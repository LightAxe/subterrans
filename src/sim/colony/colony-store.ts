// colony-store.ts — PRD §2 ColonyRecord schema and factories
//
// Canonical per-colony record shape: every downstream system (reconcile, lifecycle,
// food economy, HUD) reads and writes fields defined here.
//
// Data-only module: no tick logic, no mutation helpers, no lifecycle transitions.
// Reconcile pass lives in Plan 09; lifecycle transitions in Plan 08.
//
// ADR-0006: plain object invariant — no Map/Set anywhere.
// Node --experimental-strip-types compatible: no const enum.

import type { EntityId } from '../types.js';
import type { ChamberType } from '../enums.js';
import type { FoodPileId } from '../food.js';
import type { NestEntrance } from './entrance.js';
import {
  DEFAULT_BEHAVIOR_RATIO,
  STARVATION_GRACE_TICKS,
  RECONCILE_INTERVAL_TICKS,
  QUEEN_EGG_INTERVAL_BASE_TICKS,
} from '../constants.js';

// ---------------------------------------------------------------------------
// ColonyId — controller-agnostic integer alias (PRD §2 line 234)
// Never branched on; purely a readability tag on numeric IDs.
// ---------------------------------------------------------------------------

export type ColonyId = number;

// ---------------------------------------------------------------------------
// WorkerAllocation — per-task worker counts (PRD §2)
//
// Used for both computedAllocation (target per-task counts, derived by
// the reconcile pass from targetRatio × workerCount) and taskCensus
// (actual per-task counts written at the end of PRD §8a step 9).
//
// 4 fields exactly: nurse, forage, dig, fight.
// There is no idle-count field — PRD §8a step 9 reassigns every surviving
// idle worker into one of these 4 target tasks before writing taskCensus;
// idle is a transient step-9-internal state, never a cached colony-level count.
// ---------------------------------------------------------------------------

export interface WorkerAllocation {
  nurse: number;
  forage: number;
  dig: number;
  fight: number;
}

// ---------------------------------------------------------------------------
// BehaviorRatio — player-controlled task distribution control (PRD §2 + Phase 10 amendment per CTRL-01')
//
// Two roles: forage and fight. Digging is auto-assigned per CLNY-09-style
// demand — see CTRL-06 and `tick.ts` step 10a (auto-dig path landed in
// Plan 02). Values are integer percentages on a 0–10 scale (10 = 100%).
// The nurse task is computed from workerCount and is not directly
// player-controlled.
// ---------------------------------------------------------------------------

export interface BehaviorRatio {
  forage: number;
  fight: number;
}

// ---------------------------------------------------------------------------
// ChamberRecord — single underground chamber (PRD §2)
//
// All fields are integers (no floats — fixed-point architecture principle).
// chamberType is a ChamberType object-const value (0 | 1 | 2).
// ---------------------------------------------------------------------------

export interface ChamberRecord {
  chamberId: EntityId;
  chamberType: ChamberType;
  foodStored: number;
  posX: number;
  posY: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// ColonyRecord — canonical per-colony state (PRD §2 + accepted Phase 3 PRD §2 extensions)
//
// 17 Phase 2 fields + 3 Phase 3 extension fields (entrances, rallyPoint, digFlowFieldDirty).
// Field inventory:
//   colonyId, queenEntityId, queenStarvationTimer, foodStored,
//   workerCount, eggCount, larvaeCount, nurseCount,
//   eggs, larvae, workers, chambers,
//   targetRatio, computedAllocation, taskCensus,
//   defeated, reconcileCountdown,
//   entrances, rallyPoint, digFlowFieldDirty      // Phase 3 PRD — caller-side init
//
// Per accepted Phase 3 PRD §2a extension contract, createColonyRecord below
// returns the Phase 2 17-field shape; the caller MUST assign the 3 Phase 3
// defaults immediately after the factory call.
// ---------------------------------------------------------------------------

export interface ColonyRecord {
  colonyId: ColonyId;
  queenEntityId: EntityId;
  queenStarvationTimer: number;
  foodStored: number;
  workerCount: number;
  eggCount: number;
  larvaeCount: number;
  nurseCount: number;
  eggs: EntityId[];
  larvae: EntityId[];
  workers: EntityId[];
  chambers: ChamberRecord[];
  targetRatio: BehaviorRatio;
  computedAllocation: WorkerAllocation;
  /**
   * Per-task worker counts written at the end of PRD §8a step 9 (Plan 10). Invariants:
   *   (1) Every field is non-negative: `taskCensus.{nurse,forage,dig,fight} >= 0`.
   *   (2) Sum is bounded by workerCount: `nurse + forage + dig + fight === workerCount - (ants whose task is AntTask.Idle post-step-9)`. In Phase 6 steady state step 9 reassigns every idle-checkpoint ant, so the sum equals `workerCount` once all eligible idle ants have been rehomed.
   * Step 9 writes this field after reconciling actual-per-task counters against `computedAllocation`; see Plan 10 Test 14b for the regression guard.
   */
  taskCensus: WorkerAllocation;
  defeated: boolean;
  reconcileCountdown: number;

  /** Phase 3 PRD §2 — nest entrances (max MAX_ENTRANCES_PER_COLONY = 4). Assigned caller-side (PRD §2a extension contract); the Phase 2 factory body does not initialize this field. */
  entrances: NestEntrance[];

  /** Phase 3 PRD §2 — current active fight rally point in tile coords, null if unset. Read by Phase 9 fight behavior; Phase 7 does not mutate but must round-trip through copyWorldState. Assigned caller-side per PRD §2a extension contract. */
  rallyPoint: { tileX: number; tileY: number } | null;

  /** Phase 3 PRD §2 — set true when any tile passability in this colony's underground changes (per research Pitfall 3). Cleared by tick.ts step 9 after flow-field recomputation. Assigned caller-side per PRD §2a extension contract. */
  digFlowFieldDirty: boolean;

  /** Issue #15 — set true when a FoodStorage chamber crosses the full↔not-full
   *  boundary, so step 9 re-seeds the food chamber flow-field excluding any
   *  newly-full chambers. Independent from `digFlowFieldDirty` because food
   *  fill changes don't affect tile topology — only the food field's seed set.
   *  Cleared by tick.ts step 9 after recompute. Initialized to false. */
  foodFlowFieldDirty: boolean;

  /** #235 — set true when any INPUT to the nursing-pickup / V24 nursery-deposit
   *  fields changes, so tick.ts step-9's second loop can gate those every-tick
   *  O(grid) BFS rebuilds instead of running them unconditionally. Cleared by that
   *  loop after recompute; also forced true by the step-9 FIRST loop whenever it
   *  recomputes (topology change / first-compute-on-load), which is what makes a
   *  loaded world recompute on tick 1 regardless of the deserialized value.
   *  Assigned caller-side (factory does not init), like digFlowFieldDirty.
   *
   *  Trigger sites (every real input-change to those fields MUST set this true):
   *    - lifecycle-system.ts   egg lay (new reclaimable seed)
   *    - lifecycle-system.ts   egg→larva hatch (swap-remove + push REORDERS the
   *                            eggs-then-larvae BFS seed enumeration; the flow BFS
   *                            is first-claim-wins on equidistant tiles, so a tie
   *                            tile's direction can flip — NOT output-inert)
   *    - lifecycle-system.ts   larva→worker promotion (brood leaves the set)
   *    - lifecycle-system.ts   worker lifespan death (defensive: carried-brood orphan)
   *    - larva-maturation.ts   larva→worker promotion (2nd promotion site)
   *    - colony-system.ts      larva starvation death
   *    - colony-system.ts      checkPendingChambers chamber promotion (a new Nursery
   *                            joins the seed/exclusion set; needed for the all-Open
   *                            PlaceChamber path where no tile-flip dirties step 9)
   *    - ant-nursing.ts        nurse pickup (carriedBy set) + depositCarriedBrood
   *    - combat.ts killAnt     brood death AND carrier-death orphan
   *  NOT triggers (output-identical): carried-brood per-tick position sync (carried
   *  brood is excluded by isBroodReclaimable); tickDeathCleanup swap-remove of an
   *  already-dead brood (the death that set alive=0 already flagged, and the removal
   *  happens after that tick's step 9). */
  broodFieldDirty: boolean;

  /** Phase 9 / CMBT-06/07 / PRD §1a — cumulative count of enemies killed by this colony's ants.
   *  Incremented inside combat.killAnt (Plan 02) when ants from this colony win a combat round.
   *  Initialized to 0 in createColonyRecord. Round-trips through copyWorldState + save. */
  killCount: number;

  /** Phase 9 / PRD §3d — exclusive per-colony priority food target.
   *  Single FoodPileId the player has selected as "send my foragers here first", or null
   *  when no pile is prioritized. Replaces the previous shared FoodPile.isMarkedPriority
   *  flag so (a) enemy colonies no longer read the player's mark and (b) selecting a new
   *  pile is an exclusive redirect, not an additive toggle of the shared flag.
   *  Read by routeForagerPriority; mutated by the MarkFoodPile command handler.
   *  Initialized to null in createColonyRecord. Round-trips through copyWorldState + save. */
  priorityFoodPileId: FoodPileId | null;

  /** S4 V21+ — world tick at which the queen most recently laid an egg.
   *  Used by tickQueenEggProduction to enforce the selected interval as elapsed
   *  ticks since the last lay, not a global modulo (which misfires when the
   *  surplus tier changes mid-cycle). Initialized to -QUEEN_EGG_INTERVAL_BASE_TICKS
   *  so the queen can lay on tick 0 (0 - (-300) = 300 ≥ 300). Round-trips
   *  through copyWorldState + save. */
  queenLastEggTick: number;

  /** S5 V22 — brood-interval difficulty multiplier numerator (denominator is always 4).
   *  Applied as `(eggInterval * eggIntervalNumerator) >> 2` in tickQueenEggProduction.
   *  Player colony always uses 4 (identity). AI colony numerator set from
   *  QUEEN_EGG_INTERVAL_DIFFICULTY_NUMERATOR[tier] in createScenario: Easy=5(+25%),
   *  Normal=4(×1), Hard=3(−25%). Defaults to 4 so pre-V22 saves are unaffected. */
  eggIntervalNumerator: number;
}

// ---------------------------------------------------------------------------
// createColonyRecord — factory producing a fresh ColonyRecord (PRD §2 line 455)
//
// IMPORTANT: per accepted Phase 3 PRD §2a, this factory DOES NOT initialize
// the Phase 3 extension fields (entrances, rallyPoint, digFlowFieldDirty),
// nor the issue-#15 extension `foodFlowFieldDirty`. Callers MUST assign all
// four fields immediately after the factory call:
//   const colony = createColonyRecord(colonyId, queenEntityId);
//   colony.entrances         = [];
//   colony.rallyPoint        = null;
//   colony.digFlowFieldDirty  = false;
//   colony.foodFlowFieldDirty = false;
//   colony.broodFieldDirty    = false;  // #235
// Callers: createScenario (Plan 07), copyWorldState new-colony fallback (Plan 03 Task 2),
// deserializeColony (save.ts — defaults `foodFlowFieldDirty`/`broodFieldDirty` to false on old saves).
//
// Default values (Phase 2 fields):
//   - foodStored=0, workerCount=0, eggCount=0, larvaeCount=0, nurseCount=0
//   - eggs/larvae/workers/chambers: empty arrays (fresh per call)
//   - targetRatio: spread of DEFAULT_BEHAVIOR_RATIO (independent object per colony)
//   - computedAllocation: {nurse:0, forage:0, dig:0, fight:0} (fresh object)
//   - taskCensus:         {nurse:0, forage:0, dig:0, fight:0} (fresh object)
//   - defeated: false
//   - queenStarvationTimer: STARVATION_GRACE_TICKS (100)
//   - reconcileCountdown:   RECONCILE_INTERVAL_TICKS (100)
//
// Each call returns independent objects — mutations on one colony do not
// leak to another through shared references.
// ---------------------------------------------------------------------------

export function createColonyRecord(colonyId: ColonyId, queenEntityId: EntityId): ColonyRecord {
  // Phase 2 factory body — unchanged. Per accepted Phase 3 PRD §2a, this factory
  // intentionally does NOT initialize entrances / rallyPoint / digFlowFieldDirty.
  // Callers MUST assign those three fields immediately after this factory call
  // (see createScenario in Plan 07, and the new-colony fallback in copyWorldState
  // in Task 2 below). The `as unknown as ColonyRecord` assertion reflects that the
  // object is complete only after the caller assigns the Phase 3 defaults.
  return {
    colonyId,
    queenEntityId,
    queenStarvationTimer: STARVATION_GRACE_TICKS,
    foodStored: 0,
    workerCount: 0,
    eggCount: 0,
    larvaeCount: 0,
    nurseCount: 0,
    eggs: [],
    larvae: [],
    workers: [],
    chambers: [],
    targetRatio: { ...DEFAULT_BEHAVIOR_RATIO },
    computedAllocation: { nurse: 0, forage: 0, dig: 0, fight: 0 },
    taskCensus: { nurse: 0, forage: 0, dig: 0, fight: 0 },
    defeated: false,
    reconcileCountdown: RECONCILE_INTERVAL_TICKS,
    killCount: 0,
    priorityFoodPileId: null,
    queenLastEggTick: -QUEEN_EGG_INTERVAL_BASE_TICKS,
    eggIntervalNumerator: 4, // Normal = identity (set per-colony in createScenario for difficulty tiers)
  } as unknown as ColonyRecord;
}

// ---------------------------------------------------------------------------
// createColonyStore — produce an empty colony registry (ADR-0006)
//
// Returns a plain object (Record<ColonyId, ColonyRecord>) — JSON-serializable,
// never a Map. Assign colony records by integer key: store[colonyId] = record.
// ---------------------------------------------------------------------------

export function createColonyStore(): Record<ColonyId, ColonyRecord> {
  return {};
}
