// terrain-motifs.ts — pixel-art motif sprites as inline bitmap tables.
//
// Each motif is a small 2D bitmap rendered at a deterministic offset inside
// a tile when the per-tile hash selects it. Motifs stack on top of the base
// substrate (barren earth / open floor / solid rock) to produce visual variety
// without any external assets.
//
// Encoding: each motif is a `MotifSprite` with a width, height, a pixel array
// indexed (row * width + col), and a palette index per pixel. A 0 in the pixel
// array means "no draw" (transparent); positive values index into the motif's
// `colors` array.
//
// Adding a new motif: extend the export with another `const FOO_SPRITE`. Keep
// the `width × height` ≤ 8 px so motifs fit comfortably inside a 16-px tile
// with margin for placement variation.

/**
 * A pixel-art motif. `pixels[r * width + c] === 0` means transparent;
 * positive values index into `colors`.
 */
export interface MotifSprite {
  readonly width: number;
  readonly height: number;
  readonly pixels: ReadonlyArray<number>;
  readonly colors: ReadonlyArray<number>;
}

// ---------------------------------------------------------------------------
// Surface motifs — drawn over the barren-earth base layer.
// ---------------------------------------------------------------------------

/** A 4-blade grass tuft. Center blade tallest, two side blades shorter. */
export const GRASS_TUFT_SPRITE: MotifSprite = {
  width: 5,
  height: 4,
  // 0 = transparent
  // 1 = darker green base (root)
  // 2 = mid green (blade)
  // 3 = lighter green (tip highlight)
  pixels: [
    0, 0, 3, 0, 0,
    0, 2, 2, 0, 3,
    2, 2, 1, 2, 2,
    0, 1, 1, 1, 0,
  ],
  colors: [0, 0x4f6b35, 0x6e8a3f, 0x9bb05a],
};

/** A small dry-grass tuft — yellower, looks like dead/dry grass. */
export const DRY_GRASS_TUFT_SPRITE: MotifSprite = {
  width: 4,
  height: 3,
  pixels: [
    0, 2, 0, 2,
    2, 1, 2, 1,
    1, 1, 0, 1,
  ],
  colors: [0, 0x8a7838, 0xb09858],
};

/** A pebble — small grey rounded pixel cluster. */
export const PEBBLE_SPRITE: MotifSprite = {
  width: 3,
  height: 2,
  pixels: [
    1, 2, 1,
    2, 1, 2,
  ],
  colors: [0, 0x686058, 0x84776a],
};

/** A small dark-grey stone. Slightly larger than a pebble. */
export const SMALL_STONE_SPRITE: MotifSprite = {
  width: 4,
  height: 3,
  pixels: [
    0, 1, 1, 0,
    1, 2, 1, 1,
    1, 1, 1, 0,
  ],
  colors: [0, 0x4a443c, 0x6c6258],
};

/** A short twig — 5 px wide horizontal stick with one knot pixel. */
export const TWIG_SPRITE: MotifSprite = {
  width: 5,
  height: 2,
  pixels: [
    1, 2, 1, 1, 1,
    0, 0, 1, 0, 0,
  ],
  colors: [0, 0x4a3520, 0x6e4f30],
};

/** A dead leaf — desiccated browned curl. */
export const DEAD_LEAF_SPRITE: MotifSprite = {
  width: 4,
  height: 3,
  pixels: [
    0, 1, 2, 0,
    1, 2, 2, 1,
    0, 1, 2, 0,
  ],
  colors: [0, 0x6e4a25, 0x9c6a35],
};

/** A tiny seed/pine-needle accent — single dark pixel cluster. */
export const SEED_SPRITE: MotifSprite = {
  width: 2,
  height: 1,
  pixels: [
    1, 2,
  ],
  colors: [0, 0x3a2a18, 0x5a4028],
};

// ---------------------------------------------------------------------------
// Underground motifs — drawn over solid-rock and open-floor bases.
// ---------------------------------------------------------------------------

/** A cluster of rock flecks — for solid (unexcavated) tiles. */
export const ROCK_FLECK_SPRITE: MotifSprite = {
  width: 3,
  height: 2,
  pixels: [
    1, 0, 2,
    0, 2, 1,
  ],
  colors: [0, 0x564030, 0x7a5b40],
};

/** A short horizontal strata line — geological banding. */
export const STRATA_LINE_SPRITE: MotifSprite = {
  width: 4,
  height: 1,
  pixels: [
    1, 2, 1, 2,
  ],
  colors: [0, 0x3e2d1d, 0x5c4530],
};

/** A small dust speck on the open underground floor. */
export const FLOOR_DUST_SPRITE: MotifSprite = {
  width: 2,
  height: 2,
  pixels: [
    0, 1,
    1, 0,
  ],
  colors: [0, 0x35261c],
};

// ---------------------------------------------------------------------------
// Large multi-tile surface features.
//
// `tilesWide × tilesTall` describes the footprint in 16-pixel tiles. The
// `pixels` array is `(tilesWide * 16) × (tilesTall * 16)` cells, indexed
// `(row * tilesWide * 16) + col`. Pixel values index into `colors` exactly
// like the smaller `MotifSprite` — 0 is transparent (substrate shows
// through).
//
// Drawn at deterministic anchor positions per tile-coordinate hash. Each
// visible tile checks whether any anchor in the W×H window above-left
// covers it; if so it renders the appropriate slice. This means features
// spanning the camera edge still draw their visible portion — no
// "anchor-must-be-onscreen" gotcha.
// ---------------------------------------------------------------------------

export interface LargeFeatureSprite {
  readonly tilesWide: number;
  readonly tilesTall: number;
  readonly pixels: ReadonlyArray<number>;
  readonly colors: ReadonlyArray<number>;
}

// Helper for inlining 2-tile-wide pixel rows readably.
const _ = 0; // transparent

/**
 * A chunky boulder, 2 tiles wide × 2 tiles tall (32×32 px). Light-grey crown,
 * darker shadowed underside, occasional moss highlight on the top-left.
 *
 * Palette:
 *   1 = mid grey (rock body)
 *   2 = light grey (top-light highlight)
 *   3 = dark grey (under-shadow)
 *   4 = mossy green (sparse top accent)
 */
export const LARGE_BOULDER_SPRITE: LargeFeatureSprite = {
  tilesWide: 2,
  tilesTall: 2,
  colors: [0, 0x6b6258, 0x8b8278, 0x4a4338, 0x6e7c45],
  pixels: [
    // 32×32 grid (16 wide × 16 tall × 2). Row-major.
    _,_,_,_,_,_,_,2,2,2,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,2,2,2,2,2,2,2,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,2,2,2,2,2,2,2,4,2,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,2,2,2,2,1,1,2,2,2,2,2,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,2,2,1,1,1,1,1,1,1,1,2,2,2,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,2,1,1,1,1,1,1,1,1,1,1,2,2,2, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,2,2,1,1,1,1,1,1,1,1,1,1,1,2,2, 2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,2,1,1,1,1,1,1,1,1,1,1,1,1,1,2, 2,2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 2,2,2,_,_,_,_,_,_,_,_,_,_,_,_,_,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,2,2,_,_,_,_,_,_,_,_,_,_,_,_,_,
    2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,2,2,2,_,_,_,_,_,_,_,_,_,_,_,_,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,2,2,2,_,_,_,_,_,_,_,_,_,_,_,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,2,2,_,_,_,_,_,_,_,_,_,_,_,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,2,_,_,_,_,_,_,_,_,_,_,_,
    1,1,1,1,3,3,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,2,2,_,_,_,_,_,_,_,_,_,_,
    1,1,3,3,3,3,3,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,2,_,_,_,_,_,_,_,_,_,_,

    1,3,3,3,3,3,3,3,1,1,1,1,1,1,1,1, 1,1,1,1,1,2,2,_,_,_,_,_,_,_,_,_,
    3,3,3,3,3,3,3,3,3,1,1,1,1,1,1,1, 1,1,1,1,1,1,2,_,_,_,_,_,_,_,_,_,
    3,3,3,3,3,3,3,3,3,3,1,1,1,1,1,1, 1,1,1,1,1,1,2,_,_,_,_,_,_,_,_,_,
    3,3,3,3,3,3,3,3,3,3,3,1,1,1,1,1, 1,1,1,1,1,1,1,_,_,_,_,_,_,_,_,_,
    _,3,3,3,3,3,3,3,3,3,3,3,1,1,1,1, 1,1,1,1,1,1,_,_,_,_,_,_,_,_,_,_,
    _,3,3,3,3,3,3,3,3,3,3,3,3,3,1,1, 1,1,1,1,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,3,3,3,3,3,3,3,3,3,3,3,3,3,3, 3,3,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,3,3,3,3,3,3,3,3,3,3,3,3,3, 3,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,3,3,3,3,3,3,3,3,3,3,3,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  ],
};

/**
 * A second boulder variant — flatter, slightly more elongated. Same palette
 * so the registry can pick between this and `LARGE_BOULDER_SPRITE` per
 * anchor hash and the result still reads as "boulders are grey".
 */
export const LARGE_BOULDER_SPRITE_FLAT: LargeFeatureSprite = {
  tilesWide: 2,
  tilesTall: 2,
  colors: [0, 0x6b6258, 0x8b8278, 0x4a4338, 0x6e7c45],
  pixels: [
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,2,2, 2,2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,2,2,2,2,2,2, 2,2,2,2,2,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,2,2,2,2,2,2,2,2,2, 4,2,2,2,2,2,2,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,2,2,2,2,2,1,1,1,1,1,1, 1,1,2,2,2,2,2,2,_,_,_,_,_,_,_,_,
    _,_,_,_,2,2,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,2,2,2,_,_,_,_,_,_,_,
    _,_,_,2,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,2,2,2,_,_,_,_,_,_,
    _,_,2,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,2,2,_,_,_,_,_,

    _,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,2,_,_,_,_,
    2,1,1,1,1,3,3,3,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,2,_,_,_,
    2,1,3,3,3,3,3,3,3,3,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,2,_,_,_,
    2,3,3,3,3,3,3,3,3,3,3,3,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,2,2,_,_,_,
    _,2,3,3,3,3,3,3,3,3,3,3,3,3,3,1, 1,1,1,1,1,1,1,1,1,1,2,2,_,_,_,_,
    _,_,2,3,3,3,3,3,3,3,3,3,3,3,3,3, 3,3,3,3,3,3,3,3,3,2,2,_,_,_,_,_,
    _,_,_,2,2,3,3,3,3,3,3,3,3,3,3,3, 3,3,3,3,3,3,3,3,2,2,_,_,_,_,_,_,
    _,_,_,_,_,2,2,2,2,2,2,2,2,2,2,2, 2,2,2,2,2,2,2,2,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  ],
};

/**
 * A leafy bush — 2×2 tiles. Round leafy crown, darker centers, woody base.
 *
 * Palette:
 *   1 = mid green leaf
 *   2 = darker green shadow
 *   3 = lighter green highlight
 *   4 = brown stem
 */
export const LARGE_BUSH_SPRITE: LargeFeatureSprite = {
  tilesWide: 2,
  tilesTall: 2,
  colors: [0, 0x4a6b30, 0x2f4a20, 0x6e8a40, 0x3a2818],
  pixels: [
    _,_,_,_,_,_,3,3,3,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,3,3,1,1,1,3,3,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,3,1,1,1,1,1,1,1,3,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,3,1,1,1,2,2,1,1,1,1,3,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,3,1,1,1,2,2,2,2,1,1,1,1,3,_,_, _,_,_,_,_,_,_,3,3,_,_,_,_,_,_,_,
    _,3,1,1,1,2,2,2,2,2,1,1,1,1,3,_, _,_,3,3,1,1,1,1,1,1,3,_,_,_,_,_,
    3,1,1,1,1,1,2,2,2,1,1,1,1,1,1,3, 3,1,1,1,1,1,1,2,2,1,1,3,_,_,_,_,
    3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,3, 1,1,1,1,1,2,2,2,2,1,1,1,3,_,_,_,
    3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,2,2,2,2,2,2,1,1,3,_,_,_,
    3,3,1,1,1,1,1,2,2,1,1,1,1,1,1,1, 1,1,1,2,2,2,2,2,2,2,1,1,1,3,_,_,
    _,3,1,1,1,1,2,2,2,2,1,1,1,1,1,1, 1,1,2,2,2,1,1,1,2,2,1,1,1,3,_,_,
    _,3,3,1,1,1,2,2,2,2,2,1,1,1,1,1, 1,1,1,2,2,1,1,1,2,2,1,1,1,1,3,_,
    _,_,3,3,1,1,1,2,2,2,2,1,1,1,1,1, 1,1,1,1,2,2,2,2,2,1,1,1,1,1,3,_,
    _,_,_,3,3,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,2,2,2,1,1,1,1,1,1,3,_,
    _,_,_,_,3,3,3,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,1,3,_,_,
    _,_,_,_,_,_,3,3,3,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,3,3,3,_,_,_,

    _,_,_,_,_,_,_,_,3,3,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,3,3,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,3,3,1,1,1,1, 1,1,1,1,1,3,3,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,3,3,1,4, 4,1,3,3,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,4,4, 4,4,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,4,4, 4,4,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,4, 4,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  ],
};

/**
 * A second bush variant — taller, narrower silhouette, more spiky.
 */
export const LARGE_BUSH_SPRITE_TALL: LargeFeatureSprite = {
  tilesWide: 2,
  tilesTall: 2,
  colors: [0, 0x4a6b30, 0x2f4a20, 0x6e8a40, 0x3a2818],
  pixels: [
    _,_,_,_,_,_,_,_,3,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,3,1,3,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,3,1,1,1,3,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,3,1,1,1,1,1,3,_,_,_,_, _,_,_,_,_,_,_,_,_,_,3,_,_,_,_,_,
    _,_,_,_,3,1,1,1,2,1,1,1,3,_,_,_, _,_,_,_,_,_,_,_,3,1,1,3,_,_,_,_,
    _,_,_,3,1,1,1,2,2,2,1,1,1,3,_,_, _,_,_,_,_,_,_,3,1,1,1,3,_,_,_,_,
    _,_,3,1,1,1,2,2,2,2,2,1,1,1,3,_, _,_,_,_,_,3,3,1,1,1,2,1,3,_,_,_,
    _,3,1,1,1,1,2,2,2,2,2,2,1,1,1,3, _,_,_,3,3,1,1,1,2,2,2,1,1,3,_,_,
    3,1,1,1,1,1,1,2,2,2,2,2,1,1,1,1, 3,3,3,1,1,1,2,2,2,2,2,1,1,1,3,_,
    1,1,1,1,1,1,1,1,2,2,2,1,1,1,1,1, 1,1,1,1,2,2,2,2,2,2,2,1,1,1,3,_,
    1,1,2,1,1,1,1,1,1,2,2,1,1,1,1,1, 1,1,2,2,2,2,1,1,2,2,2,1,1,1,1,3,
    1,2,2,2,1,1,1,1,1,1,2,1,1,1,1,1, 1,2,2,2,1,1,1,1,1,2,2,1,1,1,1,3,
    1,1,2,2,2,1,1,1,1,1,1,1,1,1,1,1, 1,1,2,2,1,1,1,1,1,1,2,1,1,1,1,_,
    1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,1,1,_,_,
    _,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,1,_,_,_,
    _,_,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,_,_,_,_,

    _,_,_,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,_,_,_,_,_,
    _,_,_,_,1,1,1,1,1,1,1,1,1,1,4,4, 4,1,1,1,1,1,1,1,1,1,_,_,_,_,_,_,
    _,_,_,_,_,1,1,1,1,1,1,1,4,4,4,4, 4,4,4,1,1,1,1,1,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,4,4,4,4, 4,4,4,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,4,4,_, _,4,4,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,4,_,_, _,_,4,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  ],
};

/**
 * A wide grass clump — 2 tiles wide × 1 tile tall (32×16 px). Multiple
 * blades varied in height, mid-green dominant.
 *
 * Palette:
 *   1 = blade base/dark
 *   2 = blade mid
 *   3 = blade tip highlight
 */
export const LARGE_GRASS_CLUMP_SPRITE: LargeFeatureSprite = {
  tilesWide: 2,
  tilesTall: 1,
  colors: [0, 0x3f5a25, 0x5d7a35, 0x8aa550],
  pixels: [
    _,_,_,3,_,_,3,_,_,_,_,_,_,3,_,_, _,_,_,3,_,_,_,_,_,_,3,_,_,_,_,_,
    _,_,2,2,_,2,2,_,_,3,_,2,2,2,_,3, _,_,2,2,_,3,_,_,_,2,2,_,_,_,3,_,
    _,_,2,2,_,2,2,_,_,2,2,2,2,2,_,2, _,_,2,2,_,2,_,_,_,2,2,_,_,2,2,_,
    _,2,2,2,_,2,2,_,2,2,2,2,2,2,2,2, _,2,2,2,_,2,2,_,2,2,2,_,2,2,2,_,
    _,2,2,2,2,2,2,2,2,2,2,2,1,2,2,2, 2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,_,
    1,2,2,2,2,2,2,2,2,2,1,1,1,1,2,2, 2,2,2,2,2,2,1,1,2,2,2,2,2,2,2,2,
    1,1,2,2,1,2,2,1,1,1,1,1,1,1,1,1, 2,1,1,2,2,1,1,1,1,2,2,1,2,2,2,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    _,1,1,1,1,1,1,1,1,1,1,1,1,1,1,_, _,_,1,1,_,_,1,1,1,1,1,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  ],
};

/** A second grass-clump variant — sparser, taller front blades. */
export const LARGE_GRASS_CLUMP_SPRITE_SPARSE: LargeFeatureSprite = {
  tilesWide: 2,
  tilesTall: 1,
  colors: [0, 0x3f5a25, 0x5d7a35, 0x8aa550],
  pixels: [
    _,_,_,_,3,_,_,_,_,3,_,_,_,_,_,_, _,_,_,_,_,_,3,_,_,_,_,_,3,_,_,_,
    _,_,_,3,2,_,_,_,3,2,_,_,_,_,3,_, _,_,_,_,3,_,2,_,_,_,_,3,2,_,_,_,
    _,_,3,2,2,_,_,_,2,2,_,_,_,3,2,_, _,_,_,3,2,_,2,_,_,_,3,2,2,_,_,_,
    _,3,2,2,2,_,_,3,2,2,3,_,_,2,2,_, _,_,3,2,2,_,2,_,3,_,2,2,2,2,_,_,
    3,2,2,2,2,_,3,2,2,2,2,3,_,2,2,_, _,3,2,2,2,3,2,_,2,_,2,2,1,2,_,_,
    2,2,2,2,2,3,2,2,2,2,2,2,_,2,2,_, _,2,2,1,2,2,2,3,2,3,2,1,1,1,2,_,
    2,1,2,2,2,2,2,1,2,2,2,2,_,1,1,_, _,1,1,1,1,1,1,2,2,2,1,1,1,1,1,_,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,_,
    _,1,1,1,1,1,1,1,1,1,1,1,1,1,_,_, _,_,1,1,1,1,1,1,_,_,1,1,1,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
    _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_, _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  ],
};

// ---------------------------------------------------------------------------
// SURFACE_FEATURE_SPRITES — kind→sprite[] map consumed by terrain-atlas.ts
// when rendering the slice the sim-side surface-feature selector returned.
//
// Issue #44 step 2: render no longer owns the layout decision (which anchor
// goes where). The sim selector
// (`src/sim/surface-features.ts → surfaceFeatureAt`) returns
// `{ kind, variantIndex }` and render translates that pair into the
// pixel-art sprite to draw via this map.
//
// Invariant (enforced at module load below):
//   For every entry, `sprites[i].tilesWide === footprintTilesWide` and
//   `sprites[i].tilesTall === footprintTilesTall` from the registry, AND
//   `sprites.length === variantCount`. A mismatch means the sim and render
//   sides have drifted and the rendered slice will misalign.
// ---------------------------------------------------------------------------

import {
  SurfaceFeatureKind,
  getSurfaceFeatureRegistryEntry,
  type SurfaceFeatureKind as SurfaceFeatureKindType,
} from '../sim/surface-features.js';

export const SURFACE_FEATURE_SPRITES: Readonly<Record<SurfaceFeatureKindType, ReadonlyArray<LargeFeatureSprite>>> = {
  [SurfaceFeatureKind.Boulder]:    [LARGE_BOULDER_SPRITE,    LARGE_BOULDER_SPRITE_FLAT],
  [SurfaceFeatureKind.Bush]:       [LARGE_BUSH_SPRITE,       LARGE_BUSH_SPRITE_TALL],
  [SurfaceFeatureKind.GrassClump]: [LARGE_GRASS_CLUMP_SPRITE, LARGE_GRASS_CLUMP_SPRITE_SPARSE],
};

// Boot-time integrity check: each sprite array's length and footprint
// dimensions must agree with the sim-side registry. Catches drift that
// would otherwise silently misrender slices when a future contributor
// adds a variant on one side and forgets the other.
for (const kindStr of Object.keys(SURFACE_FEATURE_SPRITES)) {
  const kind = Number(kindStr) as SurfaceFeatureKindType;
  const entry = getSurfaceFeatureRegistryEntry(kind);
  if (entry === null) {
    throw new Error(`SURFACE_FEATURE_SPRITES has unknown kind=${kind}`);
  }
  const sprites = SURFACE_FEATURE_SPRITES[kind];
  if (sprites.length !== entry.variantCount) {
    throw new Error(
      `SURFACE_FEATURE_SPRITES[kind=${kind}]: ${sprites.length} sprites but ` +
      `registry variantCount=${entry.variantCount}`,
    );
  }
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i]!;
    if (s.tilesWide !== entry.footprintTilesWide || s.tilesTall !== entry.footprintTilesTall) {
      throw new Error(
        `SURFACE_FEATURE_SPRITES[kind=${kind}] variant[${i}]: ` +
        `${s.tilesWide}×${s.tilesTall} but registry footprint=` +
        `${entry.footprintTilesWide}×${entry.footprintTilesTall}`,
      );
    }
  }
}
