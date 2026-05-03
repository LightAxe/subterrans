// chamber-flow.ts — multi-source BFS flow-field toward chamber Open tiles.
//
// Analogue of src/sim/entrance-flow.ts, but seeded from every Open tile
// inside a chamber footprint instead of from entrance shaft tops. Maintains
// four per-colony flow-fields:
//   - food         : seeded from Open tiles inside FoodStorage chambers.
//                    Consumed by Underground carrying foragers routing to deposit.
//   - nursing      : pre-v10: seeded from Open tiles inside Queen OR Nursery
//                    chambers. v10+: re-seeded from Queen Open tiles AND any
//                    uncarried-brood-entity tile outside Nursery (the
//                    "pickup" field; tickNurseActions handles the v10
//                    re-seed via the same compute function).
//                    Consumed by Nursing ants routing to brood pickup.
//   - queen        : seeded from Open tiles inside Queen chambers only.
//                    Consumed by the queen entity when routing from her current
//                    underground tile to the Queen chamber footprint (PRD §4b —
//                    queen relocates once a Queen chamber is completed).
//   - nurseDeposit : seeded from Open tiles inside Nursery chambers only.
//                    Consumed by v10+ nurses currently carrying a brood
//                    (subTask=Feeding under simVersion >= 10) routing to
//                    deposit. Issue #17 Phase 1.
//
// Why a dedicated field per target class rather than one shared field:
// each consumer targets a different set of chamber types. Sharing a single
// field would either over-seed (routing nurses to FoodStorage) or require
// per-tile chamber-type filtering at read time.
//
// Why is this needed: seed-920076605 tick-2588 debug snapshot showed ants
// 17/18 (carrying foragers underground, target FoodStorage near 18,17) and
// ant 19 (nurse underground, target Nursery near 13,9) frozen because
// straight-line chamber steering picked a Solid neighbour tile every tick.
// See entrance-flow.ts for the equivalent fix on the exit-to-surface path.
//
// DO NOT import Phaser, DOM, or any non-sim module.
// DO NOT use Math.random(), Date, performance.now(), or floating-point math.

import { ChamberType } from './enums.js';
import type { ColonyId, ChamberRecord } from './colony/colony-store.js';
import { UndergroundTileState } from './terrain.js';
import type { UndergroundGrid } from './terrain.js';
import { FP_SHIFT } from './fixed.js';
import type { AntComponents } from './ant/ant-store.js';
import { isBroodReclaimable } from './ant/ant-store.js';

// Direction constants — identical encoding to entrance-flow.ts / dig-system.ts.
//   0=N, 1=E, 2=S, 3=W, -1=source, -2=unreachable.
const REVERSE = [2, 3, 0, 1] as const;
const NEIGHBOR_DR = [-1, 0, 1, 0] as const;
const NEIGHBOR_DC = [0, 1, 0, -1] as const;

/**
 * Per-colony flow-field cache for chamber-targeted routing.
 *
 * `food`, `nursing`, `queen`, and `nurseDeposit` are parallel Int32Arrays of
 * length W*H indexed by tileY * width + tileX. `queues` is a single BFS
 * scratch queue per colony reused across the compute calls (BFS is
 * sequential, never concurrent).
 */
export interface ChamberFlowFields {
  food: Record<ColonyId, Int32Array>;
  nursing: Record<ColonyId, Int32Array>;
  queen: Record<ColonyId, Int32Array>;
  /** Issue #17 Phase 1 — Nursery-only deposit field for v10 carrying nurses. */
  nurseDeposit: Record<ColonyId, Int32Array>;
  queues: Record<ColonyId, Int32Array>;
}

export function createChamberFlowFields(): ChamberFlowFields {
  return { food: {}, nursing: {}, queen: {}, nurseDeposit: {}, queues: {} };
}

/**
 * Ensure all flow-field buffers plus the shared BFS queue are allocated
 * for the colony. Lazy allocation — first call sizes to gridSize, later
 * calls are no-ops if present.
 *
 * @returns all flow-field arrays so callers can immediately compute + read.
 */
export function ensureChamberFlowFields(
  cache: ChamberFlowFields,
  colonyId: ColonyId,
  gridSize: number,
): { food: Int32Array; nursing: Int32Array; queen: Int32Array; nurseDeposit: Int32Array; queue: Int32Array } {
  if (!(colonyId in cache.food))         cache.food[colonyId]         = new Int32Array(gridSize);
  if (!(colonyId in cache.nursing))      cache.nursing[colonyId]      = new Int32Array(gridSize);
  if (!(colonyId in cache.queen))        cache.queen[colonyId]        = new Int32Array(gridSize);
  if (!(colonyId in cache.nurseDeposit)) cache.nurseDeposit[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.queues))       cache.queues[colonyId]       = new Int32Array(gridSize);
  return {
    food:         cache.food[colonyId]!,
    nursing:      cache.nursing[colonyId]!,
    queen:        cache.queen[colonyId]!,
    nurseDeposit: cache.nurseDeposit[colonyId]!,
    queue:        cache.queues[colonyId]!,
  };
}

/**
 * Shared BFS expansion for chamber-style flow-fields. Caller seeds `out`
 * with -1 at every source tile (and fills the rest with -2 first), pushes
 * each source's flat index into `queue`, and passes the resulting tail
 * pointer. This function expands outward through Open and BeingDug tiles,
 * writing the step direction (0=N, 1=E, 2=S, 3=W) to `out[idx]` for each
 * reached tile.
 *
 * Single-sourced so the integer-division `(idx / width) | 0` BFS row
 * extraction lives in ONE place — extracted from the previously
 * duplicated implementations in `computeChamberFlowField` and
 * `computeNursingPickupField` (PR #56 codex P2).
 */
function bfsExpandSeededField(
  out:        Int32Array,
  queue:      Int32Array,
  initialTail: number,
  data:       Uint8Array,
  width:      number,
  height:     number,
): void {
  let head = 0;
  let tail = initialTail;
  while (head < tail) {
    const idx = queue[head++]!;
    // eslint-disable-next-line no-restricted-syntax -- integer division via `| 0`; BFS index→row conversion, not fixed-point math
    const row = (idx / width) | 0;
    const col = idx % width;

    for (let d = 0; d < 4; d++) {
      const nRow = row + NEIGHBOR_DR[d]!;
      const nCol = col + NEIGHBOR_DC[d]!;
      if (nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) continue;

      const nIdx = nRow * width + nCol;
      if (out[nIdx] !== -2) continue;

      const tileState = data[nIdx]!;
      if (
        tileState !== UndergroundTileState.Open &&
        tileState !== UndergroundTileState.BeingDug
      ) {
        continue;
      }

      out[nIdx] = REVERSE[d]!;
      queue[tail++] = nIdx;
    }
  }
}

/**
 * Multi-source BFS from every Open tile inside any chamber whose type is
 * present in `chamberTypes` AND (optionally) passes `chamberFilter`.
 * Expands through Open and BeingDug tiles. Marked and Solid are walls
 * (same contract as entrance-flow.ts — a non-digger can't traverse Marked).
 *
 * Output at each reachable tile is the direction an ant should step to head
 * one tile closer to the nearest seeded chamber tile. Reachable chamber
 * tiles themselves receive -1 (source); unreachable tiles keep -2.
 *
 * Deterministic: seed order is chamber array order × row-major footprint
 * iteration; BFS expansion order is N/E/S/W.
 *
 * @param underground    Colony underground grid (read-only).
 * @param chambers       Colony chambers array (completed chambers only).
 * @param chamberTypes   Types to seed from (e.g. [FoodStorage] or [Queen, Nursery]).
 * @param out            Pre-allocated Int32Array of length W*H. Filled in-place.
 * @param queue          Pre-allocated Int32Array of length W*H for BFS queue.
 * @param chamberFilter  Optional per-chamber predicate (issue #15) — only
 *                       chambers returning true are seeded. Used by the food
 *                       field to exclude FoodStorage chambers at capacity so
 *                       carriers redirect to non-full chambers.
 */
export function computeChamberFlowField(
  underground: UndergroundGrid,
  chambers: ReadonlyArray<ChamberRecord>,
  chamberTypes: ReadonlyArray<ChamberType>,
  out: Int32Array,
  queue: Int32Array,
  chamberFilter?: (chamber: ChamberRecord) => boolean,
): void {
  const { data, width, height } = underground;

  out.fill(-2);

  let tail = 0;

  // Seed every Open tile inside any matching chamber footprint.
  for (let c = 0; c < chambers.length; c++) {
    const chamber = chambers[c]!;
    let matches = false;
    for (let t = 0; t < chamberTypes.length; t++) {
      if (chamber.chamberType === chamberTypes[t]!) { matches = true; break; }
    }
    if (!matches) continue;
    if (chamberFilter !== undefined && !chamberFilter(chamber)) continue;

    const baseX = chamber.posX >> FP_SHIFT;
    const baseY = chamber.posY >> FP_SHIFT;
    for (let ty = 0; ty < chamber.height; ty++) {
      for (let tx = 0; tx < chamber.width; tx++) {
        const cx = baseX + tx;
        const cy = baseY + ty;
        if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
        const idx = cy * width + cx;
        if (data[idx] !== UndergroundTileState.Open) continue;
        if (out[idx] !== -2) continue;
        out[idx] = -1;
        queue[tail++] = idx;
      }
    }
  }

  bfsExpandSeededField(out, queue, tail, data, width, height);
}

/** Chamber type lists exported so callers don't hard-code the arrays. */
export const FOOD_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.FoodStorage];
export const NURSING_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [
  ChamberType.Queen,
  ChamberType.Nursery,
];
export const QUEEN_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.Queen];
/** Issue #17 Phase 1 — Nursery-only seeds for the v10 nurseDeposit field. */
export const NURSERY_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.Nursery];

/**
 * Issue #17 Phase 1 — multi-source BFS toward brood pickup tiles for v10+
 * Nursing ants in the MovingToBrood substate.
 *
 * Seeded from every alive uncarried brood entity (egg or larva) tile
 * that is NOT inside any Nursery footprint. Brood inside the Queen
 * chamber, brood orphaned at a tunnel tile after a carrier death, and
 * any other uncarried brood outside a Nursery are all included.
 *
 * Brood already inside a Nursery is excluded — it has reached its
 * destination and shouldn't lure pickups. Carried brood (carriedBy >= 0
 * with an alive carrier) is excluded — a second nurse must not race onto
 * an already-claimed brood (race resolution lives in tickNurseActions;
 * this just keeps the field from advertising a stale pickup target).
 *
 * Output is a step-direction grid identical to computeChamberFlowField
 * (-1 = source, -2 = unreachable, 0..3 = step N/E/S/W).
 *
 * Deterministic: brood seed order is eggIds first then larvaeIds, each
 * in array order. Duplicate sources are idempotent (the `out[idx] !== -2`
 * guard skips re-seeding).
 *
 * @param underground Colony underground grid (read-only).
 * @param chambers    Colony chambers (used to exclude brood already
 *                    deposited inside a Nursery footprint).
 * @param ants        The world.ants AntComponents struct (reads
 *                    posX/posY/alive/carriedBy via isBroodReclaimable).
 * @param eggIds      colony.eggs for the colony being computed.
 * @param larvaeIds   colony.larvae for the colony being computed.
 * @param out         Pre-allocated Int32Array of length W*H. Filled in-place.
 * @param queue       Pre-allocated Int32Array of length W*H for BFS queue.
 */
export function computeNursingPickupField(
  underground: UndergroundGrid,
  chambers: ReadonlyArray<ChamberRecord>,
  ants:      AntComponents,
  eggIds:    ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  out:       Int32Array,
  queue:     Int32Array,
): void {
  const { data, width, height } = underground;

  out.fill(-2);

  let tail = 0;

  // Seed: uncarried brood entities outside Nursery, on Open tiles.
  //
  // Earlier this function ALSO seeded every Queen-chamber Open tile
  // (the now-removed "Seed (1)"). That over-seeded — a Queen chamber is
  // typically 5×3 with at most a handful of eggs at any time, so most
  // Queen tiles have no brood. The BFS routed nurses to the geographically
  // nearest Queen tile, which often was NOT one of the egg-bearing tiles.
  // When the nurse arrived at a non-egg Queen tile, the pickup gate found
  // no brood there and the finite-nursing release fired — the nurse was
  // sent back to Idle without ever reaching an egg. Brood-tile-only
  // seeding routes nurses directly to the egg tile via BFS, so the
  // first-arrival pickup gate succeeds.
  // Brood inside Nursery doesn't seed (already deposited); carried brood
  // doesn't seed (a second nurse mustn't race onto it). Dead-carrier
  // exception: if `carriedBy[bid]` points to an ant whose `alive` is 0,
  // the brood is effectively orphaned (carrier died mid-carry) and is
  // reclaimable — seed it as uncarried. tickNurseActions Feeding branch
  // also drops dead-brood carries on the carrier side.
  //
  // Iterate eggs then larvae as two separate arrays to avoid per-tick
  // `concat()` allocation (this BFS runs every tick under v10+).
  for (let pass = 0; pass < 2; pass++) {
    const broodIds = pass === 0 ? eggIds : larvaeIds;
    for (let i = 0; i < broodIds.length; i++) {
      const bid = broodIds[i]!;
      if (!isBroodReclaimable(ants, bid)) continue;
      const tx = ants.posX[bid]! >> FP_SHIFT;
      const ty = ants.posY[bid]! >> FP_SHIFT;
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
      // Skip brood inside any Nursery footprint.
      let insideNursery = false;
      for (let c = 0; c < chambers.length; c++) {
        const chamber = chambers[c]!;
        if (chamber.chamberType !== ChamberType.Nursery) continue;
        const bx = chamber.posX >> FP_SHIFT;
        const by = chamber.posY >> FP_SHIFT;
        if (
          tx >= bx && tx < bx + chamber.width &&
          ty >= by && ty < by + chamber.height
        ) {
          insideNursery = true;
          break;
        }
      }
      if (insideNursery) continue;
      const idx = ty * width + tx;
      // Allow seeds on Open OR BeingDug tiles. BeingDug is reachable per
      // canEnterUndergroundTile, and the BFS expansion below traverses
      // both states, so a seed on a BeingDug tile propagates correctly.
      // PR #56 codex P1 round 3 fix: a carrier can die on a BeingDug
      // tile (e.g. mid-combat next to an active dig), dropping its brood
      // there. Pre-fix, the Open-only guard skipped that seed, the
      // pickup field had no source for the orphan, and mid-tunnel nurses
      // stranded indefinitely. The colonyHasClaimableBrood predicate in
      // ant-system.ts applies the same Open-or-BeingDug filter so the
      // field-seed-set and the release predicate agree exactly.
      const tileState = data[idx]!;
      if (
        tileState !== UndergroundTileState.Open &&
        tileState !== UndergroundTileState.BeingDug
      ) continue;
      if (out[idx] !== -2) continue;
      out[idx] = -1;
      queue[tail++] = idx;
    }
  }

  bfsExpandSeededField(out, queue, tail, data, width, height);
}
