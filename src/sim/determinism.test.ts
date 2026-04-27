// src/sim/determinism.test.ts
// SCEN-06 proof — two runs from the same seed produce byte-identical serialized WorldState
// after N ticks. Phase 6 SCs 1-4 end-to-end integration proofs.
// Phase 7 adds: createScenario + MarkDigTile determinism proof.
//
// All constant assertions reference imported symbols from constants.ts — never hardcoded
// PRD §9c literals. If balance constants change, these tests adapt automatically.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createWorldState, allocateEntityId } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import { createPheromoneGrid, phGet, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { AntTask, PheromoneType, ForagingSubState, ChamberType } from './enums.js';
import {
  WORKER_LIFESPAN_TICKS,
  WORKER_BASE_SPEED,
  STARVATION_GRACE_TICKS,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  ENEMY_START_X,
  ENEMY_START_Y,
} from './constants.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import type { WorldState } from './types.js';
import type { SimCommand } from './commands.js';
import type { ColonyId } from './colony/colony-store.js';
import { createScenario } from './scenario.js';

// ---------------------------------------------------------------------------
// Helper: deterministic serialization
// ---------------------------------------------------------------------------

function serializeWorldState(w: WorldState): string {
  return JSON.stringify({
    tick: w.tick,
    rngState: w.rngState,
    nextEntityId: w.nextEntityId,
    commandQueue: w.commandQueue.map(c => ({ ...c })),
    ants: {
      posX:            Array.from(w.ants.posX),
      posY:            Array.from(w.ants.posY),
      alive:           Array.from(w.ants.alive),
      age:             Array.from(w.ants.age),
      task:            Array.from(w.ants.task),
      subTask:         Array.from(w.ants.subTask),
      speed:           Array.from(w.ants.speed),
      lifespan:        Array.from(w.ants.lifespan),
      colonyId:        Array.from(w.ants.colonyId),
      foodCarrying:    Array.from(w.ants.foodCarrying),
      starvationTimer: Array.from(w.ants.starvationTimer),
      // Phase 7 ant fields:
      zone:               Array.from(w.ants.zone),
      digTileX:           Array.from(w.ants.digTileX),
      digTileY:           Array.from(w.ants.digTileY),
      digTicksRemaining:  Array.from(w.ants.digTicksRemaining),
      targetPosX:         Array.from(w.ants.targetPosX),
      targetPosY:         Array.from(w.ants.targetPosY),
      // Phase 09.1 Chunk 0 — grid-of-occupancy byte (new SoA field).
      currentGridColonyId: Array.from(w.ants.currentGridColonyId),
      // Phase 9 — 6 previously-omitted SoA fields (pre-existing serializer
      // gap closed here per 09.1-00-PLAN). If closure surfaces a latent
      // non-deterministic divergence in one of these fields, revert ONLY the
      // 6 search* lines and document in 09.1-MEMO.md §5 Deviations Log.
      searchWave:         Array.from(w.ants.searchWave),
      searchHeadingX:     Array.from(w.ants.searchHeadingX),
      searchHeadingY:     Array.from(w.ants.searchHeadingY),
      searchHeadingTicks: Array.from(w.ants.searchHeadingTicks),
      searchPrevTileX:    Array.from(w.ants.searchPrevTileX),
      searchPrevTileY:    Array.from(w.ants.searchPrevTileY),
    },
    colonies: Object.keys(w.colonies).sort().reduce((acc, k) => {
      const c = w.colonies[Number(k) as ColonyId]!;
      acc[k] = {
        colonyId:             c.colonyId,
        queenEntityId:        c.queenEntityId,
        queenStarvationTimer: c.queenStarvationTimer,
        foodStored:           c.foodStored,
        workerCount:          c.workerCount,
        eggCount:             c.eggCount,
        larvaeCount:          c.larvaeCount,
        nurseCount:           c.nurseCount,
        defeated:             c.defeated,
        reconcileCountdown:   c.reconcileCountdown,
        killCount:            c.killCount,
        digFlowFieldDirty:    c.digFlowFieldDirty,
        eggs:                 [...c.eggs],
        larvae:               [...c.larvae],
        workers:              [...c.workers],
        chambers:             c.chambers.map(ch => ({ ...ch })),
        entrances:            c.entrances.map(e => ({ ...e })),
        targetRatio:          { ...c.targetRatio },
        computedAllocation:   { ...c.computedAllocation },
        taskCensus:           { ...c.taskCensus },
      };
      return acc;
    }, {} as Record<string, unknown>),
    pheromoneGrids: Object.keys(w.pheromoneGrids).sort().reduce((acc, k) => {
      const g = w.pheromoneGrids[k]!;
      acc[k] = { width: g.width, height: g.height, data: Array.from(g.data) };
      return acc;
    }, {} as Record<string, unknown>),
    // Phase 7: underground grids
    undergroundGrids: Object.keys(w.undergroundGrids).sort().reduce((acc, k) => {
      const g = w.undergroundGrids[Number(k) as ColonyId]!;
      acc[k] = { width: g.width, height: g.height, data: Array.from(g.data) };
      return acc;
    }, {} as Record<string, unknown>),
    // Phase 7: food piles and pending chambers
    foodPiles: w.foodPiles.map(p => ({ ...p })),
    pendingChambers: Object.keys(w.pendingChambers).sort().reduce((acc, k) => {
      acc[k] = { ...w.pendingChambers[k]! };
      return acc;
    }, {} as Record<string, unknown>),
  });
}

// ---------------------------------------------------------------------------
// Helper: build + run a simulation, return serialized state
// ---------------------------------------------------------------------------

function buildWorld(seed: number): { world: WorldState; queenId: number; colonyId: ColonyId } {
  const world = createWorldState(seed);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId:  1,
    posX:      32 << FP_SHIFT,
    posY:      32 << FP_SHIFT,
    task:      AntTask.Idle,
    subTask:   0,
    speed:     0,
    lifespan:  WORKER_LIFESPAN_TICKS,
  });
  world.colonies[1] = createColonyRecord(1, queenId);
  // Issue #15: chamber.foodStored is now per-chamber authoritative. The
  // synthetic 100000fp head-start has to live in chambers, not the entrance
  // pool — reconcile clamps colony.foodStored to BASE alone so dumping 100000
  // into the pool would collapse to 2048 on the first reconcile and starve
  // the queen well before Test 6's pipeline completes. Spread the head-start
  // across 20 chambers (5000fp each, all under FOOD_CHAMBER_CAPACITY=5120).
  world.colonies[1]!.foodStored = 0;
  for (let i = 0; i < 20; i++) {
    world.colonies[1]!.chambers.push({
      chamberId:   1000 + i,
      chamberType: ChamberType.FoodStorage,
      foodStored:  5000,
      posX:        0,
      posY:        0,
      width:       3,
      height:      3,
    });
  }
  // 09 reproduction-gate memo: queen egg production requires a completed
  // Queen chamber AND a completed Nursery chamber. Seed both so the lifecycle
  // pipeline (Test 6) reaches the first worker by tick 3600.
  //
  // seed936214196-tick2401 Gate 6: tickQueenEggProduction now also requires
  // the queen to be Underground AND physically inside the Queen chamber
  // footprint. Anchor the Queen chamber around the queen's tile (32,32) and
  // flip her zone to Underground so the pipeline is unblocked without having
  // to simulate relocation via entrances (Test 6 has no entrances or
  // underground grid — it's a behavior-free lifecycle harness).
  world.colonies[1]!.chambers.push({
    chamberId:   1100,
    chamberType: ChamberType.Queen,
    foodStored:  0,
    posX:        32 << FP_SHIFT, posY: 32 << FP_SHIFT, width: 2, height: 2,
  });
  world.colonies[1]!.chambers.push({
    chamberId:   1101,
    chamberType: ChamberType.Nursery,
    foodStored:  0,
    posX:        0, posY: 0, width: 2, height: 2,
  });
  world.ants.zone[queenId] = 1; // Zone.Underground — Gate 6 precondition
  // Phase 3 PRD §2a caller-side extension fields (factory does not set these):
  world.colonies[1]!.entrances          = [];
  world.colonies[1]!.rallyPoint         = null;
  world.colonies[1]!.digFlowFieldDirty  = false;
  world.colonies[1]!.foodFlowFieldDirty = false;
  world.pheromoneGrids[pheromoneGridKey(1, PheromoneType.FoodTrail, 'surface')] =
    createPheromoneGrid(64, 64);
  return { world, queenId, colonyId: 1 as ColonyId };
}

function runSimulation(
  seed: number,
  ticks: number,
  commandsPerTick: readonly SimCommand[][] = [],
): string {
  const { world } = buildWorld(seed);
  for (let t = 0; t < ticks; t++) {
    tick(world, commandsPerTick[t] ?? []);
  }
  return serializeWorldState(world);
}

function runSimulationWithState(
  seed: number,
  ticks: number,
  commandsPerTick: readonly SimCommand[][] = [],
): { world: WorldState; queenId: number; colonyId: ColonyId } {
  const result = buildWorld(seed);
  for (let t = 0; t < ticks; t++) {
    tick(result.world, commandsPerTick[t] ?? []);
  }
  return result;
}

// ---------------------------------------------------------------------------
// SCEN-06 tests — Phase 6 SC 9 (determinism)
// ---------------------------------------------------------------------------

describe('SCEN-06: Determinism proof', () => {
  // Test 1: Seed 42 × 100 ticks — byte-for-byte identical
  it('Test 1: seed 42 × 100 ticks — byte-for-byte identical across two independent runs', () => {
    const r1 = runSimulation(42, 100);
    const r2 = runSimulation(42, 100);
    expect(r1).toBe(r2);
  });

  // Test 2: Seed 42 × 1000 ticks — byte-for-byte identical
  it('Test 2: seed 42 × 1000 ticks — byte-for-byte identical across two independent runs', () => {
    const r1 = runSimulation(42, 1000);
    const r2 = runSimulation(42, 1000);
    expect(r1).toBe(r2);
  });

  // Test 3: Different seeds produce different state
  it('Test 3: different seeds produce different serialized state after 100 ticks', () => {
    const r1 = runSimulation(42, 100);
    const r3 = runSimulation(99, 100);
    expect(r1).not.toBe(r3);
  });

  // Test 4: Same seed, same commands, identical output
  it('Test 4: same seed + same commands produce identical state', () => {
    const ratioCmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId: 1 as ColonyId,
      ratio: { forage: 7, dig: 2, fight: 1 },
      issuedAtTick: 50,
    };
    const digCmd: SimCommand = {
      type: 'MarkDigTile',
      colonyId: 1 as ColonyId,
      tileX: 10,
      tileY: 10,
      issuedAtTick: 70,
    };
    const cmds: SimCommand[][] = [];
    cmds[50] = [ratioCmd];
    cmds[70] = [digCmd];

    const r1 = runSimulation(42, 100, cmds);
    const r2 = runSimulation(42, 100, cmds);
    expect(r1).toBe(r2);
  });

  // Test 5: Same seed, different commands, different state
  it('Test 5: same seed + different commands at tick 50 produce different state', () => {
    const cmdsA: SimCommand[][] = [];
    cmdsA[50] = [{ type: 'SetBehaviorRatio', colonyId: 1 as ColonyId, ratio: { forage: 10, dig: 0, fight: 0 }, issuedAtTick: 50 }];

    const cmdsB: SimCommand[][] = [];
    cmdsB[50] = [{ type: 'SetBehaviorRatio', colonyId: 1 as ColonyId, ratio: { forage: 0, dig: 10, fight: 0 }, issuedAtTick: 50 }];

    const r1 = runSimulation(42, 100, cmdsA);
    const r2 = runSimulation(42, 100, cmdsB);
    expect(r1).not.toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 1 — full pipeline (queen → egg → larva → worker)
// ---------------------------------------------------------------------------

describe('Phase 6 SC 1: queen → egg → larva → worker pipeline', () => {
  // Test 6: Full lifecycle pipeline
  it('Test 6: queen produces egg → egg becomes larva → larva becomes worker after 3700 ticks', () => {
    const { world, colonyId } = runSimulationWithState(42, 3700);
    const colony = world.colonies[colonyId]!;
    // At least one worker must have been produced from the pipeline
    expect(colony.workerCount).toBeGreaterThanOrEqual(1);
    // Pipeline is still producing — eggs and/or larvae present
    expect(colony.eggCount + colony.larvaeCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 2 — starvation cascade
// ---------------------------------------------------------------------------

describe('Phase 6 SC 2: starvation cascade', () => {
  // Test 7: Unfed queen dies after STARVATION_GRACE_TICKS
  it('Test 7: unfed queen dies after STARVATION_GRACE_TICKS + 1 ticks', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId:  1,
      posX:      1024,
      posY:      1024,
      task:      AntTask.Idle,
      subTask:   0,
      speed:     0,
      lifespan:  WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 0;                            // no food — queen cannot eat
    world.colonies[1]!.queenStarvationTimer = STARVATION_GRACE_TICKS; // timer at full grace

    // Run STARVATION_GRACE_TICKS + 1 ticks — timer decrements by 1 each tick until <= 0 → death
    for (let t = 0; t < STARVATION_GRACE_TICKS + 1; t++) {
      tick(world, []);
    }

    expect(world.ants.alive[queenId]).toBe(0);
    expect(world.colonies[1]!.defeated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 3 — pheromone deposit on traversed cells
// ---------------------------------------------------------------------------

describe('Phase 6 SC 3: pheromone deposit on traversed cells', () => {
  // Test 8: Food-carrying worker leaves trail
  it('Test 8: food-carrying worker at tile (10,10) leaves a food-trail deposit after 1 tick', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId:  1,
      posX:      1024,
      posY:      1024,
      task:      AntTask.Idle,
      subTask:   0,
      speed:     0,
      lifespan:  WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 100000;

    const workerId = allocateEntityId(world);
    initAnt(world.ants, workerId, {
      colonyId:  1,
      posX:      10 << FP_SHIFT,
      posY:      10 << FP_SHIFT,
      task:      AntTask.Foraging,
      subTask:   ForagingSubState.CarryingFood,
      speed:     WORKER_BASE_SPEED,
      lifespan:  WORKER_LIFESPAN_TICKS,
    });
    world.ants.foodCarrying[workerId] = 512; // carrying food — deposit rule activates
    world.colonies[1]!.workers.push(workerId);
    world.colonies[1]!.workerCount = 1;

    const gridKey = pheromoneGridKey(1, PheromoneType.FoodTrail, 'surface');
    const foodGrid = createPheromoneGrid(64, 64);
    world.pheromoneGrids[gridKey] = foodGrid;

    tick(world, []);

    // Step 10 deposited food trail; step 11 decayed it slightly but not to 0
    expect(phGet(foodGrid, 10, 10)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 4 — CTRL-04 one-tick allocation
// ---------------------------------------------------------------------------

describe('Phase 6 SC 4: CTRL-04 one-tick immediate allocation', () => {
  // Test 9: SetBehaviorRatio at tick N updates computedAllocation in tick N output
  it('Test 9: issuing SetBehaviorRatio at tick N updates computedAllocation at tick N (not N+1)', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId:  1,
      posX:      1024,
      posY:      1024,
      task:      AntTask.Idle,
      subTask:   0,
      speed:     0,
      lifespan:  WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 100000;

    // Add 10 workers (all Idle — no brood)
    for (let i = 0; i < 10; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId:  1,
        posX:      1024,
        posY:      1024,
        task:      AntTask.Idle,
        subTask:   0,
      });
      world.colonies[1]!.workers.push(wid);
      world.colonies[1]!.workerCount += 1;
    }

    // Set initial targetRatio → forage:10 (all 10 workers allocated to forage)
    world.colonies[1]!.targetRatio.forage = 10;
    world.colonies[1]!.targetRatio.dig    = 0;
    world.colonies[1]!.targetRatio.fight  = 0;

    // Tick 0 (no commands): allocation reflects forage:10 ratio
    tick(world, []);
    expect(world.colonies[1]!.computedAllocation.forage).toBe(10);
    expect(world.colonies[1]!.computedAllocation.dig).toBe(0);

    // Tick 1: issue SetBehaviorRatio switching to all-dig
    const cmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId: 1 as ColonyId,
      ratio: { forage: 0, dig: 10, fight: 0 },
      issuedAtTick: 1,
    };
    tick(world, [cmd]);

    // The new ratio takes effect in the SAME tick the command is issued (CTRL-04).
    // NOT in the "next tick after this one".
    expect(world.colonies[1]!.computedAllocation.forage).toBe(0);
    expect(world.colonies[1]!.computedAllocation.dig).toBe(10);
    expect(world.colonies[1]!.computedAllocation.fight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No-allocation invariant (object-identity proof)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 7: createScenario determinism proof
// ---------------------------------------------------------------------------

describe('Phase 7: createScenario determinism with MarkDigTile commands', () => {
  // Test 11: createScenario(42) + 100 ticks with MarkDigTile commands → byte-identical across two runs
  it('Test 11: createScenario(42) × 100 ticks with MarkDigTile — byte-for-byte identical', () => {
    const colonyId = PLAYER_COLONY_ID as ColonyId;

    // Build a fixed command schedule: mark several tiles at specific ticks
    const cmds: SimCommand[][] = [];
    cmds[0]  = [{ type: 'MarkDigTile', colonyId, tileX: 10, tileY: 5, issuedAtTick: 0 }];
    cmds[10] = [{ type: 'MarkDigTile', colonyId, tileX: 15, tileY: 8, issuedAtTick: 10 }];
    cmds[20] = [{ type: 'MarkDigTile', colonyId, tileX: 20, tileY: 10, issuedAtTick: 20 }];
    cmds[30] = [{ type: 'CancelDigMark', colonyId, tileX: 10, tileY: 5, issuedAtTick: 30 }];
    cmds[50] = [{
      type: 'SetBehaviorRatio', colonyId,
      ratio: { forage: 0, dig: 10, fight: 0 },
      issuedAtTick: 50,
    }];

    function runScenario(): string {
      const world = createScenario(42);
      for (let t = 0; t < 100; t++) {
        tick(world, cmds[t] ?? []);
      }
      return serializeWorldState(world);
    }

    const r1 = runScenario();
    const r2 = runScenario();
    expect(r1).toBe(r2);
  });
});

describe('No-allocation invariant: object identity in steady state', () => {
  // Test 10: targetRatio, computedAllocation, taskCensus are mutated in-place (not replaced)
  it('Test 10: colony.targetRatio/computedAllocation/taskCensus are the SAME objects after 100 ticks', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId:  1,
      posX:      32 << FP_SHIFT,
      posY:      32 << FP_SHIFT,
      task:      AntTask.Idle,
      subTask:   0,
      speed:     0,
      lifespan:  WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 100000;

    // 10 warm-up ticks to stabilize
    for (let i = 0; i < 10; i++) tick(world, []);

    // Capture object references after warmup
    const colony = world.colonies[1]!;
    const targetRatioRef        = colony.targetRatio;
    const computedAllocationRef = colony.computedAllocation;
    const taskCensusRef         = colony.taskCensus;

    // Run 100 more ticks
    for (let i = 0; i < 100; i++) tick(world, []);

    // Objects must be the SAME reference — tick.ts mutates fields in-place, never replaces objects
    expect(colony.targetRatio).toBe(targetRatioRef);
    expect(colony.computedAllocation).toBe(computedAllocationRef);
    expect(colony.taskCensus).toBe(taskCensusRef);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 SC 5 — two-colony determinism proof (appended)
// ---------------------------------------------------------------------------

describe('Phase 9 determinism (SC 5) — two-colony parity', () => {
  // Test A: pure determinism — same seed, no commands, 500 ticks, byte-identical serialized state.
  it('500-tick two-colony parity: identical seeds produce byte-identical serialized states', () => {
    const seed = 424242;
    const worldA = createScenario(seed);
    const worldB = createScenario(seed);

    const TICKS = 500;
    for (let i = 0; i < TICKS; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }

    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 20_000);

  // Test B: combat-surface determinism — forcing ants together then running 500 ticks still parity-clean.
  // We don't need a full "force workers to tile" helper — createScenario already spawns both colonies
  // near each other per PLAYER_START_X/Y and ENEMY_START_X/Y (constants.ts). Over 500 ticks foragers
  // naturally wander, encounter enemies, and trigger combat. If Phase 9 combat/AI/rally paths are
  // non-deterministic, the serialized states will diverge even without artificial placement.
  it('500-tick two-colony parity with natural combat: worlds still serialize identically', () => {
    const seed = 31415;
    const worldA = createScenario(seed);
    const worldB = createScenario(seed);

    for (let i = 0; i < 500; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }

    // Sanity: both colonies still present (no freak ENOENT on colony lookup).
    expect(worldA.colonies[PLAYER_COLONY_ID]).toBeDefined();
    expect(worldA.colonies[ENEMY_COLONY_ID]).toBeDefined();

    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 20_000);

  // Test C: rngState scalar parity — cheaper fast-fail on drift.
  it('RNG scalar parity: rngState identical after 500 ticks', () => {
    const seed = 17;
    const worldA = createScenario(seed);
    const worldB = createScenario(seed);
    for (let i = 0; i < 500; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }
    expect(worldA.rngState).toBe(worldB.rngState);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Phase 09.1 Chunk 4 (plan 09.1-04) — cross-grid combat parity (REQ-C4c)
// ---------------------------------------------------------------------------
//
// The generic two-colony parity cases above do NOT exercise the Chunk-4
// tile-key extension (makeTileKey's new gridColonyId byte) because their
// scenarios never produce an ant with `ants.currentGridColonyId[id] !==
// ants.colonyId[id]` — i.e., no ant descends into a FOREIGN underground grid.
// Without that divergence, the new gridByte in the bucket key is always 0 for
// underground ants and the cross-grid bucketing path goes untested.
//
// This describe block stages an explicit cross-grid scenario: a player Fighting
// ant standing on the enemy entrance tile descends (Chunk 3 descent-intent
// gate) and the `currentGridColonyId` byte flips to ENEMY_COLONY_ID. Inside
// the foreign grid it engages combat with a pre-placed enemy hostile (Chunk 4
// tile-key extension buckets them together correctly).
//
// MANDATORY divergence guard at midTick: at least one underground ant must
// have `currentGridColonyId !== colonyId`. If that guard ever fails, the
// scenario is no longer exercising cross-grid bucketing and the parity check
// is no longer proving REQ-C4c — fail loudly rather than silently pass.

/**
 * Stage a cross-grid combat scenario on top of `createScenario`. Returns the
 * world. The invader is placed on the enemy entrance tile (Surface) with
 * task=Fighting; a hostile is pinned inside the enemy grid's foreign
 * corridor; an open rectangle is carved from the enemy entrance column to
 * the hostile so the invader's greedy-Manhattan stepper can reach it.
 *
 * Same pattern as invasion-routing.test.ts's distance-decrease scenario — we
 * reuse it here specifically to exercise Chunk-4 cross-grid combat bucketing.
 */
function buildCrossGridCombatWorld(seed: number): WorldState {
  const world = createScenario(seed);

  // Spawn 1 player Fighter on the enemy entrance tile (Surface).
  const playerAntId = allocateEntityId(world);
  initAnt(world.ants, playerAntId, {
    colonyId: PLAYER_COLONY_ID,
    posX:     (ENEMY_START_X << FP_SHIFT) + (FP_ONE >> 1),
    posY:     (ENEMY_START_Y << FP_SHIFT) + (FP_ONE >> 1),
    task:     AntTask.Fighting,
    subTask:  0,
    speed:    WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Surface,
  });
  world.colonies[PLAYER_COLONY_ID]!.workers.push(playerAntId);
  world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;

  // Pin an enemy hostile a few tiles east + below the entrance shaft.
  const hostileTileX = ENEMY_START_X + 3;
  const hostileTileY = 5;
  const hostileId = allocateEntityId(world);
  initAnt(world.ants, hostileId, {
    colonyId: ENEMY_COLONY_ID,
    posX:     (hostileTileX << FP_SHIFT) + (FP_ONE >> 1),
    posY:     (hostileTileY << FP_SHIFT) + (FP_ONE >> 1),
    task:     AntTask.Idle,
    subTask:  0,
    speed:    0, // pinned — keeps the test scenario stable and combat-reachable
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Underground,
  });
  world.ants.currentGridColonyId[hostileId] = ENEMY_COLONY_ID;
  world.colonies[ENEMY_COLONY_ID]!.workers.push(hostileId);
  world.colonies[ENEMY_COLONY_ID]!.workerCount += 1;

  // Carve an open rectangle in the enemy grid from shaft column to hostile.
  // createScenario pre-excavates the shaft (y=0..1); we widen it so
  // greedy-Manhattan stepping doesn't pin at an elbow (same rationale as
  // invasion-routing's distance-decrease test).
  const enemyGrid = world.undergroundGrids[ENEMY_COLONY_ID]!;
  for (let y = 0; y <= hostileTileY; y++) {
    for (let x = ENEMY_START_X; x <= hostileTileX; x++) {
      ugSet(enemyGrid, x, y, UndergroundTileState.Open);
    }
  }

  return world;
}

describe('Phase 09.1 Chunk 4 — cross-grid combat parity (REQ-C4c)', () => {
  // Seed and tick budget chosen so descent + combat + cleanup all occur
  // inside the parity window AND the divergence guard at midTick finds an
  // ant with currentGridColonyId != colonyId.
  //
  // Seed 31337 chosen empirically: produces a descent around t≈3-5 ticks
  // (one pass through tickAntMovement's descent block with scenario's
  // default PRNG rolls — not rng-dependent for the descent itself since
  // the gate is deterministic on task+entrance state), keeps the invader
  // alive long enough to reach the midTick check, and matches the cadence
  // used by the neighbouring parity cases above.
  const SEED = 31337;
  const N = 500;
  // MID_TICK chosen to be AFTER descent (zone flip is t=1 in this scenario)
  // but BEFORE the invader is killed in combat (combat resolves around t=11 per
  // debug trace). At t=10 the invader is alive, Underground, in the enemy grid
  // — divergence guard has a live subject to find.
  const MID_TICK = 10;

  it('cross-grid parity: same seed produces identical serialization with divergence guard active', () => {
    const worldA = buildCrossGridCombatWorld(SEED);
    const worldB = buildCrossGridCombatWorld(SEED);

    // Run to midTick, capture divergence guard state from worldA.
    for (let i = 0; i < MID_TICK; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }

    // MANDATORY divergence guard: at least one underground ant has
    // currentGridColonyId != colonyId. If this fails, the scenario isn't
    // actually exercising cross-grid bucketing — parity alone could then
    // pass trivially without ever touching the Chunk-4 extension.
    let anyDiverged = false;
    let playerFighterInEnemyGrid = false;
    for (let id = 0; id < worldA.ants.alive.length; id++) {
      if (worldA.ants.alive[id] !== 1) continue;
      if (worldA.ants.zone[id] !== Zone.Underground) continue;
      const owner = worldA.ants.colonyId[id];
      const grid  = worldA.ants.currentGridColonyId[id];
      if (owner !== grid) {
        anyDiverged = true;
        if (owner === PLAYER_COLONY_ID && grid === ENEMY_COLONY_ID) {
          playerFighterInEnemyGrid = true;
        }
      }
    }
    expect(anyDiverged).toBe(true);
    expect(playerFighterInEnemyGrid).toBe(true);

    // Parity check midrun — catches drift BEFORE the full run.
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));

    // Run the rest of the budget, then re-check parity at t=N.
    for (let i = MID_TICK; i < N; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 30_000);
});
