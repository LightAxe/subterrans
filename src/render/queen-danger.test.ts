// queen-danger.test.ts — #375: "Your queen is in danger." covers combat and (from
// V66) starvation, and re-arms once the danger has passed: she is fed and has been
// unhurt for QUEEN_DANGER_REARM_UNHURT_TICKS (#416), or for QUEEN_DANGER_REARM_TICKS
// once back at full HP.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createQueenDangerState,
  stepQueenDanger,
  advanceQueenDanger,
  noteQueenDangerTick,
  QUEEN_DANGER_REARM_TICKS,
  QUEEN_DANGER_REARM_UNHURT_TICKS,
  type QueenDangerState,
} from './queen-danger.js';
import { beforeSimTick } from './sim-tick-hook.js';
import { createStoresFillingCaptionState } from './stores-filling-caption.js';
import { createStorageHintState } from './storage-hint.js';
import { createCounterAttackCaptionState } from './counter-attack-caption.js';
import { createEnemyQueenWoundState } from './enemy-queen-wound.js';
import { createRampageCaptionState } from './recurring-captions.js';
import { createGameLoop, MAX_CATCHUP_TICKS, MS_PER_TICK } from '../platform/game-loop.js';
import { checkAndTrigger, resetCaptions, untrigger } from './onboarding-captions.js';
import { QUEEN_DAMAGE_SUPPRESS_TICKS } from './screen-effects.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { GameOutcome } from '../sim/game-over.js';
import type { WorldState } from '../sim/types.js';
import {
  COMBAT_COOLDOWN_TICKS,
  COMBAT_HP_QUEEN,
  HEAL_SAFE_TICKS,
  PLAYER_COLONY_ID,
  QUEEN_HEAL_INTERVAL_TICKS,
  QUEEN_HP_HOME,
  QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS,
} from '../sim/constants.js';
import { stageQueenInNest } from '../sim/health-test-utils.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';

const DANGER = 'Your queen is in danger.';

/** One look (stepQueenDanger) and the caption it decides, minus the world: returns the caption, if any. */
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

/** Frames on every tick in [from, to] at a steady `hp`; returns the ticks it re-armed on. */
function hold(
  state: QueenDangerState,
  hp: number,
  fed: boolean,
  healed: boolean,
  from: number,
  to: number,
): number[] {
  const rearms: number[] = [];
  for (let t = from; t <= to; t++) {
    const d = stepQueenDanger(state, hp, fed, healed, t);
    expect(d.hurt).toBe(false);
    if (d.rearm) {
      untrigger('queenDamage');
      rearms.push(t);
    }
  }
  return rearms;
}

/** Two minutes of world ticks at 20 Hz. */
const TWO_MINUTES = 2 * 60 * 20;

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
    // #416: neither path — wounded or back at full HP, past either unhurt window.
    for (const healed of [false, true]) {
      resetCaptions();
      const s = createQueenDangerState();
      frame(s, 30, true, 0);
      expect(frame(s, 29, false, 1, healed)).toBe(DANGER);
      const later = 1 + QUEEN_DANGER_REARM_UNHURT_TICKS * 4;
      expect(stepQueenDanger(s, 29, false, healed, later).rearm, `healed ${healed}`).toBe(false);
      expect(frame(s, 28, false, later + 1, healed)).toBeNull();
    }
  });

  it('below full HP it re-arms only once she has gone QUEEN_DANGER_REARM_UNHURT_TICKS unhurt (#416)', () => {
    const s = createQueenDangerState();
    frame(s, 30, true, 0);
    expect(frame(s, 25, true, 1, false)).toBe(DANGER);
    expect(hold(s, 26, true, false, 2, QUEEN_DANGER_REARM_UNHURT_TICKS)).toEqual([]);
    expect(stepQueenDanger(s, 26, true, false, 1 + QUEEN_DANGER_REARM_UNHURT_TICKS).rearm).toBe(
      true,
    );
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

describe('#416 stepQueenDanger: re-arms after 30 s unhurt, even while she is still wounded', () => {
  beforeEach(() => resetCaptions());
  const HIT = 101;

  it('the window is 30 s, longer than the full-HP window and the sim heal-safe time', () => {
    expect(QUEEN_DANGER_REARM_UNHURT_TICKS).toBe(600);
    expect(QUEEN_DANGER_REARM_UNHURT_TICKS).toBeGreaterThan(QUEEN_DANGER_REARM_TICKS);
    expect(QUEEN_DANGER_REARM_UNHURT_TICKS).toBeGreaterThan(HEAL_SAFE_TICKS);
  });

  it('1. a second blow 10 s after the first, while she is still wounded, shows no second caption', () => {
    const s = createQueenDangerState();
    expect(frame(s, 50, true, HIT - 1)).toBeNull();
    expect(frame(s, 7, true, HIT, false)).toBe(DANGER);
    expect(hold(s, 7, true, false, HIT + 1, HIT + QUEEN_DANGER_REARM_TICKS)).toEqual([]);
    expect(frame(s, 2, true, HIT + QUEEN_DANGER_REARM_TICKS + 1, false)).toBeNull();
  });

  it('2. after 30 s unhurt and fed, still wounded, the next blow shows it again', () => {
    const s = createQueenDangerState();
    frame(s, 50, true, HIT - 1);
    expect(frame(s, 7, true, HIT, false)).toBe(DANGER);
    // Fed, nowhere near full HP: it re-arms exactly 30 s after her last HP loss, once.
    const end = HIT + QUEEN_DANGER_REARM_UNHURT_TICKS + 50;
    expect(hold(s, 7, true, false, HIT + 1, end)).toEqual([HIT + QUEEN_DANGER_REARM_UNHURT_TICKS]);
    expect(frame(s, 2, true, end + 1, false)).toBe(DANGER);
    expect(frame(s, 1, true, end + 2, false)).toBeNull(); // same spell again
  });

  it('3. a 2-minute fight whose lulls stay under 30 s shows it once', () => {
    const s = createQueenDangerState();
    frame(s, 50, true, HIT - 1);
    // Bursts of blows COMBAT_COOLDOWN_TICKS apart, then lulls up to 1 tick short of
    // the window. She heals a little in each lull, never back to full (healed false).
    const gaps = [
      COMBAT_COOLDOWN_TICKS,
      COMBAT_COOLDOWN_TICKS,
      QUEEN_DANGER_REARM_UNHURT_TICKS - 1,
      COMBAT_COOLDOWN_TICKS,
      QUEEN_DANGER_REARM_TICKS,
      QUEEN_DANGER_REARM_UNHURT_TICKS - 1,
    ];
    let hp = 40;
    let nextBlow = HIT;
    let lastBlow = HIT;
    let blows = 0;
    const shown: number[] = [];
    for (let t = HIT; t <= HIT + TWO_MINUTES; t++) {
      if (t === nextBlow) {
        hp -= 5;
        lastBlow = t;
        nextBlow += gaps[blows % gaps.length]!;
        blows += 1;
      } else if (t - lastBlow >= HEAL_SAFE_TICKS && t % QUEEN_HEAL_INTERVAL_TICKS === 0) {
        hp += 1; // the sim's heal: safe from blows, on a heal tick
      }
      expect(hp).toBeGreaterThan(0);
      expect(hp).toBeLessThan(50);
      if (frame(s, hp, true, t, false) !== null) shown.push(t);
    }
    expect(blows).toBeGreaterThan(gaps.length); // the fight ran the whole 2 minutes
    expect(shown).toEqual([HIT]);
  });

  it('4. back at full HP it still re-arms after QUEEN_DANGER_REARM_TICKS, as before', () => {
    const s = createQueenDangerState();
    frame(s, 50, true, HIT - 1);
    expect(frame(s, 49, true, HIT, false)).toBe(DANGER);
    expect(hold(s, 49, true, false, HIT + 1, HIT + 50)).toEqual([]);
    // Healed to full: re-arms QUEEN_DANGER_REARM_TICKS after the blow, well before 30 s.
    expect(hold(s, 50, true, true, HIT + 51, HIT + QUEEN_DANGER_REARM_TICKS + 10)).toEqual([
      HIT + QUEEN_DANGER_REARM_TICKS,
    ]);
    expect(frame(s, 45, true, HIT + QUEEN_DANGER_REARM_TICKS + 11, false)).toBe(DANGER);
  });

  it('5. starvation: one caption per famine, no re-arm while she starves, whichever path', () => {
    const s = createQueenDangerState();
    frame(s, 50, true, HIT - 1);
    // A famine: 1 HP every QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS, unfed throughout,
    // for longer than the 30 s window (a fixture: in the sim she dies sooner).
    let hp = 50;
    const shown: number[] = [];
    const famineEnd = HIT + 2 * QUEEN_DANGER_REARM_UNHURT_TICKS;
    for (let t = HIT; t <= famineEnd; t++) {
      if ((t - HIT) % QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS === 0) hp -= 1;
      const d = stepQueenDanger(s, hp, false, false, t);
      expect(d.rearm).toBe(false);
      if (d.hurt && checkAndTrigger('queenDamage') !== null) shown.push(t);
    }
    expect(shown).toEqual([HIT]);
    // Unfed but no longer losing HP (fixture) — still no re-arm, past either window.
    expect(
      hold(s, hp, false, false, famineEnd + 1, famineEnd + 2 * QUEEN_DANGER_REARM_UNHURT_TICKS),
    ).toEqual([]);
    expect(
      hold(
        s,
        50,
        false,
        true,
        famineEnd + 1 + 2 * QUEEN_DANGER_REARM_UNHURT_TICKS,
        famineEnd + 3 * QUEEN_DANGER_REARM_UNHURT_TICKS,
      ),
    ).toEqual([]);
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
      // Past the full-HP window, inside the 30 s one (#416), so only "healed" re-arms.
      // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
      world.tick = QUEEN_DANGER_REARM_TICKS * 2;
      expect(world.tick).toBeLessThan(QUEEN_DANGER_REARM_UNHURT_TICKS);
      world.ants.lastMealTick[q] = world.tick - 1; // fed
      advanceQueenDanger(s, world, colony);
      expect(s.lastHarmTick === null, `hp ${hp}`).toBe(rearmed);
    }
  });

  it('#416: a wounded queen, fed and unhurt, re-arms below full HP only after 30 s', () => {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = colony.queenEntityId;
    for (const [unhurt, rearmed] of [
      [QUEEN_DANGER_REARM_UNHURT_TICKS - 1, false],
      [QUEEN_DANGER_REARM_UNHURT_TICKS, true],
    ] as const) {
      const s = createQueenDangerState();
      s.prevHp = COMBAT_HP_QUEEN - 1;
      s.lastHarmTick = 0;
      world.ants.hp[q] = COMBAT_HP_QUEEN - 1; // fixture: wounded, 1 HP short of full
      // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
      world.tick = unhurt;
      world.ants.lastMealTick[q] = world.tick - 1; // fed
      advanceQueenDanger(s, world, colony);
      expect(s.lastHarmTick === null, `unhurt ${unhurt}`).toBe(rearmed);
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

describe('#416 advanceQueenDanger against the sim: re-arms after 30 s unhurt, while she still heals', () => {
  beforeEach(() => resetCaptions());

  /**
   * The player's queen staged in her nest at full home HP, stores topped up each tick,
   * and GameScene's per-frame step after every tick. `blow` lands a hit on her the way
   * combat.ts applyDamage does — lower HP, stamp lastHitTick — on the tick just run.
   */
  function harness() {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = stageQueenInNest(world, colony);
    world.ants.hp[q] = QUEEN_HP_HOME;
    const s = createQueenDangerState();
    const shown: number[] = [];
    let pulses = 0;
    const step = (opts: { food?: number; blow?: number } = {}): void => {
      setColonyFoodForTest(world, colony, opts.food ?? 2048);
      tick(world, []);
      if (opts.blow !== undefined) {
        world.ants.hp[q] = world.ants.hp[q]! - opts.blow; // fixture: a blow (combat.ts applyDamage)
        world.ants.lastHitTick[q] = world.tick - 1;
      }
      const f = advanceQueenDanger(s, world, colony);
      if (f.pulse) pulses += 1;
      if (f.caption !== null) {
        expect(f.caption).toBe(DANGER);
        shown.push(world.tick);
      }
    };
    const run = (ticks: number, food?: number): void => {
      for (let i = 0; i < ticks; i++) step({ food });
    };
    run(60); // past the round-start grace
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME);
    return { world, q, s, shown, step, run, pulses: () => pulses };
  }

  it('1+2. a heavy wound: a blow 10 s later is not announced; one 30 s after that is, though she is still healing', () => {
    const h = harness();
    h.step({ blow: QUEEN_HP_HOME - 7 }); // down to 7 HP
    expect(h.shown).toHaveLength(1);
    h.run(QUEEN_DANGER_REARM_TICKS);
    h.step({ blow: 2 }); // 10 s later, still wounded
    expect(h.shown).toHaveLength(1);
    expect(h.pulses()).toBe(2);
    const second = h.world.tick;
    const hpAfterSecond = h.world.ants.hp[h.q]!;
    h.run(QUEEN_DANGER_REARM_UNHURT_TICKS - 1);
    expect(h.s.lastHarmTick).toBe(second); // 1 tick short: not re-armed
    h.run(1);
    expect(h.s.lastHarmTick).toBeNull(); // 30 s unhurt: re-armed…
    expect(h.world.ants.hp[h.q]).toBeLessThan(QUEEN_HP_HOME - 10); // …while still healing
    expect(h.world.ants.hp[h.q]).toBeGreaterThan(hpAfterSecond); // (she did heal)
    h.step({ blow: 2 });
    expect(h.shown).toHaveLength(2);
    expect(h.world.ants.alive[h.q]).toBe(1);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);

  it('3. a 2-minute fight — bursts of blows, lulls under 30 s — shows it once', () => {
    const h = harness();
    const gaps = [
      COMBAT_COOLDOWN_TICKS,
      COMBAT_COOLDOWN_TICKS,
      QUEEN_DANGER_REARM_UNHURT_TICKS - 10,
    ];
    let blows = 0;
    let wait = 0;
    for (let i = 0; i < TWO_MINUTES; i++) {
      if (wait === 0) {
        h.step({ blow: 5 }); // a burst outweighs what she heals in the lull after it
        wait = gaps[blows % gaps.length]! - 1;
        blows += 1;
      } else {
        h.step();
        wait -= 1;
      }
      expect(h.world.ants.hp[h.q]).toBeLessThan(QUEEN_HP_HOME); // never back to full
    }
    expect(blows).toBeGreaterThan(2 * gaps.length);
    expect(h.pulses()).toBe(blows);
    expect(h.shown).toHaveLength(1);
    expect(h.world.ants.alive[h.q]).toBe(1);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);

  it('4. a light wound healed back to full re-arms after QUEEN_DANGER_REARM_TICKS, as before', () => {
    const h = harness();
    h.step({ blow: 1 });
    expect(h.shown).toHaveLength(1);
    const hit = h.world.tick;
    h.run(QUEEN_DANGER_REARM_TICKS - 1);
    expect(h.world.ants.hp[h.q]).toBe(QUEEN_HP_HOME); // healed (HEAL_SAFE_TICKS + one heal tick)
    expect(h.s.lastHarmTick).toBe(hit);
    h.run(1);
    expect(h.s.lastHarmTick).toBeNull(); // re-armed 10 s after the blow, not 30 s
    h.step({ blow: 1 });
    expect(h.shown).toHaveLength(2);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);

  it('5. starvation: one caption per famine, no re-arm while she starves; re-arms 30 s after it ends', () => {
    const h = harness();
    // Up to 250 unfed ticks: a drain every QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS (41 HP).
    const famine = 250;
    for (let i = 0; i < famine; i++) {
      const harmed = h.s.lastHarmTick !== null;
      h.step({ food: 0 });
      if (harmed) expect(h.s.lastHarmTick).not.toBeNull(); // never re-armed mid-famine
    }
    const drained = Math.floor(famine / QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS);
    expect(h.world.ants.hp[h.q]).toBe(QUEEN_HP_HOME - drained);
    expect(h.pulses()).toBe(drained);
    expect(h.shown).toHaveLength(1);
    expect(h.world.ants.alive[h.q]).toBe(1);
    // Fed again, still deeply wounded: the same 30 s rule re-arms it as for a blow
    // (up to #416 she had to heal back to full first), so the next famine (or
    // attack) is announced.
    const lastDrain = h.s.lastHarmTick!;
    h.run(lastDrain + QUEEN_DANGER_REARM_UNHURT_TICKS - 1 - h.world.tick);
    expect(h.s.lastHarmTick).toBe(lastDrain); // 1 tick short
    h.run(1);
    expect(h.s.lastHarmTick).toBeNull();
    expect(h.world.ants.hp[h.q]).toBeLessThan(QUEEN_HP_HOME - 20);
    for (let i = 0; i < 2 * QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS; i++) h.step({ food: 0 });
    expect(h.shown).toHaveLength(2);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);

  it('5b. starvation: a food trickle (a drain every heal interval, healed back each time) shows it once', () => {
    // Stores empty for QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS + 1 ticks out of every
    // QUEEN_HEAL_INTERVAL_TICKS, never on a heal tick: one drain per window,
    // healed back on the next heal tick, so she is fed on most frames and never hit.
    // Her HP keeps dropping, so "unhurt" never reaches 30 s and it never re-arms — a
    // clock on ants.lastHitTick alone (never stamped by a drain) would re-arm on her
    // next meal and repeat the caption on every drain.
    const h = harness();
    const windows = 30;
    const unfedPerWindow = QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS + 1;
    expect(10 + unfedPerWindow).toBeLessThan(QUEEN_HEAL_INTERVAL_TICKS); // clear of the heal tick
    let unfed = 0;
    for (let i = 0; i < windows * QUEEN_HEAL_INTERVAL_TICKS; i++) {
      const phase = h.world.tick % QUEEN_HEAL_INTERVAL_TICKS; // the tick about to run
      const starving = phase >= 10 && phase < 10 + unfedPerWindow;
      if (starving) unfed += 1;
      h.step(starving ? { food: 0 } : {});
      expect(h.world.ants.hp[h.q]).toBeGreaterThanOrEqual(QUEEN_HP_HOME - 1);
    }
    expect(unfed).toBe(windows * unfedPerWindow);
    expect(h.pulses()).toBe(windows); // one drain per window
    expect(h.shown).toHaveLength(1);
    expect(h.world.ants.alive[h.q]).toBe(1);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);
});

describe('#416 review: harm inside a frame or a tick (seen before every sim tick)', () => {
  beforeEach(() => resetCaptions());

  /**
   * GameScene's wiring without Phaser: the game loop with beforeSimTick as its
   * onBeforeTick, then advanceQueenDanger once per render frame. The player's queen is
   * staged in her nest at full home HP; the stores are full except on sim ticks in
   * [unfedFrom, unfedTo]; and on each sim tick in `strikes` a 1-HP blow lands on her
   * after the tick's own steps (fixture: as combat.ts applyDamage does at step 17,
   * after healing at 16f — lower HP, stamp lastHitTick with that sim tick).
   */
  function loopHarness() {
    const world = createScenario(7, 'Normal');
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = stageQueenInNest(world, colony);
    world.ants.hp[q] = QUEEN_HP_HOME;
    const s = createQueenDangerState();
    const prev = createScenario(7, 'Normal');
    const rampage = createRampageCaptionState();
    const food = { unfedFrom: -1, unfedTo: -1 };
    const strikes = new Set<number>();
    const loop = createGameLoop(
      (w, cmds) => {
        const simTick = w.tick;
        const empty = simTick >= food.unfedFrom && simTick <= food.unfedTo;
        setColonyFoodForTest(w, colony, empty ? 0 : 2048);
        const outcome = tick(w, cmds);
        if (strikes.has(simTick)) {
          w.ants.hp[q] = w.ants.hp[q]! - 1;
          w.ants.lastHitTick[q] = simTick;
        }
        return outcome;
      },
      world,
      {
        onBeforeTick: (w) =>
          beforeSimTick(w, [], PLAYER_COLONY_ID, prev, {
            rampage: rampage,
            queenDanger: s,
            enemyQueenWound: createEnemyQueenWoundState(),
            counterAttack: createCounterAttackCaptionState(),
            storesFilling: createStoresFillingCaptionState(),
            storageHint: createStorageHintState(),
          }),
      },
    );
    const shown: number[] = [];
    let pulses = 0;
    /** One render frame that runs `n` sim ticks, then GameScene's frame step. */
    const frameOf = (n: number): void => {
      loop.update(n * MS_PER_TICK);
      const f = advanceQueenDanger(s, world, colony);
      if (f.pulse) pulses += 1;
      if (f.caption !== null) shown.push(world.tick);
    };
    const runTo = (t: number): void => {
      while (world.tick < t) frameOf(1);
    };
    runTo(100); // past the round-start grace
    world.ants.hp[q] = 20; // fixture: a heavy blow (combat.ts applyDamage)
    world.ants.lastHitTick[q] = world.tick - 1;
    frameOf(1);
    expect(shown).toHaveLength(1);
    const hit = s.lastHarmTick!;
    expect(hit).toBe(world.tick - 1); // seen before the next sim tick
    /** The first heal tick at least `after` ticks past `from`. */
    const healTickAfter = (from: number, after: number): number =>
      (Math.floor((from + after) / QUEEN_HEAL_INTERVAL_TICKS) + 1) * QUEEN_HEAL_INTERVAL_TICKS;
    return {
      world,
      q,
      s,
      food,
      strikes,
      shown,
      hit,
      frameOf,
      runTo,
      healTickAfter,
      pulses: () => pulses,
    };
  }

  it('a new last-hit tick is harm, dated to the look, though her HP shows none', () => {
    const s = createQueenDangerState();
    // The first look only records her clock (an old blow).
    expect(stepQueenDanger(s, 30, true, false, 100, 40)).toEqual({ hurt: false, rearm: false });
    expect(s.lastHarmTick).toBeNull();
    expect(stepQueenDanger(s, 30, true, false, 101, 40).hurt).toBe(false); // no new blow
    // A blow on sim tick 150 whose HP a heal in the same tick put back.
    expect(stepQueenDanger(s, 30, true, false, 151, 150)).toEqual({ hurt: true, rearm: false });
    expect(s.lastHarmTick).toBe(151);
    expect(stepQueenDanger(s, 30, true, false, 152, 150).hurt).toBe(false); // seen once
    expect(hold(s, 30, true, false, 153, 151 + QUEEN_DANGER_REARM_UNHURT_TICKS + 5)).toEqual([
      151 + QUEEN_DANGER_REARM_UNHURT_TICKS,
    ]);
  });

  it('a drain, a meal and a heal inside one frame: dated to the drain, so no early re-arm', () => {
    const h = loopHarness();
    // A heal tick H long after the blow (she is safe and healing again). The stores
    // run empty for the QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS sim ticks up to D = H - 2,
    // so she is drained 1 HP on D, eats on H - 1 and H, and heals 1 HP on H.
    const H = h.healTickAfter(h.hit, 300);
    const D = H - 2;
    h.food.unfedFrom = D - QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS + 1;
    h.food.unfedTo = D;
    h.runTo(H - MAX_CATCHUP_TICKS + 1);
    const hpBefore = h.world.ants.hp[h.q];
    expect(hpBefore).toBeLessThan(QUEEN_HP_HOME - 5);
    h.frameOf(MAX_CATCHUP_TICKS); // one frame: sim ticks H - 4 .. H
    expect(h.world.tick).toBe(H + 1);
    expect(h.world.ants.hp[h.q]).toBe(hpBefore); // the frame's end hides the drain…
    expect(h.s.lastHarmTick).toBe(D + 1); // …but it was seen, before sim tick D + 1
    expect(h.pulses()).toBe(2);
    expect(h.shown).toHaveLength(1); // same danger spell
    // No re-arm 30 s after the blow…
    h.runTo(h.hit + QUEEN_DANGER_REARM_UNHURT_TICKS + 1);
    expect(h.s.lastHarmTick).toBe(D + 1);
    // …only 30 s after the hidden drain, while she is still wounded.
    h.runTo(D + 1 + QUEEN_DANGER_REARM_UNHURT_TICKS - 1);
    expect(h.s.lastHarmTick).toBe(D + 1);
    h.frameOf(1);
    expect(h.s.lastHarmTick).toBeNull();
    expect(h.world.ants.hp[h.q]).toBeLessThan(QUEEN_HP_HOME);
    expect(h.world.ants.alive[h.q]).toBe(1);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);

  it('a heal and a 1-HP blow in one tick: her HP is unchanged, yet it is harm — pulsed, dated, announced when armed', () => {
    const h = loopHarness();
    // A heal tick H long after the blow: she heals 1 HP at step 16f, then a 1-HP blow
    // lands (a worker's, COMBAT_DAMAGE_WORKER) — the tick leaves her HP as it was.
    const H = h.healTickAfter(h.hit, 300);
    h.strikes.add(H);
    h.runTo(H);
    const hpBefore = h.world.ants.hp[h.q];
    expect(hpBefore).toBeLessThan(QUEEN_HP_HOME - 5);
    h.frameOf(1); // sim tick H
    expect(h.world.ants.hp[h.q]).toBe(hpBefore); // no HP lost across the tick…
    expect(h.world.ants.lastHitTick[h.q]).toBe(H);
    expect(h.s.lastHarmTick).toBe(H + 1); // …but the blow is harm, seen after it
    expect(h.pulses()).toBe(2); // pulsed for the new attack
    expect(h.shown).toHaveLength(1); // not re-armed yet: same danger spell
    // No re-arm 30 s after the first blow…
    h.runTo(h.hit + QUEEN_DANGER_REARM_UNHURT_TICKS + 1);
    expect(h.s.lastHarmTick).toBe(H + 1);
    // …only 30 s after the hidden one, while she is still wounded.
    h.runTo(H + 1 + QUEEN_DANGER_REARM_UNHURT_TICKS - 1);
    expect(h.s.lastHarmTick).toBe(H + 1);
    h.frameOf(1);
    expect(h.s.lastHarmTick).toBeNull();
    expect(h.world.ants.hp[h.q]).toBeLessThan(QUEEN_HP_HOME);
    // Re-armed: the next hidden blow is announced.
    const H2 = h.healTickAfter(h.world.tick, 0);
    h.strikes.add(H2);
    h.runTo(H2);
    const hpBefore2 = h.world.ants.hp[h.q];
    expect(hpBefore2).toBeLessThan(QUEEN_HP_HOME); // still wounded: she heals on H2
    h.frameOf(1); // sim tick H2
    expect(h.world.ants.hp[h.q]).toBe(hpBefore2);
    expect(h.shown).toEqual([h.hit + 1, H2 + 1]);
    expect(h.pulses()).toBe(3);
    expect(h.world.ants.alive[h.q]).toBe(1);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);

  it('a blow just after the 30 s re-arm, inside one frame: re-armed on its own tick, so the new attack is announced', () => {
    const h = loopHarness();
    // Unharmed since the look at h.hit, fed and still wounded: the look at
    // h.hit + 600 re-arms. A 1-HP blow lands on that sim tick (seen at the next look),
    // and one 5-tick frame holds both.
    const rearmAt = h.hit + QUEEN_DANGER_REARM_UNHURT_TICKS;
    h.strikes.add(rearmAt);
    h.runTo(rearmAt - 2);
    expect(h.s.lastHarmTick).toBe(h.hit); // not yet re-armed
    h.frameOf(MAX_CATCHUP_TICKS); // sim ticks rearmAt - 2 .. rearmAt + 2
    expect(h.world.ants.hp[h.q]).toBeLessThan(QUEEN_HP_HOME); // still wounded
    expect(h.s.lastHarmTick).toBe(rearmAt + 1); // the new blow, seen after its tick
    expect(h.shown).toEqual([h.hit + 1, rearmAt + 3]); // announced in that frame
    expect(h.pulses()).toBe(2);
    // #227: a long run of full-scenario ticks — explicit generous timeout so the local
    // coverage gate passes under v8 instrumentation.
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #416 review — batching invariance: the property test.
//
// State-space audit. One LOOK per sim tick's end state (beforeSimTick's before each
// tick, the frame step's after the frame's last), each handled by stepQueenDanger
// the same way wherever it falls in a render frame:
//
//   tracker at the look              | since the previous look                  | the look decides, as of its tick
//   ---------------------------------+------------------------------------------+-------------------------------------------------
//   any                              | HP dropped (a blow, a starvation drain)  | harm; past the grace: a pulse, + caption if armed
//   any                              | new lastHitTick, HP not dropped          | the same (a heal and a 1-HP blow in one tick)
//   never harmed / re-armed          | nothing                                  | nothing
//   harmed, not fed                  | nothing                                  | nothing (a starving queen never re-arms)
//   harmed, fed, unharmed < 200      | nothing                                  | nothing
//   harmed, fed, at full HP, ≥ 200   | nothing                                  | re-arm (untrigger)
//   harmed, fed, unharmed ≥ 600      | nothing                                  | re-arm (untrigger)
//   any                              | nothing: a second look at the same state | nothing (idempotent)
//
// In-frame position (first, middle, last tick, or a frame of its own) never enters a
// decision; it only picks the frame that presents it — the one whose looks include
// that tick. advanceQueenDanger presents one pulse for any harm owed, and the caption
// if one was decided. So, for any sequence of per-tick events and any batching, a
// frame pulses iff some harm past the grace was seen at a tick in (its first tick,
// its last tick], and shows the caption iff the caption was decided at such a tick —
// with the decisions those of an independent per-tick model (`oracle`). Fixed cases:
// Codex's three batching findings on #418.

/** The queen after one sim tick of a script (sim order: meal or drain at step 3, heal at 16f, blow at 17). */
interface ScriptTick {
  readonly hp: number;
  readonly lastHit: number;
  /** She ate on this tick. */
  readonly meal: boolean;
  /** A blow landed, or a drain took HP, on this tick. */
  readonly harm: boolean;
}

/**
 * Play `n` sim ticks of the queen in her nest by the sim's rules: unfed ticks drain
 * 1 HP every QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS (never to 0); a fed, safe, wounded
 * queen heals 1 HP on each heal tick; then a blow of `blowOn(t)` HP lands (0 = none;
 * never to 0 HP, though it stamps her clock).
 */
function playQueen(
  n: number,
  fedOn: (t: number) => boolean,
  blowOn: (t: number, healedThisTick: boolean) => number,
): ScriptTick[] {
  const out: ScriptTick[] = [];
  let hp = QUEEN_HP_HOME;
  let lastHit = -1;
  let unfed = 0;
  for (let t = 0; t < n; t++) {
    const meal = fedOn(t);
    let harm = false;
    if (meal) unfed = 0;
    else if (++unfed % QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS === 0 && hp > 1) {
      hp -= 1;
      harm = true;
    }
    let healed = false;
    const safe = lastHit < 0 || t - lastHit >= HEAL_SAFE_TICKS;
    if (meal && safe && hp < QUEEN_HP_HOME && t % QUEEN_HEAL_INTERVAL_TICKS === 0) {
      hp += 1;
      healed = true;
    }
    const dmg = blowOn(t, healed);
    if (dmg > 0) {
      hp = Math.max(1, hp - dmg);
      lastHit = t;
      harm = true;
    }
    out.push({ hp, lastHit, meal, harm });
  }
  return out;
}

/** mulberry32: a small seeded PRNG in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random script of episodes: a burst of harm — a fight (blows of 1–3 HP), a famine
 * (drains), a trickle (short unfed runs), a 1-HP blow on a heal tick that the heal
 * cancels, a drain just before a heal tick, or one blow (often heavy, so she stays
 * wounded) — then calm: within a few ticks of the 600- or 200-tick window, or any
 * length. Every boundary is crossed at every phase of a frame across the batchings.
 */
function randomScript(seed: number, n: number): ScriptTick[] {
  const r = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const fed = new Array<boolean>(n).fill(true);
  const blow = new Array<number>(n).fill(0);
  const sneak = new Set<number>();
  const healTickFrom = (t: number): number =>
    Math.ceil(t / QUEEN_HEAL_INTERVAL_TICKS) * QUEEN_HEAL_INTERVAL_TICKS;
  let t = int(0, 60); // sometimes harm inside the round-start grace
  while (t < n) {
    const k = r();
    if (k < 0.35) {
      const len = int(1, 60);
      const p = 0.05 + r() * 0.25;
      for (let i = 0; i < len && t < n; i++, t++) if (i === 0 || r() < p) blow[t] = int(1, 3);
    } else if (k < 0.5) {
      const len = int(QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS, 40);
      for (let i = 0; i < len && t < n; i++, t++) fed[t] = false;
    } else if (k < 0.62) {
      const end = t + int(40, 240);
      while (t < end && t < n) {
        const unfedRun = int(QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS, 8);
        for (let j = 0; j < unfedRun && t < n; j++, t++) fed[t] = false;
        t += int(10, 60);
      }
    } else if (k < 0.72) {
      t = healTickFrom(t + HEAL_SAFE_TICKS); // safe again, so the heal lands first
      sneak.add(t);
      t += 1;
    } else if (k < 0.8) {
      const heal = healTickFrom(t + HEAL_SAFE_TICKS + QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS);
      for (let u = heal - QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS; u < heal && u < n; u++)
        fed[u] = false;
      t = heal + 1;
    } else {
      blow[t] = r() < 0.6 ? int(10, 25) : int(1, 3);
      t += 1;
    }
    const g = r();
    t +=
      g < 0.35
        ? QUEEN_DANGER_REARM_UNHURT_TICKS + int(-6, 6)
        : g < 0.55
          ? QUEEN_DANGER_REARM_TICKS + int(-6, 6)
          : g < 0.75
            ? int(0, 150)
            : int(150, 1300);
  }
  return playQueen(
    n,
    (u) => fed[u]!,
    (u) => (blow[u]! > 0 ? blow[u]! : sneak.has(u) ? 1 : 0),
  );
}

/** A script from fixed blows (sim tick → HP) and unfed sim-tick ranges, calm otherwise. */
function fixedScript(
  n: number,
  blows: ReadonlyMap<number, number>,
  unfed: readonly (readonly [number, number])[] = [],
): ScriptTick[] {
  return playQueen(
    n,
    (t) => !unfed.some(([a, b]) => t >= a && t <= b),
    (t) => blows.get(t) ?? 0,
  );
}

/**
 * The independent per-tick model of the rule: the world ticks at which a pulse is
 * decided (harm past the grace) and at which the caption is (such harm while armed).
 * Sim tick t's end state is looked at on world tick t + 1.
 */
function oracle(script: readonly ScriptTick[]): {
  pulses: Set<number>;
  captions: Set<number>;
  rearms: { unhurt: number; healed: number };
} {
  const pulses = new Set<number>();
  const captions = new Set<number>();
  const rearms = { unhurt: 0, healed: 0 };
  let armed = true;
  let lastHarm: number | null = null;
  for (let t = 0; t < script.length; t++) {
    const T = t + 1;
    const st = script[t]!;
    if (st.harm) {
      lastHarm = T;
      if (T > QUEEN_DAMAGE_SUPPRESS_TICKS) {
        pulses.add(T);
        if (armed) captions.add(T);
        armed = false;
      }
      continue;
    }
    if (lastHarm === null || !st.meal) continue;
    const unharmed = T - lastHarm;
    const full = st.hp >= QUEEN_HP_HOME;
    if (unharmed >= QUEEN_DANGER_REARM_UNHURT_TICKS) rearms.unhurt += 1;
    else if (full && unharmed >= QUEEN_DANGER_REARM_TICKS) rearms.healed += 1;
    else continue;
    lastHarm = null;
    armed = true;
  }
  return { pulses, captions, rearms };
}

/** Frame sizes (sim ticks per render frame, 0..MAX_CATCHUP_TICKS) by frame index. */
type Batching = { readonly name: string; readonly size: (frame: number) => number };

function batchings(seed: number): Batching[] {
  const out: Batching[] = [{ name: '1', size: () => 1 }];
  for (const n of [2, 3, MAX_CATCHUP_TICKS]) {
    for (let off = 0; off < n; off++) {
      out.push({ name: `${n}+${off}`, size: (i) => (i === 0 && off > 0 ? off : n) });
    }
  }
  const cycle = (name: string, sizes: readonly number[]): Batching => ({
    name,
    size: (i) => sizes[i % sizes.length]!,
  });
  out.push(cycle('irregular A', [1, 5, 2, 0, 4, 3, 5, 0, 1, 1, 5, 2]));
  out.push(cycle('irregular B', [5, 5, 5, 1, 0, 0, 3, 2, 5, 4]));
  const r = prng(seed ^ 0x9e3779b9);
  const sizes = Array.from({ length: 97 }, () => Math.floor(r() * (MAX_CATCHUP_TICKS + 1)));
  sizes[0] = 1;
  out.push(cycle('random', sizes));
  return out;
}

describe('#416 review: the outcome of every tick is the same however the ticks are batched', () => {
  const world = createScenario(7, 'Normal');
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const q = stageQueenInNest(world, colony);
  const prev = createScenario(7, 'Normal');

  function setTick(w: WorldState, t: number): void {
    // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
    w.tick = t;
  }

  /**
   * Play `script` through GameScene's wiring — the game loop, `perTick` as its
   * onBeforeTick, advanceQueenDanger once per render frame — with `batching`'s frame
   * sizes, and return the frames whose pulse or caption disagree with the oracle.
   */
  function mismatches(
    script: readonly ScriptTick[],
    batching: Batching,
    hook: 'beforeSimTick' | 'noteQueenDangerTick',
  ): string[] {
    resetCaptions();
    setTick(world, 0);
    world.ants.hp[q] = QUEEN_HP_HOME;
    world.ants.lastHitTick[q] = -1;
    world.ants.lastMealTick[q] = -1;
    const s = createQueenDangerState();
    const rampage = createRampageCaptionState();
    const loop = createGameLoop(
      (w) => {
        const st = script[w.tick]!;
        w.ants.hp[q] = st.hp;
        w.ants.lastHitTick[q] = st.lastHit;
        if (st.meal) w.ants.lastMealTick[q] = w.tick;
        setTick(w, w.tick + 1);
        return GameOutcome.None;
      },
      world,
      {
        onBeforeTick:
          hook === 'beforeSimTick'
            ? (w) =>
                beforeSimTick(w, [], PLAYER_COLONY_ID, prev, {
                  rampage: rampage,
                  queenDanger: s,
                  enemyQueenWound: createEnemyQueenWoundState(),
                  counterAttack: createCounterAttackCaptionState(),
                  storesFilling: createStoresFillingCaptionState(),
                  storageHint: createStorageHintState(),
                })
            : (w) => noteQueenDangerTick(s, w, PLAYER_COLONY_ID),
      },
    );
    const want = oracle(script);
    const inFrame = (ticks: Set<number>, from: number, to: number): boolean => {
      for (let t = from + 1; t <= to; t++) if (ticks.has(t)) return true;
      return false;
    };
    const bad: string[] = [];
    for (let i = 0; world.tick < script.length; i++) {
      const from = world.tick;
      const n = Math.min(batching.size(i), script.length - from);
      loop.update(n * MS_PER_TICK);
      const f = advanceQueenDanger(s, world, colony);
      const to = world.tick;
      const pulse = inFrame(want.pulses, from, to);
      const caption = inFrame(want.captions, from, to);
      if (f.pulse !== pulse || (f.caption !== null) !== caption) {
        bad.push(
          `[${batching.name}] frame ${from}..${to}: pulse ${f.pulse}/${pulse}, caption ${f.caption !== null}/${caption}`,
        );
      }
    }
    return bad.slice(0, 5);
  }

  function expectInvariant(
    script: readonly ScriptTick[],
    seed: number,
    hook: 'beforeSimTick' | 'noteQueenDangerTick',
  ): void {
    const want = oracle(script);
    expect(want.captions.size).toBeGreaterThan(1); // the script exercises re-arms
    for (const b of batchings(seed)) expect(mismatches(script, b, hook)).toEqual([]);
  }

  // Codex's three findings on #418, through beforeSimTick (GameScene's own wiring).
  it('fixed: a drain, a meal and a heal inside one frame (8d1bbaf)', () => {
    // A heavy blow; then, at heal tick 440, a drain on 439 (unfed 434..439) that the
    // meal and heal on 440 hide; then blows that a too-early re-arm would announce.
    const script = fixedScript(
      1500,
      new Map([
        [100, 30],
        [720, 2],
        [1400, 2],
      ]),
      [[434, 439]],
    );
    expect(script[439]!.harm && script[440]!.hp === script[438]!.hp).toBe(true);
    expectInvariant(script, 1, 'beforeSimTick');
    // #227: explicit generous timeout so the local coverage gate passes.
  }, 30_000);

  it('fixed: a heal and a 1-HP blow in one tick (6ed61a3)', () => {
    const script = fixedScript(
      1500,
      new Map([
        [100, 30],
        [440, 1],
        [720, 2],
        [1400, 2],
      ]),
    );
    expect(script[440]!.hp).toBe(script[439]!.hp); // the heal hides the blow
    expectInvariant(script, 2, 'beforeSimTick');
    // #227: explicit generous timeout so the local coverage gate passes.
  }, 30_000);

  it('fixed: a blow on or just after the 30 s re-arm tick, at every frame phase (this fix)', () => {
    // Blows of 15 HP (she stays wounded), each 600 + k sim ticks after the last: the
    // re-arm look is due on the blow's own look (k = 0: not re-armed) or k ticks before it.
    const blows = new Map<number, number>([[100, 20]]);
    let at = 100;
    for (const k of [0, 1, 2, 3, 4, 5]) {
      at += QUEEN_DANGER_REARM_UNHURT_TICKS + k;
      blows.set(at, 15);
    }
    const script = fixedScript(at + 50, blows);
    expect(script.every((st) => st.hp < QUEEN_HP_HOME || st.lastHit < 100)).toBe(true);
    expectInvariant(script, 3, 'beforeSimTick');
    // #227: explicit generous timeout so the local coverage gate passes.
  }, 30_000);

  const SEEDS = [11, 23, 37, 41, 59, 61, 73, 89, 97, 101, 113, 127];
  it.each(SEEDS)('random script, seed %i: every batching matches the per-tick model', (seed) => {
    expectInvariant(randomScript(seed, 4000), seed, 'noteQueenDangerTick');
  });

  it('the random scripts exercise both re-arm paths, a hidden blow and a hidden drain', () => {
    let unhurt = 0;
    let healed = 0;
    let hiddenBlows = 0;
    let hiddenDrains = 0;
    for (const seed of SEEDS) {
      const script = randomScript(seed, 4000);
      const { rearms } = oracle(script);
      unhurt += rearms.unhurt;
      healed += rearms.healed;
      for (let t = 2; t < script.length; t++) {
        const a = script[t - 2]!;
        const b = script[t - 1]!;
        const c = script[t]!;
        if (c.harm && c.lastHit === t && c.hp >= b.hp) hiddenBlows += 1; // healed in its tick
        if (b.harm && b.lastHit !== t - 1 && !c.harm && c.hp >= a.hp) hiddenDrains += 1; // healed next tick
      }
    }
    expect(unhurt).toBeGreaterThan(0);
    expect(healed).toBeGreaterThan(0);
    expect(hiddenBlows).toBeGreaterThan(0);
    expect(hiddenDrains).toBeGreaterThan(0);
  });
});
