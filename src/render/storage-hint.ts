// storage-hint.ts — #395 (V70) / #413: the Food Storage hint, and the queen's
// "Waiting for stores" status line.
//
// From simVersion V70 the queen lays only while the colony's stores cover the egg
// reserve (lifecycle-system.ts Gate 7, eggReserveFp): 60 s of the whole colony's
// food, the brood already laid and the new egg's larva included. Storage capacity
// (colonyFoodCapacity: the entrance pool's cap plus every completed FoodStorage
// chamber's) therefore caps the brood, the way supply depots cap an army: with the
// opening's one larder a colony settles at about 3 brood, its stores near full and
// its queen waiting (#413). That is intended; this module teaches it.
//
// The hint (the 'foodStorageNeeded' caption), for the player's colony, when storage
// is what holds the queen back:
//   - the queen is alive and her Queen chamber and Nursery are both completed;
//   - the egg reserve she needs now (#413: brood waiting included) exceeds storage
//     capacity, so no amount of foraging can cover it: only more storage (or brood
//     maturing) lets her lay. A reserve the stores can hold is a wait for food, not
//     a build-order problem, however low the stores are now: a larder with room that
//     foragers are filling never counts;
//   - FoodStorage chambers the colony has already designated (pending) would not
//     close the gap. A player who has ordered one is not told to build one; GameScene
//     passes the projected world, so an order still in the command queue counts.
// Its copy names the fix. With no completed Food Storage chamber: "Build a Food
// Storage chamber so your queen can lay eggs." With one or more, the full-larder
// stall: STORAGE_FULL_HINT_TEXT. (In play such a spell starts when she lays, which
// she does only once the stores reach the reserve less one larva's runway, so the
// stores are close to full when the hint shows.)
//
// The condition has to hold for STORAGE_HINT_DWELL_TICKS before the hint shows, which
// gives a player who is about to designate a larder a moment to do it (a designated
// one already silences it, above). It shows once (the 'foodStorageNeeded' one-shot
// caption key), held for STORAGE_HINT_HOLD_MS so it can be read. It re-arms only once
// the stall has cleared, storage covering the reserve for STORAGE_HINT_REARM_TICKS,
// and no sooner than STORAGE_HINT_COOLDOWN_TICKS after it was last offered. In a
// stall storage stops covering the reserve each time she lays and covers it again
// only briefly, when a larva matures, so a stalled colony is told once, not on every
// egg. A colony that builds storage, lays up to its new capacity and stalls again is
// told again, at most once per cooldown. A hint waiting behind another caption is
// withdrawn, never to show, on the first frame storage stops blocking the queen
// (covered, or enough Food Storage designated; judged on the projected world, so a
// queued designation counts, paused or not; storageHintStale). Its key is un-marked,
// so it comes back if storage blocks the queen again (after a fresh dwell, unless the
// blocking spell it was due in never broke while the game played on).
//
// The status line (queenStoresWait, formatQueenStoresLine): UIScene shows
// "Waiting for stores: 24/30" under the HUD stats bar for as long as the queen is
// held back by the egg reserve at all: her stores (colonyFoodTotal, the Food count's
// number) against the reserve Gate 7 compares them with. That covers the storage
// stall (the reserve above capacity: `capped`, drawn in the warning colour) and an
// ordinary wait for food. It reads the live world.
//
// Render-side session state only: reads world state, writes nothing, saves nothing.
// Pure and Phaser-free; GameScene owns the hint state and calls advanceStorageHint
// each frame while playing.

import type { WorldState } from '../sim/types.js';
import { SIM_VERSION_V70_EGG_RESERVE } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { hasCompletedChamber } from '../sim/colony/colony-system.js';
import { eggReserveFp } from '../sim/colony/lifecycle-system.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/food/food-api.js';
import { FOOD_CHAMBER_CAPACITY } from '../sim/constants.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';

/** Ticks (10 s at 20 Hz) storage must keep blocking the queen before the caption shows. */
export const STORAGE_HINT_DWELL_TICKS = 200;

/** Ticks (30 s) storage must cover the reserve before the caption re-arms. */
export const STORAGE_HINT_REARM_TICKS = 600;

/** #413 — ticks (2 min) after the caption was last offered before it may re-arm, so
 *  a colony that keeps outgrowing its storage is not told on every stall. The status
 *  line says so meanwhile. */
export const STORAGE_HINT_COOLDOWN_TICKS = 2400;

/** The caption's full-opacity hold (ms), as long as the army warning's
 *  (GATHER_CAPTION_HOLD_MS): long enough to read. Like it, the caption gives way to
 *  an event caption queued behind it (caption-queue.ts CAPTION_YIELD_FLOOR_MS). */
export const STORAGE_HINT_HOLD_MS = 4000;

/** #413 — the hint's copy once the colony has a Food Storage chamber: its stores are
 *  full and still short of the reserve (the 'foodStorageNeeded' caption's own text,
 *  for a colony with none, says to build the first). */
export const STORAGE_FULL_HINT_TEXT =
  'Your stores are full — build another Food Storage so your queen can keep laying.';

export interface StorageHintState {
  /** world.tick since which storage has blocked the queen (null: not blocked). */
  blockedSinceTick: number | null;
  /** world.tick since which storage has covered the reserve (null: not covering). */
  coveredSinceTick: number | null;
  /** #413 — world.tick the caption was last offered (null: not this round). */
  lastOfferedTick: number | null;
  /** #413 — storage has covered the reserve for STORAGE_HINT_REARM_TICKS since the
   *  caption was last offered (the stall cleared): it re-arms once the cooldown is up. */
  rearmDue: boolean;
}

export function createStorageHintState(): StorageHintState {
  return { blockedSinceTick: null, coveredSinceTick: null, lastOfferedTick: null, rearmDue: false };
}

/** What storage says this frame about a colony. */
export type StorageHintCondition =
  /** Storage blocks the queen from laying (see the header). */
  | 'blocked'
  /** Storage can hold the reserve she needs now (or her stores already do). */
  | 'covered'
  /** Neither: no colony or queen, no Queen chamber or Nursery yet, or a short
   *  larder with enough FoodStorage already designated. */
  | 'neither';

/** The egg reserve gates the queen (lifecycle-system.ts Gate 7: from V70 only). */
function reserveRuleApplies(world: WorldState): boolean {
  return world.simVersion >= SIM_VERSION_V70_EGG_RESERVE;
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
  // Before V70 there is no reserve to cover.
  if (!reserveRuleApplies(world)) return 'covered';
  const reserve = eggReserveFp(world, colony);
  const capacity = colonyFoodCapacity(colony);
  // Storage can hold the reserve (a wait for food at most), or the stores hold it.
  if (reserve <= capacity || colonyFoodTotal(world, colony) >= reserve) return 'covered';
  if (!queenReadyBarStores(world, colony)) return 'neither';
  let pendingStorage = 0;
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    const pc = world.pendingChambers[key]!;
    if (pc.colonyId === colonyId && pc.chamberType === ChamberType.FoodStorage) {
      pendingStorage += FOOD_CHAMBER_CAPACITY;
    }
  }
  return reserve - capacity > pendingStorage ? 'blocked' : 'neither';
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

/**
 * GameScene's per-frame step for the player's colony. Returns the caption text to
 * show now (with the 'foodStorageNeeded' key), or null: the key's own text with no
 * completed Food Storage chamber, STORAGE_FULL_HINT_TEXT with one. Re-arms the
 * caption once storage has covered the reserve for STORAGE_HINT_REARM_TICKS and
 * STORAGE_HINT_COOLDOWN_TICKS have passed since it was offered. With `mayOffer`
 * false (#395: a recurring caption — the army warning, the rampage warning or raid
 * news — is owed and goes first) the dwell, re-arm and cooldown clocks run on but no
 * caption is offered this frame; a due one is offered on the next frame that may.
 */
export function advanceStorageHint(
  state: StorageHintState,
  world: WorldState,
  colonyId: ColonyId,
  mayOffer = true,
): string | null {
  const condition = storageHintCondition(world, colonyId);
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
  // Re-arm (a no-op while it has not shown since the last re-arm) once the stall has
  // cleared and the cooldown is up, whatever storage says by then.
  if (
    state.rearmDue &&
    (state.lastOfferedTick === null || tick - state.lastOfferedTick >= STORAGE_HINT_COOLDOWN_TICKS)
  ) {
    untrigger('foodStorageNeeded');
    state.rearmDue = false;
  }
  if (condition !== 'blocked') {
    state.blockedSinceTick = null;
    return null;
  }
  if (state.blockedSinceTick === null || state.blockedSinceTick > tick) {
    state.blockedSinceTick = tick;
  }
  if (tick - state.blockedSinceTick < STORAGE_HINT_DWELL_TICKS) return null;
  if (!mayOffer) return null;
  // null once it has shown (or is showing) since the last re-arm.
  const text = checkAndTrigger('foodStorageNeeded');
  if (text === null) return null;
  // Offered (again, after the queue dropped or withdrew it): the cooldown runs from
  // now, and only a stall that clears after this re-arms it.
  state.lastOfferedTick = tick;
  state.rearmDue = false;
  // 'blocked' means the colony exists.
  return hasCompletedChamber(world.colonies[colonyId]!, ChamberType.FoodStorage)
    ? STORAGE_FULL_HINT_TEXT
    : text;
}

/** #413 — the queen held back by the egg reserve: her stores against it. */
export interface QueenStoresWait {
  /** The stores in whole food, rounded down (the HUD Food count's number). */
  storedFood: number;
  /** The egg reserve in whole food, rounded up, so it always reads above the stores. */
  reserveFood: number;
  /** The reserve exceeds storage capacity: no amount of foraging covers it (the
   *  storage stall the hint is about). */
  capped: boolean;
}

/**
 * #413 — colony `colonyId`'s queen is held back by the egg reserve: alive, her Queen
 * chamber and Nursery completed, and the stores short of the reserve (Gate 7's own
 * comparison: colonyFoodTotal against eggReserveFp). Null otherwise, and before V70.
 * Gate 6 (she is inside her Queen chamber) is not checked: a queen still on her way
 * there with the stores short waits for them too. Read-only.
 */
export function queenStoresWait(world: WorldState, colonyId: ColonyId): QueenStoresWait | null {
  const colony = world.colonies[colonyId];
  if (colony === undefined || !reserveRuleApplies(world)) return null;
  if (!queenReadyBarStores(world, colony)) return null;
  const stored = colonyFoodTotal(world, colony);
  const reserve = eggReserveFp(world, colony);
  if (stored >= reserve) return null;
  return {
    storedFood: stored >> FP_SHIFT,
    reserveFood: (reserve + FP_ONE - 1) >> FP_SHIFT,
    capped: reserve > colonyFoodCapacity(colony),
  };
}

/** #413 — the status line's text: "Waiting for stores: 24/30" (food: the HUD Food count
 *  above it shows the same stores, out of capacity). No unit, so that the strip ends
 *  left of the widest caption at the top (hud-stats.test.ts). */
export function formatQueenStoresLine(wait: QueenStoresWait): string {
  return `Waiting for stores: ${wait.storedFood}/${wait.reserveFood}`;
}
