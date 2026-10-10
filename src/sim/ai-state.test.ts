// src/sim/ai-state.test.ts
// S2 — unit tests for ai-state.ts narrow sim helpers.
// Covers CF-P1-010 boundary cases, getAIStateForColony, operation death counters.

import { describe, it, expect } from 'vitest';
import { createWorldState } from './types.js';
import type { WorldState, AIStateRecord } from './types.js';
import { LATEST_SIM_VERSION, SIM_VERSION_V19_AI_STATE } from './types.js';
import { applyCommands } from './tick.js';
import type { SimCommand } from './commands.js';
import {
  advanceAIState,
  setAIRallyOperation,
  endAIRallyOperation,
  getAIStateForColony,
  isInCohort,
  createDefaultAIStateRecord,
  NORMAL_TIER_INDEX,
  tierIndex,
  opponentColonyId,
  frontageOpponentWorkerCount,
  invasionFighterNeed,
} from './ai-state.js';
import { killAnt } from './ant-death.js';
import { colonyFoodCapacity } from './food/food-api.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';
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
  AI_INVADING_FIGHTER_THRESHOLD,
  AI_INVADING_MIN_TICK,
  AI_INVADING_TIMEOUT_TICKS,
  AI_RECOVERY_DURATION_TICKS,
  AI_INVASION_FLOOR_STEP,
  AI_INVASION_FLOOR_MAX,
  AI_INVASION_FLOOR_PATIENCE_TICKS,
  AI_INVADING_FOOD_FRAC_PCT,
  AI_INVADING_FOOD_GATE_BYPASS_FIGHTERS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMinimalWorld(): WorldState {
  const world = createWorldState(42);
  world.simVersion = SIM_VERSION_V19_AI_STATE;
  // Initialize two colonies
  const playerColony = createColonyRecord(PLAYER_COLONY_ID as ColonyId, 0);
  playerColony.entrances = [];
  playerColony.rallyPoint = null;
  playerColony.digFlowFieldDirty = false;
  playerColony.foodFlowFieldDirty = false;
  playerColony.workerCount = 5;
  world.colonies[PLAYER_COLONY_ID as ColonyId] = playerColony;

  const enemyColony = createColonyRecord(ENEMY_COLONY_ID as ColonyId, 1);
  enemyColony.entrances = [];
  enemyColony.rallyPoint = null;
  enemyColony.digFlowFieldDirty = false;
  enemyColony.foodFlowFieldDirty = false;
  enemyColony.workerCount = 10;
  world.colonies[ENEMY_COLONY_ID as ColonyId] = enemyColony;

  // Initialize ants for queen slots
  initAnt(world.ants, 0, { colonyId: PLAYER_COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });
  initAnt(world.ants, 1, { colonyId: ENEMY_COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });

  setPoolFoodForTest(world, playerColony, 1000);
  setPoolFoodForTest(world, enemyColony, 2000);

  // Initialize aiState
  world.aiState = [createDefaultAIStateRecord(ENEMY_COLONY_ID as ColonyId)];
  return world;
}

/** Spawn N alive fighters for a colony, starting at entity slot `startId`. */
function spawnFighters(
  world: WorldState,
  colonyId: number,
  count: number,
  startId: number,
): number[] {
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
    const cap = colonyFoodCapacity(world.colonies[ENEMY_COLONY_ID as ColonyId]!);
    setPoolFoodForTest(
      world,
      world.colonies[ENEMY_COLONY_ID as ColonyId]!,
      Math.ceil((cap * AI_WARFOOTING_FOOD_FRAC_PCT) / 100), // eslint-disable-line no-restricted-syntax
    );

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
    const cap = colonyFoodCapacity(world.colonies[ENEMY_COLONY_ID as ColonyId]!);
    setPoolFoodForTest(
      world,
      world.colonies[ENEMY_COLONY_ID as ColonyId]!,
      Math.ceil((cap * AI_WARFOOTING_FOOD_FRAC_PCT) / 100), // eslint-disable-line no-restricted-syntax
    );

    // Player: many workers, satisfying frontage hook
    const aiWorkers = world.colonies[ENEMY_COLONY_ID as ColonyId]!.workerCount;
    const playerNeeded = Math.max(
      AI_FRONTAGE_PLAYER_WORKERS_ABS,
      // eslint-disable-next-line no-restricted-syntax
      Math.ceil((AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100 * aiWorkers) / 100),
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
    const cap = colonyFoodCapacity(world.colonies[ENEMY_COLONY_ID as ColonyId]!);
    setPoolFoodForTest(
      world,
      world.colonies[ENEMY_COLONY_ID as ColonyId]!,
      Math.ceil((cap * AI_WARFOOTING_FOOD_FRAC_PCT) / 100), // eslint-disable-line no-restricted-syntax
    );

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
    setPoolFoodForTest(world, world.colonies[ENEMY_COLONY_ID as ColonyId]!, 0); // no food

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
    world.simVersion = SIM_VERSION_V19_AI_STATE;

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
    setAIRallyOperation(
      world,
      ENEMY_COLONY_ID as ColonyId,
      40,
      64,
      [10, 11, 12, 13, 14],
      'Invasion',
    );
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

// ---------------------------------------------------------------------------
// S5 (V22) — tierIndex
// ---------------------------------------------------------------------------

describe('tierIndex', () => {
  it('maps Easy to 0', () => {
    expect(tierIndex('Easy')).toBe(0);
  });

  it('maps Normal to 1 (same as NORMAL_TIER_INDEX)', () => {
    expect(tierIndex('Normal')).toBe(1);
    expect(tierIndex('Normal')).toBe(NORMAL_TIER_INDEX);
  });

  it('maps Hard to 2', () => {
    expect(tierIndex('Hard')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// StartAIOperation command validation (#226, V32 gate) — applied in tick.ts
// ---------------------------------------------------------------------------
describe('StartAIOperation validation (#226, V32 gate)', () => {
  const AI = ENEMY_COLONY_ID as ColonyId;
  const startOp = (kind: 'Probe' | 'Invasion', fighterIds: number[]): SimCommand =>
    ({
      type: 'StartAIOperation',
      colonyId: AI,
      kind,
      rallyTileX: 50,
      rallyTileY: 50,
      fighterIds,
      issuedAtTick: 0,
    }) as SimCommand;
  const setState = (
    world: WorldState,
    state: 'Peacetime' | 'WarFooting' | 'Probing' | 'Invading',
  ) => {
    getAIStateForColony(world, AI)!.state = state;
  };
  const setup = (state: 'Peacetime' | 'WarFooting' | 'Probing' | 'Invading') => {
    const world = makeMinimalWorld();
    world.simVersion = LATEST_SIM_VERSION;
    spawnFighters(world, ENEMY_COLONY_ID, 3, 10);
    setState(world, state);
    return world;
  };

  it('WarFooting + Probe → applies', () => {
    const world = setup('WarFooting');
    applyCommands(world, [startOp('Probe', [10, 11, 12])]);
    const ai = getAIStateForColony(world, AI)!;
    expect(ai.state).toBe('Probing');
    expect(ai.operationKind).toBe('Probe');
  });

  it('Peacetime + Probe → dropped (silent)', () => {
    const world = setup('Peacetime');
    const before = world.events.length;
    applyCommands(world, [startOp('Probe', [10, 11, 12])]);
    const ai = getAIStateForColony(world, AI)!;
    expect(ai.state).toBe('Peacetime');
    expect(ai.operationKind).toBe('None');
    expect(world.events.length).toBe(before);
  });

  it('Invading + Invasion → applies', () => {
    const world = setup('Invading');
    applyCommands(world, [startOp('Invasion', [10, 11, 12])]);
    expect(getAIStateForColony(world, AI)!.operationKind).toBe('Invasion');
    expect(world.events.some((e) => e.type === 'invasion_start')).toBe(true);
  });

  it('Probing + Invasion → dropped (Probing→Invading via this command is illegal)', () => {
    const world = setup('Probing');
    applyCommands(world, [startOp('Invasion', [10, 11, 12])]);
    const ai = getAIStateForColony(world, AI)!;
    expect(ai.operationKind).toBe('None');
    expect(ai.state).toBe('Probing');
  });

  it('malformed kind: dropped before the state ternary can mis-route it', () => {
    const world = setup('Invading');
    applyCommands(world, [startOp('Garbage' as 'Invasion', [10, 11, 12])]);
    expect(getAIStateForColony(world, AI)!.operationKind).toBe('None');
    expect(world.events.some((e) => e.type === 'invasion_start')).toBe(false);
  });

  it('ai_state_transition reports the ACTUAL from-state (Peacetime), not a hardcoded WarFooting', () => {
    // Called directly: the command path now rejects a Probe from Peacetime, so
    // this is the only way to reach setAIRallyOperation from a non-WarFooting state.
    const world = setup('Peacetime');
    setAIRallyOperation(world, AI, 50, 50, [10, 11, 12], 'Probe');
    const evt = world.events.find((e) => e.type === 'ai_state_transition');
    expect(evt).toBeDefined();
    if (evt?.type === 'ai_state_transition') {
      expect(evt.payload).toMatchObject({ from: 'Peacetime', to: 'Probing' });
    }
  });

  it('command-pair: a legit StartAIOperation + paired SetRallyPoint both apply consistently', () => {
    const world = setup('WarFooting');
    applyCommands(world, [
      startOp('Probe', [10, 11, 12]),
      {
        type: 'SetRallyPoint',
        colonyId: AI,
        tileX: 50,
        tileY: 50,
        issuedAtTick: 0,
      } as SimCommand,
    ]);
    expect(getAIStateForColony(world, AI)!.state).toBe('Probing');
    expect(world.colonies[AI]!.rallyPoint).toEqual({ tileX: 50, tileY: 50 });
  });
});

// ---------------------------------------------------------------------------
// #347 (V56) — a player-colony AI sizes itself against, and invades, its OPPONENT
// ---------------------------------------------------------------------------

describe('#347 — a player-colony AI reads its opponent (V56)', () => {
  it('opponentColonyId: player <-> enemy; null when there is no other colony', () => {
    const world = makeMinimalWorld();
    expect(opponentColonyId(world, PLAYER_COLONY_ID as ColonyId)).toBe(ENEMY_COLONY_ID);
    expect(opponentColonyId(world, ENEMY_COLONY_ID as ColonyId)).toBe(PLAYER_COLONY_ID);
    delete world.colonies[PLAYER_COLONY_ID as ColonyId];
    expect(opponentColonyId(world, ENEMY_COLONY_ID as ColonyId)).toBeNull();
  });

  /**
   * The PLAYER colony runs the AI, 10 workers of its own against an enemy of 40
   * (>= AI_FRONTAGE_PLAYER_WORKERS_ABS and >= 1.3x). Before the age gate, only the
   * frontage trigger can move it to WarFooting.
   */
  function playerAIWorld(): WorldState {
    const world = makeMinimalWorld();
    world.simVersion = LATEST_SIM_VERSION;
    world.aiState = [createDefaultAIStateRecord(PLAYER_COLONY_ID as ColonyId)];
    world.tick = AI_WARFOOTING_MIN_TICK - 1; // NOT age ready
    const player = world.colonies[PLAYER_COLONY_ID as ColonyId]!;
    const enemy = world.colonies[ENEMY_COLONY_ID as ColonyId]!;
    spawnFighters(world, PLAYER_COLONY_ID, AI_WARFOOTING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX], 10);
    setPoolFoodForTest(
      world,
      player,
      Math.ceil((colonyFoodCapacity(player) * AI_WARFOOTING_FOOD_FRAC_PCT) / 100), // eslint-disable-line no-restricted-syntax
    );
    player.workerCount = 10;
    enemy.workerCount = 40;
    expect(enemy.workerCount).toBeGreaterThanOrEqual(AI_FRONTAGE_PLAYER_WORKERS_ABS);
    expect(enemy.workerCount * 100).toBeGreaterThanOrEqual(
      AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100 * player.workerCount,
    );
    return world;
  }

  it('the player-colony AI reads the ENEMY worker count and goes to WarFooting early', () => {
    const world = playerAIWorld();
    expect(frontageOpponentWorkerCount(world, PLAYER_COLONY_ID as ColonyId)).toBe(40);
    const rec = advanceAIState(world, PLAYER_COLONY_ID as ColonyId);
    expect(rec.state).toBe('WarFooting');
    // The transition reports the number the check compared.
    const evt = world.events.find((e) => e.type === 'ai_state_transition');
    expect(evt?.type === 'ai_state_transition' && evt.payload.triggerValues.playerWorkerCount).toBe(
      40,
    );
  });

  it("the ENEMY AI goes to WarFooting early on the player's frontage", () => {
    const world = makeMinimalWorld();
    world.simVersion = LATEST_SIM_VERSION;
    world.tick = AI_WARFOOTING_MIN_TICK - 1; // NOT age ready
    const enemy = world.colonies[ENEMY_COLONY_ID as ColonyId]!;
    spawnFighters(world, ENEMY_COLONY_ID, AI_WARFOOTING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX], 10);
    setPoolFoodForTest(
      world,
      enemy,
      Math.ceil((colonyFoodCapacity(enemy) * AI_WARFOOTING_FOOD_FRAC_PCT) / 100), // eslint-disable-line no-restricted-syntax
    );
    enemy.workerCount = 10;
    world.colonies[PLAYER_COLONY_ID as ColonyId]!.workerCount = 40;
    expect(advanceAIState(world, ENEMY_COLONY_ID as ColonyId).state).toBe('WarFooting');
    const evt = world.events.find((e) => e.type === 'ai_state_transition');
    expect(evt?.type === 'ai_state_transition' && evt.payload.triggerValues.playerWorkerCount).toBe(
      40,
    );
  });

  it('invasion_start targets the opponent: the enemy for a player-colony AI', () => {
    const world = makeMinimalWorld();
    world.aiState.push(createDefaultAIStateRecord(PLAYER_COLONY_ID as ColonyId));
    spawnFighters(world, PLAYER_COLONY_ID, 3, 10);
    getAIStateForColony(world, PLAYER_COLONY_ID as ColonyId)!.state = 'Invading';
    setAIRallyOperation(world, PLAYER_COLONY_ID as ColonyId, 104, 0, [10, 11, 12], 'Invasion');
    const evt = world.events.find((e) => e.type === 'invasion_start');
    expect(evt?.payload).toMatchObject({ colonyId: PLAYER_COLONY_ID, targetGrid: ENEMY_COLONY_ID });
  });

  it('invasion_start from the enemy AI still targets the player (unchanged)', () => {
    const world = makeMinimalWorld();
    spawnFighters(world, ENEMY_COLONY_ID, 3, 10);
    getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!.state = 'Invading';
    setAIRallyOperation(world, ENEMY_COLONY_ID as ColonyId, 24, 0, [10, 11, 12], 'Invasion');
    const evt = world.events.find((e) => e.type === 'invasion_start');
    expect(evt?.payload).toMatchObject({ colonyId: ENEMY_COLONY_ID, targetGrid: PLAYER_COLONY_ID });
  });
});

// ---------------------------------------------------------------------------
// #371 (V62) — the AI raid clock (SetAIRaidClock → AIStateRecord.raidSinceTick)
// ---------------------------------------------------------------------------

describe('#371 — SetAIRaidClock (V62)', () => {
  const clock = (raiding: unknown): SimCommand =>
    ({
      type: 'SetAIRaidClock',
      colonyId: ENEMY_COLONY_ID,
      raiding,
      issuedAtTick: 0,
    }) as SimCommand;

  it('starts at the tick it applies, keeps its start while running, and clears', () => {
    const world = makeMinimalWorld();
    const rec = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    world.tick = 500;
    applyCommands(world, [clock(true)]);
    expect(rec.raidSinceTick).toBe(500);
    world.tick = 900;
    applyCommands(world, [clock(true)]);
    expect(rec.raidSinceTick).toBe(500);
    applyCommands(world, [clock(false)]);
    expect(rec.raidSinceTick).toBe(-1);
  });

  it('is a no-op for a non-boolean or an unknown colony', () => {
    const world = makeMinimalWorld();
    const rec = getAIStateForColony(world, ENEMY_COLONY_ID as ColonyId)!;
    world.tick = 500;
    applyCommands(world, [clock('yes')]);
    expect(rec.raidSinceTick).toBe(-1);
    applyCommands(world, [{ ...clock(true), colonyId: 99 } as SimCommand]);
    expect(rec.raidSinceTick).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// #398 (V72) — the invasion floor: a repelled invasion raises it; the launch gate
// needs it until its patience runs out.
// ---------------------------------------------------------------------------

describe('#398 — the invasion floor (V72)', () => {
  const E = ENEMY_COLONY_ID as ColonyId;
  const NORMAL_BASE = AI_INVADING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX]; // 15

  function floorWorld(difficulty: WorldState['difficulty'] = 'Normal'): WorldState {
    const world = makeMinimalWorld();
    world.simVersion = LATEST_SIM_VERSION;
    world.difficulty = difficulty;
    return world;
  }

  /** An Invading record with a committed cohort of `n` (ids 100..), alive or dead. */
  function commitCohort(world: WorldState, n: number, alive: boolean): AIStateRecord {
    const rec = getAIStateForColony(world, E)!;
    const ids = alive ? spawnFighters(world, ENEMY_COLONY_ID, n, 100) : [];
    if (!alive) for (let i = 0; i < n; i++) ids.push(100 + i); // never initialised: dead
    rec.state = 'Invading';
    rec.enteredTick = world.tick;
    rec.invasionStartTick = world.tick;
    setAIRallyOperation(world, E, 30, 5, ids, 'Invasion');
    expect(rec.operationStartFighterCount).toBe(Math.min(n, AI_MAX_OPERATION_FIGHTERS));
    return rec;
  }

  /** A record in WarFooting after a Recovery that ended at `recoveryEndTick`. */
  function warFooting(
    world: WorldState,
    opts: { floor: number; recoveryEndTick: number; tick: number; fighters: number },
  ): AIStateRecord {
    const rec = getAIStateForColony(world, E)!;
    rec.state = 'WarFooting';
    rec.invasionFloor = opts.floor;
    rec.recoveryEndTick = opts.recoveryEndTick;
    // WarFooting is entered after Recovery ends: an enteredTick distinct from
    // recoveryEndTick, so patience measured from the wrong clock shows.
    rec.enteredTick = opts.recoveryEndTick + 500;
    rec.lastProbeEndTick = opts.tick; // no probe signal noise
    world.tick = opts.tick;
    spawnFighters(world, ENEMY_COLONY_ID, opts.fighters, 200);
    const colony = world.colonies[E]!;
    setPoolFoodForTest(world, colony, colonyFoodCapacity(colony)); // food gate met
    return rec;
  }

  const launches = (world: WorldState): boolean => advanceAIState(world, E).state === 'Invading';

  /** The floor a repelled wave of `n` leaves from `floor`, by the rule (the constants
   *  are pinned once, in (6), so a retune of step or cap moves only that test). */
  const raised = (floor: number, n: number, d: WorldState['difficulty'] = 'Normal'): number =>
    Math.min(AI_INVASION_FLOOR_MAX[tierIndex(d)], Math.max(floor, n) + AI_INVASION_FLOOR_STEP);

  // --- escalation on a repelled invasion -------------------------------------------

  it('(1) a rout of an 18-fighter wave raises the floor from 0 to 18 + step (24, Normal)', () => {
    const world = floorWorld();
    world.tick = 9000;
    const rec = commitCohort(world, 18, false);
    advanceAIState(world, E);
    expect(world.events.find((e) => e.type === 'invasion_end')?.payload).toMatchObject({
      outcome: 'fighter_rout',
    });
    expect(rec.state).toBe('Recovery');
    expect(rec.invasionFloor).toBe(raised(0, 18));
    expect(rec.operationStartFighterCount).toBe(0); // the cohort is wiped after the read
  });

  it('(2) a timeout with a committed cohort escalates too', () => {
    const world = floorWorld();
    world.tick = 9000;
    const rec = commitCohort(world, 16, true);
    world.tick = rec.invasionStartTick + AI_INVADING_TIMEOUT_TICKS;
    advanceAIState(world, E);
    expect(world.events.find((e) => e.type === 'invasion_end')?.payload).toMatchObject({
      outcome: 'timeout',
    });
    expect(rec.invasionFloor).toBe(raised(0, 16));
  });

  it('(3) a timeout before any cohort was committed leaves the floor alone', () => {
    for (const floor of [0, 20]) {
      const world = floorWorld();
      const rec = getAIStateForColony(world, E)!;
      rec.invasionFloor = floor;
      rec.state = 'Invading';
      rec.invasionStartTick = 9000;
      // A stale committed size must not count: there is no cohort (count 0).
      rec.operationStartFighterCount = 18;
      world.tick = 9000 + AI_INVADING_TIMEOUT_TICKS;
      spawnFighters(world, ENEMY_COLONY_ID, 20, 100);
      advanceAIState(world, E);
      expect(rec.state).toBe('Recovery');
      expect(rec.invasionFloor).toBe(floor);
    }
  });

  it('an Invasion with no committed fighters (start 0) ending leaves the floor alone', () => {
    const world = floorWorld();
    world.tick = 9000;
    const rec = getAIStateForColony(world, E)!;
    rec.invasionFloor = 20;
    rec.state = 'Invading';
    rec.invasionStartTick = world.tick;
    setAIRallyOperation(world, E, 30, 5, [], 'Invasion');
    expect(rec.operationKind).toBe('Invasion');
    expect(rec.operationStartFighterCount).toBe(0);
    endAIRallyOperation(world, E, 'timeout');
    expect(rec.state).toBe('Recovery');
    expect(rec.invasionFloor).toBe(20);
  });

  it('(4) a queen kill leaves the floor alone', () => {
    const world = floorWorld();
    world.tick = 9000;
    const rec = commitCohort(world, 18, true);
    rec.invasionFloor = 20;
    endAIRallyOperation(world, E, 'queen_kill');
    expect(rec.state).toBe('Recovery');
    expect(rec.invasionFloor).toBe(20);
  });

  it('a rout or timeout forced through endAIRallyOperation escalates like a natural one', () => {
    for (const outcome of ['fighter_rout', 'timeout'] as const) {
      const world = floorWorld();
      world.tick = 9000;
      const rec = commitCohort(world, 18, true);
      endAIRallyOperation(world, E, outcome);
      expect(rec.invasionFloor, outcome).toBe(raised(0, 18));
    }
  });

  it('a probe ending (any way) leaves the floor alone', () => {
    const world = floorWorld();
    world.tick = 9000;
    const rec = getAIStateForColony(world, E)!;
    rec.invasionFloor = 20;
    rec.state = 'WarFooting';
    setAIRallyOperation(world, E, 30, 5, [100, 101, 102], 'Probe'); // dead ids: all done
    advanceAIState(world, E);
    expect(rec.state).toBe('WarFooting');
    setAIRallyOperation(world, E, 30, 5, [100, 101, 102], 'Probe');
    endAIRallyOperation(world, E, 'fighter_rout');
    expect(rec.invasionFloor).toBe(20);
  });

  it('(5) the floor never falls: from 20 a 12-fighter rout gives 20 + step, from 30 the cap', () => {
    for (const [floor, want] of [
      [20, raised(20, 12)],
      [30, AI_INVASION_FLOOR_MAX[NORMAL_TIER_INDEX]],
    ] as const) {
      const world = floorWorld();
      world.tick = 9000;
      const rec = commitCohort(world, 12, false);
      rec.invasionFloor = floor;
      advanceAIState(world, E);
      expect(rec.invasionFloor, `from ${floor}`).toBe(want);
    }
  });

  it('(6) the constants, and the cap per tier: Easy 24, Normal 32, Hard 32 (a step or cap retune edits this test)', () => {
    expect(AI_INVASION_FLOOR_MAX).toEqual([24, 32, 32]);
    expect(AI_INVASION_FLOOR_STEP).toBe(6);
    // Above the cohort buffer the rout accounting would see only the first 32.
    expect(AI_INVASION_FLOOR_MAX.every((c) => c <= AI_MAX_OPERATION_FIGHTERS)).toBe(true);
    for (const [difficulty, n, want] of [
      ['Easy', 20, 24], // capped
      ['Easy', 14, 20],
      ['Normal', 30, 32], // capped
      ['Normal', 20, 26],
      ['Hard', 30, 32], // capped
      ['Hard', 12, 18],
    ] as const) {
      const world = floorWorld(difficulty);
      world.tick = 9000;
      const rec = commitCohort(world, n, false);
      advanceAIState(world, E);
      expect(rec.invasionFloor, `${difficulty} n${n}`).toBe(want);
    }
  });

  it('a cohort of 32 committed from 40 fighters raises the floor to the cap, not past it', () => {
    const world = floorWorld('Hard');
    world.tick = 9000;
    const rec = commitCohort(world, 40, false);
    expect(rec.operationStartFighterCount).toBe(AI_MAX_OPERATION_FIGHTERS);
    advanceAIState(world, E);
    expect(rec.invasionFloor).toBe(AI_INVASION_FLOOR_MAX[tierIndex('Hard')]);
  });

  // --- the launch gate --------------------------------------------------------------

  it('(7) with floor 0 the gate is exactly the base: 14 no, 15 yes (Normal)', () => {
    expect(NORMAL_BASE).toBe(15);
    for (const [fighters, want] of [
      [14, false],
      [15, true],
    ] as const) {
      const world = floorWorld();
      const rec = warFooting(world, { floor: 0, recoveryEndTick: 0, tick: 7000, fighters });
      expect(invasionFighterNeed(world, rec)).toBe(15);
      expect(launches(world), `${fighters}`).toBe(want);
    }
  });

  it('(8) with floor 24 the gate needs 24: 23 no, 24 yes', () => {
    for (const [fighters, want] of [
      [23, false],
      [24, true],
    ] as const) {
      const world = floorWorld();
      const rec = warFooting(world, {
        floor: 24,
        recoveryEndTick: 10_000,
        tick: 10_100,
        fighters,
      });
      expect(invasionFighterNeed(world, rec)).toBe(24);
      expect(launches(world), `${fighters}`).toBe(want);
      if (want) expect(rec.invasionFloor).toBe(24); // launching does not clear it
    }
  });

  it('(9) patience: the floor holds at recoveryEndTick + 3599, the base applies at + 3600', () => {
    expect(AI_INVASION_FLOOR_PATIENCE_TICKS).toBe(3600);
    for (const [elapsed, want] of [
      [AI_INVASION_FLOOR_PATIENCE_TICKS - 1, false],
      [AI_INVASION_FLOOR_PATIENCE_TICKS, true],
    ] as const) {
      const world = floorWorld();
      const rec = warFooting(world, {
        floor: 24,
        recoveryEndTick: 10_000,
        tick: 10_000 + elapsed,
        fighters: NORMAL_BASE, // ≥ base, < floor
      });
      expect(invasionFighterNeed(world, rec)).toBe(want ? NORMAL_BASE : 24);
      expect(launches(world), `+${elapsed}`).toBe(want);
      expect(rec.invasionFloor).toBe(24); // the floor itself stays
    }
  });

  it('(10) the base still applies (not the floor) long after patience', () => {
    const world = floorWorld();
    const rec = warFooting(world, {
      floor: 32,
      recoveryEndTick: 10_000,
      tick: 10_000 + 100 * AI_INVASION_FLOOR_PATIENCE_TICKS,
      fighters: NORMAL_BASE,
    });
    expect(invasionFighterNeed(world, rec)).toBe(NORMAL_BASE);
    expect(launches(world)).toBe(true);
  });

  it('a floor at or below the base changes nothing (Easy floor 18 = base; Normal floor 9 < base)', () => {
    const easy = floorWorld('Easy');
    const easyRec = warFooting(easy, {
      floor: 18,
      recoveryEndTick: 10_000,
      tick: 10_100,
      fighters: 18,
    });
    expect(invasionFighterNeed(easy, easyRec)).toBe(18);
    expect(launches(easy)).toBe(true);
    // A small timed-out cohort (3 + 6 = 9) never lowers the need below the base.
    const normal = floorWorld();
    const normalRec = warFooting(normal, {
      floor: 9,
      recoveryEndTick: 10_000,
      tick: 10_100,
      fighters: NORMAL_BASE - 1,
    });
    expect(invasionFighterNeed(normal, normalRec)).toBe(NORMAL_BASE);
    expect(launches(normal)).toBe(false);
  });

  it('(11) the food gate and the minimum tick still apply with a floor', () => {
    // Food below 70 %: no launch even with fighters over the floor.
    const hungry = floorWorld();
    warFooting(hungry, { floor: 24, recoveryEndTick: 10_000, tick: 10_100, fighters: 30 });
    setPoolFoodForTest(hungry, hungry.colonies[E]!, 0);
    expect(launches(hungry)).toBe(false);
    // Before AI_INVADING_MIN_TICK: no launch.
    const early = floorWorld();
    warFooting(early, {
      floor: 24,
      recoveryEndTick: 6_000,
      tick: AI_INVADING_MIN_TICK - 1,
      fighters: 30,
    });
    expect(launches(early)).toBe(false);
    const onTime = floorWorld();
    warFooting(onTime, {
      floor: 24,
      recoveryEndTick: 6_000,
      tick: AI_INVADING_MIN_TICK,
      fighters: 30,
    });
    expect(launches(onTime)).toBe(true);
  });

  it('Hard: base 12, a floor of 18 needs 18 within patience', () => {
    for (const [fighters, want] of [
      [17, false],
      [18, true],
    ] as const) {
      const world = floorWorld('Hard');
      const rec = warFooting(world, {
        floor: 18,
        recoveryEndTick: 10_000,
        tick: 10_100,
        fighters,
      });
      expect(invasionFighterNeed(world, rec)).toBe(18);
      expect(launches(world), `${fighters}`).toBe(want);
    }
  });

  it('a pre-cohort timeout re-arms an expired floor (any Recovery restarts patience) without raising it', () => {
    const world = floorWorld();
    const rec = warFooting(world, {
      floor: 24,
      recoveryEndTick: 10_000,
      tick: 10_000 + AI_INVASION_FLOOR_PATIENCE_TICKS,
      fighters: NORMAL_BASE,
    });
    expect(launches(world)).toBe(true); // patience ran out: launched at the base
    // No cohort is ever committed: the invasion times out before one.
    world.tick = rec.invasionStartTick + AI_INVADING_TIMEOUT_TICKS;
    advanceAIState(world, E);
    expect(rec.state).toBe('Recovery');
    expect(rec.invasionFloor).toBe(24);
    world.tick = rec.recoveryEndTick;
    advanceAIState(world, E);
    expect(rec.state).toBe('Peacetime');
    // Back in WarFooting: the floor holds again for a fresh patience.
    rec.state = 'WarFooting';
    rec.lastProbeEndTick = world.tick;
    expect(invasionFighterNeed(world, rec)).toBe(24);
    expect(launches(world)).toBe(false);
  });

  it('CLNY-08: a player-colony AI record (--both-ai) escalates and gates on its own floor', () => {
    const world = floorWorld();
    const P = PLAYER_COLONY_ID as ColonyId;
    const enemy = getAIStateForColony(world, E)!;
    const player = createDefaultAIStateRecord(P);
    world.aiState.push(player);
    world.tick = 9000;
    player.state = 'Invading';
    player.invasionStartTick = world.tick;
    setAIRallyOperation(
      world,
      P,
      30,
      5,
      [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317],
      'Invasion',
    );
    advanceAIState(world, P); // dead cohort: rout
    expect(player.invasionFloor).toBe(raised(0, 18));
    expect(enemy.invasionFloor).toBe(0);
    // Its gate reads its own floor: 20 player fighters are not enough within patience.
    player.state = 'WarFooting';
    player.lastProbeEndTick = world.tick = player.recoveryEndTick + 100;
    spawnFighters(world, PLAYER_COLONY_ID, 20, 400);
    setPoolFoodForTest(world, world.colonies[P]!, colonyFoodCapacity(world.colonies[P]!));
    expect(invasionFighterNeed(world, player)).toBe(24);
    expect(advanceAIState(world, P).state).toBe('WarFooting');
    spawnFighters(world, PLAYER_COLONY_ID, 4, 420);
    expect(advanceAIState(world, P).state).toBe('Invading');
  });

  it('(12) recoveryEndTick survives Recovery → Peacetime (the patience clock)', () => {
    const world = floorWorld();
    world.tick = 9000;
    const rec = commitCohort(world, 18, false);
    advanceAIState(world, E); // rout → Recovery
    const end = rec.recoveryEndTick;
    expect(end).toBe(9000 + AI_RECOVERY_DURATION_TICKS[NORMAL_TIER_INDEX]);
    world.tick = end;
    advanceAIState(world, E);
    expect(rec.state).toBe('Peacetime');
    expect(rec.recoveryEndTick).toBe(end);
    expect(rec.invasionFloor).toBe(raised(0, 18));
  });

  it('the default record has no floor', () => {
    expect(createDefaultAIStateRecord(E).invasionFloor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #421 (V73) — a colony with a full army (AI_INVADING_FOOD_GATE_BYPASS_FIGHTERS, the
// cohort cap) launches its invasion without the food check. The fighter need, the
// minimum tick and the other states are unchanged.
// ---------------------------------------------------------------------------

describe('#421 — a full army launches without the food check (V73)', () => {
  const E = ENEMY_COLONY_ID as ColonyId;
  const P = PLAYER_COLONY_ID as ColonyId;
  const FULL = AI_INVADING_FOOD_GATE_BYPASS_FIGHTERS;
  const TIERS = ['Easy', 'Normal', 'Hard'] as const;

  function gateWorld(difficulty: WorldState['difficulty'] = 'Normal'): WorldState {
    const world = makeMinimalWorld();
    world.simVersion = LATEST_SIM_VERSION;
    world.difficulty = difficulty;
    return world;
  }

  /** `cid`'s AI record (created if missing) in WarFooting at `tick`, with `fighters`
   *  of its own fighters (slots from `startId`) and `foodFp` in its stores. */
  function armed(
    world: WorldState,
    cid: ColonyId,
    opts: {
      fighters: number;
      foodFp: number;
      tick: number;
      startId: number;
      floor?: number;
      recoveryEndTick?: number;
    },
  ): AIStateRecord {
    let rec = getAIStateForColony(world, cid);
    if (rec === null) {
      rec = createDefaultAIStateRecord(cid);
      world.aiState.push(rec);
    }
    rec.state = 'WarFooting';
    rec.invasionFloor = opts.floor ?? 0;
    rec.recoveryEndTick = opts.recoveryEndTick ?? 0;
    rec.lastProbeEndTick = opts.tick;
    world.tick = opts.tick;
    spawnFighters(world, cid, opts.fighters, opts.startId);
    setPoolFoodForTest(world, world.colonies[cid]!, opts.foodFp);
    return rec;
  }

  const cap = (world: WorldState, cid: ColonyId = E): number =>
    colonyFoodCapacity(world.colonies[cid]!);
  const half = (world: WorldState, cid: ColonyId = E): number => cap(world, cid) >> 1;
  /** The least food (fp) that passes the 70 % check for a capacity of `c`. */
  function onTheLine(c: number): number {
    let f = 0;
    while (f * 100 < c * AI_INVADING_FOOD_FRAC_PCT) f += 1;
    return f;
  }
  const launches = (world: WorldState, cid: ColonyId = E): boolean =>
    advanceAIState(world, cid).state === 'Invading';

  it('the constant is the cohort cap, 32', () => {
    expect(FULL).toBe(AI_MAX_OPERATION_FIGHTERS);
    expect(FULL).toBe(32);
  });

  it('32 fighters at 50 % food launch once the need and the minimum tick are met (every tier)', () => {
    for (const d of TIERS) {
      const world = gateWorld(d);
      const rec = armed(world, E, {
        fighters: FULL,
        foodFp: half(world),
        tick: 7000,
        startId: 200,
      });
      expect(invasionFighterNeed(world, rec), d).toBeLessThanOrEqual(FULL);
      expect(launches(world), d).toBe(true);
      expect(rec.invasionStartTick, d).toBe(7000);
      // The transition event records the real stores: below the 70 % line.
      const ev = world.events.find((e) => e.type === 'ai_state_transition');
      expect(ev, d).toBeDefined();
      const tv = (
        ev?.payload as {
          to: string;
          triggerValues: { aiFighterCount: number; aiFoodStored: number; aiFoodCap: number };
        }
      ).triggerValues;
      expect((ev?.payload as { to: string }).to, d).toBe('Invading');
      expect(tv.aiFighterCount, d).toBe(FULL);
      expect(tv.aiFoodStored * 100, d).toBeLessThan(tv.aiFoodCap * AI_INVADING_FOOD_FRAC_PCT);
    }
  });

  it('31 fighters at 50 % food do not launch (every tier)', () => {
    for (const d of TIERS) {
      const world = gateWorld(d);
      const rec = armed(world, E, {
        fighters: FULL - 1,
        foodFp: half(world),
        tick: 7000,
        startId: 200,
      });
      expect(FULL - 1, d).toBeGreaterThanOrEqual(invasionFighterNeed(world, rec));
      expect(launches(world), d).toBe(false);
      expect(rec.state, d).toBe('WarFooting');
    }
  });

  it('below 32 the 70 % check is unchanged: 1 fp under the line holds, on the line launches', () => {
    for (const fighters of [AI_INVADING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX], 24, FULL - 1]) {
      for (const [delta, want] of [
        [-1, false],
        [0, true],
      ] as const) {
        const world = gateWorld();
        armed(world, E, { fighters, foodFp: 0, tick: 7000, startId: 200 });
        setPoolFoodForTest(world, world.colonies[E]!, onTheLine(cap(world)) + delta);
        expect(launches(world), `${fighters} fighters, line ${delta}`).toBe(want);
      }
    }
  });

  it('grid: below 32 fighters the gate is V72’s exactly; from 32 it is V72’s without the food check', () => {
    const FIGHTERS = [0, 11, 12, 14, 15, 17, 18, 23, 24, 31, 32, 33, 40] as const;
    const TICKS = [
      AI_INVADING_MIN_TICK - 1,
      AI_INVADING_MIN_TICK,
      10_100,
      10_000 + AI_INVASION_FLOOR_PATIENCE_TICKS,
    ] as const;
    let bypassed = 0; // launched by the bypass alone
    let heldByFood = 0; // below 32, everything but the food met: held, as at V72
    let cases = 0;
    for (const d of TIERS) {
      const world = gateWorld(d);
      const rec = armed(world, E, { fighters: 40, foodFp: 0, tick: 7000, startId: 200 });
      const colony = world.colonies[E]!;
      const c = cap(world);
      for (const fighters of FIGHTERS) {
        for (let i = 0; i < 40; i++) {
          world.ants.task[200 + i] = i < fighters ? AntTask.Fighting : AntTask.Idle;
        }
        for (const food of [0, c >> 1, onTheLine(c) - 1, onTheLine(c), c]) {
          setPoolFoodForTest(world, colony, food);
          for (const t of TICKS) {
            for (const floor of [0, 24, 32]) {
              rec.state = 'WarFooting';
              rec.invasionFloor = floor;
              rec.recoveryEndTick = 10_000;
              rec.lastProbeEndTick = t;
              world.tick = t;
              world.events.length = 0;
              // Independent of ai-state.ts: literal per-tier base need; the floor counts only
              // while it is above the base and its patience has not run out.
              const base = { Easy: 18, Normal: 15, Hard: 12 }[d];
              const need =
                floor > base && t - 10_000 < AI_INVASION_FLOOR_PATIENCE_TICKS ? floor : base;
              const fed = food * 100 >= c * AI_INVADING_FOOD_FRAC_PCT;
              const v72 = fighters >= need && fed && t >= AI_INVADING_MIN_TICK;
              // The spec: below 32 the V72 gate; from 32 the V72 gate without the food check.
              const want = fighters < FULL ? v72 : fighters >= need && t >= AI_INVADING_MIN_TICK;
              const where = `${d} f${fighters} food${food} t${t} floor${floor}`;
              expect(launches(world), where).toBe(want);
              if (want && !v72) bypassed += 1;
              if (!fed && fighters >= need && fighters < FULL && t >= AI_INVADING_MIN_TICK) {
                heldByFood += 1;
              }
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(TIERS.length * FIGHTERS.length * 5 * TICKS.length * 3);
    expect(bypassed).toBeGreaterThan(0);
    expect(heldByFood).toBeGreaterThan(0);
  });

  it('the minimum tick still applies at 32+: 6599 no, 6600 yes', () => {
    for (const [t, want] of [
      [AI_INVADING_MIN_TICK - 1, false],
      [AI_INVADING_MIN_TICK, true],
    ] as const) {
      for (const fighters of [FULL, 40]) {
        const world = gateWorld('Hard');
        armed(world, E, { fighters, foodFp: half(world), tick: t, startId: 200 });
        expect(launches(world), `t${t} f${fighters}`).toBe(want);
      }
    }
    // Full stores do not open it early either.
    const full = gateWorld('Hard');
    armed(full, E, {
      fighters: 40,
      foodFp: cap(full),
      tick: AI_INVADING_MIN_TICK - 1,
      startId: 200,
    });
    expect(launches(full)).toBe(false);
  });

  it('the fighter need still applies at 32+: only the food check is skipped', () => {
    // No escalation reaches past the cap, so a full army always meets its need...
    expect(Math.max(...AI_INVADING_FIGHTER_THRESHOLD)).toBeLessThanOrEqual(FULL);
    expect(Math.max(...AI_INVASION_FLOOR_MAX)).toBeLessThanOrEqual(FULL);
    // ...as at the cap's floor within its patience: 32 at 50 % launch, 31 at full stores do not.
    for (const [fighters, food, want] of [
      [FULL, 'half', true],
      [FULL - 1, 'full', false],
    ] as const) {
      const world = gateWorld('Hard');
      const rec = armed(world, E, {
        fighters,
        foodFp: 0,
        tick: 10_100,
        startId: 200,
        floor: AI_INVASION_FLOOR_MAX[tierIndex('Hard')],
        recoveryEndTick: 10_000,
      });
      setPoolFoodForTest(world, world.colonies[E]!, food === 'half' ? half(world) : cap(world));
      expect(invasionFighterNeed(world, rec)).toBe(FULL);
      expect(launches(world), `${fighters} ${food}`).toBe(want);
    }
    // ...but the need is still read: a floor above the army holds a 35-fighter army at
    // 50 %. Not reachable in play (escalation caps the floor at AI_INVASION_FLOOR_MAX,
    // and the save loader clamps it to the tier's cap): it pins that only the food
    // check is skipped.
    for (const [fighters, want] of [
      [35, false],
      [40, true],
    ] as const) {
      const world = gateWorld();
      const rec = armed(world, E, {
        fighters,
        foodFp: 0,
        tick: 10_100,
        startId: 200,
        floor: 40,
        recoveryEndTick: 10_000,
      });
      setPoolFoodForTest(world, world.colonies[E]!, half(world));
      expect(invasionFighterNeed(world, rec)).toBe(40);
      expect(launches(world), `${fighters}`).toBe(want);
    }
  });

  it('only WarFooting launches: at 40 fighters Peacetime still arms at 50 % food, and Recovery and Probing run their course', () => {
    // Peacetime: below 50 % a full army does not even arm; at 50 % it arms (WarFooting,
    // not Invading), and launches from WarFooting on the next tick.
    const peace = gateWorld();
    const pRec = armed(peace, E, { fighters: 40, foodFp: 0, tick: 7000, startId: 200 });
    pRec.state = 'Peacetime';
    setPoolFoodForTest(peace, peace.colonies[E]!, half(peace) - 1);
    advanceAIState(peace, E);
    expect(pRec.state).toBe('Peacetime');
    setPoolFoodForTest(peace, peace.colonies[E]!, half(peace));
    advanceAIState(peace, E);
    expect(pRec.state).toBe('WarFooting');
    peace.tick += 1;
    advanceAIState(peace, E);
    expect(pRec.state).toBe('Invading');
    // Recovery: stays until it ends, then Peacetime — never straight to Invading.
    const recovering = gateWorld();
    const rRec = armed(recovering, E, { fighters: 40, foodFp: 0, tick: 9000, startId: 200 });
    rRec.state = 'Recovery';
    rRec.recoveryEndTick = 9000 + AI_RECOVERY_DURATION_TICKS[NORMAL_TIER_INDEX];
    advanceAIState(recovering, E);
    expect(rRec.state).toBe('Recovery');
    recovering.tick = rRec.recoveryEndTick;
    advanceAIState(recovering, E);
    expect(rRec.state).toBe('Peacetime');
    // Probing: a live probe cohort out on the surface keeps the colony Probing.
    const probe = gateWorld();
    const qRec = armed(probe, E, { fighters: 40, foodFp: 0, tick: 7000, startId: 200 });
    setAIRallyOperation(probe, E, 30, 5, [200, 201, 202], 'Probe');
    expect(qRec.state).toBe('Probing');
    advanceAIState(probe, E);
    expect(qRec.state).toBe('Probing');
  });

  it('CLNY-08: each colony counts its own fighters', () => {
    for (const [enemyF, playerF] of [
      [FULL, FULL - 1],
      [20, 40],
    ] as const) {
      const world = gateWorld();
      // Both colonies armed at 50 %; the world holds 32+ fighters either way.
      const enemy = armed(world, E, {
        fighters: enemyF,
        foodFp: half(world),
        tick: 7000,
        startId: 200,
      });
      const player = armed(world, P, {
        fighters: playerF,
        foodFp: half(world, P),
        tick: 7000,
        startId: 400,
      });
      advanceAIState(world, E);
      advanceAIState(world, P);
      const where = `enemy ${enemyF}, player ${playerF}`;
      expect(enemy.state, where).toBe(enemyF >= FULL ? 'Invading' : 'WarFooting');
      expect(player.state, where).toBe(playerF >= FULL ? 'Invading' : 'WarFooting');
    }
  });
});

// ---------------------------------------------------------------------------
// #426 (V75) — a pre-cohort Invading stands down to WarFooting when the army is
// below the launch need.
// ---------------------------------------------------------------------------

describe('#426 — an invasion with no cohort yet stands down under the need (V75)', () => {
  const E = ENEMY_COLONY_ID as ColonyId;
  const NEED_NORMAL = AI_INVADING_FIGHTER_THRESHOLD[NORMAL_TIER_INDEX];

  /** An Invading record, no cohort committed, with `fighters` fighters and a floor. */
  function preCohort(fighters: number, floor = 0): { world: WorldState; rec: AIStateRecord } {
    const world = makeMinimalWorld();
    world.simVersion = LATEST_SIM_VERSION;
    world.difficulty = 'Normal';
    world.tick = 9000;
    const rec = getAIStateForColony(world, E)!;
    rec.state = 'Invading';
    rec.enteredTick = 8900;
    rec.invasionStartTick = 8900;
    rec.invasionFloor = floor;
    rec.recoveryEndTick = 1234;
    rec.invasionRallyTileX = 30;
    rec.invasionRallyTileY = 5;
    spawnFighters(world, ENEMY_COLONY_ID, fighters, 100);
    return { world, rec };
  }

  it('(1) fighters below the need: back to WarFooting, nothing launched, nothing raised', () => {
    const { world, rec } = preCohort(NEED_NORMAL - 1);
    expect(invasionFighterNeed(world, rec)).toBe(NEED_NORMAL);
    advanceAIState(world, E);
    expect(rec.state).toBe('WarFooting');
    expect(rec.enteredTick).toBe(world.tick);
    expect(rec.invasionStartTick).toBe(0);
    expect(rec.invasionRallyTileX).toBe(-1);
    expect(rec.invasionRallyTileY).toBe(-1);
    expect(rec.operationKind).toBe('None');
    expect(rec.invasionFloor).toBe(0);
    expect(rec.recoveryEndTick).toBe(1234);
    const ev = world.events.filter((e) => e.type === 'ai_state_transition');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ colonyId: E, from: 'Invading', to: 'WarFooting' });
    expect(world.events.some((e) => e.type === 'invasion_end')).toBe(false);
    expect(world.commandQueue.some((c) => c.type === 'ClearRallyPoint')).toBe(false);
  });

  it('(1b) the floor counts as the need while it is in force, and the stand-down leaves it', () => {
    const floor = NEED_NORMAL + 6;
    const { world, rec } = preCohort(NEED_NORMAL + 2, floor);
    rec.recoveryEndTick = world.tick - 10; // patience has barely begun: the need is the floor
    expect(invasionFighterNeed(world, rec)).toBe(floor);
    advanceAIState(world, E);
    expect(rec.state).toBe('WarFooting');
    expect(rec.invasionFloor).toBe(floor);
  });

  it('(2) fighters exactly at the need: stays Invading', () => {
    const { world, rec } = preCohort(NEED_NORMAL);
    advanceAIState(world, E);
    expect(rec.state).toBe('Invading');
    expect(rec.invasionStartTick).toBe(8900);
    expect(world.events.some((e) => e.type === 'ai_state_transition')).toBe(false);
  });

  it('(3) once a cohort is committed, fewer fighters than the need do not stand it down', () => {
    const { world, rec } = preCohort(0);
    const ids = spawnFighters(world, ENEMY_COLONY_ID, NEED_NORMAL, 100);
    setAIRallyOperation(world, E, 30, 5, ids, 'Invasion');
    // The rest of the army falls: 3 of the cohort left, below the need but not a rout.
    for (const id of ids.slice(3)) world.ants.alive[id] = 0;
    expect(aiFightersAlive(world)).toBeLessThan(NEED_NORMAL);
    advanceAIState(world, E);
    expect(rec.state).toBe('Invading');
    expect(rec.operationKind).toBe('Invasion');
    // The rout rule is unchanged: fewer than 3 of the cohort alive ends it.
    world.ants.alive[ids[0]!] = 0;
    advanceAIState(world, E);
    expect(rec.state).toBe('Recovery');
    expect(world.events.find((e) => e.type === 'invasion_end')?.payload).toMatchObject({
      outcome: 'fighter_rout',
    });
  });

  it('the pre-cohort timeout still fires when the army is at its need', () => {
    const { world, rec } = preCohort(NEED_NORMAL);
    world.tick = rec.invasionStartTick + AI_INVADING_TIMEOUT_TICKS;
    advanceAIState(world, E);
    expect(rec.state).toBe('Recovery');
  });

  function aiFightersAlive(world: WorldState): number {
    return world.ants.alive.reduce(
      (n, a, i) => n + (a === 1 && world.ants.colonyId[i] === E ? 1 : 0),
      0,
    );
  }
});
