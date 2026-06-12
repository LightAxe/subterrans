// surface-routing.test.ts — PR 5 Fix-A: direct coverage for the passability-aware
// forager stepping module.
//
// Test coverage:
//   packReachableStep:          encoding matches ant-system packStep / unpackStepDx,Dy
//   computeSurfaceGoalField:     BFS distances over the open grid, 4-connected,
//                                HardBlock walls, off-component isolation, target
//                                off-grid / on a wall, grid-length guard
//   ensureSurfaceGoalField:      memoisation (same instance), per-target keying
//   surfaceGoalDistance:         path distance, off-component, off-grid source
//   stepTowardReachable:         AtGoal, descent toward the target, no corner-cut
//                                through a diagonal wall gap, both invariant throws

import { describe, it, expect } from 'vitest';
import { createWorldState, type WorldState } from './types.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';
import { SurfaceMovementEffect } from './surface-features.js';
import { unpackStepDx, unpackStepDy } from './ant/ant-system.js';
import {
  packReachableStep,
  computeSurfaceGoalField,
  ensureSurfaceGoalField,
  surfaceGoalDistance,
  stepTowardReachable,
  SURFACE_GOAL_UNREACHED,
  SURFACE_STEP_AT_GOAL,
} from './surface-routing.js';

const TILE_COUNT = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;
const idx = (x: number, y: number): number => y * SURFACE_GRID_WIDTH + x;

// A fully-open grid (every tile passable). Tests carve HardBlocks into a copy.
function openGrid(): Uint8Array {
  return new Uint8Array(TILE_COUNT).fill(SurfaceMovementEffect.Cosmetic);
}

// World whose frozen terrain is the supplied grid, so the cache-backed helpers
// (ensure/surfaceGoalDistance/stepTowardReachable) read a controlled layout.
function worldWithGrid(grid: Uint8Array): WorldState {
  const world = createWorldState(1);
  world.bakedSurfaceEffect = grid;
  world.surfaceGoalFields = null;
  return world;
}

describe('packReachableStep encoding', () => {
  it('matches packStep bit layout — round-trips through unpackStepDx/Dy', () => {
    for (const dy of [-1, 0, 1] as const) {
      for (const dx of [-1, 0, 1] as const) {
        const packed = packReachableStep(dx, dy);
        expect(packed).toBe(((dy + 1) << 2) | (dx + 1));
        expect(unpackStepDx(packed)).toBe(dx);
        expect(unpackStepDy(packed)).toBe(dy);
      }
    }
  });

  it('SURFACE_STEP_AT_GOAL is the (0,0) step', () => {
    expect(SURFACE_STEP_AT_GOAL).toBe(packReachableStep(0, 0));
    expect(unpackStepDx(SURFACE_STEP_AT_GOAL)).toBe(0);
    expect(unpackStepDy(SURFACE_STEP_AT_GOAL)).toBe(0);
  });
});

describe('computeSurfaceGoalField', () => {
  it('assigns the target distance 0 and 4-connected Manhattan distances on an open grid', () => {
    const field = computeSurfaceGoalField(openGrid(), 10, 10);
    expect(field[idx(10, 10)]).toBe(0);
    expect(field[idx(11, 10)]).toBe(1);
    expect(field[idx(10, 11)]).toBe(1);
    // Diagonal neighbour is 2 hops away under 4-connected BFS, not 1.
    expect(field[idx(11, 11)]).toBe(2);
    expect(field[idx(13, 10)]).toBe(3);
  });

  it('routes the BFS distance AROUND a HardBlock wall', () => {
    const grid = openGrid();
    // Vertical wall at x=11 spanning y=9..11, leaving a gap below at y=12.
    grid[idx(11, 9)] = SurfaceMovementEffect.HardBlock;
    grid[idx(11, 10)] = SurfaceMovementEffect.HardBlock;
    grid[idx(11, 11)] = SurfaceMovementEffect.HardBlock;
    const field = computeSurfaceGoalField(grid, 10, 10);
    expect(field[idx(11, 10)]).toBe(SURFACE_GOAL_UNREACHED); // the wall itself
    // (12,10) is one tile east of the wall: shortest path detours around the gap.
    // (10,10)->(10,12)=2, ->(11,12)=3, ->(12,12)=4, ->(12,11)=5, ->(12,10)=6.
    expect(field[idx(12, 10)]).toBe(6);
  });

  it('leaves tiles walled off in a separate pocket as SURFACE_GOAL_UNREACHED', () => {
    const grid = openGrid();
    // Fully enclose tile (5,5) with HardBlocks (4-connected isolation).
    grid[idx(4, 5)] = SurfaceMovementEffect.HardBlock;
    grid[idx(6, 5)] = SurfaceMovementEffect.HardBlock;
    grid[idx(5, 4)] = SurfaceMovementEffect.HardBlock;
    grid[idx(5, 6)] = SurfaceMovementEffect.HardBlock;
    const field = computeSurfaceGoalField(grid, 20, 20);
    expect(field[idx(5, 5)]).toBe(SURFACE_GOAL_UNREACHED);
  });

  it('returns an all-unreached field when the target tile is a HardBlock', () => {
    const grid = openGrid();
    grid[idx(7, 7)] = SurfaceMovementEffect.HardBlock;
    const field = computeSurfaceGoalField(grid, 7, 7);
    expect(field[idx(7, 7)]).toBe(SURFACE_GOAL_UNREACHED);
    expect(field.every((d) => d === SURFACE_GOAL_UNREACHED)).toBe(true);
  });

  it('returns an all-unreached field when the target is off-grid', () => {
    const field = computeSurfaceGoalField(openGrid(), -1, 0);
    expect(field.every((d) => d === SURFACE_GOAL_UNREACHED)).toBe(true);
  });

  it('throws when the grid length does not match the surface tile count', () => {
    expect(() => computeSurfaceGoalField(new Uint8Array(4), 0, 0)).toThrow(/grid length/);
  });
});

describe('ensureSurfaceGoalField', () => {
  it('memoises the field per target tile (returns the same instance)', () => {
    const world = worldWithGrid(openGrid());
    const first = ensureSurfaceGoalField(world, 10, 10);
    const second = ensureSurfaceGoalField(world, 10, 10);
    expect(second).toBe(first);
  });

  it('caches distinct fields for distinct targets', () => {
    const world = worldWithGrid(openGrid());
    const a = ensureSurfaceGoalField(world, 10, 10);
    const b = ensureSurfaceGoalField(world, 20, 20);
    expect(b).not.toBe(a);
    expect(a[idx(10, 10)]).toBe(0);
    expect(b[idx(20, 20)]).toBe(0);
  });
});

describe('surfaceGoalDistance', () => {
  it('returns the reachable path distance from a source tile', () => {
    const world = worldWithGrid(openGrid());
    expect(surfaceGoalDistance(world, 13, 10, 10, 10)).toBe(3);
  });

  it('returns SURFACE_GOAL_UNREACHED for a walled-off source', () => {
    const grid = openGrid();
    grid[idx(4, 5)] = SurfaceMovementEffect.HardBlock;
    grid[idx(6, 5)] = SurfaceMovementEffect.HardBlock;
    grid[idx(5, 4)] = SurfaceMovementEffect.HardBlock;
    grid[idx(5, 6)] = SurfaceMovementEffect.HardBlock;
    const world = worldWithGrid(grid);
    expect(surfaceGoalDistance(world, 5, 5, 20, 20)).toBe(SURFACE_GOAL_UNREACHED);
  });

  it('returns SURFACE_GOAL_UNREACHED for an off-grid source', () => {
    const world = worldWithGrid(openGrid());
    expect(surfaceGoalDistance(world, -1, 0, 10, 10)).toBe(SURFACE_GOAL_UNREACHED);
  });
});

describe('stepTowardReachable', () => {
  it('returns AtGoal when the ant is already on the target tile', () => {
    const world = worldWithGrid(openGrid());
    expect(stepTowardReachable(world, 10, 10, 10, 10)).toBe(SURFACE_STEP_AT_GOAL);
  });

  it('steps strictly closer to the target on an open grid', () => {
    const world = worldWithGrid(openGrid());
    // From (13,10) toward (10,10): a westward cardinal step is the descent.
    const step = stepTowardReachable(world, 13, 10, 10, 10);
    expect(unpackStepDx(step)).toBe(-1);
    expect(unpackStepDy(step)).toBe(0);
  });

  it('prefers a diagonal when it strictly lowers the goal distance', () => {
    const world = worldWithGrid(openGrid());
    // From (12,12) toward (10,10): the NW diagonal (dist 2) beats either cardinal
    // (dist 3), so descent takes it.
    const step = stepTowardReachable(world, 12, 12, 10, 10);
    expect(unpackStepDx(step)).toBe(-1);
    expect(unpackStepDy(step)).toBe(-1);
  });

  it('rejects a diagonal whose destination is a HardBlock and takes an open cardinal instead', () => {
    const grid = openGrid();
    // From (12,12) toward (10,10) the NW diagonal lands on (11,11). Wall that
    // diagonal destination off: its field value becomes SURFACE_GOAL_UNREACHED,
    // so descent must reject it and fall back to a passable cardinal that is
    // still strictly closer (the no-corner-cut guarantee).
    grid[idx(11, 11)] = SurfaceMovementEffect.HardBlock;
    const world = worldWithGrid(grid);
    const here = surfaceGoalDistance(world, 12, 12, 10, 10);
    const step = stepTowardReachable(world, 12, 12, 10, 10);
    const dx = unpackStepDx(step);
    const dy = unpackStepDy(step);
    // Not the walled-off NW diagonal.
    expect([dx, dy]).not.toEqual([-1, -1]);
    const landed = surfaceGoalDistance(world, 12 + dx, 12 + dy, 10, 10);
    expect(landed).toBeGreaterThanOrEqual(0); // landed on a passable, reachable tile
    expect(landed).toBeLessThan(here); // strictly closer
  });

  it('throws when a positive-distance tile has no strictly-closer neighbour (corrupt field)', () => {
    const world = worldWithGrid(openGrid());
    // Hand-seed a corrupt field into the cache: the source tile holds a positive
    // distance but every neighbour is unreached, so no descending step exists.
    // This drives the second invariant assert (a complete BFS field can never
    // produce this; only corruption can).
    const corrupt = new Int32Array(TILE_COUNT).fill(SURFACE_GOAL_UNREACHED);
    corrupt[idx(30, 30)] = 5; // positive distance, isolated from any lower neighbour
    const cache = new Map<number, Int32Array>();
    cache.set(idx(40, 40), corrupt); // key = target tile (40,40)
    world.surfaceGoalFields = cache;
    expect(() => stepTowardReachable(world, 30, 30, 40, 40)).toThrow(/goal field corrupt/);
  });

  it('throws when the source tile cannot reach the target (connectivity invariant)', () => {
    const grid = openGrid();
    grid[idx(4, 5)] = SurfaceMovementEffect.HardBlock;
    grid[idx(6, 5)] = SurfaceMovementEffect.HardBlock;
    grid[idx(5, 4)] = SurfaceMovementEffect.HardBlock;
    grid[idx(5, 6)] = SurfaceMovementEffect.HardBlock;
    const world = worldWithGrid(grid);
    expect(() => stepTowardReachable(world, 5, 5, 20, 20)).toThrow(
      /connectivity invariant violated/,
    );
  });

  it('does not select a diagonal with both orthogonals blocked (wrap-around case)', () => {
    const grid = openGrid();
    const target = { x: 5, y: 5 };
    const source = { x: 10, y: 10 };
    // Create walls blocking N and W of source at (10,10):
    // N = (10, 9) and W = (9, 10) are blocked
    // But allow NW = (9, 9) to be reachable via a longer path
    grid[idx(10, 9)] = SurfaceMovementEffect.HardBlock; // N of source
    grid[idx(9, 10)] = SurfaceMovementEffect.HardBlock; // W of source

    const world = worldWithGrid(grid);
    const here = surfaceGoalDistance(world, source.x, source.y, target.x, target.y);

    const step = stepTowardReachable(world, source.x, source.y, target.x, target.y);
    const dx = unpackStepDx(step);
    const dy = unpackStepDy(step);

    // The key check: NW (dx=-1, dy=-1) must NOT be selected — both of its
    // orthogonals (N and W) are blocked, so the corner-squeeze rejection in
    // stepTowardReachable makes the diagonal ineligible even though NW itself
    // is passable and shorter. The algorithm selects NE instead (or SW — both
    // are equidistant at 10; NE wins the tie-break due to iteration order).
    expect([dx, dy]).not.toEqual([-1, -1]);

    const landed = surfaceGoalDistance(world, source.x + dx, source.y + dy, target.x, target.y);
    expect(landed).toBeGreaterThanOrEqual(0); // landed on a passable, reachable tile
    expect(landed).toBeLessThan(here); // strictly closer
  });
});

describe('ensureSurfaceGoalField cache eviction (clear-all on overflow)', () => {
  it('stays bounded past the cap and a re-requested field still recomputes correctly', () => {
    const world = createWorldState(42);
    // Request many distinct targets (more than the 256 cap) to force the
    // clear-all overflow path at least once. Nested loops avoid `/` (banned in
    // src/sim); 3 rows × 128 cols = 384 distinct tiles, capped at REQUESTS.
    const REQUESTS = 300;
    let requested = 0;
    for (let ty = 0; ty < 3 && requested < REQUESTS; ty++) {
      for (let tx = 0; tx < SURFACE_GRID_WIDTH && requested < REQUESTS; tx++) {
        ensureSurfaceGoalField(world, tx, ty);
        requested++;
      }
    }
    // The cache cleared on overflow rather than growing unbounded.
    expect(world.surfaceGoalFields).not.toBeNull();
    const size = world.surfaceGoalFields!.size;
    expect(size).toBeLessThan(REQUESTS); // a clear happened
    expect(size).toBeLessThanOrEqual(256); // bounded by the cap
    // A field requested after the clears still equals a fresh computation
    // (eviction is correctness-neutral — entries are pure functions of terrain).
    const cached = ensureSurfaceGoalField(world, 5, 0);
    const fresh = computeSurfaceGoalField(world.bakedSurfaceEffect, 5, 0);
    expect(Array.from(cached)).toEqual(Array.from(fresh));
  });
});
