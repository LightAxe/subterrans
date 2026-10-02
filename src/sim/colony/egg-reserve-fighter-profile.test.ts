// egg-reserve-fighter-profile.test.ts — #395 (V70): the egg reserve sizes each worker
// by its own hunger profile at the moment it is read (workerHungerProfile: the
// fighter profile while Fighting).
//
// Fighters and workers share every hunger value today, so in the real constants the
// two profiles cannot be told apart. This file gives the fighter a distinct meal
// (FIGHTER_MEAL_FP doubled) by partly mocking the constants module, so a reserve
// that sized every worker on the worker profile would fail here.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../constants.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../constants.js')>();
  return { ...real, FIGHTER_MEAL_FP: 2 * real.WORKER_MEAL_FP };
});

import { eggReserveFp } from './lifecycle-system.js';
import { createWorldState, SIM_VERSION_V70_EGG_RESERVE } from '../types.js';
import { createColonyRecord } from './colony-store.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask } from '../enums.js';
import { Zone } from '../terrain.js';
import { FIGHTER_HUNGER, WORKER_HUNGER } from '../hunger.js';
import {
  LARVA_MEAL_FP,
  QUEEN_EGG_RESERVE_RUNWAY_TICKS,
  QUEEN_MEAL_FP,
  WORKER_MEAL_FP,
  WORKER_MEAL_INTERVAL_TICKS,
} from '../constants.js';

describe('#395 (V70) — the reserve reads each worker’s own profile (a distinct fighter meal)', () => {
  it('a fighter counts its fighter meals, and a worker that turns fighter changes the reserve', () => {
    expect(FIGHTER_HUNGER.mealFp).toBe(2 * WORKER_MEAL_FP);
    expect(WORKER_HUNGER.mealFp).toBe(WORKER_MEAL_FP);

    const world = createWorldState(42, 64);
    world.simVersion = SIM_VERSION_V70_EGG_RESERVE;
    const queenId = world.nextEntityId++;
    initAnt(world.ants, queenId, { colonyId: 1, posX: 0, posY: 0, zone: Zone.Underground });
    const colony = createColonyRecord(1, queenId);
    world.colonies[1] = colony;
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = world.nextEntityId++;
      initAnt(world.ants, id, {
        colonyId: 1,
        posX: 0,
        posY: 0,
        task: i < 2 ? AntTask.Fighting : AntTask.Foraging,
        zone: Zone.Underground,
      });
      colony.workers.push(id);
      colony.workerCount += 1;
      ids.push(id);
    }

    // Meals of each worker kind over the runway: one now, then one every interval.
    let meals = 0;
    for (let t = 0; t < QUEEN_EGG_RESERVE_RUNWAY_TICKS; t += WORKER_MEAL_INTERVAL_TICKS) meals++;
    // The queen and the new egg's larva eat every tick.
    const queenAndEgg = (QUEEN_MEAL_FP + LARVA_MEAL_FP) * QUEEN_EGG_RESERVE_RUNWAY_TICKS;
    expect(eggReserveFp(world, colony)).toBe(
      queenAndEgg + 2 * meals * 2 * WORKER_MEAL_FP + 2 * meals * WORKER_MEAL_FP,
    );

    world.ants.task[ids[3]!] = AntTask.Fighting;
    expect(eggReserveFp(world, colony)).toBe(
      queenAndEgg + 3 * meals * 2 * WORKER_MEAL_FP + 1 * meals * WORKER_MEAL_FP,
    );
  });
});
