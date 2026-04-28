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

import type { WorldState } from './types.js';
import { createWorldState, allocateEntityId } from './types.js';
import { createSurfaceGrid, createUndergroundGrid, SurfaceTileState, UndergroundTileState, ugSet } from './terrain.js';
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
  DIRT_SCATTER_RATIO_FP,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  WORKER_LIFESPAN_TICKS,
  ENTRANCE_SHAFT_DEPTH,
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
 */
function generateFoodPiles(world: WorldState, rng: Rng): void {
  const colonies = [
    { x: PLAYER_START_X, y: PLAYER_START_Y },
    { x: ENEMY_START_X,  y: ENEMY_START_Y  },
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

    world.foodPiles.push({
      foodPileId: allocateEntityId(world),
      tileX,
      tileY,
    });
  }
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
    posX:     startX << FP_SHIFT,
    posY:     startY << FP_SHIFT,
    task:     AntTask.Idle,
    lifespan: WORKER_LIFESPAN_TICKS,
  });

  const colony = createColonyRecord(colonyId, queenId);

  // Phase 3 PRD §2a caller-side extension contract —
  // factory intentionally does not set these three fields:
  colony.entrances         = [];
  colony.rallyPoint        = null;
  colony.digFlowFieldDirty = false;
  colony.foodFlowFieldDirty = false;
  colony.foodStored        = STARTING_FOOD;

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
      entranceId:   allocateEntityId(world),
      surfaceTileX: startX,
      surfaceTileY: startY,
      isOpen:       true,
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
 * @param seed - Mulberry32 seed for deterministic generation.
 */
export function createScenario(seed: number): WorldState {
  // --- Step 1: Create base WorldState ---
  const world = createWorldState(seed);

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
  initColony(world, ENEMY_COLONY_ID,  ENEMY_START_X,  ENEMY_START_Y,  rng);

  // --- Step 8: Pheromone grids — all 8 (2 colonies × 2 types × 2 zones) ---
  // All 8 must exist so tick-step lookups never hit a missing key.
  for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
    for (const pType of [PheromoneType.FoodTrail, PheromoneType.DangerTrail]) {
      const surfaceKey     = pheromoneGridKey(cid, pType, 'surface');
      const undergroundKey = pheromoneGridKey(cid, pType, 'underground');
      world.pheromoneGrids[surfaceKey]     = createPheromoneGrid(SURFACE_GRID_WIDTH,     SURFACE_GRID_HEIGHT);
      world.pheromoneGrids[undergroundKey] = createPheromoneGrid(UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT);
    }
  }

  // --- Step 9: Write back rngState ---
  world.rngState = rng.getState();

  return world;
}
