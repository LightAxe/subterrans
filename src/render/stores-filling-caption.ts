// stores-filling-caption.ts — economy captions (playtest 4 follow-up): tell the player
// to build the next Food Storage chamber BEFORE the stores fill.
//
// Playtest 4's novice, who builds a larder only when the #413 storage hint asks for
// one, loses 18 of 20 Easy games. The hint fires only once storage is already
// holding the queen back; by then the stores have been full for a while and the
// colony's foragers have had nowhere to put food (forage backpressure,
// food-api.ts colonyForageBackpressure: they are sent idle). Measured over the
// first 12 minutes (Easy, seeds 0-19), that novice builds 3-4 larders, spends
// 4.5 minutes in backpressure and brings in 448 food; the scripted "human", who
// builds a larder whenever the Food count reads three-quarters full, builds 8 by
// minute 5, spends 0.2 minutes in backpressure and brings in 595. Grafting only that
// one decision onto the novice lifts it from 2 to 17 Easy wins in 20 (8 of 20 on
// Normal, against 1). This caption teaches it.
//
// The trigger, for the viewing colony:
//   - its queen is alive and it already has a completed Food Storage chamber (with
//     none, the #395 storage hint's "Build a Food Storage chamber …" covers it);
//   - its stores (colonyFoodTotal, the HUD Food count) are at least
//     STORES_FILLING_NUM/STORES_FILLING_DEN of storage capacity (colonyFoodCapacity);
//   - it has no Food Storage chamber designated (pending): a player who has ordered
//     the next one is not told to;
//   - storage is not already holding the queen back (storage-hint.ts
//     storageHintCondition 'blocked'): that is the #413 storage hint's to say, with
//     the reason ("… so your queen can keep laying");
// held for STORES_FILLING_DWELL_TICKS, so a player about to designate one has time
// to. It is then owed, and not owed again within STORES_FILLING_COOLDOWN_TICKS of
// that, nor within that of the storage hint's last offer (the two give the same
// advice; GameScene passes the hint's last offer tick). The storage hint is not held
// back by it: a player who did not build, whose queen storage then holds back, is told
// why.
//
// It DECIDES per sim tick and PRESENTS per render frame (#416 review, queen-danger.ts):
// sim-tick-hook.ts beforeSimTick calls noteStoresFillingTick before each tick (the
// world as the previous tick left it) and GameScene calls it for the frame's last
// tick, so the dwell and the cooldown run on world ticks and which ticks owe the
// caption does not depend on how the game loop batches ticks into frames, except
// through two frame-decided inputs: the storage hint's last offer (it is offered per
// frame) and a caption dropped unshown (stale, judged per frame), which frees the
// cooldown so a trigger that still holds owes it again. The frame step
// (offerStoresFillingCaption) presents what is owed and drops what is stale.
//
// It is a RECURRING caption (recurring-captions.ts offerRecurringCaption): it enters
// the caption queue only while the queue is idle, so it never takes the pending slot
// a one-shot caption needs. It stays owed for STORES_FILLING_OWED_TICKS; if that runs
// out behind a busy queue and the trigger still holds, it is owed again. It is advice,
// not a threat: GameScene offers it after every other caption but the storage hint,
// and an owed one makes no long caption give way. It goes stale, dropped unshown, once the trigger
// no longer holds on the projected world (a Food Storage designated, paused or not; the
// stores drawn down) or the window has passed.
//
// Render-side session state only: reads world state, writes nothing, saves nothing.
// Pure and Phaser-free; GameScene owns the state.

import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { hasCompletedChamber } from '../sim/colony/colony-system.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/food/food-api.js';
import { offerRecurringCaption, type RecurringCaptionSink } from './recurring-captions.js';
import { STORAGE_HINT_HOLD_MS, storageHintCondition } from './storage-hint.js';

/** The caption, in the storage hint's voice ("Your stores are full — build another
 *  Food Storage so your queen can keep laying."). */
export const STORES_FILLING_CAPTION_TEXT =
  'Your stores are nearly full — build another Food Storage so your foragers have room.';

/** "Nearly full": the stores at least 3/4 of capacity. */
export const STORES_FILLING_NUM = 3;
export const STORES_FILLING_DEN = 4;

/** Ticks (10 s) the trigger must hold before the caption is owed. */
export const STORES_FILLING_DWELL_TICKS = 200;

/** Ticks after the caption was last owed (or the storage hint last offered) before it
 *  may be owed again. */
export const STORES_FILLING_COOLDOWN_TICKS = 1200;

/** Ticks (10 s) an owed caption the busy queue has not taken is still offered. */
export const STORES_FILLING_OWED_TICKS = 200;

/** Full-opacity hold (ms): the storage hint's. */
export const STORES_FILLING_HOLD_MS = STORAGE_HINT_HOLD_MS;

export interface StoresFillingCaptionState {
  /** world.tick since which the trigger has held (null: it does not hold). */
  sinceTick: number | null;
  /** world.tick the caption was last owed, unless that one was then dropped unshown
   *  (null: none this round). The cooldown runs from it. */
  lastOwedTick: number | null;
  /** world.tick it is owed from and has not shown yet (null: none owed). */
  owedTick: number | null;
}

export function createStoresFillingCaptionState(): StoresFillingCaptionState {
  return { sinceTick: null, lastOwedTick: null, owedTick: null };
}

/** `colonyId` has a Food Storage chamber designated and not yet complete. */
function storageDesignated(world: WorldState, colonyId: ColonyId): boolean {
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    const pc = world.pendingChambers[key]!;
    if (pc.colonyId === colonyId && pc.chamberType === ChamberType.FoodStorage) return true;
  }
  return false;
}

/** The trigger (see the header) for colony `colonyId` in `world`. Read-only. */
export function storesFillingCondition(world: WorldState, colonyId: ColonyId): boolean {
  const colony = world.colonies[colonyId];
  if (colony === undefined || world.ants.alive[colony.queenEntityId] !== 1) return false;
  if (!hasCompletedChamber(colony, ChamberType.FoodStorage)) return false;
  const capacity = colonyFoodCapacity(colony);
  if (colonyFoodTotal(world, colony) * STORES_FILLING_DEN < capacity * STORES_FILLING_NUM) {
    return false;
  }
  if (storageDesignated(world, colonyId)) return false;
  // Storage already holds the queen back: the #413 storage hint, which says why, is
  // the caption for that.
  return storageHintCondition(world, colonyId) !== 'blocked';
}

/**
 * One look at colony `colonyId` at world.tick (before every sim tick, and once per
 * frame for the frame's last tick). Owes the caption once the trigger has held for
 * STORES_FILLING_DWELL_TICKS, unless it was owed, or the storage hint offered
 * (`storageHintLastOfferedTick`, null: never), within STORES_FILLING_COOLDOWN_TICKS.
 * A second look at the same tick changes nothing, unless the frame step dropped the owed
 * caption in between (offerStoresFillingCaption), which owes it again.
 */
export function noteStoresFillingTick(
  state: StoresFillingCaptionState,
  world: WorldState,
  colonyId: ColonyId,
  storageHintLastOfferedTick: number | null,
): void {
  const tick = world.tick;
  // A world that went back (a load) restarts the clocks there.
  if (state.lastOwedTick !== null && state.lastOwedTick > tick) state.lastOwedTick = null;
  if (!storesFillingCondition(world, colonyId)) {
    state.sinceTick = null;
    return;
  }
  if (state.sinceTick === null || state.sinceTick > tick) state.sinceTick = tick;
  if (tick - state.sinceTick < STORES_FILLING_DWELL_TICKS) return;
  if (storesFillingCaptionRecent(state, tick)) return;
  const hint = storageHintLastOfferedTick;
  if (hint !== null && hint <= tick && tick - hint < STORES_FILLING_COOLDOWN_TICKS) return;
  // The dwell clock runs on: a trigger that still holds once the cooldown is up owes it
  // again then (and a second look at this tick changes nothing, unless the frame step
  // dropped the owed caption in between).
  state.lastOwedTick = tick;
  state.owedTick = tick;
}

/** The owed caption is out of date in `world` (the projected world: queued orders
 *  folded in): past its window, or the trigger no longer holds. Read-only. */
export function storesFillingCaptionStale(
  state: StoresFillingCaptionState,
  world: WorldState,
  colonyId: ColonyId,
): boolean {
  const owed = state.owedTick;
  if (owed === null) return false;
  const age = world.tick - owed;
  return age < 0 || age > STORES_FILLING_OWED_TICKS || !storesFillingCondition(world, colonyId);
}

/**
 * GameScene's per-frame step: offers the owed caption (offerRecurringCaption: only
 * while the queue is idle), or drops it once stale. Returns true iff it was shown.
 */
export function offerStoresFillingCaption(
  state: StoresFillingCaptionState,
  world: WorldState,
  colonyId: ColonyId,
  ui: RecurringCaptionSink,
  screenX: number,
  screenY: number,
): boolean {
  if (state.owedTick === null) return false;
  if (storesFillingCaptionStale(state, world, colonyId)) {
    // Dropped unshown, so its cooldown holds nothing back: a trigger that still holds
    // (it expired behind a busy queue) owes it again on the next look.
    state.owedTick = null;
    state.lastOwedTick = null;
    return false;
  }
  if (
    !offerRecurringCaption(
      ui,
      STORES_FILLING_CAPTION_TEXT,
      screenX,
      screenY,
      STORES_FILLING_HOLD_MS,
    )
  ) {
    return false;
  }
  state.owedTick = null;
  return true;
}

/** The caption was owed within STORES_FILLING_COOLDOWN_TICKS of `tick` (its cooldown). */
export function storesFillingCaptionRecent(
  state: StoresFillingCaptionState,
  tick: number,
): boolean {
  const last = state.lastOwedTick;
  return last !== null && last <= tick && tick - last < STORES_FILLING_COOLDOWN_TICKS;
}
