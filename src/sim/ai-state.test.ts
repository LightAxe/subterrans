// src/sim/ai-state.test.ts
// S2 — unit tests for ai-state.ts narrow sim helpers.
// Covers CF-P1-010 boundary cases, getAIStateForColony, operation death counters.

import { describe, it, expect } from 'vitest';
import { createWorldState } from './types.js';
import type { WorldState, AIStateRecord } from './types.js';
import {
  LATEST_SIM_VERSION,
  SIM_VERSION_V19_AI_STATE,
  SIM_VERSION_V55_ROUTED_HOMING,
  SIM_VERSION_V56_OPPONENT_FRONTAGE,
} from './types.js';
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
  it('LATEST is V56 or later', () => {
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V56_OPPONENT_FRONTAGE);
  });

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
  function playerAIWorld(simVersion: number): WorldState {
    const world = makeMinimalWorld();
    world.simVersion = simVersion;
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

  it('V56: the player-colony AI reads the ENEMY worker count and goes to WarFooting early', () => {
    const world = playerAIWorld(SIM_VERSION_V56_OPPONENT_FRONTAGE);
    expect(frontageOpponentWorkerCount(world, PLAYER_COLONY_ID as ColonyId)).toBe(40);
    const rec = advanceAIState(world, PLAYER_COLONY_ID as ColonyId);
    expect(rec.state).toBe('WarFooting');
    // The transition reports the number the check compared.
    const evt = world.events.find((e) => e.type === 'ai_state_transition');
    expect(evt?.type === 'ai_state_transition' && evt.payload.triggerValues.playerWorkerCount).toBe(
      40,
    );
  });

  it('V55 (pinned): the player-colony AI compares its own workers with itself — stays Peacetime', () => {
    const world = playerAIWorld(SIM_VERSION_V55_ROUTED_HOMING);
    expect(frontageOpponentWorkerCount(world, PLAYER_COLONY_ID as ColonyId)).toBe(10);
    expect(advanceAIState(world, PLAYER_COLONY_ID as ColonyId).state).toBe('Peacetime');
  });

  it('the ENEMY AI reads the player count at V55 and V56 alike (real play unchanged)', () => {
    for (const v of [SIM_VERSION_V55_ROUTED_HOMING, SIM_VERSION_V56_OPPONENT_FRONTAGE]) {
      const world = makeMinimalWorld();
      world.simVersion = v;
      world.colonies[PLAYER_COLONY_ID as ColonyId]!.workerCount = 33;
      world.colonies[ENEMY_COLONY_ID as ColonyId]!.workerCount = 7;
      expect(frontageOpponentWorkerCount(world, ENEMY_COLONY_ID as ColonyId)).toBe(33);
    }
  });

  it("V56: the ENEMY AI still goes to WarFooting early on the player's frontage", () => {
    const world = makeMinimalWorld();
    world.simVersion = SIM_VERSION_V56_OPPONENT_FRONTAGE;
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
