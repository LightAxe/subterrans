// src/sim/ant/ant-movement.ts
// #212 Layer 2 (orchestrator): tickAntMovement — the per-ant movement tick (PRD §8a
// step 16) — plus same-colony occupancy resolution. Sits ABOVE the behavior modules:
// depends on Layer-0 ant-motion AND Layer-1 behaviors (foraging/queens/combat). Nothing
// in ant/ depends on it; tick.ts is its sole production caller. Owns SURFACE_MOVE_CACHE
// (reset each tick) and OCCUPANCY_SCRATCH.
import type { ChamberFlowFields } from '../chamber-flow.js';
import { isFoodChamberDepositable } from '../colony/colony-system.js';
import {
  SEARCH_LEASH_MAX_WAVE,
  SEARCH_PAUSE_BASE_TICKS,
  SEARCH_PAUSE_JITTER_TICKS,
  SEARCH_PAUSE_TRIGGER_INV_PROB,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
} from '../constants.js';
import type { DigFlowFields } from '../dig-system.js';
import type { EntranceFlowFields } from '../entrance-flow.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import { pheromoneGridKey } from '../pheromone/pheromone-store.js';
import { sampleForagingDirection } from '../pheromone/pheromone-system.js';
import { Rng } from '../rng.js';
import {
  SurfaceMovementEffect,
  createSurfaceMovementCache,
  resetSurfaceMovementCache,
  surfaceMovementAtCached,
} from '../surface-features.js';
import {
  SURFACE_GOAL_UNREACHED,
  stepTowardReachable,
  surfaceGoalDistance,
} from '../surface-routing.js';
import { UndergroundTileState, Zone, ugGet } from '../terrain.js';
import { SIM_VERSION_V25_RALLY_RECALL, type WorldState } from '../types.js';
import {
  pickInvaderUndergroundStep,
  pickNearestHostileUnderground,
} from './ant-combat-targeting.js';
import { chooseExcursionDirection, findReachableScentPile } from './ant-foraging.js';
import {
  ALT_DX,
  ALT_DY,
  DIR_DX,
  DIR_DY,
  canEnterSurfaceTile,
  canEnterUndergroundTile,
  cardinalStepScratch,
  diagonalizeFlowStep,
  getTaskDirection,
  isDescentBlocked,
  pickCardinalStep,
  pickSurfaceDetour,
  unpackStepDx,
  unpackStepDy,
} from './ant-motion.js';
import { collectAliveQueenIds, moveQueens } from './ant-queens.js';
import { clearRecentTiles, isRecentTile, pushRecentTile } from './ant-store.js';

/**
 * Issue #67 — module-level surface movement cache. Reset (not reallocated)
 * each tick by `tickAntMovement`. Allocating ~16 KB of Uint8Array per tick
 * and discarding it was a measurable GC burden in long sessions. Reset is
 * identical to `createSurfaceMovementCache`'s post-construction fill.
 */
// sim-scratch: reset (not reallocated) each tick by tickAntMovement (factory return — not lint-enforced).
const SURFACE_MOVE_CACHE_SCRATCH = createSurfaceMovementCache();

/**
 * Issue #67 — module-level scratch for `resolveSameColonyOccupancy`. Cleared
 * (not reallocated) each call. Map.clear() is much cheaper than `new Map()`
 * + GC release of the prior tick's map.
 */
// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch: Map.clear()ed at the top of each resolveSameColonyOccupancy call; never read before write
const OCCUPANCY_SCRATCH = new Map<number, number>();

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

  // Issue #44 step 5 — per-tick surface movement cache. The SoftCost check
  // fires for every surface ant on every tick; without memoisation each
  // call re-walks the surface-feature selector (anchor scan + suppression).
  // The cache flattens it to O(1) per repeated tile lookup. Pre-v6 worlds
  // never consult it (gate below skips the SoftCost block entirely).
  //
  // Issue #67 — module-level scratch, reset each tick instead of allocating
  // a fresh ~16 KB Uint8Array. The reset is the same fill(255) work that
  // createSurfaceMovementCache does after allocation, just without the
  // allocation+GC churn.
  resetSurfaceMovementCache(SURFACE_MOVE_CACHE_SCRATCH);
  const surfaceMoveCache = SURFACE_MOVE_CACHE_SCRATCH;

  // P1 queen-relocation: queens have their own movement path (route to Queen
  // chamber). They must be skipped in the main loop below so the default
  // Idle-task branch (which triggers needsSurface zone-transition) does not
  // yank a relocated queen back to the surface. Collect the ID set up front.
  const queenIds = collectAliveQueenIds(world);
  moveQueens(world, queenIds, entranceFlowFields, chamberFlowFields, surfaceMoveCache);

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

    // Issue #27 — carrier wait state holds the ant in place until the wake
    // check in tickForagerActions clears the flag (a chamber became
    // depositable or the entrance pool drained). Gate on the same predicate
    // that admits entry (Underground + Foraging + CarryingFood) so that a
    // future code path which mutates task/subTask on a waiting ant can't
    // leave it pinned indefinitely — a flag mismatched with the ant's
    // current task is treated as stale and cleared. The
    // `tickForagerActions` block, by contrast, runs only inside the
    // matching subTask branch, so its check is naturally gated.
    if (ants.waitingDeposit[id] === 1) {
      if (
        zone === Zone.Underground &&
        task === AntTask.Foraging &&
        ants.subTask[id] === ForagingSubState.CarryingFood
      ) {
        continue; // skip movement, stay parked
      }
      // Stale flag — task/subTask/zone changed underneath us. Clear and
      // fall through so this ant moves normally per its current state.
      ants.waitingDeposit[id] = 0;
    }

    let dx = 0;
    let dy = 0;
    // PR 5 Fix-A — true when dx/dy came from the path-aware goal-field primitive
    // (priority or scent). Such a step is wall-avoiding and monotonically
    // approaches the target, so the recent-tiles no-revisit substitution must not
    // override it into a wall or a higher-distance tile (it is bypassed below).
    let targetedStep = false;

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
    if (zone === Zone.Underground && task === AntTask.Foraging && foodCarrying > 0) {
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
                // Issue #70 — tile-center, not tile-corner.
                chamberTargetX = (cx << FP_SHIFT) + (FP_ONE >> 1);
                chamberTargetY = (cy << FP_SHIFT) + (FP_ONE >> 1);
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
          (task === AntTask.Foraging && ants.subTask[id] === ForagingSubState.ReturningToNest);
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
            const dist = Math.abs(ent.surfaceTileX - antTileX) + Math.abs(entDistY - antTileY);
            if (bestDist < 0 || dist < bestDist || (dist === bestDist && ent.entranceId < bestId)) {
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
            // Issue #34 v4 follow-up: lift the cardinal step into a diagonal
            // when the next tile's flow direction is perpendicular and the
            // corner-cut check passes. Foragers use their actual task for
            // passability (AntTask.Foraging blocks Marked tiles).
            diagonalizeFlowStep(
              underground,
              flowField,
              tileX,
              tileY,
              DIR_DX[dir]!,
              DIR_DY[dir]!,
              task as AntTask,
              world.simVersion,
              cardinalStepScratch,
            );
            dx = cardinalStepScratch.dx;
            dy = cardinalStepScratch.dy;
            stepped = true;
          }
          // dir === -2 is unreachable here — chamberFoodUnreachable was set
          // above and the outer branch guards against entering this block.
        }
      }
      if (!stepped) {
        // Cache absent (test harness) — retain the original Manhattan step via
        // pickCardinalStep; deltas are tile-space (all call sites pass tile
        // units, a single consistent unit), matching
        // the production flow-field path's step selection.
        const step = pickCardinalStep(
          ants,
          id,
          (chamberTargetX >> FP_SHIFT) - (posX >> FP_SHIFT),
          (chamberTargetY >> FP_SHIFT) - (posY >> FP_SHIFT),
        );
        dx = unpackStepDx(step);
        dy = unpackStepDy(step);
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
            // Issue #34 v4 follow-up: lift cardinal → diagonal when the next
            // tile's flow direction is perpendicular and the corner-cut
            // check passes. Uses the ant's actual task for passability.
            diagonalizeFlowStep(
              underground,
              flowField,
              tileX,
              tileY,
              DIR_DX[dir]!,
              DIR_DY[dir]!,
              task as AntTask,
              world.simVersion,
              cardinalStepScratch,
            );
            dx = cardinalStepScratch.dx;
            dy = cardinalStepScratch.dy;
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

      // Issue #63 (v11+) — surface ants RETURNING to an open entrance to
      // deposit food consume the surface entrance flow-field instead of
      // straight-line pickCardinalStep. The field is a true BFS through
      // non-HardBlock tiles, so the ant routes around multi-tile feature
      // pockets (4×4 boulders, 6×3 twigs, 3×4 BigLeaves) that the 1-tile
      // pickSurfaceDetour can't escape.
      //
      // Codex P1 follow-up — narrow the BFS branch to ONLY the
      // CarryingFood/ReturningToNest cases the issue described. The
      // surface BFS field is seeded only from OPEN entrances, so any
      // ant with a target that ISN'T an open entrance (Diggers heading
      // to a freshly-designated closed shaft to excavate it; Fighting
      // invaders targeting an enemy's open entrance which isn't on the
      // player's BFS field) would be misrouted toward the nearest open
      // own-colony entrance. Pin the branch to Foraging + Carry/Return
      // and let other tasks fall through to the existing straight-line.
      const subTaskHere = ants.subTask[id]!;
      const isHomeBoundForager =
        task === AntTask.Foraging &&
        (subTaskHere === ForagingSubState.CarryingFood ||
          subTaskHere === ForagingSubState.ReturningToNest);
      if (
        !stepped &&
        zone === Zone.Surface &&
        isHomeBoundForager &&
        entranceFlowFields !== undefined
      ) {
        const colonyId = ants.colonyId[id]!;
        const surfaceField = entranceFlowFields.surface[colonyId];
        if (surfaceField) {
          const tileX = posX >> FP_SHIFT;
          const tileY = posY >> FP_SHIFT;
          if (
            tileX >= 0 &&
            tileX < SURFACE_GRID_WIDTH &&
            tileY >= 0 &&
            tileY < SURFACE_GRID_HEIGHT
          ) {
            const sIdx = tileY * SURFACE_GRID_WIDTH + tileX;
            const sDir = surfaceField[sIdx]!;
            if (sDir === -1) {
              // Source tile — at the entrance. Hold so the zone-transition
              // block below promotes to Underground.
              dx = 0;
              dy = 0;
              stepped = true;
            } else if (sDir >= 0 && sDir < 4) {
              dx = DIR_DX[sDir]!;
              dy = DIR_DY[sDir]!;
              stepped = true;
            }
            // sDir === -2 (unreachable) → fall through to straight-line below.
            // Shouldn't happen in practice (entrance always reachable from any
            // walkable surface tile in a connected map), but defensive.
          }
        }
      }

      if (!stepped) {
        // Codex coord-scale fix: tile-space deltas (see the chamber-target site
        // above for the same-tile rationale).
        const step = pickCardinalStep(
          ants,
          id,
          (entranceTargetX >> FP_SHIFT) - (posX >> FP_SHIFT),
          (entranceTargetY >> FP_SHIFT) - (posY >> FP_SHIFT),
        );
        dx = unpackStepDx(step);
        dy = unpackStepDy(step);
      }
    } else if (task === AntTask.Foraging) {
      // Issue #35 — pause-while-searching. Real ants scurry-stop-scurry; we
      // emulate that here for SearchingFood ants only. Two states:
      //
      //   (a) Already paused (searchPauseTicks > 0) → decrement, hold, skip
      //       the rest of this branch. Movement is (0, 0); the existing
      //       prev→curr render interpolation produces a stationary sprite
      //       (same pattern as the issue #27 carrier wait state).
      //
      //   (b) Not paused → roll the world RNG. On a 1/N hit, set
      //       searchPauseTicks = base + jitter and hold this tick too. The
      //       roll only runs for SearchingFood — CarryingFood and
      //       ReturningToNest are reachability-driven and shouldn't pause.
      //
      // Determinism gating (codex follow-up): the entire pause block is
      // gated on simVersion >= V4 because the RNG pulls below didn't exist
      // pre-v4. A pre-v4 save replaying through this path must NOT consume
      // those rolls or its rng.state diverges from the original record.
      // Sticky simVersion on load (types.ts) keeps v3 saves on the no-pause
      // path forever; new worlds (LATEST_SIM_VERSION = v4) get the feature.
      //
      // Throughput impact (v4 only): ~12% of search time paused with the
      // default constants (probability 1/50, duration 5-9 ticks). Tuned to
      // stay inside the ±15% throughput band acceptance criterion.
      if (ants.subTask[id] === ForagingSubState.SearchingFood && zone === Zone.Surface) {
        if (ants.searchPauseTicks[id]! > 0) {
          ants.searchPauseTicks[id] = ants.searchPauseTicks[id]! - 1;
          continue;
        }
        const trigger = rng.nextU32() % SEARCH_PAUSE_TRIGGER_INV_PROB;
        if (trigger === 0) {
          // Codex P2: the trigger tick is itself stationary (we `continue`
          // below). Setting the counter to `base + jitter` here would make
          // total paused-ticks count = base + jitter + 1, contradicting the
          // documented 5-9 cadence and inflating throughput impact. Subtract
          // 1 so total paused ticks (this trigger tick + next N decrements)
          // equals the (base + jitter) value the constants advertise.
          const jitter = rng.nextU32() % SEARCH_PAUSE_JITTER_TICKS;
          ants.searchPauseTicks[id] = SEARCH_PAUSE_BASE_TICKS + jitter - 1;
          continue;
        }
      }

      // Non-transitioning forager — priority target (step 13), else scent /
      // pheromone / wander.
      const colonyId = ants.colonyId[id]!;
      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      const targetX = ants.targetPosX[id]!;
      const targetY = ants.targetPosY[id]!;
      const ttx = targetX >> FP_SHIFT;
      const tty = targetY >> FP_SHIFT;
      if (targetX !== -1 && targetY !== -1) {
        if (
          zone === Zone.Surface &&
          surfaceGoalDistance(world, tileX, tileY, ttx, tty) !== SURFACE_GOAL_UNREACHED
        ) {
          // Surface + reachable priority pile — PR 5 Fix-A passability-aware step
          // (target identity unchanged; only the STEP is path-aware).
          const step = stepTowardReachable(world, tileX, tileY, ttx, tty);
          dx = unpackStepDx(step);
          dy = unpackStepDy(step);
          targetedStep = true;
        } else {
          // Naive cardinal step toward the target's coords. Two cases land here:
          //  (1) UNDERGROUND zone guard — the surface goal field (read by
          //      surfaceGoalDistance/stepTowardReachable) is meaningless for an
          //      underground forager, which routeForagerPriority still gives a
          //      target; step zone-agnostically toward its coords (pre-PR-5).
          //  (2) A SURFACE target unreachable on the static field. PR 4 guarantees
          //      the colony's CURRENT priority pile shares every forager's
          //      component, so this is necessarily a STALE leftover target (e.g.
          //      from a prior Fighting/zone stint not yet cleared by
          //      routeForagerPriority), pointing at a non-pile tile. The cardinal
          //      step + the surface passability/detour guard below keep the ant
          //      MOVING — it does NOT pin on the wall (the acceptance harness
          //      confirms worst confinement 0 tk and aimedIntoWall 0), and
          //      routeForagerPriority clears the stale target within a tick or two.
          //      We deliberately do NOT assert: stepTowardReachable's internal
          //      throw is a defensive guard, but a benign transient stale target
          //      must not crash the sim (it does occur — e.g. spider-combat
          //      leftovers in the S3 determinism scenarios). Falling through to
          //      wander instead measurably REGRESSES confinement (wander lacks the
          //      cardinal step's directional escape), so the cardinal step is the
          //      correct, cap-satisfying handling.
          const step = pickCardinalStep(ants, id, ttx - tileX, tty - tileY);
          dx = unpackStepDx(step);
          dy = unpackStepDy(step);
        }
      } else {
        // 09 foraging-autonomy memo: short-range scent pull toward an unmarked
        // pile within FOOD_SCENT_RADIUS (path distance). PR 5 Fix-A:
        //  - SURFACE: gate eligibility AND rank by REACHABLE path distance over
        //    the static field (a walled-off in-range pile loses to a reachable
        //    one; final tie-break lowest foodPileId), then step path-aware.
        //    Path-distance eligibility (not Manhattan) keeps the targeted-step
        //    monotonicity invariant: the quantity that gates eligibility is the
        //    one each stepTowardReachable step strictly decreases, so the
        //    selected pile cannot flicker out of range mid-approach (see
        //    findReachableScentPile doc).
        //  - UNDERGROUND: the pre-PR-5 pull steered underground foragers by
        //    SURFACE-pile COORDINATES — meaningless in underground space (it fed
        //    surface tile coords to an underground walker). V29 DELIBERATELY drops
        //    it (scoped behaviour change, called out in the PR body): underground
        //    searchers fall through to pheromone/wander, the correct underground
        //    discovery path. findReachableScentPile reads the surface field, so it
        //    is gated to the surface zone here.
        const scent = zone === Zone.Surface ? findReachableScentPile(world, tileX, tileY) : null;
        if (scent !== null) {
          const step = stepTowardReachable(world, tileX, tileY, scent.tileX, scent.tileY);
          dx = unpackStepDx(step);
          dy = unpackStepDy(step);
          targetedStep = true;
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
              ants.searchPrevTileX[id],
              ants.searchPrevTileY[id],
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
      const isForeignGridUnderground = zone === Zone.Underground && gridColonyId !== ownColonyId;

      let rawDx = 0;
      let rawDy = 0;
      let haveTarget = false;

      if (isForeignGridUnderground) {
        const ownColony = world.colonies[ownColonyId];
        // null colony is treated as NOT recalled (matches isRecallingFromForeign guard
        // in skipAscent) — missing colony record is a defensive fallback, not a recall.
        // V25 (#174): recall keys on the rally point alone — a cleared rally means
        // "come home". Pre-V25 also recalled on fight===0, which fought an explicit
        // rally on the enemy entrance and bounced invaders at the shaft. Kept gated
        // for byte-identical replay of pre-V25 saves. Must stay in lockstep with the
        // ascent `isRecallingFromForeign` / `skipAscent` predicate in the
        // surface-ascent block later in tickAntMovement.
        const isRecalling =
          ownColony != null &&
          (world.simVersion >= SIM_VERSION_V25_RALLY_RECALL
            ? ownColony.rallyPoint == null
            : ownColony.targetRatio.fight === 0 || ownColony.rallyPoint == null);

        if (isRecalling) {
          // Recalled invader: navigate toward the nearest foreign entrance exit
          // (underground tileY=0 at the shaft column) so skipAscent=false allows ascent.
          const foreignColony = world.colonies[gridColonyId];
          const fEnts = foreignColony?.entrances;
          if (fEnts != null && fEnts.length > 0) {
            // Pick nearest open entrance; fall back to nearest any entrance.
            const antTileX = posX >> FP_SHIFT;
            const antTileY = posY >> FP_SHIFT;
            let bestEnt = fEnts[0]!;
            let bestDist = Math.abs(bestEnt.surfaceTileX - antTileX) + antTileY;
            let bestIsOpen = bestEnt.isOpen;
            for (let ei = 1; ei < fEnts.length; ei++) {
              const candidate = fEnts[ei]!;
              const dist = Math.abs(candidate.surfaceTileX - antTileX) + antTileY;
              const improves =
                (candidate.isOpen && !bestIsOpen) ||
                (candidate.isOpen === bestIsOpen && dist < bestDist);
              if (improves) {
                bestEnt = candidate;
                bestDist = dist;
                bestIsOpen = candidate.isOpen;
              }
            }
            rawDx = (bestEnt.surfaceTileX << FP_SHIFT) - posX;
            rawDy = -posY; // target underground Y=0 (entrance row)
            haveTarget = true;
          }
          // else: no enemy entrance → hold (dx=dy=0 fallback)
        } else {
          const hostile = pickNearestHostileUnderground(ants, id, gridColonyId);
          if (hostile !== null) {
            const invUnderground = world.undergroundGrids[gridColonyId];
            if (invUnderground) {
              // Wall-aware greedy step — avoids freezing against solid
              // walls that blocked the direct cardinal path. See
              // pickInvaderUndergroundStep. Routes through rawDx/rawDy so the
              // shared pickCardinalStep block does the FP→step conversion.
              const tileX = posX >> FP_SHIFT;
              const tileY = posY >> FP_SHIFT;
              const tTileX = hostile.targetX >> FP_SHIFT;
              const tTileY = hostile.targetY >> FP_SHIFT;
              const step = pickInvaderUndergroundStep(invUnderground, tileX, tileY, tTileX, tTileY);
              rawDx = unpackStepDx(step) * FP_ONE;
              rawDy = unpackStepDy(step) * FP_ONE;
            } else {
              rawDx = hostile.targetX - posX;
              rawDy = hostile.targetY - posY;
            }
            haveTarget = true;
          }
          // hostile === null → idle fallback: dx=dy=0 (haveTarget stays false)
        }
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
        // Codex coord-scale fix: rawDx/rawDy were FP-space (target − pos, both
        // fp). Recompute as tile-space so the same-tile hold (absDx/absDy === 0
        // in pickCardinalStep) is decided in tile units, matching the queen and
        // scent paths. The original target is recoverable as `rawDx + posX`
        // (== absolute fp target X).
        const targetTileX = (rawDx + posX) >> FP_SHIFT;
        const targetTileY = (rawDy + posY) >> FP_SHIFT;
        const tileX = posX >> FP_SHIFT;
        const tileY = posY >> FP_SHIFT;
        const step = pickCardinalStep(ants, id, targetTileX - tileX, targetTileY - tileY);
        dx = unpackStepDx(step);
        dy = unpackStepDy(step);
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

    // Issue #42 fix #3 — surface SearchingFood no-revisit filter. v6+ only.
    // If the proposed step lands on a tile in the ant's recent-tiles ring
    // buffer, scan the 8-connected alternates in a fixed order and pick the
    // first one that is BOTH not in the buffer AND inside the surface grid.
    // The bounds check matters at the map edge (e.g. an ant at y=0 whose
    // proposed step is in the buffer must not pick N — that would clamp
    // back to the same tile, no tile-cross occurs, the buffer doesn't
    // advance, and the ant stalls indefinitely with valid in-bounds
    // alternates still available). If every neighbor is filtered, pause
    // (dx=dy=0); the buffer-push gate (only on actual tile crossings) keeps
    // pause ticks from polluting history.
    //
    // PR 5 Fix-A — a path-aware priority/scent step (`targetedStep`) is BYPASSED:
    // it is wall-avoiding and strictly decreases goal-field distance every tick,
    // so it can never loop, and a no-revisit alternate would risk steering it
    // into a wall or a higher-distance tile (R2 + R4-5). No-revisit still applies
    // to the untargeted wander/pheromone path, where C-both's deeper buffer helps.
    // The no-loop claim also holds across per-tick scent RESELECTION because
    // findReachableScentPile gates eligibility on PATH distance: the previously
    // targeted pile's path distance shrank by 1, so it stays eligible and the
    // SELECTED pile's path distance strictly decreases every scent-targeted tick
    // (a monotone potential), regardless of which pile wins reselection.
    if (
      !targetedStep &&
      zone === Zone.Surface &&
      task === AntTask.Foraging &&
      ants.subTask[id] === ForagingSubState.SearchingFood &&
      (dx !== 0 || dy !== 0)
    ) {
      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      if (isRecentTile(ants, id, tileX + dx, tileY + dy)) {
        // Try 8 cardinals/diagonals in N-clockwise order (N, NE, E, SE, S,
        // SW, W, NW) — fixed and deterministic, the same neighbor sweep the
        // queen overlap resolver uses, so the alternate-pick is easy to
        // reason about across the codebase.
        let found = false;
        for (let i = 0; i < ALT_DX.length; i++) {
          const ax = ALT_DX[i]!;
          const ay = ALT_DY[i]!;
          if (ax === dx && ay === dy) continue; // already-rejected proposal
          const candX = tileX + ax;
          const candY = tileY + ay;
          // Bounds check — out-of-grid alternates clamp to a no-op step
          // and would stall the ant at the map edge. Reject before they
          // can be picked.
          if (candX < 0 || candX >= SURFACE_GRID_WIDTH || candY < 0 || candY >= SURFACE_GRID_HEIGHT)
            continue;
          if (isRecentTile(ants, id, candX, candY)) continue;
          dx = ax;
          dy = ay;
          found = true;
          break;
        }
        if (!found) {
          dx = 0;
          dy = 0;
        }
      }
    }

    // S0a / issue #120 — V14+ underground CarryingFood no-revisit filter.
    // Mirrors the surface SearchingFood guard above (V6+), extended to
    // underground Foraging+CarryingFood ants so they cannot oscillate on
    // the FoodStorage chamber landing tile. Uses 4-connected cardinal
    // alternates (not 8-connected) to avoid underground corner-cut issues;
    // each candidate is checked for underground passability before selection.
    //
    // When no non-recent passable alternate exists (narrow tunnel), the guard
    // is skipped and the ant proceeds with its original direction. Holding
    // (dx=dy=0) would deadlock the ant permanently because the ring buffer
    // only advances on tile crossings and never ages out while stationary.
    if (
      zone === Zone.Underground &&
      task === AntTask.Foraging &&
      ants.subTask[id] === ForagingSubState.CarryingFood &&
      (dx !== 0 || dy !== 0)
    ) {
      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      if (isRecentTile(ants, id, tileX + dx, tileY + dy)) {
        const gridColonyId = ants.currentGridColonyId[id]!;
        const underground = world.undergroundGrids[gridColonyId];
        if (underground) {
          for (let i = 0; i < DIR_DX.length; i++) {
            const ax = DIR_DX[i]!;
            const ay = DIR_DY[i]!;
            if (ax === dx && ay === dy) continue;
            const candX = tileX + ax;
            const candY = tileY + ay;
            if (
              candX < 0 ||
              candX >= UNDERGROUND_GRID_WIDTH ||
              candY < 0 ||
              candY >= UNDERGROUND_GRID_HEIGHT
            )
              continue;
            if (!canEnterUndergroundTile(underground, candX, candY, task as AntTask)) continue;
            if (isRecentTile(ants, id, candX, candY)) continue;
            dx = ax;
            dy = ay;
            break;
          }
        }
      }
    }

    const baseSpeed = ants.speed[id]!;
    const prevPosX = ants.posX[id]!;
    const prevPosY = ants.posY[id]!;

    // Surface SoftCost slowdown (issue #44 step 5 — gated on v6). When the
    // ant's current tile is a SoftCost feature (bush / grass clump), halve
    // effective speed for this tick. Integer-only; min 1 so a base speed
    // of 1 doesn't get clamped to zero. Pre-v6 ants move at base speed.
    // Underground ants skip the check entirely (zone gate). Per-tick cache
    // memoises the lookup so repeated same-tile queries are O(1).
    let speed = baseSpeed;
    if (zone === Zone.Surface) {
      const tileX = prevPosX >> FP_SHIFT;
      const tileY = prevPosY >> FP_SHIFT;
      if (
        surfaceMovementAtCached(world, tileX, tileY, surfaceMoveCache) ===
        SurfaceMovementEffect.SoftCost
      ) {
        const halved = baseSpeed >> 1;
        speed = halved < 1 ? 1 : halved;
      }
    }
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
        const taskAsAntTask = task as AntTask;
        const xCrossed = newTileX !== prevTileX;
        const yCrossed = newTileY !== prevTileY;
        if (xCrossed && yCrossed) {
          // Diagonal tile crossing (issue #34 v4) — corner-cut prevention.
          // Reject the diagonal when the destination tile is impassable OR
          // BOTH intermediate cardinal tiles are blocked (squeezing through
          // a wall corner). When only one intermediate is open, drop the
          // other axis so the ant hugs that side.
          const destPassable = canEnterUndergroundTile(
            underground,
            newTileX,
            newTileY,
            taskAsAntTask,
          );
          const passXOnly = canEnterUndergroundTile(
            underground,
            newTileX,
            prevTileY,
            taskAsAntTask,
          );
          const passYOnly = canEnterUndergroundTile(
            underground,
            prevTileX,
            newTileY,
            taskAsAntTask,
          );
          if (destPassable && (passXOnly || passYOnly)) {
            // Diagonal allowed — keep both axis updates.
          } else if (passXOnly) {
            posY = prevPosY;
          } else if (passYOnly) {
            posX = prevPosX;
          } else {
            posX = prevPosX;
            posY = prevPosY;
          }
        } else if (xCrossed) {
          // Cardinal-tile X crossing only (Y move stayed inside prevTileY).
          // Check the actually-entered tile (newTileX, prevTileY); if blocked
          // revert ONLY posX so any sub-tile Y progress survives. v3 cardinal
          // steps put dy=0 here so the posY revert was a no-op; the per-axis
          // form preserves v4 sub-tile diagonals where Y didn't cross a tile.
          if (!canEnterUndergroundTile(underground, newTileX, prevTileY, taskAsAntTask)) {
            posX = prevPosX;
          }
        } else if (yCrossed) {
          // Cardinal-tile Y crossing only — symmetric to the X case.
          if (!canEnterUndergroundTile(underground, prevTileX, newTileY, taskAsAntTask)) {
            posY = prevPosY;
          }
        }
      }
    }

    // Surface passability guard + detour (issue #44 step 4 — gated on v6).
    // Mirrors the underground guard above. HardBlock features (boulders,
    // twigs, leaves, big leaves) reject the step; pickSurfaceDetour finds
    // the best walkable adjacent tile. Pre-v6 saves replay with no surface
    // passability — same coordinate-only motion they recorded.
    if (zone === Zone.Surface && (dx !== 0 || dy !== 0)) {
      const prevTileX = prevPosX >> FP_SHIFT;
      const prevTileY = prevPosY >> FP_SHIFT;
      const newTileX = posX >> FP_SHIFT;
      const newTileY = posY >> FP_SHIFT;
      const xCrossed = newTileX !== prevTileX;
      const yCrossed = newTileY !== prevTileY;
      let blocked = false;
      if (xCrossed && yCrossed) {
        // Diagonal step. Three checks: destination tile passable, both
        // intermediate cardinals passable. Recent-tiles consult on the
        // intermediates (per-axis revert) prevents the ant from being
        // pushed sideways onto a tile it just came from — without that
        // check the ant ping-pongs west↔east through the same two tiles
        // when wedged against an obstacle (UAT round 2 stuck-ant repro,
        // ant 17 in seed 1790811502).
        // PR 5 Fix-A — a path-aware targeted step is never a corner-squeeze
        // (stepTowardReachable only returns a diagonal when at least one shared
        // orthogonal is itself a descending passable step, so the per-axis revert
        // below always has a legal cardinal), and must not be diverted by the
        // no-revisit (recent-tiles) consult. Keep the pure passability checks but
        // skip the recent-tiles veto when `targetedStep`.
        const destPassable = canEnterSurfaceTile(world, newTileX, newTileY);
        const passXOnly =
          canEnterSurfaceTile(world, newTileX, prevTileY) &&
          (targetedStep || !isRecentTile(ants, id, newTileX, prevTileY));
        const passYOnly =
          canEnterSurfaceTile(world, prevTileX, newTileY) &&
          (targetedStep || !isRecentTile(ants, id, prevTileX, newTileY));
        if (destPassable && (passXOnly || passYOnly)) {
          // Diagonal allowed.
        } else if (passXOnly) {
          posY = prevPosY;
        } else if (passYOnly) {
          posX = prevPosX;
        } else {
          blocked = true;
        }
      } else if (xCrossed && !canEnterSurfaceTile(world, newTileX, prevTileY)) {
        blocked = true;
      } else if (yCrossed && !canEnterSurfaceTile(world, prevTileX, newTileY)) {
        blocked = true;
      }
      if (blocked) {
        const detour = pickSurfaceDetour(world, prevTileX, prevTileY, dx, dy, id);
        if (detour.dx !== 0 || detour.dy !== 0) {
          // Snap-to-tile-boundary instead of `prev + detour * speed`.
          // Ants at half-speed (e.g. base WORKER_BASE_SPEED = 128 = ½ tile/
          // tick) would otherwise NOT cross the tile boundary on a single
          // detour step — they'd nudge sub-tile and the next tick's
          // steering would nudge them back, producing two-tick sub-tile
          // oscillation inside the same tile. The snap commits the
          // detour decision visibly (one-tile jump in the chosen
          // direction) and pushes the just-vacated tile onto the
          // recent-tiles ring buffer so subsequent detours skip it.
          // Visual: a wedged ant takes a slightly larger step on the
          // tick it detours; only fires when blocked, so rare in
          // normal play.
          posX = ((prevTileX + detour.dx) << FP_SHIFT) + (FP_ONE >> 1);
          posY = ((prevTileY + detour.dy) << FP_SHIFT) + (FP_ONE >> 1);
        } else {
          // No walkable detour candidate — hold in place. Next tick the
          // steering recomputes; if the situation persists, the ant
          // continues to hold (preferable to oscillation).
          posX = prevPosX;
          posY = prevPosY;
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
    if (zone === Zone.Surface && task === AntTask.Foraging) {
      // Issue #44 UAT round 2 fix: extended from SearchingFood-only to
      // ALL surface Foraging ants (CarryingFood, ReturningToNest too).
      // The recent-tiles ring buffer is now consulted by
      // `pickSurfaceDetour` to skip "step back to where I just came
      // from" candidates, which fixes the v7-detour two-tile oscillation
      // observed in the 2026-05-02T15:10 stuck-ant snapshot (ant 17 at
      // (24/25, 75) bouncing east-west south of a 4×4 boulder). The
      // SearchingFood-only no-revisit filter (gated below in pickStep
      // assembly) is unchanged — broadening it would risk pinning
      // CarryingFood/ReturningToNest ants when their entrance route is
      // fully encircled by a recent-tiles ring; the detour-only consult
      // is safer.
      const isSearching = ants.subTask[id] === ForagingSubState.SearchingFood;
      const preTileX = prevPosX >> FP_SHIFT;
      const preTileY = prevPosY >> FP_SHIFT;
      const newTileX = posX >> FP_SHIFT;
      const newTileY = posY >> FP_SHIFT;
      if (newTileX !== preTileX || newTileY !== preTileY) {
        if (isSearching) {
          // searchPrevTileX/Y is the SearchingFood anti-backtrack memo;
          // leave its semantics unchanged.
          ants.searchPrevTileX[id] = preTileX;
          ants.searchPrevTileY[id] = preTileY;
        }
        // Push the just-vacated tile onto the recent-tiles ring buffer
        // for ANY surface Foraging ant. Pause ticks (no tile
        // crossing) intentionally do NOT push, so the buffer tracks
        // distinct moves rather than ticks.
        pushRecentTile(ants, id, preTileX, preTileY);
      }
    }

    // S0a / issue #120 — V14+ underground CarryingFood ring-buffer push.
    // Tracks the just-vacated tile so the no-revisit filter above can prevent
    // oscillation on FoodStorage chamber landing tiles. Push only on actual
    // tile crossings (same as the surface path); pause ticks don't advance
    // the buffer. Cleared on full deposit (antDepositFood clearRecentTiles).
    if (
      zone === Zone.Underground &&
      task === AntTask.Foraging &&
      ants.subTask[id] === ForagingSubState.CarryingFood
    ) {
      const preTileXU = prevPosX >> FP_SHIFT;
      const preTileYU = prevPosY >> FP_SHIFT;
      const newTileXU = posX >> FP_SHIFT;
      const newTileYU = posY >> FP_SHIFT;
      if (newTileXU !== preTileXU || newTileYU !== preTileYU) {
        pushRecentTile(ants, id, preTileXU, preTileYU);
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
      if (task === AntTask.Foraging && ants.subTask[id] === ForagingSubState.ReturningToNest) {
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
              ants.searchWave[id] =
                nextWave > SEARCH_LEASH_MAX_WAVE ? SEARCH_LEASH_MAX_WAVE : nextWave;
              ants.searchHeadingX[id] = 0;
              ants.searchHeadingY[id] = 0;
              ants.searchHeadingTicks[id] = 0;
              ants.searchPrevTileX[id] = -1;
              ants.searchPrevTileY[id] = -1;
              // Issue #35 — clean pause cadence on entrance arrival.
              ants.searchPauseTicks[id] = 0;
              // Issue #42 fix #3 — entrance arrival flips ReturningToNest
              // back to SearchingFood; the new excursion should start with
              // a clean recent-tiles buffer (no carry-over from the route
              // that just ended).
              clearRecentTiles(ants, id);
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
          if (!Object.hasOwn(world.colonies, cidKey)) continue;
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

            // Pre-descent gate (#164, #165): hold the ant on the surface when
            // a blocker on the entrance tile should resolve this tick (rampaging
            // spider blockade, or a surface queen a foreign Fighter must engage).
            // `continue` skips descent through this entrance; with no other
            // matching entrance the ant stays on the surface for combat.
            if (isDescentBlocked(world, task, isOwnEntrance, colony, tileX, tileY)) {
              continue;
            }

            // PR 6-sim (V30, #128 class-ii) — landing-tile validity guard. Descent
            // sets posY=0 at the ant's column; pre-V30 there was NO check that the
            // landing tile (tileX, 0) is enterable, so an ant could descend onto a
            // Solid/Marked tile and embed. Land ONLY on a tile this ant's task can
            // enter; otherwise BLOCK descent in place (stay on the surface this
            // tick, re-checked next tick) — never seek a "nearest legal landing",
            // which could teleport the ant laterally into an unrelated tunnel.
            // Fail CLOSED: a missing grid (unreachable in normal play — every
            // colony gets one at init) means there is nowhere valid to land, so
            // block descent rather than silently skip the embedding guard.
            const landingGrid = world.undergroundGrids[colony.colonyId];
            if (
              landingGrid === undefined ||
              !canEnterUndergroundTile(landingGrid, tileX, 0, task)
            ) {
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
            // V14: clear the recent-tiles ring buffer on descent so stale
            // surface coordinates don't produce false-positive no-revisit
            // deflections in the underground CarryingFood guard.
            clearRecentTiles(ants, id);
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
          // Issue #106 (v13+) — ascent reads the GRID the ant is currently
          // in (`currentGridColonyId`), not the ant's owning colony. For
          // Fighter invaders in foreign grids, `currentGridColonyId !==
          // colonyId` by design (see descent comment above). Pre-v13 used
          // `colonyId` and an invader could ascend through any of its
          // OWN-colony entrances that happened to share the underground
          // tileX it occupied inside the enemy grid — a "warp home"
          // movement bug.
          //
          // The fix has two parts:
          //   (1) Lookup uses currentGridColonyId, so ascent honors the
          //       grid the ant occupies.
          //   (2) Fighting invaders in foreign grids skip ascent entirely
          //       (mirrors the descent code's `isFightingForeigner` logic).
          //       Without (2), an invader bounces back to the surface every
          //       other tick: descent → ascent through enemy entrance →
          //       descent → ascent → ... pre-v13 the wrong-colony lookup
          //       accidentally masked this by failing to find an entrance,
          //       which is also why the warp-home bug only surfaced on
          //       coincidental tileX alignment.
          const inOwnGrid = ants.currentGridColonyId[id] === ants.colonyId[id];
          // Recalled invaders must be able to exit the enemy underground, so
          // skipAscent is cleared for them. V25 (#174): recall keys on a cleared
          // rally alone. Pre-V25 also recalled on fight===0, which made invaders
          // ascend the moment they reached tileY=0 on the enemy entrance column
          // even with a rally explicitly set there, producing a descend/ascend
          // bounce. Kept gated for byte-identical replay. Must match the
          // underground recall-navigation `isRecalling` predicate in the
          // recalled-invader block earlier in tickAntMovement.
          const ownColonyForAscent = world.colonies[ants.colonyId[id]!];
          const isRecallingFromForeign =
            !inOwnGrid &&
            ownColonyForAscent != null &&
            (world.simVersion >= SIM_VERSION_V25_RALLY_RECALL
              ? ownColonyForAscent.rallyPoint == null
              : ownColonyForAscent.targetRatio.fight === 0 ||
                ownColonyForAscent.rallyPoint == null);
          const skipAscent = task === AntTask.Fighting && !inOwnGrid && !isRecallingFromForeign;
          if (!skipAscent) {
            const lookupColonyId = ants.currentGridColonyId[id]!;
            const colony = world.colonies[lookupColonyId];
            if (colony && colony.entrances) {
              for (let e = 0; e < colony.entrances.length; e++) {
                const entrance = colony.entrances[e]!;
                if (entrance.isOpen && entrance.surfaceTileX === tileX) {
                  ants.zone[id] = Zone.Surface;
                  ants.posY[id] = entrance.surfaceTileY << FP_SHIFT;
                  // Restore the surface invariant. For ants in their own
                  // grid this is a no-op (already equal). For an invader
                  // who eventually leaves via the enemy entrance after
                  // being re-promoted out of Fighting (e.g. Idle), this
                  // snaps the grid id back to their own colony.
                  ants.currentGridColonyId[id] = ants.colonyId[id]!;
                  break;
                }
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
  // Issue #67 — reuse a module-level Map instead of allocating per tick.
  // Map.clear() is O(n) where n is the size of the previous tick's map;
  // negligible vs. the prior `new Map()` + GC churn. Same observable
  // behavior — Map iteration order is insertion order, which we don't
  // rely on (lookups are key-based).
  const occupancy = OCCUPANCY_SCRATCH;
  occupancy.clear();

  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1) continue;

    // Issue #17 Phase 1 — brood entities currently being carried by an alive
    // nurse follow the nurse's position via `tickNurseActions` step 16c sync,
    // so they MUST NOT participate in occupancy displacement. Otherwise the
    // resolver would bump the brood off the carrier's tile every tick of in-
    // tunnel transit, the next 16c sync would snap it back, and the player
    // would see a 1-tile-jitter visual artifact + the carry render offset
    // would briefly appear above an empty tile.
    const carrierId = ants.carriedBy[id]!;
    if (carrierId !== -1 && ants.alive[carrierId] === 1) continue;

    const colonyId = ants.colonyId[id]!;
    const zone = ants.zone[id]!;
    // Issue #61 — include `gridColonyId` in the occupancy key so cross-grid
    // ants (Phase 09.1 Chunk 3+4 fighter invaders with currentGridColonyId !==
    // colonyId) never alias home-grid same-colony ants. Today gridColonyId ===
    // colonyId for every ant by construction (initAnt establishes the
    // invariant; only mid-attack invaders break it once 09.1 lands), so the
    // key value differs from pre-fix but ant pairs collide at the same key —
    // observable behavior unchanged. Shifts when invasion lands.
    //
    // Bit layout (preserves existing 17 low bits for zone + tile coords,
    // adds gridColonyId in bits 17..23 — 7 bits is plenty since ColonyId is
    // a small enum):
    //   bits  0..6  : tileX (0..127)
    //   bits  7..14 : tileY (0..127, fits SURFACE_GRID_HEIGHT and underground)
    //   bit  15     : zone (0 = Surface, 1 = Underground)
    //   bits 16..22 : colonyId (0..127)
    //   bits 23..29 : gridColonyId (0..127)
    const rawGridColonyId = ants.currentGridColonyId[id]!;
    let tileX = ants.posX[id]! >> FP_SHIFT;
    let tileY = ants.posY[id]! >> FP_SHIFT;

    if (isOccupancyExempt(world, colonyId, zone, tileX, tileY)) continue;

    // Issue #108 (v13+) — zero the gridColonyId portion of the key when
    // zone === Surface. Mirrors combat tile-key encoding (tile-key.ts:56);
    // pre-v13 this resolver keyed on the raw gridColonyId, so two same-
    // colony surface ants with diverging `currentGridColonyId` (post-#106
    // ascent bug) produced different keys and stacked silently.
    const gridByte = zone !== Zone.Underground ? 0 : rawGridColonyId;
    const key = (gridByte << 23) | (colonyId << 16) | (zone << 15) | (tileY << 7) | tileX;
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
    const underground =
      zone === Zone.Underground ? world.undergroundGrids[rawGridColonyId] : undefined;
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
        // Don't bump a same-colony collision into a HardBlock tile.
        if (!canEnterSurfaceTile(world, nx, ny)) continue;
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
      // Issue #61 — same key layout as the primary key above. Issue #108
      // (v13+): mirror the same gridByte mask so adjacent-tile lookup keys
      // match the primary lookup. Pre-v13 used `rawGridColonyId` here too;
      // safe because pre-v13 occupancy resolution never crosses zones.
      const adjKey = (gridByte << 23) | (colonyId << 16) | (zone << 15) | (ny << 7) | nx;
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
    if (tileX >= bx && tileX < bx + chamber.width && tileY >= by && tileY < by + chamber.height) {
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
