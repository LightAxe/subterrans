// danger.ts — shared DangerTrail deposit helper (leaf; #209 PR A).
//
// The 5-tile cross deposit (center + N/S/E/W) that the spider seeds every
// surface tick (spider.ts seedDangerPheromone) is now also used by the
// cross-colony ant-kill alarm (combat.ts killAnt), so the primitive is factored
// here to keep the two writers byte-identical.
//
// MUST NOT import Phaser, DOM, or any non-leaf module. phGet/phSet are the
// bounds-safe accessors (out-of-bounds read → 0, write → no-op), so the cross
// arms that fall off the grid edge are silently skipped — byte-identical to the
// spider's previous explicitly-guarded unroll.

import { phGet, phSet, type PheromoneGrid } from './pheromone-store.js';
import { PHEROMONE_CAP } from '../constants.js';

/** Additive deposit at (x, y) clamped to PHEROMONE_CAP. Bounds-safe (phGet/phSet). */
function deposit(grid: PheromoneGrid, x: number, y: number, add: number): void {
  const v = phGet(grid, x, y) + add;
  phSet(grid, x, y, v > PHEROMONE_CAP ? PHEROMONE_CAP : v);
}

/**
 * Deposit a 5-tile danger cross on `grid`: `center` at (tx, ty) and `neighbor`
 * at each of N/S/E/W. Additive, clamped to PHEROMONE_CAP, allocation-free.
 * Arms off the grid edge are no-ops (bounds-safe accessors).
 */
export function depositDangerCross(
  grid: PheromoneGrid,
  tx: number,
  ty: number,
  center: number,
  neighbor: number,
): void {
  deposit(grid, tx, ty, center);
  deposit(grid, tx, ty - 1, neighbor);
  deposit(grid, tx, ty + 1, neighbor);
  deposit(grid, tx - 1, ty, neighbor);
  deposit(grid, tx + 1, ty, neighbor);
}
