// chamber-flow.ts — multi-source BFS flow-field toward chamber Open tiles.
//
// Analogue of src/sim/entrance-flow.ts, but seeded from every Open tile
// inside a chamber footprint instead of from entrance shaft tops. Maintains
// three per-colony flow-fields:
//   - food    : seeded from Open tiles inside FoodStorage chambers.
//               Consumed by Underground carrying foragers routing to deposit.
//   - nursing : seeded from Open tiles inside Queen OR Nursery chambers.
//               Consumed by Nursing ants routing to tend brood.
//   - queen   : seeded from Open tiles inside Queen chambers only.
//               Consumed by the queen entity when routing from her current
//               underground tile to the Queen chamber footprint (PRD §4b —
//               queen relocates once a Queen chamber is completed).
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

// Direction constants — identical encoding to entrance-flow.ts / dig-system.ts.
//   0=N, 1=E, 2=S, 3=W, -1=source, -2=unreachable.
const REVERSE = [2, 3, 0, 1] as const;
const NEIGHBOR_DR = [-1, 0, 1, 0] as const;
const NEIGHBOR_DC = [0, 1, 0, -1] as const;

/**
 * Per-colony flow-field cache for chamber-targeted routing.
 *
 * `food`, `nursing`, and `queen` are parallel Int32Arrays of length W*H
 * indexed by tileY * width + tileX. `queues` is a single BFS scratch queue
 * per colony reused across the compute calls (BFS is sequential, never
 * concurrent).
 */
export interface ChamberFlowFields {
  food: Record<ColonyId, Int32Array>;
  nursing: Record<ColonyId, Int32Array>;
  queen: Record<ColonyId, Int32Array>;
  queues: Record<ColonyId, Int32Array>;
}

export function createChamberFlowFields(): ChamberFlowFields {
  return { food: {}, nursing: {}, queen: {}, queues: {} };
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
): { food: Int32Array; nursing: Int32Array; queen: Int32Array; queue: Int32Array } {
  if (!(colonyId in cache.food))    cache.food[colonyId]    = new Int32Array(gridSize);
  if (!(colonyId in cache.nursing)) cache.nursing[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.queen))   cache.queen[colonyId]   = new Int32Array(gridSize);
  if (!(colonyId in cache.queues))  cache.queues[colonyId]  = new Int32Array(gridSize);
  return {
    food:    cache.food[colonyId]!,
    nursing: cache.nursing[colonyId]!,
    queen:   cache.queen[colonyId]!,
    queue:   cache.queues[colonyId]!,
  };
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

  let head = 0;
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

  // BFS expansion through Open and BeingDug only.
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

/** Chamber type lists exported so callers don't hard-code the arrays. */
export const FOOD_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.FoodStorage];
export const NURSING_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [
  ChamberType.Queen,
  ChamberType.Nursery,
];
export const QUEEN_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.Queen];
