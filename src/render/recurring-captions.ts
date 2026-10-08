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
//   - the spider-rampage warning (#397) is shown ONCE per hungry spell: owed
//     while the rampage threatens the viewing colony — by the V68 rampage
//     shelter's own threat rule (rampageThreatRule), so it comes as that
//     colony's idle workers head underground — and, once shown, not owed again
//     until the spider has fed (spiderOnRampage false: it has eaten, or is
//     gone). Every chase divert restarts the sim's rampage (88-144 starts in a
//     long match), so keying the warning on spider_rampage_start, as #350 did,
//     showed it again and again; and a rampage at another colony's door does
//     not concern the viewer at all.
//     Once owed it stays owed while the spider is still out hunting hungry,
//     whether or not it still threatens the colony (it was at the door a moment
//     ago), for up to RAMPAGE_CAPTION_OWED_TICKS; if that runs out unshown, a
//     threat that is still there owes it afresh. It goes stale when the spider
//     has eaten or is gone (or is in Retreating, a pre-V23 state the spider
//     normalizes away every tick). "Has eaten" is read
//     from its hunger, not its state: a kill always resets hungerTicks to 0, but
//     a kill made while a fighter is still adjacent does not enter Feeding (the
//     spider stays in its state and keeps fighting). Without a meal hungerTicks
//     never decreases, so it falling below its value when the warning became
//     owed means the spider has eaten by some path.
//   - (playtest 4) the counter-attack caption after a fighter rout
//     (counter-attack-caption.ts) stays owed for COUNTER_ATTACK_CAPTION_OWED_TICKS;
//   - (economy captions) the stores-filling caption (stores-filling-caption.ts)
//     stays owed for STORES_FILLING_OWED_TICKS.
//
// GameScene offers the owed rampage warning before raid news each frame, so a
// rampage outranks raid news when both wait on the same idle queue; the
// counter-attack caption comes between them. The stores-filling caption is advice:
// offered after every other caption but the storage hint, and, owed, it makes no long
// caption give way (it is not part of recurringCaptionStillOwed).
//
// Pure + Phaser-free: GameScene owns the state and passes its UIScene in.

import type { SpiderBehaviorState, WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { rampageThreatRule } from '../sim/ant/ant-system.js';
import { spiderOnRampage } from '../sim/spider.js';
import { captionText } from './onboarding-captions.js';

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
 * army warning, the #395 storage hint, the playtest 4 counter-attack caption) hold
 * longer; while news (or, behind the hint, an army warning) is owed they shorten to
 * a 2 s readable floor (2.7 s in all, UIScene.yieldLongCaption), so at 4x (a 2.5 s
 * real-time window) news owed from the same moment one began can still expire behind
 * it, as can a march or gathering warning behind the hint (its own window,
 * ARMY_CAPTION_OWED_TICKS, is also 200). So can news owed while an invasion's
 * launch warning (owed until shown, #404 review) waited out the same busy queue,
 * which it then enters first. That is a known cost of a once-per-spell
 * caption being readable, and of an army outranking news.
 */
export const RAMPAGE_CAPTION_OWED_TICKS = 200;

/** Spider states in which the warning is stale: it is eating, or in Retreating (a
 *  pre-V23 state tickSpiderV23 turns back into Patrolling every tick). A meal is
 *  also detected from hunger (see offerOwedRampageCaption). */
const RAMPAGE_OVER_STATES: ReadonlySet<SpiderBehaviorState> = new Set(['Feeding', 'Retreating']);

export interface RampageCaptionState {
  /** world.tick the warning became owed and has not shown yet (-Infinity: none
   *  owed). */
  owedSinceTick: number;
  /** The spider's hungerTicks then. Hunger below this means the spider has eaten
   *  since. */
  owedHungerTicks: number;
  /** #397 — the warning has been shown this hungry spell: it is not owed again
   *  until the spider has fed. */
  announced: boolean;
}

export function createRampageCaptionState(): RampageCaptionState {
  return { owedSinceTick: -Infinity, owedHungerTicks: 0, announced: false };
}

/** New round or loaded save: nothing owed, nothing announced. */
export function resetRampageCaptionState(state: RampageCaptionState): void {
  state.owedSinceTick = -Infinity;
  state.owedHungerTicks = 0;
  state.announced = false;
}

/** Owe the warning from `tick`, with the spider's `hungerTicks` then. */
export function oweRampageCaption(
  state: RampageCaptionState,
  tick: number,
  hungerTicks: number,
): void {
  state.owedSinceTick = tick;
  state.owedHungerTicks = hungerTicks;
}

/**
 * #397 — the spider on a rampage (spiderOnRampage) threatens colony
 * `viewerColonyId` by the rampage shelter's own threat rule (idle-reserve.ts
 * rampageThreatRule: camping, or on its way to camp, one of the colony's entrances,
 * or within RAMPAGE_THREAT_RADIUS_TILES of an open one). That is exactly the sim's
 * rampageThreatens (V68), so the warning comes as that colony's idle workers head
 * underground. Reads only; any colony may be the viewer (CLNY-08).
 */
export function rampageThreatensViewer(world: WorldState, viewerColonyId: ColonyId): boolean {
  const colony = world.colonies[viewerColonyId];
  if (colony === undefined) return false;
  return spiderOnRampage(world) && rampageThreatRule(world, colony);
}

/**
 * #397 — the threat to colony `viewerColonyId` as the sim's rampage shelter saw it
 * (step 15b) during the tick that took `prev` to `world`. Step 15b runs after step 12,
 * which may open an entrance that tick, and before the spider moves (step 17.5): a
 * shaft finished near the spider, which then walks out of reach, sends the colony's
 * idle workers in although the world before and after the tick shows no threat.
 * Only tickSpider changes the spider, entrances only ever open (step 12), and
 * world.tick advances at the end of the tick, so step 15b saw `prev`'s spider and
 * tick with `world`'s entrances. The caller passes `prev` as `world`'s own snapshot
 * (GameScene's interpolation snapshot, taken just before each tick); this reads it
 * only when it is exactly one tick behind (a new round or a loaded save copies the
 * world at its own tick, so not before its first tick). Reads only.
 */
export function rampageThreatenedViewerLastTick(
  prev: WorldState,
  world: WorldState,
  viewerColonyId: ColonyId,
): boolean {
  if (prev.tick + 1 !== world.tick) return false;
  const colony = world.colonies[viewerColonyId];
  if (colony === undefined) return false;
  return spiderOnRampage(prev) && rampageThreatRule(prev, colony);
}

/**
 * #397 — called before every sim tick (sim-tick-hook.ts beforeSimTick: a frame
 * can run several ticks, and a threat may last only one of them) and each frame
 * before offerOwedRampageCaption (for the frame's last tick). While the rampage
 * threatens the viewing colony and nothing is owed, it owes the warning — unless
 * it has already been shown this hungry spell. It asks about the world now
 * (rampageThreatensViewer) and, with `prev` the world one tick earlier, about the
 * tick between them as the rampage shelter saw it (rampageThreatenedViewerLastTick).
 * The spell ends when the spider is no longer on a rampage (spiderOnRampage false:
 * a meal resets its hunger; a spider that is gone hunts nothing), which re-arms
 * it. Nothing else does: not its state (a hungry spider in the leftover
 * Retreating state has not fed).
 */
export function noteRampageThreat(
  state: RampageCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
  prev: WorldState | null,
): void {
  if (!spiderOnRampage(world)) {
    state.announced = false;
    return;
  }
  if (state.announced || state.owedSinceTick !== -Infinity) return;
  if (
    !rampageThreatensViewer(world, viewerColonyId) &&
    !(prev !== null && rampageThreatenedViewerLastTick(prev, world, viewerColonyId))
  ) {
    return;
  }
  oweRampageCaption(state, world.tick, world.spider!.hungerTicks);
}

/**
 * Called each frame. Shows the owed rampage warning once the queue is idle — it
 * is then announced for this hungry spell (noteRampageThreat) — or drops it
 * unshown once it is stale (see the header). Returns true iff it was shown this
 * call.
 */
export function offerOwedRampageCaption(
  state: RampageCaptionState,
  world: Pick<WorldState, 'spider' | 'tick'>,
  ui: RecurringCaptionSink,
  screenX: number,
  screenY: number,
): boolean {
  if (state.owedSinceTick === -Infinity) return false;
  if (
    world.spider === null ||
    RAMPAGE_OVER_STATES.has(world.spider.state) ||
    world.spider.hungerTicks < state.owedHungerTicks || // it has eaten since
    world.tick - state.owedSinceTick > RAMPAGE_CAPTION_OWED_TICKS
  ) {
    state.owedSinceTick = -Infinity; // stale: drop it
    return false;
  }
  if (!offerRecurringCaption(ui, captionText('spiderRampage'), screenX, screenY)) return false;
  state.owedSinceTick = -Infinity;
  state.announced = true;
  return true;
}

/**
 * #372 — after this frame's offers, is a recurring caption still owed: the army
 * warning (`armyWarningOwed`: offered this frame and not taken), the rampage
 * warning, or the raid caption `raidCaption` that was not taken? GameScene then
 * asks a long-hold caption to give way (UIScene.yieldLongCaption).
 * `armyWarningOwed` (#395): the storage hint is a long-hold caption too, and an
 * army warning owed behind it would otherwise wait its full 4 s; a march or
 * gathering warning would, at 4x, go stale (ARMY_CAPTION_OWED_TICKS) unshown (an
 * invasion's launch warning is owed until shown). Giving way narrows that to a
 * warning owed in the hint's first ~0.2 s at 4x (see RAMPAGE_CAPTION_OWED_TICKS).
 * The warning being offered is never itself the caption showing: once shown it is
 * no longer owed. While this is true GameScene also holds the storage hint back,
 * and withdraws one waiting, so the owed caption comes next.
 * `counterAttackOwed` (playtest 4): the counter-attack caption after a fighter rout
 * (counter-attack-caption.ts counterAttackCaptionOwed), offered this frame and not
 * taken, is owed the same way.
 */
export function recurringCaptionStillOwed(
  rampage: RampageCaptionState,
  raidCaption: string | null,
  armyWarningOwed: boolean,
  counterAttackOwed: boolean,
): boolean {
  return (
    armyWarningOwed ||
    counterAttackOwed ||
    rampage.owedSinceTick !== -Infinity ||
    raidCaption !== null
  );
}
