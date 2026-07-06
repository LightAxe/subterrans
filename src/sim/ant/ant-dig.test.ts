// dig — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-dig.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import { antPickupFood, tickDigExecution, tickSearchLeash } from './ant-system.js';
import { createWorldState, allocateEntityId } from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { AntTask, ForagingSubState, DiggingSubState } from '../enums.js';
import { DIG_TICKS_PER_TILE, SEARCH_LEASH_RADII, SEARCH_LEASH_MAX_WAVE } from '../constants.js';
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
      posX: 0, // posX=0 → tileX=0
      posY: 0, // posY=0 → tileY=0
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
    // Seed the gate: the leash only fires when (a) more workers are foraging
    // than the allocation asks for AND (b) the player has requested dig or
    // fight work. That matches the memo's target bug: "when the colony's
    // requested allocation no longer supports that role" — i.e. the triangle
    // is asking for dig/fight but foragers are stuck out searching.
    colony.computedAllocation.forage = 0;
    colony.computedAllocation.dig = 1;
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
    const pile = { pickupsRemaining: 50 };
    const transferred = antPickupFood(world.ants, antId, pile);
    expect(transferred).toBeGreaterThan(0);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('zero-transfer antPickupFood does NOT reset searchWave (no successful find)', () => {
    const { world, antId } = setupLeashWorld(10, 0);
    world.ants.searchWave[antId] = 2;
    // Empty pile → zero transfer → no CarryingFood transition and no wave reset.
    const transferred = antPickupFood(world.ants, antId, { pickupsRemaining: 0 });
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
    world.colonies[COLONY_ID]!.computedAllocation.dig = 0;
    world.colonies[COLONY_ID]!.computedAllocation.fight = 0;
    world.colonies[COLONY_ID]!.computedAllocation.nurse = 1;
    world.colonies[COLONY_ID]!.taskCensus.forage = 5;
    world.colonies[COLONY_ID]!.taskCensus.nurse = 0;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.searchWave[antId]).toBe(0);
  });

  it('DOES demote when over-foraged and player has requested fight (not just dig)', () => {
    // Symmetric check: the memo names dig/fight as the triangle axes. The
    // gate must arm on either.
    const base = SEARCH_LEASH_RADII[0]!;
    const { world, antId } = setupLeashWorld(base + 1, 0);
    world.colonies[COLONY_ID]!.computedAllocation.dig = 0;
    world.colonies[COLONY_ID]!.computedAllocation.fight = 1;
    tickSearchLeash(world);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.searchWave[antId]).toBe(1);
  });

  it('measures distance from the NEAREST entrance when multiple exist', () => {
    const { world, colony, antId } = setupLeashWorld(30, 0, 100, 0);
    // Add a closer entrance — ant at (30,0) is 30 from (100,0) but 2 from (28,0).
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: 28,
      surfaceTileY: 0,
      isOpen: true,
    });
    tickSearchLeash(world);
    // Closest is 2 ≤ 25 → not demoted.
    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
  });
});
