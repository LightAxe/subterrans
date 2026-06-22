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
// Issue #87 — shared BFS expansion (was a local helper here pre-#87;
// dig-system.ts and entrance-flow.ts had near-identical inline copies).
import { bfsExpandSeededField } from './bfs-flow-field.js';

// 4-cardinal step offsets (N/E/S/W), matching bfs-flow-field.ts' expansion
// order. Module-scope so the carrier-local flood in hasReachableNonFullNursery
// allocates nothing per call (AGENTS.md hot-loop rule; #173 Codex review).
const FLOOD_NEIGHBOR_DR = [-1, 0, 1, 0] as const;
const FLOOD_NEIGHBOR_DC = [0, 1, 0, -1] as const;

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
  /**
   * Issue #173 (V24+) — visited map reused by {@link hasReachableNonFullNursery}'s
   * carrier-local flood, kept separate from `queues` (which the flood reuses as
   * its FIFO queue) so the two never collide. Lazily allocated like the other
   * buffers (once per colony, never per tick — the flood only runs on the rare
   * null-deposit path).
   */
  depositReachVisited: Record<ColonyId, Int32Array>;
}

export function createChamberFlowFields(): ChamberFlowFields {
  return {
    food: {},
    nursing: {},
    queen: {},
    nurseDeposit: {},
    queues: {},
    depositReachVisited: {},
  };
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
): {
  food: Int32Array;
  nursing: Int32Array;
  queen: Int32Array;
  nurseDeposit: Int32Array;
  queue: Int32Array;
  depositReachVisited: Int32Array;
} {
  if (!(colonyId in cache.food)) cache.food[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.nursing)) cache.nursing[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.queen)) cache.queen[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.nurseDeposit)) cache.nurseDeposit[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.queues)) cache.queues[colonyId] = new Int32Array(gridSize);
  if (!(colonyId in cache.depositReachVisited))
    cache.depositReachVisited[colonyId] = new Int32Array(gridSize);
  return {
    food: cache.food[colonyId]!,
    nursing: cache.nursing[colonyId]!,
    queen: cache.queen[colonyId]!,
    nurseDeposit: cache.nurseDeposit[colonyId]!,
    queue: cache.queues[colonyId]!,
    depositReachVisited: cache.depositReachVisited[colonyId]!,
  };
}

// Note: `bfsExpandSeededField` lives in `./bfs-flow-field.js` per issue #87.

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
      if (chamber.chamberType === chamberTypes[t]!) {
        matches = true;
        break;
      }
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

/**
 * Count Open tiles inside a chamber footprint — the chamber's brood capacity
 * under the V24 one-brood-per-tile model (#173).
 */
function countOpenTiles(underground: UndergroundGrid, chamber: ChamberRecord): number {
  const { data, width, height } = underground;
  const bx = chamber.posX >> FP_SHIFT;
  const by = chamber.posY >> FP_SHIFT;
  let openCount = 0;
  for (let ty = 0; ty < chamber.height; ty++) {
    for (let tx = 0; tx < chamber.width; tx++) {
      const cx = bx + tx;
      const cy = by + ty;
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
      if (data[cy * width + cx] === UndergroundTileState.Open) openCount++;
    }
  }
  return openCount;
}

/**
 * Count brood that physically OCCUPY a tile inside a chamber footprint — the
 * chamber's current occupancy under V24 (#173). Uses {@link isBroodReclaimable}
 * (alive AND uncarried-or-orphaned) so it counts deposited brood and orphans
 * frozen at a dead carrier's tile, but NOT brood in active transit (carried by
 * a living nurse). Sharing isBroodReclaimable keeps this in lockstep with the
 * pickup-field seed set, so a Nursery's fill level reflects exactly the brood a
 * deposit could collide with.
 */
function residentBroodInChamber(
  ants: AntComponents,
  eggIds: ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  chamber: ChamberRecord,
): number {
  const bx = chamber.posX >> FP_SHIFT;
  const by = chamber.posY >> FP_SHIFT;
  let count = 0;
  for (let pass = 0; pass < 2; pass++) {
    const broodIds = pass === 0 ? eggIds : larvaeIds;
    for (let i = 0; i < broodIds.length; i++) {
      const bid = broodIds[i]!;
      if (!isBroodReclaimable(ants, bid)) continue;
      const tx = ants.posX[bid]! >> FP_SHIFT;
      const ty = ants.posY[bid]! >> FP_SHIFT;
      if (tx >= bx && tx < bx + chamber.width && ty >= by && ty < by + chamber.height) count++;
    }
  }
  return count;
}

/** A Nursery is full when its resident brood reaches its Open-tile capacity
 *  (1 brood/tile, #173 V24). A zero-Open-tile chamber counts as full. */
function nurseryIsFull(
  underground: UndergroundGrid,
  ants: AntComponents,
  eggIds: ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  chamber: ChamberRecord,
): boolean {
  const capacity = countOpenTiles(underground, chamber);
  if (capacity === 0) return true;
  return residentBroodInChamber(ants, eggIds, larvaeIds, chamber) >= capacity;
}

/** Seed every Open tile of `chamber` that is still unvisited (-2) as a source
 *  (-1) and enqueue it. Returns the new queue tail. */
function seedChamberOpenTiles(
  underground: UndergroundGrid,
  chamber: ChamberRecord,
  out: Int32Array,
  queue: Int32Array,
  tail: number,
): number {
  const { data, width, height } = underground;
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
  return tail;
}

/**
 * Issue #173 (V24+) — capacity-aware Nursery deposit flow field via a two-pass
 * seed so it prefers non-full Nurseries WITHOUT ever stranding a carrier:
 *
 *   Pass 1 — seed Open tiles of every NON-FULL Nursery, BFS expand. Every tile
 *            that can reach a non-full Nursery now points to the nearest one;
 *            full Nurseries reachable from here get step directions pointing OUT
 *            toward the non-full target (NOT a -1 source), so a carrier merely
 *            transiting a full Nursery keeps moving instead of depositing.
 *   Pass 2 — seed Open tiles of ANY Nursery that are STILL unvisited (-2) — i.e.
 *            Nurseries in a pocket from which no non-full Nursery is reachable
 *            (a full Nursery that is the only one a carrier there can reach, or
 *            the all-full case) — then BFS expand into the rest of that pocket.
 *
 * Net: a tile is a -1 source iff it belongs to a Nursery that is the carrier's
 * actual deposit destination (a reachable non-full Nursery, or — only when no
 * non-full Nursery is reachable — the fallback Nursery). The deposit gate keys
 * on that (-1) so brood lands one-per-tile in non-full Nurseries and never
 * overflows a full Nursery that is only being passed through. Any tile that can
 * reach SOME Nursery gets a direction, so a carrier is never stranded.
 *
 * Recomputed every tick (like {@link computeNursingPickupField}) because brood
 * positions — and therefore each Nursery's fill level — change as carriers
 * deposit. Each Nursery's fullness is evaluated exactly once (pass 1); pass 2
 * keys on the -2 tile sentinel, not a second fullness scan.
 *
 * Output: -1 = source, -2 = unreachable (no Nursery reachable at all), 0..3 =
 * step N/E/S/W. Deterministic: chamber array order × row-major iteration.
 */
export function computeNurseryDepositField(
  underground: UndergroundGrid,
  chambers: ReadonlyArray<ChamberRecord>,
  ants: AntComponents,
  eggIds: ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  out: Int32Array,
  queue: Int32Array,
): void {
  const { data, width, height } = underground;

  out.fill(-2);
  let tail = 0;

  // Pass 1: non-full Nurseries (preferred deposit targets). Fullness computed
  // once per Nursery here.
  for (let c = 0; c < chambers.length; c++) {
    const chamber = chambers[c]!;
    if (chamber.chamberType !== ChamberType.Nursery) continue;
    if (nurseryIsFull(underground, ants, eggIds, larvaeIds, chamber)) continue;
    tail = seedChamberOpenTiles(underground, chamber, out, queue, tail);
  }
  bfsExpandSeededField(out, queue, tail, data, width, height);

  // Pass 2: fallback — any Nursery whose Open tiles are still unreachable from a
  // non-full Nursery (pocket isolation, or every Nursery full). Seeds only the
  // still-(-2) tiles, then expands into the remaining unreached region so a
  // carrier there is never stranded.
  tail = 0;
  for (let c = 0; c < chambers.length; c++) {
    const chamber = chambers[c]!;
    if (chamber.chamberType !== ChamberType.Nursery) continue;
    tail = seedChamberOpenTiles(underground, chamber, out, queue, tail);
  }
  bfsExpandSeededField(out, queue, tail, data, width, height);
}

/**
 * Issue #173 (V24+) — is a non-full Nursery reachable from the carrier's CURRENT
 * tile over the walkable tunnel graph? Used by the deposit path to decide, when
 * the carrier's reached (full) Nursery yields no free tile, whether to DEFER
 * (another non-full Nursery is reachable from here → reroute next tick) or
 * OVERFLOW (no non-full Nursery is reachable → stack as a last resort so the
 * carrier never strands).
 *
 * Why reachability must be carrier-LOCAL, not a global capacity scan: in a
 * partitioned colony (e.g. a cave-in severs a tunnel) a non-full Nursery can
 * sit in a pocket the carrier cannot reach while the only Nursery reachable
 * from the carrier is full. computeNurseryDepositField's Pass 2 still seeds
 * that full Nursery's Open tiles as -1 sources for the carrier's pocket, so the
 * carrier stands on a -1 tile, triggers a deposit attempt, and gets null. A
 * global "does any Nursery have room?" check would see the unreachable non-full
 * Nursery and DEFER — forever, because the rebuilt field is identical every
 * tick and cannot route the carrier across the severed tunnel. Scoping the
 * "can I reroute?" question to the carrier's own connected component lets the
 * disconnected case fall through to overflow like the all-full case, while
 * still deferring in the legitimate mid-tick race (an earlier carrier filled a
 * reachable non-full Nursery this tick — that Nursery is in the carrier's
 * component, so the flood still finds another non-full target if one remains).
 *
 * Implementation: a BFS flood from the carrier's tile over Open/BeingDug tiles
 * (the same traversal predicate as {@link bfsExpandSeededField}), returning true
 * as soon as it enters the footprint of a non-full Nursery. `visited` and
 * `queue` are pre-allocated W*H Int32Arrays (the deposit-reach scratch and the
 * shared BFS queue, both free at deposit time); `visited` is filled with 0 on
 * entry (O(W*H), only on the rare null-deposit path). The carrier's start tile
 * is excluded from the Nursery test on purpose — it sits inside the FULL
 * Nursery it just failed to deposit into. Deterministic: N/E/S/W expansion,
 * row-major chamber/footprint iteration. Shares the same occupancy predicate
 * (nurseryIsFull) as computeNurseryDepositField so deposit and routing agree.
 */
export function hasReachableNonFullNursery(
  underground: UndergroundGrid,
  chambers: ReadonlyArray<ChamberRecord>,
  ants: AntComponents,
  eggIds: ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  carrierTileX: number,
  carrierTileY: number,
  visited: Int32Array,
  queue: Int32Array,
): boolean {
  const { data, width, height } = underground;
  if (carrierTileX < 0 || carrierTileX >= width || carrierTileY < 0 || carrierTileY >= height) {
    return false;
  }

  // 4-cardinal step offsets are module-scope (FLOOD_NEIGHBOR_*) — see note there.
  // `visited` is the visited map (0 = unvisited, 1 = visited); `queue` holds
  // tiles packed as (row << 16) | col so the BFS decodes coordinates with
  // shifts/masks — no `/` operator (AGENTS.md determinism rule); each axis is
  // far below 2^16. Flat indices into `visited`/`data` use row * width + col
  // (multiplication is allowed in sim code). The carrier's start tile is marked
  // visited but NOT tested for non-fullness — it is the full Nursery the deposit
  // just failed in.
  visited.fill(0);
  visited[carrierTileY * width + carrierTileX] = 1;
  queue[0] = (carrierTileY << 16) | carrierTileX;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const packed = queue[head++]!;
    const row = packed >> 16;
    const col = packed & 0xffff;
    for (let d = 0; d < 4; d++) {
      const nRow = row + FLOOD_NEIGHBOR_DR[d]!;
      const nCol = col + FLOOD_NEIGHBOR_DC[d]!;
      if (nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) continue;
      const nIdx = nRow * width + nCol;
      if (visited[nIdx] === 1) continue;
      const tileState = data[nIdx]!;
      if (tileState !== UndergroundTileState.Open && tileState !== UndergroundTileState.BeingDug) {
        continue;
      }
      visited[nIdx] = 1;
      // Reached a walkable tile — is it inside a non-full Nursery?
      if (tileInNonFullNursery(underground, chambers, ants, eggIds, larvaeIds, nCol, nRow)) {
        return true;
      }
      queue[tail++] = (nRow << 16) | nCol;
    }
  }
  return false;
}

/** True iff (tx,ty) lies inside the footprint of a non-full Nursery. */
function tileInNonFullNursery(
  underground: UndergroundGrid,
  chambers: ReadonlyArray<ChamberRecord>,
  ants: AntComponents,
  eggIds: ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  tx: number,
  ty: number,
): boolean {
  for (let c = 0; c < chambers.length; c++) {
    const chamber = chambers[c]!;
    if (chamber.chamberType !== ChamberType.Nursery) continue;
    const bx = chamber.posX >> FP_SHIFT;
    const by = chamber.posY >> FP_SHIFT;
    if (tx < bx || tx >= bx + chamber.width || ty < by || ty >= by + chamber.height) continue;
    if (!nurseryIsFull(underground, ants, eggIds, larvaeIds, chamber)) return true;
  }
  return false;
}

/** Chamber type lists exported so callers don't hard-code the arrays. */
export const FOOD_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.FoodStorage] as const;
export const NURSING_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [
  ChamberType.Queen,
  ChamberType.Nursery,
] as const;
export const QUEEN_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.Queen] as const;
/** Issue #17 Phase 1 — Nursery-only seeds for the v10 nurseDeposit field. */
export const NURSERY_CHAMBER_TYPES: ReadonlyArray<ChamberType> = [ChamberType.Nursery] as const;

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
  ants: AntComponents,
  eggIds: ReadonlyArray<number>,
  larvaeIds: ReadonlyArray<number>,
  out: Int32Array,
  queue: Int32Array,
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
        if (tx >= bx && tx < bx + chamber.width && ty >= by && ty < by + chamber.height) {
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
      if (tileState !== UndergroundTileState.Open && tileState !== UndergroundTileState.BeingDug)
        continue;
      if (out[idx] !== -2) continue;
      out[idx] = -1;
      queue[tail++] = idx;
    }
  }

  bfsExpandSeededField(out, queue, tail, data, width, height);
}
