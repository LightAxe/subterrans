// reproduction.test.ts — S4 V21 Reproduction Lever tests
//
// Validation targets (plan):
//   1. Surplus thresholds: crossing 3×/5×/10× boundary changes egg interval
//   2. Nurse acceleration: larva matures in 750 ticks with 100% nurse coverage
//   3. Cap — nurse-side tighter: 3 nurses, 8 larvae → 3 accelerated
//   4. Cap — cap tighter: 10 nurses, 6 larvae, cap=4 → 4 accelerated
//   5. V20 replay: pre-V21 simVersion leaves tickLarvaMaturation as no-op
//   6. D-29 WarFooting: 10× surplus colony reaches AI WarFooting ≥120 ticks earlier

import { describe, it, expect } from 'vitest';
import { tickQueenEggProduction, tickLifecycleTransitions } from './lifecycle-system.js';
import { tickLarvaMaturation } from './larva-maturation.js';
import { createWorldState, SIM_VERSION_V20_SPIDER, SIM_VERSION_V21_REPRODUCTION, SIM_VERSION_V22_DIFFICULTY } from '../types.js';
import { createColonyRecord } from './colony-store.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask, ChamberType, NursingSubState } from '../enums.js';
import { Zone, createUndergroundGrid, ugSet, UndergroundTileState } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import {
  QUEEN_EGG_INTERVAL_TICKS,
  QUEEN_EGG_FOOD_THRESHOLD,
  QUEEN_EGG_INTERVAL_BASE_TICKS,
  QUEEN_EGG_INTERVAL_MEDIUM_TICKS,
  QUEEN_EGG_INTERVAL_FAST_TICKS,
  QUEEN_EGG_INTERVAL_FLOOR_TICKS,
  COLONY_SIZE_FLOOR,
  FOOD_PER_ANT_BASELINE,
  LARVA_MATURE_TICKS,
  LARVA_MATURE_NURSE_ACCELERATION,
  MIN_EGG_INTERVAL_TICKS,
} from '../constants.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord, ColonyId } from './colony-store.js';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;
const MAX_TEST_ENTITIES = 512;
const QUEEN_TILE_X = 8;
const QUEEN_TILE_Y = 4;

function makeWorld(simVersion: number = SIM_VERSION_V21_REPRODUCTION): WorldState {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  world.simVersion = simVersion;
  return world;
}

/**
 * Set up a colony with a live queen inside a Queen chamber footprint.
 * Returns the colony and queen entity ID.
 */
function setupColony(
  world: WorldState,
  foodStored = QUEEN_EGG_FOOD_THRESHOLD,
): { colony: ColonyRecord; queenId: number } {
  const queenId = world.nextEntityId++;
  const posX = (QUEEN_TILE_X << FP_SHIFT) + (FP_ONE >> 1);
  const posY = (QUEEN_TILE_Y << FP_SHIFT) + (FP_ONE >> 1);

  initAnt(world.ants, queenId, {
    colonyId: COLONY_ID,
    posX, posY,
    task: AntTask.Idle,
    speed: 0,
  });
  world.ants.zone[queenId] = Zone.Underground;

  const colony = createColonyRecord(COLONY_ID, queenId);
  colony.foodStored = foodStored;

  // Queen chamber sized around the queen's tile.
  colony.chambers.push({
    chamberId: 100,
    chamberType: ChamberType.Queen,
    foodStored: 0,
    posX: QUEEN_TILE_X << FP_SHIFT,
    posY: QUEEN_TILE_Y << FP_SHIFT,
    width: 2, height: 2,
  });
  // Nursery chamber of 12 tiles (4×3) so the reproduction gates pass.
  colony.chambers.push({
    chamberId: 101,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: 0,
    posY: 0,
    width: 4, height: 3,
  });

  // Underground grid so deposit logic can run.
  const grid = createUndergroundGrid(20, 20);
  ugSet(grid, QUEEN_TILE_X, QUEEN_TILE_Y, UndergroundTileState.Open);
  ugSet(grid, 0, 0, UndergroundTileState.Open);
  world.undergroundGrids[COLONY_ID] = grid;
  world.colonies[COLONY_ID] = colony;

  return { colony, queenId };
}

/**
 * Add a larva at (larvaTileX, larvaTileY) to the colony. Returns the entity ID.
 */
function addLarva(
  world: WorldState,
  colony: ColonyRecord,
  larvaTileX = 1,
  larvaTileY = 1,
): number {
  const id = world.nextEntityId++;
  const posX = (larvaTileX << FP_SHIFT) + (FP_ONE >> 1);
  const posY = (larvaTileY << FP_SHIFT) + (FP_ONE >> 1);
  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX, posY,
    task: AntTask.Idle,
    speed: 0,
  });
  world.ants.zone[id] = Zone.Underground;
  colony.larvae.push(id);
  colony.larvaeCount += 1;
  return id;
}

/**
 * Add a nurse in Attending substate at (nurseTileX, nurseTileY).
 */
function addAttendingNurse(
  world: WorldState,
  colony: ColonyRecord,
  nurseTileX = 1,
  nurseTileY = 1,
): number {
  const id = world.nextEntityId++;
  const posX = (nurseTileX << FP_SHIFT) + (FP_ONE >> 1);
  const posY = (nurseTileY << FP_SHIFT) + (FP_ONE >> 1);
  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX, posY,
    task: AntTask.Nursing,
    speed: 0,
  });
  world.ants.zone[id]    = Zone.Underground;
  world.ants.subTask[id] = NursingSubState.Attending;
  world.ants.searchPauseTicks[id] = 0;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

// Compute the food amount that produces a given sX10 ratio for COLONY_SIZE_FLOOR mouths.
function foodForSX10(sX10: number): number {
  const denom = COLONY_SIZE_FLOOR * FOOD_PER_ANT_BASELINE; // 8 × 60 = 480
  // eslint-disable-next-line no-restricted-syntax -- test helper; integer division is intentional
  return Math.ceil((sX10 * denom) / 10);
}

// ---------------------------------------------------------------------------
// 1. Surplus thresholds
// ---------------------------------------------------------------------------

describe('eggIntervalForColony — V21 surplus thresholds', () => {
  // Pre-threshold (sX10 < 30): BASE interval = 300.
  // We verify by checking that an egg is laid at a tick that's a multiple of
  // the EXPECTED interval but NOT at a tick that's off-cycle.

  it('V20 → unchanged static interval (300 ticks)', () => {
    const world = makeWorld(SIM_VERSION_V20_SPIDER);
    const { colony } = setupColony(world, QUEEN_EGG_FOOD_THRESHOLD);
    world.tick = QUEEN_EGG_INTERVAL_TICKS; // 300
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);

    // Off-cycle tick with V20 still uses static interval.
    world.tick = QUEEN_EGG_INTERVAL_MEDIUM_TICKS; // 250 — NOT a multiple of 300
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1); // no new egg
  });

  it('V21, lean food (base interval=300): lays at 300, not at 250', () => {
    const world = makeWorld();
    const { colony } = setupColony(world, QUEEN_EGG_FOOD_THRESHOLD); // sX10 = 16 → BASE
    world.tick = QUEEN_EGG_INTERVAL_BASE_TICKS; // 300
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);

    // 250 is not a multiple of 300.
    world.tick = QUEEN_EGG_INTERVAL_MEDIUM_TICKS; // 250
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);
  });

  it('V21, 3× surplus (medium interval=250): lays at 250, not at 300', () => {
    // sX10 >= 30: food = foodForSX10(30) = ceil(30*480/10) = ceil(1440) = 1440
    const world = makeWorld();
    const { colony } = setupColony(world, foodForSX10(30));
    world.tick = QUEEN_EGG_INTERVAL_MEDIUM_TICKS; // 250
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);

    // 300 is also a multiple of nothing we expect — actually 300 % 250 = 50 ≠ 0
    // so confirm no second egg at 300.
    // Reset colony eggs for clean count.
    colony.eggs.length = 0; colony.eggCount = 0;
    world.tick = QUEEN_EGG_INTERVAL_BASE_TICKS; // 300 — not a multiple of 250
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);
  });

  it('V21, 5× surplus (fast interval=200): lays at 200, not at 250', () => {
    // sX10 >= 50: food = foodForSX10(50) = ceil(50*480/10) = 2400
    const world = makeWorld();
    const { colony } = setupColony(world, foodForSX10(50));
    world.tick = QUEEN_EGG_INTERVAL_FAST_TICKS; // 200
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);

    colony.eggs.length = 0; colony.eggCount = 0;
    world.tick = QUEEN_EGG_INTERVAL_MEDIUM_TICKS; // 250 — not a multiple of 200
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);
  });

  it('V21, 10× surplus (floor interval=150): lays at 150, not at 200', () => {
    // sX10 >= 100: food = foodForSX10(100) = ceil(100*480/10) = 4800
    const world = makeWorld();
    const { colony } = setupColony(world, foodForSX10(100));
    world.tick = QUEEN_EGG_INTERVAL_FLOOR_TICKS; // 150
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);

    colony.eggs.length = 0; colony.eggCount = 0;
    world.tick = QUEEN_EGG_INTERVAL_FAST_TICKS; // 200 — not a multiple of 150
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);
  });

  it('V21, food below threshold → no egg (DISABLED sentinel)', () => {
    const world = makeWorld();
    const { colony } = setupColony(world, QUEEN_EGG_FOOD_THRESHOLD - 1);
    world.tick = 0;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Nurse acceleration: 100% coverage → matures in 750 ticks
// ---------------------------------------------------------------------------

describe('tickLarvaMaturation — nurse acceleration', () => {
  it('larva with 100% adjacent nurse coverage matures in LARVA_MATURE_TICKS / 2 ticks', () => {
    const world = makeWorld();
    const { colony } = setupColony(world);

    const larvaId = addLarva(world, colony, 1, 1);
    addAttendingNurse(world, colony, 1, 1); // same tile — Manhattan-0 ≤ 1

    // The larva has a Nursery chamber (cap=12) in the colony already.
    // Each tick: tickLifecycleTransitions gives +1 (baseline), tickLarvaMaturation gives +1 (nurse).
    // Total: +2 per tick → mature at LARVA_MATURE_TICKS / 2 = 750 ticks.

    // eslint-disable-next-line no-restricted-syntax -- test-only constant; LARVA_MATURE_TICKS is even
    const halfMature = LARVA_MATURE_TICKS / 2; // 750

    for (let t = 0; t < halfMature - 1; t++) {
      tickLifecycleTransitions(world, colony);
      tickLarvaMaturation(world, colony);
    }
    // One tick before maturation: larva should still be alive.
    expect(world.ants.alive[larvaId]).toBe(1);
    expect(colony.larvaeCount).toBe(1);
    expect(colony.workerCount).toBe(1); // the nurse counted as a worker

    // Final tick: promotes.
    tickLifecycleTransitions(world, colony);
    tickLarvaMaturation(world, colony);

    expect(colony.larvaeCount).toBe(0);
    expect(colony.workerCount).toBe(2); // nurse + promoted worker
    expect(world.ants.task[larvaId]).toBe(AntTask.Idle);
  });
});

// ---------------------------------------------------------------------------
// 3. Cap — nurse-side tighter (3 nurses, 8 larvae, cap=12)
// ---------------------------------------------------------------------------

describe('tickLarvaMaturation — throughput cap (nurse-side binds)', () => {
  it('3 nurses, 8 larvae, cap=12 → exactly 3 larvae accelerated', () => {
    const world = makeWorld();
    const { colony } = setupColony(world);
    // cap = 12 from the 4×3 Nursery chamber added by setupColony.

    // Add 8 larvae at tile (1,1).
    const larvaIds: number[] = [];
    for (let i = 0; i < 8; i++) larvaIds.push(addLarva(world, colony, 1, 1));

    // Add 3 nurses at tile (1,1).
    for (let i = 0; i < 3; i++) addAttendingNurse(world, colony, 1, 1);

    // Record ages before.
    const agesBefore = larvaIds.map(id => world.ants.age[id]!);

    // Baseline tick: each larva gets +1.
    tickLifecycleTransitions(world, colony);
    // Nurse acceleration: 3 slots available, 3 nurses, cap=12 — nurse-count binds.
    tickLarvaMaturation(world, colony);

    // After baseline: all larva ages = 1. After nurse pass: 3 have age 2.
    let acceleratedCount = 0;
    for (const id of larvaIds) {
      const ageDelta = world.ants.age[id]! - agesBefore[larvaIds.indexOf(id)]!;
      if (ageDelta === 1 + LARVA_MATURE_NURSE_ACCELERATION) acceleratedCount++;
    }
    expect(acceleratedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Cap — cap tighter (10 nurses, 6 larvae, cap=4)
// ---------------------------------------------------------------------------

describe('tickLarvaMaturation — throughput cap (cap binds)', () => {
  it('10 nurses, 6 larvae, cap=4 → exactly 4 larvae accelerated', () => {
    const world = makeWorld();
    const { colony } = setupColony(world);

    // Replace the default 4×3 Nursery (cap=12) with a 2×2 (cap=4).
    const nurseryIdx = colony.chambers.findIndex(c => c.chamberType === ChamberType.Nursery);
    colony.chambers[nurseryIdx]!.width  = 2;
    colony.chambers[nurseryIdx]!.height = 2;

    // Add 6 larvae at tile (1,1).
    const larvaIds: number[] = [];
    for (let i = 0; i < 6; i++) larvaIds.push(addLarva(world, colony, 1, 1));

    // Add 10 nurses at tile (1,1).
    for (let i = 0; i < 10; i++) addAttendingNurse(world, colony, 1, 1);

    const agesBefore = larvaIds.map(id => world.ants.age[id]!);

    tickLifecycleTransitions(world, colony);
    tickLarvaMaturation(world, colony);

    let acceleratedCount = 0;
    for (let i = 0; i < larvaIds.length; i++) {
      const id = larvaIds[i]!;
      const ageDelta = world.ants.age[id]! - agesBefore[i]!;
      if (ageDelta === 1 + LARVA_MATURE_NURSE_ACCELERATION) acceleratedCount++;
    }
    expect(acceleratedCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 6. D-29: 10× surplus colony reaches workerCount=10 ≥120 ticks earlier
//
// Demonstrates that faster egg interval (150 vs 300 ticks) from the
// food-surplus lever leads to a measurable reproduction advantage.
//
// Setup: colony starts with 9 workers, queen in Queen chamber, Nursery
// chamber present. Food is pinned each tick. Runs tickQueenEggProduction +
// tickLifecycleTransitions + tickLarvaMaturation per "tick" and records
// the sim tick when workerCount reaches 10 (one new worker from reproduction).
//
// Expected timing (no nurse adjacency, so no acceleration):
//   Lean  (interval=300): first egg at t=300, larva at t=1500, worker at t=3900
//   Rich  (interval=150): first egg at t=150, larva at t=1350, worker at t=3750
//   Delta: 150 ticks ≥ MIN_TICK_DELTA (120)
// ---------------------------------------------------------------------------

describe('D-29 WarFooting — reproduction speed advantage', () => {
  function makeD29World(foodLevel: number): { world: WorldState; colony: ColonyRecord } {
    const world = makeWorld(SIM_VERSION_V21_REPRODUCTION);
    world.tick = 0;
    const { colony } = setupColony(world, foodLevel);

    // Place queen at QUEEN_TILE_X, QUEEN_TILE_Y (inside the Queen chamber from setupColony).
    // Gate 6 (queen-in-chamber) is already satisfied by setupColony.

    // Add 9 pre-existing workers (workerCount = 9).
    for (let i = 0; i < 9; i++) {
      const id = world.nextEntityId++;
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: (QUEEN_TILE_X << FP_SHIFT) + (FP_ONE >> 1),
        posY: (QUEEN_TILE_Y << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Idle,
        speed: 0,
      });
      world.ants.zone[id] = Zone.Underground;
      colony.workers.push(id);
      colony.workerCount += 1;
    }
    return { world, colony };
  }

  it(
    '10× surplus colony reaches workerCount=10 ≥120 ticks before lean colony',
    () => {
      const MAX_TICKS = 8400;
      const MIN_TICK_DELTA = 120;

      // With 9 workers + queen (mouths = max(10, COLONY_SIZE_FLOOR=8) = 10):
      //   denom = 10 × FOOD_PER_ANT_BASELINE (60) = 600
      //   Lean: food=768  → sX10 = floor(768×10/600) = 12 → BASE interval (300)
      //   Rich: food=6000 → sX10 = floor(6000×10/600) = 100 → FLOOR interval (150)
      const LEAN_FOOD = QUEEN_EGG_FOOD_THRESHOLD; // 768
      // foodForSX10(100) = 4800 with 8 mouths (COLONY_SIZE_FLOOR), but with 10 mouths
      // (9 workers + queen) the threshold for FLOOR interval needs food ≥ 6000.
      const RICH_FOOD_10X = 6000; // sX10 = floor(6000×10/600) = 100 → FLOOR (150)

      const { world: worldA, colony: colonyA } = makeD29World(LEAN_FOOD);
      const { world: worldB, colony: colonyB } = makeD29World(RICH_FOOD_10X);

      // Reset queenLastEggTick so neither world lays at t=1 (default=-300 would
      // give elapsed=301>=300, firing both worlds at the same tick and masking the
      // interval difference). Setting to 0 means lean lays at t=300, rich at t=150.
      colonyA.queenLastEggTick = 0;
      colonyB.queenLastEggTick = 0;

      let reachTickA = -1;
      let reachTickB = -1;

      for (let t = 1; t < MAX_TICKS; t++) {
        // Pin food so the surplus tier stays constant across the run.
        colonyA.foodStored = LEAN_FOOD;
        colonyB.foodStored = RICH_FOOD_10X;

        worldA.tick = t;
        worldB.tick = t;

        tickQueenEggProduction(worldA, colonyA);
        tickLifecycleTransitions(worldA, colonyA);
        tickLarvaMaturation(worldA, colonyA);

        tickQueenEggProduction(worldB, colonyB);
        tickLifecycleTransitions(worldB, colonyB);
        tickLarvaMaturation(worldB, colonyB);

        if (reachTickA < 0 && colonyA.workerCount >= 10) reachTickA = t;
        if (reachTickB < 0 && colonyB.workerCount >= 10) reachTickB = t;

        if (reachTickA >= 0 && reachTickB >= 0) break;
      }

      expect(
        reachTickB,
        `Rich colony never reached workerCount=10 within ${MAX_TICKS} ticks`,
      ).toBeGreaterThan(0);

      const delta = reachTickA - reachTickB;
      expect(
        delta,
        `Expected rich colony to reach 10 workers ≥${MIN_TICK_DELTA} ticks before lean ` +
        `(lean=${reachTickA}, rich=${reachTickB}, delta=${delta})`,
      ).toBeGreaterThanOrEqual(MIN_TICK_DELTA);
    },
  );
});

// ---------------------------------------------------------------------------
// 7. V22 difficulty brood modifier — AI egg interval scaling
// ---------------------------------------------------------------------------

describe('V22 difficulty brood modifier — AI egg interval', () => {
  const AI_COLONY_ID = 2;

  function setupAIColony(world: WorldState, foodStored = foodForSX10(100)): ColonyRecord {
    const queenId = world.nextEntityId++;
    const posX = (QUEEN_TILE_X << FP_SHIFT) + (FP_ONE >> 1);
    const posY = (QUEEN_TILE_Y << FP_SHIFT) + (FP_ONE >> 1);
    initAnt(world.ants, queenId, { colonyId: AI_COLONY_ID, posX, posY, task: AntTask.Idle, speed: 0 });
    world.ants.zone[queenId] = Zone.Underground;

    const colony = createColonyRecord(AI_COLONY_ID as ColonyId, queenId);
    colony.foodStored = foodStored;
    colony.queenLastEggTick = 0; // prevent default -300 from firing early
    colony.chambers.push({
      chamberId: 200,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: QUEEN_TILE_X << FP_SHIFT,
      posY: QUEEN_TILE_Y << FP_SHIFT,
      width: 2, height: 2,
    });
    colony.chambers.push({
      chamberId: 201,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 0, posY: 0,
      width: 4, height: 3,
    });
    const grid = createUndergroundGrid(20, 20);
    ugSet(grid, QUEEN_TILE_X, QUEEN_TILE_Y, UndergroundTileState.Open);
    ugSet(grid, 0, 0, UndergroundTileState.Open);
    world.undergroundGrids[AI_COLONY_ID] = grid;
    world.colonies[AI_COLONY_ID] = colony;
    return colony;
  }

  it('eggIntervalNumerator=3 (Hard): lays at tick 112 (150*3>>2=112), not at 111', () => {
    const world = makeWorld(SIM_VERSION_V22_DIFFICULTY);
    const colony = setupAIColony(world);
    colony.eggIntervalNumerator = 3; // Hard

    world.tick = 111;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);

    world.tick = 112;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);
  });

  it('eggIntervalNumerator=4 (Normal): interval unchanged — lays at 150, not at 149', () => {
    const world = makeWorld(SIM_VERSION_V22_DIFFICULTY);
    const colony = setupAIColony(world);
    // default eggIntervalNumerator=4 (identity: 150*4>>2=150)

    world.tick = 149;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);

    world.tick = 150;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);
  });

  it('eggIntervalNumerator=5 (Easy): lays at tick 187 (150*5>>2=187), not at 150', () => {
    const world = makeWorld(SIM_VERSION_V22_DIFFICULTY);
    const colony = setupAIColony(world);
    colony.eggIntervalNumerator = 5; // Easy

    world.tick = 150; // would fire at Normal (numerator=4) but not Easy
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);

    world.tick = 187;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);
  });

  it('pre-V22 (V21): eggIntervalNumerator=3 is ignored — interval unchanged at 150 ticks', () => {
    const world = makeWorld(SIM_VERSION_V21_REPRODUCTION);
    const colony = setupAIColony(world);
    colony.eggIntervalNumerator = 3; // Hard, but V22 gate not active

    world.tick = 150;
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1); // no V22 modifier → fires at 150
  });

  it('Hard modifier (numerator=3) keeps interval above MIN_EGG_INTERVAL_TICKS (100)', () => {
    // floor interval=150, Hard: 150*3>>2=112 > 100 — clamp does not fire in standard play.
    expect((QUEEN_EGG_INTERVAL_FLOOR_TICKS * 3) >> 2).toBeGreaterThanOrEqual(MIN_EGG_INTERVAL_TICKS);
    expect(MIN_EGG_INTERVAL_TICKS).toBe(100);
  });
});
