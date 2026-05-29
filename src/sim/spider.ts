// src/sim/spider.ts — S3: Spider neutral predator state machine.
// tickSpider runs at step 17.5 (after combat at step 17).
// All decisions are deterministic from WorldState + tick; no world.rngState draws.

import type { WorldState, SpiderState } from './types.js';
import { emitEvent } from './telemetry.js';
import { phGet, phSet } from './pheromone/pheromone-store.js';
import { AntTask, PheromoneType } from './enums.js';
import { tierIndex } from './ai-state.js';
import {
  SPIDER_HP_FULL,
  SPIDER_HUNT_INTERVAL_TICKS,
  SPIDER_HUNGER_MAX_TICKS,
  SPIDER_TELEGRAPH_TICKS,
  SPIDER_STRIKE_TICKS,
  SPIDER_FEEDING_TICKS,
  SPIDER_HP_REGEN_PER_20_TICKS,
  SPIDER_RAMPAGE_RETREAT_HP,
  SPIDER_RETREAT_MIN_TICKS,
  SPIDER_RAMPAGE_KILL_QUOTA,
  SPIDER_RAMPAGE_MAX_TICKS,
  SPIDER_HUNT_SEARCH_RADIUS_TILES,
  SPIDER_HUNT_MIN_TARGET_WORKERS,
  SPIDER_SPEED,
  SPIDER_DANGER_DEPOSIT,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PHEROMONE_CAP,
} from './constants.js';
import { FP_SHIFT } from './fixed.js';

// HUNT_KEY_SHIFT: number of bits to shift Y to form a tile key (Y << SHIFT + X).
// Requires SURFACE_GRID_WIDTH === 2^HUNT_KEY_SHIFT. Compile-time assertion below.
const HUNT_KEY_SHIFT = 7; // SURFACE_GRID_WIDTH = 128 = 2^7
const _huntKeyShiftCheck: 128 = SURFACE_GRID_WIDTH; // fails to compile if SURFACE_GRID_WIDTH !== 128

// ---------------------------------------------------------------------------
// Module-level scratch for findHuntTarget — avoids per-call Map allocation.
// SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT = 128 * 128 = 16384 tiles.
// Cleared between calls via HUNT_DIRTY list. Same precedent as tick.ts flow-field buffers.
const HUNT_TILE_COUNTS = new Uint16Array(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT);
const HUNT_DIRTY: number[] = [];

// Precomputed suffix for surface DangerTrail pheromone grid key lookup.
// Avoids per-tick string allocation while remaining enum-safe.
const SURFACE_DANGER_SUFFIX = `:${PheromoneType.DangerTrail}:surface`;

// Module-level scratch for findNearestEntrance return value — avoids per-Rampaging-tick allocation.
const NEAREST_ENTRANCE_SCRATCH: { x: number; y: number; colonyId: number } = { x: -1, y: -1, colonyId: -1 };

// ---------------------------------------------------------------------------
// Hunt target selection — deterministic (no rng draws)
// ---------------------------------------------------------------------------

/**
 * Find the densest worker tile within SPIDER_HUNT_SEARCH_RADIUS_TILES of the
 * spider's current position. Returns tile coords or null if no qualifying tile.
 * Tie-break: ascending tileKey = tileY * SURFACE_GRID_WIDTH + tileX (Q-4).
 */
function findHuntTarget(
  world: WorldState,
  spider: SpiderState,
): { x: number; y: number; workerCount: number } | null {
  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;
  const r = SPIDER_HUNT_SEARCH_RADIUS_TILES;

  // Clear dirty tiles from previous call (reuse scratch buffer, avoid Map alloc).
  for (let d = 0; d < HUNT_DIRTY.length; d++) HUNT_TILE_COUNTS[HUNT_DIRTY[d]!] = 0;
  HUNT_DIRTY.length = 0;

  // Pre-scan queen IDs so they are excluded from worker density. Queens are identified
  // by colony.queenEntityId (not by task — queen task may vary) to avoid counting them
  // as prey and triggering hunts on depleted colonies. Assumes ≤2 active colonies (Phase 1).
  let huntQueenId0 = -1;
  let huntQueenId1 = -1;
  for (const ckey in world.colonies) {
    if (!Object.hasOwn(world.colonies, ckey)) continue;
    const col = world.colonies[ckey as unknown as import('./colony/colony-store.js').ColonyId];
    if (col === undefined) continue;
    if (huntQueenId0 < 0) huntQueenId0 = col.queenEntityId;
    else huntQueenId1 = col.queenEntityId;
  }

  // Count workers per tile within radius.
  const { ants } = world;
  const antCount = ants.alive.length;
  for (let i = 0; i < antCount; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.zone[i] !== 0) continue; // surface only
    if (ants.task[i] === AntTask.Fighting) continue; // spider hunts workers, not fighters
    if (i === huntQueenId0 || i === huntQueenId1) continue; // queens are not prey
    const ax = ants.posX[i]! >> FP_SHIFT;
    const ay = ants.posY[i]! >> FP_SHIFT;
    const dist = (ax > spiderTileX ? ax - spiderTileX : spiderTileX - ax) +
                 (ay > spiderTileY ? ay - spiderTileY : spiderTileY - ay);
    if (dist > r) continue;
    const key = (ay << HUNT_KEY_SHIFT) + ax;
    if (HUNT_TILE_COUNTS[key] === 0) HUNT_DIRTY.push(key);
    HUNT_TILE_COUNTS[key] = HUNT_TILE_COUNTS[key]! + 1;
  }

  let bestKey = -1;
  let bestCount = SPIDER_HUNT_MIN_TARGET_WORKERS - 1; // must exceed to qualify
  let bestX = -1;
  let bestY = -1;
  for (let d = 0; d < HUNT_DIRTY.length; d++) {
    const k = HUNT_DIRTY[d]!;
    const c = HUNT_TILE_COUNTS[k]!;
    if (c > bestCount || (c === bestCount && bestKey !== -1 && k < bestKey)) {
      bestCount = c;
      bestKey = k;
      bestX = k & (SURFACE_GRID_WIDTH - 1);
      bestY = k >> HUNT_KEY_SHIFT;
    }
  }
  if (bestKey === -1) return null;
  return { x: bestX, y: bestY, workerCount: bestCount };
}

// ---------------------------------------------------------------------------
// Rampage target: nearest entrance by squared-Euclidean, tileKey tiebreak
// ---------------------------------------------------------------------------

/**
 * Find the nearest open nest entrance (any colony) to the spider's current tile.
 * Squared-Euclidean distance (integer, no sqrt per CF-P1-014); ties broken by
 * ascending tileKey = tileY * SURFACE_GRID_WIDTH + tileX (QC Pass 4 AI8 / D-05).
 */
function findNearestEntrance(
  world: WorldState,
  spider: SpiderState,
  targetColonyId: number = -1,
): { x: number; y: number; colonyId: number } | null {
  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;

  let bestDist = Number.MAX_SAFE_INTEGER;
  let bestKey = -1;
  let bestX = -1;
  let bestY = -1;
  let bestColonyId = -1;

  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const cid = Number(key);
    const colony = world.colonies[key as unknown as import('./colony/colony-store.js').ColonyId];
    if (colony === undefined) continue;
    if (targetColonyId >= 0 && cid !== targetColonyId) continue;
    for (let e = 0; e < colony.entrances.length; e++) {
      const entrance = colony.entrances[e]!;
      if (!entrance.isOpen) continue;
      const dx = entrance.surfaceTileX - spiderTileX;
      const dy = entrance.surfaceTileY - spiderTileY;
      const dist = dx * dx + dy * dy;
      const tk = entrance.surfaceTileY * SURFACE_GRID_WIDTH + entrance.surfaceTileX;
      if (dist < bestDist || (dist === bestDist && tk < bestKey)) {
        bestDist = dist;
        bestKey = tk;
        bestX = entrance.surfaceTileX;
        bestY = entrance.surfaceTileY;
        bestColonyId = cid;
      }
    }
  }
  if (bestX === -1) return null;
  NEAREST_ENTRANCE_SCRATCH.x = bestX;
  NEAREST_ENTRANCE_SCRATCH.y = bestY;
  NEAREST_ENTRANCE_SCRATCH.colonyId = bestColonyId;
  return NEAREST_ENTRANCE_SCRATCH;
}


// ---------------------------------------------------------------------------
// Rampage target colony selection — 60/40 weighted toward richer colony
// ---------------------------------------------------------------------------

/**
 * Pick which colony the spider rampages on this cycle.
 * Score = foodStored + workerCount * 10. The richer colony is favored 60/40
 * using a deterministic hash of (terrainSeed ^ rampageStartTick) so the
 * result looks organic but is fully replay-safe. No world.rngState draws.
 */
function pickRampageTarget(world: WorldState, spider: SpiderState): number {
  const candidates: Array<{ colonyId: number; score: number }> = [];
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const cid = Number(key);
    if (cid <= 0) continue; // skip NEUTRAL_COLONY_ID
    const col = world.colonies[key as unknown as import('./colony/colony-store.js').ColonyId];
    if (col === undefined) continue;
    candidates.push({ colonyId: cid, score: col.foodStored + col.workerCount * 10 });
  }
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0]!.colonyId;
  // Richest first; ascending colonyId tiebreak for determinism.
  candidates.sort((a, b) => b.score - a.score || a.colonyId - b.colonyId);
  // Murmur3 finalizer seeded by terrainSeed ^ rampageStartTick — good avalanche,
  // deterministic, no rngState draw.
  let h = Math.imul(world.terrainSeed ^ spider.rampageStartTick, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  // 60% → richer colony (index 0), 40% → poorer (index 1).
  return (h % 100) < 60 ? candidates[0]!.colonyId : candidates[1]!.colonyId;
}

// ---------------------------------------------------------------------------
// Movement helpers
// ---------------------------------------------------------------------------

/** Move spider one step toward (targetTileX, targetTileY). */
function moveTowardTile(spider: SpiderState, targetX: number, targetY: number): void {
  const curX = spider.posX >> FP_SHIFT;
  const curY = spider.posY >> FP_SHIFT;
  if (curX === targetX && curY === targetY) return;

  const dx = targetX - curX;
  const dy = targetY - curY;
  // Move along the longer axis first (no diagonal per integer step; one tile per tick)
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;

  if (ax >= ay) {
    spider.posX += dx > 0 ? SPIDER_SPEED : -SPIDER_SPEED;
  } else {
    spider.posY += dy > 0 ? SPIDER_SPEED : -SPIDER_SPEED;
  }

  // Clamp to grid bounds
  const maxX = (SURFACE_GRID_WIDTH - 1) << FP_SHIFT;
  const maxY = (SURFACE_GRID_HEIGHT - 1) << FP_SHIFT;
  if (spider.posX < 0) spider.posX = 0;
  if (spider.posX > maxX) spider.posX = maxX;
  if (spider.posY < 0) spider.posY = 0;
  if (spider.posY > maxY) spider.posY = maxY;
}

/** Move spider in a deterministic patrol arc within territory radius of lair. */
function tickPatrolMovement(world: WorldState, spider: SpiderState): void {
  // Simple deterministic patrol: move in a clockwise square orbit around lair.
  // Uses world.tick to pick a target corner deterministically (no rng draws).
  const r = spider.territoryRadiusTiles >> 1; // patrol at half radius
  const phase = (world.tick >> 6) & 3; // change quadrant every 64 ticks
  const lx = spider.lairTileX;
  const ly = spider.lairTileY;
  let tx: number;
  let ty: number;
  switch (phase) {
    case 0: tx = lx + r; ty = ly - r; break;
    case 1: tx = lx + r; ty = ly + r; break;
    case 2: tx = lx - r; ty = ly + r; break;
    default: tx = lx - r; ty = ly - r; break;
  }
  // Clamp target within grid
  if (tx < 0) tx = 0;
  if (tx >= SURFACE_GRID_WIDTH) tx = SURFACE_GRID_WIDTH - 1;
  if (ty < 0) ty = 0;
  if (ty >= SURFACE_GRID_HEIGHT) ty = SURFACE_GRID_HEIGHT - 1;
  moveTowardTile(spider, tx, ty);
}

// ---------------------------------------------------------------------------
// Danger pheromone deposit
// ---------------------------------------------------------------------------

/**
 * Seed the 5-tile cross (center + N/S/E/W) on both colonies' DangerTrail grids.
 * Center gets SPIDER_DANGER_DEPOSIT; neighbors get SPIDER_DANGER_DEPOSIT >> 1.
 * Option B per spec: deposit calibrated for DANGER_DECAY_FP=10 (see constants.ts).
 */
function seedDangerPheromone(world: WorldState, spider: SpiderState): void {
  const tileX = spider.posX >> FP_SHIFT;
  const tileY = spider.posY >> FP_SHIFT;
  const center = SPIDER_DANGER_DEPOSIT;
  const nb = SPIDER_DANGER_DEPOSIT >> 1;
  const w = SURFACE_GRID_WIDTH;
  const h = SURFACE_GRID_HEIGHT;

  // Deposit in both colonies' surface DangerTrail grids.
  // Unrolled 5-cell cross to avoid per-tick array allocation (AGENTS.md hot-loop rule).
  for (const colonyKey in world.pheromoneGrids) {
    if (!Object.hasOwn(world.pheromoneGrids, colonyKey)) continue;
    if (!colonyKey.endsWith(SURFACE_DANGER_SUFFIX)) continue;
    const grid = world.pheromoneGrids[colonyKey]!;
    // center (spider is always within surface bounds)
    { const v = phGet(grid, tileX, tileY) + center; phSet(grid, tileX, tileY, v > PHEROMONE_CAP ? PHEROMONE_CAP : v); }
    // north
    if (tileY > 0) { const v = phGet(grid, tileX, tileY - 1) + nb; phSet(grid, tileX, tileY - 1, v > PHEROMONE_CAP ? PHEROMONE_CAP : v); }
    // south
    if (tileY < h - 1) { const v = phGet(grid, tileX, tileY + 1) + nb; phSet(grid, tileX, tileY + 1, v > PHEROMONE_CAP ? PHEROMONE_CAP : v); }
    // west
    if (tileX > 0) { const v = phGet(grid, tileX - 1, tileY) + nb; phSet(grid, tileX - 1, tileY, v > PHEROMONE_CAP ? PHEROMONE_CAP : v); }
    // east
    if (tileX < w - 1) { const v = phGet(grid, tileX + 1, tileY) + nb; phSet(grid, tileX + 1, tileY, v > PHEROMONE_CAP ? PHEROMONE_CAP : v); }
  }
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

function emitSpiderHuntEnd(
  world: WorldState,
  outcome: 'kill' | 'swarm_retreat' | 'scatter',
  deaths: number,
): void {
  emitEvent(world, {
    tick: world.tick,
    type: 'spider_hunt_end',
    payload: { outcome, deaths },
  });
}

function emitSpiderRampageEnd(
  world: WorldState,
  outcome: 'killed_in_nest' | 'killed_by_player' | 'killed_by_ai' | 'quota_met' | 'retreated',
  broodKilled: number,
  queenKilled: boolean,
): void {
  emitEvent(world, {
    tick: world.tick,
    type: 'spider_rampage_end',
    payload: { outcome, broodKilled, queenKilled },
  });
}

// ---------------------------------------------------------------------------
// Utility: clear stale spider-pairing sentinels from live ants
// ---------------------------------------------------------------------------

/**
 * Clear combatOpponentId === -2 (spider-paired sentinel) on all live ants.
 * Must be called at every exit from Striking or Rampaging so that surviving
 * ants don't skip the windup on the spider's next combat engagement.
 */
function clearSpiderPairingSentinels(world: WorldState): void {
  const { ants } = world;
  const len = ants.alive.length;
  for (let i = 0; i < len; i++) {
    if (ants.alive[i] === 1 && ants.combatOpponentId[i] === -2) {
      ants.combatOpponentId[i] = -1;
    }
  }
}

// ---------------------------------------------------------------------------
// tickSpider — main entry point (step 17.5)
// ---------------------------------------------------------------------------

/**
 * Advance spider state machine by one tick. Called at step 17.5 (after combat).
 * Deterministic: no world.rngState draws.
 */
export function tickSpider(world: WorldState): void {
  const spider = world.spider;
  if (spider === null) {
    world.scatterReticleTile = null;
    return;
  }

  // Evaluation-order rule: combat ran at step 17 and may have brought hp to 0.
  if (spider.hp <= 0) {
    // Spider died from combat this tick. Emit end events, then clear.
    if (spider.state === 'Striking') {
      emitSpiderHuntEnd(world, 'swarm_retreat', spider.killsThisStrike);
    } else if (spider.state === 'Rampaging') {
      emitSpiderRampageEnd(world, 'killed_in_nest', spider.rampageKillsThisRampage, false);
    }
    clearSpiderPairingSentinels(world);
    world.spider = null;
    world.spiderPriorityColonyId = null;
    world.scatterReticleTile = null;
    return;
  }

  // HP regeneration: 1 HP per 20 ticks while Retreating or Feeding.
  if ((spider.state === 'Retreating' || spider.state === 'Feeding') &&
      (world.tick % 20 === 0) &&
      spider.hp < SPIDER_HP_FULL) {
    spider.hp += SPIDER_HP_REGEN_PER_20_TICKS;
    if (spider.hp > SPIDER_HP_FULL) spider.hp = SPIDER_HP_FULL;
  }

  // Hunger accrual: only while not Feeding.
  if (spider.state !== 'Feeding') {
    spider.hungerTicks += 1;
  }

  // --- Priority retreating-threshold check (applies to Striking and Rampaging) ---
  // This runs before state-specific logic so a combat-damaged spider retreats
  // immediately, even on the same tick its duration would have expired.
  if ((spider.state === 'Striking' || spider.state === 'Rampaging') &&
      spider.hp < SPIDER_RAMPAGE_RETREAT_HP) {
    if (spider.state === 'Striking') {
      emitSpiderHuntEnd(world, 'swarm_retreat', spider.killsThisStrike);
    } else {
      emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
    }
    clearSpiderPairingSentinels(world);
    spider.state = 'Retreating';
    spider.retreatStartTick = world.tick;
    spider.huntTargetTileX = -1;
    spider.huntTargetTileY = -1;
    spider.hungerTicks = 0; // prevent immediate re-rampaging on return to Patrolling
    spider.rampageTargetColonyId = -1;
    world.spiderPriorityColonyId = null;
    // Fall through to movement + pheromone below.
  }

  // --- State machine transitions ---
  switch (spider.state) {
    case 'Patrolling': {
      // Hunger check first: rampaging wins over hunting on same tick.
      if (spider.hungerTicks >= SPIDER_HUNGER_MAX_TICKS[tierIndex(world.difficulty)]) {
        spider.state = 'Rampaging';
        spider.rampageStartTick = world.tick;
        spider.rampageKillsThisRampage = 0;
        spider.rampageTargetColonyId = pickRampageTarget(world, spider);
        emitEvent(world, {
          tick: world.tick,
          type: 'spider_rampage_start',
          payload: {
            lairTile: { x: spider.lairTileX, y: spider.lairTileY },
            hungerTicks: spider.hungerTicks,
          },
        });
      } else if (world.tick >= spider.nextHuntTick) {
        const target = findHuntTarget(world, spider);
        if (target !== null) {
          spider.state = 'Hunting';
          spider.huntTargetTileX = target.x;
          spider.huntTargetTileY = target.y;
          spider.huntStartTick = world.tick;
          emitEvent(world, {
            tick: world.tick,
            type: 'spider_hunt_start',
            payload: {
              reticleTile: { x: target.x, y: target.y, grid: 'surface' },
              targetWorkers: target.workerCount,
            },
          });
        } else {
          // No qualifying workers in range — postpone hunt by one interval to preserve
          // the 1200-tick cadence rather than re-scanning every tick.
          spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        }
      }
      break;
    }

    case 'Hunting': {
      if (world.tick - spider.huntStartTick >= SPIDER_TELEGRAPH_TICKS) {
        spider.state = 'Striking';
        spider.strikeStartTick = world.tick;
        spider.killsThisStrike = 0;
      }
      break;
    }

    case 'Striking': {
      // Duration check (retreat threshold was already handled above).
      if (world.tick - spider.strikeStartTick >= SPIDER_STRIKE_TICKS) {
        if (spider.killsThisStrike > 0) {
          emitSpiderHuntEnd(world, 'kill', spider.killsThisStrike);
          clearSpiderPairingSentinels(world);
          spider.state = 'Feeding';
          spider.feedingStartTick = world.tick;
          spider.hungerTicks = 0; // CF-P0-006: reset on Feeding entry
          spider.huntTargetTileX = -1;
          spider.huntTargetTileY = -1;
          world.spiderPriorityColonyId = null;
        } else {
          emitSpiderHuntEnd(world, 'scatter', 0);
          clearSpiderPairingSentinels(world);
          spider.state = 'Patrolling';
          spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
          spider.huntTargetTileX = -1;
          spider.huntTargetTileY = -1;
          world.spiderPriorityColonyId = null;
        }
      }
      break;
    }

    case 'Feeding': {
      if (world.tick >= spider.feedingStartTick + SPIDER_FEEDING_TICKS) {
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.huntTargetTileX = -1;
        spider.huntTargetTileY = -1;
      }
      break;
    }

    case 'Rampaging': {
      // Quota check: fed enough brood.
      if (spider.rampageKillsThisRampage >= SPIDER_RAMPAGE_KILL_QUOTA) {
        emitSpiderRampageEnd(world, 'quota_met', spider.rampageKillsThisRampage, false);
        clearSpiderPairingSentinels(world);
        spider.state = 'Feeding';
        spider.feedingStartTick = world.tick;
        spider.hungerTicks = 0;
        spider.rampageTargetColonyId = -1;
        world.spiderPriorityColonyId = null;
      } else if (world.tick - spider.rampageStartTick >= SPIDER_RAMPAGE_MAX_TICKS) {
        // Timeout: no ants surfaced at entrance — treat as failed rampage and retreat.
        emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
        clearSpiderPairingSentinels(world);
        spider.state = 'Retreating';
        spider.retreatStartTick = world.tick;
        spider.huntTargetTileX = -1;
        spider.huntTargetTileY = -1;
        spider.hungerTicks = 0; // prevent immediate re-rampaging on return to Patrolling
        spider.rampageTargetColonyId = -1;
        world.spiderPriorityColonyId = null;
      }
      break;
    }

    case 'Retreating': {
      if (spider.hp >= SPIDER_HP_FULL &&
          world.tick >= spider.retreatStartTick + SPIDER_RETREAT_MIN_TICKS) {
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
      }
      break;
    }
  }

  // --- Movement ---
  // Cache nearest entrance for Rampaging once per tick (used by both movement and pheromone seeding).
  // Self-heal: a Rampaging spider loaded from a save predating rampageTargetColonyId derives
  // its target here so behavior is consistent with a spider that never reloaded.
  if (spider.state === 'Rampaging' && spider.rampageTargetColonyId < 0) {
    spider.rampageTargetColonyId = pickRampageTarget(world, spider);
  }
  const rampageNearest = spider.state === 'Rampaging' ? findNearestEntrance(world, spider, spider.rampageTargetColonyId) : null;
  switch (spider.state) {
    case 'Patrolling': {
      tickPatrolMovement(world, spider);
      break;
    }
    case 'Hunting': {
      moveTowardTile(spider, spider.huntTargetTileX, spider.huntTargetTileY);
      break;
    }
    case 'Striking': {
      // Stay on target tile.
      moveTowardTile(spider, spider.huntTargetTileX, spider.huntTargetTileY);
      break;
    }
    case 'Feeding':
    case 'Retreating': {
      moveTowardTile(spider, spider.lairTileX, spider.lairTileY);
      break;
    }
    case 'Rampaging': {
      if (rampageNearest !== null) {
        // Park ON the entrance tile. The pre-descent gate (#165, ant-system.ts)
        // holds surface ants here instead of letting them descend before combat,
        // and spider combat scans the spider's own tile — so blockading the
        // entrance tile itself is what actually catches entrance traffic,
        // regardless of which direction the ant approached from. (Parking one
        // tile above only caught ants approaching from that side.)
        moveTowardTile(spider, rampageNearest.x, rampageNearest.y);
      }
      break;
    }
  }

  // --- Danger pheromone seeding ---
  // Surface states: Patrolling, Hunting, Striking, Rampaging (while on surface)
  const isOnSurface = spider.state !== 'Feeding' && spider.state !== 'Retreating';
  if (isOnSurface) {
    seedDangerPheromone(world, spider);
  }


  // --- scatterReticleTile shadow field: written at end for next tick's step 13e ---
  if (spider.state === 'Hunting' || spider.state === 'Striking') {
    if (world.scatterReticleTile === null) {
      world.scatterReticleTile = { x: spider.huntTargetTileX, y: spider.huntTargetTileY };
    } else {
      world.scatterReticleTile.x = spider.huntTargetTileX;
      world.scatterReticleTile.y = spider.huntTargetTileY;
    }
  } else {
    world.scatterReticleTile = null;
  }
}
