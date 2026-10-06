// invader-retarget.test.ts — #364 (V59): invaders piling on one defender go for
// the next reachable enemy.
//
// Combat fights one pair per tile per tick (the lowest-id ant of each colony on
// it). A tile is SATURATED for a fighter when its colony already holds the fight
// there (tileSaturatedFor: its own tile when a lower-id friend stands on it too,
// any other tile when any friend does). From V59 an invader on the hunt steps
// toward the nearest hostile BY PATH on a tile not saturated for it
// (invaderHuntStep), and a raider's reach check ignores hostiles on saturated
// tiles.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId, type WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import {
  NO_FREE_HOSTILE,
  fighterMayLoot,
  invaderHuntStep,
  pickInvaderUndergroundStep,
  unpackStepDx,
  unpackStepDy,
} from './ant/ant-system.js';
// The saturation rule's reference form is a Layer-0 primitive with no production
// consumer outside the ant modules, so it is not on the barrel's public surface.
import { tileSaturatedFor } from './ant/ant-motion.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone, ugSet, UndergroundTileState } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { getScratch } from './scratch.js';
import { copyWorldState } from './types.js';
// eslint-disable-next-line no-restricted-imports -- the rollover/copy proofs compare the full serialized world (telemetry.test.ts:8 pattern)
import { serializeWorldState } from '../platform/save.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';
import {
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  RAID_START_CLEAR_RADIUS_TILES,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';
import {
  addEnemyWorker,
  addFighter as addRaidFighter,
  raidWorld,
  rallyOn,
} from './raid-test-utils.js';

/** Enough HP that no test duel ends. */
const UNKILLABLE_HP = 1_000_000;
/** The corridor's row in the enemy nest. */
const ROW = 6;

type Tile = { x: number; y: number };

/**
 * The fixture nest, mirrored by `dir` (+1: the corridor runs east of the shaft;
 * -1: west). Seed 7, no spider or AI; the enemy nest emptied of its ants (the
 * queen moved to the surface, far off), filled solid, then dug out as:
 *   - the shaft, (sx, 0..ROW);
 *   - a corridor along ROW, 12 tiles from the shaft;
 *   - a branch off it 3 along, down to ROW+3 and along to 8.
 * `at(k, dy)` is the tile k tiles along from the shaft, dy rows below ROW.
 * The player's rally is on the enemy entrance: its fighters there are invaders.
 */
function nest(dir: 1 | -1 = 1) {
  const world = createScenario(7, 'Normal');
  world.spider = null;
  world.aiState = [];
  setPoolFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 2000);
  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  expect(enemy.chambers.length).toBe(0); // no chamber footprint (occupancy-exempt) in play
  const ent = enemy.entrances.find((e) => e.isOpen)!;
  world.colonies[PLAYER_COLONY_ID]!.rallyPoint = {
    tileX: ent.surfaceTileX,
    tileY: ent.surfaceTileY,
  };
  for (let i = 0; i < world.ants.alive.length; i++) {
    if (world.ants.alive[i] !== 1 || world.ants.colonyId[i] !== ENEMY_COLONY_ID) continue;
    if (i === enemy.queenEntityId) continue;
    world.ants.alive[i] = 0; // test-only removal (workers and brood)
  }
  enemy.workers.length = 0;
  enemy.workerCount = 0;
  enemy.eggs.length = 0;
  enemy.larvae.length = 0;
  const q = enemy.queenEntityId;
  world.ants.zone[q] = Zone.Surface;
  world.ants.posX[q] = (120 << FP_SHIFT) + (FP_ONE >> 1);
  world.ants.posY[q] = (120 << FP_SHIFT) + (FP_ONE >> 1);
  const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
  grid.data.fill(UndergroundTileState.Solid);
  const sx = ent.surfaceTileX;
  const at = (k: number, dy = 0): Tile => ({ x: sx + k * dir, y: ROW + dy });
  const open = (t: Tile) => ugSet(grid, t.x, t.y, UndergroundTileState.Open);
  for (let y = 0; y <= ROW; y++) open({ x: sx, y });
  for (let k = 0; k <= 12; k++) open(at(k));
  for (let dy = 1; dy <= 3; dy++) open(at(3, dy));
  for (let k = 3; k <= 8; k++) open(at(k, 3));
  return { world, grid, sx, at, open };
}

/** A fed player fighter below ground in the enemy nest at `t`. */
function addInvader(world: WorldState, t: Tile): number {
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX: (t.x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (t.y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: FightingSubState.MovingToRally,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Underground,
    lastMealTick: world.tick,
  });
  world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
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

/** A stationary, unkillable enemy worker at `t` in its own nest. */
function addDefender(world: WorldState, t: Tile): number {
  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: ENEMY_COLONY_ID,
    posX: (t.x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (t.y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle,
    zone: Zone.Underground,
    speed: 0,
    lastMealTick: world.tick,
  });
  world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
  world.ants.hp[id] = UNKILLABLE_HP;
  enemy.workers.push(id);
  enemy.workerCount += 1;
  return id;
}

/** The hunt with no friend exempt from the occupancy pass (claimsNoTile false). */
function hunt(
  world: WorldState,
  id: number,
  claimsNoTile = (_w: WorldState, _id: number) => false,
) {
  return invaderHuntStep(world, id, ENEMY_COLONY_ID, claimsNoTile);
}

function stepOf(s: number): [number, number] {
  return [unpackStepDx(s), unpackStepDy(s)];
}

/** Defender A 4 along the corridor, B at the branch's end; invader `first` on A,
 *  `second` (a higher id) one short of A, where the branch leaves the corridor. */
function duelAtA(dir: 1 | -1 = 1) {
  const n = nest(dir);
  const a = n.at(4);
  const b = n.at(8, 3);
  const defA = addDefender(n.world, a);
  const defB = addDefender(n.world, b);
  const first = addInvader(n.world, a);
  const second = addInvader(n.world, n.at(3));
  return { ...n, a, b, defA, defB, first, second };
}

describe('#364 — saturated, concretely (tileSaturatedFor)', () => {
  it('its own tile: only a LOWER-id friend saturates it', () => {
    const { world, at } = nest();
    const t = at(5);
    const low = addInvader(world, t);
    const high = addInvader(world, t);
    expect(tileSaturatedFor(world, high, ENEMY_COLONY_ID, t.x, t.y)).toBe(true);
    expect(tileSaturatedFor(world, low, ENEMY_COLONY_ID, t.x, t.y)).toBe(false);
  });

  it('any other tile: ANY friend saturates it, lower id or higher', () => {
    const { world, at } = nest();
    const t = at(5);
    const low = addInvader(world, at(1));
    addInvader(world, t);
    const higher = addInvader(world, at(2));
    expect(tileSaturatedFor(world, low, ENEMY_COLONY_ID, t.x, t.y)).toBe(true);
    expect(tileSaturatedFor(world, higher, ENEMY_COLONY_ID, t.x, t.y)).toBe(true);
  });

  it('an enemy on the tile, or a friend in another nest or on the surface, does not', () => {
    const { world, at } = nest();
    const t = at(5);
    const me = addInvader(world, at(1));
    addDefender(world, t);
    expect(tileSaturatedFor(world, me, ENEMY_COLONY_ID, t.x, t.y)).toBe(false);
    const f = addInvader(world, t);
    world.ants.currentGridColonyId[f] = PLAYER_COLONY_ID;
    expect(tileSaturatedFor(world, me, ENEMY_COLONY_ID, t.x, t.y)).toBe(false);
    world.ants.currentGridColonyId[f] = ENEMY_COLONY_ID;
    world.ants.zone[f] = Zone.Surface;
    expect(tileSaturatedFor(world, me, ENEMY_COLONY_ID, t.x, t.y)).toBe(false);
    world.ants.zone[f] = Zone.Underground;
    expect(tileSaturatedFor(world, me, ENEMY_COLONY_ID, t.x, t.y)).toBe(true);
  });
});

describe('#364 — the hunt goes for the nearest FREE hostile by path (invaderHuntStep)', () => {
  for (const dir of [1, -1] as const) {
    it(`${dir > 0 ? 'east' : 'west'}: the second invader leaves the queue for the free defender, round the bend`, () => {
      const { world, second } = duelAtA(dir);
      // Its way to B leaves the corridor down the branch, then runs along: the
      // FIRST step is south.
      expect(stepOf(hunt(world, second))).toEqual([0, 1]);
    });
  }

  it('the invader in the duel holds: a free hostile shares its own tile', () => {
    const { world, first } = duelAtA();
    expect(stepOf(hunt(world, first))).toEqual([0, 0]);
  });

  it('a higher-id friend on its own tile does not unseat it: it holds its duel', () => {
    const { world, a, first } = duelAtA();
    addInvader(world, a);
    expect(stepOf(hunt(world, first))).toEqual([0, 0]);
  });

  it('on the duel tile behind a lower-id friend, it leaves for the free defender', () => {
    for (const dir of [1, -1] as const) {
      const { world, a, second } = duelAtA(dir);
      world.ants.posX[second] = (a.x << FP_SHIFT) + (FP_ONE >> 1);
      // Back one tile to the branch's mouth, then down it.
      expect(stepOf(hunt(world, second))).toEqual([-dir, 0]);
    }
  });

  it('a higher-id friend already fighting at B saturates B for it too: no free hostile', () => {
    const { world, b, second } = duelAtA();
    const later = addInvader(world, b);
    expect(later).toBeGreaterThan(second);
    // Every hostile saturated: it keeps its place in the queue beside A's duel.
    expect(stepOf(hunt(world, second))).toEqual([0, 0]);
  });

  it('a free hostile it cannot reach does not pull it off the queue', () => {
    const { world, at, grid, second } = duelAtA();
    const cut = at(3, 1);
    ugSet(grid, cut.x, cut.y, UndergroundTileState.Solid); // the branch cut off
    // B out of reach: it keeps its place in the queue beside A's duel.
    expect(stepOf(hunt(world, second))).toEqual([0, 0]);
  });

  /** duelAtA, but with a LOWER-id friend than `second` standing at the branch
   *  mouth, and a third defender past A, reachable only through A's tile. */
  function blockedMouth() {
    const n = nest();
    const a = n.at(4);
    addDefender(n.world, a);
    addDefender(n.world, n.at(8, 3));
    addDefender(n.world, n.at(10));
    const first = addInvader(n.world, a);
    const blocker = addInvader(n.world, n.at(3, 1));
    const second = addInvader(n.world, n.at(3));
    return { ...n, first, blocker, second };
  }

  it('with lower-id friends in every way to a free hostile, it holds its place', () => {
    const { world, second } = blockedMouth();
    // Through A's tile (first) or the branch mouth (blocker): both lower ids, which
    // the occupancy pass would keep, bumping it back.
    expect(stepOf(hunt(world, second))).toEqual([0, 0]);
  });

  it('a lower-id friend that claims no tile (passes through friends) does not block it', () => {
    const { world, blocker, second } = blockedMouth();
    expect(stepOf(hunt(world, second, (_w, o) => o === blocker))).toEqual([0, 1]);
  });

  it('a HIGHER-id friend in the way does not block it (that friend is the one bumped)', () => {
    const { world, at, second } = duelAtA();
    const later = addInvader(world, at(3, 1));
    expect(later).toBeGreaterThan(second);
    expect(stepOf(hunt(world, second))).toEqual([0, 1]);
  });

  it('routes through a lower-id friend tile where friends stack (the shaft top)', () => {
    const { world, sx, open, first, second } = duelAtA();
    // `second` moved to a stub beside the shaft top, whose only way on is the
    // shaft top itself; `first` (a lower id) moved there.
    open({ x: sx - 1, y: 0 });
    world.ants.posX[second] = ((sx - 1) << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[second] = FP_ONE >> 1;
    world.ants.posX[first] = (sx << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[first] = FP_ONE >> 1;
    expect(first).toBeLessThan(second);
    expect(stepOf(hunt(world, second))).toEqual([1, 0]);
  });

  it('picks the nearest free hostile BY PATH, not by Manhattan distance', () => {
    const { world, grid, at, open, second } = duelAtA();
    // A pocket 4 above `second` (Manhattan 4; B is Manhattan 8), reached only the
    // long way: back along the corridor to the shaft, up it, and along (path 10;
    // B's path is 8).
    const pocket = at(3, -4);
    for (let k = 0; k <= 3; k++) open(at(k, -4));
    addDefender(world, pocket);
    const toPocket = pickInvaderUndergroundStep(
      grid,
      at(3).x,
      at(3).y,
      pocket.x,
      pocket.y,
      getScratch(world),
    );
    // The pocket's way starts back toward the shaft; the hunt takes B's branch.
    expect(unpackStepDy(toPocket)).toBe(0);
    expect(unpackStepDx(toPocket)).not.toBe(0);
    expect(stepOf(hunt(world, second))).toEqual([0, 1]);
  });

  it('with every hostile saturated, it goes to the nearest queue BY PATH (one metric, not Manhattan)', () => {
    for (const dir of [1, -1] as const) {
      const { world, at, open } = nest(dir);
      // D at the corridor's far end, its duel held by a lower-id friend; a pocket
      // defender P 4 above the queue's mouth (Manhattan 4 from `me`; D is 9), P's
      // tile held by a higher-id friend, reached only the long way round (path 10;
      // D's queue is 8 along the corridor).
      const d = at(12);
      addDefender(world, d);
      const pocket = at(3, -4);
      for (let k = 0; k <= 3; k++) open(at(k, -4));
      addDefender(world, pocket);
      addInvader(world, d); // lower id than `me`
      const me = addInvader(world, at(3));
      addInvader(world, pocket); // higher id: saturates P for `me`, does not block
      expect(stepOf(hunt(world, me))).toEqual([dir, 0]); // along the corridor to D's queue
    }
  });

  it('a queue it can walk to: a saturated hostile whose friend is a higher id (no block)', () => {
    const { world, at } = nest();
    const b = at(8, 3);
    addDefender(world, b);
    const me = addInvader(world, at(3));
    addInvader(world, b); // higher id: saturates B for `me`, does not block
    expect(stepOf(hunt(world, me))).toEqual([0, 1]); // down the branch to B's queue
  });

  /** `me` at the branch mouth's corridor tile with a LOWER-id friend at the branch
   *  mouth, and D at the corridor's far end with its duel held by a lower-id friend
   *  (D's queue lies east, along the corridor). */
  function mouthHeld() {
    const n = nest();
    const d = n.at(12);
    addDefender(n.world, d);
    addInvader(n.world, d);
    const blocker = addInvader(n.world, n.at(3, 1));
    return { ...n, blocker };
  }

  it('a free hostile beyond its friends comes first: it holds rather than walk to a queue', () => {
    const { world, at } = mouthHeld();
    addDefender(world, at(8, 3)); // B, free, down the branch past the blocker
    const me = addInvader(world, at(3));
    expect(stepOf(hunt(world, me))).toEqual([0, 0]);
  });

  it('the same answer whatever the unsaved search-stamp counter holds (rollover included)', () => {
    const { world, at } = mouthHeld();
    addDefender(world, at(8, 3)); // B, free, down the branch past the blocker
    const me = addInvader(world, at(3));
    const rt = getScratch(world).antTargeting.retarget;
    expect(stepOf(hunt(world, me))).toEqual([0, 0]); // builds the buffers; holds
    // The counter only ever moves forward within an arena (a load or copyWorldState
    // drops the arena, buffers and all): jump it close to the limit once, then let
    // it climb through the rollover, two stamps a call.
    // Both parities of the gap to the limit: from max − 6 the third call lands on
    // (max − 1, max); from max − 5 the third call starts at max − 1 and must roll
    // over rather than overflow past max.
    for (const gap of [6, 5]) {
      rt.stamp = 0x7fffffff - gap;
      for (let k = 0; k < 6; k++) {
        // It holds (the walls-only search finds B past the blocker), never walks to
        // D's queue: that search must run at every counter value.
        expect(stepOf(hunt(world, me))).toEqual([0, 0]);
        expect(rt.stamp).toBeLessThanOrEqual(0x7fffffff);
      }
      expect(rt.stamp).toBeLessThan(0x7fffffff - 6); // it rolled over
    }
  });

  it('a free hostile walled off beyond its friends does not hold it: it walks to the queue', () => {
    const { world, grid, at } = mouthHeld();
    addDefender(world, at(8, 3));
    const cut = at(3, 2);
    ugSet(grid, cut.x, cut.y, UndergroundTileState.Solid); // B cut off below the blocker
    const me = addInvader(world, at(3));
    expect(stepOf(hunt(world, me))).toEqual([1, 0]); // east, to D's queue
  });

  it('hostiles only beyond its friends (no queue to walk to): it holds', () => {
    const { world, at } = mouthHeld();
    addInvader(world, at(4)); // a lower-id friend in the corridor too: D's queue is past it
    const me = addInvader(world, at(3));
    expect(stepOf(hunt(world, me))).toEqual([0, 0]);
  });

  it('neutral ants are not hostiles', () => {
    const { world, defB, second } = duelAtA();
    world.ants.colonyId[defB] = 0; // B neutral: no free hostile left
    expect(stepOf(hunt(world, second))).toEqual([0, 0]); // the queue beside A
    world.ants.colonyId[world.colonies[ENEMY_COLONY_ID]!.workers[0]!] = 0; // A neutral too
    expect(hunt(world, second)).toBe(NO_FREE_HOSTILE);
  });
});

describe('#364 — full ticks: a pile of invaders spreads over the defenders', () => {
  for (const dir of [1, -1] as const) {
    it(`${dir > 0 ? 'east' : 'west'}: the far defender is engaged`, () => {
      const { world, sx, at } = nest(dir);
      const near = addDefender(world, at(4));
      const far = addDefender(world, at(8, 3));
      const invaders: number[] = [];
      for (let y = ROW; y >= ROW - 2; y--) invaders.push(addInvader(world, { x: sx, y }));
      for (const i of invaders) world.ants.hp[i] = UNKILLABLE_HP;
      // Per invader, its last two tiles: an A-B-A move is a bounce.
      const prev = invaders.map(() => [-1, -1, -1, -1]);
      let bounces = 0;
      let farEngaged = 0;
      let nearEngaged = 0;
      for (let t = 0; t < 150; t++) {
        for (const i of invaders) world.ants.lastMealTick[i] = world.tick;
        world.ants.lastMealTick[near] = world.tick;
        world.ants.lastMealTick[far] = world.tick;
        // #400 (V71): step 16f clamps every ant to its max HP where it stands, so
        // "unkillable" is restored each tick (no blow takes more than one tick's HP).
        for (const id of [...invaders, near, far]) world.ants.hp[id] = UNKILLABLE_HP;
        tick(world, []);
        invaders.forEach((i, k) => {
          expect(world.ants.alive[i]).toBe(1);
          const x = world.ants.posX[i]! >> FP_SHIFT;
          const y = world.ants.posY[i]! >> FP_SHIFT;
          const p = prev[k]!;
          if (x === p[0] && y === p[1] && (x !== p[2] || y !== p[3])) bounces++;
          prev[k] = [p[2]!, p[3]!, x, y];
        });
        if (world.ants.combatOpponentId[far] !== -1) farEngaged++;
        if (world.ants.combatOpponentId[near] !== -1) nearEngaged++;
      }
      expect(nearEngaged).toBeGreaterThan(50);
      expect(farEngaged).toBeGreaterThan(50);
      expect(bounces).toBe(0);
    });
  }
});

describe("#364 — the raid check reads the saturation rule on the raider's own tile too", () => {
  for (const [label, lower, loots] of [
    ['a LOWER-id friend holds the duel there: it does not stop it', true, true],
    ['only a HIGHER-id friend there: the raider is the one paired, so it stops it', false, false],
  ] as const) {
    it(label, () => {
      const r = raidWorld();
      rallyOn(r.player, r.enemyDoor);
      const before = lower
        ? addRaidFighter(r.world, PLAYER_COLONY_ID, 100, 6, ENEMY_COLONY_ID)
        : -1;
      const id = addRaidFighter(r.world, PLAYER_COLONY_ID, 100, 6, ENEMY_COLONY_ID);
      const after = lower ? -1 : addRaidFighter(r.world, PLAYER_COLONY_ID, 100, 6, ENEMY_COLONY_ID);
      expect(lower ? before < id : after > id).toBe(true);
      addEnemyWorker(r.world, 100, 6); // on the raider's own tile
      expect(fighterMayLoot(r.world, r.player, id)).toBe(loots);
      expect(tileSaturatedFor(r.world, id, ENEMY_COLONY_ID, 100, 6)).toBe(loots);
    });
  }
});

describe('#364 — the raid check does not depend on its unsaved stamp counter', () => {
  it('a rollover clears the window: a friend long gone does not still saturate a tile', () => {
    const r = raidWorld();
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    const id = addRaidFighter(w, PLAYER_COLONY_ID, 100, 6, ENEMY_COLONY_ID);
    const hx = 100 - RAID_START_CLEAR_RADIUS_TILES;
    addEnemyWorker(w, hx, 6);
    const friend = addRaidFighter(w, PLAYER_COLONY_ID, hx, 6, ENEMY_COLONY_ID);
    const raid = getScratch(w).raid;
    raid.friendCurrent = 0;
    expect(fighterMayLoot(w, r.player, id)).toBe(true); // stamp 1: the friend holds that duel
    w.ants.posX[friend] = (60 << FP_SHIFT) + (FP_ONE >> 1); // the friend leaves the window
    raid.friendCurrent = 0x7fffffff; // the next check rolls over to stamp 1 again
    expect(fighterMayLoot(w, r.player, id)).toBe(false); // the hostile is free: it stops
  });
});

describe('#364 — a raider aimed by step 10e follows that aim, not the hunt', () => {
  it('V59: it closes on the hostile that stopped its looting, not a nearer one the raid check does not count', () => {
    const r = raidWorld();
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    const id = addRaidFighter(w, PLAYER_COLONY_ID, 100, 6, ENEMY_COLONY_ID);
    // The blocker, an adult worker 2 tiles west (inside the start radius).
    addEnemyWorker(w, 98, 6);
    // One tile east, an enemy ant outside the colony's worker list (as brood is):
    // the hunt counts it, the raid check does not.
    const other = allocateEntityId(w);
    initAnt(w.ants, other, {
      colonyId: ENEMY_COLONY_ID,
      posX: (101 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (6 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
      lastMealTick: w.tick,
    });
    w.ants.currentGridColonyId[other] = ENEMY_COLONY_ID;
    expect(RAID_START_CLEAR_RADIUS_TILES).toBeGreaterThanOrEqual(2);
    // Unaimed, the hunt would go east, to the nearer one.
    expect(stepOf(hunt(w, id))).toEqual([1, 0]);
    const x0 = w.ants.posX[id]!;
    tick(w, []);
    expect(w.ants.posX[id]!).toBeLessThan(x0); // west, at the blocker
  });
});

describe('#364 — a duel its colony holds no longer stops a raider looting', () => {
  it('a hostile in reach on a friend-held tile does not stop it', () => {
    const r = raidWorld();
    rallyOn(r.player, r.enemyDoor);
    const id = addRaidFighter(r.world, PLAYER_COLONY_ID, 100, 6, ENEMY_COLONY_ID);
    const hx = 100 - RAID_START_CLEAR_RADIUS_TILES;
    addEnemyWorker(r.world, hx, 6);
    expect(fighterMayLoot(r.world, r.player, id)).toBe(false); // a free hostile stops it
    addRaidFighter(r.world, PLAYER_COLONY_ID, hx, 6, ENEMY_COLONY_ID); // a friend holds that duel
    expect(fighterMayLoot(r.world, r.player, id)).toBe(true);
  });
});

describe('#364 — results never depend on the unsaved search-stamp counters', () => {
  /** The pile-up nest with a raid larder in play is not needed: the hunt alone
   *  exercises the hunt stamps; raid stamps are exercised by raidPile below. */
  function pile() {
    const { world, sx, at } = nest();
    addDefender(world, at(4));
    addDefender(world, at(8, 3));
    addDefender(world, at(12));
    for (let y = ROW; y >= ROW - 3; y--) addInvader(world, { x: sx, y });
    return world;
  }
  function raidPile() {
    const r = raidWorld();
    rallyOn(r.player, r.enemyDoor);
    for (let x = 90; x <= 110; x += 2)
      addRaidFighter(r.world, PLAYER_COLONY_ID, x, 6, ENEMY_COLONY_ID);
    for (let x = 91; x <= 111; x += 4) addEnemyWorker(r.world, x, 6);
    return r.world;
  }
  /** The whole serialized world (the save format), for comparison. */
  function state(w: WorldState): string {
    return JSON.stringify(serializeWorldState(w));
  }
  function run(w: WorldState, ticks: number): void {
    for (let t = 0; t < ticks; t++) tick(w, []);
  }

  for (const [label, make] of [
    ['the invader hunt', pile],
    ['the raid check', raidPile],
  ] as const) {
    it(`${label}: counters started at the limit give the same run`, () => {
      const plain = make();
      const nearLimit = make();
      const s = getScratch(nearLimit);
      // Buffers must exist before the counter is forced; a first tick builds them.
      tick(plain, []);
      tick(nearLimit, []);
      // Forced once, forward, just short of the limit; the counters then climb
      // through their rollovers on their own (a counter never moves backwards
      // within one arena: a load or copyWorldState drops the arena).
      s.antTargeting.retarget.stamp = 0x7fffffff - 6;
      s.raid.friendCurrent = 0x7fffffff - 3;
      for (let k = 0; k < 13; k++) {
        run(plain, 5);
        run(nearLimit, 5);
        expect(state(nearLimit)).toBe(state(plain));
      }
      // The counter this world exercises rolled over (and neither passed the limit).
      const rolled =
        label === 'the invader hunt' ? s.antTargeting.retarget.stamp : s.raid.friendCurrent;
      expect(rolled).toBeLessThan(0x7fffffff - 6);
      expect(s.antTargeting.retarget.stamp).toBeLessThanOrEqual(0x7fffffff);
      expect(s.raid.friendCurrent).toBeLessThanOrEqual(0x7fffffff);
      expect(state(nearLimit)).toBe(state(plain));
    });

    it(`${label}: a fresh copyWorldState (counters back at 0) continues identically`, () => {
      const plain = make();
      run(plain, 40);
      const copy = make();
      copyWorldState(plain, copy);
      expect(getScratch(copy).antTargeting.retarget.stamp).toBe(0);
      expect(getScratch(plain).antTargeting.retarget.stamp).toBeGreaterThan(0);
      run(plain, 80);
      run(copy, 80);
      expect(state(copy)).toBe(state(plain));
    });
  }
});
