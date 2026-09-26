// fighter-hunger.test.ts — #290 PR 4 (V51), owner decision D11: a hungry fighter
// away from home walks home to eat, then goes back to what it was doing.
//
// Driven through tick() on createScenario worlds so step 3 (the meal), step 10c
// (updateFightAntTargets: the walk-home verdict) and step 16 (tickAntMovement:
// the flow-field walk, the climb out of a foreign nest, the foreign-shaft bar)
// run at their real call sites. The consumption rule itself is pinned in
// colony/worker-hunger.test.ts.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId, SIM_VERSION_V50_LOCATED_FOOD, type WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { fighterWalksHomeToEat, updateFightAntTargets } from './ant/ant-system.js';
import { antIsAtHome, ticksSinceMeal } from './hunger.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone, ugSet, UndergroundTileState } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { isSurfaceTileInComponent } from './surface-features.js';
import { colonyFoodTotal } from './food/food-api.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';
import {
  ENEMY_COLONY_ID,
  FIGHT_AGGRO_RADIUS,
  FIGHTER_STARVE_AFTER_TICKS,
  FIGHTER_WALK_HOME_HUNGER_TICKS,
  PLAYER_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

/** A quiet world (no spider, no AI operations) with a well-stocked player pool. */
function quietWorld(): WorldState {
  const world = createScenario(7, 'Normal');
  world.spider = null;
  world.aiState = [];
  setPoolFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 2000);
  return world;
}

function playerDoor(world: WorldState): { x: number; y: number } {
  const e = world.colonies[PLAYER_COLONY_ID]!.entrances.find((en) => en.isOpen)!;
  return { x: e.surfaceTileX, y: e.surfaceTileY };
}

/** A walkable surface tile `dist` tiles (Manhattan) from the player door, on the
 *  side away from the enemy nest. */
function distantTile(world: WorldState, dist: number): { x: number; y: number } {
  const door = playerDoor(world);
  for (let dy = 0; dy <= dist; dy++) {
    for (const sy of [1, -1]) {
      const x = door.x - (dist - dy) < 0 ? door.x + (dist - dy) : door.x - (dist - dy);
      const y = door.y + sy * dy;
      if (isSurfaceTileInComponent(world, x, y)) return { x, y };
    }
  }
  throw new Error('no walkable tile at that distance');
}

/** Add one player Fighting ant on the surface at (x, y), `sinceMeal` ticks after its
 *  last meal; ask the ratio for every fighter so no stand-down releases it. */
function addFighter(world: WorldState, x: number, y: number, sinceMeal: number): number {
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: FightingSubState.MovingToRally,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Surface,
    lastMealTick: world.tick - sinceMeal,
  });
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

function tileOf(world: WorldState, id: number): { x: number; y: number } {
  return { x: world.ants.posX[id]! >> FP_SHIFT, y: world.ants.posY[id]! >> FP_SHIFT };
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

describe('D11 — a hungry fighter at a distant rally walks home, eats and returns (V51)', () => {
  it('leaves the rally once hungry, eats at home, and walks back to the rally', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    // Standing at its rally, 20 ticks short of the walk-home threshold.
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS - 20);
    const door = playerDoor(world);

    let leftAt = -1;
    let sawWalkHome = false;
    let homeAt = -1;
    let ateAt = -1;
    let backAt = -1;
    const lastBefore = world.ants.lastMealTick[id]!;
    for (let t = 0; t < 1500 && backAt < 0; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      if (fighterWalksHomeToEat(world, id)) sawWalkHome = true;
      const d = manhattan(tileOf(world, id), rally);
      if (leftAt < 0 && d > 2) leftAt = world.tick;
      if (homeAt < 0 && antIsAtHome(world, id)) homeAt = world.tick;
      if (ateAt < 0 && world.ants.lastMealTick[id] !== lastBefore) ateAt = world.tick;
      if (ateAt >= 0 && d <= 2) backAt = world.tick;
    }
    expect(sawWalkHome).toBe(true);
    // It did not budge before it was hungry.
    expect(leftAt).toBeGreaterThan(0);
    expect(leftAt - (lastBefore + FIGHTER_WALK_HOME_HUNGER_TICKS)).toBeGreaterThanOrEqual(0);
    expect(homeAt).toBeGreaterThan(leftAt);
    expect(ateAt).toBeGreaterThanOrEqual(homeAt);
    expect(ateAt).toBeLessThanOrEqual(homeAt + 1);
    // It ate well before it could have starved, and came back to its rally.
    expect(ateAt - lastBefore).toBeLessThan(FIGHTER_STARVE_AFTER_TICKS);
    expect(backAt).toBeGreaterThan(ateAt);
    expect(manhattan(door, rally)).toBe(40);
  });

  it('turns for home exactly at FIGHTER_WALK_HOME_HUNGER_TICKS since its last meal', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS - 1);
    updateFightAntTargets(world); // step 10c reads ticks since meal = world.tick − lastMealTick
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    world.ants.lastMealTick[id] = world.tick - FIGHTER_WALK_HOME_HUNGER_TICKS;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('walks home round an obstacle by the surface flow field (seed 7: x18–23, y70–72)', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    expect(playerDoor(world)).toEqual({ x: 24, y: 64 });
    // Rallied just south of the obstacle, 13 tiles from the door: a straight
    // step north pins it against the obstacle, still out of home range.
    colony.rallyPoint = { tileX: 21, tileY: 74 };
    const id = addFighter(world, 21, 74, FIGHTER_WALK_HOME_HUNGER_TICKS);
    const lastBefore = world.ants.lastMealTick[id]!;
    for (let t = 0; t < 300 && world.ants.lastMealTick[id] === lastBefore; t++) tick(world, []);
    expect(world.ants.lastMealTick[id]).not.toBe(lastBefore);
  });

  it('steps by the surface entrance flow field (cardinal), not the straight-line diagonal', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const door = playerDoor(world);
    // Off both axes from the door: a straight-line step toward it is diagonal;
    // a flow-field step is one cardinal direction.
    let start: { x: number; y: number } | null = null;
    for (let k = 16; k < 40 && start === null; k++) {
      if (isSurfaceTileInComponent(world, door.x + k, door.y + k))
        start = { x: door.x + k, y: door.y + k };
    }
    expect(start).not.toBeNull();
    colony.rallyPoint = { tileX: start!.x, tileY: start!.y };
    const id = addFighter(world, start!.x, start!.y, FIGHTER_WALK_HOME_HUNGER_TICKS);
    let sawCardinal = 0;
    let sawDiagonal = 0;
    for (let t = 0; t < 20; t++) {
      const x0 = world.ants.posX[id]!;
      const y0 = world.ants.posY[id]!;
      tick(world, []);
      expect(fighterWalksHomeToEat(world, id)).toBe(true);
      const moved = [world.ants.posX[id]! !== x0, world.ants.posY[id]! !== y0];
      if (moved[0] && moved[1]) sawDiagonal++;
      else if (moved[0] || moved[1]) sawCardinal++;
    }
    expect(sawCardinal).toBeGreaterThan(0);
    expect(sawDiagonal).toBe(0);
  });

  it('leaves a CROWDED corner rally: fed friends holding the tiles round it do not bump it back', () => {
    // Seed 15, a rally in the map's north-east corner with a fed fighter on
    // each of the 9 walkable tiles within 2 of it. Bumped by the same-colony occupancy pass, the
    // hungry walker (the highest id) was pushed back onto the rally every tick and
    // starved there (reviewer's probe: seed 15, rally (125,2)); walking home to
    // eat it passes through friends, as V43 sentries and V49 musterers do.
    const world = createScenario(15, 'Normal');
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    setPoolFoodForTest(world, colony, 2000);
    const rally = { x: 125, y: 2 };
    expect(isSurfaceTileInComponent(world, rally.x, rally.y)).toBe(true);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    let friends = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2) continue;
        if (!isSurfaceTileInComponent(world, rally.x + dx, rally.y + dy)) continue;
        addFighter(world, rally.x + dx, rally.y + dy, 0);
        friends++;
      }
    }
    expect(friends).toBe(9);
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS);
    const lastBefore = world.ants.lastMealTick[id]!;
    for (let t = 0; t < 1300 && world.ants.lastMealTick[id] === lastBefore; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
    }
    expect(world.ants.lastMealTick[id]).not.toBe(lastBefore); // it got home and ate
  }, 30_000);

  it('a hungry surface fighter of a tunnel-defence colony (rally on its own door) goes in, not waits', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const door = playerDoor(world);
    colony.rallyPoint = { tileX: door.x, tileY: door.y };
    const id = addFighter(world, door.x + 3, door.y, FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    setPoolFoodForTest(world, colony, 0); // unfed at home
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    // Ordinary tunnel-defence routing: onto its own door to go down, not a hold.
    expect(world.ants.targetPosX[id]! >> FP_SHIFT).toBe(door.x);
    expect(world.ants.targetPosY[id]! >> FP_SHIFT).toBe(door.y);
  });

  it('a fed fighter at the same rally stays put', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, 0);
    for (let t = 0; t < 300; t++) {
      tick(world, []);
      expect(manhattan(tileOf(world, id), rally)).toBeLessThanOrEqual(2);
    }
  });

  it('home but unfed (famine), a rallied fighter waits at home instead of going back out', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const door = playerDoor(world);
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, door.x + 3, door.y, FIGHTER_WALK_HOME_HUNGER_TICKS);
    setPoolFoodForTest(world, colony, 0); // no FoodStorage in a fresh scenario
    expect(colonyFoodTotal(world, colony)).toBe(0);
    // Past a meal but unfed: the rally is 40 tiles out, yet it stays home.
    for (let t = 0; t < 200; t++) {
      setPoolFoodForTest(world, colony, 0); // foragers keep bringing food in: hold the famine
      tick(world, []);
      expect(antIsAtHome(world, id)).toBe(true);
    }
    expect(ticksSinceMeal(world, id)).toBeGreaterThan(FIGHTER_WALK_HOME_HUNGER_TICKS);
  });
});

describe('D11 — combat comes first', () => {
  it('a hungry fighter with an enemy ant in sight chases it instead of walking home', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    // An enemy worker two tiles off.
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const eid = allocateEntityId(world);
    initAnt(world.ants, eid, {
      colonyId: ENEMY_COLONY_ID,
      posX: ((rally.x + 2) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (rally.y << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      zone: Zone.Surface,
    });
    enemy.workers.push(eid);
    enemy.workerCount += 1;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    expect(world.ants.targetPosX[id]! >> FP_SHIFT).toBe(rally.x + 2);
    // Enemy gone: now it walks home.
    world.ants.alive[eid] = 0; // test-only: removes the target from the scan
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('a hungry fighter in a duel does not walk home', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    world.ants.combatOpponentId[id] = -2; // paired with the spider
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    world.ants.combatOpponentId[id] = -1;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('a colony sent at the spider keeps its hungry fighters on it', () => {
    const world = quietWorld();
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    world.spiderPriorityColonyId = PLAYER_COLONY_ID;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });

  it('a hungry fighter walking home does not stop to mob a spider it merely sees', () => {
    const world = createScenario(7, 'Normal');
    world.aiState = [];
    setPoolFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 2000);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    expect(world.spider).not.toBeNull();
    world.spider!.posX = ((rally.x + 2) << FP_SHIFT) + (FP_ONE >> 1);
    world.spider!.posY = (rally.y << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('below V51 nothing walks home hungry', () => {
    const world = quietWorld();
    world.simVersion = SIM_VERSION_V50_LOCATED_FOOD;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, FIGHTER_STARVE_AFTER_TICKS + 10);
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    expect(world.ants.targetPosX[id]).toBe(-1); // held at its rally
  });
});

describe('D11 — a hungry invader climbs out of the enemy nest', () => {
  /** A player fighter below ground in the ENEMY nest, at the foot of its open shaft. */
  function invader(sinceMeal: number): { world: WorldState; id: number; shaftX: number } {
    const world = quietWorld();
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const ent = enemy.entrances.find((e) => e.isOpen)!;
    world.colonies[PLAYER_COLONY_ID]!.rallyPoint = {
      tileX: ent.surfaceTileX,
      tileY: ent.surfaceTileY,
    };
    const id = addFighter(world, ent.surfaceTileX, 0, sinceMeal);
    world.ants.zone[id] = Zone.Underground;
    world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
    world.ants.posX[id] = (ent.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (1 << FP_SHIFT) + (FP_ONE >> 1); // the shaft's bottom tile
    return { world, id, shaftX: ent.surfaceTileX };
  }

  it('climbs out of a U-bend tunnel (wall-aware route, not a straight line at the shaft)', () => {
    const { world, id, shaftX } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    const far = distantTile(world, 60);
    world.ants.posX[enemy.queenEntityId] = (far.x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[enemy.queenEntityId] = (far.y << FP_SHIFT) + (FP_ONE >> 1);
    // A U-bend: the shaft (shaftX, 0..1) runs down to y 8, east 6 tiles, and back
    // up to y 3, where the invader stands. Every step toward the shaft top is
    // rock: it has to walk AWAY from the exit (down) first.
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let y = 1; y <= 8; y++) ugSet(grid, shaftX, y, UndergroundTileState.Open);
    for (let x = shaftX; x <= shaftX + 6; x++) ugSet(grid, x, 8, UndergroundTileState.Open);
    for (let y = 3; y <= 8; y++) ugSet(grid, shaftX + 6, y, UndergroundTileState.Open);
    world.ants.posX[id] = ((shaftX + 6) << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (3 << FP_SHIFT) + (FP_ONE >> 1);
    let surfacedAt = -1;
    for (let t = 0; t < 600 && surfacedAt < 0; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      if (world.ants.zone[id] === Zone.Surface) surfacedAt = t;
    }
    expect(surfacedAt).toBeGreaterThanOrEqual(0);
  });

  it('ignores a nearer open stub shaft that does not join the nest, and climbs out the real one', () => {
    const { world, id, shaftX } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    const far = distantTile(world, 60);
    world.ants.posX[enemy.queenEntityId] = (far.x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[enemy.queenEntityId] = (far.y << FP_SHIFT) + (FP_ONE >> 1);
    // The U-bend of the previous test…
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let y = 1; y <= 8; y++) ugSet(grid, shaftX, y, UndergroundTileState.Open);
    for (let x = shaftX; x <= shaftX + 6; x++) ugSet(grid, x, 8, UndergroundTileState.Open);
    for (let y = 3; y <= 8; y++) ugSet(grid, shaftX + 6, y, UndergroundTileState.Open);
    // …plus an "open" entrance two columns east whose 2-tile shaft joins nothing:
    // nearer to the invader than the real exit, and unreachable.
    ugSet(grid, shaftX + 8, 0, UndergroundTileState.Open);
    ugSet(grid, shaftX + 8, 1, UndergroundTileState.Open);
    enemy.entrances.push({
      entranceId: 99,
      surfaceTileX: shaftX + 8,
      surfaceTileY: enemy.entrances[0]!.surfaceTileY,
      isOpen: true,
    });
    world.ants.posX[id] = ((shaftX + 6) << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (3 << FP_SHIFT) + (FP_ONE >> 1);
    let surfacedAt = -1;
    for (let t = 0; t < 600 && surfacedAt < 0; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      if (world.ants.zone[id] === Zone.Surface) surfacedAt = t;
    }
    expect(surfacedAt).toBeGreaterThanOrEqual(0);
    expect(world.ants.posX[id] >> FP_SHIFT).toBe(shaftX); // out of the real shaft
  });

  it('never takes a closed entrance as its exit, even one whose shaft is dug below its top tile', () => {
    const { world, id, shaftX } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    const far = distantTile(world, 60);
    world.ants.posX[enemy.queenEntityId] = (far.x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[enemy.queenEntityId] = (far.y << FP_SHIFT) + (FP_ONE >> 1);
    // The U-bend again…
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let y = 1; y <= 8; y++) ugSet(grid, shaftX, y, UndergroundTileState.Open);
    for (let x = shaftX; x <= shaftX + 6; x++) ugSet(grid, x, 8, UndergroundTileState.Open);
    for (let y = 3; y <= 8; y++) ugSet(grid, shaftX + 6, y, UndergroundTileState.Open);
    // …plus a CLOSED entrance two columns east, dug from inside: y 1..3 open and
    // joined to the invader's tunnel, but its top tile (y 0) still Marked. It is
    // nearer than the real exit, and reachable up to y 1, where it would be stuck.
    ugSet(grid, shaftX + 8, 0, UndergroundTileState.Marked);
    for (let y = 1; y <= 3; y++) ugSet(grid, shaftX + 8, y, UndergroundTileState.Open);
    ugSet(grid, shaftX + 7, 3, UndergroundTileState.Open);
    enemy.entrances.push({
      entranceId: 99,
      surfaceTileX: shaftX + 8,
      surfaceTileY: enemy.entrances[0]!.surfaceTileY,
      isOpen: false,
    });
    world.ants.posX[id] = ((shaftX + 6) << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (3 << FP_SHIFT) + (FP_ONE >> 1);
    let surfacedAt = -1;
    for (let t = 0; t < 600 && surfacedAt < 0; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      if (world.ants.zone[id] === Zone.Surface) surfacedAt = t;
    }
    expect(surfacedAt).toBeGreaterThanOrEqual(0);
    expect(world.ants.posX[id] >> FP_SHIFT).toBe(shaftX); // out of the real, open shaft
  });

  it('with no hostile near, it climbs out, crosses home and eats', () => {
    const { world, id } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    // Clear the enemy doorstep (its starting workers and queen stand on the door
    // tile, where same-tile combat would kill a lone invader climbing out).
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    const far = distantTile(world, 60);
    world.ants.posX[enemy.queenEntityId] = (far.x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[enemy.queenEntityId] = (far.y << FP_SHIFT) + (FP_ONE >> 1);
    const lastBefore = world.ants.lastMealTick[id]!;
    let surfacedAt = -1;
    let ateAt = -1;
    let homeWhenItAte = false;
    for (let t = 0; t < 1200 && ateAt < 0; t++) {
      const homeBefore = antIsAtHome(world, id); // where step 3 of this tick sees it
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      if (world.ants.lastMealTick[id] !== lastBefore) homeWhenItAte = homeBefore;
      if (surfacedAt < 0 && world.ants.zone[id] === Zone.Surface) {
        surfacedAt = world.tick;
        expect(world.ants.currentGridColonyId[id]).toBe(PLAYER_COLONY_ID);
      }
      // It never drops back into the enemy nest on the way.
      if (surfacedAt >= 0) expect(world.ants.currentGridColonyId[id]).toBe(PLAYER_COLONY_ID);
      if (world.ants.lastMealTick[id] !== lastBefore) ateAt = world.tick;
    }
    expect(surfacedAt).toBeGreaterThan(0);
    expect(ateAt).toBeGreaterThan(surfacedAt);
    // It ate at home, from the stores (it carries nothing).
    expect(homeWhenItAte).toBe(true);
  });

  it('with a hostile within FIGHT_AGGRO_RADIUS it stays to fight', () => {
    const { world, id, shaftX } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let y = 0; y <= 2 + FIGHT_AGGRO_RADIUS; y++) {
      ugSet(grid, shaftX, y, UndergroundTileState.Open);
    }
    const eid = allocateEntityId(world);
    initAnt(world.ants, eid, {
      colonyId: ENEMY_COLONY_ID,
      posX: (shaftX << FP_SHIFT) + (FP_ONE >> 1),
      posY: ((1 + FIGHT_AGGRO_RADIUS) << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      zone: Zone.Underground,
    });
    world.ants.currentGridColonyId[eid] = ENEMY_COLONY_ID;
    enemy.workers.push(eid);
    enemy.workerCount += 1;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    // One tile farther: out of reach, so it leaves.
    world.ants.posY[eid] = ((2 + FIGHT_AGGRO_RADIUS) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('climbing out into an enemy on the doorstep, it fights there and does not drop back in', () => {
    const { world, id } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const door = enemy.entrances.find((e) => e.isOpen)!;
    // Clear the doorstep, then stand one enemy worker on the door tile.
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    const far = distantTile(world, 60);
    world.ants.posX[enemy.queenEntityId] = (far.x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[enemy.queenEntityId] = (far.y << FP_SHIFT) + (FP_ONE >> 1);
    const eid = allocateEntityId(world);
    initAnt(world.ants, eid, {
      colonyId: ENEMY_COLONY_ID,
      posX: (door.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (door.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      zone: Zone.Surface,
      lastMealTick: world.tick - 1,
    });
    enemy.workers.push(eid);
    enemy.workerCount += 1;
    let surfaced = false;
    let redescents = 0;
    for (let t = 0; t < 40 && world.ants.alive[id] === 1; t++) {
      tick(world, []);
      if (world.ants.zone[id] === Zone.Surface) surfaced = true;
      else if (surfaced) redescents++;
    }
    expect(surfaced).toBe(true);
    expect(redescents).toBe(0);
  });

  it('an invader in a duel stays, even with no other hostile near', () => {
    const { world, id } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    world.ants.combatOpponentId[id] = 0; // paired with an ant
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    world.ants.combatOpponentId[id] = -1;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('cohort-mates beside it, or an enemy in another grid or on the surface, do not keep it', () => {
    const { world, id, shaftX } = invader(FIGHTER_WALK_HOME_HUNGER_TICKS + 10);
    // A fed cohort-mate (own colony) one tile away in the same foreign nest.
    const mate = addFighter(world, shaftX, 0, 0);
    world.ants.zone[mate] = Zone.Underground;
    world.ants.currentGridColonyId[mate] = ENEMY_COLONY_ID;
    world.ants.posY[mate] = (1 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posX[mate] = ((shaftX + 1) << FP_SHIFT) + (FP_ONE >> 1);
    // Enemy ants at the same coordinates but not in this grid: one on the
    // surface, one below ground in the PLAYER's nest.
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    for (const [zone, grid] of [
      [Zone.Surface, ENEMY_COLONY_ID],
      [Zone.Underground, PLAYER_COLONY_ID],
    ] as const) {
      const eid = allocateEntityId(world);
      initAnt(world.ants, eid, {
        colonyId: ENEMY_COLONY_ID,
        posX: (shaftX << FP_SHIFT) + (FP_ONE >> 1),
        posY: (2 << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Idle,
        zone,
      });
      world.ants.currentGridColonyId[eid] = grid;
      enemy.workers.push(eid);
      enemy.workerCount += 1;
    }
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
  });

  it('a fed invader stays in the enemy nest', () => {
    const { world, id } = invader(0);
    for (let t = 0; t < 50; t++) tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[id]).toBe(ENEMY_COLONY_ID);
  });
});
