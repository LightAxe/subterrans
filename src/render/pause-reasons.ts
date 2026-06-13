// pause-reasons.ts — Stage 1 controls rework (issue #18): reconciled pause-reason set.
//
// The render loop is paused iff ANY reason is set. Two independent reasons can
// pause concurrently and must be cleared independently (Codex R1-5, R2-1):
//   - 'user' — the player pressed Space / clicked the ⏸ speed button.
//   - 'menu' — an Esc-driven overlay (pause menu / Save-Load dialog) is open.
//
// Before this set, Esc-close called gameLoop.resume() unconditionally, which
// would silently cancel a concurrent Space pause (and vice-versa). Routing both
// through the same set, then reconciling once to gameLoop.pause()/resume(),
// makes each reason independent: closing the menu only clears 'menu'; the loop
// stays paused if 'user' is still set.
//
// This module owns ONLY the reason bookkeeping — it is pure render-layer state
// with no Phaser / game-loop dependency, so it is trivially unit-testable. The
// caller (GameScene) reconciles the boolean `isPausedByAny()` to the imperative
// gameLoop.pause()/resume() each time a reason changes. Pausing here never
// touches speedMultiplier — speed and pause are orthogonal (Codex R2-11).

/** The set of reasons that can independently hold the render loop paused. */
export type PauseReason = 'user' | 'menu';

/**
 * PauseReasonState — a tiny set of active pause reasons.
 *
 * Modeled as a plain object with one boolean per reason rather than a JS `Set`
 * so it is JSON-trivial, allocation-free to read, and matches the
 * structure-of-flags style used elsewhere in the render layer. Not part of
 * WorldState; never saved.
 */
export interface PauseReasonState {
  user: boolean;
  menu: boolean;
}

/** Construct an empty reason set (nothing paused). */
export function createPauseReasonState(): PauseReasonState {
  return { user: false, menu: false };
}

/** Add a reason. Idempotent. */
export function setPauseReason(state: PauseReasonState, reason: PauseReason): void {
  state[reason] = true;
}

/** Remove a reason. Idempotent. */
export function clearPauseReason(state: PauseReasonState, reason: PauseReason): void {
  state[reason] = false;
}

/** Toggle a reason and return its new value. Used by the edge-triggered Space/⏸ 'user' pause. */
export function togglePauseReason(state: PauseReasonState, reason: PauseReason): boolean {
  state[reason] = !state[reason];
  return state[reason];
}

/** True iff the given reason is currently set. */
export function hasPauseReason(state: PauseReasonState, reason: PauseReason): boolean {
  return state[reason];
}

/** True iff ANY reason is set — i.e. the loop should be paused. */
export function isPausedByAny(state: PauseReasonState): boolean {
  return state.user || state.menu;
}

/**
 * Clear the ENTIRE reason set (Codex R2-1). Called by resetSessionState so a
 * new-game-from-Esc / Save-Load path can never leave 'menu' (or 'user') stuck
 * set on the fresh session.
 */
export function clearAllPauseReasons(state: PauseReasonState): void {
  state.user = false;
  state.menu = false;
}
