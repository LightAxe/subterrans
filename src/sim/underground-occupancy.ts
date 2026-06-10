// underground-occupancy.ts — PR 6-sim (V30) shared occupancy primitives for the
// #128 embedding guards. Lives in a NEUTRAL module so both ant-system.ts and
// colony-system.ts can use it: ant-system already imports colony-system, so a
// colony-system → ant-system import would be a runtime cycle. WorldState/ColonyId
// are TYPE-ONLY imports (erased at runtime), and terrain/enums/fixed are
// low-level, so this module introduces no runtime cycle.
//
// Pure (FNDN-04): reads only; no Phaser/DOM/Math.random/Date/float; no world
// writes. `>> FP_SHIFT` is a bit op (not `/`).

import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import { UndergroundTileState, Zone } from './terrain.js';
import { AntTask } from './enums.js';
import { FP_SHIFT } from './fixed.js';

/** Pure task-aware passability of an underground tile STATE (no grid read):
 *  Open/BeingDug enterable by all tasks; Marked only by diggers; Solid by none.
 *  Lets the occupancy guard test a HYPOTHETICAL post-mutation state without
 *  writing the grid. `canEnterUndergroundTile` is this plus a bounds + grid read. */
export function isUndergroundStateEnterable(state: UndergroundTileState, task: AntTask): boolean {
  if (state === UndergroundTileState.Open || state === UndergroundTileState.BeingDug) return true;
  if (state === UndergroundTileState.Marked) return task === AntTask.Digging;
  return false; // Solid (and any future state): impassable for every task
}

/**
 * PR 6-sim (V30, #128 class-iv) — occupancy guard primitive. Returns the id of an
 * ant occupying (tileX, tileY) of the underground grid owned by `gridColonyId`
 * for whom `newState` would be NON-passable (i.e. the ant would embed if the tile
 * were set to `newState`), or -1 if no such occupant exists. Occupants are scanned
 * by `currentGridColonyId` (grid-of-occupancy), NOT owning colony, so a Fighting
 * foreigner standing in the mutated grid is seen (keying by colonyId would miss it
 * and embed it). Task-aware: a digger does not block a BeingDug→Marked revert
 * (Marked is passable for diggers), but any ant blocks a →Solid revert.
 */
export function findEmbeddedByTightening(
  world: WorldState,
  gridColonyId: ColonyId,
  tileX: number,
  tileY: number,
  newState: UndergroundTileState,
): number {
  const ants = world.ants;
  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.zone[id] !== Zone.Underground) continue;
    if (ants.currentGridColonyId[id] !== gridColonyId) continue;
    if (ants.posX[id]! >> FP_SHIFT !== tileX) continue;
    if (ants.posY[id]! >> FP_SHIFT !== tileY) continue;
    if (!isUndergroundStateEnterable(newState, ants.task[id]! as AntTask)) return id;
  }
  return -1;
}
