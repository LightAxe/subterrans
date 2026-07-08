// src/sim/ant/ant-dig.ts
// #212 Layer 1 (behavior): search-leash dig assignment + dig execution. Tick steps
// invoked by tick.ts; depend only on Layer-0 ant-motion (+ sibling sim modules).
import { colonyForageBackpressure } from '../colony/colony-system.js';
import { DIG_TICKS_PER_TILE, SEARCH_LEASH_MAX_WAVE, SEARCH_LEASH_RADII } from '../constants.js';
import type { DigFlowFields } from '../dig-system.js';
import { AntTask, DiggingSubState, ForagingSubState } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import { UndergroundTileState, Zone, ugSet } from '../terrain.js';
import type { WorldState } from '../types.js';
import { clearRecentTiles } from './ant-store.js';

/**
 * Step-9b: release stuck SearchingFood surface foragers back to Idle so
 * step 10a can re-home them against the current behavior allocation.
 *
 * Only affects ants with: alive=1, task=Foraging, subTask=SearchingFood,
 * zone=Surface, colony has ≥1 entrance, AND the colony is CURRENTLY
 * over-foraged (taskCensus.forage > computedAllocation.forage — the
 * exact state the memo calls out as "no longer supports that role").
 * CarryingFood ants complete their return/deposit cycle regardless
 * (PRD §4c idle-checkpoint already releases them on deposit — see
 * antDepositFood).
 *
 * @param world  WorldState (reads ants, colonies; writes ants.task, subTask,
 *               targetPosX/Y, searchWave).
 */
export function tickSearchLeash(world: WorldState): void {
  const ants = world.ants;

  // Pre-resolve per-colony "over-foraged with player-requested non-forage
  // demand?" so the ant loop does a cheap boolean lookup per entity.
  //
  // The leash fires ONLY when (a) more workers are foraging than the
  // allocation asks for AND (b) the player has asked for dig or fight
  // work (computedAllocation.dig + fight > 0). This matches the memo's
  // exact target: "when the colony's requested allocation no longer
  // supports that role" — i.e. the triangle-responsiveness bug, where a
  // player dragging toward dig/fight waits on stuck searchers.
  //
  // Why nurse demand does NOT arm the leash: nurses are auto-carved from
  // brood count (allocation-system.ts computeNurseCount), not player-
  // requested. The nurse slot fills naturally from foragers completing
  // their deposit cycle (antDepositFood → Idle → step 10a → nurse). Arming
  // the leash on nurse demand would break the autonomous forage bootstrap
  // — as soon as broodCount ≥ NURSE_RATIO, a nurse is carved and all
  // searchers would be demoted before they ever reached food piles beyond
  // the wave-3 radius (40 tiles).
  const rebalanceNeeded: Record<number, boolean> = {};
  // Issue #42 fix #2 — "no deposit target" demotion. When the colony's
  // entrance pool is at cap AND no FoodStorage chamber is depositable, any
  // food a forager finds has nowhere to land — demoting these searchers
  // (regardless of wave-radius) avoids the eddy at the entrance that
  // forms when waves of would-be carriers can't unload. Step 10a will
  // re-promote them to Foraging once a deposit target opens (chamber built
  // or queen consumes pool down). v6+ only — pre-v6 saves replay byte-
  // identical, only the demote-on-cap behavior is new.
  const forageBackpressure: Record<number, boolean> = {};
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const overForage = colony.taskCensus.forage > colony.computedAllocation.forage;
    const nonForageDemand =
      colony.computedAllocation.dig > 0 || colony.computedAllocation.fight > 0;
    rebalanceNeeded[colony.colonyId] = overForage && nonForageDemand;

    // Shared forager-backpressure gate — kept in lockstep with the #126 step-10a
    // idle-promotion suppression (colony-system.ts) so a forager is never
    // re-promoted into a state this leash would immediately demote. Scoped to
    // colonies that own a FoodStorage chamber (the mature-colony pile-up of #126).
    forageBackpressure[colony.colonyId] = colonyForageBackpressure(colony);
  }

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;
    if (ants.subTask[id] !== ForagingSubState.SearchingFood) continue;
    if (ants.zone[id] !== Zone.Surface) continue;

    const colonyId = ants.colonyId[id]!;
    const noDeposit = forageBackpressure[colonyId] === true;
    const rebalance = rebalanceNeeded[colonyId] === true;
    if (!noDeposit && !rebalance) continue;

    const colony = world.colonies[colonyId];
    if (!colony || !colony.entrances || colony.entrances.length === 0) continue;

    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    let wave = ants.searchWave[id]!;
    if (wave < 0) wave = 0;
    if (wave > SEARCH_LEASH_MAX_WAVE) wave = SEARCH_LEASH_MAX_WAVE;

    // Two independent reasons to demote (issue #42 fix #2 introduces the
    // second). The radius gate produces a wave bump (we've searched out
    // to this distance and reset to consider re-promotion at a wider
    // radius); the no-deposit gate does not (the issue isn't search
    // distance, it's that there's nowhere to bring food back to).
    let overLeashed = false;
    if (rebalance) {
      // Nearest-entrance Manhattan distance. Any entrance counts (open or closed
      // — the leash is about drift from the nest, not about reachability).
      let bestDist = -1;
      for (let e = 0; e < colony.entrances.length; e++) {
        const ent = colony.entrances[e]!;
        const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
        if (bestDist < 0 || d < bestDist) bestDist = d;
      }
      if (bestDist >= 0) {
        const radius = SEARCH_LEASH_RADII[wave]!;
        overLeashed = bestDist > radius;
      }
    }
    if (!overLeashed && !noDeposit) continue;

    // Demote → Idle (step 10a re-entry). Clear priority target so the ant
    // doesn't carry a stale override into its next promotion.
    ants.task[id] = AntTask.Idle;
    ants.subTask[id] = 0;
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;

    // 09 excursion-foraging memo — clear heading so the re-promoted ant
    // chooses a fresh outward direction from its current position instead
    // of continuing the stale heading that just leashed it. Follow-up:
    // also clear prev-tile so the next SearchingFood pass isn't biased by
    // stale anti-backtrack memory from the leashed route.
    ants.searchHeadingX[id] = 0;
    ants.searchHeadingY[id] = 0;
    ants.searchHeadingTicks[id] = 0;
    ants.searchPrevTileX[id] = -1;
    ants.searchPrevTileY[id] = -1;
    // Issue #35 — clear pause counter on leash demotion so the next
    // search excursion starts with a clean cadence.
    ants.searchPauseTicks[id] = 0;
    // Issue #42 fix #3 — clear recent-tiles buffer on demotion so a
    // re-promoted forager doesn't carry stale revisit-history from the
    // leashed route into its fresh excursion.
    clearRecentTiles(ants, id);

    // Wave bump applies only when the radius-leash gate fired. A pure
    // no-deposit demotion preserves the wave so the ant resumes searching
    // at the same radius once a deposit target opens up.
    if (overLeashed) {
      const nextWave = wave + 1;
      ants.searchWave[id] = nextWave > SEARCH_LEASH_MAX_WAVE ? SEARCH_LEASH_MAX_WAVE : nextWave;
    }
  }
}

/**
 * Step-10 dig-worker execution. Owns the Marked→BeingDug→Open state machine.
 * Called from tick.ts step 10, after the existing idle-reassignment worker allocation,
 * and BEFORE step 11 checkPendingChambers / step 12 checkEntranceCompletion — those
 * steps depend on this tick's transitions having already happened (accepted Phase 3 PRD §9b).
 *
 * For each alive ant with task === AntTask.Digging:
 *   - DiggingSubState.MovingToTile: read flow-field at ant's current tile.
 *     If direction === -1 (ant is ON the Marked tile): claim it.
 *       ugSet(underground, tileX, tileY, UndergroundTileState.BeingDug);
 *       colony.digFlowFieldDirty = true;
 *       ants.digTileX[id] = tileX; ants.digTileY[id] = tileY;
 *       ants.digTicksRemaining[id] = DIG_TICKS_PER_TILE;
 *       ants.subTask[id] = DiggingSubState.Excavating;
 *     Otherwise: no-op (the ant will move toward the Marked tile in step 16).
 *
 *   - DiggingSubState.Excavating: decrement ants.digTicksRemaining[id].
 *     If it reaches 0:
 *       ugSet(underground, digTileX, digTileY, UndergroundTileState.Open);
 *       colony.digFlowFieldDirty = true;
 *       ants.digTileX[id] = -1; ants.digTileY[id] = -1;
 *       ants.subTask[id] = DiggingSubState.MovingToTile;
 *
 * @param world          WorldState (reads/writes ants, undergroundGrids, colonies).
 * @param digFlowFields  Per-colony flow-field cache (reads fields for direction lookup).
 */
export function tickDigExecution(world: WorldState, digFlowFields: DigFlowFields): void {
  const ants = world.ants;

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Digging) continue;

    // colonyId keys the digger's OWN colony (digFlowFields, world.colonies);
    // gridColonyId keys the underground grid the ant currently occupies
    // (Phase 09.1 Chunk 0). Today both values are identical; diggers never
    // invade so this decoupling is forward-compatibility.
    const colonyId = ants.colonyId[id]!;
    const gridColonyId = ants.currentGridColonyId[id]!;
    const subTask = ants.subTask[id]!;

    // Phase 9 digger-reassignment fix (09-DIGGER-REASSIGNMENT-BUG.md):
    // Release dormant diggers — workers in MovingToTile with no reachable or
    // pending dig work — back to AntTask.Idle so step 10a (next tick) can
    // rehome them against the current behavior-triangle allocation. Previously
    // these ants stayed classified as Digging indefinitely and never made it
    // back into the eligible-for-reassignment set. Excavating is NEVER
    // released: a claimed tile must finish to avoid dropping BeingDug state.
    if (subTask === DiggingSubState.MovingToTile) {
      const flowField = digFlowFields.fields[colonyId];
      const underground = world.undergroundGrids[gridColonyId];
      if (!flowField || !underground) {
        // Colony has never marked dig work / no underground grid — release.
        ants.task[id] = AntTask.Idle;
        ants.subTask[id] = 0;
        continue;
      }
      if (ants.zone[id] === Zone.Underground) {
        const atTileX = ants.posX[id]! >> FP_SHIFT;
        const atTileY = ants.posY[id]! >> FP_SHIFT;
        const atDir = flowField[atTileY * underground.width + atTileX];
        if (atDir === undefined || atDir === -2) {
          // Underground but no reachable dig source from here — release.
          // Surface diggers with a valid flow field are NOT released: tickAntMovement
          // routes them to an entrance and they'll re-enter this path once underground.
          ants.task[id] = AntTask.Idle;
          ants.subTask[id] = 0;
          continue;
        }
      }
    }

    // Dig workers must be underground for claim / excavation countdown.
    if (ants.zone[id] !== Zone.Underground) continue;

    const colony = world.colonies[colonyId];
    if (!colony) continue;

    const underground = world.undergroundGrids[gridColonyId];
    if (!underground) continue;

    if (subTask === DiggingSubState.MovingToTile) {
      // Check flow-field to see if ant is ON a Marked tile
      const flowField = digFlowFields.fields[colonyId];
      if (!flowField) continue;

      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      const direction = flowField[tileY * underground.width + tileX];

      if (direction === -1) {
        // Ant is ON the Marked tile — claim it
        ugSet(underground, tileX, tileY, UndergroundTileState.BeingDug);
        colony.digFlowFieldDirty = true;
        ants.digTileX[id] = tileX;
        ants.digTileY[id] = tileY;
        ants.digTicksRemaining[id] = DIG_TICKS_PER_TILE;
        ants.subTask[id] = DiggingSubState.Excavating;
      }
      // Otherwise: no-op (ant will move toward Marked tile in step 16 movement)
    } else if (subTask === DiggingSubState.Excavating) {
      // Decrement countdown
      const remaining = ants.digTicksRemaining[id]!;
      if (remaining <= 0) continue; // guard against unexpected state

      const newRemaining = remaining - 1;
      ants.digTicksRemaining[id] = newRemaining;

      if (newRemaining === 0) {
        // Excavation complete — open the tile
        const digTileX = ants.digTileX[id]!;
        const digTileY = ants.digTileY[id]!;
        ugSet(underground, digTileX, digTileY, UndergroundTileState.Open);
        colony.digFlowFieldDirty = true;
        ants.digTileX[id] = -1;
        ants.digTileY[id] = -1;
        ants.subTask[id] = DiggingSubState.MovingToTile;
      }
    }
  }
}
