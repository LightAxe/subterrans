// src/sim/spider.test.ts — S3 spider state machine unit tests.

import { describe, it, expect } from 'vitest';
import type { WorldState, SpiderState } from './types.js';
import {
  createWorldState,
  SIM_VERSION_V19_AI_STATE,
  SIM_VERSION_V20_SPIDER,
  SIM_VERSION_V23_SPIDER_AGGRO,
  SIM_VERSION_V26_SPIDER_EDGE_MARGIN,
  SIM_VERSION_V31_SPIDER_TERRAIN,
  SIM_VERSION_V32_AI_OP_VALIDATION,
} from './types.js';
import { PLAYTRACE_EVENT_CAP_PER_ROUND } from './telemetry.js';
import { tickSpider, isSpiderPassable, computeFeedAwayTile } from './spider.js';
import { SurfaceMovementEffect } from './surface-features.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, PheromoneType } from './enums.js';
import { createPheromoneGrid, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ColonyId } from './colony/colony-store.js';
import {
  SPIDER_HP_FULL,
  SPIDER_TELEGRAPH_TICKS,
  SPIDER_STRIKE_TICKS,
  SPIDER_HUNT_INTERVAL_TICKS,
  SPIDER_HUNGER_MAX_TICKS,
  SPIDER_CHASE_TRIGGER_RADIUS,
  SPIDER_DEFENSE_TRIGGER_RADIUS,
  SPIDER_CHASE_MAX_TICKS,
  SPIDER_RAMPAGE_RETREAT_HP,
  SPIDER_RAMPAGE_MAX_TICKS,
  SPIDER_SPEED,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_MEANDER_TICK_DIVISOR,
  SPIDER_FEED_TICKS,
  SPIDER_FEED_RETREAT_TILES,
  SPIDER_FEED_HEAL_INTERVAL_TICKS,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  SPIDER_EDGE_MARGIN_TILES,
} from './constants.js';
import { FP_SHIFT } from './fixed.js';
import { Zone } from './terrain.js';

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
function placeWorker(
  world: WorldState,
  tx: number,
  ty: number,
  colonyId = PLAYER_COLONY_ID,
): number {
  const id = world.nextEntityId++;
  initAnt(world.ants, id, {
    colonyId,
    posX: tx << FP_SHIFT,
    posY: ty << FP_SHIFT,
    task: AntTask.Foraging,
  });
  return id;
}

function placeFighter(
  world: WorldState,
  tx: number,
  ty: number,
  colonyId = PLAYER_COLONY_ID,
): number {
  const id = world.nextEntityId++;
  initAnt(world.ants, id, {
    colonyId,
    posX: tx << FP_SHIFT,
    posY: ty << FP_SHIFT,
    task: AntTask.Fighting,
  });
  return id;
}

// Hunger value (Normal tier) that puts a V23 spider over the hungry threshold.
const HUNGRY_TICKS = SPIDER_HUNGER_THRESHOLD_TICKS[1];

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

  describe('Patrolling → Hunting transition (V23 telegraphed density hunt)', () => {
    // Hunt entry is gated in tickSpiderV23 behind hunger + past-grace + the
    // chase→hunt→rampage precedence: a hungry, active spider with no lone ant
    // in chase range but a dense worker tile in hunt range telegraphs a hunt.
    // (The pre-V23 sated/in-grace/chase-range entry was reaped with
    // tickSpiderV22 — a sated or in-grace spider stays Patrolling, covered by
    // the hunger-gate and start-of-match-grace describes.)
    const SX = 64;
    const SY = 32;
    // Two workers on ONE tile just past chase radius → in hunt range (12), so
    // no opportunistic chase pre-empts the telegraphed hunt.
    const HUNT_TILE_X = SX + SPIDER_CHASE_TRIGGER_RADIUS + 2;

    it('enters Hunting on a dense worker tile in hunt range when hungry and off cooldown', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({
        posX: SX << FP_SHIFT,
        posY: SY << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.spider.nextHuntTick = 0; // off cooldown
      world.tick = SPIDER_GRACE_TICKS; // past grace → active
      placeWorker(world, HUNT_TILE_X, SY);
      placeWorker(world, HUNT_TILE_X, SY);

      tickSpider(world);

      expect(world.spider.state).toBe('Hunting');
      expect(world.spider.huntStartTick).toBe(SPIDER_GRACE_TICKS);
      expect(world.spider.huntTargetTileX).toBe(HUNT_TILE_X);
      expect(world.spider.huntTargetTileY).toBe(SY);
      const started = world.events.find((e) => e.type === 'spider_hunt_start');
      expect(started).toBeDefined();
      if (started?.type === 'spider_hunt_start') {
        expect(started.payload.targetWorkers).toBe(2);
      }
    });

    it('does NOT enter Hunting while on cooldown (tick < nextHuntTick) — camps instead', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({
        posX: SX << FP_SHIFT,
        posY: SY << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.tick = SPIDER_GRACE_TICKS; // past grace
      world.spider.nextHuntTick = world.tick + 100; // hunt on cooldown
      placeWorker(world, HUNT_TILE_X, SY);
      placeWorker(world, HUNT_TILE_X, SY);

      tickSpider(world);

      // A hungry spider that can't hunt (on cooldown) camps an entrance
      // (Rampaging) rather than staying Patrolling — no hunt is telegraphed.
      expect(world.spider.state).not.toBe('Hunting');
      expect(world.spider.state).toBe('Rampaging');
      expect(world.events.some((e) => e.type === 'spider_hunt_start')).toBe(false);
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
      expect(world.spider.state).toBe('Striking');
      expect(world.spider.strikeStartTick).toBe(SPIDER_TELEGRAPH_TICKS);
      expect(world.spider.killsThisStrike).toBe(0);
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
      expect(world.spider.state).toBe('Hunting');
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
      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.nextHuntTick).toBe(SPIDER_STRIKE_TICKS + SPIDER_HUNT_INTERVAL_TICKS);
      expect(world.spider.huntTargetTileX).toBe(-1);
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

      expect(world.spider.state).toBe('Patrolling');
      expect(world.ants.combatOpponentId[antId]).toBe(-1);
    });
  });

  // ---------------------------------------------------------------------------
  // Hunger accrual and reset
  // ---------------------------------------------------------------------------

  describe('hunger accrual', () => {
    it('does not accrue hungerTicks while Feeding', () => {
      const world = makeWorld();
      world.spider = makeSpider({
        state: 'Feeding',
        hungerTicks: 50,
        feedingStartTick: 0,
      });
      world.tick = 1;
      tickSpider(world);
      expect(world.spider.hungerTicks).toBe(50); // unchanged
    });
  });

  describe('rampageTargetColonyId — weighted colony selection', () => {
    it('distributes targets across both colonies over many rampages (not always same colony)', () => {
      // Over 50 rampages with varying ticks, both colonies should be chosen at least once.
      const chosen = new Set<number>();
      const world = makeWorld(42);
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = createColonyRecord(
        PLAYER_COLONY_ID,
        0,
      );
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.entrances = [];
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId] = createColonyRecord(
        ENEMY_COLONY_ID,
        1,
      );
      world.colonies[ENEMY_COLONY_ID as unknown as ColonyId]!.entrances = [];
      for (let tick = 0; tick < 50; tick++) {
        world.spider = makeSpider({
          state: 'Patrolling',
          hungerTicks: SPIDER_HUNGER_MAX_TICKS[1] - 1,
          rampageStartTick: 0,
        });
        world.tick = tick * 37; // vary tick to get different hash values
        tickSpider(world);
        chosen.add(world.spider.rampageTargetColonyId);
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

    it('V32: emits spider_hunt_end(swarm_retreat, deaths 0) when dying while Hunting (#226)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V32_AI_OP_VALIDATION;
      // killsThisStrike is deliberately nonzero: deaths must still report 0, since
      // that counter holds the PREVIOUS strike's kills during the Hunting telegraph.
      world.spider = makeSpider({ state: 'Hunting', hp: 0, killsThisStrike: 2 });
      tickSpider(world);
      expect(world.spider).toBeNull();
      const evt = world.events.find((e) => e.type === 'spider_hunt_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_hunt_end') {
        expect(evt.payload.outcome).toBe('swarm_retreat');
        expect(evt.payload.deaths).toBe(0);
      }
    });

    it('V32: a same-tick Hunting kill + death reports outcome kill with exactly the fresh death (#226)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V32_AI_OP_VALIDATION;
      // The combat resolver can set killedThisTick=1 while also dropping hp<=0 in the
      // same step. killsThisStrike is deliberately STALE (5, from a prior strike) — the
      // report must use the one fresh same-tick kill (killedThisTick), not the stale count.
      world.spider = makeSpider({ state: 'Hunting', hp: 0, killedThisTick: 1, killsThisStrike: 5 });
      tickSpider(world);
      const evt = world.events.find((e) => e.type === 'spider_hunt_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_hunt_end') {
        expect(evt.payload.outcome).toBe('kill');
        expect(evt.payload.deaths).toBe(1); // NOT the stale killsThisStrike (5)
      }
    });

    it('pre-V32: dying while Hunting emits no spider_hunt_end (dangling episode preserved)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V31_SPIDER_TERRAIN;
      world.spider = makeSpider({ state: 'Hunting', hp: 0, killsThisStrike: 2 });
      tickSpider(world);
      expect(world.spider).toBeNull();
      expect(world.events.some((e) => e.type === 'spider_hunt_end')).toBe(false);
    });

    it('V32 cap-full: dying while Hunting bumps a persisted dropped-event counter (byte-impact pin)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V32_AI_OP_VALIDATION;
      // Fill the event buffer to the hard cap so the added hunt_end overflows and
      // bumps a PERSISTED dropped counter — the exact divergence that requires
      // gating this emission (#226 item 1).
      for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND; i++) {
        world.events.push({
          tick: 0,
          type: 'spider_hunt_end',
          payload: { outcome: 'kill', deaths: 0 },
        });
      }
      world.spider = makeSpider({ state: 'Hunting', hp: 0 });
      tickSpider(world);
      expect(world.droppedStructuralCount + world.droppedCombatKillCount).toBeGreaterThan(0);
    });

    it('pre-V32 cap-full: dying while Hunting emits nothing, dropped counters unchanged', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V31_SPIDER_TERRAIN;
      for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND; i++) {
        world.events.push({
          tick: 0,
          type: 'spider_hunt_end',
          payload: { outcome: 'kill', deaths: 0 },
        });
      }
      world.spider = makeSpider({ state: 'Hunting', hp: 0 });
      tickSpider(world);
      expect(world.droppedStructuralCount + world.droppedCombatKillCount).toBe(0);
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
  // V23 (#146): Chasing — opportunistic chase of a nearby ant
  // ---------------------------------------------------------------------------

  describe('hunger gate (V23 redesign #146/#147)', () => {
    it('a sated spider does NOT chase a lone ant in radius', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({ posX: sx << FP_SHIFT, posY: sy << FP_SHIFT, hungerTicks: 0 });
      world.spider.nextHuntTick = 9999;
      placeWorker(world, sx + 1, sy);

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
    });

    it('a hungry spider enters Chasing for the nearest surface ant within trigger radius', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.spider.nextHuntTick = 9999;
      world.tick = SPIDER_GRACE_TICKS; // past grace so the spider is active and hungry
      const antId = placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS, sy);

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(antId);
      expect(world.spider.chaseStartTick).toBe(world.tick);
      const evt = world.events.find((e) => e.type === 'spider_chase_start');
      expect(evt).toBeDefined();
    });

    it('picks the nearest ant (lower id wins on tie) when hungry', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.spider.nextHuntTick = 9999;
      world.tick = SPIDER_GRACE_TICKS; // past grace so the spider is active and hungry
      const near = placeWorker(world, sx + 1, sy); // dist 1
      placeWorker(world, sx + 3, sy); // dist 3 (farther)

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(near);
    });

    it('does NOT chase an ant just outside the trigger radius (camps an entrance instead)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.spider.nextHuntTick = 9999;
      placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy); // out of range

      tickSpider(world);

      expect(world.spider.state).not.toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(-1);
    });

    it('chase takes precedence over entrance-camping when hungry', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.tick = SPIDER_GRACE_TICKS; // past grace so the spider is active and hungry
      placeWorker(world, sx + 1, sy); // a chaseable ant is present → chase wins over rampage

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
    });

    it('excludes the queen from chase targets', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
      });
      world.spider.nextHuntTick = 9999;
      world.tick = SPIDER_GRACE_TICKS; // past grace so the no-chase is queen-exclusion, not dormancy
      const queenId = placeWorker(world, sx + 1, sy);
      const col = createColonyRecord(PLAYER_COLONY_ID, 0);
      col.entrances = []; // caller-init contract; no open entrance → sealed
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = col;
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.queenEntityId = queenId;

      tickSpider(world);

      // Only the queen is in range and queens are excluded → no chase.
      expect(world.spider.state).not.toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(-1);
    });
  });

  describe('start-of-match grace period (V23 #177)', () => {
    it('does NOT accrue hunger during the grace window', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({ state: 'Patrolling', hungerTicks: 10 });
      world.tick = SPIDER_GRACE_TICKS - 1;
      tickSpider(world);
      expect(world.spider.hungerTicks).toBe(10); // frozen during grace
    });

    it('resumes hunger accrual at the grace boundary', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({ state: 'Patrolling', hungerTicks: 10 });
      world.tick = SPIDER_GRACE_TICKS;
      tickSpider(world);
      expect(world.spider.hungerTicks).toBe(11);
    });

    it('stays dormant — no chase — on the last grace tick even with prey in range', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      // One tick below the hungry threshold: only the grace gate stops it crossing.
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS - 1,
      });
      world.spider.nextHuntTick = 9999;
      world.tick = SPIDER_GRACE_TICKS - 1;
      placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS, sy);

      tickSpider(world);

      expect(world.spider.hungerTicks).toBe(HUNGRY_TICKS - 1); // no accrual → never crosses
      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
    });

    it('stays dormant during grace even when hunger already exceeds the threshold (e.g. a loaded save)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      // Hunger already over the threshold but still inside grace: grace must gate the
      // predation transition itself, not merely freeze further accrual.
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS + 100,
      });
      world.spider.nextHuntTick = 0; // hunt cooldown elapsed — only grace should hold it back
      world.tick = SPIDER_GRACE_TICKS - 1;
      placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS, sy);

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
      expect(world.spider.hungerTicks).toBe(HUNGRY_TICKS + 100); // frozen during grace
    });

    it('wakes and chases once the grace window ends', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS - 1,
      });
      world.spider.nextHuntTick = 9999;
      world.tick = SPIDER_GRACE_TICKS;
      const antId = placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS, sy);

      tickSpider(world);

      // Accrual resumes → crosses the hungry threshold → opportunistic chase fires.
      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(antId);
    });
  });

  describe('active self-defense (V23 #147)', () => {
    it('a sated Patrolling spider Chases the nearest attacking fighter within defense radius', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({ posX: sx << FP_SHIFT, posY: sy << FP_SHIFT, hungerTicks: 0 });
      world.spider.nextHuntTick = 9999;
      // Distance 5: inside defense radius (6), outside chase radius (4) — only the
      // self-defense path can pick this up, proving sated bite-back works.
      expect(SPIDER_DEFENSE_TRIGGER_RADIUS).toBeGreaterThan(SPIDER_CHASE_TRIGGER_RADIUS);
      const fighterId = placeFighter(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy);

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(fighterId);
      expect(world.spider.chaseStartTick).toBe(world.tick);
    });

    it('picks the nearest attacking fighter when several are in range', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({ posX: sx << FP_SHIFT, posY: sy << FP_SHIFT, hungerTicks: 0 });
      world.spider.nextHuntTick = 9999;
      placeFighter(world, sx + 6, sy); // dist 6 (farther)
      const near = placeFighter(world, sx, sy + 5); // dist 5 (nearer)

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(near);
    });

    it('ignores a non-fighter worker within defense radius (only bites back attackers)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({ posX: sx << FP_SHIFT, posY: sy << FP_SHIFT, hungerTicks: 0 });
      world.spider.nextHuntTick = 9999;
      placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy); // dist 5, but Foraging

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
    });

    it('does NOT self-defend an attacker outside the defense radius', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({ posX: sx << FP_SHIFT, posY: sy << FP_SHIFT, hungerTicks: 0 });
      world.spider.nextHuntTick = 9999;
      placeFighter(world, sx + SPIDER_DEFENSE_TRIGGER_RADIUS + 1, sy); // out of defense range

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
    });

    it('a Rampaging spider under attack abandons the camp and Chases the attacker', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
        state: 'Rampaging',
        rampageTargetColonyId: PLAYER_COLONY_ID,
        rampageStartTick: 0,
      });
      world.spider.nextHuntTick = 9999;
      const fighterId = placeFighter(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy);

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(fighterId);
      expect(world.spider.rampageTargetColonyId).toBe(-1);
      const evt = world.events.find((e) => e.type === 'spider_rampage_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_rampage_end') {
        expect(evt.payload.outcome).toBe('retreated');
      }
    });

    it('a Rampaging spider pinning a descender on its entrance HOLDS even under attack (#165)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
        state: 'Rampaging',
        rampageTargetColonyId: PLAYER_COLONY_ID,
        rampageStartTick: 0,
      });
      world.spider.nextHuntTick = 9999;
      const col = createColonyRecord(PLAYER_COLONY_ID, -1);
      col.entrances = [{ entranceId: 1, surfaceTileX: sx, surfaceTileY: sy, isOpen: true }];
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = col;
      placeWorker(world, sx, sy); // descender pinned on the entrance
      placeFighter(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy); // attacker within defense radius

      tickSpider(world);

      // Holds the gate: combat catches the pinned descender this tick; the spider does
      // not chase the attacker off the entrance (which would let the descender escape).
      expect(world.spider.state).toBe('Rampaging');
      expect(world.spider.rampageTargetColonyId).toBe(PLAYER_COLONY_ID);
    });

    it('still self-defends when only the enemy QUEEN sits on the camped entrance (queen does not hold the gate)', () => {
      // The #165 gate-hold is only justified for a bite-able ant: resolveSpiderCombatOnTile
      // skips queens, so a queen parked on the entrance is never caught by tile-coincident
      // combat. Holding for her would let an attacker surround the spider unanswered.
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
        state: 'Rampaging',
        rampageTargetColonyId: PLAYER_COLONY_ID,
        rampageStartTick: 0,
      });
      world.spider.nextHuntTick = 9999;
      const col = createColonyRecord(PLAYER_COLONY_ID, -1);
      col.entrances = [{ entranceId: 1, surfaceTileX: sx, surfaceTileY: sy, isOpen: true }];
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = col;
      const queenId = placeWorker(world, sx, sy); // queen parked ON the entrance (unbiteable)
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.queenEntityId = queenId;
      const fighterId = placeFighter(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy); // within defense radius

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.chaseTargetAntId).toBe(fighterId);
      expect(world.spider.rampageTargetColonyId).toBe(-1);
    });
  });

  describe('Rampaging straggler chase-divert (V23 #146)', () => {
    function campingSpider(world: WorldState, sx: number, sy: number): void {
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        hungerTicks: HUNGRY_TICKS,
        state: 'Rampaging',
        rampageTargetColonyId: PLAYER_COLONY_ID,
        rampageStartTick: world.tick,
      });
      world.spider.nextHuntTick = 9999;
      // queenEntityId = -1 so the first placed ant (id 0) is not mistaken for the queen.
      const col = createColonyRecord(PLAYER_COLONY_ID, -1);
      col.entrances = [{ entranceId: 1, surfaceTileX: sx, surfaceTileY: sy, isOpen: true }];
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId] = col;
    }

    it('diverts to Chasing a straggler that emerges within chase radius', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      campingSpider(world, sx, sy);
      const strag = placeWorker(world, sx + 1, sy);

      tickSpider(world);

      expect(world.spider!.state).toBe('Chasing');
      expect(world.spider!.chaseTargetAntId).toBe(strag);
      expect(world.spider!.rampageTargetColonyId).toBe(-1);
      const evt = world.events.find((e) => e.type === 'spider_rampage_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_rampage_end') {
        expect(evt.payload.outcome).toBe('retreated');
      }
    });

    it('keeps camping (stays Rampaging) when no ant is within chase radius', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      campingSpider(world, sx, sy);
      placeWorker(world, sx + SPIDER_CHASE_TRIGGER_RADIUS + 1, sy); // out of chase range

      tickSpider(world);

      expect(world.spider!.state).toBe('Rampaging');
      expect(world.spider!.rampageTargetColonyId).toBe(PLAYER_COLONY_ID);
    });

    it('does NOT divert off an ant sitting ON the camped entrance tile (#165 blockade hold)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      campingSpider(world, sx, sy); // entrance at (sx, sy)
      placeWorker(world, sx, sy); // descender sitting ON the entrance → must be held, not chased

      tickSpider(world);

      // The spider holds the gate so tile-coincident combat can catch the descender,
      // rather than chasing it off the entrance (which would let it slip underground).
      expect(world.spider!.state).toBe('Rampaging');
      expect(world.spider!.rampageTargetColonyId).toBe(PLAYER_COLONY_ID);
    });

    it('DOES divert to a straggler when only the enemy QUEEN sits on the camped entrance (no gate-hold for an unbiteable queen)', () => {
      // Regression (seed2082146439 dump): the enemy queen parked on the camped entrance
      // made holdGate=true, suppressing the chase-divert, while combat refused to bite
      // her — a ~1200-tick deadlock camp. The queen must not hold the gate; the spider
      // should chase the nearby bite-able straggler instead.
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      campingSpider(world, sx, sy); // entrance at (sx, sy), queenEntityId = -1
      const queenId = placeWorker(world, sx, sy); // queen parked ON the entrance (unbiteable)
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.queenEntityId = queenId;
      const strag = placeWorker(world, sx + 1, sy); // bite-able straggler within chase radius

      tickSpider(world);

      expect(world.spider!.state).toBe('Chasing');
      expect(world.spider!.chaseTargetAntId).toBe(strag);
      expect(world.spider!.rampageTargetColonyId).toBe(-1);
    });

    it('keeps camping when only the enemy QUEEN sits on the entrance and no straggler is in range', () => {
      // Queen excluded from both the gate-hold and the chase-target scan → no divert,
      // no spurious transition: the spider simply continues camping (rampage times out later).
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      campingSpider(world, sx, sy);
      const queenId = placeWorker(world, sx, sy); // queen alone on the entrance
      world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!.queenEntityId = queenId;

      tickSpider(world);

      expect(world.spider!.state).toBe('Rampaging');
      expect(world.spider!.rampageTargetColonyId).toBe(PLAYER_COLONY_ID);
    });
  });

  describe('Chasing movement + transitions (V23 #146)', () => {
    it('moves one step toward the target ant while chasing', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      const antId = placeWorker(world, sx + 4, sy);
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        state: 'Chasing',
        chaseTargetAntId: antId,
        chaseStartTick: 0,
      });
      world.tick = 1;

      tickSpider(world);

      expect(world.spider.state).toBe('Chasing');
      expect(world.spider.posX).toBe((sx << FP_SHIFT) + SPIDER_SPEED); // moved +X toward target
    });

    it('a chase catch (killedThisTick) with no fighter adjacent → Feeding, hunger reset', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 66;
      const sy = 32;
      const antId = placeWorker(world, sx, sy);
      world.ants.alive[antId] = 0; // combat killed it this tick
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        state: 'Chasing',
        chaseTargetAntId: antId,
        chaseStartTick: 0,
        hungerTicks: 500,
        killedThisTick: 1,
        lastKillTileX: sx,
        lastKillTileY: sy,
      });
      world.tick = 50;

      tickSpider(world);

      expect(world.spider.state).toBe('Feeding');
      expect(world.spider.chaseTargetAntId).toBe(-1);
      expect(world.spider.hungerTicks).toBe(0);
      const evt = world.events.find((e) => e.type === 'spider_feed_start');
      expect(evt).toBeDefined();
      // The chase episode is closed before Feeding so start/end pairs aren't dangling.
      const chaseEnd = world.events.find((e) => e.type === 'spider_chase_end');
      expect(chaseEnd).toBeDefined();
      if (chaseEnd?.type === 'spider_chase_end') expect(chaseEnd.payload.outcome).toBe('kill');
    });

    it('a stale dead target (no kill signal) returns to Patrolling without resetting hunger', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const antId = placeWorker(world, 66, 32);
      world.ants.alive[antId] = 0; // died to some other cause, no killedThisTick
      world.spider = makeSpider({
        state: 'Chasing',
        chaseTargetAntId: antId,
        chaseStartTick: SPIDER_GRACE_TICKS, // chase began just as grace ended
        hungerTicks: 500,
      });
      // Past the grace window so hunger accrues again; chase elapsed (50) is kept
      // under the leash (300) so the leash can't preempt the dead-target exit.
      world.tick = SPIDER_GRACE_TICKS + 50;

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
      expect(world.spider.hungerTicks).toBe(501); // accrued +1, not reset
      // Target died from another source (no killedThisTick) → 'lost', not 'kill',
      // so chase-success telemetry isn't credited a phantom spider kill.
      const evt = world.events.find((e) => e.type === 'spider_chase_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_chase_end') expect(evt.payload.outcome).toBe('lost');
    });

    it('reports a chase kill (killed signal) when caught with a fighter adjacent', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 66;
      const sy = 32;
      const target = placeWorker(world, sx, sy);
      world.ants.alive[target] = 0; // spider killed it this tick
      // A fighter sharing the tile keeps the spider out of Feeding (still Chasing).
      placeFighter(world, sx, sy);
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        state: 'Chasing',
        chaseTargetAntId: target,
        chaseStartTick: 0,
        hungerTicks: 500,
        killedThisTick: 1,
        lastKillTileX: sx,
        lastKillTileY: sy,
      });
      world.tick = 50;

      tickSpider(world);

      // Out of Feeding (fighter adjacent) but a real spider kill → 'kill'.
      expect(world.spider.state).toBe('Patrolling');
      const evt = world.events.find((e) => e.type === 'spider_chase_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_chase_end') expect(evt.payload.outcome).toBe('kill');
    });

    it('abandons the chase when the target reaches safety underground', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const antId = placeWorker(world, 66, 32);
      world.ants.zone[antId] = Zone.Underground;
      world.spider = makeSpider({
        state: 'Chasing',
        chaseTargetAntId: antId,
        chaseStartTick: 0,
      });
      world.tick = 50;

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
      const evt = world.events.find((e) => e.type === 'spider_chase_end');
      if (evt?.type === 'spider_chase_end') expect(evt.payload.outcome).toBe('escape');
    });

    it('abandons the chase when the safety leash expires', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const antId = placeWorker(world, 66, 32);
      world.spider = makeSpider({
        state: 'Chasing',
        chaseTargetAntId: antId,
        chaseStartTick: 0,
      });
      world.tick = SPIDER_CHASE_MAX_TICKS; // leash window elapsed

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.chaseTargetAntId).toBe(-1);
      const evt = world.events.find((e) => e.type === 'spider_chase_end');
      if (evt?.type === 'spider_chase_end') expect(evt.payload.outcome).toBe('leash');
    });

    it('does NOT retreat when damaged below the old threshold mid-chase — fights on', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const antId = placeWorker(world, 66, 32);
      world.spider = makeSpider({
        state: 'Chasing',
        chaseTargetAntId: antId,
        chaseStartTick: 0,
        hp: SPIDER_RAMPAGE_RETREAT_HP - 1,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).not.toBe('Retreating');
      expect(world.spider.state).toBe('Chasing'); // still pursuing its live target
    });

    it('emits spider_chase_end(killed) when the spider dies mid-chase', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const antId = placeWorker(world, 66, 32);
      world.spider = makeSpider({
        state: 'Chasing',
        chaseTargetAntId: antId,
        hp: 0, // combat killed the spider this tick
      });

      tickSpider(world);

      expect(world.spider).toBeNull();
      const evt = world.events.find((e) => e.type === 'spider_chase_end');
      expect(evt).toBeDefined();
      if (evt?.type === 'spider_chase_end') expect(evt.payload.outcome).toBe('killed');
    });
  });

  describe('meander (V23 redesign)', () => {
    it('a sated spider moves only on tick % SPIDER_MEANDER_TICK_DIVISOR === 0', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({ posX: 64 << FP_SHIFT, posY: 32 << FP_SHIFT, hungerTicks: 0 });

      // Pick a tick that is NOT divisible by the divisor → no movement.
      // divisor+1 is never ≡ 0 (mod divisor) for divisor > 1.
      world.tick = SPIDER_MEANDER_TICK_DIVISOR + 1;
      const beforeX = world.spider.posX;
      const beforeY = world.spider.posY;
      tickSpider(world);
      expect(world.spider.posX).toBe(beforeX);
      expect(world.spider.posY).toBe(beforeY);
      expect(world.spider.state).toBe('Patrolling');
    });

    it('writes no scatter reticle while meandering', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({ posX: 64 << FP_SHIFT, posY: 32 << FP_SHIFT, hungerTicks: 0 });
      world.tick = 3;
      tickSpider(world);
      expect(world.scatterReticleTile).toBeNull();
    });

    it('does NOT orbit a fixed lair point (meanders away over time)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const lairX = 64;
      const lairY = 32;
      world.spider = makeSpider({
        posX: lairX << FP_SHIFT,
        posY: lairY << FP_SHIFT,
        lairTileX: lairX,
        lairTileY: lairY,
        territoryRadiusTiles: 24,
        hungerTicks: 0,
      });
      let maxDist = 0;
      for (let t = 0; t < 2000; t++) {
        world.tick = t;
        tickSpider(world);
        const tx = world.spider.posX >> FP_SHIFT;
        const ty = world.spider.posY >> FP_SHIFT;
        const d = Math.abs(tx - lairX) + Math.abs(ty - lairY);
        if (d > maxDist) maxDist = d;
      }
      // Old lair orbit was bounded by territoryRadiusTiles (24); the meander should
      // wander well beyond half-radius and is not pinned to the lair.
      expect(maxDist).toBeGreaterThan(24);
    });
  });

  describe('feed-after-kill + heal (V23 redesign)', () => {
    it('kill with adjacent fighter resets hunger but does NOT feed', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        state: 'Striking',
        hungerTicks: 800,
        killedThisTick: 1,
        lastKillTileX: sx,
        lastKillTileY: sy,
        killsThisStrike: 1,
      });
      placeFighter(world, sx, sy); // fighter on the spider's tile (adjacent)
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.hungerTicks).toBe(0);
      expect(world.spider.state).not.toBe('Feeding');
    });

    it('kill with no fighter adjacent → Feeding, feedAwayTile ~10 tiles from kill, hunger reset', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        state: 'Striking',
        hungerTicks: 800,
        killedThisTick: 1,
        lastKillTileX: sx,
        lastKillTileY: sy,
        killsThisStrike: 1,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).toBe('Feeding');
      expect(world.spider.hungerTicks).toBe(0);
      const fx = world.spider.feedAwayTileX;
      const fy = world.spider.feedAwayTileY;
      const dist = Math.abs(fx - sx) + Math.abs(fy - sy);
      expect(dist).toBe(SPIDER_FEED_RETREAT_TILES);
      // The hunt/strike episode is closed before Feeding (no dangling start/end pair).
      const huntEnd = world.events.find((e) => e.type === 'spider_hunt_end');
      expect(huntEnd).toBeDefined();
      if (huntEnd?.type === 'spider_hunt_end') expect(huntEnd.payload.outcome).toBe('kill');
    });

    it('edge kill with an outward retreat direction still moves the full distance in-bounds (Codex P2)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      // Kill near the left edge; spider sits further left (sx=0) so the
      // deterministic direction (sx - kx < 0) points outward, off the grid.
      const kx = 3;
      const ky = 64;
      world.spider = makeSpider({
        posX: 0 << FP_SHIFT,
        posY: ky << FP_SHIFT,
        state: 'Striking',
        hungerTicks: 800,
        killedThisTick: 1,
        lastKillTileX: kx,
        lastKillTileY: ky,
        killsThisStrike: 1,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).toBe('Feeding');
      const fx = world.spider.feedAwayTileX;
      const fy = world.spider.feedAwayTileY;
      // In-bounds, full retreat distance, and reflected inward (away from the
      // edge) rather than clamped onto the kill tile.
      expect(fx).toBeGreaterThanOrEqual(0);
      expect(fx).toBeLessThanOrEqual(SURFACE_GRID_WIDTH - 1);
      expect(Math.abs(fx - kx) + Math.abs(fy - ky)).toBe(SPIDER_FEED_RETREAT_TILES);
      expect(fx).toBeGreaterThan(kx);
    });

    it('edge kill on the Y axis reflects inward the full distance in-bounds (Codex P2)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      // Kill near the bottom edge; spider sits further down so the deterministic
      // direction (sy - ky > 0) points outward past the grid on the Y axis. This
      // covers the SURFACE_GRID_HEIGHT call site, not just the X one.
      const kx = 64;
      const ky = SURFACE_GRID_HEIGHT - 4;
      world.spider = makeSpider({
        posX: kx << FP_SHIFT,
        posY: (SURFACE_GRID_HEIGHT - 1) << FP_SHIFT,
        state: 'Striking',
        hungerTicks: 800,
        killedThisTick: 1,
        lastKillTileX: kx,
        lastKillTileY: ky,
        killsThisStrike: 1,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).toBe('Feeding');
      const fx = world.spider.feedAwayTileX;
      const fy = world.spider.feedAwayTileY;
      expect(fy).toBeGreaterThanOrEqual(0);
      expect(fy).toBeLessThanOrEqual(SURFACE_GRID_HEIGHT - 1);
      expect(Math.abs(fx - kx) + Math.abs(fy - ky)).toBe(SPIDER_FEED_RETREAT_TILES);
      expect(fy).toBeLessThan(ky); // reflected inward (up), away from the bottom edge
    });

    it('corner kill via the hash fallback still retreats the full distance in-bounds (Codex P2)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      // Kill tile == spider tile at the (0,0) corner → dx==dy==0 takes the hash
      // fallback. Whichever cardinal it picks, the endpoint must stay in-bounds
      // and retreat AT LEAST a full SPIDER_FEED_RETREAT_TILES from the kill
      // (pre-fix, an outward pick collapsed to the edge at distance 0). #247 made
      // the edge-margin clamp unconditional, so at the corner the spider is first
      // nudged off the edge by the margin and then retreats — the endpoint sits
      // exactly SPIDER_FEED_RETREAT_TILES + SPIDER_EDGE_MARGIN_TILES from the kill
      // in every hash direction, and can never collapse back to 0.
      world.spider = makeSpider({
        posX: 0 << FP_SHIFT,
        posY: 0 << FP_SHIFT,
        state: 'Striking',
        hungerTicks: 800,
        killedThisTick: 1,
        lastKillTileX: 0,
        lastKillTileY: 0,
        killsThisStrike: 1,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).toBe('Feeding');
      const fx = world.spider.feedAwayTileX;
      const fy = world.spider.feedAwayTileY;
      expect(fx).toBeGreaterThanOrEqual(0);
      expect(fx).toBeLessThanOrEqual(SURFACE_GRID_WIDTH - 1);
      expect(fy).toBeGreaterThanOrEqual(0);
      expect(fy).toBeLessThanOrEqual(SURFACE_GRID_HEIGHT - 1);
      expect(Math.abs(fx) + Math.abs(fy)).toBe(
        SPIDER_FEED_RETREAT_TILES + SPIDER_EDGE_MARGIN_TILES,
      );
    });

    it('a Rampaging kill with no fighter adjacent → Feeding emits spider_rampage_end(quota_met)', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const sx = 64;
      const sy = 32;
      world.spider = makeSpider({
        posX: sx << FP_SHIFT,
        posY: sy << FP_SHIFT,
        state: 'Rampaging',
        rampageStartTick: 0,
        rampageTargetColonyId: PLAYER_COLONY_ID,
        hungerTicks: 800,
        killedThisTick: 1,
        lastKillTileX: sx,
        lastKillTileY: sy,
        rampageKillsThisRampage: 1,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).toBe('Feeding');
      const rampageEnd = world.events.find((e) => e.type === 'spider_rampage_end');
      expect(rampageEnd).toBeDefined();
      if (rampageEnd?.type === 'spider_rampage_end') {
        expect(rampageEnd.payload.outcome).toBe('quota_met');
        expect(rampageEnd.payload.broodKilled).toBe(1);
      }
    });

    it('heals ~+1 HP per interval while parked at the feed tile, then resumes Patrolling', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const fx = 70;
      const fy = 32;
      const arrived = 100;
      world.spider = makeSpider({
        posX: fx << FP_SHIFT,
        posY: fy << FP_SHIFT,
        state: 'Feeding',
        feedAwayTileX: fx,
        feedAwayTileY: fy,
        feedArrivedTick: arrived,
        hp: 40,
      });

      // Advance through the heal window. No fighters anywhere → never interrupted.
      const startHp = world.spider.hp;
      for (let t = arrived + 1; t <= arrived + SPIDER_FEED_TICKS; t++) {
        world.tick = t;
        tickSpider(world);
        if (world.spider === null || world.spider.state !== 'Feeding') break;
      }
      // Healed by roughly SPIDER_FEED_TICKS / interval HP (within 2 of target).
      // eslint-disable-next-line no-restricted-syntax -- test-only expected-count math; both operands are constants, result is floored
      const expectedHeal = Math.floor(SPIDER_FEED_TICKS / SPIDER_FEED_HEAL_INTERVAL_TICKS);
      expect(world.spider.hp).toBeGreaterThanOrEqual(startHp + expectedHeal - 2);
      expect(world.spider.state).toBe('Patrolling');
    });

    it('a fighter reaching the feeding spider interrupts the heal → Patrolling', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      const fx = 70;
      const fy = 32;
      world.spider = makeSpider({
        posX: fx << FP_SHIFT,
        posY: fy << FP_SHIFT,
        state: 'Feeding',
        feedAwayTileX: fx,
        feedAwayTileY: fy,
        feedArrivedTick: 100,
        hp: 40,
      });
      placeFighter(world, fx, fy); // fighter adjacent → interrupt
      world.tick = 150;

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      const evt = world.events.find((e) => e.type === 'spider_feed_end');
      if (evt?.type === 'spider_feed_end') expect(evt.payload.outcome).toBe('interrupted');
    });
  });

  describe('rampage no-quota + retreating normalization (V23 redesign)', () => {
    it('a sealed colony (no open entrance) leashes Rampaging back to Patrolling', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      // No colonies with open entrances exist in makeWorld → findNearestEntrance null.
      world.spider = makeSpider({
        state: 'Rampaging',
        rampageStartTick: 0,
        rampageTargetColonyId: PLAYER_COLONY_ID,
        hungerTicks: HUNGRY_TICKS,
      });
      world.tick = 10;

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
      expect(world.spider.rampageTargetColonyId).toBe(-1);
    });

    it('Rampaging leashes back to Patrolling after SPIDER_RAMPAGE_MAX_TICKS', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({
        state: 'Rampaging',
        rampageStartTick: 0,
        rampageTargetColonyId: PLAYER_COLONY_ID,
        hungerTicks: HUNGRY_TICKS,
      });
      world.tick = SPIDER_RAMPAGE_MAX_TICKS;

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
    });

    it('normalizes a loaded Retreating state to Patrolling on the first V23 tick', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
      world.spider = makeSpider({ state: 'Retreating', retreatStartTick: 0, hungerTicks: 0 });
      world.tick = 5;

      tickSpider(world);

      expect(world.spider.state).toBe('Patrolling');
    });
  });

  // -------------------------------------------------------------------------
  // #181 — Spider keeps a margin from map edges (V26) so its centered 3-tile
  // sprite never renders off-screen while chasing an ant into a corner.
  // -------------------------------------------------------------------------
  describe('edge margin (#181)', () => {
    const M = SPIDER_EDGE_MARGIN_TILES;

    /**
     * Stage a spider Chasing a stationary surface ant pinned at the west edge.
     * The spider starts a handful of tiles inland on the same row, so it moves
     * purely west (−X) toward the ant. Chase has no distance-escape (only
     * dead/descended/leash), and we never run combat, so the chase persists for
     * the whole window. Returns { world, tileXOf }.
     */
    function chaseTowardWestEdge(simVersion: number) {
      const world = makeWorld();
      world.simVersion = simVersion;
      world.tick = 0;
      const rowY = 32;
      // Target ant at the very west edge; stays put (only tickSpider runs).
      const antId = placeWorker(world, 0, rowY);
      world.spider = makeSpider({
        state: 'Chasing',
        posX: (M + 5) << FP_SHIFT,
        posY: rowY << FP_SHIFT,
        chaseTargetAntId: antId,
        chaseStartTick: 0,
      });
      const tileXOf = () => world.spider!.posX >> FP_SHIFT;
      const tileYOf = () => world.spider!.posY >> FP_SHIFT;
      return { world, tileXOf, tileYOf, rowY };
    }

    it('V26: spider chasing an ant at the west edge holds the margin (never reaches the edge)', () => {
      const { world, tileXOf, tileYOf, rowY } = chaseTowardWestEdge(
        SIM_VERSION_V26_SPIDER_EDGE_MARGIN,
      );
      // Precondition: started inland, actually Chasing the edge ant.
      expect(world.spider!.state).toBe('Chasing');
      expect(tileXOf()).toBe(M + 5);

      // Drive enough ticks to traverse well past the edge had it been unclamped.
      let minTileX = tileXOf();
      for (let t = 0; t < 20; t++) {
        tickSpider(world);
        minTileX = Math.min(minTileX, tileXOf());
        // Invariant every tick: never inside the margin band.
        expect(tileXOf()).toBeGreaterThanOrEqual(M);
      }
      // It pressed up against the margin (settled exactly at it) and pursued
      // purely along X (row unchanged), confirming it WANTED to go further west.
      expect(minTileX).toBe(M);
      expect(tileXOf()).toBe(M);
      expect(tileYOf()).toBe(rowY);
      expect(world.spider!.state).toBe('Chasing');
    });

    it('V26: chasing an ant into the NW corner clamps BOTH axes to the margin', () => {
      const world = makeWorld();
      world.simVersion = SIM_VERSION_V26_SPIDER_EDGE_MARGIN;
      world.tick = 0;
      const antId = placeWorker(world, 0, 0); // NW corner
      world.spider = makeSpider({
        state: 'Chasing',
        posX: (M + 6) << FP_SHIFT,
        posY: (M + 6) << FP_SHIFT,
        chaseTargetAntId: antId,
        chaseStartTick: 0,
      });

      const spider = world.spider;
      for (let t = 0; t < 24; t++) {
        tickSpider(world);
        expect(spider.posX >> FP_SHIFT).toBeGreaterThanOrEqual(M);
        expect(spider.posY >> FP_SHIFT).toBeGreaterThanOrEqual(M);
      }
      // Settled in the corner of the allowed region, margin off both edges.
      expect(spider.posX >> FP_SHIFT).toBe(M);
      expect(spider.posY >> FP_SHIFT).toBe(M);
    });
  });
});

describe('spider terrain passability (#225, V31)', () => {
  const V31 = SIM_VERSION_V31_SPIDER_TERRAIN;
  function setHardBlock(world: WorldState, tx: number, ty: number): void {
    world.bakedSurfaceEffect[ty * SURFACE_GRID_WIDTH + tx] = SurfaceMovementEffect.HardBlock;
  }
  // createWorldState bakes real procedural terrain (scattered boulders); wipe it
  // to an all-passable slate so each test controls exactly which tiles block.
  function makeCleanWorld(simVersion: number): WorldState {
    const world = makeWorld();
    world.simVersion = simVersion;
    world.bakedSurfaceEffect.fill(SurfaceMovementEffect.Cosmetic);
    return world;
  }

  it('isSpiderPassable treats OOB as impassable and honors HardBlock (C2)', () => {
    const world = makeCleanWorld(V31);
    // surfaceMovementAt returns Cosmetic (passable) for OOB, so the predicate
    // must bounds-check itself — off-grid is impassable.
    expect(isSpiderPassable(world, -1, 5)).toBe(false);
    expect(isSpiderPassable(world, SURFACE_GRID_WIDTH, 5)).toBe(false);
    expect(isSpiderPassable(world, 5, -1)).toBe(false);
    expect(isSpiderPassable(world, 5, SURFACE_GRID_HEIGHT)).toBe(false);
    // In-bounds: passable by default (Cosmetic), impassable on a boulder.
    expect(isSpiderPassable(world, 5, 5)).toBe(true);
    setHardBlock(world, 5, 5);
    expect(isSpiderPassable(world, 5, 5)).toBe(false);
  });

  it('V31 step refuses a HardBlock on the preferred axis and takes the other axis', () => {
    const world = makeCleanWorld(V31);
    const sx = 64;
    const sy = 32;
    // Target 3 east + 2 north → prefers X (ax = 3 >= ay = 2).
    const antId = placeWorker(world, sx + 3, sy - 2);
    setHardBlock(world, sx + 1, sy); // east neighbour is a boulder
    world.spider = makeSpider({
      posX: sx << FP_SHIFT,
      posY: sy << FP_SHIFT,
      state: 'Chasing',
      chaseTargetAntId: antId,
      chaseStartTick: 0,
    });
    world.tick = 1;
    tickSpider(world);
    expect(world.spider.state).toBe('Chasing');
    expect(world.spider.posX).toBe(sx << FP_SHIFT); // X refused (boulder)
    expect(world.spider.posY).toBe((sy << FP_SHIFT) - SPIDER_SPEED); // stepped north instead
  });

  it('V31 Chasing routes around a multi-tile boulder wall to reach the prey (routing P2)', () => {
    const world = makeCleanWorld(V31);
    // A vertical wall between the spider (west) and its prey (east), with gaps
    // above and below. Greedy movement would hold at the wall's west face until
    // the chase times out (dy === 0, no sideways detour); flow-field routing steps
    // down the goal field and goes around it.
    const wallX = 64;
    for (let y = 30; y <= 34; y++) setHardBlock(world, wallX, y);
    const antId = placeWorker(world, wallX + 4, 32); // prey on the far side of the wall
    world.spider = makeSpider({
      posX: (wallX - 4) << FP_SHIFT,
      posY: 32 << FP_SHIFT,
      state: 'Chasing',
      chaseTargetAntId: antId,
      chaseStartTick: 0,
    });
    let gotPastWall = false;
    let steppedOnWall = false;
    for (let t = 1; t <= 60; t++) {
      world.tick = t;
      tickSpider(world);
      if (world.spider === null) break;
      const sx = world.spider.posX >> FP_SHIFT;
      const sy = world.spider.posY >> FP_SHIFT;
      if (!isSpiderPassable(world, sx, sy)) steppedOnWall = true;
      if (sx > wallX) {
        gotPastWall = true;
        break;
      }
    }
    expect(steppedOnWall).toBe(false); // never walked onto the wall
    expect(gotPastWall).toBe(true); // detoured around it (greedy would hold at wallX-1 for 300 ticks)
  });

  it('pre-V31 (V23) steps onto the boulder — terrain-blind movement preserved byte-for-byte', () => {
    const world = makeCleanWorld(SIM_VERSION_V23_SPIDER_AGGRO);
    const sx = 64;
    const sy = 32;
    const antId = placeWorker(world, sx + 3, sy);
    setHardBlock(world, sx + 1, sy); // ignored below the V31 gate
    world.spider = makeSpider({
      posX: sx << FP_SHIFT,
      posY: sy << FP_SHIFT,
      state: 'Chasing',
      chaseTargetAntId: antId,
      chaseStartTick: 0,
    });
    world.tick = 1;
    tickSpider(world);
    expect(world.spider.posX).toBe((sx << FP_SHIFT) + SPIDER_SPEED); // stepped onto the boulder tile
  });

  it('Feeding stays terrain-blind under V31: crosses a boulder to the feed tile and heals (C3)', () => {
    const world = makeCleanWorld(V31);
    const sx = 64;
    const sy = 32;
    setHardBlock(world, sx + 1, sy); // boulder between the spider and its feed tile
    world.spider = makeSpider({
      posX: sx << FP_SHIFT,
      posY: sy << FP_SHIFT,
      state: 'Feeding',
      feedAwayTileX: sx + 2,
      feedAwayTileY: sy,
      feedArrivedTick: -1,
      hp: SPIDER_HP_FULL - 5,
      lastKillTileX: sx,
      lastKillTileY: sy,
    });
    let reachedFeedTile = false;
    let healed = false;
    for (let t = 1; t <= 60; t++) {
      world.tick = t;
      tickSpider(world);
      if (world.spider === null) break;
      if (world.spider.posX >> FP_SHIFT === sx + 2 && world.spider.posY >> FP_SHIFT === sy) {
        reachedFeedTile = true;
      }
      if (world.spider.hp > SPIDER_HP_FULL - 5) healed = true;
    }
    // Passability-gated Feeding would livelock at sx (refusing the boulder step).
    expect(reachedFeedTile).toBe(true);
    expect(healed).toBe(true);
  });

  it('V31 meander fires the probe on a HardBlock hash target and steps onto passable ground', () => {
    // hash32 replicated from spider.ts — keep in sync with that murmur finalizer.
    const hash32 = (x: number): number => {
      let h = Math.imul(x | 0, 2654435761) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
      return (h ^ (h >>> 16)) >>> 0;
    };
    const world = makeCleanWorld(V31);
    world.tick = 0; // meander tick (0 % divisor === 0), tick-bucket 0
    const seed = 0 ^ world.terrainSeed;
    const tx = hash32(seed) % SURFACE_GRID_WIDTH;
    const ty = hash32(seed ^ 0x9e3779b9) % SURFACE_GRID_HEIGHT;
    // For seed 0 the hashed meander target is (0, 37) — make it a boulder so the
    // V31 probe branch fires and redirects to a passable tile.
    setHardBlock(world, tx, ty);
    // Park the spider centrally (clear of the V26 edge-margin clamp so it can't
    // confound the post-move position). It steps one tile toward the probed
    // (passable) target and lands on open ground — never on the boulder.
    world.spider = makeSpider({
      posX: 64 << FP_SHIFT,
      posY: 40 << FP_SHIFT,
      state: 'Patrolling',
      hungerTicks: 0,
    });
    tickSpider(world);
    expect(world.spider.state).toBe('Patrolling');
    const finalX = world.spider.posX >> FP_SHIFT;
    const finalY = world.spider.posY >> FP_SHIFT;
    // Deterministic single step toward the redirected target (west of centre).
    expect(finalX).toBe(63);
    expect(finalY).toBe(40);
    // On passable ground, and never standing on the HardBlock hash tile.
    expect(isSpiderPassable(world, finalX, finalY)).toBe(true);
    expect(finalX === tx && finalY === ty).toBe(false);
  });

  it('V31 computeFeedAwayTile probes a boulder feed endpoint to passable in-band ground (Codex P2)', () => {
    const world = makeCleanWorld(V31);
    // Boulder a large square around the spider/kill so that wherever the ~10-tile
    // retreat endpoint lands (±10 on one axis), it is inside the block; passable
    // ground remains just beyond it.
    for (let y = 20; y <= 44; y++) {
      for (let x = 52; x <= 76; x++) {
        setHardBlock(world, x, y);
      }
    }
    const spider = makeSpider({
      posX: 64 << FP_SHIFT,
      posY: 32 << FP_SHIFT,
      lastKillTileX: 64,
      lastKillTileY: 32,
    });
    computeFeedAwayTile(world, spider);
    // The endpoint landed in the boulder; the probe redirected it to passable,
    // in-band ground so the spider heals where an adjacent fighter can interrupt it.
    expect(isSpiderPassable(world, spider.feedAwayTileX, spider.feedAwayTileY)).toBe(true);
  });

  it('pre-V31 computeFeedAwayTile leaves the endpoint in the boulder (un-probed, gated)', () => {
    const world = makeCleanWorld(SIM_VERSION_V23_SPIDER_AGGRO);
    for (let y = 20; y <= 44; y++) {
      for (let x = 52; x <= 76; x++) {
        setHardBlock(world, x, y);
      }
    }
    const spider = makeSpider({
      posX: 64 << FP_SHIFT,
      posY: 32 << FP_SHIFT,
      lastKillTileX: 64,
      lastKillTileY: 32,
    });
    computeFeedAwayTile(world, spider);
    // No probe below V31: the endpoint stays inside the boulder (old behavior).
    expect(isSpiderPassable(world, spider.feedAwayTileX, spider.feedAwayTileY)).toBe(false);
  });

  it('V31 spider that starts on an impassable tile escapes via the terrain-blind hatch (Codex P1)', () => {
    const world = makeCleanWorld(V31);
    // 5x5 boulder with the spider in the dead centre — all four cardinal neighbours
    // are HardBlock, so passability-aware stepping alone would strand it forever.
    for (let y = 30; y <= 34; y++) {
      for (let x = 62; x <= 66; x++) {
        setHardBlock(world, x, y);
      }
    }
    const antId = placeWorker(world, 70, 32); // chase target on open ground, east of the boulder
    world.spider = makeSpider({
      posX: 64 << FP_SHIFT,
      posY: 32 << FP_SHIFT,
      state: 'Chasing',
      chaseTargetAntId: antId,
      chaseStartTick: 0,
    });
    // Precondition: it starts on an impassable tile.
    expect(isSpiderPassable(world, 64, 32)).toBe(false);
    let escaped = false;
    for (let t = 1; t <= 10; t++) {
      world.tick = t;
      tickSpider(world);
      if (world.spider === null) break;
      const sx = world.spider.posX >> FP_SHIFT;
      const sy = world.spider.posY >> FP_SHIFT;
      if (isSpiderPassable(world, sx, sy)) {
        escaped = true;
        break;
      }
    }
    // Terrain-blind hatch walked it out onto passable ground (never stranded).
    expect(escaped).toBe(true);
  });
});
