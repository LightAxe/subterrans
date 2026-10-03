// queen-danger.test.ts — #375: "Your queen is in danger." covers combat and (from
// V66) starvation, and re-arms once she has recovered (back at full HP — waived
// before V66 — fed, and unhurt for QUEEN_DANGER_REARM_TICKS).
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
import {
  COMBAT_HP_QUEEN,
  PLAYER_COLONY_ID,
  QUEEN_HEAL_INTERVAL_TICKS,
  QUEEN_HP_HOME,
  QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS,
} from '../sim/constants.js';
import { stageQueenInNest } from '../sim/health-test-utils.js';
import { SIM_VERSION_V66_QUEEN_STARVES_HP } from '../sim/types.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';

const DANGER = 'Your queen is in danger.';

/** GameScene's per-frame queen-danger step, minus Phaser: returns the caption shown, if any. */
function frame(
  state: QueenDangerState,
  hp: number,
  fed: boolean,
  t: number,
  healed = true,
): string | null {
  const d = stepQueenDanger(state, hp, fed, healed, t);
  if (d.rearm) untrigger('queenDamage');
  return d.hurt ? checkAndTrigger('queenDamage') : null;
}

describe('stepQueenDanger', () => {
  beforeEach(() => resetCaptions());

  it('reports hurt on an HP drop only (not the first frame, not a rise)', () => {
    const s = createQueenDangerState();
    expect(stepQueenDanger(s, 30, true, true, 0).hurt).toBe(false);
    expect(stepQueenDanger(s, 30, true, true, 1).hurt).toBe(false);
    expect(stepQueenDanger(s, 29, false, false, 2).hurt).toBe(true);
    expect(stepQueenDanger(s, 33, true, true, 3).hurt).toBe(false); // healed
  });

  it('the caption shows once per danger spell, and again after she recovers', () => {
    const s = createQueenDangerState();
    expect(frame(s, 30, true, 0)).toBeNull();
    expect(frame(s, 29, true, 10)).toBe(DANGER);
    expect(frame(s, 28, true, 20)).toBeNull(); // same spell
    // Fed, healed and unhurt, but not yet for long enough.
    expect(frame(s, 28, true, 20 + QUEEN_DANGER_REARM_TICKS - 1)).toBeNull();
    expect(frame(s, 27, true, 20 + QUEEN_DANGER_REARM_TICKS)).toBeNull(); // hit again: still armed off
    // Recovered: fed, healed, and no HP lost for 200 ticks since the last hit, re-arms it.
    const last = 20 + QUEEN_DANGER_REARM_TICKS;
    expect(frame(s, 27, true, last + QUEEN_DANGER_REARM_TICKS)).toBeNull(); // re-arms here
    expect(frame(s, 26, false, last + QUEEN_DANGER_REARM_TICKS + 1)).toBe(DANGER);
  });

  it('does not re-arm while she is starving (not fed), however long since the last HP loss', () => {
    const s = createQueenDangerState();
    frame(s, 30, true, 0);
    expect(frame(s, 29, false, 1)).toBe(DANGER);
    expect(stepQueenDanger(s, 29, false, true, 1 + QUEEN_DANGER_REARM_TICKS * 10).rearm).toBe(
      false,
    );
    expect(frame(s, 28, false, 2 + QUEEN_DANGER_REARM_TICKS * 10)).toBeNull();
  });

  it('does not re-arm until she is healed, however long fed and unhurt', () => {
    const s = createQueenDangerState();
    frame(s, 30, true, 0);
    expect(frame(s, 25, true, 1, false)).toBe(DANGER);
    expect(stepQueenDanger(s, 26, true, false, 1 + QUEEN_DANGER_REARM_TICKS * 10).rearm).toBe(
      false,
    );
    expect(stepQueenDanger(s, 30, true, true, 2 + QUEEN_DANGER_REARM_TICKS * 10).rearm).toBe(true);
  });

  it('re-arms once only, and not before any harm', () => {
    const s = createQueenDangerState();
    expect(stepQueenDanger(s, 30, true, true, 0).rearm).toBe(false);
    expect(stepQueenDanger(s, 30, true, true, QUEEN_DANGER_REARM_TICKS * 3).rearm).toBe(false);
    stepQueenDanger(s, 29, true, true, 1000);
    expect(stepQueenDanger(s, 29, true, true, 1000 + QUEEN_DANGER_REARM_TICKS).rearm).toBe(true);
    expect(stepQueenDanger(s, 29, true, true, 1001 + QUEEN_DANGER_REARM_TICKS).rearm).toBe(false);
  });
});

describe('#375 advanceQueenDanger against the sim (V66): starvation raises it, recovery re-arms it', () => {
  beforeEach(() => resetCaptions());

  it('famine → pulse + caption; fed 200+ ticks → re-armed; second famine → caption again', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    // #400 (V71): she heals only in her nest — stage her there, at full home HP.
    const q = stageQueenInNest(world, colony);
    world.ants.hp[q] = QUEEN_HP_HOME;
    // Two drains, then (fed) safe ticks to heal them.
    const famine =
      2 * QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS + (QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS >> 1);
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
    for (let i = 0; i < famine; i++) step(0); // famine: two drains since her meal
    expect(shown).toHaveLength(1);
    expect(pulses).toBe(2);
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME - 2);
    // Fed: she regenerates to full HP, then stays unhurt long enough to re-arm.
    const recover = 2 * QUEEN_HEAL_INTERVAL_TICKS + QUEEN_DANGER_REARM_TICKS + 5;
    for (let i = 0; i < recover; i++) step(2048);
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME);
    expect(shown).toHaveLength(1);
    for (let i = 0; i < famine; i++) step(0); // second famine
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

  it('#400: at full home HP the first blow is harm (no hidden buffer absorbs it)', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = stageQueenInNest(world, colony);
    world.ants.hp[q] = QUEEN_HP_HOME;
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    world.tick = QUEEN_DAMAGE_SUPPRESS_TICKS + 1;
    world.ants.lastMealTick[q] = world.tick - 1;
    const s = createQueenDangerState();
    advanceQueenDanger(s, world, colony);
    world.ants.hp[q] = QUEEN_HP_HOME - 5; // one home-ground blow
    expect(advanceQueenDanger(s, world, colony)).toEqual({ pulse: true, caption: DANGER });
  });

  it('#400: "healed" is her max HP where she stands — in her nest, QUEEN_HP_HOME', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = stageQueenInNest(world, colony);
    for (const [hp, rearmed] of [
      [COMBAT_HP_QUEEN, false], // her surface max: not full at home
      [QUEEN_HP_HOME, true],
    ] as const) {
      const s = createQueenDangerState();
      s.prevHp = hp;
      s.lastHarmTick = 0;
      world.ants.hp[q] = hp;
      // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
      world.tick = QUEEN_DANGER_REARM_TICKS * 5;
      world.ants.lastMealTick[q] = world.tick - 1; // fed
      advanceQueenDanger(s, world, colony);
      expect(s.lastHarmTick === null, `hp ${hp}`).toBe(rearmed);
    }
  });

  it('V66: a wounded queen fed and unhurt does not re-arm below full HP; pre-V66 the HP bar is waived', () => {
    for (const [v, expected] of [
      [SIM_VERSION_V66_QUEEN_STARVES_HP, 1],
      [SIM_VERSION_V66_QUEEN_STARVES_HP - 1, null],
    ] as const) {
      const world = createScenario(7, 'Normal');
      world.simVersion = v;
      const colony = world.colonies[PLAYER_COLONY_ID]!;
      const q = colony.queenEntityId;
      const s = createQueenDangerState();
      s.prevHp = COMBAT_HP_QUEEN - 1;
      s.lastHarmTick = 0;
      world.ants.hp[q] = COMBAT_HP_QUEEN - 1; // fixture: wounded, 1 HP short of full
      // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
      world.tick = QUEEN_DANGER_REARM_TICKS * 5;
      world.ants.lastMealTick[q] = world.tick - 1; // fed
      advanceQueenDanger(s, world, colony);
      expect(s.lastHarmTick === null ? null : 1, `V${v}`).toBe(expected);
    }
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
