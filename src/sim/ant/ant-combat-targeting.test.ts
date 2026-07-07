// combat-targeting — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-combat-targeting.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import {
  unpackStepDx,
  unpackStepDy,
  updateFightAntTargets,
  pickInvaderUndergroundStep,
} from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V17_COMBAT_AGGRO,
  SIM_VERSION_V22_DIFFICULTY,
  SIM_VERSION_V23_SPIDER_AGGRO,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { getScratch } from '../scratch.js';
import { AntTask } from '../enums.js';
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

  it('falls back to first entrance (surfaceTileX/surfaceTileY in fp) when rallyPoint is null', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
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

  it('V23 gate: a pre-V23 (V22) world shows no spider auto-aggro', () => {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V22_DIFFICULTY;
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

    const spider = placeAggroSpider(world, 11, 10); // dist 1, but gate is closed pre-V23

    updateFightAntTargets(world);

    // No auto-aggro: fighter follows the rally, not the spider.
    expect(world.ants.targetPosX[fighter]).toBe((50 << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosX[fighter]).not.toBe(spider.posX);
  });
});

// ---------------------------------------------------------------------------
// pickInvaderUndergroundStep — wall-aware BFS step (UAT: fighters freeze bug;
// issue #163: route through bent tunnels)
//
// BFS routing requires a fully connected passable path from the invader's tile
// to the target — including the invader's OWN tile — so each scenario carves
// the complete corridor (the old greedy stepper only looked one tile ahead).
// ---------------------------------------------------------------------------

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
