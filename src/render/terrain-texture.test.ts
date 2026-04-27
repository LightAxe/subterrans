// terrain-texture.test.ts — unit tests for render-only terrain texture helpers.

import { describe, expect, it } from 'vitest';
import type { GfxLike } from './draw-surface.js';
import { COLOR_UNDERGROUND_OPEN_DUST, TILE_SIZE_PX } from './sprites.js';
import {
  drawGrassTexture,
  drawSurfaceDirtTexture,
  drawUndergroundOpenTexture,
  drawUndergroundSolidTexture,
} from './terrain-texture.js';

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

function drawAllTextures(gfx: GfxLike, screenX: number, screenY: number, tileX: number, tileY: number): void {
  drawGrassTexture(gfx, screenX, screenY, tileX, tileY);
  drawSurfaceDirtTexture(gfx, screenX, screenY, tileX, tileY);
  drawUndergroundSolidTexture(gfx, screenX, screenY, tileX, tileY);
  drawUndergroundOpenTexture(gfx, screenX, screenY, tileX, tileY);
}

describe('terrain texture helpers', () => {
  it('produce stable draw calls for the same tile coordinates', () => {
    const a = new MockGfx();
    const b = new MockGfx();
    drawAllTextures(a, 32, 48, 12, 34);
    drawAllTextures(b, 32, 48, 12, 34);
    expect(a.calls).toEqual(b.calls);
  });

  it('keeps every texture mark inside the target 16px tile', () => {
    const screenX = 32;
    const screenY = 48;
    for (let tileY = 0; tileY < TILE_SIZE_PX; tileY++) {
      for (let tileX = 0; tileX < TILE_SIZE_PX; tileX++) {
        const gfx = new MockGfx();
        drawAllTextures(gfx, screenX, screenY, tileX, tileY);

        for (const call of gfx.callsOf('fillRect')) {
          const [x, y, w, h] = call.args as [number, number, number, number];
          expect(x).toBeGreaterThanOrEqual(screenX);
          expect(y).toBeGreaterThanOrEqual(screenY);
          expect(x + w).toBeLessThanOrEqual(screenX + TILE_SIZE_PX);
          expect(y + h).toBeLessThanOrEqual(screenY + TILE_SIZE_PX);
        }
      }
    }
  });

  it('does not gate open-dust bonus pixels on primary pixel x parity', () => {
    const counts = {
      bonusEven: 0,
      bonusOdd: 0,
      noBonusEven: 0,
      noBonusOdd: 0,
    };

    for (let tileY = 0; tileY < 32; tileY++) {
      for (let tileX = 0; tileX < 32; tileX++) {
        const gfx = new MockGfx();
        drawUndergroundOpenTexture(gfx, 0, 0, tileX, tileY);

        let currentStyle: unknown = null;
        const dustRects: GfxCall[] = [];
        for (const call of gfx.calls) {
          if (call.method === 'fillStyle') {
            currentStyle = call.args[0];
            continue;
          }
          if (call.method === 'fillRect' && currentStyle === COLOR_UNDERGROUND_OPEN_DUST) {
            dustRects.push(call);
          }
        }

        const primaryX = dustRects[0]!.args[0] as number;
        const hasBonus = dustRects.length > 1;
        if (hasBonus && primaryX % 2 === 0) counts.bonusEven++;
        if (hasBonus && primaryX % 2 === 1) counts.bonusOdd++;
        if (!hasBonus && primaryX % 2 === 0) counts.noBonusEven++;
        if (!hasBonus && primaryX % 2 === 1) counts.noBonusOdd++;
      }
    }

    expect(counts.bonusEven).toBeGreaterThan(150);
    expect(counts.bonusOdd).toBeGreaterThan(150);
    expect(counts.noBonusEven).toBeGreaterThan(150);
    expect(counts.noBonusOdd).toBeGreaterThan(150);
  });
});
