// underground-autotile.test.ts — underground tile rendering tests.
//
// Issue #48 stripped the quarter-tile autotile masks (chamfer +
// inner-corner bite) from drawAutotiledUndergroundTile because they read
// as visible right-triangle teeth at every corner. The current contract
// is "substrate-only": for any neighborhood, the tile renders only its
// centerKind's dithered substrate. The rim-shading pass — covered by its
// own describe block below — handles the wall-side carved-out feel as a
// separate translucent overlay.
//
// Tests render a tile via MockGfx into a pixel buffer (filtered to opaque
// alpha=1 draws so translucent rim bands don't pollute the silhouette
// assertions) and check that no opposite-kind paint appears regardless
// of neighborhood configuration.

import { describe, it, expect } from 'vitest';
import { drawAutotiledUndergroundTile, drawUndergroundRim } from './underground-autotile.js';
import type { Neighbors3x3, NeighborKind } from './underground-neighbors.js';
import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX } from './sprites.js';
import { COLOR_ROCK_BASE, COLOR_FLOOR_BASE } from './terrain-atlas.js';

// ---------------------------------------------------------------------------
// Pixel-buffer recorder. Re-plays MockGfx fillRect calls with their LAST
// fillStyle color into a (TILE_SIZE_PX × TILE_SIZE_PX) buffer of color codes.
// 'wall' = COLOR_ROCK_BASE (or any darker rock variant); 'open' =
// COLOR_FLOOR_BASE. We classify each fillStyle to one of those two for the
// pixel buffer.
// ---------------------------------------------------------------------------

interface GfxCall { method: string; args: unknown[]; }

class PixelBuffer {
  // [y][x] → 'wall' | 'open' | undefined. Undefined = nothing painted yet.
  private grid: (NeighborKind | undefined)[][] = [];
  constructor(public readonly w: number, public readonly h: number) {
    for (let y = 0; y < h; y++) {
      const row: (NeighborKind | undefined)[] = new Array(w).fill(undefined);
      this.grid.push(row);
    }
  }
  set(x: number, y: number, kind: NeighborKind): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.grid[y]![x] = kind;
  }
  get(x: number, y: number): NeighborKind | undefined { return this.grid[y]?.[x]; }
}

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];
  private currentColor: number = 0;
  private currentAlpha: number = 1;

  clear(): GfxLike { this.calls.push({ method: 'clear', args: [] }); return this; }
  fillStyle(color: number, alpha?: number): GfxLike {
    this.currentColor = color;
    this.currentAlpha = alpha ?? 1;
    this.calls.push({ method: 'fillStyle', args: [color, alpha] });
    return this;
  }
  lineStyle(): GfxLike { return this; }
  fillRect(x: number, y: number, w: number, h: number): GfxLike {
    this.calls.push({ method: 'fillRect', args: [x, y, w, h, this.currentColor, this.currentAlpha] });
    return this;
  }
  fillCircle(): GfxLike { return this; }
  strokeCircle(): GfxLike { return this; }
  fillTriangle(): GfxLike { return this; }

  /**
   * Replay calls into a single-tile pixel buffer. Pixels last-write-wins
   * (matching the actual draw order). Only fully-opaque (alpha === 1)
   * substrate / mask draws contribute to the silhouette; the rim's
   * translucent bands are intentionally filtered out so the buffer
   * represents the autotile shape, not the final visible blend. Unknown
   * colors are ignored too.
   */
  paintBuffer(buf: PixelBuffer, screenX: number, screenY: number): void {
    for (const call of this.calls) {
      if (call.method !== 'fillRect') continue;
      const [x, y, w, h, color, alpha] = call.args as [number, number, number, number, number, number];
      if (alpha !== 1) continue; // silhouette = opaque draws only
      const kind = classifyColor(color);
      if (kind === undefined) continue;
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          buf.set(x - screenX + dx, y - screenY + dy, kind);
        }
      }
    }
  }
}

/**
 * Classify a draw color into the autotile silhouette (wall vs open).
 *
 * Rock-tone colors → wall, floor-tone → open. We use color exact matches
 * against the small palette, plus a fallback range for the dithered dark
 * variants. Anything else → undefined (e.g. tints, sprites).
 */
function classifyColor(color: number): NeighborKind | undefined {
  if (color === COLOR_ROCK_BASE) return 'wall';
  if (color === COLOR_FLOOR_BASE) return 'open';
  // Treat the dithered darker variants on the same kind too — for shape
  // tests they all read as the same silhouette.
  if (color === 0x1d130a || color === 0x3f2c1c) return 'wall';
  if (color === 0x080403) return 'open';
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNeighbors(
  c: NeighborKind,
  spec: Partial<Neighbors3x3> = {},
): Neighbors3x3 {
  // Default unspecified neighbors to 'wall' — this models a tile carved out
  // of an all-Solid grid, the most common test setup.
  return {
    nw: spec.nw ?? 'wall',
    n:  spec.n  ?? 'wall',
    ne: spec.ne ?? 'wall',
    w:  spec.w  ?? 'wall',
    c,
    e:  spec.e  ?? 'wall',
    sw: spec.sw ?? 'wall',
    s:  spec.s  ?? 'wall',
    se: spec.se ?? 'wall',
  };
}

function renderTile(neighbors: Neighbors3x3): PixelBuffer {
  const gfx = new MockGfx();
  drawAutotiledUndergroundTile(gfx, 0, 0, 5, 7, neighbors.c, neighbors);
  const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
  gfx.paintBuffer(buf, 0, 0);
  return buf;
}

function countPixels(buf: PixelBuffer, kind: NeighborKind): number {
  let n = 0;
  for (let y = 0; y < buf.h; y++) {
    for (let x = 0; x < buf.w; x++) {
      if (buf.get(x, y) === kind) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tests — canonical quarter shapes
// ---------------------------------------------------------------------------

describe('drawAutotiledUndergroundTile — organic boundary noise (issue #48)', () => {
  // After three failed iterations on issue #48, the autotile lands on
  // organic noise-displaced boundaries. For an open tile that has at
  // least one wall cardinal neighbor, the wall encroaches into the open
  // tile by 0..ORGANIC_MAX_DEPTH (3) pixels per column / row along that
  // edge — hashed depth, deterministic per (tileX, tileY, edge, position).
  // Open tiles with no wall neighbors stay pure substrate. Wall tiles
  // also stay pure substrate (the encroachment only paints into open).
  const ORGANIC_MAX_DEPTH = 3;

  it('an open tile with NO wall neighbors stays fully open substrate', () => {
    const buf = renderTile(makeNeighbors('open', {
      nw: 'open', n: 'open', ne: 'open',
      w:  'open',             e: 'open',
      sw: 'open', s: 'open', se: 'open',
    }));
    expect(countPixels(buf, 'wall')).toBe(0);
  });

  it('encroachment depth never exceeds ORGANIC_MAX_DEPTH from any edge', () => {
    // Sweep many tiles at "all 4 cardinals = wall" and verify wall
    // pixels never appear in the interior region (depth ≥ ORGANIC_MAX_DEPTH
    // from every edge). N edge at max depth paints rows [0..2], so the
    // first row that must be pure open is y=ORGANIC_MAX_DEPTH=3. Symmetric
    // on the other three edges.
    for (let tx = 0; tx < 16; tx++) {
      for (let ty = 0; ty < 16; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', makeNeighbors('open'));
        const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
        gfx.paintBuffer(buf, 0, 0);
        // Interior region [3..12] × [3..12] (inclusive) must be pure open.
        for (let y = ORGANIC_MAX_DEPTH; y < TILE_SIZE_PX - ORGANIC_MAX_DEPTH; y++) {
          for (let x = ORGANIC_MAX_DEPTH; x < TILE_SIZE_PX - ORGANIC_MAX_DEPTH; x++) {
            expect(buf.get(x, y)).toBe('open');
          }
        }
      }
    }
  });

  it('an open tile with N=wall ONLY gets encroachment along the top edge', () => {
    // All other edges must remain pure open substrate. N edge at max
    // depth paints rows [0..2]; rows [3..15] must be pure open.
    const buf = renderTile(makeNeighbors('open', {
      nw: 'open', n: 'wall',  ne: 'open',
      w:  'open',              e: 'open',
      sw: 'open', s: 'open',  se: 'open',
    }));
    for (let y = ORGANIC_MAX_DEPTH; y < TILE_SIZE_PX; y++) {
      for (let x = 0; x < TILE_SIZE_PX; x++) {
        expect(buf.get(x, y)).toBe('open');
      }
    }
  });

  it('encroachment density on an active edge is high enough to break the grid line', () => {
    // Sample many tiles with N=wall and count how many top-row pixels
    // got encroachment. Aggressive distribution targets ~70% non-zero.
    // Allowing >= 50% gives room for hash variance without brittleness.
    const spec: Partial<Neighbors3x3> = {
      nw: 'open', n: 'wall',  ne: 'open',
      w:  'open',              e: 'open',
      sw: 'open', s: 'open',  se: 'open',
    };
    let encroached = 0;
    let total = 0;
    for (let tx = 0; tx < 16; tx++) {
      for (let ty = 0; ty < 16; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', makeNeighbors('open', spec));
        const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
        gfx.paintBuffer(buf, 0, 0);
        for (let x = 0; x < TILE_SIZE_PX; x++) {
          total++;
          if (buf.get(x, 0) === 'wall') encroached++;
        }
      }
    }
    expect(encroached / total).toBeGreaterThanOrEqual(0.5);
  });

  it('different tiles produce different encroachment patterns', () => {
    // Hash-driven variation — 16 distinct tiles should produce mostly
    // distinct boundary patterns, proving the noise is per-tile and not
    // a stamped shape.
    const spec: Partial<Neighbors3x3> = {
      nw: 'open', n: 'wall', ne: 'open',
      w:  'open',             e: 'open',
      sw: 'open', s: 'open', se: 'open',
    };
    const fingerprints = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const gfx = new MockGfx();
      drawAutotiledUndergroundTile(gfx, 0, 0, i * 13, i * 7 + 3, 'open', makeNeighbors('open', spec));
      const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
      gfx.paintBuffer(buf, 0, 0);
      const cells: string[] = [];
      for (let y = 0; y < ORGANIC_MAX_DEPTH; y++) {
        for (let x = 0; x < TILE_SIZE_PX; x++) {
          if (buf.get(x, y) === 'wall') cells.push(`${x},${y}`);
        }
      }
      fingerprints.add(cells.join('|'));
    }
    expect(fingerprints.size).toBeGreaterThanOrEqual(8);
  });

  it('a wall tile produces ONLY wall substrate — no floor-color paint anywhere', () => {
    // Symmetric to the open case. With chamfers removed, a wall tile
    // surrounded by open neighbors no longer has its corners cut to
    // floor color (the dark-triangle artifact in the issue #48 screenshot).
    const cases: Array<Partial<Neighbors3x3>> = [
      // Isolated wall pillar — used to fire 4 floor-color chamfers.
      { nw: 'open', n: 'open', ne: 'open',
        w:  'open',             e:  'open',
        sw: 'open', s: 'open', se: 'open' },
      // Wall corner (open in NW, walls elsewhere) — used to fire 1 chamfer.
      { nw: 'open', n: 'open',  ne: 'wall',
        w:  'open',              e: 'wall',
        sw: 'wall', s: 'wall',  se: 'wall' },
      // Wall saddle (cardinals all wall, two opposite diagonals = open) —
      // used to fire 2 floor-color inner-corner bites in the previous
      // implementation. Now nothing.
      { nw: 'open',  n: 'wall',  ne: 'wall',
        w:  'wall',                e: 'wall',
        sw: 'wall',  s: 'wall',  se: 'open' },
    ];
    for (const spec of cases) {
      const buf = renderTile(makeNeighbors('wall', spec));
      expect(countPixels(buf, 'open')).toBe(0);
    }
  });

  it('axis-aligned vertical corridor: top/bottom edges open, left/right edges have encroachment', () => {
    // 1-wide vertical corridor: walls L+R, corridor U+D. Top and bottom
    // rows are open (no wall N/S). Left col 0 and right col 15 are
    // accessible to encroachment from W/E walls.
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall', n: 'open',  ne: 'wall',
      w:  'wall',              e: 'wall',
      sw: 'wall', s: 'open',  se: 'wall',
    }));
    // Top row 0 and bottom row 15: must be open along the interior
    // width [3..12] (inclusive). The leftmost / rightmost ORGANIC_MAX_DEPTH
    // pixels can be reached by W/E encroachment (since W/E paint at
    // every y in [0..15]).
    for (let x = ORGANIC_MAX_DEPTH; x < TILE_SIZE_PX - ORGANIC_MAX_DEPTH; x++) {
      expect(buf.get(x, 0)).toBe('open');
      expect(buf.get(x, TILE_SIZE_PX - 1)).toBe('open');
    }
  });

  it('output is deterministic per (tileX, tileY, neighbors)', () => {
    const a = new MockGfx();
    const b = new MockGfx();
    drawAutotiledUndergroundTile(a, 32, 48, 7, 11, 'open', makeNeighbors('open'));
    drawAutotiledUndergroundTile(b, 32, 48, 7, 11, 'open', makeNeighbors('open'));
    expect(a.calls).toEqual(b.calls);
  });
});

describe('drawUndergroundRim', () => {
  function makeNeighbors(c: NeighborKind, spec: Partial<Neighbors3x3> = {}): Neighbors3x3 {
    return {
      nw: spec.nw ?? 'wall', n:  spec.n  ?? 'wall', ne: spec.ne ?? 'wall',
      w:  spec.w  ?? 'wall', c,                       e:  spec.e  ?? 'wall',
      sw: spec.sw ?? 'wall', s:  spec.s  ?? 'wall', se: spec.se ?? 'wall',
    };
  }

  function gfxCalls(): MockGfx { return new MockGfx(); }

  it('does nothing on a wall tile (rim only fires on open tiles)', () => {
    const gfx = gfxCalls();
    drawUndergroundRim(gfx, 0, 0, 0, 0, 'wall', makeNeighbors('wall'));
    expect(gfx.calls.filter(c => c.method === 'fillRect')).toHaveLength(0);
  });

  it('does nothing on an open tile with no wall neighbors', () => {
    const gfx = gfxCalls();
    drawUndergroundRim(gfx, 0, 0, 0, 0, 'open', makeNeighbors('open', {
      nw: 'open', n: 'open', ne: 'open',
      w:  'open',             e: 'open',
      sw: 'open', s: 'open', se: 'open',
    }));
    expect(gfx.calls.filter(c => c.method === 'fillRect')).toHaveLength(0);
  });

  it('emits 2 band fillRects + 1 chip per cardinal wall neighbor', () => {
    const gfx = gfxCalls();
    // Open tile with only N=wall (rest open).
    drawUndergroundRim(gfx, 0, 0, 5, 7, 'open', makeNeighbors('open', {
      n: 'wall',
      ne: 'open', e: 'open', se: 'open', s: 'open', sw: 'open', w: 'open', nw: 'open',
    }));
    // 1 heavy band + 1 light band + 1 chip = 3 fillRects.
    expect(gfx.calls.filter(c => c.method === 'fillRect')).toHaveLength(3);
  });

  it('all four cardinal walls → 8 band fillRects + 4 chips = 12', () => {
    const gfx = gfxCalls();
    drawUndergroundRim(gfx, 0, 0, 5, 7, 'open', makeNeighbors('open'));
    expect(gfx.calls.filter(c => c.method === 'fillRect')).toHaveLength(12);
  });
});

describe('drawAutotiledUndergroundTile — draw-op budget', () => {
  // Open tile cost: substrate (~10) + organic boundary noise per active
  // wall edge (up to 16 ops × 4 edges = 64) ≈ 75 worst case for an
  // isolated open chamber. Pin ≤ 100 to leave headroom for the existing
  // substrate variance + future texture additions, but still trip on a
  // regression that re-introduces 36-pixel chamfers (4 × 36 = 144+).
  //
  // Wall tile cost: just the substrate (~26 max). No encroachment fires.
  it('open tile emits ≤ 100 fillRects (substrate + organic encroachment)', () => {
    let max = 0;
    for (let tx = 0; tx < 32; tx++) {
      for (let ty = 0; ty < 32; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', makeNeighbors('open'));
        const ops = gfx.calls.filter(c => c.method === 'fillRect').length;
        if (ops > max) max = ops;
      }
    }
    expect(max).toBeLessThanOrEqual(100);
  });

  it('wall tile emits ≤ 40 fillRects (substrate-only — encroachment skipped)', () => {
    let max = 0;
    for (let tx = 0; tx < 32; tx++) {
      for (let ty = 0; ty < 32; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'wall', makeNeighbors('wall', {
          nw: 'open', n: 'open', ne: 'open',
          w:  'open',             e:  'open',
          sw: 'open', s: 'open', se: 'open',
        }));
        const ops = gfx.calls.filter(c => c.method === 'fillRect').length;
        if (ops > max) max = ops;
      }
    }
    expect(max).toBeLessThanOrEqual(40);
  });
});
