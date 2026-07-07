// #231 — per-world scratch arena: interleave proof.
//
// The migration's purpose is that two worlds ticking in one process no longer
// share scratch buffers. This test drives two worlds ALTERNATELY (A, B, A, B …)
// and asserts each matches its own SOLO run — the property Phase 6 (background/
// replay sim in a worker) and Phase 7 (rollback resim interleaved with the live
// world) depend on. A future regression that reverts a buffer to module scope AND
// lets it carry cross-tick state would diverge here; the byte-gate (env-gated)
// separately proves the migration is byte-identical to the pre-#231 tree.
import { describe, it, expect, beforeEach } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { resetScratchArenas } from './scratch.js';
import { PLAYER_COLONY_ID } from './constants.js';
import type { ColonyId } from './colony/colony-store.js';
import type { SimCommand } from './commands.js';
// eslint-disable-next-line no-restricted-imports -- interleave proof needs the platform serializer to compare full world state (telemetry.test.ts:8 pattern)
import { serializeWorldState } from '../platform/save.js';

const PC = PLAYER_COLONY_ID as ColonyId;

// Dig + descent + fight-ratio pivot — exercises the migrated combat sweep,
// invader-BFS, occupancy, idle, spider-hunt, and motion out-param buffers.
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

const TICKS = 300;

function serialize(world: ReturnType<typeof createScenario>): string {
  return JSON.stringify(serializeWorldState(world));
}

function runSolo(seed: number): string {
  const world = createScenario(seed);
  const script = cannedScript();
  for (let t = 0; t < TICKS; t++) tick(world, script[t] ?? []);
  return serialize(world);
}

describe('per-world scratch arena (#231) — interleave safety', () => {
  beforeEach(() => {
    resetScratchArenas();
  });

  it('interleaved A,B,A,B… ticking of two worlds equals each world ticked solo', () => {
    const SEED_A = 1337;
    const SEED_B = 4242;

    // Solo baselines (each world ticked alone, start to finish).
    const soloA = runSolo(SEED_A);
    const soloB = runSolo(SEED_B);

    // Interleaved: both worlds live at once, ticked alternately.
    resetScratchArenas();
    const worldA = createScenario(SEED_A);
    const worldB = createScenario(SEED_B);
    const script = cannedScript();
    for (let t = 0; t < TICKS; t++) {
      tick(worldA, script[t] ?? []);
      tick(worldB, script[t] ?? []);
    }

    expect(serialize(worldA)).toBe(soloA);
    expect(serialize(worldB)).toBe(soloB);
  });

  it('a fresh world gets an independent arena (no state carried from a prior world)', () => {
    const soloA = runSolo(1337);
    // Tick a DIFFERENT world first, then run A — A must still match its solo run.
    resetScratchArenas();
    const decoy = createScenario(999);
    const script = cannedScript();
    for (let t = 0; t < TICKS; t++) tick(decoy, script[t] ?? []);
    const worldA = createScenario(1337);
    for (let t = 0; t < TICKS; t++) tick(worldA, script[t] ?? []);
    expect(serialize(worldA)).toBe(soloA);
  });
});
