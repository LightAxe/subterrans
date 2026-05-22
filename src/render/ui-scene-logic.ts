// ui-scene-logic.ts — Pure helpers extracted from UIScene for testability.
//
// These functions have no Phaser dependency and can be unit-tested under Node (Vitest).
// UIScene imports and uses these; Plan 07 covers Phaser-coupled integration via Playwright.

import { GameOutcome } from '../sim/game-over.js';

// queen_death cause values from sim/telemetry.ts — duplicated here to avoid a
// Phaser-free module importing from the sim telemetry bundle.
export type QueenDeathCause =
  | 'InvasionKill'
  | 'SpiderRampage'
  | 'Starvation'
  | 'MutualDestruction'
  | null;

// ---------------------------------------------------------------------------
// formatOutcomeTitle — maps GameOutcome to display text + color
// ---------------------------------------------------------------------------

/**
 * Returns the overlay title text and hex color for a given GameOutcome.
 * Used by UIScene to configure the GameOver overlay text.
 */
export function formatOutcomeTitle(outcome: GameOutcome): { text: string; color: number } {
  switch (outcome) {
    case GameOutcome.Victory:           return { text: 'VICTORY',           color: 0x00ff00 };
    case GameOutcome.Defeat:            return { text: 'DEFEAT',             color: 0xff0000 };
    case GameOutcome.MutualDestruction: return { text: 'MUTUAL DESTRUCTION', color: 0xffaa00 };
    case GameOutcome.None:
    default:                            return { text: '',                   color: 0x000000 };
  }
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
// formatCauseSubtitle — why the relevant queen died
// ---------------------------------------------------------------------------

/**
 * Returns a one-line explanation of why the game ended (the losing/winning queen's
 * death cause). Returns '' when no cause is available (pre-V16 saves or unknown).
 */
export function formatCauseSubtitle(outcome: GameOutcome, cause: QueenDeathCause): string {
  switch (outcome) {
    case GameOutcome.Victory:
      switch (cause) {
        case 'InvasionKill':  return 'Your fighters killed their queen';
        case 'Starvation':    return 'Their queen starved';
        case 'SpiderRampage': return 'Their queen was killed by a spider';
        default:              return '';
      }
    case GameOutcome.Defeat:
      switch (cause) {
        case 'InvasionKill':  return 'Your queen was killed by the enemy';
        case 'Starvation':    return 'Your queen starved';
        case 'SpiderRampage': return 'Your queen was killed by a spider';
        default:              return '';
      }
    case GameOutcome.MutualDestruction:
      return 'Both queens died at the same time';
    default:
      return '';
  }
}
