// storage-hint.ts — #395 (V70) / #413: the Food Storage hint, and the queen's
// "Waiting for stores" status line.
//
// The queen lays only while the colony's stores cover the egg reserve
// (lifecycle-system.ts Gate 7, eggReserveFp): 60 s of the whole colony's food, the
// brood already laid and the new egg's larva included. Storage capacity
// (colonyFoodCapacity: the entrance pool's cap plus every completed FoodStorage
// chamber's) therefore caps the brood, the way supply depots cap an army: with the
// opening's one larder a colony settles at about 3 brood, its stores near full and
// its queen waiting (#413). That is intended; this module teaches it.
//
// What the stores must hold (queenStoresNeedFp): the egg reserve, plus what the queen
// and her larvae eat on the tick before Gate 7 reads the stores (tick.ts step 3, food
// consumption, runs before step 6, egg production). The stores a frame shows must
// reach that for her to lay on the next tick.
//
// The hint (the 'foodStorageNeeded' caption), for the player's colony, when storage
// is what holds the queen back:
//   - the queen is alive and her Queen chamber and Nursery are both completed;
//   - what she needs now (#413: brood waiting included) exceeds storage capacity, so
//     no amount of foraging can cover it: only more storage (or brood maturing) lets
//     her lay. A need the stores can hold is a wait for food, not a build-order
//     problem, however low the stores are now: a larder with room that foragers are
//     filling never counts;
//   - FoodStorage chambers the colony has already designated (pending) would not
//     close the gap. A player who has ordered one is not told to build one; GameScene
//     passes the projected world, so an order still in the command queue counts.
// Its copy names the fix:
//   - no completed Food Storage chamber: "Build a Food Storage chamber so your queen
//     can lay eggs." (the caption key's own text);
//   - one or more, the stores at least STORAGE_FULL_NUM/STORAGE_FULL_DEN of capacity:
//     STORAGE_FULL_HINT_TEXT, "Your stores are full — …". That is the full-larder
//     stall as play produces it: a spell starts when she lays, which she does only
//     once the stores reach the reserve less one larva's runway, so they are near full
//     (87–97% each time in a 10-game sweep of playtest 3's novice bot);
//   - one or more, the stores lower (a famine, a raid, a load): STORAGE_SMALL_HINT_TEXT,
//     "Your Food Storage is too small …", which holds whatever the stores read.
//
// The condition has to hold for STORAGE_HINT_DWELL_TICKS before the hint shows, which
// gives a player who is about to designate a larder a moment to do it (a designated
// one already silences it, above). It shows once (the 'foodStorageNeeded' one-shot
// caption key), held for STORAGE_HINT_HOLD_MS so it can be read. It re-arms once the
// stall has cleared, and no sooner than STORAGE_HINT_COOLDOWN_TICKS after it was last
// offered. The stall has cleared when storage has covered the need for
// STORAGE_HINT_REARM_TICKS, or when storage capacity has grown since the hint was
// offered: the player built what it asked for, so the next stall is a new one, however
// soon the queen lays up to the new capacity. In a stall storage stops covering the
// need each time she lays and covers it again only briefly, when a larva matures, so
// a stalled colony is told once, not on every egg. A hint waiting behind another
// caption is withdrawn, never to show, on the first frame storage stops blocking the
// queen (covered, or enough Food Storage designated; judged on the projected world, so
// a queued designation counts, paused or not; storageHintStale). Its key is un-marked,
// so it comes back if storage blocks the queen again (after a fresh dwell, unless the
// blocking spell it was due in never broke while the game played on).
//
// The status line (queenStoresWait, formatQueenStoresLine): UIScene shows
// "Waiting for stores: 24/30" under the HUD stats bar for as long as the queen is held
// back by the egg reserve at all: her stores (colonyFoodTotal, the Food count's
// number) against what they must hold. That covers the storage stall (the need above
// capacity: `capped`, drawn in the warning colour) and an ordinary wait for food. It
// reads the live world, held 2 s past the wait's end and 2 s amber past `capped`
// (queen-stores-line.ts, #425).
//
// Render-side session state only: reads world state, writes nothing, saves nothing.
// Pure and Phaser-free; GameScene owns the hint state and calls advanceStorageHint
// each frame while playing.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { hasCompletedChamber } from '../sim/colony/colony-system.js';
import { eggReserveFp } from '../sim/colony/lifecycle-system.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/food/food-api.js';
import { LARVA_HUNGER, QUEEN_HUNGER } from '../sim/hunger.js';
import { FOOD_CHAMBER_CAPACITY } from '../sim/constants.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';

/** Ticks (10 s at 20 Hz) storage must keep blocking the queen before the caption shows. */
export const STORAGE_HINT_DWELL_TICKS = 200;

/** Ticks (30 s) storage must cover the need before the caption re-arms. */
export const STORAGE_HINT_REARM_TICKS = 600;

/** #413 — ticks (2 min) after the caption was last offered before it may re-arm, so
 *  a colony that keeps outgrowing its storage is not told on every stall. The status
 *  line says so meanwhile. */
export const STORAGE_HINT_COOLDOWN_TICKS = 2400;

/** The caption's full-opacity hold (ms), as long as the army warning's
 *  (ARMY_CAPTION_HOLD_MS): long enough to read. Like it, the caption gives way to
 *  an event caption queued behind it (caption-queue.ts CAPTION_YIELD_FLOOR_MS). */
export const STORAGE_HINT_HOLD_MS = 4000;

/** #413 — the hint's copy for a colony with a Food Storage chamber whose stores are
 *  full (at least STORAGE_FULL_NUM/STORAGE_FULL_DEN of capacity) yet short. */
export const STORAGE_FULL_HINT_TEXT =
  'Your stores are full — build another Food Storage so your queen can keep laying.';

/** #413 — the same, with the stores lower than that: the cause, not the symptom (not
 *  "stores", which on the HUD is the food count: in a famine that would read as "too
 *  little food"). */
export const STORAGE_SMALL_HINT_TEXT =
  'Your Food Storage is too small for your queen to keep laying — build another.';

/** #413 — "full", for the hint's copy: the stores at least 3/4 of capacity (the HUD
 *  Food count reads nearly full). */
export const STORAGE_FULL_NUM = 3;
export const STORAGE_FULL_DEN = 4;

export interface StorageHintState {
  /** world.tick since which storage has blocked the queen (null: not blocked). */
  blockedSinceTick: number | null;
  /** world.tick since which storage has covered the need (null: not covering). */
  coveredSinceTick: number | null;
  /** #413 — world.tick the caption was last offered (null: not this round). */
  lastOfferedTick: number | null;
  /** #413 — storage capacity (fp) when the caption was last offered (null: not this
   *  round); capacity above it means the player has built storage since. */
  capacityAtOffer: number | null;
  /** #413 — the stall has cleared since the caption was last offered: it re-arms once
   *  the cooldown is up. */
  rearmDue: boolean;
}

export function createStorageHintState(): StorageHintState {
  return {
    blockedSinceTick: null,
    coveredSinceTick: null,
    lastOfferedTick: null,
    capacityAtOffer: null,
    rearmDue: false,
  };
}

/** What storage says this frame about a colony. */
export type StorageHintCondition =
  /** Storage blocks the queen from laying (see the header). */
  | 'blocked'
  /** Storage can hold what she needs now (or her stores already do). */
  | 'covered'
  /** Neither: no colony or queen, no Queen chamber or Nursery yet, or a short
   *  larder with enough FoodStorage already designated. */
  | 'neither';

/**
 * #413 — the food (fp) `colony`'s stores must hold, as a frame shows them, for its
 * queen to lay on the next tick: the egg reserve (eggReserveFp), plus the meals the
 * queen (if alive) and each larva eat that tick before Gate 7 reads the stores (both
 * eat every tick: QUEEN_HUNGER and LARVA_HUNGER have a 1-tick meal interval). A
 * worker that eats at home draws on the stores in the same step, but only one tick in
 * its meal interval; that is not counted. Read-only.
 */
export function queenStoresNeedFp(world: WorldState, colony: ColonyRecord): number {
  const queenMeal = world.ants.alive[colony.queenEntityId] === 1 ? QUEEN_HUNGER.mealFp : 0;
  return eggReserveFp(world, colony) + queenMeal + colony.larvaeCount * LARVA_HUNGER.mealFp;
}

/** The egg gates other than the reserve that this module checks: the queen is alive
 *  and her Queen chamber and Nursery are both completed. */
function queenReadyBarStores(world: WorldState, colony: ColonyRecord): boolean {
  return (
    world.ants.alive[colony.queenEntityId] === 1 &&
    hasCompletedChamber(colony, ChamberType.Queen) &&
    hasCompletedChamber(colony, ChamberType.Nursery)
  );
}

/** The storage condition of colony `colonyId` now. Read-only. */
export function storageHintCondition(world: WorldState, colonyId: ColonyId): StorageHintCondition {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return 'neither';
  const need = queenStoresNeedFp(world, colony);
  const capacity = colonyFoodCapacity(colony);
  // Storage can hold what she needs (a wait for food at most), or the stores hold it.
  if (need <= capacity || colonyFoodTotal(world, colony) >= need) return 'covered';
  if (!queenReadyBarStores(world, colony)) return 'neither';
  let pendingStorage = 0;
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    const pc = world.pendingChambers[key]!;
    if (pc.colonyId === colonyId && pc.chamberType === ChamberType.FoodStorage) {
      pendingStorage += FOOD_CHAMBER_CAPACITY;
    }
  }
  return need - capacity > pendingStorage ? 'blocked' : 'neither';
}

/**
 * True when storage no longer blocks colony `colonyId`'s queen (covered, or enough
 * Food Storage designated; also no colony or queen), so a storage hint still
 * waiting behind another caption is out of date. Whenever the hint is the caption
 * waiting, GameScene asks this of the projected world (queued commands folded in)
 * before the loop drains (Playing or Paused) and again after the hint's step, and
 * withdraws the waiting hint (UIScene.withdrawPendingCaption). Read-only.
 */
export function storageHintStale(world: WorldState, colonyId: ColonyId): boolean {
  return storageHintCondition(world, colonyId) !== 'blocked';
}

/** #413 — the hint's text for `colony`, blocked now: see the header. */
function storageHintText(world: WorldState, colony: ColonyRecord, keyText: string): string {
  if (!hasCompletedChamber(colony, ChamberType.FoodStorage)) return keyText;
  const full =
    colonyFoodTotal(world, colony) * STORAGE_FULL_DEN >=
    colonyFoodCapacity(colony) * STORAGE_FULL_NUM;
  return full ? STORAGE_FULL_HINT_TEXT : STORAGE_SMALL_HINT_TEXT;
}

/**
 * GameScene's per-frame step for the player's colony. Returns the caption text to
 * show now (with the 'foodStorageNeeded' key; storageHintText picks it), or null.
 * Re-arms the caption once the stall has cleared (storage covering the need for
 * STORAGE_HINT_REARM_TICKS, or capacity grown since the caption was offered) and
 * STORAGE_HINT_COOLDOWN_TICKS have passed since it was offered. With `mayOffer` false
 * (#395: a recurring caption — the army warning, the rampage warning, raid news or the
 * counter-attack caption — is owed and goes first) the dwell, re-arm and cooldown
 * clocks run on but no caption is offered this frame; a due one is offered on the next
 * frame that may.
 */
export function advanceStorageHint(
  state: StorageHintState,
  world: WorldState,
  colonyId: ColonyId,
  mayOffer = true,
): string | null {
  const condition = storageHintCondition(world, colonyId);
  const colony = world.colonies[colonyId];
  const tick = world.tick;
  // A tick that goes back (a load) restarts the cooldown there.
  if (state.lastOfferedTick !== null && state.lastOfferedTick > tick) state.lastOfferedTick = tick;
  if (condition === 'covered') {
    state.blockedSinceTick = null;
    if (state.coveredSinceTick === null || state.coveredSinceTick > tick) {
      state.coveredSinceTick = tick;
    }
    if (tick - state.coveredSinceTick >= STORAGE_HINT_REARM_TICKS) state.rearmDue = true;
  } else {
    state.coveredSinceTick = null;
  }
  // Storage built since the caption was offered: the stall it was about is over.
  if (colony !== undefined && state.capacityAtOffer !== null) {
    const capacity = colonyFoodCapacity(colony);
    if (capacity > state.capacityAtOffer) {
      state.capacityAtOffer = capacity;
      state.rearmDue = true;
    }
  }
  // Re-arm (a no-op while it has not shown since the last re-arm) once the stall has
  // cleared and the cooldown is up, whatever storage says by then.
  if (
    state.rearmDue &&
    (state.lastOfferedTick === null || tick - state.lastOfferedTick >= STORAGE_HINT_COOLDOWN_TICKS)
  ) {
    untrigger('foodStorageNeeded');
    state.rearmDue = false;
  }
  if (condition !== 'blocked' || colony === undefined) {
    state.blockedSinceTick = null;
    return null;
  }
  if (state.blockedSinceTick === null || state.blockedSinceTick > tick) {
    state.blockedSinceTick = tick;
  }
  if (tick - state.blockedSinceTick < STORAGE_HINT_DWELL_TICKS) return null;
  if (!mayOffer) return null;
  // null once it has shown (or is showing) since the last re-arm.
  const keyText = checkAndTrigger('foodStorageNeeded');
  if (keyText === null) return null;
  // Offered (again, after the queue dropped or withdrew it): the cooldown runs from
  // now, and only a stall that clears after this re-arms it.
  state.lastOfferedTick = tick;
  state.capacityAtOffer = colonyFoodCapacity(colony);
  state.rearmDue = false;
  return storageHintText(world, colony, keyText);
}

/** #413 — the queen held back by the egg reserve: her stores against what they need. */
export interface QueenStoresWait {
  /** The stores in whole food, rounded down (the HUD Food count's number). */
  storedFood: number;
  /** What the stores must hold (queenStoresNeedFp) in whole food, rounded up, so it
   *  always reads above the stores. */
  needFood: number;
  /** The need exceeds storage capacity: no amount of foraging covers it (the storage
   *  stall the hint is about). */
  capped: boolean;
}

/**
 * #413 — colony `colonyId`'s queen is held back by the egg reserve: alive, her Queen
 * chamber and Nursery completed, and the stores short of what Gate 7 will need on the
 * next tick (queenStoresNeedFp). Null otherwise. Gate 6 (she is inside her Queen
 * chamber) and Gate 1 (her egg interval has run) are not checked: a queen on her way
 * there, or between eggs, with the stores short waits for them too. Read-only.
 */
export function queenStoresWait(world: WorldState, colonyId: ColonyId): QueenStoresWait | null {
  const colony = world.colonies[colonyId];
  if (colony === undefined || !queenReadyBarStores(world, colony)) return null;
  const stored = colonyFoodTotal(world, colony);
  const need = queenStoresNeedFp(world, colony);
  if (stored >= need) return null;
  return {
    storedFood: stored >> FP_SHIFT,
    needFood: (need + FP_ONE - 1) >> FP_SHIFT,
    capped: need > colonyFoodCapacity(colony),
  };
}

/** #413 — the status line's text: "Waiting for stores: 24/30" (food: the HUD Food
 *  count just above shows the same stores, out of capacity). No unit, so a three-digit
 *  line still ends left of the widest caption at the top (hud-stats.test.ts). */
export function formatQueenStoresLine(wait: QueenStoresWait): string {
  return `Waiting for stores: ${wait.storedFood}/${wait.needFood}`;
}
