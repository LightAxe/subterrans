// food-system.ts — Issue #112 food-pile depletion + spawn tick step
//
// Two responsibilities:
//   1. recordFoodPileDepletion: called from tickForagerActions when a pickup
//      drains a pile to zero charges. Appends a DepletionRecord to
//      `world.recentlyDepletedFood` (with append-time cap to bound autosave
//      size) and clears any colony's `priorityFoodPileId` that pointed at
//      the now-vanished pile.
//
//   2. tickFoodPileSpawn: tick step 16d. Time-gated, soft-ceiled, deterministic
//      runtime spawner. Picks a passable tile far from colonies / entrances /
//      rally points / existing piles / recently-depleted neighbourhoods,
//      weighted toward Grass tiles. Allocates a fresh entity ID (handling
//      INVALID_ENTITY_ID exhaustion silently) and pushes the new pile.
//
// All randomness flows through the seeded `Rng` instance constructed from
// `world.rngState` at tick start. No Math.random, no Date, no floats — the
// step is fully deterministic and SCEN-06 byte-identical replay holds across
// long sessions where spawn events occur.
//
// Allocation note: `tickFoodPileSpawn` makes per-call allocations (Object.values
// of world.colonies + the new pile object). Cost is amortised over the
// FOOD_PILE_SPAWN_INTERVAL_TICKS cadence (one spawn attempt every 1800 ticks),
// well outside the per-tick hot loop. Distance checks against colony entrances
// and rally points are inlined to avoid a separate noGoTiles staging array.

import type { WorldState } from './types.js';
import type { FoodPile, FoodPileId } from './food.js';
import { allocateEntityId, INVALID_ENTITY_ID } from './types.js';
import { surfaceMovementAt, SurfaceMovementEffect } from './surface-features.js';
import { sgGet, SurfaceTileState } from './terrain.js';
import { Rng } from './rng.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
  FOOD_PILE_MAX_ATTEMPTS,
  FOOD_PILE_INITIAL_PICKUPS_MIN,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_SPAWN_INTERVAL_TICKS,
  FOOD_PILE_SOFT_CEILING,
  FOOD_PILE_RECENT_DEPLETION_TICKS,
  FOOD_PILE_TERRAIN_GRASS_WEIGHT,
  FOOD_PILE_TERRAIN_OTHER_WEIGHT,
} from './constants.js';

// ---------------------------------------------------------------------------
// recordFoodPileDepletion — splice-helper for tickForagerActions
// ---------------------------------------------------------------------------

/**
 * Record a depleted food pile in `world.recentlyDepletedFood` and clear any
 * colony's priority pointer that referenced the vanished pile.
 *
 * Append-time cap: when `recentlyDepletedFood.length >= FOOD_PILE_SOFT_CEILING`,
 * the oldest entry is shifted off before push. This bounds the array between
 * spawn passes so autosave snapshots never grow unbounded — spawn-time prune
 * (in `tickFoodPileSpawn`) drops by tick-age, but the append-time cap is what
 * holds the invariant if the player saves between spawn cycles.
 *
 * Caller (tickForagerActions) is responsible for splicing the pile out of
 * `world.foodPiles` after this returns; this helper does NOT mutate the pile
 * array — it only records the depletion event and clears stale priority refs.
 *
 * @param world      WorldState (writes recentlyDepletedFood and colony priority refs).
 * @param pileIndex  Index of the depleting pile in `world.foodPiles`.
 */
export function recordFoodPileDepletion(world: WorldState, pileIndex: number): void {
  const pile = world.foodPiles[pileIndex];
  if (!pile) return;

  // Append-time cap — drop oldest before push if at capacity.
  if (world.recentlyDepletedFood.length >= FOOD_PILE_SOFT_CEILING) {
    world.recentlyDepletedFood.shift();
  }
  world.recentlyDepletedFood.push({
    tick: world.tick,
    tileX: pile.tileX,
    tileY: pile.tileY,
  });

  // Clear stale priority pointers — any colony that designated this pile must
  // reset to null so a forager doesn't try to route to a foodPileId that no
  // longer exists. The render layer also uses priorityFoodPileId to highlight
  // the player-marked pile; without this clear, the highlight would silently
  // attach to whichever pile next reuses the recycled-id slot (impossible
  // today since IDs don't recycle, but cheap defence either way).
  const depletedId: FoodPileId = pile.foodPileId;
  for (const colony of Object.values(world.colonies)) {
    if (colony.priorityFoodPileId === depletedId) {
      colony.priorityFoodPileId = null;
    }
  }
}

// ---------------------------------------------------------------------------
// tickFoodPileSpawn — tick step 16d (issue #112)
// ---------------------------------------------------------------------------

/**
 * Time-gated runtime spawner for food piles. Runs as tick step 16d (after
 * tickForagerActions / tickNurseActions, before combat).
 *
 * Gates:
 *   - `world.tick > 0` — the very first tick never spawns; world settles first.
 *   - `world.tick % FOOD_PILE_SPAWN_INTERVAL_TICKS === 0` — fires once per cycle.
 *   - `world.foodPiles.length < FOOD_PILE_SOFT_CEILING` — soft cap; skip if full.
 *
 * Placement (rejection sampling, max FOOD_PILE_MAX_ATTEMPTS):
 *   - Surface-passable (not HardBlock).
 *   - Manhattan-distant by FOOD_PILE_MIN_COLONY_DISTANCE from every colony's
 *     start (encoded by entrances) and rallyPoint.
 *   - Manhattan-distant by FOOD_PILE_MIN_SEPARATION from every existing pile.
 *   - Manhattan-distant by FOOD_PILE_MIN_SEPARATION from every entry in
 *     recentlyDepletedFood whose age <= FOOD_PILE_RECENT_DEPLETION_TICKS
 *     (anti-teleport guard while pheromone trails on the old tile decay).
 *   - Terrain weighted: Grass accepted unconditionally; non-Grass passable
 *     accepted with probability OTHER/(GRASS+OTHER) via a single PRNG draw.
 *
 * Side effects:
 *   - Prunes `recentlyDepletedFood` of stale entries (older than the recency
 *     window) before sampling, so the recency check operates on a fresh set.
 *   - On a successful placement, allocates an entity ID and pushes the new
 *     `FoodPile`. On entity-ID exhaustion (INVALID_ENTITY_ID), silently skips.
 *
 * Determinism: every PRNG read goes through the passed `rng` (the tick-shared
 * instance). RNG draws are unconditional in some branches (terrain weighting)
 * regardless of acceptance to keep replay trivially equivalent across re-runs.
 *
 * @param world  WorldState (reads/writes foodPiles, recentlyDepletedFood).
 * @param rng    Tick-shared RNG instance.
 */
export function tickFoodPileSpawn(world: WorldState, rng: Rng): void {
  // Time gate — never spawn on tick 0; only fire once per spawn cycle.
  if (world.tick <= 0) return;
  if (world.tick % FOOD_PILE_SPAWN_INTERVAL_TICKS !== 0) return;

  // Soft-ceiling gate — skip silently when at or above the soft cap. Hard cap
  // (MAX_FOOD_PILES = 60 from #109) sits at 2× this; we never approach it.
  if (world.foodPiles.length >= FOOD_PILE_SOFT_CEILING) return;

  // Spawn-time prune of stale recentlyDepletedFood entries. Append-time cap
  // bounds the array; this prune drops entries by age so an old entry doesn't
  // keep blocking a tile after pheromone trails have long since decayed.
  //
  // Walks BACKWARD (length-1 → 0) so in-place splice doesn't shift indices
  // we haven't visited yet — the standard safe pattern for delete-during-iter.
  // Also drops entries with `tick > world.tick` defensively (HI-03 guard):
  // a tampered save or a debug-tick reset could otherwise leave future-dated
  // entries that the `tick <= recencyThreshold` check would never prune,
  // permanently sterilising a tile region.
  const recencyThreshold = world.tick - FOOD_PILE_RECENT_DEPLETION_TICKS;
  for (let i = world.recentlyDepletedFood.length - 1; i >= 0; i--) {
    const entryTick = world.recentlyDepletedFood[i]!.tick;
    if (entryTick <= recencyThreshold || entryTick > world.tick) {
      world.recentlyDepletedFood.splice(i, 1);
    }
  }

  // Cache the colony list once per spawn invocation. The distance check is
  // inlined into the rejection-sampling loop below to avoid materialising a
  // separate noGoTiles array (which would allocate per-call). Spawn fires
  // every 1800 ticks, not per-tick, so this cost is amortised — but inlining
  // is still cleaner and avoids needing a buffer on `world` for one site.
  //
  // Note: we deliberately do NOT check `world.pendingChambers` here.
  // Pending chambers are underground entities (chamber.ts: anchor coords are
  // underground tile-space); food piles are surface entities. There is no
  // collision between a surface-tile placement and an underground chamber
  // marker. If a future change introduces surface-locked chamber footprints,
  // add a `pendingChambers` rejection branch alongside the others below.
  const colonies = Object.values(world.colonies);

  for (let attempt = 0; attempt < FOOD_PILE_MAX_ATTEMPTS; attempt++) {
    const tileX = rng.nextRange(0, SURFACE_GRID_WIDTH - 1);
    const tileY = rng.nextRange(0, SURFACE_GRID_HEIGHT - 1);
    // Terrain-weight roll consumed unconditionally — keeps the RNG sequence
    // stable regardless of which earlier rejection short-circuited a candidate.
    const terrainRoll = rng.nextU32();

    // Surface-passable check — HardBlock features (boulders, twigs, leaves)
    // are not eligible. SoftCost (bushes, grass clumps as movement layer) is
    // fine; the tile-state grass weighting handles the "vegetation" axis.
    if (surfaceMovementAt(world, tileX, tileY) === SurfaceMovementEffect.HardBlock) continue;

    // Distance from every colony's entrances + rallyPoint, inlined so we
    // don't allocate a noGoTiles staging array per spawn call.
    let tooCloseToColony = false;
    for (const colony of colonies) {
      if (colony.entrances) {
        for (const e of colony.entrances) {
          if (Math.abs(tileX - e.surfaceTileX) + Math.abs(tileY - e.surfaceTileY) < FOOD_PILE_MIN_COLONY_DISTANCE) {
            tooCloseToColony = true;
            break;
          }
        }
      }
      if (tooCloseToColony) break;
      if (colony.rallyPoint) {
        if (Math.abs(tileX - colony.rallyPoint.tileX) + Math.abs(tileY - colony.rallyPoint.tileY) < FOOD_PILE_MIN_COLONY_DISTANCE) {
          tooCloseToColony = true;
          break;
        }
      }
    }
    if (tooCloseToColony) continue;

    // Distance from every existing pile.
    let tooCloseToExisting = false;
    for (const pile of world.foodPiles) {
      if (Math.abs(tileX - pile.tileX) + Math.abs(tileY - pile.tileY) < FOOD_PILE_MIN_SEPARATION) {
        tooCloseToExisting = true;
        break;
      }
    }
    if (tooCloseToExisting) continue;

    // Anti-teleport guard — distance from every recently-depleted tile.
    let tooCloseToRecentDeplete = false;
    for (const r of world.recentlyDepletedFood) {
      if (Math.abs(tileX - r.tileX) + Math.abs(tileY - r.tileY) < FOOD_PILE_MIN_SEPARATION) {
        tooCloseToRecentDeplete = true;
        break;
      }
    }
    if (tooCloseToRecentDeplete) continue;

    // Terrain weighting — Grass is always accepted; non-Grass tiles pass with
    // probability OTHER/(GRASS+OTHER). Single integer compare on the roll
    // already drawn above (uniform in [0, 2^32)).
    const tileState = sgGet(world.surface, tileX, tileY);
    if (tileState !== SurfaceTileState.Grass) {
      const totalWeight = FOOD_PILE_TERRAIN_GRASS_WEIGHT + FOOD_PILE_TERRAIN_OTHER_WEIGHT;
      if (terrainRoll % totalWeight >= FOOD_PILE_TERRAIN_OTHER_WEIGHT) continue;
    }

    // Initial pickup-charges — uniform draw across the variable-size range.
    const pickups = rng.nextRange(FOOD_PILE_INITIAL_PICKUPS_MIN, FOOD_PILE_INITIAL_PICKUPS_MAX);
    // Defensive: a future misconfiguration where MIN > MAX would make
    // `nextRange` return NaN (modulo-by-non-positive). NaN-piles never
    // deplete (any decrement stays NaN). Guard so the ill-configured spawn
    // is dropped instead of poisoning world.foodPiles silently.
    if (!Number.isInteger(pickups) || pickups <= 0) return;

    // Allocate entity ID — bail silently on exhaustion (#59 long-session guard).
    const newId = allocateEntityId(world);
    if (newId === INVALID_ENTITY_ID) return;

    const newPile: FoodPile = {
      foodPileId: newId,
      tileX,
      tileY,
      pickupsRemaining: pickups,
      pickupsInitial: pickups,
    };
    world.foodPiles.push(newPile);
    return;
  }

  // Out of attempts — silently give up. Same behaviour as scenario.ts seeding
  // when the map is too crowded.
}
