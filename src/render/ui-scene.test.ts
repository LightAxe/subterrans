// ui-scene.test.ts — unit tests for pure-logic helpers extracted from UIScene.
//
// Scope: pure functions only (no Phaser scene booting).
// Overlay rendering and interaction (Phaser-coupled) is covered by Plan 07 Playwright.
//
// Helpers under test (exported from ui-scene.ts):
//   - formatOutcomeTitle(outcome): { text: string; color: number }
//   - formatKillStatsSubtitle(killCount): string
//   - formatCauseSubtitle(outcome, cause): string

import { describe, it, expect } from 'vitest';
import {
  formatOutcomeTitle,
  formatKillStatsSubtitle,
  formatCauseSubtitle,
} from './ui-scene-logic.js';
import { GameOutcome } from '../sim/game-over.js';

// ---------------------------------------------------------------------------
// formatOutcomeTitle
// ---------------------------------------------------------------------------

describe('formatOutcomeTitle', () => {
  it('Victory returns green text', () => {
    const result = formatOutcomeTitle(GameOutcome.Victory);
    expect(result.text).toBe('VICTORY');
    expect(result.color).toBe(0x00ff00);
  });

  it('Defeat returns red text', () => {
    const result = formatOutcomeTitle(GameOutcome.Defeat);
    expect(result.text).toBe('DEFEAT');
    expect(result.color).toBe(0xff0000);
  });

  it('MutualDestruction returns orange/yellow text', () => {
    const result = formatOutcomeTitle(GameOutcome.MutualDestruction);
    expect(result.text).toBe('MUTUAL DESTRUCTION');
    expect(result.color).toBe(0xffaa00);
  });

  it('None returns empty text graceful fallback', () => {
    const result = formatOutcomeTitle(GameOutcome.None);
    expect(result.text).toBe('');
    expect(result.color).toBe(0x000000);
  });
});

// ---------------------------------------------------------------------------
// formatKillStatsSubtitle
// ---------------------------------------------------------------------------

describe('formatKillStatsSubtitle', () => {
  it('killCount=0 returns "Your colony killed 0 enemies"', () => {
    expect(formatKillStatsSubtitle(0)).toBe('Your colony killed 0 enemies');
  });

  it('killCount=1 returns singular "enemy"', () => {
    expect(formatKillStatsSubtitle(1)).toBe('Your colony killed 1 enemy');
  });

  it('killCount=2 returns plural "enemies"', () => {
    expect(formatKillStatsSubtitle(2)).toBe('Your colony killed 2 enemies');
  });

  it('killCount=100 returns plural "enemies"', () => {
    expect(formatKillStatsSubtitle(100)).toBe('Your colony killed 100 enemies');
  });
});

// ---------------------------------------------------------------------------
// formatCauseSubtitle
// ---------------------------------------------------------------------------

describe('formatCauseSubtitle — Victory', () => {
  it('InvasionKill: your fighters killed their queen', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, 'InvasionKill')).toBe(
      'Your fighters killed their queen',
    );
  });

  it('Starvation: their queen starved', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, 'Starvation')).toBe('Their queen starved');
  });

  it('SpiderRampage: their queen killed by spider', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, 'SpiderRampage')).toBe(
      'Their queen was killed by a spider',
    );
  });

  it('null cause returns empty string', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, null)).toBe('');
  });
});

describe('formatCauseSubtitle — Defeat', () => {
  it('InvasionKill: your queen killed by enemy', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, 'InvasionKill')).toBe(
      'Your queen was killed by the enemy',
    );
  });

  it('Starvation: your queen starved', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, 'Starvation')).toBe('Your queen starved');
  });

  it('SpiderRampage: your queen killed by spider', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, 'SpiderRampage')).toBe(
      'Your queen was killed by a spider',
    );
  });

  it('null cause returns empty string', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, null)).toBe('');
  });
});

describe('formatCauseSubtitle — MutualDestruction', () => {
  it('always returns both-queens message regardless of cause', () => {
    expect(formatCauseSubtitle(GameOutcome.MutualDestruction, 'MutualDestruction')).toBe(
      'Both queens died at the same time',
    );
    expect(formatCauseSubtitle(GameOutcome.MutualDestruction, null)).toBe(
      'Both queens died at the same time',
    );
  });
});

describe('formatCauseSubtitle — None', () => {
  it('returns empty string', () => {
    expect(formatCauseSubtitle(GameOutcome.None, null)).toBe('');
  });
});
