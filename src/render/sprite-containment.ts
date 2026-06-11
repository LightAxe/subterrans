// sprite-containment.ts — PR 6-render (#128 class-iii): keep an underground ant
// sprite anchored on a valid Open tile from painting over adjacent Solid (dirt).
//
// The bug: sprites are center-origin and some are larger than the 16 px tile
// (queen 20×14; a rotated worker/fighter AABB can also exceed 16 px), so they
// overflow their tile. Overflow INTO passable neighbours is fine (natural); INTO
// a Solid neighbour it paints dirt. The fix uniformly scales a sprite DOWN just
// enough that its rotated axis-aligned bounding box never crosses the tile
// boundary toward a Solid (or off-grid) neighbour — proving the containment
// invariant "drawn footprint ⊆ union of passable neighbours". Workers at natural
// size already fit a tile, so they are never clamped.
//
// Render-only (src/render): floats + Math are allowed here (the `/`-and-float ban
// is src/sim). Pure: reads the grid, returns a number; no world writes.

import type { UndergroundGrid } from '../sim/terrain.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { TILE_SIZE_PX } from './sprites.js';

/** Rotated axis-aligned bounding-box half-extents (px) of a `w`×`h` sprite at
 *  `scale`, rotated by `rotation` radians. Center-origin, so the AABB is
 *  [cx−hx, cx+hx] × [cy−hy, cy+hy]. */
function rotatedAabbHalfExtents(
  w: number,
  h: number,
  rotation: number,
  scale: number,
): { hx: number; hy: number } {
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  return {
    hx: ((w * c + h * s) / 2) * scale,
    hy: ((w * s + h * c) / 2) * scale,
  };
}

/** True iff a tile is NOT passable for containment purposes: off-grid tiles and
 *  Solid tiles are "dirt" a sprite must not paint over. (Open/BeingDug/Marked all
 *  render as carved space, so overflow into them is allowed.) Exception: the
 *  off-grid row ABOVE the grid is NOT dirt — nothing is painted above row 0 in
 *  the underground viewport, and a freshly-descended ant sits at posY=0 (sprite
 *  center on the grid's top edge, edgeN=0), so treating above-grid as dirt would
 *  clamp every descent to scale 0 and make the ant pop out of existence. */
function isDirt(grid: UndergroundGrid, tileX: number, tileY: number): boolean {
  if (tileY < 0) return false;
  if (tileX < 0 || tileX >= grid.width || tileY >= grid.height) return true;
  return ugGet(grid, tileX, tileY) === UndergroundTileState.Solid;
}

/**
 * Largest scale ≤ `desiredScale` such that the sprite's rotated AABB, centered at
 * pixel (cxPx, cyPx) in underground-grid space, does not cross the anchor tile's
 * boundary toward any Solid/off-grid neighbour — i.e. its drawn footprint stays
 * within the union of the anchor tile and its PASSABLE neighbours.
 *
 * Cardinal Solid neighbours clamp the extent toward them to the tile-edge
 * distance exactly; a Solid diagonal clamps only when the AABB crosses both of
 * its edges, and then only along whichever single axis requires the smaller
 * shrink (clearing either edge suffices for a corner-only obstruction). The
 * anchor tile is assumed walkable (callers
 * only draw ants on enterable tiles); a degenerate zero/negative result is
 * floored at 0.
 */
export function containedScale(
  grid: UndergroundGrid,
  cxPx: number,
  cyPx: number,
  spriteW: number,
  spriteH: number,
  rotation: number,
  desiredScale: number,
): number {
  const { hx, hy } = rotatedAabbHalfExtents(spriteW, spriteH, rotation, desiredScale);
  if (hx <= 0 || hy <= 0) return desiredScale;
  const tileX = Math.floor(cxPx / TILE_SIZE_PX);
  const tileY = Math.floor(cyPx / TILE_SIZE_PX);
  // Distance from the sprite center to each edge of its anchor tile (px).
  const edgeW = cxPx - tileX * TILE_SIZE_PX;
  const edgeE = (tileX + 1) * TILE_SIZE_PX - cxPx;
  const edgeN = cyPx - tileY * TILE_SIZE_PX;
  const edgeS = (tileY + 1) * TILE_SIZE_PX - cyPx;

  // factor starts at 1 (desiredScale) and shrinks to satisfy every Solid side.
  let factor = 1;
  const clampX = (edge: number): void => {
    factor = Math.min(factor, edge / hx);
  };
  const clampY = (edge: number): void => {
    factor = Math.min(factor, edge / hy);
  };
  // A Solid diagonal is only overlapped when the AABB crosses BOTH of its
  // edges (hx > edgeX AND hy > edgeY), and shrinking along ONE axis suffices
  // to clear a corner-only obstruction — so take the LESS restrictive of the
  // two per-axis clamps. Clamping both axes unconditionally would drive the
  // factor to 0 whenever the center nears a tile edge with dirt diagonally
  // ahead (e.g. every tile crossing in a 1-wide tunnel).
  const clampCorner = (edgeX: number, edgeY: number): void => {
    if (hx > edgeX && hy > edgeY) {
      factor = Math.min(factor, Math.max(edgeX / hx, edgeY / hy));
    }
  };
  if (isDirt(grid, tileX - 1, tileY)) clampX(edgeW);
  if (isDirt(grid, tileX + 1, tileY)) clampX(edgeE);
  if (isDirt(grid, tileX, tileY - 1)) clampY(edgeN);
  if (isDirt(grid, tileX, tileY + 1)) clampY(edgeS);
  if (isDirt(grid, tileX - 1, tileY - 1)) clampCorner(edgeW, edgeN);
  if (isDirt(grid, tileX + 1, tileY - 1)) clampCorner(edgeE, edgeN);
  if (isDirt(grid, tileX - 1, tileY + 1)) clampCorner(edgeW, edgeS);
  if (isDirt(grid, tileX + 1, tileY + 1)) clampCorner(edgeE, edgeS);
  if (factor >= 1) return desiredScale;
  return Math.max(0, desiredScale * factor);
}

/** Result of `containSpritePlacement`: possibly-nudged center + clamped scale. */
export interface ContainedPlacement {
  cxPx: number;
  cyPx: number;
  scale: number;
}

/**
 * Containment by position FIRST, scale second. The sim anchors several
 * underground positions on exact tile coordinates (descent lands at
 * `tileX << FP_SHIFT`; ascent steers toward tile-origin X), which puts the
 * drawn sprite center exactly ON the anchor tile's edge — `edgeW`/`edgeN` = 0.
 * Pure scale containment (`containedScale`) would clamp such a sprite to scale
 * 0 against a Solid neighbour on that side: a shaft ant with the usual Solid
 * west wall would be INVISIBLE for its whole integer-X descent. Instead, slide
 * the center away from each Solid cardinal just far enough that the AABB no
 * longer crosses toward it (never further than the tile allows); only when
 * BOTH sides of an axis are Solid and the sprite cannot fit between them does
 * the axis fall back to tile-center + scale-down. The returned placement is
 * then re-clamped by `containedScale` from the nudged center, so the
 * containment invariant (footprint never paints Solid/off-grid) still holds
 * exactly — the probe checks it at the RETURNED position.
 *
 * The nudge is bounded by half a sprite, only ever moves AWAY from dirt the
 * footprint would otherwise paint, and is constant along a shaft (same
 * neighbour pattern every row), so descent motion stays smooth.
 */
export function containSpritePlacement(
  grid: UndergroundGrid,
  cxPx: number,
  cyPx: number,
  spriteW: number,
  spriteH: number,
  rotation: number,
  desiredScale: number,
): ContainedPlacement {
  const direct = containedScale(grid, cxPx, cyPx, spriteW, spriteH, rotation, desiredScale);
  if (direct >= desiredScale) return { cxPx, cyPx, scale: direct };
  const { hx, hy } = rotatedAabbHalfExtents(spriteW, spriteH, rotation, desiredScale);
  const tileX = Math.floor(cxPx / TILE_SIZE_PX);
  const tileY = Math.floor(cyPx / TILE_SIZE_PX);
  const nudgeAxis = (
    c: number,
    tile: number,
    h: number,
    dirtLo: boolean,
    dirtHi: boolean,
  ): number => {
    const lo = tile * TILE_SIZE_PX + h;
    const hi = (tile + 1) * TILE_SIZE_PX - h;
    if (dirtLo && dirtHi) {
      // Both sides Solid: fit between them if possible, else center the axis
      // (containedScale below shrinks symmetrically from there).
      if (lo > hi) return tile * TILE_SIZE_PX + TILE_SIZE_PX / 2;
      return Math.min(Math.max(c, lo), hi);
    }
    if (dirtLo) return Math.max(c, lo);
    if (dirtHi) return Math.min(c, hi);
    return c;
  };
  const nx = nudgeAxis(
    cxPx,
    tileX,
    hx,
    isDirt(grid, tileX - 1, tileY),
    isDirt(grid, tileX + 1, tileY),
  );
  const ny = nudgeAxis(
    cyPx,
    tileY,
    hy,
    isDirt(grid, tileX, tileY - 1),
    isDirt(grid, tileX, tileY + 1),
  );
  return {
    cxPx: nx,
    cyPx: ny,
    scale: containedScale(grid, nx, ny, spriteW, spriteH, rotation, desiredScale),
  };
}

/** Containment-invariant predicate (for the probe): does the rotated AABB of a
 *  `w`×`h` sprite at `scale`/`rotation`, centered at (cxPx,cyPx), overlap ANY
 *  Solid/off-grid tile? A clamped sprite must make this false. A tiny epsilon
 *  absorbs float rounding at the exact tile boundary. */
export function aabbOverlapsDirt(
  grid: UndergroundGrid,
  cxPx: number,
  cyPx: number,
  w: number,
  h: number,
  rotation: number,
  scale: number,
): boolean {
  const { hx, hy } = rotatedAabbHalfExtents(w, h, rotation, scale);
  const eps = 1e-6;
  const minTileX = Math.floor((cxPx - hx + eps) / TILE_SIZE_PX);
  const maxTileX = Math.floor((cxPx + hx - eps) / TILE_SIZE_PX);
  const minTileY = Math.floor((cyPx - hy + eps) / TILE_SIZE_PX);
  const maxTileY = Math.floor((cyPx + hy - eps) / TILE_SIZE_PX);
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      if (isDirt(grid, tx, ty)) return true;
    }
  }
  return false;
}
