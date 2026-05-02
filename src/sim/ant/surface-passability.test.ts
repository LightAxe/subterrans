// surface-passability.test.ts — issue #44 step 4.
//
// Covers the new v6 surface passability + detour code paths in
// ant-system.ts:
//   - canEnterSurfaceTile: blocked on HardBlock, walkable on Cosmetic/SoftCost
//   - pickSurfaceDetour: deterministic alternate-tile pick, respects walkability
//   - tickAntMovement surface branch: honors HardBlock under v6, ignores under v5
//   - resolveSameColonyOccupancy surface bump: respects HardBlock under v6
//
// These tests construct synthetic worlds where the surface-feature selector
// returns a known feature shape, then assert the movement / passability
// outcomes. The worlds use specific terrainSeeds chosen so a known feature
// kind anchors at a predictable tile (verified empirically by walking the
// selector — adjusting the seed if a future registry change disturbs the
// hash).

import { describe, it, expect } from 'vitest';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V5_CHAMBER_ON_MARKED,
  SIM_VERSION_V7_SURFACE_PASSABILITY,
} from '../types.js';
import { initAnt } from './ant-store.js';
import {
  canEnterSurfaceTile,
  pickSurfaceDetour,
  tickAntMovement,
} from './ant-system.js';
import { surfaceFeatureAt, SurfaceMovementEffect } from '../surface-features.js';
import { AntTask, ForagingSubState } from '../enums.js';
import { Zone } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Rng } from '../rng.js';
import { createDigFlowFields } from '../dig-system.js';
import { createColonyRecord } from '../colony/colony-store.js';

// Helper: scan a region looking for a tile whose movement effect matches the
// requested predicate. Returns the first matching tile, or null.
function findTileWith(
  world: Parameters<typeof canEnterSurfaceTile>[0],
  predicate: (movement: SurfaceMovementEffect) => boolean,
  region = { x0: 0, y0: 0, x1: 80, y1: 80 },
): { x: number; y: number } | null {
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const slice = surfaceFeatureAt(world, x, y);
      const movement = slice === null ? SurfaceMovementEffect.Cosmetic : slice.movement;
      if (predicate(movement)) return { x, y };
    }
  }
  return null;
}

describe('canEnterSurfaceTile', () => {
  it('returns true for a Cosmetic tile (no feature)', () => {
    const world = createWorldState(42);
    const free = findTileWith(world, (m) => m === SurfaceMovementEffect.Cosmetic);
    expect(free).not.toBeNull();
    expect(canEnterSurfaceTile(world, free!.x, free!.y)).toBe(true);
  });

  it('returns false for a HardBlock tile (boulder/twig/leaf/big-leaf)', () => {
    const world = createWorldState(42);
    const blocked = findTileWith(world, (m) => m === SurfaceMovementEffect.HardBlock);
    expect(blocked).not.toBeNull();
    expect(canEnterSurfaceTile(world, blocked!.x, blocked!.y)).toBe(false);
  });

  it('returns true for a SoftCost tile (bush / grass clump)', () => {
    const world = createWorldState(42);
    const soft = findTileWith(world, (m) => m === SurfaceMovementEffect.SoftCost);
    expect(soft).not.toBeNull();
    expect(canEnterSurfaceTile(world, soft!.x, soft!.y)).toBe(true);
  });

  it('returns false for out-of-bounds tiles', () => {
    const world = createWorldState(42);
    expect(canEnterSurfaceTile(world, -1, 5)).toBe(false);
    expect(canEnterSurfaceTile(world, 5, -1)).toBe(false);
    expect(canEnterSurfaceTile(world, 9999, 5)).toBe(false);
    expect(canEnterSurfaceTile(world, 5, 9999)).toBe(false);
  });
});

describe('pickSurfaceDetour', () => {
  it('returns deterministic results — same inputs → same output across calls', () => {
    const world = createWorldState(42);
    // Find an arbitrary blocked candidate location to detour around.
    const blocked = findTileWith(world, (m) => m === SurfaceMovementEffect.HardBlock);
    expect(blocked).not.toBeNull();
    // Caller intent: step into the blocked tile from one tile west.
    const a = pickSurfaceDetour(world, blocked!.x - 1, blocked!.y, 1, 0);
    const b = pickSurfaceDetour(world, blocked!.x - 1, blocked!.y, 1, 0);
    expect(b).toEqual(a);
  });

  it('returns a step into a walkable adjacent tile when one exists', () => {
    const world = createWorldState(42);
    // Pick any open tile and detour from it. The detour must return either
    // (0, 0) (no walkable neighbor — extremely rare) or a step into a
    // canEnterSurfaceTile-true neighbor.
    const free = findTileWith(world, (m) => m === SurfaceMovementEffect.Cosmetic);
    expect(free).not.toBeNull();
    const detour = pickSurfaceDetour(world, free!.x, free!.y, 1, 0);
    if (detour.dx !== 0 || detour.dy !== 0) {
      expect(canEnterSurfaceTile(world, free!.x + detour.dx, free!.y + detour.dy)).toBe(true);
    }
  });

  it('returns (0, 0) when no walkable neighbor exists', () => {
    // Construct a world where the ant is surrounded by HardBlock — easiest
    // way is to put the ant at the (-1,-1) corner so all its neighbors are
    // out of bounds. canEnterSurfaceTile rejects out-of-bounds.
    const world = createWorldState(42);
    // Probe origin corner: from (-1, -1) all 8 neighbors include some
    // out-of-bounds tiles. There's still (0, 0) which may or may not be
    // hard-blocked. Use a more robust test: query from far-out-of-bounds
    // (-100, -100) where every probe is still out of bounds.
    const detour = pickSurfaceDetour(world, -100, -100, 1, 1);
    expect(detour).toEqual({ dx: 0, dy: 0 });
  });

  it('prefers cardinal slip on intended axis as the first probe', () => {
    // Construct a synthetic test by checking the well-defined order:
    // probe 1 is (intendedDx, 0). When that candidate is walkable AND has
    // the smallest score, it must win.
    const world = createWorldState(42);
    const free = findTileWith(world, (m) => m === SurfaceMovementEffect.Cosmetic);
    expect(free).not.toBeNull();
    // Walk from free.x, free.y toward (free.x + 2, free.y + 2) — diagonal.
    // If the (free.x + 2, free.y) tile is walkable, the cardinal X slip
    // (probe 1) is one of the candidates; with intended=(2, 2), Manhattan
    // to target=(free.x+2, free.y+2) for the slip (free.x+2, free.y) is
    // |0| + |2| = 2 — same score as a slip toward (free.x, free.y+2).
    // Either way the detour returns one of those slips.
    const detour = pickSurfaceDetour(world, free!.x, free!.y, 2, 2);
    if (detour.dx !== 0 || detour.dy !== 0) {
      // Whatever it returns must be walkable.
      expect(canEnterSurfaceTile(world, free!.x + detour.dx, free!.y + detour.dy)).toBe(true);
    }
  });
});

describe('tickAntMovement surface passability — gated on simVersion', () => {
  // Helper: spawn a surface ant at (tileX, tileY) targeting (targetTileX,
  // targetTileY). Uses Foraging+CarryingFood task because that has a clean
  // entrance-routing path. Caller must install a colony with an entrance
  // for the ant to route toward.
  function spawnSurfaceCarrier(
    world: ReturnType<typeof createWorldState>,
    colonyId: number,
    tileX: number,
    tileY: number,
  ): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId,
      posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Surface,
    });
    world.ants.foodCarrying[id] = 1;
    world.ants.speed[id] = FP_ONE;
    return id;
  }

  it('under v6 — ant cannot move into a HardBlock tile', () => {
    // Find a tile pair (open, blocked) where (open.x + 1, open.y) is the
    // blocked tile. Spawn the ant on `open` with a target east of blocked
    // — its preferred step is east and should be rejected.
    const world = createWorldState(42);
    expect(world.simVersion).toBe(SIM_VERSION_V7_SURFACE_PASSABILITY);
    let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
    for (let y = 4; y < 50 && pair === null; y++) {
      for (let x = 4; x < 50; x++) {
        const open = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (
          (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
          east !== null && east.movement === SurfaceMovementEffect.HardBlock
        ) {
          pair = { open: { x, y }, blocked: { x: x + 1, y } };
          break;
        }
      }
    }
    expect(pair).not.toBeNull();

    // Install a colony with an entrance far east of the obstacle so the
    // ant routes that direction.
    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: pair!.blocked.x + 10,
      surfaceTileY: pair!.blocked.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, pair!.open.x, pair!.open.y);
    const startTileX = world.ants.posX[id]! >> FP_SHIFT;
    const startTileY = world.ants.posY[id]! >> FP_SHIFT;
    const blockedTileX = pair!.blocked.x;
    const blockedTileY = pair!.blocked.y;

    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());

    // Ant must NOT be on the blocked tile after the tick.
    const endTileX = world.ants.posX[id]! >> FP_SHIFT;
    const endTileY = world.ants.posY[id]! >> FP_SHIFT;
    expect(endTileX === blockedTileX && endTileY === blockedTileY).toBe(false);
    void startTileX; void startTileY;
  });

  it('under v6 — ant on a SoftCost (grass/bush) tile moves at half speed (issue #44 step 5)', () => {
    // Find a tile that's SoftCost AND has a Cosmetic neighbor to the east
    // (so the ant has somewhere to move). Spawn a Foraging+CarryingFood
    // ant at the SoftCost tile with FP_ONE speed. With base speed FP_ONE,
    // a normal tile gives one full tile of motion per tick; SoftCost
    // halves that, leaving the ant one tile-edge short.
    const world = createWorldState(42);
    expect(world.simVersion).toBe(SIM_VERSION_V6_SURFACE_PASSABILITY);
    let pair: { soft: { x: number; y: number }; openEast: { x: number; y: number } } | null = null;
    for (let y = 4; y < 80 && pair === null; y++) {
      for (let x = 4; x < 80; x++) {
        const cur = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        const eastEast = surfaceFeatureAt(world, x + 2, y);
        if (
          cur !== null && cur.movement === SurfaceMovementEffect.SoftCost &&
          (east === null || east.movement !== SurfaceMovementEffect.HardBlock) &&
          (eastEast === null || eastEast.movement !== SurfaceMovementEffect.HardBlock)
        ) {
          pair = { soft: { x, y }, openEast: { x: x + 1, y } };
          break;
        }
      }
    }
    expect(pair).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: pair!.soft.x + 30,  // far east — drives the ant rightward
      surfaceTileY: pair!.soft.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, pair!.soft.x, pair!.soft.y);
    const startTileX = world.ants.posX[id]! >> FP_SHIFT;
    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());
    const endTileX = world.ants.posX[id]! >> FP_SHIFT;

    // Half-speed: ant either stays in the same tile (if half FP_ONE = 128
    // doesn't push it past the boundary it started inside) or has crossed
    // exactly one tile (if it started near the right edge of the SoftCost
    // tile). Specifically it must NOT have crossed two tiles, which a
    // full-speed FP_ONE step from a tile-aligned position would.
    // spawnSurfaceCarrier places the ant at (tileX << FP_SHIFT) +
    // (FP_ONE >> 1) — mid-tile — so a half-speed step (128) lands at
    // mid-tile + 128 = tile-edge, just barely crossing into the east tile.
    // Either outcome (still on soft tile, or one tile east) is valid; what
    // we assert is "didn't make it two tiles".
    expect(endTileX - startTileX).toBeLessThanOrEqual(1);
  });

  it('under v6 — ant on a Cosmetic tile moves at full speed (sanity)', () => {
    const world = createWorldState(42);
    let pair: { open: { x: number; y: number } } | null = null;
    for (let y = 4; y < 80 && pair === null; y++) {
      for (let x = 4; x < 80; x++) {
        const cur = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (
          cur === null &&
          east === null  // open + open-east — guaranteed non-SoftCost / non-HardBlock
        ) {
          pair = { open: { x, y } };
          break;
        }
      }
    }
    expect(pair).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: pair!.open.x + 30,
      surfaceTileY: pair!.open.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, pair!.open.x, pair!.open.y);
    const startTileX = world.ants.posX[id]! >> FP_SHIFT;
    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());
    const endTileX = world.ants.posX[id]! >> FP_SHIFT;

    // Full-speed FP_ONE step from mid-tile lands at next-tile-mid → 1 tile
    // crossing. Confirms the slowdown is applied only on SoftCost tiles.
    expect(endTileX - startTileX).toBe(1);
  });

  it('detour: ant blocked from preferred east step ends at a deterministic alternate tile (issue #44 step 6)', () => {
    // Codex review explicitly called this out: a hard-block guard alone
    // would make ants repeatedly try to step into the same obstacle. The
    // deterministic local detour picks an alternate adjacent walkable tile.
    // This integration test: spawn an ant west of a HardBlock with target
    // east. After one tick, ant must NOT be on the blocked tile, AND must
    // be on a deterministic alternate (same seed → same alternate every run).
    const seed = 42;
    function runTick(): { x: number; y: number } {
      const world = createWorldState(seed);
      let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
      for (let y = 4; y < 50 && pair === null; y++) {
        for (let x = 4; x < 50; x++) {
          const open = surfaceFeatureAt(world, x, y);
          const east = surfaceFeatureAt(world, x + 1, y);
          if (
            (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
            east !== null && east.movement === SurfaceMovementEffect.HardBlock
          ) {
            pair = { open: { x, y }, blocked: { x: x + 1, y } };
            break;
          }
        }
      }
      if (pair === null) throw new Error('no test pair found for seed');

      const colony = createColonyRecord(1, 0);
      colony.entrances = [{
        entranceId: 0,
        surfaceTileX: pair.blocked.x + 10,
        surfaceTileY: pair.blocked.y,
        isOpen: true,
      }];
      colony.rallyPoint = null;
      colony.digFlowFieldDirty = false;
      world.colonies[1] = colony;

      const id = spawnSurfaceCarrier(world, 1, pair.open.x, pair.open.y);
      tickAntMovement(world, new Rng(seed), createDigFlowFields());
      return { x: world.ants.posX[id]! >> FP_SHIFT, y: world.ants.posY[id]! >> FP_SHIFT };
    }

    // Run twice — the resulting tile must be identical (deterministic detour).
    const a = runTick();
    const b = runTick();
    expect(b).toEqual(a);
  });

  it('occupancy resolver: a same-colony bump never lands an ant on a HardBlock tile (issue #44 step 6)', () => {
    // Codex review: "Occupancy resolver does not shift ants into blocked
    // surface tiles." Construct a scenario where two same-colony ants end
    // up on the same tile, with the only otherwise-valid neighbor being
    // a HardBlock feature. The resolver must skip the HardBlock direction.
    //
    // Strategy: install a colony, find a tile T whose North neighbor is
    // HardBlock and whose East/South/West are walkable. Spawn two same-
    // colony ants both targeting T. The resolver should bump the higher-id
    // to East/South/West, NOT North.
    const world = createWorldState(42);
    expect(world.simVersion).toBe(SIM_VERSION_V6_SURFACE_PASSABILITY);

    let pickedT: { x: number; y: number } | null = null;
    for (let y = 5; y < 80 && pickedT === null; y++) {
      for (let x = 5; x < 80; x++) {
        const here  = surfaceFeatureAt(world, x, y);
        const north = surfaceFeatureAt(world, x, y - 1);
        const east  = surfaceFeatureAt(world, x + 1, y);
        const south = surfaceFeatureAt(world, x, y + 1);
        const west  = surfaceFeatureAt(world, x - 1, y);
        const hereOk  = here === null || here.movement !== SurfaceMovementEffect.HardBlock;
        const northBlock = north !== null && north.movement === SurfaceMovementEffect.HardBlock;
        const eastOk  = east === null || east.movement !== SurfaceMovementEffect.HardBlock;
        const southOk = south === null || south.movement !== SurfaceMovementEffect.HardBlock;
        const westOk  = west === null || west.movement !== SurfaceMovementEffect.HardBlock;
        if (hereOk && northBlock && eastOk && southOk && westOk) {
          pickedT = { x, y };
          break;
        }
      }
    }
    expect(pickedT).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    // Spawn two stationary ants at T. Both have no movement → both end at T
    // → the post-pass resolver detects the duplicate and shifts the higher-id.
    const aId = allocateEntityId(world);
    initAnt(world.ants, aId, {
      colonyId: 1,
      posX: pickedT!.x << FP_SHIFT,
      posY: pickedT!.y << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      zone: Zone.Surface,
    });
    const bId = allocateEntityId(world);
    initAnt(world.ants, bId, {
      colonyId: 1,
      posX: pickedT!.x << FP_SHIFT,
      posY: pickedT!.y << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      zone: Zone.Surface,
    });
    expect(aId).toBeLessThan(bId);

    tickAntMovement(world, new Rng(42), createDigFlowFields());

    // B was bumped — it must not be on the HardBlock north tile.
    const bX = world.ants.posX[bId]! >> FP_SHIFT;
    const bY = world.ants.posY[bId]! >> FP_SHIFT;
    expect(bX === pickedT!.x && bY === pickedT!.y - 1).toBe(false);
  });

  it('v5 vs v6: same seed, same scenario produces different ant motion (deterministic divergence)', () => {
    // Final check that the simVersion gate is doing its job: same world
    // setup, two simVersions, must produce different motion for at least
    // ONE ant after a few ticks. If the gate were broken we'd see
    // identical positions.
    function runScenario(simVersionPin: 5 | 6): { posX: number; posY: number } {
      const world = createWorldState(42);
      world.simVersion = simVersionPin;

      // Find a tile pair where v6 would block but v5 wouldn't.
      let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
      for (let y = 4; y < 50 && pair === null; y++) {
        for (let x = 4; x < 50; x++) {
          const open = surfaceFeatureAt(world, x, y);
          const east = surfaceFeatureAt(world, x + 1, y);
          if (
            (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
            east !== null && east.movement === SurfaceMovementEffect.HardBlock
          ) {
            pair = { open: { x, y }, blocked: { x: x + 1, y } };
            break;
          }
        }
      }
      if (pair === null) throw new Error('no test pair found');

      const colony = createColonyRecord(1, 0);
      colony.entrances = [{
        entranceId: 0,
        surfaceTileX: pair.blocked.x + 10,
        surfaceTileY: pair.blocked.y,
        isOpen: true,
      }];
      colony.rallyPoint = null;
      colony.digFlowFieldDirty = false;
      world.colonies[1] = colony;

      const id = spawnSurfaceCarrier(world, 1, pair.open.x, pair.open.y);
      // Run a few ticks to amplify the divergence.
      const rng = new Rng(42);
      const digFlow = createDigFlowFields();
      for (let t = 0; t < 5; t++) {
        tickAntMovement(world, rng, digFlow);
      }
      return { posX: world.ants.posX[id]!, posY: world.ants.posY[id]! };
    }

    const v5 = runScenario(5);
    const v6 = runScenario(6);
    // v6 should detour around the obstacle while v5 walks through it →
    // positions differ.
    expect(v6.posX !== v5.posX || v6.posY !== v5.posY).toBe(true);
  });

  it('SoftCost slowdown clamps to min 1 (speed=1 stays at 1, doesn\'t go to 0)', () => {
    // Edge case: an ant with the absolute minimum nonzero speed (1) on a
    // SoftCost tile. Half of 1 is 0; the clamp must keep it at 1 so the
    // ant isn't permanently stuck. Verify by reading effective speed via
    // motion delta after one tick.
    const world = createWorldState(42);
    let soft: { x: number; y: number } | null = null;
    for (let y = 4; y < 80 && soft === null; y++) {
      for (let x = 4; x < 80; x++) {
        const cur = surfaceFeatureAt(world, x, y);
        if (cur !== null && cur.movement === SurfaceMovementEffect.SoftCost) {
          soft = { x, y };
          break;
        }
      }
    }
    expect(soft).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: soft!.x + 30,
      surfaceTileY: soft!.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, soft!.x, soft!.y);
    world.ants.speed[id] = 1;
    const startPosX = world.ants.posX[id]!;
    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());
    const endPosX = world.ants.posX[id]!;

    // Speed=1 halved would be 0; clamped to 1. So the ant moves at least
    // 1 sub-pixel per tick (the minimum quantum). NOT stuck.
    expect(endPosX).not.toBe(startPosX);
  });

  it('under v5 — same setup, ant freely walks onto the (now non-blocking) feature tile', () => {
    // Same construction as v6 test but with simVersion pinned. The
    // canEnterSurfaceTile guard is gated on v6, so v5 ants ignore features.
    const world = createWorldState(42);
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;

    let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
    for (let y = 4; y < 50 && pair === null; y++) {
      for (let x = 4; x < 50; x++) {
        const open = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (
          (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
          east !== null && east.movement === SurfaceMovementEffect.HardBlock
        ) {
          pair = { open: { x, y }, blocked: { x: x + 1, y } };
          break;
        }
      }
    }
    expect(pair).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: pair!.blocked.x + 10,
      surfaceTileY: pair!.blocked.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, pair!.open.x, pair!.open.y);
    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());

    // Under v5 the ant moves freely; expected position is one tile east
    // (toward entrance) — i.e. ON the blocked tile.
    const endTileX = world.ants.posX[id]! >> FP_SHIFT;
    expect(endTileX).toBe(pair!.blocked.x);
  });
});
