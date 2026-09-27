// routed-doorward.test.ts — #357 + #358 (V57): surface walkers bound for one
// particular door route round what is in the way.
//
// Up to V56 a tunnel-defence fighter walking to the entrance its colony defends,
// and a surface digger walking to its entrance target (closed or open), stepped
// in a straight line at that door, so an obstacle between them pinned them.
// From V57 each steps down the surface goal field seeded at its own door
// (stepTowardReachable). Neither can use the entrance flow field: it leads to the
// NEAREST OPEN entrance, which a defender may not go down and which a closed
// dig target is never on.
//
// Driven through tick() on createScenario worlds, so step 3 (the meal), step 10c
// (fighter routing), step 16 (movement and descent) run at their real call sites.
// Every test runs the same setup at V56 (pinned: the bug) and at V57 (gets there:
// the fix).

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import {
  allocateEntityId,
  SIM_VERSION_V56_OPPONENT_FRONTAGE,
  SIM_VERSION_V57_ROUTED_DOORWARD,
  LATEST_SIM_VERSION,
  type WorldState,
} from './types.js';
import { initAnt } from './ant/ant-store.js';
import { fighterDefendsTunnels } from './ant/ant-combat-targeting.js';
import { antIsAtHome, fighterIsHungry } from './hunger.js';
import { AntTask } from './enums.js';
import { Zone, ugSet, UndergroundTileState } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { canEnterSurfaceTile } from './ant/ant-motion.js';
import { surfaceGoalDistance } from './surface-routing.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';
import {
  ENEMY_COLONY_ID,
  FIGHTER_WALK_HOME_HUNGER_TICKS,
  HOME_EAT_RADIUS_TILES,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

const V56 = SIM_VERSION_V56_OPPONENT_FRONTAGE;
const V57 = SIM_VERSION_V57_ROUTED_DOORWARD;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/** The enemy colony's starting door on every seed below. */
const DOOR = { x: 104, y: 64 } as const;

/**
 * A quiet world: no spider, no AI, colony `colonyId`'s pool holding `food` fp,
 * and a 0:0 behaviour ratio so step 10a leaves the walker on its task.
 */
function quietWorld(seed: number, version: number, colonyId: number, food = 2000): WorldState {
  const world = createScenario(seed, 'Normal');
  world.simVersion = version;
  world.spider = null;
  world.aiState = [];
  const colony = world.colonies[colonyId]!;
  setPoolFoodForTest(world, colony, food);
  colony.targetRatio.forage = 0;
  colony.targetRatio.fight = 0;
  return world;
}

/** An ant of `colonyId` on the surface at (x, y), `sinceMeal` ticks after its last meal. */
function addAnt(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  task: number,
  sinceMeal: number,
): number {
  const colony = world.colonies[colonyId]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: center(x),
    posY: center(y),
    task,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Surface,
    lastMealTick: world.tick - sinceMeal,
  });
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

/** Rally the colony on its own open entrance at (x, y): a tunnel defence (V44). */
function defendDoor(world: WorldState, colonyId: number, x: number, y: number): void {
  world.colonies[colonyId]!.rallyPoint = { tileX: x, tileY: y };
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

interface Walk {
  /** Tick it went below ground (-1: never). */
  downAt: number;
  /** Column it went down (-1: never). */
  downColumn: number;
  /** Surface tiles, sampled every tick until it went down. */
  tiles: string[];
}

/** Tick `world` up to `ticks` times until ant `id` is below ground. */
function walkDown(world: WorldState, id: number, ticks: number, task: number): Walk {
  const tiles: string[] = [];
  for (let t = 0; t < ticks; t++) {
    tick(world, []);
    expect(world.ants.alive[id]).toBe(1);
    expect(world.ants.task[id]).toBe(task);
    if (world.ants.zone[id] === Zone.Underground) {
      return { downAt: t, downColumn: world.ants.posX[id]! >> FP_SHIFT, tiles };
    }
    const p = tileOf(world, id);
    tiles.push(`${p.x},${p.y}`);
  }
  return { downAt: -1, downColumn: -1, tiles };
}

/**
 * Seed 7: an obstacle at x103–108, y58–60 between the enemy door (104,64) and
 * (104,56), 8 tiles north of it: a fighter there is AT HOME (antIsAtHome), so a
 * hungry one does not take the D11 walk home.
 */
const HOME_SEED = 7;
const HOME_FROM = { x: 104, y: 56 } as const;

/**
 * Seed 488 (#343's map): an obstacle at x103–106, y51–54 north of the enemy door.
 * A walker at (104,48), due north of it and out of home range, runs into it.
 */
const FAR_SEED = 488;
const FAR_FROM = { x: 104, y: 48 } as const;

/**
 * Seed 1: a DesignateEntrance at (108,50) is accepted (closed until dug), with an
 * obstacle at x107–110, y41–44 between it and a digger at (108,40). That digger is
 * nearer the closed entrance than the open door, so the closed one is its target.
 */
const DIG_SEED = 1;
const DIG_FROM = { x: 108, y: 40 } as const;
const DIG_DOOR = { x: 108, y: 50 } as const;

describe('V57 (#357, #358)', () => {
  it('LATEST is V57 or later', () => {
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V57_ROUTED_DOORWARD);
  });
});

describe('fixtures', () => {
  it('seed 7: the obstacle stands between HOME_FROM and the door, inside home range', () => {
    const world = quietWorld(HOME_SEED, V57, ENEMY_COLONY_ID);
    const door = world.colonies[ENEMY_COLONY_ID]!.entrances[0]!;
    expect({ x: door.surfaceTileX, y: door.surfaceTileY, open: door.isOpen }).toEqual({
      ...DOOR,
      open: true,
    });
    expect(canEnterSurfaceTile(world, HOME_FROM.x, HOME_FROM.y)).toBe(true);
    expectBlocked(world, 103, 108, 58, 60);
    expect(manhattan(HOME_FROM, DOOR)).toBeLessThanOrEqual(HOME_EAT_RADIUS_TILES);
  });

  it('seed 488: the obstacle stands between FAR_FROM and the door, out of home range', () => {
    const world = quietWorld(FAR_SEED, V57, ENEMY_COLONY_ID);
    expect(canEnterSurfaceTile(world, FAR_FROM.x, FAR_FROM.y)).toBe(true);
    expectBlocked(world, 103, 106, 51, 54);
    expect(manhattan(FAR_FROM, DOOR)).toBeGreaterThan(HOME_EAT_RADIUS_TILES);
  });

  it('seed 1: the closed entrance is accepted, nearer the digger than the door, behind the obstacle', () => {
    const world = digWorld(V57);
    const ents = world.colonies[ENEMY_COLONY_ID]!.entrances;
    expect(ents.map((e) => [e.surfaceTileX, e.surfaceTileY, e.isOpen])).toEqual([
      [DOOR.x, DOOR.y, true],
      [DIG_DOOR.x, DIG_DOOR.y, false],
    ]);
    expect(canEnterSurfaceTile(world, DIG_FROM.x, DIG_FROM.y)).toBe(true);
    expectBlocked(world, 107, 110, 41, 44);
    expect(manhattan(DIG_FROM, DIG_DOOR)).toBeLessThan(manhattan(DIG_FROM, DOOR));
  });
});

describe('#357 (V57) — a tunnel-defence fighter behind an obstacle gets to its door', () => {
  /**
   * A hungry defender at HOME_FROM, its colony's stores empty (below the queen's
   * reserve), so it stays hungry and at home: step 10c keeps it on its ordinary
   * rally routing, to the defended door.
   */
  function hungryAtHome(version: number): { walk: Walk; world: WorldState; id: number } {
    const world = quietWorld(HOME_SEED, version, ENEMY_COLONY_ID, 0);
    defendDoor(world, ENEMY_COLONY_ID, DOOR.x, DOOR.y);
    const id = addAnt(
      world,
      ENEMY_COLONY_ID,
      HOME_FROM.x,
      HOME_FROM.y,
      AntTask.Fighting,
      FIGHTER_WALK_HOME_HUNGER_TICKS,
    );
    // The premise: hungry and at home, so the D11 walk home does not fire.
    expect(fighterIsHungry(world, id)).toBe(true);
    expect(antIsAtHome(world, id)).toBe(true);
    return { walk: walkDown(world, id, 300, AntTask.Fighting), world, id };
  }

  it('V56: a hungry one at home is pinned against the obstacle (the bug)', () => {
    const { walk, world, id } = hungryAtHome(V56);
    expect(walk.downAt).toBe(-1);
    expect(fighterIsHungry(world, id)).toBe(true);
    expect(antIsAtHome(world, id)).toBe(true);
  });

  it('V57: a hungry one at home walks round it and goes down to defend', () => {
    const { walk, world, id } = hungryAtHome(V57);
    expect(walk.downAt).toBeGreaterThanOrEqual(0);
    expect(walk.downColumn).toBe(DOOR.x);
    expectNoRevisit(walk.tiles);
    tick(world, []);
    expect(fighterDefendsTunnels(world, id)).toBe(true);
  });

  /** A fed defender at FAR_FROM (out of home range). */
  function fedFromFar(version: number, extraDoor?: { x: number; y: number }): Walk {
    const world = quietWorld(FAR_SEED, version, ENEMY_COLONY_ID);
    if (extraDoor !== undefined) addOpenEntrance(world, ENEMY_COLONY_ID, extraDoor.x, extraDoor.y);
    defendDoor(world, ENEMY_COLONY_ID, DOOR.x, DOOR.y);
    const id = addAnt(world, ENEMY_COLONY_ID, FAR_FROM.x, FAR_FROM.y, AntTask.Fighting, 0);
    return walkDown(world, id, 300, AntTask.Fighting);
  }

  it('V56: a fed one is pinned against the obstacle (the bug)', () => {
    expect(fedFromFar(V56).downAt).toBe(-1);
  });

  it('V57: a fed one walks round it and goes down its door, never stepping back onto a tile it left', () => {
    const walk = fedFromFar(V57);
    expect(walk.downAt).toBeGreaterThanOrEqual(0);
    expect(walk.downColumn).toBe(DOOR.x);
    expectNoRevisit(walk.tiles);
  });

  it('V57: with a nearer open entrance of its own, it still goes to the one it defends', () => {
    // A second open door at (100,46), a few tiles from FAR_FROM: the entrance flow
    // field leads there, but a defender may go down only the defended shaft.
    const extra = { x: 100, y: 46 };
    expect(manhattan(FAR_FROM, extra)).toBeLessThan(manhattan(FAR_FROM, DOOR));
    const walk = fedFromFar(V57, extra);
    expect(walk.downAt).toBeGreaterThanOrEqual(0);
    expect(walk.downColumn).toBe(DOOR.x);
    expectNoRevisit(walk.tiles);
  });
});

/** Mark colony `colonyId`'s entrance at (x, y) open, its top shaft tiles dug. */
function addOpenEntrance(world: WorldState, colonyId: number, x: number, y: number): void {
  const colony = world.colonies[colonyId]!;
  colony.entrances.push({
    entranceId: allocateEntityId(world),
    surfaceTileX: x,
    surfaceTileY: y,
    isOpen: true,
  });
  const grid = world.undergroundGrids[colonyId]!;
  for (let sy = 0; sy < 4; sy++) ugSet(grid, x, sy, UndergroundTileState.Open);
}

/** Seed 1 with DIG_DOOR designated through the real command (tick 0). */
function digWorld(version: number): WorldState {
  const world = quietWorld(DIG_SEED, version, ENEMY_COLONY_ID);
  tick(world, [
    {
      type: 'DesignateEntrance',
      colonyId: ENEMY_COLONY_ID,
      surfaceTileX: DIG_DOOR.x,
      surfaceTileY: DIG_DOOR.y,
      issuedAtTick: 0,
    },
  ]);
  return world;
}

describe('#358 (V57) — a surface digger behind an obstacle gets to its entrance', () => {
  function digToClosed(version: number): Walk {
    const world = digWorld(version);
    const id = addAnt(world, ENEMY_COLONY_ID, DIG_FROM.x, DIG_FROM.y, AntTask.Digging, 0);
    const walk = walkDown(world, id, 300, AntTask.Digging);
    // Still designated, not yet dug through, when it went down (or at the end).
    expect(world.colonies[ENEMY_COLONY_ID]!.entrances[1]!.isOpen).toBe(false);
    return walk;
  }

  it('V56: pinned against the obstacle on the way to a closed entrance (the bug)', () => {
    expect(digToClosed(V56).downAt).toBe(-1);
  });

  it('V57: walks round it and goes down the closed entrance, never stepping back onto a tile it left', () => {
    const walk = digToClosed(V57);
    expect(walk.downAt).toBeGreaterThanOrEqual(0);
    expect(walk.downColumn).toBe(DIG_DOOR.x);
    expectNoRevisit(walk.tiles);
  });

  /**
   * Seed 9: a DesignateEntrance at (115,75), 10 tiles due south of a digger at
   * (115,65) by Manhattan (the open door is 12), but walled off from it: farther
   * by path than the door. At V57 the digger picks the entrance nearest by
   * PATH, the one its goal-field walk actually shortens every step.
   */
  function digPathNearest(version: number): Walk {
    const world = quietWorld(9, version, ENEMY_COLONY_ID);
    tick(world, [
      {
        type: 'DesignateEntrance',
        colonyId: ENEMY_COLONY_ID,
        surfaceTileX: 115,
        surfaceTileY: 75,
        issuedAtTick: 0,
      },
    ]);
    const ents = world.colonies[ENEMY_COLONY_ID]!.entrances;
    expect(ents.map((e) => [e.surfaceTileX, e.surfaceTileY, e.isOpen])).toEqual([
      [DOOR.x, DOOR.y, true],
      [115, 75, false],
    ]);
    const from = { x: 115, y: 65 };
    expect(manhattan(from, { x: 115, y: 75 })).toBeLessThan(manhattan(from, DOOR));
    expect(surfaceGoalDistance(world, from.x, from.y, 115, 75)).toBeGreaterThan(
      surfaceGoalDistance(world, from.x, from.y, DOOR.x, DOOR.y),
    );
    const id = addAnt(world, ENEMY_COLONY_ID, from.x, from.y, AntTask.Digging, 0);
    return walkDown(world, id, 300, AntTask.Digging);
  }

  it('V56: pinned on the way to the Manhattan-nearest entrance (the bug)', () => {
    expect(digPathNearest(V56).downAt).toBe(-1);
  });

  it('V57: heads for the entrance nearest by path and goes down it, never doubling back', () => {
    const walk = digPathNearest(V57);
    expect(walk.downAt).toBeGreaterThanOrEqual(0);
    expect(walk.downColumn).toBe(DOOR.x);
    // Path distance to the door (12) falls every tile, so at most 12 distinct tiles.
    expect(new Set(walk.tiles).size).toBeLessThanOrEqual(12);
    expectNoRevisit(walk.tiles);
  });

  function digToOpen(version: number): Walk {
    const world = quietWorld(FAR_SEED, version, ENEMY_COLONY_ID);
    const id = addAnt(world, ENEMY_COLONY_ID, FAR_FROM.x, FAR_FROM.y, AntTask.Digging, 0);
    return walkDown(world, id, 300, AntTask.Digging);
  }

  it('an open entrance target too: pinned at V56, round the obstacle and down at V57', () => {
    expect(digToOpen(V56).downAt).toBe(-1);
    const walk = digToOpen(V57);
    expect(walk.downAt).toBeGreaterThanOrEqual(0);
    expect(walk.downColumn).toBe(DOOR.x);
    expectNoRevisit(walk.tiles);
  });
});
