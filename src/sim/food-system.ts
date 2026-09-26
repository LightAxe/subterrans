// food-system.ts — Issue #112 food-pile depletion + spawn tick step
//
// Responsibilities (pile storage itself is behind the food facade,
// `food/food-api.ts`; depletion bookkeeping lives there as `drainPile` /
// `recordFoodPileDepletion`):
//   1. spawnCorpseFood / corpseYield: A2 battlefield-scavenging drops.
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
import { allocateEntityId, INVALID_ENTITY_ID, SIM_VERSION_V37_CORPSE_FOOD } from './types.js';
import {
  naturalPileCount,
  pileCount,
  pileSlotAt,
  pileTileX,
  pileTileY,
  spawnPile,
  topUpOrSpawnCorpsePile,
} from './food/food-api.js';
import { isSurfaceTileInComponent } from './surface-features.js';
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
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_RECENT_DEPLETION_TICKS,
  FOOD_PILE_TERRAIN_GRASS_WEIGHT,
  FOOD_PILE_TERRAIN_OTHER_WEIGHT,
  CORPSE_PICKUPS_WORKER,
  CORPSE_PICKUPS_FIGHTER,
  CORPSE_PICKUPS_QUEEN,
  CORPSE_PICKUPS_SPIDER,
  FOOD_PICKUP_AMOUNT,
} from './constants.js';

// ---------------------------------------------------------------------------
// spawnCorpseFood — A2 battlefield scavenging (V37)
// ---------------------------------------------------------------------------

/** A2 — victim kinds that yield corpse food (one row per kind; centipede etc. slot in later). */
export type CorpseKind = 'worker' | 'fighter' | 'queen' | 'spider';

// `as const` (not a mutable `Record<...>`) — module-level sim state must be immutable
// so a stray mutation can't leak across worlds/save-load and make replay depend on
// process history (AGENTS.md ECS convention; Codex P1). Exhaustiveness over CorpseKind
// is still enforced at the `corpseYield` access below.
const CORPSE_YIELD = {
  worker: CORPSE_PICKUPS_WORKER,
  fighter: CORPSE_PICKUPS_FIGHTER,
  queen: CORPSE_PICKUPS_QUEEN,
  spider: CORPSE_PICKUPS_SPIDER,
} as const;

/** A2 — fixed corpse-food yield (pickup-charges) for a victim kind. Never RNG-drawn. */
export function corpseYield(kind: CorpseKind): number {
  return CORPSE_YIELD[kind];
}

/**
 * A2 (V37) — drop `pickups` charges of corpse food at surface tile (tileX, tileY):
 * the charge-unit wrapper over the facade's `topUpOrSpawnCorpsePile`, which owns
 * the top-up-on-occupied-tile rule, the hard-cap and surface-component guards and
 * the corpse flag. Callers (ant-death.ts `despawnAnt`, spider.ts death path) MUST
 * gate on `simVersion >= SIM_VERSION_V37_CORPSE_FOOD`: a new pile advances the
 * entity-id counter. Fixed `pickups` → no RNG draw.
 */
export function spawnCorpseFood(
  world: WorldState,
  tileX: number,
  tileY: number,
  pickups: number,
): void {
  topUpOrSpawnCorpsePile(world, tileX, tileY, pickups * FOOD_PICKUP_AMOUNT);
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
 *   - `pileCount(world) < FOOD_PILE_SOFT_CEILING` — soft cap; skip if full.
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
 *   - On a successful placement, allocates an entity ID and adds the new pile
 *     (`spawnPile`). On entity-ID exhaustion (INVALID_ENTITY_ID), silently skips.
 *
 * Determinism: every PRNG read goes through the passed `rng` (the tick-shared
 * instance). RNG draws are unconditional in some branches (terrain weighting)
 * regardless of acceptance to keep replay trivially equivalent across re-runs.
 *
 * @param world  WorldState (reads/writes the pile store, recentlyDepletedFood).
 * @param rng    Tick-shared RNG instance.
 */
export function tickFoodPileSpawn(world: WorldState, rng: Rng): void {
  // Time gate — never spawn on tick 0; only fire once per spawn cycle.
  if (world.tick <= 0) return;
  if (world.tick % FOOD_PILE_SPAWN_INTERVAL_TICKS !== 0) return;

  // Soft-ceiling gate — skip silently when at or above the soft cap.
  if (world.simVersion >= SIM_VERSION_V37_CORPSE_FOOD) {
    // A2 (V37) — corpse piles are EXEMPT from the natural-spawn soft ceiling, so a
    // corpse-littered war doesn't starve natural regrowth: count non-corpse piles
    // only. But the exemption breaks the old "hard cap 60 is 2×, we never approach
    // it" assumption — naturals-only would let the spawner append natural piles on
    // top of up-to-HARD_CAP corpse piles, pushing the pile count past the hard cap
    // so deserializeWorldState hard-rejects the save. The HARD_CAP backstop below is
    // therefore MANDATORY, not optional (Codex). Both clauses are V37-gated so pre-V37
    // replays byte-identically on the legacy total-count path.
    if (pileCount(world) >= FOOD_PILE_HARD_CAP) return;
    if (naturalPileCount(world) >= FOOD_PILE_SOFT_CEILING) return;
  } else {
    // Pre-V37 legacy: total-count soft ceiling (total ≤ 30 < HARD_CAP, so it never
    // nears the hard cap). Hard cap (= 60 from #109) sits at 2×; never approached.
    if (pileCount(world) >= FOOD_PILE_SOFT_CEILING) return;
  }

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

    // PR 4 reachable-spawn invariant: a runtime pile may only land on a walkable
    // tile in the single connected surface component of the frozen terrain.
    // Subsumes the old HardBlock check (component membership excludes HardBlock).
    if (!isSurfaceTileInComponent(world, tileX, tileY)) continue;

    // Distance from every colony's entrances + rallyPoint, inlined so we
    // don't allocate a noGoTiles staging array per spawn call.
    let tooCloseToColony = false;
    for (const colony of colonies) {
      if (colony.entrances) {
        for (const e of colony.entrances) {
          if (
            Math.abs(tileX - e.surfaceTileX) + Math.abs(tileY - e.surfaceTileY) <
            FOOD_PILE_MIN_COLONY_DISTANCE
          ) {
            tooCloseToColony = true;
            break;
          }
        }
      }
      if (tooCloseToColony) break;
      if (colony.rallyPoint) {
        if (
          Math.abs(tileX - colony.rallyPoint.tileX) + Math.abs(tileY - colony.rallyPoint.tileY) <
          FOOD_PILE_MIN_COLONY_DISTANCE
        ) {
          tooCloseToColony = true;
          break;
        }
      }
    }
    if (tooCloseToColony) continue;

    // Distance from every existing pile.
    let tooCloseToExisting = false;
    const nPiles = pileCount(world);
    for (let o = 0; o < nPiles; o++) {
      const slot = pileSlotAt(world, o);
      if (
        Math.abs(tileX - pileTileX(world, slot)) + Math.abs(tileY - pileTileY(world, slot)) <
        FOOD_PILE_MIN_SEPARATION
      ) {
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
    // is dropped instead of poisoning the pile store silently.
    if (!Number.isInteger(pickups) || pickups <= 0) return;

    // Allocate entity ID — bail silently on exhaustion (#59 long-session guard).
    const newId = allocateEntityId(world);
    if (newId === INVALID_ENTITY_ID) return;

    // Cannot hit spawnPile's hard-cap refusal (which would burn `newId`): the
    // V37+ branch returned above when pileCount >= FOOD_PILE_HARD_CAP, and the
    // pre-V37 branch caps the total at FOOD_PILE_SOFT_CEILING (30) < HARD_CAP
    // (60). Keep those gates BEFORE allocateEntityId if this is ever reordered.
    spawnPile(world, newId, tileX, tileY, pickups * FOOD_PICKUP_AMOUNT, 0);
    return;
  }

  // Out of attempts — silently give up. Same behaviour as scenario.ts seeding
  // when the map is too crowded.
}
