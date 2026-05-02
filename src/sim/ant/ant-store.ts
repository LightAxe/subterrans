// ant-store.ts — PRD §1 Structure-of-Arrays (SoA) ant component storage.
//
// 22 parallel TypedArray fields indexed by EntityId — one slot per entity.
// Mostly Int32Array; Phase 09.1 Chunk 0 adds currentGridColonyId as Uint8Array
// (grid-of-occupancy byte, see field JSDoc below).
// All arrays are allocated once in createAntComponents and NEVER reallocated
// during the simulation tick loop (zero per-tick allocation in the ant subsystem).
//
// Field layout (PRD §1 verbatim + Phase 7 additions):
//   posX, posY           — fixed-point tile position (FP_ONE = 256)
//   colonyId             — owning colony entity ID
//   task                 — AntTask discriminant (raw int; caller may write AntTask.Foraging etc.)
//   subTask              — sub-state discriminant (ForagingSubState, NursingSubState, etc.)
//   speed                — movement speed in fixed-point units per tick
//   foodCarrying         — food units currently carried (fixed-point)
//   starvationTimer      — ticks since last fed (0 = not starving)
//   age                  — ticks alive
//   alive                — 1 = alive, 0 = dead/unused slot
//   lifespan             — ticks until natural death (WORKER_LIFESPAN_TICKS = INT32_MAX)
//
//   Phase 7 additions:
//   zone                 — Zone.Surface (0) or Zone.Underground (1); see Zone constants below
//   digTileX             — claimed dig tile X coordinate (-1 = no claimed tile)
//   digTileY             — claimed dig tile Y coordinate (-1 = no claimed tile)
//   digTicksRemaining    — ticks left to finish excavating claimed tile (0 = not digging)
//   targetPosX           — forager priority target X in fixed-point (-1 = no target)
//   targetPosY           — forager priority target Y in fixed-point (-1 = no target)
//
// Zone values (raw integers; do not import from terrain.ts to keep this a leaf module):
//   Zone.Surface     = 0
//   Zone.Underground = 1
//
// Entity IDs are increment-only per PRD §1/§3 — no recycling, no swap-remove here.
// Swap-remove / colony-bucket management is Plan 03.

import type { EntityId } from '../types.js';
import { AntTask } from '../enums.js';
import {
  MAX_ENTITIES,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../constants.js';

// ---------------------------------------------------------------------------
// AntComponents SoA interface (PRD §1 verbatim + Phase 7 fields)
// ---------------------------------------------------------------------------

export interface AntComponents {
  readonly posX:            Int32Array;
  readonly posY:            Int32Array;
  readonly colonyId:        Int32Array;
  readonly task:            Int32Array;
  readonly subTask:         Int32Array;
  readonly speed:           Int32Array;
  readonly foodCarrying:    Int32Array;
  readonly starvationTimer: Int32Array;
  readonly age:             Int32Array;
  readonly alive:           Int32Array;
  readonly lifespan:        Int32Array;
  // Phase 7 additions:
  /** Zone the ant is currently in: 0 = Surface, 1 = Underground. */
  readonly zone:              Int32Array;
  /** X coordinate of the dig tile claimed by this ant (-1 = none). */
  readonly digTileX:          Int32Array;
  /** Y coordinate of the dig tile claimed by this ant (-1 = none). */
  readonly digTileY:          Int32Array;
  /** Ticks remaining to finish excavating the claimed tile (0 = not digging). */
  readonly digTicksRemaining: Int32Array;
  /** Forager priority target X in fixed-point units (-1 = no target). */
  readonly targetPosX:        Int32Array;
  /** Forager priority target Y in fixed-point units (-1 = no target). */
  readonly targetPosY:        Int32Array;
  /**
   * 09 SearchingFood leash wave index (0..SEARCH_LEASH_MAX_WAVE). Zero = base
   * radius. Incremented when a SearchingFood ant is demoted for exceeding the
   * current wave's radius; reset to 0 on a successful pickup. Per-ant state
   * (not colony-memory) per the 09 digger-reassignment memo.
   */
  readonly searchWave:        Int32Array;
  /**
   * 09 excursion-foraging memo — persistent outbound heading X component for a
   * SearchingFood forager. One of {-1, 0, 1}. Zero paired with searchHeadingY=0
   * means "no active heading" (initial value, or just reset after pickup /
   * deposit / entrance return). chooseExcursionDirection derives or keeps
   * this heading to produce a correlated outward walk instead of per-tick
   * random cardinals. Per-ant state — no colony-memory.
   */
  readonly searchHeadingX:    Int32Array;
  /** Companion Y component to searchHeadingX. */
  readonly searchHeadingY:    Int32Array;
  /**
   * 09 excursion-foraging memo — ticks remaining on the current heading before
   * the next turn check. Counts down each chooseExcursionDirection call; on
   * reaching zero a small random turn may be rolled and the counter is reset.
   * Zero while heading is (0,0) means "pick a fresh heading now".
   */
  readonly searchHeadingTicks: Int32Array;
  /**
   * 09 excursion-foraging follow-up — tile X the ant occupied last tick
   * (before the current tile). Sentinel: -1 = no previous tile (fresh
   * promotion, post-pickup, post-deposit, entrance-return). Used by
   * sampleForagingDirection and hasNearbyPheromoneSignal to suppress
   * immediate reversal: a SearchingFood ant will not follow pheromone back
   * to the tile it just left unless no other signal is available. Per-ant
   * state — no colony-memory.
   */
  readonly searchPrevTileX: Int32Array;
  /** Companion Y component to searchPrevTileX. Sentinel: -1 = no previous tile. */
  readonly searchPrevTileY: Int32Array;
  /**
   * Issue #34 — Bresenham accumulator for cardinal-step axis selection.
   *
   * tickAntMovement translates an integer-tile target offset (rawDx, rawDy)
   * into a single cardinal step per tick. The previous "pick the larger of
   * |rawDx| and |rawDy|" rule produced visible stair-step on near-45° paths
   * because the leading axis would deplete before the other got a turn.
   * This field tracks per-ant minor-axis debt; each tick the major axis is
   * preferred unless the accumulated debt has crossed half the (major +
   * minor) sum, at which point the minor axis is taken once and the debt
   * rebated. At 45° (|rawDx| === |rawDy|) the result is strict alternation;
   * at other slopes the alternation is proportional.
   *
   * Reset to 0 in initAnt. Round-trips through copyWorldState and save/load
   * (optional field on SerializedAnts; defaults to 0 on pre-#34 saves).
   */
  readonly pathErr: Int32Array;
  /**
   * Issue #35 — pause-while-searching counter.
   *
   * SearchingFood ants periodically pause for 5–9 ticks (constants
   * SEARCH_PAUSE_BASE_TICKS=5 + jitter mod SEARCH_PAUSE_JITTER_TICKS=5,
   * exclusive) to mimic the scurry-stop-scurry pattern of real ants.
   * While `searchPauseTicks > 0`
   * the SearchingFood movement branch in tickAntMovement skips its step
   * and decrements the counter. Reset to 0 on every transition out of
   * SearchingFood (post-pickup, post-deposit) so the next excursion
   * starts with a clean cadence.
   *
   * Reset to 0 in initAnt. Round-trips through copyWorldState and save/load
   * (optional field; defaults to 0 on pre-#35 saves).
   */
  readonly searchPauseTicks: Int32Array;
  /**
   * Phase 09.1 Chunk 0 — grid-of-occupancy byte.
   *
   * Single source of truth for "which undergroundGrids[...] does this ant
   * occupy right now." Values are ColonyId (0=PLAYER, 1=ENEMY). Spawned via
   * `initAnt` with `currentGridColonyId[id] = spec.colonyId` (same-colony
   * invariant at spawn). Surface→Underground descent updates the field to
   * the entrance-owning colony (today always the ant's own colony). Chunks
   * 3+4 of 09.1 will break the `currentGridColonyId === colonyId` invariant
   * for Fighter invaders — that is the sole design intent of this field.
   *
   * Uint8Array (not Int32Array) — ColonyId is 0..255 (PRD §2 PLAYER=0,
   * ENEMY=1; one byte fits every foreseeable colony count). Keeps the
   * per-ant SoA footprint to +1 byte instead of +4.
   */
  readonly currentGridColonyId: Uint8Array;
  /**
   * Issue #27 — carrier wait flag. 1 = ant is in WaitingToDeposit state
   * (Foraging + CarryingFood + nowhere to deposit), 0 = normal. While set,
   * tickAntMovement skips the ant and tickForagerActions checks two wake
   * conditions: any FoodStorage chamber becomes depositable, OR the
   * entrance pool drops below BASE_FOOD_STORAGE_CAPACITY.
   *
   * Uint8Array: a single bit-state field, +1 byte per entity.
   *
   * Reset to 0 in initAnt. NOT cleared by killAnt (which only zeros
   * `alive`); the stale flag is never observed because every per-ant loop
   * gates on `alive[id] === 1` before reading task/subTask/waitingDeposit.
   * Entity IDs are monotonic (PRD §3 — no recycling), so the only paths
   * that reach this slot's storage again are inert reads guarded by the
   * alive check.
   *
   * Round-trips through copyWorldState and save/load. simVersion < 3 saves
   * load with the field absent → all-zero default (no ants in wait). The
   * wait-set code paths (antDepositFood enter, tickForagerActions wake) are
   * additionally gated on `world.simVersion >= 3`, so legacy replays never
   * mutate this field at runtime.
   */
  readonly waitingDeposit: Uint8Array;
  /**
   * Issue #42 — surface forager anti-eddy ring buffer. Records the last
   * RECENT_TILES_LEN tiles a surface SearchingFood ant moved INTO. The
   * step-picker filters candidates against this buffer so foragers cannot
   * loop in a small region near a saturated entrance pool.
   *
   * Active only when `world.simVersion >= 6 && zone === Surface && task ===
   * Foraging && subTask === SearchingFood`. Cleared on state change (subTask
   * flip, food pickup, zone flip). Pushed on every actual step (not on
   * pause ticks). If filtering eliminates every candidate, the ant pauses
   * for one tick and the buffer stays as-is.
   *
   * Layout: index = id * RECENT_TILES_LEN + slot. Each slot stores tx (or
   * SENTINEL_NO_TILE = -1 if unused). recentTilesY mirrors recentTilesX.
   * recentTilesHead[id] is the next-write slot (0..RECENT_TILES_LEN-1).
   *
   * Round-trips through copyWorldState and save/load (optional fields on
   * SerializedAnts; defaults to all-empty on pre-v6 saves).
   */
  readonly recentTilesX: Int32Array;
  readonly recentTilesY: Int32Array;
  readonly recentTilesHead: Uint8Array;
}

/**
 * Length of the per-ant recent-tiles ring buffer (issue #42). Four entries
 * is enough to break 2/3/4-cycle eddies but small enough that the per-ant
 * SoA cost stays at 4×Int32 + 4×Int32 + 1×byte = 33 bytes per ant.
 */
export const RECENT_TILES_LEN = 4 as const;

/** Sentinel for an unused slot in the recent-tiles ring buffer. */
export const RECENT_TILES_SENTINEL = -1 as const;

// ---------------------------------------------------------------------------
// Factory — allocates all 22 arrays once; zero per-tick allocation guaranteed
// ---------------------------------------------------------------------------

/**
 * Allocate the SoA TypedArrays of length `maxEntities`. Mostly Int32Array,
 * with a single Uint8Array for Phase 09.1 Chunk 0 `currentGridColonyId`.
 * All slots are zero-initialized by the TypedArray spec, with the exception of
 * digTileX, digTileY, targetPosX, targetPosY, searchPrevTileX, searchPrevTileY
 * which are filled with -1 (sentinel meaning "no claimed tile" / "no target" /
 * "no previous tile").
 * Call once at world creation — do NOT call again per tick.
 *
 * @param maxEntities - Number of entity slots to allocate. Defaults to MAX_ENTITIES (8192).
 */
export function createAntComponents(maxEntities: number = MAX_ENTITIES): AntComponents {
  const digTileX = new Int32Array(maxEntities);
  digTileX.fill(-1);
  const digTileY = new Int32Array(maxEntities);
  digTileY.fill(-1);
  const targetPosX = new Int32Array(maxEntities);
  targetPosX.fill(-1);
  const targetPosY = new Int32Array(maxEntities);
  targetPosY.fill(-1);
  const searchPrevTileX = new Int32Array(maxEntities);
  searchPrevTileX.fill(-1);
  const searchPrevTileY = new Int32Array(maxEntities);
  searchPrevTileY.fill(-1);
  // Issue #42 — recent-tiles ring buffer (RECENT_TILES_LEN entries per ant).
  // Initialize to RECENT_TILES_SENTINEL (-1) so freshly-spawned ants don't
  // inherit a phantom history of tile (0, 0).
  const recentTilesX = new Int32Array(maxEntities * RECENT_TILES_LEN);
  recentTilesX.fill(RECENT_TILES_SENTINEL);
  const recentTilesY = new Int32Array(maxEntities * RECENT_TILES_LEN);
  recentTilesY.fill(RECENT_TILES_SENTINEL);

  return {
    posX:            new Int32Array(maxEntities),
    posY:            new Int32Array(maxEntities),
    colonyId:        new Int32Array(maxEntities),
    task:            new Int32Array(maxEntities),
    subTask:         new Int32Array(maxEntities),
    speed:           new Int32Array(maxEntities),
    foodCarrying:    new Int32Array(maxEntities),
    starvationTimer: new Int32Array(maxEntities),
    age:             new Int32Array(maxEntities),
    alive:           new Int32Array(maxEntities),
    lifespan:        new Int32Array(maxEntities),
    // Phase 7 fields:
    zone:              new Int32Array(maxEntities), // zero = Surface (correct default)
    digTileX,
    digTileY,
    digTicksRemaining: new Int32Array(maxEntities), // zero = not digging (correct default)
    targetPosX,
    targetPosY,
    // Phase 9 SearchingFood leash:
    searchWave:        new Int32Array(maxEntities), // zero = base wave (correct default)
    // Phase 9 excursion-foraging memo — correlated outward walk heading:
    searchHeadingX:    new Int32Array(maxEntities), // zero = no heading yet
    searchHeadingY:    new Int32Array(maxEntities), // zero = no heading yet
    searchHeadingTicks:new Int32Array(maxEntities), // zero = re-roll heading now
    // Phase 9 excursion-foraging follow-up — per-ant anti-backtrack prev tile:
    searchPrevTileX,
    searchPrevTileY,
    // Issue #34 — Bresenham accumulator. Zero-init = "no debt yet."
    pathErr:           new Int32Array(maxEntities),
    // Issue #35 — pause-while-searching counter. Zero-init = "not paused."
    searchPauseTicks:  new Int32Array(maxEntities),
    // Phase 09.1 Chunk 0 — grid-of-occupancy byte (Uint8Array). Zero-init is
    // correct: PLAYER_COLONY_ID is conventionally 0; initAnt overwrites with
    // spec.colonyId at spawn.
    currentGridColonyId: new Uint8Array(maxEntities),
    // Issue #27 — carrier wait flag. Zero-init = "not waiting" (correct default).
    waitingDeposit: new Uint8Array(maxEntities),
    // Issue #42 — recent-tiles ring buffer. SENTINEL-filled = "no history."
    recentTilesX,
    recentTilesY,
    recentTilesHead: new Uint8Array(maxEntities),
  };
}

// ---------------------------------------------------------------------------
// InitAntSpec — initialization spec for a single ant entity
// ---------------------------------------------------------------------------

/**
 * Spec passed to initAnt. Required fields: colonyId, posX, posY.
 * Optional fields default to simulation baseline values if omitted.
 */
export interface InitAntSpec {
  colonyId: number;
  posX:     number;
  posY:     number;
  /** Raw task discriminant. Defaults to AntTask.Idle (0). */
  task?:    number;
  /** Raw sub-task discriminant. Defaults to 0. */
  subTask?: number;
  /** Fixed-point speed. Defaults to WORKER_BASE_SPEED (128 = 0.5 × FP_ONE). */
  speed?:   number;
  /** Fixed-point lifespan ticks. Defaults to WORKER_LIFESPAN_TICKS (INT32_MAX). */
  lifespan?: number;
  /**
   * Zone the ant starts in. 0 = Surface (default), 1 = Underground.
   * Corresponds to Zone.Surface and Zone.Underground in terrain.ts.
   */
  zone?: number;
}

// ---------------------------------------------------------------------------
// Lifecycle helpers — O(1), no allocation
// ---------------------------------------------------------------------------

/**
 * Initialize entity slot `id` with the given spec.
 * Sets alive=1, age=0, foodCarrying=0, starvationTimer=0.
 * Phase 7 fields are reset to their sentinel defaults (zone=0, digTileX=-1, etc.).
 * Calling twice on the same id overwrites (no accumulation).
 */
export function initAnt(ants: AntComponents, id: EntityId, spec: InitAntSpec): void {
  ants.colonyId[id]        = spec.colonyId;
  // Phase 09.1 Chunk 0 — grid-of-occupancy matches owning colony at spawn.
  // Invariant: currentGridColonyId[id] === colonyId[id] for every ant,
  // until Chunks 3+4 land Fighter cross-grid invasion. See
  // 09.1-00-PLAN.md objective block.
  ants.currentGridColonyId[id] = spec.colonyId;
  ants.posX[id]            = spec.posX;
  ants.posY[id]            = spec.posY;
  ants.task[id]            = spec.task     !== undefined ? spec.task     : AntTask.Idle;
  ants.subTask[id]         = spec.subTask  !== undefined ? spec.subTask  : 0;
  ants.speed[id]           = spec.speed    !== undefined ? spec.speed    : WORKER_BASE_SPEED;
  ants.lifespan[id]        = spec.lifespan !== undefined ? spec.lifespan : WORKER_LIFESPAN_TICKS;
  ants.alive[id]           = 1;
  ants.age[id]             = 0;
  ants.foodCarrying[id]    = 0;
  ants.starvationTimer[id] = 0;
  // Phase 7 fields:
  ants.zone[id]              = spec.zone !== undefined ? spec.zone : 0;
  ants.digTileX[id]          = -1;
  ants.digTileY[id]          = -1;
  ants.digTicksRemaining[id] = 0;
  ants.targetPosX[id]        = -1;
  ants.targetPosY[id]        = -1;
  ants.searchWave[id]        = 0;
  ants.searchHeadingX[id]    = 0;
  ants.searchHeadingY[id]    = 0;
  ants.searchHeadingTicks[id]= 0;
  ants.searchPrevTileX[id]   = -1;
  ants.searchPrevTileY[id]   = -1;
  // Issue #34 — fresh ant has no path-error debt.
  ants.pathErr[id]           = 0;
  // Issue #35 — fresh ant is not paused.
  ants.searchPauseTicks[id]  = 0;
  // Issue #27 — fresh ant is never in wait state (must traverse a failed
  // deposit cycle to enter it).
  ants.waitingDeposit[id]    = 0;
  // Issue #42 — fresh ant has no recent-tile history.
  const base = id * RECENT_TILES_LEN;
  for (let s = 0; s < RECENT_TILES_LEN; s++) {
    ants.recentTilesX[base + s] = RECENT_TILES_SENTINEL;
    ants.recentTilesY[base + s] = RECENT_TILES_SENTINEL;
  }
  ants.recentTilesHead[id]   = 0;
}

// ---------------------------------------------------------------------------
// Recent-tiles ring buffer helpers (issue #42)
// ---------------------------------------------------------------------------

/**
 * Push a tile onto ant `id`'s recent-tiles ring buffer. Slot at
 * `recentTilesHead[id]` is overwritten; head advances mod RECENT_TILES_LEN.
 *
 * Caller is responsible for gating: only call on actual movement (not on
 * pause ticks) and only when world.simVersion >= 6 + Surface SearchingFood.
 */
export function pushRecentTile(
  ants: AntComponents,
  id: EntityId,
  tx: number,
  ty: number,
): void {
  const slot = ants.recentTilesHead[id]!;
  const idx  = id * RECENT_TILES_LEN + slot;
  ants.recentTilesX[idx] = tx;
  ants.recentTilesY[idx] = ty;
  ants.recentTilesHead[id] = (slot + 1) % RECENT_TILES_LEN;
}

/**
 * True iff (tx, ty) appears anywhere in ant `id`'s recent-tiles ring buffer.
 * Cheap linear scan — RECENT_TILES_LEN is 4.
 */
export function isRecentTile(
  ants: AntComponents,
  id: EntityId,
  tx: number,
  ty: number,
): boolean {
  const base = id * RECENT_TILES_LEN;
  for (let s = 0; s < RECENT_TILES_LEN; s++) {
    if (ants.recentTilesX[base + s] === tx && ants.recentTilesY[base + s] === ty) return true;
  }
  return false;
}

/** Reset ant `id`'s recent-tiles ring buffer to sentinels. */
export function clearRecentTiles(ants: AntComponents, id: EntityId): void {
  const base = id * RECENT_TILES_LEN;
  for (let s = 0; s < RECENT_TILES_LEN; s++) {
    ants.recentTilesX[base + s] = RECENT_TILES_SENTINEL;
    ants.recentTilesY[base + s] = RECENT_TILES_SENTINEL;
  }
  ants.recentTilesHead[id] = 0;
}

/**
 * Mark entity `id` as dead. O(1) — no array mutation, no swap-remove.
 * The colony-bucket system (Plan 03) handles slot reuse.
 */
export function killAnt(ants: AntComponents, id: EntityId): void {
  ants.alive[id] = 0;
}

/**
 * Returns true if the entity at `id` is currently alive.
 * Returns false for never-initialized slots (alive[id] === 0 by default).
 */
export function isAlive(ants: AntComponents, id: EntityId): boolean {
  return ants.alive[id] === 1;
}
