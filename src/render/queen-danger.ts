// queen-danger.ts — #375: when "Your queen is in danger." may show again.
//
// The caption (onboarding-captions.ts key 'queenDamage') fires when the player's
// queen loses HP. From simVersion V66 that covers both of the ways she can die:
// combat and starvation (a starving queen loses 1 HP every
// QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS). Up to #375 it was a one-shot, shown once
// per session, so a second attack or famine later in the match went unannounced.
//
// It now re-arms once the queen has RECOVERED:
//   - she is back at full health (her max HP where she stands, health.ts antMaxHp)
//     — from V66 a fed queen regenerates (from #400, V71, only while also safe from
//     blows and in her nest: health.ts), so this is the HP threshold;
//   - she ate on the last tick; and
//   - she has lost no HP for QUEEN_DANGER_REARM_TICKS, so a fight that pauses does
//     not re-raise the caption on its next blow.
//
// Render-side session state only; nothing is saved. Pure + Phaser-free so it is
// unit-testable; GameScene owns the state and calls `advanceQueenDanger` each frame.

import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { QUEEN_HUNGER } from '../sim/hunger.js';
import { antMaxHp } from '../sim/health.js';
import { queenMealsUntilStarvation } from './hud-stats.js';
import { checkAndTrigger, untrigger } from './onboarding-captions.js';
import { QUEEN_DAMAGE_SUPPRESS_TICKS } from './screen-effects.js';

/** Ticks (10 s at 20 Hz) the queen must go unhurt, fed and healed, before the caption re-arms. */
export const QUEEN_DANGER_REARM_TICKS = 200;

export interface QueenDangerState {
  /** Queen HP at the previous frame; null before the first. */
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
 * Advance the tracker by one render frame. `hp` is the queen's HP now, `fed`
 * whether she ate on the last tick, `healed` whether she is back at her full max HP,
 * `tick` the world tick.
 */
export function stepQueenDanger(
  state: QueenDangerState,
  hp: number,
  fed: boolean,
  healed: boolean,
  tick: number,
): QueenDangerStep {
  const hurt = state.prevHp !== null && hp < state.prevHp;
  state.prevHp = hp;
  if (hurt) {
    state.lastHarmTick = tick;
    return { hurt, rearm: false };
  }
  if (
    state.lastHarmTick !== null &&
    fed &&
    healed &&
    tick - state.lastHarmTick >= QUEEN_DANGER_REARM_TICKS
  ) {
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
 * HP, whether she ate on the last tick and whether she is back at her full max HP
 * (V66), re-arms the caption on
 * recovery (untrigger), and on an HP loss past
 * QUEEN_DAMAGE_SUPPRESS_TICKS asks for the pulse and the caption (checkAndTrigger,
 * so it shows once per danger spell).
 */
export function advanceQueenDanger(
  state: QueenDangerState,
  world: WorldState,
  colony: ColonyRecord,
): QueenDangerFrame {
  const q = colony.queenEntityId;
  const hp = world.ants.hp[q] ?? 0;
  const fed =
    isAlive(world.ants, q) &&
    queenMealsUntilStarvation(world, colony) >= QUEEN_HUNGER.starveAfterTicks;
  const healed = hp >= antMaxHp(world, q);
  const step = stepQueenDanger(state, hp, fed, healed, world.tick);
  if (step.rearm) untrigger('queenDamage');
  if (!step.hurt || world.tick <= QUEEN_DAMAGE_SUPPRESS_TICKS) return NO_DANGER;
  return { pulse: true, caption: checkAndTrigger('queenDamage') };
}

const NO_DANGER: QueenDangerFrame = { pulse: false, caption: null };
