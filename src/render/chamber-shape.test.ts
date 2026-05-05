import { describe, expect, it } from 'vitest';

import {
  chamberSeed,
  chamberPerimeterPoints,
  NUM_PERIMETER_POINTS,
  NUM_WAVE_NODES,
  WAVE_AMPLITUDE_PX,
} from './chamber-shape.js';

describe('chamberSeed', () => {
  it('is deterministic — same inputs produce same output', () => {
    expect(chamberSeed(1, 7, 0)).toBe(chamberSeed(1, 7, 0));
    expect(chamberSeed(2, 13, 2)).toBe(chamberSeed(2, 13, 2));
  });

  it('varies by colony id', () => {
    expect(chamberSeed(1, 5, 0)).not.toBe(chamberSeed(2, 5, 0));
  });

  it('varies by chamber id', () => {
    expect(chamberSeed(1, 5, 0)).not.toBe(chamberSeed(1, 6, 0));
  });

  it('varies by chamber type', () => {
    expect(chamberSeed(1, 5, 0)).not.toBe(chamberSeed(1, 5, 1));
  });

  it('returns a non-negative 32-bit integer', () => {
    const s = chamberSeed(1, 1, 0);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });

  it('handles negative colony ids without producing the same seed for different inputs', () => {
    expect(chamberSeed(-1, 5, 0)).not.toBe(chamberSeed(-2, 5, 0));
  });

  it('produces diverse seeds across a small range of inputs (no obvious collisions)', () => {
    const seeds = new Set<number>();
    for (let cid = 0; cid < 4; cid++) {
      for (let chid = 0; chid < 16; chid++) {
        for (let ctype = 0; ctype < 3; ctype++) {
          seeds.add(chamberSeed(cid, chid, ctype));
        }
      }
    }
    expect(seeds.size).toBe(192);
  });
});

describe('chamberPerimeterPoints', () => {
  // Queen chamber default: 80x48 px at TILE_SIZE_PX=16, anchored at (0,0).
  const W = 80, H = 48;

  it('returns NUM_PERIMETER_POINTS points by default', () => {
    const points = chamberPerimeterPoints(0xdeadbeef, 0, 0, W, H);
    expect(points.length).toBe(NUM_PERIMETER_POINTS);
  });

  it('respects an explicit numPoints override', () => {
    const points = chamberPerimeterPoints(0xdeadbeef, 0, 0, W, H, 16);
    expect(points.length).toBe(16);
  });

  it('is deterministic — same seed produces identical point sequences', () => {
    const a = chamberPerimeterPoints(42, 0, 0, W, H);
    const b = chamberPerimeterPoints(42, 0, 0, W, H);
    expect(a).toEqual(b);
  });

  it('varies by seed — different chamber identities produce different perimeters', () => {
    const a = chamberPerimeterPoints(1, 0, 0, W, H);
    const b = chamberPerimeterPoints(2, 0, 0, W, H);
    const allEqual = a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);
    expect(allEqual).toBe(false);
  });

  it('translates with the topLeft anchor (offset is invariant)', () => {
    const a = chamberPerimeterPoints(7, 0, 0, W, H);
    const b = chamberPerimeterPoints(7, 100, 200, W, H);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.x).toBe(a[i]!.x + 100);
      expect(b[i]!.y).toBe(a[i]!.y + 200);
    }
  });

  it('keeps every point within jitter-bounds of the rectangle perimeter', () => {
    // Outward-normal jitter is in [-amp, +amp]. Loose bounds:
    //   x ∈ [-amp, W + amp], y ∈ [-amp, H + amp].
    const points = chamberPerimeterPoints(0xc0ffee, 0, 0, W, H);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(-WAVE_AMPLITUDE_PX - 0.001);
      expect(p.x).toBeLessThanOrEqual(W + WAVE_AMPLITUDE_PX + 0.001);
      expect(p.y).toBeGreaterThanOrEqual(-WAVE_AMPLITUDE_PX - 0.001);
      expect(p.y).toBeLessThanOrEqual(H + WAVE_AMPLITUDE_PX + 0.001);
    }
  });

  it('actually deviates from the rectangle perimeter (the wave is non-trivial)', () => {
    // Regression guard: if amplitude collapsed to 0 the polygon would equal
    // the rectangle. Verify at least one point shows non-zero displacement
    // from the nearest rectangle edge.
    const points = chamberPerimeterPoints(0xfeedf00d, 0, 0, W, H);
    let maxDev = 0;
    for (const p of points) {
      const distTop    = Math.abs(p.y);
      const distBottom = Math.abs(p.y - H);
      const distLeft   = Math.abs(p.x);
      const distRight  = Math.abs(p.x - W);
      const dev = Math.min(distTop, distBottom, distLeft, distRight);
      if (dev > maxDev) maxDev = dev;
    }
    expect(maxDev).toBeGreaterThan(0);
  });

  it('clamps amplitude on tiny chambers to leave at least 1 px margin', () => {
    // 4x4 chamber: halfMin = 2, cap = halfMin - 1 = 1. Amplitude → 1.
    const points = chamberPerimeterPoints(0xffffffff, 0, 0, 4, 4);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(-1.001);
      expect(p.x).toBeLessThanOrEqual(5.001);
      expect(p.y).toBeGreaterThanOrEqual(-1.001);
      expect(p.y).toBeLessThanOrEqual(5.001);
    }
  });

  it('handles degenerate 0-px dimensions without producing NaN', () => {
    const points = chamberPerimeterPoints(0, 0, 0, 0, 0);
    for (const p of points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('exports sane wave constants', () => {
    expect(NUM_PERIMETER_POINTS).toBeGreaterThanOrEqual(8);
    expect(NUM_WAVE_NODES).toBeGreaterThanOrEqual(2);
    expect(WAVE_AMPLITUDE_PX).toBeGreaterThan(0);
    // Wave nodes evenly divide perimeter points for clean wraparound.
    expect(NUM_PERIMETER_POINTS % NUM_WAVE_NODES).toBe(0);
  });
});
