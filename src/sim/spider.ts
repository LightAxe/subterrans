// src/sim/spider.ts — S3: Spider neutral predator state machine.
// tickSpider runs at step 17.5 (after combat at step 17).
// All decisions are deterministic from WorldState + tick; no world.rngState draws.

import type { WorldState, SpiderState } from './types.js';
import { emitEvent } from './telemetry.js';
import { pheromoneGridKey, phGet, phSet } from './pheromone/pheromone-store.js';
import { AntTask, PheromoneType } from './enums.js';
import { NORMAL_TIER_INDEX } from './ai-state.js';
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
  SPIDER_HUNT_SEARCH_RADIUS_TILES,
  SPIDER_HUNT_MIN_TARGET_WORKERS,
  SPIDER_SPEED,
  SPIDER_DANGER_DEPOSIT,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PHEROMONE_CAP,
} from './constants.js';
import { FP_SHIFT } from './fixed.js';

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
): { x: number; y: number } | null {
  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;
  const r = SPIDER_HUNT_SEARCH_RADIUS_TILES;

  // Count workers per tile within radius
  const counts = new Map<number, number>();
  const { ants } = world;
  const count = ants.alive.length;
  for (let i = 0; i < count; i++) {
    if (ants.alive[i] !== 1) continue;
    // Only surface ants
    if (ants.zone[i] !== 0) continue;
    // Skip fighters — spider hunts workers (prey), not combatants
    if (ants.task[i] === AntTask.Fighting) continue;
    const ax = ants.posX[i]! >> FP_SHIFT;
    const ay = ants.posY[i]! >> FP_SHIFT;
    const dist = (ax > spiderTileX ? ax - spiderTileX : spiderTileX - ax) +
                 (ay > spiderTileY ? ay - spiderTileY : spiderTileY - ay);
    if (dist > r) continue;
    const key = ay * SURFACE_GRID_WIDTH + ax;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let bestKey = -1;
  let bestCount = SPIDER_HUNT_MIN_TARGET_WORKERS - 1; // must exceed to qualify
  let bestX = -1;
  let bestY = -1;
  for (const [k, c] of counts) {
    if (c > bestCount || (c === bestCount && (bestKey === -1 || k < bestKey))) {
      bestCount = c;
      bestKey = k;
      const kx = k % SURFACE_GRID_WIDTH;
      bestX = kx;
      bestY = (k - kx) >> 7; // SURFACE_GRID_WIDTH=128=2^7; integer divide via right-shift
    }
  }
  if (bestKey === -1) return null;
  return { x: bestX, y: bestY };
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
): { x: number; y: number; colonyId: number } | null {
  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;

  let bestDist = Number.MAX_SAFE_INTEGER;
  let bestKey = -1;
  let bestX = -1;
  let bestY = -1;
  let bestColonyId = -1;

  for (const key in world.colonies) {
    const cid = Number(key);
    const colony = world.colonies[key as unknown as import('./colony/colony-store.js').ColonyId];
    if (colony === undefined) continue;
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
  return { x: bestX, y: bestY, colonyId: bestColonyId };
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
  const neighbor = SPIDER_DANGER_DEPOSIT >> 1;

  const offsets: [number, number, number][] = [
    [tileX,     tileY,     center],
    [tileX,     tileY - 1, neighbor],
    [tileX,     tileY + 1, neighbor],
    [tileX - 1, tileY,     neighbor],
    [tileX + 1, tileY,     neighbor],
  ];

  // Deposit in both colonies' surface DangerTrail grids
  for (const colonyKey in world.pheromoneGrids) {
    // Filter to DangerTrail surface grids (format: "${colonyId}:1:surface")
    if (!colonyKey.endsWith(':1:surface')) continue;
    const grid = world.pheromoneGrids[colonyKey]!;
    for (const [ox, oy, amt] of offsets) {
      if (ox < 0 || ox >= SURFACE_GRID_WIDTH || oy < 0 || oy >= SURFACE_GRID_HEIGHT) continue;
      const current = phGet(grid, ox, oy);
      const sum = current + amt;
      phSet(grid, ox, oy, sum > PHEROMONE_CAP ? PHEROMONE_CAP : sum);
    }
  }
}

// ---------------------------------------------------------------------------
// Rampaging underground danger deposit
// ---------------------------------------------------------------------------

/** During Rampaging, seed DangerTrail on the underground grid of the colony being invaded. */
function seedUndergroundDangerPheromone(world: WorldState, spider: SpiderState, colonyId: number): void {
  // Find the underground danger grid for this colony
  const key = pheromoneGridKey(colonyId, PheromoneType.DangerTrail, 'underground');
  const grid = world.pheromoneGrids[key];
  if (grid === undefined) return;

  const tileX = spider.posX >> FP_SHIFT;
  const tileY = spider.posY >> FP_SHIFT;
  const center = SPIDER_DANGER_DEPOSIT;
  const neighbor = SPIDER_DANGER_DEPOSIT >> 1;
  const gridWidth = grid.width;
  const gridHeight = grid.height;

  const offsets: [number, number, number][] = [
    [tileX,     tileY,     center],
    [tileX,     tileY - 1, neighbor],
    [tileX,     tileY + 1, neighbor],
    [tileX - 1, tileY,     neighbor],
    [tileX + 1, tileY,     neighbor],
  ];
  for (const [ox, oy, amt] of offsets) {
    if (ox < 0 || ox >= gridWidth || oy < 0 || oy >= gridHeight) continue;
    const current = phGet(grid, ox, oy);
    const sum = current + amt;
    phSet(grid, ox, oy, sum > PHEROMONE_CAP ? PHEROMONE_CAP : sum);
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
    // Fall through to movement + pheromone below.
  }

  // --- State machine transitions ---
  switch (spider.state) {
    case 'Patrolling': {
      // Hunger check first: rampaging wins over hunting on same tick.
      if (spider.hungerTicks >= SPIDER_HUNGER_MAX_TICKS[NORMAL_TIER_INDEX]) {
        spider.state = 'Rampaging';
        spider.rampageKillsThisRampage = 0;
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
              targetWorkers: 0, // approximation; actual count read above in findHuntTarget
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
        } else {
          emitSpiderHuntEnd(world, 'scatter', 0);
          clearSpiderPairingSentinels(world);
          spider.state = 'Patrolling';
          spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
          spider.huntTargetTileX = -1;
          spider.huntTargetTileY = -1;
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
      const nearest = findNearestEntrance(world, spider);
      if (nearest !== null) {
        moveTowardTile(spider, nearest.x, nearest.y);
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

  // During Rampaging, seed underground danger only for the invaded colony
  // (the one whose entrance is nearest to the spider). Seeding all colonies
  // would create false threat signals in colonies the spider is not attacking.
  if (spider.state === 'Rampaging') {
    const nearestForSeed = findNearestEntrance(world, spider);
    if (nearestForSeed !== null) {
      seedUndergroundDangerPheromone(world, spider, nearestForSeed.colonyId);
    }
  }

  // --- scatterReticleTile shadow field: written at end for next tick's step 16 ---
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
