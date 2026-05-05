// chamber-shape.ts — #97 organic chamber walls.
//
// Pure helpers for deterministic per-chamber rendering geometry. Render-only:
// no Phaser, no Math.random, no floats. The simulation footprint stays
// rectangular (CHAMBER_DIMENSIONS); these helpers only shape what the player
// sees, so adjacent chambers don't all look identical and corners are softened
// from the strict tile-grid rectangle to a hand-carved rounded look.
//
// Determinism: a chamber's identity (colonyId, chamberId, chamberType) is
// stable across ticks and across save/reload, so the same chamber renders
// with the same corner radius each frame. No persisted shape state.

const HASH_MIX_A = 0x85ebca6b;
const HASH_MIX_B = 0xc2b2ae35;
const HASH_MIX_C = 0x27d4eb2f;

/**
 * 32-bit integer hash from a chamber's identity. Deterministic, integer-only,
 * stable across runs and reloads. Returned as a non-negative 32-bit value.
 */
export function chamberSeed(colonyId: number, chamberId: number, chamberType: number): number {
  let h = Math.imul(colonyId | 0, HASH_MIX_A);
  h ^= Math.imul(chamberId | 0, HASH_MIX_B);
  h ^= Math.imul(chamberType | 0, HASH_MIX_C);
  h ^= h >>> 16;
  h = Math.imul(h, HASH_MIX_A);
  h ^= h >>> 13;
  return h >>> 0;
}

export const CHAMBER_CORNER_RADIUS_MIN = 3;
export const CHAMBER_CORNER_RADIUS_RANGE = 4; // chooses MIN .. MIN + RANGE - 1

/**
 * Per-chamber corner radius in pixels. Nominal range is
 * [CHAMBER_CORNER_RADIUS_MIN, CHAMBER_CORNER_RADIUS_MIN +
 * CHAMBER_CORNER_RADIUS_RANGE - 1] inclusive — uses `%` so any positive
 * RANGE works (don't rely on RANGE being a power of two).
 *
 * Capped at floor(min(boundingW, boundingH) / 2) so very small chambers
 * can't end up with a radius that exceeds their half-extent and produces
 * a malformed shape. For current chamber sizes (Queen 80×48, Nursery /
 * FoodStorage 64×48 at TILE_SIZE_PX=16) the cap is far above the nominal
 * band, so the cap is purely defensive against future small chambers.
 *
 * Lower bound of 1 means the fillCircle corners always paint something,
 * so degenerate-tiny chambers still draw a coherent shape.
 */
export function chamberCornerRadius(seed: number, boundingW: number, boundingH: number): number {
  const requested = CHAMBER_CORNER_RADIUS_MIN + (seed % CHAMBER_CORNER_RADIUS_RANGE);
  const halfMin = Math.min(boundingW, boundingH) >> 1;
  return Math.max(1, Math.min(requested, halfMin));
}
