// pheromone-store.test.ts — unit tests for PRD §5a pheromone grid helpers
//
// Coverage:
//   1.  Grid allocation shape and zero-init
//   2.  phGet/phSet round-trip
//   3.  Row-major layout sanity
//   4.  phGet out-of-bounds (negative x, y)
//   5.  phGet out-of-bounds (>= width/height)
//   6.  phSet out-of-bounds silent no-op
//   7.  pheromoneGridKey — FoodTrail on surface
//   8.  pheromoneGridKey — DangerTrail on underground
//   9.  Distinct grids — PHER-02 proof
//   10. Independence across separate createPheromoneGrid() allocations

import { describe, it, expect } from 'vitest';
import {
  createPheromoneGrid,
  phGet,
  phSet,
  pheromoneGridKey,
  pheromoneKeySuffix,
  pheromoneKeyIsSurface,
  decodePheromoneKeyType,
} from './pheromone-store.js';
import { PheromoneType } from '../enums.js';

describe('pheromone-store', () => {
  // -------------------------------------------------------------------------
  // Test 1 — Grid allocation: correct shape and zero-initialisation
  // -------------------------------------------------------------------------

  it('createPheromoneGrid(16, 8) has correct shape and is zero-initialised', () => {
    const g = createPheromoneGrid(16, 8);
    expect(g.data.length).toBe(128);
    expect(g.width).toBe(16);
    expect(g.height).toBe(8);
    // Every cell must start at 0
    for (let i = 0; i < g.data.length; i++) {
      expect(g.data[i]).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2 — phGet/phSet round-trip
  // -------------------------------------------------------------------------

  it('phSet then phGet round-trips the stored value', () => {
    const g = createPheromoneGrid(16, 8);
    phSet(g, 3, 5, 42);
    expect(phGet(g, 3, 5)).toBe(42);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Row-major layout sanity
  // -------------------------------------------------------------------------

  it('row-major layout: phSet(g, 0, 1, 99) on a 4×3 grid writes data[4]', () => {
    // stride = width = 4, row 1, col 0 → index = (1 * 4 + 0) = 4
    const g = createPheromoneGrid(4, 3);
    phSet(g, 0, 1, 99);
    expect(g.data[4]).toBe(99);
    // Confirm no other cells were touched
    expect(g.data[0]).toBe(0);
    expect(g.data[1]).toBe(0);
    expect(g.data[3]).toBe(0);
    expect(g.data[5]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 4 — phGet out-of-bounds (negative x, y) returns 0, no throw
  // -------------------------------------------------------------------------

  it('phGet returns 0 for negative x and y coordinates', () => {
    const g = createPheromoneGrid(10, 10);
    phSet(g, 0, 0, 7);
    expect(phGet(g, -1, 0)).toBe(0);
    expect(phGet(g, 0, -1)).toBe(0);
    expect(phGet(g, -5, -5)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 5 — phGet out-of-bounds (>= width/height) returns 0, no throw
  // -------------------------------------------------------------------------

  it('phGet returns 0 for x >= width or y >= height', () => {
    const g = createPheromoneGrid(10, 10);
    phSet(g, 9, 9, 7);
    expect(phGet(g, 10, 0)).toBe(0);
    expect(phGet(g, 0, 10)).toBe(0);
    expect(phGet(g, 10, 10)).toBe(0);
    expect(phGet(g, 99, 99)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 6 — phSet out-of-bounds: silent no-op, no adjacent cell corruption
  // -------------------------------------------------------------------------

  it('phSet out-of-bounds is a silent no-op — grid data unchanged', () => {
    const g = createPheromoneGrid(4, 4);
    // Fill with a known sentinel so we can detect any corruption
    for (let i = 0; i < g.data.length; i++) {
      g.data[i] = 1;
    }
    const snapshot = Int32Array.from(g.data);

    phSet(g, -1, 0, 999); // negative x
    phSet(g, 0, -1, 999); // negative y
    phSet(g, 4, 0, 999); // x >= width
    phSet(g, 0, 4, 999); // y >= height
    phSet(g, 10, 10, 999); // both out

    // data must be bit-for-bit identical to the snapshot
    expect(g.data).toEqual(snapshot);
  });

  // -------------------------------------------------------------------------
  // Test 7 — pheromoneGridKey: FoodTrail on surface
  // -------------------------------------------------------------------------

  it('pheromoneGridKey(1, FoodTrail, "surface") returns "1:0:surface"', () => {
    expect(pheromoneGridKey(1, PheromoneType.FoodTrail, 'surface')).toBe('1:0:surface');
  });

  // -------------------------------------------------------------------------
  // Test 8 — pheromoneGridKey: DangerTrail on underground
  // -------------------------------------------------------------------------

  it('pheromoneGridKey(2, DangerTrail, "underground") returns "2:1:underground"', () => {
    expect(pheromoneGridKey(2, PheromoneType.DangerTrail, 'underground')).toBe('2:1:underground');
  });

  // -------------------------------------------------------------------------
  // Test 9 — Distinct grids proof (PHER-02)
  // -------------------------------------------------------------------------

  it('PHER-02: FoodTrail and DangerTrail grids are independent per colony', () => {
    const foodGrid = createPheromoneGrid(16, 16);
    const dangerGrid = createPheromoneGrid(16, 16);

    const foodKey = pheromoneGridKey(1, PheromoneType.FoodTrail, 'surface');
    const dangerKey = pheromoneGridKey(1, PheromoneType.DangerTrail, 'surface');

    // Keys must be distinct
    expect(foodKey).toBe('1:0:surface');
    expect(dangerKey).toBe('1:1:surface');
    expect(foodKey).not.toBe(dangerKey);

    // Store in a plain map (simulating WorldState.pheromoneGrids)
    const grids: Record<string, ReturnType<typeof createPheromoneGrid>> = {
      [foodKey]: foodGrid,
      [dangerKey]: dangerGrid,
    };

    // Write to food grid at (5, 5)
    phSet(grids[foodKey]!, 5, 5, 100);

    // DangerTrail grid must remain untouched at same coordinates
    expect(phGet(grids[dangerKey]!, 5, 5)).toBe(0);

    // FoodTrail grid must have the written value
    expect(phGet(grids[foodKey]!, 5, 5)).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Test 10 — Independence across allocations
  // -------------------------------------------------------------------------

  it('two separate createPheromoneGrid() calls produce independent Int32Arrays', () => {
    const a = createPheromoneGrid(4, 4);
    const b = createPheromoneGrid(4, 4);

    // Underlying buffers must be distinct objects
    expect(a.data.buffer).not.toBe(b.data.buffer);

    // Mutation on one must not affect the other
    phSet(a, 2, 2, 55);
    expect(phGet(b, 2, 2)).toBe(0);
  });
});

describe('pheromone key-contract helpers (#242)', () => {
  it('decodePheromoneKeyType extracts the middle type token (incl. multi-digit)', () => {
    expect(decodePheromoneKeyType('1:0:surface')).toBe(0);
    expect(decodePheromoneKeyType('2:1:underground')).toBe(1);
    expect(decodePheromoneKeyType('3:12:surface')).toBe(12);
  });

  it('pheromoneKeyIsSurface distinguishes zones', () => {
    expect(pheromoneKeyIsSurface('1:0:surface')).toBe(true);
    expect(pheromoneKeyIsSurface('2:1:underground')).toBe(false);
  });

  it('pheromoneKeySuffix builds the :type:zone suffix', () => {
    expect(pheromoneKeySuffix(PheromoneType.DangerTrail, 'surface')).toBe(':1:surface');
    expect(pheromoneKeySuffix(PheromoneType.FoodTrail, 'underground')).toBe(':0:underground');
  });

  it('suffix / decode / isSurface stay in lockstep with pheromoneGridKey (contract)', () => {
    const key = pheromoneGridKey(2, PheromoneType.DangerTrail, 'underground');
    expect(key.endsWith(pheromoneKeySuffix(PheromoneType.DangerTrail, 'underground'))).toBe(true);
    expect(decodePheromoneKeyType(key)).toBe(PheromoneType.DangerTrail);
    expect(pheromoneKeyIsSurface(key)).toBe(false);
  });
});
