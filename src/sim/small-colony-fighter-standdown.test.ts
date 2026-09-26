// V40 (#299) — small-colony fighter stand-down must never release an invader
// inside a FOREIGN underground grid: only Fighters may be there (REQ-C3c), and a
// forager routes by its HOME entrance field at those coordinates, which strands
// it. Found in review of #313 on a createScenario(42) reproduction.
import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { allocateEntityId, type WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone, UndergroundTileState, ugGet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  ENEMY_START_X,
  WORKER_BASE_SPEED,
} from './constants.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';

/** Player colony collapsed to two Fighting invaders one tile inside the enemy shaft. */
function build(): { world: WorldState; ids: number[] } {
  const world = createScenario(42);
  const player = world.colonies[PLAYER_COLONY_ID]!;
  for (const id of player.workers) world.ants.alive[id] = 0; // starting cohort dies; swept at step 5
  const enemyGrid = world.undergroundGrids[ENEMY_COLONY_ID]!;
  expect(ugGet(enemyGrid, ENEMY_START_X, 1)).toBe(UndergroundTileState.Open);
  const ids: number[] = [];
  for (let i = 0; i < 2; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: (ENEMY_START_X << FP_SHIFT) + (FP_ONE >> 1),
      posY: (1 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: FightingSubState.MovingToRally,
      speed: WORKER_BASE_SPEED,
      zone: Zone.Underground,
    });
    world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
    player.workers.push(id);
    player.workerCount += 1;
    ids.push(id);
  }
  player.rallyPoint = null; // recalled
  player.targetRatio.forage = 10;
  player.targetRatio.fight = 0; // the ratio asks for no fighters at all
  setPoolFoodForTest(world, player, 10000);
  return { world, ids };
}

function run(world: WorldState, n: number): void {
  for (let t = 0; t < n; t++) tick(world, world.commandQueue.splice(0));
}

function isHome(world: WorldState, id: number): boolean {
  return (
    world.ants.zone[id] === Zone.Surface ||
    world.ants.currentGridColonyId[id] === world.ants.colonyId[id]
  );
}

describe('V40 (#299) fighter stand-down never strands an invader in a foreign nest', () => {
  it('V40: the invaders stay Fighting while foreign, walk home, and only then stand down into foraging', () => {
    const { world, ids } = build();
    run(world, 1);
    // Below the floor with fight=0, but inside the enemy grid: NOT released.
    for (const id of ids) {
      expect(world.ants.alive[id]).toBe(1);
      expect(world.ants.task[id]).toBe(AntTask.Fighting);
    }
    run(world, 1499);
    for (const id of ids) {
      expect(world.ants.alive[id]).toBe(1);
      expect(isHome(world, id)).toBe(true);
      expect(world.ants.task[id]).toBe(AntTask.Foraging);
    }
  });
});
