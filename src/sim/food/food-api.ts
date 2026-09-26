// src/sim/food/food-api.ts — the food facade (#290).
//
// Every reader and writer of food STORAGE goes through this module: the surface
// piles, each colony's entrance pool and each FoodStorage chamber's stock. PR 1
// introduced it over the old storage (`world.foodPiles`, `foodStored` scalars);
// PR 2 (V50) swapped the storage underneath for the located food store
// (`food-store.ts`, `world.food`) without changing a signature, so callers did
// not change again. Nothing else in src/ touches the store's columns or the
// `poolSlot` / `foodSlot` links, except the save serializer/validator
// (`platform/save.ts`) and `copyWorldState` / `createWorldState` in `types.ts`.
// `food-api-guard.test.ts` enforces that.
//
// Units. Every quantity crossing this API is fixed-point food (fp). A pile holds
// whole pickups: FOOD_PICKUP_AMOUNT fp each.
//
// Pile handles ("slots"). `pileSlotAt(world, i)` maps the i-th pile in creation
// order to its store slot, and the per-pile readers take that slot. A slot is
// stable for the pile's lifetime and is recycled only after the pile is removed
// (`drainPile` emptying it).
//
// Links. A colony built by `createScenario` or loaded from a save always has a
// pool (`poolSlot ≥ 0`) and every FoodStorage chamber a stock (`foodSlot ≥ 0`).
// Hand-built test colonies may lack them (−1): such a colony reads 0 pool food and
// its pool accepts nothing; such a chamber reads 0 stock and is not depositable.
//
// Determinism: integers only, no `/`, no module-level mutable state. The per-tick
// readers and movers (totals, withdraw/deposit, pile readers, `pileAtTile`) do not
// allocate. `recordFoodPileDepletion` pushes a DepletionRecord and walks
// `Object.values(world.colonies)` (only when a pile empties), exactly as before.
// `pileRender` and `forEachPile` allocate per call and are for render / input /
// tooling only.

import type { WorldState } from '../types.js';
import { allocateEntityId, INVALID_ENTITY_ID, SIM_VERSION_V37_CORPSE_FOOD } from '../types.js';
import type { ChamberRecord, ColonyRecord } from '../colony/colony-store.js';
import type { FoodPileId } from '../food.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_SOFT_CEILING,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
} from '../constants.js';
import { ChamberType } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import { Zone } from '../terrain.js';
import { isSurfaceTileInComponent } from '../surface-features.js';
import { clearFoodSlot, FOOD_FLAG_CORPSE, findFreeFoodSlot, FoodKind } from './food-store.js';

export { FOOD_FLAG_CORPSE } from './food-store.js';

/** log2(FOOD_PICKUP_AMOUNT): pile amounts are floored to whole pickups by shifting (no `/`). */
export const PICKUP_SHIFT = 9;
// Compile-time guard: fails to typecheck if FOOD_PICKUP_AMOUNT stops being 512
// (= 1 << PICKUP_SHIFT), which would make the whole-pickup rounding wrong.
const PICKUP_SHIFT_GUARD: typeof FOOD_PICKUP_AMOUNT = 512;
void PICKUP_SHIFT_GUARD;

/** Largest pile size (fp): FOOD_PILE_INITIAL_PICKUPS_MAX whole pickups. */
const PILE_MAX_FP = FOOD_PILE_INITIAL_PICKUPS_MAX * FOOD_PICKUP_AMOUNT;

/** Floor `fp` to whole pickups. */
function wholePickupsFp(fp: number): number {
  return (fp >> PICKUP_SHIFT) << PICKUP_SHIFT;
}

// ---------------------------------------------------------------------------
// Totals and capacity
//
// Chamber-authoritative model (issue #15). Pre-#15 the colony had one pool that
// `tickReconcile` projected across FoodStorage chambers, so a second chamber
// "magically" filled at the next reconcile though no ant had visited it. Now
// each FoodStorage chamber's stock is authoritative for that chamber, and the
// entrance pool is the chamberless / entrance-shaft fallback (deposits at the
// shaft top, seeded with STARTING_FOOD). Chambers cap at FOOD_CHAMBER_CAPACITY
// each, the pool at BASE_FOOD_STORAGE_CAPACITY.
// ---------------------------------------------------------------------------

/**
 * Total stored food of a colony (fp): the entrance pool plus every FoodStorage
 * chamber's stock. Use this for the HUD, AI thresholds, egg gating, stalemate and
 * anything else that means "how much food does the colony have".
 * `colonyPoolFood` alone is only the entrance pool, which is rarely what a caller
 * wants. No cached total: a few array reads through the colony's slot links.
 */
export function colonyFoodTotal(world: WorldState, colony: ColonyRecord): number {
  let total = colonyPoolFood(world, colony);
  for (let i = 0; i < colony.chambers.length; i++) {
    total += chamberStock(world, colony.chambers[i]!);
  }
  return total;
}

/**
 * Total food-storage capacity of a colony (fp): BASE_FOOD_STORAGE_CAPACITY for
 * the entrance pool plus FOOD_CHAMBER_CAPACITY per COMPLETED FoodStorage chamber.
 * Pending chambers do not count; capacity grows when `checkPendingChambers`
 * promotes one. This is the cap for `colonyFoodTotal`.
 */
export function colonyFoodCapacity(colony: ColonyRecord): number {
  let n = 0;
  for (let i = 0; i < colony.chambers.length; i++) {
    if (colony.chambers[i]!.chamberType === ChamberType.FoodStorage) n += 1;
  }
  return BASE_FOOD_STORAGE_CAPACITY + n * FOOD_CHAMBER_CAPACITY;
}

/**
 * Food in the colony's entrance pool (fp). Deposits cap it at
 * BASE_FOOD_STORAGE_CAPACITY; only the test/bench setter can push it past that.
 */
export function colonyPoolFood(world: WorldState, colony: ColonyRecord): number {
  const slot = colony.poolSlot;
  return slot < 0 ? 0 : world.food.amountFp[slot]!;
}

/**
 * Food held by one chamber (fp). Only FoodStorage chambers ever hold food; any
 * other chamber type reads 0.
 */
export function chamberStock(world: WorldState, ch: ChamberRecord): number {
  if (ch.chamberType !== ChamberType.FoodStorage) return 0;
  const slot = ch.foodSlot;
  return slot < 0 ? 0 : world.food.amountFp[slot]!;
}

/**
 * Single source of truth for "is this chamber an active deposit destination?"
 * Used by the food flow-field seeding (tick.ts step 9), the forager deposit-site
 * test and deposit itself (step 16b), and the Manhattan fallback chamber target
 * in `tickAntMovement`.
 *
 * A saturated chamber (free space < FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP) is
 * excluded from all of them in lockstep. That prevents the queen-drain-then-
 * redeposit oscillation that pinned carriers on full-chamber tiles (see the
 * constant's docs). Non-FoodStorage chambers are never depositable.
 */
export function isFoodChamberDepositable(world: WorldState, ch: ChamberRecord): boolean {
  if (ch.chamberType !== ChamberType.FoodStorage || ch.foodSlot < 0) return false;
  return (
    FOOD_CHAMBER_CAPACITY - world.food.amountFp[ch.foodSlot]! >= FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP
  );
}

/**
 * True when the colony has genuinely nowhere to deposit foraged food: the
 * entrance pool is at capacity AND no FoodStorage chamber is depositable. Shared
 * by the #42 SearchingFood demotion and the #126 idle-promotion backpressure
 * (both via `colonyForageBackpressure`) and by the #27 carrier wait-wake gate.
 *
 * Strict at-cap: a carrier deposits the instant the pool has any headroom, so a
 * chamberless colony's pool stays pegged at cap as the queen nibbles it. (A
 * hand-built colony with no pool counts as having a full one.)
 */
export function colonyHasNoDepositTarget(world: WorldState, colony: ColonyRecord): boolean {
  if (colony.poolSlot >= 0 && colonyPoolFood(world, colony) < BASE_FOOD_STORAGE_CAPACITY) {
    return false;
  }
  for (let c = 0; c < colony.chambers.length; c++) {
    if (isFoodChamberDepositable(world, colony.chambers[c]!)) return false;
  }
  return true;
}

/**
 * Whether to apply FORAGER backpressure (suppress idle→Foraging promotion, #126
 * step 10a, and demote over-leashed searchers, #42 `tickSearchLeash`). True only
 * when the colony has nowhere to deposit (`colonyHasNoDepositTarget`) AND owns at
 * least one FoodStorage chamber: a chamberless early-game colony keeps foraging
 * into its entrance pool (its carriers still park via the #27 wait-wake gate).
 */
export function colonyForageBackpressure(world: WorldState, colony: ColonyRecord): boolean {
  if (!colonyHasNoDepositTarget(world, colony)) return false;
  for (let c = 0; c < colony.chambers.length; c++) {
    if (colony.chambers[c]!.chamberType === ChamberType.FoodStorage) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Moving food
// ---------------------------------------------------------------------------

/**
 * Withdraw `amount` fp from the colony's stores. All-or-nothing: returns false
 * (and takes nothing) if `colonyFoodTotal` is below `amount`.
 *
 * Drain order: the FoodStorage chamber with the highest fill first, ties to the
 * lowest `colony.chambers` index; then the entrance pool. Fullest-first
 * concentrates the saturated→depositable crossing on one chamber at a time
 * instead of cycling through several (closes issue #27).
 *
 * Flow-field dirty fires only when a chamber crosses from saturated to
 * depositable (per `isFoodChamberDepositable`), never on a cap → cap−N nibble;
 * otherwise step 9 would re-seed a still-saturated chamber every tick.
 */
export function withdrawFood(world: WorldState, colony: ColonyRecord, amount: number): boolean {
  if (colonyFoodTotal(world, colony) < amount) return false;
  const amountFp = world.food.amountFp;

  let remaining = amount;
  // Outer `while` re-scans each iteration. The queen (2 fp) and larva (1 fp)
  // meals finish in one iteration in steady state. From V51 a worker/fighter
  // meal (WORKER_MEAL_FP, 32 fp) can span near-empty chambers, so the loop can
  // run up to once per FoodStorage chamber the colony owns: O(chambers²) per meal
  // (a 32 fp meal can empty at most 32 chambers, so ≤ 32 × chambers), and meals
  // are rare (one per worker per meal interval). A single-pass rewrite (#290 plan §3.4) was deliberately not
  // done: the bound is small and fullest-first order is easier to keep here.
  while (remaining > 0) {
    let pickIdx = -1;
    let pickFill = -1;
    for (let i = 0; i < colony.chambers.length; i++) {
      const fill = chamberStock(world, colony.chambers[i]!);
      if (fill <= 0) continue;
      if (fill > pickFill) {
        pickFill = fill;
        pickIdx = i;
      }
    }
    if (pickIdx < 0) break; // no chamber has food

    const ch = colony.chambers[pickIdx]!;
    const wasDepositable = isFoodChamberDepositable(world, ch);
    const take = pickFill < remaining ? pickFill : remaining;
    amountFp[ch.foodSlot] = pickFill - take;
    remaining -= take;
    if (!wasDepositable && isFoodChamberDepositable(world, ch)) {
      colony.foodFlowFieldDirty = true;
    }
  }

  // The total covered `amount`, so any remainder is in the pool (poolSlot ≥ 0).
  if (remaining > 0) {
    amountFp[colony.poolSlot] = amountFp[colony.poolSlot]! - remaining;
  }
  return true;
}

/**
 * Deposit up to `amount` fp into one FoodStorage chamber, capped at its free
 * space (FOOD_CHAMBER_CAPACITY − stock). Returns the amount accepted (0 for a
 * chamber without a stock).
 *
 * If the chamber is no longer depositable afterwards (it crossed into the
 * saturation band), marks `colony.foodFlowFieldDirty` so step 9 re-seeds the food
 * field without it and other carriers redirect.
 */
export function depositIntoChamber(
  world: WorldState,
  colony: ColonyRecord,
  ch: ChamberRecord,
  amount: number,
): number {
  const slot = ch.foodSlot;
  if (ch.chamberType !== ChamberType.FoodStorage || slot < 0) return 0;
  const amountFp = world.food.amountFp;
  const space = FOOD_CHAMBER_CAPACITY - amountFp[slot]!;
  const accepted = amount < space ? amount : space;
  amountFp[slot] = amountFp[slot]! + accepted;
  if (!isFoodChamberDepositable(world, ch)) {
    colony.foodFlowFieldDirty = true;
  }
  return accepted;
}

/**
 * Deposit up to `amount` fp into the colony's entrance pool, capped at
 * BASE_FOOD_STORAGE_CAPACITY. Returns the amount accepted (never negative).
 */
export function depositIntoPool(world: WorldState, colony: ColonyRecord, amount: number): number {
  const slot = colony.poolSlot;
  if (slot < 0) return 0;
  const amountFp = world.food.amountFp;
  const space = BASE_FOOD_STORAGE_CAPACITY - amountFp[slot]!;
  const accepted = amount < space ? amount : space > 0 ? space : 0;
  amountFp[slot] = amountFp[slot]! + accepted;
  return accepted;
}

/**
 * Store `amount` fp of carried food at underground tile (tileX, tileY) of
 * `colony`'s own nest and return what is left over (0 = all stored). The food
 * goes into the DEPOSITABLE FoodStorage chamber whose footprint holds the tile
 * (`isFoodChamberDepositable`, first match in `colony.chambers` order — a
 * saturated chamber is not a match, so a carrier crossing it cannot dribble its
 * load in), then any remainder into the entrance pool (issue #68: after a
 * partial chamber deposit too). Chamber first, pool second, capped at each.
 *
 * The one deposit rule for carried food: foragers (`antDepositFood`) and, from
 * V52, raiders hauling loot home (`tickRaidActions`, #290 PR 5) both use it. The
 * caller decides WHERE the ant may deposit (a chamber tile or the shaft top) and
 * what the ant does with a leftover.
 */
export function depositCarriedFood(
  world: WorldState,
  colony: ColonyRecord,
  tileX: number,
  tileY: number,
  amount: number,
): number {
  let chamber: ChamberRecord | null = null;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (!isFoodChamberDepositable(world, ch)) continue;
    const baseX = ch.posX >> FP_SHIFT;
    const baseY = ch.posY >> FP_SHIFT;
    if (tileX >= baseX && tileX < baseX + ch.width && tileY >= baseY && tileY < baseY + ch.height) {
      chamber = ch;
      break;
    }
  }
  let remaining = amount;
  if (chamber !== null) remaining -= depositIntoChamber(world, colony, chamber, remaining);
  if (remaining > 0) remaining -= depositIntoPool(world, colony, remaining);
  return remaining;
}

/**
 * #290 PR 5 (V52) — a raid: take up to `amount` fp out of FoodStorage chamber
 * `ch`'s stock (never the entrance pool, owner decision D3). Returns the amount
 * taken, 0 for a chamber with no stock. If the take moves the chamber from the
 * saturation band back to depositable, marks `colony.foodFlowFieldDirty` (the
 * victim's), exactly as `withdrawFood` does, so its carriers may deposit there
 * again.
 */
export function takeFromStock(
  world: WorldState,
  colony: ColonyRecord,
  ch: ChamberRecord,
  amount: number,
): number {
  const slot = ch.foodSlot;
  if (ch.chamberType !== ChamberType.FoodStorage || slot < 0 || amount <= 0) return 0;
  const amountFp = world.food.amountFp;
  const have = amountFp[slot]!;
  const taken = amount < have ? amount : have;
  if (taken <= 0) return 0;
  const wasDepositable = isFoodChamberDepositable(world, ch);
  amountFp[slot] = have - taken;
  if (!wasDepositable && isFoodChamberDepositable(world, ch)) {
    colony.foodFlowFieldDirty = true;
  }
  return taken;
}

/**
 * Reconcile backstop (`tickReconcile`): clamp the entrance pool to
 * [0, BASE_FOOD_STORAGE_CAPACITY] and each FoodStorage chamber to
 * [0, FOOD_CHAMBER_CAPACITY]. Defensive only; deposit and withdraw already cap.
 * NEVER redistributes food across chambers (the pre-#15 magic-fill bug).
 */
export function clampColonyFoodStores(world: WorldState, colony: ColonyRecord): void {
  const amountFp = world.food.amountFp;
  const pool = colony.poolSlot;
  if (pool >= 0) {
    if (amountFp[pool]! < 0) amountFp[pool] = 0;
    if (amountFp[pool]! > BASE_FOOD_STORAGE_CAPACITY) amountFp[pool] = BASE_FOOD_STORAGE_CAPACITY;
  }
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    const slot = ch.foodSlot;
    if (ch.chamberType !== ChamberType.FoodStorage || slot < 0) continue;
    if (amountFp[slot]! < 0) amountFp[slot] = 0;
    if (amountFp[slot]! > FOOD_CHAMBER_CAPACITY) amountFp[slot] = FOOD_CHAMBER_CAPACITY;
  }
}

// ---------------------------------------------------------------------------
// Colony and chamber lifecycle
// ---------------------------------------------------------------------------

/** True when the store has a free slot (always, in a world the loader accepts). */
export function foodStoreHasFreeSlot(world: WorldState): boolean {
  return findFreeFoodSlot(world.food) >= 0;
}

/**
 * Give a new colony its (empty) entrance pool at underground tile (tileX, tileY)
 * — the entrance column's shaft top, where pool deposits happen; the location is
 * informational (nothing routes by it). Sets `colony.poolSlot`. Returns false,
 * leaving the colony without a pool, only when the store is full. Called by
 * `createScenario` for every colony.
 */
export function createColonyPool(
  world: WorldState,
  colony: ColonyRecord,
  tileX: number,
  tileY: number,
): boolean {
  const store = world.food;
  const slot = findFreeFoodSlot(store);
  if (slot < 0) return false;
  store.kind[slot] = FoodKind.Pool;
  store.owner[slot] = colony.colonyId;
  store.zone[slot] = Zone.Underground;
  store.grid[slot] = colony.colonyId;
  store.tileX[slot] = tileX;
  store.tileY[slot] = tileY;
  store.amountFp[slot] = 0;
  store.foodId[slot] = -1;
  colony.poolSlot = slot;
  return true;
}

/**
 * Give a newly promoted chamber its food stock. Called by `checkPendingChambers`
 * right after it appends the ChamberRecord. A FoodStorage chamber gets an empty
 * Stock at its anchor tile (`foodSlot` set, the Stock's foodId = chamberId);
 * every other type gets `foodSlot = −1`. Returns false only when a FoodStorage
 * chamber finds the store full (the caller checks `foodStoreHasFreeSlot` first,
 * so this does not happen).
 */
export function createChamberStock(
  world: WorldState,
  colony: ColonyRecord,
  ch: ChamberRecord,
): boolean {
  ch.foodSlot = -1;
  if (ch.chamberType !== ChamberType.FoodStorage) return true;
  const store = world.food;
  const slot = findFreeFoodSlot(store);
  if (slot < 0) return false;
  store.kind[slot] = FoodKind.Stock;
  store.owner[slot] = colony.colonyId;
  store.zone[slot] = Zone.Underground;
  store.grid[slot] = colony.colonyId;
  store.tileX[slot] = ch.posX >> FP_SHIFT;
  store.tileY[slot] = ch.posY >> FP_SHIFT;
  store.amountFp[slot] = 0;
  store.foodId[slot] = ch.chamberId;
  ch.foodSlot = slot;
  return true;
}

/**
 * Release a chamber's food stock (the food is lost). For completeness only:
 * chambers are never destroyed today, so nothing calls this yet.
 */
export function freeChamberStock(world: WorldState, colony: ColonyRecord, ch: ChamberRecord): void {
  void colony;
  if (ch.foodSlot < 0) return;
  clearFoodSlot(world.food, ch.foodSlot);
  ch.foodSlot = -1;
}

// ---------------------------------------------------------------------------
// Piles — readers
// ---------------------------------------------------------------------------

/** Number of live surface piles. */
export function pileCount(world: WorldState): number {
  return world.food.pileCount;
}

/**
 * Slot of the `orderIdx`-th live pile in creation order (0 ≤ orderIdx <
 * `pileCount`). Iteration in this order is the canonical pile order (every
 * "first pile found" tie-break depends on it).
 */
export function pileSlotAt(world: WorldState, orderIdx: number): number {
  return world.food.pileOrder[orderIdx]!;
}

/**
 * Slot of the pile on surface tile (x, y), or -1 (also for an off-map tile). O(1).
 * Tiles are unique among piles.
 */
export function pileAtTile(world: WorldState, x: number, y: number): number {
  // `(x | 0) !== x` also rejects a fractional or NaN coordinate (the pre-V50 scan
  // matched no pile for those either).
  if ((x | 0) !== x || (y | 0) !== y) return -1;
  if (x < 0 || y < 0 || x >= SURFACE_GRID_WIDTH || y >= SURFACE_GRID_HEIGHT) return -1;
  return world.food.surfacePileAt[y * SURFACE_GRID_WIDTH + x]! - 1;
}

/** Slot of the pile whose stable id is `foodId`, or -1 if it no longer exists. */
export function pileSlotById(world: WorldState, foodId: FoodPileId): number {
  const store = world.food;
  for (let o = 0; o < store.pileCount; o++) {
    const slot = store.pileOrder[o]!;
    if (store.foodId[slot] === foodId) return slot;
  }
  return -1;
}

/** Stable external id of the pile (an entity id; what `priorityFoodPileId` holds). */
export function pileFoodId(world: WorldState, slot: number): FoodPileId {
  return world.food.foodId[slot]!;
}

export function pileTileX(world: WorldState, slot: number): number {
  return world.food.tileX[slot]!;
}

export function pileTileY(world: WorldState, slot: number): number {
  return world.food.tileY[slot]!;
}

/** Food remaining on the pile (fp). Always > 0 for a live pile. */
export function pileAmountFp(world: WorldState, slot: number): number {
  return world.food.amountFp[slot]!;
}

/** The pile's size at birth (fp), raised by corpse top-ups. Render shrink denominator. */
export function pileInitialFp(world: WorldState, slot: number): number {
  return world.food.initialFp[slot]!;
}

/** True for a pile dropped by a combat death (A2, V37). Fixed at birth. */
export function pileIsCorpse(world: WorldState, slot: number): boolean {
  return (world.food.flags[slot]! & FOOD_FLAG_CORPSE) !== 0;
}

/**
 * Every live pile's surface tile, in creation order. Allocates; for world-gen and
 * save-load validation (`validateSurfaceConnectivity`), never the tick.
 */
export function livePileTiles(world: WorldState): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let o = 0; o < pileCount(world); o++) {
    const s = pileSlotAt(world, o);
    out.push([pileTileX(world, s), pileTileY(world, s)]);
  }
  return out;
}

/** Number of live piles that are NOT corpse piles (the natural-spawn soft ceiling's count). */
export function naturalPileCount(world: WorldState): number {
  const store = world.food;
  let n = 0;
  for (let o = 0; o < store.pileCount; o++) {
    if ((store.flags[store.pileOrder[o]!]! & FOOD_FLAG_CORPSE) === 0) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Piles — writers
// ---------------------------------------------------------------------------

/**
 * Record a pile that is about to vanish: append a DepletionRecord to
 * `world.recentlyDepletedFood` (append-time cap FOOD_PILE_SOFT_CEILING, oldest
 * dropped) and clear every colony's `priorityFoodPileId` that pointed at it.
 *
 * A2 (V37): a depleting CORPSE pile does not seed the natural-spawn cooldown, so
 * consumed battlefield food does not suppress natural regrowth on that tile.
 *
 * Does NOT remove the pile. `drainPile` calls this and then removes it. A slot
 * that holds no pile is ignored.
 */
export function recordFoodPileDepletion(world: WorldState, slot: number): void {
  const store = world.food;
  if (slot < 0 || slot >= store.kind.length || store.kind[slot] !== FoodKind.Pile) return;

  const skipBarren =
    world.simVersion >= SIM_VERSION_V37_CORPSE_FOOD &&
    (store.flags[slot]! & FOOD_FLAG_CORPSE) !== 0;
  if (!skipBarren) {
    if (world.recentlyDepletedFood.length >= FOOD_PILE_SOFT_CEILING) {
      world.recentlyDepletedFood.shift();
    }
    world.recentlyDepletedFood.push({
      tick: world.tick,
      tileX: store.tileX[slot]!,
      tileY: store.tileY[slot]!,
    });
  }

  // Clear stale priority pointers so a forager doesn't route to a vanished pile
  // and the render highlight doesn't attach to a recycled slot.
  const depletedId: FoodPileId = store.foodId[slot]!;
  for (const colony of Object.values(world.colonies)) {
    if (colony.priorityFoodPileId === depletedId) {
      colony.priorityFoodPileId = null;
    }
  }
}

/**
 * Remove the pile in `slot`: drop it from `pileOrder` preserving the creation
 * order of the rest (every "first pile found" tie-break, the scent scan and the
 * MarkFoodPile lookup depend on it), repoint its tile, and free the slot.
 */
function removePile(world: WorldState, slot: number): void {
  const store = world.food;
  const order = store.pileOrder;
  let o = 0;
  while (o < store.pileCount && order[o] !== slot) o++;
  if (o < store.pileCount) {
    for (; o + 1 < store.pileCount; o++) order[o] = order[o + 1]!;
    store.pileCount -= 1;
    order[store.pileCount] = 0;
  }

  const tile = store.tileY[slot]! * SURFACE_GRID_WIDTH + store.tileX[slot]!;
  if (store.surfacePileAt[tile] === slot + 1) {
    // Tiles are unique among piles, so this finds nothing in every real state;
    // the scan keeps a (loader-rejected) duplicate resolving to the first pile.
    let next = 0;
    for (let k = 0; k < store.pileCount; k++) {
      const s = order[k]!;
      if (store.tileY[s]! * SURFACE_GRID_WIDTH + store.tileX[s]! === tile) {
        next = s + 1;
        break;
      }
    }
    store.surfacePileAt[tile] = next;
  }
  clearFoodSlot(store, slot);
}

/**
 * Drain `amountFp` from a pile. Piles hold whole pickups today, so the amount is
 * floored to a multiple of FOOD_PICKUP_AMOUNT (a sub-pickup amount drains
 * nothing); the only caller, `antPickupFood`, drains FOOD_PILE_PICKUP_DRAIN ×
 * FOOD_PICKUP_AMOUNT. The remaining amount clamps at 0. When the pile
 * empties it is recorded (`recordFoodPileDepletion`) and removed, preserving the
 * creation order of the remaining piles. Returns true iff the pile was removed,
 * in which case `slot` is free (and may be reused by the next spawn).
 */
export function drainPile(world: WorldState, slot: number, amountFp: number): boolean {
  const amounts = world.food.amountFp;
  let left = amounts[slot]! - wholePickupsFp(amountFp);
  if (left < 0) left = 0;
  amounts[slot] = left;
  if (left > 0) return false;
  recordFoodPileDepletion(world, slot);
  removePile(world, slot);
  return true;
}

/**
 * Add a new pile of `amountFp` (floored to whole pickups) on surface tile (x, y)
 * with id `foodId`, which the caller allocated from the shared entity-id counter.
 * It goes last in creation order. `flags` takes FOOD_FLAG_CORPSE. Returns the new
 * slot, or -1 when the store already holds FOOD_PILE_HARD_CAP piles (unreachable
 * for today's callers, which gate first).
 *
 * The caller owns every placement rule (tile uniqueness, walkable + in the
 * surface component, spacing, caps).
 */
export function spawnPile(
  world: WorldState,
  foodId: FoodPileId,
  x: number,
  y: number,
  amountFp: number,
  flags: number,
): number {
  const store = world.food;
  if (store.pileCount >= FOOD_PILE_HARD_CAP) return -1;
  const slot = findFreeFoodSlot(store);
  if (slot < 0) return -1;
  const fp = wholePickupsFp(amountFp);
  store.kind[slot] = FoodKind.Pile;
  store.owner[slot] = 0;
  store.zone[slot] = Zone.Surface;
  store.grid[slot] = 0;
  store.tileX[slot] = x;
  store.tileY[slot] = y;
  store.amountFp[slot] = fp;
  store.initialFp[slot] = fp;
  store.foodId[slot] = foodId;
  store.flags[slot] = flags & FOOD_FLAG_CORPSE;
  store.pileOrder[store.pileCount] = slot;
  store.pileCount += 1;
  const tile = y * SURFACE_GRID_WIDTH + x;
  if (store.surfacePileAt[tile] === 0) store.surfacePileAt[tile] = slot + 1;
  return slot;
}

/**
 * A2 (V37) — drop `amountFp` (whole pickups) of corpse food at surface tile
 * (x, y). Callers MUST gate on `simVersion >= SIM_VERSION_V37_CORPSE_FOOD`: a new
 * pile advances the entity-id counter.
 *
 * Top-up on an occupied tile is a correctness requirement (the save rejects two
 * piles on one tile): the existing pile grows, both its size and its birth size
 * clamped to FOOD_PILE_INITIAL_PICKUPS_MAX pickups, and keeps its corpse flag (a
 * corpse topping up a natural pile leaves it natural). Otherwise a NEW corpse pile
 * is created, only while below FOOD_PILE_HARD_CAP and only on a walkable tile in
 * the surface component (the save's connectivity check would reject anything
 * else). Entity-id exhaustion is a silent skip. No RNG.
 */
export function topUpOrSpawnCorpsePile(
  world: WorldState,
  x: number,
  y: number,
  amountFp: number,
): void {
  const fp = wholePickupsFp(amountFp);
  // Less than one whole pickup is nothing to drop (#290 PR 5: a hauler's part-eaten
  // or partial load): never top up by 0 or mint a zero-sized pile, which the save
  // rejects (a live pile holds at least one pickup). Every earlier caller passes
  // whole pickups ≥ 1, so this changes nothing for them.
  if (fp <= 0) return;
  const slot = pileAtTile(world, x, y);
  if (slot >= 0) {
    const store = world.food;
    const grownInitial = store.initialFp[slot]! + fp;
    const initial = grownInitial < PILE_MAX_FP ? grownInitial : PILE_MAX_FP;
    store.initialFp[slot] = initial;
    // Clamp remaining to the (possibly clamped) initial so the save invariant holds.
    const grownRemaining = store.amountFp[slot]! + fp;
    store.amountFp[slot] = grownRemaining < initial ? grownRemaining : initial;
    return;
  }

  if (pileCount(world) >= FOOD_PILE_HARD_CAP) return;
  // Guard before allocating so an off-component tile doesn't burn an entity id.
  if (!isSurfaceTileInComponent(world, x, y)) return;
  const newId = allocateEntityId(world);
  if (newId === INVALID_ENTITY_ID) return; // entity-id exhaustion — silent skip
  // Defensive clamp, symmetric with the top-up branch.
  spawnPile(world, newId, x, y, fp < PILE_MAX_FP ? fp : PILE_MAX_FP, FOOD_FLAG_CORPSE);
}

// ---------------------------------------------------------------------------
// Render-side readers (allocate; never call from sim code)
// ---------------------------------------------------------------------------

/** A read-only snapshot of one pile for render / input / tooling. */
export interface PileView {
  readonly foodId: FoodPileId;
  readonly x: number;
  readonly y: number;
  readonly amountFp: number;
  readonly initialFp: number;
  readonly corpse: boolean;
}

/** Allocating snapshot of the pile in `slot`. Render / input / tooling only. */
export function pileRender(world: WorldState, slot: number): PileView {
  return {
    foodId: pileFoodId(world, slot),
    x: pileTileX(world, slot),
    y: pileTileY(world, slot),
    amountFp: pileAmountFp(world, slot),
    initialFp: pileInitialFp(world, slot),
    corpse: pileIsCorpse(world, slot),
  };
}

/**
 * Visit every live pile in creation order. Render / input / tooling only; sim
 * code uses `pileCount` + `pileSlotAt` index loops (no closures in the tick).
 * `cb` must not add or remove piles.
 */
export function forEachPile(world: WorldState, cb: (pile: PileView) => void): void {
  const n = pileCount(world);
  for (let o = 0; o < n; o++) cb(pileRender(world, pileSlotAt(world, o)));
}
