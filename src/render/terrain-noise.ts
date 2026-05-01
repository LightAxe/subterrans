// terrain-noise.ts — render-only deterministic noise + dithering helpers.
//
// All values derive from (tileX, tileY, salt) integer triples. No Math.random,
// no Date.now, no PRNG state — pure functions. Same inputs → same outputs
// across every call, run, browser, and platform.
//
// The render layer is downstream of the sim and never feeds back into it, so
// these helpers don't need to touch simVersion. They just need to be
// reproducible across reloads of the same seed.

import { TILE_SIZE_PX } from './sprites.js';

/**
 * Deterministic spatial hash. Same `(tileX, tileY, salt)` always returns the
 * same uint32. The constants are MurmurHash3-style mixers — large odd primes
 * with one fmix multiplier and bit-shift xors. Cheap and well-distributed.
 */
export function spatialHash(tileX: number, tileY: number, salt: number): number {
  let h = (tileX * 374761393 + tileY * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Per-pixel deterministic value-noise sample in [0, 255]. Each pixel inside a
 * tile gets a stable noise byte derived from its (pixelX, pixelY, salt). Two
 * neighboring pixels' noise values are uncorrelated — this is white noise,
 * which is the right primitive for granular dirt/sand textures (vs. coherent
 * noise which produces blobs).
 */
export function pixelNoise(pixelX: number, pixelY: number, salt: number): number {
  return spatialHash(pixelX, pixelY, salt) & 0xff;
}

/**
 * 4×4 Bayer ordered dither matrix, threshold values 0..15. The classic
 * pattern; used by SNES-era hardware to fake gradients with two colors.
 *
 * Usage: at pixel (x, y), compare noise(x, y) to bayer4(x, y) * 16. If
 * noise >= threshold, use the lighter color; else darker. The result is a
 * stable cross-hatched dither that reads as a textured material rather than
 * either flat color or random noise.
 */
const BAYER_4: ReadonlyArray<number> = [
  0,  8,  2, 10,
  12, 4, 14,  6,
  3, 11,  1,  9,
  15, 7, 13,  5,
];

export function bayer4(pixelX: number, pixelY: number): number {
  return BAYER_4[((pixelY & 3) << 2) | (pixelX & 3)]!;
}

/**
 * Bayer threshold scaled to [0, 255]. Convenience for comparing against
 * `pixelNoise` directly.
 */
export function bayer4Threshold(pixelX: number, pixelY: number): number {
  // 4x4 matrix has 16 cells with values 0..15. Scale to 0..240 (each step is
  // 16) so a noise byte (0..255) splits roughly evenly across the matrix.
  return bayer4(pixelX, pixelY) * 16;
}

/**
 * Pick a motif placement offset inside a tile, given a hash. Returns
 * `(offsetX, offsetY)` such that a `width × height` motif rendered at that
 * offset stays within the [0, TILE_SIZE_PX) bounds.
 *
 * Falls back to (0, 0) when the motif equals the tile size — rare but
 * defensive against zero-range modulos.
 */
export function motifOffset(
  hash: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const xRange = TILE_SIZE_PX - width + 1;
  const yRange = TILE_SIZE_PX - height + 1;
  if (xRange <= 1 && yRange <= 1) return { x: 0, y: 0 };
  const x = xRange > 1 ? (hash & 0xffff) % xRange : 0;
  const y = yRange > 1 ? ((hash >>> 16) & 0xffff) % yRange : 0;
  return { x, y };
}
