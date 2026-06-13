// pause-reasons.test.ts — Vitest unit tests for the reconciled pause-reason set
// (Stage 1 controls rework, issue #18). Covers the reconciliation + full-reset
// contract (Codex R1-5, R2-1).

import { describe, it, expect } from 'vitest';
import {
  createPauseReasonState,
  setPauseReason,
  clearPauseReason,
  togglePauseReason,
  hasPauseReason,
  isPausedByAny,
  clearAllPauseReasons,
} from './pause-reasons.js';

describe('pause-reasons', () => {
  it('starts empty (nothing paused)', () => {
    const s = createPauseReasonState();
    expect(isPausedByAny(s)).toBe(false);
  });

  it('isPausedByAny is true iff any reason is set', () => {
    const s = createPauseReasonState();
    setPauseReason(s, 'user');
    expect(isPausedByAny(s)).toBe(true);
    clearPauseReason(s, 'user');
    expect(isPausedByAny(s)).toBe(false);
    setPauseReason(s, 'menu');
    expect(isPausedByAny(s)).toBe(true);
  });

  it('clearing one reason does not resume while the other is still set (Codex R1-5)', () => {
    const s = createPauseReasonState();
    setPauseReason(s, 'user');
    setPauseReason(s, 'menu');
    // Esc closes the menu → clear 'menu' only; a concurrent Space ('user') stays.
    clearPauseReason(s, 'menu');
    expect(hasPauseReason(s, 'menu')).toBe(false);
    expect(hasPauseReason(s, 'user')).toBe(true);
    expect(isPausedByAny(s)).toBe(true);
  });

  it('togglePauseReason flips and returns the new value (edge-triggered Space)', () => {
    const s = createPauseReasonState();
    expect(togglePauseReason(s, 'user')).toBe(true);
    expect(isPausedByAny(s)).toBe(true);
    expect(togglePauseReason(s, 'user')).toBe(false);
    expect(isPausedByAny(s)).toBe(false);
  });

  it('set/clear are idempotent', () => {
    const s = createPauseReasonState();
    setPauseReason(s, 'user');
    setPauseReason(s, 'user');
    expect(hasPauseReason(s, 'user')).toBe(true);
    clearPauseReason(s, 'user');
    clearPauseReason(s, 'user');
    expect(hasPauseReason(s, 'user')).toBe(false);
  });

  it('clearAllPauseReasons wipes the entire set (full reset — Codex R2-1)', () => {
    const s = createPauseReasonState();
    setPauseReason(s, 'user');
    setPauseReason(s, 'menu');
    clearAllPauseReasons(s);
    expect(hasPauseReason(s, 'user')).toBe(false);
    expect(hasPauseReason(s, 'menu')).toBe(false);
    expect(isPausedByAny(s)).toBe(false);
  });
});
