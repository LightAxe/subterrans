import { describe, expect, it } from 'vitest';

import {
  chamberSeed,
  chamberCornerRadius,
  CHAMBER_CORNER_RADIUS_MIN,
  CHAMBER_CORNER_RADIUS_RANGE,
} from './chamber-shape.js';

describe('chamberSeed', () => {
  it('is deterministic — same inputs produce same output', () => {
    expect(chamberSeed(1, 7, 0)).toBe(chamberSeed(1, 7, 0));
    expect(chamberSeed(2, 13, 2)).toBe(chamberSeed(2, 13, 2));
  });

  it('varies by colony id', () => {
    const a = chamberSeed(1, 5, 0);
    const b = chamberSeed(2, 5, 0);
    expect(a).not.toBe(b);
  });

  it('varies by chamber id', () => {
    const a = chamberSeed(1, 5, 0);
    const b = chamberSeed(1, 6, 0);
    expect(a).not.toBe(b);
  });

  it('varies by chamber type', () => {
    const a = chamberSeed(1, 5, 0);
    const b = chamberSeed(1, 5, 1);
    expect(a).not.toBe(b);
  });

  it('returns a non-negative 32-bit integer', () => {
    const s = chamberSeed(1, 1, 0);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });

  it('handles negative colony ids without producing the same seed for different inputs', () => {
    // Defensive: enemy colony ids could in principle be negative in some
    // future iteration. Math.imul handles that, but verify diversity.
    const a = chamberSeed(-1, 5, 0);
    const b = chamberSeed(-2, 5, 0);
    expect(a).not.toBe(b);
  });
});

describe('chamberCornerRadius', () => {
  it('returns a value in the documented [MIN, MIN + RANGE - 1] band', () => {
    for (let s = 0; s < 64; s++) {
      const r = chamberCornerRadius(s, 80, 48);
      expect(r).toBeGreaterThanOrEqual(CHAMBER_CORNER_RADIUS_MIN);
      expect(r).toBeLessThanOrEqual(CHAMBER_CORNER_RADIUS_MIN + CHAMBER_CORNER_RADIUS_RANGE - 1);
    }
  });

  it('caps at half the smaller bounding dimension', () => {
    // Tiny chamber: 8x8 → radius capped at 4 even for high seed bits.
    const r = chamberCornerRadius(0xffffffff, 8, 8);
    expect(r).toBeLessThanOrEqual(4);
  });

  it('produces stable output for the same seed', () => {
    expect(chamberCornerRadius(12345, 80, 48)).toBe(chamberCornerRadius(12345, 80, 48));
  });
});
