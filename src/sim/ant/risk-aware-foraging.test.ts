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
import { chooseExcursionDirection, tickExcursionBoundary } from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER,
  SIM_VERSION_V36_RISK_AWARE_FORAGING,
  type WorldState,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
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

    const rngV35 = new Rng(999);
    sampleForagingDirection(food, 5, 5, rngV35); // no danger grid (V35 / legacy): layer 1, 0 draws
    const rngV36 = new Rng(999);
    sampleForagingDirection(food, 5, 5, rngV36, -1, -1, danger); // V36: layer 2, ≥ 1 draw

    // Same seed, but the danger path consumed RNG the legacy path did not — the
    // streams have diverged. This is the PRNG draw-count change the world-level
    // replay tests (determinism.test.ts) then prove stays deterministic.
    expect(rngV35.nextInt(1_000_000)).not.toBe(rngV36.nextInt(1_000_000));
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
