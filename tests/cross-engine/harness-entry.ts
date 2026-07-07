/**
 * #229 — browser entry for the cross-engine determinism harness. Vite transforms
 * this .ts on the fly when harness.html loads and exposes the canned-scenario
 * hasher on `window`, so the Playwright spec can invoke it via page.evaluate and
 * compare against the Node-computed hash.
 */
import { runCannedHash } from './run-canned.js';

declare global {
  interface Window {
    __simHash?: (seed: number, ticks: number) => string;
  }
}

window.__simHash = (seed: number, ticks: number): string => runCannedHash(seed, ticks);

export {};
