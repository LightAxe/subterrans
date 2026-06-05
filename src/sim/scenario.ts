// scenario.ts — one-shot world generation function (PRD §6a)
//
// createScenario is the single entry point for game initialization.
// It creates the surface grid, two underground grids, two colonies with
// queen + STARTING_WORKERS workers, FOOD_PILE_COUNT scattered food piles,
// and all 8 pheromone grids (2 colonies × 2 types × 2 zones).
//
// Deterministic: same seed always produces identical output (SCEN-06).
// No Math.random() — all randomness flows through the seeded Mulberry32 PRNG.
// No floats — all positions use fixed-point (FP_SHIFT=8).

import type { WorldState, SpiderState } from './types.js';
import { createWorldState, allocateEntityId } from './types.js';
import { createDefaultAIStateRecord, tierIndex } from './ai-state.js';
import {
  createSurfaceGrid,
  createUndergroundGrid,
  SurfaceTileState,
  UndergroundTileState,
  ugSet,
} from './terrain.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import { createPheromoneGrid, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { Rng } from './rng.js';
import { FP_SHIFT } from './fixed.js';
import { AntTask, PheromoneType } from './enums.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  ENEMY_START_X,
  ENEMY_START_Y,
  STARTING_FOOD,
  STARTING_WORKERS,
  FOOD_PILE_COUNT,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
  FOOD_PILE_MAX_ATTEMPTS,
  FOOD_PILE_INITIAL_PICKUPS_MIN,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  DIRT_SCATTER_RATIO_FP,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  WORKER_LIFESPAN_TICKS,
  ENTRANCE_SHAFT_DEPTH,
  COMBAT_HP_QUEEN,
  SPIDER_HP_FULL,
  SPIDER_TERRITORY_RADIUS_TILES,
  SPIDER_EDGE_MARGIN_TILES,
  SPIDER_HUNT_INTERVAL_TICKS,
  QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR,
} from './constants.js';

// ---------------------------------------------------------------------------
// Food pile scatter — rejection sampling (PRD §6b)
// ---------------------------------------------------------------------------

/**
 * Populate world.foodPiles via rejection sampling.
 *
 * Constraints (PRD §6b):
 *   - Each pile must be >= FOOD_PILE_MIN_COLONY_DISTANCE (8) Manhattan tiles
 *     from any colony start position.
 *   - Each pile must be >= FOOD_PILE_MIN_SEPARATION (12) Manhattan tiles
 *     from every already-placed pile.
 *   - Up to FOOD_PILE_MAX_ATTEMPTS (1000) total tries before giving up.
 *
 * Note: Math.abs is used for Manhattan distance — only Math.random,
 * Math.sqrt, Math.sin, Math.cos, Math.round, Math.floor are banned in src/sim/.
 *
 * Issue #59 — `allocateEntityId` calls in scenario.ts are not guarded against
 * the INVALID_ENTITY_ID sentinel because createScenario runs once on a fresh
 * world (nextEntityId starts at 0) and allocates a known-bounded count
 * (FOOD_PILE_COUNT food piles + 2 queens + N workers per colony, all far
 * below MAX_ENTITIES=8192). The sentinel cannot be returned from these calls
 * by construction. Production runtime callers (egg-laying, chamber spawn,
 * entrance creation) handle the sentinel.
 */
function generateFoodPiles(world: WorldState, rng: Rng): void {
  const colonies = [
    { x: PLAYER_START_X, y: PLAYER_START_Y },
    { x: ENEMY_START_X, y: ENEMY_START_Y },
  ];

  for (
    let attempt = 0;
    attempt < FOOD_PILE_MAX_ATTEMPTS && world.foodPiles.length < FOOD_PILE_COUNT;
    attempt++
  ) {
    const tileX = rng.nextRange(0, SURFACE_GRID_WIDTH - 1);
    const tileY = rng.nextRange(0, SURFACE_GRID_HEIGHT - 1);

    // Reject if too close to any colony start (Manhattan distance)
    let tooCloseToColony = false;
    for (const c of colonies) {
      if (Math.abs(tileX - c.x) + Math.abs(tileY - c.y) < FOOD_PILE_MIN_COLONY_DISTANCE) {
        tooCloseToColony = true;
        break;
      }
    }
    if (tooCloseToColony) continue;

    // Reject if too close to any existing pile (Manhattan distance)
    let tooCloseToExisting = false;
    for (const pile of world.foodPiles) {
      if (Math.abs(tileX - pile.tileX) + Math.abs(tileY - pile.tileY) < FOOD_PILE_MIN_SEPARATION) {
        tooCloseToExisting = true;
        break;
      }
    }
    if (tooCloseToExisting) continue;

    // Issue #112 — Each scenario-seeded pile gets a finite pickup-charge count
    // drawn uniformly from [FOOD_PILE_INITIAL_PICKUPS_MIN, MAX]. The draw uses
    // a hash of (terrainSeed, allocated entity id) instead of the world RNG so
    // adding the depletion mechanic does NOT advance world.rngState during
    // scenario seeding — preserving byte-identical replay for every existing
    // test that calls createScenario(seed) and asserts post-tick RNG outcomes.
    // Runtime spawns (tickFoodPileSpawn) still use the world RNG; only the
    // one-shot generation step is hash-derived.
    const newId = allocateEntityId(world);
    const pickups = pickupsForSeed(world.terrainSeed, newId);

    world.foodPiles.push({
      foodPileId: newId,
      tileX,
      tileY,
      pickupsRemaining: pickups,
      pickupsInitial: pickups,
    });
  }
}

/**
 * Issue #112 — derive a per-pile initial pickup-charge count from a stable
 * hash of (terrainSeed, foodPileId). Returns a uniform integer in
 * `[FOOD_PILE_INITIAL_PICKUPS_MIN, FOOD_PILE_INITIAL_PICKUPS_MAX]`.
 *
 * This intentionally bypasses the world RNG so scenario seeding's RNG
 * footprint is unchanged after the depletion mechanic landed. Same input
 * seed → same per-pile pickup counts → same downstream behaviour for any
 * test or replay.
 */
function pickupsForSeed(terrainSeed: number, foodPileId: number): number {
  // Knuth's golden-ratio multiplier — same constant used by terrainSeed
  // initialization in createWorldState. Mixed with foodPileId for per-pile
  // variation that's stable across runs of the same seed.
  let h = (terrainSeed ^ foodPileId) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  const span = FOOD_PILE_INITIAL_PICKUPS_MAX - FOOD_PILE_INITIAL_PICKUPS_MIN + 1;
  return FOOD_PILE_INITIAL_PICKUPS_MIN + ((h >>> 0) % span);
}

// ---------------------------------------------------------------------------
// Colony initialization helper
// ---------------------------------------------------------------------------

/**
 * Create a colony record with Phase 3 extension defaults (PRD §2a caller-side
 * contract), queen, and STARTING_WORKERS workers — all at (startX, startY).
 *
 * Phase 3 PRD §2a: createColonyRecord factory does NOT initialize
 * entrances / rallyPoint / digFlowFieldDirty.  This function assigns those
 * three defaults immediately after the factory call per the accepted contract.
 */
function initColony(
  world: WorldState,
  colonyId: number,
  startX: number,
  startY: number,
  rng: Rng,
): void {
  // Suppress lint warning: rng parameter is accepted for future use in
  // queen/worker placement variance; currently unused (all ants placed at
  // exact start tile per PRD §6a step 7).
  void rng;

  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId,
    posX: startX << FP_SHIFT,
    posY: startY << FP_SHIFT,
    task: AntTask.Idle,
    lifespan: WORKER_LIFESPAN_TICKS,
    hp: COMBAT_HP_QUEEN,
  });

  const colony = createColonyRecord(colonyId, queenId);

  // Phase 3 PRD §2a caller-side extension contract —
  // factory intentionally does not set these three fields:
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  colony.foodFlowFieldDirty = false;
  colony.foodStored = STARTING_FOOD;

  // Phase 9 playability: seed each colony with one pre-excavated open entrance
  // at the colony's start column so the forage loop closes on tick 0.
  // Without this, STARTING_WORKERS foragers can pick up food on the surface
  // but have no route underground to deposit — colony.foodStored never grows,
  // the queen starves in a few hundred ticks, and the player cannot recover
  // until they manually designate + excavate a shaft. (Phase 10 CTRL-06:
  // digging is now auto-assigned whenever Marked tiles exist and an ant is
  // Idle — the player only needs to mark the shaft tiles; the default
  // behavior ratio `{ forage: 10, fight: 0 }` no longer needs adjustment to
  // make digging happen.) The starting entrance is the minimum thing that
  // makes the prototype playable out of the box. Aligns with the Phase 8
  // Stabilization Memo item #4 ("expose a more legible initial
  // entrance/opening state").
  const underground = world.undergroundGrids[colonyId];
  if (underground) {
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: startX,
      surfaceTileY: startY,
      isOpen: true,
    });
    // Pre-excavate the shaft (underground tiles at the entrance column).
    for (let sy = 0; sy < ENTRANCE_SHAFT_DEPTH; sy++) {
      ugSet(underground, startX, sy, UndergroundTileState.Open);
    }
  }

  // Create STARTING_WORKERS workers at same tile as queen (PRD §6a step 7)
  for (let w = 0; w < STARTING_WORKERS; w++) {
    const workerId = allocateEntityId(world);
    initAnt(world.ants, workerId, {
      colonyId,
      posX: startX << FP_SHIFT,
      posY: startY << FP_SHIFT,
      task: AntTask.Idle,
    });
    colony.workers.push(workerId);
    colony.workerCount += 1;
  }

  world.colonies[colonyId] = colony;
}

// ---------------------------------------------------------------------------
// S3 — Spider lair placement (deterministic, no world.rngState draws)
// ---------------------------------------------------------------------------

/**
 * S3 — Place spider at a deterministic lair tile derived from terrainSeed.
 * Lair placement: surface tile not within SPIDER_TERRITORY_RADIUS_TILES of
 * either colony start, using rejection sampling from a terrainSeed-derived hash.
 * No rng draws from world.rngState — uses a separate hash from terrainSeed
 * to preserve SCEN-06 replay determinism.
 */
function _placeSpider(world: WorldState): SpiderState {
  const minDist = SPIDER_TERRITORY_RADIUS_TILES;
  let h = Math.imul(world.terrainSeed, 2654435761) >>> 0;

  let lairTileX = SURFACE_GRID_WIDTH >> 1;
  let lairTileY = SURFACE_GRID_HEIGHT >> 1;

  // #181 — Sample the lair from the SPIDER_EDGE_MARGIN_TILES-inset interior
  // [margin, size-1-margin] instead of the full [0, size-1] grid, so the spider
  // never spawns inside the margin band the per-tick clamp (tickSpiderV23 step 6b)
  // enforces during play. Without this the spider could spawn at the very edge and
  // jump inward on its first tick. Scenario generation is unversioned (always
  // LATEST, like the rest of createScenario), so no simVersion gate here — only the
  // runtime movement clamp is gated, for save-replay determinism.
  const spanX = SURFACE_GRID_WIDTH - 2 * SPIDER_EDGE_MARGIN_TILES;
  const spanY = SURFACE_GRID_HEIGHT - 2 * SPIDER_EDGE_MARGIN_TILES;

  for (let attempt = 0; attempt < 1000; attempt++) {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    const tx = ((h >>> 0) % spanX) + SPIDER_EDGE_MARGIN_TILES;
    const h2 = Math.imul(h, 0x9e3779b9) >>> 0;
    const ty = ((h2 >>> 0) % spanY) + SPIDER_EDGE_MARGIN_TILES;

    // Check Manhattan distance from both colony starts
    const d1 =
      (tx > PLAYER_START_X ? tx - PLAYER_START_X : PLAYER_START_X - tx) +
      (ty > PLAYER_START_Y ? ty - PLAYER_START_Y : PLAYER_START_Y - ty);
    const d2 =
      (tx > ENEMY_START_X ? tx - ENEMY_START_X : ENEMY_START_X - tx) +
      (ty > ENEMY_START_Y ? ty - ENEMY_START_Y : ENEMY_START_Y - ty);
    if (d1 >= minDist && d2 >= minDist && Math.abs(d1 - d2) <= 20) {
      lairTileX = tx;
      lairTileY = ty;
      break;
    }
  }

  return {
    state: 'Patrolling',
    posX: lairTileX << FP_SHIFT,
    posY: lairTileY << FP_SHIFT,
    lairTileX,
    lairTileY,
    territoryRadiusTiles: SPIDER_TERRITORY_RADIUS_TILES,
    hp: SPIDER_HP_FULL,
    attackCooldown: 0,
    hungerTicks: 0,
    nextHuntTick: SPIDER_HUNT_INTERVAL_TICKS, // first hunt at tick 1200
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
}

// ---------------------------------------------------------------------------
// createScenario — one-shot world generation entry point (PRD §6a)
// ---------------------------------------------------------------------------

/**
 * Generate a complete game scenario from a seed.
 *
 * Steps (PRD §6a):
 *   1. Create WorldState via createWorldState(seed)
 *   2. Create surface grid with dirt scatter
 *   3. Create underground grids (one per colony, all Solid)
 *   4. Generate food piles via rejection sampling
 *   5. Create colony 1 (player) with queen + STARTING_WORKERS workers
 *   6. Create colony 2 (enemy) with queen + STARTING_WORKERS workers
 *   7. Phase 3 colony extensions assigned caller-side per PRD §2a
 *   8. Create pheromone grids for each colony (FoodTrail + DangerTrail, both zones)
 *   9. Write back rngState
 *
 * @param seed       - Mulberry32 seed for deterministic generation.
 * @param difficulty - S5 player-selected difficulty tier. Stored on world.difficulty.
 *                     Defaults to 'Normal' for backward-compatible call sites.
 */
export function createScenario(
  seed: number,
  difficulty: 'Easy' | 'Normal' | 'Hard' = 'Normal',
): WorldState {
  // --- Step 1: Create base WorldState ---
  const world = createWorldState(seed);
  world.difficulty = difficulty;

  // Reconstruct PRNG from seed-derived rngState (PRD §4 integration contract)
  const rng = new Rng(world.rngState);

  // --- Step 2: Surface grid with dirt scatter (PRD §6b) ---
  world.surface = createSurfaceGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
  for (let i = 0; i < SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT; i++) {
    if (rng.nextRange(0, 255) < DIRT_SCATTER_RATIO_FP) {
      world.surface.data[i] = SurfaceTileState.Dirt;
    }
  }

  // --- Step 3: Underground grids (all Solid by default — Uint8Array zero-init) ---
  world.undergroundGrids[PLAYER_COLONY_ID] = createUndergroundGrid(
    UNDERGROUND_GRID_WIDTH,
    UNDERGROUND_GRID_HEIGHT,
  );
  world.undergroundGrids[ENEMY_COLONY_ID] = createUndergroundGrid(
    UNDERGROUND_GRID_WIDTH,
    UNDERGROUND_GRID_HEIGHT,
  );

  // --- Step 4: Food pile scatter ---
  generateFoodPiles(world, rng);

  // --- Steps 5-6: Colony initialization (player + enemy) ---
  initColony(world, PLAYER_COLONY_ID, PLAYER_START_X, PLAYER_START_Y, rng);
  initColony(world, ENEMY_COLONY_ID, ENEMY_START_X, ENEMY_START_Y, rng);
  // S5 (V22): encode difficulty scaling into the AI colony record so lifecycle-system
  // can apply the numerator without branching on PLAYER_COLONY_ID at runtime.
  world.colonies[ENEMY_COLONY_ID]!.eggIntervalNumerator =
    QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR[tierIndex(difficulty)];
  // Player colony keeps default eggIntervalNumerator=4 (identity).

  // --- Step 8: Pheromone grids — all 8 (2 colonies × 2 types × 2 zones) ---
  // All 8 must exist so tick-step lookups never hit a missing key.
  for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
    for (const pType of [PheromoneType.FoodTrail, PheromoneType.DangerTrail]) {
      const surfaceKey = pheromoneGridKey(cid, pType, 'surface');
      const undergroundKey = pheromoneGridKey(cid, pType, 'underground');
      world.pheromoneGrids[surfaceKey] = createPheromoneGrid(
        SURFACE_GRID_WIDTH,
        SURFACE_GRID_HEIGHT,
      );
      world.pheromoneGrids[undergroundKey] = createPheromoneGrid(
        UNDERGROUND_GRID_WIDTH,
        UNDERGROUND_GRID_HEIGHT,
      );
    }
  }

  // --- S2: Initialize aiState for the enemy colony ---
  // One AIStateRecord per non-player colony with defensive defaults.
  world.aiState = [createDefaultAIStateRecord(ENEMY_COLONY_ID)];

  // --- S3: Initialize spider at a deterministic lair tile ---
  world.spider = _placeSpider(world);
  world.spiderPriorityColonyId = null;
  world.scatterReticleTile = null;

  // --- Step 9: Write back rngState ---
  world.rngState = rng.getState();

  return world;
}
