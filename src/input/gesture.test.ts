// gesture.test.ts — Vitest unit tests for the pure gesture classifier (issue #18).

import { describe, it, expect } from 'vitest';
import { hasCrossedDragThreshold, classifyDragMode, DRAG_THRESHOLD_PX } from './gesture.js';

describe('hasCrossedDragThreshold', () => {
  it('false for zero movement and for movement at the threshold', () => {
    expect(hasCrossedDragThreshold(0, 0, 0, 0)).toBe(false);
    expect(hasCrossedDragThreshold(0, 0, DRAG_THRESHOLD_PX, 0)).toBe(false);
    expect(hasCrossedDragThreshold(0, 0, 0, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it('true once either axis exceeds the threshold', () => {
    expect(hasCrossedDragThreshold(0, 0, DRAG_THRESHOLD_PX + 1, 0)).toBe(true);
    expect(hasCrossedDragThreshold(0, 0, 0, DRAG_THRESHOLD_PX + 1)).toBe(true);
  });

  it('is symmetric for negative deltas (jitter in any direction)', () => {
    expect(hasCrossedDragThreshold(100, 100, 100 - (DRAG_THRESHOLD_PX + 1), 100)).toBe(true);
    expect(hasCrossedDragThreshold(100, 100, 100, 100 - (DRAG_THRESHOLD_PX + 1))).toBe(true);
    // Sub-threshold jitter stays a tap.
    expect(
      hasCrossedDragThreshold(100, 100, 100 - DRAG_THRESHOLD_PX, 100 - DRAG_THRESHOLD_PX),
    ).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(hasCrossedDragThreshold(0, 0, 3, 0, 2)).toBe(true);
    expect(hasCrossedDragThreshold(0, 0, 2, 0, 2)).toBe(false);
  });
});

describe('classifyDragMode (the view×tool drag matrix)', () => {
  it('paints ONLY for Dig + underground', () => {
    expect(classifyDragMode('dig', 'underground')).toBe('paint');
  });

  it('pans for every other combination', () => {
    expect(classifyDragMode('command', 'surface')).toBe('pan');
    expect(classifyDragMode('command', 'underground')).toBe('pan');
    expect(classifyDragMode('dig', 'surface')).toBe('pan');
    expect(classifyDragMode('chamber', 'underground')).toBe('pan');
  });
});
