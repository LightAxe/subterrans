// ant-sprite-layer.ts — minimal interface for per-frame sprite drawing.
//
// draw-surface.ts and draw-underground.ts call AntSpriteLayer.drawAnt(...)
// (mobile ants, with tint + rotation) or AntSpriteLayer.drawStatic(...) (eggs,
// larvae, food caches — no rotation / tint optional) instead of emitting
// primitive fillRect/strokeCircle calls. The Phaser implementation
// (AntSpritePool) lives in ant-sprite-pool.ts; tests use a recording mock.
// Keeps the draw-* modules Phaser-free.

import { COLOR_FOOD_PILE_NORMAL } from './sprites.js';

export type AntSpriteKind = 'worker' | 'queen';

export interface AntSpriteDrawOptions {
  kind: AntSpriteKind;
  /** Screen-space pixel X of the sprite center. */
  x: number;
  /** Screen-space pixel Y of the sprite center. */
  y: number;
  /** Colony color applied via multiplicative tint (white SVG → target color). */
  tint: number;
  /**
   * Rotation in radians. Omit (or 0) for the sprite's native pose. The SVG
   * sources render with the ant's head on the LEFT side of the texture, so
   * callers that want the head to face direction (dx, dy) should pass
   * `Math.atan2(-dy, -dx)`. When movement delta is zero (stationary ant) the
   * caller is expected to pass 0 to keep the sprite in a stable default pose
   * rather than jittering frame-to-frame.
   */
  rotation?: number;
  /** S1 — uniform scale multiplier. 1.0 = natural size; >1 = larger sprite.
   *  Used to render fighter ants slightly larger than workers. */
  scale?: number;
  /**
   * #290 PR 6 — the ant is carrying food (`ants.foodCarrying[id] > 0`): the pool
   * draws a small food crumb at its head (CARRIED_FOOD_*), above the ant. Keyed
   * on the load alone, not the task, so a forager bringing food home and a
   * fighter hauling raided food look the same. Omit (or false) for no crumb.
   */
  carrying?: boolean;
}

/** Static (non-moving) entities drawn through the same sprite pool. */
export type StaticSpriteKind = 'egg' | 'larva' | 'food-cache';

export interface StaticSpriteDrawOptions {
  kind: StaticSpriteKind;
  /** Screen-space pixel X of the sprite center. */
  x: number;
  /** Screen-space pixel Y of the sprite center. */
  y: number;
  /**
   * Optional multiplicative tint. White (0xffffff) = use the SVG's natural
   * fill. Food caches pass COLOR_CHAMBER_FOOD_STORAGE_FILL so the same SVG
   * can represent stored grain in the amber palette.
   */
  tint?: number;
}

/** S3 — Spider entity draw options. */
export interface SpiderSpriteDrawOptions {
  /** Screen-space pixel X of the sprite center. */
  x: number;
  /** Screen-space pixel Y of the sprite center. */
  y: number;
  /** Hunger-derived multiplicative tint: 0xCCCCCC (idle) → 0xFF3300 (rampage). */
  tint: number;
  /**
   * Rotation in radians. Omit (or 0) for the sprite's native pose. Like the ant
   * SVGs, the spider sprite renders with its head/front on the LEFT side of the
   * texture (chelicerae + eyes + cephalothorax on -x), so callers that want the
   * head to face movement direction (dx, dy) pass `Math.atan2(-dy, -dx)`. When
   * the spider is stationary the caller holds the last rotation (via the shared
   * facing cache) rather than snapping back to the default pose.
   */
  rotation?: number;
}

export interface AntSpriteLayer {
  /** Reset the per-frame draw cursor. Hidden sprites are reused in draw order. */
  beginFrame(): void;
  drawAnt(opts: AntSpriteDrawOptions): void;
  /** Draw a static (non-rotating) entity — egg, larva, or food cache. */
  drawStatic(opts: StaticSpriteDrawOptions): void;
  /** S3 — Draw the spider entity. */
  drawSpider(opts: SpiderSpriteDrawOptions): void;
  /** Hide any pooled sprites not touched this frame. */
  endFrame(): void;
}

// Texture keys shared by preload (game-scene.ts) and pool (ant-sprite-pool.ts).
export const ANT_TEXTURE_WORKER = 'ant-worker';
export const ANT_TEXTURE_QUEEN = 'ant-queen';
export const EGG_TEXTURE = 'egg';
export const LARVA_TEXTURE = 'larva';
export const FOOD_CACHE_TEXTURE = 'food-cache';

// S3 spider
export const SPIDER_TEXTURE = 'spider';
export const SPIDER_SPRITE_WIDTH = 48;
export const SPIDER_SPRITE_HEIGHT = 48;
export const SPIDER_SPRITE_DEPTH = 52; // above ants (depth 50); exported unlike ant/static depths which are pool-internal

// Rasterization sizes — keep in sync with the SVG viewBox values in
// code/public/assets/sprites/{worker,queen}-ant.svg. Phaser's load.svg
// rasterizes at these dimensions; the resulting texture is what renders
// in the scene.
export const WORKER_SPRITE_WIDTH = 12;
export const WORKER_SPRITE_HEIGHT = 8;
export const QUEEN_SPRITE_WIDTH = 20;
export const QUEEN_SPRITE_HEIGHT = 14;

// Static entity rasterization sizes — these are rasterized at 2× the tile
// footprint so rotation-less scaling from the pool center keeps crisp edges.
// Visual size still fits inside TILE_SIZE_PX (16) via draw-underground's
// setDisplaySize clamp; the higher raster preserves SVG detail when Phaser
// tints/scales.
export const EGG_SPRITE_WIDTH = 10;
export const EGG_SPRITE_HEIGHT = 10;
export const LARVA_SPRITE_WIDTH = 12;
export const LARVA_SPRITE_HEIGHT = 10;
export const FOOD_CACHE_SPRITE_WIDTH = 16;
export const FOOD_CACHE_SPRITE_HEIGHT = 16;

// #290 PR 6 — the carried-food crumb (AntSpriteDrawOptions.carrying). It reuses the
// food-cache texture shrunk to about 6 px and tinted the surface food-pile green
// (the HUD food colour), so a laden ant reads as "has food" at a glance. It sits
// over the head (the SVGs face -x, so the offset is along the rotated -x axis,
// scaled with the ant) and stays inside the ant's own footprint, so the
// underground containment of the ant (sprite-containment.ts) also keeps the crumb
// off a Solid neighbour.
export const CARRIED_FOOD_SCALE = 0.4;
/** Crumb centre, in px ahead of the ant centre at scale 1 (half-way to the head tip). */
export const CARRIED_FOOD_HEAD_OFFSET_PX = WORKER_SPRITE_WIDTH / 4;
/** The surface food-pile green (sprites.ts), which the HUD food count uses too. */
export const CARRIED_FOOD_TINT = COLOR_FOOD_PILE_NORMAL;

/**
 * Centre of the carried-food crumb for an ant drawn at (x, y) with `rotation` and
 * `scale` (AntSpriteDrawOptions). Pure, so the placement is unit-testable without
 * Phaser; `out` is filled and returned (no allocation per ant).
 */
export function carriedFoodPosition(
  x: number,
  y: number,
  rotation: number,
  scale: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const off = CARRIED_FOOD_HEAD_OFFSET_PX * scale;
  out.x = x - Math.cos(rotation) * off;
  out.y = y - Math.sin(rotation) * off;
  return out;
}
