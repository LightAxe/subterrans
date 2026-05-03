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
} from './terrain-atlas.js';
import { spatialHash } from './terrain-noise.js';
import type { Neighbors3x3, NeighborKind } from './underground-neighbors.js';

// Rim chip salt — used by drawUndergroundRim for hashed 1-pixel darker
// specks in the rim band.
const SALT_RIM_CHIP = 411;
// Issue #48 organic-boundary noise salts — distinct per cardinal edge so
// the encroachment patterns along different edges of the same tile are
// uncorrelated.
const SALT_ORGANIC_N = 501;
const SALT_ORGANIC_E = 502;
const SALT_ORGANIC_S = 503;
const SALT_ORGANIC_W = 504;
// Maximum noise depth in pixels. Bigger numbers = wavier boundary, but
// also narrower tunnels (each pixel of encroachment shrinks the open
// corridor by 1 px on that edge). 3 is the empirically-good balance.
const ORGANIC_MAX_DEPTH = 3 as const;

/**
 * Draw an underground tile: dithered substrate by `centerKind`, plus
 * issue #48 organic-boundary noise on every cardinal-wall edge of an
 * open tile. Tints / decoration (Marked/BeingDug overlay, ceiling tint,
 * etc.) and rim shading are applied separately by the caller.
 *
 * History — issue #48 went through three failed approaches before
 * landing on this one:
 *   - PR #46 chamfer triangles: visible right-triangle "teeth" at corners.
 *   - PR #50 chamfer wobble: triangles still visible, ±1 jaggedness too subtle.
 *   - PR #51 substrate-only: no chamfers, but boundaries on the tile
 *     grid lines read as visible square cell cutouts.
 * Current approach: per-column hashed wall encroachment along each open
 * tile's wall-side edges. The boundary breaks up the grid line without
 * forming a triangle, and corner overlap creates organic curves naturally.
 *
 * Total ops: substrate (~30) + noise encroachment (~16 per active edge,
 * up to 4 active edges) ≈ 95 worst case for an isolated open chamber.
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
    return;
  }
  drawOpenFloorTile(gfx, screenX, screenY, tileX, tileY);
  // Organic wall encroachment along each cardinal-wall edge. Per-pixel
  // hashed depth (0..ORGANIC_MAX_DEPTH) breaks up the grid line so the
  // boundary reads as carved/wavy rather than as a square tile cutout.
  drawOrganicEncroachment(gfx, screenX, screenY, tileX, tileY, neighbors);
}

/**
 * Per-column / per-row hashed wall encroachment into an open tile.
 *
 * For each of the four cardinal edges where the open tile faces a wall
 * neighbor, walk along the edge and paint 0..ORGANIC_MAX_DEPTH pixels of
 * wall color encroaching into the open tile. Depths come from
 * `spatialHash(tileX, tileY, salt + i)` where `i` is the position along
 * the edge — so the pattern is deterministic per (tileX, tileY, edge,
 * position) and uncorrelated between edges (distinct salts per edge).
 *
 * Distribution (chosen aggressively per UAT feedback that small noise
 * was too subtle to break the grid):
 *   depth 0 — 30%
 *   depth 1 — 30%
 *   depth 2 — 25%
 *   depth 3 — 15%
 * So ~70% of pixels along each boundary have at least 1 px encroachment.
 *
 * At corners where two cardinal walls meet (e.g. open tile with N=wall
 * AND W=wall), both edges' encroachments overlap in the corner pixels —
 * the corner naturally fills in deeper than a straight edge, producing
 * an organic curve into the corner without any explicit corner code.
 */
function drawOrganicEncroachment(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  neighbors: Neighbors3x3,
): void {
  const wallN = neighbors.n === 'wall';
  const wallS = neighbors.s === 'wall';
  const wallE = neighbors.e === 'wall';
  const wallW = neighbors.w === 'wall';
  if (!wallN && !wallS && !wallE && !wallW) return;

  gfx.fillStyle(COLOR_ROCK_BASE, 1);

  if (wallN) drawEdgeNoise(gfx, screenX, screenY, tileX, tileY, 'N');
  if (wallS) drawEdgeNoise(gfx, screenX, screenY, tileX, tileY, 'S');
  if (wallE) drawEdgeNoise(gfx, screenX, screenY, tileX, tileY, 'E');
  if (wallW) drawEdgeNoise(gfx, screenX, screenY, tileX, tileY, 'W');
}

type EdgeDir = 'N' | 'S' | 'E' | 'W';

/**
 * Sample a depth in [0, ORGANIC_MAX_DEPTH] from the hash byte. The
 * thresholds are tuned for an aggressive distribution per the issue
 * #48 UAT feedback — see the parent function's docblock.
 */
function depthFromHashByte(b: number): number {
  if (b < 0x4d) return 0; // ~30%
  if (b < 0x9a) return 1; // ~30%
  if (b < 0xd9) return 2; // ~25%
  return 3;               // ~15%
}

/**
 * Paint the noise band along one cardinal edge. Caller has already set
 * fillStyle. For each of the 16 pixel positions along the edge, sample
 * the hash byte and emit a 1-pixel-wide band with that depth into the
 * open tile.
 */
function drawEdgeNoise(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  edge: EdgeDir,
): void {
  const salt =
    edge === 'N' ? SALT_ORGANIC_N :
    edge === 'E' ? SALT_ORGANIC_E :
    edge === 'S' ? SALT_ORGANIC_S :
                   SALT_ORGANIC_W;

  const last = TILE_SIZE_PX - 1;
  for (let i = 0; i < TILE_SIZE_PX; i++) {
    const h = spatialHash(tileX, tileY, salt + i);
    const depth = depthFromHashByte(h & 0xff);
    if (depth === 0) continue;

    // Emit a 1-pixel-wide band perpendicular to the edge, depth pixels
    // deep into the open tile from that edge.
    let px = 0, py = 0, w = 0, hgt = 0;
    switch (edge) {
      case 'N': px = i; py = 0;            w = 1;     hgt = depth; break;
      case 'S': px = i; py = last - depth + 1; w = 1; hgt = depth; break;
      case 'W': px = 0; py = i;            w = depth; hgt = 1;     break;
      case 'E': px = last - depth + 1; py = i; w = depth; hgt = 1; break;
    }
    gfx.fillRect(screenX + px, screenY + py, w, hgt);
  }
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
