// hp-bar.test.ts — #427: the shared world-space HP bar (the spider's since #148, the
// enemy queen's since #427).
import { describe, it, expect } from 'vitest';
import {
  createHpBarDrawn,
  drawHpBar,
  hpBarFillColor,
  hpBarFillWidth,
  hpRatio,
  HP_BAR_GAP,
  HP_BAR_H,
  HP_BAR_OUTLINE_COLOR,
  HP_BAR_TRACK_COLOR,
  HP_BAR_W,
} from './hp-bar.js';
import type { GfxLike } from './draw-surface.js';

class RecordingGfx implements GfxLike {
  calls: { method: string; args: number[] }[] = [];
  private rec(method: string, args: number[]): GfxLike {
    this.calls.push({ method, args });
    return this;
  }
  clear(): GfxLike {
    return this.rec('clear', []);
  }
  fillStyle(color: number, alpha = 1): GfxLike {
    return this.rec('fillStyle', [color, alpha]);
  }
  lineStyle(width: number, color: number, alpha = 1): GfxLike {
    return this.rec('lineStyle', [width, color, alpha]);
  }
  fillRect(x: number, y: number, w: number, h: number): GfxLike {
    return this.rec('fillRect', [x, y, w, h]);
  }
  fillCircle(x: number, y: number, r: number): GfxLike {
    return this.rec('fillCircle', [x, y, r]);
  }
  strokeCircle(x: number, y: number, r: number): GfxLike {
    return this.rec('strokeCircle', [x, y, r]);
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): GfxLike {
    return this.rec('fillTriangle', [x0, y0, x1, y1, x2, y2]);
  }
}

describe('hpRatio', () => {
  it('is hp over max HP, clamped to [0, 1]', () => {
    expect(hpRatio(25, 50)).toBe(0.5);
    expect(hpRatio(23, 46)).toBe(0.5);
    expect(hpRatio(46, 50)).toBe(0.92);
    expect(hpRatio(60, 50)).toBe(1);
    expect(hpRatio(-3, 50)).toBe(0);
  });

  it('is 0 for a non-positive or missing max', () => {
    expect(hpRatio(10, 0)).toBe(0);
    expect(hpRatio(10, -5)).toBe(0);
    expect(hpRatio(10, Number.NaN)).toBe(0);
  });
});

describe('hpBarFillWidth', () => {
  it('fills the whole track at full HP and none at 0', () => {
    expect(hpBarFillWidth(1)).toBe(HP_BAR_W);
    expect(hpBarFillWidth(0)).toBe(0);
  });

  it('is the rounded fraction of the track in between', () => {
    expect(hpBarFillWidth(0.5)).toBe(12);
    expect(hpBarFillWidth(20 / 50)).toBe(Math.round(HP_BAR_W * 0.4)); // 10
    expect(hpBarFillWidth(23 / 50)).toBe(11);
  });

  it('never shows a wound as full, nor HP left as empty (#148 P3-2)', () => {
    expect(hpBarFillWidth(49 / 50)).toBe(HP_BAR_W - 1);
    expect(hpBarFillWidth(1 / 50)).toBe(1);
    for (let hp = 1; hp < 50; hp++) {
      const w = hpBarFillWidth(hp / 50);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(HP_BAR_W - 1);
    }
  });
});

describe('hpBarFillColor', () => {
  const green = (c: number): number => (c >> 8) & 0xff;
  const red = (c: number): number => (c >> 16) & 0xff;

  it('runs green at full, yellow at half, red near empty', () => {
    expect(hpBarFillColor(1)).toBe(0x33cc33);
    expect(hpBarFillColor(0.5)).toBe(0xffcc00);
    expect(hpBarFillColor(0)).toBe(0xcc2020);
    expect(green(hpBarFillColor(0.9))).toBeGreaterThan(red(hpBarFillColor(0.9)));
    expect(red(hpBarFillColor(0.1))).toBeGreaterThan(green(hpBarFillColor(0.1)));
  });
});

describe('drawHpBar', () => {
  it('draws outline, track and fill, centred above the sprite top, and records them', () => {
    const gfx = new RecordingGfx();
    const out = createHpBarDrawn();
    const got = drawHpBar(gfx, 100, 50, 0.4, out);
    expect(got).toBe(out);
    const x = 100 - HP_BAR_W / 2;
    const y = 50 - HP_BAR_H - HP_BAR_GAP;
    expect(gfx.calls).toEqual([
      { method: 'fillStyle', args: [HP_BAR_OUTLINE_COLOR, 0.7] },
      { method: 'fillRect', args: [x - 1, y - 1, HP_BAR_W + 2, HP_BAR_H + 2] },
      { method: 'fillStyle', args: [HP_BAR_TRACK_COLOR, 0.85] },
      { method: 'fillRect', args: [x, y, HP_BAR_W, HP_BAR_H] },
      { method: 'fillStyle', args: [hpBarFillColor(0.4), 1] },
      { method: 'fillRect', args: [x, y, hpBarFillWidth(0.4), HP_BAR_H] },
    ]);
    expect(out).toEqual({
      x,
      y,
      w: HP_BAR_W,
      h: HP_BAR_H,
      fillW: hpBarFillWidth(0.4),
      color: hpBarFillColor(0.4),
      ratio: 0.4,
    });
  });

  it('rounds the box to whole pixels and clamps the ratio', () => {
    const gfx = new RecordingGfx();
    const out = drawHpBar(gfx, 100.4, 50.6, 1.7, createHpBarDrawn());
    expect(Number.isInteger(out.x) && Number.isInteger(out.y)).toBe(true);
    expect(out.ratio).toBe(1);
    expect(out.fillW).toBe(HP_BAR_W);
  });
});
