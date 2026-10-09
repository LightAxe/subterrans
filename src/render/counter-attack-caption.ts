// counter-attack-caption.ts — playtest 4: after an invasion of the player's colony
// ends in a fighter rout, tell the player to strike back while the enemy's army is
// broken. (Rationale: CONTEXT.md §Counter-attack caption; measurements: the
// constants' doc comments below.)
//
// TRIGGER. An invasion launched at the viewing colony ends in a FIGHTER ROUT
// (invasion_end, outcome 'fighter_rout'; the attacker's opponentColonyId is the
// viewer), AND the attacker's whole army is broken: the same-tick Invading → Recovery
// ai_state_transition carries triggerValues.aiFighterCount, which must be below the
// tier's AI_INVADING_FIGHTER_THRESHOLD (the rout counts only the committed cohort, so
// a big army kept at home must not read as broken). Not owed for a timeout, a
// pre-cohort timeout (no invasion_end), a queen kill, or a wave of the viewer's own
// colony. Every such rout owes it again, but not within
// COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS of the last rout it was owed for (the cooldown
// runs from that rout, not from when the caption showed).
//
// THE ARMY GATE. The Assault copy is used only when counterAttackArmyReady: at least
// COUNTER_ATTACK_READY_FIGHTERS fighters and COUNTER_ATTACK_READY_MARGIN more than the
// attacker's whole army. Otherwise COUNTER_ATTACK_BUILD_UP_TEXT is shown, and the
// Assault copy follows once, the first tick the army is ready, within
// COUNTER_ATTACK_FOLLOW_UP_TICKS, unless the attacker invades or probes again or a
// queen dies. The copy is chosen as the queue takes the caption, on the projected
// world. The gate (counterAttackArmyReady) is read in two places, the frame step's copy
// choice and the follow-up's per-tick check (noteCounterAttackTick), and decides the
// same way in both.
//
// DECIDES PER SIM TICK, PRESENTS PER RENDER FRAME (#416 review, queen-danger.ts), so
// the outcome does not depend on how ticks are batched into frames. Each rout is
// judged on its own events, in tick order, dated by the events' tick: GameScene passes
// every new event to noteCounterAttackEvent (consumeEventsForRender), and the
// follow-up is decided by noteCounterAttackTick in beforeSimTick. The frame step
// (offerCounterAttackCaption) presents what is owed and picks the copy.
//
// PRESENTATION. A RECURRING caption (recurring-captions.ts offerRecurringCaption): it
// enters the queue only while the queue is fully idle and stays owed, offered every
// frame, for COUNTER_ATTACK_CAPTION_OWED_TICKS; while owed, a long caption gives way
// and the storage hint waits (recurringCaptionStillOwed). GameScene offers it after
// the army and rampage warnings and before raid news.
//
// STALENESS. Owed, it is dropped unshown once the owed window has passed, once either
// queen is dead, or once the player is already doing what it says (an Assault order on
// that colony's entrance, judged on the frame's projected world).
//
// JEV OPPONENT (beta branch). A Jev-driven colony never invades through the AI
// machinery: it attacks with a rally on the viewer's entrance, and the AI state
// machine it leaves running never ends an invasion it did not start (so no
// invasion_end, and its `Invading` state means nothing). For the colonies GameScene
// lists as RALLY ATTACKERS (setRallyAttackers: the seats Jev is driving), the trigger
// is instead the rally leaving the viewer's entrance (the assault is over: called
// home, retargeted elsewhere or cleared), judged per tick by noteCounterAttackTick,
// when the assault was ROUTED — its army now no more than
// COUNTER_ATTACK_RALLY_ROUT_PCT of its peak while the rally was on the viewer's door
// (the rules AI's rout is its committed cohort nearly wiped out; Jev commits no
// cohort, and its drafts keep joining the rally) — and the same broken-army test
// holds (its whole army, aiFighterCount, below the tier's base need). Cooldown, copy
// and army gate are the rout path's. "Invades again" (which lapses a follow-up) is
// the rally back on the viewer's entrance. (Playtest 5, #436: the caption fired 0
// times in 30 games against a Jev stand-in.)
//
// Render-side session state only: reads world state and events, writes nothing, saves
// nothing (a loaded save starts with none owed). Pure and Phaser-free; GameScene owns
// the state.

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
import { ARMY_CAPTION_HOLD_MS } from './army-warning.js';

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

/** Full-opacity hold (ms): the army warning's (ARMY_CAPTION_HOLD_MS), as it must be
 *  read. Like it, it gives way to a caption owed behind it (caption-queue.ts
 *  CAPTION_YIELD_FLOOR_MS). */
export const COUNTER_ATTACK_CAPTION_HOLD_MS = ARMY_CAPTION_HOLD_MS;

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
  /** Jev opponent: the colonies whose attacks are rallies on the viewer's entrance
   *  (setRallyAttackers). Empty: every attacker is the rules AI. */
  rallyAttackers: ColonyId[];
  /** Of `rallyAttackers`, those whose rally was on one of the viewer's entrances at the
   *  last look (noteCounterAttackTick), each with its largest army (aiFighterCount)
   *  seen while it was. */
  rallyOnViewer: { readonly attackerId: ColonyId; peakArmy: number }[];
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
    rallyAttackers: [],
    rallyOnViewer: [],
  };
}

/**
 * Jev opponent: name the colonies whose attacks are rallies (GameScene: the seats Jev
 * is driving; a seat that falls back to the rules AI leaves the list). A colony that
 * leaves it is forgotten mid-assault: its rally ending owes nothing.
 */
export function setRallyAttackers(
  state: CounterAttackCaptionState,
  colonyIds: readonly ColonyId[],
): void {
  state.rallyAttackers = [...colonyIds];
  state.rallyOnViewer = state.rallyOnViewer.filter((r) => colonyIds.includes(r.attackerId));
}

/**
 * Jev opponent: an assault by rally that ends with its attacker's army at or below
 * this percentage of the army's peak while the rally was on the viewer's door was
 * routed (Fable review: 14 mustered fighters called home before contact are below
 * Normal's base need of 15, but not broken).
 */
export const COUNTER_ATTACK_RALLY_ROUT_PCT = 50;

/** `attackerId`'s rally is on one of `viewerColonyId`'s entrances (open or closed). */
function rallyOnViewerEntrance(
  world: WorldState,
  attackerId: ColonyId,
  viewerColonyId: ColonyId,
): boolean {
  const attacker = world.colonies[attackerId];
  if (attacker === undefined) return false;
  const target = rallyEnemyEntrance(world, attacker);
  return target !== null && (world.colonies[viewerColonyId]?.entrances.includes(target) ?? false);
}

/** `attackerId` is attacking `viewerColonyId` (again): a rally attacker's rally is on
 *  the viewer's entrance; the rules AI is Invading or Probing. */
function attacking(
  state: CounterAttackCaptionState,
  world: WorldState,
  attackerId: ColonyId,
  viewerColonyId: ColonyId,
): boolean {
  if (state.rallyAttackers.includes(attackerId)) {
    return rallyOnViewerEntrance(world, attackerId, viewerColonyId);
  }
  const ai = getAIStateForColony(world, attackerId)?.state;
  return ai === 'Invading' || ai === 'Probing';
}

/**
 * Jev opponent: each rally attacker whose rally has left the viewer's entrance since
 * the last look ended an assault on this tick; it owes the caption if the assault was
 * routed (its army now at most COUNTER_ATTACK_RALLY_ROUT_PCT of its peak during the
 * assault) and its whole army is broken now (oweIfBroken, the rout path's test and
 * cooldown). While the rally is on the door, the peak is kept up to date. Idempotent
 * for one world state (GameScene's frame step and the next beforeSimTick both look at
 * the frame's last tick).
 */
function noteRallyAssaults(
  state: CounterAttackCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  for (const attacker of state.rallyAttackers) {
    const on = rallyOnViewerEntrance(world, attacker, viewerColonyId);
    const army = aiFighterCount(world, attacker);
    const rec = state.rallyOnViewer.find((r) => r.attackerId === attacker);
    if (on) {
      if (rec === undefined) state.rallyOnViewer.push({ attackerId: attacker, peakArmy: army });
      else if (army > rec.peakArmy) rec.peakArmy = army;
      continue;
    }
    if (rec === undefined) continue;
    state.rallyOnViewer = state.rallyOnViewer.filter((r) => r !== rec);
    if (army * 100 <= rec.peakArmy * COUNTER_ATTACK_RALLY_ROUT_PCT) {
      oweIfBroken(state, world, world.tick, attacker, army);
    }
  }
}

/**
 * Economy captions — once per sim tick (sim-tick-hook.ts beforeSimTick, and GameScene
 * for the frame's last tick): after the build-up caption, owe the Assault caption the
 * first tick the viewer's army is ready (counterAttackArmyReady). The follow-up lapses
 * after COUNTER_ATTACK_FOLLOW_UP_TICKS, once the attacker invades or probes again (also
 * when already owed behind a busy queue), or once either queen is dead. Jev opponent:
 * first, a rally attacker's assault that ended since the last look owes the caption
 * (noteRallyAssaults), and for a rally attacker "invades again" is its rally back on
 * the viewer's entrance. Read-only on the world.
 */
export function noteCounterAttackTick(
  state: CounterAttackCaptionState,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  // Jev opponent: an assault by rally that ended since the last look owes it here.
  noteRallyAssaults(state, world, viewerColonyId);
  // An owed follow-up the queue has not taken yet lapses the tick the attacker invades
  // or probes again, as a pending one does below (it is no longer a broken army to
  // strike): dropped unshown, however long the queue stays busy.
  if (
    state.owedFollowUp &&
    state.owedRoutTick !== null &&
    attacking(state, world, state.owedAttackerId, viewerColonyId)
  ) {
    state.owedRoutTick = null;
    state.owedFollowUp = false;
  }
  const since = state.buildUpTick;
  if (since === null) return;
  const attacker = state.buildUpAttackerId;
  if (
    world.tick < since ||
    world.tick - since > COUNTER_ATTACK_FOLLOW_UP_TICKS ||
    attacking(state, world, attacker, viewerColonyId) ||
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
 *  if that army is broken and the cooldown since the last rout that owed it is up.
 *  A rout owes it afresh even if a follow-up is still owed unshown (two colonies
 *  today: with more, another attacker's rout would replace it). */
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
