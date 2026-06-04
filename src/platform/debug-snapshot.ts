// debug-snapshot.ts — render/platform-only diagnostic exporter.
//
// Produces a JSON-safe payload capturing the full replay-determining state
// (seed + inputLog + world snapshot) plus an enriched per-ant trace with the
// derived fields that aren't directly present in the SoA arrays — nearest
// entrance distance, nearby food-trail pheromone diamond, and the inferred
// movement decision source for each ant.
//
// This file deliberately lives OUTSIDE src/sim. It only READS WorldState,
// uses no wall-clock, no Math.random, no browser APIs. The thin browser-
// side downloader is src/render/debug-snapshot-download.ts; this module is
// pure data extraction and is safely testable headlessly.

import type { WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';
import {
  AntTask,
  ChamberType,
  DiggingSubState,
  FightingSubState,
  ForagingSubState,
  NursingSubState,
  PheromoneType,
} from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import { pheromoneGridKey, phGet } from '../sim/pheromone/pheromone-store.js';
import { serializeWorldState, type SerializedWorldState } from './save.js';

export const DEBUG_SNAPSHOT_VERSION = 2 as const;

/** Manhattan radius of the food-trail pheromone sample captured per ant.
 *  Matches SIGNAL_PHEROMONE_RADIUS used by hasNearbyPheromoneSignal so the
 *  exported diamond lines up with the set of cells the sim actually looked
 *  at when deciding whether to hold the ant on SearchingFood. */
export const DEBUG_TRACE_PHEROMONE_RADIUS = 3;

/** Manhattan radius of the food-scent probe in tickAntMovement. Mirrored
 *  here so the exporter's "scent" movement-source inference matches the sim
 *  without re-exporting an internal constant. Stays in sync by code review. */
const DEBUG_SCENT_RADIUS = 15;

/** Single source of truth for the movement-decision labels: each key is a
 *  value {@link inferMovementSource} may return, mapped to a plain-language
 *  explanation. The {@link MovementSource} type is DERIVED from these keys, so
 *  a new return value that lacks an entry here is a compile error — and the F9
 *  `guide` re-exports this object verbatim, so the legend can never drift from
 *  the code. Explanations mirror the precedence chain in inferMovementSource. */
export const MOVEMENT_SOURCES = {
  priority:
    'Surface SearchingFood with targetPosX/Y set → chase that priority pile (beats scent/pheromone/wander).',
  scent: `Surface SearchingFood, no priority, with a food pile within ${DEBUG_SCENT_RADIUS} tiles (Manhattan) → head toward scent.`,
  pheromone: `Surface SearchingFood, no priority/scent, with FoodTrail pheromone within ${DEBUG_TRACE_PHEROMONE_RADIUS} tiles → follow the trail.`,
  wander:
    'Surface SearchingFood with no priority/scent/pheromone signal → chooseExcursionDirection (random walk).',
  entrance:
    'CarryingFood/ReturningToNest heading to a surface entrance (also the fallback when no FoodStorage chamber exists).',
  'food-storage':
    'Underground CarryingFood routing to a FoodStorage chamber via the chamber flow-field.',
  'underground-exit':
    'Underground SearchingFood routing back to the surface via the entrance flow-field (surface scent/pheromone probes do not apply underground).',
  'nursing-chamber': 'Nursing ant routing to the Queen/Nursery chamber via the chamber flow-field.',
  rally:
    'Fighting ant moving to colony.rallyPoint (surface) or, underground, to an entrance as transit toward the rally.',
  task: 'Non-forager fallback (Digging/Idle), or a Nursing ant whose colony has no Queen/Nursery chamber.',
  dead: 'Slot is not alive (ants.alive !== 1).',
} as const;

export type MovementSource = keyof typeof MOVEMENT_SOURCES;

/** One row of the per-ant debug trace. All fields are plain numbers so the
 *  payload JSON-serializes without any TypedArray handling. */
export interface AntTraceRow {
  antId: number;
  colonyId: number;
  /** Grid-of-occupancy byte from ants.currentGridColonyId (Phase 09.1-00).
   *  Equals colonyId for all non-invasion scenarios; diverges during Phase
   *  09.1 invasion when a Fighting ant enters a foreign underground grid.
   *  Exposing it in the snapshot lets readers see at a glance which ants are
   *  inside a foreign grid without re-deriving from tile coordinates. */
  currentGridColonyId: number;
  task: number;
  subTask: number;
  zone: number;
  tileX: number;
  tileY: number;
  posX: number; // fixed-point (FP_ONE = 256)
  posY: number;
  foodCarrying: number;
  searchWave: number;
  searchHeadingX: number;
  searchHeadingY: number;
  searchHeadingTicks: number;
  searchPrevTileX: number; // -1 sentinel when no prev tile
  searchPrevTileY: number;
  targetPosX: number; // -1 sentinel when no priority target
  targetPosY: number;
  nearestEntranceDist: number; // Manhattan tiles; -1 if colony has none
  nearbyPheromoneRadius: number; // echoes DEBUG_TRACE_PHEROMONE_RADIUS
  /** Flat row-major diamond (length = (2r+1)^2). Cells outside the Manhattan
   *  diamond are emitted as 0 so the array is a simple square for consumers
   *  to pretty-print. Centre cell (the ant's tile) is the middle entry. */
  nearbyPheromone: number[];
  movementSource: MovementSource;
}

/** Static, self-describing legend embedded once per dump (negligible size vs.
 *  the playtrace 5 MB cap, ADR 0013) so an F9 snapshot can be interpreted
 *  without opening any source file. Built by {@link buildDebugGuide}; enum maps
 *  are derived from the live TS enums so they cannot drift from the code. */
export interface DebugGuide {
  /** What the top-level fields are and how the snapshot replays. */
  readonly about: string;
  /** How to decode the fixed-point position fields. */
  readonly fixedPoint: string;
  /** `-1` sentinel meaning per field (the sentinel differs by field). */
  readonly sentinels: Readonly<Record<string, string>>;
  /** value→member-name legend per enum. `subTask` is split by task (its meaning
   *  depends on the ant's `task`); `chamberType`/`pheromoneType` decode fields
   *  inside `snapshot` rather than antTrace rows. */
  readonly enums: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Shape + index formula for the flat nearbyPheromone diamond. */
  readonly nearbyPheromone: string;
  /** Re-export of {@link MOVEMENT_SOURCES}: every movementSource value explained. */
  readonly movementSource: Readonly<Record<string, string>>;
  /** Plain-language note for each non-obvious antTrace field. */
  readonly fields: Readonly<Record<string, string>>;
}

/** Envelope mirrors SaveFile (PRD §8a) with debug extensions. */
export interface DebugSnapshot {
  readonly version: number;
  /** Static interpretation legend — see {@link DebugGuide}. */
  readonly guide: DebugGuide;
  readonly seed: number;
  readonly tick: number;
  readonly inputLog: SimCommand[];
  readonly snapshot: SerializedWorldState;
  readonly antTrace: AntTraceRow[];
}

// ---------------------------------------------------------------------------
// Helpers — each one is a pure, allocation-light extraction over WorldState.
// ---------------------------------------------------------------------------

/** Nearest-entrance Manhattan distance for the given tile within the ant's
 *  own colony. Returns -1 if the colony record is missing or has no
 *  entrances — consumers read -1 as "not applicable". */
function nearestEntranceDist(
  world: WorldState,
  colonyId: number,
  tileX: number,
  tileY: number,
): number {
  const colony = world.colonies[colonyId];
  if (!colony || !colony.entrances || colony.entrances.length === 0) return -1;
  let best = -1;
  for (let e = 0; e < colony.entrances.length; e++) {
    const ent = colony.entrances[e]!;
    const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
    if (best < 0 || d < best) best = d;
  }
  return best;
}

/** Flat (2r+1)² square covering the Manhattan diamond around (tileX,tileY)
 *  in the colony's surface food-trail grid. Cells outside the diamond or off
 *  the grid read as 0. Row-major: index (dy + r) * (2r+1) + (dx + r). */
function samplePheromoneDiamond(
  world: WorldState,
  colonyId: number,
  tileX: number,
  tileY: number,
  radius: number,
): number[] {
  const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
  const grid = world.pheromoneGrids[key];
  const side = 2 * radius + 1;
  const out: number[] = new Array<number>(side * side).fill(0);
  if (!grid) return out;
  for (let dy = -radius; dy <= radius; dy++) {
    const absY = dy < 0 ? -dy : dy;
    const xRange = radius - absY;
    for (let dx = -xRange; dx <= xRange; dx++) {
      out[(dy + radius) * side + (dx + radius)] = phGet(grid, tileX + dx, tileY + dy);
    }
  }
  return out;
}

/** Does a food pile exist within DEBUG_SCENT_RADIUS Manhattan of (tileX,tileY)?
 *  Read-only scan over world.foodPiles — no RNG, no allocation beyond the bool. */
function hasNearbyScentPile(world: WorldState, tileX: number, tileY: number): boolean {
  for (let p = 0; p < world.foodPiles.length; p++) {
    const pile = world.foodPiles[p]!;
    const d = Math.abs(tileX - pile.tileX) + Math.abs(tileY - pile.tileY);
    if (d <= DEBUG_SCENT_RADIUS) return true;
  }
  return false;
}

/** Does the ant's colony surface food-trail grid have any nonzero cell in the
 *  diamond around (tileX,tileY)? Used ONLY for pheromone-source inference —
 *  this helper does not replicate the full hasNearbyPheromoneSignal prev-skip
 *  logic, so a stale-trapped ant reports "pheromone" here while the sim
 *  rightly treats it as "no signal". That divergence is diagnostic: if trace
 *  says "pheromone" but the ant is stuck, the trap is the likely cause. */
function hasNearbyTrailPheromone(
  world: WorldState,
  colonyId: number,
  tileX: number,
  tileY: number,
  radius: number,
): boolean {
  const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
  const grid = world.pheromoneGrids[key];
  if (!grid) return false;
  for (let dy = -radius; dy <= radius; dy++) {
    const absY = dy < 0 ? -dy : dy;
    const xRange = radius - absY;
    for (let dx = -xRange; dx <= xRange; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (phGet(grid, tileX + dx, tileY + dy) > 0) return true;
    }
  }
  return false;
}

/** True iff the ant's colony has at least one chamber of the given type. */
function colonyHasChamberType(
  world: WorldState,
  colonyId: number,
  chamberType: ChamberType,
): boolean {
  const colony = world.colonies[colonyId];
  if (!colony) return false;
  for (let i = 0; i < colony.chambers.length; i++) {
    if (colony.chambers[i]!.chamberType === chamberType) return true;
  }
  return false;
}

/** Reproduce tickAntMovement's decision chain as data:
 *   non-alive                        → 'dead'
 *   Nursing (underground + colony has Queen/Nursery) → 'nursing-chamber'
 *   Fighting                         → 'rally'
 *   non-forager                      → 'task'
 *   Underground CarryingFood + colony has FoodStorage → 'food-storage'
 *   CarryingFood/ReturningToNest     → 'entrance' (heads home regardless)
 *   Underground SearchingFood (foodCarrying === 0) → 'underground-exit'
 *     (tunnel-route to the surface via the entrance flow-field — scent/pheromone
 *     probes on the SURFACE grid would be misleading here)
 *   Surface SearchingFood:
 *     targetPosX/Y set → 'priority'
 *     else food pile within DEBUG_SCENT_RADIUS → 'scent'
 *     else pheromone cell within DEBUG_TRACE_PHEROMONE_RADIUS → 'pheromone'
 *     else → 'wander'
 */
function inferMovementSource(world: WorldState, antId: number): MovementSource {
  const a = world.ants;
  if (a.alive[antId] !== 1) return 'dead';
  const task = a.task[antId];
  // Nurses get their own source label so stuck underground nurses are
  // attributable to the nursing routing path, not generic 'task'.
  if (task === AntTask.Nursing) {
    const colonyId = a.colonyId[antId]!;
    const hasNurseryOrQueen =
      colonyHasChamberType(world, colonyId, ChamberType.Queen) ||
      colonyHasChamberType(world, colonyId, ChamberType.Nursery);
    if (hasNurseryOrQueen) return 'nursing-chamber';
    return 'task';
  }
  // Fighting: tickAntMovement steers surface fighters via targetPosX/Y toward
  // rallyPoint, and underground fighters via the entrance flow-field toward an
  // entrance (same path as underground foragers). Both cases are "rally" for
  // trace purposes — the goal is the rally, the underground hop is transit.
  if (task === AntTask.Fighting) return 'rally';
  if (task !== AntTask.Foraging) return 'task';
  const sub = a.subTask[antId]!;
  if (sub === ForagingSubState.CarryingFood || sub === ForagingSubState.ReturningToNest) {
    // Underground carrying foragers with a FoodStorage chamber route via the
    // chamber flow-field — distinguish from surface 'entrance' routing so the
    // trace identifies the correct stuck-path class.
    if (
      a.zone[antId] === Zone.Underground &&
      sub === ForagingSubState.CarryingFood &&
      colonyHasChamberType(world, a.colonyId[antId]!, ChamberType.FoodStorage)
    ) {
      return 'food-storage';
    }
    return 'entrance';
  }
  // Underground SearchingFood routes to surface entrance via flow-field, not
  // via the surface scent/pheromone probes. Report that explicitly so trace
  // dumps of stuck underground foragers don't read "scent" misleadingly.
  if (a.zone[antId] === Zone.Underground) return 'underground-exit';
  // Surface SearchingFood — priority > scent > pheromone > wander
  if (a.targetPosX[antId]! !== -1 && a.targetPosY[antId]! !== -1) return 'priority';
  const tileX = a.posX[antId]! >> FP_SHIFT;
  const tileY = a.posY[antId]! >> FP_SHIFT;
  if (hasNearbyScentPile(world, tileX, tileY)) return 'scent';
  const colonyId = a.colonyId[antId]!;
  if (hasNearbyTrailPheromone(world, colonyId, tileX, tileY, DEBUG_TRACE_PHEROMONE_RADIUS)) {
    return 'pheromone';
  }
  return 'wander';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build an enriched trace row for a single ant. Surface zone derives tile
 *  coords from posX/posY >> FP_SHIFT; underground ants get the same treatment
 *  (nearest-entrance/pheromone calls still use tile coords, and pheromone on
 *  the surface grid is simply zero for an underground ant — expected). */
export function buildAntTrace(world: WorldState, antId: number): AntTraceRow {
  const a = world.ants;
  const colonyId = a.colonyId[antId]!;
  const posX = a.posX[antId]!;
  const posY = a.posY[antId]!;
  const tileX = posX >> FP_SHIFT;
  const tileY = posY >> FP_SHIFT;
  return {
    antId,
    colonyId,
    currentGridColonyId: a.currentGridColonyId[antId]!,
    task: a.task[antId]!,
    subTask: a.subTask[antId]!,
    zone: a.zone[antId]!,
    tileX,
    tileY,
    posX,
    posY,
    foodCarrying: a.foodCarrying[antId]!,
    searchWave: a.searchWave[antId]!,
    searchHeadingX: a.searchHeadingX[antId]!,
    searchHeadingY: a.searchHeadingY[antId]!,
    searchHeadingTicks: a.searchHeadingTicks[antId]!,
    searchPrevTileX: a.searchPrevTileX[antId]!,
    searchPrevTileY: a.searchPrevTileY[antId]!,
    targetPosX: a.targetPosX[antId]!,
    targetPosY: a.targetPosY[antId]!,
    nearestEntranceDist: nearestEntranceDist(world, colonyId, tileX, tileY),
    nearbyPheromoneRadius: DEBUG_TRACE_PHEROMONE_RADIUS,
    nearbyPheromone:
      a.zone[antId] === Zone.Surface
        ? samplePheromoneDiamond(world, colonyId, tileX, tileY, DEBUG_TRACE_PHEROMONE_RADIUS)
        : new Array<number>((2 * DEBUG_TRACE_PHEROMONE_RADIUS + 1) ** 2).fill(0),
    movementSource: inferMovementSource(world, antId),
  };
}

/** Invert an object-const enum (`{ Member: value }`) into the snapshot legend
 *  shape (`{ "value": "Member" }`). Iterating the live enum means a newly added
 *  member appears in the guide automatically — the legend cannot silently lag
 *  the enum. */
function enumLegend(e: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(e)) {
    out[String(value)] = name;
  }
  return out;
}

/** Build the static interpretation legend embedded in every F9 dump. Enum maps
 *  are derived from the live TS enums and the diamond/scent prose from the same
 *  radius constants the sampler uses, so the guide stays in lockstep with the
 *  code. See {@link DebugGuide}. */
export function buildDebugGuide(): DebugGuide {
  const r = DEBUG_TRACE_PHEROMONE_RADIUS;
  const side = 2 * r + 1;
  return {
    about:
      'F9 debug snapshot. `snapshot` is a SerializedWorldState restorable via ' +
      'deserializeWorldState(); replaying `inputLog` from `seed` reproduces this ' +
      'exact state at `tick`. `antTrace` holds derived per-ant diagnostics not ' +
      'present in the raw SoA arrays. This `guide` is a static legend emitted ' +
      'once per dump — use its sub-keys to interpret every antTrace field ' +
      'without opening source.',
    fixedPoint:
      `posX, posY, targetPosX, targetPosY are fixed-point integers: FP_ONE=${FP_ONE} ` +
      `(FP_SHIFT=${FP_SHIFT}); tile coordinate = value >> ${FP_SHIFT}. tileX/tileY ` +
      'are already decoded from posX/posY. (targetPosX/Y also carry a -1 sentinel — see sentinels.)',
    sentinels: {
      'searchPrevTileX / searchPrevTileY': '-1 = no previous tile recorded yet',
      'targetPosX / targetPosY': '-1 = no priority target set (otherwise fixed-point coords)',
      nearestEntranceDist: "-1 = the ant's colony has no entrance (or no colony record)",
    },
    enums: {
      task: enumLegend(AntTask),
      // subTask is a union field: its enum depends on `task`. Legend each
      // variant from its own enum so a non-forager's subTask isn't mislabeled
      // with ForagingSubState names (e.g. a Nursing ant's subTask=1 is Feeding,
      // not CarryingFood).
      'subTask if task=Foraging': enumLegend(ForagingSubState),
      'subTask if task=Nursing': enumLegend(NursingSubState),
      'subTask if task=Digging': enumLegend(DiggingSubState),
      'subTask if task=Fighting': enumLegend(FightingSubState),
      zone: enumLegend(Zone),
      chamberType: enumLegend(ChamberType),
      pheromoneType: enumLegend(PheromoneType),
    },
    nearbyPheromone:
      `Flat row-major ${side}x${side} square ((2r+1)^2, r=nearbyPheromoneRadius=${r}) ` +
      "covering the Manhattan diamond |dx|+|dy|<=r around the ant's tile; cells " +
      `outside the diamond read 0. index = (dy+r)*${side} + (dx+r), so the centre ` +
      `(the ant's own tile) is index ${r * side + r}. Values are FoodTrail strength on ` +
      'the colony SURFACE grid only — all-zero for underground ants.',
    movementSource: { ...MOVEMENT_SOURCES },
    fields: {
      antId: 'entity slot id in the SoA arrays',
      colonyId: 'permanent owning colony id (never changes)',
      currentGridColonyId:
        'occupancy-grid colony byte; equals colonyId except during invasion, when a ' +
        'Fighting ant occupies a foreign underground grid',
      'task / subTask / zone':
        'enum integers — see enums (subTask is split there by task, since its meaning depends on task)',
      'tileX / tileY': 'tile coordinates already decoded from posX/posY (see fixedPoint)',
      foodCarrying: 'units of food the ant is currently carrying',
      'searchWave / searchHeadingX / searchHeadingY / searchHeadingTicks':
        'excursion-search state: wave index, current heading vector, and ticks left on this heading',
      nearbyPheromoneRadius: `Manhattan radius of the nearbyPheromone sample (echoes ${r})`,
      movementSource: 'inferred routing decision for this tick — see movementSource',
    },
  };
}

/**
 * Optional shape parameters for {@link buildDebugSnapshot}. All fields are
 * additive — omitting the argument (or passing `{}`) reproduces the original
 * "include everything" payload that the F9 export path depends on.
 *
 * The `includeAntTrace` / `includeInputLog` flags exist for the playtrace
 * upload's graceful-downgrade fallback (ADR 0013): when the gzipped body
 * would exceed the 5 MB API Gateway cap, the uploader rebuilds the snapshot
 * with antTrace omitted, then with inputLog omitted, before falling back to
 * a survey-only submission with `snapshot: null`.
 */
export interface BuildDebugSnapshotOptions {
  /** Restrict the trace to ants belonging to the listed colonies. Defaults
   *  to all live ants. Useful to scope exports to the player colony. */
  colonyFilter?: readonly number[];
  /** When false, `antTrace` is emitted as an empty array. The world snapshot
   *  still carries the raw per-ant component state; only the derived per-ant
   *  trace rows are dropped. Defaults to true. */
  includeAntTrace?: boolean;
  /** When false, `inputLog` is emitted as an empty array. The receiver loses
   *  replay value (the input sequence is what reproduces the recorded run)
   *  but the snapshot itself is still a valid point-in-time observation.
   *  Defaults to true. */
  includeInputLog?: boolean;
}

/**
 * Build a full debug snapshot for export. Captures every LIVE ant (alive === 1)
 * in the trace. Dead slots are skipped — the world snapshot preserves their
 * raw array state already, so duplicating them in the trace is noise.
 *
 * @param world     The current world state.
 * @param seed      The session seed (matches SaveFile.seed).
 * @param inputLog  The session's accumulated command log (shared reference —
 *                  caller-side is responsible for NOT mutating after the call;
 *                  each command is shallow-copied into the payload).
 * @param options   Optional payload-shape controls. See {@link BuildDebugSnapshotOptions}.
 *                  Back-compat: a bare `readonly number[]` is accepted in this
 *                  slot for legacy callers that previously passed `colonyFilter`
 *                  directly. New code should pass an options object.
 */
export function buildDebugSnapshot(
  world: WorldState,
  seed: number,
  inputLog: readonly SimCommand[],
  options?: BuildDebugSnapshotOptions | readonly number[],
): DebugSnapshot {
  // Back-compat: a bare array argument was the legacy colonyFilter signature.
  const opts: BuildDebugSnapshotOptions = Array.isArray(options)
    ? { colonyFilter: options as readonly number[] }
    : ((options as BuildDebugSnapshotOptions | undefined) ?? {});
  const includeAntTrace = opts.includeAntTrace ?? true;
  const includeInputLog = opts.includeInputLog ?? true;

  const trace: AntTraceRow[] = [];
  if (includeAntTrace) {
    const filter = opts.colonyFilter ? new Set(opts.colonyFilter) : null;
    // Queens are stored as AntTask.Idle with a queenEntityId reference on the
    // colony record — collect those entity IDs up front so the trace can skip
    // them (a queen's posX/posY never moves, so its trace row is noise).
    const queenIds = new Set<number>();
    for (const [, colony] of Object.entries(world.colonies)) {
      if (colony.queenEntityId >= 0) queenIds.add(colony.queenEntityId);
    }
    for (let id = 0; id < world.nextEntityId; id++) {
      if (world.ants.alive[id] !== 1) continue;
      if (queenIds.has(id)) continue;
      if (filter !== null && !filter.has(world.ants.colonyId[id]!)) continue;
      trace.push(buildAntTrace(world, id));
    }
  }
  return {
    version: DEBUG_SNAPSHOT_VERSION,
    guide: buildDebugGuide(),
    seed,
    tick: world.tick,
    inputLog: includeInputLog ? inputLog.map((c) => ({ ...c })) : [],
    snapshot: serializeWorldState(world),
    antTrace: trace,
  };
}

/** Default filename format — seed + tick so multiple exports from one session
 *  don't collide. Consumers can override the name when calling the downloader. */
export function defaultDebugSnapshotFilename(snap: DebugSnapshot): string {
  return `subterrans-debug-seed${snap.seed}-tick${snap.tick}.json`;
}
