// storage-hint.ts — #395 (V70): "Build a Food Storage chamber so your queen can lay
// eggs."
//
// From simVersion V70 the queen lays only while the colony's stores cover the egg
// reserve (lifecycle-system.ts eggReserveFp). The smallest reserve (3600 fp) is more
// than the entrance pool holds (2048), so a colony with no FoodStorage chamber can
// never lay, and a colony that outgrows its chambers stops laying too. Nothing else
// in the game says so. This caption does, for the player's colony, when storage is
// the problem:
//   - the queen is alive and her Queen chamber and Nursery are both completed, so
//     storage is what stands between her and laying;
//   - storage capacity falls short of the reserve she would need with no brood
//     waiting (eggReserveStorageShortfallFp > 0). No larder can then cover it,
//     however full. Low stores in an adequate larder are normal, not a build-order
//     problem, and so is the larder's brood ceiling (she is held back only by brood
//     she has already laid, and lays again as it matures): neither counts;
//   - FoodStorage chambers the colony has already designated (pending) would not
//     close the gap. A player who has ordered one is not told to build one; GameScene
//     passes the projected world, so an order still in the command queue counts.
// That has to hold for STORAGE_HINT_DWELL_TICKS before the caption shows, which
// gives a player who is about to designate a larder a moment to do it (a designated
// one already silences it, above). It shows once (the 'foodStorageNeeded' one-shot
// caption key), held for STORAGE_HINT_HOLD_MS so it can be read: it is the only
// place the game says storage is why the queen is not laying. It re-arms only after
// storage has covered the no-brood reserve again for STORAGE_HINT_REARM_TICKS, so a
// colony that later outgrows its chambers is told again. That suppresses flips shorter
// than STORAGE_HINT_REARM_TICKS only: a colony at the edge that loses a worker and
// waits for the replacement to mature (EGG_HATCH_TICKS + LARVA_MATURE_TICKS, far
// longer) is told again when it is short once more, at most once per such spell.
// A colony with no Food Storage chamber can never be covered, so it is told once.
// A hint waiting behind another caption is withdrawn, never to show, on the first
// frame storage stops blocking the queen (covered, or enough Food Storage
// designated; judged on the projected world, so a queued designation counts, paused
// or not; storageHintStale). Its key is un-marked, so it comes back if storage
// blocks the queen again (after a fresh dwell, unless the blocking spell it was due
// in never broke while the game played on).
//
// Render-side session state only: reads world state, writes nothing, saves nothing.
// Pure and Phaser-free; GameScene owns the state and calls advanceStorageHint each
// frame while playing.

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { hasCompletedChamber } from '../sim/colony/colony-system.js';
import { eggReserveStorageShortfallFp } from '../sim/colony/lifecycle-system.js';
import { FOOD_CHAMBER_CAPACITY } from '../sim/constants.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';

/** Ticks (10 s at 20 Hz) storage must keep blocking the queen before the caption shows. */
export const STORAGE_HINT_DWELL_TICKS = 200;

/** Ticks (30 s) storage must cover the no-brood reserve before the caption re-arms. */
export const STORAGE_HINT_REARM_TICKS = 600;

/** The caption's full-opacity hold (ms), as long as the army warning's
 *  (GATHER_CAPTION_HOLD_MS): long enough to read. Like it, the caption gives way to
 *  an event caption queued behind it (caption-queue.ts CAPTION_YIELD_FLOOR_MS). */
export const STORAGE_HINT_HOLD_MS = 4000;

export interface StorageHintState {
  /** world.tick since which storage has blocked the queen (null: not blocked). */
  blockedSinceTick: number | null;
  /** world.tick since which storage has covered the reserve (null: not covering). */
  coveredSinceTick: number | null;
}

export function createStorageHintState(): StorageHintState {
  return { blockedSinceTick: null, coveredSinceTick: null };
}

/** What storage says this frame about a colony. */
export type StorageHintCondition =
  /** Storage blocks the queen from laying (see the header). */
  | 'blocked'
  /** Storage covers the reserve she would need with no brood waiting. */
  | 'covered'
  /** Neither: no colony or queen, no Queen chamber or Nursery yet, or a short
   *  larder with enough FoodStorage already designated. */
  | 'neither';

/** The storage condition of colony `colonyId` now. Read-only. */
export function storageHintCondition(world: WorldState, colonyId: ColonyId): StorageHintCondition {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return 'neither';
  const shortfall = eggReserveStorageShortfallFp(world, colony);
  if (shortfall === 0) return 'covered';
  if (world.ants.alive[colony.queenEntityId] !== 1) return 'neither';
  if (!hasCompletedChamber(colony, ChamberType.Queen)) return 'neither';
  if (!hasCompletedChamber(colony, ChamberType.Nursery)) return 'neither';
  let pendingStorage = 0;
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    const pc = world.pendingChambers[key]!;
    if (pc.colonyId === colonyId && pc.chamberType === ChamberType.FoodStorage) {
      pendingStorage += FOOD_CHAMBER_CAPACITY;
    }
  }
  return shortfall > pendingStorage ? 'blocked' : 'neither';
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
 * show now (with the 'foodStorageNeeded' key), or null. Re-arms the caption once
 * storage has covered the reserve for STORAGE_HINT_REARM_TICKS. With `mayOffer`
 * false (#395: a recurring caption — the army warning, the rampage warning or raid
 * news — is owed and goes first) the dwell and re-arm clocks run on but no caption
 * is offered this frame; a due one is offered on the next frame that may.
 */
export function advanceStorageHint(
  state: StorageHintState,
  world: WorldState,
  colonyId: ColonyId,
  mayOffer = true,
): string | null {
  const condition = storageHintCondition(world, colonyId);
  const tick = world.tick;
  if (condition === 'covered') {
    state.blockedSinceTick = null;
    if (state.coveredSinceTick === null || state.coveredSinceTick > tick) {
      state.coveredSinceTick = tick;
    }
    // Re-arm (a no-op while it has not shown since the last re-arm).
    if (tick - state.coveredSinceTick >= STORAGE_HINT_REARM_TICKS) untrigger('foodStorageNeeded');
    return null;
  }
  state.coveredSinceTick = null;
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
  return checkAndTrigger('foodStorageNeeded');
}
