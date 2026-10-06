// hp-bar.ts — #148 / #427: the small health bar drawn in world space above a creature.
//
// The spider has had one since #148 (draw-surface.ts, shown once it is hurt). #427
// gives the enemy queen the same bar in the enemy nest view (draw-underground.ts), so
// the two read alike: a dark outline, a grey track, and a fill whose width is the HP
// fraction and whose colour runs green (full) → yellow (half) → red (empty).
//
// Pure + Phaser-free: draws through GfxLike. Callers pass the overlay Graphics layer
// GameScene draws above the sprites, so the bar is never painted over by an ant.

import type { GfxLike } from './draw-surface.js';
import { lerpColor } from './sprites.js';

/** Bar width (world px). */
export const HP_BAR_W = 24;
/** Bar height (world px). */
export const HP_BAR_H = 4;
/** Gap (world px) between the bar's bottom edge and the top of the sprite it labels. */
export const HP_BAR_GAP = 4;

/** Outline (drawn 1 px round the track) and track colours. */
export const HP_BAR_OUTLINE_COLOR = 0x000000;
export const HP_BAR_TRACK_COLOR = 0x333333;

/** `hp / maxHp`, clamped to [0, 1] (0 for a non-positive max). */
export function hpRatio(hp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

/** The fill colour at HP fraction `ratio`: green above half, yellow at half, red near empty. */
export function hpBarFillColor(ratio: number): number {
  return ratio > 0.5
    ? lerpColor(0xffcc00, 0x33cc33, (ratio - 0.5) / 0.5)
    : lerpColor(0xcc2020, 0xffcc00, ratio / 0.5);
}

/**
 * The fill's width (px) on a `barW`-px track at HP fraction `ratio`: the whole track
 * at full HP, nothing at 0, and otherwise the rounded fraction kept within
 * [1, barW − 1] — so any wound shows as a gap, and a creature with HP left never
 * reads as empty (#148 review P3-2).
 */
export function hpBarFillWidth(ratio: number, barW: number = HP_BAR_W): number {
  if (ratio >= 1) return barW;
  if (ratio <= 0) return 0;
  return Math.max(1, Math.min(barW - 1, Math.round(barW * ratio)));
}

/** Where a bar was drawn (world px) and what it showed. */
export interface HpBarDrawn {
  /** The track's top-left corner and size; the outline sits 1 px outside it. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The fill's width (px), from the track's left edge. */
  fillW: number;
  /** The fill's colour. */
  color: number;
  /** The HP fraction drawn, in [0, 1]. */
  ratio: number;
}

/**
 * Draw the bar centred on `centerX`, its bottom edge HP_BAR_GAP px above `spriteTopY`
 * (the top of the sprite it labels), at HP fraction `ratio`. Writes the result into
 * `out` (callers keep one per bar to stay allocation-free per frame) and returns it.
 */
export function drawHpBar(
  gfx: GfxLike,
  centerX: number,
  spriteTopY: number,
  ratio: number,
  out: HpBarDrawn,
): HpBarDrawn {
  const r = Math.max(0, Math.min(1, ratio));
  const x = Math.round(centerX - HP_BAR_W / 2);
  const y = Math.round(spriteTopY - HP_BAR_H - HP_BAR_GAP);
  const color = hpBarFillColor(r);
  const fillW = hpBarFillWidth(r);
  gfx.fillStyle(HP_BAR_OUTLINE_COLOR, 0.7);
  gfx.fillRect(x - 1, y - 1, HP_BAR_W + 2, HP_BAR_H + 2);
  gfx.fillStyle(HP_BAR_TRACK_COLOR, 0.85);
  gfx.fillRect(x, y, HP_BAR_W, HP_BAR_H);
  gfx.fillStyle(color, 1);
  gfx.fillRect(x, y, fillW, HP_BAR_H);
  out.x = x;
  out.y = y;
  out.w = HP_BAR_W;
  out.h = HP_BAR_H;
  out.fillW = fillW;
  out.color = color;
  out.ratio = r;
  return out;
}

/** A blank HpBarDrawn, for a caller's reusable record. */
export function createHpBarDrawn(): HpBarDrawn {
  return { x: 0, y: 0, w: 0, h: 0, fillW: 0, color: 0, ratio: 0 };
}
