// egg-reserve.test.ts — #395 part 2 (V70): the queen lays an egg only while the
// colony's stored food covers the egg reserve — every meal the whole colony would eat
// over QUEEN_EGG_RESERVE_RUNWAY_TICKS, the new egg's larva included.
//
// The expected reserves here come from an independent oracle: a tick-by-tick replay
// of the meal-due rule (feedOrStarve: a meal is due once ticks since the last one
// reach the interval), not from runwayFoodFp's bisection.

import { describe, it, expect } from 'vitest';
import {
  eggReserveFp,
  tickLifecycleTransitions,
  tickQueenEggProduction,
} from './lifecycle-system.js';
import { tickDeathCleanup, tickFoodConsumption } from './colony-system.js';
import { createWorldState } from '../types.js';
import type { WorldState } from '../types.js';
import { createColonyRecord } from './colony-store.js';
import type { ColonyRecord } from './colony-store.js';
import { initAnt } from '../ant/ant-store.js';
import { despawnAnt } from '../ant-death.js';
import { AntTask, ChamberType } from '../enums.js';
import { Zone } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../food/food-api.js';
import { addChamberForTest, setColonyFoodForTest } from '../food/food-test-utils.js';
import {
  FIGHTER_HUNGER,
  LARVA_HUNGER,
  QUEEN_HUNGER,
  WORKER_HUNGER,
  runwayFoodFp,
  workerHungerProfile,
  type HungerProfile,
} from '../hunger.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  QUEEN_EGG_FOOD_THRESHOLD,
  QUEEN_EGG_INTERVAL_FLOOR_TICKS,
  QUEEN_EGG_RESERVE_RUNWAY_TICKS,
  WORKER_BASE_SPEED,
  WORKER_MEAL_FP,
  WORKER_MEAL_INTERVAL_TICKS,
} from '../constants.js';

const RUNWAY = QUEEN_EGG_RESERVE_RUNWAY_TICKS;
const MAX_TEST_ENTITIES = 2048;
const QUEEN_TILE_X = 8;
const QUEEN_TILE_Y = 4;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/** Oracle: fp a creature of `profile` eats over `runway` ticks when a meal is due at
 *  tick 0, replayed tick by tick with feedOrStarve's due rule. */
function oracleRunwayFp(profile: HungerProfile, runway: number): number {
  let fp = 0;
  let lastMeal = -profile.mealIntervalTicks;
  for (let t = 0; t < runway; t++) {
    if (t - lastMeal >= profile.mealIntervalTicks) {
      fp += profile.mealFp;
      lastMeal = t;
    }
  }
  return fp;
}

/** Oracle: the egg reserve of a colony with this many larvae, eggs, (living) workers
 *  and fighters. */
function oracleReserve(larvae: number, eggs: number, workers: number, fighters: number): number {
  return (
    oracleRunwayFp(QUEEN_HUNGER, RUNWAY) +
    (larvae + eggs + 1) * oracleRunwayFp(LARVA_HUNGER, RUNWAY) +
    workers * oracleRunwayFp(WORKER_HUNGER, RUNWAY) +
    fighters * oracleRunwayFp(FIGHTER_HUNGER, RUNWAY)
  );
}

interface Shape {
  larvae: number;
  eggs: number;
  workers: number;
  fighters: number;
  /** Dead workers still on the roster (despawned, not yet cleaned up). */
  dead?: number;
}

/**
 * The storage layouts a colony's stores can be split across. The formula tests fill
 * them through the test setters, which ignore capacity, so a 'pool' colony can hold
 * more than the 2048 fp the game lets it; the "storage capacity" describe below plays
 * the rule against real capacities.
 */
type Layout = 'pool' | 'pool+1' | 'chambers-only:3' | 'pool+2';
const LAYOUTS: readonly Layout[] = ['pool', 'pool+1', 'chambers-only:3', 'pool+2'];

function spawnAnt(
  world: WorldState,
  colonyId: number,
  task: AntTask,
  tileX: number,
  tileY: number,
): number {
  const id = world.nextEntityId++;
  initAnt(world.ants, id, {
    colonyId,
    posX: center(tileX),
    posY: center(tileY),
    task,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    zone: Zone.Underground,
    lastMealTick: world.tick,
  });
  world.ants.currentGridColonyId[id] = colonyId;
  return id;
}

/**
 * A colony that passes every gate but food: a living queen inside her Queen chamber,
 * a Nursery, the egg interval elapsed. `shape` gives its brood and workers; `layout`
 * the FoodStorage chambers its stores can be split across.
 */
function makeColony(
  world: WorldState,
  colonyId: number,
  shape: Shape,
  layout: Layout,
): ColonyRecord {
  const queenId = spawnAnt(world, colonyId, AntTask.Idle, QUEEN_TILE_X, QUEEN_TILE_Y);
  world.ants.speed[queenId] = 0;
  const colony = createColonyRecord(colonyId, queenId);
  world.colonies[colonyId] = colony;
  colony.chambers.push(
    {
      chamberId: 100 + colonyId * 10,
      chamberType: ChamberType.Queen,
      foodSlot: -1,
      posX: QUEEN_TILE_X << FP_SHIFT,
      posY: QUEEN_TILE_Y << FP_SHIFT,
      width: 2,
      height: 2,
    },
    {
      chamberId: 101 + colonyId * 10,
      chamberType: ChamberType.Nursery,
      foodSlot: -1,
      posX: 0,
      posY: 0,
      width: 4,
      height: 3,
    },
  );
  const storage = layout === 'pool' ? 0 : layout === 'pool+1' ? 1 : layout === 'pool+2' ? 2 : 3;
  for (let i = 0; i < storage; i++) {
    addChamberForTest(world, colony, {
      chamberId: 102 + colonyId * 10 + i,
      chamberType: ChamberType.FoodStorage,
      posX: (12 + 5 * i) << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      width: 4,
      height: 3,
    });
  }
  for (let i = 0; i < shape.larvae; i++) {
    colony.larvae.push(spawnAnt(world, colonyId, AntTask.Idle, 1, 1));
    colony.larvaeCount += 1;
  }
  for (let i = 0; i < shape.eggs; i++) {
    colony.eggs.push(spawnAnt(world, colonyId, AntTask.Idle, 1, 1));
    colony.eggCount += 1;
  }
  // Every non-Fighting task is the worker profile; cycle through them.
  const civilianTasks = [AntTask.Foraging, AntTask.Nursing, AntTask.Digging, AntTask.Idle];
  for (let i = 0; i < shape.workers; i++) {
    colony.workers.push(spawnAnt(world, colonyId, civilianTasks[i % 4]!, 2, 2));
    colony.workerCount += 1;
  }
  for (let i = 0; i < shape.fighters; i++) {
    colony.workers.push(spawnAnt(world, colonyId, AntTask.Fighting, 2, 2));
    colony.workerCount += 1;
  }
  for (let i = 0; i < (shape.dead ?? 0); i++) {
    const id = spawnAnt(world, colonyId, AntTask.Foraging, 2, 2);
    colony.workers.push(id);
    colony.workerCount += 1;
    despawnAnt(world, id, { cause: 'starvation' });
  }
  return colony;
}

/** Put `totalFp` in the colony's stores, split across the layout's pool and chambers. */
function setStores(world: WorldState, colony: ColonyRecord, layout: Layout, totalFp: number): void {
  if (layout === 'pool') {
    setColonyFoodForTest(world, colony, totalFp);
  } else if (layout === 'pool+1') {
    setColonyFoodForTest(world, colony, 1000, [totalFp - 1000]);
  } else if (layout === 'pool+2') {
    setColonyFoodForTest(world, colony, 500, [totalFp - 2500, 2000]);
  } else {
    // No food in the entrance pool: all of it in three FoodStorage chambers.
    setColonyFoodForTest(world, colony, 0, [totalFp - 3000, 1000, 2000]);
  }
  expect(colonyFoodTotal(world, colony)).toBe(totalFp);
}

function makeWorld(): WorldState {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  world.tick = 10_000;
  return world;
}

/** Colony sizes, from a lone queen to a large colony with a big brood. */
const SHAPES: readonly Shape[] = [
  { larvae: 0, eggs: 0, workers: 0, fighters: 0 },
  { larvae: 0, eggs: 0, workers: 3, fighters: 0 }, // the opening cohort
  { larvae: 1, eggs: 0, workers: 3, fighters: 0 },
  { larvae: 0, eggs: 4, workers: 3, fighters: 0 }, // eggs count as the larvae they become
  { larvae: 5, eggs: 4, workers: 12, fighters: 2 },
  { larvae: 11, eggs: 3, workers: 8, fighters: 0 }, // the V69 opening boom
  { larvae: 4, eggs: 2, workers: 60, fighters: 25, dead: 7 },
  { larvae: 20, eggs: 10, workers: 180, fighters: 40, dead: 3 }, // a large colony
];

describe('#395 (V70) — runwayFoodFp', () => {
  it('matches a tick-by-tick meal replay for every interval 1..13 and runway 0..120', () => {
    for (let interval = 1; interval <= 13; interval++) {
      const profile: HungerProfile = {
        mealIntervalTicks: interval,
        mealFp: 7,
        starveAfterTicks: 1,
      };
      for (let runway = 0; runway <= 120; runway++) {
        expect(runwayFoodFp(profile, runway), `interval ${interval} runway ${runway}`).toBe(
          oracleRunwayFp(profile, runway),
        );
      }
    }
  });

  it('the real profiles at the boundaries of a worker meal interval and at each candidate runway', () => {
    const I = WORKER_MEAL_INTERVAL_TICKS; // 600
    const table: ReadonlyArray<readonly [HungerProfile, number, number]> = [
      [WORKER_HUNGER, 0, 0],
      [WORKER_HUNGER, 1, WORKER_MEAL_FP],
      [WORKER_HUNGER, I - 1, WORKER_MEAL_FP],
      [WORKER_HUNGER, I, WORKER_MEAL_FP],
      [WORKER_HUNGER, I + 1, 2 * WORKER_MEAL_FP],
      [WORKER_HUNGER, 2 * I, 2 * WORKER_MEAL_FP],
      [WORKER_HUNGER, 2 * I + 1, 3 * WORKER_MEAL_FP],
      [WORKER_HUNGER, 4 * I, 4 * WORKER_MEAL_FP],
      [FIGHTER_HUNGER, 2 * I, 2 * WORKER_MEAL_FP],
      [QUEEN_HUNGER, 600, 1200],
      [QUEEN_HUNGER, 1200, 2400],
      [QUEEN_HUNGER, 2400, 4800],
      [LARVA_HUNGER, 600, 600],
      [LARVA_HUNGER, 1200, 1200],
      [LARVA_HUNGER, 2400, 2400],
    ];
    for (const [profile, runway, fp] of table) {
      expect(runwayFoodFp(profile, runway)).toBe(fp);
      expect(oracleRunwayFp(profile, runway)).toBe(fp);
    }
  });
});

describe('#395 (V70) — eggReserveFp: the whole colony for the runway', () => {
  it('is the oracle reserve across colony sizes (dead workers on the roster do not eat)', () => {
    for (const shape of SHAPES) {
      const world = makeWorld();
      const colony = makeColony(world, 1, shape, 'pool');
      expect(eggReserveFp(world, colony), JSON.stringify(shape)).toBe(
        oracleReserve(shape.larvae, shape.eggs, shape.workers, shape.fighters),
      );
    }
  });

  it('at 60 s: a lone queen needs 3600 fp; the V69 opening boom (11 larvae, 3 eggs, 8 workers) 20 912 fp', () => {
    // Pins the arithmetic of the chosen runway, so a retune of it or of a hunger
    // profile is a visible decision.
    expect(RUNWAY).toBe(1200);
    const world = makeWorld();
    expect(eggReserveFp(world, makeColony(world, 1, SHAPES[0]!, 'pool'))).toBe(2400 + 1200);
    expect(eggReserveFp(world, makeColony(world, 2, SHAPES[5]!, 'pool'))).toBe(
      2400 + 15 * 1200 + 8 * 64,
    );
  });

  it('each brood and each worker adds its own runway, wherever it stands (reads no colony id)', () => {
    const world = makeWorld();
    const base = eggReserveFp(world, makeColony(world, 1, SHAPES[4]!, 'pool'));
    const plusLarva = eggReserveFp(
      world,
      makeColony(world, 2, { ...SHAPES[4]!, larvae: 6 }, 'pool'),
    );
    const plusEgg = eggReserveFp(world, makeColony(world, 3, { ...SHAPES[4]!, eggs: 5 }, 'pool'));
    const plusWorker = eggReserveFp(
      world,
      makeColony(world, 4, { ...SHAPES[4]!, workers: 13 }, 'pool'),
    );
    const plusFighter = eggReserveFp(
      world,
      makeColony(world, 5, { ...SHAPES[4]!, fighters: 3 }, 'pool'),
    );
    const sameAtOtherId = eggReserveFp(world, makeColony(world, 0, SHAPES[4]!, 'pool+2'));
    expect(plusLarva - base).toBe(oracleRunwayFp(LARVA_HUNGER, RUNWAY));
    expect(plusEgg - base).toBe(oracleRunwayFp(LARVA_HUNGER, RUNWAY));
    expect(plusWorker - base).toBe(oracleRunwayFp(WORKER_HUNGER, RUNWAY));
    expect(plusFighter - base).toBe(oracleRunwayFp(FIGHTER_HUNGER, RUNWAY));
    expect(sameAtOtherId).toBe(base);
  });

  it('a worker that dies leaves the reserve; one that becomes a fighter is still counted', () => {
    // Fighters and workers share every hunger value today, so this cannot tell the two
    // profiles apart; egg-reserve-fighter-profile.test.ts does, with a distinct
    // fighter meal. If the two are ever split, that file is the one to keep honest.
    expect(FIGHTER_HUNGER.mealFp).toBe(WORKER_HUNGER.mealFp);
    expect(FIGHTER_HUNGER.mealIntervalTicks).toBe(WORKER_HUNGER.mealIntervalTicks);
    const world = makeWorld();
    const colony = makeColony(world, 1, { larvae: 2, eggs: 1, workers: 5, fighters: 0 }, 'pool');
    const before = eggReserveFp(world, colony);
    despawnAnt(world, colony.workers[0]!, { cause: 'starvation' });
    expect(eggReserveFp(world, colony)).toBe(before - oracleRunwayFp(WORKER_HUNGER, RUNWAY));
    world.ants.task[colony.workers[1]!] = AntTask.Fighting;
    expect(eggReserveFp(world, colony)).toBe(
      before - 2 * oracleRunwayFp(WORKER_HUNGER, RUNWAY) + oracleRunwayFp(FIGHTER_HUNGER, RUNWAY),
    );
  });
});

describe('#395 (V70) — eggReserveFp sizes every worker on one of two profiles', () => {
  it('workerHungerProfile returns WORKER_HUNGER or FIGHTER_HUNGER for every task', () => {
    // eggReserveFp sizes the two profiles once per call; a third profile would have to
    // be added there. This pins the assumption.
    const world = makeWorld();
    const colony = makeColony(world, 1, { larvae: 0, eggs: 0, workers: 1, fighters: 0 }, 'pool');
    const id = colony.workers[0]!;
    for (const task of Object.values(AntTask)) {
      world.ants.task[id] = task;
      expect(workerHungerProfile(world, id), `task ${task}`).toBe(
        task === AntTask.Fighting ? FIGHTER_HUNGER : WORKER_HUNGER,
      );
    }
  });
});

describe('#395 (V70) — the queen lays only while the stores cover the egg reserve', () => {
  it('at the reserve she lays; one fp short she does not — every colony size, every storage layout', () => {
    for (const shape of SHAPES) {
      for (const layout of LAYOUTS) {
        const need = oracleReserve(shape.larvae, shape.eggs, shape.workers, shape.fighters);
        for (const [stores, lays] of [
          [need, true],
          [need - 1, false],
          [need + 1, true],
        ] as const) {
          const world = makeWorld();
          const colony = makeColony(world, 1, shape, layout);
          setStores(world, colony, layout, stores);
          const eggsBefore = colony.eggCount;
          tickQueenEggProduction(world, colony);
          expect(colony.eggCount - eggsBefore, `${JSON.stringify(shape)} ${layout} ${stores}`).toBe(
            lays ? 1 : 0,
          );
          expect(colony.queenLastEggTick === world.tick).toBe(lays);
        }
      }
    }
  });

  it('the 3-food threshold is gone: a lone queen with 3 food (or 3599 fp) does not lay', () => {
    for (const stores of [QUEEN_EGG_FOOD_THRESHOLD, 3599]) {
      const world = makeWorld();
      const colony = makeColony(world, 1, SHAPES[0]!, 'pool');
      setStores(world, colony, 'pool', stores);
      tickQueenEggProduction(world, colony);
      expect(colony.eggCount).toBe(0);
    }
  });

  it('the reserve can never be below the old threshold, so dropping it from the interval is safe', () => {
    // The smallest reserve (a lone queen) — the V69 threshold's early-out in
    // eggIntervalForColony can only ever have fired on stores Gate 7 now refuses.
    expect(
      oracleRunwayFp(QUEEN_HUNGER, RUNWAY) + oracleRunwayFp(LARVA_HUNGER, RUNWAY),
    ).toBeGreaterThan(QUEEN_EGG_FOOD_THRESHOLD);
  });

  it('every colony is judged on its own stores and mouths (CLNY-08: any number of colonies)', () => {
    const world = makeWorld();
    const shapes = [SHAPES[1]!, SHAPES[4]!, SHAPES[6]!, SHAPES[2]!];
    const colonies = shapes.map((s, i) => makeColony(world, i, s, LAYOUTS[i]!));
    // Colonies 0 and 2 just covered; 1 and 3 one fp short.
    colonies.forEach((c, i) => {
      const s = shapes[i]!;
      const need = oracleReserve(s.larvae, s.eggs, s.workers, s.fighters);
      setStores(world, c, LAYOUTS[i]!, i % 2 === 0 ? need : need - 1);
    });
    const before = colonies.map((c) => c.eggCount);
    for (const c of colonies) tickQueenEggProduction(world, c);
    expect(colonies.map((c, i) => c.eggCount - before[i]!)).toEqual([1, 0, 1, 0]);
  });
});

describe('#395 (V70) — over time: steady in a healthy colony, paused while the stores are short', () => {
  /** Lay ticks over `ticks` ticks (egg production only; nothing hatches or eats), with
   *  `storesAt(t)` in the stores at each tick. */
  function layTicks(
    shape: Shape,
    storesAt: (t: number, colony: ColonyRecord, world: WorldState) => number,
    ticks: number,
  ): number[] {
    const world = makeWorld();
    const colony = makeColony(world, 1, shape, 'pool+1');
    const start = world.tick;
    const lays: number[] = [];
    for (let t = 0; t < ticks; t++) {
      world.tick = start + t;
      setStores(world, colony, 'pool+1', storesAt(t, colony, world));
      const before = colony.eggCount;
      tickQueenEggProduction(world, colony);
      if (colony.eggCount > before) lays.push(t);
    }
    return lays;
  }

  it('with the stores always above the reserve she lays on the plain interval cadence', () => {
    // Stores comfortably above the reserve at every tick (it grows with each egg).
    const rich = (_t: number, c: ColonyRecord, w: WorldState): number => eggReserveFp(w, c) + 5000;
    const lays = layTicks(SHAPES[4]!, rich, 3000);
    expect(lays.length).toBeGreaterThanOrEqual(10);
    // Pinned: the cadence the V69 rule (no reserve) gave on the same stores, every
    // floor interval from tick 0 (#408 kept this as an absolute list when it removed
    // the V69 side of the comparison).
    expect(lays).toEqual(Array.from({ length: 20 }, (_, i) => i * QUEEN_EGG_INTERVAL_FLOOR_TICKS));
  });

  it('a raid that empties the stores pauses laying until they cover the reserve again', () => {
    const raided = (t: number, c: ColonyRecord, w: WorldState): number =>
      t >= 1000 && t < 2000 ? 1200 : eggReserveFp(w, c) + 2000;
    const lays = layTicks(SHAPES[4]!, raided, 3000);
    expect(lays.some((t) => t < 1000)).toBe(true);
    expect(lays.some((t) => t >= 1000 && t < 2000)).toBe(false);
    // The first tick back above the reserve: the interval has long elapsed.
    expect(lays).toContain(2000);
  });

  it('just short of the reserve she never lays, however long it lasts (a famine)', () => {
    const short = (_t: number, c: ColonyRecord, w: WorldState): number => eggReserveFp(w, c) - 1;
    expect(layTicks(SHAPES[6]!, short, 3000)).toEqual([]);
  });

  it('a large colony needs proportionally more: 300 workers and fighters need 300 worker runways', () => {
    const world = makeWorld();
    const big = makeColony(world, 1, { larvae: 0, eggs: 0, workers: 250, fighters: 50 }, 'pool');
    expect(eggReserveFp(world, big)).toBe(
      oracleRunwayFp(QUEEN_HUNGER, RUNWAY) +
        oracleRunwayFp(LARVA_HUNGER, RUNWAY) +
        300 * oracleRunwayFp(WORKER_HUNGER, RUNWAY),
    );
  });
});

describe('#395 (V70) — storage capacity caps what the reserve allows', () => {
  /** Every store of the colony at its real cap: the entrance pool and each chamber full. */
  function fillToCapacity(world: WorldState, colony: ColonyRecord): void {
    const stocks: number[] = [];
    for (const ch of colony.chambers) {
      if (ch.chamberType === ChamberType.FoodStorage) stocks.push(FOOD_CHAMBER_CAPACITY);
    }
    setColonyFoodForTest(world, colony, BASE_FOOD_STORAGE_CAPACITY, stocks);
    expect(colonyFoodTotal(world, colony)).toBe(colonyFoodCapacity(colony));
  }

  it('with no FoodStorage chamber she never lays, even with the entrance pool full', () => {
    for (const workers of [0, 3, 10]) {
      const world = makeWorld();
      const colony = makeColony(world, 1, { larvae: 0, eggs: 0, workers, fighters: 0 }, 'pool');
      fillToCapacity(world, colony);
      expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY);
      tickQueenEggProduction(world, colony);
      expect(colony.eggCount, `${workers} workers`).toBe(0);
    }
  });

  it('with the larder full, the number of chambers sets the brood ceiling', () => {
    const layouts: ReadonlyArray<readonly [Layout, number]> = [
      ['pool+1', 1],
      ['pool+2', 2],
      ['chambers-only:3', 3],
    ];
    for (const [layout, chambers] of layouts) {
      const capacity = BASE_FOOD_STORAGE_CAPACITY + chambers * FOOD_CHAMBER_CAPACITY;
      for (const workers of [3, 25, 60, 140]) {
        // The oracle ceiling: the most brood she can already have and still lay
        // (-1: she never lays, at any brood).
        let ceiling = -1;
        while (oracleReserve(ceiling + 1, 0, workers, 0) <= capacity) ceiling++;
        for (const brood of [ceiling, ceiling + 1]) {
          if (brood < 0) continue;
          const world = makeWorld();
          const shape = { larvae: brood, eggs: 0, workers, fighters: 0 };
          const colony = makeColony(world, 1, shape, layout);
          fillToCapacity(world, colony);
          tickQueenEggProduction(world, colony);
          expect(colony.eggCount, `${chambers} chambers, ${workers} workers, ${brood} brood`).toBe(
            brood <= ceiling ? 1 : 0,
          );
        }
      }
    }
  });

  it('at 60 s: one chamber and 3 workers lays up to 2 brood; two chambers stop for good past 135 workers', () => {
    const one = BASE_FOOD_STORAGE_CAPACITY + FOOD_CHAMBER_CAPACITY;
    const two = BASE_FOOD_STORAGE_CAPACITY + 2 * FOOD_CHAMBER_CAPACITY;
    expect(oracleReserve(2, 0, 3, 0)).toBeLessThanOrEqual(one);
    expect(oracleReserve(3, 0, 3, 0)).toBeGreaterThan(one);
    expect(oracleReserve(0, 0, 135, 0)).toBeLessThanOrEqual(two);
    expect(oracleReserve(0, 0, 136, 0)).toBeGreaterThan(two);
    // The smallest reserve of all (a lone queen) is above the entrance pool's cap.
    expect(oracleReserve(0, 0, 0, 0)).toBeGreaterThan(BASE_FOOD_STORAGE_CAPACITY);
  });
});

describe('#395 (V70) — the reserve feeds the colony for the runway (real consumption)', () => {
  it('laid at exactly the reserve, with no food coming in nobody starves or misses a meal for the runway', () => {
    // Two worker timings: due on the tick after the lay (meals at +1 and +601), and fed
    // on the lay tick (meals at +600 and +1200, the last when the stores are lowest).
    // Both fit the meals the reserve counts; the second is the tighter for the at-home rule
    // that a worker's meal must leave QUEEN_MEAL_RESERVE_FP in the stores.
    const timings = [WORKER_MEAL_INTERVAL_TICKS - 1, 0];
    for (const shape of [SHAPES[1]!, SHAPES[4]!, SHAPES[5]!, SHAPES[6]!])
      for (const lastMealAgo of timings) {
        const world = makeWorld();
        const colony = makeColony(world, 1, shape, 'chambers-only:3');
        const ants = world.ants;
        // Most meals in the runway for every worker. Some eggs hatch, and some larvae
        // mature, during the runway (lifecycle transitions run below).
        for (const id of colony.workers) ants.lastMealTick[id] = world.tick - lastMealAgo;
        colony.eggs.forEach((id, i) => {
          ants.age[id] = i % 2 === 0 ? 600 : 0;
        });
        colony.larvae.forEach((id, i) => {
          ants.age[id] = i % 3 === 0 ? 1000 : 0;
        });
        const reserve = eggReserveFp(world, colony);
        setStores(world, colony, 'chambers-only:3', reserve);
        tickQueenEggProduction(world, colony);
        expect(colony.eggCount, JSON.stringify(shape)).toBe(shape.eggs + 1);
        // The real tick order: the lay tick's consumption has already run (step 3), its
        // lifecycle step (7) runs right after the lay (6). The runway is the next RUNWAY
        // ticks.
        tickLifecycleTransitions(world, colony);
        const queen = colony.queenEntityId;
        const living = [queen, ...colony.eggs, ...colony.larvae, ...colony.workers].filter(
          (id) => ants.alive[id] === 1,
        );
        const start = world.tick;
        let workerMealsMissed = 0;
        for (let t = 1; t <= RUNWAY; t++) {
          world.tick = start + t;
          tickFoodConsumption(world, colony);
          expect(ants.lastMealTick[queen], `queen fed at tick ${t}`).toBe(world.tick);
          for (const id of colony.larvae) {
            if (ants.alive[id] === 1)
              expect(ants.lastMealTick[id], `larva fed at tick ${t}`).toBe(world.tick);
          }
          for (const id of colony.workers) {
            if (
              ants.alive[id] === 1 &&
              world.tick - ants.lastMealTick[id]! >= WORKER_MEAL_INTERVAL_TICKS
            ) {
              workerMealsMissed++;
            }
          }
          tickDeathCleanup(world, colony);
          tickLifecycleTransitions(world, colony);
        }
        for (const id of living)
          expect(ants.alive[id], `ant ${id} ${JSON.stringify(shape)}`).toBe(1);
        expect(workerMealsMissed, JSON.stringify(shape)).toBe(0);
      }
  });
});
