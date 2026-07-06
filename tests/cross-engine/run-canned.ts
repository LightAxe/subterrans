/**
 * #229 — the single canned scenario BOTH engines run for the cross-engine
 * byte-identity proof (Node via scripts/cross-engine-hash.ts, headless Chromium
 * via harness.html). Sim-only import graph so it loads under bare
 * `node --experimental-strip-types` AND under Vite in the browser — do NOT add
 * `import.meta` or any Vite-only syntax here (the whole point is engine-agnostic
 * execution).
 */
import { createScenario } from '../../src/sim/scenario.js';
import { tick } from '../../src/sim/tick.js';
import { hashWorldState } from '../../src/platform/world-hash.js';
import { PLAYER_COLONY_ID } from '../../src/sim/constants.js';
import type { ColonyId } from '../../src/sim/colony/colony-store.js';
import type { SimCommand } from '../../src/sim/commands.js';

/** Pinned tuple — both engines must run this exact (seed, ticks). */
export const CE_SEED = 1337;
export const CE_TICKS = 3000;

const PC = PLAYER_COLONY_ID as ColonyId;

/**
 * Fixed command script (byte-gate `digFightScript` shape): diggers + descent
 * toward the enemy grid, a fight-ratio pivot (combat paths), and a surface rally
 * — so the run exercises the movement / dig / combat-targeting / foraging
 * clusters, not just passive idling. Deterministic; no Math.random / wall-clock.
 */
function cannedScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 2, issuedAtTick: 0 }];
  c[5] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 6, issuedAtTick: 5 }];
  c[10] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 12, issuedAtTick: 10 }];
  c[20] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 30, tileY: 18, issuedAtTick: 20 }];
  c[40] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 5, fight: 5 }, issuedAtTick: 40 },
  ];
  c[60] = [{ type: 'SetRallyPoint', colonyId: PC, tileX: 30, tileY: 20, issuedAtTick: 60 }];
  c[200] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 2, fight: 8 }, issuedAtTick: 200 },
  ];
  return c;
}

/** Build the canned world, tick `ticks` times feeding the fixed script, return the 8-hex state hash. */
export function runCannedHash(seed: number, ticks: number): string {
  const world = createScenario(seed);
  const script = cannedScript();
  for (let t = 0; t < ticks; t++) {
    tick(world, script[t] ?? []);
  }
  return hashWorldState(world);
}
