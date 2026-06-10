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
 *  render as carved space, so overflow into them is allowed.) */
function isDirt(grid: UndergroundGrid, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= grid.width || tileY >= grid.height) return true;
  return ugGet(grid, tileX, tileY) === UndergroundTileState.Solid;
}

/**
 * Largest scale ≤ `desiredScale` such that the sprite's rotated AABB, centered at
 * pixel (cxPx, cyPx) in underground-grid space, does not cross the anchor tile's
 * boundary toward any Solid/off-grid neighbour — i.e. its drawn footprint stays
 * within the union of the anchor tile and its PASSABLE neighbours.
 *
 * Cardinal Solid neighbours clamp the extent toward them to the tile-edge
 * distance exactly; a Solid diagonal clamps BOTH extents toward that corner
 * (conservative — it may shrink slightly more than strictly required for a
 * corner-only obstruction, but never paints dirt and never shrinks below what a
 * Solid cardinal already demands). The anchor tile is assumed walkable (callers
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
  if (isDirt(grid, tileX - 1, tileY)) clampX(edgeW);
  if (isDirt(grid, tileX + 1, tileY)) clampX(edgeE);
  if (isDirt(grid, tileX, tileY - 1)) clampY(edgeN);
  if (isDirt(grid, tileX, tileY + 1)) clampY(edgeS);
  if (isDirt(grid, tileX - 1, tileY - 1)) {
    clampX(edgeW);
    clampY(edgeN);
  }
  if (isDirt(grid, tileX + 1, tileY - 1)) {
    clampX(edgeE);
    clampY(edgeN);
  }
  if (isDirt(grid, tileX - 1, tileY + 1)) {
    clampX(edgeW);
    clampY(edgeS);
  }
  if (isDirt(grid, tileX + 1, tileY + 1)) {
    clampX(edgeE);
    clampY(edgeS);
  }
  if (factor >= 1) return desiredScale;
  return Math.max(0, desiredScale * factor);
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
