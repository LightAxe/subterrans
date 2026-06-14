// terrain-bake.test.ts — Vitest tests for the terrain bake subsystem (PLAN-stage2 §B):
//   - render-owned shadow-diff dirty set (§E18 "shadow-diff dirty set, grid+entrance,
//     chambers excluded")
//   - RT lifecycle manager (§E18 "RT lifecycle: origin, lazy enemy, rebake on restart +
//     RESTORE_WEBGL")
// Pure logic — no Phaser (the RT is a stub).

import { describe, it, expect } from 'vitest';
import {
  createUndergroundGrid,
  ugSet,
  UndergroundTileState,
  type UndergroundGrid,
} from '../sim/terrain.js';
import {
  createTerrainShadow,
  diffTerrainShadow,
  tileKey,
  TerrainCache,
  surfaceCacheKey,
  undergroundCacheKey,
  type TerrainShadow,
  type TerrainCacheKey,
} from './terrain-bake.js';

const W = 5;
const H = 5;
const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);
const keys = (grid: UndergroundGrid, coords: Array<[number, number]>): number[] =>
  coords.map(([x, y]) => tileKey(x, y, grid.width)).sort((a, b) => a - b);

function freshGrid(): UndergroundGrid {
  return createUndergroundGrid(W, H); // all Solid (0)
}

// ---------------------------------------------------------------------------
// Shadow-diff dirty tracking
// ---------------------------------------------------------------------------

describe('createTerrainShadow', () => {
  it('snapshots every tile state and the entrance columns', () => {
    const grid = freshGrid();
    ugSet(grid, 2, 2, UndergroundTileState.Open);
    ugSet(grid, 1, 3, UndergroundTileState.Marked);
    const shadow = createTerrainShadow(grid, new Set([2, 4]));
    expect(shadow.width).toBe(W);
    expect(shadow.height).toBe(H);
    expect(shadow.tiles[tileKey(2, 2, W)]).toBe(UndergroundTileState.Open);
    expect(shadow.tiles[tileKey(1, 3, W)]).toBe(UndergroundTileState.Marked);
    expect(shadow.tiles[tileKey(0, 0, W)]).toBe(UndergroundTileState.Solid);
    expect([...shadow.entranceCols]).toEqual([0, 0, 1, 0, 1]);
  });
});

describe('diffTerrainShadow — grid tile changes dirty a clipped 3×3', () => {
  it('returns an empty set when nothing changed', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    expect(diffTerrainShadow(shadow, grid, new Set()).size).toBe(0);
  });

  it('an interior tile change dirties all 9 tiles of its 3×3', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    ugSet(grid, 2, 2, UndergroundTileState.Open);
    const dirty = diffTerrainShadow(shadow, grid, new Set());
    expect(sorted(dirty)).toEqual(
      keys(grid, [
        [1, 1],
        [2, 1],
        [3, 1],
        [1, 2],
        [2, 2],
        [3, 2],
        [1, 3],
        [2, 3],
        [3, 3],
      ]),
    );
  });

  it('a corner tile change dirties only the in-bounds 2×2', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    ugSet(grid, 0, 0, UndergroundTileState.Open);
    const dirty = diffTerrainShadow(shadow, grid, new Set());
    expect(sorted(dirty)).toEqual(
      keys(grid, [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]),
    );
  });

  it('a left-edge tile change clips the off-grid column', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    ugSet(grid, 0, 2, UndergroundTileState.BeingDug);
    const dirty = diffTerrainShadow(shadow, grid, new Set());
    expect(sorted(dirty)).toEqual(
      keys(grid, [
        [0, 1],
        [1, 1],
        [0, 2],
        [1, 2],
        [0, 3],
        [1, 3],
      ]),
    );
  });

  it('refreshes the shadow in place — a second diff with no further change is empty', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    ugSet(grid, 2, 2, UndergroundTileState.Open);
    expect(diffTerrainShadow(shadow, grid, new Set()).size).toBe(9);
    expect(diffTerrainShadow(shadow, grid, new Set()).size).toBe(0); // shadow updated
  });

  it('Marked → BeingDug is a state change (baked tints update with the diff)', () => {
    const grid = freshGrid();
    ugSet(grid, 2, 2, UndergroundTileState.Marked);
    const shadow = createTerrainShadow(grid, new Set());
    ugSet(grid, 2, 2, UndergroundTileState.BeingDug);
    expect(diffTerrainShadow(shadow, grid, new Set()).size).toBe(9);
  });
});

describe('diffTerrainShadow — entrance column changes dirty (x,0)+(x±1,1),(x,1)', () => {
  it('an interior entrance column added dirties exactly the clipped set', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    const dirty = diffTerrainShadow(shadow, grid, new Set([2]));
    expect(sorted(dirty)).toEqual(
      keys(grid, [
        [2, 0],
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    );
  });

  it('a column-0 entrance clips the off-grid x−1 neighbour', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set());
    const dirty = diffTerrainShadow(shadow, grid, new Set([0]));
    expect(sorted(dirty)).toEqual(
      keys(grid, [
        [0, 0],
        [0, 1],
        [1, 1],
      ]),
    );
  });

  it('removing an entrance column is also a change', () => {
    const grid = freshGrid();
    const shadow = createTerrainShadow(grid, new Set([2]));
    const dirty = diffTerrainShadow(shadow, grid, new Set()); // entrance gone
    expect(sorted(dirty)).toEqual(
      keys(grid, [
        [2, 0],
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    );
  });
});

describe('chambers are excluded from the bake invalidation', () => {
  it('the diff has no chamber input — only grid tile-state + entrance changes dirty tiles', () => {
    // A pre-existing excavated region (e.g. a chamber floor already Open in the shadow)
    // produces NO dirty tiles while unchanged: chamber SHAPES are a dynamic overlay, not
    // baked. Only when the underlying grid tiles or entrance columns change does the bake
    // need re-stamping — which the tile scan handles.
    const grid = freshGrid();
    ugSet(grid, 1, 1, UndergroundTileState.Open);
    ugSet(grid, 2, 1, UndergroundTileState.Open);
    ugSet(grid, 1, 2, UndergroundTileState.Open);
    const shadow = createTerrainShadow(grid, new Set());
    expect(diffTerrainShadow(shadow, grid, new Set()).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RT lifecycle manager (§E18 — origin, lazy enemy, rebake on restart + RESTORE_WEBGL)
// ---------------------------------------------------------------------------

interface StubRt {
  id: TerrainCacheKey;
}

/** A TerrainCache over a stub RT, with a spy counter for factory calls. */
function makeCache(): { cache: TerrainCache<StubRt>; created: TerrainCacheKey[] } {
  const created: TerrainCacheKey[] = [];
  const cache = new TerrainCache<StubRt>((key) => {
    created.push(key);
    return { id: key };
  });
  return { cache, created };
}

function shadowOf(width = 4, height = 2): TerrainShadow {
  return {
    width,
    height,
    tiles: new Uint8Array(width * height),
    entranceCols: new Uint8Array(width),
  };
}

describe('TerrainCache lifecycle', () => {
  it('ensure() allocates a NEW entry at origin (0,0), needsRebake, no shadow, factory once', () => {
    const { cache, created } = makeCache();
    const e = cache.ensure(surfaceCacheKey());
    expect(e.originX).toBe(0);
    expect(e.originY).toBe(0);
    expect(e.needsRebake).toBe(true);
    expect(e.shadow).toBeNull();
    expect(e.rt.id).toBe('surface');
    expect(created).toEqual(['surface']);
  });

  it('ensure() is memoized — second call returns the SAME entry, factory not re-run', () => {
    const { cache, created } = makeCache();
    const a = cache.ensure(surfaceCacheKey());
    const b = cache.ensure(surfaceCacheKey());
    expect(b).toBe(a);
    expect(created).toEqual(['surface']); // exactly once
  });

  it('enemy underground is allocated LAZILY (only on first ensure)', () => {
    const { cache, created } = makeCache();
    // "boot": allocate surface + player underground only.
    cache.ensure(surfaceCacheKey());
    cache.ensure(undergroundCacheKey(0)); // player colony 0
    expect(cache.has(undergroundCacheKey(1))).toBe(false); // enemy NOT allocated
    expect(sorted2(cache.allocatedKeys())).toEqual(['surface', 'ug:0']);
    // First X-toggle to the enemy grid allocates it now.
    const enemy = cache.ensure(undergroundCacheKey(1));
    expect(enemy.rt.id).toBe('ug:1');
    expect(created).toEqual(['surface', 'ug:0', 'ug:1']);
    expect(sorted2(cache.allocatedKeys())).toEqual(['surface', 'ug:0', 'ug:1']);
  });

  it('markBaked() clears needsRebake and stores the shadow', () => {
    const { cache } = makeCache();
    cache.ensure(surfaceCacheKey());
    const sh = shadowOf();
    cache.markBaked(surfaceCacheKey(), sh);
    const e = cache.get(surfaceCacheKey())!;
    expect(e.needsRebake).toBe(false);
    expect(e.shadow).toBe(sh);
  });

  it('invalidateAll() flags EVERY allocated cache for rebake and drops shadows (restart / RESTORE_WEBGL)', () => {
    const { cache } = makeCache();
    cache.ensure(surfaceCacheKey());
    cache.ensure(undergroundCacheKey(0));
    cache.markBaked(surfaceCacheKey(), shadowOf());
    cache.markBaked(undergroundCacheKey(0), shadowOf());
    // both baked + clean now
    expect(cache.get(surfaceCacheKey())!.needsRebake).toBe(false);

    cache.invalidateAll(); // restart/load OR webgl context restore

    for (const k of cache.allocatedKeys()) {
      const e = cache.get(k)!;
      expect(e.needsRebake).toBe(true);
      expect(e.shadow).toBeNull();
    }
    // It does NOT allocate the never-opened enemy cache.
    expect(cache.has(undergroundCacheKey(1))).toBe(false);
  });

  it('destroyAll() disposes every RT and clears the cache', () => {
    const { cache } = makeCache();
    cache.ensure(surfaceCacheKey());
    cache.ensure(undergroundCacheKey(0));
    const destroyed: TerrainCacheKey[] = [];
    cache.destroyAll((rt) => destroyed.push(rt.id));
    expect(sorted2(destroyed)).toEqual(['surface', 'ug:0']);
    expect(cache.allocatedKeys()).toEqual([]);
  });
});

const sorted2 = (a: string[]): string[] => [...a].sort();
