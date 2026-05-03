// src/sim/types.ts
// WorldState snapshot interface, factory, copy, and entity ID allocator.
// PRD §1/§3 authoritative shape.
// Phase 5 scope: four fields (tick, rngState, nextEntityId, commandQueue).
// Phase 6 adds ants (AntComponents), colonies (Record<ColonyId, ColonyRecord>),
// pheromoneGrids (Record<string, PheromoneGrid>).
// Phase 7 adds terrain (surface, undergroundGrids), foodPiles, pendingChambers.
import type { SimCommand } from './commands.js';
import type { AntComponents } from './ant/ant-store.js';
import { createAntComponents } from './ant/ant-store.js';
import type { ColonyId, ColonyRecord } from './colony/colony-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { PheromoneGrid } from './pheromone/pheromone-store.js';
import { createPheromoneGrid } from './pheromone/pheromone-store.js';
import type { SurfaceGrid, UndergroundGrid } from './terrain.js';
import { createSurfaceGrid, createUndergroundGrid } from './terrain.js';
import type { FoodPile } from './food.js';
import type { PendingChamber } from './colony/chamber.js';
import { MAX_ENTITIES, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';

export type EntityId = number; // incrementing counter from 0, no recycling per PRD §1/§3

/**
 * Sim-behavior version. Independent of SAVE_FORMAT_VERSION (which gates the
 * on-disk envelope shape). simVersion gates determinism-affecting algorithm
 * changes that DON'T change the snapshot shape — old saves still load fine,
 * but replay using the algorithm they were recorded under.
 *
 * v2 (LEGACY_SIM_VERSION) — issue #15 baseline. withdrawFood drains
 * FoodStorage chambers in colony.chambers array order; no carrier
 * WaitingToDeposit state. 4-connected ant movement (cardinal-only steps).
 *
 * v3 — issue #27 fix. withdrawFood drains the fullest FoodStorage chamber
 * first (array-index tie-break); carriers enter WaitingToDeposit when
 * storage is fully saturated. Movement remains 4-connected.
 *
 * v4 — issue #34 follow-up. 8-connected ant movement:
 * pickStep can return diagonal cardinals when both axes have remaining
 * work, with corner-cut prevention requiring at least one of the two
 * intermediate cardinal tiles to be passable. Underground flow-field
 * consumers also peek at the next tile's direction and combine into a
 * diagonal step when the next-tile flow is perpendicular. Diagonal moves
 * traverse √2× cardinal Manhattan distance per tick — standard 8-connected
 * speed semantics.
 *
 * v5 (LATEST_SIM_VERSION) — issue #38. PlaceChamber accepts anchors on
 * Solid or Marked tiles in addition to Open. The handler auto-marks any
 * Solid tile in the chamber footprint and runs a reachability BFS from
 * the colony's entrances through Open + Marked + BeingDug + the new
 * footprint; placements that wouldn't be reachable after all current
 * digs complete are rejected. Pre-v5 saves keep the strict-Open anchor
 * + Solid-4-neighbor-required gates so SCEN-06 replays of recorded
 * commands stay byte-identical.
 *
 * Saves missing the `simVersion` field load with LEGACY_SIM_VERSION (sticky).
 * New worlds (createWorldState) start at LATEST_SIM_VERSION. Sticky on load
 * preserves SCEN-06 replay determinism — a save recorded before a given
 * fix keeps producing identical ticks across reload under the old algorithm.
 */
export const LEGACY_SIM_VERSION = 2 as const;
export const SIM_VERSION_V3 = 3 as const;
export const SIM_VERSION_V4_DIAGONAL_MOTION = 4 as const;
export const SIM_VERSION_V5_CHAMBER_ON_MARKED = 5 as const;
export const SIM_VERSION_V6_FORAGER_NO_REVISIT = 6 as const;
/**
 * v7 — issue #44 steps 4 + 5. Surface movement integration: HardBlock
 * features (boulders, twig-as-log, dead-leaf canopies, big-leaf "ships")
 * block surface ants and a deterministic local detour picks the best
 * walkable adjacent tile when the preferred step is blocked; SoftCost
 * features (bushes, grass clumps) halve effective speed (`speed >> 1`,
 * min 1) for the tick the ant occupies a SoftCost tile — integer-only,
 * no float math, no new RNG pulls. Pre-v7 saves replay with no surface
 * passability and no soft cost — same coordinate-only motion they
 * recorded — so SCEN-06 byte-identity holds.
 *
 * Originally landed as v6 on the #44 branch; renumbered to v7 during
 * the rebase onto main once #42 (PR #47) had already taken v6.
 */
export const SIM_VERSION_V7_SURFACE_PASSABILITY = 7 as const;
/**
 * v8 (LATEST_SIM_VERSION) — issue #44 UAT round 3. Three converging
 * fixes for stuck/eddied surface foragers, all gated together:
 *
 *   (a) Leash-boundary hysteresis. The SearchingFood→ReturningToNest
 *       demotion still fires at `dist > SEARCH_LEASH_RADII[wave]`
 *       (unchanged), but the inverse ReturningToNest→SearchingFood
 *       breakout now also requires `dist <= radius -
 *       LEASH_HYSTERESIS_TILES` before any AMBIENT food signal can
 *       pull the ant back out. Player-marked priority piles bypass
 *       the deadband. Pre-v8 the symmetric signal-only breakout
 *       produced per-tick flip-flops at the radius boundary that wiped
 *       the issue-#42 recent-tiles ring buffer.
 *
 *   (b) Detour recent-tile fallback. `pickSurfaceDetour` now falls
 *       back to the best RECENT tile when every walkable neighbour
 *       has been recently visited, instead of returning (0, 0) and
 *       deadlocking the ant. The fallback step pushes a new ring-
 *       buffer entry, eventually rotating the original blocker out.
 *       Pre-v8 the picker hard-rejected recent tiles, stranding ants
 *       in one-way pockets around HardBlock features.
 *
 *   (c) Surface-feature shadow correctness. `isAnchorSuppressedByOverlap`
 *       now also rejects suppressors that themselves sit inside an
 *       entrance/food gameplay-suppression zone — pre-v8 a higher-
 *       priority anchor that would never render still cast an empty
 *       halo around the suppression zone, hiding lower-priority
 *       anchors that should have surfaced.
 *
 * Pre-v8 saves replay all three behaviours unchanged for SCEN-06
 * byte-identity.
 */
export const SIM_VERSION_V8_LEASH_HYSTERESIS = 8 as const;
export const SIM_VERSION_V9_CANCEL_DROPS_PENDING = 9 as const;
export const SIM_VERSION_V10_VISIBLE_BROOD_CARRY = 10 as const;
export const LATEST_SIM_VERSION = SIM_VERSION_V10_VISIBLE_BROOD_CARRY;

export interface WorldState {
  tick: number;             // 0 at creation; incremented once per tick
  rngState: number;         // Mulberry32 state (uint32); initialized from seed
  nextEntityId: EntityId;   // starts at 0 (PRD §3); allocateEntityId returns current and post-increments
  commandQueue: SimCommand[]; // staging seam — drained by platform accumulator between ticks

  /**
   * Sim behavior version — gates determinism-affecting algorithm changes that
   * post-date issue #27 (carrier-oscillation fix). Sticky on load: a save
   * recorded at version N replays at version N regardless of the current
   * latest. New worlds use the latest version (LATEST_SIM_VERSION).
   *
   * Versions:
   *   2 = pre-fix array-order withdrawFood drain (issue #15 baseline);
   *       legacy greedy major-axis cardinal step movement.
   *   3 = drain-fullest-first withdrawFood + carrier WaitingToDeposit state;
   *       still legacy greedy 4-connected cardinal movement.
   *   4 = 8-connected diagonal ant movement (issue #34) + scurry-stop-scurry
   *       SearchingFood pause cadence (issue #35). The pause block consumes
   *       additional RNG pulls per tick, so v3 saves stay on the no-pause
   *       path forever to keep replay byte-identical.
   *   5 = PlaceChamber accepts Solid/Marked anchors with reachability check
   *       and auto-marks Solid footprint tiles (issue #38). Pre-v5 saves keep
   *       the strict-Open-anchor + Solid-4-neighbor gates so any v5-only
   *       commands that may sit in their inputLog stay rejected on replay.
   *   6 = Three early-game-pool fixes (issue #42): partial-deposit wait gate
   *       sets waitingDeposit=1 on leftover food; SearchingFood foragers
   *       demote to Idle when colony has nowhere to deposit; surface
   *       SearchingFood foragers refuse to step onto a tile from their
   *       last 4 moves (eddy escape). Pre-v6 saves keep the legacy paths.
   *   7 = Surface movement integration (issue #44 steps 4 + 5):
   *       (a) HardBlock features (boulders, twig-as-log, dead leaves, big
   *           leaves) block surface ants; deterministic local detour picks
   *           an alternate adjacent tile when the preferred step is blocked.
   *       (b) SoftCost features (bushes, grass clumps) halve the effective
   *           speed of any surface ant occupying a SoftCost tile.
   *       Pre-v7 saves replay with no surface passability and no soft cost
   *       — same coordinate-only motion they recorded.
   *   8 = Issue #44 UAT round 3 — three converging surface-forager
   *       fixes:
   *       (a) Leash-boundary hysteresis. The RTN→SF breakout in
   *           tickExcursionBoundary requires `dist <= radius -
   *           LEASH_HYSTERESIS_TILES` for AMBIENT signals (priority
   *           piles bypass).
   *       (b) Detour recent-tile fallback. pickSurfaceDetour falls
   *           back to the best recent tile when every walkable
   *           neighbour is recent — kills permanent deadlocks in
   *           one-way pockets around HardBlock features.
   *       (c) Surface-feature shadow correctness. Suppressors inside
   *           a gameplay-suppression zone no longer cast an empty
   *           halo over lower-priority anchors outside the zone.
   *       Pre-v8 saves keep the original behaviours for byte-identity.
   *   9 = Issue #54 — CancelDigMark on a tile inside a pending chamber's
   *       footprint drops the pending chamber entry (and reverts any
   *       remaining Marked footprint tiles to Solid). Pre-v9, the
   *       pending chamber stayed orphaned forever — for unique chamber
   *       types like Queen, both gates that scan `world.pendingChambers`
   *       (the underground context-menu Queen filter in
   *       `context-menu-layout.ts:hasPendingChamber` and the
   *       PlaceChamber Queen-uniqueness rule in `tick.ts`) stayed
   *       tripped, soft-locking re-placement. Pre-v9 saves replay
   *       byte-identical with the orphan-on-cancel behaviour.
   *  10 = Issue #17 Phase 1 — visible brood carry. Nurses pathfind to
   *       a brood entity (egg or larva) inside a Queen chamber, pick
   *       it up (sets `carryingBroodId` on the nurse and `carriedBy`
   *       on the brood), walk it to a Nursery Open tile, and deposit.
   *       Pre-v10 the `Feeding` substate ran the instant teleport in
   *       `transportBroodToNursery`. Pre-v10 saves replay byte-
   *       identically with the teleport behaviour. With no Nursery,
   *       no carry happens and brood sits where laid (matches pre-v10
   *       teleport-gate behaviour).
   *
   * Round-trips through copyWorldState and save/load.
   */
  simVersion: number;

  /**
   * Issue #44 — terrain decoration seed. Independent of `rngState` so that
   * decoration layout stays stable across the lifetime of a world: rngState
   * advances every tick as the sim consumes random pulls, and a layout that
   * drifted with it would shift mid-game.
   *
   * Folded into the surface feature selector's spatial hash
   * (`src/sim/surface-features.ts`) so different game seeds produce
   * different boulder/grass layouts. Pre-#44 placement was coordinate-only
   * — every world looked identical from above.
   *
   * Initialized in `createWorldState(seed)` via a fixed mixer of the input
   * seed (so it's a deterministic function of the seed but doesn't equal
   * `rngState`). Round-trips through `copyWorldState` and save/load. Legacy
   * saves missing the field load with `terrainSeed = 0`; this changes their
   * decoration layout on first reload but not their world geometry.
   */
  terrainSeed: number;

  // Phase 6 additions (PRD §3):
  ants: AntComponents;                          // SoA ant component storage — 17 parallel Int32Arrays
  colonies: Record<ColonyId, ColonyRecord>;     // per-colony state keyed by integer ColonyId
  pheromoneGrids: Record<string, PheromoneGrid>; // pheromone intensity grids keyed by pheromoneGridKey()

  // Phase 7 additions (PRD §2e):
  surface: SurfaceGrid;                                    // shared surface terrain (SURF-01)
  undergroundGrids: Record<ColonyId, UndergroundGrid>;     // per-colony underground (UNDR-08)
  foodPiles: FoodPile[];                                   // static food sources on surface (SURF-02)
  pendingChambers: Record<string, PendingChamber>;         // keyed by `${colonyId}:${anchorTileX}:${anchorTileY}` (PRD §2d)
}

/**
 * Create a fresh WorldState with zero-initialised Phase 6 stores.
 *
 * @param seed        - Mulberry32 seed (uint32 coerced via >>> 0).
 * @param maxEntities - Ant entity slot count. Defaults to MAX_ENTITIES (8192).
 */
export function createWorldState(seed: number, maxEntities: number = MAX_ENTITIES): WorldState {
  const seedU32 = seed >>> 0;
  return {
    tick: 0,
    rngState: seedU32,
    nextEntityId: 0,      // PRD §3 line 130: starts at 0, no recycling
    commandQueue: [],
    simVersion: LATEST_SIM_VERSION,
    // Issue #44 — derive terrainSeed from the input seed via Knuth's golden-
    // ratio multiplier so it's a deterministic function of the seed but
    // doesn't equal rngState. Using rngState directly would couple the very-
    // first decoration query to wherever the PRNG happens to land on tick 0.
    terrainSeed: Math.imul(seedU32, 2654435761) >>> 0,
    ants: createAntComponents(maxEntities),
    colonies: {},
    pheromoneGrids: {},
    // Phase 7 defaults:
    surface: createSurfaceGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT),
    undergroundGrids: {},
    foodPiles: [],
    pendingChambers: {},    // empty Record; PlaceChamberCommand creates entries
  };
}

/**
 * Copy src into dst in place — double-buffer swap for render interpolation (PRD §1/§3).
 *
 * Steady-state: zero allocations after colonies and grids populated.
 * Allocation occurs only when the set of colony keys or grid keys grows.
 *
 * Ordered operations per PRD §3 line 566:
 *   1. Scalar fields (tick, rngState, nextEntityId)
 *   2. commandQueue — slice() (only allocation in the command path per PRD §3)
 *   3. AntComponents — 11 TypedArray.set calls (zero allocation)
 *   4. colonies — delete stale dst keys; upsert each src colony field-by-field
 *   5. pheromoneGrids — delete stale dst keys; upsert each src grid via Int32Array.set
 */
export function copyWorldState(src: WorldState, dst: WorldState): void {
  // --- Phase 5 scalar fields ---
  dst.tick = src.tick;
  dst.rngState = src.rngState;
  dst.nextEntityId = src.nextEntityId;
  dst.simVersion = src.simVersion;
  dst.terrainSeed = src.terrainSeed;
  dst.commandQueue = src.commandQueue.slice(); // small in practice (user-input rate) — PRD §3 accepts this as the only Phase 1 allocation

  // --- AntComponents: 19 TypedArray.set calls (zero allocation) ---
  dst.ants.posX.set(src.ants.posX);
  dst.ants.posY.set(src.ants.posY);
  dst.ants.colonyId.set(src.ants.colonyId);
  dst.ants.task.set(src.ants.task);
  dst.ants.subTask.set(src.ants.subTask);
  dst.ants.speed.set(src.ants.speed);
  dst.ants.foodCarrying.set(src.ants.foodCarrying);
  dst.ants.starvationTimer.set(src.ants.starvationTimer);
  dst.ants.age.set(src.ants.age);
  dst.ants.alive.set(src.ants.alive);
  dst.ants.lifespan.set(src.ants.lifespan);
  // Phase 7 ant fields:
  dst.ants.zone.set(src.ants.zone);
  dst.ants.digTileX.set(src.ants.digTileX);
  dst.ants.digTileY.set(src.ants.digTileY);
  dst.ants.digTicksRemaining.set(src.ants.digTicksRemaining);
  dst.ants.targetPosX.set(src.ants.targetPosX);
  dst.ants.targetPosY.set(src.ants.targetPosY);
  // Phase 9 / 09 digger-reassignment memo — per-ant SearchingFood leash wave.
  dst.ants.searchWave.set(src.ants.searchWave);
  // Phase 9 / 09 excursion-foraging memo — correlated outward walk heading.
  dst.ants.searchHeadingX.set(src.ants.searchHeadingX);
  dst.ants.searchHeadingY.set(src.ants.searchHeadingY);
  dst.ants.searchHeadingTicks.set(src.ants.searchHeadingTicks);
  // Phase 9 / 09 excursion-foraging follow-up — per-ant anti-backtrack prev
  // tile. Live state read by sampleForagingDirection + hasNearbyPheromoneSignal,
  // so the render snapshot MUST round-trip it (previously dropped → the
  // interpolated prev frame looked "fresh" every tick and broke anti-backtrack
  // diagnostics / replay determinism boundary).
  dst.ants.searchPrevTileX.set(src.ants.searchPrevTileX);
  dst.ants.searchPrevTileY.set(src.ants.searchPrevTileY);
  // Phase 09.1 Chunk 0 — grid-of-occupancy byte. MUST round-trip through the
  // double-buffer so every prev-frame grid lookup sees the same value as the
  // current frame. See 09.1-00-PLAN.md Task 2.
  dst.ants.currentGridColonyId.set(src.ants.currentGridColonyId);
  // Issue #27 — carrier wait flag. Round-trips so render's interpolated frame
  // sees the same wait state as the current frame, and so SCEN-06 replay
  // determinism is preserved across save/reload boundaries.
  dst.ants.waitingDeposit.set(src.ants.waitingDeposit);
  // Issue #34 — Bresenham accumulator and #35 — pause counter. Both round-
  // trip for SCEN-06 replay determinism (same seed + commands → same
  // step pattern + pause schedule).
  dst.ants.pathErr.set(src.ants.pathErr);
  dst.ants.searchPauseTicks.set(src.ants.searchPauseTicks);
  // Issue #42 — recent-tiles ring buffer. The buffer is read by the v6
  // forager step-picker, so it must round-trip for replay determinism.
  dst.ants.recentTilesX.set(src.ants.recentTilesX);
  dst.ants.recentTilesY.set(src.ants.recentTilesY);
  dst.ants.recentTilesHead.set(src.ants.recentTilesHead);
  // Issue #17 Phase 1 — brood carry slot + reverse pointer. Both round-trip
  // because the v10 nurse state machine reads them every tick.
  dst.ants.carryingBroodId.set(src.ants.carryingBroodId);
  dst.ants.carriedBy.set(src.ants.carriedBy);

  // --- colonies: delete stale dst keys; upsert each src colony ---
  // Remove dst colonies that no longer exist in src
  for (const key in dst.colonies) {
    if (!(key in src.colonies)) {
      delete dst.colonies[key as unknown as ColonyId];
    }
  }

  for (const key in src.colonies) {
    const colonyId = key as unknown as ColonyId;
    const s = src.colonies[colonyId]!;

    // Create dst colony if absent (allocates once per colony, zero in steady state)
    if (!(colonyId in dst.colonies)) {
      dst.colonies[colonyId] = createColonyRecord(s.colonyId, s.queenEntityId);
      // Phase 3 PRD §2a caller-side extension defaults (factory does not set these):
      const fresh = dst.colonies[colonyId]!;
      fresh.entrances         = [];
      fresh.rallyPoint        = null;
      fresh.digFlowFieldDirty = false;
      fresh.foodFlowFieldDirty = false;
      fresh.killCount         = 0;
      fresh.priorityFoodPileId = null;
    }
    const d = dst.colonies[colonyId]!;

    // Scalar fields — direct assignment
    d.colonyId             = s.colonyId;
    d.queenEntityId        = s.queenEntityId;
    d.queenStarvationTimer = s.queenStarvationTimer;
    d.foodStored           = s.foodStored;
    d.workerCount          = s.workerCount;
    d.eggCount             = s.eggCount;
    d.larvaeCount          = s.larvaeCount;
    d.nurseCount           = s.nurseCount;
    d.defeated             = s.defeated;
    d.reconcileCountdown   = s.reconcileCountdown;
    d.killCount            = s.killCount;
    d.priorityFoodPileId   = s.priorityFoodPileId;

    // Bucket arrays — reuse via length truncation + index copy (no new array)
    d.eggs.length = s.eggs.length;
    for (let i = 0; i < s.eggs.length; i++) {
      d.eggs[i] = s.eggs[i]!;
    }

    d.larvae.length = s.larvae.length;
    for (let i = 0; i < s.larvae.length; i++) {
      d.larvae[i] = s.larvae[i]!;
    }

    d.workers.length = s.workers.length;
    for (let i = 0; i < s.workers.length; i++) {
      d.workers[i] = s.workers[i]!;
    }

    // chambers — nested ChamberRecord objects: pop/push(Object.assign) for reuse
    while (d.chambers.length > s.chambers.length) {
      d.chambers.pop();
    }
    for (let i = 0; i < s.chambers.length; i++) {
      if (i < d.chambers.length) {
        // Reuse existing object — Object.assign preserves object identity for test assertions
        Object.assign(d.chambers[i]!, s.chambers[i]!);
      } else {
        // Grow: push a fresh copy of the source chamber
        d.chambers.push(Object.assign({}, s.chambers[i]!));
      }
    }

    // Nested plain-object fields — field-by-field copy (NOT spread — preserves object identity)
    // Phase 10 (CTRL-01'): targetRatio is two-field {forage, fight}. WorkerAllocation
    // (computedAllocation, taskCensus) keeps its `dig` slot per D-03 — auto-dig writes it.
    d.targetRatio.forage           = s.targetRatio.forage;
    d.targetRatio.fight            = s.targetRatio.fight;

    d.computedAllocation.nurse     = s.computedAllocation.nurse;
    d.computedAllocation.forage    = s.computedAllocation.forage;
    d.computedAllocation.dig       = s.computedAllocation.dig;
    d.computedAllocation.fight     = s.computedAllocation.fight;

    d.taskCensus.nurse             = s.taskCensus.nurse;
    d.taskCensus.forage            = s.taskCensus.forage;
    d.taskCensus.dig               = s.taskCensus.dig;
    d.taskCensus.fight             = s.taskCensus.fight;

    // Phase 3 extension fields — typed copies (no `as any` — fields are required on interface)

    // entrances — reuse dst array, truncate/extend, field-by-field copy each NestEntrance
    while (d.entrances.length > s.entrances.length) d.entrances.pop();
    for (let i = 0; i < s.entrances.length; i++) {
      if (i < d.entrances.length) {
        Object.assign(d.entrances[i]!, s.entrances[i]!);
      } else {
        d.entrances.push(Object.assign({}, s.entrances[i]!));
      }
    }

    // rallyPoint — null-aware copy (avoid object churn when both sides are already null or both are objects)
    if (s.rallyPoint === null) {
      d.rallyPoint = null;
    } else if (d.rallyPoint === null) {
      d.rallyPoint = { tileX: s.rallyPoint.tileX, tileY: s.rallyPoint.tileY };
    } else {
      d.rallyPoint.tileX = s.rallyPoint.tileX;
      d.rallyPoint.tileY = s.rallyPoint.tileY;
    }

    // digFlowFieldDirty — boolean assignment
    d.digFlowFieldDirty = s.digFlowFieldDirty;
    // foodFlowFieldDirty (issue #15) — boolean assignment
    d.foodFlowFieldDirty = s.foodFlowFieldDirty;
  }

  // --- pheromoneGrids: delete stale dst keys; upsert each src grid ---
  for (const key in dst.pheromoneGrids) {
    if (!(key in src.pheromoneGrids)) {
      delete dst.pheromoneGrids[key];
    }
  }

  for (const key in src.pheromoneGrids) {
    const srcGrid = src.pheromoneGrids[key]!;

    // Create dst grid if absent (allocates once per grid, zero in steady state)
    if (!(key in dst.pheromoneGrids)) {
      dst.pheromoneGrids[key] = createPheromoneGrid(srcGrid.width, srcGrid.height);
    }
    const dstGrid = dst.pheromoneGrids[key]!;

    // Int32Array.set — zero allocation
    dstGrid.data.set(srcGrid.data);
  }

  // --- Phase 7: surface grid ---
  // Uint8Array.set — zero allocation; dimensions are fixed at world creation
  dst.surface.data.set(src.surface.data);

  // --- Phase 7: undergroundGrids — same delete-stale + upsert pattern as pheromoneGrids ---
  for (const key in dst.undergroundGrids) {
    if (!(key in src.undergroundGrids)) {
      delete dst.undergroundGrids[key as unknown as ColonyId];
    }
  }
  for (const key in src.undergroundGrids) {
    const colonyId = key as unknown as ColonyId;
    const srcGrid = src.undergroundGrids[colonyId]!;
    if (!(colonyId in dst.undergroundGrids)) {
      dst.undergroundGrids[colonyId] = createUndergroundGrid(srcGrid.width, srcGrid.height);
    }
    dst.undergroundGrids[colonyId]!.data.set(srcGrid.data);
  }

  // --- Phase 7: foodPiles — length-adjust + field-by-field copy (reuse objects in steady state) ---
  while (dst.foodPiles.length > src.foodPiles.length) dst.foodPiles.pop();
  for (let i = 0; i < src.foodPiles.length; i++) {
    if (i < dst.foodPiles.length) {
      Object.assign(dst.foodPiles[i]!, src.foodPiles[i]!);
    } else {
      dst.foodPiles.push(Object.assign({}, src.foodPiles[i]!));
    }
  }

  // --- Phase 7: pendingChambers — same delete-stale + upsert pattern as pheromoneGrids ---
  for (const key in dst.pendingChambers) {
    if (!(key in src.pendingChambers)) {
      delete dst.pendingChambers[key];
    }
  }
  for (const key in src.pendingChambers) {
    if (!(key in dst.pendingChambers)) {
      dst.pendingChambers[key] = Object.assign({}, src.pendingChambers[key]!);
    } else {
      Object.assign(dst.pendingChambers[key]!, src.pendingChambers[key]!);
    }
  }
}

/** Allocate a fresh entity ID. No recycling (PRD §1/§3 incrementing counter). */
export function allocateEntityId(world: WorldState): EntityId {
  const id = world.nextEntityId;
  world.nextEntityId = id + 1;
  return id;
}
