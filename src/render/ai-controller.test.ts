// ai-controller.test.ts
// Phase 9 / CMBT-01, CMBT-02, CMBT-03, CLNY-08
// Tests for the rule-based AI controller living in src/render/.
//
// No Phaser imported — ai-controller.ts is pure TS and testable in Node.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runAIController,
  aiInitialSetup,
  aiDigHeuristic,
  aiChamberPlacement,
  aiEntranceDesignation,
  AI_DIG_INTERVAL,
  AI_DIG_MARK_BUDGET,
  AI_QUEEN_CHAMBER_DEPTH,
  AI_FOOD_STORAGE_THRESHOLD,
  AI_NURSERY_THRESHOLD,
  AI_BEHAVIOR_RATIO,
} from './ai-controller.js';

import { createWorldState } from '../sim/types.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { ColonyRecord, ChamberRecord } from '../sim/colony/colony-store.js';
import { createUndergroundGrid, ugSet, UndergroundTileState } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { ENEMY_COLONY_ID } from '../sim/constants.js';

// ---------------------------------------------------------------------------
// World builder helpers
// ---------------------------------------------------------------------------

const GRID_W = 64;
const GRID_H = 64;

/**
 * Build a minimal WorldState with the given tick.
 * Uses `as unknown as WorldState` cast per the STATE.md FNDN-07 avoidance pattern for
 * render-layer tests — direct `world.tick = N` would trip the no-restricted-syntax rule.
 */
function makeWorld(tick = 0): WorldState {
  const base = createWorldState(42, 16);
  // Object-spread override so the FNDN-07 lint tripwire (AssignmentExpression on world.tick)
  // is not triggered. The cast is intentional and documented by the project (see STATE.md).
  return { ...base, tick } as unknown as WorldState;
}

/** Add a colony (with Phase 3 extension fields) to world.colonies. */
function addColony(world: WorldState, colonyId: ColonyId, queenEntityId: number): ColonyRecord {
  const colony = createColonyRecord(colonyId, queenEntityId) as ColonyRecord;
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  colony.foodFlowFieldDirty = false;
  world.colonies[colonyId] = colony;
  return colony;
}

/** Add an underground grid (all Solid by default) for the given colony. */
function addUndergroundGrid(world: WorldState, colonyId: ColonyId): void {
  world.undergroundGrids[colonyId] = createUndergroundGrid(GRID_W, GRID_H);
}

/** Set queen fixed-point position in ants SoA. */
function setQueenPos(world: WorldState, queenId: number, tileX: number, tileY: number): void {
  world.ants.posX[queenId] = tileX << FP_SHIFT;
  world.ants.posY[queenId] = tileY << FP_SHIFT;
}

/** Build a minimal ChamberRecord at tile coords. posX/posY are fixed-point. */
function makeChamber(
  chamberType: ChamberType,
  tileX: number,
  tileY: number,
  width = 3,
  height = 3,
): ChamberRecord {
  return {
    chamberId: 99,
    chamberType,
    foodStored: 0,
    posX: tileX << FP_SHIFT,
    posY: tileY << FP_SHIFT,
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ai-controller (CMBT-01..03, CLNY-08)', () => {

  // -------------------------------------------------------------------------
  describe('runAIController', () => {

    it('no-ops when aiColonyId does not exist (world.colonies[id] === undefined)', () => {
      const world = makeWorld(0);
      // No colony added
      runAIController(world, 99 as ColonyId);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('no-ops when colony.defeated === true', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      colony.defeated = true;
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      runAIController(world, 2 as ColonyId);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('accesses world.colonies via plain-object key (not .get())', () => {
      // Smoke test: colonies is Record<ColonyId, ColonyRecord>; runs without error.
      const world = makeWorld(0);
      addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      // Should not throw
      expect(() => runAIController(world, 2 as ColonyId)).not.toThrow();
    });

    it('calls all four heuristics for a live AI colony on tick 0', () => {
      const world = makeWorld(0);
      addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      // tick 0 fires aiInitialSetup (2 cmds) + aiDigHeuristic (tick%40=0 → no chambers → 0)
      // + aiChamberPlacement (no open tiles → 0) + aiEntranceDesignation (no entrances → no chambers → 0)
      runAIController(world, 2 as ColonyId);
      // At minimum: SetBehaviorRatio + DesignateEntrance from aiInitialSetup
      expect(world.commandQueue.length).toBeGreaterThanOrEqual(2);
    });

    it('does not push commands when colony already has entrances and no cadence match (tick=1)', () => {
      const world = makeWorld(1);
      const colony = addColony(world, 2 as ColonyId, 0);
      colony.entrances = [{ entranceId: 1, surfaceTileX: 10, surfaceTileY: 0, isOpen: true }];
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      runAIController(world, 2 as ColonyId);
      // tick=1: aiInitialSetup no-ops (not tick 0), aiDigHeuristic no-ops (1%40≠0),
      // aiChamberPlacement: no queen chamber → tries to find open spot (all Solid → null)
      // aiEntranceDesignation: has entrances → skip
      // So 0 commands
      expect(world.commandQueue).toHaveLength(0);
    });

  });

  // -------------------------------------------------------------------------
  describe('aiInitialSetup (CMBT-02 tick-0 setup)', () => {

    it('on tick 0, pushes SetBehaviorRatio with AI_BEHAVIOR_RATIO', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      aiInitialSetup(world, colony);
      const ratioCmd = world.commandQueue.find((c) => c.type === 'SetBehaviorRatio');
      expect(ratioCmd).toBeDefined();
      expect((ratioCmd as { ratio: typeof AI_BEHAVIOR_RATIO }).ratio).toEqual(AI_BEHAVIOR_RATIO);
      expect(ratioCmd!.issuedAtTick).toBe(0);
    });

    it('on tick 0, pushes DesignateEntrance for the AI queen\'s surface tile', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Place queen at tile (15, 8) → fixed-point
      setQueenPos(world, 0, 15, 8);
      aiInitialSetup(world, colony);
      const entranceCmd = world.commandQueue.find((c) => c.type === 'DesignateEntrance');
      expect(entranceCmd).toBeDefined();
      const ec = entranceCmd as { surfaceTileX: number; surfaceTileY: number };
      expect(ec.surfaceTileX).toBe(15); // derived from queen posX >> FP_SHIFT
      expect(ec.surfaceTileY).toBe(0);  // surface row
      expect(entranceCmd!.issuedAtTick).toBe(0);
    });

    it('does NOT push initial-setup commands after tick 0', () => {
      const world = makeWorld(1);
      const colony = addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      aiInitialSetup(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('every command pushed by aiInitialSetup carries issuedAtTick: world.tick', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      aiInitialSetup(world, colony);
      for (const cmd of world.commandQueue) {
        expect(cmd.issuedAtTick).toBe(0);
      }
    });

    it('SetBehaviorRatio uses the AI colonyId (not a hardcoded value)', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 42 as ColonyId, 0);
      colony.colonyId = 42 as ColonyId;
      setQueenPos(world, 0, 10, 5);
      aiInitialSetup(world, colony);
      const ratioCmd = world.commandQueue.find((c) => c.type === 'SetBehaviorRatio');
      expect((ratioCmd as { colonyId: number }).colonyId).toBe(42);
    });

  });

  // -------------------------------------------------------------------------
  describe('aiDigHeuristic', () => {

    it('does nothing when tick % AI_DIG_INTERVAL !== 0', () => {
      const world = makeWorld(1);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      aiDigHeuristic(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('does nothing at tick 0 when no chambers exist', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      aiDigHeuristic(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('pushes up to AI_DIG_MARK_BUDGET MarkDigTile commands on cadence ticks', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Place one chamber in a sea of Solid tiles
      colony.chambers.push(makeChamber(ChamberType.Queen, 20, 20));
      // Mark adjacent tiles as Open (to avoid immediate push); but we want Solid neighbors
      // The grid starts all Solid, so neighbors of chamber will be Solid → pushable
      aiDigHeuristic(world, colony);
      // Chamber at (20,20) size 3x3; neighbors checked per chamber tile (20,20) only
      // 4 adjacent directions: (20,19), (21,20), (20,21), (19,20) — all Solid
      // Budget = 5; 4 adjacents exist, so 4 commands pushed (≤ 5)
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      expect(digCmds.length).toBeGreaterThan(0);
      expect(digCmds.length).toBeLessThanOrEqual(AI_DIG_MARK_BUDGET);
    });

    it('respects AI_DIG_MARK_BUDGET and does not exceed it', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Add many chambers to ensure many potential dig targets
      for (let i = 5; i < 30; i += 4) {
        colony.chambers.push(makeChamber(ChamberType.Queen, i, 20, 1, 1));
      }
      aiDigHeuristic(world, colony);
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      expect(digCmds.length).toBeLessThanOrEqual(AI_DIG_MARK_BUDGET);
    });

    it('targets only Solid tiles (not Open/Marked/BeingDug)', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Place chamber at (10,10); mark all neighbors Open
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      ugSet(grid, 10, 9, UndergroundTileState.Open);   // N
      ugSet(grid, 11, 10, UndergroundTileState.Open);  // E
      ugSet(grid, 10, 11, UndergroundTileState.Open);  // S
      ugSet(grid, 9, 10, UndergroundTileState.Open);   // W
      aiDigHeuristic(world, colony);
      // No Solid neighbors → no commands
      expect(world.commandQueue).toHaveLength(0);
    });

    it('every MarkDigTile command has issuedAtTick: world.tick and no zone field', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      aiDigHeuristic(world, colony);
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      expect(digCmds.length).toBeGreaterThan(0);
      for (const cmd of digCmds) {
        expect(cmd.issuedAtTick).toBe(AI_DIG_INTERVAL);
        // zone field must not exist
        expect('zone' in cmd).toBe(false);
      }
    });

    it('deterministic: same world → same commands in same order', () => {
      function buildWorldAndRunDig(): typeof world.commandQueue {
        const world = makeWorld(AI_DIG_INTERVAL);
        const colony = addColony(world, 2 as ColonyId, 0);
        addUndergroundGrid(world, 2 as ColonyId);
        colony.chambers.push(makeChamber(ChamberType.Queen, 15, 15, 2, 2));
        colony.chambers.push(makeChamber(ChamberType.Nursery, 20, 10, 2, 2));
        aiDigHeuristic(world, colony);
        return world.commandQueue;
      }
      const run1 = buildWorldAndRunDig();
      const run2 = buildWorldAndRunDig();
      expect(run1).toEqual(run2);
    });

  });

  // -------------------------------------------------------------------------
  describe('aiChamberPlacement', () => {

    it('issues PlaceChamber Queen when no queen chamber exists, using anchorTileX/anchorTileY', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      // Mark a tile Open near AI_QUEEN_CHAMBER_DEPTH
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const chamberCmds = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      const queenCmd = chamberCmds.find(
        (c) => (c as { chamberType: number }).chamberType === ChamberType.Queen,
      );
      expect(queenCmd).toBeDefined();
      expect('anchorTileX' in queenCmd!).toBe(true);
      expect('anchorTileY' in queenCmd!).toBe(true);
      // tileX/tileY must NOT be present (wrong field names)
      expect('tileX' in queenCmd!).toBe(false);
      expect('tileY' in queenCmd!).toBe(false);
    });

    it('issues PlaceChamber FoodStorage when foodStored >= AI_FOOD_STORAGE_THRESHOLD', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      colony.foodStored = AI_FOOD_STORAGE_THRESHOLD;
      // Add a Queen chamber so that branch is skipped
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      // Open tile for FoodStorage
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const chamberCmds = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      const fsCmd = chamberCmds.find(
        (c) => (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      );
      expect(fsCmd).toBeDefined();
    });

    it('does NOT issue PlaceChamber FoodStorage when foodStored is below threshold', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      colony.foodStored = AI_FOOD_STORAGE_THRESHOLD - 1;
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      colony.chambers.push(makeChamber(ChamberType.FoodStorage, 10, 5));
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const fsCmd = world.commandQueue.find(
        (c) => c.type === 'PlaceChamber' && (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      );
      expect(fsCmd).toBeUndefined();
    });

    it('issues PlaceChamber Nursery when eggs+larvae >= AI_NURSERY_THRESHOLD', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      colony.eggCount = 6;
      colony.larvaeCount = 6; // 12 total >= AI_NURSERY_THRESHOLD
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, 7, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const nurseryCmd = world.commandQueue.find(
        (c) => c.type === 'PlaceChamber' && (c as { chamberType: number }).chamberType === ChamberType.Nursery,
      );
      expect(nurseryCmd).toBeDefined();
    });

    it('does NOT re-issue PlaceChamber when chamber already exists', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      colony.chambers.push(makeChamber(ChamberType.FoodStorage, 10, 5));
      colony.chambers.push(makeChamber(ChamberType.Nursery, 10, 7));
      aiChamberPlacement(world, colony);
      const chamberCmds = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      expect(chamberCmds).toHaveLength(0);
    });

    it('every PlaceChamber command uses anchorTileX/anchorTileY and issuedAtTick', () => {
      const world = makeWorld(5);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      for (const cmd of world.commandQueue) {
        if (cmd.type === 'PlaceChamber') {
          expect('anchorTileX' in cmd).toBe(true);
          expect('anchorTileY' in cmd).toBe(true);
          expect(cmd.issuedAtTick).toBe(5);
        }
      }
    });

  });

  // -------------------------------------------------------------------------
  describe('aiEntranceDesignation', () => {

    it('issues DesignateEntrance (with surfaceTileX/surfaceTileY) when colony has zero entrances', () => {
      const world = makeWorld(10);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Add a chamber near surface (tileY <= 3)
      colony.chambers.push(makeChamber(ChamberType.Queen, 15, 2));
      aiEntranceDesignation(world, colony);
      const entranceCmd = world.commandQueue.find((c) => c.type === 'DesignateEntrance');
      expect(entranceCmd).toBeDefined();
      expect('surfaceTileX' in entranceCmd!).toBe(true);
      expect('surfaceTileY' in entranceCmd!).toBe(true);
      expect((entranceCmd as { surfaceTileX: number }).surfaceTileX).toBe(15);
      expect((entranceCmd as { surfaceTileY: number }).surfaceTileY).toBe(0);
      expect(entranceCmd!.issuedAtTick).toBe(10);
    });

    it('does not issue DesignateEntrance when colony already has entrances', () => {
      const world = makeWorld(10);
      const colony = addColony(world, 2 as ColonyId, 0);
      colony.entrances = [{ entranceId: 1, surfaceTileX: 15, surfaceTileY: 0, isOpen: true }];
      colony.chambers.push(makeChamber(ChamberType.Queen, 15, 2));
      aiEntranceDesignation(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('does not issue DesignateEntrance when no chambers are near surface', () => {
      const world = makeWorld(10);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Chamber deep underground (tileY = 20, well beyond surfaceEdgeY+2 = 3)
      colony.chambers.push(makeChamber(ChamberType.Queen, 15, 20));
      aiEntranceDesignation(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('issues at most one DesignateEntrance per call', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Multiple near-surface chambers
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 2));
      colony.chambers.push(makeChamber(ChamberType.Nursery, 20, 1));
      aiEntranceDesignation(world, colony);
      const entranceCmds = world.commandQueue.filter((c) => c.type === 'DesignateEntrance');
      expect(entranceCmds).toHaveLength(1);
    });

  });

  // -------------------------------------------------------------------------
  describe('isDirtTileUnderground helper (via aiDigHeuristic)', () => {

    it('returns false (no commands) when grid does not exist for colonyId', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      // NO underground grid added
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      aiDigHeuristic(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('returns false on out-of-bounds (negative coords)', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Chamber at edge (0,0); N neighbor is (0,-1) — out of bounds
      colony.chambers.push(makeChamber(ChamberType.Queen, 0, 0, 1, 1));
      aiDigHeuristic(world, colony);
      // Only E and S neighbors are valid, both Solid → should push commands for in-bounds only
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      // None of the commands should have negative coords
      for (const cmd of digCmds) {
        const c = cmd as { tileX: number; tileY: number };
        expect(c.tileX).toBeGreaterThanOrEqual(0);
        expect(c.tileY).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns false on out-of-bounds (>= width/height)', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Chamber at far edge; E and S neighbors would exceed width/height
      colony.chambers.push(makeChamber(ChamberType.Queen, GRID_W - 1, GRID_H - 1, 1, 1));
      aiDigHeuristic(world, colony);
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      for (const cmd of digCmds) {
        const c = cmd as { tileX: number; tileY: number };
        expect(c.tileX).toBeLessThan(GRID_W);
        expect(c.tileY).toBeLessThan(GRID_H);
      }
    });

    it('returns true when tile is UndergroundTileState.Solid', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // All tiles start Solid; chamber at (10,10)
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      aiDigHeuristic(world, colony);
      // Should have pushed commands for Solid neighbors
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      expect(digCmds.length).toBeGreaterThan(0);
    });

    it('returns false when tile is Open (not diggable)', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      // Make all neighbors Open
      ugSet(grid, 10, 9, UndergroundTileState.Open);
      ugSet(grid, 11, 10, UndergroundTileState.Open);
      ugSet(grid, 10, 11, UndergroundTileState.Open);
      ugSet(grid, 9, 10, UndergroundTileState.Open);
      aiDigHeuristic(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('returns false when tile is Marked', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      colony.chambers.push(makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      ugSet(grid, 10, 9, UndergroundTileState.Marked);
      ugSet(grid, 11, 10, UndergroundTileState.Marked);
      ugSet(grid, 10, 11, UndergroundTileState.Marked);
      ugSet(grid, 9, 10, UndergroundTileState.Marked);
      aiDigHeuristic(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

  });

  // -------------------------------------------------------------------------
  describe('findOpenChamberSpot helper (via aiChamberPlacement)', () => {

    it('returns null (no command) when colony has no underground grid', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      // No underground grid
      setQueenPos(world, 0, 10, 10);
      aiChamberPlacement(world, colony);
      // No PlaceChamber Queen since grid is missing
      const chamberCmds = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      expect(chamberCmds).toHaveLength(0);
    });

    it('returns null when no Open tiles within radius', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // All tiles Solid — no Open tiles → no PlaceChamber
      setQueenPos(world, 0, 10, 10);
      aiChamberPlacement(world, colony);
      const chamberCmds = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      expect(chamberCmds).toHaveLength(0);
    });

    it('returns the Open tile nearest to preferredDepth', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Two Open tiles: one at preferredDepth, one far away
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      ugSet(grid, 10, 30, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const queenCmd = world.commandQueue.find(
        (c) => c.type === 'PlaceChamber' && (c as { chamberType: number }).chamberType === ChamberType.Queen,
      );
      expect(queenCmd).toBeDefined();
      const qc = queenCmd as { anchorTileY: number };
      // Should pick the tile at AI_QUEEN_CHAMBER_DEPTH (closer to preferredDepth)
      expect(qc.anchorTileY).toBe(AI_QUEEN_CHAMBER_DEPTH);
    });

    it('excludes tiles already occupied by existing chambers', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Open tile at exact preferred depth, but occupied by existing chamber
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      colony.chambers.push(makeChamber(ChamberType.Nursery, 10, AI_QUEEN_CHAMBER_DEPTH, 1, 1));
      // Also provide an alternative open tile
      ugSet(grid, 12, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const queenCmd = world.commandQueue.find(
        (c) => c.type === 'PlaceChamber' && (c as { chamberType: number }).chamberType === ChamberType.Queen,
      );
      // Should NOT place at (10, AI_QUEEN_CHAMBER_DEPTH) — that's occupied
      if (queenCmd !== undefined) {
        expect((queenCmd as { anchorTileX: number }).anchorTileX).not.toBe(10);
      }
    });

    it('deterministic: same world + same preferredDepth → same tile', () => {
      function runAndGetQueenAnchor(): { x: number; y: number } | undefined {
        const world = makeWorld(0);
        const colony = addColony(world, 2 as ColonyId, 0);
        addUndergroundGrid(world, 2 as ColonyId);
        setQueenPos(world, 0, 10, 10);
        const grid = world.undergroundGrids[2 as ColonyId]!;
        // Multiple open tiles — tiebreak should be deterministic
        ugSet(grid, 8, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
        ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
        ugSet(grid, 12, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
        aiChamberPlacement(world, colony);
        const queenCmd = world.commandQueue.find(
          (c) => c.type === 'PlaceChamber' && (c as { chamberType: number }).chamberType === ChamberType.Queen,
        );
        if (queenCmd === undefined) return undefined;
        return {
          x: (queenCmd as { anchorTileX: number }).anchorTileX,
          y: (queenCmd as { anchorTileY: number }).anchorTileY,
        };
      }
      const run1 = runAndGetQueenAnchor();
      const run2 = runAndGetQueenAnchor();
      expect(run1).toEqual(run2);
    });

  });

  // -------------------------------------------------------------------------
  describe('CLNY-08 compliance', () => {

    it('all pushed commands use the AI colonyId passed in (never the player colony)', () => {
      const PLAYER_COLONY_ID = 1 as ColonyId;
      const AI_COLONY_ID = 2 as ColonyId;
      const world = makeWorld(0);
      // Player colony exists but runAIController is only called for AI colony
      addColony(world, PLAYER_COLONY_ID, 0);
      const aiColony = addColony(world, AI_COLONY_ID, 1);
      setQueenPos(world, 1, 10, 5);
      addUndergroundGrid(world, AI_COLONY_ID);
      const grid = world.undergroundGrids[AI_COLONY_ID]!;
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      aiColony.foodStored = AI_FOOD_STORAGE_THRESHOLD;
      aiColony.eggCount = AI_NURSERY_THRESHOLD;
      runAIController(world, AI_COLONY_ID);
      expect(world.commandQueue.length).toBeGreaterThan(0);
      for (const cmd of world.commandQueue) {
        if ('colonyId' in cmd) {
          expect((cmd as { colonyId: ColonyId }).colonyId).toBe(AI_COLONY_ID);
          expect((cmd as { colonyId: ColonyId }).colonyId).not.toBe(PLAYER_COLONY_ID);
        }
      }
    });

    it('never mutates world.colonies, world.ants, or world.undergroundGrids directly', () => {
      const world = makeWorld(0);
      const aiColony = addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);

      // Take snapshot of sim state (excluding commandQueue)
      const beforeTick = world.tick;
      const beforePosX = world.ants.posX[0];
      const beforePosY = world.ants.posY[0];
      const beforeFoodStored = aiColony.foodStored;
      const beforeWorkerCount = aiColony.workerCount;
      const gridDataSnapshot = new Uint8Array(grid.data);

      runAIController(world, 2 as ColonyId);

      // Assert no sim state mutated (only commandQueue changed)
      expect(world.tick).toBe(beforeTick);
      expect(world.ants.posX[0]).toBe(beforePosX);
      expect(world.ants.posY[0]).toBe(beforePosY);
      expect(aiColony.foodStored).toBe(beforeFoodStored);
      expect(aiColony.workerCount).toBe(beforeWorkerCount);
      expect(grid.data).toEqual(gridDataSnapshot);
    });

    it('runAIController is only an orchestrator — has no isPlayer branching', () => {
      // Verifies architecture: the function doesn't condition on colony ownership internally.
      // Both AI and player colony (if passed) would get the same treatment.
      // This is enforced by the CLNY-08 principle: differentiation is at the CALLER level.
      const world = makeWorld(0);
      addColony(world, 1 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 1 as ColonyId);
      runAIController(world, 1 as ColonyId);
      // Commands pushed for colonyId=1 (the caller determined this is AI)
      for (const cmd of world.commandQueue) {
        if ('colonyId' in cmd) {
          expect((cmd as { colonyId: ColonyId }).colonyId).toBe(1 as ColonyId);
        }
      }
    });

  });

  // -------------------------------------------------------------------------
  describe('exported constants', () => {

    it('AI_DIG_INTERVAL is 40', () => expect(AI_DIG_INTERVAL).toBe(40));
    it('AI_DIG_MARK_BUDGET is 5', () => expect(AI_DIG_MARK_BUDGET).toBe(5));
    it('AI_QUEEN_CHAMBER_DEPTH is 10', () => expect(AI_QUEEN_CHAMBER_DEPTH).toBe(10));
    it('AI_FOOD_STORAGE_THRESHOLD is 8', () => expect(AI_FOOD_STORAGE_THRESHOLD).toBe(8));
    it('AI_NURSERY_THRESHOLD is 12', () => expect(AI_NURSERY_THRESHOLD).toBe(12));
    it('AI_BEHAVIOR_RATIO has two-field shape (Phase 10 / D-05)', () => {
      // Phase 10 / D-05 (LOCKED): BehaviorRatio is {forage, fight} only;
      // dig is auto-assigned via CTRL-06 (tick.ts step 10a).
      // Candidate A tuning: {forage:7, fight:3} preserves the original 5:2
      // forage:fight emphasis on the two-role schema. See plan 10-04 SUMMARY.
      expect(AI_BEHAVIOR_RATIO).toMatchObject({ forage: 7, fight: 3 });
      expect(AI_BEHAVIOR_RATIO).not.toHaveProperty('dig');
    });

  });

  // -------------------------------------------------------------------------
  // Phase 10 / D-05 — AI auto-dig parity
  //
  // D-05 (LOCKED): the AI uses the SAME auto-dig path as the player.
  // The AI keeps issuing MarkDigTileCommand at AI_DIG_INTERVAL cadence; the
  // sim-tier auto-dig override (tick.ts step 10a, Plan 10-02) drives Idle
  // ants into AntTask.Digging uniformly for both colonies (CLNY-08 invariant).
  //
  // These tests pin the end-to-end pipeline: runAIController + tick() →
  // AI ant in Digging via auto-dig. Distinct from tick.test.ts Phase 10
  // describe block (which exercises step 10a directly via MarkDigTile commands)
  // — these prove the AI's natural cadence flows through the same wire.
  // -------------------------------------------------------------------------
  describe('Phase 10 / D-05 — AI auto-dig parity', () => {

    it('AI ant reaches AntTask.Digging via auto-dig path within reasonable tick budget', () => {
      // Build a real 2-colony scenario; AI drives ENEMY_COLONY_ID only — same
      // pattern as ai-controller.integration.test.ts.
      const world = createScenario(42);
      const aiColony = world.colonies[ENEMY_COLONY_ID]!;
      expect(aiColony, 'AI colony should exist at ENEMY_COLONY_ID').toBeDefined();

      const countAntsByTask = (taskValue: number): number => {
        let n = 0;
        for (const wid of aiColony.workers) {
          if (world.ants.alive[wid] === 1 && world.ants.task[wid] === taskValue) n += 1;
        }
        return n;
      };

      // t=0 preconditions: zero Digging ants in the AI colony.
      expect(countAntsByTask(AntTask.Digging)).toBe(0);

      // Run the controller per-tick like GameScene.onBeforeTick does.
      // Generous upper bound: 200 ticks. AI_DIG_INTERVAL=40 so the AI marks
      // tiles within the first 80 ticks; auto-dig + ant movement to the
      // Marked tile usually completes within another 30-60 ticks.
      const MAX_TICKS = 200;
      let firstDiggerTick = -1;
      for (let t = 0; t < MAX_TICKS; t++) {
        runAIController(world, ENEMY_COLONY_ID);
        const cmds = world.commandQueue.splice(0);
        tick(world, cmds);
        if (countAntsByTask(AntTask.Digging) >= 1) {
          firstDiggerTick = t;
          break;
        }
      }

      // t=N outcomes: AI got a digger via the auto-dig path within budget.
      expect(
        firstDiggerTick,
        `AI did not reach AntTask.Digging within ${MAX_TICKS} ticks via auto-dig`,
      ).toBeGreaterThanOrEqual(0);
      // CTRL-06 strict 1-cap: at most one ant in the AI colony is Digging.
      expect(countAntsByTask(AntTask.Digging)).toBe(1);
    }, 30_000);

    it('CLNY-08 invariant: ai-controller.ts has no PLAYER_COLONY_ID branching', () => {
      // Source-text scan via fs.readFileSync. Conservative regexes — match any
      // branch on PLAYER_COLONY_ID (===) or `if (... isPlayer ...)` patterns.
      // STATE.md Phase 08-03 decision confirms this pattern is supported
      // (HUD-05 source-scan self-checks; @types/node installed as devDep).
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(__dirname, 'ai-controller.ts'), 'utf8');
      expect(src).not.toMatch(/PLAYER_COLONY_ID\s*===/);
      expect(src).not.toMatch(/if\s*\([^)]*\bisPlayer\b/);
    });

  });

});
