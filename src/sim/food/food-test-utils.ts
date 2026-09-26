// src/sim/food/food-test-utils.ts — test/bench-only food setters (#290).
//
// Tests and benches sometimes need a colony holding an exact amount of food,
// including amounts the deposit paths would cap (e.g. an over-cap pool that keeps
// a benchmark queen fed), a hand-placed pile, or an ant a given number of meals
// from starvation. These helpers write the located food store (`world.food`) and
// the hunger clock directly, bypassing the facade's caps and flow-field
// bookkeeping, so they live apart from `food-api.ts` and are NOT re-exported
// anywhere. Never import this from a tick path.

import type { EntityId, WorldState } from '../types.js';
import type { ChamberRecord, ColonyRecord } from '../colony/colony-store.js';
import type { FoodPileId } from '../food.js';
import { ChamberType } from '../enums.js';
import { FOOD_PICKUP_AMOUNT } from '../constants.js';
import type { HungerProfile } from '../hunger.js';
import { createChamberStock, createColonyPool, FOOD_FLAG_CORPSE } from './food-api.js';
import { clearFoodSlot, FoodKind, rebuildSurfacePileAt } from './food-store.js';

/**
 * Give `colony` a pool if it has none (a hand-built test colony: createColonyRecord
 * leaves `poolSlot` −1; createScenario creates the pool). The pool sits at the
 * colony's first entrance column, or (0, 0).
 */
export function ensureColonyPoolForTest(world: WorldState, colony: ColonyRecord): void {
  if (colony.poolSlot >= 0) return;
  const e = colony.entrances?.[0];
  if (!createColonyPool(world, colony, e ? e.surfaceTileX : 0, 0)) {
    throw new Error('food store full');
  }
}

/** Give a FoodStorage chamber its stock if it has none (hand-built test chambers). */
export function ensureChamberStockForTest(
  world: WorldState,
  colony: ColonyRecord,
  ch: ChamberRecord,
): void {
  if (ch.chamberType !== ChamberType.FoodStorage || ch.foodSlot >= 0) return;
  if (!createChamberStock(world, colony, ch)) throw new Error('food store full');
}

/** A ChamberRecord literal as tests write it: `foodSlot` optional (the helper links it). */
export type TestChamber = Omit<ChamberRecord, 'foodSlot'> & { foodSlot?: number };

/**
 * Append a chamber to `colony.chambers` (as `checkPendingChambers` would) and,
 * for a FoodStorage chamber, create its stock holding `stockFp`. Returns the
 * stored record.
 */
export function addChamberForTest(
  world: WorldState,
  colony: ColonyRecord,
  chamber: TestChamber,
  stockFp = 0,
): ChamberRecord {
  const ch: ChamberRecord = { ...chamber, foodSlot: -1 };
  colony.chambers.push(ch);
  ensureChamberStockForTest(world, colony, ch);
  if (ch.foodSlot >= 0) world.food.amountFp[ch.foodSlot] = stockFp;
  return ch;
}

/** Set the colony's entrance pool to `poolFp` (no cap; creates the pool if missing). */
export function setPoolFoodForTest(world: WorldState, colony: ColonyRecord, poolFp: number): void {
  ensureColonyPoolForTest(world, colony);
  world.food.amountFp[colony.poolSlot] = poolFp;
}

/** Set one FoodStorage chamber's stock to `fp` (no cap; creates the stock if missing). */
export function setChamberStockForTest(
  world: WorldState,
  colony: ColonyRecord,
  ch: ChamberRecord,
  fp: number,
): void {
  ensureChamberStockForTest(world, colony, ch);
  if (ch.foodSlot < 0) throw new Error('not a FoodStorage chamber');
  world.food.amountFp[ch.foodSlot] = fp;
}

/**
 * Set the colony's entrance pool to `poolFp` and, when `stockFp` is given, its
 * FoodStorage chambers' stock in `colony.chambers` order (the i-th FoodStorage
 * chamber gets `stockFp[i]`; chambers beyond the list are left as they are).
 * No caps, no dirty flags. Creates a missing pool / stock.
 */
export function setColonyFoodForTest(
  world: WorldState,
  colony: ColonyRecord,
  poolFp: number,
  stockFp: readonly number[] = [],
): void {
  setPoolFoodForTest(world, colony, poolFp);
  let k = 0;
  for (let i = 0; i < colony.chambers.length && k < stockFp.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType !== ChamberType.FoodStorage) continue;
    setChamberStockForTest(world, colony, ch, stockFp[k]!);
    k += 1;
  }
}

/** A food pile in the pre-V50 shape (pickup-charges), as tests describe one. */
export interface TestPile {
  foodPileId: FoodPileId;
  tileX: number;
  tileY: number;
  pickupsRemaining: number;
  pickupsInitial: number;
  isCorpse?: boolean;
}

/**
 * Append a pile (last in creation order). Unlike `spawnPile` it takes any
 * charges (including ones the save would reject) and ignores the hard cap and
 * tile uniqueness. Returns the slot.
 */
export function addPileForTest(world: WorldState, pile: TestPile): number {
  const store = world.food;
  let slot = -1;
  for (let s = 0; s < store.kind.length; s++) {
    if (store.kind[s] === FoodKind.None) {
      slot = s;
      break;
    }
  }
  if (slot < 0) throw new Error('food store full');
  store.kind[slot] = FoodKind.Pile;
  store.tileX[slot] = pile.tileX;
  store.tileY[slot] = pile.tileY;
  store.amountFp[slot] = pile.pickupsRemaining * FOOD_PICKUP_AMOUNT;
  store.initialFp[slot] = pile.pickupsInitial * FOOD_PICKUP_AMOUNT;
  store.foodId[slot] = pile.foodPileId;
  store.flags[slot] = pile.isCorpse === true ? FOOD_FLAG_CORPSE : 0;
  store.pileOrder[store.pileCount] = slot;
  store.pileCount += 1;
  rebuildSurfacePileAt(store);
  return slot;
}

/** Remove every pile. */
export function clearPilesForTest(world: WorldState): void {
  const store = world.food;
  for (let o = 0; o < store.pileCount; o++) clearFoodSlot(store, store.pileOrder[o]!);
  store.pileOrder.fill(0);
  store.pileCount = 0;
  rebuildSurfacePileAt(store);
}

/** Replace every pile with `piles` (in that creation order). */
export function setPilesForTest(world: WorldState, piles: readonly TestPile[]): void {
  clearPilesForTest(world);
  for (const p of piles) addPileForTest(world, p);
}

/** Every live pile in creation order, in the pre-V50 (pickup-charge) shape. */
export function pilesForTest(world: WorldState): TestPile[] {
  const store = world.food;
  const out: TestPile[] = [];
  for (let o = 0; o < store.pileCount; o++) {
    const s = store.pileOrder[o]!;
    const p: TestPile = {
      foodPileId: store.foodId[s]!,
      tileX: store.tileX[s]!,
      tileY: store.tileY[s]!,
      pickupsRemaining: store.amountFp[s]! >> 9,
      pickupsInitial: store.initialFp[s]! >> 9,
    };
    if ((store.flags[s]! & FOOD_FLAG_CORPSE) !== 0) p.isCorpse = true;
    out.push(p);
  }
  return out;
}

/** Overwrite a pile's charges (either may be omitted). No validation. */
export function setPileChargesForTest(
  world: WorldState,
  slot: number,
  pickupsRemaining?: number,
  pickupsInitial?: number,
): void {
  if (pickupsRemaining !== undefined) {
    world.food.amountFp[slot] = pickupsRemaining * FOOD_PICKUP_AMOUNT;
  }
  if (pickupsInitial !== undefined)
    world.food.initialFp[slot] = pickupsInitial * FOOD_PICKUP_AMOUNT;
}

/**
 * Set ant `id`'s hunger clock so that, between ticks, it survives exactly
 * `meals` more failed meals under `profile` (the pre-V50 countdown value: 1 = dies
 * on its next unfed tick; `profile.starveAfterTicks` = just ate).
 */
export function setMealsUntilStarvationForTest(
  world: WorldState,
  id: EntityId,
  profile: HungerProfile,
  meals: number,
): void {
  world.ants.lastMealTick[id] = world.tick - 1 - (profile.starveAfterTicks - meals);
}

/**
 * Push a synthetic natural pile at tile (0, 0) holding `pickupsRemaining` pickups
 * (initial = remaining, or 1 for an empty pile so the save invariant holds) and
 * return its slot plus the pile as described. Id is 90_000 + creation index.
 * Direct store write: no hard cap, no dirty flags.
 */
export function pushTestPile(
  world: WorldState,
  pickupsRemaining: number,
): { slot: number; pile: TestPile } {
  const pile: TestPile = {
    foodPileId: 90_000 + world.food.pileCount,
    tileX: 0,
    tileY: 0,
    pickupsRemaining,
    pickupsInitial: pickupsRemaining > 0 ? pickupsRemaining : 1,
  };
  return { slot: addPileForTest(world, pile), pile };
}
