// worker-hunger-replay.test.ts — #290 PR 4 (V51): deterministic replay with worker
// meals and a D11 hungry walk home.
//
// A seeded match with a recorded command log (a fight-heavy ratio, then a rally
// 40 tiles out) runs long enough for workers to eat at home, for the rallied
// fighters to turn hungry, walk home, eat and go back. The same seed + log must
// reproduce the run's per-checkpoint hashWorldState exactly, and so must a run
// saved and reloaded in the middle of the walk home — which proves the walk-home
// verdict lives in state the save carries (the hunger clock), not in the
// same-tick scratch that marks it.

import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import type { WorldState } from '../sim/types.js';
import { fighterWalksHomeToEat } from '../sim/ant/ant-system.js';
import { AntTask } from '../sim/enums.js';
import { isSurfaceTileInComponent } from '../sim/surface-features.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { hashWorldState } from './world-hash.js';
import { serializeWorldState, deserializeWorldState } from './save.js';

const SEED = 7;
const TICKS = 3200;
const CHECK_EVERY = 100;
const SAVE_AT = 2450; // mid-walk-home (the fighters turn hungry around tick 2400)

function rallyTile(world: WorldState): { x: number; y: number } {
  const door = world.colonies[PLAYER_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
  for (let dy = 0; dy <= 40; dy++) {
    const x = door.surfaceTileX + (40 - dy);
    for (const y of [door.surfaceTileY + dy, door.surfaceTileY - dy]) {
      if (isSurfaceTileInComponent(world, x, y)) return { x, y };
    }
  }
  throw new Error('no rally tile');
}

function makeWorld(): WorldState {
  const world = createScenario(SEED, 'Normal');
  world.spider = null;
  world.aiState = [];
  return world;
}

function commandLog(world: WorldState): SimCommand[][] {
  const pc = PLAYER_COLONY_ID as ColonyId;
  const r = rallyTile(world);
  const log: SimCommand[][] = [];
  log[1] = [
    { type: 'SetBehaviorRatio', colonyId: pc, ratio: { forage: 1, fight: 1 }, issuedAtTick: 1 },
  ];
  log[10] = [{ type: 'SetRallyPoint', colonyId: pc, tileX: r.x, tileY: r.y, issuedAtTick: 10 }];
  return log;
}

interface Run {
  hashes: string[];
  workerMeals: number;
  walkHomeTicks: number;
  /** Fighters marked walking home to eat on the tick just before SAVE_AT. */
  walkingAtSave: number;
}

function run(saveAt = -1): Run {
  let world = makeWorld();
  const log = commandLog(world);
  const hashes: string[] = [];
  let workerMeals = 0;
  let walkHomeTicks = 0;
  let walkingAtSave = 0;
  const lastMeal = new Map<number, number>();
  for (let t = 0; t < TICKS; t++) {
    if (world.tick === saveAt) {
      world = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
    }
    tick(world, log[world.tick] ?? []);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (const id of colony.workers) {
      if (world.ants.alive[id] !== 1) continue;
      const m = world.ants.lastMealTick[id]!;
      const prev = lastMeal.get(id);
      if (prev !== undefined && m !== prev) workerMeals += 1;
      lastMeal.set(id, m);
      if (world.ants.task[id] === AntTask.Fighting && fighterWalksHomeToEat(world, id)) {
        walkHomeTicks += 1;
        if (world.tick === SAVE_AT) walkingAtSave += 1;
      }
    }
    if (world.tick % CHECK_EVERY === 0) hashes.push(hashWorldState(world));
  }
  return { hashes, workerMeals, walkHomeTicks, walkingAtSave };
}

describe('V51 worker meals + D11 walk home replay deterministically (#290 PR 4)', () => {
  const a = run();

  it('the run exercises both: workers eat, and a rallied fighter walks home hungry', () => {
    expect(a.workerMeals).toBeGreaterThan(0);
    expect(a.walkHomeTicks).toBeGreaterThan(0);
    expect(a.walkingAtSave).toBeGreaterThan(0); // the save below lands mid-walk
  });

  it('same seed + same command log → identical hashes at every checkpoint', () => {
    expect(run().hashes).toEqual(a.hashes);
  });

  it('a save/load in the middle of the walk home continues identically', () => {
    expect(run(SAVE_AT).hashes).toEqual(a.hashes);
  });
});
