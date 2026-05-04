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
// Issue #87 — shared BFS expansion (was inline pre-#87, near-identical to
// dig-system.ts and chamber-flow.ts copies). Direction encoding:
//   0=N (toward tileY=0, surface side of a shaft), 1=E, 2=S, 3=W;
//   -1=source (open entrance underground tile), -2=unreachable.
import { bfsExpandSeededField } from './bfs-flow-field.js';

// ---------------------------------------------------------------------------
// EntranceFlowFields — per-colony flow-field cache, transient (not saved).
// ---------------------------------------------------------------------------

export interface EntranceFlowFields {
  /** Direction array per colony. Key = colonyId. Value = Int32Array of length W*H. */
  fields: Record<ColonyId, Int32Array>;
  /** BFS scratch queue per colony. Pre-allocated to avoid per-tick allocation. */
  queues: Record<ColonyId, Int32Array>;
}

/**
 * Create an EntranceFlowFields cache — call once at module init.
 * Both maps start empty; ensureEntranceFlowField allocates lazily per colony.
 */
export function createEntranceFlowFields(): EntranceFlowFields {
  return { fields: {}, queues: {} };
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
