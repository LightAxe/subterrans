// health.test.ts — #400 (V71): max HP by territory and healing while fed and safe.
import { describe, it, expect } from 'vitest';
import { antMaxHp, antOnHomeGround, isSafeFromHits, tickHealth } from './health.js';
import { createWorldState, allocateEntityId } from './types.js';
import type { WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import { AntTask } from './enums.js';
import { Zone } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { detectAndResolveCombat } from './combat.js';
import { Rng } from './rng.js';
import {
  ANT_HEAL_INTERVAL_TICKS,
  COMBAT_COOLDOWN_TICKS,
  COMBAT_DAMAGE_BASE,
  COMBAT_HP_BASE,
  COMBAT_HP_HOMEGROUND_BONUS,
  COMBAT_HP_QUEEN,
  HEAL_SAFE_TICKS,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  QUEEN_HP_HOME,
  SPIDER_HEAL_INTERVAL_TICKS,
  SPIDER_HP_FULL,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  WORKER_MEAL_INTERVAL_TICKS,
} from './constants.js';

const HOME_MAX = COMBAT_HP_BASE + COMBAT_HP_HOMEGROUND_BONUS;

/** Two colonies (1 and 2), each a queen on the surface and no workers. */
function twoColonies(): WorldState {
  const world = createWorldState(5);
  for (const cid of [1, 2]) {
    const q = allocateEntityId(world);
    initAnt(world.ants, q, {
      colonyId: cid,
      posX: 0,
      posY: 0,
      task: AntTask.Idle,
      hp: COMBAT_HP_QUEEN,
    });
    const colony = createColonyRecord(cid, q);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[cid] = colony;
  }
  return world;
}

/** A worker of `cid` at tile (5, 7) in `zone` (underground: inside grid `gridCid`). */
function addWorker(
  world: WorldState,
  cid: number,
  zone: Zone,
  gridCid = cid,
  task: number = AntTask.Idle,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: cid,
    posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
    posY: (7 << FP_SHIFT) + (FP_ONE >> 1),
    task,
    zone,
    lastMealTick: world.tick, // fed
  });
  world.ants.currentGridColonyId[id] = gridCid;
  world.colonies[cid]!.workers.push(id);
  world.colonies[cid]!.workerCount += 1;
  return id;
}

/** Advance world.tick to the next multiple of `interval` (a heal tick), or stay. */
function toHealTick(world: WorldState, interval: number): void {
  while (world.tick % interval !== 0) world.tick += 1;
}

describe('#400 max HP by territory (antMaxHp / antOnHomeGround)', () => {
  it('a worker: 16 on the surface, 20 in its own nest, 16 in a foreign nest — for every colony (CLNY-08)', () => {
    const world = twoColonies();
    for (const [cid, other] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const surface = addWorker(world, cid, Zone.Surface);
      const home = addWorker(world, cid, Zone.Underground);
      const foreign = addWorker(world, cid, Zone.Underground, other);
      expect(antOnHomeGround(world, surface)).toBe(false);
      expect(antOnHomeGround(world, home)).toBe(true);
      expect(antOnHomeGround(world, foreign)).toBe(false);
      expect(antMaxHp(world, surface)).toBe(COMBAT_HP_BASE);
      expect(antMaxHp(world, home)).toBe(HOME_MAX);
      expect(antMaxHp(world, foreign)).toBe(COMBAT_HP_BASE);
    }
    expect(HOME_MAX).toBe(20);
    expect(COMBAT_HP_BASE).toBe(16);
  });

  it('the queen: her base away, QUEEN_HP_HOME (+4) in her nest', () => {
    const world = twoColonies();
    for (const cid of [1, 2]) {
      const q = world.colonies[cid]!.queenEntityId;
      expect(antMaxHp(world, q)).toBe(COMBAT_HP_QUEEN);
      world.ants.zone[q] = Zone.Underground;
      expect(antMaxHp(world, q)).toBe(QUEEN_HP_HOME);
      expect(QUEEN_HP_HOME).toBe(COMBAT_HP_QUEEN + COMBAT_HP_HOMEGROUND_BONUS);
    }
  });

  it('safe: never hit, or HEAL_SAFE_TICKS or more since the last blow', () => {
    expect(isSafeFromHits(-1, 0)).toBe(true);
    expect(isSafeFromHits(100, 100 + HEAL_SAFE_TICKS - 1)).toBe(false);
    expect(isSafeFromHits(100, 100 + HEAL_SAFE_TICKS)).toBe(true);
    expect(isSafeFromHits(0, 0)).toBe(false);
  });
});

describe('#400 tickHealth — clamping (leaving home lowers the max; coming home does not heal)', () => {
  it('a full ant that leaves its nest clamps to the away max; a wounded one keeps its HP', () => {
    const world = twoColonies();
    world.tick = 7; // not a heal tick
    const full = addWorker(world, 1, Zone.Underground);
    const wounded = addWorker(world, 1, Zone.Underground);
    world.ants.hp[full] = HOME_MAX;
    world.ants.hp[wounded] = 12;
    world.ants.zone[full] = Zone.Surface; // both step out
    world.ants.zone[wounded] = Zone.Surface;
    tickHealth(world);
    expect(world.ants.hp[full]).toBe(COMBAT_HP_BASE);
    expect(world.ants.hp[wounded]).toBe(12);
  });

  it('a full ant that enters a foreign nest clamps too', () => {
    const world = twoColonies();
    const invader = addWorker(world, 2, Zone.Underground, 1);
    world.ants.hp[invader] = HOME_MAX;
    tickHealth(world);
    expect(world.ants.hp[invader]).toBe(COMBAT_HP_BASE);
  });

  it('coming home raises the max but does not heal: HP grows only by the heal schedule', () => {
    const world = twoColonies();
    const ant = addWorker(world, 1, Zone.Surface);
    world.ants.hp[ant] = COMBAT_HP_BASE;
    world.ants.zone[ant] = Zone.Underground; // it comes home
    world.tick = 1; // not a heal tick
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(COMBAT_HP_BASE);
    toHealTick(world, ANT_HEAL_INTERVAL_TICKS);
    world.ants.lastMealTick[ant] = world.tick;
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(COMBAT_HP_BASE + 1); // one step, not straight to 20
  });

  it('the queen clamps the same way (staged: above her surface max on the surface)', () => {
    const world = twoColonies();
    const q = world.colonies[2]!.queenEntityId;
    world.ants.hp[q] = QUEEN_HP_HOME;
    tickHealth(world);
    expect(world.ants.hp[q]).toBe(COMBAT_HP_QUEEN);
  });
});

describe('#400 tickHealth — ants heal 1 HP per interval while fed, safe and on home ground', () => {
  function woundedAtHome(): { world: WorldState; ant: number } {
    const world = twoColonies();
    world.tick = 1000;
    toHealTick(world, ANT_HEAL_INTERVAL_TICKS);
    const ant = addWorker(world, 1, Zone.Underground);
    world.ants.hp[ant] = 10;
    world.ants.lastMealTick[ant] = world.tick; // fed
    return { world, ant };
  }

  it('fed, safe, at home, on a heal tick: +1', () => {
    const { world, ant } = woundedAtHome();
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(11);
  });

  it('nothing on the ticks between heal ticks', () => {
    const { world, ant } = woundedAtHome();
    for (let k = 1; k < ANT_HEAL_INTERVAL_TICKS; k++) {
      world.tick += 1;
      tickHealth(world);
      expect(world.ants.hp[ant], `tick ${world.tick}`).toBe(10);
    }
  });

  it('not while hungry (a meal is due)', () => {
    const { world, ant } = woundedAtHome();
    world.ants.lastMealTick[ant] = world.tick - WORKER_MEAL_INTERVAL_TICKS;
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(10);
    world.ants.lastMealTick[ant] = world.tick - (WORKER_MEAL_INTERVAL_TICKS - 1); // still fed
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(11);
  });

  it('not until HEAL_SAFE_TICKS have passed since its last blow (boundary)', () => {
    const { world, ant } = woundedAtHome();
    world.ants.lastHitTick[ant] = world.tick - HEAL_SAFE_TICKS + 1;
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(10);
    world.ants.lastHitTick[ant] = world.tick - HEAL_SAFE_TICKS;
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(11);
  });

  it('not on the surface nor in a foreign nest, fed and safe', () => {
    const { world, ant } = woundedAtHome();
    world.ants.zone[ant] = Zone.Surface;
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(10);
    world.ants.zone[ant] = Zone.Underground;
    world.ants.currentGridColonyId[ant] = 2;
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(10);
  });

  it('a fighter heals the same way (its own hunger profile), up to the home max and no further', () => {
    const { world, ant } = woundedAtHome();
    world.ants.task[ant] = AntTask.Fighting;
    for (let k = 0; k < 20 * ANT_HEAL_INTERVAL_TICKS; k++) {
      world.ants.lastMealTick[ant] = world.tick; // kept fed
      tickHealth(world);
      world.tick += 1;
    }
    expect(world.ants.hp[ant]).toBe(HOME_MAX);
  });

  it('brood and the dead do not heal', () => {
    const { world, ant } = woundedAtHome();
    world.ants.alive[ant] = 0; // a dead slot left in the roster until death cleanup
    const larva = allocateEntityId(world);
    initAnt(world.ants, larva, {
      colonyId: 1,
      posX: 0,
      posY: 0,
      task: AntTask.Idle,
      zone: Zone.Underground,
      hp: 10,
      lastMealTick: world.tick,
    });
    world.colonies[1]!.larvae.push(larva);
    tickHealth(world);
    expect(world.ants.hp[ant]).toBe(10);
    expect(world.ants.hp[larva]).toBe(10);
  });
});

describe('#400 tickHealth — the spider heals anywhere while fed and safe', () => {
  function woundedSpider(): WorldState {
    const world = createScenario(3, 'Normal');
    world.tick = 4000;
    toHealTick(world, SPIDER_HEAL_INTERVAL_TICKS);
    const spider = world.spider!;
    spider.hp = 50;
    spider.hungerTicks = 0; // just ate
    spider.lastHitTick = -1;
    return world;
  }

  it('fed and safe on a heal tick: +1, on the surface (it has no home)', () => {
    const world = woundedSpider();
    tickHealth(world);
    expect(world.spider!.hp).toBe(51);
    world.tick += 1;
    tickHealth(world); // not a heal tick
    expect(world.spider!.hp).toBe(51);
  });

  it('not while hungry (past its tier threshold)', () => {
    const world = woundedSpider();
    world.spider!.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1];
    tickHealth(world);
    expect(world.spider!.hp).toBe(50);
    world.spider!.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1] - 1;
    tickHealth(world);
    expect(world.spider!.hp).toBe(51);
  });

  it('not until HEAL_SAFE_TICKS after the last blow (boundary)', () => {
    const world = woundedSpider();
    world.spider!.lastHitTick = world.tick - HEAL_SAFE_TICKS + 1;
    tickHealth(world);
    expect(world.spider!.hp).toBe(50);
    world.spider!.lastHitTick = world.tick - HEAL_SAFE_TICKS;
    tickHealth(world);
    expect(world.spider!.hp).toBe(51);
  });

  it('capped at SPIDER_HP_FULL; a dying spider (hp <= 0) never heals', () => {
    const world = woundedSpider();
    world.spider!.hp = SPIDER_HP_FULL;
    tickHealth(world);
    expect(world.spider!.hp).toBe(SPIDER_HP_FULL);
    world.spider!.hp = 0;
    tickHealth(world);
    expect(world.spider!.hp).toBe(0);
  });
});

describe('#400 combat stamps the spider when an ant lands a blow on it', () => {
  it('non-swarm: the fighter strikes after its windup; spider.lastHitTick = that tick', () => {
    const world = createScenario(3, 'Normal');
    const spider = world.spider!;
    spider.state = 'Chasing';
    const tx = spider.posX >> FP_SHIFT;
    const ty = spider.posY >> FP_SHIFT;
    const f = allocateEntityId(world);
    initAnt(world.ants, f, {
      colonyId: PLAYER_COLONY_ID,
      posX: (tx << FP_SHIFT) + (FP_ONE >> 1),
      posY: (ty << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
    });
    world.tick = 4000;
    const rng = new Rng(world.rngState);
    detectAndResolveCombat(world, rng); // pairing (windup)
    expect(spider.lastHitTick).toBe(-1);
    for (let k = 1; k <= COMBAT_COOLDOWN_TICKS; k++) {
      world.tick = 4000 + k;
      detectAndResolveCombat(world, rng);
    }
    expect(spider.hp).toBe(SPIDER_HP_FULL - COMBAT_DAMAGE_BASE);
    expect(spider.lastHitTick).toBe(4000 + COMBAT_COOLDOWN_TICKS);
    expect(world.ants.lastHitTick[f]).toBe(4000 + COMBAT_COOLDOWN_TICKS); // it bit back
  });
});

describe('#400 step 16f runs after movement and before combat (through tick())', () => {
  it('an ant above its away max on the surface is clamped before the fight lands', () => {
    const world = createScenario(9, 'Normal');
    world.spider = null; // keep the spider out of it
    // Two enemy fighters on one open surface tile far from both nests.
    const tx = 64;
    const ty = 100;
    const ids: number[] = [];
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: cid,
        posX: (tx << FP_SHIFT) + (FP_ONE >> 1),
        posY: (ty << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Fighting,
        speed: 0, // held on the tile through step 16, so the fight is certain
        lastMealTick: world.tick,
      });
      world.colonies[cid]!.workers.push(id);
      world.colonies[cid]!.workerCount += 1;
      ids.push(id);
    }
    const [mine, theirs] = ids as [number, number];
    // Staged: mine just came up from its nest at full home HP (as movement would
    // leave it before step 16f).
    world.ants.hp[mine] = HOME_MAX;
    tick(world, []);
    // Both fighters struck on the first contested tick. Clamped first (16 → 12), not
    // hit at 20 and clamped after (16).
    expect(world.ants.posX[mine]! >> FP_SHIFT).toBe(world.ants.posX[theirs]! >> FP_SHIFT);
    expect(world.ants.hp[theirs]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_BASE);
    expect(world.ants.hp[mine]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_BASE);
  });
});
