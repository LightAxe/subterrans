import { describe, expect, it } from 'vitest';

import {
  chamberSeed,
  chamberPerimeterPoints,
  NUM_PERIMETER_POINTS,
  NUM_CORNER_ARC_SAMPLES,
  NUM_WAVE_NODES,
  WAVE_AMPLITUDE_PX,
  CORNER_RADIUS_PX,
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

  it('returns NUM_PERIMETER_POINTS edge samples + 4 × NUM_CORNER_ARC_SAMPLES arc samples by default', () => {
    const points = chamberPerimeterPoints(0xdeadbeef, 0, 0, W, H);
    expect(points.length).toBe(NUM_PERIMETER_POINTS + 4 * NUM_CORNER_ARC_SAMPLES);
  });

  it('respects an explicit numEdgeSamples override (still adds 4 × NUM_CORNER_ARC_SAMPLES arc samples)', () => {
    const points = chamberPerimeterPoints(0xdeadbeef, 0, 0, W, H, 16);
    expect(points.length).toBe(16 + 4 * NUM_CORNER_ARC_SAMPLES);
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

  it('always covers the original rectangle: no perimeter point is strictly inside [0, W] × [0, H]', () => {
    // The substrate-bleed-through fix part 1: the perimeter walks an
    // inflated rectangle, so the worst inward swing of the wave reaches
    // exactly the original rectangle edge — never crosses inside.
    const points = chamberPerimeterPoints(0xc0ffee, 0, 0, W, H);
    const epsilon = 0.001;
    for (const p of points) {
      const inX = p.x > epsilon && p.x < W - epsilon;
      const inY = p.y > epsilon && p.y < H - epsilon;
      expect(inX && inY).toBe(false);
    }
  });

  it('always covers the original rectangle: no chord between adjacent points cuts the interior (codex P1 repro on seed=0)', () => {
    // Bleed-through fix part 2: even if every vertex stays outside the
    // rectangle, the chord between adjacent vertices can dip across a
    // corner into the rectangle interior. The corner-sample insertion
    // wraps each corner externally so adjacent chords stay outside.
    //
    // Specific repro from codex P1 on PR #100: seed=0, W=80, H=48 — without
    // corner samples, a segment near (0.01, 0.79) inside bounds appears.
    const points = chamberPerimeterPoints(0, 0, 0, W, H);
    const epsilon = 0.001;
    const stepsPerChord = 32;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      for (let s = 1; s < stepsPerChord; s++) {
        const tStep = s / stepsPerChord;
        const x = a.x + (b.x - a.x) * tStep;
        const y = a.y + (b.y - a.y) * tStep;
        const inX = x > epsilon && x < W - epsilon;
        const inY = y > epsilon && y < H - epsilon;
        expect(
          inX && inY,
          `Chord between point ${i} and ${i + 1} crosses interior at (${x.toFixed(3)}, ${y.toFixed(3)})`,
        ).toBe(false);
      }
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

  it('produces non-trivial wave variation on the straight edges (regression guard against amp=0)', () => {
    // Regression guard: if amplitude collapsed to 0 every top-edge sample
    // would sit at y = -amp (the inflated edge). Verify at least one
    // top-edge point's y differs from -amp by more than a half-pixel.
    const points = chamberPerimeterPoints(0xfeedf00d, 0, 0, W, H);
    const amp = WAVE_AMPLITUDE_PX;
    let maxYDev = 0;
    for (const p of points) {
      // Top-edge samples have baseY = -amp; jittered y deviates outward
      // (y < -amp) or inward (y > -amp). Skip points clearly not on the
      // top edge (large |y - (-amp)| means corner arc or other edge).
      const dy = Math.abs(p.y - (-amp));
      // Corner arcs at TL/TR have y up to (-amp + R) ≈ 3, far from -amp.
      // Filter to "near top edge" by capping at 2*amp = 6 px deviation.
      if (dy <= 2 * amp + 0.001 && p.x > 0 && p.x < W) {
        if (dy > maxYDev) maxYDev = dy;
      }
    }
    expect(maxYDev).toBeGreaterThan(0);
  });

  it('clamps amplitude on tiny chambers to leave at least 1 px margin', () => {
    // 4x4 chamber: halfMin = 2, ampCap = halfMin - 1 = 1. Amplitude → 1.
    // With cornerR clamped to ≤ 3*amp = 3, but also halfMin=3 of inflated
    // (= 6/2), so cornerR ≤ 3.
    const points = chamberPerimeterPoints(0xffffffff, 0, 0, 4, 4);
    for (const p of points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      // Outward bounds: edge wave up to 2*amp = 2 beyond rectangle.
      // Corner arcs stay within the inflated rect (amp = 1 beyond).
      // So overall extent is at most 2 px beyond the rectangle.
      expect(p.x).toBeGreaterThanOrEqual(-2.001);
      expect(p.x).toBeLessThanOrEqual(6.001);
      expect(p.y).toBeGreaterThanOrEqual(-2.001);
      expect(p.y).toBeLessThanOrEqual(6.001);
    }
  });

  it('inscribes corner arcs that stay outside the original rectangle', () => {
    // Corner-arc midpoints sit at distance (R - amp) * √2 from the
    // original rectangle's nearest corner, in the diagonal-outward
    // direction. With R = CORNER_RADIUS_PX = 6 and amp = 3, the midpoint
    // is at (~-1.24, ~-1.24) for the TL corner — outside the rectangle.
    // The clampCornerRadius bound of 3 × amp keeps this guarantee.
    const points = chamberPerimeterPoints(0xc0ffee, 0, 0, W, H);
    expect(CORNER_RADIUS_PX).toBeLessThanOrEqual(3 * WAVE_AMPLITUDE_PX);
    // Sanity: at least 4 × 5 = 20 points lie at distances near
    // CORNER_RADIUS_PX from one of the four arc centers (the corner
    // arcs themselves).
    const arcCenters = [
      { cx: -WAVE_AMPLITUDE_PX + CORNER_RADIUS_PX,        cy: -WAVE_AMPLITUDE_PX + CORNER_RADIUS_PX },
      { cx:  W + WAVE_AMPLITUDE_PX - CORNER_RADIUS_PX,    cy: -WAVE_AMPLITUDE_PX + CORNER_RADIUS_PX },
      { cx:  W + WAVE_AMPLITUDE_PX - CORNER_RADIUS_PX,    cy:  H + WAVE_AMPLITUDE_PX - CORNER_RADIUS_PX },
      { cx: -WAVE_AMPLITUDE_PX + CORNER_RADIUS_PX,        cy:  H + WAVE_AMPLITUDE_PX - CORNER_RADIUS_PX },
    ];
    let arcLikePoints = 0;
    for (const p of points) {
      for (const c of arcCenters) {
        const d = Math.hypot(p.x - c.cx, p.y - c.cy);
        if (Math.abs(d - CORNER_RADIUS_PX) < 0.001) arcLikePoints++;
      }
    }
    expect(arcLikePoints).toBe(4 * NUM_CORNER_ARC_SAMPLES);
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
