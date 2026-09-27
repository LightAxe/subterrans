// routed-homing.test.ts — #343 + #346 (V55): ants walking home route round what
// is in the way.
//
// Up to V54 a surface nurse or idle worker walking home stepped in a straight
// line at the entrance, and a plain recalled invader walked out of an enemy nest
// in a straight line at its shaft, so an obstacle (or a U-bend) pinned them; since
// V51 workers eat, and a worker pinned away from home starves. From V55 the
// surface walkers step by the colony's surface entrance flow field and the
// recalled invader by the wall-aware BFS exit step.
//
// Driven through tick() on createScenario worlds so step 3 (the meal), step 10a
// (allocation), step 15b (the mill target) and step 16 (movement) run at their
// real call sites. Every test runs the same setup at V54 (pinned: the bug) and at
// V55 (gets home: the fix).

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import {
  allocateEntityId,
  SIM_VERSION_V54_SPIDER_ROTATES_ENTRANCES,
  SIM_VERSION_V55_ROUTED_HOMING,
  LATEST_SIM_VERSION,
  type WorldState,
} from './types.js';
import { initAnt } from './ant/ant-store.js';
import { idleWalksHome } from './ant/idle-reserve.js';
import { tickAntMovement } from './ant/ant-movement.js';
import { createDigFlowFields } from './dig-system.js';
import { Rng } from './rng.js';
import { antIsAtHome } from './hunger.js';
import { AntTask, FightingSubState, NursingSubState, PheromoneType } from './enums.js';
import { Zone, ugSet, UndergroundTileState } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { canEnterSurfaceTile } from './ant/ant-motion.js';
import { pheromoneGridKey, phSet } from './pheromone/pheromone-store.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';
import {
  ENEMY_COLONY_ID,
  FIGHTER_WALK_HOME_HUNGER_TICKS,
  FLEE_THRESHOLD,
  HOME_EAT_RADIUS_TILES,
  IDLE_MILL_TICK_DIVISOR,
  PLAYER_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  WORKER_STARVE_AFTER_TICKS,
} from './constants.js';

const V54 = SIM_VERSION_V54_SPIDER_ROTATES_ENTRANCES;
const V55 = SIM_VERSION_V55_ROUTED_HOMING;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/**
 * A quiet world: no spider, no AI, a well-stocked pool for colony `colonyId`,
 * and a behaviour ratio of 0:0 there so step 10a leaves an Idle worker Idle (no
 * forage or fight demand; a fresh scenario has no Nursery, so no nurse demand).
 */
function quietWorld(seed: number, version: number, colonyId: number): WorldState {
  const world = createScenario(seed, 'Normal');
  world.simVersion = version;
  world.spider = null;
  world.aiState = [];
  const colony = world.colonies[colonyId]!;
  setPoolFoodForTest(world, colony, 2000);
  colony.targetRatio.forage = 0;
  colony.targetRatio.fight = 0;
  return world;
}

function doorOf(world: WorldState, colonyId: number): { x: number; y: number } {
  const e = world.colonies[colonyId]!.entrances.find((en) => en.isOpen)!;
  return { x: e.surfaceTileX, y: e.surfaceTileY };
}

/** A worker of `colonyId` on the surface at (x, y), `sinceMeal` ticks after its last meal. */
function addWorker(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  task: number,
  subTask: number,
  sinceMeal: number,
): number {
  const colony = world.colonies[colonyId]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: center(x),
    posY: center(y),
    task,
    subTask,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Surface,
    lastMealTick: world.tick - sinceMeal,
  });
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

function tileOf(world: WorldState, id: number): { x: number; y: number } {
  return { x: world.ants.posX[id]! >> FP_SHIFT, y: world.ants.posY[id]! >> FP_SHIFT };
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Every-tick tile samples: no A→B→A oscillation, and no tile revisited once left. */
function expectNoRevisit(tiles: readonly string[]): void {
  const left = new Set<string>();
  for (let i = 1; i < tiles.length; i++) {
    if (tiles[i] === tiles[i - 1]) continue;
    expect(left.has(tiles[i]!)).toBe(false);
    left.add(tiles[i - 1]!);
  }
}

function expectBlocked(world: WorldState, x0: number, x1: number, y0: number, y1: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) expect(canEnterSurfaceTile(world, x, y)).toBe(false);
  }
}

/**
 * #343's own case: seed 488, the obstacle at x103–106, y51–54 north of the enemy
 * door (104,64). An enemy nurse walking in from (104,48), due north of it, runs
 * straight into it.
 */
const NURSE_SEED = 488;
const NURSE_FROM = { x: 104, y: 48 } as const;

/**
 * Seed 117: an obstacle at x89–93, y83–88 (x85–93 on y83) south-west of the
 * enemy door (104,64). An enemy idle worker in the pocket west of it, at (86,86),
 * 40 tiles from the door, steps east / north into it.
 */
const IDLE_SEED = 117;
const IDLE_FROM = { x: 86, y: 86 } as const;

describe('V55 (#343, #346)', () => {
  it('LATEST is V55 or later', () => {
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V55_ROUTED_HOMING);
  });
});

describe('fixtures', () => {
  it('seed 488: the obstacle stands between NURSE_FROM and the enemy door', () => {
    const world = quietWorld(NURSE_SEED, V55, ENEMY_COLONY_ID);
    expect(doorOf(world, ENEMY_COLONY_ID)).toEqual({ x: 104, y: 64 });
    expect(canEnterSurfaceTile(world, NURSE_FROM.x, NURSE_FROM.y)).toBe(true);
    expectBlocked(world, 103, 106, 51, 54);
  });

  it('seed 117: the obstacle stands between IDLE_FROM and the enemy door, out of home range', () => {
    const world = quietWorld(IDLE_SEED, V55, ENEMY_COLONY_ID);
    expect(doorOf(world, ENEMY_COLONY_ID)).toEqual({ x: 104, y: 64 });
    expect(canEnterSurfaceTile(world, IDLE_FROM.x, IDLE_FROM.y)).toBe(true);
    expectBlocked(world, 89, 93, 84, 88);
    expectBlocked(world, 85, 93, 83, 83);
    expect(manhattan(IDLE_FROM, doorOf(world, ENEMY_COLONY_ID))).toBeGreaterThan(
      HOME_EAT_RADIUS_TILES,
    );
  });
});

describe('#343 (V55) — a surface nurse behind an obstacle gets into its nest', () => {
  /** A nurse carrying an egg home from NURSE_FROM: the tick it is below ground (or
   *  -1), and the tiles it stood on, sampled every tick. */
  function nurseWalk(version: number, ticks: number): { downAt: number; tiles: string[] } {
    const world = quietWorld(NURSE_SEED, version, ENEMY_COLONY_ID);
    // A carrier (Feeding, a live egg in the carry slot) walks home and is never
    // released on the way; a MovingToBrood nurse with no claimable brood would
    // be released at once.
    const id = addWorker(
      world,
      ENEMY_COLONY_ID,
      NURSE_FROM.x,
      NURSE_FROM.y,
      AntTask.Nursing,
      NursingSubState.Feeding,
      0,
    );
    const egg = allocateEntityId(world);
    initAnt(world.ants, egg, {
      colonyId: ENEMY_COLONY_ID,
      posX: center(NURSE_FROM.x),
      posY: center(NURSE_FROM.y),
      task: AntTask.Idle,
      zone: Zone.Surface,
    });
    world.colonies[ENEMY_COLONY_ID]!.eggs.push(egg);
    world.ants.carryingBroodId[id] = egg;
    world.ants.carriedBy[egg] = id;
    const tiles: string[] = [];
    for (let t = 0; t < ticks; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      expect(world.ants.task[id]).toBe(AntTask.Nursing);
      if (world.ants.zone[id] === Zone.Underground) return { downAt: t, tiles };
      const p = tileOf(world, id);
      tiles.push(`${p.x},${p.y}`);
    }
    return { downAt: -1, tiles };
  }

  it('V54: pinned against the obstacle (the bug)', () => {
    expect(nurseWalk(V54, 500).downAt).toBe(-1);
  });

  it('V55: walks round the obstacle and goes down, never stepping back onto a tile it left', () => {
    const { downAt, tiles } = nurseWalk(V55, 500);
    expect(downAt).toBeGreaterThanOrEqual(0);
    expectNoRevisit(tiles);
  });
});

describe('#343 (V55) — an idle worker behind an obstacle walks home', () => {
  interface IdleWalk {
    homeAt: number;
    tiles: string[];
    leftHomeAfter: number;
    alive: boolean;
    ate: boolean;
    endHome: boolean;
  }
  /** An enemy Idle worker from IDLE_FROM, `sinceMeal` ticks since its last meal. */
  function idleWalk(version: number, ticks: number, sinceMeal = 0): IdleWalk {
    const world = quietWorld(IDLE_SEED, version, ENEMY_COLONY_ID);
    const id = addWorker(
      world,
      ENEMY_COLONY_ID,
      IDLE_FROM.x,
      IDLE_FROM.y,
      AntTask.Idle,
      0,
      sinceMeal,
    );
    const lastMeal = world.ants.lastMealTick[id]!;
    const tiles: string[] = [];
    let homeAt = -1;
    let leftHomeAfter = 0;
    for (let t = 0; t < ticks; t++) {
      tick(world, []);
      if (world.ants.alive[id] !== 1) break;
      expect(world.ants.task[id]).toBe(AntTask.Idle);
      const home = antIsAtHome(world, id);
      if (homeAt < 0) {
        if (home) homeAt = t;
        else {
          const p = tileOf(world, id);
          tiles.push(`${p.x},${p.y}`);
        }
      } else if (!home) leftHomeAfter++;
    }
    return {
      homeAt,
      tiles,
      leftHomeAfter,
      alive: world.ants.alive[id] === 1,
      ate: world.ants.lastMealTick[id] !== lastMeal,
      endHome: world.ants.alive[id] === 1 && antIsAtHome(world, id),
    };
  }

  it('V54: pinned out of home range (the bug)', () => {
    expect(idleWalk(V54, 800).homeAt).toBe(-1);
  });

  it('V55: gets home and stays home; on the way it never steps back onto a tile it left', () => {
    const r = idleWalk(V55, 800);
    expect(r.homeAt).toBeGreaterThanOrEqual(0);
    // At the idle saunter: no faster than one tile per IDLE_MILL_TICK_DIVISOR ticks.
    expect(r.homeAt).toBeGreaterThanOrEqual(
      (manhattan(IDLE_FROM, { x: 104, y: 64 }) - HOME_EAT_RADIUS_TILES) * IDLE_MILL_TICK_DIVISOR -
        IDLE_MILL_TICK_DIVISOR,
    );
    // Here, at the edge of home range, the first diagonal mill step crosses a tile
    // boundary on one axis a tick before the other (sub-tile motion) and leaves
    // home range for one tile; the field steps it straight back, and the mill's
    // other axis closes on the next mill tick. (Where a mill step is detoured out
    // of home range by an obstacle inside it, the walker can bounce in and out;
    // it is at home every other step, so it still eats.)
    expect(r.leftHomeAfter).toBeLessThanOrEqual(2 * IDLE_MILL_TICK_DIVISOR);
    expect(r.endHome).toBe(true);
    expectNoRevisit(r.tiles);
  });

  it('a hungry one starves pinned at V54 and gets home to eat at V55', () => {
    const since = WORKER_STARVE_AFTER_TICKS - 400;
    const v54 = idleWalk(V54, 500, since);
    expect(v54.alive).toBe(false);
    const v55 = idleWalk(V55, 500, since);
    expect(v55.alive).toBe(true);
    expect(v55.ate).toBe(true);
  });

  describe('idleWalksHome', () => {
    /** The predicate with the colony's surface DangerTrail grid, as movement passes it. */
    function walksHome(world: WorldState, id: number): boolean {
      return idleWalksHome(
        world,
        id,
        world.pheromoneGrids[
          pheromoneGridKey(ENEMY_COLONY_ID, PheromoneType.DangerTrail, 'surface')
        ],
      );
    }

    function idleAt(version: number, x: number, y: number): { world: WorldState; id: number } {
      const world = quietWorld(IDLE_SEED, version, ENEMY_COLONY_ID);
      const id = addWorker(world, ENEMY_COLONY_ID, x, y, AntTask.Idle, 0, 0);
      tick(world, []); // step 15b sets its mill target
      world.ants.posX[id] = center(x);
      world.ants.posY[id] = center(y);
      return { world, id };
    }

    it('true for an idle worker out of home range with its mill target set', () => {
      const { world, id } = idleAt(V55, IDLE_FROM.x, IDLE_FROM.y);
      expect(world.ants.targetPosX[id]).not.toBe(-1);
      expect(walksHome(world, id)).toBe(true);
    });

    it('false below V55', () => {
      const { world, id } = idleAt(V54, IDLE_FROM.x, IDLE_FROM.y);
      expect(walksHome(world, id)).toBe(false);
    });

    it('false at home (it mills)', () => {
      const { world, id } = idleAt(V55, 104 + 4, 64);
      expect(antIsAtHome(world, id)).toBe(true);
      expect(walksHome(world, id)).toBe(false);
    });

    it('false while one of its open entrances is camped (the field may lead there)', () => {
      const { world, id } = idleAt(V55, IDLE_FROM.x, IDLE_FROM.y);
      const grid =
        world.pheromoneGrids[
          pheromoneGridKey(ENEMY_COLONY_ID, PheromoneType.DangerTrail, 'surface')
        ]!;
      phSet(grid, 104, 64, FLEE_THRESHOLD);
      expect(walksHome(world, id)).toBe(false);
      phSet(grid, 104, 64, FLEE_THRESHOLD - 1);
      expect(walksHome(world, id)).toBe(true);
    });

    it('false inside the spider scatter radius (it keeps dodging)', () => {
      const { world, id } = idleAt(V55, IDLE_FROM.x, IDLE_FROM.y);
      world.scatterReticleTile = { x: IDLE_FROM.x, y: IDLE_FROM.y + 1 };
      expect(walksHome(world, id)).toBe(false);
    });

    it('false under the colony alarm (the V49 muster routes it)', () => {
      const { world, id } = idleAt(V55, IDLE_FROM.x, IDLE_FROM.y);
      world.colonies[ENEMY_COLONY_ID]!.alarmActive = true;
      expect(walksHome(world, id)).toBe(false);
    });

    it('false while fleeing, with no target, or when not Idle', () => {
      const { world, id } = idleAt(V55, IDLE_FROM.x, IDLE_FROM.y);
      world.ants.fleeShelterUntilTick[id] = 0;
      expect(walksHome(world, id)).toBe(false);
      world.ants.fleeShelterUntilTick[id] = -1;
      world.ants.task[id] = AntTask.Foraging;
      expect(walksHome(world, id)).toBe(false);
      world.ants.task[id] = AntTask.Idle;
      world.ants.targetPosX[id] = -1;
      expect(walksHome(world, id)).toBe(false);
    });
  });
});

describe('#346 (V55) — a recalled invader climbs out of a U-bend in the enemy nest', () => {
  /**
   * A FED player fighter below ground in the enemy nest, its colony's rally
   * cleared (recalled), standing at the top of the far leg of a U-bend: the shaft
   * (shaftX, 0..1) runs down to y 8, east 6 tiles, and back up to y 3. Every step
   * toward the shaft top is rock, so it has to walk AWAY from the exit first.
   * (The layout of the V51 hungry-invader test in fighter-hunger.test.ts.)
   */
  function recalledInUBend(version: number): { world: WorldState; id: number; shaftX: number } {
    const world = quietWorld(7, version, PLAYER_COLONY_ID);
    const player = world.colonies[PLAYER_COLONY_ID]!;
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const ent = enemy.entrances.find((e) => e.isOpen)!;
    const shaftX = ent.surfaceTileX;
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    // Park the enemy queen far away on the surface so nothing hostile is near.
    const door = doorOf(world, PLAYER_COLONY_ID);
    world.ants.zone[enemy.queenEntityId] = Zone.Surface;
    world.ants.posX[enemy.queenEntityId] = center(door.x - 20);
    world.ants.posY[enemy.queenEntityId] = center(door.y);
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let y = 1; y <= 8; y++) ugSet(grid, shaftX, y, UndergroundTileState.Open);
    for (let x = shaftX; x <= shaftX + 6; x++) ugSet(grid, x, 8, UndergroundTileState.Open);
    for (let y = 3; y <= 8; y++) ugSet(grid, shaftX + 6, y, UndergroundTileState.Open);
    const id = addWorker(
      world,
      PLAYER_COLONY_ID,
      shaftX + 6,
      3,
      AntTask.Fighting,
      FightingSubState.MovingToRally,
      0,
    );
    world.ants.zone[id] = Zone.Underground;
    world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
    // Ask the ratio for every fighter so no stand-down releases it; no rally.
    player.targetRatio.fight = 1;
    player.rallyPoint = null;
    return { world, id, shaftX };
  }

  function surfaces(version: number, ticks: number): { at: number; tiles: string[] } {
    const { world, id } = recalledInUBend(version);
    const tiles: string[] = [];
    for (let t = 0; t < ticks; t++) {
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      expect(world.ants.task[id]).toBe(AntTask.Fighting);
      if (world.ants.zone[id] === Zone.Surface) return { at: t, tiles };
      const p = tileOf(world, id);
      tiles.push(`${p.x},${p.y}`);
    }
    return { at: -1, tiles };
  }

  it('the invader is fed for the whole run, so the V51 hungry walk-out never rescues it', () => {
    expect(FIGHTER_WALK_HOME_HUNGER_TICKS).toBeGreaterThan(600);
  });

  it('V54: pinned in the U-bend (the bug)', () => {
    expect(surfaces(V54, 600).at).toBe(-1);
  });

  it('V55: walks down, along and up the shaft and surfaces, never stepping back', () => {
    const { at, tiles } = surfaces(V55, 600);
    expect(at).toBeGreaterThanOrEqual(0);
    expectNoRevisit(tiles);
  });

  it('V55: surfaces through the real shaft', () => {
    const { world, id, shaftX } = recalledInUBend(V55);
    for (let t = 0; t < 600 && world.ants.zone[id] !== Zone.Surface; t++) tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect(world.ants.posX[id]! >> FP_SHIFT).toBe(shaftX);
  });

  it('V55: ignores a nearer open stub shaft that does not join the nest, and climbs out the real one', () => {
    const { world, id, shaftX } = recalledInUBend(V55);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    ugSet(grid, shaftX + 8, 0, UndergroundTileState.Open);
    ugSet(grid, shaftX + 8, 1, UndergroundTileState.Open);
    enemy.entrances.push({
      entranceId: 99,
      surfaceTileX: shaftX + 8,
      surfaceTileY: enemy.entrances[0]!.surfaceTileY,
      isOpen: true,
    });
    for (let t = 0; t < 600 && world.ants.zone[id] !== Zone.Surface; t++) tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect(world.ants.posX[id]! >> FP_SHIFT).toBe(shaftX);
  });

  it('V55: on the field it takes the exit nearest by tunnel, not the one nearest as the crow flies', () => {
    // A second open shaft at shaftX + 14 joined to the invader's tile by a tunnel
    // east along y 3: 11 steps away by tunnel against the U-bend exit's 19, but
    // 11 tiles away as the crow flies against the U-bend exit's 9. The nest's
    // entrance field (a recalled invader's first choice, as a hauler's) takes the
    // tunnel-nearest; the BFS fallback would take the crow-nearest reachable one.
    const { world, id, shaftX } = recalledInUBend(V55);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let x = shaftX + 7; x <= shaftX + 14; x++) ugSet(grid, x, 3, UndergroundTileState.Open);
    for (let y = 0; y <= 3; y++) ugSet(grid, shaftX + 14, y, UndergroundTileState.Open);
    enemy.entrances.push({
      entranceId: 99,
      surfaceTileX: shaftX + 14,
      surfaceTileY: enemy.entrances[0]!.surfaceTileY,
      isOpen: true,
    });
    for (let t = 0; t < 600 && world.ants.zone[id] !== Zone.Surface; t++) tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect(world.ants.posX[id]! >> FP_SHIFT).toBe(shaftX + 14);
  });

  it('with no entrance field (movement driven alone) the BFS exit step gets it out at V55, not at V54', () => {
    for (const version of [V54, V55]) {
      const { world, id } = recalledInUBend(version);
      let out = false;
      for (let t = 0; t < 400 && !out; t++) {
        tickAntMovement(world, new Rng(1), createDigFlowFields());
        out = world.ants.zone[id] === Zone.Surface;
      }
      expect(out).toBe(version === V55);
    }
  });

  it('with a rally still on the enemy door it is not recalled: it stays below at V55 too', () => {
    const { world, id } = recalledInUBend(V55);
    const ent = world.colonies[ENEMY_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
    world.colonies[PLAYER_COLONY_ID]!.rallyPoint = {
      tileX: ent.surfaceTileX,
      tileY: ent.surfaceTileY,
    };
    for (let t = 0; t < 300; t++) {
      tick(world, []);
      expect(world.ants.zone[id]).toBe(Zone.Underground);
    }
  });
});
