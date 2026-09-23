// src/render/hud-layout.test.ts — #238 PR1 acceptance gate.
//
// The deep-equality snapshot below is the load-bearing test: it pins every
// unchanged LEGACY zone of buildHudLayout(DEFAULT_LAYOUT) to the exact values
// the former sprites.ts `HUD` constant held at 800×592, so the LayoutContext
// conversion provably changed zero geometry at the default size. Zones added or
// resized since (C1's ALARM_TOGGLE, #320's toggle widths) are pinned beside it.

import { describe, it, expect } from 'vitest';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';

describe('buildHudLayout', () => {
  it('keeps every unchanged legacy zone byte-identical at the default 800×592 layout', () => {
    // Verbatim from the former sprites.ts HUD block (lines 150-208).
    const EXPECTED = {
      STATS: { x: 8, y: 8, w: 200, h: 24 },
      TRIANGLE: { x: 8, y: 532, w: 120, h: 44 },
      SPEED: { x: 320, y: 552, w: 160, h: 32, PAUSE_BUTTON_W: 40, SPEED_BUTTON_W: 32 },
      HINTS: { x: 8, y: 508, w: 616, h: 18 },
      TOOLS: { x: 632, y: 36, w: 128, h: 40, BUTTON_W: 40, GAP: 4 },
      MINIMAP: { x: 632, y: 424, w: 160, h: 160 },
      SAVE_ICON: { x: 772, y: 8, w: 20, h: 20 },
    };
    // C1 added ALARM_TOGGLE, a genuinely NEW zone, and #320 deliberately widened
    // VIEW_TOGGLE (80 → 128), UNDERGROUND_COLONY_TOGGLE (112 → 128) and
    // ALARM_TOGGLE (112 → 128) so every label fits its click rect. The property
    // this test exists to guard is that the LayoutContext conversion moved no
    // LEGACY geometry, so those three are split off rather than folded into the
    // legacy table — a future edit that shifts any zone above still fails here.
    // Their positions are unchanged.
    const { ALARM_TOGGLE, VIEW_TOGGLE, UNDERGROUND_COLONY_TOGGLE, ...legacy } =
      buildHudLayout(DEFAULT_LAYOUT);
    expect(legacy).toEqual(EXPECTED);
    expect(VIEW_TOGGLE).toEqual({ x: 632, y: 396, w: 128, h: 24 });
    expect(UNDERGROUND_COLONY_TOGGLE).toEqual({ x: 632, y: 372, w: 128, h: 22 });
    expect(ALARM_TOGGLE).toEqual({ x: 632, y: 346, w: 128, h: 22 });
  });

  it('gives the three right-column toggles one shared x and width (#320)', () => {
    // One column, one width: a ragged column is how VIEW_TOGGLE ended up 80 wide
    // under a label that needed ~102px. The width itself is sized to the widest
    // label; tests/hud-button-geometry.spec.ts measures the labels against it in
    // the real renderer, since glyph widths are a property of the font.
    for (const size of [DEFAULT_LAYOUT, createLayoutContext(1000, 700)]) {
      const hud = buildHudLayout(size);
      const column = [hud.VIEW_TOGGLE, hud.UNDERGROUND_COLONY_TOGGLE, hud.ALARM_TOGGLE];
      expect(new Set(column.map((r) => r.x)).size).toBe(1);
      expect(new Set(column.map((r) => r.w)).size).toBe(1);
      // Still inside the canvas on the right.
      expect(hud.VIEW_TOGGLE.x + hud.VIEW_TOGGLE.w).toBeLessThanOrEqual(size.w);
    }
  });

  it('pins the exact height at which the alarm toggle would meet the tool palette', () => {
    // ALARM_TOGGLE is bottom-anchored (h - 246), TOOLS is top-anchored (36..76),
    // so they converge as the canvas shortens. The seam is h = 322 (346 - 246 +
    // ... i.e. h - 246 === 76). Pin BOTH sides of it so a future move of either
    // zone fails here instead of silently overlapping on a short viewport.
    const atSeam = buildHudLayout(createLayoutContext(800, 322));
    expect(atSeam.ALARM_TOGGLE.y).toBe(atSeam.TOOLS.y + atSeam.TOOLS.h);
    const below = buildHudLayout(createLayoutContext(800, 321));
    expect(below.ALARM_TOGGLE.y).toBeLessThan(below.TOOLS.y + below.TOOLS.h);
    // The other end of the zone's range: y = h - 246, so h = 246 is the exact
    // height at which it reaches the top of the canvas. Asserting this at the
    // DEFAULT height would be tautological (346 >= 0), which is no guard at all.
    expect(buildHudLayout(createLayoutContext(800, 246)).ALARM_TOGGLE.y).toBe(0);
    expect(buildHudLayout(createLayoutContext(800, 245)).ALARM_TOGGLE.y).toBeLessThan(0);
  });

  it('stacks the alarm toggle clear of the colony toggle below it', () => {
    // Both are right-column buttons; an overlap would make one of them unclickable.
    const hud = buildHudLayout(DEFAULT_LAYOUT);
    expect(hud.ALARM_TOGGLE.y + hud.ALARM_TOGGLE.h).toBeLessThanOrEqual(
      hud.UNDERGROUND_COLONY_TOGGLE.y,
    );
    expect(hud.ALARM_TOGGLE.x).toBe(hud.UNDERGROUND_COLONY_TOGGLE.x);
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
