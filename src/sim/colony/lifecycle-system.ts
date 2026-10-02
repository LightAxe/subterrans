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
import { allocateEntityId, INVALID_ENTITY_ID, SIM_VERSION_V70_EGG_RESERVE } from '../types.js';
import { initAnt } from '../ant/ant-store.js';
import { despawnAnt } from '../ant-death.js';
import type { ColonyRecord } from './colony-store.js';
import { AntTask, ChamberType } from '../enums.js';
import { hasCompletedChamber } from './colony-system.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../food/food-api.js';
import {
  FIGHTER_HUNGER,
  LARVA_HUNGER,
  QUEEN_HUNGER,
  WORKER_HUNGER,
  runwayFoodFp,
  workerHungerProfile,
} from '../hunger.js';
import { Zone, ugGet, UndergroundTileState } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import {
  QUEEN_EGG_FOOD_THRESHOLD,
  QUEEN_EGG_RESERVE_RUNWAY_TICKS,
  QUEEN_EGG_INTERVAL_DISABLED,
  QUEEN_EGG_INTERVAL_BASE_TICKS,
  QUEEN_EGG_INTERVAL_MEDIUM_TICKS,
  QUEEN_EGG_INTERVAL_FAST_TICKS,
  QUEEN_EGG_INTERVAL_FLOOR_TICKS,
  COLONY_SIZE_FLOOR,
  FOOD_PER_ANT_BASELINE,
  EGG_HATCH_TICKS,
  LARVA_MATURE_TICKS,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  MIN_EGG_INTERVAL_TICKS,
  COMBAT_HP_BASE,
  COMBAT_HP_HOMEGROUND_BONUS,
} from '../constants.js';

// ---------------------------------------------------------------------------
// tickQueenEggProduction — CLNY-01
//
// Gating order (PRD §4b line 980 + 09 reproduction-gate memo):
//   1. Tick-modulo gate:  world.tick % QUEEN_EGG_INTERVAL_TICKS !== 0 → return
//   2. Food threshold:    colonyFoodTotal(colony) < QUEEN_EGG_FOOD_THRESHOLD → return
//                         (before V70 only; issue #15 — total stash = entrance
//                         pool + every FoodStorage chamber, NOT the entrance pool
//                         alone)
//   3. Queen alive:       world.ants.alive[colony.queenEntityId] !== 1 → return
//   4. Queen chamber:     colony has at least one COMPLETED Queen chamber (09 memo)
//   5. Nursery chamber:   colony has at least one COMPLETED Nursery chamber (09 memo)
//   6. Queen in chamber:  queen entity Underground and inside a Queen chamber
//                         footprint — debug seed936214196-tick2401 fix. While
//                         she is still routing (Surface / tunnel), no eggs lay
//                         so brood never spawns on the surface.
//   7. Egg reserve:       from V70 (#395), in place of Gate 2:
//                         colonyFoodTotal(colony) < eggReserveFp(colony) → return.
//                         Last because it is the only gate that walks the worker
//                         roster; the gates are pure early returns, so their order
//                         changes nothing else.
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
// From V70 (#395) a FoodStorage chamber is effectively required too: the smallest
// egg reserve (3600 fp at the 60 s runway) is more than the entrance pool holds
// (BASE_FOOD_STORAGE_CAPACITY, 2048), and storage capacity then caps the brood
// (QUEEN_EGG_RESERVE_RUNWAY_TICKS).
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

// ---------------------------------------------------------------------------
// eggIntervalForColony — surplus-scaled egg interval
//
// Before V70, returns QUEEN_EGG_INTERVAL_DISABLED (-1) when food is below the
// gate threshold (Gate 2 absorbs this; returning -1 keeps Gate 1 clean). From
// V70 (#395) there is no threshold here: Gate 7's egg reserve decides alone (it
// is never below 3 food, so dropping the early-out changes no outcome).
// Returns one of four interval constants based on surplus ratio. Uses pure
// integer multiplication comparisons to avoid division and bitwise truncation:
//   food10 >= K * denom  ↔  surplus ratio ≥ K/10
// JS numbers are 64-bit floats; integers up to 2^53 are exact, so even
// extreme stockpiles cannot overflow or round incorrectly.
// ---------------------------------------------------------------------------

function eggIntervalForColony(world: WorldState, colony: ColonyRecord): number {
  const foodTotal = colonyFoodTotal(world, colony);
  if (world.simVersion < SIM_VERSION_V70_EGG_RESERVE && foodTotal < QUEEN_EGG_FOOD_THRESHOLD) {
    return QUEEN_EGG_INTERVAL_DISABLED;
  }
  const mouthsRaw = colony.workerCount + colony.larvaeCount + colony.eggCount + 1; // +1 queen
  const mouths = Math.max(mouthsRaw, COLONY_SIZE_FLOOR);
  const denom = mouths * FOOD_PER_ANT_BASELINE;
  const food10 = foodTotal * 10; // multiply once; no division, no | 0 truncation
  if (food10 >= 100 * denom) return QUEEN_EGG_INTERVAL_FLOOR_TICKS;
  if (food10 >= 50 * denom) return QUEEN_EGG_INTERVAL_FAST_TICKS;
  if (food10 >= 30 * denom) return QUEEN_EGG_INTERVAL_MEDIUM_TICKS;
  return QUEEN_EGG_INTERVAL_BASE_TICKS;
}

/**
 * #395 (V70) — the egg reserve (fp): the stored food `colony` must hold for its queen
 * to lay. It is every meal the whole colony would eat over
 * QUEEN_EGG_RESERVE_RUNWAY_TICKS with no food coming in, by each kind's hunger
 * profile (hunger.ts runwayFoodFp):
 *   - the queen (QUEEN_HUNGER);
 *   - each larva, each egg, and the egg about to be laid (LARVA_HUNGER). An egg does
 *     not eat, but it becomes a larva that does. Counting it now is what stops a run
 *     of eggs from being laid against food their larvae will need;
 *   - each living worker by its profile now (workerHungerProfile: FIGHTER_HUNGER
 *     while Fighting). Fighters, nurses, foragers and diggers are all in
 *     colony.workers.
 * Every mouth counts as eating from the stores for the whole runway. That is the
 * worst case: a larva that matures, or a forager that eats its own load, only lowers
 * the real draw. Read from world state only: the brood counts (death cleanup has
 * already run this tick), the worker roster and its tasks. The caller compares it
 * with colonyFoodTotal: the stores meals are drawn from, the entrance pool and every
 * FoodStorage chamber however many (a worker's carried load is not counted, the
 * conservative side). Integer-only; no allocation; O(workers).
 */
export function eggReserveFp(world: WorldState, colony: ColonyRecord): number {
  const runway = QUEEN_EGG_RESERVE_RUNWAY_TICKS;
  const ants = world.ants;
  const brood = colony.larvaeCount + colony.eggCount + 1; // + the egg about to be laid
  let need = runwayFoodFp(QUEEN_HUNGER, runway) + brood * runwayFoodFp(LARVA_HUNGER, runway);
  // The two worker profiles' runways once per call, not once per worker.
  // workerHungerProfile returns one of these two (egg-reserve.test.ts pins that for
  // every task, so a third profile has to be added here too).
  const workerFp = runwayFoodFp(WORKER_HUNGER, runway);
  const fighterFp = runwayFoodFp(FIGHTER_HUNGER, runway);
  const roster = colony.workers;
  for (let i = 0; i < roster.length; i++) {
    const id = roster[i]!;
    if (ants.alive[id] !== 1) continue;
    need += workerHungerProfile(world, id) === FIGHTER_HUNGER ? fighterFp : workerFp;
  }
  return need;
}

/**
 * #395 (V70) — how far (fp) `colony`'s storage capacity falls short of the egg
 * reserve its queen would need with no brood waiting: the queen, the new egg's larva
 * and every living worker (eggReserveFp less the brood already laid). While this is
 * above 0 no larder can cover the reserve, however full, so she cannot lay until the
 * colony builds storage (colonyFoodCapacity: the entrance pool's cap plus every
 * COMPLETED FoodStorage chamber's) or loses workers. That is the case with only the
 * entrance pool (2048 fp against at least 3600), or with a colony grown past its
 * chambers. Held back only by the brood she has already laid (the larder's brood
 * ceiling) she lays again as it matures; that is not counted here. 0 when storage
 * covers it, and always 0 before V70. Read-only, for the render-side storage hint
 * (any colony, CLNY-08). Integer-only; O(workers).
 */
export function eggReserveStorageShortfallFp(world: WorldState, colony: ColonyRecord): number {
  if (world.simVersion < SIM_VERSION_V70_EGG_RESERVE) return 0;
  const laidBrood = colony.larvaeCount + colony.eggCount;
  const noBroodReserve =
    eggReserveFp(world, colony) -
    laidBrood * runwayFoodFp(LARVA_HUNGER, QUEEN_EGG_RESERVE_RUNWAY_TICKS);
  const shortfall = noBroodReserve - colonyFoodCapacity(colony);
  return shortfall > 0 ? shortfall : 0;
}

export function tickQueenEggProduction(world: WorldState, colony: ColonyRecord): void {
  // Gate 1: tick-modulo interval (surplus-scaled).
  let eggInterval = eggIntervalForColony(world, colony);
  if (eggInterval < 0) return; // QUEEN_EGG_INTERVAL_DISABLED sentinel
  // Apply per-colony brood-interval numerator (set in createScenario from difficulty tier).
  // Integer-only: (interval * numerator) >> 2; numerator=4 is identity. Hard floor: MIN_EGG_INTERVAL_TICKS.
  eggInterval = (eggInterval * colony.eggIntervalNumerator) >> 2;
  if (eggInterval < MIN_EGG_INTERVAL_TICKS) eggInterval = MIN_EGG_INTERVAL_TICKS;
  // Elapsed-since-last-lay prevents spurious double-lays when the surplus
  // tier changes mid-cycle.
  if (world.tick - colony.queenLastEggTick < eggInterval) return;

  // Gate 2: food threshold — issue #15: read the TOTAL stockpile (entrance pool +
  // every FoodStorage chamber's stock). The entrance pool alone would miss a
  // colony whose entire stash lives in chambers, which would then never lay.
  // Before V70 only: from V70 (#395) Gate 7, the egg reserve, replaces it.
  const reserveRule = world.simVersion >= SIM_VERSION_V70_EGG_RESERVE;
  if (!reserveRule && colonyFoodTotal(world, colony) < QUEEN_EGG_FOOD_THRESHOLD) return;

  // Gate 3: queen alive
  if (world.ants.alive[colony.queenEntityId] !== 1) return;

  // Gate 4/5 (09 reproduction-gate memo): require completed Queen + Nursery
  // chambers before the queen starts laying. Either missing → no eggs.
  if (!hasCompletedChamber(colony, ChamberType.Queen)) return;
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
      queenTileX >= bx &&
      queenTileX < bx + ch.width &&
      queenTileY >= by &&
      queenTileY < by + ch.height
    ) {
      queenHome = true;
      break;
    }
  }
  if (!queenHome) return;

  // Gate 7 (V70, #395): the egg reserve. The stores (the same total stockpile as
  // Gate 2) must feed the whole colony, the new egg's larva included, for
  // QUEEN_EGG_RESERVE_RUNWAY_TICKS.
  if (reserveRule && colonyFoodTotal(world, colony) < eggReserveFp(world, colony)) return;

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
  //
  // Issue #59 — bail on -1 sentinel. allocateEntityId returns
  // INVALID_ENTITY_ID when world.nextEntityId reaches MAX_ENTITIES;
  // egg-laying is the sim's biggest allocator (food and corpse piles,
  // chambers and entrances take IDs too), so this is where the population
  // cap manifests. Skipping the lay leaves the queen ready to retry next
  // tick (food / queen-home gates re-fire each tick anyway), but entity IDs
  // are never recycled (#233), so once the cap is reached no colony lays
  // again for the rest of the match. From V67 (#376, no match timeout) a
  // long enough match can reach it.
  const eggId = allocateEntityId(world);
  if (eggId === INVALID_ENTITY_ID) return;

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
    posX: eggPosX,
    posY: eggPosY,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0, // eggs don't move
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Underground, // Gate 6 guarantees queen is Underground
    lastMealTick: world.tick, // eggs do not eat; hatching resets the clock
    // #400 (V71): laid in its own nest, so at its home-ground max HP (health.ts).
    hp: COMBAT_HP_BASE + COMBAT_HP_HOMEGROUND_BONUS,
  });

  colony.eggs.push(eggId);
  colony.eggCount += 1;
  colony.broodFieldDirty = true; // #235 — new reclaimable brood seed for the pickup/deposit fields
  colony.queenLastEggTick = world.tick; // update after lay so next interval is measured from here
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
  const eggSnapLen = colony.eggs.length;
  const larvaeSnapLen = colony.larvae.length;
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
      ants.age[id] = 0; // reset age for larva phase
      // #288 (V50): the larva's hunger clock starts now. Hatching runs after this
      // tick's consumption step, so its first meal is next tick — one tick after
      // this "meal", as the pre-V50 countdown's full STARVATION_GRACE_TICKS start.
      ants.lastMealTick[id] = world.tick;
      colony.larvae.push(id);
      colony.larvaeCount += 1;
      // #235 — the brood stays on the same tile, but the swap-remove from eggs[]
      // and append to larvae[] REORDER the pickup/deposit BFS seed enumeration
      // (eggs-then-larvae, array order; the flow-field BFS is first-claim-wins on
      // equidistant tiles), so an equidistant tile's step direction can flip. NOT
      // output-inert — the field must rebuild.
      colony.broodFieldDirty = true;
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
      ants.age[id] = 0; // reset age for worker phase
      ants.lastMealTick[id] = world.tick; // #288 — a new worker starts fed
      ants.task[id] = AntTask.Idle;
      ants.speed[id] = WORKER_BASE_SPEED;
      colony.workers.push(id);
      colony.workerCount += 1;
      colony.broodFieldDirty = true; // #235 — brood left the reclaimable set (larva→worker)
      // Issue #17 Phase 1 — if a nurse was carrying this larva when
      // it matured, drop the carry. The new worker stays at the carrier's
      // current tile (posX/posY were synced last tick); the carrier
      // returns to Idle so step 10a re-allocates per ratio.
      {
        const carrierId = ants.carriedBy[id]!;
        if (carrierId !== -1) {
          // Carrier-side cleanup is gated on the carrier still being alive
          // AND still carrying THIS entity — guards against state desync
          // (e.g. carrier already started carrying a different brood).
          if (ants.alive[carrierId] === 1 && ants.carryingBroodId[carrierId] === id) {
            ants.carryingBroodId[carrierId] = -1;
            ants.task[carrierId] = AntTask.Idle;
            ants.subTask[carrierId] = 0;
          }
          // Always clear the matured worker's `carriedBy` so the new
          // worker is not flagged as carried, regardless of carrier-side
          // state. The new worker is now in colony.workers (no longer
          // brood) and will not be referenced by carry-aware code.
          ants.carriedBy[id] = -1;
        }
      }
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
      // #235 broodFieldDirty is set inside (a dying worker could be carrying brood).
      despawnAnt(world, id, { cause: 'lifespan' });
      // Note: dead workers are removed on the NEXT tick's backwards iteration pass
      // (the worker remains in colony.workers until then — Plan 09 death cleanup
      // will handle immediate removal once implemented)
    }
  }
}
