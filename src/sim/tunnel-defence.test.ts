// V44 (#325) — a rally on the colony's own open entrance: fighters go down and
// defend the nest from inside. Targeting (step 10c) is pinned directly through
// updateFightAntTargets on a hand-dug nest; the zone rules through tick().
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId, createWorldState } from './types.js';
import type { WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { updateFightAntTargets } from './ant/ant-system.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyRecord } from './colony/colony-store.js';
import { getScratch } from './scratch.js';
import { AntTask, ForagingSubState } from './enums.js';
import { Zone, UndergroundTileState, ugSet, createUndergroundGrid } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  ENTRANCE_SHAFT_DEPTH,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Targeting on a hand-dug nest: a shaft at column SHAFT_X (rows 0..SHAFT_FOOT)
// and a tunnel east along row SHAFT_FOOT to column TUNNEL_END.
// ---------------------------------------------------------------------------

const COLONY = 1;
const ENEMY = 2;
const SHAFT_X = 5;
const SHAFT_FOOT = ENTRANCE_SHAFT_DEPTH; // the shaft's top rows and its foot stay clear
const TUNNEL_END = 14;
const SURFACE_Y = 30;

function nestWorld(): {
  world: WorldState;
  colony: ColonyRecord;
} {
  const world = createWorldState(42, 64);
  const colony = createColonyRecord(COLONY, -1);
  colony.entrances = [
    { entranceId: 1, surfaceTileX: SHAFT_X, surfaceTileY: SURFACE_Y, isOpen: true },
  ];
  colony.rallyPoint = { tileX: SHAFT_X, tileY: SURFACE_Y };
  colony.digFlowFieldDirty = false;
  world.colonies[COLONY] = colony;
  const grid = createUndergroundGrid(20, 20);
  for (let y = 0; y <= SHAFT_FOOT; y++) ugSet(grid, SHAFT_X, y, UndergroundTileState.Open);
  for (let x = SHAFT_X; x <= TUNNEL_END; x++) ugSet(grid, x, SHAFT_FOOT, UndergroundTileState.Open);
  world.undergroundGrids[COLONY] = grid;
  return { world, colony };
}

function addFighter(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number = Zone.Underground,
  grid: number = colonyId,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: 0,
  });
  world.ants.zone[id] = zone;
  world.ants.currentGridColonyId[id] = grid;
  world.colonies[colonyId]?.workers.push(id);
  return id;
}

const targetTile = (world: WorldState, id: number): [number, number] => [
  world.ants.targetPosX[id]! >> FP_SHIFT,
  world.ants.targetPosY[id]! >> FP_SHIFT,
];

describe('V44 (#325) — tunnel defenders: targeting', () => {
  it('a defender below with no invader walks to the first tunnel post, off the shaft', () => {
    const { world, colony } = nestWorld();
    const id = addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([SHAFT_X + 1, SHAFT_FOOT]);
  });

  it('defenders spread one per post along the first tunnel', () => {
    const { world, colony } = nestWorld();
    const ids = [0, 1, 2].map(() => addFighter(world, colony.colonyId, SHAFT_X, 0));
    updateFightAntTargets(world);
    expect(ids.map((id) => targetTile(world, id))).toEqual([
      [SHAFT_X + 1, SHAFT_FOOT],
      [SHAFT_X + 2, SHAFT_FOOT],
      [SHAFT_X + 3, SHAFT_FOOT],
    ]);
  });

  it('ranks count the colony fighters still on the surface, so posts do not reshuffle as they come down', () => {
    const { world, colony } = nestWorld();
    addFighter(world, colony.colonyId, SHAFT_X, SURFACE_Y + 2, Zone.Surface); // lowest id, still outside
    const below = addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    expect(targetTile(world, below)).toEqual([SHAFT_X + 2, SHAFT_FOOT]);
  });

  it('builds the same posts on every pass', () => {
    const { world, colony } = nestWorld();
    const id = addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    const first = targetTile(world, id);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual(first);
    expect(first).toEqual([SHAFT_X + 1, SHAFT_FOOT]);
  });

  it('leaves the shared invader-BFS distance buffer untouched (every cell -1)', () => {
    const { world, colony } = nestWorld();
    addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    expect(getScratch(world).antTargeting.invBfsDist.every((v) => v === -1)).toBe(true);
  });

  it('a defender on its post holds, and is not flagged as moving; one walking to it is', () => {
    const { world, colony } = nestWorld();
    const holder = addFighter(world, colony.colonyId, SHAFT_X + 1, SHAFT_FOOT);
    const walker = addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[holder]).toBe(-1);
    expect(targetTile(world, walker)).toEqual([SHAFT_X + 2, SHAFT_FOOT]);
    const moving = getScratch(world).antTargeting.sentryMoving;
    expect(moving[holder]).toBe(0);
    expect(moving[walker]).toBe(1);
  });

  it('goes after an invader anywhere in the nest, however far', () => {
    const { world, colony } = nestWorld();
    world.colonies[ENEMY] = createColonyRecord(ENEMY, -1);
    const id = addFighter(world, colony.colonyId, SHAFT_X + 1, SHAFT_FOOT);
    const invader = addFighter(world, ENEMY, TUNNEL_END, SHAFT_FOOT, Zone.Underground, COLONY);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([TUNNEL_END, SHAFT_FOOT]);
    expect(getScratch(world).antTargeting.sentryMoving[id]).toBe(0); // chasing is not passing through
    expect(world.ants.alive[invader]).toBe(1);
  });

  it('ignores an invader it cannot reach and holds its post; takes a reachable one even if farther', () => {
    const { world, colony } = nestWorld();
    world.colonies[ENEMY] = createColonyRecord(ENEMY, -1);
    const grid = world.undergroundGrids[COLONY]!;
    ugSet(grid, SHAFT_X + 1, SHAFT_FOOT + 3, UndergroundTileState.Open); // a pocket joined to nothing
    const id = addFighter(world, colony.colonyId, SHAFT_X + 1, SHAFT_FOOT); // on its post
    addFighter(world, ENEMY, SHAFT_X + 1, SHAFT_FOOT + 3, Zone.Underground, COLONY);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
    addFighter(world, ENEMY, TUNNEL_END, SHAFT_FOOT, Zone.Underground, COLONY);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([TUNNEL_END, SHAFT_FOOT]);
  });

  it("keeps the top of every own entrance's shaft clear of posts, not just the defended one's", () => {
    const { world, colony } = nestWorld();
    const otherX = SHAFT_X + 2; // a second own open entrance, its shaft joined to the tunnel
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: otherX,
      surfaceTileY: SURFACE_Y,
      isOpen: true,
    });
    for (let y = 0; y < SHAFT_FOOT; y++) {
      ugSet(world.undergroundGrids[COLONY]!, otherX, y, UndergroundTileState.Open);
    }
    const ids = [0, 1, 2].map(() => addFighter(world, colony.colonyId, SHAFT_X, 0));
    updateFightAntTargets(world);
    expect(ids.map((id) => targetTile(world, id))).toEqual([
      [SHAFT_X + 1, SHAFT_FOOT],
      [SHAFT_X + 3, SHAFT_FOOT],
      [SHAFT_X + 4, SHAFT_FOOT],
    ]);
  });

  it('spider priority overrides it: the fighter below is routed up to the rally tile, not to a post', () => {
    const { world, colony } = nestWorld();
    world.spiderPriorityColonyId = COLONY;
    const id = addFighter(world, colony.colonyId, SHAFT_X + 1, SHAFT_FOOT);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([SHAFT_X, SURFACE_Y]);
  });

  it('of two invaders at the same distance, goes after the lower id', () => {
    const { world, colony } = nestWorld();
    world.colonies[ENEMY] = createColonyRecord(ENEMY, -1);
    const id = addFighter(world, colony.colonyId, SHAFT_X + 3, SHAFT_FOOT);
    addFighter(world, ENEMY, SHAFT_X + 5, SHAFT_FOOT, Zone.Underground, COLONY); // lower id, east
    addFighter(world, ENEMY, SHAFT_X + 1, SHAFT_FOOT, Zone.Underground, COLONY); // west
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([SHAFT_X + 5, SHAFT_FOOT]);
  });

  it("a closed entrance's column is not kept clear: only open shafts are ways in and out", () => {
    const { world, colony } = nestWorld();
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: SHAFT_X + 2,
      surfaceTileY: SURFACE_Y,
      isOpen: false,
    });
    const ids = [0, 1, 2].map(() => addFighter(world, colony.colonyId, SHAFT_X, 0));
    updateFightAntTargets(world);
    expect(targetTile(world, ids[1]!)).toEqual([SHAFT_X + 2, SHAFT_FOOT]);
  });

  it('rebuilds the post list each pass: more defenders get more posts, not stale ones', () => {
    const { world, colony } = nestWorld();
    addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    const more = [0, 1].map(() => addFighter(world, colony.colonyId, SHAFT_X, 0));
    updateFightAntTargets(world);
    expect(more.map((id) => targetTile(world, id))).toEqual([
      [SHAFT_X + 2, SHAFT_FOOT],
      [SHAFT_X + 3, SHAFT_FOOT],
    ]);
  });

  it('with only the shaft dug there is no post: it holds where it is', () => {
    const { world, colony } = nestWorld();
    for (let x = SHAFT_X + 1; x <= TUNNEL_END; x++) {
      ugSet(world.undergroundGrids[COLONY]!, x, SHAFT_FOOT, UndergroundTileState.Solid);
    }
    const id = addFighter(world, colony.colonyId, SHAFT_X, 0);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.targetPosY[id]).toBe(-1);
  });

  it('a rally anywhere else, or on a closed own entrance, is not tunnel defence: routed up to the entrance', () => {
    for (const setRally of [
      (c: ColonyRecord) => {
        c.rallyPoint = { tileX: SHAFT_X + 8, tileY: SURFACE_Y };
      },
      (c: ColonyRecord) => {
        c.entrances[0]!.isOpen = false;
      },
    ]) {
      const { world, colony } = nestWorld();
      setRally(colony);
      const id = addFighter(world, colony.colonyId, SHAFT_X + 1, SHAFT_FOOT);
      updateFightAntTargets(world);
      expect(targetTile(world, id)).toEqual([SHAFT_X, SURFACE_Y]);
    }
  });
});

// ---------------------------------------------------------------------------
// Through tick(): the scenario's own nest (early game: just the entrance shaft).
// ---------------------------------------------------------------------------

function rallyOnOwnEntrance(n: number): {
  world: WorldState;
  colony: ColonyRecord;
  ids: number[];
  ent: { x: number; y: number };
} {
  const world = createScenario(7, 'Normal');
  world.spider = null;
  world.aiState = [];
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const e = colony.entrances.find((en) => en.isOpen)!;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: ((e.surfaceTileX + 2) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    ids.push(id);
  }
  colony.targetRatio.fight = Math.max(5, n);
  colony.rallyPoint = { tileX: e.surfaceTileX, tileY: e.surfaceTileY };
  return { world, colony, ids, ent: { x: e.surfaceTileX, y: e.surfaceTileY } };
}

function zoneFlips(world: WorldState, ids: readonly number[], ticks: number): number {
  let flips = 0;
  const last = ids.map((id) => world.ants.zone[id]!);
  for (let t = 0; t < ticks; t++) {
    tick(world, []);
    ids.forEach((id, k) => {
      const z = world.ants.zone[id]!;
      if (z !== last[k]) flips += 1;
      last[k] = z;
    });
  }
  return flips;
}

describe('V44 (#325) — tunnel defenders: going in and coming out', () => {
  it('V44: they go down once and stay below', () => {
    const { world, ids } = rallyOnOwnEntrance(3);
    expect(zoneFlips(world, ids, 60)).toBe(3);
    expect(ids.every((id) => world.ants.zone[id] === Zone.Underground)).toBe(true);
    expect(zoneFlips(world, ids, 100)).toBe(0);
  });

  it('they fight an invader that comes down their shaft, and stay below doing it', () => {
    const { world, ids, ent } = rallyOnOwnEntrance(3);
    zoneFlips(world, ids, 60);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    enemy.rallyPoint = { tileX: ent.x, tileY: ent.y }; // it is invading, not recalled
    const invader = allocateEntityId(world);
    initAnt(world.ants, invader, {
      colonyId: ENEMY_COLONY_ID,
      posX: (ent.x << FP_SHIFT) + (FP_ONE >> 1),
      posY: (1 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Underground,
    });
    world.ants.currentGridColonyId[invader] = PLAYER_COLONY_ID;
    enemy.workers.push(invader);
    enemy.workerCount += 1;
    let flips = 0;
    const last = ids.map((id) => world.ants.zone[id]!);
    for (let t = 0; t < 200 && world.ants.alive[invader] === 1; t++) {
      tick(world, []);
      ids.forEach((id, k) => {
        if (world.ants.alive[id] === 1 && world.ants.zone[id] !== last[k]) flips += 1;
        last[k] = world.ants.zone[id]!;
      });
    }
    expect(world.ants.alive[invader]).toBe(0);
    expect(flips).toBe(0);
  });

  it('in a one-tile tunnel with a bend, every defender reaches its own post and holds', () => {
    const { world, colony, ids, ent } = rallyOnOwnEntrance(10);
    // Dig down from the shaft to row 3, east to column +4, down to row 6, east to +10.
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    const dig = (x: number, y: number): void => ugSet(grid, x, y, UndergroundTileState.Open);
    for (let y = 0; y <= 3; y++) dig(ent.x, y);
    for (let x = ent.x; x <= ent.x + 4; x++) dig(x, 3);
    for (let y = 3; y <= 6; y++) dig(ent.x + 4, y);
    for (let x = ent.x + 4; x <= ent.x + 10; x++) dig(x, 6);
    colony.digFlowFieldDirty = true;
    zoneFlips(world, ids, 300);
    // Settled: every defender below, each on its own tile, holding, no longer moving.
    const tiles = new Set(
      ids.map((id) => `${world.ants.posX[id]! >> FP_SHIFT},${world.ants.posY[id]! >> FP_SHIFT}`),
    );
    expect(ids.every((id) => world.ants.zone[id] === Zone.Underground)).toBe(true);
    expect(tiles.size).toBe(ids.length);
    expect(ids.filter((id) => world.ants.targetPosX[id] !== -1)).toEqual([]);
    // Past the bend too: the tenth post is on the lower tunnel.
    expect(ids.some((id) => world.ants.posY[id]! >> FP_SHIFT === 6)).toBe(true);
    expect(zoneFlips(world, ids, 40)).toBe(0);
  }, 30_000);

  it('they find their way to an invader that stays put in a pocket off their tunnels, and kill it', () => {
    const { world, colony, ids, ent } = rallyOnOwnEntrance(6);
    // Down to row 3, east to +4, down to row 10, west to -6, then back UP into a
    // pocket at row 8, where the invader sits: the way to it first goes deeper
    // than it, so steering straight at it stalls against the rock at row 8.
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    const dig = (x: number, y: number): void => ugSet(grid, x, y, UndergroundTileState.Open);
    for (let y = 0; y <= 3; y++) dig(ent.x, y);
    for (let x = ent.x; x <= ent.x + 4; x++) dig(x, 3);
    for (let y = 3; y <= 10; y++) dig(ent.x + 4, y);
    for (let x = ent.x - 6; x <= ent.x + 4; x++) dig(x, 10);
    for (let y = 8; y <= 10; y++) dig(ent.x - 6, y);
    colony.digFlowFieldDirty = true;
    zoneFlips(world, ids, 200);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    enemy.rallyPoint = { tileX: ent.x, tileY: ent.y };
    const invader = allocateEntityId(world);
    initAnt(world.ants, invader, {
      colonyId: ENEMY_COLONY_ID,
      posX: ((ent.x - 6) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (8 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: 0,
      speed: 0, // it stays put: the defenders must find their way to it
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Underground,
    });
    world.ants.currentGridColonyId[invader] = PLAYER_COLONY_ID;
    enemy.workers.push(invader);
    enemy.workerCount += 1;
    for (let t = 0; t < 300 && world.ants.alive[invader] === 1; t++) tick(world, []);
    expect(world.ants.alive[invader]).toBe(0);
  }, 30_000);

  it('a worker below gets past defenders holding posts in a one-tile tunnel', () => {
    const { world, colony, ids, ent } = rallyOnOwnEntrance(6);
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    for (let y = 0; y <= 3; y++) ugSet(grid, ent.x, y, UndergroundTileState.Open);
    for (let x = ent.x; x <= ent.x + 10; x++) ugSet(grid, x, 3, UndergroundTileState.Open);
    colony.digFlowFieldDirty = true;
    zoneFlips(world, ids, 200); // the defenders hold the first six tiles of the tunnel
    // A forager at the far end (a higher id than every defender) heads out.
    const forager = allocateEntityId(world);
    initAnt(world.ants, forager, {
      colonyId: PLAYER_COLONY_ID,
      posX: ((ent.x + 10) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (3 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Underground,
    });
    colony.workers.push(forager);
    colony.workerCount += 1;
    colony.targetRatio.forage = 5;
    let outAt = -1;
    for (let t = 0; t < 150 && outAt < 0; t++) {
      tick(world, []);
      if (world.ants.zone[forager] === Zone.Surface) outAt = t;
    }
    expect(outAt).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('spider priority brings defenders out to fight it', () => {
    const { world, ids, ent } = rallyOnOwnEntrance(3);
    zoneFlips(world, ids, 60);
    // A spider far off (priority lasts while it lives), and the order to attack it.
    const spider = createScenario(7, 'Normal').spider!;
    spider.posX = ((ent.x + 40) << FP_SHIFT) + (FP_ONE >> 1);
    spider.posY = (ent.y << FP_SHIFT) + (FP_ONE >> 1);
    world.spider = spider;
    world.spiderPriorityColonyId = PLAYER_COLONY_ID;
    zoneFlips(world, ids, 20);
    expect(world.spiderPriorityColonyId).toBe(PLAYER_COLONY_ID);
    expect(ids.filter((id) => world.ants.zone[id] === Zone.Surface)).toEqual(ids);
  });

  it('fighters below a second entrance not joined to the nest come out and round when the rally moves to the first', () => {
    const { world, colony, ids, ent } = rallyOnOwnEntrance(4);
    // Entrance B, 8 east: a fresh 2-deep shaft, joined to nothing.
    const bx = ent.x + 8;
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    for (let y = 0; y < ENTRANCE_SHAFT_DEPTH; y++) ugSet(grid, bx, y, UndergroundTileState.Open);
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: bx,
      surfaceTileY: ent.y,
      isOpen: true,
    });
    colony.digFlowFieldDirty = true;
    colony.rallyPoint = { tileX: bx, tileY: ent.y };
    zoneFlips(world, ids, 150); // they go down B
    expect(ids.every((id) => world.ants.zone[id] === Zone.Underground)).toBe(true);
    expect(ids.every((id) => world.ants.posX[id]! >> FP_SHIFT === bx)).toBe(true);
    colony.rallyPoint = { tileX: ent.x, tileY: ent.y };
    zoneFlips(world, ids, 300);
    // Every one climbed out of B, walked to A and went down it.
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(world.ants.posX[id]! >> FP_SHIFT).toBe(ent.x);
    }
  }, 30_000);

  it('both colonies defending their own nests at once each stay below', () => {
    const { world, ids } = rallyOnOwnEntrance(3);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const ee = enemy.entrances.find((en) => en.isOpen)!;
    const theirs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: ENEMY_COLONY_ID,
        posX: ((ee.surfaceTileX + 2) << FP_SHIFT) + (FP_ONE >> 1),
        posY: (ee.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Fighting,
        subTask: 0,
        speed: WORKER_BASE_SPEED,
        lifespan: WORKER_LIFESPAN_TICKS,
        zone: Zone.Surface,
      });
      enemy.workers.push(id);
      enemy.workerCount += 1;
      theirs.push(id);
    }
    enemy.targetRatio.fight = 5;
    enemy.rallyPoint = { tileX: ee.surfaceTileX, tileY: ee.surfaceTileY };
    const all = [...ids, ...theirs];
    zoneFlips(world, all, 100);
    expect(all.every((id) => world.ants.zone[id] === Zone.Underground)).toBe(true);
    expect(zoneFlips(world, all, 60)).toBe(0);
  });

  it('clearing the rally brings them back out', () => {
    const { world, colony, ids } = rallyOnOwnEntrance(3);
    zoneFlips(world, ids, 60);
    colony.rallyPoint = null;
    zoneFlips(world, ids, 60);
    expect(ids.filter((id) => world.ants.zone[id] === Zone.Surface)).toEqual(ids);
  });

  it('moving the rally elsewhere brings them out and to it', () => {
    const { world, colony, ids, ent } = rallyOnOwnEntrance(3);
    zoneFlips(world, ids, 60);
    colony.rallyPoint = { tileX: ent.x + 8, tileY: ent.y + 3 };
    zoneFlips(world, ids, 200);
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      const d =
        Math.abs((world.ants.posX[id]! >> FP_SHIFT) - (ent.x + 8)) +
        Math.abs((world.ants.posY[id]! >> FP_SHIFT) - (ent.y + 3));
      expect(d).toBeLessThanOrEqual(3);
    }
  });
});
