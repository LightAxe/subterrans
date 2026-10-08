// queen-stores-line.test.ts — #425: the "Waiting for stores" line is held through
// laying blips (2 s of sim ticks), and amber is held as long after `capped` clears.
import { describe, it, expect } from 'vitest';
import {
  QUEEN_STORES_HOLD_TICKS,
  createQueenStoresLineState,
  holdQueenStoresLine,
  resetQueenStoresLineState,
} from './queen-stores-line.js';
import type { QueenStoresWait } from './storage-hint.js';

const H = QUEEN_STORES_HOLD_TICKS;
const grey = (stored = 24, need = 30): QueenStoresWait => ({
  storedFood: stored,
  needFood: need,
  capped: false,
});
const amber = (stored = 24, need = 30): QueenStoresWait => ({
  storedFood: stored,
  needFood: need,
  capped: true,
});

describe('#425 — holdQueenStoresLine', () => {
  it('holds 40 ticks (2 s)', () => {
    expect(H).toBe(40);
  });

  it('shows the live wait as is', () => {
    const s = createQueenStoresLineState();
    expect(holdQueenStoresLine(s, 100, grey())).toEqual(grey());
  });

  it('is null when it never waited', () => {
    const s = createQueenStoresLineState();
    expect(holdQueenStoresLine(s, 100, null)).toBeNull();
  });

  it('stays up across a 1-5 tick gap, with the last waiting numbers', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, grey(65, 70));
    for (let t = 101; t <= 105; t++) {
      expect(holdQueenStoresLine(s, t, null)).toEqual(grey(65, 70));
    }
    // waiting resumes with new numbers: live numbers win
    expect(holdQueenStoresLine(s, 106, grey(65, 71))).toEqual(grey(65, 71));
  });

  it('hides after the hold', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, grey());
    expect(holdQueenStoresLine(s, 100 + H, null)).toEqual(grey());
    expect(holdQueenStoresLine(s, 100 + H + 1, null)).toBeNull();
    expect(holdQueenStoresLine(s, 100 + H + 2, null)).toBeNull();
  });

  it('holds amber 40 ticks after capped clears, then turns grey', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, amber());
    expect(holdQueenStoresLine(s, 101, grey())?.capped).toBe(true);
    expect(holdQueenStoresLine(s, 100 + H, grey())?.capped).toBe(true);
    expect(holdQueenStoresLine(s, 100 + H + 1, grey())?.capped).toBe(false);
  });

  it('amber hold keeps the live numbers', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, amber(65, 70));
    expect(holdQueenStoresLine(s, 102, grey(66, 66))).toEqual(amber(66, 66));
  });

  it('grey to amber is immediate', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, grey());
    expect(holdQueenStoresLine(s, 101, amber())?.capped).toBe(true);
  });

  it('the issue sample: no off frames, then amber held through the blip at 7543', () => {
    const s = createQueenStoresLineState();
    for (let t = 7338; t < 7543; t++) {
      expect(holdQueenStoresLine(s, t, amber(65, 70))).toEqual(amber(65, 70));
    }
    expect(holdQueenStoresLine(s, 7543, null)).toEqual(amber(65, 70));
    expect(holdQueenStoresLine(s, 7544, amber(65, 71))).toEqual(amber(65, 71));
  });

  it('capped at tick 0 is held like any other tick', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 0, amber());
    expect(holdQueenStoresLine(s, 1, grey())?.capped).toBe(true);
  });

  it('does not advance while the tick does not (paused)', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, amber());
    for (let frame = 0; frame < 1000; frame++) {
      const shown = holdQueenStoresLine(s, 101, null);
      expect(shown).toEqual(amber());
    }
  });

  it('reset clears it', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 100, amber());
    resetQueenStoresLineState(s);
    expect(holdQueenStoresLine(s, 101, null)).toBeNull();
  });

  it('a tick that goes backwards (a load) clears it', () => {
    const s = createQueenStoresLineState();
    holdQueenStoresLine(s, 5000, amber());
    expect(holdQueenStoresLine(s, 10, null)).toBeNull();
  });

  it('non-null across a blip sequence', () => {
    // UIScene draws, and masks input with, exactly the returned result (wiring covered
    // by tests/storage-hint.spec.ts).
    const s = createQueenStoresLineState();
    const seq: (QueenStoresWait | null)[] = [null, grey(), null, null, grey(), null];
    const shown = seq.map((live, i) => holdQueenStoresLine(s, 100 + i, live));
    expect(shown.map((x) => x !== null)).toEqual([false, true, true, true, true, true]);
  });
});
