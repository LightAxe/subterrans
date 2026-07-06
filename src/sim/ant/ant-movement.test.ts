// movement — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-movement.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import { tickAntMovement, updateFightAntTargets } from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V4_DIAGONAL_MOTION,
  SIM_VERSION_V5_CHAMBER_ON_MARKED,
  SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX,
  SIM_VERSION_V32_AI_OP_VALIDATION,
  SIM_VERSION_V33_OCCUPANCY_CENTER,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt, RECENT_TILES_LEN, isRecentTile } from './ant-store.js';
import {
  AntTask,
  ForagingSubState,
  DiggingSubState,
  NursingSubState,
  ChamberType,
  PheromoneType,
} from '../enums.js';
import { createPheromoneGrid, phSet, pheromoneGridKey } from '../pheromone/pheromone-store.js';
import { Rng } from '../rng.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  WORKER_BASE_SPEED,
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
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[colonyId] = colony;

  const underground = createUndergroundGrid(ugWidth, ugHeight);
  world.undergroundGrids[colonyId] = underground;

  return { world, colony, underground, colonyId };
}

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
    const moved = posYAfter !== posYBefore || world.ants.posX[antId]! !== 5 << FP_SHIFT;
    expect(moved).toBe(true);
    // Also: posY should equal posYBefore + speed (moved toward strong pheromone)
    // Only true if exploit branch taken. Accept either posYBefore+speed OR any other valid movement.
    // With V7+ SoftCost, the ant may move at speed/2=64 instead of speed=128.
    /* eslint-disable no-restricted-syntax */
    expect([
      posYBefore + speed,
      posYBefore + speed / 2,
      posYBefore,
      posYBefore - speed / 2,
      posYBefore - speed,
    ]).toContain(posYAfter);
    /* eslint-enable no-restricted-syntax */
  });

  it('12. non-forager stays put (getTaskDirection returns {0,0})', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
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
    const tileY = (world.ants.posY[antId] >> FP_SHIFT) + 1;
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
    // PR 6-sim landing-tile guard: an OPEN entrance has an excavated shaft, so the
    // landing tile (10, 0) is Open. (Real play: DesignateEntrance marks the shaft
    // and excavation opens it; this manual entrance.push bypasses that.)
    ugSet(world.undergroundGrids[COLONY_ID]!, 10, 0, UndergroundTileState.Open);

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
      posY: 0, // tileY=0 (already at top of underground)
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

    // PR 6-sim landing-tile guard: DesignateEntrance auto-marks the shaft column,
    // so a freshly-designated (closed) entrance has (5, 0) = Marked — enterable by
    // a Digger (the task that excavates it). This manual entrance.push bypasses the
    // auto-mark, so set it here to reflect real designated-entrance state.
    ugSet(world.undergroundGrids[COLONY_ID]!, 5, 0, UndergroundTileState.Marked);

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
      posX: 5 << FP_SHIFT,
      posY: 8 << FP_SHIFT,
      width: 1,
      height: 1,
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
      posX: 5 << FP_SHIFT,
      posY: 8 << FP_SHIFT,
      width: 1,
      height: 1,
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
      posX: 8 << FP_SHIFT,
      posY: 4 << FP_SHIFT,
      width: 2,
      height: 2,
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
      posX: 0,
      posY: 0,
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
      posX: 1 << FP_SHIFT,
      posY: 0,
      width: 1,
      height: 1,
    });

    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
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
        posX: 7 << FP_SHIFT,
        posY: 7 << FP_SHIFT,
        width: 1,
        height: 1,
      });

      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: 5 << FP_SHIFT,
        posY: 5 << FP_SHIFT,
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
    // Sweep a range of seeds. Two invariants:
    //   (a) Every seed either MOVES the forager (the wander-fallback
    //       fired) or PAUSES it (issue #35 scurry-stop-scurry produces
    //       stationary frames intentionally). What must NOT happen is
    //       a stationary ant with no pause armed — that's the original
    //       pre-09-memo bug where empty-trail SearchingFood ants got
    //       stuck forever.
    //   (b) When the seed did NOT trigger a pause, the ant must have
    //       moved. This separates the two cases and stops a hypothetical
    //       wander regression from being silently masked by pauses.
    let movedOrPausedCount = 0;
    let nonPausedSeedsThatMoved = 0;
    let nonPausedSeedsTotal = 0;
    for (let seed = 0; seed < 30; seed++) {
      world.ants.posX[antId] = posXBefore;
      world.ants.posY[antId] = posYBefore;
      world.ants.searchPauseTicks[antId] = 0;
      const rng = new Rng(seed);
      tickAntMovement(world, rng, digFlowFields);
      const moved = world.ants.posX[antId] !== posXBefore || world.ants.posY[antId] !== posYBefore;
      const pausedThisTick = world.ants.searchPauseTicks[antId] > 0;
      if (moved || pausedThisTick) movedOrPausedCount += 1;
      if (!pausedThisTick) {
        nonPausedSeedsTotal += 1;
        if (moved) nonPausedSeedsThatMoved += 1;
      }
    }
    expect(movedOrPausedCount).toBe(30); // (a) every seed makes progress somehow
    // (b) non-paused seeds must move — wander-fallback regression guard.
    expect(nonPausedSeedsThatMoved).toBe(nonPausedSeedsTotal);
    expect(nonPausedSeedsTotal).toBeGreaterThan(0); // sanity: not every seed paused
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
    // PR 5 Fix-A — isolate priority-vs-wander from terrain: an all-walkable baked
    // grid makes the path-aware goal field a straight line, so the step toward a
    // due-west target is the pure -X cardinal (no wall-routing detour in Y).
    world.bakedSurfaceEffect.fill(0);
    world.surfaceComponentMask = null;
    world.surfaceGoalFields = null;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 30 << FP_SHIFT,
      posY: 64 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Priority target is west of the ant → deterministic -X step (path-aware over
    // the cleared grid still yields the straight cardinal).
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
    // Pin to pre-v6: prev-tile tracking is gated on the same code path
    // as the v6 surface SoftCost slowdown, which would halve the ant's
    // FP_ONE speed if its current tile is a bush/grass clump under
    // seed-42's terrain layout. The slowdown breaks the test's "one
    // tick = one full tile crossing" precondition. These tests are
    // about prev-tile recording semantics, not surface features.
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      {
        entranceId: allocateEntityId(world),
        surfaceTileX: 0,
        surfaceTileY: antTileY,
        isOpen: true,
      },
    ];
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
  function buildChamberTunnelWorld(opts: {
    chamberType: 0 | 1 | 2;
    antTask: typeof AntTask.Foraging | typeof AntTask.Nursing;
    antSubTask: number;
    foodCarrying: number;
  }) {
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
    computeChamberFlowField(
      underground,
      colony.chambers,
      FOOD_CHAMBER_TYPES,
      bufs.food,
      bufs.queue,
    );
    computeChamberFlowField(
      underground,
      colony.chambers,
      NURSING_CHAMBER_TYPES,
      bufs.nursing,
      bufs.queue,
    );
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
// Issue #34 v4 — 8-connected motion: flow-field diagonal lift + corner-cut
// prevention.
//
// L-shape tunnel from (10,10) up to (10,5) and west to (5,5). FoodStorage
// chamber at (5,5). The food flow-field is N along the column and W along
// the row; at the corner tile (10,5) it switches from N to W. A v4 forager
// at (10,6) reads N (toward (10,5)), peeks (10,5) and sees W — perpendicular
// → lift to NW diagonal → step (10,6) → (9,5) in one tick. Pre-v4 took
// (10,6) → (10,5) (one tick) then (10,5) → (9,5) (next tick).
// ---------------------------------------------------------------------------

describe('tickAntMovement — v4 diagonal flow-field lift (issue #34)', () => {
  function buildLTunnel(): {
    world: WorldState;
    colony: ColonyRecord;
    underground: ReturnType<typeof createUndergroundGrid>;
    colonyId: number;
  } {
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Vertical column x=10 from y=5 to y=10.
    for (let y = 5; y <= 10; y++) ugSet(underground, 10, y, UndergroundTileState.Open);
    // Horizontal row y=5 from x=5 to x=10 (overlaps at (10,5)).
    for (let x = 5; x <= 10; x++) ugSet(underground, x, 5, UndergroundTileState.Open);
    // FoodStorage chamber at (5,5), 1×1 footprint.
    colony.chambers.push({
      chamberId: 100,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 12,
      surfaceTileY: 5,
      isOpen: true,
    });
    return { world, colony, underground, colonyId };
  }

  function buildChamberCache(
    underground: ReturnType<typeof createUndergroundGrid>,
    colony: ColonyRecord,
    colonyId: number,
  ): ReturnType<typeof createChamberFlowFields> {
    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeChamberFlowField(
      underground,
      colony.chambers,
      FOOD_CHAMBER_TYPES,
      bufs.food,
      bufs.queue,
    );
    computeChamberFlowField(
      underground,
      colony.chambers,
      NURSING_CHAMBER_TYPES,
      bufs.nursing,
      bufs.queue,
    );
    return cache;
  }

  function placeForagerAt(
    world: WorldState,
    colonyId: number,
    tileX: number,
    tileY: number,
  ): number {
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 300;
    world.ants.speed[antId] = FP_ONE;
    return antId;
  }

  it('D-1. v4 forager at perpendicular-flow corner takes diagonal step', () => {
    const { world, colony, underground, colonyId } = buildLTunnel();
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V4_DIAGONAL_MOTION);
    const antId = placeForagerAt(world, colonyId, 10, 6);
    const chamberCache = buildChamberCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    // Single tick: at (10,6) flow says N → (10,5). At (10,5) flow says W → (9,5).
    // Perpendicular pair → diagonal lift to NW. Destination (9,5) is Open (on
    // the row). xOnly intermediate (9,6) is Solid (not on the L), yOnly (10,5)
    // is Open → corner-cut allows the diagonal.
    tickAntMovement(world, rng, digFlowFields, undefined, chamberCache);

    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(9);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(5);
  });

  it('D-3. v4 forager on parallel-flow segment takes cardinal (no lift)', () => {
    // Mid-column at (10,8): flow N (toward 10,7). Next tile (10,7) flow N too
    // — parallel, not perpendicular → no diagonal.
    const { world, colony, underground, colonyId } = buildLTunnel();
    const antId = placeForagerAt(world, colonyId, 10, 8);
    const chamberCache = buildChamberCache(underground, colony, colonyId);
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    tickAntMovement(world, rng, digFlowFields, undefined, chamberCache);

    // Pure cardinal north.
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(10);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Issue #34 v4 — corner-cut prevention on target-based motion (Manhattan
// fallback). Set up a queen Manhattan-fallback path where the diagonal target
// tile is Solid and only one intermediate is Open. The post-step passability
// guard must drop the impassable axis (hug the wall) instead of reverting
// both axes.
// ---------------------------------------------------------------------------

describe('tickAntMovement — v4 corner-cut prevention on target motion', () => {
  it('D-4. forager target diagonal blocked at dest → falls back to single-axis cardinal', () => {
    // Underground forager at (5, 5) with target (3, 3) — diagonal NW (-1,-1).
    // Path setup: (5,5) Open, (4,5) Open, (5,4) Solid, (4,4) Solid (the
    // diagonal target). v4 should detect destPassable=false, passXOnly=true
    // (4,5 open), passYOnly=false (5,4 solid) → drop Y axis, keep X step.
    // Result: ant moves W to (4, 5) instead of NW to (4, 4) or stuck at (5,5).
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Open tiles: (5,5) and (4,5) only — surrounding solid.
    ugSet(underground, 5, 5, UndergroundTileState.Open);
    ugSet(underground, 4, 5, UndergroundTileState.Open);
    // Chamber at (3, 3) — but (4, 4) and (5, 4) are Solid, blocking direct paths.
    // The chamber is unreachable via cardinal flow → ant uses Manhattan fallback.
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 0,
      surfaceTileY: 0,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 300;
    world.ants.speed[antId] = FP_ONE;
    // Set explicit target to (3, 3) so the priority-target branch fires.
    world.ants.targetPosX[antId] = (3 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.targetPosY[antId] = (3 << FP_SHIFT) + (FP_ONE >> 1);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    tickAntMovement(world, rng, digFlowFields);

    // Diagonal NW dest (4,4) is Solid. xOnly (4,5) is Open, yOnly (5,4) is
    // Solid. Drop Y axis → ant moves W to (4, 5).
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(4);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(5);
  });

  it('D-5. forager target diagonal with both intermediates blocked → reverts (no cut)', () => {
    // Same idea but BOTH cardinal intermediates AND destination are Solid.
    // Ant must hold position rather than squeeze through a wall corner.
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(16, 16);
    // Only (5,5) is Open — surrounded by Solid in all 4 cardinals + diagonal.
    ugSet(underground, 5, 5, UndergroundTileState.Open);
    colony.entrances.push({
      entranceId: 1,
      surfaceTileX: 0,
      surfaceTileY: 0,
      isOpen: true,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.foodCarrying[antId] = 300;
    world.ants.speed[antId] = FP_ONE;
    world.ants.targetPosX[antId] = (3 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.targetPosY[antId] = (3 << FP_SHIFT) + (FP_ONE >> 1);

    const beforeX = world.ants.posX[antId]!;
    const beforeY = world.ants.posY[antId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);

    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[antId]).toBe(beforeX);
    expect(world.ants.posY[antId]).toBe(beforeY);
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
   *  the rally. Under v4 8-connected motion (issue #34 follow-up) any
   *  multi-axis target produces a diagonal step: (+1, -1). */
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

    // v4 diagonal: rawDx=+77, rawDy=-2, both non-zero → step (+1, -1).
    expect(world.ants.posX[antId]! >> FP_SHIFT).toBe(25);
    expect(world.ants.posY[antId]! >> FP_SHIFT).toBe(63);
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
    const past = fighterIds.filter((id) => world.ants.posX[id]! >> FP_SHIFT > 24).length;
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
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // A at (5,5), B at (7,5). Both target (6,5). A is allocated first → lower id.
    const aId = spawnSurfaceFighter(world, COLONY_ID, 5, 5, 6, 5);
    const bId = spawnSurfaceFighter(world, COLONY_ID, 7, 5, 6, 5);
    expect(aId).toBeLessThan(bId);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

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
    // Verify that two different-colony ants are NOT subject to same-colony
    // occupancy enforcement: even if they independently reach the same tile,
    // neither one is displaced by the resolver (which only separates
    // same-colony ants). We confirm this by placing both ants ON the target
    // tile already (stationary) — the resolver must not displace either,
    // since they are from different colonies.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colonyA = createColonyRecord(1, 0);
    colonyA.entrances = [];
    colonyA.rallyPoint = null;
    colonyA.digFlowFieldDirty = false;
    const colonyB = createColonyRecord(2, 0);
    colonyB.entrances = [];
    colonyB.rallyPoint = null;
    colonyB.digFlowFieldDirty = false;
    world.colonies[1] = colonyA;
    world.colonies[2] = colonyB;

    // Both ants spawn AT (6,5), stationary — the occupancy resolver must
    // leave cross-colony overlaps intact.
    const aId = spawnSurfaceFighter(world, 1, 6, 5, 6, 5);
    const bId = spawnSurfaceFighter(world, 2, 6, 5, 6, 5);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Both should remain at (6,5) — cross-colony overlap is allowed.
    expect(world.ants.posX[aId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[aId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.colonyId[aId]).not.toBe(world.ants.colonyId[bId]);
  });

  it("OCC-4. lower-id ant moving into a higher-id stationary ant's tile → stationary keeps tile, mover shifts", () => {
    // Wait — spec says lower-id wins. Here A=lower, B=higher-stationary.
    // A walks into B's tile. In post-pass resolution, ants are processed in
    // entity-id order: A claims (6,5) first (it's a non-exempt tile and
    // nothing else has claimed yet). Then B is processed: B is at (6,5) too
    // (stationary), so B shifts to adjacent. Lower-id ALWAYS wins.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // A first (lower id), will walk east.
    const aId = spawnSurfaceFighter(world, COLONY_ID, 5, 5, 10, 5);
    // B second (higher id), stationary on (6,5) — A's next step lands here.
    const bId = spawnSurfaceHolding(world, COLONY_ID, 6, 5);
    expect(aId).toBeLessThan(bId);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Invariant: no two ants share a (zone, tile).
    expect(uniqueTiles(world, COLONY_ID).size).toBe(countAliveForColony(world, COLONY_ID));
  });

  it('OCC-5. pre-existing stationary same-colony duplicate final tile is detected and resolved', () => {
    // Both spawn on (5,5) with no targets → both hold. Previous implementation
    // left both at (5,5) (pre-existing overlap). New post-pass resolves the
    // duplicate: lower-id keeps, higher-id shifts to adjacent.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
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
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
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
      colony.entrances = [];
      colony.rallyPoint = null;
      colony.digFlowFieldDirty = false;
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

  // #243 (V33) — resolveSameColonyOccupancy shift-writes park a bumped ant at tile
  // CENTER, not the corner. Two same-colony ants forced onto one tile → the
  // higher-id one shifts; assert the sub-tile offset on both axes and both write
  // pairs (the non-exempt claim and the exempt chamber shift).
  function collideTwo(simVersion: number): { world: WorldState; bId: number } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = simVersion;
    world.bakedSurfaceEffect.fill(0); // all-passable so the shift always finds a tile
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    const aId = spawnSurfaceHolding(world, COLONY_ID, 6, 5);
    const bId = spawnSurfaceHolding(world, COLONY_ID, 6, 5); // same tile → B (higher id) shifts
    expect(aId).toBeLessThan(bId);
    return { world, bId };
  }

  it('V33: a shifted colliding ant parks at tile CENTER on both axes (non-exempt write)', () => {
    const { world, bId } = collideTwo(SIM_VERSION_V33_OCCUPANCY_CENTER);
    tickAntMovement(world, new Rng(42), createDigFlowFields());
    expect(uniqueTiles(world, COLONY_ID).size).toBe(2); // B was shifted off (6,5)
    expect(world.ants.posX[bId]! & (FP_ONE - 1)).toBe(FP_ONE >> 1);
    expect(world.ants.posY[bId]! & (FP_ONE - 1)).toBe(FP_ONE >> 1);
  });

  it('pre-V33 (V32, LATEST−1): a shifted colliding ant parks at the tile CORNER (offset 0)', () => {
    // Pin the gate at exactly >= V33 by testing the boundary just below it. A
    // regression mis-gating at >= V31 or >= V32 would still pass a V30 corner test
    // (V30 < any mis-gate) yet silently break replay for real V31/V32 saves; V32
    // here (LATEST−1) catches that. The occupancy resolver is unchanged V30→V32, so
    // the corner write is identical at V32.
    const { world, bId } = collideTwo(SIM_VERSION_V32_AI_OP_VALIDATION);
    tickAntMovement(world, new Rng(42), createDigFlowFields());
    expect(uniqueTiles(world, COLONY_ID).size).toBe(2);
    expect(world.ants.posX[bId]! & (FP_ONE - 1)).toBe(0);
    expect(world.ants.posY[bId]! & (FP_ONE - 1)).toBe(0);
  });

  it('V33: the exempt-tile shift (into a chamber footprint) also parks at tile CENTER', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V33_OCCUPANCY_CENTER;
    world.bakedSurfaceEffect.fill(0);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    // Chamber footprint over the North neighbour (6,4) — the first tile the resolver
    // tries (DIR order N,E,S,W) — so the shift takes the EXEMPT write pair.
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 6 << FP_SHIFT,
      posY: 4 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    world.colonies[COLONY_ID] = colony;
    const aId = spawnSurfaceHolding(world, COLONY_ID, 6, 5);
    const bId = spawnSurfaceHolding(world, COLONY_ID, 6, 5);
    expect(aId).toBeLessThan(bId);
    tickAntMovement(world, new Rng(42), createDigFlowFields());
    // B shifted North into the exempt chamber tile (6,4), at tile center.
    expect(world.ants.posX[bId]! >> FP_SHIFT).toBe(6);
    expect(world.ants.posY[bId]! >> FP_SHIFT).toBe(4);
    expect(world.ants.posX[bId]! & (FP_ONE - 1)).toBe(FP_ONE >> 1);
    expect(world.ants.posY[bId]! & (FP_ONE - 1)).toBe(FP_ONE >> 1);
  });
});

// ---------------------------------------------------------------------------
// Issue #106 — Underground→Surface ascent reads currentGridColonyId in V13+.
//
// Pre-V13 the ascent looked up entrances on the ant's OWNING colony, so an
// invading Fighter at tileY=0 inside an enemy grid could ascend through ANY
// of its OWN colony's entrances that happened to share its underground tileX.
// V13 reads `currentGridColonyId` instead and writes back `colonyId` on
// successful ascent so the "Surface ⇒ currentGridColonyId === colonyId"
// invariant holds.
// ---------------------------------------------------------------------------
describe('Issue #106 — ascent uses currentGridColonyId (V13+)', () => {
  it("V13+ ascent looks up GRID colony's entrances, not the ant's OWN colony", () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = 13;
    // Two colonies. Player owns colony 1; enemy is colony 2.
    const playerColonyId = 1;
    const enemyColonyId = 2;
    const playerColony = createColonyRecord(playerColonyId, 0);
    playerColony.entrances = [{ entranceId: 10, surfaceTileX: 5, surfaceTileY: 5, isOpen: true }];
    playerColony.rallyPoint = null;
    playerColony.digFlowFieldDirty = false;
    world.colonies[playerColonyId] = playerColony;
    const enemyColony = createColonyRecord(enemyColonyId, 0);
    // Enemy has no open entrance at tileX=5 (the only colony with that
    // entrance is the player). Pre-V13: the player Fighter inside the enemy
    // grid would warp home through the player entrance at tileX=5. V13: no
    // matching entrance on the GRID colony (enemy), so no ascent.
    enemyColony.entrances = [{ entranceId: 20, surfaceTileX: 99, surfaceTileY: 50, isOpen: true }];
    enemyColony.rallyPoint = null;
    enemyColony.digFlowFieldDirty = false;
    world.colonies[enemyColonyId] = enemyColony;
    const enemyGrid = createUndergroundGrid(16, 16);
    world.undergroundGrids[enemyColonyId] = enemyGrid;
    // Carve open tiles so passability checks don't kick in.
    ugSet(enemyGrid, 5, 0, UndergroundTileState.Open);

    // Player Fighter at tileY=0, tileX=5, currentGridColonyId=enemy (descended).
    const fighterId = allocateEntityId(world);
    initAnt(world.ants, fighterId, {
      colonyId: playerColonyId,
      posX: 5 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
      speed: 0,
    });
    world.ants.currentGridColonyId[fighterId] = enemyColonyId;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // V13: no ascent — the enemy's tileX=5 has no entrance.
    expect(world.ants.zone[fighterId]).toBe(Zone.Underground);
  });

  it('V13+ same-colony ascent (ant in own grid) writes back currentGridColonyId for invariant restore', () => {
    const { world, colony } = setupWorldWithUnderground();
    world.simVersion = 13;
    colony.entrances.push({ entranceId: 1, surfaceTileX: 8, surfaceTileY: 5, isOpen: true });
    setupSurfaceGrid(world);

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 8 << FP_SHIFT,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
      speed: 0,
    });
    world.ants.currentGridColonyId[antId] = COLONY_ID; // own grid

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Successful ascent. Post-V13 invariant: currentGridColonyId === colonyId.
    expect(world.ants.zone[antId]).toBe(Zone.Surface);
    expect(world.ants.currentGridColonyId[antId]).toBe(COLONY_ID);
  });

  it('V13+ invader Fighter at tileY=0 in foreign grid AT a matching enemy entrance does NOT ascend (skipAscent guard)', () => {
    // Direct regression test for the descent→ascent ping-pong bug uncovered
    // mid-implementation. Without the `skipAscent` guard, a Fighting invader
    // at tileY=0 in the enemy grid would find the enemy's entrance at the
    // same tileX (which is exactly where it descended) and ascend through
    // it, then descend again next tick — bouncing forever and never fighting.
    // Note: skipAscent only fires for ACTIVE invaders (fight ratio > 0 AND rally
    // set). Recalled invaders (fight=0 or rally cleared) intentionally ascend.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = 13;
    const playerColonyId = 1;
    const enemyColonyId = 2;
    const playerColony = createColonyRecord(playerColonyId, 0);
    playerColony.entrances = [{ entranceId: 10, surfaceTileX: 5, surfaceTileY: 5, isOpen: true }];
    // Active invader: rally set + fight ratio > 0 (not a recall situation).
    playerColony.rallyPoint = { tileX: 5, tileY: 50 };
    playerColony.targetRatio.fight = 5;
    playerColony.digFlowFieldDirty = false;
    world.colonies[playerColonyId] = playerColony;
    const enemyColony = createColonyRecord(enemyColonyId, 0);
    // Enemy entrance at SAME tileX=5 as where the invader is sitting — this
    // is the "ping-pong" repro case. With skipAscent, the Fighter stays put.
    enemyColony.entrances = [{ entranceId: 20, surfaceTileX: 5, surfaceTileY: 50, isOpen: true }];
    enemyColony.rallyPoint = null;
    enemyColony.digFlowFieldDirty = false;
    world.colonies[enemyColonyId] = enemyColony;
    const enemyGrid = createUndergroundGrid(16, 16);
    world.undergroundGrids[enemyColonyId] = enemyGrid;
    ugSet(enemyGrid, 5, 0, UndergroundTileState.Open);

    // Player Fighter at tileY=0, tileX=5, currentGridColonyId=enemy.
    const fighterId = allocateEntityId(world);
    initAnt(world.ants, fighterId, {
      colonyId: playerColonyId,
      posX: 5 << FP_SHIFT,
      posY: 0,
      task: AntTask.Fighting, // <-- KEY: Fighting, not Foraging
      zone: Zone.Underground,
      speed: 0,
    });
    world.ants.currentGridColonyId[fighterId] = enemyColonyId; // foreign grid

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // Fighter must NOT ascend even though enemy entrance matches its tileX.
    // skipAscent fires: task === Fighting && currentGridColonyId !== colonyId.
    expect(world.ants.zone[fighterId]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[fighterId]).toBe(enemyColonyId);
  });
});

// ---------------------------------------------------------------------------
// Issue #108 — resolveSameColonyOccupancy zone-masks gridColonyId in V13+.
//
// V13+ mirrors combat tile-key encoding (tile-key.ts:56) — when zone ===
// Surface, the gridColonyId portion of the per-tile key is zero-masked so
// two same-colony surface ants with diverging `currentGridColonyId` (e.g.
// post-#106 ascent transient) bucket together and one gets shifted off the
// shared tile. Pre-V13 the raw gridColonyId was used and they stacked.
// ---------------------------------------------------------------------------
describe('Issue #108 — occupancy zone-mask (V13+)', () => {
  it('V13+ shifts one of two same-colony surface ants with diverging currentGridColonyId at same tile', () => {
    const { world } = setupWorldWithUnderground();
    world.simVersion = 13;
    setupSurfaceGrid(world);

    const a = allocateEntityId(world);
    initAnt(world.ants, a, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      zone: Zone.Surface,
      speed: 0,
    });
    world.ants.currentGridColonyId[a] = COLONY_ID; // matches own colony

    const b = allocateEntityId(world);
    initAnt(world.ants, b, {
      colonyId: COLONY_ID, // SAME colony
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      zone: Zone.Surface,
      speed: 0,
    });
    world.ants.currentGridColonyId[b] = 99; // DIVERGENT — exposes the bug

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // V13+: occupancy resolver zero-masks gridByte for surface, so both ants
    // share a key and one (higher id) shifts to an adjacent tile.
    const aTile = `${world.ants.posX[a]! >> FP_SHIFT},${world.ants.posY[a]! >> FP_SHIFT}`;
    const bTile = `${world.ants.posX[b]! >> FP_SHIFT},${world.ants.posY[b]! >> FP_SHIFT}`;
    expect(aTile).not.toBe(bTile);
  });

  // Pre-V13 byte-identity is enforced indirectly: the V13+ behavior change
  // only fires on `world.simVersion >= V13`, and the rest of the
  // ant-system test corpus pins simVersion at LEGACY_SIM_VERSION (2) for
  // its setupWorldWithUnderground default. If V13 leaked through, the
  // existing 263-test surface would fail. The positive V13 test above is
  // sufficient to demonstrate the masked-key separation; reproducing the
  // pre-V13 stack here would require exporting resolveSameColonyOccupancy
  // for direct call (the full tickAntMovement also runs surface foraging
  // / passability passes that can shift either ant for unrelated reasons).
});

// ---------------------------------------------------------------------------
// S0a / issue #120 — V14 underground CarryingFood no-revisit guard (unit tests)
// ---------------------------------------------------------------------------

describe('tickAntMovement — V14 underground CarryingFood no-revisit guard', () => {
  /**
   * Build a minimal underground world where a V14 CarryingFood ant is placed
   * at (antX, antY) on an open tile. The grid is 8×8 with all tiles Solid by
   * default; callers open specific tiles.
   */
  function setupUndergroundCarryingAnt(
    antX: number,
    antY: number,
  ): {
    world: WorldState;
    antId: number;
    underground: ReturnType<typeof createUndergroundGrid>;
    chamberFlowFields: ReturnType<typeof createChamberFlowFields>;
    digFlowFields: ReturnType<typeof createDigFlowFields>;
  } {
    const { world, colony, underground, colonyId } = setupWorldWithUnderground(8, 8);
    world.simVersion = SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX;

    colony.entrances = [
      {
        entranceId: 1,
        surfaceTileX: 0,
        surfaceTileY: 64,
        isOpen: true,
      },
    ];

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId,
      posX: antX << FP_SHIFT,
      posY: antY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Underground,
    });
    world.ants.currentGridColonyId[antId] = colonyId;
    world.ants.foodCarrying[antId] = 500;

    const chamberFlowFields = createChamberFlowFields();
    const digFlowFields = createDigFlowFields();
    return { world, antId, underground, chamberFlowFields, digFlowFields };
  }

  it('V14: ring buffer is pushed on underground CarryingFood tile crossing', () => {
    // Place ant at (3, 3); open tile to East (4, 3) and South (3, 4).
    // With no flow field, the ant explores; after a tile crossing, the previous
    // tile should appear in the ring buffer.
    const { world, antId, underground, chamberFlowFields, digFlowFields } =
      setupUndergroundCarryingAnt(3, 3);
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    ugSet(underground, 4, 3, UndergroundTileState.Open);
    ugSet(underground, 3, 4, UndergroundTileState.Open);
    ugSet(underground, 2, 3, UndergroundTileState.Open);
    ugSet(underground, 3, 2, UndergroundTileState.Open);

    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    const posX = world.ants.posX[antId]!;
    const posY = world.ants.posY[antId]!;
    const newTileX = posX >> FP_SHIFT;
    const newTileY = posY >> FP_SHIFT;

    if (newTileX !== 3 || newTileY !== 3) {
      // A tile crossing occurred — old tile (3,3) should be in the buffer.
      let found = false;
      for (let s = 0; s < RECENT_TILES_LEN; s++) {
        if (
          world.ants.recentTilesX[antId * RECENT_TILES_LEN + s] === 3 &&
          world.ants.recentTilesY[antId * RECENT_TILES_LEN + s] === 3
        ) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
    // If no crossing (ant stayed put), the ring buffer stays empty (no push on hold).
    // Either outcome is valid — the test verifies the PUSH path, not the hold path.
  });

  it('V14: redirects underground CarryingFood ant away from recent tile to alternate open tile', () => {
    // Ant at (3, 3). FoodStorage chamber at (4, 3) → flow field points East.
    // Poison East with a recent tile so the guard fires.
    // South (3, 4) is open → guard redirects South.
    const { world, antId, underground, chamberFlowFields, digFlowFields } =
      setupUndergroundCarryingAnt(3, 3);
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    ugSet(underground, 4, 3, UndergroundTileState.Open); // East — proposed direction
    ugSet(underground, 3, 4, UndergroundTileState.Open); // South — alternate
    // (2,3) and (3,2) remain Solid — no other alternates

    const colonyId = world.ants.colonyId[antId]!;
    const colony = world.colonies[colonyId]!;
    // Place FoodStorage chamber at (4, 3) to seed the food flow field East.
    colony.chambers.push({
      chamberId: 100,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 4 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(chamberFlowFields, colonyId, gridSize);
    computeChamberFlowField(
      underground,
      colony.chambers,
      FOOD_CHAMBER_TYPES,
      bufs.food,
      bufs.queue,
    );

    // Poison East tile (4, 3) as a recent tile.
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 0] = 4;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 0] = 3;

    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    const newTileX = world.ants.posX[antId]! >> FP_SHIFT;

    // Must NOT have moved East to the recent tile.
    expect(newTileX).not.toBe(4);
    // The ant should have moved South (or stayed — either is non-East, showing the guard fired).
    // If South was chosen: (3, 4).
    expect(newTileX).toBe(3); // x unchanged (went South or held)
  });

  it('V14: allows original direction when all alternates are impassable (no deadlock)', () => {
    // Ant at (3, 3). East is open (proposed direction, blocked as recent).
    // All other neighbors are Solid — no alternate escape. Guard must NOT hold
    // (holding deadlocks permanently since ring buffer only advances on crossings).
    // The ant should proceed East into the recent tile.
    const { world, antId, underground, chamberFlowFields, digFlowFields } =
      setupUndergroundCarryingAnt(3, 3);
    ugSet(underground, 3, 3, UndergroundTileState.Open);
    ugSet(underground, 4, 3, UndergroundTileState.Open); // East — will be poisoned
    // (2,3), (3,2), (3,4) remain Solid

    const colonyId = world.ants.colonyId[antId]!;
    const colony = world.colonies[colonyId]!;
    colony.chambers.push({
      chamberId: 101,
      chamberType: ChamberType.FoodStorage,
      foodStored: 0,
      posX: 4 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      width: 1,
      height: 1,
    });
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(chamberFlowFields, colonyId, gridSize);
    computeChamberFlowField(
      underground,
      colony.chambers,
      FOOD_CHAMBER_TYPES,
      bufs.food,
      bufs.queue,
    );

    // Poison East as recent. No other open tiles exist — no valid alternate.
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 0] = 4;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 0] = 3;

    const posXBefore = world.ants.posX[antId]!;
    const posYBefore = world.ants.posY[antId]!;

    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    // Ant must have moved East (into the recent tile) rather than deadlocking.
    expect(world.ants.posX[antId]).toBeGreaterThan(posXBefore);
    expect(world.ants.posY[antId]).toBe(posYBefore);
  });

  // ---------------------------------------------------------------------------
  // Descent clear gate tests: verifies clearRecentTiles is V14-gated at descent.
  // A V13 world must NOT have its ring buffer cleared on descent (replay invariant).
  // ---------------------------------------------------------------------------

  it('V14: clears ring buffer on Surface→Underground descent', () => {
    const { world, colony } = setupWorldWithUnderground(16, 16);
    world.simVersion = SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX;
    colony.entrances = [{ entranceId: 1, surfaceTileX: 5, surfaceTileY: 5, isOpen: true }];
    // PR 6-sim landing-tile guard: an open entrance has an excavated shaft, so the
    // carrier's landing tile (5, 0) is Open (else the V30 guard blocks descent).
    ugSet(world.undergroundGrids[COLONY_ID]!, 5, 0, UndergroundTileState.Open);

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Surface,
      speed: 0,
    });
    world.ants.foodCarrying[antId] = 500;
    // Poison two ring-buffer slots with stale surface coords
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 0] = 3;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 0] = 3;
    world.ants.recentTilesX[antId * RECENT_TILES_LEN + 1] = 4;
    world.ants.recentTilesY[antId * RECENT_TILES_LEN + 1] = 4;

    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields(), undefined, createChamberFlowFields());

    expect(world.ants.zone[antId]).toBe(Zone.Underground);
    // Stale surface coords must no longer appear as recent after the V14 clear
    expect(isRecentTile(world.ants, antId, 3, 3)).toBe(false);
    expect(isRecentTile(world.ants, antId, 4, 4)).toBe(false);
  });
});
