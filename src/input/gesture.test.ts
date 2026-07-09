// gesture.test.ts — Vitest unit tests for the pure gesture classifier (issue #18).

import { describe, it, expect } from 'vitest';
import {
  hasCrossedDragThreshold,
  classifyDragMode,
  thresholdLogicalPx,
  DRAG_THRESHOLD_PX,
} from './gesture.js';

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

describe('thresholdLogicalPx (#237 PR3 — scale-tuned drag threshold)', () => {
  it('maps ~10px physical jitter to logical px by the inverse of cssScale', () => {
    expect(thresholdLogicalPx(1)).toBe(10); // 1:1 display → ceil(10/1) = 10
    expect(thresholdLogicalPx(0.5)).toBe(20); // canvas shrunk to half → ceil(10/0.5) = 20
    expect(thresholdLogicalPx(2)).toBe(6); // enlarged 2× → ceil(5) = 5 → clamped up to the 6 floor
  });

  it('clamps to [6, 24]', () => {
    expect(thresholdLogicalPx(3)).toBe(6); // ceil(10/3) = 4 → 6 floor
    expect(thresholdLogicalPx(10)).toBe(6); // tiny logical jitter → 6 floor
    expect(thresholdLogicalPx(0.25)).toBe(24); // ceil(40) = 40 → 24 ceiling
    expect(thresholdLogicalPx(0.1)).toBe(24); // extreme shrink → 24 ceiling
  });

  it('is never looser than the fixed desktop DRAG_THRESHOLD_PX floor at any scale', () => {
    for (const s of [0.1, 0.5, 1, 1.5, 2, 3, 10]) {
      expect(thresholdLogicalPx(s)).toBeGreaterThanOrEqual(DRAG_THRESHOLD_PX);
    }
  });
});
