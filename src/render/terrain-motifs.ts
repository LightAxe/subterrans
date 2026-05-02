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

// (The legacy `_` const and ASCII `bitmap` helper were removed in issue #44
// step 3 — all small motifs use literal 0/1/2/... and all large features
// build their pixels procedurally via sprite-shapes.ts.)

// ---------------------------------------------------------------------------
// Large multi-tile features — issue #44 step 3 redesign.
//
// All large features now ship at 3×3 tiles or larger so they read as
// imposing at ant scale. Variants are built procedurally via the helpers
// in `sprite-shapes.ts` rather than hand-authored bitmap arrays:
//   - keeps source under 700 lines instead of 4000+ for 16 sprites,
//   - keeps the "darker base, lighter tip" layered shading consistent
//     across kinds (the issue called for that depth cue),
//   - lets future tuning happen by tweaking parameters instead of
//     hand-editing pixels.
//
// Each kind exports an array of variants. The number of variants must
// match the sim-side `variantCount` (boot-time check below). Sprite
// pixel data is built once at module load — `pixels: ReadonlyArray<number>`
// is captured by the `LargeFeatureSprite` literal and never recomputed.
// ---------------------------------------------------------------------------

import {
  makeCanvas,
  paintOval,
  paintRect,
  paintLine,
  paintGrassBlade,
  paintFlecks,
} from './sprite-shapes.js';

// ---------------------------------------------------------------------------
// Boulder — 3×3 (48×48 px), 3 variants. Mid-grey body, lighter top, darker
// base; lichen variant adds mossy green flecks.
// ---------------------------------------------------------------------------

const BOULDER_PALETTE = [0, 0x6b6258, 0x8b8278, 0x4a4338, 0x6e7c45] as const;

function buildBoulderRound(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  paintOval(c, 48, 24, 28, 22, 17, 1);  // mid-grey body
  paintOval(c, 48, 26, 41, 18, 5, 3);   // dark crescent shadow at base
  paintOval(c, 48, 21, 19, 14, 9, 2);   // lighter top-left highlight
  return c;
}

function buildBoulderFlat(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  paintOval(c, 48, 24, 32, 23, 13, 1);  // wider, lower body
  paintOval(c, 48, 26, 42, 20, 4, 3);   // heavy bottom shadow
  paintOval(c, 48, 22, 22, 17, 6, 2);   // narrow top-light strip
  return c;
}

function buildBoulderLichen(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  paintOval(c, 48, 24, 28, 22, 17, 1);
  paintOval(c, 48, 26, 41, 18, 5, 3);
  paintOval(c, 48, 21, 19, 14, 9, 2);
  paintFlecks(c, 48, 18, 8, 13, 38, 24, 4, 0x42);  // mossy green crown
  return c;
}

export const LARGE_BOULDER_SPRITE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: BOULDER_PALETTE, pixels: buildBoulderRound(),
};
export const LARGE_BOULDER_SPRITE_FLAT: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: BOULDER_PALETTE, pixels: buildBoulderFlat(),
};
export const LARGE_BOULDER_SPRITE_LICHEN: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: BOULDER_PALETTE, pixels: buildBoulderLichen(),
};

// ---------------------------------------------------------------------------
// Bush — 3×3 (48×48 px), 3 variants. Reframed for ant scale as a wildflower
// /clover clump (small dense plants ants push through, not a literal shrub).
// SoftCost movement effect — ants slow but pass.
// ---------------------------------------------------------------------------

const BUSH_PALETTE = [
  0,
  0x4a6d2e,  // 1: dark green leaf base
  0x6f9540,  // 2: mid green leaf body
  0x9ab85a,  // 3: light green leaf tip / fleck
  0xe8d97a,  // 4: pale yellow flower edge
  0xf4eb9a,  // 5: bright yellow flower center
] as const;

function buildBushClover(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  // Three overlapping leaf clusters at varied positions.
  paintOval(c, 48, 16, 32, 12, 10, 1);
  paintOval(c, 48, 32, 30, 13, 12, 1);
  paintOval(c, 48, 24, 24, 11, 11, 1);
  // Mid-green highlights on top of each cluster.
  paintOval(c, 48, 16, 28, 8, 5, 2);
  paintOval(c, 48, 32, 24, 9, 6, 2);
  paintOval(c, 48, 24, 20, 7, 4, 2);
  // Tip flecks for surface texture.
  paintFlecks(c, 48, 12, 10, 16, 38, 30, 3, 0x77);
  return c;
}

function buildBushFlower(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  // Three vertical stems.
  paintRect(c, 48, 22, 28, 24, 42, 1);
  paintRect(c, 48, 16, 32, 18, 42, 1);
  paintRect(c, 48, 30, 32, 32, 42, 1);
  // Flower clusters at top of each stem.
  paintOval(c, 48, 23, 24, 6, 5, 5);
  paintOval(c, 48, 17, 28, 5, 4, 5);
  paintOval(c, 48, 31, 28, 5, 4, 5);
  paintOval(c, 48, 23, 23, 3, 2, 4);
  paintOval(c, 48, 17, 27, 3, 2, 4);
  paintOval(c, 48, 31, 27, 3, 2, 4);
  // Leaf hint at base.
  paintOval(c, 48, 24, 42, 14, 4, 1);
  paintOval(c, 48, 18, 42, 4, 3, 2);
  paintOval(c, 48, 30, 42, 4, 3, 2);
  return c;
}

function buildBushDense(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  // Dense leaf cluster, no flowers — ant pushes through a wall of leaves.
  paintOval(c, 48, 24, 30, 20, 14, 1);
  paintOval(c, 48, 16, 24, 6, 4, 2);
  paintOval(c, 48, 28, 22, 7, 5, 2);
  paintOval(c, 48, 22, 28, 5, 3, 3);
  paintOval(c, 48, 32, 30, 6, 4, 2);
  paintOval(c, 48, 18, 32, 5, 3, 3);
  paintFlecks(c, 48, 14, 8, 18, 40, 36, 3, 0x33);
  return c;
}

export const LARGE_BUSH_SPRITE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: BUSH_PALETTE, pixels: buildBushClover(),
};
export const LARGE_BUSH_SPRITE_TALL: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: BUSH_PALETTE, pixels: buildBushFlower(),
};
export const LARGE_BUSH_SPRITE_DENSE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: BUSH_PALETTE, pixels: buildBushDense(),
};

// ---------------------------------------------------------------------------
// Grass clump — 3×3 (48×48 px), 3 variants, vertical bias. Ants at this
// scale see grass blades as towering vertical spikes; the new variants lean
// into that with tall, narrow blades that span most of the tile height.
// SoftCost movement effect.
// ---------------------------------------------------------------------------

const GRASS_PALETTE = [
  0,
  0x3f5a25,  // 1: dark green base
  0x5d7a35,  // 2: mid green blade
  0x8aa550,  // 3: light green tip
  0xb3c87a,  // 4: pale tip highlight (rare)
] as const;

function buildGrassDense(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  for (let i = 0; i < 14; i++) {
    const baseX = 4 + i * 3;
    const tipX = baseX + (i % 3) - 1;     // slight per-blade lean
    const tipY = 8 + ((i * 7) % 12);      // varying heights
    paintGrassBlade(c, 48, baseX, 44, tipX, tipY, 1, 2, 3);
  }
  paintFlecks(c, 48, 6, 5, 8, 42, 16, 4, 0x55);  // pale tip highlights
  return c;
}

function buildGrassSparse(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  // Five tall, well-spaced blades — sparser silhouette.
  const blades: ReadonlyArray<readonly [number, number, number]> = [
    [10,  9, 4],
    [18, 16, 7],
    [25, 27, 3],
    [33, 31, 9],
    [40, 38, 6],
  ];
  for (const [bx, tx, ty] of blades) {
    paintGrassBlade(c, 48, bx, 44, tx, ty, 1, 2, 3);
  }
  return c;
}

function buildGrassTilted(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  // Blades all leaning rightward — wind motion at ant scale.
  for (let i = 0; i < 10; i++) {
    const baseX = 5 + i * 4;
    const tipX = baseX + 6 + (i % 3);
    const tipY = 4 + ((i * 5) % 10);
    paintGrassBlade(c, 48, baseX, 44, tipX, tipY, 1, 2, 3);
  }
  return c;
}

export const LARGE_GRASS_CLUMP_SPRITE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: GRASS_PALETTE, pixels: buildGrassDense(),
};
export const LARGE_GRASS_CLUMP_SPRITE_SPARSE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: GRASS_PALETTE, pixels: buildGrassSparse(),
};
export const LARGE_GRASS_CLUMP_SPRITE_TILTED: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: GRASS_PALETTE, pixels: buildGrassTilted(),
};

// ---------------------------------------------------------------------------
// Twig — 4×2 (64×32 px), 2 variants. Long, low silhouette — fallen
// twig that an ant must walk around (HardBlock). Wood-brown palette with
// bark texture flecks.
// ---------------------------------------------------------------------------

const TWIG_PALETTE = [
  0,
  0x6b4a28,  // 1: mid brown body
  0x8c6438,  // 2: light brown highlight
  0x4a3018,  // 3: dark brown shadow
  0xa07b48,  // 4: pale bark grain
  0x3d2310,  // 5: deep shadow accent
] as const;

function buildTwigSmooth(): ReadonlyArray<number> {
  const c = makeCanvas(64, 32);
  // Cylindrical body with rounded end caps.
  paintRect(c, 64, 5, 13, 59, 19, 1);
  paintOval(c, 64,  4, 16, 4, 4, 1);
  paintOval(c, 64, 60, 16, 4, 4, 1);
  // Top highlight strip and bottom shadow strip.
  paintRect(c, 64, 7, 12, 57, 13, 2);
  paintRect(c, 64, 7, 19, 57, 20, 3);
  paintRect(c, 64, 9, 21, 55, 21, 5);
  // Darker end caps.
  paintOval(c, 64,  4, 16, 3, 5, 3);
  paintOval(c, 64, 60, 16, 3, 5, 3);
  // Bark grain flecks.
  paintFlecks(c, 64, 22, 8, 14, 56, 18, 4, 0x99);
  return c;
}

function buildTwigBark(): ReadonlyArray<number> {
  const c = makeCanvas(64, 32);
  // Slightly thinner body with heavier bark texture.
  paintRect(c, 64, 4, 14, 60, 18, 1);
  paintOval(c, 64, 32, 16, 30, 4, 1);
  paintRect(c, 64, 6, 13, 58, 13, 2);
  paintRect(c, 64, 6, 19, 58, 19, 3);
  paintFlecks(c, 64, 35, 7, 14, 57, 18, 5, 0xab);
  paintFlecks(c, 64, 25, 7, 13, 57, 14, 4, 0xcd);
  return c;
}

export const LARGE_TWIG_SPRITE: LargeFeatureSprite = {
  tilesWide: 4, tilesTall: 2, colors: TWIG_PALETTE, pixels: buildTwigSmooth(),
};
export const LARGE_TWIG_SPRITE_BARK: LargeFeatureSprite = {
  tilesWide: 4, tilesTall: 2, colors: TWIG_PALETTE, pixels: buildTwigBark(),
};

// ---------------------------------------------------------------------------
// Leaf — 3×3 (48×48 px), 3 variants. Dead/dry leaf occupying real screen
// real estate. HardBlock — ants navigate around, not over.
// ---------------------------------------------------------------------------

const LEAF_PALETTE = [
  0,
  0x8a5a28,  // 1: mid brown leaf body
  0xb07a40,  // 2: light brown highlight
  0xc89358,  // 3: pale tan top edge
  0x654020,  // 4: dark brown vein/edge
  0x9a6c30,  // 5: mid-dark brown vein
] as const;

function buildLeafBroad(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  paintOval(c, 48, 24, 24, 20, 16, 1);
  paintOval(c, 48, 22, 18, 14, 8, 2);
  // Veins (central + 6 side veins).
  paintLine(c, 48, 24,  8, 24, 40, 4);
  paintLine(c, 48, 24, 16, 12, 22, 5);
  paintLine(c, 48, 24, 16, 36, 22, 5);
  paintLine(c, 48, 24, 24, 10, 30, 5);
  paintLine(c, 48, 24, 24, 38, 30, 5);
  paintLine(c, 48, 24, 32, 14, 36, 5);
  paintLine(c, 48, 24, 32, 34, 36, 5);
  return c;
}

function buildLeafCurled(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  // Half body — leaf curled inward at the top.
  paintOval(c, 48, 24, 28, 22, 12, 1);
  // Rolled curl visible as inverted darker arc near the top.
  paintOval(c, 48, 24, 20, 18, 6, 4);
  paintOval(c, 48, 24, 18, 16, 4, 3);
  // Base shading.
  paintOval(c, 48, 24, 36, 18, 4, 5);
  // Central vein.
  paintLine(c, 48, 24, 22, 24, 38, 4);
  return c;
}

function buildLeafTorn(): ReadonlyArray<number> {
  const c = makeCanvas(48, 48);
  paintOval(c, 48, 24, 24, 19, 14, 1);
  paintOval(c, 48, 22, 18, 12, 6, 2);
  // Veins.
  paintLine(c, 48, 24, 10, 24, 38, 4);
  paintLine(c, 48, 24, 18, 14, 24, 5);
  paintLine(c, 48, 24, 26, 36, 30, 5);
  // Torn-edge gaps (overpaint with transparent).
  for (let y = 22; y <= 26; y++) {
    for (let x = 4; x <= 8; x++) c[y * 48 + x] = 0;
  }
  for (let y = 24; y <= 28; y++) {
    for (let x = 40; x <= 44; x++) c[y * 48 + x] = 0;
  }
  for (let y = 36; y <= 40; y++) {
    for (let x = 22; x <= 28; x++) c[y * 48 + x] = 0;
  }
  return c;
}

export const LARGE_LEAF_SPRITE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: LEAF_PALETTE, pixels: buildLeafBroad(),
};
export const LARGE_LEAF_SPRITE_CURLED: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: LEAF_PALETTE, pixels: buildLeafCurled(),
};
export const LARGE_LEAF_SPRITE_TORN: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 3, colors: LEAF_PALETTE, pixels: buildLeafTorn(),
};

// ---------------------------------------------------------------------------
// Big leaf — 3×4 (48×64 px), 2 variants. The "ship-sized canopy" the issue
// called for: a single large leaf that dominates its region. Vertical
// orientation. HardBlock.
// ---------------------------------------------------------------------------

const BIG_LEAF_PALETTE = [
  0,
  0x7a4818,
  0xa8722c,
  0xc89344,
  0x523010,
  0x8b5828,
] as const;

function buildBigLeafBroad(): ReadonlyArray<number> {
  const c = makeCanvas(48, 64);
  // Pointed oval, vertical orientation.
  paintOval(c, 48, 24, 32, 22, 28, 1);
  paintOval(c, 48, 22, 18, 16, 10, 2);
  paintOval(c, 48, 24, 14, 8, 4, 3);
  // Central vein from tip to base.
  paintLine(c, 48, 24,  6, 24, 58, 4);
  // Side veins (5 pairs, fanning outward).
  for (let i = 0; i < 5; i++) {
    const y = 14 + i * 9;
    paintLine(c, 48, 24, y,  8 + i * 1, y + 8, 5);
    paintLine(c, 48, 24, y, 40 - i * 1, y + 8, 5);
  }
  paintOval(c, 48, 24, 56, 18, 5, 4);  // base shadow
  return c;
}

function buildBigLeafTorn(): ReadonlyArray<number> {
  const c = makeCanvas(48, 64);
  paintOval(c, 48, 24, 32, 22, 26, 1);
  paintOval(c, 48, 22, 20, 16, 9, 2);
  paintLine(c, 48, 24,  8, 24, 56, 4);
  for (let i = 0; i < 5; i++) {
    const y = 14 + i * 9;
    paintLine(c, 48, 24, y,  6 + i, y + 8, 5);
    paintLine(c, 48, 24, y, 42 - i, y + 8, 5);
  }
  // Tears (overpaint transparent).
  for (let y = 30; y <= 36; y++) {
    for (let x =  0; x <=  6; x++) c[y * 48 + x] = 0;
  }
  for (let y = 26; y <= 32; y++) {
    for (let x = 42; x <= 47; x++) c[y * 48 + x] = 0;
  }
  for (let y = 50; y <= 56; y++) {
    for (let x =  6; x <= 14; x++) c[y * 48 + x] = 0;
  }
  return c;
}

export const LARGE_BIG_LEAF_SPRITE: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 4, colors: BIG_LEAF_PALETTE, pixels: buildBigLeafBroad(),
};
export const LARGE_BIG_LEAF_SPRITE_TORN: LargeFeatureSprite = {
  tilesWide: 3, tilesTall: 4, colors: BIG_LEAF_PALETTE, pixels: buildBigLeafTorn(),
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
  [SurfaceFeatureKind.Boulder]:    [LARGE_BOULDER_SPRITE,    LARGE_BOULDER_SPRITE_FLAT,    LARGE_BOULDER_SPRITE_LICHEN],
  [SurfaceFeatureKind.Bush]:       [LARGE_BUSH_SPRITE,       LARGE_BUSH_SPRITE_TALL,       LARGE_BUSH_SPRITE_DENSE],
  [SurfaceFeatureKind.GrassClump]: [LARGE_GRASS_CLUMP_SPRITE, LARGE_GRASS_CLUMP_SPRITE_SPARSE, LARGE_GRASS_CLUMP_SPRITE_TILTED],
  [SurfaceFeatureKind.Twig]:       [LARGE_TWIG_SPRITE,       LARGE_TWIG_SPRITE_BARK],
  [SurfaceFeatureKind.Leaf]:       [LARGE_LEAF_SPRITE,       LARGE_LEAF_SPRITE_CURLED,     LARGE_LEAF_SPRITE_TORN],
  [SurfaceFeatureKind.BigLeaf]:    [LARGE_BIG_LEAF_SPRITE,   LARGE_BIG_LEAF_SPRITE_TORN],
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
