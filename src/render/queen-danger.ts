// queen-danger.ts — #375: when "Your queen is in danger." may show again.
//
// The caption (onboarding-captions.ts key 'queenDamage') fires when the player's
// queen loses HP. From simVersion V66 that covers both of the ways she can die:
// combat and starvation (a starving queen loses 1 HP every
// QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS). Up to #375 it was a one-shot, shown once
// per session, so a second attack or famine later in the match went unannounced.
//
// It now re-arms once the queen has RECOVERED: she ate on the last tick and has
// lost no HP for QUEEN_DANGER_REARM_TICKS. (Fed on the frame of the check, not
// continuously: a queen eating often enough never loses HP anyway.) Her HP is not the
// threshold: ants never regenerate HP, so a wounded queen never climbs back above
// any HP line, and an HP-keyed re-arm would never re-arm. Recovery is therefore
// "out of danger for a while", read from the two causes themselves.
//
// Render-side session state only; nothing is saved. Pure + Phaser-free so it is
// unit-testable; GameScene owns the state and calls `advanceQueenDanger` each frame.

import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { QUEEN_HUNGER } from '../sim/hunger.js';
import { queenMealsUntilStarvation } from './hud-stats.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';
import { QUEEN_DAMAGE_SUPPRESS_TICKS } from './screen-effects.js';

/** Ticks (10 s at 20 Hz) the queen must go fed and unhurt before the caption re-arms. */
export const QUEEN_DANGER_REARM_TICKS = 200;

export interface QueenDangerState {
  /** Queen HP (base + home-ground buffer) at the previous frame; null before the first. */
  prevHp: number | null;
  /** Tick of her most recent HP loss seen, or null if none since the last re-arm. */
  lastHarmTick: number | null;
}

export function createQueenDangerState(): QueenDangerState {
  return { prevHp: null, lastHarmTick: null };
}

export interface QueenDangerStep {
  /** She lost HP since the previous frame (combat or, from V66, starvation). */
  readonly hurt: boolean;
  /** The danger caption may show again: call untrigger('queenDamage'). */
  readonly rearm: boolean;
}

/**
 * Advance the tracker by one render frame. `hp` is the queen's combined HP now,
 * `fed` whether she ate on the last tick, `tick` the world tick.
 */
export function stepQueenDanger(
  state: QueenDangerState,
  hp: number,
  fed: boolean,
  tick: number,
): QueenDangerStep {
  const hurt = state.prevHp !== null && hp < state.prevHp;
  state.prevHp = hp;
  if (hurt) {
    state.lastHarmTick = tick;
    return { hurt, rearm: false };
  }
  if (state.lastHarmTick !== null && fed && tick - state.lastHarmTick >= QUEEN_DANGER_REARM_TICKS) {
    state.lastHarmTick = null;
    return { hurt, rearm: true };
  }
  return { hurt, rearm: false };
}

/** What GameScene should show this frame for the queen's danger. */
export interface QueenDangerFrame {
  /** Flash the queen-damage pulse (she lost HP, past the round-start grace). */
  readonly pulse: boolean;
  /** The danger caption text to show, or null. */
  readonly caption: string | null;
}

/**
 * GameScene's per-frame queen-danger step for `colony` (the player's): reads her
 * combined HP (base + home-ground buffer) and whether she ate on the last tick,
 * re-arms the caption on recovery (untrigger), and on an HP loss past
 * QUEEN_DAMAGE_SUPPRESS_TICKS asks for the pulse and the caption (checkAndTrigger,
 * so it shows once per danger spell).
 */
export function advanceQueenDanger(
  state: QueenDangerState,
  world: WorldState,
  colony: ColonyRecord,
): QueenDangerFrame {
  const q = colony.queenEntityId;
  const hp = (world.ants.hp[q] ?? 0) + (world.ants.homeGroundBonusHp[q] ?? 0);
  const fed =
    isAlive(world.ants, q) &&
    queenMealsUntilStarvation(world, colony) >= QUEEN_HUNGER.starveAfterTicks;
  const step = stepQueenDanger(state, hp, fed, world.tick);
  if (step.rearm) untrigger('queenDamage');
  if (!step.hurt || world.tick <= QUEEN_DAMAGE_SUPPRESS_TICKS) return NO_DANGER;
  return { pulse: true, caption: checkAndTrigger('queenDamage') };
}

const NO_DANGER: QueenDangerFrame = { pulse: false, caption: null };
