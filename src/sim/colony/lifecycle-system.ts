// lifecycle-system.ts — PRD §4b colony lifecycle pipeline
//
// Implements two exported tick-step functions:
//   1. tickQueenEggProduction  — CLNY-01: queen lays eggs on tick-modulo cadence
//   2. tickLifecycleTransitions — CLNY-02/03: egg→larva→worker transitions + aging
//
// Scope:
//   - No starvation logic (Plan 09)
//   - No ant movement (Plan 09)
//   - No task assignment beyond setting Idle at worker promotion (Plan 10)
//   - No per-tick allocation — swap-remove is O(1) via backwards iteration
//
// Swap-remove pattern (PRD §4b line 388):
//   array[i] = array[array.length - 1]!;
//   array.pop();
// The `!` non-null assertion is safe because we only iterate when i >= 0 and
// array.length > 0, so array[length-1] is always defined.

import type { WorldState } from '../types.js';
import { allocateEntityId } from '../types.js';
import { initAnt } from '../ant/ant-store.js';
import type { ColonyRecord } from './colony-store.js';
import { AntTask, ChamberType } from '../enums.js';
import { hasCompletedChamber, colonyFoodTotal } from './colony-system.js';
import { Zone, ugGet, UndergroundTileState } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import {
  QUEEN_EGG_INTERVAL_TICKS,
  QUEEN_EGG_FOOD_THRESHOLD,
  EGG_HATCH_TICKS,
  LARVA_MATURE_TICKS,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  STARVATION_GRACE_TICKS,
} from '../constants.js';

// ---------------------------------------------------------------------------
// tickQueenEggProduction — CLNY-01
//
// Gating order (PRD §4b line 980 + 09 reproduction-gate memo):
//   1. Tick-modulo gate:  world.tick % QUEEN_EGG_INTERVAL_TICKS !== 0 → return
//   2. Food threshold:    colonyFoodTotal(colony) < QUEEN_EGG_FOOD_THRESHOLD → return
//                         (issue #15 — total stash = entrance pool + every
//                         FoodStorage chamber, NOT colony.foodStored alone)
//   3. Queen alive:       world.ants.alive[colony.queenEntityId] !== 1 → return
//   4. Queen chamber:     colony has at least one COMPLETED Queen chamber (09 memo)
//   5. Nursery chamber:   colony has at least one COMPLETED Nursery chamber (09 memo)
//   6. Queen in chamber:  queen entity Underground and inside a Queen chamber
//                         footprint — debug seed936214196-tick2401 fix. While
//                         she is still routing (Surface / tunnel), no eggs lay
//                         so brood never spawns on the surface.
//
// The chamber gates turn reproduction into an explicit progression unlock: the
// player must excavate both a Queen chamber and a Nursery before brood can
// accumulate. This prevents the pre-memo failure mode where a brand-new colony
// started laying eggs against an empty tunnel, forcing every worker into
// Nursing and starving the queen (see gsd-debug 09 session).
//
// Pending chambers do NOT satisfy either gate — colony.chambers only contains
// promoted entries (see checkPendingChambers, single-path creation invariant).
//
// When all gates pass:
//   - Allocate new entity via allocateEntityId(world)
//   - Pick a "drop tile" inside a Queen chamber that is NOT the queen's tile
//     (issue #22), spread across all non-queen Open tiles by `eggId %
//     openCount`. Falls back to the queen's exact fixed-point coords if no
//     non-queen Open tile exists (1×1 chamber, fully blocked) or if the
//     colony has no underground grid (test harnesses).
//   - initAnt at the chosen drop tile (tile-center fixed-point); zone =
//     Underground (Gate 6 invariant), task=Idle, speed=0, age=0,
//     lifespan=WORKER_LIFESPAN_TICKS.
//   - Push to colony.eggs; increment colony.eggCount
//
// No RNG parameter — egg production is fully deterministic.
// ---------------------------------------------------------------------------

export function tickQueenEggProduction(world: WorldState, colony: ColonyRecord): void {
  // Gate 1: tick-modulo interval
  if ((world.tick % QUEEN_EGG_INTERVAL_TICKS) !== 0) return;

  // Gate 2: food threshold — issue #15: read TOTAL stockpile (entrance pool +
  // every FoodStorage chamber.foodStored). Pre-#15 this read colony.foodStored
  // as the single pool; post-#15 colony.foodStored is only the entrance-shaft
  // pool, so a colony whose entire stash lives in chambers would never lay.
  if (colonyFoodTotal(colony) < QUEEN_EGG_FOOD_THRESHOLD) return;

  // Gate 3: queen alive
  if (world.ants.alive[colony.queenEntityId] !== 1) return;

  // Gate 4/5 (09 reproduction-gate memo): require completed Queen + Nursery
  // chambers before the queen starts laying. Either missing → no eggs.
  if (!hasCompletedChamber(colony, ChamberType.Queen))   return;
  if (!hasCompletedChamber(colony, ChamberType.Nursery)) return;

  // Gate 6 (seed936214196-tick2401 fix): queen must be inside the Queen
  // chamber footprint. Until she has physically routed there (handled by
  // moveQueens in ant-system.ts), no eggs lay — this prevents eggs being
  // spawned on the surface at the queen's starting tile.
  const queenId = colony.queenEntityId;
  if (world.ants.zone[queenId] !== Zone.Underground) return;
  const queenTileX = world.ants.posX[queenId]! >> FP_SHIFT;
  const queenTileY = world.ants.posY[queenId]! >> FP_SHIFT;
  let queenHome = false;
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Queen) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    if (
      queenTileX >= bx && queenTileX < bx + ch.width &&
      queenTileY >= by && queenTileY < by + ch.height
    ) {
      queenHome = true;
      break;
    }
  }
  if (!queenHome) return;

  // Issue #22 — pick a "drop tile" inside a Queen chamber that is NOT the
  // queen's current tile so her sprite (depth 50) does not visually cover
  // the freshly-laid egg sprite (depth 48), AND spread successive eggs
  // across all such tiles so they do not all stack on the same drop tile
  // (which would re-create the same visual hide-under-each-other artifact
  // one tile over). Two-pass count/find using `eggId % openCount` as the
  // spread index, mirroring the issue-#21 fix in transportBroodToNursery.
  //
  // Falls back to the queen's exact fixed-point coords when the colony has
  // no underground grid (test harnesses without grids) or when no non-queen
  // Open tile exists (1×1 chamber, or chamber fully blocked) — the visual
  // artifact is acceptable in those degenerate cases so reproduction still
  // proceeds.
  //
  // eggId is allocated up-front so the spread index is the egg's own ID,
  // matching the brood-transport pattern (deterministic, replay-safe, and
  // independent of colony.eggCount which can be perturbed by death cleanup).
  const eggId = allocateEntityId(world);

  let eggPosX = world.ants.posX[colony.queenEntityId]!;
  let eggPosY = world.ants.posY[colony.queenEntityId]!;
  const underground = world.undergroundGrids[colony.colonyId];
  if (underground) {
    let openCount = 0;
    for (let c = 0; c < colony.chambers.length; c++) {
      const ch = colony.chambers[c]!;
      if (ch.chamberType !== ChamberType.Queen) continue;
      const bx = ch.posX >> FP_SHIFT;
      const by = ch.posY >> FP_SHIFT;
      for (let ty = 0; ty < ch.height; ty++) {
        for (let tx = 0; tx < ch.width; tx++) {
          const cx = bx + tx;
          const cy = by + ty;
          if (cx === queenTileX && cy === queenTileY) continue;
          if (ugGet(underground, cx, cy) === UndergroundTileState.Open) openCount++;
        }
      }
    }
    if (openCount > 0) {
      // eggId is a non-negative entity ID, so the modulo is in [0, openCount).
      const targetIndex = eggId % openCount;
      let cursor = 0;
      outer: for (let c = 0; c < colony.chambers.length; c++) {
        const ch = colony.chambers[c]!;
        if (ch.chamberType !== ChamberType.Queen) continue;
        const bx = ch.posX >> FP_SHIFT;
        const by = ch.posY >> FP_SHIFT;
        for (let ty = 0; ty < ch.height; ty++) {
          for (let tx = 0; tx < ch.width; tx++) {
            const cx = bx + tx;
            const cy = by + ty;
            if (cx === queenTileX && cy === queenTileY) continue;
            if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
            if (cursor === targetIndex) {
              eggPosX = (cx << FP_SHIFT) + (FP_ONE >> 1);
              eggPosY = (cy << FP_SHIFT) + (FP_ONE >> 1);
              break outer;
            }
            cursor++;
          }
        }
      }
    }
  }

  // Init the already-allocated egg entity.
  initAnt(world.ants, eggId, {
    colonyId: colony.colonyId,
    posX:     eggPosX,
    posY:     eggPosY,
    task:     AntTask.Idle,
    subTask:  0,
    speed:    0,                  // eggs don't move
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Underground,   // Gate 6 guarantees queen is Underground
  });

  colony.eggs.push(eggId);
  colony.eggCount += 1;
}

// ---------------------------------------------------------------------------
// tickLifecycleTransitions — CLNY-02 (egg hatch) + CLNY-03 (larva mature)
//
// Three backwards-iteration loops (PRD §4b lines 889-923):
//   1. Eggs:    age++; on age >= EGG_HATCH_TICKS → swap-remove → push to larvae
//   2. Larvae:  age++; on age >= LARVA_MATURE_TICKS → swap-remove → push to workers
//   3. Workers: age++; check lifespan (effectively disabled: WORKER_LIFESPAN_TICKS = INT32_MAX)
//
// Dead entries (alive !== 1) are swap-removed in each loop.
// This is a defensive path for death cleanup by Plan 09; lifecycle transitions
// skip dead entries rather than aging or promoting them.
//
// Age resets to 0 on every bucket transition (egg→larva, larva→worker).
// Worker promotion sets task=Idle and speed=WORKER_BASE_SPEED.
// ---------------------------------------------------------------------------

export function tickLifecycleTransitions(world: WorldState, colony: ColonyRecord): void {
  const ants = world.ants;

  // Snapshot bucket lengths before each phase so newly-promoted entities are
  // not processed in the same tick they are promoted (PRD §4b: one phase-step
  // per tick per bucket; newly pushed IDs start participating next tick).
  const eggSnapLen     = colony.eggs.length;
  const larvaeSnapLen  = colony.larvae.length;
  const workersSnapLen = colony.workers.length;

  // 09 reproduction-gate memo — brood-aging gate. Egg production is already
  // blocked without a completed Queen + Nursery chamber (tickQueenEggProduction
  // gate 4/5), but legacy / save-loaded / debug-seeded eggs and larvae must
  // also be frozen if the colony lacks a completed Nursery at this tick — they
  // must not age or promote. Without this, a save file with brood but no
  // Nursery could still produce workers, violating the agreed design rule
  // that brood requires Nursery support.
  //
  // Freeze semantics: age++ and promotion are skipped for eggs and larvae.
  // Dead-entry swap-remove still runs so starvation / death cleanup is not
  // delayed. Worker aging (Loop 3) is unaffected — existing workers continue
  // to age normally regardless of chamber state.
  const broodFrozen = !hasCompletedChamber(colony, ChamberType.Nursery);

  // ------------------------------------------------------------------
  // Loop 1: Eggs — age + transition to larva on EGG_HATCH_TICKS
  // Backwards iteration + swap-remove preserves O(1) per promotion.
  // Iterates only over eggs that existed at the start of this tick.
  // ------------------------------------------------------------------
  for (let i = eggSnapLen - 1; i >= 0; i--) {
    const id = colony.eggs[i]!;

    // Dead egg — defensive swap-remove (primary cleanup handled by Plan 09)
    if (ants.alive[id] !== 1) {
      colony.eggs[i] = colony.eggs[colony.eggs.length - 1]!;
      colony.eggs.pop();
      colony.eggCount -= 1;
      continue;
    }

    if (broodFrozen) continue; // no age++, no promotion while Nursery missing

    const eggAge = ants.age[id]! + 1;
    ants.age[id] = eggAge;

    if (eggAge >= EGG_HATCH_TICKS) {
      // Promote egg → larva: swap-remove from eggs, reset age, push to larvae
      colony.eggs[i] = colony.eggs[colony.eggs.length - 1]!;
      colony.eggs.pop();
      colony.eggCount -= 1;
      ants.age[id] = 0;         // reset age for larva phase
      ants.starvationTimer[id] = STARVATION_GRACE_TICKS;
      colony.larvae.push(id);
      colony.larvaeCount += 1;
    }
  }

  // ------------------------------------------------------------------
  // Loop 2: Larvae — age + transition to worker on LARVA_MATURE_TICKS
  // Iterates only over larvae that existed at the start of this tick
  // (excludes larvae just promoted from eggs in Loop 1 above).
  // ------------------------------------------------------------------
  for (let i = larvaeSnapLen - 1; i >= 0; i--) {
    const id = colony.larvae[i]!;

    // Dead larva — defensive swap-remove
    if (ants.alive[id] !== 1) {
      colony.larvae[i] = colony.larvae[colony.larvae.length - 1]!;
      colony.larvae.pop();
      colony.larvaeCount -= 1;
      continue;
    }

    if (broodFrozen) continue; // no age++, no promotion while Nursery missing

    const larvaAge = ants.age[id]! + 1;
    ants.age[id] = larvaAge;

    if (larvaAge >= LARVA_MATURE_TICKS) {
      // Promote larva → worker: swap-remove from larvae, reset age, push to workers
      colony.larvae[i] = colony.larvae[colony.larvae.length - 1]!;
      colony.larvae.pop();
      colony.larvaeCount -= 1;
      ants.age[id] = 0;         // reset age for worker phase
      ants.starvationTimer[id] = STARVATION_GRACE_TICKS;
      ants.task[id] = AntTask.Idle;
      ants.speed[id] = WORKER_BASE_SPEED;
      colony.workers.push(id);
      colony.workerCount += 1;
    }
  }

  // ------------------------------------------------------------------
  // Loop 3: Workers — age; lifespan check (disabled in Phase 6 via INT32_MAX)
  // ------------------------------------------------------------------
  for (let i = workersSnapLen - 1; i >= 0; i--) {
    const id = colony.workers[i]!;

    // Dead worker — defensive swap-remove
    if (ants.alive[id] !== 1) {
      colony.workers[i] = colony.workers[colony.workers.length - 1]!;
      colony.workers.pop();
      colony.workerCount -= 1;
      continue;
    }

    const workerAge = ants.age[id]! + 1;
    ants.age[id] = workerAge;

    // Lifespan check — effectively disabled in Phase 6 (WORKER_LIFESPAN_TICKS = 0x7FFFFFFF)
    if (workerAge >= ants.lifespan[id]!) {
      ants.alive[id] = 0;
      // Note: dead workers are removed on the NEXT tick's backwards iteration pass
      // (the worker remains in colony.workers until then — Plan 09 death cleanup
      // will handle immediate removal once implemented)
    }
  }
}
