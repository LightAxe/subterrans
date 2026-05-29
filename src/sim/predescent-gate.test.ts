// predescent-gate.test.ts — regression coverage for the pre-descent gate.
//
// Descent (Surface → Underground) is a zone transition performed during step-16
// movement (tickAntMovement), which runs BEFORE step-17 combat and step-17.5
// spider. Two bugs followed from that ordering:
//
//   #164 — a foreign Fighter standing on an enemy entrance could descend past a
//          queen still sitting on that same surface tile (the pre-Queen-chamber
//          opening state) before surface combat ever saw the encounter.
//   #165 — a carrying forager could descend through an entrance a rampaging
//          spider was blockading before spider combat checked the surface tile.
//
// The fix holds the ant on the entrance's surface tile when a blocker occupies
// it, so the relevant combat pass resolves the encounter the same tick.

import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { allocateEntityId } from './types.js';
import type { WorldState, SpiderState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, ForagingSubState } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  ENEMY_START_X,
  ENEMY_START_Y,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  COMBAT_HP_QUEEN,
  COMBAT_HP_BASE,
  COMBAT_COOLDOWN_TICKS,
  SPIDER_HP_FULL,
} from './constants.js';

const SEED = 4242;

/** Tile-center fixed-point coordinate for a tile index. */
function center(tile: number): number {
  return (tile << FP_SHIFT) + (FP_ONE >> 1);
}

/** Build a Rampaging spider parked on (tileX, tileY). */
function rampagingSpiderAt(tileX: number, tileY: number, targetColonyId: number): SpiderState {
  return {
    state: 'Rampaging',
    posX: center(tileX),
    posY: center(tileY),
    lairTileX: tileX,
    lairTileY: tileY,
    territoryRadiusTiles: 24,
    hp: SPIDER_HP_FULL,
    attackCooldown: 0,
    hungerTicks: 0,
    nextHuntTick: 0,
    huntStartTick: 0,
    strikeStartTick: 0,
    feedingStartTick: 0,
    retreatStartTick: 0,
    rampageStartTick: 0,
    huntTargetTileX: -1,
    huntTargetTileY: -1,
    killsThisStrike: 0,
    rampageKillsThisRampage: 0,
    rampageTargetColonyId: targetColonyId,
    chaseTargetAntId: -1,
    chaseStartTick: 0,
  };
}

/** Spawn a player Fighter on the enemy entrance tile, rallied so it holds. */
function spawnInvaderOnEnemyEntrance(world: WorldState): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX:     center(ENEMY_START_X),
    posY:     center(ENEMY_START_Y),
    task:     AntTask.Fighting,
    subTask:  0,
    speed:    WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Surface,
  });
  world.colonies[PLAYER_COLONY_ID]!.workers.push(id);
  world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;
  // Rally + fight ratio > 0 so recall logic doesn't fire and the fighter holds
  // on the entrance tile rather than walking home.
  world.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: ENEMY_START_X, tileY: ENEMY_START_Y };
  world.colonies[PLAYER_COLONY_ID]!.targetRatio.fight = 5;
  return id;
}

/** Spawn a player carrying-forager on the player entrance tile. */
function spawnCarrierOnPlayerEntrance(world: WorldState): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX:     center(PLAYER_START_X),
    posY:     center(PLAYER_START_Y),
    task:     AntTask.Foraging,
    subTask:  ForagingSubState.CarryingFood,
    speed:    WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    hp:       COMBAT_HP_BASE,
    zone:     Zone.Surface,
  });
  world.ants.foodCarrying[id] = FP_ONE; // carrying food → has descent intent
  world.colonies[PLAYER_COLONY_ID]!.workers.push(id);
  world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;
  return id;
}

describe('pre-descent gate — #164 foreign Fighter vs. a surface queen on an entrance', () => {
  it('does NOT descend past an enemy queen sitting on the enemy entrance tile', () => {
    const world = createScenario(SEED);
    world.spider = null; // isolate the queen encounter from spider combat
    // createScenario leaves the enemy queen on (ENEMY_START_X, ENEMY_START_Y),
    // which is also the enemy entrance — exactly the #164 opening state.
    const enemyQueenId = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
    expect(world.ants.zone[enemyQueenId]).toBe(Zone.Surface);
    expect(world.ants.posX[enemyQueenId]! >> FP_SHIFT).toBe(ENEMY_START_X);
    expect(world.ants.posY[enemyQueenId]! >> FP_SHIFT).toBe(ENEMY_START_Y);

    const invaderId = spawnInvaderOnEnemyEntrance(world);

    tick(world, []);

    // Gate held the invader on the surface in its own grid — it did not slip
    // underground past the queen.
    expect(world.ants.zone[invaderId]).toBe(Zone.Surface);
    expect(world.ants.currentGridColonyId[invaderId]).toBe(PLAYER_COLONY_ID);
  });

  it('resolves the surface encounter — the held invader damages the queen', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const enemyQueenId = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
    const invaderId = spawnInvaderOnEnemyEntrance(world);

    // Tick past combat windup (COMBAT_COOLDOWN_TICKS) so a strike lands.
    for (let i = 0; i < COMBAT_COOLDOWN_TICKS + 4; i++) tick(world, []);

    // The invader stayed contesting the queen tile (surface) and the queen took
    // damage — the encounter the old ordering skipped now resolves.
    expect(world.ants.zone[invaderId]).toBe(Zone.Surface);
    const queenDamaged =
      world.ants.alive[enemyQueenId] === 0 || world.ants.hp[enemyQueenId]! < COMBAT_HP_QUEEN;
    expect(queenDamaged).toBe(true);
  });

  it('control: with the enemy queen moved off the entrance tile, the invader descends', () => {
    const world = createScenario(SEED);
    world.spider = null;
    // Relocate the enemy queen off the entrance (she holds — no Queen chamber).
    const enemyQueenId = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
    world.ants.posX[enemyQueenId] = (ENEMY_START_X + 6) << FP_SHIFT;

    const invaderId = spawnInvaderOnEnemyEntrance(world);

    let descended = false;
    for (let i = 0; i < 5; i++) {
      tick(world, []);
      if (world.ants.zone[invaderId] === Zone.Underground) { descended = true; break; }
    }

    expect(descended).toBe(true);
    expect(world.ants.currentGridColonyId[invaderId]).toBe(ENEMY_COLONY_ID);
  });
});

describe('pre-descent gate — #165 rampaging spider blockade at an entrance', () => {
  it('does NOT descend through an entrance a rampaging spider is parked on', () => {
    const world = createScenario(SEED);
    world.spider = rampagingSpiderAt(PLAYER_START_X, PLAYER_START_Y, PLAYER_COLONY_ID);

    const carrierId = spawnCarrierOnPlayerEntrance(world);

    tick(world, []);

    // Gate held the carrier on the surface entrance tile instead of letting it
    // slip underground before spider combat could see it.
    expect(world.ants.zone[carrierId]).toBe(Zone.Surface);
  });

  it('blockade resolves — the held carrier is caught (damaged or killed) by the spider', () => {
    const world = createScenario(SEED);
    world.spider = rampagingSpiderAt(PLAYER_START_X, PLAYER_START_Y, PLAYER_COLONY_ID);

    const carrierId = spawnCarrierOnPlayerEntrance(world);
    const startHp = world.ants.hp[carrierId]!;

    // Tick past spider-combat windup; verify it never reaches Underground.
    let everUnderground = false;
    for (let i = 0; i < COMBAT_COOLDOWN_TICKS + 4; i++) {
      tick(world, []);
      if (world.ants.alive[carrierId] === 1 && world.ants.zone[carrierId] === Zone.Underground) {
        everUnderground = true;
        break;
      }
    }

    expect(everUnderground).toBe(false);
    const caught = world.ants.alive[carrierId] === 0 || world.ants.hp[carrierId]! < startHp;
    expect(caught).toBe(true);
  });

  it('control: with no spider on the entrance, the carrier descends normally', () => {
    const world = createScenario(SEED);
    world.spider = null; // no blockade

    const carrierId = spawnCarrierOnPlayerEntrance(world);

    let descended = false;
    for (let i = 0; i < 5; i++) {
      tick(world, []);
      if (world.ants.zone[carrierId] === Zone.Underground) { descended = true; break; }
    }

    expect(descended).toBe(true);
  });
});
