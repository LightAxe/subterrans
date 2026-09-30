// chamber-tiles.test.ts — #378 review: the one fixed-point decode of a chamber's
// position. Pins the helpers to the two inline formulas they replaced — the
// invasion flash's anchor tile (game-scene, `posX >> 8`) and the colony-toggle
// camera's chamber centre — so each caller keeps exactly the coordinates it had.
// The camera caller itself is pinned end to end in camera.test.ts; the game-scene
// call site lives in the Phaser scene and is not unit-tested.

import { describe, it, expect } from 'vitest';
import { chamberAnchorTile, chamberCenterTile } from './chamber-tiles.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { TILE_SIZE_PX } from './sprites.js';

/** Chamber positions in fixed point, including fractional bits (floored). */
const POSITIONS: Array<[number, number]> = [
  [0, 0],
  [30 << FP_SHIFT, 25 << FP_SHIFT],
  [(90 << FP_SHIFT) + 1, (20 << FP_SHIFT) + 255],
  [(127 << FP_SHIFT) + 128, (63 << FP_SHIFT) + 7],
];

describe('chamberAnchorTile', () => {
  it('is exactly the `posX >> 8` / `posY >> 8` the invasion flash (game-scene) used', () => {
    expect(FP_SHIFT).toBe(8);
    for (const [posX, posY] of POSITIONS) {
      expect(chamberAnchorTile({ posX, posY })).toEqual({ tileX: posX >> 8, tileY: posY >> 8 });
    }
  });
});

describe('chamberCenterTile', () => {
  it('× TILE_SIZE_PX is exactly the centre undergroundNestCenterPx (camera) computed', () => {
    for (const [posX, posY] of POSITIONS) {
      for (const [width, height] of [
        [6, 4],
        [3, 3],
        [4, 5],
      ] as const) {
        const c = chamberCenterTile({ posX, posY, width, height });
        expect(c.tileX * TILE_SIZE_PX).toBe(((posX >> FP_SHIFT) + width / 2) * TILE_SIZE_PX);
        expect(c.tileY * TILE_SIZE_PX).toBe(((posY >> FP_SHIFT) + height / 2) * TILE_SIZE_PX);
      }
    }
  });

  it('is the anchor plus half the footprint (a half tile on an odd side)', () => {
    expect(chamberCenterTile({ posX: 90 << 8, posY: 20 << 8, width: 6, height: 3 })).toEqual({
      tileX: 93,
      tileY: 21.5,
    });
  });
});
