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
  COLOR_ROCK_BASE_DARK,
} from './terrain-atlas.js';
import { spatialHash } from './terrain-noise.js';
import type { Neighbors3x3, NeighborKind } from './underground-neighbors.js';

// Rim chip salt — used by drawUndergroundRim for hashed 1-pixel darker
// specks in the rim band.
const SALT_RIM_CHIP = 411;

/**
 * Draw an underground tile: dithered substrate by `centerKind`. Tints /
 * decoration (Marked/BeingDug overlay, ceiling tint, etc.) and rim shading
 * are applied separately by the caller.
 *
 * Issue #48 follow-up: the chamfer + inner-corner-bite painting that PR
 * #46 introduced has been REMOVED. Those opaque opposite-kind triangles
 * read as visible right-triangle "teeth" at every corner where the
 * autotile fired (chambers, L-corners, stair-step diagonals) and the
 * hashed-wobble attempt (PR #50, closed) didn't fix the problem — the
 * silhouette stayed triangular at high contrast even with ±1 boundary
 * jaggedness. Corners now read as clean tile-aligned squares with the
 * rim-shading pass (`drawUndergroundRim`) providing the carved-out feel
 * along wall-side edges.
 *
 * The function name + signature are preserved so callers (draw-underground.ts)
 * don't need to change. The `neighbors` parameter is unused at present but
 * is retained for any future re-introduction of a corner-softening pass
 * that doesn't paint hard triangles.
 *
 * Total ops: dominated by the substrate (~30); no per-quadrant work.
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
  void neighbors; // see docblock — kept for signature stability.
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

  // Heavy band — outermost pixel row/column on each wall-facing edge.
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
  if (wallN) gfx.fillRect(screenX,            screenY,            TILE_SIZE_PX, 1);
  if (wallS) gfx.fillRect(screenX,            screenY + last,     TILE_SIZE_PX, 1);
  if (wallW) gfx.fillRect(screenX,            screenY,            1, TILE_SIZE_PX);
  if (wallE) gfx.fillRect(screenX + last,     screenY,            1, TILE_SIZE_PX);

  // Light band — second pixel inward, lighter alpha for the fade transition.
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.30);
  if (wallN) gfx.fillRect(screenX,            screenY + 1,        TILE_SIZE_PX, 1);
  if (wallS) gfx.fillRect(screenX,            screenY + last - 1, TILE_SIZE_PX, 1);
  if (wallW) gfx.fillRect(screenX + 1,        screenY,            1, TILE_SIZE_PX);
  if (wallE) gfx.fillRect(screenX + last - 1, screenY,            1, TILE_SIZE_PX);

  // Per-tile rim chips — 1-pixel deterministic dark specks inside each
  // active rim band, breaking the rim's flat appearance. Same alpha as
  // the heavy band so chips read as small "packed soil" grains rather
  // than sub-rim noise. Position is hash-driven within the band.
  const h = spatialHash(tileX, tileY, SALT_RIM_CHIP);
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
  if (wallN) {
    const x = (h >>> 0) & 0xf;        // 0..15
    gfx.fillRect(screenX + x, screenY + 1, 1, 1);
  }
  if (wallS) {
    const x = (h >>> 4) & 0xf;
    gfx.fillRect(screenX + x, screenY + last - 1, 1, 1);
  }
  if (wallW) {
    const y = (h >>> 8) & 0xf;
    gfx.fillRect(screenX + 1, screenY + y, 1, 1);
  }
  if (wallE) {
    const y = (h >>> 12) & 0xf;
    gfx.fillRect(screenX + last - 1, screenY + y, 1, 1);
  }
}
