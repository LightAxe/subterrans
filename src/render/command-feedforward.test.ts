// src/render/command-feedforward.test.ts — Stage 3a (issue #18).

import { describe, it, expect } from 'vitest';
import { CommandFeedforward } from './command-feedforward.js';
import { CommandProjection } from './command-projection.js';
import { createScenario } from '../sim/scenario.js';
import { PLAYER_COLONY_ID, UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { ChamberType, AntTask } from '../sim/enums.js';
import { MAX_COMMANDS_PER_TICK } from '../sim/commands.js';
import { UndergroundTileState, ugSet, Zone } from '../sim/terrain.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import { allocateEntityId } from '../sim/types.js';
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
const cancel = (tileX: number, tileY: number): SimCommand => ({
  type: 'CancelDigMark',
  colonyId: PLAYER_COLONY_ID,
  tileX,
  tileY,
  issuedAtTick: 0,
});

describe('CommandFeedforward.outcome (trial-apply)', () => {
  it('valid — marking a fresh Solid tile takes effect', () => {
    const w = world();
    const ff = new CommandFeedforward();
    expect(ff.outcome(w, mark(20, 20), 0, 0)).toBe('valid');
  });

  it('invalid — ceiling row and out-of-bounds are geometrically rejected', () => {
    const w = world();
    const ff = new CommandFeedforward();
    expect(ff.outcome(w, mark(30, UNDERGROUND_CEILING_ROW_Y), 0, 0)).toBe('invalid');
    expect(ff.outcome(w, mark(-5, 10), 0, 0)).toBe('invalid');
  });

  it('invalid — NO false green against your OWN pending queue (Codex R1-2)', () => {
    const w = world();
    // Pending: a queued MarkDigTile already marks (25,25) in the projection.
    w.commandQueue.push(mark(25, 25));
    const proj = new CommandProjection();
    const projected = proj.get(w);
    const ff = new CommandFeedforward();
    // Aiming another mark at the SAME tile must read invalid — it's already Marked
    // in the projected world, so committing it is a no-op (no false green).
    expect(ff.outcome(projected, mark(25, 25), 1, proj.revision)).toBe('invalid');
    // …while a different fresh tile is still valid against that same projection.
    expect(ff.outcome(projected, mark(26, 26), 1, proj.revision)).toBe('valid');
  });

  it('blocked — geometrically valid but the live non-Sync queue is at the cap', () => {
    const w = world();
    const ff = new CommandFeedforward();
    expect(ff.outcome(w, mark(40, 40), MAX_COMMANDS_PER_TICK, 0)).toBe('blocked');
    // one slot free → valid again
    expect(ff.outcome(w, mark(41, 41), MAX_COMMANDS_PER_TICK - 1, 0)).toBe('valid');
  });

  it('invalid — chamber with no reachable entrance is rejected', () => {
    const w = world();
    const ff = new CommandFeedforward();
    const place: SimCommand = {
      type: 'PlaceChamber',
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.Nursery,
      anchorTileX: 30,
      anchorTileY: 30,
      issuedAtTick: 0,
    } as SimCommand;
    expect(ff.outcome(w, place, 0, 0)).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// willTakeEffect — the input layer's emit gate (Codex R2-3/4). It MUST agree with
// outcome()'s validity so the cue and the emitted command can never disagree.
// ---------------------------------------------------------------------------

/**
 * Place an alive Underground ant in the PLAYER grid at (tileX,tileY) via the sanctioned
 * sim helper (initAnt sets alive=1, zone, currentGridColonyId=colonyId, task, pos). A
 * Digging task still blocks a Marked→Solid revert (any ant embeds on →Solid).
 */
function placeUndergroundAnt(w: WorldState, tileX: number, tileY: number): number {
  const id = allocateEntityId(w);
  initAnt(w.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Digging,
    zone: Zone.Underground,
  });
  return id;
}

describe('CommandFeedforward.willTakeEffect (input emit gate)', () => {
  it('MarkDigTile on a fresh Solid tile takes effect (and outcome is valid)', () => {
    const w = world();
    const ff = new CommandFeedforward();
    expect(ff.willTakeEffect(w, mark(20, 20))).toBe(true);
    expect(ff.outcome(w, mark(20, 20), 0, 0)).toBe('valid');
  });

  it('MarkDigTile on an Open tunnel tile does NOT take effect (finding 2 — cue is red)', () => {
    const w = world();
    ugSet(w.undergroundGrids[PLAYER_COLONY_ID]!, 21, 21, UndergroundTileState.Open);
    const ff = new CommandFeedforward();
    // Mark no-ops on non-Solid (Codex R1-5) — the input must not enqueue it…
    expect(ff.willTakeEffect(w, mark(21, 21))).toBe(false);
    // …and the cue paints it invalid (red): gate and cue agree.
    expect(ff.outcome(w, mark(21, 21), 0, 0)).toBe('invalid');
  });

  it('CancelDigMark on a plain Marked tile takes effect (and outcome is valid)', () => {
    const w = world();
    ugSet(w.undergroundGrids[PLAYER_COLONY_ID]!, 22, 22, UndergroundTileState.Marked);
    const ff = new CommandFeedforward();
    expect(ff.willTakeEffect(w, cancel(22, 22))).toBe(true);
    expect(ff.outcome(w, cancel(22, 22), 0, 0)).toBe('valid');
  });

  it('CancelDigMark on a Marked tile under an embedded ant does NOT take effect (finding 1 — cue is red)', () => {
    const w = world();
    ugSet(w.undergroundGrids[PLAYER_COLONY_ID]!, 23, 23, UndergroundTileState.Marked);
    placeUndergroundAnt(w, 23, 23); // an ant legitimately stands on the Marked tile
    const ff = new CommandFeedforward();
    // The sim CancelDigMark handler BLOCKS the Marked→Solid revert (the ant would
    // embed), so committing it is a no-op — the input must not enqueue it…
    expect(ff.willTakeEffect(w, cancel(23, 23))).toBe(false);
    // …and the cue paints it invalid (red): gate and cue agree.
    expect(ff.outcome(w, cancel(23, 23), 0, 0)).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// outcome() memoization (finding 3) — no world deep-clone when (revision, tick,
// candidate) are unchanged; busts on a tick change so it never serves stale state.
// ---------------------------------------------------------------------------

describe('CommandFeedforward.outcome memoization', () => {
  it('reuses the cached trial-apply across identical (revision, tick, candidate) calls', () => {
    const w = world();
    const ff = new CommandFeedforward();
    // Prime the memo: (24,24) is Solid → valid, cached at revision 7 / tick 0.
    expect(ff.outcome(w, mark(24, 24), 0, 7)).toBe('valid');
    // Mutate the underlying grid to Open WITHOUT advancing tick or revision: a
    // re-clone would now read 'invalid', but the memo must serve the cached 'valid'.
    ugSet(w.undergroundGrids[PLAYER_COLONY_ID]!, 24, 24, UndergroundTileState.Open);
    expect(ff.outcome(w, mark(24, 24), 0, 7)).toBe('valid'); // cached (no re-clone)
  });

  it('busts the memo when projection.tick changes (empty-queue alias mutates per tick)', () => {
    const w = world();
    const ff = new CommandFeedforward();
    expect(ff.outcome(w, mark(25, 25), 0, 7)).toBe('valid'); // Solid → valid @ tick 0
    // The world advances a tick and that tile is now Open (an ant dug it): revision
    // is unchanged (empty-queue alias), but tick moved, so the memo must recompute.
    // Spread a next-tick view (shares the grid refs, so the ugSet below is visible) —
    // the STATE.md FNDN-07 avoidance for a render-layer `world.tick = N` write.
    ugSet(w.undergroundGrids[PLAYER_COLONY_ID]!, 25, 25, UndergroundTileState.Open);
    const wNext = { ...w, tick: w.tick + 1 } as unknown as WorldState;
    expect(ff.outcome(wNext, mark(25, 25), 0, 7)).toBe('invalid'); // recomputed
  });
});
