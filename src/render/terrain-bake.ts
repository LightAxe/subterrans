// terrain-bake.ts — Stage 2 controls rework (issue #18) §B: the render-owned terrain
// bake subsystem for the baked-terrain RenderTexture path.
//
// PURE core (no Phaser, no DOM) — fully unit-testable. Two pieces:
//   1. Shadow-diff dirty tracking (§B10): a render-owned snapshot of the underground
//      grid + entrance columns; each tick, diff the live grid → the set of tiles whose
//      baked appearance must be re-stamped into the RT (instead of redrawing ~2–3k tiles
//      every frame).
//   2. RT lifecycle manager (§B7/8/11): tracks which view RenderTextures are allocated
//      (surface + player-underground up front, enemy-underground LAZILY on first
//      X-toggle), all at world origin (0,0), with a needsRebake flag flipped on
//      restart/load and on WebGL context restore. Generic over the RT type so the
//      lifecycle is testable with a stub; GameScene injects a real Phaser
//      RenderTexture factory and drives the actual blits from this state.
//
// Render-only: imports sim terrain read accessors only (no mutation, no simVersion bump).

import { ugGet, type UndergroundGrid } from '../sim/terrain.js';

// ===========================================================================
// Shadow-diff dirty tracking (§B10)
// ===========================================================================

/** Dirty-set tile key for (tx, ty) in a grid of the given width: ty * width + tx. */
export function tileKey(tx: number, ty: number, width: number): number {
  return ty * width + tx;
}

/**
 * Render-owned snapshot of the underground terrain's baked-relevant state: every tile's
 * UndergroundTileState plus which columns are entrance ceiling-gaps. One per allocated
 * underground cache (player + enemy). The ACTIVE view's shadow is diffed each frame; an
 * inactive grid's shadow persists from its last active frame, and diffTerrainShadow
 * full-reconciles everything the AI dug while it was inactive on the first frame after it
 * is reactivated (R4-2's "mark inactive stale + reconcile-on-activate" option — NOT a
 * per-tick diff of every allocated cache).
 */
export interface TerrainShadow {
  width: number;
  height: number;
  /** Snapshot of ugGet(grid, tx, ty) for every tile, indexed ty*width + tx. */
  tiles: Uint8Array;
  /** Per-column flag (length = width): 1 if the column is an entrance ceiling-gap. */
  entranceCols: Uint8Array;
}

/** Build a fresh shadow snapshot from the current grid + entrance columns. */
export function createTerrainShadow(
  grid: UndergroundGrid,
  entranceXSet: ReadonlySet<number>,
): TerrainShadow {
  const { width, height } = grid;
  const tiles = new Uint8Array(width * height);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      tiles[ty * width + tx] = ugGet(grid, tx, ty);
    }
  }
  const entranceCols = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    entranceCols[x] = entranceXSet.has(x) ? 1 : 0;
  }
  return { width, height, tiles, entranceCols };
}

/** Add a tile's clipped 3×3 block to the dirty set. */
function addClipped3x3(
  dirty: Set<number>,
  tx: number,
  ty: number,
  width: number,
  height: number,
): void {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      dirty.add(ny * width + nx);
    }
  }
}

/**
 * Add an entrance column's clipped dirty set: (x,0) plus the row-1 neighbours
 * (x−1,1),(x,1),(x+1,1) — the exact set whose autotile reads row-0 column x (R3-5).
 */
function addEntranceDirty(dirty: Set<number>, x: number, width: number, height: number): void {
  if (x >= 0 && x < width) dirty.add(x); // (x, 0)
  if (height > 1) {
    for (const nx of [x - 1, x, x + 1]) {
      if (nx >= 0 && nx < width) dirty.add(width + nx); // (nx, 1)
    }
  }
}

/**
 * Diff the live grid + entrance columns against the shadow, returning the set of tile
 * keys whose baked appearance must be re-stamped, and refreshing the shadow IN PLACE so
 * the next tick diffs against the new state.
 *
 * Dirty rules (PLAN §B10, grilled R1-5/6, R2-7, R3-5):
 *   - a changed grid tile dirties its FULL clipped 3×3 (autotile is neighbour-dependent);
 *   - a changed entrance column x dirties (x,0)+(x−1,1),(x,1),(x+1,1);
 *   - chambers are NOT tracked here (dynamic overlay layer §C — no chamber input); the
 *     grid tiles under a chamber are baked terrain and update via the tile scan.
 *
 * O(width × height) per call — cheap at 128×64. Called for the ACTIVE view's cache each
 * frame; an inactive (toggled-away) grid the AI keeps excavating is reconciled in full on
 * its first frame back, since the diff compares the live grid to the shadow last refreshed
 * while it was active (R4-2 reconcile-on-activate).
 */
export function diffTerrainShadow(
  shadow: TerrainShadow,
  grid: UndergroundGrid,
  entranceXSet: ReadonlySet<number>,
): Set<number> {
  const dirty = new Set<number>();
  const { width, height } = shadow;

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const idx = ty * width + tx;
      const cur = ugGet(grid, tx, ty);
      if (shadow.tiles[idx] !== cur) {
        addClipped3x3(dirty, tx, ty, width, height);
        shadow.tiles[idx] = cur;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    const cur = entranceXSet.has(x) ? 1 : 0;
    if (shadow.entranceCols[x] !== cur) {
      addEntranceDirty(dirty, x, width, height);
      shadow.entranceCols[x] = cur;
    }
  }

  return dirty;
}

// ===========================================================================
// RT lifecycle manager (§B7/8/11)
// ===========================================================================

/** Cache key identifying a view's RenderTexture: 'surface' or 'ug:<colonyId>'. */
export type TerrainCacheKey = string;

export function surfaceCacheKey(): TerrainCacheKey {
  return 'surface';
}
export function undergroundCacheKey(colonyId: number): TerrainCacheKey {
  return `ug:${colonyId}`;
}

/**
 * One cached view RenderTexture + its bake bookkeeping. RTs are always created at world
 * origin (0,0) so a world-px draw lands at the matching texel; the main camera then
 * scrolls/zooms the whole RT.
 */
export interface TerrainCacheEntry<RT> {
  key: TerrainCacheKey;
  rt: RT;
  readonly originX: 0;
  readonly originY: 0;
  /** True until the RT has been (re)stamped with the current terrain (full bake). */
  needsRebake: boolean;
  /** Render-owned shadow for incremental dirty-diff; null until the first full bake. */
  shadow: TerrainShadow | null;
}

/**
 * Pure RT lifecycle manager. Generic over the RT type so the lifecycle is unit-testable
 * with a stub; GameScene injects a real Phaser RenderTexture factory.
 *   - surface + player-underground are allocated up front (ensure at boot);
 *   - enemy-underground is allocated LAZILY on first ensure (first X-toggle) (R1-13);
 *   - every NEW entry starts at origin (0,0), needsRebake=true, shadow=null;
 *   - invalidateAll() (restart/load + RESTORE_WEBGL) flags every ALLOCATED cache for a
 *     full rebake and drops its shadow (R2-11/R4-6) — it never allocates the lazy enemy
 *     cache that was never opened.
 */
export class TerrainCache<RT> {
  private readonly entries = new Map<TerrainCacheKey, TerrainCacheEntry<RT>>();
  constructor(private readonly createRt: (key: TerrainCacheKey) => RT) {}

  has(key: TerrainCacheKey): boolean {
    return this.entries.has(key);
  }

  get(key: TerrainCacheKey): TerrainCacheEntry<RT> | undefined {
    return this.entries.get(key);
  }

  /** All currently-allocated keys (excludes a lazy enemy cache never opened). */
  allocatedKeys(): TerrainCacheKey[] {
    return [...this.entries.keys()];
  }

  /** #236 PR3 — the live key iterator (no array allocation), for the per-frame
   *  visibility sweep. allocatedKeys() stays for callers that need a snapshot. */
  keys(): IterableIterator<TerrainCacheKey> {
    return this.entries.keys();
  }

  /**
   * Fetch (or lazily allocate) the entry for a key. A new entry is created at origin
   * (0,0) with needsRebake=true and no shadow; the RT factory runs exactly once per key.
   */
  ensure(key: TerrainCacheKey): TerrainCacheEntry<RT> {
    let e = this.entries.get(key);
    if (e === undefined) {
      e = { key, rt: this.createRt(key), originX: 0, originY: 0, needsRebake: true, shadow: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /**
   * Mark an entry baked: clear needsRebake and store the fresh shadow. Surface terrain is
   * static (never diffed) so it bakes with a null shadow; underground passes its shadow.
   */
  markBaked(key: TerrainCacheKey, shadow: TerrainShadow | null = null): void {
    const e = this.entries.get(key);
    if (e !== undefined) {
      e.needsRebake = false;
      e.shadow = shadow;
    }
  }

  /**
   * Restart/load OR WebGL-context restore: every ALLOCATED cache must fully rebake.
   * Drops shadows so the next bake re-snapshots from scratch.
   */
  invalidateAll(): void {
    for (const e of this.entries.values()) {
      e.needsRebake = true;
      e.shadow = null;
    }
  }

  /** Destroy every RT (scene shutdown), calling the provided disposer, then clear. */
  destroyAll(destroy: (rt: RT) => void): void {
    for (const e of this.entries.values()) destroy(e.rt);
    this.entries.clear();
  }
}
