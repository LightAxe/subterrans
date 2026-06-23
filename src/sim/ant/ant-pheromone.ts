// src/sim/ant/ant-pheromone.ts
// #212 Layer 1 (behavior): food-trail pheromone deposit. A tick.ts step; depends only
// on sibling sim modules (pheromone store/system). No ant/ module depends on it.
import { ENTRANCE_DEPOSIT_SUPPRESS_RADIUS, FOOD_TRAIL_DEPOSIT_V14 } from '../constants.js';
import { PheromoneType } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import { pheromoneGridKey } from '../pheromone/pheromone-store.js';
import { depositFoodTrail } from '../pheromone/pheromone-system.js';
import { Zone } from '../terrain.js';
import type { WorldState } from '../types.js';

/**
 * Deposit food-trail pheromone for every alive, food-carrying ant.
 *
 * PRD §5b carry-only rule (PHER-03): only ants with foodCarrying > 0 deposit.
 * Deposit targets the colony's food-trail surface grid (Phase 6 hardcoded zone).
 *
 * Near-entrance suppression (09 excursion-foraging follow-up): deposits within
 * ENTRANCE_DEPOSIT_SUPPRESS_RADIUS Manhattan tiles of any own-colony entrance
 * are skipped to prevent nest-mouth scalar-peak oscillation for searchers.
 *
 * @param world  WorldState (reads ants, colonies, pheromoneGrids).
 */
export function tickPheromoneDeposit(world: WorldState): void {
  const ants = world.ants;

  // Issue #57 — gate underground carriers OUT of the surface FoodTrail loop.
  // Pre-v11 this loop iterated EVERY alive food-carrying ant and deposited
  // at `pheromoneGridKey(colonyId, FoodTrail, 'surface')` using the ant's
  // tile coords. Underground tiles (0..127, 0..63) all map to real surface
  // cells — nothing was clipped — so underground carriers wrote phantom
  // trails on the surface that surface foragers then read. The entrance-
  // suppression check below also compared surface entrance tiles to
  // underground coords, producing nonsense distances that effectively
  // never fired the radius cutoff.
  //
  // Pre-v11 saves keep the bugged behaviour for replay determinism — the
  // pheromone grids round-trip through saves and any phantom trails baked
  // into a v10 snapshot must continue to influence v10-replay routing.
  // S0a / issue #119 — V14+ uses a stronger deposit per step.
  const depositAmount = FOOD_TRAIL_DEPOSIT_V14;

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.foodCarrying[id]! <= 0) continue;
    if (ants.zone[id] !== Zone.Surface) continue;

    const colonyId = ants.colonyId[id]!;
    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    // 09 excursion-foraging follow-up (issue 2): suppress deposits near any
    // own-colony entrance to keep the trail peak out along the path toward
    // food rather than stacking it at the nest mouth.
    const colony = world.colonies[colonyId];
    if (colony && colony.entrances && colony.entrances.length > 0) {
      let nearEntrance = false;
      for (let e = 0; e < colony.entrances.length; e++) {
        const ent = colony.entrances[e]!;
        const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
        if (d <= ENTRANCE_DEPOSIT_SUPPRESS_RADIUS) {
          nearEntrance = true;
          break;
        }
      }
      if (nearEntrance) continue;
    }

    const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
    const grid = world.pheromoneGrids[key];
    if (!grid) continue; // grid missing — silently skip (scenario-dependent presence)

    depositFoodTrail(grid, tileX, tileY, depositAmount);
  }
}
