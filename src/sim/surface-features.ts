// surface-features.ts — sim-owned multi-tile surface decoration selector.
//
// Decides where boulders, bushes, grass clumps (and the larger ant-scale
// variants added in issue #44 step 3) anchor on the surface grid. Mirrors
// what was previously computed render-side in terrain-atlas.ts, but:
//
//   1. Selection mixes in WorldState.terrainSeed so different game seeds
//      produce different surface layouts. Pre-#44 placement was coordinate-
//      only — every world looked identical from above.
//   2. The selection metadata is sim-side state. Surface movement code
//      (added in step 4) reads passability and movement cost from here
//      without crossing the sim/render boundary.
//   3. Critical tiles (within an entrance suppression radius, on a food
//      pile) are blocked so seed luck cannot spawn a hard-block boulder
//      in the player's doorway.
//
// Pure functions: no PRNG state, no clock, no Math.random, no floats. Same
// inputs → same outputs forever (FNDN-04 / SCEN-06).
//
// Render reads via `surfaceFeatureAt(world, tileX, tileY)` and maps
// `(kind, variantIndex)` to pixel art. Movement reads via
// `surfaceMovementAt(world, tileX, tileY)` for passability + step cost.

import type { WorldState } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Categories of multi-tile surface feature. Step 3 of issue #44 added the
 * ant-scale variants (Twig/Leaf/BigLeaf) on top of the original three
 * (Boulder/Bush/GrassClump). New kinds land here, with sprite art keyed
 * off `(kind, variantIndex)` in render's SURFACE_FEATURE_SPRITES map.
 *
 * Numeric values are stable — they're stored on `SurfaceFeatureSlice` and
 * could theoretically appear in saved snapshots if a future step caches
 * selector output. Don't reorder.
 */
export const SurfaceFeatureKind = {
  Boulder:    0,
  Bush:       1,
  GrassClump: 2,
  Twig:       3,  // 4×2 fallen-twig log — HardBlock
  Leaf:       4,  // 3×3 dead leaf — HardBlock
  BigLeaf:    5,  // 3×4 large dead leaf "ship" — HardBlock
} as const;
export type SurfaceFeatureKind = typeof SurfaceFeatureKind[keyof typeof SurfaceFeatureKind];

/**
 * How a feature affects ant movement on the tiles it covers.
 *
 *   - Cosmetic: walks through, no effect. Reserved for the small per-tile
 *     motifs (pebbles, seeds, single grass tufts) that still live render-side
 *     and are never returned by this selector — included in the enum so
 *     `surfaceMovementAt` can use it as the "no feature here" sentinel.
 *   - SoftCost: walks through, slowed (grass clumps; bushes for now). Step 5
 *     of issue #44 plumbs the actual cost.
 *   - HardBlock: cannot enter (boulders, twig-as-log, leaf-as-ship once they
 *     ship in step 3). Step 4 of issue #44 wires the passability guard.
 */
export const SurfaceMovementEffect = {
  Cosmetic:  0,
  SoftCost:  1,
  HardBlock: 2,
} as const;
export type SurfaceMovementEffect = typeof SurfaceMovementEffect[keyof typeof SurfaceMovementEffect];

/**
 * What `surfaceFeatureAt` returns for a covered tile. Identifies which
 * feature anchor covers the queried tile plus enough metadata for render
 * and movement to act without recomputing.
 */
export interface SurfaceFeatureSlice {
  kind:               SurfaceFeatureKind;
  variantIndex:       number;  // 0..(registry entry's variantCount - 1)
  anchorX:            number;  // upper-left tile of the feature's footprint
  anchorY:            number;
  footprintTilesWide: number;  // copy of the registry value for caller convenience
  footprintTilesTall: number;
  movement:           SurfaceMovementEffect;
}

// ---------------------------------------------------------------------------
// Registry — single source of truth for kinds, footprints, and movement.
// Render imports kind→sprite mappings from here (step 2); movement imports
// movement effects (step 4/5).
// ---------------------------------------------------------------------------

interface SurfaceFeatureRegistryEntry {
  kind: SurfaceFeatureKind;
  /**
   * Anchor probability hash salt. Distinct per kind so two decision channels
   * never accidentally land on the same value. The rendered sprites must use
   * the same kind→salt mapping (enforced by the kind→sprite map in render).
   */
  salt: number;
  /** Per-tile anchor probability in 0..255 (e.g. 6 = ~2.3% of tiles host an anchor). */
  probability: number;
  footprintTilesWide: number;
  footprintTilesTall: number;
  /**
   * Number of distinct sprite variants the renderer may pick from. Selector
   * picks one deterministically per (anchorX, anchorY) hash so the world
   * doesn't read as one cloned sprite across the map.
   */
  variantCount: number;
  movement: SurfaceMovementEffect;
}

// Registry order doubles as cross-type priority. Earlier entries suppress
// later entries when their footprints overlap (mirrors PR #41 contract).
//
// Issue #44 step 3 + step 4:
//   - All previously-existing kinds bumped to 3×3 footprints with 3 variants
//     each so they read as imposing at ant scale. Probabilities tuned twice:
//     once for the larger footprints (more tile coverage per anchor → fewer
//     anchors), then again in step 4 once movement actually started honoring
//     HardBlock — sparse hard-block coverage (~3–5% of tiles after
//     suppression) keeps forager throughput acceptable while still feeling
//     substantial visually.
//   - New kinds Twig (4×2), Leaf (3×3), BigLeaf (3×4) added. All HardBlock.
//   - Salts 151..156 reserved for surface feature anchor channels.
//   - Priority: HardBlock kinds win over SoftCost. Among HardBlocks: Boulder
//     > Twig > Leaf > BigLeaf (rarer/larger features yield to more common
//     smaller ones to avoid one BigLeaf wiping out a region's variety).
const SURFACE_FEATURES: ReadonlyArray<SurfaceFeatureRegistryEntry> = [
  {
    kind: SurfaceFeatureKind.Boulder,
    salt: 151,
    probability: 2,                    // ~0.8% — substantial, sparse
    footprintTilesWide: 3,
    footprintTilesTall: 3,
    variantCount: 3,                    // round / flat / lichen
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.Twig,
    salt: 154,
    probability: 1,                    // ~0.4% — fallen twig (4×2 = 8 tiles)
    footprintTilesWide: 4,
    footprintTilesTall: 2,             // long horizontal fallen-twig silhouette
    variantCount: 2,                    // smooth / bark
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.Leaf,
    salt: 155,
    probability: 1,                    // ~0.4%
    footprintTilesWide: 3,
    footprintTilesTall: 3,
    variantCount: 3,                    // broad / curled / torn
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.BigLeaf,
    salt: 156,
    probability: 1,                    // ~0.4% — the rare ship-canopy anchor
    footprintTilesWide: 3,
    footprintTilesTall: 4,             // vertical orientation
    variantCount: 2,                    // broad / torn
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.Bush,
    salt: 152,
    probability: 6,                    // ~2.3% — wildflower/clover clump
    footprintTilesWide: 3,
    footprintTilesTall: 3,
    variantCount: 3,                    // clover / flower / dense
    // A bush at ant scale reads as dense vegetation an ant pushes through,
    // not a solid wall. SoftCost; step 5 wires the actual cost.
    movement: SurfaceMovementEffect.SoftCost,
  },
  {
    kind: SurfaceFeatureKind.GrassClump,
    salt: 153,
    probability: 10,                   // ~3.9% — most common, vertical-bias spikes
    footprintTilesWide: 3,
    footprintTilesTall: 3,
    variantCount: 3,                    // dense / sparse / tilted
    movement: SurfaceMovementEffect.SoftCost,
  },
];

// Boot-time integrity check: the registry must be self-consistent or the
// selector will silently misbehave. Surface bugs at module-load time so
// nobody ships a bad registry.
for (let i = 0; i < SURFACE_FEATURES.length; i++) {
  const e = SURFACE_FEATURES[i]!;
  if (e.variantCount <= 0) {
    throw new Error(`SURFACE_FEATURES[${i}]: variantCount must be > 0`);
  }
  if (e.footprintTilesWide <= 0 || e.footprintTilesTall <= 0) {
    throw new Error(`SURFACE_FEATURES[${i}]: footprint dimensions must be > 0`);
  }
  if (e.probability < 0 || e.probability > 255) {
    throw new Error(`SURFACE_FEATURES[${i}]: probability must be 0..255`);
  }
}

// Cross-entry maximum span — bounds the anchor-candidate scan window. A tile
// (X, Y) can be covered by any anchor in the (MAX_W × MAX_H) window above-
// left of it; nothing further away can reach.
let _maxW = 0;
let _maxH = 0;
for (const e of SURFACE_FEATURES) {
  if (e.footprintTilesWide > _maxW) _maxW = e.footprintTilesWide;
  if (e.footprintTilesTall > _maxH) _maxH = e.footprintTilesTall;
}
const MAX_FEATURE_TILES_WIDE = _maxW;
const MAX_FEATURE_TILES_TALL = _maxH;

/**
 * Lookup helper for render (step 2). Returns the registry entry for a kind so
 * the renderer can pick the correct sprite for a given variantIndex.
 *
 * Returns null for unknown kinds rather than throwing — callers that decode
 * a snapshot from a future sim version with new kinds shouldn't crash.
 */
export function getSurfaceFeatureRegistryEntry(kind: SurfaceFeatureKind): {
  readonly footprintTilesWide: number;
  readonly footprintTilesTall: number;
  readonly variantCount: number;
  readonly movement: SurfaceMovementEffect;
} | null {
  for (const e of SURFACE_FEATURES) {
    if (e.kind === kind) {
      return {
        footprintTilesWide: e.footprintTilesWide,
        footprintTilesTall: e.footprintTilesTall,
        variantCount: e.variantCount,
        movement: e.movement,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gameplay suppression — keep features off critical tiles
// ---------------------------------------------------------------------------

/**
 * Chebyshev-distance radius around every entrance within which feature
 * anchors are suppressed. Picked at 3 to give the queen and starting
 * workers roughly half a screen of clear ground in any direction. Smaller
 * (1..2) leaves grass claustrophobic right at the doorway; larger (5+)
 * starts to dominate the visible surface.
 *
 * Applied to ALL features in this selector — both HardBlock and SoftCost.
 * HardBlock suppression is mandatory (seed luck could otherwise box in the
 * queen on tick 0); SoftCost suppression is a polish call (grass right on
 * the doorstep would feel weird visually too).
 */
export const SURFACE_FEATURE_ENTRANCE_RADIUS = 3 as const;

/**
 * True if the candidate anchor's footprint overlaps any entrance suppression
 * radius or any food pile tile.
 *
 * Walks every colony's entrances and the food-pile array. Cost is bounded
 * by colony-count × entrance-count + food-pile-count, which the scenario
 * keeps small (typical: ≤4 colonies × ≤4 entrances + ~10 food piles).
 */
function isAnchorGameplaySuppressed(
  world: WorldState,
  anchorX: number,
  anchorY: number,
  footprintW: number,
  footprintH: number,
): boolean {
  const fx0 = anchorX;
  const fy0 = anchorY;
  const fx1 = anchorX + footprintW - 1;
  const fy1 = anchorY + footprintH - 1;

  // Entrances — Chebyshev-radius rectangle overlap. Footprint overlaps
  // (ex - r .. ex + r, ey - r .. ey + r) iff both axes overlap.
  const r = SURFACE_FEATURE_ENTRANCE_RADIUS;
  for (const cidStr in world.colonies) {
    const colony = world.colonies[cidStr as unknown as number]!;
    // The Phase 3 PRD §2a contract requires the caller to initialize
    // `entrances` after createColonyRecord, but several pre-#44 tests
    // create a colony without that init because their code path never
    // reads it. Be defensive — undefined → "no entrances to suppress
    // around" rather than a TypeError that breaks unrelated tests.
    const entrances = colony.entrances;
    if (entrances === undefined) continue;
    for (let i = 0; i < entrances.length; i++) {
      const e = entrances[i]!;
      const ex = e.surfaceTileX;
      const ey = e.surfaceTileY;
      if (fx1 >= ex - r && fx0 <= ex + r && fy1 >= ey - r && fy0 <= ey + r) {
        return true;
      }
    }
  }

  // Food piles — Chebyshev-radius rectangle overlap (same r as entrances).
  // Pre-#44 step 4 this was an exact-tile check; once movement honors
  // HardBlock features, foragers need a clear approach corridor or they
  // can't deposit pheromone trails to the pile and the colony starves.
  const piles = world.foodPiles;
  for (let i = 0; i < piles.length; i++) {
    const p = piles[i]!;
    if (fx1 >= p.tileX - r && fx0 <= p.tileX + r && fy1 >= p.tileY - r && fy0 <= p.tileY + r) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Spatial hash — same MurmurHash3-style mixer as render-side terrain-noise.ts
// but with terrainSeed folded in. Lives here in sim because src/render/
// cannot be imported from src/sim/, and the render hash stays unchanged for
// substrate dithering / specks where terrainSeed mixing isn't needed.
// ---------------------------------------------------------------------------

/**
 * Deterministic per-tile hash, same constants as render-side `spatialHash`
 * but with the terrain seed XOR'd into the salt input. Same `(tileX, tileY,
 * salt, terrainSeed)` always returns the same uint32. XOR keeps the existing
 * salt namespace meaningful while letting different seeds produce different
 * anchor positions.
 */
function tileHash(tileX: number, tileY: number, salt: number, terrainSeed: number): number {
  let h = (
    tileX * 374761393 +
    tileY * 668265263 +
    (salt ^ terrainSeed) * 2246822519
  ) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Anchor overlap suppression — same logic as the previous render-side
// `isAnchorSuppressed` (cross-type by priority + same-type upper-leftmost
// wins, recursive into is-real-render check). With terrainSeed mixing.
// ---------------------------------------------------------------------------

function isAnchorSuppressedByOverlap(
  ax: number,
  ay: number,
  ownEntryIndex: number,
  terrainSeed: number,
): boolean {
  const own = SURFACE_FEATURES[ownEntryIndex]!;
  const ownW = own.footprintTilesWide;
  const ownH = own.footprintTilesTall;

  // Cross-type: any higher-priority feature whose footprint overlaps suppresses.
  for (let ei = 0; ei < ownEntryIndex; ei++) {
    const entry = SURFACE_FEATURES[ei]!;
    const W = entry.footprintTilesWide;
    const H = entry.footprintTilesTall;
    for (let py = ay - H + 1; py <= ay + ownH - 1; py++) {
      for (let px = ax - W + 1; px <= ax + ownW - 1; px++) {
        const ph = tileHash(px, py, entry.salt, terrainSeed);
        if ((ph & 0xff) >= entry.probability) continue;
        // Only count (px, py) as a real suppressor if it itself renders.
        // A higher-priority anchor that's suppressed by an even-higher-
        // priority one shouldn't block lower-priority anchors. Recursion
        // terminates because every call strictly reduces ownEntryIndex
        // (this branch) or reduces (ay, ax) lex order (the same-type branch).
        if (!isAnchorSuppressedByOverlap(px, py, ei, terrainSeed)) return true;
      }
    }
  }

  // Same-type: any upper-left anchor of THIS type that covers (ax, ay) suppresses.
  for (let dy = 0; dy < ownH; dy++) {
    for (let dx = 0; dx < ownW; dx++) {
      if (dx === 0 && dy === 0) continue;
      const px = ax - dx;
      const py = ay - dy;
      const ph = tileHash(px, py, own.salt, terrainSeed);
      if ((ph & 0xff) >= own.probability) continue;
      if (!isAnchorSuppressedByOverlap(px, py, ownEntryIndex, terrainSeed)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Returns the surface feature slice covering (tileX, tileY), or null if no
 * registered feature anchors at any candidate position above-left of this
 * tile and survives both overlap suppression and gameplay suppression.
 *
 * Resolution rules in order:
 *   1. Walk every (ax, ay) in the [tileX − MAX_W + 1 .. tileX] ×
 *      [tileY − MAX_H + 1 .. tileY] window above-left.
 *   2. For each candidate, walk SURFACE_FEATURES and pick the first entry
 *      whose footprint covers (tileX, tileY) and whose anchor probability
 *      admits.
 *   3. Reject the candidate if it's overlap-suppressed (cross-type priority
 *      + same-type upper-leftmost) or gameplay-suppressed (entrance radius
 *      / food pile).
 *   4. Among surviving candidates, pick the upper-leftmost (lex-smallest
 *      `(ay, ax)`). This matches the render-side `drawLargeFeatureSliceIfAny`
 *      tie-break so step 2's render refactor can produce identical pixels.
 *
 * Pure: never mutates `world`. Cost is bounded by MAX_W × MAX_H × kinds ×
 * gameplay-suppression cost (small constants for typical scenarios).
 */
export function surfaceFeatureAt(
  world: WorldState,
  tileX: number,
  tileY: number,
): SurfaceFeatureSlice | null {
  const terrainSeed = world.terrainSeed;
  let bestAx = 0;
  let bestAy = 0;
  let bestEntryIndex = -1;
  let bestVariantIndex = 0;

  for (let dy = 0; dy < MAX_FEATURE_TILES_TALL; dy++) {
    for (let dx = 0; dx < MAX_FEATURE_TILES_WIDE; dx++) {
      const ax = tileX - dx;
      const ay = tileY - dy;
      for (let ei = 0; ei < SURFACE_FEATURES.length; ei++) {
        const entry = SURFACE_FEATURES[ei]!;
        if (dx >= entry.footprintTilesWide || dy >= entry.footprintTilesTall) continue;
        const h = tileHash(ax, ay, entry.salt, terrainSeed);
        if ((h & 0xff) >= entry.probability) continue;
        if (isAnchorSuppressedByOverlap(ax, ay, ei, terrainSeed)) {
          break;
        }
        if (isAnchorGameplaySuppressed(world, ax, ay, entry.footprintTilesWide, entry.footprintTilesTall)) {
          break;
        }
        if (
          bestEntryIndex < 0 ||
          ay < bestAy ||
          (ay === bestAy && ax < bestAx)
        ) {
          bestAx = ax;
          bestAy = ay;
          bestEntryIndex = ei;
          bestVariantIndex = (h >>> 8) % entry.variantCount;
        }
        break;
      }
    }
  }

  if (bestEntryIndex < 0) return null;
  const entry = SURFACE_FEATURES[bestEntryIndex]!;
  return {
    kind: entry.kind,
    variantIndex: bestVariantIndex,
    anchorX: bestAx,
    anchorY: bestAy,
    footprintTilesWide: entry.footprintTilesWide,
    footprintTilesTall: entry.footprintTilesTall,
    movement: entry.movement,
  };
}

/**
 * Convenience helper for surface movement code (step 4/5). Returns the
 * movement effect of any feature covering this tile, or `Cosmetic` if no
 * feature is present (i.e. ant walks freely with no cost).
 */
export function surfaceMovementAt(
  world: WorldState,
  tileX: number,
  tileY: number,
): SurfaceMovementEffect {
  const slice = surfaceFeatureAt(world, tileX, tileY);
  return slice === null ? SurfaceMovementEffect.Cosmetic : slice.movement;
}
