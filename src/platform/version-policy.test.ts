// version-policy.test.ts
// #228 — simVersion acceptance-window policy guard. See save.ts's
// DELIBERATE_WINDOW_BREAK_AT for the exception ritual this test enforces.
import { describe, it, expect } from 'vitest';
import { MIN_ACCEPTED_SIM_VERSION, DELIBERATE_WINDOW_BREAK_AT } from './save.js';
import { LATEST_SIM_VERSION } from '../sim/types.js';

describe('simVersion acceptance-window policy (#228)', () => {
  it('MIN_ACCEPTED never exceeds LATEST (the window is never negative)', () => {
    expect(MIN_ACCEPTED_SIM_VERSION).toBeLessThanOrEqual(LATEST_SIM_VERSION);
  });

  it('the window is open (MIN < LATEST) unless a version-scoped deliberate break is declared', () => {
    // Raising MIN to LATEST silently discards every player save. If you are here
    // because this failed: either leave MIN alone and gate your change behind
    // `simVersion >= <new version>`, or follow the deliberate-break ritual on
    // DELIBERATE_WINDOW_BREAK_AT in save.ts (set it to the new LATEST in the same
    // PR that raises MIN; set it back to null in the next LATEST bump).
    if (DELIBERATE_WINDOW_BREAK_AT === null) {
      expect(MIN_ACCEPTED_SIM_VERSION).toBeLessThan(LATEST_SIM_VERSION);
    } else {
      // A declared break is valid ONLY at the current LATEST and ONLY while the
      // window is closed — this forces the flag back to null on the next LATEST
      // bump and blocks a stale break from surviving a combined MIN+LATEST raise.
      expect(MIN_ACCEPTED_SIM_VERSION).toBe(LATEST_SIM_VERSION);
      expect(DELIBERATE_WINDOW_BREAK_AT).toBe(LATEST_SIM_VERSION);
    }
  });
});
