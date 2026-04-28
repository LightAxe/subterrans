// triangle-widget.test.ts — Vitest unit tests for the Phase 10 / D-01 slider
// widget primitives in triangle-widget.ts.
//
// (File-name note: the file under test is still `triangle-widget.ts` to
// minimize the diff against ui-scene.ts; symbols are slider-prefixed. See
// triangle-widget.ts header.)
//
// Tests run under Node (no Phaser). MockGfx pattern from draw-surface tests.

import { describe, it, expect } from 'vitest';
import {
  SLIDER_GEOMETRY,
  screenToSliderRatio,
  ratioToSliderPos,
  isInsideSlider,
  drawSlider,
  createSliderDragState,
} from './triangle-widget.js';
import type { GfxLike } from './draw-surface.js';
import { HUD, COLOR_PLAYER_COLONY } from './sprites.js';

// ---------------------------------------------------------------------------
// MockGfx — spy recorder implementing GfxLike (matches draw-surface.test.ts pattern)
// ---------------------------------------------------------------------------

interface GfxCall {
  method: string;
  args: unknown[];
}

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];

  clear(): GfxLike { this.calls.push({ method: 'clear', args: [] }); return this; }
  fillStyle(color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'fillStyle', args: [color, alpha] }); return this;
  }
  lineStyle(width: number, color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'lineStyle', args: [width, color, alpha] }); return this;
  }
  fillRect(x: number, y: number, w: number, h: number): GfxLike {
    this.calls.push({ method: 'fillRect', args: [x, y, w, h] }); return this;
  }
  fillCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'fillCircle', args: [x, y, r] }); return this;
  }
  strokeCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'strokeCircle', args: [x, y, r] }); return this;
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): GfxLike {
    this.calls.push({ method: 'fillTriangle', args: [x0, y0, x1, y1, x2, y2] }); return this;
  }

  callsOf(method: string): GfxCall[] {
    return this.calls.filter(c => c.method === method);
  }
}

// ---------------------------------------------------------------------------
// SLIDER_GEOMETRY sanity (locked to HUD.TRIANGLE — single source of truth)
// ---------------------------------------------------------------------------

describe('SLIDER_GEOMETRY', () => {
  it('trackLeft = HUD.TRIANGLE.x + 16', () => {
    expect(SLIDER_GEOMETRY.trackLeft).toBe(HUD.TRIANGLE.x + 16);
  });

  it('trackRight = HUD.TRIANGLE.x + HUD.TRIANGLE.w - 16', () => {
    expect(SLIDER_GEOMETRY.trackRight).toBe(HUD.TRIANGLE.x + HUD.TRIANGLE.w - 16);
  });

  it('trackY at the vertical midpoint of HUD.TRIANGLE', () => {
    expect(SLIDER_GEOMETRY.trackY).toBe(HUD.TRIANGLE.y + HUD.TRIANGLE.h / 2);
  });

  it('trackLen = trackRight - trackLeft', () => {
    expect(SLIDER_GEOMETRY.trackLen).toBe(SLIDER_GEOMETRY.trackRight - SLIDER_GEOMETRY.trackLeft);
  });

  it('trackLen is positive (geometry sane)', () => {
    expect(SLIDER_GEOMETRY.trackLen).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// screenToSliderRatio — extremes and centerpoint
// ---------------------------------------------------------------------------

describe('screenToSliderRatio — extremes', () => {
  it('left edge of track returns full forage', () => {
    expect(screenToSliderRatio(SLIDER_GEOMETRY.trackLeft)).toEqual({ forage: 10, fight: 0 });
  });

  it('right edge of track returns full fight', () => {
    expect(screenToSliderRatio(SLIDER_GEOMETRY.trackRight)).toEqual({ forage: 0, fight: 10 });
  });

  it('exact center returns balanced 5/5', () => {
    const center = (SLIDER_GEOMETRY.trackLeft + SLIDER_GEOMETRY.trackRight) / 2;
    expect(screenToSliderRatio(center)).toEqual({ forage: 5, fight: 5 });
  });
});

describe('screenToSliderRatio — clamping', () => {
  it('px far left of track clamps to forage:10', () => {
    expect(screenToSliderRatio(SLIDER_GEOMETRY.trackLeft - 100)).toEqual({ forage: 10, fight: 0 });
  });

  it('px far right of track clamps to fight:10', () => {
    expect(screenToSliderRatio(SLIDER_GEOMETRY.trackRight + 100)).toEqual({ forage: 0, fight: 10 });
  });

  it('px = 0 (canvas left edge) clamps to forage:10', () => {
    expect(screenToSliderRatio(0)).toEqual({ forage: 10, fight: 0 });
  });

  it('px = 1000 (canvas-right-extreme) clamps to fight:10', () => {
    expect(screenToSliderRatio(1000)).toEqual({ forage: 0, fight: 10 });
  });
});

describe('screenToSliderRatio — sum invariant', () => {
  // Cover all 11 discrete steps along the track.
  for (let step = 0; step <= 10; step++) {
    const px = SLIDER_GEOMETRY.trackLeft + (step / 10) * SLIDER_GEOMETRY.trackLen;
    it(`step ${step}: forage + fight === 10 at px=${px}`, () => {
      const r = screenToSliderRatio(px);
      expect(r.forage + r.fight).toBe(10);
      expect(r.forage).toBeGreaterThanOrEqual(0);
      expect(r.fight).toBeGreaterThanOrEqual(0);
    });
  }
});

// ---------------------------------------------------------------------------
// ratioToSliderPos — inverse of screenToSliderRatio
// ---------------------------------------------------------------------------

describe('ratioToSliderPos — extremes', () => {
  it('forage=10, fight=0 returns track-left x', () => {
    const pos = ratioToSliderPos({ forage: 10, fight: 0 });
    expect(pos.x).toBe(SLIDER_GEOMETRY.trackLeft);
    expect(pos.y).toBe(SLIDER_GEOMETRY.trackY);
  });

  it('forage=0, fight=10 returns track-right x', () => {
    const pos = ratioToSliderPos({ forage: 0, fight: 10 });
    expect(pos.x).toBe(SLIDER_GEOMETRY.trackRight);
    expect(pos.y).toBe(SLIDER_GEOMETRY.trackY);
  });

  it('forage=5, fight=5 returns track midpoint', () => {
    const pos = ratioToSliderPos({ forage: 5, fight: 5 });
    expect(pos.x).toBe(SLIDER_GEOMETRY.trackLeft + SLIDER_GEOMETRY.trackLen / 2);
    expect(pos.y).toBe(SLIDER_GEOMETRY.trackY);
  });

  it('forage=0, fight=0 (degenerate) pins to track center', () => {
    const pos = ratioToSliderPos({ forage: 0, fight: 0 });
    expect(pos.x).toBe(SLIDER_GEOMETRY.trackLeft + SLIDER_GEOMETRY.trackLen / 2);
    expect(pos.y).toBe(SLIDER_GEOMETRY.trackY);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: ratioToSliderPos(screenToSliderRatio(px)).x ≈ px (snap to step)
// ---------------------------------------------------------------------------

describe('round-trip: pixel → ratio → pixel snaps to nearest step', () => {
  it('all integer px in [trackLeft, trackRight] round-trip within ½ step (~4.4px)', () => {
    const stepPx = SLIDER_GEOMETRY.trackLen / 10;
    for (let px = SLIDER_GEOMETRY.trackLeft; px <= SLIDER_GEOMETRY.trackRight; px++) {
      const r = screenToSliderRatio(px);
      const back = ratioToSliderPos(r);
      // After Math.round in screenToSliderRatio, px snaps to its nearest discrete
      // step pixel. Tolerance is half-a-step + 1 (rounding slack).
      expect(Math.abs(back.x - px)).toBeLessThanOrEqual(stepPx / 2 + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// isInsideSlider — hit-test against HUD.TRIANGLE zone
// ---------------------------------------------------------------------------

describe('isInsideSlider', () => {
  it('returns true for a point inside HUD.TRIANGLE', () => {
    expect(isInsideSlider(HUD.TRIANGLE.x + 10, HUD.TRIANGLE.y + 10)).toBe(true);
  });

  it('returns true for the track centerline', () => {
    expect(isInsideSlider(SLIDER_GEOMETRY.trackLeft + 1, SLIDER_GEOMETRY.trackY)).toBe(true);
  });

  it('returns false for a point left of the zone', () => {
    expect(isInsideSlider(HUD.TRIANGLE.x - 1, HUD.TRIANGLE.y + 10)).toBe(false);
  });

  it('returns false for a point above the zone', () => {
    expect(isInsideSlider(HUD.TRIANGLE.x + 10, HUD.TRIANGLE.y - 1)).toBe(false);
  });

  it('returns false for a point right of the zone', () => {
    expect(isInsideSlider(HUD.TRIANGLE.x + HUD.TRIANGLE.w, HUD.TRIANGLE.y + 10)).toBe(false);
  });

  it('returns false for a point below the zone', () => {
    expect(isInsideSlider(HUD.TRIANGLE.x + 10, HUD.TRIANGLE.y + HUD.TRIANGLE.h)).toBe(false);
  });

  it('top-left corner is inside (inclusive)', () => {
    expect(isInsideSlider(HUD.TRIANGLE.x, HUD.TRIANGLE.y)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// drawSlider — call sequence + visual coherence (HUD-05: Graphics + Text only)
// ---------------------------------------------------------------------------

describe('drawSlider', () => {
  it('emits exactly the expected GfxLike methods (no Image / Sprite calls)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 10, fight: 0 });
    const allowedMethods = new Set([
      'fillStyle', 'lineStyle', 'fillRect', 'fillCircle', 'strokeCircle',
    ]);
    for (const c of gfx.calls) {
      expect(allowedMethods.has(c.method)).toBe(true);
    }
  });

  it('emits ≥ 8 GfxLike calls (background + track + 2 icons + 2 markers + style)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 10, fight: 0 });
    // 4× fillRect (zone bg, track, forage icon, fight icon)
    // 1× fillCircle (current marker)
    // 1× strokeCircle (target marker)
    // ≥ 5× fillStyle / lineStyle setup calls
    expect(gfx.calls.length).toBeGreaterThanOrEqual(8);
  });

  it('emits exactly four fillRect calls (background, track, forage icon, fight icon)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 5, fight: 5 }, { forage: 5, fight: 5 });
    expect(gfx.callsOf('fillRect').length).toBe(4);
  });

  it('first fillRect is the zone background filling HUD.TRIANGLE exactly', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 10, fight: 0 });
    const firstFillRect = gfx.callsOf('fillRect')[0]!;
    expect(firstFillRect.args).toEqual([
      HUD.TRIANGLE.x, HUD.TRIANGLE.y, HUD.TRIANGLE.w, HUD.TRIANGLE.h,
    ]);
  });

  it('emits exactly one fillCircle (current marker)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 7, fight: 3 }, { forage: 5, fight: 5 });
    expect(gfx.callsOf('fillCircle').length).toBe(1);
  });

  it('emits exactly one strokeCircle (target marker)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 7, fight: 3 }, { forage: 5, fight: 5 });
    expect(gfx.callsOf('strokeCircle').length).toBe(1);
  });

  it('current marker uses COLOR_PLAYER_COLONY', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 0, fight: 10 });
    // Find the fillStyle call immediately preceding the fillCircle call.
    const fillCircleIdx = gfx.calls.findIndex(c => c.method === 'fillCircle');
    expect(fillCircleIdx).toBeGreaterThan(0);
    // Walk backwards to the most recent fillStyle.
    let lastFillStyleColor: unknown = null;
    for (let i = fillCircleIdx - 1; i >= 0; i--) {
      if (gfx.calls[i]!.method === 'fillStyle') {
        lastFillStyleColor = gfx.calls[i]!.args[0];
        break;
      }
    }
    expect(lastFillStyleColor).toBe(COLOR_PLAYER_COLONY);
  });

  it('current marker position tracks currentRatio', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 0, fight: 10 }, { forage: 10, fight: 0 });
    const fillCircle = gfx.callsOf('fillCircle')[0]!;
    const [cx] = fillCircle.args as [number, number, number];
    expect(cx).toBe(SLIDER_GEOMETRY.trackRight);
  });

  it('target marker position tracks targetRatio independently of currentRatio', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 0, fight: 10 }, { forage: 10, fight: 0 });
    const strokeCircle = gfx.callsOf('strokeCircle')[0]!;
    const [tx] = strokeCircle.args as [number, number, number];
    expect(tx).toBe(SLIDER_GEOMETRY.trackLeft);
  });
});

// ---------------------------------------------------------------------------
// createSliderDragState — initial state matches DEFAULT_BEHAVIOR_RATIO shape
// ---------------------------------------------------------------------------

describe('createSliderDragState', () => {
  it('returns isDragging=false with two-field targetRatio default', () => {
    const s = createSliderDragState();
    expect(s.isDragging).toBe(false);
    expect(s.targetRatio).toEqual({ forage: 10, fight: 0 });
  });

  it('targetRatio has no `dig` field (Phase 10 schema; D-01 LOCKED)', () => {
    const s = createSliderDragState();
    expect(s.targetRatio).not.toHaveProperty('dig');
  });

  it('produces independent objects on each call', () => {
    const a = createSliderDragState();
    const b = createSliderDragState();
    expect(a).not.toBe(b);
    expect(a.targetRatio).not.toBe(b.targetRatio);
  });
});
