// counter-attack-caption.ts — playtest 4: after an invasion of the player's colony
// ends in a fighter rout, tell the player to strike back while the enemy's army is
// broken.
//
// Playtest 4 found that the captions teach only defence: a novice who follows every
// one of them (more fighters, a rally on each army warning) routs most waves but
// never attacks, so it wins no game, even on Easy. The window to win is right after a
// rout: the AI then spends AI_RECOVERY_DURATION_TICKS in Recovery and its home army
// stays depleted until it musters the next wave. This caption names that window.
//
// The trigger: an invasion launched at the viewing colony ends in a FIGHTER ROUT
// (ai-state.ts _checkInvadingToRecovery: fewer than 3 of its committed cohort alive;
// _endInvasion emits the invasion_end, whose `outcome` says how it ended), AND the
// attacker's whole army is broken then: fewer fighters than the tier's base invasion
// need (AI_INVADING_FIGHTER_THRESHOLD), so it could not launch again. The rout counts
// only the committed cohort, which is capped at AI_MAX_OPERATION_FIGHTERS: an AI that
// held a big army at home (#421's food-gate holds: up to 87 fighters) may rout a wave
// of 32 and keep 50 at home, and "their army is broken" would send the player into a
// slaughter. The whole army is read from the ai_state_transition (Invading → Recovery)
// the same AI step emits right after the invasion_end, on the same tick
// (triggerValues.aiFighterCount), so it is the army at the rout. In the novice games
// measured for this caption (playtest 4's harness, seeds 0-39 Easy and 0-19 Normal) the
// AI's army just after a rout never reached the base need (at most 13 on Easy, 12 on
// Normal), so this holds back only the big-army case. Nothing else owes it:
//   - not the timeout (outcome 'timeout'): the invaders are still alive, out there;
//   - not a pre-cohort timeout (no cohort was committed, so no army was beaten):
//     the AI goes to Recovery without an invasion_end (only ai_state_transition);
//   - not a queen kill ('queen_kill'): the match is over;
//   - not a wave of the viewer's own colony (a player-colony AI, the --both-ai
//     harness) routed at an enemy nest: the attacker's opponent must be the viewer
//     (ai-state.ts opponentColonyId, the colony an AI invades), so any colony may be
//     the viewer (CLNY-08).
// WHAT it says depends on the viewer's own army (the army gate, from Fable's review and
// the economy-captions measurement): the Assault copy only when the army can win
// (counterAttackArmyReady: at least COUNTER_ATTACK_READY_FIGHTERS fighters and
// COUNTER_ATTACK_READY_MARGIN more than the attacker's whole army). Pooled over the
// caption-following novice's counter-attacks, an Assault with fewer than 8 fighters
// won 1% (Easy) / 0% (Normal) of the time, and one past this gate 69% / 55%. An army
// short of it gets COUNTER_ATTACK_BUILD_UP_TEXT ("… train more fighters, then strike
// …") instead, and the Assault copy follows, once, the first tick the army is ready
// (noteCounterAttackTick, per sim tick) within COUNTER_ATTACK_FOLLOW_UP_TICKS, unless
// the attacker invades or probes again first or a queen dies. The copy is chosen as
// the queue takes the caption, on the frame's projected world. (With more than two
// colonies, a follow-up owed in the same frame as another attacker's fresh rout would
// replace it; opponentColonyId assumes two colonies today.)
//
// Every such rout owes it again, so it repeats as the storage hint does, but not within
// COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS of the last rout it was owed for. The cooldown
// runs from that rout, not from when the caption showed (raid news starts its cooldown
// when the queue takes it): which routs owe it must not depend on the frame it showed
// in. With two colonies this never holds a wave back (see the constant); with more, a
// caption that went stale unshown still holds back another attacker's rout for 60 s.
//
// It DECIDES per sim tick and PRESENTS per render frame (#416 review, queen-danger.ts).
// The game loop runs up to MAX_CATCHUP_TICKS ticks in one frame, so a rule judged on
// the world a frame leaves would depend on how the ticks were batched. Each rout is
// therefore judged on its own events, in tick order, dated by the events' tick:
// GameScene passes every new event to noteCounterAttackEvent (consumeEventsForRender,
// which reads the events of every tick run while Playing once, however the ticks were
// batched: by tick, not by index; an invasion_end or ai_state_transition is always
// appended, even at the event cap, unless the buffer holds nothing but terminal
// events). The army check and the cooldown use only the events, so which routs owe the
// caption is the same for any batching. The follow-up after the build-up copy is
// decided per tick too (noteCounterAttackTick in beforeSimTick). The frame step
// (offerCounterAttackCaption) presents what is owed; all it decides is which copy the
// queue takes, from the army as it stands then, and (for the build-up copy) when the
// follow-up's window opens.
//
// It is a RECURRING caption (recurring-captions.ts offerRecurringCaption): it enters
// the caption queue only while the queue is fully idle, so it never takes the pending
// slot a one-shot caption would need, and it stays owed, offered again every frame,
// for COUNTER_ATTACK_CAPTION_OWED_TICKS. While it is owed, a long caption on screen
// gives way and the storage hint waits (recurringCaptionStillOwed), so it comes next.
// GameScene offers it after the army warning and the rampage warning (threats to the
// colony come first) and before raid news. Raid news owed behind it (an invasion
// raids the player's larder) shortens its own 4 s hold to the 2 s readable floor, as
// it does the army warning's: the accepted cost of a long caption being readable.
// Owed, it goes stale once that window has passed; once either queen is dead (the
// match is over; GameScene stops offering captions at game over anyway, and UIScene
// closes the queue); or once the player is already doing what it says (an Assault
// order on that colony's entrance), judged on the frame.
//
// Render-side session state only: reads world state and events, writes nothing, saves
// nothing (a loaded save starts with none owed: saves keep no events). Pure and
// Phaser-free; GameScene owns the state.

import type { WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { RaidType } from '../sim/enums.js';
import {
  aiFighterCount,
  getAIStateForColony,
  opponentColonyId,
  tierIndex,
} from '../sim/ai-state.js';
import { AI_INVADING_FIGHTER_THRESHOLD } from '../sim/constants.js';
import { rallyEnemyEntrance } from '../sim/raid-order.js';
import { offerRecurringCaption, type RecurringCaptionSink } from './recurring-captions.js';
import { GATHER_CAPTION_HOLD_MS } from './enemy-gathering.js';

/**
 * The caption. Its second sentence names the raid menu's Assault order
 * (raid-order-view.ts: "Fighters ignore food and go for the queen"), in the order
 * caption's "Raiding: Assault." style, and how to open the menu: right-click an enemy
 * entrance on the surface, or long-press it on a touch screen. Two lines at the top
 * caption's wrap width. A plain tap on their entrance raids with Loot, whose fighters
 * go for the queen only once there is nothing left to take; in the playtest 4 novice
 * games (Easy, seeds 0-39) a Loot counter-attack hit the enemy queen 4 times in 112,
 * an Assault 18 times in 106.
 */
export const COUNTER_ATTACK_CAPTION_TEXT =
  'Their army is broken — strike their nest now! Assault: right-click or long-press their entrance.';

/** Full-opacity hold (ms): the army warning's (GATHER_CAPTION_HOLD_MS), as it must be
 *  read. Like it, it gives way to a caption owed behind it (caption-queue.ts
 *  CAPTION_YIELD_FLOOR_MS). */
export const COUNTER_ATTACK_CAPTION_HOLD_MS = GATHER_CAPTION_HOLD_MS;

/**
 * How long (ticks, 20 s) a caption the busy queue has not taken is still offered.
 * Longer than raid news' 10 s (RAID_CAPTION_OWED_TICKS): captions run on the wall
 * clock, so at 4x a long caption that gives way (2.7 s with its fades) and a one-shot
 * waiting behind it (1.5 s) hold the queue for ~17 s of game time; and the window it
 * is about stays open for the whole of the AI's Recovery (AI_RECOVERY_DURATION_TICKS,
 * 60 s). On an idle queue it shows on the frame that runs the rout's tick.
 */
export const COUNTER_ATTACK_CAPTION_OWED_TICKS = 400;

/**
 * Ticks (60 s) after a rout the caption was owed for in which another rout owes it
 * no more. No more than the AI's Recovery (AI_RECOVERY_DURATION_TICKS): one colony
 * cannot rout twice inside that, so every wave of one attacker gets its caption, and
 * a burst of routs (several attackers at once) cannot repeat it back to back.
 */
export const COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS = 1200;

/**
 * The army gate: the Assault copy only when the viewer's army can win. Over the
 * caption-following novice's counter-attacks (playtest 4's harness and its economy-
 * captions copies, every same-sim run: 1,041 on Easy, 507 on Normal), an Assault won
 * (Easy / Normal): with fewer than 8 fighters 1% / 0%; with 8-11, 13% / 5%; with at
 * least max(8, their whole army) 51% / 42%; with at least
 * COUNTER_ATTACK_READY_FIGHTERS and COUNTER_ATTACK_READY_MARGIN more than their whole
 * army 69% / 55%.
 */
export const COUNTER_ATTACK_READY_FIGHTERS = 12;
export const COUNTER_ATTACK_READY_MARGIN = 4;

/** The caption when the viewer's army is not ready (counterAttackArmyReady false). It
 *  says what to do but not how to strike: the Assault copy, which says how, follows
 *  once the army is ready. If the follow-up lapses first (its window, a new wave), that
 *  rout gets no Assault copy; the next rout does. By then their army may be rebuilding
 *  ("broken" is about the rout), which the ready margin allows for. */
export const COUNTER_ATTACK_BUILD_UP_TEXT =
  'Their army is broken — train more fighters, then strike their nest while they recover.';

/**
 * After the build-up caption, how long (ticks, 4 min) the Assault caption may still
 * follow once the viewer's army is ready, unless the attacker invades (or probes)
 * again first. Waves come about 4.4 minutes apart on Normal (playtest 4).
 */
export const COUNTER_ATTACK_FOLLOW_UP_TICKS = 4800;

/**
 * `viewerColonyId`'s army can take on `attackerId`'s: at least
 * COUNTER_ATTACK_READY_FIGHTERS alive fighters, and COUNTER_ATTACK_READY_MARGIN more
 * than the attacker's whole army (aiFighterCount: every alive Fighting ant, wherever).
 */
export function counterAttackArmyReady(
  world: WorldState,
  viewerColonyId: ColonyId,
  attackerId: ColonyId,
): boolean {
  const mine = aiFighterCount(world, viewerColonyId);
  return (
    mine >= COUNTER_ATTACK_READY_FIGHTERS &&
    mine - aiFighterCount(world, attackerId) >= COUNTER_ATTACK_READY_MARGIN
  );
}

export interface CounterAttackCaptionState {
  /** The tick of the rout (its invasion_end) the caption is owed for and has not shown
   *  yet, or, for the follow-up Assault copy, the tick the army became ready (null:
   *  none owed). */
  owedRoutTick: number | null;
  /** The owed caption is the follow-up: it takes the Assault copy whatever the army
   *  reads when the queue takes it, so the build-up copy shows at most once per rout. */
  owedFollowUp: boolean;
  /** The colony whose wave was routed then: the nest to strike (meaningful while owed). */
  owedAttackerId: ColonyId;
  /** The tick of the last rout the caption was owed for (null: none this round). The
   *  cooldown runs from it. */
  lastRoutTick: number | null;
  /** The tick of a fighter rout read whose colony's next AI event (its Invading →
   *  Recovery transition, from the same AI step) has not been read yet: that decides
   *  it. Null: none. */
  routSeenTick: number | null;
  /** The routed colony then (meaningful while routSeenTick is set). */
  routSeenAttackerId: ColonyId;
  /** The tick the build-up caption showed (null: none pending): the Assault caption is
   *  owed once the viewer's army is ready, within COUNTER_ATTACK_FOLLOW_UP_TICKS. */
  buildUpTick: number | null;
  /** The colony the build-up caption was about (meaningful while buildUpTick is set). */
  buildUpAttackerId: ColonyId;
}

export function createCounterAttackCaptionState(): CounterAttackCaptionState {
  return {
    owedRoutTick: null,
    owedFollowUp: false,
    owedAttackerId: -1,
    lastRoutTick: null,
    routSeenTick: null,
    routSeenAttackerId: -1,
    buildUpTick: null,
    buildUpAttackerId: -1,
  };
}

/**
 * Economy captions — once per sim tick (sim-tick-hook.ts beforeSimTick, and GameScene
 * for the frame's last tick): after the build-up caption, owe the Assault caption the
 * first tick the viewer's army is ready (counterAttackArmyReady). The follow-up lapses
 * after COUNTER_ATTACK_FOLLOW_UP_TICKS, once the attacker invades or probes again, or
 * once either queen is dead. Read-only on the world.
 */
export function noteCounterAttackTick(
  state: CounterAttackCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  const since = state.buildUpTick;
  if (since === null) return;
  const attacker = state.buildUpAttackerId;
  const aiState = getAIStateForColony(world, attacker)?.state;
  if (
    world.tick < since ||
    world.tick - since > COUNTER_ATTACK_FOLLOW_UP_TICKS ||
    aiState === 'Invading' ||
    aiState === 'Probing' ||
    !queenAlive(world, viewerColonyId) ||
    !queenAlive(world, attacker)
  ) {
    state.buildUpTick = null;
    return;
  }
  if (!counterAttackArmyReady(world, viewerColonyId, attacker)) return;
  state.buildUpTick = null;
  state.owedRoutTick = world.tick;
  state.owedFollowUp = true;
  state.owedAttackerId = attacker;
}

/**
 * The colony whose invasion of `viewerColonyId` event `ev` reports routed (its
 * invasion_end with outcome 'fighter_rout'), or null for any other event: another
 * outcome, or an invasion of another colony (the attacker invades its opponent,
 * opponentColonyId, which is never the attacker itself, so a wave of the viewer's
 * own is never the viewer's). Reads only.
 */
export function routedWaveAttacker(
  ev: SimEvent,
  world: WorldState,
  viewerColonyId: ColonyId,
): ColonyId | null {
  if (ev.type !== 'invasion_end' || ev.payload.outcome !== 'fighter_rout') return null;
  const attacker = ev.payload.colonyId;
  return opponentColonyId(world, attacker) === viewerColonyId ? attacker : null;
}

/**
 * An army of `fighters` is broken in `world`: fewer than its tier's base invasion
 * need (AI_INVADING_FIGHTER_THRESHOLD), so it could not launch another invasion.
 */
export function armyBroken(world: WorldState, fighters: number): boolean {
  return fighters < AI_INVADING_FIGHTER_THRESHOLD[tierIndex(world.difficulty)];
}

/**
 * GameScene.consumeEventsForRender's step for each new event, in order. A fighter rout
 * of a wave launched at `viewerColonyId` (routedWaveAttacker) is noted, and the routed
 * colony's next AI event (its next invasion_end or ai_state_transition) decides it:
 * the AI step that ends an invasion emits the invasion_end and then that colony's
 * Invading → Recovery transition, on the same tick. If that is what comes, the caption
 * is owed, as of that tick, when the colony's whole army then is broken (armyBroken,
 * from the transition's aiFighterCount) and the tick is not within
 * COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS of the last rout that owed it. Anything else
 * (no such transition) owes nothing. A rout owes it afresh even if the last one's is
 * still owed unshown.
 */
export function noteCounterAttackEvent(
  state: CounterAttackCaptionState,
  ev: SimEvent,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  if (ev.type !== 'invasion_end' && ev.type !== 'ai_state_transition') return;
  const seenTick = state.routSeenTick;
  if (seenTick !== null && ev.payload.colonyId === state.routSeenAttackerId) {
    state.routSeenTick = null;
    if (
      ev.type === 'ai_state_transition' &&
      ev.tick === seenTick &&
      ev.payload.from === 'Invading' &&
      ev.payload.to === 'Recovery'
    ) {
      oweIfBroken(
        state,
        world,
        ev.tick,
        ev.payload.colonyId,
        ev.payload.triggerValues.aiFighterCount,
      );
      return;
    }
  }
  const attacker = routedWaveAttacker(ev, world, viewerColonyId);
  if (attacker !== null) {
    state.routSeenTick = ev.tick;
    state.routSeenAttackerId = attacker;
  }
}

/** The rout of `attackerId` on `routTick`, its army then `fighters`, owes the caption
 *  if that army is broken and the cooldown since the last rout that owed it is up. */
function oweIfBroken(
  state: CounterAttackCaptionState,
  world: WorldState,
  routTick: number,
  attackerId: ColonyId,
  fighters: number,
): void {
  if (!armyBroken(world, fighters)) return;
  const last = state.lastRoutTick;
  if (
    last !== null &&
    routTick >= last &&
    routTick - last < COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS
  ) {
    return;
  }
  state.lastRoutTick = routTick;
  state.owedRoutTick = routTick;
  state.owedFollowUp = false;
  state.owedAttackerId = attackerId;
}

function queenAlive(world: WorldState, colonyId: ColonyId): boolean {
  const colony = world.colonies[colonyId];
  return colony !== undefined && world.ants.alive[colony.queenEntityId] === 1;
}

/** `viewerColonyId` is giving an Assault order on an entrance of `attackerId` (its
 *  rally is on one, with raid type Assault): it is already doing what the caption says. */
function alreadyAssaulting(
  world: WorldState,
  viewerColonyId: ColonyId,
  attackerId: ColonyId,
): boolean {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined || viewer.raidType !== RaidType.Assault) return false;
  const target = rallyEnemyEntrance(world, viewer);
  return target !== null && (world.colonies[attackerId]?.entrances.includes(target) ?? false);
}

/**
 * Is the owed caption out of date in `world`: more than
 * COUNTER_ATTACK_CAPTION_OWED_TICKS past its rout (or before it: a world that went
 * back), either queen dead (the match is over), or the viewer already giving an
 * Assault order on the routed colony's entrance? False when none is owed. Reads only.
 */
export function counterAttackCaptionStale(
  state: CounterAttackCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
): boolean {
  const routTick = state.owedRoutTick;
  if (routTick === null) return false;
  const age = world.tick - routTick;
  return (
    age < 0 ||
    age > COUNTER_ATTACK_CAPTION_OWED_TICKS ||
    !queenAlive(world, viewerColonyId) ||
    !queenAlive(world, state.owedAttackerId) ||
    alreadyAssaulting(world, viewerColonyId, state.owedAttackerId)
  );
}

/**
 * GameScene's per-frame step: offers the owed caption to the queue
 * (offerRecurringCaption: it enters only while the queue is idle), or drops it unshown
 * once it is stale (counterAttackCaptionStale). Returns true iff it was shown this call;
 * it is then no longer owed. GameScene passes its projected world (queued commands
 * folded in: the same tick, ants and colonies, plus the player's orders not yet
 * drained), so an Assault order picked while paused already counts.
 */
export function offerCounterAttackCaption(
  state: CounterAttackCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
  ui: RecurringCaptionSink,
  screenX: number,
  screenY: number,
): boolean {
  if (state.owedRoutTick === null) return false;
  if (counterAttackCaptionStale(state, world, viewerColonyId)) {
    state.owedRoutTick = null;
    return false;
  }
  // Economy captions: the Assault copy only when the army can win; otherwise the
  // build-up copy, and the Assault copy follows once it can (noteCounterAttackTick).
  const attacker = state.owedAttackerId;
  const ready = state.owedFollowUp || counterAttackArmyReady(world, viewerColonyId, attacker);
  if (
    !offerRecurringCaption(
      ui,
      ready ? COUNTER_ATTACK_CAPTION_TEXT : COUNTER_ATTACK_BUILD_UP_TEXT,
      screenX,
      screenY,
      COUNTER_ATTACK_CAPTION_HOLD_MS,
    )
  ) {
    return false;
  }
  state.owedRoutTick = null;
  state.buildUpTick = ready ? null : world.tick;
  state.buildUpAttackerId = attacker;
  return true;
}

/** After this frame's offer, is the caption still owed (the queue was busy)? GameScene
 *  passes it to recurringCaptionStillOwed: a long caption on screen then gives way and
 *  the storage hint is held back, as for any owed recurring caption. */
export function counterAttackCaptionOwed(state: CounterAttackCaptionState): boolean {
  return state.owedRoutTick !== null;
}
