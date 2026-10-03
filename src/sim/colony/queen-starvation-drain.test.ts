// queen-starvation-drain.test.ts — #375 (V66): the queen starves by losing HP;
// #400 (V71): she heals only while fed, safe and in her nest.
//
// While she cannot eat she loses 1 HP each time the ticks since her last meal reach
// a multiple of QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS, and dies of starvation at 0 HP.
// Covered: the drain schedule, a queen at full home HP dying on the V65 tick, a
// wounded one sooner, a meal stopping the drain and restarting the interval, the
// meal itself healing nothing (#400), healing in step 16f (fed, safe, in her nest;
// capped; not while starving; not on the surface; not right after a blow), short
// famines healing back, the queen_death cause through tick(), the larva unchanged,
// and the V65 instant-death path pinned.
import { describe, it, expect } from 'vitest';
import { tickFoodConsumption } from './colony-system.js';
import { createScenario } from '../scenario.js';
import { tick } from '../tick.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask } from '../enums.js';
import {
  COMBAT_HP_QUEEN,
  HEAL_SAFE_TICKS,
  PLAYER_COLONY_ID,
  QUEEN_FOOD_PER_TICK,
  QUEEN_HEAL_INTERVAL_TICKS,
  QUEEN_HP_HOME,
  QUEEN_STARVE_AFTER_TICKS,
  QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS,
  QUEEN_MEAL_INTERVAL_TICKS,
  STARVATION_GRACE_TICKS,
} from '../constants.js';
import { LARVA_HUNGER, mealsUntilStarvation, QUEEN_HUNGER } from '../hunger.js';
import { tickHealth } from '../health.js';
import { stageQueenInNest } from '../health-test-utils.js';
import { setColonyFoodForTest, setMealsUntilStarvationForTest } from '../food/food-test-utils.js';
import { allocateEntityId, SIM_VERSION_V66_QUEEN_STARVES_HP } from '../types.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from './colony-store.js';

const V65 = SIM_VERSION_V66_QUEEN_STARVES_HP - 1;
const D = QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS;

/** A scenario world (at `simVersion` if given), the player colony emptied of food. */
function starvingWorld(simVersion?: number): {
  world: WorldState;
  colony: ColonyRecord;
  q: number;
} {
  const world = createScenario(7, 'Normal');
  if (simVersion !== undefined) world.simVersion = simVersion;
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  setColonyFoodForTest(world, colony, 0);
  return { world, colony, q: colony.queenEntityId };
}

/** The same, with the queen staged in her nest (home ground) at full home HP. */
function starvingWorldInNest(): { world: WorldState; colony: ColonyRecord; q: number } {
  const r = starvingWorld();
  stageQueenInNest(r.world, r.colony);
  r.world.ants.hp[r.q] = QUEEN_HP_HOME;
  return r;
}

/** Step 3 of one tick (the colony's meals), then the tick advances, as tick() does. */
function consume(world: WorldState, colony: ColonyRecord): void {
  tickFoodConsumption(world, colony);
  world.tick += 1;
}

/** Step 3 then step 16f (health) of one tick, then the tick advances. */
function consumeAndHeal(world: WorldState, colony: ColonyRecord): void {
  tickFoodConsumption(world, colony);
  tickHealth(world);
  world.tick += 1;
}

/** Ticks of step 3 until the queen dies (the tick she died on), or -1 within `limit`. */
function deathTick(world: WorldState, colony: ColonyRecord, limit = 1000): number {
  for (let i = 0; i < limit; i++) {
    const t = world.tick;
    consume(world, colony);
    if (world.ants.alive[colony.queenEntityId] === 0) return t;
  }
  return -1;
}

describe('#375 V66 — the queen starves by losing HP', () => {
  it('drain interval × full home HP = 300 ticks: a queen at full health lasts exactly the old grace', () => {
    expect(D * QUEEN_HP_HOME).toBe(QUEEN_STARVE_AFTER_TICKS);
    expect(QUEEN_STARVE_AFTER_TICKS).toBe(STARVATION_GRACE_TICKS);
    // #400: she is fed only on a tick she ate, so her healing needs a meal every tick.
    expect(QUEEN_MEAL_INTERVAL_TICKS).toBe(1);
  });

  it('a queen at full home HP never fed dies on the same tick as at V65 (tick 299)', () => {
    const a = starvingWorldInNest();
    const b = starvingWorld(V65);
    const dA = deathTick(a.world, a.colony);
    const dB = deathTick(b.world, b.colony);
    expect(dB).toBe(STARVATION_GRACE_TICKS - 1);
    expect(dA).toBe(dB);
  });

  it('she loses 1 HP each time ticks-since-meal reaches a multiple of the drain interval, and no other tick', () => {
    const { world, colony, q } = starvingWorldInNest();
    // createScenario: lastMealTick = −1, so tick t is t + 1 ticks since her meal.
    for (let t = 0; t < STARVATION_GRACE_TICKS - 1; t++) {
      consume(world, colony);
      const sinceMeal = t + 1;
      const drained = sinceMeal - (sinceMeal % D);
      // HP lost so far = the multiples of D reached (integer: drained is a multiple).
      let lost = 0;
      for (let m = D; m <= drained; m += D) lost += 1;
      expect(world.ants.hp[q], `tick ${t}`).toBe(QUEEN_HP_HOME - lost);
      expect(world.ants.alive[q], `tick ${t}`).toBe(1);
    }
    expect(world.ants.hp[q]).toBe(1);
    consume(world, colony); // tick 299: the last drain
    expect(world.ants.hp[q]).toBe(0);
    expect(world.ants.alive[q]).toBe(0);
  });

  it('a wounded queen starves sooner: at h HP she dies h × D ticks after her last meal', () => {
    for (const h of [1, 6, 17, 29, COMBAT_HP_QUEEN]) {
      const { world, colony, q } = starvingWorld();
      world.ants.hp[q] = h;
      // lastMealTick = −1: the (h × D)-th tick since is tick h × D − 1.
      expect(deathTick(world, colony), `hp ${h}`).toBe(h * D - 1);
    }
  });

  it('V65 pinned: a wounded queen still dies only at the 300-tick clock, her HP untouched', () => {
    const { world, colony, q } = starvingWorld(V65);
    world.ants.hp[q] = 6;
    expect(deathTick(world, colony)).toBe(STARVATION_GRACE_TICKS - 1);
    expect(world.ants.hp[q]).toBe(6);
  });

  it('eating stops the drain and heals nothing by itself (#400); a new famine restarts the interval', () => {
    const { world, colony, q } = starvingWorldInNest();
    for (let t = 0; t < 5 * D + 1; t++) consume(world, colony); // 5 drains
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME - 5);

    // Food arrives: she eats every tick (the queen eats first), and step 3 alone no
    // longer heals her (V66 did; from V71 her healing is step 16f's).
    for (let t = 0; t < 10 * QUEEN_HEAL_INTERVAL_TICKS; t++) {
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consume(world, colony);
      expect(mealsUntilStarvation(world, q, QUEEN_HUNGER)).toBe(STARVATION_GRACE_TICKS);
    }
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME - 5);

    // The food runs out: the interval counts from her last meal, not the old one.
    setColonyFoodForTest(world, colony, 0);
    for (let i = 1; i < D; i++) consume(world, colony);
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME - 5);
    consume(world, colony); // D ticks since her last meal
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME - 6);
    const lastMeal = world.ants.lastMealTick[q]!;
    // She had QUEEN_HP_HOME − 5 at her last meal: she dies that many drains after it.
    expect(deathTick(world, colony)).toBe(lastMeal + (QUEEN_HP_HOME - 5) * D);
  });

  it('a larva keeps V65 starvation at V66: dies at its 300-tick clock', () => {
    const { world, colony } = starvingWorld();
    world.ants.hp[colony.queenEntityId] = 1000; // keep the queen out of it
    const id = allocateEntityId(world);
    initAnt(world.ants, id, { colonyId: PLAYER_COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });
    colony.larvae.push(id);
    colony.larvaeCount += 1;
    setMealsUntilStarvationForTest(world, id, LARVA_HUNGER, STARVATION_GRACE_TICKS);
    const hp = world.ants.hp[id]!;
    for (let i = 0; i < STARVATION_GRACE_TICKS - 1; i++) {
      consume(world, colony);
      expect(world.ants.alive[id]).toBe(1);
    }
    expect(world.ants.hp[id]).toBe(hp);
    consume(world, colony);
    expect(world.ants.alive[id]).toBe(0);
  });

  it('a queen fed at least every D − 1 ticks never loses HP', () => {
    const { world, colony, q } = starvingWorldInNest();
    for (let t = 0; t < 900; t++) {
      if (t % (D - 1) === D - 2) setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consumeAndHeal(world, colony);
      expect(world.ants.hp[q], `tick ${t}`).toBe(QUEEN_HP_HOME);
    }
    expect(world.ants.alive[q]).toBe(1);
  });
});

describe('#400 V71 — the queen heals while fed, safe and in her nest (step 16f)', () => {
  it('fed in her nest she regains 1 HP on each heal-interval tick, up to QUEEN_HP_HOME', () => {
    const { world, colony, q } = starvingWorldInNest();
    world.ants.hp[q] = QUEEN_HP_HOME - 5;
    let healed = 0;
    for (let t = 0; t < 10 * QUEEN_HEAL_INTERVAL_TICKS; t++) {
      const now = world.tick;
      const before = world.ants.hp[q];
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consumeAndHeal(world, colony);
      const expected = now % QUEEN_HEAL_INTERVAL_TICKS === 0 && before < QUEEN_HP_HOME ? 1 : 0;
      expect(world.ants.hp[q] - before, `tick ${now}`).toBe(expected);
      healed += expected;
    }
    expect(healed).toBe(5);
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME); // capped at her home max
  });

  it('she does not heal while starving (not fed)', () => {
    const { world, colony, q } = starvingWorldInNest();
    world.ants.hp[q] = QUEEN_HP_HOME - 10;
    let prev = world.ants.hp[q];
    for (let t = 0; t < 4 * QUEEN_HEAL_INTERVAL_TICKS; t++) {
      consumeAndHeal(world, colony);
      expect(world.ants.hp[q]).toBeLessThanOrEqual(prev);
      prev = world.ants.hp[q]!;
    }
  });

  it('a wounded queen does not heal for HEAL_SAFE_TICKS after a blow, fed or not', () => {
    const { world, colony, q } = starvingWorldInNest();
    world.ants.hp[q] = 10; // e.g. after a fight
    world.ants.lastHitTick[q] = world.tick; // hit this tick (staged)
    const hitTick = world.tick;
    for (let t = 0; t < HEAL_SAFE_TICKS + 2 * QUEEN_HEAL_INTERVAL_TICKS; t++) {
      const now = world.tick;
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consumeAndHeal(world, colony);
      if (now - hitTick < HEAL_SAFE_TICKS) expect(world.ants.hp[q], `tick ${now}`).toBe(10);
    }
    expect(world.ants.hp[q]).toBeGreaterThan(10); // safe at last, and healing
  });

  it('an unfounded queen on the surface (away) never heals, and her max there is COMBAT_HP_QUEEN', () => {
    const { world, colony, q } = starvingWorld(); // createScenario: she starts on the surface
    world.ants.hp[q] = COMBAT_HP_QUEEN - 6;
    for (let t = 0; t < 10 * QUEEN_HEAL_INTERVAL_TICKS; t++) {
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consumeAndHeal(world, colony);
    }
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN - 6);
    // Above her surface max she clamps down to it (staged: as if she had just come up).
    world.ants.hp[q] = QUEEN_HP_HOME;
    consumeAndHeal(world, colony);
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN);
  });

  it('short famines heal back when she is fed long enough between them; without the time they add up', () => {
    // Each famine: 5 × D unfed ticks = 5 HP. Fed 6 heal intervals between them she is
    // whole again; fed only one tick between them (never on a heal tick) she is not.
    const run = (fedTicks: number): { alive: boolean; hp: number } => {
      const { world, colony, q } = starvingWorldInNest();
      for (let famine = 0; famine < 12; famine++) {
        setColonyFoodForTest(world, colony, 0);
        for (let i = 0; i < 5 * D; i++) {
          consumeAndHeal(world, colony);
          if (world.ants.alive[q] === 0) return { alive: false, hp: 0 };
        }
        for (let i = 0; i < fedTicks; i++) {
          // Skip heal ticks when fed only briefly (the "without the time" arm).
          if (fedTicks === 1 && world.tick % QUEEN_HEAL_INTERVAL_TICKS === 0) {
            consumeAndHeal(world, colony);
          }
          setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
          consumeAndHeal(world, colony);
        }
      }
      return { alive: world.ants.alive[q] === 1, hp: world.ants.hp[q]! };
    };
    const healed = run(6 * QUEEN_HEAL_INTERVAL_TICKS);
    expect(healed.alive).toBe(true);
    expect(healed.hp).toBe(QUEEN_HP_HOME);
    expect(run(1).alive).toBe(false); // ~5 HP per famine, never healed: dies by the 11th
  });
});

describe('#375 V66 — starvation by drain through tick(): queen_death cause Starvation', () => {
  function runUntilPlayerQueenDies(world: WorldState, limit: number): number {
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (let i = 0; i < limit; i++) {
      // Keep the colony unfed (foragers may bank food mid-run).
      setColonyFoodForTest(world, colony, 0);
      const t = world.tick;
      tick(world, []);
      if (world.ants.alive[colony.queenEntityId] === 0) return t;
    }
    return -1;
  }

  it('a wounded queen (4 HP) starves at tick 4D − 1; the event reports Starvation', () => {
    const world = createScenario(7, 'Normal');
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V66_QUEEN_STARVES_HP);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    world.ants.hp[colony.queenEntityId] = 4;
    expect(runUntilPlayerQueenDies(world, 400)).toBe(4 * D - 1);
    expect(world.ants.hp[colony.queenEntityId]).toBe(0);
    // She died before the old 300-tick clock ran out.
    expect(mealsUntilStarvation(world, colony.queenEntityId, QUEEN_HUNGER)).toBeGreaterThan(0);
    const deaths = world.events.filter((e) => e.type === 'queen_death');
    expect(deaths).toHaveLength(1);
    expect(deaths[0]!.type === 'queen_death' && deaths[0]!.payload.cause).toBe('Starvation');
    expect(colony.defeated).toBe(true);
  });

  it('#400: an unfounded queen (surface, full surface HP) starves at COMBAT_HP_QUEEN × D − 1; one in her nest at full home HP at tick 299', () => {
    const away = createScenario(7, 'Normal');
    expect(runUntilPlayerQueenDies(away, 400)).toBe(COMBAT_HP_QUEEN * D - 1);
    const home = createScenario(7, 'Normal');
    const colony = home.colonies[PLAYER_COLONY_ID]!;
    stageQueenInNest(home, colony);
    home.ants.hp[colony.queenEntityId] = QUEEN_HP_HOME;
    expect(runUntilPlayerQueenDies(home, 400)).toBe(STARVATION_GRACE_TICKS - 1);
    for (const w of [away, home]) {
      const deaths = w.events.filter((e) => e.type === 'queen_death');
      expect(deaths).toHaveLength(1);
      expect(deaths[0]!.type === 'queen_death' && deaths[0]!.payload.cause).toBe('Starvation');
    }
  });
});
