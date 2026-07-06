// pheromone — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-pheromone.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import { tickPheromoneDeposit } from './ant-system.js';
import { createWorldState, allocateEntityId } from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import { createPheromoneGrid, phGet, pheromoneGridKey } from '../pheromone/pheromone-store.js';
import {
  FOOD_TRAIL_DEPOSIT_V14,
  PHEROMONE_CAP,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  ENTRANCE_DEPOSIT_SUPPRESS_RADIUS,
} from '../constants.js';
import { FP_SHIFT } from '../fixed.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';

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
// tickPheromoneDeposit — PHER-03 carry-only rule
// ---------------------------------------------------------------------------

describe('tickPheromoneDeposit', () => {
  it('6. carrying ant deposits FOOD_TRAIL_DEPOSIT at its tile', () => {
    const { world, antId } = setupForagerWorld(5 << FP_SHIFT, 5 << FP_SHIFT);
    const { grid } = setupSurfaceGrid(world);
    world.ants.foodCarrying[antId] = 500;
    world.ants.alive[antId] = 1;

    tickPheromoneDeposit(world);

    expect(phGet(grid, 5, 5)).toBe(FOOD_TRAIL_DEPOSIT_V14);
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

    const expected = FOOD_TRAIL_DEPOSIT_V14 * 2;
    // If expected exceeds PHEROMONE_CAP, value is capped
    const capped = expected > PHEROMONE_CAP ? PHEROMONE_CAP : expected;
    expect(phGet(grid, tileX, tileY)).toBe(capped);
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
  function setupCarryingAnt(antTileX: number, antTileY: number, entranceX = 0, entranceY = 0) {
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
    expect(phGet(grid, 4, 0)).toBe(FOOD_TRAIL_DEPOSIT_V14);
  });

  it('carrying ant far from entrance still deposits normally', () => {
    const { world, grid } = setupCarryingAnt(20, 20);
    tickPheromoneDeposit(world);
    expect(phGet(grid, 20, 20)).toBe(FOOD_TRAIL_DEPOSIT_V14);
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
    expect(phGet(grid, 2, 0)).toBe(FOOD_TRAIL_DEPOSIT_V14);
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
    const { grid } = setupSurfaceGrid(world);

    // Four carrying ants parked on adjacent entrance-side tiles — the exact
    // shape the observed stutter came from (all passing through the same
    // two tiles). Pre-suppression, 50 ticks here would pin these cells at
    // PHEROMONE_CAP and create the two-tile trap.
    const carrierOffsets: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
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
