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
  Boulder: 0,
  Bush: 1,
  GrassClump: 2,
  Twig: 3, // 4×2 fallen-twig log — HardBlock
  Leaf: 4, // 3×3 dead leaf — HardBlock
  BigLeaf: 5, // 3×4 large dead leaf "ship" — HardBlock
} as const;
export type SurfaceFeatureKind = (typeof SurfaceFeatureKind)[keyof typeof SurfaceFeatureKind];

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
  Cosmetic: 0,
  SoftCost: 1,
  HardBlock: 2,
} as const;
export type SurfaceMovementEffect =
  (typeof SurfaceMovementEffect)[keyof typeof SurfaceMovementEffect];

/**
 * What `surfaceFeatureAt` returns for a covered tile. Identifies which
 * feature anchor covers the queried tile plus enough metadata for render
 * and movement to act without recomputing.
 */
export interface SurfaceFeatureSlice {
  kind: SurfaceFeatureKind;
  variantIndex: number; // 0..(registry entry's variantCount - 1)
  anchorX: number; // upper-left tile of the feature's footprint
  anchorY: number;
  footprintTilesWide: number; // copy of the registry value for caller convenience
  footprintTilesTall: number;
  movement: SurfaceMovementEffect;
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
// Issue #44 step 3 + step 4 + UAT rounds 1 + 2:
//   - All kinds use 4×4 (or larger) footprints — bumped from 3×3 in UAT
//     round 1 after feedback that 3×3 sprites read too small for
//     "Honey I Shrunk the Kids" scale.
//   - UAT round 2: cut overall density ~50% by widening the per-tile
//     probability bucket from 256 to 512. The anchor hash check uses
//     `(hash & 0x1ff) < probability` so each unit of `probability` now
//     means `1/512` per-tile chance instead of `1/256`. Same per-kind
//     `probability` integers, half the spawn rate.
//   - Net post-suppression coverage at the new bucket: ~1.5% HardBlock
//     + ~5% SoftCost — substantial visually without choking foragers.
//   - Salts 151..156 reserved for surface feature anchor channels.
//   - Priority: HardBlock kinds win over SoftCost. Among HardBlocks: Boulder
//     > Twig > Leaf > BigLeaf (rarer/larger features yield to more common
//     smaller ones to avoid one BigLeaf wiping out a region's variety).
const SURFACE_FEATURES: ReadonlyArray<SurfaceFeatureRegistryEntry> = [
  {
    kind: SurfaceFeatureKind.Boulder,
    salt: 151,
    probability: 1, // ~0.4% per tile (~16 anchors / 1000 tiles × 16-tile fp ≈ 6% pre-supp)
    footprintTilesWide: 4,
    footprintTilesTall: 4, // 64×64 px — substantial ant-scale boulder
    variantCount: 3, // round / flat / lichen
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.Twig,
    salt: 154,
    probability: 1, // ~0.4% — fallen twig (6×3 = 18 tiles)
    footprintTilesWide: 6,
    footprintTilesTall: 3, // 96×48 px — long horizontal log
    variantCount: 2, // smooth / bark
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.Leaf,
    salt: 155,
    probability: 1, // ~0.4%
    footprintTilesWide: 4,
    footprintTilesTall: 4, // 64×64 px
    variantCount: 3, // broad / curled / torn
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.BigLeaf,
    salt: 156,
    probability: 1, // ~0.4% — the rare ship-canopy anchor
    footprintTilesWide: 5,
    footprintTilesTall: 6, // 80×96 px — ant-scale "ship"
    variantCount: 2, // broad / torn
    movement: SurfaceMovementEffect.HardBlock,
  },
  {
    kind: SurfaceFeatureKind.Bush,
    salt: 152,
    probability: 3, // ~1.2% — wildflower/clover clump
    footprintTilesWide: 4,
    footprintTilesTall: 4, // 64×64 px
    variantCount: 3, // clover / flower / dense
    // A bush at ant scale reads as dense vegetation an ant pushes through,
    // not a solid wall. SoftCost; step 5 wires the actual cost.
    movement: SurfaceMovementEffect.SoftCost,
  },
  {
    kind: SurfaceFeatureKind.GrassClump,
    salt: 153,
    probability: 5, // ~2.0% — most common, vertical-bias spikes
    footprintTilesWide: 4,
    footprintTilesTall: 4, // 64×64 px
    variantCount: 3, // dense / sparse / tilted
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
  // PR 4 carve-detection precondition: `surfaceFeatureAt` infers "this feature
  // was carved passable" from `baked[idx] !== proc.movement` (carving sets the
  // baked effect to Cosmetic). That proxy is only sound while NO registry
  // feature has Cosmetic movement — otherwise a carved tile's baked Cosmetic
  // would equal the feature's own Cosmetic movement, the feature would NOT be
  // suppressed, and the renderer would paint a sprite over a carved-passable
  // tile (violating R4-3). Enforce the precondition here so a future Cosmetic
  // feature fails loudly at boot instead of silently breaking the carve.
  if (e.movement === SurfaceMovementEffect.Cosmetic) {
    throw new Error(
      `SURFACE_FEATURES[${i}]: movement must not be Cosmetic — it breaks PR 4 carve detection in surfaceFeatureAt`,
    );
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
// PR 4 — dynamic gameplay suppression DELETED. Terrain is now frozen at
// world-gen (see bakeStaticTerrain below); the old entrance/food-pile
// suppression halo that flipped terrain as piles depleted / entrances were
// designated is replaced by the reachable-spawn + connectivity invariants
// (placement only on already-walkable, in-component tiles) plus a static
// per-root clearance carve. `SURFACE_FEATURE_ENTRANCE_RADIUS` and
// `isAnchorGameplaySuppressed` are gone.
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
  let h = (tileX * 374761393 + tileY * 668265263 + (salt ^ terrainSeed) * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Anchor overlap suppression — same logic as the previous render-side
// `isAnchorSuppressed` (cross-type by priority + same-type upper-leftmost
// wins, recursive into is-real-render check). With terrainSeed mixing.
//
// Real-render check (v8+): rejects both overlap-suppressed (recursive) AND
// gameplay-suppressed (entrance/food zone) shadowers. Pre-v8 only checked
// overlap-suppression — a higher-priority anchor inside a suppression zone
// would never render but would still suppress lower-priority anchors
// outside the zone, producing unintended empty halos. v8+ closes that gap
// (Codex P2 on PR #49 round 3); pre-v8 saves replay with the original
// terrain layout for byte-identity (SCEN-06).
// ---------------------------------------------------------------------------

/**
 * @param world         only threaded through to the recursive
 *                      `isAnchorSuppressedByOverlap` calls below; no field of it
 *                      is read here. (It formerly gated the deleted
 *                      `isAnchorGameplaySuppressed` check — PR 4 removed dynamic
 *                      entrance/food-pile suppression, so terrain no longer
 *                      depends on world state, but the param is kept to avoid
 *                      churning every caller's signature.)
 */
function isAnchorSuppressedByOverlap(
  world: WorldState,
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
        if ((ph & 0x1ff) >= entry.probability) continue;
        // Only count (px, py) as a real suppressor if it itself renders.
        // Recursion terminates because every recursive call strictly
        // reduces ownEntryIndex (this branch) or reduces (ay, ax) lex
        // order (the same-type branch).
        if (isAnchorSuppressedByOverlap(world, px, py, ei, terrainSeed)) continue;
        return true;
      }
    }
  }

  // Same-type: any same-type anchor whose footprint OVERLAPS this anchor's
  // footprint suppresses, where lex-smaller `(anchorY, anchorX)` wins.
  //
  // Issue #44 UAT round 1 fix: the previous "upper-left only" check
  // (window restricted to dx, dy ∈ [0, ownW) × [0, ownH)) missed diagonal
  // overlaps where neither anchor is strictly above-left of the other.
  // For 2×2 footprints (the original PR #41 contract) two overlapping
  // anchors are always within ±1 tile on each axis, so one MUST be
  // above-left. For 4×4+ footprints (steps 3 + UAT-1) two anchors can
  // be diagonally placed (e.g. (42, 14) and (45, 11) — both 4×4 — cover
  // tile (45, 14) but neither anchor is above-left of the other), so
  // both pass the old same-type check and "two boulders overlap" was
  // visible at UAT.
  //
  // Fix: walk the full overlap window (same axis range as the cross-type
  // check above) and use a lex-order tie-break instead of "above-left
  // window membership". `(anchorY, anchorX)` is the deterministic
  // ordering — the upper-leftmost anchor in the FOOTPRINT-OVERLAP set
  // wins, regardless of whether other overlapping anchors are strictly
  // above-left of it.
  for (let py = ay - ownH + 1; py <= ay + ownH - 1; py++) {
    for (let px = ax - ownW + 1; px <= ax + ownW - 1; px++) {
      if (px === ax && py === ay) continue;
      // Lex tie-break: only suppress if (py, px) is lex-smaller than
      // (ay, ax). Otherwise THIS anchor wins the tie and isn't suppressed
      // by (px, py). (The opposite test fires recursively when the
      // selector evaluates (px, py).)
      if (py > ay) continue;
      if (py === ay && px >= ax) continue;
      const ph = tileHash(px, py, own.salt, terrainSeed);
      if ((ph & 0x1ff) >= own.probability) continue;
      // Same gameplay-suppression rejection as the cross-type branch:
      // a same-type anchor sitting inside an entrance/food suppression
      // zone never renders, so it must not suppress sibling anchors
      // outside the zone.
      if (isAnchorSuppressedByOverlap(world, px, py, ownEntryIndex, terrainSeed)) continue;
      return true;
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
export function surfaceFeatureProcedural(
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
        if ((h & 0x1ff) >= entry.probability) continue;
        if (isAnchorSuppressedByOverlap(world, ax, ay, ei, terrainSeed)) {
          break;
        }
        if (bestEntryIndex < 0 || ay < bestAy || (ay === bestAy && ax < bestAx)) {
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
 * STATIC surface feature selector (PR 4). Returns the feature slice covering
 * (tileX, tileY) for BOTH movement and render, as a pure function of
 * `terrainSeed` and the **frozen baked grid** — with the old dynamic
 * entrance/food-pile suppression DELETED, so depleting a pile or designating
 * an entrance can never flip terrain.
 *
 * The procedural feature is filtered by the baked movement-effect grid (the
 * carve override): a tile reserved/carved passable at world-gen has its whole
 * feature footprint set to `Cosmetic` in the baked grid, so the procedural
 * feature there is suppressed (returns null) — the render must not paint a
 * boulder/leaf over a carved-passable tile (R4-3). When no baked grid is
 * present yet (mid-bake, or a bare hand-built world), falls back to the raw
 * procedural feature so the selector still works.
 */
export function surfaceFeatureAt(
  world: WorldState,
  tileX: number,
  tileY: number,
): SurfaceFeatureSlice | null {
  const proc = surfaceFeatureProcedural(world, tileX, tileY);
  if (proc === null) return null;
  const baked = world.bakedSurfaceEffect;
  if (
    baked !== undefined &&
    tileX >= 0 &&
    tileY >= 0 &&
    tileX < SURFACE_GRID_WIDTH &&
    tileY < SURFACE_GRID_HEIGHT
  ) {
    // Feature present iff the baked effect at this tile still matches the
    // procedural movement. A carved-out feature has its footprint set to
    // Cosmetic, so baked !== proc.movement ⇒ removed.
    if (baked[tileY * SURFACE_GRID_WIDTH + tileX] !== proc.movement) return null;
  }
  return proc;
}

/**
 * Movement effect of the (frozen) terrain at this tile. Reads the baked
 * movement-effect grid directly — O(1), static across pile/entrance events —
 * falling back to the raw procedural movement only when no baked grid exists
 * (bare hand-built worlds). `Cosmetic` for out-of-bounds / no feature.
 */
export function surfaceMovementAt(
  world: WorldState,
  tileX: number,
  tileY: number,
): SurfaceMovementEffect {
  const baked = world.bakedSurfaceEffect;
  if (baked !== undefined) {
    if (tileX < 0 || tileY < 0 || tileX >= SURFACE_GRID_WIDTH || tileY >= SURFACE_GRID_HEIGHT) {
      return SurfaceMovementEffect.Cosmetic;
    }
    return baked[tileY * SURFACE_GRID_WIDTH + tileX] as SurfaceMovementEffect;
  }
  const slice = surfaceFeatureProcedural(world, tileX, tileY);
  return slice === null ? SurfaceMovementEffect.Cosmetic : slice.movement;
}

// ---------------------------------------------------------------------------
// SurfaceMovementCache — per-tick lookup cache for surfaceMovementAt
//
// Step 5 introduced a per-ant per-tick SoftCost check that calls
// `surfaceMovementAt` on every surface ant's current tile, and step 4 calls
// `canEnterSurfaceTile` on every tile boundary crossing. Both go through
// `surfaceFeatureAt`, which is non-trivial (anchor scan + overlap suppression
// + gameplay suppression that walks all colonies). At hundreds of surface
// ants × 20 ticks/sec, the call rate dominates the simulation step.
//
// The cache flattens the cost via a Uint8Array of size
// `SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT` (~16 KB) initialised to a
// sentinel value (255). Lookups check the cache first; misses compute the
// effect via `surfaceMovementAt` and store. Same-tile re-lookups are O(1).
//
// Allocated once per `tickAntMovement` invocation and discarded — derived
// purely from `WorldState`, so it's not snapshot state and never crosses
// the save boundary.
//
// Pattern matches the underground side's flow-field caches (per-tick
// allocation, derived from world state, parameter-passed through movement
// helpers, never persisted).
// ---------------------------------------------------------------------------

import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  SURFACE_ROOT_CLEARANCE_RADIUS,
  PLAYER_START_X,
  PLAYER_START_Y,
} from './constants.js';

const SURFACE_MOVE_CACHE_SENTINEL = 255 as const;

export type SurfaceMovementCache = Uint8Array;

export function createSurfaceMovementCache(): SurfaceMovementCache {
  const c = new Uint8Array(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT);
  c.fill(SURFACE_MOVE_CACHE_SENTINEL);
  return c;
}

/**
 * Issue #67 — reset a previously-allocated cache for reuse, instead of
 * allocating a fresh 16KB Uint8Array per tick. Caller pre-allocates once at
 * module scope (or via a tick-scratch struct) and resets each tick before
 * the first lookup. Same observable behaviour as `createSurfaceMovementCache`.
 */
export function resetSurfaceMovementCache(cache: SurfaceMovementCache): void {
  cache.fill(SURFACE_MOVE_CACHE_SENTINEL);
}

/**
 * Cached variant of `surfaceMovementAt`. Returns the same value as the
 * uncached form; just memoises within a tick.
 *
 * Out-of-bounds tiles return `Cosmetic` (matches the no-feature default,
 * which is what surface movement code wants — the bounds check is the
 * caller's responsibility).
 */
export function surfaceMovementAtCached(
  world: WorldState,
  tileX: number,
  tileY: number,
  cache: SurfaceMovementCache,
): SurfaceMovementEffect {
  if (tileX < 0 || tileY < 0 || tileX >= SURFACE_GRID_WIDTH || tileY >= SURFACE_GRID_HEIGHT) {
    return SurfaceMovementEffect.Cosmetic;
  }
  const idx = tileY * SURFACE_GRID_WIDTH + tileX;
  let v = cache[idx]!;
  if (v === SURFACE_MOVE_CACHE_SENTINEL) {
    v = surfaceMovementAt(world, tileX, tileY);
    cache[idx] = v;
  }
  return v as SurfaceMovementEffect;
}

// ===========================================================================
// PR 4 — static terrain baking, root reservation, corridor carve, connectivity
//
// All pure integer ops (FNDN-04 / determinism): the baked grid + component
// mask are deterministic functions of (terrainSeed, canonical roots). No
// PRNG, no float, no clock. A tile is "walkable" iff its effect != HardBlock
// (SoftCost slows but is passable). Connectivity is 4-connected over walkable.
// ===========================================================================

const SURFACE_TILE_COUNT = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;

/** A canonical colony root (initial start tile) the bake reserves + connects. */
export interface SurfaceRoot {
  tileX: number;
  tileY: number;
}

/**
 * Bake the raw procedural movement-effect grid (no carves) — the frozen
 * per-tile snapshot of `surfaceFeatureProcedural(...).movement`. Used by
 * `createWorldState` (bare worlds) and as the starting point for the reserved +
 * connected bake; `bakeStaticTerrain` carves a copy rather than re-baking, so a
 * scenario pays one bake. No module-level cache (AGENTS.md forbids mutable state
 * outside the world snapshot).
 *
 * Iterates ANCHORS, not tiles: the per-tile selector calls the recursive
 * overlap-suppression check up to 16,384× per grid; walking real anchors in
 * lex (ay,ax) order and letting the first one claim each footprint tile yields
 * the IDENTICAL lex-smallest-winner result (so it stays consistent with the
 * per-tile `surfaceFeatureProcedural` the visual selector still uses) while
 * calling the suppression check only ~once per real anchor (hundreds, not 16k)
 * — the difference between a ~8 ms and a sub-ms bake (PR-4 CI regression fix).
 */
export function bakeSurfaceEffectGrid(world: WorldState): Uint8Array {
  const grid = new Uint8Array(SURFACE_TILE_COUNT); // 0 = Cosmetic (no feature)
  const claimed = new Uint8Array(SURFACE_TILE_COUNT);
  const terrainSeed = world.terrainSeed;
  // Per-anchor scratch: for tile-offset (dy,dx) within an anchor, which passing
  // feature is the FIRST that covers it (the per-tile selector's "first covering
  // feature, then break"). Reset per anchor (only when it has a passing feature).
  const offsetHandled = new Uint8Array(MAX_FEATURE_TILES_WIDE * MAX_FEATURE_TILES_TALL);
  // Anchors in lex (ay, ax) order so the FIRST surviving anchor covering a tile
  // wins — matching `surfaceFeatureProcedural`'s lex-smallest tie-break. Anchors
  // start at -(MAX-1): a feature anchored above/left of the grid still covers
  // in-grid tiles, and the per-tile selector considers those negative anchors.
  for (let ay = -(MAX_FEATURE_TILES_TALL - 1); ay < SURFACE_GRID_HEIGHT; ay++) {
    for (let ax = -(MAX_FEATURE_TILES_WIDE - 1); ax < SURFACE_GRID_WIDTH; ax++) {
      let anchorReset = false;
      for (let ei = 0; ei < SURFACE_FEATURES.length; ei++) {
        const entry = SURFACE_FEATURES[ei]!;
        const h = tileHash(ax, ay, entry.salt, terrainSeed);
        if ((h & 0x1ff) >= entry.probability) continue; // not a passing anchor for ei
        if (!anchorReset) {
          offsetHandled.fill(0);
          anchorReset = true;
        }
        // Suppression is per (ax,ay,ei). When the FIRST passing feature covering
        // a tile is suppressed, that tile gets nothing from this anchor (the
        // per-tile selector's break) — mark the offset handled but don't claim,
        // so neither a later feature here nor this anchor claims it (a later
        // anchor still can).
        const suppressed = isAnchorSuppressedByOverlap(world, ax, ay, ei, terrainSeed);
        for (let dy = 0; dy < entry.footprintTilesTall; dy++) {
          const ty = ay + dy;
          if (ty < 0) continue; // off the top edge — a larger dy may be in-grid
          if (ty >= SURFACE_GRID_HEIGHT) break;
          for (let dx = 0; dx < entry.footprintTilesWide; dx++) {
            const tx = ax + dx;
            if (tx < 0) continue; // off the left edge — a larger dx may be in-grid
            if (tx >= SURFACE_GRID_WIDTH) break;
            const off = dy * MAX_FEATURE_TILES_WIDE + dx;
            if (offsetHandled[off] === 1) continue; // an earlier passing feature covers it
            offsetHandled[off] = 1; // ei is the first covering feature for this offset
            if (!suppressed) {
              const idx = ty * SURFACE_GRID_WIDTH + tx;
              if (claimed[idx] === 0) {
                claimed[idx] = 1;
                grid[idx] = entry.movement;
              }
            }
          }
        }
      }
    }
  }
  return grid;
}

/**
 * Carve (to Cosmetic) the ENTIRE footprint of the procedural feature covering
 * (tileX, tileY) — at feature granularity so the render never paints a sprite
 * over a carved-passable tile (R4-3). Only the tiles where this feature is the
 * procedural winner are cleared (overlapping higher-priority neighbours keep
 * their effect). No-op if the tile already has no feature. When
 * `hardBlockOnly`, a SoftCost feature is left intact (used by corridor carving,
 * which only needs to clear impassable HardBlock).
 */
function carveFeatureFootprint(
  world: WorldState,
  grid: Uint8Array,
  tileX: number,
  tileY: number,
  hardBlockOnly: boolean,
): void {
  const winner = surfaceFeatureProcedural(world, tileX, tileY);
  if (winner === null) return;
  if (hardBlockOnly && winner.movement !== SurfaceMovementEffect.HardBlock) return;
  const ax = winner.anchorX;
  const ay = winner.anchorY;
  for (let py = ay; py < ay + winner.footprintTilesTall; py++) {
    if (py < 0 || py >= SURFACE_GRID_HEIGHT) continue;
    for (let px = ax; px < ax + winner.footprintTilesWide; px++) {
      if (px < 0 || px >= SURFACE_GRID_WIDTH) continue;
      const at = surfaceFeatureProcedural(world, px, py);
      if (at !== null && at.anchorX === ax && at.anchorY === ay && at.kind === winner.kind) {
        grid[py * SURFACE_GRID_WIDTH + px] = SurfaceMovementEffect.Cosmetic;
      }
    }
  }
}

/** Carve a deterministic Manhattan path (horizontal then vertical) between two
 *  roots, clearing every HardBlock feature it crosses so the two endpoints end
 *  up in one walkable component. */
function carveCorridor(world: WorldState, grid: Uint8Array, a: SurfaceRoot, b: SurfaceRoot): void {
  const stepX = a.tileX <= b.tileX ? 1 : -1;
  for (let x = a.tileX; x !== b.tileX + stepX; x += stepX) {
    carveFeatureFootprint(world, grid, x, a.tileY, true);
  }
  const stepY = a.tileY <= b.tileY ? 1 : -1;
  for (let y = a.tileY; y !== b.tileY + stepY; y += stepY) {
    carveFeatureFootprint(world, grid, b.tileX, y, true);
  }
}

/**
 * Bake the FROZEN static terrain for a scenario: raw procedural field, then
 * (1) reserve a static clearance neighbourhood around every canonical root
 * (clear ALL features so co-spawned ants have launch space), and (2) carve a
 * deterministic corridor chaining every root to the first, so all canonical
 * roots — and, via the reachable-spawn gate, every food pile + entrance — share
 * ONE connected walkable component (constructed, not merely asserted — R4-2).
 * (Isolated *empty* walkable pockets elsewhere are harmless and not gameplay
 * tiles; the reachable-spawn gate never places anything in them.) Deterministic;
 * no `terrainSeed` retry (R1-3).
 */
export function bakeStaticTerrain(
  world: WorldState,
  roots: ReadonlyArray<SurfaceRoot>,
): Uint8Array {
  // Reuse the procedural bake `createWorldState` already computed (carve a copy)
  // rather than re-baking from scratch — one full procedural pass per scenario.
  const grid = world.bakedSurfaceEffect.slice();
  const r = SURFACE_ROOT_CLEARANCE_RADIUS;
  for (const root of roots) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = root.tileX + dx;
        const ty = root.tileY + dy;
        if (tx < 0 || ty < 0 || tx >= SURFACE_GRID_WIDTH || ty >= SURFACE_GRID_HEIGHT) continue;
        carveFeatureFootprint(world, grid, tx, ty, false);
      }
    }
  }
  for (let i = 1; i < roots.length; i++) {
    carveCorridor(world, grid, roots[i]!, roots[0]!);
  }
  return grid;
}

/**
 * BFS the single connected walkable component (effect != HardBlock, 4-connected)
 * reachable from (rootX, rootY). Returns a 0/1 membership mask. Pure +
 * allocation-bounded (one Uint8Array mask + one Int32Array queue).
 */
export function computeSurfaceComponentMask(
  grid: Uint8Array,
  rootX: number,
  rootY: number,
): Uint8Array {
  // Fail loudly on a malformed grid: out-of-range reads return undefined, and
  // `undefined !== HardBlock` is true, so a short grid would silently flood the
  // whole map into one walkable component (a wrong-but-plausible mask).
  if (grid.length !== SURFACE_TILE_COUNT) {
    throw new Error(
      `computeSurfaceComponentMask: grid length ${grid.length} !== ${SURFACE_TILE_COUNT}`,
    );
  }
  const mask = new Uint8Array(SURFACE_TILE_COUNT);
  if (rootX < 0 || rootY < 0 || rootX >= SURFACE_GRID_WIDTH || rootY >= SURFACE_GRID_HEIGHT) {
    return mask;
  }
  const rootIdx = rootY * SURFACE_GRID_WIDTH + rootX;
  if (grid[rootIdx] === SurfaceMovementEffect.HardBlock) return mask;
  const queue = new Int32Array(SURFACE_TILE_COUNT);
  let head = 0;
  let tail = 0;
  mask[rootIdx] = 1;
  queue[tail++] = rootIdx;
  while (head < tail) {
    const idx = queue[head++]!;
    const x = idx % SURFACE_GRID_WIDTH;
    // 4-connected neighbours, derived from idx without division: a North
    // neighbour exists iff idx >= WIDTH; South iff idx < tileCount - WIDTH.
    if (idx >= SURFACE_GRID_WIDTH)
      tail = visitNeighbour(grid, mask, queue, idx - SURFACE_GRID_WIDTH, tail);
    if (idx < SURFACE_TILE_COUNT - SURFACE_GRID_WIDTH)
      tail = visitNeighbour(grid, mask, queue, idx + SURFACE_GRID_WIDTH, tail);
    if (x < SURFACE_GRID_WIDTH - 1) tail = visitNeighbour(grid, mask, queue, idx + 1, tail);
    if (x > 0) tail = visitNeighbour(grid, mask, queue, idx - 1, tail);
  }
  return mask;
}

function visitNeighbour(
  grid: Uint8Array,
  mask: Uint8Array,
  queue: Int32Array,
  nIdx: number,
  tail: number,
): number {
  if (mask[nIdx] === 0 && grid[nIdx] !== SurfaceMovementEffect.HardBlock) {
    mask[nIdx] = 1;
    queue[tail++] = nIdx;
  }
  return tail;
}

/** Canonical BFS root for the connected component — the first colony's first
 *  entrance (lowest colonyId), else the player start tile for bare worlds. */
function canonicalSurfaceRoot(world: WorldState): SurfaceRoot {
  let bestId = Number.POSITIVE_INFINITY;
  let root: SurfaceRoot | null = null;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const ents = colony.entrances;
    if (ents === undefined || ents.length === 0) continue;
    if (colony.colonyId < bestId) {
      bestId = colony.colonyId;
      root = { tileX: ents[0]!.surfaceTileX, tileY: ents[0]!.surfaceTileY };
    }
  }
  return root ?? { tileX: PLAYER_START_X, tileY: PLAYER_START_Y };
}

/**
 * Memoised single-component membership mask for the frozen surface terrain.
 * Terrain is immutable after bake, so the mask is computed once from the baked
 * grid + canonical root and cached on `world.surfaceComponentMask`.
 */
export function ensureSurfaceComponentMask(world: WorldState): Uint8Array {
  let mask = world.surfaceComponentMask;
  if (mask === null || mask === undefined) {
    const root = canonicalSurfaceRoot(world);
    mask = computeSurfaceComponentMask(world.bakedSurfaceEffect, root.tileX, root.tileY);
    world.surfaceComponentMask = mask;
  }
  return mask;
}

/** True iff (tileX, tileY) is walkable AND in the single connected surface
 *  component — the reachable-spawn gate for piles + entrances. */
export function isSurfaceTileInComponent(world: WorldState, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= SURFACE_GRID_WIDTH || tileY >= SURFACE_GRID_HEIGHT) {
    return false;
  }
  return ensureSurfaceComponentMask(world)[tileY * SURFACE_GRID_WIDTH + tileX] === 1;
}

/**
 * Connectivity invariant (R1-5): the single canonical walkable component (rooted
 * at `canonicalSurfaceRoot`) must contain every colony **entrance** and every
 * **food pile** — i.e. they are all mutually reachable. (Each colony's root
 * start tile gets an entrance at world-gen — `initColony` — so the entrance IS
 * the root; a colony with `entrances === undefined` contributes nothing and is
 * skipped.) Returns true iff the invariant holds. Called at world-gen
 * (`createScenario`) and on save load (`deserializeWorldState`).
 */
export function validateSurfaceConnectivity(world: WorldState): boolean {
  const mask = ensureSurfaceComponentMask(world);
  const inMask = (x: number, y: number): boolean =>
    x >= 0 &&
    y >= 0 &&
    x < SURFACE_GRID_WIDTH &&
    y < SURFACE_GRID_HEIGHT &&
    mask[y * SURFACE_GRID_WIDTH + x] === 1;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const ents = colony.entrances;
    if (ents === undefined) continue;
    for (const e of ents) {
      if (!inMask(e.surfaceTileX, e.surfaceTileY)) return false;
    }
  }
  for (const pile of world.foodPiles) {
    if (!inMask(pile.tileX, pile.tileY)) return false;
  }
  return true;
}
