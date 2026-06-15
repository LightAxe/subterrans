// src/sim/projection.test.ts — Stage 3a (issue #18).
//
// Sim-owned projection helper (moved out of src/render per the AGENTS.md sim/render
// boundary; Codex P1). The render layer only calls these; the mutation lives here.

import { describe, it, expect } from 'vitest';
import { projectWorld, projectionCopy } from './projection.js';
import { createScenario } from './scenario.js';
import { PLAYER_COLONY_ID } from './constants.js';
import type { SimCommand } from './commands.js';

describe('projectWorld', () => {
  it('folds a command onto dst, leaving src (the live world) untouched', () => {
    const src = createScenario(0x3a90d, 'Normal');
    const dst = createScenario(0x3a90d, 'Normal');
    const cmd: SimCommand = {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: 70,
      tileY: 60,
      issuedAtTick: 0,
    };
    projectWorld(src, [cmd], dst);
    // dst reflects the fold...
    const dstRally = dst.colonies[PLAYER_COLONY_ID]!.rallyPoint;
    expect(dstRally).not.toBeNull();
    expect(dstRally!.tileX).toBe(70);
    expect(dstRally!.tileY).toBe(60);
    // ...and src is provably never the projection target.
    expect(src.colonies[PLAYER_COLONY_ID]!.rallyPoint).toBeNull();
  });

  it('empty command list = pure clone (dst mirrors src tick; distinct object)', () => {
    const src = createScenario(0x1234, 'Normal');
    const dst = createScenario(0x9999, 'Normal'); // different seed pre-clone
    projectWorld(src, [], dst);
    expect(dst).not.toBe(src);
    expect(dst.tick).toBe(src.tick);
  });
});

describe('projectionCopy', () => {
  it('gives dst its own events array (copyWorldState omits events)', () => {
    const src = createScenario(0x3a90d, 'Normal');
    const dst = createScenario(0x1234, 'Normal');
    projectionCopy(src, dst);
    // A distinct array, so a reused projection buffer never accrues stale events across rebuilds.
    expect(dst.events).not.toBe(src.events);
    expect(dst.events.length).toBe(src.events.length);
  });
});
