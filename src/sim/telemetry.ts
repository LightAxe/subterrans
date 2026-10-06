// telemetry.ts — S0b: SimEvent discriminated union, emitEvent helper,
// and cap enforcement (ADR-0013 v2 / D-31 / D-34).
//
// This is a SIM-SIDE module (src/sim/). It mutates WorldState.events and
// the two overflow counters. Render-side code must NOT import emitEvent;
// instead it calls narrow sim helpers (e.g. transitionAIState in S2)
// that perform both the state mutation and the event emission atomically.
//
// Cap policy (D-34; #388):
//   - Hard cap: WorldState.events never exceeds PLAYTRACE_EVENT_CAP_PER_ROUND.
//   - New event over cap: evict the oldest combat_kill (lowest priority), append
//     the new one, increment droppedCombatKillCount.
//   - Over cap with no combat_kill to evict: increment droppedStructuralCount —
//     one event is lost; it counts there whatever its type, as it always has, so
//     it includes a new combat_kill dropped in this state. A new combat_kill is
//     dropped; any other new event evicts the OLDEST non-terminal structural
//     event and is appended. Terminal events (isTerminalEvent: queen_death and
//     round_end, which the end screen and the playtrace's roundEndReason read) are
//     never evicted. So in live play — at most one terminal event per colony
//     before the game loop stops on the outcome — the event that ends a match is
//     always recorded, and so is the latest invasion_start / spider_rampage_start
//     the render layer warns on. Only a buffer holding nothing but terminal
//     events drops the new one (a harness that keeps ticking past a stalemate
//     gets a round_end every tick).
//   The overflow was expected to stay 0 in a round of 20 minutes or less; from
//   V67 (#376) a round has no time limit, and one that runs for hours fills the
//   buffer with structural events.
//
// #388 — before it, the no-combat_kill case dropped the NEW event, so after a
// few hours of play the queen_death that ended the match was lost (no cause or
// narrative on the end screen, a null roundEndReason) and the invasion / rampage
// warnings went quiet.
// What the new rule keeps changes only which events are in the buffer: which
// branch an emit takes depends only on the buffer's length and on whether it
// holds a combat_kill, and the new path runs only when it holds none, keeps the
// length, and appends only a non-combat_kill — so the length, the combat_kill
// count and both saved counters stay exactly what the old rule gave at every emit
// (telemetry.test.ts checks it against the old rule). world.events itself is
// never saved (serializeWorldState skips it, so it is not in hashWorldState) and
// nothing in src/sim or the AI controller reads it — so no simVersion gate.
// What the buffer holds after an overflow: with only combat_kills lost, every
// other event plus the latest kills (unchanged); once a structural event has
// been lost, the terminal events plus the latest non-kill events, and no kills
// from then on (before #388: the first non-kill events).

import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

export const PLAYTRACE_EVENT_CAP_PER_ROUND = 2000;

// AIState alias — real union defined in S2; string covers all legal values
// until then. The names are the canonical PascalCase strings that appear in
// the wire envelope.
export type AIState = 'Peacetime' | 'WarFooting' | 'Probing' | 'Invading' | 'Recovery';

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
          /** The worker count the frontage check compares with: the AI's opponent's
           *  (the player's in real play; the enemy's for a player-colony AI from
           *  V56, #347). The wire name is kept for the playtrace schema. */
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
      payload: { outcome: 'kill' | 'escape' | 'leash' | 'retreat' | 'killed' | 'lost' };
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
        outcome: 'killed_in_nest' | 'killed_by_player' | 'killed_by_ai' | 'quota_met' | 'retreated';
        broodKilled: number;
        queenKilled: boolean;
      };
    }
  | {
      tick: number;
      type: 'spider_feed_start';
      payload: { killTile: { x: number; y: number } };
    }
  | {
      tick: number;
      type: 'spider_feed_end';
      payload: { outcome: 'healed' | 'interrupted' };
    }
  | {
      tick: number;
      type: 'queen_death';
      payload: {
        // cause is null in V15 traces (S0b proof-of-concept). S1/S2 will fill
        // this in from the kill-site context when those stages land (RC-P1-003).
        cause: 'InvasionKill' | 'SpiderRampage' | 'Starvation' | 'MutualDestruction' | null;
        location: { x: number; y: number; grid: 'surface' | 'underground' };
        aiStateAtTime: AIState | null;
      };
    }
  | {
      // combat_kill is the lowest-priority event: at the cap the oldest one is
      // evicted first; with none buffered the oldest non-terminal structural
      // event is evicted instead (#388), and a new combat_kill is dropped.
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
      // S5 (V22) — tiebreak condition reached. Emitted by checkTiebreaks() in
      // game-over.ts when all food is exhausted below the stalemate threshold.
      // 'TimeoutTiebreak' is no longer emitted: #376 (V67) removed the 24 000-tick
      // match timeout, and #408 reaped its gate. It stays in the union because the
      // playtrace wire enum (RoundEndReason) and the end-screen copy still name it.
      // deriveRoundEndReason() reads this to populate the playtrace
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

/**
 * #388 — a terminal event states how a match ended: the end screen reads the
 * queen_death (its cause) and a round_end (a tiebreak's narrative), and the
 * playtrace's roundEndReason is derived from them. emitEvent never evicts one.
 */
export function isTerminalEvent(event: SimEvent): boolean {
  return event.type === 'queen_death' || event.type === 'round_end';
}

function findOldestCombatKillIndex(events: SimEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === 'combat_kill') return i;
  }
  return -1;
}

/** Oldest event that is neither a combat_kill nor terminal; -1 if none. */
function findOldestEvictableStructuralIndex(events: SimEvent[]): number {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type !== 'combat_kill' && !isTerminalEvent(ev)) return i;
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
    return;
  }
  // No combat_kill to evict: one event is lost (counted as structural, as it
  // always was) — hard cap honored. #388: keep the NEW event (unless it is a
  // combat_kill) and lose the oldest non-terminal structural one instead, so a
  // match's terminal event and the latest warnings survive. Same counts either
  // way (see the header).
  world.droppedStructuralCount += 1;
  if (event.type === 'combat_kill') return;
  const structuralIdx = findOldestEvictableStructuralIndex(world.events);
  if (structuralIdx < 0) return; // nothing but terminal events: drop the new one
  world.events.splice(structuralIdx, 1);
  world.events.push(event);
}
