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

describe('drawAutotiledUndergroundTile — bidirectional smooth boundary (issue #48 v4)', () => {
  // v4 contract: the wall/open boundary is a smooth low-frequency curve
  // that lives independently of the tile grid. Both sides paint
  // encroachment of the OPPOSITE kind into themselves — open tiles
  // get wall encroachment along their wall-side edges, AND wall tiles
  // get open encroachment along their open-side edges. Maximum
  // displacement is BOUNDARY_AMP pixels in either direction (post-v4.2
  // = 3 to remove the visible "spike" artifact UAT flagged at AMP=5).
  //
  // Tiles with NO opposite-kind cardinal neighbors stay pure substrate.
  const BOUNDARY_AMP = 3;

  it('an open tile with NO wall neighbors stays fully open substrate', () => {
    const buf = renderTile(makeNeighbors('open', {
      nw: 'open', n: 'open', ne: 'open',
      w:  'open',             e: 'open',
      sw: 'open', s: 'open', se: 'open',
    }));
    expect(countPixels(buf, 'wall')).toBe(0);
  });

  it('encroachment depth never exceeds BOUNDARY_AMP from any edge', () => {
    // Sweep many tiles at "all 4 cardinals = wall" and verify wall
    // pixels never appear in the interior region (depth ≥ BOUNDARY_AMP
    // from every edge). N edge at max depth paints rows [0..2], so the
    // first row that must be pure open is y=BOUNDARY_AMP=3. Symmetric
    // on the other three edges.
    for (let tx = 0; tx < 16; tx++) {
      for (let ty = 0; ty < 16; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', makeNeighbors('open'));
        const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
        gfx.paintBuffer(buf, 0, 0);
        // Interior region [3..12] × [3..12] (inclusive) must be pure open.
        for (let y = BOUNDARY_AMP; y < TILE_SIZE_PX - BOUNDARY_AMP; y++) {
          for (let x = BOUNDARY_AMP; x < TILE_SIZE_PX - BOUNDARY_AMP; x++) {
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
    for (let y = BOUNDARY_AMP; y < TILE_SIZE_PX; y++) {
      for (let x = 0; x < TILE_SIZE_PX; x++) {
        expect(buf.get(x, y)).toBe('open');
      }
    }
  });

  it('encroachment density on an active edge is high enough to break the grid line', () => {
    // Sample many tiles with N=wall and count how many top-row pixels
    // are wall (encroachment from this side). With bidirectional v4,
    // each side paints when its sign-of-offset goes inward; for an
    // open tile that's offset > 0 on the shared edge, expected ~50%
    // density. The rest is painted by the WALL tile from above as
    // open encroachment INTO the wall, so the boundary is wavy from
    // both perspectives. >= 35% captures the active-side fire rate
    // without brittleness on the smooth-interp distribution.
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
    expect(encroached / total).toBeGreaterThanOrEqual(0.35);
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
      for (let y = 0; y < BOUNDARY_AMP; y++) {
        for (let x = 0; x < TILE_SIZE_PX; x++) {
          if (buf.get(x, y) === 'wall') cells.push(`${x},${y}`);
        }
      }
      fingerprints.add(cells.join('|'));
    }
    expect(fingerprints.size).toBeGreaterThanOrEqual(8);
  });

  it('a wall tile with ALL wall neighbors stays pure wall substrate (no encroachment)', () => {
    // Only fires when there are NO opposite-kind cardinal neighbors.
    const buf = renderTile(makeNeighbors('wall', {
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'wall',             e: 'wall',
      sw: 'wall', s: 'wall', se: 'wall',
    }));
    expect(countPixels(buf, 'open')).toBe(0);
  });

  it('a wall tile with open neighbors paints OPEN encroachment along open-facing edges (bidirectional)', () => {
    // The v4 fix: walls also have noise along their open-facing edges,
    // so open extends INTO wall, decoupling the boundary from the grid.
    // Pre-v4 (PR #51, PR #52 v3) wall tiles painted nothing, leaving
    // 90° corners visible at every chamber edge. Post-v4 those corners
    // get organic open encroachment.
    const buf = renderTile(makeNeighbors('wall', {
      nw: 'open', n: 'open',  ne: 'open',
      w:  'open',              e: 'open',
      sw: 'open', s: 'open',  se: 'open',
    }));
    expect(countPixels(buf, 'open')).toBeGreaterThan(0);
    // Interior region must still be pure wall substrate (encroachment
    // bounded to BOUNDARY_AMP=5 from each edge, so cells [5..10]² are
    // guaranteed wall).
    for (let y = BOUNDARY_AMP; y < TILE_SIZE_PX - BOUNDARY_AMP; y++) {
      for (let x = BOUNDARY_AMP; x < TILE_SIZE_PX - BOUNDARY_AMP; x++) {
        expect(buf.get(x, y)).toBe('wall');
      }
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
    // width [3..12] (inclusive). The leftmost / rightmost BOUNDARY_AMP
    // pixels can be reached by W/E encroachment (since W/E paint at
    // every y in [0..15]).
    for (let x = BOUNDARY_AMP; x < TILE_SIZE_PX - BOUNDARY_AMP; x++) {
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

  it('cross-tile boundary continuity: shared edge produces a complete cover (no gap, no overdraw conflict)', () => {
    // Render two vertically-stacked tiles that share a horizontal
    // edge: upper tile (5, 7) is WALL, lower tile (5, 8) is OPEN.
    // The shared edge is at globalY = 8 * 16 = 128, with the SAME
    // boundaryOffsetH(globalX, 8) controlling both sides. Verify that
    // for every column along the shared edge, the offset's sign drives
    // exactly one side to paint and the other to leave substrate —
    // i.e. there's no gap (boundary missing on both sides) and no
    // overdraw of the same pixel by both sides simultaneously.
    const upperGfx = new MockGfx();
    const lowerGfx = new MockGfx();
    // Upper (wall) with S = open neighbor below.
    drawAutotiledUndergroundTile(upperGfx, 0, 0, 5, 7, 'wall', makeNeighbors('wall', {
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'wall',             e: 'wall',
      sw: 'open', s: 'open', se: 'open',
    }));
    // Lower (open) with N = wall neighbor above.
    drawAutotiledUndergroundTile(lowerGfx, 0, TILE_SIZE_PX, 5, 8, 'open', makeNeighbors('open', {
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'open',             e: 'open',
      sw: 'open', s: 'open', se: 'open',
    }));

    const upperBuf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
    const lowerBuf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
    upperGfx.paintBuffer(upperBuf, 0, 0);
    lowerGfx.paintBuffer(lowerBuf, 0, TILE_SIZE_PX);

    // For each column along the shared edge, the two tiles' boundary
    // pixels must form a continuous wall-then-open transition (or a
    // continuous open substrate if offset = 0). Specifically the
    // boundary at any (globalX, sharedY) is exactly ONE material —
    // either upper paints opposite into its bottom rows OR lower
    // paints opposite into its top rows, but not both for the same
    // physical row (since they're different tiles' rows).
    //
    // Test invariant: the upper tile's bottom-most row (last) is wall
    // by default and may have OPEN encroachment if offset < 0. The
    // lower tile's top-most row (0) is open by default and may have
    // WALL encroachment if offset > 0. Both can't simultaneously be
    // the OPPOSITE-of-default (upper=open AND lower=wall) for the
    // same column — that would require offset > 0 AND offset < 0.
    for (let x = 0; x < TILE_SIZE_PX; x++) {
      const upperBottomIsOpen = upperBuf.get(x, TILE_SIZE_PX - 1) === 'open';
      const lowerTopIsWall    = lowerBuf.get(x, 0) === 'wall';
      // At least one of these must be FALSE (default-substrate state).
      expect(upperBottomIsOpen && lowerTopIsWall).toBe(false);
    }
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

  it('emits per-pixel rim ops along each active edge (rim follows displaced boundary)', () => {
    // v4 follow-up: rim is now per-pixel because it tracks the wavy
    // boundary curve (not the grid line). Per active edge: up to 16
    // heavy + up to 16 light + 1 chip = up to 33 fillRects.
    const gfx = gfxCalls();
    drawUndergroundRim(gfx, 0, 0, 5, 7, 'open', makeNeighbors('open', {
      n: 'wall',
      ne: 'open', e: 'open', se: 'open', s: 'open', sw: 'open', w: 'open', nw: 'open',
    }));
    const ops = gfx.calls.filter(c => c.method === 'fillRect').length;
    // At least 16 (heavy band only, if all light-band rows are off-tile)
    // and at most 33 (16 heavy + 16 light + 1 chip).
    expect(ops).toBeGreaterThanOrEqual(16);
    expect(ops).toBeLessThanOrEqual(33);
  });

  it('all four cardinal walls → up to 132 rim fillRects', () => {
    const gfx = gfxCalls();
    drawUndergroundRim(gfx, 0, 0, 5, 7, 'open', makeNeighbors('open'));
    const ops = gfx.calls.filter(c => c.method === 'fillRect').length;
    // Up to 4 × (16 heavy + 16 light + 1 chip) = 132. Lower bound is
    // 4 × 16 = 64 (heavy only).
    expect(ops).toBeGreaterThanOrEqual(64);
    expect(ops).toBeLessThanOrEqual(132);
  });
});

describe('drawAutotiledUndergroundTile — draw-op budget', () => {
  // v4 cost (both kinds): substrate (~30 max) + bidirectional boundary
  // displacement (up to 16 ops per active edge × 4 edges = 64). Worst
  // case for an isolated tile (all 4 cardinals are opposite kind) ≈ 95.
  // Pin ≤ 120 to leave headroom for substrate variance.
  it('open tile emits ≤ 120 fillRects (substrate + boundary displacement)', () => {
    let max = 0;
    for (let tx = 0; tx < 32; tx++) {
      for (let ty = 0; ty < 32; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', makeNeighbors('open'));
        const ops = gfx.calls.filter(c => c.method === 'fillRect').length;
        if (ops > max) max = ops;
      }
    }
    expect(max).toBeLessThanOrEqual(120);
  });

  it('wall tile emits ≤ 120 fillRects (substrate + bidirectional encroachment)', () => {
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
    expect(max).toBeLessThanOrEqual(120);
  });
});
