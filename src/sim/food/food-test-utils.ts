// src/sim/food/food-test-utils.ts — test/bench-only food setters (#290 PR 1).
//
// Tests and benches sometimes need a colony holding an exact amount of food,
// including amounts the deposit paths would cap (e.g. an over-cap pool that keeps
// a benchmark queen fed), or a bare synthetic pile. These helpers write the storage directly, bypassing
// the facade's caps and flow-field bookkeeping, so they live apart from
// `food-api.ts` and are NOT re-exported anywhere. Never import this from a tick
// path. PR 2 re-implements it over the located food store.

import type { WorldState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';
import { ChamberType } from '../enums.js';

/**
 * Set the colony's entrance pool to `poolFp` and, when `stockFp` is given, its
 * FoodStorage chambers' stock in `colony.chambers` order (the i-th FoodStorage
 * chamber gets `stockFp[i]`; chambers beyond the list are left as they are).
 * No caps, no dirty flags.
 */
export function setColonyFoodForTest(
  world: WorldState,
  colony: ColonyRecord,
  poolFp: number,
  stockFp: readonly number[] = [],
): void {
  void world;
  colony.foodStored = poolFp;
  let k = 0;
  for (let i = 0; i < colony.chambers.length && k < stockFp.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType !== ChamberType.FoodStorage) continue;
    ch.foodStored = stockFp[k]!;
    k += 1;
  }
}

/**
 * Push a synthetic natural pile at tile (0, 0) holding `pickupsRemaining` pickups
 * (initial = remaining, or 1 for an empty pile so the save invariant holds) and
 * return its slot plus the stored record. Id is 90_000 + slot. Direct storage
 * write: no hard cap, no dirty flags.
 */
export function pushTestPile(
  world: WorldState,
  pickupsRemaining: number,
): { slot: number; pile: WorldState['foodPiles'][number] } {
  const pile = {
    foodPileId: 90_000 + world.foodPiles.length,
    tileX: 0,
    tileY: 0,
    pickupsRemaining,
    pickupsInitial: pickupsRemaining > 0 ? pickupsRemaining : 1,
  };
  world.foodPiles.push(pile);
  return { slot: world.foodPiles.length - 1, pile };
}
