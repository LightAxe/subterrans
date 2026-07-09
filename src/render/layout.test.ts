// layout.test.ts — the LayoutContext seam (issue #213).

import { describe, it, expect } from 'vitest';
import { createLayoutContext, cssScaleX, DEFAULT_LAYOUT } from './layout.js';
import { CANVAS_W, CANVAS_H } from './sprites.js';

describe('LayoutContext (issue #213)', () => {
  it('DEFAULT_LAYOUT carries the fixed canvas size (CANVAS_W × CANVAS_H)', () => {
    expect(DEFAULT_LAYOUT.w).toBe(CANVAS_W);
    expect(DEFAULT_LAYOUT.h).toBe(CANVAS_H);
  });

  it('createLayoutContext() defaults to the fixed canvas size', () => {
    const ctx = createLayoutContext();
    expect(ctx.w).toBe(CANVAS_W);
    expect(ctx.h).toBe(CANVAS_H);
  });

  it('createLayoutContext(w, h) carries explicit dimensions (the future responsive path)', () => {
    const ctx = createLayoutContext(1024, 768);
    expect(ctx.w).toBe(1024);
    expect(ctx.h).toBe(768);
  });
});

describe('cssScaleX (#237 PR3)', () => {
  it('returns CSS pixels per logical pixel (cssWidth / layout.w)', () => {
    const layout = createLayoutContext(800, 592);
    expect(cssScaleX(800, layout)).toBe(1); // displayed 1:1
    expect(cssScaleX(1600, layout)).toBe(2); // displayed 2× larger
    expect(cssScaleX(400, layout)).toBe(0.5); // displayed half size (phone)
  });

  it('tracks the layout width, not the fixed canvas constant', () => {
    expect(cssScaleX(512, createLayoutContext(1024, 768))).toBe(0.5);
  });
});
