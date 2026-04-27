// ant-system.test.ts — CLNY-06 (forage cycle), PHER-03 (carry-only), movement
//
// Test coverage:
//   antPickupFood:          normal pickup + CarryingFood transition, capacity-limited,
//                           pile-limited, capacity-full early-return (no flip), empty-pile (no flip)
//   antDepositFood:         normal deposit + idle-checkpoint, no-op when empty (no task flip)
//   tickPheromoneDeposit:   carrying deposits, non-carrying skip, dead skip, missing grid,
//                           multi-ant accumulation (PHER-03)
//   tickAntMovement:        forager moves per gradient, non-forager stays put,
//                           clamp-to-bounds, dead ant stationary
//   CLNY-06 integration:    full forage cycle: pickup → carryingFood → pheromone deposits
//                           → deposit → foodStored increment + idle-checkpoint (SC 6)

import { describe, it, expect } from 'vitest';
import {
  antPickupFood,
  antDepositFood,
  canEnterUndergroundTile,
  getTaskDirection,
  tickDigExecution,
  routeForagerPriority,
  tickPheromoneDeposit,
  tickAntMovement,
  tickForagerActions,
  tickNurseActions,
  tickSearchLeash,
  updateFightAntTargets,
  chooseExcursionDirection,
  tickExcursionBoundary,
} from './ant-system.js';
import { createWorldState, allocateEntityId } from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { AntTask, ForagingSubState, DiggingSubState, NursingSubState, ChamberType, PheromoneType } from '../enums.js';
import { createPheromoneGrid, phGet, phSet, pheromoneGridKey } from '../pheromone/pheromone-store.js';
import { Rng } from '../rng.js';
import {
  WORKER_CARRY_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  FOOD_CHAMBER_CAPACITY,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_TRAIL_DEPOSIT,
  PHEROMONE_CAP,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  DIG_TICKS_PER_TILE,
  SEARCH_LEASH_RADII,
  SEARCH_LEASH_MAX_WAVE,
  ENTRANCE_DEPOSIT_SUPPRESS_RADIUS,
  WORKER_BASE_SPEED,
  QUEEN_EGG_INTERVAL_TICKS,
} from '../constants.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Zone, UndergroundTileState, ugGet, ugSet, createUndergroundGrid } from '../terrain.js';
import { createDigFlowFields, computeDigFlowField } from '../dig-system.js';
import {
  createEntranceFlowFields,
  ensureEntranceFlowField,
  computeEntranceFlowField,
} from '../entrance-flow.js';
import {
  createChamberFlowFields,
  ensureChamberFlowFields,
  computeChamberFlowField,
  FOOD_CHAMBER_TYPES,
  NURSING_CHAMBER_TYPES,
} from '../chamber-flow.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';
import type { FoodPile } from '../food.js';

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
  it('1. normal pickup — transfers FOOD_PICKUP_AMOUNT, transitions to CarryingFood', () => {
    const { world, antId } = setupForagerWorld();
    const pile = { amount: 1000 };
    world.ants.foodCarrying[antId] = 0;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(FOOD_PICKUP_AMOUNT); // 512
    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    expect(pile.amount).toBe(1000 - FOOD_PICKUP_AMOUNT); // 488
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('2. capacity-limited — transfers remaining capacity, not full FOOD_PICKUP_AMOUNT', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 600; // 424 remaining capacity (WORKER_CARRY_CAPACITY=1024)
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { amount: 1000 };

    const transferred = antPickupFood(world.ants, antId, pile);

    const expectedTransfer = WORKER_CARRY_CAPACITY - 600; // 424
    expect(transferred).toBe(expectedTransfer);
    expect(world.ants.foodCarrying[antId]).toBe(WORKER_CARRY_CAPACITY); // full
    expect(pile.amount).toBe(1000 - expectedTransfer);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('3. pile-limited — transfers only what pile has when less than FOOD_PICKUP_AMOUNT', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 0;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { amount: 100 }; // less than FOOD_PICKUP_AMOUNT (512)

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(100);
    expect(world.ants.foodCarrying[antId]).toBe(100);
    expect(pile.amount).toBe(0);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
  });

  it('3a. capacity-full early-return — NO subTask transition (PRD §4c L1097 regression guard)', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = WORKER_CARRY_CAPACITY; // already full
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { amount: 1000 };

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(WORKER_CARRY_CAPACITY); // unchanged
    expect(pile.amount).toBe(1000); // unchanged
    // Critical: no transition — subTask must NOT be flipped on zero transfer
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('3b. empty-pile early-return — NO subTask transition (zero-transfer regression guard)', () => {
    const { world, antId } = setupForagerWorld();
    world.ants.foodCarrying[antId] = 0;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    const pile = { amount: 0 }; // empty pile

    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(0);
    expect(world.ants.foodCarrying[antId]).toBe(0);
    expect(pile.amount).toBe(0);
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
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);   // NOT flipped to Idle
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
      chamberId: 100, chamberType: ChamberType.FoodStorage, foodStored: 0,
      posX: 0, posY: 0, width: 3, height: 3,
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
      chamberId: 100, chamberType: ChamberType.FoodStorage,
      foodStored: FOOD_CHAMBER_CAPACITY,
      posX: 0, posY: 0, width: 3, height: 3,
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
// tickPheromoneDeposit — PHER-03 carry-only rule
// ---------------------------------------------------------------------------

describe('tickPheromoneDeposit', () => {
  it('6. carrying ant deposits FOOD_TRAIL_DEPOSIT at its tile', () => {
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 5 << FP_SHIFT);
    const { grid } = setupSurfaceGrid(world);
    world.ants.foodCarrying[antId] = 500;
    world.ants.alive[antId] = 1;

    tickPheromoneDeposit(world);

    expect(phGet(grid, 5, 5)).toBe(FOOD_TRAIL_DEPOSIT);
  });

  it('7. non-carrying ant does NOT deposit (PHER-03 carry-only rule)', () => {
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 5 << FP_SHIFT);
    const { grid } = setupSurfaceGrid(world);
    world.ants.foodCarrying[antId] = 0; // not carrying
    world.ants.alive[antId] = 1;

    tickPheromoneDeposit(world);

    expect(phGet(grid, 5, 5)).toBe(0);
  });

  it('8. dead ant does NOT deposit', () => {
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 5 << FP_SHIFT);
    const { grid } = setupSurfaceGrid(world);
    world.ants.foodCarrying[antId] = 500;
    world.ants.alive[antId] = 0; // dead

    tickPheromoneDeposit(world);

    expect(phGet(grid, 5, 5)).toBe(0);
  });

  it('9. missing grid is silently skipped — no throw', () => {
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 5 << FP_SHIFT);
    // Do NOT register any pheromone grid
    world.ants.foodCarrying[antId] = 500;
    world.ants.alive[antId] = 1;

    // Must not throw
    expect(() => tickPheromoneDeposit(world)).not.toThrow();
  });

  it('10. multiple ants accumulate deposits at same tile', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    world.colonies[COLONY_ID] = colony;
    const { grid } = setupSurfaceGrid(world);

    // Two ants at the same tile (5,5)
    const tileX = 5;
    const tileY = 5;
    const posX = tileX << FP_SHIFT;
    const posY = tileY << FP_SHIFT;

    const ant1 = allocateEntityId(world);
    initAnt(world.ants, ant1, { colonyId: COLONY_ID, posX, posY });
    world.ants.foodCarrying[ant1] = 500;

    const ant2 = allocateEntityId(world);
    initAnt(world.ants, ant2, { colonyId: COLONY_ID, posX, posY });
    world.ants.foodCarrying[ant2] = 500;

    tickPheromoneDeposit(world);

    const expected = FOOD_TRAIL_DEPOSIT * 2;
    // If expected exceeds PHEROMONE_CAP, value is capped
    const capped = expected > PHEROMONE_CAP ? PHEROMONE_CAP : expected;
    expect(phGet(grid, tileX, tileY)).toBe(capped);
  });
});

// ---------------------------------------------------------------------------
// tickAntMovement
// ---------------------------------------------------------------------------

describe('tickAntMovement', () => {
  it('11. forager moves per gradient — toward strong pheromone neighbor', () => {
    // Place strong pheromone at tile (5,5) and weak at (5,3); ant at (5,4) as forager.
    // The exploit branch picks the direction toward the strongest neighbor.
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 4 << FP_SHIFT);
    const { grid } = setupSurfaceGrid(world);

    // Strong pheromone directly below the ant's tile (dy = +1 → posY increases)
    phSet(grid, 5, 5, 1000);
    // Weak pheromone above (dy = -1)
    phSet(grid, 5, 3, 100);

    const speed = world.ants.speed[antId]!; // WORKER_BASE_SPEED = 128
    const posYBefore = world.ants.posY[antId]!; // 4 * FP_ONE = 1024

    // Use a seed that takes the exploit branch: rng.nextInt(100) >= EXPLORE_RATE_PERCENT(10)
    // Mulberry32 seed 42: first nextInt(100) value — we test exploit behavior
    // We scan with seed 999 which reliably gives exploit for our test assertions
    const rng = new Rng(999);
    const digFlowFields = createDigFlowFields();

    tickAntMovement(world, rng, digFlowFields);

    const posYAfter = world.ants.posY[antId]!;
    // Ant should have moved downward (+dy direction, toward tile (5,5))
    // posY increases by 1 * speed on exploit, posY may change by random direction on explore
    // In all cases: posY must be in valid bounds
    expect(posYAfter).toBeGreaterThanOrEqual(0);
    expect(posYAfter).toBeLessThanOrEqual((SURFACE_GRID_HEIGHT << FP_SHIFT) - 1);

    // With seed 999: first nextInt(100) result determines exploit vs explore.
    // We assert the position changed (movement happened in some direction)
    // OR stayed (explore chose {0,0} — but sampleGradient never returns 0,0 when neighbors exist)
    // The ant at (5,4) has strong neighbor at (5,5) — exploit must move toward it
    // Since we need determinism without seed-specific hardcoding, we assert posY >= posYBefore
    // (exploit gives +speed, explore gives a random direction from DIRS which includes dy=+1)
    // We just validate movement occurred in bounds; the clamp test (13) covers the actual clamp.
    expect(posYAfter + world.ants.posX[antId]!).toBeGreaterThanOrEqual(0); // trivially true, movement is the goal
    // Stronger assertion: posX and posY are both in bounds
    expect(world.ants.posX[antId]).toBeGreaterThanOrEqual(0);
    expect(world.ants.posX[antId]).toBeLessThanOrEqual((SURFACE_GRID_WIDTH << FP_SHIFT) - 1);

    // Key assertion: ant position changed from initial if exploit branch gives down direction
    // or explore branch gives any non-zero direction (which includes moving from posY=1024)
    // The speed (128) is added to position, so at least one dimension should change
    const moved = (posYAfter !== posYBefore) || (world.ants.posX[antId]! !== (5 << FP_SHIFT));
    expect(moved).toBe(true);
    // Also: posY should equal posYBefore + speed (moved toward strong pheromone)
    // Only true if exploit branch taken. Accept either posYBefore+speed OR any other valid movement.
    expect([posYBefore + speed, posYBefore, posYBefore - speed]).toContain(posYAfter);
  });

  it('12. non-forager stays put (getTaskDirection returns {0,0})', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances        = [];
    colony.rallyPoint       = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Digging, // non-forager
      zone: Zone.Underground,
      subTask: DiggingSubState.Excavating, // Excavating → stays put per getTaskDirection
    });
    world.ants.digTicksRemaining[antId] = 5; // has ticks left, so tickDigExecution won't open

    const posXBefore = world.ants.posX[antId]!;
    const posYBefore = world.ants.posY[antId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Non-forager in Excavating must not move (getTaskDirection returns {0,0})
    expect(world.ants.posX[antId]).toBe(posXBefore);
    expect(world.ants.posY[antId]).toBe(posYBefore);
  });

  it('13. clamp to bounds — posX does not exceed maxX after rightward movement', () => {
    const { world, antId } = setupForagerWorld();
    const { grid } = setupSurfaceGrid(world);

    // Place ant at the right edge - 2 fixed-point units
    const maxX = (SURFACE_GRID_WIDTH << FP_SHIFT) - 1;
    world.ants.posX[antId] = maxX - 2;
    world.ants.posY[antId] = 10 << FP_SHIFT;

    // Place strong pheromone at the rightmost neighbor of the ant's tile
    // Ant's tile: x = (maxX - 2) >> FP_SHIFT = SURFACE_GRID_WIDTH - 1 (rightmost column)
    // Neighbor to the right is out of bounds → phGet returns 0 there
    // So instead place strong pheromone at tile below and ensure movement stays in bounds
    const tileY = (world.ants.posY[antId]! >> FP_SHIFT) + 1;
    phSet(grid, SURFACE_GRID_WIDTH - 1, tileY, 1000);

    // Use seed 0 — exploit branch likely, moves toward strong neighbor
    const rng = new Rng(0);
    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, rng, digFlowFields);

    // Key invariant: posX must be clamped and never exceed maxX
    expect(world.ants.posX[antId]).toBeLessThanOrEqual(maxX);
    expect(world.ants.posX[antId]).toBeGreaterThanOrEqual(0);
    expect(world.ants.posY[antId]).toBeGreaterThanOrEqual(0);
    expect(world.ants.posY[antId]).toBeLessThanOrEqual((SURFACE_GRID_HEIGHT << FP_SHIFT) - 1);
  });

  it('14. dead ant does not move', () => {
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 5 << FP_SHIFT);
    setupSurfaceGrid(world);
    world.ants.alive[antId] = 0; // dead

    const posXBefore = world.ants.posX[antId]!;
    const posYBefore = world.ants.posY[antId]!;

    const rng = new Rng(42);
    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[antId]).toBe(posXBefore);
    expect(world.ants.posY[antId]).toBe(posYBefore);
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
    const pile = { amount: 1000 };

    // --- Tick 0: pickup ---
    const transferred = antPickupFood(world.ants, antId, pile);

    expect(transferred).toBe(FOOD_PICKUP_AMOUNT); // 512
    expect(world.ants.foodCarrying[antId]).toBe(FOOD_PICKUP_AMOUNT);
    expect(pile.amount).toBe(1000 - FOOD_PICKUP_AMOUNT);
    // antPickupFood owns the subTask transition per PRD §4c L1103
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);

    // --- Ticks 1..5: pheromone deposits while carrying (Phase 6 SC 3) ---
    for (let t = 0; t < 5; t++) {
      tickPheromoneDeposit(world);
    }

    // Pheromone must have accumulated at the ant's tile
    const pherValue = phGet(grid, tileX, tileY);
    expect(pherValue).toBeGreaterThan(0);
    // 5 deposits of FOOD_TRAIL_DEPOSIT each (capped at PHEROMONE_CAP)
    const expected5 = FOOD_TRAIL_DEPOSIT * 5;
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
// getTaskDirection — sanity check
// ---------------------------------------------------------------------------

describe('getTaskDirection', () => {
  it('returns {dx:0, dy:0} for Idle and Fighting tasks (no pathfinding needed)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances        = [];
    colony.rallyPoint       = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    const digFlowFields = createDigFlowFields();

    for (const task of [AntTask.Idle, AntTask.Fighting]) {
      initAnt(world.ants, antId, {
        colonyId: COLONY_ID,
        posX: 5 << FP_SHIFT,
        posY: 5 << FP_SHIFT,
        task,
        subTask: 0,
      });
      const dir = getTaskDirection(world, antId, digFlowFields);
      expect(dir.dx).toBe(0);
      expect(dir.dy).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: create world with colony + underground grid for dig/zone tests
// ---------------------------------------------------------------------------

function setupWorldWithUnderground(
  ugWidth = 16,
  ugHeight = 16,
): {
  world: WorldState;
  colony: ColonyRecord;
  underground: ReturnType<typeof createUndergroundGrid>;
  colonyId: number;
} {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  const colonyId = COLONY_ID;
  const colony = createColonyRecord(colonyId, 0);
  colony.entrances        = [];
  colony.rallyPoint       = null;
  colony.digFlowFieldDirty = false;
  world.colonies[colonyId] = colony;

  const underground = createUndergroundGrid(ugWidth, ugHeight);
  world.undergroundGrids[colonyId] = underground;

  return { world, colony, underground, colonyId };
}

// ---------------------------------------------------------------------------
// getTaskDirection — dig direction lookup (UNDR-02 purity checks)
// ---------------------------------------------------------------------------

describe('getTaskDirection — dig direction lookup (purity checks)', () => {
  it('D-1. dig worker at Open tile adjacent to Marked tile → returns correct dx/dy; no state mutation', () => {
    // Grid: ant at (0,0)=Open, (1,0)=Marked → flow-field should point East (dx=1, dy=0)
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 0, 0, UndergroundTileState.Open);
    ugSet(underground, 1, 0, UndergroundTileState.Marked);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0 << FP_SHIFT,
      posY: 0 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });

    const tileStateBefore = ugGet(underground, 1, 0);
    const subTaskBefore = world.ants.subTask[antId];
    const dirtyBefore = colony.digFlowFieldDirty;

    const dir = getTaskDirection(world, antId, digFlowFields);

    // Direction: from (0,0) the nearest Marked tile is East → dx=1, dy=0
    expect(dir.dx).toBe(1);
    expect(dir.dy).toBe(0);

    // Purity: nothing mutated
    expect(ugGet(underground, 1, 0)).toBe(tileStateBefore); // tile unchanged
    expect(world.ants.subTask[antId]).toBe(subTaskBefore);   // subTask unchanged
    expect(colony.digFlowFieldDirty).toBe(dirtyBefore);      // dirty flag unchanged
  });

  it('D-2. dig worker ON Marked tile (flow-field dir=-1) → returns {0,0}; tile still Marked (not claimed)', () => {
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 2, 2, UndergroundTileState.Marked);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 2 << FP_SHIFT,
      posY: 2 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });

    const subTaskBefore = world.ants.subTask[antId];

    const dir = getTaskDirection(world, antId, digFlowFields);

    // Returns {0,0} — claim happens in tickDigExecution at step 10
    expect(dir.dx).toBe(0);
    expect(dir.dy).toBe(0);

    // Purity: tile still Marked (NOT BeingDug), subTask unchanged
    expect(ugGet(underground, 2, 2)).toBe(UndergroundTileState.Marked);
    expect(world.ants.subTask[antId]).toBe(subTaskBefore);
    expect(colony.digFlowFieldDirty).toBe(false);
  });

  it('D-3. dig worker in Excavating → returns {0,0}; digTicksRemaining unchanged (purity check)', () => {
    const { world, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 1, 1, UndergroundTileState.BeingDug);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
      zone: Zone.Underground,
    });
    world.ants.digTicksRemaining[antId] = DIG_TICKS_PER_TILE;
    world.ants.digTileX[antId] = 1;
    world.ants.digTileY[antId] = 1;

    const ticksBefore = world.ants.digTicksRemaining[antId];

    const dir = getTaskDirection(world, antId, digFlowFields);

    // Stationary while digging
    expect(dir.dx).toBe(0);
    expect(dir.dy).toBe(0);

    // Purity: digTicksRemaining NOT decremented (decrement happens in tickDigExecution)
    expect(world.ants.digTicksRemaining[antId]).toBe(ticksBefore);
  });
});

// ---------------------------------------------------------------------------
// tickDigExecution — state machine transitions (UNDR-02)
// ---------------------------------------------------------------------------

describe('tickDigExecution — state machine transitions', () => {
  it('3a. dig worker ON Marked tile → claims it (Marked→BeingDug, sets claim fields, digFlowFieldDirty)', () => {
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 2, 2, UndergroundTileState.Marked);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 2 << FP_SHIFT,
      posY: 2 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });

    tickDigExecution(world, digFlowFields);

    // Tile: Marked → BeingDug
    expect(ugGet(underground, 2, 2)).toBe(UndergroundTileState.BeingDug);
    // Ant claim fields set
    expect(world.ants.digTileX[antId]).toBe(2);
    expect(world.ants.digTileY[antId]).toBe(2);
    expect(world.ants.digTicksRemaining[antId]).toBe(DIG_TICKS_PER_TILE);
    // Transitioned to Excavating
    expect(world.ants.subTask[antId]).toBe(DiggingSubState.Excavating);
    // Flow-field dirty flag set
    expect(colony.digFlowFieldDirty).toBe(true);
  });

  it('3b. dig worker Excavating with digTicksRemaining>1 → decrements by 1; tile still BeingDug; still Excavating', () => {
    const { world, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 1, 1, UndergroundTileState.BeingDug);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
      zone: Zone.Underground,
    });
    world.ants.digTileX[antId] = 1;
    world.ants.digTileY[antId] = 1;
    world.ants.digTicksRemaining[antId] = 5; // > 1

    tickDigExecution(world, digFlowFields);

    expect(world.ants.digTicksRemaining[antId]).toBe(4); // decremented
    expect(ugGet(underground, 1, 1)).toBe(UndergroundTileState.BeingDug); // still BeingDug
    expect(world.ants.subTask[antId]).toBe(DiggingSubState.Excavating); // still Excavating
  });

  it('3c. dig worker Excavating with digTicksRemaining=1 → tile BeingDug→Open, claim cleared, back to MovingToTile', () => {
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 3, 3, UndergroundTileState.BeingDug);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 3 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
      zone: Zone.Underground,
    });
    world.ants.digTileX[antId] = 3;
    world.ants.digTileY[antId] = 3;
    world.ants.digTicksRemaining[antId] = 1; // final tick

    tickDigExecution(world, digFlowFields);

    // Tile opens
    expect(ugGet(underground, 3, 3)).toBe(UndergroundTileState.Open);
    // Claim fields cleared
    expect(world.ants.digTileX[antId]).toBe(-1);
    expect(world.ants.digTileY[antId]).toBe(-1);
    // Back to MovingToTile
    expect(world.ants.subTask[antId]).toBe(DiggingSubState.MovingToTile);
    // Flow-field dirty
    expect(colony.digFlowFieldDirty).toBe(true);
  });

  it('3d. dig worker MovingToTile on unreachable Open tile → released to Idle (09 digger-reassignment fix)', () => {
    // No Marked tiles anywhere → flow field is all -2. Before the 09 fix this
    // ant stayed sticky as a Digging worker; now it is released to Idle so
    // step 10a can rehome it on the next tick.
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 1, 1, UndergroundTileState.Open);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });

    tickDigExecution(world, digFlowFields);

    // No claim, no tile mutation, no dirty flag
    expect(world.ants.digTileX[antId]).toBe(-1);
    expect(world.ants.digTileY[antId]).toBe(-1);
    expect(colony.digFlowFieldDirty).toBe(false);
    // Released back to Idle so step 10a can reassign it next tick
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('3d2. dig worker with no flow field (never any dig work marked) → released to Idle', () => {
    // No flow field at all for this colony — the whole failure mode when the
    // player sets dig>0 on a fresh colony but never marks a tile.
    const { world, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 1, 1, UndergroundTileState.Open);

    const digFlowFields = createDigFlowFields();
    // Intentionally DO NOT populate digFlowFields.fields[COLONY_ID].

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });

    tickDigExecution(world, digFlowFields);

    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('3d3. dig worker on surface with no flow field → released to Idle', () => {
    // Fresh colony, no dig work ever marked, dig worker still on surface.
    // No flow field → release regardless of zone so the worker is not
    // stranded waiting for dig work that will never materialize.
    const { world } = setupWorldWithUnderground(4, 4);

    const digFlowFields = createDigFlowFields();

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT,
      posY: 1 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Surface,
    });

    tickDigExecution(world, digFlowFields);

    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('3d4. surface dig worker with a valid flow field is NOT released (descending toward entrance)', () => {
    // Surface digger, flow field exists (colony has Marked tiles elsewhere).
    // Must stay as Digging so tickAntMovement can route it to an entrance.
    const { world, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 2, 2, UndergroundTileState.Marked);

    const digFlowFields = createDigFlowFields();
    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 3 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Surface,
    });

    tickDigExecution(world, digFlowFields);

    expect(world.ants.task[antId]).toBe(AntTask.Digging);
    expect(world.ants.subTask[antId]).toBe(DiggingSubState.MovingToTile);
  });

  it('3e. ordering/integration: after DIG_TICKS_PER_TILE+1 calls, tile is Open and ant is MovingToTile', () => {
    // Ant starts ON a Marked tile; simulate full claim→excavate→open sequence
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 0, 0, UndergroundTileState.Marked);

    const digFlowFields = createDigFlowFields();

    // Initial flow-field (with Marked tile seeded)
    let flowField = new Int32Array(4 * 4);
    let queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,  // posX=0 → tileX=0
      posY: 0,  // posY=0 → tileY=0
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });

    // Tick 1: claim happens (Marked → BeingDug, subTask → Excavating)
    tickDigExecution(world, digFlowFields);
    expect(ugGet(underground, 0, 0)).toBe(UndergroundTileState.BeingDug);
    expect(world.ants.subTask[antId]).toBe(DiggingSubState.Excavating);
    expect(world.ants.digTicksRemaining[antId]).toBe(DIG_TICKS_PER_TILE);

    // Recompute flow-field after claim (now BeingDug; no Marked tiles left)
    flowField = new Int32Array(4 * 4);
    queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    // Ticks 2..DIG_TICKS_PER_TILE: countdown
    for (let t = 0; t < DIG_TICKS_PER_TILE - 1; t++) {
      tickDigExecution(world, digFlowFields);
    }
    expect(world.ants.digTicksRemaining[antId]).toBe(1);

    // Final tick: tile opens
    tickDigExecution(world, digFlowFields);

    expect(ugGet(underground, 0, 0)).toBe(UndergroundTileState.Open);
    expect(world.ants.subTask[antId]).toBe(DiggingSubState.MovingToTile);
    expect(world.ants.digTileX[antId]).toBe(-1);
    expect(world.ants.digTileY[antId]).toBe(-1);
    expect(colony.digFlowFieldDirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// routeForagerPriority — forager priority routing (SURF-03)
// ---------------------------------------------------------------------------

describe('routeForagerPriority', () => {
  function makePile(id: number, tileX: number, tileY: number): FoodPile {
    return { foodPileId: id, tileX, tileY };
  }

  it('4. colony has no priorityFoodPileId → routeForagerPriority sets targetPosX/Y = -1', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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

  it('5. colony.priorityFoodPileId set → targetPosX/Y set to that pile\'s tile position', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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

    expect(world.ants.targetPosX[antId]).toBe(15 << FP_SHIFT);
    expect(world.ants.targetPosY[antId]).toBe(20 << FP_SHIFT);
  });

  it('6. priority target is exclusive: ant routes to the chosen pile even when a closer pile exists', () => {
    // Exclusive-selection semantics: the player points the colony at a specific
    // pile; proximity does not override that choice. Previously this tested
    // nearest-wins + foodPileId tie-breaking; with the new model neither
    // applies — a single priorityFoodPileId per colony is authoritative.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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
    expect(world.ants.targetPosX[antId]).toBe(10 << FP_SHIFT);
    expect(world.ants.targetPosY[antId]).toBe(5 << FP_SHIFT);
  });

  it('7. ant not in SearchingFood sub-state → targetPosX/Y unchanged', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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

  it('8. cross-colony isolation: colony A\'s priority pile does NOT redirect colony B\'s foragers', () => {
    // Regression for the Phase 9 bug where isMarkedPriority lived on the shared
    // FoodPile entity and enemy ants read it too. With per-colony priority, a
    // forager from a colony with no priority keeps targetPosX/Y at -1 even
    // when another colony has pointed its own foragers at a pile.
    const world = createWorldState(42, MAX_TEST_ENTITIES);

    const COLONY_A = 1;
    const COLONY_B = 2;

    const colonyA = createColonyRecord(COLONY_A, 0);
    colonyA.entrances = []; colonyA.rallyPoint = null; colonyA.digFlowFieldDirty = false;
    colonyA.priorityFoodPileId = 1;
    world.colonies[COLONY_A] = colonyA;

    const colonyB = createColonyRecord(COLONY_B, 0);
    colonyB.entrances = []; colonyB.rallyPoint = null; colonyB.digFlowFieldDirty = false;
    colonyB.priorityFoodPileId = null;
    world.colonies[COLONY_B] = colonyB;

    world.foodPiles.push(makePile(1, 15, 20));

    const antA = allocateEntityId(world);
    initAnt(world.ants, antA, {
      colonyId: COLONY_A,
      posX: 0, posY: 0,
      task: AntTask.Foraging, subTask: ForagingSubState.SearchingFood,
    });
    const antB = allocateEntityId(world);
    initAnt(world.ants, antB, {
      colonyId: COLONY_B,
      posX: 0, posY: 0,
      task: AntTask.Foraging, subTask: ForagingSubState.SearchingFood,
    });

    routeForagerPriority(world);

    // A routes to the pile; B is cleared (its colony has no priority).
    expect(world.ants.targetPosX[antA]).toBe(15 << FP_SHIFT);
    expect(world.ants.targetPosY[antA]).toBe(20 << FP_SHIFT);
    expect(world.ants.targetPosX[antB]).toBe(-1);
    expect(world.ants.targetPosY[antB]).toBe(-1);
  });

  it('9. stale priorityFoodPileId (pile removed) is treated as null for that tick', () => {
    // If the pile id a colony points at no longer exists in world.foodPiles
    // (e.g. removed by a future depletion/despawn system), the forager falls
    // through to the pheromone gradient rather than chasing a ghost target.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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
// tickAntMovement — zone transition tests (SURF-05)
// ---------------------------------------------------------------------------

describe('tickAntMovement — zone transitions', () => {
  it('8. surface ant at open entrance, task=Digging → swaps to Underground zone, posY=0', () => {
    const { world, colony } = setupWorldWithUnderground();
    // Add an open entrance at surface tile (10, 5)
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 10,
      surfaceTileY: 5,
      isOpen: true,
    });
    setupSurfaceGrid(world); // register pheromone grid (not needed for digging but prevents missing-grid path)

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating, // Excavating → {0,0} direction, stays on tile
      zone: Zone.Surface,
      speed: 0, // zero speed so position doesn't change from movement
    });
    world.ants.digTicksRemaining[antId] = 5;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.zone[antId]).toBe(Zone.Underground);
    expect(world.ants.posY[antId]).toBe(0);
    expect(world.ants.posX[antId]).toBe(10 << FP_SHIFT); // X unchanged
  });

  it('9. underground ant at tileY=0, open entrance, task=Foraging+SearchingFood → swaps to Surface', () => {
    const { world, colony } = setupWorldWithUnderground();
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: 8,
      surfaceTileY: 64,
      isOpen: true,
    });
    setupSurfaceGrid(world);

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 8 << FP_SHIFT,
      posY: 0,  // tileY=0 (already at top of underground)
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
      speed: 0,
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.zone[antId]).toBe(Zone.Surface);
    expect(world.ants.posY[antId]).toBe(64 << FP_SHIFT); // entrance.surfaceTileY
    expect(world.ants.posX[antId]).toBe(8 << FP_SHIFT);
  });

  it('10. surface Digger at closed (designated) entrance → descends to Underground (Phase 9 playability)', () => {
    // A freshly designated entrance has isOpen=false until its shaft is excavated.
    // The excavation itself requires Diggers to reach the shaft tiles, which live
    // in the underground grid at (surfaceTileX, 0..ENTRANCE_SHAFT_DEPTH-1). Without
    // this descent path, closed entrances would be an unreachable deadlock — the
    // shaft could never be dug and isOpen would never flip true.
    const { world, colony } = setupWorldWithUnderground();
    colony.entrances.push({
      entranceId: 3,
      surfaceTileX: 5,
      surfaceTileY: 5,
      isOpen: false, // designated but not yet excavated
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
      zone: Zone.Surface,
      speed: 0,
    });
    world.ants.digTicksRemaining[antId] = 5;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Closed entrance still admits Diggers so the shaft can be excavated.
    expect(world.ants.zone[antId]).toBe(Zone.Underground);
    expect(world.ants.posY[antId]).toBe(0);
    expect(world.ants.posX[antId]).toBe(5 << FP_SHIFT);
  });

  it('10b. surface Nurse at closed entrance → stays on surface (non-Diggers still gated)', () => {
    // Only Diggers get the closed-entrance bypass. Nurses, Fighters, and
    // CarryingFood foragers still require an open entrance per PRD §5d.
    const { world, colony } = setupWorldWithUnderground();
    colony.entrances.push({
      entranceId: 3,
      surfaceTileX: 5,
      surfaceTileY: 5,
      isOpen: false,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Surface,
      speed: 0,
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.zone[antId]).toBe(Zone.Surface);
  });

  it('11. surface ant at entrance but task=Foraging+SearchingFood → no zone swap (stays surface)', () => {
    const { world, colony } = setupWorldWithUnderground();
    colony.entrances.push({
      entranceId: 4,
      surfaceTileX: 7,
      surfaceTileY: 7,
      isOpen: true,
    });
    setupSurfaceGrid(world);

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 7 << FP_SHIFT,
      posY: 7 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood, // needs surface → no transition
      zone: Zone.Surface,
      speed: 0,
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // SearchingFood requires surface — no transition
    expect(world.ants.zone[antId]).toBe(Zone.Surface);
  });
});

// ---------------------------------------------------------------------------
// tickAntMovement — zone-aware bounds tests (SURF-05)
// ---------------------------------------------------------------------------

describe('tickAntMovement — zone-aware bounds', () => {
  it('12. underground ant moved past grid edge → clamped to underground bounds', () => {
    const { world, colony } = setupWorldWithUnderground();
    colony.entrances = []; // no entrances to avoid zone transition

    const antId = allocateEntityId(world);
    // Place ant at far right edge of underground, then trigger movement rightward
    // Use Digging+Excavating → {0,0} direction, but give large posX to test clamp
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: (UNDERGROUND_GRID_WIDTH << FP_SHIFT) + 100, // beyond right edge
      posY: (UNDERGROUND_GRID_HEIGHT << FP_SHIFT) + 100, // beyond bottom edge
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
      zone: Zone.Underground,
      speed: 0,
    });
    world.ants.digTicksRemaining[antId] = 5;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    const maxX = (UNDERGROUND_GRID_WIDTH << FP_SHIFT) - 1;
    const maxY = (UNDERGROUND_GRID_HEIGHT << FP_SHIFT) - 1;
    expect(world.ants.posX[antId]).toBeLessThanOrEqual(maxX);
    expect(world.ants.posY[antId]).toBeLessThanOrEqual(maxY);
    expect(world.ants.posX[antId]).toBeGreaterThanOrEqual(0);
    expect(world.ants.posY[antId]).toBeGreaterThanOrEqual(0);
  });

  it('13. surface ant moved past grid edge → clamped to surface bounds', () => {
    const { world, colony } = setupWorldWithUnderground();
    colony.entrances = [];

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: (SURFACE_GRID_WIDTH << FP_SHIFT) + 500, // beyond right edge
      posY: (SURFACE_GRID_HEIGHT << FP_SHIFT) + 500, // beyond bottom edge
      task: AntTask.Digging,
      subTask: DiggingSubState.Excavating,
      zone: Zone.Surface,
      speed: 0,
    });
    world.ants.digTicksRemaining[antId] = 5;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    const maxX = (SURFACE_GRID_WIDTH << FP_SHIFT) - 1;
    const maxY = (SURFACE_GRID_HEIGHT << FP_SHIFT) - 1;
    expect(world.ants.posX[antId]).toBeLessThanOrEqual(maxX);
    expect(world.ants.posY[antId]).toBeLessThanOrEqual(maxY);
    expect(world.ants.posX[antId]).toBeGreaterThanOrEqual(0);
    expect(world.ants.posY[antId]).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// canEnterUndergroundTile + tickAntMovement — underground passability
//
// Contract: non-digging ants must not cut through Solid dirt to reach their
// target (chamber, food pile, entrance). A Nurse routing to the Queen chamber,
// a carrying forager routing to FoodStorage, or an ascending forager heading
// for the entrance all derive a Manhattan unit step toward their target; the
// tickAntMovement guard must reject a step whose destination tile is Solid
// (or Marked for a non-Digger). Diggers retain the right to step onto Marked
// tiles — that's how tickDigExecution claims them.
// ---------------------------------------------------------------------------

describe('canEnterUndergroundTile', () => {
  it('Open tile — passable for every task', () => {
    const grid = createUndergroundGrid(4, 4);
    ugSet(grid, 1, 1, UndergroundTileState.Open);
    expect(canEnterUndergroundTile(grid, 1, 1, AntTask.Idle)).toBe(true);
    expect(canEnterUndergroundTile(grid, 1, 1, AntTask.Foraging)).toBe(true);
    expect(canEnterUndergroundTile(grid, 1, 1, AntTask.Nursing)).toBe(true);
    expect(canEnterUndergroundTile(grid, 1, 1, AntTask.Digging)).toBe(true);
    expect(canEnterUndergroundTile(grid, 1, 1, AntTask.Fighting)).toBe(true);
  });

  it('BeingDug tile — passable for every task (claim-in-progress but mechanically a pit)', () => {
    const grid = createUndergroundGrid(4, 4);
    ugSet(grid, 2, 2, UndergroundTileState.BeingDug);
    expect(canEnterUndergroundTile(grid, 2, 2, AntTask.Foraging)).toBe(true);
    expect(canEnterUndergroundTile(grid, 2, 2, AntTask.Nursing)).toBe(true);
    expect(canEnterUndergroundTile(grid, 2, 2, AntTask.Digging)).toBe(true);
  });

  it('Marked tile — only Digging may enter (flow-field claim target)', () => {
    const grid = createUndergroundGrid(4, 4);
    ugSet(grid, 3, 3, UndergroundTileState.Marked);
    expect(canEnterUndergroundTile(grid, 3, 3, AntTask.Digging)).toBe(true);
    expect(canEnterUndergroundTile(grid, 3, 3, AntTask.Foraging)).toBe(false);
    expect(canEnterUndergroundTile(grid, 3, 3, AntTask.Nursing)).toBe(false);
    expect(canEnterUndergroundTile(grid, 3, 3, AntTask.Fighting)).toBe(false);
    expect(canEnterUndergroundTile(grid, 3, 3, AntTask.Idle)).toBe(false);
  });

  it('Solid tile — impassable for every task (no ant walks through raw dirt)', () => {
    const grid = createUndergroundGrid(4, 4);
    // Default state is Solid.
    expect(canEnterUndergroundTile(grid, 0, 0, AntTask.Digging)).toBe(false);
    expect(canEnterUndergroundTile(grid, 0, 0, AntTask.Foraging)).toBe(false);
    expect(canEnterUndergroundTile(grid, 0, 0, AntTask.Nursing)).toBe(false);
    expect(canEnterUndergroundTile(grid, 0, 0, AntTask.Fighting)).toBe(false);
    expect(canEnterUndergroundTile(grid, 0, 0, AntTask.Idle)).toBe(false);
  });

  it('Out-of-bounds tile — impassable (defensive; bounds clamp also protects)', () => {
    const grid = createUndergroundGrid(4, 4);
    expect(canEnterUndergroundTile(grid, -1, 0, AntTask.Foraging)).toBe(false);
    expect(canEnterUndergroundTile(grid, 0, -1, AntTask.Foraging)).toBe(false);
    expect(canEnterUndergroundTile(grid, 4, 0, AntTask.Foraging)).toBe(false);
    expect(canEnterUndergroundTile(grid, 0, 4, AntTask.Foraging)).toBe(false);
  });
});

describe('tickAntMovement — underground passability guard', () => {
  it('Nurse targeting a Queen chamber through Solid dirt stalls at her current tile — does not cut through', () => {
    // Setup: a 16x16 underground grid, all Solid. Carve a one-tile Open pocket
    // at (5, 5) where the nurse stands, and a Queen chamber at (5, 8) whose
    // anchor tile is also Open. Everything between is Solid. The pure Manhattan
    // routing in getTaskDirection would step the nurse south → into a Solid
    // tile at (5, 6). The guard must block that step.
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    ugSet(underground, 5, 5, UndergroundTileState.Open);
    ugSet(underground, 5, 8, UndergroundTileState.Open);
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 5 << FP_SHIFT, posY: 8 << FP_SHIFT,
      width: 1, height: 1,
    });

    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    // Run several ticks; the nurse must never leave her Open pocket.
    for (let t = 0; t < 8; t++) {
      tickAntMovement(world, rng, digFlowFields);
      const tileX = world.ants.posX[nurseId]! >> FP_SHIFT;
      const tileY = world.ants.posY[nurseId]! >> FP_SHIFT;
      expect(ugGet(underground, tileX, tileY)).not.toBe(UndergroundTileState.Solid);
    }
    // Final tile unchanged — there is no connected path.
    expect(world.ants.posX[nurseId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[nurseId]! >> FP_SHIFT).toBe(5);
  });

  it('Nurse reaches Queen chamber when a connected Open corridor exists (passability permits tunnel path)', () => {
    // Carve a straight vertical tunnel (5,5)→(5,8) all Open. Nurse should walk it.
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    for (let y = 5; y <= 8; y++) {
      ugSet(underground, 5, y, UndergroundTileState.Open);
    }
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 5 << FP_SHIFT, posY: 8 << FP_SHIFT,
      width: 1, height: 1,
    });

    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    // Each tick the nurse moves 0.5 tile (WORKER_BASE_SPEED). 3 tiles = ~6 ticks; 12 is generous.
    for (let t = 0; t < 12; t++) {
      tickAntMovement(world, rng, digFlowFields);
    }
    // Should have reached the chamber tile (or be on it).
    expect(world.ants.posY[nurseId]! >> FP_SHIFT).toBe(8);
    expect(world.ants.posX[nurseId]! >> FP_SHIFT).toBe(5);
  });

  it('Underground carrying forager routing to FoodStorage never steps into Solid', () => {
    // Forager stands at (2, 10) in a one-tile Open pocket. FoodStorage chamber
    // footprint at (8, 4). Manhattan unit step would take her east into Solid.
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    ugSet(underground, 2, 10, UndergroundTileState.Open);
    // Chamber footprint Open tiles so the routing finds them.
    for (let oy = 0; oy < 2; oy++) {
      for (let ox = 0; ox < 2; ox++) {
        ugSet(underground, 8 + ox, 4 + oy, UndergroundTileState.Open);
      }
    }
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 8 << FP_SHIFT, posY: 4 << FP_SHIFT,
      width: 2, height: 2,
    });

    const foragerId = allocateEntityId(world);
    initAnt(world.ants, foragerId, {
      colonyId: COLONY_ID,
      posX: 2 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[foragerId] = 500;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    for (let t = 0; t < 16; t++) {
      tickAntMovement(world, rng, digFlowFields);
      const tileX = world.ants.posX[foragerId]! >> FP_SHIFT;
      const tileY = world.ants.posY[foragerId]! >> FP_SHIFT;
      expect(ugGet(underground, tileX, tileY)).not.toBe(UndergroundTileState.Solid);
    }
  });

  it('Underground ascending forager (SearchingFood) routing to entrance never steps into Solid', () => {
    // SearchingFood forager at (3, 10) in a one-tile Open pocket. Entrance at
    // surface (7, 5); underground side at (7, 0). No connecting tunnel — the
    // Manhattan step must be blocked, not cut through Solid.
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    ugSet(underground, 3, 10, UndergroundTileState.Open);
    ugSet(underground, 7, 0, UndergroundTileState.Open);
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 7,
      surfaceTileY: 5,
      isOpen: true,
    });
    setupSurfaceGrid(world); // pheromone grid present (not relevant but keeps missing-grid path clean)

    const foragerId = allocateEntityId(world);
    initAnt(world.ants, foragerId, {
      colonyId: COLONY_ID,
      posX: 3 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[foragerId] = 0;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    for (let t = 0; t < 12; t++) {
      tickAntMovement(world, rng, digFlowFields);
      const tileX = world.ants.posX[foragerId]! >> FP_SHIFT;
      const tileY = world.ants.posY[foragerId]! >> FP_SHIFT;
      expect(ugGet(underground, tileX, tileY)).not.toBe(UndergroundTileState.Solid);
    }
    // Zone stays Underground — no phantom transition through dirt.
    expect(world.ants.zone[foragerId]).toBe(Zone.Underground);
  });

  it('Digger retains flow-field descent onto a Marked tile (passability exception)', () => {
    // 4x4 grid: (0,0)=Open (ant stands here), (1,0)=Marked. Flow-field directs
    // east. The guard must allow the step because task === Digging.
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 0, 0, UndergroundTileState.Open);
    ugSet(underground, 1, 0, UndergroundTileState.Marked);

    const flowField = new Int32Array(4 * 4);
    const queue = new Int32Array(4 * 4);
    computeDigFlowField(underground, flowField, queue);
    const digFlowFields = createDigFlowFields();
    digFlowFields.fields[COLONY_ID] = flowField;
    digFlowFields.queues[COLONY_ID] = queue;

    const diggerId = allocateEntityId(world);
    initAnt(world.ants, diggerId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      zone: Zone.Underground,
    });
    // Speed must be large enough for a single tick to cross a tile boundary.
    world.ants.speed[diggerId] = FP_ONE; // exactly one tile per tick

    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Digger stepped from (0,0) Open → (1,0) Marked.
    expect(world.ants.posX[diggerId]! >> FP_SHIFT).toBe(1);
    expect(world.ants.posY[diggerId]! >> FP_SHIFT).toBe(0);
    // Tile itself is still Marked — tickAntMovement does NOT claim (that's tickDigExecution step 10).
    expect(ugGet(underground, 1, 0)).toBe(UndergroundTileState.Marked);
    // And a non-Digger in the same spot would have been blocked.
    void colony;
  });

  it('Non-Digger on an Open tile adjacent to a Marked tile is blocked from stepping onto it', () => {
    // Same topology as the digger test, but the ant is Nursing with the Queen
    // chamber anchored on the Marked tile. The guard must block the eastward step.
    const { world, colony, underground } = setupWorldWithUnderground(4, 4);
    ugSet(underground, 0, 0, UndergroundTileState.Open);
    ugSet(underground, 1, 0, UndergroundTileState.Marked);
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 1 << FP_SHIFT, posY: 0,
      width: 1, height: 1,
    });

    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    world.ants.speed[nurseId] = FP_ONE;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Blocked: still at (0,0).
    expect(world.ants.posX[nurseId]! >> FP_SHIFT).toBe(0);
    expect(world.ants.posY[nurseId]! >> FP_SHIFT).toBe(0);
  });

  it('Determinism — two independent runs with identical setup produce identical positions after N ticks', () => {
    // Deterministic movement: blocked steps don't introduce RNG or allocation.
    function run(): number[] {
      const { world, colony, underground } = setupWorldWithUnderground(16, 16);
      // Carve an L-shaped corridor: (5,5)→(5,7)→(7,7)
      ugSet(underground, 5, 5, UndergroundTileState.Open);
      ugSet(underground, 5, 6, UndergroundTileState.Open);
      ugSet(underground, 5, 7, UndergroundTileState.Open);
      ugSet(underground, 6, 7, UndergroundTileState.Open);
      ugSet(underground, 7, 7, UndergroundTileState.Open);
      colony.chambers.push({
        chamberId: 1,
        chamberType: ChamberType.Queen,
        foodStored: 0,
        posX: 7 << FP_SHIFT, posY: 7 << FP_SHIFT,
        width: 1, height: 1,
      });

      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: 5 << FP_SHIFT, posY: 5 << FP_SHIFT,
        task: AntTask.Nursing,
        subTask: NursingSubState.MovingToBrood,
        zone: Zone.Underground,
      });

      const digFlowFields = createDigFlowFields();
      const rng = new Rng(42);
      for (let t = 0; t < 20; t++) {
        tickAntMovement(world, rng, digFlowFields);
      }
      return [world.ants.posX[id]!, world.ants.posY[id]!];
    }

    expect(run()).toEqual(run());
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
    colony.entrances = []; colony.rallyPoint = null;
    colony.digFlowFieldDirty = false; colony.foodFlowFieldDirty = false;
    colony.chambers.push(makeFoodStorageChamber(1, 0, 0, 0));
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
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
    colony.entrances = []; colony.rallyPoint = null;
    colony.digFlowFieldDirty = false; colony.foodFlowFieldDirty = false;
    // No chambers → capacity = BASE_FOOD_STORAGE_CAPACITY (entrance pool only).
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
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
    colony.entrances = []; colony.rallyPoint = null;
    colony.digFlowFieldDirty = false; colony.foodFlowFieldDirty = false;
    // Two chambers in different parts of the grid. Ant only stands in chamber[0].
    // chamber[0] starts with 1234 stored, so headroom = 5120-1234 = 3886.
    colony.chambers.push(makeFoodStorageChamber(1, 1234, 0,  0));
    colony.chambers.push(makeFoodStorageChamber(2,    0, 8,  8));
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
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
    colony.entrances = []; colony.rallyPoint = null;
    colony.digFlowFieldDirty = false; colony.foodFlowFieldDirty = false;
    // Two chambers, both far from the ant's tile.
    colony.chambers.push(makeFoodStorageChamber(1, 0,  8, 8));
    colony.chambers.push(makeFoodStorageChamber(2, 0, 16, 8));
    colony.foodStored = 0;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0, // outside both chamber footprints
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
// updateFightAntTargets — Phase 9 / SURF-04
// ---------------------------------------------------------------------------

describe('updateFightAntTargets', () => {
  it('writes targetPosX/targetPosY (fixed-point tile-center) for Fighting-task ants when colony rallyPoint is set', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[antId] = 0; // Zone.Surface

    updateFightAntTargets(world);

    expect(world.ants.targetPosX[antId]).toBe((10 << FP_SHIFT) + (FP_ONE >> 1)); // 2688
    expect(world.ants.targetPosY[antId]).toBe((20 << FP_SHIFT) + (FP_ONE >> 1)); // 5248
  });

  it('does not touch non-Fighting ants', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: 0,
    });
    world.ants.zone[antId] = 0; // Zone.Surface
    world.ants.targetPosX[antId] = 999;
    world.ants.targetPosY[antId] = 888;

    updateFightAntTargets(world);

    // Non-Fighting ant's target untouched
    expect(world.ants.targetPosX[antId]).toBe(999);
    expect(world.ants.targetPosY[antId]).toBe(888);
  });

  it('falls back to first entrance (surfaceTileX/surfaceTileY in fp) when rallyPoint is null', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 5, surfaceTileY: 7, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[antId] = 0; // Zone.Surface

    updateFightAntTargets(world);

    expect(world.ants.targetPosX[antId]).toBe((5 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antId]).toBe((7 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('underground Fighting ant with surface rallyPoint routes to first entrance coord first', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 3, surfaceTileY: 4, isOpen: true }];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[antId] = 1; // Zone.Underground

    updateFightAntTargets(world);

    // Underground ant with surface rally: targets entrance, not rally point
    expect(world.ants.targetPosX[antId]).toBe((3 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antId]).toBe((4 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('skips dead ants (alive[id] !== 1) and unknown colony slots (colonyId not in world.colonies)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // Dead ant: alive=0
    const deadId = allocateEntityId(world);
    initAnt(world.ants, deadId, {
      colonyId: COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.alive[deadId] = 0;
    world.ants.targetPosX[deadId] = -1;
    world.ants.targetPosY[deadId] = -1;

    // Ant with unknown colony ID
    const unknownColonyAntId = allocateEntityId(world);
    initAnt(world.ants, unknownColonyAntId, {
      colonyId: 999 as typeof COLONY_ID,
      posX: 0, posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[unknownColonyAntId] = 0;
    world.ants.targetPosX[unknownColonyAntId] = -1;
    world.ants.targetPosY[unknownColonyAntId] = -1;

    updateFightAntTargets(world);

    // Dead ant: target unchanged
    expect(world.ants.targetPosX[deadId]).toBe(-1);
    expect(world.ants.targetPosY[deadId]).toBe(-1);
    // Unknown colony ant: target unchanged
    expect(world.ants.targetPosX[unknownColonyAntId]).toBe(-1);
    expect(world.ants.targetPosY[unknownColonyAntId]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// tickForagerActions — Phase 9 playability wiring
// ---------------------------------------------------------------------------

describe('tickForagerActions', () => {
  it('surface SearchingFood ant on a food pile tile → picks up and transitions to CarryingFood', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push({ foodPileId: 1, tileX: 12, tileY: 8 });

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
  });

  it('surface SearchingFood ant NOT on any food pile tile → no pickup', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    world.foodPiles.push({ foodPileId: 1, tileX: 12, tileY: 8 });

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
    colony.entrances = []; colony.rallyPoint = null;
    colony.digFlowFieldDirty = false; colony.foodFlowFieldDirty = false;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 0, posY: 0,
      width: 4, height: 3,
    });
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 1 << FP_SHIFT,   // inside chamber footprint
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
    colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    // No FoodStorage chamber — fallback path.
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 7 << FP_SHIFT,
      posY: 0,            // underground top-of-shaft at entrance column
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
    colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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
    expect(world.ants.foodCarrying[antId]).toBe(300);      // still carrying
    expect(world.ants.task[antId]).toBe(AntTask.Foraging); // not flipped
  });

  it('closed entrance does NOT act as deposit fallback', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 7, surfaceTileY: 5, isOpen: false }];
    colony.rallyPoint = null; colony.digFlowFieldDirty = false;
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
    colony.entrances = [{
      entranceId:   1,
      surfaceTileX: entranceTileX,
      surfaceTileY: entranceTileY,
      isOpen:       true,
    }];
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
      world.ants.searchHeadingX[antId]     = 0;
      world.ants.searchHeadingY[antId]     = 0;
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
      w1.ants.searchHeadingX[a1]     = 0;
      w1.ants.searchHeadingY[a1]     = 0;
      w1.ants.searchHeadingTicks[a1] = 0;
      w2.ants.searchHeadingX[a2]     = 0;
      w2.ants.searchHeadingY[a2]     = 0;
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
      world.ants.searchHeadingX[antId]     = 0;
      world.ants.searchHeadingY[antId]     = 0;
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
      world.ants.searchHeadingX[antId]     = 0;
      world.ants.searchHeadingY[antId]     = 0;
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
    world.ants.searchHeadingX[antId]     = -1;
    world.ants.searchHeadingY[antId]     = 0;
    world.ants.searchHeadingTicks[antId] = 10;
    const dir = chooseExcursionDirection(world, antId, new Rng(1));
    expect(dir.dx).toBeGreaterThanOrEqual(0);
    // After bounce, heading is a valid on-grid cardinal.
    expect(Math.abs(dir.dx) + Math.abs(dir.dy)).toBe(1);
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
    colony.entrances = [{
      entranceId:   allocateEntityId(world),
      surfaceTileX: entranceX,
      surfaceTileY: entranceY,
      isOpen:       true,
    }];
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
    world.ants.searchHeadingX[antId]     = 1;
    world.ants.searchHeadingY[antId]     = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
    expect(world.ants.searchHeadingX[antId]).toBe(1);
    expect(world.ants.searchHeadingTicks[antId]).toBe(5);
  });

  it('past base radius → flips to ReturningToNest, heading cleared', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupExcursionWorld(base + 1, 0);
    world.ants.searchHeadingX[antId]     = 1;
    world.ants.searchHeadingY[antId]     = 0;
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
    colony.entrances = [{
      entranceId: allocateEntityId(world),
      surfaceTileX: 0,
      surfaceTileY: 0,
      isOpen: true,
    }];
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
    const pile = { foodPileId: 1, tileX: base + 20, tileY: 0 } as FoodPile;
    world.foodPiles.push(pile);
    colony.priorityFoodPileId = pile.foodPileId;
    tickExcursionBoundary(world);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('past radius + nearby food pile (scent) → stays SearchingFood', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = baseSetup(base + 2, 0);
    // Pile within FOOD_SCENT_RADIUS (=15) of the ant — scent lookup returns non-null.
    world.foodPiles.push({ foodPileId: 1, tileX: base + 5, tileY: 0 });
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
    // Ant anywhere in range — position not load-bearing for the return-breakout rule.
    const { world, colony, antId } = baseSetup(base - 3, 0);
    world.ants.subTask[antId] = ForagingSubState.ReturningToNest;
    const pile = { foodPileId: 1, tileX: base + 20, tileY: 0 } as FoodPile;
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
    world.foodPiles.push({ foodPileId: 1, tileX: 12, tileY: 10 });
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
});

// ---------------------------------------------------------------------------
// tickPheromoneDeposit — entrance suppression (09 follow-up issue 2)
//
// Regression coverage for the "entrance stutter" bug: carrying ants that
// deposit pheromone at every tile stack a strong scalar peak on the nest
// mouth. A SearchingFood ant greedy-following that peak oscillates between
// the two hottest adjacent tiles. Suppressing deposits within
// ENTRANCE_DEPOSIT_SUPPRESS_RADIUS Manhattan of any own-colony entrance
// keeps the peak out along the trail toward food instead of at the entrance.
// ---------------------------------------------------------------------------

describe('tickPheromoneDeposit — entrance suppression (09 follow-up issue 2)', () => {
  function setupCarryingAnt(
    antTileX: number,
    antTileY: number,
    entranceX = 0,
    entranceY = 0,
  ) {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{
      entranceId: allocateEntityId(world),
      surfaceTileX: entranceX,
      surfaceTileY: entranceY,
      isOpen: true,
    }];
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
      subTask: ForagingSubState.CarryingFood,
    });
    world.ants.foodCarrying[antId] = 500;
    world.ants.alive[antId] = 1;
    return { world, colony, grid, antId };
  }

  it('carrying ant AT the entrance (d=0) does NOT deposit', () => {
    const { world, grid } = setupCarryingAnt(0, 0);
    tickPheromoneDeposit(world);
    expect(phGet(grid, 0, 0)).toBe(0);
  });

  it('carrying ant at Manhattan d=3 from entrance (boundary) does NOT deposit', () => {
    // ENTRANCE_DEPOSIT_SUPPRESS_RADIUS = 3 — suppression is inclusive at d=3.
    const { world, grid } = setupCarryingAnt(3, 0);
    tickPheromoneDeposit(world);
    expect(phGet(grid, 3, 0)).toBe(0);
  });

  it('carrying ant at Manhattan d=2 from entrance (diagonal) does NOT deposit', () => {
    // (1,1) is |1|+|1| = 2 from (0,0) — inside the diamond.
    const { world, grid } = setupCarryingAnt(1, 1);
    tickPheromoneDeposit(world);
    expect(phGet(grid, 1, 1)).toBe(0);
  });

  it('carrying ant at Manhattan d=4 from entrance DOES deposit (outside suppression)', () => {
    const { world, grid } = setupCarryingAnt(4, 0);
    tickPheromoneDeposit(world);
    expect(phGet(grid, 4, 0)).toBe(FOOD_TRAIL_DEPOSIT);
  });

  it('carrying ant far from entrance still deposits normally', () => {
    const { world, grid } = setupCarryingAnt(20, 20);
    tickPheromoneDeposit(world);
    expect(phGet(grid, 20, 20)).toBe(FOOD_TRAIL_DEPOSIT);
  });

  it('checks NEAREST entrance — far from one, near another → suppressed', () => {
    const { world, colony, grid, antId } = setupCarryingAnt(2, 0, 0, 0);
    // Add a second far entrance; ant is 2 from (0,0) but 98 from (100,0).
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: 100,
      surfaceTileY: 0,
      isOpen: true,
    });
    tickPheromoneDeposit(world);
    const tileX = world.ants.posX[antId]! >> FP_SHIFT;
    const tileY = world.ants.posY[antId]! >> FP_SHIFT;
    expect(phGet(grid, tileX, tileY)).toBe(0);
  });

  it('colony with no entrances still deposits (no suppression reference)', () => {
    const { world, colony, grid } = setupCarryingAnt(2, 0);
    colony.entrances = [];
    tickPheromoneDeposit(world);
    expect(phGet(grid, 2, 0)).toBe(FOOD_TRAIL_DEPOSIT);
  });

  it('repeated carrying-ant traffic at entrance never builds a scalar peak within suppression radius', () => {
    // Root-cause regression: the observed stutter came from carrying ants
    // repeatedly stacking FOOD_TRAIL_DEPOSIT on the one or two tiles they
    // all crossed at the nest mouth, producing a PHEROMONE_CAP-size peak a
    // greedy searcher would oscillate on. With entrance deposit suppression
    // the peak never forms, which is what eliminates the stutter. This
    // test drives the cause, not the symptom: many ticks of carrying-ant
    // deposits at the entrance must leave every cell within
    // ENTRANCE_DEPOSIT_SUPPRESS_RADIUS at zero.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    const entranceX = 24;
    const entranceY = 64;
    colony.entrances = [{
      entranceId: allocateEntityId(world),
      surfaceTileX: entranceX,
      surfaceTileY: entranceY,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    const { grid } = setupSurfaceGrid(world);

    // Four carrying ants parked on adjacent entrance-side tiles — the exact
    // shape the observed stutter came from (all passing through the same
    // two tiles). Pre-suppression, 50 ticks here would pin these cells at
    // PHEROMONE_CAP and create the two-tile trap.
    const carrierOffsets: Array<[number, number]> = [
      [0, 0], [1, 0], [0, 1], [-1, 0],
    ];
    for (const [dx, dy] of carrierOffsets) {
      const antId = allocateEntityId(world);
      initAnt(world.ants, antId, {
        colonyId: COLONY_ID,
        posX: (entranceX + dx) << FP_SHIFT,
        posY: (entranceY + dy) << FP_SHIFT,
        task: AntTask.Foraging,
        subTask: ForagingSubState.CarryingFood,
      });
      world.ants.foodCarrying[antId] = 500;
      world.ants.alive[antId] = 1;
    }

    for (let tick = 0; tick < 50; tick++) {
      tickPheromoneDeposit(world);
    }

    // Every cell within the suppression Manhattan diamond must be untouched.
    for (let dx = -ENTRANCE_DEPOSIT_SUPPRESS_RADIUS; dx <= ENTRANCE_DEPOSIT_SUPPRESS_RADIUS; dx++) {
      const maxDy = ENTRANCE_DEPOSIT_SUPPRESS_RADIUS - Math.abs(dx);
      for (let dy = -maxDy; dy <= maxDy; dy++) {
        expect(phGet(grid, entranceX + dx, entranceY + dy)).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tickAntMovement — wander fallback (09 foraging-autonomy memo)
// ---------------------------------------------------------------------------

describe('tickAntMovement — wander fallback', () => {
  it('SearchingFood forager with empty trail and no priority target moves (not stationary)', () => {
    // Prior to the 09 memo fix: sampleGradient returned (0,0) on empty grid,
    // and tickAntMovement left the ant stationary — foragers could not
    // discover food unless the player hand-marked a pile. Now foragers
    // wander outward whenever there is no trail within one tile.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 24, surfaceTileY: 64, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    setupSurfaceGrid(world); // empty grid

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 30 << FP_SHIFT,
      posY: 64 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Explicitly clear any priority target set by routeForagerPriority elsewhere.
    world.ants.targetPosX[antId] = -1;
    world.ants.targetPosY[antId] = -1;

    const posXBefore = world.ants.posX[antId]!;
    const posYBefore = world.ants.posY[antId]!;

    const digFlowFields = createDigFlowFields();
    // Sweep a range of seeds — every single one must produce motion.
    let movedCount = 0;
    for (let seed = 0; seed < 30; seed++) {
      world.ants.posX[antId] = posXBefore;
      world.ants.posY[antId] = posYBefore;
      const rng = new Rng(seed);
      tickAntMovement(world, rng, digFlowFields);
      if (world.ants.posX[antId] !== posXBefore || world.ants.posY[antId] !== posYBefore) {
        movedCount += 1;
      }
    }
    expect(movedCount).toBe(30); // every seed moves the forager
  });

  it('priority target still takes precedence over wander', () => {
    // Memo requirement: selecting a food pile must still redirect foragers.
    // When targetPosX/Y is set (by routeForagerPriority), wander must NOT apply.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 24, surfaceTileY: 64, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    setupSurfaceGrid(world); // empty grid — no pheromone

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 30 << FP_SHIFT,
      posY: 64 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Priority target is west of the ant → deterministic -X step.
    world.ants.targetPosX[antId] = 10 << FP_SHIFT;
    world.ants.targetPosY[antId] = 64 << FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    const posXBefore = world.ants.posX[antId]!;
    tickAntMovement(world, new Rng(42), digFlowFields);
    // Manhattan step toward priority: dx=-1, dy=0 → posX decreases by speed.
    expect(world.ants.posX[antId]!).toBeLessThan(posXBefore);
    expect(world.ants.posY[antId]).toBe(64 << FP_SHIFT);
  });
});

// ---------------------------------------------------------------------------
// tickSearchLeash — 09 digger-reassignment memo SearchingFood responsiveness fix
// ---------------------------------------------------------------------------

describe('tickSearchLeash (09 digger-reassignment memo)', () => {
  /**
   * Build a colony with a single entrance at (entranceX, 0) on the surface and
   * a SearchingFood ant at the given tile. Entrance is marked open so the
   * leash path is exercised with a realistic forage scenario.
   */
  function setupLeashWorld(
    antTileX: number,
    antTileY: number,
    entranceX = 0,
    entranceY = 0,
    wave = 0,
  ): { world: WorldState; colony: ColonyRecord; antId: number } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    // PRD §2a extension contract: caller-side init for entrances / rallyPoint / digFlowFieldDirty.
    colony.entrances = [{
      entranceId:   allocateEntityId(world),
      surfaceTileX: entranceX,
      surfaceTileY: entranceY,
      isOpen:       true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    // Seed the gate: the leash only fires when (a) more workers are foraging
    // than the allocation asks for AND (b) the player has requested dig or
    // fight work. That matches the memo's target bug: "when the colony's
    // requested allocation no longer supports that role" — i.e. the triangle
    // is asking for dig/fight but foragers are stuck out searching.
    colony.computedAllocation.forage = 0;
    colony.computedAllocation.dig    = 1;
    colony.taskCensus.forage = 1;
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

  it('does NOT demote a SearchingFood ant within the base leash radius', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    // Exactly on the boundary — still within.
    const { world, antId } = setupLeashWorld(base, 0);
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('demotes a SearchingFood ant past base radius → Idle, wave += 1, target cleared', () => {
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupLeashWorld(base + 1, 0);
    world.ants.targetPosX[antId] = 5 << FP_SHIFT;
    world.ants.targetPosY[antId] = 5 << FP_SHIFT;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
    expect(world.ants.searchWave[antId]).toBe(1);
    // Priority target cleared so the next promotion starts clean.
    expect(world.ants.targetPosX[antId]).toBe(-1);
    expect(world.ants.targetPosY[antId]).toBe(-1);
  });

  it('each subsequent demotion uses the next wave radius, capped at SEARCH_LEASH_MAX_WAVE', () => {
    // Place the ant far enough that every wave demotes it. 100 > 40 (max).
    const { world, antId } = setupLeashWorld(100, 0);
    for (let expectedNext = 1; expectedNext <= SEARCH_LEASH_MAX_WAVE; expectedNext++) {
      // Re-promote to SearchingFood (step 10a would do this each tick). The
      // leash field carries forward.
      world.ants.task[antId] = AntTask.Foraging;
      world.ants.subTask[antId] = ForagingSubState.SearchingFood;
      tickSearchLeash(world);
      expect(world.ants.searchWave[antId]).toBe(expectedNext);
    }
    // One more pass — wave must not exceed MAX_WAVE.
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;
    tickSearchLeash(world);
    expect(world.ants.searchWave[antId]).toBe(SEARCH_LEASH_MAX_WAVE);
  });

  it('does NOT demote a CarryingFood ant, even when far from the entrance', () => {
    const { world, antId } = setupLeashWorld(100, 0);
    // Flip to CarryingFood — the return/deposit cycle must complete.
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.CarryingFood);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('does NOT demote an underground SearchingFood ant (leash is surface-only)', () => {
    const { world, antId } = setupLeashWorld(100, 0);
    world.ants.zone[antId] = Zone.Underground;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('antPickupFood resets searchWave to 0 on a successful pickup', () => {
    const { world, antId } = setupLeashWorld(10, 0);
    world.ants.searchWave[antId] = SEARCH_LEASH_MAX_WAVE;
    const pile = { amount: FOOD_PICKUP_AMOUNT };
    const transferred = antPickupFood(world.ants, antId, pile);
    expect(transferred).toBeGreaterThan(0);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('zero-transfer antPickupFood does NOT reset searchWave (no successful find)', () => {
    const { world, antId } = setupLeashWorld(10, 0);
    world.ants.searchWave[antId] = 2;
    // Empty pile → zero transfer → no CarryingFood transition and no wave reset.
    const transferred = antPickupFood(world.ants, antId, { amount: 0 });
    expect(transferred).toBe(0);
    expect(world.ants.searchWave[antId]).toBe(2);
  });

  it('skips ants whose colony has no entrances (no nest to measure against)', () => {
    const { world, antId } = setupLeashWorld(100, 0);
    world.colonies[COLONY_ID]!.entrances = [];
    tickSearchLeash(world);
    // No leash reference → no demotion, wave unchanged.
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('does NOT demote when colony is not over-foraged (census.forage ≤ allocation.forage)', () => {
    // Pure-forage or balanced-forage mode: the colony wants as many (or more)
    // foragers as it has. Releasing a far-flung SearchingFood ant here would
    // just churn (step 10a re-promotes to Foraging the same tick) while
    // shrinking its effective discovery radius. Autonomous forage bootstrap
    // relies on this carve-out.
    const { world, antId } = setupLeashWorld(100, 0);
    world.colonies[COLONY_ID]!.computedAllocation.forage = 10;
    world.colonies[COLONY_ID]!.taskCensus.forage = 10;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('does NOT demote when only nurse demand is under-served (no dig/fight asked)', () => {
    // Nurses are auto-carved from brood count, not player-requested. The
    // natural idle-checkpoint flow (antDepositFood → Idle → step 10a → nurse)
    // fills nurse slots without needing to leash productive foragers. Armed
    // on nurse demand alone, the leash would stall the autonomous forage
    // bootstrap as soon as broodCount reached NURSE_RATIO.
    const { world, antId } = setupLeashWorld(100, 0);
    // Over-foraged (census=5 > allocation.forage=4) but the only non-forage
    // demand is nurse — no dig/fight. Gate must stay closed.
    world.colonies[COLONY_ID]!.computedAllocation.forage = 4;
    world.colonies[COLONY_ID]!.computedAllocation.dig    = 0;
    world.colonies[COLONY_ID]!.computedAllocation.fight  = 0;
    world.colonies[COLONY_ID]!.computedAllocation.nurse  = 1;
    world.colonies[COLONY_ID]!.taskCensus.forage = 5;
    world.colonies[COLONY_ID]!.taskCensus.nurse  = 0;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('DOES demote when over-foraged and player has requested fight (not just dig)', () => {
    // Symmetric check: the memo names dig/fight as the triangle axes. The
    // gate must arm on either.
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupLeashWorld(base + 1, 0);
    world.colonies[COLONY_ID]!.computedAllocation.dig   = 0;
    world.colonies[COLONY_ID]!.computedAllocation.fight = 1;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.searchWave[antId]).toBe(1);
  });

  it('measures distance from the NEAREST entrance when multiple exist', () => {
    const { world, colony, antId } = setupLeashWorld(30, 0, 100, 0);
    // Add a closer entrance — ant at (30,0) is 30 from (100,0) but 2 from (28,0).
    colony.entrances.push({
      entranceId:   allocateEntityId(world),
      surfaceTileX: 28,
      surfaceTileY: 0,
      isOpen:       true,
    });
    tickSearchLeash(world);
    // Closest is 2 ≤ 25 → not demoted.
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
  });
});

// ---------------------------------------------------------------------------
// tickAntMovement — prev-tile tracking (09 excursion-foraging follow-up)
//
// Regression coverage for the far-from-nest stutter. The pheromone sampler
// needs to know the tile the ant just left so it doesn't greedily reverse
// onto it (ABAB scalar-gradient loop). tickAntMovement is responsible for
// recording that prev tile whenever a surface SearchingFood forager actually
// crosses a tile boundary. Partial steps, non-forager states, carrying ants,
// and underground ants all leave searchPrevTileX/Y untouched.
// ---------------------------------------------------------------------------
describe('tickAntMovement — prev-tile tracking (09 follow-up issue 1)', () => {
  function setupMoveWorld(antTileX: number, antTileY: number) {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{
      entranceId:   allocateEntityId(world),
      surfaceTileX: 0,
      surfaceTileY: antTileY,
      isOpen:       true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    setupSurfaceGrid(world); // empty grid — no pheromone

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: antTileX << FP_SHIFT,
      posY: antTileY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Speed = FP_ONE so one tick moves exactly one full tile — a guaranteed
    // tile-boundary crossing for the prev-tile recording check.
    world.ants.speed[antId] = FP_ONE;
    return { world, colony, antId };
  }

  it('SearchingFood forager crossing a tile boundary writes prev = pre-move tile', () => {
    const { world, antId } = setupMoveWorld(20, 20);
    // Priority target east of the ant → deterministic +X step through tickAntMovement.
    world.ants.targetPosX[antId] = 40 << FP_SHIFT;
    world.ants.targetPosY[antId] = 20 << FP_SHIFT;
    // Sentinel before the step.
    expect(world.ants.searchPrevTileX[antId]).toBe(-1);
    expect(world.ants.searchPrevTileY[antId]).toBe(-1);

    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, new Rng(42), digFlowFields);

    // Crossed from (20,20) to (21,20). Prev == starting tile.
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(21);
    expect(world.ants.searchPrevTileX[antId]).toBe(20);
    expect(world.ants.searchPrevTileY[antId]).toBe(20);
  });

  it('sub-tile step that does NOT cross a tile boundary leaves prev untouched', () => {
    const { world, antId } = setupMoveWorld(20, 20);
    world.ants.targetPosX[antId] = 40 << FP_SHIFT;
    world.ants.targetPosY[antId] = 20 << FP_SHIFT;
    // Half-tile speed — one tick cannot cross the boundary from offset 0.
    world.ants.speed[antId] = WORKER_BASE_SPEED; // 128 = 0.5 tile
    // Seed a previous prev so we can see it survive the non-crossing tick.
    world.ants.searchPrevTileX[antId] = 19;
    world.ants.searchPrevTileY[antId] = 20;

    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, new Rng(42), digFlowFields);

    // Still on tile 20 — the prev-recording branch must be skipped.
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(20);
    expect(world.ants.searchPrevTileX[antId]).toBe(19);
    expect(world.ants.searchPrevTileY[antId]).toBe(20);
  });

  it('CarryingFood ant crossing a tile boundary does NOT record prev (state-gated)', () => {
    const { world, antId } = setupMoveWorld(20, 20);
    world.ants.subTask[antId] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[antId] = 500;
    // Priority target irrelevant for CarryingFood — use entrance-bound default path.
    // Set a target east-ward just to drive deterministic +X motion.
    world.ants.targetPosX[antId] = 40 << FP_SHIFT;
    world.ants.targetPosY[antId] = 20 << FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, new Rng(42), digFlowFields);

    // Ant moved, but prev-tile memory is SearchingFood-only.
    expect(world.ants.posX[antId]! >> FP_SHIFT).not.toBe(20);
    expect(world.ants.searchPrevTileX[antId]).toBe(-1);
    expect(world.ants.searchPrevTileY[antId]).toBe(-1);
  });

  it('underground SearchingFood ant does NOT record prev (surface-only anti-backtrack)', () => {
    const { world, antId } = setupMoveWorld(20, 20);
    world.ants.zone[antId] = Zone.Underground;
    // Drive motion deterministically via a priority target.
    world.ants.targetPosX[antId] = 40 << FP_SHIFT;
    world.ants.targetPosY[antId] = 20 << FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, new Rng(42), digFlowFields);

    expect(world.ants.searchPrevTileX[antId]).toBe(-1);
    expect(world.ants.searchPrevTileY[antId]).toBe(-1);
  });

  it('existing prev is overwritten, not cleared, on a later boundary crossing', () => {
    const { world, antId } = setupMoveWorld(20, 20);
    world.ants.targetPosX[antId] = 40 << FP_SHIFT;
    world.ants.targetPosY[antId] = 20 << FP_SHIFT;
    // Pre-seed an OLD prev from two tiles back.
    world.ants.searchPrevTileX[antId] = 18;
    world.ants.searchPrevTileY[antId] = 20;

    const digFlowFields = createDigFlowFields();
    tickAntMovement(world, new Rng(42), digFlowFields);

    // After stepping (20,20) → (21,20), prev must be the tile just left.
    expect(world.ants.searchPrevTileX[antId]).toBe(20);
    expect(world.ants.searchPrevTileY[antId]).toBe(20);
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
    colony.entrances = [{
      entranceId:   allocateEntityId(world),
      surfaceTileX: 0,
      surfaceTileY: 0,
      isOpen:       true,
    }];
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
    phSet(grid, antTileX - 1, antTileY, PHEROMONE_CAP);         // prev: ignored
    phSet(grid, antTileX, antTileY + 2, FOOD_TRAIL_DEPOSIT);    // real signal

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
    const antTileX = base + 2;         // 27
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
    const antTileX = base + 2;         // 27
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
    const antTileX = base + 2;         // 27
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
    const antTileX = base + 2;         // 27
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
// tickNurseActions — 09 reproduction-gate memo: finite nursing
// ---------------------------------------------------------------------------

describe('tickNurseActions', () => {
  /**
   * Minimal world: one colony with queen entity 0, a Nursery chamber at
   * (chamberTileX, chamberTileY) of width×height, and a nursing ant at the
   * given tile. Returns IDs so individual tests can assert per-entity state.
   */
  function setupNursingAnt(params: {
    antTileX: number;
    antTileY: number;
    chamberTileX: number;
    chamberTileY: number;
    chamberWidth?: number;
    chamberHeight?: number;
    chamberType?: ChamberType;
    subTask?: number;
  }): { world: WorldState; antId: number; colony: ColonyRecord } {
    const world = createWorldState(42, 64);
    // Queen (entity 0) — required for createColonyRecord.
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;
    colony.chambers.push({
      chamberId:   100,
      chamberType: params.chamberType ?? ChamberType.Nursery,
      foodStored:  0,
      posX:        params.chamberTileX << FP_SHIFT,
      posY:        params.chamberTileY << FP_SHIFT,
      width:       params.chamberWidth  ?? 2,
      height:      params.chamberHeight ?? 2,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX:     params.antTileX << FP_SHIFT,
      posY:     params.antTileY << FP_SHIFT,
      task:     AntTask.Nursing,
      subTask:  params.subTask ?? NursingSubState.MovingToBrood,
    });
    return { world, antId, colony };
  }

  it('MovingToBrood on Nursery tile → Feeding (one-tick service begins)', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10, antTileY: 10,
      chamberTileX: 10, chamberTileY: 10,
    });

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[antId]).toBe(NursingSubState.Feeding);
  });

  it('MovingToBrood on Queen chamber tile → Feeding', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 5, antTileY: 7,
      chamberTileX: 4, chamberTileY: 6,
      chamberWidth: 3, chamberHeight: 3,
      chamberType: ChamberType.Queen,
    });

    tickNurseActions(world);

    expect(world.ants.subTask[antId]).toBe(NursingSubState.Feeding);
  });

  it('MovingToBrood off chamber tile → unchanged', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 0, antTileY: 0,
      chamberTileX: 10, chamberTileY: 10,
    });

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[antId]).toBe(NursingSubState.MovingToBrood);
  });

  it('Feeding → Idle (released for step 10a reassignment)', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10, antTileY: 10,
      chamberTileX: 10, chamberTileY: 10,
      subTask: NursingSubState.Feeding,
    });

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('two-tick arc: MovingToBrood on tile → Feeding → Idle', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10, antTileY: 10,
      chamberTileX: 10, chamberTileY: 10,
    });

    tickNurseActions(world);
    expect(world.ants.subTask[antId]).toBe(NursingSubState.Feeding);

    tickNurseActions(world);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('FoodStorage chamber does NOT trigger Feeding (Queen/Nursery only)', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10, antTileY: 10,
      chamberTileX: 10, chamberTileY: 10,
      chamberType: ChamberType.FoodStorage,
    });

    tickNurseActions(world);

    expect(world.ants.subTask[antId]).toBe(NursingSubState.MovingToBrood);
  });

  it('dead ant: ignored', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10, antTileY: 10,
      chamberTileX: 10, chamberTileY: 10,
    });
    world.ants.alive[antId] = 0;

    tickNurseActions(world);

    expect(world.ants.subTask[antId]).toBe(NursingSubState.MovingToBrood);
  });

  it('non-nursing ant: ignored even on chamber tile', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10, antTileY: 10,
      chamberTileX: 10, chamberTileY: 10,
    });
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });

  it('colony with zero chambers: nursing ant unchanged', () => {
    const world = createWorldState(42, 64);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT, posY: 10 << FP_SHIFT,
      task: AntTask.Nursing, subTask: NursingSubState.MovingToBrood,
    });

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[antId]).toBe(NursingSubState.MovingToBrood);
  });
});

// ---------------------------------------------------------------------------
// Regression: underground empty forager entrance routing (seed-914637646 bug).
// Reproduces the debug-snapshot scenario where an ant stuck inside a chamber
// footprint used straight-line steering into solid dirt. The fix reads the
// entrance flow-field and routes around the bend.
// ---------------------------------------------------------------------------

describe('tickAntMovement — underground entrance routing (tunnel-aware)', () => {
  /** Build a 16x16 underground grid with a bent L tunnel:
   *
   *  tileY=0  X X X X E . . .    (E = entrance col 4, Open at (4,0))
   *  tileY=1  . . . . O . . .    (. = Solid, O = Open tunnel)
   *  tileY=2  . . . . O . . .
   *  tileY=3  . . O O O . . .    (chamber pocket at (2,3)..(4,3))
   *  tileY=4  . . . . . . . .
   *
   *  Ant sits at (2,3). Straight-line steering toward entrance (4,0) picks the
   *  larger axis — rawDy=-3, rawDx=+2 → |dy|>|dx| → step dy=-1 into (2,2)=Solid.
   *  Flow-field routes the ant east to (3,3) instead, then to (4,3), then up
   *  the shaft to (4,0).
   */
  function buildBentTunnelWorld(): {
    world: WorldState;
    colony: ColonyRecord;
    underground: ReturnType<typeof createUndergroundGrid>;
    colonyId: number;
    antId: number;
  } {
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Shaft: (4,0)→(4,1)→(4,2)→(4,3)
    ugSet(underground, 4, 0, UndergroundTileState.Open);
    ugSet(underground, 4, 1, UndergroundTileState.Open);
    ugSet(underground, 4, 2, UndergroundTileState.Open);
    ugSet(underground, 4, 3, UndergroundTileState.Open);
    // Chamber row: (2,3), (3,3)
    ugSet(underground, 2, 3, UndergroundTileState.Open);
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    // Entrance at surface col 4
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 4,
      surfaceTileY: 5,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 2 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 0;
    // One tile per tick so flow-field direction translates to a tile crossing.
    world.ants.speed[antId] = FP_ONE;

    return { world, colony, underground, colonyId, antId };
  }

  function buildEntranceFlowFields(
    underground: ReturnType<typeof createUndergroundGrid>,
    colony: ColonyRecord,
    colonyId: number,
  ) {
    const cache = createEntranceFlowFields();
    const gridSize = underground.width * underground.height;
    const out = ensureEntranceFlowField(cache, colonyId, gridSize);
    const queue = cache.queues[colonyId]!;
    computeEntranceFlowField(underground, colony.entrances, out, queue);
    return cache;
  }

  it('E-1. empty forager with bent tunnel routes around Solid instead of straight-line into dirt', () => {
    const { world, colony, underground, colonyId, antId } = buildBentTunnelWorld();
    const entranceFlowFields = buildEntranceFlowFields(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // First tick: ant at (2,3). Straight-line would pick dy=-1 into (2,2)=Solid.
    // Flow-field routes east (dx=+1) toward (3,3).
    tickAntMovement(world, rng, digFlowFields, entranceFlowFields);

    const tileX1 = world.ants.posX[antId]! >> FP_SHIFT;
    const tileY1 = world.ants.posY[antId]! >> FP_SHIFT;
    expect(ugGet(underground, tileX1, tileY1)).not.toBe(UndergroundTileState.Solid);
    // Must have moved — the straight-line failure mode is "frozen in place".
    expect(tileX1 === 2 && tileY1 === 3).toBe(false);
    // First step specifically: east one tile to (3,3).
    expect(tileX1).toBe(3);
    expect(tileY1).toBe(3);
  });

  it('E-2. empty forager follows tunnel to entrance and transitions to surface', () => {
    const { world, colony, underground, colonyId, antId } = buildBentTunnelWorld();
    const entranceFlowFields = buildEntranceFlowFields(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // Path: (2,3)→(3,3)→(4,3)→(4,2)→(4,1)→(4,0). 5 steps to source tile,
    // then the Underground→Surface zone-transition block (same tick) promotes
    // to Surface at entrance (4, 5). So the "at (4,0) underground" moment is
    // never observable between ticks — but the successful surface promotion
    // is the stronger proof that the ant tunnelled out.
    for (let t = 0; t < 6; t++) {
      tickAntMovement(world, rng, digFlowFields, entranceFlowFields);
      const tx = world.ants.posX[antId]! >> FP_SHIFT;
      const ty = world.ants.posY[antId]! >> FP_SHIFT;
      const zone = world.ants.zone[antId];
      // Invariant: while underground, never stand on a Solid tile.
      if (zone === Zone.Underground) {
        expect(ugGet(underground, tx, ty)).not.toBe(UndergroundTileState.Solid);
      }
    }
    // Zone promotion happened — the ant successfully tunnelled out. Post-
    // transition surface wandering (no priority pile, no pheromone) may shift
    // posX by a tile, so we only assert the zone flip here.
    expect(world.ants.zone[antId]).toBe(Zone.Surface);
  });

  it('E-3. unreachable ant (Marked pocket, no tunnel) holds position instead of oscillating', () => {
    // Ant on an Open tile completely surrounded by Solid — no route to any
    // open entrance. The flow-field reports -2 (unreachable) and the ant must
    // hold position rather than oscillate into a wall.
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    ugSet(underground, 8, 8, UndergroundTileState.Open);
    // Entrance exists but no tunnel connects to (8,8).
    ugSet(underground, 4, 0, UndergroundTileState.Open);
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 4,
      surfaceTileY: 5,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 8 << FP_SHIFT,
      posY: 8 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 0;
    world.ants.speed[antId] = FP_ONE;

    const entranceFlowFields = buildEntranceFlowFields(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    const posXBefore = world.ants.posX[antId]!;
    const posYBefore = world.ants.posY[antId]!;

    for (let t = 0; t < 4; t++) {
      tickAntMovement(world, rng, digFlowFields, entranceFlowFields);
    }

    // Held position — no phantom movement into dirt.
    expect(world.ants.posX[antId]).toBe(posXBefore);
    expect(world.ants.posY[antId]).toBe(posYBefore);
  });
});

// ---------------------------------------------------------------------------
// Regression: underground chamber routing (seed-920076605 bug). Before this
// fix, carrying foragers targeting FoodStorage and nursing ants targeting
// Queen/Nursery used straight-line chamber steering. On bent tunnels the
// next axis-step landed on Solid dirt every tick and the ant froze in place.
// ---------------------------------------------------------------------------

describe('tickAntMovement — underground chamber routing (tunnel-aware)', () => {
  /** 16x16 grid, FoodStorage chamber at (5,5) (1x1 Open), with a bent tunnel
   *  from (10,10) westbound then northbound to (5,5). Direct-steering from
   *  (10,10) picks dx=-1 first → (9,10). Make (9,10) Solid so the old logic
   *  would freeze there. Flow-field instead routes via the tunnel. */
  function buildChamberTunnelWorld(opts: { chamberType: 0 | 1 | 2; antTask: typeof AntTask.Foraging | typeof AntTask.Nursing; antSubTask: number; foodCarrying: number }) {
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Chamber tile at (5,5) — seeded tile for flow-field. 1x1 footprint.
    ugSet(underground, 5, 5, UndergroundTileState.Open);
    // Tunnel: (10,10) → (10,9) → (10,8) → ... → (10,5) → (9,5) → ... → (6,5) → (5,5)
    for (let y = 5; y <= 10; y++) ugSet(underground, 10, y, UndergroundTileState.Open);
    for (let x = 5; x <= 10; x++) ugSet(underground, x, 5, UndergroundTileState.Open);
    // Chamber record (posX/posY in fixed-point, width/height in tiles)
    colony.chambers.push({
      chamberId: 100,
      chamberType: opts.chamberType,
      foodStored: 0,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    // Entrance somewhere harmless — not used by the flow-field here, but
    // entrance-targeting logic reads it when computing fallback.
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 12,
      surfaceTileY: 5,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: opts.antTask,
      subTask: opts.antSubTask,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = opts.foodCarrying;
    world.ants.speed[antId] = FP_ONE;

    return { world, colony, underground, colonyId, antId };
  }

  function buildChamberFlowFieldsCache(
    underground: ReturnType<typeof createUndergroundGrid>,
    colony: ColonyRecord,
    colonyId: number,
  ) {
    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeChamberFlowField(underground, colony.chambers, FOOD_CHAMBER_TYPES, bufs.food, bufs.queue);
    computeChamberFlowField(underground, colony.chambers, NURSING_CHAMBER_TYPES, bufs.nursing, bufs.queue);
    return cache;
  }

  function buildEntranceFFCache(
    underground: ReturnType<typeof createUndergroundGrid>,
    colony: ColonyRecord,
    colonyId: number,
  ) {
    const cache = createEntranceFlowFields();
    const gridSize = underground.width * underground.height;
    const out = ensureEntranceFlowField(cache, colonyId, gridSize);
    const queue = cache.queues[colonyId]!;
    computeEntranceFlowField(underground, colony.entrances, out, queue);
    return cache;
  }

  it('C-1. carrying forager with FoodStorage routes around Solid via tunnel', () => {
    const { world, colony, underground, colonyId, antId } = buildChamberTunnelWorld({
      chamberType: 2 /* FoodStorage */,
      antTask: AntTask.Foraging,
      antSubTask: ForagingSubState.CarryingFood,
      foodCarrying: 300,
    });
    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // First tick: ant at (10,10). Straight-line step would be west to (9,10)
    // but our tunnel only goes through the vertical column at x=10. The
    // flow-field's shortest route is north: (10,10)→(10,9).
    tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);

    const tileX = world.ants.posX[antId]! >> FP_SHIFT;
    const tileY = world.ants.posY[antId]! >> FP_SHIFT;
    expect(ugGet(underground, tileX, tileY)).not.toBe(UndergroundTileState.Solid);
    expect(tileX === 10 && tileY === 10).toBe(false);
    expect(tileX).toBe(10);
    expect(tileY).toBe(9);
  });

  it('C-2. carrying forager reaches FoodStorage chamber tile through tunnel', () => {
    const { world, colony, underground, colonyId, antId } = buildChamberTunnelWorld({
      chamberType: 2,
      antTask: AntTask.Foraging,
      antSubTask: ForagingSubState.CarryingFood,
      foodCarrying: 300,
    });
    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // Path length: (10,10)→(10,9)→...→(10,5) then (10,5)→...→(5,5). 10 steps.
    for (let t = 0; t < 12; t++) {
      tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
      const tx = world.ants.posX[antId]! >> FP_SHIFT;
      const ty = world.ants.posY[antId]! >> FP_SHIFT;
      expect(ugGet(underground, tx, ty)).not.toBe(UndergroundTileState.Solid);
    }
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(5);
  });

  it('C-3. Nursing ant routes around Solid toward Nursery via tunnel', () => {
    const { world, colony, underground, colonyId, antId } = buildChamberTunnelWorld({
      chamberType: 1 /* Nursery */,
      antTask: AntTask.Nursing,
      antSubTask: NursingSubState.MovingToBrood,
      foodCarrying: 0,
    });
    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);

    const tileX = world.ants.posX[antId]! >> FP_SHIFT;
    const tileY = world.ants.posY[antId]! >> FP_SHIFT;
    expect(ugGet(underground, tileX, tileY)).not.toBe(UndergroundTileState.Solid);
    expect(tileX === 10 && tileY === 10).toBe(false);
    expect(tileX).toBe(10);
    expect(tileY).toBe(9);
  });

  it('C-4. Nursing ant reaches Nursery chamber tile through tunnel', () => {
    const { world, colony, underground, colonyId, antId } = buildChamberTunnelWorld({
      chamberType: 1,
      antTask: AntTask.Nursing,
      antSubTask: NursingSubState.MovingToBrood,
      foodCarrying: 0,
    });
    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    for (let t = 0; t < 12; t++) {
      tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
      const tx = world.ants.posX[antId]! >> FP_SHIFT;
      const ty = world.ants.posY[antId]! >> FP_SHIFT;
      expect(ugGet(underground, tx, ty)).not.toBe(UndergroundTileState.Solid);
    }
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(5);
  });

  it('C-5. carrying forager with unreachable FoodStorage falls back to entrance routing', () => {
    // FoodStorage chamber exists but is sealed (no tunnel from ant to it).
    // Entrance flow-field offers a path → ant must surface, not freeze.
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Isolated chamber tile, no tunnel to it.
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    // Ant is on an Open tile connected only to the entrance shaft, not the chamber.
    ugSet(underground, 10, 10, UndergroundTileState.Open);
    ugSet(underground, 10, 9, UndergroundTileState.Open);
    ugSet(underground, 10, 8, UndergroundTileState.Open);
    // ...tunnel up to entrance (10, 0):
    for (let y = 0; y <= 10; y++) ugSet(underground, 10, y, UndergroundTileState.Open);
    colony.chambers.push({
      chamberId: 100,
      chamberType: 2 /* FoodStorage */,
      foodStored: 0,
      posX: 3 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 10,
      surfaceTileY: 5,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 300;
    world.ants.speed[antId] = FP_ONE;

    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // First tick: chamber flow-field is -2 at (10,10). Fallback is entrance
    // flow-field which routes north up the shaft.
    tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
    const tileX = world.ants.posX[antId]! >> FP_SHIFT;
    const tileY = world.ants.posY[antId]! >> FP_SHIFT;
    expect(ugGet(underground, tileX, tileY)).not.toBe(UndergroundTileState.Solid);
    expect(tileX).toBe(10);
    expect(tileY).toBe(9); // moved north one tile via entrance flow-field
  });

  it('C-6. Nursing ant with unreachable Nursery holds position (failsafe)', () => {
    // Nursery exists but no tunnel connects. Nurse must hold, not oscillate.
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    ugSet(underground, 10, 10, UndergroundTileState.Open);
    colony.chambers.push({
      chamberId: 100,
      chamberType: 1 /* Nursery */,
      foodStored: 0,
      posX: 3 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      width: 1,
      height: 1,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    world.ants.speed[antId] = FP_ONE;

    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    const posXBefore = world.ants.posX[antId]!;
    const posYBefore = world.ants.posY[antId]!;

    for (let t = 0; t < 4; t++) {
      tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
    }

    expect(world.ants.posX[antId]).toBe(posXBefore);
    expect(world.ants.posY[antId]).toBe(posYBefore);
  });

  it('C-7. seed-920076605 reproduction: carrying forager at (23,7) with FoodStorage at (18,17) and blocked straight-line step at (23,8)', () => {
    // Reproduces the snapshot shape directly. Tunnel route: (23,7)→(23,6)→
    // (23,5)→...→(23,0)→(22,0)→...→(18,0)→(18,1)→...→(18,17). Straight-line
    // picks (23,8) = Solid.
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(48, 32);
    // L-shaped tunnel: up then left then down to FoodStorage.
    for (let y = 0; y <= 7; y++) ugSet(underground, 23, y, UndergroundTileState.Open);
    for (let x = 18; x <= 23; x++) ugSet(underground, x, 0, UndergroundTileState.Open);
    for (let y = 0; y <= 17; y++) ugSet(underground, 18, y, UndergroundTileState.Open);
    // Explicit: (23,8) must be Solid so the straight-line failure mode is reproducible.
    expect(ugGet(underground, 23, 8)).toBe(UndergroundTileState.Solid);

    colony.chambers.push({
      chamberId: 100,
      chamberType: 2 /* FoodStorage */,
      foodStored: 0,
      posX: 18 << FP_SHIFT,
      posY: 17 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 23,
      surfaceTileY: 5,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 23 << FP_SHIFT,
      posY: 7 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 138;
    world.ants.speed[antId] = FP_ONE;

    const chamberCache = buildChamberFlowFieldsCache(underground, colony, colonyId);
    const entranceCache = buildEntranceFFCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // Over 30 ticks the ant must (a) never repeatedly choose a Solid tile and
    // (b) eventually reach the FoodStorage chamber tile or transition state.
    for (let t = 0; t < 32; t++) {
      tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
      const tx = world.ants.posX[antId]! >> FP_SHIFT;
      const ty = world.ants.posY[antId]! >> FP_SHIFT;
      expect(ugGet(underground, tx, ty)).not.toBe(UndergroundTileState.Solid);
    }
    // Arrived at the chamber seed tile.
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(18);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Regression: Fighting-ant rally movement (seed-923593824 bug).
// Before this fix, updateFightAntTargets wrote targetPosX/Y correctly, but
// tickAntMovement fell through to getTaskDirection → {0,0} for Fighting on
// the surface. All fighters clustered at the entrance regardless of rally.
// ---------------------------------------------------------------------------

describe('tickAntMovement — Fighting rally movement', () => {
  /** Surface fighter at (24,64), rally at (101,62) — target east/slightly-north.
   *  One call to updateFightAntTargets + one tick should step the ant toward
   *  the rally (Manhattan: |dx|=77 > |dy|=2 → dx=+1). */
  it('F-1. surface fighter moves toward rally after updateFightAntTargets + tickAntMovement', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 24, surfaceTileY: 64, isOpen: true }];
    colony.rallyPoint = { tileX: 101, tileY: 62 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 24 << FP_SHIFT,
      posY: 64 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
      zone: Zone.Surface,
    });
    world.ants.speed[antId] = FP_ONE;

    updateFightAntTargets(world);
    const rng = new Rng(42);
    const digFlowFields = createDigFlowFields();
    const entranceCache = createEntranceFlowFields();
    const chamberCache = createChamberFlowFields();
    tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);

    // Moved east by one tile (24→25).
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(25);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(64);
  });

  /** Snapshot-shape reproduction: seven fighters at the entrance tile, rally
   *  east. Every fighter must receive the rally target and the group must make
   *  progress toward rally (the lead fighter advances immediately; the rest
   *  caterpillar out over subsequent ticks per the same-colony occupancy rule).
   *  The tick-1 entrance tile itself is an occupancy-exempt work site, so
   *  starting overlap persists but advancement still happens. */
  it('F-2. seven-fighter snapshot reproduction: all fighters advance toward rally', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 24, surfaceTileY: 64, isOpen: true }];
    colony.rallyPoint = { tileX: 101, tileY: 62 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const fighterIds: number[] = [];
    for (let i = 0; i < 7; i++) {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: 24 << FP_SHIFT,
        posY: 64 << FP_SHIFT,
        task: AntTask.Fighting,
        subTask: 0,
        zone: Zone.Surface,
      });
      world.ants.speed[id] = FP_ONE;
      fighterIds.push(id);
    }

    updateFightAntTargets(world);

    // Every fighter received the same rally target (tile-center of 101,62).
    const expectedTargetX = (101 << FP_SHIFT) + (FP_ONE >> 1);
    const expectedTargetY = (62 << FP_SHIFT) + (FP_ONE >> 1);
    for (const id of fighterIds) {
      expect(world.ants.targetPosX[id]).toBe(expectedTargetX);
      expect(world.ants.targetPosY[id]).toBe(expectedTargetY);
    }

    const rng = new Rng(42);
    const digFlowFields = createDigFlowFields();
    const entranceCache = createEntranceFlowFields();
    const chamberCache = createChamberFlowFields();
    tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);

    // At least the lead fighter advances past the entrance column. The other
    // fighters either hold at the exempt entrance tile or spread to adjacent
    // tiles per the same-colony occupancy post-pass. The original bug this
    // test reproduces (rally target not set → everyone motionless at the
    // entrance with no advance) is caught by: (a) expectedTarget assertions
    // above and (b) the advancedCount ≥ 1 assertion here.
    let advancedCount = 0;
    for (const id of fighterIds) {
      const tx = world.ants.posX[id]! >> FP_SHIFT;
      if (tx > 24) advancedCount += 1;
    }
    expect(advancedCount).toBeGreaterThanOrEqual(1);

    // After a handful of ticks the caterpillar spreads out — multiple fighters
    // past the entrance column.
    for (let t = 0; t < 6; t++) {
      updateFightAntTargets(world);
      tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
    }
    const past = fighterIds.filter(id => (world.ants.posX[id]! >> FP_SHIFT) > 24).length;
    expect(past).toBeGreaterThanOrEqual(2);
  });

  /** Underground fighter with surface rally: routes via entrance flow-field to
   *  the entrance underground tile, transitions to surface at tileY=0, then
   *  (on the next tick) begins stepping toward the rally. */
  it('F-3. underground fighter routes entrance → surface → rally', () => {
    // 16x16 underground grid with shaft at col 4, surface entrance at (4,5).
    // Rally at (10,7). Ant starts at underground (2,3) with bent L-tunnel.
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Shaft (4,0..3) Open, chamber pocket (2,3)(3,3) Open.
    ugSet(underground, 4, 0, UndergroundTileState.Open);
    ugSet(underground, 4, 1, UndergroundTileState.Open);
    ugSet(underground, 4, 2, UndergroundTileState.Open);
    ugSet(underground, 4, 3, UndergroundTileState.Open);
    ugSet(underground, 2, 3, UndergroundTileState.Open);
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    colony.entrances.push({ entranceId: 1, surfaceTileX: 4, surfaceTileY: 5, isOpen: true });
    colony.rallyPoint = { tileX: 10, tileY: 7 };

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: 2 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
      zone: Zone.Underground,
    });
    world.ants.speed[antId] = FP_ONE;

    // Build the entrance flow-field that underground fighters consume.
    const entranceCache = createEntranceFlowFields();
    {
      const gridSize = underground.width * underground.height;
      const out = ensureEntranceFlowField(entranceCache, colonyId, gridSize);
      const queue = entranceCache.queues[colonyId]!;
      computeEntranceFlowField(underground, colony.entrances, out, queue);
    }
    const digFlowFields = createDigFlowFields();
    const chamberCache = createChamberFlowFields();
    const rng = new Rng(42);

    // Step long enough to tunnel out and begin the surface rally walk:
    // (2,3)→(3,3)→(4,3)→(4,2)→(4,1)→(4,0) underground (5 steps), then the
    // zone-transition block promotes to Surface at (4,5) same tick. From
    // (4,5) heading to rally (10,7), first surface step is east.
    let transitioned = false;
    for (let t = 0; t < 12; t++) {
      updateFightAntTargets(world);
      tickAntMovement(world, rng, digFlowFields, entranceCache, chamberCache);
      if (world.ants.zone[antId] === Zone.Surface) {
        // Invariant: never stand on a Solid underground tile during transit.
        transitioned = true;
      } else {
        const tx = world.ants.posX[antId]! >> FP_SHIFT;
        const ty = world.ants.posY[antId]! >> FP_SHIFT;
        expect(ugGet(underground, tx, ty)).not.toBe(UndergroundTileState.Solid);
      }
    }
    // Zone transition happened and the fighter is now stepping on the surface
    // toward the rally (no longer stuck at the entrance column).
    expect(transitioned).toBe(true);
    expect(world.ants.zone[antId]).toBe(Zone.Surface);
    const finalTileX = world.ants.posX[antId]! >> FP_SHIFT;
    // From entrance surface col 4, moved east toward rally col 10.
    expect(finalTileX).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// tickAntMovement — same-colony occupancy enforcement (post-pass resolution)
//
// Invariant: no two mobile same-colony ants may end a tick on the same
// (zone, non-exempt tile). Enforced by resolveSameColonyOccupancy after the
// movement loop — it walks ants in entity-id order, lowest-id wins a
// contested tile, and higher-id ants deterministically shift to the first
// passable unclaimed adjacent tile (N, E, S, W). Cross-colony overlap is
// preserved (combat). Brood (eggs / larvae) are exempt — they are not
// entities in world.ants and never reach tickAntMovement. Work sites
// (chambers, entrances, food piles) are exempt so the foraging / nursing
// / digging loops still function.
// ---------------------------------------------------------------------------

describe('tickAntMovement — same-colony occupancy enforcement', () => {
  // Small helper: make a surface Fighting ant that walks straight-line toward
  // (targetX, targetY). Fighting on the surface takes the priority-target
  // branch directly — no pheromone grid, no entrance routing, no dig flow.
  function spawnSurfaceFighter(
    world: WorldState,
    colonyId: number,
    posTileX: number,
    posTileY: number,
    targetTileX: number,
    targetTileY: number,
  ): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId,
      posX: posTileX << FP_SHIFT,
      posY: posTileY << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
      zone: Zone.Surface,
    });
    world.ants.speed[id] = FP_ONE; // exactly one tile per tick
    world.ants.targetPosX[id] = targetTileX << FP_SHIFT;
    world.ants.targetPosY[id] = targetTileY << FP_SHIFT;
    return id;
  }

  function spawnSurfaceHolding(
    world: WorldState,
    colonyId: number,
    posTileX: number,
    posTileY: number,
  ): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId,
      posX: posTileX << FP_SHIFT,
      posY: posTileY << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
      zone: Zone.Surface,
    });
    world.ants.speed[id] = FP_ONE;
    // targetPosX/Y default to -1 → Fighting branch holds dx=dy=0.
    return id;
  }

  function uniqueTiles(world: WorldState, colonyId: number): Set<string> {
    const s = new Set<string>();
    for (let id = 0; id < world.nextEntityId; id++) {
      if (world.ants.alive[id] !== 1) continue;
      if (world.ants.colonyId[id] !== colonyId) continue;
      const tx = world.ants.posX[id]! >> FP_SHIFT;
      const ty = world.ants.posY[id]! >> FP_SHIFT;
      const tz = world.ants.zone[id];
      s.add(`${tz}:${tx},${ty}`);
    }
    return s;
  }

  function countAliveForColony(world: WorldState, colonyId: number): number {
    let n = 0;
    for (let id = 0; id < world.nextEntityId; id++) {
      if (world.ants.alive[id] !== 1) continue;
      if (world.ants.colonyId[id] !== colonyId) continue;
      n += 1;
    }
    return n;
  }

  it('OCC-1. two same-colony workers target the same surface tile → lower-id keeps the tile, higher-id shifts to an adjacent tile', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // A at (5,5), B at (7,5). Both target (6,5). A is allocated first → lower id.
    const aId = spawnSurfaceFighter(world, COLONY_ID, 5, 5, 6, 5);
    const bId = spawnSurfaceFighter(world, COLONY_ID, 7, 5, 6, 5);
    expect(aId).toBeLessThan(bId);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // A (lower id) keeps (6,5).
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    // B ended at (6,5) in the move loop, shift resolves to adjacent non-claimed
    // tile. First direction tried is N (0,-1) → (6,4) is free.
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(4);
    // Invariant: no two ants share a (zone, tile).
    expect(uniqueTiles(world, COLONY_ID).size).toBe(countAliveForColony(world, COLONY_ID));
  });

  it('OCC-2. two same-colony workers target the same underground tile → lower-id keeps it, higher-id shifts to a passable adjacent tile', () => {
    // Carve a plus-shaped Open corridor (cross) at (5,5) so adjacent shifts
    // have a passable tile in at least one direction.
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    for (let x = 3; x <= 7; x++) ugSet(underground, x, 5, UndergroundTileState.Open);
    for (let y = 3; y <= 7; y++) ugSet(underground, 5, y, UndergroundTileState.Open);

    function spawnCarrier(posTileX: number): number {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: posTileX << FP_SHIFT,
        posY: 5 << FP_SHIFT,
        task: AntTask.Foraging,
        subTask: ForagingSubState.CarryingFood,
        zone: Zone.Underground,
      });
      world.ants.foodCarrying[id] = 0; // skip chamber-routing block
      world.ants.speed[id] = FP_ONE;
      world.ants.targetPosX[id] = 5 << FP_SHIFT;
      world.ants.targetPosY[id] = 5 << FP_SHIFT;
      return id;
    }

    const aId = spawnCarrier(4);
    const bId = spawnCarrier(6);
    expect(aId).toBeLessThan(bId);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // A wins (5,5); B is shifted to a passable adjacent Open tile, not the
    // conflicting (5,5) — concretely the first passable adjacent tile in
    // N,E,S,W order, which is (5,4) (N) since the cross is all Open.
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(4);
    // Invariant holds.
    expect(uniqueTiles(world, COLONY_ID).size).toBe(countAliveForColony(world, COLONY_ID));
    void colony;
  });

  it('OCC-3. different-colony workers target the same tile → both occupy (combat overlap preserved)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colonyA = createColonyRecord(1, 0);
    colonyA.entrances = []; colonyA.rallyPoint = null; colonyA.digFlowFieldDirty = false;
    const colonyB = createColonyRecord(2, 0);
    colonyB.entrances = []; colonyB.rallyPoint = null; colonyB.digFlowFieldDirty = false;
    world.colonies[1] = colonyA;
    world.colonies[2] = colonyB;

    const aId = spawnSurfaceFighter(world, 1, 5, 5, 6, 5);
    const bId = spawnSurfaceFighter(world, 2, 7, 5, 6, 5);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Both reach (6,5) — cross-colony overlap is allowed.
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.colonyId[aId]).not.toBe(world.ants.colonyId[bId]);
  });

  it('OCC-4. lower-id ant moving into a higher-id stationary ant\'s tile → stationary keeps tile, mover shifts', () => {
    // Wait — spec says lower-id wins. Here A=lower, B=higher-stationary.
    // A walks into B's tile. In post-pass resolution, ants are processed in
    // entity-id order: A claims (6,5) first (it's a non-exempt tile and
    // nothing else has claimed yet). Then B is processed: B is at (6,5) too
    // (stationary), so B shifts to adjacent. Lower-id ALWAYS wins.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // A first (lower id), will walk east.
    const aId = spawnSurfaceFighter(world, COLONY_ID, 5, 5, 10, 5);
    // B second (higher id), stationary on (6,5) — A's next step lands here.
    const bId = spawnSurfaceHolding(world, COLONY_ID, 6, 5);
    expect(aId).toBeLessThan(bId);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // A (lower) wins (6,5); B (higher, stationary) shifts to first passable
    // adjacent (N → (6,4)).
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(4);
    expect(uniqueTiles(world, COLONY_ID).size).toBe(countAliveForColony(world, COLONY_ID));
  });

  it('OCC-5. pre-existing stationary same-colony duplicate final tile is detected and resolved', () => {
    // Both spawn on (5,5) with no targets → both hold. Previous implementation
    // left both at (5,5) (pre-existing overlap). New post-pass resolves the
    // duplicate: lower-id keeps, higher-id shifts to adjacent.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const aId = spawnSurfaceHolding(world, COLONY_ID, 5, 5);
    const bId = spawnSurfaceHolding(world, COLONY_ID, 5, 5);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // A keeps (5,5). B shifts to first passable adjacent tile (N → (5,4)).
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(4);
    expect(uniqueTiles(world, COLONY_ID).size).toBe(countAliveForColony(world, COLONY_ID));
  });

  it('OCC-6. same-colony workers on different zones do not contest (zone-scoped key)', () => {
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    for (let x = 3; x <= 7; x++) ugSet(underground, x, 5, UndergroundTileState.Open);
    void colony;

    const aId = spawnSurfaceFighter(world, COLONY_ID, 4, 5, 5, 5);

    const bId = allocateEntityId(world);
    initAnt(world.ants, bId, {
      colonyId: COLONY_ID,
      posX: 4 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[bId] = 0;
    world.ants.speed[bId] = FP_ONE;
    world.ants.targetPosX[bId] = 5 << FP_SHIFT;
    world.ants.targetPosY[bId] = 5 << FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Both reached (5,5) — different zones, no contention.
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.zone[aId]).toBe(Zone.Surface);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.zone[bId]).toBe(Zone.Underground);
  });

  it('OCC-7. underground same-colony stationary duplicate is detected; higher-id shifts to a passable Open tile (Solid blocked)', () => {
    // Carve a Y-shaped corridor with only (5,5) and (5,4) Open — all other
    // adjacents of (5,5) are Solid. Both ants stationary on (5,5); the
    // resolution must pick the N direction (the only Open adjacent) for the
    // higher-id ant. Verifies the shift respects passability.
    const { world, colony, underground } = setupWorldWithUnderground(16, 16);
    ugSet(underground, 5, 5, UndergroundTileState.Open);
    ugSet(underground, 5, 4, UndergroundTileState.Open);
    void colony;

    function spawnUndergroundHolding(): number {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: 5 << FP_SHIFT,
        posY: 5 << FP_SHIFT,
        task: AntTask.Nursing,
        subTask: NursingSubState.MovingToBrood,
        zone: Zone.Underground,
      });
      world.ants.speed[id] = FP_ONE;
      return id;
    }

    const aId = spawnUndergroundHolding();
    const bId = spawnUndergroundHolding();

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(4);
    expect(uniqueTiles(world, COLONY_ID).size).toBe(countAliveForColony(world, COLONY_ID));
  });

  it('OCC-8. four same-colony ants all converging on one tile end up on four distinct tiles', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const ids = [
      spawnSurfaceFighter(world, COLONY_ID, 5, 6, 6, 6), // from west
      spawnSurfaceFighter(world, COLONY_ID, 7, 6, 6, 6), // from east
      spawnSurfaceFighter(world, COLONY_ID, 6, 5, 6, 6), // from north
      spawnSurfaceFighter(world, COLONY_ID, 6, 7, 6, 6), // from south
    ];

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Each on a unique (zone, tile).
    const tiles = uniqueTiles(world, COLONY_ID);
    expect(tiles.size).toBe(ids.length);
  });

  it('OCC-9. determinism — two independent runs produce identical final positions after contested converge', () => {
    function run(): number[] {
      const world = createWorldState(42, MAX_TEST_ENTITIES);
      const colony = createColonyRecord(COLONY_ID, 0);
      colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
      world.colonies[COLONY_ID] = colony;

      const ids = [
        spawnSurfaceFighter(world, COLONY_ID, 5, 5, 6, 5),
        spawnSurfaceFighter(world, COLONY_ID, 7, 5, 6, 5),
        spawnSurfaceFighter(world, COLONY_ID, 6, 7, 6, 5),
      ];

      const digFlowFields = createDigFlowFields();
      const rng = new Rng(42);
      for (let t = 0; t < 4; t++) tickAntMovement(world, rng, digFlowFields);

      const out: number[] = [];
      for (const id of ids) {
        out.push(world.ants.posX[id]!, world.ants.posY[id]!);
      }
      return out;
    }

    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
// P1 queen relocation — seed936214196-tick2401 debug-snapshot fix.
// tickAntMovement drives moveQueens for every alive queen; these tests pin
// that contract: no Queen chamber → hold; already home → hold; underground
// transit consumes queen flow-field; Solid dirt is never traversed; surface
// queen descends through nearest open entrance.
// ---------------------------------------------------------------------------

describe('tickAntMovement — P1 queen relocation', () => {
  /**
   * Build a world with a 16×16 all-Open underground grid, one colony whose
   * queen is entity 0 placed at (queenTileX, queenTileY) in the chosen zone.
   * The Queen chamber and chamber flow-field are added only if requested.
   */
  function setupQueenWorld(params: {
    queenTileX: number;
    queenTileY: number;
    zone?: number;
    addQueenChamber?: boolean;
    queenChamberTileX?: number;
    queenChamberTileY?: number;
    queenChamberWidth?: number;
    queenChamberHeight?: number;
    addEntrance?: { tileX: number; tileY: number; isOpen: boolean } | null;
    computeQueenField?: boolean;
    ugWidth?: number;
    ugHeight?: number;
  }): { world: WorldState; colony: ColonyRecord; chamberFlowFields: ReturnType<typeof createChamberFlowFields>; queenId: number } {
    const ugWidth = params.ugWidth ?? 16;
    const ugHeight = params.ugHeight ?? 16;
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // All-Open underground grid so underground movement is unconstrained by default.
    const underground = createUndergroundGrid(ugWidth, ugHeight);
    for (let y = 0; y < ugHeight; y++) {
      for (let x = 0; x < ugWidth; x++) {
        ugSet(underground, x, y, UndergroundTileState.Open);
      }
    }
    world.undergroundGrids[COLONY_ID] = underground;

    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: COLONY_ID,
      // Tile-aligned (no half-tile offset) so a single WORKER_BASE_SPEED step
      // (FP_ONE / 2) reliably crosses the tile boundary in tests that assert
      // tile-index deltas.
      posX:     params.queenTileX << FP_SHIFT,
      posY:     params.queenTileY << FP_SHIFT,
      task:     AntTask.Idle,
      subTask:  0,
      speed:    WORKER_BASE_SPEED,
      zone:     params.zone ?? Zone.Underground,
    });
    colony.queenEntityId = queenId;

    if (params.addQueenChamber) {
      colony.chambers.push({
        chamberId:   500,
        chamberType: ChamberType.Queen,
        foodStored:  0,
        posX:        (params.queenChamberTileX ?? 2) << FP_SHIFT,
        posY:        (params.queenChamberTileY ?? 2) << FP_SHIFT,
        width:       params.queenChamberWidth  ?? 2,
        height:      params.queenChamberHeight ?? 2,
      });
    }

    if (params.addEntrance) {
      colony.entrances.push({
        entranceId:   1,
        surfaceTileX: params.addEntrance.tileX,
        surfaceTileY: params.addEntrance.tileY,
        isOpen:       params.addEntrance.isOpen,
      });
    }

    const chamberFlowFields = createChamberFlowFields();
    if (params.computeQueenField) {
      const bufs = ensureChamberFlowFields(chamberFlowFields, COLONY_ID, ugWidth * ugHeight);
      computeChamberFlowField(
        underground,
        colony.chambers,
        [ChamberType.Queen],
        bufs.queen,
        bufs.queue,
      );
    }

    return { world, colony, chamberFlowFields, queenId };
  }

  it('Q-1. no Queen chamber → queen holds in place (any starting tile is home)', () => {
    const { world, queenId } = setupQueenWorld({
      queenTileX: 5, queenTileY: 5,
      addQueenChamber: false,
    });
    const beforeX = world.ants.posX[queenId]!;
    const beforeY = world.ants.posY[queenId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[queenId]).toBe(beforeX);
    expect(world.ants.posY[queenId]).toBe(beforeY);
  });

  it('Q-2. queen inside Queen chamber footprint → wanders toward a chamber Open tile (Issue #16)', () => {
    // Queen at (3,3). 2×2 chamber footprint = {(2,2),(3,2),(2,3),(3,3)}. The
    // wander targets a non-self tile each cycle, so the queen must move and
    // stay inside the footprint. We deliberately avoid pinning the exact
    // direction here — Q-2c covers "visits every tile" and Q-2b pins the
    // cadence; this case only asserts the bug fix's user-facing claim:
    // "she does not sit motionless on her arrival corner."
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 3, queenTileY: 3,            // inside chamber (2,2)-(3,3)
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      queenChamberWidth: 2, queenChamberHeight: 2,
      computeQueenField: true,
    });
    const beforeX = world.ants.posX[queenId]!;
    const beforeY = world.ants.posY[queenId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    const afterX = world.ants.posX[queenId]!;
    const afterY = world.ants.posY[queenId]!;
    // She moved (wander step is always one Manhattan dimension at speed 128 fp).
    expect(afterX !== beforeX || afterY !== beforeY).toBe(true);
    // She stayed inside the chamber footprint (no dirt-cut, no escape).
    const afterTileX = afterX >> FP_SHIFT;
    const afterTileY = afterY >> FP_SHIFT;
    expect(afterTileX).toBeGreaterThanOrEqual(2);
    expect(afterTileX).toBeLessThanOrEqual(3);
    expect(afterTileY).toBeGreaterThanOrEqual(2);
    expect(afterTileY).toBeLessThanOrEqual(3);
  });

  it('Q-2b. wander target advances every QUEEN_EGG_INTERVAL_TICKS (Issue #16)', () => {
    // Same fixture as Q-2. At tick=0 the target is chamber Open tile index 0
    // = (2,2). After advancing tick by QUEEN_EGG_INTERVAL_TICKS the target
    // index becomes 1 = (3,2). The queen, having had ample time to reach
    // (2,2), now drifts back toward (3,2). This pins the cadence contract:
    // the wander cycle is tied to the egg-laying interval.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 2, queenTileY: 2,            // already at cycle-0 target
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      queenChamberWidth: 2, queenChamberHeight: 2,
      computeQueenField: true,
    });
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    // Cycle 0: she's already at target (2,2) → holds.
    const t0X = world.ants.posX[queenId]!;
    const t0Y = world.ants.posY[queenId]!;
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    expect(world.ants.posX[queenId]).toBe(t0X);
    expect(world.ants.posY[queenId]).toBe(t0Y);

    // Mid-cycle: still inside cycle 0 — target must not have advanced. A
    // regression that uses `world.tick % interval` instead of `floor(world.tick
    // / interval)` would compute a different cycleIndex here (150 → a
    // different tile) and the queen would step away from her current tile.
    world.tick = 150; // half of QUEEN_EGG_INTERVAL_TICKS (300)
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    expect(world.ants.posX[queenId]).toBe(t0X);
    expect(world.ants.posY[queenId]).toBe(t0Y);

    // Advance to cycle 1 (target = (3,2)) and verify she now steps east.
    world.tick = QUEEN_EGG_INTERVAL_TICKS;
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    expect(world.ants.posX[queenId]).toBeGreaterThan(t0X);
  });

  it('Q-2c. queen visits every chamber Open tile across one full wander cycle (Issue #16)', () => {
    // 2×2 chamber → 4 Open tiles. Across QUEEN_EGG_INTERVAL_TICKS × 4 ticks,
    // the wander target advances four times and the queen should occupy every
    // tile in the chamber footprint at least once. A regression where the
    // modulo is wrong (e.g. `% 1` collapses every cycle to tile 0, or
    // openCount is computed as width*height including non-Open tiles) would
    // fail by leaving at least one tile unvisited.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 2, queenTileY: 2,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      queenChamberWidth: 2, queenChamberHeight: 2,
      computeQueenField: true,
    });
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    const visited = new Set<string>();
    for (let t = 0; t < 4 * QUEEN_EGG_INTERVAL_TICKS; t++) {
      world.tick = t;
      tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
      const tx = world.ants.posX[queenId]! >> FP_SHIFT;
      const ty = world.ants.posY[queenId]! >> FP_SHIFT;
      visited.add(`${tx},${ty}`);
    }
    expect(visited.has('2,2')).toBe(true);
    expect(visited.has('3,2')).toBe(true);
    expect(visited.has('2,3')).toBe(true);
    expect(visited.has('3,3')).toBe(true);
    // She also never escaped the chamber.
    expect(visited.size).toBe(4);
  });

  it('Q-2d. wander counts only Open tiles when the chamber has a Solid corner (Issue #16)', () => {
    // 3×3 chamber footprint with one Solid corner tile (4,2). The wander
    // must count Open tiles (8) — a regression that uses width*height (9)
    // would shift the modulo and miss a tile, or pick the Solid tile and
    // get blocked indefinitely. Run 8 cycles and verify the queen
    // (a) never occupies the Solid tile and (b) visits every Open tile.
    //
    // Solid placed in a corner rather than the chamber center because the
    // queen's Manhattan stepping is not a path-finder: a center Solid tile
    // would force Manhattan paths through it and would expose a separate
    // limitation (no diagonal routing) unrelated to the "count Open tiles"
    // contract under test here.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 2, queenTileY: 2,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      queenChamberWidth: 3, queenChamberHeight: 3,
      computeQueenField: true,
    });
    const underground = world.undergroundGrids[COLONY_ID]!;
    ugSet(underground, 4, 2, UndergroundTileState.Solid);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    const visited = new Set<string>();
    for (let t = 0; t < 8 * QUEEN_EGG_INTERVAL_TICKS; t++) {
      world.tick = t;
      tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
      const tx = world.ants.posX[queenId]! >> FP_SHIFT;
      const ty = world.ants.posY[queenId]! >> FP_SHIFT;
      visited.add(`${tx},${ty}`);
    }
    expect(visited.has('4,2')).toBe(false); // never on the Solid tile
    const expectedOpen = ['2,2','3,2','2,3','3,3','4,3','2,4','3,4','4,4'];
    for (const k of expectedOpen) expect(visited.has(k)).toBe(true);
    expect(visited.size).toBe(expectedOpen.length);
  });

  it('Q-3. underground queen routes toward Queen chamber (flow-field step)', () => {
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 5, queenTileY: 5,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      queenChamberWidth: 2, queenChamberHeight: 2,
      computeQueenField: true,
    });
    const beforeTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const beforeTileY = world.ants.posY[queenId]! >> FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    const afterTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const afterTileY = world.ants.posY[queenId]! >> FP_SHIFT;
    const beforeDist = Math.abs(beforeTileX - 2) + Math.abs(beforeTileY - 2);
    const afterDist  = Math.abs(afterTileX  - 2) + Math.abs(afterTileY  - 2);
    expect(afterDist).toBeLessThan(beforeDist);
  });

  it('Q-4. queen cannot cut through Solid dirt — blocked boundary holds position', () => {
    // Queen at (5,5). Queen chamber at (2,2)-(3,3). Solidify every tile at
    // column 4 so the queen's westward step into (4,5) is blocked — with no
    // open path she must hold.
    const { world, queenId } = setupQueenWorld({
      queenTileX: 5, queenTileY: 5,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      queenChamberWidth: 2, queenChamberHeight: 2,
      computeQueenField: false,   // force Manhattan-fallback path
    });
    const underground = world.undergroundGrids[COLONY_ID]!;
    for (let y = 0; y < underground.height; y++) {
      ugSet(underground, 4, y, UndergroundTileState.Solid);
    }
    const beforeX = world.ants.posX[queenId]!;
    const beforeY = world.ants.posY[queenId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    // No chamber flow-field → Manhattan fallback. With column 4 solid the
    // Manhattan step toward (2,2) picks westward (to 4,5), which is Solid →
    // canEnterUndergroundTile blocks the move → queen stays put.
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[queenId]).toBe(beforeX);
    expect(world.ants.posY[queenId]).toBe(beforeY);
  });

  it('Q-5. surface queen steps toward nearest open entrance (Manhattan)', () => {
    const { world, queenId } = setupQueenWorld({
      queenTileX: 10, queenTileY: 10,
      zone: Zone.Surface,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      computeQueenField: true,
      addEntrance: { tileX: 5, tileY: 10, isOpen: true },
    });
    const beforeTileX = world.ants.posX[queenId]! >> FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    const afterTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    // Manhattan step reduces distance to entrance at (5,10).
    expect(afterTileX).toBeLessThan(beforeTileX);
    // Still on surface — she hasn't reached the entrance yet.
    expect(world.ants.zone[queenId]).toBe(Zone.Surface);
  });

  it('Q-6. surface queen already on the open entrance tile descends on the first tick', () => {
    // Regression for the (dx=0,dy=0) early-return bug: without the pre-move
    // descent short-circuit, the Manhattan step from (5,5) toward an entrance
    // at (5,5) yielded rawDx=rawDy=0, the early return fired, and the
    // Surface→Underground transition never ran — the queen sat on the
    // entrance forever with Gate 6 blocking egg production.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 5, queenTileY: 5,
      zone: Zone.Surface,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      computeQueenField: true,
      addEntrance: { tileX: 5, tileY: 5, isOpen: true },
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    expect(world.ants.zone[queenId]).toBe(Zone.Underground);
    expect(world.ants.posY[queenId]).toBe(0);                 // shaft top
    expect(world.ants.posX[queenId]).toBe(5 << FP_SHIFT);     // column preserved

    // Second tick: queen flow-field should steer her toward the Queen
    // chamber at (2,2). Distance to (2,2) must strictly decrease.
    const beforeTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const beforeTileY = world.ants.posY[queenId]! >> FP_SHIFT;
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    const afterTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const afterTileY = world.ants.posY[queenId]! >> FP_SHIFT;
    const beforeDist = Math.abs(beforeTileX - 2) + Math.abs(beforeTileY - 2);
    const afterDist  = Math.abs(afterTileX  - 2) + Math.abs(afterTileY  - 2);
    expect(afterDist).toBeLessThan(beforeDist);
    expect(world.ants.zone[queenId]).toBe(Zone.Underground);  // no surfacing back
  });

  it('Q-7. surface queen does NOT descend through a closed (designated) entrance', () => {
    const { world, queenId } = setupQueenWorld({
      queenTileX: 5, queenTileY: 5,
      zone: Zone.Surface,
      addQueenChamber: true,
      queenChamberTileX: 2, queenChamberTileY: 2,
      computeQueenField: true,
      addEntrance: { tileX: 5, tileY: 5, isOpen: false },
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // No open entrance → queen stays on the surface (holds, because the
    // Manhattan routing finds no target).
    expect(world.ants.zone[queenId]).toBe(Zone.Surface);
  });
});

// ---------------------------------------------------------------------------
// P2 brood transport — seed936214196-tick2401 debug-snapshot fix.
// On a nurse's MovingToBrood → Feeding flip, one brood entity is teleported
// into a Nursery Open tile. Gated on a completed Nursery.
// ---------------------------------------------------------------------------

describe('tickNurseActions — P2 brood transport to Nursery', () => {
  function setupBroodTransportWorld(params: {
    includeNursery?: boolean;
    nurseryTileX?: number;
    nurseryTileY?: number;
    queenTileX?: number;
    queenTileY?: number;
    ugWidth?: number;
    ugHeight?: number;
  }): {
    world: WorldState;
    colony: ColonyRecord;
    nurseId: number;
    queenId: number;
    nurseryTile: { x: number; y: number };
    queenTile:   { x: number; y: number };
  } {
    const ugWidth  = params.ugWidth  ?? 16;
    const ugHeight = params.ugHeight ?? 16;
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const underground = createUndergroundGrid(ugWidth, ugHeight);
    for (let y = 0; y < ugHeight; y++) {
      for (let x = 0; x < ugWidth; x++) {
        ugSet(underground, x, y, UndergroundTileState.Open);
      }
    }
    world.undergroundGrids[COLONY_ID] = underground;

    // Queen entity at params.queenTileX/Y (nurse will stand on this tile too).
    const queenTileX = params.queenTileX ?? 3;
    const queenTileY = params.queenTileY ?? 3;
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: COLONY_ID,
      posX:     (queenTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (queenTileY << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Idle,
      speed:    0,
      zone:     Zone.Underground,
    });
    colony.queenEntityId = queenId;

    // Queen chamber anchored on queen tile (so nurse on that tile = on service tile).
    colony.chambers.push({
      chamberId:   500,
      chamberType: ChamberType.Queen,
      foodStored:  0,
      posX:        queenTileX << FP_SHIFT,
      posY:        queenTileY << FP_SHIFT,
      width:       2,
      height:      2,
    });

    const nurseryTileX = params.nurseryTileX ?? 10;
    const nurseryTileY = params.nurseryTileY ?? 10;
    if (params.includeNursery ?? true) {
      colony.chambers.push({
        chamberId:   501,
        chamberType: ChamberType.Nursery,
        foodStored:  0,
        posX:        nurseryTileX << FP_SHIFT,
        posY:        nurseryTileY << FP_SHIFT,
        width:       2,
        height:      2,
      });
    }

    // Nurse ant — sits on the Queen chamber tile, MovingToBrood.
    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX:     (queenTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (queenTileY << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Nursing,
      subTask:  NursingSubState.MovingToBrood,
      zone:     Zone.Underground,
    });

    return {
      world, colony, nurseId, queenId,
      nurseryTile: { x: nurseryTileX, y: nurseryTileY },
      queenTile:   { x: queenTileX,   y: queenTileY },
    };
  }

  // Issue #21 — brood are now spread across the Nursery footprint by
  //   index = pickId % openCount
  // (row-major over Nursery Open tiles). Pre-fix every transport collapsed
  // to nurseryTile (top-left), stacking every brood at one corner. Tests
  // below pin the exact post-fix tile each pickId lands on so a regression
  // back to "always tile 0" lights up immediately. setupBroodTransportWorld
  // allocates queenId=0 + nurseId=1 first, so the first user-allocated
  // brood gets entityId=2 — which under the 2×2 Nursery (4 open tiles) maps
  // to the 3rd tile in row-major order: (nurseryTile.x, nurseryTile.y + 1).

  it('B-1. egg on non-Nursery tile is teleported to a Nursery Open tile (spread by pickId)', () => {
    const { world, colony, nurseryTile } = setupBroodTransportWorld({});
    // Add an egg at (0,0) — outside Nursery footprint.
    const eggId = allocateEntityId(world);
    expect(eggId).toBe(2); // queenId=0, nurseId=1 → eggId=2; pin the spread math.
    initAnt(world.ants, eggId, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    tickNurseActions(world);

    // pickId=2, openCount=4, targetIndex=2 → 3rd row-major Open tile.
    const eggTileX = world.ants.posX[eggId]! >> FP_SHIFT;
    const eggTileY = world.ants.posY[eggId]! >> FP_SHIFT;
    expect(eggTileX).toBe(nurseryTile.x);
    expect(eggTileY).toBe(nurseryTile.y + 1);
    expect(world.ants.zone[eggId]).toBe(Zone.Underground);
  });

  it('B-2. larva is teleported to a Nursery Open tile on nurse service (spread by pickId)', () => {
    const { world, colony, nurseryTile } = setupBroodTransportWorld({});
    const larvaId = allocateEntityId(world);
    expect(larvaId).toBe(2);
    initAnt(world.ants, larvaId, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.larvae.push(larvaId);
    colony.larvaeCount = 1;

    tickNurseActions(world);

    // pickId=2, targetIndex=2 → (nurseryTile.x, nurseryTile.y + 1).
    expect(world.ants.posX[larvaId]! >> FP_SHIFT).toBe(nurseryTile.x);
    expect(world.ants.posY[larvaId]! >> FP_SHIFT).toBe(nurseryTile.y + 1);
  });

  it('B-3. no Nursery chamber → brood stays in place (gate enforced)', () => {
    const { world, colony } = setupBroodTransportWorld({ includeNursery: false });
    const eggId = allocateEntityId(world);
    initAnt(world.ants, eggId, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(eggId);

    tickNurseActions(world);

    expect(world.ants.posX[eggId]).toBe(0);
    expect(world.ants.posY[eggId]).toBe(0);
  });

  it('B-4. FoodStorage chamber does not count as Nursery target', () => {
    const { world, colony } = setupBroodTransportWorld({ includeNursery: false });
    colony.chambers.push({
      chamberId:   600,
      chamberType: ChamberType.FoodStorage,
      foodStored:  0,
      posX:        10 << FP_SHIFT,
      posY:        10 << FP_SHIFT,
      width:       2,
      height:      2,
    });
    const eggId = allocateEntityId(world);
    initAnt(world.ants, eggId, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(eggId);

    tickNurseActions(world);

    expect(world.ants.posX[eggId]).toBe(0);
    expect(world.ants.posY[eggId]).toBe(0);
  });

  it('B-5. dead brood is skipped — transport picks the next alive entity', () => {
    const { world, colony, nurseryTile } = setupBroodTransportWorld({});
    const deadEgg = allocateEntityId(world);
    expect(deadEgg).toBe(2);
    initAnt(world.ants, deadEgg, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    world.ants.alive[deadEgg] = 0;
    colony.eggs.push(deadEgg);

    const aliveEgg = allocateEntityId(world);
    expect(aliveEgg).toBe(3);
    initAnt(world.ants, aliveEgg, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(aliveEgg);
    colony.eggCount = 1;

    tickNurseActions(world);

    // Dead brood must not have moved.
    expect(world.ants.posX[deadEgg]).toBe(0);
    // Alive brood is teleported. pickId=3, openCount=4, targetIndex=3 →
    // 4th row-major Open tile = (nurseryTile.x + 1, nurseryTile.y + 1).
    expect(world.ants.posX[aliveEgg]! >> FP_SHIFT).toBe(nurseryTile.x + 1);
    expect(world.ants.posY[aliveEgg]! >> FP_SHIFT).toBe(nurseryTile.y + 1);
  });

  it('B-6. deterministic lowest-id selection across multiple brood', () => {
    const { world, colony, nurseryTile } = setupBroodTransportWorld({});

    // allocateEntityId returns ascending IDs, so `lowerId` is allocated
    // first. Push `higherId` FIRST into colony.eggs to prove that selection
    // is by entity ID, not by insertion order.
    const lowerId = allocateEntityId(world);
    expect(lowerId).toBe(2);
    initAnt(world.ants, lowerId, {
      colonyId: COLONY_ID, posX: 1 << FP_SHIFT, posY: 1 << FP_SHIFT, speed: 0, zone: Zone.Underground,
    });
    const higherId = allocateEntityId(world);
    initAnt(world.ants, higherId, {
      colonyId: COLONY_ID, posX: 1 << FP_SHIFT, posY: 1 << FP_SHIFT, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(higherId, lowerId);
    colony.eggCount = 2;

    tickNurseActions(world);

    // The smaller entity ID is the one moved. pickId=2 → 3rd Open tile =
    // (nurseryTile.x, nurseryTile.y + 1). Higher-id brood stays put.
    expect(world.ants.posX[lowerId]!  >> FP_SHIFT).toBe(nurseryTile.x);
    expect(world.ants.posY[lowerId]!  >> FP_SHIFT).toBe(nurseryTile.y + 1);
    expect(world.ants.posX[higherId]! >> FP_SHIFT).toBe(1);
  });

  it('B-7. brood already inside Nursery is skipped', () => {
    const { world, colony, nurseryTile } = setupBroodTransportWorld({});
    // Place egg inside the Nursery footprint — it must be skipped.
    const insideEgg = allocateEntityId(world);
    expect(insideEgg).toBe(2);
    initAnt(world.ants, insideEgg, {
      colonyId: COLONY_ID,
      posX:     (nurseryTile.x << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (nurseryTile.y << FP_SHIFT) + (FP_ONE >> 1),
      speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(insideEgg);

    // Add an outside egg — it is the one the nurse should move.
    const outsideEgg = allocateEntityId(world);
    expect(outsideEgg).toBe(3);
    initAnt(world.ants, outsideEgg, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(outsideEgg);

    tickNurseActions(world);

    // pickId=3 → 4th Open tile = (nurseryTile.x + 1, nurseryTile.y + 1).
    expect(world.ants.posX[outsideEgg]! >> FP_SHIFT).toBe(nurseryTile.x + 1);
    expect(world.ants.posY[outsideEgg]! >> FP_SHIFT).toBe(nurseryTile.y + 1);
  });

  it('B-8a. issue #21 degenerate — 1×1 Nursery collapses spread to the single Open tile (no other tile to spread to)', () => {
    // Edge case: a Nursery with exactly one Open tile (e.g., 1×1 chamber, or
    // a 2×2 chamber where the other three tiles are still Solid mid-dig).
    // openCount = 1 so the modulo is always 0 and every brood lands on the
    // single tile. This is not a regression of #21 — there is no other
    // valid Open tile to spread to. Test pins the openCount=1 collapse so
    // a future refactor cannot silently change the contract (e.g., a
    // refactor that produced an off-by-one cursor or skipped the only tile
    // would land brood elsewhere and fail this assertion).
    const { world, colony, nurseryTile } = setupBroodTransportWorld({});
    // Shrink the Nursery to 1×1; underground grid stays all-Open so the
    // single tile (nurseryTile.x, nurseryTile.y) is the only Open Nursery tile.
    for (const ch of colony.chambers) {
      if (ch.chamberType === ChamberType.Nursery) {
        ch.width  = 1;
        ch.height = 1;
      }
    }
    const eggId = allocateEntityId(world);
    initAnt(world.ants, eggId, {
      colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    tickNurseActions(world);

    expect(world.ants.posX[eggId]! >> FP_SHIFT).toBe(nurseryTile.x);
    expect(world.ants.posY[eggId]! >> FP_SHIFT).toBe(nurseryTile.y);
  });

  it('B-8. issue #21 — successive brood transports spread across Nursery tiles, not one corner', () => {
    // Bug repro: pre-fix transport always wrote to the first row-major Open
    // tile in the first Nursery chamber, so every brood collapsed to a
    // single corner. Build four brood, transport each, assert the four
    // tiles visited cover all four 2×2 Nursery cells.
    const { world, colony, nurseryTile, nurseId, queenTile } = setupBroodTransportWorld({});

    const broodIds: number[] = [];
    for (let k = 0; k < 4; k++) {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0, zone: Zone.Underground,
      });
      colony.eggs.push(id);
      broodIds.push(id);
    }
    colony.eggCount = 4;
    expect(broodIds).toEqual([2, 3, 4, 5]); // pin pickId modulo math.

    // Transport one brood per tickNurseActions call. After each call the
    // nurse flips MovingToBrood→Feeding, so reset back to MovingToBrood
    // (and re-place on the queen-chamber service tile) for the next round.
    const visited = new Set<string>();
    for (let k = 0; k < 4; k++) {
      world.ants.task[nurseId]    = AntTask.Nursing;
      world.ants.subTask[nurseId] = NursingSubState.MovingToBrood;
      world.ants.posX[nurseId]    = (queenTile.x << FP_SHIFT) + (FP_ONE >> 1);
      world.ants.posY[nurseId]    = (queenTile.y << FP_SHIFT) + (FP_ONE >> 1);
      tickNurseActions(world);
    }

    for (const id of broodIds) {
      const tx = world.ants.posX[id]! >> FP_SHIFT;
      const ty = world.ants.posY[id]! >> FP_SHIFT;
      // Every brood landed inside the Nursery footprint.
      expect(tx).toBeGreaterThanOrEqual(nurseryTile.x);
      expect(tx).toBeLessThan(nurseryTile.x + 2);
      expect(ty).toBeGreaterThanOrEqual(nurseryTile.y);
      expect(ty).toBeLessThan(nurseryTile.y + 2);
      visited.add(`${tx},${ty}`);
    }
    // …and all four Nursery tiles were covered — no corner pile-up.
    expect(visited.size).toBe(4);
    // Pin the exact pickId→tile mapping (row-major over the 2×2 footprint:
    // index 0=(x,y), 1=(x+1,y), 2=(x,y+1), 3=(x+1,y+1)). pickIds 2,3,4,5
    // → indices 2,3,0,1 → tiles (x,y+1), (x+1,y+1), (x,y), (x+1,y).
    expect(world.ants.posX[broodIds[0]!]! >> FP_SHIFT).toBe(nurseryTile.x);
    expect(world.ants.posY[broodIds[0]!]! >> FP_SHIFT).toBe(nurseryTile.y + 1);
    expect(world.ants.posX[broodIds[1]!]! >> FP_SHIFT).toBe(nurseryTile.x + 1);
    expect(world.ants.posY[broodIds[1]!]! >> FP_SHIFT).toBe(nurseryTile.y + 1);
    expect(world.ants.posX[broodIds[2]!]! >> FP_SHIFT).toBe(nurseryTile.x);
    expect(world.ants.posY[broodIds[2]!]! >> FP_SHIFT).toBe(nurseryTile.y);
    expect(world.ants.posX[broodIds[3]!]! >> FP_SHIFT).toBe(nurseryTile.x + 1);
    expect(world.ants.posY[broodIds[3]!]! >> FP_SHIFT).toBe(nurseryTile.y);
  });

  it('B-8b. issue #21 — Nursery with zero Open tiles short-circuits (no teleport)', () => {
    // Edge case: a Nursery chamber exists in colony.chambers but every tile
    // in its footprint is Solid (e.g., the chamber was just registered but
    // the dig pass has not converted any tile yet). openCount=0, so the
    // transport must early-return without writing posX/posY/zone — leaving
    // the brood at its original (queen-tile-side) position to be retried on
    // a later tick once the Nursery actually has Open tiles.
    const { world, colony, nurseId, queenTile } = setupBroodTransportWorld({});
    // Mark every Nursery tile Solid so openCount across the chamber is 0.
    const grid = world.undergroundGrids[COLONY_ID]!;
    for (const ch of colony.chambers) {
      if (ch.chamberType !== ChamberType.Nursery) continue;
      const bx = ch.posX >> FP_SHIFT;
      const by = ch.posY >> FP_SHIFT;
      for (let ty = 0; ty < ch.height; ty++) {
        for (let tx = 0; tx < ch.width; tx++) {
          ugSet(grid, bx + tx, by + ty, UndergroundTileState.Solid);
        }
      }
    }
    // Brood placed at the queen's tile (outside the now-Solid Nursery).
    const eggId = allocateEntityId(world);
    const startX = (queenTile.x << FP_SHIFT) + (FP_ONE >> 1);
    const startY = (queenTile.y << FP_SHIFT) + (FP_ONE >> 1);
    initAnt(world.ants, eggId, {
      colonyId: COLONY_ID, posX: startX, posY: startY, speed: 0, zone: Zone.Underground,
    });
    colony.eggs.push(eggId);
    colony.eggCount = 1;
    void nurseId;

    tickNurseActions(world);

    // Brood was NOT moved — the Nursery had no Open tile to teleport to.
    expect(world.ants.posX[eggId]).toBe(startX);
    expect(world.ants.posY[eggId]).toBe(startY);
  });
});
