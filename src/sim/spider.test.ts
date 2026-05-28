// src/sim/spider.test.ts — S3 spider state machine unit tests.

import { describe, it, expect } from 'vitest';
import type { WorldState, SpiderState } from './types.js';
import { createWorldState, SIM_VERSION_V19_AI_STATE, SIM_VERSION_V20_SPIDER } from './types.js';
import { tickSpider } from './spider.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, PheromoneType } from './enums.js';
import { createPheromoneGrid, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyId } from './colony/colony-store.js';
import {
  SPIDER_HP_FULL,
  SPIDER_TELEGRAPH_TICKS,
  SPIDER_STRIKE_TICKS,
  SPIDER_FEEDING_TICKS,
  SPIDER_HUNT_INTERVAL_TICKS,
  SPIDER_HUNGER_MAX_TICKS,
  SPIDER_RAMPAGE_KILL_QUOTA,
  SURFACE_GRID_WIDTH,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
} from './constants.js';
import { FP_SHIFT } from './fixed.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpider(overrides: Partial<SpiderState> = {}): SpiderState {
  return {
    state: 'Patrolling',
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
    ...overrides,
  };
}

function makeWorld(seed = 0): WorldState {
  const world = createWorldState(seed);
  world.simVersion = SIM_VERSION_V20_SPIDER;
  // Add pheromone grids for both colonies so seedDangerPheromone doesn't crash.
  for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
    const surfaceKey = pheromoneGridKey(cid, PheromoneType.DangerTrail, 'surface');
    world.pheromoneGrids[surfaceKey] = createPheromoneGrid(SURFACE_GRID_WIDTH, 128);
  }
  return world;
}

/** Place a surface worker at tile (tx, ty) in the world. Returns ant index. */
function placeWorker(world: WorldState, tx: number, ty: number, colonyId = PLAYER_COLONY_ID): number {
  const id = world.nextEntityId++;
  initAnt(world.ants, id, {
    colonyId,
    posX: tx << FP_SHIFT,
    posY: ty << FP_SHIFT,
    task: AntTask.Foraging,
  });
  return id;
}

// ---------------------------------------------------------------------------
// State transition tests
// ---------------------------------------------------------------------------

describe('tickSpider', () => {
  describe('null spider: no-op', () => {
    it('does nothing when world.spider is null', () => {
      const world = makeWorld();
      world.spider = null;
      world.scatterReticleTile = { x: 5, y: 5 }; // should be cleared
      tickSpider(world);
      expect(world.spider).toBeNull();
      expect(world.scatterReticleTile).toBeNull();
    });
  });

  describe('Patrolling → Hunting transition', () => {
    it('transitions to Hunting when tick >= nextHuntTick and workers are present', () => {
      const world = makeWorld();
      const spiderTileX = 64;
      const spiderTileY = 32;
      world.spider = makeSpider({ posX: spiderTileX << FP_SHIFT, posY: spiderTileY << FP_SHIFT });
      world.spider.nextHuntTick = 0; // trigger immediately

      // Place 2 workers near spider
      placeWorker(world, spiderTileX + 2, spiderTileY);
      placeWorker(world, spiderTileX + 2, spiderTileY);

      tickSpider(world);
      expect(world.spider!.state).toBe('Hunting');
      expect(world.spider!.huntStartTick).toBe(0);
      expect(world.spider!.huntTargetTileX).toBe(spiderTileX + 2);
      expect(world.spider!.huntTargetTileY).toBe(spiderTileY);
    });

    it('stays Patrolling when no workers in range', () => {
      const world = makeWorld();
      world.spider = makeSpider();
      world.spider.nextHuntTick = 0;
      // No workers placed
      tickSpider(world);
      expect(world.spider!.state).toBe('Patrolling');
    });

    it('stays Patrolling when tick < nextHuntTick even with workers present', () => {
      const world = makeWorld();
      const spiderTileX = 64;
      const spiderTileY = 32;
      world.spider = makeSpider({ posX: spiderTileX << FP_SHIFT, posY: spiderTileY << FP_SHIFT });
      world.spider.nextHuntTick = 9999;
      placeWorker(world, spiderTileX + 2, spiderTileY);
      placeWorker(world, spiderTileX + 2, spiderTileY);

      tickSpider(world);
      expect(world.spider!.state).toBe('Patrolling');
    });
  });

  describe('Hunting → Striking transition', () => {
    it('transitions to Striking after SPIDER_TELEGRAPH_TICKS', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Hunting',
        huntStartTick: 0,
        huntTargetTileX: 65,
        huntTargetTileY: 32,
      });
      world.tick = SPIDER_TELEGRAPH_TICKS;

      tickSpider(world);
      expect(world.spider!.state).toBe('Striking');
      expect(world.spider!.strikeStartTick).toBe(SPIDER_TELEGRAPH_TICKS);
      expect(world.spider!.killsThisStrike).toBe(0);
    });

    it('stays Hunting before SPIDER_TELEGRAPH_TICKS', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Hunting',
        huntStartTick: 0,
        huntTargetTileX: 65,
        huntTargetTileY: 32,
      });
      world.tick = SPIDER_TELEGRAPH_TICKS - 1;

      tickSpider(world);
      expect(world.spider!.state).toBe('Hunting');
    });
  });

  describe('Striking → Feeding transition (kill path)', () => {
    it('transitions to Feeding after SPIDER_STRIKE_TICKS when kills > 0', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Striking',
        strikeStartTick: 0,
        killsThisStrike: 3,
        huntTargetTileX: 65,
        huntTargetTileY: 32,
      });
      world.tick = SPIDER_STRIKE_TICKS;

      tickSpider(world);
      expect(world.spider!.state).toBe('Feeding');
      expect(world.spider!.feedingStartTick).toBe(SPIDER_STRIKE_TICKS);
      expect(world.spider!.hungerTicks).toBe(0); // reset on Feeding entry
    });
  });

  describe('Striking → Patrolling transition (scatter/frustrate path)', () => {
    it('transitions to Patrolling after SPIDER_STRIKE_TICKS with zero kills', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Striking',
        strikeStartTick: 0,
        killsThisStrike: 0,
        huntTargetTileX: 65,
        huntTargetTileY: 32,
      });
      world.tick = SPIDER_STRIKE_TICKS;

      tickSpider(world);
      expect(world.spider!.state).toBe('Patrolling');
      expect(world.spider!.nextHuntTick).toBe(SPIDER_STRIKE_TICKS + SPIDER_HUNT_INTERVAL_TICKS);
      expect(world.spider!.huntTargetTileX).toBe(-1);
    });

    it('clears stale -2 combatOpponentId sentinels on Striking → Patrolling exit', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Striking',
        strikeStartTick: 0,
        killsThisStrike: 0,
        huntTargetTileX: 65,
        huntTargetTileY: 32,
      });
      // Simulate an ant that was paired with the spider during this Striking episode
      const antId = placeWorker(world, 65, 32);
      world.ants.combatOpponentId[antId] = -2;

      world.tick = SPIDER_STRIKE_TICKS;
      tickSpider(world);

      expect(world.spider!.state).toBe('Patrolling');
      expect(world.ants.combatOpponentId[antId]).toBe(-1);
    });
  });

  describe('Feeding → Patrolling transition', () => {
    it('returns to Patrolling after SPIDER_FEEDING_TICKS', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Feeding',
        feedingStartTick: 0,
        huntTargetTileX: -1,
        huntTargetTileY: -1,
      });
      world.tick = SPIDER_FEEDING_TICKS;

      tickSpider(world);
      expect(world.spider!.state).toBe('Patrolling');
      expect(world.spider!.nextHuntTick).toBe(SPIDER_FEEDING_TICKS + SPIDER_HUNT_INTERVAL_TICKS);
    });
  });

  // ---------------------------------------------------------------------------
  // Hunger accrual and reset
  // ---------------------------------------------------------------------------

  describe('hunger accrual', () => {
    it('accrues hungerTicks every tick while not Feeding', () => {
      const world = makeWorld();
      world.spider = makeSpider({ state: 'Patrolling', hungerTicks: 10 });
      world.tick = 0;
      tickSpider(world);
      expect(world.spider!.hungerTicks).toBe(11);
    });

    it('does not accrue hungerTicks while Feeding', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Feeding',
        hungerTicks: 50,
        feedingStartTick: 0,
      });
      world.tick = 1;
      tickSpider(world);
      expect(world.spider!.hungerTicks).toBe(50); // unchanged
    });

    it('resets hungerTicks on Feeding entry from Striking', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Striking',
        strikeStartTick: 0,
        killsThisStrike: 2,
        hungerTicks: 500,
        huntTargetTileX: 65,
        huntTargetTileY: 32,
      });
      world.tick = SPIDER_STRIKE_TICKS;
      tickSpider(world);
      expect(world.spider!.state).toBe('Feeding');
      expect(world.spider!.hungerTicks).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rampage trigger
  // ---------------------------------------------------------------------------

  describe('Patrolling → Rampaging transition', () => {
    it('triggers Rampaging when hungerTicks reaches SPIDER_HUNGER_MAX_TICKS[1]', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Patrolling',
        // hungerTicks will be incremented before the check, so set to max - 1
        hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
      });
      world.tick = 0;

      tickSpider(world);
      // After increment: hungerTicks = SPIDER_HUNGER_MAX_TICKS[1]; triggers rampaging.
      expect(world.spider!.state).toBe('Rampaging');
      expect(world.spider!.rampageKillsThisRampage).toBe(0);
    });
  });


  describe('rampageTargetColonyId — weighted colony selection', () => {
    it('sets rampageTargetColonyId on Rampaging entry and clears it on exit', () => {
      const world = makeWorld();
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = createColonyRecord(PLAYER_COLONY_ID, 0);
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.entrances = [];
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId] = createColonyRecord(ENEMY_COLONY_ID, 1);
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId]!.entrances = [];
      world.spider = makeSpider({
        state: 'Patrolling',
        hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
      });
      world.tick = 0;

      tickSpider(world);
      expect(world.spider!.state).toBe('Rampaging');
      expect(world.spider!.rampageTargetColonyId === PLAYER_COLONY_ID ||
             world.spider!.rampageTargetColonyId === ENEMY_COLONY_ID).toBe(true);

      // Transition to Feeding via kill quota — target should be cleared.
      world.spider!.rampageKillsThisRampage = SPIDER_RAMPAGE_KILL_QUOTA;
      tickSpider(world);
      expect(world.spider!.state).toBe('Feeding');
      expect(world.spider!.rampageTargetColonyId).toBe(-1);
    });

    it('always targets a valid colony (not -1) when both colonies exist', () => {
      // Run 20 rampages across varying seeds and ticks; none should produce -1.
      for (let seed = 1; seed <= 20; seed++) {
        const world = makeWorld(seed * 1000);
        world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = createColonyRecord(PLAYER_COLONY_ID, 0);
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.entrances = [];
        world.colonies[ENEMY_COLONY_ID as unknown as ColonyId] = createColonyRecord(ENEMY_COLONY_ID, 1);
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId]!.entrances = [];
        world.spider = makeSpider({
          state: 'Patrolling',
          hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
        });
        world.tick = seed * 100;
        tickSpider(world);
        expect(world.spider!.rampageTargetColonyId).toBeGreaterThan(0);
      }
    });

    it('distributes targets across both colonies over many rampages (not always same colony)', () => {
      // Over 50 rampages with varying ticks, both colonies should be chosen at least once.
      const chosen = new Set<number>();
      const world = makeWorld(42);
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = createColonyRecord(PLAYER_COLONY_ID, 0);
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.entrances = [];
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId] = createColonyRecord(ENEMY_COLONY_ID, 1);
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId]!.entrances = [];
      for (let tick = 0; tick < 50; tick++) {
        world.spider = makeSpider({
          state: 'Patrolling',
          hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
          rampageStartTick: 0,
        });
        world.tick = tick * 37; // vary tick to get different hash values
        tickSpider(world);
        chosen.add(world.spider!.rampageTargetColonyId);
      }
      // Both colonies should appear at least once across 50 rampages.
      expect(chosen.has(PLAYER_COLONY_ID)).toBe(true);
      expect(chosen.has(ENEMY_COLONY_ID)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Spider death
  // ---------------------------------------------------------------------------

  describe('spider death', () => {
    it('clears world.spider when hp <= 0', () => {
      const world = makeWorld();
      world.spider = makeSpider({ hp: 0 });
      world.spiderPriorityColonyId = PLAYER_COLONY_ID;
      world.scatterReticleTile = { x: 5, y: 5 };

      tickSpider(world);
      expect(world.spider).toBeNull();
      expect(world.spiderPriorityColonyId).toBeNull();
      expect(world.scatterReticleTile).toBeNull();
    });

    it('emits spider_hunt_end(swarm_retreat) when dying in Striking', () => {
      const world = makeWorld();
      world.spider = makeSpider({ state: 'Striking', hp: 0, killsThisStrike: 2 });
      tickSpider(world);
      expect(world.spider).toBeNull();
      // Event should be in world.events
      const evt = world.events.find((e) => e.type === 'spider_hunt_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_hunt_end') {
        expect(evt.payload.outcome).toBe('swarm_retreat');
        expect(evt.payload.deaths).toBe(2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // scatterReticleTile shadow field
  // ---------------------------------------------------------------------------

  describe('scatterReticleTile', () => {
    it('is set during Hunting', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Hunting',
        huntStartTick: 0,
        huntTargetTileX: 70,
        huntTargetTileY: 40,
      });
      world.scatterReticleTile = null;
      world.tick = 1;

      tickSpider(world);
      expect(world.scatterReticleTile).not.toBeNull();
      expect(world.scatterReticleTile!.x).toBe(70);
      expect(world.scatterReticleTile!.y).toBe(40);
    });

    it('is set during Striking', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Striking',
        strikeStartTick: 0,
        huntTargetTileX: 70,
        huntTargetTileY: 40,
      });
      world.scatterReticleTile = null;
      world.tick = 1;

      tickSpider(world);
      expect(world.scatterReticleTile).not.toBeNull();
      expect(world.scatterReticleTile!.x).toBe(70);
    });

    it('is null during Patrolling', () => {
      const world = makeWorld();
      world.spider = makeSpider({ state: 'Patrolling' });
      world.scatterReticleTile = { x: 5, y: 5 };

      tickSpider(world);
      expect(world.scatterReticleTile).toBeNull();
    });

    it('is null during Feeding', () => {
      const world = makeWorld();
      world.spider = makeSpider({ state: 'Feeding', feedingStartTick: 0 });
      world.scatterReticleTile = { x: 5, y: 5 };
      world.tick = 1;

      tickSpider(world);
      expect(world.scatterReticleTile).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // V19 replay determinism: spider null for pre-V20 worlds
  // ---------------------------------------------------------------------------

  describe('V19 replay determinism', () => {
    it('world.spider is null when simVersion < V20 (createWorldState default before S3)', () => {
      const world = createWorldState(42);
      world.simVersion = SIM_VERSION_V19_AI_STATE; // pre-V20
      // Spider starts null in createWorldState
      expect(world.spider).toBeNull();
    });

    it('tickSpider is a no-op when spider is null (gated by tick.ts but also safe to call directly)', () => {
      const world = createWorldState(42);
      world.simVersion = SIM_VERSION_V19_AI_STATE;
      world.spider = null;
      tickSpider(world);
      expect(world.spider).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // HP regeneration
  // ---------------------------------------------------------------------------

  describe('HP regeneration', () => {
    it('regenerates 1 HP per 20 ticks while Retreating', () => {
      const world = makeWorld();
      world.spider = makeSpider({ state: 'Retreating', hp: 40, retreatStartTick: 0 });
      world.tick = 20;

      tickSpider(world);
      expect(world.spider!.hp).toBe(41);
    });

    it('does not exceed SPIDER_HP_FULL', () => {
      const world = makeWorld();
      world.spider = makeSpider({ state: 'Retreating', hp: SPIDER_HP_FULL - 1, retreatStartTick: 0 });
      world.tick = 20;

      tickSpider(world);
      expect(world.spider!.hp).toBe(SPIDER_HP_FULL);
    });
  });

  // ---------------------------------------------------------------------------
  // Rampaging: kill quota triggers Feeding
  // ---------------------------------------------------------------------------

  describe('Rampaging → Feeding via kill quota', () => {
    it('transitions to Feeding when rampageKillsThisRampage reaches SPIDER_RAMPAGE_KILL_QUOTA', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Rampaging',
        rampageKillsThisRampage: SPIDER_RAMPAGE_KILL_QUOTA,
      });
      world.tick = 100;

      tickSpider(world);
      expect(world.spider!.state).toBe('Feeding');
      expect(world.spider!.hungerTicks).toBe(0);
    });
  });
});
