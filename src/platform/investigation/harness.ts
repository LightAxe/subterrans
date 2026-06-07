// harness.ts — committed diagnostic harness for the flurry PR-2 investigation
// (plan/flurry/PR2-REPLAN.md Phase 0). Reproduces and CATALOGS ant
// mis-movement: surface forager confinement (#127) and underground embedding
// (#128). It ships no fix — it is the pre/post regression instrument PR 2 / 2b
// inherit.
//
// LOCATION / BOUNDARY: this module lives in src/platform (not src/sim) because
// it imports the render/platform-only debug-snapshot inferencer. It only READS
// WorldState and calls `tick()`; it never assigns to a `world.*` field, so it
// respects FNDN-07. Synthetic world construction (for structural #128 cases)
// lives in the *.test.ts file, which the sim-boundary grep excludes.
//
// (Per-ant detector state is held on a local object named `win`, never `w`, so
//  the FNDN-07 boundary grep does not mistake field writes for world mutations.)
//
// OBSERVATIONAL NEUTRALITY (plan §1, R3-P0-3): tracing consumes NO RNG and
// mutates no sim state. `buildAntTrace` is a pure read; the only randomness in
// the system flows through `tick()`'s internal Rng. `checkObservationalNeutrality`
// proves an instrumented run and a clean run end byte-identical incl. rngState.

import { tick } from '../../sim/tick.js';
import { createScenario } from '../../sim/scenario.js';
import { canEnterUndergroundTile } from '../../sim/ant/ant-system.js';
import { surfaceMovementAt, SurfaceMovementEffect } from '../../sim/surface-features.js';
import { Zone, ugGet } from '../../sim/terrain.js';
import { AntTask, ForagingSubState } from '../../sim/enums.js';
import { FP_SHIFT } from '../../sim/fixed.js';
import { PLAYER_COLONY_ID, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from '../../sim/constants.js';
import type { WorldState } from '../../sim/types.js';
import type { SimCommand } from '../../sim/commands.js';
import { buildAntTrace, type MovementSource } from '../debug-snapshot.js';
import { serializeWorldState } from '../save.js';

// ===========================================================================
// Tuning — episode thresholds. These are DIAGNOSTIC detection thresholds, not
// the acceptance caps the fixes must hit (those are derived from measured
// worst-episode data on the calibration seeds — see INVESTIGATION.md).
// ===========================================================================

/** Sliding window (ticks) over which surface confinement is judged. */
export const CONFINE_WINDOW = 20;
/** Chebyshev bounding-box side an ant must stay within to count as confined. */
export const CONFINE_BBOX = 3;
/** Min tile-crossings in the window to count as "actively moving" (vs a
 *  legitimate stationary pause, which is NOT confinement). */
export const CONFINE_MIN_CROSSINGS = 4;
/** Consecutive no-progress ticks before a confinement episode is recorded. */
export const CONFINE_MIN_TICKS = 12;

// ===========================================================================
// Types
// ===========================================================================

/** A reproduced surface-confinement episode (#127). */
export interface ConfinementEpisode {
  seed: number;
  difficulty: string;
  antId: number;
  /** Tick the episode began (first no-progress tick in the run). */
  startTick: number;
  /** Tick the episode ended (progress resumed, ant left, or run ended). */
  endTick: number;
  /** Episode length in ticks (endTick - startTick). */
  lengthTicks: number;
  /** Tile the ant was confined around (modal tile across the whole episode). */
  tileX: number;
  tileY: number;
  /** Distribution of inferred movement sources across the episode. */
  sources: Partial<Record<MovementSource, number>>;
  /** True if any tick aimed a step into an adjacent HardBlock (scent/priority
   *  vs wall — the worst #127 class). */
  aimedIntoWall: boolean;
}

/** A reproduced underground-embedding episode (#128). */
export interface EmbeddingEpisode {
  seed: number;
  difficulty: string;
  antId: number;
  startTick: number;
  endTick: number;
  lengthTicks: number;
  tileX: number;
  tileY: number;
  task: number;
  /** Underground tile state under the ant at first detection. */
  tileState: number;
  /** Classification (plan §5): one of the #128 classes. */
  klass: EmbeddingClass;
}

/** #128 classification (plan §5 (i)-(iv); render-only (iii) is a separate probe). */
export type EmbeddingClass =
  | 'descent-placement' // (ii) embedded on the tick a zone transition placed it
  | 'mutation-under-occupant' // (iv) tile flipped to non-passable under a standing ant
  | 'terrain-pocket'; // (i) sustained embedding while attempting to move

export interface SweepResult {
  seed: number;
  difficulty: string;
  ticks: number;
  confinement: ConfinementEpisode[];
  embedding: EmbeddingEpisode[];
  /** Worst (longest) surface confinement episode length, ticks. */
  worstConfinementTicks: number;
  /** Worst underground embedding episode length, ticks. */
  worstEmbeddingTicks: number;
  /** Count of distinct ants that experienced ≥1 confinement episode. */
  confinedAnts: number;
}

// ===========================================================================
// Per-ant online detector state
// ===========================================================================

interface AntWindow {
  // Ring of recent tile positions for bbox + crossing count.
  xs: number[];
  ys: number[];
  // Coverage high-water (max Chebyshev distance from this excursion's origin).
  originX: number;
  originY: number;
  progressHW: number;
  ticksSinceProgress: number;
  // Active confinement episode (null if not currently confined).
  episodeStart: number | null;
  episodeSources: Partial<Record<MovementSource, number>>;
  episodeAimedWall: boolean;
  // Tile occupancy tally across the WHOLE detected episode (not just the
  // 20-sample ring) so the reported locus covers the same interval the episode
  // length describes — keyed "x,y". A confined ant sits in a ≤3×3 box, so this
  // map stays tiny.
  episodeTiles: Map<string, number>;
  lastWave: number;
  // Last tick at which this ant was observed alive (-1 = never).
  lastSeenTick: number;
  // Underground embedding tracking.
  lastZone: number;
  lastTileX: number;
  lastTileY: number;
  embedStart: number | null;
  embedClass: EmbeddingClass | null;
  embedTileState: number;
  embedTask: number;
}

function freshWindow(): AntWindow {
  return {
    xs: [],
    ys: [],
    originX: -1,
    originY: -1,
    progressHW: -1,
    ticksSinceProgress: 0,
    episodeStart: null,
    episodeSources: {},
    episodeAimedWall: false,
    episodeTiles: new Map(),
    lastWave: -1,
    lastSeenTick: -1,
    lastZone: -1,
    lastTileX: -1,
    lastTileY: -1,
    embedStart: null,
    embedClass: null,
    embedTileState: -1,
    embedTask: -1,
  };
}

// ===========================================================================
// Static-terrain feature-field oracle (plan §3, R3-P1-6)
// ===========================================================================

/**
 * FNV-1a hash of the COMPLETE 128×128 surface feature-effect field. Two worlds
 * with the same hash have identical movement effect (Cosmetic/SoftCost/
 * HardBlock) on every surface tile. Used to prove the field MUTATES across
 * pile spawn/depletion + entrance designation today (the bug the static-terrain
 * redesign removes) and to require exact equality across save/load.
 */
export function featureFieldHash(world: WorldState): number {
  let h = 0x811c9dc5;
  for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
      const effect = surfaceMovementAt(world, x, y);
      h ^= effect & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/** Count of surface tiles whose effect differs between two worlds. */
export function featureFieldDiffCount(a: WorldState, b: WorldState): number {
  let diff = 0;
  for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
      if (surfaceMovementAt(a, x, y) !== surfaceMovementAt(b, x, y)) diff++;
    }
  }
  return diff;
}

// ===========================================================================
// Core traced run
// ===========================================================================

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Run one scenario for `ticks`, tracing every live ant each tick, and return
 * the catalogued confinement + embedding episodes. Pure observation — the only
 * mutation is `tick()`'s own.
 */
export function runTracedScenario(
  seed: number,
  difficulty: 'Easy' | 'Normal' | 'Hard',
  ticks: number,
  commandsPerTick: readonly SimCommand[][],
): SweepResult {
  const world = createScenario(seed, difficulty);
  const windows = new Map<number, AntWindow>();
  const confinement: ConfinementEpisode[] = [];
  const embedding: EmbeddingEpisode[] = [];

  for (let t = 0; t < ticks; t++) {
    tick(world, commandsPerTick[t] ?? []);
    observeTick(world, t, windows, confinement, embedding, seed, difficulty);
  }

  // Flush any still-open episodes at run end.
  for (const [antId, win] of windows) {
    if (win.episodeStart !== null) {
      finishConfinement(confinement, seed, difficulty, antId, win, ticks - 1);
    }
    if (win.embedStart !== null) {
      finishEmbedding(embedding, seed, difficulty, antId, win, ticks - 1);
    }
  }

  const worstConfinementTicks = confinement.reduce((m, e) => Math.max(m, e.lengthTicks), 0);
  const worstEmbeddingTicks = embedding.reduce((m, e) => Math.max(m, e.lengthTicks), 0);
  const confinedAnts = new Set(confinement.map((e) => e.antId)).size;

  return {
    seed,
    difficulty,
    ticks,
    confinement,
    embedding,
    worstConfinementTicks,
    worstEmbeddingTicks,
    confinedAnts,
  };
}

function observeTick(
  world: WorldState,
  t: number,
  windows: Map<number, AntWindow>,
  confinement: ConfinementEpisode[],
  embedding: EmbeddingEpisode[],
  seed: number,
  difficulty: string,
): void {
  const a = world.ants;
  for (let id = 0; id < a.alive.length; id++) {
    if (a.alive[id] !== 1) {
      // Entity ids are never recycled, so a dead ant's window lingers in the
      // map with potentially-open episodes. Close them at the last tick the ant
      // was seen alive and drop the window so it is not re-flushed (with an
      // inflated end-tick) at run end, and so a reused slot can't read stale
      // state.
      const dead = windows.get(id);
      if (dead !== undefined) {
        if (dead.episodeStart !== null)
          finishConfinement(confinement, seed, difficulty, id, dead, dead.lastSeenTick);
        if (dead.embedStart !== null)
          finishEmbedding(embedding, seed, difficulty, id, dead, dead.lastSeenTick);
        windows.delete(id);
      }
      continue;
    }
    const task = a.task[id]!;
    // Skip the queen (never moves; stored Idle underground). Use the exact
    // queen identity rather than the Idle+Underground heuristic so embedded or
    // task-parked Idle workers underground remain observable by the #128 detector.
    if (id === world.colonies[a.colonyId[id]!]?.queenEntityId) continue;

    let win = windows.get(id);
    if (win === undefined) {
      win = freshWindow();
      windows.set(id, win);
    }

    const zone = a.zone[id]!;
    const tileX = a.posX[id]! >> FP_SHIFT;
    const tileY = a.posY[id]! >> FP_SHIFT;

    if (zone === Zone.Surface) {
      observeSurface(world, t, id, win, confinement, seed, difficulty, tileX, tileY);
      // Surface ants cannot be embedded; close any open embed episode.
      if (win.embedStart !== null) finishEmbedding(embedding, seed, difficulty, id, win, t - 1);
    } else {
      observeUnderground(world, t, id, win, embedding, seed, difficulty, tileX, tileY, task);
      // Underground ants are not subject to the surface confinement model.
      if (win.episodeStart !== null)
        finishConfinement(confinement, seed, difficulty, id, win, t - 1);
    }

    win.lastSeenTick = t;
    win.lastZone = zone;
    win.lastTileX = tileX;
    win.lastTileY = tileY;
  }
}

// --- Surface confinement (#127) -------------------------------------------

function observeSurface(
  world: WorldState,
  t: number,
  id: number,
  win: AntWindow,
  confinement: ConfinementEpisode[],
  seed: number,
  difficulty: string,
  tileX: number,
  tileY: number,
): void {
  const a = world.ants;
  const isSearching =
    a.task[id] === AntTask.Foraging && a.subTask[id] === ForagingSubState.SearchingFood;

  // Only searching foragers are candidates for #127 milling. Carriers/returners
  // are goal-directed and excluded (they have a stable home target).
  if (!isSearching) {
    if (win.episodeStart !== null) finishConfinement(confinement, seed, difficulty, id, win, t - 1);
    return;
  }

  // Reset the excursion origin/high-water when a new search wave starts (the
  // ant just left an entrance) or when the ant has just re-entered the surface
  // after an underground stint, so progress is measured per-excursion. Also
  // clear the position ring so bbox/crossing detection never mixes positions
  // from a prior excursion (different entrance) or pre-dive positions.
  const wave = a.searchWave[id]!;
  if (wave !== win.lastWave || win.originX < 0 || win.lastZone !== Zone.Surface) {
    win.originX = tileX;
    win.originY = tileY;
    win.progressHW = 0;
    win.ticksSinceProgress = 0;
    win.lastWave = wave;
    win.xs.length = 0;
    win.ys.length = 0;
  }

  // Coverage progress: Chebyshev distance from the excursion origin. A genuinely
  // searching ant pushes this high-water up; a milling ant cannot.
  const cover = Math.max(Math.abs(tileX - win.originX), Math.abs(tileY - win.originY));
  if (cover > win.progressHW) {
    win.progressHW = cover;
    win.ticksSinceProgress = 0;
  } else {
    win.ticksSinceProgress++;
  }

  // Maintain the position ring.
  win.xs.push(tileX);
  win.ys.push(tileY);
  if (win.xs.length > CONFINE_WINDOW) {
    win.xs.shift();
    win.ys.shift();
  }

  // Active movement check: count tile crossings within the window.
  let crossings = 0;
  for (let i = 1; i < win.xs.length; i++) {
    if (win.xs[i] !== win.xs[i - 1] || win.ys[i] !== win.ys[i - 1]) crossings++;
  }
  const minX = Math.min(...win.xs);
  const maxX = Math.max(...win.xs);
  const minY = Math.min(...win.ys);
  const maxY = Math.max(...win.ys);
  const bbox = Math.max(maxX - minX, maxY - minY);

  const confinedNow =
    win.xs.length >= CONFINE_WINDOW &&
    bbox <= CONFINE_BBOX &&
    crossings >= CONFINE_MIN_CROSSINGS &&
    win.ticksSinceProgress >= CONFINE_MIN_TICKS;

  if (confinedNow) {
    if (win.episodeStart === null) {
      win.episodeStart = t - win.ticksSinceProgress + 1;
      win.episodeSources = {};
      win.episodeAimedWall = false;
      win.episodeTiles.clear();
    }
    const tileKey = `${tileX},${tileY}`;
    win.episodeTiles.set(tileKey, (win.episodeTiles.get(tileKey) ?? 0) + 1);
    const src = buildAntTrace(world, id).movementSource;
    win.episodeSources[src] = (win.episodeSources[src] ?? 0) + 1;
    if (!win.episodeAimedWall && aimsIntoWall(world, src, tileX, tileY)) {
      win.episodeAimedWall = true;
    }
  } else if (win.episodeStart !== null) {
    finishConfinement(confinement, seed, difficulty, id, win, t - 1);
  }
}

/** True if the ant's targeted source (priority/scent) sits next to a HardBlock —
 *  the scent/priority-vs-wall class (#127 worst case). */
function aimsIntoWall(
  world: WorldState,
  src: MovementSource,
  tileX: number,
  tileY: number,
): boolean {
  if (src !== 'scent' && src !== 'priority') return false;
  for (const [dx, dy] of DIRS) {
    if (surfaceMovementAt(world, tileX + dx, tileY + dy) === SurfaceMovementEffect.HardBlock) {
      return true;
    }
  }
  return false;
}

function finishConfinement(
  out: ConfinementEpisode[],
  seed: number,
  difficulty: string,
  antId: number,
  win: AntWindow,
  endTick: number,
): void {
  const start = win.episodeStart!;
  const len = endTick - start + 1;
  if (len >= CONFINE_MIN_TICKS) {
    // Locus = modal tile across the WHOLE detected episode (episodeTiles), so it
    // describes the same interval as lengthTicks rather than only the trailing
    // 20-sample ring.
    let bestKey = `${win.lastTileX},${win.lastTileY}`;
    let bestN = 0;
    for (const [k, n] of win.episodeTiles) {
      if (n > bestN) {
        bestN = n;
        bestKey = k;
      }
    }
    const [lx, ly] = bestKey.split(',').map(Number);
    out.push({
      seed,
      difficulty,
      antId,
      startTick: start,
      endTick,
      lengthTicks: len,
      tileX: lx!,
      tileY: ly!,
      sources: { ...win.episodeSources },
      aimedIntoWall: win.episodeAimedWall,
    });
  }
  win.episodeStart = null;
  win.episodeSources = {};
  win.episodeAimedWall = false;
  win.episodeTiles.clear();
}

// --- Underground embedding (#128) -----------------------------------------

function observeUnderground(
  world: WorldState,
  t: number,
  id: number,
  win: AntWindow,
  embedding: EmbeddingEpisode[],
  seed: number,
  difficulty: string,
  tileX: number,
  tileY: number,
  task: number,
): void {
  const a = world.ants;
  const gridColonyId = a.currentGridColonyId[id]!;
  const grid = world.undergroundGrids[gridColonyId];
  if (grid === undefined) {
    if (win.embedStart !== null) finishEmbedding(embedding, seed, difficulty, id, win, t - 1);
    return;
  }

  const passable = canEnterUndergroundTile(grid, tileX, tileY, task as AntTask);
  if (passable) {
    if (win.embedStart !== null) finishEmbedding(embedding, seed, difficulty, id, win, t - 1);
    return;
  }

  // Embedded this tick. Classify on the first detection tick only.
  if (win.embedStart === null) {
    win.embedStart = t;
    win.embedTileState = ugGet(grid, tileX, tileY);
    win.embedTask = task;
    const justDescended = win.lastZone === Zone.Surface;
    const stayedPut =
      win.lastTileX === tileX && win.lastTileY === tileY && win.lastZone === Zone.Underground;
    if (justDescended) {
      win.embedClass = 'descent-placement';
    } else if (stayedPut) {
      // Ant did not move but its tile became non-passable → terrain mutated
      // under the occupant (cancel-dig / chamber-cancel revert).
      win.embedClass = 'mutation-under-occupant';
    } else {
      win.embedClass = 'terrain-pocket';
    }
  }
}

function finishEmbedding(
  out: EmbeddingEpisode[],
  seed: number,
  difficulty: string,
  antId: number,
  win: AntWindow,
  endTick: number,
): void {
  const start = win.embedStart!;
  out.push({
    seed,
    difficulty,
    antId,
    startTick: start,
    endTick,
    lengthTicks: endTick - start + 1,
    tileX: win.lastTileX,
    tileY: win.lastTileY,
    task: win.embedTask,
    tileState: win.embedTileState,
    klass: win.embedClass!,
  });
  win.embedStart = null;
  win.embedClass = null;
  win.embedTileState = -1;
  win.embedTask = -1;
}

// ===========================================================================
// Observational neutrality assertion (plan §1, R3-P0-3)
// ===========================================================================

export interface NeutralityResult {
  neutral: boolean;
  rngStateClean: number;
  rngStateTraced: number;
  serializedEqual: boolean;
}

/**
 * Run the same (seed, difficulty, log) twice: once WITHOUT tracing, once WITH
 * full per-tick tracing, and compare the final serialized WorldState and
 * rngState. Tracing must perturb neither. Returns the comparison so callers
 * (tests) can assert.
 */
export function checkObservationalNeutrality(
  seed: number,
  difficulty: 'Easy' | 'Normal' | 'Hard',
  ticks: number,
  commandsPerTick: readonly SimCommand[][],
): NeutralityResult {
  // Clean run — no buildAntTrace calls.
  const clean = createScenario(seed, difficulty);
  for (let t = 0; t < ticks; t++) tick(clean, commandsPerTick[t] ?? []);

  // Traced run — full instrumentation each tick (same code path as the sweep).
  const traced = createScenario(seed, difficulty);
  const windows = new Map<number, AntWindow>();
  const c: ConfinementEpisode[] = [];
  const e: EmbeddingEpisode[] = [];
  for (let t = 0; t < ticks; t++) {
    tick(traced, commandsPerTick[t] ?? []);
    observeTick(traced, t, windows, c, e, seed, difficulty);
  }

  const serializedEqual =
    JSON.stringify(serializeWorldState(clean)) === JSON.stringify(serializeWorldState(traced));
  return {
    neutral: serializedEqual && clean.rngState === traced.rngState,
    rngStateClean: clean.rngState,
    rngStateTraced: traced.rngState,
    serializedEqual,
  };
}

// ===========================================================================
// Measurements (plan §4) — perf + save size. Collected with tracing DISABLED.
// ===========================================================================

export interface PerfSample {
  seed: number;
  difficulty: string;
  ticks: number;
  msTotal: number;
  msPerTick: number;
  /** Serialized WorldState size in bytes (JSON string length). */
  saveSizeBytes: number;
}

/** Time an untraced run and capture serialized save size at the end. Uses
 *  performance.now (allowed outside src/sim). */
export function measurePerfAndSize(
  seed: number,
  difficulty: 'Easy' | 'Normal' | 'Hard',
  ticks: number,
  commandsPerTick: readonly SimCommand[][],
): PerfSample {
  const world = createScenario(seed, difficulty);
  const start = performance.now();
  for (let t = 0; t < ticks; t++) tick(world, commandsPerTick[t] ?? []);
  const msTotal = performance.now() - start;
  const saveSizeBytes = JSON.stringify(serializeWorldState(world)).length;
  return {
    seed,
    difficulty,
    ticks,
    msTotal,
    msPerTick: msTotal / ticks,
    saveSizeBytes,
  };
}

/** Re-export for callers building per-colony scoped traces. */
export { PLAYER_COLONY_ID };
