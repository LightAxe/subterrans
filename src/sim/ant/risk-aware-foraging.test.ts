// risk-aware-foraging.test.ts — A1 (simVersion V36) risk-aware foraging.
//
// Covers the four A1 surfaces:
//   (a) sampleForagingDirection danger penalty — RNG-free scoring layers.
//   (b) hasNearbyPheromoneSignal mirror via tickExcursionBoundary at V36.
//   (c) V35 gate regression — the danger grid is never consulted pre-V36.
//   (d) chooseExcursionDirection danger-steer (world-edge bounce) at V36.
//
// The danger penalty is `net = food − (Math.imul(danger, DANGER_ROUTE_WEIGHT_FP)
// >> FP_SHIFT)`, clamped ≥ 0. With DANGER_ROUTE_WEIGHT_FP = 256 (1.0) an equal
// danger value fully cancels a food-trail cell (net = 0).

import { describe, it, expect } from 'vitest';
import { sampleForagingDirection } from '../pheromone/pheromone-system.js';
import { chooseExcursionDirection, tickExcursionBoundary, tickAntMovement } from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER,
  SIM_VERSION_V36_RISK_AWARE_FORAGING,
  type WorldState,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt, pushRecentTile } from './ant-store.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import { createPheromoneGrid, phSet, pheromoneGridKey } from '../pheromone/pheromone-store.js';
import { Rng } from '../rng.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  SEARCH_LEASH_RADII,
  DANGER_ROUTE_AVOID_THRESHOLD,
} from '../constants.js';
import { FP_SHIFT } from '../fixed.js';
import { createDigFlowFields } from '../dig-system.js';
import { createEntranceFlowFields } from '../entrance-flow.js';
import { createChamberFlowFields } from '../chamber-flow.js';

const COLONY_ID = 1;
const MAX_TEST_ENTITIES = 64;

// ---------------------------------------------------------------------------
// (a) sampleForagingDirection — danger penalty on the RNG-free scoring layers
// ---------------------------------------------------------------------------

describe('A1 (a) sampleForagingDirection danger penalty', () => {
  it('a strong food trail through danger loses to a weaker CLEAN trail', () => {
    const food = createPheromoneGrid(10, 10);
    const danger = createPheromoneGrid(10, 10);
    // Right neighbor: strong trail (500) but fully poisoned (danger 500 → net 0).
    phSet(food, 6, 5, 500);
    phSet(danger, 6, 5, 500);
    // Up neighbor: weaker but clean (200 → net 200, ≥ strong-trail threshold 128).
    phSet(food, 5, 4, 200);

    const dir = sampleForagingDirection(food, 5, 5, new Rng(1), -1, -1, danger);
    expect(dir).toEqual({ dx: 0, dy: -1 }); // up — the clean trail. Layer 1, no RNG.
  });

  it('WITHOUT the danger grid (legacy path) the strong poisoned trail still wins', () => {
    const food = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 500);
    phSet(food, 5, 4, 200);

    const dir = sampleForagingDirection(food, 5, 5, new Rng(1)); // no danger grid
    expect(dir).toEqual({ dx: 1, dy: 0 }); // right — strongest raw strength.
  });

  it('a fully danger-poisoned trail yields {0,0} → caller falls through to wander', () => {
    const food = createPheromoneGrid(10, 10);
    const danger = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 300);
    phSet(danger, 6, 5, 300); // net 0 — no usable candidate anywhere.

    const dir = sampleForagingDirection(food, 5, 5, new Rng(7), -1, -1, danger);
    expect(dir).toEqual({ dx: 0, dy: 0 });
  });
});

// ---------------------------------------------------------------------------
// RNG draw-count — danger flips the sampler branch (the real V36 vs V35 delta)
// ---------------------------------------------------------------------------

describe('A1 sampler RNG draw-count', () => {
  it('danger dropping a strong trail into the weak-trail band consumes RNG the legacy path does not', () => {
    const food = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 500); // strong (≥ 128) → layer 1 → 0 RNG draws
    const danger = createPheromoneGrid(10, 10);
    phSet(danger, 6, 5, 400); // net 100: weak (0 < net < 128) → layer 2 → consumes RNG

    // Count nextInt() calls via a duck-typed wrapper around a real seeded Rng, so
    // we pin the EXACT draw count (not just "the streams diverged" — that would pass
    // even if V36 over-consumed the RNG). CodeRabbit.
    const countingRng = (seed: number): { rng: Rng; draws: () => number } => {
      const base = new Rng(seed);
      let n = 0;
      const rng = {
        nextInt: (max: number) => {
          n++;
          return base.nextInt(max);
        },
      } as unknown as Rng;
      return { rng, draws: () => n };
    };

    const v35 = countingRng(999);
    sampleForagingDirection(food, 5, 5, v35.rng); // legacy: strong trail → layer 1
    expect(v35.draws()).toBe(0); // strong-trail branch consumes ZERO draws

    const v36 = countingRng(999);
    sampleForagingDirection(food, 5, 5, v36.rng, -1, -1, danger); // V36: weak trail → layer 2
    expect(v36.draws()).toBe(1); // exactly the single explore-roll draw (no explore branch this seed)
  });
});

// ---------------------------------------------------------------------------
// (b)/(c) hasNearbyPheromoneSignal mirror + V35 gate, via tickExcursionBoundary
// ---------------------------------------------------------------------------

/**
 * A SearchingFood forager parked one tile PAST its leash radius, with a food
 * trail 2 tiles away (inside the SIGNAL_PHEROMONE_RADIUS=3 scan). Whether it
 * flips to ReturningToNest depends entirely on whether that trail still counts
 * as "signal" once the danger mirror is applied.
 */
function setupPastLeashForager(
  simVersion: number,
  dangerValue: number,
): { world: WorldState; antId: number } {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  world.simVersion = simVersion;
  const colony = createColonyRecord(COLONY_ID, 0);
  colony.entrances = [
    { entranceId: allocateEntityId(world), surfaceTileX: 0, surfaceTileY: 0, isOpen: true },
  ];
  world.colonies[COLONY_ID] = colony;

  const base = SEARCH_LEASH_RADII[0]!;
  const antTileX = base + 1; // one tile past the wave-0 leash from entrance (0,0)
  const antTileY = 0;
  const antId = allocateEntityId(world);
  initAnt(world.ants, antId, {
    colonyId: COLONY_ID,
    posX: antTileX << FP_SHIFT,
    posY: antTileY << FP_SHIFT,
    task: AntTask.Foraging,
    subTask: ForagingSubState.SearchingFood,
  });
  world.ants.searchWave[antId] = 0;
  world.ants.searchPrevTileX[antId] = -1;
  world.ants.searchPrevTileY[antId] = -1;

  // Food trail 2 tiles east of the ant (within the radius-3 signal scan).
  const foodTileX = antTileX + 2;
  const foodGrid = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
  world.pheromoneGrids[pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface')] = foodGrid;
  phSet(foodGrid, foodTileX, antTileY, 1000);

  const dangerGrid = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
  world.pheromoneGrids[pheromoneGridKey(COLONY_ID, PheromoneType.DangerTrail, 'surface')] =
    dangerGrid;
  if (dangerValue > 0) phSet(dangerGrid, foodTileX, antTileY, dangerValue);

  return { world, antId };
}

describe('A1 (b) boundary mirror at V36', () => {
  it('a trail poisoned beyond recovery (danger ≫ food) stops holding a past-leash forager → ReturningToNest', () => {
    // food 1000, danger 2000 → net < 0 even after the danger-decay alignment.
    const { world, antId } = setupPastLeashForager(SIM_VERSION_V36_RISK_AWARE_FORAGING, 2000);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('control: a CLEAN trail still holds the forager → stays SearchingFood', () => {
    const { world, antId } = setupPastLeashForager(SIM_VERSION_V36_RISK_AWARE_FORAGING, 0);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('decay-aligned: danger == food is NOT cancelled here (food decays slower → usable) → stays SearchingFood', () => {
    // Raw danger 1000 would cancel food 1000, but the sampler reads them one decay
    // step later where food > danger (danger decays faster). The boundary decays the
    // danger term forward to agree with the sampler, so it must NOT flip the ant home
    // for a trail that will be usable next tick (Codex P2 fix).
    const { world, antId } = setupPastLeashForager(SIM_VERSION_V36_RISK_AWARE_FORAGING, 1000);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

describe('A1 (c) V35 gate regression — danger grid never consulted pre-V36', () => {
  it('a danger ≫ food trail is ignored at V35: forager stays SearchingFood (byte-identical to clean)', () => {
    const { world, antId } = setupPastLeashForager(SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER, 2000);
    tickExcursionBoundary(world);
    // At V35 the danger grid is not passed, so even a heavily-poisoned trail still
    // counts as signal — exactly the pre-V36 behaviour.
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

// ---------------------------------------------------------------------------
// (d) chooseExcursionDirection — world-edge bounce danger-steer at V36
// ---------------------------------------------------------------------------

describe('A1 (d) chooseExcursionDirection danger-steer', () => {
  function setupWanderer(): { world: WorldState; antId: number } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.colonies[COLONY_ID] = createColonyRecord(COLONY_ID, 0);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Committed east heading with time on the clock → the function decrements
    // ticks and drops straight into the edge/danger bounce, leaving the heading
    // pick/turn logic (and its RNG) out of the picture.
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    return { world, antId };
  }

  it('steers away from a dangerous heading tile when the danger grid is provided', () => {
    const { world, antId } = setupWanderer();
    const danger = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
    // East neighbor (11,10) is dangerous; the first rotation (south, (10,11)) is clean.
    phSet(danger, 11, 10, DANGER_ROUTE_AVOID_THRESHOLD + 100);

    const dir = chooseExcursionDirection(world, antId, new Rng(3), danger);
    expect(dir).not.toEqual({ dx: 1, dy: 0 }); // not east (into the danger)
    // First safe in-bounds rotation = south (0,1). The rotation formula yields a
    // negative-zero dx (`-rotHy`), numerically identical to 0 for `tileX + dx`
    // and normalized to 0 by the Int heading store — compare with === semantics.
    expect(dir.dx === 0).toBe(true);
    expect(dir.dy).toBe(1);
  });

  it('WITHOUT the danger grid it keeps the committed heading (legacy bounce)', () => {
    const { world, antId } = setupWanderer();
    const dir = chooseExcursionDirection(world, antId, new Rng(3)); // no danger grid
    expect(dir).toEqual({ dx: 1, dy: 0 }); // east — unchanged.
  });
});

// ---------------------------------------------------------------------------
// (e) no-revisit alternate selection is danger-aware at V36 (Codex round 2) —
// the downstream recent-tiles swap must not undo the sampler's safe choice.
// ---------------------------------------------------------------------------

describe('A1 (e) no-revisit alternate is danger-aware at V36', () => {
  // A wandering SearchingFood forager at (10,10) committed east; the east tile
  // (11,10) is a recent tile, so the no-revisit swap fires. In ALT order the
  // first fresh alternate is North (10,9); we make North a spider-wake tile and
  // leave NE (11,9) clean. Legacy takes North (no +x); V36 skips it for NE (+x).
  function setup(simVersion: number): {
    world: WorldState;
    antId: number;
    x0: number;
    y0: number;
  } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = simVersion;
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      { entranceId: allocateEntityId(world), surfaceTileX: 0, surfaceTileY: 0, isOpen: true },
    ];
    world.colonies[COLONY_ID] = colony;

    const TX = 10;
    const TY = 10;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: TX << FP_SHIFT,
      posY: TY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Committed east heading with time on the clock → the wander returns east
    // (empty FoodTrail grid + no food piles → sampler returns {0,0}).
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    world.ants.searchPrevTileX[antId] = -1;
    world.ants.searchPrevTileY[antId] = -1;

    world.pheromoneGrids[pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface')] =
      createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);

    // The proposed east tile (11,10) is recent → triggers the no-revisit swap.
    pushRecentTile(world.ants, antId, TX + 1, TY);

    // North (10,9) — the first fresh alternate — is dangerous; NE (11,9) is clean.
    // (East itself stays clean so the excursion-steer keeps the heading.)
    const danger = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
    phSet(danger, TX, TY - 1, DANGER_ROUTE_AVOID_THRESHOLD + 100);
    world.pheromoneGrids[pheromoneGridKey(COLONY_ID, PheromoneType.DangerTrail, 'surface')] =
      danger;

    return { world, antId, x0: world.ants.posX[antId]!, y0: world.ants.posY[antId]! };
  }

  function move(world: WorldState): void {
    tickAntMovement(
      world,
      new Rng(1),
      createDigFlowFields(),
      createEntranceFlowFields(),
      createChamberFlowFields(),
    );
  }

  it('V36 skips the dangerous North alternate for clean NE (moves +x and −y)', () => {
    const { world, antId, x0, y0 } = setup(SIM_VERSION_V36_RISK_AWARE_FORAGING);
    move(world);
    expect(world.ants.posX[antId]! > x0).toBe(true); // NE: east component
    expect(world.ants.posY[antId]! < y0).toBe(true); // NE: north component
  });

  it('V35 control: takes the first fresh alternate North — only −y, no +x (danger ignored)', () => {
    const { world, antId, x0, y0 } = setup(SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER);
    move(world);
    expect(world.ants.posX[antId]!).toBe(x0); // North: no east component
    expect(world.ants.posY[antId]! < y0).toBe(true); // North: north component
  });
});
