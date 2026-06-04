// ant-facing-cache.test.ts — render-only heading smoothing unit tests.
//
// Covers the blending contract: first observation seeds from the raw delta,
// subsequent samples low-pass toward the incoming delta, and eviction
// conditions (useInterp=false / zone change) reset the entry so reused ant
// IDs never inherit stale headings.

import { describe, it, expect } from 'vitest';
import { AntFacingCache, computeAntRotation } from './ant-facing-cache.js';

describe('AntFacingCache', () => {
  it('first observation seeds from the raw delta (rotation matches atan2)', () => {
    const cache = new AntFacingCache();
    // Moving +x: SVG head natively on -x, so rotation atan2(-0, -16) = ±π.
    const r = cache.sample({ id: 1, zone: 0, dx: 16, dy: 0, useInterp: true });
    expect(Math.abs(r)).toBeCloseTo(Math.PI, 5);
    // Cache now tracks this ant.
    expect(cache.size).toBe(1);
  });

  it('useInterp=false returns 0 and evicts prior entry', () => {
    const cache = new AntFacingCache();
    // Establish a heading first.
    cache.sample({ id: 1, zone: 0, dx: 16, dy: 0, useInterp: true });
    expect(cache.size).toBe(1);

    // A zone flip / spawn frame / post-death reuse: useInterp=false.
    const r = cache.sample({ id: 1, zone: 0, dx: 100, dy: 100, useInterp: false });
    expect(r).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('alternating right/down samples settle toward a diagonal rotation', () => {
    const cache = new AntFacingCache();
    const id = 1;
    // The sim moves this ant one tile per tick on a cardinal grid. Simulating
    // that as alternating axis-aligned deltas of constant magnitude; the cache
    // should blend them into a consistent southeast-ish heading.
    const deltas: Array<[number, number]> = [
      [16, 0],
      [0, 16],
      [16, 0],
      [0, 16],
      [16, 0],
      [0, 16],
      [16, 0],
      [0, 16],
    ];
    let last = 0;
    for (const [dx, dy] of deltas) {
      last = cache.sample({ id, zone: 0, dx, dy, useInterp: true });
    }
    // Heading vector points into +x/+y (southeast in screen space). SVG head
    // native on -x, so rotation = atan2(-hy, -hx) lands in the third quadrant
    // (-π, -π/2). Diagonal ≈ -3π/4; after 8 alternating steps we should be
    // well inside the diagonal band, not hugging either axis.
    expect(last).toBeGreaterThan(-Math.PI);
    expect(last).toBeLessThan(-Math.PI / 2);
    // And specifically closer to the diagonal (-3π/4) than to either axis.
    const diag = (-3 * Math.PI) / 4;
    const distDiag = Math.abs(last - diag);
    const distRight = Math.abs(last - -Math.PI); // axis-aligned right
    const distDown = Math.abs(last - -Math.PI / 2); // axis-aligned down
    expect(distDiag).toBeLessThan(distRight);
    expect(distDiag).toBeLessThan(distDown);
  });

  it('stationary sample (dx=dy=0) with a prior heading keeps prior rotation — no jitter', () => {
    const cache = new AntFacingCache();
    const id = 1;
    // Establish a definite heading.
    const prior = cache.sample({ id, zone: 0, dx: 16, dy: 0, useInterp: true });
    // Now simulate a few stationary ticks. Rotation must NOT snap to 0.
    for (let i = 0; i < 5; i++) {
      const r = cache.sample({ id, zone: 0, dx: 0, dy: 0, useInterp: true });
      expect(r).toBe(prior);
    }
  });

  it('stationary sample with no prior returns 0 (stable default pose)', () => {
    const cache = new AntFacingCache();
    const r = cache.sample({ id: 99, zone: 0, dx: 0, dy: 0, useInterp: true });
    expect(r).toBe(0);
    // Should NOT create a cache entry from a zero-delta first observation —
    // we don't want a (0,0) heading driving future blends.
    expect(cache.size).toBe(0);
  });

  it('zone change evicts the stale entry and seeds fresh from the new delta', () => {
    const cache = new AntFacingCache();
    const id = 1;
    // Ant established a heading while underground (zone=1).
    cache.sample({ id, zone: 1, dx: 16, dy: 0, useInterp: true });
    // Same ant surfaces (zone=0). useInterp is typically false in this case
    // (zone flip → draw modules skip interp), but we also want zone-mismatch
    // with useInterp=true to re-seed — defensive guard.
    const r = cache.sample({ id, zone: 0, dx: 0, dy: 16, useInterp: true });
    // New heading is pure +y → rotation = atan2(-16, -0) = -π/2.
    expect(r).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('reset() clears every entry', () => {
    const cache = new AntFacingCache();
    cache.sample({ id: 1, zone: 0, dx: 16, dy: 0, useInterp: true });
    cache.sample({ id: 2, zone: 1, dx: 0, dy: 16, useInterp: true });
    expect(cache.size).toBe(2);
    cache.reset();
    expect(cache.size).toBe(0);
  });
});

describe('computeAntRotation (helper)', () => {
  it('without a cache: falls back to raw atan2 of the delta', () => {
    // No facing cache supplied → pre-smoothing behavior preserved. Used by
    // tests that don't need smoothing semantics.
    const r = computeAntRotation(undefined, 1, 0, 16, 0, true);
    expect(Math.abs(r)).toBeCloseTo(Math.PI, 5);
  });

  it('without a cache: !useInterp returns 0 (no spurious rotation on spawn/zone flip)', () => {
    const r = computeAntRotation(undefined, 1, 0, 16, 0, false);
    expect(r).toBe(0);
  });

  it('without a cache: sub-epsilon delta returns 0 (stationary default)', () => {
    const r = computeAntRotation(undefined, 1, 0, 0, 0, true);
    expect(r).toBe(0);
  });

  it('with a cache: routes through cache.sample() (observable by cache.size growth)', () => {
    const cache = new AntFacingCache();
    computeAntRotation(cache, 1, 0, 16, 0, true);
    expect(cache.size).toBe(1);
  });
});
