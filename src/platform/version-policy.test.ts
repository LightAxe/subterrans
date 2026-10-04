// version-policy.test.ts
// simVersion / MIN_ACCEPTED_SIM_VERSION policy guard (#228, revised for the pre-1.0
// no-gate policy of 2026-10-01 — AGENTS.md "simVersion and saves", ARCHITECTURE.md
// Principle 7).
//
// Pre-1.0 there are no simVersion gates. A sim-behaviour PR bumps LATEST and sets
// MIN to the same value, so MIN === LATEST is the normal state, not an exception.
// This file checks four things:
//   - LATEST is the newest registered version;
//   - MIN never exceeds LATEST;
//   - MIN never drops below its floor (V50, and above V70 once past the transition:
//     since #408 that is also the reap floor);
//   - once past the transition from the gated policy, MIN equals LATEST.
// At 1.0 the post-1.0 rolling window (MIN held back while LATEST advances behind
// sticky gates) replaces the last of these; ARCHITECTURE.md Principle 7, "Re-enabling
// simVersion gates (post-1.0)", has the checklist and the template.
import { describe, it, expect } from 'vitest';
import { MIN_ACCEPTED_SIM_VERSION } from './save.js';
import * as simTypes from '../sim/types.js';

const { LATEST_SIM_VERSION, SIM_VERSION_V50_LOCATED_FOOD } = simTypes;

/**
 * The last simVersion written under the earlier gated, rolling-window policy.
 * #402 (V69) and #405 (V70) were opened before the policy changed and landed with
 * their gates while MIN stayed put. Every version above this one is ungated, so once
 * LATEST passes it, MIN must equal LATEST.
 *
 * It is also the reap floor: #408 removed the remaining gates of this version and
 * earlier, so the code no longer has those rules, and MIN must stay above it for
 * good, post-1.0 included. Frozen; do not delete it. The transition branches below may go, leaving
 * MIN === LATEST unconditional until 1.0.
 */
const LAST_GATED_SIM_VERSION = 70;

/**
 * The highest value MIN had reached when this guard was written (the V50
 * located-food save wipe, #290). MIN may never drop below it. Past the transition,
 * MIN === LATEST plus "LATEST is the newest registered version" keep MIN moving
 * forward, so this floor needs no per-PR upkeep.
 */
const MIN_FLOOR = SIM_VERSION_V50_LOCATED_FOOD;

const POLICY_HINT =
  'Pre-1.0 policy (AGENTS.md "simVersion and saves"): a PR that bumps ' +
  'LATEST_SIM_VERSION also sets MIN_ACCEPTED_SIM_VERSION (src/platform/save.ts) to ' +
  'the same value, and does not gate the change behind `simVersion >=`.';

/** Every `SIM_VERSION_V<n>…` export of types.ts, with the n its name claims. */
function registeredVersions(): { name: string; nameVersion: number; value: unknown }[] {
  const exported: Record<string, unknown> = simTypes;
  const out: { name: string; nameVersion: number; value: unknown }[] = [];
  for (const [name, value] of Object.entries(exported)) {
    const m = /^SIM_VERSION_V(\d+)(?:_|$)/.exec(name);
    if (m) out.push({ name, nameVersion: Number(m[1]), value });
  }
  return out;
}

describe('simVersion policy (#228; pre-1.0: no gates, MIN moves with LATEST)', () => {
  it('LATEST_SIM_VERSION is the newest registered SIM_VERSION_V* constant', () => {
    const versions = registeredVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(v.value, `${v.name} must equal the version number in its name`).toBe(v.nameVersion);
    }
    const newest = Math.max(...versions.map((v) => v.nameVersion));
    expect(
      LATEST_SIM_VERSION,
      'point LATEST_SIM_VERSION at the newest SIM_VERSION_V* constant',
    ).toBe(newest);
  });

  it('MIN_ACCEPTED never exceeds LATEST (the window is never negative)', () => {
    expect(MIN_ACCEPTED_SIM_VERSION).toBeLessThanOrEqual(LATEST_SIM_VERSION);
  });

  it('MIN_ACCEPTED never drops below its floor', () => {
    expect(MIN_ACCEPTED_SIM_VERSION).toBeGreaterThanOrEqual(MIN_FLOOR);
    if (LATEST_SIM_VERSION > LAST_GATED_SIM_VERSION) {
      // Ungated behaviour cannot reproduce the gated era, so once MIN has left it,
      // it may never sink back into it.
      expect(MIN_ACCEPTED_SIM_VERSION).toBeGreaterThan(LAST_GATED_SIM_VERSION);
    }
  });

  it('a simVersion bump moves MIN with LATEST (no simVersion gates pre-1.0)', () => {
    if (LATEST_SIM_VERSION > LAST_GATED_SIM_VERSION) {
      expect(MIN_ACCEPTED_SIM_VERSION, POLICY_HINT).toBe(LATEST_SIM_VERSION);
    } else {
      // Transition: the last gated PRs may leave MIN at the legacy floor. The only
      // other value it may take is LATEST; a partial raise into the window is never
      // valid.
      expect([MIN_FLOOR, LATEST_SIM_VERSION], POLICY_HINT).toContain(MIN_ACCEPTED_SIM_VERSION);
    }
  });
});
