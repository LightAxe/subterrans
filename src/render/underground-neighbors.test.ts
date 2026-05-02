// underground-neighbors.test.ts — Phase A coverage for the autotile classifier.
//
// The classifier is a pure function over (UndergroundGrid, tx, ty,
// entranceXSet). The tests fix all four explicitly so a regression in the
// classification rules surfaces here rather than as a render-output diff.

import { describe, expect, it } from 'vitest';
import {
  classifyUndergroundTile,
  gatherUnderground3x3Neighbors,
} from './underground-neighbors.js';
import {
  createUndergroundGrid,
  ugSet,
  UndergroundTileState,
} from '../sim/terrain.js';

const NO_ENTRANCES: ReadonlySet<number> = new Set();

describe('classifyUndergroundTile', () => {
  it('classifies Solid as wall', () => {
    const grid = createUndergroundGrid(4, 4);
    // grids initialize to Solid, no need to set anything.
    expect(classifyUndergroundTile(grid, 1, 1, NO_ENTRANCES)).toBe('wall');
  });

  it('classifies Open / Marked / BeingDug as open', () => {
    const grid = createUndergroundGrid(4, 4);
    ugSet(grid, 0, 1, UndergroundTileState.Open);
    ugSet(grid, 1, 1, UndergroundTileState.Marked);
    ugSet(grid, 2, 1, UndergroundTileState.BeingDug);
    expect(classifyUndergroundTile(grid, 0, 1, NO_ENTRANCES)).toBe('open');
    expect(classifyUndergroundTile(grid, 1, 1, NO_ENTRANCES)).toBe('open');
    expect(classifyUndergroundTile(grid, 2, 1, NO_ENTRANCES)).toBe('open');
  });

  it('classifies all out-of-bounds positions as wall', () => {
    const grid = createUndergroundGrid(4, 4);
    expect(classifyUndergroundTile(grid, -1, 0, NO_ENTRANCES)).toBe('wall');
    expect(classifyUndergroundTile(grid,  0, -1, NO_ENTRANCES)).toBe('wall');
    expect(classifyUndergroundTile(grid,  4, 0, NO_ENTRANCES)).toBe('wall');
    expect(classifyUndergroundTile(grid,  0, 4, NO_ENTRANCES)).toBe('wall');
    // Way out — same answer.
    expect(classifyUndergroundTile(grid, -100, -100, NO_ENTRANCES)).toBe('wall');
  });

  it('classifies ceiling row (ty=0) as wall except at entrance columns', () => {
    const grid = createUndergroundGrid(8, 4);
    const entrances = new Set([3]);
    // Even if the ceiling tile happens to be Open in the underlying grid,
    // the ceiling-rule fires first — non-entrance ceiling reads as wall.
    ugSet(grid, 0, 0, UndergroundTileState.Open);
    expect(classifyUndergroundTile(grid, 0, 0, entrances)).toBe('wall');
    expect(classifyUndergroundTile(grid, 3, 0, entrances)).toBe('open'); // entrance gap
    expect(classifyUndergroundTile(grid, 7, 0, entrances)).toBe('wall');
  });

  it('does not apply the ceiling rule below ty=0', () => {
    const grid = createUndergroundGrid(4, 4);
    ugSet(grid, 1, 1, UndergroundTileState.Open);
    // ty=1 reads the underlying state regardless of entrance set.
    const entrances = new Set([1]);
    expect(classifyUndergroundTile(grid, 1, 1, entrances)).toBe('open');
    expect(classifyUndergroundTile(grid, 1, 1, NO_ENTRANCES)).toBe('open');
  });
});

describe('gatherUnderground3x3Neighbors', () => {
  it('returns the classifications for all 9 surrounding cells', () => {
    // Build a grid with a known cross pattern around (1,1):
    //   wall  open  wall
    //   open  open  open
    //   wall  open  wall
    const grid = createUndergroundGrid(3, 3);
    ugSet(grid, 1, 0, UndergroundTileState.Open);
    ugSet(grid, 0, 1, UndergroundTileState.Open);
    ugSet(grid, 1, 1, UndergroundTileState.Open);
    ugSet(grid, 2, 1, UndergroundTileState.Open);
    ugSet(grid, 1, 2, UndergroundTileState.Open);

    // ty=0 entries in the gathered struct are forced 'wall' by the ceiling
    // rule unless the entrance set says otherwise — verify both branches.
    const noEntrance = gatherUnderground3x3Neighbors(grid, 1, 1, NO_ENTRANCES);
    expect(noEntrance).toEqual({
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'open', c: 'open', e:  'open',
      sw: 'wall', s: 'open', se: 'wall',
    });

    const withEntrance = gatherUnderground3x3Neighbors(grid, 1, 1, new Set([1]));
    // Entrance at column 1 carves an 'open' gap in the n cell.
    expect(withEntrance.n).toBe('open');
    // Adjacent ceiling cells (col 0, col 2) remain 'wall' since they aren't
    // entrance columns.
    expect(withEntrance.nw).toBe('wall');
    expect(withEntrance.ne).toBe('wall');
  });

  it('treats grid edges as wall — corner tile at (0,0) sees 5 walls', () => {
    const grid = createUndergroundGrid(3, 3);
    ugSet(grid, 0, 0, UndergroundTileState.Open);
    ugSet(grid, 1, 0, UndergroundTileState.Open);
    ugSet(grid, 0, 1, UndergroundTileState.Open);
    ugSet(grid, 1, 1, UndergroundTileState.Open);

    // Tile at (0, 0). The center happens to be Open, but the ceiling rule
    // still classifies (0, 0) as wall (no entrances). N, NE, NW, W, SW are
    // out-of-bounds or ceiling, so they're all wall.
    const n = gatherUnderground3x3Neighbors(grid, 0, 0, NO_ENTRANCES);
    expect(n).toEqual({
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'wall', c: 'wall', e:  'wall',
      sw: 'wall', s: 'open', se: 'open',
    });
  });

  it('reuses an out buffer when one is passed (no allocation per call)', () => {
    // Performance contract: callers in the render loop pass a scratch
    // Neighbors3x3 so the per-frame tile sweep doesn't allocate. Verify
    // the function mutates the provided object and returns the same
    // reference rather than building a new one.
    const grid = createUndergroundGrid(3, 3);
    ugSet(grid, 1, 1, UndergroundTileState.Open);
    const scratch: ReturnType<typeof gatherUnderground3x3Neighbors> = {
      nw: 'wall', n: 'wall', ne: 'wall',
      w:  'wall', c: 'wall', e:  'wall',
      sw: 'wall', s: 'wall', se: 'wall',
    };
    const result = gatherUnderground3x3Neighbors(grid, 1, 1, NO_ENTRANCES, scratch);
    expect(result).toBe(scratch);          // same reference, not a copy
    expect(scratch.c).toBe('open');        // mutated in place
  });

  it('is deterministic — same inputs produce the same output every call', () => {
    const grid = createUndergroundGrid(5, 5);
    ugSet(grid, 2, 2, UndergroundTileState.Open);
    const a = gatherUnderground3x3Neighbors(grid, 2, 2, NO_ENTRANCES);
    const b = gatherUnderground3x3Neighbors(grid, 2, 2, NO_ENTRANCES);
    expect(a).toEqual(b);
  });
});
