// queen-danger.ts — #375: when "Your queen is in danger." may show again.
//
// The caption (onboarding-captions.ts key 'queenDamage') fires when the player's
// queen loses HP. From simVersion V66 that covers both of the ways she can die:
// combat and starvation (a starving queen loses 1 HP every
// QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS). Up to #375 it was a one-shot, shown once
// per session, so a second attack or famine later in the match went unannounced.
//
// It now re-arms once the danger has PASSED. Both ways need her to have eaten on
// the last tick, so a starving queen never re-arms (she loses HP every
// QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS while she cannot eat, and that HP loss
// raised the caption in the first place):
//   - RECOVERED: she is back at full health (her max HP where she stands, health.ts
//     antMaxHp) and has lost no HP for QUEEN_DANGER_REARM_TICKS, so a fight that
//     pauses does not re-raise the caption on its next blow. From V66 a fed queen
//     regenerates (from #400, V71, only while also safe from blows and in her nest:
//     health.ts); or
//   - UNHURT (#416): she has lost no HP for QUEEN_DANGER_REARM_UNHURT_TICKS, however
//     wounded she still is. Since #398 she heals at the ant rate (about 1½ minutes
//     from 7 HP to full), so waiting for full HP left a follow-up attack inside
//     that time unannounced. The same goes for a famine: once she eats again, a
//     queen still wounded by it re-arms 30 s after its last drain, where up to #416
//     she had to heal back to full first.
// "Lost no HP" means no HARM: every HP loss this tracker sees (a starvation drain,
// which the sim does not stamp as a hit) and every blow, read from the sim's
// ants.lastHitTick even when her HP shows none (#416 review: health.ts heals at
// step 16f, before combat, so a heal tick and a 1-HP blow in one tick cancel out).
// So 30 s of calm means no fight and no famine, and a fight or famine that keeps
// hurting her never re-arms the caption.
//
// It DECIDES per sim tick and PRESENTS per render frame (#416 review). The game
// loop runs up to MAX_CATCHUP_TICKS ticks in one frame (4x speed, a stalled frame),
// so anything decided once a frame depends on how the ticks were batched: a drain,
// a meal and a heal tick could hide inside one frame, and so could the tick she
// became eligible to re-arm before a fresh blow. So every tick's end state gets one
// look: sim-tick-hook.ts beforeSimTick calls noteQueenDangerTick before each tick
// (the world as the previous tick left it), and the frame step looks at the frame's
// last tick. Each look (stepQueenDanger) either records harm or checks the re-arm,
// and the look decides the round-start grace, the re-arm (untrigger) and the
// caption (checkAndTrigger) as of its own tick. advanceQueenDanger then only
// presents what is owed: one pulse for any harm since the last frame, and the
// caption if one was decided. A second look at the same state (the frame step's,
// then the next frame's first per-tick look) changes nothing. The outcome of every
// tick is therefore the same however the ticks are batched; queen-danger.test.ts's
// batching-invariance property test pins it. (One accepted exception, in the
// presentation: a caption UIScene drops on a full queue is untriggered only when the
// frame presents it, so a harm later in that same frame cannot decide it again; it
// re-fires at the next harm after that frame, while the queue is still full anyway.)
//
// Render-side session state only; nothing is saved. Pure + Phaser-free so it is
// unit-testable; GameScene owns the state and calls `advanceQueenDanger` each frame.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { QUEEN_HUNGER } from '../sim/hunger.js';
import { antMaxHp } from '../sim/health.js';
import { queenMealsUntilStarvation } from './hud-stats.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';
import { QUEEN_DAMAGE_SUPPRESS_TICKS } from './screen-effects.js';

/**
 * Ticks (10 s at 20 Hz) the queen must go unhurt, and be fed, before the caption
 * re-arms once she is back at full HP. While she is still wounded it takes
 * QUEEN_DANGER_REARM_UNHURT_TICKS instead (#416).
 */
export const QUEEN_DANGER_REARM_TICKS = 200;

/**
 * #416 — ticks (30 s at 20 Hz) the queen must go unhurt, and be fed, before the
 * caption re-arms while she is still wounded. Longer than QUEEN_DANGER_REARM_TICKS:
 * without the full-HP check it is the only thing between the caption and a fight
 * that pauses, and much longer than any lull inside one fight (a blow lands every
 * COMBAT_COOLDOWN_TICKS; the sim's HEAL_SAFE_TICKS is 5 s).
 */
export const QUEEN_DANGER_REARM_UNHURT_TICKS = 600;

export interface QueenDangerState {
  /** Queen HP at the previous look (one per sim tick, plus the frame's); null before the first. */
  prevHp: number | null;
  /** Her ants.lastHitTick at the previous look; null before the first. */
  prevLastHitTick: number | null;
  /**
   * World tick of the look that first saw her most recent harm (an HP loss or a
   * blow) — one past the sim tick that dealt it — or null if none since the last
   * re-arm.
   */
  lastHarmTick: number | null;
  /**
   * Owed to the next frame step: harm was seen past the round-start grace, so it
   * pulses. (A frame that ends the round skips the frame step; every new round or
   * loaded save starts from createQueenDangerState, GameScene.resetSessionState.)
   */
  pulseOwed: boolean;
  /** Owed to the next frame step: the danger caption, decided at a harm; null if none. */
  captionOwed: string | null;
}

export function createQueenDangerState(): QueenDangerState {
  return {
    prevHp: null,
    prevLastHitTick: null,
    lastHarmTick: null,
    pulseOwed: false,
    captionOwed: null,
  };
}

export interface QueenDangerStep {
  /** This look saw harm: a blow, or (from V66) a starvation drain. */
  readonly hurt: boolean;
  /** The danger caption may show again: call untrigger('queenDamage'). */
  readonly rearm: boolean;
}

const HURT: QueenDangerStep = { hurt: true, rearm: false };
const REARM: QueenDangerStep = { hurt: false, rearm: true };
const NOTHING: QueenDangerStep = { hurt: false, rearm: false };

/**
 * One look at the queen at world tick `tick`, after the sim tick before it: `hp` is
 * her HP, `fed` whether she ate on that tick, `healed` whether she is back at her
 * full max HP, `lastHitTick` her ants.lastHitTick (the sim tick of her latest blow,
 * stamped by combat.ts applyDamage only for a damaging blow; -1 = never; by default
 * unchanged since the previous look).
 *
 * HARM is an HP drop since the previous look (a blow or a starvation drain, which the
 * sim does not stamp as a hit) or a new lastHitTick (a blow, even one her HP does not
 * show: health.ts heals at step 16f, before combat, so a heal and a 1-HP blow in one
 * tick cancel out). Harm is dated `tick`. A look without harm checks the re-arm as of
 * `tick`: she is fed and has been unharmed for QUEEN_DANGER_REARM_UNHURT_TICKS, or
 * for QUEEN_DANGER_REARM_TICKS if she is also healed (once per harm). The first look
 * only records her HP and clock.
 */
export function stepQueenDanger(
  state: QueenDangerState,
  hp: number,
  fed: boolean,
  healed: boolean,
  tick: number,
  lastHitTick: number = state.prevLastHitTick ?? -1,
): QueenDangerStep {
  const hit = state.prevLastHitTick !== null && lastHitTick > state.prevLastHitTick;
  const drop = state.prevHp !== null && hp < state.prevHp;
  state.prevHp = hp;
  state.prevLastHitTick = lastHitTick;
  if (hit || drop) {
    state.lastHarmTick = tick;
    return HURT;
  }
  if (state.lastHarmTick === null || !fed) return NOTHING;
  const unhurtTicks = tick - state.lastHarmTick;
  if (
    unhurtTicks >= QUEEN_DANGER_REARM_UNHURT_TICKS ||
    (healed && unhurtTicks >= QUEEN_DANGER_REARM_TICKS)
  ) {
    state.lastHarmTick = null;
    return REARM;
  }
  return NOTHING;
}

/**
 * One look at `colony`'s queen in `world` (stepQueenDanger), and what it decides as of
 * world.tick: a re-arm (untrigger), or harm past QUEEN_DAMAGE_SUPPRESS_TICKS — owed a
 * pulse, and the caption if it is armed (checkAndTrigger, so it shows once per danger
 * spell).
 */
function lookAtQueen(state: QueenDangerState, world: WorldState, colony: ColonyRecord): void {
  const q = colony.queenEntityId;
  const hp = world.ants.hp[q] ?? 0;
  const fed =
    isAlive(world.ants, q) &&
    queenMealsUntilStarvation(world, colony) >= QUEEN_HUNGER.starveAfterTicks;
  const healed = hp >= antMaxHp(world, q);
  const step = stepQueenDanger(state, hp, fed, healed, world.tick, world.ants.lastHitTick[q] ?? -1);
  if (step.rearm) untrigger('queenDamage');
  if (!step.hurt || world.tick <= QUEEN_DAMAGE_SUPPRESS_TICKS) return;
  state.pulseOwed = true;
  const caption = checkAndTrigger('queenDamage');
  if (caption !== null) state.captionOwed = caption;
}

/**
 * #416 review — sim-tick-hook.ts beforeSimTick's look at `colonyId`'s queen before each
 * sim tick (lookAtQueen), so every tick's outcome is decided on its own end state
 * however many ticks the render frame runs.
 */
export function noteQueenDangerTick(
  state: QueenDangerState,
  world: WorldState,
  colonyId: ColonyId,
): void {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return;
  lookAtQueen(state, world, colony);
}

/** What GameScene should show this frame for the queen's danger. */
export interface QueenDangerFrame {
  /** Flash the queen-damage pulse (she was harmed since the last frame, past the round-start grace). */
  readonly pulse: boolean;
  /** The danger caption text to show, or null. */
  readonly caption: string | null;
}

/**
 * GameScene's per-frame queen-danger step for `colony` (the player's): one look at the
 * frame's last tick (lookAtQueen, as for every other tick), then it presents what the
 * looks since the last frame decided — the pulse for any harm, and the caption if one
 * was decided — and clears it.
 */
export function advanceQueenDanger(
  state: QueenDangerState,
  world: WorldState,
  colony: ColonyRecord,
): QueenDangerFrame {
  lookAtQueen(state, world, colony);
  if (!state.pulseOwed) return NO_DANGER;
  const frame: QueenDangerFrame = { pulse: true, caption: state.captionOwed };
  state.pulseOwed = false;
  state.captionOwed = null;
  return frame;
}

const NO_DANGER: QueenDangerFrame = { pulse: false, caption: null };
