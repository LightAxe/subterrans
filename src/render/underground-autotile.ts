// underground-autotile.ts — underground tile rendering.
//
// `drawAutotiledUndergroundTile` paints the dithered substrate for a tile
// based on its centerKind ('wall' or 'open'). `drawUndergroundRim` adds
// a translucent 2-pixel darker rim band on the open side of wall
// boundaries (plus deterministic 1-pixel darker chip specks within the
// band) for the carved-out feel.
//
// History — issue #43 originally introduced quarter-tile autotile masks
// (chamfer + inner-corner-bite) at this function for "smooth stair-step
// diagonal corridors." Issue #48 removed those masks: their opaque
// opposite-kind triangles read as visible right-triangle "teeth" at every
// corner where the autotile fired (chambers, L-corners, stair-step
// diagonals). The hashed-wobble attempt (PR #50, closed) didn't fix the
// silhouette read at high contrast. Corners now render as clean
// tile-aligned squares; rim shading provides the only visual
// differentiation along wall-side edges. The function name + signature
// are preserved so any future re-introduction of a corner-softening pass
// can land here without touching callers.
//
// Render-only — no sim mutation, no simVersion bump.

import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX } from './sprites.js';
import {
  drawSolidRockTile,
  drawOpenFloorTile,
  COLOR_ROCK_BASE,
  COLOR_ROCK_BASE_DARK,
  COLOR_FLOOR_BASE,
} from './terrain-atlas.js';
import { spatialHash } from './terrain-noise.js';
import type { Neighbors3x3, NeighborKind } from './underground-neighbors.js';

// Rim chip salt — used by drawUndergroundRim for hashed 1-pixel darker
// specks in the rim band.
const SALT_RIM_CHIP = 411;
// Issue #48 v4 — boundary-displacement salts. One per axis so horizontal
// and vertical edge offsets are independent.
const SALT_BOUNDARY_H = 521;
const SALT_BOUNDARY_V = 522;
// Maximum boundary displacement in pixels. The actual boundary between
// wall and open materials wanders ±BOUNDARY_AMP from the nominal tile
// grid line, so corner positions are no longer pinned to tile corners.
// UAT feedback on AMP=5: "weird spikes pointing out of the tunnels."
// Reduced to 3 — extreme excursions are what produce the spike artifact
// (especially at corners where N and W encroachments overlap with
// different magnitudes). With AMP=3 the boundary still deviates
// noticeably from the grid but transitions feel like gentle rolling.
const BOUNDARY_AMP = 3 as const;
// Control-point spacing in pixels. Smaller = more frequent variation
// (jagged); larger = smoother/wavier. 16 gives ~1 control point per
// tile edge with cosine smoothing — very slow rolling waves over
// multi-tile spans. UAT feedback on CP_SPACING=8: "still too jagged,
// should look like a glass ant farm." Bumped to one wave per tile.
const BOUNDARY_CP_SPACING = 16 as const;

/**
 * Draw an underground tile: dithered substrate by `centerKind`, plus
 * issue #48 v4 organic-boundary displacement on every cardinal edge
 * where the tile meets an opposite-kind neighbor. Tints / decoration
 * (Marked/BeingDug overlay, ceiling tint, etc.) and rim shading are
 * applied separately by the caller.
 *
 * History — issue #48 iterated four times before landing here:
 *   - PR #46 chamfer triangles: visible right-triangle "teeth" at corners.
 *   - PR #50 chamfer wobble: triangles still visible, ±1 too subtle.
 *   - PR #51 substrate-only: no chamfers, but boundaries on tile grid
 *     lines read as visible square cell cutouts.
 *   - PR #52 v3 per-pixel ±0-3 noise: too subtle, 90° corners persisted
 *     because wall tiles painted nothing back into themselves.
 *
 * Current approach (v4): the wall/open boundary is a smooth low-frequency
 * continuous curve that lives independently of the tile grid. Per-pixel
 * displacement is computed via cosine-interpolation between hashed
 * control points spaced every BOUNDARY_CP_SPACING pixels, keyed off
 * GLOBAL pixel coordinates (so the curve flows smoothly across tile
 * boundaries instead of restarting each tile). Both sides of every
 * boundary paint encroachment — wall extending into open AND open
 * extending into wall — so the boundary is wavy from both perspectives,
 * fully decoupling visible silhouette from the underlying tile grid.
 *
 * Total ops: substrate (~30) + per-edge displacement (up to 16 per
 * active edge × 4 edges) ≈ 95 worst case for an isolated tile.
 */
export function drawAutotiledUndergroundTile(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  centerKind: NeighborKind,
  neighbors: Neighbors3x3,
): void {
  if (centerKind === 'wall') {
    drawSolidRockTile(gfx, screenX, screenY, tileX, tileY);
  } else {
    drawOpenFloorTile(gfx, screenX, screenY, tileX, tileY);
  }
  drawBoundaryDisplacement(gfx, screenX, screenY, tileX, tileY, centerKind, neighbors);
}

/**
 * Bidirectional boundary displacement.
 *
 * For each cardinal direction where the tile faces an OPPOSITE-kind
 * neighbor, paint encroachment of the neighbor's kind into THIS tile.
 * The depth per pixel comes from a smooth shared boundary-offset curve
 * that's continuous across tile boundaries — so an open tile painting
 * "wall comes down 3 px here" and the wall tile above painting "open
 * goes up 2 px there" together produce a single wavy line that flows
 * organically through the world, never anchored to the grid.
 *
 * Sign convention: `boundaryOffsetH(globalX, edgeRowIdx)` returns a
 * signed offset for the horizontal edge between tile rows
 * `edgeRowIdx-1` (above) and `edgeRowIdx` (below). Positive = boundary
 * moves DOWN into the lower tile. Negative = boundary moves UP into
 * the upper tile. The lower tile paints opposite-kind for offset > 0;
 * the upper tile paints opposite-kind for offset < 0. Both keys are
 * consistent so adjacent tiles agree on the same boundary curve.
 */
function drawBoundaryDisplacement(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  centerKind: NeighborKind,
  neighbors: Neighbors3x3,
): void {
  const oppositeColor = centerKind === 'wall' ? COLOR_FLOOR_BASE : COLOR_ROCK_BASE;
  const last = TILE_SIZE_PX - 1;

  // North edge — between tile row tileY-1 (above) and tileY (this).
  // This tile is the LOWER tile; paint into rows [0..off-1] when off>0.
  if (neighbors.n !== centerKind) {
    gfx.fillStyle(oppositeColor, 1);
    for (let lx = 0; lx < TILE_SIZE_PX; lx++) {
      const off = boundaryOffsetH(tileX * TILE_SIZE_PX + lx, tileY);
      if (off > 0) gfx.fillRect(screenX + lx, screenY, 1, off);
    }
  }

  // South edge — between tile row tileY (this) and tileY+1 (below).
  // This tile is the UPPER tile of this edge; paint into rows
  // [last + off + 1 .. last] when off<0 (i.e. depth = -off pixels).
  if (neighbors.s !== centerKind) {
    gfx.fillStyle(oppositeColor, 1);
    for (let lx = 0; lx < TILE_SIZE_PX; lx++) {
      const off = boundaryOffsetH(tileX * TILE_SIZE_PX + lx, tileY + 1);
      if (off < 0) {
        const depth = -off;
        gfx.fillRect(screenX + lx, screenY + last - depth + 1, 1, depth);
      }
    }
  }

  // West edge — between tile column tileX-1 (left) and tileX (this).
  // This tile is the RIGHT tile; paint into cols [0..off-1] when off>0.
  if (neighbors.w !== centerKind) {
    gfx.fillStyle(oppositeColor, 1);
    for (let ly = 0; ly < TILE_SIZE_PX; ly++) {
      const off = boundaryOffsetV(tileY * TILE_SIZE_PX + ly, tileX);
      if (off > 0) gfx.fillRect(screenX, screenY + ly, off, 1);
    }
  }

  // East edge — between tile column tileX (this) and tileX+1 (right).
  // This tile is the LEFT tile of this edge; paint into cols
  // [last + off + 1 .. last] when off<0 (depth = -off pixels).
  if (neighbors.e !== centerKind) {
    gfx.fillStyle(oppositeColor, 1);
    for (let ly = 0; ly < TILE_SIZE_PX; ly++) {
      const off = boundaryOffsetV(tileY * TILE_SIZE_PX + ly, tileX + 1);
      if (off < 0) {
        const depth = -off;
        gfx.fillRect(screenX + last - depth + 1, screenY + ly, depth, 1);
      }
    }
  }
}

/**
 * Smooth horizontal-edge displacement at `globalX`, for the edge between
 * tile rows `edgeRowIdx - 1` (above) and `edgeRowIdx` (below).
 *
 * Cosine-interpolated between two hashed control points spaced
 * BOUNDARY_CP_SPACING pixels apart along the edge. Range is
 * [-BOUNDARY_AMP, +BOUNDARY_AMP] (rounded to integer pixels).
 *
 * Determinism: both `tileX-1` and `tileX` (when rendering adjacent
 * tiles) compute the SAME globalX positions for shared boundary cells,
 * and use the SAME `edgeRowIdx`, so the offset agrees across tiles.
 */
export function boundaryOffsetH(globalX: number, edgeRowIdx: number): number {
  const cpA = Math.floor(globalX / BOUNDARY_CP_SPACING) * BOUNDARY_CP_SPACING;
  const cpB = cpA + BOUNDARY_CP_SPACING;
  const t = (globalX - cpA) / BOUNDARY_CP_SPACING;
  const hA = spatialHash(cpA, edgeRowIdx, SALT_BOUNDARY_H);
  const hB = spatialHash(cpB, edgeRowIdx, SALT_BOUNDARY_H);
  // Map hash byte to [-AMP, +AMP] floating, then cosine-interp, round.
  const offA = ((hA & 0xff) - 127.5) / 127.5 * BOUNDARY_AMP;
  const offB = ((hB & 0xff) - 127.5) / 127.5 * BOUNDARY_AMP;
  const smoothT = (1 - Math.cos(t * Math.PI)) / 2;
  return Math.round(offA * (1 - smoothT) + offB * smoothT);
}

/** Vertical-edge displacement, mirrored math. */
export function boundaryOffsetV(globalY: number, edgeColIdx: number): number {
  const cpA = Math.floor(globalY / BOUNDARY_CP_SPACING) * BOUNDARY_CP_SPACING;
  const cpB = cpA + BOUNDARY_CP_SPACING;
  const t = (globalY - cpA) / BOUNDARY_CP_SPACING;
  const hA = spatialHash(edgeColIdx, cpA, SALT_BOUNDARY_V);
  const hB = spatialHash(edgeColIdx, cpB, SALT_BOUNDARY_V);
  const offA = ((hA & 0xff) - 127.5) / 127.5 * BOUNDARY_AMP;
  const offB = ((hB & 0xff) - 127.5) / 127.5 * BOUNDARY_AMP;
  const smoothT = (1 - Math.cos(t * Math.PI)) / 2;
  return Math.round(offA * (1 - smoothT) + offB * smoothT);
}

// ---------------------------------------------------------------------------
// drawUndergroundRim — Checkpoint 4 rim/lighting pass.
//
// Issue #43 — pure quarter-tile shape masks in flat colours look flat.
// The screenshot example reads as a tunnel partly because of a 1-2px darker
// "packed earth" rim along the open corridor's wall-adjacent edges. We draw
// that rim as a separate pass after the autotile masks (so chamfer/inner-
// corner pixels still get the rim's darkening, which subtly outlines them
// even more).
//
// Rim only fires on OPEN tiles (centerKind === 'open'). Wall tiles get
// nothing — there's no contrast direction that would help on a wall tile.
//
// Two-band fade per cardinal wall neighbor:
//   - outer 1px row at alpha 0.55 (heavy)
//   - inner 1px row at alpha 0.30 (light transition)
// Same alphas as the previous drawTunnelCornerOverlay edge bands so the
// "soft pack" feel is preserved.
// ---------------------------------------------------------------------------

export function drawUndergroundRim(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  centerKind: NeighborKind,
  neighbors: Neighbors3x3,
): void {
  if (centerKind !== 'open') return;

  const wallN = neighbors.n === 'wall';
  const wallS = neighbors.s === 'wall';
  const wallE = neighbors.e === 'wall';
  const wallW = neighbors.w === 'wall';
  if (!wallN && !wallS && !wallE && !wallW) return;

  const last = TILE_SIZE_PX - 1;

  // Issue #48 v4 follow-up — the boundary curve is displaced from the
  // tile-grid line, so the rim must follow the curve, not the grid.
  // Per pixel along each active edge, compute the same offset the
  // displacement pass used and place the 2-pixel rim band immediately
  // ON THE OPEN SIDE of the boundary. Heavy band (alpha 0.55) is the
  // first open-side pixel; light band (alpha 0.30) is the next one.

  // North edge — open side begins at row max(off, 0). When off > 0,
  // wall encroaches into rows [0..off-1]; rim sits at rows [off..off+1].
  // When off ≤ 0, boundary is at or above row 0 (in the wall tile);
  // rim sits at rows [0..1] of this open tile (still adjacent to the
  // boundary's open side).
  if (wallN) {
    for (let lx = 0; lx < TILE_SIZE_PX; lx++) {
      const off = boundaryOffsetH(tileX * TILE_SIZE_PX + lx, tileY);
      const startRow = off > 0 ? off : 0;
      gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
      gfx.fillRect(screenX + lx, screenY + startRow, 1, 1);
      if (startRow + 1 < TILE_SIZE_PX) {
        gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.30);
        gfx.fillRect(screenX + lx, screenY + startRow + 1, 1, 1);
      }
    }
  }
  // South edge — open side ends at row min(last - (-off), last) when
  // off < 0 (boundary moved up by -off into wall above). When off ≥ 0,
  // rim sits at rows [last-1..last] (default position).
  if (wallS) {
    for (let lx = 0; lx < TILE_SIZE_PX; lx++) {
      const off = boundaryOffsetH(tileX * TILE_SIZE_PX + lx, tileY + 1);
      const endRow = off < 0 ? last + off : last;
      gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
      gfx.fillRect(screenX + lx, screenY + endRow, 1, 1);
      if (endRow - 1 >= 0) {
        gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.30);
        gfx.fillRect(screenX + lx, screenY + endRow - 1, 1, 1);
      }
    }
  }
  // West edge — same logic with x in place of y.
  if (wallW) {
    for (let ly = 0; ly < TILE_SIZE_PX; ly++) {
      const off = boundaryOffsetV(tileY * TILE_SIZE_PX + ly, tileX);
      const startCol = off > 0 ? off : 0;
      gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
      gfx.fillRect(screenX + startCol, screenY + ly, 1, 1);
      if (startCol + 1 < TILE_SIZE_PX) {
        gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.30);
        gfx.fillRect(screenX + startCol + 1, screenY + ly, 1, 1);
      }
    }
  }
  // East edge.
  if (wallE) {
    for (let ly = 0; ly < TILE_SIZE_PX; ly++) {
      const off = boundaryOffsetV(tileY * TILE_SIZE_PX + ly, tileX + 1);
      const endCol = off < 0 ? last + off : last;
      gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
      gfx.fillRect(screenX + endCol, screenY + ly, 1, 1);
      if (endCol - 1 >= 0) {
        gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.30);
        gfx.fillRect(screenX + endCol - 1, screenY + ly, 1, 1);
      }
    }
  }

  // Per-tile rim chips — 1-pixel deterministic dark specks inside each
  // active rim band, breaking the rim's flat appearance.
  const h = spatialHash(tileX, tileY, SALT_RIM_CHIP);
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
  if (wallN) {
    const x = (h >>> 0) & 0xf;
    const off = boundaryOffsetH(tileX * TILE_SIZE_PX + x, tileY);
    const row = off > 0 ? off : 0;
    if (row + 1 < TILE_SIZE_PX) gfx.fillRect(screenX + x, screenY + row + 1, 1, 1);
  }
  if (wallS) {
    const x = (h >>> 4) & 0xf;
    const off = boundaryOffsetH(tileX * TILE_SIZE_PX + x, tileY + 1);
    const row = off < 0 ? last + off : last;
    if (row - 1 >= 0) gfx.fillRect(screenX + x, screenY + row - 1, 1, 1);
  }
  if (wallW) {
    const y = (h >>> 8) & 0xf;
    const off = boundaryOffsetV(tileY * TILE_SIZE_PX + y, tileX);
    const col = off > 0 ? off : 0;
    if (col + 1 < TILE_SIZE_PX) gfx.fillRect(screenX + col + 1, screenY + y, 1, 1);
  }
  if (wallE) {
    const y = (h >>> 12) & 0xf;
    const off = boundaryOffsetV(tileY * TILE_SIZE_PX + y, tileX + 1);
    const col = off < 0 ? last + off : last;
    if (col - 1 >= 0) gfx.fillRect(screenX + col - 1, screenY + y, 1, 1);
  }
}
