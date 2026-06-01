// debug-snapshot.test.ts — coverage for the render/platform-only debug
// snapshot payload builder (09 excursion-foraging follow-up QA aid).
//
// Scope: pure-data extraction — buildAntTrace, buildDebugSnapshot, and the
// movement-source inference heuristic. The browser-side downloader in
// src/render/debug-snapshot-download.ts is thin DOM glue and is exercised
// indirectly (its input format is what this suite asserts on).

import { describe, it, expect } from 'vitest';
import {
  buildDebugSnapshot,
  buildAntTrace,
  buildDebugGuide,
  defaultDebugSnapshotFilename,
  DEBUG_SNAPSHOT_VERSION,
  DEBUG_TRACE_PHEROMONE_RADIUS,
  MOVEMENT_SOURCES,
} from './debug-snapshot.js';
import { createWorldState, allocateEntityId } from '../sim/types.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import { initAnt } from '../sim/ant/ant-store.js';
import {
  AntTask, ChamberType, DiggingSubState, FightingSubState,
  ForagingSubState, NursingSubState, PheromoneType,
} from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import {
  createPheromoneGrid, phSet, pheromoneGridKey,
} from '../sim/pheromone/pheromone-store.js';
import {
  SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT, FOOD_TRAIL_DEPOSIT,
} from '../sim/constants.js';

const COLONY_ID = 1;
const OTHER_COLONY_ID = 2;
const MAX_TEST_ENTITIES = 64;

function setupSurfaceGrid(world: ReturnType<typeof createWorldState>, colonyId: number) {
  const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
  const grid = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
  world.pheromoneGrids[key] = grid;
  return grid;
}

function setupWorldWithColony(colonyId: number) {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  const colony = createColonyRecord(colonyId, allocateEntityId(world));
  colony.entrances = [{
    entranceId: allocateEntityId(world),
    surfaceTileX: 0,
    surfaceTileY: 0,
    isOpen: true,
  }];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[colonyId] = colony;
  return { world, colony };
}

describe('buildAntTrace — currentGridColonyId (Phase 09.1-05)', () => {
  it('default invariant: currentGridColonyId matches colonyId on spawn', () => {
    // Plan 09.1-00 set currentGridColonyId = colonyId in initAnt. Asserting
    // that the trace surfaces this invariant prevents a later initAnt
    // regression (accidental missing write) from going undetected in the
    // exported payload readers use to diagnose invasions.
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });

    const row = buildAntTrace(world, antId);
    expect(row.colonyId).toBe(COLONY_ID);
    expect(row.currentGridColonyId).toBe(COLONY_ID);
  });

  it('divergent values: player ant inside enemy grid (colonyId=0, currentGridColonyId=1)', () => {
    // During Phase 09.1 invasion a Fighting ant crosses into the enemy
    // underground grid. colonyId never changes (ownership is permanent);
    // currentGridColonyId tracks the grid-of-occupancy. The snapshot must
    // expose BOTH so a reader can see at-a-glance which ants are inside a
    // foreign grid.
    const PLAYER = 0;
    const ENEMY  = 1;
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    for (const cid of [PLAYER, ENEMY]) {
      const c = createColonyRecord(cid, -1);
      c.entrances = [];
      c.rallyPoint = null;
      c.digFlowFieldDirty = false;
      world.colonies[cid] = c;
      setupSurfaceGrid(world, cid);
    }
    const invaderId = allocateEntityId(world);
    initAnt(world.ants, invaderId, {
      colonyId: PLAYER,
      posX: 30 << FP_SHIFT,
      posY: 30 << FP_SHIFT,
      task: AntTask.Fighting,
    });
    // Simulate mid-invasion: the ant is inside the enemy underground grid.
    world.ants.currentGridColonyId[invaderId] = ENEMY;

    const row = buildAntTrace(world, invaderId);
    expect(row.colonyId).toBe(PLAYER);
    expect(row.currentGridColonyId).toBe(ENEMY);
  });

  it('buildDebugSnapshot payload includes currentGridColonyId per ant trace row', () => {
    // End-to-end: the full snapshot payload (not just a single trace row)
    // must carry the field so downstream JSON consumers can read it.
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 20 << FP_SHIFT,
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
    });
    const snap = buildDebugSnapshot(world, 1, []);
    const row = snap.antTrace.find((r) => r.antId === antId);
    expect(row).toBeDefined();
    expect(row!.currentGridColonyId).toBe(COLONY_ID);
  });
});

describe('buildAntTrace — field population', () => {
  it('emits tile coords derived from posX/posY >> FP_SHIFT and all SoA fields', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: (10 << FP_SHIFT) + 64, // sub-tile offset survives in posX
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    world.ants.foodCarrying[antId] = 111;
    world.ants.searchWave[antId] = 2;
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = -1;
    world.ants.searchHeadingTicks[antId] = 7;
    world.ants.searchPrevTileX[antId] = 9;
    world.ants.searchPrevTileY[antId] = 20;
    world.ants.targetPosX[antId] = 42 << FP_SHIFT;
    world.ants.targetPosY[antId] = 20 << FP_SHIFT;

    const row = buildAntTrace(world, antId);

    expect(row.antId).toBe(antId);
    expect(row.colonyId).toBe(COLONY_ID);
    expect(row.task).toBe(AntTask.Foraging);
    expect(row.subTask).toBe(ForagingSubState.SearchingFood);
    expect(row.zone).toBe(Zone.Surface);
    expect(row.tileX).toBe(10);
    expect(row.tileY).toBe(20);
    expect(row.posX).toBe((10 << FP_SHIFT) + 64);
    expect(row.posY).toBe(20 << FP_SHIFT);
    expect(row.foodCarrying).toBe(111);
    expect(row.searchWave).toBe(2);
    expect(row.searchHeadingX).toBe(1);
    expect(row.searchHeadingY).toBe(-1);
    expect(row.searchHeadingTicks).toBe(7);
    expect(row.searchPrevTileX).toBe(9);
    expect(row.searchPrevTileY).toBe(20);
    expect(row.targetPosX).toBe(42 << FP_SHIFT);
    expect(row.targetPosY).toBe(20 << FP_SHIFT);
  });

  it('nearestEntranceDist returns Manhattan distance to the nearest own-colony entrance', () => {
    const { world, colony } = setupWorldWithColony(COLONY_ID);
    // Add a second entrance closer than (0,0).
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: 25,
      surfaceTileY: 20,
      isOpen: true,
    });
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 20 << FP_SHIFT,
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });

    const row = buildAntTrace(world, antId);

    // |20-25| + |20-20| = 5 (closer than |20-0|+|20-0|=40).
    expect(row.nearestEntranceDist).toBe(5);
  });

  it('nearestEntranceDist returns -1 when the colony has no entrances', () => {
    const { world, colony } = setupWorldWithColony(COLONY_ID);
    colony.entrances = [];
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 20 << FP_SHIFT,
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    const row = buildAntTrace(world, antId);
    expect(row.nearestEntranceDist).toBe(-1);
  });

  it('nearbyPheromone is a (2r+1)^2 row-major flat diamond with phGet values, zero outside diamond', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    const grid = setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 30 << FP_SHIFT,
      posY: 30 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Corner of the square (|dx|+|dy| > r) should read 0 in the output even if
    // a cell happens to have pheromone there — that cell falls outside the
    // Manhattan diamond. Set a corner + a centre-adjacent and verify.
    phSet(grid, 30 + DEBUG_TRACE_PHEROMONE_RADIUS, 30 + DEBUG_TRACE_PHEROMONE_RADIUS, 999);
    phSet(grid, 30 + 1, 30, FOOD_TRAIL_DEPOSIT);

    const row = buildAntTrace(world, antId);
    const side = 2 * DEBUG_TRACE_PHEROMONE_RADIUS + 1;
    expect(row.nearbyPheromone.length).toBe(side * side);
    // Centre cell (dx=0, dy=0) at index r*side + r.
    const r = DEBUG_TRACE_PHEROMONE_RADIUS;
    expect(row.nearbyPheromone[r * side + r]).toBe(0);
    // Adjacent +X cell (dx=1, dy=0) — the FOOD_TRAIL_DEPOSIT deposit.
    expect(row.nearbyPheromone[r * side + (r + 1)]).toBe(FOOD_TRAIL_DEPOSIT);
    // Corner (dx=r, dy=r) — outside diamond, must be 0 despite the phSet.
    expect(row.nearbyPheromone[(r + r) * side + (r + r)]).toBe(0);
  });

  it('underground ant gets an all-zero nearbyPheromone square (surface grid N/A)', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    const grid = setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 30 << FP_SHIFT,
      posY: 30 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      zone: Zone.Underground,
    });
    // Non-zero surface pheromone next to the ant's tile must NOT appear in the
    // underground ant's trace — underground ants don't sample the surface grid.
    phSet(grid, 31, 30, FOOD_TRAIL_DEPOSIT);
    const row = buildAntTrace(world, antId);
    expect(row.nearbyPheromone.every((v) => v === 0)).toBe(true);
  });
});

describe('buildAntTrace — movement source inference', () => {
  function makeAnt(sub: number, zone: number = Zone.Surface) {
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 20 << FP_SHIFT,
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: sub,
      zone,
    });
    return { world, antId };
  }

  it('dead ant → "dead"', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    world.ants.alive[antId] = 0;
    expect(buildAntTrace(world, antId).movementSource).toBe('dead');
  });

  it('non-forager (Idle/Nursing/Digging/Fighting) → "task"', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    world.ants.task[antId] = AntTask.Nursing;
    expect(buildAntTrace(world, antId).movementSource).toBe('task');
  });

  it('CarryingFood → "entrance"', () => {
    const { world, antId } = makeAnt(ForagingSubState.CarryingFood);
    expect(buildAntTrace(world, antId).movementSource).toBe('entrance');
  });

  it('ReturningToNest → "entrance"', () => {
    const { world, antId } = makeAnt(ForagingSubState.ReturningToNest);
    expect(buildAntTrace(world, antId).movementSource).toBe('entrance');
  });

  it('SearchingFood with targetPos set → "priority"', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    world.ants.targetPosX[antId] = 30 << FP_SHIFT;
    world.ants.targetPosY[antId] = 30 << FP_SHIFT;
    // Make sure scent/pheromone can't steal the answer.
    expect(buildAntTrace(world, antId).movementSource).toBe('priority');
  });

  it('SearchingFood + food pile within scent radius → "scent"', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    // Pile 5 tiles away (well within DEBUG_SCENT_RADIUS = 15).
    world.foodPiles.push({ foodPileId: 1, tileX: 25, tileY: 20 , pickupsRemaining: 50, pickupsInitial: 50});
    expect(buildAntTrace(world, antId).movementSource).toBe('scent');
  });

  it('SearchingFood + trail pheromone within radius → "pheromone"', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    const key = pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface');
    phSet(world.pheromoneGrids[key]!, 21, 20, FOOD_TRAIL_DEPOSIT);
    expect(buildAntTrace(world, antId).movementSource).toBe('pheromone');
  });

  it('SearchingFood with no signal anywhere → "wander"', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    expect(buildAntTrace(world, antId).movementSource).toBe('wander');
  });

  it('priority overrides scent AND pheromone (decision order preserved)', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    world.ants.targetPosX[antId] = 30 << FP_SHIFT;
    world.ants.targetPosY[antId] = 30 << FP_SHIFT;
    world.foodPiles.push({ foodPileId: 1, tileX: 25, tileY: 20 , pickupsRemaining: 50, pickupsInitial: 50});
    const key = pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface');
    phSet(world.pheromoneGrids[key]!, 21, 20, FOOD_TRAIL_DEPOSIT);
    expect(buildAntTrace(world, antId).movementSource).toBe('priority');
  });

  it('scent overrides pheromone (decision order preserved)', () => {
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood);
    world.foodPiles.push({ foodPileId: 1, tileX: 25, tileY: 20 , pickupsRemaining: 50, pickupsInitial: 50});
    const key = pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface');
    phSet(world.pheromoneGrids[key]!, 21, 20, FOOD_TRAIL_DEPOSIT);
    expect(buildAntTrace(world, antId).movementSource).toBe('scent');
  });

  it('Underground SearchingFood → "underground-exit" (not scent/pheromone/wander)', () => {
    // Underground empty foragers route via the entrance flow-field, not via
    // surface scent/pheromone. Surface-grid signals must NOT be reported.
    const { world, antId } = makeAnt(ForagingSubState.SearchingFood, Zone.Underground);
    // Populate the surface grid with a nearby pile + pheromone — if the
    // classifier incorrectly ran the surface cascade, one of these would win.
    world.foodPiles.push({ foodPileId: 1, tileX: 25, tileY: 20 , pickupsRemaining: 50, pickupsInitial: 50});
    const key = pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface');
    phSet(world.pheromoneGrids[key]!, 21, 20, FOOD_TRAIL_DEPOSIT);
    expect(buildAntTrace(world, antId).movementSource).toBe('underground-exit');
  });

  it('Underground CarryingFood still reports "entrance" (precedence preserved)', () => {
    // Zone check runs AFTER the CarryingFood/ReturningToNest branch, so a
    // carrying forager — underground or not — still classifies as entrance.
    const { world, antId } = makeAnt(ForagingSubState.CarryingFood, Zone.Underground);
    expect(buildAntTrace(world, antId).movementSource).toBe('entrance');
  });
});

describe('buildDebugSnapshot — envelope + filtering', () => {
  it('emits the stable envelope shape { version, guide, seed, tick, inputLog, snapshot, antTrace }', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    const snap = buildDebugSnapshot(world, 1234, []);
    expect(snap.version).toBe(DEBUG_SNAPSHOT_VERSION);
    expect(snap.guide).toBeDefined();
    expect(snap.seed).toBe(1234);
    expect(snap.tick).toBe(world.tick);
    expect(Array.isArray(snap.inputLog)).toBe(true);
    expect(snap.snapshot).toBeDefined();
    expect(Array.isArray(snap.antTrace)).toBe(true);
  });

  it('DEBUG_SNAPSHOT_VERSION is bumped to 2 for the self-describing guide', () => {
    expect(DEBUG_SNAPSHOT_VERSION).toBe(2);
  });

  it('skips dead ants in the trace', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    const liveId = allocateEntityId(world);
    initAnt(world.ants, liveId, { colonyId: COLONY_ID, posX: 0, posY: 0, task: AntTask.Foraging });
    const deadId = allocateEntityId(world);
    initAnt(world.ants, deadId, { colonyId: COLONY_ID, posX: 0, posY: 0, task: AntTask.Foraging });
    world.ants.alive[deadId] = 0;

    const snap = buildDebugSnapshot(world, 1, []);
    const ids = snap.antTrace.map((r) => r.antId);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(deadId);
  });

  it('skips queens (entity IDs referenced by colony.queenEntityId)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const queenId = allocateEntityId(world);
    const colony = createColonyRecord(COLONY_ID, queenId);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    setupSurfaceGrid(world, COLONY_ID);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });
    const workerId = allocateEntityId(world);
    initAnt(world.ants, workerId, { colonyId: COLONY_ID, posX: 0, posY: 0, task: AntTask.Foraging });

    const snap = buildDebugSnapshot(world, 1, []);
    const ids = snap.antTrace.map((r) => r.antId);
    expect(ids).toContain(workerId);
    expect(ids).not.toContain(queenId);
  });

  it('colonyFilter restricts the trace to listed colonies', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    for (const cid of [COLONY_ID, OTHER_COLONY_ID]) {
      const c = createColonyRecord(cid, -1);
      c.entrances = [];
      c.rallyPoint = null;
      c.digFlowFieldDirty = false;
      world.colonies[cid] = c;
      setupSurfaceGrid(world, cid);
    }
    const playerAnt = allocateEntityId(world);
    initAnt(world.ants, playerAnt, { colonyId: COLONY_ID, posX: 0, posY: 0, task: AntTask.Foraging });
    const enemyAnt = allocateEntityId(world);
    initAnt(world.ants, enemyAnt, { colonyId: OTHER_COLONY_ID, posX: 0, posY: 0, task: AntTask.Foraging });

    const filtered = buildDebugSnapshot(world, 1, [], [COLONY_ID]);
    const ids = filtered.antTrace.map((r) => r.antId);
    expect(ids).toContain(playerAnt);
    expect(ids).not.toContain(enemyAnt);
  });

  it('inputLog entries are shallow-copied (mutation after build does not leak)', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    const cmd = { type: 'NoOp' as const, issuedAtTick: 5 };
    const log = [cmd];
    const snap = buildDebugSnapshot(world, 1, log);
    // Mutating the original command does not alter the snapshot's copy.
    (cmd as unknown as { issuedAtTick: number }).issuedAtTick = 99;
    expect(snap.inputLog[0]!.issuedAtTick).toBe(5);
  });

  it('payload JSON-serializes cleanly (no TypedArrays or circular refs)', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 20 << FP_SHIFT,
      posY: 20 << FP_SHIFT,
      task: AntTask.Foraging,
    });
    const snap = buildDebugSnapshot(world, 42, []);
    // Will throw on circular refs; a stringified "{}" for a TypedArray would
    // still succeed so we also sanity-check a known-string-able field.
    const json = JSON.stringify(snap);
    expect(json.length).toBeGreaterThan(0);
    const roundTrip = JSON.parse(json);
    expect(roundTrip.seed).toBe(42);
    expect(Array.isArray(roundTrip.antTrace)).toBe(true);
  });

  it('defaultDebugSnapshotFilename includes seed and tick', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    const snap = buildDebugSnapshot(world, 999, []);
    const name = defaultDebugSnapshotFilename(snap);
    expect(name).toContain('seed999');
    expect(name).toContain(`tick${world.tick}`);
    expect(name.endsWith('.json')).toBe(true);
  });
});

describe('buildDebugSnapshot — BuildDebugSnapshotOptions (issue #122)', () => {
  function makeWorldWithAnts() {
    const { world } = setupWorldWithColony(COLONY_ID);
    setupSurfaceGrid(world, COLONY_ID);
    for (let i = 0; i < 4; i++) {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: COLONY_ID,
        posX: (10 + i) << FP_SHIFT,
        posY: (10 + i) << FP_SHIFT,
        task: AntTask.Foraging,
        subTask: ForagingSubState.SearchingFood,
      });
    }
    return world;
  }

  it('default options include both antTrace and inputLog (F9 path is unchanged)', () => {
    const world = makeWorldWithAnts();
    const log = [{ type: 'SetBehaviorRatio', colonyId: COLONY_ID, ratio: { forage: 50, fight: 50 }, issuedAtTick: 0 }] as never;
    const snap = buildDebugSnapshot(world, 1, log);
    expect(snap.antTrace.length).toBeGreaterThan(0);
    expect(snap.inputLog.length).toBe(1);
  });

  it('includeAntTrace=false emits an empty trace array (downgrade stage 1)', () => {
    const world = makeWorldWithAnts();
    const log = [{ type: 'SetBehaviorRatio', colonyId: COLONY_ID, ratio: { forage: 50, fight: 50 }, issuedAtTick: 0 }] as never;
    const snap = buildDebugSnapshot(world, 1, log, { includeAntTrace: false });
    expect(snap.antTrace).toEqual([]);
    // inputLog must still be present at this stage.
    expect(snap.inputLog.length).toBe(1);
  });

  it('includeInputLog=false drops the input log (downgrade stage 2)', () => {
    const world = makeWorldWithAnts();
    const log = [{ type: 'SetBehaviorRatio', colonyId: COLONY_ID, ratio: { forage: 50, fight: 50 }, issuedAtTick: 0 }] as never;
    const snap = buildDebugSnapshot(world, 1, log, { includeAntTrace: false, includeInputLog: false });
    expect(snap.antTrace).toEqual([]);
    expect(snap.inputLog).toEqual([]);
  });

  it('legacy colonyFilter array signature still works', () => {
    const world = makeWorldWithAnts();
    const snap = buildDebugSnapshot(world, 1, [], [COLONY_ID]);
    expect(snap.antTrace.every(r => r.colonyId === COLONY_ID)).toBe(true);
  });

  it('options.colonyFilter narrows the trace to the listed colonies', () => {
    const world = makeWorldWithAnts();
    const snap = buildDebugSnapshot(world, 1, [], { colonyFilter: [OTHER_COLONY_ID] });
    expect(snap.antTrace).toEqual([]);
  });
});

describe('buildDebugGuide — self-describing legend (issue #179)', () => {
  const guide = buildDebugGuide();

  /** Independent inversion of an object-const enum, mirroring the production
   *  derivation, so assertions check the guide against the LIVE enum rather
   *  than a hand-written table that could silently drift. */
  function invert(e: Record<string, number>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(e)) out[String(value)] = name;
    return out;
  }

  // Each guide.enums key paired with the enum it must legend. Driven off the
  // real enum objects so adding a member to any of them is automatically
  // covered by the assertions below.
  const ENUM_LEGEND_CASES: ReadonlyArray<readonly [string, Record<string, number>]> = [
    ['task', AntTask],
    ['subTask if task=Foraging', ForagingSubState],
    ['subTask if task=Nursing', NursingSubState],
    ['subTask if task=Digging', DiggingSubState],
    ['subTask if task=Fighting', FightingSubState],
    ['zone', Zone],
    ['chamberType', ChamberType],
    ['pheromoneType', PheromoneType],
  ];

  it.each(ENUM_LEGEND_CASES)(
    'guide.enums["%s"] contains exactly the live enum members (fails if any is missing, extra, or mislabeled)',
    (key, enumObj) => {
      // toEqual against an inversion of the LIVE enum: if buildDebugGuide ever
      // regressed to a hand-written / stale / wrong-enum table, or omitted a
      // newly added member, this assertion fails.
      expect(guide.enums[key]).toEqual(invert(enumObj));
    },
  );

  it('guide.enums uses concrete, correct mappings (hand-written oracle — non-tautological)', () => {
    // Values pinned by hand so the check does not merely re-derive what the
    // production helper derives: this catches a wrong-enum or dropped-member
    // regression independent of enumLegend's own iteration. Also pins the
    // task-specific subTask split (a Nursing subTask=1 is Feeding, NOT the
    // ForagingSubState CarryingFood).
    expect(guide.enums['task']).toMatchObject({ '0': 'Idle', '1': 'Foraging', '4': 'Nursing' });
    expect(guide.enums['subTask if task=Foraging']).toMatchObject({ '1': 'CarryingFood' });
    expect(guide.enums['subTask if task=Nursing']).toMatchObject({ '1': 'Feeding', '2': 'Attending' });
    expect(guide.enums['subTask if task=Digging']).toMatchObject({ '1': 'Excavating' });
    expect(guide.enums['zone']).toMatchObject({ '0': 'Surface', '1': 'Underground' });
    expect(guide.enums['chamberType']).toMatchObject({ '2': 'FoodStorage' });
    expect(guide.enums['pheromoneType']).toMatchObject({ '1': 'DangerTrail' });
  });

  it('explains every movementSource value, from a single source of truth (no hand-maintained duplicate)', () => {
    // MovementSource is `keyof typeof MOVEMENT_SOURCES` and inferMovementSource
    // is typed to return MovementSource, so the compiler already forbids
    // returning a value absent from MOVEMENT_SOURCES. This confirms the guide
    // re-exports that same map and that every entry is a non-empty explanation.
    expect(Object.keys(guide.movementSource).sort()).toEqual(Object.keys(MOVEMENT_SOURCES).sort());
    for (const [src, text] of Object.entries(guide.movementSource)) {
      expect(typeof text, `${src} explanation type`).toBe('string');
      expect(text.length, `${src} explanation non-empty`).toBeGreaterThan(0);
    }
  });

  it('documents fixed-point decoding, the -1 sentinels, and the pheromone-diamond layout', () => {
    expect(guide.fixedPoint).toContain('FP_ONE=256');
    expect(guide.fixedPoint).toContain('>> 8');
    // The three -1 sentinels carry different meanings per field — all present.
    expect(guide.sentinels['nearestEntranceDist']).toBeDefined();
    expect(guide.sentinels['targetPosX / targetPosY']).toBeDefined();
    expect(guide.sentinels['searchPrevTileX / searchPrevTileY']).toBeDefined();
    // Diamond prose names the row-major index formula and the LIVE radius.
    const side = 2 * DEBUG_TRACE_PHEROMONE_RADIUS + 1;
    expect(guide.nearbyPheromone).toContain(`(dy+r)*${side}`);
    expect(guide.nearbyPheromone).toContain(`r=nearbyPheromoneRadius=${DEBUG_TRACE_PHEROMONE_RADIUS}`);
  });

  it('is embedded in the full snapshot payload and survives JSON round-trip', () => {
    const { world } = setupWorldWithColony(COLONY_ID);
    const snap = buildDebugSnapshot(world, 7, []);
    expect(snap.guide).toEqual(guide);
    const roundTrip = JSON.parse(JSON.stringify(snap));
    expect(roundTrip.guide.enums.task[String(AntTask.Foraging)]).toBe('Foraging');
    expect(roundTrip.guide.movementSource.wander.length).toBeGreaterThan(0);
  });
});
