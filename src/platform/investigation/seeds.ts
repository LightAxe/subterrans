// seeds.ts — three DISJOINT seed sets for the flurry PR-2 investigation harness.
//
// Per plan/flurry/PR2-REPLAN.md Phase 0 §1 (R3-P1-4): the investigation uses
// three non-overlapping seed sets so that numeric acceptance caps are never
// tuned and verified on the same seeds.
//
//   - DISCOVERY  — used to FIND mis-movement mechanisms (inspected freely).
//   - CALIBRATION — used to SET the numeric acceptance caps.
//   - ACCEPTANCE — an untouched hold-out, NEVER inspected during design; used
//                  only for post-fix verification. If an acceptance seed ever
//                  fails (R4-P2-5) it is no longer a clean hold-out: move it
//                  into DISCOVERY and mint a fresh acceptance set before any
//                  retuning, so acceptance always verifies on never-seen seeds.
//
// Seed 11 (Codex's scent-vs-wall repro, ant 22) lives in DISCOVERY because it
// has already been inspected and is therefore not a clean hold-out.
//
// The sets are asserted disjoint by the harness test; do not let them overlap.

/** Seeds used to discover and reproduce mechanisms. Inspected freely. */
export const DISCOVERY_SEEDS: readonly number[] = [
  11, // Codex scent-vs-wall repro (ant 22, movementSource="scent")
  42,
  99,
  7,
  123,
  256,
  777,
  2024,
  31415,
  8675309,
];

/** Seeds used to set the numeric acceptance caps (worst-episode ticks, etc.). */
export const CALIBRATION_SEEDS: readonly number[] = [13, 17, 23, 51, 88, 101, 202, 303, 404, 505];

/** Untouched hold-out — NEVER inspect during design. Post-fix verification only. */
export const ACCEPTANCE_SEEDS: readonly number[] = [
  1009, 2017, 3023, 4051, 5077, 6101, 7127, 8147, 9173, 10193,
];

/** All three difficulties createScenario accepts. The mis-movement sweep runs
 *  every seed across all three (terrain density + spider behaviour vary). */
export const DIFFICULTIES: readonly ('Easy' | 'Normal' | 'Hard')[] = ['Easy', 'Normal', 'Hard'];

/** Returns true iff the three seed sets are mutually disjoint (sanity gate). */
export function seedSetsAreDisjoint(): boolean {
  const all = [...DISCOVERY_SEEDS, ...CALIBRATION_SEEDS, ...ACCEPTANCE_SEEDS];
  return new Set(all).size === all.length;
}
