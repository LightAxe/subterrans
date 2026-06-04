// terrain.test.ts — PRD §1 terrain grid unit tests
//
// Run: npx vitest run src/sim/terrain.test.ts

import { describe, expect, it } from 'vitest';
import {
  Zone,
  SurfaceTileState,
  UndergroundTileState,
  createSurfaceGrid,
  createUndergroundGrid,
  sgGet,
  sgSet,
  ugGet,
  ugSet,
} from './terrain.js';

// ---------------------------------------------------------------------------
// Discriminant value tests
// ---------------------------------------------------------------------------

describe('Zone discriminant values', () => {
  it('Zone.Surface === 0', () => {
    expect(Zone.Surface).toBe(0);
  });

  it('Zone.Underground === 1', () => {
    expect(Zone.Underground).toBe(1);
  });
});

describe('SurfaceTileState discriminant values', () => {
  it('SurfaceTileState.Grass === 0', () => {
    expect(SurfaceTileState.Grass).toBe(0);
  });

  it('SurfaceTileState.Dirt === 1', () => {
    expect(SurfaceTileState.Dirt).toBe(1);
  });
});

describe('UndergroundTileState discriminant values', () => {
  it('UndergroundTileState.Solid === 0', () => {
    expect(UndergroundTileState.Solid).toBe(0);
  });

  it('UndergroundTileState.Marked === 1', () => {
    expect(UndergroundTileState.Marked).toBe(1);
  });

  it('UndergroundTileState.BeingDug === 2', () => {
    expect(UndergroundTileState.BeingDug).toBe(2);
  });

  it('UndergroundTileState.Open === 3', () => {
    expect(UndergroundTileState.Open).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createSurfaceGrid factory tests
// ---------------------------------------------------------------------------

describe('createSurfaceGrid', () => {
  it('creates a 128×128 grid with data.length === 16384', () => {
    const g = createSurfaceGrid(128, 128);
    expect(g.data.length).toBe(16384);
  });

  it('128×128 grid is zero-initialized (all Grass)', () => {
    const g = createSurfaceGrid(128, 128);
    let allZero = true;
    for (let i = 0; i < g.data.length; i++) {
      if (g.data[i] !== 0) {
        allZero = false;
        break;
      }
    }
    expect(allZero).toBe(true);
  });

  it('stores the correct width and height', () => {
    const g = createSurfaceGrid(128, 128);
    expect(g.width).toBe(128);
    expect(g.height).toBe(128);
  });
});

// ---------------------------------------------------------------------------
// createUndergroundGrid factory tests
// ---------------------------------------------------------------------------

describe('createUndergroundGrid', () => {
  it('creates a 128×64 grid with data.length === 8192', () => {
    const g = createUndergroundGrid(128, 64);
    expect(g.data.length).toBe(8192);
  });

  it('128×64 grid is zero-initialized (all Solid)', () => {
    const g = createUndergroundGrid(128, 64);
    let allZero = true;
    for (let i = 0; i < g.data.length; i++) {
      if (g.data[i] !== 0) {
        allZero = false;
        break;
      }
    }
    expect(allZero).toBe(true);
  });

  it('stores the correct width and height', () => {
    const g = createUndergroundGrid(128, 64);
    expect(g.width).toBe(128);
    expect(g.height).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// sgGet / sgSet round-trip tests
// ---------------------------------------------------------------------------

describe('sgGet / sgSet round-trip', () => {
  it('round-trips at corner (0, 0)', () => {
    const g = createSurfaceGrid(128, 128);
    sgSet(g, 0, 0, SurfaceTileState.Dirt);
    expect(sgGet(g, 0, 0)).toBe(SurfaceTileState.Dirt);
  });

  it('round-trips at corner (127, 127)', () => {
    const g = createSurfaceGrid(128, 128);
    sgSet(g, 127, 127, SurfaceTileState.Dirt);
    expect(sgGet(g, 127, 127)).toBe(SurfaceTileState.Dirt);
  });

  it('setting one tile does not affect adjacent tile', () => {
    const g = createSurfaceGrid(128, 128);
    sgSet(g, 5, 5, SurfaceTileState.Dirt);
    expect(sgGet(g, 6, 5)).toBe(SurfaceTileState.Grass);
    expect(sgGet(g, 5, 6)).toBe(SurfaceTileState.Grass);
  });

  it('can reset a tile back to Grass', () => {
    const g = createSurfaceGrid(128, 128);
    sgSet(g, 10, 10, SurfaceTileState.Dirt);
    sgSet(g, 10, 10, SurfaceTileState.Grass);
    expect(sgGet(g, 10, 10)).toBe(SurfaceTileState.Grass);
  });
});

// ---------------------------------------------------------------------------
// ugGet / ugSet round-trip tests
// ---------------------------------------------------------------------------

describe('ugGet / ugSet round-trip', () => {
  it('round-trips Solid at corner (0, 0)', () => {
    const g = createUndergroundGrid(128, 64);
    ugSet(g, 0, 0, UndergroundTileState.Solid);
    expect(ugGet(g, 0, 0)).toBe(UndergroundTileState.Solid);
  });

  it('round-trips Marked at corner (0, 0)', () => {
    const g = createUndergroundGrid(128, 64);
    ugSet(g, 0, 0, UndergroundTileState.Marked);
    expect(ugGet(g, 0, 0)).toBe(UndergroundTileState.Marked);
  });

  it('round-trips BeingDug at corner (127, 63)', () => {
    const g = createUndergroundGrid(128, 64);
    ugSet(g, 127, 63, UndergroundTileState.BeingDug);
    expect(ugGet(g, 127, 63)).toBe(UndergroundTileState.BeingDug);
  });

  it('round-trips Open at corner (127, 63)', () => {
    const g = createUndergroundGrid(128, 64);
    ugSet(g, 127, 63, UndergroundTileState.Open);
    expect(ugGet(g, 127, 63)).toBe(UndergroundTileState.Open);
  });

  it('all 4 tile states round-trip correctly at (64, 32)', () => {
    const g = createUndergroundGrid(128, 64);
    const states = [
      UndergroundTileState.Solid,
      UndergroundTileState.Marked,
      UndergroundTileState.BeingDug,
      UndergroundTileState.Open,
    ] as const;
    for (const state of states) {
      ugSet(g, 64, 32, state);
      expect(ugGet(g, 64, 32)).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// UNDR-08: Two instances must not share data buffers
// ---------------------------------------------------------------------------

describe('UndergroundGrid instance independence (UNDR-08)', () => {
  it('two grids do not share data buffers', () => {
    const g1 = createUndergroundGrid(128, 64);
    const g2 = createUndergroundGrid(128, 64);
    // Mutate g1, verify g2 is unaffected
    ugSet(g1, 10, 10, UndergroundTileState.Open);
    expect(ugGet(g2, 10, 10)).toBe(UndergroundTileState.Solid);
  });

  it('two surface grids do not share data buffers', () => {
    const g1 = createSurfaceGrid(128, 128);
    const g2 = createSurfaceGrid(128, 128);
    sgSet(g1, 20, 20, SurfaceTileState.Dirt);
    expect(sgGet(g2, 20, 20)).toBe(SurfaceTileState.Grass);
  });
});
