// raid-test-utils.ts — #290 PR 5 (V52) test fixture: a two-nest world set up for a
// raid. Test-only (imported by *.test.ts; not part of any barrel).
//
// createScenario(7) gives two colonies with a 2-deep shaft each. This carves, in
// each nest, a shaft down to row 6 and a tunnel along row 6 to a FoodStorage
// chamber (4 × 3) and a Queen chamber (5 × 3), and moves each queen into her
// chamber, so:
//   - enemy (ENEMY_COLONY_ID, door x = 104): FoodStorage at x 86..89, Queen at
//     x 116..120 — the queen is 29 path tiles from the larder, 14 from the shaft;
//   - player (PLAYER_COLONY_ID, door x = 24): FoodStorage at x 35..38, Queen at
//     x 10..14.
// The spider and the AI are switched off and both colonies' three starting workers
// removed, so nothing hostile walks into a raider's reach unless a test puts it
// there, and no forager puts food in a larder. Brood still comes (the queens
// lay), but brood is never a hostile.

import { createScenario } from './scenario.js';
import { allocateEntityId, type WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { despawnAnt } from './ant-death.js';
import { AntTask, ChamberType, FightingSubState } from './enums.js';
import { Zone, ugSet, UndergroundTileState, type UndergroundGrid } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID, WORKER_BASE_SPEED } from './constants.js';
import type { ChamberRecord, ColonyRecord } from './colony/colony-store.js';
import { addChamberForTest, setPoolFoodForTest } from './food/food-test-utils.js';

export interface RaidWorld {
  world: WorldState;
  player: ColonyRecord;
  enemy: ColonyRecord;
  playerDoor: { x: number; y: number };
  enemyDoor: { x: number; y: number };
  /** The enemy's FoodStorage chamber (the larder). */
  enemyLarder: ChamberRecord;
  /** The player's FoodStorage chamber (where hauls are deposited). */
  playerLarder: ChamberRecord;
}

/** Tile centre (fp) of tile coordinate `t`. */
export function centre(t: number): number {
  return (t << FP_SHIFT) + (FP_ONE >> 1);
}

/** Open every tile of the rectangle [x0..x1] × [y0..y1] (inclusive). */
export function carve(grid: UndergroundGrid, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) ugSet(grid, x, y, UndergroundTileState.Open);
  }
}

function layoutNest(
  world: WorldState,
  colony: ColonyRecord,
  door: number,
  larderX: number,
  queenX: number,
  larderFp: number,
): ChamberRecord {
  const grid = world.undergroundGrids[colony.colonyId]!;
  carve(grid, door, 0, door, 6);
  carve(grid, Math.min(larderX, queenX), 6, Math.max(larderX + 3, queenX + 4), 6);
  carve(grid, larderX, 5, larderX + 3, 7);
  carve(grid, queenX, 5, queenX + 4, 7);
  const larder = addChamberForTest(
    world,
    colony,
    {
      chamberId: allocateEntityId(world),
      chamberType: ChamberType.FoodStorage,
      posX: larderX << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      width: 4,
      height: 3,
    },
    larderFp,
  );
  addChamberForTest(world, colony, {
    chamberId: allocateEntityId(world),
    chamberType: ChamberType.Queen,
    posX: queenX << FP_SHIFT,
    posY: 5 << FP_SHIFT,
    width: 5,
    height: 3,
  });
  const q = colony.queenEntityId;
  world.ants.zone[q] = Zone.Underground;
  world.ants.currentGridColonyId[q] = colony.colonyId;
  world.ants.posX[q] = centre(queenX + 2);
  world.ants.posY[q] = centre(6);
  colony.digFlowFieldDirty = true;
  return larder;
}

/**
 * The raid world (see the file header). `enemyLarderFp` is the enemy larder's
 * stock; the player's starts empty. Both pools hold 2000 fp so the queens eat.
 */
export function raidWorld(enemyLarderFp = 3000): RaidWorld {
  const world = createScenario(7, 'Normal');
  world.spider = null;
  world.aiState = [];
  const player = world.colonies[PLAYER_COLONY_ID]!;
  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  const pd = player.entrances.find((e) => e.isOpen)!;
  const ed = enemy.entrances.find((e) => e.isOpen)!;
  for (const id of [...enemy.workers, ...player.workers]) {
    despawnAnt(world, id, { cause: 'starvation' });
  }
  const enemyLarder = layoutNest(world, enemy, ed.surfaceTileX, 86, 116, enemyLarderFp);
  const playerLarder = layoutNest(world, player, pd.surfaceTileX, 35, 10, 0);
  setPoolFoodForTest(world, player, 2000);
  setPoolFoodForTest(world, enemy, 2000);
  return {
    world,
    player,
    enemy,
    playerDoor: { x: pd.surfaceTileX, y: pd.surfaceTileY },
    enemyDoor: { x: ed.surfaceTileX, y: ed.surfaceTileY },
    enemyLarder,
    playerLarder,
  };
}

/**
 * Add a Fighting ant of `colonyId` at tile (x, y): on the surface, or below ground
 * in nest `grid`. Just fed. The colony's ratio is set to want every fighter it has
 * (so the small-colony stand-down does not release it).
 */
export function addFighter(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  grid: number | null,
): number {
  const colony = world.colonies[colonyId]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: centre(x),
    posY: centre(y),
    task: AntTask.Fighting,
    subTask: FightingSubState.MovingToRally,
    speed: WORKER_BASE_SPEED,
    zone: grid === null ? Zone.Surface : Zone.Underground,
    lastMealTick: world.tick - 1,
  });
  if (grid !== null) world.ants.currentGridColonyId[id] = grid;
  colony.workers.push(id);
  colony.workerCount += 1;
  let fight = 0;
  let other = 0;
  for (const w of colony.workers) {
    if (world.ants.alive[w] !== 1) continue;
    if (world.ants.task[w] === AntTask.Fighting) fight += 1;
    else other += 1;
  }
  colony.targetRatio.forage = other;
  colony.targetRatio.fight = fight;
  return id;
}

/** Add a motionless enemy (ENEMY_COLONY_ID) worker below ground in its nest at (x, y). */
export function addEnemyWorker(world: WorldState, x: number, y: number): number {
  const colony = world.colonies[ENEMY_COLONY_ID]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: ENEMY_COLONY_ID,
    posX: centre(x),
    posY: centre(y),
    task: AntTask.Idle,
    speed: 0,
    zone: Zone.Underground,
    lastMealTick: world.tick - 1,
  });
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

/** Rally `colony`'s fighters on tile `t`. */
export function rallyOn(colony: ColonyRecord, t: { x: number; y: number }): void {
  colony.rallyPoint = { tileX: t.x, tileY: t.y };
}
