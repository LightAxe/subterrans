// recurring-captions.ts — #350: how recurring (keyless) captions enter the
// shared caption queue without costing a one-shot caption its slot.
//
// The caption queue (caption-queue.ts) holds one active caption and ONE pending
// one. A one-shot caption (rally, queen damage, invasion, onboarding) is marked
// shown before it reaches the queue and is un-marked only if the queue drops it
// on overflow; it then waits for its trigger to happen again, which for most
// one-shots is never. A recurring caption has no key and would take the pending
// slot behind an active caption, so the next one-shot overflows. Recurring
// captions therefore enter only while the queue is fully idle
// (recurringCaptionMayEnter), and each one stays owed until it gets in:
//
//   - raid news (raid-captions.ts) stays owed for RAID_CAPTION_OWED_TICKS;
//   - the spider-rampage warning stays owed while the spider is still out
//     hunting hungry, capped at RAMPAGE_CAPTION_OWED_TICKS after the start.
//     The sim's Rampaging state itself is too short-lived to key on: a rampage
//     ends as soon as the spider diverts to chase a nearby ant, often within a
//     second or two, and at 4x speed a start and that divert can land in the
//     same render frame. The spider is then still hunting, so the warning is
//     still true. It goes stale only when the spider has eaten (Feeding), been
//     driven off (Retreating) or is gone, or when the window runs out.
//
// GameScene offers the owed rampage warning before raid news each frame, so a
// rampage outranks raid news when both wait on the same idle queue.
//
// Pure + Phaser-free: GameScene owns the state and passes its UIScene in.

import type { SpiderBehaviorState, WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';
import { captionForEvent, oneShotKeyForEvent, type CaptionKey } from './onboarding-captions.js';

/** The part of UIScene a recurring caption needs. */
export interface RecurringCaptionSink {
  /** True while nothing is showing and nothing is pending. Optional so the
   *  gate can fail closed: a sink without it never takes recurring captions. */
  captionQueueIdle?(): boolean;
  /** Returns false iff the queue dropped the caption. */
  showCaption(text: string, screenX: number, screenY: number): boolean;
}

/**
 * Offer a recurring caption to the queue. It enters only while the queue is idle,
 * so it never takes the pending slot a one-shot caption would need. Fails closed:
 * no captionQueueIdle means no caption. Returns true iff the queue took it; on
 * false the caller keeps it owed and offers it again next frame.
 */
export function offerRecurringCaption(
  ui: RecurringCaptionSink,
  text: string,
  screenX: number,
  screenY: number,
): boolean {
  return ui.captionQueueIdle?.() === true && ui.showCaption(text, screenX, screenY);
}

/**
 * How long an owed rampage warning is still offered (10 s of game time), the
 * same window as owed raid news. The queue drains within about 3 s of wall-clock
 * time (an active and a pending caption), so this only runs out at high game
 * speed behind a busy queue.
 */
export const RAMPAGE_CAPTION_OWED_TICKS = 200;

/** Spider states in which the warning is stale: it has eaten or been driven off. */
const RAMPAGE_OVER_STATES: ReadonlySet<SpiderBehaviorState> = new Set(['Feeding', 'Retreating']);

export interface RampageCaptionState {
  /** world.tick of a spider_rampage_start whose warning has not shown yet
   *  (-Infinity: none owed). */
  owedSinceTick: number;
}

export function createRampageCaptionState(): RampageCaptionState {
  return { owedSinceTick: -Infinity };
}

/** New round or loaded save: nothing owed. */
export function resetRampageCaptionState(state: RampageCaptionState): void {
  state.owedSinceTick = -Infinity;
}

/** A spider_rampage_start event at `tick`: the warning is owed until it shows.
 *  A later rampage while one is still owed restarts the window. */
export function noteRampageStart(state: RampageCaptionState, tick: number): void {
  state.owedSinceTick = tick;
}

/**
 * Called each frame. Shows the owed rampage warning once the queue is idle, or
 * drops it unshown once it is stale (see the header). Returns true iff it was
 * shown this call.
 */
export function offerOwedRampageCaption(
  state: RampageCaptionState,
  world: Pick<WorldState, 'spider' | 'tick'>,
  ui: RecurringCaptionSink,
  screenX: number,
  screenY: number,
): boolean {
  if (state.owedSinceTick === -Infinity) return false;
  const text = captionForEvent('spider_rampage_start');
  if (
    world.spider === null ||
    RAMPAGE_OVER_STATES.has(world.spider.state) ||
    world.tick - state.owedSinceTick > RAMPAGE_CAPTION_OWED_TICKS ||
    text === null
  ) {
    state.owedSinceTick = -Infinity; // stale: drop it
    return false;
  }
  if (!offerRecurringCaption(ui, text, screenX, screenY)) return false;
  state.owedSinceTick = -Infinity;
  return true;
}

/** The part of UIScene an event caption needs: showCaption with the one-shot key. */
export interface EventCaptionSink extends RecurringCaptionSink {
  showCaption(text: string, screenX: number, screenY: number, captionKey?: CaptionKey): boolean;
}

/**
 * GameScene's caption handling for one sim event, per the event→caption policy
 * in onboarding-captions.ts:
 *   - a one-shot event caption (invasion_start) is shown now, with its key, so
 *     the queue un-marks and re-fires it if it is dropped;
 *   - the recurring spider_rampage_start warning is NOT shown here. It is marked
 *     owed and shown by offerOwedRampageCaption once the queue is idle (#350);
 *     shown here, it would take the pending slot behind an active caption and
 *     the next one-shot caption would be dropped.
 * Other events have no caption. captionForEvent marks a one-shot key even with
 * no UIScene, as GameScene always has.
 */
export function routeEventCaption(
  ev: SimEvent,
  rampage: RampageCaptionState,
  ui: EventCaptionSink | null,
  screenX: number,
  screenY: number,
): void {
  if (ev.type === 'spider_rampage_start') {
    noteRampageStart(rampage, ev.tick);
    return;
  }
  const key = oneShotKeyForEvent(ev.type);
  if (key === null) return;
  const text = captionForEvent(ev.type);
  if (text !== null && ui !== null) ui.showCaption(text, screenX, screenY, key);
}
