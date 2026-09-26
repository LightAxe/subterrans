// src/sim/food/food-api.ts — the food facade (#290 PR 1).
//
// Every reader and writer of food STORAGE goes through this module: the surface
// piles (`world.foodPiles`), the entrance pool (`ColonyRecord.foodStored`) and the
// FoodStorage chamber stock (`ChamberRecord.foodStored`). Nothing else in src/
// touches those three fields, except the save serializer/validator in
// `platform/save.ts` (which owns the on-disk shape) and the struct declaration +
// `copyWorldState` in `types.ts`. `food-api-guard.test.ts` enforces that.
//
// PR 1 implements the facade over the EXISTING storage. The located-food rewrite
// (PR 2) swaps the storage for a structure-of-arrays store underneath these same
// signatures, so callers do not change again. That is why several functions take
// `world` although today's storage does not need it.
//
// Units. Every quantity crossing this API is fixed-point food (fp). A pile stores
// pickup-charges today; the facade converts: 1 charge = FOOD_PICKUP_AMOUNT fp.
//
// Pile handles ("slots"). `pileSlotAt(world, i)` maps the i-th pile in creation
// order to a slot, and the per-pile readers take that slot. Today a slot IS the
// array index, so a slot is invalidated by any pile removal (`drainPile` emptying
// a pile). Never hold a slot across a call that can remove a pile.
//
// Determinism: integers only, no `/`, no module-level mutable state. The per-tick
// readers and movers (totals, withdraw/deposit, pile readers, `pileAtTile`) do not
// allocate. The rare writers allocate exactly as the code they replaced did:
// `spawnPile` pushes a new pile object, `drainPile` splices, and
// `recordFoodPileDepletion` pushes a DepletionRecord and walks
// `Object.values(world.colonies)` (only when a pile empties). `pileRender` and
// `forEachPile` allocate per call and are for render / input / tooling only.

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
} from '../constants.js';
import { ChamberType } from '../enums.js';
import { isSurfaceTileInComponent } from '../surface-features.js';

// ---------------------------------------------------------------------------
// Charge ↔ fp conversion (PR 1 only: piles still store charges)
// ---------------------------------------------------------------------------

/** log2(FOOD_PICKUP_AMOUNT). Conversion fp → charges is a shift (no `/` in sim). */
const PICKUP_SHIFT = 9;
// Compile-time guard: fails to typecheck if FOOD_PICKUP_AMOUNT stops being 512
// (= 1 << PICKUP_SHIFT), which would make the shift conversion wrong.
const PICKUP_SHIFT_GUARD: typeof FOOD_PICKUP_AMOUNT = 512;
void PICKUP_SHIFT_GUARD;

/** Pile flag bit: the pile was dropped by a combat death (A2, V37). */
export const FOOD_FLAG_CORPSE = 1;

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
 * wants.
 */
export function colonyFoodTotal(world: WorldState, colony: ColonyRecord): number {
  void world;
  let total = colony.foodStored;
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType === ChamberType.FoodStorage) total += ch.foodStored;
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
  void world;
  return colony.foodStored;
}

/**
 * Food held by one chamber (fp). Only FoodStorage chambers ever hold food; any
 * other chamber type reads 0.
 */
export function chamberStock(world: WorldState, ch: ChamberRecord): number {
  void world;
  if (ch.chamberType !== ChamberType.FoodStorage) return 0;
  return ch.foodStored;
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
  void world;
  if (ch.chamberType !== ChamberType.FoodStorage) return false;
  return FOOD_CHAMBER_CAPACITY - ch.foodStored >= FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP;
}

/**
 * True when the colony has genuinely nowhere to deposit foraged food: the
 * entrance pool is at capacity AND no FoodStorage chamber is depositable. Shared
 * by the #42 SearchingFood demotion and the #126 idle-promotion backpressure
 * (both via `colonyForageBackpressure`) and by the #27 carrier wait-wake gate.
 *
 * Strict at-cap: a carrier deposits the instant the pool has any headroom, so a
 * chamberless colony's pool stays pegged at cap as the queen nibbles it.
 */
export function colonyHasNoDepositTarget(world: WorldState, colony: ColonyRecord): boolean {
  if (colony.foodStored < BASE_FOOD_STORAGE_CAPACITY) return false;
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

  let remaining = amount;
  // Outer `while` re-scans each iteration. Both production callers (queen 2 fp,
  // larva 1 fp) finish in one iteration in steady state; the O(N²) worst case
  // (tiny dribbles across many chambers) does not arise in any current caller.
  while (remaining > 0) {
    let pickIdx = -1;
    let pickFill = -1;
    for (let i = 0; i < colony.chambers.length; i++) {
      const ch = colony.chambers[i]!;
      if (ch.chamberType !== ChamberType.FoodStorage) continue;
      if (ch.foodStored <= 0) continue;
      if (ch.foodStored > pickFill) {
        pickFill = ch.foodStored;
        pickIdx = i;
      }
    }
    if (pickIdx < 0) break; // no chamber has food

    const ch = colony.chambers[pickIdx]!;
    const wasDepositable = isFoodChamberDepositable(world, ch);
    const take = ch.foodStored < remaining ? ch.foodStored : remaining;
    ch.foodStored -= take;
    remaining -= take;
    if (!wasDepositable && isFoodChamberDepositable(world, ch)) {
      colony.foodFlowFieldDirty = true;
    }
  }

  if (remaining > 0) {
    colony.foodStored -= remaining;
  }
  return true;
}

/**
 * Deposit up to `amount` fp into one FoodStorage chamber, capped at its free
 * space (FOOD_CHAMBER_CAPACITY − stock). Returns the amount accepted.
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
  const space = FOOD_CHAMBER_CAPACITY - ch.foodStored;
  const accepted = amount < space ? amount : space;
  ch.foodStored += accepted;
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
  void world;
  const space = BASE_FOOD_STORAGE_CAPACITY - colony.foodStored;
  const accepted = amount < space ? amount : space > 0 ? space : 0;
  colony.foodStored += accepted;
  return accepted;
}

/**
 * Reconcile backstop (`tickReconcile`): clamp the entrance pool to
 * [0, BASE_FOOD_STORAGE_CAPACITY] and each FoodStorage chamber to
 * [0, FOOD_CHAMBER_CAPACITY]. Defensive only; deposit and withdraw already cap.
 * NEVER redistributes food across chambers (the pre-#15 magic-fill bug).
 */
export function clampColonyFoodStores(world: WorldState, colony: ColonyRecord): void {
  void world;
  if (colony.foodStored < 0) colony.foodStored = 0;
  if (colony.foodStored > BASE_FOOD_STORAGE_CAPACITY) {
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;
  }
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType !== ChamberType.FoodStorage) continue;
    if (ch.foodStored < 0) ch.foodStored = 0;
    if (ch.foodStored > FOOD_CHAMBER_CAPACITY) ch.foodStored = FOOD_CHAMBER_CAPACITY;
  }
}

// ---------------------------------------------------------------------------
// Chamber lifecycle
// ---------------------------------------------------------------------------

/**
 * Give a newly promoted chamber its (empty) food stock. Called by
 * `checkPendingChambers` right after it appends the ChamberRecord. Today the
 * stock is the record's own field, already 0, so this only restates it.
 */
export function createChamberStock(
  world: WorldState,
  colony: ColonyRecord,
  ch: ChamberRecord,
): void {
  void world;
  void colony;
  ch.foodStored = 0;
}

/**
 * Release a chamber's food stock (the food is lost). For completeness only:
 * chambers are never destroyed today, so nothing calls this yet.
 */
export function freeChamberStock(world: WorldState, colony: ColonyRecord, ch: ChamberRecord): void {
  void world;
  void colony;
  ch.foodStored = 0;
}

// ---------------------------------------------------------------------------
// Piles — readers
// ---------------------------------------------------------------------------

/** Number of live surface piles. */
export function pileCount(world: WorldState): number {
  return world.foodPiles.length;
}

/**
 * Slot of the `orderIdx`-th live pile in creation order (0 ≤ orderIdx <
 * `pileCount`). Iteration in this order is the canonical pile order (every
 * "first pile found" tie-break depends on it).
 */
export function pileSlotAt(world: WorldState, orderIdx: number): number {
  void world;
  return orderIdx;
}

/** Slot of the pile on surface tile (x, y), or -1. Tiles are unique among piles. */
export function pileAtTile(world: WorldState, x: number, y: number): number {
  const piles = world.foodPiles;
  for (let p = 0; p < piles.length; p++) {
    const pile = piles[p]!;
    if (pile.tileX === x && pile.tileY === y) return p;
  }
  return -1;
}

/** Slot of the pile whose stable id is `foodId`, or -1 if it no longer exists. */
export function pileSlotById(world: WorldState, foodId: FoodPileId): number {
  const piles = world.foodPiles;
  for (let p = 0; p < piles.length; p++) {
    if (piles[p]!.foodPileId === foodId) return p;
  }
  return -1;
}

/** Stable external id of the pile (an entity id; what `priorityFoodPileId` holds). */
export function pileFoodId(world: WorldState, slot: number): FoodPileId {
  return world.foodPiles[slot]!.foodPileId;
}

export function pileTileX(world: WorldState, slot: number): number {
  return world.foodPiles[slot]!.tileX;
}

export function pileTileY(world: WorldState, slot: number): number {
  return world.foodPiles[slot]!.tileY;
}

/** Food remaining on the pile (fp). Always > 0 for a live pile. */
export function pileAmountFp(world: WorldState, slot: number): number {
  return world.foodPiles[slot]!.pickupsRemaining * FOOD_PICKUP_AMOUNT;
}

/** The pile's size at birth (fp), raised by corpse top-ups. Render shrink denominator. */
export function pileInitialFp(world: WorldState, slot: number): number {
  return world.foodPiles[slot]!.pickupsInitial * FOOD_PICKUP_AMOUNT;
}

/** True for a pile dropped by a combat death (A2, V37). Fixed at birth. */
export function pileIsCorpse(world: WorldState, slot: number): boolean {
  return world.foodPiles[slot]!.isCorpse === true;
}

/** Number of live piles that are NOT corpse piles (the natural-spawn soft ceiling's count). */
export function naturalPileCount(world: WorldState): number {
  const piles = world.foodPiles;
  let n = 0;
  for (let i = 0; i < piles.length; i++) {
    if (!piles[i]!.isCorpse) n++;
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
 * Does NOT remove the pile. `drainPile` calls this and then removes it.
 */
export function recordFoodPileDepletion(world: WorldState, slot: number): void {
  const pile = world.foodPiles[slot];
  if (!pile) return;

  const skipBarren = world.simVersion >= SIM_VERSION_V37_CORPSE_FOOD && pile.isCorpse === true;
  if (!skipBarren) {
    if (world.recentlyDepletedFood.length >= FOOD_PILE_SOFT_CEILING) {
      world.recentlyDepletedFood.shift();
    }
    world.recentlyDepletedFood.push({
      tick: world.tick,
      tileX: pile.tileX,
      tileY: pile.tileY,
    });
  }

  // Clear stale priority pointers so a forager doesn't route to a vanished pile
  // and the render highlight doesn't attach to a recycled slot.
  const depletedId: FoodPileId = pile.foodPileId;
  for (const colony of Object.values(world.colonies)) {
    if (colony.priorityFoodPileId === depletedId) {
      colony.priorityFoodPileId = null;
    }
  }
}

/**
 * Drain `amountFp` from a pile (whole pickups: the amount is floored to a
 * multiple of FOOD_PICKUP_AMOUNT; the remainder clamps at 0). When the pile
 * empties it is recorded (`recordFoodPileDepletion`) and removed, preserving the
 * creation order of the remaining piles. Returns true iff the pile was removed,
 * in which case `slot` and every later slot are invalidated.
 */
export function drainPile(world: WorldState, slot: number, amountFp: number): boolean {
  const pile = world.foodPiles[slot]!;
  pile.pickupsRemaining -= amountFp >> PICKUP_SHIFT;
  if (pile.pickupsRemaining < 0) pile.pickupsRemaining = 0;
  if (pile.pickupsRemaining > 0) return false;
  recordFoodPileDepletion(world, slot);
  // Splice (not swap-pop): keeps creation order, which every "first pile found"
  // tie-break, the scent scan and the MarkFoodPile lookup depend on.
  world.foodPiles.splice(slot, 1);
  return true;
}

/**
 * Append a new pile of `amountFp` (whole pickups) on surface tile (x, y) with id
 * `foodId`, which the caller allocated from the shared entity-id counter. `flags`
 * takes FOOD_FLAG_CORPSE. Returns the new slot, or -1 when the pile store is at
 * FOOD_PILE_HARD_CAP (unreachable for today's callers, which gate first).
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
  if (world.foodPiles.length >= FOOD_PILE_HARD_CAP) return -1;
  const pickups = amountFp >> PICKUP_SHIFT;
  // Natural piles leave `isCorpse` ABSENT (not false): the snapshot shape of a
  // natural pile has no such key.
  if ((flags & FOOD_FLAG_CORPSE) !== 0) {
    world.foodPiles.push({
      foodPileId: foodId,
      tileX: x,
      tileY: y,
      pickupsRemaining: pickups,
      pickupsInitial: pickups,
      isCorpse: true,
    });
  } else {
    world.foodPiles.push({
      foodPileId: foodId,
      tileX: x,
      tileY: y,
      pickupsRemaining: pickups,
      pickupsInitial: pickups,
    });
  }
  return world.foodPiles.length - 1;
}

/**
 * A2 (V37) — drop `amountFp` (whole pickups) of corpse food at surface tile
 * (x, y). Callers MUST gate on `simVersion >= SIM_VERSION_V37_CORPSE_FOOD`: a new
 * pile advances the entity-id counter.
 *
 * Top-up on an occupied tile is a correctness requirement (the save rejects two
 * piles on one tile): the existing pile grows, both its size and its birth size
 * clamped to FOOD_PILE_INITIAL_PICKUPS_MAX, and keeps its corpse flag (a corpse
 * topping up a natural pile leaves it natural). Otherwise a NEW corpse pile is
 * created, only while below FOOD_PILE_HARD_CAP and only on a walkable tile in the
 * surface component (the save's connectivity check would reject anything else).
 * Entity-id exhaustion is a silent skip. No RNG.
 */
export function topUpOrSpawnCorpsePile(
  world: WorldState,
  x: number,
  y: number,
  amountFp: number,
): void {
  const pickups = amountFp >> PICKUP_SHIFT;
  const slot = pileAtTile(world, x, y);
  if (slot >= 0) {
    const pile = world.foodPiles[slot]!;
    pile.pickupsInitial = Math.min(pile.pickupsInitial + pickups, FOOD_PILE_INITIAL_PICKUPS_MAX);
    // Clamp remaining to the (possibly clamped) initial so the save invariant holds.
    pile.pickupsRemaining = Math.min(pile.pickupsRemaining + pickups, pile.pickupsInitial);
    return;
  }

  if (world.foodPiles.length >= FOOD_PILE_HARD_CAP) return;
  // Guard before allocating so an off-component tile doesn't burn an entity id.
  if (!isSurfaceTileInComponent(world, x, y)) return;
  const newId = allocateEntityId(world);
  if (newId === INVALID_ENTITY_ID) return; // entity-id exhaustion — silent skip
  // Defensive clamp, symmetric with the top-up branch.
  const initial = Math.min(pickups, FOOD_PILE_INITIAL_PICKUPS_MAX);
  spawnPile(world, newId, x, y, initial * FOOD_PICKUP_AMOUNT, FOOD_FLAG_CORPSE);
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
