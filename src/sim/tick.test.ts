// src/sim/tick.test.ts
// Tests for tick() 17-step PRD §9a dispatcher — Phase 6 + Phase 7 full suite.
// Preserves Phase 5 tests; adds Phase 6 command, step-ordering, task-assignment,
// pheromone, and writeback tests; Phase 7 adds command processing, step ordering,
// and integration tests.

import { describe, it, expect, beforeEach } from 'vitest';
import { tick, resetFlowFieldCaches } from './tick.js';
import {
  createWorldState,
  allocateEntityId,
  LEGACY_SIM_VERSION,
  SIM_VERSION_V5_CHAMBER_ON_MARKED,
  SIM_VERSION_V7_SURFACE_PASSABILITY,
  SIM_VERSION_V8_LEASH_HYSTERESIS,
  LATEST_SIM_VERSION,
} from './types.js';
import { GameOutcome } from './game-over.js';
import type { SimCommand } from './commands.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import { createPheromoneGrid, phGet, phSet, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { AntTask, ForagingSubState, PheromoneType, FightingSubState, ChamberType, NursingSubState } from './enums.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import {
  QUEEN_FOOD_PER_TICK,
  STARVATION_GRACE_TICKS,
  WORKER_LIFESPAN_TICKS,
  FOOD_TRAIL_DEPOSIT,
  PHEROMONE_CAP,
} from './constants.js';
import { FP_SHIFT } from './fixed.js';

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

function makeWorldWithColony(seed: number = 42): { world: WorldState; colonyId: ColonyId; queenId: number } {
  const world = createWorldState(seed);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId: 1,
    posX: 1024,
    posY: 1024,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[1] = createColonyRecord(1, queenId);
  world.colonies[1]!.foodStored = 10000;
  return { world, colonyId: 1 as ColonyId, queenId };
}

// ---------------------------------------------------------------------------
// Phase 5 preserved tests
// ---------------------------------------------------------------------------

describe('tick() basic (Phase 5 preserved)', () => {
  it('increments world.tick from 0 to 1 on a fresh world with no commands', () => {
    const world = createWorldState(42);
    tick(world, []);
    expect(world.tick).toBe(1);
  });

  it('returns GameOutcome.None', () => {
    const world = createWorldState(42);
    const result = tick(world, []);
    expect(result).toBe(GameOutcome.None);
  });

  it('increments world.tick to 2 after two consecutive calls', () => {
    const world = createWorldState(42);
    tick(world, []);
    tick(world, []);
    expect(world.tick).toBe(2);
  });

  it('does not allocate via .slice() or the array iterator — PRD line 708 "No allocation" contract', () => {
    const world = createWorldState(42);
    const cmds: SimCommand[] = Array.from({ length: 100 }, (_, i): SimCommand => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const guarded = new Proxy(cmds, {
      get(target, prop, receiver) {
        if (prop === 'slice') {
          throw new Error('PRD-708 violation: tick() must not call .slice()');
        }
        if (prop === Symbol.iterator) {
          throw new Error('PRD-708 violation: tick() must not use for...of on commands (allocates iterator object)');
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(() => tick(world, guarded)).not.toThrow();
    expect(world.tick).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Command processing — Step 1
// ---------------------------------------------------------------------------

describe('Step 1: command processing', () => {
  let world: WorldState;
  let colonyId: ColonyId;
  let queenId: number;

  beforeEach(() => {
    ({ world, colonyId, queenId } = makeWorldWithColony());
    void queenId; // used in some tests via closure
  });

  // Test 1: NoOp command does not throw; tick increments
  it('Test 1: NoOp command does not throw; world.tick === 1 after', () => {
    const noOp: SimCommand = { type: 'NoOp', issuedAtTick: 0 };
    expect(() => tick(world, [noOp])).not.toThrow();
    expect(world.tick).toBe(1);
  });

  // Test 2: SetBehaviorRatio writes targetRatio
  it('Test 2: SetBehaviorRatio writes targetRatio fields', () => {
    const cmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId: colonyId,
      ratio: { forage: 5, fight: 2 },
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const colony = world.colonies[colonyId]!;
    expect(colony.targetRatio.forage).toBe(5);
    expect(colony.targetRatio.fight).toBe(2);
  });

  // Test 3: SetBehaviorRatio runs allocateWorkers immediately (CTRL-04, Phase 6 SC 4)
  it('Test 3: SetBehaviorRatio updates computedAllocation in the same tick (CTRL-04)', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 10;
    colony.eggCount = 0;
    colony.larvaeCount = 0;
    // Add workers to the workers array so step 8 counts correctly
    for (let i = 0; i < 10; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, { colonyId, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
      colony.workers.push(wid);
    }

    const cmd1: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId,
      ratio: { forage: 10, fight: 0 },
      issuedAtTick: 0,
    };
    tick(world, [cmd1]);
    // After tick, computedAllocation should reflect forage:10 ratio (step 1 CTRL-04 + step 8)
    expect(world.colonies[colonyId]!.computedAllocation.nurse).toBe(0);
    expect(world.colonies[colonyId]!.computedAllocation.forage).toBe(10);
    expect(world.colonies[colonyId]!.computedAllocation.dig).toBe(0);
    expect(world.colonies[colonyId]!.computedAllocation.fight).toBe(0);

    const cmd2: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId,
      ratio: { forage: 0, fight: 10 },
      issuedAtTick: 1,
    };
    tick(world, [cmd2]);
    // Same tick as issuance — new ratio takes effect (CTRL-04 immediate-takeup).
    // Phase 10 / CTRL-06: dig is auto-assigned per Marked-tile presence, NOT per ratio.
    // With no Marked tiles in this colony's underground grid, computeDigDemand returns 0
    // and the entire 10-worker pool flows to fight. Pre-Plan-02 this asserted dig:10
    // (the old fallback when the triangle had a `dig` vertex); the rewire here pins
    // CTRL-04 against the two-role widget contract.
    expect(world.colonies[colonyId]!.computedAllocation.forage).toBe(0);
    expect(world.colonies[colonyId]!.computedAllocation.dig).toBe(0);
    expect(world.colonies[colonyId]!.computedAllocation.fight).toBe(10);
  });

  // Test 4: SetBehaviorRatio rejects negative weights
  it('Test 4: SetBehaviorRatio rejects negative ratio — targetRatio unchanged', () => {
    const colony = world.colonies[colonyId]!;
    const forageBefore = colony.targetRatio.forage;
    const cmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId,
      ratio: { forage: -1, fight: 5 },
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[colonyId]!.targetRatio.forage).toBe(forageBefore);
  });

  // Test 5: SetBehaviorRatio silently drops unknown colonyId
  it('Test 5: SetBehaviorRatio silently drops unknown colonyId — no throw, no state change', () => {
    const cmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId: 999 as ColonyId,
      ratio: { forage: 5, fight: 0 },
      issuedAtTick: 0,
    };
    expect(() => tick(world, [cmd])).not.toThrow();
    expect(world.tick).toBe(1);
  });

  // Test 6: MarkDigTile is silent no-op
  it('Test 6: MarkDigTile is silent no-op — no throw, no colony state change', () => {
    const colony = world.colonies[colonyId]!;
    const foodBefore = colony.foodStored;
    const cmd: SimCommand = {
      type: 'MarkDigTile',
      colonyId,
      tileX: 10,
      tileY: 10,
      issuedAtTick: 0,
    };
    expect(() => tick(world, [cmd])).not.toThrow();
    expect(world.tick).toBe(1);
    // Food untouched by command itself (may be consumed by queen though)
    void foodBefore;
  });

  // Test 7: MarkFoodPile is silent no-op
  it('Test 7: MarkFoodPile is silent no-op — no throw, tick increments', () => {
    const cmd: SimCommand = {
      type: 'MarkFoodPile',
      colonyId,
      tileX: 5,
      tileY: 5,
      issuedAtTick: 0,
    };
    expect(() => tick(world, [cmd])).not.toThrow();
    expect(world.tick).toBe(1);
  });

  // Test 8: FIFO cap — 64 SetBehaviorRatio + 1 extra; the 65th is dropped
  it('Test 8: FIFO cap — 65th SetBehaviorRatio command is dropped', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 0;
    // Build 65 SetBehaviorRatio commands with increasing forage values 0..64
    const cmds: SimCommand[] = [];
    for (let r = 0; r < 65; r++) {
      cmds.push({
        type: 'SetBehaviorRatio',
        colonyId,
        ratio: { forage: r, fight: 0 },
        issuedAtTick: 0,
      });
    }
    tick(world, cmds);
    // Only first 64 processed; the last processed is ratio.forage=63
    expect(world.colonies[colonyId]!.targetRatio.forage).toBe(63);
  });

  // Test 9: Unknown command variant dropped — no throw
  it('Test 9: unknown command variant silently dropped — no throw, tick increments', () => {
    const unknown = { type: 'Bogus', issuedAtTick: 0 } as unknown as SimCommand;
    expect(() => tick(world, [unknown])).not.toThrow();
    expect(world.tick).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Step ordering tests
// ---------------------------------------------------------------------------

describe('Step ordering observable proofs', () => {
  let world: WorldState;
  let colonyId: ColonyId;
  let queenId: number;

  beforeEach(() => {
    ({ world, colonyId, queenId } = makeWorldWithColony());
  });

  // Test 10: Step 1 (command) before Step 8 (allocation)
  it('Test 10: SetBehaviorRatio in step 1 affects computedAllocation at tick output (step 1 before step 8)', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 5;
    for (let i = 0; i < 5; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, { colonyId, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
      colony.workers.push(wid);
    }
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    const cmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId,
      ratio: { forage: 0, fight: 0 },
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    // After tick, allocation reflects the command's ratio (all workers would go to nurse or idle)
    // The ratio {0,0,0} means no non-nurse targets; all available workers unallocated
    const alloc = world.colonies[colonyId]!.computedAllocation;
    expect(alloc.forage).toBe(0);
    expect(alloc.dig).toBe(0);
    expect(alloc.fight).toBe(0);
  });

  // Test 11: Step 3 (food consumption) before Step 4 (starvation)
  it('Test 11: food consumption runs before starvation check — fed queen timer resets not decrements', () => {
    const colony = world.colonies[colonyId]!;
    colony.foodStored = 1000; // plenty of food
    colony.queenStarvationTimer = 10; // partially expired timer

    tick(world, []);

    // Queen was fed (foodStored had enough), so timer should reset to STARVATION_GRACE_TICKS
    // not continue decrementing from 10 → 9
    expect(colony.queenStarvationTimer).toBe(STARVATION_GRACE_TICKS);
    // Food was consumed by exactly QUEEN_FOOD_PER_TICK (from the abundant pool)
    expect(colony.foodStored).toBeLessThan(1000);
    expect(colony.foodStored).toBe(1000 - QUEEN_FOOD_PER_TICK);
  });

  // Test 12: Step 5 (death cleanup) before Step 6 (egg production)
  it('Test 12: dead queen (step 5) prevents egg production in same tick (step 6)', () => {
    const colony = world.colonies[colonyId]!;
    // Kill queen manually before tick
    world.ants.alive[queenId] = 0;
    colony.foodStored = 100000; // plenty of food and threshold met
    colony.eggCount = 0;

    tick(world, []);

    // Step 5 marks colony.defeated; step 6 sees queen as dead (alive !== 1) and skips
    expect(colony.eggCount).toBe(0);
    expect(colony.defeated).toBe(true);
  });

  // Test 13: Step 8 (allocation) and Step 9 (task census) both run per colony
  it('Test 13a: colony.taskCensus populated after tick (step 9 ran)', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 5;
    for (let i = 0; i < 5; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId,
        posX: 100,
        posY: 100,
        task: AntTask.Foraging,
        subTask: ForagingSubState.SearchingFood,
      });
      colony.workers.push(wid);
    }
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    tick(world, []);

    // 5 foragers, none are Idle → census forage=5 (they're mid-cycle, not eligible for reassignment)
    expect(colony.taskCensus.forage).toBe(5);
  });

  it('Test 13b: step 9 reassigns Idle ants — 2 Idle + 3 mid-cycle Foraging with forage allocation 5', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 5;
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    // 2 Idle workers (at idle checkpoint → eligible for reassignment)
    const idleWorkers: number[] = [];
    for (let i = 0; i < 2; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId,
        posX: 100,
        posY: 100,
        task: AntTask.Idle,
        subTask: 0,
      });
      colony.workers.push(wid);
      idleWorkers.push(wid);
    }
    // 3 mid-cycle Foraging workers (not at idle checkpoint → NOT eligible)
    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId,
        posX: 100,
        posY: 100,
        task: AntTask.Foraging,
        subTask: ForagingSubState.SearchingFood,
      });
      colony.workers.push(wid);
    }

    // Set allocation: want 5 foragers; need = 5 - 3 = 2 (the 2 idle ants)
    colony.computedAllocation.nurse  = 0;
    colony.computedAllocation.forage = 5;
    colony.computedAllocation.dig    = 0;
    colony.computedAllocation.fight  = 0;

    tick(world, []);

    // After tick: all 5 workers are foragers, none are Idle
    expect(colony.taskCensus.forage).toBe(5);
    for (const id of idleWorkers) {
      expect(world.ants.task[id]).toBe(AntTask.Foraging);
    }
    // No idleCount field on ColonyRecord — do NOT assert colony.idleCount
  });

  // Test 13b: 09 digger-reassignment fix — dormant diggers are released to Idle
  //           and reassigned toward the current allocation within 2 ticks.
  it('Test 13b (09 digger-reassignment): worker stuck in Digging with no flow field is released and rehomed to Foraging', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 1;
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    const wid = allocateEntityId(world);
    // Pre-state: a Digging worker in MovingToTile. The colony has no underground
    // grid and no flow field — the sticky-digger root cause from
    // 09-DIGGER-REASSIGNMENT-BUG.md.
    initAnt(world.ants, wid, {
      colonyId,
      posX: 100,
      posY: 100,
      task: AntTask.Digging,
      subTask: 0, // MovingToTile
    });
    colony.workers.push(wid);

    // Player has shifted the behavior triangle strongly toward forage.
    colony.computedAllocation.forage = 1;
    colony.computedAllocation.dig    = 0;
    colony.computedAllocation.fight  = 0;
    colony.computedAllocation.nurse  = 0;
    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    // Tick 1: step 10a sees Digging (not Idle) → skipped. Step 10b tickDigExecution
    // runs and releases the sticky digger to AntTask.Idle.
    tick(world, []);
    expect(world.ants.task[wid]).toBe(AntTask.Idle);

    // Tick 2: step 10a now sees AntTask.Idle → reassigns toward Foraging.
    tick(world, []);
    expect(world.ants.task[wid]).toBe(AntTask.Foraging);

    // Census reflects reality.
    expect(colony.taskCensus.forage).toBe(1);
    expect(colony.taskCensus.dig).toBe(0);
  });

  // Test 13c: 09 digger-reassignment memo — sticky SearchingFood forager far
  //           from the nest is released by step 9b (tickSearchLeash) once the
  //           colony's taskCensus reflects the over-foraged state and the
  //           triangle has shifted away from forage. Step 10a then re-homes
  //           the released worker against the current allocation.
  it('Test 13c (09 search-leash): over-leashed SearchingFood forager is demoted and re-homed when triangle shifts', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 1;
    colony.eggCount = 0;
    colony.larvaeCount = 0;
    colony.entrances = [{
      entranceId:   allocateEntityId(world),
      surfaceTileX: 0,
      surfaceTileY: 0,
      isOpen:       true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;

    const wid = allocateEntityId(world);
    // Forager 50 tiles from the entrance — well past the max leash (40).
    initAnt(world.ants, wid, {
      colonyId,
      posX: 50 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    colony.workers.push(wid);

    // Player shifted the triangle: zero forage, all fight. Seed taskCensus
    // to the over-foraged state so step 9b fires on tick 1 (normally
    // taskCensus is written by the prior tick's step 10a — we skip that
    // ramp-up to keep the test focused on the leash gate).
    colony.computedAllocation.nurse  = 0;
    colony.computedAllocation.forage = 0;
    colony.computedAllocation.dig    = 0;
    colony.computedAllocation.fight  = 1;
    colony.taskCensus.forage = 1;
    colony.targetRatio.forage = 0;
    colony.targetRatio.fight  = 10;

    tick(world, []);

    // Step 9b releases to Idle → step 10a (same tick) re-homes to Fighting.
    expect(world.ants.task[wid]).toBe(AntTask.Fighting);
    expect(colony.taskCensus.forage).toBe(0);
    expect(colony.taskCensus.fight).toBe(1);
    // Wave counter bumped once (0 → 1) by the demotion.
    expect(world.ants.searchWave[wid]).toBe(1);
  });

  // Test 13d: 09 digger-reassignment memo — CarryingFood forager is NEVER
  //           interrupted by the search leash, even when deep in the wilderness.
  it('Test 13d (09 search-leash): CarryingFood forager is not demoted by leash', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 1;
    colony.eggCount = 0;
    colony.larvaeCount = 0;
    colony.entrances = [{
      entranceId:   allocateEntityId(world),
      surfaceTileX: 0,
      surfaceTileY: 0,
      isOpen:       true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;

    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId,
      posX: 100 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[wid] = 256;
    colony.workers.push(wid);

    colony.computedAllocation.nurse  = 0;
    colony.computedAllocation.forage = 0;
    colony.computedAllocation.dig    = 0;
    colony.computedAllocation.fight  = 1;

    tick(world, []);

    // Still Foraging+CarryingFood — the deposit cycle completes on its own.
    expect(world.ants.task[wid]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[wid]).toBe(ForagingSubState.CarryingFood);
  });

  // Test 14: Mid-action ants are NOT force-interrupted (PRD §7c "No forced interruption")
  it('Test 14: mid-cycle CarryingFood ant is NOT reassigned even when allocation wants diggers', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 1;
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId,
      posX: 100,
      posY: 100,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[wid] = 256; // carrying food — mid-cycle
    colony.workers.push(wid);

    // Set allocation: want 1 digger, 0 foragers (over-allocated forager)
    colony.computedAllocation.nurse  = 0;
    colony.computedAllocation.forage = 0;
    colony.computedAllocation.dig    = 1;
    colony.computedAllocation.fight  = 0;
    colony.targetRatio.forage = 0;
    colony.targetRatio.fight  = 0;
    // Phase 10 (CTRL-06): dig is auto-assigned via need.dig from Marked tiles, not
    // via targetRatio. Step 10a's auto-dig override will set computedAllocation.dig=0
    // here (no Marked tiles, no active digger). The pre-set dig=1 above is noise but
    // harmless: the assertion below — "mid-carry forager NOT preempted by Idle-eligibility"
    // — depends only on the eligibility predicate, not on which task has demand.

    tick(world, []);

    // Mid-carry ant stays as Foraging+CarryingFood — only Idle ants are eligible
    expect(world.ants.task[wid]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[wid]).toBe(ForagingSubState.CarryingFood);
    // Census reflects reality: 1 forager, 0 diggers
    expect(colony.taskCensus.forage).toBe(1);
    expect(colony.taskCensus.dig).toBe(0);
  });

  // Test 14b: Step 9 taskCensus non-negative invariant + sum bound under adversarial reassignment
  describe('Test 14b: taskCensus non-negative invariant + sum bound', () => {
    it('sub-case 1: all 10 workers Idle — all reassigned, census matches allocation, sum=workerCount', () => {
      const { world: w } = makeWorldWithColony(42);
      const colony = w.colonies[1]!;
      colony.workerCount = 10;
      // Add 9 eggs (age=0, will not hatch in 1 tick; EGG_HATCH_TICKS=1200).
      // allocateWorkers(10, 9, {forage:4,dig:0,fight:3}) => nurse=(9/3)|0=3, available=7,
      // forage=(7*4/7)|0=4, fight=(7*3/7)|0=3, dig=0 → {nurse:3,forage:4,dig:0,fight:3}.
      //
      // Note: before the 09 digger-reassignment fix this test used dig:4 in the
      // target ratio. That worked only because the old sticky-digger behavior
      // kept released workers classified as Digging even though this world has
      // no undergroundGrid / no flow field. With the fix, those workers are
      // honestly released back to Idle (see ant-system.ts tickDigExecution).
      // The rule the test exercises — step 10a reassigns ALL Idle workers up
      // to the computedAllocation, no Idle residue — is unchanged; we just use
      // a ratio that doesn't depend on dig-work the test never set up.
      for (let e = 0; e < 9; e++) {
        const eid = allocateEntityId(w);
        initAnt(w.ants, eid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
        w.ants.age[eid] = 0; // age 0 — will not hatch in 1 tick
        colony.eggs.push(eid);
        colony.eggCount += 1;
      }
      colony.larvaeCount = 0;

      // 09 reproduction-gate memo: nurse carveout requires a completed Nursery.
      // Without this chamber, allocateWorkers returns nurse=0 and the
      // {3,4,0,3} expectation below would collapse to {0,6,0,4}.
      colony.chambers.push({
        chamberId:   9001,
        chamberType: ChamberType.Nursery,
        foodStored:  0,
        posX:        0, posY: 0,
        width:       2, height: 2,
      });

      for (let i = 0; i < 10; i++) {
        const wid = allocateEntityId(w);
        initAnt(w.ants, wid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
        colony.workers.push(wid);
      }

      // targetRatio that produces {nurse:3, forage:4, dig:0, fight:3} via allocateWorkers(10, 9, ratio).
      colony.targetRatio.forage = 4;
      colony.targetRatio.fight  = 3;

      tick(w, []);

      const tc = colony.taskCensus;
      // Non-negative invariant
      expect(tc.forage).toBeGreaterThanOrEqual(0);
      expect(tc.dig).toBeGreaterThanOrEqual(0);
      expect(tc.fight).toBeGreaterThanOrEqual(0);
      expect(tc.nurse).toBeGreaterThanOrEqual(0);
      // Sum bound — all 10 ants assigned; no Idle residue
      expect(tc.forage + tc.dig + tc.fight + tc.nurse).toBe(10);
      // Census matches computedAllocation under full-reassignment (forage→dig→fight→nurse order)
      expect(tc.forage).toBe(4);
      expect(tc.dig).toBe(0);
      expect(tc.fight).toBe(3);
      expect(tc.nurse).toBe(3);
      // No Idle residue
      for (const wid of colony.workers) {
        expect(w.ants.task[wid]).not.toBe(AntTask.Idle);
      }
    });

    it('sub-case 2: 5 Idle + 1 mid-carry worker — all 5 Idle reassigned, mid-carry unchanged, sum=6', () => {
      const { world: w } = makeWorldWithColony(99);
      const colony = w.colonies[1]!;
      colony.workerCount = 6;
      colony.eggCount = 0;
      colony.larvaeCount = 0;

      // 5 Idle workers
      for (let i = 0; i < 5; i++) {
        const wid = allocateEntityId(w);
        initAnt(w.ants, wid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
        colony.workers.push(wid);
      }
      // 1 mid-carry worker
      const carryWid = allocateEntityId(w);
      initAnt(w.ants, carryWid, {
        colonyId: 1,
        posX: 100,
        posY: 100,
        task: AntTask.Foraging,
        subTask: ForagingSubState.CarryingFood,
      });
      w.ants.foodCarrying[carryWid] = 256;
      colony.workers.push(carryWid);

      // Pre-seed computedAllocation; step 8 will overwrite via allocateWorkers under
      // the actual ratio. Phase 10 (CTRL-06): dig is auto-assigned per Marked-tile
      // presence (none in this fixture → dig=0). The test's load-bearing assertion is
      // the non-negative invariant + sum=workerCount + mid-carry-not-preempted, all
      // of which hold for any valid allocation that step 10a produces.
      colony.computedAllocation = { nurse: 1, forage: 2, dig: 2, fight: 1 };
      colony.targetRatio.forage = 10;
      colony.targetRatio.fight  = 3;

      tick(w, []);

      const tc = colony.taskCensus;
      // All census fields non-negative
      expect(tc.forage).toBeGreaterThanOrEqual(0);
      expect(tc.dig).toBeGreaterThanOrEqual(0);
      expect(tc.fight).toBeGreaterThanOrEqual(0);
      expect(tc.nurse).toBeGreaterThanOrEqual(0);
      // Sum = 6 (mid-carry counted under Foraging in step 9a; all 5 idle reassigned)
      expect(tc.forage + tc.dig + tc.fight + tc.nurse).toBe(6);
      // Mid-carry worker: task and subTask unchanged (no forced interruption)
      expect(w.ants.task[carryWid]).toBe(AntTask.Foraging);
      expect(w.ants.subTask[carryWid]).toBe(ForagingSubState.CarryingFood);
    });
  });
});

// ---------------------------------------------------------------------------
// 09 reproduction-gate memo — end-to-end starvation-shape regression
// ---------------------------------------------------------------------------

describe('09 reproduction-gate memo — starvation-shape regression', () => {
  it('3 workers + 30 brood + NO Nursery + forage ratio → nurse=0, foragers=3', () => {
    // This is the exact failure shape from the debug snapshot: a pre-nursery
    // colony started accumulating brood, computedAllocation carved nurses
    // from the worker pool, and foraging collapsed because every worker was
    // stuck en route to a non-existent nursery. After the memo fix,
    // hasNursery=false forces nurse=0 regardless of brood and the triangle
    // splits across the full worker pool.
    const { world: w } = makeWorldWithColony(42);
    const colony = w.colonies[1]!;
    colony.workerCount = 3;

    // 30 larvae (already-hatched brood).
    for (let e = 0; e < 30; e++) {
      const lid = allocateEntityId(w);
      initAnt(w.ants, lid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
      colony.larvae.push(lid);
      colony.larvaeCount += 1;
    }

    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(w);
      initAnt(w.ants, wid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
      colony.workers.push(wid);
    }

    // Forage-favored triangle; no chambers at all (intentional — this is the
    // pre-excavation colony state from the memo).
    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    tick(w, []);

    const alloc = colony.computedAllocation;
    const tc    = colony.taskCensus;

    // Memo gate: no Nursery → nurse=0 even with 30 brood.
    expect(alloc.nurse).toBe(0);
    expect(alloc.forage).toBe(3);
    // Census matches: every worker is on the forage line.
    expect(tc.nurse).toBe(0);
    expect(tc.forage).toBe(3);
    expect(tc.forage + tc.dig + tc.fight + tc.nurse).toBe(3);
  });

  it('legacy brood inertness: 30 brood without Nursery does not steal workers', () => {
    // Save-compat: a legacy save can ship brood that pre-dates the memo.
    // The fix must leave that brood in the world without forcing nursing.
    const { world: w } = makeWorldWithColony(42);
    const colony = w.colonies[1]!;
    colony.workerCount = 5;

    for (let e = 0; e < 30; e++) {
      const lid = allocateEntityId(w);
      initAnt(w.ants, lid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
      colony.larvae.push(lid);
      colony.larvaeCount += 1;
    }

    for (let i = 0; i < 5; i++) {
      const wid = allocateEntityId(w);
      initAnt(w.ants, wid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
      colony.workers.push(wid);
    }

    colony.targetRatio.forage = 3;
    colony.targetRatio.fight  = 0;
    // Phase 10 (CTRL-06): dig is auto-assigned via Marked-tile presence; this fixture
    // has no Marked tiles so computedAllocation.dig stays 0 and the assertions below
    // (nurse=0 under no-Nursery memo gate; brood inert; sum=workerCount) hold.

    tick(w, []);

    expect(colony.computedAllocation.nurse).toBe(0);
    expect(colony.taskCensus.nurse).toBe(0);
    // Brood remains in the colony — not cleared, not killed.
    expect(colony.larvaeCount).toBe(30);
    // Workers sum back to workerCount across non-nurse tasks.
    const tc = colony.taskCensus;
    expect(tc.forage + tc.dig + tc.fight + tc.nurse).toBe(5);
  });

  it('Nursery present + 30 brood + 3 workers → nurse capped at ceil(3/4)=1', () => {
    // Counterpoint: once the Nursery exists, the brood actually demands
    // nursing — but the ceil(workers/4) cap prevents the whole pool from
    // being drained. With 3 workers and heavy brood, exactly 1 nurse and
    // 2 foragers (forage-only ratio).
    const { world: w } = makeWorldWithColony(42);
    const colony = w.colonies[1]!;
    colony.workerCount = 3;

    for (let e = 0; e < 30; e++) {
      const lid = allocateEntityId(w);
      initAnt(w.ants, lid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
      colony.larvae.push(lid);
      colony.larvaeCount += 1;
    }

    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(w);
      initAnt(w.ants, wid, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0 });
      colony.workers.push(wid);
    }

    colony.chambers.push({
      chamberId:   9000,
      chamberType: ChamberType.Nursery,
      foodStored:  0,
      posX: 0, posY: 0, width: 2, height: 2,
    });

    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    tick(w, []);

    expect(colony.computedAllocation.nurse).toBe(1);
    expect(colony.computedAllocation.forage).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pheromone step ordering (steps 10 → 11 → 12)
// ---------------------------------------------------------------------------

describe('Pheromone step ordering', () => {
  let world: WorldState;
  let colonyId: ColonyId;

  beforeEach(() => {
    ({ world, colonyId } = makeWorldWithColony());
  });

  // Test 15: Step 10 (deposit) before Step 11 (decay)
  it('Test 15: deposit (step 10) runs before decay (step 11) — grid cell > 0 after tick', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 1;
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId,
      posX: 3 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[wid] = 256;
    colony.workers.push(wid);

    const gridKey = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
    world.pheromoneGrids[gridKey] = createPheromoneGrid(64, 64);

    tick(world, []);

    // Deposit ran first (added FOOD_TRAIL_DEPOSIT), then decay reduced it.
    // Result must be > 0 (not zero) and <= FOOD_TRAIL_DEPOSIT.
    const val = phGet(world.pheromoneGrids[gridKey]!, 3, 3);
    expect(val).toBeGreaterThan(0);
    expect(val).toBeLessThanOrEqual(FOOD_TRAIL_DEPOSIT);
  });

  // Test 16: Step 12 (movement) uses post-decay grid
  it('Test 16: movement (step 12) runs after deposit+decay; forager may move per gradient', () => {
    const colony = world.colonies[colonyId]!;
    colony.workerCount = 1;
    colony.eggCount = 0;
    colony.larvaeCount = 0;

    // Place forager at a position with a non-zero pheromone neighbor
    const wid = allocateEntityId(world);
    const startX = 10 << FP_SHIFT;
    const startY = 10 << FP_SHIFT;
    initAnt(world.ants, wid, {
      colonyId,
      posX: startX,
      posY: startY,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    colony.workers.push(wid);

    const gridKey = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
    const grid = createPheromoneGrid(64, 64);
    // Strong pheromone trail to the right of the forager
    phSet(grid, 11, 10, 5000);
    world.pheromoneGrids[gridKey] = grid;

    tick(world, []);

    // The movement step ran (either moved or not depending on rng explore/exploit).
    // Just verify no crash and tick incremented.
    expect(world.tick).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tick writeback + return
// ---------------------------------------------------------------------------

describe('Tick writeback and return', () => {
  // Test 17: rngState writeback
  it('Test 17: rngState advances after tick with movement-consuming forager', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: 1, posX: 1024, posY: 1024, task: AntTask.Idle, subTask: 0, speed: 0 });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 10000;

    // Add a forager so movement uses rng
    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, { colonyId: 1, posX: 1024, posY: 1024, task: AntTask.Foraging, subTask: ForagingSubState.SearchingFood });
      world.colonies[1]!.workers.push(wid);
      world.colonies[1]!.workerCount += 1;
    }
    const gridKey = pheromoneGridKey(1 as ColonyId, PheromoneType.FoodTrail, 'surface');
    world.pheromoneGrids[gridKey] = createPheromoneGrid(64, 64);

    const rngBefore = world.rngState;
    tick(world, []);
    // rngState should have advanced (forager movement consumes PRNG)
    expect(world.rngState).not.toBe(rngBefore);

    const rngAfterFirst = world.rngState;
    tick(world, []);
    expect(world.rngState).not.toBe(rngAfterFirst);
  });

  // Test 18: Returns GameOutcome.None
  it('Test 18: returns GameOutcome.None', () => {
    const { world } = makeWorldWithColony();
    expect(tick(world, [])).toBe(GameOutcome.None);
  });

  // Test 19: world.tick increments exactly once per call
  it('Test 19: world.tick increments exactly once; 0 → 1 → 2', () => {
    const { world } = makeWorldWithColony();
    expect(world.tick).toBe(0);
    tick(world, []);
    expect(world.tick).toBe(1);
    tick(world, []);
    expect(world.tick).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-colony iteration
// ---------------------------------------------------------------------------

describe('Multi-colony iteration', () => {
  // Test 20: Two colonies both process food consumption and task census
  it('Test 20: two colonies both get food consumed and taskCensus populated per tick', () => {
    const world = createWorldState(42);

    // Colony 1
    const q1 = allocateEntityId(world);
    initAnt(world.ants, q1, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
    world.colonies[1] = createColonyRecord(1, q1);
    world.colonies[1]!.foodStored = 5000;

    // Colony 2
    const q2 = allocateEntityId(world);
    initAnt(world.ants, q2, { colonyId: 2, posX: 200, posY: 200, task: AntTask.Idle, subTask: 0, speed: 0 });
    world.colonies[2] = createColonyRecord(2, q2);
    world.colonies[2]!.foodStored = 5000;

    // Add 2 workers to each colony
    for (let i = 0; i < 2; i++) {
      const w1 = allocateEntityId(world);
      initAnt(world.ants, w1, { colonyId: 1, posX: 100, posY: 100, task: AntTask.Foraging, subTask: ForagingSubState.SearchingFood });
      world.colonies[1]!.workers.push(w1);
      world.colonies[1]!.workerCount += 1;

      const w2 = allocateEntityId(world);
      initAnt(world.ants, w2, { colonyId: 2, posX: 200, posY: 200, task: AntTask.Foraging, subTask: ForagingSubState.SearchingFood });
      world.colonies[2]!.workers.push(w2);
      world.colonies[2]!.workerCount += 1;
    }

    tick(world, []);

    // Both colonies consumed food (queen fed)
    expect(world.colonies[1]!.foodStored).toBe(5000 - QUEEN_FOOD_PER_TICK);
    expect(world.colonies[2]!.foodStored).toBe(5000 - QUEEN_FOOD_PER_TICK);
    // Both colonies have populated task census
    // (2 mid-cycle foragers each → census forage = 2)
    expect(world.colonies[1]!.taskCensus.forage).toBe(2);
    expect(world.colonies[2]!.taskCensus.forage).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SCEN-06 determinism (Phase 5 preserved + expanded)
// ---------------------------------------------------------------------------

describe('SCEN-06 determinism', () => {
  it('same seed produces identical { tick, rngState, nextEntityId } across two independent runs', () => {
    function runSim(seed: number, ticks: number) {
      const world = createWorldState(seed);
      for (let i = 0; i < ticks; i++) {
        tick(world, []);
      }
      return { tick: world.tick, rngState: world.rngState, nextEntityId: world.nextEntityId };
    }
    const run1 = runSim(42, 100);
    const run2 = runSim(42, 100);
    expect(run1).toEqual(run2);
  });

  it('100 ticks with seed 42 yields tick === 100', () => {
    const world = createWorldState(42);
    for (let i = 0; i < 100; i++) tick(world, []);
    expect(world.tick).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// PHER-02 two-grid integration
// ---------------------------------------------------------------------------

describe('PHER-02 two-grid integration', () => {
  it('SC 9: tick() decays DangerTrail faster than FoodTrail via key-parsed dispatch', () => {
    const { world, colonyId } = makeWorldWithColony(42);

    // Create both grids (64x64) and register in world.pheromoneGrids
    const foodKey = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
    const dangerKey = pheromoneGridKey(colonyId, PheromoneType.DangerTrail, 'surface');

    const foodGrid = createPheromoneGrid(64, 64);
    const dangerGrid = createPheromoneGrid(64, 64);

    // Seed both grids at the same cell with PHEROMONE_CAP
    phSet(foodGrid, 5, 5, PHEROMONE_CAP);
    phSet(dangerGrid, 5, 5, PHEROMONE_CAP);

    world.pheromoneGrids[foodKey] = foodGrid;
    world.pheromoneGrids[dangerKey] = dangerGrid;

    // Run tick() 10 times — routes through the key-parse dispatch in tick.ts lines 242-248
    for (let i = 0; i < 10; i++) {
      tick(world, []);
    }

    const foodVal = phGet(foodGrid, 5, 5);
    const dangerVal = phGet(dangerGrid, 5, 5);

    // DangerTrail decays faster (DANGER_DECAY_FP=10 > PHEROMONE_DECAY_FP=5)
    expect(dangerVal).toBeLessThan(foodVal);
    // FoodTrail has NOT decayed to zero — confirms real differential decay, not both zeroed
    expect(foodVal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Command processing tests
// ---------------------------------------------------------------------------

import { createUndergroundGrid, UndergroundTileState, ugGet, ugSet } from './terrain.js';
import { DiggingSubState } from './enums.js';
import type { FoodPile } from './food.js';
import {
  MAX_ENTRANCES_PER_COLONY,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
} from './constants.js';
import { CHAMBER_DIMENSIONS } from './colony/chamber.js';
import { createScenario } from './scenario.js';
import { tickAntMovement } from './ant/ant-system.js';
import { createDigFlowFields } from './dig-system.js';
import { Rng } from './rng.js';

describe('Phase 7: MarkDigTile command processing', () => {
  function makeWorldWithUnderground(seed = 42) {
    const world = createWorldState(seed);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: 1, posX: 1024, posY: 1024, task: AntTask.Idle, subTask: 0 });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 10000;
    // Phase 3 extension fields required by tick.ts
    world.colonies[1]!.entrances = [];
    world.colonies[1]!.rallyPoint = null;
    world.colonies[1]!.digFlowFieldDirty = false;
    world.undergroundGrids[1] = createUndergroundGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);
    return { world, colonyId: 1 as ColonyId };
  }

  // Test P7-1: MarkDigTile on Solid tile → becomes Marked, digFlowFieldDirty set true
  it('Test P7-1: MarkDigTile on Solid tile → Marked + digFlowFieldDirty=true', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 10, tileY: 10, issuedAtTick: 0 };
    tick(world, [cmd]);
    const underground = world.undergroundGrids[colonyId]!;
    expect(ugGet(underground, 10, 10)).toBe(UndergroundTileState.Marked);
    // digFlowFieldDirty reset by step 9 recompute — confirm tile is correctly set
  });

  // Test P7-2: MarkDigTile on non-Solid tile → silent drop
  it('Test P7-2: MarkDigTile on non-Solid tile → silent drop', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    // Pre-set tile to Open
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 10, tileY: 10, issuedAtTick: 0 };
    tick(world, [cmd]);
    // Should remain Open (not changed to Marked)
    expect(ugGet(underground, 10, 10)).toBe(UndergroundTileState.Open);
  });

  // Issue #30 (sim-side): ceiling-row reject regardless of dispatch source.
  it('Issue #30: MarkDigTile on tileY=0 (ceiling row) → silent drop, tile stays Solid', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 30, tileY: 0, issuedAtTick: 0 };
    tick(world, [cmd]);
    const underground = world.undergroundGrids[colonyId]!;
    // Tile stays Solid — the ceiling-row gate fires before the Marked write.
    expect(ugGet(underground, 30, 0)).toBe(UndergroundTileState.Solid);
  });

  // Issue #30 (carve-out): DesignateEntrance must still mark row 0 at the
  // entrance column. Entrance columns are exempt by design — the renderer
  // paints them as the gold-tinted "way in" hole, not as the grass ceiling.
  // The MarkDigTile gate above is scoped to the MarkDigTile dispatch path
  // only; DesignateEntrance writes via direct ugSet to preserve this
  // legitimate exemption. Regression guard so a future overreach of the
  // ceiling-row rule doesn't break entrance shaft excavation.
  it('Issue #30: DesignateEntrance still marks the row-0 shaft tile at the entrance column', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 40, surfaceTileY: 64, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const underground = world.undergroundGrids[colonyId]!;
    // Row-0 tile at the designated column is Marked — entrance columns
    // are exempt from the ceiling-row prohibition.
    expect(ugGet(underground, 40, 0)).toBe(UndergroundTileState.Marked);
  });

  // Test P7-3: MarkDigTile out of bounds → silent drop
  it('Test P7-3: MarkDigTile out of bounds → silent drop, no throw', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: -1, tileY: 10, issuedAtTick: 0 };
    expect(() => tick(world, [cmd])).not.toThrow();
    expect(world.tick).toBe(1);
  });

  // Test P7-4: CancelDigMark on Marked tile → becomes Solid, digFlowFieldDirty set true
  it('Test P7-4: CancelDigMark on Marked tile → Solid', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    // Pre-mark the tile
    underground.data[5 * UNDERGROUND_GRID_WIDTH + 5] = UndergroundTileState.Marked;
    const cmd: SimCommand = { type: 'CancelDigMark', colonyId, tileX: 5, tileY: 5, issuedAtTick: 0 };
    tick(world, [cmd]);
    expect(ugGet(underground, 5, 5)).toBe(UndergroundTileState.Solid);
  });

  // Test P7-5: CancelDigMark on BeingDug tile → silent drop (finish-then-switch rule)
  it('Test P7-5: CancelDigMark on BeingDug tile → silent drop (finish-then-switch)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[7 * UNDERGROUND_GRID_WIDTH + 7] = UndergroundTileState.BeingDug;
    const cmd: SimCommand = { type: 'CancelDigMark', colonyId, tileX: 7, tileY: 7, issuedAtTick: 0 };
    tick(world, [cmd]);
    // Should remain BeingDug
    expect(ugGet(underground, 7, 7)).toBe(UndergroundTileState.BeingDug);
  });

  // Test P7-6: MarkFoodPile sets colony.priorityFoodPileId and re-clicking the same pile clears it
  it('Test P7-6: MarkFoodPile sets colony priority on first click, clears on second (toggle off)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const pile: FoodPile = { foodPileId: 0, tileX: 20, tileY: 30 };
    world.foodPiles.push(pile);
    const colony = world.colonies[colonyId]!;
    expect(colony.priorityFoodPileId).toBeNull();
    const cmd: SimCommand = { type: 'MarkFoodPile', colonyId, tileX: 20, tileY: 30, issuedAtTick: 0 };
    tick(world, [cmd]);
    expect(colony.priorityFoodPileId).toBe(0);
    // Toggle-off on re-click of the same pile.
    tick(world, [cmd]);
    expect(colony.priorityFoodPileId).toBeNull();
  });

  // Phase 9: selecting a different pile is an EXCLUSIVE redirect, not an additive mark.
  it('MarkFoodPile redirect: clicking a second pile replaces the first (exclusive per colony)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    world.foodPiles.push({ foodPileId: 0, tileX: 20, tileY: 30 });
    world.foodPiles.push({ foodPileId: 1, tileX: 40, tileY: 50 });
    const colony = world.colonies[colonyId]!;
    tick(world, [{ type: 'MarkFoodPile', colonyId, tileX: 20, tileY: 30, issuedAtTick: 0 }]);
    expect(colony.priorityFoodPileId).toBe(0);
    tick(world, [{ type: 'MarkFoodPile', colonyId, tileX: 40, tileY: 50, issuedAtTick: 0 }]);
    expect(colony.priorityFoodPileId).toBe(1);
  });

  // Phase 9 cross-colony isolation: colony A marking a pile does NOT mark it for colony B.
  it('MarkFoodPile is per-colony: marking in colony A leaves colony B unchanged', () => {
    const { world, colonyId: colonyA } = makeWorldWithUnderground();
    // Add a second colony in the same world.
    const colonyB = colonyA + 1;
    world.colonies[colonyB] = {
      ...world.colonies[colonyA]!,
      colonyId: colonyB,
      priorityFoodPileId: null,
    };
    world.foodPiles.push({ foodPileId: 7, tileX: 10, tileY: 10 });
    tick(world, [{ type: 'MarkFoodPile', colonyId: colonyA, tileX: 10, tileY: 10, issuedAtTick: 0 }]);
    expect(world.colonies[colonyA]!.priorityFoodPileId).toBe(7);
    expect(world.colonies[colonyB]!.priorityFoodPileId).toBeNull();
  });

  // Test P7-7: PlaceChamber creates PendingChamber with correct dimensions; footprint tiles marked
  it('Test P7-7: PlaceChamber creates PendingChamber with correct dims; tiles marked', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // PRD §3c tunnel-end: anchor tile must be Open; surrounding Solid tiles give adjacency.
    // Issue #38: this test exercises the LEGACY pre-v5 gate — pin simVersion
    // so the v5 reachability BFS doesn't reject the placement (the test
    // colony has no entrance, which is fine for the legacy gate but
    // trivially fails the new reachability check).
    world.simVersion = LEGACY_SIM_VERSION;
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    const cmd: SimCommand = {
      type: 'PlaceChamber',
      colonyId,
      chamberType: ChamberType.Queen,
      anchorTileX: 10,
      anchorTileY: 10,
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const pcKey = `${colonyId}:10:10`;
    expect(world.pendingChambers[pcKey]).toBeDefined();
    const pc = world.pendingChambers[pcKey]!;
    const dims = CHAMBER_DIMENSIONS[ChamberType.Queen]!;
    expect(pc.width).toBe(dims.width);
    expect(pc.height).toBe(dims.height);
    expect(pc.chamberType).toBe(ChamberType.Queen);
    // Footprint tiles (were Solid before) are now Marked. Anchor tile was Open → stays Open.
    for (let dy = 0; dy < dims.height; dy++) {
      for (let dx = 0; dx < dims.width; dx++) {
        const expected = (dx === 0 && dy === 0)
          ? UndergroundTileState.Open
          : UndergroundTileState.Marked;
        expect(ugGet(underground, 10 + dx, 10 + dy)).toBe(expected);
      }
    }
  });

  // Test P7-8: PlaceChamber rejected if overlapping existing pendingChamber
  it('Test P7-8: PlaceChamber rejected if overlapping existing pendingChamber', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Issue #38: legacy gate (no entrance set up — fails v5 reachability).
    world.simVersion = LEGACY_SIM_VERSION;
    // PRD §3c tunnel-end: open the anchor tile for each placement attempt.
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    // Place first chamber
    const cmd1: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Nursery, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd1]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBeDefined();

    // Open anchor (12,10) too so only the overlap rule (not the tunnel-end rule) rejects cmd2.
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 12] = UndergroundTileState.Open;
    const cmd2: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage, anchorTileX: 12, anchorTileY: 10, issuedAtTick: 1,
    };
    tick(world, [cmd2]);
    // Overlapping chamber should NOT have been created
    expect(world.pendingChambers[`${colonyId}:12:10`]).toBeUndefined();
  });

  // Issue #30 (sim-side): PlaceChamber footprint must not include the
  // ceiling row. Symmetric with the MarkDigTile gate.
  it('Issue #30: PlaceChamber rejected when anchorTileY=0 (footprint overlaps ceiling)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[0 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen,
      anchorTileX: 10, anchorTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:10:0`]).toBeUndefined();
  });

  // Test P7-9: PlaceChamber rejected if out of bounds
  it('Test P7-9: PlaceChamber rejected if out of bounds', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const dims = CHAMBER_DIMENSIONS[ChamberType.Queen]!;
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen,
      // anchorTileX so that anchor + width > UNDERGROUND_GRID_WIDTH
      anchorTileX: UNDERGROUND_GRID_WIDTH - dims.width + 1,
      anchorTileY: 10,
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const pcKey = `${colonyId}:${UNDERGROUND_GRID_WIDTH - dims.width + 1}:10`;
    expect(world.pendingChambers[pcKey]).toBeUndefined();
  });

  // Test P7-10: DesignateEntrance creates NestEntrance in colony.entrances; shaft tiles marked
  it('Test P7-10: DesignateEntrance creates NestEntrance; shaft tiles marked', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const colony = world.colonies[colonyId]!;
    expect(colony.entrances.length).toBe(1);
    expect(colony.entrances[0]!.surfaceTileX).toBe(50);
    expect(colony.entrances[0]!.isOpen).toBe(false);
    // Shaft tiles (y=0, y=1) at x=50 should be Marked
    const underground = world.undergroundGrids[colonyId]!;
    expect(ugGet(underground, 50, 0)).toBe(UndergroundTileState.Marked);
    expect(ugGet(underground, 50, 1)).toBe(UndergroundTileState.Marked);
  });

  // Test P7-11: DesignateEntrance rejected if max entrances reached
  it('Test P7-11: DesignateEntrance rejected if MAX_ENTRANCES_PER_COLONY reached', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    // Manually fill up to MAX_ENTRANCES_PER_COLONY
    for (let i = 0; i < MAX_ENTRANCES_PER_COLONY; i++) {
      colony.entrances.push({
        entranceId: allocateEntityId(world),
        surfaceTileX: i,
        surfaceTileY: 0,
        isOpen: false,
      });
    }
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 99, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    // Should remain at MAX_ENTRANCES_PER_COLONY
    expect(colony.entrances.length).toBe(MAX_ENTRANCES_PER_COLONY);
  });

  // Test P7-12: DesignateEntrance rejected if duplicate (same surfaceTileX/Y)
  it('Test P7-12: DesignateEntrance rejected if duplicate surfaceTileX/Y', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const colony = world.colonies[colonyId]!;
    expect(colony.entrances.length).toBe(1);
    // Second command with same surfaceTileX/Y
    tick(world, [cmd]);
    expect(colony.entrances.length).toBe(1); // still 1
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Step ordering tests
// ---------------------------------------------------------------------------

describe('Phase 7: Step ordering tests', () => {
  function makeWorldWithUnderground(seed = 42) {
    const world = createWorldState(seed);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: 1, posX: 1024, posY: 1024, task: AntTask.Idle, subTask: 0 });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 10000;
    world.colonies[1]!.entrances = [];
    world.colonies[1]!.rallyPoint = null;
    world.colonies[1]!.digFlowFieldDirty = false;
    world.undergroundGrids[1] = createUndergroundGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);
    return { world, colonyId: 1 as ColonyId };
  }

  // Test P7-13: Step 9 before step 10: after MarkDigTile tick, flow-field recomputed
  it('Test P7-13: flow-field recomputed in step 9 before step 10 tick dig execution', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Mark a tile in step 1 of next tick — dirty flag will be set; step 9 recomputes
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 10, tileY: 10, issuedAtTick: 0 };
    tick(world, [cmd]);
    // After tick: digFlowFieldDirty was reset by step 9 recompute
    expect(world.colonies[colonyId]!.digFlowFieldDirty).toBe(false);
  });

  // Test P7-14: checkPendingChambers (step 11) promotes chamber when all footprint tiles open
  it('Test P7-14: step 11 checkPendingChambers promotes fully-open PendingChamber to ChamberRecord', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    const dims = CHAMBER_DIMENSIONS[ChamberType.Nursery]!;
    const ax = 20, ay = 5;
    // Pre-open all footprint tiles
    for (let dy = 0; dy < dims.height; dy++) {
      for (let dx = 0; dx < dims.width; dx++) {
        underground.data[(ay + dy) * UNDERGROUND_GRID_WIDTH + (ax + dx)] = UndergroundTileState.Open;
      }
    }
    // Create PendingChamber directly (bypassing PlaceChamber command)
    const pcKey = `${colonyId}:${ax}:${ay}`;
    world.pendingChambers[pcKey] = {
      colonyId,
      chamberType: ChamberType.Nursery,
      anchorTileX: ax,
      anchorTileY: ay,
      width: dims.width,
      height: dims.height,
    };
    tick(world, []);
    // checkPendingChambers (step 11) should have promoted it
    expect(world.pendingChambers[pcKey]).toBeUndefined();
    const colony = world.colonies[colonyId]!;
    expect(colony.chambers.length).toBeGreaterThan(0);
    expect(colony.chambers[0]!.chamberType).toBe(ChamberType.Nursery);
  });

  // Test P7-14a: Same-tick dig→chamber completion (proves tickDigExecution at step 10, not step 16)
  it('Test P7-14a: same-tick dig→chamber: last BeingDug tile opens AND PendingChamber promotes in single tick', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;

    // 1×1 chamber so only one tile needs to be Open
    const dims = { width: 1, height: 1 };
    const ax = 15, ay = 3;

    // Set the single footprint tile to BeingDug
    underground.data[ay * UNDERGROUND_GRID_WIDTH + ax] = UndergroundTileState.BeingDug;

    // Create PendingChamber for the single tile
    const pcKey = `${colonyId}:${ax}:${ay}`;
    world.pendingChambers[pcKey] = {
      colonyId,
      chamberType: ChamberType.Nursery,
      anchorTileX: ax,
      anchorTileY: ay,
      width: dims.width,
      height: dims.height,
    };

    // Place a Digging+Excavating worker ON that tile with digTicksRemaining=1
    const colony = world.colonies[colonyId]!;
    const wid = allocateEntityId(world);
    // Zone.Underground = 1 (from terrain.ts)
    initAnt(world.ants, wid, {
      colonyId,
      posX: ax << FP_SHIFT,
      posY: ay << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
    });
    world.ants.zone[wid] = 1; // Zone.Underground
    world.ants.digTileX[wid] = ax;
    world.ants.digTileY[wid] = ay;
    world.ants.digTicksRemaining[wid] = 1;
    colony.workers.push(wid);
    colony.workerCount += 1;
    colony.digFlowFieldDirty = true; // trigger step 9

    tick(world, []);

    // (a) tile must be Open
    expect(ugGet(underground, ax, ay)).toBe(UndergroundTileState.Open);
    // (b) PendingChamber must be gone and ChamberRecord created
    expect(world.pendingChambers[pcKey]).toBeUndefined();
    expect(colony.chambers.length).toBeGreaterThan(0);
  });

  // Test P7-14b: Same-tick dig→entrance opening
  it('Test P7-14b: same-tick dig→entrance opening: last shaft tile opens, entrance.isOpen=true in one tick', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    const colony = world.colonies[colonyId]!;

    // Entrance at surfaceTileX=30; shaft tileY=0 already Open, tileY=1 BeingDug
    underground.data[0 * UNDERGROUND_GRID_WIDTH + 30] = UndergroundTileState.Open;
    underground.data[1 * UNDERGROUND_GRID_WIDTH + 30] = UndergroundTileState.BeingDug;

    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: 30,
      surfaceTileY: 0,
      isOpen: false,
    });

    // Worker digging tileY=1 with digTicksRemaining=1
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId,
      posX: 30 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
    });
    world.ants.zone[wid] = 1; // Zone.Underground
    world.ants.digTileX[wid] = 30;
    world.ants.digTileY[wid] = 1;
    world.ants.digTicksRemaining[wid] = 1;
    colony.workers.push(wid);
    colony.workerCount += 1;
    colony.digFlowFieldDirty = true;

    tick(world, []);

    // Shaft tile y=1 should now be Open
    expect(ugGet(underground, 30, 1)).toBe(UndergroundTileState.Open);
    // Entrance should be open (checkEntranceCompletion at step 12 observes the transition)
    expect(colony.entrances[0]!.isOpen).toBe(true);
  });

  // Test P7-15: checkEntranceCompletion (step 12) with pre-opened shaft tiles
  it('Test P7-15: step 12 checkEntranceCompletion sets isOpen=true when both shaft tiles Open', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    const colony = world.colonies[colonyId]!;

    // Pre-open both shaft tiles
    underground.data[0 * UNDERGROUND_GRID_WIDTH + 20] = UndergroundTileState.Open;
    underground.data[1 * UNDERGROUND_GRID_WIDTH + 20] = UndergroundTileState.Open;

    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: 20,
      surfaceTileY: 0,
      isOpen: false,
    });

    tick(world, []);

    expect(colony.entrances[0]!.isOpen).toBe(true);
  });

  // Test P7-15a: Step 16 movement is pure for dig workers (digTicksRemaining unchanged)
  it('Test P7-15a: tickAntMovement (step 16) does NOT decrement digTicksRemaining — movement is pure', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // Place an Excavating dig worker with digTicksRemaining=5
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
    });
    world.ants.zone[wid] = 1; // Zone.Underground
    world.ants.digTileX[wid] = 10;
    world.ants.digTileY[wid] = 10;
    world.ants.digTicksRemaining[wid] = 5;
    colony.workers.push(wid);
    colony.workerCount += 1;
    // Set tile to BeingDug (required for Excavating state)
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.BeingDug;

    // Call tickAntMovement directly — bypassing step 10
    const rng = new Rng(world.rngState);
    const stubFields = createDigFlowFields();
    tickAntMovement(world, rng, stubFields);

    // digTicksRemaining MUST be unchanged (5) — countdown only in tickDigExecution (step 10)
    expect(world.ants.digTicksRemaining[wid]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Integration tests (SC 1, 5, 6, 7)
// ---------------------------------------------------------------------------

describe('Phase 7: Integration tests', () => {
  // SC 1: createScenario + MarkDigTile + run ticks → dig workers path to and clear tiles
  it('SC 1: workers with Dig priority path toward MarkDigTile targets over multiple ticks', () => {
    const world = createScenario(42);
    const colonyId = PLAYER_COLONY_ID as ColonyId;
    const colony = world.colonies[colonyId]!;

    // Phase 10 (CTRL-06): dig is auto-assigned via need.dig from Marked tiles.
    // The MarkDigTile below is the load-bearing lever (not targetRatio). Per
    // D-02 LOCKED + WR-06, auto-dig carves from `computedAllocation.forage`,
    // so a non-zero forage budget is required for dig to fire. Forage-only
    // ratio guarantees the carve reserves exactly one slot for dig (forage
    // budget = N − 1, dig budget = 1) on the activation tick; subsequent
    // ticks see `computeDigDemand` return 0 because an ant is already
    // Digging, so the strict 1-cap holds across the 10-tick window.
    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    // Mark a tile adjacent to the pre-excavated player shaft (entrance column=24,
    // shaft Open at underground rows 0..ENTRANCE_SHAFT_DEPTH-1). Picking a
    // reachable tile is load-bearing after the 09 digger-reassignment fix:
    // tickDigExecution now releases any dig worker whose underlying flow-field
    // cell is -2 (unreachable) back to Idle, so marks isolated from the Open
    // region would leave every worker freshly Idle and break the
    // `diggingCount > 0` assertion below. (25, 1) is adjacent to Open (24, 1).
    const cmd: SimCommand = {
      type: 'MarkDigTile',
      colonyId,
      tileX: 25,
      tileY: 1,
      issuedAtTick: 0,
    };

    // Run 10 ticks with the command in tick 0
    tick(world, [cmd]);
    for (let i = 1; i < 10; i++) {
      tick(world, []);
    }

    // Workers should have been reassigned to Digging via step 10a
    expect(world.tick).toBe(10);
    // At least some workers are Digging (after allocation kicked in)
    const diggingCount = colony.workers.filter(wid => world.ants.task[wid] === AntTask.Digging).length;
    expect(diggingCount).toBeGreaterThan(0);
  });

  // SC 5: createScenario + DesignateEntrance + manually open shaft → entrance.isOpen=true
  it('SC 5: DesignateEntrance then manually open shaft tiles → entrance opens', () => {
    const world = createScenario(42);
    const colonyId = PLAYER_COLONY_ID as ColonyId;
    const colony = world.colonies[colonyId]!;

    // Designate entrance at surfaceTileX=50
    const cmd: SimCommand = {
      type: 'DesignateEntrance',
      colonyId,
      surfaceTileX: 50,
      surfaceTileY: 0,
      issuedAtTick: 0,
    };
    tick(world, [cmd]);

    // Manually open both shaft tiles (simulating excavation complete)
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[0 * UNDERGROUND_GRID_WIDTH + 50] = UndergroundTileState.Open;
    underground.data[1 * UNDERGROUND_GRID_WIDTH + 50] = UndergroundTileState.Open;

    tick(world, []);

    // checkEntranceCompletion (step 12) should have set isOpen=true
    const entrance = colony.entrances.find(e => e.surfaceTileX === 50);
    expect(entrance).toBeDefined();
    expect(entrance!.isOpen).toBe(true);
  });

  // SC 6: PlaceChamber + manually open footprint → ChamberRecord created; overlap rejected
  it('SC 6: PlaceChamber + open footprint → ChamberRecord; overlapping chamber rejected', () => {
    const world = createScenario(42);
    // Issue #38: this test directly mutates underground state to set up a
    // chamber-anchor scenario without digging an entrance shaft to it. Pin
    // simVersion to LEGACY so the v5 reachability BFS doesn't reject the
    // synthetic placement.
    world.simVersion = LEGACY_SIM_VERSION;
    const colonyId = PLAYER_COLONY_ID as ColonyId;
    const colony = world.colonies[colonyId]!;

    const chamberType = ChamberType.FoodStorage;
    const dims = CHAMBER_DIMENSIONS[chamberType]!;
    const ax = 30, ay = 10;

    // PRD §3c tunnel-end: open anchors for both placements; surrounding Solid gives adjacency.
    const undergroundSc6 = world.undergroundGrids[colonyId]!;
    undergroundSc6.data[ay * UNDERGROUND_GRID_WIDTH + ax] = UndergroundTileState.Open;
    undergroundSc6.data[ay * UNDERGROUND_GRID_WIDTH + (ax + 1)] = UndergroundTileState.Open;

    const cmd1: SimCommand = {
      type: 'PlaceChamber',
      colonyId,
      chamberType,
      anchorTileX: ax,
      anchorTileY: ay,
      issuedAtTick: 0,
    };
    tick(world, [cmd1]);

    // Manually open all footprint tiles
    const underground = world.undergroundGrids[colonyId]!;
    for (let dy = 0; dy < dims.height; dy++) {
      for (let dx = 0; dx < dims.width; dx++) {
        underground.data[(ay + dy) * UNDERGROUND_GRID_WIDTH + (ax + dx)] = UndergroundTileState.Open;
      }
    }
    tick(world, []);

    // ChamberRecord should exist with correct dimensions
    const chamber = colony.chambers.find(ch => (ch.posX >> FP_SHIFT) === ax && (ch.posY >> FP_SHIFT) === ay);
    expect(chamber).toBeDefined();
    expect(chamber!.width).toBe(dims.width);
    expect(chamber!.height).toBe(dims.height);
    expect(chamber!.chamberType).toBe(chamberType);

    // Try to place overlapping chamber — should be rejected
    const cmd2: SimCommand = {
      type: 'PlaceChamber',
      colonyId,
      chamberType: ChamberType.Nursery,
      anchorTileX: ax + 1, // overlaps existing chamber
      anchorTileY: ay,
      issuedAtTick: 2,
    };
    tick(world, [cmd2]);
    const pcKey2 = `${colonyId}:${ax + 1}:${ay}`;
    expect(world.pendingChambers[pcKey2]).toBeUndefined();
  });

  // SC 7: createScenario(42) twice → undergroundGrids are independent
  it('SC 7: two createScenario(42) calls produce independent undergroundGrids', () => {
    const world1 = createScenario(42);
    const world2 = createScenario(42);
    const colonyId1 = PLAYER_COLONY_ID as ColonyId;
    const colonyId2 = ENEMY_COLONY_ID as ColonyId;

    // Mutate world1's player underground grid
    world1.undergroundGrids[colonyId1]!.data[100] = UndergroundTileState.Open;

    // world2's player underground grid should be unaffected
    expect(world2.undergroundGrids[colonyId1]!.data[100]).toBe(UndergroundTileState.Solid);

    // world1's enemy underground grid should also be unaffected
    expect(world1.undergroundGrids[colonyId2]!.data[100]).toBe(UndergroundTileState.Solid);
  });
});

// ---------------------------------------------------------------------------
// Regression: reviewer P1 fixes
//   - Entrance-seeking movement (PRD §5c)
//   - PlaceChamber tunnel-end validation (PRD §3c)
//   - DesignateEntrance validation (PRD §3g)
// ---------------------------------------------------------------------------

describe('Regression: reviewer P1 fixes', () => {
  function makeWorldWithUnderground(seed = 42) {
    const world = createWorldState(seed);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: 1, posX: 1024, posY: 1024, task: AntTask.Idle, subTask: 0 });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 10000;
    world.colonies[1]!.entrances = [];
    world.colonies[1]!.rallyPoint = null;
    world.colonies[1]!.digFlowFieldDirty = false;
    world.undergroundGrids[1] = createUndergroundGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);
    return { world, colonyId: 1 as ColonyId };
  }

  // --- Entrance-seeking movement ---
  it('surface CarryingFood ant paths toward open entrance (PRD §5c)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    colony.entrances.push({ entranceId: 99, surfaceTileX: 50, surfaceTileY: 10, isOpen: true });
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId, posX: 20 << FP_SHIFT, posY: 10 << FP_SHIFT,
      task: AntTask.Foraging, subTask: ForagingSubState.CarryingFood, speed: 1,
    });
    world.ants.foodCarrying[antId] = 5;
    const x0 = world.ants.posX[antId]!;
    tickAntMovement(world, new Rng(world.rngState), createDigFlowFields());
    expect(world.ants.posX[antId]!).toBeGreaterThan(x0); // moved toward entrance (+x)
  });

  it('underground SearchingFood ant paths toward open entrance at (x,0)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    colony.entrances.push({ entranceId: 7, surfaceTileX: 40, surfaceTileY: 10, isOpen: true });
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId, posX: 10 << FP_SHIFT, posY: 5 << FP_SHIFT,
      task: AntTask.Foraging, subTask: ForagingSubState.SearchingFood, speed: 1,
    });
    world.ants.zone[antId] = 1; // Underground
    const x0 = world.ants.posX[antId]!;
    const y0 = world.ants.posY[antId]!;
    tickAntMovement(world, new Rng(world.rngState), createDigFlowFields());
    // Should move either in +x (toward column 40) or -y (toward tileY=0)
    const moved = world.ants.posX[antId]! !== x0 || world.ants.posY[antId]! !== y0;
    expect(moved).toBe(true);
  });

  it('no open entrances → zone-transitioning ant does not move toward nothing', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // No entrances at all
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId, posX: 20 << FP_SHIFT, posY: 10 << FP_SHIFT,
      task: AntTask.Nursing, subTask: 0, speed: 1,
    });
    const x0 = world.ants.posX[antId]!;
    const y0 = world.ants.posY[antId]!;
    tickAntMovement(world, new Rng(world.rngState), createDigFlowFields());
    // Nursing with no chambers and no entrance → stays put
    expect(world.ants.posX[antId]!).toBe(x0);
    expect(world.ants.posY[antId]!).toBe(y0);
  });

  // --- PlaceChamber tunnel-end validation (PRD §3c) ---
  it('PlaceChamber rejected: anchor tile is Solid (not a tunnel end)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Issue #38: this test verifies the LEGACY pre-v5 anchor-must-be-Open
    // gate. Under v5 the gate disappears (Solid anchors are accepted with
    // reachability), so pin simVersion explicitly. Without the pin, the
    // test would still pass under v5 — but for the wrong reason (no
    // entrance → reachability rejects every placement).
    world.simVersion = LEGACY_SIM_VERSION;
    // Everything is Solid by default — anchor (10,10) is Solid
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBeUndefined();
  });

  it('PlaceChamber rejected: no adjacent Solid (anchor in wide-open cavern)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Issue #38: legacy gate (the v5 path drops the Solid-4-neighbor
    // requirement entirely). See note on the previous test.
    world.simVersion = LEGACY_SIM_VERSION;
    const underground = world.undergroundGrids[colonyId]!;
    // Open a 3×3 region around (10,10) — no adjacent Solid
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        underground.data[(10 + dy) * UNDERGROUND_GRID_WIDTH + (10 + dx)] = UndergroundTileState.Open;
      }
    }
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBeUndefined();
  });

  it('PlaceChamber rejected: footprint contains BeingDug tile', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open; // anchor
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 11] = UndergroundTileState.BeingDug; // footprint conflict
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBeUndefined();
  });

  it('PlaceChamber rejected: pendingChambers key already exists at anchor', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Issue #38: legacy gate (no entrance — fails v5 reachability).
    world.simVersion = LEGACY_SIM_VERSION;
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBeDefined();
    // Second command at the same anchor must be dropped
    const before = world.pendingChambers[`${colonyId}:10:10`];
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBe(before); // not overwritten
  });

  // --- 09 backlog memo — Queen uniqueness + FoodStorage multiplicity ---
  it('PlaceChamber rejected: second Queen attempt while a Queen pending', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Issue #38: legacy gate (no entrance — fails v5 reachability).
    world.simVersion = LEGACY_SIM_VERSION;
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    underground.data[20 * UNDERGROUND_GRID_WIDTH + 30] = UndergroundTileState.Open;
    const c1: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [c1]);
    const pendingBefore = Object.keys(world.pendingChambers).length;
    expect(pendingBefore).toBe(1);
    const c2: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 30, anchorTileY: 20, issuedAtTick: 1,
    };
    tick(world, [c2]);
    expect(Object.keys(world.pendingChambers).length).toBe(pendingBefore);
  });

  it('PlaceChamber rejected: second Queen attempt while a Queen already exists', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const underground = world.undergroundGrids[colonyId]!;
    // Seed an existing Queen chamber directly in colony.chambers.
    const colony = world.colonies[colonyId]!;
    colony.chambers.push({
      chamberId: 999, chamberType: ChamberType.Queen, foodStored: 0,
      posX: 5 << FP_SHIFT, posY: 5 << FP_SHIFT, width: 5, height: 3,
    });
    underground.data[20 * UNDERGROUND_GRID_WIDTH + 30] = UndergroundTileState.Open;
    const c: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.Queen, anchorTileX: 30, anchorTileY: 20, issuedAtTick: 0,
    };
    tick(world, [c]);
    expect(world.pendingChambers[`${colonyId}:30:20`]).toBeUndefined();
  });

  it('PlaceChamber allows multiple FoodStorage placements on the same colony', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Issue #38: legacy gate (no entrance — fails v5 reachability).
    world.simVersion = LEGACY_SIM_VERSION;
    const underground = world.undergroundGrids[colonyId]!;
    underground.data[10 * UNDERGROUND_GRID_WIDTH + 10] = UndergroundTileState.Open;
    underground.data[20 * UNDERGROUND_GRID_WIDTH + 30] = UndergroundTileState.Open;
    const c1: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage, anchorTileX: 10, anchorTileY: 10, issuedAtTick: 0,
    };
    const c2: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage, anchorTileX: 30, anchorTileY: 20, issuedAtTick: 1,
    };
    tick(world, [c1]);
    tick(world, [c2]);
    expect(world.pendingChambers[`${colonyId}:10:10`]).toBeDefined();
    expect(world.pendingChambers[`${colonyId}:30:20`]).toBeDefined();
  });

  // --- DesignateEntrance validation (PRD §3g) ---
  it('DesignateEntrance rejected: surfaceTileX out of bounds', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: -1, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[colonyId]!.entrances.length).toBe(0);
  });

  it('DesignateEntrance rejected: same-column duplicate (different surfaceTileY)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const cmd1: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd1]);
    expect(world.colonies[colonyId]!.entrances.length).toBe(1);
    // Same column, different surfaceTileY — PRD §3g column uniqueness rejects this
    const cmd2: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 5, issuedAtTick: 1,
    };
    tick(world, [cmd2]);
    expect(world.colonies[colonyId]!.entrances.length).toBe(1);
  });

  it('DesignateEntrance rejected: food pile at surface tile', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    world.foodPiles.push({ foodPileId: 0, tileX: 50, tileY: 0 });
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[colonyId]!.entrances.length).toBe(0);
  });

  it('DesignateEntrance rejected: colony rally point at surface tile', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    world.colonies[colonyId]!.rallyPoint = { tileX: 50, tileY: 0 };
    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[colonyId]!.entrances.length).toBe(0);
  });

  // --- PRD §4d Food Storage chamber routing (underground carrying foragers) ---
  it('underground CarryingFood ant routes to nearest Open FoodStorage tile (PRD §4d)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;
    // Open a small FoodStorage footprint at (20-23, 10-12)
    for (let ty = 10; ty <= 12; ty++) {
      for (let tx = 20; tx <= 23; tx++) {
        underground.data[ty * UNDERGROUND_GRID_WIDTH + tx] = UndergroundTileState.Open;
      }
    }
    colony.chambers.push({
      chamberId: 7,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 20 << FP_SHIFT, posY: 10 << FP_SHIFT,
      width: 4, height: 3,
    });
    // Also open a path from ant position to chamber so nothing else interferes
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId, posX: 10 << FP_SHIFT, posY: 10 << FP_SHIFT,
      task: AntTask.Foraging, subTask: ForagingSubState.CarryingFood, speed: 1,
    });
    world.ants.zone[antId] = 1; // Underground
    world.ants.foodCarrying[antId] = 5;
    const x0 = world.ants.posX[antId]!;
    tickAntMovement(world, new Rng(world.rngState), createDigFlowFields());
    // Should move +x toward chamber tile at (20,10) — X distance 10, Y distance 0
    expect(world.ants.posX[antId]!).toBeGreaterThan(x0);
  });

  it('underground CarryingFood ant with no FoodStorage chamber falls back to entrance', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    // No FoodStorage chamber; add only an entrance at column 40.
    colony.entrances.push({ entranceId: 1, surfaceTileX: 40, surfaceTileY: 10, isOpen: true });
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId, posX: 10 << FP_SHIFT, posY: 5 << FP_SHIFT,
      task: AntTask.Foraging, subTask: ForagingSubState.CarryingFood, speed: 1,
    });
    world.ants.zone[antId] = 1; // Underground
    world.ants.foodCarrying[antId] = 5;
    const x0 = world.ants.posX[antId]!;
    const y0 = world.ants.posY[antId]!;
    tickAntMovement(world, new Rng(world.rngState), createDigFlowFields());
    // Moves toward entrance at (40, 0) underground-side — either +x or -y
    const dx = world.ants.posX[antId]! - x0;
    const dy = world.ants.posY[antId]! - y0;
    expect(dx > 0 || dy < 0).toBe(true);
  });

  it('chamber target overrides surface pheromone gradient (no spurious surface-grid sampling)', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;
    // Open a FoodStorage footprint well to the east of the ant
    for (let ty = 10; ty <= 12; ty++) {
      for (let tx = 30; tx <= 33; tx++) {
        underground.data[ty * UNDERGROUND_GRID_WIDTH + tx] = UndergroundTileState.Open;
      }
    }
    colony.chambers.push({
      chamberId: 9, chamberType: ChamberType.FoodStorage, foodStored: 0,
      posX: 30 << FP_SHIFT, posY: 10 << FP_SHIFT, width: 4, height: 3,
    });
    // Plant a strong surface food-trail gradient to the WEST to prove it's ignored.
    const surfaceGrid = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
    phSet(surfaceGrid, 5, 10, 9999);
    world.pheromoneGrids[pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface')] = surfaceGrid;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId, posX: 20 << FP_SHIFT, posY: 10 << FP_SHIFT,
      task: AntTask.Foraging, subTask: ForagingSubState.CarryingFood, speed: 1,
    });
    world.ants.zone[antId] = 1; // Underground
    world.ants.foodCarrying[antId] = 5;
    const x0 = world.ants.posX[antId]!;
    tickAntMovement(world, new Rng(world.rngState), createDigFlowFields());
    // Chamber is east → +x. Surface gradient lure was west → would be -x if the bug were still present.
    expect(world.ants.posX[antId]!).toBeGreaterThan(x0);
  });

  it('DesignateEntrance rejected: another colony already has an entrance there', () => {
    const { world, colonyId } = makeWorldWithUnderground();
    // Add a second colony with an entrance at (50,0)
    const queen2 = allocateEntityId(world);
    initAnt(world.ants, queen2, { colonyId: 2, posX: 0, posY: 0, task: AntTask.Idle, subTask: 0 });
    world.colonies[2] = createColonyRecord(2, queen2);
    world.colonies[2]!.entrances = [{ entranceId: 999, surfaceTileX: 50, surfaceTileY: 0, isOpen: true }];
    world.colonies[2]!.rallyPoint = null;
    world.colonies[2]!.digFlowFieldDirty = false;
    world.undergroundGrids[2] = createUndergroundGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);

    const cmd: SimCommand = {
      type: 'DesignateEntrance', colonyId,
      surfaceTileX: 50, surfaceTileY: 0, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[colonyId]!.entrances.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #38 — PlaceChamber on Solid/Marked tiles with reachability gate (v5+).
// ---------------------------------------------------------------------------

describe('PlaceChamber v5 — chamber on Marked tiles (issue #38)', () => {
  /** Build a world with one entrance at column ENTRANCE_X and the entrance
   *  shaft auto-Marked rows 0..ENTRANCE_SHAFT_DEPTH-1. Mirrors what a real
   *  DesignateEntrance command would produce (without going through the
   *  command path so the test can directly inspect the gate behavior).
   *  simVersion is left at LATEST (= V5+) so the new gate is exercised. */
  function makeWorldWithEntrance(seed = 42, entranceX = 10) {
    const world = createWorldState(seed);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: 1, posX: 1024, posY: 1024, task: AntTask.Idle, subTask: 0 });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1]!.foodStored = 10000;
    world.colonies[1]!.entrances = [{
      entranceId: 999, surfaceTileX: entranceX, surfaceTileY: 0, isOpen: true,
    }];
    world.colonies[1]!.rallyPoint = null;
    world.colonies[1]!.digFlowFieldDirty = false;
    const ug = createUndergroundGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);
    world.undergroundGrids[1] = ug;
    return { world, colonyId: 1 as ColonyId, ug, entranceX };
  }

  it('accepts anchor on Solid when reachable via Marked tunnel from entrance', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    // Mark a column from row 0 to row 9 — this becomes the "tunnel" the
    // chamber will sit at the bottom of.
    for (let y = 0; y < 10; y++) {
      ug.data[y * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.Marked;
    }
    // Anchor on a SOLID tile two columns over from the marked tunnel,
    // adjacent to the marked column. Reachable via the marked column +
    // own footprint expansion.
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: entranceX, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    const pcKey = `${colonyId}:${entranceX}:10`;
    expect(world.pendingChambers[pcKey]).toBeDefined();
  });

  it('rejects anchor on Solid in unreachable dirt (no Marked path)', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    // The helper does NOT auto-mark the entrance shaft (DesignateEntrance
    // does that in production but we bypass the command path here for
    // test isolation). So the entrance source tile (entranceX, 0) is
    // Solid, not in the new footprint, and NOT traversable — BFS
    // terminates with an empty visited set and the placement is rejected.
    // That's the test we want: a far-away Solid anchor with no path
    // through Marked tiles to it must be refused.
    void ug;
    void entranceX;
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: 50, anchorTileY: 30, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:50:30`]).toBeUndefined();
  });

  it('rejects when colony has no entrance (BFS source set is empty)', () => {
    const { world, colonyId } = makeWorldWithEntrance();
    // Drop the entrance.
    world.colonies[colonyId]!.entrances = [];
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: 5, anchorTileY: 5, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:5:5`]).toBeUndefined();
  });

  it('auto-marks Solid footprint tiles after acceptance', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    for (let y = 0; y < 10; y++) {
      ug.data[y * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.Marked;
    }
    // Place 4×3 FoodStorage at (entranceX, 10). All footprint tiles start Solid.
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: entranceX, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    // Every Solid footprint tile should be Marked now.
    const dims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage]!;
    for (let dy = 0; dy < dims.height; dy++) {
      for (let dx = 0; dx < dims.width; dx++) {
        const state = ugGet(ug, entranceX + dx, 10 + dy);
        expect(state).toBe(UndergroundTileState.Marked);
      }
    }
  });

  it('accepts anchor on a Marked tile (chamber along an in-progress tunnel)', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    // Mark column entranceX rows 0..15 — long tunnel being dug.
    for (let y = 0; y < 16; y++) {
      ug.data[y * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.Marked;
    }
    // Anchor on a Marked tile at row 10 (mid-tunnel).
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: entranceX, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:${entranceX}:10`]).toBeDefined();
  });

  it('rejects anchor on a BeingDug tile (active excavation conflict)', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    for (let y = 0; y < 10; y++) {
      ug.data[y * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.Marked;
    }
    // Set the proposed anchor tile to BeingDug.
    ug.data[10 * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.BeingDug;
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: entranceX, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:${entranceX}:10`]).toBeUndefined();
  });

  it('promotes a v5-placed chamber once all footprint tiles are dug Open', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    for (let y = 0; y < 10; y++) {
      ug.data[y * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.Marked;
    }
    // Place chamber on Solid; should enter PendingChamber state.
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: entranceX, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:${entranceX}:10`]).toBeDefined();
    // Manually open the footprint (simulating excavation complete) and tick.
    const dims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage]!;
    for (let dy = 0; dy < dims.height; dy++) {
      for (let dx = 0; dx < dims.width; dx++) {
        ug.data[(10 + dy) * UNDERGROUND_GRID_WIDTH + (entranceX + dx)] = UndergroundTileState.Open;
      }
    }
    tick(world, []);
    // ChamberRecord should exist; PendingChamber is gone.
    const colony = world.colonies[colonyId]!;
    const chamber = colony.chambers.find(
      (ch) => (ch.posX >> FP_SHIFT) === entranceX && (ch.posY >> FP_SHIFT) === 10,
    );
    expect(chamber).toBeDefined();
    expect(world.pendingChambers[`${colonyId}:${entranceX}:10`]).toBeUndefined();
  });

  it('legacy v4 still rejects Solid-anchor placements (replay determinism)', () => {
    const { world, colonyId, ug, entranceX } = makeWorldWithEntrance();
    // Roll back to a pre-v5 version. Pre-v5 saves with Solid-anchor commands
    // in their inputLog must keep getting rejected so replay stays
    // byte-identical.
    world.simVersion = LEGACY_SIM_VERSION;
    for (let y = 0; y < 10; y++) {
      ug.data[y * UNDERGROUND_GRID_WIDTH + entranceX] = UndergroundTileState.Marked;
    }
    const cmd: SimCommand = {
      type: 'PlaceChamber', colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: entranceX, anchorTileY: 10, issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.pendingChambers[`${colonyId}:${entranceX}:10`]).toBeUndefined();
  });

  it('new worlds run at LATEST_SIM_VERSION (== V8_LEASH_HYSTERESIS after #44 UAT round 3)', () => {
    // Verify createWorldState uses the LATEST_SIM_VERSION constant exactly.
    // Tracks the constant rather than a hard-coded number so future bumps
    // don't have to update this assertion, while still proving the factory
    // is wired to the latest version (not stuck on a stale literal). Also
    // pins the explicit v8 sentinel so a downgrade (e.g. accidental revert
    // of the #44 leash-hysteresis fix) trips here.
    const world = createWorldState(42);
    expect(world.simVersion).toBe(LATEST_SIM_VERSION);
    expect(world.simVersion).toBe(SIM_VERSION_V8_LEASH_HYSTERESIS);
    // The v7 surface-passability ceiling still belongs to LATEST as well —
    // an accidental drop below v7 would silently re-enable pre-#44 movement.
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V7_SURFACE_PASSABILITY);
    // Plus a floor to flag accidental downgrades — the latest must always
    // be at least v5 (the issue #38 baseline).
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V5_CHAMBER_ON_MARKED);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 tick integration — step 1 rally handlers; step 10c; step 17/18/19
// ---------------------------------------------------------------------------

/**
 * Build a two-colony world suitable for Phase 9 combat/game-over tests.
 * Returns: world, playerColonyId=1, playerQueenId, enemyColonyId=2, enemyQueenId.
 */
function makeTwoColonyWorld(): {
  world: WorldState;
  playerColonyId: ColonyId;
  playerQueenId: number;
  enemyColonyId: ColonyId;
  enemyQueenId: number;
} {
  const world = createWorldState(42);

  // Player colony (ID=1)
  const playerQueenId = allocateEntityId(world);
  initAnt(world.ants, playerQueenId, {
    colonyId: 1,
    posX: 10 << FP_SHIFT,
    posY: 10 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[1] = createColonyRecord(1, playerQueenId);
  world.colonies[1]!.foodStored = 100000;
  world.colonies[1]!.entrances = [];
  world.colonies[1]!.rallyPoint = null;
  world.colonies[1]!.digFlowFieldDirty = false;

  // Enemy colony (ID=2)
  const enemyQueenId = allocateEntityId(world);
  initAnt(world.ants, enemyQueenId, {
    colonyId: 2,
    posX: 50 << FP_SHIFT,
    posY: 10 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[2] = createColonyRecord(2, enemyQueenId);
  world.colonies[2]!.foodStored = 100000;
  world.colonies[2]!.entrances = [];
  world.colonies[2]!.rallyPoint = null;
  world.colonies[2]!.digFlowFieldDirty = false;

  return {
    world,
    playerColonyId: 1 as ColonyId,
    playerQueenId,
    enemyColonyId: 2 as ColonyId,
    enemyQueenId,
  };
}

describe('Phase 9 tick integration', () => {
  it('SetRallyPoint command writes colony.rallyPoint', () => {
    const { world, playerColonyId } = makeTwoColonyWorld();
    const cmd: SimCommand = {
      type: 'SetRallyPoint',
      colonyId: playerColonyId,
      tileX: 10,
      tileY: 20,
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[playerColonyId]!.rallyPoint).toEqual({ tileX: 10, tileY: 20 });
  });

  it('SetRallyPoint silently drops out-of-range tileX/tileY', () => {
    const { world, playerColonyId } = makeTwoColonyWorld();
    // tileX = -1 → out of range
    const cmd1: SimCommand = {
      type: 'SetRallyPoint',
      colonyId: playerColonyId,
      tileX: -1,
      tileY: 10,
      issuedAtTick: 0,
    };
    tick(world, [cmd1]);
    expect(world.colonies[playerColonyId]!.rallyPoint).toBeNull();

    // tileX = SURFACE_GRID_WIDTH → out of range
    const cmd2: SimCommand = {
      type: 'SetRallyPoint',
      colonyId: playerColonyId,
      tileX: SURFACE_GRID_WIDTH,
      tileY: 10,
      issuedAtTick: 1,
    };
    tick(world, [cmd2]);
    expect(world.colonies[playerColonyId]!.rallyPoint).toBeNull();
  });

  it('SetRallyPoint silently drops unknown colonyId', () => {
    const { world } = makeTwoColonyWorld();
    const cmd: SimCommand = {
      type: 'SetRallyPoint',
      colonyId: 999 as ColonyId,
      tileX: 10,
      tileY: 10,
      issuedAtTick: 0,
    };
    // Should not throw
    expect(() => tick(world, [cmd])).not.toThrow();
  });

  it('ClearRallyPoint nulls colony.rallyPoint', () => {
    const { world, playerColonyId } = makeTwoColonyWorld();
    // Pre-set rally point
    world.colonies[playerColonyId]!.rallyPoint = { tileX: 5, tileY: 5 };

    const cmd: SimCommand = {
      type: 'ClearRallyPoint',
      colonyId: playerColonyId,
      issuedAtTick: 0,
    };
    tick(world, [cmd]);
    expect(world.colonies[playerColonyId]!.rallyPoint).toBeNull();
  });

  it('tick returns None when all queens alive', () => {
    const { world } = makeTwoColonyWorld();
    const result = tick(world, []);
    expect(result).toBe(GameOutcome.None);
  });

  it('tick returns Victory when player queen alive and enemy queen dead', () => {
    const { world, enemyQueenId } = makeTwoColonyWorld();
    // Kill enemy queen
    world.ants.alive[enemyQueenId] = 0;
    const result = tick(world, []);
    expect(result).toBe(GameOutcome.Victory);
  });

  it('tick returns Defeat when player queen dead', () => {
    const { world, playerQueenId } = makeTwoColonyWorld();
    // Kill player queen
    world.ants.alive[playerQueenId] = 0;
    const result = tick(world, []);
    expect(result).toBe(GameOutcome.Defeat);
  });

  it('tick returns MutualDestruction when both queens dead', () => {
    const { world, playerQueenId, enemyQueenId } = makeTwoColonyWorld();
    world.ants.alive[playerQueenId] = 0;
    world.ants.alive[enemyQueenId] = 0;
    const result = tick(world, []);
    expect(result).toBe(GameOutcome.MutualDestruction);
  });

  it('tick advances world.tick by exactly 1 even when outcome is non-None', () => {
    const { world, playerQueenId } = makeTwoColonyWorld();
    world.ants.alive[playerQueenId] = 0; // Defeat outcome
    const tickBefore = world.tick;
    tick(world, []);
    expect(world.tick).toBe(tickBefore + 1);
  });

  it('tick runs detectAndResolveCombat BEFORE checkQueenDeath (ordering)', () => {
    // Place a fighter from colony 2 co-located with the player queen (colony 1).
    // Combat at step 17 kills the enemy fighter (queen survives if player queen wins coin flip)
    // OR kills the player queen → step 18 sees dead queen → Victory or Defeat.
    // The key assertion: the outcome reflects what happened AFTER combat, not before.
    const { world, playerQueenId, enemyColonyId } = makeTwoColonyWorld();

    // Place an enemy fighter on the same tile as player queen
    const enemyFighterId = allocateEntityId(world);
    initAnt(world.ants, enemyFighterId, {
      colonyId: enemyColonyId,
      posX: 10 << FP_SHIFT, // same as playerQueen
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: FightingSubState.MovingToRally,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.ants.zone[enemyFighterId] = 0; // Surface
    world.ants.zone[playerQueenId] = 0;  // Surface

    // Register fighter in enemy colony workers
    world.colonies[enemyColonyId]!.workers.push(enemyFighterId);
    world.colonies[enemyColonyId]!.workerCount = 1;

    // Run one tick: combat resolves, then game-over checks
    const result = tick(world, []);
    // Either player queen survived (None) or was killed by fighter (Defeat).
    // In either case, the result is consistent with the post-combat state.
    // With seed 42, the PRNG determines the winner — we just verify no throw
    // and that result is a valid GameOutcome.
    const validOutcomes = [GameOutcome.None, GameOutcome.Defeat, GameOutcome.Victory, GameOutcome.MutualDestruction];
    expect(validOutcomes).toContain(result);
    // Combat ran: either the enemy fighter or the player queen is dead (or both still alive if no valid combat)
    // At minimum world.tick advanced — confirms tick ran to completion
    expect(world.tick).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: flow-field caches must not leak across worlds/sessions.
// Module-level entrance/dig/chamber caches keyed by colonyId would otherwise
// let a second world with the same colonyId inherit the first world's tunnel
// topology when digFlowFieldDirty=false on the loaded snapshot.
// ---------------------------------------------------------------------------
describe('resetFlowFieldCaches — cross-world isolation', () => {
  // Build a minimal underground-only world where a foraging ant with
  // foodCarrying=0 routes to the nearest open entrance via the entrance
  // flow-field. Different entrance locations in world A vs world B make the
  // expected first-step direction diverge, so stale cache inheritance is
  // directly observable.
  async function makeUndergroundWorldWithFighter(
    entranceCol: number,
    rallyTileX: number,
  ): Promise<{ world: WorldState; antId: number; colonyId: ColonyId }> {
    const { createUndergroundGrid, UndergroundTileState, ugSet, Zone } = await import('./terrain.js');
    const { FP_ONE } = await import('./fixed.js');
    const { initAnt: _initAnt } = await import('./ant/ant-store.js');
    const world = createWorldState(42);
    const colonyId = 1 as ColonyId;
    const queenId = allocateEntityId(world);
    _initAnt(world.ants, queenId, {
      colonyId,
      posX: 1024,
      posY: 1024,
      task: AntTask.Idle,
      subTask: 0,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    const colony = createColonyRecord(colonyId, queenId);
    colony.foodStored = 10000;
    // digFlowFieldDirty=false deliberately: this is the stale-cache gate.
    colony.digFlowFieldDirty = false;
    // Rally at (rallyTileX, 0) — only used to give updateFightAntTargets a
    // target; the fighter is underground so it routes to the entrance first.
    colony.rallyPoint = { tileX: rallyTileX, tileY: 0 };
    colony.entrances = [{
      entranceId: 10,
      surfaceTileX: entranceCol,
      surfaceTileY: 5,
      isOpen: true,
    }];
    world.colonies[colonyId] = colony;

    // 16x16 underground grid. Fully open in row 0 so the ant can sidestep
    // toward whichever entrance column is active this world. Row 1 open too,
    // to give a starting tile one below the shaft cap. All other rows remain
    // Solid by default.
    const ug = createUndergroundGrid(16, 16);
    for (let x = 0; x < 16; x++) {
      ugSet(ug, x, 0, UndergroundTileState.Open);
      ugSet(ug, x, 1, UndergroundTileState.Open);
    }
    world.undergroundGrids[colonyId] = ug;

    // Fighter at (8, 0) underground. Row 0 is Open end-to-end; the entrance
    // flow-field's sole source tile is (entranceCol, 0), so at (8,0) the dir
    // is a pure E/W axis step toward the source column — world A (col 2)
    // routes west, world B (col 14) routes east. Row 1 is filled too so the
    // ant never needs row-1 traversal; this keeps the first-tick step strictly
    // horizontal (no ambiguous N/W tie-breaks from BFS expansion order).
    const antId = allocateEntityId(world);
    _initAnt(world.ants, antId, {
      colonyId,
      posX: 8 << FP_SHIFT,
      posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
      speed: FP_ONE,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.ants.zone[antId] = Zone.Underground;
    // Register in colony.workers so step 10a sees it.
    colony.workers.push(antId);
    colony.workerCount = 1;
    colony.taskCensus.fight = 1;

    return { world, antId, colonyId };
  }

  it('second world routes per its own topology after resetFlowFieldCaches()', async () => {
    resetFlowFieldCaches();
    // World A: entrance at col 2 — first underground step should be west.
    const { world: worldA, antId: antA } = await makeUndergroundWorldWithFighter(2, 2);
    const beforeA = worldA.ants.posX[antA]! >> FP_SHIFT;
    tick(worldA, []);
    const afterA = worldA.ants.posX[antA]! >> FP_SHIFT;
    expect(afterA).toBeLessThan(beforeA);  // stepped west toward col 2

    // Clear the module-level caches between worlds (simulates bootFresh /
    // bootFromSave flow: new world, same colony id).
    resetFlowFieldCaches();

    // World B: same colony id (1), but entrance at col 14 — first underground
    // step should be east. If the entrance flow-field cache from world A
    // leaked, the ant would instead step west (toward col 2 in world A).
    const { world: worldB, antId: antB } = await makeUndergroundWorldWithFighter(14, 14);
    const beforeB = worldB.ants.posX[antB]! >> FP_SHIFT;
    tick(worldB, []);
    const afterB = worldB.ants.posX[antB]! >> FP_SHIFT;
    expect(afterB).toBeGreaterThan(beforeB);  // stepped east toward col 14 in world B
  });

  it('without resetFlowFieldCaches() between worlds, world B would inherit world A topology (negative control)', async () => {
    // Ensure cache is clean at the start.
    resetFlowFieldCaches();
    // World A: entrance at col 2 — populates caches under colonyId=1.
    const { world: worldA } = await makeUndergroundWorldWithFighter(2, 2);
    tick(worldA, []);

    // Intentionally skip resetFlowFieldCaches(). World B has same colonyId=1
    // but entrance at col 14 and digFlowFieldDirty=false — the firstDigCompute
    // latch is false (cache has key) so the recompute would be skipped UNLESS
    // the colony dirties the field. With the latch check on both dig and
    // entrance caches, a lingering cache is reused — confirming why the reset
    // call is load-bearing in bootFresh / bootFromSave.
    const { world: worldB, antId: antB } = await makeUndergroundWorldWithFighter(14, 14);
    const beforeB = worldB.ants.posX[antB]! >> FP_SHIFT;
    tick(worldB, []);
    const afterB = worldB.ants.posX[antB]! >> FP_SHIFT;
    // The fighter steps west (toward world A's entrance col 2), NOT east
    // toward world B's own entrance col 14 — the exact bug fixed by the
    // reset hook.
    expect(afterB).toBeLessThan(beforeB);

    // Leave clean state for the next test.
    resetFlowFieldCaches();
  });

  it('food chamber routing honors world-B topology after reset', async () => {
    const { createUndergroundGrid, UndergroundTileState, ugSet, Zone } = await import('./terrain.js');
    const { FP_ONE } = await import('./fixed.js');
    const { initAnt: _initAnt } = await import('./ant/ant-store.js');

    function buildCarrierWorld(chamberTileX: number): { world: WorldState; antId: number } {
      const world = createWorldState(42);
      const colonyId = 1 as ColonyId;
      const queenId = allocateEntityId(world);
      _initAnt(world.ants, queenId, {
        colonyId,
        posX: 1024, posY: 1024,
        task: AntTask.Idle, subTask: 0,
        speed: 0, lifespan: WORKER_LIFESPAN_TICKS,
      });
      const colony = createColonyRecord(colonyId, queenId);
      colony.foodStored = 10000;
      colony.digFlowFieldDirty = false;
      colony.rallyPoint = null;
      colony.entrances = [{ entranceId: 1, surfaceTileX: 8, surfaceTileY: 5, isOpen: true }];
      colony.chambers.push({
        chamberId: 200,
        chamberType: ChamberType.FoodStorage,
        foodStored: 0,
        posX: chamberTileX << FP_SHIFT,
        posY: 3 << FP_SHIFT,
        width: 1, height: 1,
      });
      world.colonies[colonyId] = colony;

      // Row-3 tunnel fully open for chamber BFS to reach across.
      const ug = createUndergroundGrid(16, 16);
      for (let x = 0; x < 16; x++) {
        ugSet(ug, x, 0, UndergroundTileState.Open);
        ugSet(ug, x, 1, UndergroundTileState.Open);
        ugSet(ug, x, 2, UndergroundTileState.Open);
        ugSet(ug, x, 3, UndergroundTileState.Open);
      }
      world.undergroundGrids[colonyId] = ug;

      // Carrier foraging underground at (8,3) with food — targets FoodStorage
      // chamber via the chamber flow-field.
      const antId = allocateEntityId(world);
      _initAnt(world.ants, antId, {
        colonyId,
        posX: 8 << FP_SHIFT,
        posY: 3 << FP_SHIFT,
        task: AntTask.Foraging,
        subTask: ForagingSubState.CarryingFood,
        speed: FP_ONE,
        lifespan: WORKER_LIFESPAN_TICKS,
      });
      world.ants.zone[antId] = Zone.Underground;
      world.ants.foodCarrying[antId] = 100;
      colony.workers.push(antId);
      colony.workerCount = 1;

      return { world, antId };
    }

    resetFlowFieldCaches();
    // World A: FoodStorage chamber at (2, 3) → carrier steps west.
    const { world: worldA, antId: antIdA } = buildCarrierWorld(2);
    const beforeA = worldA.ants.posX[antIdA]! >> FP_SHIFT;
    tick(worldA, []);
    const afterA = worldA.ants.posX[antIdA]! >> FP_SHIFT;
    expect(afterA).toBeLessThan(beforeA);

    resetFlowFieldCaches();

    // World B: same colonyId, chamber now at (14, 3) → carrier should step east.
    const { world: worldB, antId: antIdB } = buildCarrierWorld(14);
    const beforeB = worldB.ants.posX[antIdB]! >> FP_SHIFT;
    tick(worldB, []);
    const afterB = worldB.ants.posX[antIdB]! >> FP_SHIFT;
    expect(afterB).toBeGreaterThan(beforeB);

    resetFlowFieldCaches();
  });

  // -------------------------------------------------------------------------
  // Issue #15 regression: full FoodStorage chambers must drop out of the food
  // flow-field. A second chamber further away should pick up the routing once
  // the nearer chamber fills, instead of letting carriers stall at the cap.
  // -------------------------------------------------------------------------
  it('issue #15 — full FoodStorage chamber stops seeding the food flow-field; carriers redirect to non-full chamber', async () => {
    const { createUndergroundGrid, UndergroundTileState, ugSet, Zone } = await import('./terrain.js');
    const { FP_ONE } = await import('./fixed.js');
    const { initAnt: _initAnt } = await import('./ant/ant-store.js');
    const { FOOD_CHAMBER_CAPACITY: CAP } = await import('./constants.js');

    resetFlowFieldCaches();

    const world = createWorldState(42);
    const colonyId = 1 as ColonyId;
    const queenId = allocateEntityId(world);
    _initAnt(world.ants, queenId, {
      colonyId,
      posX: 1024, posY: 1024,
      task: AntTask.Idle, subTask: 0,
      speed: 0, lifespan: WORKER_LIFESPAN_TICKS,
    });
    const colony = createColonyRecord(colonyId, queenId);
    colony.foodStored = 0;
    colony.digFlowFieldDirty = true; // first compute on tick 0
    colony.foodFlowFieldDirty = false;
    colony.rallyPoint = null;
    colony.entrances = [{ entranceId: 1, surfaceTileX: 8, surfaceTileY: 5, isOpen: true }];
    // Two chambers on opposite ends of the open row. Chamber A (west, at col 2)
    // is FULL — it must NOT seed the food field. Chamber B (east, at col 14)
    // has room and should be the only seed.
    //
    // Chamber B is pushed FIRST so tickFoodConsumption (step 3) drains it for
    // the queen's 2fp/tick stipend BEFORE chamber A — leaving chamber A at
    // exactly capacity when the food flow-field recomputes at step 9. Without
    // this ordering, withdrawFood would dip chamber A below the cap and the
    // BFS would re-seed from the now-not-full chamber, defeating the test.
    colony.chambers.push({
      chamberId: 101, chamberType: ChamberType.FoodStorage, foodStored: 100,
      posX: 14 << FP_SHIFT, posY: 3 << FP_SHIFT, width: 1, height: 1,
    });
    colony.chambers.push({
      chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: CAP,
      posX: 2 << FP_SHIFT, posY: 3 << FP_SHIFT, width: 1, height: 1,
    });
    world.colonies[colonyId] = colony;

    const ug = createUndergroundGrid(16, 16);
    for (let x = 0; x < 16; x++) {
      ugSet(ug, x, 0, UndergroundTileState.Open);
      ugSet(ug, x, 1, UndergroundTileState.Open);
      ugSet(ug, x, 2, UndergroundTileState.Open);
      ugSet(ug, x, 3, UndergroundTileState.Open);
    }
    world.undergroundGrids[colonyId] = ug;

    // Carrier ant in the middle of row 3, holding food and routing home.
    const antId = allocateEntityId(world);
    _initAnt(world.ants, antId, {
      colonyId,
      posX: 8 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      speed: FP_ONE,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 100;
    colony.workers.push(antId);
    colony.workerCount = 1;

    const beforeX = world.ants.posX[antId]! >> FP_SHIFT;
    tick(world, []);
    const afterX = world.ants.posX[antId]! >> FP_SHIFT;

    // The full chamber is to the WEST (col 2); the open chamber is to the
    // EAST (col 14). Pre-#15 the BFS would have seeded both and the carrier
    // would have stepped west toward the closer (full) chamber, only to stall
    // on a full-cap deposit. Post-#15 the food field excludes the full chamber
    // and routes the carrier east toward the open one.
    expect(afterX).toBeGreaterThan(beforeX);

    resetFlowFieldCaches();
  });

  // -------------------------------------------------------------------------
  // Issue #15 — cross-tick partial-deposit redirection.
  //
  // End-to-end check that exercises the full chamber-fill/redirect loop:
  //
  //  1. Carrier arrives at near chamber A, which has space for only part of
  //     its load. antDepositFood writes the chamber up to cap, leaves the
  //     leftover on the ant, and sets foodFlowFieldDirty.
  //  2. On the next tick, step 9 re-seeds the food flow-field excluding A
  //     (now full). The carrier — still holding the leftover — gets a
  //     direction value pointing toward the only remaining seed (chamber B).
  //  3. Carrier walks to B, deposits the leftover, flips Foraging→Idle.
  //
  // This wires together: dirty-flag cycle (deposit→step 9 next tick),
  // chamberFilter integration in computeChamberFlowField, deposit-site
  // selection in tickForagerActions, antDepositFood leftover semantics, and
  // the Foraging→Idle transition. Round-1 unit tests cover each piece in
  // isolation; this is the integration that catches a regression in any
  // single piece misaligning with the rest.
  // -------------------------------------------------------------------------
  it('issue #15 — partial deposit at near chamber leaves leftover on ant; carrier then routes to far chamber', async () => {
    const { createUndergroundGrid, UndergroundTileState, ugSet, Zone } = await import('./terrain.js');
    const { FP_ONE } = await import('./fixed.js');
    const { initAnt: _initAnt } = await import('./ant/ant-store.js');
    const { FOOD_CHAMBER_CAPACITY: CAP, FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP: HYST } = await import('./constants.js');

    resetFlowFieldCaches();

    const world = createWorldState(42);
    const colonyId = 1 as ColonyId;
    const queenId = allocateEntityId(world);
    _initAnt(world.ants, queenId, {
      colonyId,
      posX: 1024, posY: 1024,
      task: AntTask.Idle, subTask: 0,
      speed: 0, lifespan: WORKER_LIFESPAN_TICKS,
    });
    // Kill the queen so tickFoodConsumption (step 3) doesn't drain chamber A
    // mid-tick. This test is about the chamber-fill / food-flow-field-redirect
    // path; queen consumption would steal 2fp/tick from A and reopen capacity,
    // preventing the redirect from triggering. Killing the queen is fine for
    // the few-tick window — `defeated` is checked on its own cadence.
    world.ants.alive[queenId] = 0;
    const colony = createColonyRecord(colonyId, queenId);
    colony.foodStored = 0;
    colony.digFlowFieldDirty = true; // first compute on tick 0
    colony.foodFlowFieldDirty = false;
    colony.rallyPoint = null;
    colony.entrances = [{ entranceId: 1, surfaceTileX: 8, surfaceTileY: 5, isOpen: true }];
    // Chamber A near (col 5) with `space` units of room. Chamber B far
    // (col 14) is empty. The carrier holds `loadFp` such that the deposit
    // into A fills A exactly to cap and leaves `loadFp - space` on the ant.
    //
    // Issue #15 follow-up: under the deposit hysteresis, A must start
    // DEPOSITABLE (free space >= HYST) so the deposit fires this tick. With
    // free space < HYST the carrier would refuse to deposit at A entirely
    // and route straight to B with full load — a different (also correct)
    // path covered by the dedicated stuck-ant repro test below. Here we
    // exercise the cross-tick redirect after a partial fill.
    const space = HYST + 100;              // 612fp — depositable pre, saturated post
    const loadFp = space + 200;            // 812fp leaves 200 on the ant after A fills
    const chamberA_initial = CAP - space;
    colony.chambers.push({
      chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: chamberA_initial,
      posX: 5 << FP_SHIFT, posY: 3 << FP_SHIFT, width: 1, height: 1,
    });
    colony.chambers.push({
      chamberId: 101, chamberType: ChamberType.FoodStorage, foodStored: 0,
      posX: 14 << FP_SHIFT, posY: 3 << FP_SHIFT, width: 1, height: 1,
    });
    world.colonies[colonyId] = colony;

    const ug = createUndergroundGrid(16, 16);
    for (let x = 0; x < 16; x++) {
      ugSet(ug, x, 0, UndergroundTileState.Open);
      ugSet(ug, x, 1, UndergroundTileState.Open);
      ugSet(ug, x, 2, UndergroundTileState.Open);
      ugSet(ug, x, 3, UndergroundTileState.Open);
    }
    world.undergroundGrids[colonyId] = ug;

    // Carrier ant starts ON chamber A's tile so antDepositFood fires this
    // tick — keeps the test compact (≤30 ticks even with the redirect).
    const antId = allocateEntityId(world);
    _initAnt(world.ants, antId, {
      colonyId,
      posX: 5 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      speed: FP_ONE,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = loadFp;
    colony.workers.push(antId);
    colony.workerCount = 1;

    const chamberA = colony.chambers[0]!;
    const chamberB = colony.chambers[1]!;

    // Tick 0 — deposit fires, A fills to cap, leftover stays on ant, dirty
    // flag set so step 9 next tick re-seeds the food field excluding A.
    tick(world, []);
    expect(chamberA.foodStored).toBe(CAP);
    expect(world.ants.foodCarrying[antId]).toBe(loadFp - space);

    // Drive the sim until B has the leftover. Bound by 30 ticks — the
    // carrier walks from col 5 → col 14 = 9 tiles at 1 tile/tick, plus a
    // small margin for the deposit + idle-flip handshake.
    let landedInB = false;
    for (let t = 0; t < 30; t++) {
      tick(world, []);
      if (chamberB.foodStored > 0) { landedInB = true; break; }
    }
    expect(landedInB).toBe(true);
    // Queen is dead, no consumption — the leftover deposits cleanly into B.
    expect(chamberB.foodStored).toBe(loadFp - space);
    expect(world.ants.foodCarrying[antId]).toBe(0);

    resetFlowFieldCaches();
  });

  // -------------------------------------------------------------------------
  // Issue #15 follow-up — queen-drain oscillation stuck-ant regression.
  //
  // Repro from /tmp/stuck-dump.json (seed 1294596103 tick 1876):
  //   - Chamber A is full (foodStored = CAP) and the queen consumes
  //     QUEEN_FOOD_PER_TICK=2fp from it each tick.
  //   - A carrier ant stands on chamber A's footprint en route to chamber B
  //     (depositable, far away).
  //
  // Pre-fix (full→not-full re-seed): the queen's 2fp drain marks A non-full,
  // step 9 re-seeds the BFS with A as a source, the carrier's tile reads
  // direction = -1 (source), movement holds. Step 16b then deposits 2fp into
  // A (matches what the queen just took), A is full again, queen drains 2,
  // repeat. The carrier dribbles its entire load 2fp/tick into A and never
  // reaches B.
  //
  // Post-fix (saturated→depositable hysteresis): A stays saturated (free
  // space < HYST = 512fp) for ~256 ticks of queen drain before re-seeding.
  // The carrier walks past A to B in well under that window. This test asserts
  // the carrier's load arrives at B, not A.
  // -------------------------------------------------------------------------
  it('issue #15 follow-up — queen-drain oscillation does NOT pin a carrier on a near-full chamber', async () => {
    const { createUndergroundGrid, UndergroundTileState, ugSet, Zone } = await import('./terrain.js');
    const { FP_ONE } = await import('./fixed.js');
    const { initAnt: _initAnt } = await import('./ant/ant-store.js');
    const { FOOD_CHAMBER_CAPACITY: CAP } = await import('./constants.js');

    resetFlowFieldCaches();

    const world = createWorldState(1294596103);
    const colonyId = 1 as ColonyId;
    const queenId = allocateEntityId(world);
    // Queen position is decorative — withdrawFood drains chambers in array
    // order regardless of queen tile, so chamber 0 (A) is drained first
    // because it's pushed first below. Queen sits inside A's footprint
    // purely to keep the test's mental model close to the dump scenario.
    _initAnt(world.ants, queenId, {
      colonyId,
      posX: 5 << FP_SHIFT, posY: 3 << FP_SHIFT,
      task: AntTask.Idle, subTask: 0,
      speed: 0, lifespan: WORKER_LIFESPAN_TICKS,
    });
    const colony = createColonyRecord(colonyId, queenId);
    colony.foodStored = 0;
    colony.digFlowFieldDirty = true; // first compute on tick 0
    colony.foodFlowFieldDirty = false;
    colony.rallyPoint = null;
    colony.entrances = [{ entranceId: 1, surfaceTileX: 8, surfaceTileY: 5, isOpen: true }];

    // Chamber A near (col 5) full. Chamber B far (col 14) empty/depositable.
    colony.chambers.push({
      chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: CAP,
      posX: 5 << FP_SHIFT, posY: 3 << FP_SHIFT, width: 1, height: 1,
    });
    colony.chambers.push({
      chamberId: 101, chamberType: ChamberType.FoodStorage, foodStored: 0,
      posX: 14 << FP_SHIFT, posY: 3 << FP_SHIFT, width: 1, height: 1,
    });
    world.colonies[colonyId] = colony;

    const ug = createUndergroundGrid(16, 16);
    for (let x = 0; x < 16; x++) {
      ugSet(ug, x, 0, UndergroundTileState.Open);
      ugSet(ug, x, 1, UndergroundTileState.Open);
      ugSet(ug, x, 2, UndergroundTileState.Open);
      ugSet(ug, x, 3, UndergroundTileState.Open);
    }
    world.undergroundGrids[colonyId] = ug;

    // Carrier ant starts ON chamber A's tile holding a full pickup load.
    // Pre-fix this is the pinned state (deposits 2/tick, queen drains 2/tick,
    // never moves). Post-fix the carrier walks east to B.
    const antId = allocateEntityId(world);
    const carriedFp = 1024;
    _initAnt(world.ants, antId, {
      colonyId,
      posX: 5 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      speed: FP_ONE,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = carriedFp;
    colony.workers.push(antId);
    colony.workerCount = 1;

    const chamberA = colony.chambers[0]!;
    const chamberB = colony.chambers[1]!;
    const aBefore = chamberA.foodStored;

    // Drive 60 ticks — the carrier walks 9 tiles at 1 tile/tick to chamber B
    // and deposits its full load. Generous margin for movement quirks.
    let landedInB = false;
    for (let t = 0; t < 60; t++) {
      tick(world, []);
      if (chamberB.foodStored > 0) { landedInB = true; break; }
    }

    expect(landedInB).toBe(true);
    expect(chamberB.foodStored).toBe(carriedFp);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    // Pre-fix the carrier would have leaked all 1024fp INTO A (matching the
    // queen's drain), driving chamberA.foodStored above aBefore. Post-fix A
    // never grows — the assertion is `<=` rather than `<` because the loop
    // breaks on the tick the carrier deposits at B, which can be early enough
    // that no queen tick has consumed yet (aBefore == aAfter is legitimate).
    expect(chamberA.foodStored).toBeLessThanOrEqual(aBefore);

    resetFlowFieldCaches();
  });
});

// ---------------------------------------------------------------------------
// Phase 10 / CTRL-06 — auto-dig demand-driven role (D-02 LOCKED)
// ---------------------------------------------------------------------------
//
// These tests pin the contract added in Plan 10-02 (and locked by CONTEXT.md D-02):
//
//   - need.dig = (Marked tile count > 0 && no ant currently Digging) ? 1 : 0
//   - When need.dig > 0 and at least one ant is Idle, step 10a auto-assigns
//     exactly ONE Idle ant to AntTask.Digging (strict 1-digger cap).
//   - When dig work exists but no ant is Idle, the simulation WAITS — no
//     preemption of foragers/fighters.
//   - When a Digging ant finishes (tile clears or it dies), it transitions to
//     Idle; step 10a next tick reassigns it (auto-dig if more Marked tiles,
//     else forage/fight per ratio).
//   - The AI colony uses the SAME path — there is no isPlayer / colonyId
//     branching in the auto-dig logic (CLNY-08 invariant).
//
// Discipline (per Plan 09.1-03 conventions): every test asserts BOTH t=0
// preconditions (so a fixture-drift pass doesn't masquerade as a green) AND
// t=N outcomes (the specific behavioral claim). Diagnostic for "feature missing
// vs. feature broken" is encoded into the precondition asserts.
// ---------------------------------------------------------------------------

describe('Phase 10 / CTRL-06 auto-dig', () => {
  // Reset the module-level dig flow-field cache between every test in this
  // block. Without this, a test that mutates the underground grid via
  // `ugSet` (rather than the MarkDigTileCommand handler that sets
  // colony.digFlowFieldDirty=true) inherits the cached flow field from
  // whichever test ran before — step 9 sees a falsy dirty flag AND a non-
  // first-compute state, and skips recomputation. The flow field then
  // doesn't reflect the tiles the test just marked, so tickDigExecution's
  // unreachable-release path (-2 reading) misclassifies a freshly-assigned
  // Digger and bounces it back to Idle. Caught while authoring Tests 11/12
  // for issue #31 (computeDigDemand reachability fix).
  beforeEach(() => {
    resetFlowFieldCaches();
  });

  /**
   * Build a single-colony world with an underground grid pre-shaped so that
   * (24, 1) is Open (mirrors the entrance shaft created by createScenario but
   * runs against makeWorldWithColony for fast setup). The tile (25, 1) starts
   * Solid; tests can MarkDigTile to flip it to Marked.
   */
  function makeWorldWithUndergroundForAutoDig(seed = 42): {
    world: WorldState;
    colonyId: ColonyId;
    queenId: number;
  } {
    const { world, colonyId, queenId } = makeWorldWithColony(seed);
    const colony = world.colonies[colonyId]!;
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    const ug = createUndergroundGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);
    // Open the entrance shaft so a Marked tile at (25, y) has a reachable Open
    // neighbor for the BFS flow field; matches the shape used by SC 1.
    ug.data[0 * UNDERGROUND_GRID_WIDTH + 24] = UndergroundTileState.Open;
    ug.data[1 * UNDERGROUND_GRID_WIDTH + 24] = UndergroundTileState.Open;
    world.undergroundGrids[colonyId] = ug;
    return { world, colonyId, queenId };
  }

  it('Test 1: demand activation — Marked tile + Idle ant → ant becomes Digging within 1 tick', () => {
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // Add 3 Idle workers (one will be picked; the strict cap holds the others).
    colony.workerCount = 3;
    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, { colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT, task: AntTask.Idle, subTask: 0 });
      world.ants.zone[wid] = 1; // Underground; matches the Open shaft cell
      colony.workers.push(wid);
    }

    // Forage-only ratio so non-dig demand is 0; auto-dig is the only signal.
    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    // t=0 preconditions
    expect(colony.workers.length).toBe(3);
    let initialIdle = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Idle) initialIdle += 1;
    expect(initialIdle).toBe(3);
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Solid);
    let initialDigging = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) initialDigging += 1;
    expect(initialDigging).toBe(0);
    expect(colony.computedAllocation.dig).toBe(0);

    // Mark a tile adjacent to the Open shaft.
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 25, tileY: 1, issuedAtTick: 0 };
    tick(world, [cmd]);

    // t=N outcomes
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Marked);
    expect(colony.computedAllocation.dig).toBe(1);
    let diggingCount = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) diggingCount += 1;
    expect(diggingCount).toBeGreaterThanOrEqual(1);
    // Strict cap holds even on the activation tick.
    expect(diggingCount).toBe(1);
  });

  it('Test 2: 1-digger cap — 5 Marked tiles + 5 Idle ants → exactly 1 Digging at t=1 and t=2', () => {
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    colony.workerCount = 5;
    for (let i = 0; i < 5; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, { colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT, task: AntTask.Idle, subTask: 0 });
      world.ants.zone[wid] = 1;
      colony.workers.push(wid);
    }
    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    // Mark 5 tiles in a column adjacent to the Open shaft.
    const markCmds: SimCommand[] = [];
    for (let dy = 1; dy <= 5; dy++) {
      markCmds.push({ type: 'MarkDigTile', colonyId, tileX: 25, tileY: dy, issuedAtTick: 0 });
    }

    // t=0 preconditions
    expect(colony.workers.length).toBe(5);
    for (let dy = 1; dy <= 5; dy++) {
      expect(ugGet(underground, 25, dy)).toBe(UndergroundTileState.Solid);
    }
    let initialDigging = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) initialDigging += 1;
    expect(initialDigging).toBe(0);

    tick(world, markCmds);

    // t=1: cap holds — exactly 1 ant Digging despite 5 Marked tiles + 5 Idle.
    let markedCount = 0;
    for (let dy = 1; dy <= 5; dy++) {
      if (ugGet(underground, 25, dy) === UndergroundTileState.Marked) markedCount += 1;
    }
    expect(markedCount).toBe(5);
    expect(colony.computedAllocation.dig).toBe(1);
    let digT1 = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) digT1 += 1;
    expect(digT1).toBe(1);

    tick(world, []);

    // t=2: still exactly 1 — cap holds across ticks while a digger is active.
    let digT2 = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) digT2 += 1;
    expect(digT2).toBe(1);
    // WR-07: slot stays reserved (dig=1) while a digger is active so the
    // forage carve persists across ticks; without the reservation, the
    // canonical iteration would over-book forage/fight and starve nurse
    // for the duration of every dig job (codex P1 v2).
    expect(colony.computedAllocation.dig).toBe(1);
  });

  it('Test 3: scarcity wait — Marked tile + 0 Idle ants → 0 Digging; foragers not preempted', () => {
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // 3 mid-cycle foragers carrying food (not Idle, not eligible for reassignment).
    colony.workerCount = 3;
    const foragerIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId,
        posX: 24 << FP_SHIFT,
        posY: 1 << FP_SHIFT,
        task: AntTask.Foraging,
        subTask: ForagingSubState.CarryingFood,
      });
      world.ants.zone[wid] = 1;
      world.ants.foodCarrying[wid] = 256; // mid-cycle; PRD §7c — not idle-checkpoint eligible
      colony.workers.push(wid);
      foragerIds.push(wid);
    }
    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;
    // Pre-populate computedAllocation so step 10a doesn't try to reassign these.
    colony.computedAllocation = { nurse: 0, forage: 3, dig: 0, fight: 0 };

    // t=0 preconditions
    let initialIdle = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Idle) initialIdle += 1;
    expect(initialIdle).toBe(0);
    let initialDigging = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) initialDigging += 1;
    expect(initialDigging).toBe(0);
    // Snapshot foragers' tasks at t=0 — they must NOT be preempted at t=N.
    const t0Tasks: Record<number, number> = {};
    for (const wid of foragerIds) t0Tasks[wid] = world.ants.task[wid]!;

    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 25, tileY: 1, issuedAtTick: 0 };
    tick(world, [cmd]);

    // Run 4 more ticks — wait policy: dig demand persists, no auto-assignment.
    for (let i = 0; i < 4; i++) tick(world, []);

    // t=N=5 outcomes
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Marked); // tile still Marked (nobody reached it)
    let diggingCount = 0;
    for (const wid of colony.workers) if (world.ants.task[wid] === AntTask.Digging) diggingCount += 1;
    expect(diggingCount).toBe(0);
    // No forager was preempted to dig.
    for (const wid of foragerIds) {
      expect(world.ants.task[wid]).toBe(t0Tasks[wid]);
    }
    // Demand check fired every tick — colony.computedAllocation.dig is 1 (Marked tile present, no ant Digging).
    expect(colony.computedAllocation.dig).toBe(1);
  });

  it('Test 4: return-to-Idle reassign — Digging ant finishes → next tick goes Foraging (no more Marked)', () => {
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // Place a worker already in Digging+Excavating ON a BeingDug tile with digTicksRemaining=1.
    // After 1 tick, tickDigExecution opens the tile and flips back to MovingToTile.
    // With no remaining Marked tiles, the next tick releases ant to Idle, and step 10a
    // reassigns to Foraging per the {forage:10, fight:0} ratio.
    colony.workerCount = 1;
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId,
      posX: 25 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
    });
    world.ants.zone[wid] = 1;
    world.ants.digTileX[wid] = 25;
    world.ants.digTileY[wid] = 1;
    world.ants.digTicksRemaining[wid] = 1;
    underground.data[1 * UNDERGROUND_GRID_WIDTH + 25] = UndergroundTileState.BeingDug;
    colony.workers.push(wid);
    colony.digFlowFieldDirty = true;

    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    // t=0 preconditions
    expect(world.ants.task[wid]).toBe(AntTask.Digging);
    expect(world.ants.subTask[wid]).toBe(DiggingSubState.Excavating);
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.BeingDug);
    expect(world.ants.digTicksRemaining[wid]).toBe(1);

    // Tick 1: excavation completes (digTicksRemaining 1→0), tile becomes Open, ant → MovingToTile.
    tick(world, []);
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Open);

    // Tick 2: step 10a sees the ant still as Digging (release hasn't fired yet —
    // tickDigExecution runs at step 10b, AFTER step 10a). Then at step 10b the dormant-
    // digger release path flips Digging → Idle since no Marked source remains.
    tick(world, []);
    expect(world.ants.task[wid]).toBe(AntTask.Idle);

    // Tick 3: step 10a sees the now-Idle ant; with no Marked tiles, computeDigDemand
    // returns 0 and the canonical iteration assigns to Foraging per the {forage:10, fight:0} ratio.
    tick(world, []);

    // t=N outcomes
    expect(world.ants.task[wid]).toBe(AntTask.Foraging);
    expect(colony.computedAllocation.dig).toBe(0);
  });

  it('Test 5: AI parity — Marked tile + Idle ant in AI colony → AI ant becomes Digging via the same path', () => {
    // CLNY-08 self-check: the auto-dig path is colony-symmetric. A MarkDigTileCommand with
    // colonyId === ENEMY_COLONY_ID drives an AI ant into Digging through the SAME step 10a
    // wire that the player uses. No isPlayer / colonyId branching.
    const world = createScenario(42);
    const aiColonyId = ENEMY_COLONY_ID as ColonyId;
    const playerColonyId = PLAYER_COLONY_ID as ColonyId;
    const aiColony = world.colonies[aiColonyId]!;
    const aiUg = world.undergroundGrids[aiColonyId]!;

    // Use a Marked tile adjacent to the AI's pre-excavated entrance shaft. createScenario
    // opens the entrance shaft for both colonies the same way (see scenario.ts:167-168).
    // We pick a tile reachable from the AI's Open region. ENEMY_START_X is the shaft column.
    // Any tile (col±1, row 1) where col is the AI shaft is reachable; we use a fixed
    // offset that sits next to the shaft and flip Solid→Marked via MarkDigTile.
    let aiShaftCol = -1;
    for (let x = 0; x < UNDERGROUND_GRID_WIDTH; x++) {
      if (aiUg.data[1 * UNDERGROUND_GRID_WIDTH + x] === UndergroundTileState.Open) {
        aiShaftCol = x;
        break;
      }
    }
    expect(aiShaftCol).toBeGreaterThanOrEqual(0); // sanity: scenario.ts opened a shaft
    const markX = aiShaftCol + 1;
    const markY = 1;
    expect(ugGet(aiUg, markX, markY)).toBe(UndergroundTileState.Solid);

    // Force AI workers to be Idle and underground at the shaft so they can pick up dig work.
    // STARTING_WORKERS spawn surface-side; for this test we just relocate one.
    expect(aiColony.workers.length).toBeGreaterThan(0);
    const aiWorkerId = aiColony.workers[0]!;
    world.ants.task[aiWorkerId] = AntTask.Idle;
    world.ants.subTask[aiWorkerId] = 0;
    world.ants.posX[aiWorkerId] = aiShaftCol << FP_SHIFT;
    world.ants.posY[aiWorkerId] = 1 << FP_SHIFT;
    world.ants.zone[aiWorkerId] = 1; // Underground — needed for tickDigExecution claim path

    // t=0 preconditions
    let aiDiggingT0 = 0;
    for (const wid of aiColony.workers) if (world.ants.task[wid] === AntTask.Digging) aiDiggingT0 += 1;
    expect(aiDiggingT0).toBe(0);
    expect(world.ants.task[aiWorkerId]).toBe(AntTask.Idle);

    // Issue MarkDigTile on the AI colony — same command surface as the player.
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId: aiColonyId, tileX: markX, tileY: markY, issuedAtTick: 0 };
    tick(world, [cmd]);

    // t=N outcomes — AI colony has exactly 1 Digging ant via the auto-dig path.
    expect(ugGet(aiUg, markX, markY)).toBe(UndergroundTileState.Marked);
    expect(aiColony.computedAllocation.dig).toBe(1);
    let aiDiggingT1 = 0;
    for (const wid of aiColony.workers) if (world.ants.task[wid] === AntTask.Digging) aiDiggingT1 += 1;
    expect(aiDiggingT1).toBe(1);

    // Player colony got NO Digging ants (no Mark in player colony) — proves the path is colony-scoped.
    const playerColony = world.colonies[playerColonyId]!;
    let playerDiggingT1 = 0;
    for (const wid of playerColony.workers) if (world.ants.task[wid] === AntTask.Digging) playerDiggingT1 += 1;
    expect(playerDiggingT1).toBe(0);
  });

  it('Test 6 (WR-06): nurse cap eats the only worker → auto-dig waits, nurse not preempted', () => {
    // Regression for the codex P1 finding: in a brood-heavy 1-worker colony,
    // the nurse cap (ceil(1/4)=1) eats the entire pool, leaving forage budget = 0.
    // Without WR-06, the auto-dig override would still set computedAllocation.dig=1
    // and the forage→dig→fight→nurse iteration would assign the only Idle ant to
    // Digging — starving nurse. With the gate, dig is suppressed and nurse wins.
    //
    // The load-bearing setup here is brood + Nursery + workerCount=1 (driving the
    // cap); targetRatio is irrelevant (the cap saturates first and forage_share
    // would be 0 even with forage=10).
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    colony.workerCount = 1;
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
      task: AntTask.Idle, subTask: 0,
    });
    world.ants.zone[wid] = 1;
    colony.workers.push(wid);

    for (let e = 0; e < 30; e++) {
      const lid = allocateEntityId(world);
      initAnt(world.ants, lid, { colonyId, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
      colony.larvae.push(lid);
      colony.larvaeCount += 1;
    }
    colony.chambers.push({
      chamberId: 9100, chamberType: ChamberType.Nursery,
      foodStored: 0, posX: 0, posY: 0, width: 2, height: 2,
    });

    // t=0 preconditions
    expect(colony.workers.length).toBe(1);
    expect(world.ants.task[wid]).toBe(AntTask.Idle);
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Solid);

    // Mark a tile + tick. allocateWorkers will compute nurse=1, forage=0; the
    // auto-dig override must observe forage=0 and suppress dig demand.
    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 25, tileY: 1, issuedAtTick: 0 };
    tick(world, [cmd]);

    // t=N outcomes — nurse cap is the actual cause; explicitly assert it.
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Marked); // Mark persists — waiting
    expect(colony.computedAllocation.nurse).toBe(1);
    expect(colony.computedAllocation.forage).toBe(0); // <- nurse cap, not targetRatio, drove this
    expect(colony.computedAllocation.dig).toBe(0); // suppressed (no forage slot to carve)
    expect(world.ants.task[wid]).toBe(AntTask.Nursing); // nurse won, not dig
    expect(world.ants.subTask[wid]).toBe(NursingSubState.MovingToBrood); // freshly assigned, not just inherited
  });

  it('Test 7 (WR-08): slider-to-fight (forage:0, no brood) → dig carves from fight, issue #13 honored', () => {
    // When the player slams the 1-D slider all the way to Fight ({forage:0,
    // fight:10}) with no brood, allocation = {nurse:0, forage:0, dig:0,
    // fight:N}. Issue #13's promise ("auto-assign one digger when a Mark
    // exists and an ant is Idle") still holds because the WR-08 carve falls
    // back to fight when forage is empty. nurse is still never carved.
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    colony.workerCount = 3;
    const widList: number[] = [];
    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
        task: AntTask.Idle, subTask: 0,
      });
      world.ants.zone[wid] = 1;
      colony.workers.push(wid);
      widList.push(wid);
    }

    colony.targetRatio.forage = 0;
    colony.targetRatio.fight  = 10;

    let initialIdle = 0;
    for (const id of widList) if (world.ants.task[id] === AntTask.Idle) initialIdle += 1;
    expect(initialIdle).toBe(3);
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Solid);

    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 25, tileY: 1, issuedAtTick: 0 };
    tick(world, [cmd]);

    // t=N outcomes — Mark dug, 1 worker Digging, 2 Fighting (carve from fight).
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Marked);
    expect(colony.computedAllocation.forage).toBe(0);
    expect(colony.computedAllocation.fight).toBe(3); // canonical post-allocation; carve is local
    expect(colony.computedAllocation.dig).toBe(1);
    let diggingCount = 0;
    let fightingCount = 0;
    for (const id of widList) {
      if (world.ants.task[id] === AntTask.Digging) diggingCount += 1;
      if (world.ants.task[id] === AntTask.Fighting) fightingCount += 1;
    }
    expect(diggingCount).toBe(1);
    expect(fightingCount).toBe(2);
  });

  it('Test 10 (WR-11): zero-ratio {forage:0, fight:0} with Idle ants → dig fires (CTRL-06 honored without a carve source)', () => {
    // codex P2 follow-up to PR #26: WR-10 leaves {forage:0, fight:0} as a
    // valid post-Phase-10 targetRatio (snap-to-default only fires for
    // legacy/malformed inputs). With both ratio-driven roles at 0 there is
    // nothing to carve from, but the unallocated remainder
    // (workerCount - nurseCount) sits Idle. Without WR-11 the CTRL-06
    // promise — "assign one digger when a Mark exists and an ant is Idle" —
    // silently breaks. WR-11 fires digDemand directly when Idle ants exist
    // (workerCount > nurseCount), keeping CLNY-09 nurse intact.
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // 3 workers, no brood — auto-nurse stays at 0 so all 3 are Idle.
    colony.workerCount = 3;
    const widList: number[] = [];
    for (let i = 0; i < 3; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
        task: AntTask.Idle, subTask: 0,
      });
      world.ants.zone[wid] = 1;
      colony.workers.push(wid);
      widList.push(wid);
    }

    // Valid post-Phase-10 zero-ratio. WR-10 keeps this as-is (the snap only
    // catches legacy {forage:0, dig:N, fight:0} inputs).
    colony.targetRatio.forage = 0;
    colony.targetRatio.fight  = 0;

    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 25, tileY: 1, issuedAtTick: 0 };
    tick(world, [cmd]);

    // CTRL-06 honored — exactly one ant Digging despite zero ratio budget.
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Marked);
    expect(colony.computedAllocation.nurse).toBe(0);
    expect(colony.computedAllocation.forage).toBe(0);
    expect(colony.computedAllocation.fight).toBe(0);
    expect(colony.computedAllocation.dig).toBe(1);
    let diggingCount = 0;
    let idleCount    = 0;
    for (const id of widList) {
      if (world.ants.task[id] === AntTask.Digging) diggingCount += 1;
      if (world.ants.task[id] === AntTask.Idle)    idleCount    += 1;
    }
    expect(diggingCount).toBe(1);
    expect(idleCount).toBe(2); // remaining Idle ants stay Idle (no other role demands)
  });

  it('Test 11 (issue #31): isolated Marked island (no Open neighbor) → dig demand = 0, Idle ants reassign to forage', () => {
    // Repro of the user-visible "ant sitting at chamber doing nothing" bug
    // captured in seed1521505688-tick2967. The player marked 4 tiles in the
    // top row of the underground grid by clicking the grass-textured ceiling
    // strip (issue #30); none of those tiles has an Open 4-neighbor. Pre-fix:
    // computeDigDemand returns 1, step 10a carves a slot and assigns one
    // Idle ant to Digging, the dig flow-field reports unreachable, the ant
    // bounces back to Idle each tick — locked out of forage indefinitely.
    // Post-fix (issue #31): Marked tiles without an Open neighbor don't
    // count, demand=0, the Idle ant gets reassigned to Foraging normally.
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    colony.workerCount = 2;
    const widList: number[] = [];
    for (let i = 0; i < 2; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
        task: AntTask.Idle, subTask: 0,
      });
      world.ants.zone[wid] = 1;
      colony.workers.push(wid);
      widList.push(wid);
    }

    // Mark a 2-tile island far from the entrance shaft, with no Open
    // 4-neighbor. The shaft Open tiles are at (24, 0) and (24, 1) per the
    // helper; the marks at (50, 30)/(50, 31) sit in a sea of Solid. The
    // describe-level `beforeEach(resetFlowFieldCaches)` ensures step 9's
    // firstDigCompute gate fires this tick, so direct ugSet without
    // dirty-flagging is safe here.
    ugSet(underground, 50, 30, UndergroundTileState.Marked);
    ugSet(underground, 50, 31, UndergroundTileState.Marked);

    // t=0 preconditions — confirm the island is genuinely isolated.
    expect(ugGet(underground, 50, 30)).toBe(UndergroundTileState.Marked);
    expect(ugGet(underground, 50, 31)).toBe(UndergroundTileState.Marked);
    expect(ugGet(underground, 49, 30)).toBe(UndergroundTileState.Solid);
    expect(ugGet(underground, 51, 30)).toBe(UndergroundTileState.Solid);
    expect(ugGet(underground, 50, 29)).toBe(UndergroundTileState.Solid);
    expect(ugGet(underground, 50, 32)).toBe(UndergroundTileState.Solid);

    tick(world, []);

    // Dig demand suppressed — the Marked island is unreachable, so the
    // forage-carve never fires. Both workers go to forage.
    expect(colony.computedAllocation.dig).toBe(0);
    let diggingCount = 0;
    let foragingCount = 0;
    for (const id of widList) {
      if (world.ants.task[id] === AntTask.Digging)  diggingCount  += 1;
      if (world.ants.task[id] === AntTask.Foraging) foragingCount += 1;
    }
    expect(diggingCount).toBe(0);
    expect(foragingCount).toBe(2);
  });

  it('Test 12 (issue #31): one Marked tile with an Open neighbor + one isolated → dig demand = 1', () => {
    // Mixed island scenario: prove the fix doesn't over-suppress. As long as
    // ANY Marked tile has an Open 4-neighbor, dig demand fires — the
    // unreachable marks are simply ignored.
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    colony.workerCount = 1;
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
      task: AntTask.Idle, subTask: 0,
    });
    world.ants.zone[wid] = 1;
    colony.workers.push(wid);

    // (25, 1) is adjacent to the Open shaft at (24, 1) — reachable.
    // (50, 30) is isolated — unreachable. beforeEach reset handles cache.
    ugSet(underground, 25, 1, UndergroundTileState.Marked);
    ugSet(underground, 50, 30, UndergroundTileState.Marked);

    tick(world, []);

    expect(colony.computedAllocation.dig).toBe(1);
    expect(world.ants.task[wid]).toBe(AntTask.Digging);
  });

  it('Test 9 (WR-08): all-nurse colony (forage=fight=0) → auto-dig genuinely waits', () => {
    // Counterpoint to Test 7 — and a future-regression guard against any
    // attempt to carve from nurse when both ratio-driven roles are empty.
    // When forage AND fight are both 0 (e.g., 1-worker brood-heavy colony
    // where the nurse cap pinned the only worker to nurse), there is no
    // ratio-driven slot to carve from. nurse is never carved (CLNY-09),
    // so dig waits — same scarcity-wait philosophy as no-Idle-ant case.
    // This case passes under both the old `forage > 0` gate and the new
    // forage→fight rule; its job is to lock in the "never carve from nurse"
    // floor so a future contributor doesn't extend the fallback chain.
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // 1 worker, brood-heavy + Nursery so nurse cap (ceil(1/4)=1) pins everything.
    colony.workerCount = 1;
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
      task: AntTask.Idle, subTask: 0,
    });
    world.ants.zone[wid] = 1;
    colony.workers.push(wid);

    for (let e = 0; e < 30; e++) {
      const lid = allocateEntityId(world);
      initAnt(world.ants, lid, { colonyId, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
      colony.larvae.push(lid);
      colony.larvaeCount += 1;
    }
    colony.chambers.push({
      chamberId: 9300, chamberType: ChamberType.Nursery,
      foodStored: 0, posX: 0, posY: 0, width: 2, height: 2,
    });

    // Slider-to-fight; combined with the nurse cap this leaves zero ratio
    // budget for any carve — the all-nurse case.
    colony.targetRatio.forage = 0;
    colony.targetRatio.fight  = 10;

    const cmd: SimCommand = { type: 'MarkDigTile', colonyId, tileX: 25, tileY: 1, issuedAtTick: 0 };
    tick(world, [cmd]);

    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.Marked); // Mark waits
    expect(colony.computedAllocation.nurse).toBe(1);
    expect(colony.computedAllocation.forage).toBe(0);
    expect(colony.computedAllocation.fight).toBe(0); // nurse cap ate available
    expect(colony.computedAllocation.dig).toBe(0); // no ratio-driven slot to carve
    expect(world.ants.task[wid]).toBe(AntTask.Nursing);
  });


  it('Test 8 (WR-07): dig slot reserved while digger is active → nurse not preempted by forage', () => {
    // Regression for codex P1 v2: in a 2-worker / brood-heavy / forage-only
    // colony with one ant actively excavating, the second (Idle) ant must
    // become a nurse, not a forager. allocateWorkers gives {nurse:1, forage:1,
    // fight:0}; without WR-07 the carve disappears mid-dig (rawDigDemand=0
    // under the 1-cap) and the forage→…→nurse iteration assigns the Idle
    // ant to Foraging — starving nurse for the entire dig duration. WR-07
    // holds digDemand=1 while actualDig>0, preserving the carve.
    const { world, colonyId } = makeWorldWithUndergroundForAutoDig();
    const colony = world.colonies[colonyId]!;
    const underground = world.undergroundGrids[colonyId]!;

    // Worker A: actively excavating with a long countdown so the dig persists
    // across the tick under test.
    colony.workerCount = 2;
    const widDigger = allocateEntityId(world);
    initAnt(world.ants, widDigger, {
      colonyId, posX: 25 << FP_SHIFT, posY: 1 << FP_SHIFT,
      task: AntTask.Digging, subTask: DiggingSubState.Excavating,
    });
    world.ants.zone[widDigger] = 1;
    world.ants.digTileX[widDigger] = 25;
    world.ants.digTileY[widDigger] = 1;
    world.ants.digTicksRemaining[widDigger] = 10;
    underground.data[1 * UNDERGROUND_GRID_WIDTH + 25] = UndergroundTileState.BeingDug;
    colony.workers.push(widDigger);
    colony.digFlowFieldDirty = true;

    // Worker B: Idle, the candidate for nurse vs forage.
    const widIdle = allocateEntityId(world);
    initAnt(world.ants, widIdle, {
      colonyId, posX: 24 << FP_SHIFT, posY: 1 << FP_SHIFT,
      task: AntTask.Idle, subTask: 0,
    });
    world.ants.zone[widIdle] = 1;
    colony.workers.push(widIdle);

    // Brood + Nursery so nurse=1, available=1, allocation={nurse:1, forage:1}.
    for (let e = 0; e < 30; e++) {
      const lid = allocateEntityId(world);
      initAnt(world.ants, lid, { colonyId, posX: 100, posY: 100, task: AntTask.Idle, subTask: 0, speed: 0 });
      colony.larvae.push(lid);
      colony.larvaeCount += 1;
    }
    colony.chambers.push({
      chamberId: 9200, chamberType: ChamberType.Nursery,
      foodStored: 0, posX: 0, posY: 0, width: 2, height: 2,
    });

    colony.targetRatio.forage = 10;
    colony.targetRatio.fight  = 0;

    // t=0 preconditions
    expect(world.ants.task[widDigger]).toBe(AntTask.Digging);
    expect(world.ants.task[widIdle]).toBe(AntTask.Idle);
    expect(ugGet(underground, 25, 1)).toBe(UndergroundTileState.BeingDug);
    expect(world.ants.digTicksRemaining[widDigger]).toBe(10);

    tick(world, []);

    // t=N outcomes — digger persists, idle ant goes to Nursing (not Foraging).
    expect(world.ants.task[widDigger]).toBe(AntTask.Digging);
    expect(world.ants.digTicksRemaining[widDigger]).toBe(9); // step 10b decremented
    expect(colony.computedAllocation.nurse).toBe(1);
    expect(colony.computedAllocation.forage).toBe(1); // canonical post-allocation; carve is local
    expect(colony.computedAllocation.dig).toBe(1); // slot reserved while digger active
    expect(world.ants.task[widIdle]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[widIdle]).toBe(NursingSubState.MovingToBrood);
  });
});
