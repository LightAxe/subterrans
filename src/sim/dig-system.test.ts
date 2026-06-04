// dig-system.test.ts — Phase 7 PRD §4a BFS flow-field tests
//
// All tests use createUndergroundGrid + ugSet from terrain.ts.
// Pre-allocate out and queue as new Int32Array(width * height).

import { describe, it, expect } from 'vitest';
import { createDigFlowFields, ensureDigFlowField, computeDigFlowField } from './dig-system.js';
import { createUndergroundGrid, ugSet, UndergroundTileState } from './terrain.js';

// ---------------------------------------------------------------------------
// Direction constants (match dig-system.ts internal encoding)
// 0=North, 1=East, 2=South, 3=West, -1=source, -2=unreachable
// ---------------------------------------------------------------------------
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;
const WEST = 3;
const SOURCE = -1;
const UNREACHABLE = -2;

// ---------------------------------------------------------------------------
// Helper to allocate buffers for a grid
// ---------------------------------------------------------------------------
function makeBuffers(width: number, height: number) {
  const size = width * height;
  return {
    out: new Int32Array(size),
    queue: new Int32Array(size),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Empty grid (all Solid) — no Marked tiles → all unreachable
// ---------------------------------------------------------------------------
describe('computeDigFlowField', () => {
  it('empty grid (all Solid) produces all -2 (unreachable)', () => {
    const width = 4,
      height = 4;
    const grid = createUndergroundGrid(width, height);
    const { out, queue } = makeBuffers(width, height);

    computeDigFlowField(grid, out, queue);

    for (let i = 0; i < width * height; i++) {
      expect(out[i]).toBe(UNREACHABLE);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: Single Marked tile with adjacent Open tiles — directions point toward source
  // ---------------------------------------------------------------------------
  it('single Marked tile with adjacent Open tiles — neighbors point toward source', () => {
    // 8×4 grid; Marked at (3,2); Open neighbors at (2,2),(4,2),(3,1),(3,3)
    const width = 8,
      height = 4;
    const grid = createUndergroundGrid(width, height);

    ugSet(grid, 3, 2, UndergroundTileState.Marked);
    ugSet(grid, 2, 2, UndergroundTileState.Open);
    ugSet(grid, 4, 2, UndergroundTileState.Open);
    ugSet(grid, 3, 1, UndergroundTileState.Open);
    ugSet(grid, 3, 3, UndergroundTileState.Open);

    const { out, queue } = makeBuffers(width, height);
    computeDigFlowField(grid, out, queue);

    // The source tile itself
    expect(out[2 * width + 3]).toBe(SOURCE); // (3,2)

    // West of source → East points back to (3,2)
    expect(out[2 * width + 2]).toBe(EAST); // (2,2): go East to reach (3,2)

    // East of source → West points back to (3,2)
    expect(out[2 * width + 4]).toBe(WEST); // (4,2): go West to reach (3,2)

    // North of source (row 1) → South points back to (3,2)
    expect(out[1 * width + 3]).toBe(SOUTH); // (3,1): go South to reach (3,2)

    // South of source (row 3) → North points back to (3,2)
    expect(out[3 * width + 3]).toBe(NORTH); // (3,3): go North to reach (3,2)

    // All Solid tiles (rest of the grid) remain -2
    const markedIdx = 2 * width + 3;
    const openIdxs = [2 * width + 2, 2 * width + 4, 1 * width + 3, 3 * width + 3];
    for (let i = 0; i < width * height; i++) {
      if (i !== markedIdx && !openIdxs.includes(i)) {
        expect(out[i]).toBe(UNREACHABLE);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: Multi-source BFS — nearest Marked tile wins at midpoint
  // ---------------------------------------------------------------------------
  it('multi-source BFS — midpoint tile points to nearer source', () => {
    // 10×1 grid (single row): Marked at (0,0) and (9,0), Open at (1,0)–(8,0)
    // Tiles 1–4 should point West (toward col 0); tiles 5–8 should point East (toward col 9).
    // Tile 4 and 5 are equidistant — BFS is deterministic so the tiebreak goes to whichever
    // was enqueued first (source at col 0 is seeded first in the linear scan).
    const width = 10,
      height = 1;
    const grid = createUndergroundGrid(width, height);

    ugSet(grid, 0, 0, UndergroundTileState.Marked);
    ugSet(grid, 9, 0, UndergroundTileState.Marked);
    for (let x = 1; x <= 8; x++) {
      ugSet(grid, x, 0, UndergroundTileState.Open);
    }

    const { out, queue } = makeBuffers(width, height);
    computeDigFlowField(grid, out, queue);

    expect(out[0]).toBe(SOURCE); // (0,0) Marked
    expect(out[9]).toBe(SOURCE); // (9,0) Marked

    // Tiles near left source should point West (toward col 0)
    // The BFS from source 0 expands East first; source 9 expands West.
    // Cells reached first by source 0: col 1, 2, 3, 4 (distance 1,2,3,4)
    // Cells reached first by source 9: col 8, 7, 6, 5 (distance 1,2,3,4)
    // At col 4 and col 5: equidistant — source 0 seeds first (leftmost source),
    //   so col 4 (dist 4) from source 0 is expanded before source 9 can reach it.
    //   col 5 is equidistant from both; source 9 (rightmost) is also in queue.
    //   The exact winner depends on BFS order — just verify the tiles are reachable.

    // Tiles 1-4 point West (WEST=3) — closer to left source
    for (let x = 1; x <= 4; x++) {
      expect(out[x]).toBe(WEST);
    }

    // Tiles 5-8 point East (EAST=1) — closer to right source
    for (let x = 5; x <= 8; x++) {
      expect(out[x]).toBe(EAST);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Solid tiles block BFS — far side of wall is unreachable
  // ---------------------------------------------------------------------------
  it('Solid wall blocks BFS — tiles on far side are unreachable', () => {
    // 6×1 grid: Marked at (0,0), Open at (1,0),(2,0), Solid at (3,0), Open at (4,0),(5,0)
    // Tiles (4,0) and (5,0) should be unreachable (-2) because (3,0) is Solid.
    const width = 6,
      height = 1;
    const grid = createUndergroundGrid(width, height);

    ugSet(grid, 0, 0, UndergroundTileState.Marked);
    ugSet(grid, 1, 0, UndergroundTileState.Open);
    ugSet(grid, 2, 0, UndergroundTileState.Open);
    // (3,0) remains Solid (default)
    ugSet(grid, 4, 0, UndergroundTileState.Open);
    ugSet(grid, 5, 0, UndergroundTileState.Open);

    const { out, queue } = makeBuffers(width, height);
    computeDigFlowField(grid, out, queue);

    expect(out[0]).toBe(SOURCE); // (0,0) Marked
    expect(out[1]).toBe(WEST); // (1,0) points West toward (0,0)
    expect(out[2]).toBe(WEST); // (2,0) points West
    expect(out[3]).toBe(UNREACHABLE); // (3,0) Solid — unreachable
    expect(out[4]).toBe(UNREACHABLE); // (4,0) cut off by wall
    expect(out[5]).toBe(UNREACHABLE); // (5,0) cut off by wall
  });

  // ---------------------------------------------------------------------------
  // Test 5: BeingDug tiles are passable
  // ---------------------------------------------------------------------------
  it('BeingDug tiles are passable — flow-field routes through them', () => {
    // 3×1 grid: Marked at (0,0), BeingDug at (1,0), Open at (2,0)
    // (2,0) should get a direction toward (0,0) via (1,0).
    const width = 3,
      height = 1;
    const grid = createUndergroundGrid(width, height);

    ugSet(grid, 0, 0, UndergroundTileState.Marked);
    ugSet(grid, 1, 0, UndergroundTileState.BeingDug);
    ugSet(grid, 2, 0, UndergroundTileState.Open);

    const { out, queue } = makeBuffers(width, height);
    computeDigFlowField(grid, out, queue);

    expect(out[0]).toBe(SOURCE); // (0,0) Marked
    expect(out[1]).toBe(WEST); // (1,0) BeingDug: points West toward (0,0)
    expect(out[2]).toBe(WEST); // (2,0) Open: points West through BeingDug
  });

  // ---------------------------------------------------------------------------
  // Test 6: Pre-allocated queue reuse — second call on same buffers works correctly
  // ---------------------------------------------------------------------------
  it('second call with same buffers produces correct results (queue reuse)', () => {
    const width = 4,
      height = 1;
    const grid1 = createUndergroundGrid(width, height);
    const grid2 = createUndergroundGrid(width, height);

    ugSet(grid1, 0, 0, UndergroundTileState.Marked);
    ugSet(grid1, 1, 0, UndergroundTileState.Open);
    ugSet(grid1, 2, 0, UndergroundTileState.Open);
    ugSet(grid1, 3, 0, UndergroundTileState.Open);

    ugSet(grid2, 3, 0, UndergroundTileState.Marked);
    ugSet(grid2, 0, 0, UndergroundTileState.Open);
    ugSet(grid2, 1, 0, UndergroundTileState.Open);
    ugSet(grid2, 2, 0, UndergroundTileState.Open);

    const { out, queue } = makeBuffers(width, height);

    // First call
    computeDigFlowField(grid1, out, queue);
    expect(out[0]).toBe(SOURCE);
    expect(out[1]).toBe(WEST);
    expect(out[2]).toBe(WEST);
    expect(out[3]).toBe(WEST);

    // Second call — different grid (source on right), same buffers
    computeDigFlowField(grid2, out, queue);
    expect(out[3]).toBe(SOURCE);
    expect(out[2]).toBe(EAST);
    expect(out[1]).toBe(EAST);
    expect(out[0]).toBe(EAST);
  });
});

// ---------------------------------------------------------------------------
// Test 7: createDigFlowFields — returns empty cache
// ---------------------------------------------------------------------------
describe('createDigFlowFields', () => {
  it('returns an empty fields and queues cache', () => {
    const cache = createDigFlowFields();
    expect(cache.fields).toEqual({});
    expect(cache.queues).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Test 8: ensureDigFlowField — lazy allocation and identity on second call
// ---------------------------------------------------------------------------
describe('ensureDigFlowField', () => {
  it('allocates fields and queues for colonyId on first call', () => {
    const cache = createDigFlowFields();
    const gridSize = 128 * 64; // 8192

    const field = ensureDigFlowField(cache, 1, gridSize);

    expect(field).toBeInstanceOf(Int32Array);
    expect(field.length).toBe(gridSize);
    expect(cache.fields[1]).toBe(field);
    expect(cache.queues[1]).toBeInstanceOf(Int32Array);
    expect(cache.queues[1]!.length).toBe(gridSize);
  });

  it('returns same buffer on second call (no reallocation)', () => {
    const cache = createDigFlowFields();
    const gridSize = 8192;

    const field1 = ensureDigFlowField(cache, 1, gridSize);
    const field2 = ensureDigFlowField(cache, 1, gridSize);

    expect(field1).toBe(field2); // exact same reference
  });

  it('allocates independent buffers for different colonies', () => {
    const cache = createDigFlowFields();
    const gridSize = 8192;

    const field1 = ensureDigFlowField(cache, 1, gridSize);
    const field2 = ensureDigFlowField(cache, 2, gridSize);

    expect(field1).not.toBe(field2);
    expect(cache.fields[1]).toBe(field1);
    expect(cache.fields[2]).toBe(field2);
  });
});
