// underground-autotile.test.ts — issue #43 quarter-tile autotiling.
//
// These tests verify the SHAPE produced by drawAutotiledUndergroundTile for
// the canonical neighborhoods. The strategy is to render a tile to a
// pixel-grid synthesized from the recorded fillRect calls, then assert the
// expected silhouette pattern at quadrant-level granularity.
//
// We don't pin down exact pixel coordinates — that would over-fit the
// implementation and would have to be rewritten when texture variants land
// in Checkpoint 5. Instead we check shape invariants: which quadrants got
// opposite-kind paint, where chamfer hypotenuses sit, and that the sacred
// join contract holds across simulated adjacent tiles.

import { describe, it, expect } from 'vitest';
import { drawAutotiledUndergroundTile, drawUndergroundRim } from './underground-autotile.js';
import type { Neighbors3x3, NeighborKind } from './underground-neighbors.js';
import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX, COLOR_QUEEN_OUTLINE } from './sprites.js';
import { COLOR_ROCK_BASE, COLOR_FLOOR_BASE } from './terrain-atlas.js';

void COLOR_QUEEN_OUTLINE; // silence unused — kept as a hook for future tests

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

describe('drawAutotiledUndergroundTile — full quadrants', () => {
  it('isolated open chamber tile (all 4 cardinals = wall) gets 4 chamfer cuts', () => {
    // sameH=0, sameV=0 in every quadrant → chamfer everywhere.
    // Canonical wall pixel count is 4 chamfers × 36 = 144. Per-tile chip
    // variants (Phase E) cut 0..4 of those wall pixels back to open via a
    // hashed 1-pixel chip per chamfer; the exact count for tile (5, 7) is
    // 2 chips → 142 wall pixels. The range below is the variant envelope:
    // anywhere from 140 (4 chips) to 144 (no chips) across the hash space.
    const buf = renderTile(makeNeighbors('open'));
    expect(countPixels(buf, 'wall')).toBeGreaterThanOrEqual(140);
    expect(countPixels(buf, 'wall')).toBeLessThanOrEqual(144);
  });

  it('fully open tile (all 8 neighbors = open) leaves substrate intact — no opposite paint', () => {
    const buf = renderTile(makeNeighbors('open', {
      nw: 'open', n: 'open', ne: 'open',
      w:  'open',             e: 'open',
      sw: 'open', s: 'open', se: 'open',
    }));
    // Substrate is all open; no opposite-kind paint should appear.
    expect(countPixels(buf, 'wall')).toBe(0);
  });

  it('fully solid tile (all 8 neighbors = wall) leaves substrate intact — no opposite paint', () => {
    const buf = renderTile(makeNeighbors('wall'));
    expect(countPixels(buf, 'open')).toBe(0);
  });

  it('axis-aligned vertical corridor (open tile with W=wall, E=wall, N=open, S=open) draws no chamfers or bites', () => {
    // sameH=0, sameV=1 in NW, NE, SW, SE — every quadrant is v-edge.
    // No opposite-kind paint should appear; the substrate alone represents
    // the open floor between two vertical walls.
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall', n: 'open',  ne: 'wall',
      w:  'wall',              e: 'wall',
      sw: 'wall', s: 'open',  se: 'wall',
    }));
    expect(countPixels(buf, 'wall')).toBe(0);
  });

  it('inner-corner only (all cardinals = open, NW diagonal = wall) produces a small wall bite at NW', () => {
    // sameH=1, sameV=1 in every quadrant. Only NW has sameD=0; the others
    // have sameD=1 → full → no paint.
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall',  n: 'open', ne: 'open',
      w:  'open',              e:  'open',
      sw: 'open',  s: 'open', se: 'open',
    }));
    // Inner-corner bite is a 4-row triangle at the NW corner: row 0 fills
    // x=0..3 (4 px), row 1 fills x=0..2 (3 px), row 2: 2 px, row 3: 1 px.
    // Total 4+3+2+1 = 10 pixels.
    expect(countPixels(buf, 'wall')).toBe(10);
    // The wall pixels must be in the NW quadrant (0..7, 0..7), not anywhere else.
    for (let y = 0; y < TILE_SIZE_PX; y++) {
      for (let x = 0; x < TILE_SIZE_PX; x++) {
        if (buf.get(x, y) === 'wall') {
          expect(x).toBeLessThan(8);
          expect(y).toBeLessThan(8);
        }
      }
    }
    // Specifically: pixel (0,0) must be wall (the diagonal poke anchor).
    expect(buf.get(0, 0)).toBe('wall');
  });
});

describe('drawAutotiledUndergroundTile — chamfer anchor pixels', () => {
  it('isolates a single NW chamfer and verifies the anchor pixels (8,0) and (0,8) are NOT painted', () => {
    // Set up a neighborhood where ONLY the NW quadrant is chamfer:
    //   - NW chamfer needs h(W)=wall AND v(N)=wall.
    //   - NE NOT chamfer: h(E) must equal centerKind. Set E=open.
    //   - SW NOT chamfer: h(W)=wall (sameH=0), so we need v(S)=open
    //     (sameV=1) to demote SW to v-edge.
    //   - SE NOT chamfer: h(E)=open, so SE is at most v-edge. Set S=open.
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall', n: 'wall',  ne: 'wall',  // NW chamfer fires; NE: h-edge
      w:  'wall',              e:  'open',
      sw: 'wall', s: 'open',  se: 'open',  // SW: v-edge; SE: full
    }));
    // The anchor pixels live on the BOUNDARY between quadrants. The NW
    // chamfer mask covers (lx + ly < 8) in the NW quadrant. So:
    //   - (8, 0) is in the NE quadrant → NOT painted by NW chamfer.
    //   - (0, 8) is in the SW quadrant → NOT painted by NW chamfer.
    //   - (7, 0) IS painted (last pixel of NW row 0).
    //   - (0, 7) IS painted (last pixel of NW column 0).
    expect(buf.get(7, 0)).toBe('wall');
    expect(buf.get(0, 7)).toBe('wall');
    expect(buf.get(8, 0)).not.toBe('wall'); // anchor — past NW chamfer end
    expect(buf.get(0, 8)).not.toBe('wall');
    // Hypotenuse interior pixel — (4, 3): 4 + 3 = 7 < 8 → wall.
    expect(buf.get(4, 3)).toBe('wall');
    // Just past the hypotenuse: (4, 4): 4 + 4 = 8 → NOT wall.
    expect(buf.get(4, 4)).not.toBe('wall');
  });

  it('axis-aligned corridor (no chamfers fire along shared open-open boundary) — interior tile column is fully open', () => {
    // 1-wide horizontal open corridor between two walls. The "join"
    // between two open tiles in the corridor doesn't have either tile
    // chamfering toward the other (chamfer needs a WALL on the cardinal,
    // and the cardinal between two open tiles is the OTHER OPEN tile).
    // So the shared boundary scanline is pure open substrate on both
    // sides — the autotile silhouette is silent there by design.
    const interior = renderTile(makeNeighbors('open', {
      nw: 'wall', n: 'wall',  ne: 'wall',
      w:  'open',              e:  'open',  // both cardinals open: corridor
      sw: 'wall', s: 'wall',  se: 'wall',
    }));
    // Left and right columns should be pure open substrate (no chamfer or
    // bite). The wall-side rim band (top / bottom, alpha < 1) does NOT
    // contribute to the silhouette buffer (paintBuffer filters alpha < 1).
    for (let y = 0; y < TILE_SIZE_PX; y++) {
      expect(interior.get(0, y)).not.toBe('wall');
      expect(interior.get(TILE_SIZE_PX - 1, y)).not.toBe('wall');
    }
  });
});

describe('drawAutotiledUndergroundTile — stair-step diagonal corridor', () => {
  it('NW-leading open tile in a SW-NE stair-step shows wall chamfers on the NW corner', () => {
    // Stair-step path: ..., (0,0)=O, (1,0)=O, (1,1)=O, (2,1)=O, ...
    // For tile (0,0) in this layout (relative to surrounding wall fill):
    //   N=W, S=W, E=O, W=W, NE=W, NW=W, SE=O, SW=W
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'wall',             e: 'open',
      sw: 'wall', s: 'wall', se: 'open',
    }));
    // NW quadrant: h(W)=W, v(N)=W → chamfer. Wall pixels in NW corner
    // triangle.
    for (let i = 0; i < 8; i++) {
      // Row i, last wall pixel of NW chamfer is at x = 7 - i
      // (chamfer condition: x + y < 8).
      expect(buf.get(0, i)).toBe('wall');           // first column of chamfer
      expect(buf.get(7 - i, i)).toBe('wall');       // hypotenuse pixel
      // Just past the hypotenuse → NOT wall (open substrate)
      // — except in row 0 where the NE chamfer also paints (x=8 wall).
      if (i > 0) {
        expect(buf.get(8 - i, i)).not.toBe('wall'); // open or untouched
      }
    }
    // NE quadrant: h(E)=O, v(N)=W → h-edge → no paint. So the open
    // substrate in the NE quadrant remains visible.
    expect(buf.get(15, 7)).toBe('open');
    // SW quadrant: h(W)=W, v(S)=W → chamfer.
    expect(buf.get(0, 15)).toBe('wall');
    // SE quadrant: h(E)=O, v(S)=W → h-edge → no paint.
    expect(buf.get(15, 15)).toBe('open');
  });

  it('saddle case (cardinals all open, two opposing diagonals = wall) paints two opposite inner-corner bites and no chamfers', () => {
    // sameH=1, sameV=1 in every quadrant. NW and SE diagonals are wall (sameD=0
    // → inner-corner bite). NE and SW are open (sameD=1 → full → no paint).
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall',  n: 'open',  ne: 'open',
      w:  'open',                e: 'open',
      sw: 'open',  s: 'open',  se: 'wall',
    }));
    // 2 inner-corner bites = 20 wall pixels total.
    expect(countPixels(buf, 'wall')).toBe(20);
    // NW corner bite: pixel (0,0) is wall.
    expect(buf.get(0, 0)).toBe('wall');
    // SE corner bite: pixel (15,15) is wall.
    expect(buf.get(15, 15)).toBe('wall');
    // NE corner (would be wall if NE diagonal were wall) — open here.
    expect(buf.get(15, 0)).not.toBe('wall');
    // SW corner — open.
    expect(buf.get(0, 15)).not.toBe('wall');
  });
});

describe('drawAutotiledUndergroundTile — chip variants (Phase E)', () => {
  function makeNeighbors(c: NeighborKind, spec: Partial<Neighbors3x3> = {}): Neighbors3x3 {
    return {
      nw: spec.nw ?? 'wall', n:  spec.n  ?? 'wall', ne: spec.ne ?? 'wall',
      w:  spec.w  ?? 'wall', c,                       e:  spec.e  ?? 'wall',
      sw: spec.sw ?? 'wall', s:  spec.s  ?? 'wall', se: spec.se ?? 'wall',
    };
  }

  it('chip never violates anchor / corner sacred pixels under a hash sweep (single-quadrant chamfer)', () => {
    // Use the single-NW-chamfer setup (only NW fires; other quadrants
    // are h-edge / v-edge / full and paint nothing). Sweep tile
    // coordinates so the chip hash varies across many values, and
    // confirm:
    //   - (8, 0) and (0, 8) anchors remain non-wall (NW chamfer never
    //     reaches them; chips can only retreat further inward, not extend).
    //   - (0, 0) — the OUTER NW corner — is always wall (chip's lx, ly
    //     each ≥ 1, so chip never lands at (0, 0)).
    const singleNW = makeNeighbors('open', {
      nw: 'wall', n: 'wall',  ne: 'wall',
      w:  'wall',              e:  'open',
      sw: 'wall', s: 'open',  se: 'open',
    });
    for (let tx = 0; tx < 32; tx++) {
      for (let ty = 0; ty < 32; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', singleNW);
        const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
        gfx.paintBuffer(buf, 0, 0);

        expect(buf.get(8, 0)).not.toBe('wall'); // top-edge midpoint anchor
        expect(buf.get(0, 8)).not.toBe('wall'); // left-edge midpoint anchor
        expect(buf.get(0, 0)).toBe('wall');     // outer NW corner — always wall
      }
    }
  });

  it('chip output is deterministic per (tileX, tileY)', () => {
    // Render the same tile twice and confirm draw call sequences match.
    // Variant code paths are the densest part of the autotiler — chip
    // determinism is what guarantees byte-identical replays across reloads.
    const a = new MockGfx();
    const b = new MockGfx();
    drawAutotiledUndergroundTile(a, 0, 0, 11, 13, 'open', makeNeighbors('open'));
    drawAutotiledUndergroundTile(b, 0, 0, 11, 13, 'open', makeNeighbors('open'));
    expect(a.calls).toEqual(b.calls);
  });

  it('different tiles produce different chip placements (not a stamped triangle)', () => {
    // Sample 16 distinct tiles and count how many produce a different
    // wall-pixel pattern. Expect MOST tiles to differ — the whole point
    // of variants is that long stair-step diagonals stop reading as a
    // repeated stamp.
    const fingerprints = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const gfx = new MockGfx();
      drawAutotiledUndergroundTile(gfx, 0, 0, i * 7, i * 11, 'open', makeNeighbors('open'));
      const buf = new PixelBuffer(TILE_SIZE_PX, TILE_SIZE_PX);
      gfx.paintBuffer(buf, 0, 0);
      // Build a coarse fingerprint of wall positions inside the chamfer
      // interior (exclude row 0 / col 0 which never vary).
      const cells: string[] = [];
      for (let y = 1; y < TILE_SIZE_PX - 1; y++) {
        for (let x = 1; x < TILE_SIZE_PX - 1; x++) {
          if (buf.get(x, y) === 'wall') cells.push(`${x},${y}`);
        }
      }
      fingerprints.add(cells.join('|'));
    }
    // Want at least 4 distinct patterns from 16 tiles — otherwise the
    // chip variation is too weak to break visual repetition.
    expect(fingerprints.size).toBeGreaterThanOrEqual(4);
  });
});

describe('drawAutotiledUndergroundTile — determinism', () => {
  it('same neighborhood produces the same draw call sequence', () => {
    const a = new MockGfx();
    const b = new MockGfx();
    const n = makeNeighbors('open', { ne: 'open', e: 'open', se: 'open' });
    drawAutotiledUndergroundTile(a, 32, 48, 7, 11, 'open', n);
    drawAutotiledUndergroundTile(b, 32, 48, 7, 11, 'open', n);
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
  it('worst-case open tile (4 chamfers) emits ≤ 80 fillRects', () => {
    const gfx = new MockGfx();
    drawAutotiledUndergroundTile(gfx, 0, 0, 0, 0, 'open', makeNeighbors('open'));
    expect(gfx.calls.filter(c => c.method === 'fillRect').length).toBeLessThanOrEqual(80);
  });

  it('worst-case wall tile (4 chamfers) emits ≤ 80 fillRects', () => {
    const gfx = new MockGfx();
    drawAutotiledUndergroundTile(gfx, 0, 0, 0, 0, 'wall', makeNeighbors('wall', {
      nw: 'open', n: 'open', ne: 'open',
      w:  'open',             e:  'open',
      sw: 'open', s: 'open', se: 'open',
    }));
    expect(gfx.calls.filter(c => c.method === 'fillRect').length).toBeLessThanOrEqual(80);
  });
});
