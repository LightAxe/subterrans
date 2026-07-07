// bench/tick-cost.bench.ts — whole-sim tick-cost benchmark (#235).
//
// Invocation: cd code && npx vitest run --config bench/vitest.bench.config.ts
//
// INFORMATIONAL ONLY — not run by `npm run verify` / CI (matches the #188
// rationale: instrumented/timing runs are local-only, never CI-gated). Prints
// ticks/sec for three whole-sim workloads at a pinned seed so the #235 gating
// PRs (brood-field dirty-gate, step-9 rebuild split) can quantify their win:
// run this, record idle/excavation/combat ticks/sec BEFORE and AFTER the gate,
// paste the delta into the PR body.
//
// Lives outside src/sim/ so performance.now is allowed (the simSafetyConfig
// ESLint glob does not apply here).
import { describe, it } from 'vitest';
import { createScenario } from '../src/sim/scenario.js';
import { tick } from '../src/sim/tick.js';
import { PLAYER_COLONY_ID } from '../src/sim/constants.js';
import type { ColonyId } from '../src/sim/colony/colony-store.js';
import type { SimCommand } from '../src/sim/commands.js';

const SEED = 42;
const TICKS = 2000;
const WARMUP_TICKS = 200; // JIT warmup on a throwaway world
const PC = PLAYER_COLONY_ID as ColonyId;

function ticksPerSec(label: string, buildScript: () => SimCommand[][]): void {
  // Warmup a throwaway world to let the JIT settle before timing.
  {
    const warm = createScenario(SEED);
    const script = buildScript();
    for (let t = 0; t < WARMUP_TICKS; t++) tick(warm, script[t] ?? []);
  }
  const world = createScenario(SEED);
  const script = buildScript();
  const start = performance.now();
  for (let t = 0; t < TICKS; t++) tick(world, script[t] ?? []);
  const elapsedMs = performance.now() - start;
  const tps = TICKS / (elapsedMs / 1000);
  // eslint-disable-next-line no-console -- bench output is the deliverable
  console.log(
    `[tick-cost] ${label.padEnd(16)} ${tps.toFixed(0).padStart(8)} ticks/sec  (${elapsedMs.toFixed(1)}ms / ${TICKS} ticks)`,
  );
}

// idle — early-game, no player input (foraging/nursing/lifecycle only).
function idleScript(): SimCommand[][] {
  return [];
}

// excavation-heavy — ~10 dig marks over the first 100 ticks keeps diggers
// churning digFlowFieldDirty (the step-9 rebuild hot path #235 PR3 narrows).
function excavationScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const tileX = 20 + ((i * 3) % 12);
    const tileY = 2 + i;
    c[t] = [{ type: 'MarkDigTile', colonyId: PC, tileX, tileY, issuedAtTick: t }];
    t += 10;
  }
  return c;
}

// combat-heavy — rally the player's fighters + let the ENEMY_COLONY_ID AI invade;
// deaths exercise killAnt (the brood-field dirty trigger #235 PR2 adds).
function combatScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'SetRallyPoint', colonyId: PC, tileX: 64, tileY: 64, issuedAtTick: 0 }];
  c[20] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 3, fight: 7 }, issuedAtTick: 20 },
  ];
  return c;
}

describe('whole-sim tick-cost benchmark (#235 — informational)', () => {
  it('reports ticks/sec for idle / excavation-heavy / combat-heavy workloads', () => {
    ticksPerSec('idle', idleScript);
    ticksPerSec('excavation', excavationScript);
    ticksPerSec('combat', combatScript);
  });
});
