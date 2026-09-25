// combat-targeting — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-combat-targeting.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import {
  unpackStepDx,
  unpackStepDy,
  updateFightAntTargets,
  pickInvaderUndergroundStep,
  sentryPassesThroughFriends,
} from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V17_COMBAT_AGGRO,
  SIM_VERSION_V23_SPIDER_AGGRO,
  SIM_VERSION_V42_COLONY_ALARM,
  SIM_VERSION_V44_TUNNEL_DEFENCE,
  SIM_VERSION_V45_SENTRY_RING_PASSABLE,
  SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE,
} from '../types.js';
import { SurfaceMovementEffect } from '../surface-features.js';
import { SURFACE_GRID_WIDTH } from '../constants.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { getScratch } from '../scratch.js';
import { AntTask, FightingSubState } from '../enums.js';
import { FIGHT_AGGRO_RADIUS, SPIDER_HP_FULL, SPIDER_HUNT_INTERVAL_TICKS } from '../constants.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Zone, UndergroundTileState, ugSet, createUndergroundGrid } from '../terrain.js';
import type { WorldState, SpiderState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;

const MAX_TEST_ENTITIES = 64;

// ---------------------------------------------------------------------------
// Helper: create world with colony + underground grid for dig/zone tests
// ---------------------------------------------------------------------------

function setupWorldWithUnderground(
  ugWidth = 16,
  ugHeight = 16,
): {
  world: WorldState;
  colony: ColonyRecord;
  underground: ReturnType<typeof createUndergroundGrid>;
  colonyId: number;
} {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  const colonyId = COLONY_ID;
  const colony = createColonyRecord(colonyId, 0);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[colonyId] = colony;

  const underground = createUndergroundGrid(ugWidth, ugHeight);
  world.undergroundGrids[colonyId] = underground;

  return { world, colony, underground, colonyId };
}

// ---------------------------------------------------------------------------
// updateFightAntTargets — Phase 9 / SURF-04
// ---------------------------------------------------------------------------

/** A Patrolling spider at (tileX, tileY), installed as world.spider. */
function placeAggroSpider(world: WorldState, tileX: number, tileY: number): SpiderState {
  const spider: SpiderState = {
    state: 'Patrolling',
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

describe('updateFightAntTargets', () => {
  it('writes targetPosX/targetPosY (fixed-point tile-center) for Fighting-task ants when colony rallyPoint is set', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[antId] = 0; // Zone.Surface

    updateFightAntTargets(world);

    expect(world.ants.targetPosX[antId]).toBe((10 << FP_SHIFT) + (FP_ONE >> 1)); // 2688
    expect(world.ants.targetPosY[antId]).toBe((20 << FP_SHIFT) + (FP_ONE >> 1)); // 5248
  });

  it('does not touch non-Fighting ants', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: 0,
    });
    world.ants.zone[antId] = 0; // Zone.Surface
    world.ants.targetPosX[antId] = 999;
    world.ants.targetPosY[antId] = 888;

    updateFightAntTargets(world);

    // Non-Fighting ant's target untouched
    expect(world.ants.targetPosX[antId]).toBe(999);
    expect(world.ants.targetPosY[antId]).toBe(888);
  });

  it('pre-V43: falls back to first entrance (surfaceTileX/surfaceTileY in fp) when rallyPoint is null', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    // V43 (#323) replaced this with sentry posts; below it, the entrance tile stands.
    world.simVersion = SIM_VERSION_V42_COLONY_ALARM;
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 5, surfaceTileY: 7, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[antId] = 0; // Zone.Surface

    updateFightAntTargets(world);

    expect(world.ants.targetPosX[antId]).toBe((5 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antId]).toBe((7 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('underground Fighting ant with surface rallyPoint routes to first entrance coord first', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: 3, surfaceTileY: 4, isOpen: true }];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[antId] = 1; // Zone.Underground

    updateFightAntTargets(world);

    // Underground ant with surface rally: targets entrance, not rally point
    expect(world.ants.targetPosX[antId]).toBe((3 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[antId]).toBe((4 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('skips dead ants (alive[id] !== 1) and unknown colony slots (colonyId not in world.colonies)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = { tileX: 10, tileY: 20 };
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // Dead ant: alive=0
    const deadId = allocateEntityId(world);
    initAnt(world.ants, deadId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.alive[deadId] = 0;
    world.ants.targetPosX[deadId] = -1;
    world.ants.targetPosY[deadId] = -1;

    // Ant with unknown colony ID
    const unknownColonyAntId = allocateEntityId(world);
    initAnt(world.ants, unknownColonyAntId, {
      colonyId: 999 as typeof COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[unknownColonyAntId] = 0;
    world.ants.targetPosX[unknownColonyAntId] = -1;
    world.ants.targetPosY[unknownColonyAntId] = -1;

    updateFightAntTargets(world);

    // Dead ant: target unchanged
    expect(world.ants.targetPosX[deadId]).toBe(-1);
    expect(world.ants.targetPosY[deadId]).toBe(-1);
    // Unknown colony ant: target unchanged
    expect(world.ants.targetPosX[unknownColonyAntId]).toBe(-1);
    expect(world.ants.targetPosY[unknownColonyAntId]).toBe(-1);
  });

  it('V16: proximity aggro scan is suppressed (enemy nearby does NOT override rally)', () => {
    // Gate test: pre-V17 worlds must NOT apply the aggro scan.
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V17_COMBAT_AGGRO - 1; // V16

    const COLONY_A = 1 as const;
    const COLONY_B = 2 as const;
    const colA = createColonyRecord(COLONY_A, 0);
    colA.entrances = [{ entranceId: 1, surfaceTileX: 50, surfaceTileY: 5, isOpen: true }];
    colA.rallyPoint = { tileX: 50, tileY: 5 };
    colA.digFlowFieldDirty = false;
    world.colonies[COLONY_A] = colA;

    const fighter = allocateEntityId(world);
    initAnt(world.ants, fighter, {
      colonyId: COLONY_A,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[fighter] = 0; // Zone.Surface

    // Enemy ant placed 1 tile away (within FIGHT_AGGRO_RADIUS)
    const colB_v16 = createColonyRecord(COLONY_B, 0);
    colB_v16.queenEntityId = -1; // no queen in this test colony
    colB_v16.entrances = [];
    colB_v16.digFlowFieldDirty = false;
    world.colonies[COLONY_B] = colB_v16;
    const enemy = allocateEntityId(world);
    initAnt(world.ants, enemy, {
      colonyId: COLONY_B,
      posX: (10 << FP_SHIFT) + (FP_ONE >> 1),
      posY: 10 << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
    });
    world.ants.zone[enemy] = 0; // same zone
    colB_v16.workers.push(enemy);
    colB_v16.workerCount += 1;

    updateFightAntTargets(world);

    // In V16, enemy is present but aggro scan is off → target follows rally, NOT the enemy.
    const rallyFP = (50 << FP_SHIFT) + (FP_ONE >> 1);
    expect(world.ants.targetPosX[fighter]).toBe(rallyFP);
  });

  it('V17: proximity aggro scan routes fighter toward nearby enemy (overrides rally)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V17_COMBAT_AGGRO; // V17

    const COLONY_A = 1 as const;
    const COLONY_B = 2 as const;
    const colA = createColonyRecord(COLONY_A, 0);
    // Rally NOT on any entrance — ensures aggro scan is not suppressed.
    colA.entrances = [{ entranceId: 1, surfaceTileX: 50, surfaceTileY: 5, isOpen: true }];
    colA.rallyPoint = { tileX: 10, tileY: 10 }; // rally on fighter's own tile, not entrance
    colA.digFlowFieldDirty = false;
    world.colonies[COLONY_A] = colA;

    const fighter = allocateEntityId(world);
    initAnt(world.ants, fighter, {
      colonyId: COLONY_A,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[fighter] = 0; // Zone.Surface

    // Enemy ant placed within FIGHT_AGGRO_RADIUS
    const colB_v17 = createColonyRecord(COLONY_B, 0);
    colB_v17.queenEntityId = -1; // no queen in this test colony
    colB_v17.entrances = [];
    colB_v17.digFlowFieldDirty = false;
    world.colonies[COLONY_B] = colB_v17;
    // eslint-disable-next-line no-restricted-syntax
    const enemyTileX = 10 + Math.floor(FIGHT_AGGRO_RADIUS / 2);
    const enemy = allocateEntityId(world);
    initAnt(world.ants, enemy, {
      colonyId: COLONY_B,
      posX: (enemyTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: 10 << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
    });
    world.ants.zone[enemy] = 0; // same zone
    colB_v17.workers.push(enemy);
    colB_v17.workerCount += 1;

    updateFightAntTargets(world);

    // In V17, enemy within radius → target is the enemy's position (not the rally).
    expect(world.ants.targetPosX[fighter]).toBe((enemyTileX << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosX[fighter]).not.toBe((50 << FP_SHIFT) + (FP_ONE >> 1));
  });

  // -------------------------------------------------------------------------
  // V23 (#147): the spider is one more candidate in the proximity aggro scan.
  // -------------------------------------------------------------------------

  /** Build a Patrolling spider parked on tile (tileX, tileY). */

  it('V23: fighter within FIGHT_AGGRO_RADIUS of the spider retargets onto it', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const colA = createColonyRecord(COLONY_ID, 0);
    colA.entrances = []; // rally not on any entrance → aggro scan active
    colA.rallyPoint = { tileX: 50, tileY: 5 };
    colA.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colA;

    const fighter = allocateEntityId(world);
    initAnt(world.ants, fighter, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[fighter] = Zone.Surface;

    const spider = placeAggroSpider(world, 10 + 2, 10); // dist 2, within radius

    updateFightAntTargets(world);

    // Routed onto the spider's exact position, not the rally.
    expect(world.ants.targetPosX[fighter]).toBe(spider.posX);
    expect(world.ants.targetPosY[fighter]).toBe(spider.posY);
    expect(world.ants.targetPosX[fighter]).not.toBe((50 << FP_SHIFT) + (FP_ONE >> 1));
  });

  it('V23: a closer enemy ant wins over the spider (just another candidate)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const COLONY_B = 2 as const;
    const colA = createColonyRecord(COLONY_ID, 0);
    colA.entrances = [];
    colA.rallyPoint = { tileX: 50, tileY: 5 };
    colA.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colA;

    const fighter = allocateEntityId(world);
    initAnt(world.ants, fighter, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[fighter] = Zone.Surface;

    // Enemy ant at dist 1 (closer than the spider at dist 3).
    const colB = createColonyRecord(COLONY_B, 0);
    colB.queenEntityId = -1;
    colB.entrances = [];
    colB.digFlowFieldDirty = false;
    world.colonies[COLONY_B] = colB;
    const enemyTileX = 11;
    const enemy = allocateEntityId(world);
    initAnt(world.ants, enemy, {
      colonyId: COLONY_B,
      posX: (enemyTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: 10 << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
    });
    world.ants.zone[enemy] = Zone.Surface;
    colB.workers.push(enemy);
    colB.workerCount += 1;

    const spider = placeAggroSpider(world, 13, 10); // dist 3, farther than the enemy

    updateFightAntTargets(world);

    // The nearer enemy ant wins; the spider is not chosen.
    expect(world.ants.targetPosX[fighter]).toBe((enemyTileX << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosX[fighter]).not.toBe(spider.posX);
  });

  it('V23: fighter rallied on an OPEN entrance is NOT diverted to a nearby spider', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const colA = createColonyRecord(COLONY_ID, 0);
    // Rally sits on this colony's own OPEN entrance → aggro scan suppressed so the
    // fighter walks the exact entrance tile (descent trigger carve-out).
    colA.entrances = [{ entranceId: 1, surfaceTileX: 20, surfaceTileY: 8, isOpen: true }];
    colA.rallyPoint = { tileX: 20, tileY: 8 };
    colA.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colA;

    const fighter = allocateEntityId(world);
    initAnt(world.ants, fighter, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[fighter] = Zone.Surface;

    const spider = placeAggroSpider(world, 11, 10); // dist 1 — would aggro if not suppressed

    updateFightAntTargets(world);

    // Held to the entrance rally, not diverted to the spider.
    expect(world.ants.targetPosX[fighter]).toBe((20 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[fighter]).toBe((8 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosX[fighter]).not.toBe(spider.posX);
  });

  it('V23 redesign: a Feeding spider IS a valid aggro target (fighters pursue to interrupt)', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const colA = createColonyRecord(COLONY_ID, 0);
    colA.entrances = [];
    colA.rallyPoint = { tileX: 50, tileY: 5 };
    colA.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colA;

    const fighter = allocateEntityId(world);
    initAnt(world.ants, fighter, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[fighter] = Zone.Surface;

    const spider = placeAggroSpider(world, 11, 10); // dist 1 — close
    spider.state = 'Feeding';

    updateFightAntTargets(world);

    // Under the redesign fighters may pursue a feeding spider to interrupt its
    // heal, so the fighter retargets onto it rather than holding the rally.
    expect(world.ants.targetPosX[fighter]).toBe(spider.posX);
    expect(world.ants.targetPosY[fighter]).toBe(spider.posY);
  });

  // #247 — the "pre-V23 world shows no spider auto-aggro" pinning test was removed:
  // MIN_ACCEPTED_SIM_VERSION is V30, so no V22 world can load; the reaped gate's
  // legacy branch is unreachable in production.
});

// ---------------------------------------------------------------------------
// pickInvaderUndergroundStep — wall-aware BFS step (UAT: fighters freeze bug;
// issue #163: route through bent tunnels)
//
// BFS routing requires a fully connected passable path from the invader's tile
// to the target — including the invader's OWN tile — so each scenario carves
// the complete corridor (the old greedy stepper only looked one tile ahead).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// V43 (#323) — sentries: fighters whose colony has no rally point
// ---------------------------------------------------------------------------

describe('updateFightAntTargets — V43 sentries (no rally point)', () => {
  const ENT_X = 40;
  const ENT_Y = 40;

  function sentryWorld(): { world: WorldState; colony: ColonyRecord } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [{ entranceId: 1, surfaceTileX: ENT_X, surfaceTileY: ENT_Y, isOpen: true }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;
    return { world, colony };
  }

  function addFighter(
    world: WorldState,
    colony: ColonyRecord,
    tileX: number,
    tileY: number,
    zone: number = Zone.Surface,
  ): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: colony.colonyId,
      posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.ants.zone[id] = zone;
    world.ants.currentGridColonyId[id] = colony.colonyId;
    colony.workers.push(id);
    return id;
  }

  const targetTile = (world: WorldState, id: number): [number, number] => [
    world.ants.targetPosX[id]! >> FP_SHIFT,
    world.ants.targetPosY[id]! >> FP_SHIFT,
  ];
  const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
    Math.abs(ax - bx) + Math.abs(ay - by);

  it('targets a post one tile inside sight of the door, never the entrance tile (the #323 bounce)', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
    expect([tx, ty]).not.toEqual([ENT_X, ENT_Y]);
  });

  it('spreads consecutive sentries around the ring instead of stacking them', () => {
    const { world, colony } = sentryWorld();
    // Five: a stride sharing a factor with the ring size (12) repeats by the fifth.
    const ids = [0, 1, 2, 3, 4].map(() => addFighter(world, colony, ENT_X + 3, ENT_Y + 3));
    updateFightAntTargets(world);
    const posts = ids.map((id) => targetTile(world, id).join(','));
    expect(new Set(posts).size).toBe(5);
    for (const id of ids) {
      const [tx, ty] = targetTile(world, id);
      expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
    }
  });

  it('holds (target -1) within one tile of its post', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    const [px, py] = targetTile(world, id);
    // Move the sentry onto its post, then next to it: both hold.
    world.ants.posX[id] = (px << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (py << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.targetPosY[id]).toBe(-1);
    world.ants.posX[id] = ((px + 1) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('chases an enemy it can see (within FIGHT_AGGRO_RADIUS), and ignores one out of sight', () => {
    const { world, colony } = sentryWorld();
    // No queen (-1): createColonyRecord's second argument is the queen's entity
    // id, and 0 is this test's own sentry.
    const enemy = createColonyRecord(2, -1);
    enemy.entrances = [];
    enemy.rallyPoint = null;
    enemy.digFlowFieldDirty = false;
    world.colonies[2] = enemy;
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    const foe = addFighter(world, enemy, ENT_X + 3 + FIGHT_AGGRO_RADIUS, ENT_Y);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(world.ants.posX[foe]);
    expect(world.ants.targetPosY[id]).toBe(world.ants.posY[foe]);
    // One tile further: out of sight, so back to the post.
    world.ants.posX[foe] = ((ENT_X + 4 + FIGHT_AGGRO_RADIUS) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).not.toBe(world.ants.posX[foe]);
  });

  /** An enemy colony with no entrances and no queen (-1) unless a test adds one. */
  function enemyColony(world: WorldState): ColonyRecord {
    const enemy = createColonyRecord(2, -1);
    enemy.entrances = [];
    enemy.rallyPoint = null;
    enemy.digFlowFieldDirty = false;
    world.colonies[2] = enemy;
    return enemy;
  }

  // The guard area: what a sentry can see from its post or a hold tile, i.e. its
  // sight (4) past the door area (post ring 3 + hold 1).
  const GUARD_RADIUS = 2 * FIGHT_AGGRO_RADIUS;

  it('chases only inside its guard area: an enemy in sight beyond it does not lure it off', () => {
    const { world, colony } = sentryWorld();
    const enemy = enemyColony(world);
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    // 3 from the sentry, one past the guard radius of the door.
    const foe = addFighter(world, enemy, ENT_X + GUARD_RADIUS + 1, ENT_Y);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1); // its post
    // On the guard radius: chased.
    world.ants.posX[foe] = ((ENT_X + GUARD_RADIUS) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(world.ants.posX[foe]);
  });

  it('the guard area bounds a chase of the enemy queen too', () => {
    const { world, colony } = sentryWorld();
    const enemy = enemyColony(world);
    const q = allocateEntityId(world);
    initAnt(world.ants, q, {
      colonyId: 2,
      posX: ((ENT_X + GUARD_RADIUS + 1) << FP_SHIFT) + (FP_ONE >> 1),
      posY: (ENT_Y << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      subTask: 0,
    });
    world.ants.zone[q] = Zone.Surface;
    enemy.queenEntityId = q;
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).not.toBe(world.ants.posX[q]);
    world.ants.posX[q] = ((ENT_X + GUARD_RADIUS) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(world.ants.posX[q]);
  });

  it('beyond its guard area walks to the door itself (the pre-V43 route home), and takes its post inside it', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + GUARD_RADIUS + 1, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
    world.ants.posX[id] = ((ENT_X + GUARD_RADIUS) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('skips a ring tile that is off the walkable surface component', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    const [px, py] = targetTile(world, id);
    // Block that post, invalidate the memoised component mask, retarget.
    world.bakedSurfaceEffect[py * SURFACE_GRID_WIDTH + px] = SurfaceMovementEffect.HardBlock;
    world.surfaceComponentMask = null;
    updateFightAntTargets(world);
    const [qx, qy] = targetTile(world, id);
    expect([qx, qy]).not.toEqual([px, py]);
    expect(manhattan(qx, qy, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('with only a CLOSED entrance, keeps the pre-V43 wait at the shaft', () => {
    const { world, colony } = sentryWorld();
    colony.entrances[0]!.isOpen = false;
    const id = addFighter(world, colony, ENT_X + 10, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('underground in its own grid, still routes to the entrance (climbs out, then posts)', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X, 5, Zone.Underground);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('takes cover from a spider it can see: heads for its door, never at the spider', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    const spider = placeAggroSpider(world, ENT_X + 3 + FIGHT_AGGRO_RADIUS, ENT_Y); // just in sight
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
    expect(world.ants.targetPosX[id]).not.toBe(spider.posX);
  });

  it('away from its door, takes cover from a spider it can see even though the spider is far from the door', () => {
    const { world, colony } = sentryWorld();
    // 8 from the door, so not AT it; the spider just in sight beyond it, 12 from
    // the door and past the door-relative cover radius: only "sees it" applies.
    const id = addFighter(world, colony, ENT_X + 8, ENT_Y);
    placeAggroSpider(world, ENT_X + 8 + FIGHT_AGGRO_RADIUS, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('does not take cover from a spider one tile out of its sight while away from its door', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    placeAggroSpider(world, ENT_X + 6 + FIGHT_AGGRO_RADIUS + 1, ENT_Y); // 5 from it, 11 from the door
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1); // its post
  });

  it('takes cover before chasing: an enemy in sight does not keep it out with the spider in sight too', () => {
    const { world, colony } = sentryWorld();
    const enemy = enemyColony(world);
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    addFighter(world, enemy, ENT_X + 5, ENT_Y); // 2 from the sentry
    placeAggroSpider(world, ENT_X + 3, ENT_Y + 3); // 3 from the sentry
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  // The door-relative cover radius: the watch radius (4) plus the door area (post
  // ring 3 + hold 1). Past it no post or hold tile is in the spider's watch.
  const COVER_DOOR_RADIUS = 2 * FIGHT_AGGRO_RADIUS;

  it('at its door, takes cover while the spider is within the cover radius of the door — even out of its own sight', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    // Opposite side of the door: 11 from the sentry, exactly COVER_DOOR_RADIUS from the door.
    placeAggroSpider(world, ENT_X - COVER_DOOR_RADIUS, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('keeps its post once the spider is past the cover radius of the door', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    placeAggroSpider(world, ENT_X - COVER_DOOR_RADIUS - 1, ENT_Y);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect([tx, ty]).not.toEqual([ENT_X, ENT_Y]);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('takes the door-relative cover only AT its door: 5 out, a spider it cannot see leaves it be', () => {
    const { world, colony } = sentryWorld();
    // 5 from the door: past the door area (post ring 3 + hold 1).
    const id = addFighter(world, colony, ENT_X + 5, ENT_Y);
    // 5 from the door on the far side, inside the cover radius; 10 from the sentry.
    placeAggroSpider(world, ENT_X - 5, ENT_Y);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect([tx, ty]).not.toEqual([ENT_X, ENT_Y]);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('measures the spider in Manhattan tiles: off the row it is farther than its larger offset', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y); // at its door
    // (+5, +4) from the door: 9 tiles, past the cover radius (only 5 by its larger
    // offset); 6 from the sentry, out of its sight (4 by its larger offset).
    placeAggroSpider(world, ENT_X + 5, ENT_Y + 4);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).not.toEqual([ENT_X, ENT_Y]);
  });

  it('under spider priority, does not take cover (step 10d sends it at the spider)', () => {
    const { world, colony } = sentryWorld();
    world.spiderPriorityColonyId = COLONY_ID;
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    placeAggroSpider(world, ENT_X + 3 + 2, ENT_Y); // in plain sight
    updateFightAntTargets(world);
    expect(targetTile(world, id)).not.toEqual([ENT_X, ENT_Y]);
  });

  it('posts sit well apart: consecutive slots are not neighbours on the ring', () => {
    const { world, colony } = sentryWorld();
    const a = addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    const b = addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    updateFightAntTargets(world);
    const [ax, ay] = targetTile(world, a);
    const [bx, by] = targetTile(world, b);
    expect(manhattan(ax, ay, bx, by)).toBeGreaterThanOrEqual(4);
  });

  it("ranks per entrance: the first sentry at each of two doors takes that door's slot-0 post", () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 40,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    const nearA = addFighter(world, colony, ENT_X + 2, ENT_Y + 6);
    const nearB = addFighter(world, colony, ENT_X + 42, ENT_Y + 6);
    updateFightAntTargets(world);
    const [ax, ay] = targetTile(world, nearA);
    const [bx, by] = targetTile(world, nearB);
    // Slot 0 is due north of each door.
    expect([ax, ay]).toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
    expect([bx, by]).toEqual([ENT_X + 40, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it('a fighter inside a FOREIGN grid does not take a slot from the sentries at home', () => {
    const { world, colony } = sentryWorld();
    const invader = addFighter(world, colony, 5, 5, Zone.Underground);
    world.ants.currentGridColonyId[invader] = 2; // inside another colony's nest
    const sentry = addFighter(world, colony, ENT_X + 2, ENT_Y + 6);
    updateFightAntTargets(world);
    expect(targetTile(world, sentry)).toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it("never posts on, or holds next to, another colony's entrance tile", () => {
    const { world, colony } = sentryWorld();
    const other = createColonyRecord(2, -1);
    // A foreign door right next to slot 0's post (due north, 3 up).
    other.entrances = [
      {
        entranceId: 9,
        surfaceTileX: ENT_X + 1,
        surfaceTileY: ENT_Y - (FIGHT_AGGRO_RADIUS - 1),
        isOpen: true,
      },
    ];
    other.rallyPoint = null;
    other.digFlowFieldDirty = false;
    world.colonies[2] = other;
    const id = addFighter(world, colony, ENT_X + 2, ENT_Y + 6);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    expect([tx, ty]).not.toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
    expect(manhattan(tx, ty, ENT_X + 1, ENT_Y - (FIGHT_AGGRO_RADIUS - 1))).toBeGreaterThan(1);
  });

  it('a sentry sheltering in its own nest keeps its slot at the door it is under', () => {
    const { world, colony } = sentryWorld();
    // Door B six columns east, nine rows north. Measured against B's surface row,
    // the depth of a shelterer under A would bind it to B.
    const bx = ENT_X + 6;
    const by = ENT_Y - 9;
    colony.entrances.push({ entranceId: 2, surfaceTileX: bx, surfaceTileY: by, isOpen: true });
    // A lower id than B's sentry, so binding it to B would take B's slot 0.
    addFighter(world, colony, ENT_X, 1, Zone.Underground); // at the top of A's shaft
    const sentryB = addFighter(world, colony, bx + 1, by + 5);
    updateFightAntTargets(world);
    expect(targetTile(world, sentryB)).toEqual([bx, by - (FIGHT_AGGRO_RADIUS - 1)]); // B's slot 0
  });

  it('a sentry going below to shelter does not move the posts of those still outside', () => {
    const { world, colony } = sentryWorld();
    const ids = [0, 1, 2].map(() => addFighter(world, colony, ENT_X + 3, ENT_Y + 3));
    updateFightAntTargets(world);
    const before = ids.slice(1).map((id) => targetTile(world, id).join(','));
    // The first (lowest id, slot 0) shelters at the top of the shaft.
    world.ants.zone[ids[0]!] = Zone.Underground;
    world.ants.posX[ids[0]!] = (ENT_X << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[ids[0]!] = FP_ONE >> 1;
    updateFightAntTargets(world);
    expect(ids.slice(1).map((id) => targetTile(world, id).join(','))).toEqual(before);
  });

  it("ranks by entity id: a worker's death does not reshuffle the posts", () => {
    const { world, colony } = sentryWorld();
    const forager = addFighter(world, colony, ENT_X + 20, ENT_Y + 20);
    world.ants.task[forager] = AntTask.Foraging;
    const ids = [0, 1, 2].map(() => addFighter(world, colony, ENT_X + 3, ENT_Y + 3));
    updateFightAntTargets(world);
    const before = ids.map((id) => targetTile(world, id).join(','));
    // The forager dies: step 5 removes it by swapping the last worker into its place.
    world.ants.alive[forager] = 0;
    colony.workers[colony.workers.indexOf(forager)] = colony.workers[colony.workers.length - 1]!;
    colony.workers.pop();
    updateFightAntTargets(world);
    expect(ids.map((id) => targetTile(world, id).join(','))).toEqual(before);
  });

  it('with own doors in the columns either side, the middle door still posts its sentries', () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push(
      { entranceId: 2, surfaceTileX: ENT_X - 1, surfaceTileY: ENT_Y, isOpen: true },
      { entranceId: 3, surfaceTileX: ENT_X + 1, surfaceTileY: ENT_Y, isOpen: true },
    );
    // Every hold area on the middle door's ring reaches a tile nearer a neighbour:
    // no stable post. A sentry that has just climbed out onto the middle door:
    const id = addFighter(world, colony, ENT_X, ENT_Y);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).not.toBe(-1); // not frozen on the door
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  // Off the door's row, where Manhattan distance and the larger offset part ways.
  it('the guard area is Manhattan off the door row too: an enemy worker at (+4, +5) is past it', () => {
    const { world, colony } = sentryWorld();
    const enemy = enemyColony(world);
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    const foe = addFighter(world, enemy, ENT_X + 4, ENT_Y + 5); // 9 from the door, 3 from the sentry
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).not.toBe(world.ants.posX[foe]);
  });

  it('the guard area is Manhattan off the door row for the enemy queen too', () => {
    const { world, colony } = sentryWorld();
    const enemy = enemyColony(world);
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    const q = allocateEntityId(world);
    initAnt(world.ants, q, {
      colonyId: 2,
      posX: ((ENT_X + 4) << FP_SHIFT) + (FP_ONE >> 1),
      posY: ((ENT_Y + 5) << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      subTask: 0,
    });
    world.ants.zone[q] = Zone.Surface;
    enemy.queenEntityId = q;
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).not.toBe(world.ants.posX[q]);
  });

  it('walks home from 9 out off the door row too', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 1, ENT_Y + 8);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('ranks a surface sentry at the door it is routed to, not the column-nearest one', () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 6,
      surfaceTileY: ENT_Y - 9,
      isOpen: true,
    });
    // P is Manhattan-nearer A (7 vs 8) but column-nearer B (2 vs 4); Q is plainly A's.
    const p = addFighter(world, colony, ENT_X + 4, ENT_Y - 3);
    const q = addFighter(world, colony, ENT_X - 2, ENT_Y + 3);
    updateFightAntTargets(world);
    expect(targetTile(world, p)).not.toEqual(targetTile(world, q)); // two ranks at A
  });

  it('a dead fighter holds no rank: when the first of three dies, the others move up a slot', () => {
    const { world, colony } = sentryWorld();
    const ids = [0, 1, 2].map(() => addFighter(world, colony, ENT_X + 3, ENT_Y + 3));
    updateFightAntTargets(world);
    const slotPosts = ids.map((id) => targetTile(world, id).join(','));
    world.ants.alive[ids[0]!] = 0; // its task stays Fighting, as despawning leaves it
    updateFightAntTargets(world);
    expect([ids[1]!, ids[2]!].map((id) => targetTile(world, id).join(','))).toEqual(
      slotPosts.slice(0, 2),
    );
  });

  it('twelve sentries at one door take all twelve ring posts', () => {
    const { world, colony } = sentryWorld();
    const ids = Array.from({ length: 12 }, () => addFighter(world, colony, ENT_X + 3, ENT_Y + 3));
    updateFightAntTargets(world);
    expect(new Set(ids.map((id) => targetTile(world, id).join(','))).size).toBe(12);
  });

  it('the lowest entity id takes slot 0, due north of the door', () => {
    const { world, colony } = sentryWorld();
    const a = addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    updateFightAntTargets(world);
    expect(targetTile(world, a)).toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it('a fighter deep in the tunnels of a two-door nest holds no slot until it surfaces', () => {
    const { world, colony } = sentryWorld();
    const cx = ENT_X + 10;
    colony.entrances.push({ entranceId: 3, surfaceTileX: cx, surfaceTileY: ENT_Y, isOpen: true });
    // Which shaft it climbs is the entrance flow field's call, not its column's.
    addFighter(world, colony, ENT_X + 5, 5, Zone.Underground);
    const sa = addFighter(world, colony, ENT_X - 2, ENT_Y + 3);
    const sc = addFighter(world, colony, cx + 2, ENT_Y + 3);
    updateFightAntTargets(world);
    // Slot 0 (due north) at both doors: the one below took neither.
    expect(targetTile(world, sa)).toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
    expect(targetTile(world, sc)).toEqual([cx, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it("a fighter in a shaft's column but below its top rows holds no slot in a two-door nest", () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push({
      entranceId: 3,
      surfaceTileX: ENT_X + 10,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    addFighter(world, colony, ENT_X, 5, Zone.Underground); // under A, but deep in the nest
    const s = addFighter(world, colony, ENT_X - 2, ENT_Y + 3);
    updateFightAntTargets(world);
    expect(targetTile(world, s)).toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]); // A's slot 0
  });

  it('a fighter anywhere below a one-door nest holds its slot at that door', () => {
    const { world, colony } = sentryWorld();
    addFighter(world, colony, ENT_X + 5, 5, Zone.Underground); // deep, and off the shaft's column
    const s = addFighter(world, colony, ENT_X - 2, ENT_Y + 3);
    updateFightAntTargets(world);
    // The one below took slot 0, so the surface sentry has slot 1.
    expect(targetTile(world, s)).not.toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it("a door's first sentries take distinct posts even when a neighbouring door rules out a run of ring tiles", () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 3,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    // Door B three east leaves door A seven stable ring tiles.
    const ids = Array.from({ length: 7 }, () => addFighter(world, colony, ENT_X - 3, ENT_Y + 3));
    updateFightAntTargets(world);
    expect(new Set(ids.map((id) => targetTile(world, id).join(','))).size).toBe(7);
  });

  it('pre-V45: more sentries than stable posts wrap around onto them from slot 0', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V44_TUNNEL_DEFENCE; // V45 adds an outer ring
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 3,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    // Seven stable posts at A (door B three east): the eighth sentry shares slot 0's,
    // and fourteen use those seven and nothing else.
    const ids = Array.from({ length: 14 }, () => addFighter(world, colony, ENT_X - 3, ENT_Y + 3));
    updateFightAntTargets(world);
    expect(targetTile(world, ids[7]!)).toEqual(targetTile(world, ids[0]!));
    const firstSeven = new Set(ids.slice(0, 7).map((id) => targetTile(world, id).join(',')));
    expect(new Set(ids.map((id) => targetTile(world, id).join(',')))).toEqual(firstSeven);
  });

  it('V45: past the inner ring, sentries take an outer ring of posts in sight of the door', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V45_SENTRY_RING_PASSABLE;
    const inner = 4 * (FIGHT_AGGRO_RADIUS - 1);
    const outer = 4 * FIGHT_AGGRO_RADIUS;
    const ids = Array.from({ length: inner + outer + 1 }, () =>
      addFighter(world, colony, ENT_X + 6, ENT_Y),
    );
    updateFightAntTargets(world);
    const tiles = ids.map((id) => targetTile(world, id));
    const dist = tiles.map(([x, y]) => manhattan(x, y, ENT_X, ENT_Y));
    expect(dist.slice(0, inner).every((d) => d === FIGHT_AGGRO_RADIUS - 1)).toBe(true);
    expect(dist.slice(inner, inner + outer).every((d) => d === FIGHT_AGGRO_RADIUS)).toBe(true);
    // Every one of the first inner + outer has a post of its own; the next wraps to slot 0.
    const own = new Set(tiles.slice(0, inner + outer).map((t) => t.join(',')));
    expect(own.size).toBe(inner + outer);
    expect(tiles[inner + outer]).toEqual(tiles[0]);
  });

  it('V45: a holder bound for an outer post keeps holding only within one tile inside that ring', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V45_SENTRY_RING_PASSABLE;
    const inner = 4 * (FIGHT_AGGRO_RADIUS - 1);
    const ids = Array.from({ length: inner + 1 }, () =>
      addFighter(world, colony, ENT_X + 6, ENT_Y),
    );
    updateFightAntTargets(world);
    const id = ids[inner]!; // the first sentry on the outer ring
    const [px, py] = targetTile(world, id);
    expect(manhattan(px, py, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS);
    // Two tiles in from its post, toward the door: 2 from the door, inside the
    // inner ring. A holder there walks back out rather than holding.
    let x = -1;
    let y = -1;
    for (let dx = -2; dx <= 2 && x < 0; dx++) {
      for (let dy = -2; dy <= 2 && x < 0; dy++) {
        if (
          manhattan(px + dx, py + dy, px, py) === 2 &&
          manhattan(px + dx, py + dy, ENT_X, ENT_Y) === FIGHT_AGGRO_RADIUS - 2
        ) {
          x = px + dx;
          y = py + dy;
        }
      }
    }
    expect(x).toBeGreaterThanOrEqual(0);
    world.ants.posX[id] = (x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (y << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.subTask[id] = FightingSubState.Holding;
    world.ants.targetPosX[id] = -1;
    world.ants.targetPosY[id] = -1;
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([px, py]);
  });

  it('V45: a sentry bound for an outer post does not hold beyond sight of the door', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V45_SENTRY_RING_PASSABLE;
    const inner = 4 * (FIGHT_AGGRO_RADIUS - 1);
    const ids = Array.from({ length: inner + 1 }, () =>
      addFighter(world, colony, ENT_X + 6, ENT_Y),
    );
    updateFightAntTargets(world);
    const id = ids[inner]!; // the first sentry on the outer ring
    const [px, py] = targetTile(world, id);
    // Its post's outward neighbour: one tile from the post, one past sight of the door.
    let x = -1;
    let y = -1;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (manhattan(px + dx, py + dy, ENT_X, ENT_Y) === FIGHT_AGGRO_RADIUS + 1) {
        x = px + dx;
        y = py + dy;
      }
    }
    expect(x).toBeGreaterThanOrEqual(0);
    world.ants.posX[id] = (x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (y << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world); // walking in: does not start holding there
    expect(targetTile(world, id)).toEqual([px, py]);
    world.ants.subTask[id] = FightingSubState.Holding; // nor keep holding there
    world.ants.targetPosX[id] = -1;
    world.ants.targetPosY[id] = -1;
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([px, py]);
  });

  // Three entrances this close leave no stable post, and the fallback posts of
  // entrances 1 and 2 overlap. Returns the world, the colony and both post lists.
  function crowdedPosts(
    second: readonly [number, number],
    third: readonly [number, number],
  ): {
    world: WorldState;
    colony: ColonyRecord;
    posts: Map<number, number[]>;
    raw: Map<number, number[]>;
  } {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE;
    colony.entrances.push(
      {
        entranceId: 2,
        surfaceTileX: ENT_X + second[0],
        surfaceTileY: ENT_Y + second[1],
        isOpen: true,
      },
      {
        entranceId: 3,
        surfaceTileX: ENT_X + third[0],
        surfaceTileY: ENT_Y + third[1],
        isOpen: true,
      },
    );
    // Probe sentries around every entrance, so the first pass builds every post list.
    const probes: number[] = [];
    for (const e of colony.entrances) {
      for (const [dx, dy] of [
        [-5, 0],
        [5, 0],
        [0, 5],
        [0, -5],
      ] as const) {
        probes.push(addFighter(world, colony, e.surfaceTileX + dx, e.surfaceTileY + dy));
      }
    }
    updateFightAntTargets(world);
    for (const p of probes) world.ants.alive[p] = 0;
    const scratch = getScratch(world).antTargeting;
    return { world, colony, posts: scratch.sentryPosts, raw: scratch.sentryRawPosts };
  }

  /** A post both lists share, no farther from (ox, oy) than from (px, py). */
  function sharedPost(
    a: number[],
    b: number[],
    [ox, oy]: readonly [number, number],
    [px, py]: readonly [number, number],
  ): [number, number] | null {
    for (let i = 0; i < b.length; i += 2) {
      for (let j = 0; j < a.length; j += 2) {
        if (a[j] !== b[i] || a[j + 1] !== b[i + 1]) continue;
        if (manhattan(b[i]!, b[i + 1]!, ox, oy) <= manhattan(b[i]!, b[i + 1]!, px, py)) {
          return [b[i]!, b[i + 1]!];
        }
      }
    }
    return null;
  }

  function walkTo(world: WorldState, id: number, [x, y]: readonly [number, number]): void {
    world.ants.targetPosX[id] = (x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.targetPosY[id] = (y << FP_SHIFT) + (FP_ONE >> 1);
  }

  it("V46: a sentry walking to a post two entrances share is bound to the post's own entrance", () => {
    // Its own entrance is the one nearest the POST (a tie to the lower id), not the
    // sentry. Here entrance 1, though the sentry stands nearer entrance 2.
    {
      const { world, colony, posts, raw } = crowdedPosts([1, -1], [2, -4]);
      const [a, b] = [posts.get(1)!, posts.get(2)!];
      // A ring tile both entrances accept; entrance 1 owns it (ties go to the lower id).
      const shared = sharedPost(raw.get(1)!, raw.get(2)!, [ENT_X, ENT_Y], [ENT_X + 1, ENT_Y - 1]);
      expect(shared).not.toBeNull();
      expect([a[0], a[1]]).not.toEqual([b[0], b[1]]);
      const id = addFighter(world, colony, ENT_X + 3, ENT_Y - 1); // nearer entrance 2
      walkTo(world, id, shared!);
      updateFightAntTargets(world);
      expect(targetTile(world, id)).toEqual([a[0], a[1]]); // entrance 1's first post
    }
    // Here entrance 3 — not the lowest id that lists the post — though the sentry
    // stands nearer entrance 1.
    {
      const { world, colony, posts, raw } = crowdedPosts([-1, 0], [2, 1]);
      const [a, c] = [posts.get(1)!, posts.get(3)!];
      const shared = sharedPost(raw.get(1)!, raw.get(3)!, [ENT_X + 2, ENT_Y + 1], [ENT_X, ENT_Y]);
      expect(shared).not.toBeNull();
      expect(manhattan(shared![0], shared![1], ENT_X + 2, ENT_Y + 1)).toBeLessThan(
        manhattan(shared![0], shared![1], ENT_X, ENT_Y),
      );
      expect([a[0], a[1]]).not.toEqual([c[0], c[1]]);
      const id = addFighter(world, colony, ENT_X + 1, ENT_Y - 3); // nearer entrance 1
      walkTo(world, id, shared!);
      updateFightAntTargets(world);
      expect(targetTile(world, id)).toEqual([c[0], c[1]]); // entrance 3's first post
    }
  });

  it("V46: a sentry chasing an enemy on another entrance's post does not re-bind to it", () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE;
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 6,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    const enemy = enemyColony(world);
    // Build entrance 2's posts with a probe sentry beside it.
    const probe = addFighter(world, colony, ENT_X + 9, ENT_Y);
    updateFightAntTargets(world);
    world.ants.alive[probe] = 0;
    const far = getScratch(world).antTargeting.sentryPosts.get(2)!;
    // A sentry of entrance 1, and an enemy on one of entrance 2's posts in its sight.
    // Level with both entrances (a tie binds to the lower id, 1).
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    let px = -1;
    let py = -1;
    for (let k = 0; k < far.length; k += 2) {
      if (manhattan(far[k]!, far[k + 1]!, ENT_X + 3, ENT_Y) <= FIGHT_AGGRO_RADIUS) {
        px = far[k]!;
        py = far[k + 1]!;
        break;
      }
    }
    expect(px).toBeGreaterThanOrEqual(0);
    const foe = addFighter(world, enemy, px, py);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([px, py]); // chasing it
    // The enemy dies: the sentry goes back to entrance 1's post, not entrance 2's.
    world.ants.alive[foe] = 0;
    updateFightAntTargets(world);
    // …and no longer counts as chasing, so its binding follows its post again.
    expect(world.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('V46: a sentry is never held by a ring tile of a CLOSED entrance', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE;
    // Entrance 1 is closed (and the lower id); entrance 2, six tiles east, is open.
    colony.entrances[0]!.isOpen = false;
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 6,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    const id = addFighter(world, colony, ENT_X + 4, ENT_Y); // nearer entrance 2
    // Walking to the closed entrance's north ring tile.
    world.ants.targetPosX[id] = (ENT_X << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.targetPosY[id] = ((ENT_Y - (FIGHT_AGGRO_RADIUS - 1)) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    // A sentry of the open entrance: one of its posts, not its door tile.
    const [tx, ty] = targetTile(world, id);
    expect(manhattan(tx, ty, ENT_X + 6, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('V46: a sentry is not held by a post of an entrance whose guard area it has left', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE;
    colony.entrances.push({
      entranceId: 2,
      surfaceTileX: ENT_X + 20,
      surfaceTileY: ENT_Y,
      isOpen: true,
    });
    const id = addFighter(world, colony, ENT_X + 5, ENT_Y); // near entrance 1, 15 from 2
    updateFightAntTargets(world);
    const far = getScratch(world).antTargeting.sentryPosts.get(2);
    // Entrance 2's posts are built only if something binds to it; build them by
    // placing a probe sentry there once.
    const probe = addFighter(world, colony, ENT_X + 23, ENT_Y);
    updateFightAntTargets(world);
    const b = far ?? getScratch(world).antTargeting.sentryPosts.get(2)!;
    world.ants.alive[probe] = 0;
    world.ants.targetPosX[id] = (b[0]! << FP_SHIFT) + (FP_ONE >> 1); // a post of entrance 2
    world.ants.targetPosY[id] = (b[1]! << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    const [tx, ty] = targetTile(world, id);
    // Bound to entrance 1, its nearest: one of entrance 1's posts, not entrance 2's door.
    expect(manhattan(tx, ty, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 1);
  });

  it('V45: only a sentry HOLDING its post passes through friends while holding', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V45_SENTRY_RING_PASSABLE;
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y);
    world.ants.subTask[id] = FightingSubState.Holding;
    world.ants.targetPosX[id] = -1;
    expect(sentryPassesThroughFriends(world, id)).toBe(true);
    // Target -1 but not Holding (newly promoted, say): it claims its tile.
    world.ants.subTask[id] = FightingSubState.MovingToRally;
    expect(sentryPassesThroughFriends(world, id)).toBe(false);
    // Holding recorded but a target set: not holding.
    world.ants.subTask[id] = FightingSubState.Holding;
    world.ants.targetPosX[id] = (ENT_X << FP_SHIFT) + (FP_ONE >> 1);
    expect(sentryPassesThroughFriends(world, id)).toBe(false);
    // Pre-V45 a holder claims its tile.
    world.ants.targetPosX[id] = -1;
    world.simVersion = SIM_VERSION_V44_TUNNEL_DEFENCE;
    expect(sentryPassesThroughFriends(world, id)).toBe(false);
  });

  it('holds near its post only on the ring or outside it: nearer the door it walks on out', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    const [px, py] = targetTile(world, id);
    // Put it one tile inside the ring from its post: within the hold radius, but
    // standing where sentries walk out from the door.
    const ix = px + Math.sign(ENT_X - px);
    const iy = ix === px ? py + Math.sign(ENT_Y - py) : py;
    expect(manhattan(ix, iy, ENT_X, ENT_Y)).toBe(FIGHT_AGGRO_RADIUS - 2);
    world.ants.posX[id] = (ix << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = (iy << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([px, py]);
  });

  it('a fighter below is not ranked at a closed shaft, however near its column', () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push({
      entranceId: 0,
      surfaceTileX: ENT_X + 4,
      surfaceTileY: ENT_Y + 12,
      isOpen: false,
    });
    addFighter(world, colony, ENT_X + 4, 5, Zone.Underground);
    const s = addFighter(world, colony, ENT_X - 2, ENT_Y + 3);
    updateFightAntTargets(world);
    // Ranked at open door A instead, taking its slot 0.
    expect(targetTile(world, s)).not.toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  /** The middle of three own doors in adjacent columns: no ring tile of it is stable. */
  function boxedDoorWorld(): { world: WorldState; colony: ColonyRecord } {
    const { world, colony } = sentryWorld();
    colony.entrances.push(
      { entranceId: 2, surfaceTileX: ENT_X - 1, surfaceTileY: ENT_Y, isOpen: true },
      { entranceId: 3, surfaceTileX: ENT_X + 1, surfaceTileY: ENT_Y, isOpen: true },
    );
    return { world, colony };
  }

  it('the no-stable-post fallback still keeps posts clear of any doorway', () => {
    const { world, colony } = boxedDoorWorld();
    const enemy = enemyColony(world);
    // A foreign door right beside slot 0's ring tile, due north.
    enemy.entrances = [
      { entranceId: 9, surfaceTileX: ENT_X, surfaceTileY: ENT_Y - 4, isOpen: true },
    ];
    const id = addFighter(world, colony, ENT_X, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).not.toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it('the no-stable-post fallback still skips a ring tile off the walkable surface', () => {
    const { world, colony } = boxedDoorWorld();
    const py = ENT_Y - (FIGHT_AGGRO_RADIUS - 1);
    world.bakedSurfaceEffect[py * SURFACE_GRID_WIDTH + ENT_X] = SurfaceMovementEffect.HardBlock;
    world.surfaceComponentMask = null;
    const id = addFighter(world, colony, ENT_X, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).not.toEqual([ENT_X, py]);
  });

  it('a CLOSED entrance beside a ring tile keeps posts off it too', () => {
    const { world, colony } = sentryWorld();
    colony.entrances.push({
      entranceId: 5,
      surfaceTileX: ENT_X + 1,
      surfaceTileY: ENT_Y - (FIGHT_AGGRO_RADIUS - 1),
      isOpen: false,
    });
    const id = addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).not.toEqual([ENT_X, ENT_Y - (FIGHT_AGGRO_RADIUS - 1)]);
  });

  it('pre-V43 worlds keep routing an idle fighter onto the entrance tile', () => {
    const { world, colony } = sentryWorld();
    world.simVersion = SIM_VERSION_V42_COLONY_ALARM;
    const id = addFighter(world, colony, ENT_X + 10, ENT_Y);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('on an outer hold tile (4 from the door) it is AT its door: a spider it cannot see near the door sends it in', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 4, ENT_Y); // SENTRY_DOOR_AREA_RADIUS
    placeAggroSpider(world, ENT_X - 5, ENT_Y); // 5 from the door, 9 from the sentry
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y]);
  });

  it('a sentry walking to its post starts holding one tile outside it', () => {
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    const [px, py] = targetTile(world, id);
    const dx = px > ENT_X ? 1 : px < ENT_X ? -1 : 0;
    const dy = dx === 0 ? (py > ENT_Y ? 1 : -1) : 0;
    // One tile outward from the post, still walking (its target is set).
    world.ants.posX[id] = ((px + dx) << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[id] = ((py + dy) << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('a holding sentry bumped one tile keeps holding; one walking there carries on to its post', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    // Slot 0's post is due north on the ring: (ENT_X, ENT_Y - R).
    for (const [x, y] of [
      [ENT_X, ENT_Y - R + 1], // one tile inside the ring
      [ENT_X + 1, ENT_Y - R - 1], // two tiles off the post, outside the ring
    ] as const) {
      const { world, colony } = sentryWorld();
      // The second tile is 5 from the door: from V45 no sentry holds beyond sight of
      // its door (see the V45 sight test), so that case is pinned below V45.
      const version =
        manhattan(x, y, ENT_X, ENT_Y) > FIGHT_AGGRO_RADIUS
          ? SIM_VERSION_V44_TUNNEL_DEFENCE
          : SIM_VERSION_V45_SENTRY_RING_PASSABLE;
      world.simVersion = version;
      const id = addFighter(world, colony, x, y);
      world.ants.targetPosX[id] = -1; // already holding
      world.ants.targetPosY[id] = -1;
      world.ants.subTask[id] = FightingSubState.Holding;
      updateFightAntTargets(world);
      expect(world.ants.targetPosX[id]).toBe(-1);

      const walker = sentryWorld();
      walker.world.simVersion = version;
      const w = addFighter(walker.world, walker.colony, x, y);
      walker.world.ants.targetPosX[w] = (ENT_X << FP_SHIFT) + (FP_ONE >> 1); // on its way
      updateFightAntTargets(walker.world);
      expect(targetTile(walker.world, w)).toEqual([ENT_X, ENT_Y - R]);
    }
  });

  it('a fighter with no target that was not holding its post starts holding only by the start rule', () => {
    // Newly promoted fighters have no target too; only a sentry recorded as
    // Holding gets the wider keep-hold area.
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X, ENT_Y - R + 1); // a tile inside the ring
    world.ants.targetPosX[id] = -1;
    world.ants.targetPosY[id] = -1;
    world.ants.subTask[id] = FightingSubState.MovingToRally;
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y - R]);
    expect(world.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
  });

  it('a sentry held at a rally near its post, once the rally is cleared, walks to its post', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X, ENT_Y - R);
    updateFightAntTargets(world);
    expect(world.ants.subTask[id]).toBe(FightingSubState.Holding);
    // A rally two tiles off the post, with the sentry standing on it: it stops
    // there under orders, and is no longer holding its post.
    world.ants.posX[id] = ((ENT_X + 2) << FP_SHIFT) + (FP_ONE >> 1);
    colony.rallyPoint = { tileX: ENT_X + 2, tileY: ENT_Y - R };
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    colony.rallyPoint = null;
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y - R]);
  });

  it('records a sentry that stops at its post as Holding', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    const id = addFighter(world, colony, ENT_X, ENT_Y - R);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.subTask[id]).toBe(FightingSubState.Holding);
  });

  it('a holding sentry pushed past the keep-hold area walks back to its post', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    for (const [x, y] of [
      [ENT_X, ENT_Y - R + 2], // two tiles inside the ring
      [ENT_X + 2, ENT_Y - R - 1], // three tiles off the post
    ] as const) {
      const { world, colony } = sentryWorld();
      const id = addFighter(world, colony, x, y);
      world.ants.targetPosX[id] = -1;
      world.ants.targetPosY[id] = -1;
      world.ants.subTask[id] = FightingSubState.Holding;
      updateFightAntTargets(world);
      expect(targetTile(world, id)).toEqual([ENT_X, ENT_Y - R]);
    }
  });

  it('marks sentries sent to their post or into cover as moving; holders, chasers and those walking home not', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    const holder = addFighter(world, colony, ENT_X, ENT_Y - R);
    const walker = addFighter(world, colony, ENT_X + 6, ENT_Y);
    updateFightAntTargets(world);
    const moving = getScratch(world).antTargeting.sentryMoving;
    expect(moving[holder]).toBe(0);
    expect(moving[walker]).toBe(1);

    // Walking home from outside the guard area is not.
    const home = sentryWorld();
    const far = addFighter(home.world, home.colony, ENT_X + 12, ENT_Y);
    updateFightAntTargets(home.world);
    expect(targetTile(home.world, far)).toEqual([ENT_X, ENT_Y]);
    expect(getScratch(home.world).antTargeting.sentryMoving[far]).toBe(0);

    // Into cover counts as moving; after an enemy does not.
    const cover = sentryWorld();
    const hider = addFighter(cover.world, cover.colony, ENT_X, ENT_Y - R);
    placeAggroSpider(cover.world, ENT_X, ENT_Y - R - 3);
    updateFightAntTargets(cover.world);
    expect(targetTile(cover.world, hider)).toEqual([ENT_X, ENT_Y]);
    expect(getScratch(cover.world).antTargeting.sentryMoving[hider]).toBe(1);

    const chase = sentryWorld();
    const chaser = addFighter(chase.world, chase.colony, ENT_X, ENT_Y - R);
    const enemy = createColonyRecord(2, -1);
    enemy.rallyPoint = null;
    enemy.digFlowFieldDirty = false;
    chase.world.colonies[2] = enemy;
    addFighter(chase.world, enemy, ENT_X + 2, ENT_Y - R);
    updateFightAntTargets(chase.world);
    expect(targetTile(chase.world, chaser)).toEqual([ENT_X + 2, ENT_Y - R]);
    expect(getScratch(chase.world).antTargeting.sentryMoving[chaser]).toBe(0);
  });

  it("a shelterer at the top of the higher-id shaft of a two-door nest holds that door's slot 0", () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    const bx = ENT_X + 10;
    colony.entrances.push({ entranceId: 2, surfaceTileX: bx, surfaceTileY: ENT_Y, isOpen: true });
    addFighter(world, colony, bx, 1, Zone.Underground); // lowest id, top of B's shaft
    const sb = addFighter(world, colony, bx + 2, ENT_Y + 3);
    updateFightAntTargets(world);
    expect(targetTile(world, sb)).not.toEqual([bx, ENT_Y - R]);
  });

  it('a fighter on the first row below the shaft takes no slot in a two-door nest', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    const bx = ENT_X + 10;
    colony.entrances.push({ entranceId: 2, surfaceTileX: bx, surfaceTileY: ENT_Y, isOpen: true });
    addFighter(world, colony, bx, 2, Zone.Underground); // ENTRANCE_SHAFT_DEPTH = 2
    const sb = addFighter(world, colony, bx + 2, ENT_Y + 3);
    updateFightAntTargets(world);
    expect(targetTile(world, sb)).toEqual([bx, ENT_Y - R]);
  });

  it('an own-grid fighter underground below a door near the top of the map climbs out, not to a post', () => {
    const { world, colony } = sentryWorld();
    colony.entrances[0]!.surfaceTileY = 3;
    const id = addFighter(world, colony, ENT_X, 1, Zone.Underground);
    updateFightAntTargets(world);
    expect(targetTile(world, id)).toEqual([ENT_X, 3]);
  });

  it('a foreign door west or south of a ring tile keeps the post off it', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    for (const [fx, fy] of [
      [ENT_X - 1, ENT_Y - R],
      [ENT_X, ENT_Y - R + 1],
    ] as const) {
      const { world, colony } = sentryWorld();
      const other = createColonyRecord(2, -1);
      other.entrances = [{ entranceId: 9, surfaceTileX: fx, surfaceTileY: fy, isOpen: true }];
      other.rallyPoint = null;
      other.digFlowFieldDirty = false;
      world.colonies[2] = other;
      const id = addFighter(world, colony, ENT_X + 2, ENT_Y + 6);
      updateFightAntTargets(world);
      expect(targetTile(world, id)).not.toEqual([ENT_X, ENT_Y - R]);
    }
  });

  it('with no walkable ring tile, the sentry holds instead of targeting the door', () => {
    const R = FIGHT_AGGRO_RADIUS - 1;
    const { world, colony } = sentryWorld();
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        if (Math.abs(dx) + Math.abs(dy) !== R) continue;
        world.bakedSurfaceEffect[(ENT_Y + dy) * SURFACE_GRID_WIDTH + ENT_X + dx] =
          SurfaceMovementEffect.HardBlock;
      }
    }
    world.surfaceComponentMask = null;
    const id = addFighter(world, colony, ENT_X + 1, ENT_Y + 1);
    world.ants.targetPosX[id] = (ENT_X << FP_SHIFT) + (FP_ONE >> 1);
    updateFightAntTargets(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.targetPosY[id]).toBe(-1);
  });

  it('rebuilds the entrance-tile list every pass instead of appending to it', () => {
    const { world, colony } = sentryWorld();
    addFighter(world, colony, ENT_X + 3, ENT_Y + 3);
    updateFightAntTargets(world);
    updateFightAntTargets(world);
    expect(getScratch(world).antTargeting.sentryEntranceTiles.length).toBe(2);
  });
});

describe('pickInvaderUndergroundStep — wall-aware BFS invader step', () => {
  // #231 — one per-world scratch arena reused across all cases, exactly as the
  // module buffer was (each call restores its touched dist cells to -1).
  const scratch = getScratch(createWorldState(1));

  it('returns direct cardinal step when a straight open path exists', () => {
    // 5x5 grid. Fighter at (1,1), target at (1,4) due south. Carve the full
    // column (1,1)..(1,4) Open. BFS distances south are 3,2,1,0; the invader's
    // lowest-distance neighbour is S (1,2)=2 < self 3, so it steps south.
    const { underground } = setupWorldWithUnderground(5, 5);
    ugSet(underground, 1, 1, UndergroundTileState.Open);
    ugSet(underground, 1, 2, UndergroundTileState.Open);
    ugSet(underground, 1, 3, UndergroundTileState.Open);
    ugSet(underground, 1, 4, UndergroundTileState.Open);
    const step = pickInvaderUndergroundStep(underground, 1, 1, 1, 4, scratch);
    expect(unpackStepDx(step)).toBe(0);
    expect(unpackStepDy(step)).toBe(1);
  });

  it('routes around a wall blocking the direct cardinal path', () => {
    // 5x5 grid. Fighter at (2,1), hostile at (4,3). A Solid wall at (2,2)
    // blocks the direct south step. Carve the L path (2,1)->(3,1)->(4,1)->
    // (4,2)->(4,3) Open. BFS routes the invader east first (toward (3,1)=3 <
    // self 4); the blocked south neighbour is never chosen.
    const { underground } = setupWorldWithUnderground(5, 5);
    ugSet(underground, 2, 1, UndergroundTileState.Open);
    ugSet(underground, 3, 1, UndergroundTileState.Open);
    ugSet(underground, 4, 1, UndergroundTileState.Open);
    ugSet(underground, 4, 2, UndergroundTileState.Open);
    ugSet(underground, 4, 3, UndergroundTileState.Open);
    const step = pickInvaderUndergroundStep(underground, 2, 1, 4, 3, scratch);
    expect(unpackStepDx(step)).toBe(1);
    expect(unpackStepDy(step)).toBe(0);
  });

  it('returns (0,0) when already on target tile', () => {
    const { underground } = setupWorldWithUnderground(5, 5);
    const step = pickInvaderUndergroundStep(underground, 3, 3, 3, 3, scratch);
    expect(unpackStepDx(step)).toBe(0);
    expect(unpackStepDy(step)).toBe(0);
  });

  it('returns (0,0) when the target is walled off (unreachable hold, no wall-bounce)', () => {
    // 3x3 grid. Fighter at (1,0) on an Open tile; target (1,2) is isolated
    // (row 1 all Solid, so the target tile has no passable neighbour). With no
    // connected path the BFS never reaches the invader → it holds rather than
    // oscillating against the wall.
    const { underground } = setupWorldWithUnderground(3, 3);
    ugSet(underground, 1, 0, UndergroundTileState.Open);
    const step = pickInvaderUndergroundStep(underground, 1, 0, 1, 2, scratch);
    expect(unpackStepDx(step)).toBe(0);
    expect(unpackStepDy(step)).toBe(0);
  });

  it('routes through a one-tile-wide bent L-corridor whose first legal step increases Manhattan distance (issue #163)', () => {
    // 5x5 grid, everything Solid except the bent corridor
    //   (0,1) -> (0,2) -> (1,2) -> (2,2) -> (2,1)
    // Invader at (0,1), hostile at (2,1). Straight-line Manhattan distance is 2,
    // but the ONLY legal first step is south to (0,2), which RAISES Manhattan
    // distance to 3. The old greedy stepper rejected any non-improving step and
    // froze at this elbow forever; the BFS stepper takes the detour.
    const { underground } = setupWorldWithUnderground(5, 5);
    ugSet(underground, 0, 1, UndergroundTileState.Open);
    ugSet(underground, 0, 2, UndergroundTileState.Open);
    ugSet(underground, 1, 2, UndergroundTileState.Open);
    ugSet(underground, 2, 2, UndergroundTileState.Open);
    ugSet(underground, 2, 1, UndergroundTileState.Open);

    // First step is the distance-increasing detour (south), not a hold.
    const first = pickInvaderUndergroundStep(underground, 0, 1, 2, 1, scratch);
    expect(unpackStepDx(first)).toBe(0);
    expect(unpackStepDy(first)).toBe(1);

    // Walking the returned steps reaches the hostile tile along the 4-step
    // path without ever stalling.
    let x = 0;
    let y = 1;
    let steps = 0;
    while (!(x === 2 && y === 1) && steps < 16) {
      const s = pickInvaderUndergroundStep(underground, x, y, 2, 1, scratch);
      const sdx = unpackStepDx(s);
      const sdy = unpackStepDy(s);
      expect(sdx !== 0 || sdy !== 0).toBe(true); // never stalls on a connected path
      x += sdx;
      y += sdy;
      steps++;
    }
    expect(x).toBe(2);
    expect(y).toBe(1);
    expect(steps).toBe(4);
  });
});
