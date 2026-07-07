// src/sim/ant/ant-nursing.ts
// #212 Layer 1 (behavior): nurse actions + brood/nursery placement. tickNurseActions
// is a tick.ts step; the brood helpers are internal. Depends only on Layer-0
// ant-motion (+ sibling sim modules); no other behavior module depends on it.
import { hasReachableNonFullNursery, type ChamberFlowFields } from '../chamber-flow.js';
import type { ChamberRecord, ColonyRecord } from '../colony/colony-store.js';
import { colonyFoodTotal, hasCompletedChamber } from '../colony/colony-system.js';
import { NURSE_ATTEND_DWELL_TICKS } from '../constants.js';
import { AntTask, ChamberType, NursingSubState } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import { UndergroundTileState, Zone, type UndergroundGrid, ugGet } from '../terrain.js';
import { SIM_VERSION_V24_NURSERY_CAPACITY, type WorldState } from '../types.js';
import { isInsideQueenChamber } from './ant-motion.js';
import { isBroodReclaimable, type AntComponents } from './ant-store.js';

/**
 * Finalize nursing: on arrival at a Queen/Nursery chamber, perform a one-tick
 * service (MovingToBrood → Feeding) and then return the ant to Idle so step
 * 10a can reassign it next tick per the current allocation.
 *
 * Only acts on ants with alive=1 AND task=Nursing. Ignores any other task.
 *
 * @param world  WorldState (reads ants, colonies; writes ants.task, ants.subTask).
 */
export function tickNurseActions(world: WorldState, chamberFlowFields?: ChamberFlowFields): void {
  const ants = world.ants;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Nursing) continue;

    const subTask = ants.subTask[id]!;

    // -----------------------------------------------------------------
    // Issue #17 Phase 1 (v10+): visible brood carry.
    //
    // Substate semantics under v10:
    //   MovingToBrood (0) — heading toward a brood pickup tile via the
    //     `nursing` chamber-flow field (re-seeded each tick from Queen
    //     Open tiles AND uncarried-brood-entity tiles outside Nursery).
    //     On arrival at a tile that holds an alive uncarried brood,
    //     claim it: set carryingBroodId/carriedBy, flip to Feeding.
    //   Feeding (1) — "carrying brood." The carrier syncs the brood's
    //     position to its own each tick (so the renderer just draws the
    //     brood at its own posX/posY). Movement step routes via
    //     `nurseDeposit` (Nursery-only flow-field). On arrival at a
    //     Nursery Open tile, deposit the brood and return to Idle.
    // -----------------------------------------------------------------
    if (subTask === NursingSubState.Feeding) {
      const broodId = ants.carryingBroodId[id]!;
      if (broodId === -1) {
        // Defensive guard — Feeding without a carry slot is unreachable
        // under normal v10 flow (pickup always sets the slot). If we
        // hit it (state corruption, manual mutation), release back to
        // Idle so the nurse doesn't strand.
        ants.task[id] = AntTask.Idle;
        ants.subTask[id] = 0;
        continue;
      }
      // Brood died mid-carry (combat, starvation, etc.). Drop the carry
      // and return to Idle. The dead brood will be swap-removed from
      // colony.eggs/larvae at step 5 (tickDeathCleanup) on the next tick.
      if (ants.alive[broodId] !== 1) {
        ants.carryingBroodId[id] = -1;
        // carriedBy[broodId] is left as-is — the brood is dead and will
        // be swap-removed from colony.eggs/larvae at the next step 5
        // tickDeathCleanup. Entity ids are not recycled (PRD §3), so
        // the stale carriedBy is harmless.
        ants.task[id] = AntTask.Idle;
        ants.subTask[id] = 0;
        continue;
      }
      // Sync brood position to carrier (every tick — the renderer reads
      // posX/posY directly).
      ants.posX[broodId] = ants.posX[id]!;
      ants.posY[broodId] = ants.posY[id]!;
      ants.zone[broodId] = ants.zone[id]!;
      ants.currentGridColonyId[broodId] = ants.currentGridColonyId[id]!;
      // Check for Nursery-tile arrival → deposit.
      const colonyId = ants.colonyId[id]!;
      const colony = world.colonies[colonyId];
      if (!colony) continue;
      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      // Issue #173 (V24+): deposit only when the carrier is AT REST on a
      // deposit-field source tile (-1) — its routed Nursery target. The
      // capacity-aware nurseDeposit field marks a Nursery's tiles as a source
      // only when that Nursery is the carrier's actual destination (a reachable
      // non-full Nursery, or — when none is reachable — the fallback Nursery).
      // A carrier merely TRANSITING a full Nursery toward a non-full one sits on
      // a step tile (0..3), so it keeps moving instead of overflowing the full
      // Nursery. Pre-V24 — or when no field is supplied (unit tests that drive
      // tickNurseActions directly) — keeps the original isInsideNursery deposit.
      let shouldDeposit: boolean;
      if (world.simVersion >= SIM_VERSION_V24_NURSERY_CAPACITY && chamberFlowFields !== undefined) {
        const field = chamberFlowFields.nurseDeposit[colonyId];
        const underground = world.undergroundGrids[colonyId];
        shouldDeposit =
          field !== undefined &&
          underground !== undefined &&
          field[tileY * underground.width + tileX] === -1;
      } else {
        shouldDeposit = isInsideNursery(colony, tileX, tileY);
      }
      if (shouldDeposit) {
        depositCarriedBrood(world, colony, id, broodId, colonyId, chamberFlowFields);
      }
      continue;
    }
    // S4 V21+ Attending handler: nurse dwells at the Nursery tile after
    // deposit. searchPauseTicks is repurposed as the dwell counter — it is
    // not used by nursing-task ants (search-pause logic only runs for
    // Foraging ants). When the dwell expires, nurse returns to Idle.
    //
    // Emergency exit: colony food zero → nurse must forage to prevent
    // starvation lock. Pairs with the step-8 allocation override in
    // tick.ts. Brood-transport priority is enforced at deposit time
    // (depositCarriedBrood skips Attending when claimable brood remains),
    // so no per-tick brood check is needed here.
    if (subTask === NursingSubState.Attending) {
      const colonyId = ants.colonyId[id]!;
      const colony = world.colonies[colonyId];
      const starving = colony !== undefined && colonyFoodTotal(colony) === 0;
      ants.searchPauseTicks[id] = ants.searchPauseTicks[id]! + 1;
      if (starving || ants.searchPauseTicks[id]! >= NURSE_ATTEND_DWELL_TICKS) {
        ants.task[id] = AntTask.Idle;
        ants.subTask[id] = 0;
        ants.searchPauseTicks[id] = 0;
      }
      continue;
    }

    if (subTask !== NursingSubState.MovingToBrood) continue;

    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId];
    if (!colony) continue;

    // Finite-nursing release — three cases (PR #56 codex P1 + P2).
    // Any "no claim possible" path flips subTask to Feeding without a
    // carry slot. Next tick the Feeding branch's defensive guard
    // (carryingBroodId === -1) releases to Idle, mirroring the
    // pre-v10 MovingToBrood→Feeding→Idle two-tick cadence. Without
    // these releases, nurses without claimable brood would strand in
    // MovingToBrood forever — step 10a only reallocates Idle ants.
    //
    // Case 1 (colony-level): no claimable brood exists anywhere in
    // the colony — pickup field has no sources at all. The nurse may
    // be mid-tunnel and never reach a source tile, so the release
    // must fire regardless of her current tile. Covers brood
    // matured/died/all-claimed mid-walk.
    if (!colonyHasClaimableBrood(world, colony)) {
      ants.subTask[id] = NursingSubState.Feeding;
      continue;
    }

    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    // Cases 2 + 3 (tile-level): brood exists somewhere but pickup is
    // gated for THIS nurse on THIS tile. Release only when she's on
    // a source tile (i.e., she has actually arrived). An in-transit
    // off-source nurse keeps walking — she'll reach a brood tile.
    const onSourceTile =
      isInsideQueenChamber(colony, tileX, tileY) || isInsideNursery(colony, tileX, tileY);

    // Case 2: no completed Nursery → no destination for the carry.
    // Symmetric with the pre-v10 transport gate. Defensive — allocator
    // gates nurseCount on hasNursery, so a Nursing ant should never
    // exist before a completed Nursery in normal flow.
    if (!hasCompletedChamber(colony, ChamberType.Nursery)) {
      if (onSourceTile) ants.subTask[id] = NursingSubState.Feeding;
      continue;
    }

    // Find an alive uncarried brood entity standing on this tile.
    // Iterate eggs first then larvae; pick the lowest entity id for
    // determinism (matches the pre-v10 transportBroodToNursery
    // selection order).
    const broodId = findUncarriedBroodOnTile(ants, colony, tileX, tileY);
    if (broodId < 0) {
      // Case 3: brood exists in colony but not on this tile (lower-id
      // nurse claimed first, brood inside Nursery, or arrived at a
      // stale source tile). Release if on-source; keep walking otherwise.
      if (onSourceTile) ants.subTask[id] = NursingSubState.Feeding;
      continue;
    }

    // Defensive: if the brood was carried by a now-dead carrier
    // (orphan reclaim path), null out the dead carrier's carryingBroodId
    // slot so the both-ends-of-the-pointer invariant holds. killAnt
    // intentionally leaves carry slots set so the brood stays at the
    // death tile until reclaim; the cleanup happens here when we
    // overwrite the brood's carriedBy below.
    const oldCarrier = ants.carriedBy[broodId]!;
    if (oldCarrier !== -1 && ants.alive[oldCarrier] !== 1) {
      ants.carryingBroodId[oldCarrier] = -1;
    }

    // Claim the brood. Set both ends of the carry pointer atomically.
    ants.carryingBroodId[id] = broodId;
    ants.carriedBy[broodId] = id;
    ants.subTask[id] = NursingSubState.Feeding;
    // #235 — the brood just left the pickup-seed set (carried brood is excluded
    // by carriedBy !== -1), so the pickup/deposit fields must rebuild. Formerly
    // this was invisible because those fields recomputed unconditionally every
    // tick; now step-9's second loop is gated on broodFieldDirty.
    colony.broodFieldDirty = true;
    continue;
  }
}

/**
 * Return the entity ID of an alive uncarried brood (egg or larva) standing
 * on tile (tileX, tileY) for `colony`, or -1 if none. Iterates eggs then
 * larvae and picks the lowest entity id for determinism (matches the pre-
 * v10 transportBroodToNursery selection order).
 */
/**
 * Issue #17 Phase 1 — true iff `colony` owns at least one alive,
 * reclaimable, OUTSIDE-Nursery brood entity (egg or larva) on a tile
 * that the pickup field would actually seed. Equivalent to "the v10
 * nursing pickup field has at least one source." Filters mirror
 * `computeNursingPickupField` exactly:
 *   - alive AND (uncarried OR carrier-dead)            (isBroodReclaimable)
 *   - outside any Nursery footprint                    (isInsideNursery)
 *   - on an Open OR BeingDug tile                      (tile state)
 *
 * Used by tickNurseActions to release MovingToBrood nurses to Idle when
 * the pickup pool is empty — without this the nurse would strand mid-
 * tunnel forever (no field source → can't pathfind anywhere → never
 * reaches a source tile → finite-nursing release never fires).
 *
 * Tile-state filter parity (PR #56 codex P1 round 3): a carrier can die
 * on a BeingDug tile, leaving the orphan brood there. The field seeds
 * such tiles (BeingDug is reachable per canEnterUndergroundTile and the
 * BFS expansion traverses it). Without the matching filter here, a
 * brood on a Solid/Marked tile (theoretically impossible — defensive
 * only) would be counted as claimable but never seeded → strand.
 */
function colonyHasClaimableBrood(world: WorldState, colony: ColonyRecord): boolean {
  const ants = world.ants;
  const underground = world.undergroundGrids[colony.colonyId];
  for (let i = 0; i < colony.eggs.length; i++) {
    if (isReclaimableBroodSeedable(ants, colony, underground, colony.eggs[i]!)) return true;
  }
  for (let i = 0; i < colony.larvae.length; i++) {
    if (isReclaimableBroodSeedable(ants, colony, underground, colony.larvae[i]!)) return true;
  }
  return false;
}

/** Shared predicate: brood `bid` is reclaimable AND would seed the pickup field. */
function isReclaimableBroodSeedable(
  ants: AntComponents,
  colony: ColonyRecord,
  underground: UndergroundGrid | undefined,
  bid: number,
): boolean {
  if (!isBroodReclaimable(ants, bid)) return false;
  const tx = ants.posX[bid]! >> FP_SHIFT;
  const ty = ants.posY[bid]! >> FP_SHIFT;
  if (isInsideNursery(colony, tx, ty)) return false;
  // Tile-state filter — must match computeNursingPickupField. Without an
  // underground grid (test harness), assume the brood is on an Open
  // tile so the predicate stays inclusive (matches the legacy behaviour
  // where the field couldn't be computed anyway).
  if (underground !== undefined) {
    if (tx < 0 || tx >= underground.width || ty < 0 || ty >= underground.height) return false;
    const state = ugGet(underground, tx, ty);
    if (state !== UndergroundTileState.Open && state !== UndergroundTileState.BeingDug)
      return false;
  }
  return true;
}

function findUncarriedBroodOnTile(
  ants: AntComponents,
  colony: ColonyRecord,
  tileX: number,
  tileY: number,
): number {
  // The pickup gate already excluded the inside-Nursery case (the nursing
  // flow field skips brood-inside-Nursery as seeds, so a nurse should never
  // be routed here). Defensive guard: without this, a nurse who walks onto
  // a Nursery tile while a brood is deposited there would re-pick-up the
  // brood and re-shuffle it via broodId%openCount, visible as occasional
  // brood teleports inside the Nursery.
  if (isInsideNursery(colony, tileX, tileY)) return -1;
  let pickId = -1;
  // Reclaimable = alive AND (uncarried OR carrier is dead). Shared with
  // computeNursingPickupField via `isBroodReclaimable` so the two consumers
  // can never drift.
  for (let i = 0; i < colony.eggs.length; i++) {
    const bid = colony.eggs[i]!;
    if (!isBroodReclaimable(ants, bid)) continue;
    const bx = ants.posX[bid]! >> FP_SHIFT;
    const by = ants.posY[bid]! >> FP_SHIFT;
    if (bx !== tileX || by !== tileY) continue;
    if (pickId < 0 || bid < pickId) pickId = bid;
  }
  for (let i = 0; i < colony.larvae.length; i++) {
    const bid = colony.larvae[i]!;
    if (!isBroodReclaimable(ants, bid)) continue;
    const bx = ants.posX[bid]! >> FP_SHIFT;
    const by = ants.posY[bid]! >> FP_SHIFT;
    if (bx !== tileX || by !== tileY) continue;
    if (pickId < 0 || bid < pickId) pickId = bid;
  }
  return pickId;
}

/**
 * Compute a deposit position within a single Nursery `chamber`, spread
 * across its Open tiles by `broodId % openCount` in row-major order.
 * Returns `null` if no underground grid or no Open tile exists in that chamber.
 *
 * Used by `depositCarriedBrood` (v10+) to keep brood in the specific chamber
 * the nurse physically arrived at, preventing cross-chamber teleportation.
 */
function computeDepositPositionInChamber(
  world: WorldState,
  colony: ColonyRecord,
  broodId: number,
  chamber: ChamberRecord,
): { x: number; y: number } | null {
  const underground = world.undergroundGrids[colony.colonyId];
  if (!underground) return null;
  const bx = chamber.posX >> FP_SHIFT;
  const by = chamber.posY >> FP_SHIFT;
  let openCount = 0;
  for (let ty = 0; ty < chamber.height; ty++) {
    for (let tx = 0; tx < chamber.width; tx++) {
      if (ugGet(underground, bx + tx, by + ty) === UndergroundTileState.Open) openCount++;
    }
  }
  if (openCount === 0) return null;

  // Issue #173 (V24+): place the brood on the first UNOCCUPIED Open tile
  // (row-major) so brood spreads one-per-tile instead of stacking wherever
  // `broodId % openCount` happens to collide. If every Open tile is already
  // occupied — capacity overshoot from >k carriers arriving at a Nursery with k
  // free tiles in a single tickNurseActions pass, since the deposit field is
  // computed once at tick start and never recomputed mid-tick — return null
  // rather than fall through to the legacy modulo slot, which performs no
  // occupancy check and would stack a second brood on an occupied tile. The
  // caller keeps the brood at the carrier's current tile, preserving the
  // one-per-tile invariant (the brood is re-deposited on a later tick once a
  // tile frees up).
  if (world.simVersion >= SIM_VERSION_V24_NURSERY_CAPACITY) {
    for (let ty = 0; ty < chamber.height; ty++) {
      for (let tx = 0; tx < chamber.width; tx++) {
        const cx = bx + tx;
        const cy = by + ty;
        if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
        if (tileHasResidentBrood(world, colony, broodId, cx, cy)) continue;
        return { x: (cx << FP_SHIFT) + (FP_ONE >> 1), y: (cy << FP_SHIFT) + (FP_ONE >> 1) };
      }
    }
    return null;
  }

  const targetIndex = broodId % openCount;
  let cursor = 0;
  for (let ty = 0; ty < chamber.height; ty++) {
    for (let tx = 0; tx < chamber.width; tx++) {
      const cx = bx + tx;
      const cy = by + ty;
      if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
      if (cursor === targetIndex) {
        return { x: (cx << FP_SHIFT) + (FP_ONE >> 1), y: (cy << FP_SHIFT) + (FP_ONE >> 1) };
      }
      cursor++;
    }
  }
  return null;
}

/**
 * Issue #173 (V24+) — does any OTHER brood physically occupy tile (tileX,tileY)?
 * Uses {@link isBroodReclaimable} (alive AND uncarried-or-orphaned) so deposited
 * brood and orphans frozen at a dead carrier's tile both count, but brood in
 * active transit (carried by a living nurse) does not. Excludes `excludeBroodId`
 * (the brood being placed). Matches the occupancy definition used by the
 * capacity-aware deposit field so seed exclusion and one-per-tile placement
 * agree.
 */
function tileHasResidentBrood(
  world: WorldState,
  colony: ColonyRecord,
  excludeBroodId: number,
  tileX: number,
  tileY: number,
): boolean {
  const ants = world.ants;
  for (let pass = 0; pass < 2; pass++) {
    const broodIds = pass === 0 ? colony.eggs : colony.larvae;
    for (let i = 0; i < broodIds.length; i++) {
      const bid = broodIds[i]!;
      if (bid === excludeBroodId) continue;
      if (!isBroodReclaimable(ants, bid)) continue;
      if (ants.posX[bid]! >> FP_SHIFT === tileX && ants.posY[bid]! >> FP_SHIFT === tileY)
        return true;
    }
  }
  return false;
}

/**
 * Issue #17 Phase 1 — compute the fixed-point Nursery deposit position for
 * brood `broodId`, spread across all Open tiles in the colony's Nursery
 * chambers via `broodId % openCount` in row-major order. Returns `null` if
 * no underground grid OR no Open Nursery tile exists. Used as a fallback
 * from `depositCarriedBrood` when the nurse's chamber cannot be identified.
 */
function computeNurseryDepositPosition(
  world: WorldState,
  colony: ColonyRecord,
  broodId: number,
): { x: number; y: number } | null {
  const underground = world.undergroundGrids[colony.colonyId];
  if (!underground) return null;

  let openCount = 0;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Nursery) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    for (let ty = 0; ty < ch.height; ty++) {
      for (let tx = 0; tx < ch.width; tx++) {
        if (ugGet(underground, bx + tx, by + ty) === UndergroundTileState.Open) openCount++;
      }
    }
  }
  if (openCount === 0) return null;

  // broodId is a non-negative entity ID, so the modulo is always in
  // [0, openCount) without the negative-fold guard moveQueens needs.
  const targetIndex = broodId % openCount;
  let cursor = 0;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Nursery) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    for (let ty = 0; ty < ch.height; ty++) {
      for (let tx = 0; tx < ch.width; tx++) {
        const cx = bx + tx;
        const cy = by + ty;
        if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
        if (cursor === targetIndex) {
          return {
            x: (cx << FP_SHIFT) + (FP_ONE >> 1),
            y: (cy << FP_SHIFT) + (FP_ONE >> 1),
          };
        }
        cursor++;
      }
    }
  }
  return null;
}

/**
 * Issue #17 Phase 1 — v10 deposit. The carrier (`nurseId`) has just arrived
 * at a tile inside a Nursery footprint while carrying brood `broodId`.
 *
 * V21+: places brood inside the specific Nursery chamber the nurse is standing
 * in (spread by `broodId % openCount` within that chamber's Open tiles),
 * preventing teleportation to a distant chamber. Falls back to the all-chambers
 * pool only if the nurse's chamber cannot be identified (pathological).
 *
 * Pre-V21: uses the original all-chambers spread via `computeNurseryDepositPosition`
 * to preserve byte-identical replay of pre-V21 saves.
 *
 * No allocations, no RNG.
 */
function depositCarriedBrood(
  world: WorldState,
  colony: ColonyRecord,
  nurseId: number,
  broodId: number,
  colonyId?: number,
  chamberFlowFields?: ChamberFlowFields,
): void {
  const ants = world.ants;
  // S4 V21+: restrict deposit to the nurse's current Nursery chamber so brood
  // never teleports to a distant chamber the nurse hasn't physically reached.
  // Pre-V21 worlds use the original all-chambers distribution to preserve
  // byte-identical replay of pre-V21 saves.
  let pos: { x: number; y: number } | null = null;
  const nurseTileX = ants.posX[nurseId]! >> FP_SHIFT;
  const nurseTileY = ants.posY[nurseId]! >> FP_SHIFT;
  let nurseChamber: ChamberRecord | null = null;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Nursery) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    if (
      nurseTileX >= bx &&
      nurseTileX < bx + ch.width &&
      nurseTileY >= by &&
      nurseTileY < by + ch.height
    ) {
      nurseChamber = ch;
      break;
    }
  }
  pos =
    nurseChamber !== null
      ? computeDepositPositionInChamber(world, colony, broodId, nurseChamber)
      : computeNurseryDepositPosition(world, colony, broodId); // fallback (pathological)
  // Issue #173 (V24+): computeDepositPositionInChamber returns null when the
  // carrier's target Nursery has no unoccupied Open tile — e.g. several carriers
  // reach the same Nursery in one tick and an earlier one consumed the last free
  // tile (the deposit field is computed once at tick start, not mid-tick), or
  // every Nursery is full. Decide between deferring and overflowing:
  //   - If ANOTHER Nursery still has capacity, DEFER (Codex #183): keep carrying
  //     (leave carryingBroodId/carriedBy and the brood's position untouched);
  //     next tick the rebuilt field excludes this now-full Nursery and reroutes
  //     the carrier to one with room, preserving one-brood-per-tile.
  //   - If EVERY Nursery is full, overflow-deposit (stack) as a last resort
  //     rather than leave the carrier holding the brood indefinitely. Under
  //     sustained saturation (e.g. a colony with a single Nursery and continuous
  //     egg-laying) deferring forever would pile up carriers and starve brood
  //     transport. Falls through to the carrier-tile drop below.
  if (pos === null && world.simVersion >= SIM_VERSION_V24_NURSERY_CAPACITY) {
    const underground = world.undergroundGrids[colony.colonyId];
    // Issue #173 (V24+): only DEFER if a non-full Nursery is reachable from the
    // carrier's CURRENT tile over the walkable graph. A non-full Nursery that
    // exists globally but sits in a disconnected pocket (e.g. after a cave-in
    // severs a tunnel) must NOT count — a global capacity check there would
    // defer forever, because the rebuilt deposit field is identical every tick
    // and cannot route the carrier across the severed tunnel. The carrier-local
    // flood lets the disconnected case fall through to overflow like the
    // all-full case, while still deferring in the legitimate mid-tick race
    // (a reachable non-full Nursery was filled by an earlier carrier this tick).
    const visited =
      chamberFlowFields !== undefined && colonyId !== undefined
        ? chamberFlowFields.depositReachVisited[colonyId]
        : undefined;
    const floodQueue =
      chamberFlowFields !== undefined && colonyId !== undefined
        ? chamberFlowFields.queues[colonyId]
        : undefined;
    const canRerouteElsewhere =
      underground !== undefined &&
      visited !== undefined &&
      floodQueue !== undefined &&
      hasReachableNonFullNursery(
        underground,
        colony.chambers,
        ants,
        colony.eggs,
        colony.larvae,
        nurseTileX,
        nurseTileY,
        visited,
        floodQueue,
      );
    if (canRerouteElsewhere) return; // defer — reroute next tick
    // else: no reachable non-full Nursery → fall through to overflow-deposit.
  }
  // Fallback: if the helper returns null (no grid, no Open Nursery tile —
  // test-harness or pathological state), keep the brood at the carrier's
  // current tile. Never reachable in production because the v10 path only
  // runs when nurseDeposit routed the carrier onto a Nursery tile.
  ants.posX[broodId] = pos !== null ? pos.x : ants.posX[nurseId]!;
  ants.posY[broodId] = pos !== null ? pos.y : ants.posY[nurseId]!;
  ants.zone[broodId] = Zone.Underground;
  ants.currentGridColonyId[broodId] = colony.colonyId;
  // Clear both ends of the carry pointer.
  ants.carryingBroodId[nurseId] = -1;
  ants.carriedBy[broodId] = -1;
  // #235 — the brood moved into a Nursery (changing that Nursery's fill level,
  // which the V24 capacity-aware deposit field seeds on) and its carried state
  // flipped; rebuild the pickup/deposit fields.
  colony.broodFieldDirty = true;
  // S4 V21+: nurse enters Attending substate and dwells at the Nursery tile
  // for NURSE_ATTEND_DWELL_TICKS, accelerating adjacent larvae. Pre-V21:
  // carrier returns to Idle immediately; step 10a re-allocates next tick.
  //
  // Brood-transport priority (UAT fix): if uncarried brood still exists
  // outside the Nursery (e.g., the queen laid new eggs while this nurse was
  // carrying the previous batch), skip Attending and return to Idle immediately
  // so step 10a re-assigns this nurse to pick up the next brood. Attending
  // only starts when the pickup pool is empty — brood in the Queen chamber
  // receives zero maturation benefit, so transport must come first.
  // This check runs once per deposit (not per tick), keeping it cheap.
  if (colonyHasClaimableBrood(world, colony)) {
    ants.task[nurseId] = AntTask.Idle;
    ants.subTask[nurseId] = 0;
    ants.searchPauseTicks[nurseId] = 0;
  } else {
    ants.subTask[nurseId] = NursingSubState.Attending;
    ants.searchPauseTicks[nurseId] = 0;
    // task remains AntTask.Nursing — Attending is a Nursing substate
  }
}

function isInsideNursery(colony: ColonyRecord, tileX: number, tileY: number): boolean {
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Nursery) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    if (tileX >= bx && tileX < bx + ch.width && tileY >= by && tileY < by + ch.height) return true;
  }
  return false;
}
