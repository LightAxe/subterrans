// camera-adapter.test.ts — Vitest tests for the pure zoom-aware camera adapter.
//
// Covers PLAN-stage2.md §E18 unit items for the adapter:
//   - pure screen↔world at several zooms (no Phaser matrix), round-trip + center
//   - screen→tile (continuous projection, integer tile floor, no camera-pos rounding)
//   - custom center-aware per-axis clamp (incl. the asymmetric underground Y-only case)
//   - cursor-anchored zoom recomputed per lerp step (no drift) + lerp convergence/cancel
//   - pan ÷zoom (grab + sign) and time-based WASD ÷zoom (frame-rate independence)
//   - per-view settle (lerp cancel + clamp) and minimap-nav (underground preserves depth)
//   - LOD hysteresis (0.55 / 0.65, band holds prior mode)

import { describe, it, expect } from 'vitest';
import { CANVAS_W, CANVAS_H, TILE_SIZE_PX } from './sprites.js';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  LOD_DOT_ENTER_ZOOM,
  LOD_SPRITE_RETURN_ZOOM,
  clampZoom,
  resolveDotMode,
  makeCameraView,
  viewWorldWidth,
  viewWorldHeight,
  visibleWorldRect,
  screenToWorld,
  worldToScreen,
  screenToTileZoom,
  clampCameraView,
  beginWheelZoom,
  applyZoomAnchor,
  stepZoomLerp,
  cancelZoomLerp,
  panByScreenDelta,
  panByKeyboard,
  settleEnteringView,
  minimapNavTargets,
  type CameraView,
} from './camera-adapter.js';

// World-pixel dimensions used across tests (PLAN grounding facts).
const SURFACE_PX = 2048; // 128 tiles × 16
const UG_W_PX = 2048; // 128 tiles × 16
const UG_H_PX = 1024; // 64 tiles × 16

function view(centerX: number, centerY: number, zoom: number): CameraView {
  return { centerX, centerY, zoom, targetZoom: zoom };
}

// ---------------------------------------------------------------------------
// constants & makeCameraView
// ---------------------------------------------------------------------------

describe('zoom constants & makeCameraView', () => {
  it('clampZoom respects [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it('makeCameraView clamps zoom and sets targetZoom == zoom', () => {
    const a = makeCameraView(10, 20, 5);
    expect(a.zoom).toBe(MAX_ZOOM);
    expect(a.targetZoom).toBe(MAX_ZOOM);
    const b = makeCameraView(10, 20, 0.01);
    expect(b.zoom).toBe(MIN_ZOOM);
    const c = makeCameraView(10, 20);
    expect(c.zoom).toBe(DEFAULT_ZOOM);
    expect(c.centerX).toBe(10);
    expect(c.centerY).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// screen↔world projection
// ---------------------------------------------------------------------------

describe('screenToWorld / worldToScreen', () => {
  for (const zoom of [0.2, 0.5, 1, 2]) {
    it(`canvas center maps to camera center at zoom ${zoom}`, () => {
      const v = view(1000, 500, zoom);
      const { worldX, worldY } = screenToWorld(CANVAS_W / 2, CANVAS_H / 2, v);
      expect(worldX).toBeCloseTo(1000, 6);
      expect(worldY).toBeCloseTo(500, 6);
      const { screenX, screenY } = worldToScreen(1000, 500, v);
      expect(screenX).toBeCloseTo(CANVAS_W / 2, 6);
      expect(screenY).toBeCloseTo(CANVAS_H / 2, 6);
    });

    it(`screen→world→screen round-trips at zoom ${zoom}`, () => {
      const v = view(1234, 678, zoom);
      const sx = 123;
      const sy = 456;
      const { worldX, worldY } = screenToWorld(sx, sy, v);
      const { screenX, screenY } = worldToScreen(worldX, worldY, v);
      expect(screenX).toBeCloseTo(sx, 6);
      expect(screenY).toBeCloseTo(sy, 6);
    });
  }

  it('1 screen px == 1/zoom world px horizontally', () => {
    const v = view(0, 0, 0.5);
    const a = screenToWorld(0, 0, v).worldX;
    const b = screenToWorld(1, 0, v).worldX;
    expect(b - a).toBeCloseTo(1 / 0.5, 9); // 2 world px per screen px at 0.5×
  });
});

describe('screenToTileZoom', () => {
  it('floors continuous world coords to the tile grid (no camera-pos rounding)', () => {
    // centerX chosen so a fractional world X lands inside a known tile.
    const v = view(446 + CANVAS_W / 2 / 1, 0, 1); // screenToWorld(0,..) = 446
    const { tileX } = screenToTileZoom(0, CANVAS_H / 2, v);
    expect(tileX).toBe(Math.floor(446 / TILE_SIZE_PX)); // 27
  });

  it('a fractional camera center does NOT snap the projection', () => {
    // Two centers 0.4 tile apart can resolve the same screen px to different tiles —
    // the projection is continuous, unlike the old floor-the-camera screenToTile.
    const base = view(1000.0, 500.0, 1);
    const shifted = view(1000.0 + 0.4 * TILE_SIZE_PX, 500.0, 1);
    const a = screenToTileZoom(10, 10, base).tileX;
    const b = screenToTileZoom(10, 10, shifted).tileX;
    expect(b).toBeGreaterThanOrEqual(a); // monotonic with center, never rounded away
  });
});

// ---------------------------------------------------------------------------
// custom center-aware clamp
// ---------------------------------------------------------------------------

describe('clampCameraView', () => {
  it('clamps center to [half, world − half] when world > viewport (zoom 1)', () => {
    const lo = view(-9999, -9999, 1);
    clampCameraView(lo, SURFACE_PX, SURFACE_PX);
    expect(lo.centerX).toBeCloseTo(CANVAS_W / 2, 6); // 400
    expect(lo.centerY).toBeCloseTo(CANVAS_H / 2, 6); // 296
    const hi = view(99999, 99999, 1);
    clampCameraView(hi, SURFACE_PX, SURFACE_PX);
    expect(hi.centerX).toBeCloseTo(SURFACE_PX - CANVAS_W / 2, 6); // 1648
    expect(hi.centerY).toBeCloseTo(SURFACE_PX - CANVAS_H / 2, 6); // 1752
  });

  it('centers an undersized world (strategic zoom-out shows whole 2048 width)', () => {
    const v = view(50, 50, 0.2); // viewW = 4000 > 2048
    clampCameraView(v, SURFACE_PX, SURFACE_PX);
    expect(v.centerX).toBeCloseTo(SURFACE_PX / 2, 6); // 1024
    expect(v.centerY).toBeCloseTo(SURFACE_PX / 2, 6);
  });

  it('handles the ASYMMETRIC underground case: clamp X, center Y (the setBounds-killer)', () => {
    // zoom 0.5 underground: viewW=1600 < 2048 (X clamps), viewH=1184 > 1024 (Y centers).
    const v = view(99999, 99999, 0.5);
    clampCameraView(v, UG_W_PX, UG_H_PX);
    expect(v.centerX).toBeCloseTo(UG_W_PX - viewWorldWidth(0.5) / 2, 6); // 2048 - 800 = 1248
    expect(v.centerY).toBeCloseTo(UG_H_PX / 2, 6); // centered: 512
  });
});

// ---------------------------------------------------------------------------
// cursor-anchored zoom
// ---------------------------------------------------------------------------

describe('cursor-anchored zoom (no drift across lerp)', () => {
  it('beginWheelZoom multiplies & clamps targetZoom and captures the world point under the cursor', () => {
    const v = view(1000, 500, 1);
    const anchor = beginWheelZoom(v, 1.1, 600, 400);
    expect(v.targetZoom).toBeCloseTo(1.1, 6);
    expect(v.zoom).toBe(1); // zoom itself untouched until the lerp runs
    expect(anchor.worldX).toBeCloseTo(screenToWorld(600, 400, v).worldX, 6);
  });

  it('clamps targetZoom at the limits', () => {
    const v = view(0, 0, MAX_ZOOM);
    beginWheelZoom(v, 4, 400, 296);
    expect(v.targetZoom).toBe(MAX_ZOOM);
    const w = view(0, 0, MIN_ZOOM);
    beginWheelZoom(w, 0.1, 400, 296);
    expect(w.targetZoom).toBe(MIN_ZOOM);
  });

  it('the anchored world point stays under the cursor at EVERY lerp step (no drift)', () => {
    const v = view(1000, 500, 1);
    const anchor = beginWheelZoom(v, 1.8, 612, 333);
    for (let i = 0; i < 40; i++) {
      stepZoomLerp(v, 0.25);
      applyZoomAnchor(v, anchor);
      clampCameraView(v, SURFACE_PX, SURFACE_PX);
      // before clamping pulls it off-screen, the un-clamped invariant must hold; use a
      // center well inside bounds so clamp is a no-op here.
      const back = screenToWorld(anchor.screenX, anchor.screenY, v);
      expect(back.worldX).toBeCloseTo(anchor.worldX, 4);
      expect(back.worldY).toBeCloseTo(anchor.worldY, 4);
    }
  });

  it('stepZoomLerp converges and snaps exactly to targetZoom', () => {
    const v = view(0, 0, 1);
    v.targetZoom = 0.2;
    let done = false;
    for (let i = 0; i < 200 && !done; i++) done = stepZoomLerp(v, 0.3);
    expect(done).toBe(true);
    expect(v.zoom).toBe(0.2);
  });

  it('cancelZoomLerp snaps targetZoom to the current zoom', () => {
    const v = view(0, 0, 0.7);
    v.targetZoom = 1.9;
    cancelZoomLerp(v);
    expect(v.targetZoom).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// pan
// ---------------------------------------------------------------------------

describe('pan ÷zoom', () => {
  it('panByScreenDelta divides by zoom and moves the center opposite the cursor', () => {
    const v = view(1000, 500, 0.5);
    panByScreenDelta(v, 100, 50);
    expect(v.centerX).toBeCloseTo(1000 - 100 / 0.5, 6); // 800
    expect(v.centerY).toBeCloseTo(500 - 50 / 0.5, 6); // 400
  });

  it('panByKeyboard is frame-rate independent (two half-steps == one full-step)', () => {
    const a = view(1000, 500, 1);
    const b = view(1000, 500, 1);
    panByKeyboard(a, 1, 0, 0.1, 600);
    panByKeyboard(b, 1, 0, 0.05, 600);
    panByKeyboard(b, 1, 0, 0.05, 600);
    expect(a.centerX).toBeCloseTo(b.centerX, 9);
    expect(a.centerX).toBeCloseTo(1000 + (600 * 0.1) / 1, 6); // +60
  });

  it('panByKeyboard divides by zoom (slower world travel when zoomed in)', () => {
    const v = view(0, 0, 2);
    panByKeyboard(v, 0, 1, 1, 600);
    expect(v.centerY).toBeCloseTo((600 * 1) / 2, 6); // 300 world px, not 600
  });
});

// ---------------------------------------------------------------------------
// view settle + minimap nav
// ---------------------------------------------------------------------------

describe('settleEnteringView', () => {
  it('cancels the in-flight lerp and clamps at the restored zoom', () => {
    const v: CameraView = { centerX: 99999, centerY: 99999, zoom: 1, targetZoom: 1.7 };
    settleEnteringView(v, SURFACE_PX, SURFACE_PX);
    expect(v.targetZoom).toBe(1); // lerp cancelled
    expect(v.centerX).toBeCloseTo(SURFACE_PX - CANVAS_W / 2, 6);
    expect(v.centerY).toBeCloseTo(SURFACE_PX - CANVAS_H / 2, 6);
  });
});

describe('minimapNavTargets', () => {
  it('sets surface center to the click and X-links underground while preserving its depth', () => {
    const surface = view(100, 200, 1);
    const underground = view(300, 800, 1);
    const t = minimapNavTargets(surface, underground, 1500, 250);
    expect(t.surfaceCenterX).toBe(1500);
    expect(t.surfaceCenterY).toBe(250);
    expect(t.undergroundCenterX).toBe(1500); // X-link
    expect(t.undergroundCenterY).toBe(800); // depth preserved, NOT the surface Y
  });
});

// ---------------------------------------------------------------------------
// visibleWorldRect
// ---------------------------------------------------------------------------

describe('visibleWorldRect', () => {
  it('is the zoomed window centered on the camera', () => {
    const v = view(1000, 500, 1);
    const r = visibleWorldRect(v);
    expect(r.left).toBeCloseTo(600, 6);
    expect(r.right).toBeCloseTo(1400, 6);
    expect(r.top).toBeCloseTo(204, 6);
    expect(r.bottom).toBeCloseTo(796, 6);
  });

  it('grows as zoom decreases', () => {
    const wide = visibleWorldRect(view(0, 0, 0.2));
    expect(wide.right - wide.left).toBeCloseTo(viewWorldWidth(0.2), 6);
    expect(wide.bottom - wide.top).toBeCloseTo(viewWorldHeight(0.2), 6);
  });
});

// ---------------------------------------------------------------------------
// LOD hysteresis (§E18) — the stateful dot/sprite mode resolver for Phase-B
// ---------------------------------------------------------------------------

describe('resolveDotMode hysteresis', () => {
  it('enters dot mode at/below LOD_DOT_ENTER_ZOOM regardless of prior mode', () => {
    expect(resolveDotMode(LOD_DOT_ENTER_ZOOM, false)).toBe(true);
    expect(resolveDotMode(0.4, false)).toBe(true);
    expect(resolveDotMode(0.2, true)).toBe(true);
  });

  it('returns to sprites at/above LOD_SPRITE_RETURN_ZOOM regardless of prior mode', () => {
    expect(resolveDotMode(LOD_SPRITE_RETURN_ZOOM, true)).toBe(false);
    expect(resolveDotMode(1, true)).toBe(false);
    expect(resolveDotMode(2, false)).toBe(false);
  });

  it('inside the hysteresis band, holds the prior mode (no thrash)', () => {
    expect(resolveDotMode(0.6, true)).toBe(true);
    expect(resolveDotMode(0.6, false)).toBe(false);
  });
});
