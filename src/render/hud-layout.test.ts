// src/render/hud-layout.test.ts — #238 PR1 acceptance gate.
//
// The deep-equality snapshot below is the load-bearing test: it pins
// buildHudLayout(DEFAULT_LAYOUT) to the exact values the former sprites.ts `HUD`
// constant held at 800×592, so the LayoutContext conversion provably changed
// zero geometry at the default size.

import { describe, it, expect } from 'vitest';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';

describe('buildHudLayout', () => {
  it('is byte-identical to the legacy HUD table at the default 800×592 layout', () => {
    // Verbatim from the former sprites.ts HUD block (lines 150-208).
    const EXPECTED = {
      STATS: { x: 8, y: 8, w: 200, h: 24 },
      TRIANGLE: { x: 8, y: 532, w: 120, h: 44 },
      SPEED: { x: 320, y: 552, w: 160, h: 32, PAUSE_BUTTON_W: 40, SPEED_BUTTON_W: 32 },
      HINTS: { x: 8, y: 508, w: 616, h: 18 },
      TOOLS: { x: 632, y: 36, w: 128, h: 40, BUTTON_W: 40, GAP: 4 },
      MINIMAP: { x: 632, y: 424, w: 160, h: 160 },
      VIEW_TOGGLE: { x: 632, y: 396, w: 80, h: 24 },
      UNDERGROUND_COLONY_TOGGLE: { x: 632, y: 372, w: 112, h: 22 },
      SAVE_ICON: { x: 772, y: 8, w: 20, h: 20 },
    };
    expect(buildHudLayout(DEFAULT_LAYOUT)).toEqual(EXPECTED);
  });

  it('reflows right/bottom-anchored zones with the layout size', () => {
    const hud = buildHudLayout(createLayoutContext(1000, 700));
    expect(hud.MINIMAP.x).toBe(832); // 1000 - 168
    expect(hud.MINIMAP.y).toBe(532); // 700 - 168
    expect(hud.SAVE_ICON.x).toBe(972); // 1000 - 28
    expect(hud.SPEED.x).toBe(420); // 1000/2 - 80
    expect(hud.TRIANGLE.y).toBe(640); // 700 - 60
    // Top-left-anchored zones are size-independent.
    expect(hud.STATS).toEqual({ x: 8, y: 8, w: 200, h: 24 });
  });
});
