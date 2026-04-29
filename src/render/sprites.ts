// sprites.ts — Phase 8 render-layer color palette, canvas dimensions, HUD zone layout, and color utilities.
//
// Source: PRD §7g (03-PRD-world-interaction.md) for color constants,
//         PRD §6b (04-PRD-playable-game-loop.md) for HUD zone layout.
//
// This file is in src/render/ — ESLint simSafetyConfig does NOT apply here.
// Float arithmetic is permitted in the render layer per ARCHITECTURE.md Principle 6.
// No Phaser imports — pure TypeScript utilities for use by the render pipeline.

// ---------------------------------------------------------------------------
// Canvas dimensions (PRD §6b)
// ---------------------------------------------------------------------------

/** Tile size in pixels — the fundamental render unit. PRD §7g normative. */
export const TILE_SIZE_PX = 16;

/** Canvas width in pixels. PRD §6b normative: 800×592. */
export const CANVAS_W = 800;

/** Canvas height in pixels. PRD §6b normative: 800×592. */
export const CANVAS_H = 592;

// ---------------------------------------------------------------------------
// Color palette — PRD §7g normative hex values
// ---------------------------------------------------------------------------

/** PRD §7g — Primary surface grass tile color. */
export const COLOR_SURFACE_GRASS_PRIMARY = 0x4a7c40;

/** Darker grass pixels for render-only terrain texture detail. */
export const COLOR_SURFACE_GRASS_DARK = 0x355f30;

/** PRD §7g — Surface dirt tile color. */
export const COLOR_SURFACE_DIRT = 0x8b6914;

/** Darker dirt pixels for render-only terrain texture detail. */
export const COLOR_SURFACE_DIRT_DARK = 0x64470d;

/** Lighter dirt pixels for render-only terrain texture detail. */
export const COLOR_SURFACE_DIRT_LIGHT = 0xa77f25;

/** PRD §7g — Food pile (unmarked) color. */
export const COLOR_FOOD_PILE_NORMAL = 0x22bb44;

/** PRD §7g — Food pile (player-marked for collection) color. */
export const COLOR_FOOD_PILE_MARKED = 0xffdd00;

/** PRD §7g — Surface entrance hole color. */
export const COLOR_SURFACE_ENTRANCE_HOLE = 0x1a0f00;

/** PRD §7g — Rally point marker color. */
export const COLOR_RALLY_POINT = 0xffffff;

/** PRD §7g — Underground solid (unexcavated) tile color. */
export const COLOR_UNDERGROUND_SOLID = 0x2d1a0a;

/** Rock flecks for render-only solid underground texture detail. */
export const COLOR_UNDERGROUND_SOLID_ROCK = 0x49301a;

/** PRD §7g — Underground open (excavated) tile color. */
export const COLOR_UNDERGROUND_OPEN = 0x0d0805;

/** Subtle floor pixels for render-only open underground texture detail. */
export const COLOR_UNDERGROUND_OPEN_DUST = 0x25170f;

/** PRD §7g — Dig-marked tile overlay color (blue tint). */
export const COLOR_MARKED_TILE_OVERLAY = 0x4a8fff;

/** PRD §7g — Tile currently being excavated overlay color. */
export const COLOR_BEING_DUG_OVERLAY = 0x8b6000;

/** PRD §7g — Underground ceiling strip (top row, shows entrance alignment). */
export const COLOR_UNDERGROUND_CEILING_STRIP = 0x3d6b35;

/** PRD §7g — Queen chamber floor color. */
export const COLOR_CHAMBER_QUEEN = 0x1a0d1a;

/** PRD §7g — Nursery chamber floor color. */
export const COLOR_CHAMBER_NURSERY = 0x0d1a0d;

/** PRD §7g — Food storage chamber floor color. */
export const COLOR_CHAMBER_FOOD_STORAGE = 0x1a1400;

/** Visible amber for the stored-food fill inside FoodStorage chambers. */
export const COLOR_CHAMBER_FOOD_STORAGE_FILL = 0xb8872a;

/** PRD §7g — Player colony ant body color. */
export const COLOR_PLAYER_COLONY = 0x4a2800;

/** PRD §7g — Enemy colony ant body color. */
export const COLOR_ENEMY_COLONY = 0xcc1a00;

/** PRD §7g — Queen outline highlight color. */
export const COLOR_QUEEN_OUTLINE = 0xffd700;

/** PRD §7g — Ant egg color. */
export const COLOR_ANT_EGG = 0xf5f0e0;

/** PRD §7g — Ant larvae color. */
export const COLOR_ANT_LARVAE = 0xe8d4a0;

/** PRD §7g — Food-trail pheromone (low intensity) color. */
export const COLOR_PHEROMONE_FOOD_FAINT = 0x004020;

/** PRD §7g — Food-trail pheromone (high intensity) color. */
export const COLOR_PHEROMONE_FOOD_STRONG = 0x00ff80;

/** PRD §7g — Danger-trail pheromone (low intensity) color. */
export const COLOR_PHEROMONE_DANGER_FAINT = 0x400000;

/** PRD §7g — Danger-trail pheromone (high intensity) color. */
export const COLOR_PHEROMONE_DANGER_STRONG = 0xff4000;

// ---------------------------------------------------------------------------
// HUD zone layout — PRD §6b normative pixel coordinates for 800×592 canvas
// ---------------------------------------------------------------------------

/**
 * HUD zone rectangles.
 *
 * All coordinates are screen pixels for the 800×592 canvas.
 *
 * SPEED and SAVE_ICON are Phase 9 layout reservations — coordinates are defined here
 * so Phase 9 has stable pixel targets, but Phase 8 draws NOTHING in these zones.
 *
 * Source: PRD §6b (04-PRD-playable-game-loop.md)
 */
export const HUD = {
  /** Colony stats bar: ant count, food stored, queen health. */
  STATS:       { x: 8,   y: 8,   w: 200, h: 24  },
  /**
   * Behavior allocation slider widget. Field name retained from the Phase 8
   * 3-vertex triangle to minimize diff churn; Phase 10 / D-01 collapsed the
   * widget to a 1-D Forage↔Fight slider, so the box no longer needs to be a
   * 120×120 square. Issue #13 follow-up: shrunk to 120×44 to hug the slider
   * track + extreme-icon labels and avoid the unsightly empty square that
   * the original triangle bounding box left behind.
   *
   * Geometry is sized to keep `trackY = y + h/2` valid given the 22px label
   * gap (`trackY - 22 == y` ⇒ labels render flush with the box top edge).
   * h must stay ≥ 44 for that invariant to hold without re-deriving the
   * track formula. Bottom edge (y + h = 576) is unchanged from the prior
   * 120×120 layout so HUD-anchor pixel positions of neighboring zones are
   * not disturbed.
   */
  TRIANGLE:    { x: 8,   y: 532, w: 120, h: 44 },
  /**
   * Speed controls zone.
   * Phase 9 layout reservation — Phase 8 draws nothing here.
   * Phase 9 wires 1×/2×/4× speed buttons and pause button.
   */
  SPEED:       { x: 320, y: 552, w: 160, h: 32,  PAUSE_BUTTON_W: 40, SPEED_BUTTON_W: 32 },
  /** Minimap: full surface overview with colony positions and food sources. */
  MINIMAP:     { x: 632, y: 424, w: 160, h: 160 },
  /** View toggle button: switches between surface and underground views. */
  VIEW_TOGGLE: { x: 632, y: 396, w: 80,  h: 24  },
  /**
   * Save icon zone.
   * Phase 9 layout reservation — Phase 8 draws nothing here.
   * Phase 9 wires autosave indicator rendering.
   */
  SAVE_ICON:   { x: 772, y: 8,   w: 20,  h: 20  },
} as const;

// ---------------------------------------------------------------------------
// Color interpolation utility
// ---------------------------------------------------------------------------

/**
 * lerpColor — linearly interpolate between two 0xRRGGBB color values.
 *
 * Decomposes each color into R, G, B byte components, interpolates each independently
 * by factor `t`, then recomposes. Uses `| 0` for integer truncation (render layer;
 * float arithmetic is permitted in src/render/).
 *
 * @param a - Source color (0xRRGGBB integer)
 * @param b - Target color (0xRRGGBB integer)
 * @param t - Interpolation factor, clamped to [0, 1]
 * @returns Interpolated color as 0xRRGGBB integer
 */
export function lerpColor(a: number, b: number, t: number): number {
  const tc = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r    = (ar + (br - ar) * tc) | 0;
  const g    = (ag + (bg - ag) * tc) | 0;
  const blue = (ab + (bb - ab) * tc) | 0;
  return (r << 16) | (g << 8) | blue;
}
