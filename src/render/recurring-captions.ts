// recurring-captions.ts — #350: how recurring (keyless) captions enter the
// shared caption queue without costing a one-shot caption its slot.
//
// The caption queue (caption-queue.ts) holds one active caption and ONE pending
// one. A one-shot caption (rally, queen damage, onboarding) is marked
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
//     still true. It goes stale only when the spider has eaten, been driven off
//     (Retreating) or is gone, or when the window runs out. "Has eaten" is read
//     from its hunger, not its state: a kill always resets hungerTicks to 0, but
//     a kill made while a fighter is still adjacent does not enter Feeding (the
//     spider stays in its state and keeps fighting). Without a meal hungerTicks
//     never decreases, so it falling below its value at the rampage start means the
//     spider has eaten by some path. The owed window (RAMPAGE_CAPTION_OWED_TICKS)
//     is far shorter than any hunger threshold, so a spider that ate cannot grow
//     back past that value before the warning expires anyway.
//
// GameScene offers the owed rampage warning before raid news each frame, so a
// rampage outranks raid news when both wait on the same idle queue.
//
// Pure + Phaser-free: GameScene owns the state and passes its UIScene in.

import type { SpiderBehaviorState, WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';
import { captionForEvent } from './onboarding-captions.js';

/** The part of UIScene a recurring caption needs. */
export interface RecurringCaptionSink {
  /** True while nothing is showing and nothing is pending. Optional so the
   *  gate can fail closed: a sink without it never takes recurring captions. */
  captionQueueIdle?(): boolean;
  /** Returns false iff the caption was not admitted (dropped, or captions closed
   *  at the round's end). `holdMs` (#372): a longer
   *  full-opacity hold for a caption that must be read. */
  showCaption(
    text: string,
    screenX: number,
    screenY: number,
    captionKey?: undefined,
    holdMs?: number,
  ): boolean;
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
  holdMs?: number,
): boolean {
  if (ui.captionQueueIdle?.() !== true) return false;
  return holdMs === undefined
    ? ui.showCaption(text, screenX, screenY)
    : ui.showCaption(text, screenX, screenY, undefined, holdMs);
}

/**
 * How long an owed rampage warning is still offered (10 s of game time), the
 * same window as owed raid news. The queue drains within about 3 s of wall-clock
 * time behind an active and a pending default caption, so this only runs out
 * at high game speed behind a busy queue. The long-hold captions (the #372/#394
 * army warning, the #395 storage hint) hold longer; while news (or, behind the
 * hint, an army warning) is owed they shorten to a 2 s readable floor (2.7 s in
 * all, UIScene.yieldLongCaption), so at 4x (a 2.5 s real-time window) news owed
 * from the same moment one began can still expire behind it, as can a march or
 * gathering warning behind the hint (its own window, GATHER_CAPTION_OWED_TICKS, is
 * also 200). So can news owed while an
 * invasion's launch warning (owed until shown, #404 review) waited out the same
 * busy queue, which it then enters first. That is a known cost of a once-per-spell
 * caption being readable, and of an army outranking news.
 */
export const RAMPAGE_CAPTION_OWED_TICKS = 200;

/** Spider states in which the warning is stale: it is eating or has been driven
 *  off. A meal is also detected from hunger (see offerOwedRampageCaption). */
const RAMPAGE_OVER_STATES: ReadonlySet<SpiderBehaviorState> = new Set(['Feeding', 'Retreating']);

export interface RampageCaptionState {
  /** world.tick of a spider_rampage_start whose warning has not shown yet
   *  (-Infinity: none owed). */
  owedSinceTick: number;
  /** The spider's hungerTicks at that rampage start (from the event payload).
   *  Hunger below this means the spider has eaten since. */
  owedHungerTicks: number;
}

export function createRampageCaptionState(): RampageCaptionState {
  return { owedSinceTick: -Infinity, owedHungerTicks: 0 };
}

/** New round or loaded save: nothing owed. */
export function resetRampageCaptionState(state: RampageCaptionState): void {
  state.owedSinceTick = -Infinity;
  state.owedHungerTicks = 0;
}

/** A spider_rampage_start event at `tick`, with the spider's hungerTicks from its
 *  payload: the warning is owed until it shows. A later rampage while one is
 *  still owed restarts the window. */
export function noteRampageStart(
  state: RampageCaptionState,
  tick: number,
  hungerTicks: number,
): void {
  state.owedSinceTick = tick;
  state.owedHungerTicks = hungerTicks;
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
    world.spider.hungerTicks < state.owedHungerTicks || // it has eaten since
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

/**
 * #372 — after this frame's offers, is a recurring caption still owed: the army
 * warning (`armyWarningOwed`: offered this frame and not taken), the rampage
 * warning, or the raid caption `raidCaption` that was not taken? GameScene then
 * asks a long-hold caption to give way (UIScene.yieldLongCaption).
 * `armyWarningOwed` (#395): the storage hint is a long-hold caption too, and an
 * army warning owed behind it would otherwise wait its full 4 s; a march or
 * gathering warning would, at 4x, go stale (GATHER_CAPTION_OWED_TICKS) unshown (an
 * invasion's launch warning is owed until shown). Giving way narrows that to a
 * warning owed in the hint's first ~0.2 s at 4x (see RAMPAGE_CAPTION_OWED_TICKS).
 * The warning being offered is never itself the caption showing: once shown it is
 * no longer owed. While this is true GameScene also holds the storage hint back,
 * and withdraws one waiting, so the owed caption comes next.
 */
export function recurringCaptionStillOwed(
  rampage: RampageCaptionState,
  raidCaption: string | null,
  armyWarningOwed: boolean,
): boolean {
  return armyWarningOwed || rampage.owedSinceTick !== -Infinity || raidCaption !== null;
}

/**
 * GameScene's caption handling for one sim event, per the event→caption policy
 * in onboarding-captions.ts. The spider_rampage_start warning is NOT shown here:
 * it is marked owed and shown by offerOwedRampageCaption once the queue is idle
 * (#350); shown here, it would take the pending slot behind an active caption and
 * the next one-shot caption would be dropped. Other events have no caption (#394:
 * invasion_start's one-shot caption is gone — the army warning announces every
 * invasion wave instead).
 */
export function routeEventCaption(ev: SimEvent, rampage: RampageCaptionState): void {
  if (ev.type === 'spider_rampage_start') {
    noteRampageStart(rampage, ev.tick, ev.payload.hungerTicks);
  }
}
