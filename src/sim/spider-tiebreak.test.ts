// src/sim/spider-tiebreak.test.ts — V39 spider seat-bias tie-breaks.
//
// Pre-V39 every spider target selection resolved an exact tie on an ascending id:
// ascending colonyId in pickRampageTarget, ascending ant entity id in
// findChaseTarget / findNearestAttackingFighter, ascending tile slot in
// resolveSpiderCombatOnTile. Colony 1's ants always hold the lower entity ids, so
// that handed colony 1 the losing end of every tie — measurably (colony 1's queen
// died first in 55.25% of 800 passive runs, z = +2.97). V39 replaces each id ordering
// with a deterministic hash32 key, and changes nothing else — in particular the
// rampage SCORE stays `colonyPoolFood + workerCount * 10`.
//
// These tests pin BOTH sides of every gate: the V39 coin behaviour AND the pre-V39
// id behaviour a save inside the acceptance window still replays under.

import { describe, it, expect } from 'vitest';
import type { WorldState, SpiderState, SpiderBehaviorState } from './types.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V38_FORAGER_DOORSTEP_PUSH,
  SIM_VERSION_V39_SPIDER_TIEBREAK,
} from './types.js';
import { hash32 } from './hash.js';
import { tickSpider } from './spider.js';
import { resolveSpiderCombatOnTile } from './combat.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, ChamberType, PheromoneType } from './enums.js';
import { createPheromoneGrid, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyId, ColonyRecord } from './colony/colony-store.js';
import { setPoolFoodForTest, addChamberForTest, type TestChamber } from './food/food-test-utils.js';
import {
  SPIDER_HP_FULL,
  SPIDER_HUNT_INTERVAL_TICKS,
  SPIDER_HUNGER_MAX_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_CHASE_TRIGGER_RADIUS,
  SPIDER_DEFENSE_TRIGGER_RADIUS,
  SPIDER_SWARM_FIGHTER_THRESHOLD,
  COMBAT_COOLDOWN_TICKS,
  SURFACE_GRID_WIDTH,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { Zone } from './terrain.js';

// V39's immediate predecessor — what a save one version below the gate replays under.
const PRE_V39 = SIM_VERSION_V38_FORAGER_DOORSTEP_PUSH;

const C1 = PLAYER_COLONY_ID as unknown as ColonyId;
const C2 = ENEMY_COLONY_ID as unknown as ColonyId;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    hungerTicks: 0,
    nextHuntTick: SPIDER_HUNT_INTERVAL_TICKS,
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
    ...overrides,
  };
}

/**
 * Two-colony world with real queen entities (both spider selectors exclude
 * colony.queenEntityId, so the queens must be actual ant slots) and the surface
 * DangerTrail grids the spider deposits into.
 */
function makeWorld(seed: number, simVersion: number): WorldState {
  const world = createWorldState(seed);
  world.simVersion = simVersion;
  for (const cid of [C1, C2]) {
    const queen = allocateEntityId(world);
    initAnt(world.ants, queen, {
      colonyId: cid,
      posX: 0,
      posY: 0,
      task: AntTask.Idle,
      speed: 0,
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
  return world;
}

function spawnAnt(
  world: WorldState,
  colonyId: ColonyId,
  tileX: number,
  tileY: number,
  task: AntTask = AntTask.Foraging,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task,
    speed: WORKER_BASE_SPEED,
    zone: Zone.Surface,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

function foodChamberLiteral(chamberId: number): TestChamber {
  return {
    chamberId,
    chamberType: ChamberType.FoodStorage,
    posX: 10 << FP_SHIFT,
    posY: 10 << FP_SHIFT,
    width: 2,
    height: 2,
  };
}

/** Push a FoodStorage chamber holding `stockFp` onto `colony.chambers`. */
function addFoodChamber(
  world: WorldState,
  colony: ColonyRecord,
  chamberId: number,
  stockFp: number,
): void {
  addChamberForTest(world, colony, foodChamberLiteral(chamberId), stockFp);
}

/** Mirror of spider.ts's private 60/40 richer-colony draw. */
function favorsIndexZero(world: WorldState, rampageStartTick: number): boolean {
  return hash32(world.terrainSeed ^ rampageStartTick) % 100 < 60;
}

/** Mirror of spider.ts's private V39 per-colony rampage tie key (SPIDER_TIEBREAK_SALT). */
function rampageTieKey(world: WorldState, tick: number, colonyId: number): number {
  return hash32(world.terrainSeed ^ tick ^ 0x5bf03635 ^ colonyId);
}

/** The colony V39 sorts to index 0 on an exact score tie (lower tie key wins). */
function tieWinner(world: WorldState, tick: number): number {
  return rampageTieKey(world, tick, PLAYER_COLONY_ID) <= rampageTieKey(world, tick, ENEMY_COLONY_ID)
    ? PLAYER_COLONY_ID
    : ENEMY_COLONY_ID;
}

/** Mirror of spider.ts's private V39 per-ant chase/defense tie key. */
function antTieKey(world: WorldState, antId: number): number {
  return hash32(world.terrainSeed ^ world.tick ^ antId);
}

/** Mirror of combat.ts's private V39 tick-FREE on-tile tie key. */
function spiderAntTieKey(world: WorldState, antId: number): number {
  return hash32(world.terrainSeed ^ antId);
}

/**
 * Drive one Patrolling → Rampaging entry at `tick` and return the colony the
 * spider picked. `hungerTicks` is set over the Normal-tier threshold and the tick
 * is past the start-of-match grace, so the rampage branch is the one taken (no
 * ants exist, so neither the chase nor the density hunt can pre-empt it).
 */
function rampageTargetAtTick(world: WorldState, tick: number): number {
  world.tick = tick;
  world.spider = makeSpider({
    state: 'Patrolling',
    hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
    nextHuntTick: tick + SPIDER_HUNT_INTERVAL_TICKS, // hunt on cooldown → camp
  });
  tickSpider(world);
  return world.spider.rampageTargetColonyId;
}

// ---------------------------------------------------------------------------
// 1. pickRampageTarget — score source + tie coin
// ---------------------------------------------------------------------------

describe('pickRampageTarget — V39 seat-bias fix', () => {
  const TICKS = Array.from({ length: 200 }, (_, i) => SPIDER_GRACE_TICKS + i * 37);

  /** Both colonies tied on score: equal pool food, equal worker counts. */
  function tiedWorld(seed: number, simVersion: number): WorldState {
    const world = makeWorld(seed, simVersion);
    for (const cid of [C1, C2]) {
      setPoolFoodForTest(world, world.colonies[cid]!, 4096);
      world.colonies[cid]!.workerCount = 7;
    }
    return world;
  }

  it('V39: an exact score tie is broken by the tie key, not by ascending colony id', () => {
    const world = tiedWorld(42, SIM_VERSION_V39_SPIDER_TIEBREAK);
    for (const t of TICKS) {
      const indexZero = tieWinner(world, t);
      const indexOne = indexZero === PLAYER_COLONY_ID ? ENEMY_COLONY_ID : PLAYER_COLONY_ID;
      const expected = favorsIndexZero(world, t) ? indexZero : indexOne;
      expect(rampageTargetAtTick(world, t)).toBe(expected);
    }
  });

  it('V39: the tied-score split goes from lopsided to near even (paired arms, same ticks)', () => {
    // Counts, not fractions: src/sim/ bans float division and float literals, tests
    // included — so every rate assertion below is cross-multiplied into integers.
    const N = TICKS.length;
    function colony1Picks(simVersion: number): number {
      const world = tiedWorld(42, simVersion);
      let c1 = 0;
      for (const t of TICKS) if (rampageTargetAtTick(world, t) === PLAYER_COLONY_ID) c1 += 1;
      return c1;
    }
    const oldCount = colony1Picks(PRE_V39);
    const newCount = colony1Picks(SIM_VERSION_V39_SPIDER_TIEBREAK);
    // Pre-V39 the ascending-colonyId sort pins colony 1 at index 0 on every tie, so
    // the 60/40 weighting lands on one seat — the structural advantage this fixes.
    // oldCount / N > 55/100:
    expect(oldCount * 100).toBeGreaterThan(55 * N);
    // V39 folds in an independent order coin → ~50%. |newCount / N - 1/2| < 6/100:
    expect(Math.abs(newCount * 2 - N) * 100).toBeLessThan(12 * N);
    expect(newCount).toBeLessThan(oldCount);
  });

  it('pre-V39: an exact score tie still sorts colony 1 first (the old, biased rule)', () => {
    const world = tiedWorld(42, PRE_V39);
    let c1 = 0;
    for (const t of TICKS) {
      // Ascending colonyId tiebreak ⇒ index 0 is ALWAYS colony 1.
      const expected = favorsIndexZero(world, t) ? PLAYER_COLONY_ID : ENEMY_COLONY_ID;
      expect(rampageTargetAtTick(world, t)).toBe(expected);
      if (expected === PLAYER_COLONY_ID) c1 += 1;
    }
    // ... which is exactly the 60/40 weighting pointed at one seat (c1 / N > 1/2).
    expect(c1 * 2).toBeGreaterThan(TICKS.length);
  });

  it('V39 leaves the SCORE on the entrance pool — FoodStorage chambers do not count', () => {
    // V39 changes the tiebreak, not the score. Scoring on colonyFoodTotal was
    // considered and deferred (see pickRampageTarget): colony 2 here holds far more
    // total food but a smaller pool, and it must still read as the POORER colony at
    // V39, exactly as at PRE_V39.
    function build(simVersion: number): WorldState {
      const world = makeWorld(7, simVersion);
      setPoolFoodForTest(world, world.colonies[C1]!, 4096);
      setPoolFoodForTest(world, world.colonies[C2]!, 1024);
      addFoodChamber(world, world.colonies[C2]!, 900, 8192); // ignored by the score
      return world;
    }
    const v39 = build(SIM_VERSION_V39_SPIDER_TIEBREAK);
    const old = build(PRE_V39);
    // Pick a tick where the 60/40 draw favours index 0 so "richer" is observable.
    const t = TICKS.find((tk) => favorsIndexZero(v39, tk))!;
    expect(t).toBeDefined();
    expect(rampageTargetAtTick(v39, t)).toBe(PLAYER_COLONY_ID); // bigger POOL wins
    expect(rampageTargetAtTick(old, t)).toBe(PLAYER_COLONY_ID); // unchanged from pre-V39
  });

  it('V39: a genuine score gap still decides the order (the key only breaks exact ties)', () => {
    const world = makeWorld(11, SIM_VERSION_V39_SPIDER_TIEBREAK);
    setPoolFoodForTest(world, world.colonies[C1]!, 64);
    setPoolFoodForTest(world, world.colonies[C2]!, 9999);
    for (const t of TICKS) {
      const expected = favorsIndexZero(world, t) ? ENEMY_COLONY_ID : PLAYER_COLONY_ID;
      expect(rampageTargetAtTick(world, t)).toBe(expected);
    }
  });

  it('V39: worker count still decides when the POOL is equal (the term is not dead)', () => {
    // The worker term is the score's only discriminator once both pools peg at
    // BASE_FOOD_STORAGE_CAPACITY — which is the common steady state, and the reason
    // ~36% of picks tie. Pin that V39 leaves it doing that job. Chambers differ here
    // and must not matter.
    const world = makeWorld(13, SIM_VERSION_V39_SPIDER_TIEBREAK);
    setPoolFoodForTest(world, world.colonies[C1]!, 2048);
    addFoodChamber(world, world.colonies[C1]!, 901, 3072); // ignored by the score
    setPoolFoodForTest(world, world.colonies[C2]!, 2048);
    addFoodChamber(world, world.colonies[C2]!, 902, 4096); // ignored by the score
    world.colonies[C1]!.workerCount = 3;
    world.colonies[C2]!.workerCount = 30; // + 300 → colony 2 scores higher
    for (const t of TICKS) {
      const expected = favorsIndexZero(world, t) ? ENEMY_COLONY_ID : PLAYER_COLONY_ID;
      expect(rampageTargetAtTick(world, t)).toBe(expected);
    }
  });

  it('V39: three tied colonies split evenly (a bare order-reversing coin would not)', () => {
    // A coin that only chose ascending-vs-descending colonyId reaches just [1,2,3] and
    // [3,2,1], so the middle colony would take 40% of picks against 30% each for the
    // outer two. Per-colony keys make every permutation reachable.
    const world = makeWorld(21, SIM_VERSION_V39_SPIDER_TIEBREAK);
    const C3 = 3 as unknown as ColonyId;
    const queen3 = allocateEntityId(world);
    initAnt(world.ants, queen3, {
      colonyId: C3,
      posX: 0,
      posY: 0,
      task: AntTask.Idle,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    const colony3 = createColonyRecord(C3, queen3);
    colony3.entrances = [];
    colony3.rallyPoint = null;
    colony3.digFlowFieldDirty = false;
    world.colonies[C3] = colony3;
    for (const cid of [C1, C2, C3]) {
      setPoolFoodForTest(world, world.colonies[cid]!, 4096);
      world.colonies[cid]!.workerCount = 7;
    }

    const picks = [0, 0, 0];
    for (const t of TICKS) picks[rampageTargetAtTick(world, t) - 1]! += 1;
    const N = TICKS.length;
    for (const count of picks) {
      // Each colony should land near N/3. Integer band (src/sim/ bans float division):
      // 25/100 < count/N < 42/100 — wide enough for 200 samples, tight enough to
      // reject the 40/30/30 shape a single order-reversing coin produces.
      expect(count * 100).toBeGreaterThan(25 * N);
      expect(count * 100).toBeLessThan(42 * N);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. findChaseTarget — equal-distance tie between two colonies' ants
// ---------------------------------------------------------------------------

describe('findChaseTarget — V39 equal-distance tie coin', () => {
  const SX = 64;
  const SY = 32;
  const D = SPIDER_CHASE_TRIGGER_RADIUS - 1; // inside the trigger radius, not adjacent

  /** One ant of each colony exactly D tiles from the spider, opposite sides. */
  function twoEquidistantAnts(world: WorldState): { a1: number; a2: number } {
    const a1 = spawnAnt(world, C1, SX - D, SY);
    const a2 = spawnAnt(world, C2, SX + D, SY);
    return { a1, a2 };
  }

  function chaseTargetAtTick(world: WorldState, tick: number): number {
    world.tick = tick;
    world.spider = makeSpider({
      state: 'Patrolling',
      posX: SX << FP_SHIFT,
      posY: SY << FP_SHIFT,
      hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
    });
    tickSpider(world);
    expect(world.spider.state).toBe('Chasing');
    return world.spider.chaseTargetAntId;
  }

  it('V39: the lower antTieKey wins the tie, and both ants are reachable across ticks', () => {
    const world = makeWorld(3, SIM_VERSION_V39_SPIDER_TIEBREAK);
    const { a1, a2 } = twoEquidistantAnts(world);
    let pickedA2 = 0;
    for (let i = 0; i < 200; i++) {
      const t = SPIDER_GRACE_TICKS + i * 13;
      world.tick = t; // antTieKey reads world.tick
      const expected = antTieKey(world, a1) <= antTieKey(world, a2) ? a1 : a2;
      expect(chaseTargetAtTick(world, t)).toBe(expected);
      if (expected === a2) pickedA2 += 1;
    }
    // The higher-id (colony 2) ant must win a healthy share — under the old rule it
    // could never win a single tie.
    expect(pickedA2).toBeGreaterThan(60);
    expect(pickedA2).toBeLessThan(140);
  });

  it('pre-V39: the lower entity id always wins the tie (colony 1, every time)', () => {
    const world = makeWorld(3, PRE_V39);
    const { a1, a2 } = twoEquidistantAnts(world);
    expect(a1).toBeLessThan(a2);
    for (let i = 0; i < 50; i++) {
      expect(chaseTargetAtTick(world, SPIDER_GRACE_TICKS + i * 13)).toBe(a1);
    }
  });

  it('V39: a strictly nearer ant still wins regardless of its coin', () => {
    const world = makeWorld(3, SIM_VERSION_V39_SPIDER_TIEBREAK);
    spawnAnt(world, C1, SX - D, SY); // farther
    const near = spawnAnt(world, C2, SX + 1, SY); // strictly nearer
    for (let i = 0; i < 50; i++) {
      expect(chaseTargetAtTick(world, SPIDER_GRACE_TICKS + i * 13)).toBe(near);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. findNearestAttackingFighter — same treatment on the self-defense divert
// ---------------------------------------------------------------------------

describe('findNearestAttackingFighter — V39 equal-distance tie coin', () => {
  const SX = 64;
  const SY = 32;
  const D = SPIDER_DEFENSE_TRIGGER_RADIUS - 2;

  function attackerAtTick(world: WorldState, tick: number): number {
    world.tick = tick;
    world.spider = makeSpider({
      state: 'Patrolling',
      posX: SX << FP_SHIFT,
      posY: SY << FP_SHIFT,
      hungerTicks: 0, // sated: only the self-defense divert can move it
    });
    tickSpider(world);
    expect(world.spider.state).toBe('Chasing');
    return world.spider.chaseTargetAntId;
  }

  it('V39: the lower antTieKey wins, and the colony-2 fighter is reachable', () => {
    const world = makeWorld(5, SIM_VERSION_V39_SPIDER_TIEBREAK);
    const f1 = spawnAnt(world, C1, SX - D, SY, AntTask.Fighting);
    const f2 = spawnAnt(world, C2, SX + D, SY, AntTask.Fighting);
    let pickedF2 = 0;
    for (let i = 0; i < 200; i++) {
      const t = SPIDER_GRACE_TICKS + i * 17;
      world.tick = t;
      const expected = antTieKey(world, f1) <= antTieKey(world, f2) ? f1 : f2;
      expect(attackerAtTick(world, t)).toBe(expected);
      if (expected === f2) pickedF2 += 1;
    }
    expect(pickedF2).toBeGreaterThan(60);
    expect(pickedF2).toBeLessThan(140);
  });

  it('pre-V39: the lower entity id always wins (colony 1, every time)', () => {
    const world = makeWorld(5, PRE_V39);
    const f1 = spawnAnt(world, C1, SX - D, SY, AntTask.Fighting);
    const f2 = spawnAnt(world, C2, SX + D, SY, AntTask.Fighting);
    expect(f1).toBeLessThan(f2);
    for (let i = 0; i < 50; i++) {
      expect(attackerAtTick(world, SPIDER_GRACE_TICKS + i * 17)).toBe(f1);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. resolveSpiderCombatOnTile — mixed-colony tile slot choice
// ---------------------------------------------------------------------------

describe('resolveSpiderCombatOnTile — V39 on-tile selection key', () => {
  const TX = 20;
  const TY = 20;

  /** Which on-tile ant did the spider pair with? (-2 is the spider sentinel.) */
  function pairedAnt(world: WorldState, candidates: number[]): number {
    const paired = candidates.filter((id) => world.ants.combatOpponentId[id] === -2);
    expect(paired).toHaveLength(1);
    return paired[0]!;
  }

  function mixedTileWorld(
    seed: number,
    simVersion: number,
    task: AntTask = AntTask.Foraging,
  ): { world: WorldState; a1: number; a2: number } {
    const world = makeWorld(seed, simVersion);
    const a1 = spawnAnt(world, C1, TX, TY, task);
    const a2 = spawnAnt(world, C2, TX, TY, task);
    world.spider = makeSpider({
      state: 'Rampaging', // a pursuit state: the resolver engages non-fighters too
      posX: TX << FP_SHIFT,
      posY: TY << FP_SHIFT,
    });
    return { world, a1, a2 };
  }

  it('V39: the lower spiderAntTieKey is engaged, not the lower slot', () => {
    let colony2Wins = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { world, a1, a2 } = mixedTileWorld(seed, SIM_VERSION_V39_SPIDER_TIEBREAK);
      resolveSpiderCombatOnTile(world);
      const expected = spiderAntTieKey(world, a1) <= spiderAntTieKey(world, a2) ? a1 : a2;
      expect(pairedAnt(world, [a1, a2])).toBe(expected);
      if (expected === a2) colony2Wins += 1;
    }
    // Both outcomes reachable across worlds — under the old rule colony 2's ant
    // could never be the engaged one on a mixed tile.
    expect(colony2Wins).toBeGreaterThan(5);
    expect(colony2Wins).toBeLessThan(35);
  });

  it('pre-V39: the lowest slot (colony 1) is engaged on every seed', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { world, a1, a2 } = mixedTileWorld(seed, PRE_V39);
      resolveSpiderCombatOnTile(world);
      expect(pairedAnt(world, [a1, a2])).toBe(a1);
    }
  });

  it('V39: a Fighting ant outranks a worker even when the worker holds the lower key', () => {
    // Fighter FIRST (lower slot), worker second. This ordering — unlike the reverse —
    // actually exercises the class term of the `better` comparison in
    // resolveSpiderCombatOnTile: with `isFighter !== bestFighter ? isFighter` dropped,
    // the incumbent fighter would be displaced by any worker holding a lower key.
    let exercised = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = makeWorld(seed, SIM_VERSION_V39_SPIDER_TIEBREAK);
      const fighter = spawnAnt(world, C1, TX, TY, AntTask.Fighting);
      const worker = spawnAnt(world, C2, TX, TY, AntTask.Foraging);
      world.spider = makeSpider({
        state: 'Rampaging',
        posX: TX << FP_SHIFT,
        posY: TY << FP_SHIFT,
      });
      resolveSpiderCombatOnTile(world);
      expect(pairedAnt(world, [worker, fighter])).toBe(fighter);
      if (spiderAntTieKey(world, worker) < spiderAntTieKey(world, fighter)) exercised += 1;
    }
    // Guard the guard: at least some seeds must put the worker's key below the
    // fighter's, or the assertion above would pass without the class rule.
    expect(exercised).toBeGreaterThan(5);
  });

  it('V39: two fighters and a lower-key worker — a fighter is still engaged', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const world = makeWorld(seed, SIM_VERSION_V39_SPIDER_TIEBREAK);
      const f1 = spawnAnt(world, C1, TX, TY, AntTask.Fighting);
      const f2 = spawnAnt(world, C2, TX, TY, AntTask.Fighting);
      const worker = spawnAnt(world, C1, TX, TY, AntTask.Foraging);
      world.spider = makeSpider({
        state: 'Rampaging',
        posX: TX << FP_SHIFT,
        posY: TY << FP_SHIFT,
      });
      resolveSpiderCombatOnTile(world);
      const expected = spiderAntTieKey(world, f1) <= spiderAntTieKey(world, f2) ? f1 : f2;
      expect(pairedAnt(world, [f1, f2, worker])).toBe(expected);
    }
  });

  it('V39: a single-colony tile uses the key too (the rule is unconditional)', () => {
    // Deliberately NOT conditioned on the tile being mixed-colony: a rule that
    // switched on tile composition re-targeted live engagements whenever an
    // unrelated ant stepped on or off (see spiderAntTieKey's doc comment).
    let secondWins = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = makeWorld(seed, SIM_VERSION_V39_SPIDER_TIEBREAK);
      const first = spawnAnt(world, C1, TX, TY);
      const second = spawnAnt(world, C1, TX, TY);
      world.spider = makeSpider({
        state: 'Rampaging',
        posX: TX << FP_SHIFT,
        posY: TY << FP_SHIFT,
      });
      resolveSpiderCombatOnTile(world);
      const expected =
        spiderAntTieKey(world, first) <= spiderAntTieKey(world, second) ? first : second;
      expect(pairedAnt(world, [first, second])).toBe(expected);
      if (expected === second) secondWins += 1;
    }
    expect(secondWins).toBeGreaterThan(5);
  });

  it('V39: the engaged ant is STABLE across ticks, so the spider actually lands a bite', () => {
    // The combat tie key is deliberately tick-free. A tick-mixed key would re-pick a
    // different ant every tick, re-running the windup and never decrementing one
    // ant's cooldown to a strike — this test is the regression guard for that.
    const { world, a1, a2 } = mixedTileWorld(9, SIM_VERSION_V39_SPIDER_TIEBREAK);
    resolveSpiderCombatOnTile(world); // tick 0: windup, no damage
    const engaged = pairedAnt(world, [a1, a2]);
    const other = engaged === a1 ? a2 : a1;
    const startHp = world.ants.hp[engaged]!;

    for (let t = 1; t <= COMBAT_COOLDOWN_TICKS; t++) {
      world.tick = t;
      resolveSpiderCombatOnTile(world);
      expect(world.ants.combatOpponentId[engaged]).toBe(-2);
      expect(world.ants.combatOpponentId[other]).not.toBe(-2);
    }
    // Cooldown reached 0 within COMBAT_COOLDOWN_TICKS ticks → the spider bit it.
    expect(world.ants.hp[engaged]!).toBeLessThan(startHp);
    expect(world.ants.hp[other]).toBe(startHp);
  });

  it('V39: an ENEMY ant joining the tile does not by itself re-target the engagement', () => {
    // Regression guard for the reverted mixed-tile gating. When the rule was applied
    // only to mixed-colony tiles, an enemy ant stepping on flipped the RULE (lowest
    // slot → lowest key), so it re-targeted a live engagement mid-windup and reset the
    // spider's cooldown even when the arrival itself did not outrank the incumbent.
    // With one unconditional rule, an arrival displaces the incumbent iff it actually
    // ranks higher — so whenever it does not, the engagement and the windup survive.
    let heldCases = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const world = makeWorld(seed, SIM_VERSION_V39_SPIDER_TIEBREAK);
      const resident = spawnAnt(world, C1, TX, TY);
      world.spider = makeSpider({
        state: 'Rampaging',
        posX: TX << FP_SHIFT,
        posY: TY << FP_SHIFT,
      });
      resolveSpiderCombatOnTile(world); // windup on `resident`
      resolveSpiderCombatOnTile(world); // one cooldown tick burned
      const armed = world.spider.attackCooldown;
      expect(armed).toBeLessThan(COMBAT_COOLDOWN_TICKS);

      // An ant of the OTHER colony steps onto the tile mid-engagement.
      const arrival = spawnAnt(world, C2, TX, TY);
      const arrivalOutranks = spiderAntTieKey(world, arrival) < spiderAntTieKey(world, resident);
      resolveSpiderCombatOnTile(world);

      if (!arrivalOutranks) {
        heldCases += 1;
        expect(pairedAnt(world, [resident, arrival])).toBe(resident); // engagement held
        expect(world.spider.attackCooldown).toBeLessThan(armed); // windup NOT reset
      } else {
        // It genuinely outranks the incumbent, so a hand-over is correct and exactly
        // what the pre-V39 rule did when a LOWER-SLOT ant arrived: the newcomer gets
        // the windup, and — a PRE-EXISTING wart this change does not touch — the
        // abandoned incumbent keeps its stale -2 until the off-tile sweep or
        // clearSpiderPairingSentinels clears it.
        expect(world.ants.combatOpponentId[arrival]).toBe(-2);
        expect(world.spider.attackCooldown).toBe(COMBAT_COOLDOWN_TICKS); // fresh windup
      }
    }
    // The "held" branch has to be exercised, or the assertion above proves nothing.
    expect(heldCases).toBeGreaterThan(15);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveSpiderCombatOnTile — swarm path (world.spiderPriorityColonyId set)
// ---------------------------------------------------------------------------

describe('resolveSpiderCombatOnTile — V39 swarm retaliation target', () => {
  const TX = 24;
  const TY = 24;

  /**
   * Priority-colony swarm on the spider's tile, plus one ant of the other colony so
   * the tile is genuinely contested. Returns the priority fighters in spawn order.
   */
  function swarmWorld(seed: number, simVersion: number): { world: WorldState; f: number[] } {
    const world = makeWorld(seed, simVersion);
    const f: number[] = [];
    for (let i = 0; i < SPIDER_SWARM_FIGHTER_THRESHOLD; i++) {
      f.push(spawnAnt(world, C1, TX, TY, AntTask.Fighting));
    }
    spawnAnt(world, C2, TX, TY, AntTask.Foraging); // non-priority bystander
    world.spiderPriorityColonyId = PLAYER_COLONY_ID;
    world.spider = makeSpider({
      state: 'Rampaging',
      posX: TX << FP_SHIFT,
      posY: TY << FP_SHIFT,
    });
    return { world, f };
  }

  /** Run until the spider's cooldown fires, then report which fighter it damaged. */
  function retaliationVictim(world: WorldState, f: number[]): number {
    const startHp = f.map((id) => world.ants.hp[id]!);
    for (let t = 0; t <= COMBAT_COOLDOWN_TICKS + 1; t++) {
      world.tick = t;
      resolveSpiderCombatOnTile(world);
      const hit = f.findIndex((id, i) => world.ants.hp[id]! < startHp[i]!);
      if (hit >= 0) return f[hit]!;
    }
    return -1;
  }

  it('V39: the retaliation target is the lowest-key priority fighter, not the lowest slot', () => {
    let nonFirstWins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { world, f } = swarmWorld(seed, SIM_VERSION_V39_SPIDER_TIEBREAK);
      const expected = f.reduce((best, id) =>
        spiderAntTieKey(world, id) < spiderAntTieKey(world, best) ? id : best,
      );
      expect(retaliationVictim(world, f)).toBe(expected);
      if (expected !== f[0]) nonFirstWins += 1;
    }
    // Pre-V39 this was always f[0]; the key must actually move it.
    expect(nonFirstWins).toBeGreaterThan(10);
  });

  it('pre-V39: the retaliation target is the lowest-slot priority fighter on every seed', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { world, f } = swarmWorld(seed, PRE_V39);
      expect(retaliationVictim(world, f)).toBe(f[0]);
    }
  });

  it('V39: the retaliation target is stable across the whole windup (damage is not smeared)', () => {
    const { world, f } = swarmWorld(3, SIM_VERSION_V39_SPIDER_TIEBREAK);
    const startHp = f.map((id) => world.ants.hp[id]!);
    for (let t = 0; t <= COMBAT_COOLDOWN_TICKS + 1; t++) {
      world.tick = t;
      resolveSpiderCombatOnTile(world);
    }
    // Exactly one fighter took spider damage over the episode.
    const hurt = f.filter((id, i) => world.ants.hp[id]! < startHp[i]!);
    expect(hurt).toHaveLength(1);
  });
});
