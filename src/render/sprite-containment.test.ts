// sprite-containment.test.ts — PR 6-render (#128 class-iii) CONTAINMENT PROBE.
//
// Proves the invariant rather than enumerating: for a sprite anchored on a valid
// Open tile, containedScale() yields a scale whose rotated drawn footprint never
// overlaps a Solid/off-grid tile (⊆ the union of passable neighbours). Tested at
// the boundary cases the spec names — rotation extrema, each sprite kind's max
// scale, interpolation-alpha sub-tile centers {0, 0.5, 1} + midpoints — against
// adjacent Solid; plus the dual case (overflow INTO passable neighbours is
// allowed, not clamped).

import { describe, it, expect } from 'vitest';
import { createUndergroundGrid, ugSet, UndergroundTileState } from '../sim/terrain.js';
import type { UndergroundGrid } from '../sim/terrain.js';
import { TILE_SIZE_PX } from './sprites.js';
import {
  WORKER_SPRITE_WIDTH,
  WORKER_SPRITE_HEIGHT,
  QUEEN_SPRITE_WIDTH,
  QUEEN_SPRITE_HEIGHT,
} from './ant-sprite-layer.js';
import { containedScale, aabbOverlapsDirt } from './sprite-containment.js';

const CX = 5;
const CY = 5;

/** Grid (default all-Solid) with a single Open tile at (CX,CY) — all 8 neighbours
 *  and everything else are Solid dirt: the worst case for containment. */
function islandGrid(): UndergroundGrid {
  const g = createUndergroundGrid(16, 16);
  ugSet(g, CX, CY, UndergroundTileState.Open);
  return g;
}

/** Grid with a 5×5 Open field centered on (CX,CY) — neighbours are passable, so
 *  a sprite may overflow into them and must NOT be clamped. */
function openFieldGrid(): UndergroundGrid {
  const g = createUndergroundGrid(16, 16);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      ugSet(g, CX + dx, CY + dy, UndergroundTileState.Open);
    }
  }
  return g;
}

const KINDS = [
  { name: 'worker', w: WORKER_SPRITE_WIDTH, h: WORKER_SPRITE_HEIGHT, maxScale: 1.0 },
  { name: 'fighter', w: WORKER_SPRITE_WIDTH, h: WORKER_SPRITE_HEIGHT, maxScale: 1.25 },
  { name: 'queen', w: QUEEN_SPRITE_WIDTH, h: QUEEN_SPRITE_HEIGHT, maxScale: 1.0 },
] as const;

// Rotation extrema + the 45° AABB maximum + midpoints.
const ROTATIONS = [
  0,
  Math.PI / 6,
  Math.PI / 4,
  Math.PI / 3,
  Math.PI / 2,
  Math.PI,
  (3 * Math.PI) / 4,
];
// Interpolation-alpha sub-tile centers: fraction of the tile the center sits at.
// alpha 0 / 0.5 / 1 between two same-tile endpoints maps to interior offsets;
// include realistic off-center positions an interpolated ant can occupy.
const CENTER_FRACS = [0.3, 0.4, 0.5, 0.6, 0.7];

describe('PR 6-render containment probe — sprite on an Open tile never paints Solid', () => {
  it('clamped footprint overlaps NO dirt across kinds × rotations × sub-tile centers (island)', () => {
    const grid = islandGrid();
    let checks = 0;
    for (const kind of KINDS) {
      for (const rot of ROTATIONS) {
        for (const fx of CENTER_FRACS) {
          for (const fy of CENTER_FRACS) {
            const cx = (CX + fx) * TILE_SIZE_PX;
            const cy = (CY + fy) * TILE_SIZE_PX;
            const scale = containedScale(grid, cx, cy, kind.w, kind.h, rot, kind.maxScale);
            expect(scale).toBeLessThanOrEqual(kind.maxScale + 1e-9);
            expect(scale).toBeGreaterThanOrEqual(0);
            // The invariant: the clamped footprint touches no Solid/off-grid tile.
            expect(aabbOverlapsDirt(grid, cx, cy, kind.w, kind.h, rot, scale)).toBe(false);
            checks++;
          }
        }
      }
    }
    console.log(`PASS PR6 render containment (island): ${checks} configs, 0 dirt overlaps`);
  });

  it('the UNCLAMPED queen DOES overflow onto Solid — proving the probe is not vacuous', () => {
    // Sanity: at full scale (no clamp) the 20×14 queen overflows the 16px tile
    // onto the Solid neighbours, so the probe is actually constraining something.
    const grid = islandGrid();
    const cx = (CX + 0.5) * TILE_SIZE_PX;
    const cy = (CY + 0.5) * TILE_SIZE_PX;
    expect(aabbOverlapsDirt(grid, cx, cy, QUEEN_SPRITE_WIDTH, QUEEN_SPRITE_HEIGHT, 0, 1.0)).toBe(
      true,
    );
    // And the clamp fixes it.
    const scale = containedScale(grid, cx, cy, QUEEN_SPRITE_WIDTH, QUEEN_SPRITE_HEIGHT, 0, 1.0);
    expect(scale).toBeLessThan(1.0);
    expect(aabbOverlapsDirt(grid, cx, cy, QUEEN_SPRITE_WIDTH, QUEEN_SPRITE_HEIGHT, 0, scale)).toBe(
      false,
    );
  });

  it('overflow INTO passable neighbours is allowed — a centered queen is NOT clamped', () => {
    const grid = openFieldGrid();
    const cx = (CX + 0.5) * TILE_SIZE_PX;
    const cy = (CY + 0.5) * TILE_SIZE_PX;
    // All neighbours passable → no dirt to hit → full scale retained.
    const scale = containedScale(grid, cx, cy, QUEEN_SPRITE_WIDTH, QUEEN_SPRITE_HEIGHT, 0, 1.0);
    expect(scale).toBe(1.0);
    expect(aabbOverlapsDirt(grid, cx, cy, QUEEN_SPRITE_WIDTH, QUEEN_SPRITE_HEIGHT, 0, scale)).toBe(
      false,
    );
    console.log('PASS PR6 render containment: passable-neighbour overflow allowed (no over-clamp)');
  });

  it('a freshly-descended ant at the grid top edge is NOT clamped to zero (above-grid exempt)', () => {
    // Regression (ship-review round 1): isDirt treated ALL off-grid tiles as
    // dirt, so an ant at posY=0 (sprite center exactly on the top edge, edgeN=0)
    // was clamped to scale 0 and popped out of existence on every descent.
    // Nothing renders above row 0 in the underground viewport, so the row
    // above the grid is exempt from containment.
    const g = createUndergroundGrid(16, 16); // all Solid
    ugSet(g, CX, 0, UndergroundTileState.Open); // 1-wide entrance shaft
    ugSet(g, CX, 1, UndergroundTileState.Open);
    const cx = (CX + 0.5) * TILE_SIZE_PX;
    const cy = 0; // center on the grid's top edge — the descent spawn position
    const scale = containedScale(g, cx, cy, WORKER_SPRITE_WIDTH, WORKER_SPRITE_HEIGHT, 0, 1.0);
    // 12×8 worker: hx 6 ≤ edgeW/E 8 (Solid shaft walls), south Open, north exempt.
    expect(scale).toBe(1.0);
    expect(aabbOverlapsDirt(g, cx, cy, WORKER_SPRITE_WIDTH, WORKER_SPRITE_HEIGHT, 0, scale)).toBe(
      false,
    );
  });

  it('crossing a tile edge in a 1-wide tunnel is NOT corner-clamped toward zero', () => {
    // Regression (ship-review round 1): a Solid diagonal used to clamp BOTH
    // axes to that corner's edge distances unconditionally, so a center
    // approaching a tile edge (edgeE → 0) with dirt diagonally ahead collapsed
    // the factor toward 0 on every tile crossing in a 1-wide tunnel. The corner
    // only obstructs when the AABB crosses both of its edges — here hy (4)
    // never crosses the tunnel walls' edge (8), so it must not clamp at all.
    const g = createUndergroundGrid(16, 16); // all Solid
    for (let x = 3; x <= 8; x++) ugSet(g, x, CY, UndergroundTileState.Open); // 1-wide tunnel
    const cx = (CX + 0.95) * TILE_SIZE_PX; // about to cross into tile CX+1
    const cy = (CY + 0.5) * TILE_SIZE_PX;
    const scale = containedScale(g, cx, cy, WORKER_SPRITE_WIDTH, WORKER_SPRITE_HEIGHT, 0, 1.0);
    expect(scale).toBe(1.0);
    expect(aabbOverlapsDirt(g, cx, cy, WORKER_SPRITE_WIDTH, WORKER_SPRITE_HEIGHT, 0, scale)).toBe(
      false,
    );
  });

  it('workers at natural size are never clamped on an open field (fit one tile)', () => {
    const grid = islandGrid();
    const cx = (CX + 0.5) * TILE_SIZE_PX;
    const cy = (CY + 0.5) * TILE_SIZE_PX;
    // 12×8 at scale 1, no rotation → half 6×4 < 8 → fits within the tile even on
    // an all-Solid island.
    const scale = containedScale(grid, cx, cy, WORKER_SPRITE_WIDTH, WORKER_SPRITE_HEIGHT, 0, 1.0);
    expect(scale).toBe(1.0);
    expect(
      aabbOverlapsDirt(grid, cx, cy, WORKER_SPRITE_WIDTH, WORKER_SPRITE_HEIGHT, 0, scale),
    ).toBe(false);
  });
});
