// queen-starvation-drain.test.ts — #375 (V66): the queen starves by losing HP;
// #400 (V71): she heals only while fed, safe and in her nest; #398: at the ant rate.
//
// While she cannot eat she loses 1 HP each time the ticks since her last meal reach
// a multiple of QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS, and dies of starvation at 0 HP.
// Covered: the drain schedule, a queen at full home HP dying on tick 299 (the old
// 300-tick grace), a wounded one sooner, a meal stopping the drain and restarting
// the interval, the meal itself healing nothing (#400), healing in step 16f (fed,
// safe, in her nest; capped; not while starving; not on the surface; not right
// after a blow), short famines healing back, the #398 rate (1 HP per
// ANT_HEAL_INTERVAL_TICKS through tick(), on every phase her meals resume on, and
// not mid-fight in a real fight), the queen_death cause through tick(), and the
// larva unchanged.
import { describe, it, expect } from 'vitest';
import { tickFoodConsumption } from './colony-system.js';
import { createScenario } from '../scenario.js';
import { tick } from '../tick.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask } from '../enums.js';
import { Zone } from '../terrain.js';
import {
  ANT_HEAL_INTERVAL_TICKS,
  COMBAT_DAMAGE_BASE,
  COMBAT_HP_QUEEN,
  ENEMY_COLONY_ID,
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
import { antOnHomeGround, isSafeFromHits, tickHealth } from '../health.js';
import { stageQueenInNest } from '../health-test-utils.js';
import { setColonyFoodForTest, setMealsUntilStarvationForTest } from '../food/food-test-utils.js';
import { allocateEntityId, SIM_VERSION_V66_QUEEN_STARVES_HP } from '../types.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from './colony-store.js';

const D = QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS;

/** A scenario world, the player colony emptied of food. */
function starvingWorld(): {
  world: WorldState;
  colony: ColonyRecord;
  q: number;
} {
  const world = createScenario(7, 'Normal');
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

  it('a queen at full home HP never fed dies at tick 299, the old 300-tick grace', () => {
    const a = starvingWorldInNest();
    expect(deathTick(a.world, a.colony)).toBe(STARVATION_GRACE_TICKS - 1);
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

  it('a larva does not drain HP: it dies at its 300-tick clock', () => {
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

describe('#398 — the queen heals at the ant rate, so a wounded queen stays wounded', () => {
  const H = QUEEN_HEAL_INTERVAL_TICKS;

  /** A scenario world without the spider, the player queen staged in her nest at `hp`. */
  function queenAtHome(hp: number): { world: WorldState; colony: ColonyRecord; q: number } {
    const world = createScenario(7, 'Normal');
    world.spider = null; // keep the spider out of it
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = stageQueenInNest(world, colony);
    world.ants.hp[q] = hp;
    return { world, colony, q };
  }

  /** One full tick() with the colony's stores topped up, so the queen eats this tick. */
  function fedTick(world: WorldState, colony: ColonyRecord): void {
    setColonyFoodForTest(world, colony, 1 << 12);
    tick(world, []);
  }

  it('the queen and the ants share one heal interval: 40 ticks, 1 HP every 2 s', () => {
    expect(ANT_HEAL_INTERVAL_TICKS).toBe(40);
    expect(QUEEN_HEAL_INTERVAL_TICKS).toBe(40);
  });

  it('through tick(): fed, safe, at home, from 7 HP she gains 1 HP per heal tick: 43 heals', () => {
    const { world, colony, q } = queenAtHome(7);
    const healTicks: number[] = [];
    for (let i = 0; i < (QUEEN_HP_HOME - 7 + 2) * H; i++) {
      const now = world.tick;
      const before = world.ants.hp[q]!;
      fedTick(world, colony);
      expect(world.ants.lastMealTick[q], `she ate on tick ${now}`).toBe(now);
      const gain = world.ants.hp[q]! - before;
      expect(gain, `tick ${now}`).toBe(now % H === 0 && before < QUEEN_HP_HOME ? 1 : 0);
      if (gain === 1) healTicks.push(now);
    }
    expect(world.ants.hp[q]).toBe(QUEEN_HP_HOME); // full, and no further
    expect(healTicks).toHaveLength(QUEEN_HP_HOME - 7);
    for (let k = 1; k < healTicks.length; k++) {
      expect(healTicks[k]! - healTicks[k - 1]!, `heal ${k}`).toBe(H);
    }
    // Nothing hit her, so the heal schedule alone governed it: 42 intervals from the first
    // heal to the last, 1681–1720 ticks from 7 HP to full depending on the starting phase.
    expect(healTicks[healTicks.length - 1]! - healTicks[0]!).toBe((QUEEN_HP_HOME - 8) * H);
    expect(world.ants.lastHitTick[q]).toBe(-1);
  }, 30_000);

  it('while the stores hold food, she heals on the first heal tick after her meals resume, on any phase', () => {
    // She is fed only on a tick she ate (QUEEN_MEAL_INTERVAL_TICKS = 1). Each round: one
    // missed meal (1 tick since her meal: no drain), then H fed ticks. The round is
    // H + 1 ticks, so the tick her meals resume on moves one phase per round and the
    // rounds cover every phase of the interval. A missed meal on a heal tick costs that
    // heal; the H fed ticks after it always hold one heal tick, and she heals on it.
    const { world, colony, q } = starvingWorldInNest();
    world.ants.hp[q] = 7;
    const phases = new Set<number>();
    for (let round = 0; round < H; round++) {
      setColonyFoodForTest(world, colony, 0);
      consumeAndHeal(world, colony);
      phases.add(world.tick % H);
      const before = world.ants.hp[q];
      for (let i = 0; i < H; i++) {
        const now = world.tick;
        const hp = world.ants.hp[q];
        setColonyFoodForTest(world, colony, QUEEN_FOOD_PER_TICK);
        consumeAndHeal(world, colony);
        expect(world.ants.hp[q] - hp, `round ${round} tick ${now}`).toBe(now % H === 0 ? 1 : 0);
      }
      expect(world.ants.hp[q], `round ${round}`).toBe(before + 1);
    }
    expect(phases.size).toBe(H);
    expect(world.ants.hp[q]).toBe(7 + H);
  });

  it('through tick(): no heal mid-fight; after the last blow, HEAL_SAFE_TICKS, then 1 HP per interval', () => {
    const { world, colony, q } = queenAtHome(QUEEN_HP_HOME);
    // Start the fight 3 ticks before a heal tick: a fighter already in contact strikes on
    // the tick it arrives, then every COMBAT_COOLDOWN_TICKS (5), so the heal tick falls 3
    // ticks after the first blow and before the second.
    while ((world.tick + 3) % H !== 0) fedTick(world, colony);
    const healTickInFight = world.tick + 3;
    /** An enemy fighter on her tile in her nest, held there. */
    const spawnFighter = (): number => {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: ENEMY_COLONY_ID,
        posX: world.ants.posX[q]!,
        posY: world.ants.posY[q]!,
        task: AntTask.Fighting,
        zone: Zone.Underground,
        speed: 0,
        lastMealTick: world.tick,
      });
      world.ants.currentGridColonyId[id] = PLAYER_COLONY_ID;
      world.colonies[ENEMY_COLONY_ID]!.workers.push(id);
      world.colonies[ENEMY_COLONY_ID]!.workerCount += 1;
      return id;
    };
    // A fighter, then a second when she kills it; the fight ends when she kills the second.
    let fighter = spawnFighter();
    let fighters = 1;
    let blows = 0;
    let onHealTick: {
      ate: boolean;
      blow: boolean;
      lastHit: number;
      safe: boolean;
      atHome: boolean;
      wounded: boolean;
    } | null = null;
    for (let i = 0; i < 200 && world.ants.alive[fighter] === 1; i++) {
      const now = world.tick;
      const before = world.ants.hp[q]!;
      fedTick(world, colony);
      // Every HP change in the fight is a blow (an away fighter deals COMBAT_DAMAGE_BASE),
      // never a heal: not +1, and not +1 hidden inside a blow.
      const blow = world.ants.lastHitTick[q] === now;
      if (blow) blows += 1;
      expect(world.ants.hp[q]! - before, `mid-fight tick ${now}`).toBe(
        blow ? -COMBAT_DAMAGE_BASE : 0,
      );
      if (now === healTickInFight) {
        onHealTick = {
          ate: world.ants.lastMealTick[q] === now,
          blow,
          lastHit: world.ants.lastHitTick[q]!,
          safe: isSafeFromHits(world.ants.lastHitTick[q]!, now),
          atHome: antOnHomeGround(world, q),
          wounded: before < QUEEN_HP_HOME,
        };
      }
      if (world.ants.alive[fighter] !== 1 && fighters < 2) {
        fighter = spawnFighter();
        fighters += 1;
      }
    }
    expect(world.ants.alive[fighter]).toBe(0); // the fight is over
    expect(world.ants.alive[q]).toBe(1);
    // On the heal tick inside the fight she was wounded, fed, at home and not struck: only
    // the safe window (a blow 3 ticks earlier) kept her from healing.
    expect(onHealTick).toEqual({
      ate: true,
      blow: false,
      lastHit: healTickInFight - 3,
      safe: false,
      atHome: true,
      wounded: true,
    });
    const lastBlow = world.ants.lastHitTick[q]!;
    expect(lastBlow).toBeGreaterThan(healTickInFight); // the fight ran past that heal tick
    const wounded = world.ants.hp[q]!;
    expect(wounded).toBe(QUEEN_HP_HOME - blows * COMBAT_DAMAGE_BASE);
    expect(wounded).toBeLessThan(QUEEN_HP_HOME - 10);
    let healed = 0;
    while (world.tick < lastBlow + HEAL_SAFE_TICKS + 3 * H) {
      const now = world.tick;
      const before = world.ants.hp[q]!;
      fedTick(world, colony);
      const expected = now - lastBlow >= HEAL_SAFE_TICKS && now % H === 0 ? 1 : 0;
      expect(world.ants.hp[q]! - before, `tick ${now}`).toBe(expected);
      healed += expected;
    }
    expect(world.ants.lastHitTick[q]).toBe(lastBlow); // nothing hit her after the fight
    expect(healed).toBe(3);
    expect(world.ants.hp[q]).toBe(wounded + 3);
  }, 30_000);
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
