// src/sim/ai-state.test.ts
// S2 — unit tests for ai-state.ts narrow sim helpers.
// Covers CF-P1-010 boundary cases, getAIStateForColony, operation death counters.

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorldState } from './types.js';
import type { WorldState, AIStateRecord } from './types.js';
import { SIM_VERSION_V17_AI_STATE } from './types.js';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import {
  advanceAIState,
  setAIRallyOperation,
  endAIRallyOperation,
  getAIStateForColony,
  isInCohort,
  aiFighterCount,
  aiFoodStored,
  aiFoodCapacity,
  playerWorkerCount,
  createDefaultAIStateRecord,
  NORMAL_TIER_INDEX,
} from './ai-state.js';
import { killAnt } from './combat.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyId } from './colony/colony-store.js';
import { AntTask } from './enums.js';
import { FP_SHIFT } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  AI_WARFOOTING_FIGHTER_THRESHOLD,
  AI_WARFOOTING_FOOD_FRAC_PCT,
  AI_FRONTAGE_PLAYER_WORKERS_ABS,
  AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100,
  AI_WARFOOTING_MIN_TICK,
  AI_MAX_OPERATION_FIGHTERS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMinimalWorld(): WorldState {
  const world = createWorldState(42);
  world.simVersion = SIM_VERSION_V17_AI_STATE;
  // Initialize two colonies
  const playerColony = createColonyRecord(PLAYER_COLONY_ID as ColonyId, 0);
  playerColony.entrances = [];
  playerColony.rallyPoint = null;
  playerColony.digFlowFieldDirty = false;
  playerColony.foodFlowFieldDirty = false;
  playerColony.foodStored = 1000;
  playerColony.workerCount = 5;
  world.colonies[PLAYER_COLONY_ID as ColonyId] = playerColony;

  const enemyColony = createColonyRecord(ENEMY_COLONY_ID as ColonyId, 1);
  enemyColony.entrances = [];
  enemyColony.rallyPoint = null;
  enemyColony.digFlowFieldDirty = false;
  enemyColony.foodFlowFieldDirty = false;
  enemyColony.foodStored = 2000;
  enemyColony.workerCount = 10;
  world.colonies[ENEMY_COLONY_ID as ColonyId] = enemyColony;

  // Initialize ants for queen slots
  initAnt(world.ants, 0, { colonyId: PLAYER_COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });
  initAnt(world.ants, 1, { colonyId: ENEMY_COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });

  // Initialize aiState
  world.aiState = [createDefaultAIStateRecord(ENEMY_COLONY_ID as ColonyId)];
  return world;
}

/** Spawn N alive fighters for a colony, starting at entity slot `startId`. */
function spawnFighters(world: WorldState, colonyId: number, count: number, startId: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    initAnt(world.ants, id, {
      colonyId,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
    });
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// getAIStateForColony
// ---------------------------------------------------------------------------

describe('getAIStateForColony', () => {
  it('finds the record by colonyId even when array index != colonyId', () => {
    const world = makeMinimalWorld();
    // aiState has one entry for ENEMY_COLONY_ID=2, at index 0
    expect(world.aiState.length).toBe(1);
    expect(world.aiState[0]!.colonyId).toBe(ENEMY_COLONY_ID);

    const rec = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId);
    expect(rec).not.toBeNull();
    expect(rec!.colonyId).toBe(ENEMY_COLONY_ID);
  });

  it('returns null for an unknown colonyId', () => {
    const world = makeMinimalWorld();
    const rec = getAIStateForColony(world, 999 as ColonyId);
    expect(rec).toBeNull();
  });

  it('works with multiple aiState entries', () => {
    const world = makeMinimalWorld();
    // Add a second colony with id=3
    world.aiState.push(createDefaultAIStateRecord(3 as ColonyId));
    const rec2 = getAIStateForColony(world, 3 as ColonyId);
    expect(rec2).not.toBeNull();
    expect(rec2!.colonyId).toBe(3);
    // Original still accessible
    const rec1 = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId);
    expect(rec1!.colonyId).toBe(ENEMY_COLONY_ID);
  });
});

// ---------------------------------------------------------------------------
// isInCohort
// ---------------------------------------------------------------------------

describe('isInCohort', () => {
  it('returns true for id in cohort', () => {
    const cohort = new Int32Array([5, 10, 15, -1, -1]);
    expect(isInCohort(10, cohort, 3)).toBe(true);
  });

  it('returns false for id not in cohort', () => {
    const cohort = new Int32Array([5, 10, 15, -1, -1]);
    expect(isInCohort(7, cohort, 3)).toBe(false);
  });

  it('respects count parameter (ignores slots beyond count)', () => {
    const cohort = new Int32Array([5, 10, 15, 20, -1]);
    // count=3: only checks slots 0,1,2 → 20 at slot 3 should NOT be found
    expect(isInCohort(20, cohort, 3)).toBe(false);
    expect(isInCohort(20, cohort, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CF-P1-010 boundary tests: Peacetime → WarFooting transitions
// ---------------------------------------------------------------------------

describe('advanceAIState — Peacetime → WarFooting (CF-P1-010)', () => {
  it('(a) aiReady && ageReady but !frontageReady → fires', () => {
    const world = makeMinimalWorld();
    world.tick = AI_WARFOOTING_MIN_TICK; // age ready

    // AI: enough fighters + enough food
    const minFighters = AI_WARFOOTING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX];
    spawnFighters(world, ENEMY_COLONY_ID, minFighters, 10);
    // Set food: enough for 50% threshold
    const cap = aiFoodCapacity(world, ENEMY_COLONY_ID as ColonyId);
    world.colonies[ENEMY_COLONY_ID as ColonyId]!.foodStored = Math.ceil(cap * AI_WARFOOTING_FOOD_FRAC_PCT / 100);

    // Player: low workers — NOT frontage ready
    world.colonies[PLAYER_COLONY_ID as ColonyId]!.workerCount = 2;

    const aiState = advanceAIState(world, ENEMY_COLONY_ID as ColonyId);
    expect(aiState.state).toBe('WarFooting');
  });

  it('(b) aiReady && frontageReady but !ageReady → fires (early entry)', () => {
    const world = makeMinimalWorld();
    world.tick = AI_WARFOOTING_MIN_TICK - 1; // NOT age ready

    // AI: enough fighters + enough food
    const minFighters = AI_WARFOOTING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX];
    spawnFighters(world, ENEMY_COLONY_ID, minFighters, 10);
    const cap = aiFoodCapacity(world, ENEMY_COLONY_ID as ColonyId);
    world.colonies[ENEMY_COLONY_ID as ColonyId]!.foodStored = Math.ceil(cap * AI_WARFOOTING_FOOD_FRAC_PCT / 100);

    // Player: many workers, satisfying frontage hook
    const aiWorkers = world.colonies[ENEMY_COLONY_ID as ColonyId]!.workerCount;
    const playerNeeded = Math.max(
      AI_FRONTAGE_PLAYER_WORKERS_ABS,
      Math.ceil(AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100 * aiWorkers / 100),
    );
    world.colonies[PLAYER_COLONY_ID as ColonyId]!.workerCount = playerNeeded;

    const aiState = advanceAIState(world, ENEMY_COLONY_ID as ColonyId);
    expect(aiState.state).toBe('WarFooting');
  });

  it('(c) !aiReady (not enough fighters) → does NOT fire', () => {
    const world = makeMinimalWorld();
    world.tick = AI_WARFOOTING_MIN_TICK + 1000; // age ready, frontage would be ready

    // AI: NOT enough fighters
    const minFighters = AI_WARFOOTING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX];
    spawnFighters(world, ENEMY_COLONY_ID, minFighters - 1, 10); // one short
    const cap = aiFoodCapacity(world, ENEMY_COLONY_ID as ColonyId);
    world.colonies[ENEMY_COLONY_ID as ColonyId]!.foodStored = Math.ceil(cap * AI_WARFOOTING_FOOD_FRAC_PCT / 100);

    // Player: large enough to trigger frontage
    world.colonies[PLAYER_COLONY_ID as ColonyId]!.workerCount = 100;

    const aiState = advanceAIState(world, ENEMY_COLONY_ID as ColonyId);
    expect(aiState.state).toBe('Peacetime');
  });

  it('(d) !aiReady (not enough food) → does NOT fire even with age ready', () => {
    const world = makeMinimalWorld();
    world.tick = AI_WARFOOTING_MIN_TICK + 500;

    // AI: enough fighters but NOT enough food
    const minFighters = AI_WARFOOTING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX];
    spawnFighters(world, ENEMY_COLONY_ID, minFighters + 2, 10);
    world.colonies[ENEMY_COLONY_ID as ColonyId]!.foodStored = 0; // no food

    const aiState = advanceAIState(world, ENEMY_COLONY_ID as ColonyId);
    expect(aiState.state).toBe('Peacetime');
  });
});

// ---------------------------------------------------------------------------
// Operation death counter tests (QC Pass 4 AR-P1-001)
// ---------------------------------------------------------------------------

describe('operation death counters (AR-P1-001)', () => {
  function setupInvasionWorld() {
    const world = makeMinimalWorld();
    world.simVersion = SIM_VERSION_V17_AI_STATE;

    // Spawn AI fighters (cohort) at slots 10..14
    const cohortIds = spawnFighters(world, ENEMY_COLONY_ID, 5, 10);
    // Spawn a late-arrival AI fighter NOT in cohort at slot 20
    spawnFighters(world, ENEMY_COLONY_ID, 1, 20);
    // Spawn player ant at slot 30
    spawnFighters(world, PLAYER_COLONY_ID, 1, 30);

    // Set up active invasion operation with cohort = slots 10..14
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    aiState.state = 'Invading';
    aiState.enteredTick = 0;
    aiState.invasionStartTick = 0;
    aiState.operationKind = 'Invasion';
    aiState.operationStartTick = 0;
    aiState.operationFighterCount = cohortIds.length;
    for (let i = 0; i < cohortIds.length; i++) {
      aiState.operationFighterIds[i] = cohortIds[i]!;
    }
    aiState.operationAttackerDeaths = 0;
    aiState.operationDefenderDeaths = 0;

    return { world, cohortIds };
  }

  it('player ant killed by spider → does NOT increment operationDefenderDeaths', () => {
    const { world } = setupInvasionWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    // Kill player ant (slot 30) by spider (killerColonyId=null, killerKind='Spider')
    killAnt(world, 30, null, null, 'Spider');
    expect(aiState.operationDefenderDeaths).toBe(0);
  });

  it('player ant killed by late-arrival AI fighter (not in cohort) → does NOT increment', () => {
    const { world } = setupInvasionWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    // Kill player ant (slot 30) by late-arrival (slot 20, not in cohort 10..14)
    killAnt(world, 30, ENEMY_COLONY_ID as ColonyId, 20, 'Ant');
    expect(aiState.operationDefenderDeaths).toBe(0);
  });

  it('player ant killed by committed-cohort AI fighter → increments operationDefenderDeaths by 1', () => {
    const { world } = setupInvasionWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    // Kill player ant (slot 30) by committed cohort fighter (slot 10)
    killAnt(world, 30, ENEMY_COLONY_ID as ColonyId, 10, 'Ant');
    expect(aiState.operationDefenderDeaths).toBe(1);
  });

  it('committed-cohort AI fighter killed by player → increments operationAttackerDeaths by 1', () => {
    const { world } = setupInvasionWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    // Kill committed cohort fighter (slot 10) by player ant (slot 30)
    killAnt(world, 10, PLAYER_COLONY_ID as ColonyId, 30, 'Ant');
    expect(aiState.operationAttackerDeaths).toBe(1);
  });

  it('late-arrival AI fighter killed by player → does NOT increment operationAttackerDeaths', () => {
    const { world } = setupInvasionWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    // Kill late-arrival (slot 20, not in cohort) by player
    killAnt(world, 20, PLAYER_COLONY_ID as ColonyId, 30, 'Ant');
    expect(aiState.operationAttackerDeaths).toBe(0);
  });

  it('multiple kills accumulate correctly', () => {
    const { world } = setupInvasionWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    // Kill two cohort fighters by player
    killAnt(world, 10, PLAYER_COLONY_ID as ColonyId, 30, 'Ant');
    killAnt(world, 11, PLAYER_COLONY_ID as ColonyId, 30, 'Ant');
    expect(aiState.operationAttackerDeaths).toBe(2);
    // Kill player by cohort fighter
    spawnFighters(world, PLAYER_COLONY_ID, 1, 31);
    killAnt(world, 31, ENEMY_COLONY_ID as ColonyId, 12, 'Ant');
    expect(aiState.operationDefenderDeaths).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setAIRallyOperation — probe cohort selection (correct fighters committed)
// ---------------------------------------------------------------------------

describe('setAIRallyOperation — probe cohort', () => {
  it('commits exactly the provided fighter IDs to the cohort', () => {
    const world = makeMinimalWorld();
    // Spawn 5 AI fighters; provide 3 as probe cohort
    spawnFighters(world, ENEMY_COLONY_ID, 5, 10);
    const cohort = [10, 11, 12]; // closest 3 by ascending index

    // Set state to WarFooting first
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    aiState.state = 'WarFooting';

    setAIRallyOperation(world, ENEMY_COLONY_ID as ColonyId, 50, 50, cohort, 'Probe');

    const updatedAI = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    expect(updatedAI.state).toBe('Probing');
    expect(updatedAI.operationKind).toBe('Probe');
    expect(updatedAI.operationFighterCount).toBe(3);
    expect(updatedAI.operationFighterIds[0]).toBe(10);
    expect(updatedAI.operationFighterIds[1]).toBe(11);
    expect(updatedAI.operationFighterIds[2]).toBe(12);
    // Unused slots remain -1
    expect(updatedAI.operationFighterIds[3]).toBe(-1);
  });

  it('emits ai_state_transition WarFooting→Probing event', () => {
    const world = makeMinimalWorld();
    spawnFighters(world, ENEMY_COLONY_ID, 3, 10);
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    aiState.state = 'WarFooting';

    const eventsBefore = world.events.length;
    setAIRallyOperation(world, ENEMY_COLONY_ID as ColonyId, 50, 50, [10, 11, 12], 'Probe');
    const newEvents = world.events.slice(eventsBefore);
    const transitionEvent = newEvents.find((e) => e.type === 'ai_state_transition');
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent!.payload).toMatchObject({ from: 'WarFooting', to: 'Probing' });
  });

  it('emits invasion_start event for Invasion operation', () => {
    const world = makeMinimalWorld();
    spawnFighters(world, ENEMY_COLONY_ID, 5, 10);
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    aiState.state = 'WarFooting';

    const eventsBefore = world.events.length;
    setAIRallyOperation(world, ENEMY_COLONY_ID as ColonyId, 40, 64, [10, 11, 12, 13, 14], 'Invasion');
    const newEvents = world.events.slice(eventsBefore);
    const invasionEvent = newEvents.find((e) => e.type === 'invasion_start');
    expect(invasionEvent).toBeDefined();
    expect(invasionEvent!.payload).toMatchObject({ fighterCount: 5 });
  });
});

// ---------------------------------------------------------------------------
// endAIRallyOperation — emits invasion_end
// ---------------------------------------------------------------------------

describe('endAIRallyOperation', () => {
  it('emits invasion_end event for Invasion operation', () => {
    const world = makeMinimalWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    aiState.state = 'Invading';
    aiState.operationKind = 'Invasion';
    aiState.operationAttackerDeaths = 3;
    aiState.operationDefenderDeaths = 2;

    const eventsBefore = world.events.length;
    endAIRallyOperation(world, ENEMY_COLONY_ID as ColonyId, 'fighter_rout');
    const newEvents = world.events.slice(eventsBefore);
    const endEvent = newEvents.find((e) => e.type === 'invasion_end');
    expect(endEvent).toBeDefined();
    expect(endEvent!.payload).toMatchObject({
      outcome: 'fighter_rout',
      attackerLosses: 3,
      defenderLosses: 2,
    });
  });

  it('transitions Invading → Recovery after invasion_end', () => {
    const world = makeMinimalWorld();
    const aiState = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    aiState.state = 'Invading';
    aiState.operationKind = 'Invasion';

    endAIRallyOperation(world, ENEMY_COLONY_ID as ColonyId, 'timeout');
    expect(aiState.state).toBe('Recovery');
  });
});

// ---------------------------------------------------------------------------
// createDefaultAIStateRecord — defensive defaults shape check
// ---------------------------------------------------------------------------

describe('createDefaultAIStateRecord', () => {
  it('creates a record with correct defensive defaults', () => {
    const rec = createDefaultAIStateRecord(ENEMY_COLONY_ID as ColonyId);
    expect(rec.colonyId).toBe(ENEMY_COLONY_ID);
    expect(rec.state).toBe('Peacetime');
    expect(rec.operationKind).toBe('None');
    expect(rec.operationFighterIds.length).toBe(AI_MAX_OPERATION_FIGHTERS);
    expect(rec.operationFighterIds[0]).toBe(-1);
    expect(rec.invasionRallyTileX).toBe(-1);
    expect(rec.invasionRallyTileY).toBe(-1);
  });
});
