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
import { HUD } from './sprites.js';

function center(r: { x: number; y: number; w: number; h: number }): [number, number] {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

describe('tool palette geometry + hit-testing', () => {
  it('lays out 3 buttons inside HUD.TOOLS, left → right', () => {
    expect(TOOL_ORDER).toEqual(['command', 'dig', 'chamber']);
    const r0 = toolButtonRect(0);
    const r2 = toolButtonRect(2);
    expect(r0.x).toBe(HUD.TOOLS.x);
    expect(r2.x + r2.w).toBeLessThanOrEqual(HUD.TOOLS.x + HUD.TOOLS.w);
  });

  it('hits each tool by its button center', () => {
    expect(toolButtonAt(...center(toolButtonRect(0)), 'underground')).toBe('command');
    expect(toolButtonAt(...center(toolButtonRect(1)), 'underground')).toBe('dig');
    expect(toolButtonAt(...center(toolButtonRect(2)), 'underground')).toBe('chamber');
  });

  it('Chamber is inert on the surface (returns null there)', () => {
    expect(toolButtonAt(...center(toolButtonRect(2)), 'surface')).toBeNull();
    // Command/Dig still hittable on the surface.
    expect(toolButtonAt(...center(toolButtonRect(0)), 'surface')).toBe('command');
  });

  it('returns null outside every button', () => {
    expect(toolButtonAt(0, 0, 'underground')).toBeNull();
  });
});

describe('speed widget geometry + hit-testing', () => {
  it('lays out ⏸ + three presets inside HUD.SPEED', () => {
    expect(SPEED_CONTROL_ORDER).toEqual(['pause', 1, 2, 4]);
    const rPause = speedControlRect(0);
    expect(rPause.x).toBe(HUD.SPEED.x);
    expect(rPause.w).toBe(HUD.SPEED.PAUSE_BUTTON_W);
    const rLast = speedControlRect(3);
    expect(rLast.x + rLast.w).toBeLessThanOrEqual(HUD.SPEED.x + HUD.SPEED.w);
  });

  it('hits ⏸ / 1× / 2× / 4× by their centers', () => {
    expect(speedControlAt(...center(speedControlRect(0)))).toBe('pause');
    expect(speedControlAt(...center(speedControlRect(1)))).toBe(1);
    expect(speedControlAt(...center(speedControlRect(2)))).toBe(2);
    expect(speedControlAt(...center(speedControlRect(3)))).toBe(4);
  });

  it('returns null outside the widget', () => {
    expect(speedControlAt(0, 0)).toBeNull();
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
