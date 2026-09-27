// worker-hunger.test.ts — #288 / #290 PR 4 (V51): workers and fighters eat.
//
// Step 3 (tickFoodConsumption) feeds the queen, then larvae, then — from V51 —
// every live worker in `colony.workers` order: a meal from the colony stores AT
// HOME (own nest, or within HOME_EAT_RADIUS_TILES of an own open entrance) unless
// it would leave less than QUEEN_MEAL_RESERVE_FP; a meal from its own load when
// away and carrying; nothing when away and empty-handed. A missed meal at or past
// the kind's starve-after (read from the task at the check) is fatal.
//
// Hand-built worlds: these pin the consumption rule itself. The walk-home half
// of D11 is driven through tick() in ../fighter-hunger.test.ts.

import { describe, it, expect } from 'vitest';
import { tickFoodConsumption } from './colony-system.js';
import { createColonyRecord, type ColonyRecord } from './colony-store.js';
import { createWorldState, SIM_VERSION_V50_LOCATED_FOOD, type WorldState } from '../types.js';
import { colonyFoodTotal } from '../food/food-api.js';
import { setMealsUntilStarvationForTest, setPoolFoodForTest } from '../food/food-test-utils.js';
import {
  antIsAtHome,
  FIGHTER_HUNGER,
  hungerState,
  LARVA_HUNGER,
  QUEEN_HUNGER,
  ticksSinceMeal,
  WORKER_HUNGER,
  workerHungerProfile,
} from '../hunger.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask, ForagingSubState } from '../enums.js';
import { Zone } from '../terrain.js';
import { FP_SHIFT } from '../fixed.js';
import {
  FIGHT_AGGRO_RADIUS,
  FIGHTER_MEAL_FP,
  FIGHTER_STARVE_AFTER_TICKS,
  FIGHTER_WALK_HOME_BUDGET_TICKS,
  FIGHTER_WALK_HOME_HUNGER_TICKS,
  HOME_EAT_RADIUS_TILES,
  QUEEN_FOOD_PER_TICK,
  QUEEN_MEAL_RESERVE_FP,
  STARVATION_GRACE_TICKS,
  WORKER_MEAL_FP,
  WORKER_MEAL_INTERVAL_TICKS,
  WORKER_STARVE_AFTER_TICKS,
} from '../constants.js';

const COLONY_ID = 1;
const DOOR_X = 20;
const DOOR_Y = 20;

/** A world at tick 5000 with a fed queen at the door and one open entrance. */
function setup(poolFp = 2000): { world: WorldState; colony: ColonyRecord } {
  const world = createWorldState(42, 64);
  world.tick = 5000;
  const queenId = world.nextEntityId++;
  initAnt(world.ants, queenId, {
    colonyId: COLONY_ID,
    posX: DOOR_X << FP_SHIFT,
    posY: 0,
    task: AntTask.Idle,
    zone: Zone.Underground,
  });
  world.ants.currentGridColonyId[queenId] = COLONY_ID;
  const colony = createColonyRecord(COLONY_ID, queenId);
  colony.entrances = [{ entranceId: 0, surfaceTileX: DOOR_X, surfaceTileY: DOOR_Y, isOpen: true }];
  colony.rallyPoint = null;
  setPoolFoodForTest(world, colony, poolFp);
  world.colonies[COLONY_ID] = colony;
  setMealsUntilStarvationForTest(world, queenId, QUEEN_HUNGER, STARVATION_GRACE_TICKS);
  return { world, colony };
}

type Where =
  | { kind: 'nest' } // underground, own grid
  | { kind: 'surface'; x: number; y: number }
  | { kind: 'foreignNest' }; // underground in another colony's grid

/** Add a live worker at `where`, `sinceMeal` ticks after its last meal (as step 3 of this tick reads it). */
function addWorker(
  world: WorldState,
  colony: ColonyRecord,
  where: Where,
  sinceMeal: number,
  task: number = AntTask.Idle,
): number {
  const id = world.nextEntityId++;
  const onSurface = where.kind === 'surface';
  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX: (onSurface ? where.x : DOOR_X) << FP_SHIFT,
    posY: (onSurface ? where.y : 3) << FP_SHIFT,
    task,
    zone: onSurface ? Zone.Surface : Zone.Underground,
  });
  world.ants.currentGridColonyId[id] = where.kind === 'foreignNest' ? COLONY_ID + 1 : COLONY_ID;
  world.ants.lastMealTick[id] = world.tick - sinceMeal;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

/** Step 3 of the current tick, then advance the tick (as tick() does). */
function consume(world: WorldState, colony: ColonyRecord): void {
  tickFoodConsumption(world, colony);
  world.tick += 1;
}

describe('V51 worker/fighter profiles and constants', () => {
  it('the profiles carry the tuned knobs; a fighter is read from its task at the check', () => {
    expect(WORKER_HUNGER).toEqual({
      mealIntervalTicks: WORKER_MEAL_INTERVAL_TICKS,
      mealFp: WORKER_MEAL_FP,
      starveAfterTicks: WORKER_STARVE_AFTER_TICKS,
    });
    expect(FIGHTER_HUNGER.mealFp).toBe(FIGHTER_MEAL_FP);
    expect(FIGHTER_HUNGER.starveAfterTicks).toBe(FIGHTER_STARVE_AFTER_TICKS);
    const { world, colony } = setup();
    const id = addWorker(world, colony, { kind: 'nest' }, 0);
    expect(workerHungerProfile(world, id)).toBe(WORKER_HUNGER);
    world.ants.task[id] = AntTask.Fighting;
    expect(workerHungerProfile(world, id)).toBe(FIGHTER_HUNGER);
  });

  it('a fighter turns for home before it could starve; the reserve is one grace window of queen meals', () => {
    expect(FIGHTER_WALK_HOME_HUNGER_TICKS).toBe(
      FIGHTER_STARVE_AFTER_TICKS - FIGHTER_WALK_HOME_BUDGET_TICKS,
    );
    expect(FIGHTER_WALK_HOME_HUNGER_TICKS).toBeGreaterThanOrEqual(FIGHTER_HUNGER.mealIntervalTicks);
    expect(QUEEN_MEAL_RESERVE_FP).toBe(STARVATION_GRACE_TICKS * QUEEN_FOOD_PER_TICK);
    // Home is a sentry's guard area — FIGHT_AGGRO_RADIUS past its door area, which
    // is itself FIGHT_AGGRO_RADIUS (ant-combat-targeting.ts) — so a sentry at its
    // post, or chasing inside its guard area, eats there. Retune them together.
    expect(HOME_EAT_RADIUS_TILES).toBe(2 * FIGHT_AGGRO_RADIUS);
    for (const p of [WORKER_HUNGER, FIGHTER_HUNGER]) {
      expect(p.mealIntervalTicks).toBeLessThan(p.starveAfterTicks);
      expect(hungerState(p.mealIntervalTicks, p)).toBe('hungry');
    }
  });
});

describe('antIsAtHome (V51)', () => {
  it('own nest: home; a foreign nest: away', () => {
    const { world, colony } = setup();
    expect(antIsAtHome(world, addWorker(world, colony, { kind: 'nest' }, 0))).toBe(true);
    expect(antIsAtHome(world, addWorker(world, colony, { kind: 'foreignNest' }, 0))).toBe(false);
  });

  it('surface: home within HOME_EAT_RADIUS_TILES (Manhattan) of an OPEN own entrance only', () => {
    const { world, colony } = setup();
    const edge = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 5, y: DOOR_Y + HOME_EAT_RADIUS_TILES - 5 },
      0,
    );
    const past = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 5, y: DOOR_Y + HOME_EAT_RADIUS_TILES - 4 },
      0,
    );
    expect(antIsAtHome(world, edge)).toBe(true);
    expect(antIsAtHome(world, past)).toBe(false);
    colony.entrances[0]!.isOpen = false;
    expect(antIsAtHome(world, edge)).toBe(false);
  });
});

describe('tickFoodConsumption — worker meals (V51)', () => {
  it('a worker at home eats one meal from the stores once its meal is due', () => {
    const { world, colony } = setup(2000);
    const early = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS - 1);
    const due = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.lastMealTick[due]).toBe(t);
    expect(world.ants.lastMealTick[early]).toBe(t - (WORKER_MEAL_INTERVAL_TICKS - 1));
    // queen 2 fp + one worker meal
    expect(colonyFoodTotal(world, colony)).toBe(2000 - QUEEN_FOOD_PER_TICK - WORKER_MEAL_FP);
  });

  it('a worker on the surface near an open entrance eats; one away and empty-handed does not', () => {
    const { world, colony } = setup(2000);
    const near = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 3, y: DOOR_Y },
      WORKER_MEAL_INTERVAL_TICKS,
    );
    const far = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 40, y: DOOR_Y },
      WORKER_MEAL_INTERVAL_TICKS,
    );
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.lastMealTick[near]).toBe(t);
    expect(world.ants.lastMealTick[far]).toBe(t - WORKER_MEAL_INTERVAL_TICKS);
    expect(world.ants.alive[far]).toBe(1);
    expect(colonyFoodTotal(world, colony)).toBe(2000 - QUEEN_FOOD_PER_TICK - WORKER_MEAL_FP);
  });

  it('away and carrying, it eats from its load (the stores are untouched)', () => {
    const { world, colony } = setup(2000);
    const id = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 40, y: DOOR_Y },
      WORKER_MEAL_INTERVAL_TICKS,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = 512;
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.lastMealTick[id]).toBe(t);
    expect(world.ants.foodCarrying[id]).toBe(512 - WORKER_MEAL_FP);
    expect(world.ants.task[id]).toBe(AntTask.Foraging);
    expect(colonyFoodTotal(world, colony)).toBe(2000 - QUEEN_FOOD_PER_TICK);
  });

  it('a load of exactly one meal is its last bite: empty, and Idle', () => {
    const { world, colony } = setup(2000);
    const id = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 40, y: DOOR_Y },
      WORKER_MEAL_INTERVAL_TICKS,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = WORKER_MEAL_FP;
    consume(world, colony);
    expect(world.ants.foodCarrying[id]).toBe(0);
    expect(world.ants.task[id]).toBe(AntTask.Idle);
  });

  it('a carrier that eats its last bite away from home goes Idle, like a full deposit', () => {
    const { world, colony } = setup(2000);
    const id = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 40, y: DOOR_Y },
      WORKER_MEAL_INTERVAL_TICKS,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = WORKER_MEAL_FP - 1;
    world.ants.searchHeadingX[id] = 1;
    world.ants.searchHeadingTicks[id] = 9;
    world.ants.searchPrevTileX[id] = 7;
    world.ants.searchPauseTicks[id] = 3;
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.lastMealTick[id]).toBe(t);
    expect(world.ants.foodCarrying[id]).toBe(0);
    expect(world.ants.task[id]).toBe(AntTask.Idle);
    expect(world.ants.subTask[id]).toBe(0);
    // The full-deposit checkpoint's clean excursion state (resetCarrierToIdle).
    expect(world.ants.searchHeadingX[id]).toBe(0);
    expect(world.ants.searchHeadingTicks[id]).toBe(0);
    expect(world.ants.searchPrevTileX[id]).toBe(-1);
    expect(world.ants.searchPauseTicks[id]).toBe(0);
  });

  it('at home with the stores below the reserve, a carrier eats from its load instead of starving', () => {
    const { world, colony } = setup(QUEEN_MEAL_RESERVE_FP);
    const id = addWorker(
      world,
      colony,
      { kind: 'nest' },
      WORKER_STARVE_AFTER_TICKS,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = 512;
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.alive[id]).toBe(1);
    expect(world.ants.lastMealTick[id]).toBe(t);
    expect(world.ants.foodCarrying[id]).toBe(512 - WORKER_MEAL_FP);
    expect(colonyFoodTotal(world, colony)).toBe(QUEEN_MEAL_RESERVE_FP - QUEEN_FOOD_PER_TICK);
  });

  it('at home it eats from the stores, not its load', () => {
    const { world, colony } = setup(2000);
    const id = addWorker(
      world,
      colony,
      { kind: 'nest' },
      WORKER_MEAL_INTERVAL_TICKS,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = 512;
    consume(world, colony);
    expect(world.ants.foodCarrying[id]).toBe(512);
    expect(colonyFoodTotal(world, colony)).toBe(2000 - QUEEN_FOOD_PER_TICK - WORKER_MEAL_FP);
  });

  it('skips a meal that would leave the stores below the queen reserve; eats at exactly the reserve', () => {
    // After the queen's 2 fp, exactly reserve + meal − 1 remain: skipped.
    const skip = setup(QUEEN_MEAL_RESERVE_FP + WORKER_MEAL_FP - 1 + QUEEN_FOOD_PER_TICK);
    const a = addWorker(skip.world, skip.colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    consume(skip.world, skip.colony);
    expect(ticksSinceMeal(skip.world, a)).toBe(WORKER_MEAL_INTERVAL_TICKS + 1);
    expect(colonyFoodTotal(skip.world, skip.colony)).toBe(
      QUEEN_MEAL_RESERVE_FP + WORKER_MEAL_FP - 1,
    );
    // One more fp: the meal leaves exactly the reserve, so it is eaten.
    const eat = setup(QUEEN_MEAL_RESERVE_FP + WORKER_MEAL_FP + QUEEN_FOOD_PER_TICK);
    const b = addWorker(eat.world, eat.colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    const t = eat.world.tick;
    consume(eat.world, eat.colony);
    expect(eat.world.ants.lastMealTick[b]).toBe(t);
    expect(colonyFoodTotal(eat.world, eat.colony)).toBe(QUEEN_MEAL_RESERVE_FP);
  });

  it('a worker dies of starvation exactly at WORKER_STARVE_AFTER_TICKS, not a tick before', () => {
    const { world, colony } = setup(0);
    colony.workers.length = 0;
    const id = addWorker(world, colony, { kind: 'nest' }, WORKER_STARVE_AFTER_TICKS - 1);
    // Keep the queen alive: she eats from a store the worker cannot touch (below reserve).
    setPoolFoodForTest(world, colony, QUEEN_MEAL_RESERVE_FP);
    consume(world, colony);
    expect(world.ants.alive[id]).toBe(1);
    consume(world, colony);
    expect(world.ants.alive[id]).toBe(0);
  });

  it('a fighter dies at FIGHTER_STARVE_AFTER_TICKS, away and empty-handed', () => {
    const { world, colony } = setup(2000);
    const id = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 40, y: DOOR_Y },
      FIGHTER_STARVE_AFTER_TICKS - 1,
      AntTask.Fighting,
    );
    consume(world, colony);
    expect(world.ants.alive[id]).toBe(1);
    consume(world, colony);
    expect(world.ants.alive[id]).toBe(0);
  });

  it('the kind is read at the check: a worker promoted to Fighting keeps its clock', () => {
    const { world, colony } = setup(2000);
    const id = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS - 1);
    const last = world.ants.lastMealTick[id]!;
    world.ants.task[id] = AntTask.Fighting; // promotion does not reset the clock
    consume(world, colony);
    expect(world.ants.lastMealTick[id]).toBe(last);
    const t = world.tick;
    consume(world, colony); // due now, under FIGHTER_HUNGER
    expect(world.ants.lastMealTick[id]).toBe(t);
    expect(workerHungerProfile(world, id)).toBe(FIGHTER_HUNGER);
  });

  it('famine priority: the queen eats, then larvae, then workers', () => {
    // Enough for the queen and one larva, not for a worker meal above the reserve.
    const { world, colony } = setup(QUEEN_MEAL_RESERVE_FP + WORKER_MEAL_FP);
    const larva = world.nextEntityId++;
    initAnt(world.ants, larva, { colonyId: COLONY_ID, posX: 0, posY: 0, task: AntTask.Idle });
    setMealsUntilStarvationForTest(world, larva, LARVA_HUNGER, STARVATION_GRACE_TICKS);
    colony.larvae.push(larva);
    colony.larvaeCount += 1;
    const w = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.lastMealTick[colony.queenEntityId]).toBe(t);
    expect(world.ants.lastMealTick[larva]).toBe(t);
    expect(ticksSinceMeal(world, w)).toBe(WORKER_MEAL_INTERVAL_TICKS + 1);
    expect(colonyFoodTotal(world, colony)).toBe(QUEEN_MEAL_RESERVE_FP + WORKER_MEAL_FP - 3);
  });

  it('workers eat in colony.workers order when only one meal fits above the reserve', () => {
    const { world, colony } = setup(QUEEN_MEAL_RESERVE_FP + WORKER_MEAL_FP + QUEEN_FOOD_PER_TICK);
    const second = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    const first = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    colony.workers.reverse(); // `first` is first in the list, though allocated later
    const t = world.tick;
    consume(world, colony);
    expect(world.ants.lastMealTick[first]).toBe(t);
    expect(world.ants.lastMealTick[second]).toBe(t - WORKER_MEAL_INTERVAL_TICKS);
  });

  it('a scripted famine: workers go hungry but survive, and eat again when food returns', () => {
    const { world, colony } = setup(QUEEN_MEAL_RESERVE_FP);
    const ids = [0, 1, 2, 3].map((k) =>
      addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS + k),
    );
    // Famine: the stores sit at the reserve (topped up so the queen keeps eating),
    // so no worker meal fits above it for a long stretch.
    const famineTicks = WORKER_STARVE_AFTER_TICKS - WORKER_MEAL_INTERVAL_TICKS - 10;
    for (let i = 0; i < famineTicks; i++) {
      setPoolFoodForTest(world, colony, QUEEN_MEAL_RESERVE_FP);
      consume(world, colony);
    }
    for (const id of ids) {
      expect(world.ants.alive[id]).toBe(1);
      expect(hungerState(ticksSinceMeal(world, id), WORKER_HUNGER)).toBe('hungry');
    }
    // Food returns: everyone eats on the next tick, and nobody starves after.
    setPoolFoodForTest(world, colony, 2000);
    const t = world.tick;
    consume(world, colony);
    for (const id of ids) expect(world.ants.lastMealTick[id]).toBe(t);
    for (let i = 0; i < WORKER_STARVE_AFTER_TICKS; i++) {
      if (colonyFoodTotal(world, colony) < QUEEN_MEAL_RESERVE_FP + 200) {
        setPoolFoodForTest(world, colony, 2000);
      }
      consume(world, colony);
    }
    for (const id of ids) expect(world.ants.alive[id]).toBe(1);
  });

  it('a V50 world never runs the worker loop: no meals, no starvation', () => {
    const { world, colony } = setup(2000);
    world.simVersion = SIM_VERSION_V50_LOCATED_FOOD;
    const starving = addWorker(
      world,
      colony,
      { kind: 'surface', x: DOOR_X + 40, y: DOOR_Y },
      WORKER_STARVE_AFTER_TICKS + 100,
    );
    const due = addWorker(world, colony, { kind: 'nest' }, WORKER_MEAL_INTERVAL_TICKS);
    const lastDue = world.ants.lastMealTick[due]!;
    consume(world, colony);
    expect(world.ants.alive[starving]).toBe(1);
    expect(world.ants.lastMealTick[due]).toBe(lastDue);
    expect(colonyFoodTotal(world, colony)).toBe(2000 - QUEEN_FOOD_PER_TICK);
  });
});
