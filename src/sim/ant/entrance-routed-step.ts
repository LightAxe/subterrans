// src/sim/ant/entrance-routed-step.ts
// #212 Layer 1 (behavior): the step a surface walker bound for ONE particular
// entrance takes to get there round obstacles (#357 + #358, V57). Depends on no
// other ant module (only the sim core's surface goal fields); the orchestrator
// (ant-movement.ts) calls it for the walkers whose policy says so — a tunnel
// defender (ant-combat-targeting: defenderWalksToEntrance) and a surface digger
// (ant-dig: surfaceDiggerRoutesToEntrance). No behaviour module depends on it.
//
// Why not the colony's surface entrance flow field: it leads to the NEAREST OPEN
// entrance, and each of these walkers is bound for one entrance that may not be it
// (a defender may go down only the entrance it defends; a digger's target may be
// a closed, designated entrance, which is on no entrance flow field).
import { FP_SHIFT } from '../fixed.js';
import {
  SURFACE_GOAL_UNREACHED,
  stepTowardReachable,
  surfaceGoalDistance,
} from '../surface-routing.js';
import type { WorldState } from '../types.js';

/** entranceRoutedStep's result for a walker whose tile cannot reach its target. */
export const OFF_GOAL_FIELD = -1;

/**
 * #357 / #358 (V57) — the packed step (unpackStepDx/Dy) a surface walker at fp
 * (posX, posY) takes toward the entrance at fp (targetX, targetY), down the
 * surface goal field seeded at that entrance's tile (stepTowardReachable:
 * obstacle-aware, cached per target tile on the frozen terrain). (0, 0) on the
 * entrance tile itself. OFF_GOAL_FIELD when the walker's tile cannot reach the
 * entrance, so the caller keeps its straight-line step (stepTowardReachable would
 * throw there).
 */
export function entranceRoutedStep(
  world: WorldState,
  posX: number,
  posY: number,
  targetX: number,
  targetY: number,
): number {
  const tileX = posX >> FP_SHIFT;
  const tileY = posY >> FP_SHIFT;
  const entranceX = targetX >> FP_SHIFT;
  const entranceY = targetY >> FP_SHIFT;
  if (surfaceGoalDistance(world, tileX, tileY, entranceX, entranceY) === SURFACE_GOAL_UNREACHED) {
    return OFF_GOAL_FIELD;
  }
  return stepTowardReachable(world, tileX, tileY, entranceX, entranceY);
}
