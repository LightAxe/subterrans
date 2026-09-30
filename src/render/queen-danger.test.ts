// queen-danger.test.ts — #375: "Your queen is in danger." covers combat and (from
// V66) starvation, and re-arms once she has recovered (fed and unhurt for
// QUEEN_DANGER_REARM_TICKS).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createQueenDangerState,
  stepQueenDanger,
  advanceQueenDanger,
  QUEEN_DANGER_REARM_TICKS,
  type QueenDangerState,
} from './queen-danger.js';
import { checkAndTrigger, resetCaptions, untrigger } from './onboarding-captions.js';
import { QUEEN_DAMAGE_SUPPRESS_TICKS } from './screen-effects.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';

const DANGER = 'Your queen is in danger.';

/** GameScene's per-frame queen-danger step, minus Phaser: returns the caption shown, if any. */
function frame(state: QueenDangerState, hp: number, fed: boolean, t: number): string | null {
  const d = stepQueenDanger(state, hp, fed, t);
  if (d.rearm) untrigger('queenDamage');
  return d.hurt ? checkAndTrigger('queenDamage') : null;
}

describe('stepQueenDanger', () => {
  beforeEach(() => resetCaptions());

  it('reports hurt on an HP drop only (not the first frame, not a rise)', () => {
    const s = createQueenDangerState();
    expect(stepQueenDanger(s, 30, true, 0).hurt).toBe(false);
    expect(stepQueenDanger(s, 30, true, 1).hurt).toBe(false);
    expect(stepQueenDanger(s, 29, false, 2).hurt).toBe(true);
    expect(stepQueenDanger(s, 33, true, 3).hurt).toBe(false); // home-ground buffer refilled
  });

  it('the caption shows once per danger spell, and again after she recovers', () => {
    const s = createQueenDangerState();
    expect(frame(s, 30, true, 0)).toBeNull();
    expect(frame(s, 29, true, 10)).toBe(DANGER);
    expect(frame(s, 28, true, 20)).toBeNull(); // same spell
    // Fed and unhurt, but not yet for long enough.
    expect(frame(s, 28, true, 20 + QUEEN_DANGER_REARM_TICKS - 1)).toBeNull();
    expect(frame(s, 27, true, 20 + QUEEN_DANGER_REARM_TICKS)).toBeNull(); // hit again: still armed off
    // Recovered: fed now, and no HP lost for 200 ticks since the last hit, re-arms it.
    const last = 20 + QUEEN_DANGER_REARM_TICKS;
    expect(frame(s, 27, true, last + QUEEN_DANGER_REARM_TICKS)).toBeNull(); // re-arms here
    expect(frame(s, 26, false, last + QUEEN_DANGER_REARM_TICKS + 1)).toBe(DANGER);
  });

  it('does not re-arm while she is starving (not fed), however long since the last HP loss', () => {
    const s = createQueenDangerState();
    frame(s, 30, true, 0);
    expect(frame(s, 29, false, 1)).toBe(DANGER);
    expect(stepQueenDanger(s, 29, false, 1 + QUEEN_DANGER_REARM_TICKS * 10).rearm).toBe(false);
    expect(frame(s, 28, false, 2 + QUEEN_DANGER_REARM_TICKS * 10)).toBeNull();
  });

  it('re-arms once only, and not before any harm', () => {
    const s = createQueenDangerState();
    expect(stepQueenDanger(s, 30, true, 0).rearm).toBe(false);
    expect(stepQueenDanger(s, 30, true, QUEEN_DANGER_REARM_TICKS * 3).rearm).toBe(false);
    stepQueenDanger(s, 29, true, 1000);
    expect(stepQueenDanger(s, 29, true, 1000 + QUEEN_DANGER_REARM_TICKS).rearm).toBe(true);
    expect(stepQueenDanger(s, 29, true, 1001 + QUEEN_DANGER_REARM_TICKS).rearm).toBe(false);
  });
});

describe('#375 advanceQueenDanger against the sim (V66): starvation raises it, recovery re-arms it', () => {
  beforeEach(() => resetCaptions());

  it('famine → pulse + caption; fed 200+ ticks → re-armed; second famine → caption again', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = colony.queenEntityId;
    const s = createQueenDangerState();
    const shown: number[] = [];
    let pulses = 0;
    const step = (food: number): void => {
      setColonyFoodForTest(world, colony, food);
      tick(world, []);
      const f = advanceQueenDanger(s, world, colony);
      if (f.pulse) pulses += 1;
      if (f.caption !== null) {
        expect(f.caption).toBe(DANGER);
        shown.push(world.tick);
      }
    };
    for (let i = 0; i < 60; i++) step(2048); // past the round-start grace, fed
    expect(pulses).toBe(0);
    for (let i = 0; i < 25; i++) step(0); // famine: drains at 10 and 20 ticks since her meal
    expect(shown).toHaveLength(1);
    expect(pulses).toBe(2);
    expect(world.ants.hp[q]).toBe(28);
    for (let i = 0; i < QUEEN_DANGER_REARM_TICKS + 5; i++) step(2048); // fed
    expect(shown).toHaveLength(1);
    for (let i = 0; i < 25; i++) step(0); // second famine
    expect(shown).toHaveLength(2);
    expect(world.ants.alive[q]).toBe(1);
  });

  it('no pulse or caption for an HP loss inside the round-start grace', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const s = createQueenDangerState();
    advanceQueenDanger(s, world, colony);
    world.ants.hp[colony.queenEntityId] = 20; // staged hit at tick 0 (fixture, not a sim write path)
    expect(world.tick).toBeLessThanOrEqual(QUEEN_DAMAGE_SUPPRESS_TICKS);
    expect(advanceQueenDanger(s, world, colony)).toEqual({ pulse: false, caption: null });
  });

  it('counts the home-ground buffer: a buffer hit is harm', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = colony.queenEntityId;
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    world.tick = QUEEN_DAMAGE_SUPPRESS_TICKS + 1;
    world.ants.lastMealTick[q] = world.tick - 1;
    world.ants.homeGroundBonusHp[q] = 4;
    const s = createQueenDangerState();
    advanceQueenDanger(s, world, colony);
    world.ants.homeGroundBonusHp[q] = 2;
    expect(advanceQueenDanger(s, world, colony)).toEqual({ pulse: true, caption: DANGER });
  });

  it('a dead queen never re-arms the caption', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const s = createQueenDangerState();
    s.prevHp = 30;
    s.lastHarmTick = 0;
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    world.tick = QUEEN_DANGER_REARM_TICKS * 5;
    world.ants.alive[colony.queenEntityId] = 0; // fixture: a dead slot…
    world.ants.lastMealTick[colony.queenEntityId] = world.tick - 1; // …whose clock reads "fed"
    advanceQueenDanger(s, world, colony);
    expect(s.lastHarmTick).toBe(0);
  });
});
