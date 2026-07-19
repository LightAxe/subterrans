// corpse-food.test.ts — A2 battlefield scavenging (simVersion V37).
//
// Covers PLAN.md "PR 2 — A2" step-9 matrix:
//   - spawnCorpseFood: new pile, top-up (tile-uniqueness + isCorpse fixed-at-birth),
//     clamp to MAX, hard-cap skip-new / allow-top-up, entity-ID exhaustion.
//   - killAnt corpse drop (V37): worker/fighter/queen yields; no-drop for spider-kill,
//     underground, null-colony, null-id (synthetic), non-member, and pre-V37 (gate).
//   - spider-death drop (100) + pre-V37 gate.
//   - soft-ceiling exemption (V37 corpse exempt / natural counts / pre-V37 total-count).
//   - hard-cap backstop + save round-trip safety.
//   - no-barren (V37 corpse depletion skips the recency cooldown; natural records;
//     pre-V37 records regardless; priority pointer clears either way).
//   - version-aware save validator (corpse floor 1 vs natural floor 20; smuggle defense;
//     isCorpse round-trip / pre-V37 drop; corpse-topped natural pile round-trip).
//   - integration: an ordinary forager retrieves corpse food on the following step.
//
// Determinism: every A2 effect is gated `simVersion >= V37`, so the pre-V37 cases here
// double as byte-identical-replay guards (nothing spawns, nothing is counted differently).

import { describe, it, expect } from 'vitest';
import { killAnt } from './combat.js';
import { tickSpider } from './spider.js';
import {
  spawnCorpseFood,
  corpseYield,
  recordFoodPileDepletion,
  tickFoodPileSpawn,
} from './food-system.js';
import { tickForagerActions } from './ant/ant-foraging.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V36_RISK_AWARE_FORAGING,
  SIM_VERSION_V37_CORPSE_FOOD,
} from './types.js';
import type { WorldState, SpiderState, SpiderBehaviorState } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyId } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, ForagingSubState } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { Rng } from './rng.js';
import { createScenario } from './scenario.js';
import { isSurfaceTileInComponent } from './surface-features.js';
import {
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_SOFT_CEILING,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_SPAWN_INTERVAL_TICKS,
  CORPSE_PICKUPS_WORKER,
  CORPSE_PICKUPS_FIGHTER,
  CORPSE_PICKUPS_QUEEN,
  CORPSE_PICKUPS_SPIDER,
  MAX_ENTITIES,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SPIDER_HP_FULL,
  SPIDER_HUNT_INTERVAL_TICKS,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from './constants.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal 2-colony world (surface queens), simVersion pinned by the caller. */
function makeWorld2(
  simVersion: number,
  seed = 42,
): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const world = createWorldState(seed);
  world.simVersion = simVersion;

  const queen1 = allocateEntityId(world);
  initAnt(world.ants, queen1, {
    colonyId: 1,
    posX: 0,
    posY: 0,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    zone: Zone.Surface,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  const colony1 = createColonyRecord(1 as ColonyId, queen1);
  colony1.entrances = [];
  colony1.rallyPoint = null;
  colony1.digFlowFieldDirty = false;
  world.colonies[1] = colony1;

  const queen2 = allocateEntityId(world);
  initAnt(world.ants, queen2, {
    colonyId: 2,
    posX: 1 << FP_SHIFT,
    posY: 0,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    zone: Zone.Surface,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  const colony2 = createColonyRecord(2 as ColonyId, queen2);
  colony2.entrances = [];
  colony2.rallyPoint = null;
  colony2.digFlowFieldDirty = false;
  world.colonies[2] = colony2;

  return { world, cid1: 1 as ColonyId, cid2: 2 as ColonyId };
}

/** Spawn a surface worker (added to the colony's workers[]) at (tileX, tileY). */
function spawnWorker(world: WorldState, colonyId: ColonyId, tileX: number, tileY: number): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    zone: Zone.Surface,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

/** Spawn a surface fighter (AntTask.Fighting, NOT in workers[]) at (tileX, tileY). */
function spawnFighter(world: WorldState, colonyId: ColonyId, tileX: number, tileY: number): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    zone: Zone.Surface,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  return id;
}

function placeSpider(
  world: WorldState,
  tileX: number,
  tileY: number,
  state: SpiderBehaviorState,
): SpiderState {
  const spider: SpiderState = {
    state,
    posX: tileX << FP_SHIFT,
    posY: tileY << FP_SHIFT,
    lairTileX: tileX,
    lairTileY: tileY,
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
  };
  world.spider = spider;
  return spider;
}

/** First `n` walkable-component tiles (row-major) — for save round-trips (load checks reachability). */
function walkableTiles(world: WorldState, n: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SURFACE_GRID_HEIGHT && out.length < n; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH && out.length < n; x++) {
      if (isSurfaceTileInComponent(world, x, y)) out.push({ x, y });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// spawnCorpseFood + corpseYield (unit)
// ---------------------------------------------------------------------------

describe('corpseYield', () => {
  it('returns the fixed per-kind constants (never RNG-drawn)', () => {
    expect(corpseYield('worker')).toBe(CORPSE_PICKUPS_WORKER);
    expect(corpseYield('fighter')).toBe(CORPSE_PICKUPS_FIGHTER);
    expect(corpseYield('queen')).toBe(CORPSE_PICKUPS_QUEEN);
    expect(corpseYield('spider')).toBe(CORPSE_PICKUPS_SPIDER);
  });
});

describe('spawnCorpseFood', () => {
  it('creates a new corpse pile on an empty tile', () => {
    const world = createWorldState(42);
    spawnCorpseFood(world, 4, 4, 5);
    expect(world.foodPiles).toHaveLength(1);
    expect(world.foodPiles[0]).toMatchObject({
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 5,
      pickupsInitial: 5,
      isCorpse: true,
    });
  });

  it('skips a new pile on an off-component (unwalkable) tile — the save-corruption guard', () => {
    // A pile off the single walkable component makes deserializeWorldState throw on
    // load, so spawnCorpseFood must skip such a tile (a dying spider can reach one via
    // terrain-blind movement). Find an off-component tile in a real scenario world.
    const world = createScenario(42);
    world.foodPiles = [];
    let off: { x: number; y: number } | null = null;
    for (let y = 0; y < SURFACE_GRID_HEIGHT && !off; y++) {
      for (let x = 0; x < SURFACE_GRID_WIDTH && !off; x++) {
        if (!isSurfaceTileInComponent(world, x, y)) off = { x, y };
      }
    }
    expect(off).not.toBeNull();
    const idBefore = world.nextEntityId;
    spawnCorpseFood(world, off!.x, off!.y, CORPSE_PICKUPS_SPIDER);
    expect(world.foodPiles).toHaveLength(0); // skipped — would otherwise brick the save
    expect(world.nextEntityId).toBe(idBefore); // and no entity ID was burned
  });

  it('tops up an existing pile instead of adding a second (tile-uniqueness); isCorpse fixed at birth', () => {
    const world = createWorldState(42);
    world.foodPiles.push({
      foodPileId: 1,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 30,
      pickupsInitial: 30,
    });
    spawnCorpseFood(world, 4, 4, 10);
    expect(world.foodPiles).toHaveLength(1); // no second pile on the tile
    expect(world.foodPiles[0]!.pickupsInitial).toBe(40);
    expect(world.foodPiles[0]!.pickupsRemaining).toBe(40);
    expect(world.foodPiles[0]!.isCorpse).toBeUndefined(); // a corpse topping up a natural pile stays natural
  });

  it('clamps a top-up to FOOD_PILE_INITIAL_PICKUPS_MAX', () => {
    const world = createWorldState(42);
    world.foodPiles.push({
      foodPileId: 1,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 100,
      pickupsInitial: 140,
    });
    spawnCorpseFood(world, 4, 4, 100);
    expect(world.foodPiles[0]!.pickupsInitial).toBe(FOOD_PILE_INITIAL_PICKUPS_MAX); // clamp 240 -> 150
    expect(world.foodPiles[0]!.pickupsRemaining).toBe(FOOD_PILE_INITIAL_PICKUPS_MAX); // min(200, 150)
  });

  it('skips a NEW pile at the hard cap but still allows top-ups', () => {
    const world = createWorldState(42);
    for (let i = 0; i < FOOD_PILE_HARD_CAP; i++) {
      world.foodPiles.push({
        foodPileId: 1 + i,
        tileX: i,
        tileY: 0,
        pickupsRemaining: 1,
        pickupsInitial: 1,
        isCorpse: true,
      });
    }
    spawnCorpseFood(world, 500, 500, 5); // new tile -> blocked by hard cap
    expect(world.foodPiles).toHaveLength(FOOD_PILE_HARD_CAP);
    spawnCorpseFood(world, 0, 0, 5); // existing tile (0,0) -> top-up allowed
    expect(world.foodPiles).toHaveLength(FOOD_PILE_HARD_CAP);
    expect(world.foodPiles[0]!.pickupsInitial).toBe(6);
  });

  it('degrades to a silent skip on entity-ID exhaustion; top-ups still succeed', () => {
    const world = createWorldState(42);
    world.nextEntityId = MAX_ENTITIES; // exhausted
    spawnCorpseFood(world, 4, 4, 5); // new pile needs an ID -> skipped
    expect(world.foodPiles).toHaveLength(0);
    expect(world.nextEntityId).toBe(MAX_ENTITIES); // unchanged

    world.foodPiles.push({
      foodPileId: 7,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 2,
      pickupsInitial: 2,
      isCorpse: true,
    });
    spawnCorpseFood(world, 4, 4, 5); // top-up needs no ID
    expect(world.foodPiles[0]!.pickupsInitial).toBe(7);
    expect(world.nextEntityId).toBe(MAX_ENTITIES);
  });
});

// ---------------------------------------------------------------------------
// killAnt corpse drop
// ---------------------------------------------------------------------------

describe('killAnt corpse drop (V37)', () => {
  it('drops 1-charge corpse food when an enemy ant kills a surface worker', () => {
    const { world, cid1, cid2 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const victim = spawnWorker(world, cid1, 5, 7);
    const killer = spawnWorker(world, cid2, 6, 7);
    killAnt(world, victim, cid2, killer, 'Ant');
    const pile = world.foodPiles.find((p) => p.tileX === 5 && p.tileY === 7);
    expect(pile).toBeDefined();
    expect(pile!.pickupsInitial).toBe(CORPSE_PICKUPS_WORKER);
    expect(pile!.isCorpse).toBe(true);
  });

  it('drops corpse food for a surface fighter victim (task === Fighting)', () => {
    const { world, cid1, cid2 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const victim = spawnFighter(world, cid1, 8, 9);
    const killer = spawnWorker(world, cid2, 9, 9);
    killAnt(world, victim, cid2, killer, 'Ant');
    const pile = world.foodPiles.find((p) => p.tileX === 8 && p.tileY === 9);
    expect(pile?.pickupsInitial).toBe(CORPSE_PICKUPS_FIGHTER);
    expect(pile?.isCorpse).toBe(true);
  });

  it('drops an 8-charge queen corpse (forward-compat, inert but deterministic; same-tick)', () => {
    const { world, cid1, cid2 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const queen2 = world.colonies[cid2]!.queenEntityId;
    // makeWorld2 seats queen2 on the off-component y=0 edge; reseat it onto an in-component
    // surface tile so the drop isn't suppressed by spawnCorpseFood's connectivity guard.
    world.ants.posX[queen2] = (5 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[queen2] = (7 << FP_SHIFT) + (FP_ONE >> 1);
    const killer = spawnWorker(world, cid1, 6, 7);
    killAnt(world, queen2, cid1, killer, 'Ant'); // queen2 now at tile (5,7)
    const pile = world.foodPiles.find((p) => p.tileX === 5 && p.tileY === 7);
    expect(pile?.pickupsInitial).toBe(CORPSE_PICKUPS_QUEEN);
    expect(pile?.isCorpse).toBe(true);
  });

  it('does NOT drop for a spider kill', () => {
    const { world, cid1 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const victim = spawnWorker(world, cid1, 5, 7);
    killAnt(world, victim, null, null, 'Spider');
    expect(world.foodPiles).toHaveLength(0);
  });

  it('does NOT drop for an underground death', () => {
    const { world, cid1, cid2 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const victim = spawnWorker(world, cid1, 5, 7);
    world.ants.zone[victim] = Zone.Underground;
    const killer = spawnWorker(world, cid2, 6, 7);
    killAnt(world, victim, cid2, killer, 'Ant');
    expect(world.foodPiles).toHaveLength(0);
  });

  it('does NOT drop when killerColonyId is null', () => {
    const { world, cid1 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const victim = spawnWorker(world, cid1, 5, 7);
    killAnt(world, victim, null, 5, 'Ant');
    expect(world.foodPiles).toHaveLength(0);
  });

  it('does NOT drop for a synthetic non-null-colony/null-id kill (killerId === null)', () => {
    const { world, cid1, cid2 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const victim = spawnWorker(world, cid1, 5, 7);
    killAnt(world, victim, cid2, null, 'Ant'); // the exact synthetic case Codex flagged
    expect(world.foodPiles).toHaveLength(0);
  });

  it('does NOT drop for a non-member victim (not worker/fighter/queen — e.g. brood-like)', () => {
    const { world, cid2 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    const stray = allocateEntityId(world);
    initAnt(world.ants, stray, {
      colonyId: 1, // colony exists, but the ant is NOT in workers[], not fighting, not the queen
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (7 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      zone: Zone.Surface,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    const killer = spawnWorker(world, cid2, 6, 7);
    killAnt(world, stray, cid2, killer, 'Ant');
    expect(world.foodPiles).toHaveLength(0);
  });

  it('pre-V37 (V36): a surface enemy-ant worker kill drops NOTHING (byte-identical legacy)', () => {
    const { world, cid1, cid2 } = makeWorld2(SIM_VERSION_V36_RISK_AWARE_FORAGING);
    const victim = spawnWorker(world, cid1, 5, 7);
    const killer = spawnWorker(world, cid2, 6, 7);
    const nextIdBefore = world.nextEntityId;
    killAnt(world, victim, cid2, killer, 'Ant');
    expect(world.foodPiles).toHaveLength(0);
    expect(world.nextEntityId).toBe(nextIdBefore); // no ID-counter advance -> replay-safe
  });
});

// ---------------------------------------------------------------------------
// Spider-death drop
// ---------------------------------------------------------------------------

describe('spider-death corpse drop', () => {
  it('V37: the spider dying drops a 100-charge corpse cache at its tile', () => {
    const world = createWorldState(42);
    world.simVersion = SIM_VERSION_V37_CORPSE_FOOD;
    const spider = placeSpider(world, 10, 12, 'Chasing');
    spider.hp = 0; // combat brought it down this tick
    tickSpider(world);
    expect(world.spider).toBeNull();
    const pile = world.foodPiles.find((p) => p.tileX === 10 && p.tileY === 12);
    expect(pile?.pickupsInitial).toBe(CORPSE_PICKUPS_SPIDER);
    expect(pile?.isCorpse).toBe(true);
  });

  it('pre-V37 (V36): a spider death drops nothing', () => {
    const world = createWorldState(42);
    world.simVersion = SIM_VERSION_V36_RISK_AWARE_FORAGING;
    const spider = placeSpider(world, 10, 12, 'Chasing');
    spider.hp = 0;
    tickSpider(world);
    expect(world.spider).toBeNull();
    expect(world.foodPiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Soft-ceiling exemption + hard-cap backstop
// ---------------------------------------------------------------------------

describe('tickFoodPileSpawn — soft-ceiling exemption (V37) + hard-cap backstop', () => {
  function fillPiles(world: WorldState, n: number, corpse: boolean): void {
    world.foodPiles = [];
    for (let i = 0; i < n; i++) {
      world.foodPiles.push({
        foodPileId: 9000 + i,
        tileX: 100, // off to the side of the spawn area; distinct rows
        tileY: i,
        pickupsRemaining: corpse ? 1 : 50,
        pickupsInitial: corpse ? 1 : 50,
        ...(corpse ? { isCorpse: true } : {}),
      });
    }
  }

  it('V37: corpse piles are EXEMPT — a natural pile still spawns above the soft ceiling', () => {
    const world = createScenario(42); // simVersion = LATEST (V37)
    fillPiles(world, FOOD_PILE_SOFT_CEILING, true);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    tickFoodPileSpawn(world, new Rng(world.rngState));
    expect(world.foodPiles.length).toBe(FOOD_PILE_SOFT_CEILING + 1); // naturalCount was 0 -> placed
  });

  it('V37: natural piles DO count against the soft ceiling — spawn throttled', () => {
    const world = createScenario(42);
    fillPiles(world, FOOD_PILE_SOFT_CEILING, false);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    tickFoodPileSpawn(world, new Rng(world.rngState));
    expect(world.foodPiles.length).toBe(FOOD_PILE_SOFT_CEILING); // throttled
  });

  it('pre-V37 (V36): counts TOTAL piles, ignoring isCorpse (gate)', () => {
    const world = createScenario(42);
    world.simVersion = SIM_VERSION_V36_RISK_AWARE_FORAGING;
    fillPiles(world, FOOD_PILE_SOFT_CEILING, true); // corpse-flagged, but legacy ignores the flag
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    tickFoodPileSpawn(world, new Rng(world.rngState));
    expect(world.foodPiles.length).toBe(FOOD_PILE_SOFT_CEILING); // legacy total-count throttle
  });

  it('hard-cap backstop: the spawner never pushes past FOOD_PILE_HARD_CAP even with naturalCount 0', () => {
    const world = createScenario(42);
    world.foodPiles = [];
    for (let i = 0; i < FOOD_PILE_HARD_CAP; i++) {
      world.foodPiles.push({
        foodPileId: 1000 + i,
        tileX: 100,
        tileY: i,
        pickupsRemaining: 1,
        pickupsInitial: 1,
        isCorpse: true, // all corpse -> naturalCount is 0, so only the hard cap can stop growth
      });
    }
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    tickFoodPileSpawn(world, new Rng(world.rngState));
    expect(world.foodPiles.length).toBe(FOOD_PILE_HARD_CAP); // naturalCount 0 but hard cap holds
  });
});

// ---------------------------------------------------------------------------
// no-barren
// ---------------------------------------------------------------------------

describe('no-barren (corpse depletion does not seed the natural-spawn cooldown)', () => {
  it('V37: a depleting corpse pile is NOT recorded in recentlyDepletedFood', () => {
    const world = createWorldState(42);
    world.foodPiles.push({
      foodPileId: 7,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 0,
      pickupsInitial: 1,
      isCorpse: true,
    });
    recordFoodPileDepletion(world, 0);
    expect(world.recentlyDepletedFood).toHaveLength(0);
  });

  it('V37: a depleting NATURAL pile IS recorded', () => {
    const world = createWorldState(42);
    world.foodPiles.push({
      foodPileId: 7,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 0,
      pickupsInitial: 30,
    });
    recordFoodPileDepletion(world, 0);
    expect(world.recentlyDepletedFood).toHaveLength(1);
    expect(world.recentlyDepletedFood[0]).toMatchObject({ tileX: 4, tileY: 4 });
  });

  it('pre-V37 (V36): a corpse-flagged pile is recorded regardless (gate)', () => {
    const world = createWorldState(42);
    world.simVersion = SIM_VERSION_V36_RISK_AWARE_FORAGING;
    world.foodPiles.push({
      foodPileId: 7,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 0,
      pickupsInitial: 1,
      isCorpse: true,
    });
    recordFoodPileDepletion(world, 0);
    expect(world.recentlyDepletedFood).toHaveLength(1);
  });

  it('V37: corpse depletion still clears a colony priority pointer', () => {
    const { world, cid1 } = makeWorld2(SIM_VERSION_V37_CORPSE_FOOD);
    world.foodPiles.push({
      foodPileId: 77,
      tileX: 4,
      tileY: 4,
      pickupsRemaining: 0,
      pickupsInitial: 1,
      isCorpse: true,
    });
    world.colonies[cid1]!.priorityFoodPileId = 77;
    recordFoodPileDepletion(world, world.foodPiles.length - 1);
    expect(world.colonies[cid1]!.priorityFoodPileId).toBeNull();
    expect(world.recentlyDepletedFood).toHaveLength(0); // still no-barren
  });
});

// ---------------------------------------------------------------------------
// Integration — an ordinary forager retrieves corpse food
// ---------------------------------------------------------------------------

describe('integration: forager retrieves corpse food', () => {
  it('a SearchingFood forager standing on corpse food picks it up on the following forager step', () => {
    const world = createScenario(42); // V37
    world.foodPiles = [];
    const tile = walkableTiles(world, 1)[0]!;
    // Tick order: corpse food is written at combat (step 17); a forager standing there
    // retrieves it at the forager step (16b) the NEXT tick. Model that: drop, then run
    // tickForagerActions once.
    spawnCorpseFood(world, tile.x, tile.y, CORPSE_PICKUPS_SPIDER); // a 100-charge cache
    const forager = allocateEntityId(world);
    initAnt(world.ants, forager, {
      colonyId: 1,
      posX: (tile.x << FP_SHIFT) + (FP_ONE >> 1),
      posY: (tile.y << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      speed: WORKER_BASE_SPEED,
      zone: Zone.Surface,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    tickForagerActions(world);
    expect(world.ants.subTask[forager]).toBe(ForagingSubState.CarryingFood);
    expect(world.ants.foodCarrying[forager]).toBeGreaterThan(0);
    const pile = world.foodPiles.find((p) => p.tileX === tile.x && p.tileY === tile.y);
    expect(pile?.pickupsRemaining).toBe(CORPSE_PICKUPS_SPIDER - 1); // one charge drained
  });
});
