// src/sim/ai-state.ts
// S2 — narrow sim helpers for AI state machine mutation + event emission.
//
// Render-side ai-controller.ts calls these helpers; it never writes world.aiState.* directly.
// Per CF-P0-004 / ADR-0007: sim owns mutation and event emission; render owns policy.
//
// QC Pass 4 AR-P0-001: S2 V17 ships Normal-only tier reads. S5 V22 gates all
// NORMAL_TIER_INDEX lookup sites on SIM_VERSION_V22_DIFFICULTY and uses tierIndex(world.difficulty).

import type { WorldState, AIStateRecord } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import type { ClearRallyPointCommand } from './commands.js';
import { emitEvent } from './telemetry.js';
import { AntTask, ChamberType } from './enums.js';
import { Zone } from './terrain.js';
import {
  PLAYER_COLONY_ID,
  AI_WARFOOTING_MIN_TICK,
  AI_WARFOOTING_FIGHTER_THRESHOLD,
  AI_WARFOOTING_FOOD_FRAC_PCT,
  AI_INVADING_FOOD_FRAC_PCT,
  AI_FRONTAGE_PLAYER_WORKERS_ABS,
  AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100,
  AI_PROBE_INTERVAL_TICKS,
  AI_PROBE_FIGHTER_COUNT,
  AI_PROBE_TIMEOUT_TICKS,
  AI_INVADING_MIN_TICK,
  AI_INVADING_FIGHTER_THRESHOLD,
  AI_INVADING_TIMEOUT_TICKS,
  AI_RECOVERY_DURATION_TICKS,
  AI_MAX_OPERATION_FIGHTERS,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
} from './constants.js';


// QC Pass 4 AR-P0-001: Normal-only tier index. Used for pre-V22 saves; V22+ uses tierIndex(world.difficulty).
export const NORMAL_TIER_INDEX = 1 as const;

/**
 * S5 (V22) — Map player-selected difficulty to a 0-based tier index for
 * per-difficulty constant arrays (e.g. AI_WARFOOTING_FIGHTER_THRESHOLD).
 * Easy=0, Normal=1, Hard=2.
 */
export function tierIndex(difficulty: WorldState['difficulty']): 0 | 1 | 2 {
  if (difficulty === 'Easy') return 0;
  if (difficulty === 'Hard') return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Helper: create a fresh AIStateRecord at defensive defaults (pre-V17 migration)
// ---------------------------------------------------------------------------

export function createDefaultAIStateRecord(colonyId: ColonyId): AIStateRecord {
  return {
    colonyId,
    state: 'Peacetime',
    enteredTick: 0,
    probeCount: 0,
    lastProbeEndTick: 0,
    invasionStartTick: 0,
    invasionRallyTileX: -1,
    invasionRallyTileY: -1,
    recoveryEndTick: 0,
    operationKind: 'None',
    operationStartTick: 0,
    operationTargetTileX: -1,
    operationTargetTileY: -1,
    operationFighterIds: new Int32Array(AI_MAX_OPERATION_FIGHTERS).fill(-1),
    operationFighterCount: 0,
    operationStartFighterCount: 0,
    operationAttackerDeaths: 0,
    operationDefenderDeaths: 0,
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Sim-safe lookup: iterate world.aiState to find the record by colonyId.
 * QC Pass 4 AR-P1-001: do NOT assume array is dense-indexed by raw ColonyId.
 */
export function getAIStateForColony(world: WorldState, colonyId: ColonyId): AIStateRecord | null {
  for (let i = 0; i < world.aiState.length; i++) {
    if (world.aiState[i]!.colonyId === colonyId) return world.aiState[i]!;
  }
  return null;
}

/**
 * O(n) cohort membership check. n ≤ AI_MAX_OPERATION_FIGHTERS (32) — negligible.
 */
export function isInCohort(id: number, cohort: Int32Array, count: number): boolean {
  for (let i = 0; i < count; i++) {
    if (cohort[i] === id) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// World-state query helpers used by the state machine
// ---------------------------------------------------------------------------

/** Count alive AI fighters (colonyId === aiColonyId AND task === Fighting). */
export function aiFighterCount(world: WorldState, aiColonyId: ColonyId): number {
  const { ants } = world;
  let count = 0;
  for (let i = 0; i < ants.alive.length; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.colonyId[i] !== aiColonyId) continue;
    if (ants.task[i] === AntTask.Fighting) count += 1;
  }
  return count;
}

/** Count alive AI workers of any task (excludes dead ants). */
export function aiWorkerCount(world: WorldState, aiColonyId: ColonyId): number {
  const colony = world.colonies[aiColonyId];
  if (colony === undefined) return 0;
  return colony.workerCount;
}

/** Total food stored by the AI colony (entrance pool + food chambers). */
export function aiFoodStored(world: WorldState, aiColonyId: ColonyId): number {
  const colony = world.colonies[aiColonyId];
  if (colony === undefined) return 0;
  let total = colony.foodStored;
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType === ChamberType.FoodStorage) total += ch.foodStored;
  }
  return total;
}

/** Total food storage capacity of the AI colony (base + food chambers). */
export function aiFoodCapacity(world: WorldState, aiColonyId: ColonyId): number {
  const colony = world.colonies[aiColonyId];
  if (colony === undefined) return BASE_FOOD_STORAGE_CAPACITY;
  let capacity = BASE_FOOD_STORAGE_CAPACITY;
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType === ChamberType.FoodStorage) capacity += FOOD_CHAMBER_CAPACITY;
  }
  return capacity;
}

/** Player colony worker count. */
export function playerWorkerCount(world: WorldState): number {
  const colony = world.colonies[PLAYER_COLONY_ID];
  if (colony === undefined) return 0;
  return colony.workerCount;
}

// ---------------------------------------------------------------------------
// Cohort-alive-count helper (for operation exit conditions)
// ---------------------------------------------------------------------------

/** Count how many fighters in the committed cohort are still alive. */
function cohortAliveCount(world: WorldState, aiState: AIStateRecord): number {
  let count = 0;
  for (let i = 0; i < aiState.operationFighterCount; i++) {
    const id = aiState.operationFighterIds[i]!;
    if (id >= 0 && world.ants.alive[id] === 1) count += 1;
  }
  return count;
}

/** Check if all committed probe cohort fighters are "done" (dead or returned home non-fighting). */
function allProbeFightersDone(world: WorldState, aiState: AIStateRecord): boolean {
  const { ants } = world;
  for (let i = 0; i < aiState.operationFighterCount; i++) {
    const id = aiState.operationFighterIds[i]!;
    if (id < 0) continue;
    if (ants.alive[id] !== 1) continue; // dead = done
    // "Done" = alive AND back in AI's underground grid AND task !== Fighting.
    // In-transit (alive but on surface or not yet returned) is NOT done.
    const onAIGrid = ants.zone[id] === Zone.Underground &&
      ants.currentGridColonyId[id] === aiState.colonyId;
    const notFighting = ants.task[id] !== AntTask.Fighting;
    if (!(onAIGrid && notFighting)) return false; // still out
  }
  return true;
}

// ---------------------------------------------------------------------------
// advanceAIState — evaluate transitions, write new state, emit events
// ---------------------------------------------------------------------------

/**
 * Evaluate AI state machine transitions for one tick and mutate world.aiState.
 * Called from render-side aiStateMachineTick; never called with a player colony.
 * Returns the (potentially updated) AIStateRecord for the colony.
 */
export function advanceAIState(world: WorldState, aiColonyId: ColonyId): AIStateRecord {
  let aiState = getAIStateForColony(world, aiColonyId);
  if (aiState === null) {
    // Should not happen if scenario initializes correctly; defensive fallback.
    const rec = createDefaultAIStateRecord(aiColonyId);
    world.aiState.push(rec);
    aiState = rec;
  }

  const prevState = aiState.state;

  switch (aiState.state) {
    case 'Peacetime':
      _tryTransitionPeacetimeToWarFooting(world, aiColonyId, aiState);
      break;
    case 'WarFooting':
      // QC Pass 4 AD3: check Invading BEFORE probe-interval to ensure Invading fires
      // at tick 6600 if conditions are met, not slipping a probe-cycle further out.
      if (_checkWarFootingToInvading(world, aiColonyId, aiState)) break;
      _tryTransitionWarFootingToProbing(world, aiColonyId, aiState);
      break;
    case 'Probing':
      _checkProbingToWarFooting(world, aiColonyId, aiState);
      break;
    case 'Invading':
      _checkInvadingToRecovery(world, aiColonyId, aiState);
      break;
    case 'Recovery':
      _checkRecoveryToPeacetime(world, aiColonyId, aiState);
      break;
  }

  // Increment ticksInState alias (not a separate field; use enteredTick for this)
  // Note: ticksInState = world.tick - aiState.enteredTick (derived, not stored separately)

  if (aiState.state !== prevState) {
    // Emit ai_state_transition structural event.
    const fighters = aiFighterCount(world, aiColonyId);
    const foodStored = aiFoodStored(world, aiColonyId);
    const foodCap = aiFoodCapacity(world, aiColonyId);
    emitEvent(world, {
      tick: world.tick,
      type: 'ai_state_transition',
      payload: {
        colonyId: aiColonyId,
        from: prevState,
        to: aiState.state,
        triggerValues: {
          aiFighterCount: fighters,
          aiFoodStored: foodStored,
          aiFoodCap: foodCap,
          playerWorkerCount: playerWorkerCount(world),
        },
      },
    });
  }

  return aiState;
}

// ---------------------------------------------------------------------------
// State transition helpers (internal)
// ---------------------------------------------------------------------------

function _tryTransitionPeacetimeToWarFooting(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
): void {
  const fighters = aiFighterCount(world, aiColonyId);
  const foodStored = aiFoodStored(world, aiColonyId);
  const foodCap = aiFoodCapacity(world, aiColonyId);

  // CF-P1-010: aiReady AND (ageReady OR frontageReady)
  const aiReady =
    fighters >= AI_WARFOOTING_FIGHTER_THRESHOLD[tierIndex(world.difficulty)] &&
    foodStored * 100 >= foodCap * AI_WARFOOTING_FOOD_FRAC_PCT;

  const ageReady = world.tick >= AI_WARFOOTING_MIN_TICK;

  const aiWorkers = aiWorkerCount(world, aiColonyId);
  const playerWorkers = playerWorkerCount(world);
  const frontageReady =
    playerWorkers >= AI_FRONTAGE_PLAYER_WORKERS_ABS &&
    playerWorkers * 100 >= AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100 * aiWorkers;

  if (aiReady && (ageReady || frontageReady)) {
    aiState.state = 'WarFooting';
    aiState.enteredTick = world.tick;
  }
}

/** Returns true if transition fired (to prevent probe check on same tick). */
function _checkWarFootingToInvading(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
): boolean {
  const fighters = aiFighterCount(world, aiColonyId);
  const foodStored = aiFoodStored(world, aiColonyId);
  const foodCap = aiFoodCapacity(world, aiColonyId);

  if (
    fighters >= AI_INVADING_FIGHTER_THRESHOLD[tierIndex(world.difficulty)] &&
    foodStored * 100 >= foodCap * AI_INVADING_FOOD_FRAC_PCT &&
    world.tick >= AI_INVADING_MIN_TICK
  ) {
    aiState.state = 'Invading';
    aiState.enteredTick = world.tick;
    aiState.invasionStartTick = world.tick;
    return true;
  }
  return false;
}

function _tryTransitionWarFootingToProbing(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
): void {
  // Probe-interval check: every AI_PROBE_INTERVAL_TICKS while in WarFooting.
  // Guard: aiFighterCount >= 3 AND probe target must exist (checked by caller via setAIRallyOperation).
  // The actual transition is completed by the render-side controller calling setAIRallyOperation.
  // Here we just check the time gate and fighter count gate.
  const ticksSinceLastProbe = world.tick - aiState.lastProbeEndTick;
  if (ticksSinceLastProbe < AI_PROBE_INTERVAL_TICKS) return;
  if (aiFighterCount(world, aiColonyId) < AI_PROBE_FIGHTER_COUNT) return;
  // Signal to caller that probe conditions are met (state left as WarFooting until
  // setAIRallyOperation is called with operationKind='Probe' which transitions to Probing).
  // The render controller reads aiState.state and calls setAIRallyOperation to proceed.
  // To communicate probe-readiness, we set a sentinel: operationKind remains 'None'
  // but the render checks probe-interval conditions itself. This is policy-side.
  // (no state mutation here — render side does the target check and calls setAIRallyOperation)
}

function _checkProbingToWarFooting(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
): void {
  // Exit conditions (evaluated against committed cohort per CF-P0-005):
  // 1. All committed fighters dead (zero-cohort case → allDead=true, recovers immediately)
  // 2. All committed fighters "done" (returned home non-fighting)
  // 3. Timeout
  const allDead = cohortAliveCount(world, aiState) === 0;
  const timeout = world.tick - aiState.operationStartTick >= AI_PROBE_TIMEOUT_TICKS;
  const allDone = !allDead && allProbeFightersDone(world, aiState);

  if (allDead || allDone || timeout) {
    // Emit ClearRallyPoint before clearing rally tile so fighters re-route home.
    if (aiState.invasionRallyTileX !== -1) {
      const clearCmd: ClearRallyPointCommand = { type: 'ClearRallyPoint', colonyId: aiColonyId, issuedAtTick: world.tick };
      world.commandQueue.push(clearCmd);
    }
    aiState.state = 'WarFooting';
    aiState.enteredTick = world.tick;
    aiState.lastProbeEndTick = world.tick;
    aiState.probeCount += 1;
    // Intentionally preserve invasionRallyTileX/Y as the "last probe target" so that
    // _selectInvasionEntrance can use it for proximity-based entrance selection when
    // Invading starts later. The live colony.rallyPoint is cleared above via ClearRallyPoint.
    // These fields will be overwritten when the next probe or invasion begins.
    _clearOperationFields(aiState);
  }
}

function _checkInvadingToRecovery(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
): void {
  // Exit conditions (CF-P0-005 — cohort-based):
  // 1. Queen kill → game ends; AI stays Invading (Q-6: aiStateAtTime = "Invading")
  // 2. Cohort alive < 3 (only once a cohort has been committed)
  // 3. Timeout (only once a cohort has been committed, so entrance-retry ticks don't burn the budget)
  if (aiState.operationFighterCount === 0) {
    // No cohort committed yet (entrance-retry window). Use invasionStartTick so
    // entrance unavailability can't lock the AI in Invading indefinitely.
    // Guard against save-restored state with invasionStartTick=0 (mirrors the guard in
    // setAIRallyOperation at the cohort-committed path).
    if (aiState.invasionStartTick === 0) aiState.invasionStartTick = world.tick;
    if (world.tick - aiState.invasionStartTick >= AI_INVADING_TIMEOUT_TICKS) {
      // setAIRallyOperation was never called (no entrance found), so no invasion_start
      // was emitted and no rally point is set. Transition directly to Recovery without
      // _endInvasion to avoid emitting an orphaned invasion_end event or a spurious
      // ClearRallyPoint. advanceAIState still emits ai_state_transition after this returns.
      aiState.state = 'Recovery';
      aiState.enteredTick = world.tick;
      aiState.recoveryEndTick = world.tick + AI_RECOVERY_DURATION_TICKS[tierIndex(world.difficulty)];
      aiState.invasionStartTick = 0;
      aiState.invasionRallyTileX = -1;
      aiState.invasionRallyTileY = -1;
      _clearOperationFields(aiState);
    }
    return;
  }
  const aliveCount = cohortAliveCount(world, aiState);
  // Use invasionStartTick (invasion entry) not operationStartTick (cohort commit) so the
  // entrance-retry window and the cohort fight share one budget, not two.
  const timeout = world.tick - aiState.invasionStartTick >= AI_INVADING_TIMEOUT_TICKS;
  // P0-2: clamp rout threshold to cohort size so a 1-2 fighter cohort doesn't
  // immediately rout (shouldn't happen in practice; tick.ts rejects < 3 for Invasion).
  const rout = aliveCount < Math.min(3, aiState.operationStartFighterCount);

  if (rout || timeout) {
    const outcome: 'fighter_rout' | 'timeout' = rout ? 'fighter_rout' : 'timeout';
    _endInvasion(world, aiColonyId, aiState, outcome);
  }
}

function _checkRecoveryToPeacetime(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
): void {
  if (aiState.recoveryEndTick === 0) return;
  if (world.tick >= aiState.recoveryEndTick) {
    aiState.state = 'Peacetime';
    aiState.enteredTick = world.tick;
  }
}

function _endInvasion(
  world: WorldState,
  aiColonyId: ColonyId,
  aiState: AIStateRecord,
  outcome: 'queen_kill' | 'fighter_rout' | 'timeout',
): void {
  const attackerLosses = aiState.operationAttackerDeaths;
  const defenderLosses = aiState.operationDefenderDeaths;

  emitEvent(world, {
    tick: world.tick,
    type: 'invasion_end',
    payload: {
      colonyId: aiColonyId,
      outcome,
      attackerLosses,
      defenderLosses,
    },
  });

  // Emit ClearRallyPoint so fighters stop routing to the invasion target and go home.
  const clearCmd: ClearRallyPointCommand = { type: 'ClearRallyPoint', colonyId: aiColonyId, issuedAtTick: world.tick };
  world.commandQueue.push(clearCmd);
  aiState.state = 'Recovery';
  aiState.enteredTick = world.tick;
  aiState.recoveryEndTick = world.tick + AI_RECOVERY_DURATION_TICKS[tierIndex(world.difficulty)];
  aiState.invasionStartTick = 0;
  aiState.invasionRallyTileX = -1;
  aiState.invasionRallyTileY = -1;
  _clearOperationFields(aiState);
}

function _clearOperationFields(aiState: AIStateRecord): void {
  aiState.operationKind = 'None';
  aiState.operationStartTick = 0;
  aiState.operationTargetTileX = -1;
  aiState.operationTargetTileY = -1;
  aiState.operationFighterIds.fill(-1);
  aiState.operationFighterCount = 0;
  aiState.operationStartFighterCount = 0;
  aiState.operationAttackerDeaths = 0;
  aiState.operationDefenderDeaths = 0;
}

// ---------------------------------------------------------------------------
// setAIRallyOperation — atomically write operation fields; emit invasion_start
// ---------------------------------------------------------------------------

/**
 * Atomically writes rally/operation state and transitions to Probing or Invading.
 * Emits invasion_start for Invasion operations.
 * Called by render-side ai-controller.ts after target selection.
 */
export function setAIRallyOperation(
  world: WorldState,
  aiColonyId: ColonyId,
  rallyTileX: number,
  rallyTileY: number,
  committedFighterIds: readonly number[],
  operationKind: 'Probe' | 'Invasion',
): void {
  let aiState = getAIStateForColony(world, aiColonyId);
  if (aiState === null) return;

  const count = Math.min(committedFighterIds.length, AI_MAX_OPERATION_FIGHTERS);
  aiState.operationKind = operationKind;
  aiState.operationStartTick = world.tick;
  aiState.operationTargetTileX = rallyTileX;
  aiState.operationTargetTileY = rallyTileY;
  aiState.operationFighterIds.fill(-1);
  for (let i = 0; i < count; i++) {
    aiState.operationFighterIds[i] = committedFighterIds[i]!;
  }
  aiState.operationFighterCount = count;
  aiState.operationStartFighterCount = count;
  aiState.operationAttackerDeaths = 0;
  aiState.operationDefenderDeaths = 0;

  if (operationKind === 'Probe') {
    aiState.invasionRallyTileX = rallyTileX;
    aiState.invasionRallyTileY = rallyTileY;
    aiState.state = 'Probing';
    aiState.enteredTick = world.tick;
    // ai_state_transition event emitted by advanceAIState caller check
    // (but since setAIRallyOperation is called from the render controller AFTER
    // advanceAIState, we emit it here directly)
    const fighters = aiFighterCount(world, aiColonyId);
    const foodStored = aiFoodStored(world, aiColonyId);
    const foodCap = aiFoodCapacity(world, aiColonyId);
    emitEvent(world, {
      tick: world.tick,
      type: 'ai_state_transition',
      payload: {
        colonyId: aiColonyId,
        from: 'WarFooting',
        to: 'Probing',
        triggerValues: {
          aiFighterCount: fighters,
          aiFoodStored: foodStored,
          aiFoodCap: foodCap,
          playerWorkerCount: playerWorkerCount(world),
        },
      },
    });
  } else {
    // Invasion
    aiState.invasionRallyTileX = rallyTileX;
    aiState.invasionRallyTileY = rallyTileY;
    aiState.state = 'Invading';
    aiState.enteredTick = world.tick;
    // Preserve invasionStartTick set by _checkWarFootingToInvading (tick T) so that both
    // the pre-cohort and cohort timeout paths share a single budget from invasion entry.
    // Only overwrite if it was somehow not set (e.g., SyncAIState-restored state).
    if (aiState.invasionStartTick === 0) aiState.invasionStartTick = world.tick;

    emitEvent(world, {
      tick: world.tick,
      type: 'invasion_start',
      payload: {
        colonyId: aiColonyId,
        rallyTile: { x: rallyTileX, y: rallyTileY, grid: 'surface' },
        fighterCount: count,
        targetGrid: PLAYER_COLONY_ID,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// endAIRallyOperation — reset operation state; emit invasion_end for Invasion
// ---------------------------------------------------------------------------

/**
 * Called by render-side ai-controller.ts when an operation (Probe or Invasion) ends
 * due to external cause (e.g., queen kill detected by checkQueenDeath).
 * For natural operation termination (cohort attrition / timeout), advanceAIState
 * handles the transition; this is for callers that need to force-end an operation.
 */
export function endAIRallyOperation(
  world: WorldState,
  aiColonyId: ColonyId,
  outcome: 'queen_kill' | 'fighter_rout' | 'timeout',
): void {
  const aiState = getAIStateForColony(world, aiColonyId);
  if (aiState === null) return;

  if (aiState.operationKind === 'Invasion') {
    _endInvasion(world, aiColonyId, aiState, outcome);
  } else if (aiState.operationKind === 'Probe') {
    aiState.state = 'WarFooting';
    aiState.enteredTick = world.tick;
    aiState.lastProbeEndTick = world.tick;
    aiState.probeCount += 1;
    _clearOperationFields(aiState);
  }
}
