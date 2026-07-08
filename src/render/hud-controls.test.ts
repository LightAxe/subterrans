// hud-controls.test.ts — Vitest unit tests for the HUD palette / speed / hint
// geometry + hit-testing (Stage 1 controls rework, issue #18).

import { describe, it, expect } from 'vitest';
import {
  TOOL_ORDER,
  toolButtonRect,
  toolButtonAt,
  SPEED_CONTROL_ORDER,
  speedControlRect,
  speedControlAt,
  hintTextFor,
  queueFullHint,
  PAUSED_QUEUE_FULL_HINT,
  RUNNING_QUEUE_FULL_HINT,
} from './hud-controls.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';

// #238: hud-controls.ts now takes the tools/speed rects; at the default 800×592
// layout hud.TOOLS / hud.SPEED == the former HUD-table TOOLS / SPEED.
const hud = buildHudLayout(DEFAULT_LAYOUT);

function center(r: { x: number; y: number; w: number; h: number }): [number, number] {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

describe('tool palette geometry + hit-testing', () => {
  it('lays out 3 buttons inside hud.TOOLS, left → right', () => {
    expect(TOOL_ORDER).toEqual(['command', 'dig', 'chamber']);
    const r0 = toolButtonRect(0, hud.TOOLS);
    const r2 = toolButtonRect(2, hud.TOOLS);
    expect(r0.x).toBe(hud.TOOLS.x);
    expect(r2.x + r2.w).toBeLessThanOrEqual(hud.TOOLS.x + hud.TOOLS.w);
  });

  it('hits each tool by its button center', () => {
    expect(toolButtonAt(...center(toolButtonRect(0, hud.TOOLS)), 'underground', hud.TOOLS)).toBe(
      'command',
    );
    expect(toolButtonAt(...center(toolButtonRect(1, hud.TOOLS)), 'underground', hud.TOOLS)).toBe(
      'dig',
    );
    expect(toolButtonAt(...center(toolButtonRect(2, hud.TOOLS)), 'underground', hud.TOOLS)).toBe(
      'chamber',
    );
  });

  it('Chamber is inert on the surface (returns null there)', () => {
    expect(toolButtonAt(...center(toolButtonRect(2, hud.TOOLS)), 'surface', hud.TOOLS)).toBeNull();
    // Command/Dig still hittable on the surface.
    expect(toolButtonAt(...center(toolButtonRect(0, hud.TOOLS)), 'surface', hud.TOOLS)).toBe(
      'command',
    );
  });

  it('returns null outside every button', () => {
    expect(toolButtonAt(0, 0, 'underground', hud.TOOLS)).toBeNull();
  });
});

describe('speed widget geometry + hit-testing', () => {
  it('lays out ⏸ + three presets inside hud.SPEED', () => {
    expect(SPEED_CONTROL_ORDER).toEqual(['pause', 1, 2, 4]);
    const rPause = speedControlRect(0, hud.SPEED);
    expect(rPause.x).toBe(hud.SPEED.x);
    expect(rPause.w).toBe(hud.SPEED.PAUSE_BUTTON_W);
    const rLast = speedControlRect(3, hud.SPEED);
    expect(rLast.x + rLast.w).toBeLessThanOrEqual(hud.SPEED.x + hud.SPEED.w);
  });

  it('hits ⏸ / 1× / 2× / 4× by their centers', () => {
    expect(speedControlAt(...center(speedControlRect(0, hud.SPEED)), hud.SPEED)).toBe('pause');
    expect(speedControlAt(...center(speedControlRect(1, hud.SPEED)), hud.SPEED)).toBe(1);
    expect(speedControlAt(...center(speedControlRect(2, hud.SPEED)), hud.SPEED)).toBe(2);
    expect(speedControlAt(...center(speedControlRect(3, hud.SPEED)), hud.SPEED)).toBe(4);
  });

  it('returns null outside the widget', () => {
    expect(speedControlAt(0, 0, hud.SPEED)).toBeNull();
  });
});

describe('hintTextFor', () => {
  it('returns a non-empty per-tool/per-view legend', () => {
    expect(hintTextFor('command', 'surface').length).toBeGreaterThan(0);
    expect(hintTextFor('dig', 'surface')).toContain('entrance');
    expect(hintTextFor('dig', 'underground')).toContain('mark');
    expect(hintTextFor('chamber', 'underground')).toContain('chamber');
  });
});

describe('queueFullHint (Fix 3 — accurate paused-vs-running message)', () => {
  it('paused → the resume-to-continue message', () => {
    expect(queueFullHint(true)).toBe(PAUSED_QUEUE_FULL_HINT);
    expect(queueFullHint(true)).toContain('resume');
  });

  it('running → the transient try-again message (NOT the resume message)', () => {
    expect(queueFullHint(false)).toBe(RUNNING_QUEUE_FULL_HINT);
    expect(queueFullHint(false)).not.toContain('resume');
  });

  it('the two messages are distinct and both non-empty', () => {
    expect(PAUSED_QUEUE_FULL_HINT.length).toBeGreaterThan(0);
    expect(RUNNING_QUEUE_FULL_HINT.length).toBeGreaterThan(0);
    expect(PAUSED_QUEUE_FULL_HINT).not.toBe(RUNNING_QUEUE_FULL_HINT);
  });
});
