// rng.ts — Mulberry32 PRNG for src/sim/
// Source: RESEARCH.md Pattern 2 (lines 383–420), verified against PRD §4 (lines 509–572).
//
// Canonical Mulberry32 as specified in PRD §4. This API is normative — do not
// rename methods, add nextFloat(), or create module-level singleton instances.
//
// WorldState integration contract (PRD §4): Reconstruct `new Rng(state.rngState)` at
// tick start; write `state.rngState = rng.getState()` at tick end.
// Module-level singleton Rng instances are forbidden — they break save/load and replay.

export class Rng {
  private state: number; // internal uint32

  constructor(seed: number) {
    this.state = seed >>> 0; // coerce to uint32 (matches setState and PRD §4 vectors)
  }

  /** Uniform integer in [0, 0xFFFFFFFF]. Advances state one step. */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0); // Mulberry32 advance — keep uint32
    t = Math.imul(t ^ (t >>> 15), t | 1); // hash-mix shift 15 — PRD §4 normative
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); // hash-mix shifts 7, 61 — PRD §4 normative
    return (t ^ (t >>> 14)) >>> 0; // hash-mix shift 14 — PRD §4 normative; >>> 0 coerces to uint32
  }

  /** Uniform integer in [0, max). `max` must be a positive integer. */
  nextInt(max: number): number {
    return this.nextU32() % max;
  }

  /** Uniform integer in [min, max] inclusive. Requires `max >= min`. */
  nextRange(min: number, max: number): number {
    return min + (this.nextU32() % (max - min + 1));
  }

  /** Snapshot PRNG state for `worldState.rngState` at tick end. */
  getState(): number {
    return this.state;
  }

  /** Restore PRNG from serialized state (save/load, replay). */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}
