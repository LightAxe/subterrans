// camera-controller.test.ts — Vitest tests for the stateful CameraController glue.
//
// camera-adapter.test.ts covers the pure math; this file covers the controller's
// state-machine — the in-flight `anchor` lifecycle and the order in which it drives the
// adapter — which is exercised by no other test. Focus areas (PLAN-stage2.md §E18):
//   - apply() pushes zoom THEN center onto the Phaser camera
//   - beginZoom records the anchor; tickZoomLerp holds it under the cursor each frame
//   - the zoom-at-limit early-return that DISCARDS an anchor (zoom === targetZoom)
//   - the final-step ordering: applyZoomAnchor is applied at the final zoom, THEN the
//     anchor is nulled (a reversed order would drift the cursor point by one frame)
//   - cancel() drops the anchor (e.g. across a view toggle)
//
// The Phaser camera is faked: the controller's only camera touch-points are
// setRoundPixels / setZoom / centerOn, so a recording stub cast through the camera type
// is sufficient (no Phaser runtime, matching the Node + Vitest constraint).

import { describe, it, expect } from 'vitest';
import type * as Phaser from 'phaser';
import { CameraController } from './camera-controller.js';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  applyZoomAnchor,
  screenToWorld,
  type CameraView,
} from './camera-adapter.js';

// World-pixel dimensions (PLAN grounding facts: 128×128 surface tiles × 16).
const SURFACE_PX = 2048;

function view(centerX: number, centerY: number, zoom: number): CameraView {
  return { centerX, centerY, zoom, targetZoom: zoom };
}

/**
 * Recording stand-in for the Phaser camera. Captures the controller's only camera
 * touch-points; lastZoom/lastCenter reflect the most recent apply() so projection-order
 * and final-frame state can be asserted without a Phaser runtime.
 */
class FakeCamera {
  roundPixels = true;
  lastZoom: number | null = null;
  lastCenter: { x: number; y: number } | null = null;
  setRoundPixels(value: boolean): this {
    this.roundPixels = value;
    return this;
  }
  setZoom(value: number): this {
    this.lastZoom = value;
    return this;
  }
  centerOn(x: number, y: number): this {
    this.lastCenter = { x, y };
    return this;
  }
}

function makeController(): { ctrl: CameraController; cam: FakeCamera } {
  const cam = new FakeCamera();
  const ctrl = new CameraController(cam as unknown as Phaser.Cameras.Scene2D.Camera);
  return { ctrl, cam };
}

describe('CameraController', () => {
  it('constructor disables pixel rounding (continuous sub-pixel pan)', () => {
    const { cam } = makeController();
    expect(cam.roundPixels).toBe(false);
  });

  it('apply() pushes zoom and center from the view onto the camera', () => {
    const { ctrl, cam } = makeController();
    ctrl.apply(view(1000, 500, 1.5));
    expect(cam.lastZoom).toBe(1.5);
    expect(cam.lastCenter).toEqual({ x: 1000, y: 500 });
  });

  it('beginZoom sets targetZoom and records the anchor under the cursor', () => {
    const { ctrl } = makeController();
    const v = view(1000, 500, 1);
    ctrl.beginZoom(v, 1.15, 600, 400);
    expect(v.targetZoom).toBeCloseTo(1.15, 6);
    expect(v.zoom).toBe(1); // zoom itself moves only via tickZoomLerp
  });

  it('tickZoomLerp is a no-op (and discards the anchor) when zoom === targetZoom', () => {
    const { ctrl } = makeController();
    const v = view(1000, 500, 1); // zoom === targetZoom: no lerp in flight
    // Plant an anchor as if a wheel notch had been clamped to a no-op at the limit.
    ctrl.beginZoom(v, 1, 600, 400); // factor 1 → targetZoom unchanged → still no lerp
    const before = { centerX: v.centerX, centerY: v.centerY };
    ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
    // Center must NOT move (a stale anchor applied here would drift it).
    expect(v.centerX).toBe(before.centerX);
    expect(v.centerY).toBe(before.centerY);
  });

  it('zoom-at-limit notch DISCARDS its anchor so a later lerp cannot re-apply it', () => {
    const { ctrl } = makeController();
    const v = view(1000, 500, MAX_ZOOM);
    // A wheel notch at the zoom-in limit: targetZoom clamps back to the current zoom, so
    // no lerp runs — but beginZoom recorded an off-center anchor that MUST be discarded.
    ctrl.beginZoom(v, 4, 612, 333);
    expect(v.targetZoom).toBe(MAX_ZOOM);

    // The early-return tick fires (zoom === targetZoom) and must null that stale anchor.
    const before = { centerX: v.centerX, centerY: v.centerY };
    ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
    expect(v.centerX).toBe(before.centerX);
    expect(v.centerY).toBe(before.centerY);

    // Now a genuine lerp begins WITHOUT a fresh anchor (e.g. a non-wheel zoom path):
    // arm targetZoom directly. If the at-limit anchor was not discarded, this step would
    // re-center on the OLD (612,333) cursor point and the center would jump.
    v.targetZoom = MIN_ZOOM;
    ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
    expect(v.zoom).not.toBe(MAX_ZOOM); // lerp advanced
    expect(v.centerX).toBe(before.centerX); // anchor was discarded → no re-center
    expect(v.centerY).toBe(before.centerY);
  });

  it('tickZoomLerp holds the cursor world point fixed across every frame', () => {
    const { ctrl } = makeController();
    const v = view(1000, 500, 1);
    ctrl.beginZoom(v, 1.8, 612, 333);
    const anchorWorld = screenToWorld(612, 333, v);
    for (let i = 0; i < 40; i++) {
      ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
      // Center well inside bounds → clamp is a no-op; the cursor's world point must
      // still project back under the cursor screen point.
      const back = screenToWorld(612, 333, v);
      expect(back.worldX).toBeCloseTo(anchorWorld.worldX, 4);
      expect(back.worldY).toBeCloseTo(anchorWorld.worldY, 4);
    }
    expect(v.zoom).toBe(v.targetZoom); // converged
  });

  it('final lerp step applies the anchor AT the final zoom BEFORE nulling it (no 1-frame drift)', () => {
    const { ctrl } = makeController();
    const v = view(1000, 500, 1);
    // The anchor is private; we assert its lifecycle purely through observable center.
    const wheelAnchor = screenToWorld(612, 333, v);
    ctrl.beginZoom(v, 1.6, 612, 333);
    // Run to convergence.
    let prevZoom = v.zoom;
    for (let i = 0; i < 100; i++) {
      ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
      if (v.zoom === v.targetZoom && v.zoom === prevZoom) break;
      prevZoom = v.zoom;
    }
    expect(v.zoom).toBe(v.targetZoom);
    // The center on the final frame must equal applyZoomAnchor evaluated at the FINAL
    // zoom — i.e. the anchor was applied before being dropped. Reconstruct the expected
    // center independently from the adapter.
    const expected: CameraView = { ...v };
    applyZoomAnchor(expected, {
      screenX: 612,
      screenY: 333,
      worldX: wheelAnchor.worldX,
      worldY: wheelAnchor.worldY,
    });
    expect(v.centerX).toBeCloseTo(expected.centerX, 6);
    expect(v.centerY).toBeCloseTo(expected.centerY, 6);

    // And the anchor is now dropped: a further tick (zoom === targetZoom) is inert.
    const after = { centerX: v.centerX, centerY: v.centerY };
    ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
    expect(v.centerX).toBe(after.centerX);
    expect(v.centerY).toBe(after.centerY);
  });

  it('cancel() drops the in-flight anchor so a later lerp does not re-apply it', () => {
    const { ctrl } = makeController();
    const v = view(1000, 500, 1);
    ctrl.beginZoom(v, 1.6, 612, 333); // anchor recorded, lerp armed
    ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX); // one step in
    ctrl.cancel(v); // e.g. across a view toggle
    expect(v.targetZoom).toBe(v.zoom); // lerp cancelled (adapter behavior)
    // Re-arm a lerp WITHOUT a new anchor by nudging targetZoom directly; the dropped
    // anchor must NOT resurface — center moves only by the clamp, not by re-anchoring.
    const beforeCenter = { centerX: v.centerX, centerY: v.centerY };
    const beforeZoom = v.zoom;
    v.targetZoom = MIN_ZOOM; // lerp now in flight again, anchor still null
    ctrl.tickZoomLerp(v, SURFACE_PX, SURFACE_PX);
    // Zoom advanced, but the cleared anchor did not re-center toward the old cursor point.
    expect(v.zoom).not.toBe(beforeZoom);
    expect(v.centerX).toBe(beforeCenter.centerX); // no re-anchor (well inside bounds)
    expect(v.centerY).toBe(beforeCenter.centerY);
  });
});
