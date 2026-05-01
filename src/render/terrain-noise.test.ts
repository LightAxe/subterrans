// terrain-noise.test.ts — determinism + distribution sanity for the noise
// helpers used by terrain-atlas.
//
// These functions are pure but their distribution properties feed the visual
// readability of every tile, so a regression in either is worth catching.

import { describe, expect, it } from 'vitest';
import {
  spatialHash,
  pixelNoise,
  bayer4,
  bayer4Threshold,
  motifOffset,
} from './terrain-noise.js';
import { TILE_SIZE_PX } from './sprites.js';

describe('spatialHash', () => {
  it('returns the same value for the same (x, y, salt) triple', () => {
    expect(spatialHash(5, 7, 11)).toBe(spatialHash(5, 7, 11));
    expect(spatialHash(0, 0, 0)).toBe(spatialHash(0, 0, 0));
    expect(spatialHash(-3, 100, 42)).toBe(spatialHash(-3, 100, 42));
  });

  it('returns different values when any coordinate changes', () => {
    const h = spatialHash(5, 7, 11);
    expect(spatialHash(6, 7, 11)).not.toBe(h);
    expect(spatialHash(5, 8, 11)).not.toBe(h);
    expect(spatialHash(5, 7, 12)).not.toBe(h);
  });

  it('distributes well across 256-buckets for a 64×64 sweep', () => {
    // Simple bucket-uniformity check: count how many tiles land in each
    // low-byte bucket. With 4096 samples across 256 buckets, a roughly
    // uniform hash gives ~16 per bucket. Allow a 4× variation either way.
    const buckets = new Array(256).fill(0);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        buckets[spatialHash(x, y, 1) & 0xff]!++;
      }
    }
    let zeroBuckets = 0;
    let overflow = 0;
    for (const count of buckets) {
      if (count === 0) zeroBuckets++;
      if (count > 80) overflow++;
    }
    // No bucket should be empty (severe collision) or overflowing (poor mix).
    expect(zeroBuckets).toBe(0);
    expect(overflow).toBe(0);
  });
});

describe('pixelNoise', () => {
  it('returns a byte in [0, 255]', () => {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const n = pixelNoise(x, y, 7);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(255);
      }
    }
  });

  it('is deterministic per (x, y, salt)', () => {
    expect(pixelNoise(10, 20, 30)).toBe(pixelNoise(10, 20, 30));
  });
});

describe('bayer4 + bayer4Threshold', () => {
  it('returns a value in [0, 15] from the 4×4 matrix', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const v = bayer4(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(15);
        seen.add(v);
      }
    }
    // The classic 4×4 Bayer matrix uses each integer 0..15 exactly once.
    expect(seen.size).toBe(16);
  });

  it('tiles the 4×4 pattern across larger regions', () => {
    // bayer4 should be periodic with period 4 in both axes — that's the whole
    // point of an "ordered" dither matrix.
    expect(bayer4(0, 0)).toBe(bayer4(4, 0));
    expect(bayer4(0, 0)).toBe(bayer4(0, 4));
    expect(bayer4(0, 0)).toBe(bayer4(8, 8));
  });

  it('threshold scales bayer4 to [0, 240] in steps of 16', () => {
    expect(bayer4Threshold(0, 0)).toBe(0);
    // The cell with value 15 (bottom-left corner of the 4×4 matrix) → 240.
    expect(bayer4Threshold(0, 3)).toBe(240);
  });
});

describe('motifOffset', () => {
  it('keeps motifs inside the tile for representative hash + size combos', () => {
    // Cover the corner cases (1-px, full-tile, off-by-one near edge) plus a
    // sparse hash sweep. Exhaustive sweep is overkill — motifOffset is a
    // pure modulo, so a handful of well-chosen hashes is enough.
    const sampleHashes = [0, 1, 0xff, 0x10000, 0xdeadbeef >>> 0, 0xffffffff];
    const sampleSizes = [1, 2, 4, 8, TILE_SIZE_PX - 1, TILE_SIZE_PX];
    for (const h of sampleHashes) {
      for (const w of sampleSizes) {
        for (const hh of sampleSizes) {
          const off = motifOffset(h, w, hh);
          expect(off.x + w).toBeLessThanOrEqual(TILE_SIZE_PX);
          expect(off.y + hh).toBeLessThanOrEqual(TILE_SIZE_PX);
          expect(off.x).toBeGreaterThanOrEqual(0);
          expect(off.y).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('returns (0, 0) when the motif fills the entire tile', () => {
    expect(motifOffset(0xdeadbeef, TILE_SIZE_PX, TILE_SIZE_PX)).toEqual({ x: 0, y: 0 });
  });
});
