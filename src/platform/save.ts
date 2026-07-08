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

import type { WorldState, EntityId, AIStateRecord, SpiderState } from '../sim/types.js';
import { LATEST_SIM_VERSION, SIM_VERSION_V30_UNDERGROUND_EMBEDDING_GUARDS } from '../sim/types.js';
import { AI_MAX_OPERATION_FIGHTERS, SPIDER_HUNT_INTERVAL_TICKS } from '../sim/constants.js';
import type { AntComponents } from '../sim/ant/ant-store.js';
import {
  createAntComponents,
  RECENT_TILES_LEN,
  RECENT_TILES_SENTINEL,
} from '../sim/ant/ant-store.js';
import type {
  ColonyId,
  ColonyRecord,
  WorkerAllocation,
  ChamberRecord,
} from '../sim/colony/colony-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import type { PendingChamber } from '../sim/colony/chamber.js';
import type { SimCommand } from '../sim/commands.js';
import { getStorageDriver } from './storage.js';
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
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import {
  validateSurfaceConnectivity,
  ensureSurfaceComponentMask,
} from '../sim/surface-features.js';

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
//
// NOTE (Issue #161): the Mulberry32 `>>> 0` state fix in rng.ts does NOT
// require a format bump. `>>> 0` and the prior `| 0` coercion preserve the
// same 32 bits, so a v3 save's `rngState` reloads to an identical PRNG output
// sequence either way — there is no on-disk incompatibility to reject.
//
// PR 4 (static terrain) deliberately does NOT bump SAVE_FORMAT_VERSION: the new
// required `bakedSurfaceEffect` lives in the SNAPSHOT (SerializedWorldState), and
// snapshot-content shape changes are gated by `simVersion`, not the envelope's
// SAVE_FORMAT_VERSION (which versions the envelope structure). Raising
// MIN_ACCEPTED_SIM_VERSION to V28 rejects every pre-static-terrain save — which
// also lacks the field — before unpack is reached, matching the v2/v3 precedent.
export const SAVE_FORMAT_VERSION = 3 as const;
export const SAVE_KEY = 'subterrans:save:v3' as const;
export const AUTOSAVE_INTERVAL_MS = 30_000 as const;

export class SaveVersionMismatchError extends Error {
  // #229 — explicit fields (not `constructor(public …)` parameter properties):
  // parameter properties are unsupported by Node's strip-only TypeScript loader,
  // and the cross-engine determinism proof runs save.ts under `node
  // --experimental-strip-types`. Behaviour is identical (pure desugaring).
  expected: number;
  got: number;
  constructor(expected: number, got: number) {
    super(`Save format version mismatch: expected ${expected}, got ${got}`);
    this.name = 'SaveVersionMismatchError';
    this.expected = expected;
    this.got = got;
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
  // #229 — explicit fields (see SaveVersionMismatchError): strip-only Node compat.
  got: number;
  latest: number;
  constructor(got: number, latest: number) {
    super(`Save's simVersion (${got}) is newer than this build's LATEST (${latest})`);
    this.name = 'FutureSimVersionError';
    this.got = got;
    this.latest = latest;
  }
}

// PR 6-sim (posture 2): the underground-embedding guards change descent and
// underground-mutation behaviour, so a pre-V30 save would replay differently.
// Raise the floor to reject pre-V30 saves cleanly. (Supersedes the PR 5 V29
// floor; path-aware-routing + static-terrain reasoning still applies.)
export const MIN_ACCEPTED_SIM_VERSION = SIM_VERSION_V30_UNDERGROUND_EMBEDDING_GUARDS;

/**
 * #228 window policy — deliberate-break escape hatch (version-scoped).
 *
 * POLICY (ARCHITECTURE.md Principle 7): `MIN_ACCEPTED_SIM_VERSION` stays put while
 * `LATEST_SIM_VERSION` advances, so saves within the window keep loading — each
 * behavior change ships a sticky `simVersion >=` gate instead. Raising MIN wipes
 * real players' localStorage saves and orphans in-flight playtrace uploads (they
 * keep arriving from the previous deploy for days), so it is a deliberate
 * exception, not the default posture.
 *
 * This records WHICH version a deliberate break was declared at (`null` = no
 * active break), so a stale flag can't ride silently through a later break. The
 * guard in `version-policy.test.ts` enforces:
 *     BREAK_AT === null ? MIN < LATEST : (MIN === LATEST && BREAK_AT === LATEST)
 *
 * THE RITUAL for a deliberate compat break (a change that genuinely cannot be
 * gated — e.g. a stored-field semantics change like V28/V30):
 *   1. In the breaking PR: raise MIN to LATEST AND set this to that new LATEST,
 *      and justify the player-facing save wipe in the PR description.
 *   2. In the NEXT PR that bumps LATEST while leaving MIN behind: set this back to
 *      `null` (the guard test fails until you do). Never leave a stale version here.
 *
 * Now `null`: #225 (V31) is the first behavior PR to bump LATEST past V30 while
 * leaving MIN at V30, re-opening the acceptance window (V30..LATEST), so the
 * deliberate V30 break declared at HEAD is retired per step 2 of the ritual. It
 * stays `null` until some future PR runs the ritual again (raise MIN to LATEST +
 * set this to that LATEST).
 */
export const DELIBERATE_WINDOW_BREAK_AT: number | null = null;

export class OldSimVersionError extends Error {
  // #229 — explicit field (see SaveVersionMismatchError): strip-only Node compat.
  got: number | null;
  constructor(got: number | null) {
    const gotStr = got !== null ? String(got) : 'unknown';
    super(
      `Save is from an older version (simVersion=${gotStr}); minimum accepted is ${MIN_ACCEPTED_SIM_VERSION}. Please start a new game.`,
    );
    this.name = 'OldSimVersionError';
    this.got = got;
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
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= -0x80000000 &&
    value <= 0x7fffffff
  );
}

/** Cap on how many entries each top-level Object map may carry on load.
 *  Issue #99 — defense against memory-DoS via unbounded `Object.entries`
 *  loops in deserializeWorldState. Numbers are 4-8× current scenario use,
 *  ample headroom for future scenario tweaks; anything above is tampering. */
const MAX_COLONIES_LOAD = 16; // current LIVE_COLONY_COUNT = 2.
const MAX_PHEROMONE_GRID_KEYS = 16; // current = 8 (2 colonies × 2 types × 2 zones).
const MAX_PENDING_CHAMBERS = 256; // few per colony in normal play.
const MAX_FOOD_PILES = FOOD_PILE_COUNT * 4; // issue #109.

/** Issue #99 — verify a serialized grid object matches the canonical
 *  dimensions and has an array-like data field. Width/height are PRD-locked
 *  (`src/sim/constants.ts`); a future change to grid size would correctly
 *  require a save-format bump anyway, so a strict equality check is the
 *  right strictness level here. */
function validateGridShape(s: unknown, expectedW: number, expectedH: number, label: string): void {
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
  if (
    typeof c.chamberId !== 'number' ||
    !Number.isInteger(c.chamberId) ||
    c.chamberId < 0 ||
    c.chamberId > MAX_ENTITIES
  ) {
    throw new Error(`Invalid ${label}.chamberId: ${String(c.chamberId)}`);
  }
  if (
    typeof c.chamberType !== 'number' ||
    !Number.isInteger(c.chamberType) ||
    c.chamberType < 0 ||
    c.chamberType > 2
  ) {
    throw new Error(`Invalid ${label}.chamberType: ${String(c.chamberType)}`);
  }
  const dims = CHAMBER_DIMENSIONS[c.chamberType];
  if (c.width !== dims.width || c.height !== dims.height) {
    throw new Error(
      `Invalid ${label} dims for type ${c.chamberType}: ` +
        `${String(c.width)}x${String(c.height)} (expected ${dims.width}x${dims.height})`,
    );
  }
  // posX/posY are FP coords; require integer in [0, gridSize<<FP_SHIFT).
  const ugWidthFp = UNDERGROUND_GRID_WIDTH << FP_SHIFT;
  const ugHeightFp = UNDERGROUND_GRID_HEIGHT << FP_SHIFT;
  if (
    typeof c.posX !== 'number' ||
    !Number.isInteger(c.posX) ||
    c.posX < 0 ||
    c.posX >= ugWidthFp
  ) {
    throw new Error(`Invalid ${label}.posX: ${String(c.posX)}`);
  }
  if (
    typeof c.posY !== 'number' ||
    !Number.isInteger(c.posY) ||
    c.posY < 0 ||
    c.posY >= ugHeightFp
  ) {
    throw new Error(`Invalid ${label}.posY: ${String(c.posY)}`);
  }
  if (
    typeof c.foodStored !== 'number' ||
    !Number.isInteger(c.foodStored) ||
    c.foodStored < 0 ||
    c.foodStored > FOOD_CHAMBER_CAPACITY
  ) {
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
  if (
    typeof p.chamberType !== 'number' ||
    !Number.isInteger(p.chamberType) ||
    p.chamberType < 0 ||
    p.chamberType > 2
  ) {
    throw new Error(`Invalid ${label}.chamberType: ${String(p.chamberType)}`);
  }
  if (!isTileCoord(p.anchorTileX, UNDERGROUND_GRID_WIDTH)) {
    throw new Error(`Invalid ${label}.anchorTileX: ${String(p.anchorTileX)}`);
  }
  if (!isTileCoord(p.anchorTileY, UNDERGROUND_GRID_HEIGHT)) {
    throw new Error(`Invalid ${label}.anchorTileY: ${String(p.anchorTileY)}`);
  }
  const dims = CHAMBER_DIMENSIONS[p.chamberType];
  if (p.width !== dims.width || p.height !== dims.height) {
    throw new Error(
      `Invalid ${label} dims for type ${p.chamberType}: ` +
        `${String(p.width)}x${String(p.height)} (expected ${dims.width}x${dims.height})`,
    );
  }
  if (
    (p.anchorTileX as number) + dims.width > UNDERGROUND_GRID_WIDTH ||
    (p.anchorTileY as number) + dims.height > UNDERGROUND_GRID_HEIGHT
  ) {
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
  if (
    typeof fp.foodPileId !== 'number' ||
    !Number.isInteger(fp.foodPileId) ||
    fp.foodPileId < 0 ||
    fp.foodPileId > MAX_ENTITIES
  ) {
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
  if (
    typeof fp.pickupsInitial !== 'number' ||
    !Number.isInteger(fp.pickupsInitial) ||
    fp.pickupsInitial < FOOD_PILE_INITIAL_PICKUPS_MIN ||
    fp.pickupsInitial > FOOD_PILE_INITIAL_PICKUPS_MAX
  ) {
    throw new Error(`Invalid ${label}.pickupsInitial: ${String(fp.pickupsInitial)}`);
  }
  // pickupsRemaining: integer in [1, pickupsInitial]. Live piles always have
  // at least one charge — the runtime splices at zero so saves should never
  // observe a 0 here. Above-initial means tampering or accidental re-creation.
  if (
    typeof fp.pickupsRemaining !== 'number' ||
    !Number.isInteger(fp.pickupsRemaining) ||
    fp.pickupsRemaining <= 0 ||
    fp.pickupsRemaining > fp.pickupsInitial
  ) {
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
  count: number; // we persist capacity = MAX_ENTITIES; no separate count field exists on AntComponents
  // All 18 Int32Array fields as plain number[]:
  posX: number[];
  posY: number[];
  colonyId: number[];
  task: number[];
  subTask: number[];
  speed: number[];
  foodCarrying: number[];
  starvationTimer: number[];
  age: number[];
  alive: number[];
  lifespan: number[];
  zone: number[];
  digTileX: number[];
  digTileY: number[];
  digTicksRemaining: number[];
  targetPosX: number[];
  targetPosY: number[];
  searchWave: number[];
  searchHeadingX: number[];
  searchHeadingY: number[];
  searchHeadingTicks: number[];
  searchPrevTileX: number[];
  searchPrevTileY: number[];
  currentGridColonyId: number[];
  waitingDeposit: number[];
  // #243 — write-only vestige of the deleted runtime `pathErr` field. The runtime
  // AntComponents.pathErr is gone (dead Bresenham accumulator), but the save format
  // keeps emitting a zeros array so an OLDER build (which still reads this key via
  // copyIntoInt32) never chokes on a missing field and deleteSave()s a save written
  // by a newer build — including MIGRATED saves that keep their in-window sticky
  // simVersion. Reap this vestige once MIN_ACCEPTED_SIM_VERSION > V32 (the LATEST
  // when it shipped): then every save a post-reap build writes is stamped > V32, so
  // an old pathErr-reading build rejects it as FutureSimVersionError (preserved, not
  // corrupt) at the version gate before the ant shape ever matters. Deserialize
  // ignores it.
  pathErr: number[];
  searchPauseTicks: number[];
  // PR 5 C-both — recent-tiles ring, COMPACT canonical encoding (not the flat
  // maxEntities×RECENT_TILES_LEN arrays, which would triple save size and blow
  // the ≤+5% quota when N deepened from 4). A flat number[] stream of records
  // sorted by antId; each record is [antId, head, count, (slot,x,y)×count] for
  // every ant with antId < nextEntityId AND ≥1 non-sentinel slot. Round-trips
  // the ring EXACTLY (slot order + head preserved); load rejects malformed data.
  recentTiles: number[];
  carryingBroodId: number[];
  carriedBy: number[];
  hp: number[];
  homeGroundBonusHp: number[];
  attackCooldown: number[];
  combatOpponentId: number[];
}

interface SerializedColony {
  colonyId: ColonyId;
  queenEntityId: EntityId;
  queenStarvationTimer: number;
  foodStored: number;
  workerCount: number;
  eggCount: number;
  larvaeCount: number;
  nurseCount: number;
  eggs: EntityId[];
  larvae: EntityId[];
  workers: EntityId[];
  chambers: ChamberRecord[];
  queenLastEggTick: number;
  targetRatio: { forage: number; fight: number };
  computedAllocation: WorkerAllocation;
  taskCensus: WorkerAllocation;
  defeated: boolean;
  reconcileCountdown: number;
  entrances: NestEntrance[];
  rallyPoint: { tileX: number; tileY: number } | null;
  digFlowFieldDirty: boolean;
  foodFlowFieldDirty: boolean;
  broodFieldDirty?: boolean; // #235 — optional: absent on pre-#235 saves (deserialize defaults false)
  killCount: number;
  priorityFoodPileId: FoodPileId | null;
  eggIntervalNumerator: number;
}

interface SerializedGrid {
  width: number;
  height: number;
  data: number[];
}

/** S3 — serialized form of SpiderState. All fields are plain numbers/strings. */
interface SerializedSpiderState {
  state: string;
  posX: number;
  posY: number;
  lairTileX: number;
  lairTileY: number;
  territoryRadiusTiles: number;
  hp: number;
  attackCooldown: number;
  hungerTicks: number;
  nextHuntTick: number;
  huntStartTick: number;
  strikeStartTick: number;
  feedingStartTick: number;
  retreatStartTick: number;
  rampageStartTick: number;
  huntTargetTileX: number;
  huntTargetTileY: number;
  killsThisStrike: number;
  rampageKillsThisRampage: number;
  rampageTargetColonyId: number;
  chaseTargetAntId: number;
  chaseStartTick: number;
  killedThisTick: number;
  lastKillTileX: number;
  lastKillTileY: number;
  feedAwayTileX: number;
  feedAwayTileY: number;
  feedArrivedTick: number;
}

/** S2 — serialized form of AIStateRecord. operationFighterIds stored as number[]. */
interface SerializedAIStateRecord {
  colonyId: number;
  state: string;
  enteredTick: number;
  probeCount: number;
  lastProbeEndTick: number;
  invasionStartTick: number;
  invasionRallyTileX: number;
  invasionRallyTileY: number;
  recoveryEndTick: number;
  operationKind: string;
  operationStartTick: number;
  operationTargetTileX: number;
  operationTargetTileY: number;
  operationFighterIds: number[];
  operationFighterCount: number;
  operationStartFighterCount: number;
  operationAttackerDeaths: number;
  operationDefenderDeaths: number;
}

export interface SerializedWorldState {
  tick: number;
  rngState: number;
  nextEntityId: number;
  simVersion: number;
  droppedCombatKillCount: number;
  droppedStructuralCount: number;
  terrainSeed: number;
  commandQueue: SimCommand[];
  ants: SerializedAnts;
  colonies: Record<string, SerializedColony>;
  pheromoneGrids: Record<string, SerializedGrid>;
  surface: SerializedGrid;
  /**
   * PR 4 — frozen surface movement-effect grid, packed 2 bits/tile then base64.
   * `SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT` entries (values 0/1/2). ~5.5 KB
   * vs ~48 KB for a raw number[] — keeps the save-size delta well within quota.
   */
  bakedSurfaceEffect: string;
  undergroundGrids: Record<string, SerializedGrid>;
  foodPiles: FoodPile[];
  recentlyDepletedFood: DepletionRecord[];
  pendingChambers: Record<string, PendingChamber>;
  aiState: SerializedAIStateRecord[];
  spider: SerializedSpiderState | null;
  spiderPriorityColonyId: number | null;
  scatterReticleTile: { x: number; y: number } | null;
  difficulty: 'Easy' | 'Normal' | 'Hard';
}

// ---------------------------------------------------------------------------
// SaveFile envelope — PRD §8a normative shape
// ---------------------------------------------------------------------------

export interface SaveFile {
  readonly version: number;
  readonly seed: number;
  readonly inputLog: SimCommand[];
  readonly snapshot: SerializedWorldState;
  /**
   * Issue #115 — wall-clock timestamp (Date.now() epoch ms) when the
   * envelope was written. Populated by buildSaveFile so all writers
   * (manualSave + tickAutosave) include it consistently. Optional in the
   * type so older envelopes without the field still load — getSaveInfo
   * falls back to 0 ("unknown") for the dialog when the field is absent.
   */
  readonly savedAtMs?: number;
}

// ---------------------------------------------------------------------------
// Serialize helpers
// ---------------------------------------------------------------------------

/**
 * PR 5 C-both — encode the per-ant recent-tiles ring compactly. Emits a flat
 * number[] stream of records sorted by ascending antId; each record is
 * `[antId, head, count, (slot, x, y)×count]` for every ALIVE ant with `antId <
 * nextEntityId` AND at least one non-sentinel slot. Slots are emitted in
 * ascending slot order so the encoding is canonical (a given ring state always
 * serializes identically). Dead-but-allocated ants are skipped: entity ids are
 * never reused and dead rings are never read (all isRecentTile/detour consumers
 * run only for alive ants), so serializing them would only leak save size
 * monotonically — an ant killed mid-Searching/CarryingFood (combat, starvation,
 * lifespan) keeps its populated ring in memory forever. Old saves that contain
 * dead-ant records still load (unpack doesn't check alive) and self-heal here
 * on the next save.
 */
function packRecentTiles(a: AntComponents, nextEntityId: number): number[] {
  const out: number[] = [];
  const limit = Math.min(nextEntityId, a.recentTilesHead.length);
  for (let id = 0; id < limit; id++) {
    if (a.alive[id] !== 1) continue;
    const base = id * RECENT_TILES_LEN;
    let count = 0;
    for (let s = 0; s < RECENT_TILES_LEN; s++) {
      if (a.recentTilesX[base + s] !== RECENT_TILES_SENTINEL) count++;
    }
    if (count === 0) continue;
    out.push(id, a.recentTilesHead[id]!, count);
    for (let s = 0; s < RECENT_TILES_LEN; s++) {
      if (a.recentTilesX[base + s] !== RECENT_TILES_SENTINEL) {
        out.push(s, a.recentTilesX[base + s]!, a.recentTilesY[base + s]!);
      }
    }
  }
  return out;
}

/**
 * PR 5 C-both — decode + VALIDATE the compact recent-tiles stream into the
 * (already sentinel-filled) ant arrays, reconstructing the identical ring. Load
 * rejects (throws) malformed data: non-array stream, truncated record, antId out
 * of range or not strictly ascending (duplicate / unsorted), head/slot/count out
 * of range, duplicate or non-ascending slot within a record, or out-of-range
 * coords. Slots absent from a record stay sentinel; head is restored verbatim.
 */
function unpackRecentTiles(
  a: AntComponents,
  stream: unknown,
  nextEntityId: number,
  capacity: number,
): void {
  if (!Array.isArray(stream)) throw new Error('recentTiles: not an array');
  // The shared ring holds either surface (SearchingFood) or underground
  // (CarryingFood) tiles, and the stream carries no zone tag, so each axis is
  // bounded by the widest legitimate value across both grids: x by the max grid
  // WIDTH, y by the max grid HEIGHT. The two grids share a width (128) but
  // differ in height (surface 128, underground 64), so y must use the surface
  // ceiling — using the smaller underground height would reject valid surface
  // recent-tiles, while a single conflated coordMax let stray coords through on
  // the narrower axis.
  const xMax = Math.max(SURFACE_GRID_WIDTH, UNDERGROUND_GRID_WIDTH);
  const yMax = Math.max(SURFACE_GRID_HEIGHT, UNDERGROUND_GRID_HEIGHT);
  let i = 0;
  let prevAntId = -1;
  while (i < stream.length) {
    if (i + 3 > stream.length) throw new Error('recentTiles: truncated record header');
    const antId = stream[i++] as number;
    const head = stream[i++] as number;
    const count = stream[i++] as number;
    // Bound by BOTH nextEntityId AND capacity. nextEntityId is the canonical
    // bound — the serializer only emits records for antId < nextEntityId, so a
    // record for a never-allocated id is something serialize can never produce.
    // capacity is the memory-safety bound — the ring arrays are sized
    // capacity * RECENT_TILES_LEN, and a tampered save can set ants.count
    // (→ capacity) and nextEntityId independently (both only checked against
    // MAX_ENTITIES), so without the capacity check an antId in [capacity,
    // nextEntityId) would index out of bounds (a silent TypedArray no-op, but it
    // breaks "load is strictly the inverse of save"). Legitimate saves persist
    // count = MAX_ENTITIES ≥ nextEntityId, so both bounds coincide.
    if (!Number.isInteger(antId) || antId < 0 || antId >= nextEntityId || antId >= capacity) {
      throw new Error(
        `recentTiles: antId ${antId} out of range [0, min(${nextEntityId},${capacity}))`,
      );
    }
    if (antId <= prevAntId) throw new Error(`recentTiles: antId ${antId} not strictly ascending`);
    prevAntId = antId;
    if (!Number.isInteger(head) || head < 0 || head >= RECENT_TILES_LEN) {
      throw new Error(`recentTiles: head ${head} out of range [0,${RECENT_TILES_LEN})`);
    }
    if (!Number.isInteger(count) || count < 1 || count > RECENT_TILES_LEN) {
      throw new Error(`recentTiles: count ${count} out of range [1,${RECENT_TILES_LEN}]`);
    }
    if (i + count * 3 > stream.length) throw new Error('recentTiles: truncated record body');
    const base = antId * RECENT_TILES_LEN;
    let prevSlot = -1;
    for (let c = 0; c < count; c++) {
      const slot = stream[i++] as number;
      const x = stream[i++] as number;
      const y = stream[i++] as number;
      if (!Number.isInteger(slot) || slot < 0 || slot >= RECENT_TILES_LEN) {
        throw new Error(`recentTiles: slot ${slot} out of range [0,${RECENT_TILES_LEN})`);
      }
      if (slot <= prevSlot) throw new Error(`recentTiles: slot ${slot} not strictly ascending`);
      prevSlot = slot;
      if (!Number.isInteger(x) || x < 0 || x >= xMax) {
        throw new Error(`recentTiles: x ${x} out of range [0,${xMax})`);
      }
      if (!Number.isInteger(y) || y < 0 || y >= yMax) {
        throw new Error(`recentTiles: y ${y} out of range [0,${yMax})`);
      }
      a.recentTilesX[base + slot] = x;
      a.recentTilesY[base + slot] = y;
    }
    a.recentTilesHead[antId] = head;
  }
}

function serializeAnts(a: AntComponents, nextEntityId: number): SerializedAnts {
  // Persist the full array (MAX_ENTITIES length). The deserializer allocates the
  // same size, so unused slots (alive=0) round-trip faithfully.
  return {
    count: a.alive.length,
    posX: Array.from(a.posX),
    posY: Array.from(a.posY),
    colonyId: Array.from(a.colonyId),
    task: Array.from(a.task),
    subTask: Array.from(a.subTask),
    speed: Array.from(a.speed),
    foodCarrying: Array.from(a.foodCarrying),
    starvationTimer: Array.from(a.starvationTimer),
    age: Array.from(a.age),
    alive: Array.from(a.alive),
    lifespan: Array.from(a.lifespan),
    zone: Array.from(a.zone),
    digTileX: Array.from(a.digTileX),
    digTileY: Array.from(a.digTileY),
    digTicksRemaining: Array.from(a.digTicksRemaining),
    targetPosX: Array.from(a.targetPosX),
    targetPosY: Array.from(a.targetPosY),
    searchWave: Array.from(a.searchWave),
    searchHeadingX: Array.from(a.searchHeadingX),
    searchHeadingY: Array.from(a.searchHeadingY),
    searchHeadingTicks: Array.from(a.searchHeadingTicks),
    searchPrevTileX: Array.from(a.searchPrevTileX),
    searchPrevTileY: Array.from(a.searchPrevTileY),
    // Phase 09.1 Chunk 0 — grid-of-occupancy byte. Array.from works for both
    // Int32Array and Uint8Array, so the shape is identical to the other
    // per-ant fields (number[]).
    currentGridColonyId: Array.from(a.currentGridColonyId),
    // Issue #27 — carrier wait flag (Uint8Array; serialized as number[]).
    waitingDeposit: Array.from(a.waitingDeposit),
    // #243 — write-only zeros vestige of the deleted runtime pathErr field (see
    // SerializedAnts.pathErr). Emitting all-zeros is byte-identical to the old
    // serialization (the field was never written, so it was always zeros).
    pathErr: new Array<number>(a.posX.length).fill(0),
    searchPauseTicks: Array.from(a.searchPauseTicks),
    // PR 5 C-both — recent-tiles ring, compact canonical encoding (see
    // packRecentTiles). Round-trips the ring exactly for SCEN-06 determinism.
    recentTiles: packRecentTiles(a, nextEntityId),
    // Issue #17 Phase 1 — visible brood carry slot + reverse pointer.
    carryingBroodId: Array.from(a.carryingBroodId),
    carriedBy: Array.from(a.carriedBy),
    // S1 — combat HP/damage/cooldown fields.
    hp: Array.from(a.hp),
    homeGroundBonusHp: Array.from(a.homeGroundBonusHp),
    attackCooldown: Array.from(a.attackCooldown),
    combatOpponentId: Array.from(a.combatOpponentId),
  };
}

function serializeColony(c: ColonyRecord): SerializedColony {
  return {
    colonyId: c.colonyId,
    queenEntityId: c.queenEntityId,
    queenStarvationTimer: c.queenStarvationTimer,
    foodStored: c.foodStored,
    workerCount: c.workerCount,
    eggCount: c.eggCount,
    larvaeCount: c.larvaeCount,
    nurseCount: c.nurseCount,
    eggs: [...c.eggs],
    larvae: [...c.larvae],
    workers: [...c.workers],
    chambers: c.chambers.map((ch) => ({ ...ch })),
    targetRatio: { ...c.targetRatio },
    computedAllocation: { ...c.computedAllocation },
    taskCensus: { ...c.taskCensus },
    defeated: c.defeated,
    reconcileCountdown: c.reconcileCountdown,
    queenLastEggTick: c.queenLastEggTick,
    entrances: c.entrances.map((e) => ({ ...e })),
    rallyPoint: c.rallyPoint === null ? null : { ...c.rallyPoint },
    digFlowFieldDirty: c.digFlowFieldDirty,
    foodFlowFieldDirty: c.foodFlowFieldDirty,
    broodFieldDirty: c.broodFieldDirty, // #235
    killCount: c.killCount,
    priorityFoodPileId: c.priorityFoodPileId,
    eggIntervalNumerator: c.eggIntervalNumerator,
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

// ---------------------------------------------------------------------------
// PR 4 — baked surface terrain pack/unpack (2 bits/tile) + cross-env base64.
// Pure, table-based base64 (no Buffer/btoa dependency) so it works identically
// in Node and the browser. Values are 0/1/2 (Cosmetic/SoftCost/HardBlock); the
// 2-bit code 3 is never produced and is rejected on load as a corrupt enum.
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      '=';
  }
  return out;
}

/** Decode base64 → bytes. Returns null on any malformed input (bad char,
 *  length not a multiple of 4) so the caller can reject the save loudly. */
function base64ToBytes(s: string): Uint8Array | null {
  if (s.length % 4 !== 0) return null;
  const lut = new Int16Array(128).fill(-1);
  for (let k = 0; k < BASE64_ALPHABET.length; k++) lut[BASE64_ALPHABET.charCodeAt(k)] = k;
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  const outLen = (s.length >> 2) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const isFinalQuartet = i + 4 === s.length;
    const c0 = lut[s.charCodeAt(i)] ?? -1;
    const c1 = lut[s.charCodeAt(i + 1)] ?? -1;
    const ch2 = s[i + 2];
    const ch3 = s[i + 3];
    // `=` padding is only legal in the final quartet, in standard positions
    // (c3, or c2+c3). Anywhere else it's a corrupt encoding — reject (Codex P2).
    if ((ch2 === '=' || ch3 === '=') && !isFinalQuartet) return null;
    if (ch2 === '=' && ch3 !== '=') return null; // "x=y" is never valid
    const c2 = ch2 === '=' ? 0 : (lut[s.charCodeAt(i + 2)] ?? -1);
    const c3 = ch3 === '=' ? 0 : (lut[s.charCodeAt(i + 3)] ?? -1);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

/** Pack a per-tile effect grid (valid values 0=Cosmetic/1=SoftCost/2=HardBlock)
 *  into 2-bit codes, base64-encoded. Throws on any out-of-range value so an
 *  already-corrupt in-memory grid fails at the WRITE rather than masking to a
 *  wrong-but-loadable terrain (`& 0x3` would launder a 4 into Cosmetic; a 3 would
 *  only fail at the next load via unpack's code-3 guard). */
function packBakedSurfaceEffect(grid: Uint8Array): string {
  const packed = new Uint8Array((grid.length + 3) >> 2);
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]!;
    if (v > 2) throw new Error(`packBakedSurfaceEffect: out-of-range effect ${v} at tile ${i}`);
    const pi = i >> 2;
    packed[pi] = packed[pi]! | (v << ((i & 3) << 1));
  }
  return bytesToBase64(packed);
}

/**
 * Decode + validate a packed baked-surface grid. Returns the Uint8Array of
 * `expectedLen` effect values, or null if the string is malformed, the wrong
 * length, or contains an out-of-range (code 3) effect — every failure mode the
 * load validator must reject.
 */
export function unpackBakedSurfaceEffect(s: string, expectedLen: number): Uint8Array | null {
  if (typeof s !== 'string') return null;
  // DoS guard (issue #99 posture): reject by LENGTH before decoding, so a
  // tampered localStorage save with an arbitrarily long valid-base64 string
  // can't force a large allocation + O(n) decode in base64ToBytes before the
  // post-decode size check rejects it. The exact base64 length for a
  // `expectedLen`-tile grid is ceil(packedBytes / 3) * 4.
  const packedBytes = (expectedLen + 3) >> 2;
  const expectedB64Len = (((packedBytes + 2) / 3) | 0) * 4;
  if (s.length !== expectedB64Len) return null;
  const packed = base64ToBytes(s);
  if (packed === null) return null;
  if (packed.length !== packedBytes) return null;
  const grid = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    const v = (packed[i >> 2]! >> ((i & 3) << 1)) & 0x3;
    if (v === 3) return null; // 0/1/2 only — code 3 is a corrupt enum value
    grid[i] = v;
  }
  // When expectedLen isn't a multiple of 4 the final packed byte has unused high
  // bits; serialize always leaves them 0, so non-zero bits mean a tampered/
  // malformed payload that decodes to a grid we'd never emit — reject it. (No-op
  // for the production 16384-tile grid, but keeps this exported, length-general
  // validator honest.)
  const rem = expectedLen & 3;
  if (rem !== 0 && packed[packed.length - 1]! >> (rem << 1) !== 0) return null;
  return grid;
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
    commandQueue: world.commandQueue.map((c) => ({ ...c })), // Pitfall 7 — preserve
    ants: serializeAnts(world.ants, world.nextEntityId),
    colonies: coloniesOut,
    pheromoneGrids: pheromoneOut,
    surface: serializeSurfaceGrid(world.surface),
    bakedSurfaceEffect: packBakedSurfaceEffect(world.bakedSurfaceEffect),
    undergroundGrids: undergroundOut,
    foodPiles: world.foodPiles.map((p) => ({ ...p })),
    recentlyDepletedFood: world.recentlyDepletedFood.map((r) => ({ ...r })),
    pendingChambers: pendingOut,
    // S0b: persist overflow counters; skip events (transient per design).
    droppedCombatKillCount: world.droppedCombatKillCount,
    droppedStructuralCount: world.droppedStructuralCount,
    // S3 — spider entity.
    spider: world.spider === null ? null : { ...world.spider },
    spiderPriorityColonyId: world.spiderPriorityColonyId,
    scatterReticleTile: world.scatterReticleTile === null ? null : { ...world.scatterReticleTile },
    // S5 — difficulty tier.
    difficulty: world.difficulty,
    // S2 — AI state machine records. operationFighterIds stored as number[].
    aiState: world.aiState.map((rec) => ({
      colonyId: rec.colonyId,
      state: rec.state,
      enteredTick: rec.enteredTick,
      probeCount: rec.probeCount,
      lastProbeEndTick: rec.lastProbeEndTick,
      invasionStartTick: rec.invasionStartTick,
      invasionRallyTileX: rec.invasionRallyTileX,
      invasionRallyTileY: rec.invasionRallyTileY,
      recoveryEndTick: rec.recoveryEndTick,
      operationKind: rec.operationKind,
      operationStartTick: rec.operationStartTick,
      operationTargetTileX: rec.operationTargetTileX,
      operationTargetTileY: rec.operationTargetTileY,
      operationFighterIds: Array.from(rec.operationFighterIds),
      operationFighterCount: rec.operationFighterCount,
      operationStartFighterCount: rec.operationStartFighterCount,
      operationAttackerDeaths: rec.operationAttackerDeaths,
      operationDefenderDeaths: rec.operationDefenderDeaths,
    })),
  };
}

// ---------------------------------------------------------------------------
// Deserialize helpers
// ---------------------------------------------------------------------------

/**
 * Validate `simVersion` at the save boundary.
 *
 * Throws one of two typed errors so the caller can differentiate recoverable
 * from definitively-obsolete:
 *   - simVersion missing / non-integer / < MIN_ACCEPTED → `OldSimVersionError`
 *     (obsolete save; user must start a new game)
 *   - simVersion > LATEST → `FutureSimVersionError` (recoverable: a newer
 *     build wrote this save; older build can't load it but bytes are intact)
 *
 * Throws happen at deserialize-time (`deserializeWorldState`) and are
 * caught by `bootFromSave`'s try/catch in render/game-scene.ts.
 */
function validateSimVersion(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new OldSimVersionError(null);
  }
  if (raw > LATEST_SIM_VERSION) {
    throw new FutureSimVersionError(raw, LATEST_SIM_VERSION);
  }
  if (raw < MIN_ACCEPTED_SIM_VERSION) {
    throw new OldSimVersionError(raw);
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

function deserializeAnts(
  saved: SerializedAnts,
  capacity: number,
  nextEntityId: number,
): AntComponents {
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
  copyIntoInt32(a.searchWave, saved.searchWave);
  copyIntoInt32(a.searchHeadingX, saved.searchHeadingX);
  copyIntoInt32(a.searchHeadingY, saved.searchHeadingY);
  copyIntoInt32(a.searchHeadingTicks, saved.searchHeadingTicks);
  copyIntoInt32(a.searchPrevTileX, saved.searchPrevTileX);
  copyIntoInt32(a.searchPrevTileY, saved.searchPrevTileY);
  copyIntoUint8(a.currentGridColonyId, saved.currentGridColonyId);
  copyIntoUint8(a.waitingDeposit, saved.waitingDeposit);
  copyIntoInt32(a.searchPauseTicks, saved.searchPauseTicks);
  // PR 5 C-both — reconstruct the ring from the compact stream (arrays are
  // already sentinel-filled + head 0 by createAntComponents).
  unpackRecentTiles(a, saved.recentTiles, nextEntityId, capacity);
  copyIntoInt32(a.carryingBroodId, saved.carryingBroodId);
  copyIntoInt32(a.carriedBy, saved.carriedBy);
  copyIntoInt32(a.hp, saved.hp);
  copyIntoInt32(a.homeGroundBonusHp, saved.homeGroundBonusHp);
  copyIntoInt32(a.attackCooldown, saved.attackCooldown);
  copyIntoInt32(a.combatOpponentId, saved.combatOpponentId);
  return a;
}

function deserializeColony(s: SerializedColony): ColonyRecord {
  const c = createColonyRecord(s.colonyId, s.queenEntityId);
  c.queenStarvationTimer = s.queenStarvationTimer;
  c.foodStored = s.foodStored;
  c.workerCount = s.workerCount;
  c.eggCount = s.eggCount;
  c.larvaeCount = s.larvaeCount;
  c.nurseCount = s.nurseCount;
  c.eggs = [...s.eggs];
  c.larvae = [...s.larvae];
  c.workers = [...s.workers];
  c.chambers = s.chambers.map((ch) => ({ ...ch }));
  c.targetRatio = { ...s.targetRatio };
  c.computedAllocation = { ...s.computedAllocation };
  c.taskCensus = { ...s.taskCensus };
  c.defeated = s.defeated;
  c.reconcileCountdown = s.reconcileCountdown;
  c.entrances = s.entrances.map((e) => ({ ...e }));
  c.rallyPoint = s.rallyPoint === null ? null : { ...s.rallyPoint };
  c.digFlowFieldDirty = s.digFlowFieldDirty;
  c.foodFlowFieldDirty = s.foodFlowFieldDirty;
  c.broodFieldDirty = s.broodFieldDirty ?? false; // #235 — absent on pre-#235 saves; tick-1 firstDigCompute forces recompute regardless
  c.killCount = s.killCount;
  c.priorityFoodPileId = s.priorityFoodPileId;
  c.queenLastEggTick = s.queenLastEggTick;
  // Valid difficulty numerators are 3, 4, 5. Reject any out-of-range value (tampered save or future compat).
  c.eggIntervalNumerator =
    s.eggIntervalNumerator === 3 || s.eggIntervalNumerator === 4 || s.eggIntervalNumerator === 5
      ? s.eggIntervalNumerator
      : 4;
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

function deserializeAIStateArray(s: SerializedWorldState): AIStateRecord[] {
  const raw = s.aiState;
  if (!Array.isArray(raw)) return [];
  const result: AIStateRecord[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    if (r === null || typeof r !== 'object') continue;
    const fightIds = Array.isArray(r.operationFighterIds) ? r.operationFighterIds : [];
    const buf = new Int32Array(AI_MAX_OPERATION_FIGHTERS).fill(-1);
    const copyLen = Math.min(fightIds.length, AI_MAX_OPERATION_FIGHTERS);
    for (let j = 0; j < copyLen; j++) {
      const val = fightIds[j];
      buf[j] = typeof val === 'number' && Number.isInteger(val) ? val : -1;
    }
    result.push({
      colonyId: typeof r.colonyId === 'number' ? r.colonyId : 0,
      state: isValidAIState(r.state) ? r.state : 'Peacetime',
      enteredTick: typeof r.enteredTick === 'number' ? r.enteredTick : 0,
      probeCount: typeof r.probeCount === 'number' ? r.probeCount : 0,
      lastProbeEndTick: typeof r.lastProbeEndTick === 'number' ? r.lastProbeEndTick : 0,
      invasionStartTick: typeof r.invasionStartTick === 'number' ? r.invasionStartTick : 0,
      invasionRallyTileX: typeof r.invasionRallyTileX === 'number' ? r.invasionRallyTileX : -1,
      invasionRallyTileY: typeof r.invasionRallyTileY === 'number' ? r.invasionRallyTileY : -1,
      recoveryEndTick: typeof r.recoveryEndTick === 'number' ? r.recoveryEndTick : 0,
      operationKind: isValidOperationKind(r.operationKind) ? r.operationKind : 'None',
      operationStartTick: typeof r.operationStartTick === 'number' ? r.operationStartTick : 0,
      operationTargetTileX:
        typeof r.operationTargetTileX === 'number' ? r.operationTargetTileX : -1,
      operationTargetTileY:
        typeof r.operationTargetTileY === 'number' ? r.operationTargetTileY : -1,
      operationFighterIds: buf,
      operationFighterCount:
        typeof r.operationFighterCount === 'number'
          ? Math.min(Math.max(0, r.operationFighterCount), AI_MAX_OPERATION_FIGHTERS)
          : 0,
      operationStartFighterCount:
        typeof r.operationStartFighterCount === 'number' ? r.operationStartFighterCount : 0,
      operationAttackerDeaths:
        typeof r.operationAttackerDeaths === 'number' ? r.operationAttackerDeaths : 0,
      operationDefenderDeaths:
        typeof r.operationDefenderDeaths === 'number' ? r.operationDefenderDeaths : 0,
    });
  }
  return result;
}

function isValidSpiderBehaviorState(
  v: unknown,
): v is import('../sim/types.js').SpiderBehaviorState {
  return (
    v === 'Patrolling' ||
    v === 'Hunting' ||
    v === 'Chasing' ||
    v === 'Striking' ||
    v === 'Feeding' ||
    v === 'Rampaging' ||
    v === 'Retreating'
  );
}

function deserializeSpider(s: SerializedWorldState): SpiderState | null {
  const raw = s.spider;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const r = raw as Partial<SerializedSpiderState>;
  const rawState = isValidSpiderBehaviorState(r.state) ? r.state : 'Patrolling';
  const rawHuntX =
    typeof r.huntTargetTileX === 'number' && Number.isInteger(r.huntTargetTileX)
      ? r.huntTargetTileX
      : -1;
  const rawHuntY =
    typeof r.huntTargetTileY === 'number' && Number.isInteger(r.huntTargetTileY)
      ? r.huntTargetTileY
      : -1;
  // Guard: Hunting/Striking require a valid (non-sentinel) hunt target. A save with
  // state=Hunting but target=-1 (corrupt or truncated) would route the spider to (0,0)
  // for the full telegraph duration. Fall back to Patrolling in that case.
  const huntTargetValid = rawHuntX >= 0 && rawHuntY >= 0;
  // V23: Chasing requires a valid (non-sentinel) ant id; fall back to Patrolling otherwise.
  const rawChaseId =
    typeof r.chaseTargetAntId === 'number' && Number.isInteger(r.chaseTargetAntId)
      ? r.chaseTargetAntId
      : -1;
  const chaseTargetValid = rawChaseId >= 0;
  let safeState =
    (rawState === 'Hunting' || rawState === 'Striking') && !huntTargetValid
      ? 'Patrolling'
      : rawState;
  if (safeState === 'Chasing' && !chaseTargetValid) safeState = 'Patrolling';
  return {
    state: safeState,
    posX: typeof r.posX === 'number' && Number.isInteger(r.posX) ? r.posX : 0,
    posY: typeof r.posY === 'number' && Number.isInteger(r.posY) ? r.posY : 0,
    lairTileX: typeof r.lairTileX === 'number' && Number.isInteger(r.lairTileX) ? r.lairTileX : 0,
    lairTileY: typeof r.lairTileY === 'number' && Number.isInteger(r.lairTileY) ? r.lairTileY : 0,
    territoryRadiusTiles:
      typeof r.territoryRadiusTiles === 'number' && Number.isInteger(r.territoryRadiusTiles)
        ? r.territoryRadiusTiles
        : 24,
    hp: typeof r.hp === 'number' && Number.isInteger(r.hp) ? r.hp : 80,
    attackCooldown:
      typeof r.attackCooldown === 'number' && Number.isInteger(r.attackCooldown)
        ? r.attackCooldown
        : 0,
    hungerTicks:
      typeof r.hungerTicks === 'number' && Number.isInteger(r.hungerTicks) ? r.hungerTicks : 0,
    nextHuntTick:
      typeof r.nextHuntTick === 'number' && Number.isInteger(r.nextHuntTick)
        ? r.nextHuntTick
        : SPIDER_HUNT_INTERVAL_TICKS,
    huntStartTick:
      typeof r.huntStartTick === 'number' && Number.isInteger(r.huntStartTick)
        ? r.huntStartTick
        : 0,
    strikeStartTick:
      typeof r.strikeStartTick === 'number' && Number.isInteger(r.strikeStartTick)
        ? r.strikeStartTick
        : 0,
    feedingStartTick:
      typeof r.feedingStartTick === 'number' && Number.isInteger(r.feedingStartTick)
        ? r.feedingStartTick
        : 0,
    retreatStartTick:
      typeof r.retreatStartTick === 'number' && Number.isInteger(r.retreatStartTick)
        ? r.retreatStartTick
        : 0,
    rampageStartTick:
      typeof r.rampageStartTick === 'number' && Number.isInteger(r.rampageStartTick)
        ? r.rampageStartTick
        : 0,
    huntTargetTileX: huntTargetValid ? rawHuntX : -1,
    huntTargetTileY: huntTargetValid ? rawHuntY : -1,
    killsThisStrike:
      typeof r.killsThisStrike === 'number' && Number.isInteger(r.killsThisStrike)
        ? r.killsThisStrike
        : 0,
    rampageKillsThisRampage:
      typeof r.rampageKillsThisRampage === 'number' && Number.isInteger(r.rampageKillsThisRampage)
        ? r.rampageKillsThisRampage
        : 0,
    rampageTargetColonyId:
      safeState === 'Rampaging' &&
      typeof r.rampageTargetColonyId === 'number' &&
      r.rampageTargetColonyId > 0
        ? r.rampageTargetColonyId
        : -1,
    chaseTargetAntId: safeState === 'Chasing' ? rawChaseId : -1,
    chaseStartTick:
      typeof r.chaseStartTick === 'number' && Number.isInteger(r.chaseStartTick)
        ? r.chaseStartTick
        : 0,
    killedThisTick: 0,
    lastKillTileX:
      typeof r.lastKillTileX === 'number' && Number.isInteger(r.lastKillTileX)
        ? r.lastKillTileX
        : -1,
    lastKillTileY:
      typeof r.lastKillTileY === 'number' && Number.isInteger(r.lastKillTileY)
        ? r.lastKillTileY
        : -1,
    feedAwayTileX:
      typeof r.feedAwayTileX === 'number' && Number.isInteger(r.feedAwayTileX)
        ? r.feedAwayTileX
        : -1,
    feedAwayTileY:
      typeof r.feedAwayTileY === 'number' && Number.isInteger(r.feedAwayTileY)
        ? r.feedAwayTileY
        : -1,
    feedArrivedTick:
      typeof r.feedArrivedTick === 'number' && Number.isInteger(r.feedArrivedTick)
        ? r.feedArrivedTick
        : -1,
  };
}

function isValidAIState(v: unknown): v is import('../sim/types.js').AIState {
  return (
    v === 'Peacetime' ||
    v === 'WarFooting' ||
    v === 'Probing' ||
    v === 'Invading' ||
    v === 'Recovery'
  );
}

function isValidOperationKind(v: unknown): v is 'None' | 'Probe' | 'Invasion' {
  return v === 'None' || v === 'Probe' || v === 'Invasion';
}

export function deserializeWorldState(s: SerializedWorldState): WorldState {
  // Top-level guard — must be a non-null object to read .simVersion.
  if (s === null || typeof s !== 'object') {
    throw new Error('Invalid save shape: snapshot is not an object');
  }
  // Validate simVersion FIRST so a future-build save gets FutureSimVersionError
  // (preserved + autosave-suspended) before any shape mismatch can misclassify
  // it as corruption.
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
  if (
    typeof rawCount !== 'number' ||
    !Number.isInteger(rawCount) ||
    rawCount < 0 ||
    rawCount > MAX_ENTITIES
  ) {
    // Use String() so NaN/Infinity render as their canonical names; JSON.stringify
    // would coerce them to 'null', which is more confusing than less.
    throw new Error(
      `Invalid ants.count in save: ${String(rawCount)} (require integer in [0, ${MAX_ENTITIES}])`,
    );
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
    throw new Error(
      `Too many undergroundGrids in save: ${ugKeys.length} (cap ${MAX_COLONIES_LOAD})`,
    );
  }
  if (s.pheromoneGrids === null || typeof s.pheromoneGrids !== 'object') {
    throw new Error('Invalid save shape: missing or non-object pheromoneGrids');
  }
  const pheroKeys = Object.keys(s.pheromoneGrids);
  if (pheroKeys.length > MAX_PHEROMONE_GRID_KEYS) {
    throw new Error(
      `Too many pheromoneGrids in save: ${pheroKeys.length} (cap ${MAX_PHEROMONE_GRID_KEYS})`,
    );
  }
  if (s.pendingChambers === null || typeof s.pendingChambers !== 'object') {
    throw new Error('Invalid save shape: missing or non-object pendingChambers');
  }
  const pcKeys = Object.keys(s.pendingChambers);
  if (pcKeys.length > MAX_PENDING_CHAMBERS) {
    throw new Error(
      `Too many pendingChambers in save: ${pcKeys.length} (cap ${MAX_PENDING_CHAMBERS})`,
    );
  }

  const colonies: Record<ColonyId, ColonyRecord> = {};
  for (const [cidStr, sc] of Object.entries(s.colonies)) {
    // Issue #99 — colonies map keys must be decimal-integer strings; reject
    // `__proto__` and any non-numeric key shape that would corrupt the
    // resulting Record.
    if (!/^-?\d+$/.test(cidStr)) {
      throw new Error(`Invalid colonies key: ${cidStr}`);
    }
    colonies[Number(cidStr)] = deserializeColony(sc);
  }
  const undergroundGrids: Record<ColonyId, UndergroundGrid> = {};
  for (const [cidStr, sg] of Object.entries(s.undergroundGrids)) {
    if (!/^-?\d+$/.test(cidStr)) {
      throw new Error(`Invalid undergroundGrids key: ${cidStr}`);
    }
    // Issue #99 — verify grid shape before allocator runs.
    validateGridShape(
      sg,
      UNDERGROUND_GRID_WIDTH,
      UNDERGROUND_GRID_HEIGHT,
      `undergroundGrids[${cidStr}]`,
    );
    undergroundGrids[Number(cidStr)] = deserializeUndergroundGrid(sg);
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
      validateGridShape(sg, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT, `pheromoneGrids[${key}]`);
      validated = true;
    } catch {
      /* try underground next */
    }
    if (!validated) {
      validateGridShape(
        sg,
        UNDERGROUND_GRID_WIDTH,
        UNDERGROUND_GRID_HEIGHT,
        `pheromoneGrids[${key}]`,
      );
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
  if (
    typeof rawNext !== 'number' ||
    !Number.isInteger(rawNext) ||
    rawNext < 0 ||
    rawNext > MAX_ENTITIES
  ) {
    throw new Error(
      `Invalid nextEntityId in save: ${String(rawNext)} (require integer in [0, ${MAX_ENTITIES}])`,
    );
  }

  // Issue #104 — boundary validation for snapshot tick. Same pattern as
  // nextEntityId: `tick: s.tick` previously passed strings/NaN through,
  // and `world.tick += 1` became unbounded string concatenation.
  const rawTick = s.tick;
  if (
    typeof rawTick !== 'number' ||
    !Number.isFinite(rawTick) ||
    !Number.isInteger(rawTick) ||
    rawTick < 0
  ) {
    throw new Error(`Invalid tick in save: ${String(rawTick)} (require non-negative integer)`);
  }
  // rngState — same hardening for symmetry. Rng's `state | 0` would coerce
  // NaN/strings to 0 on first use, but boundary validation surfaces tampering
  // explicitly instead of silently snapping.
  const rawRng = s.rngState;
  if (typeof rawRng !== 'number' || !Number.isFinite(rawRng) || !Number.isInteger(rawRng)) {
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
  // Hoist spider deserialization so spiderPriorityColonyId and scatterReticleTile
  // can be forced null when spider is null (B11 fix: ghost-scatter prevention).
  const _deserializedSpider = deserializeSpider(s);

  // PR 4 — decode + validate the baked static-terrain grid. Reject wrong
  // dimensions, malformed base64, or an out-of-range (code 3) movement-effect
  // value before accepting the field (R3-8/R5-2). Connectivity is validated
  // after the world is assembled (it needs colonies + foodPiles).
  const bakedSurfaceEffect = unpackBakedSurfaceEffect(
    (s as { bakedSurfaceEffect?: unknown }).bakedSurfaceEffect as string,
    SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT,
  );
  if (bakedSurfaceEffect === null) {
    throw new Error(
      'Invalid bakedSurfaceEffect: wrong dimensions, malformed encoding, or out-of-range effect value',
    );
  }

  const world: WorldState = {
    tick: rawTick,
    rngState: rawRng,
    nextEntityId: rawNext,
    simVersion: validatedSimVersion,
    // terrainSeed: uint32-coerce to guard against NaN/string/negative tampered values.
    terrainSeed:
      typeof s.terrainSeed === 'number' && Number.isInteger(s.terrainSeed)
        ? s.terrainSeed >>> 0
        : 0,
    // Issue #105 — filter null/non-object entries before the spread so the
    // runtime queue is always consistent with the dispatcher's expectations.
    commandQueue: (Array.isArray(s.commandQueue) ? s.commandQueue : [])
      .filter((c) => c !== null && typeof c === 'object')
      .map((c) => ({ ...c }) as SimCommand),
    ants: deserializeAnts(s.ants, capacity, rawNext),
    colonies,
    pheromoneGrids,
    surface: deserializeSurfaceGrid(s.surface),
    bakedSurfaceEffect,
    surfaceComponentMask: null,
    surfaceGoalFields: null,
    surfaceGoalBfsScratch: null,
    undergroundGrids,
    foodPiles: s.foodPiles.map((p) => ({ ...p })),
    recentlyDepletedFood: validatedRecentlyDepleted.map((r) => ({ ...r })),
    pendingChambers,
    events: [],
    droppedCommandOverflowCount: 0, // #230 — transient, reset on load
    pendingQueenDeathContexts: [],
    aiState: deserializeAIStateArray(s),
    spider: _deserializedSpider,
    spiderPriorityColonyId:
      _deserializedSpider !== null &&
      typeof s.spiderPriorityColonyId === 'number' &&
      Number.isInteger(s.spiderPriorityColonyId) &&
      s.spiderPriorityColonyId > 0
        ? s.spiderPriorityColonyId
        : null,
    scatterReticleTile: (() => {
      if (_deserializedSpider === null) return null;
      const r = s.scatterReticleTile;
      if (r === null || r === undefined) return null;
      if (typeof r !== 'object') return null;
      if (typeof r.x !== 'number' || typeof r.y !== 'number') return null;
      if (!Number.isInteger(r.x) || !Number.isInteger(r.y)) return null;
      return { x: r.x, y: r.y };
    })(),
    droppedCombatKillCount:
      typeof s.droppedCombatKillCount === 'number' &&
      Number.isInteger(s.droppedCombatKillCount) &&
      s.droppedCombatKillCount >= 0
        ? s.droppedCombatKillCount
        : 0,
    droppedStructuralCount:
      typeof s.droppedStructuralCount === 'number' &&
      Number.isInteger(s.droppedStructuralCount) &&
      s.droppedStructuralCount >= 0
        ? s.droppedStructuralCount
        : 0,
    difficulty: s.difficulty === 'Easy' || s.difficulty === 'Hard' ? s.difficulty : 'Normal',
  };

  // PR 4 — re-run the FULL connectivity check against the assembled world: every
  // saved food pile and every saved entrance must sit in the single connected
  // walkable component of the baked grid (not just the roots — R3-8/R5-2). A
  // corrupt/old map fails loudly here rather than loading a broken world.
  if (!validateSurfaceConnectivity(world)) {
    throw new Error(
      'Invalid bakedSurfaceEffect: connectivity violated (a food pile or entrance is not in the single walkable component)',
    );
  }
  // Eagerly materialise the derived component mask on load (idempotent —
  // validateSurfaceConnectivity already populated it), so post-load
  // isSurfaceTileInComponent queries (incl. the render/input preview gate) are
  // pure reads of a pre-built mask, never a lazy world mutation.
  ensureSurfaceComponentMask(world);

  return world;
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
    // Issue #115 — wall-clock stamp, surfaced in the Save/Load dialog's info
    // line. Date.now() is allowed in src/platform (not src/sim — see file
    // header rule list). Determinism unaffected: SCEN-06 replay is keyed on
    // (seed, inputLog) and never reads this field.
    savedAtMs: Date.now(),
  };
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
async function purgeLegacySaves(): Promise<void> {
  try {
    await getStorageDriver().remove('subterrans:save:v1');
  } catch {
    /* quota / private mode — silent: best-effort cleanup, no UX signal */
  }
  try {
    await getStorageDriver().remove('subterrans:save:v2');
  } catch {
    /* quota / private mode — silent: best-effort cleanup, no UX signal */
  }
}

export async function hasSave(): Promise<boolean> {
  try {
    await purgeLegacySaves();
    const raw = await getStorageDriver().get(SAVE_KEY);
    if (raw === null) return false;
    parseSaveFile(raw);
    return true;
  } catch {
    return false;
  }
}

export async function loadSave(): Promise<SaveFile | null> {
  try {
    await purgeLegacySaves();
    const raw = await getStorageDriver().get(SAVE_KEY);
    if (raw === null) return null;
    return parseSaveFile(raw);
  } catch {
    return null;
  }
}

export async function deleteSave(): Promise<void> {
  try {
    await getStorageDriver().remove(SAVE_KEY);
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
export async function manualSave(
  seed: number,
  inputLog: readonly SimCommand[],
  world: WorldState,
): Promise<boolean> {
  try {
    const envelope = buildSaveFile(seed, inputLog, world);
    await getStorageDriver().set(SAVE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * Issue #196 — three-way compatibility verdict for the save currently in
 * localStorage. Distinguishes a recoverable future-build save from definitive
 * corruption so the boot path can preserve the former (suspend autosave so the
 * bytes survive for recovery on a newer build) while letting the latter be
 * overwritten freely.
 *
 *   - 'none'                 — no bytes under SAVE_KEY (or storage unreadable)
 *   - 'compatible'           — parses AND deserializes on this build (loadable)
 *   - 'incompatible-future'  — parses but `snapshot.simVersion > LATEST`
 *                              (FutureSimVersionError): a NEWER build wrote it;
 *                              the bytes are intact and recoverable on that build
 *   - 'incompatible-corrupt' — any other failure (envelope parse error,
 *                              non-object snapshot, tampered/missing fields,
 *                              `simVersion < MIN`): not loadable by any build
 *
 * Mirrors the classification `bootFromSave` already performs on the Continue
 * path (FutureSimVersionError vs plain Error) so the fresh-boot path can make
 * the same recoverable-vs-corrupt decision at boot time.
 */
export type SaveCompatibility =
  | 'none'
  | 'compatible'
  | 'incompatible-future'
  | 'incompatible-corrupt';

export async function classifySaveCompatibility(): Promise<SaveCompatibility> {
  let raw: string | null;
  try {
    await purgeLegacySaves();
    raw = await getStorageDriver().get(SAVE_KEY);
  } catch {
    return 'none';
  }
  if (raw === null) return 'none';
  let file: SaveFile;
  try {
    file = parseSaveFile(raw);
  } catch {
    return 'incompatible-corrupt';
  }
  // parseSaveFile validates the envelope only; the snapshot can be null / a
  // non-object on a tampered envelope. Reject before the deserialize attempt.
  const snapshot = file.snapshot as unknown;
  if (snapshot === null || typeof snapshot !== 'object') return 'incompatible-corrupt';
  // The canonical compatibility boundary: a full deserialize. FutureSimVersionError
  // is the one recoverable failure (newer build wrote it); every other throw is
  // corruption this build (or any build) cannot load.
  try {
    deserializeWorldState(file.snapshot);
    return 'compatible';
  } catch (err) {
    return err instanceof FutureSimVersionError ? 'incompatible-future' : 'incompatible-corrupt';
  }
}

/** Issue #115 — true iff bytes exist under SAVE_KEY but this build cannot
 *  load them. Three categories of incompatibility:
 *    1. envelope parse fails (wrong save format version, malformed JSON,
 *       tampered seed, etc. — `parseSaveFile` throws)
 *    2. envelope parses but `snapshot.simVersion > LATEST_SIM_VERSION` —
 *       the save was written by a NEWER build. `bootFromSave`'s
 *       `deserializeWorldState` would throw `FutureSimVersionError` and
 *       fall through to `bootFresh` with autosave suspended (issue #66).
 *       Surface this at the dialog level so Continue stays disabled and
 *       the info line warns the user instead of letting them click
 *       Continue and silently get a fresh world.
 *
 *  Distinct from `hasSave === false` which can mean "no save written yet"
 *  OR "save present but unreadable." The dialog uses
 *  `hasSave() && !hasIncompatibleSave()` to decide whether Continue is
 *  actionable.
 *
 *  Round-2 review: also fires the legacy-save purge so an external caller
 *  that hits this method first (without a prior hasSave call) still cleans
 *  up the old subterrans:save:v1/v2 keys. Symmetry with hasSave/loadSave.
 *
 *  Round-3 (Codex P2 follow-up): the simVersion check above replaces the
 *  prior "envelope-parse only" check that returned false for future-sim
 *  saves and enabled a Continue click that would silently lose the save. */
export async function hasIncompatibleSave(): Promise<boolean> {
  // Issue #196 — delegate to the three-way classifier so this and the boot
  // path share one compatibility boundary. Both incompatible verdicts
  // (future + corrupt) mean Continue would not actually load the save, so
  // the dialog surfaces them identically (its info line already does).
  //
  // Cost: one full WorldState allocation per call (the classifier's
  // deserialize). The dialog open path calls this once (cached for the
  // render); user-initiated, infrequent.
  const verdict = await classifySaveCompatibility();
  return verdict === 'incompatible-future' || verdict === 'incompatible-corrupt';
}

/** Lightweight save summary surfaced in the Save/Load dialog's info line.
 *  Avoids deserializeWorldState (which allocates the full typed-array world)
 *  by reading only a handful of primitives from the JSON envelope. */
export interface SaveInfo {
  /** Sim tick at the moment the snapshot was taken. */
  tick: number;
  /** Player colony's living worker count, or 0 when the field is missing. */
  playerWorkers: number;
  /** Player colony's stored-food count in HUMAN units (post `>> FP_SHIFT`). */
  playerFoodStored: number;
  /** Wall-clock timestamp (Date.now() epoch ms) when the envelope was last
   *  written. 0 if the field is absent from a pre-issue-#115 envelope —
   *  callers should treat 0 as "unknown" rather than "1970-01-01." */
  savedAtMs: number;
}

/** Issue #115 — extract the dialog's summary fields without a full
 *  deserialize. Returns null if no save exists or the envelope is unreadable.
 *  Player colony key is `String(PLAYER_COLONY_ID)` per the colonies map's
 *  stringified-int convention (ADR-0006). */
export async function getSaveInfo(): Promise<SaveInfo | null> {
  let raw: string | null;
  try {
    raw = await getStorageDriver().get(SAVE_KEY);
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
  // Codex round-3 P1: parseSaveFile validates the envelope only. A
  // parseable-but-corrupt envelope can have `snapshot: null` or
  // `snapshot.colonies: undefined`, both of which would throw on the
  // dereferences below and crash the dialog open path. Return null so
  // the dialog falls back to the "no save / incompatible" branch in
  // formatSaveInfoLine.
  const snapshot = file.snapshot as unknown;
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const colonies = (snapshot as { colonies?: unknown }).colonies as
    | Record<string, { foodStored?: unknown; workerCount?: unknown } | undefined>
    | undefined;
  const playerKey = String(PLAYER_COLONY_ID);
  // colonies may be undefined / null / a non-object on a malformed envelope;
  // probe defensively before keying into it.
  const playerColony =
    colonies !== undefined && colonies !== null && typeof colonies === 'object'
      ? colonies[playerKey]
      : undefined;
  // foodStored is fixed-point; convert to whole-food units for display.
  // Right-shift on a non-number short-circuits cleanly via the ?? fallback.
  const foodFpRaw = playerColony?.foodStored;
  const foodFp =
    typeof foodFpRaw === 'number' && Number.isFinite(foodFpRaw) && foodFpRaw >= 0 ? foodFpRaw : 0;
  const workerCountRaw = playerColony?.workerCount;
  const playerWorkers =
    typeof workerCountRaw === 'number' && Number.isFinite(workerCountRaw) && workerCountRaw >= 0
      ? workerCountRaw
      : 0;
  // tick may also be missing on a malformed envelope — surface 0 rather
  // than rendering "Tick undefined" in the dialog.
  const tickRaw = (snapshot as { tick?: unknown }).tick;
  const tick =
    typeof tickRaw === 'number' && Number.isFinite(tickRaw) && tickRaw >= 0 ? tickRaw : 0;
  // Issue #115 — savedAtMs is optional in the envelope; pre-fix saves and
  // any tampered/malformed timestamp fall back to 0 ("unknown") so the
  // dialog can render a sensible placeholder.
  const stampRaw = (file as { savedAtMs?: unknown }).savedAtMs;
  const savedAtMs =
    typeof stampRaw === 'number' && Number.isFinite(stampRaw) && stampRaw >= 0 ? stampRaw : 0;
  return {
    tick,
    playerWorkers,
    playerFoodStored: foodFp >> FP_SHIFT,
    savedAtMs,
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
export async function tickAutosave(
  seed: number,
  inputLog: readonly SimCommand[],
  world: WorldState,
  lastSaveMs: number,
  nowMs: number,
): Promise<number> {
  if (nowMs - lastSaveMs < AUTOSAVE_INTERVAL_MS) return lastSaveMs;
  try {
    const envelope = buildSaveFile(seed, inputLog, world);
    await getStorageDriver().set(SAVE_KEY, JSON.stringify(envelope));
    return nowMs;
  } catch {
    // Honor the cooldown on failure too — see #80 above.
    return nowMs;
  }
}
