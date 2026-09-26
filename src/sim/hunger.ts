// hunger.ts — the shared hunger primitive (#288, #290 PR 2).
//
// Every hungry creature is described by a HungerProfile: how often it wants a
// meal, how big a meal is, and how long after its last meal a failed meal kills
// it. `hungerState` turns "ticks since the last meal" into fed / hungry /
// starving against a profile.
//
// Ants keep their clock in the ant store as `ants.lastMealTick` (the tick of the
// last successful meal). "Ticks since meal" is a difference, not a counter, so an
// ant that is not eating costs no per-tick write, and a threshold retune stays a
// bare constant retune. The spider keeps its own counting clock
// (`spider.hungerTicks`, owner decision D6) but reads its threshold through the
// same `hungerState`, so a future mob reuses one primitive.
//
// Determinism: integers only, no `/`, no allocation, no module-level mutable state.

import type { EntityId, WorldState } from './types.js';
import {
  LARVA_MEAL_FP,
  LARVA_MEAL_INTERVAL_TICKS,
  LARVA_STARVE_AFTER_TICKS,
  QUEEN_MEAL_FP,
  QUEEN_MEAL_INTERVAL_TICKS,
  QUEEN_STARVE_AFTER_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
} from './constants.js';

/** How a kind of creature eats. All values are integers (ticks, fp). */
export interface HungerProfile {
  /** A meal is due once ticks-since-meal reaches this. */
  readonly mealIntervalTicks: number;
  /** Food (fp) one meal draws. 0 for a creature that does not eat stored food. */
  readonly mealFp: number;
  /** A failed meal at or past this many ticks since the last meal is fatal. */
  readonly starveAfterTicks: number;
}

/** 'fed' before a meal is due; 'hungry' once it is; 'starving' once a failed meal would kill. */
export type HungerState = 'fed' | 'hungry' | 'starving';

/** Classify `ticksSinceMeal` against `profile`. Pure; no allocation. */
export function hungerState(ticksSinceMeal: number, profile: HungerProfile): HungerState {
  if (ticksSinceMeal >= profile.starveAfterTicks) return 'starving';
  if (ticksSinceMeal >= profile.mealIntervalTicks) return 'hungry';
  return 'fed';
}

/** The queen: 2 fp every tick; dies 300 ticks after her last meal. */
export const QUEEN_HUNGER: HungerProfile = {
  mealIntervalTicks: QUEEN_MEAL_INTERVAL_TICKS,
  mealFp: QUEEN_MEAL_FP,
  starveAfterTicks: QUEEN_STARVE_AFTER_TICKS,
} as const;

/** A larva: 1 fp every tick; dies 300 ticks after its last meal. */
export const LARVA_HUNGER: HungerProfile = {
  mealIntervalTicks: LARVA_MEAL_INTERVAL_TICKS,
  mealFp: LARVA_MEAL_FP,
  starveAfterTicks: LARVA_STARVE_AFTER_TICKS,
} as const;

/** Largest int32 — "never" for a starve-after that must not fire. */
const NEVER_TICKS = 0x7fffffff;

/**
 * The spider, per difficulty tier [Easy, Normal, Hard]: hungry (starts hunting)
 * at SPIDER_HUNGER_THRESHOLD_TICKS[tier]; it eats only its kills (no stored
 * food) and never starves.
 */
export const SPIDER_HUNGER: readonly [HungerProfile, HungerProfile, HungerProfile] = [
  { mealIntervalTicks: SPIDER_HUNGER_THRESHOLD_TICKS[0], mealFp: 0, starveAfterTicks: NEVER_TICKS },
  { mealIntervalTicks: SPIDER_HUNGER_THRESHOLD_TICKS[1], mealFp: 0, starveAfterTicks: NEVER_TICKS },
  { mealIntervalTicks: SPIDER_HUNGER_THRESHOLD_TICKS[2], mealFp: 0, starveAfterTicks: NEVER_TICKS },
] as const;

/**
 * Ticks since ant `id` last ate, as the CURRENT tick's consumption step sees it
 * (`world.tick − lastMealTick`). Inside `tick()` world.tick is the tick being
 * simulated: an ant fed on the previous tick reads 1.
 */
export function ticksSinceMeal(world: WorldState, id: EntityId): number {
  return world.tick - world.ants.lastMealTick[id]!;
}

/**
 * Between ticks (render, save dialog, tooling): how many more failed meals ant
 * `id` survives, i.e. the pre-V50 starvation countdown. `profile.starveAfterTicks`
 * right after a meal, one less per missed meal, 0 at death. Between ticks,
 * world.tick is the NEXT tick to simulate, so the last consumption step ran at
 * world.tick − 1.
 */
export function mealsUntilStarvation(
  world: WorldState,
  id: EntityId,
  profile: HungerProfile,
): number {
  return profile.starveAfterTicks - (world.tick - 1 - world.ants.lastMealTick[id]!);
}
