// hunger.test.ts — #288 / #290 PR 2 (V50): the shared hunger primitive.
import { describe, it, expect } from 'vitest';
import {
  hungerState,
  LARVA_HUNGER,
  mealsUntilStarvation,
  QUEEN_HUNGER,
  SPIDER_HUNGER,
  ticksSinceMeal,
  type HungerProfile,
} from './hunger.js';
import {
  LARVA_FOOD_PER_TICK,
  QUEEN_FOOD_PER_TICK,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  STARVATION_GRACE_TICKS,
} from './constants.js';
import { createWorldState } from './types.js';

describe('hungerState', () => {
  const p: HungerProfile = { mealIntervalTicks: 10, mealFp: 5, starveAfterTicks: 30 };
  it('is fed before the interval, hungry from it, starving from starve-after', () => {
    expect(hungerState(0, p)).toBe('fed');
    expect(hungerState(9, p)).toBe('fed');
    expect(hungerState(10, p)).toBe('hungry');
    expect(hungerState(29, p)).toBe('hungry');
    expect(hungerState(30, p)).toBe('starving');
    expect(hungerState(1_000_000, p)).toBe('starving');
  });
});

describe('profiles', () => {
  it('queen and larva reproduce the pre-V50 per-tick draw and 300-tick countdown', () => {
    expect(QUEEN_HUNGER).toEqual({
      mealIntervalTicks: 1,
      mealFp: QUEEN_FOOD_PER_TICK,
      starveAfterTicks: STARVATION_GRACE_TICKS,
    });
    expect(LARVA_HUNGER).toEqual({
      mealIntervalTicks: 1,
      mealFp: LARVA_FOOD_PER_TICK,
      starveAfterTicks: STARVATION_GRACE_TICKS,
    });
  });

  it('the spider is hungry exactly at its tier threshold, eats no stored food, never starves', () => {
    for (const tier of [0, 1, 2] as const) {
      const prof = SPIDER_HUNGER[tier];
      const threshold = SPIDER_HUNGER_THRESHOLD_TICKS[tier];
      expect(prof.mealFp).toBe(0);
      // The pre-refactor check was `hungerTicks >= threshold`.
      for (const t of [0, threshold - 1, threshold, threshold + 1, 10 * threshold]) {
        expect(hungerState(t, prof) !== 'fed', `tier ${tier} t ${t}`).toBe(t >= threshold);
      }
      expect(hungerState(0x7ffffffe, prof)).toBe('hungry');
    }
  });
});

describe('ant clock readers', () => {
  it('ticksSinceMeal is world.tick − lastMealTick; mealsUntilStarvation reads between ticks', () => {
    const w = createWorldState(1);
    w.tick = 500;
    w.ants.lastMealTick[3] = 499; // fed on the last simulated tick
    expect(ticksSinceMeal(w, 3)).toBe(1);
    expect(mealsUntilStarvation(w, 3, QUEEN_HUNGER)).toBe(STARVATION_GRACE_TICKS);
    w.ants.lastMealTick[3] = 489; // ten missed meals
    expect(mealsUntilStarvation(w, 3, QUEEN_HUNGER)).toBe(STARVATION_GRACE_TICKS - 10);
  });
});
