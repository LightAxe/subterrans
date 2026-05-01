// underground-neighbors.ts — issue #43 Checkpoint 1.
//
// Pure neighbor classifier for the underground autotiling renderer. Given an
// UndergroundGrid + ceiling-entrance set, classifies any (tx, ty) — including
// out-of-bounds — as either 'wall' or 'open' for autotile shape purposes.
//
// Open includes: Open, Marked, BeingDug. Marked and BeingDug count as open so
// the autotile silhouette previews the final tunnel shape; the existing tint
// overlays on those tiles still communicate the queued/in-progress state.
//
// Wall includes: Solid, out-of-bounds, ceiling row (ty=0) except at entrance
// columns. The ceiling-row carve-out matches the existing entrance-gap rule
// in draw-underground.ts so the autotiler classifies the ceiling above the
// entrance shaft as 'open' (so the ant tunnel reads as continuous up to the
// surface), while the rest of the ceiling reads as 'wall'.
//
// Render-only — no sim mutation, no simVersion bump.

import { ugGet, UndergroundTileState } from '../sim/terrain.js';
import type { UndergroundGrid } from '../sim/terrain.js';

export type NeighborKind = 'wall' | 'open';

/**
 * 3x3 neighborhood centered on a tile. Field names use compass shorthand:
 * nw/n/ne, w/c/e, sw/s/se. `c` is the classification of the center tile
 * itself, included so callers can drive shape decisions off the same struct.
 */
export interface Neighbors3x3 {
  nw: NeighborKind; n: NeighborKind; ne: NeighborKind;
  w:  NeighborKind; c: NeighborKind; e:  NeighborKind;
  sw: NeighborKind; s: NeighborKind; se: NeighborKind;
}

/**
 * Classify a single underground tile as 'wall' or 'open' for autotile shape.
 *
 * The classification is the same one `draw-underground.ts` already used for
 * its `isWallNeighbor` predicate — just lifted into a reusable function.
 *
 * @param entranceXSet — surfaceTileX positions for the viewed colony's
 *   entrances. Used to carve open gaps in the ceiling row.
 */
export function classifyUndergroundTile(
  grid: UndergroundGrid,
  tx: number,
  ty: number,
  entranceXSet: ReadonlySet<number>,
): NeighborKind {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return 'wall';
  if (ty === 0) return entranceXSet.has(tx) ? 'open' : 'wall';
  return ugGet(grid, tx, ty) === UndergroundTileState.Solid ? 'wall' : 'open';
}

/**
 * Gather a 3x3 neighborhood of wall/open classifications around (tx, ty).
 * The center cell (`c`) is also classified; the autotiler uses it together
 * with the cardinal neighbors to pick quarter-tile shapes for each corner.
 */
export function gatherUnderground3x3Neighbors(
  grid: UndergroundGrid,
  tx: number,
  ty: number,
  entranceXSet: ReadonlySet<number>,
): Neighbors3x3 {
  return {
    nw: classifyUndergroundTile(grid, tx - 1, ty - 1, entranceXSet),
    n:  classifyUndergroundTile(grid, tx,     ty - 1, entranceXSet),
    ne: classifyUndergroundTile(grid, tx + 1, ty - 1, entranceXSet),
    w:  classifyUndergroundTile(grid, tx - 1, ty,     entranceXSet),
    c:  classifyUndergroundTile(grid, tx,     ty,     entranceXSet),
    e:  classifyUndergroundTile(grid, tx + 1, ty,     entranceXSet),
    sw: classifyUndergroundTile(grid, tx - 1, ty + 1, entranceXSet),
    s:  classifyUndergroundTile(grid, tx,     ty + 1, entranceXSet),
    se: classifyUndergroundTile(grid, tx + 1, ty + 1, entranceXSet),
  };
}
