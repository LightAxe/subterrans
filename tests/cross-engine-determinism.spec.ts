/**
 * #229 — cross-engine determinism proof.
 *
 * Every existing byte-identity test runs two worlds inside ONE Node process. This
 * is the only gate that compares a Node-run sim to a headless-Chromium-run sim
 * for the same (seed, script) — and cross-engine byte identity is the single
 * load-bearing assumption of Phase 7 lockstep (and Phase 6 mobile Safari/WebView).
 *
 * SCOPE: this runs under BOTH the `chromium` (V8) and `webkit` (JSC) projects,
 * each comparing its browser hash to the same Node(V8) baseline. So it covers the
 * transform-vs-loader / embedder / future-V8-drift axis (chromium) AND the JSC
 * axis (webkit — iOS Safari / WKWebView, the actual Phase-6 target; #254). The
 * harness is pure compute (no canvas/WebGL), so the `webkit` project is low-flake;
 * it is scoped to this spec alone in playwright.config.ts and installed alongside
 * chromium in the CI e2e job.
 *
 * Auto-matched by testMatch:/.*\.spec\.ts/ for chromium; the webkit project's
 * testMatch narrows to this file. Both run in the existing e2e job.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('Node and the browser engine produce byte-identical sim state for the canned scenario', async ({
  page,
}) => {
  // --- Node side: run the canned scenario under bare `node --experimental-strip-types`.
  // The script owns the canonical (seed, ticks) and prints "<seed> <ticks> <hash>".
  const nodeOut = execFileSync(
    'node',
    ['--experimental-strip-types', 'scripts/cross-engine-hash.ts'],
    {
      encoding: 'utf8',
    },
  ).trim();
  const [seedStr, ticksStr, nodeHash] = nodeOut.split(/\s+/);
  const seed = Number(seedStr);
  const ticks = Number(ticksStr);
  expect(Number.isInteger(seed), `bad seed from node script: "${nodeOut}"`).toBe(true);
  expect(Number.isInteger(ticks), `bad ticks from node script: "${nodeOut}"`).toBe(true);
  expect(nodeHash).toMatch(/^[0-9a-f]{8}$/);
  expect(nodeHash).not.toBe('00000000');

  // --- Browser side: same scenario via the Vite-served harness, invoked with the
  // SAME (seed, ticks) the Node script used, so any divergence is engine-attributable.
  await page.goto('/tests/cross-engine/harness.html');
  await page.waitForFunction(
    () => typeof (window as unknown as { __simHash?: unknown }).__simHash === 'function',
  );
  const browserHash = await page.evaluate(
    ([s, t]) =>
      (window as unknown as { __simHash: (a: number, b: number) => string }).__simHash(s, t),
    [seed, ticks] as [number, number],
  );

  expect(browserHash, 'Node hash !== browser hash — engine-dependent nondeterminism').toBe(
    nodeHash,
  );
});
