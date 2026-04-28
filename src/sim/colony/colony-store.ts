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
  nurse:  number;
  forage: number;
  dig:    number;
  fight:  number;
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
  fight:  number;
}

// ---------------------------------------------------------------------------
// ChamberRecord — single underground chamber (PRD §2)
//
// All fields are integers (no floats — fixed-point architecture principle).
// chamberType is a ChamberType object-const value (0 | 1 | 2).
// ---------------------------------------------------------------------------

export interface ChamberRecord {
  chamberId:   EntityId;
  chamberType: ChamberType;
  foodStored:  number;
  posX:        number;
  posY:        number;
  width:       number;
  height:      number;
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
  colonyId:              ColonyId;
  queenEntityId:         EntityId;
  queenStarvationTimer:  number;
  foodStored:            number;
  workerCount:           number;
  eggCount:              number;
  larvaeCount:           number;
  nurseCount:            number;
  eggs:                  EntityId[];
  larvae:                EntityId[];
  workers:               EntityId[];
  chambers:              ChamberRecord[];
  targetRatio:           BehaviorRatio;
  computedAllocation:    WorkerAllocation;
  /**
   * Per-task worker counts written at the end of PRD §8a step 9 (Plan 10). Invariants:
   *   (1) Every field is non-negative: `taskCensus.{nurse,forage,dig,fight} >= 0`.
   *   (2) Sum is bounded by workerCount: `nurse + forage + dig + fight === workerCount - (ants whose task is AntTask.Idle post-step-9)`. In Phase 6 steady state step 9 reassigns every idle-checkpoint ant, so the sum equals `workerCount` once all eligible idle ants have been rehomed.
   * Step 9 writes this field after reconciling actual-per-task counters against `computedAllocation`; see Plan 10 Test 14b for the regression guard.
   */
  taskCensus:            WorkerAllocation;
  defeated:              boolean;
  reconcileCountdown:    number;

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
// Callers: createScenario (Plan 07), copyWorldState new-colony fallback (Plan 03 Task 2),
// deserializeColony (save.ts — defaults `foodFlowFieldDirty` to false on pre-#15 saves).
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
  return ({
    colonyId,
    queenEntityId,
    queenStarvationTimer:  STARVATION_GRACE_TICKS,
    foodStored:            0,
    workerCount:           0,
    eggCount:              0,
    larvaeCount:           0,
    nurseCount:            0,
    eggs:                  [],
    larvae:                [],
    workers:               [],
    chambers:              [],
    targetRatio:           { ...DEFAULT_BEHAVIOR_RATIO },
    computedAllocation:    { nurse: 0, forage: 0, dig: 0, fight: 0 },
    taskCensus:            { nurse: 0, forage: 0, dig: 0, fight: 0 },
    defeated:              false,
    reconcileCountdown:    RECONCILE_INTERVAL_TICKS,
    killCount:             0,
    priorityFoodPileId:    null,
  }) as unknown as ColonyRecord;
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
