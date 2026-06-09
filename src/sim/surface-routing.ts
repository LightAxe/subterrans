// surface-routing.ts — PR 5 Fix-A: passability-aware forager stepping.
//
// The naive cardinal step (`pickCardinalStep`) aimed an ant's move straight at
// its scent/priority target regardless of walls — the dominant #127 mechanism
// (86% of episodes, every one of the 10 longest, all `aimedIntoWall`). This
// module replaces that step (NOT the target selection) with a step derived from
// a COMPLETE breadth-first goal field: distance-to-target over the single
// connected walkable component of the FROZEN terrain (PR 4). Because terrain is
// static, each target's field is computed once and cached per world; descent
// over it can never aim into a wall and — with PR 4's single-component
// reachable-spawn guarantee — always reaches the target.
//
// Pure (FNDN-04): no Phaser/DOM/Math.random/Date/float; `/` is lint-banned in
// src/sim, so index math uses `%` + bit ops (mirrors computeSurfaceComponentMask).

import type { WorldState } from './types.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';
import { SurfaceMovementEffect } from './surface-features.js';

const SURFACE_TILE_COUNT = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;

/** Goal-field cell value for a tile not reachable from the target (off-component
 *  or HardBlock). Target-reachable tiles hold their BFS distance (>= 0). */
export const SURFACE_GOAL_UNREACHED = -1;

/** Bound on the per-world goal-field cache. Distinct live targets (food piles +
 *  priority tiles) are few (~tens), but depleted/respawned piles' fields are
 *  never invalidated and linger, so the distinct-key set grows slowly over a long
 *  game. The cap sits well ABOVE the realistic live-target count (MAX_FOOD_PILES
 *  = 60 + a couple priority tiles) so the active working set is never cleared
 *  mid-use. On overflow the whole cache is cleared; the next ticks rebuild only
 *  the handful of CURRENTLY-targeted fields (a re-request caches on first touch,
 *  so it is ~active-targets BFS rebuilds, not O(piles x ants)). 256 gives 4x
 *  headroom while bounding memory at 256 x Int32Array(SURFACE_TILE_COUNT) = 16 MB
 *  (vs 64 MB at 1024) — ample for many food spawn cycles before any clear. */
const SURFACE_GOAL_FIELD_CACHE_CAP = 256;

/**
 * Three-valued step result, encoded to avoid per-call allocation in the movement
 * hot loop. `stepTowardReachable` returns a packed step using the SAME encoding
 * as ant-system's `packStep` — `((dy + 1) << 2) | (dx + 1)` with dx,dy in
 * {-1,0,1} — so callers decode with the existing `unpackStepDx/Dy`. The (0,0)
 * step IS the AtGoal case (the ant is on its target tile; hold for the tick's
 * pickup). The third value, InvariantViolation, is a thrown error: on a COMPLETE
 * field a reachable target always yields AtGoal or a real Step, so no-path means
 * PR 4's single-component connectivity invariant was violated — assert, never
 * silently mill.
 */
export function packReachableStep(dx: number, dy: number): number {
  return ((dy + 1) << 2) | (dx + 1);
}

/** The AtGoal sentinel — a (0,0) step (distance 0; ant already on its target). */
export const SURFACE_STEP_AT_GOAL = packReachableStep(0, 0);

/**
 * BFS distance-to-target over the connected component of the frozen terrain
 * (4-connected, non-HardBlock). Returns Int32Array(SURFACE_TILE_COUNT): each
 * cell is the tile-count distance to (targetTileX, targetTileY), or
 * SURFACE_GOAL_UNREACHED for tiles in no/another component. Pure +
 * allocation-bounded (one Int32Array field + one Int32Array queue).
 */
export function computeSurfaceGoalField(
  grid: Uint8Array,
  targetTileX: number,
  targetTileY: number,
): Int32Array {
  if (grid.length !== SURFACE_TILE_COUNT) {
    throw new Error(
      `computeSurfaceGoalField: grid length ${grid.length} !== ${SURFACE_TILE_COUNT}`,
    );
  }
  const dist = new Int32Array(SURFACE_TILE_COUNT).fill(SURFACE_GOAL_UNREACHED);
  if (
    targetTileX < 0 ||
    targetTileY < 0 ||
    targetTileX >= SURFACE_GRID_WIDTH ||
    targetTileY >= SURFACE_GRID_HEIGHT
  ) {
    return dist;
  }
  const targetIdx = targetTileY * SURFACE_GRID_WIDTH + targetTileX;
  if (grid[targetIdx] === SurfaceMovementEffect.HardBlock) return dist;
  const queue = new Int32Array(SURFACE_TILE_COUNT);
  let head = 0;
  let tail = 0;
  dist[targetIdx] = 0;
  queue[tail++] = targetIdx;
  while (head < tail) {
    const idx = queue[head++]!;
    const next = dist[idx]! + 1;
    const x = idx % SURFACE_GRID_WIDTH;
    // 4-connected neighbours derived from idx without division: North exists iff
    // idx >= WIDTH; South iff idx < tileCount - WIDTH; West iff x > 0; East iff
    // x < WIDTH - 1.
    if (idx >= SURFACE_GRID_WIDTH)
      tail = visitGoalNeighbour(grid, dist, queue, idx - SURFACE_GRID_WIDTH, next, tail);
    if (idx < SURFACE_TILE_COUNT - SURFACE_GRID_WIDTH)
      tail = visitGoalNeighbour(grid, dist, queue, idx + SURFACE_GRID_WIDTH, next, tail);
    if (x < SURFACE_GRID_WIDTH - 1)
      tail = visitGoalNeighbour(grid, dist, queue, idx + 1, next, tail);
    if (x > 0) tail = visitGoalNeighbour(grid, dist, queue, idx - 1, next, tail);
  }
  return dist;
}

function visitGoalNeighbour(
  grid: Uint8Array,
  dist: Int32Array,
  queue: Int32Array,
  nIdx: number,
  nDist: number,
  tail: number,
): number {
  if (dist[nIdx] === SURFACE_GOAL_UNREACHED && grid[nIdx] !== SurfaceMovementEffect.HardBlock) {
    dist[nIdx] = nDist;
    queue[tail++] = nIdx;
  }
  return tail;
}

/**
 * Memoised goal field for (targetTileX, targetTileY), cached on the world keyed
 * by target tile index. Terrain is immutable (PR 4), so a tile-keyed field never
 * needs invalidation while the world lives — a depleted pile's field simply goes
 * unused and a new pile elsewhere builds its own. Bounded; clears all on
 * overflow. Derived state (not serialized), like `surfaceComponentMask`.
 */
export function ensureSurfaceGoalField(
  world: WorldState,
  targetTileX: number,
  targetTileY: number,
): Int32Array {
  let cache = world.surfaceGoalFields;
  if (cache === null) {
    cache = new Map<number, Int32Array>();
    world.surfaceGoalFields = cache;
  }
  const key = targetTileY * SURFACE_GRID_WIDTH + targetTileX;
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const field = computeSurfaceGoalField(world.bakedSurfaceEffect, targetTileX, targetTileY);
  if (cache.size >= SURFACE_GOAL_FIELD_CACHE_CAP) cache.clear();
  cache.set(key, field);
  return field;
}

/** Path distance (tile count) from (fromTileX, fromTileY) to the target over the
 *  static field, or SURFACE_GOAL_UNREACHED if the source tile cannot reach it.
 *  Used to rank scent candidates by reachable path length (R2-3). */
export function surfaceGoalDistance(
  world: WorldState,
  fromTileX: number,
  fromTileY: number,
  targetTileX: number,
  targetTileY: number,
): number {
  if (
    fromTileX < 0 ||
    fromTileY < 0 ||
    fromTileX >= SURFACE_GRID_WIDTH ||
    fromTileY >= SURFACE_GRID_HEIGHT
  ) {
    return SURFACE_GOAL_UNREACHED;
  }
  const field = ensureSurfaceGoalField(world, targetTileX, targetTileY);
  return field[fromTileY * SURFACE_GRID_WIDTH + fromTileX]!;
}

// Step descent order (deterministic): cardinals first, then diagonals, matching
// the no-revisit ALT sweep's N,E,S,W,NE,SE,SW,NW spirit. Cardinals are tried
// before diagonals so an equal-distance cardinal wins the tie (a 4-connected
// field always has a cardinal neighbour at distance-1, so a step always exists).
const STEP_DX = [0, 1, 0, -1, 1, 1, -1, -1] as const; // N, E, S, W, NE, SE, SW, NW
const STEP_DY = [-1, 0, 1, 0, -1, 1, 1, -1] as const;

/**
 * One passability-aware step from (fromTileX, fromTileY) toward
 * (targetTileX, targetTileY) over the complete goal field. Returns a packed step
 * (decode with unpackStepDx/Dy). (0,0) means AtGoal (already on the target).
 * Throws on InvariantViolation — no path on a complete field, structurally
 * impossible post-PR 4 (single connected component + reachable spawn), so it is
 * an assert, not a silent mill.
 *
 * Descent picks, among the 8 neighbours, a passable one whose goal-field
 * distance is STRICTLY LESS than the current tile's, choosing the minimum
 * distance (cardinals tried first so an equal-distance cardinal wins the tie).
 *
 * A diagonal is only eligible when at least one of its two shared orthogonals is
 * itself passable AND strictly closer than the current tile — i.e. a legal
 * stepping cardinal exists. This is NOT guaranteed by the field alone: in a
 * 4-connected BFS a diagonal reached via a wrap-around path can carry a lower
 * distance than the source even when BOTH of the source's shared orthogonals are
 * HardBlocks. Selecting such a corner-squeeze diagonal would be rejected by the
 * movement passability guard (both orthogonals walled → no legal single-axis
 * revert) and force a naive Manhattan detour, breaking strict goal-field descent.
 * Requiring a descending orthogonal keeps every returned diagonal a true,
 * wall-free corner turn.
 */
export function stepTowardReachable(
  world: WorldState,
  fromTileX: number,
  fromTileY: number,
  targetTileX: number,
  targetTileY: number,
): number {
  const field = ensureSurfaceGoalField(world, targetTileX, targetTileY);
  const fromIdx = fromTileY * SURFACE_GRID_WIDTH + fromTileX;
  const here = field[fromIdx]!;
  if (here === SURFACE_GOAL_UNREACHED) {
    throw new Error(
      `stepTowardReachable: ant tile (${fromTileX},${fromTileY}) cannot reach target (${targetTileX},${targetTileY}) on the complete goal field — PR 4 connectivity invariant violated`,
    );
  }
  if (here === 0) return SURFACE_STEP_AT_GOAL; // AtGoal
  let bestDx = 0;
  let bestDy = 0;
  let bestDist = here; // require STRICTLY lower than the current tile
  for (let i = 0; i < STEP_DX.length; i++) {
    const sdx = STEP_DX[i]!;
    const sdy = STEP_DY[i]!;
    const nx = fromTileX + sdx;
    const ny = fromTileY + sdy;
    if (nx < 0 || ny < 0 || nx >= SURFACE_GRID_WIDTH || ny >= SURFACE_GRID_HEIGHT) continue;
    const nd = field[ny * SURFACE_GRID_WIDTH + nx]!;
    if (nd === SURFACE_GOAL_UNREACHED) continue; // HardBlock / off-component
    if (nd >= bestDist) continue;
    if (sdx !== 0 && sdy !== 0) {
      // Diagonal: eligible only when at least one shared orthogonal is itself a
      // descending, passable step (so the movement guard's per-axis revert has a
      // legal cardinal and never falls into a Manhattan detour). A wrap-around
      // BFS path can give a corner-squeeze diagonal a lower distance even with
      // both orthogonals walled — reject those here.
      const orthoX = field[fromTileY * SURFACE_GRID_WIDTH + nx]!; // (nx, fromTileY)
      const orthoY = field[ny * SURFACE_GRID_WIDTH + fromTileX]!; // (fromTileX, ny)
      const orthoXok = orthoX !== SURFACE_GOAL_UNREACHED && orthoX < here;
      const orthoYok = orthoY !== SURFACE_GOAL_UNREACHED && orthoY < here;
      if (!orthoXok && !orthoYok) continue;
    }
    bestDist = nd;
    bestDx = sdx;
    bestDy = sdy;
  }
  if (bestDx === 0 && bestDy === 0) {
    // here > 0 but no strictly-closer neighbour: impossible on a complete BFS
    // field (a cardinal neighbour is always at distance here-1).
    throw new Error(
      `stepTowardReachable: no descending step from (${fromTileX},${fromTileY}) dist ${here} toward (${targetTileX},${targetTileY}) — goal field corrupt`,
    );
  }
  return packReachableStep(bestDx, bestDy);
}
