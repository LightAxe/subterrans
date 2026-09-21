// src/render/difficulty-copy.ts
// #304 — the new-game screen's strings, and the plain-language line each
// difficulty row shows about what that tier changes.
//
// The numbers in those lines are DERIVED from the sim's [Easy, Normal, Hard]
// triplets in src/sim/constants.ts (via the same tierIndex the sim reads them
// with), not typed in by hand, so the copy cannot drift from what the sim does.
// A balance retune shows up here as a changed string — difficulty-copy.test.ts
// pins the current wording so that change is visible in review, not silent.
//
// What a tier changes (everything else, including the player's own colony, is
// identical at every tier):
//   - the AI queen's egg interval          QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR
//   - the fighter count for WarFooting     AI_WARFOOTING_FIGHTER_THRESHOLD
//   - the fighter count for Invading       AI_INVADING_FIGHTER_THRESHOLD
//   - how soon after eating the spider     SPIDER_HUNGER_THRESHOLD_TICKS
//     becomes Hungry and hunts again
// (AI_RECOVERY_DURATION_TICKS and SPIDER_HUNGER_MAX_TICKS are per-tier too, but
// the former is identical at every tier and the latter is only read by the
// render layer, as the spider hunger bar's denominator — neither is a
// differentiator a player picks a tier for, so neither is in the line.)
//
// The fighter counts are NECESSARY, not sufficient — WarFooting and Invading
// also want a food-stock fraction and a minimum age (ai-state.ts) — so the line
// says "needs N fighters to …", not "attacks at N".
//
// Pure TypeScript, no Phaser: importable from Vitest.

import {
  AI_INVADING_FIGHTER_THRESHOLD,
  AI_WARFOOTING_FIGHTER_THRESHOLD,
  QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR,
  SPIDER_HUNGER_THRESHOLD_TICKS,
} from '../sim/constants.js';
import { tierIndex } from '../sim/ai-state.js';
import { MS_PER_TICK } from '../platform/game-loop.js';
import type { Difficulty } from './boot-overlay-layout.js';

export const NEW_GAME_TITLE = 'New Game';
export const NEW_GAME_SUBTITLE =
  'Only the enemy colony and the spider change — your colony plays the same at every tier.';
export const NEW_GAME_DIFFICULTY_CAPTION = 'Difficulty';
export const NEW_GAME_START_LABEL = 'Start game';
export const NEW_GAME_START_HINT = 'Enter also starts';

/** The egg-interval scale is applied as `(interval * numerator) >> 2` in
 *  scenario.ts — a fixed denominator of 4. Normal's numerator is 4 (×1.0). */
const EGG_INTERVAL_DENOMINATOR = 4;

/** Signed percentage change to the AI queen's egg interval at `tier`, relative
 *  to Normal: +25 at Easy (×1.25, slower breeding), 0 at Normal, −25 at Hard. */
export function eggIntervalPercent(tier: Difficulty): number {
  const numerator = QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR[tierIndex(tier)];
  return Math.round(((numerator - EGG_INTERVAL_DENOMINATOR) / EGG_INTERVAL_DENOMINATOR) * 100);
}

/** Seconds after its last meal before the spider becomes Hungry at `tier`
 *  (SPIDER_HUNGER_THRESHOLD_TICKS at the fixed 20 Hz tick rate). */
export function spiderHungerSeconds(tier: Difficulty): number {
  return (SPIDER_HUNGER_THRESHOLD_TICKS[tierIndex(tier)] * MS_PER_TICK) / 1000;
}

/** The one-line, plain-language description shown on `tier`'s row. */
export function difficultyDescription(tier: Difficulty): string {
  const t = tierIndex(tier);
  const pct = eggIntervalPercent(tier);
  const eggs =
    pct > 0
      ? `Enemy queen waits ${pct}% longer between eggs.`
      : pct < 0
        ? `Enemy queen waits ${-pct}% less between eggs.`
        : 'The reference tuning.';
  const army = `Enemy needs ${AI_WARFOOTING_FIGHTER_THRESHOLD[t]} fighters to arm, ${AI_INVADING_FIGHTER_THRESHOLD[t]} to invade.`;
  const spider = `Spider hunts ${spiderHungerSeconds(tier)} s after eating.`;
  return `${eggs} ${army} ${spider}`;
}
