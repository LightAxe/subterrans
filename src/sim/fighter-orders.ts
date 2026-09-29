// src/sim/fighter-orders.ts
// #372 (V64) — which fighters a colony's rally point applies to.
//
// Up to V63 a colony's rally point applied to every one of its fighters. From V64 an
// AI probe's rally applies only to the probe's cohort: the fighters the AI recorded
// for it (AIStateRecord.operationFighterIds). Every other fighter of that colony has
// no orders: it is a sentry (or, while the nest is invaded, an automatic defender).
//
// Sits at src/sim/ root (outside the ant-cycle graph) and reads world.aiState
// directly, so any ant behaviour module may use it.

import { AntTask } from './enums.js';
import { SIM_VERSION_V64_AUTO_DEFENCE, type WorldState } from './types.js';
import type { ColonyRecord } from './colony/colony-store.js';

/**
 * #372 (V64) — `colony`'s rally point is its AI probe's rally: the colony has an AI
 * state record running a Probe and the rally is on that probe's target tile. Only the
 * probe's cohort answers such a rally (fighterOutsideProbeCohort). Any other rally
 * (the player's, an invasion's, the AI's nest defence) applies to every fighter.
 * Always false below V64 and with no rally.
 */
export function colonyRallyIsProbe(world: WorldState, colony: ColonyRecord): boolean {
  if (world.simVersion < SIM_VERSION_V64_AUTO_DEFENCE) return false;
  const rp = colony.rallyPoint;
  if (rp == null) return false;
  for (let i = 0; i < world.aiState.length; i++) {
    const rec = world.aiState[i]!;
    if (rec.colonyId !== colony.colonyId) continue;
    return (
      rec.operationKind === 'Probe' &&
      rec.operationTargetTileX === rp.tileX &&
      rec.operationTargetTileY === rp.tileY
    );
  }
  return false;
}

/**
 * #372 (V64) — fighter `id`'s colony's rally is its AI probe's rally
 * (colonyRallyIsProbe) and `id` is not in the probe's cohort, so the rally does not
 * apply to it: it has no orders. Always false below V64 (colonyRallyIsProbe is), for
 * a non-fighter, and for
 * every fighter of a colony whose rally is not a probe's.
 */
export function fighterOutsideProbeCohort(world: WorldState, id: number): boolean {
  if (world.ants.task[id] !== AntTask.Fighting) return false;
  const colonyId = world.ants.colonyId[id]!;
  const colony = world.colonies[colonyId];
  if (colony === undefined || !colonyRallyIsProbe(world, colony)) return false;
  for (let i = 0; i < world.aiState.length; i++) {
    const rec = world.aiState[i]!;
    if (rec.colonyId !== colonyId) continue;
    for (let k = 0; k < rec.operationFighterCount; k++) {
      if (rec.operationFighterIds[k] === id) return false;
    }
    return true;
  }
  return false;
}

/**
 * #372 — fighter `id` answers its colony's rally point: the colony has one and, from
 * V64, it is not a probe's rally `id` is outside the cohort of. Below V64 exactly
 * "its colony has a rally point". False for a missing colony.
 */
export function fighterAnswersRally(world: WorldState, id: number): boolean {
  const colony = world.colonies[world.ants.colonyId[id]!];
  if (colony === undefined || colony.rallyPoint == null) return false;
  return !fighterOutsideProbeCohort(world, id);
}
