// tooltips.test.ts — Stage 3b (#5): control-widget hit-test (incl. the disabled
// Chamber-on-surface) and ≤150-char copy.

import { describe, it, expect } from 'vitest';
import { toolButtonRect, speedControlRect } from './hud-controls.js';
import {
  tooltipTargetAt,
  tooltipTextFor,
  sameTooltipTarget,
  type TooltipTarget,
} from './tooltips.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';

// #238: tooltips.ts + hud-controls.ts now take the built HUD layout / its rects;
// at the default 800×592 layout hud.* == the former HUD table.
const hud = buildHudLayout(DEFAULT_LAYOUT);

const center = (r: { x: number; y: number; w: number; h: number }) => ({
  x: r.x + r.w / 2,
  y: r.y + r.h / 2,
});

describe('tooltipTargetAt', () => {
  it('hits the stats bar', () => {
    const c = center(hud.STATS);
    expect(tooltipTargetAt(c.x, c.y, 'surface', hud)?.kind).toBe('stats');
  });

  it('hits the view toggle', () => {
    const c = center(hud.VIEW_TOGGLE);
    expect(tooltipTargetAt(c.x, c.y, 'surface', hud)?.kind).toBe('view-toggle');
  });

  it('hits the colony toggle ONLY on the underground view', () => {
    const c = center(hud.UNDERGROUND_COLONY_TOGGLE);
    expect(tooltipTargetAt(c.x, c.y, 'underground', hud)?.kind).toBe('colony-toggle');
    // On the surface the toggle isn't rendered, so its rect is not a tooltip
    // target (and nothing else lives there).
    expect(tooltipTargetAt(c.x, c.y, 'surface', hud)).toBeNull();
  });

  it('hits an enabled tool button', () => {
    const c = center(toolButtonRect(1, hud.TOOLS)); // Dig
    const t = tooltipTargetAt(c.x, c.y, 'underground', hud);
    expect(t).toEqual({ kind: 'tool', tool: 'dig', enabled: true, anchor: hud.TOOLS });
  });

  it('STILL hits the DISABLED Chamber button on the surface (enabled:false)', () => {
    const c = center(toolButtonRect(2, hud.TOOLS)); // Chamber
    const t = tooltipTargetAt(c.x, c.y, 'surface', hud);
    expect(t).toEqual({ kind: 'tool', tool: 'chamber', enabled: false, anchor: hud.TOOLS });
    // …and it's enabled underground.
    const u = tooltipTargetAt(c.x, c.y, 'underground', hud);
    expect(u).toMatchObject({ kind: 'tool', tool: 'chamber', enabled: true });
  });

  it('hits the speed widget (pause + a preset)', () => {
    const pause = center(speedControlRect(0, hud.SPEED));
    expect(tooltipTargetAt(pause.x, pause.y, 'surface', hud)).toMatchObject({
      kind: 'speed',
      control: 'pause',
    });
    const two = center(speedControlRect(2, hud.SPEED)); // 2×
    expect(tooltipTargetAt(two.x, two.y, 'surface', hud)).toMatchObject({
      kind: 'speed',
      control: 2,
    });
  });

  it('hits the Forage↔Fight slider', () => {
    const c = center(hud.TRIANGLE);
    expect(tooltipTargetAt(c.x, c.y, 'surface', hud)?.kind).toBe('slider');
  });

  it('returns null over open world / the minimap (excluded)', () => {
    expect(tooltipTargetAt(400, 300, 'surface', hud)).toBeNull();
    const m = center(hud.MINIMAP);
    expect(tooltipTargetAt(m.x, m.y, 'underground', hud)).toBeNull();
  });
});

describe('tooltipTextFor', () => {
  const all: TooltipTarget[] = [
    { kind: 'tool', tool: 'command', enabled: true, anchor: hud.TOOLS },
    { kind: 'tool', tool: 'dig', enabled: true, anchor: hud.TOOLS },
    { kind: 'tool', tool: 'chamber', enabled: true, anchor: hud.TOOLS },
    { kind: 'tool', tool: 'chamber', enabled: false, anchor: hud.TOOLS },
    { kind: 'speed', control: 'pause', anchor: hud.SPEED },
    { kind: 'speed', control: 2, anchor: hud.SPEED },
    { kind: 'view-toggle', anchor: hud.VIEW_TOGGLE },
    { kind: 'colony-toggle', anchor: hud.UNDERGROUND_COLONY_TOGGLE },
    { kind: 'slider', anchor: hud.TRIANGLE },
    { kind: 'stats', anchor: hud.STATS },
  ];

  it('every tooltip is non-empty and ≤150 chars', () => {
    for (const t of all) {
      const text = tooltipTextFor(t);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length, `"${text}" too long`).toBeLessThanOrEqual(150);
    }
  });

  it('the disabled Chamber explains WHY it is inert', () => {
    expect(
      tooltipTextFor({ kind: 'tool', tool: 'chamber', enabled: false, anchor: hud.TOOLS }),
    ).toBe('Chamber — underground only');
  });

  it('STATS teaches the non-obvious ant-activity click', () => {
    expect(tooltipTextFor({ kind: 'stats', anchor: hud.STATS }).toLowerCase()).toContain(
      'ant-activity',
    );
  });

  it('includes the keyboard glyph where a key exists', () => {
    expect(tooltipTextFor({ kind: 'view-toggle', anchor: hud.VIEW_TOGGLE })).toContain('[Tab]');
  });
});

describe('sameTooltipTarget', () => {
  it('distinguishes different tools and matches same tool', () => {
    const dig: TooltipTarget = { kind: 'tool', tool: 'dig', enabled: true, anchor: hud.TOOLS };
    const dig2: TooltipTarget = { kind: 'tool', tool: 'dig', enabled: true, anchor: hud.TOOLS };
    const cmd: TooltipTarget = { kind: 'tool', tool: 'command', enabled: true, anchor: hud.TOOLS };
    expect(sameTooltipTarget(dig, dig2)).toBe(true);
    expect(sameTooltipTarget(dig, cmd)).toBe(false);
  });

  it('null handling', () => {
    expect(sameTooltipTarget(null, null)).toBe(true);
    expect(sameTooltipTarget(null, { kind: 'stats', anchor: hud.STATS })).toBe(false);
  });
});
