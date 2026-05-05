// entrance-flow.ts — multi-source BFS flow-field toward underground entrance tiles.
//
// Mirror of src/sim/dig-system.ts (which BFS's toward Marked dig targets), but
// seeded from OPEN entrance underground tiles (tileY=0 at ent.surfaceTileX for
// every ent.isOpen) and expanded through Open/BeingDug tiles only.
//
// Why a dedicated field: a forager returning to the surface from deep in the
// tunnel network needs tunnel-aware routing. The previous straight-line
// steering ("pick axis with larger delta, step one cardinal") walks into solid
// dirt whenever the tunnel bends — the underground passability guard then
// rejects the step every tick and the ant appears frozen inside a chamber.
// See the seed-914637646 tick-3399 debug snapshot: worker 17 stuck at (43,19)
// inside FoodStorage, target (24,0), left-step blocked by solid dirt.
//
// Scope: BFS computation + per-colony Int32Array cache only. This module does
// NOT write tiles, does NOT write ant components, does NOT drive movement.
// Movement consumers (tickAntMovement) read the direction value at the ant's
// current tile and convert it to a dx/dy step.
//
// DO NOT import Phaser, DOM, or any non-sim module.
// DO NOT use Math.random(), Date, performance.now(), or floating-point math.

import type { ColonyId } from './colony/colony-store.js';
import type { NestEntrance } from './colony/entrance.js';
import { UndergroundTileState } from './terrain.js';
import type { UndergroundGrid } from './terrain.js';
import type { WorldState } from './types.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';
import { surfaceMovementAt, SurfaceMovementEffect } from './surface-features.js';

// Static check: the surface BFS at the bottom of this file uses bit-shift
// row decode (`idx >> 7`) on the assumption that SURFACE_GRID_WIDTH is a
// power of 2. If the constant ever leaves 128, the SURFACE_WIDTH_SHIFT
// constant inside `computeSurfaceEntranceFlowField` MUST update in
// lockstep. This satisfies-clause fails to compile if the value drifts.
const _SURFACE_WIDTH_IS_128: 128 = SURFACE_GRID_WIDTH;
void _SURFACE_WIDTH_IS_128;
// Issue #87 — shared BFS expansion (was inline pre-#87, near-identical to
// dig-system.ts and chamber-flow.ts copies). Direction encoding:
//   0=N (toward tileY=0, surface side of a shaft), 1=E, 2=S, 3=W;
//   -1=source (open entrance underground tile), -2=unreachable.
import { bfsExpandSeededField } from './bfs-flow-field.js';

// ---------------------------------------------------------------------------
// EntranceFlowFields — per-colony flow-field cache, transient (not saved).
// ---------------------------------------------------------------------------

export interface EntranceFlowFields {
  /** Underground direction array per colony — points toward nearest open entrance underground tile. */
  fields: Record<ColonyId, Int32Array>;
  /** BFS scratch queue per colony for the underground field. */
  queues: Record<ColonyId, Int32Array>;
  /**
   * Issue #63 — surface direction array per colony. Points toward the nearest
   * open entrance through non-HardBlock surface tiles. Lets surface ants
   * targeting an entrance (CarryingFood / ReturningToNest) escape pockets
   * formed by clusters of multi-tile HardBlock features (boulders, twigs,
   * leaves) that the 1-tile pickSurfaceDetour can't reason about.
   */
  surface: Record<ColonyId, Int32Array>;
  /** BFS scratch queue per colony for the surface field. */
  surfaceQueues: Record<ColonyId, Int32Array>;
}

/**
 * Create an EntranceFlowFields cache — call once at module init.
 * All maps start empty; ensureEntranceFlowField allocates lazily per colony.
 */
export function createEntranceFlowFields(): EntranceFlowFields {
  return { fields: {}, queues: {}, surface: {}, surfaceQueues: {} };
}

/**
 * Ensure the flow-field buffers for a colony are allocated.
 *
 * @param cache     - Shared EntranceFlowFields cache.
 * @param colonyId  - Colony whose buffers to ensure.
 * @param gridSize  - Total tile count (width × height) for the underground grid.
 * @returns The direction Int32Array for the colony.
 */
export function ensureEntranceFlowField(
  cache: EntranceFlowFields,
  colonyId: ColonyId,
  gridSize: number,
): Int32Array {
  if (!(colonyId in cache.fields)) {
    cache.fields[colonyId] = new Int32Array(gridSize);
    cache.queues[colonyId] = new Int32Array(gridSize);
  }
  return cache.fields[colonyId]!;
}

/**
 * Issue #63 — ensure the SURFACE flow-field buffers for a colony are allocated.
 * Sized to the surface grid (128×128 fixed). Lazy per colony.
 */
export function ensureSurfaceEntranceFlowField(
  cache: EntranceFlowFields,
  colonyId: ColonyId,
): Int32Array {
  if (!(colonyId in cache.surface)) {
    const size = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;
    cache.surface[colonyId] = new Int32Array(size);
    cache.surfaceQueues[colonyId] = new Int32Array(size);
  }
  return cache.surface[colonyId]!;
}

/**
 * Multi-source BFS from all open entrance underground tiles through Open and
 * BeingDug tiles. Output at each reachable tile is the direction an ant should
 * step to head one tile closer to the nearest open entrance.
 *
 * BFS expands through Open and BeingDug. Marked (including Queen/Nursery/
 * FoodStorage footprints still in excavation) and Solid are walls. An ant
 * that finds itself on a Marked/Solid tile gets -2 (unreachable) — the caller
 * must fall back safely (e.g. hold position) rather than oscillate.
 *
 * @param underground - The colony's underground grid (read-only).
 * @param entrances   - The colony's entrance array. Closed entrances are skipped.
 * @param out         - Pre-allocated Int32Array of length W*H. Filled in-place.
 * @param queue       - Pre-allocated Int32Array of length W*H for BFS queue.
 */
export function computeEntranceFlowField(
  underground: UndergroundGrid,
  entrances: ReadonlyArray<NestEntrance>,
  out: Int32Array,
  queue: Int32Array,
): void {
  const { data, width, height } = underground;

  // Step 1: fill out with -2 (unreachable sentinel).
  out.fill(-2);

  // Step 2: seed BFS from each open entrance underground tile (tileY=0 at
  // ent.surfaceTileX). Skip closed entrances — an ant can't exit through
  // them. Skip entries that are out-of-bounds or not actually passable
  // (defensive — shouldn't happen for a real open entrance, since
  // checkEntranceCompletion only flips isOpen=true once the shaft is Open).
  let tail = 0;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    const sx = ent.surfaceTileX;
    if (sx < 0 || sx >= width) continue;
    const idx = sx; // row 0, col sx → 0 * width + sx
    const state = data[idx]!;
    if (state !== UndergroundTileState.Open && state !== UndergroundTileState.BeingDug) continue;
    if (out[idx] !== -2) continue; // dedupe: multiple entrances at same column
    out[idx] = -1;                 // source tile
    queue[tail++] = idx;
  }

  // Step 3: BFS expansion through Open and BeingDug (shared helper).
  // Solid and Marked are walls for a non-digger returning to the surface.
  bfsExpandSeededField(out, queue, tail, data, width, height);
}

// ---------------------------------------------------------------------------
// Issue #63 — surface entrance flow field.
//
// Multi-source BFS from each open entrance's SURFACE tile (at row 0 column
// surfaceTileX), expanded through non-HardBlock surface tiles. Output at
// each reachable tile is the direction an ant should step to head one tile
// closer to the nearest open entrance.
//
// Why a dedicated field:
//   - Pre-#63 surface ants targeting an entrance used straight-line
//     pickCardinalStep + 1-tile pickSurfaceDetour. The detour can't escape
//     pockets formed by clusters of multi-tile HardBlock features (4×4
//     boulder, 6×3 twig, 3×4 BigLeaf), and the picker scores by Manhattan
//     to the BLOCKED tile rather than the actual destination — so candidate
//     scores tie and the compass tie-break can route the ant AWAY from goal.
//   - The BFS is a true shortest-path-through-walkable-tiles solver.
//     No tie-break ambiguity, no pocket trapping.
//
// Encoding mirrors the underground field at the top of this file:
//   0=N  1=E  2=S  3=W  -1=source  -2=unreachable
//
// Direction at each tile is `out[ty * width + tx]`, where width =
// SURFACE_GRID_WIDTH (128). Caller derives `tileX/tileY` from the ant's
// posX/posY and reads `out[ty * width + tx]`.
//
// Cost: O(W*H) per call. With W*H = 128*128 = 16384, this is comparable to
// the underground field. Recomputed only when surface flow goes dirty (today:
// every tick alongside underground; future optimization could gate on
// entrance changes since surface terrain features are static post-init).
// ---------------------------------------------------------------------------

export function computeSurfaceEntranceFlowField(
  world: WorldState,
  entrances: ReadonlyArray<NestEntrance>,
  out: Int32Array,
  queue: Int32Array,
): void {
  const width = SURFACE_GRID_WIDTH;
  const height = SURFACE_GRID_HEIGHT;

  // Step 1: -2 fill (unvisited sentinel).
  out.fill(-2);

  // Step 2: seed from open entrance surface tiles. The entrance's surface
  // tile is (surfaceTileX, surfaceTileY) — typically (sx, 0) but read both
  // for forward-compat with future entrance-elevation features.
  let tail = 0;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    const sx = ent.surfaceTileX;
    const sy = ent.surfaceTileY;
    if (sx < 0 || sx >= width) continue;
    if (sy < 0 || sy >= height) continue;
    // Defensive: skip if the entrance tile itself is a HardBlock (shouldn't
    // happen — DesignateEntrance handler guards against placement on a
    // HardBlock — but the BFS would never reach it from itself anyway).
    if (surfaceMovementAt(world, sx, sy) === SurfaceMovementEffect.HardBlock) continue;
    const idx = sy * width + sx;
    if (out[idx] !== -2) continue; // dedupe
    out[idx] = -1; // source
    queue[tail++] = idx;
  }

  // Step 3: 4-cardinal BFS expansion through non-HardBlock surface tiles.
  // Inline rather than reusing bfsExpandSeededField because the predicate
  // differs (surface uses SurfaceMovementEffect, not UndergroundTileState).
  // Direction encoding matches: 0=N, 1=E, 2=S, 3=W; out[neighbor] gets
  // REVERSE[d] = direction pointing back toward the source.
  //
  // Codex P1 follow-up — `(idx / width) | 0` was disabled-eslint here in
  // the first pass; replaced with shift/mask. SURFACE_GRID_WIDTH is fixed
  // at 128 = 2^7, so `idx >> 7` equals integer division for our range
  // (idx in [0, 128*128)). Same for column via `idx & 127`. Integer-only,
  // ESLint-clean, single-instruction. If SURFACE_GRID_WIDTH ever leaves
  // power-of-2 territory, this needs a strategy change (and the
  // SHIFT/MASK constants below need to update accordingly).
  const SURFACE_WIDTH_SHIFT = 7;       // log2(128)
  const SURFACE_WIDTH_MASK  = width - 1; // 127
  const REVERSE = [2, 3, 0, 1] as const;
  const NEIGHBOR_DR = [-1, 0, 1, 0] as const;
  const NEIGHBOR_DC = [0, 1, 0, -1] as const;

  let head = 0;
  while (head < tail) {
    const idx = queue[head++]!;
    const row = idx >> SURFACE_WIDTH_SHIFT;
    const col = idx & SURFACE_WIDTH_MASK;

    for (let d = 0; d < 4; d++) {
      const nRow = row + NEIGHBOR_DR[d]!;
      const nCol = col + NEIGHBOR_DC[d]!;
      if (nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) continue;
      const nIdx = nRow * width + nCol;
      if (out[nIdx] !== -2) continue;
      // Predicate: any non-HardBlock surface tile is passable. Cosmetic and
      // SoftCost both pass — the SoftCost speed penalty is applied separately
      // by the per-step movement code, doesn't affect routing reachability.
      if (surfaceMovementAt(world, nCol, nRow) === SurfaceMovementEffect.HardBlock) continue;
      out[nIdx] = REVERSE[d]!;
      queue[tail++] = nIdx;
    }
  }
}
