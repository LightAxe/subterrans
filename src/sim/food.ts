// food.ts — food-pile id alias and the depletion record (PRD §6a).
//
// Food piles are surface food sources. Issue #112 made them depleting + spawning
// (tickFoodPileSpawn places new piles over time). Since #290 PR 2 (V50) a pile is
// a `Pile` record in the located food store (`food/food-store.ts`), read and
// written through the food facade (`food/food-api.ts`); its per-colony priority
// mark lives on ColonyRecord.priorityFoodPileId.
//
// This module is data-only: no mutation helpers, no tick logic.
//
// Compatible with Node --experimental-strip-types (no const enum, no enums).

// ---------------------------------------------------------------------------
// FoodPileId — integer alias for readability (PRD §6a)
// ---------------------------------------------------------------------------

export type FoodPileId = number;

// ---------------------------------------------------------------------------
// DepletionRecord — entry in WorldState.recentlyDepletedFood (issue #112)
//
// Bounded ring-buffer-style array (cap = FOOD_PILE_SOFT_CEILING, oldest
// shifted on append). Used by `tickFoodPileSpawn` to reject placement near
// recently-vanished piles, preventing jarring "pile reappeared where one
// just disappeared" teleports while pheromone trails are still decaying.
//
// `tick` is the world.tick at the moment of depletion. Spawn-time pruning
// drops entries older than FOOD_PILE_RECENT_DEPLETION_TICKS.
// ---------------------------------------------------------------------------

export interface DepletionRecord {
  tick: number;
  tileX: number;
  tileY: number;
}
