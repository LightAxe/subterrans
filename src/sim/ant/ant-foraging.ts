// src/sim/ant/ant-foraging.ts
// #212 Layer 1 (behavior): forager pickup/deposit, food/scent routing, excursion
// boundary + priority piles. Several functions are tick.ts steps; the orchestrator
// also calls routeForagerPriority / chooseExcursionDirection / findReachableScentPile.
// Depends only on Layer-0 ant-motion (+ sibling sim modules). Owns FOOD_SCENT_RADIUS
// and SIGNAL_PHEROMONE_RADIUS (their sole consumers live here).
import type { ChamberRecord, ColonyRecord } from '../colony/colony-store.js';
import { colonyHasNoDepositTarget, isFoodChamberDepositable } from '../colony/colony-system.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  DANGER_ROUTE_AVOID_THRESHOLD,
  DANGER_ROUTE_WEIGHT_FP,
  EXCURSION_HEADING_JITTER_TICKS,
  EXCURSION_HEADING_MIN_TICKS,
  EXCURSION_TURN_PERCENT,
  EXCURSION_WOBBLE_PERCENT,
  FOOD_CHAMBER_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_PICKUP_DRAIN,
  LEASH_HYSTERESIS_TILES,
  SEARCH_LEASH_MAX_WAVE,
  SEARCH_LEASH_RADII,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  WORKER_CARRY_CAPACITY,
} from '../constants.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import { recordFoodPileDepletion } from '../food-system.js';
import { phGet, pheromoneGridKey, type PheromoneGrid } from '../pheromone/pheromone-store.js';
import { Rng } from '../rng.js';
import { SURFACE_GOAL_UNREACHED, surfaceGoalDistance } from '../surface-routing.js';
import { Zone } from '../terrain.js';
import { SIM_VERSION_V36_RISK_AWARE_FORAGING, type WorldState } from '../types.js';
import { clearRecentTiles } from './ant-store.js';

/**
 * Attempt to pick up food from a pile into an ant's carry inventory.
 *
 * Transfers `min(remaining_capacity, FOOD_PICKUP_AMOUNT)` from the pile to the
 * ant when `pile.pickupsRemaining > 0`. Decrements `pile.pickupsRemaining` by
 * `FOOD_PILE_PICKUP_DRAIN` on every successful transfer. On a nonzero transfer,
 * internally transitions the ant to ForagingSubState.CarryingFood per PRD §4c L1103
 * (caller does NOT flip subTask separately).
 *
 * Pile depletion (`pickupsRemaining` reaching 0) is signaled to the caller by
 * inspecting the field after the call; the caller is responsible for splicing
 * the pile out of `world.foodPiles` and recording it in `recentlyDepletedFood`.
 *
 * @param ants   Ant components SoA.
 * @param antId  Entity ID of the forager.
 * @param pile   Food source with a mutable `pickupsRemaining` field.
 * @returns      Amount transferred (0 means no pickup — no transition occurred).
 */
export function antPickupFood(
  ants: WorldState['ants'],
  antId: number,
  pile: { pickupsRemaining: number },
): number {
  const carried = ants.foodCarrying[antId]!;
  const capacity = WORKER_CARRY_CAPACITY - carried;

  if (capacity <= 0) return 0; // already at capacity — no pickup, no transition (PRD §4c L1097)
  if (pile.pickupsRemaining <= 0) return 0; // pile exhausted — no pickup, no transition

  const transfer = capacity < FOOD_PICKUP_AMOUNT ? capacity : FOOD_PICKUP_AMOUNT;

  ants.foodCarrying[antId] = carried + transfer;

  // Issue #112 — drain one pickup-charge per successful pickup. Charge counter
  // is independent of food quantity transferred; FOOD_PILE_PICKUP_DRAIN keeps
  // the drain rate as a tunable balance lever.
  pile.pickupsRemaining -= FOOD_PILE_PICKUP_DRAIN;
  if (pile.pickupsRemaining < 0) pile.pickupsRemaining = 0; // clamp (defensive)

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
  // Issue #35 — clear pause counter on transition out of SearchingFood
  // (here on pickup → CarryingFood) so the next excursion starts with a
  // clean cadence.
  ants.searchPauseTicks[antId] = 0;
  // Issue #42 fix #3 — pickup is a state change. The next time this ant
  // returns to SearchingFood (after deposit), the recent-tiles buffer
  // should start empty so the new excursion isn't biased by stale memory
  // from the previous trip.
  clearRecentTiles(ants, antId);

  return transfer;
}

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
    if (tileX >= baseX && tileX < baseX + ch.width && tileY >= baseY && tileY < baseY + ch.height) {
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
    // Issue #68 (v12+) — fall through to the entrance-pool path for any
    // leftover food after a partial chamber deposit. Pre-v12 the chamber
    // path silently swallowed the leftover (ant walked away with the
    // remainder, no Idle flip, no wait-state) and relied on next-tick
    // flow-field re-routing — which had a 1-tick stale-routing window
    // and could cause the ant to re-step toward the same now-saturated
    // chamber. Now: deposit chamber slice → fall through → deposit pool
    // slice → enter wait-state if leftover persists.
  }
  // Issue #68 (v12+) — pre-v12 this was an `else` branch. Now runs after
  // the chamber path too when v12+, so leftover food can flow into the
  // entrance pool before forcing wait-state.
  if (remaining > 0) {
    // Fallback — entrance-shaft / chamberless pool. Cap at BASE.
    const space = BASE_FOOD_STORAGE_CAPACITY - colony.foodStored;
    const toPool = remaining < space ? remaining : space > 0 ? space : 0;
    colony.foodStored += toPool;
    remaining -= toPool;

    // Issue #27 — carrier wait state. Enter wait when there is no chamber-
    // depositable target AND the ant still has leftover food after the
    // entrance-pool deposit attempt. Two sub-cases trigger this:
    //   (a) zero-progress: pool already at cap → toPool === 0 (issue #27 path)
    //   (b) partial-progress: pool had headroom but couldn't absorb the full
    //       carry → toPool > 0 AND remaining > 0 (issue #42 fix). Pre-v6,
    //       the partial-fill case left waitingDeposit=0 for one tick because
    //       toPool > 0 short-circuited the gate; the carrier would re-enter
    //       wait the NEXT tick's antDepositFood call (via the now-zero space),
    //       producing the "5 carriers stacked at entrance, 2 not waiting"
    //       state seen in the issue #42 snapshot. With the partial path, the
    //       carrier enters wait on the same tick the partial deposit happens.
    //   - Common conditions:
    //       remaining > 0 (still carrying leftover)
    //       no chamber depositable (otherwise next tick's movement re-routes
    //       to the chamber rather than parking at the entrance)
    //       simVersion >= 3 (issue #27 gate; legacy replays stay on the
    //       always-oscillate path)
    // The simVersion >= 6 gate on the partial-fill branch keeps pre-v6
    // replays byte-identical to v5 (same toPool === 0 behavior only).
    const enterWait = remaining > 0;
    if (enterWait) {
      let anyChamberDepositable = false;
      for (let c = 0; c < colony.chambers.length; c++) {
        if (isFoodChamberDepositable(colony.chambers[c]!)) {
          anyChamberDepositable = true;
          break;
        }
      }
      if (!anyChamberDepositable) {
        world.ants.waitingDeposit[antId] = 1;
        // Clear the outward heading so a future wake-up rebuilds routing fresh
        // rather than continuing a stale return-to-entrance bearing.
        world.ants.searchHeadingX[antId] = 0;
        world.ants.searchHeadingY[antId] = 0;
        world.ants.searchHeadingTicks[antId] = 0;
      }
    }
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
    // Issue #27 — full deposit always clears any wait state. The ant is
    // about to be reassigned by step 10a; whatever state it returns from
    // (foraging, idle pool, etc.) starts with a clean waitingDeposit flag.
    world.ants.waitingDeposit[antId] = 0;
    // Issue #35 — clear pause counter so a future SearchingFood pass
    // starts with a clean cadence.
    world.ants.searchPauseTicks[antId] = 0;
    // Issue #42 fix #3 — full-deposit transitions Foraging→Idle. The next
    // re-promotion to SearchingFood starts a fresh excursion that should
    // not be biased by the just-completed return route's tile history.
    clearRecentTiles(world.ants, antId);
  }
}

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

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Foraging) continue;

    const subTask = ants.subTask[id]!;
    const zone = ants.zone[id]!;

    if (
      zone === Zone.Surface &&
      (subTask === ForagingSubState.SearchingFood || subTask === ForagingSubState.ReturningToNest)
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
        // Issue #112 — pile is now finite. antPickupFood transfers food and
        // drains a pickup-charge; we splice the pile + record the depletion
        // here when its charges hit zero so the spawn step (16d) can avoid
        // re-placing on the same neighbourhood while pheromones decay.
        antPickupFood(ants, id, pile); // may transition subTask to CarryingFood
        if (pile.pickupsRemaining <= 0) {
          recordFoodPileDepletion(world, p);
          // Splice (not swap-pop) so the tile-key uniqueness invariant on
          // `world.foodPiles` is preserved. The unconditional `break` below
          // exits this inner pile-scan loop immediately, so no further index
          // bookkeeping is needed — index management is trivial here.
          world.foodPiles.splice(p, 1);
        }
        break;
      }
      continue;
    }

    if (zone === Zone.Underground && subTask === ForagingSubState.CarryingFood) {
      // Deposit path — arrival at FoodStorage chamber (preferred) OR entrance shaft (fallback).
      const colonyId = ants.colonyId[id]!;
      const colony = world.colonies[colonyId];
      if (!colony) {
        // Issue #27 — orphaned ant (colony deleted/defeated mid-tick). Clear
        // any wait flag defensively so the ant can resume movement next tick
        // if its alive bit somehow survives the colony's destruction. In
        // practice colony loss currently zeros every member's `alive`, but
        // this defends against future colony-merge or defection paths.
        ants.waitingDeposit[id] = 0;
        continue;
      }

      // Issue #27 — carrier wait gate. A waiting carrier (set by antDepositFood
      // when the entrance fallback found the pool at cap) holds in place until
      // SOMEWHERE in the colony can take a deposit. Wake conditions:
      //   - any FoodStorage chamber is depositable, OR
      //   - the entrance pool has headroom.
      // The `colony.foodFlowFieldDirty` flag is unsuitable as a wake signal
      // here: step 9 consumes and clears it BEFORE step 16b runs, so by the
      // time tickForagerActions sees the colony, dirty is always false. The
      // chamber-iteration check is stateless and immune to the dirty cycle.
      // Iteration cost: O(chambers) only for ants currently in wait — the
      // common case (no carriers in wait) skips this block entirely.
      if (ants.waitingDeposit[id] === 1) {
        if (!colonyHasNoDepositTarget(colony)) {
          ants.waitingDeposit[id] = 0;
          // Fall through to normal deposit handling. The ant didn't move this
          // tick (tickAntMovement skipped it), so it's at the same entrance
          // tile where it entered wait. The entrance fallback may now succeed
          // (pool drained); if not, the deposit branch is a no-op and next
          // tick's tickAntMovement re-routes via the recomputed flow field.
        } else {
          continue; // still nowhere to deposit; remain in wait
        }
      }

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
          tileX >= baseX &&
          tileX < baseX + chamber.width &&
          tileY >= baseY &&
          tileY < baseY + chamber.height
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
        // Issue #70 — tile-center, not tile-corner. All target-coord
        // writers in the sim use `(tileX << FP_SHIFT) + (FP_ONE >> 1)`
        // for tile-center semantics (matches updateFightAntTargets,
        // SetRallyPoint, etc.). Pre-fix used corner coords.
        //
        // Codex P1 follow-up: gate behind V12 even though movement is
        // observably identical. The targetPos values themselves differ
        // (corner=N×256, center=N×256+128) and round-trip through saves,
        // so a v11 snapshot loaded by v12 code would write tile-center
        // where the saved bytes had tile-corner — breaking SCEN-06
        // byte-identity for any save with priority foragers active.
        priorityTargets[colony.colonyId] = {
          targetX: (pile.tileX << FP_SHIFT) + (FP_ONE >> 1),
          targetY: (pile.tileY << FP_SHIFT) + (FP_ONE >> 1),
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
 * @param dangerGrid  Optional surface DangerTrail grid (A1 / V36). When provided,
 *   the world-edge bounce softly steers the heading away from tiles whose danger
 *   is ≥ DANGER_ROUTE_AVOID_THRESHOLD (bounds stay the hard filter). `undefined`
 *   (pre-V36, gated at the call site) = byte-identical legacy bounce.
 * @returns      Cardinal direction vector { dx, dy } with |dx| + |dy| === 1.
 */
export function chooseExcursionDirection(
  world: WorldState,
  antId: number,
  rng: Rng,
  dangerGrid?: PheromoneGrid,
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
        case 0:
          hx = 1;
          hy = 0;
          break;
        case 1:
          hx = -1;
          hy = 0;
          break;
        case 2:
          hx = 0;
          hy = 1;
          break;
        default:
          hx = 0;
          hy = -1;
          break;
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
        const nhx = hy;
        const nhy = -hx;
        hx = nhx;
        hy = nhy;
      } else {
        const nhx = -hy;
        const nhy = hx;
        hx = nhx;
        hy = nhy;
      }
      ticks = EXCURSION_HEADING_MIN_TICKS + jitter;
    } else if (turnRoll >= 100 - EXCURSION_WOBBLE_PERCENT) {
      // Lateral wobble — one-tick perpendicular step, heading preserved.
      // Perpendicular of (hx,hy) is (hy,-hx) (left) or (-hy,hx) (right).
      const lhx = turnDir === 0 ? hy : -hy;
      const lhy = turnDir === 0 ? -hx : hx;
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
  //
  // A1 (V36) risk-aware wander: when a surface DangerTrail grid is provided,
  // among the in-bounds rotations prefer the FIRST whose next tile's danger is
  // below DANGER_ROUTE_AVOID_THRESHOLD (soft steer away from the spider's wake).
  // Bounds stay the HARD filter — if every in-bounds rotation is dangerous, fall
  // back to the first in-bounds rotation (never an off-grid heading). Gated:
  // dangerGrid is passed only at simVersion >= V36, and with danger==0 everywhere
  // the safe pick collapses to the first in-bounds rotation, so pre-V36 (and
  // danger-free) wanderers are byte-identical. No RNG consumed here.
  let fallbackHx = hx;
  let fallbackHy = hy;
  let foundFallback = false;
  let safeHx = 0;
  let safeHy = 0;
  let foundSafe = false;
  let rotHx = hx;
  let rotHy = hy;
  for (let attempts = 0; attempts < 4; attempts++) {
    const nx = tileX + rotHx;
    const ny = tileY + rotHy;
    if (nx >= 0 && nx < SURFACE_GRID_WIDTH && ny >= 0 && ny < SURFACE_GRID_HEIGHT) {
      if (!foundFallback) {
        fallbackHx = rotHx;
        fallbackHy = rotHy;
        foundFallback = true;
      }
      if (dangerGrid === undefined) break; // legacy: first in-bounds rotation wins.
      if (!foundSafe && phGet(dangerGrid, nx, ny) < DANGER_ROUTE_AVOID_THRESHOLD) {
        safeHx = rotHx;
        safeHy = rotHy;
        foundSafe = true;
      }
      if (foundSafe) break;
    }
    const nhx = -rotHy;
    const nhy = rotHx;
    rotHx = nhx;
    rotHy = nhy;
  }
  if (foundSafe) {
    hx = safeHx;
    hy = safeHy;
  } else if (foundFallback) {
    hx = fallbackHx;
    hy = fallbackHy;
  }

  ants.searchHeadingX[antId] = hx;
  ants.searchHeadingY[antId] = hy;
  ants.searchHeadingTicks[antId] = ticks;

  return { dx: hx, dy: hy };
}

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
 *
 * A1 (V36) danger mirror: when `dangerGrid` is provided, a cell only counts as
 * signal if its FoodTrail survives the same penalty the sampler applies
 * (`raw − (Math.imul(danger, DANGER_ROUTE_WEIGHT_FP) >> FP_SHIFT) > 0`). This
 * keeps the "true ⇒ sampleForagingDirection returns non-zero" invariant intact
 * under the penalty. `undefined` (pre-V36, gated at the call site) = the legacy
 * raw-nonzero scan, byte-identical.
 */
function hasNearbyPheromoneSignal(
  grid: PheromoneGrid,
  tileX: number,
  tileY: number,
  prevTileX: number = -1,
  prevTileY: number = -1,
  dangerGrid?: PheromoneGrid,
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
        const stepY = absX >= absY ? 0 : dy > 0 ? 1 : dy < 0 ? -1 : 0;
        if (tileX + stepX === prevTileX && tileY + stepY === prevTileY) continue;
      }
      const rawSignal = phGet(grid, sx, sy);
      if (rawSignal > 0) {
        if (dangerGrid === undefined) return true;
        const penalty = Math.imul(phGet(dangerGrid, sx, sy), DANGER_ROUTE_WEIGHT_FP) >> FP_SHIFT;
        if (rawSignal - penalty > 0) return true;
      }
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
 * v8+ leash-boundary hysteresis (#44 UAT round 3): the breakout
 * additionally requires `dist <= SEARCH_LEASH_RADII[wave] -
 * LEASH_HYSTERESIS_TILES` from the nearest entrance. Without this
 * asymmetry the signal-only breakout trips the boundary every tick for
 * ants parked just past the radius next to a steady pheromone trail,
 * wiping the recent-tiles buffer on each flip and keeping the ant
 * cycling in a tiny region forever. Pre-v8 saves keep the original
 * signal-only breakout for byte-identical replay.
 *
 * Player-marked priority targets (`colony.priorityFoodPileId`) bypass
 * the v8 deadband — explicit user intent always wins over an automatic
 * leash heuristic. The deadband only suppresses *ambient* signals
 * (scent and pheromone), which are what drove the original flip-flop.
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
    if (sub !== ForagingSubState.SearchingFood && sub !== ForagingSubState.ReturningToNest)
      continue;

    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId];
    if (!colony || !colony.entrances || colony.entrances.length === 0) continue;

    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;

    // Signal detection — priority target > scent > pheromone (09 follow-up).
    const hasPriority = colonyHasPriorityPile(world, colonyId);
    // Signal detection uses the SAME path-distance reachability predicate as the
    // movement code (findReachableScentPile). This loop only visits SURFACE
    // foragers (zone filter above), so the surface goal field is valid for every
    // ant reaching here. A cheaper Manhattan probe would diverge from movement
    // exactly at the radius boundary: a pile that is Manhattan-close but beyond
    // FOOD_SCENT_RADIUS by PATH (a long wall detour) would flip a
    // ReturningToNest forager back to SearchingFood while movement — which gates
    // on path distance — refuses to route to it, so the ant wanders and can
    // oscillate searching<->returning past the excursion leash (Codex P2).
    // Sharing one predicate keeps detection and movement in lockstep.
    const hasScent = hasPriority ? false : findReachableScentPile(world, tileX, tileY) !== null;
    let hasPheromone = false;
    if (!hasPriority && !hasScent) {
      const key = pheromoneGridKey(colonyId, PheromoneType.FoodTrail, 'surface');
      const grid = world.pheromoneGrids[key];
      if (grid) {
        // A1 (V36): mirror the sampler's danger penalty so a cell whose FoodTrail
        // is fully cancelled by DangerTrail does not count as "signal" — otherwise
        // an over-leash forager lingers SearchingFood next to danger the sampler
        // would refuse to route into. Gated: undefined pre-V36 = legacy scan.
        const dangerGrid =
          world.simVersion >= SIM_VERSION_V36_RISK_AWARE_FORAGING
            ? world.pheromoneGrids[pheromoneGridKey(colonyId, PheromoneType.DangerTrail, 'surface')]
            : undefined;
        // 09 follow-up issue 2: skip the ant's prev tile so its own just-left
        // trail doesn't count as "signal" and trap it in ReturningToNest
        // purgatory. Sentinels (-1,-1) are treated as "no prev" by the helper.
        hasPheromone = hasNearbyPheromoneSignal(
          grid,
          tileX,
          tileY,
          ants.searchPrevTileX[id],
          ants.searchPrevTileY[id],
          dangerGrid,
        );
      }
    }
    const hasSignal = hasPriority || hasScent || hasPheromone;

    if (sub === ForagingSubState.ReturningToNest) {
      // Breakout: a returning ant that now senses food or a trail should go
      // search/follow rather than complete the return leg.
      if (!hasSignal) continue;

      // v8+ leash-boundary hysteresis (#44 UAT round 3). The signal-only
      // breakout was symmetric with the outbound flip's `dist > radius`
      // gate, which produced a per-tick flip-flop for any ant parked
      // just past its leash radius next to a steady pheromone trail:
      // each flip cleared the recent-tiles ring buffer below, so the
      // issue-#42 no-revisit memory never accumulated and the ant
      // cycled in a 4-tile region indefinitely. Requiring the ant to
      // first walk back inside `radius - LEASH_HYSTERESIS_TILES`
      // forces several ticks of homeward progress between flips, which
      // both breaks the eddy and lets recent-tiles fill enough to be
      // useful when the ant later resumes searching.
      //
      // Player-marked priority piles bypass the deadband (`!hasPriority`
      // gate). priorityFoodPileId is explicit user intent — the
      // deadband only suppresses ambient signals (scent + pheromone)
      // that drove the original flip-flop, never an explicit "go here"
      // command from the player.
      if (!hasPriority) {
        // colony.entrances.length >= 1 is guaranteed by the early-
        // continue at the top of this for-loop, so bestDist is
        // unconditionally overwritten by a non-negative Manhattan
        // distance below.
        let bestDist = Number.MAX_SAFE_INTEGER;
        for (let e = 0; e < colony.entrances.length; e++) {
          const ent = colony.entrances[e]!;
          const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
          if (d < bestDist) bestDist = d;
        }
        let wave = ants.searchWave[id]!;
        if (wave < 0) wave = 0;
        if (wave > SEARCH_LEASH_MAX_WAVE) wave = SEARCH_LEASH_MAX_WAVE;
        const radius = SEARCH_LEASH_RADII[wave]!;
        if (bestDist > radius - LEASH_HYSTERESIS_TILES) continue;
      }

      ants.subTask[id] = ForagingSubState.SearchingFood;
      ants.searchHeadingX[id] = 0;
      ants.searchHeadingY[id] = 0;
      ants.searchHeadingTicks[id] = 0;
      ants.searchPrevTileX[id] = -1;
      ants.searchPrevTileY[id] = -1;
      // Issue #35 — fresh SearchingFood pass starts with a clean
      // pause cadence.
      ants.searchPauseTicks[id] = 0;
      // Issue #42 fix #3 — flipping ReturningToNest→SearchingFood mid-
      // route starts a new excursion. The buffer should reset so the
      // search isn't biased by stale tiles from before the return leg.
      clearRecentTiles(ants, id);
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
    // Issue #35 — clear pause counter on leash boundary cross so the
    // ReturningToNest leg doesn't inherit stale pause state.
    ants.searchPauseTicks[id] = 0;
    // Issue #42 fix #3 — sub-state flip is a state change. The buffer
    // belongs to the SearchingFood excursion that just ended; the
    // ReturningToNest leg navigates by entrance distance, not by
    // anti-revisit memory, and the next SearchingFood pass should
    // start with a clean buffer.
    clearRecentTiles(ants, id);
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
 * PR 5 Fix-A scent selection: among food piles within FOOD_SCENT_RADIUS
 * (PATH-distance eligibility over the static goal field), pick the one with
 * the shortest reachable path, so a walled-off
 * in-range pile loses to a reachable one. Ties (equal path distance) break on
 * lowest `foodPileId` — preserving the existing deterministic tie-break. An
 * eligible-but-unreachable pile (off the ant's component) is skipped; post-PR 4
 * single-component connectivity makes that impossible for spawned piles, but the
 * guard keeps the selector total. Returns the pile's tile, or null.
 *
 * Eligibility is gated on PATH distance, not Manhattan distance, because the
 * targeted-step no-revisit bypass relies on the step strictly decreasing the
 * eligibility quantity every tick. A path-aware descent step can INCREASE
 * Manhattan distance to the pile (detour around a wall), so Manhattan
 * eligibility could flicker at the radius boundary — the targeted pile drops
 * out on the very step taken toward it, selection switches piles, and the two
 * targeted steps can form a permanent cycle no loop-breaker interrupts. Path
 * distance strictly decreases along every stepTowardReachable step, so a
 * targeted pile can never leave eligibility by stepping toward it. The
 * Manhattan check below is only a cheap pre-filter: the field is 4-connected
 * BFS, so pathDist >= manhattan and manhattan > radius implies pathDist >
 * radius. Consequence: a pile whose shortest path exceeds the radius (long
 * wall detour) is no longer scent-eligible even when Manhattan-close — it
 * falls back to trail-following/exploration like any other far pile.
 */
export function findReachableScentPile(
  world: WorldState,
  tileX: number,
  tileY: number,
): { tileX: number; tileY: number } | null {
  let bestDist = -1; // path distance of the current best (>=0); -1 = none yet
  let bestId = -1;
  let bestX = 0;
  let bestY = 0;
  for (let p = 0; p < world.foodPiles.length; p++) {
    const pile = world.foodPiles[p]!;
    const manhattan = Math.abs(pile.tileX - tileX) + Math.abs(pile.tileY - tileY);
    if (manhattan > FOOD_SCENT_RADIUS) continue; // cheap pre-filter (pathDist >= manhattan)
    const pathDist = surfaceGoalDistance(world, tileX, tileY, pile.tileX, pile.tileY);
    if (pathDist === SURFACE_GOAL_UNREACHED) continue; // walled off from this ant
    if (pathDist > FOOD_SCENT_RADIUS) continue; // eligibility gates on PATH distance (see doc)
    if (
      bestId === -1 ||
      pathDist < bestDist ||
      (pathDist === bestDist && pile.foodPileId < bestId)
    ) {
      bestDist = pathDist;
      bestId = pile.foodPileId;
      bestX = pile.tileX;
      bestY = pile.tileY;
    }
  }
  if (bestId === -1) return null;
  return { tileX: bestX, tileY: bestY };
}
