// src/render/command-projection.test.ts — Stage 3a (issue #18).

import { describe, it, expect } from 'vitest';
import { CommandProjection } from './command-projection.js';
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

describe('CommandProjection', () => {
  it('aliases the live world when the queue is empty (zero clone)', () => {
    const w = world();
    const proj = new CommandProjection();
    expect(proj.get(w)).toBe(w); // same object reference
  });

  it('folds queued commands into the projection without mutating the live world', () => {
    const w = world();
    const grid = w.undergroundGrids[PLAYER_COLONY_ID]!;
    expect(ugGet(grid, 20, 20)).toBe(UndergroundTileState.Solid);

    w.commandQueue.push(mark(20, 20));
    const proj = new CommandProjection();
    const projected = proj.get(w);

    // Projection reflects the queued mark…
    expect(ugGet(projected.undergroundGrids[PLAYER_COLONY_ID]!, 20, 20)).toBe(
      UndergroundTileState.Marked,
    );
    // …but the live world is untouched (still Solid, queue intact).
    expect(ugGet(grid, 20, 20)).toBe(UndergroundTileState.Solid);
    expect(w.commandQueue.length).toBe(1);
    expect(projected).not.toBe(w);
  });

  it('memoizes within the same (identity, tick, queue length); revision is stable', () => {
    const w = world();
    w.commandQueue.push(mark(21, 21));
    const proj = new CommandProjection();
    const a = proj.get(w);
    const r = proj.revision;
    const b = proj.get(w);
    expect(b).toBe(a); // memoized — same buffer, no rebuild
    expect(proj.revision).toBe(r); // revision stable across no-change calls
  });

  it('revision bumps when the queue grows (paused enqueue)', () => {
    const w = world();
    const proj = new CommandProjection();
    proj.get(w); // empty alias
    const r0 = proj.revision;
    w.commandQueue.push(mark(22, 22));
    proj.get(w);
    expect(proj.revision).toBeGreaterThan(r0);
  });

  it('completes the whole queue (an enemy-colony command is folded too)', () => {
    const w = world();
    // A second player mark + a clear-rally for the enemy: both fold; projection is exact.
    w.commandQueue.push(mark(23, 23));
    w.commandQueue.push({ type: 'ClearRallyPoint', colonyId: 2, issuedAtTick: 0 });
    const proj = new CommandProjection();
    const projected = proj.get(w);
    expect(ugGet(projected.undergroundGrids[PLAYER_COLONY_ID]!, 23, 23)).toBe(
      UndergroundTileState.Marked,
    );
  });
});
