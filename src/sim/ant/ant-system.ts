// src/sim/ant/ant-system.ts
// #212: thin re-export barrel for the ant subsystem. The implementation lives in
// cohesive sub-modules (ant-motion / ant-foraging / ant-nursing / ant-queens /
// ant-combat-targeting / ant-dig / ant-pheromone / ant-movement); this file only
// re-exports the public API so consumers (tick.ts, harness.ts, tests) keep a single
// stable import path. Explicit NAMED re-exports — never `export *` — so internal
// cross-module helpers stay internal.
//
// New ant behavior goes in a new src/sim/ant/*.ts sub-module, NOT here (see AGENTS.md).

export type { CardinalStep } from './ant-motion.js';
export {
  pickCardinalStep,
  unpackStepDx,
  unpackStepDy,
  getTaskDirection,
  canEnterUndergroundTile,
  canEnterSurfaceTile,
  pickSurfaceDetour,
} from './ant-motion.js';
export {
  antPickupFood,
  antDepositFood,
  tickForagerActions,
  routeForagerPriority,
  chooseExcursionDirection,
  tickExcursionBoundary,
} from './ant-foraging.js';
export { tickNurseActions } from './ant-nursing.js';
export { tickSearchLeash, tickDigExecution } from './ant-dig.js';
export { tickPheromoneDeposit } from './ant-pheromone.js';
export {
  updateFightAntTargets,
  pickNearestHostileUnderground,
  pickInvaderUndergroundStep,
} from './ant-combat-targeting.js';
export { tickAntMovement } from './ant-movement.js';
export { tickIdleReserveAndFlee } from './idle-reserve.js';
