// motion — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-motion.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import {
  canEnterUndergroundTile,
  pickCardinalStep,
  unpackStepDx,
  unpackStepDy,
  getTaskDirection,
} from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  LEGACY_SIM_VERSION,
  SIM_VERSION_V3,
  SIM_VERSION_V4_DIAGONAL_MOTION,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt, createAntComponents } from './ant-store.js';
import { AntTask, DiggingSubState } from '../enums.js';
import { DIG_TICKS_PER_TILE } from '../constants.js';
import { FP_SHIFT } from '../fixed.js';
import { Zone, UndergroundTileState, ugGet, ugSet, createUndergroundGrid } from '../terrain.js';
import { createDigFlowFields, computeDigFlowField } from '../dig-system.js';
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
// Issue #34 — pickCardinalStep
//
// Two simVersion modes:
//   v2/v3 (LEGACY_SIM_VERSION / SIM_VERSION_V3) — legacy greedy major-axis
//                                                 cardinal pick. Pre-issue-#34
//                                                 behavior preserved verbatim
//                                                 for replay determinism.
//   v4 (SIM_VERSION_V4_DIAGONAL_MOTION) — 8-connected diagonal step when both
//                                         axes have non-zero delta.
//
// Issue #69: pickCardinalStep now returns a packed int (dx + 1) | ((dy + 1) << 2).
// Test helper `step(p)` decodes back to {dx, dy} for assertion convenience.
// ---------------------------------------------------------------------------

/** Decode a pickCardinalStep result for test assertions. */
function step(packed: number): { dx: number; dy: number } {
  return { dx: unpackStepDx(packed), dy: unpackStepDy(packed) };
}

// ---------------------------------------------------------------------------
// getTaskDirection — sanity check
// ---------------------------------------------------------------------------

describe('getTaskDirection', () => {
  it('returns {dx:0, dy:0} for Idle and Fighting tasks (no pathfinding needed)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
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
    expect(world.ants.subTask[antId]).toBe(subTaskBefore); // subTask unchanged
    expect(colony.digFlowFieldDirty).toBe(dirtyBefore); // dirty flag unchanged
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
// canEnterUndergroundTile — underground passability predicate
//
// Contract: the standalone predicate deciding whether a given task may step
// onto an underground tile by its state. Open/BeingDug are passable for all;
// Solid is impassable for all; Marked is enterable only by a Digger — that's
// how tickDigExecution claims them. The tickAntMovement guard that consumes
// this predicate to reject a Solid/Marked step mid-route (Nurse → Queen chamber,
// carrying forager → FoodStorage, ascending forager → entrance) is exercised in
// ant-movement.test.ts ("underground passability guard").
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

describe('pickCardinalStep (issue #34) — v2/v3 legacy greedy cardinal', () => {
  function emptyAnts(): ReturnType<typeof createAntComponents> {
    return createAntComponents(8);
  }

  it('zero delta returns (0, 0) under v3', () => {
    const ants = emptyAnts();
    expect(step(pickCardinalStep(ants, 0, 0, 0, SIM_VERSION_V3))).toEqual({ dx: 0, dy: 0 });
  });

  it('pure +X / -Y cardinals are unchanged under v3', () => {
    const ants = emptyAnts();
    expect(step(pickCardinalStep(ants, 0, 5, 0, SIM_VERSION_V3))).toEqual({ dx: 1, dy: 0 });
    expect(step(pickCardinalStep(ants, 0, 0, -3, SIM_VERSION_V3))).toEqual({ dx: 0, dy: -1 });
  });

  it('LEGACY_SIM_VERSION (v2) uses the same legacy greedy path as v3', () => {
    // v2 was the issue-#15 baseline; v2 → v3 only shifted withdrawFood
    // ordering (issue #27), never the movement algorithm. Both replay
    // identically through pickCardinalStep.
    const a2 = emptyAnts();
    const a3 = emptyAnts();
    // Two packed ints — toBe rather than toEqual since they're primitive.
    expect(pickCardinalStep(a2, 0, 3, 3, LEGACY_SIM_VERSION)).toBe(
      pickCardinalStep(a3, 0, 3, 3, SIM_VERSION_V3),
    );
  });
});

describe('pickCardinalStep (issue #34) — v4 8-connected diagonal', () => {
  function emptyAnts(): ReturnType<typeof createAntComponents> {
    return createAntComponents(8);
  }

  it('pure cardinals are unchanged in v4 (single-axis targets behave identically)', () => {
    const ants = emptyAnts();
    expect(step(pickCardinalStep(ants, 0, 5, 0, SIM_VERSION_V4_DIAGONAL_MOTION))).toEqual({
      dx: 1,
      dy: 0,
    });
    expect(step(pickCardinalStep(ants, 0, 0, -3, SIM_VERSION_V4_DIAGONAL_MOTION))).toEqual({
      dx: 0,
      dy: -1,
    });
    expect(step(pickCardinalStep(ants, 0, 0, 0, SIM_VERSION_V4_DIAGONAL_MOTION))).toEqual({
      dx: 0,
      dy: 0,
    });
  });

  it('45° target (3,3) reaches the target in 3 diagonal steps — no zig-zag', () => {
    const ants = emptyAnts();
    let x = 0;
    let y = 0;
    const dxs: number[] = [];
    const dys: number[] = [];
    for (let i = 0; i < 3; i++) {
      const stepP = pickCardinalStep(ants, 0, 3 - x, 3 - y, SIM_VERSION_V4_DIAGONAL_MOTION);
      dxs.push(unpackStepDx(stepP));
      dys.push(unpackStepDy(stepP));
      x += unpackStepDx(stepP);
      y += unpackStepDy(stepP);
    }
    expect(x).toBe(3);
    expect(y).toBe(3);
    // Every step was diagonal (both axes moved).
    for (let i = 0; i < 3; i++) {
      expect(dxs[i]).toBe(1);
      expect(dys[i]).toBe(1);
    }
  });

  it('3:1 slope (rawDx=3, rawDy=1) — diagonal until Y is satisfied, then pure +X', () => {
    // v4 always takes diagonal when both axes have work. Once Y is satisfied
    // (after 1 step), the remaining 2 X-steps are pure cardinal.
    const ants = emptyAnts();
    let x = 0;
    let y = 0;
    const trace: Array<[number, number]> = [];
    for (let i = 0; i < 3; i++) {
      const stepP = pickCardinalStep(ants, 0, 3 - x, 1 - y, SIM_VERSION_V4_DIAGONAL_MOTION);
      trace.push([unpackStepDx(stepP), unpackStepDy(stepP)]);
      x += unpackStepDx(stepP);
      y += unpackStepDy(stepP);
    }
    expect(x).toBe(3);
    expect(y).toBe(1);
    // Step 0: diagonal (both axes had work). Steps 1+2: pure +X (Y done).
    expect(trace[0]).toEqual([1, 1]);
    expect(trace[1]).toEqual([1, 0]);
    expect(trace[2]).toEqual([1, 0]);
  });

  it('negative diagonal: (-3,-3) target → 3 ticks of (-1,-1)', () => {
    const ants = emptyAnts();
    let x = 0;
    let y = 0;
    for (let i = 0; i < 3; i++) {
      const stepP = pickCardinalStep(ants, 0, -3 - x, -3 - y, SIM_VERSION_V4_DIAGONAL_MOTION);
      expect(unpackStepDx(stepP)).toBe(-1);
      expect(unpackStepDy(stepP)).toBe(-1);
      x += unpackStepDx(stepP);
      y += unpackStepDy(stepP);
    }
    expect(x).toBe(-3);
    expect(y).toBe(-3);
  });

  it('mixed-quadrant diagonals: (rawDx=2, rawDy=-2) → (1, -1)', () => {
    // sign(rawDx) = +1, sign(rawDy) = -1 → SE-quadrant diagonal.
    const ants = emptyAnts();
    const stepP = pickCardinalStep(ants, 0, 2, -2, SIM_VERSION_V4_DIAGONAL_MOTION);
    expect(step(stepP)).toEqual({ dx: 1, dy: -1 });
  });
});
