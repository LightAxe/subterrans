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

  it('always covers the original rectangle (no inward dip past the rectangle edge)', () => {
    // The substrate-bleed-through fix: the perimeter walks an inflated
    // rectangle, so the worst inward swing of the wave reaches exactly
    // the original rectangle edge — never crosses inside. This means
    // every perimeter point's x lies in [-2*amp, 0] ∪ [W, W+2*amp] OR
    // y lies in [-2*amp, 0] ∪ [H, H+2*amp] — ie. is never strictly
    // inside the rectangle [0, W] × [0, H].
    const points = chamberPerimeterPoints(0xc0ffee, 0, 0, W, H);
    const epsilon = 0.001;
    for (const p of points) {
      const inX = p.x > epsilon && p.x < W - epsilon;
      const inY = p.y > epsilon && p.y < H - epsilon;
      // A point is "strictly inside" iff BOTH x and y are strictly inside.
      // Boundary points (x=0 or x=W, etc.) are allowed — they're the worst-
      // inward-swing case the inflation guarantees.
      expect(inX && inY).toBe(false);
    }
  });

  it('keeps every point within outward-jitter bounds (2 × amplitude beyond the rectangle)', () => {
    // Inflated walking: outward swing is up to amp beyond the inflated
    // rectangle, which is itself amp beyond the original — total 2*amp
    // beyond the original rectangle on each side.
    const points = chamberPerimeterPoints(0xc0ffee, 0, 0, W, H);
    const cap = 2 * WAVE_AMPLITUDE_PX + 0.001;
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(-cap);
      expect(p.x).toBeLessThanOrEqual(W + cap);
      expect(p.y).toBeGreaterThanOrEqual(-cap);
      expect(p.y).toBeLessThanOrEqual(H + cap);
    }
  });

  it('actually deviates from the inflated rectangle perimeter (the wave is non-trivial)', () => {
    // Regression guard against amp=0. Verify at least one point shows
    // non-zero displacement from the nearest INFLATED rectangle edge.
    const points = chamberPerimeterPoints(0xfeedf00d, 0, 0, W, H);
    const amp = WAVE_AMPLITUDE_PX;
    let maxDev = 0;
    for (const p of points) {
      // Distance to the inflated rectangle's edges:
      const distTop    = Math.abs(p.y - (-amp));
      const distBottom = Math.abs(p.y - (H + amp));
      const distLeft   = Math.abs(p.x - (-amp));
      const distRight  = Math.abs(p.x - (W + amp));
      const dev = Math.min(distTop, distBottom, distLeft, distRight);
      if (dev > maxDev) maxDev = dev;
    }
    expect(maxDev).toBeGreaterThan(0);
  });

  it('clamps amplitude on tiny chambers to leave at least 1 px margin', () => {
    // 4x4 chamber: halfMin = 2, cap = halfMin - 1 = 1. Amplitude → 1.
    // Inflated rect: (-1, -1) to (5, 5). Outward swing of 1 → up to 2*1=2
    // beyond original.
    const points = chamberPerimeterPoints(0xffffffff, 0, 0, 4, 4);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(-2.001);
      expect(p.x).toBeLessThanOrEqual(6.001);
      expect(p.y).toBeGreaterThanOrEqual(-2.001);
      expect(p.y).toBeLessThanOrEqual(6.001);
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
