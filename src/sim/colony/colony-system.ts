// colony-system.ts — PRD §4c food economy, starvation, death cleanup, reconcile
//
// Implements seven exported tick-step functions:
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
import {
  allocateEntityId,
  INVALID_ENTITY_ID,
  SIM_VERSION_V40_SMALL_COLONY_SURVIVAL,
} from '../types.js';
import type { ColonyRecord } from './colony-store.js';
import type { ColonyId } from './colony-store.js';
import {
  QUEEN_FOOD_PER_TICK,
  LARVA_FOOD_PER_TICK,
  STARVATION_GRACE_TICKS,
  RECONCILE_INTERVAL_TICKS,
  NURSE_MIN_WORKERS,
} from '../constants.js';
import { clampColonyFoodStores, createChamberStock, withdrawFood } from '../food/food-api.js';
import { ChamberType } from '../enums.js';
import { allocateWorkers } from '../behavior/allocation-system.js';
import { ugGet, ugSet, UndergroundTileState } from '../terrain.js';
import { findEmbeddedByTightening } from '../underground-occupancy.js';
import { FP_SHIFT } from '../fixed.js';
import { despawnAnt } from '../ant-death.js';

// Food storage (the entrance pool, FoodStorage chamber stock and the surface
// piles) lives behind the food facade, `../food/food-api.ts`: `withdrawFood`,
// `colonyFoodTotal`, `colonyFoodCapacity`, `isFoodChamberDepositable`,
// `colonyHasNoDepositTarget` and `colonyForageBackpressure` moved there (#290
// PR 1). This module calls it for the queen/larva draw, the reconcile clamp and
// chamber-stock creation.

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
export function hasCompletedChamber(colony: ColonyRecord, chamberType: ChamberType): boolean {
  for (let i = 0; i < colony.chambers.length; i++) {
    if (colony.chambers[i]!.chamberType === chamberType) return true;
  }
  return false;
}

/**
 * S4 — Returns the tile count of the largest completed Nursery chamber in the
 * colony. This is the throughput cap for nurse-acceleration per tick: at most
 * N larvae can receive nurse acceleration per tick, where N = this value.
 *
 * Returns 0 if no completed Nursery chamber exists (broodFrozen should gate
 * the caller before this case is reached in normal play).
 */
export function largestNurseryTileCount(colony: ColonyRecord): number {
  let max = 0;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Nursery) continue;
    const tiles = ch.width * ch.height;
    if (tiles > max) max = tiles;
  }
  return max;
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
 * V40 (#299) — the living-worker floor for the nurse carve-out, by simVersion.
 * Pre-V40 worlds pass 0 (no floor), so their allocation is byte-identical.
 */
export function nurseMinWorkersFor(world: WorldState): number {
  return world.simVersion >= SIM_VERSION_V40_SMALL_COLONY_SURVIVAL ? NURSE_MIN_WORKERS : 0;
}

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

  // Queen (CLNY-04) — reset on success, decrement + death-check on fail.
  const queenId = colony.queenEntityId;
  if (ants.alive[queenId] === 1) {
    if (withdrawFood(world, colony, QUEEN_FOOD_PER_TICK)) {
      colony.queenStarvationTimer = STARVATION_GRACE_TICKS;
    } else {
      colony.queenStarvationTimer -= 1;
      if (colony.queenStarvationTimer <= 0) {
        despawnAnt(world, queenId, { cause: 'starvation' });
      }
    }
  }

  // Larvae (CLNY-05) — same per-entity contract.
  for (let i = 0; i < colony.larvae.length; i++) {
    const id = colony.larvae[i]!;
    if (ants.alive[id] !== 1) continue;
    if (withdrawFood(world, colony, LARVA_FOOD_PER_TICK)) {
      ants.starvationTimer[id] = STARVATION_GRACE_TICKS;
    } else {
      // Non-null assertion: id is a valid entity index, bounds verified by colony.larvae membership.
      const timer = ants.starvationTimer[id]! - 1;
      ants.starvationTimer[id] = timer;
      if (timer <= 0) {
        despawnAnt(world, id, { cause: 'starvation' }); // #235 broodFieldDirty is set inside
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
// ---------------------------------------------------------------------------

/**
 * Remove dead entities from colony.eggs, colony.larvae, colony.workers via swap-remove.
 *
 * Backwards iteration prevents index-skip on consecutive dead entities.
 * Updates cached count fields (eggCount, larvaeCount, workerCount) after each removal.
 * colony.defeated is set by checkQueenDeath (step 18) — NOT here — so the queen_death
 * event is emitted before the flag is set. (Starvation kills the queen at step 3;
 * setting defeated at step 5 caused checkQueenDeath to skip event emission.)
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
 * Issue #15: also clamps the entrance pool to [0, BASE_FOOD_STORAGE_CAPACITY]
 * and each FoodStorage chamber's stock to [0, FOOD_CHAMBER_CAPACITY]
 * (`clampColonyFoodStores`) — defensive only; deposit/withdraw cap at their sources.
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

  // Food validation (issue #15 — chamber-authoritative model): a defensive clamp
  // of the pool and each FoodStorage chamber's stock. Deposits + withdraws cap at
  // their sources; this never redistributes across chambers (the #15 magic-fill bug).
  clampColonyFoodStores(world, colony);

  // Recompute allocation with corrected counts (PRD §2 reconcile contract +
  // 09 reproduction-gate memo: nursing requires a completed Nursery chamber).
  const brood = colony.eggCount + colony.larvaeCount;
  const hasNursery = hasCompletedChamber(colony, ChamberType.Nursery);
  const alloc = allocateWorkers(
    colony.workerCount,
    brood,
    colony.targetRatio,
    hasNursery,
    nurseMinWorkersFor(world),
  );
  colony.computedAllocation.nurse = alloc.nurse;
  colony.computedAllocation.forage = alloc.forage;
  colony.computedAllocation.dig = alloc.dig;
  colony.computedAllocation.fight = alloc.fight;
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
        if (
          ugGet(underground, pc.anchorTileX + dx, pc.anchorTileY + dy) !== UndergroundTileState.Open
        ) {
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
        foodStored: 0,
        posX: pc.anchorTileX << FP_SHIFT,
        posY: pc.anchorTileY << FP_SHIFT,
        width: pc.width,
        height: pc.height,
      });
      createChamberStock(world, colony, colony.chambers[colony.chambers.length - 1]!);
      // #235 — a new chamber changes the pickup/deposit field seed sets (a Nursery
      // enters the deposit seeds + pickup's inside-Nursery exclusion). The normal
      // dug-to-completion path is covered by the completing tile-flip's
      // digFlowFieldDirty, but a PlaceChamber over an ALREADY-Open footprint marks
      // zero tiles, so step-9 (step 8) already consumed digFlowFieldDirty before this
      // step-11 promotion — nothing would recompute. Flag here so step 9 rebuilds
      // next tick (matches the pre-#235 every-tick second loop). Set only
      // broodFieldDirty (not digFlowFieldDirty): pre-#235 the first-loop chamber
      // fields were likewise NOT healed on the all-Open path, so keep byte-identical.
      colony.broodFieldDirty = true;

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
    const cid = world.ants.colonyId[id]!;
    const ug = world.undergroundGrids[cid];
    if (!ug) continue;
    if (ugGet(ug, dtx, dty) === UndergroundTileState.BeingDug) {
      // PR 6-sim (V30, #128 class-iv) — occupancy guard. Reverting BeingDug→Marked
      // embeds a non-digger standing on the tile (Marked is non-passable for
      // them). If such an occupant is present, RETAIN the dead ant's claim and
      // skip the revert this tick — retry on a later tick once the occupant moves.
      // Retaining (rather than blocking + clearing the claim) is mandatory: the
      // claim is the only owner of this BeingDug tile, so clearing it while
      // blocking would ORPHAN the tile as BeingDug forever (R2-8). A digger
      // occupant does NOT block (Marked is passable for diggers).
      //
      // LIVENESS BOUND: retain+retry assumes the occupant eventually leaves. Every
      // current underground task does move off a passable BeingDug tile — diggers
      // dig elsewhere, foragers/carriers route to food/entrance, and idle ants are
      // reassigned by the step-10a allocation pass — so the deferral resolves in a
      // bounded number of ticks. Entity ids are monotonic (never reused), so the
      // dead claim is never aliased by reallocation while it waits. A hypothetical
      // permanently-stationary non-digger parked on the tile is the only soft-lock,
      // and no current task produces one; if one is ever added, switch this to the
      // spec's displace-the-occupant-then-revert alternative (R2-8).
      if (findEmbeddedByTightening(world, cid, dtx, dty, UndergroundTileState.Marked) !== -1) {
        continue; // retain claim (digTileX/Y/Remaining untouched); retry next tick
      }
      ugSet(ug, dtx, dty, UndergroundTileState.Marked);
      world.colonies[cid]!.digFlowFieldDirty = true; // typed field (Plan 03 Task 1)
    }
    // Clear the dead ant's dig claim
    world.ants.digTileX[id] = -1;
    world.ants.digTileY[id] = -1;
    world.ants.digTicksRemaining[id] = 0;
  }
}
