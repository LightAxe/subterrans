// camera-controller.ts — Stage 2 controls rework (issue #18): the thin Phaser-bound
// driver for the continuous-zoom camera. This is the ONLY place in the codebase that
// calls cameras.main.setZoom / centerOn. All math is delegated to the pure
// camera-adapter (the single screen↔world authority); this class just pushes the
// adapter's authoritative CameraView state onto the live Phaser camera and runs the
// per-frame zoom-lerp.
//
// Why centerOn + setZoom is sufficient (no manual scrollX): Phaser centers the view on
// the camera midpoint = scrollX + width/2 and expands the worldView around it by
// 1/zoom, so a world→screen point maps to `(worldX − centerX)·zoom + width/2`. That is
// exactly the adapter's worldToScreen formula, so driving the camera with
// centerOn(centerX, centerY) + setZoom(zoom) keeps Phaser's projection in lockstep with
// the adapter's pure formula at every zoom — no Phaser matrix is ever read for input.
//
// No setBounds: useBounds is a single flag that can't clamp per-axis and PINS (not
// centers) an undersized world (fatal underground). The adapter's custom center-aware
// clampCameraView handles bounds instead.

import type * as Phaser from 'phaser';
import {
  type CameraView,
  type ZoomAnchor,
  beginWheelZoom,
  stepZoomLerp,
  applyZoomAnchor,
  clampCameraView,
  cancelZoomLerp,
} from './camera-adapter.js';

/** Per-wheel-notch zoom multiplier (one full ~WHEEL_NOTCH_PX notch zooms ×1.15 / ÷1.15). */
export const WHEEL_ZOOM_STEP = 1.15;

/**
 * Wheel deltaY (px) treated as one full zoom notch. A standard mouse-wheel notch is
 * ~100px; trackpads and high-resolution wheels emit MANY small deltas per gesture, so the
 * zoom factor is scaled by deltaY/WHEEL_NOTCH_PX (WHEEL_ZOOM_STEP ** (−dy/WHEEL_NOTCH_PX))
 * — one notch = ×1.15, while small trackpad deltas zoom proportionally instead of slamming
 * targetZoom to the min/max on every event.
 */
export const WHEEL_NOTCH_PX = 100;

/**
 * Per-frame interpolation factor toward targetZoom. A fixed factor gives an
 * exponential ease (~snappy in ~150 ms at 60 fps); zoom smoothing is cosmetic, so —
 * unlike pan/WASD — it is not frame-rate normalized (the adapter snaps to the target
 * within ZOOM_LERP_EPSILON, so it always terminates).
 */
const ZOOM_LERP_RATE = 0.18;

/**
 * CameraController — binds a Phaser camera to a pure CameraView. Construct once per
 * GameScene with cameras.main; the active view's CameraView is passed into each method
 * (the controller is stateless except for the in-flight wheel anchor).
 */
export class CameraController {
  private readonly camera: Phaser.Cameras.Scene2D.Camera;
  /** The fixed screen point + world point under it for the in-flight wheel zoom. */
  private anchor: ZoomAnchor | null = null;

  constructor(camera: Phaser.Cameras.Scene2D.Camera) {
    this.camera = camera;
    // Crisp + smooth pan: the camera must NOT round pixels (continuous sub-pixel pan;
    // the snapping PR6 removed must not return), and we never enable bounds.
    this.camera.setRoundPixels(false);
  }

  /**
   * Push the authoritative CameraView onto the Phaser camera (zoom THEN center — order
   * is irrelevant since centerOn is zoom-independent, but zoom first keeps worldView
   * consistent for any same-frame reads). Call once per frame after all mutations.
   */
  apply(view: CameraView): void {
    this.camera.setZoom(view.zoom);
    this.camera.centerOn(view.centerX, view.centerY);
  }

  /**
   * Begin a cursor-anchored wheel zoom: sets the view's targetZoom and records the
   * anchor (the world point under the cursor) for the lerp to hold fixed. The actual
   * zoom moves over subsequent frames via tickZoomLerp.
   */
  beginZoom(view: CameraView, factor: number, screenX: number, screenY: number): void {
    this.anchor = beginWheelZoom(view, factor, screenX, screenY);
  }

  /**
   * Advance an in-flight zoom-lerp by one frame: step zoom toward targetZoom, re-anchor
   * the center so the cursor's world point stays fixed (recomputed EVERY frame — not
   * once on the wheel event — so it doesn't drift), then custom-clamp. No-op when no
   * lerp is active (zoom === targetZoom). Does NOT call apply(); the caller applies once
   * per frame after pan + lerp.
   */
  tickZoomLerp(view: CameraView, worldPxW: number, worldPxH: number): void {
    if (view.zoom === view.targetZoom) {
      this.anchor = null;
      return;
    }
    const done = stepZoomLerp(view, ZOOM_LERP_RATE);
    if (this.anchor !== null) applyZoomAnchor(view, this.anchor);
    clampCameraView(view, worldPxW, worldPxH);
    if (done) this.anchor = null;
  }

  /** Cancel any in-flight zoom-lerp (e.g. across a view toggle) and drop the anchor. */
  cancel(view: CameraView): void {
    cancelZoomLerp(view);
    this.anchor = null;
  }
}
