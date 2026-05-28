// rng.test.ts — Mulberry32 PRNG tests
// PRD §4 normative test vectors MUST be the first describe block.
// See RESEARCH.md Pattern 2 (lines 383–420) for implementation spec.

import { describe, it, expect } from 'vitest';
import { Rng } from './rng.js';

// PRD §4 test vectors — these must pass before any other tests are checked.
// If these fail, the Mulberry32 implementation uses the wrong variant (RESEARCH.md Pitfall 4).
describe('PRD §4 test vectors (seed 12345)', () => {
  it('first five outputs from seed 12345 match PRD §4 normative values', () => {
    const rng = new Rng(12345);
    expect(rng.nextU32()).toBe(4207900869);
    expect(rng.nextU32()).toBe(1317490944);
    expect(rng.nextU32()).toBe(2079646450);
    expect(rng.nextU32()).toBe(3513001552);
    expect(rng.nextU32()).toBe(2187978186);
  });

  it('two separate Rng instances from the same seed produce the same first value', () => {
    const rng1 = new Rng(12345);
    const rng2 = new Rng(12345);
    expect(rng1.nextU32()).toBe(rng2.nextU32());
  });
});

describe('state save/restore', () => {
  it('getState/setState round-trip reproduces the same sequence', () => {
    const rng = new Rng(99);
    // Advance N steps, snapshot state
    rng.nextU32();
    rng.nextU32();
    rng.nextU32();
    const snap = rng.getState();

    // Capture the next 5 outputs
    const original: number[] = [];
    for (let i = 0; i < 5; i++) {
      original.push(rng.nextU32());
    }

    // Restore state on a fresh Rng and re-capture
    const rng2 = new Rng(0);
    rng2.setState(snap);
    const replayed: number[] = [];
    for (let i = 0; i < 5; i++) {
      replayed.push(rng2.nextU32());
    }

    expect(replayed).toEqual(original);
  });
});

describe('nextInt', () => {
  it('returns values in [0, max) over 1000 iterations', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });
});

describe('nextRange', () => {
  it('returns values in [min, max] inclusive over 1000 iterations', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextRange(5, 15);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(15);
    }
  });
});

describe('multiple seeds diverge', () => {
  it('Rng(42) and Rng(43) produce different first outputs', () => {
    expect(new Rng(42).nextU32()).not.toBe(new Rng(43).nextU32());
  });
});

describe('uint32 state canonicality (#161)', () => {
  it('state stays within uint32 bounds after many advances (>>> 0 wrap)', () => {
    // Without `>>> 0` on state advance, state grows as a JS float after ~2^32 wraps.
    // Start near wrap-around to exercise the boundary quickly.
    const rng = new Rng(0x7fffffff);
    for (let i = 0; i < 10_000; i++) {
      rng.nextU32();
      const s = rng.getState();
      expect(s >>> 0).toBe(s); // canonical uint32: no bits lost by >>> 0
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('setState restores uint32 values > 2^31 without sign-extending', () => {
    const rng1 = new Rng(1);
    // Advance until state is in the high uint32 range.
    // Seed 1 produces state 0x6d2b79f6 after first advance = 1831565814 (< 2^31).
    // Use a direct setState with high-bit set to test >>> 0 path.
    rng1.setState(0x80000001); // would become -2147483647 with `| 0`
    expect(rng1.getState()).toBe(0x80000001);

    const rng2 = new Rng(1);
    rng2.setState(0x80000001);
    const out1 = rng1.nextU32();
    const out2 = rng2.nextU32();
    expect(out1).toBe(out2); // same state → same output
  });
});

describe('no nextFloat method', () => {
  it('nextFloat is undefined (floats are banned in src/sim/)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((new Rng(1) as any).nextFloat).toBeUndefined();
  });
});
