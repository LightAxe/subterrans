// terrain-atlas.ts — procedural pixel-art terrain renderer.
//
// Replaces the previous "flat fillRect base + sparse colored dots" terrain
// rendering with substrate dithering + scattered decorative motifs +
// edge-aware tunnel corner sprites.
//
// Architecture:
//   - drawBarrenEarthTile / drawSolidRockTile / drawOpenFloorTile build the
//     visible tile from substrate dithering + motif overlays.
//   - The underground autotiler (underground-autotile.ts) drives shape via
//     quarter-tile masks composed on top of these substrates. The earlier
//     drawTunnelCornerOverlay / drawSolidConvexCornerOverlay path was
//     replaced by issue #43 — adjacent stair-step tiles now read as a
//     smooth diagonal silhouette via the autotile's chamfer hypotenuses.
//   - All decisions key off `(tileX, tileY, salt)` integer hashes — no PRNG,
//     no time, no Math.random. Same seed → same render forever (SCEN-06).
//
// The render layer is downstream of the sim and never affects tick output, so
// these helpers don't need a simVersion gate.

import type { GfxLike } from './draw-surface.js';
import type { WorldState } from '../sim/types.js';
import { surfaceFeatureAt } from '../sim/surface-features.js';
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
  SURFACE_FEATURE_SPRITES,
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

// Large multi-tile feature anchor salts and registry now live in
// `src/sim/surface-features.ts` (issue #44 step 1) — render queries the
// sim selector via `surfaceFeatureAt(world, tileX, tileY)` and renders
// the slice it returns. Salts 151..153 are reserved for boulder/bush/
// grass-clump anchor channels in the sim registry.

const SALT_SOLID_BASE      = 201;
const SALT_SOLID_DITHER    = 202;
const SALT_SOLID_FLECK     = 203;
const SALT_SOLID_STRATA    = 204;

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
// drawLargeFeatureSliceIfAny — query the sim-side surface-feature selector
// (`src/sim/surface-features.ts`) and render the slice covering this tile.
// Returns true if a feature was rendered, false otherwise. The selector
// owns layout decisions (anchor positions, variant pick, suppression);
// render only owns the pixel art (via SURFACE_FEATURE_SPRITES).
// ---------------------------------------------------------------------------

function drawLargeFeatureSliceIfAny(
  gfx: GfxLike,
  world: WorldState,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): boolean {
  const slice = surfaceFeatureAt(world, tileX, tileY);
  if (slice === null) return false;
  const sprites = SURFACE_FEATURE_SPRITES[slice.kind];
  // Defensive: an unmapped kind would mean sim and render have drifted.
  // The boot-time check in terrain-motifs.ts validates the map, so this
  // branch should never hit at runtime — but bail safely rather than
  // throwing inside the per-tile render hot path.
  if (sprites === undefined || sprites.length === 0) return false;
  const sprite = sprites[slice.variantIndex] ?? sprites[0]!;
  drawLargeFeatureSlice(
    gfx,
    sprite,
    screenX,
    screenY,
    tileX - slice.anchorX,
    tileY - slice.anchorY,
  );
  return true;
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
  world: WorldState,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): void {
  drawBarrenEarthSubstrate(gfx, screenX, screenY, tileX, tileY);

  // Multi-tile features (boulders, bushes, large grass clumps) override the
  // single-tile motif scattering when they cover this tile. Pebbles and
  // grass tufts inside a boulder's footprint would clash visually, so we
  // bail before the per-tile motif passes. Selector is sim-owned (issue
  // #44 step 1) — render only translates kind→sprite and paints the slice.
  if (drawLargeFeatureSliceIfAny(gfx, world, screenX, screenY, tileX, tileY)) return;

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

