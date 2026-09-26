// fighter-sentries.test.ts — V43 (#323): idle fighters become sentries instead of
// bouncing down and up their own shaft every tick.
//
// Driven through tick() on createScenario worlds, so the targeting pass (step
// 10c) and the descent block (step 16) are exercised at their real call sites.
// The targeting-only cases (post ring, spread, hold, sight, blocked tile, closed
// entrance) live in ant/ant-combat-targeting.test.ts.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, FightingSubState, ForagingSubState } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  SPIDER_SWARM_FIGHTER_THRESHOLD,
} from './constants.js';
import type { SimCommand } from './commands.js';
import type { WorldState } from './types.js';

/** A quiet player colony (no spider, no AI) with `n` Fighting ants standing on the
 *  surface ON its open entrance tile. */
function fightersOnTheDoor(n: number): {
  world: WorldState;
  ids: number[];
  ent: { x: number; y: number };
} {
  const world = createScenario(7, 'Normal');
  world.spider = null; // nothing to chase or flee: only the door rules act
  world.aiState = [];
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const e = colony.entrances.find((en) => en.isOpen)!;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: FightingSubState.MovingToRally,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    ids.push(id);
  }
  askForEveryFighter(world);
  return { world, ids, ent: { x: e.surfaceTileX, y: e.surfaceTileY } };
}

/** Set the player colony's ratio to its living workers' current split, so the
 *  allocation asks for every Fighting ant: neither the V40 small-colony stand-down
 *  nor the V47 surplus-sentry stand-down (sentry-stand-down.test.ts) releases any,
 *  and no other worker is promoted. These tests are about where sentries go. */
function askForEveryFighter(world: WorldState): void {
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  let fight = 0;
  let other = 0;
  for (const id of colony.workers) {
    if (world.ants.alive[id] !== 1) continue;
    if (world.ants.task[id] === AntTask.Fighting) fight += 1;
    else other += 1;
  }
  colony.targetRatio.forage = other;
  colony.targetRatio.fight = fight;
}

/** Tick `ticks` times; return each fighter's number of zone changes. */
function zoneFlips(world: WorldState, ids: readonly number[], ticks: number): number[] {
  const flips = ids.map(() => 0);
  const last = ids.map((id) => world.ants.zone[id]!);
  for (let t = 0; t < ticks; t++) {
    tick(world, []);
    ids.forEach((id, k) => {
      if (world.ants.alive[id] !== 1) return;
      const z = world.ants.zone[id]!;
      if (z !== last[k]) flips[k] = flips[k]! + 1;
      last[k] = z;
    });
  }
  return flips;
}

/** Add `n` player Fighting ants on the surface at (tileX, tileY). */
function placeFighters(
  world: WorldState,
  tileX: number,
  tileY: number,
  n: number,
): { ids: number[] } {
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: FightingSubState.MovingToRally,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    ids.push(id);
  }
  askForEveryFighter(world);
  return { ids };
}

describe('V43 (#323) — idle fighters stand sentry instead of bouncing at the door', () => {
  it('V43: no-rally fighters on their own door never go down it, and settle on posts', () => {
    const { world, ids, ent } = fightersOnTheDoor(4);
    const flips = zoneFlips(world, ids, 120);
    expect(flips).toEqual([0, 0, 0, 0]);
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      const tx = world.ants.posX[id]! >> FP_SHIFT;
      const ty = world.ants.posY[id]! >> FP_SHIFT;
      // Off the door, within sight of it.
      expect([tx, ty]).not.toEqual([ent.x, ent.y]);
      expect(Math.abs(tx - ent.x) + Math.abs(ty - ent.y)).toBeLessThanOrEqual(4);
    }
  });

  it('V43: a rally ON the own entrance still takes a fighter down it (defensive descent kept)', () => {
    const { world, ids, ent } = fightersOnTheDoor(1);
    world.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: ent.x, tileY: ent.y };
    tick(world, []);
    expect(world.ants.zone[ids[0]!]).toBe(Zone.Underground);
  });

  /** One fighter two tiles west of its door, rallied eight tiles east of it: its
   *  straight path steps onto the entrance tile on the way. (Starting ON the door
   *  would not test the crossing: its first step east takes it off the door
   *  before the descent check runs.) */
  function crossing(): number {
    const { world, ids, ent } = fightersOnTheDoor(1);
    world.ants.posX[ids[0]!] = ((ent.x - 2) << FP_SHIFT) + (FP_ONE >> 1);
    world.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: ent.x + 8, tileY: ent.y };
    return zoneFlips(world, ids, 30)[0]!;
  }

  it('V43: a fighter crossing its own door toward a surface rally walks over it', () => {
    expect(crossing()).toBe(0);
  });

  it('V43: a fighter crossing its own door toward a rally in the same column walks over it', () => {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e = colony.entrances.find((en) => en.isOpen)!;
    const { ids } = placeFighters(world, e.surfaceTileX, e.surfaceTileY - 2, 1);
    colony.rallyPoint = { tileX: e.surfaceTileX, tileY: e.surfaceTileY + 3 };
    expect(zoneFlips(world, ids, 30)).toEqual([0]);
  });
});

describe('V43 (#323) — sentries take cover from the spider', () => {
  /** Put the world's spider `dx` tiles east of the door, Patrolling. */
  function spiderEastOfDoor(world: WorldState, ent: { x: number; y: number }, dx: number): void {
    const sp = world.spider!;
    sp.state = 'Patrolling';
    sp.posX = ((ent.x + dx) << FP_SHIFT) + (FP_ONE >> 1);
    sp.posY = (ent.y << FP_SHIFT) + (FP_ONE >> 1);
  }

  function sentryWithSpider(): {
    world: WorldState;
    id: number;
    ent: { x: number; y: number };
  } {
    const world = createScenario(7, 'Normal');
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e = colony.entrances.find((en) => en.isOpen)!;
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: FightingSubState.MovingToRally,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    colony.targetRatio.fight = 5;
    return { world, id, ent: { x: e.surfaceTileX, y: e.surfaceTileY } };
  }

  /** Put the fighter at the top of its own shaft, sheltering. */
  function shelter(world: WorldState, id: number): void {
    world.ants.zone[id] = Zone.Underground;
    world.ants.posY[id] = FP_ONE >> 1;
    world.ants.currentGridColonyId[id] = PLAYER_COLONY_ID;
  }

  /** Tick up to `ticks` times with the spider pinned `dx` east of the door; the
   *  tick the fighter reached the surface, or -1. */
  function ticksToSurface(
    world: WorldState,
    id: number,
    ent: { x: number; y: number },
    dx: number,
    ticks: number,
  ): number {
    for (let t = 0; t < ticks; t++) {
      spiderEastOfDoor(world, ent, dx);
      tick(world, []);
      if (world.ants.zone[id] === Zone.Surface) return t;
    }
    return -1;
  }

  // The door-relative cover radius: watch radius 4 + post ring 3 + hold 1.
  const COVER_DOOR_RADIUS = 8;
  // A sheltering sentry climbs out only past this: the cover radius + 2 tiles.
  const ALL_CLEAR_RADIUS = COVER_DOOR_RADIUS + 2;

  it('a sentry on its door that sees the spider goes down the shaft', () => {
    const { world, id, ent } = sentryWithSpider();
    spiderEastOfDoor(world, ent, 4); // in sight, not in reach this tick
    tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
  });

  it('stays below until the spider is past the all-clear radius of the door, then climbs back out', () => {
    const { world, id, ent } = sentryWithSpider();
    shelter(world, id);
    expect(ticksToSurface(world, id, ent, ALL_CLEAR_RADIUS, 15)).toBe(-1); // at the radius: stays
    expect(ticksToSurface(world, id, ent, ALL_CLEAR_RADIUS + 1, 15)).toBeGreaterThanOrEqual(0); // past it: out
  });

  it('a spider pacing across the cover radius does not bounce a sentry down and up the shaft', () => {
    const { world, id, ent } = sentryWithSpider();
    // One tile a tick, as the spider moves: back and forth between the cover radius
    // and the all-clear radius, starting inside the cover radius.
    const path = [8, 9, 10, 9];
    let flips = 0;
    let last = world.ants.zone[id]!;
    for (let t = 0; t < 40; t++) {
      spiderEastOfDoor(world, ent, path[t % path.length]!);
      tick(world, []);
      const z = world.ants.zone[id]!;
      if (z !== last) flips += 1;
      last = z;
    }
    // Down once, and it stays down: the spider never gets past the all-clear radius.
    expect(flips).toBe(1);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
  });

  it('stays below only in its OWN nest: a recalled invader climbs out of the enemy shaft past the spider', () => {
    const { world } = sentryWithSpider();
    const enemyEnt = world.colonies[ENEMY_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
    const ent = { x: enemyEnt.surfaceTileX, y: enemyEnt.surfaceTileY };
    // No rally point (recalled), at the top of the ENEMY shaft.
    const { ids } = placeFighters(world, ent.x, 0, 1);
    const id = ids[0]!;
    world.ants.zone[id] = Zone.Underground;
    world.ants.posY[id] = FP_ONE >> 1;
    world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
    expect(ticksToSurface(world, id, ent, 5, 6)).toBeGreaterThanOrEqual(0);
  });

  it('under spider priority, fighters sent at the spider do not pass through each other onto its tile', () => {
    const world = createScenario(7, 'Normal');
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e = colony.entrances.find((en) => en.isOpen)!;
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        ...placeFighters(world, e.surfaceTileX + 6 + (i % 3), e.surfaceTileY - 2 + (i % 4), 1).ids,
      );
    }
    const sp = world.spider!;
    sp.state = 'Patrolling';
    sp.posX = ((e.surfaceTileX + 13) << FP_SHIFT) + (FP_ONE >> 1);
    sp.posY = (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
    let cmds: SimCommand[] = [
      {
        type: 'MarkSpiderPriority',
        colonyId: PLAYER_COLONY_ID,
        isPriority: true,
        issuedAtTick: world.tick,
      },
    ];
    let maxOnSpider = 0;
    for (let t = 0; t < 120 && world.spider !== null; t++) {
      tick(world, cmds);
      cmds = [];
      const s = world.spider;
      if (s === null) break;
      const on = ids.filter(
        (id) =>
          world.ants.alive[id] === 1 &&
          world.ants.zone[id] === Zone.Surface &&
          world.ants.posX[id]! >> FP_SHIFT === s.posX >> FP_SHIFT &&
          world.ants.posY[id]! >> FP_SHIFT === s.posY >> FP_SHIFT,
      ).length;
      maxOnSpider = Math.max(maxOnSpider, on);
    }
    // Same-colony occupancy still spreads them: never a swarm-sized stack.
    expect(maxOnSpider).toBeLessThan(SPIDER_SWARM_FIGHTER_THRESHOLD);
  });

  it('under spider priority, a sheltering fighter climbs out to fight it', () => {
    const { world, id, ent } = sentryWithSpider();
    world.spiderPriorityColonyId = PLAYER_COLONY_ID;
    shelter(world, id);
    expect(ticksToSurface(world, id, ent, 5, 5)).toBeGreaterThanOrEqual(0);
  });

  it('a sentry at its post heads in and goes down while the spider lingers near the door (no pacing)', () => {
    const { world, id, ent } = sentryWithSpider();
    // Let it settle on its post first, spider far away.
    for (let t = 0; t < 40; t++) {
      spiderEastOfDoor(world, ent, 30);
      tick(world, []);
    }
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    // A Feeding spider settles 6 tiles from the door: out of plain sight of some
    // posts, but inside the cover radius. The sentry must end up below, not pace.
    let wentDown = -1;
    for (let t = 0; t < 40 && wentDown < 0; t++) {
      spiderEastOfDoor(world, ent, 6);
      world.spider!.state = 'Feeding';
      tick(world, []);
      if (world.ants.zone[id] === Zone.Underground) wentDown = t;
    }
    expect(wentDown).toBeGreaterThanOrEqual(0);
  });
});

describe('V43 (#323) — no orders, no invasion; no ping-pong between close doors', () => {
  it('V43: a fighter with no rally point on an enemy open entrance stays out', () => {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    world.aiState = [];
    const enemyEnt = world.colonies[ENEMY_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
    // Move the enemy queen off her door (the #164 pre-descent gate would hold a
    // foreign fighter up top to fight her instead).
    const q = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
    world.ants.posX[q] = (enemyEnt.surfaceTileX + 6) << FP_SHIFT;
    const { ids } = placeFighters(world, enemyEnt.surfaceTileX, enemyEnt.surfaceTileY, 1);
    tick(world, []);
    expect(world.ants.zone[ids[0]!]).toBe(Zone.Surface);
  });

  it('sentries settle when two open entrances sit close together', () => {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e1 = colony.entrances.find((e) => e.isOpen)!;
    // A second open entrance 3 east: parts of each door's post ring lie nearer
    // the other door, so without the stable-post filter a sentry re-binds between
    // the two rings every tick. (A high id: it loses nearest-door ties.)
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: e1.surfaceTileX + 3,
      surfaceTileY: e1.surfaceTileY,
      isOpen: true,
    });
    placeFighters(world, e1.surfaceTileX, e1.surfaceTileY, 5);
    // The colony's own starting workers become fighters too.
    colony.targetRatio.forage = 0;
    for (let t = 0; t < 150; t++) tick(world, []);
    // After settling, no fighter moves on ANY tick. (Checked every tick: a sentry
    // ping-ponging between the two rings alternates positions each tick, so two
    // samples an even number of ticks apart would look identical.)
    const at = (): string =>
      colony.workers
        .filter((id) => world.ants.alive[id] === 1 && world.ants.task[id] === AntTask.Fighting)
        .map((id) => [id, world.ants.posX[id], world.ants.posY[id], world.ants.zone[id]].join(','))
        .join(' ');
    let prev = at();
    let moves = 0;
    for (let t = 0; t < 40; t++) {
      tick(world, []);
      const now = at();
      if (now !== prev) moves += 1;
      prev = now;
    }
    expect(moves).toBe(0);
    // Settled on posts, not queued up behind one another on a door.
    const onADoor = colony.workers.filter(
      (id) =>
        world.ants.alive[id] === 1 &&
        world.ants.task[id] === AntTask.Fighting &&
        colony.entrances.some(
          (e) =>
            e.surfaceTileX === world.ants.posX[id]! >> FP_SHIFT &&
            e.surfaceTileY === world.ants.posY[id]! >> FP_SHIFT,
        ),
    );
    expect(onADoor).toEqual([]);
  });

  it('a latecomer reaches its post through sentries already holding theirs', () => {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e1 = colony.entrances.find((e) => e.isOpen)!;
    placeFighters(world, e1.surfaceTileX, e1.surfaceTileY, 11);
    for (let t = 0; t < 300; t++) tick(world, []);
    // The last free post is on the far side of a ring of holders; bumped back off
    // their tiles every tick, the latecomer used to freeze against them for good.
    const { ids } = placeFighters(world, e1.surfaceTileX, e1.surfaceTileY - 8, 1);
    const late = ids[0]!;
    let heldAt = -1;
    for (let t = 0; t < 200 && heldAt < 0; t++) {
      tick(world, []);
      if (world.ants.targetPosX[late] === -1) heldAt = t;
    }
    expect(heldAt).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('fighters walking home after a cleared field rally get round obstacles', () => {
    // A field rally far from the door, then cleared: the recalled fighters walk
    // home across the map. Count those still more than 6 from the door after
    // 1 500 ticks.
    const stranded = (): number => {
      const world = createScenario(6, 'Normal');
      world.spider = null;
      world.aiState = [];
      const colony = world.colonies[PLAYER_COLONY_ID]!;
      const e = colony.entrances.find((en) => en.isOpen)!;
      const { ids } = placeFighters(world, e.surfaceTileX, e.surfaceTileY, 10);
      colony.targetRatio.fight = 50;
      colony.rallyPoint = { tileX: 55, tileY: 100 };
      for (let t = 0; t < 400; t++) tick(world, []);
      colony.rallyPoint = null;
      for (let t = 0; t < 1500; t++) tick(world, []);
      return ids.filter(
        (id) =>
          world.ants.alive[id] === 1 &&
          Math.abs((world.ants.posX[id]! >> FP_SHIFT) - e.surfaceTileX) +
            Math.abs((world.ants.posY[id]! >> FP_SHIFT) - e.surfaceTileY) >
            6,
      ).length;
    };
    // Before V43 some stayed stranded; walking home by the flow field (V48) none do.
    expect(stranded()).toBe(0);
  }, 30_000);

  it('twenty sentries at one door settle one to a tile, with none on the door', () => {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e1 = colony.entrances.find((e) => e.isOpen)!;
    const { ids } = placeFighters(world, e1.surfaceTileX, e1.surfaceTileY, 20);
    for (let t = 0; t < 700; t++) tick(world, []);
    const at = (): string =>
      ids
        .map((id) => [world.ants.posX[id], world.ants.posY[id], world.ants.zone[id]].join(','))
        .join(' ');
    let prev = at();
    let moves = 0;
    for (let t = 0; t < 40; t++) {
      tick(world, []);
      const now = at();
      if (now !== prev) moves += 1;
      prev = now;
    }
    expect(moves).toBe(0);
    expect(ids.filter((id) => world.ants.targetPosX[id] !== -1)).toEqual([]);
    // Holders take a tile each.
    const tiles = new Set(
      ids.map((id) => `${world.ants.posX[id]! >> FP_SHIFT},${world.ants.posY[id]! >> FP_SHIFT}`),
    );
    expect(tiles.size).toBe(ids.length);
    expect(
      ids.filter(
        (id) =>
          world.ants.posX[id]! >> FP_SHIFT === e1.surfaceTileX &&
          world.ants.posY[id]! >> FP_SHIFT === e1.surfaceTileY,
      ),
    ).toEqual([]);
  }, 30_000);

  it('three own doors in adjacent columns: nobody freezes on a door, and the sentries settle', () => {
    const world = createScenario(7, 'Normal');
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e1 = colony.entrances.find((e) => e.isOpen)!;
    // The middle door has no stable post: every hold area on its ring reaches a
    // tile nearer one of its neighbours. (Inside the root's clear halo.)
    for (const dx of [-1, 1]) {
      colony.entrances.push({
        entranceId: allocateEntityId(world),
        surfaceTileX: e1.surfaceTileX + dx,
        surfaceTileY: e1.surfaceTileY,
        isOpen: true,
      });
    }
    const { ids } = placeFighters(world, e1.surfaceTileX, e1.surfaceTileY, 6);
    for (let t = 0; t < 150; t++) tick(world, []);
    const onADoor = (id: number): boolean =>
      colony.entrances.some(
        (e) =>
          e.surfaceTileX === world.ants.posX[id]! >> FP_SHIFT &&
          e.surfaceTileY === world.ants.posY[id]! >> FP_SHIFT,
      );
    // Settled: no fighter moves on any tick (checked every tick), none on a door.
    const at = (): string =>
      ids
        .map((id) => [world.ants.posX[id], world.ants.posY[id], world.ants.zone[id]].join(','))
        .join(' ');
    let prev = at();
    let moves = 0;
    for (let t = 0; t < 40; t++) {
      tick(world, []);
      const now = at();
      if (now !== prev) moves += 1;
      prev = now;
    }
    expect(moves).toBe(0);
    expect(ids.filter(onADoor)).toEqual([]);
  });
});

describe('V45 (#327) — workers walk through the sentry ring', () => {
  /** Ticks for a laden forager to get below, starting `dx` tiles east of an entrance
   *  that `n` settled sentries surround; -1 if it never does within `limit`. */
  function carrierThroughRing(n: number, dx: number, limit: number): number {
    const { world, ent } = fightersOnTheDoor(n);
    for (let t = 0; t < 300; t++) tick(world, []); // the sentries take their posts
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const id = allocateEntityId(world); // highest id: every holder outranks it
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: ((ent.x + dx) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (ent.y << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    world.ants.foodCarrying[id] = FP_ONE;
    colony.workers.push(id);
    colony.workerCount += 1;
    for (let t = 1; t <= limit; t++) {
      tick(world, []);
      if (world.ants.zone[id] === Zone.Underground) return t;
    }
    return -1;
  }

  it('twenty-four sentries settle one to a tile, on the inner and outer rings, none on the door', () => {
    const { world, ids, ent } = fightersOnTheDoor(24);
    for (let t = 0; t < 400; t++) tick(world, []);
    const tiles = new Set<string>();
    const rings = new Map<number, number>();
    for (const id of ids) {
      const x = world.ants.posX[id]! >> FP_SHIFT;
      const y = world.ants.posY[id]! >> FP_SHIFT;
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      const d = Math.abs(x - ent.x) + Math.abs(y - ent.y);
      rings.set(d, (rings.get(d) ?? 0) + 1);
      tiles.add(`${x},${y}`);
    }
    expect(tiles.size).toBe(24);
    expect(Object.fromEntries(rings)).toEqual({ 3: 12, 4: 12 });
  });

  it('a laden forager crosses a ring of holding sentries and goes down', () => {
    expect(carrierThroughRing(20, 6, 200)).toBeGreaterThan(0);
  });
});

describe('V46 (#328) — sentries at entrances close together settle', () => {
  /** Three own open entrances within a few tiles, sharing ring tiles as posts, and
   *  `n` sentries. Returns how many sentries change tile on some tick of the last
   *  `watch` ticks (checked every tick: a ping-pong has period 2). */
  function crowdedEntrances(
    n: number,
    watch: number,
    offsets: ReadonlyArray<readonly [number, number]>,
  ): number {
    const { world, ids, ent } = fightersOnTheDoor(n);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (const [dx, dy] of offsets) {
      colony.entrances.push({
        entranceId: allocateEntityId(world),
        surfaceTileX: ent.x + dx,
        surfaceTileY: ent.y + dy,
        isOpen: true,
      });
    }
    // Start them spread over the three entrances, as a garrison coming home would.
    const doors = colony.entrances.filter((e) => e.isOpen);
    ids.forEach((id, k) => {
      const d = doors[k % doors.length]!;
      world.ants.posX[id] = (d.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
      world.ants.posY[id] = (d.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
    });
    for (let t = 0; t < 600; t++) tick(world, []);
    const moved = new Set<number>();
    const last = ids.map((id) => `${world.ants.posX[id]},${world.ants.posY[id]}`);
    for (let t = 0; t < watch; t++) {
      tick(world, []);
      ids.forEach((id, k) => {
        const now = `${world.ants.posX[id]},${world.ants.posY[id]}`;
        if (now !== last[k]) moved.add(id);
        last[k] = now;
      });
    }
    return moved.size;
  }

  // In the first layout entrances share posts, and sentries turned round every
  // tick before V46; the second settles only if a sentry HOLDING a post nearer
  // another entrance stays bound to its own; the third only if every post has one
  // owner.
  const LAYOUTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [
      [1, -1],
      [2, -4],
    ],
    [
      [-1, 0],
      [2, 1],
    ],
    // Four entrances (the most a colony may have) listing the same ring tiles: an
    // entrance that handed out a post another owned sent sentries back and forth
    // between the two.
    [
      [-3, 0],
      [1, 0],
      [2, 0],
    ],
  ];

  it('no sentry keeps moving once settled', () => {
    for (const layout of LAYOUTS) {
      expect(crowdedEntrances(30, 100, layout)).toBe(0);
    }
  }, 30_000);

  it('a garrison at four close entrances spreads over all of them, one sentry to a tile', () => {
    const { world, ids, ent } = fightersOnTheDoor(30);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (const [dx, dy] of [
      [2, -1],
      [1, -4],
      [4, 0],
    ] as const) {
      colony.entrances.push({
        entranceId: allocateEntityId(world),
        surfaceTileX: ent.x + dx,
        surfaceTileY: ent.y + dy,
        isOpen: true,
      });
    }
    const doors = colony.entrances.filter((e) => e.isOpen);
    ids.forEach((id, k) => {
      const d = doors[k % doors.length]!;
      world.ants.posX[id] = (d.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
      world.ants.posY[id] = (d.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
    });
    for (let t = 0; t < 600; t++) tick(world, []);
    const tiles = new Set<string>();
    const nearDoor = doors.map(() => 0);
    for (const id of ids) {
      const x = world.ants.posX[id]! >> FP_SHIFT;
      const y = world.ants.posY[id]! >> FP_SHIFT;
      tiles.add(`${x},${y}`);
      let best = 0;
      doors.forEach((d, i) => {
        const b = doors[best]!;
        if (
          Math.abs(d.surfaceTileX - x) + Math.abs(d.surfaceTileY - y) <
          Math.abs(b.surfaceTileX - x) + Math.abs(b.surfaceTileY - y)
        )
          best = i;
      });
      nearDoor[best] = nearDoor[best]! + 1;
    }
    // Binding every shared post to the lowest-id entrance instead stacked sentries
    // three to a tile and left the east entrance with two.
    expect(tiles.size).toBe(ids.length);
    expect(nearDoor[3]).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it('the spider override clears the walking-to-post mark', () => {
    const world = createScenario(7, 'Normal');
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e = colony.entrances.find((en) => en.isOpen)!;
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: ((e.surfaceTileX + 4) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: FightingSubState.MovingToRally,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    colony.targetRatio.fight = 5;
    // The spider well away from the entrance, so nothing takes cover.
    world.spider!.posX = (e.surfaceTileX + 30) << FP_SHIFT;
    world.spider!.posY = e.surfaceTileY << FP_SHIFT;
    tick(world, []);
    expect(world.ants.subTask[id]).toBe(FightingSubState.ToPost);
    // Sent at the spider: its target is the spider now, and no longer a post.
    world.spiderPriorityColonyId = PLAYER_COLONY_ID;
    tick(world, []);
    expect(world.ants.subTask[id]).not.toBe(FightingSubState.ToPost);
  });
});

describe('V48 (#333) — a sentry behind an obstacle gets home', () => {
  /** Seed 7's map has a multi-tile obstacle at x18–23, y70–72. With entrances at
   *  the root (24,64) and (28,65), (21,66), (23,63), a sentry dropped just south
   *  of it is 7–9 tiles from its entrance. Returns, over ticks 400–600: target
   *  changes, tile changes, and whether it ends holding a post. */
  function behindTheObstacle(
    sx: number,
    sy: number,
  ): { targetChanges: number; moves: number; holding: boolean } {
    const { world, ids, ent } = fightersOnTheDoor(1);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    expect(ent).toEqual({ x: 24, y: 64 });
    for (const [x, y] of [
      [28, 65],
      [21, 66],
      [23, 63],
    ] as const) {
      colony.entrances.push({
        entranceId: allocateEntityId(world),
        surfaceTileX: x,
        surfaceTileY: y,
        isOpen: true,
      });
    }
    const id = ids[0]!;
    world.ants.posX[id] = (sx << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (sy << FP_SHIFT) + (FP_ONE >> 1);
    let targetChanges = 0;
    let moves = 0;
    let lastTarget = '';
    let lastTile = '';
    for (let t = 0; t < 600; t++) {
      tick(world, []);
      const target = `${world.ants.targetPosX[id]},${world.ants.targetPosY[id]}`;
      const tile = `${world.ants.posX[id] >> FP_SHIFT},${world.ants.posY[id] >> FP_SHIFT}`;
      if (t > 400) {
        if (target !== lastTarget) targetChanges++;
        if (tile !== lastTile) moves++;
      }
      lastTarget = target;
      lastTile = tile;
    }
    const holding =
      world.ants.subTask[id] === FightingSubState.Holding && world.ants.targetPosX[id] === -1;
    return { targetChanges, moves, holding };
  }

  it('V48: it walks round the obstacle and holds a post', () => {
    for (const [sx, sy] of [
      [19, 73],
      [21, 74],
      [22, 74],
    ] as const) {
      expect(behindTheObstacle(sx, sy)).toEqual({
        targetChanges: 0,
        moves: 0,
        holding: true,
      });
    }
  }, 30_000);
});
