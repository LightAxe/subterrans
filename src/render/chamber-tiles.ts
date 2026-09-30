// chamber-tiles.ts — #378 review: a chamber's position in tiles, decoded in one
// place. A ChamberRecord stores its top-left anchor in fixed point (posX/posY,
// FP_SHIFT fractional bits) and its footprint in whole tiles (width/height), so
// render code that frames or aims at a chamber decodes it through here rather
// than repeating the shift.
//
// Pure + Phaser-free: reads a ChamberRecord, never writes it.

import type { ChamberRecord } from '../sim/colony/colony-store.js';
import { FP_SHIFT } from '../sim/fixed.js';

/** The tile of a chamber's top-left anchor: its fixed-point position, floored to
 *  the whole tile (`posX >> FP_SHIFT`, `posY >> FP_SHIFT`). */
export function chamberAnchorTile(ch: Pick<ChamberRecord, 'posX' | 'posY'>): {
  tileX: number;
  tileY: number;
} {
  return { tileX: ch.posX >> FP_SHIFT, tileY: ch.posY >> FP_SHIFT };
}

/** The centre of a chamber's footprint, in tiles (a half tile on an odd side):
 *  its anchor tile plus half its width and height. */
export function chamberCenterTile(ch: Pick<ChamberRecord, 'posX' | 'posY' | 'width' | 'height'>): {
  tileX: number;
  tileY: number;
} {
  const a = chamberAnchorTile(ch);
  return { tileX: a.tileX + ch.width / 2, tileY: a.tileY + ch.height / 2 };
}
