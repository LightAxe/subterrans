// ui-scene-logic.ts — Pure helpers extracted from UIScene (and, for
// queenDeathCauseAt and roundEndReasonAt, GameScene) for testability.
//
// These functions have no Phaser dependency and can be unit-tested under Node (Vitest).
// UIScene / GameScene import and use these; Plan 07 covers Phaser-coupled integration
// via Playwright.

import { GameOutcome } from '../sim/game-over.js';
import type { SimEvent } from '../sim/telemetry.js';
import { SIM_VERSION_V67_NO_MATCH_TIMEOUT, type WorldState } from '../sim/types.js';
import { MATCH_TIMEOUT_TICKS } from '../sim/constants.js';
import { isAlive } from '../sim/ant/ant-store.js';
import type { RoundEndReason } from './playtrace-upload.js';

// queen_death cause values, from the sim/telemetry.ts event type.
export type QueenDeathCause = Extract<SimEvent, { type: 'queen_death' }>['payload']['cause'];

// ---------------------------------------------------------------------------
// formatOutcomeTitle — maps GameOutcome to display text + color
// ---------------------------------------------------------------------------

/**
 * Returns the overlay title text and hex color for a given GameOutcome.
 * Used by UIScene to configure the GameOver overlay text.
 */
export function formatOutcomeTitle(outcome: GameOutcome): { text: string; color: number } {
  switch (outcome) {
    case GameOutcome.Victory:
      return { text: 'VICTORY', color: 0x00ff00 };
    case GameOutcome.Defeat:
      return { text: 'DEFEAT', color: 0xff0000 };
    case GameOutcome.MutualDestruction:
      return { text: 'MUTUAL DESTRUCTION', color: 0xffaa00 };
    case GameOutcome.None:
    default:
      return { text: '', color: 0x000000 };
  }
}

// ---------------------------------------------------------------------------
// queenDeathCauseAt — the cause the end screen names (survey line; GameOver fallback)
// ---------------------------------------------------------------------------

/**
 * The cause of the queen death that ended the match: the first `queen_death` event
 * emitted on `deathTick` (the tick() that returned the outcome — world.tick − 1
 * once it has returned). checkQueenDeath adds the player's queen to the dead
 * first, so her event comes before the enemy's: Defeat gives the player's cause,
 * Victory the enemy's. The tick filter keeps a stale event from an earlier tick
 * from matching. null when there is no such event — a tiebreak ended the match,
 * the forceGameOver dev seam, or a buffer holding nothing but terminal events
 * (before #388 also any match long enough to fill the buffer with structural
 * events) — or when its cause is null (an unattributed kill, pre-V16 events).
 */
export function queenDeathCauseAt(events: readonly SimEvent[], deathTick: number): QueenDeathCause {
  for (const ev of events) {
    if (ev.type === 'queen_death' && ev.tick === deathTick) return ev.payload.cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// roundEndReasonAt — how the match ended, for the end screen's cause line (#389)
// ---------------------------------------------------------------------------

/**
 * #389 — how the match that ended on `deathTick` ended: a queen death or a
 * tiebreak (the playtrace's RoundEndReason). The terminal event emitted on that
 * tick says so — a round_end names its tiebreak, a queen_death a queen death. A
 * round_end wins, as in the playtrace's deriveRoundEndReason (with two colonies
 * the two never share a tick: checkTiebreaks runs only while both queens live).
 *
 * Without one (an event buffer that lost it, as one could before #388), the world
 * still tells: a dead queen means a queen death. With every queen alive only a
 * tiebreak ends a match — the timeout when checkTiebreaks' timeout test held on
 * that tick (worlds before V67 only, #376), otherwise the stalemate, which the
 * sim always ends as a draw. null when even that cannot say: every queen alive
 * and an outcome no tiebreak gives (the forceGameOver dev seam's Defeat).
 */
export function roundEndReasonAt(
  world: Pick<WorldState, 'events' | 'colonies' | 'ants' | 'simVersion'>,
  deathTick: number,
  outcome: GameOutcome,
): RoundEndReason | null {
  for (const ev of world.events) {
    if (ev.tick === deathTick && ev.type === 'round_end') return ev.payload.reason;
  }
  for (const ev of world.events) {
    if (ev.tick === deathTick && ev.type === 'queen_death') return 'QueenDeath';
  }
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[Number(key)];
    if (colony !== undefined && !isAlive(world.ants, colony.queenEntityId)) return 'QueenDeath';
  }
  if (world.simVersion < SIM_VERSION_V67_NO_MATCH_TIMEOUT && deathTick >= MATCH_TIMEOUT_TICKS) {
    return 'TimeoutTiebreak';
  }
  return outcome === GameOutcome.MutualDestruction ? 'StalemateTiebreak' : null;
}

// ---------------------------------------------------------------------------
// formatKillStatsSubtitle — singular/plural kill count text
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable kill stats string for the GameOver overlay subtitle.
 * Singular: "1 enemy"; plural: "0 enemies", "2+ enemies".
 */
export function formatKillStatsSubtitle(killCount: number): string {
  const noun = killCount === 1 ? 'enemy' : 'enemies';
  return `Your colony killed ${killCount} ${noun}`;
}

// ---------------------------------------------------------------------------
// formatCauseSubtitle — why the game ended
// ---------------------------------------------------------------------------

/**
 * Returns a one-line explanation of why the game ended: the tiebreak that ended
 * it, or the death cause of the queen whose death did. `reason` is
 * roundEndReasonAt's: #389 — a draw is not always a double queen death (a
 * stalemate ends one with both queens alive), so the draw line comes from the
 * reason, never from the outcome alone. Returns '' when it cannot say what
 * happened (an unknown or unattributed cause, or — for a draw — an unknown reason).
 */
export function formatCauseSubtitle(
  outcome: GameOutcome,
  cause: QueenDeathCause,
  reason: RoundEndReason | null,
): string {
  if (reason === 'StalemateTiebreak') {
    // No food left on the map and both colonies starving; the sim ends every
    // stalemate as a draw (checkTiebreaks), so any other outcome has no true line.
    return outcome === GameOutcome.MutualDestruction
      ? 'Both colonies ran out of food — a draw'
      : '';
  }
  if (reason === 'TimeoutTiebreak') {
    // Worlds before V67 only (#376): both queens alive at the match time cap,
    // decided by living worker count.
    switch (outcome) {
      case GameOutcome.Victory:
        return 'Time ran out — your colony had more workers';
      case GameOutcome.Defeat:
        return 'Time ran out — the enemy had more workers';
      case GameOutcome.MutualDestruction:
        return 'Time ran out — the colonies were evenly matched';
      default:
        return '';
    }
  }
  switch (outcome) {
    case GameOutcome.Victory:
      switch (cause) {
        case 'InvasionKill':
          return 'Your fighters killed their queen';
        case 'Starvation':
          return 'Their queen starved';
        case 'SpiderRampage':
          return 'Their queen was killed by a spider';
        default:
          return '';
      }
    case GameOutcome.Defeat:
      switch (cause) {
        case 'InvasionKill':
          return 'Your queen was killed by the enemy';
        case 'Starvation':
          return 'Your queen starved';
        case 'SpiderRampage':
          return 'Your queen was killed by a spider';
        default:
          return '';
      }
    case GameOutcome.MutualDestruction:
      // Only a queen death means both queens died (#389).
      return reason === 'QueenDeath' ? 'Both queens died at the same time' : '';
    default:
      return '';
  }
}
