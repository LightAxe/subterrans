// allocation-system.ts — PRD §7a/§7b behavior allocation math
//
// Pure, stateless functions. No tick integration, no ant reassignment, no colony state writes.
// Downstream caller (Plan 10 tick.ts) reads the result and writes colony.computedAllocation.
//
// Invariant: result.nurse + result.forage + result.fight === workerCount  (when no auto-dig
// is active). The `dig` slot in the returned WorkerAllocation is always 0 from this function.
// Phase 10 auto-dig (CTRL-06, plan 02) writes colony.computedAllocation.dig from need.dig
// AFTER allocateWorkers in tick.ts step 10a; it consumes from the Idle pool, not from this
// split (D-02 scarcity policy: wait, no preemption).
//
// Remainder distribution: forage gets +1 if available > forage + fight (max remainder is 1
// when both slots are positive). Fight never receives remainder.

import type { BehaviorRatio, ColonyRecord, WorkerAllocation } from '../colony/colony-store.js';
import type { AntComponents } from '../ant/ant-store.js';
import type { UndergroundGrid } from '../terrain.js';
import { UndergroundTileState } from '../terrain.js';
import { AntTask } from '../enums.js';
import { NURSE_RATIO } from '../constants.js';

/**
 * Compute the number of nurses required for a given brood count.
 *
 * PRD §7a: one nurse required per NURSE_RATIO brood members (floor division),
 * capped at (a) ceil(workerCount / 4) — the 09 reproduction-gate memo cap so
 * nursing can never become a hidden full-worker tax — and (b) workerCount
 * itself. If the colony has no completed Nursery, nurse = 0 regardless of
 * brood count (legacy brood from older saves/debug states is left inert).
 *
 * Integer math throughout: `| 0` truncation, `(n+3) >> 2` for ceil(n/4).
 *
 * Cap table (for `ceil(workers / 4)`):
 *   workers  = 0  1  2  3  4  5  6  7  8  9 10 ...
 *   maxNurse = 0  1  1  1  1  2  2  2  2  3  3 ...
 *
 * @param broodCount  - Total brood (larvae + eggs) currently in the colony.
 * @param workerCount - Total available workers.
 * @param hasNursery  - True iff the colony owns a completed Nursery chamber.
 * @returns Number of workers that must be assigned as nurses.
 */
export function computeNurseCount(
  broodCount: number,
  workerCount: number,
  hasNursery: boolean,
): number {
  // 09 memo gate: no Nursery → no nurses, even if legacy brood exists.
  if (!hasNursery) return 0;
  if (workerCount <= 0 || broodCount <= 0) return 0;
  // eslint-disable-next-line no-restricted-syntax -- PRD §7a integer ratio, not float math
  const needed = (broodCount / NURSE_RATIO) | 0;
  // 09 memo cap: ceil(workerCount / 4). Deterministic integer form.
  const capByFraction = (workerCount + 3) >> 2;
  const capped = needed < capByFraction ? needed : capByFraction;
  return capped < workerCount ? capped : workerCount;
}

/**
 * Allocate workers across tasks according to PRD §7a (nurse carveout) and §7b
 * (two-role floor-split) under the Phase 10 amendment (CTRL-01' / CTRL-06).
 *
 * Algorithm:
 *  1. Nurse carveout (PRD §7a + 09 memo): nurses are computed BEFORE the
 *     two-role split. Gated on `hasNursery` and capped at ceil(workerCount/4)
 *     so nursing can never starve the triangle (see computeNurseCount).
 *  2. Remaining workers are split forage/fight by integer floor of the ratio weights.
 *  3. Remainder distribution: any leftover workers go to forage. Max remainder is
 *     1 when both slots are positive. Fight never receives a remainder bonus.
 *  4. The returned `dig` slot is always 0. Phase 10 auto-dig (CTRL-06, plan 02)
 *     writes colony.computedAllocation.dig from need.dig in tick.ts step 10a
 *     AFTER this function runs. Per CONTEXT.md D-02, scarcity is "wait — no
 *     preemption", so allocateWorkers does NOT reserve a slot for auto-dig;
 *     auto-dig consumes from the Idle pool instead.
 *
 * Invariant: result.nurse + result.forage + result.fight === workerCount
 *            (when no auto-dig is active that tick).
 *
 * Edge cases:
 *  - workerCount === 0: all fields are 0.
 *  - broodCount === 0: nurseCount === 0, all workers go to the two-role split.
 *  - hasNursery === false: nurseCount === 0 regardless of brood (09 memo gate).
 *  - total ratio === 0 (ratio {forage:0, fight:0}): all non-nurse workers are idle (0 allocated).
 *  - broodCount >> workerCount: nurseCount capped at ceil(workerCount/4).
 *
 * @param workerCount - Total workers to allocate.
 * @param broodCount  - Colony brood count, used for nurse carveout.
 * @param ratio       - Player/AI target task distribution (two roles: forage / fight).
 * @param hasNursery  - True iff the colony owns a completed Nursery chamber.
 * @returns WorkerAllocation; the `dig` field is always 0 from this function.
 */
export function allocateWorkers(
  workerCount: number,
  broodCount: number,
  ratio: BehaviorRatio,
  hasNursery: boolean,
): WorkerAllocation {
  const nurseCount = computeNurseCount(broodCount, workerCount, hasNursery);
  const available = workerCount - nurseCount;

  // WR-04: defensive clamp on ratio inputs. The BehaviorRatio interface declares
  // `number` without enforcing non-negativity or integer-ness. The SetBehaviorRatio
  // command handler in tick.ts step 5 rejects negatives, but direct mutations (tests,
  // future render-layer code) and corrupted saves can still feed negative or
  // fractional weights here. `| 0` truncates fractions to integers; `Math.max(0, …)`
  // floors negatives to 0 so `(available * ratio.forage / total) | 0` cannot
  // produce a negative integer (which would yield a nonsense allocation).
  // eslint-disable-next-line no-restricted-syntax -- PRD §7b integer guard, not float math
  const forageWeight = Math.max(0, ratio.forage | 0);
  // eslint-disable-next-line no-restricted-syntax -- PRD §7b integer guard, not float math
  const fightWeight  = Math.max(0, ratio.fight  | 0);

  const total = forageWeight + fightWeight;
  if (total === 0 || available === 0) {
    return { nurse: nurseCount, forage: 0, dig: 0, fight: 0 };
  }

  // eslint-disable-next-line no-restricted-syntax -- PRD §7b integer ratio, not float math
  const forage = ((available * forageWeight) / total) | 0;
  // eslint-disable-next-line no-restricted-syntax -- PRD §7b integer ratio, not float math
  const fight  = ((available * fightWeight)  / total) | 0;
  const remainder = available - forage - fight;

  return {
    nurse:  nurseCount,
    forage: forage + (remainder > 0 ? 1 : 0),
    dig:    0,
    fight:  fight,
  };
}

/**
 * Phase 10 / CTRL-06 — auto-dig demand check (D-02 LOCKED).
 *
 * Returns 1 if (a) at least one Marked tile exists in the colony's underground
 * grid AND (b) no ant in `colony.workers` currently has `task === AntTask.Digging`.
 * Returns 0 otherwise.
 *
 * Strict 1-digger cap (per CONTEXT.md D-02): if ANY ant of the colony is already
 * Digging, no new digger is auto-assigned this tick. This solves the tunnel-jam
 * problem from issue #13.
 *
 * Scarcity policy is handled at the call site (tick.ts step 10a): if no ant is
 * Idle, the demand goes unfulfilled this tick and Marked tiles wait. No
 * preemption of foragers / fighters.
 *
 * Pure function. Reads only `colony.workers`, `ants.alive`, `ants.task`, and the
 * underground grid `data` array — all deterministic state. No PRNG, no allocation,
 * no float math. Same inputs → same output by construction (SCEN-06).
 *
 * Boolean-style 0/1 form chosen over a count: concurrency is locked at 1 by
 * D-02; if a future phase lifts the cap, a count value would naturally generalize
 * (`0..N`), but coding it as a count today would invite a future contributor to
 * bump it to 2 without realizing the assertion is locked elsewhere.
 *
 * @param colony           - Colony record; iterated to detect any active digger.
 * @param undergroundGrid  - Colony's underground grid; scanned for Marked tiles.
 * @param ants             - Ant component store (alive + task arrays).
 * @returns 1 if Marked tiles exist and no ant is Digging in this colony, else 0.
 */
export function computeDigDemand(
  colony: ColonyRecord,
  undergroundGrid: UndergroundGrid,
  ants: AntComponents,
): number {
  // (b) Strict 1-digger cap — early exit on the cheaper check.
  for (let i = 0; i < colony.workers.length; i++) {
    const id = colony.workers[i]!;
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] === AntTask.Digging) return 0;
  }
  // (a) Marked tile presence — single linear scan over the grid's Uint8Array.
  // Direct data[] access (matches the Phase 07-04 decision for computeDigFlowField:
  // direct array access, not ugGet, in inner BFS loop for performance). Same fixed
  // iteration order as BFS (linear i from 0).
  const data = undergroundGrid.data;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === UndergroundTileState.Marked) return 1;
  }
  return 0;
}
