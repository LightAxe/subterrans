// gesture.ts — Stage 1 controls rework (issue #18): pure left-button gesture
// classification. No Phaser, no DOM — trivially unit-testable.
//
// The arbiter (gesture-arbiter.ts) owns the LEFT pointer button and uses these
// pure helpers to decide, frame by frame, whether an in-flight press is:
//   - still a potential TAP (pointer has not moved past the threshold), or
//   - a DRAG (pointer crossed the threshold) — and if so, whether that drag is
//     a PAINT (underground Dig) or a PAN (everything else).
//
// The threshold is a small pixel radius so trackpad jitter on a "click" is not
// misread as a drag (Codex R2's tap-vs-drag concern). It is a tunable constant,
// unit-tested at/just-below/just-above the boundary.

import type { ToolId } from '../render/camera.js';

/**
 * Movement (in screen pixels, Chebyshev/max-axis distance from the down point)
 * beyond which a left press is reclassified from a pending tap to a drag.
 *
 * 6px: large enough to swallow trackpad micro-movement during a physical click,
 * small enough that an intentional drag is recognized almost immediately. Pinned
 * here and unit-tested; fine-tuned in UAT.
 */
export const DRAG_THRESHOLD_PX = 6;

/**
 * thresholdLogicalPx — the drag threshold (in LOGICAL/game pixels) tuned for the
 * current display scale (#237 PR3). The arbiter classifies in logical pixels
 * (Phaser.Scale.FIT maps the CSS-displayed canvas back to the fixed logical
 * canvas), so a fixed physical finger jitter maps to MORE logical pixels the
 * smaller the canvas is displayed.
 *
 * `cssScale` = displayed CSS width / logical width (see layout.cssScaleX). A
 * ~10px physical jitter is therefore `10 / cssScale` logical px:
 *   - phone, canvas shrunk (cssScale 0.5) → 20 logical px of jitter → threshold 20
 *   - 1:1 display (cssScale 1)            → 10
 *   - canvas enlarged (cssScale 3)        → ~3 → clamped up to the 6px floor
 * Clamped to [6, 24]: the 6px floor keeps trackpad clicks from registering as
 * drags on large displays (the original DRAG_THRESHOLD_PX intent); the 24px
 * ceiling stops a pathologically tiny canvas from swallowing real short drags.
 */
export function thresholdLogicalPx(cssScale: number): number {
  return Math.max(6, Math.min(24, Math.ceil(10 / cssScale)));
}

/** The outcome of a drag, once the threshold has been crossed. */
export type DragMode = 'paint' | 'pan';

/**
 * hasCrossedDragThreshold — true once the pointer has moved more than
 * DRAG_THRESHOLD_PX from the down point on either axis.
 *
 * Uses max(|dx|,|dy|) (Chebyshev) rather than Euclidean distance: it is
 * allocation- and sqrt-free, and the difference at a 6px radius is immaterial
 * for this purpose. A press that never crosses this stays a tap.
 */
export function hasCrossedDragThreshold(
  downX: number,
  downY: number,
  curX: number,
  curY: number,
  threshold: number = DRAG_THRESHOLD_PX,
): boolean {
  const dx = curX - downX;
  const dy = curY - downY;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  return (adx > threshold ? adx : ady) > threshold;
}

/**
 * classifyDragMode — given the snapshotted tool + view at pointer-down, decide
 * what a threshold-crossing drag does.
 *
 * The complete view×tool matrix (PLAN §A2, Codex R1-3/R2-4/R3-6) reduces to one
 * rule: **left-drag = pan everywhere EXCEPT underground-Dig, which paints.**
 *   - Dig + underground            → 'paint' (MarkDigTile stroke)
 *   - Command (either view)        → 'pan'
 *   - Dig + surface                → 'pan'
 *   - Chamber (underground only)   → 'pan'
 * Surface Chamber is unreachable (Chamber is underground-only), so it has no row.
 */
export function classifyDragMode(tool: ToolId, view: 'surface' | 'underground'): DragMode {
  return tool === 'dig' && view === 'underground' ? 'paint' : 'pan';
}
