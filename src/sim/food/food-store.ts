// src/sim/food/food-store.ts — the located food store (#290 PR 2, V50).
//
// Every piece of food that sits still lives here, in one structure-of-arrays
// table (`world.food`), one slot per record:
//
//   kind   | replaces (pre-V50)            | location                         | foodId
//   -------+-------------------------------+----------------------------------+-----------
//   Pile   | world.foodPiles[i]            | surface tile                     | entity id
//   Pool   | ColonyRecord.foodStored       | underground (entrance column, 0) | -1
//   Stock  | ChamberRecord.foodStored      | underground, the chamber anchor  | chamberId
//
// Food an ant carries stays on the ant (`ants.foodCarrying`): the ant's position
// is its location, so a store record would need a per-tick position sync.
//
// Links. `ColonyRecord.poolSlot` points at the colony's Pool; a FoodStorage
// chamber's `ChamberRecord.foodSlot` points at its Stock (−1 for every other
// chamber type), and the Stock's `foodId` is the chamber id. Live Piles are
// listed in creation order in `pileOrder[0..pileCount)`.
//
// Only the facade (`food-api.ts`) and its test setters (`food-test-utils.ts`)
// read or write these columns; the save serializer/validator (`platform/save.ts`)
// and `copyWorldState` own the on-disk and cloned shapes.
//
// Capacity is FOOD_STORE_CAPACITY (constants.ts): every pile, one pool per colony
// and the physical FoodStorage-chamber bound per colony, so a world the loader
// accepts can never fill the store.
//
// Determinism: integers only, no `/`, no module-level mutable state. Columns are
// allocated once per world and never reallocated.

import {
  FOOD_PILE_HARD_CAP,
  FOOD_STORE_CAPACITY,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
} from '../constants.js';

/** What a food-store slot holds. Append-only values (serialized). */
export const FoodKind = {
  /** Free slot: every column is 0. */
  None: 0,
  /** A surface food pile. */
  Pile: 1,
  /** A colony's entrance pool (never raidable, #290 D3). */
  Pool: 2,
  /** A FoodStorage chamber's stock. */
  Stock: 3,
} as const;
export type FoodKind = (typeof FoodKind)[keyof typeof FoodKind];

/** Pile flag bit: the pile was dropped by a combat death (A2, V37). */
export const FOOD_FLAG_CORPSE = 1;

/** The located food store. See the module header. */
export interface FoodStore {
  // --- serialized columns (length FOOD_STORE_CAPACITY) ---
  /** FoodKind per slot (0 = free). */
  readonly kind: Uint8Array;
  /** Owning colony id for a Pool / Stock; 0 for a Pile (unowned). */
  readonly owner: Uint8Array;
  /** Zone.Surface (Pile) or Zone.Underground (Pool / Stock). */
  readonly zone: Uint8Array;
  /** Underground grid owner (= owner) for a Pool / Stock; 0 on the surface. */
  readonly grid: Uint8Array;
  readonly tileX: Int16Array;
  readonly tileY: Int16Array;
  /** Food held (fp). A Pile always holds whole pickups (multiples of FOOD_PICKUP_AMOUNT). */
  readonly amountFp: Int32Array;
  /** Pile: size at birth (fp; the render shrink denominator, raised by corpse top-ups). 0 otherwise. */
  readonly initialFp: Int32Array;
  /** Stable external id: Pile = its entity id; Stock = its chamber id; Pool = −1. */
  readonly foodId: Int32Array;
  /** Pile flags: bit 0 = FOOD_FLAG_CORPSE. 0 otherwise. */
  readonly flags: Uint8Array;
  // --- serialized ordering ---
  /** Live Pile slots in creation order; the first `pileCount` entries are live. */
  readonly pileOrder: Int32Array;
  pileCount: number;
  // --- derived, NOT serialized (rebuilt on load / copy) ---
  /** Surface tile index (y × SURFACE_GRID_WIDTH + x) → pile slot + 1; 0 = no pile. */
  readonly surfacePileAt: Int16Array;
}

// surfacePileAt stores slot + 1 in an Int16Array, so FOOD_STORE_CAPACITY must stay
// below 0x7fff (food-store.test.ts asserts it).

/** A fresh, empty store (every slot free). */
export function createFoodStore(): FoodStore {
  return {
    kind: new Uint8Array(FOOD_STORE_CAPACITY),
    owner: new Uint8Array(FOOD_STORE_CAPACITY),
    zone: new Uint8Array(FOOD_STORE_CAPACITY),
    grid: new Uint8Array(FOOD_STORE_CAPACITY),
    tileX: new Int16Array(FOOD_STORE_CAPACITY),
    tileY: new Int16Array(FOOD_STORE_CAPACITY),
    amountFp: new Int32Array(FOOD_STORE_CAPACITY),
    initialFp: new Int32Array(FOOD_STORE_CAPACITY),
    foodId: new Int32Array(FOOD_STORE_CAPACITY),
    flags: new Uint8Array(FOOD_STORE_CAPACITY),
    pileOrder: new Int32Array(FOOD_PILE_HARD_CAP),
    pileCount: 0,
    surfacePileAt: new Int16Array(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT),
  };
}

/**
 * Lowest free slot, or −1 when the store is full (unreachable in a world the
 * loader accepts, see FOOD_STORE_CAPACITY). Does not claim it. Linear scan; only
 * called on a pile spawn, a corpse drop, a chamber promotion or colony setup.
 */
export function findFreeFoodSlot(store: FoodStore): number {
  const kind = store.kind;
  for (let s = 0; s < kind.length; s++) {
    if (kind[s] === FoodKind.None) return s;
  }
  return -1;
}

/** Zero every column of `slot` (it becomes free). Does not touch pileOrder / surfacePileAt. */
export function clearFoodSlot(store: FoodStore, slot: number): void {
  store.kind[slot] = FoodKind.None;
  store.owner[slot] = 0;
  store.zone[slot] = 0;
  store.grid[slot] = 0;
  store.tileX[slot] = 0;
  store.tileY[slot] = 0;
  store.amountFp[slot] = 0;
  store.initialFp[slot] = 0;
  store.foodId[slot] = 0;
  store.flags[slot] = 0;
}

/**
 * Point `surfacePileAt` at the FIRST live pile (in creation order) on each tile.
 * Tiles are unique among live piles in every state the sim or the loader
 * produces; first-in-order is what the pre-V50 linear scan returned, so a
 * duplicate (impossible) would still resolve the same way.
 */
export function rebuildSurfacePileAt(store: FoodStore): void {
  store.surfacePileAt.fill(0);
  for (let o = store.pileCount - 1; o >= 0; o--) {
    const slot = store.pileOrder[o]!;
    store.surfacePileAt[store.tileY[slot]! * SURFACE_GRID_WIDTH + store.tileX[slot]!] = slot + 1;
  }
}

/** Copy `src` into `dst` in place (copyWorldState). Zero allocation. */
export function copyFoodStore(src: FoodStore, dst: FoodStore): void {
  dst.kind.set(src.kind);
  dst.owner.set(src.owner);
  dst.zone.set(src.zone);
  dst.grid.set(src.grid);
  dst.tileX.set(src.tileX);
  dst.tileY.set(src.tileY);
  dst.amountFp.set(src.amountFp);
  dst.initialFp.set(src.initialFp);
  dst.foodId.set(src.foodId);
  dst.flags.set(src.flags);
  dst.pileOrder.set(src.pileOrder);
  dst.pileCount = src.pileCount;
  dst.surfacePileAt.set(src.surfacePileAt);
}
