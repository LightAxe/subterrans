// larva-maturation.ts — nurse-acceleration pass for larva maturation.
//
// Runs as a second sub-step inside tick step 7, AFTER tickLifecycleTransitions
// has applied the baseline +1 age increment to every larva.
//
// Per-tick contract:
//   1. Gate on a completed Nursery chamber; no-op if absent.
//   2. Compute nursery throughput cap = tile count of the largest completed
//      Nursery chamber (from largestNurseryTileCount in colony-system.ts).
//   3. Iterate colony.larvae (existing larvae after baseline tick).
//   4. For each larva, find the lowest-index nurse in Attending OR Feeding
//      substate within Manhattan-1, not yet used this tick.
//   5. Assign the nurse (stamp-mark it), consume one throughput slot, and
//      apply LARVA_MATURE_NURSE_ACCELERATION (+1) to the larva's age.
//   6. If the extra tick matures the larva, promote it (swap-remove + push to
//      workers) — mirrors the promotion logic in tickLifecycleTransitions Loop 2.
//
// Hot-path discipline (QC Pass 4 AR-P1-002):
//   - No per-tick allocations. nurseScratch is allocated once at module load
//     (Uint32Array, not serialized, not persisted).
//   - Mark-stamp pattern: currentStamp increments once per tick. Claiming a
//     nurse writes the current stamp into usedStamp[nurseId]. Checking is
//     `usedStamp[nurseId] === currentStamp`. Wraps at Uint32 max (~4 billion
//     ticks = ~6 years of sim time at 20 Hz) — safe for v3.0 timescales.
//   - No sorted temporary list. colony.larvae is iterated in its current order
//     (deterministic for a given sim state; not strictly ascending entity ID
//     post swap-remove, but still fully deterministic).
//
// Nurse adjacency definition: Manhattan distance ≤ 1 between tile positions
// (same tile or N/S/E/W neighbor). Matches Q3 DEFAULT_ACCEPTED in S4 stage doc.
//
// Throughput cap semantics: "largest contiguous Nursery chamber tile count"
// per stage doc. Two separate 12-tile Nursery chambers yield cap = 12 (one
// chamber's tiles, not 24). Building one larger Nursery is the intended
// growth lever.

import type { WorldState } from '../types.js';
import type { ColonyRecord } from './colony-store.js';
import { hasCompletedChamber, largestNurseryTileCount } from './colony-system.js';
import { AntTask, ChamberType, NursingSubState } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import {
  LARVA_MATURE_TICKS,
  LARVA_MATURE_NURSE_ACCELERATION,
  STARVATION_GRACE_TICKS,
  WORKER_BASE_SPEED,
} from '../constants.js';
import type { AntComponents } from '../ant/ant-store.js';
import { MAX_ENTITIES } from '../constants.js';

// ---------------------------------------------------------------------------
// Module-level scratch — allocated once, not serialized, not per-tick.
//
// Save/load safety: this scratch holds NO inter-tick state. Its only role is
// to track which nurses have already been claimed as accelerators within the
// current tick's backward loop. Once tickLarvaMaturation returns, all nurse
// claims are already reflected in WorldState (ants.age, ants.task, etc.) and
// the stamp values are stale. On reload from a snapshot, currentStamp resets
// to 0 and usedStamp is all-zeros; the first post-load tick increments stamp
// to 1 and correctly sees no nurses pre-claimed — identical to a fresh start.
//
// This is the same pattern used throughout ant-system.ts (Issues #67, #69) for
// hot-path scratch objects: one allocation at module load, stamp-or-fill per tick,
// never serialized, deterministic within any contiguous run or replay.
// ---------------------------------------------------------------------------

// sim-scratch: per-tick nurse bookkeeping, stamp-invalidated each pass; never serialized (object — not lint-enforced).
const nurseScratch = {
  /** Per-nurse stamp: nurseScratch.usedStamp[nurseId] === currentStamp means used this tick. */
  usedStamp: new Uint32Array(MAX_ENTITIES),
  /** Incremented once per tick before the acceleration pass. Uint32 wrap is safe. */
  currentStamp: 0,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Nurse acceleration pass for larva maturation.
 *
 * Call from tick step 7, after tickLifecycleTransitions(world, colony).
 * No-op if the colony has no completed Nursery chamber.
 */
export function tickLarvaMaturation(world: WorldState, colony: ColonyRecord): void {
  // Brood frozen = no completed Nursery. Nurses can't exist without a Nursery
  // (behavior allocator gates on hasNursery), so there's nothing to accelerate.
  if (!hasCompletedChamber(colony, ChamberType.Nursery)) return;

  const cap = largestNurseryTileCount(colony);
  if (cap <= 0) return;

  // Advance the stamp. Skip 0: usedStamp[] is zero-initialized, so stamp===0
  // would falsely treat every nurse as "used this tick" after a full Uint32
  // wrap (~4 billion ticks). `|| 1` bumps the one collision tick to 1.
  nurseScratch.currentStamp = (nurseScratch.currentStamp + 1) >>> 0 || 1;
  const stamp = nurseScratch.currentStamp;

  let slotsRemaining = cap;
  const ants = world.ants;

  // Snapshot length: only accelerate larvae that existed before this sub-step.
  // Larvae that were just promoted from eggs in Loop 1 of tickLifecycleTransitions
  // this tick are at indices >= snapLen; we skip them to avoid double-processing.
  // (They already have age=0 and can't promote anyway, but the snap is hygienic.)
  const snapLen = colony.larvae.length;

  for (let i = snapLen - 1; i >= 0; i--) {
    if (slotsRemaining <= 0) break;

    const larvaId = colony.larvae[i]!;
    if (ants.alive[larvaId] !== 1) continue; // dead larvae cleaned up at step 5
    // Newly hatched larvae (from this tick's tickLifecycleTransitions Loop 1) have
    // age=0 — Loop 2 did not process them (snapLen excluded them). Skip them to
    // preserve the "one lifecycle phase per tick" invariant.
    if (ants.age[larvaId] === 0) continue;

    const larvaTileX = ants.posX[larvaId]! >> FP_SHIFT;
    const larvaTileY = ants.posY[larvaId]! >> FP_SHIFT;

    const nurseId = findAdjacentAttendingNurse(
      ants,
      world.nextEntityId,
      colony.colonyId,
      larvaTileX,
      larvaTileY,
      nurseScratch.usedStamp,
      stamp,
    );
    if (nurseId < 0) continue; // no eligible nurse adjacent

    // Claim the nurse and consume a throughput slot.
    nurseScratch.usedStamp[nurseId] = stamp;
    slotsRemaining -= 1;

    // Apply the extra maturation tick (larva-side cap: +1 per tick max).
    const newAge = ants.age[larvaId]! + LARVA_MATURE_NURSE_ACCELERATION;
    ants.age[larvaId] = newAge;

    if (newAge >= LARVA_MATURE_TICKS) {
      // Promote larva → worker: same pattern as tickLifecycleTransitions Loop 2.
      colony.larvae[i] = colony.larvae[colony.larvae.length - 1]!;
      colony.larvae.pop();
      colony.larvaeCount -= 1;
      ants.age[larvaId] = 0;
      ants.starvationTimer[larvaId] = STARVATION_GRACE_TICKS;
      ants.task[larvaId] = AntTask.Idle;
      ants.speed[larvaId] = WORKER_BASE_SPEED;
      colony.workers.push(larvaId);
      colony.workerCount += 1;
      // If a nurse was carrying this larva (Feeding state), drop the carry.
      // The new worker keeps the carrier's last position (posX/posY were synced).
      const carrierId = ants.carriedBy[larvaId]!;
      if (carrierId !== -1) {
        if (ants.alive[carrierId] === 1 && ants.carryingBroodId[carrierId] === larvaId) {
          ants.carryingBroodId[carrierId] = -1;
          ants.task[carrierId] = AntTask.Idle;
          ants.subTask[carrierId] = 0;
          // Clear the Attending dwell counter so the future Forager search-pause
          // logic (which decrements searchPauseTicks > 0) doesn't see a stale
          // non-zero value from the mid-dwell abort.
          ants.searchPauseTicks[carrierId] = 0;
        }
        ants.carriedBy[larvaId] = -1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Find the lowest-entity-ID nurse in NursingSubState.Attending that is within
 * Manhattan distance 1 of (larvaTileX, larvaTileY) and has not yet been used
 * this tick (stamp check).
 *
 * Only Attending nurses qualify — they have already deposited their brood in
 * the Nursery and are dwelling there to accelerate development. Feeding nurses
 * (carrying brood in transit) are excluded: they may be anywhere along the
 * Queen-chamber → Nursery route, so counting them would grant acceleration
 * credit before brood is in the Nursery, and potentially to larvae that are
 * not yet in the Nursery environment.
 *
 * Returns -1 if no eligible nurse is found.
 */
function findAdjacentAttendingNurse(
  ants: AntComponents,
  entityCount: number,
  colonyId: number,
  larvaTileX: number,
  larvaTileY: number,
  usedStamp: Uint32Array,
  stamp: number,
): number {
  let bestId = -1;
  for (let j = 0; j < entityCount; j++) {
    if (ants.alive[j] !== 1) continue;
    if (ants.colonyId[j] !== colonyId) continue;
    if (ants.task[j] !== AntTask.Nursing) continue;
    if (ants.subTask[j] !== NursingSubState.Attending) continue;
    if (usedStamp[j] === stamp) continue;
    const nx = ants.posX[j]! >> FP_SHIFT;
    const ny = ants.posY[j]! >> FP_SHIFT;
    if (Math.abs(nx - larvaTileX) + Math.abs(ny - larvaTileY) > 1) continue;
    // Lowest entity ID wins (deterministic; older nurses get priority).
    if (bestId < 0 || j < bestId) bestId = j;
  }
  return bestId;
}
