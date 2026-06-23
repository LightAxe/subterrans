// layout.test.ts — the LayoutContext seam (issue #213).

import { describe, it, expect } from 'vitest';
import { createLayoutContext, DEFAULT_LAYOUT } from './layout.js';
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
