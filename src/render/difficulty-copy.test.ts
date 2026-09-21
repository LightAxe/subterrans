// src/render/difficulty-copy.test.ts
// #304 — the difficulty rows' copy is derived from the sim triplets. Two
// guarantees: (a) every number in a line IS the constant (derivation), and
// (b) the exact wording is pinned, so a balance retune surfaces here as a
// visible string change in review rather than silently rewording the screen.
import { describe, it, expect } from 'vitest';
import {
  difficultyDescription,
  eggIntervalPercent,
  spiderHungerSeconds,
  NEW_GAME_START_LABEL,
  NEW_GAME_SUBTITLE,
} from './difficulty-copy.js';
import { DIFFICULTY_TIERS } from './boot-overlay-layout.js';
import {
  AI_INVADING_FIGHTER_THRESHOLD,
  AI_WARFOOTING_FIGHTER_THRESHOLD,
  QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR,
  SPIDER_HUNGER_THRESHOLD_TICKS,
} from '../sim/constants.js';
import { tierIndex } from '../sim/ai-state.js';
import { MS_PER_TICK } from '../platform/game-loop.js';

describe('difficultyDescription — derived from the sim triplets', () => {
  it('states the egg-interval change as the numerator-over-4 percentage', () => {
    for (const tier of DIFFICULTY_TIERS) {
      const n = QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR[tierIndex(tier)];
      expect(eggIntervalPercent(tier)).toBe(Math.round(((n - 4) / 4) * 100));
    }
    expect(eggIntervalPercent('Easy')).toBe(25);
    expect(eggIntervalPercent('Normal')).toBe(0);
    expect(eggIntervalPercent('Hard')).toBe(-25);
  });

  it('states the spider hunger threshold in seconds at the fixed 20 Hz tick', () => {
    expect(MS_PER_TICK).toBe(50);
    for (const tier of DIFFICULTY_TIERS) {
      const ticks = SPIDER_HUNGER_THRESHOLD_TICKS[tierIndex(tier)];
      expect(spiderHungerSeconds(tier)).toBe((ticks * MS_PER_TICK) / 1000);
    }
  });

  it('every number in a line is the tier constant it describes', () => {
    for (const tier of DIFFICULTY_TIERS) {
      const t = tierIndex(tier);
      const line = difficultyDescription(tier);
      expect(line).toContain(`needs ${AI_WARFOOTING_FIGHTER_THRESHOLD[t]} fighters to arm`);
      expect(line).toContain(`${AI_INVADING_FIGHTER_THRESHOLD[t]} to invade.`);
      expect(line).toContain(`gets hungry ${spiderHungerSeconds(tier)} s after a meal`);
      const pct = eggIntervalPercent(tier);
      if (pct > 0) expect(line).toContain(`${pct}% longer between eggs`);
      else if (pct < 0) expect(line).toContain(`${-pct}% less between eggs`);
      else expect(line).toContain('The reference tuning.');
    }
  });

  it('pins the shipped wording (a retune must change this deliberately)', () => {
    expect(difficultyDescription('Easy')).toBe(
      'Enemy queen waits 25% longer between eggs. Enemy needs 10 fighters to arm, 18 to invade. Spider gets hungry 90 s after a meal.',
    );
    expect(difficultyDescription('Normal')).toBe(
      'The reference tuning. Enemy needs 8 fighters to arm, 15 to invade. Spider gets hungry 60 s after a meal.',
    );
    expect(difficultyDescription('Hard')).toBe(
      'Enemy queen waits 25% less between eggs. Enemy needs 6 fighters to arm, 12 to invade. Spider gets hungry 45 s after a meal.',
    );
  });

  it('keeps each line short enough for two wrapped lines in the row', () => {
    // 12 px monospace in the 490 px description column wraps at ~68 chars; two
    // lines is the row's budget, with slack for the wrap landing mid-word.
    for (const tier of DIFFICULTY_TIERS) {
      expect(difficultyDescription(tier).length).toBeLessThanOrEqual(130);
    }
  });

  it('the fixed strings say what the screen promises', () => {
    expect(NEW_GAME_START_LABEL).toBe('Start game');
    expect(NEW_GAME_SUBTITLE).toContain('your colony plays the same');
  });
});
