// foraging — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-foraging.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import {
  antPickupFood,
  antDepositFood,
  routeForagerPriority,
  tickPheromoneDeposit,
  tickAntMovement,
  tickForagerActions,
  tickSearchLeash,
  chooseExcursionDirection,
  tickExcursionBoundary,
} from './ant-system.js';
import { createWorldState, allocateEntityId, SIM_VERSION_V8_LEASH_HYSTERESIS } from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt, RECENT_TILES_LEN } from './ant-store.js';
import { AntTask, ForagingSubState, ChamberType, PheromoneType } from '../enums.js';
import {
  createPheromoneGrid,
  phGet,
  phSet,
  pheromoneGridKey,
} from '../pheromone/pheromone-store.js';
import { Rng } from '../rng.js';
import {
  WORKER_CARRY_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  FOOD_CHAMBER_CAPACITY,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_TRAIL_DEPOSIT,
  FOOD_TRAIL_DEPOSIT_V14,
  PHEROMONE_CAP,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  SEARCH_LEASH_RADII,
  SEARCH_PAUSE_BASE_TICKS,
  SEARCH_PAUSE_JITTER_TICKS,
} from '../constants.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Zone } from '../terrain.js';
import { createDigFlowFields } from '../dig-system.js';
import { createEntranceFlowFields } from '../entrance-flow.js';
import { createChamberFlowFields } from '../chamber-flow.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';
import type { FoodPile } from '../food.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;

const MAX_TEST_ENTITIES = 64;

/**
 * Create a fresh world + colony with a live forager ant.
 * Returns world, colony, and the ant's entity ID.
 */
function setupForagerWorld(
  posX = 5 << FP_SHIFT,
  posY = 4 << FP_SHIFT,
  subTask: number = ForagingSubState.SearchingFood,
): { world: WorldState; colony: ColonyRecord; antId: number } {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  const colony = createColonyRecord(COLONY_ID, 0);
  world.colonies[COLONY_ID] = colony;

  const antId = allocateEntityId(world);
  initAnt(world.ants, antId, {
    colonyId: COLONY_ID,
    posX,
    posY,
    task: AntTask.Foraging,
    subTask,
  });

  return { world, colony, antId };
}

/**
 * Create a surface pheromone grid and register it in world.pheromoneGrids.
 * Returns the grid key and the grid object.
 */
function setupSurfaceGrid(world: WorldState, colonyId = COLONY_ID) {
  const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
  const grid = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
  world.pheromoneGrids[key] = grid;
  return { key, grid };
}

// ---------------------------------------------------------------------------
// antPickupFood
// ---------------------------------------------------------------------------

describe('antPickupFood', () => {
  it('1. normal pickup — transfers FOOD_PICKUP_AMOUNT, drains one charge, transitions to CarryingFood', () => {
    const { world, antId } = setupForagerWorld();
    const pile = { pickupsRemaining: 50 };
    world.ants.foodCarrying[antId] = 0;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(FOOD_PICKUP_AMOUNT); // 512
    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    // Issue #112 — pickup-charge counter drains by FOOD_PILE_PICKUP_DRAIN (=1)
    // independently of the food quantity transferred.
    expect(pile.pickupsRemaining).toBe(49);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('2. capacity-limited — transfers remaining capacity, still drains one charge', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 600; // 424 remaining capacity (WORKER_CARRY_CAPACITY=1024)
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { pickupsRemaining: 50 };

    const transferred = antPickupFood(world.ants, antId, pile);

    const expectedTransfer = WORKER_CARRY_CAPACITY - 600; // 424
    expect(transferred).toBe(expectedTransfer);
    expect(world.ants.foodCarrying[antId]).toBe(WORKER_CARRY_CAPACITY); // full
    expect(pile.pickupsRemaining).toBe(49); // one charge drained
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('3. final-charge pickup — drains pile to zero, full FOOD_PICKUP_AMOUNT still transferred', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 0;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { pickupsRemaining: 1 }; // last charge

    const transferred = antPickupFood(world.ants, antId, pile);

    // Issue #112: charge counter is not a quantity — full FOOD_PICKUP_AMOUNT
    // is transferred even on the final charge. Pile drains to 0; caller is
    // responsible for splicing it.
    expect(transferred).toBe(FOOD_PICKUP_AMOUNT);
    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    expect(pile.pickupsRemaining).toBe(0);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('3a. capacity-full early-return — NO subTask transition (PRD §4c L1097 regression guard)', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = WORKER_CARRY_CAPACITY; // already full
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { pickupsRemaining: 50 };

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(WORKER_CARRY_CAPACITY); // unchanged
    expect(pile.pickupsRemaining).toBe(50); // no drain on zero-transfer
    // Critical: no transition — subTask must NOT be flipped on zero transfer
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('3b. exhausted-pile early-return — NO subTask transition, NO charge drain', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 0;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { pickupsRemaining: 0 }; // already exhausted

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(pile.pickupsRemaining).toBe(0); // no underflow on exhausted pile
    // Critical: subTask must NOT flip on zero-transfer
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

// ---------------------------------------------------------------------------
// antDepositFood
// ---------------------------------------------------------------------------

describe('antDepositFood', () => {
  it('4. normal deposit — adds foodCarrying to colony.foodStored, idle-checkpoint transition', () => {
    const { world, colony, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 500;
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    colony.foodStored = 0;

    antDepositFood(world, colony, antId);

    expect(colony.foodStored).toBe(500);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    // Idle-checkpoint per PRD §4c + §7c as revised by Errata E-01:
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('5. no-op when empty — full no-op, no idle transition (defensive guard per PRD §4c)', () => {
    const { world, colony, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 0;
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    colony.foodStored = 100;

    antDepositFood(world, colony, antId);

    // Full no-op: nothing changes
    expect(colony.foodStored).toBe(100);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging); // NOT flipped to Idle
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood); // NOT cleared
  });

  // 09 backlog memo — food-storage capacity progression
  it('5a. deposit clamps at colonyFoodCapacity — full-cap colony does not gain food, leftover stays on ant', () => {
    const { world, colony, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 512;
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    // No chambers → capacity = BASE. Start at capacity.
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;

    antDepositFood(world, colony, antId);

    // Nothing deposited; all food retained by the ant.
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(world.ants.foodCarrying[antId]).toBe(512);
    // Ant remains in deposit-seeking state for next-tick retry
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('5b. near-full partial deposit — only what fits goes into the pool; leftover stays on ant in Foraging+CarryingFood', () => {
    const { world, colony, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 512; // 2 × FP_ONE
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    // No chambers. capacity = BASE. 10fp of headroom.
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY - 10;

    antDepositFood(world, colony, antId);

    // Exactly 10fp fit; 502fp remain on the ant.
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(world.ants.foodCarrying[antId]).toBe(502);
    // Ant holds its carrying state so step 16b re-routes next tick.
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('5c. ant standing inside FoodStorage footprint → deposit goes to chamber.foodStored, pool untouched', () => {
    // Ant placed at (1,1) — inside the chamber at (0,0) width=3 height=3.
    const { world, colony, antId } = setupForagerWorld(1 << FP_SHIFT, 1 << FP_SHIFT);
    world.ants.foodCarrying[antId] = 512;
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    colony.chambers.push({
      chamberId: 100,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    // Pool is already at BASE; further pool deposits would be impossible. The
    // chamber-authoritative path lets the ant deposit anyway because the
    // chamber has its own bucket.
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;

    antDepositFood(world, colony, antId);

    // Issue #15: chamber gets the deposit; entrance pool is untouched.
    expect(colony.chambers[0]!.foodStored).toBe(512);
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('5d. ant inside FULL FoodStorage chamber → no deposit, leftover stays on ant', () => {
    const { world, colony, antId } = setupForagerWorld(1 << FP_SHIFT, 1 << FP_SHIFT);
    world.ants.foodCarrying[antId] = 512;
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    // Chamber at cap — antDepositFood must skip it (issue #15: full chambers
    // are not deposit targets).
    colony.chambers.push({
      chamberId: 100,
      chamberType: ChamberType.FoodStorage,
      foodStored: FOOD_CHAMBER_CAPACITY,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    // Pool also at cap → no fallback room either.
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;

    antDepositFood(world, colony, antId);

    expect(colony.chambers[0]!.foodStored).toBe(FOOD_CHAMBER_CAPACITY);
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(world.ants.foodCarrying[antId]).toBe(512);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });
});

// ---------------------------------------------------------------------------
// CLNY-06 forage cycle integration test (Phase 6 SC 6)
// ---------------------------------------------------------------------------

describe('CLNY-06 forage cycle — Phase 6 SC 6 integration', () => {
  it('15. full forage cycle: pickup → CarryingFood → pheromone deposits → deposit → idle-checkpoint', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    world.colonies[COLONY_ID] = colony;
    colony.foodStored = 0;

    // Set up ant at a known tile
    const tileX = 10;
    const tileY = 10;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: tileX << FP_SHIFT,
      posY: tileY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });

    // Register surface pheromone grid
    const { grid } = setupSurfaceGrid(world);

    // Synthetic food pile (Phase 6 headless — no FoodPile entity needed)
    const pile = { pickupsRemaining: 50 };

    // --- Tick 0: pickup ---
    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(FOOD_PICKUP_AMOUNT); // 512
    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    // Issue #112 — pickup-charge counter drains by 1 per pickup
    expect(pile.pickupsRemaining).toBe(49);
    // antPickupFood owns the subTask transition per PRD §4c L1103
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);

    // --- Ticks 1..5: pheromone deposits while carrying (Phase 6 SC 3) ---
    for (let t = 0; t < 5; t++) {
      tickPheromoneDeposit(world);
    }

    // Pheromone must have accumulated at the ant's tile
    const pherValue = phGet(grid, tileX, tileY);
    expect(pherValue).toBeGreaterThan(0);
    // 5 deposits of FOOD_TRAIL_DEPOSIT_V14 each (capped at PHEROMONE_CAP)
    const expected5 = FOOD_TRAIL_DEPOSIT_V14 * 5;
    expect(pherValue).toBe(expected5 > PHEROMONE_CAP ? PHEROMONE_CAP : expected5);

    // --- Tick 6: deposit food ---
    antDepositFood(world, colony, antId);

    // Phase 6 SC 6 closure: food transferred to colony pool
    expect(colony.foodStored).toBe(FOOD_PICKUP_AMOUNT); // 512
    expect(world.ants.foodCarrying[antId]).toBe(0);

    // Idle-checkpoint per PRD §4c + §7c as revised by Errata E-01:
    // Plan 10 step 9 will reassign back to Foraging+SearchingFood next tick if
    // allocation still demands forage — but that's Plan 10's dispatcher scope.
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// routeForagerPriority — forager priority routing (SURF-03)
// ---------------------------------------------------------------------------

describe('routeForagerPriority', () => {
  function makePile(id: number, tileX: number, tileY: number): FoodPile {
    return { foodPileId: id, tileX, tileY, pickupsRemaining: 50, pickupsInitial: 50 };
  }

  it('4. colony has no priorityFoodPileId → routeForagerPriority sets targetPosX/Y = -1', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = null;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push(makePile(1, 10, 10));
    world.foodPiles.push(makePile(2, 20, 20));

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.targetPosX[antId] = 99;

    routeForagerPriority(world);

    expect(world.ants.targetPosX[antId]).toBe(-1);
    expect(world.ants.targetPosY[antId]).toBe(-1);
  });

  it("5. colony.priorityFoodPileId set → targetPosX/Y set to that pile's tile position", () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = 1;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push(makePile(1, 15, 20));

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });

    routeForagerPriority(world);

    // Issue #70 — tile-center semantics. Pre-fix used tile-corner; now
    // standardized with all other target writers (FP_ONE/2 offset).
    expect(world.ants.targetPosX[antId]).toBe((15 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antId]).toBe((20 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('6. priority target is exclusive: ant routes to the chosen pile even when a closer pile exists', () => {
    // Exclusive-selection semantics: the player points the colony at a specific
    // pile; proximity does not override that choice. Previously this tested
    // nearest-wins + foodPileId tie-breaking; with the new model neither
    // applies — a single priorityFoodPileId per colony is authoritative.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = 10;
    world.colonies[COLONY_ID] = colony;

    // Ant at (5,5); pile 10 is far (10,5), pile 20 is close (6,5).
    world.foodPiles.push(makePile(10, 10, 5));
    world.foodPiles.push(makePile(20, 6, 5));

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });

    routeForagerPriority(world);

    // Targets pile 10 (player's explicit choice), not the closer pile 20.
    // Issue #70 — tile-center semantics.
    expect(world.ants.targetPosX[antId]).toBe((10 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antId]).toBe((5 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('7. ant not in SearchingFood sub-state → targetPosX/Y unchanged', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = 1;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push(makePile(1, 10, 10));

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.targetPosX[antId] = 77;
    world.ants.targetPosY[antId] = 88;

    routeForagerPriority(world);

    expect(world.ants.targetPosX[antId]).toBe(77);
    expect(world.ants.targetPosY[antId]).toBe(88);
  });

  it("8. cross-colony isolation: colony A's priority pile does NOT redirect colony B's foragers", () => {
    // Regression for the Phase 9 bug where isMarkedPriority lived on the shared
    // FoodPile entity and enemy ants read it too. With per-colony priority, a
    // forager from a colony with no priority keeps targetPosX/Y at -1 even
    // when another colony has pointed its own foragers at a pile.
    const world = createWorldState(42, MAX_TEST_ENTITIES);

    const COLONY_A = 1;
    const COLONY_B = 2;

    const colonyA = createColonyRecord(COLONY_A, 0);
    colonyA.entrances = [];
    colonyA.rallyPoint = null;
    colonyA.digFlowFieldDirty = false;
    colonyA.priorityFoodPileId = 1;
    world.colonies[COLONY_A] = colonyA;

    const colonyB = createColonyRecord(COLONY_B, 0);
    colonyB.entrances = [];
    colonyB.rallyPoint = null;
    colonyB.digFlowFieldDirty = false;
    colonyB.priorityFoodPileId = null;
    world.colonies[COLONY_B] = colonyB;

    world.foodPiles.push(makePile(1, 15, 20));

    const antA = allocateEntityId(world);
    initAnt(world.ants, antA, {
      colonyId: COLONY_A,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    const antB = allocateEntityId(world);
    initAnt(world.ants, antB, {
      colonyId: COLONY_B,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });

    routeForagerPriority(world);

    // A routes to the pile; B is cleared (its colony has no priority).
    // Issue #70 — tile-center semantics on A's target.
    expect(world.ants.targetPosX[antA]).toBe((15 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antA]).toBe((20 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosX[antB]).toBe(-1);
    expect(world.ants.targetPosY[antB]).toBe(-1);
  });

  it('9. stale priorityFoodPileId (pile removed) is treated as null for that tick', () => {
    // If the pile id a colony points at no longer exists in world.foodPiles
    // (e.g. removed by a future depletion/despawn system), the forager falls
    // through to the pheromone gradient rather than chasing a ghost target.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = 999; // no such pile
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push(makePile(1, 10, 10));

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.targetPosX[antId] = 77;

    routeForagerPriority(world);

    expect(world.ants.targetPosX[antId]).toBe(-1);
    expect(world.ants.targetPosY[antId]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// antDepositFood — chamber-authoritative deposit model (issue #15)
//
// chamber.foodStored is authoritative per FoodStorage chamber. An ant standing
// inside a non-full chamber footprint deposits THERE. An ant outside any
// FoodStorage footprint (or with no chambers existing) falls back to the
// entrance-shaft pool `colony.foodStored`. There is no magical pool→chamber
// redistribution — fill requires an actual ant visit.
// ---------------------------------------------------------------------------

describe('antDepositFood — chamber-authoritative deposit (issue #15)', () => {
  function makeFoodStorageChamber(
    id: number,
    stored: number,
    posTileX: number,
    posTileY: number,
  ): ColonyRecord['chambers'][number] {
    return {
      chamberId: id,
      chamberType: ChamberType.FoodStorage,
      foodStored: stored,
      posX: posTileX << FP_SHIFT,
      posY: posTileY << FP_SHIFT,
      width: 4,
      height: 3,
    };
  }

  it('14. ant inside FoodStorage footprint → deposit writes ONLY chamber.foodStored; entrance pool untouched', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    colony.chambers.push(makeFoodStorageChamber(1, 0, 0, 0));
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[antId] = 500;

    antDepositFood(world, colony, antId);

    // Chamber receives all 500; entrance pool untouched.
    expect(colony.chambers[0]!.foodStored).toBe(500);
    expect(colony.foodStored).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    // Chamber not yet full → no flow-field re-seed signal needed.
    expect(colony.foodFlowFieldDirty).toBe(false);
  });

  it('15. colony has no food storage chamber → deposit writes entrance pool up to BASE capacity', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    // No chambers → capacity = BASE_FOOD_STORAGE_CAPACITY (entrance pool only).
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[antId] = 512;

    antDepositFood(world, colony, antId);

    expect(colony.foodStored).toBe(512);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
  });

  it('16. ant in chamber 0 fills it to cap → chamber.foodStored hits FOOD_CHAMBER_CAPACITY and foodFlowFieldDirty fires', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    // Two chambers in different parts of the grid. Ant only stands in chamber[0].
    // chamber[0] starts with 1234 stored, so headroom = 5120-1234 = 3886.
    colony.chambers.push(makeFoodStorageChamber(1, 1234, 0, 0));
    colony.chambers.push(makeFoodStorageChamber(2, 0, 8, 8));
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    // Deposit exactly the headroom of chamber[0] (will fill it to cap).
    world.ants.foodCarrying[antId] = FOOD_CHAMBER_CAPACITY - 1234;

    antDepositFood(world, colony, antId);

    // chamber[0] reaches FOOD_CHAMBER_CAPACITY; chamber[1] is untouched (no ant
    // visit). Issue #15: the OLD bug was redistributing the pool across
    // chambers without a visit — this test guards against regression.
    expect(colony.chambers[0]!.foodStored).toBe(FOOD_CHAMBER_CAPACITY);
    expect(colony.chambers[1]!.foodStored).toBe(0);
    expect(colony.foodStored).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    // Full↔not-full boundary crossed → flow-field must re-seed next tick.
    expect(colony.foodFlowFieldDirty).toBe(true);
  });

  it('17. issue #15 regression — ant outside FoodStorage footprint does NOT cause distant chambers to fill', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    // Two chambers, both far from the ant's tile.
    colony.chambers.push(makeFoodStorageChamber(1, 0, 8, 8));
    colony.chambers.push(makeFoodStorageChamber(2, 0, 16, 8));
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0, // outside both chamber footprints
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[antId] = 1000;

    antDepositFood(world, colony, antId);

    // Distant chambers must NOT receive any food — that's the bug we fixed.
    expect(colony.chambers[0]!.foodStored).toBe(0);
    expect(colony.chambers[1]!.foodStored).toBe(0);
    // Fallback pool gets the deposit.
    expect(colony.foodStored).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// tickForagerActions — Phase 9 playability wiring
// ---------------------------------------------------------------------------

describe('tickForagerActions', () => {
  it('surface SearchingFood ant on a food pile tile → picks up, drains a charge, transitions to CarryingFood', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push({
      foodPileId: 1,
      tileX: 12,
      tileY: 8,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 12 << FP_SHIFT,
      posY: 8 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.zone[antId] = Zone.Surface;
    world.ants.foodCarrying[antId] = 0;

    tickForagerActions(world);

    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
    // Issue #112 — pile drained one charge.
    expect(world.foodPiles[0]!.pickupsRemaining).toBe(49);
  });

  it('issue #112 — final-charge pickup splices pile out and records depletion', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = 1; // mark this pile as priority
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push({
      foodPileId: 1,
      tileX: 12,
      tileY: 8,
      pickupsRemaining: 1,
      pickupsInitial: 1,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 12 << FP_SHIFT,
      posY: 8 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.zone[antId] = Zone.Surface;
    world.ants.foodCarrying[antId] = 0;

    tickForagerActions(world);

    // Ant carried away one full transfer.
    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    // Pile spliced out of the array.
    expect(world.foodPiles.length).toBe(0);
    // Recorded in recentlyDepletedFood with the right tile.
    expect(world.recentlyDepletedFood.length).toBe(1);
    expect(world.recentlyDepletedFood[0]).toMatchObject({ tileX: 12, tileY: 8 });
    // Priority pointer cleared.
    expect(colony.priorityFoodPileId).toBeNull();
  });

  it('surface SearchingFood ant NOT on any food pile tile → no pickup', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push({
      foodPileId: 1,
      tileX: 12,
      tileY: 8,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 3 << FP_SHIFT, // different tile
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.zone[antId] = Zone.Surface;
    world.ants.foodCarrying[antId] = 0;

    tickForagerActions(world);

    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('underground CarryingFood ant on a FoodStorage chamber tile → deposits to chamber.foodStored and flips to Idle', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 0,
      posY: 0,
      width: 4,
      height: 3,
    });
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT, // inside chamber footprint
      posY: 1 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 500;

    tickForagerActions(world);

    // Issue #15: deposit lands in chamber.foodStored, NOT the entrance pool.
    expect(colony.chambers[0]!.foodStored).toBe(500);
    expect(colony.foodStored).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
  });

  it('underground CarryingFood ant at open entrance shaft top (no chamber) → deposits via fallback', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 7, surfaceTileY: 5, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    // No FoodStorage chamber — fallback path.
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 7 << FP_SHIFT,
      posY: 0, // underground top-of-shaft at entrance column
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 300;

    tickForagerActions(world);

    expect(colony.foodStored).toBe(300);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
  });

  it('underground CarryingFood ant NOT at chamber or entrance → no deposit', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 7, surfaceTileY: 5, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 20 << FP_SHIFT, // far from entrance column
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 300;

    tickForagerActions(world);

    expect(colony.foodStored).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(300); // still carrying
    expect(world.ants.task[antId]).toBe(AntTask.Foraging); // not flipped
  });

  it('closed entrance does NOT act as deposit fallback', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 7, surfaceTileY: 5, isOpen: false }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 7 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 300;

    tickForagerActions(world);

    expect(colony.foodStored).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(300);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
  });
});

// ---------------------------------------------------------------------------
// Issue #27 — carrier WaitingToDeposit state.
//
// Coverage:
//   - antDepositFood enters wait when entrance fallback finds the pool full
//     and there's leftover, gated on simVersion >= 3
//   - LEGACY simVersion does NOT enter wait (replay determinism)
//   - tickForagerActions wakes a waiting carrier when any chamber becomes
//     depositable OR the entrance pool drops below cap
//   - tickForagerActions keeps carrier waiting when nothing changed
//   - tickAntMovement skips waiting carriers (zero displacement)
//   - antDepositFood clears wait flag on full deposit
// ---------------------------------------------------------------------------

describe('issue #27 — carrier WaitingToDeposit', () => {
  // Helper: build a world with a single colony, one open entrance, and a single
  // FoodStorage chamber. Caller positions the ant and seeds chamber/pool fills.
  function setupSaturatedColony(): {
    world: WorldState;
    colony: ColonyRecord;
    antId: number;
  } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 7, surfaceTileY: 5, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: FOOD_CHAMBER_CAPACITY, // saturated
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 7 << FP_SHIFT, // entrance column
      posY: 0, // top of shaft underground
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 512;

    // Pool also at cap → fallback also has no headroom.
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;
    return { world, colony, antId };
  }

  it('1. wait entry — entrance fallback with pool at cap sets waitingDeposit=1', () => {
    const { world, colony, antId } = setupSaturatedColony();
    expect(world.ants.waitingDeposit[antId]).toBe(0);

    antDepositFood(world, colony, antId);

    expect(world.ants.waitingDeposit[antId]).toBe(1);
    expect(world.ants.foodCarrying[antId]).toBe(512); // unchanged
    expect(world.ants.task[antId]).toBe(AntTask.Foraging); // not Idle
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
    // searchHeading cleared on entry so a future wake doesn't continue stale routing
    expect(world.ants.searchHeadingX[antId]).toBe(0);
    expect(world.ants.searchHeadingY[antId]).toBe(0);
    expect(world.ants.searchHeadingTicks[antId]).toBe(0);
  });

  it('2. wait hold — saturated colony, no state change → still waiting after tickForagerActions', () => {
    const { world, antId } = setupSaturatedColony();
    world.ants.waitingDeposit[antId] = 1; // pre-existing wait

    tickForagerActions(world);

    expect(world.ants.waitingDeposit[antId]).toBe(1);
  });

  it('3. wake on chamber depositable — drain a chamber below saturation, tickForagerActions wakes', () => {
    const { world, colony, antId } = setupSaturatedColony();
    world.ants.waitingDeposit[antId] = 1;

    // Drain the chamber across the saturation threshold so it becomes depositable.
    // CAPACITY=5120, HYST=512, so depositable ⇔ stored ≤ 4608.
    colony.chambers[0]!.foodStored = 4000;

    tickForagerActions(world);

    expect(world.ants.waitingDeposit[antId]).toBe(0);
  });

  it('4. wake on pool headroom — entrance pool drops below cap, tickForagerActions wakes', () => {
    const { world, colony, antId } = setupSaturatedColony();
    world.ants.waitingDeposit[antId] = 1;

    // Chamber stays saturated; only the entrance pool drains.
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY - 100;

    tickForagerActions(world);

    // Wake fires; antDepositFood at the entrance fallback fits 100 fp.
    // Issue #42 fix: at v6 the partial-deposit branch re-enters wait
    // because the chamber is still saturated and there's leftover carry
    // (412 fp) — so on v6 the ant ends the tick BACK in wait. On v5 the
    // ant ends the tick out-of-wait. The pool drain + carry-down assertions
    // hold under both versions.
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(world.ants.foodCarrying[antId]).toBe(412);
    if (world.simVersion >= 6) {
      expect(world.ants.waitingDeposit[antId]).toBe(1); // re-enters wait on partial fill
    } else {
      expect(world.ants.waitingDeposit[antId]).toBe(0);
    }
  });

  it('5. movement skip — tickAntMovement does NOT change posX/posY for a waiting ant', () => {
    const { world, antId } = setupSaturatedColony();
    world.ants.waitingDeposit[antId] = 1;
    const startX = world.ants.posX[antId]!;
    const startY = world.ants.posY[antId]!;

    const rng = new Rng(0);
    const digFlowFields = createDigFlowFields();
    const entranceFlowFields = createEntranceFlowFields();
    const chamberFlowFields = createChamberFlowFields();
    tickAntMovement(world, rng, digFlowFields, entranceFlowFields, chamberFlowFields);

    expect(world.ants.posX[antId]).toBe(startX);
    expect(world.ants.posY[antId]).toBe(startY);
  });

  it('6. full deposit clears wait flag (defense in depth — wait should never coexist with Idle)', () => {
    const { world, colony, antId } = setupSaturatedColony();
    // Pre-seed wait (synthetic — antDepositFood won't both enter and exit
    // wait in the same call, but if a slot is reused the flag must zero).
    world.ants.waitingDeposit[antId] = 1;
    // Make the chamber depositable so antDepositFood succeeds.
    colony.chambers[0]!.foodStored = 0;
    // Move ant into chamber footprint so chamber path is taken.
    world.ants.posX[antId] = 1 << FP_SHIFT;
    world.ants.posY[antId] = 1 << FP_SHIFT;

    antDepositFood(world, colony, antId);

    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.waitingDeposit[antId]).toBe(0);
  });

  it('7a. stale-flag self-clear — tickAntMovement clears waitingDeposit when ant is no longer Foraging+CarryingFood underground (defense in depth)', () => {
    const { world, antId } = setupSaturatedColony();
    world.ants.waitingDeposit[antId] = 1;
    // Mutate the ant out of the wait-eligible state without going through
    // antDepositFood. Simulates a future code path that flips task/subTask
    // on a CarryingFood ant; the wake-check inside tickForagerActions
    // would never fire because the carrier branch is gated on subTask.
    world.ants.task[antId] = AntTask.Idle;
    world.ants.subTask[antId] = 0;

    const rng = new Rng(0);
    const digFlowFields = createDigFlowFields();
    const entranceFlowFields = createEntranceFlowFields();
    const chamberFlowFields = createChamberFlowFields();
    tickAntMovement(world, rng, digFlowFields, entranceFlowFields, chamberFlowFields);

    // Stale flag detected and zeroed; the ant is free to move per its
    // current state on subsequent ticks.
    expect(world.ants.waitingDeposit[antId]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chooseExcursionDirection — 09 excursion-foraging memo correlated outward walk
// ---------------------------------------------------------------------------

describe('chooseExcursionDirection', () => {
  function setupWorldWithEntrance(
    entranceTileX: number,
    entranceTileY: number,
    antTileX: number,
    antTileY: number,
  ): { world: WorldState; antId: number } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      {
        entranceId: 1,
        surfaceTileX: entranceTileX,
        surfaceTileY: entranceTileY,
        isOpen: true,
      },
    ];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: antTileX << FP_SHIFT,
      posY: antTileY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    return { world, antId };
  }

  it('always returns a non-zero cardinal direction (never stationary)', () => {
    // Across many RNG seeds and ant positions, excursion never returns (0,0).
    const { world, antId } = setupWorldWithEntrance(24, 64, 30, 70);
    for (let seed = 0; seed < 200; seed++) {
      // Reset heading so each seed starts from scratch.
      world.ants.searchHeadingX[antId] = 0;
      world.ants.searchHeadingY[antId] = 0;
      world.ants.searchHeadingTicks[antId] = 0;
      const rng = new Rng(seed);
      const dir = chooseExcursionDirection(world, antId, rng);
      expect(Math.abs(dir.dx) + Math.abs(dir.dy)).toBe(1);
    }
  });

  it('same seed + same world produces same direction (determinism)', () => {
    const { world: w1, antId: a1 } = setupWorldWithEntrance(24, 64, 30, 70);
    const { world: w2, antId: a2 } = setupWorldWithEntrance(24, 64, 30, 70);
    for (let seed = 0; seed < 50; seed++) {
      w1.ants.searchHeadingX[a1] = 0;
      w1.ants.searchHeadingY[a1] = 0;
      w1.ants.searchHeadingTicks[a1] = 0;
      w2.ants.searchHeadingX[a2] = 0;
      w2.ants.searchHeadingY[a2] = 0;
      w2.ants.searchHeadingTicks[a2] = 0;
      const d1 = chooseExcursionDirection(w1, a1, new Rng(seed));
      const d2 = chooseExcursionDirection(w2, a2, new Rng(seed));
      expect(d1).toEqual(d2);
    }
  });

  it('picks an outward-biased initial heading from nearest entrance', () => {
    // Ant 4 tiles east of the entrance (24,64). outX=4, outY=0 → initial
    // heading east (+1, 0). Repeated with resets across seeds — the initial
    // direction is deterministic regardless of RNG.
    const { world, antId } = setupWorldWithEntrance(24, 64, 28, 64);
    for (let seed = 0; seed < 20; seed++) {
      world.ants.searchHeadingX[antId] = 0;
      world.ants.searchHeadingY[antId] = 0;
      world.ants.searchHeadingTicks[antId] = 0;
      const dir = chooseExcursionDirection(world, antId, new Rng(seed));
      expect(dir.dx).toBe(1);
      expect(dir.dy).toBe(0);
    }
  });

  it('persists heading across calls while ticks > 0 (correlated walk)', () => {
    // After initialization, heading should persist for EXCURSION_HEADING_MIN_TICKS
    // + jitter calls without rolling a turn. Consecutive calls with the same ant
    // produce the same direction until the ticks counter expires.
    const { world, antId } = setupWorldWithEntrance(24, 64, 28, 64);
    const rng = new Rng(7);
    const first = chooseExcursionDirection(world, antId, rng);
    // Next several calls should share the same heading (turn counter decrements).
    for (let i = 0; i < 4; i++) {
      const next = chooseExcursionDirection(world, antId, rng);
      expect(next).toEqual(first);
    }
  });

  it('at entrance tile with no outward vector — antId parity picks cardinal', () => {
    // Ant positioned exactly on the entrance — outward vector is (0,0), so the
    // initial heading falls back to the antId-parity switch. Headings are in
    // {(+1,0),(-1,0),(0,+1),(0,-1)} based on (antId & 3).
    const { world, antId } = setupWorldWithEntrance(24, 64, 24, 64);
    const dir = chooseExcursionDirection(world, antId, new Rng(13));
    expect(Math.abs(dir.dx) + Math.abs(dir.dy)).toBe(1);
  });

  it('no entrances → still returns non-zero cardinal (degenerate fallback)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 40 << FP_SHIFT,
      posY: 40 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    for (let seed = 0; seed < 50; seed++) {
      world.ants.searchHeadingX[antId] = 0;
      world.ants.searchHeadingY[antId] = 0;
      world.ants.searchHeadingTicks[antId] = 0;
      const dir = chooseExcursionDirection(world, antId, new Rng(seed));
      expect(Math.abs(dir.dx) + Math.abs(dir.dy)).toBe(1);
    }
  });

  it('world-edge bounce — heading rotates rather than stepping off-grid', () => {
    // Ant at the west edge (tileX=0), heading (-1, 0) would step off-grid.
    // The bounce loop rotates 90° right until a valid cardinal is found, so
    // the result must have dx >= 0 (no off-grid step).
    const { world, antId } = setupWorldWithEntrance(24, 64, 0, 64);
    // Manually seed a westward heading with active ticks so the bounce path
    // (rather than the initial-outward path) is exercised.
    world.ants.searchHeadingX[antId] = -1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 10;
    const dir = chooseExcursionDirection(world, antId, new Rng(1));
    expect(dir.dx).toBeGreaterThanOrEqual(0);
    // After bounce, heading is a valid on-grid cardinal.
    expect(Math.abs(dir.dx) + Math.abs(dir.dy)).toBe(1);
  });

  // Issue #83 — uniform-RNG-consumption contract. The function pulls
  // exactly 3 RNG values up-front regardless of branch, to keep the
  // post-call rng stream identical across all branches. If a future
  // PR adds a 4th rng.nextInt inside a conditional branch, this test
  // (combined with the seed-determinism test above) catches the drift.
  it('advances RNG by exactly 3 nextU32 calls regardless of branch (#83)', () => {
    // Each nextInt call invokes nextU32 exactly once (rng.ts:27-29).
    // We verify the post-call state matches a fresh Rng advanced 3x.
    const expectedAfter3 = (seed: number): number => {
      const r = new Rng(seed);
      r.nextU32();
      r.nextU32();
      r.nextU32();
      return r.getState();
    };

    // Walk the matrix of branches:
    //   - initial-heading branch (hx===0 && hy===0)
    //   - active-heading branch with hx,hy outward
    //   - active-heading branch with hx,hy inward (bounce path)
    //   - ant inside grid bounds vs. near edge
    const seedsToProbe = [0, 1, 7, 42, 1000, 999_999];
    const cases: Array<() => { world: WorldState; antId: number }> = [
      // Initial-heading branch
      () => setupWorldWithEntrance(24, 64, 30, 70),
      // Active-outward heading
      () => {
        const r = setupWorldWithEntrance(24, 64, 30, 70);
        r.world.ants.searchHeadingX[r.antId] = 1;
        r.world.ants.searchHeadingY[r.antId] = 0;
        r.world.ants.searchHeadingTicks[r.antId] = 5;
        return r;
      },
      // Active-inward (bounce) heading
      () => {
        const r = setupWorldWithEntrance(24, 64, 30, 70);
        r.world.ants.searchHeadingX[r.antId] = -1;
        r.world.ants.searchHeadingY[r.antId] = 0;
        r.world.ants.searchHeadingTicks[r.antId] = 10;
        return r;
      },
      // Edge of grid (forces axis-clamp branches in the bounce/refresh path)
      () => setupWorldWithEntrance(24, 64, 1, 1),
    ];

    for (const seed of seedsToProbe) {
      for (const buildCase of cases) {
        const { world, antId } = buildCase();
        const rng = new Rng(seed);
        chooseExcursionDirection(world, antId, rng);
        expect(rng.getState()).toBe(expectedAfter3(seed));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tickExcursionBoundary — 09 excursion-foraging memo
// ---------------------------------------------------------------------------

describe('tickExcursionBoundary', () => {
  function setupExcursionWorld(
    antTileX: number,
    antTileY: number,
    entranceX = 0,
    entranceY = 0,
    wave = 0,
  ): { world: WorldState; colony: ColonyRecord; antId: number } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      {
        entranceId: allocateEntityId(world),
        surfaceTileX: entranceX,
        surfaceTileY: entranceY,
        isOpen: true,
      },
    ];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: antTileX << FP_SHIFT,
      posY: antTileY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.searchWave[antId] = wave;
    return { world, colony, antId };
  }

  it('within base radius → no transition, heading preserved', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupExcursionWorld(base, 0);
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
    expect(world.ants.searchHeadingX[antId]).toBe(1);
    expect(world.ants.searchHeadingTicks[antId]).toBe(5);
  });

  it('past base radius → flips to ReturningToNest, heading cleared', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupExcursionWorld(base + 1, 0);
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
    expect(world.ants.searchHeadingX[antId]).toBe(0);
    expect(world.ants.searchHeadingY[antId]).toBe(0);
    expect(world.ants.searchHeadingTicks[antId]).toBe(0);
  });

  it('wave counter is NOT incremented here — only on entrance arrival', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupExcursionWorld(base + 5, 0, 0, 0, 1);
    tickExcursionBoundary(world);
    // Still wave=1 — tickAntMovement is responsible for the bump.
    expect(world.ants.searchWave[antId]).toBe(1);
  });

  it('leaves CarryingFood ants alone', () => {
    const { world, antId } = setupExcursionWorld(100, 0);
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('leaves underground SearchingFood ants alone (surface-only boundary)', () => {
    const { world, antId } = setupExcursionWorld(100, 0);
    world.ants.zone[antId] = Zone.Underground;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('skips colonies with no entrances (no reference point)', () => {
    const { world, antId } = setupExcursionWorld(100, 0);
    world.colonies[COLONY_ID]!.entrances = [];
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('uses higher-wave radius when searchWave > 0', () => {
    const wave1 = SEARCH_LEASH_RADII[1]!;
    const { world, antId } = setupExcursionWorld(wave1, 0, 0, 0, 1);
    tickExcursionBoundary(world);
    // Exactly on wave-1 boundary — still within.
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

// ---------------------------------------------------------------------------
// tickExcursionBoundary — 09 excursion-foraging follow-up (issue 1)
//
// Regression coverage for the "boundary override" bug: a SearchingFood ant
// past its wave radius must NOT flip to ReturningToNest while a higher-
// priority signal (priority target / food scent / pheromone trail) is
// present, and a ReturningToNest ant that picks up such a signal en route
// home must flip BACK to SearchingFood rather than complete the return leg.
// ---------------------------------------------------------------------------

describe('tickExcursionBoundary — priority-aware (09 follow-up issue 1)', () => {
  function baseSetup(antTileX: number, antTileY: number, wave = 0) {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      {
        entranceId: allocateEntityId(world),
        surfaceTileX: 0,
        surfaceTileY: 0,
        isOpen: true,
      },
    ];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: antTileX << FP_SHIFT,
      posY: antTileY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.searchWave[antId] = wave;
    return { world, colony, antId };
  }

  it('past radius + priority food pile set → stays SearchingFood (signal beats boundary)', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, colony, antId } = baseSetup(base + 2, 0);
    // Mark a priority pile; pile exists in foodPiles so colonyHasPriorityPile resolves true.
    const pile = {
      foodPileId: 1,
      tileX: base + 20,
      tileY: 0,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    } as FoodPile;
    world.foodPiles.push(pile);
    colony.priorityFoodPileId = pile.foodPileId;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + nearby food pile (scent) → stays SearchingFood', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = baseSetup(base + 2, 0);
    // Pile within FOOD_SCENT_RADIUS (=15) of the ant — scent lookup returns non-null.
    world.foodPiles.push({
      foodPileId: 1,
      tileX: base + 5,
      tileY: 0,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    });
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + nearby pheromone trail → stays SearchingFood', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = baseSetup(base + 2, 0);
    const { grid } = setupSurfaceGrid(world);
    // Put pheromone 2 tiles from the ant (inside SIGNAL_PHEROMONE_RADIUS=3).
    phSet(grid, base + 2, 2, FOOD_TRAIL_DEPOSIT);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + no signal → flips to ReturningToNest (baseline still works)', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = baseSetup(base + 2, 0);
    // No priority, no piles, no grid → hasSignal === false.
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('ReturningToNest + priority food pile set → flips back to SearchingFood', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    // Place the ant well inside `radius - LEASH_HYSTERESIS_TILES` so the v8
    // breakout-deadband (issue #44 UAT round 3) doesn't suppress this flip.
    // Distance-from-entrance is 5, which is comfortably below the wave-0
    // hysteresis threshold (25 - 5 = 20).
    const { world, colony, antId } = baseSetup(5, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const pile = {
      foodPileId: 1,
      tileX: base + 20,
      tileY: 0,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    } as FoodPile;
    world.foodPiles.push(pile);
    colony.priorityFoodPileId = pile.foodPileId;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
    expect(world.ants.searchHeadingX[antId]).toBe(0);
    expect(world.ants.searchHeadingY[antId]).toBe(0);
    expect(world.ants.searchHeadingTicks[antId]).toBe(0);
  });

  it('ReturningToNest + nearby scent pile → flips back to SearchingFood', () => {
    const { world, antId } = baseSetup(10, 10);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    world.foodPiles.push({
      foodPileId: 1,
      tileX: 12,
      tileY: 10,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    });
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('ReturningToNest + nearby pheromone → flips back to SearchingFood', () => {
    const { world, antId } = baseSetup(10, 10);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const { grid } = setupSurfaceGrid(world);
    phSet(grid, 11, 10, FOOD_TRAIL_DEPOSIT);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('ReturningToNest + no signal → stays ReturningToNest (boundary pass leaves it alone)', () => {
    const { world, antId } = baseSetup(10, 10);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    // No signals anywhere — the return leg continues.
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  // -------------------------------------------------------------------------
  // v8 leash-boundary hysteresis (#44 UAT round 3)
  //
  // Pre-v8 the RTN→SF breakout was symmetric with the SF→RTN flip's
  // `dist > radius` gate, producing a per-tick flip-flop for ants parked
  // just past the radius next to a steady pheromone trail (each flip
  // wiped recent-tiles, so the no-revisit memory never accumulated and
  // the ant cycled in a tiny region forever — observed in seed
  // 1806015051 tick 5863, ant 24).
  //
  // v8 requires `dist <= radius - LEASH_HYSTERESIS_TILES` for the
  // breakout in addition to a food signal; pre-v8 keeps the original
  // signal-only behaviour for byte-identical replay.
  // -------------------------------------------------------------------------
  it('v8 — RTN ant just past radius with pheromone signal STAYS RTN (hysteresis suppresses flip)', () => {
    const base = SEARCH_LEASH_RADII[0]!; // 25
    // Distance 27 from entrance — past `radius` (25) so outside the
    // hysteresis deadband (radius - 5 = 20). Pheromone right next door.
    const { world, antId } = baseSetup(base + 2, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const { grid } = setupSurfaceGrid(world);
    phSet(grid, base + 2, 2, FOOD_TRAIL_DEPOSIT);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V8_LEASH_HYSTERESIS);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('v8 — RTN ant just inside hysteresis radius with pheromone signal FLIPS to SF', () => {
    const base = SEARCH_LEASH_RADII[0]!; // 25
    // Distance 19 from entrance — inside `radius - 5 = 20`. Hysteresis
    // permits the breakout once the ant has actually returned closer.
    const { world, antId } = baseSetup(base - 6, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const { grid } = setupSurfaceGrid(world);
    phSet(grid, base - 6, 2, FOOD_TRAIL_DEPOSIT);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('v8 — RTN ant exactly at hysteresis threshold (dist == radius - hysteresis) FLIPS (boundary inclusive)', () => {
    // Pins the strict `>` comparison: condition `bestDist > radius -
    // LEASH_HYSTERESIS_TILES` is FALSE at exact equality, so the
    // breakout fires. A future refactor changing `>` to `>=` would
    // shift the deadband by one tile and trip this test.
    const base = SEARCH_LEASH_RADII[0]!;
    const threshold = base - 5; // 25 - 5 = 20 — wave-0 hysteresis edge
    const { world, antId } = baseSetup(threshold, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const { grid } = setupSurfaceGrid(world);
    phSet(grid, threshold, 2, FOOD_TRAIL_DEPOSIT);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('v8 — RTN ant one tile past hysteresis threshold STAYS RTN (boundary exclusive on the past-side)', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const justOver = base - 5 + 1; // 21
    const { world, antId } = baseSetup(justOver, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const { grid } = setupSurfaceGrid(world);
    phSet(grid, justOver, 2, FOOD_TRAIL_DEPOSIT);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('v8 — hysteresis scales with searchWave (wave 2: radius 55, deadband 50)', () => {
    // Non-default wave coverage. Wave-2 radius is 55, so the deadband
    // sits at 50. A RTN ant at distance 52 is outside the wave-2
    // deadband (50) — and far outside the wave-0 deadband (20) — so
    // the breakout must stay suppressed. Confirms the gate uses the
    // ant's actual searchWave, not a hard-coded wave-0 threshold.
    const wave2Radius = SEARCH_LEASH_RADII[2]!; // 55
    const wave2Threshold = wave2Radius - 5; // 50
    const justPast = wave2Threshold + 2; // 52
    const { world, antId } = baseSetup(justPast, 0, /*wave=*/ 2);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const { grid } = setupSurfaceGrid(world);
    phSet(grid, justPast, 2, FOOD_TRAIL_DEPOSIT);
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('v8 — priority pile bypasses the deadband (player intent always wins)', () => {
    // MEDIUM-1: explicit player commands (priorityFoodPileId) must not
    // be suppressed by the leash deadband. An ant well past the wave-0
    // hysteresis threshold (deadband 20, ant at 27) with a priority
    // pile set should still flip back to SearchingFood.
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, colony, antId } = baseSetup(base + 2, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const pile = {
      foodPileId: 1,
      tileX: base + 20,
      tileY: 0,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    } as FoodPile;
    world.foodPiles.push(pile);
    colony.priorityFoodPileId = pile.foodPileId;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

// ---------------------------------------------------------------------------
// tickExcursionBoundary — stale-trap leash recovery (09 follow-up issue 2)
//
// Companion regression for the "prev tile trap": far from the nest, the only
// pheromone within SIGNAL_PHEROMONE_RADIUS is the ant's own just-left trail.
// hasNearbyPheromoneSignal must treat that as "no signal" so the leash can
// demote the ant and send it home, instead of leaving it stuck in a two-tile
// stutter forever. The previous describe block covers the entrance-mouth
// variant of this bug; this block covers the away-from-nest variant.
// ---------------------------------------------------------------------------
describe('tickExcursionBoundary — stale-trap recovery (09 follow-up issue 2)', () => {
  function awayFromNestSetup(antTileX: number, antTileY: number) {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      {
        entranceId: allocateEntityId(world),
        surfaceTileX: 0,
        surfaceTileY: 0,
        isOpen: true,
      },
    ];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    const { grid } = setupSurfaceGrid(world);

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: antTileX << FP_SHIFT,
      posY: antTileY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    return { world, colony, grid, antId };
  }

  it('past radius + pheromone ONLY on prev tile → flips to ReturningToNest', () => {
    // Reproduces the seed-29 tick-270-ish stutter: an ant far from the nest
    // with its own just-vacated trail as the only "signal" nearby. Prev-skip
    // in hasNearbyPheromoneSignal makes the leash fire instead of pinning.
    const base = SEARCH_LEASH_RADII[0]!; // 25
    const antTileX = base + 2;
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    // Prev is the tile the ant just left (one step west).
    world.ants.searchPrevTileX[antId] = antTileX - 1;
    world.ants.searchPrevTileY[antId] = antTileY;
    // The prev tile carries a strong ghost of the ant's own trail; nothing
    // else is in range — this is the exact trap condition.
    phSet(grid, antTileX - 1, antTileY, PHEROMONE_CAP);

    tickExcursionBoundary(world);

    // With prev-skip the scan finds nothing → leash fires → ReturningToNest.
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
    // Heading/prev reset so the return leg starts clean.
    expect(world.ants.searchPrevTileX[antId]).toBe(-1);
    expect(world.ants.searchPrevTileY[antId]).toBe(-1);
  });

  it('past radius + pheromone on a non-prev neighbour → stays SearchingFood', () => {
    // Sanity check: a genuine trail (a cell the ant has NOT just left) still
    // counts as signal and keeps the ant searching. Only prev is filtered.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2;
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    world.ants.searchPrevTileX[antId] = antTileX - 1;
    world.ants.searchPrevTileY[antId] = antTileY;
    // Pheromone on the OPPOSITE side of the ant from prev.
    phSet(grid, antTileX + 1, antTileY, PHEROMONE_CAP);

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + pheromone on BOTH prev and a non-prev neighbour → still SearchingFood', () => {
    // Mixed case: prev is a trap cell, but there's also a real signal a few
    // tiles away. The non-prev cell alone is enough to keep the ant out.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2;
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    world.ants.searchPrevTileX[antId] = antTileX - 1;
    world.ants.searchPrevTileY[antId] = antTileY;
    phSet(grid, antTileX - 1, antTileY, PHEROMONE_CAP); // prev: ignored
    phSet(grid, antTileX, antTileY + 2, FOOD_TRAIL_DEPOSIT); // real signal

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + no prev hint (-1,-1) + pheromone anywhere → stays SearchingFood (baseline)', () => {
    // Backward-compat: a freshly promoted ant has no prev tile and must treat
    // any nonzero cell as signal. This check fails if prev-skip accidentally
    // runs when sentinels are present.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2;
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    expect(world.ants.searchPrevTileX[antId]).toBe(-1);
    expect(world.ants.searchPrevTileY[antId]).toBe(-1);
    phSet(grid, antTileX - 1, antTileY, PHEROMONE_CAP);

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + pheromone on a prev-side REACQUIRE candidate (dist=2) → flips to ReturningToNest', () => {
    // Codex review follow-up: hasNearbyPheromoneSignal must align with
    // sampleForagingDirection's candidate rules. Ant at (27,0), prev (26,0).
    // A cell at (25,0) is dist=2 inside the diamond — exact-coord check
    // doesn't catch it, but its major-axis step from (27,0) is -X which
    // lands on prev. The sampler rejects it and returns {0,0}; the leash
    // check must rule it out too, or the ant never flips home.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2; // 27
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    world.ants.searchPrevTileX[antId] = antTileX - 1; // 26
    world.ants.searchPrevTileY[antId] = antTileY;
    // Pheromone ONLY on the prev-side reacquire path, two tiles back.
    phSet(grid, antTileX - 2, antTileY, PHEROMONE_CAP); // 25

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('past radius + pheromone on a prev-side REACQUIRE candidate (dist=3) → flips to ReturningToNest', () => {
    // Same path, farther out. Cell at (24,0) is dist=3 from (27,0), the
    // outer edge of SIGNAL_PHEROMONE_RADIUS. Major-axis step is still -X,
    // still lands on prev (26,0). Sampler rejects → leash must fire.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2; // 27
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    world.ants.searchPrevTileX[antId] = antTileX - 1; // 26
    world.ants.searchPrevTileY[antId] = antTileY;
    phSet(grid, antTileX - 3, antTileY, PHEROMONE_CAP); // 24

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });

  it('past radius + pheromone on a LATERAL cell off the prev-side step path → stays SearchingFood', () => {
    // Guard against over-filtering. Cell at (26,2): dx=-1, dy=2, absY>absX
    // so major-axis step is +Y → target (27,1), NOT prev. Sampler would
    // accept this candidate, so the leash check must accept it too.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2; // 27
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    world.ants.searchPrevTileX[antId] = antTileX - 1;
    world.ants.searchPrevTileY[antId] = antTileY;
    phSet(grid, antTileX - 1, antTileY + 2, FOOD_TRAIL_DEPOSIT);

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + pheromone on every prev-side candidate (dist=1..3) → flips to ReturningToNest', () => {
    // Full trap: a trail of pheromone leading back toward the nest along the
    // prev axis. All three cells (prev, dist=2, dist=3) are candidates the
    // sampler will reject; none should keep the ant on SearchingFood.
    const base = SEARCH_LEASH_RADII[0]!;
    const antTileX = base + 2; // 27
    const antTileY = 0;
    const { world, grid, antId } = awayFromNestSetup(antTileX, antTileY);
    world.ants.searchPrevTileX[antId] = antTileX - 1;
    world.ants.searchPrevTileY[antId] = antTileY;
    phSet(grid, antTileX - 1, antTileY, PHEROMONE_CAP); // prev (dist=1)
    phSet(grid, antTileX - 2, antTileY, PHEROMONE_CAP); // dist=2, stepX hits prev
    phSet(grid, antTileX - 3, antTileY, PHEROMONE_CAP); // dist=3, stepX hits prev

    tickExcursionBoundary(world);

    expect(world.ants.subTask[antId]).toBe(ForagingSubState.ReturningToNest);
  });
});

// ---------------------------------------------------------------------------
// Issue #35 — pause-while-searching
// ---------------------------------------------------------------------------

describe('SearchingFood pause cadence (issue #35)', () => {
  function setupSurfaceForager(): {
    world: ReturnType<typeof createWorldState>;
    antId: number;
    posX: number;
    posY: number;
  } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 24, surfaceTileY: 64, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    setupSurfaceGrid(world);

    const antId = allocateEntityId(world);
    const posX = 30 << FP_SHIFT;
    const posY = 64 << FP_SHIFT;
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX,
      posY,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.targetPosX[antId] = -1;
    world.ants.targetPosY[antId] = -1;
    return { world, antId, posX, posY };
  }

  it('a paused ant (searchPauseTicks > 0) does not move and decrements its counter', () => {
    const { world, antId, posX, posY } = setupSurfaceForager();
    world.ants.searchPauseTicks[antId] = 7;

    const rng = new Rng(0);
    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, rng, digFlowFields);

    // Position unchanged; counter decremented.
    expect(world.ants.posX[antId]).toBe(posX);
    expect(world.ants.posY[antId]).toBe(posY);
    expect(world.ants.searchPauseTicks[antId]).toBe(6);
  });

  it('a paused ant resumes movement once the counter hits 0', () => {
    const { world, antId, posX, posY } = setupSurfaceForager();
    world.ants.searchPauseTicks[antId] = 1;

    const digFlowFields = createDigFlowFields();
    // Tick 1: counter goes 1 → 0 and movement is skipped (the decrement
    // path uses `continue`).
    tickAntMovement(world, new Rng(0), digFlowFields);
    expect(world.ants.searchPauseTicks[antId]).toBe(0);
    expect(world.ants.posX[antId]).toBe(posX);
    expect(world.ants.posY[antId]).toBe(posY);
    // Tick 2: counter is 0; the trigger MAY fire (1/50 chance) but most
    // seeds will fall through to wander. Sweep many seeds and confirm at
    // least one moved.
    let movedAfterResume = 0;
    for (let s = 0; s < 30; s++) {
      world.ants.posX[antId] = posX;
      world.ants.posY[antId] = posY;
      world.ants.searchPauseTicks[antId] = 0;
      tickAntMovement(world, new Rng(100 + s), digFlowFields);
      if (world.ants.posX[antId] !== posX || world.ants.posY[antId] !== posY) {
        movedAfterResume += 1;
      }
    }
    expect(movedAfterResume).toBeGreaterThan(20);
  });

  it('CarryingFood ants do NOT pause (pause gate is SearchingFood-only)', () => {
    const { world, antId } = setupSurfaceForager();
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    world.ants.searchPauseTicks[antId] = 0;

    const digFlowFields = createDigFlowFields();
    // Sweep seeds — none should set searchPauseTicks for a CarryingFood ant.
    for (let s = 0; s < 30; s++) {
      world.ants.searchPauseTicks[antId] = 0;
      tickAntMovement(world, new Rng(s), digFlowFields);
      expect(world.ants.searchPauseTicks[antId]).toBe(0);
    }
  });

  it('pickup clears any active pause (transition out of SearchingFood)', () => {
    const { world, antId } = setupSurfaceForager();
    world.ants.searchPauseTicks[antId] = 8;
    world.ants.foodCarrying[antId] = 0;
    // Synthetic pickup — antPickupFood should clear the pause counter.
    antPickupFood(world.ants, antId, { pickupsRemaining: 50 });
    expect(world.ants.searchPauseTicks[antId]).toBe(0);
  });

  it('post-deposit clears any active pause', () => {
    const { world, antId } = setupSurfaceForager();
    world.ants.searchPauseTicks[antId] = 8;
    world.ants.foodCarrying[antId] = 200;
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    const colony = world.colonies[COLONY_ID]!;
    colony.foodStored = 0;
    antDepositFood(world, colony, antId);
    expect(world.ants.searchPauseTicks[antId]).toBe(0);
  });

  it('pause length matches documented 5-9 tick range (codex P2 — no off-by-one)', () => {
    // Pre-fix: arming `searchPauseTicks = base + jitter` and continuing
    // immediately made the trigger tick count as paused too, inflating the
    // total to base + jitter + 1 (6-10 ticks instead of 5-9). The fix
    // arms at base + jitter - 1 so the trigger tick + N decrements sum
    // to exactly base + jitter total stationary ticks.
    //
    // Direct inspection: when the trigger fires (before = 0, after > 0),
    // total paused-tick count for that cycle equals after + 1 (this
    // trigger tick is already stationary). Sweep seeds until at least
    // one trigger fires, capture the after-trigger value, assert the
    // implied total is in [5, 9].
    const digFlowFields = createDigFlowFields();
    const observedTotalPauses = new Set<number>();
    for (let seed = 0; seed < 500; seed++) {
      const { world, antId } = setupSurfaceForager();
      const before = world.ants.searchPauseTicks[antId]!;
      tickAntMovement(world, new Rng(seed), digFlowFields);
      const after = world.ants.searchPauseTicks[antId]!;
      if (before === 0 && after > 0) {
        observedTotalPauses.add(after + 1);
      }
    }
    expect(observedTotalPauses.size).toBeGreaterThan(0);
    for (const totalPause of observedTotalPauses) {
      expect(totalPause).toBeGreaterThanOrEqual(SEARCH_PAUSE_BASE_TICKS);
      expect(totalPause).toBeLessThanOrEqual(
        SEARCH_PAUSE_BASE_TICKS + SEARCH_PAUSE_JITTER_TICKS - 1,
      );
    }
  });

  it('throughput regression guard — pause does not stop the colony from moving on average', () => {
    // Acceptance criterion: throughput within ±15% of pre-pause baseline.
    // We can't easily simulate "baseline minus pause feature" inside one
    // test, but we CAN assert that across many seeds, the ratio of paused
    // ticks to total ticks lands roughly at the design target (~12%).
    const digFlowFields = createDigFlowFields();
    let pausedTickCount = 0;
    const totalTicks = 200;
    const { world, antId, posX, posY } = setupSurfaceForager();
    for (let t = 0; t < totalTicks; t++) {
      world.ants.posX[antId] = posX;
      world.ants.posY[antId] = posY;
      const before = world.ants.searchPauseTicks[antId]!;
      tickAntMovement(world, new Rng(t * 17 + 11), digFlowFields);
      // Counts ticks where the ant was paused (didn't move because of #35).
      const after = world.ants.searchPauseTicks[antId]!;
      if (
        after > 0 ||
        (before === 0 && world.ants.posX[antId] === posX && world.ants.posY[antId] === posY)
      ) {
        pausedTickCount += 1;
      }
    }
    // Generous bound — the design target is ~12% paused (≈ 24 paused
    // ticks out of 200) but there's variance across seeds. Anything
    // under 30% (60/200) is consistent with the feature working and
    // not overwhelming throughput.
    expect(pausedTickCount).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// Issue #42 — early-game-pool fixes (v6)
//
// Three sub-fixes share a single repro shape: an early colony with no
// FoodStorage chamber whose entrance pool is at cap, where carriers can't
// fully deposit and surface foragers form a small attractor cycle near the
// entrance. Tests below cover each fix in isolation; the full snapshot
// replay lives in src/sim/issue-42-snapshot-replay.test.ts.
// ---------------------------------------------------------------------------

describe('issue #42 — partial-deposit wait gate (v6)', () => {
  it('partial deposit at the entrance pool sets waitingDeposit=1 (v6)', () => {
    // Setup: colony at the cap minus 100 fp pool headroom, no chambers,
    // ant at the entrance underground tile carrying 500 fp. The deposit
    // absorbs 100 (to reach cap) and leaves 400 on the carry. Pre-v6 the
    // wait gate only fired on toPool === 0; v6 also fires on partial fill
    // when no chamber is depositable.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 7, surfaceTileY: 5, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY - 100; // 100 fp headroom
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 7 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.zone[antId] = Zone.Underground;
    world.ants.foodCarrying[antId] = 500;

    antDepositFood(world, colony, antId);

    // Pool at cap, 400 leftover, ant entered wait.
    expect(colony.foodStored).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(world.ants.foodCarrying[antId]).toBe(400);
    expect(world.ants.waitingDeposit[antId]).toBe(1);
  });
});

describe('issue #42 — demote SearchingFood when no deposit target (v6)', () => {
  it('forager inside the wave radius is demoted when colony has nowhere to deposit', () => {
    // Saturated MATURE colony — pool at cap AND a full FoodStorage chamber, so
    // anything a forager finds has nowhere to land. Demote unconditionally
    // regardless of distance to entrance. Wave does NOT bump (the demote isn't
    // about radius). V27 (#126) scopes the noDeposit demote to colonies that own
    // a FoodStorage chamber (the mature-colony pile-up); a chamberless colony is
    // covered separately (forager-backpressure.test.ts) and keeps foraging.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 0, surfaceTileY: 0, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: FOOD_CHAMBER_CAPACITY, // saturated → not depositable
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT, // 5 tiles from entrance — well within wave 0 radius (25)
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.zone[antId] = Zone.Surface;

    tickSearchLeash(world);

    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
    // Wave preserved (no penalty for noDeposit demotion).
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('a depositable chamber prevents the noDeposit demote (gate is on cap AND no chambers)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 0, surfaceTileY: 0, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;
    // A FoodStorage chamber with headroom — gives the forager a deposit
    // target, so the noDeposit gate must NOT fire.
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.zone[antId] = Zone.Surface;

    tickSearchLeash(world);

    // Still searching — chamber headroom preserves the foraging role.
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

describe('issue #42 — surface SearchingFood no-revisit rule (v6)', () => {
  function setupForagerInOpenSurface(): {
    world: WorldState;
    antId: number;
  } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 0, surfaceTileY: 0, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    // Below cap so the v6 noDeposit demote doesn't fire and pre-empt the
    // movement filter under test.
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;
    // Surface grid + empty pheromone state are correct defaults from
    // createWorldState; nothing else to seed for a no-pheromone wander.

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 50 << FP_SHIFT,
      posY: 50 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.zone[antId] = Zone.Surface;
    return { world, antId };
  }

  it('proposed step onto a tile in the recent-tiles buffer redirects to a non-recent neighbor', () => {
    const { world, antId } = setupForagerInOpenSurface();
    // Pre-load the buffer so (51, 50) and (50, 51) are "recent" — the most
    // common biased candidates from the wander/pheromone samplers.
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 0] = 51;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 0] = 50;
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 1] = 50;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 1] = 51;
    world.ants.recentTilesHead[antId] = 2;

    const rng = new Rng(123);
    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, rng, digFlowFields);

    const newTileX = world.ants.posX[antId]! >> FP_SHIFT;
    const newTileY = world.ants.posY[antId]! >> FP_SHIFT;
    // The ant must NOT have stepped onto either pre-loaded recent tile.
    expect(`${newTileX},${newTileY}`).not.toBe('51,50');
    expect(`${newTileX},${newTileY}`).not.toBe('50,51');
  });

  it('a successful tile-crossing pushes the vacated tile onto the recent-tiles buffer', () => {
    const { world, antId } = setupForagerInOpenSurface();
    const startTileX = 50;
    const startTileY = 50;

    const rng = new Rng(7);
    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, rng, digFlowFields);

    const newTileX = world.ants.posX[antId]! >> FP_SHIFT;
    const newTileY = world.ants.posY[antId]! >> FP_SHIFT;
    if (newTileX !== startTileX || newTileY !== startTileY) {
      // The starting tile (the one we just left) is now in the buffer.
      let found = false;
      for (let s = 0; s < RECENT_TILES_LEN; s++) {
        if (
          world.ants.recentTilesX[antId * RECENT_TILES_LEN + s] === startTileX &&
          world.ants.recentTilesY[antId * RECENT_TILES_LEN + s] === startTileY
        ) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
  });

  it('pickup clears the recent-tiles buffer', () => {
    const { world, antId } = setupForagerInOpenSurface();
    // Pre-populate the buffer so we can tell a clear happened.
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 0] = 49;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 0] = 50;
    world.ants.recentTilesHead[antId] = 1;

    // Trigger pickup directly with a synthetic pile object — antPickupFood
    // is the state-mutation API that flips subTask and clears search state.
    antPickupFood(world.ants, antId, { pickupsRemaining: 50 });

    // Every slot back to the SENTINEL value (-1).
    for (let s = 0; s < RECENT_TILES_LEN; s++) {
      expect(world.ants.recentTilesX[antId * RECENT_TILES_LEN + s]).toBe(-1);
      expect(world.ants.recentTilesY[antId * RECENT_TILES_LEN + s]).toBe(-1);
    }
    expect(world.ants.recentTilesHead[antId]).toBe(0);
  });

  it('alternate-pick rejects out-of-bounds neighbors at the map edge (codex review fix)', () => {
    // Pin the regression with a synthetic call into the picker logic via
    // an end-state assertion: at y=0 with all in-bounds neighbors except
    // W marked recent, the picker's only valid alternate is W. Without
    // the bounds check the picker would accept N (the first ALT_DX/DY
    // entry — out of bounds at y=0) the moment a recent-tile filter
    // activates, then the post-step clamp would null the move and the
    // ant would stall indefinitely (no tile-cross → buffer never pushes).
    //
    // The test runs 20 ticks. With the bounds fix, the ant must visit
    // at least one tile that is NOT (50, 0) within those 20 ticks —
    // i.e. at least one valid tile-crossing happens. Without the fix,
    // the picker repeatedly chooses OOB directions whenever a recent-
    // tile filter activates, the clamp eats the step, and the ant
    // stalls at (50, 0) for the entire window.
    const { world, antId } = setupForagerInOpenSurface();
    world.ants.posX[antId] = 50 << FP_SHIFT;
    world.ants.posY[antId] = 0;
    // Mark E, SE, S, SW as recent — covers 4 of 5 in-bounds neighbors
    // at y=0. Only W remains as a valid in-bounds alternate.
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 0] = 51;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 0] = 0; // E
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 1] = 51;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 1] = 1; // SE
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 2] = 50;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 2] = 1; // S
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 3] = 49;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 3] = 1; // SW
    world.ants.recentTilesHead[antId] = 0;

    const visitedTiles = new Set<string>();
    const rng = new Rng(42);
    const digFlowFields = createDigFlowFields();
    for (let t = 0; t < 20; t++) {
      tickAntMovement(world, rng, digFlowFields);
      const tx = world.ants.posX[antId] >> FP_SHIFT;
      const ty = world.ants.posY[antId] >> FP_SHIFT;
      visitedTiles.add(`${tx},${ty}`);
      // Hard requirement: never enter an OOB tile (y must never be
      // < 0 even at sub-tile precision). Surface clamp at the call
      // boundary should already enforce this; assert so the test
      // catches any future passability change that lifts the clamp.
      expect(world.ants.posY[antId]).toBeGreaterThanOrEqual(0);
    }
    // The ant must have crossed at least one tile boundary in 20
    // ticks — without the bounds check the picker would pin it at
    // (50, 0) by repeatedly choosing OOB directions.
    expect(visitedTiles.size).toBeGreaterThan(1);
  });
});
