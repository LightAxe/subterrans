// layout.ts — the LayoutContext seam (issue #213).
//
// HUD/overlay geometry must be a pure function of a LayoutContext rather than of
// the fixed CANVAS_W/CANVAS_H constants or inline 800/592 literals. Today the
// context simply carries the logical canvas size (w × h), so NOTHING about
// rendering changes — the game still draws at the fixed 800×592 resolution. The
// point is the SEAM: when the responsive/mobile work lands later it becomes
// "compute a LayoutContext from the real canvas size + reflow on resize", not a
// scavenger hunt through a dozen modules pulling 800/592 out of thin air.
//
// Convention (see code/AGENTS.md → "Layout discipline"): a layout module takes
// `(…, layout)` and derives every canvas-relative coordinate from `layout.w` /
// `layout.h` (anchors, fractions, insets from an edge). It must NOT import
// CANVAS_W/CANVAS_H for geometry, redefine them locally, or hardcode 800/592.
// Canvas-INDEPENDENT constants (a fixed inset, a button size, an offset from
// another anchor) may stay plain constants — the rule targets dimensions tied to
// the canvas size, which are exactly what a resize has to move.
//
// Future fields (safe-area insets, orientation, devicePixelRatio) hang off this
// same object; adding them is the one place that needs to change.

import { CANVAS_W, CANVAS_H } from './sprites.js';

export interface LayoutContext {
  /** Logical canvas width in pixels. */
  readonly w: number;
  /** Logical canvas height in pixels. */
  readonly h: number;
}

/**
 * Build a LayoutContext. Defaults to the fixed logical canvas size
 * (CANVAS_W × CANVAS_H) — the only size the game renders at today. Pass explicit
 * dimensions once the responsive work computes them from the real canvas.
 */
export function createLayoutContext(w: number = CANVAS_W, h: number = CANVAS_H): LayoutContext {
  return { w, h };
}

/**
 * The fixed-resolution LayoutContext (800×592) — the single instance every
 * overlay consumes today. Swapping this for a resize-derived context (computed
 * from the real canvas in UIScene) is the eventual mobile seam; until then it
 * keeps the geometry byte-for-byte identical to the pre-seam constants.
 */
export const DEFAULT_LAYOUT: LayoutContext = createLayoutContext();

/**
 * cssScaleX — CSS pixels per logical pixel: how much the FIT-scaled canvas is
 * displayed larger (>1) or smaller (<1) than its logical width. `cssWidth` is the
 * canvas's on-screen width (canvas.getBoundingClientRect().width). Centralizes
 * the ratio that both the free-text overlay positioning (ui-scene) and the
 * touch-tuned drag threshold (#237 PR3, input.thresholdLogicalPx) need, so the
 * two can't drift. Callers guard a zero/NaN cssWidth themselves if a pre-layout
 * measurement is possible.
 */
export function cssScaleX(cssWidth: number, layout: LayoutContext): number {
  return cssWidth / layout.w;
}
