// underground-autotile.ts — issue #43 Checkpoint 2.
//
// Quarter-tile autotiling for the underground cross-section. Replaces the
// per-corner overlay path (drawTunnelCornerOverlay + drawSolidConvexCornerOverlay)
// with a quadrant-based approach where each tile's four 8×8 quadrants pick a
// canonical shape from a small catalogue and paint OPPOSITE-kind pixels into
// the quadrant when the silhouette demands it.
//
// The canonical quarter shapes (per quadrant):
//
//   sameH sameV  shape          paints OPPOSITE kind?
//   ───────────────────────────────────────────────────
//     0     0    chamfer        yes — triangular fill at outer corner
//     1     0    h-edge         no  — substrate is correct
//     0     1    v-edge         no  — substrate is correct
//     1     1    full           no  — substrate is correct
//
// where sameH/V mean "this cardinal neighbor matches the center kind". h-edge/v-edge
// represent straight cardinal walls; the rim shading that visually distinguishes
// them from the open floor is added by a SEPARATE pass (Checkpoint 4) so the
// shape logic stays orthogonal to the lighting/texture concerns.
//
// Sacred join contract — the chamfer hypotenuse passes through the edge
// midpoints of the full tile (NW: (8,0)→(0,8); NE: (8,0)→(15,8); SE:
// (15,8)→(8,15); SW: (0,8)→(8,15)). Variants may alter the jaggedness
// between anchors but must NOT move them, so adjacent tiles' chamfers meet
// exactly along their shared edge midpoint.
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

// Per-quadrant salt namespaces for chamfer chip placement. Distinct so
// adjacent quadrants on the same tile pick independent chip positions.
const SALT_CHIP_NW = 401;
const SALT_CHIP_NE = 402;
const SALT_CHIP_SE = 403;
const SALT_CHIP_SW = 404;
// Rim chip salt (one channel — band-position derived from quadrant).
const SALT_RIM_CHIP = 411;

const HALF = TILE_SIZE_PX / 2; // 8

type Quadrant = 'NW' | 'NE' | 'SE' | 'SW';

/**
 * Draw an autotiled underground tile: substrate by `centerKind`, then
 * quarter-tile masks driven by the 3×3 neighborhood. Tints / decoration
 * (Marked/BeingDug overlay, ceiling tint, etc.) are applied separately by
 * the caller.
 *
 * Total ops: ~30 (substrate) + up to 4 × 8 (chamfers) ≈ 65 worst case for
 * an isolated open pocket.
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
  // 1. Substrate — same dithered base the existing code uses, so axis-aligned
  //    corridors render byte-identical for substrate-level pixels.
  if (centerKind === 'wall') {
    drawSolidRockTile(gfx, screenX, screenY, tileX, tileY);
  } else {
    drawOpenFloorTile(gfx, screenX, screenY, tileX, tileY);
  }

  // 2. Quarter-tile masks. We paint the OPPOSITE substrate's base color into
  //    the quadrant region the autotile says belongs to the other kind. Solid
  //    color (no dither) — the chamfer reads as a clean "carved" region
  //    against the dithered substrate behind it, which is the right contrast
  //    for a hard-pixel-art look. Each helper sets its own fillStyle so the
  //    chip and chamfer paints don't bleed into one another.
  //
  // For each quadrant, the (h, v) classification picks a shape. h is the
  // cardinal-horizontal neighbor (W for NW/SW, E for NE/SE); v is the
  // cardinal-vertical neighbor (N for NW/NE, S for SW/SE). Diagonal-only
  // mismatches are intentionally ignored after issue #48.
  drawQuadrantMask(gfx, screenX, screenY, tileX, tileY, centerKind, 'NW', neighbors.w, neighbors.n);
  drawQuadrantMask(gfx, screenX, screenY, tileX, tileY, centerKind, 'NE', neighbors.e, neighbors.n);
  drawQuadrantMask(gfx, screenX, screenY, tileX, tileY, centerKind, 'SE', neighbors.e, neighbors.s);
  drawQuadrantMask(gfx, screenX, screenY, tileX, tileY, centerKind, 'SW', neighbors.w, neighbors.s);
}

function drawQuadrantMask(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  centerKind: NeighborKind,
  quadrant: Quadrant,
  horizKind: NeighborKind,
  vertKind:  NeighborKind,
): void {
  const sameH = horizKind === centerKind;
  const sameV = vertKind  === centerKind;

  const oppositeColor = centerKind === 'wall' ? COLOR_FLOOR_BASE : COLOR_ROCK_BASE;
  if (!sameH && !sameV) {
    // chamfer — the quadrant has two opposite-kind cardinals. Paint a
    // hypotenuse-anchored triangle of OPPOSITE kind into the outer corner.
    gfx.fillStyle(oppositeColor, 1);
    fillChamferTriangle(gfx, screenX, screenY, quadrant);
    // Per-tile chip variant — 1 deterministic pixel of CENTER-kind paint
    // inside the chamfer interior, simulating a chip / crack / mineral
    // inclusion. Strictly avoids the sacred edges (row 0 / col 0) and the
    // hypotenuse boundary, so anchor and join contracts hold regardless.
    maybeAddChamferChip(gfx, screenX, screenY, tileX, tileY, quadrant, centerKind);
  }
  // else: full / h-edge / v-edge — substrate is correct, nothing to paint.
  // Diagonal-only mismatches intentionally do not paint: issue #48 showed
  // those tiny opposite-kind bites read as stray wrong-side triangles.
}

/**
 * Fill the hypotenuse-anchored triangle inside the named quadrant. The
 * triangle covers (lx, ly) where lx + ly ≤ 7 in quadrant-local coords; the
 * hypotenuse passes through the tile-edge midpoints, so adjacent tiles'
 * chamfers join cleanly on their shared edge.
 *
 * 8 fillRect scanline calls per chamfer.
 */
function fillChamferTriangle(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  quadrant: Quadrant,
): void {
  // For each of the 8 scanlines, compute the row's (x, y) origin and width.
  // The triangle's "right angle" sits at the outer corner of the quadrant
  // (the corner of the full tile); the hypotenuse runs from the midpoint of
  // one tile edge to the midpoint of the adjacent tile edge.
  for (let i = 0; i < HALF; i++) {
    const width = HALF - i;
    let x = 0, y = 0;
    switch (quadrant) {
      case 'NW': x = 0;                        y = i;                              break;
      case 'NE': x = HALF + i;                 y = i;                              break;
      case 'SE': x = HALF + i;                 y = TILE_SIZE_PX - 1 - i;           break;
      case 'SW': x = 0;                        y = TILE_SIZE_PX - 1 - i;           break;
    }
    gfx.fillRect(screenX + x, screenY + y, width, 1);
  }
}

/**
 * Place a 1-pixel "chip" of CENTER-kind paint inside a chamfer interior.
 *
 * Visual purpose: long stair-step diagonals look stamped if every chamfer
 * is pixel-identical. A single deterministic 1-pixel chip per chamfer
 * breaks the repetition without altering the silhouette.
 *
 * Sacred-edge protection: the chip's local (lx, ly) lives in [1..5] × [1..5]
 * with the additional constraint lx + ly ≤ 6 (strictly inside the canonical
 * chamfer hypotenuse, lx + ly < 8). So:
 *   - lx ≥ 1 → never on col 0 (sacred join with adjacent quadrant)
 *   - ly ≥ 1 → never on row 0 (same)
 *   - lx + ly ≤ 6 → never on or past the canonical hypotenuse pixels
 *
 * Approximate chip rate ~60% (h & 0xff < 154), so most chamfers carry one
 * but uniform stair-steps occasionally show a "boring" canonical mask too.
 */
function maybeAddChamferChip(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  quadrant: Quadrant,
  centerKind: NeighborKind,
): void {
  const salt = quadrant === 'NW' ? SALT_CHIP_NW
             : quadrant === 'NE' ? SALT_CHIP_NE
             : quadrant === 'SE' ? SALT_CHIP_SE
             :                     SALT_CHIP_SW;
  const h = spatialHash(tileX, tileY, salt);
  if ((h & 0xff) >= 154) return; // ~60% emission rate

  // Sample (lx, ly) inside the safe region. lx ∈ [1..5]; ly ∈ [1..(6 - lx)].
  // The constraint lx + ly ≤ 6 keeps the chip strictly interior.
  const lx = 1 + ((h >>> 8) & 0xf) % 5;
  const ly = 1 + ((h >>> 12) & 0xf) % (6 - lx);

  // Map quadrant-local (lx, ly) to tile-relative pixel.
  let px = 0, py = 0;
  switch (quadrant) {
    case 'NW': px = lx;                          py = ly;                          break;
    case 'NE': px = TILE_SIZE_PX - 1 - lx;       py = ly;                          break;
    case 'SE': px = TILE_SIZE_PX - 1 - lx;       py = TILE_SIZE_PX - 1 - ly;       break;
    case 'SW': px = lx;                          py = TILE_SIZE_PX - 1 - ly;       break;
  }

  // Chip color is the CENTER kind — i.e., a 1-pixel "cut" through the
  // opposite-kind chamfer fill, revealing the substrate beneath. For an
  // open tile this is a tiny floor-color crack in the rock chamfer; for
  // a wall tile it's a tiny rock-color bump in the floor chamfer.
  const chipColor = centerKind === 'wall' ? COLOR_ROCK_BASE : COLOR_FLOOR_BASE;
  gfx.fillStyle(chipColor, 1);
  gfx.fillRect(screenX + px, screenY + py, 1, 1);
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
  // Clip ONLY the chamfer-occupied portion of the half-edge (codex P2 pass —
  // the previous "clip whole half" rule over-clipped: at row 1 of the N rim,
  // the NW chamfer covers cols 0..6 only, so col 7 should still get rim
  // shading. The depth-aware clip uses HALF - rowFromEdge so each band's
  // clip width matches the chamfer's actual width at that row.
  //
  // rowFromEdge: distance into the tile from the band's outer edge.
  //   - heavy band (outermost row/col): 0 → clip full HALF width (chamfer
  //     row 0 covers 0..7).
  //   - light band (1 inward): 1 → clip HALF-1 = 7 (chamfer row 1 covers
  //     0..6); the edge pixel at 7 stays visible.
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
  if (wallN) drawHorizontalRimBand(gfx, screenX, screenY,        0, wallW, wallE);
  if (wallS) drawHorizontalRimBand(gfx, screenX, screenY + last, 0, wallW, wallE);
  if (wallW) drawVerticalRimBand(gfx,   screenX, screenY,        0, wallN, wallS);
  if (wallE) drawVerticalRimBand(gfx,   screenX + last, screenY, 0, wallN, wallS);

  // Light band — 1 pixel inward, lighter alpha for the fade transition.
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.30);
  if (wallN) drawHorizontalRimBand(gfx, screenX, screenY + 1,        1, wallW, wallE);
  if (wallS) drawHorizontalRimBand(gfx, screenX, screenY + last - 1, 1, wallW, wallE);
  if (wallW) drawVerticalRimBand(gfx,   screenX + 1, screenY,        1, wallN, wallS);
  if (wallE) drawVerticalRimBand(gfx,   screenX + last - 1, screenY, 1, wallN, wallS);

  // Per-tile rim chips — 1-pixel deterministic dark specks inside each
  // active rim band, breaking the rim's flat appearance. Same alpha as
  // the heavy band so chips read as small "packed soil" grains rather
  // than sub-rim noise. Chip lives on the LIGHT band (rowFromEdge=1).
  const h = spatialHash(tileX, tileY, SALT_RIM_CHIP);
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
  if (wallN) {
    const x = (h >>> 0) & 0xf;        // 0..15
    if (rimXVisible(x, 1, wallW, wallE)) gfx.fillRect(screenX + x, screenY + 1, 1, 1);
  }
  if (wallS) {
    const x = (h >>> 4) & 0xf;
    if (rimXVisible(x, 1, wallW, wallE)) gfx.fillRect(screenX + x, screenY + last - 1, 1, 1);
  }
  if (wallW) {
    const y = (h >>> 8) & 0xf;
    if (rimYVisible(y, 1, wallN, wallS)) gfx.fillRect(screenX + 1, screenY + y, 1, 1);
  }
  if (wallE) {
    const y = (h >>> 12) & 0xf;
    if (rimYVisible(y, 1, wallN, wallS)) gfx.fillRect(screenX + last - 1, screenY + y, 1, 1);
  }
}

/**
 * Paint a 1-pixel-tall rim band at row `y`, clipping the chamfer-occupied
 * portion on either end. `rowFromEdge` is the band's depth into the tile
 * from its outer edge (0 = outermost / heavy, 1 = inner / light). The
 * clip width on each side matches the chamfer's width at that row, so
 * pixels outside the chamfer remain visible.
 */
function drawHorizontalRimBand(
  gfx: GfxLike,
  screenX: number,
  y: number,
  rowFromEdge: number,
  clipWestHalf: boolean,
  clipEastHalf: boolean,
): void {
  const clipPx = HALF - rowFromEdge;
  // Beyond the chamfer's reach — the row is fully outside any chamfer,
  // so paint the full edge regardless of clip flags.
  if (clipPx <= 0) {
    gfx.fillRect(screenX, y, TILE_SIZE_PX, 1);
    return;
  }
  const start  = clipWestHalf ? clipPx : 0;
  const endExc = clipEastHalf ? (TILE_SIZE_PX - clipPx) : TILE_SIZE_PX;
  if (endExc > start) {
    gfx.fillRect(screenX + start, y, endExc - start, 1);
  }
}

/** Vertical mirror of `drawHorizontalRimBand`. */
function drawVerticalRimBand(
  gfx: GfxLike,
  x: number,
  screenY: number,
  colFromEdge: number,
  clipNorthHalf: boolean,
  clipSouthHalf: boolean,
): void {
  const clipPx = HALF - colFromEdge;
  if (clipPx <= 0) {
    gfx.fillRect(x, screenY, 1, TILE_SIZE_PX);
    return;
  }
  const start  = clipNorthHalf ? clipPx : 0;
  const endExc = clipSouthHalf ? (TILE_SIZE_PX - clipPx) : TILE_SIZE_PX;
  if (endExc > start) {
    gfx.fillRect(x, screenY + start, 1, endExc - start);
  }
}

/**
 * True iff a chip at column `x` on a horizontal rim band at depth
 * `rowFromEdge` is outside any chamfered area. Same depth-aware clip
 * geometry as `drawHorizontalRimBand`.
 */
function rimXVisible(
  x: number,
  rowFromEdge: number,
  clipWestHalf: boolean,
  clipEastHalf: boolean,
): boolean {
  const clipPx = HALF - rowFromEdge;
  if (clipPx <= 0) return true;
  if (clipWestHalf && x < clipPx) return false;
  if (clipEastHalf && x >= TILE_SIZE_PX - clipPx) return false;
  return true;
}

/** Vertical mirror of `rimXVisible`. */
function rimYVisible(
  y: number,
  colFromEdge: number,
  clipNorthHalf: boolean,
  clipSouthHalf: boolean,
): boolean {
  const clipPx = HALF - colFromEdge;
  if (clipPx <= 0) return true;
  if (clipNorthHalf && y < clipPx) return false;
  if (clipSouthHalf && y >= TILE_SIZE_PX - clipPx) return false;
  return true;
}
