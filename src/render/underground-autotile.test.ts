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

describe('drawAutotiledUndergroundTile — substrate-only contract (issue #48)', () => {
  // After issue #48, the autotile produces ONLY the dithered substrate
  // for the center tile's kind. No chamfer, no inner-corner bite, no
  // chip variants — those produced visible right-triangle "teeth" at
  // every corner where the autotile fired. Corners now read as clean
  // tile-aligned squares; rim shading (a separate translucent pass)
  // gives wall-side edges their carved-out feel.

  it('an open tile produces ONLY open substrate — no wall-color paint anywhere', () => {
    // For a center=open tile with any neighborhood, the silhouette is
    // entirely open substrate. The only wall pixels in the buffer would
    // come from the (deleted) chamfer/bite painters.
    const cases: Array<Partial<Neighbors3x3>> = [
      // Isolated open pocket — used to fire 4 chamfers.
      {},
      // L-corner — used to fire 1 chamfer.
      { n: 'wall', w: 'wall', s: 'open', e: 'open',
        nw: 'wall', ne: 'wall', sw: 'wall', se: 'open' },
      // Stair-step lead tile — used to fire 2 chamfers + 0 bites.
      { nw: 'wall', n: 'wall', ne: 'wall',
        w:  'wall',             e: 'open',
        sw: 'wall', s: 'wall', se: 'open' },
      // Saddle / inner-corner-only — used to fire 2 inner-corner bites.
      { nw: 'wall',  n: 'open',  ne: 'open',
        w:  'open',                e: 'open',
        sw: 'open',  s: 'open',  se: 'wall' },
    ];
    for (const spec of cases) {
      const buf = renderTile(makeNeighbors('open', spec));
      expect(countPixels(buf, 'wall')).toBe(0);
    }
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

  it('axis-aligned vertical corridor renders fully open — every silhouette pixel is open substrate', () => {
    // Tile in a 1-wide vertical corridor with walls L+R and corridor U+D.
    // Stronger than the parameterized "no wall paint" check above: every
    // pixel must positively be `open` (substrate filled the tile), proving
    // the substrate path actually ran and didn't produce any gaps.
    const buf = renderTile(makeNeighbors('open', {
      nw: 'wall', n: 'open',  ne: 'wall',
      w:  'wall',              e: 'wall',
      sw: 'wall', s: 'open',  se: 'wall',
    }));
    for (let y = 0; y < TILE_SIZE_PX; y++) {
      for (let x = 0; x < TILE_SIZE_PX; x++) {
        expect(buf.get(x, y)).toBe('open');
      }
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
  // Issue #48 dropped the per-quadrant masks; tile cost is now just the
  // dithered substrate (drawSolidRockTile / drawOpenFloorTile). Bounds
  // measured across a 32x32 hash sweep at the time of writing:
  //   OPEN tile fillRect count: 1..11
  //   WALL tile fillRect count: 4..26
  // Pin a slightly-loose ≤ 40 cap so legitimate substrate variation
  // doesn't fail the test, but a regression re-introducing per-tile
  // mask painting (~36 pixel chamfer × multiple quadrants = 80+) trips it.
  it('open tile emits ≤ 40 fillRects (substrate-only after issue #48)', () => {
    let max = 0;
    for (let tx = 0; tx < 32; tx++) {
      for (let ty = 0; ty < 32; ty++) {
        const gfx = new MockGfx();
        drawAutotiledUndergroundTile(gfx, 0, 0, tx, ty, 'open', makeNeighbors('open'));
        const ops = gfx.calls.filter(c => c.method === 'fillRect').length;
        if (ops > max) max = ops;
      }
    }
    expect(max).toBeLessThanOrEqual(40);
  });

  it('wall tile emits ≤ 40 fillRects (substrate-only after issue #48)', () => {
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
