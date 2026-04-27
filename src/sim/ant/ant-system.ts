// ant-system.ts — PRD §4c + §5b + §8a step 10/12 ant interaction and movement
//
// Implements eight exported functions:
//   antPickupFood          — PRD §4c L1093-1104: pickup from food pile, internal subTask transition
//   antDepositFood         — PRD §4c (Errata E-01): chamber-aware deposit + idle-checkpoint transition
//   getTaskDirection       — PURE direction lookup for non-forager movement (no state mutations)
//   tickDigExecution       — Step-10 dig-worker state machine (Marked→BeingDug→Open)
//   updateFightAntTargets  — Phase 9 / SURF-04: route Fighting ants to colony.rallyPoint (step 10c global pass)
//   routeForagerPriority   — Step-13 forager priority routing to marked food piles
//   tickPheromoneDeposit   — PRD §8a step 10 + §5b carry-only rule: deposit food trail per alive carrying ant
//   tickAntMovement        — PRD §8a step 16: gradient-driven forager movement + zone-aware bounds + zone transitions
//
// Key semantic decisions:
//   - antPickupFood: on NONZERO transfer, sets subTask=CarryingFood internally (caller does NOT flip).
//     Zero transfer (capacity-full or empty-pile) must NOT flip subTask (PRD §4c L1097).
//   - antDepositFood: Errata E-01 supersedes original §4c subTask=SearchingFood write.
//     On deposit, writes task=Idle, subTask=0. Plan 10 step 9 reassigns next tick.
//     Phase 7 (UNDR-07): chamber-aware routing when FoodStorage chamber exists.
//   - tickDigExecution: owns the Marked→BeingDug claim and BeingDug→Open countdown.
//     MUST run at step 10 (after idle-reassignment, before checkPendingChambers step 11).
//     MUST NOT be called from tickAntMovement (step 16) — ordering contract is critical.
//   - getTaskDirection: PURE — reads world state, MUST NOT mutate tiles, ant sub-state, or colony flags.
//   - tickPheromoneDeposit: only ants with foodCarrying > 0 AND alive === 1 deposit (§5b carry-only rule).
//   - tickAntMovement: foragers use sampleGradient on their colony's food-trail surface grid.
//     Non-foragers use getTaskDirection (pure, no state transitions).
//     Zone-aware bounds and zone transitions handled here (SURF-05).
//
// No Math.random, Math.floor, Math.round, Date.now. Use | 0 and >> FP_SHIFT.
// No per-iteration allocations beyond sampleGradient's return object (accepted in Phase 6).
// world.nextEntityId is the upper bound for entity iteration; alive=0 slots are skipped.

import type { WorldState } from '../types.js';
import type { AntComponents } from './ant-store.js';
import type { ColonyRecord, ChamberRecord } from '../colony/colony-store.js';
import { hasCompletedChamber, isFoodChamberDepositable } from '../colony/colony-system.js';
import { AntTask, ForagingSubState, DiggingSubState, NursingSubState, ChamberType, PheromoneType } from '../enums.js';
import {
  WORKER_CARRY_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  DIG_TICKS_PER_TILE,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  SEARCH_LEASH_RADII,
  SEARCH_LEASH_MAX_WAVE,
  EXCURSION_HEADING_MIN_TICKS,
  EXCURSION_HEADING_JITTER_TICKS,
  EXCURSION_TURN_PERCENT,
  EXCURSION_WOBBLE_PERCENT,
  ENTRANCE_DEPOSIT_SUPPRESS_RADIUS,
  QUEEN_EGG_INTERVAL_TICKS,
  FOOD_CHAMBER_CAPACITY,
  BASE_FOOD_STORAGE_CAPACITY,
} from '../constants.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Rng } from '../rng.js';
import { depositFoodTrail, sampleForagingDirection } from '../pheromone/pheromone-system.js';
import { pheromoneGridKey, phGet, type PheromoneGrid } from '../pheromone/pheromone-store.js';
import type { DigFlowFields } from '../dig-system.js';
import type { EntranceFlowFields } from '../entrance-flow.js';
import type { ChamberFlowFields } from '../chamber-flow.js';
import { Zone, UndergroundTileState, ugGet, ugSet, type UndergroundGrid } from '../terrain.js';

// ---------------------------------------------------------------------------
// Direction tables for dig flow-field to dx/dy conversion
// Flow-field direction encoding: 0=N, 1=E, 2=S, 3=W
// ---------------------------------------------------------------------------
const DIR_DX = [0, 1, 0, -1] as const;  // N, E, S, W
const DIR_DY = [-1, 0, 1, 0] as const;  // N, E, S, W

// ---------------------------------------------------------------------------
// Fighting ant rally hold radius (Manhattan tiles).
//
// Surface Fighters within this Manhattan tile distance of their colony's
// rallyPoint have targetPosX/Y cleared to -1 in updateFightAntTargets, which
// the Fighting branch in tickAntMovement interprets as "no target → hold in
// place (dx=dy=0)". Prevents the ABAB occupancy-bump oscillation where
// clustered fighters repeatedly walk back to the rally tile center only to
// be bumped 1 tile by resolveSameColonyOccupancy and re-targeted next tick.
//
// Radius 2 yields a 13-tile hold zone (center + 12 Manhattan-2 tiles) which
// comfortably absorbs the resolver's single-step bump footprint for any
// realistic fighter group. Radius 1 would leave a 5-tile zone — a 6th
// fighter would be bumped outside and re-oscillate. The value is a simple
// integer compare (no fixed-point math) and still feels "at the rally"
// visually to the player.
// ---------------------------------------------------------------------------
const RALLY_HOLD_RADIUS_TILES = 2;

// ---------------------------------------------------------------------------
// antPickupFood — PRD §4c L1093-1104
//
// Transfers min(capacity, pile.amount, FOOD_PICKUP_AMOUNT) from pile to ant.
// Returns amount transferred (0 if no transfer occurred).
//
// Subtask transition rule (PRD §4c L1103):
//   On nonzero transfer → sets ants.subTask[antId] = ForagingSubState.CarryingFood.
//   On zero transfer (capacity-full or empty-pile) → NO transition. subTask unchanged.
//
// pile is a plain {amount: number} object — Phase 6 headless tests use synthetic piles.
// Phase 7 (UNDR-07) adds the FoodPile entity type and the overlap-detection step in tick().
// ---------------------------------------------------------------------------

/**
 * Attempt to pick up food from a pile into an ant's carry inventory.
 *
 * Transfers `min(remaining_capacity, pile.amount, FOOD_PICKUP_AMOUNT)` from pile to ant.
 * On a nonzero transfer, internally transitions the ant to ForagingSubState.CarryingFood
 * per PRD §4c L1103 (caller does NOT flip subTask separately).
 *
 * @param ants   Ant components SoA.
 * @param antId  Entity ID of the forager.
 * @param pile   Food source with a mutable `amount` field.
 * @returns      Amount transferred (0 means no pickup — no transition occurred).
 */
export function antPickupFood(
  ants: WorldState['ants'],
  antId: number,
  pile: { amount: number },
): number {
  const carried = ants.foodCarrying[antId]!;
  const capacity = WORKER_CARRY_CAPACITY - carried;

  if (capacity <= 0) return 0; // already at capacity — no pickup, no transition (PRD §4c L1097)

  const requested = capacity < FOOD_PICKUP_AMOUNT ? capacity : FOOD_PICKUP_AMOUNT;
  const available = pile.amount < requested ? pile.amount : requested;

  if (available <= 0) return 0; // pile empty — no pickup, no transition

  ants.foodCarrying[antId] = carried + available;
  pile.amount -= available;

  // PRD §4c L1103: transition to CarryingFood (food-trail pheromone deposit rule activates)
  ants.subTask[antId] = ForagingSubState.CarryingFood;

  // 09 digger-reassignment memo — SearchingFood leash: a successful pickup
  // counts as "return/reset", so drop the wave counter back to base. If the
  // ant is killed or drops this food, subsequent SearchingFood passes start
  // with the base 25-tile radius again.
  ants.searchWave[antId] = 0;

  // 09 excursion-foraging memo — clear the outbound heading so a post-deposit
  // re-promotion to SearchingFood re-picks a fresh outward direction instead
  // of resuming the stale heading that led to this pile. Follow-up: prev-tile
  // memory is search-state, not carry-state; clear so a future SearchingFood
  // pass starts without anti-backtrack bias.
  ants.searchHeadingX[antId] = 0;
  ants.searchHeadingY[antId] = 0;
  ants.searchHeadingTicks[antId] = 0;
  ants.searchPrevTileX[antId] = -1;
  ants.searchPrevTileY[antId] = -1;

  return available;
}

// ---------------------------------------------------------------------------
// antDepositFood — authoritative-pool deposit
//
// Transfers ants.foodCarrying[antId] into the colony food pool.
// On full deposit: zeros foodCarrying and writes task=Idle, subTask=0
// (Errata E-01 idle-checkpoint transition). On partial deposit (chamber +
// fallback pool at capacity): leaves leftover on the ant and preserves
// Foraging+CarryingFood for a next-tick retry.
//
// Errata E-01 (2026-04-16) is authoritative for the completion-write contract:
//   task = AntTask.Idle, subTask = 0   (NOT SearchingFood as the original §4c stated)
//   Plan 10 step 9 next tick reassigns — back to Foraging+SearchingFood if allocation
//   still demands forage, or to a different task if the triangle shifted.
//
// Issue #15 (2026-04-26) — food source-of-truth model:
//   chamber.foodStored is the authoritative store for each FoodStorage
//   chamber, capped at FOOD_CHAMBER_CAPACITY. colony.foodStored is the
//   entrance-shaft / chamberless-fallback pool, capped at
//   BASE_FOOD_STORAGE_CAPACITY. Total capacity is unchanged:
//   BASE + N × FOOD_CHAMBER_CAPACITY.
//
//   Deposit selection: an ant standing inside a non-full FoodStorage
//   chamber footprint deposits THERE (only). An ant at the chamberless
//   fallback site (entrance shaft top, when no FoodStorage chamber exists
//   or the field routed it home that way) deposits into colony.foodStored.
//   Pre-#15 the colony pool received every deposit and tickReconcile
//   "magically" redistributed across all chambers; that redistribution is
//   gone — chamber fill now requires an actual ant visit.
//
// Early-return if foodCarrying <= 0 (defensive guard per PRD §4c — deposit is only
// called when an ant arrives carrying food; the guard pins exact no-op behavior).
// ---------------------------------------------------------------------------

/**
 * Deposit food the ant is carrying into the FoodStorage chamber it stands
 * in (preferred), or the entrance-shaft pool (fallback).
 *
 * Chamber path: if the ant's tile lies inside a non-full FoodStorage
 * chamber footprint, deposit up to that chamber's remaining capacity
 * (FOOD_CHAMBER_CAPACITY - chamber.foodStored). If the chamber transitions
 * full as a result, mark colony.foodFlowFieldDirty so step 9 re-seeds the
 * food flow-field excluding the now-full chamber on the next tick.
 *
 * Fallback path: if no FoodStorage chamber footprint matches, deposit into
 * colony.foodStored up to BASE_FOOD_STORAGE_CAPACITY. This is the chamberless
 * early-game path AND the entrance-shaft top deposit site
 * `tickForagerActions` (b) routes to when chambers are full or absent.
 *
 * Leftover that does not fit stays on ants.foodCarrying; the ant keeps
 * task=Foraging, subTask=CarryingFood so step 16b retries next tick once
 * consumption opens space (or the flow-field redirects to another chamber).
 *
 * On FULL deposit (foodCarrying reaches 0), Errata E-01 idle-checkpoint
 * fires: task=Idle, subTask=0, step 10a reassigns next tick.
 *
 * Early-returns if foodCarrying === 0 (no-op; no task transition occurs).
 *
 * @param world    WorldState (reads ants, writes ants.foodCarrying, task, subTask).
 * @param colony   ColonyRecord (writes chamber.foodStored OR colony.foodStored;
 *                 may set colony.foodFlowFieldDirty when a chamber fills).
 * @param antId    Entity ID of the depositing forager.
 */
export function antDepositFood(world: WorldState, colony: ColonyRecord, antId: number): void {
  const amount = world.ants.foodCarrying[antId]!;
  if (amount <= 0) return;

  const tileX = world.ants.posX[antId]! >> FP_SHIFT;
  const tileY = world.ants.posY[antId]! >> FP_SHIFT;

  // Chamber path — pick the FoodStorage chamber whose footprint contains the
  // ant's tile. Iterates colony.chambers in storage order; the first match
  // wins (chambers don't overlap by construction). A "saturated" chamber
  // (free space < FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP) is NOT a match — the
  // hysteresis predicate `isFoodChamberDepositable` matches the BFS seed
  // filter in tick.ts step 9, so an ant routing past a saturated chamber
  // toward a truly-empty one cannot dribble its load into the saturated
  // chamber 2 fp at a time. See FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP rationale
  // in constants.ts (issue #15 follow-up — stuck-ant repro).
  let chamber: ChamberRecord | null = null;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (!isFoodChamberDepositable(ch)) continue;
    const baseX = ch.posX >> FP_SHIFT;
    const baseY = ch.posY >> FP_SHIFT;
    if (
      tileX >= baseX && tileX < baseX + ch.width &&
      tileY >= baseY && tileY < baseY + ch.height
    ) {
      chamber = ch;
      break;
    }
  }

  let remaining = amount;
  if (chamber !== null) {
    // We entered this branch via isFoodChamberDepositable, so pre-deposit
    // the chamber was depositable. If this deposit pushes it across into
    // saturated territory (free space < FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP),
    // re-seed the food flow-field next tick so other carriers redirect to
    // a remaining depositable chamber. This boundary check matches the
    // BFS seed filter in tick.ts step 9, keeping the routing invariant.
    const space = FOOD_CHAMBER_CAPACITY - chamber.foodStored;
    const toChamber = remaining < space ? remaining : space;
    chamber.foodStored += toChamber;
    remaining -= toChamber;
    if (!isFoodChamberDepositable(chamber)) {
      colony.foodFlowFieldDirty = true;
    }
  } else {
    // Fallback — entrance-shaft / chamberless pool. Cap at BASE.
    const space = BASE_FOOD_STORAGE_CAPACITY - colony.foodStored;
    const toPool = remaining < space ? remaining : (space > 0 ? space : 0);
    colony.foodStored += toPool;
    remaining -= toPool;
  }

  world.ants.foodCarrying[antId] = remaining;

  // Idle-checkpoint transition per PRD §4c + §7c as revised by Errata E-01 (2026-04-16):
  // on FULL deposit (remaining === 0) the action system writes task=Idle, subTask=0.
  // Plan 10 step 9 next tick reassigns (back to Foraging+SearchingFood if allocation
  // still demands forage, or to a different task if the triangle shifted).
  //
  // Near-full deposit: if leftover remains on the ant (chamber + fallback pool both
  // at capacity), preserve the Foraging + CarryingFood state and the active outbound
  // heading so routeForagerPriority can re-route the ant back to a chamber next tick
  // without a round-trip through Idle.
  if (remaining === 0) {
    world.ants.task[antId] = AntTask.Idle;
    world.ants.subTask[antId] = 0;

    // 09 excursion-foraging memo — clear heading on deposit so the re-promoted
    // SearchingFood pass after step 10a starts fresh. Follow-up: also clear
    // prev-tile memory — a fresh outbound excursion should have no anti-
    // backtrack bias.
    world.ants.searchHeadingX[antId] = 0;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 0;
    world.ants.searchPrevTileX[antId] = -1;
    world.ants.searchPrevTileY[antId] = -1;
  }
}

// ---------------------------------------------------------------------------
// tickForagerActions — Phase 9 playability: wire antPickupFood + antDepositFood
//
// Runs at tick step 16b, AFTER tickAntMovement (step 16). Bridges the forager
// state machine: a Foraging+SearchingFood ant on the surface that has arrived
// at a food pile tile picks up; a Foraging+CarryingFood ant underground that
// has arrived at a FoodStorage chamber tile OR the underground side of an
// entrance (chamberless fallback) deposits.
//
// antPickupFood and antDepositFood were defined in Phase 6 but never called
// from tick() — foragers could walk to piles and chambers but the transfer
// never happened, so the colony never accumulated food beyond STARTING_FOOD.
// This step closes that loop per PRD §4c / §4d.
// ---------------------------------------------------------------------------

/**
 * Execute the forager arrival actions: pickup on surface food piles,
 * deposit at underground FoodStorage or entrance tiles (chamberless fallback).
 *
 * Pickup: Surface + Foraging + SearchingFood + on a food pile tile → antPickupFood.
 *   On nonzero transfer, antPickupFood internally flips subTask to CarryingFood.
 *   Zero transfer (capacity-full or empty pile) is a no-op — subTask unchanged.
 *
 * Deposit: Underground + Foraging + CarryingFood + at a deposit site → antDepositFood.
 *   Deposit site = any FoodStorage chamber's Open tile, OR (fallback) the
 *   underground side of any open entrance column (tileY=0 at entrance.surfaceTileX).
 *   antDepositFood writes task=Idle, subTask=0 on full deposit so step 10a
 *   reassigns the ant next tick.
 *
 * Deterministic: iterates ant entity IDs ascending. No Math.random. No allocations.
 *
 * @param world  WorldState (reads/writes ants, foodPiles, colonies, undergroundGrids).
 */
export function tickForagerActions(world: WorldState): void {
  const ants = world.ants;

  // Scratch wrapper satisfying antPickupFood's `{ amount: number }` contract.
  // Food piles are infinite per PRD SURF-02 — antPickupFood mutates this
  // wrapper's amount which we reset per pickup; the wrapper is discarded.
  // Pre-allocated outside the loop (no per-ant allocation, hot-path friendly).
  const pileScratch = { amount: 0 };

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;

    const subTask = ants.subTask[id]!;
    const zone = ants.zone[id]!;

    if (
      zone === Zone.Surface &&
      (subTask === ForagingSubState.SearchingFood ||
       subTask === ForagingSubState.ReturningToNest)
    ) {
      // Pickup path — ant must be exactly on a food pile tile.
      // ReturningToNest is included per the 09 excursion-foraging memo: a
      // forager heading home after an over-leash failed search that crosses
      // a pile en route picks up and seamlessly flips to CarryingFood (via
      // antPickupFood's internal subTask write). Skipping it would silently
      // drop free food the ant is literally standing on.
      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      for (let p = 0; p < world.foodPiles.length; p++) {
        const pile = world.foodPiles[p]!;
        if (pile.tileX !== tileX || pile.tileY !== tileY) continue;
        // Infinite source (SURF-02): seed wrapper with FOOD_PICKUP_AMOUNT so
        // antPickupFood's `min(capacity, pile.amount, FOOD_PICKUP_AMOUNT)` clamp
        // resolves to capacity-or-pickup-amount, never pile-limited.
        pileScratch.amount = FOOD_PICKUP_AMOUNT;
        antPickupFood(ants, id, pileScratch);     // may transition subTask to CarryingFood
        break;
      }
      continue;
    }

    if (zone === Zone.Underground && subTask === ForagingSubState.CarryingFood) {
      // Deposit path — arrival at FoodStorage chamber (preferred) OR entrance shaft (fallback).
      const colonyId = ants.colonyId[id]!;
      const colony = world.colonies[colonyId];
      if (!colony) continue;

      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;

      // (a) FoodStorage chamber Open tile — only DEPOSITABLE chambers count
      // (issue #15 follow-up). A worker standing on a saturated chamber tile
      // (free space < FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP) is a no-op here;
      // the food flow-field excludes saturated chambers from BFS seeding (see
      // tick.ts step 9), so on the next tick movement steers them to a
      // depositable chamber if one exists, or to the entrance fallback (b)
      // below. The shared `isFoodChamberDepositable` predicate keeps the
      // movement, deposit, and BFS seed paths in lockstep.
      let depositSite = false;
      for (let c = 0; c < colony.chambers.length; c++) {
        const chamber = colony.chambers[c]!;
        if (!isFoodChamberDepositable(chamber)) continue;
        const baseX = chamber.posX >> FP_SHIFT;
        const baseY = chamber.posY >> FP_SHIFT;
        if (
          tileX >= baseX && tileX < baseX + chamber.width &&
          tileY >= baseY && tileY < baseY + chamber.height
        ) {
          depositSite = true;
          break;
        }
      }

      // (b) Chamberless fallback — arrival at underground side of any open entrance.
      if (!depositSite && colony.entrances) {
        for (let e = 0; e < colony.entrances.length; e++) {
          const ent = colony.entrances[e]!;
          if (!ent.isOpen) continue;
          // Underground tile at the entrance column, at the top of the shaft.
          if (ent.surfaceTileX === tileX && tileY === 0) {
            depositSite = true;
            break;
          }
        }
      }

      if (depositSite) {
        // antDepositFood — on full deposit flips to Idle (step 10a reassigns);
        // on partial deposit (colony at cap) leaves leftover on ants.foodCarrying
        // and keeps task=Foraging, subTask=CarryingFood so the forager retries.
        antDepositFood(world, colony, id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tickNurseActions — 09 reproduction-gate memo: make nursing FINITE
//
// Runs at tick step 16c, AFTER tickAntMovement (step 16) and tickForagerActions
// (step 16b). Closes the final gap in the nursing loop: before this step,
// nursing ants would walk to a Queen/Nursery chamber and then loop forever,
// because no code wrote them back to AntTask.Idle. Step 10a only reassigns
// Idle ants, so nurses remained nurses forever — the "3 nurses / 0 foragers"
// lock seen in the colony snapshot.
//
// Two-step service state machine using NursingSubState:
//   MovingToBrood (0) + ON a Queen/Nursery chamber tile → subTask = Feeding (1)
//   Feeding (1)                                         → task = Idle, subTask = 0
//
// The one-tick Feeding dwell models a "service/check" beat before the ant
// re-enters the Idle pool. Step 10a next tick re-considers the ant against
// the current computedAllocation — if brood still requires nursing and the
// ceil(workers/4) cap is not yet met, it may be re-promoted to nurse; if the
// triangle asks for foragers, it goes foraging. This is how nursing becomes
// an overdispatchable task instead of a sticky terminal state.
//
// Chamber footprint test uses the promoted chambers array (single-path
// creation — colony.chambers only contains completed entries). Pending
// chambers do not count, matching the memo's "completed only" rule.
//
// P2 brood transport (seed936214196-tick2401 fix): on the same service tick
// (MovingToBrood → Feeding transition), if the colony has a completed Nursery,
// pick the minimum-entity-id alive brood (eggs ∪ larvae) that is NOT already
// inside any Nursery footprint and teleport it to the first Nursery Open tile
// (row-major within the chosen chamber; chambers iterated in storage order).
// This is the minimal pass that satisfies "nurse moves brood to Nursery"
// without introducing per-brood pathing — foragers/nurses handle movement via
// the main dispatch; direct relocation is the nurse's service effect. Eggs
// and larvae are passive entities (speed=0) so teleport == deterministic
// one-tick transport.
//
// Deterministic: iterates ant entity IDs ascending. No Math.random. No
// allocations. Mirrors the tickForagerActions iteration shape.
// ---------------------------------------------------------------------------

/**
 * Finalize nursing: on arrival at a Queen/Nursery chamber, perform a one-tick
 * service (MovingToBrood → Feeding) and then return the ant to Idle so step
 * 10a can reassign it next tick per the current allocation.
 *
 * Only acts on ants with alive=1 AND task=Nursing. Ignores any other task.
 *
 * @param world  WorldState (reads ants, colonies; writes ants.task, ants.subTask).
 */
export function tickNurseActions(world: WorldState): void {
  const ants = world.ants;

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Nursing) continue;

    const subTask = ants.subTask[id]!;

    // Feeding → Idle: the dwell tick is already spent; release the ant.
    // Step 10a on the next tick sees an Idle ant and routes per allocation.
    if (subTask === NursingSubState.Feeding) {
      ants.task[id]    = AntTask.Idle;
      ants.subTask[id] = 0;
      continue;
    }

    // MovingToBrood → Feeding iff ant is inside a Queen or Nursery footprint.
    if (subTask !== NursingSubState.MovingToBrood) continue;

    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId];
    if (!colony || colony.chambers.length === 0) continue;

    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    let onServiceTile = false;
    for (let c = 0; c < colony.chambers.length; c++) {
      const chamber = colony.chambers[c]!;
      const ct = chamber.chamberType;
      if (ct !== ChamberType.Queen && ct !== ChamberType.Nursery) continue;
      const baseX = chamber.posX >> FP_SHIFT;
      const baseY = chamber.posY >> FP_SHIFT;
      if (
        tileX >= baseX && tileX < baseX + chamber.width &&
        tileY >= baseY && tileY < baseY + chamber.height
      ) {
        ants.subTask[id] = NursingSubState.Feeding;
        onServiceTile = true;
        break;
      }
    }

    // P2 brood transport: on the MovingToBrood→Feeding flip, relocate one
    // brood entity into the Nursery. Gated on a completed Nursery — without
    // one there is no target tile to deposit brood on.
    if (onServiceTile && hasCompletedChamber(colony, ChamberType.Nursery)) {
      transportBroodToNursery(world, colony);
    }
  }
}

/**
 * Move a single brood entity (egg or larva) into the colony's Nursery.
 *
 * Selection: deterministic min-entity-id across colony.eggs ∪ colony.larvae,
 * restricted to alive entities whose tile is NOT already inside any Nursery
 * footprint. If every brood is already in a Nursery, does nothing.
 *
 * Destination: spread across every Open tile in every Nursery chamber the
 * colony owns. The candidate tiles are enumerated row-major across all
 * Nursery chambers in colony.chambers order; the chosen tile is index
 * `pickId % openCount` (issue #21 fix — pre-fix this always wrote to the
 * first Open tile, stacking every brood at one corner). Writes posX/posY
 * in fixed-point (tile-center) and zone=Underground. With a single Open
 * tile (e.g., a 1×1 Nursery, or a Nursery whose other tiles are still
 * Solid) the modulo collapses to 0 and brood necessarily land on that
 * one tile — there is no other valid Open tile to spread to.
 *
 * No allocations, no RNG, no wall-clock.
 */
function transportBroodToNursery(world: WorldState, colony: ColonyRecord): void {
  const ants = world.ants;

  // 1. Select the minimum-id brood entity that is alive and not already in a
  //    Nursery footprint.
  let pickId = -1;
  for (let i = 0; i < colony.eggs.length; i++) {
    const bid = colony.eggs[i]!;
    if (ants.alive[bid] !== 1) continue;
    if (isInsideNursery(colony, ants.posX[bid]! >> FP_SHIFT, ants.posY[bid]! >> FP_SHIFT)) continue;
    if (pickId < 0 || bid < pickId) pickId = bid;
  }
  for (let i = 0; i < colony.larvae.length; i++) {
    const bid = colony.larvae[i]!;
    if (ants.alive[bid] !== 1) continue;
    if (isInsideNursery(colony, ants.posX[bid]! >> FP_SHIFT, ants.posY[bid]! >> FP_SHIFT)) continue;
    if (pickId < 0 || bid < pickId) pickId = bid;
  }
  if (pickId < 0) return;

  // 2. Distribute across all Nursery Open tiles (issue #21). Pre-fix the
  //    transport always picked the first Open tile in row-major order across
  //    the first Nursery chamber, so successive brood stacked at one corner.
  //    Now: count Open tiles across every Nursery chamber the colony owns,
  //    then deposit at index `pickId % openCount` in row-major order. Using
  //    pickId (the brood's own entity ID) gives a deterministic, replay-safe
  //    spread that fans out as new brood is transported — different IDs land
  //    on different tiles. Same two-pass count/find pattern as moveQueens.
  //
  // Phase 09.1 Chunk 0 disposition: own-colony chamber membership — brood
  // is transported into its own colony's Nursery chamber, never into an
  // enemy grid. Keeping colony.colonyId here is safe-by-construction (brood
  // never invades). Parallel to colony-system.ts:376/431 dispositions.
  const underground = world.undergroundGrids[colony.colonyId];
  if (!underground) return;

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
  if (openCount === 0) return;

  // pickId is a non-negative entity ID, so the modulo is always in
  // [0, openCount) without the negative-fold guard moveQueens needs.
  const targetIndex = pickId % openCount;
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
          // Fixed-point tile-center position.
          ants.posX[pickId] = (cx << FP_SHIFT) + (FP_ONE >> 1);
          ants.posY[pickId] = (cy << FP_SHIFT) + (FP_ONE >> 1);
          ants.zone[pickId] = Zone.Underground;
          // Phase 09.1 Chunk 0 — descent invariant. Brood teleported into
          // nursery now occupies that colony's grid. Today brood is in its
          // OWN colony so colony.colonyId === ants.colonyId[pickId] and this
          // is a byte-identical no-op.
          ants.currentGridColonyId[pickId] = colony.colonyId;
          return;
        }
        cursor++;
      }
    }
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

// ---------------------------------------------------------------------------
// getTaskDirection — PURE direction lookup (no state mutations)
//
// Returns the movement direction for a non-forager ant based on task/subTask.
// PURE: reads world state and flow-field, MUST NOT mutate tiles, ant sub-state,
// or colony flags. All dig-worker state transitions (Marked→BeingDug claim,
// BeingDug→Open excavation) live in tickDigExecution at step 10.
// ---------------------------------------------------------------------------

/**
 * Compute movement direction for a non-forager ant based on task and context.
 * PURE — reads world state but MUST NOT mutate tiles, ant sub-state, or colony flags.
 * All dig-worker state transitions (Marked→BeingDug claim, BeingDug→Open open)
 * live in `tickDigExecution` and run at tick step 10 per accepted Phase 3 PRD §9a.
 *
 * Dig workers in MovingToTile: read flow-field direction, convert to dx/dy.
 *   Direction=-1 (ant is ON the Marked tile) → return {0,0} so the ant holds
 *   position until step 10 claims the tile next tick.
 * Dig workers in Excavating: return {0,0} (stationary while digging).
 * Nursing ants: read the nursing chamber flow-field (seeded from Queen+Nursery
 *   Open tiles). -1 (on chamber tile) → {0,0} so tickNurseActions can flip
 *   subTask=Feeding. -2 (no tunnel connection) → {0,0} as a deterministic
 *   failsafe. When no cache is supplied (legacy test harnesses) falls back to
 *   Manhattan steering.
 * Fighting ants: {0,0} here — rally steering lives in tickAntMovement so the
 *   fighter can consume ants.targetPosX/Y (written by updateFightAntTargets)
 *   with the same Manhattan step pattern as the priority-forager branch.
 * Idle ants: {0,0} (awaiting task assignment).
 *
 * @param world              WorldState (reads ants, colonies, undergroundGrids).
 * @param antId              Entity ID of the ant.
 * @param digFlowFields      Per-colony flow-field cache (dig targets).
 * @param chamberFlowFields  Optional per-colony chamber flow-field cache. When
 *                           provided, nurses consume the `nursing` field
 *                           instead of Manhattan steering.
 * @returns                  Direction vector {dx, dy}.
 */
export function getTaskDirection(
  world: WorldState,
  antId: number,
  digFlowFields: DigFlowFields,
  chamberFlowFields?: ChamberFlowFields,
): { dx: number; dy: number } {
  const ants = world.ants;
  const task = ants.task[antId]!;
  const subTask = ants.subTask[antId]!;

  if (task === AntTask.Digging) {
    if (subTask === DiggingSubState.Excavating) {
      // Stationary while digging — countdown happens in tickDigExecution at step 10
      return { dx: 0, dy: 0 };
    }

    // MovingToTile: read flow-field direction.
    // colonyId keys the dig flow-field (indexed by the digger's OWN colony —
    // diggers never cross grids); gridColonyId keys the underground grid the
    // ant currently occupies (Phase 09.1 Chunk 0). Today both values are
    // identical for every ant; Chunks 3+4 break that for Fighter invaders.
    const colonyId = ants.colonyId[antId]!;
    const gridColonyId = ants.currentGridColonyId[antId]!;
    const flowField = digFlowFields.fields[colonyId];
    if (!flowField) return { dx: 0, dy: 0 };

    const underground = world.undergroundGrids[gridColonyId];
    if (!underground) return { dx: 0, dy: 0 };

    const tileX = ants.posX[antId]! >> FP_SHIFT;
    const tileY = ants.posY[antId]! >> FP_SHIFT;
    const direction = flowField[tileY * underground.width + tileX];

    if (direction === undefined || direction === -1 || direction === -2) {
      // -1 = source (ant is ON Marked tile, claim happens in tickDigExecution)
      // -2 = unreachable
      return { dx: 0, dy: 0 };
    }

    return { dx: DIR_DX[direction]!, dy: DIR_DY[direction]! };
  }

  if (task === AntTask.Nursing) {
    // colonyId keys the nursing chamber flow-field (indexed by the nurse's
    // OWN colony — nurses never cross grids); gridColonyId keys the
    // underground grid the ant currently occupies (Phase 09.1 Chunk 0).
    // Today both values are identical for every ant.
    const colonyId = ants.colonyId[antId]!;
    const gridColonyId = ants.currentGridColonyId[antId]!;

    // Prefer the nursing flow-field. Seeded from Open tiles inside every
    // Queen/Nursery chamber footprint, so the nurse routes through tunnels
    // instead of straight-line stepping into Solid dirt on bends. See the
    // seed-920076605 debug snapshot: ant 19 at (14,16) targeted Nursery
    // (13,9) and straight-line steering picked (14,15) = Solid every tick.
    if (chamberFlowFields !== undefined) {
      const flowField = chamberFlowFields.nursing[colonyId];
      const underground = world.undergroundGrids[gridColonyId];
      if (flowField && underground) {
        const tileX = ants.posX[antId]! >> FP_SHIFT;
        const tileY = ants.posY[antId]! >> FP_SHIFT;
        const dir = flowField[tileY * underground.width + tileX];
        if (dir === undefined) return { dx: 0, dy: 0 };
        if (dir === -1) {
          // On a Queen/Nursery chamber tile — hold. tickNurseActions flips
          // subTask to Feeding this same tick (it runs at step 16c after
          // tickAntMovement at step 16) and to Idle next tick.
          return { dx: 0, dy: 0 };
        }
        if (dir === -2) {
          // Unreachable. Failsafe: hold. Better than oscillating into dirt;
          // the debug trace reports 'nursing-chamber' so the stuck ant is
          // still visually attributable to the nursing path.
          return { dx: 0, dy: 0 };
        }
        return { dx: DIR_DX[dir]!, dy: DIR_DY[dir]! };
      }
      // flowField/grid absent — fall through to Manhattan legacy path.
    }

    // Legacy Manhattan path (test harnesses without chamberFlowFields).
    const colony = world.colonies[colonyId];
    if (!colony || colony.chambers.length === 0) return { dx: 0, dy: 0 };

    const antTileX = ants.posX[antId]! >> FP_SHIFT;
    const antTileY = ants.posY[antId]! >> FP_SHIFT;

    let bestDx = 0;
    let bestDy = 0;
    let bestDist = -1;

    for (let i = 0; i < colony.chambers.length; i++) {
      const chamber = colony.chambers[i]!;
      const ct = chamber.chamberType;
      if (ct !== (0 as typeof ChamberType.Queen) && ct !== (1 as typeof ChamberType.Nursery)) continue;

      const chamberTileX = chamber.posX >> FP_SHIFT;
      const chamberTileY = chamber.posY >> FP_SHIFT;
      const dist = Math.abs(antTileX - chamberTileX) + Math.abs(antTileY - chamberTileY);

      if (bestDist < 0 || dist < bestDist) {
        bestDist = dist;
        // Compute unit direction step
        const rawDx = chamberTileX - antTileX;
        const rawDy = chamberTileY - antTileY;
        // Prefer axis with greater distance; if equal pick X
        if (Math.abs(rawDx) >= Math.abs(rawDy)) {
          bestDx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
          bestDy = 0;
        } else {
          bestDx = 0;
          bestDy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
        }
      }
    }

    return { dx: bestDx, dy: bestDy };
  }

  // Fighting, Idle, and anything else: stationary
  return { dx: 0, dy: 0 };
}

// ---------------------------------------------------------------------------
// tickSearchLeash — 09 digger-reassignment memo responsiveness fix
//
// Demotes Foraging+SearchingFood surface ants that have drifted past the
// current wave radius from their nearest own-colony entrance — but ONLY when
// the colony has another task under-served. The memo's real target is triangle
// responsiveness ("SearchingFood foragers should not remain effectively
// committed forever when the colony's requested allocation no longer supports
// that role"), not a hard wanderer cap: demoting a far-flung forager under
// pure-forage allocation just churns the ant (step 10a re-promotes it to
// Foraging the same tick) while shrinking its effective discovery radius.
// Gating on `rebalance benefit exists` keeps autonomous forage bootstrap
// working when the player hasn't shifted the triangle.
//
// The demoted ant is written back to AntTask.Idle (subTask=0, priority target
// cleared) and its searchWave is incremented (capped at SEARCH_LEASH_MAX_WAVE).
// Runs at tick step 9b — immediately BEFORE step 10a idle-reassignment so the
// demoted ant is re-considered the same tick against the colony's current
// computedAllocation.
//
// Per the memo: per-ant state (not colony-memory), deterministic, compatible
// with pheromone-first routing (priority targets are cleared so the released
// ant can re-acquire pheromone/priority cleanly on re-promotion). Underground
// foragers (CarryingFood returning home, or bounced-back SearchingFood) are
// untouched — the leash only applies to surface search wandering.
// ---------------------------------------------------------------------------

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
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const overForage =
      colony.taskCensus.forage > colony.computedAllocation.forage;
    const nonForageDemand =
      colony.computedAllocation.dig > 0 || colony.computedAllocation.fight > 0;
    rebalanceNeeded[colony.colonyId] = overForage && nonForageDemand;
  }

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;
    if (ants.subTask[id] !== ForagingSubState.SearchingFood) continue;
    if (ants.zone[id] !== Zone.Surface) continue;

    const colonyId = ants.colonyId[id]!;
    if (rebalanceNeeded[colonyId] !== true) continue;

    const colony = world.colonies[colonyId];
    if (!colony || !colony.entrances || colony.entrances.length === 0) continue;

    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    // Nearest-entrance Manhattan distance. Any entrance counts (open or closed
    // — the leash is about drift from the nest, not about reachability).
    let bestDist = -1;
    for (let e = 0; e < colony.entrances.length; e++) {
      const ent = colony.entrances[e]!;
      const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
      if (bestDist < 0 || d < bestDist) bestDist = d;
    }
    if (bestDist < 0) continue;

    let wave = ants.searchWave[id]!;
    if (wave < 0) wave = 0;
    if (wave > SEARCH_LEASH_MAX_WAVE) wave = SEARCH_LEASH_MAX_WAVE;
    const radius = SEARCH_LEASH_RADII[wave]!;

    if (bestDist <= radius) continue;

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

    const nextWave = wave + 1;
    ants.searchWave[id] = nextWave > SEARCH_LEASH_MAX_WAVE
      ? SEARCH_LEASH_MAX_WAVE
      : nextWave;
  }
}

// ---------------------------------------------------------------------------
// tickDigExecution — step-10 dig-worker state machine (PRD §9a)
//
// Owns the Marked→BeingDug claim and BeingDug→Open countdown.
// Called from tick.ts step 10, AFTER existing idle-reassignment,
// BEFORE step 11 checkPendingChambers / step 12 checkEntranceCompletion.
//
// CRITICAL ordering: do NOT call this from tickAntMovement (step 16) —
// that would break the same-tick chamber/entrance completion semantics.
// ---------------------------------------------------------------------------

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
export function tickDigExecution(
  world: WorldState,
  digFlowFields: DigFlowFields,
): void {
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

// ---------------------------------------------------------------------------
// updateFightAntTargets — Phase 9 / SURF-04 step-10c global pass
//
// Route AntTask.Fighting ants to their colony's rallyPoint in fixed-point coords.
//
// If colony.rallyPoint is set and ant is on the surface → target the rally tile center.
// If colony.rallyPoint is null → fall back to first entrance (surfaceTileX/Y in fp).
// If ant is underground with a surface rally → route to first entrance first
// (zone promotion happens inside tickAntMovement at step 16 via flow fields).
// Non-Fighting ants and dead slots are untouched.
//
// Architectural rationale: runs as a GLOBAL pass at step 10c (after idle-reassignment
// 10a and tickDigExecution 10b, before checkPendingChambers 11). Not inlined in the
// per-colony 10a loop because this is a per-ant task filter, not a per-colony census
// mutation — same split as Phase 7's tickDeadDiggerCleanup.
//
// Deterministic: iterates ant entity IDs ascending (natural SoA order).
// Pure-sim: reads world.colonies, writes only ants.targetPosX/targetPosY.
// ---------------------------------------------------------------------------

/**
 * Phase 9 / SURF-04 — route AntTask.Fighting ants to their colony's rallyPoint.
 *
 * Runs at tick.ts step 10c as a GLOBAL pass (after idle-reassignment 10a and
 * tickDigExecution 10b, before checkPendingChambers 11). Separate pass rather
 * than inline in the per-colony 10a loop because this is a per-ant task filter,
 * not a per-colony census mutation — same architectural split as Phase 7's
 * tickDeadDiggerCleanup.
 *
 * Pure-sim: reads world.colonies, writes world.ants.targetPosX/targetPosY only.
 * Deterministic: iterates ant entity IDs ascending (natural SoA order).
 *
 * @param world  WorldState (reads ants, colonies; writes ants.targetPosX/Y).
 */
export function updateFightAntTargets(world: WorldState): void {
  const { ants } = world;

  // Precompute: for each colony with a rally, does ANY colony have an OPEN
  // entrance at that rally tile? If yes, the hold-radius anti-oscillation
  // suppression MUST be skipped for that colony's fighters — they must walk
  // onto the EXACT entrance tile so the Surface→Underground descent block
  // in tickAntMovement can fire. This carve-out covers:
  //   - Invasion: player rallies on an enemy open entrance → fighters
  //     descend into the enemy grid (Plan 09.1-03 descent-intent gate).
  //   - Defensive descent: a colony rallies on its OWN open entrance →
  //     fighters enter their own grid. Colony-agnostic by design — the
  //     invariant "rally on entrance → descend" holds regardless of owner.
  // Complexity: O(N²·E) where N = colony count, E = entrances per colony.
  // Realistic values are tiny (2-4 colonies, 1-3 entrances each). Simplicity
  // over microperf — clarity wins for this rarely-hit guard.
  const rallyOnEntrance: Record<number, boolean> = {};
  for (const cidKey in world.colonies) {
    const colony = world.colonies[cidKey as unknown as keyof typeof world.colonies];
    if (!colony) continue;
    const rp = colony.rallyPoint;
    if (rp == null) continue;
    let hit = false;
    for (const otherKey in world.colonies) {
      if (hit) break;
      const other = world.colonies[otherKey as unknown as keyof typeof world.colonies];
      if (!other || !other.entrances) continue;
      for (let e = 0; e < other.entrances.length; e++) {
        const ent = other.entrances[e]!;
        if (ent.isOpen
            && ent.surfaceTileX === rp.tileX
            && ent.surfaceTileY === rp.tileY) {
          hit = true;
          break;
        }
      }
    }
    rallyOnEntrance[colony.colonyId] = hit;
  }

  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;

    const colonyId = ants.colonyId[id]! as ReturnType<typeof Number>;
    const colony = world.colonies[colonyId as unknown as keyof typeof world.colonies];
    if (colony === undefined) continue;

    const rp = colony.rallyPoint;

    // createColonyRecord intentionally leaves entrances/rallyPoint uninitialized (colony-store.ts:164);
    // callers set them post-construction. Treat both null and undefined as "no value".
    const entrances = colony.entrances;
    const hasEntrances = entrances != null && entrances.length > 0;

    // No rally point (null or uninitialized): fall back to first entrance (idle-at-nest).
    if (rp == null) {
      if (hasEntrances) {
        const e = entrances[0]!;
        ants.targetPosX[id] = (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
        ants.targetPosY[id] = (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
      }
      continue;
    }

    // Underground fighter with surface rally: route to first entrance first.
    // Zone promotion happens inside tickAntMovement when the ant crosses the shaft;
    // this pass only writes the fixed-point target coord.
    if (ants.zone[id] === 1 /* Underground */ && hasEntrances) {
      const e = entrances[0]!;
      ants.targetPosX[id] = (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
      ants.targetPosY[id] = (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
      continue;
    }

    // Surface fighter (or underground with no entrances yet): target rally tile center.
    //
    // Anti-oscillation: if the ant is already within RALLY_HOLD_RADIUS_TILES
    // Manhattan of the rally tile, clear the target to -1 so the Fighting
    // branch in tickAntMovement holds in place (dx=dy=0). Without this,
    // resolveSameColonyOccupancy bumps clustered ants one tile N/E/S/W and
    // the next tick re-writes the same rally center target → walk →
    // re-collide → re-bump → visible ABAB jitter at fp-resolution.
    //
    // Carve-out: if the rally tile IS an open entrance (any colony's), the
    // hold-radius suppression is skipped — fighters must reach the EXACT
    // entrance tile for the descent block in tickAntMovement to fire.
    if (!rallyOnEntrance[colony.colonyId]) {
      const antTileX = ants.posX[id]! >> FP_SHIFT;
      const antTileY = ants.posY[id]! >> FP_SHIFT;
      const d = Math.abs(antTileX - rp.tileX) + Math.abs(antTileY - rp.tileY);
      if (d <= RALLY_HOLD_RADIUS_TILES) {
        ants.targetPosX[id] = -1;
        ants.targetPosY[id] = -1;
        continue;
      }
    }
    ants.targetPosX[id] = (rp.tileX << FP_SHIFT) + (FP_ONE >> 1);
    ants.targetPosY[id] = (rp.tileY << FP_SHIFT) + (FP_ONE >> 1);
  }
}

// ---------------------------------------------------------------------------
// routeForagerPriority — step-13 forager priority routing (PRD §5a)
//
// Per-colony priority targeting. Each colony carries at most one
// priorityFoodPileId (the player — or AI caller — has designated it as the
// "send my foragers here" target). For each Foraging ant in SearchingFood
// sub-state:
//   - Look up the ant's colony and that colony's priorityFoodPileId.
//   - If null OR the pile no longer exists, clear targetPosX/Y to -1.
//   - Otherwise, set targetPosX/Y to the pile's tile center.
//
// The old "iterate all piles and pick the nearest marked" logic is gone — with
// an exclusive single-target model per colony there is nothing to tie-break.
// Critically, this function must filter by ants.colonyId so the player's mark
// never redirects enemy foragers (the pre-fix bug).
// ---------------------------------------------------------------------------

/**
 * For each Foraging ant in SearchingFood sub-state:
 *   - Look up the ant's colony's priorityFoodPileId.
 *   - If null (or the referenced pile no longer exists), clear targetPosX/Y to -1
 *     so the ant falls through to the pheromone gradient.
 *   - Else set targetPosX/Y to the priority pile's tile center.
 *
 * @param world  WorldState (reads ants, colonies, foodPiles; writes ants.targetPosX/Y).
 */
export function routeForagerPriority(world: WorldState): void {
  const ants = world.ants;

  // Pre-resolve per-colony priority pile coords (indexed by colonyId) so the
  // ant loop doesn't re-scan foodPiles per entity. Built only for colonies
  // whose priorityFoodPileId points at an extant pile — a stale id (pile
  // removed mid-game) is treated as "no priority" for this tick.
  //
  // Using a plain object per ADR-0006 (no Map). Keys are ColonyId coerced to
  // string by the JS engine; values are packed as [tileX << FP_SHIFT, tileY << FP_SHIFT].
  const priorityTargets: Record<number, { targetX: number; targetY: number }> = {};
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    if (colony.priorityFoodPileId === null) continue;
    for (let p = 0; p < world.foodPiles.length; p++) {
      const pile = world.foodPiles[p]!;
      if (pile.foodPileId === colony.priorityFoodPileId) {
        priorityTargets[colony.colonyId] = {
          targetX: pile.tileX << FP_SHIFT,
          targetY: pile.tileY << FP_SHIFT,
        };
        break;
      }
    }
  }

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;
    if (ants.subTask[id] !== ForagingSubState.SearchingFood) continue;

    const colonyId = ants.colonyId[id]!;
    const target = priorityTargets[colonyId];

    if (target === undefined) {
      // This ant's colony has no priority pile (or the id is stale) — clear.
      ants.targetPosX[id] = -1;
      ants.targetPosY[id] = -1;
      continue;
    }

    ants.targetPosX[id] = target.targetX;
    ants.targetPosY[id] = target.targetY;
  }
}

// ---------------------------------------------------------------------------
// chooseExcursionDirection — 09 excursion-foraging memo correlated outward walk
//
// Replaces the older chooseWanderDirection (scatter-ring + diffusion) with a
// correlated outward walk: a SearchingFood forager without a priority target
// or pheromone gradient commits to an outward cardinal heading for a short
// run, occasionally turning 90° left or right, and gets leashed back to the
// nest by tickExcursionBoundary when it has travelled past the current wave
// radius. The combined effect is a bounded outbound arc rather than 2-D
// Brownian motion, which covers more ground per tile of travel and produces
// a visibly more ant-like outbound trail that the player can read.
//
// Per-ant state (no colony memory, per the 09 memo):
//   searchHeadingX, searchHeadingY  ∈ {-1, 0, 1}; exactly one axis nonzero
//                                    when active; (0,0) means "pick a new
//                                    outward heading now".
//   searchHeadingTicks             ticks until the next turn check; counts
//                                    down each call; when it hits 0 we roll
//                                    a turn and reset to MIN + rng jitter.
//
// RNG consumption is uniform: exactly three rng calls per invocation
// (turnRoll, turnDir, jitter). This keeps RNG-stream advance identical
// across branches for replay determinism.
//
// Priority order is preserved upstream — priority target > food scent >
// pheromone gradient > excursion exploration. This function is only
// consulted when all three upstream branches have no direction to offer.
// ---------------------------------------------------------------------------

/**
 * 09 excursion-foraging memo — correlated outward walk direction for a
 * SearchingFood forager with no priority target and no pheromone gradient
 * to follow.
 *
 * Reads and writes ants.searchHeadingX / searchHeadingY / searchHeadingTicks.
 * Consumes exactly three rng calls (turnRoll, turnDir, jitter) regardless of
 * branch taken, so the RNG stream advances uniformly across replays.
 *
 * @param world  WorldState (reads ants and colonies, writes heading fields).
 * @param antId  Entity ID of the searching forager.
 * @param rng    Deterministic world Rng.
 * @returns      Cardinal direction vector { dx, dy } with |dx| + |dy| === 1.
 */
export function chooseExcursionDirection(
  world: WorldState,
  antId: number,
  rng: Rng,
): { dx: number; dy: number } {
  const ants = world.ants;

  // Consume RNG uniformly — even branches that don't need every roll still
  // read them so replay/save-load determinism is preserved regardless of
  // which branch each invocation takes.
  const turnRoll = rng.nextInt(100);
  const turnDir = rng.nextInt(2); // 0 = left, 1 = right
  const jitter = rng.nextInt(EXCURSION_HEADING_JITTER_TICKS);

  let hx = ants.searchHeadingX[antId]!;
  let hy = ants.searchHeadingY[antId]!;
  let ticks = ants.searchHeadingTicks[antId]!;

  const tileX = ants.posX[antId]! >> FP_SHIFT;
  const tileY = ants.posY[antId]! >> FP_SHIFT;

  // Pick or refresh heading based on current state.
  if (hx === 0 && hy === 0) {
    // No active heading — derive an outward-biased initial heading from
    // nearest own-colony entrance. Ties and "ant sitting on an entrance"
    // fall back to antId-parity so initial fan-out is deterministic.
    const colonyId = ants.colonyId[antId]!;
    const colony = world.colonies[colonyId];
    const entrances = colony?.entrances;

    let outX = 0;
    let outY = 0;
    if (entrances && entrances.length > 0) {
      let bestEx = entrances[0]!.surfaceTileX;
      let bestEy = entrances[0]!.surfaceTileY;
      let bestDist = Math.abs(tileX - bestEx) + Math.abs(tileY - bestEy);
      for (let e = 1; e < entrances.length; e++) {
        const ent = entrances[e]!;
        const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
        if (d < bestDist) {
          bestDist = d;
          bestEx = ent.surfaceTileX;
          bestEy = ent.surfaceTileY;
        }
      }
      outX = tileX - bestEx;
      outY = tileY - bestEy;
    }

    if (outX === 0 && outY === 0) {
      // Ant is standing on the entrance (or there are no entrances) — deal
      // an initial cardinal by antId so colony members fan out to four
      // different compass directions rather than all piling the same way.
      switch (antId & 3) {
        case 0:  hx =  1; hy =  0; break;
        case 1:  hx = -1; hy =  0; break;
        case 2:  hx =  0; hy =  1; break;
        default: hx =  0; hy = -1; break;
      }
    } else {
      const absX = outX < 0 ? -outX : outX;
      const absY = outY < 0 ? -outY : outY;
      let pickX: boolean;
      if (absX > absY) pickX = true;
      else if (absY > absX) pickX = false;
      else pickX = (antId & 1) === 0;

      if (pickX) {
        hx = outX > 0 ? 1 : -1;
        hy = 0;
      } else {
        hx = 0;
        hy = outY > 0 ? 1 : -1;
      }
    }

    ticks = EXCURSION_HEADING_MIN_TICKS + jitter;
  } else if (ticks <= 0) {
    // Turn-check expired. Three possible outcomes on a single turnRoll:
    //   [0, EXCURSION_TURN_PERCENT)                        → hard 90° turn
    //   [100 - EXCURSION_WOBBLE_PERCENT, 100)              → lateral wobble
    //                                                        (heading preserved,
    //                                                         one-tick side step)
    //   otherwise                                          → keep heading
    // The two branches MUST NOT overlap — this is enforced in constants.ts.
    // Wobble produces a single perpendicular step while leaving the committed
    // heading intact; the next tick continues outward along the original
    // cardinal, yielding a subtle meander without regressing to random walk
    // (09 excursion-foraging follow-up, issue 3).
    if (turnRoll < EXCURSION_TURN_PERCENT) {
      // Rotate 90° — left: (hx,hy) → (hy, -hx); right: (hx,hy) → (-hy, hx).
      if (turnDir === 0) {
        const nhx =  hy;
        const nhy = -hx;
        hx = nhx;
        hy = nhy;
      } else {
        const nhx = -hy;
        const nhy =  hx;
        hx = nhx;
        hy = nhy;
      }
      ticks = EXCURSION_HEADING_MIN_TICKS + jitter;
    } else if (turnRoll >= 100 - EXCURSION_WOBBLE_PERCENT) {
      // Lateral wobble — one-tick perpendicular step, heading preserved.
      // Perpendicular of (hx,hy) is (hy,-hx) (left) or (-hy,hx) (right).
      const lhx = turnDir === 0 ?  hy : -hy;
      const lhy = turnDir === 0 ? -hx :  hx;
      const nx = tileX + lhx;
      const ny = tileY + lhy;
      if (nx >= 0 && nx < SURFACE_GRID_WIDTH && ny >= 0 && ny < SURFACE_GRID_HEIGHT) {
        // Persist the (unchanged) heading and reset ticks — the NEXT turn-check
        // fires after another MIN+jitter run along the original heading.
        ants.searchHeadingX[antId] = hx;
        ants.searchHeadingY[antId] = hy;
        ants.searchHeadingTicks[antId] = EXCURSION_HEADING_MIN_TICKS + jitter;
        return { dx: lhx, dy: lhy };
      }
      // Lateral would step off-grid → fall through to keep-heading branch.
      ticks = EXCURSION_HEADING_MIN_TICKS + jitter;
    } else {
      // Keep heading, reset the turn-check clock.
      ticks = EXCURSION_HEADING_MIN_TICKS + jitter;
    }
  } else {
    ticks = ticks - 1;
  }

  // World-edge bounce: if the chosen cardinal would step off the surface
  // grid, rotate it 90° right deterministically until we find a valid one.
  // Cardinal-only movement on a rectangular grid always has at least two
  // valid options, so this converges in ≤ 3 rotations.
  for (let attempts = 0; attempts < 4; attempts++) {
    const nx = tileX + hx;
    const ny = tileY + hy;
    if (nx >= 0 && nx < SURFACE_GRID_WIDTH && ny >= 0 && ny < SURFACE_GRID_HEIGHT) break;
    const nhx = -hy;
    const nhy =  hx;
    hx = nhx;
    hy = nhy;
  }

  ants.searchHeadingX[antId] = hx;
  ants.searchHeadingY[antId] = hy;
  ants.searchHeadingTicks[antId] = ticks;

  return { dx: hx, dy: hy };
}

// ---------------------------------------------------------------------------
// tickExcursionBoundary — 09 excursion-foraging memo (+ follow-up)
//
// At step 9c (after tickSearchLeash, before step 10a idle-reassignment),
// manage the excursion ↔ ReturningToNest state flip for surface foragers.
//
// Two directions:
//   (a) SearchingFood ants past their current wave radius with NO higher
//       priority signal → flip to ReturningToNest, clear heading.
//   (b) ReturningToNest ants that encounter a higher priority signal →
//       flip back to SearchingFood, clear heading so the next excursion
//       derives a fresh outward direction.
//
// Higher-priority signals, evaluated in this order:
//   1. explicit priority food target (colony.priorityFoodPileId set)
//   2. direct food scent within FOOD_SCENT_RADIUS
//   3. useful food-trail pheromone within SIGNAL_PHEROMONE_RADIUS
//
// These mirror the priority order the movement step (tickAntMovement)
// consults — so the boundary pass never strands an ant that actually has
// somewhere useful to go (09 excursion-foraging follow-up, issue 1).
//
// This is distinct from (and complementary to) tickSearchLeash:
//   tickSearchLeash demotes stuck SearchingFood ants to Idle so the
//     behavior-triangle allocation can rebalance workers to dig/fight —
//     it only fires when the colony is over-foraged AND player wants
//     dig/fight work ("triangle responsiveness").
//   tickExcursionBoundary implements the bounded-excursion loop from the
//     memo: regardless of allocation, an ant that has searched past its
//     current wave radius and has NO signal heads home and resets.
//
// Per-ant state only — no colony-level known-food memory.
// ---------------------------------------------------------------------------

/**
 * Manhattan radius scanned around a forager for an "any pheromone present"
 * signal. Mirrors REACQUIRE_RADIUS in pheromone-system.ts — if this scan
 * returns true, sampleForagingDirection is guaranteed to return a non-zero
 * direction, so we must not flip the ant into ReturningToNest (or keep it
 * there). Kept as a local constant to avoid widening pheromone-system's
 * public surface for what is otherwise an internal implementation detail.
 */
const SIGNAL_PHEROMONE_RADIUS = 3;

/**
 * Return true if any pheromone cell in the REACQUIRE_RADIUS Manhattan
 * diamond around (tileX, tileY) has a nonzero strength that
 * sampleForagingDirection() could actually follow. Early exits on the first
 * usable hit; no RNG consumption, no mutation.
 *
 * Anti-backtrack alignment (09 excursion-foraging follow-up, issues 1 & 2):
 * this helper MUST match the candidate-rejection rules inside
 * sampleForagingDirection so tickExcursionBoundary's "hasSignal" decision
 * agrees with the sampler's "could I pick a move" decision. Two filters:
 *   1. Exact prev-tile skip — the ant's own just-left trail is never signal.
 *   2. Major-axis-step skip — a cell whose major-axis step from (tileX,tileY)
 *      lands on prev is a prev-side reacquire candidate; the sampler would
 *      reject it, so it must not hold the ant on SearchingFood either.
 * Without (2), pheromone two or three tiles "behind" an ant would keep it
 * over-leash forever even though the sampler returns {0,0} and the ant has
 * no real follow-target — an exact repeat of the far-from-nest stutter.
 *
 * Pass prevTileX = prevTileY = -1 when the ant has no prev tile; the
 * function then behaves as a plain nonzero-within-radius scan.
 */
function hasNearbyPheromoneSignal(
  grid: PheromoneGrid,
  tileX: number,
  tileY: number,
  prevTileX: number = -1,
  prevTileY: number = -1,
): boolean {
  const hasPrev = prevTileX >= 0 && prevTileY >= 0;
  for (let dy = -SIGNAL_PHEROMONE_RADIUS; dy <= SIGNAL_PHEROMONE_RADIUS; dy++) {
    const absY = dy < 0 ? -dy : dy;
    const xRange = SIGNAL_PHEROMONE_RADIUS - absY;
    for (let dx = -xRange; dx <= xRange; dx++) {
      if (dx === 0 && dy === 0) continue;
      const sx = tileX + dx;
      const sy = tileY + dy;
      if (hasPrev && sx === prevTileX && sy === prevTileY) continue;
      // Major-axis candidate filter — mirrors sampleForagingDirection's
      // reacquire-layer skip. For dist==1 immediate neighbors the major-axis
      // step equals the cell itself, which the exact-coord check above
      // already handles, so this branch only prunes dist>=2 cells whose
      // first step would route through prev.
      if (hasPrev) {
        const absX = dx < 0 ? -dx : dx;
        const stepX = absX >= absY ? (dx > 0 ? 1 : dx < 0 ? -1 : 0) : 0;
        const stepY = absX >= absY ? 0 : (dy > 0 ? 1 : dy < 0 ? -1 : 0);
        if (tileX + stepX === prevTileX && tileY + stepY === prevTileY) continue;
      }
      if (phGet(grid, sx, sy) > 0) return true;
    }
  }
  return false;
}

/**
 * Return true if the colony has a priority food pile id pointing at an
 * extant pile — the player-marked target routeForagerPriority propagates to
 * targetPosX/Y at step 13. Checked directly (not via targetPosX) so the
 * answer is correct for ReturningToNest ants too, whose targetPosX is not
 * refreshed by routeForagerPriority.
 */
function colonyHasPriorityPile(world: WorldState, colonyId: number): boolean {
  const colony = world.colonies[colonyId];
  if (!colony || colony.priorityFoodPileId === null) return false;
  const pileId = colony.priorityFoodPileId;
  for (let p = 0; p < world.foodPiles.length; p++) {
    if (world.foodPiles[p]!.foodPileId === pileId) return true;
  }
  return false;
}

/**
 * Step-9c — excursion boundary state flip with priority-aware skipping.
 *
 * Only affects surface Foraging ants in SearchingFood or ReturningToNest.
 *
 * SearchingFood over-leash rule: if the ant is past
 * SEARCH_LEASH_RADII[searchWave] AND has NO priority target, scent, or
 * pheromone signal, flip to ReturningToNest and clear heading. If any signal
 * is present the ant stays SearchingFood — the movement step will follow it.
 *
 * ReturningToNest breakout rule: if a ReturningToNest ant has ANY priority
 * target, scent, or pheromone signal, flip back to SearchingFood and clear
 * heading so the next excursion re-derives an outward direction. This stops
 * the boundary pass from overriding meaningful food signals an ant picks up
 * en route home (09 excursion-foraging follow-up, issue 1).
 *
 * The wave counter is NOT incremented here — that happens on the return
 * side when the ant actually reaches the entrance (see tickAntMovement
 * Surface zone-transition block). An ant that picks up food en route via
 * tickForagerActions bypasses ReturningToNest entirely and resets wave to 0.
 *
 * @param world  WorldState (reads ants, colonies, foodPiles, pheromoneGrids;
 *               writes ants.subTask, searchHeadingX/Y/Ticks).
 */
export function tickExcursionBoundary(world: WorldState): void {
  const ants = world.ants;

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;
    if (ants.zone[id] !== Zone.Surface) continue;
    const sub = ants.subTask[id]!;
    if (sub !== ForagingSubState.SearchingFood && sub !== ForagingSubState.ReturningToNest) continue;

    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId];
    if (!colony || !colony.entrances || colony.entrances.length === 0) continue;

    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    // Signal detection — priority target > scent > pheromone (09 follow-up).
    const hasPriority = colonyHasPriorityPile(world, colonyId);
    const hasScent = hasPriority ? false : findNearestScentPile(world, tileX, tileY) !== null;
    let hasPheromone = false;
    if (!hasPriority && !hasScent) {
      const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
      const grid = world.pheromoneGrids[key];
      if (grid) {
        // 09 follow-up issue 2: skip the ant's prev tile so its own just-left
        // trail doesn't count as "signal" and trap it in ReturningToNest
        // purgatory. Sentinels (-1,-1) are treated as "no prev" by the helper.
        hasPheromone = hasNearbyPheromoneSignal(
          grid,
          tileX,
          tileY,
          ants.searchPrevTileX[id]!,
          ants.searchPrevTileY[id]!,
        );
      }
    }
    const hasSignal = hasPriority || hasScent || hasPheromone;

    if (sub === ForagingSubState.ReturningToNest) {
      // Breakout: a returning ant that now senses food or a trail should go
      // search/follow rather than complete the return leg.
      if (hasSignal) {
        ants.subTask[id] = ForagingSubState.SearchingFood;
        ants.searchHeadingX[id] = 0;
        ants.searchHeadingY[id] = 0;
        ants.searchHeadingTicks[id] = 0;
        ants.searchPrevTileX[id] = -1;
        ants.searchPrevTileY[id] = -1;
      }
      continue;
    }

    // sub === SearchingFood: boundary check.
    if (hasSignal) continue; // priority/scent/pheromone overrides the boundary.

    let bestDist = -1;
    for (let e = 0; e < colony.entrances.length; e++) {
      const ent = colony.entrances[e]!;
      const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
      if (bestDist < 0 || d < bestDist) bestDist = d;
    }
    if (bestDist < 0) continue;

    let wave = ants.searchWave[id]!;
    if (wave < 0) wave = 0;
    if (wave > SEARCH_LEASH_MAX_WAVE) wave = SEARCH_LEASH_MAX_WAVE;
    const radius = SEARCH_LEASH_RADII[wave]!;

    if (bestDist <= radius) continue;

    ants.subTask[id] = ForagingSubState.ReturningToNest;
    ants.searchHeadingX[id] = 0;
    ants.searchHeadingY[id] = 0;
    ants.searchHeadingTicks[id] = 0;
    ants.searchPrevTileX[id] = -1;
    ants.searchPrevTileY[id] = -1;
  }
}

/**
 * Manhattan radius within which a SearchingFood forager can sense a food pile
 * directly and head toward it, bypassing the pheromone gradient. This is the
 * local-discovery mechanism the 09 foraging-autonomy memo calls for: with only
 * a handful of workers per colony, pure random diffusion rarely strikes a
 * single-tile pile before the queen starves. Short-range scent gives the last
 * few tiles of approach determinism without making food designation irrelevant
 * — piles beyond this radius still require trail-following or exploration.
 */
const FOOD_SCENT_RADIUS = 15;

/**
 * Return the tile coords of the nearest food pile within FOOD_SCENT_RADIUS
 * Manhattan of (tileX, tileY), or null if none. Ties broken by foodPileId
 * (lowest first) for determinism.
 */
function findNearestScentPile(
  world: WorldState,
  tileX: number,
  tileY: number,
): { tileX: number; tileY: number } | null {
  let bestDist = FOOD_SCENT_RADIUS + 1;
  let bestId = -1;
  let bestX = 0;
  let bestY = 0;
  for (let p = 0; p < world.foodPiles.length; p++) {
    const pile = world.foodPiles[p]!;
    const d = Math.abs(pile.tileX - tileX) + Math.abs(pile.tileY - tileY);
    if (d >= bestDist) continue;
    if (d > FOOD_SCENT_RADIUS) continue;
    bestDist = d;
    bestId = pile.foodPileId;
    bestX = pile.tileX;
    bestY = pile.tileY;
    continue;
  }
  // Tie-break pass — if a pile is at the same bestDist as another, prefer lowest id.
  if (bestId === -1) return null;
  for (let p = 0; p < world.foodPiles.length; p++) {
    const pile = world.foodPiles[p]!;
    const d = Math.abs(pile.tileX - tileX) + Math.abs(pile.tileY - tileY);
    if (d === bestDist && pile.foodPileId < bestId) {
      bestId = pile.foodPileId;
      bestX = pile.tileX;
      bestY = pile.tileY;
    }
  }
  return { tileX: bestX, tileY: bestY };
}

// ---------------------------------------------------------------------------
// tickPheromoneDeposit — PRD §8a step 10 + §5b carry-only rule (PHER-03)
//
// Iterates 0..world.nextEntityId. For each alive ant with foodCarrying > 0,
// computes tile position via >> FP_SHIFT, constructs the pheromoneGridKey,
// looks up the grid, and calls depositFoodTrail.
//
// If the grid is missing, the deposit is silently skipped (scenario-dependent presence).
// Dead slots (alive !== 1) are skipped. Non-carrying ants (foodCarrying <= 0) are skipped.
//
// 09 excursion-foraging follow-up (issue 2): deposits WITHIN
// ENTRANCE_DEPOSIT_SUPPRESS_RADIUS Manhattan tiles of any own-colony entrance
// are suppressed. Multiple carrying ants passing the same few tiles at the
// entrance mouth otherwise build a strong local scalar peak that greedy
// gradient-following turns into two-tile oscillation, trapping searchers
// near the nest. Suppressing the entrance-adjacent deposits keeps the
// useful trail peak out along the path toward food, not on the nest tile.
//
// O(nextEntityId * entrances_per_colony) — entrances count is bounded by
// MAX_ENTRANCES_PER_COLONY so the extra work is O(N) in ant count.
// ---------------------------------------------------------------------------

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

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.foodCarrying[id]! <= 0) continue;

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

    depositFoodTrail(grid, tileX, tileY);
  }
}

// ---------------------------------------------------------------------------
// canEnterUndergroundTile — underground movement passability predicate
//
// Non-digging ants must not cut through Solid dirt to reach chambers, food, or
// entrances — the only way through solid ground is a tunnel excavated by a
// Digger. The underground movement paths in tickAntMovement all pick a target
// (nearest FoodStorage tile, entrance, Queen/Nursery chamber) and derive a
// Manhattan unit step toward it; without this guard a carrying forager or a
// nurse would walk diagonally through dirt to reach its target.
//
// Rules:
//   Out-of-bounds: blocked (the per-tick bounds clamp would normally handle
//                  this, but the predicate is defensive).
//   Open:          passable for all tasks.
//   BeingDug:      passable for all tasks (mechanically a pit; the owning
//                  Digger reads direction=-1 and stays put anyway).
//   Marked:        passable only for AntTask.Digging — the flow-field routes
//                  the digger to step onto the Marked tile so it can claim it
//                  via tickDigExecution.
//   Solid:         blocked for all tasks. A Digger reaches Solid only via a
//                  Marked claim, never by walking onto raw dirt.
// ---------------------------------------------------------------------------

export function canEnterUndergroundTile(
  underground: UndergroundGrid,
  tileX: number,
  tileY: number,
  task: AntTask,
): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= underground.width || tileY >= underground.height) {
    return false;
  }
  const state = ugGet(underground, tileX, tileY);
  if (state === UndergroundTileState.Open || state === UndergroundTileState.BeingDug) {
    return true;
  }
  if (state === UndergroundTileState.Marked) {
    return task === AntTask.Digging;
  }
  return false; // Solid (and any future state): impassable for every task
}

// ---------------------------------------------------------------------------
// pickNearestHostileUnderground — Phase 09.1 Chunk 3 invasion routing helper
//
// Returns the fixed-point target position of the nearest hostile ant that is
// underground in the given grid (Manhattan distance). A "hostile" is any
// alive ant whose owning colony differs from the caller's and who currently
// occupies `gridColonyId` (i.e. is inside the same underground grid).
//
// Used by Fighting invaders inside a foreign grid: their own-colony flow
// fields don't guide them toward the enemy queen, so they substitute a
// Manhattan nearest-hostile step while the proper fight-flow-field work is
// deferred to Chunk 5. Returns null if no hostile is present — caller must
// choose a fallback (idle, wander, retreat, etc.).
//
// Pure: reads ants SoA only. No PRNG calls. No wall-clock. Deterministic —
// iteration order is ascending entity id, ties broken by first-seen (strict
// `<` comparison preserves the lowest-id candidate on equal distances).
// ---------------------------------------------------------------------------

/**
 * Manhattan nearest-hostile underground target selector.
 *
 * @param ants           SoA ant component storage.
 * @param selfId         EntityId of the caller (must be alive and underground).
 * @param gridColonyId   Underground-grid id the caller occupies
 *                       (ants.currentGridColonyId[selfId]). Hostiles in OTHER
 *                       grids are ignored — both the caller and the target
 *                       must share the same grid-of-occupancy.
 * @returns              Fixed-point {targetX, targetY} of the nearest hostile,
 *                       or null if no underground hostile shares the grid.
 */
export function pickNearestHostileUnderground(
  ants: AntComponents,
  selfId: number,
  gridColonyId: number,
): { targetX: number; targetY: number } | null {
  const selfColony = ants.colonyId[selfId]!;
  const selfPosX = ants.posX[selfId]!;
  const selfPosY = ants.posY[selfId]!;
  const selfTileX = selfPosX >> FP_SHIFT;
  const selfTileY = selfPosY >> FP_SHIFT;

  let bestPosX = 0;
  let bestPosY = 0;
  let bestDist = -1;

  // alive.length is a safe upper bound for iteration. Post-death slots read
  // alive=0 and are skipped. No allocation inside the loop.
  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1) continue;
    if (id === selfId) continue;
    if (ants.zone[id] !== Zone.Underground) continue;
    if (ants.currentGridColonyId[id] !== gridColonyId) continue;
    if (ants.colonyId[id] === selfColony) continue;

    const theirTileX = ants.posX[id]! >> FP_SHIFT;
    const theirTileY = ants.posY[id]! >> FP_SHIFT;
    const dx = theirTileX - selfTileX;
    const dy = theirTileY - selfTileY;
    const dist = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
    if (bestDist < 0 || dist < bestDist) {
      bestDist = dist;
      bestPosX = ants.posX[id]!;
      bestPosY = ants.posY[id]!;
    }
  }

  if (bestDist < 0) return null;
  return { targetX: bestPosX, targetY: bestPosY };
}

// ---------------------------------------------------------------------------
// P1 queen relocation — Phase 3 chamber behavior.
//
// Once a completed Queen chamber exists, the queen routes from her current
// tile to the Queen chamber footprint and remains there. She routes surface →
// open entrance → underground → Queen chamber Open tile through the existing
// flow-field machinery so she never steps through Solid / Marked dirt.
//
// Queens never return to the surface once they've descended. Eggs laid while
// the queen is in transit (i.e. Queen chamber exists but queen is not yet
// inside the footprint) are suppressed by tickQueenEggProduction — see its
// Gate 6 in lifecycle-system.ts.
// ---------------------------------------------------------------------------

function collectAliveQueenIds(world: WorldState): Set<number> | null {
  // Only skip ants that the relocation pass actually drives. That requires a
  // completed Queen chamber AND task=Idle (the queen's canonical task). This
  // narrowing matters for test fixtures where the colony's queenEntityId
  // placeholder may point at a non-queen entity (e.g. setupForagerWorld uses
  // entity 0 as a forager and createColonyRecord(..., 0) as the queen slot).
  // Without a Queen chamber moveQueens is a no-op, so the main loop must
  // remain responsible for moving that entity.
  let set: Set<number> | null = null;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const qId = colony.queenEntityId;
    if (world.ants.alive[qId] !== 1) continue;
    if (world.ants.task[qId] !== AntTask.Idle) continue;
    if (!hasCompletedChamber(colony, ChamberType.Queen)) continue;
    if (set === null) set = new Set<number>();
    set.add(qId);
  }
  return set;
}

/**
 * True if tile (tileX, tileY) lies inside any completed Queen chamber
 * footprint in `colony`. Inclusive of the anchor tile; exclusive of tiles at
 * anchor + dims boundary (the footprint is [anchor, anchor + dims)).
 */
function isInsideQueenChamber(colony: ColonyRecord, tileX: number, tileY: number): boolean {
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Queen) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    if (tileX >= bx && tileX < bx + ch.width && tileY >= by && tileY < by + ch.height) return true;
  }
  return false;
}

/**
 * Move every alive colony queen one step toward (or around inside) her Queen chamber.
 *
 * No Queen chamber → queen holds (initial state — any starting position is
 * the "home" position for Phase 3 playability).
 * Queen already inside Queen chamber footprint → wander deterministically
 * between chamber Open tiles, advancing the target every QUEEN_EGG_INTERVAL_TICKS.
 * (Issue #16: prevents her sticking in whichever corner the flow-field first
 * delivered her to; also spreads brood across the chamber since eggs spawn
 * at the queen's current tile.)
 * Surface → step toward nearest OPEN entrance; descend when on the entrance
 * tile (Surface → Underground, posY = 0).
 * Underground → consume the per-colony `queen` chamber flow-field; fall back
 * to Manhattan step toward the nearest Queen-chamber Open tile when the
 * cache is absent (test harness path).
 *
 * Queens NEVER return to the surface once underground. Their passability
 * uses AntTask.Idle rules (blocks Solid + Marked) — the queen is not a
 * digger and must never cut through dirt.
 */
function moveQueens(
  world: WorldState,
  queenIds: Set<number> | null,
  entranceFlowFields?: EntranceFlowFields,
  chamberFlowFields?: ChamberFlowFields,
): void {
  void entranceFlowFields; // entrance steering for queens uses Manhattan — no flow-field needed on surface.
  if (queenIds === null || queenIds.size === 0) return;

  const ants = world.ants;
  const surfaceMaxX = (SURFACE_GRID_WIDTH << FP_SHIFT) - 1;
  const surfaceMaxY = (SURFACE_GRID_HEIGHT << FP_SHIFT) - 1;
  const undergroundMaxX = (UNDERGROUND_GRID_WIDTH << FP_SHIFT) - 1;
  const undergroundMaxY = (UNDERGROUND_GRID_HEIGHT << FP_SHIFT) - 1;

  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const qId = colony.queenEntityId;
    if (!queenIds.has(qId)) continue;

    // Gate: no completed Queen chamber → queen holds at her current tile.
    if (!hasCompletedChamber(colony, ChamberType.Queen)) continue;

    const zone = ants.zone[qId]!;
    const prevPosX = ants.posX[qId]!;
    const prevPosY = ants.posY[qId]!;
    const tileX = prevPosX >> FP_SHIFT;
    const tileY = prevPosY >> FP_SHIFT;

    let dx = 0;
    let dy = 0;

    // Issue #16 — once the queen is inside her chamber, drift between Open
    // tiles instead of holding wherever the flow-field first delivered her
    // (always a corner). Cycles deterministically every QUEEN_EGG_INTERVAL_TICKS
    // so the target advances each egg-laying interval. Eggs spawn at her
    // current tile (lifecycle-system.ts), so the wander also distributes
    // brood across the chamber footprint.
    const isAlreadyHome = zone === Zone.Underground && isInsideQueenChamber(colony, tileX, tileY);
    if (isAlreadyHome) {
      const underground = world.undergroundGrids[ants.currentGridColonyId[qId]!];
      if (!underground) continue;
      let openCount = 0;
      for (let c = 0; c < colony.chambers.length; c++) {
        const ch = colony.chambers[c]!;
        if (ch.chamberType !== ChamberType.Queen) continue;
        const bx = ch.posX >> FP_SHIFT;
        const by = ch.posY >> FP_SHIFT;
        for (let ty = 0; ty < ch.height; ty++) {
          for (let tx = 0; tx < ch.width; tx++) {
            if (ugGet(underground, bx + tx, by + ty) === UndergroundTileState.Open) openCount++;
          }
        }
      }
      if (openCount === 0) continue;
      // `| 0` performs ECMA-262 ToInt32 — bit-identical across V8/JSC/SpiderMonkey
      // and integer-exact for any quotient that fits in Int32. The cast wraps
      // negative once `tick / interval` exceeds 2^31, i.e. tick > 2^31 × 300
      // ≈ 6.4×10^11 ticks (~1000 years at 20Hz). `((x % n) + n) % n` folds the
      // wrap deterministically back into [0, openCount) so the indexed match
      // below never falls off the end.
      // eslint-disable-next-line no-restricted-syntax -- integer division via `| 0`; tick / interval is integer arithmetic, not fixed-point math
      const cycleIndex = (world.tick / QUEEN_EGG_INTERVAL_TICKS) | 0;
      const targetIndex = ((cycleIndex % openCount) + openCount) % openCount;
      let i = 0;
      let targetTileX = -1;
      let targetTileY = -1;
      for (let c = 0; c < colony.chambers.length && targetTileX < 0; c++) {
        const ch = colony.chambers[c]!;
        if (ch.chamberType !== ChamberType.Queen) continue;
        const bx = ch.posX >> FP_SHIFT;
        const by = ch.posY >> FP_SHIFT;
        for (let ty = 0; ty < ch.height && targetTileX < 0; ty++) {
          for (let tx = 0; tx < ch.width; tx++) {
            const cx = bx + tx;
            const cy = by + ty;
            if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
            if (i === targetIndex) {
              targetTileX = cx;
              targetTileY = cy;
              break;
            }
            i++;
          }
        }
      }
      if (targetTileX < 0) continue;
      if (targetTileX === tileX && targetTileY === tileY) continue;
      const rawDx = targetTileX - tileX;
      const rawDy = targetTileY - tileY;
      if (Math.abs(rawDx) >= Math.abs(rawDy)) {
        dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
      } else {
        dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
      }
    } else if (zone === Zone.Surface) {
      // Pre-move descent: if the queen is already standing on one of her
      // colony's OPEN entrance tiles, descend immediately rather than computing
      // a (0,0) Manhattan delta and bailing via the zero-delta early return.
      // Debug case: starter colony spawns the queen on the entrance tile with a
      // completed Queen chamber already in place — without this short-circuit
      // she would sit on the entrance forever and Gate 6 would block egg
      // production indefinitely.
      for (let e = 0; e < colony.entrances.length; e++) {
        const entrance = colony.entrances[e]!;
        if (!entrance.isOpen) continue;
        if (entrance.surfaceTileX !== tileX || entrance.surfaceTileY !== tileY) continue;
        ants.zone[qId] = Zone.Underground;
        // Phase 09.1 Chunk 0 — descent invariant: the entrance-owning colony
        // dictates the queen's occupied grid. Queens never invade, so this
        // is a byte-identical no-op today (colony.colonyId === own).
        ants.currentGridColonyId[qId] = colony.colonyId;
        ants.posY[qId] = 0;
        // posX preserved (entrance shaft is the same column); next tick the
        // underground branch steers her toward the Queen chamber via the
        // queen flow-field.
        break;
      }
      if (ants.zone[qId] === Zone.Underground) continue;

      // Route to the nearest OPEN entrance. Deterministic tie-break:
      // smallest entranceId wins (same rule tickAntMovement uses).
      let bestDist = -1;
      let bestId = -1;
      let targetTileX = -1;
      let targetTileY = -1;
      for (let e = 0; e < colony.entrances.length; e++) {
        const ent = colony.entrances[e]!;
        if (!ent.isOpen) continue;
        const d = Math.abs(ent.surfaceTileX - tileX) + Math.abs(ent.surfaceTileY - tileY);
        if (bestDist < 0 || d < bestDist || (d === bestDist && ent.entranceId < bestId)) {
          bestDist = d;
          bestId = ent.entranceId;
          targetTileX = ent.surfaceTileX;
          targetTileY = ent.surfaceTileY;
        }
      }
      if (targetTileX < 0) continue; // no open entrance — queen cannot descend yet.
      const rawDx = targetTileX - tileX;
      const rawDy = targetTileY - tileY;
      if (Math.abs(rawDx) >= Math.abs(rawDy)) {
        dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
      } else {
        dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
      }
    } else {
      // Underground → follow the queen flow-field (seeded only from Queen
      // chamber Open tiles). A Nursery-only chamber tile must NOT be a
      // resting target for the queen, so we never consume the nursing field
      // here.
      //
      // Phase 09.1 Chunk 0: queens never invade, so ants.currentGridColonyId[qId]
      // always equals colony.colonyId. Still, the grid lookup keys off the
      // queen's occupancy byte to match the invariant "all ant grid lookups
      // route through currentGridColonyId" (consistency with foragers/
      // nurses/diggers refactored above).
      const underground = world.undergroundGrids[ants.currentGridColonyId[qId]!];
      if (!underground) continue;

      let stepped = false;
      if (chamberFlowFields) {
        const flowField = chamberFlowFields.queen[colony.colonyId];
        if (flowField) {
          const idx = tileY * underground.width + tileX;
          const dir = flowField[idx]!;
          if (dir === -1) {
            // On a Queen chamber Open tile — isInsideQueenChamber covers this
            // earlier in the function, but the flow-field may still report
            // -1 on a queen-chamber Marked-tile-turned-Open boundary race.
            continue;
          }
          if (dir === -2) {
            // Unreachable — failsafe: hold. The queen cannot cut through
            // dirt. Once a digger excavates the intervening tile, dirty
            // flag will recompute the field.
            continue;
          }
          if (dir >= 0 && dir < 4) {
            dx = DIR_DX[dir]!;
            dy = DIR_DY[dir]!;
            stepped = true;
          }
        }
      }

      if (!stepped) {
        // No cache or no field yet — Manhattan fallback: nearest Queen
        // chamber Open tile.
        let bestDist = -1;
        let targetTileX = -1;
        let targetTileY = -1;
        for (let c = 0; c < colony.chambers.length; c++) {
          const ch = colony.chambers[c]!;
          if (ch.chamberType !== ChamberType.Queen) continue;
          const bx = ch.posX >> FP_SHIFT;
          const by = ch.posY >> FP_SHIFT;
          for (let ty = 0; ty < ch.height; ty++) {
            for (let tx = 0; tx < ch.width; tx++) {
              const cx = bx + tx;
              const cy = by + ty;
              if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
              const d = Math.abs(cx - tileX) + Math.abs(cy - tileY);
              if (bestDist < 0 || d < bestDist) {
                bestDist = d;
                targetTileX = cx;
                targetTileY = cy;
              }
            }
          }
        }
        if (targetTileX < 0) continue;
        const rawDx = targetTileX - tileX;
        const rawDy = targetTileY - tileY;
        if (Math.abs(rawDx) >= Math.abs(rawDy)) {
          dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
        } else {
          dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
        }
      }
    }

    if (dx === 0 && dy === 0) continue;

    const speed = ants.speed[qId]!;
    let posX = prevPosX + dx * speed;
    let posY = prevPosY + dy * speed;

    // Underground passability guard — queen uses AntTask.Idle rules, so
    // Solid and Marked are both blocked. She can only traverse Open and
    // BeingDug tiles, guaranteeing no dirt-cutting.
    //
    // Phase 09.1 Chunk 0: keys off currentGridColonyId for consistency with
    // the invariant. Queens never invade, so same grid as colony.colonyId
    // today.
    if (zone === Zone.Underground) {
      const underground = world.undergroundGrids[ants.currentGridColonyId[qId]!];
      if (underground) {
        const newTileX = posX >> FP_SHIFT;
        const newTileY = posY >> FP_SHIFT;
        if (newTileX !== tileX || newTileY !== tileY) {
          if (!canEnterUndergroundTile(underground, newTileX, newTileY, AntTask.Idle)) {
            posX = prevPosX;
            posY = prevPosY;
          }
        }
      }
    }

    // Clamp to zone bounds
    if (zone === Zone.Underground) {
      if (posX < 0) posX = 0; else if (posX > undergroundMaxX) posX = undergroundMaxX;
      if (posY < 0) posY = 0; else if (posY > undergroundMaxY) posY = undergroundMaxY;
    } else {
      if (posX < 0) posX = 0; else if (posX > surfaceMaxX) posX = surfaceMaxX;
      if (posY < 0) posY = 0; else if (posY > surfaceMaxY) posY = surfaceMaxY;
    }

    ants.posX[qId] = posX;
    ants.posY[qId] = posY;

    // Zone transition — Surface → Underground only. Queens never return to
    // the surface once they descend.
    if (zone === Zone.Surface) {
      const newTileX = posX >> FP_SHIFT;
      const newTileY = posY >> FP_SHIFT;
      for (let e = 0; e < colony.entrances.length; e++) {
        const entrance = colony.entrances[e]!;
        if (entrance.isOpen && entrance.surfaceTileX === newTileX && entrance.surfaceTileY === newTileY) {
          ants.zone[qId] = Zone.Underground;
          // Plan 09.1-00: every Surface→Underground transition must update
          // currentGridColonyId so the descending queen resolves to its own
          // colony's grid. Byte-identical today (queens never invade) but
          // required by the invariant for uniform downstream lookups.
          ants.currentGridColonyId[qId] = colony.colonyId;
          ants.posY[qId] = 0;
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tickAntMovement — PRD §8a step 16 (zone-aware, SURF-05)
//
// For each alive ant:
//   - Foragers: check targetPosX/Y for priority target; otherwise use pheromone gradient.
//   - Non-foragers: call pure getTaskDirection(world, id, digFlowFields) → {dx, dy}.
//     (No dig state transitions here — those are in tickDigExecution at step 10.)
//   - Update posX += dx * speed, posY += dy * speed.
//   - Underground passability guard (canEnterUndergroundTile) blocks the step
//     when the new integer tile would be Solid (or Marked for non-diggers).
//   - Clamp posX/posY to zone-appropriate bounds (Surface or Underground).
//   - Apply zone transitions (Surface ↔ Underground) via open entrances (PRD §5d).
//
// Bounds use << instead of *: (GRID_WIDTH << FP_SHIFT) - 1.
// No Math.floor, no floats, no division. Clamp uses if/else for zero alloc.
// ---------------------------------------------------------------------------

/**
 * Move every alive ant one step based on its current task and zone.
 *
 * Foragers sample the pheromone gradient (or follow priority target if set).
 * Non-foragers receive direction from pure getTaskDirection.
 * Position is clamped to zone-appropriate grid bounds after movement.
 * Zone transitions applied after position update (PRD §5d — Pitfall 6).
 *
 * IMPORTANT: tickDigExecution MUST have already run this tick (step 10).
 * This function MUST NOT perform any dig state transitions — it only moves ants.
 *
 * @param world          WorldState (reads + writes ants, reads pheromoneGrids, undergroundGrids, colonies).
 * @param rng            WorldState Rng instance (passed explicitly — no singletons).
 * @param digFlowFields       Per-colony flow-field cache (passed to getTaskDirection for dig workers).
 * @param entranceFlowFields  Optional per-colony flow-field cache seeded from open
 *                            entrance underground tiles. When provided, underground
 *                            zone-transitioning ants read this field to avoid
 *                            straight-line steering into solid dirt on bent tunnels.
 *                            Tests that don't exercise underground entrance routing
 *                            may omit this parameter.
 * @param chamberFlowFields   Optional per-colony chamber flow-field cache. When
 *                            provided, underground carrying foragers consume the
 *                            `food` field (FoodStorage target) and Nursing ants
 *                            consume the `nursing` field (Queen/Nursery target)
 *                            instead of straight-line chamber steering. Tests that
 *                            don't exercise underground chamber routing may omit it.
 */
export function tickAntMovement(
  world: WorldState,
  rng: Rng,
  digFlowFields: DigFlowFields,
  entranceFlowFields?: EntranceFlowFields,
  chamberFlowFields?: ChamberFlowFields,
): void {
  const ants = world.ants;
  const surfaceMaxX = (SURFACE_GRID_WIDTH << FP_SHIFT) - 1;
  const surfaceMaxY = (SURFACE_GRID_HEIGHT << FP_SHIFT) - 1;
  const undergroundMaxX = (UNDERGROUND_GRID_WIDTH << FP_SHIFT) - 1;
  const undergroundMaxY = (UNDERGROUND_GRID_HEIGHT << FP_SHIFT) - 1;

  // P1 queen-relocation: queens have their own movement path (route to Queen
  // chamber). They must be skipped in the main loop below so the default
  // Idle-task branch (which triggers needsSurface zone-transition) does not
  // yank a relocated queen back to the surface. Collect the ID set up front.
  const queenIds = collectAliveQueenIds(world);
  moveQueens(world, queenIds, entranceFlowFields, chamberFlowFields);

  // Same-colony occupancy enforcement is applied as a POST-PASS after the
  // movement loop — see resolveSameColonyOccupancy below. The in-loop
  // check (the previous revision) only saw already-processed ants, so a
  // lower-id ant could move onto a higher-id ant that had not yet been
  // processed. The post-pass walks every live ant in entity-id order after
  // all moves and zone transitions are committed, so every collision
  // (mobile-into-mobile, mobile-into-stationary, pre-existing stationary
  // duplicate) is visible at resolution time.

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (queenIds !== null && queenIds.has(id)) continue; // queen moved above

    const task = ants.task[id]!;
    const zone = ants.zone[id]!;
    const foodCarrying = ants.foodCarrying[id]!;
    let dx = 0;
    let dy = 0;

    // --- PRD §4d Food Storage chamber routing (underground carrying foragers) ---
    // Underground + Foraging + foodCarrying > 0 → target the nearest OPEN tile
    // inside any FoodStorage chamber footprint (Manhattan from ant's tile).
    // If the colony has no FoodStorage chamber, fall through to entrance targeting
    // below — the ant routes to the underground side of the nearest open entrance
    // (tileY=0 at entrance column) per PRD §4d fallback.
    // Tie-break is deterministic: first chamber in colony.chambers array order,
    // then row-major tile iteration — stable across ticks given stable inputs.
    let chamberTargetX = -1;
    let chamberTargetY = -1;
    if (
      zone === Zone.Underground &&
      task === AntTask.Foraging &&
      foodCarrying > 0
    ) {
      // colonyId keys the OWN-colony record (carriers deposit into their own
      // FoodStorage chambers — foragers never invade). gridColonyId keys the
      // underground grid the ant currently occupies (Phase 09.1 Chunk 0);
      // today both are identical.
      const colonyId = ants.colonyId[id]!;
      const gridColonyId = ants.currentGridColonyId[id]!;
      const colony = world.colonies[colonyId];
      const underground = world.undergroundGrids[gridColonyId];
      if (colony && underground) {
        const antTileX = ants.posX[id]! >> FP_SHIFT;
        const antTileY = ants.posY[id]! >> FP_SHIFT;
        let bestDist = -1;
        for (let c = 0; c < colony.chambers.length; c++) {
          const chamber = colony.chambers[c]!;
          // Issue #15 follow-up — skip saturated chambers in fallback target
          // selection too, mirroring the food flow-field's seed exclusion in
          // tick.ts step 9. The flow-field is the primary path; this Manhattan
          // fallback only fires when the chamberFlowFields cache is absent
          // (test harnesses) — both paths must agree on which chambers are
          // valid deposit targets, otherwise the fallback would route a
          // carrier into a saturated chamber it would refuse to deposit into.
          if (!isFoodChamberDepositable(chamber)) continue;
          const baseX = chamber.posX >> FP_SHIFT;
          const baseY = chamber.posY >> FP_SHIFT;
          for (let ty = 0; ty < chamber.height; ty++) {
            for (let tx = 0; tx < chamber.width; tx++) {
              const cx = baseX + tx;
              const cy = baseY + ty;
              if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
              const dist = Math.abs(cx - antTileX) + Math.abs(cy - antTileY);
              if (bestDist < 0 || dist < bestDist) {
                bestDist = dist;
                chamberTargetX = cx << FP_SHIFT;
                chamberTargetY = cy << FP_SHIFT;
              }
            }
          }
        }
      }
    }

    // --- PRD §5c entrance targeting (zone-transitioning ants) ---
    // Surface→Underground: Digging, Nursing, or Foraging+CarryingFood.
    // Underground→Surface: Foraging+SearchingFood (foodCarrying=0), or Fighting.
    // Underground+Foraging+CarryingFood also computes an entrance target — it
    // serves as the fallback path when (a) no FoodStorage chamber exists
    // (PRD §4d fallback) or (b) FoodStorage exists but the chamber flow-field
    // reports it unreachable from the ant's current tile.
    // Target the nearest OPEN entrance (Manhattan; lower entranceId breaks ties).
    // Step overrides any priority target set by routeForagerPriority (step 13) —
    // only SearchingFood surface foragers (non-transitioning) keep that target.
    let entranceTargetX = -1;
    let entranceTargetY = -1;
    {
      let needsTransition = false;
      if (zone === Zone.Surface) {
        // 09 excursion-foraging memo — ReturningToNest foragers share the
        // entrance-routing path. The Surface→Underground descent logic
        // further down (zone-transition block) is gated on CarryingFood, so
        // a ReturningToNest ant arriving at the entrance tile stays on the
        // surface and flips back to SearchingFood there.
        needsTransition =
          task === AntTask.Digging ||
          task === AntTask.Nursing ||
          (task === AntTask.Foraging && foodCarrying > 0) ||
          (task === AntTask.Foraging &&
           ants.subTask[id] === ForagingSubState.ReturningToNest);
      } else {
        // Zone.Underground — underground carriers compute an entrance target
        // whether or not a FoodStorage chamber exists, so the chamber-flow
        // unreachable failsafe has a fallback ready.
        //
        // Phase 09.1 Chunk 3 — Fighting ants in a FOREIGN grid are invaders,
        // not exfiltrating. They target hostiles via pickNearestHostileUnderground
        // in the Fighting branch below, NOT the own-colony entrance. Only
        // Fighters in their OWN grid (the normal surface→underground Fighter
        // path, or a returning invader who exited and re-entered home) route
        // toward the own-colony entrance here.
        const inOwnGrid = ants.currentGridColonyId[id] === ants.colonyId[id];
        needsTransition =
          (task === AntTask.Foraging && foodCarrying === 0) ||
          (task === AntTask.Fighting && inOwnGrid) ||
          (task === AntTask.Foraging && foodCarrying > 0);
      }

      if (needsTransition) {
        const colonyId = ants.colonyId[id]!;
        const colony = world.colonies[colonyId];
        if (colony && colony.entrances && colony.entrances.length > 0) {
          const antTileX = ants.posX[id]! >> FP_SHIFT;
          const antTileY = ants.posY[id]! >> FP_SHIFT;
          let bestDist = -1;
          let bestId = -1;
          // Phase 9 playability: Surface Diggers may target a designated-but-unopened
          // entrance — that's the only way a freshly designated shaft ever gets excavated.
          // All other descent tasks still require an open entrance per PRD §5c.
          const allowClosedEntrance = zone === Zone.Surface && task === AntTask.Digging;
          for (let e = 0; e < colony.entrances.length; e++) {
            const ent = colony.entrances[e]!;
            if (!ent.isOpen && !allowClosedEntrance) continue;
            const entDistY = zone === Zone.Surface ? ent.surfaceTileY : 0;
            const dist =
              Math.abs(ent.surfaceTileX - antTileX) + Math.abs(entDistY - antTileY);
            if (
              bestDist < 0 ||
              dist < bestDist ||
              (dist === bestDist && ent.entranceId < bestId)
            ) {
              bestDist = dist;
              bestId = ent.entranceId;
              entranceTargetX = ent.surfaceTileX << FP_SHIFT;
              entranceTargetY = entDistY << FP_SHIFT;
            }
          }
        }
      }
    }

    // chamberFoodUnreachable is set when the FoodStorage flow-field reports
    // -2 at the ant's current tile. That forces a fall-through to the
    // entrance branch so a pocketed carrier heads for the surface rather
    // than freezing inside a chamber footprint still awaiting excavation.
    // Peeked here (before the steering if/elseif chain) so the branch
    // selection can consume it as a guard.
    let chamberFoodUnreachable = false;
    if (chamberTargetX !== -1 && chamberFlowFields !== undefined) {
      // colonyId keys the own-colony food flow-field; gridColonyId keys the
      // occupied grid (Phase 09.1 Chunk 0). Today both identical.
      const colonyId = ants.colonyId[id]!;
      const gridColonyId = ants.currentGridColonyId[id]!;
      const flowField = chamberFlowFields.food[colonyId];
      const underground = world.undergroundGrids[gridColonyId];
      if (flowField && underground) {
        const tileX = ants.posX[id]! >> FP_SHIFT;
        const tileY = ants.posY[id]! >> FP_SHIFT;
        const idx = tileY * underground.width + tileX;
        if (flowField[idx] === -2) chamberFoodUnreachable = true;
      }
    }

    if (chamberTargetX !== -1 && !chamberFoodUnreachable) {
      // PRD §4d: underground carrying forager routes to a FoodStorage Open
      // tile. Prefer the food flow-field when available — straight-line
      // steering walks through Solid dirt on bent tunnels (see the
      // seed-920076605 debug snapshot where carriers froze at 23,7 because
      // the next axis-step landed on Solid at 23,8).
      const posX = ants.posX[id]!;
      const posY = ants.posY[id]!;
      let stepped = false;
      if (chamberFlowFields !== undefined) {
        // colonyId keys own-colony food flow-field; gridColonyId keys the
        // occupied grid (Phase 09.1 Chunk 0). Today both identical.
        const colonyId = ants.colonyId[id]!;
        const gridColonyId = ants.currentGridColonyId[id]!;
        const flowField = chamberFlowFields.food[colonyId];
        const underground = world.undergroundGrids[gridColonyId];
        if (flowField && underground) {
          const tileX = posX >> FP_SHIFT;
          const tileY = posY >> FP_SHIFT;
          const idx = tileY * underground.width + tileX;
          const dir = flowField[idx]!;
          if (dir === -1) {
            // On a FoodStorage chamber tile — hold. antDepositFood at step
            // 16b completes the hand-off and flips task=Idle.
            dx = 0;
            dy = 0;
            stepped = true;
          } else if (dir >= 0 && dir < 4) {
            dx = DIR_DX[dir]!;
            dy = DIR_DY[dir]!;
            stepped = true;
          }
          // dir === -2 is unreachable here — chamberFoodUnreachable was set
          // above and the outer branch guards against entering this block.
        }
      }
      if (!stepped) {
        // Cache absent (test harness) — retain the original Manhattan step.
        const rawDx = chamberTargetX - posX;
        const rawDy = chamberTargetY - posY;
        if (Math.abs(rawDx) >= Math.abs(rawDy)) {
          dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
          dy = 0;
        } else {
          dx = 0;
          dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
        }
      }
    } else if (entranceTargetX !== -1) {
      // Zone-transitioning ant — move toward nearest open entrance.
      const posX = ants.posX[id]!;
      const posY = ants.posY[id]!;

      // Underground: consume the entrance flow-field so we route through
      // Open/BeingDug tunnels instead of steering straight-line into dirt on
      // bends. See entrance-flow.ts for BFS details. Fall back to straight-line
      // when no cache is passed (test harnesses) or the colony's field is
      // missing (shouldn't happen at step 16 — step 9 seeds lazily).
      let stepped = false;
      if (zone === Zone.Underground && entranceFlowFields !== undefined) {
        // colonyId keys the own-colony entrance flow-field (an ant always
        // routes to its OWN colony's entrances — invaders exit via their own
        // entrance, not the enemy's). gridColonyId keys the occupied grid
        // (Phase 09.1 Chunk 0). Today both identical.
        const colonyId = ants.colonyId[id]!;
        const gridColonyId = ants.currentGridColonyId[id]!;
        const flowField = entranceFlowFields.fields[colonyId];
        const underground = world.undergroundGrids[gridColonyId];
        if (flowField && underground) {
          const tileX = posX >> FP_SHIFT;
          const tileY = posY >> FP_SHIFT;
          const idx = tileY * underground.width + tileX;
          const dir = flowField[idx]!;
          if (dir === -1) {
            // Source tile — at underground side of an open entrance. Hold so
            // the zone-transition block below can promote to Surface.
            dx = 0;
            dy = 0;
            stepped = true;
          } else if (dir >= 0 && dir < 4) {
            dx = DIR_DX[dir]!;
            dy = DIR_DY[dir]!;
            stepped = true;
          } else {
            // dir === -2 (unreachable). Deterministic failsafe: hold position
            // rather than oscillate straight-line into a wall. Happens when
            // the ant is on a Marked/Solid tile with no tunnel connection to
            // any open entrance — e.g. stranded on a chamber footprint still
            // awaiting excavation.
            dx = 0;
            dy = 0;
            stepped = true;
          }
        }
      }

      if (!stepped) {
        const rawDx = entranceTargetX - posX;
        const rawDy = entranceTargetY - posY;
        if (Math.abs(rawDx) >= Math.abs(rawDy)) {
          dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
          dy = 0;
        } else {
          dx = 0;
          dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
        }
      }
    } else if (task === AntTask.Foraging) {
      // Non-transitioning forager — priority target (step 13) or pheromone gradient.
      const targetX = ants.targetPosX[id]!;
      const targetY = ants.targetPosY[id]!;

      if (targetX !== -1 && targetY !== -1) {
        const posX = ants.posX[id]!;
        const posY = ants.posY[id]!;
        const rawDx = targetX - posX;
        const rawDy = targetY - posY;
        if (Math.abs(rawDx) >= Math.abs(rawDy)) {
          dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
          dy = 0;
        } else {
          dx = 0;
          dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
        }
      } else {
        const colonyId = ants.colonyId[id]!;
        const tileX = ants.posX[id]! >> FP_SHIFT;
        const tileY = ants.posY[id]! >> FP_SHIFT;

        // 09 foraging-autonomy memo: short-range scent pull. A forager within
        // FOOD_SCENT_RADIUS tiles of an unmarked pile heads straight for it,
        // so once diffusion brings a worker into local range discovery is
        // deterministic rather than Bernoulli. Priority-target piles still win
        // upstream (targetX/Y branch); this only affects the no-priority path.
        const scent = findNearestScentPile(world, tileX, tileY);
        if (scent !== null) {
          const rawDx = scent.tileX - tileX;
          const rawDy = scent.tileY - tileY;
          if (Math.abs(rawDx) >= Math.abs(rawDy)) {
            dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
            dy = 0;
          } else {
            dx = 0;
            dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
          }
        } else {
          const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
          const grid = world.pheromoneGrids[key];
          if (grid) {
            // 09 pheromone-reacquisition memo: sampleForagingDirection widens
            // the trail scan to REACQUIRE_RADIUS and suppresses the 10%
            // random-explore roll when a strong local trail exists, so
            // successful routes get reused instead of randomly discarded.
            // Still returns (0,0) when no pheromone is within range → fall
            // through to the bootstrap wander (09 foraging-autonomy memo).
            // 09 follow-up issue 1: pass the ant's prev tile so the sampler
            // can filter out an immediate-reverse pick — breaks the ABAB
            // scalar-gradient loop.
            const dir = sampleForagingDirection(
              grid,
              tileX,
              tileY,
              rng,
              ants.searchPrevTileX[id]!,
              ants.searchPrevTileY[id]!,
            );
            if (dir.dx !== 0 || dir.dy !== 0) {
              dx = dir.dx;
              dy = dir.dy;
            } else {
              const wander = chooseExcursionDirection(world, id, rng);
              dx = wander.dx;
              dy = wander.dy;
            }
          } else {
            // No pheromone grid (scenario-dependent presence) — still wander
            // so the forager is not pinned at the entrance.
            const wander = chooseExcursionDirection(world, id, rng);
            dx = wander.dx;
            dy = wander.dy;
          }
        }
      }
    } else if (task === AntTask.Fighting) {
      // Surface fighter routes to colony.rallyPoint via ants.targetPosX/Y
      // (written by updateFightAntTargets at step 10c each tick). Underground
      // fighters computed entranceTargetX via needsTransition above and were
      // handled by the entrance branch — they only reach this branch after
      // transitioning to the surface, when targetPosX/Y now holds the rally.
      //
      // Phase 09.1 Chunk 3 — a Fighter in a FOREIGN underground grid (an
      // invader) skips the entrance-routing path above (needsTransition is
      // false for them) and arrives here. They have no rally-targetPosX/Y
      // that is meaningful to navigate the enemy grid (updateFightAntTargets
      // writes their OWN colony's rally/entrance, which is surface-side).
      // Substitute a Manhattan nearest-hostile step via
      // pickNearestHostileUnderground while a proper fight-flow-field is
      // deferred to Chunk 5. Null-target fallback: idle in place (Option A
      // per plan 09.1-03 task 3 — simplest, deterministic, no magic numbers).
      const posX = ants.posX[id]!;
      const posY = ants.posY[id]!;

      const gridColonyId = ants.currentGridColonyId[id]!;
      const ownColonyId = ants.colonyId[id]!;
      const isForeignGridUnderground =
        zone === Zone.Underground && gridColonyId !== ownColonyId;

      let rawDx = 0;
      let rawDy = 0;
      let haveTarget = false;

      if (isForeignGridUnderground) {
        const hostile = pickNearestHostileUnderground(ants, id, gridColonyId);
        if (hostile !== null) {
          rawDx = hostile.targetX - posX;
          rawDy = hostile.targetY - posY;
          haveTarget = true;
        }
        // hostile === null → idle fallback: dx=dy=0 (haveTarget stays false,
        // axis-step block below leaves dx/dy at their defaults of 0).
      } else {
        const targetX = ants.targetPosX[id]!;
        const targetY = ants.targetPosY[id]!;
        if (targetX !== -1 && targetY !== -1) {
          rawDx = targetX - posX;
          rawDy = targetY - posY;
          haveTarget = true;
        }
      }

      if (haveTarget) {
        if (Math.abs(rawDx) >= Math.abs(rawDy)) {
          dx = rawDx > 0 ? 1 : rawDx < 0 ? -1 : 0;
          dy = 0;
        } else {
          dx = 0;
          dy = rawDy > 0 ? 1 : rawDy < 0 ? -1 : 0;
        }
      } else {
        // No target and no entrance fallback — hold. updateFightAntTargets
        // writes targetPosX/Y whenever rallyPoint or entrances exist, so this
        // is only reached when a fighter has neither rally nor entrance
        // (or a foreign-grid invader with no underground hostiles yet).
        dx = 0;
        dy = 0;
      }
    } else {
      // Non-forager, non-transitioning: pure direction lookup (no state mutations).
      const dir = getTaskDirection(world, id, digFlowFields, chamberFlowFields);
      dx = dir.dx;
      dy = dir.dy;
    }

    const speed = ants.speed[id]!;
    const prevPosX = ants.posX[id]!;
    const prevPosY = ants.posY[id]!;
    let posX = prevPosX + dx * speed;
    let posY = prevPosY + dy * speed;

    // Underground passability guard — reject a step that would cross into a
    // Solid tile (or into a Marked tile for any non-Digger). Axis-independent
    // integer-tile comparison: if the tile under the prospective (posX, posY)
    // is impassable for this task, revert to the previous frame's position.
    // Partial-tile moves within the current tile are unaffected.
    //
    // Phase 09.1 Chunk 0: the passability check reads the grid the ant is
    // currently IN (not the ant's owning colony). For Fighter invaders in
    // enemy grids (Chunks 3+4), currentGridColonyId !== colonyId and the
    // enemy grid's passability must apply.
    if (zone === Zone.Underground && (dx !== 0 || dy !== 0)) {
      const gridColonyId = ants.currentGridColonyId[id]!;
      const underground = world.undergroundGrids[gridColonyId];
      if (underground) {
        const prevTileX = prevPosX >> FP_SHIFT;
        const prevTileY = prevPosY >> FP_SHIFT;
        const newTileX = posX >> FP_SHIFT;
        const newTileY = posY >> FP_SHIFT;
        if (newTileX !== prevTileX || newTileY !== prevTileY) {
          if (!canEnterUndergroundTile(underground, newTileX, newTileY, task as AntTask)) {
            posX = prevPosX;
            posY = prevPosY;
          }
        }
      }
    }

    // Clamp to zone-appropriate bounds
    if (zone === Zone.Underground) {
      if (posX < 0) posX = 0;
      else if (posX > undergroundMaxX) posX = undergroundMaxX;
      if (posY < 0) posY = 0;
      else if (posY > undergroundMaxY) posY = undergroundMaxY;
    } else {
      // Zone.Surface (default)
      if (posX < 0) posX = 0;
      else if (posX > surfaceMaxX) posX = surfaceMaxX;
      if (posY < 0) posY = 0;
      else if (posY > surfaceMaxY) posY = surfaceMaxY;
    }

    ants.posX[id] = posX;
    ants.posY[id] = posY;

    // 09 excursion-foraging follow-up — record prev tile for a surface
    // Foraging + SearchingFood ant that actually crossed a tile boundary.
    // sampleForagingDirection and hasNearbyPheromoneSignal use this to avoid
    // reversing onto the just-vacated cell (anti-backtrack). Only the
    // SearchingFood state needs this — CarryingFood/ReturningToNest paths
    // navigate by scent/target/entrance, not by scalar gradient.
    if (
      zone === Zone.Surface &&
      task === AntTask.Foraging &&
      ants.subTask[id] === ForagingSubState.SearchingFood
    ) {
      const preTileX = prevPosX >> FP_SHIFT;
      const preTileY = prevPosY >> FP_SHIFT;
      const newTileX = posX >> FP_SHIFT;
      const newTileY = posY >> FP_SHIFT;
      if (newTileX !== preTileX || newTileY !== preTileY) {
        ants.searchPrevTileX[id] = preTileX;
        ants.searchPrevTileY[id] = preTileY;
      }
    }

    // --- Zone transitions (PRD §5d — applied AFTER position update) ---
    // Surface → Underground: ant on surface at an open entrance, task requires underground
    if (zone === Zone.Surface) {
      // 09 excursion-foraging memo — ReturningToNest arrival check. A forager
      // heading home after a failed search reaches the entrance tile on the
      // surface, flips back to SearchingFood, bumps its wave counter (capped
      // at SEARCH_LEASH_MAX_WAVE), and clears the heading so the next
      // excursion re-derives an outward direction from the entrance.
      if (
        task === AntTask.Foraging &&
        ants.subTask[id] === ForagingSubState.ReturningToNest
      ) {
        const tileXR = posX >> FP_SHIFT;
        const tileYR = posY >> FP_SHIFT;
        const colonyIdR = ants.colonyId[id]!;
        const colonyR = world.colonies[colonyIdR];
        if (colonyR && colonyR.entrances) {
          for (let e = 0; e < colonyR.entrances.length; e++) {
            const ent = colonyR.entrances[e]!;
            if (ent.surfaceTileX === tileXR && ent.surfaceTileY === tileYR) {
              ants.subTask[id] = ForagingSubState.SearchingFood;
              const curWave = ants.searchWave[id]!;
              const nextWave = curWave + 1;
              ants.searchWave[id] = nextWave > SEARCH_LEASH_MAX_WAVE
                ? SEARCH_LEASH_MAX_WAVE
                : nextWave;
              ants.searchHeadingX[id] = 0;
              ants.searchHeadingY[id] = 0;
              ants.searchHeadingTicks[id] = 0;
              ants.searchPrevTileX[id] = -1;
              ants.searchPrevTileY[id] = -1;
              break;
            }
          }
        }
      }

      // Phase 09.1 Chunk 3 — descent-intent gate (REQ-C3). `needsUnderground`
      // is the TASK-level filter: tasks that have a reason to descend.
      // Fighters are included here so an own-colony Fighter standing on its
      // own open entrance descends (pre-09.1 Fighters had no descent path;
      // Plan 09.1-03 adds one). Invasion routing (foreign entrance) then
      // layers on top via the per-entrance descent-intent predicate below.
      const needsUnderground =
        task === AntTask.Digging ||
        task === AntTask.Nursing ||
        task === AntTask.Fighting ||
        (task === AntTask.Foraging && ants.subTask[id] === ForagingSubState.CarryingFood);

      if (needsUnderground) {
        const tileX = posX >> FP_SHIFT;
        const tileY = posY >> FP_SHIFT;
        const antColonyId = ants.colonyId[id]!;

        // Phase 09.1 Chunk 3 — iterate ALL colonies' entrances, not just the
        // ant's own colony. Combined with the descent-intent predicate below,
        // this is what lets player Fighting ants cross colony boundaries
        // through open enemy entrances (REQ-C3a) while preserving the
        // existing own-colony descent behavior and rejecting foreign descent
        // for non-Fighting ants (REQ-C3c).
        //
        // Determinism: world.colonies is a Record<ColonyId, ColonyRecord>
        // iterated via `for...in`; CLNY-08-compliant keyed iteration. Insertion
        // order is stable (createScenario calls initColony(PLAYER) then
        // initColony(ENEMY)) and no PRNG calls occur inside the loop.
        let descended = false;
        for (const cidKey in world.colonies) {
          if (descended) break;
          const colony = world.colonies[cidKey as unknown as keyof typeof world.colonies];
          if (!colony || !colony.entrances) continue;

          for (let e = 0; e < colony.entrances.length; e++) {
            const entrance = colony.entrances[e]!;

            // Tile match gate: both x and y must match the ant's current tile.
            if (entrance.surfaceTileX !== tileX || entrance.surfaceTileY !== tileY) continue;

            // Descent-intent predicate (RESEARCH.md §Pattern 3):
            //   - Own-colony entrance: all tasks in `needsUnderground` descend.
            //     Closed-but-designated own entrance still accepts a Surface
            //     Digger (Phase 9 playability carve-out).
            //   - Foreign entrance: descent ONLY for Fighting, and ONLY if the
            //     entrance is open. Closed enemy entrance rejects Fighters.
            //     Foreign Foraging / Digging / Nursing never descend.
            const isOwnEntrance = colony.colonyId === antColonyId;
            const isFightingForeigner =
              task === AntTask.Fighting && !isOwnEntrance && entrance.isOpen;

            if (isOwnEntrance) {
              // Own-colony descent: digger carve-out (closed entrance OK) or
              // any other descent-intent task on an open entrance.
              const canDescend = entrance.isOpen || task === AntTask.Digging;
              if (!canDescend) continue;
            } else if (!isFightingForeigner) {
              // Foreign entrance but not a Fighting invader — descent-intent
              // gate rejects (REQ-C3c). Non-Fighting foreign ants stay on
              // the surface.
              continue;
            }

            // Descent fires. `colony.colonyId` is the entrance-owning colony
            // and becomes the ant's new grid-of-occupancy (Phase 09.1 Chunk 0
            // invariant). For own-colony descent this byte-identical; for
            // Fighting foreigners it diverges from `ants.colonyId[id]`, which
            // is the precise design intent.
            ants.zone[id] = Zone.Underground;
            ants.currentGridColonyId[id] = colony.colonyId;
            ants.posY[id] = 0; // enter at top of underground grid
            descended = true;
            break;
          }
        }
      }
    } else if (zone === Zone.Underground) {
      // Underground → Surface: ant at tileY=0 at an open entrance, task requires surface (PRD §5d).
      // Idle kept as defensive allowance: a post-deposit ant still at an entrance tile transits
      // immediately rather than lingering underground until step-10a reassigns it next tick.
      const needsSurface =
        task === AntTask.Idle ||
        task === AntTask.Fighting ||
        (task === AntTask.Foraging && ants.subTask[id] === ForagingSubState.SearchingFood);

      if (needsSurface) {
        const tileX = posX >> FP_SHIFT;
        const tileY = posY >> FP_SHIFT;

        if (tileY === 0) {
          const colonyId = ants.colonyId[id]!;
          const colony = world.colonies[colonyId];
          if (colony && colony.entrances) {
            for (let e = 0; e < colony.entrances.length; e++) {
              const entrance = colony.entrances[e]!;
              if (entrance.isOpen && entrance.surfaceTileX === tileX) {
                ants.zone[id] = Zone.Surface;
                ants.posY[id] = entrance.surfaceTileY << FP_SHIFT;
                break;
              }
            }
          }
        }
      }
    }

  }

  // POST-PASS: resolve same-colony occupancy after every ant has moved and
  // zone-transitioned. See resolveSameColonyOccupancy for semantics.
  resolveSameColonyOccupancy(world);
}

// ---------------------------------------------------------------------------
// resolveSameColonyOccupancy — enforce "no two same-colony mobile ants end a
// tick on the same (zone, tile)" invariant.
//
// Runs after tickAntMovement's per-ant move + zone transition loop. Iterates
// every live ant in entity-id order (lower-id wins contested tiles). On a
// collision with an already-claimed same-colony tile, the higher-id ant is
// deterministically shifted to the first passable adjacent tile (N, E, S, W
// order) that is not claimed by another same-colony ant in this pass. When no
// adjacent tile is available (extreme corner cases — fully walled in) the ant
// accepts the overlap rather than invalidating the scene. Cross-colony overlap
// is preserved: the key encodes colonyId, so different colonies never contest.
//
// "Work site" tiles (chamber footprints, entrance tiles, food piles) are
// exempt: they are explicit stacking zones where multiple ants must coexist to
// deposit food, nurse brood, excavate, or pick up. Exempt tiles never enter
// the occupancy map.
// ---------------------------------------------------------------------------
function resolveSameColonyOccupancy(world: WorldState): void {
  const ants = world.ants;
  const occupancy = new Map<number, number>(); // tileKey → lowest-id claimant

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;

    const colonyId = ants.colonyId[id]!;
    const zone = ants.zone[id]!;
    let tileX = ants.posX[id]! >> FP_SHIFT;
    let tileY = ants.posY[id]! >> FP_SHIFT;

    if (isOccupancyExempt(world, colonyId, zone, tileX, tileY)) continue;

    const key = (colonyId << 16) | (zone << 15) | (tileY << 7) | tileX;
    if (!occupancy.has(key)) {
      occupancy.set(key, id);
      continue;
    }

    // Collision: a lower-id same-colony ant already claimed this tile.
    // Try to shift this ant to a passable, unclaimed adjacent tile.
    //
    // Phase 09.1 Chunk 0: passability reads the grid the ant is currently IN
    // (currentGridColonyId), not the ant's owning colony. colonyId above still
    // keys occupancy detection (same-colony ants compete for tiles regardless
    // of where they are). Today both keys yield the same grid.
    const task = ants.task[id]! as AntTask;
    const gridColonyId = ants.currentGridColonyId[id]!;
    const underground =
      zone === Zone.Underground ? world.undergroundGrids[gridColonyId] : undefined;
    let shifted = false;
    for (let d = 0; d < 4; d++) {
      const nx = tileX + DIR_DX[d]!;
      const ny = tileY + DIR_DY[d]!;
      if (zone === Zone.Underground) {
        if (nx < 0 || nx >= UNDERGROUND_GRID_WIDTH) continue;
        if (ny < 0 || ny >= UNDERGROUND_GRID_HEIGHT) continue;
        if (underground && !canEnterUndergroundTile(underground, nx, ny, task)) continue;
      } else {
        if (nx < 0 || nx >= SURFACE_GRID_WIDTH) continue;
        if (ny < 0 || ny >= SURFACE_GRID_HEIGHT) continue;
      }
      // Exempt adjacent tiles are always "free" — we shift into them and do
      // not claim them (keeping them open for further stacking).
      if (isOccupancyExempt(world, colonyId, zone, nx, ny)) {
        tileX = nx;
        tileY = ny;
        ants.posX[id] = tileX << FP_SHIFT;
        ants.posY[id] = tileY << FP_SHIFT;
        shifted = true;
        break;
      }
      const adjKey = (colonyId << 16) | (zone << 15) | (ny << 7) | nx;
      if (occupancy.has(adjKey)) continue;
      tileX = nx;
      tileY = ny;
      ants.posX[id] = tileX << FP_SHIFT;
      ants.posY[id] = tileY << FP_SHIFT;
      occupancy.set(adjKey, id);
      shifted = true;
      break;
    }
    // If no shift found, forced overlap — rare. Leave the ant at the original
    // tile; do not pollute the occupancy map (the lower-id claimant remains
    // registered). Visual overlap persists this tick; natural drift on the
    // next tick usually breaks the tie.
    void shifted;
  }
}

// ---------------------------------------------------------------------------
// isOccupancyExempt — tile-based exemption for same-colony occupancy rule.
//
// Returns true when (zone, tileX, tileY) is a "work site" where multiple
// same-colony ants must be able to stack:
//   - Any same-colony chamber footprint (food deposit, nursing, expansion).
//   - Any same-colony entrance (surface tile; underground shaft bottom at tileY=0).
//   - Any food pile (surface only; piles are infinite pickup sources per SURF-02).
//
// Inlined per-ant. Chamber / entrance / pile counts are small in practice
// (bounded by colony design), so the linear scan is acceptable in the movement
// hot path. Runs O(chambers + entrances + piles) per move rather than per ant
// per work-site lookup — no Set/Map allocation.
// ---------------------------------------------------------------------------
function isOccupancyExempt(
  world: WorldState,
  colonyId: number,
  zone: number,
  tileX: number,
  tileY: number,
): boolean {
  const colony = world.colonies[colonyId];
  if (!colony) return false;

  for (let c = 0; c < colony.chambers.length; c++) {
    const chamber = colony.chambers[c]!;
    const bx = chamber.posX >> FP_SHIFT;
    const by = chamber.posY >> FP_SHIFT;
    if (
      tileX >= bx && tileX < bx + chamber.width &&
      tileY >= by && tileY < by + chamber.height
    ) {
      return true;
    }
  }

  if (colony.entrances) {
    for (let e = 0; e < colony.entrances.length; e++) {
      const ent = colony.entrances[e]!;
      if (zone === Zone.Surface) {
        if (ent.surfaceTileX === tileX && ent.surfaceTileY === tileY) return true;
      } else {
        // Underground shaft bottom at (entrance col, tileY=0)
        if (ent.surfaceTileX === tileX && tileY === 0) return true;
      }
    }
  }

  if (zone === Zone.Surface) {
    for (let p = 0; p < world.foodPiles.length; p++) {
      const pile = world.foodPiles[p]!;
      if (pile.tileX === tileX && pile.tileY === tileY) return true;
    }
  }

  return false;
}
