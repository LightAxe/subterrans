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
for (const entry of LARGE_FEATURES) {
  const W = entry.variants[0]!.tilesWide;
  const H = entry.variants[0]!.tilesTall;
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
  for (const entry of LARGE_FEATURES) {
    // All variants of a given feature type share W × H so they can
    // round-trip through the same anchor scan. Picking variant[0]'s
    // dimensions is fine.
    const W = entry.variants[0]!.tilesWide;
    const H = entry.variants[0]!.tilesTall;
    for (let dy = 0; dy < H; dy++) {
      for (let dx = 0; dx < W; dx++) {
        const ax = tileX - dx;
        const ay = tileY - dy;
        const h = spatialHash(ax, ay, entry.salt);
        if ((h & 0xff) >= entry.probability) continue;
        // Anchor exists at (ax, ay). Pick a variant deterministically per
        // anchor — same (ax, ay) always picks the same variant, but
        // adjacent anchors get different variants so two boulders side by
        // side don't look like the same boulder copy-pasted.
        const variant = entry.variants[(h >>> 8) % entry.variants.length]!;
        drawLargeFeatureSlice(gfx, variant, screenX, screenY, dx, dy);
        return true;
      }
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

export function drawTunnelCornerOverlay(
  gfx: GfxLike,
  screenX: number,
  screenY: number,
  solidN: boolean,
  solidE: boolean,
  solidS: boolean,
  solidW: boolean,
): void {
  // Soft fade-to-rock alpha 0.5 along the edge facing the Solid neighbor.
  // The dither pattern from drawOpenFloorTile already adds tonal noise; this
  // overlay just shadows the edge band, producing a beveled-in feel.
  gfx.fillStyle(COLOR_ROCK_BASE_DARK, 0.5);
  if (solidN) gfx.fillRect(screenX,                  screenY,                  TILE_SIZE_PX, 2);
  if (solidS) gfx.fillRect(screenX,                  screenY + TILE_SIZE_PX-2, TILE_SIZE_PX, 2);
  if (solidW) gfx.fillRect(screenX,                  screenY,                  2, TILE_SIZE_PX);
  if (solidE) gfx.fillRect(screenX + TILE_SIZE_PX-2, screenY,                  2, TILE_SIZE_PX);

  // Inside-corner dither: where two adjacent edges are Solid, paint the
  // 2×2 corner block with a single darker pixel that visually softens the
  // 90° join. Combined with the edge fade above, the corner reads as
  // rounded-in rather than square.
  gfx.fillStyle(COLOR_ROCK_BASE, 0.7);
  if (solidN && solidW) gfx.fillRect(screenX + 0,                screenY + 0,                1, 1);
  if (solidN && solidE) gfx.fillRect(screenX + TILE_SIZE_PX-1,   screenY + 0,                1, 1);
  if (solidS && solidW) gfx.fillRect(screenX + 0,                screenY + TILE_SIZE_PX-1,   1, 1);
  if (solidS && solidE) gfx.fillRect(screenX + TILE_SIZE_PX-1,   screenY + TILE_SIZE_PX-1,   1, 1);
}
