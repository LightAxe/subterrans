// food.ts — PRD §6a FoodPile data interface
//
// FoodPiles are surface food sources. Issue #112 made them depleting + spawning
// (pickupsRemaining/pickupsInitial added; tickFoodPileSpawn places new piles
// over time). Pre-#112 piles were infinite per SURF-02; the SURF-02 contract
// is now tightened: piles exist for a finite number of pickup-charges.
//
// This module is data-only: no mutation helpers, no tick logic.
//
// Compatible with Node --experimental-strip-types (no const enum, no enums).

// ---------------------------------------------------------------------------
// FoodPileId — integer alias for readability (PRD §6a)
// ---------------------------------------------------------------------------

export type FoodPileId = number;

// ---------------------------------------------------------------------------
// FoodPile — surface food source (PRD §6a, SURF-02 + issue #112 depletion)
//
// Priority-target state lives per-colony on ColonyRecord.priorityFoodPileId —
// food piles themselves are shared surface resources with no owner, so the
// "mark" is not a property of the pile.
// ---------------------------------------------------------------------------

export interface FoodPile {
  foodPileId: FoodPileId;
  tileX: number;
  tileY: number;

  /**
   * Issue #112 — Pickup-charges remaining on this pile. Each successful
   * `antPickupFood` call decrements by FOOD_PILE_PICKUP_DRAIN. When this
   * hits 0 the pile is spliced out of `world.foodPiles` and recorded in
   * `world.recentlyDepletedFood`. Live piles always have `pickupsRemaining > 0`
   * (the validator rejects 0 in saved piles).
   *
   * Distinct from the fixed-point food *quantity* transferred per pickup
   * (FOOD_PICKUP_AMOUNT) — pickups control pile longevity, food carry stays
   * the existing per-ant mechanic.
   */
  pickupsRemaining: number;

  /**
   * Issue #112 — Pickup-charges this pile started with. Captured at creation
   * (scenario seeding or `tickFoodPileSpawn`) and never mutated. Used by the
   * render layer to bucket shrinkage relative to the pile's own starting
   * size, so a small ephemeral pile and a large strategic anchor both
   * visibly shrink across their lifetime rather than the small one always
   * appearing depleted from birth.
   */
  pickupsInitial: number;
}

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
