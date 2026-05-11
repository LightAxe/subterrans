// src/platform/save.ts
// Phase 9 / SCEN-04 + SCEN-06 — browser-localStorage session persistence.
// Envelope shape (PRD §8a, 04-PRD-playable-game-loop.md):
//   SaveFile = { version, seed, inputLog, snapshot }
// Strict rules:
//   1. ALL TypedArrays serialized via Array.from (JSON.stringify emits "{}" for TAs — Pitfall 2)
//   2. commandQueue IS preserved in snapshot (Pitfall 7 — autosave fires wall-clock, not tick boundary)
//   3. seed + inputLog preserved at envelope top-level (SCEN-06 replay truth)
//   4. ViewState (PRD §8e) is OUT OF SCOPE — only pure WorldState fields
//   5. colonies / undergroundGrids / pendingChambers / pheromoneGrids are PLAIN OBJECTS (ADR-0006)
//      Iterate via Object.entries — NEVER Array.from(world.colonies.entries()) [there is no .entries()]
//   6. Version-gated: bumping SAVE_FORMAT_VERSION invalidates old saves (intentional for beta)

import type { WorldState, EntityId } from '../sim/types.js';
import { LEGACY_SIM_VERSION, LATEST_SIM_VERSION } from '../sim/types.js';
import type { AntComponents } from '../sim/ant/ant-store.js';
import { createAntComponents } from '../sim/ant/ant-store.js';
import type {
  ColonyId, ColonyRecord, WorkerAllocation, BehaviorRatio, ChamberRecord,
} from '../sim/colony/colony-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import type { PendingChamber } from '../sim/colony/chamber.js';
import type { SimCommand } from '../sim/commands.js';
import type { SurfaceGrid, UndergroundGrid } from '../sim/terrain.js';
import { createSurfaceGrid, createUndergroundGrid } from '../sim/terrain.js';
import type { PheromoneGrid } from '../sim/pheromone/pheromone-store.js';
import { createPheromoneGrid } from '../sim/pheromone/pheromone-store.js';
import type { DepletionRecord, FoodPile, FoodPileId } from '../sim/food.js';
import {
  MAX_ENTITIES,
  FOOD_PILE_COUNT,
  FOOD_PILE_INITIAL_PICKUPS_MIN,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_SOFT_CEILING,
  FOOD_CHAMBER_CAPACITY,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  PLAYER_COLONY_ID,
} from '../sim/constants.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { ChamberType } from '../sim/enums.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';

// SAVE_FORMAT_VERSION is bumped on any breaking change to the on-disk shape
// or to invariants that survivors must respect. Pre-bump saves are rejected
// by parseSaveFile (SaveVersionMismatchError) — the loadSave/hasSave path
// returns null, so the caller boots a fresh scenario instead of corrupting
// state. Per the original save.ts header note, version bumps "intentionally
// invalidate old saves (intentional for beta)".
//
// History:
//   v1 — Phase 9 / SCEN-04 baseline.
//   v2 — Issue #15: chamber-authoritative food storage. Pre-v2 saves stored
//        the entire stockpile in `colony.foodStored` (chambers held projected
//        slices, recomputed each reconcile). Loading those into v2 would
//        either double-count (slices + pool) or silently truncate to BASE on
//        the next reconcile. Reject them — fresh scenarios are cheap in beta.
//   v3 — Issue #112: finite food piles + runtime spawn. FoodPile gains
//        pickupsRemaining + pickupsInitial (charge counter, separate from
//        the fixed-point food quantity transferred per pickup); WorldState
//        gains recentlyDepletedFood (anti-teleport guard for the spawner).
//        Pre-v3 saves lack both; loading them would route every pickup
//        through `pile.pickupsRemaining = undefined`, which decrements to
//        NaN and silently breaks the depletion semantic. Reject them.
export const SAVE_FORMAT_VERSION = 3 as const;
export const SAVE_KEY = 'subterrans:save:v3' as const;
export const AUTOSAVE_INTERVAL_MS = 30_000 as const;

export class SaveVersionMismatchError extends Error {
  constructor(public expected: number, public got: number) {
    super(`Save format version mismatch: expected ${expected}, got ${got}`);
    this.name = 'SaveVersionMismatchError';
  }
}

/**
 * Issue #66 — thrown by `deserializeWorldState` when the snapshot's
 * `simVersion` exceeds `LATEST_SIM_VERSION`. Distinct from the plain
 * `Error` thrown for tampered-corruption cases (negative simVersion,
 * out-of-range ants.count, malformed snapshot shape) so callers can
 * preserve the recoverable case and discard the tampered case.
 *
 * "Future-build save loaded by older build" is the canonical scenario:
 * the envelope is intact and a newer build can load it, but THIS build
 * doesn't know how to interpret the simVersion. Caller should boot
 * fresh without deleting; user can recover by upgrading the build.
 */
export class FutureSimVersionError extends Error {
  constructor(public got: number, public latest: number) {
    super(`Save's simVersion (${got}) is newer than this build's LATEST (${latest})`);
    this.name = 'FutureSimVersionError';
  }
}

// ---------------------------------------------------------------------------
// Boundary validators — issues #99, #101-#105, #109, #110.
//
// All run at the parseSaveFile / deserializeWorldState boundary. Throws
// route through bootFromSave's catch → bootFresh, consistent with
// existing #59 / #65 / #66 hardening. Validators are intentionally narrow:
// reject anything that wouldn't survive a serialize/deserialize round-trip
// from a legitimate game (allowing only the value domains buildSaveFile
// can produce). The render layer's `loadSave` already swallows these
// throws; existing tests confirm the corrupt-save path triggers
// deleteSave + bootFresh.
// ---------------------------------------------------------------------------

/** Tile-coord boundary check (mirrors src/sim/tick.ts:204 — kept private here
 *  so save.ts doesn't import from the tick module). */
function isTileCoord(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < max;
}

/** Issue #110 — envelope seed must round-trip `seed | 0` losslessly (int32). */
function isInt32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= -0x80000000
    && value <= 0x7fffffff;
}

/** Cap on how many entries each top-level Object map may carry on load.
 *  Issue #99 — defense against memory-DoS via unbounded `Object.entries`
 *  loops in deserializeWorldState. Numbers are 4-8× current scenario use,
 *  ample headroom for future scenario tweaks; anything above is tampering. */
const MAX_COLONIES_LOAD = 16;       // current LIVE_COLONY_COUNT = 2.
const MAX_PHEROMONE_GRID_KEYS = 16; // current = 8 (2 colonies × 2 types × 2 zones).
const MAX_PENDING_CHAMBERS = 256;   // few per colony in normal play.
const MAX_FOOD_PILES = FOOD_PILE_COUNT * 4; // issue #109.

/** Issue #99 — verify a serialized grid object matches the canonical
 *  dimensions and has an array-like data field. Width/height are PRD-locked
 *  (`src/sim/constants.ts`); a future change to grid size would correctly
 *  require a save-format bump anyway, so a strict equality check is the
 *  right strictness level here. */
function validateGridShape(
  s: unknown,
  expectedW: number,
  expectedH: number,
  label: string,
): void {
  if (s === null || typeof s !== 'object') {
    throw new Error(`Invalid ${label}: not an object`);
  }
  const g = s as { width?: unknown; height?: unknown; data?: unknown };
  if (g.width !== expectedW || g.height !== expectedH) {
    throw new Error(
      `Invalid ${label} dimensions: ${String(g.width)}x${String(g.height)} ` +
      `(expected ${expectedW}x${expectedH})`,
    );
  }
  if (!Array.isArray(g.data) && !ArrayBuffer.isView(g.data)) {
    throw new Error(`Invalid ${label}: data is not array-like`);
  }
}

/** Issue #101 — chamber-record validator. Width/height MUST match the
 *  canonical CHAMBER_DIMENSIONS for the chamberType — chamber footprints are
 *  PRD-fixed, not player-set. Any deviation is tampering. The seed loop in
 *  chamber-flow.ts:146-157 iterates `chamber.height × chamber.width`, so an
 *  unvalidated record can hang the renderer (4× per dirty cycle). */
function validateChamberRecord(ch: unknown, label: string): void {
  if (ch === null || typeof ch !== 'object') {
    throw new Error(`Invalid ${label}: not an object`);
  }
  const c = ch as Partial<ChamberRecord>;
  if (typeof c.chamberId !== 'number'
      || !Number.isInteger(c.chamberId)
      || c.chamberId < 0
      || c.chamberId > MAX_ENTITIES) {
    throw new Error(`Invalid ${label}.chamberId: ${String(c.chamberId)}`);
  }
  if (typeof c.chamberType !== 'number'
      || !Number.isInteger(c.chamberType)
      || c.chamberType < 0
      || c.chamberType > 2) {
    throw new Error(`Invalid ${label}.chamberType: ${String(c.chamberType)}`);
  }
  const dims = CHAMBER_DIMENSIONS[c.chamberType as ChamberType];
  if (c.width !== dims.width || c.height !== dims.height) {
    throw new Error(
      `Invalid ${label} dims for type ${c.chamberType}: ` +
      `${String(c.width)}x${String(c.height)} (expected ${dims.width}x${dims.height})`,
    );
  }
  // posX/posY are FP coords; require integer in [0, gridSize<<FP_SHIFT).
  const ugWidthFp = UNDERGROUND_GRID_WIDTH << FP_SHIFT;
  const ugHeightFp = UNDERGROUND_GRID_HEIGHT << FP_SHIFT;
  if (typeof c.posX !== 'number'
      || !Number.isInteger(c.posX)
      || c.posX < 0
      || c.posX >= ugWidthFp) {
    throw new Error(`Invalid ${label}.posX: ${String(c.posX)}`);
  }
  if (typeof c.posY !== 'number'
      || !Number.isInteger(c.posY)
      || c.posY < 0
      || c.posY >= ugHeightFp) {
    throw new Error(`Invalid ${label}.posY: ${String(c.posY)}`);
  }
  if (typeof c.foodStored !== 'number'
      || !Number.isInteger(c.foodStored)
      || c.foodStored < 0
      || c.foodStored > FOOD_CHAMBER_CAPACITY) {
    throw new Error(`Invalid ${label}.foodStored: ${String(c.foodStored)}`);
  }
}

/** Issue #102 — pendingChamber validator. Same canonical-dims rule as
 *  #101 plus footprint-fits-grid check. The CancelDigMark revert loop at
 *  tick.ts:382-389 has no early exit, so an unvalidated entry can hang
 *  the renderer on a single right-click. */
function validatePendingChamber(pc: unknown, label: string): void {
  if (pc === null || typeof pc !== 'object') {
    throw new Error(`Invalid ${label}: not an object`);
  }
  const p = pc as Partial<PendingChamber>;
  if (typeof p.colonyId !== 'number' || !Number.isInteger(p.colonyId) || p.colonyId < 0) {
    throw new Error(`Invalid ${label}.colonyId: ${String(p.colonyId)}`);
  }
  if (typeof p.chamberType !== 'number'
      || !Number.isInteger(p.chamberType)
      || p.chamberType < 0
      || p.chamberType > 2) {
    throw new Error(`Invalid ${label}.chamberType: ${String(p.chamberType)}`);
  }
  if (!isTileCoord(p.anchorTileX, UNDERGROUND_GRID_WIDTH)) {
    throw new Error(`Invalid ${label}.anchorTileX: ${String(p.anchorTileX)}`);
  }
  if (!isTileCoord(p.anchorTileY, UNDERGROUND_GRID_HEIGHT)) {
    throw new Error(`Invalid ${label}.anchorTileY: ${String(p.anchorTileY)}`);
  }
  const dims = CHAMBER_DIMENSIONS[p.chamberType as ChamberType];
  if (p.width !== dims.width || p.height !== dims.height) {
    throw new Error(
      `Invalid ${label} dims for type ${p.chamberType}: ` +
      `${String(p.width)}x${String(p.height)} (expected ${dims.width}x${dims.height})`,
    );
  }
  if ((p.anchorTileX as number) + dims.width > UNDERGROUND_GRID_WIDTH
      || (p.anchorTileY as number) + dims.height > UNDERGROUND_GRID_HEIGHT) {
    throw new Error(
      `${label} footprint extends past grid: anchor ` +
      `(${p.anchorTileX}, ${p.anchorTileY}) + ${dims.width}x${dims.height}`,
    );
  }
}

/** Issue #109 + #112 — foodPile validator. */
function validateFoodPile(p: unknown, label: string): void {
  if (p === null || typeof p !== 'object') {
    throw new Error(`Invalid ${label}: not an object`);
  }
  const fp = p as Partial<FoodPile>;
  if (typeof fp.foodPileId !== 'number'
      || !Number.isInteger(fp.foodPileId)
      || fp.foodPileId < 0
      || fp.foodPileId > MAX_ENTITIES) {
    throw new Error(`Invalid ${label}.foodPileId: ${String(fp.foodPileId)}`);
  }
  if (!isTileCoord(fp.tileX, SURFACE_GRID_WIDTH)) {
    throw new Error(`Invalid ${label}.tileX: ${String(fp.tileX)}`);
  }
  if (!isTileCoord(fp.tileY, SURFACE_GRID_HEIGHT)) {
    throw new Error(`Invalid ${label}.tileY: ${String(fp.tileY)}`);
  }
  // Issue #112 — pickup-charge fields.
  // pickupsInitial: integer in [FOOD_PILE_INITIAL_PICKUPS_MIN, MAX]. The
  // runtime spawner and `pickupsForSeed` both produce values in that closed
  // range, so any save with `pickupsInitial < MIN` represents a state the
  // sim cannot generate (either tampered, or a back-port from a build with
  // looser constants — neither survives the contract).
  if (typeof fp.pickupsInitial !== 'number'
      || !Number.isInteger(fp.pickupsInitial)
      || fp.pickupsInitial < FOOD_PILE_INITIAL_PICKUPS_MIN
      || fp.pickupsInitial > FOOD_PILE_INITIAL_PICKUPS_MAX) {
    throw new Error(`Invalid ${label}.pickupsInitial: ${String(fp.pickupsInitial)}`);
  }
  // pickupsRemaining: integer in [1, pickupsInitial]. Live piles always have
  // at least one charge — the runtime splices at zero so saves should never
  // observe a 0 here. Above-initial means tampering or accidental re-creation.
  if (typeof fp.pickupsRemaining !== 'number'
      || !Number.isInteger(fp.pickupsRemaining)
      || fp.pickupsRemaining <= 0
      || fp.pickupsRemaining > fp.pickupsInitial) {
    throw new Error(`Invalid ${label}.pickupsRemaining: ${String(fp.pickupsRemaining)}`);
  }
}

/**
 * Issue #112 — recentlyDepletedFood entry validator. Validates shape and
 * non-negativity; an additional `tick > world.tick` guard lives in
 * `tickFoodPileSpawn` (food-system.ts) because this validator runs before
 * deserialize hands `world.tick` over. Without that runtime guard a tampered
 * save with `tick = 4e9` would permanently sterilise its tile region against
 * respawn (the entry would never match the prune threshold).
 */
function validateDepletionRecord(d: unknown, label: string): void {
  if (d === null || typeof d !== 'object') {
    throw new Error(`Invalid ${label}: not an object`);
  }
  const r = d as Partial<DepletionRecord>;
  if (typeof r.tick !== 'number' || !Number.isInteger(r.tick) || r.tick < 0) {
    throw new Error(`Invalid ${label}.tick: ${String(r.tick)}`);
  }
  if (!isTileCoord(r.tileX, SURFACE_GRID_WIDTH)) {
    throw new Error(`Invalid ${label}.tileX: ${String(r.tileX)}`);
  }
  if (!isTileCoord(r.tileY, SURFACE_GRID_HEIGHT)) {
    throw new Error(`Invalid ${label}.tileY: ${String(r.tileY)}`);
  }
}

// ---------------------------------------------------------------------------
// SerializedWorldState — JSON-safe shape of WorldState.
// Mirrors WorldState exactly; typed arrays become number[]; plain-object
// Records become { [stringKey]: ... } and are iterated with Object.entries.
// ---------------------------------------------------------------------------

interface SerializedAnts {
  count: number;   // we persist capacity = MAX_ENTITIES; no separate count field exists on AntComponents
  // All 18 Int32Array fields as plain number[]:
  posX: number[]; posY: number[]; colonyId: number[];
  task: number[]; subTask: number[]; speed: number[];
  foodCarrying: number[]; starvationTimer: number[];
  age: number[]; alive: number[]; lifespan: number[];
  zone: number[];
  digTileX: number[]; digTileY: number[]; digTicksRemaining: number[];
  targetPosX: number[]; targetPosY: number[];
  // Phase 9 / 09 digger-reassignment memo — per-ant SearchingFood leash wave.
  // Optional for backward compatibility with pre-Phase-9 saves; deserializer
  // treats absent as zero-init (base wave).
  searchWave?: number[];
  // Phase 9 / 09 excursion-foraging memo — correlated outward walk heading
  // (per-ant, no colony-memory). Optional for backward compatibility — a save
  // written before the excursion pass simply re-rolls the heading next tick.
  searchHeadingX?: number[];
  searchHeadingY?: number[];
  searchHeadingTicks?: number[];
  // Phase 9 / 09 excursion-foraging follow-up — per-ant anti-backtrack prev
  // tile. Optional for backward compatibility; absent means "no previous tile",
  // so an ant one tick post-load cannot be anti-backtracked on its first move.
  searchPrevTileX?: number[];
  searchPrevTileY?: number[];
  // Phase 09.1 Chunk 0 — grid-of-occupancy byte (Uint8Array on AntComponents,
  // serialized as number[]). Optional for backward compatibility with saves
  // written before Phase 09.1 landed: deserializer falls back to copying
  // `colonyId` into `currentGridColonyId`, reproducing the pre-Chunk-0
  // invariant (every ant's grid byte equals its colony byte) that initAnt
  // establishes for fresh ants. A naive zero-fill would silently point every
  // enemy ant's grid lookup at the player's underground grid.
  currentGridColonyId?: number[];
  /**
   * Issue #27 — carrier wait flag. Optional for backward compatibility with
   * pre-#27 saves; absent → all-zero (no ants waiting), which matches the
   * legacy behavior of always-routing carriers regardless of saturation.
   * Pre-#27 saves load at simVersion=LEGACY anyway, so the wait-state code
   * paths stay dormant.
   */
  waitingDeposit?: number[];
  /**
   * Issue #34 — per-ant Bresenham error accumulator. Optional; absent →
   * zero-init, which matches the pre-#34 "fresh start" semantics of the
   * cardinal-pick algorithm.
   */
  pathErr?: number[];
  /**
   * Issue #35 — per-ant pause-while-searching counter. Optional; absent →
   * zero-init (no ants paused at load time).
   */
  searchPauseTicks?: number[];
  /**
   * Issue #42 — recent-tiles ring buffer. Three flat arrays:
   *   recentTilesX / recentTilesY: length = maxEntities * RECENT_TILES_LEN
   *   recentTilesHead: length = maxEntities, value 0..RECENT_TILES_LEN-1
   * Optional; absent → SENTINEL-filled (no history), which is the correct
   * v6 default. Pre-v6 saves never read these fields (gated on simVersion).
   */
  recentTilesX?: number[];
  recentTilesY?: number[];
  recentTilesHead?: number[];
  /**
   * Issue #17 Phase 1 — visible brood carry. carryingBroodId[i] = entity id
   * of the brood ant `i` is carrying (or -1 if none); carriedBy[j] = entity
   * id of the nurse carrying brood `j` (or -1 if uncarried). Optional;
   * absent → all-(-1) default, which also matches a v10+ "no carries in
   * flight" snapshot. Pre-v10 saves never read these fields (gated on
   * simVersion).
   */
  carryingBroodId?: number[];
  carriedBy?: number[];
}

interface SerializedColony {
  colonyId: ColonyId; queenEntityId: EntityId; queenStarvationTimer: number;
  foodStored: number; workerCount: number; eggCount: number; larvaeCount: number; nurseCount: number;
  eggs: EntityId[]; larvae: EntityId[]; workers: EntityId[];
  chambers: ChamberRecord[];
  // Phase 10 / D-04 silent-migration: serialized shape is the runtime BehaviorRatio
  // (post-migration `{ forage, fight }`), but the legacy `dig` field is allowed for
  // backward compatibility with pre-Phase-10 saves. Migration via migrateBehaviorRatio
  // at load time (deserializeColony) silently drops the `dig` field — no schema
  // version bump per D-04 (pre-1.0, save compat is not a public contract).
  targetRatio: { forage: number; fight: number; dig?: number };
  computedAllocation: WorkerAllocation;
  taskCensus: WorkerAllocation;
  defeated: boolean; reconcileCountdown: number;
  entrances: NestEntrance[];
  rallyPoint: { tileX: number; tileY: number } | null;
  digFlowFieldDirty: boolean;
  foodFlowFieldDirty?: boolean;  // Issue #15 — defaults false on old saves
  killCount: number;   // Plan 09-01
  priorityFoodPileId: FoodPileId | null;  // Phase 9 / PRD §3d — per-colony priority food target
}

interface SerializedGrid { width: number; height: number; data: number[] }

export interface SerializedWorldState {
  tick: number;
  rngState: number;
  nextEntityId: number;
  /**
   * Issue #27 — sim-behavior version (independent of SAVE_FORMAT_VERSION).
   * Optional for backward compatibility: saves written before issue #27 omit
   * the field; deserializeWorldState defaults absent → LEGACY_SIM_VERSION (2),
   * sticky on load to preserve SCEN-06 replay determinism.
   */
  simVersion?: number;
  /**
   * Issue #44 — terrain decoration seed (independent of `rngState` and
   * `simVersion`). Optional for backward compatibility: pre-#44 saves omit
   * the field; deserializeWorldState defaults absent → 0. Loading a pre-#44
   * save will therefore produce a different decoration layout than the
   * recorded run, but world geometry (entrances, food piles, colony
   * positions) is unaffected. Movement-affecting feature collision (added in
   * step 4) is gated separately via simVersion.
   */
  terrainSeed?: number;
  commandQueue: SimCommand[];  // plain-object spread is sufficient (ADR-0006)
  ants: SerializedAnts;
  colonies: Record<string, SerializedColony>;       // keys are ColonyId.toString()
  pheromoneGrids: Record<string, SerializedGrid>;
  surface: SerializedGrid;
  undergroundGrids: Record<string, SerializedGrid>; // keys are ColonyId.toString()
  foodPiles: FoodPile[];
  /**
   * Issue #112 — Optional for backward-compat at the type level only; saves
   * written by v3 always include the field. parseSaveFile rejects v2 saves
   * outright (`SaveVersionMismatchError`), so deserialize only ever sees v3
   * snapshots whose `recentlyDepletedFood` is present and validated.
   */
  recentlyDepletedFood?: DepletionRecord[];
  pendingChambers: Record<string, PendingChamber>;
}

// ---------------------------------------------------------------------------
// SaveFile envelope — PRD §8a normative shape
// ---------------------------------------------------------------------------

export interface SaveFile {
  readonly version: number;
  readonly seed: number;
  readonly inputLog: SimCommand[];
  readonly snapshot: SerializedWorldState;
}

// ---------------------------------------------------------------------------
// Serialize helpers
// ---------------------------------------------------------------------------

function serializeAnts(a: AntComponents): SerializedAnts {
  // Persist the full array (MAX_ENTITIES length). The deserializer allocates the
  // same size, so unused slots (alive=0) round-trip faithfully.
  return {
    count: a.alive.length,
    posX:              Array.from(a.posX),
    posY:              Array.from(a.posY),
    colonyId:          Array.from(a.colonyId),
    task:              Array.from(a.task),
    subTask:           Array.from(a.subTask),
    speed:             Array.from(a.speed),
    foodCarrying:      Array.from(a.foodCarrying),
    starvationTimer:   Array.from(a.starvationTimer),
    age:               Array.from(a.age),
    alive:             Array.from(a.alive),
    lifespan:          Array.from(a.lifespan),
    zone:              Array.from(a.zone),
    digTileX:          Array.from(a.digTileX),
    digTileY:          Array.from(a.digTileY),
    digTicksRemaining: Array.from(a.digTicksRemaining),
    targetPosX:        Array.from(a.targetPosX),
    targetPosY:        Array.from(a.targetPosY),
    searchWave:        Array.from(a.searchWave),
    searchHeadingX:    Array.from(a.searchHeadingX),
    searchHeadingY:    Array.from(a.searchHeadingY),
    searchHeadingTicks:Array.from(a.searchHeadingTicks),
    searchPrevTileX:   Array.from(a.searchPrevTileX),
    searchPrevTileY:   Array.from(a.searchPrevTileY),
    // Phase 09.1 Chunk 0 — grid-of-occupancy byte. Array.from works for both
    // Int32Array and Uint8Array, so the shape is identical to the other
    // per-ant fields (number[]).
    currentGridColonyId: Array.from(a.currentGridColonyId),
    // Issue #27 — carrier wait flag (Uint8Array; serialized as number[]).
    waitingDeposit: Array.from(a.waitingDeposit),
    pathErr: Array.from(a.pathErr),
    searchPauseTicks: Array.from(a.searchPauseTicks),
    // Issue #42 — recent-tiles ring buffer. The X/Y arrays are flat
    // (length = maxEntities * RECENT_TILES_LEN); the head array indexes
    // into them. All three round-trip for v6 SCEN-06 replay determinism.
    recentTilesX:    Array.from(a.recentTilesX),
    recentTilesY:    Array.from(a.recentTilesY),
    recentTilesHead: Array.from(a.recentTilesHead),
    // Issue #17 Phase 1 — visible brood carry slot + reverse pointer.
    carryingBroodId: Array.from(a.carryingBroodId),
    carriedBy:       Array.from(a.carriedBy),
  };
}

function serializeColony(c: ColonyRecord): SerializedColony {
  return {
    colonyId:             c.colonyId,
    queenEntityId:        c.queenEntityId,
    queenStarvationTimer: c.queenStarvationTimer,
    foodStored:           c.foodStored,
    workerCount:          c.workerCount,
    eggCount:             c.eggCount,
    larvaeCount:          c.larvaeCount,
    nurseCount:           c.nurseCount,
    eggs:                 [...c.eggs],
    larvae:               [...c.larvae],
    workers:              [...c.workers],
    chambers:             c.chambers.map((ch) => ({ ...ch })),
    targetRatio:          { ...c.targetRatio },
    computedAllocation:   { ...c.computedAllocation },
    taskCensus:           { ...c.taskCensus },
    defeated:             c.defeated,
    reconcileCountdown:   c.reconcileCountdown,
    entrances:            c.entrances.map((e) => ({ ...e })),
    rallyPoint:           c.rallyPoint === null ? null : { ...c.rallyPoint },
    digFlowFieldDirty:    c.digFlowFieldDirty,
    foodFlowFieldDirty:   c.foodFlowFieldDirty,
    killCount:            c.killCount,
    priorityFoodPileId:   c.priorityFoodPileId,
  };
}

function serializeSurfaceGrid(g: SurfaceGrid): SerializedGrid {
  return { width: g.width, height: g.height, data: Array.from(g.data) };
}
function serializeUndergroundGrid(g: UndergroundGrid): SerializedGrid {
  return { width: g.width, height: g.height, data: Array.from(g.data) };
}
function serializePheromoneGrid(g: PheromoneGrid): SerializedGrid {
  return { width: g.width, height: g.height, data: Array.from(g.data) };
}

export function serializeWorldState(world: WorldState): SerializedWorldState {
  // ADR-0006: colonies is a PLAIN OBJECT. Use Object.entries — NOT Array.from(world.colonies.entries())
  const coloniesOut: Record<string, SerializedColony> = {};
  for (const [cidStr, rec] of Object.entries(world.colonies)) {
    coloniesOut[cidStr] = serializeColony(rec);
  }
  const undergroundOut: Record<string, SerializedGrid> = {};
  for (const [cidStr, grid] of Object.entries(world.undergroundGrids)) {
    undergroundOut[cidStr] = serializeUndergroundGrid(grid);
  }
  const pheromoneOut: Record<string, SerializedGrid> = {};
  for (const [key, grid] of Object.entries(world.pheromoneGrids)) {
    pheromoneOut[key] = serializePheromoneGrid(grid);
  }
  const pendingOut: Record<string, PendingChamber> = {};
  for (const [key, pc] of Object.entries(world.pendingChambers)) {
    pendingOut[key] = { ...pc };
  }

  return {
    tick: world.tick,
    rngState: world.rngState,
    nextEntityId: world.nextEntityId,
    simVersion: world.simVersion,
    terrainSeed: world.terrainSeed,
    commandQueue: world.commandQueue.map((c) => ({ ...c })),  // Pitfall 7 — preserve
    ants: serializeAnts(world.ants),
    colonies: coloniesOut,
    pheromoneGrids: pheromoneOut,
    surface: serializeSurfaceGrid(world.surface),
    undergroundGrids: undergroundOut,
    foodPiles: world.foodPiles.map((p) => ({ ...p })),
    recentlyDepletedFood: world.recentlyDepletedFood.map((r) => ({ ...r })),
    pendingChambers: pendingOut,
  };
}

// ---------------------------------------------------------------------------
// Deserialize helpers
// ---------------------------------------------------------------------------

/**
 * Phase 10 / D-04 — silent BehaviorRatio migration on load.
 *
 * Pre-Phase-10 saves serialize targetRatio as `{ forage, dig, fight }` (3 fields).
 * Phase 10 narrows BehaviorRatio to `{ forage, fight }`. This helper:
 *   - drops the `dig` field (no proportional rescale)
 *   - snaps all-zero `{ forage: 0, fight: 0 }` to `{ forage: 10, fight: 0 }`
 *     (the player had pure dig under the old contract; default to 100% forage,
 *     matching DEFAULT_BEHAVIOR_RATIO from Plan 01)
 *   - leaves already-migrated saves untouched (idempotent)
 *   - defensively defaults missing/non-numeric `forage` and `fight` to 0
 *     (which then triggers the all-zero snap → `{ forage: 10, fight: 0 }`)
 *
 * No schema version bump — pre-1.0, save compat is not a public contract per D-04.
 *
 * Pure function: no PRNG, no clock, no side effects. Idempotent: applying twice
 * produces the same output as applying once.
 */
export function migrateBehaviorRatio(legacy: unknown): BehaviorRatio {
  // Issue #78 — accept `unknown` at runtime: a corrupted snapshot can pass
  // null / number / string / array here from deserializeColony(s.targetRatio).
  // Direct property access or `'dig' in legacy` would otherwise throw
  // TypeError for non-object inputs and propagate out of loadSave as a
  // swallowed error → total save loss. Treat any non-object input as "no
  // usable fields" → defaults to DEFAULT_BEHAVIOR_RATIO via the all-zero
  // malformed snap below.
  const isObject = legacy !== null && typeof legacy === 'object';
  const obj = (isObject ? legacy : {}) as { forage?: unknown; fight?: unknown; dig?: unknown };
  // Defensive: reject NaN, +/-Infinity, and negatives. typeof NaN === 'number',
  // so the typeof guard alone allows NaN to propagate into colony.targetRatio
  // and contaminate every downstream allocateWorkers call (WR-01). A negative
  // weight is also rejected to mirror the SetBehaviorRatio command handler in
  // tick.ts step 5 (any negative weight → reject command).
  const rawForage = obj.forage;
  const rawFight  = obj.fight;
  const isForageValid = typeof rawForage === 'number' && Number.isFinite(rawForage) && rawForage >= 0;
  const isFightValid  = typeof rawFight  === 'number' && Number.isFinite(rawFight)  && rawFight  >= 0;
  const forage = isForageValid ? rawForage : 0;
  const fight  = isFightValid  ? rawFight  : 0;
  // All-zero edge case: snap to { forage: 10, fight: 0 } per D-04 — but ONLY
  // when the input is legacy (has the `dig` key) or malformed (missing/NaN/
  // negative fields). A post-Phase-10 caller that intentionally writes
  // { forage: 0, fight: 0 } (idle slider, AI controller exotic state, debug
  // command replay) is preserved verbatim — otherwise migrateBehaviorRatio
  // would silently mutate valid two-field zeros and break snapshot-vs-replay
  // determinism for tools that compare them (WR-10).
  const isLegacy = isObject && 'dig' in obj;
  const isMalformed = !isObject || !isForageValid || !isFightValid;
  if (forage === 0 && fight === 0 && (isLegacy || isMalformed)) {
    return { forage: 10, fight: 0 };
  }
  return { forage, fight };
}

/**
 * Issue #66 — validate `simVersion` at the save boundary.
 *
 * Returns LEGACY for missing/non-integer (preserves pre-#27 legacy load).
 * Returns the value verbatim for an integer in [LEGACY, LATEST].
 *
 * For out-of-range integers, throws one of two error types so the caller
 * can differentiate recoverable from definitively-corrupt:
 *   - simVersion > LATEST → `FutureSimVersionError` (recoverable: a newer
 *     build wrote this save; older build doesn't know the gate semantics
 *     but the bytes are intact)
 *   - simVersion < LEGACY (e.g. 0, 1, negative) → plain `Error` (tampered
 *     or otherwise definitively corrupt; pre-LEGACY values are not a real
 *     historical save shape, since LEGACY itself was the original baseline)
 *
 * Throws happen at deserialize-time (`deserializeWorldState`) and are
 * caught by `bootFromSave`'s try/catch in render/game-scene.ts. Note
 * that `loadSave` does NOT catch — its swallowing try/catch wraps
 * `parseSaveFile` only, and parseSaveFile doesn't deserialize.
 *
 * Rationale: a tampered save with simVersion=-1 makes every `>= SIM_VERSION_VN`
 * gate evaluate false forever; simVersion=99999 makes them all evaluate
 * true. Both silently break the sticky-on-load determinism contract.
 */
function validateSimVersion(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return LEGACY_SIM_VERSION;
  if (raw > LATEST_SIM_VERSION) {
    throw new FutureSimVersionError(raw, LATEST_SIM_VERSION);
  }
  if (raw < LEGACY_SIM_VERSION) {
    throw new Error(`Invalid simVersion in save: ${raw} (require integer in [${LEGACY_SIM_VERSION}, ${LATEST_SIM_VERSION}])`);
  }
  return raw;
}

function copyIntoInt32(dst: Int32Array, src: readonly number[]): void {
  const n = src.length < dst.length ? src.length : dst.length;
  for (let i = 0; i < n; i++) dst[i] = src[i]!;
}

// Phase 09.1 Chunk 0 — currentGridColonyId is Uint8Array, not Int32Array.
// Same semantics as copyIntoInt32 (length-clamped, positional copy).
function copyIntoUint8(dst: Uint8Array, src: readonly number[]): void {
  const n = src.length < dst.length ? src.length : dst.length;
  for (let i = 0; i < n; i++) dst[i] = src[i]!;
}

function deserializeAnts(saved: SerializedAnts, capacity: number): AntComponents {
  const a = createAntComponents(capacity);
  // createAntComponents pre-fills digTileX/digTileY/targetPosX/targetPosY with -1.
  // Overwrite with saved values (including -1 sentinels where appropriate).
  copyIntoInt32(a.posX, saved.posX);
  copyIntoInt32(a.posY, saved.posY);
  copyIntoInt32(a.colonyId, saved.colonyId);
  copyIntoInt32(a.task, saved.task);
  copyIntoInt32(a.subTask, saved.subTask);
  copyIntoInt32(a.speed, saved.speed);
  copyIntoInt32(a.foodCarrying, saved.foodCarrying);
  copyIntoInt32(a.starvationTimer, saved.starvationTimer);
  copyIntoInt32(a.age, saved.age);
  copyIntoInt32(a.alive, saved.alive);
  copyIntoInt32(a.lifespan, saved.lifespan);
  copyIntoInt32(a.zone, saved.zone);
  copyIntoInt32(a.digTileX, saved.digTileX);
  copyIntoInt32(a.digTileY, saved.digTileY);
  copyIntoInt32(a.digTicksRemaining, saved.digTicksRemaining);
  copyIntoInt32(a.targetPosX, saved.targetPosX);
  copyIntoInt32(a.targetPosY, saved.targetPosY);
  // Phase 9: pre-Phase-9 saves omit searchWave — createAntComponents already
  // zero-initialized the field (base wave), so skip the copy when absent.
  if (saved.searchWave !== undefined) {
    copyIntoInt32(a.searchWave, saved.searchWave);
  }
  // Phase 9 excursion-foraging — heading fields are optional for forward
  // compatibility with older saves written before the excursion pass landed.
  if (saved.searchHeadingX !== undefined) {
    copyIntoInt32(a.searchHeadingX, saved.searchHeadingX);
  }
  if (saved.searchHeadingY !== undefined) {
    copyIntoInt32(a.searchHeadingY, saved.searchHeadingY);
  }
  if (saved.searchHeadingTicks !== undefined) {
    copyIntoInt32(a.searchHeadingTicks, saved.searchHeadingTicks);
  }
  // 09 excursion-foraging follow-up — prev-tile fields. Pre-follow-up saves
  // omit these; createAntComponents already -1-filled them, so a loaded ant
  // starts with "no previous tile" exactly as if it had just been promoted.
  if (saved.searchPrevTileX !== undefined) {
    copyIntoInt32(a.searchPrevTileX, saved.searchPrevTileX);
  }
  if (saved.searchPrevTileY !== undefined) {
    copyIntoInt32(a.searchPrevTileY, saved.searchPrevTileY);
  }
  // Phase 09.1 Chunk 0 — grid-of-occupancy byte. Pre-Chunk-0 saves omit this
  // field; fall back to copying colonyId into currentGridColonyId, which
  // reproduces the invariant initAnt establishes for fresh ants
  // (currentGridColonyId[id] === colonyId[id]). A naive zero-fill would
  // silently route every enemy ant's grid lookup at the player's underground
  // grid. Chunks 3+4 of 09.1 are the only code path that breaks this
  // invariant at runtime (Fighter invaders mid-attack); until a save from
  // after Chunks 3+4 exists, "absent field" and "identity copy" are equivalent.
  if (saved.currentGridColonyId !== undefined) {
    copyIntoUint8(a.currentGridColonyId, saved.currentGridColonyId);
  } else {
    copyIntoUint8(a.currentGridColonyId, saved.colonyId);
  }
  // Issue #27 — carrier wait flag. Pre-#27 saves omit; createAntComponents
  // already zero-init'd the field (no ants waiting), which is the correct
  // default. Pre-#27 saves also load at simVersion=LEGACY, so the wait-state
  // code paths remain dormant for them regardless.
  if (saved.waitingDeposit !== undefined) {
    copyIntoUint8(a.waitingDeposit, saved.waitingDeposit);
  }
  // Issue #34 / #35 — Bresenham error accumulator and pause-while-searching
  // counter. Pre-feature saves omit; the fields zero-init in
  // createAntComponents which is the correct "fresh start" default.
  if (saved.pathErr !== undefined) {
    copyIntoInt32(a.pathErr, saved.pathErr);
  }
  if (saved.searchPauseTicks !== undefined) {
    copyIntoInt32(a.searchPauseTicks, saved.searchPauseTicks);
  }
  // Issue #42 — recent-tiles ring buffer. Pre-v6 saves omit; the SENTINEL-
  // filled defaults from createAntComponents are correct (no history).
  if (saved.recentTilesX !== undefined) {
    copyIntoInt32(a.recentTilesX, saved.recentTilesX);
  }
  if (saved.recentTilesY !== undefined) {
    copyIntoInt32(a.recentTilesY, saved.recentTilesY);
  }
  if (saved.recentTilesHead !== undefined) {
    copyIntoUint8(a.recentTilesHead, saved.recentTilesHead);
  }
  // Issue #17 Phase 1 — brood carry slot + reverse pointer. Pre-v10 saves
  // omit; createAntComponents fills both with -1 (no carries), which is
  // correct for both pre-v10 (never read) and a fresh v10 load (no carries
  // in flight at that snapshot).
  if (saved.carryingBroodId !== undefined) {
    copyIntoInt32(a.carryingBroodId, saved.carryingBroodId);
  }
  if (saved.carriedBy !== undefined) {
    copyIntoInt32(a.carriedBy, saved.carriedBy);
  }
  return a;
}

function deserializeColony(s: SerializedColony): ColonyRecord {
  const c = createColonyRecord(s.colonyId, s.queenEntityId);
  // createColonyRecord does NOT set the Phase 3 extension fields nor the
  // issue-#15 `foodFlowFieldDirty` field — caller-side contract (see the
  // colony-store.ts factory docblock). Set them explicitly alongside scalar
  // fields. `foodFlowFieldDirty` is `?? false` defensively even though v2
  // saves should always include it; pre-v2 saves are rejected upstream by
  // parseSaveFile (SaveVersionMismatchError).
  c.queenStarvationTimer = s.queenStarvationTimer;
  c.foodStored           = s.foodStored;
  c.workerCount          = s.workerCount;
  c.eggCount             = s.eggCount;
  c.larvaeCount          = s.larvaeCount;
  c.nurseCount           = s.nurseCount;
  c.eggs                 = [...s.eggs];
  c.larvae               = [...s.larvae];
  c.workers              = [...s.workers];
  c.chambers             = s.chambers.map((ch) => ({ ...ch }));
  // Phase 10 / D-04 silent migration: legacy saves carry `targetRatio.dig`;
  // migrateBehaviorRatio drops it, snaps all-zero to DEFAULT_BEHAVIOR_RATIO,
  // and is idempotent on post-Phase-10 saves. See migrateBehaviorRatio docblock.
  c.targetRatio          = migrateBehaviorRatio(s.targetRatio);
  c.computedAllocation   = { ...s.computedAllocation };
  c.taskCensus           = { ...s.taskCensus };
  c.defeated             = s.defeated;
  c.reconcileCountdown   = s.reconcileCountdown;
  c.entrances            = s.entrances.map((e) => ({ ...e }));
  c.rallyPoint           = s.rallyPoint === null ? null : { ...s.rallyPoint };
  c.digFlowFieldDirty    = s.digFlowFieldDirty;
  c.foodFlowFieldDirty   = s.foodFlowFieldDirty ?? false;
  c.killCount            = s.killCount;
  c.priorityFoodPileId   = s.priorityFoodPileId ?? null;
  // Issue #101 — validate chamber records before they reach the runtime.
  // Done after the spread so the validator inspects the persisted shape;
  // throw aborts deserializeWorldState's map() and propagates to bootFromSave.
  for (let i = 0; i < c.chambers.length; i++) {
    validateChamberRecord(c.chambers[i]!, `colony[${s.colonyId}].chambers[${i}]`);
  }
  return c;
}

function deserializeSurfaceGrid(s: SerializedGrid): SurfaceGrid {
  const g = createSurfaceGrid(s.width, s.height);
  g.data.set(s.data);
  return g;
}
function deserializeUndergroundGrid(s: SerializedGrid): UndergroundGrid {
  const g = createUndergroundGrid(s.width, s.height);
  g.data.set(s.data);
  return g;
}
function deserializePheromoneGrid(s: SerializedGrid): PheromoneGrid {
  const g = createPheromoneGrid(s.width, s.height);
  g.data.set(s.data);
  return g;
}

export function deserializeWorldState(s: SerializedWorldState): WorldState {
  // Top-level guard — must be a non-null object to read .simVersion.
  if (s === null || typeof s !== 'object') {
    throw new Error('Invalid save shape: snapshot is not an object');
  }
  // Validate simVersion FIRST — earliest possible, before any other shape
  // or field-value check. Per codex P1 on PR #88: a future build can
  // legitimately restructure the snapshot layout (e.g., split `s.ants`
  // per-colony, raise MAX_ENTITIES, add new top-level fields). Any of those
  // would otherwise throw plain Error at a downstream guard, and bootFromSave
  // would deleteSave() — destroying a recoverable forward-version save.
  // Hoisting the simVersion check ensures any future-version mismatch is
  // surfaced as FutureSimVersionError (preserved + autosave-suspended)
  // before the shape mismatch can misclassify it as tampering.
  const validatedSimVersion = validateSimVersion((s as { simVersion?: unknown }).simVersion);
  // Issue #65 / #66 — shape guard for `s.ants`. Reaches here only after
  // validateSimVersion confirmed simVersion <= LATEST, so a non-object
  // s.ants at this point indicates real corruption (no future build
  // restructure to worry about, since that would have bumped simVersion).
  if (s.ants === null || typeof s.ants !== 'object') {
    throw new Error('Invalid save shape: missing or non-object ants');
  }
  // Issue #65 — boundary validation for s.ants.count. Pre-fix code was
  // `s.ants.count > 0 ? s.ants.count : MAX_ENTITIES`, which silently accepted
  // 1e9 / Infinity / NaN. A hand-edited or corrupted save with a huge count
  // flowed straight into createAntComponents(capacity) and allocated ~25
  // TypedArrays of that length — a memory-DoS vector on load.
  //
  // Boundary policy (codex review-confirmed): count is always written by
  // serializeAnts, so any present-but-invalid value (non-integer / negative /
  // > MAX_ENTITIES) is treated as corrupt and throws — caught by bootFromSave's
  // try/catch, which falls through to bootFresh. count === 0 retains the
  // pre-fix MAX_ENTITIES fallback (was the "no count field" sentinel and is
  // still safe). Compare with simVersion, where missing/non-integer falls
  // back to LEGACY (pre-#27 saves omit the field entirely; that path is real).
  // Reaches here only after validateSimVersion confirmed simVersion <= LATEST,
  // so a count > MAX_ENTITIES at this point is genuine tampering — a future
  // build raising MAX_ENTITIES would have bumped simVersion to flag the change.
  const rawCount = s.ants.count;
  if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 0 || rawCount > MAX_ENTITIES) {
    // Use String() so NaN/Infinity render as their canonical names; JSON.stringify
    // would coerce them to 'null', which is more confusing than less.
    throw new Error(`Invalid ants.count in save: ${String(rawCount)} (require integer in [0, ${MAX_ENTITIES}])`);
  }
  const capacity = rawCount > 0 ? rawCount : MAX_ENTITIES;

  // Issue #99 — top-level Object map cardinality caps. Each loop below
  // allocates per entry, so an oversized map drives unbounded allocation
  // even before any single entry is validated. Reject upfront.
  if (s.colonies === null || typeof s.colonies !== 'object') {
    throw new Error('Invalid save shape: missing or non-object colonies');
  }
  const colonyKeys = Object.keys(s.colonies);
  if (colonyKeys.length > MAX_COLONIES_LOAD) {
    throw new Error(`Too many colonies in save: ${colonyKeys.length} (cap ${MAX_COLONIES_LOAD})`);
  }
  if (s.undergroundGrids === null || typeof s.undergroundGrids !== 'object') {
    throw new Error('Invalid save shape: missing or non-object undergroundGrids');
  }
  const ugKeys = Object.keys(s.undergroundGrids);
  if (ugKeys.length > MAX_COLONIES_LOAD) {
    throw new Error(`Too many undergroundGrids in save: ${ugKeys.length} (cap ${MAX_COLONIES_LOAD})`);
  }
  if (s.pheromoneGrids === null || typeof s.pheromoneGrids !== 'object') {
    throw new Error('Invalid save shape: missing or non-object pheromoneGrids');
  }
  const pheroKeys = Object.keys(s.pheromoneGrids);
  if (pheroKeys.length > MAX_PHEROMONE_GRID_KEYS) {
    throw new Error(`Too many pheromoneGrids in save: ${pheroKeys.length} (cap ${MAX_PHEROMONE_GRID_KEYS})`);
  }
  if (s.pendingChambers === null || typeof s.pendingChambers !== 'object') {
    throw new Error('Invalid save shape: missing or non-object pendingChambers');
  }
  const pcKeys = Object.keys(s.pendingChambers);
  if (pcKeys.length > MAX_PENDING_CHAMBERS) {
    throw new Error(`Too many pendingChambers in save: ${pcKeys.length} (cap ${MAX_PENDING_CHAMBERS})`);
  }

  const colonies: Record<ColonyId, ColonyRecord> = {};
  for (const [cidStr, sc] of Object.entries(s.colonies)) {
    // Issue #99 — colonies map keys must be decimal-integer strings; reject
    // `__proto__` and any non-numeric key shape that would corrupt the
    // resulting Record.
    if (!/^-?\d+$/.test(cidStr)) {
      throw new Error(`Invalid colonies key: ${cidStr}`);
    }
    colonies[Number(cidStr) as ColonyId] = deserializeColony(sc);
  }
  const undergroundGrids: Record<ColonyId, UndergroundGrid> = {};
  for (const [cidStr, sg] of Object.entries(s.undergroundGrids)) {
    if (!/^-?\d+$/.test(cidStr)) {
      throw new Error(`Invalid undergroundGrids key: ${cidStr}`);
    }
    // Issue #99 — verify grid shape before allocator runs.
    validateGridShape(sg, UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT,
      `undergroundGrids[${cidStr}]`);
    undergroundGrids[Number(cidStr) as ColonyId] = deserializeUndergroundGrid(sg);
  }
  const pheromoneGrids: Record<string, PheromoneGrid> = {};
  for (const [key, sg] of Object.entries(s.pheromoneGrids)) {
    // Pheromone grids exist for both surface and underground zones; the key
    // encodes the zone. Two valid sizes; accept either by trying both
    // (validateGridShape throws on mismatch — wrap to retry the alternate).
    if (key.startsWith('__')) {
      throw new Error(`Invalid pheromoneGrids key: ${key}`);
    }
    let validated = false;
    try {
      validateGridShape(sg, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT,
        `pheromoneGrids[${key}]`);
      validated = true;
    } catch { /* try underground next */ }
    if (!validated) {
      validateGridShape(sg, UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT,
        `pheromoneGrids[${key}]`);
    }
    pheromoneGrids[key] = deserializePheromoneGrid(sg);
  }
  const pendingChambers: Record<string, PendingChamber> = {};
  for (const [key, pc] of Object.entries(s.pendingChambers)) {
    if (key.startsWith('__')) {
      throw new Error(`Invalid pendingChambers key: ${key}`);
    }
    // Issue #102 — validate every entry; tick.ts:382 revert loop is
    // unbounded over pc.width × pc.height.
    validatePendingChamber(pc, `pendingChambers[${key}]`);
    pendingChambers[key] = { ...pc };
  }

  // Issue #59 — boundary validation for nextEntityId. Codex suggested
  // saves should reject snapshots whose nextEntityId exceeds component
  // capacity (otherwise the next allocateEntityId after load would
  // happily return an OOB slot index). Now that allocateEntityId
  // soft-caps at MAX_ENTITIES, a legitimate post-fix save can have
  // nextEntityId === MAX_ENTITIES (saturated counter). Anything above
  // is tampered/corrupt and indicates the cap wasn't enforced when
  // the snapshot was written. Match the count check: integer in
  // [0, MAX_ENTITIES] required, anything else throws.
  const rawNext = s.nextEntityId;
  if (typeof rawNext !== 'number' || !Number.isInteger(rawNext) || rawNext < 0 || rawNext > MAX_ENTITIES) {
    throw new Error(`Invalid nextEntityId in save: ${String(rawNext)} (require integer in [0, ${MAX_ENTITIES}])`);
  }

  // Issue #104 — boundary validation for snapshot tick. Same pattern as
  // nextEntityId: `tick: s.tick` previously passed strings/NaN through,
  // and `world.tick += 1` became unbounded string concatenation.
  const rawTick = s.tick;
  if (typeof rawTick !== 'number'
      || !Number.isFinite(rawTick)
      || !Number.isInteger(rawTick)
      || rawTick < 0) {
    throw new Error(`Invalid tick in save: ${String(rawTick)} (require non-negative integer)`);
  }
  // rngState — same hardening for symmetry. Rng's `state | 0` would coerce
  // NaN/strings to 0 on first use, but boundary validation surfaces tampering
  // explicitly instead of silently snapping.
  const rawRng = s.rngState;
  if (typeof rawRng !== 'number'
      || !Number.isFinite(rawRng)
      || !Number.isInteger(rawRng)) {
    throw new Error(`Invalid rngState in save: ${String(rawRng)} (require integer)`);
  }

  // Issue #109 — foodPiles boundary validation. The runtime scans this array
  // every frame (draw-surface, minimap) and every tick (command handlers,
  // ant behavior); an unbounded count converts a load-time anomaly into a
  // sustained per-frame DoS that survives bootFromSave.
  if (!Array.isArray(s.foodPiles)) {
    throw new Error('Invalid foodPiles: not an array');
  }
  if (s.foodPiles.length > MAX_FOOD_PILES) {
    throw new Error(`foodPiles length ${s.foodPiles.length} exceeds cap ${MAX_FOOD_PILES}`);
  }
  const seenFoodIds = new Set<number>();
  const seenFoodTiles = new Set<number>();
  for (let i = 0; i < s.foodPiles.length; i++) {
    const fp = s.foodPiles[i]!;
    validateFoodPile(fp, `foodPiles[${i}]`);
    if (seenFoodIds.has(fp.foodPileId)) {
      throw new Error(`Duplicate foodPiles[${i}].foodPileId: ${fp.foodPileId}`);
    }
    seenFoodIds.add(fp.foodPileId);
    const tileKey = (fp.tileY << 16) | fp.tileX;
    if (seenFoodTiles.has(tileKey)) {
      throw new Error(`Duplicate foodPiles[${i}] tile (${fp.tileX}, ${fp.tileY})`);
    }
    seenFoodTiles.add(tileKey);
  }

  // Issue #99 — surface grid shape (single grid, not per-colony).
  validateGridShape(s.surface, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT, 'surface');

  // Issue #112 — recentlyDepletedFood validation. v3 snapshots always have it
  // (serializer always emits it; v2 saves are rejected by parseSaveFile so
  // they never reach here). Length-cap matches the spawn step's append-time
  // cap (FOOD_PILE_SOFT_CEILING) so this is a tampering check.
  const rawRecentlyDepleted: unknown = s.recentlyDepletedFood;
  if (!Array.isArray(rawRecentlyDepleted)) {
    throw new Error('Invalid recentlyDepletedFood: not an array');
  }
  // Length cap matches the append-time cap in `recordFoodPileDepletion`
  // (food-system.ts): saves with exactly FOOD_PILE_SOFT_CEILING entries are
  // valid; > that is tampering.
  if (rawRecentlyDepleted.length > FOOD_PILE_SOFT_CEILING) {
    throw new Error(
      `recentlyDepletedFood length ${rawRecentlyDepleted.length} exceeds cap ${FOOD_PILE_SOFT_CEILING}`,
    );
  }
  for (let i = 0; i < rawRecentlyDepleted.length; i++) {
    validateDepletionRecord(rawRecentlyDepleted[i], `recentlyDepletedFood[${i}]`);
  }
  const validatedRecentlyDepleted = rawRecentlyDepleted as DepletionRecord[];

  return {
    tick: rawTick,
    rngState: rawRng,
    nextEntityId: rawNext,
    // Issue #27 — sticky-on-load: pre-#27 saves omit `simVersion` and replay
    // at LEGACY (2). Post-#27 saves carry the recorded version through.
    // Type-validate at the boundary: `??` only guards null/undefined, so a
    // hand-edited or corrupted save passing `"3"` / NaN / null / object
    // would otherwise reach `world.simVersion >= 3` comparisons which
    // coerce inconsistently (`"3" >= 3 === true`, `"latest" >= 3 === false`)
    // and silently land replays on the wrong drain order.
    //
    // Issue #66 — also reject present-but-out-of-range integers. Pre-fix
    // code accepted any integer, including 99999 (every gate evaluates true
    // forever, breaking the sticky-on-load contract for tampered saves) and
    // negatives (every gate evaluates false). Boundary policy: missing/non-
    // integer falls back to LEGACY (preserves legacy save-load); present
    // integer in [LEGACY, LATEST] is used verbatim; integer outside that
    // band throws (caught by bootFromSave's try/catch in render/game-scene.ts
    // → bootFresh) rather than silently loading into an undefined gate-state
    // mode. NB: loadSave does NOT catch this — its try/catch only wraps
    // parseSaveFile. The simVersion check runs at deserialize-time.
    simVersion: validatedSimVersion,
    // Issue #44 — pre-#44 saves omit `terrainSeed`; default to 0 on load.
    // Same boundary type-validation as `simVersion`: `??` only guards null/
    // undefined, so a hand-edited save with `"42"` / NaN / object would land
    // at world.terrainSeed and be XOR'd into the surface hash, producing
    // either NaN-poisoning or coercion surprises. Reject anything that isn't
    // a uint32-coercible integer.
    terrainSeed: typeof s.terrainSeed === 'number' && Number.isInteger(s.terrainSeed)
      ? s.terrainSeed >>> 0
      : 0,
    // Issue #82 — also run migrateInputLogCommand on the queued commands.
    // Pre-fix path migrated only inputLog at parseSaveFile and relied on
    // tick.ts's inline SetBehaviorRatio guard for queued commands. That
    // works for the live tick loop, but anything that inspects
    // world.commandQueue directly (debug snapshot tools, ad-hoc tests,
    // future remote-command surfaces) would see the unmigrated legacy
    // shape until the dispatcher actually consumed it. Centralizing the
    // migration here makes the loaded snapshot internally consistent
    // before any tick runs.
    //
    // Issue #105 — also filter null/non-object entries before the spread:
    // `{ ...null }` works (yields `{}`), but the resulting object lacks
    // `cmd.type` and the dispatcher's exhaustive switch would silently no-op
    // — better to drop them at the boundary so the runtime queue is always
    // consistent with the dispatcher's expectations.
    commandQueue: (Array.isArray(s.commandQueue) ? s.commandQueue : [])
      .filter((c) => c !== null && typeof c === 'object')
      .map((c) => migrateInputLogCommand({ ...c })),
    ants: deserializeAnts(s.ants, capacity),
    colonies,
    pheromoneGrids,
    surface: deserializeSurfaceGrid(s.surface),
    undergroundGrids,
    foodPiles: s.foodPiles.map((p) => ({ ...p })),
    recentlyDepletedFood: validatedRecentlyDepleted.map((r) => ({ ...r })),
    pendingChambers,
  };
}

// ---------------------------------------------------------------------------
// Envelope + localStorage API
// ---------------------------------------------------------------------------

function buildSaveFile(seed: number, inputLog: readonly SimCommand[], world: WorldState): SaveFile {
  return {
    version: SAVE_FORMAT_VERSION,
    seed: seed | 0,
    inputLog: inputLog.map((c) => ({ ...c })),
    snapshot: serializeWorldState(world),
  };
}

/**
 * Phase 10 / WR-09 — migrate a single inputLog entry on load.
 *
 * Pre-Phase-10 v2 saves (issue #15 bumped 1→2; Phase 10 narrowed without
 * bumping per D-04) can carry `SetBehaviorRatio` commands shaped as
 * `{ forage, dig, fight }`. The `dig` field is gone in the Phase 10 sim;
 * replaying such a command verbatim would either silently drop the dig
 * weight (turning legitimate dig-heavy commands into idle ones) or trip
 * post-Phase-10 invariants. SCEN-06 replay truth requires the in-memory
 * inputLog to match what the current sim accepts, so we migrate here
 * rather than in the per-tick command handler.
 *
 * Migration semantics mirror `migrateBehaviorRatio` for the snapshot's
 * persisted `targetRatio`:
 *   - drop `dig` (no rescale)
 *   - all-zero `{forage:0, fight:0}` snaps to DEFAULT_BEHAVIOR_RATIO
 *     `{forage:10, fight:0}` (covers the pre-Phase-10 pure-dig case)
 *
 * Pure function, idempotent on already-migrated commands. Non-
 * `SetBehaviorRatio` entries pass through untouched.
 */
function migrateInputLogCommand(cmd: SimCommand): SimCommand {
  // Issue #105 — guard at entry, before any property access. The Issue #78
  // fix block below covers null `cmd.ratio`; this covers structurally-
  // identical null / non-object `cmd`. Without this guard, parseSaveFile's
  // loop throws TypeError on `null.type`, loadSave's try/catch swallows
  // the throw and returns null, the caller treats the WHOLE save as corrupt
  // and calls deleteSave + bootFresh — escalating one bad command into
  // total save loss. Pass through verbatim; the dispatcher's exhaustive-
  // default in tick.ts silently drops malformed entries.
  if (cmd === null || typeof cmd !== 'object') return cmd;
  if (cmd.type !== 'SetBehaviorRatio') return cmd;
  // Issue #78 — guard against null/primitive ratios before using `'in'`.
  // Pre-fix code did `'dig' in ratioRaw` directly, which throws TypeError
  // for null / undefined / number / string / boolean. parseSaveFile is
  // called from loadSave inside a try/catch that swallows the throw and
  // returns null; the caller then treats the entire save as corrupt and
  // calls deleteSave + bootFresh, escalating a recoverable single-command
  // corruption into total save loss. Defensive shape-check keeps the rest
  // of the inputLog intact (the malformed command passes through verbatim
  // — the SetBehaviorRatio handler in tick.ts has its own type guard so
  // replay drops it cleanly).
  const ratioRaw: unknown = cmd.ratio;
  if (ratioRaw === null || typeof ratioRaw !== 'object') return cmd;
  // Already in the two-field form (no `dig` key) — pass through.
  if (!('dig' in ratioRaw)) return cmd;
  const migrated = migrateBehaviorRatio(ratioRaw);
  return { ...cmd, ratio: migrated };
}

// Exported for issue #112 v2-rejection test — verifies that parseSaveFile
// throws SaveVersionMismatchError on pre-v3 envelopes. loadSave swallows the
// throw so the contract can't be observed via the public surface.
export function parseSaveFile(raw: string): SaveFile {
  const parsed = JSON.parse(raw) as { version?: unknown; seed?: unknown };
  if (typeof parsed.version !== 'number') {
    throw new SaveVersionMismatchError(SAVE_FORMAT_VERSION, NaN);
  }
  if (parsed.version !== SAVE_FORMAT_VERSION) {
    throw new SaveVersionMismatchError(SAVE_FORMAT_VERSION, parsed.version);
  }
  // Issue #110 — envelope seed validation. buildSaveFile writes `seed | 0`
  // (signed int32 domain). Reject anything that wouldn't survive that
  // coercion losslessly. Without this guard, a tampered/malformed seed
  // continues to play from the snapshot, autosave silently coerces it to 0
  // on the next write, and the (seed, inputLog) → snapshot replay contract
  // is permanently broken. Throw routes the corrupt save through loadSave's
  // try/catch (returns null) → bootFresh.
  if (!isInt32(parsed.seed)) {
    throw new Error(`Invalid save envelope seed: ${String(parsed.seed)} (require int32)`);
  }
  const file = parsed as SaveFile;
  // Issue #103 — normalize non-array inputLog to []. parseSaveFile is the
  // only boundary; downstream `for (const c of loaded.inputLog)` in
  // game-scene.ts runs OUTSIDE the deserialize try/catch and would soft-
  // brick Continue with TypeError on a missing/null/non-array inputLog.
  // Replacing with `[]` lets the snapshot continue to play; the next
  // autosave restores a proper inputLog from that point.
  if (!Array.isArray(file.inputLog)) {
    (file as { inputLog: SimCommand[] }).inputLog = [];
  }
  // WR-09: walk inputLog and migrate any legacy SetBehaviorRatio entries so
  // SCEN-06 replay (`createScenario(seed) + tick(cmds[t])`) reproduces the
  // migrated snapshot. Other command types pass through.
  for (let i = 0; i < file.inputLog.length; i++) {
    file.inputLog[i] = migrateInputLogCommand(file.inputLog[i]!);
  }
  return file;
}

/**
 * Opportunistically purge superseded keys so existing players don't carry
 * rejected envelopes in localStorage indefinitely. Each version bump fully
 * supersedes the prior keys; pre-bump saves are intentionally rejected
 * (parseSaveFile throws SaveVersionMismatchError), so there is no recovery
 * path that needs the old data. Called from both hasSave and loadSave so the
 * purge fires on the first save-touching operation.
 *
 * Issue #112 — added v2 to the purge list when SAVE_KEY moved to v3.
 */
function purgeLegacySaves(): void {
  try { localStorage.removeItem('subterrans:save:v1'); } catch { /* quota / private mode — silent: best-effort cleanup, no UX signal */ }
  try { localStorage.removeItem('subterrans:save:v2'); } catch { /* quota / private mode — silent: best-effort cleanup, no UX signal */ }
}

export function hasSave(): boolean {
  try {
    purgeLegacySaves();
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw === null) return false;
    parseSaveFile(raw);
    return true;
  } catch {
    return false;
  }
}

export function loadSave(): SaveFile | null {
  try {
    purgeLegacySaves();
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw === null) return null;
    return parseSaveFile(raw);
  } catch {
    return null;
  }
}

export function deleteSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // swallow — quota / private-mode errors are non-fatal for delete
  }
}

// ---------------------------------------------------------------------------
// Issue #115 — manual save / save-info / incompatible-save detection
//
// The autosave path (tickAutosave) writes opportunistically every 30s. A
// manual "Save now" button needs an explicit write that doesn't disturb the
// autosave cooldown — so manualSave is a thin wrapper around buildSaveFile +
// setItem that does NOT update the lastSaveMs timer. The next autosave still
// fires on its own schedule, which is fine: a manual save followed by an
// autosave 5 seconds later costs one extra setItem call, not "two competing
// writers."
//
// hasIncompatibleSave distinguishes "no save in localStorage" from "save
// present but unreadable by this build" so the Save/Load dialog can surface
// a one-time recovery message instead of silently booting fresh.
//
// getSaveInfo extracts the cheap summary fields the dialog displays without
// running deserializeWorldState (which allocates typed arrays and validates
// every field). It only parses the JSON envelope and reads three primitive
// fields, so it's safe to call on every dialog open.
// ---------------------------------------------------------------------------

/** Issue #115 — manual save. Returns true on successful write, false on
 *  quota / private-mode / blocked-storage failure. Does NOT touch the
 *  autosave timer; callers driving tickAutosave keep their own lastSaveMs. */
export function manualSave(
  seed: number,
  inputLog: readonly SimCommand[],
  world: WorldState,
): boolean {
  try {
    const envelope = buildSaveFile(seed, inputLog, world);
    localStorage.setItem(SAVE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/** Issue #115 — true iff bytes exist under SAVE_KEY but parseSaveFile cannot
 *  read them (wrong version, corrupt envelope, future simVersion). Distinct
 *  from `hasSave === false` which can mean "no save written yet" OR "save
 *  present but unreadable" — the Save/Load dialog needs to tell the player
 *  the difference so a v2 save in localStorage doesn't silently disappear
 *  on a New Game click. */
export function hasIncompatibleSave(): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  try {
    parseSaveFile(raw);
    return false;
  } catch {
    return true;
  }
}

/** Lightweight save summary surfaced in the Save/Load dialog's info line.
 *  Avoids deserializeWorldState (which allocates the full typed-array world)
 *  by reading only three primitives from the JSON envelope. */
export interface SaveInfo {
  /** Sim tick at the moment the snapshot was taken. */
  tick: number;
  /** Player colony's living worker count, or 0 when the field is missing. */
  playerWorkers: number;
  /** Player colony's stored-food count in HUMAN units (post `>> FP_SHIFT`). */
  playerFoodStored: number;
}

/** Issue #115 — extract the dialog's summary fields without a full
 *  deserialize. Returns null if no save exists or the envelope is unreadable.
 *  Player colony key is `String(PLAYER_COLONY_ID)` per the colonies map's
 *  stringified-int convention (ADR-0006). */
export function getSaveInfo(): SaveInfo | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let file: SaveFile;
  try {
    file = parseSaveFile(raw);
  } catch {
    return null;
  }
  const playerKey = String(PLAYER_COLONY_ID);
  const playerColony = file.snapshot.colonies[playerKey];
  // foodStored is fixed-point; convert to whole-food units for display.
  // Right-shift is safe here: foodStored is a non-negative int in the
  // serialized envelope (validated upstream).
  const foodFp = playerColony?.foodStored ?? 0;
  return {
    tick: file.snapshot.tick,
    playerWorkers: playerColony?.workerCount ?? 0,
    playerFoodStored: foodFp >> FP_SHIFT,
  };
}

/**
 * Autosave gate. Returns the new lastSaveMs value:
 *   - interval not elapsed → returns lastSaveMs unchanged, no write
 *   - elapsed + setItem success → returns nowMs
 *   - elapsed + setItem throw (quota / private-mode / blocked) → returns
 *     nowMs (retry one interval later, NOT every frame)
 *
 * Issue #80 — pre-fix code returned lastSaveMs on failure, so the next
 * frame instantly satisfied `nowMs - lastSaveMs >= AUTOSAVE_INTERVAL_MS`
 * and tried again immediately. At 60 FPS that's ~60 attempts/sec each
 * re-stringifying the entire WorldState (megabytes). Honoring the
 * cooldown by advancing to nowMs converts the retry storm into one
 * attempt every AUTOSAVE_INTERVAL_MS even when storage is full/blocked.
 *
 * Caller reassigns: `lastSaveMs = tickAutosave(seed, inputLog, world, lastSaveMs, now);`
 */
export function tickAutosave(
  seed: number,
  inputLog: readonly SimCommand[],
  world: WorldState,
  lastSaveMs: number,
  nowMs: number,
): number {
  if (nowMs - lastSaveMs < AUTOSAVE_INTERVAL_MS) return lastSaveMs;
  try {
    const envelope = buildSaveFile(seed, inputLog, world);
    localStorage.setItem(SAVE_KEY, JSON.stringify(envelope));
    return nowMs;
  } catch {
    // Honor the cooldown on failure too — see #80 above.
    return nowMs;
  }
}
