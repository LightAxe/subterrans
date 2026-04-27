// src/sim/tick.ts — Phase 9 19-step tick dispatcher.
import type { WorldState } from './types.js';
import { allocateEntityId } from './types.js';
import { MAX_COMMANDS_PER_TICK, type SimCommand } from './commands.js';
import { GameOutcome, checkQueenDeath } from './game-over.js';
import { detectAndResolveCombat } from './combat.js';
import { Rng } from './rng.js';
import {
  AntTask,
  ForagingSubState,
  DiggingSubState,
  NursingSubState,
  FightingSubState,
  PheromoneType,
  ChamberType,
} from './enums.js';
import {
  PHEROMONE_DECAY_FP,
  DANGER_DECAY_FP,
  MAX_ENTRANCES_PER_COLONY,
  ENTRANCE_SHAFT_DEPTH,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from './constants.js';
import { FP_SHIFT } from './fixed.js';
import { allocateWorkers } from './behavior/allocation-system.js';
import {
  tickReconcile,
  tickFoodConsumption,
  tickStarvationCheck,
  tickDeathCleanup,
  tickDeadDiggerCleanup,
  checkPendingChambers,
  checkEntranceCompletion,
  hasCompletedChamber,
  isFoodChamberDepositable,
} from './colony/colony-system.js';
import {
  tickQueenEggProduction,
  tickLifecycleTransitions,
} from './colony/lifecycle-system.js';
import {
  tickPheromoneDeposit,
  tickAntMovement,
  tickDigExecution,
  tickForagerActions,
  tickNurseActions,
  tickSearchLeash,
  tickExcursionBoundary,
  routeForagerPriority,
  updateFightAntTargets,
} from './ant/ant-system.js';
import { tickPheromoneDecay } from './pheromone/pheromone-system.js';
import {
  computeDigFlowField,
  ensureDigFlowField,
  createDigFlowFields,
} from './dig-system.js';
import type { DigFlowFields } from './dig-system.js';
import {
  computeEntranceFlowField,
  ensureEntranceFlowField,
  createEntranceFlowFields,
} from './entrance-flow.js';
import type { EntranceFlowFields } from './entrance-flow.js';
import {
  computeChamberFlowField,
  ensureChamberFlowFields,
  createChamberFlowFields,
  FOOD_CHAMBER_TYPES,
  NURSING_CHAMBER_TYPES,
  QUEEN_CHAMBER_TYPES,
} from './chamber-flow.js';
import type { ChamberFlowFields } from './chamber-flow.js';
import { ugGet, ugSet, UndergroundTileState } from './terrain.js';
import { CHAMBER_DIMENSIONS } from './colony/chamber.js';
import type { PendingChamber } from './colony/chamber.js';
import type { ColonyId } from './colony/colony-store.js';
import type { FoodPileId } from './food.js';

// ---------------------------------------------------------------------------
// Module-level scratch state — persists across ticks, not part of WorldState.
// Created once at module load. Per Open Question 1 in RESEARCH.md.
// Plan 08 replaces the Phase 06 _stubDigFlowFields with this properly-populated instance.
// ---------------------------------------------------------------------------
const digFlowFields: DigFlowFields = createDigFlowFields();
// Shared entrance-return flow-field cache. Seeded from open entrance
// underground tiles; used by underground empty foragers to find a tunnel
// path back to the surface instead of steering straight-line into dirt.
const entranceFlowFields: EntranceFlowFields = createEntranceFlowFields();
// Shared chamber flow-field cache. Two fields per colony: `food` (seeded from
// FoodStorage chamber Open tiles, read by underground carrying foragers) and
// `nursing` (seeded from Queen+Nursery chamber Open tiles, read by Nursing
// ants). Prevents straight-line chamber steering into Solid dirt on bent
// tunnels (see chamber-flow.ts).
const chamberFlowFields: ChamberFlowFields = createChamberFlowFields();

/**
 * Clear every module-level flow-field cache keyed by colonyId.
 *
 * MUST be called between distinct sessions/worlds that may share colony IDs —
 * bootFresh() and bootFromSave() both replace `world` but the singletons above
 * survive across those transitions. Without this reset, a colony in the new
 * world whose `digFlowFieldDirty` is false on the first tick would keep the
 * previous session's entrance/chamber topology in its cache and route ants
 * against the old tunnel layout.
 *
 * In-place deletion preserves the const-bound record identities held by step 9.
 */
export function resetFlowFieldCaches(): void {
  for (const k in digFlowFields.fields)       delete digFlowFields.fields[k as unknown as ColonyId];
  for (const k in digFlowFields.queues)       delete digFlowFields.queues[k as unknown as ColonyId];
  for (const k in entranceFlowFields.fields)  delete entranceFlowFields.fields[k as unknown as ColonyId];
  for (const k in entranceFlowFields.queues)  delete entranceFlowFields.queues[k as unknown as ColonyId];
  for (const k in chamberFlowFields.food)     delete chamberFlowFields.food[k as unknown as ColonyId];
  for (const k in chamberFlowFields.nursing)  delete chamberFlowFields.nursing[k as unknown as ColonyId];
  for (const k in chamberFlowFields.queen)    delete chamberFlowFields.queen[k as unknown as ColonyId];
  for (const k in chamberFlowFields.queues)   delete chamberFlowFields.queues[k as unknown as ColonyId];
}

// Suppress unused-import TS error for PendingChamber (used in PlaceChamber case shape)
void (undefined as unknown as PendingChamber);

/**
 * Advance the simulation by one tick — 19-step PRD §9a dispatcher (Phase 9).
 *
 * Step order:
 *  1.  Process commands (FIFO cap: MAX_COMMANDS_PER_TICK; unknown variants silently dropped)
 *       Extended in Phase 7: real MarkDigTile, MarkFoodPile handlers;
 *       new CancelDigMark, PlaceChamber, DesignateEntrance handlers.
 *       Extended in Phase 9: SetRallyPoint, ClearRallyPoint handlers (9-variant exhaustive switch).
 *  2.  Reconcile colony stats
 *  3.  Food consumption
 *  4.  Starvation check
 *  5.  Death cleanup (per-colony) + dead-digger tile reversion (global post-pass, NEW in Phase 7)
 *  6.  Queen egg production
 *  7.  Lifecycle transitions
 *  8.  Behavior allocation (re-run per colony after lifecycle changes)
 *  9.  Recompute dig flow-fields for colonies with dirty flag (NEW in Phase 7)
 *  9b. tickSearchLeash — release over-leashed SearchingFood ants (NEW in Phase 9, 09 memo)
 *  9c. tickExcursionBoundary — flip over-leash SearchingFood → ReturningToNest (Phase 9 09 memo)
 * 10.  Task assignment:
 *       10a. existing Phase 6 idle-reassignment
 *       10b. tickDigExecution — dig-worker state machine (Marked→BeingDug→Open) (NEW in Phase 7)
 *       10c. updateFightAntTargets — route AntTask.Fighting ants to rallyPoint (NEW in Phase 9)
 * 11.  checkPendingChambers — promote fully-excavated pending chambers (NEW in Phase 7)
 * 12.  checkEntranceCompletion — enable completed entrance shafts (NEW in Phase 7)
 * 13.  routeForagerPriority — route SearchingFood foragers to marked piles (NEW in Phase 7)
 * 14.  Pheromone deposit
 * 15.  Pheromone decay
 * 16.  Movement (zone-aware, extended in Phase 7 with DigFlowFields for pure direction reads)
 * 16b. tickForagerActions — forager pickup (surface) + deposit (underground) (Phase 9 playability fix)
 * 16c. tickNurseActions — nurse arrival→Feeding→Idle state machine (09 reproduction-gate memo: finite nursing)
 * 17.  detectAndResolveCombat (NEW in Phase 9 / CMBT-04)
 * 18.  checkQueenDeath — game-over detection (NEW in Phase 9 / CMBT-06/07)
 * 19.  rngState writeback + world.tick increment
 *
 * tick() retains its accepted Phase 4 2-arg signature.
 * DigFlowFields is module-level scratch state, invisible to callers.
 *
 * @param world    - Mutable world state; mutated in place across all 19 steps.
 * @param commands - Point-in-time snapshot of commands for this tick. Not mutated.
 *                   Commands beyond MAX_COMMANDS_PER_TICK are silently dropped FIFO (PRD §5).
 * @returns GameOutcome — None each tick until a win/lose condition is detected (Phase 9).
 */
export function tick(world: WorldState, commands: readonly SimCommand[]): GameOutcome {
  // Reconstruct Rng from saved state at tick start (PRD §4 contract).
  const rng = new Rng(world.rngState);

  // ---------------------------------------------------------------------------
  // Step 1: Process commands (FIFO cap — PRD §5; indexed loop, no allocation)
  //         Extended in Phase 7 with real handlers for all 7 SimCommand variants.
  // ---------------------------------------------------------------------------
  const limit = commands.length < MAX_COMMANDS_PER_TICK ? commands.length : MAX_COMMANDS_PER_TICK;

  for (let i = 0; i < limit; i++) {
    const cmd = commands[i]!;
    switch (cmd.type) {
      case 'NoOp':
        // No state change — by definition a no-op.
        break;
      case 'SetBehaviorRatio': {
        // Colony lookup; silently skip if colony does not exist (PRD §5 T-01-02).
        const colony = world.colonies[cmd.colonyId];
        if (colony === undefined) break;
        // Validate ratio fields: any negative weight rejects the command.
        if (cmd.ratio.forage < 0 || cmd.ratio.dig < 0 || cmd.ratio.fight < 0) break;
        // Field-by-field copy to preserve object identity for copyWorldState determinism.
        colony.targetRatio.forage = cmd.ratio.forage;
        colony.targetRatio.dig    = cmd.ratio.dig;
        colony.targetRatio.fight  = cmd.ratio.fight;
        // CTRL-04: run allocateWorkers immediately in the same tick the command is issued.
        const brood0 = colony.eggCount + colony.larvaeCount;
        const hasNursery0 = hasCompletedChamber(colony, ChamberType.Nursery);
        const alloc0 = allocateWorkers(colony.workerCount, brood0, colony.targetRatio, hasNursery0);
        colony.computedAllocation.nurse  = alloc0.nurse;
        colony.computedAllocation.forage = alloc0.forage;
        colony.computedAllocation.dig    = alloc0.dig;
        colony.computedAllocation.fight  = alloc0.fight;
        colony.nurseCount = alloc0.nurse;
        break;
      }
      case 'MarkDigTile': {
        // PRD §3a — mark a Solid tile for excavation; silently drop non-Solid or out-of-bounds.
        const underground = world.undergroundGrids[cmd.colonyId];
        if (!underground) break;
        // T-07-10: bounds check (mitigate tamper — reject out-of-range silently)
        if (cmd.tileX < 0 || cmd.tileX >= UNDERGROUND_GRID_WIDTH || cmd.tileY < 0 || cmd.tileY >= UNDERGROUND_GRID_HEIGHT) break;
        if (ugGet(underground, cmd.tileX, cmd.tileY) !== UndergroundTileState.Solid) break;
        ugSet(underground, cmd.tileX, cmd.tileY, UndergroundTileState.Marked);
        const colony1 = world.colonies[cmd.colonyId];
        if (colony1) colony1.digFlowFieldDirty = true;   // typed field (Plan 03 Task 1)
        break;
      }
      case 'MarkFoodPile': {
        // PRD §3d — set the issuing colony's priority food target, or clear it
        // if the player clicked the same pile that is already the active
        // target (re-click toggles off). Exclusive per colony: selecting a
        // different pile replaces the previous target — this is the
        // "redirect" semantics the player expects, not an additive flag.
        const colony = world.colonies[cmd.colonyId];
        if (!colony) break;
        let matched: FoodPileId | null = null;
        for (const pile of world.foodPiles) {
          if (pile.tileX === cmd.tileX && pile.tileY === cmd.tileY) {
            matched = pile.foodPileId;
            break;
          }
        }
        if (matched === null) break;
        colony.priorityFoodPileId = (colony.priorityFoodPileId === matched)
          ? null
          : matched;
        break;
      }
      case 'CancelDigMark': {
        // PRD §3b — cancel a Marked tile (only Marked — NOT BeingDug; finish-then-switch rule per CTRL-04).
        const underground = world.undergroundGrids[cmd.colonyId];
        if (!underground) break;
        if (cmd.tileX < 0 || cmd.tileX >= UNDERGROUND_GRID_WIDTH || cmd.tileY < 0 || cmd.tileY >= UNDERGROUND_GRID_HEIGHT) break;
        if (ugGet(underground, cmd.tileX, cmd.tileY) !== UndergroundTileState.Marked) break;
        ugSet(underground, cmd.tileX, cmd.tileY, UndergroundTileState.Solid);
        const colony2 = world.colonies[cmd.colonyId];
        if (colony2) colony2.digFlowFieldDirty = true;   // typed field (Plan 03 Task 1)
        break;
      }
      case 'PlaceChamber': {
        // PRD §3c — place a chamber footprint at a tunnel end; marks Solid tiles; creates PendingChamber.
        const underground = world.undergroundGrids[cmd.colonyId];
        if (!underground) break;
        const dims = CHAMBER_DIMENSIONS[cmd.chamberType];
        if (!dims) break;
        // (a)(b) Bounds check (T-07-11 first guard)
        if (cmd.anchorTileX < 0 || cmd.anchorTileX + dims.width > UNDERGROUND_GRID_WIDTH) break;
        if (cmd.anchorTileY < 0 || cmd.anchorTileY + dims.height > UNDERGROUND_GRID_HEIGHT) break;
        const colony3 = world.colonies[cmd.colonyId];
        if (!colony3) break;
        // Queen-uniqueness (09 backlog memo): reject if colony already has a
        // Queen chamber, either completed or pending. Nursery is intentionally
        // left multi-place-capable here; FoodStorage is multi-place by design.
        if (cmd.chamberType === ChamberType.Queen) {
          let hasQueen = false;
          for (let qi = 0; qi < colony3.chambers.length; qi++) {
            if (colony3.chambers[qi]!.chamberType === ChamberType.Queen) { hasQueen = true; break; }
          }
          if (!hasQueen) {
            for (const pcKey in world.pendingChambers) {
              if (!Object.hasOwn(world.pendingChambers, pcKey)) continue;
              const pc = world.pendingChambers[pcKey]!;
              if (pc.colonyId === cmd.colonyId && pc.chamberType === ChamberType.Queen) {
                hasQueen = true;
                break;
              }
            }
          }
          if (hasQueen) break;
        }
        // (c) Anchor tile must be Open (tunnel-end check, UNDR-04)
        if (ugGet(underground, cmd.anchorTileX, cmd.anchorTileY) !== UndergroundTileState.Open) break;
        // (d) At least one 4-connected neighbor of the anchor must be Solid (tunnel-end check)
        {
          let hasAdjacentSolid = false;
          const ax = cmd.anchorTileX;
          const ay = cmd.anchorTileY;
          if (ax - 1 >= 0                        && ugGet(underground, ax - 1, ay) === UndergroundTileState.Solid) hasAdjacentSolid = true;
          if (!hasAdjacentSolid && ax + 1 < UNDERGROUND_GRID_WIDTH  && ugGet(underground, ax + 1, ay) === UndergroundTileState.Solid) hasAdjacentSolid = true;
          if (!hasAdjacentSolid && ay - 1 >= 0                      && ugGet(underground, ax,     ay - 1) === UndergroundTileState.Solid) hasAdjacentSolid = true;
          if (!hasAdjacentSolid && ay + 1 < UNDERGROUND_GRID_HEIGHT && ugGet(underground, ax,     ay + 1) === UndergroundTileState.Solid) hasAdjacentSolid = true;
          if (!hasAdjacentSolid) break;
        }
        // (e) No footprint tile may be BeingDug (conflict with active excavation)
        {
          let conflictsBeingDug = false;
          for (let dy = 0; dy < dims.height && !conflictsBeingDug; dy++) {
            for (let dx = 0; dx < dims.width; dx++) {
              if (ugGet(underground, cmd.anchorTileX + dx, cmd.anchorTileY + dy) === UndergroundTileState.BeingDug) {
                conflictsBeingDug = true;
                break;
              }
            }
          }
          if (conflictsBeingDug) break;
        }
        // (h) pendingChambers key at this anchor must not already exist
        const newPcKey = `${cmd.colonyId}:${cmd.anchorTileX}:${cmd.anchorTileY}`;
        if (Object.hasOwn(world.pendingChambers, newPcKey)) break;
        // (g) Overlap with existing ChamberRecord footprint
        let overlaps = false;
        for (const ch of colony3.chambers) {
          const chTileX = ch.posX >> FP_SHIFT;
          const chTileY = ch.posY >> FP_SHIFT;
          if (cmd.anchorTileX < chTileX + ch.width && cmd.anchorTileX + dims.width > chTileX &&
              cmd.anchorTileY < chTileY + ch.height && cmd.anchorTileY + dims.height > chTileY) {
            overlaps = true; break;
          }
        }
        if (overlaps) break;
        // (f) Overlap with same-colony PendingChamber footprint
        for (const pcKey in world.pendingChambers) {
          if (!Object.hasOwn(world.pendingChambers, pcKey)) continue;
          const pc = world.pendingChambers[pcKey]!;
          if (pc.colonyId !== cmd.colonyId) continue;
          if (cmd.anchorTileX < pc.anchorTileX + pc.width && cmd.anchorTileX + dims.width > pc.anchorTileX &&
              cmd.anchorTileY < pc.anchorTileY + pc.height && cmd.anchorTileY + dims.height > pc.anchorTileY) {
            overlaps = true; break;
          }
        }
        if (overlaps) break;
        // All checks passed — mark footprint Solid tiles and create PendingChamber
        for (let dy = 0; dy < dims.height; dy++) {
          for (let dx = 0; dx < dims.width; dx++) {
            const tx = cmd.anchorTileX + dx;
            const ty = cmd.anchorTileY + dy;
            if (ugGet(underground, tx, ty) === UndergroundTileState.Solid) {
              ugSet(underground, tx, ty, UndergroundTileState.Marked);
            }
          }
        }
        world.pendingChambers[newPcKey] = {
          colonyId:    cmd.colonyId,
          chamberType: cmd.chamberType,
          anchorTileX: cmd.anchorTileX,
          anchorTileY: cmd.anchorTileY,
          width:       dims.width,
          height:      dims.height,
        };
        colony3.digFlowFieldDirty = true;   // typed field (Plan 03 Task 1)
        break;
      }
      case 'DesignateEntrance': {
        // PRD §3g — designate a new nest entrance; auto-marks shaft tiles.
        const colony4 = world.colonies[cmd.colonyId];
        if (!colony4) break;
        const underground = world.undergroundGrids[cmd.colonyId];
        if (!underground) break;
        // Surface-coord bounds (PRD §3g silent-drop first bullet)
        if (cmd.surfaceTileX < 0 || cmd.surfaceTileX >= SURFACE_GRID_WIDTH) break;
        if (cmd.surfaceTileY < 0 || cmd.surfaceTileY >= SURFACE_GRID_HEIGHT) break;
        // T-07-12: cap check (mitigate tamper — prevent unbounded entrance creation)
        if (colony4.entrances.length >= MAX_ENTRANCES_PER_COLONY) break;
        // Column uniqueness — same surfaceTileX collapses in underground view (PRD §3g)
        {
          let duplicateColumn = false;
          for (let e = 0; e < colony4.entrances.length; e++) {
            if (colony4.entrances[e]!.surfaceTileX === cmd.surfaceTileX) {
              duplicateColumn = true;
              break;
            }
          }
          if (duplicateColumn) break;
        }
        // Food-pile collision (PRD §3g — commands are authoritative)
        {
          let onFoodPile = false;
          for (let p = 0; p < world.foodPiles.length; p++) {
            const pile = world.foodPiles[p]!;
            if (pile.tileX === cmd.surfaceTileX && pile.tileY === cmd.surfaceTileY) {
              onFoodPile = true;
              break;
            }
          }
          if (onFoodPile) break;
        }
        // Colony rally-point collision
        if (colony4.rallyPoint !== null &&
            colony4.rallyPoint.tileX === cmd.surfaceTileX &&
            colony4.rallyPoint.tileY === cmd.surfaceTileY) break;
        // Another colony's entrance already occupies this surface tile
        {
          let occupiedByOther = false;
          for (const otherKey in world.colonies) {
            if (!Object.hasOwn(world.colonies, otherKey)) continue;
            const other = world.colonies[otherKey as unknown as ColonyId]!;
            if (other.colonyId === cmd.colonyId) continue;
            if (!other.entrances) continue;
            for (let e = 0; e < other.entrances.length; e++) {
              const oe = other.entrances[e]!;
              if (oe.surfaceTileX === cmd.surfaceTileX && oe.surfaceTileY === cmd.surfaceTileY) {
                occupiedByOther = true;
                break;
              }
            }
            if (occupiedByOther) break;
          }
          if (occupiedByOther) break;
        }
        // Create entrance (not yet open)
        colony4.entrances.push({
          entranceId:   allocateEntityId(world),
          surfaceTileX: cmd.surfaceTileX,
          surfaceTileY: cmd.surfaceTileY,
          isOpen:       false,
        });
        // Auto-mark shaft tiles (tileY=0 .. ENTRANCE_SHAFT_DEPTH-1 at surfaceTileX) for excavation
        for (let sy = 0; sy < ENTRANCE_SHAFT_DEPTH; sy++) {
          if (ugGet(underground, cmd.surfaceTileX, sy) === UndergroundTileState.Solid) {
            ugSet(underground, cmd.surfaceTileX, sy, UndergroundTileState.Marked);
          }
        }
        colony4.digFlowFieldDirty = true;   // typed field (Plan 03 Task 1)
        break;
      }
      case 'SetRallyPoint': {
        const colony = world.colonies[cmd.colonyId];
        if (colony === undefined) break;
        if (cmd.tileX < 0 || cmd.tileX >= SURFACE_GRID_WIDTH) break;
        if (cmd.tileY < 0 || cmd.tileY >= SURFACE_GRID_HEIGHT) break;
        colony.rallyPoint = { tileX: cmd.tileX, tileY: cmd.tileY };
        break;
      }
      case 'ClearRallyPoint': {
        const colony = world.colonies[cmd.colonyId];
        if (colony === undefined) break;
        colony.rallyPoint = null;
        break;
      }
      default: {
        // Exhaustive narrowing — SimCommand is a 9-variant union (Phase 9 adds SetRallyPoint + ClearRallyPoint).
        // Silent-drop unknowns per PRD §5. Do NOT throw, do NOT log (wall-clock-adjacent).
        const _exhaustive: never = cmd;
        void _exhaustive;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Steps 2-8: Per-colony loop
  // ---------------------------------------------------------------------------
  for (const colonyId in world.colonies) {
    if (!Object.hasOwn(world.colonies, colonyId)) continue;
    const colony = world.colonies[colonyId]!;

    // Step 2: Reconcile colony stats (drift-correction recount)
    tickReconcile(world, colony);

    // Step 3: Food consumption (feeds queen and larvae from colony pool)
    tickFoodConsumption(world, colony);

    // Step 4: Starvation check (Phase 6 no-op slot — decrement-on-fail is inline in step 3)
    tickStarvationCheck(world, colony);

    // Step 5: Death cleanup (swap-remove dead entities; sets colony.defeated if queen dead)
    tickDeathCleanup(world, colony);

    // Step 6: Queen egg production (tick-modulo + food threshold gate)
    tickQueenEggProduction(world, colony);

    // Step 7: Lifecycle transitions (egg→larva→worker aging + promotion)
    tickLifecycleTransitions(world, colony);

    // Step 8: Behavior allocation (re-run after lifecycle; handles new matures + deaths from step 7)
    const brood8 = colony.eggCount + colony.larvaeCount;
    const hasNursery8 = hasCompletedChamber(colony, ChamberType.Nursery);
    const alloc8 = allocateWorkers(colony.workerCount, brood8, colony.targetRatio, hasNursery8);
    colony.computedAllocation.nurse  = alloc8.nurse;
    colony.computedAllocation.forage = alloc8.forage;
    colony.computedAllocation.dig    = alloc8.dig;
    colony.computedAllocation.fight  = alloc8.fight;
    colony.nurseCount = alloc8.nurse;
  }

  // Step 5 extension: dead-digger tile reversion (global pass, after per-colony death cleanup)
  // Reverts BeingDug tiles claimed by dead diggers back to Marked (Phase 7 Plan 05).
  tickDeadDiggerCleanup(world);

  // ---------------------------------------------------------------------------
  // Step 9: Recompute dig flow-fields for colonies with dirty flag (NEW in Phase 7)
  // ---------------------------------------------------------------------------
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as ColonyId]!;
    const underground = world.undergroundGrids[colony.colonyId];
    if (!underground) continue;
    const gridSize = underground.width * underground.height;

    // Lazy first-time compute: if the entrance/dig flow-field has never been
    // allocated for this colony, compute it unconditionally on first access.
    // This closes the gap where a colony is created with a pre-excavated
    // entrance (scenario seed) but never issues a dig command — without this,
    // the field would remain all-zeros and empty foragers would "route" north
    // forever. The chamber flow-fields piggy-back on the same gate — they
    // share the underlying topology, so any signal that dirties dig/entrance
    // fields dirties them too. `firstDigCompute` also fires after a cross-
    // session reset via resetFlowFieldCaches(), guaranteeing a fresh/loaded
    // world never reuses another world's cached topology.
    const firstEntranceCompute = !(colony.colonyId in entranceFlowFields.fields);
    const firstDigCompute = !(colony.colonyId in digFlowFields.fields);

    if (
      !colony.digFlowFieldDirty &&
      !colony.foodFlowFieldDirty &&
      !firstEntranceCompute &&
      !firstDigCompute
    ) continue;

    if (colony.digFlowFieldDirty || firstDigCompute) {
      const out = ensureDigFlowField(digFlowFields, colony.colonyId, gridSize);
      const queue = digFlowFields.queues[colony.colonyId]!;
      computeDigFlowField(underground, out, queue);
    }

    // Recompute entrance flow-field on the same topology-changed signal that
    // drives dig recompute: tile state flips (Solid↔Marked↔BeingDug↔Open) and
    // entrance designation/completion all mutate reachability through tunnels.
    const entOut = ensureEntranceFlowField(entranceFlowFields, colony.colonyId, gridSize);
    const entQueue = entranceFlowFields.queues[colony.colonyId]!;
    computeEntranceFlowField(underground, colony.entrances ?? [], entOut, entQueue);

    // Recompute chamber flow-fields on the same cycle. Chamber completion
    // (which flips tile states from Marked/BeingDug to Open) is one of the
    // signals that sets digFlowFieldDirty upstream, so this cadence is
    // sufficient to keep the fields fresh. Issue #15: the food field also
    // recomputes when foodFlowFieldDirty fires (set when a FoodStorage chamber
    // crosses the full↔not-full boundary) so carriers redirect away from full
    // chambers without waiting for an unrelated topology change.
    const chamberBufs = ensureChamberFlowFields(chamberFlowFields, colony.colonyId, gridSize);
    computeChamberFlowField(
      underground,
      colony.chambers,
      FOOD_CHAMBER_TYPES,
      chamberBufs.food,
      chamberBufs.queue,
      // Issue #15 follow-up: saturated chambers (free space <
      // FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP) must not seed the BFS — otherwise
      // a carrier mid-traversal across a near-full chamber gets pinned by
      // the queen-drain-then-redeposit oscillation. Shared with the deposit
      // path in ant-system.ts via `isFoodChamberDepositable`, so seed
      // exclusion and deposit refusal stay in lockstep.
      isFoodChamberDepositable,
    );
    computeChamberFlowField(
      underground,
      colony.chambers,
      NURSING_CHAMBER_TYPES,
      chamberBufs.nursing,
      chamberBufs.queue,
    );
    computeChamberFlowField(
      underground,
      colony.chambers,
      QUEEN_CHAMBER_TYPES,
      chamberBufs.queen,
      chamberBufs.queue,
    );

    colony.digFlowFieldDirty = false;
    colony.foodFlowFieldDirty = false;
  }

  // ---------------------------------------------------------------------------
  // Step 9b: 09 digger-reassignment memo — SearchingFood leash.
  // Release surface SearchingFood ants whose Manhattan distance from their
  // nearest own-colony entrance exceeds the current wave radius. Runs BEFORE
  // step 10a so demoted ants are re-evaluated the same tick under the current
  // computedAllocation (fast triangle responsiveness).
  tickSearchLeash(world);

  // Step 9c: 09 excursion-foraging memo — ReturningToNest transition.
  // Complements step 9b: rather than rebalancing to dig/fight (9b is gated on
  // allocation demand), 9c implements the bounded-excursion loop — any over-
  // leash SearchingFood ant flips to ReturningToNest and routes home via
  // tickAntMovement. On entrance arrival, wave += 1 and subTask flips back to
  // SearchingFood so the ant resumes with a larger leash on the next excursion.
  tickExcursionBoundary(world);

  // Step 10: assignWorkerTasks
  //   10a: existing Phase 6 idle-reassignment (unchanged body from Phase 6 tick.ts step 9)
  //   10b: Phase 7 dig-worker state machine (claim + excavation countdown)
  // ---------------------------------------------------------------------------
  for (const colonyId in world.colonies) {
    if (!Object.hasOwn(world.colonies, colonyId)) continue;
    const colony = world.colonies[colonyId]!;

    // Step 10a: Task assignment (PRD §8a step 9 + §7c as revised by Errata E-01)
    //
    // PRD §8a step 9 + §7c (revised by Errata E-01): reassign AntTask.Idle ants toward
    // computedAllocation, then write taskCensus. Mid-cycle ants (any non-Idle task) are not
    // interrupted; they become eligible on the cycle-completion tick when their action system
    // writes task=Idle (Plan 09 antDepositFood owns Foraging→Idle in Phase 6).

    // (a) Count current per-task totals by iterating colony.workers (skip dead).
    //     Only the 4 target categories; idle is a transient eligibility state, not a census slot.
    let actualForage = 0, actualDig = 0, actualFight = 0, actualNurse = 0, actualIdle = 0;
    for (let i = 0; i < colony.workers.length; i++) {
      const id = colony.workers[i]!;
      if (world.ants.alive[id] !== 1) continue;
      const t = world.ants.task[id]!;
      if      (t === AntTask.Foraging) actualForage += 1;
      else if (t === AntTask.Digging)  actualDig    += 1;
      else if (t === AntTask.Fighting) actualFight  += 1;
      else if (t === AntTask.Nursing)  actualNurse  += 1;
      else                             actualIdle   += 1;
    }

    // (b) Collect ants at PRD §7c idle checkpoints, sorted ascending by EntityId (SCEN-06 determinism).
    //     The eligibility predicate is `task === AntTask.Idle` — the single, uniform rule per §7c
    //     as revised by Errata E-01. The per-task rows of the §7c table (post-deposit for Foraging,
    //     post-excavation for Digging, post-feed for Nursing) describe the action-system transitions
    //     that PUT an ant into AntTask.Idle — NOT sub-state predicates against the current task.
    //     AntTask.Fighting not eligible in Phase 6 — no combat resolution yet (Phase 9 scope).
    const eligible: number[] = [];
    for (let i = 0; i < colony.workers.length; i++) {
      const id = colony.workers[i]!;
      if (world.ants.alive[id] !== 1) continue;
      if (world.ants.task[id] === AntTask.Idle) eligible.push(id);
    }
    // Sort ascending by EntityId — "lowest-EntityId first" per PRD §7c (deterministic per SCEN-06).
    eligible.sort((a, b) => a - b);

    // (c) Walk the sorted eligibles and reassign into under-represented targets.
    //     Canonical target iteration order: forage → dig → fight → nurse (matches PRD §7a result shape).
    //     This deterministic if/else chain is the ONLY selection strategy.
    const need = {
      forage: colony.computedAllocation.forage - actualForage,
      dig:    colony.computedAllocation.dig    - actualDig,
      fight:  colony.computedAllocation.fight  - actualFight,
      nurse:  colony.computedAllocation.nurse  - actualNurse,
    };

    for (let i = 0; i < eligible.length; i++) {
      const id = eligible[i]!;
      let newTask = -1;
      let newSubTask = 0;

      if      (need.forage > 0) { newTask = AntTask.Foraging; newSubTask = ForagingSubState.SearchingFood; need.forage -= 1; }
      else if (need.dig    > 0) { newTask = AntTask.Digging;  newSubTask = DiggingSubState.MovingToTile;   need.dig    -= 1; }
      else if (need.fight  > 0) { newTask = AntTask.Fighting; newSubTask = FightingSubState.MovingToRally; need.fight  -= 1; }
      else if (need.nurse  > 0) { newTask = AntTask.Nursing;  newSubTask = NursingSubState.MovingToBrood;  need.nurse  -= 1; }
      else break; // no remaining under-represented targets; leave rest of eligibles in their current state

      // Decrement actual for the OLD task (so counts stay consistent), increment for new.
      const oldTask = world.ants.task[id]!;
      if      (oldTask === AntTask.Foraging) actualForage -= 1;
      else if (oldTask === AntTask.Digging)  actualDig    -= 1;
      else if (oldTask === AntTask.Fighting) actualFight  -= 1;
      else if (oldTask === AntTask.Nursing)  actualNurse  -= 1;
      else                                   actualIdle   -= 1;

      world.ants.task[id]    = newTask;
      world.ants.subTask[id] = newSubTask;

      if      (newTask === AntTask.Foraging) actualForage += 1;
      else if (newTask === AntTask.Digging)  actualDig    += 1;
      else if (newTask === AntTask.Fighting) actualFight  += 1;
      else if (newTask === AntTask.Nursing)  actualNurse  += 1;
    }

    void actualIdle; // tracked for internal consistency; not exposed on ColonyRecord (Plan 03 removed idleCount)

    // (d) Final census write — true post-reassignment distribution (4 fields: PRD §2 WorkerAllocation).
    colony.taskCensus.forage = actualForage;
    colony.taskCensus.dig    = actualDig;
    colony.taskCensus.fight  = actualFight;
    colony.taskCensus.nurse  = actualNurse;
  }

  // Step 10b: Phase 7 dig-worker state machine (Marked→BeingDug claim, BeingDug→Open countdown).
  // MUST run AFTER idle-reassignment (10a) so newly-assigned dig workers are eligible.
  // MUST run BEFORE checkPendingChambers (step 11) and checkEntranceCompletion (step 12)
  // so same-tick BeingDug→Open transitions are visible to those steps (PRD §9a/§9b).
  tickDigExecution(world, digFlowFields);

  // Step 10c: route AntTask.Fighting ants to colony.rallyPoint (Phase 9 / SURF-04).
  // Global pass (not inlined in 10a) because this is a per-ant task filter,
  // not a per-colony census mutation. Same split as Phase 7 tickDeadDiggerCleanup.
  updateFightAntTargets(world);

  // ---------------------------------------------------------------------------
  // Step 11: checkPendingChambers (NEW in Phase 7)
  //   Promote fully-excavated PendingChambers to ChamberRecords.
  //   Depends on step 10b tickDigExecution having already run this tick.
  // ---------------------------------------------------------------------------
  checkPendingChambers(world);

  // ---------------------------------------------------------------------------
  // Step 12: checkEntranceCompletion (NEW in Phase 7)
  //   Enable entrances whose shaft tiles are now Open.
  //   Depends on step 10b tickDigExecution having already run this tick.
  // ---------------------------------------------------------------------------
  checkEntranceCompletion(world);

  // ---------------------------------------------------------------------------
  // Step 13: routeForagerPriority (NEW in Phase 7)
  //   Route SearchingFood foragers to marked food piles (priority targeting).
  // ---------------------------------------------------------------------------
  routeForagerPriority(world);

  // ---------------------------------------------------------------------------
  // Step 14: Pheromone deposit (per-ant — carry-only rule enforced inside tickPheromoneDeposit)
  // ---------------------------------------------------------------------------
  tickPheromoneDeposit(world);

  // ---------------------------------------------------------------------------
  // Step 15: Pheromone decay (per-grid; select decay rate from grid key)
  // ---------------------------------------------------------------------------
  for (const gridKey in world.pheromoneGrids) {
    if (!Object.hasOwn(world.pheromoneGrids, gridKey)) continue;
    const grid = world.pheromoneGrids[gridKey]!;
    // Key format: "${colonyId}:${pheromoneType}:${zone}"
    // PheromoneType: 0 = FoodTrail, 1 = DangerTrail (per enums.ts)
    const parts = gridKey.split(':');
    const pheromoneType = (parts[1] as unknown as number) | 0;
    const decayRate = pheromoneType === PheromoneType.DangerTrail
      ? DANGER_DECAY_FP
      : PHEROMONE_DECAY_FP;
    tickPheromoneDecay(grid, decayRate);
  }

  // ---------------------------------------------------------------------------
  // Step 16: Movement (zone-aware; DigFlowFields passed for pure direction reads only).
  //          Pure movement — no dig state transitions here (those ran at step 10b).
  // ---------------------------------------------------------------------------
  tickAntMovement(world, rng, digFlowFields, entranceFlowFields, chamberFlowFields);

  // ---------------------------------------------------------------------------
  // Step 16b: Forager arrival actions — pickup (surface) + deposit (underground).
  //           antPickupFood / antDepositFood were unreachable from tick() in Phase 6;
  //           this closes the foraging economy loop per PRD §4c / §4d.
  //           Runs after movement so ants-that-just-arrived this tick act on arrival.
  // ---------------------------------------------------------------------------
  tickForagerActions(world);

  // ---------------------------------------------------------------------------
  // Step 16c: Nurse arrival actions — MovingToBrood → Feeding on chamber tile,
  //           Feeding → Idle so step 10a next tick re-dispatches per allocation.
  //           Without this step, Nursing is a terminal state (step 10a only
  //           reassigns Idle ants), which produced the 09 reproduction-gate
  //           memo's "3 nurses / 0 foragers" lock.
  // ---------------------------------------------------------------------------
  tickNurseActions(world);

  // ---------------------------------------------------------------------------
  // Step 17: combat detection + resolution (Phase 9 / CMBT-04) — runs after step 16 tickAntMovement.
  // ---------------------------------------------------------------------------
  detectAndResolveCombat(world);

  // ---------------------------------------------------------------------------
  // Step 18: game-over detection (Phase 9 / CMBT-06/07).
  // ---------------------------------------------------------------------------
  const outcome = checkQueenDeath(world);

  // ---------------------------------------------------------------------------
  // Step 19: rngState writeback (BEFORE tick increment per PRD §4 serialization contract)
  //          then tick counter increment.
  // ---------------------------------------------------------------------------
  world.rngState = rng.getState();
  world.tick += 1;

  return outcome;
}
