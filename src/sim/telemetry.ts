// telemetry.ts — S0b: SimEvent discriminated union, emitEvent helper,
// and cap enforcement (ADR-0013 v2 / D-31 / D-34).
//
// This is a SIM-SIDE module (src/sim/). It mutates WorldState.events and
// the two overflow counters. Render-side code must NOT import emitEvent;
// instead it calls narrow sim helpers (e.g. transitionAIState in S2)
// that perform both the state mutation and the event emission atomically.
//
// Cap policy (D-34):
//   - Hard cap: WorldState.events never exceeds PLAYTRACE_EVENT_CAP_PER_ROUND.
//   - combat_kill is the only evictable event type (lowest priority).
//   - New structural event over cap: evict oldest combat_kill, append new.
//   - New combat_kill over cap: evict oldest combat_kill, append new.
//   - Over cap with no combat_kill to evict: drop and increment
//     droppedStructuralCount. Expected to stay 0 in a 7-minute round.

import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

export const PLAYTRACE_EVENT_CAP_PER_ROUND = 2000;

// AIState alias — real union defined in S2; string covers all legal values
// until then. The names are the canonical PascalCase strings that appear in
// the wire envelope.
export type AIState =
  | 'Peacetime'
  | 'WarFooting'
  | 'Probing'
  | 'Invading'
  | 'Recovery';

// ---------------------------------------------------------------------------
// SimEvent discriminated union (9 types — CF-P1-005)
// ---------------------------------------------------------------------------

export type SimEvent =
  | {
      tick: number;
      type: 'ai_state_transition';
      payload: {
        colonyId: ColonyId;
        from: AIState;
        to: AIState;
        triggerValues: {
          aiFighterCount: number;
          aiFoodStored: number;
          aiFoodCap: number;
          playerWorkerCount: number;
        };
      };
    }
  | {
      tick: number;
      type: 'invasion_start';
      payload: {
        colonyId: ColonyId;
        rallyTile: { x: number; y: number; grid: 'surface' };
        fighterCount: number;
        targetGrid: ColonyId;
      };
    }
  | {
      tick: number;
      type: 'invasion_end';
      payload: {
        colonyId: ColonyId;
        outcome: 'queen_kill' | 'fighter_rout' | 'timeout';
        attackerLosses: number;
        defenderLosses: number;
      };
    }
  | {
      tick: number;
      type: 'spider_hunt_start';
      payload: {
        reticleTile: { x: number; y: number; grid: 'surface' };
        targetWorkers: number;
      };
    }
  | {
      tick: number;
      type: 'spider_hunt_end';
      payload: { outcome: 'kill' | 'swarm_retreat' | 'scatter'; deaths: number };
    }
  | {
      tick: number;
      type: 'spider_chase_start';
      payload: { targetAntId: number; targetTile: { x: number; y: number } };
    }
  | {
      tick: number;
      type: 'spider_chase_end';
      payload: { outcome: 'kill' | 'escape' | 'leash' | 'retreat' | 'killed' };
    }
  | {
      tick: number;
      type: 'spider_rampage_start';
      payload: { lairTile: { x: number; y: number }; hungerTicks: number };
    }
  | {
      tick: number;
      type: 'spider_rampage_end';
      payload: {
        outcome:
          | 'killed_in_nest'
          | 'killed_by_player'
          | 'killed_by_ai'
          | 'quota_met'
          | 'retreated';
        broodKilled: number;
        queenKilled: boolean;
      };
    }
  | {
      tick: number;
      type: 'queen_death';
      payload: {
        // cause is null in V15 traces (S0b proof-of-concept). S1/S2 will fill
        // this in from the kill-site context when those stages land (RC-P1-003).
        cause:
          | 'InvasionKill'
          | 'SpiderRampage'
          | 'Starvation'
          | 'MutualDestruction'
          | null;
        location: { x: number; y: number; grid: 'surface' | 'underground' };
        aiStateAtTime: AIState | null;
      };
    }
  | {
      // combat_kill is the ONLY evictable (low-priority) event type.
      // The cap policy preferentially drops oldest combat_kills when the
      // buffer is full, preserving structural events.
      tick: number;
      type: 'combat_kill';
      payload: {
        killer: {
          kind: 'Ant' | 'Spider';
          id: number | null;
          colonyId: ColonyId | null;
        };
        victim: {
          kind: 'Ant' | 'Spider' | 'Brood' | 'Queen';
          id: number | null;
          colonyId: ColonyId | null;
        };
        location: { x: number; y: number; grid: 'surface' | 'underground' };
      };
    }
  | {
      // S5 (V22) — tiebreak condition reached (timeout or stalemate).
      // Emitted by checkTiebreaks() in game-over.ts when both queens survive
      // to MATCH_TIMEOUT_TICKS or all food is exhausted below the stalemate
      // threshold. deriveRoundEndReason() reads this to populate the playtrace
      // roundEndReason field.
      tick: number;
      type: 'round_end';
      payload: {
        reason: 'TimeoutTiebreak' | 'StalemateTiebreak';
        playerWorkerCount: number;
        aiWorkerCount: number;
      };
    };

// ---------------------------------------------------------------------------
// Cap enforcement helpers
// ---------------------------------------------------------------------------

function findOldestCombatKillIndex(events: SimEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === 'combat_kill') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// emitEvent — the single write path into world.events
// ---------------------------------------------------------------------------

export function emitEvent(world: WorldState, event: SimEvent): void {
  if (world.events.length < PLAYTRACE_EVENT_CAP_PER_ROUND) {
    world.events.push(event);
    return;
  }
  // Cap reached: evict oldest combat_kill if available, then append new event.
  const evictIdx = findOldestCombatKillIndex(world.events);
  if (evictIdx >= 0) {
    world.events.splice(evictIdx, 1);
    world.events.push(event);
    world.droppedCombatKillCount += 1;
  } else {
    // No combat_kill to evict; structural overflow — hard cap honored.
    world.droppedStructuralCount += 1;
  }
}
