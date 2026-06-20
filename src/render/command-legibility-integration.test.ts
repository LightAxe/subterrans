// src/render/command-legibility-integration.test.ts — Stage 3a §E (issue #18).
//
// Cross-module integration proofs the unit suites don't cover: render-only PURITY
// (Codex R1-15 — the projection/feedforward/ghost path never mutates the committed
// world or its queue) and LAZY FRESHNESS (Codex R3-5 — getProjectedWorld re-checks on
// every access, so same-frame sequential reads see up-to-date state).

import { describe, it, expect } from 'vitest';
import { CommandProjection } from './command-projection.js';
import { CommandFeedforward } from './command-feedforward.js';
import { computeGhostDelta } from './command-ghosts.js';
import { serializeWorldState } from '../platform/save.js';
import { createScenario } from '../sim/scenario.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import type { SimCommand } from '../sim/commands.js';
import type { WorldState } from '../sim/types.js';

function world(): WorldState {
  return createScenario(0x3a90d, 'Normal');
}
const mark = (tileX: number, tileY: number): SimCommand => ({
  type: 'MarkDigTile',
  colonyId: PLAYER_COLONY_ID,
  tileX,
  tileY,
  issuedAtTick: 0,
});

/** Full committed-world fingerprint incl. events (which serializeWorldState omits). */
function fingerprint(w: WorldState): string {
  return JSON.stringify({ s: serializeWorldState(w), events: w.events });
}

describe('command-legibility integration (§E)', () => {
  it('PURITY — projection + feedforward + ghosts never mutate the committed world or queue', () => {
    const w = world();
    w.commandQueue.push(mark(20, 20), mark(21, 21));
    const before = fingerprint(w);
    const queueRef = w.commandQueue;
    const queueLen = w.commandQueue.length;

    const proj = new CommandProjection();
    const projected = proj.get(w);
    new CommandFeedforward().outcome(projected, mark(22, 22), 2, proj.revision);
    computeGhostDelta(w, projected);
    // a second projection/feedforward cycle for good measure
    new CommandFeedforward().outcome(proj.get(w), mark(20, 20), 2, proj.revision);

    expect(fingerprint(w)).toBe(before); // committed world + events unchanged
    expect(w.commandQueue).toBe(queueRef); // same array identity
    expect(w.commandQueue.length).toBe(queueLen); // same contents length
  });

  it('LAZY FRESHNESS — two accesses in one frame reflect a queue change between them', () => {
    const w = world();
    const proj = new CommandProjection();
    // Access 1: empty queue → aliases the live world.
    expect(proj.get(w)).toBe(w);
    // A tap enqueues a mark mid-frame (input events fire outside the frame update).
    w.commandQueue.push(mark(25, 25));
    // Access 2 (same frame): must see the fresh projection, not a stale alias.
    const p2 = proj.get(w);
    expect(p2).not.toBe(w);
    expect(ugGet(p2.undergroundGrids[PLAYER_COLONY_ID]!, 25, 25)).toBe(UndergroundTileState.Marked);
  });
});
