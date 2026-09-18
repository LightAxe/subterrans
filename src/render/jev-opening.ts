// jev-opening.ts — the code-owned opening the Jev opponent plays before it starts
// asking Jev anything.
//
// Rationale (validated in the spike): the first few thousand ticks are a solved
// build order — dig a shaft, place Queen / Nursery / FoodStorage — and spending
// model beats on it produced worse colonies and burned latency budget. So the
// opening reuses the rule-based controller's own exported helpers verbatim, which
// also means both colonies open identically and any strength difference is
// attributable to the live phase.
//
// Handoff = Queen + Nursery + first FoodStorage chambers all completed and none
// of ours pending. `isHandoffComplete` is a pure predicate over WorldState, so a
// controller created by bootFromSave detects its phase from the loaded world
// rather than assuming a fresh start.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, BehaviorRatio } from '../sim/colony/colony-store.js';
import type { SetBehaviorRatioCommand } from '../sim/commands.js';
import { ChamberType } from '../sim/enums.js';
import { aiInitialSetup, aiDigHeuristic, aiChamberPlacement } from './ai-controller.js';
import type { JevCommandLedger } from './jev-commands.js';

/** Fixed Behavior ratio for the opening — the rule-based AI's own 7:3. */
export const JEV_OPENING_RATIO: BehaviorRatio = { forage: 7, fight: 3 };

export interface JevOpeningState {
  ratioIssued: boolean;
}

export function createJevOpeningState(): JevOpeningState {
  return { ratioIssued: false };
}

/** One tick of the opening for `colonyId`. Idempotent; call every tick until handoff. */
export function runJevOpeningTick(
  world: WorldState,
  colonyId: ColonyId,
  ledger: JevCommandLedger,
  st: JevOpeningState,
): void {
  const colony = world.colonies[colonyId];
  if (colony === undefined || colony.defeated) return;

  if (!st.ratioIssued) {
    if (
      colony.targetRatio.forage !== JEV_OPENING_RATIO.forage ||
      colony.targetRatio.fight !== JEV_OPENING_RATIO.fight
    ) {
      const cmd: SetBehaviorRatioCommand = {
        type: 'SetBehaviorRatio',
        colonyId,
        ratio: { ...JEV_OPENING_RATIO },
        issuedAtTick: world.tick,
      };
      ledger.issue(world, cmd);
    }
    st.ratioIssued = true;
  }

  // aiInitialSetup is the guarded Entrance-recovery path (createScenario already
  // seeds an open Entrance + shaft, so this is normally a no-op).
  ledger.adopt(world, () => aiInitialSetup(world, colony));
  ledger.adopt(world, () => aiDigHeuristic(world, colony));
  ledger.adopt(world, () => aiChamberPlacement(world, colony));
}

/** Handoff = Queen, Nursery and first FoodStorage all completed, nothing of ours pending. */
export function isHandoffComplete(world: WorldState, colonyId: ColonyId): boolean {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return false;
  const has = (t: ChamberType): boolean => colony.chambers.some((c) => c.chamberType === t);
  if (!has(ChamberType.Queen) || !has(ChamberType.Nursery) || !has(ChamberType.FoodStorage)) {
    return false;
  }
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    if (world.pendingChambers[key]!.colonyId === colonyId) return false;
  }
  return true;
}
