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
// OBSERVATIONAL NEUTRALITY (plan §1, R3-P0-3): tracing consumes NO world RNG and
// mutates no sim state. The probes are pure reads; the pheromone-branch probe
// (sampleForagingDirection) is fed a THROWAWAY Rng that never touches
// world.rngState. The only randomness that advances the world flows through
// `tick()`'s internal Rng. `checkObservationalNeutrality` proves an instrumented
// run and a clean run end byte-identical incl. rngState.

import { tick } from '../../sim/tick.js';
import { createScenario } from '../../sim/scenario.js';
import { canEnterUndergroundTile } from '../../sim/ant/ant-system.js';
import { surfaceMovementAt, SurfaceMovementEffect } from '../../sim/surface-features.js';
import { Zone, ugGet } from '../../sim/terrain.js';
import { AntTask, ForagingSubState, PheromoneType } from '../../sim/enums.js';
import { FP_SHIFT } from '../../sim/fixed.js';
import {
  PLAYER_COLONY_ID,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  SPIDER_SCATTER_RADIUS_TILES,
} from '../../sim/constants.js';
import { Rng } from '../../sim/rng.js';
import { sampleForagingDirection } from '../../sim/pheromone/pheromone-system.js';
import { pheromoneGridKey } from '../../sim/pheromone/pheromone-store.js';
import type { WorldState } from '../../sim/types.js';
import type { SimCommand } from '../../sim/commands.js';
import type { MovementSource } from '../debug-snapshot.js';
import { serializeWorldState } from '../save.js';

/** Movement source as attributed by this harness: the sim's surface-steering
 *  precedence plus two states the `debug-snapshot` `MovementSource` enum does not
 *  distinguish — `'scatter'` (the spider-flee override, step 13e) and
 *  `'search-pause'` (the V4+ stationary pause, where `tickAntMovement` exits
 *  before any steering, so no step is intended that tick). */
export type HarnessSource = MovementSource | 'scatter' | 'search-pause';

// ===========================================================================
// Tuning — episode thresholds. These are DIAGNOSTIC detection thresholds, not
// the acceptance caps the fixes must hit (those are derived from measured
// worst-episode data on the calibration seeds — see INVESTIGATION.md).
// ===========================================================================

/** Sliding window (ticks) over which surface confinement is judged. */
export const CONFINE_WINDOW = 20;
/** Max box SIDE in distinct tiles the ant must stay within to count as confined.
 *  3 ⇒ a true 3×3 box (compared as span+1, so X=10..12 passes, X=10..13 fails). */
export const CONFINE_BBOX = 3;
/** Min tile-crossings in the window to count as "actively moving" (vs a
 *  legitimate stationary pause, which is NOT confinement). */
export const CONFINE_MIN_CROSSINGS = 4;
/** Minimum contiguous confined-tick run length to record an episode (a single
 *  duration gate; there is no separate progress gate). */
export const CONFINE_MIN_TICKS = 12;

// ===========================================================================
// Types
// ===========================================================================

/** A reproduced surface-confinement episode (#127). */
export interface ConfinementEpisode {
  seed: number;
  difficulty: string;
  antId: number;
  /** Tick confinement was CONFIRMED (window full + ≥CONFINE_MIN_TICKS of
   *  no coverage-progress). Onset is ~CONFINE_MIN_TICKS earlier; lengthTicks
   *  measures the confirmed interval so it matches sources/tile/aimedIntoWall. */
  startTick: number;
  /** Tick the episode ended (progress resumed, ant left, or run ended). */
  endTick: number;
  /** Episode length in ticks (endTick - startTick). */
  lengthTicks: number;
  /** Tile the ant was confined around (modal tile across the whole episode). */
  tileX: number;
  tileY: number;
  /** Distribution of inferred movement sources across the episode. */
  sources: Partial<Record<HarnessSource, number>>;
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
  // Active confinement episode (null if not currently confined).
  episodeStart: number | null;
  episodeSources: Partial<Record<HarnessSource, number>>;
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

/** The steering decision recorded for a tick, computed from PRE-movement state. */
interface Decision {
  source: HarnessSource;
  /** True iff the ant's intended scent/priority step lands on a HardBlock. */
  wallAim: boolean;
}

/**
 * Compute, from the CURRENT (pre-`tick`) world state, the steering decision for
 * every surface `SearchingFood` forager — the movement source and whether its
 * intended step aims into a wall. Must be called BEFORE `tick()` so the inputs
 * describe the state the ant steered from this tick, not the post-movement state
 * (Codex P1). Pure read — no `world.rngState` mutation (the pheromone branch is
 * probed with a throwaway `Rng`), so observational neutrality holds.
 *
 * The source is the EXACT sim precedence the sim resolves AT MOVEMENT TIME, not
 * the `debug-snapshot` heuristic and not the stale pre-tick `targetPos`:
 *
 *   scatter > priority > scent > pheromone > wander
 *
 * - **scatter** — `tick.ts` step 13e overrides `targetPos` for surface
 *   non-fighters within `SPIDER_SCATTER_RADIUS_TILES` of `world.scatterReticleTile`
 *   (the shadow tile set by `tickSpider` the prior tick, so it is readable at
 *   tick start). This runs AFTER priority routing, so it wins (Codex r6).
 * - **priority** — `routeForagerPriority` (step 13) sets `targetPos` from the
 *   colony's `priorityFoodPileId`, else CLEARS it. So a searcher's movement-time
 *   `targetPos` is governed by `priorityFoodPileId` here, NOT the stale pre-tick
 *   value — reconstruct from `priorityFoodPileId`, never read `targetPos`.
 * - **scent / pheromone / wander** — `findNearestScentPile`, then the real
 *   `sampleForagingDirection` (with prev-tile anti-backtrack): pheromone iff it
 *   returns a non-zero step. It only draws RNG to pick WHICH direction in its
 *   10% weak-trail explore; the zero-vs-non-zero outcome is RNG-independent, so a
 *   throwaway `Rng` reproduces the branch without touching `world.rngState`.
 *
 * Residual (INVESTIGATION.md §9): the trail grid is read one tick stale (deposit/
 * decay run mid-`tick` before movement) — far smaller than the prior heuristic.
 */
function computeDecisions(world: WorldState): Map<number, Decision> {
  const a = world.ants;
  const out = new Map<number, Decision>();
  const probeRng = new Rng(1); // throwaway; never touches world.rngState
  const reticle = world.scatterReticleTile;
  for (let id = 0; id < a.alive.length; id++) {
    if (a.alive[id] !== 1) continue;
    if (a.zone[id] !== Zone.Surface) continue;
    if (a.task[id] !== AntTask.Foraging || a.subTask[id] !== ForagingSubState.SearchingFood)
      continue;
    const tileX = a.posX[id]! >> FP_SHIFT;
    const tileY = a.posY[id]! >> FP_SHIFT;

    // V4+ search pause: when searchPauseTicks > 0, tickAntMovement decrements and
    // `continue`s BEFORE consulting scatter/priority/scent/pheromone — no step is
    // intended this tick, so it is a non-steering state, never a wall-aim (Codex
    // P2). Pre-tick searchPauseTicks equals the movement-time value (steps 1–15
    // do not touch it). The pause-ENTRY tick (searchPauseTicks == 0 → set via an
    // RNG roll) cannot be detected pre-tick without drawing world RNG; that is a
    // documented ≤1-tick-per-pause residual (INVESTIGATION.md §9).
    if (a.searchPauseTicks[id]! > 0) {
      out.set(id, { source: 'search-pause', wallAim: false });
      continue;
    }

    let source: HarnessSource;
    let target: { tileX: number; tileY: number } | null = null;
    if (
      reticle !== null &&
      Math.abs(tileX - reticle.x) + Math.abs(tileY - reticle.y) <= SPIDER_SCATTER_RADIUS_TILES
    ) {
      source = 'scatter'; // spider flee — not a scent/priority wall-pin
    } else {
      const priority = priorityPileFor(world, a.colonyId[id]!);
      const scent = priority ?? nearestScentPile(world, tileX, tileY);
      if (priority !== null) {
        source = 'priority';
        target = priority;
      } else if (scent !== null) {
        source = 'scent';
        target = scent;
      } else {
        const grid =
          world.pheromoneGrids[
            pheromoneGridKey(a.colonyId[id]!, PheromoneType.FoodTrail, 'surface')
          ];
        const dir =
          grid === undefined
            ? { dx: 0, dy: 0 }
            : sampleForagingDirection(
                grid,
                tileX,
                tileY,
                probeRng,
                a.searchPrevTileX[id],
                a.searchPrevTileY[id],
              );
        source = dir.dx !== 0 || dir.dy !== 0 ? 'pheromone' : 'wander';
      }
    }
    // Wall-aim only for the targeted scent/priority class — the #127 worst case.
    const wallAim =
      target !== null && stepHitsWall(world, tileX, tileY, target.tileX, target.tileY);
    out.set(id, { source, wallAim });
  }
  return out;
}

/** Resolve a colony's priority food pile (set via MarkFoodPile) to tile coords,
 *  mirroring `routeForagerPriority`. Null if the colony has none or the id is
 *  stale. The harness issues no `MarkFoodPile`, so this is null in every sweep —
 *  kept for faithfulness to general worlds. */
function priorityPileFor(
  world: WorldState,
  colonyId: number,
): { tileX: number; tileY: number } | null {
  const colony = world.colonies[colonyId];
  if (colony === undefined || colony.priorityFoodPileId === null) return null;
  for (const pile of world.foodPiles) {
    if (pile.foodPileId === colony.priorityFoodPileId) {
      return { tileX: pile.tileX, tileY: pile.tileY };
    }
  }
  return null;
}

/** True iff the cardinal/diagonal step toward (targetX,targetY) — the sim's
 *  `pickCardinalStep` packing (per-axis sign, 8-connected) — lands on a
 *  HardBlock. The precise scent/priority-vs-wall test (Codex P1). */
function stepHitsWall(
  world: WorldState,
  tileX: number,
  tileY: number,
  targetTileX: number,
  targetTileY: number,
): boolean {
  const rawDx = targetTileX - tileX;
  const rawDy = targetTileY - tileY;
  const dx = rawDx === 0 ? 0 : rawDx > 0 ? 1 : -1;
  const dy = rawDy === 0 ? 0 : rawDy > 0 ? 1 : -1;
  if (dx === 0 && dy === 0) return false;
  return surfaceMovementAt(world, tileX + dx, tileY + dy) === SurfaceMovementEffect.HardBlock;
}

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
    const decisions = computeDecisions(world); // PRE-movement steering decisions.
    tick(world, commandsPerTick[t] ?? []);
    observeTick(world, t, windows, confinement, embedding, seed, difficulty, decisions);
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
  decisions: Map<number, Decision>,
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
      observeSurface(
        world,
        t,
        id,
        win,
        confinement,
        seed,
        difficulty,
        tileX,
        tileY,
        decisions.get(id),
      );
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
  decision: Decision | undefined,
): void {
  const a = world.ants;
  // Eligibility brackets the tick from BOTH ends, because the sim flips the
  // forager subtask mid-tick at boundaries the harness cannot observe directly:
  //   - tick start: `decision` is defined iff the ant was a surface SearchingFood
  //     forager (computeDecisions, pre-`tick`).
  //   - movement time (step 16): `tickExcursionBoundary` (step 9c) may have
  //     demoted SearchingFood→ReturningToNest (leash) or promoted the reverse
  //     BEFORE the ant moved (Codex r10); and `tickForagerActions` (step 16b)
  //     flips SearchingFood→CarryingFood AFTER a searching move on a pickup (r9).
  // A tick counts as a searching movement iff the ant was a searcher at tick
  // start AND is still SearchingFood OR has just picked up (CarryingFood)
  // post-tick. This EXCLUDES leash-demote home-movement ticks (post-tick
  // ReturningToNest) and is conservative on the resume tick (post-tick searcher
  // but not at tick start → its window restarts on the wave bump anyway). The
  // dominant scent-vs-wall pins are immune: a wall-pinned ant never travels past
  // its leash radius, so step 9c never fires for it.
  const postTask = a.task[id];
  const postSub = a.subTask[id];
  const postEligible =
    postTask === AntTask.Foraging &&
    (postSub === ForagingSubState.SearchingFood || postSub === ForagingSubState.CarryingFood);
  const isSearching = decision !== undefined && postEligible;

  // Only searching foragers are candidates for #127 milling. Carriers/returners
  // are goal-directed and excluded (they have a stable home target).
  if (!isSearching) {
    if (win.episodeStart !== null) finishConfinement(confinement, seed, difficulty, id, win, t - 1);
    // Clear the ring so a SearchingFood → ReturningToNest → SearchingFood flip
    // (which `tickExcursionBoundary` can do WITHOUT bumping searchWave) cannot
    // stitch pre-return positions into the next search stint's bbox window
    // (Codex r5) — the window must hold only contiguous searching ticks.
    win.xs.length = 0;
    win.ys.length = 0;
    return;
  }

  // Clear the position ring when a new search wave starts (the ant just left an
  // entrance) or it has just re-entered the surface after an underground stint,
  // so bbox/crossing detection never mixes positions from a prior excursion
  // (different entrance) or pre-dive positions.
  const wave = a.searchWave[id]!;
  if (wave !== win.lastWave || win.lastZone !== Zone.Surface) {
    win.lastWave = wave;
    win.xs.length = 0;
    win.ys.length = 0;
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
  // Box SIDE in distinct tiles (span + 1): X=10..13 is a 4-tile side, not 3.
  const boxSide = Math.max(maxX - minX, maxY - minY) + 1;

  // Confined THIS tick: trapped in a box of at most CONFINE_BBOX tiles per side
  // over the full window while still actively moving. Staying boxed for the whole
  // trailing window is itself the no-progress signal — no separate progress gate
  // (which, combined with the duration gate in finishConfinement, would
  // double-count the threshold and drop qualifying short episodes — Codex P1-b).
  // An episode is the contiguous run of confined ticks; finishConfinement keeps
  // only runs ≥ CONFINE_MIN_TICKS.
  const confinedNow =
    win.xs.length >= CONFINE_WINDOW &&
    boxSide <= CONFINE_BBOX &&
    crossings >= CONFINE_MIN_CROSSINGS;

  if (confinedNow) {
    if (win.episodeStart === null) {
      // Start at the first confined tick. startTick, endTick, lengthTicks,
      // sources, tileX/tileY, and aimedIntoWall therefore all describe the exact
      // same interval [first-confined .. resolution] — no coverage gap (Codex P2).
      win.episodeStart = t;
      win.episodeSources = {};
      win.episodeAimedWall = false;
      win.episodeTiles.clear();
    }
    const tileKey = `${tileX},${tileY}`;
    win.episodeTiles.set(tileKey, (win.episodeTiles.get(tileKey) ?? 0) + 1);
    // Source + wall-aim come from the PRE-movement decision for this tick
    // (computeDecisions) — the exact sim precedence, not a post-tick recompute
    // (Codex P1). `decision` is present for every surface SearchingFood ant; if
    // an ant became a searcher this very tick (so the pre-tick pass missed it),
    // skip its source tally for this one tick rather than fabricate it.
    if (decision !== undefined) {
      let source = decision.source;
      let wallAim = decision.wallAim;
      // Pause-ENTRY relabel (Codex r8): when the pause RNG fired this tick
      // (pre-tick searchPauseTicks was 0, so `decision` holds a steering source),
      // tickAntMovement entered the pause and skipped the step — leaving
      // searchPauseTicks > 0 post-tick. Detect that transition and relabel the
      // entry tick `search-pause` so it can never contribute a false wall-aim or
      // inflate a steering count. (A normal steering tick leaves it 0; an
      // in-pause tick was already labeled `search-pause` pre-tick.)
      if (source !== 'search-pause' && a.searchPauseTicks[id]! > 0) {
        source = 'search-pause';
        wallAim = false;
      }
      win.episodeSources[source] = (win.episodeSources[source] ?? 0) + 1;
      if (wallAim) win.episodeAimedWall = true;
    }
  } else if (win.episodeStart !== null) {
    finishConfinement(confinement, seed, difficulty, id, win, t - 1);
  }
}

/**
 * Manhattan radius of the sim's food-scent probe (`FOOD_SCENT_RADIUS`,
 * `ant-system.ts:2834`, not exported). Mirrored here so the harness reconstructs
 * the SAME scent target the sim chose. Kept in sync by code review — matches the
 * mirror `debug-snapshot.ts` already maintains for the same constant.
 */
const HARNESS_FOOD_SCENT_RADIUS = 15;

/**
 * Replicate `findNearestScentPile` (`ant-system.ts`): nearest food pile within
 * FOOD_SCENT_RADIUS (Manhattan), tie-break lowest id. Returns null if none.
 * Exact for the harness because the sim mutates `foodPiles` only after movement
 * (deplete step 16b, spawn step 16d), so a pre-`tick` read matches movement time.
 */
function nearestScentPile(
  world: WorldState,
  tileX: number,
  tileY: number,
): { tileX: number; tileY: number } | null {
  let bestDist = HARNESS_FOOD_SCENT_RADIUS + 1;
  let bestId = -1;
  let bestX = 0;
  let bestY = 0;
  for (const pile of world.foodPiles) {
    const d = Math.abs(pile.tileX - tileX) + Math.abs(pile.tileY - tileY);
    if (d > HARNESS_FOOD_SCENT_RADIUS) continue;
    if (d < bestDist || (d === bestDist && pile.foodPileId < bestId)) {
      bestDist = d;
      bestId = pile.foodPileId;
      bestX = pile.tileX;
      bestY = pile.tileY;
    }
  }
  return bestId === -1 ? null : { tileX: bestX, tileY: bestY };
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
    const decisions = computeDecisions(traced); // PRE-movement, same path as the sweep.
    tick(traced, commandsPerTick[t] ?? []);
    observeTick(traced, t, windows, c, e, seed, difficulty, decisions);
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
