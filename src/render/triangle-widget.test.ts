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
  sliderGeometry,
  screenToSliderRatio,
  ratioToSliderPos,
  isInsideSlider,
  drawSlider,
  createSliderDragState,
} from './triangle-widget.js';
import type { GfxLike } from './draw-surface.js';
import { COLOR_PLAYER_COLONY } from './sprites.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';

// #238: triangle-widget.ts now takes the slider-zone rect (the hud.TRIANGLE box)
// as a parameter. At the default 800×592 layout `tri` == the former HUD-table TRIANGLE
// and `SG` == the former SLIDER_GEOMETRY constant, so these tests stay
// byte-identical.
const tri = buildHudLayout(DEFAULT_LAYOUT).TRIANGLE;
const SG = sliderGeometry(tri);

// ---------------------------------------------------------------------------
// MockGfx — spy recorder implementing GfxLike (matches draw-surface.test.ts pattern)
// ---------------------------------------------------------------------------

interface GfxCall {
  method: string;
  args: unknown[];
}

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];

  clear(): GfxLike {
    this.calls.push({ method: 'clear', args: [] });
    return this;
  }
  fillStyle(color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'fillStyle', args: [color, alpha] });
    return this;
  }
  lineStyle(width: number, color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'lineStyle', args: [width, color, alpha] });
    return this;
  }
  fillRect(x: number, y: number, w: number, h: number): GfxLike {
    this.calls.push({ method: 'fillRect', args: [x, y, w, h] });
    return this;
  }
  fillCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'fillCircle', args: [x, y, r] });
    return this;
  }
  strokeCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'strokeCircle', args: [x, y, r] });
    return this;
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): GfxLike {
    this.calls.push({ method: 'fillTriangle', args: [x0, y0, x1, y1, x2, y2] });
    return this;
  }

  callsOf(method: string): GfxCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

// ---------------------------------------------------------------------------
// sliderGeometry sanity (locked to the hud.TRIANGLE rect — single source of truth)
// ---------------------------------------------------------------------------

describe('sliderGeometry', () => {
  it('trackLeft = tri.x + 16', () => {
    expect(SG.trackLeft).toBe(tri.x + 16);
  });

  it('trackRight = tri.x + tri.w - 16', () => {
    expect(SG.trackRight).toBe(tri.x + tri.w - 16);
  });

  it('trackY at the vertical midpoint of tri', () => {
    expect(SG.trackY).toBe(tri.y + tri.h / 2);
  });

  it('trackLen = trackRight - trackLeft', () => {
    expect(SG.trackLen).toBe(SG.trackRight - SG.trackLeft);
  });

  it('trackLen is positive (geometry sane)', () => {
    expect(SG.trackLen).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// screenToSliderRatio — extremes and centerpoint
// ---------------------------------------------------------------------------

describe('screenToSliderRatio — extremes', () => {
  it('left edge of track returns full forage', () => {
    expect(screenToSliderRatio(SG.trackLeft, tri)).toEqual({ forage: 10, fight: 0 });
  });

  it('right edge of track returns full fight', () => {
    expect(screenToSliderRatio(SG.trackRight, tri)).toEqual({ forage: 0, fight: 10 });
  });

  it('exact center returns balanced 5/5', () => {
    const center = (SG.trackLeft + SG.trackRight) / 2;
    expect(screenToSliderRatio(center, tri)).toEqual({ forage: 5, fight: 5 });
  });
});

describe('screenToSliderRatio — clamping', () => {
  it('px far left of track clamps to forage:10', () => {
    expect(screenToSliderRatio(SG.trackLeft - 100, tri)).toEqual({ forage: 10, fight: 0 });
  });

  it('px far right of track clamps to fight:10', () => {
    expect(screenToSliderRatio(SG.trackRight + 100, tri)).toEqual({ forage: 0, fight: 10 });
  });

  it('px = 0 (canvas left edge) clamps to forage:10', () => {
    expect(screenToSliderRatio(0, tri)).toEqual({ forage: 10, fight: 0 });
  });

  it('px = 1000 (canvas-right-extreme) clamps to fight:10', () => {
    expect(screenToSliderRatio(1000, tri)).toEqual({ forage: 0, fight: 10 });
  });
});

describe('screenToSliderRatio — sum invariant', () => {
  // Cover all 11 discrete steps along the track.
  for (let step = 0; step <= 10; step++) {
    const px = SG.trackLeft + (step / 10) * SG.trackLen;
    it(`step ${step}: forage + fight === 10 at px=${px}`, () => {
      const r = screenToSliderRatio(px, tri);
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
    const pos = ratioToSliderPos({ forage: 10, fight: 0 }, tri);
    expect(pos.x).toBe(SG.trackLeft);
    expect(pos.y).toBe(SG.trackY);
  });

  it('forage=0, fight=10 returns track-right x', () => {
    const pos = ratioToSliderPos({ forage: 0, fight: 10 }, tri);
    expect(pos.x).toBe(SG.trackRight);
    expect(pos.y).toBe(SG.trackY);
  });

  it('forage=5, fight=5 returns track midpoint', () => {
    const pos = ratioToSliderPos({ forage: 5, fight: 5 }, tri);
    expect(pos.x).toBe(SG.trackLeft + SG.trackLen / 2);
    expect(pos.y).toBe(SG.trackY);
  });

  it('forage=0, fight=0 (degenerate) pins to track center', () => {
    const pos = ratioToSliderPos({ forage: 0, fight: 0 }, tri);
    expect(pos.x).toBe(SG.trackLeft + SG.trackLen / 2);
    expect(pos.y).toBe(SG.trackY);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: ratioToSliderPos(screenToSliderRatio(px)).x ≈ px (snap to step)
// ---------------------------------------------------------------------------

describe('round-trip: pixel → ratio → pixel snaps to nearest step', () => {
  it('all integer px in [trackLeft, trackRight] round-trip within ½ step (~4.4px)', () => {
    const stepPx = SG.trackLen / 10;
    for (let px = SG.trackLeft; px <= SG.trackRight; px++) {
      const r = screenToSliderRatio(px, tri);
      const back = ratioToSliderPos(r, tri);
      // After Math.round in screenToSliderRatio, px snaps to its nearest discrete
      // step pixel. Tolerance is half-a-step + 1 (rounding slack).
      expect(Math.abs(back.x - px)).toBeLessThanOrEqual(stepPx / 2 + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// isInsideSlider — hit-test against the hud.TRIANGLE zone
// ---------------------------------------------------------------------------

describe('isInsideSlider', () => {
  it('returns true for a point inside tri', () => {
    expect(isInsideSlider(tri.x + 10, tri.y + 10, tri)).toBe(true);
  });

  it('returns true for the track centerline', () => {
    expect(isInsideSlider(SG.trackLeft + 1, SG.trackY, tri)).toBe(true);
  });

  it('returns false for a point left of the zone', () => {
    expect(isInsideSlider(tri.x - 1, tri.y + 10, tri)).toBe(false);
  });

  it('returns false for a point above the zone', () => {
    expect(isInsideSlider(tri.x + 10, tri.y - 1, tri)).toBe(false);
  });

  it('returns false for a point right of the zone', () => {
    expect(isInsideSlider(tri.x + tri.w, tri.y + 10, tri)).toBe(false);
  });

  it('returns false for a point below the zone', () => {
    expect(isInsideSlider(tri.x + 10, tri.y + tri.h, tri)).toBe(false);
  });

  it('top-left corner is inside (inclusive)', () => {
    expect(isInsideSlider(tri.x, tri.y, tri)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// drawSlider — call sequence + visual coherence (HUD-05: Graphics + Text only)
// ---------------------------------------------------------------------------

describe('drawSlider', () => {
  it('emits exactly the expected GfxLike methods (no Image / Sprite calls)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 10, fight: 0 }, tri);
    const allowedMethods = new Set([
      'fillStyle',
      'lineStyle',
      'fillRect',
      'fillCircle',
      'strokeCircle',
    ]);
    for (const c of gfx.calls) {
      expect(allowedMethods.has(c.method)).toBe(true);
    }
  });

  it('emits ≥ 8 GfxLike calls (background + track + 2 icons + 2 markers + style)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 10, fight: 0 }, tri);
    // 4× fillRect (zone bg, track, forage icon, fight icon)
    // 1× fillCircle (current marker)
    // 1× strokeCircle (target marker)
    // ≥ 5× fillStyle / lineStyle setup calls
    expect(gfx.calls.length).toBeGreaterThanOrEqual(8);
  });

  it('emits exactly four fillRect calls (background, track, forage icon, fight icon)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 5, fight: 5 }, { forage: 5, fight: 5 }, tri);
    expect(gfx.callsOf('fillRect').length).toBe(4);
  });

  it('first fillRect is the zone background filling tri exactly', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 10, fight: 0 }, tri);
    const firstFillRect = gfx.callsOf('fillRect')[0]!;
    expect(firstFillRect.args).toEqual([tri.x, tri.y, tri.w, tri.h]);
  });

  it('emits exactly one fillCircle (current marker)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 7, fight: 3 }, { forage: 5, fight: 5 }, tri);
    expect(gfx.callsOf('fillCircle').length).toBe(1);
  });

  it('emits exactly one strokeCircle (target marker)', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 7, fight: 3 }, { forage: 5, fight: 5 }, tri);
    expect(gfx.callsOf('strokeCircle').length).toBe(1);
  });

  it('current marker uses COLOR_PLAYER_COLONY', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 10, fight: 0 }, { forage: 0, fight: 10 }, tri);
    // Find the fillStyle call immediately preceding the fillCircle call.
    const fillCircleIdx = gfx.calls.findIndex((c) => c.method === 'fillCircle');
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
    drawSlider(gfx, { forage: 0, fight: 10 }, { forage: 10, fight: 0 }, tri);
    const fillCircle = gfx.callsOf('fillCircle')[0]!;
    const [cx] = fillCircle.args as [number, number, number];
    expect(cx).toBe(SG.trackRight);
  });

  it('target marker position tracks targetRatio independently of currentRatio', () => {
    const gfx = new MockGfx();
    drawSlider(gfx, { forage: 0, fight: 10 }, { forage: 10, fight: 0 }, tri);
    const strokeCircle = gfx.callsOf('strokeCircle')[0]!;
    const [tx] = strokeCircle.args as [number, number, number];
    expect(tx).toBe(SG.trackLeft);
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
