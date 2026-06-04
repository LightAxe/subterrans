// src/sim/tile-key.ts — shared per-tile key encoding (Phase 9).
//
// Used by combat.ts (detect same-tile same-zone collisions) and any future
// subsystem that needs a single integer identifying a (zone, tileX, tileY)
// triple. Phase 09.1 Chunk 4 (plan 09.1-04) extends this to separate
// underground ants by their grid-of-occupancy so same-(tileX,tileY) ants in
// DIFFERENT underground grids (player grid vs enemy grid) do NOT bucket
// together. Surface keys are byte-identical to Phase 9 pre-extension.
//
// Encoding (32-bit int, little-endian semantics):
//   bits 24-31 : zone (0 = Surface, 1 = Underground)
//   bits 16-23 : gridColonyId (0 for Surface / same-grid; owning colony id for
//                Underground — drives the grid-of-occupancy separation)
//   bits 0-15  : tileY * GRID_WIDTH + tileX
//
// Invariants:
//   - Surface keys are unchanged — gridByte is always 0 when zone===Surface.
//   - gridColonyId defaults to 0, so call sites that haven't been updated to
//     pass the 4th arg produce identical keys as before (safe migration).
//   - Call sites that pass the ant's currentGridColonyId work identically for
//     same-grid Underground ants (gridByte stable for same-grid cohabitants)
//     and correctly SEPARATE cross-grid ants at the same (tileX, tileY).
//
// GRID_WIDTH = 128 for BOTH surface and underground (constants.ts:115, 121).
// If that invariant ever changes, THIS module must switch to per-zone strides
// and every call site becomes a single-file audit.
//
// Pure-sim: no Phaser, no DOM, no Math.*, zero allocation.

import { Zone } from './terrain.js';
import { SURFACE_GRID_WIDTH } from './constants.js';
import type { ColonyId } from './colony/colony-store.js';

/** Tile-key stride. See module header re: surface/underground parity. */
const TILE_KEY_STRIDE = SURFACE_GRID_WIDTH;

/**
 * Encode (zone, tileX, tileY, gridColonyId) as a single int32 key.
 *
 * Callers MUST pass in-range coordinates; this module does not clamp.
 *
 * @param zone         - Zone.Surface (0) or Zone.Underground (1)
 * @param tileX        - integer tile X (0 .. GRID_WIDTH-1)
 * @param tileY        - integer tile Y (0 .. GRID_HEIGHT-1)
 * @param gridColonyId - (Underground only) the owning colony of the
 *                       underground grid this ant occupies. Default 0 keeps
 *                       Surface keys byte-identical to pre-Chunk-4 behavior
 *                       and lets un-updated call sites compile unchanged.
 */
export function makeTileKey(
  zone: Zone,
  tileX: number,
  tileY: number,
  gridColonyId: ColonyId = 0,
): number {
  const gridByte = zone === Zone.Underground ? gridColonyId & 0xff : 0;
  return (
    ((zone & 0xff) << 24) | (gridByte << 16) | ((tileY * TILE_KEY_STRIDE + tileX) & 0xffff) | 0
  );
}
