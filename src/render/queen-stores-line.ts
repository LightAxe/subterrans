// queen-stores-line.ts — #425: hysteresis for the queen's "Waiting for stores" line.
// queenStoresWait (storage-hint.ts) is recomputed from the live world, so each time
// she lays, the new larva raises the need for a tick or two: the line blinked off
// and, as `capped` crossed capacity, back in the other colour. This holds the line
// up for QUEEN_STORES_HOLD_TICKS after the wait ends and amber for as long after
// `capped` clears. Timed in sim ticks (world.tick), so pausing freezes the hold.
// Pure: UIScene calls holdQueenStoresLine and draws what it returns; the strip's
// input mask (queenStoresStripState) is derived from that same displayed result.

import type { QueenStoresWait } from './storage-hint.js';

/** 2 s at 20 ticks/s. */
export const QUEEN_STORES_HOLD_TICKS = 40;

export interface QueenStoresLineState {
  /** The latest live "waiting" result, with the `capped` it had. */
  lastWait: QueenStoresWait | null;
  /** The tick of the latest live wait, and of the latest live capped wait. */
  lastWaitTick: number;
  lastCappedTick: number;
  /** The latest tick seen, so a tick that goes backwards (a load) resets the hold. */
  lastTick: number;
}

export function createQueenStoresLineState(): QueenStoresLineState {
  return { lastWait: null, lastWaitTick: 0, lastCappedTick: -1, lastTick: 0 };
}

/** Clear the hold (new game, restart, retry, load). */
export function resetQueenStoresLineState(state: QueenStoresLineState): void {
  state.lastWait = null;
  state.lastWaitTick = 0;
  state.lastCappedTick = -1;
  state.lastTick = 0;
}

/**
 * What the line shows at `tick`, given the live wait (null when not waiting).
 * While live it shows the live numbers; for QUEEN_STORES_HOLD_TICKS after the wait
 * ends it keeps the last waiting numbers (or the live ones if waiting resumes).
 * Amber (`capped`) is held the same long after the live `capped` clears; grey to
 * amber is immediate. Null once both have run out.
 */
export function holdQueenStoresLine(
  state: QueenStoresLineState,
  tick: number,
  live: QueenStoresWait | null,
): QueenStoresWait | null {
  if (tick < state.lastTick) resetQueenStoresLineState(state);
  state.lastTick = tick;
  if (live) {
    state.lastWait = live;
    state.lastWaitTick = tick;
    if (live.capped) state.lastCappedTick = tick;
  }
  const last = state.lastWait;
  if (last === null || tick - state.lastWaitTick > QUEEN_STORES_HOLD_TICKS) return null;
  const amber = state.lastCappedTick >= 0 && tick - state.lastCappedTick <= QUEEN_STORES_HOLD_TICKS;
  return { ...last, capped: amber || last.capped };
}
