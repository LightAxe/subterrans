// queen-starvation-drain.test.ts — #375 (V66): the queen starves by losing HP.
//
// While she cannot eat she loses 1 HP each time the ticks since her last meal reach
// a multiple of QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS, and dies of starvation at 0 HP.
// Covered: the drain schedule, a full-HP queen dying on the V65 tick, a wounded one
// sooner, a meal stopping the drain, regeneration while fed (capped, not while
// starving, combat wounds too, not at V65), the drain restarting after a meal, the
// home-ground buffer untouched, the queen_death cause through tick(), the
// larva unchanged, and the V65 instant-death path pinned.
import { describe, it, expect } from 'vitest';
import { tickFoodConsumption } from './colony-system.js';
import { createScenario } from '../scenario.js';
import { tick } from '../tick.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask } from '../enums.js';
import {
  COMBAT_HP_QUEEN,
  PLAYER_COLONY_ID,
  QUEEN_FOOD_PER_TICK,
  QUEEN_STARVE_AFTER_TICKS,
  QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS,
  QUEEN_FED_HP_REGEN_INTERVAL_TICKS,
  QUEEN_MEAL_INTERVAL_TICKS,
  STARVATION_GRACE_TICKS,
} from '../constants.js';
import { LARVA_HUNGER, mealsUntilStarvation, QUEEN_HUNGER } from '../hunger.js';
import { setColonyFoodForTest, setMealsUntilStarvationForTest } from '../food/food-test-utils.js';
import { allocateEntityId, SIM_VERSION_V66_QUEEN_STARVES_HP } from '../types.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from './colony-store.js';

const V65 = SIM_VERSION_V66_QUEEN_STARVES_HP - 1;

/** A scenario world at `simVersion`, the player colony emptied of food. */
function starvingWorld(simVersion: number): {
  world: WorldState;
  colony: ColonyRecord;
  q: number;
} {
  const world = createScenario(7, 'Normal');
  world.simVersion = simVersion;
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  setColonyFoodForTest(world, colony, 0);
  return { world, colony, q: colony.queenEntityId };
}

/** Step 3 of one tick (the colony's meals), then the tick advances, as tick() does. */
function consume(world: WorldState, colony: ColonyRecord): void {
  tickFoodConsumption(world, colony);
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
  it('10 × 30 HP = 300 ticks: a full-HP queen lasts exactly the old grace', () => {
    expect(QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS * COMBAT_HP_QUEEN).toBe(QUEEN_STARVE_AFTER_TICKS);
    expect(QUEEN_STARVE_AFTER_TICKS).toBe(STARVATION_GRACE_TICKS);
    // The regen is keyed on the ticks she EATS: regular only while she tries to eat
    // every tick. A meal interval above 1 would phase-lock it (see the constant).
    expect(QUEEN_MEAL_INTERVAL_TICKS).toBe(1);
  });

  it('a full-HP queen never fed dies on the same tick at V66 as at V65 (tick 299)', () => {
    const a = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    const b = starvingWorld(V65);
    expect(a.world.ants.hp[a.q]).toBe(COMBAT_HP_QUEEN);
    const dA = deathTick(a.world, a.colony);
    const dB = deathTick(b.world, b.colony);
    expect(dB).toBe(STARVATION_GRACE_TICKS - 1);
    expect(dA).toBe(dB);
  });

  it('she loses 1 HP each time ticks-since-meal reaches a multiple of 10, and no other tick', () => {
    const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    // createScenario: lastMealTick = −1, so tick t is t + 1 ticks since her meal.
    for (let t = 0; t < STARVATION_GRACE_TICKS - 1; t++) {
      consume(world, colony);
      const sinceMeal = t + 1;
      const drained = sinceMeal - (sinceMeal % QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS);
      // HP lost so far = the multiples of 10 reached (integer: drained is a multiple).
      let lost = 0;
      for (
        let m = QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS;
        m <= drained;
        m += QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS
      )
        lost += 1;
      expect(world.ants.hp[q], `tick ${t}`).toBe(COMBAT_HP_QUEEN - lost);
      expect(world.ants.alive[q], `tick ${t}`).toBe(1);
    }
    expect(world.ants.hp[q]).toBe(1);
    consume(world, colony); // tick 299: the 30th drain
    expect(world.ants.hp[q]).toBe(0);
    expect(world.ants.alive[q]).toBe(0);
  });

  it('a wounded queen starves sooner: at h HP she dies h × 10 ticks after her last meal', () => {
    for (const h of [1, 6, 17, 29]) {
      const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
      world.ants.hp[q] = h;
      // lastMealTick = −1: the (h × 10)-th tick since is tick h × 10 − 1.
      expect(deathTick(world, colony), `hp ${h}`).toBe(
        h * QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS - 1,
      );
    }
  });

  it('V65 pinned: a wounded queen still dies only at the 300-tick clock, her HP untouched', () => {
    const { world, colony, q } = starvingWorld(V65);
    world.ants.hp[q] = 6;
    expect(deathTick(world, colony)).toBe(STARVATION_GRACE_TICKS - 1);
    expect(world.ants.hp[q]).toBe(6);
  });

  it('eating stops the drain; fed, she heals 1 HP per regen interval up to full; a new famine restarts the interval', () => {
    const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    for (let t = 0; t < 55; t++) consume(world, colony); // sinceMeal 1..55: 5 drains
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN - 5);

    // Food arrives: she eats every tick (one meal's worth each tick: the queen eats
    // first, so nobody else takes it) and regains 1 HP on each tick she eats whose
    // number is a multiple of the regen interval, never above her max.
    let healed = 0;
    for (let t = 0; t < 10 * QUEEN_FED_HP_REGEN_INTERVAL_TICKS; t++) {
      const eatTick = world.tick;
      const before = world.ants.hp[q]!;
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consume(world, colony);
      expect(mealsUntilStarvation(world, q, QUEEN_HUNGER)).toBe(STARVATION_GRACE_TICKS);
      const expected =
        eatTick % QUEEN_FED_HP_REGEN_INTERVAL_TICKS === 0 && before < COMBAT_HP_QUEEN ? 1 : 0;
      expect(world.ants.hp[q]! - before, `tick ${eatTick}`).toBe(expected);
      healed += expected;
    }
    expect(healed).toBe(5);
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN); // capped at full
    expect(world.ants.alive[q]).toBe(1);

    // The food runs out: the interval counts from her last meal, not the old one.
    setColonyFoodForTest(world, colony, 0);
    for (let i = 1; i < QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS; i++) consume(world, colony);
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN);
    consume(world, colony); // 10 ticks since her last meal
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN - 1);
    // 29 HP left: she dies 300 ticks after her last meal, as from full.
    const lastMeal = world.ants.lastMealTick[q]!;
    expect(deathTick(world, colony)).toBe(lastMeal + STARVATION_GRACE_TICKS);
  });

  it('she does not heal while starving, nor above her max when fed', () => {
    const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    world.ants.hp[q] = 20;
    // Unfed across several regen ticks: HP only falls.
    let prev = 20;
    for (let t = 0; t < 3 * QUEEN_FED_HP_REGEN_INTERVAL_TICKS; t++) {
      consume(world, colony);
      expect(world.ants.hp[q]).toBeLessThanOrEqual(prev);
      prev = world.ants.hp[q]!;
    }
    // A full-HP queen fed across many regen ticks stays at max.
    const fed = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    for (let t = 0; t < 5 * QUEEN_FED_HP_REGEN_INTERVAL_TICKS; t++) {
      setColonyFoodForTest(fed.world, fed.colony, QUEEN_FOOD_PER_TICK);
      consume(fed.world, fed.colony);
      expect(fed.world.ants.hp[fed.q]).toBe(COMBAT_HP_QUEEN);
    }
  });

  it('combat wounds heal the same way while she is fed; the home-ground buffer is not regenerated', () => {
    const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    world.ants.hp[q] = 6; // e.g. after a fight
    world.ants.homeGroundBonusHp[q] = 1;
    for (let t = 0; t < 24 * QUEEN_FED_HP_REGEN_INTERVAL_TICKS; t++) {
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consume(world, colony);
    }
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN);
    expect(world.ants.homeGroundBonusHp[q]).toBe(1);
  });

  it('V65 pinned: a wounded queen who is fed never heals', () => {
    const { world, colony, q } = starvingWorld(V65);
    world.ants.hp[q] = 6;
    for (let t = 0; t < 10 * QUEEN_FED_HP_REGEN_INTERVAL_TICKS; t++) {
      setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consume(world, colony);
    }
    expect(world.ants.hp[q]).toBe(6);
  });

  it('short famines heal back when she is fed long enough between them; without the time they add up', () => {
    // Each famine: 50 unfed ticks = 5 HP. Fed 6 regen intervals between them she is
    // whole again; fed only one tick between them (never on a regen tick) she is not.
    const run = (fedTicks: number): { alive: boolean; hp: number } => {
      const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
      for (let famine = 0; famine < 8; famine++) {
        setColonyFoodForTest(world, colony, 0);
        for (let i = 0; i < 5 * QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS; i++) {
          consume(world, colony);
          if (world.ants.alive[q] === 0) return { alive: false, hp: 0 };
        }
        for (let i = 0; i < fedTicks; i++) {
          // Skip regen ticks when fed only briefly (the "without the time" arm).
          if (fedTicks === 1 && world.tick % QUEEN_FED_HP_REGEN_INTERVAL_TICKS === 0) {
            consume(world, colony);
          }
          setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
          consume(world, colony);
        }
      }
      return { alive: world.ants.alive[q] === 1, hp: world.ants.hp[q]! };
    };
    const healed = run(6 * QUEEN_FED_HP_REGEN_INTERVAL_TICKS);
    expect(healed.alive).toBe(true);
    expect(healed.hp).toBe(COMBAT_HP_QUEEN);
    expect(run(1).alive).toBe(false); // 5 HP per famine, never healed: dies in the 6th
  });

  it('a queen fed at least every 9 ticks never loses HP', () => {
    const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    for (let t = 0; t < 900; t++) {
      if (t % 9 === 8) setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
      consume(world, colony);
      expect(world.ants.hp[q], `tick ${t}`).toBe(COMBAT_HP_QUEEN);
    }
    expect(world.ants.alive[q]).toBe(1);
  });

  it('the drain takes base HP, not the home-ground combat buffer', () => {
    const { world, colony, q } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
    world.ants.homeGroundBonusHp[q] = 4;
    for (let t = 0; t < 20; t++) consume(world, colony);
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN - 2);
    expect(world.ants.homeGroundBonusHp[q]).toBe(4);
  });

  it('a larva keeps V65 starvation at V66: dies at its 300-tick clock', () => {
    const { world, colony } = starvingWorld(SIM_VERSION_V66_QUEEN_STARVES_HP);
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

  it('a wounded queen (4 HP) starves at tick 39; the event reports Starvation', () => {
    const world = createScenario(7, 'Normal');
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V66_QUEEN_STARVES_HP);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    world.ants.hp[colony.queenEntityId] = 4;
    expect(runUntilPlayerQueenDies(world, 400)).toBe(4 * QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS - 1);
    expect(world.ants.hp[colony.queenEntityId]).toBe(0);
    // She died before the old 300-tick clock ran out.
    expect(mealsUntilStarvation(world, colony.queenEntityId, QUEEN_HUNGER)).toBeGreaterThan(0);
    const deaths = world.events.filter((e) => e.type === 'queen_death');
    expect(deaths).toHaveLength(1);
    expect(deaths[0]!.type === 'queen_death' && deaths[0]!.payload.cause).toBe('Starvation');
    expect(colony.defeated).toBe(true);
  });

  it('a full-HP queen starves at tick 299 at V66, as at V65, and the event reports Starvation', () => {
    for (const v of [SIM_VERSION_V66_QUEEN_STARVES_HP, V65]) {
      const world = createScenario(7, 'Normal');
      world.simVersion = v;
      expect(runUntilPlayerQueenDies(world, 400), `V${v}`).toBe(STARVATION_GRACE_TICKS - 1);
      const deaths = world.events.filter((e) => e.type === 'queen_death');
      expect(deaths).toHaveLength(1);
      expect(deaths[0]!.type === 'queen_death' && deaths[0]!.payload.cause).toBe('Starvation');
    }
  });
});
