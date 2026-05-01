// terrain-atlas.ts — procedural pixel-art terrain renderer.
//
// Replaces the previous "flat fillRect base + sparse colored dots" terrain
// rendering with substrate dithering + scattered decorative motifs +
// edge-aware tunnel corner sprites.
//
// Architecture:
//   - drawBarrenEarthTile / drawSolidRockTile / drawOpenFloorTile build the
//     visible tile from substrate dithering + motif overlays.
//   - drawTunnelCornerOverlay rounds inside corners on Open underground tiles
//     by darkening pixels that face a Solid 4-neighbor.
//   - All decisions key off `(tileX, tileY, salt)` integer hashes — no PRNG,
//     no time, no Math.random. Same seed → same render forever (SCEN-06).
//
// The render layer is downstream of the sim and never affects tick output, so
// these helpers don't need a simVersion gate.

import type { GfxLike } from './draw-surface.js';
import { TILE_SIZE_PX } from './sprites.js';
import {
  spatialHash,
  pixelNoise,
  bayer4Threshold,
  motifOffset,
} from './terrain-noise.js';
import {
  type MotifSprite,
  type LargeFeatureSprite,
  GRASS_TUFT_SPRITE,
  DRY_GRASS_TUFT_SPRITE,
  PEBBLE_SPRITE,
  SMALL_STONE_SPRITE,
  TWIG_SPRITE,
  DEAD_LEAF_SPRITE,
  SEED_SPRITE,
  ROCK_FLECK_SPRITE,
  STRATA_LINE_SPRITE,
  FLOOR_DUST_SPRITE,
  LARGE_BOULDER_SPRITE,
  LARGE_BOULDER_SPRITE_FLAT,
  LARGE_BUSH_SPRITE,
  LARGE_BUSH_SPRITE_TALL,
  LARGE_GRASS_CLUMP_SPRITE,
  LARGE_GRASS_CLUMP_SPRITE_SPARSE,
} from './terrain-motifs.js';

// ---------------------------------------------------------------------------
// Salt namespace — distinct integer constants per "decision channel" so two
// tiles asking different questions never accidentally land on the same hash.
// ---------------------------------------------------------------------------

const SALT_BARREN_BASE     = 101;
const SALT_BARREN_DITHER   = 102;
const SALT_BARREN_PEBBLE   = 103;
const SALT_BARREN_GRASS    = 104;
const SALT_BARREN_TWIG     = 105;
const SALT_BARREN_LEAF     = 106;
const SALT_BARREN_STONE    = 107;
const SALT_BARREN_SEED     = 108;
// Large multi-tile feature anchor salts.
const SALT_LARGE_BOULDER   = 151;
const SALT_LARGE_BUSH      = 152;
const SALT_LARGE_GRASS     = 153;

const SALT_SOLID_BASE      = 201;
const SALT_SOLID_DITHER    = 202;
const SALT_SOLID_FLECK     = 203;
const SALT_SOLID_STRATA    = 204;

const SALT_OPEN_BASE       = 301;
const SALT_OPEN_DITHER     = 302;
const SALT_OPEN_DUST       = 303;

// ---------------------------------------------------------------------------
// Surface palette — earthy / desaturated. Issue #40 reframe: barren earth is
// the surface default; grass appears as occasional decoration only.
// ---------------------------------------------------------------------------

/** Default surface base color — dry tan earth. */
export const COLOR_BARREN_EARTH       = 0x8e7752;
/** Slightly darker earth used in dithered cells for tonal variation. */
export const COLOR_BARREN_EARTH_DARK  = 0x6f5a3c;
/** A lighter earth tone for mineral/sand specks. */
export const COLOR_BARREN_EARTH_LIGHT = 0xa28a63;
/** Yet darker patch for occasional damper soil regions. */
export const COLOR_BARREN_EARTH_DAMP  = 0x5a4a30;

/** Underground solid rock palette. */
export const COLOR_ROCK_BASE     = 0x2d1f14;
export const COLOR_ROCK_BASE_DARK = 0x1d130a;
export const COLOR_ROCK_BASE_LIGHT = 0x3f2c1c;

/** Underground open-floor palette. */
export const COLOR_FLOOR_BASE      = 0x110a06;
export const COLOR_FLOOR_BASE_DARK = 0x080403;

// ---------------------------------------------------------------------------
// Multi-tile features — registry consumed by drawLargeFeatureSliceIfAny.
//
// Each entry has a sprite, a salt (independent anchor distribution), and a
// per-anchor probability. Iteration order is fixed so the "first match wins"
// resolution is deterministic across all rendering paths. Higher-priority
// features (large boulders) come first so they override grass clumps when
// their footprints would overlap.
// ---------------------------------------------------------------------------

interface FeatureRegistryEntry {
  /** Per-feature-type variants. Picked deterministically per (anchorX,
   *  anchorY) hash so each landed feature looks like one of N forms,
   *  not the same sprite cloned across the map. */
  variants: ReadonlyArray<LargeFeatureSprite>;
  salt: number;
  /** 0..255 anchor probability per tile. ~5 = ~2% of tiles host an anchor. */
  probability: number;
}

const LARGE_FEATURES: ReadonlyArray<FeatureRegistryEntry> = [
  {
    variants: [LARGE_BOULDER_SPRITE, LARGE_BOULDER_SPRITE_FLAT],
    salt: SALT_LARGE_BOULDER,
    probability: 6,
  },
  {
    variants: [LARGE_BUSH_SPRITE, LARGE_BUSH_SPRITE_TALL],
    salt: SALT_LARGE_BUSH,
    probability: 8,
  },
  {
    variants: [LARGE_GRASS_CLUMP_SPRITE, LARGE_GRASS_CLUMP_SPRITE_SPARSE],
    salt: SALT_LARGE_GRASS,
    probability: 10,
  },
];

// Boot-time integrity check: every variant in a feature entry must share
// the same `tilesWide × tilesTall` dimensions. The slice scan in
// `drawLargeFeatureSliceIfAny` uses `variants[0]`'s dimensions for the
// anchor window — if a future contributor adds a variant of a different
// size, slices outside the variant[0] window would be silently skipped.
// Throwing at module load surfaces the bug at the earliest possible point.
//
// At the same time, compute MAX_FEATURE_TILES_WIDE / MAX_FEATURE_TILES_TALL
// — the cross-entry maximum span. drawLargeFeatureSliceIfAny scans this
// window per tile so every potential anchor that could claim the tile is
// considered (including features bigger than the smallest one — relevant
// once a 3×3 boulder ships).
let _maxW = 0;
let _maxH = 0;
for (const entry of LARGE_FEATURES) {
  const W = entry.variants[0]!.tilesWide;
  const H = entry.variants[0]!.tilesTall;
  if (W > _maxW) _maxW = W;
  if (H > _maxH) _maxH = H;
  for (let i = 1; i < entry.variants.length; i++) {
    const v = entry.variants[i]!;
    if (v.tilesWide !== W || v.tilesTall !== H) {
      throw new Error(
        `LARGE_FEATURES variant size mismatch: salt=${entry.salt}, ` +
        `variant[0]=${W}×${H}, variant[${i}]=${v.tilesWide}×${v.tilesTall}`,
      );
    }
  }
}
const MAX_FEATURE_TILES_WIDE = _maxW;
const MAX_FEATURE_TILES_TALL = _maxH;

/**
 * If any registered multi-tile feature anchors at a position whose footprint
 * covers (tileX, tileY), paint that feature's slice for this tile and return
 * true. The first match wins — features earlier in `LARGE_FEATURES` take
 * priority. Returns false if no feature covers this tile.
 *
 * The scan walks every (anchorX, anchorY) candidate in the W×H window
 * above-left of (tileX, tileY) — so the rendering of any tile that's part
 * of a feature is fully self-contained. No cross-tile state, no anchor-
 * must-be-onscreen gotcha; if the camera shows tile (5, 5) and a 2×2
 * boulder anchored at (4, 4) covers it, the boulder's bottom-right
 * sub-region renders cleanly even when (4, 4) is offscreen.
 */
function drawLargeFeatureSliceIfAny(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): boolean {
  // Codex review followup #2: previous "upper-leftmost-per-tile" selection
  // still left half-feature seams when two anchors had partially-
  // overlapping footprints. Two 2×2 anchors at (5,5) and (6,5): tiles
  // (5..6, 5..6) all chose (5,5), but tile (7,5) — outside (5,5)'s
  // footprint, inside (6,5)'s — still chose (6,5). Result: anchor
  // (6,5)'s LEFT half rendered nowhere (occluded by (5,5)) while its
  // RIGHT half rendered at (7,5)/(7,6).
  //
  // Stronger fix: also reject any anchor that is itself OCCLUDED by an
  // upper-left anchor's footprint. Anchor (6,5) checks the (W-1)×(H-1)
  // window above-left for any active upper-left anchor; (5,5) is one;
  // (6,5) is therefore suppressed. Tile (7,5) sees no active anchor in
  // its scan window and renders normal substrate.
  let bestAx = 0;
  let bestAy = 0;
  let bestSprite: LargeFeatureSprite | null = null;
  for (let dy = 0; dy < MAX_FEATURE_TILES_TALL; dy++) {
    for (let dx = 0; dx < MAX_FEATURE_TILES_WIDE; dx++) {
      const ax = tileX - dx;
      const ay = tileY - dy;
      for (let ei = 0; ei < LARGE_FEATURES.length; ei++) {
        const entry = LARGE_FEATURES[ei]!;
        const W = entry.variants[0]!.tilesWide;
        const H = entry.variants[0]!.tilesTall;
        if (dx >= W || dy >= H) continue;
        const h = spatialHash(ax, ay, entry.salt);
        if ((h & 0xff) >= entry.probability) continue;
        if (isAnchorSuppressed(ax, ay, ei)) {
          break;
        }
        if (
          bestSprite === null ||
          ay < bestAy ||
          (ay === bestAy && ax < bestAx)
        ) {
          bestAx = ax;
          bestAy = ay;
          bestSprite = entry.variants[(h >>> 8) % entry.variants.length]!;
        }
        break;
      }
    }
  }
  if (bestSprite !== null) {
    drawLargeFeatureSlice(gfx, bestSprite, screenX, screenY, tileX - bestAx, tileY - bestAy);
    return true;
  }
  return false;
}

/**
 * True if anchor (ax, ay) of feature `LARGE_FEATURES[ownEntryIndex]` is
 * suppressed and should not render. Two suppression rules:
 *
 * 1. CROSS-TYPE: any HIGHER-PRIORITY feature (earlier registry entry)
 *    whose footprint OVERLAPS this anchor's footprint suppresses this
 *    anchor entirely. The boulder/bush/grass priority is the registry
 *    contract — boulders win over bushes, bushes win over grass clumps,
 *    regardless of anchor lex position. Without this rule a grass-clump
 *    anchor at (76, 2) would survive even when a higher-priority
 *    boulder anchor at (77, 2) overlaps its footprint, leaving the
 *    grass clump partially visible while the boulder occluded its
 *    other half (codex review #3).
 *
 * 2. SAME-TYPE: any earlier (lex-smaller) anchor of THIS feature type
 *    that covers this tile suppresses this anchor. Implements the
 *    "upper-leftmost wins" rule for own-type overlaps so two boulders
 *    can't render on top of each other.
 *
 * Lower-priority features (later registry entries) do NOT suppress
 * higher-priority anchors — the contract is one-directional. Costs scale
 * with `ownEntryIndex`: boulder pays 3 hash lookups, bush pays ~12,
 * grass-clump pays ~21. All well-bounded.
 */
function isAnchorSuppressed(
  ax: number,
  ay: number,
  ownEntryIndex: number,
): boolean {
  const own = LARGE_FEATURES[ownEntryIndex]!;
  const ownW = own.variants[0]!.tilesWide;
  const ownH = own.variants[0]!.tilesTall;

  // Cross-type: higher-priority features whose footprints overlap.
  for (let ei = 0; ei < ownEntryIndex; ei++) {
    const entry = LARGE_FEATURES[ei]!;
    const W = entry.variants[0]!.tilesWide;
    const H = entry.variants[0]!.tilesTall;
    // (px, py) candidates where G's footprint at (px, py) overlaps own
    // footprint at (ax, ay): px in [ax-W+1, ax+ownW-1] and similarly y.
    for (let py = ay - H + 1; py <= ay + ownH - 1; py++) {
      for (let px = ax - W + 1; px <= ax + ownW - 1; px++) {
        const ph = spatialHash(px, py, entry.salt);
        if ((ph & 0xff) < entry.probability) return true;
      }
    }
  }

  // Same-type: above-left anchors that cover (ax, ay).
  for (let dy = 0; dy < ownH; dy++) {
    for (let dx = 0; dx < ownW; dx++) {
      if (dx === 0 && dy === 0) continue;
      const px = ax - dx;
      const py = ay - dy;
      const ph = spatialHash(px, py, own.salt);
      if ((ph & 0xff) < own.probability) return true;
    }
  }
  return false;
}

/** Paint the (sliceX, sliceY)-th 16×16 cell of a multi-tile feature into the
 *  current tile, batched one fillStyle per palette index. */
function drawLargeFeatureSlice(
  gfx: GfxLike,
  sprite: LargeFeatureSprite,
  screenX: number,
  screenY: number,
  sliceX: number,
  sliceY: number,
): void {
  const stride = sprite.tilesWide * TILE_SIZE_PX;
  const baseCol = sliceX * TILE_SIZE_PX;
  const baseRow = sliceY * TILE_SIZE_PX;
  for (let c = 1; c < sprite.colors.length; c++) {
    gfx.fillStyle(sprite.colors[c]!, 1);
    for (let r = 0; r < TILE_SIZE_PX; r++) {
      for (let cc = 0; cc < TILE_SIZE_PX; cc++) {
        const px = sprite.pixels[(baseRow + r) * stride + (baseCol + cc)];
        if (px === c) {
          gfx.fillRect(screenX + cc, screenY + r, 1, 1);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// drawMotif — paint a MotifSprite at (screenX + offX, screenY + offY).
// Single fillStyle per palette index, batched as one fillRect per pixel of
// that color. Transparent (palette index 0) pixels are skipped.
// ---------------------------------------------------------------------------

function drawMotif(
  gfx: GfxLike,
  sprite: MotifSprite,
  screenX: number,
  screenY: number,
  offX: number,
  offY: number,
): void {
  // Iterate the palette in order so we issue one fillStyle per color and
  // batch the fillRects under it. Cheaper than alternating fillStyles.
  for (let c = 1; c < sprite.colors.length; c++) {
    gfx.fillStyle(sprite.colors[c]!, 1);
    for (let r = 0; r < sprite.height; r++) {
      for (let cc = 0; cc < sprite.width; cc++) {
        if (sprite.pixels[r * sprite.width + cc] === c) {
          gfx.fillRect(screenX + offX + cc, screenY + offY + r, 1, 1);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// drawDitheredSubstrate — paint a 2-tone substrate across a 16×16 tile.
//
// Strategy: solid base (1 fillRect) + sparse darker pixels at noise samples
// that pass two filters: per-pixel deterministic noise below the coverage
// cutoff AND the Bayer 4×4 ordered threshold below the same cutoff. The
// Bayer matrix gives a chunky cross-hatched SHAPE; the noise filter trims
// it to the deterministic per-(x,y) pattern.
//
// `ditherCoverage` is a 0..255 byte. Lower = sparser. The two filters
// multiply: at coverage=50, noise admits ~50/256 ≈ 20% of pixels and Bayer
// admits 4/16 = 25% of cells. Joint admission ≈ 5% per pixel × 256 pixels
// per tile = ~13 darker pixels per tile. At coverage=25 the joint rate is
// ~1.5% × 256 ≈ 4 darker pixels.
// ---------------------------------------------------------------------------

function drawDitheredSubstrate(
  gfx: GfxLike,
  baseColor: number,
  ditherColor: number,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  salt: number,
  /** 0..255. ~50 produces ~20% coverage; ~80 produces ~30%. */
  ditherCoverage: number,
): void {
  gfx.fillStyle(baseColor, 1);
  gfx.fillRect(screenX, screenY, TILE_SIZE_PX, TILE_SIZE_PX);

  gfx.fillStyle(ditherColor, 1);
  for (let r = 0; r < TILE_SIZE_PX; r++) {
    for (let c = 0; c < TILE_SIZE_PX; c++) {
      const px = tileX * TILE_SIZE_PX + c;
      const py = tileY * TILE_SIZE_PX + r;
      const n = pixelNoise(px, py, salt);
      // Two-tier filter: noise must be below the coverage cutoff AND inside
      // the Bayer mask's "on" cells. The Bayer threshold is rebased so it
      // contributes the cross-hatched SHAPE (which pixels are eligible) and
      // ditherCoverage controls overall density.
      if (n < ditherCoverage && bayer4Threshold(c, r) < ditherCoverage) {
        gfx.fillRect(screenX + c, screenY + r, 1, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// drawBarrenEarthTile — surface-default substrate. Dirt-dominant with sparse
// motifs (grass tufts, pebbles, twigs, dead leaves) sprinkled per tile hash.
// ---------------------------------------------------------------------------

/**
 * Substrate-only barren earth — dithered base + sand specks, no motifs and
 * no multi-tile feature scattering. Used by the underground ceiling row so
 * that boulders/bushes/grass-tufts can't intermittently poke into the
 * "plain ceiling" strip the player expects to be a consistent texture.
 * `drawBarrenEarthTile` calls into this for its substrate pass too, so the
 * surface and ceiling share their underlying tonal pattern.
 */
export function drawBarrenEarthSubstrate(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): void {
  drawDitheredSubstrate(
    gfx,
    COLOR_BARREN_EARTH,
    COLOR_BARREN_EARTH_DARK,
    screenX, screenY, tileX, tileY, SALT_BARREN_DITHER,
    /* ditherCoverage */ 50,
  );
  // Lighter sand specks — sparse hash-sampled positions, ~3-4 per tile.
  gfx.fillStyle(COLOR_BARREN_EARTH_LIGHT, 1);
  drawSparseSpecks(gfx, screenX, screenY, tileX, tileY, SALT_BARREN_BASE, 4);
}

export function drawBarrenEarthTile(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): void {
  drawBarrenEarthSubstrate(gfx, screenX, screenY, tileX, tileY);

  // Multi-tile features (boulders, bushes, large grass clumps) override the
  // single-tile motif scattering when they cover this tile. Pebbles and
  // grass tufts inside a boulder's footprint would clash visually, so we
  // bail before the per-tile motif passes.
  if (drawLargeFeatureSliceIfAny(gfx, screenX, screenY, tileX, tileY)) return;

  // Motif overlays — each one is a small probabilistic decoration.
  // The probabilities sum to ~30% so most tiles have at most one motif and
  // the eye treats each as a recognizable landmark.

  const hGrass = spatialHash(tileX, tileY, SALT_BARREN_GRASS);
  if ((hGrass & 0xff) < 38) {
    // ~15% — grass tuft (live).
    const off = motifOffset(hGrass, GRASS_TUFT_SPRITE.width, GRASS_TUFT_SPRITE.height);
    drawMotif(gfx, GRASS_TUFT_SPRITE, screenX, screenY, off.x, off.y);
  } else if ((hGrass & 0xff) < 48) {
    // ~4% — dry grass tuft.
    const off = motifOffset(hGrass >>> 8, DRY_GRASS_TUFT_SPRITE.width, DRY_GRASS_TUFT_SPRITE.height);
    drawMotif(gfx, DRY_GRASS_TUFT_SPRITE, screenX, screenY, off.x, off.y);
  }

  const hPebble = spatialHash(tileX, tileY, SALT_BARREN_PEBBLE);
  if ((hPebble & 0xff) < 30) {
    const off = motifOffset(hPebble, PEBBLE_SPRITE.width, PEBBLE_SPRITE.height);
    drawMotif(gfx, PEBBLE_SPRITE, screenX, screenY, off.x, off.y);
  }

  const hStone = spatialHash(tileX, tileY, SALT_BARREN_STONE);
  if ((hStone & 0xff) < 12) {
    // ~5% — small stone (rarer than pebbles).
    const off = motifOffset(hStone, SMALL_STONE_SPRITE.width, SMALL_STONE_SPRITE.height);
    drawMotif(gfx, SMALL_STONE_SPRITE, screenX, screenY, off.x, off.y);
  }

  const hTwig = spatialHash(tileX, tileY, SALT_BARREN_TWIG);
  if ((hTwig & 0xff) < 12) {
    const off = motifOffset(hTwig, TWIG_SPRITE.width, TWIG_SPRITE.height);
    drawMotif(gfx, TWIG_SPRITE, screenX, screenY, off.x, off.y);
  }

  const hLeaf = spatialHash(tileX, tileY, SALT_BARREN_LEAF);
  if ((hLeaf & 0xff) < 10) {
    const off = motifOffset(hLeaf, DEAD_LEAF_SPRITE.width, DEAD_LEAF_SPRITE.height);
    drawMotif(gfx, DEAD_LEAF_SPRITE, screenX, screenY, off.x, off.y);
  }

  const hSeed = spatialHash(tileX, tileY, SALT_BARREN_SEED);
  if ((hSeed & 0xff) < 18) {
    const off = motifOffset(hSeed, SEED_SPRITE.width, SEED_SPRITE.height);
    drawMotif(gfx, SEED_SPRITE, screenX, screenY, off.x, off.y);
  }
}

// ---------------------------------------------------------------------------
// drawSolidRockTile — underground unexcavated. Dark base + rock flecks +
// occasional strata band. No motifs that would compete with chamber colors.
// ---------------------------------------------------------------------------

export function drawSolidRockTile(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): void {
  drawDitheredSubstrate(
    gfx,
    COLOR_ROCK_BASE,
    COLOR_ROCK_BASE_DARK,
    screenX, screenY, tileX, tileY, SALT_SOLID_DITHER,
    /* ditherCoverage */ 45,
  );

  // Lighter mineral specks — sparse hash-sampled positions, ~3 per tile.
  gfx.fillStyle(COLOR_ROCK_BASE_LIGHT, 1);
  drawSparseSpecks(gfx, screenX, screenY, tileX, tileY, SALT_SOLID_BASE, 3);

  const hFleck = spatialHash(tileX, tileY, SALT_SOLID_FLECK);
  if ((hFleck & 0xff) < 80) {
    const off = motifOffset(hFleck, ROCK_FLECK_SPRITE.width, ROCK_FLECK_SPRITE.height);
    drawMotif(gfx, ROCK_FLECK_SPRITE, screenX, screenY, off.x, off.y);
  }

  const hStrata = spatialHash(tileX, tileY, SALT_SOLID_STRATA);
  if ((hStrata & 0xff) < 25) {
    const off = motifOffset(hStrata, STRATA_LINE_SPRITE.width, STRATA_LINE_SPRITE.height);
    drawMotif(gfx, STRATA_LINE_SPRITE, screenX, screenY, off.x, off.y);
  }
}

// ---------------------------------------------------------------------------
// drawOpenFloorTile — underground excavated. Near-black base with a faint
// dust-speck overlay. Kept dark-and-quiet so chambers and ants pop on top.
// ---------------------------------------------------------------------------

export function drawOpenFloorTile(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): void {
  drawDitheredSubstrate(
    gfx,
    COLOR_FLOOR_BASE,
    COLOR_FLOOR_BASE_DARK,
    screenX, screenY, tileX, tileY, SALT_OPEN_DITHER,
    /* ditherCoverage */ 25,
  );

  // Faint dust speck — at most one motif per tile, ~35% probability.
  const hDust = spatialHash(tileX, tileY, SALT_OPEN_DUST);
  if ((hDust & 0xff) < 90) {
    const off = motifOffset(hDust, FLOOR_DUST_SPRITE.width, FLOOR_DUST_SPRITE.height);
    drawMotif(gfx, FLOOR_DUST_SPRITE, screenX, screenY, off.x, off.y);
  }
}

// ---------------------------------------------------------------------------
// drawSparseSpecks — deterministic single-pixel "speck" overlay.
//
// Pulls `count` hash slots and emits a 1×1 fillRect per slot whose top byte
// passes a coverage threshold. Used for mineral specks, sand grains, and
// other "dust on top of substrate" effects without full-pixel iteration.
// Caller is responsible for setting fillStyle before calling.
// ---------------------------------------------------------------------------

function drawSparseSpecks(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
  salt: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    // Step 13 instead of 17 (codex review followup): with SALT_BARREN_BASE
    // = 101 and count = 4, step 17 produced derived salt 152 on the last
    // iteration — the same integer as `SALT_LARGE_BUSH`. Two unrelated
    // decisions sharing a hash channel correlates the speck position with
    // the bush variant pick. Step 13 yields {101, 114, 127, 140} for the
    // BARREN sweep and {201, 214, 227} for the SOLID sweep — neither
    // intersects any salt in the 151..153, 201..204, 301..303 ranges.
    const h = spatialHash(tileX, tileY, salt + i * 13);
    // ~50% emit probability per slot — tunable, but biases toward "always
    // a speck or two but never overwhelming".
    if ((h & 0xff) < 128) {
      const x = ((h >>> 8) & 0xffff) % TILE_SIZE_PX;
      const y = ((h >>> 24) & 0xff) % TILE_SIZE_PX;
      gfx.fillRect(screenX + x, screenY + y, 1, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// drawTunnelCornerOverlay — round inside corners on Open underground tiles.
//
// Issue #40 — tunnel edges should not read as a hard 90° boundary. For each
// Open tile, look at the 4 cardinal neighbors. Where a neighbor is Solid, the
// 2-pixel-wide row/column on that side gets a subtle darker fade so the
// transition reads as soil packed against open floor rather than two flat
// blocks meeting at a sharp edge.
//
// `solidN/E/S/W` are booleans — the caller decides what counts as "wall"
// for each edge. Per the call sites in draw-underground.ts, only true Solid
// tiles count as walls; Marked / BeingDug render as open-floor-with-tint
// and don't get a wall shadow facing them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// drawSolidConvexCornerOverlay — round off Solid tiles' corners where they
// poke into open space.
//
// Issue #40 user UAT (continued): the inside-corner darkening on OPEN tiles
// alone wasn't enough to make stair-step tunnel paths read as diagonal.
// The other half of the trick is to ALSO round the SOLID tiles' corners
// where two adjacent neighbors are open. A 2-tile-wide diagonal corridor
// is bordered by stair-stepped Solid tiles; each Solid tile that pokes
// into the corridor has at least one convex corner (perpendicular pair of
// open neighbors). Rendering a floor-colored quarter-arc at that corner
// makes the wall RECEDE from the corner, mirror-imaging the open tile's
// inside-corner darkening on the other side of the boundary.
//
// The two effects compose: the corridor wall on each side is rounded off
// at every stair-step junction, and the rounded curves on adjacent tiles
// connect into a continuous smooth diagonal.
//
// Convex corner detection: a Solid tile's NE corner is "convex into open"
// when its N AND E AND NE neighbors are all Open. The 3-of-3 check rules
// out saddle points (N=Open, E=Open, NE=Solid — a rock peninsula) which
// would render incorrectly as if the corner faced wide-open space.
// ---------------------------------------------------------------------------

export function drawSolidConvexCornerOverlay(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  openN: boolean,
  openNE: boolean,
  openE: boolean,
  openSE: boolean,
  openS: boolean,
  openSW: boolean,
  openW: boolean,
  openNW: boolean,
): void {
  const N = TILE_SIZE_PX - 1;
  // Same 5-layer wedge as drawTunnelCornerOverlay's inside corner — but
  // painted with COLOR_FLOOR_BASE (the Open underground floor color) so
  // the rock at the convex corner LOOKS like it's been carved away to
  // reveal the open floor underneath. Layer alphas tuned so the corner
  // pixel is fully open and outer pixels fade gradually back into rock.
  const ALPHAS: ReadonlyArray<number> = [0.95, 0.78, 0.6, 0.4, 0.22];
  for (let i = 0; i < ALPHAS.length; i++) {
    gfx.fillStyle(COLOR_FLOOR_BASE, ALPHAS[i]!);
    for (let r = 0; r <= i; r++) {
      const c = i - r;
      if (openN && openE && openNE)  gfx.fillRect(screenX + N - c, screenY + r,         1, 1);
      if (openN && openW && openNW)  gfx.fillRect(screenX + c,     screenY + r,         1, 1);
      if (openS && openE && openSE)  gfx.fillRect(screenX + N - c, screenY + N - r,     1, 1);
      if (openS && openW && openSW)  gfx.fillRect(screenX + c,     screenY + N - r,     1, 1);
    }
  }
}

export function drawTunnelCornerOverlay(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  solidN: boolean,
  solidE: boolean,
  solidS: boolean,
  solidW: boolean,
): void {
  // Edge fade: rock-tone band along each wall side, alpha-stacked so the
  // 2 outermost pixels read darkest and inner pixel reads as a transition.
  // Two-band fade (instead of the previous flat 2-pixel band) gives the
  // "soft pack" feel of dirt against open air.
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.55);
  if (solidN) gfx.fillRect(screenX,                  screenY,                  TILE_SIZE_PX, 1);
  if (solidS) gfx.fillRect(screenX,                  screenY + TILE_SIZE_PX-1, TILE_SIZE_PX, 1);
  if (solidW) gfx.fillRect(screenX,                  screenY,                  1, TILE_SIZE_PX);
  if (solidE) gfx.fillRect(screenX + TILE_SIZE_PX-1, screenY,                  1, TILE_SIZE_PX);
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.3);
  if (solidN) gfx.fillRect(screenX,                  screenY + 1,              TILE_SIZE_PX, 1);
  if (solidS) gfx.fillRect(screenX,                  screenY + TILE_SIZE_PX-2, TILE_SIZE_PX, 1);
  if (solidW) gfx.fillRect(screenX + 1,              screenY,                  1, TILE_SIZE_PX);
  if (solidE) gfx.fillRect(screenX + TILE_SIZE_PX-2, screenY,                  1, TILE_SIZE_PX);

  // Inside-corner quarter-arc (issue #40 user UAT — earlier 3-pixel bevel
  // was still reading as a 90° corner). Render a 5-pixel triangular wedge
  // at each inside corner, filled with rock-color at high alpha. The
  // wedge takes up most of the corner quadrant so that:
  //   (a) a lone inside corner reads as a fully-rounded interior bend,
  //   (b) two adjacent inside-corner tiles forming a stair-step (e.g. a
  //       SW corner on tile A immediately followed by a NE corner on
  //       tile A's east neighbor) merge visually into one long diagonal,
  //       since the wedges from adjacent tiles meet at the shared edge.
  //
  // Wedge shape (NW example, anchored at screenX+0, screenY+0):
  //   #####          (5 wide × 1)
  //   ####.          (4 wide × 1, one short of the right edge)
  //   ###..
  //   ##...
  //   #....
  // Total: 5+4+3+2+1 = 15 pixels per corner. The first row + first column
  // are the heavy-alpha "wall continues into the tile" band; deeper
  // diagonals fade with progressively lower alpha so the curve looks
  // smooth.
  const N = TILE_SIZE_PX - 1; // index of last column/row in tile
  const ALPHAS: ReadonlyArray<number> = [0.95, 0.78, 0.6, 0.4, 0.22];
  // Layer i covers cells where (col + row) === i in the corner-local
  // (0..4, 0..4) grid. Layer 0 = the corner pixel; layer 4 = the
  // diagonal opposite.
  for (let i = 0; i < ALPHAS.length; i++) {
    gfx.fillStyle(COLOR_ROCK_BASE, ALPHAS[i]!);
    for (let r = 0; r <= i; r++) {
      const c = i - r;
      // c, r index the corner-local grid (small values = closer to corner).
      if (solidN && solidW) gfx.fillRect(screenX + c,         screenY + r,         1, 1);
      if (solidN && solidE) gfx.fillRect(screenX + N - c,     screenY + r,         1, 1);
      if (solidS && solidW) gfx.fillRect(screenX + c,         screenY + N - r,     1, 1);
      if (solidS && solidE) gfx.fillRect(screenX + N - c,     screenY + N - r,     1, 1);
    }
  }
}
