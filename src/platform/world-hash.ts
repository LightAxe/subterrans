/**
 * #229 — shared deterministic world-state hash, extracted from byte-gate.test.ts
 * so the same hasher is reused by the env-gated byte gate AND the cross-engine
 * (Node vs headless Chromium) determinism proof. Sim-only import graph (types +
 * save) so it loads under bare `node --experimental-strip-types` and under Vite
 * in the browser — do NOT add `import.meta` / Vite-only syntax here.
 */
import type { WorldState } from '../sim/types.js';
import { serializeWorldState } from './save.js';

/** FNV-1a over a string — fast, deterministic change-detection hash (not crypto). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic content hash of a world's serialized state (8 hex chars). */
export function hashWorldState(world: WorldState): string {
  return fnv1a(JSON.stringify(serializeWorldState(world)));
}
