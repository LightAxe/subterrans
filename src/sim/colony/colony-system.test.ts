// colony-system.test.ts — CLNY-04, CLNY-05, CLNY-07 + supporting helpers
//
// Test coverage:
//   withdrawFood:               success, insufficient, exact-amount
//   tickFoodConsumption:        queen fed/unfed, larva fed/unfed, queen-priority ordering
//   CLNY-04:                    queen starvation cascade (SC 2) + stay-alive-when-fed
//   tickStarvationCheck:        Phase 6 no-op isolation (regression guard — test 10)
//   CLNY-05:                    larva starvation + stay-alive-when-fed
//   tickDeathCleanup:           dead worker swap-remove, queen death sets defeated, all-bucket cleanup
//   tickReconcile:              countdown decrement, recount on zero, drift-correction (CLNY-07 SC 7)
//   CLNY-07 integration:        steady-state foodStored decrement per tick
//   checkPendingChambers:       chamber promotion, partial excavation stays, multiple pending
//   checkEntranceCompletion:    shaft-open detection, partial shaft stays, idempotent, multi-entrance
//   tickDeadDiggerCleanup:      BeingDug revert, no-claim skip, Open tile skip, tickDeathCleanup isolation

import { describe, it, expect } from 'vitest';
import {
  withdrawFood,
  colonyFoodTotal,
  colonyFoodCapacity,
  tickFoodConsumption,
  tickStarvationCheck,
  tickDeathCleanup,
  tickReconcile,
  checkPendingChambers,
  checkEntranceCompletion,
  tickDeadDiggerCleanup,
} from './colony-system.js';
import { createWorldState } from '../types.js';
import { createColonyRecord } from './colony-store.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask, ChamberType } from '../enums.js';
import {
  STARVATION_GRACE_TICKS,
  RECONCILE_INTERVAL_TICKS,
  QUEEN_FOOD_PER_TICK,
  LARVA_FOOD_PER_TICK,
  FOOD_CHAMBER_CAPACITY,
  FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP,
  BASE_FOOD_STORAGE_CAPACITY,
} from '../constants.js';
import { createUndergroundGrid, ugSet, UndergroundTileState } from '../terrain.js';
import { FP_SHIFT } from '../fixed.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from './colony-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;
const MAX_TEST_ENTITIES = 128;

/**
 * Create a fresh world + colony with a live queen at entity 0.
 * The queen entity is allocated as entity 0; colony.queenEntityId = 0.
 */
function setupWorldWithQueen(foodStored = 1000): { world: WorldState; colony: ColonyRecord } {
  const world = createWorldState(42, MAX_TEST_ENTITIES);

  const queenId = world.nextEntityId; // 0
  world.nextEntityId += 1;

  initAnt(world.ants, queenId, {
    colonyId: COLONY_ID,
    posX: 256,
    posY: 256,
    task: AntTask.Idle,
  });

  const colony = createColonyRecord(COLONY_ID, queenId);
  colony.foodStored = foodStored;
  world.colonies[COLONY_ID] = colony;

  return { world, colony };
}

/**
 * Add a live larva to the colony. Allocates next entity ID.
 * Returns the larva's entityId.
 */
function addLarva(world: WorldState, colony: ColonyRecord): number {
  const id = world.nextEntityId;
  world.nextEntityId += 1;

  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX: 256,
    posY: 256,
    task: AntTask.Idle,
  });
  // Initialize starvation timer to GRACE value (same as queen default)
  world.ants.starvationTimer[id] = STARVATION_GRACE_TICKS;

  colony.larvae.push(id);
  colony.larvaeCount += 1;

  return id;
}

/**
 * Add a live worker to the colony. Allocates next entity ID.
 * Returns the worker's entityId.
 */
function addWorker(world: WorldState, colony: ColonyRecord): number {
  const id = world.nextEntityId;
  world.nextEntityId += 1;

  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX: 256,
    posY: 256,
    task: AntTask.Idle,
  });

  colony.workers.push(id);
  colony.workerCount += 1;

  return id;
}

/**
 * Add an egg entity to the colony. Allocates next entity ID.
 * Returns the egg's entityId.
 */
function addEgg(world: WorldState, colony: ColonyRecord): number {
  const id = world.nextEntityId;
  world.nextEntityId += 1;

  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX: 256,
    posY: 256,
    task: AntTask.Idle,
  });

  colony.eggs.push(id);
  colony.eggCount += 1;

  return id;
}

// ---------------------------------------------------------------------------
// withdrawFood
// ---------------------------------------------------------------------------

describe('withdrawFood', () => {
  it('1. success — returns true and decrements foodStored', () => {
    const { colony } = setupWorldWithQueen(100);
    const result = withdrawFood(colony, 50);
    expect(result).toBe(true);
    expect(colony.foodStored).toBe(50);
  });

  it('2. insufficient — returns false, foodStored unchanged', () => {
    const { colony } = setupWorldWithQueen(10);
    const result = withdrawFood(colony, 50);
    expect(result).toBe(false);
    expect(colony.foodStored).toBe(10);
  });

  it('3. exact amount — returns true, foodStored reaches 0', () => {
    const { colony } = setupWorldWithQueen(50);
    const result = withdrawFood(colony, 50);
    expect(result).toBe(true);
    expect(colony.foodStored).toBe(0);
  });

  // Issue #15 — drain-order contract: chambers in array order first, then the
  // entrance pool. Other downstream code (HUD, AI gates) relies on chambers
  // emptying before the pool so the dirty-flag / re-seed cadence is stable.
  // A future refactor that flips the order would silently regress.
  it('drains chambers before the entrance pool (issue #15)', () => {
    const { colony } = setupWorldWithQueen(100);
    colony.chambers.push({
      chamberId: 1, chamberType: ChamberType.FoodStorage, foodStored: 200,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    const result = withdrawFood(colony, 50);
    expect(result).toBe(true);
    expect(colony.chambers[0]!.foodStored).toBe(150); // chamber drained
    expect(colony.foodStored).toBe(100);              // pool untouched
  });

  it('drains the entrance pool only after every chamber is empty (issue #15)', () => {
    const { colony } = setupWorldWithQueen(100);
    colony.chambers.push({
      chamberId: 1, chamberType: ChamberType.FoodStorage, foodStored: 30,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    const result = withdrawFood(colony, 50);
    expect(result).toBe(true);
    expect(colony.chambers[0]!.foodStored).toBe(0);   // chamber drained first
    expect(colony.foodStored).toBe(80);               // remaining 20 from pool
  });

  it('sets foodFlowFieldDirty only on saturated→depositable transitions (issue #15 follow-up)', () => {
    // Hysteresis: a chamber is "saturated" while free space <
    // FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP. The flow-field re-seed must fire
    // ONLY when withdraw pushes a chamber across the saturation boundary —
    // not on every cap → cap-N drain. A naive full→not-full trigger fires on
    // a single QUEEN_FOOD_PER_TICK=2 drain and pins carriers mid-traversal
    // (see /tmp/stuck-dump.json — seed 1294596103 tick 1876).
    const HYST = FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP;
    const { colony } = setupWorldWithQueen(0);
    // Chamber 0: full → still saturated after small drains until we reach
    // the depositable threshold (free space >= HYST).
    colony.chambers.push({
      chamberId: 1, chamberType: ChamberType.FoodStorage, foodStored: FOOD_CHAMBER_CAPACITY,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    // Chamber 1: starts depositable (free space > HYST) — drains within the
    // depositable band must NOT fire dirty.
    colony.chambers.push({
      chamberId: 2, chamberType: ChamberType.FoodStorage, foodStored: 100,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    colony.foodFlowFieldDirty = false;

    // Tiny drain from chamber 0 — saturated → still saturated (free space < HYST).
    // Must NOT fire dirty (this is the queen-drain oscillation case).
    withdrawFood(colony, 1);
    expect(colony.foodFlowFieldDirty).toBe(false);

    // Drain enough to cross the saturation boundary — saturated → depositable.
    // Chamber 0 now has free space == HYST. Must fire dirty.
    withdrawFood(colony, HYST - 1);
    expect(colony.foodFlowFieldDirty).toBe(true);

    // Reset. Further drain in the depositable band — must NOT re-fire.
    colony.foodFlowFieldDirty = false;
    withdrawFood(colony, 1);
    expect(colony.foodFlowFieldDirty).toBe(false);

    // Drain across both chambers within the depositable band — must NOT fire.
    // Withdraw drains chamber 0 (lower index) before chamber 1. Total chamber
    // food at this point is 4607 + 100 = 4707; withdraw exactly 4707 to fully
    // drain both. Chamber 0: depositable (free 513) → empty (free CAP) — both
    // depositable. Chamber 1: depositable (free 5020) → empty — both
    // depositable. No saturated→depositable transition occurs, so dirty
    // must stay false. (Withdrawing `FOOD_CHAMBER_CAPACITY` here would
    // exceed colonyFoodTotal=4707 and trigger withdrawFood's all-or-nothing
    // early-return — assertion would pass vacuously without exercising the
    // drain loop.)
    colony.foodFlowFieldDirty = false;
    expect(withdrawFood(colony, 4707)).toBe(true);
    expect(colony.foodFlowFieldDirty).toBe(false);
    expect(colony.chambers[0]!.foodStored).toBe(0);
    expect(colony.chambers[1]!.foodStored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// colonyFoodTotal — issue #15 regression guard
//
// colonyFoodTotal is the canonical "total stored food" reader post-#15.
// HUD displays, AI thresholds, and forager-economy code all read it. A
// regression that drops the chamber-summing branch (e.g. reverting it to
// `return colony.foodStored` alone) would silently break every consumer.
// These tests guard against that by exercising both contributions.
// ---------------------------------------------------------------------------

describe('colonyFoodTotal — issue #15', () => {
  it('sums entrance pool only when no chambers exist', () => {
    const { colony } = setupWorldWithQueen(123);
    expect(colonyFoodTotal(colony)).toBe(123);
  });

  it('includes FoodStorage chamber food in the total', () => {
    const { colony } = setupWorldWithQueen(0);
    colony.chambers.push({
      chamberId: 1, chamberType: ChamberType.FoodStorage, foodStored: 200,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    colony.chambers.push({
      chamberId: 2, chamberType: ChamberType.FoodStorage, foodStored: 50,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    expect(colonyFoodTotal(colony)).toBe(250);
  });

  it('sums entrance pool + every FoodStorage chamber', () => {
    const { colony } = setupWorldWithQueen(100);
    colony.chambers.push({
      chamberId: 1, chamberType: ChamberType.FoodStorage, foodStored: 200,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    expect(colonyFoodTotal(colony)).toBe(300);
  });

  it('excludes non-FoodStorage chamber types from the total', () => {
    const { colony } = setupWorldWithQueen(100);
    // A non-FoodStorage chamber's foodStored is meaningless — must not contribute.
    colony.chambers.push({
      chamberId: 1, chamberType: ChamberType.Queen, foodStored: 999,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    colony.chambers.push({
      chamberId: 2, chamberType: ChamberType.Nursery, foodStored: 999,
      posX: 0, posY: 0, width: 1, height: 1,
    });
    expect(colonyFoodTotal(colony)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// tickFoodConsumption — basic per-entity contract
// ---------------------------------------------------------------------------

describe('tickFoodConsumption', () => {
  it('4. queen fed — decrements foodStored by QUEEN_FOOD_PER_TICK, resets timer to GRACE', () => {
    const { world, colony } = setupWorldWithQueen(1000);
    colony.queenStarvationTimer = 50; // below grace — should be reset on feed

    tickFoodConsumption(world, colony);

    expect(colony.foodStored).toBe(1000 - QUEEN_FOOD_PER_TICK);
    expect(colony.queenStarvationTimer).toBe(STARVATION_GRACE_TICKS);
    expect(world.ants.alive[colony.queenEntityId]).toBe(1); // still alive
  });

  it('5. queen not fed (empty pool) — foodStored stays 0, timer NOT reset', () => {
    const { world, colony } = setupWorldWithQueen(0);
    colony.queenStarvationTimer = 50;

    tickFoodConsumption(world, colony);

    expect(colony.foodStored).toBe(0);
    expect(colony.queenStarvationTimer).toBe(49); // decremented by 1, not reset
    expect(world.ants.alive[colony.queenEntityId]).toBe(1); // still alive (50 > 0)
  });

  it('6. larva fed — resets starvationTimer to GRACE', () => {
    const { world, colony } = setupWorldWithQueen(1000);
    const larvaId = addLarva(world, colony);
    world.ants.starvationTimer[larvaId] = 50; // below grace

    tickFoodConsumption(world, colony);

    // Queen consumed QUEEN_FOOD_PER_TICK first, then larva consumed LARVA_FOOD_PER_TICK
    expect(colony.foodStored).toBe(1000 - QUEEN_FOOD_PER_TICK - LARVA_FOOD_PER_TICK);
    expect(world.ants.starvationTimer[larvaId]).toBe(STARVATION_GRACE_TICKS); // reset on feed
    expect(world.ants.alive[larvaId]).toBe(1);
  });

  it('7. queen-priority — queen fed first; larvae starve when pool exactly covers queen only', () => {
    // foodStored = 2 = exactly one queen meal; QUEEN_FOOD_PER_TICK=2, LARVA_FOOD_PER_TICK=1
    const { world, colony } = setupWorldWithQueen(QUEEN_FOOD_PER_TICK);
    const larvaId1 = addLarva(world, colony);
    const larvaId2 = addLarva(world, colony);
    const larvaId3 = addLarva(world, colony);

    // Give larvae high timers so they survive one unfed tick
    world.ants.starvationTimer[larvaId1] = 50;
    world.ants.starvationTimer[larvaId2] = 50;
    world.ants.starvationTimer[larvaId3] = 50;

    tickFoodConsumption(world, colony);

    // Queen was fed — timer reset
    expect(colony.queenStarvationTimer).toBe(STARVATION_GRACE_TICKS);
    expect(colony.foodStored).toBe(0); // pool exhausted by queen
    // All larvae unfed — timers decremented by 1
    expect(world.ants.starvationTimer[larvaId1]).toBe(49);
    expect(world.ants.starvationTimer[larvaId2]).toBe(49);
    expect(world.ants.starvationTimer[larvaId3]).toBe(49);
    // Larvae not yet dead (timers still > 0)
    expect(world.ants.alive[larvaId1]).toBe(1);
    expect(world.ants.alive[larvaId2]).toBe(1);
    expect(world.ants.alive[larvaId3]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLNY-04: queen starvation cascade (Phase 6 SC 2)
// ---------------------------------------------------------------------------

describe('tickFoodConsumption — CLNY-04 queen starvation cascade', () => {
  it('8. queen dies after exactly STARVATION_GRACE_TICKS unfed ticks', () => {
    const { world, colony } = setupWorldWithQueen(0); // empty pool
    colony.queenStarvationTimer = STARVATION_GRACE_TICKS;

    // STARVATION_GRACE_TICKS - 1 calls should not kill the queen
    for (let i = 0; i < STARVATION_GRACE_TICKS - 1; i++) {
      tickFoodConsumption(world, colony);
      // Also call the no-op for realistic dispatch order (verifies it doesn't affect state)
      tickStarvationCheck(world, colony);
      expect(world.ants.alive[colony.queenEntityId]).toBe(1);
    }

    // The STARVATION_GRACE_TICKS-th tick: timer reaches 0 → queen dies
    tickFoodConsumption(world, colony);
    expect(world.ants.alive[colony.queenEntityId]).toBe(0);
    expect(colony.queenStarvationTimer).toBeLessThanOrEqual(0);
  });

  it('9. queen stays alive when fed — timer pinned at GRACE (no separate decrement)', () => {
    const { world, colony } = setupWorldWithQueen(10_000); // ample food

    for (let i = 0; i < 200; i++) {
      tickFoodConsumption(world, colony);
      // Timer must always be reset to STARVATION_GRACE_TICKS (not drifting downward)
      expect(colony.queenStarvationTimer).toBe(STARVATION_GRACE_TICKS);
    }
    expect(world.ants.alive[colony.queenEntityId]).toBe(1);
  });

  it('10. tickStarvationCheck is a no-op — isolation test (regression guard)', () => {
    // Regression guard: if an unconditional decrement were ever added to
    // tickStarvationCheck, timers would drift even without consumption.
    const { world, colony } = setupWorldWithQueen(0);
    const larvaId = addLarva(world, colony);

    colony.queenStarvationTimer = 50;
    world.ants.starvationTimer[larvaId] = 50;

    // Call tickStarvationCheck 1000 times in isolation (no consumption calls)
    for (let i = 0; i < 1000; i++) {
      tickStarvationCheck(world, colony);
    }

    // Timers must be unchanged — the function must be a true no-op
    expect(colony.queenStarvationTimer).toBe(50);
    expect(world.ants.starvationTimer[larvaId]).toBe(50);
    expect(world.ants.alive[colony.queenEntityId]).toBe(1);
    expect(world.ants.alive[larvaId]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLNY-05: larva starvation
// ---------------------------------------------------------------------------

describe('tickFoodConsumption — CLNY-05 larva starvation', () => {
  it('11. larva dies after 100 unfed ticks (STARVATION_GRACE_TICKS)', () => {
    const { world, colony } = setupWorldWithQueen(0); // empty pool
    const larvaId = addLarva(world, colony);
    world.ants.starvationTimer[larvaId] = STARVATION_GRACE_TICKS;

    // STARVATION_GRACE_TICKS - 1 iterations — still alive
    for (let i = 0; i < STARVATION_GRACE_TICKS - 1; i++) {
      tickFoodConsumption(world, colony);
      expect(world.ants.alive[larvaId]).toBe(1);
    }

    // Final tick — timer reaches 0 → larva dies
    tickFoodConsumption(world, colony);
    expect(world.ants.alive[larvaId]).toBe(0);
  });

  it('12. larva stays alive when fed — timer stays at GRACE', () => {
    const { world, colony } = setupWorldWithQueen(10_000);
    const larvaId = addLarva(world, colony);

    for (let i = 0; i < 100; i++) {
      tickFoodConsumption(world, colony);
    }

    expect(world.ants.alive[larvaId]).toBe(1);
    expect(world.ants.starvationTimer[larvaId]).toBe(STARVATION_GRACE_TICKS);
  });
});

// ---------------------------------------------------------------------------
// tickDeathCleanup
// ---------------------------------------------------------------------------

describe('tickDeathCleanup', () => {
  it('13. dead worker is swap-removed from workers bucket; workerCount decremented', () => {
    const { world, colony } = setupWorldWithQueen();
    const id1 = addWorker(world, colony);
    const id2 = addWorker(world, colony);
    const id3 = addWorker(world, colony);
    expect(colony.workerCount).toBe(3);

    world.ants.alive[id2] = 0; // kill middle worker

    tickDeathCleanup(world, colony);

    expect(colony.workers).toHaveLength(2);
    expect(colony.workers).not.toContain(id2); // removed
    expect(colony.workers).toContain(id1);     // still present
    expect(colony.workers).toContain(id3);     // still present
    expect(colony.workerCount).toBe(2);
  });

  it('14. queen death sets colony.defeated = true', () => {
    const { world, colony } = setupWorldWithQueen();
    world.ants.alive[colony.queenEntityId] = 0; // kill queen

    tickDeathCleanup(world, colony);

    expect(colony.defeated).toBe(true);
  });

  it('15. all-bucket cleanup — dead eggs/larvae/workers removed in one pass', () => {
    const { world, colony } = setupWorldWithQueen();

    // Add entities to all three buckets
    const egg1  = addEgg(world, colony);
    const egg2  = addEgg(world, colony);
    const lar1  = addLarva(world, colony);
    const lar2  = addLarva(world, colony);
    const wrk1  = addWorker(world, colony);
    const wrk2  = addWorker(world, colony);

    // Kill one from each bucket
    world.ants.alive[egg1]  = 0;
    world.ants.alive[lar1]  = 0;
    world.ants.alive[wrk1]  = 0;

    tickDeathCleanup(world, colony);

    expect(colony.eggs).toHaveLength(1);
    expect(colony.eggs).toContain(egg2);
    expect(colony.eggCount).toBe(1);

    expect(colony.larvae).toHaveLength(1);
    expect(colony.larvae).toContain(lar2);
    expect(colony.larvaeCount).toBe(1);

    expect(colony.workers).toHaveLength(1);
    expect(colony.workers).toContain(wrk2);
    expect(colony.workerCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tickReconcile
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// colonyFoodCapacity — 09 backlog memo
// ---------------------------------------------------------------------------

describe('colonyFoodCapacity', () => {
  it('base-only cap — no chambers → BASE_FOOD_STORAGE_CAPACITY', () => {
    const { colony } = setupWorldWithQueen();
    expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY);
  });

  it('base + 1× FoodStorage chamber → BASE + 1 × FOOD_CHAMBER_CAPACITY', () => {
    const { colony } = setupWorldWithQueen();
    colony.chambers.push(
      { chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: 0, posX: 0, posY: 0, width: 3, height: 3 },
    );
    expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY + FOOD_CHAMBER_CAPACITY);
  });

  it('base + 2× FoodStorage chamber → BASE + 2 × FOOD_CHAMBER_CAPACITY', () => {
    const { colony } = setupWorldWithQueen();
    colony.chambers.push(
      { chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: 0, posX: 0, posY: 0, width: 3, height: 3 },
      { chamberId: 101, chamberType: ChamberType.FoodStorage, foodStored: 0, posX: 4, posY: 0, width: 3, height: 3 },
    );
    expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY + 2 * FOOD_CHAMBER_CAPACITY);
  });

  it('Queen / Nursery chambers do NOT contribute to capacity', () => {
    const { colony } = setupWorldWithQueen();
    colony.chambers.push(
      { chamberId: 100, chamberType: ChamberType.Queen,   foodStored: 0, posX: 0, posY: 0, width: 5, height: 3 },
      { chamberId: 101, chamberType: ChamberType.Nursery, foodStored: 0, posX: 8, posY: 0, width: 4, height: 3 },
    );
    expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY);
  });

  it('pending FoodStorage chambers do NOT contribute — only completed chambers in colony.chambers count', () => {
    // Capacity helper reads only colony.chambers; world.pendingChambers is not inspected.
    // Promotion happens in checkPendingChambers once excavation completes.
    const { colony } = setupWorldWithQueen();
    expect(colony.chambers).toHaveLength(0);
    expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY);
  });
});

describe('tickReconcile', () => {
  it('16. countdown decrement — recount does NOT run when countdown > 0 after decrement', () => {
    const { world, colony } = setupWorldWithQueen();
    colony.reconcileCountdown = 100;

    tickReconcile(world, colony);

    expect(colony.reconcileCountdown).toBe(99); // decremented
    // workerCount unchanged (no recount ran)
    expect(colony.workerCount).toBe(0);
    expect(colony.eggCount).toBe(0);
    expect(colony.larvaeCount).toBe(0);
  });

  it('17. recount runs when countdown reaches 0; countdown resets to RECONCILE_INTERVAL_TICKS', () => {
    const { world, colony } = setupWorldWithQueen();
    colony.reconcileCountdown = 1; // one decrement will hit 0

    tickReconcile(world, colony);

    // Recount ran; countdown reset
    expect(colony.reconcileCountdown).toBe(RECONCILE_INTERVAL_TICKS);
  });

  it('18. recount fixes drift — CLNY-07 Phase 6 SC 7', () => {
    const { world, colony } = setupWorldWithQueen();
    addWorker(world, colony);
    const id2 = addWorker(world, colony);
    addWorker(world, colony);

    // Manually introduce drift: claim 5 workers but only 3 are in the array
    colony.workerCount = 5;

    // Kill one of the three workers to make recount non-trivial
    world.ants.alive[id2] = 0;

    // Force reconcile to run immediately
    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);

    // Recount should find 2 alive workers (id1 and id3); id2 cleaned out
    expect(colony.workerCount).toBe(2);
    expect(colony.workers).toHaveLength(2);
    expect(colony.workers).not.toContain(id2);
  });

  it('19. reconcile recomputes allocateWorkers after recount', () => {
    const { world, colony } = setupWorldWithQueen();
    // Add 6 workers + 2 larvae (brood for nurse carveout)
    for (let i = 0; i < 6; i++) addWorker(world, colony);
    addLarva(world, colony);
    addLarva(world, colony);

    colony.targetRatio.forage = 8;
    colony.targetRatio.dig = 2;
    colony.targetRatio.fight = 0;

    // Zero out allocation to prove reconcile recomputes it
    colony.computedAllocation.nurse = 0;
    colony.computedAllocation.forage = 0;
    colony.computedAllocation.dig = 0;
    colony.computedAllocation.fight = 0;
    colony.nurseCount = 0;

    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);

    // Allocation must now reflect actual worker/brood counts
    const total = colony.computedAllocation.nurse + colony.computedAllocation.forage
                + colony.computedAllocation.dig + colony.computedAllocation.fight;
    expect(total).toBe(colony.workerCount);
    expect(colony.nurseCount).toBe(colony.computedAllocation.nurse);
  });

  it('20. reconcile clamps negative foodStored to 0', () => {
    const { world, colony } = setupWorldWithQueen();
    colony.foodStored = -50; // artificially drifted negative
    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);
    expect(colony.foodStored).toBe(0);
  });

  it('20a. reconcile clamps foodStored over capacity down to colonyFoodCapacity (no chambers)', () => {
    const { world, colony } = setupWorldWithQueen();
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY + 500; // simulated overshoot
    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
  });

  it('20b. reconcile clamps the entrance pool to BASE and each chamber.foodStored to FOOD_CHAMBER_CAPACITY independently (issue #15)', () => {
    const { world, colony } = setupWorldWithQueen();
    // Issue #15: chamber.foodStored is per-chamber authoritative; the entrance
    // pool (`colony.foodStored`) caps at BASE alone — chambers are NOT a
    // capacity extension of the pool. Reconcile defensively clamps each side.
    colony.chambers.push(
      { chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: FOOD_CHAMBER_CAPACITY + 200, posX: 0, posY: 0, width: 3, height: 3 },
    );
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY + 1000; // pool overshoot
    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(colony.chambers[0]!.foodStored).toBe(FOOD_CHAMBER_CAPACITY);
  });

  it('20c. reconcile does NOT inflate foodStored when under capacity', () => {
    const { world, colony } = setupWorldWithQueen(1000);
    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);
    expect(colony.foodStored).toBe(1000);
  });

  it('20d. reconcile does NOT interfere with food consumption — consumption still decrements foodStored', () => {
    const { world, colony } = setupWorldWithQueen(1000);
    // Force reconcile to run then consume on the same tick via the per-colony contract
    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);
    expect(colony.foodStored).toBe(1000); // no-op for a colony below cap
    tickFoodConsumption(world, colony);
    expect(colony.foodStored).toBe(1000 - QUEEN_FOOD_PER_TICK);
  });

  it('22. reconcile NEVER redistributes the entrance pool across chambers (issue #15 regression)', () => {
    // Pre-#15 the pool projected over N chambers, magically filling any chamber
    // an ant had never visited. The post-#15 contract: chamber.foodStored is
    // independent — it grows only when an ant deposits inside that chamber's
    // footprint. Reconcile is forbidden from moving food across boundaries.
    const { world, colony } = setupWorldWithQueen(8000);
    colony.chambers.push(
      { chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: 0, posX: 0, posY: 0, width: 3, height: 3 },
      { chamberId: 101, chamberType: ChamberType.Nursery,     foodStored: 0, posX: 4, posY: 0, width: 3, height: 3 },
      { chamberId: 102, chamberType: ChamberType.FoodStorage, foodStored: 0, posX: 8, posY: 0, width: 3, height: 3 },
    );

    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);

    // No ant deposits happened → all FoodStorage chambers stay at 0.
    expect(colony.chambers[0]!.foodStored).toBe(0);
    expect(colony.chambers[1]!.foodStored).toBe(0);
    expect(colony.chambers[2]!.foodStored).toBe(0);
    // Entrance pool clamps to BASE (8000 > BASE = 2048).
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
  });

  it('23. reconcile defensively clamps a per-chamber overshoot down to FOOD_CHAMBER_CAPACITY (issue #15)', () => {
    // The deposit + withdraw paths cap at source, but reconcile is the safety
    // net for any drift. Direct chamber overshoot is clamped here.
    const { world, colony } = setupWorldWithQueen(0);
    colony.chambers.push(
      { chamberId: 100, chamberType: ChamberType.FoodStorage,
        foodStored: FOOD_CHAMBER_CAPACITY + 12345, // simulated drift
        posX: 0, posY: 0, width: 3, height: 3 },
    );

    colony.reconcileCountdown = 1;
    tickReconcile(world, colony);

    expect(colony.chambers[0]!.foodStored).toBe(FOOD_CHAMBER_CAPACITY);
    expect(colony.foodStored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CLNY-07 cached fields update — integration
// ---------------------------------------------------------------------------

describe('CLNY-07 cached fields — integration', () => {
  it('21. steady-state foodStored decrements by QUEEN_FOOD_PER_TICK + larvaeCount * LARVA_FOOD_PER_TICK per tick', () => {
    const { world, colony } = setupWorldWithQueen(10_000);
    const larvaCount = 3;
    for (let i = 0; i < larvaCount; i++) {
      addLarva(world, colony);
    }

    const expectedDecrement = QUEEN_FOOD_PER_TICK + larvaCount * LARVA_FOOD_PER_TICK;
    const initialFood = colony.foodStored;

    for (let tick = 1; tick <= 10; tick++) {
      tickFoodConsumption(world, colony);
      expect(colony.foodStored).toBe(initialFood - tick * expectedDecrement);
    }

    // All entities still alive (ample food)
    expect(world.ants.alive[colony.queenEntityId]).toBe(1);
    for (const larvaId of colony.larvae) {
      expect(world.ants.alive[larvaId]).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// checkPendingChambers
// ---------------------------------------------------------------------------

/**
 * Set up a minimal world with one colony and an underground grid.
 * Assigns Phase 3 defaults (entrances, rallyPoint, digFlowFieldDirty) per PRD §2a.
 * Returns world, colony, and the colonyId used.
 */
function setupWorldWithColonyAndUnderground(gridW = 20, gridH = 20): {
  world: WorldState;
  colony: ColonyRecord;
  colonyId: number;
} {
  const world = createWorldState(42, 128);
  const colonyId = 1;

  const queenId = world.nextEntityId;
  world.nextEntityId += 1;
  initAnt(world.ants, queenId, { colonyId, posX: 256, posY: 256, task: AntTask.Idle });

  const colony = createColonyRecord(colonyId, queenId);
  // Phase 3 caller-side init contract (PRD §2a):
  colony.entrances         = [];
  colony.rallyPoint        = null;
  colony.digFlowFieldDirty = false;

  world.colonies[colonyId] = colony;

  // Attach an underground grid
  const ug = createUndergroundGrid(gridW, gridH);
  world.undergroundGrids[colonyId] = ug;

  return { world, colony, colonyId };
}

describe('checkPendingChambers', () => {
  it('1. all footprint tiles Open → PendingChamber deleted, ChamberRecord created with correct fields', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Mark a 2×2 footprint at anchor (3,4) as Open
    ugSet(ug, 3, 4, UndergroundTileState.Open);
    ugSet(ug, 4, 4, UndergroundTileState.Open);
    ugSet(ug, 3, 5, UndergroundTileState.Open);
    ugSet(ug, 4, 5, UndergroundTileState.Open);

    const key = `${colonyId}:3:4`;
    world.pendingChambers[key] = {
      colonyId,
      chamberType: ChamberType.Nursery,
      anchorTileX: 3,
      anchorTileY: 4,
      width:       2,
      height:      2,
    };

    const entityIdBefore = world.nextEntityId;
    checkPendingChambers(world);

    // PendingChamber entry deleted
    expect(world.pendingChambers[key]).toBeUndefined();

    // ChamberRecord created in colony.chambers
    expect(colony.chambers).toHaveLength(1);
    const ch = colony.chambers[0]!;
    expect(ch.chamberId).toBe(entityIdBefore); // allocateEntityId returns pre-increment value
    expect(ch.chamberType).toBe(ChamberType.Nursery);
    expect(ch.foodStored).toBe(0);
    // posX/posY are fixed-point (anchorTile << FP_SHIFT)
    expect(ch.posX).toBe(3 << FP_SHIFT);
    expect(ch.posY).toBe(4 << FP_SHIFT);
    expect(ch.width).toBe(2);
    expect(ch.height).toBe(2);
  });

  it('2. some footprint tiles still Solid → PendingChamber remains, no ChamberRecord', () => {
    const { world, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Only open one of the four tiles
    ugSet(ug, 3, 4, UndergroundTileState.Open);
    // (4,4), (3,5), (4,5) remain Solid

    const key = `${colonyId}:3:4`;
    world.pendingChambers[key] = {
      colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: 3,
      anchorTileY: 4,
      width:       2,
      height:      2,
    };

    checkPendingChambers(world);

    expect(world.pendingChambers[key]).toBeDefined();
    expect(world.colonies[colonyId]!.chambers).toHaveLength(0);
  });

  it('3. some footprint tiles BeingDug → PendingChamber remains (BeingDug is NOT Open)', () => {
    const { world, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    ugSet(ug, 3, 4, UndergroundTileState.Open);
    ugSet(ug, 4, 4, UndergroundTileState.Open);
    ugSet(ug, 3, 5, UndergroundTileState.Open);
    ugSet(ug, 4, 5, UndergroundTileState.BeingDug); // NOT Open

    const key = `${colonyId}:3:4`;
    world.pendingChambers[key] = {
      colonyId,
      chamberType: ChamberType.Nursery,
      anchorTileX: 3,
      anchorTileY: 4,
      width:       2,
      height:      2,
    };

    checkPendingChambers(world);

    expect(world.pendingChambers[key]).toBeDefined();
    expect(world.colonies[colonyId]!.chambers).toHaveLength(0);
  });

  it('4. multiple PendingChambers: completed one deleted, incomplete one remains', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Chamber A (1×1 at 2,2) — fully open
    ugSet(ug, 2, 2, UndergroundTileState.Open);
    const keyA = `${colonyId}:2:2`;
    world.pendingChambers[keyA] = {
      colonyId, chamberType: ChamberType.Nursery,
      anchorTileX: 2, anchorTileY: 2, width: 1, height: 1,
    };

    // Chamber B (1×1 at 5,5) — still Solid
    const keyB = `${colonyId}:5:5`;
    world.pendingChambers[keyB] = {
      colonyId, chamberType: ChamberType.FoodStorage,
      anchorTileX: 5, anchorTileY: 5, width: 1, height: 1,
    };

    checkPendingChambers(world);

    expect(world.pendingChambers[keyA]).toBeUndefined(); // completed — deleted
    expect(world.pendingChambers[keyB]).toBeDefined();   // incomplete — remains
    expect(colony.chambers).toHaveLength(1);
    expect(colony.chambers[0]!.chamberType).toBe(ChamberType.Nursery);
  });

  it('5. UNDR-06: ChamberRecord dimensions match PendingChamber; posX/posY are fixed-point', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Open a 3×2 footprint at anchor (1,2)
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        ugSet(ug, 1 + dx, 2 + dy, UndergroundTileState.Open);
      }
    }

    const key = `${colonyId}:1:2`;
    world.pendingChambers[key] = {
      colonyId, chamberType: ChamberType.FoodStorage,
      anchorTileX: 1, anchorTileY: 2, width: 3, height: 2,
    };

    checkPendingChambers(world);

    expect(colony.chambers).toHaveLength(1);
    const ch = colony.chambers[0]!;
    expect(ch.width).toBe(3);
    expect(ch.height).toBe(2);
    expect(ch.posX).toBe(1 << FP_SHIFT);
    expect(ch.posY).toBe(2 << FP_SHIFT);
  });
});

// ---------------------------------------------------------------------------
// checkEntranceCompletion
// ---------------------------------------------------------------------------

describe('checkEntranceCompletion', () => {
  it('6. shaft tiles (y=0, y=1) both Open → entrance.isOpen set to true', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    ugSet(ug, 5, 0, UndergroundTileState.Open);
    ugSet(ug, 5, 1, UndergroundTileState.Open);

    colony.entrances.push({
      entranceId:   1,
      surfaceTileX: 5,
      surfaceTileY: 0,
      isOpen:       false,
    });

    checkEntranceCompletion(world);

    expect(colony.entrances[0]!.isOpen).toBe(true);
  });

  it('7. only y=0 Open, y=1 still Solid → entrance remains closed', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    ugSet(ug, 5, 0, UndergroundTileState.Open);
    // (5,1) stays Solid

    colony.entrances.push({
      entranceId:   1,
      surfaceTileX: 5,
      surfaceTileY: 0,
      isOpen:       false,
    });

    checkEntranceCompletion(world);

    expect(colony.entrances[0]!.isOpen).toBe(false);
  });

  it('8. entrance already open → not re-checked (idempotent)', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Shaft tiles remain Solid (normally would keep entrance closed)
    // but entrance is already marked open
    colony.entrances.push({
      entranceId:   1,
      surfaceTileX: 5,
      surfaceTileY: 0,
      isOpen:       true, // already open
    });

    // Confirm ug tiles are Solid (default)
    expect(ug.data[0 * ug.width + 5]).toBe(UndergroundTileState.Solid);

    checkEntranceCompletion(world);

    // Still open (function skipped already-open entrances)
    expect(colony.entrances[0]!.isOpen).toBe(true);
  });

  it('9. multiple entrances: one opens, other stays closed', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Entrance A at x=3 — shaft fully open
    ugSet(ug, 3, 0, UndergroundTileState.Open);
    ugSet(ug, 3, 1, UndergroundTileState.Open);

    // Entrance B at x=7 — shaft only partially open
    ugSet(ug, 7, 0, UndergroundTileState.Open);
    // (7,1) stays Solid

    colony.entrances.push(
      { entranceId: 1, surfaceTileX: 3, surfaceTileY: 0, isOpen: false },
      { entranceId: 2, surfaceTileX: 7, surfaceTileY: 0, isOpen: false },
    );

    checkEntranceCompletion(world);

    expect(colony.entrances[0]!.isOpen).toBe(true);  // entrance A opened
    expect(colony.entrances[1]!.isOpen).toBe(false); // entrance B still closed
  });
});

// ---------------------------------------------------------------------------
// tickDeadDiggerCleanup (new global function — separate from tickDeathCleanup)
// ---------------------------------------------------------------------------

describe('tickDeadDiggerCleanup', () => {
  it('10. dead ant with BeingDug claimed tile → tile reverts to Marked, digFlowFieldDirty=true, dig fields cleared', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    // Allocate a worker ant and immediately kill it
    const antId = world.nextEntityId;
    world.nextEntityId += 1;
    initAnt(world.ants, antId, { colonyId, posX: 0, posY: 0, task: AntTask.Idle });
    world.ants.alive[antId] = 0; // dead
    world.ants.digTileX[antId] = 4;
    world.ants.digTileY[antId] = 6;
    world.ants.digTicksRemaining[antId] = 10;

    // Set the claimed tile to BeingDug
    ugSet(ug, 4, 6, UndergroundTileState.BeingDug);
    colony.digFlowFieldDirty = false;

    tickDeadDiggerCleanup(world);

    expect(ug.data[6 * ug.width + 4]).toBe(UndergroundTileState.Marked);
    expect(colony.digFlowFieldDirty).toBe(true);
    expect(world.ants.digTileX[antId]).toBe(-1);
    expect(world.ants.digTileY[antId]).toBe(-1);
    expect(world.ants.digTicksRemaining[antId]).toBe(0);
  });

  it('11. dead ant with digTileX=-1 (no claimed tile) → no tile changes', () => {
    const { world, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    const antId = world.nextEntityId;
    world.nextEntityId += 1;
    initAnt(world.ants, antId, { colonyId, posX: 0, posY: 0, task: AntTask.Idle });
    world.ants.alive[antId] = 0; // dead
    // digTileX/digTileY default to -1 from initAnt

    const snapshot = new Uint8Array(ug.data);
    tickDeadDiggerCleanup(world);

    // Grid unchanged
    expect(ug.data).toEqual(snapshot);
  });

  it('12. dead ant whose tile is already Open → no reversion (only reverts BeingDug)', () => {
    const { world, colony, colonyId } = setupWorldWithColonyAndUnderground();
    const ug = world.undergroundGrids[colonyId]!;

    const antId = world.nextEntityId;
    world.nextEntityId += 1;
    initAnt(world.ants, antId, { colonyId, posX: 0, posY: 0, task: AntTask.Idle });
    world.ants.alive[antId] = 0;
    world.ants.digTileX[antId] = 2;
    world.ants.digTileY[antId] = 3;

    // Tile is already Open (excavation completed before death was processed)
    ugSet(ug, 2, 3, UndergroundTileState.Open);
    colony.digFlowFieldDirty = false;

    tickDeadDiggerCleanup(world);

    // Tile should remain Open (not reverted to Marked)
    expect(ug.data[3 * ug.width + 2]).toBe(UndergroundTileState.Open);
    // digFlowFieldDirty not set (no tile was changed)
    expect(colony.digFlowFieldDirty).toBe(false);
    // Dig claim still cleared
    expect(world.ants.digTileX[antId]).toBe(-1);
    expect(world.ants.digTileY[antId]).toBe(-1);
  });

  it('13. tickDeathCleanup(world, colony) signature still per-colony, handles entity list cleanup only', () => {
    const { world, colony } = setupWorldWithColonyAndUnderground();

    const workerId = world.nextEntityId;
    world.nextEntityId += 1;
    initAnt(world.ants, workerId, { colonyId: 1, posX: 0, posY: 0, task: AntTask.Idle });
    colony.workers.push(workerId);
    colony.workerCount += 1;

    // Kill the worker
    world.ants.alive[workerId] = 0;

    // tickDeathCleanup still takes (world, colony) — per-colony signature
    tickDeathCleanup(world, colony);

    expect(colony.workers).toHaveLength(0);
    expect(colony.workerCount).toBe(0);
  });
});
