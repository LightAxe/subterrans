// colony-system.ts — PRD §4c food economy, starvation, death cleanup, reconcile
//
// Implements eight exported tick-step functions:
//   withdrawFood             — chamberless food withdrawal helper (PRD §4c)
//   tickFoodConsumption      — PRD §8a steps 3 AND 4 combined (CLNY-04, CLNY-05)
//   tickStarvationCheck      — Phase 6 intentional no-op (PRD §8a step 4 slot)
//   tickDeathCleanup         — swap-remove dead entities from colony buckets (PRD §4b step 5)
//   tickReconcile            — drift-correction recount pass (PRD §2, CLNY-07)
//   checkPendingChambers     — promote fully-excavated PendingChambers to ChamberRecords (PRD §4c tick step 11)
//   checkEntranceCompletion  — enable entrance when shaft tiles are Open (PRD §5e tick step 12)
//   tickDeadDiggerCleanup    — revert BeingDug tiles of dead diggers back to Marked (tick step 5 post-pass)
//
// Key semantic invariant (PRD §4c lines 1052-1085):
//   tickFoodConsumption IS the concrete implementation of PRD §8a steps 3 AND 4.
//   Feed success/failure is evaluated inline per entity (queen first, then each live larva).
//   On success (withdrawFood returns true):  reset starvationTimer to STARVATION_GRACE_TICKS.
//   On failure (withdrawFood returns false): decrement timer by 1; kill entity when <= 0.
//   Both branches share the same if/else — the else IS step 4.
//   WORKER_FOOD_PER_TICK=0 in Phase 6 — no worker consumption loop.
//
// tickStarvationCheck is a named step slot for forward compatibility only.
// Phase 7+ may introduce non-food starvation sources (environmental hazards).
// Do NOT add an unconditional decrement — that would double-count step 4 and
// cause a fed queen to drift toward death.
//
// No Math.floor, no floats, no division operator.

import type { WorldState } from '../types.js';
import { allocateEntityId, INVALID_ENTITY_ID } from '../types.js';
import type { ChamberRecord, ColonyRecord } from './colony-store.js';
import type { ColonyId } from './colony-store.js';
import {
  QUEEN_FOOD_PER_TICK,
  LARVA_FOOD_PER_TICK,
  STARVATION_GRACE_TICKS,
  RECONCILE_INTERVAL_TICKS,
  FOOD_CHAMBER_CAPACITY,
  FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP,
  BASE_FOOD_STORAGE_CAPACITY,
} from '../constants.js';
import { ChamberType } from '../enums.js';
import { allocateWorkers } from '../behavior/allocation-system.js';
import { ugGet, ugSet, UndergroundTileState } from '../terrain.js';
import { FP_SHIFT } from '../fixed.js';

// ---------------------------------------------------------------------------
// withdrawFood / colonyFoodTotal — chamber-authoritative food withdrawal (issue #15)
//
// Pre-issue-#15 the colony had a single `foodStored` pool that `tickReconcile`
// projected across FoodStorage chambers. Foragers wrote the pool; once the
// pool exceeded one chamber's slice, the SECOND chamber appeared full at the
// next reconcile even though no ant had ever visited it. Players saw food
// "magically appear" in distant rooms.
//
// New model: chamber.foodStored is the authoritative store for each
// FoodStorage chamber. colony.foodStored persists as the entrance-shaft /
// chamberless-fallback pool — used by the Phase 6 deposit-at-entrance path
// (when no FoodStorage chamber exists, or when a forager deposits at the
// entrance shaft top per `tickForagerActions` (b)) and seeded by scenarios
// via STARTING_FOOD. Capacity contract: chambers cap at FOOD_CHAMBER_CAPACITY
// each; the entrance pool caps at BASE_FOOD_STORAGE_CAPACITY. Total capacity
// is unchanged: BASE + N × FOOD_CHAMBER_CAPACITY.
//
// Withdraw drains chambers in colony.chambers array order first, then the
// entrance pool. Order matters for determinism — never sort.
// ---------------------------------------------------------------------------

/**
 * Total stored food across the colony: entrance pool + every FoodStorage
 * chamber. Use this for HUD displays, AI thresholds, and any code that
 * previously read `colony.foodStored` as the colony total.
 *
 * Reading `colony.foodStored` directly post-#15 yields ONLY the
 * entrance-shaft pool, which is rarely what callers want.
 */
export function colonyFoodTotal(colony: ColonyRecord): number {
  let total = colony.foodStored;
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType === ChamberType.FoodStorage) total += ch.foodStored;
  }
  return total;
}

/**
 * Issue #15 follow-up — single-source-of-truth predicate for "is this chamber
 * an active deposit destination?" Used by:
 *   - chamber-flow-field BFS seeding (tick.ts step 9)
 *   - tickForagerActions step 16b deposit-site test
 *   - antDepositFood chamber match
 *   - tickAntMovement Manhattan fallback chamberTargetX selection
 *
 * Saturated (free space < FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP) chambers are
 * EXCLUDED from all four sites in lockstep. This is what prevents the
 * queen-drain-then-redeposit oscillation that pinned carriers on full-chamber
 * tiles in seed-1294596103 tick-1876 (see the constant docs).
 *
 * Non-FoodStorage chambers always return false — the loops upstream already
 * filter on chamberType, but this keeps the predicate self-contained so a
 * single misuse can't accidentally treat a Queen/Nursery chamber as a food
 * deposit target.
 */
export function isFoodChamberDepositable(chamber: ChamberRecord): boolean {
  if (chamber.chamberType !== ChamberType.FoodStorage) return false;
  return FOOD_CHAMBER_CAPACITY - chamber.foodStored >= FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP;
}

/**
 * Attempt to withdraw `amount` food. All-or-nothing: returns false (no
 * partial withdrawal) if the colony's combined stored food is below `amount`.
 *
 * Drain order is deterministic and gated on `simVersion`:
 *
 *   simVersion === LEGACY_SIM_VERSION (2): FoodStorage chambers in
 *     colony.chambers array order, then the entrance-shaft pool. Each
 *     source contributes up to its current contents. Issue #15 baseline.
 *
 *   simVersion === LATEST_SIM_VERSION (3): drain the FoodStorage chamber
 *     with the highest fill level first; on ties, lowest array index wins
 *     (matches LEGACY semantics on equal fills, so single-chamber colonies
 *     have identical behavior across versions). Then the entrance pool.
 *     Reduces flow-field re-seed thrash when many chambers cluster near
 *     saturation: drain-fullest concentrates the saturated→depositable
 *     crossing on one chamber at a time instead of cycling through several.
 *     Closes issue #27.
 *
 * Issue #15 follow-up — flow-field dirty: fires only when a chamber crosses
 * the saturation→depositable boundary (per isFoodChamberDepositable), not
 * on every cap → cap-N drain. A QUEEN_FOOD_PER_TICK=2 nibble of a full
 * chamber must NOT mark the field dirty — otherwise step 9 re-seeds the
 * still-saturated chamber every tick and carriers on its footprint pin in
 * the oscillation cycle described in the FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP
 * constant docs.
 */
export function withdrawFood(
  colony: ColonyRecord,
  amount: number,
  simVersion: number,
): boolean {
  if (colonyFoodTotal(colony) < amount) return false;

  let remaining = amount;
  if (simVersion >= 3) {
    // LATEST: drain fullest-first, array-index tie-break. Outer `while`
    // re-scans on each iteration; in steady state both production callers
    // (queen 2 fp, larva 1 fp) terminate after iteration 1 because the
    // fullest chamber holds far more than the drain amount. Theoretical
    // worst case (tiny dribbles across many chambers) is O(N²) but does
    // not arise in any current call path. If a future caller drains an
    // amount that may exceed several chambers' holdings, replace this
    // with a single-pass merge over a pre-sorted view.
    while (remaining > 0) {
      let pickIdx = -1;
      let pickFill = -1;
      for (let i = 0; i < colony.chambers.length; i++) {
        const ch = colony.chambers[i]!;
        if (ch.chamberType !== ChamberType.FoodStorage) continue;
        if (ch.foodStored <= 0) continue;
        if (ch.foodStored > pickFill) {
          pickFill = ch.foodStored;
          pickIdx = i;
        }
      }
      if (pickIdx < 0) break; // no chamber has food

      const ch = colony.chambers[pickIdx]!;
      const wasDepositable = isFoodChamberDepositable(ch);
      const take = ch.foodStored < remaining ? ch.foodStored : remaining;
      ch.foodStored -= take;
      remaining -= take;
      // `wasDepositable` is recomputed each outer iteration; the dirty
      // fire is naturally idempotent across the saturation crossing —
      // once a chamber is depositable, subsequent picks that still drain
      // it observe wasDepositable=true and skip the dirty write.
      if (!wasDepositable && isFoodChamberDepositable(ch)) {
        colony.foodFlowFieldDirty = true;
      }
    }
  } else {
    // LEGACY (simVersion <= 2): array-order drain — issue #15 baseline.
    // Replays of pre-#27 saves continue to use this path verbatim.
    for (let i = 0; i < colony.chambers.length && remaining > 0; i++) {
      const ch = colony.chambers[i]!;
      if (ch.chamberType !== ChamberType.FoodStorage) continue;
      if (ch.foodStored <= 0) continue;
      const wasDepositable = isFoodChamberDepositable(ch);
      const take = ch.foodStored < remaining ? ch.foodStored : remaining;
      ch.foodStored -= take;
      remaining -= take;
      if (!wasDepositable && isFoodChamberDepositable(ch)) {
        colony.foodFlowFieldDirty = true;
      }
    }
  }

  if (remaining > 0) {
    colony.foodStored -= remaining;
  }
  return true;
}

// ---------------------------------------------------------------------------
// colonyFoodCapacity — 09 backlog memo: BASE + N × FOOD_CHAMBER_CAPACITY
//
// Returns the colony's TOTAL food-storage capacity (entrance pool + every
// FoodStorage chamber). Compare against `colonyFoodTotal(colony)`, not
// `colony.foodStored` alone — post-#15, `colony.foodStored` caps at BASE
// (the entrance pool only) while each FoodStorage chamber caps at
// FOOD_CHAMBER_CAPACITY. N counts only COMPLETED FoodStorage chambers
// (entries in colony.chambers). Pending FoodStorage chambers do NOT
// contribute — capacity grows only when the chamber is fully excavated
// and promoted by checkPendingChambers.
// ---------------------------------------------------------------------------

/**
 * Total colony food-storage capacity (fp): BASE + N × FOOD_CHAMBER_CAPACITY,
 * where N is the number of completed FoodStorage chambers in colony.chambers.
 * Post-#15 this is the cap for `colonyFoodTotal(colony)` (pool + chambers),
 * not for `colony.foodStored` (which caps at BASE alone).
 *
 * Pending FoodStorage chambers (world.pendingChambers) do NOT contribute —
 * promotion happens in checkPendingChambers once excavation completes.
 */
export function colonyFoodCapacity(colony: ColonyRecord): number {
  let n = 0;
  for (let i = 0; i < colony.chambers.length; i++) {
    if (colony.chambers[i]!.chamberType === ChamberType.FoodStorage) n += 1;
  }
  return BASE_FOOD_STORAGE_CAPACITY + n * FOOD_CHAMBER_CAPACITY;
}

// ---------------------------------------------------------------------------
// hasCompletedChamber — generic "colony has chamber of this type" query.
//
// Used by the 09 reproduction-gate memo to require Queen + Nursery chambers
// before the queen lays eggs and before any worker is assigned to Nursing.
// Pending (un-excavated) chambers do NOT count — only fully-promoted entries
// in colony.chambers, matching the single-path chamber-creation invariant
// in checkPendingChambers.
// ---------------------------------------------------------------------------

/**
 * True if `colony` owns at least one COMPLETED chamber of `chamberType`.
 * Pending chambers (world.pendingChambers) are ignored — capacity/feature
 * unlocks only trigger once excavation finishes and checkPendingChambers
 * promotes the pending record into colony.chambers.
 */
export function hasCompletedChamber(
  colony: ColonyRecord,
  chamberType: ChamberType,
): boolean {
  for (let i = 0; i < colony.chambers.length; i++) {
    if (colony.chambers[i]!.chamberType === chamberType) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// tickFoodConsumption — PRD §8a steps 3 AND 4 combined (CLNY-04, CLNY-05)
//
// This IS the concrete implementation of steps 3 and 4 evaluated inline per entity.
// Step 3 (reset-on-feed):    withdrawFood success → reset starvationTimer to STARVATION_GRACE_TICKS
// Step 4 (decrement-on-fail): withdrawFood failure → decrement timer; kill entity at <= 0
//
// Queen processed first (CLNY-04); larvae processed in order (CLNY-05).
// Workers: WORKER_FOOD_PER_TICK=0 in Phase 6 → skipped entirely.
// ---------------------------------------------------------------------------

/**
 * Feed queen and each live larva from the colony food pool.
 *
 * PRD §4c lines 1052-1085 verbatim implementation.
 *
 * Queen first (CLNY-04): on success reset queenStarvationTimer to STARVATION_GRACE_TICKS;
 * on failure decrement queenStarvationTimer and kill queen when <= 0.
 *
 * Each live larva (CLNY-05): same per-entity contract using ants.starvationTimer[id].
 *
 * Workers: WORKER_FOOD_PER_TICK=0 → no worker loop (Phase 6 scope; Phase 7+ may add one).
 */
export function tickFoodConsumption(world: WorldState, colony: ColonyRecord): void {
  const ants = world.ants;

  // Issue #27 — drain order varies by sim version (see withdrawFood JSDoc);
  // capture once so both queen and larva loops use a consistent value for
  // the entire tick (defensive — `world.simVersion` is sticky on load and
  // can't change mid-tick, but pulling it once costs nothing and keeps the
  // intent local).
  const simVersion = world.simVersion;

  // Queen (CLNY-04) — reset on success, decrement + death-check on fail.
  const queenId = colony.queenEntityId;
  if (ants.alive[queenId] === 1) {
    if (withdrawFood(colony, QUEEN_FOOD_PER_TICK, simVersion)) {
      colony.queenStarvationTimer = STARVATION_GRACE_TICKS;
    } else {
      colony.queenStarvationTimer -= 1;
      if (colony.queenStarvationTimer <= 0) {
        ants.alive[queenId] = 0;
      }
    }
  }

  // Larvae (CLNY-05) — same per-entity contract.
  for (let i = 0; i < colony.larvae.length; i++) {
    const id = colony.larvae[i]!;
    if (ants.alive[id] !== 1) continue;
    if (withdrawFood(colony, LARVA_FOOD_PER_TICK, simVersion)) {
      ants.starvationTimer[id] = STARVATION_GRACE_TICKS;
    } else {
      // Non-null assertion: id is a valid entity index, bounds verified by colony.larvae membership.
      const timer = ants.starvationTimer[id]! - 1;
      ants.starvationTimer[id] = timer;
      if (timer <= 0) {
        ants.alive[id] = 0;
      }
    }
  }

  // Workers: WORKER_FOOD_PER_TICK === 0 in Phase 6 → skip.
  // Phase 7+ adds worker consumption here, identical pattern to the larva loop above.
}

// ---------------------------------------------------------------------------
// tickStarvationCheck — Phase 6 intentional no-op (PRD §8a step 4 slot)
//
// PRD §8a step 4's decrement-on-fail + death check is executed inline inside
// tickFoodConsumption's else-branch. This function is therefore a no-op in Phase 6.
// The function is kept in the dispatcher as a named step slot for forward compatibility
// (Phase 7+ may introduce non-food starvation sources such as environmental hazards).
// ---------------------------------------------------------------------------

/**
 * Phase 6 no-op — PRD §8a step 4 (decrement-on-fail + death check) is executed
 * inline inside tickFoodConsumption's else-branch (PRD §4c, lines 1052-1085).
 *
 * Do NOT add an unconditional decrement here — that would double-count step 4
 * and cause a fed queen to drift toward death (regression of PRD semantics).
 *
 * Phase 7+ may introduce non-food starvation sources here (environmental hazards).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function tickStarvationCheck(_world: WorldState, _colony: ColonyRecord): void {
  // Intentionally empty in Phase 6. tickFoodConsumption IS the concrete implementation
  // of PRD §8a steps 3 AND 4, evaluated inline per entity (see PRD §4c, lines 1052-1085).
}

// ---------------------------------------------------------------------------
// tickDeathCleanup — swap-remove dead entities from colony buckets (PRD §4b step 5)
//
// Backwards iteration ensures swap-remove does not skip indices when multiple
// consecutive dead entities are encountered (PRD §4b line 388 pattern).
// Updates cached eggCount, larvaeCount, workerCount after removal.
// Sets colony.defeated = true when queen is dead (CLNY-08, CMBT-06 read-through).
// ---------------------------------------------------------------------------

/**
 * Remove dead entities from colony.eggs, colony.larvae, colony.workers via swap-remove.
 *
 * Backwards iteration prevents index-skip on consecutive dead entities.
 * Updates cached count fields (eggCount, larvaeCount, workerCount) after each removal.
 * Sets colony.defeated = true if queen entity has alive === 0 (CLNY-08).
 */
export function tickDeathCleanup(world: WorldState, colony: ColonyRecord): void {
  const ants = world.ants;

  // Eggs
  for (let i = colony.eggs.length - 1; i >= 0; i--) {
    if (ants.alive[colony.eggs[i]!] === 0) {
      colony.eggs[i] = colony.eggs[colony.eggs.length - 1]!;
      colony.eggs.pop();
      colony.eggCount -= 1;
    }
  }

  // Larvae
  for (let i = colony.larvae.length - 1; i >= 0; i--) {
    if (ants.alive[colony.larvae[i]!] === 0) {
      colony.larvae[i] = colony.larvae[colony.larvae.length - 1]!;
      colony.larvae.pop();
      colony.larvaeCount -= 1;
    }
  }

  // Workers
  for (let i = colony.workers.length - 1; i >= 0; i--) {
    if (ants.alive[colony.workers[i]!] === 0) {
      colony.workers[i] = colony.workers[colony.workers.length - 1]!;
      colony.workers.pop();
      colony.workerCount -= 1;
    }
  }

  // Defeated flag — set when queen is dead (CLNY-08, CMBT-06 read-through)
  if (ants.alive[colony.queenEntityId] === 0) {
    colony.defeated = true;
  }
}

// ---------------------------------------------------------------------------
// tickReconcile — drift-correction recount pass (PRD §2, CLNY-07)
//
// Decrements reconcileCountdown each tick. When it reaches 0, performs a
// full recount of alive entities in each bucket, correcting any drift between
// cached count fields (eggCount, larvaeCount, workerCount) and actual bucket
// contents. Resets reconcileCountdown to RECONCILE_INTERVAL_TICKS after the pass.
// ---------------------------------------------------------------------------

/**
 * Decrement reconcileCountdown; when it reaches 0, recount all colony buckets.
 *
 * The recount pass (PRD §2) filters alive===1 entities in each bucket and
 * corrects eggCount, larvaeCount, workerCount. Doubles as a cleanup pass —
 * dead slots found during recount are swap-removed from the bucket.
 * Issue #15: also clamps `colony.foodStored` to [0, BASE_FOOD_STORAGE_CAPACITY]
 * and each FoodStorage chamber's `foodStored` to [0, FOOD_CHAMBER_CAPACITY] —
 * defensive only; the deposit/withdraw paths cap at their own sources.
 * NEVER redistributes food across chambers (that was the pre-#15 magic-fill bug).
 * Resets reconcileCountdown to RECONCILE_INTERVAL_TICKS after recount.
 *
 * CLNY-07: cached fields are guaranteed accurate at most RECONCILE_INTERVAL_TICKS
 * ticks after the last recount. Plan 10's taskCensus write also benefits from
 * this drift correction.
 */
export function tickReconcile(world: WorldState, colony: ColonyRecord): void {
  colony.reconcileCountdown -= 1;
  if (colony.reconcileCountdown > 0) return;

  const ants = world.ants;

  // Recount eggs (filtering dead — also doubles as a cleanup pass)
  let eggCount = 0;
  for (let i = colony.eggs.length - 1; i >= 0; i--) {
    if (ants.alive[colony.eggs[i]!] === 1) {
      eggCount += 1;
    } else {
      colony.eggs[i] = colony.eggs[colony.eggs.length - 1]!;
      colony.eggs.pop();
    }
  }
  colony.eggCount = eggCount;

  // Recount larvae
  let larvaeCount = 0;
  for (let i = colony.larvae.length - 1; i >= 0; i--) {
    if (ants.alive[colony.larvae[i]!] === 1) {
      larvaeCount += 1;
    } else {
      colony.larvae[i] = colony.larvae[colony.larvae.length - 1]!;
      colony.larvae.pop();
    }
  }
  colony.larvaeCount = larvaeCount;

  // Recount workers
  let workerCount = 0;
  for (let i = colony.workers.length - 1; i >= 0; i--) {
    if (ants.alive[colony.workers[i]!] === 1) {
      workerCount += 1;
    } else {
      colony.workers[i] = colony.workers[colony.workers.length - 1]!;
      colony.workers.pop();
    }
  }
  colony.workerCount = workerCount;

  // Food validation (issue #15 — chamber-authoritative model):
  // chamber.foodStored is authoritative per FoodStorage chamber; colony.foodStored
  // is the entrance-shaft fallback pool. Deposits + withdraws clamp at their
  // sources, so reconcile is a defensive backstop against drift. NEVER redistribute
  // across chambers — that was the old magic-fill bug fixed in #15.
  if (colony.foodStored < 0) colony.foodStored = 0;
  if (colony.foodStored > BASE_FOOD_STORAGE_CAPACITY) {
    colony.foodStored = BASE_FOOD_STORAGE_CAPACITY;
  }
  for (let i = 0; i < colony.chambers.length; i++) {
    const ch = colony.chambers[i]!;
    if (ch.chamberType !== ChamberType.FoodStorage) continue;
    if (ch.foodStored < 0) ch.foodStored = 0;
    if (ch.foodStored > FOOD_CHAMBER_CAPACITY) ch.foodStored = FOOD_CHAMBER_CAPACITY;
  }

  // Recompute allocation with corrected counts (PRD §2 reconcile contract +
  // 09 reproduction-gate memo: nursing requires a completed Nursery chamber).
  const brood = colony.eggCount + colony.larvaeCount;
  const hasNursery = hasCompletedChamber(colony, ChamberType.Nursery);
  const alloc = allocateWorkers(colony.workerCount, brood, colony.targetRatio, hasNursery);
  colony.computedAllocation.nurse  = alloc.nurse;
  colony.computedAllocation.forage = alloc.forage;
  colony.computedAllocation.dig    = alloc.dig;
  colony.computedAllocation.fight  = alloc.fight;
  colony.nurseCount = alloc.nurse;

  colony.reconcileCountdown = RECONCILE_INTERVAL_TICKS;
}

// ---------------------------------------------------------------------------
// checkPendingChambers — promote fully-excavated PendingChambers (PRD §4c tick step 11)
//
// Iterates world.pendingChambers Record. For each PendingChamber, checks whether
// ALL footprint tiles in the colony's underground grid are Open. If yes, creates
// a ChamberRecord in colony.chambers and deletes the entry from pendingChambers.
// If no, leaves the PendingChamber for the next tick.
//
// This is the ONLY place ChamberRecord is created (two-phase invariant, T-07-06).
// posX/posY are fixed-point (anchorTileX/Y << FP_SHIFT) per Phase 2 PRD ChamberRecord contract.
// ---------------------------------------------------------------------------

/**
 * For each PendingChamber in the Record, check if ALL footprint tiles in the colony's
 * underground grid are Open. If yes: create a ChamberRecord in colony.chambers,
 * delete from world.pendingChambers. If no: leave the PendingChamber for next tick.
 *
 * pendingChambers is Record<string, PendingChamber> keyed by `${colonyId}:${anchorTileX}:${anchorTileY}`.
 */
export function checkPendingChambers(world: WorldState): void {
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    const pc = world.pendingChambers[key]!;
    // Plan 09.1-00: `currentGridColonyId` not applicable here — a pending
    // chamber record belongs to its own colony by construction (the record's
    // `colonyId` IS the chamber's home grid). No ant-level grid-of-occupancy
    // lookup required.
    const underground = world.undergroundGrids[pc.colonyId];
    if (!underground) continue;

    // Check all footprint tiles
    let allOpen = true;
    for (let dy = 0; dy < pc.height && allOpen; dy++) {
      for (let dx = 0; dx < pc.width && allOpen; dx++) {
        if (ugGet(underground, pc.anchorTileX + dx, pc.anchorTileY + dy) !== UndergroundTileState.Open) {
          allOpen = false;
        }
      }
    }

    if (allOpen) {
      const colony = world.colonies[pc.colonyId];
      if (!colony) continue;

      // Issue #59 — bail on entity-id cap. Chamber creation is bounded in
      // practice (low chamber count per colony), so reaching this with the
      // counter at MAX_ENTITIES means the world is structurally saturated.
      // Leaving the PendingChamber in place lets it complete on a later
      // tick when entity-id space frees up (same as if the dig hadn't
      // finished). Worst case the player sees their excavated chamber not
      // commit — degraded but consistent, not corrupted.
      const chamberId = allocateEntityId(world);
      if (chamberId === INVALID_ENTITY_ID) continue;

      // Create ChamberRecord — the ONLY place ChamberRecord is created (two-phase invariant)
      // posX/posY are FIXED-POINT per Phase 2 PRD ChamberRecord contract (FP_SHIFT=8)
      colony.chambers.push({
        chamberId,
        chamberType: pc.chamberType,
        foodStored:  0,
        posX:        pc.anchorTileX << FP_SHIFT,
        posY:        pc.anchorTileY << FP_SHIFT,
        width:       pc.width,
        height:      pc.height,
      });

      // Remove PendingChamber by key (safe during for-in iteration — delete is allowed)
      delete world.pendingChambers[key];
    }
  }
}

// ---------------------------------------------------------------------------
// checkEntranceCompletion — detect open shafts and enable entrances (PRD §5e tick step 12)
//
// For each colony entrance that is not yet open, checks shaft tiles
// (tileY=0 and tileY=1 at the entrance's surfaceTileX). If both are Open,
// sets entrance.isOpen = true.
// ---------------------------------------------------------------------------

/**
 * For each colony entrance that is not yet open, check if the shaft tiles
 * (tileY=0 and tileY=1 at the entrance's surfaceTileX) are both Open.
 * If yes: set entrance.isOpen = true.
 *
 * colony.entrances is a typed required field on ColonyRecord (Plan 03 Task 1,
 * accepted Phase 3 PRD schema) — always present, default [].
 */
export function checkEntranceCompletion(world: WorldState): void {
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as ColonyId]!;
    // Plan 09.1-00: `currentGridColonyId` not applicable here — entrances
    // belong to the iterated colony by construction (we are checking THIS
    // colony's entrances against THIS colony's grid). No ant-level
    // grid-of-occupancy lookup required.
    const underground = world.undergroundGrids[colony.colonyId];
    if (!underground) continue;

    for (const entrance of colony.entrances) {
      if (entrance.isOpen) continue;
      // Check shaft tiles: tileY=0 and tileY=1 at entrance.surfaceTileX
      const shaftX = entrance.surfaceTileX;
      const allShaftOpen =
        ugGet(underground, shaftX, 0) === UndergroundTileState.Open &&
        ugGet(underground, shaftX, 1) === UndergroundTileState.Open;
      if (allShaftOpen) {
        entrance.isOpen = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tickDeadDiggerCleanup — revert dead digger BeingDug tiles to Marked (tick step 5 post-pass)
//
// Global pass (not per-colony) — runs after the per-colony tickDeathCleanup loop.
// Reverts BeingDug tiles claimed by dead diggers back to Marked so other diggers
// can claim them. Sets colony.digFlowFieldDirty when a tile is reverted.
//
// The existing tickDeathCleanup(world, colony) is UNCHANGED — it remains the
// per-colony entity list cleanup function (PRD §4b step 5).
// ---------------------------------------------------------------------------

/**
 * Revert BeingDug tiles owned by dead diggers back to Marked.
 * Global pass (not per-colony) — runs after per-colony tickDeathCleanup loop in tick step 5.
 * This allows other diggers to claim the abandoned tile. Sets digFlowFieldDirty.
 */
export function tickDeadDiggerCleanup(world: WorldState): void {
  for (let id = 0; id < world.ants.alive.length; id++) {
    if (world.ants.alive[id] !== 0) continue; // only process dead ants
    const dtx = world.ants.digTileX[id]!;
    const dty = world.ants.digTileY[id]!;
    if (dtx === -1 || dty === -1) continue; // no claimed tile
    // Plan 09.1-00 — LATENT RISK (Research Risk E): this site uses the dead
    // ant's owning colony (`ants.colonyId`) rather than its grid-of-occupancy
    // (`ants.currentGridColonyId`). Byte-identical today because only diggers
    // reach this path and diggers currently dig only inside their own colony's
    // grid. IF FUTURE INVASION EXTENDS TO DIGGERS (cross-grid digging), switch
    // this read to `ants.currentGridColonyId[id]` so the stale BeingDug tile
    // is cleared in the grid where the dig was actually claimed.
    const cid = world.ants.colonyId[id]! as ColonyId;
    const ug = world.undergroundGrids[cid];
    if (!ug) continue;
    if (ugGet(ug, dtx, dty) === UndergroundTileState.BeingDug) {
      ugSet(ug, dtx, dty, UndergroundTileState.Marked);
      world.colonies[cid]!.digFlowFieldDirty = true;   // typed field (Plan 03 Task 1)
    }
    // Clear the dead ant's dig claim
    world.ants.digTileX[id] = -1;
    world.ants.digTileY[id] = -1;
    world.ants.digTicksRemaining[id] = 0;
  }
}
