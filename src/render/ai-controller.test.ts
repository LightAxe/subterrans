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
  AI_CHAMBER_INTERVAL,
  AI_DIG_MARK_BUDGET,
  AI_QUEEN_CHAMBER_DEPTH,
  AI_PLACEMENT_DEPTH_TOLERANCE,
  aiQueenMinAnchorRow,
  AI_FOOD_STORAGE_THRESHOLD,
  AI_NURSERY_THRESHOLD,
  AI_BEHAVIOR_RATIO,
  AI_SURVIVAL_MAX_WORKERS,
  AI_SURVIVAL_FOOD_MULTIPLIER,
  AI_SURVIVAL_CANCEL_BUDGET,
  aiSurvivalMode,
  AI_SURVIVAL_RATIO,
  AI_EXTRA_FOOD_STORAGE_FULL_PCT,
  aiExtraFoodStorageWanted,
  aiSelectProbeTarget,
  aiNestDefence,
  aiThreatenedEntrance,
  aiDefenceSallies,
  AI_DEFENCE_RATIO,
  AI_DEFENCE_THREAT_RADIUS_TILES,
  AI_DEFENCE_ALERT_RAIDERS,
  AI_DEFENCE_HOLD_RADIUS_TILES,
  AI_DEFENCE_OPS_HOLD_LIMIT_TICKS,
  raidScanWeightBufferForTests,
  AI_DEFENCE_HOME_RADIUS_TILES,
  AI_DEFENCE_SALLY_KEEP_TILES,
} from './ai-controller.js';

import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V52_RAIDING,
  SIM_VERSION_V60_RAID_ORDERS,
  SIM_VERSION_V61_AI_EARLY_STORAGE,
  SIM_VERSION_V62_AI_NEST_DEFENCE,
  SIM_VERSION_V63_AI_DEEP_QUEEN,
  SIM_VERSION_V68_RAMPAGE_SHELTER,
  SIM_VERSION_V69_FOOD_FAIRNESS,
} from '../sim/types.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { createUndergroundGrid, ugSet, UndergroundTileState, Zone } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import type { AIStateRecord, WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { createScenario } from '../sim/scenario.js';
import { createDefaultAIStateRecord } from '../sim/ai-state.js';
import { tick, applyCommands } from '../sim/tick.js';
import { serializeWorldState, deserializeWorldState } from '../platform/save.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  ENEMY_START_X,
  PLAYER_COLONY_ID,
  PLAYER_START_X,
  FOOD_CHAMBER_CAPACITY,
  QUEEN_EGG_FOOD_THRESHOLD,
  STARTING_WORKERS,
} from '../sim/constants.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/food/food-api.js';
import {
  addChamberForTest,
  setPoolFoodForTest,
  setChamberStockForTest,
  setPilesForTest,
  type TestChamber,
} from '../sim/food/food-test-utils.js';

// ---------------------------------------------------------------------------
// World builder helpers
// ---------------------------------------------------------------------------

const GRID_W = 64;
const GRID_H = 64;
/** #374 (V63) — the AI's Queen anchor row on the test grid (a third of the way down). */
const QUEEN_ROW = aiQueenMinAnchorRow(GRID_H, CHAMBER_DIMENSIONS[ChamberType.Queen].height);

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
  const colony = createColonyRecord(colonyId, queenEntityId);
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
): TestChamber {
  return {
    chamberId: 99,
    chamberType,
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
      const colony = addColony(world, 2 as ColonyId, 0);
      // A bare 0-worker colony with an empty larder is (correctly) in survival
      // mode; give it a healthy larder so this exercises the ordinary wiring.
      setPoolFoodForTest(world, colony, QUEEN_EGG_FOOD_THRESHOLD * 2);
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      // tick 0 fires aiInitialSetup (2 cmds) + aiDigHeuristic (tick%40=0 → no chambers → 0)
      // + aiChamberPlacement (no open tiles → 0) + aiEntranceDesignation (no entrances → no chambers → 0)
      runAIController(world, 2 as ColonyId);
      // At minimum: SetBehaviorRatio + DesignateEntrance from aiInitialSetup
      expect(world.commandQueue.length).toBeGreaterThanOrEqual(2);
    });

    it('does not push commands when AI post-conditions are met and no cadence match (tick=1)', () => {
      const world = makeWorld(1);
      const colony = addColony(world, 2 as ColonyId, 0);
      colony.entrances = [{ entranceId: 1, surfaceTileX: 10, surfaceTileY: 0, isOpen: true }];
      // Issue #75 — aiInitialSetup is now post-condition-gated. Matching the
      // AI ratio AND having an entrance means setup is complete.
      colony.targetRatio.forage = AI_BEHAVIOR_RATIO.forage;
      colony.targetRatio.fight = AI_BEHAVIOR_RATIO.fight;
      setPoolFoodForTest(world, colony, QUEEN_EGG_FOOD_THRESHOLD * 2); // not in survival mode (see above)
      setQueenPos(world, 0, 10, 5);
      addUndergroundGrid(world, 2 as ColonyId);
      runAIController(world, 2 as ColonyId);
      // tick=1: aiInitialSetup no-ops (post-conditions met), aiDigHeuristic
      // no-ops (1%40≠0), aiChamberPlacement: no queen chamber → tries to find
      // open spot (all Solid → null), aiEntranceDesignation: has entrances → skip.
      // #258 retired the SyncAIState echo, so nothing at all may be queued here.
      expect(world.commandQueue).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('aiInitialSetup (CMBT-02 tick-0 setup)', () => {
    it('in V17+, does NOT push SetBehaviorRatio (owned by _syncBehaviorRatioToAIState)', () => {
      const world = makeWorld(0);
      // world.simVersion is already V17 (LATEST_SIM_VERSION via createWorldState)
      const colony = addColony(world, 2 as ColonyId, 0);
      setQueenPos(world, 0, 10, 5);
      aiInitialSetup(world, colony);
      const ratioCmd = world.commandQueue.find((c) => c.type === 'SetBehaviorRatio');
      expect(ratioCmd).toBeUndefined();
    });

    it("on tick 0, pushes DesignateEntrance for the AI queen's surface tile", () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Place queen at tile (15, 8) → fixed-point
      setQueenPos(world, 0, 15, 8);
      aiInitialSetup(world, colony);
      const entranceCmd = world.commandQueue.find((c) => c.type === 'DesignateEntrance');
      expect(entranceCmd).toBeDefined();
      const ec = entranceCmd as { surfaceTileX: number; surfaceTileY: number };
      expect(ec.surfaceTileX).toBe(15); // derived from queen posX >> FP_SHIFT
      expect(ec.surfaceTileY).toBe(0); // surface row
      expect(entranceCmd!.issuedAtTick).toBe(0);
    });

    it('does NOT push initial-setup commands when post-conditions already met (#75 idempotent)', () => {
      // Issue #75 — pre-fix gate was `world.tick !== 0` so any tick > 0 was
      // a no-op. Post-fix the gate is `entrances exist AND ratio matches`,
      // which is the actual contract. A save loaded mid-game (tick > 0)
      // with both post-conditions met short-circuits as expected.
      const world = makeWorld(1);
      const colony = addColony(world, 2 as ColonyId, 0);
      colony.entrances = [{ entranceId: 1, surfaceTileX: 10, surfaceTileY: 0, isOpen: true }];
      colony.targetRatio.forage = AI_BEHAVIOR_RATIO.forage;
      colony.targetRatio.fight = AI_BEHAVIOR_RATIO.fight;
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 20, 20));
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
        addChamberForTest(world, colony, makeChamber(ChamberType.Queen, i, 20, 1, 1));
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      ugSet(grid, 10, 9, UndergroundTileState.Open); // N
      ugSet(grid, 11, 10, UndergroundTileState.Open); // E
      ugSet(grid, 10, 11, UndergroundTileState.Open); // S
      ugSet(grid, 9, 10, UndergroundTileState.Open); // W
      aiDigHeuristic(world, colony);
      // No Solid neighbors → no commands
      expect(world.commandQueue).toHaveLength(0);
    });

    it('Issue #30: chamber at chTileY=1 → AI must NOT mark row 0 (top border skips ceiling)', () => {
      // The visible bug from PR #32 UAT: every chamber the AI placed at
      // chTileY=1 had its top-border perimeter loop hit ty=0, marking the
      // ceiling-strip tiles for digging. Once excavated, the chamber-edge
      // network straddled the grass band. isDirtTileUnderground now
      // rejects ty=0 so the AI never proposes those marks (the sim's
      // MarkDigTile gate would reject them anyway, but pre-filtering
      // saves AI_DIG_MARK_BUDGET on dead-on-arrival commands).
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Single-tile chamber at (10, 1) — top border lands on ty=0 = ceiling.
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 1, 1, 1));
      aiDigHeuristic(world, colony);
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      // Some marks fired (E/W/S neighbors are valid), but NONE on the ceiling row.
      expect(digCmds.length).toBeGreaterThan(0);
      for (const cmd of digCmds as Array<{ tileY: number }>) {
        expect(cmd.tileY).not.toBe(0);
      }
    });

    it('every MarkDigTile command has issuedAtTick: world.tick and no zone field', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 10, 1, 1));
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
        addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 15, 15, 2, 2));
        addChamberForTest(world, colony, makeChamber(ChamberType.Nursery, 20, 10, 2, 2));
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
      world.simVersion = SIM_VERSION_V62_AI_NEST_DEFENCE; // pre-V63 Queen depth (#374)
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
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD);
      // Add a Queen chamber so that branch is skipped
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
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
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD - 1);
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      addChamberForTest(world, colony, makeChamber(ChamberType.FoodStorage, 10, 5));
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const fsCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, 7, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const nurseryCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Nursery,
      );
      expect(nurseryCmd).toBeDefined();
    });

    it('does NOT re-issue PlaceChamber when chamber already exists', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      addChamberForTest(world, colony, makeChamber(ChamberType.FoodStorage, 10, 5));
      addChamberForTest(world, colony, makeChamber(ChamberType.Nursery, 10, 7));
      aiChamberPlacement(world, colony);
      const chamberCmds = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      expect(chamberCmds).toHaveLength(0);
    });

    it('every PlaceChamber command uses anchorTileX/anchorTileY and issuedAtTick', () => {
      // A chamber-cadence tick (off-cadence ticks return early and issue nothing).
      const world = makeWorld(AI_CHAMBER_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, QUEEN_ROW, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const placed = world.commandQueue.filter((c) => c.type === 'PlaceChamber');
      expect(placed.length).toBeGreaterThan(0);
      for (const cmd of placed) {
        expect('anchorTileX' in cmd).toBe(true);
        expect('anchorTileY' in cmd).toBe(true);
        expect(cmd.issuedAtTick).toBe(AI_CHAMBER_INTERVAL);
      }
    });
  });

  describe('#290 D14 — more FoodStorage when the stores are nearly full', () => {
    // Capacity with one completed FoodStorage = pool 2048 + chamber 5120 = 7168 fp.
    // 90 % of it is 6451.2, so 6452 fp is the first total that qualifies.
    const CAP_ONE_CHAMBER = BASE_FOOD_STORAGE_CAPACITY + FOOD_CHAMBER_CAPACITY;
    const FIRST_QUALIFYING = Math.ceil((CAP_ONE_CHAMBER * AI_EXTRA_FOOD_STORAGE_FULL_PCT) / 100);

    /** A settled AI colony: Queen, Nursery and one FoodStorage all completed, the
     *  stores holding `totalFp` (pool filled first), one Open anchor at (40, 5). */
    function settledColony(totalFp: number, withNursery = true) {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      if (withNursery) addChamberForTest(world, colony, makeChamber(ChamberType.Nursery, 20, 7));
      const fs = addChamberForTest(world, colony, makeChamber(ChamberType.FoodStorage, 10, 5));
      const pool = Math.min(totalFp, BASE_FOOD_STORAGE_CAPACITY);
      setPoolFoodForTest(world, colony, pool);
      setChamberStockForTest(world, colony, fs, totalFp - pool);
      ugSet(world.undergroundGrids[2 as ColonyId]!, 40, 5, UndergroundTileState.Open);
      return { world, colony };
    }

    const fsCommands = (world: WorldState) =>
      world.commandQueue.filter(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      ) as Array<{ anchorTileX: number; anchorTileY: number; colonyId: number }>;

    it('places a second FoodStorage once the stores reach the near-full threshold', () => {
      const { world, colony } = settledColony(FIRST_QUALIFYING);
      expect(colonyFoodTotal(world, colony)).toBe(FIRST_QUALIFYING);
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(true);
      aiChamberPlacement(world, colony);
      const cmds = fsCommands(world);
      expect(cmds).toHaveLength(1);
      expect(cmds[0]!.anchorTileX).toBe(40);
      expect(cmds[0]!.anchorTileY).toBe(5);
      expect(cmds[0]!.colonyId).toBe(2);
    });

    it('places nothing one fp below the threshold', () => {
      const { world, colony } = settledColony(FIRST_QUALIFYING - 1);
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
      aiChamberPlacement(world, colony);
      expect(world.commandQueue.filter((c) => c.type === 'PlaceChamber')).toHaveLength(0);
    });

    it('does not place a second while a FoodStorage is already pending', () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER);
      world.pendingChambers['2:30:5'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: 30,
        anchorTileY: 5,
        width: 4,
        height: 3,
      };
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
      aiChamberPlacement(world, colony);
      expect(fsCommands(world)).toHaveLength(0);
    });

    it("another colony's pending FoodStorage does not block this one", () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER);
      world.pendingChambers['1:30:5'] = {
        colonyId: 1 as ColonyId,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: 30,
        anchorTileY: 5,
        width: 4,
        height: 3,
      };
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(true);
    });

    /** settledColony plus `extra` more completed FoodStorage chambers (row 12), the
     *  stores holding `totalFp`: the pool first, then each chamber up to its cap. */
    function colonyWithChambers(extra: number, totalFp: number) {
      const { world, colony } = settledColony(0);
      for (let i = 0; i < extra; i++) {
        addChamberForTest(world, colony, makeChamber(ChamberType.FoodStorage, 10 + i * 5, 12));
      }
      let left = totalFp;
      const pool = Math.min(left, BASE_FOOD_STORAGE_CAPACITY);
      setPoolFoodForTest(world, colony, pool);
      left -= pool;
      for (const ch of colony.chambers) {
        if (ch.chamberType !== ChamberType.FoodStorage) continue;
        const fp = Math.min(left, FOOD_CHAMBER_CAPACITY);
        setChamberStockForTest(world, colony, ch, fp);
        left -= fp;
      }
      expect(left).toBe(0);
      return { world, colony };
    }

    // #395 — no fixed cap (it was 2): the near-full rule alone decides, judged
    // against the capacity every completed chamber adds.
    it.each([2, 4, 8, 16])(
      'no fixed cap: with %i completed FoodStorage chambers, full stores place another',
      (chambers) => {
        const capacity = BASE_FOOD_STORAGE_CAPACITY + chambers * FOOD_CHAMBER_CAPACITY;
        const threshold = Math.ceil((capacity * AI_EXTRA_FOOD_STORAGE_FULL_PCT) / 100);
        const below = colonyWithChambers(chambers - 1, threshold - 1);
        expect(colonyFoodCapacity(below.colony)).toBe(capacity);
        expect(aiExtraFoodStorageWanted(below.world, below.colony)).toBe(false);
        aiChamberPlacement(below.world, below.colony);
        expect(fsCommands(below.world)).toHaveLength(0);

        const at = colonyWithChambers(chambers - 1, threshold);
        expect(aiExtraFoodStorageWanted(at.world, at.colony)).toBe(true);
        aiChamberPlacement(at.world, at.colony);
        expect(fsCommands(at.world)).toHaveLength(1);
      },
    );

    it('no fixed cap: 16 brim-full chambers still wait for the pending one', () => {
      const capacity = BASE_FOOD_STORAGE_CAPACITY + 16 * FOOD_CHAMBER_CAPACITY;
      const { world, colony } = colonyWithChambers(15, capacity);
      world.pendingChambers['2:40:5'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: 40,
        anchorTileY: 5,
        width: 4,
        height: 3,
      };
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
      aiChamberPlacement(world, colony);
      expect(fsCommands(world)).toHaveLength(0);
    });

    it('Nursery keeps priority: full stores and no Nursery place the Nursery, not storage', () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER, false);
      ugSet(world.undergroundGrids[2 as ColonyId]!, 20, 7, UndergroundTileState.Open);
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
      aiChamberPlacement(world, colony);
      const placed = world.commandQueue
        .filter((c) => c.type === 'PlaceChamber')
        .map((c) => (c as { chamberType: number }).chamberType);
      expect(placed).toEqual([ChamberType.Nursery]);
    });

    it('a pending Nursery is enough: the extra storage then follows', () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER, false);
      world.pendingChambers['2:20:7'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.Nursery,
        anchorTileX: 20,
        anchorTileY: 7,
        width: 4,
        height: 3,
      };
      aiChamberPlacement(world, colony);
      expect(fsCommands(world)).toHaveLength(1);
    });

    it('waits for the Queen chamber to be COMPLETED, not merely pending', () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER);
      colony.chambers = colony.chambers.filter((c) => c.chamberType !== ChamberType.Queen);
      world.pendingChambers['2:10:18'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.Queen,
        anchorTileX: 10,
        anchorTileY: AI_QUEEN_CHAMBER_DEPTH,
        width: 5,
        height: 3,
      };
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
    });

    it('leaves the first FoodStorage to its own rule (no completed chamber → no extra)', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      addChamberForTest(world, colony, makeChamber(ChamberType.Nursery, 20, 7));
      setPoolFoodForTest(world, colony, BASE_FOOD_STORAGE_CAPACITY);
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
    });

    it('runs only on the chamber cadence, like every other placement', () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER);
      const offCadence = { ...world, tick: 1 } as unknown as WorldState;
      aiChamberPlacement(offCadence, colony);
      expect(fsCommands(offCadence)).toHaveLength(0);
    });

    it('is off below V53: a V52 world never gets the extra chamber', () => {
      const { world, colony } = settledColony(CAP_ONE_CHAMBER);
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(true);
      world.simVersion = SIM_VERSION_V52_RAIDING;
      expect(aiExtraFoodStorageWanted(world, colony)).toBe(false);
      aiChamberPlacement(world, colony);
      expect(fsCommands(world)).toHaveLength(0);
    });

    it('the near-full threshold is 90 %: 6452 fp of 7168 qualifies, 6451 does not', () => {
      // Absolute numbers, not derived from the constant: pool 2048 + one chamber
      // 5120 = 7168 fp capacity; 90 % of it is 6451.2 fp.
      expect(AI_EXTRA_FOOD_STORAGE_FULL_PCT).toBe(90);
      const high = settledColony(6452);
      expect(aiExtraFoodStorageWanted(high.world, high.colony)).toBe(true);
      const low = settledColony(6451);
      expect(aiExtraFoodStorageWanted(low.world, low.colony)).toBe(false);
    });

    it('is deterministic: the same world yields the same command', () => {
      const a = settledColony(CAP_ONE_CHAMBER);
      const b = settledColony(CAP_ONE_CHAMBER);
      aiChamberPlacement(a.world, a.colony);
      aiChamberPlacement(b.world, b.colony);
      expect(fsCommands(a.world)).toEqual(fsCommands(b.world));
    });
  });

  // -------------------------------------------------------------------------
  describe('aiEntranceDesignation', () => {
    it('issues DesignateEntrance (with surfaceTileX/surfaceTileY) when colony has zero entrances', () => {
      const world = makeWorld(10);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Add a chamber near surface (tileY <= 3)
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 15, 2));
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 15, 2));
      aiEntranceDesignation(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('does not issue DesignateEntrance when no chambers are near surface', () => {
      const world = makeWorld(10);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Chamber deep underground (tileY = 20, well beyond surfaceEdgeY+2 = 3)
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 15, 20));
      aiEntranceDesignation(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('issues at most one DesignateEntrance per call', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      // Multiple near-surface chambers
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 2));
      addChamberForTest(world, colony, makeChamber(ChamberType.Nursery, 20, 1));
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 10, 1, 1));
      aiDigHeuristic(world, colony);
      expect(world.commandQueue).toHaveLength(0);
    });

    it('returns false on out-of-bounds (negative coords)', () => {
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Chamber at edge (0,0); N neighbor is (0,-1) — out of bounds
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 0, 0, 1, 1));
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
      addChamberForTest(
        world,
        colony,
        makeChamber(ChamberType.Queen, GRID_W - 1, GRID_H - 1, 1, 1),
      );
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 10, 1, 1));
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 10, 1, 1));
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
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 10, 1, 1));
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
      world.simVersion = SIM_VERSION_V62_AI_NEST_DEFENCE; // pre-V63 Queen depth (#374)
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Two Open tiles: one at preferredDepth, one far away
      ugSet(grid, 10, AI_QUEEN_CHAMBER_DEPTH, UndergroundTileState.Open);
      ugSet(grid, 10, 30, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const queenCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Queen,
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
      ugSet(grid, 10, QUEEN_ROW, UndergroundTileState.Open);
      addChamberForTest(world, colony, makeChamber(ChamberType.Nursery, 10, QUEEN_ROW, 1, 1));
      // Also provide an alternative open tile
      ugSet(grid, 12, QUEEN_ROW, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const queenCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Queen,
      );
      // Should NOT place at (10, QUEEN_ROW) — that's occupied
      expect(queenCmd).toBeDefined();
      expect((queenCmd as { anchorTileX: number }).anchorTileX).not.toBe(10);
    });

    it('deterministic: same world + same preferredDepth → same tile', () => {
      function runAndGetQueenAnchor(): { x: number; y: number } | undefined {
        const world = makeWorld(0);
        const colony = addColony(world, 2 as ColonyId, 0);
        addUndergroundGrid(world, 2 as ColonyId);
        setQueenPos(world, 0, 10, 10);
        const grid = world.undergroundGrids[2 as ColonyId]!;
        // Multiple open tiles — tiebreak should be deterministic
        ugSet(grid, 8, QUEEN_ROW, UndergroundTileState.Open);
        ugSet(grid, 10, QUEEN_ROW, UndergroundTileState.Open);
        ugSet(grid, 12, QUEEN_ROW, UndergroundTileState.Open);
        aiChamberPlacement(world, colony);
        const queenCmd = world.commandQueue.find(
          (c) =>
            c.type === 'PlaceChamber' &&
            (c as { chamberType: number }).chamberType === ChamberType.Queen,
        );
        if (queenCmd === undefined) return undefined;
        return {
          x: (queenCmd as { anchorTileX: number }).anchorTileX,
          y: (queenCmd as { anchorTileY: number }).anchorTileY,
        };
      }
      const run1 = runAndGetQueenAnchor();
      const run2 = runAndGetQueenAnchor();
      expect(run1).toBeDefined();
      expect(run1).toEqual(run2);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #33 — anti-cluster spatial diversity
  // ---------------------------------------------------------------------------

  describe('#374 (V63) — the Queen chamber is at least a third of the way down', () => {
    /** Queen PlaceChamber anchor issued for `colony`, or undefined. */
    function queenAnchor(
      world: WorldState,
    ): { anchorTileX: number; anchorTileY: number } | undefined {
      return world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Queen,
      ) as { anchorTileX: number; anchorTileY: number } | undefined;
    }
    const QUEEN_H = CHAMBER_DIMENSIONS[ChamberType.Queen].height;
    // The first row at least a third of the way down the 64-row test grid.
    const THIRD = 22;

    it('aiQueenMinAnchorRow: the first row with 3 × row >= height', () => {
      expect(aiQueenMinAnchorRow(64, QUEEN_H)).toBe(THIRD); // 21·3 = 63 < 64, 22·3 = 66
      expect(aiQueenMinAnchorRow(63, QUEEN_H)).toBe(21); // exact third
      expect(aiQueenMinAnchorRow(65, QUEEN_H)).toBe(22);
      expect(aiQueenMinAnchorRow(66, QUEEN_H)).toBe(22);
      expect(aiQueenMinAnchorRow(67, QUEEN_H)).toBe(23);
      expect(aiQueenMinAnchorRow(128, QUEEN_H)).toBe(43);
    });

    it('aiQueenMinAnchorRow fallback: a grid too shallow for the footprint below a third uses the deepest row it fits', () => {
      // height 4: a third is row 2, but a 3-row footprint fits only from row 1.
      expect(aiQueenMinAnchorRow(4, QUEEN_H)).toBe(1);
      // (Grids of 3 rows or fewer cannot hold a Queen at all — row 0 is the ceiling.)
      // height 5: a third is row 2 and 2 + 3 = 5 still fits — no fallback.
      expect(aiQueenMinAnchorRow(5, QUEEN_H)).toBe(2);
    });

    it('the V62 anchor band (rows 14..21) no longer places the Queen', () => {
      for (let y = AI_QUEEN_CHAMBER_DEPTH - AI_PLACEMENT_DEPTH_TOLERANCE; y < THIRD; y++) {
        const world = makeWorld(0);
        expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V63_AI_DEEP_QUEEN);
        const colony = addColony(world, 2 as ColonyId, 0);
        addUndergroundGrid(world, 2 as ColonyId);
        setQueenPos(world, 0, 10, 64);
        ugSet(world.undergroundGrids[2 as ColonyId]!, 10, y, UndergroundTileState.Open);
        aiChamberPlacement(world, colony);
        expect(queenAnchor(world), `row ${y}`).toBeUndefined();
      }
    });

    it('the same world at V62 places the Queen at row 14 (the gate is what moved it)', () => {
      const world = makeWorld(0);
      world.simVersion = SIM_VERSION_V62_AI_NEST_DEFENCE;
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 64);
      ugSet(world.undergroundGrids[2 as ColonyId]!, 10, 14, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      expect(queenAnchor(world)?.anchorTileY).toBe(14);
    });

    it('a bootstrap shaft reaching a third of the way down places the Queen on that row, not a shallower one', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 64); // surface queen (pre-descent), as in a real match
      const grid = world.undergroundGrids[2 as ColonyId]!;
      for (let y = 0; y <= THIRD; y++) ugSet(grid, 10, y, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      expect(queenAnchor(world)).toMatchObject({ anchorTileX: 10, anchorTileY: THIRD });
    });

    it('prefers the third row over deeper candidates, and accepts a deeper one within tolerance when it is all there is', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 64);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, THIRD + 3, UndergroundTileState.Open);
      ugSet(grid, 20, THIRD, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      expect(queenAnchor(world)?.anchorTileY).toBe(THIRD);

      const world2 = makeWorld(0);
      const colony2 = addColony(world2, 2 as ColonyId, 0);
      addUndergroundGrid(world2, 2 as ColonyId);
      setQueenPos(world2, 0, 10, 64);
      ugSet(
        world2.undergroundGrids[2 as ColonyId]!,
        10,
        THIRD + AI_PLACEMENT_DEPTH_TOLERANCE,
        UndergroundTileState.Open,
      );
      aiChamberPlacement(world2, colony2);
      expect(queenAnchor(world2)?.anchorTileY).toBe(THIRD + AI_PLACEMENT_DEPTH_TOLERANCE);
    });

    it('the FoodStorage (larder) still goes shallow while the Queen waits for the deep row', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 64);
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      for (let y = 0; y <= 16; y++) ugSet(grid, 10, y, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      expect(queenAnchor(world)).toBeUndefined();
      const fs = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      ) as { anchorTileY: number } | undefined;
      expect(fs?.anchorTileY).toBe(5);
    });

    it('fallback: on a grid too shallow for the footprint below a third, the Queen goes on the deepest row it fits', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      // 4 rows: a third is row 2, but a 3-row footprint fits only from row 1.
      world.undergroundGrids[2 as ColonyId] = createUndergroundGrid(GRID_W, 4);
      setQueenPos(world, 0, 10, 64);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 10, 0, UndergroundTileState.Open);
      ugSet(grid, 10, 1, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      expect(queenAnchor(world)?.anchorTileY).toBe(1);
    });

    it('CLNY-08: the rule is the same for whichever colony the controller drives', () => {
      for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID] as ColonyId[]) {
        const world = makeWorld(0);
        const colony = addColony(world, cid, 0);
        addUndergroundGrid(world, cid);
        setQueenPos(world, 0, 10, 64);
        const grid = world.undergroundGrids[cid]!;
        for (let y = 0; y <= THIRD; y++) ugSet(grid, 10, y, UndergroundTileState.Open);
        aiChamberPlacement(world, colony);
        expect(queenAnchor(world)?.anchorTileY).toBe(THIRD);
      }
    });
  });

  describe('#395 (V69) — a surface queen off her start row still finds her Queen site', () => {
    function queenAnchorRow(world: WorldState): number | undefined {
      const c = world.commandQueue.find(
        (q) =>
          q.type === 'PlaceChamber' &&
          (q as { chamberType: number }).chamberType === ChamberType.Queen,
      ) as { anchorTileY: number } | undefined;
      return c?.anchorTileY;
    }
    const THIRD = QUEEN_ROW;
    /** A bootstrap shaft at column 10 down to a third of the way, the queen on the surface at row `y`. */
    function shaftWorld(
      y: number,
      simVersion: number,
    ): { world: WorldState; colony: ColonyRecord } {
      const world = makeWorld(0);
      world.simVersion = simVersion;
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, y);
      world.ants.zone[0] = Zone.Surface;
      const grid = world.undergroundGrids[2 as ColonyId]!;
      for (let r = 0; r <= THIRD; r++) ugSet(grid, 10, r, UndergroundTileState.Open);
      return { world, colony };
    }

    // Rows 55–63: from these the V68 search box (32 rows round her row read as an
    // underground row) stops short of the Queen depth. From row 54 or above it
    // reaches it, so those rows don't tell the versions apart.
    const DEADLOCK_ROWS = [63, 60, 55];

    it('scattered north of row 64 (rows 63, 60, 55) she still gets her Queen chamber a third of the way down', () => {
      for (const y of DEADLOCK_ROWS) {
        const { world, colony } = shaftWorld(y, SIM_VERSION_V69_FOOD_FAIRNESS);
        aiChamberPlacement(world, colony);
        expect(queenAnchorRow(world), `queen on surface row ${y}`).toBe(THIRD);
      }
    });

    it('at V68 the search seeded at her surface row read as underground: from rows 55–63 no Queen site (the deadlock)', () => {
      for (const y of DEADLOCK_ROWS) {
        const { world, colony } = shaftWorld(y, SIM_VERSION_V68_RAMPAGE_SHELTER);
        aiChamberPlacement(world, colony);
        expect(queenAnchorRow(world), `queen on surface row ${y}`).toBeUndefined();
      }
      // On her start row (64) both versions find it.
      for (const v of [SIM_VERSION_V68_RAMPAGE_SHELTER, SIM_VERSION_V69_FOOD_FAIRNESS]) {
        const w = shaftWorld(64, v);
        aiChamberPlacement(w.world, w.colony);
        expect(queenAnchorRow(w.world), `V${v}`).toBe(THIRD);
      }
    });

    it('a queen underground still seeds the search where she stands', () => {
      // Underground at (10, 60) with an open spot at the Queen depth: 38+ rows above
      // her, outside the 32-row search box, so no site — as at V68.
      const { world, colony } = shaftWorld(60, SIM_VERSION_V69_FOOD_FAIRNESS);
      world.ants.zone[0] = Zone.Underground;
      aiChamberPlacement(world, colony);
      expect(queenAnchorRow(world)).toBeUndefined();
    });

    it('a queen underground finds a FoodStorage site near her, outside the box round its preferred depth', () => {
      // FoodStorage prefers row 5 and has no depth gate. The only Open tile is (10, 45):
      // 5 rows from the queen at (10, 50), 40 rows from row 5 (outside a 32-row box).
      // Found only if the search starts where she stands.
      const world = makeWorld(0);
      world.simVersion = SIM_VERSION_V69_FOOD_FAIRNESS;
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 50);
      world.ants.zone[0] = Zone.Underground;
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD);
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      ugSet(world.undergroundGrids[2 as ColonyId]!, 10, 45, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const fs = world.commandQueue.find(
        (q) =>
          q.type === 'PlaceChamber' &&
          (q as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      ) as { anchorTileX: number; anchorTileY: number } | undefined;
      expect(fs?.anchorTileX).toBe(10);
      expect(fs?.anchorTileY).toBe(45);
    });
  });

  describe('issue #33 — depth gate + spread bias', () => {
    it('depth gate: Queen does NOT place when only shallow Y candidates exist (Δy > tolerance)', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Only shallow tile available (Y=2): above the V63 Queen floor (row 22), and
      // |2 - 18| = 16 is outside tolerance=4 for the pre-V63 rule too.
      // Pre-issue-#33 the AI placed Queen at the entrance shaft floor; with
      // the gate it must defer until the bootstrap dig has progressed.
      ugSet(grid, 10, 2, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const queenCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Queen,
      );
      expect(queenCmd).toBeUndefined();
    });

    it('depth gate: Queen DOES place when a candidate exists within ±tolerance of preferredDepth', () => {
      const world = makeWorld(0);
      world.simVersion = SIM_VERSION_V62_AI_NEST_DEFENCE; // pre-V63 Queen depth (#374)
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Y=14 is within tolerance 4 of preferredDepth 18 (delta = 4).
      ugSet(grid, 10, 14, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const queenCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Queen,
      ) as { anchorTileY: number } | undefined;
      expect(queenCmd).toBeDefined();
      expect(queenCmd!.anchorTileY).toBe(14);
    });

    it('spread bias: among same-depth candidates, anchor farthest from existing chambers wins', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Two candidates at Nursery preferredDepth=7: anchor X=14 (close to
      // existing Queen+FS at X≈10) and X=40 (far). Both have valid 4x3
      // footprints that don't overlap any existing chamber. Spread bias
      // should pick X=40.
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, AI_QUEEN_CHAMBER_DEPTH));
      addChamberForTest(world, colony, makeChamber(ChamberType.FoodStorage, 10, 5));
      colony.eggCount = 6;
      colony.larvaeCount = 6; // Triggers Nursery via brood threshold.
      ugSet(grid, 14, 7, UndergroundTileState.Open);
      ugSet(grid, 40, 7, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const nurseryCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.Nursery,
      ) as { anchorTileX: number; anchorTileY: number } | undefined;
      expect(nurseryCmd).toBeDefined();
      // Nursery lands at X=40 — farther from the existing chambers at X=10.
      expect(nurseryCmd!.anchorTileX).toBe(40);
      expect(nurseryCmd!.anchorTileY).toBe(7);
    });

    it('Queen-first ordering (pre-V61): FoodStorage does NOT place before Queen exists, even with food >= threshold', () => {
      const world = makeWorld(0);
      // #370 — the Queen-first order is kept for pre-V61 worlds only.
      world.simVersion = SIM_VERSION_V60_RAID_ORDERS;
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD * 100); // Far above threshold.
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Open tile at FS preferredDepth (5). Pre-fix the FS gate fired here
      // immediately; the FS chamber landed and blocked the bootstrap dig
      // before the Queen could find a deep enough spot.
      ugSet(grid, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const fsCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      );
      expect(fsCmd).toBeUndefined();
    });

    it('#370 (V61): the first FoodStorage places with no Queen chamber, completed or pending', () => {
      const world = makeWorld(0);
      expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V61_AI_EARLY_STORAGE);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Only a shallow Open tile: the Queen's depth gate refuses it, the
      // FoodStorage (no depth gate) takes it.
      ugSet(grid, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const placed = world.commandQueue
        .filter((c) => c.type === 'PlaceChamber')
        .map((c) => c as { chamberType: number; anchorTileX: number; anchorTileY: number });
      expect(placed).toEqual([
        expect.objectContaining({
          chamberType: ChamberType.FoodStorage,
          anchorTileX: 10,
          anchorTileY: 5,
        }),
      ]);
    });

    it('#370 (V61): the early FoodStorage still waits for the food threshold and for no FoodStorage in flight', () => {
      const below = makeWorld(0);
      const c1 = addColony(below, 2 as ColonyId, 0);
      addUndergroundGrid(below, 2 as ColonyId);
      setQueenPos(below, 0, 10, 10);
      setPoolFoodForTest(below, c1, AI_FOOD_STORAGE_THRESHOLD - 1);
      ugSet(below.undergroundGrids[2 as ColonyId]!, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(below, c1);
      expect(below.commandQueue.filter((c) => c.type === 'PlaceChamber')).toHaveLength(0);

      const pending = makeWorld(0);
      const c2 = addColony(pending, 2 as ColonyId, 0);
      addUndergroundGrid(pending, 2 as ColonyId);
      setQueenPos(pending, 0, 10, 10);
      setPoolFoodForTest(pending, c2, AI_FOOD_STORAGE_THRESHOLD);
      ugSet(pending.undergroundGrids[2 as ColonyId]!, 10, 5, UndergroundTileState.Open);
      pending.pendingChambers['2:30:1'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: 30,
        anchorTileY: 1,
        width: 4,
        height: 3,
      };
      aiChamberPlacement(pending, c2);
      expect(pending.commandQueue.filter((c) => c.type === 'PlaceChamber')).toHaveLength(0);
    });

    it('bootstrap dig continues while Queen is pending (codex P1 — deadlock guard)', () => {
      // Pre-fix the bootstrap was gated on "no Queen chamber AND no Queen
      // pending", which meant a Queen anchor that workers couldn't reach
      // (e.g., past unreachable Solid tiles) deadlocked the colony: the
      // pending blocked bootstrap, no other chambers existed to drive the
      // steady-state pass, and the Queen never completed. Continue
      // bootstrap while Queen is merely pending — the extra dig marks
      // around the deepest Open tile guarantee workers can always reach
      // the anchor by punching dirt as needed.
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Carve an entrance shaft so bootstrap has a deepest-Open tile.
      ugSet(grid, 32, 0, UndergroundTileState.Open);
      ugSet(grid, 32, 1, UndergroundTileState.Open);
      // Queen is pending (no chamber yet).
      world.pendingChambers['2:30:14'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.Queen,
        anchorTileX: 30,
        anchorTileY: 14,
        width: 5,
        height: 3,
      };
      aiDigHeuristic(world, colony);
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile');
      // Without the codex P1 fix, digCmds would be empty — bootstrap was
      // blocked by Queen-pending. With the fix it continues and emits
      // dig marks around the deepest Open tile.
      expect(digCmds.length).toBeGreaterThan(0);
    });

    it('depth gate does NOT apply to FoodStorage/Nursery (codex P2 — only Queen)', () => {
      // Pre-fix the depth gate applied to every findOpenChamberSpot call,
      // so a FoodStorage gate firing when only deep Open tiles existed
      // would silently never place the chamber (the BFS found candidates
      // at Y=15+ but the gate rejected them as |Y - 5| > tolerance).
      // Restricting the gate to Queen lets FS/Nursery land at the closest
      // available Y when the dig has gone deeper than their preferredDepth.
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD * 100);
      // Queen exists at a deep position; the only FS-eligible Open tile is
      // at Y=20 — way outside the (preferredDepth=5, tolerance=4) gate.
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 10, 18));
      const grid = world.undergroundGrids[2 as ColonyId]!;
      ugSet(grid, 30, 20, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const fsCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      ) as { anchorTileX: number; anchorTileY: number } | undefined;
      // FS should land at the only valid anchor, despite Y=20 being far
      // outside the Queen-style depth gate's ±4 tolerance.
      expect(fsCmd).toBeDefined();
      expect(fsCmd!.anchorTileY).toBe(20);
    });

    it('frontier collection bounds-checks footprint probes (codex P2 — edge aliasing)', () => {
      // Two chambers in the same row at opposite ends of the grid:
      //   A at (GRID_W-1, 5), B at (0, 5).
      // collectFrontierTiles walks A's top border, considering tile
      // (GRID_W-1, 4). The neighbor probe `isFootprint(GRID_W, 4)` would
      // — without bounds checking — produce a key equal to
      // `4*GRID_W + GRID_W = 5*GRID_W + 0`, colliding with the footprint
      // tile (0, 5) where B sits. Without the bounds guard, A's top tile
      // is wrongly rejected as adjacent to another chamber and never
      // makes it into the frontier dig pass.
      const world = makeWorld(AI_DIG_INTERVAL);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      // Place A at right edge, B at left edge. Both 1x1 to keep the
      // arithmetic crisp.
      const RIGHT_EDGE = 63; // GRID_W - 1, matches addUndergroundGrid GRID_W=64
      addChamberForTest(world, colony, makeChamber(ChamberType.Queen, RIGHT_EDGE, 5, 1, 1));
      addChamberForTest(world, colony, makeChamber(ChamberType.FoodStorage, 0, 5, 1, 1));

      aiDigHeuristic(world, colony);
      const digCmds = world.commandQueue.filter((c) => c.type === 'MarkDigTile') as Array<{
        tileX: number;
        tileY: number;
      }>;
      // The right-edge chamber's top tile (RIGHT_EDGE, 4) must appear in
      // the dig commands — either via the frontier pass or the legacy
      // perimeter pass. Without the bounds fix, the frontier pass falsely
      // rejected it; the legacy pass picks it up regardless, so the
      // bug manifested as "no frontier extension" rather than "no dig at
      // all". Assert a stronger property: the (RIGHT_EDGE, 4) command
      // must be present.
      const hasTopRightMark = digCmds.some((c) => c.tileX === RIGHT_EDGE && c.tileY === 4);
      expect(hasTopRightMark).toBe(true);
    });

    it('Queen-pending counts as Queen for FS gate (no double-pending)', () => {
      const world = makeWorld(0);
      const colony = addColony(world, 2 as ColonyId, 0);
      addUndergroundGrid(world, 2 as ColonyId);
      setQueenPos(world, 0, 10, 10);
      setPoolFoodForTest(world, colony, AI_FOOD_STORAGE_THRESHOLD * 100);
      const grid = world.undergroundGrids[2 as ColonyId]!;
      // Pending Queen blocks the bootstrap-dig gate AND counts as "queen
      // exists" for the FS gate, so FS can place even before the Queen
      // chamber transitions from pending to ChamberRecord.
      world.pendingChambers['2:10:18'] = {
        colonyId: 2 as ColonyId,
        chamberType: ChamberType.Queen,
        anchorTileX: 10,
        anchorTileY: 18,
        width: 5,
        height: 3,
      };
      ugSet(grid, 10, 5, UndergroundTileState.Open);
      aiChamberPlacement(world, colony);
      const fsCmd = world.commandQueue.find(
        (c) =>
          c.type === 'PlaceChamber' &&
          (c as { chamberType: number }).chamberType === ChamberType.FoodStorage,
      );
      expect(fsCmd).toBeDefined();
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
      ugSet(grid, 10, QUEEN_ROW, UndergroundTileState.Open);
      setPoolFoodForTest(world, aiColony, AI_FOOD_STORAGE_THRESHOLD);
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
      ugSet(grid, 10, QUEEN_ROW, UndergroundTileState.Open);

      // Take snapshot of sim state (excluding commandQueue)
      const beforeTick = world.tick;
      const beforePosX = world.ants.posX[0];
      const beforePosY = world.ants.posY[0];
      const beforeFoodStored = colonyFoodTotal(world, aiColony);
      const beforeWorkerCount = aiColony.workerCount;
      const gridDataSnapshot = new Uint8Array(grid.data);

      runAIController(world, 2 as ColonyId);

      // Assert no sim state mutated (only commandQueue changed)
      expect(world.tick).toBe(beforeTick);
      expect(world.ants.posX[0]).toBe(beforePosX);
      expect(world.ants.posY[0]).toBe(beforePosY);
      expect(colonyFoodTotal(world, aiColony)).toBe(beforeFoodStored);
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
    it('AI_QUEEN_CHAMBER_DEPTH is 18 (issue #33 — deeper to satisfy maxDepth>15 acceptance criterion)', () =>
      expect(AI_QUEEN_CHAMBER_DEPTH).toBe(18));
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
      // Source-text scan via fs.readFileSync (STATE.md Phase 08-03: HUD-05
      // source-scan self-checks; @types/node installed as devDep). The controller
      // must not know which colony it drives: differentiation happens at the
      // caller. Comments are stripped first so prose may name the constants.
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(__dirname, 'ai-controller.ts'), 'utf8');
      const code = clny08StripComments(src);
      // Any comparison with a colony-ID constant, in EITHER operand order and with
      // any (in)equality operator — the pre-fix guard only matched
      // `PLAYER_COLONY_ID ===`, so `aiColonyId === PLAYER_COLONY_ID` slipped by.
      for (const re of CLNY08_BRANCH_PATTERNS) expect(code).not.toMatch(re);
      // Stronger: the code does not reference a per-colony identity or start
      // constant at all (a lookup table keyed on them would dodge the above).
      expect(code).not.toMatch(CLNY08_COLONY_CONSTANT);
      expect(code).not.toMatch(/if\s*\([^)]*\bisPlayer\b/);
    });

    it('CLNY-08 guard self-check: catches both operand orders, !==, and constant references', () => {
      const cases = [
        'if (PLAYER_COLONY_ID === id) {}',
        'if (id === PLAYER_COLONY_ID) {}',
        'const x = aiColonyId === PLAYER_COLONY_ID ? A : B;',
        'if (id !== ENEMY_COLONY_ID) {}',
        'if (ENEMY_COLONY_ID!==id) {}',
        'if (id == PLAYER_COLONY_ID) {}',
        'switch (id) { case PLAYER_COLONY_ID: break; }',
      ];
      for (const c of cases) {
        expect(
          CLNY08_BRANCH_PATTERNS.some((re) => re.test(c)),
          c,
        ).toBe(true);
      }
      // The exact #347 shape (f7288f2) — caught by both layers.
      const f7288f2 =
        'const aiEntranceX = x ? y\n  : aiColonyId === PLAYER_COLONY_ID\n    ? PLAYER_START_X\n    : ENEMY_START_X;';
      expect(CLNY08_BRANCH_PATTERNS.some((re) => re.test(f7288f2))).toBe(true);
      expect(f7288f2).toMatch(CLNY08_COLONY_CONSTANT);
      // Comments are not code.
      expect(
        clny08StripComments('// aiColonyId === PLAYER_COLONY_ID\n/* ENEMY_START_X */ x'),
      ).not.toMatch(CLNY08_COLONY_CONSTANT);
    });
  });
});

// CLNY-08 source-guard helpers (see the invariant test above).
const CLNY08_ID = String.raw`\b(?:PLAYER|ENEMY)_COLONY_ID\b`;
const CLNY08_BRANCH_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${CLNY08_ID}\s*[!=]==?`),
  new RegExp(String.raw`[!=]==?\s*${CLNY08_ID}`),
  new RegExp(String.raw`\bcase\s+${CLNY08_ID}`),
];
const CLNY08_COLONY_CONSTANT = /\b(?:PLAYER|ENEMY)_(?:COLONY_ID|START_[XY])\b/;
function clny08StripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// #293 — survival mode (render-side, no simVersion, no memory)
// ---------------------------------------------------------------------------

describe('#293 survival mode', () => {
  const AI = 2 as ColonyId;
  const FOOD_BOUND = QUEEN_EGG_FOOD_THRESHOLD * AI_SURVIVAL_FOOD_MULTIPLIER;

  /**
   * A developed AI colony on a dig-cadence tick: completed Queen chamber in a sea of
   * Solid (so aiDigHeuristic marks its perimeter when allowed), initial-setup
   * post-conditions met (entrance + AI ratio, so no setup commands), `marked` extra
   * Marked tiles outstanding, and the given headcount / larder.
   */
  function survivalWorld(
    workers: number,
    food: number,
    marked = 0,
    tickAt: number = AI_DIG_INTERVAL,
  ): { world: WorldState; colony: ColonyRecord } {
    const world = makeWorld(tickAt);
    const colony = addColony(world, AI, 0);
    setQueenPos(world, 0, 10, 5);
    addUndergroundGrid(world, AI);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 10, surfaceTileY: 0, isOpen: true }];
    colony.targetRatio.forage = AI_BEHAVIOR_RATIO.forage;
    colony.targetRatio.fight = AI_BEHAVIOR_RATIO.fight;
    addChamberForTest(world, colony, makeChamber(ChamberType.Queen, 20, 20));
    // Live roster: survival mode counts colony.workers entries with alive === 1, so
    // spawn real worker ants (workerCount is kept in step for the sim's own readers).
    for (let i = 0; i < workers; i++) spawnWorker(world, colony);
    setPoolFoodForTest(world, colony, food);
    const grid = world.undergroundGrids[AI]!;
    for (let i = 0; i < marked; i++) {
      ugSet(grid, 40 + (i % 8), 40 + Math.floor(i / 8), UndergroundTileState.Marked);
    }
    return { world, colony };
  }

  function spawnWorker(world: WorldState, colony: ColonyRecord): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: colony.colonyId,
      posX: 10 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    return id;
  }

  function counts(world: WorldState): { mark: number; place: number; cancel: number } {
    let mark = 0;
    let place = 0;
    let cancel = 0;
    for (const c of world.commandQueue) {
      if (c.type === 'MarkDigTile') mark++;
      else if (c.type === 'PlaceChamber') place++;
      else if (c.type === 'CancelDigMark') cancel++;
    }
    return { mark, place, cancel };
  }

  /** Run the controller again on the same world (same tick), reading only this call's commands. */
  function runAgain(world: WorldState): { mark: number; place: number; cancel: number } {
    world.commandQueue.splice(0);
    runAIController(world, AI);
    return counts(world);
  }

  it('constants: the worker bound is below the starting cohort; the larder bound is above the (pre-V70) egg threshold', () => {
    expect(AI_SURVIVAL_MAX_WORKERS).toBeLessThan(STARTING_WORKERS);
    expect(AI_SURVIVAL_FOOD_MULTIPLIER).toBeGreaterThan(1);
  });

  it('survival mode overrides the state ratio to forage-only, and the state ratio returns once out of mode', () => {
    const { world, colony } = survivalWorld(
      AI_SURVIVAL_MAX_WORKERS,
      QUEEN_EGG_FOOD_THRESHOLD - 1,
      0,
    );
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'WarFooting';
    world.aiState.push(rec);
    runAIController(world, AI);
    const pushed = world.commandQueue.filter((c) => c.type === 'SetBehaviorRatio') as Array<{
      ratio: { forage: number; fight: number };
    }>;
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.ratio).toEqual({
      forage: AI_SURVIVAL_RATIO.forage,
      fight: AI_SURVIVAL_RATIO.fight,
    });
    // Apply it, recover the larder: the WarFooting ratio comes back.
    colony.targetRatio.forage = AI_SURVIVAL_RATIO.forage;
    colony.targetRatio.fight = AI_SURVIVAL_RATIO.fight;
    setPoolFoodForTest(world, colony, FOOD_BOUND);
    world.commandQueue.splice(0);
    runAIController(world, AI);
    const back = world.commandQueue.filter((c) => c.type === 'SetBehaviorRatio') as Array<{
      ratio: { forage: number; fight: number };
    }>;
    expect(back).toHaveLength(1);
    expect(back[0]!.ratio).toEqual({ forage: 3, fight: 7 });
  });

  it('cannot fire during the normal opening: 3 workers with an empty larder still digs', () => {
    const { world, colony } = survivalWorld(STARTING_WORKERS, 0, 3);
    expect(aiSurvivalMode(world, colony)).toBe(false);
    runAIController(world, AI);
    const c = counts(world);
    expect(c.mark).toBeGreaterThan(0);
    expect(c.cancel).toBe(0);
  });

  it('a 3-worker colony always digs, whatever its larder (there is no held state to keep it in mode)', () => {
    for (const food of [0, QUEEN_EGG_FOOD_THRESHOLD, FOOD_BOUND - 1, FOOD_BOUND]) {
      const { world, colony } = survivalWorld(STARTING_WORKERS, food, 2);
      expect(aiSurvivalMode(world, colony)).toBe(false);
      runAIController(world, AI);
      expect(counts(world).mark).toBeGreaterThan(0);
      expect(counts(world).cancel).toBe(0);
    }
  });

  it('in mode at 2 workers below the larder bound: no MarkDigTile / PlaceChamber, outstanding marks cancelled', () => {
    const { world } = survivalWorld(AI_SURVIVAL_MAX_WORKERS, QUEEN_EGG_FOOD_THRESHOLD - 1, 3);
    runAIController(world, AI);
    const c = counts(world);
    expect(c.mark).toBe(0);
    expect(c.place).toBe(0);
    expect(c.cancel).toBe(3);
    const cancelled = world.commandQueue
      .filter((cmd) => cmd.type === 'CancelDigMark')
      .map((cmd) => `${(cmd as { tileX: number }).tileX},${(cmd as { tileY: number }).tileY}`);
    expect(cancelled).toEqual(['40,40', '41,40', '42,40']);
  });

  it('in mode at 2 workers with the larder between 1x and 2x the egg threshold; out at exactly 2x', () => {
    const mid = survivalWorld(AI_SURVIVAL_MAX_WORKERS, FOOD_BOUND - 1, 2);
    expect(aiSurvivalMode(mid.world, mid.colony)).toBe(true);
    runAIController(mid.world, AI);
    expect(counts(mid.world).mark).toBe(0);
    expect(counts(mid.world).cancel).toBe(2);
    const at = survivalWorld(AI_SURVIVAL_MAX_WORKERS, FOOD_BOUND, 2);
    expect(aiSurvivalMode(at.world, at.colony)).toBe(false);
    runAIController(at.world, AI);
    expect(counts(at.world).mark).toBeGreaterThan(0);
    expect(counts(at.world).cancel).toBe(0);
  });

  it('in mode at 1 and 0 workers with an empty larder', () => {
    for (const workers of [1, 0]) {
      const { world, colony } = survivalWorld(workers, 0);
      expect(aiSurvivalMode(world, colony)).toBe(true);
    }
  });

  it('counts the live roster, not workerCount: a third worker killed this tick puts the colony in mode at once', () => {
    // despawnAnt only clears `alive`; tickDeathCleanup decrements workerCount at step 5
    // of the NEXT tick, and the controller runs before that. On a cadence tick the
    // stale count would otherwise let aiDigHeuristic emit marks that stand until the
    // next cadence.
    const { world, colony } = survivalWorld(STARTING_WORKERS, 0, 3);
    world.ants.alive[colony.workers[2]!] = 0; // killed this tick; workerCount still 3
    expect(colony.workerCount).toBe(STARTING_WORKERS);
    expect(aiSurvivalMode(world, colony)).toBe(true);
    runAIController(world, AI);
    const c = counts(world);
    expect(c.mark).toBe(0);
    expect(c.place).toBe(0);
    expect(c.cancel).toBe(3);
  });

  it('cancels at most AI_SURVIVAL_CANCEL_BUDGET marks per cadence tick, and none off-cadence', () => {
    const { world } = survivalWorld(AI_SURVIVAL_MAX_WORKERS, 0, AI_SURVIVAL_CANCEL_BUDGET + 4);
    runAIController(world, AI);
    expect(counts(world).cancel).toBe(AI_SURVIVAL_CANCEL_BUDGET);
    // Off-cadence: a colony in mode on tick 41 issues no marks and cancels nothing.
    const off = survivalWorld(AI_SURVIVAL_MAX_WORKERS, 0, 3, AI_DIG_INTERVAL + 1);
    runAIController(off.world, AI);
    expect(aiSurvivalMode(off.world, off.colony)).toBe(true);
    expect(counts(off.world).cancel).toBe(0);
    expect(counts(off.world).mark).toBe(0);
  });

  it('is a pure function of the colony: the same state gives the same decision whatever came before', () => {
    const { world, colony } = survivalWorld(AI_SURVIVAL_MAX_WORKERS, 0);
    runAIController(world, AI);
    expect(counts(world).mark).toBe(0);
    // Larder crosses the bound: digging resumes at once (no held flag).
    setPoolFoodForTest(world, colony, FOOD_BOUND);
    expect(aiSurvivalMode(world, colony)).toBe(false);
    expect(runAgain(world).mark).toBeGreaterThan(0);
    // Drops back below: in mode again at once.
    setPoolFoodForTest(world, colony, 0);
    expect(aiSurvivalMode(world, colony)).toBe(true);
    expect(runAgain(world).mark).toBe(0);
    // Grows to 3 workers with a low larder: out, and stays out regardless of history.
    spawnWorker(world, colony);
    expect(aiSurvivalMode(world, colony)).toBe(false);
    expect(runAgain(world).mark).toBeGreaterThan(0);
  });

  it('is keyed only on the colony passed in: the player colony is judged on its own state', () => {
    const { world, colony } = survivalWorld(AI_SURVIVAL_MAX_WORKERS, 0);
    expect(aiSurvivalMode(world, colony)).toBe(true);
    const player = addColony(world, 1 as ColonyId, 0);
    for (let i = 0; i < 20; i++) spawnWorker(world, player);
    setPoolFoodForTest(world, player, 0);
    expect(aiSurvivalMode(world, player)).toBe(false);
    expect(aiSurvivalMode(world, colony)).toBe(true);
  });

  describe('save round trip (src/platform/save.ts) yields the same decision on the loaded world', () => {
    /**
     * A real scenario world with the enemy colony forced into the given state (the
     * spare starting workers are killed so the serialized headcount matches the
     * live ants), serialized and deserialized through the platform save path, then
     * both worlds are asked the same question at the same tick.
     */
    function roundTrip(
      workers: number,
      food: number,
    ): {
      live: WorldState;
      loaded: WorldState;
    } {
      const live = createScenario(4242);
      const colony = live.colonies[ENEMY_COLONY_ID]!;
      const spare = colony.workers.slice(workers);
      for (const wid of spare) live.ants.alive[wid] = 0;
      colony.workers.length = workers;
      colony.workerCount = workers;
      setPoolFoodForTest(live, colony, food);
      for (const ch of colony.chambers) setChamberStockForTest(live, colony, ch, 0);
      const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(live))));
      return { live, loaded };
    }

    function decisionAndCommands(world: WorldState): {
      mode: boolean;
      mark: number;
      place: number;
      cancel: number;
    } {
      const colony = world.colonies[ENEMY_COLONY_ID]!;
      const mode = aiSurvivalMode(world, colony);
      world.commandQueue.splice(0);
      runAIController(world, ENEMY_COLONY_ID);
      return { mode, ...counts(world) };
    }

    it('2 workers, low larder: in mode live and in mode after loading', () => {
      const { live, loaded } = roundTrip(AI_SURVIVAL_MAX_WORKERS, QUEEN_EGG_FOOD_THRESHOLD - 1);
      const a = decisionAndCommands(live);
      const b = decisionAndCommands(loaded);
      expect(a.mode).toBe(true);
      expect(b).toEqual(a);
    });

    it('3 workers, larder between 1x and 2x the threshold: out of mode live and after loading', () => {
      // The state Codex flagged for the memory version: a colony that had been in
      // mode at 2 workers, recovered to 3 with a part-recovered larder, was still
      // held in mode live but loaded out of it. With no memory both agree.
      const { live, loaded } = roundTrip(STARTING_WORKERS, QUEEN_EGG_FOOD_THRESHOLD + 100);
      const a = decisionAndCommands(live);
      const b = decisionAndCommands(loaded);
      expect(a.mode).toBe(false);
      expect(b).toEqual(a);
    });

    it('2 workers, larder between 1x and 2x the threshold: in mode live and after loading', () => {
      const { live, loaded } = roundTrip(AI_SURVIVAL_MAX_WORKERS, QUEEN_EGG_FOOD_THRESHOLD + 100);
      const a = decisionAndCommands(live);
      const b = decisionAndCommands(loaded);
      expect(a.mode).toBe(true);
      expect(b).toEqual(a);
    });
  });
});

// ---------------------------------------------------------------------------
// #347 — the probe's reference point is the AI's OWN side when it has no entrance
// ---------------------------------------------------------------------------

describe("#347 aiSelectProbeTarget — no-entrance fallback uses the AI colony's own start", () => {
  /**
   * An AI colony with no entrances of its own measures candidate piles from its
   * start column. Two unmarked piles sit within AI_PROBE_FALLBACK_RADIUS_TILES of
   * the opponent's one open entrance at `doorX`: one `near` tiles toward the AI's
   * home side, one `far` tiles away from it. Measured from the AI's own start the
   * home-side pile is the closer; measured from the OPPOSITE start (the pre-#347
   * fallback for a player-colony AI) the away-side pile would be — so the pick
   * says which side the fallback used.
   */
  function world2(aiColonyId: ColonyId): WorldState {
    const world = createScenario(7, 'Normal');
    const own = world.colonies[aiColonyId]!;
    const opp =
      world.colonies[
        (aiColonyId === PLAYER_COLONY_ID ? ENEMY_COLONY_ID : PLAYER_COLONY_ID) as ColonyId
      ]!;
    own.entrances = [];
    opp.priorityFoodPileId = null;
    const doorX = aiColonyId === PLAYER_COLONY_ID ? ENEMY_START_X : PLAYER_START_X;
    opp.entrances = [{ entranceId: 900, surfaceTileX: doorX, surfaceTileY: 0, isOpen: true }];
    return world;
  }

  it('a PLAYER-colony AI measures from PLAYER_START_X (west of the enemy door)', () => {
    const world = world2(PLAYER_COLONY_ID as ColonyId);
    // Enemy door at x=104. West pile 94 (toward the player), east pile 110.
    // From x=24: west 70+5, east 86+5 -> west. From x=104: west 15, east 11 -> east.
    setPilesForTest(world, [
      {
        foodPileId: 501,
        tileX: ENEMY_START_X - 10,
        tileY: 5,
        pickupsRemaining: 5,
        pickupsInitial: 5,
      },
      {
        foodPileId: 502,
        tileX: ENEMY_START_X + 6,
        tileY: 5,
        pickupsRemaining: 5,
        pickupsInitial: 5,
      },
    ]);
    expect(aiSelectProbeTarget(world, PLAYER_COLONY_ID as ColonyId)).toEqual({
      tileX: ENEMY_START_X - 10,
      tileY: 5,
    });
  });

  it('the ENEMY AI (real play) still measures from ENEMY_START_X — unchanged', () => {
    const world = world2(ENEMY_COLONY_ID as ColonyId);
    // Player door at x=24. East pile 34 (toward the enemy), west pile 18.
    // From x=104: east 70+5, west 86+5 -> east.
    setPilesForTest(world, [
      {
        foodPileId: 601,
        tileX: PLAYER_START_X - 6,
        tileY: 5,
        pickupsRemaining: 5,
        pickupsInitial: 5,
      },
      {
        foodPileId: 602,
        tileX: PLAYER_START_X + 10,
        tileY: 5,
        pickupsRemaining: 5,
        pickupsInitial: 5,
      },
    ]);
    expect(aiSelectProbeTarget(world, ENEMY_COLONY_ID as ColonyId)).toEqual({
      tileX: PLAYER_START_X + 10,
      tileY: 5,
    });
  });

  it("reads the reference from the colony's own state, not its ID (CLNY-08)", () => {
    // Same layout as the PLAYER-colony case, but the player colony's pool sits at
    // the ENEMY's column: a colony-state fallback now measures from x=104 and picks
    // the east pile — a colony-ID fallback would still say west.
    const world = world2(PLAYER_COLONY_ID as ColonyId);
    const own = world.colonies[PLAYER_COLONY_ID as ColonyId]!;
    world.food.tileX[own.poolSlot] = ENEMY_START_X;
    const piles = [
      {
        foodPileId: 501,
        tileX: ENEMY_START_X - 10,
        tileY: 5,
        pickupsRemaining: 5,
        pickupsInitial: 5,
      },
      {
        foodPileId: 502,
        tileX: ENEMY_START_X + 6,
        tileY: 5,
        pickupsRemaining: 5,
        pickupsInitial: 5,
      },
    ];
    setPilesForTest(world, piles);
    expect(aiSelectProbeTarget(world, PLAYER_COLONY_ID as ColonyId)).toEqual({
      tileX: ENEMY_START_X + 6,
      tileY: 5,
    });
    // A pool-less (hand-built) colony falls back to its queen's column. Queen at
    // x=104 -> east; a 0 fallback or a NaN distance (reading slot -1) would say west.
    own.poolSlot = -1;
    world.ants.posX[own.queenEntityId] = ENEMY_START_X << FP_SHIFT;
    expect(aiSelectProbeTarget(world, PLAYER_COLONY_ID as ColonyId)).toEqual({
      tileX: ENEMY_START_X + 6,
      tileY: 5,
    });
    // ...and it follows the queen: back at x=24 -> west.
    world.ants.posX[own.queenEntityId] = PLAYER_START_X << FP_SHIFT;
    expect(aiSelectProbeTarget(world, PLAYER_COLONY_ID as ColonyId)).toEqual({
      tileX: ENEMY_START_X - 10,
      tileY: 5,
    });
  });

  it('a real scenario pool sits at each colony start column (fallback == pre-fix values)', () => {
    const world = createScenario(7, 'Normal');
    const p = world.colonies[PLAYER_COLONY_ID as ColonyId]!;
    const e = world.colonies[ENEMY_COLONY_ID as ColonyId]!;
    expect(world.food.tileX[p.poolSlot]).toBe(PLAYER_START_X);
    expect(world.food.tileX[e.poolSlot]).toBe(ENEMY_START_X);
  });
});

describe('#371 (V62) — the AI defends its own nest', () => {
  const AI = 2 as ColonyId;
  const FOE = 1 as ColonyId;
  const DOOR_X = 40;

  /** Two colonies; the AI owns one open entrance at (DOOR_X, 0) and no rally. */
  function setup(tick = 0): { world: WorldState; colony: ColonyRecord; foe: ColonyRecord } {
    const world = makeWorld(tick);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V62_AI_NEST_DEFENCE);
    const foe = addColony(world, FOE, allocateEntityId(world));
    const colony = addColony(world, AI, allocateEntityId(world));
    addUndergroundGrid(world, AI);
    addUndergroundGrid(world, FOE);
    colony.entrances = [{ entranceId: 7, surfaceTileX: DOOR_X, surfaceTileY: 0, isOpen: true }];
    foe.entrances = [{ entranceId: 3, surfaceTileX: 5, surfaceTileY: 0, isOpen: true }];
    return { world, colony, foe };
  }

  /** An ant of `colonyId` at (x, y); underground in `gridOf`'s nest when given. */
  function ant(
    world: WorldState,
    colonyId: ColonyId,
    x: number,
    y: number,
    gridOf?: ColonyId,
    task: number = AntTask.Fighting,
  ): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId,
      posX: x << FP_SHIFT,
      posY: y << FP_SHIFT,
      task: task as AntTask,
      subTask: 0,
    });
    if (gridOf !== undefined) {
      world.ants.zone[id] = Zone.Underground;
      world.ants.currentGridColonyId[id] = gridOf;
    }
    return id;
  }

  const rallies = (world: WorldState): unknown[] =>
    world.commandQueue.filter((c) => c.type === 'SetRallyPoint' || c.type === 'ClearRallyPoint');

  /** A probe in flight towards (9, 4), far from the AI's door. */
  function probing(world: WorldState, colony: ColonyRecord): AIStateRecord {
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'Probing';
    rec.operationKind = 'Probe';
    rec.invasionRallyTileX = 9;
    rec.invasionRallyTileY = 4;
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: 9, tileY: 4 };
    return rec;
  }

  const setAt = (x: number, y: number): unknown =>
    expect.objectContaining({ type: 'SetRallyPoint', colonyId: AI, tileX: x, tileY: y });
  const clear = (): unknown => expect.objectContaining({ type: 'ClearRallyPoint', colonyId: AI });

  it('no raid: no defence, no command', () => {
    const { world, colony } = setup();
    ant(world, FOE, DOOR_X + 1, 1); // a lone enemy fighter at the door is no raid
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toHaveLength(0);
  });

  it('one enemy fighter inside the nest: rally (a plain rally, no raid type) on the own entrance', () => {
    const { world, colony } = setup();
    for (let i = 0; i < 6; i++) ant(world, AI, DOOR_X, 5, AI); // strong at home: still below
    ant(world, FOE, DOOR_X + 20, 15, AI);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
    expect(rallies(world)[0]).not.toHaveProperty('raidType');
  });

  it('the threat radius is inclusive and Manhattan', () => {
    const { world, colony } = setup();
    expect(AI_DEFENCE_ALERT_RAIDERS).toBe(2);
    const a = ant(world, FOE, DOOR_X + AI_DEFENCE_THREAT_RADIUS_TILES + 1, 0);
    ant(world, FOE, DOOR_X, AI_DEFENCE_THREAT_RADIUS_TILES);
    expect(aiThreatenedEntrance(world, colony)).toBeNull();
    // Off the axis: Manhattan 33 is out (Chebyshev or Euclidean would count it).
    world.ants.posX[a] = (DOOR_X + 16) << FP_SHIFT;
    world.ants.posY[a] = 17 << FP_SHIFT;
    expect(aiThreatenedEntrance(world, colony)).toBeNull();
    world.ants.posY[a] = 16 << FP_SHIFT;
    expect(aiThreatenedEntrance(world, colony)?.entranceId).toBe(7);
  });

  it('hysteresis: once a raid is on (a defence rally is up), raiders count out to the hold radius', () => {
    const { world, colony } = setup();
    expect(AI_DEFENCE_HOLD_RADIUS_TILES).toBeGreaterThan(AI_DEFENCE_THREAT_RADIUS_TILES);
    expect(AI_DEFENCE_HOLD_RADIUS_TILES).toBeLessThanOrEqual(AI_DEFENCE_HOME_RADIUS_TILES);
    const a = ant(world, FOE, DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES, 0);
    ant(world, FOE, DOOR_X, AI_DEFENCE_THREAT_RADIUS_TILES + 1);
    // No raid on: beyond the threat radius they start none.
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toHaveLength(0);
    // A raid on (the rally on the entrance): the same raiders keep it on.
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toHaveLength(0);
    // One past the hold radius: the raid is over and the rally cleared.
    world.ants.posX[a] = (DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES + 1) << FP_SHIFT;
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toEqual([clear()]);
  });

  it('hysteresis: an Invading colony with no cohort yet commits none while raiders sit between the threat and hold radii', () => {
    const { world, colony } = setup();
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'Invading';
    world.aiState.push(rec);
    for (let i = 0; i < 8; i++) colony.workers.push(ant(world, AI, DOOR_X + 1, 1));
    ant(world, FOE, DOOR_X + AI_DEFENCE_THREAT_RADIUS_TILES, 0);
    const b = ant(world, FOE, DOOR_X, AI_DEFENCE_THREAT_RADIUS_TILES);
    runAIController(world, AI);
    expect(rec.operationKind).not.toBe('Invasion');
    const r = rallies(world)[0] as { tileX: number; tileY: number };
    colony.rallyPoint = { tileX: r.tileX, tileY: r.tileY };
    // One raider steps just past the threat radius: the raid holds.
    world.ants.posY[b] = (AI_DEFENCE_THREAT_RADIUS_TILES + 2) << FP_SHIFT;
    world.commandQueue.length = 0;
    runAIController(world, AI);
    expect(world.commandQueue.some((c) => c.type === 'StartAIOperation')).toBe(false);
    expect(rallies(world)).not.toContainEqual(clear());
  });

  it('only enemy FIGHTERS count: workers, own fighters, dead or neutral ants, and enemies in their own nest do not', () => {
    const { world, colony } = setup();
    ant(world, FOE, DOOR_X, 10, AI, AntTask.Foraging);
    ant(world, FOE, DOOR_X, 1, undefined, AntTask.Foraging);
    ant(world, FOE, DOOR_X + 1, 1, undefined, AntTask.Foraging);
    ant(world, AI, DOOR_X, 10, AI);
    ant(world, FOE, DOOR_X, 10, FOE); // underground, in its own nest
    ant(world, 0 as ColonyId, DOOR_X, 10, AI); // neutral
    const dead = ant(world, FOE, DOOR_X, 10, AI);
    world.ants.alive[dead] = 0;
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toHaveLength(0);
  });

  it('outnumbered at home, it goes below; stronger at home, it sallies at the nearest raider', () => {
    const { world, colony } = setup();
    ant(world, FOE, DOOR_X + 10, 2);
    ant(world, FOE, DOOR_X + 5, 3);
    for (let i = 0; i < 2; i++) ant(world, AI, DOOR_X + 1, 1); // 2 at home vs 2: below
    expect(aiDefenceSallies(world, colony)).toBe(false);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
    // A third at home: 3 > 2, it comes out at the raider nearest the door.
    ant(world, AI, DOOR_X, 4, AI);
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    world.commandQueue.length = 0;
    expect(aiDefenceSallies(world, colony)).toBe(true);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X + 5, 3)]);
  });

  it('a sally rally stays put while a raider is by it, follows them when they move, and goes below when one gets inside', () => {
    const { world, colony } = setup();
    const r = ant(world, FOE, DOOR_X + 5, 3);
    ant(world, FOE, DOOR_X + 12, 3);
    for (let i = 0; i < 4; i++) ant(world, AI, DOOR_X + 1, 1);
    colony.rallyPoint = { tileX: DOOR_X + 5, tileY: 3 };
    world.ants.posX[r] = (DOOR_X + 5 + AI_DEFENCE_SALLY_KEEP_TILES) << FP_SHIFT;
    expect(aiNestDefence(world, colony, undefined)).not.toBeNull();
    expect(rallies(world)).toHaveLength(0); // kept: a raider within the keep radius
    world.ants.posX[r] = (DOOR_X + 5 + AI_DEFENCE_SALLY_KEEP_TILES + 6) << FP_SHIFT; // still in the raid
    expect(aiNestDefence(world, colony, undefined)).not.toBeNull();
    expect(rallies(world)).toEqual([setAt(DOOR_X + 12, 3)]);
    world.commandQueue.length = 0;
    world.ants.zone[r] = Zone.Underground;
    world.ants.currentGridColonyId[r] = AI;
    expect(aiNestDefence(world, colony, undefined)).not.toBeNull();
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
  });

  it('a sally goes for the raider nearest the threatened ENTRANCE, not the one nearest the old rally', () => {
    const { world, colony } = setup();
    for (let i = 0; i < 3; i++) ant(world, AI, DOOR_X + 1, 1);
    colony.rallyPoint = { tileX: DOOR_X + 20, tileY: 10 }; // an old sally rally, raider gone
    ant(world, FOE, DOOR_X + 20, 15); // 5 from the old rally, 35 from the door
    ant(world, FOE, DOOR_X - 10, 5); // 15 from the door
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X - 10, 5)]);
  });

  it("never sallies onto an entrance tile: a raider on another colony's entrance is met at its own entrance", () => {
    const { world, colony, foe } = setup();
    foe.entrances = [{ entranceId: 3, surfaceTileX: DOOR_X + 3, surfaceTileY: 0, isOpen: true }];
    for (let i = 0; i < 3; i++) ant(world, AI, DOOR_X + 1, 1);
    ant(world, FOE, DOOR_X + 3, 0); // nearest the door, on the foe's entrance
    ant(world, FOE, DOOR_X + 10, 2);
    expect(aiDefenceSallies(world, colony)).toBe(true);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
    // Held there, it is not re-sent.
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    world.commandQueue.length = 0;
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toHaveLength(0);
  });

  it("a sally rally on a probe's own target tile is not re-sent every tick", () => {
    const { world, colony } = setup();
    const rec = probing(world, colony);
    rec.invasionRallyTileX = DOOR_X + 3;
    rec.invasionRallyTileY = 2;
    colony.rallyPoint = { tileX: DOOR_X + 3, tileY: 2 };
    for (let i = 0; i < 3; i++) ant(world, AI, DOOR_X + 1, 1);
    ant(world, FOE, DOOR_X + 3, 2); // on the probe's target, nearest the door
    ant(world, FOE, DOOR_X + 12, 2);
    expect(aiNestDefence(world, colony, rec)?.entranceId).toBe(7);
    expect(rallies(world)).toHaveLength(0);
  });

  it('Codex P2 on 5c0fcd0: a recalled probe ending mid-raid keeps the hold radius and the defence rally', () => {
    for (const sally of [false, true]) {
      const { world, colony } = setup();
      const rec = probing(world, colony);
      // Raiders between the threat and hold radii: they hold a raid on but start none.
      ant(world, FOE, DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES - 1, 0);
      ant(world, FOE, DOOR_X, AI_DEFENCE_HOLD_RADIUS_TILES - 1);
      if (sally) for (let i = 0; i < 3; i++) ant(world, AI, DOOR_X + 1, 1);
      const rp = sally
        ? { tileX: DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES - 2, tileY: 0 } // by a raider: kept
        : { tileX: DOOR_X, tileY: 0 };
      colony.rallyPoint = rp;
      // The probe times out: advanceAIState ends it and queues its own clear.
      rec.state = 'WarFooting';
      rec.operationKind = 'None'; // the probe's target (9, 4) stays recorded, as in the sim
      world.commandQueue.push({
        type: 'ClearRallyPoint',
        colonyId: AI,
        issuedAtTick: world.tick,
        origin: 'sim',
      });
      expect(aiNestDefence(world, colony, rec)?.entranceId).toBe(7);
      // The defence rally is sent again behind the clear: never a tick without one.
      expect(rallies(world)).toEqual([clear(), setAt(rp.tileX, rp.tileY)]);
    }
  });

  it('the tick after an invasion ends, its rally on an enemy entrance near home is not taken for a sally and re-sent', () => {
    const { world, colony, foe } = setup();
    foe.entrances = [{ entranceId: 3, surfaceTileX: DOOR_X + 20, surfaceTileY: 0, isOpen: true }];
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'Recovery'; // _endInvasion: operation fields reset, the sim's clear queued
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: DOOR_X + 20, tileY: 0 };
    for (let i = 0; i < 3; i++) ant(world, AI, DOOR_X + 1, 1);
    ant(world, FOE, DOOR_X + 21, 0); // by the enemy entrance
    ant(world, FOE, DOOR_X + 22, 1);
    world.commandQueue.push({
      type: 'ClearRallyPoint',
      colonyId: AI,
      issuedAtTick: world.tick,
      origin: 'sim',
    });
    expect(aiNestDefence(world, colony, rec)).not.toBeNull();
    expect(rallies(world)).not.toContainEqual(setAt(DOOR_X + 20, 0));
    expect(rallies(world)).toEqual([clear(), setAt(DOOR_X + 21, 0)]);
  });

  it('the tick after an invasion ends, its rally on an enemy entrance does not hold a raid out to the hold radius', () => {
    const { world, colony, foe } = setup();
    foe.entrances = [{ entranceId: 3, surfaceTileX: DOOR_X + 20, surfaceTileY: 0, isOpen: true }];
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'Recovery';
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: DOOR_X + 20, tileY: 0 };
    ant(world, FOE, DOOR_X + 5, 0); // within the threat radius
    ant(world, FOE, DOOR_X, AI_DEFENCE_HOLD_RADIUS_TILES - 1); // only within the hold radius
    world.commandQueue.push({
      type: 'ClearRallyPoint',
      colonyId: AI,
      issuedAtTick: world.tick,
      origin: 'sim',
    });
    expect(aiNestDefence(world, colony, rec)).toBeNull();
    expect(rallies(world)).toEqual([clear()]);
  });

  it('the tick after a probe ends, its target pile near home is not taken for a defence rally', () => {
    const { world, colony } = setup();
    const rec = probing(world, colony);
    rec.invasionRallyTileX = DOOR_X + 20;
    rec.invasionRallyTileY = 5;
    colony.rallyPoint = { tileX: DOOR_X + 20, tileY: 5 };
    rec.state = 'WarFooting';
    rec.operationKind = 'None'; // the target stays recorded
    for (let i = 0; i < 3; i++) ant(world, AI, DOOR_X + 1, 1);
    ant(world, FOE, DOOR_X + 21, 5); // by the pile, within the threat radius
    ant(world, FOE, DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES - 2, 0); // only within the hold radius
    world.commandQueue.push({
      type: 'ClearRallyPoint',
      colonyId: AI,
      issuedAtTick: world.tick,
      origin: 'sim',
    });
    expect(aiNestDefence(world, colony, rec)).toBeNull(); // one raider within 32: no raid
    expect(rallies(world)).toEqual([clear()]);
  });

  it('a defence rally left on a stale probe target (WarFooting, nothing queued) is still its own and is cleared', () => {
    const { world, colony } = setup();
    const rec = probing(world, colony);
    rec.invasionRallyTileX = DOOR_X + 10;
    rec.invasionRallyTileY = 3;
    rec.state = 'WarFooting';
    rec.operationKind = 'None'; // the probe ended long ago; its target stays recorded
    colony.rallyPoint = { tileX: DOOR_X + 10, tileY: 3 }; // a sally ended there
    expect(aiNestDefence(world, colony, rec)).toBeNull();
    expect(rallies(world)).toEqual([clear()]);
  });

  it('keeps the sim-side raid clock: starts it when a raid is seen, clears it when the raid is over', () => {
    const { world, colony } = setup();
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'WarFooting';
    world.aiState.push(rec);
    const clocks = (): unknown[] => world.commandQueue.filter((c) => c.type === 'SetAIRaidClock');
    const a = ant(world, FOE, DOOR_X + 2, 1);
    const b = ant(world, FOE, DOOR_X - 2, 1);
    aiNestDefence(world, colony, rec);
    expect(clocks()).toEqual([expect.objectContaining({ colonyId: AI, raiding: true })]);
    world.commandQueue.length = 0;
    rec.raidSinceTick = world.tick; // applied by the sim
    aiNestDefence(world, colony, rec);
    expect(clocks()).toHaveLength(0);
    world.ants.alive[a] = 0;
    world.ants.alive[b] = 0;
    world.commandQueue.length = 0;
    aiNestDefence(world, colony, rec);
    expect(clocks()).toEqual([expect.objectContaining({ colonyId: AI, raiding: false })]);
    // A committed invasion clears a running clock (a later raid starts afresh).
    ant(world, FOE, DOOR_X + 2, 1);
    ant(world, FOE, DOOR_X - 2, 1);
    rec.operationKind = 'Invasion';
    world.commandQueue.length = 0;
    aiNestDefence(world, colony, rec);
    expect(clocks()).toEqual([expect.objectContaining({ colonyId: AI, raiding: false })]);
  });

  it('Rob: two parked raiders hold an invasion for AI_DEFENCE_OPS_HOLD_LIMIT_TICKS, then it commits; one inside still holds', () => {
    const { world, colony } = setup(5000);
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'Invading';
    rec.invasionStartTick = world.tick;
    world.aiState.push(rec);
    for (let i = 0; i < 8; i++) colony.workers.push(ant(world, AI, DOOR_X + 1, 1));
    ant(world, FOE, DOOR_X + 3, 0); // parked by the door
    ant(world, FOE, DOOR_X - 3, 0);
    const commits = (): boolean => world.commandQueue.some((c) => c.type === 'StartAIOperation');
    rec.raidSinceTick = world.tick - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS + 1;
    runAIController(world, AI);
    expect(commits()).toBe(false);
    world.commandQueue.length = 0;
    rec.raidSinceTick = world.tick - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS;
    runAIController(world, AI);
    expect(commits()).toBe(true);
    // An enemy inside the nest holds operations however long the raid has run.
    world.commandQueue.length = 0;
    ant(world, FOE, DOOR_X, 8, AI);
    runAIController(world, AI);
    expect(commits()).toBe(false);
  });

  it('past the limit a probe in flight is not called home (it keeps its rally); before it, it is', () => {
    const { world, colony } = setup(5000);
    const rec = probing(world, colony);
    ant(world, FOE, DOOR_X + 3, 0);
    ant(world, FOE, DOOR_X - 3, 0);
    const out = { holdOperations: true };
    rec.raidSinceTick = world.tick - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS;
    expect(aiNestDefence(world, colony, rec, out)?.entranceId).toBe(7);
    expect(out.holdOperations).toBe(false);
    expect(rallies(world)).toHaveLength(0);
    rec.raidSinceTick = world.tick - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS + 1;
    expect(aiNestDefence(world, colony, rec, out)?.entranceId).toBe(7);
    expect(out.holdOperations).toBe(true);
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
  });

  it('fighters away (on a probe, or in an enemy nest) do not count as at home', () => {
    const { world, colony } = setup();
    ant(world, FOE, DOOR_X + 2, 1);
    ant(world, FOE, DOOR_X - 2, 1);
    for (let i = 0; i < 4; i++) ant(world, AI, DOOR_X + AI_DEFENCE_HOME_RADIUS_TILES + 1, 0);
    ant(world, AI, 5, 6, FOE);
    expect(aiDefenceSallies(world, colony)).toBe(false); // 0 at home vs 2
    const back = ant(world, AI, DOOR_X + AI_DEFENCE_HOME_RADIUS_TILES, 0);
    ant(world, AI, DOOR_X, 3, AI);
    expect(aiDefenceSallies(world, colony)).toBe(false); // 2 at home vs 2
    world.ants.posX[back] = DOOR_X << FP_SHIFT;
    ant(world, AI, DOOR_X, 1);
    expect(aiDefenceSallies(world, colony)).toBe(true); // 3 at home vs 2
  });

  it('#371 Codex P1: a 5-fighter colony with its probe out calls the probe home against 2 raiders, holds through drafting, and resumes once they leave', () => {
    const { world, colony } = setup();
    const rec = probing(world, colony);
    const fighters: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = ant(world, AI, 0, 30); // out on the probe, far from home
      fighters.push(id);
      colony.workers.push(id);
    }
    const a = ant(world, FOE, DOOR_X + 2, 1);
    const b = ant(world, FOE, DOOR_X - 2, 1);
    // 1. The raid calls the probe home: its rally is replaced by the entrance's.
    runAIController(world, AI);
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    // 2. They come home and a sixth is drafted: they sally, and the raid (not the
    //    count) still holds the probe: no probe rally, however many are home.
    for (const id of fighters) world.ants.posX[id] = (DOOR_X + 3) << FP_SHIFT;
    colony.workers.push(ant(world, AI, DOOR_X + 3, 0));
    for (let t = 0; t < 3; t++) {
      world.commandQueue.length = 0;
      runAIController(world, AI);
      expect(aiThreatenedEntrance(world, colony)).not.toBeNull();
      expect(rallies(world)).not.toContainEqual(setAt(9, 4));
      const r = rallies(world)[0] as { tileX: number; tileY: number } | undefined;
      if (r !== undefined) colony.rallyPoint = { tileX: r.tileX, tileY: r.tileY };
    }
    expect(colony.rallyPoint).toEqual({ tileX: DOOR_X + 2, tileY: 1 }); // sallying at the nearest
    // 3. The raiders go: the defence rally is cleared; once that lands the probe
    //    gets its own rally back.
    world.ants.alive[a] = 0;
    world.ants.alive[b] = 0;
    world.commandQueue.length = 0;
    runAIController(world, AI);
    expect(rallies(world)).toEqual([clear()]);
    colony.rallyPoint = null;
    world.commandQueue.length = 0;
    runAIController(world, AI);
    expect(rallies(world)).toEqual([setAt(9, 4)]);
    expect(rec.operationKind).toBe('Probe');
  });

  it('drafting does not end a raid: operations stay held however many fighters are home', () => {
    const { world, colony, foe } = setup();
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'WarFooting';
    rec.lastProbeEndTick = -100000;
    world.aiState.push(rec);
    setPilesForTest(world, [
      { foodPileId: 77, tileX: 8, tileY: 3, pickupsRemaining: 4, pickupsInitial: 4 },
    ]);
    foe.priorityFoodPileId = null;
    for (let i = 0; i < 12; i++) colony.workers.push(ant(world, AI, DOOR_X + 1, 1));
    ant(world, FOE, DOOR_X + 20, 2);
    ant(world, FOE, DOOR_X - 20, 2);
    runAIController(world, AI);
    expect(world.commandQueue.some((c) => c.type === 'StartAIOperation')).toBe(false);
    expect(world.commandQueue).toContainEqual(
      expect.objectContaining({ type: 'SetBehaviorRatio', ratio: { ...AI_DEFENCE_RATIO } }),
    );
    // Control: the raiders gone, the probe starts.
    world.commandQueue.length = 0;
    for (let i = 0; i < world.nextEntityId; i++) {
      if (world.ants.colonyId[i] === FOE) world.ants.alive[i] = 0;
    }
    runAIController(world, AI);
    expect(world.commandQueue.some((c) => c.type === 'StartAIOperation')).toBe(true);
  });

  it('when the raid is over it clears its own rallies only', () => {
    // Its entrance rally, and its sally rally, are cleared.
    for (const rp of [
      { tileX: DOOR_X, tileY: 0 },
      { tileX: DOOR_X + 7, tileY: 5 },
      { tileX: DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES, tileY: 0 }, // a sally past the threat radius
    ]) {
      const { world, colony } = setup();
      colony.rallyPoint = rp;
      expect(aiNestDefence(world, colony, undefined)).toBeNull();
      expect(rallies(world)).toEqual([clear()]);
    }
    // A rally far from its entrances is not its own.
    const far = setup();
    far.colony.rallyPoint = { tileX: DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES + 1, tileY: 0 };
    expect(aiNestDefence(far.world, far.colony, undefined)).toBeNull();
    expect(rallies(far.world)).toHaveLength(0);
    // Nor is a probe's own target, even close to home.
    const near = setup();
    const rec = probing(near.world, near.colony);
    rec.invasionRallyTileX = DOOR_X + 3;
    near.colony.rallyPoint = { tileX: DOOR_X + 3, tileY: 4 };
    expect(aiNestDefence(near.world, near.colony, rec)).toBeNull();
    expect(rallies(near.world)).toHaveLength(0);
  });

  it('a committed invasion keeps its rally: no defence while it runs', () => {
    const { world, colony } = setup();
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'Invading';
    rec.operationKind = 'Invasion';
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: 5, tileY: 0 };
    ant(world, FOE, DOOR_X, 10, AI);
    ant(world, FOE, DOOR_X + 2, 1);
    expect(aiNestDefence(world, colony, rec)).toBeNull();
    runAIController(world, AI);
    expect(rallies(world)).toHaveLength(0);
  });

  it('a probe whose rally is gone gets it back only once the raid is over', () => {
    const { world, colony } = setup();
    probing(world, colony);
    colony.rallyPoint = null; // e.g. the tick after a defence clear landed
    const id = ant(world, FOE, DOOR_X, 10, AI); // ...and the raid is back
    runAIController(world, AI);
    // Only the defence rally: no probe rally queued after it to undo it.
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
    world.ants.alive[id] = 0;
    world.commandQueue.length = 0;
    runAIController(world, AI);
    expect(rallies(world)).toEqual([setAt(9, 4)]);
  });

  it('defends the entrance the raiders are under, and keeps it on a tie', () => {
    const { world, colony } = setup();
    colony.entrances.push({
      entranceId: 9,
      surfaceTileX: DOOR_X + 30,
      surfaceTileY: 0,
      isOpen: true,
    });
    const a = ant(world, FOE, DOOR_X + 28, 8, AI);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(9);
    colony.rallyPoint = { tileX: DOOR_X + 30, tileY: 0 };
    world.commandQueue.length = 0;
    ant(world, FOE, DOOR_X + 1, 8, AI); // 1 vs 1: the defended one is kept
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(9);
    expect(rallies(world)).toHaveLength(0);
    world.ants.posX[a] = DOOR_X << FP_SHIFT; // 2 vs 0: the rally follows
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X, 0)]);
  });

  it('never defends a closed entrance, and clears a defence rally left on one', () => {
    const { world, colony } = setup();
    colony.entrances[0]!.isOpen = false;
    ant(world, FOE, DOOR_X, 10, AI);
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toHaveLength(0);
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toEqual([clear()]);
  });

  it('is off below V62: a V61 world gets no defence command', () => {
    const { world, colony } = setup();
    world.simVersion = SIM_VERSION_V61_AI_EARLY_STORAGE;
    ant(world, FOE, DOOR_X, 10, AI);
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    expect(aiNestDefence(world, colony, undefined)).toBeNull();
    expect(rallies(world)).toHaveLength(0);
  });

  it('past the limit a WarFooting colony probes again under a parked pair; an enemy inside still holds', () => {
    const { world, foe } = setup(5000);
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'WarFooting';
    rec.lastProbeEndTick = -100000;
    world.aiState.push(rec);
    for (let i = 0; i < 6; i++) ant(world, AI, DOOR_X + 2, 2);
    setPilesForTest(world, [
      { foodPileId: 77, tileX: 8, tileY: 3, pickupsRemaining: 4, pickupsInitial: 4 },
    ]);
    foe.priorityFoodPileId = null;
    ant(world, FOE, DOOR_X + 20, 0); // parked, out of reach of a sally keep
    ant(world, FOE, DOOR_X - 20, 0);
    const starts = (): boolean => world.commandQueue.some((c) => c.type === 'StartAIOperation');
    rec.raidSinceTick = 5000 - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS + 1;
    runAIController(world, AI);
    expect(starts()).toBe(false);
    world.commandQueue.length = 0;
    rec.raidSinceTick = 5000 - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS;
    runAIController(world, AI);
    expect(starts()).toBe(true);
    // The probe's rally is the last one queued, so it wins over the defence rally.
    const last = rallies(world).at(-1) as { type: string; tileX: number };
    expect(last).toEqual(expect.objectContaining({ type: 'SetRallyPoint', tileX: 8 }));
    world.commandQueue.length = 0;
    ant(world, FOE, DOOR_X, 12, AI);
    runAIController(world, AI);
    expect(starts()).toBe(false);
  });

  it('Codex P2 on 63fb027: a stale raid keeps its hold radius while its probe has its own rally back', () => {
    const { world, colony } = setup(5000);
    const rec = probing(world, colony); // rally on the probe's target (9, 4)
    rec.raidSinceTick = 5000 - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS;
    // Parked raiders between the threat and hold radii.
    ant(world, FOE, DOOR_X + AI_DEFENCE_HOLD_RADIUS_TILES - 1, 0);
    ant(world, FOE, DOOR_X, AI_DEFENCE_HOLD_RADIUS_TILES - 1);
    const out = { holdOperations: true };
    expect(aiNestDefence(world, colony, rec, out)?.entranceId).toBe(7);
    expect(out.holdOperations).toBe(false); // stale: the probe goes on
    expect(world.commandQueue).toHaveLength(0); // no clock clear, no rally change
  });

  it('past the limit a probe called home by an enemy inside gets its rally back once only parked raiders are left', () => {
    const { world, colony } = setup(5000);
    const rec = probing(world, colony); // target (9, 4)
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 }; // called home by the enemy inside
    ant(world, FOE, DOOR_X + 3, 0);
    ant(world, FOE, DOOR_X - 3, 0);
    rec.raidSinceTick = 5000 - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS;
    expect(aiNestDefence(world, colony, rec)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(9, 4)]);
  });

  it('a colony past the entrance cap (a loaded save is not checked for it) still gets a right scan', () => {
    const { world, colony } = setup();
    for (let k = 1; k <= 4; k++) {
      colony.entrances.push({
        entranceId: 10 + k,
        surfaceTileX: DOOR_X + 20 * k,
        surfaceTileY: 0,
        isOpen: true,
      });
    }
    expect(colony.entrances.length).toBeGreaterThan(4);
    ant(world, FOE, DOOR_X + 21, 1); // one on entrance 11 (index 1)
    ant(world, FOE, DOOR_X + 81, 1); // two on entrance 14 (index 4, past the cap)
    ant(world, FOE, DOOR_X + 79, 1);
    expect(aiThreatenedEntrance(world, colony)?.entranceId).toBe(14);
    // The scratch grew once for the longer list and is reused, not reallocated.
    const grown = raidScanWeightBufferForTests();
    expect(grown.length).toBeGreaterThanOrEqual(colony.entrances.length);
    expect(aiThreatenedEntrance(world, colony)?.entranceId).toBe(14);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(14);
    expect(raidScanWeightBufferForTests()).toBe(grown);
  });

  it('a raid scan with two entrances: weights, and the sally raider nearest the threatened one (lowest id on a tie)', () => {
    const { world, colony } = setup();
    colony.entrances.push({
      entranceId: 8,
      surfaceTileX: DOOR_X + 40,
      surfaceTileY: 0,
      isOpen: true,
    });
    for (let i = 0; i < 4; i++) ant(world, AI, DOOR_X + 40, 5, AI);
    const a = ant(world, FOE, DOOR_X + 43, 3); // 6 from entrance 8
    ant(world, FOE, DOOR_X + 37, 3); // also 6 from entrance 8 (higher id), nearer the door
    ant(world, FOE, DOOR_X + 50, 0);
    expect(aiThreatenedEntrance(world, colony)?.entranceId).toBe(8);
    expect(aiNestDefence(world, colony, undefined)?.entranceId).toBe(8);
    expect(rallies(world)).toEqual([
      setAt(world.ants.posX[a]! >> FP_SHIFT, world.ants.posY[a]! >> FP_SHIFT),
    ]);
  });

  // -------------------------------------------------------------------------
  // Rally-classification audit (Codex, 8 edge cases on #380): every combination
  // of rally location × AI state × raid, checked against the INTENDED rules, which
  // are written out here in their own terms (not the implementation's):
  //   - An operation's own rally — a running probe's target, or the target of a probe
  //     that has just ended (the sim's clear queued) — is never the defence's: never
  //     cleared by it, never kept by it, even on an own entrance (corpse food).
  //   - On the tick after an invasion ends (its clear queued), its rally on the foe's
  //     entrance is not the defence's. Any other rally on a foreign entrance near home
  //     (a tile that became an entrance under a sally rally) is, and is cleared; the
  //     defence never keeps or sends one (a raid order, #352).
  //   - Any other rally on an own entrance or within the hold radius of one is the
  //     defence's: cleared when no raid is on (unless a clear is already queued).
  //   - A committed invasion: no defence at all; a running raid clock is cleared.
  //   - A raid (fresh, stale, or with an enemy inside): the threat is the entrance;
  //     operations are held unless the raid is stale with nobody inside. The rally
  //     goes "below" on the entrance (no fighters at home, or an enemy inside), or,
  //     sallying (stronger at home), stays on a defence rally off the entrance that a
  //     raider is by, else goes on the raider nearest the entrance. It is sent only if
  //     the rally the queue will leave differs — except that a running probe in a
  //     stale raid keeps (gets back) its own target instead.
  // -------------------------------------------------------------------------
  it('Codex P2 on d7c3c95: a probe whose target is on the own entrance keeps its rally over successive controller calls (commands applied), no clear/restore loop', () => {
    const { world, colony } = setup(5000);
    const rec = probing(world, colony);
    rec.invasionRallyTileX = DOOR_X; // corpse food on the entrance tile
    rec.invasionRallyTileY = 0;
    colony.rallyPoint = { tileX: DOOR_X, tileY: 0 };
    for (let t = 0; t < 3; t++) {
      runAIController(world, AI);
      expect(rallies(world)).toEqual([]);
      applyCommands(world, world.commandQueue.splice(0));
      expect(colony.rallyPoint).toEqual({ tileX: DOOR_X, tileY: 0 });
    }
  });

  it('a defence rally left on a tile that became a foreign entrance is never kept by a sally, even with a raider by it', () => {
    const { world, colony, foe } = setup(5000);
    foe.entrances = [{ entranceId: 3, surfaceTileX: DOOR_X + 20, surfaceTileY: 0, isOpen: true }];
    const rec = createDefaultAIStateRecord(AI);
    rec.state = 'WarFooting';
    rec.raidSinceTick = 4990;
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: DOOR_X + 20, tileY: 0 }; // ours (nothing queued), on FE
    for (let i = 0; i < 4; i++) ant(world, AI, DOOR_X + 1, 1);
    ant(world, FOE, DOOR_X + 5, 2); // nearest the entrance
    ant(world, FOE, DOOR_X - 5, 2);
    ant(world, FOE, DOOR_X + 21, 1); // by the rally on FE
    expect(aiNestDefence(world, colony, rec)?.entranceId).toBe(7);
    expect(rallies(world)).toEqual([setAt(DOOR_X + 5, 2)]);
  });

  describe('rally classification audit (location × AI state × raid)', () => {
    type Loc = 'none' | 'ownEntrance' | 'nearOwn' | 'probeTarget' | 'foreignEntrance' | 'far';
    type St = 'noOp' | 'probe' | 'probeEnded' | 'probeLongEnded' | 'invasion' | 'invasionEnded';
    type Raid = 'none' | 'fresh' | 'stale' | 'inside';
    const LOCS: Loc[] = ['none', 'ownEntrance', 'nearOwn', 'probeTarget', 'foreignEntrance', 'far'];
    const STATES: St[] = [
      'noOp',
      'probe',
      'probeEnded',
      'probeLongEnded',
      'invasion',
      'invasionEnded',
    ];
    const RAIDS: Raid[] = ['none', 'fresh', 'stale', 'inside'];
    const T = 5000;
    const FE = { tileX: DOOR_X + 20, tileY: 0 }; // the foe's entrance, near the AI's
    // With the target on the own entrance, `probeTarget` and `ownEntrance` are the
    // same tile — deliberately, that is the corpse-food case.
    const TARGETS = {
      nearHome: { tileX: DOOR_X + 12, tileY: 4 },
      onOwnEntrance: { tileX: DOOR_X, tileY: 0 }, // Codex P2 on d7c3c95 (corpse food)
    } as const;
    type Tile = { tileX: number; tileY: number };
    const same = (a: Tile | null, b: Tile | null): boolean =>
      a !== null && b !== null && a.tileX === b.tileX && a.tileY === b.tileY;

    for (const [ptName, PT] of Object.entries(TARGETS)) {
      const locTile = (loc: Loc): Tile | null =>
        ({
          none: null,
          ownEntrance: { tileX: DOOR_X, tileY: 0 },
          nearOwn: { tileX: DOOR_X + 10, tileY: 3 },
          probeTarget: PT,
          foreignEntrance: FE,
          far: { tileX: DOOR_X + 60, tileY: 10 },
        })[loc];
      for (const st of STATES) {
        for (const loc of LOCS) {
          for (const raid of RAIDS) {
            for (const sally of raid === 'none' ? [false] : [false, true]) {
              it(`target ${ptName} · ${st} · rally ${loc} · raid ${raid}${sally ? ' · sallying' : ''}`, () => {
                const { world, colony, foe } = setup(T);
                foe.entrances = [
                  { entranceId: 3, surfaceTileX: FE.tileX, surfaceTileY: FE.tileY, isOpen: true },
                ];
                const rec = createDefaultAIStateRecord(AI);
                world.aiState.push(rec);
                const rally = locTile(loc);
                colony.rallyPoint = rally === null ? null : { ...rally };
                let clearQueued = false;
                if (st === 'probe') {
                  rec.state = 'Probing';
                  rec.operationKind = 'Probe';
                  rec.invasionRallyTileX = PT.tileX;
                  rec.invasionRallyTileY = PT.tileY;
                } else if (st === 'probeEnded') {
                  rec.state = 'WarFooting'; // target kept, the sim's clear queued
                  rec.invasionRallyTileX = PT.tileX;
                  rec.invasionRallyTileY = PT.tileY;
                  clearQueued = true;
                } else if (st === 'probeLongEnded') {
                  rec.state = 'WarFooting'; // target still recorded, nothing queued
                  rec.invasionRallyTileX = PT.tileX;
                  rec.invasionRallyTileY = PT.tileY;
                } else if (st === 'invasion') {
                  rec.state = 'Invading';
                  rec.operationKind = 'Invasion';
                  rec.invasionRallyTileX = FE.tileX;
                  rec.invasionRallyTileY = FE.tileY;
                } else if (st === 'invasionEnded') {
                  rec.state = 'Recovery'; // target reset to -1, the sim's clear queued
                  clearQueued = true;
                } else {
                  rec.state = 'WarFooting';
                }
                if (clearQueued) {
                  world.commandQueue.push({
                    type: 'ClearRallyPoint',
                    colonyId: AI,
                    issuedAtTick: T,
                    origin: 'sim',
                  });
                }
                if (raid !== 'none') {
                  ant(world, FOE, DOOR_X + 5, 2);
                  ant(world, FOE, DOOR_X - 5, 2);
                  rec.raidSinceTick =
                    raid === 'fresh' ? T - 10 : T - AI_DEFENCE_OPS_HOLD_LIMIT_TICKS;
                }
                if (raid === 'inside') ant(world, FOE, DOOR_X, 8, AI);
                // Sallying: four at home against three surface raiders, one of them by
                // the near-home rally tiles.
                const byRally = { tileX: DOOR_X + 10, tileY: 4 };
                if (sally && raid !== 'none') {
                  ant(world, FOE, byRally.tileX, byRally.tileY);
                  for (let i = 0; i < 4; i++) ant(world, AI, DOOR_X + 1, 1);
                }

                const out = { holdOperations: true };
                const got = aiNestDefence(world, colony, rec, out);
                const cmds = world.commandQueue.slice(clearQueued ? 1 : 0);

                // The intended rules.
                const opRally = (st === 'probe' || st === 'probeEnded') && same(rally, PT);
                const foreignEntrance = same(rally, FE) && clearQueued;
                const nearHome =
                  rally !== null &&
                  Math.abs(rally.tileX - DOOR_X) + Math.abs(rally.tileY) <=
                    AI_DEFENCE_HOLD_RADIUS_TILES;
                const defence = rally !== null && !opRally && !foreignEntrance && nearHome;
                const after = clearQueued ? null : rally; // the rally the queue will leave
                if (st === 'invasion') {
                  expect(got).toBeNull();
                  expect(out.holdOperations).toBe(false);
                  expect(cmds).toEqual(
                    raid === 'none'
                      ? []
                      : [expect.objectContaining({ type: 'SetAIRaidClock', raiding: false })],
                  );
                  return;
                }
                if (raid === 'none') {
                  expect(got).toBeNull();
                  expect(out.holdOperations).toBe(false);
                  expect(cmds).toEqual(defence && !clearQueued ? [clear()] : []);
                  return;
                }
                expect(got?.entranceId).toBe(7);
                const stale = raid === 'stale';
                expect(out.holdOperations).toBe(!stale);
                const entrance = { tileX: DOOR_X, tileY: 0 };
                const raiderByRally =
                  rally !== null &&
                  Math.abs(rally.tileX - byRally.tileX) + Math.abs(rally.tileY - byRally.tileY) <=
                    AI_DEFENCE_SALLY_KEEP_TILES;
                const keep = defence && !same(rally, entrance) && !same(rally, FE) && raiderByRally;
                const want: Tile =
                  stale && st === 'probe'
                    ? PT
                    : sally && raid !== 'inside'
                      ? keep
                        ? rally
                        : { tileX: DOOR_X + 5, tileY: 2 } // nearest the entrance, lowest id
                      : entrance;
                expect(cmds).toEqual(same(after, want) ? [] : [setAt(want.tileX, want.tileY)]);
              });
            }
          }
        }
      }
    }
  });

  it('a raided colony starts no probe and commits no invasion cohort', () => {
    for (const state of ['WarFooting', 'Invading'] as const) {
      const { world, foe } = setup();
      const rec = createDefaultAIStateRecord(AI);
      rec.state = state;
      rec.lastProbeEndTick = -100000;
      world.aiState.push(rec);
      for (let i = 0; i < 6; i++) ant(world, AI, DOOR_X + 2, 2);
      setPilesForTest(world, [
        { foodPileId: 77, tileX: 8, tileY: 3, pickupsRemaining: 4, pickupsInitial: 4 },
      ]);
      foe.priorityFoodPileId = null;
      runAIController(world, AI);
      expect(world.commandQueue.some((c) => c.type === 'StartAIOperation')).toBe(true);
      world.commandQueue.length = 0;
      ant(world, FOE, DOOR_X, 12, AI);
      runAIController(world, AI);
      expect(world.commandQueue.some((c) => c.type === 'StartAIOperation')).toBe(false);
      expect(world.commandQueue).toContainEqual(setAt(DOOR_X, 0));
    }
  });
});
