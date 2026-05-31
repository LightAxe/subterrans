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
  SPIDER_CHASE_TRIGGER_RADIUS,
  SPIDER_DEFENSE_TRIGGER_RADIUS,
  SPIDER_CHASE_MAX_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_MEANDER_TICK_DIVISOR,
  SPIDER_MEANDER_RETARGET_TICKS,
  SPIDER_FEED_RETREAT_TILES,
  SPIDER_FEED_DANGER_RADIUS,
  SPIDER_FEED_TICKS,
  SPIDER_FEED_HEAL_INTERVAL_TICKS,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PHEROMONE_CAP,
} from './constants.js';
import { SIM_VERSION_V23_SPIDER_AGGRO } from './types.js';
import { FP_SHIFT } from './fixed.js';

// HUNT_KEY_SHIFT: number of bits to shift Y to form a tile key (Y << SHIFT + X).
// Requires SURFACE_GRID_WIDTH === 2^HUNT_KEY_SHIFT. Compile-time assertion below.
const HUNT_KEY_SHIFT = 7; // SURFACE_GRID_WIDTH = 128 = 2^7
const _huntKeyShiftCheck: 128 = SURFACE_GRID_WIDTH; // fails to compile if SURFACE_GRID_WIDTH !== 128

// Meander tick-bucket: `tick >> SHIFT` is integer division by the retarget
// window (avoids the float-division lint). Requires the window to stay a power
// of two; the compile-time assertion below fails if the constant drifts.
const SPIDER_MEANDER_RETARGET_SHIFT = 7; // SPIDER_MEANDER_RETARGET_TICKS = 128 = 2^7
const _meanderRetargetCheck: 128 = SPIDER_MEANDER_RETARGET_TICKS; // fails to compile if != 128

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
// Chase target selection (V23 / #146) — deterministic (no rng draws)
// ---------------------------------------------------------------------------

/**
 * Find the nearest live surface ant (any caste; queens excluded) within
 * SPIDER_CHASE_TRIGGER_RADIUS of the spider. Returns the ant entity id, or -1 if
 * none qualify. Manhattan distance; ties broken by ascending ant id (lower id wins),
 * matching the deterministic SoA iteration order. No allocation.
 */
function findChaseTarget(world: WorldState, spider: SpiderState): number {
  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;
  const r = SPIDER_CHASE_TRIGGER_RADIUS;

  // Exclude queens (identified by colony.queenEntityId) — they are not chase prey.
  let chaseQueenId0 = -1;
  let chaseQueenId1 = -1;
  for (const ckey in world.colonies) {
    if (!Object.hasOwn(world.colonies, ckey)) continue;
    const col = world.colonies[ckey as unknown as import('./colony/colony-store.js').ColonyId];
    if (col === undefined) continue;
    if (chaseQueenId0 < 0) chaseQueenId0 = col.queenEntityId;
    else chaseQueenId1 = col.queenEntityId;
  }

  const { ants } = world;
  const antCount = ants.alive.length;
  let bestId = -1;
  let bestDist = r + 1; // must be <= r to qualify
  for (let i = 0; i < antCount; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.zone[i] !== 0) continue; // surface only
    if (i === chaseQueenId0 || i === chaseQueenId1) continue; // queens are not prey
    const ax = ants.posX[i]! >> FP_SHIFT;
    const ay = ants.posY[i]! >> FP_SHIFT;
    const dist = (ax > spiderTileX ? ax - spiderTileX : spiderTileX - ax) +
                 (ay > spiderTileY ? ay - spiderTileY : spiderTileY - ay);
    if (dist > r) continue;
    if (dist < bestDist) { bestDist = dist; bestId = i; } // strict < ⇒ lower id wins on tie
  }
  return bestId;
}

/**
 * True if any live, bite-able surface ant occupies tile (tileX, tileY). Used by the
 * Rampaging gate-holds to honor the #165 entrance blockade: while a descender sits on
 * the camped entrance tile, the tile-coincident spider bite (the gate holds the ant
 * there) resolves it this tick, so the spider must NOT divert off the gate to chase.
 *
 * Queens are excluded (identified by colony.queenEntityId), matching findChaseTarget
 * and resolveSpiderCombatOnTile: the gate-hold is only justified for an ant the spider
 * will actually bite, and combat skips queens. A queen parked on the camped entrance
 * must NOT hold the gate — otherwise the spider deadlock-camps an unbiteable target and
 * suppresses the chase-divert that would catch a nearby straggler. No allocation.
 */
function isSurfaceAntOnTile(world: WorldState, tileX: number, tileY: number): boolean {
  const { ants } = world;

  // Pre-scan colony queen IDs (same contract as findChaseTarget / resolveSpiderCombatOnTile).
  let queenId0 = -1;
  let queenId1 = -1;
  for (const ckey in world.colonies) {
    if (!Object.hasOwn(world.colonies, ckey)) continue;
    const col = world.colonies[ckey as unknown as import('./colony/colony-store.js').ColonyId];
    if (col === undefined) continue;
    if (queenId0 < 0) queenId0 = col.queenEntityId;
    else queenId1 = col.queenEntityId;
  }

  const antCount = ants.alive.length;
  for (let i = 0; i < antCount; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.zone[i] !== 0) continue; // surface only
    if (i === queenId0 || i === queenId1) continue; // queens are not bite-able
    if ((ants.posX[i]! >> FP_SHIFT) === tileX && (ants.posY[i]! >> FP_SHIFT) === tileY) return true;
  }
  return false;
}

/**
 * V23 self-defense (#147): nearest live surface AntTask.Fighting ant within
 * SPIDER_DEFENSE_TRIGGER_RADIUS of the spider. Returns the ant entity id, or -1.
 * Used to make an attacked spider stop meandering/camping and actively engage its
 * attackers (a Chasing spider moves at 2× ant speed, so it reliably closes). Same
 * deterministic Manhattan + ascending-id-tiebreak contract as findChaseTarget; no
 * allocation. Queens are never AntTask.Fighting, so no queen exclusion is needed.
 */
function findNearestAttackingFighter(world: WorldState, spider: SpiderState): number {
  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;
  const r = SPIDER_DEFENSE_TRIGGER_RADIUS;

  const { ants } = world;
  const antCount = ants.alive.length;
  let bestId = -1;
  let bestDist = r + 1;
  for (let i = 0; i < antCount; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.zone[i] !== 0) continue; // surface only
    if (ants.task[i] !== AntTask.Fighting) continue;
    const ax = ants.posX[i]! >> FP_SHIFT;
    const ay = ants.posY[i]! >> FP_SHIFT;
    const dist = (ax > spiderTileX ? ax - spiderTileX : spiderTileX - ax) +
                 (ay > spiderTileY ? ay - spiderTileY : spiderTileY - ay);
    if (dist > r) continue;
    if (dist < bestDist) { bestDist = dist; bestId = i; } // strict < ⇒ lower id wins on tie
  }
  return bestId;
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
/**
 * Murmur3 32-bit finalizer over a single integer seed. Good avalanche,
 * deterministic, no rngState draw. Shared by pickRampageTarget, the V23 meander
 * target, and the V23 feed-away direction. Returns an unsigned 32-bit int.
 */
function hash32(x: number): number {
  let h = Math.imul(x | 0, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

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
  const h = hash32(world.terrainSeed ^ spider.rampageStartTick);
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

function emitSpiderChaseEnd(
  world: WorldState,
  outcome: 'kill' | 'escape' | 'leash' | 'retreat' | 'killed' | 'lost',
): void {
  emitEvent(world, {
    tick: world.tick,
    type: 'spider_chase_end',
    payload: { outcome },
  });
}

/**
 * Enter the Chasing state targeting ant `targetId` and emit spider_chase_start.
 * Shared by the three V23 entry points: opportunistic Patrolling chase, active
 * self-defense (engage an attacker), and the Rampaging straggler chase-divert.
 */
function enterChasing(world: WorldState, spider: SpiderState, targetId: number): void {
  spider.state = 'Chasing';
  spider.chaseTargetAntId = targetId;
  spider.chaseStartTick = world.tick;
  emitEvent(world, {
    tick: world.tick,
    type: 'spider_chase_start',
    payload: {
      targetAntId: targetId,
      targetTile: {
        x: world.ants.posX[targetId]! >> FP_SHIFT,
        y: world.ants.posY[targetId]! >> FP_SHIFT,
      },
    },
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
    } else if (spider.state === 'Chasing') {
      emitSpiderChaseEnd(world, 'killed');
    } else if (spider.state === 'Rampaging') {
      emitSpiderRampageEnd(world, 'killed_in_nest', spider.rampageKillsThisRampage, false);
    }
    clearSpiderPairingSentinels(world);
    world.spider = null;
    world.spiderPriorityColonyId = null;
    world.scatterReticleTile = null;
    return;
  }

  // Version dispatch: V23+ uses the hunger-gated meandering predator; V22 and
  // earlier use the frozen lair-orbit/scheduled-rampage behavior (byte-identical).
  if (world.simVersion >= SIM_VERSION_V23_SPIDER_AGGRO) {
    tickSpiderV23(world, spider);
    return;
  }
  tickSpiderV22(world, spider);
}

// ---------------------------------------------------------------------------
// tickSpiderV22 — frozen pre-V23 behavior (lair orbit + scheduled rampage).
// Verbatim move of the original tickSpider body. Do NOT modify: V22-and-earlier
// replays must stay byte-identical.
// ---------------------------------------------------------------------------
function tickSpiderV22(world: WorldState, spider: SpiderState): void {
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

  // --- Priority retreating-threshold check (applies to Striking, Chasing, Rampaging) ---
  // This runs before state-specific logic so a combat-damaged spider retreats
  // immediately, even on the same tick its duration would have expired.
  if ((spider.state === 'Striking' || spider.state === 'Chasing' || spider.state === 'Rampaging') &&
      spider.hp < SPIDER_RAMPAGE_RETREAT_HP) {
    if (spider.state === 'Striking') {
      emitSpiderHuntEnd(world, 'swarm_retreat', spider.killsThisStrike);
    } else if (spider.state === 'Chasing') {
      emitSpiderChaseEnd(world, 'retreat');
    } else {
      emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
    }
    clearSpiderPairingSentinels(world);
    spider.state = 'Retreating';
    spider.retreatStartTick = world.tick;
    spider.huntTargetTileX = -1;
    spider.huntTargetTileY = -1;
    spider.chaseTargetAntId = -1;
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
      } else {
        // V23 (#146): opportunistic chase — a lone ant within trigger radius takes
        // precedence over the scheduled tile-density hunt (but not over rampaging).
        const chaseId = world.simVersion >= SIM_VERSION_V23_SPIDER_AGGRO
          ? findChaseTarget(world, spider)
          : -1;
        if (chaseId >= 0) {
          spider.state = 'Chasing';
          spider.chaseTargetAntId = chaseId;
          spider.chaseStartTick = world.tick;
          emitEvent(world, {
            tick: world.tick,
            type: 'spider_chase_start',
            payload: {
              targetAntId: chaseId,
              targetTile: {
                x: world.ants.posX[chaseId]! >> FP_SHIFT,
                y: world.ants.posY[chaseId]! >> FP_SHIFT,
              },
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

    case 'Chasing': {
      // Combat ran at step 17 (this tick) before tickSpider, so a catch shows up as a
      // dead target here. Exit on catch / escape underground / leash-timeout; otherwise
      // keep pursuing (movement happens in the movement switch below).
      const tid = spider.chaseTargetAntId;
      const targetAlive = tid >= 0 && world.ants.alive[tid] === 1;
      if (!targetAlive) {
        // Target died — treat as a successful catch (hunger satisfied).
        emitSpiderChaseEnd(world, 'kill');
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.chaseTargetAntId = -1;
        spider.hungerTicks = 0;
      } else if (world.ants.zone[tid] !== 0) {
        // Target reached safety underground — abandon.
        emitSpiderChaseEnd(world, 'escape');
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.chaseTargetAntId = -1;
      } else if (world.tick - spider.chaseStartTick >= SPIDER_CHASE_MAX_TICKS) {
        // Safety leash expired — give up and return to patrol.
        emitSpiderChaseEnd(world, 'leash');
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.chaseTargetAntId = -1;
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
    case 'Chasing': {
      // Pursue the target ant's current tile each tick (transition logic above already
      // handled dead/underground/leash-expired targets, so the id is live here).
      const tid = spider.chaseTargetAntId;
      if (tid >= 0 && world.ants.alive[tid] === 1) {
        moveTowardTile(spider, world.ants.posX[tid]! >> FP_SHIFT, world.ants.posY[tid]! >> FP_SHIFT);
      }
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
  // Surface states: Patrolling, Hunting, Chasing, Striking, Rampaging (while on surface)
  const isOnSurface = spider.state !== 'Feeding' && spider.state !== 'Retreating';
  if (isOnSurface) {
    seedDangerPheromone(world, spider);
  }


  // --- scatterReticleTile shadow field: written at end for next tick's step 13e ---
  // Hunting/Striking scatter around the hunt target tile; Chasing (V23) scatters around
  // the pursued ant's current tile so nearby non-fighters flee the chase.
  const chaseTid = spider.chaseTargetAntId;
  const chaseReticleValid =
    spider.state === 'Chasing' && chaseTid >= 0 && world.ants.alive[chaseTid] === 1;
  if (spider.state === 'Hunting' || spider.state === 'Striking') {
    if (world.scatterReticleTile === null) {
      world.scatterReticleTile = { x: spider.huntTargetTileX, y: spider.huntTargetTileY };
    } else {
      world.scatterReticleTile.x = spider.huntTargetTileX;
      world.scatterReticleTile.y = spider.huntTargetTileY;
    }
  } else if (chaseReticleValid) {
    const rx = world.ants.posX[chaseTid]! >> FP_SHIFT;
    const ry = world.ants.posY[chaseTid]! >> FP_SHIFT;
    if (world.scatterReticleTile === null) {
      world.scatterReticleTile = { x: rx, y: ry };
    } else {
      world.scatterReticleTile.x = rx;
      world.scatterReticleTile.y = ry;
    }
  } else {
    world.scatterReticleTile = null;
  }
}

// ---------------------------------------------------------------------------
// V23 helpers — fighter adjacency + feed-away destination
// ---------------------------------------------------------------------------

/**
 * V23: true if any live surface Fighting ant is within SPIDER_FEED_DANGER_RADIUS
 * (Manhattan) of the spider's tile. Boolean scan, no allocation.
 */
function isFighterAdjacent(world: WorldState, spider: SpiderState): boolean {
  const sx = spider.posX >> FP_SHIFT;
  const sy = spider.posY >> FP_SHIFT;
  const r = SPIDER_FEED_DANGER_RADIUS;
  const { ants } = world;
  const len = ants.alive.length;
  for (let i = 0; i < len; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.zone[i] !== 0) continue; // surface only
    if (ants.task[i] !== AntTask.Fighting) continue;
    const ax = ants.posX[i]! >> FP_SHIFT;
    const ay = ants.posY[i]! >> FP_SHIFT;
    const dist = (ax > sx ? ax - sx : sx - ax) + (ay > sy ? ay - sy : sy - ay);
    if (dist <= r) return true;
  }
  return false;
}

/**
 * V23: compute the ~10-tile feed destination away from the kill tile and store
 * it in feedAwayTile{X,Y}. The spider is normally on the kill tile (dx=dy=0); in
 * that case a deterministic hash picks one of ±X/±Y. Otherwise step along the
 * dominant away-axis (no diagonals). Clamped to grid bounds. No allocation.
 */
function computeFeedAwayTile(world: WorldState, spider: SpiderState): void {
  const sx = spider.posX >> FP_SHIFT;
  const sy = spider.posY >> FP_SHIFT;
  const kx = spider.lastKillTileX >= 0 ? spider.lastKillTileX : sx;
  const ky = spider.lastKillTileY >= 0 ? spider.lastKillTileY : sy;
  let signX = 0;
  let signY = 0;
  const dx = sx - kx;
  const dy = sy - ky;
  if (dx === 0 && dy === 0) {
    const h = hash32(world.tick ^ world.terrainSeed) & 3;
    if (h === 0) signX = 1;
    else if (h === 1) signX = -1;
    else if (h === 2) signY = 1;
    else signY = -1;
  } else {
    const ax = dx < 0 ? -dx : dx;
    const ay = dy < 0 ? -dy : dy;
    if (ax >= ay) signX = dx > 0 ? 1 : -1;
    else signY = dy > 0 ? 1 : -1;
  }
  spider.feedAwayTileX = feedRetreatCoord(kx, signX, SURFACE_GRID_WIDTH);
  spider.feedAwayTileY = feedRetreatCoord(ky, signY, SURFACE_GRID_HEIGHT);
}

// Retreat `SPIDER_FEED_RETREAT_TILES` from the kill coordinate along one axis.
// If the preferred direction would exit the grid, reflect inward instead of
// clamping to the edge — otherwise an edge kill collapses the endpoint onto (or
// near) the kill tile, so the spider enters Feeding without actually moving away
// and the post-kill chain-kill avoidance silently fails. The surface grid
// (128) is far larger than 2× the retreat (20), so at least one direction is
// always in-bounds; the trailing clamp only guards a hypothetically tiny grid.
function feedRetreatCoord(k: number, sign: number, size: number): number {
  let end = k + sign * SPIDER_FEED_RETREAT_TILES;
  if (end < 0 || end > size - 1) end = k - sign * SPIDER_FEED_RETREAT_TILES;
  if (end < 0) end = 0;
  if (end > size - 1) end = size - 1;
  return end;
}

// ---------------------------------------------------------------------------
// tickSpiderV23 — hunger-gated meandering surface predator (#146/#147 redesign).
// No lair orbit; slow meander while sated, fast lunge while hunting/chasing.
// Always bites back any ant attacking it; fights to the death (no retreat/flee).
// A kill resets hunger; if out of danger it retreats ~10 tiles and heals while
// feeding (interruptible). Deterministic: no world.rngState draws.
// ---------------------------------------------------------------------------
function tickSpiderV23(world: WorldState, spider: SpiderState): void {
  // 1. Normalize: 'Retreating' is unused in V23 (may load from an earlier #172 build).
  if (spider.state === 'Retreating') spider.state = 'Patrolling';

  // Start-of-match grace: for the first SPIDER_GRACE_TICKS the spider stays dormant —
  // Patrolling + self-defense (step 4a) only — so colonies can establish before it
  // hunts. Enforced in two places so the guarantee doesn't rely on the "hunger starts
  // at 0" invariant alone: hunger neither accrues (below) nor gates predation (the
  // `hungry` check in the Patrolling case). A spider that loads with hunger already
  // past the threshold therefore still will not initiate a hunt/chase/rampage during
  // grace. See SPIDER_GRACE_TICKS / #177.
  const inGrace = world.tick < SPIDER_GRACE_TICKS;

  // 2. Hunger accrual: only while not Feeding, and only after the grace window.
  if (spider.state !== 'Feeding' && !inGrace) spider.hungerTicks += 1;

  const tier = tierIndex(world.difficulty);

  // 3. Post-kill feed signal (highest priority). Combat (step 17) set this flag
  //    earlier this tick. Any meal — predation OR self-defense — resets hunger.
  if (spider.killedThisTick === 1) {
    spider.hungerTicks = 0;
    if (!isFighterAdjacent(world, spider) && spider.state !== 'Feeding') {
      // Close the open encounter episode before switching to Feeding so telemetry
      // consumers that pair spider_*_start with spider_*_end don't see a dangling
      // encounter on the common no-fighter kill path. A self-defense kill while
      // Patrolling has no open episode, so it emits no end event. (Codex P2.)
      const priorState = spider.state;
      if (priorState === 'Chasing') {
        emitSpiderChaseEnd(world, 'kill');
      } else if (priorState === 'Hunting' || priorState === 'Striking') {
        // killsThisStrike is only incremented during Striking; a self-defense kill
        // in the Hunting telegraph phase leaves it 0, so floor deaths at 1 to avoid
        // reporting outcome:'kill' with deaths:0. (Codex P3.)
        emitSpiderHuntEnd(world, 'kill', spider.killsThisStrike > 0 ? spider.killsThisStrike : 1);
      } else if (priorState === 'Rampaging') {
        emitSpiderRampageEnd(world, 'quota_met', spider.rampageKillsThisRampage, false);
      }
      // Out of danger: retreat ~10 tiles from the kill, then eat there to heal.
      computeFeedAwayTile(world, spider);
      spider.feedArrivedTick = -1;
      clearSpiderPairingSentinels(world);
      spider.state = 'Feeding';
      spider.huntTargetTileX = -1;
      spider.huntTargetTileY = -1;
      spider.chaseTargetAntId = -1;
      spider.rampageTargetColonyId = -1;
      world.spiderPriorityColonyId = null;
      emitEvent(world, {
        tick: world.tick,
        type: 'spider_feed_start',
        payload: { killTile: { x: spider.lastKillTileX, y: spider.lastKillTileY } },
      });
    }
    // Fighter adjacent: hunger reset only — stay in current state and keep fighting.
  }

  // 4. State machine transitions.
  //
  // 4a. Active self-defense (#147): if a Fighting ant is attacking from within
  //     SPIDER_DEFENSE_TRIGGER_RADIUS, abandon the current non-committed activity
  //     (sated meander / hunt telegraph / entrance camp) and Chase the nearest
  //     attacker. Without this the spider just meanders away from its attackers —
  //     the meander (1 tile / 3 ticks ≈ 0.33/tick) is slower than a fighter
  //     (0.5/tick), so a pursuing swarm surrounds and kills it while it never
  //     engages. A Chasing spider moves at 1 tile/tick and reliably closes. Striking
  //     is a committed one-shot; Chasing already engages; Feeding interrupts on
  //     adjacency in its own case — so those three states are excluded here.
  //     EXCEPTION (#165): a Rampaging spider pinning a descender on its camped
  //     entrance must HOLD even under attack — vacating the gate to chase an attacker
  //     would let the pinned ant slip underground next tick (movement reads the
  //     spider's state before the spider ticks). Holding is not passive: the spider
  //     still bites back any ant that steps onto its tile via tile-coincident combat.
  if (
    spider.state === 'Patrolling' ||
    spider.state === 'Hunting' ||
    spider.state === 'Rampaging'
  ) {
    let holdGate = false;
    if (spider.state === 'Rampaging' && spider.rampageTargetColonyId >= 0) {
      const camped = findNearestEntrance(world, spider, spider.rampageTargetColonyId);
      holdGate = camped !== null && isSurfaceAntOnTile(world, camped.x, camped.y);
    }
    const attackerId = holdGate ? -1 : findNearestAttackingFighter(world, spider);
    if (attackerId >= 0) {
      if (spider.state === 'Hunting') {
        emitSpiderHuntEnd(world, 'scatter', spider.killsThisStrike);
        spider.huntTargetTileX = -1;
        spider.huntTargetTileY = -1;
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        world.spiderPriorityColonyId = null;
      } else if (spider.state === 'Rampaging') {
        emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
        spider.rampageTargetColonyId = -1;
        world.spiderPriorityColonyId = null;
      }
      clearSpiderPairingSentinels(world);
      enterChasing(world, spider, attackerId);
    }
  }

  switch (spider.state) {
    case 'Patrolling': {
      const hungry = !inGrace && spider.hungerTicks >= SPIDER_HUNGER_THRESHOLD_TICKS[tier]!;
      if (hungry) {
        // Precedence: (a) opportunistic chase of a lone ant; (b) telegraphed
        // density hunt (when off cooldown and a dense tile exists); (c) camp a
        // colony entrance via the balance-tuned rampage target picker.
        const chaseId = findChaseTarget(world, spider);
        if (chaseId >= 0) {
          enterChasing(world, spider, chaseId);
        } else {
          let entered = false;
          if (world.tick >= spider.nextHuntTick) {
            const target = findHuntTarget(world, spider);
            if (target !== null) {
              spider.state = 'Hunting';
              spider.huntTargetTileX = target.x;
              spider.huntTargetTileY = target.y;
              spider.huntStartTick = world.tick;
              entered = true;
              emitEvent(world, {
                tick: world.tick,
                type: 'spider_hunt_start',
                payload: {
                  reticleTile: { x: target.x, y: target.y, grid: 'surface' },
                  targetWorkers: target.workerCount,
                },
              });
            } else {
              // No dense tile — postpone the hunt scan by one interval.
              spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
            }
          }
          if (!entered) {
            // Camp a colony entrance and eat the first ant there.
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
          }
        }
      }
      // Sated: no predation — slow meander handled in the movement switch.
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
      if (world.tick - spider.strikeStartTick >= SPIDER_STRIKE_TICKS) {
        // Kills route through step 3 (killedThisTick → Feeding). Reaching here
        // means no feed this strike (no kill, or a fighter-adjacent kill); scatter.
        emitSpiderHuntEnd(world, spider.killsThisStrike > 0 ? 'kill' : 'scatter', spider.killsThisStrike);
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.huntTargetTileX = -1;
        spider.huntTargetTileY = -1;
        world.spiderPriorityColonyId = null;
      }
      break;
    }

    case 'Chasing': {
      // A catch routes through step 3 (→ Feeding when out of danger). Reaching
      // here means the target is alive, escaped underground, leashed out, or the
      // catch happened with a fighter adjacent (dead target, no feed).
      const tid = spider.chaseTargetAntId;
      const targetAlive = tid >= 0 && world.ants.alive[tid] === 1;
      if (!targetAlive) {
        // Target is gone. Report a spider 'kill' only when the spider actually
        // killed this tick (combat resolver set killedThisTick); a genuine catch
        // with a fighter adjacent stays Chasing and lands here. Otherwise the
        // target died from another source (e.g. ant-vs-ant combat earlier this
        // tick) — emit 'lost', not 'kill', so chase-success telemetry isn't
        // credited a spider kill with no matching combat_kill. (Codex P2.)
        emitSpiderChaseEnd(world, spider.killedThisTick === 1 ? 'kill' : 'lost');
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.chaseTargetAntId = -1;
      } else if (world.ants.zone[tid] !== 0) {
        emitSpiderChaseEnd(world, 'escape');
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.chaseTargetAntId = -1;
      } else if (world.tick - spider.chaseStartTick >= SPIDER_CHASE_MAX_TICKS) {
        emitSpiderChaseEnd(world, 'leash');
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.chaseTargetAntId = -1;
      }
      break;
    }

    case 'Rampaging': {
      // Camp the entrance and eat the first ant there. No quota — a kill routes
      // through step 3 (→ Feeding).
      if (world.tick - spider.rampageStartTick >= SPIDER_RAMPAGE_MAX_TICKS) {
        // Leash: no ant surfaced at the entrance in time.
        emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
        clearSpiderPairingSentinels(world);
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.rampageTargetColonyId = -1;
        world.spiderPriorityColonyId = null;
      } else if (spider.rampageTargetColonyId < 0 ||
                 findNearestEntrance(world, spider, spider.rampageTargetColonyId) === null) {
        // No target yet, or the camped colony sealed its only open entrance.
        // (Re-pick first; if still no open entrance, resume patrolling.)
        if (spider.rampageTargetColonyId < 0) spider.rampageTargetColonyId = pickRampageTarget(world, spider);
        if (findNearestEntrance(world, spider, spider.rampageTargetColonyId) === null) {
          emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
          clearSpiderPairingSentinels(world);
          spider.state = 'Patrolling';
          spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
          spider.rampageTargetColonyId = -1;
          world.spiderPriorityColonyId = null;
        }
      } else {
        // Camping-straggler lunge (#146): an ant emerging from the entrance moves off
        // the spider's tile before the combat step samples it (movement runs before
        // combat), so a stationary camper rarely lands the tile-coincident bite. If a
        // live ant is within SPIDER_CHASE_TRIGGER_RADIUS, divert to Chasing it — the
        // spider is 2× ant speed so it closes and eats, then Feeds or resumes camping.
        //
        // BUT honor the #165 blockade first: while an ant occupies the camped entrance
        // tile, hold — the gate pins that descender on the entrance and the tile-coincident
        // spider bite resolves it THIS tick. Diverting would vacate the gate and let the
        // pinned ant slip underground. Only chase once the entrance tile is clear.
        // Attacking fighters were already handled by the step-4a self-defense check.
        const camped = findNearestEntrance(world, spider, spider.rampageTargetColonyId);
        const holdGate = camped !== null && isSurfaceAntOnTile(world, camped.x, camped.y);
        const stragglerId = holdGate ? -1 : findChaseTarget(world, spider);
        if (stragglerId >= 0) {
          emitSpiderRampageEnd(world, 'retreated', spider.rampageKillsThisRampage, false);
          clearSpiderPairingSentinels(world);
          spider.rampageTargetColonyId = -1;
          world.spiderPriorityColonyId = null;
          enterChasing(world, spider, stragglerId);
        }
      }
      break;
    }

    case 'Feeding': {
      if (isFighterAdjacent(world, spider)) {
        // Interrupted: forfeit the remaining heal and resume defending.
        emitEvent(world, {
          tick: world.tick,
          type: 'spider_feed_end',
          payload: { outcome: 'interrupted' },
        });
        spider.state = 'Patrolling';
        spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
        spider.feedArrivedTick = -1;
      } else {
        const sx = spider.posX >> FP_SHIFT;
        const sy = spider.posY >> FP_SHIFT;
        if (spider.feedArrivedTick < 0 && sx === spider.feedAwayTileX && sy === spider.feedAwayTileY) {
          spider.feedArrivedTick = world.tick;
        }
        if (spider.feedArrivedTick >= 0) {
          if ((world.tick - spider.feedArrivedTick) % SPIDER_FEED_HEAL_INTERVAL_TICKS === 0 &&
              spider.hp < SPIDER_HP_FULL) {
            spider.hp += 1;
            if (spider.hp > SPIDER_HP_FULL) spider.hp = SPIDER_HP_FULL;
          }
          if (world.tick - spider.feedArrivedTick >= SPIDER_FEED_TICKS) {
            emitEvent(world, {
              tick: world.tick,
              type: 'spider_feed_end',
              payload: { outcome: 'healed' },
            });
            spider.state = 'Patrolling';
            spider.nextHuntTick = world.tick + SPIDER_HUNT_INTERVAL_TICKS;
            spider.feedArrivedTick = -1;
          }
        }
      }
      break;
    }
  }

  // 6. Movement.
  const rampageNearest = spider.state === 'Rampaging'
    ? findNearestEntrance(world, spider, spider.rampageTargetColonyId)
    : null;
  switch (spider.state) {
    case 'Patrolling': {
      // Slow meander across the whole map: step only every Nth tick toward a
      // wander target re-rolled every SPIDER_MEANDER_RETARGET_TICKS ticks. The
      // target derives from a hash of (tick-bucket ^ terrainSeed) — no lair orbit,
      // no rng draw.
      if (world.tick % SPIDER_MEANDER_TICK_DIVISOR === 0) {
        // SPIDER_MEANDER_RETARGET_TICKS is 128 = 2^7, so `tick >> 7` is the
        // integer tick-bucket (same idiom as entrance-flow's row decode); avoids
        // the float-division lint and keeps the bucket deterministic.
        const bucket = world.tick >> SPIDER_MEANDER_RETARGET_SHIFT;
        const seed = bucket ^ world.terrainSeed;
        const tx = hash32(seed) % SURFACE_GRID_WIDTH;
        const ty = hash32(seed ^ 0x9e3779b9) % SURFACE_GRID_HEIGHT;
        moveTowardTile(spider, tx, ty);
      }
      break;
    }
    case 'Hunting':
    case 'Striking': {
      moveTowardTile(spider, spider.huntTargetTileX, spider.huntTargetTileY);
      break;
    }
    case 'Chasing': {
      const tid = spider.chaseTargetAntId;
      if (tid >= 0 && world.ants.alive[tid] === 1) {
        moveTowardTile(spider, world.ants.posX[tid]! >> FP_SHIFT, world.ants.posY[tid]! >> FP_SHIFT);
      }
      break;
    }
    case 'Feeding': {
      // Travel to the feed tile, then idle there while healing.
      moveTowardTile(spider, spider.feedAwayTileX, spider.feedAwayTileY);
      break;
    }
    case 'Rampaging': {
      if (rampageNearest !== null) {
        moveTowardTile(spider, rampageNearest.x, rampageNearest.y);
      }
      break;
    }
  }

  // 7. Danger pheromone — all surface states (everything except Feeding).
  if (spider.state !== 'Feeding') {
    seedDangerPheromone(world, spider);
  }

  // scatterReticleTile shadow field: Hunting/Striking scatter around the hunt
  // tile; Chasing scatters around the pursued ant; everything else clears it.
  const chaseTid = spider.chaseTargetAntId;
  const chaseReticleValid =
    spider.state === 'Chasing' && chaseTid >= 0 && world.ants.alive[chaseTid] === 1;
  if (spider.state === 'Hunting' || spider.state === 'Striking') {
    if (world.scatterReticleTile === null) {
      world.scatterReticleTile = { x: spider.huntTargetTileX, y: spider.huntTargetTileY };
    } else {
      world.scatterReticleTile.x = spider.huntTargetTileX;
      world.scatterReticleTile.y = spider.huntTargetTileY;
    }
  } else if (chaseReticleValid) {
    const rx = world.ants.posX[chaseTid]! >> FP_SHIFT;
    const ry = world.ants.posY[chaseTid]! >> FP_SHIFT;
    if (world.scatterReticleTile === null) {
      world.scatterReticleTile = { x: rx, y: ry };
    } else {
      world.scatterReticleTile.x = rx;
      world.scatterReticleTile.y = ry;
    }
  } else {
    world.scatterReticleTile = null;
  }

  // 8. Clear the per-tick kill flag — must never leak into the next tick.
  spider.killedThisTick = 0;
}
