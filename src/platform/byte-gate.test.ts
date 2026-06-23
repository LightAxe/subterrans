// src/platform/byte-gate.test.ts
// Cross-build byte-identical gate for the #212 ant-system.ts split (PLAN.md §B).
//
// Lives in platform/ (NOT sim/) because the sacred sim→platform import boundary
// forbids a sim/ file from importing the full save serializer; platform→sim is
// allowed, so here we get BOTH createScenario/tick AND save.ts serializeWorldState.
//
// NOT a normal-suite test: env-gated, SKIPS unless BYTE_GATE_MODE is set, so
// `npm run verify` stays green and no golden hash is committed (PLAN.md D2 — a
// permanent golden would fire on every legitimate future behavior change).
//
//   Capture the baseline ON THE PRE-SPLIT TREE, BEFORE any split edit:
//     BYTE_GATE_MODE=capture BYTE_GATE_FILE=/abs/baseline.json \
//       npx vitest run src/platform/byte-gate.test.ts
//   Verify the split reproduces it (on the split branch):
//     BYTE_GATE_MODE=verify  BYTE_GATE_FILE=/abs/baseline.json \
//       npx vitest run src/platform/byte-gate.test.ts
//
// Proof obligation: same scenarios ⇒ byte-identical serialized WorldState (incl.
// rngState — the RNG-pull-reorder detector) at every checkpoint and at the end.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import { serializeWorldState } from './save.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';

const MODE = process.env.BYTE_GATE_MODE; // 'capture' | 'verify' | undefined
const FILE = process.env.BYTE_GATE_FILE ?? '';
const CHECKPOINT_EVERY = 25; // hash cadence for first-divergence localization
const PC = PLAYER_COLONY_ID as ColonyId;

// FNV-1a over a string — fast, deterministic change-detection hash (not crypto).
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashWorld(world: WorldState): string {
  return fnv1a(JSON.stringify(serializeWorldState(world)));
}

// Fixed command schedule: dig downward (diggers + descent toward the enemy grid →
// underground movement + invader/combat paths) and pivot the fight ratio — exercises
// the moved movement / dig / combat-targeting / queen clusters beyond passive
// foraging+nursing. Deterministic; no Math.random / wall-clock.
function digFightScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 2, issuedAtTick: 0 }];
  c[5] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 6, issuedAtTick: 5 }];
  c[10] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 12, issuedAtTick: 10 }];
  c[20] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 30, tileY: 18, issuedAtTick: 20 }];
  c[40] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 5, fight: 5 }, issuedAtTick: 40 },
  ];
  c[200] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 2, fight: 8 }, issuedAtTick: 200 },
  ];
  c[600] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 8, fight: 2 }, issuedAtTick: 600 },
  ];
  return c;
}

function markDigScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 10, tileY: 5, issuedAtTick: 0 }];
  c[10] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 15, tileY: 8, issuedAtTick: 10 }];
  c[30] = [{ type: 'CancelDigMark', colonyId: PC, tileX: 10, tileY: 5, issuedAtTick: 30 }];
  c[50] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 0, fight: 10 }, issuedAtTick: 50 },
  ];
  return c;
}

interface Scenario {
  name: string;
  seed: number;
  difficulty: 'Easy' | 'Normal' | 'Hard';
  ticks: number;
  commands: SimCommand[][];
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'sc42-normal-2000-digfight',
    seed: 42,
    difficulty: 'Normal',
    ticks: 2000,
    commands: digFightScript(),
  },
  {
    name: 'sc99-hard-2000-digfight',
    seed: 99,
    difficulty: 'Hard',
    ticks: 2000,
    commands: digFightScript(),
  },
  {
    name: 'sc7777-normal-1500-passive',
    seed: 7777,
    difficulty: 'Normal',
    ticks: 1500,
    commands: [],
  },
  {
    name: 'sc42-normal-150-markdig',
    seed: 42,
    difficulty: 'Normal',
    ticks: 150,
    commands: markDigScript(),
  },
];

interface ScenarioResult {
  final: string;
  checkpoints: Array<[number, string]>; // [tick, hash]
}

function runScenario(scn: Scenario): ScenarioResult {
  const world = createScenario(scn.seed, scn.difficulty);
  const checkpoints: Array<[number, string]> = [];
  for (let t = 0; t < scn.ticks; t++) {
    tick(world, scn.commands[t] ?? []);
    if ((t + 1) % CHECKPOINT_EVERY === 0) checkpoints.push([t + 1, hashWorld(world)]);
  }
  return { final: hashWorld(world), checkpoints };
}

function firstDivergentTick(a: ScenarioResult, b: ScenarioResult): number {
  const n = Math.min(a.checkpoints.length, b.checkpoints.length);
  for (let i = 0; i < n; i++) {
    if (a.checkpoints[i]![1] !== b.checkpoints[i]![1]) return a.checkpoints[i]![0];
  }
  return -1;
}

describe.skipIf(!MODE)('byte-gate: cross-build determinism (#212 split)', () => {
  it(`${MODE ?? 'skip'} ${SCENARIOS.length} scenarios`, () => {
    if (!FILE) throw new Error('BYTE_GATE_FILE env var must be an absolute path');
    const results: Record<string, ScenarioResult> = {};
    for (const scn of SCENARIOS) results[scn.name] = runScenario(scn);

    if (MODE === 'capture') {
      writeFileSync(FILE, JSON.stringify(results));
      console.log(`[byte-gate] CAPTURED ${SCENARIOS.length} baselines -> ${FILE}`);
      for (const scn of SCENARIOS) {
        console.log(`  ${scn.name}: final=${results[scn.name]!.final} (${scn.ticks} ticks)`);
      }
      return; // capture asserts nothing
    }

    // verify
    const baseline: Record<string, ScenarioResult> = JSON.parse(readFileSync(FILE, 'utf8'));
    console.log(`[byte-gate] VERIFY against baseline ${FILE}`);
    let allPass = true;
    for (const scn of SCENARIOS) {
      const got = results[scn.name]!;
      const base = baseline[scn.name];
      if (!base) {
        allPass = false;
        console.log(`  BYTE-IDENTICAL: FAIL  ${scn.name} — MISSING from baseline`);
        continue;
      }
      if (got.final === base.final) {
        console.log(`  BYTE-IDENTICAL: PASS  ${scn.name} (final=${got.final}, ${scn.ticks} ticks)`);
      } else {
        allPass = false;
        const div = firstDivergentTick(got, base);
        console.log(
          `  BYTE-IDENTICAL: FAIL  ${scn.name} — first divergent checkpoint tick=${div}; ` +
            `final got=${got.final} baseline=${base.final}`,
        );
      }
    }
    expect(allPass, 'every scenario must be byte-identical to the pre-split baseline').toBe(true);
  }, 600_000);
});
