// src/sim/spider-rotation.test.ts — #337 (V54): a timed-out rampage moves on.
//
// Up to V53 a hungry spider whose rampage timed out could camp the same entrance
// again the next tick, so a colony sheltering underground could be camped until its
// queen starved. From V54 a timeout sets a rotation cursor (the entrance it timed out
// on) and the next rampage camps the next open entrance by ascending entranceId,
// across every colony, until the spider kills something. A lone open entrance can be
// camped again only SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS after the timeout.

import { describe, it, expect } from 'vitest';
import type { WorldState, SpiderState, SpiderBehaviorState } from './types.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V54_SPIDER_ROTATES_ENTRANCES,
  LATEST_SIM_VERSION,
} from './types.js';
import { tickSpider } from './spider.js';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, PheromoneType } from './enums.js';
import { createPheromoneGrid, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyId } from './colony/colony-store.js';
import {
  SPIDER_HP_FULL,
  SPIDER_HUNT_INTERVAL_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_RAMPAGE_MAX_TICKS,
  SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS,
  SURFACE_GRID_WIDTH,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { Zone } from './terrain.js';

const C1 = PLAYER_COLONY_ID as unknown as ColonyId;
const C2 = ENEMY_COLONY_ID as unknown as ColonyId;

/** Hunger well past every tier's threshold (the longest, Easy, is 1800). */
const HUNGRY = 5000;
const T0 = SPIDER_GRACE_TICKS + 1000;

// Entrance ids deliberately interleave the colonies, so the ascending-id rotation
// crosses between them: 101 (C1) → 103 (C2) → 105 (C1) → 101 ...
const E101 = { entranceId: 101, surfaceTileX: 40, surfaceTileY: 20 }; // C1
const E103 = { entranceId: 103, surfaceTileX: 100, surfaceTileY: 60 }; // C2
const E105 = { entranceId: 105, surfaceTileX: 10, surfaceTileY: 20 }; // C1, farther than 101 from the east

function makeSpider(overrides: Partial<SpiderState> = {}): SpiderState {
  return {
    state: 'Patrolling' as SpiderBehaviorState,
    posX: 64 << FP_SHIFT,
    posY: 32 << FP_SHIFT,
    lairTileX: 64,
    lairTileY: 32,
    territoryRadiusTiles: 24,
    hp: SPIDER_HP_FULL,
    attackCooldown: 0,
    hungerTicks: HUNGRY,
    nextHuntTick: T0 + 100 * SPIDER_HUNT_INTERVAL_TICKS, // hunt off: the camp branch is taken
    huntStartTick: 0,
    strikeStartTick: 0,
    feedingStartTick: 0,
    retreatStartTick: 0,
    rampageStartTick: 0,
    huntTargetTileX: -1,
    huntTargetTileY: -1,
    killsThisStrike: 0,
    rampageKillsThisRampage: 0,
    rampageTargetColonyId: -1,
    chaseTargetAntId: -1,
    chaseStartTick: 0,
    killedThisTick: 0,
    lastKillTileX: -1,
    lastKillTileY: -1,
    feedAwayTileX: -1,
    feedAwayTileY: -1,
    feedArrivedTick: -1,
    lastHitTick: -1,
    rampageEntranceId: -1,
    rampageRotationEntranceId: -1,
    rampageRotationTick: -1,
    ...overrides,
  };
}

/** Two colonies (real queen slots, off-surface so they are no prey), three open entrances. */
function makeWorld(version: number = SIM_VERSION_V54_SPIDER_ROTATES_ENTRANCES): WorldState {
  const world = createWorldState(7);
  world.simVersion = version;
  world.tick = T0;
  for (const cid of [C1, C2]) {
    const queen = allocateEntityId(world);
    initAnt(world.ants, queen, {
      colonyId: cid,
      posX: 0,
      posY: 0,
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    const colony = createColonyRecord(cid, queen);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[cid] = colony;
    world.pheromoneGrids[pheromoneGridKey(cid, PheromoneType.DangerTrail, 'surface')] =
      createPheromoneGrid(SURFACE_GRID_WIDTH, 128);
  }
  world.colonies[C1]!.entrances.push({ ...E101, isOpen: true }, { ...E105, isOpen: true });
  world.colonies[C2]!.entrances.push({ ...E103, isOpen: true });
  return world;
}

function entranceById(world: WorldState, id: number) {
  for (const cid of [C1, C2]) {
    const e = world.colonies[cid]!.entrances.find((x) => x.entranceId === id);
    if (e !== undefined) return e;
  }
  throw new Error(`no entrance ${id}`);
}

/** Put the spider on entrance `id`, Rampaging on it, with the leash already expired. */
function campExpired(world: WorldState, id: number): void {
  const e = entranceById(world, id);
  const colonyId = world.colonies[C1]!.entrances.includes(e) ? PLAYER_COLONY_ID : ENEMY_COLONY_ID;
  const s = world.spider!;
  s.state = 'Rampaging';
  s.rampageTargetColonyId = colonyId;
  s.rampageStartTick = world.tick - SPIDER_RAMPAGE_MAX_TICKS;
  s.posX = e.surfaceTileX << FP_SHIFT;
  s.posY = e.surfaceTileY << FP_SHIFT;
}

function step(world: WorldState): void {
  world.tick += 1;
  tickSpider(world);
}

/** Tick until the spider starts a rampage (or `max` ticks pass); returns ticks taken or -1. */
function untilRampage(world: WorldState, max: number): number {
  for (let i = 1; i <= max; i++) {
    step(world);
    if (world.spider!.state === 'Rampaging') return i;
  }
  return -1;
}

function spawnSurfaceWorker(world: WorldState, colonyId: ColonyId, x: number, y: number): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Foraging,
    speed: WORKER_BASE_SPEED,
    zone: Zone.Surface,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

describe('V54 (#337) — timed-out rampage rotates entrances', () => {
  it('LATEST is V54 or later', () => {
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V54_SPIDER_ROTATES_ENTRANCES);
  });

  it('a timeout records the camped entrance, and the next rampage camps a different one (pinned)', () => {
    const world = makeWorld();
    world.spider = makeSpider();
    campExpired(world, 101);
    step(world);
    const s = world.spider;
    expect(s.state).toBe('Patrolling');
    expect(s.rampageRotationEntranceId).toBe(101);
    expect(s.rampageRotationTick).toBe(world.tick);
    expect(s.rampageEntranceId).toBe(-1);
    // Next tick, still hungry: rampage again, on the next entrance by id (C2's 103).
    step(world);
    expect(s.state).toBe('Rampaging');
    expect(s.rampageEntranceId).toBe(103);
    expect(s.rampageTargetColonyId).toBe(ENEMY_COLONY_ID);
  });

  it('the rotation visits every open entrance in ascending entranceId order, across colonies, wrapping', () => {
    const world = makeWorld();
    world.spider = makeSpider();
    campExpired(world, 101);
    step(world); // timeout on 101
    const visited: number[] = [];
    for (let k = 0; k < 5; k++) {
      expect(untilRampage(world, 5)).toBeGreaterThan(0);
      visited.push(world.spider.rampageEntranceId);
      // Let this rampage time out where it is.
      world.spider.rampageStartTick = world.tick - SPIDER_RAMPAGE_MAX_TICKS;
      step(world);
      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.rampageRotationEntranceId).toBe(visited[k]);
    }
    expect(visited).toEqual([103, 105, 101, 103, 105]);
  });

  it('a pinned rampage camps its entrance, not the nearest entrance of that colony', () => {
    const world = makeWorld();
    // Cursor at 103 → next is 105 (C1, far west); the spider starts east, nearer C1's 101.
    world.spider = makeSpider({ rampageRotationEntranceId: 103, rampageRotationTick: T0 - 5 });
    world.spider.posX = 60 << FP_SHIFT;
    world.spider.posY = 20 << FP_SHIFT;
    step(world);
    expect(world.spider.rampageEntranceId).toBe(105);
    for (let i = 0; i < 80; i++) step(world);
    expect(world.spider.state).toBe('Rampaging');
    expect(world.spider.posX >> FP_SHIFT).toBe(E105.surfaceTileX);
    expect(world.spider.posY >> FP_SHIFT).toBe(E105.surfaceTileY);
  });

  it('a closed pinned entrance ends the rampage (sealed); the next one rotates on, never to the cursor', () => {
    const world = makeWorld();
    // Cursor 101 (C1): the rotation goes to 103 (C2). C2's only entrance then closes.
    world.spider = makeSpider({ rampageRotationEntranceId: 101, rampageRotationTick: T0 - 5 });
    step(world);
    expect(world.spider.rampageEntranceId).toBe(103);
    entranceById(world, 103).isOpen = false;
    world.events.length = 0;
    step(world);
    expect(world.events.some((e) => e.type === 'spider_rampage_end')).toBe(true);
    expect(world.spider.rampageEntranceId).toBe(-1);
    expect(world.spider.rampageRotationEntranceId).toBe(101); // not a timeout: cursor kept
    expect(untilRampage(world, 3)).toBeGreaterThan(0);
    expect(world.spider.rampageEntranceId).toBe(105);
  });

  it('a closed pin never falls back to the timed-out entrance of the same colony', () => {
    const world = makeWorld();
    // Cursor 101; 103 closed, so the rotation picks 105, the other C1 entrance.
    entranceById(world, 103).isOpen = false;
    world.spider = makeSpider({ rampageRotationEntranceId: 101, rampageRotationTick: T0 - 5 });
    step(world);
    expect(world.spider.rampageEntranceId).toBe(105);
    entranceById(world, 105).isOpen = false; // now 101 is the only open entrance
    for (let i = 0; i < 10; i++) {
      step(world);
      expect(world.spider.state).not.toBe('Rampaging'); // single-entrance cooldown holds
    }
  });

  describe('#165 hold gate reads the pinned entrance, not the nearest one of its colony', () => {
    /** Pinned on 105 (far west) while en route past C1's 101, which a worker stands on. */
    function enRoutePast101(): WorldState {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Rampaging',
        rampageTargetColonyId: PLAYER_COLONY_ID,
        rampageEntranceId: 105,
        rampageStartTick: world.tick,
        rampageRotationEntranceId: 103,
        rampageRotationTick: T0 - 5,
      });
      world.spider.posX = (E101.surfaceTileX - 2) << FP_SHIFT;
      world.spider.posY = E101.surfaceTileY << FP_SHIFT;
      spawnSurfaceWorker(world, C1, E101.surfaceTileX, E101.surfaceTileY);
      return world;
    }

    it('an ant on a non-camped entrance does not hold the gate: the spider diverts to chase it', () => {
      const world = enRoutePast101();
      step(world);
      expect(world.spider!.state).toBe('Chasing');
    });

    it('nor does it suppress self-defense (step 4a): the spider engages the attacker', () => {
      const world = enRoutePast101();
      const f = spawnSurfaceWorker(world, C1, E101.surfaceTileX - 6, E101.surfaceTileY);
      world.ants.task[f] = AntTask.Fighting;
      step(world);
      expect(world.spider!.state).toBe('Chasing');
      expect(world.spider!.chaseTargetAntId).toBe(f);
    });
  });

  it('a kill ends the rotation; the next hungry spell uses the colony picker again', () => {
    const world = makeWorld();
    world.spider = makeSpider({ rampageRotationEntranceId: 101, rampageRotationTick: T0 - 5 });
    step(world);
    expect(world.spider.rampageEntranceId).toBe(103);
    world.spider.killedThisTick = 1; // combat (step 17) landed a bite this tick
    world.spider.lastKillTileX = world.spider.posX >> FP_SHIFT;
    world.spider.lastKillTileY = world.spider.posY >> FP_SHIFT;
    step(world);
    const s = world.spider;
    expect(s.state).toBe('Feeding');
    expect(s.hungerTicks).toBe(0);
    expect(s.rampageRotationEntranceId).toBe(-1);
    expect(s.rampageRotationTick).toBe(-1);
    expect(s.rampageEntranceId).toBe(-1);
    // Hungry again, sated state long over: a fresh rampage is unpinned (60/40 picker).
    s.state = 'Patrolling';
    s.hungerTicks = HUNGRY;
    expect(untilRampage(world, 3)).toBeGreaterThan(0);
    expect(s.rampageEntranceId).toBe(-1);
    expect([PLAYER_COLONY_ID, ENEMY_COLONY_ID]).toContain(s.rampageTargetColonyId);
  });

  it('a kill with a fighter adjacent (no Feeding) also ends the rotation', () => {
    const world = makeWorld();
    world.spider = makeSpider({ rampageRotationEntranceId: 101, rampageRotationTick: T0 - 5 });
    const sx = world.spider.posX >> FP_SHIFT;
    const sy = world.spider.posY >> FP_SHIFT;
    const f = spawnSurfaceWorker(world, C1, sx + 1, sy);
    world.ants.task[f] = AntTask.Fighting;
    world.spider.state = 'Chasing';
    world.spider.chaseTargetAntId = f;
    world.spider.chaseStartTick = world.tick;
    world.spider.killedThisTick = 1;
    step(world);
    expect(world.spider.state).toBe('Chasing'); // fighter adjacent: keeps fighting
    expect(world.spider.hungerTicks).toBe(0);
    expect(world.spider.rampageRotationEntranceId).toBe(-1);
  });

  it('a rampage that timed out after a kill (fighter adjacent, still Rampaging) sets no cursor', () => {
    const world = makeWorld();
    world.spider = makeSpider();
    campExpired(world, 101);
    world.spider.rampageKillsThisRampage = 1;
    step(world);
    expect(world.spider.state).toBe('Patrolling');
    expect(world.spider.rampageRotationEntranceId).toBe(-1);
  });

  it('a rampage that ends without a timeout (chase-divert) does not move the cursor', () => {
    const world = makeWorld();
    world.spider = makeSpider({ rampageRotationEntranceId: 101, rampageRotationTick: T0 - 5 });
    step(world);
    expect(world.spider.rampageEntranceId).toBe(103);
    const sx = world.spider.posX >> FP_SHIFT;
    const sy = world.spider.posY >> FP_SHIFT;
    spawnSurfaceWorker(world, C1, sx + 2, sy); // a straggler within chase range
    step(world);
    expect(world.spider.state).toBe('Chasing');
    expect(world.spider.rampageEntranceId).toBe(-1);
    expect(world.spider.rampageRotationEntranceId).toBe(101);
  });

  describe('single open entrance', () => {
    function singleEntranceWorld(): WorldState {
      const world = makeWorld();
      entranceById(world, 103).isOpen = false;
      entranceById(world, 105).isOpen = false;
      world.spider = makeSpider();
      campExpired(world, 101);
      step(world); // timeout on 101 at world.tick
      expect(world.spider.rampageRotationEntranceId).toBe(101);
      return world;
    }

    it('no rampage for the cooldown after the timeout, then it may camp the same entrance again', () => {
      const world = singleEntranceWorld();
      const timedOutAt = world.spider!.rampageRotationTick;
      world.events.length = 0;
      const waited = untilRampage(world, SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS + 5);
      expect(world.events.filter((e) => e.type === 'spider_rampage_start')).toHaveLength(1);
      expect(world.tick - timedOutAt).toBe(SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS);
      expect(waited).toBe(SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS);
      expect(world.spider!.rampageEntranceId).toBe(101);
    });

    it('it still hunts during the cooldown (a dense tile in range → Hunting)', () => {
      const world = singleEntranceWorld();
      const sx = world.spider!.posX >> FP_SHIFT;
      const sy = world.spider!.posY >> FP_SHIFT;
      // Two workers stacked 6 tiles away: out of chase range (4), inside hunt range (12).
      spawnSurfaceWorker(world, C1, sx + 6, sy);
      spawnSurfaceWorker(world, C1, sx + 6, sy);
      world.spider!.nextHuntTick = world.tick + 1;
      step(world);
      expect(world.spider!.state).toBe('Hunting');
    });

    it('a second entrance opening during the cooldown is camped at once', () => {
      const world = singleEntranceWorld();
      step(world);
      expect(world.spider!.state).toBe('Patrolling');
      entranceById(world, 103).isOpen = true;
      step(world);
      expect(world.spider!.state).toBe('Rampaging');
      expect(world.spider!.rampageEntranceId).toBe(103);
    });
  });
});

// ---------------------------------------------------------------------------
// Tick-level: the full tick pipeline, a real scenario world. (Save/load mid-rotation
// and the save validator are in src/platform/spider-rotation-save.test.ts.)
// ---------------------------------------------------------------------------

/** Force the scenario spider onto colony `cid`'s open entrance with its leash expired. */
function forceExpiredCamp(world: WorldState, cid: number): number {
  const e = world.colonies[cid as unknown as ColonyId]!.entrances.find((x) => x.isOpen)!;
  const s = world.spider!;
  s.state = 'Rampaging';
  s.rampageTargetColonyId = cid;
  s.rampageStartTick = world.tick - SPIDER_RAMPAGE_MAX_TICKS; // expires on the next tick
  s.rampageKillsThisRampage = 0;
  s.chaseTargetAntId = -1;
  s.hungerTicks = HUNGRY;
  s.posX = (e.surfaceTileX << FP_SHIFT) + 128;
  s.posY = (e.surfaceTileY << FP_SHIFT) + 128;
  return e.entranceId;
}

function runTicks(world: WorldState, n: number): void {
  for (let i = 0; i < n; i++) tick(world, world.commandQueue.splice(0));
}

describe('V54 (#337) — tick-level', () => {
  it('in a scenario world, a timeout on one colony moves the next rampage to the other colony', () => {
    let rotatedSeeds = 0;
    for (const seed of [1, 2, 3, 4]) {
      const world = createScenario(seed);
      runTicks(world, 2000);
      if (world.spider === null) continue;
      const doorId = forceExpiredCamp(world, PLAYER_COLONY_ID);
      tick(world, world.commandQueue.splice(0));
      const s = world.spider;
      // A fighter in range (self-defense) or a kill can pre-empt the leash; this test
      // wants the plain timeout.
      if (s === null || s.state !== 'Patrolling' || s.hungerTicks === 0) continue;
      expect(s.rampageRotationEntranceId).toBe(doorId);
      // Every rampage it starts from here, until it kills, is on another entrance.
      for (let i = 0; i < 400 && world.spider !== null && world.spider.hungerTicks !== 0; i++) {
        tick(world, world.commandQueue.splice(0));
        const sp = world.spider;
        if (sp !== null && sp.state === 'Rampaging') {
          expect(sp.rampageEntranceId).not.toBe(doorId);
          expect(sp.rampageTargetColonyId).toBe(ENEMY_COLONY_ID);
          rotatedSeeds++;
          break;
        }
      }
    }
    expect(rotatedSeeds).toBeGreaterThan(0);
  }, 60_000); // several thousand full-pipeline ticks; generous for loaded CI runners
});
