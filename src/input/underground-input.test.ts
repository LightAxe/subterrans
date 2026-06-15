// underground-input.test.ts — Vitest unit tests for the Stage 1 controls-rework
// underground tap + paint handlers (issue #18).
//
// Tests cover:
//   - isTunnelEnd (pure topology helper, retained)
//   - handleUndergroundCommandTap: CancelDigMark on Marked; no-op otherwise;
//     player-grid-only guard
//   - handleUndergroundDigTap: Solid → MarkDigTile; Marked → CancelDigMark;
//     Open / BeingDug → no-op (the emit gate matches the red cue); player-grid-only
//     guard; ceiling-row guard
//   - paint stroke: beginPaintStroke + continuePaintStroke 4-connected Bresenham,
//     first-tile-once, enemy-view abort
//   - tryOpenChamberMenu: Solid/Open eligibility + anchor; Marked/BeingDug
//     excluded; enemy-view read-only
//   - paused cap across the paint producer

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isTunnelEnd,
  handleUndergroundCommandTap,
  handleUndergroundDigTap,
  beginPaintStroke,
  continuePaintStroke,
  createPaintStrokeState,
  resetPaintStrokeState,
  tryOpenChamberMenu,
  type PaintStrokeState,
} from './underground-input.js';
import { UndergroundTileState, ugSet } from '../sim/terrain.js';
import { contextMenuState, hideContextMenu } from '../render/context-menu-state.js';
import { CommandProjection } from '../render/command-projection.js';
import { CommandFeedforward } from '../render/command-feedforward.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { makeCameraView } from '../render/camera-adapter.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID, UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { MAX_COMMANDS_PER_TICK, type SimCommand } from '../sim/commands.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeViewState(
  colonyId: number = PLAYER_COLONY_ID,
  tool: 'command' | 'dig' | 'chamber' = 'dig',
): ViewState {
  return {
    activeView: 'underground',
    activeTool: tool,
    // The underground tap/paint/chamber handlers take tile coords directly and
    // never read camera fields; these CameraViews exist only to satisfy the type.
    surfaceCamera: makeCameraView(160, 160),
    undergroundCamera: makeCameraView(160, 160),
    undergroundVisited: true,
    activeUndergroundColonyId: colonyId,
    showPheromoneOverlay: true,
  };
}

// Stage 3a: the tap/menu handlers now resolve mark-vs-cancel + chamber eligibility
// against the PROJECTED world (the live world with its whole command queue folded
// through the real sim handlers), so the test world must be a REAL WorldState that
// CommandProjection.get() can clone + drain — not a hand-stubbed shape. createScenario
// gives a complete world whose player underground grid is all-Solid by default
// (the entrance shaft is carved at column 24, away from every coord these tests touch),
// which preserves the prior stub's "untouched tile reads Solid" assumption. The grid
// is a fixed 128×64 (UNDERGROUND_GRID_*), comfortably larger than every tile coord
// used below, so the old per-test gridWidth/gridHeight knobs are no longer needed.
function makeWorld(
  overrides: {
    commandQueue?: SimCommand[];
  } = {},
): WorldState {
  const world = createScenario(12345, 'Normal');
  if (overrides.commandQueue) world.commandQueue = overrides.commandQueue;
  return world;
}

/**
 * The projected world for the CURRENT queue — exactly what the gesture arbiter feeds
 * the underground tap/menu handlers (it calls deps.getProjectedWorld() per tap).
 * Empty queue → aliases `world`; a queued Mark/Cancel → a projected clone whose grid
 * reflects it. Rebuilt per call so a paused tap-tap toggle's 2nd tap sees the 1st
 * tap's queued mark folded in (drives the mark→cancel that the deleted effectiveDigState
 * used to produce).
 */
function projected(world: WorldState): WorldState {
  return new CommandProjection().get(world);
}

/**
 * A feedforward instance for a tap call. Stage 3a (Codex R2-3/4): the tap gates its
 * emit on feedforward.willTakeEffect against the PROJECTED world — the same trial-apply
 * the cue uses — so the test exercises the real emit gate (Open marks / embedded-ant
 * cancels are dropped here, not enqueued). A fresh instance per call is fine (it lazily
 * owns one scratch world; taps are rare).
 */
function ff(): CommandFeedforward {
  return new CommandFeedforward();
}

function grid(world: WorldState) {
  return world.undergroundGrids[PLAYER_COLONY_ID]!;
}
function lastCmd(world: WorldState): SimCommand | undefined {
  return world.commandQueue[world.commandQueue.length - 1];
}
function markCount(world: WorldState): number {
  return world.commandQueue.filter((c) => c.type === 'MarkDigTile').length;
}

beforeEach(() => {
  hideContextMenu();
  contextMenuState.anchorTileX = 0;
  contextMenuState.anchorTileY = 0;
});

// ---------------------------------------------------------------------------
// isTunnelEnd
// ---------------------------------------------------------------------------

describe('isTunnelEnd', () => {
  it('true for an Open tile with at least one Solid 4-neighbor', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 5, UndergroundTileState.Open); // neighbors stay Solid
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(true);
  });
  it('false for an Open tile fully surrounded by Open', () => {
    const world = makeWorld();
    const cells: Array<[number, number]> = [
      [5, 5],
      [5, 4],
      [6, 5],
      [5, 6],
      [4, 5],
    ];
    for (const [x, y] of cells) {
      ugSet(grid(world), x, y, UndergroundTileState.Open);
    }
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleUndergroundCommandTap
// ---------------------------------------------------------------------------

describe('handleUndergroundCommandTap', () => {
  it('Marked tile → CancelDigMark', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    handleUndergroundCommandTap(world, projected(world), ff(), makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('CancelDigMark');
  });
  it('Solid / Open / BeingDug → no-op', () => {
    const world = makeWorld();
    ugSet(grid(world), 6, 10, UndergroundTileState.Open);
    ugSet(grid(world), 7, 10, UndergroundTileState.BeingDug);
    handleUndergroundCommandTap(world, projected(world), ff(), makeViewState(), 5, 10, false); // Solid
    handleUndergroundCommandTap(world, projected(world), ff(), makeViewState(), 6, 10, false); // Open
    handleUndergroundCommandTap(world, projected(world), ff(), makeViewState(), 7, 10, false); // BeingDug
    expect(world.commandQueue).toHaveLength(0);
  });
  it('enemy-view read-only: no command on the enemy grid', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    handleUndergroundCommandTap(
      world,
      projected(world),
      ff(),
      makeViewState(ENEMY_COLONY_ID),
      5,
      10,
      false,
    );
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleUndergroundDigTap
// ---------------------------------------------------------------------------

describe('handleUndergroundDigTap', () => {
  it('Solid → MarkDigTile', () => {
    const world = makeWorld();
    handleUndergroundDigTap(world, projected(world), ff(), makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('MarkDigTile');
  });
  it('Open → no-op (mark no-ops on a non-Solid tile; gate matches the red cue)', () => {
    // Stage 3a (finding 2 / Codex R1-5): MarkDigTile only marks Solid tiles, so an
    // already-excavated Open tunnel tile marks nothing. The tap gates on
    // feedforward.willTakeEffect, so it must NOT enqueue the doomed command (it used
    // to, against the coarse Solid||Open predicate, while the cue painted it red).
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Open);
    handleUndergroundDigTap(world, projected(world), ff(), makeViewState(), 5, 10, false);
    expect(world.commandQueue).toHaveLength(0);
  });
  it('Marked → CancelDigMark', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    handleUndergroundDigTap(world, projected(world), ff(), makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('CancelDigMark');
  });
  it('BeingDug → no-op', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.BeingDug);
    handleUndergroundDigTap(world, projected(world), ff(), makeViewState(), 5, 10, false);
    expect(world.commandQueue).toHaveLength(0);
  });
  it('ceiling row → no-op', () => {
    const world = makeWorld();
    handleUndergroundDigTap(
      world,
      projected(world),
      ff(),
      makeViewState(),
      5,
      UNDERGROUND_CEILING_ROW_Y,
      false,
    );
    expect(world.commandQueue).toHaveLength(0);
  });
  it('enemy view → no-op', () => {
    const world = makeWorld();
    handleUndergroundDigTap(
      world,
      projected(world),
      ff(),
      makeViewState(ENEMY_COLONY_ID),
      5,
      10,
      false,
    );
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Paint stroke
// ---------------------------------------------------------------------------

describe('paint stroke', () => {
  let stroke: PaintStrokeState;
  beforeEach(() => {
    stroke = createPaintStrokeState();
  });

  it('beginPaintStroke marks the Solid down-tile once and arms the cursor', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    expect(markCount(world)).toBe(1);
    expect(stroke.active).toBe(true);
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([5, 10]);
  });

  it('a straight horizontal stroke marks each newly-entered tile (first tile once)', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, 10, false); // marks (5,10)
    continuePaintStroke(stroke, world, makeViewState(), 8, 10, false); // marks 6,7,8
    expect(markCount(world)).toBe(4);
    const marks = world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    expect(marks).toEqual([
      [5, 10],
      [6, 10],
      [7, 10],
      [8, 10],
    ]);
  });

  it('diagonal stroke stays 4-connected (Manhattan-adjacent successive tiles)', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    continuePaintStroke(stroke, world, makeViewState(), 7, 12, false);
    const marks: Array<[number, number]> = world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i]!;
      const b = marks[i - 1]!;
      const dManhattan = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      expect(dManhattan).toBe(1);
    }
  });

  it('continue is a debounce no-op when the target is the same tile', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    const before = markCount(world);
    continuePaintStroke(stroke, world, makeViewState(), 5, 10, false);
    expect(markCount(world)).toBe(before);
  });

  it('aborts (active=false) if the colony switches to enemy mid-stroke', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    const before = markCount(world);
    continuePaintStroke(stroke, world, makeViewState(ENEMY_COLONY_ID), 8, 10, false);
    expect(stroke.active).toBe(false);
    expect(markCount(world)).toBe(before); // no new marks on the enemy grid
  });

  it('does not arm a stroke on the ceiling row', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, UNDERGROUND_CEILING_ROW_Y, false);
    expect(stroke.active).toBe(false);
    expect(markCount(world)).toBe(0);
  });

  it('resetPaintStrokeState clears it in place', () => {
    const world = makeWorld();
    beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    const ref = stroke;
    resetPaintStrokeState(stroke);
    expect(stroke).toBe(ref);
    expect(stroke.active).toBe(false);
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([-1, -1]);
  });
});

// ---------------------------------------------------------------------------
// tryOpenChamberMenu
// ---------------------------------------------------------------------------

describe('tryOpenChamberMenu', () => {
  it('Solid tile → requests the menu, anchored at the tile + screen coords', () => {
    const world = makeWorld();
    const ok = tryOpenChamberMenu(world, projected(world), makeViewState(), 120, 80, 5, 10);
    expect(ok).toBe(true);
    expect(contextMenuState.pendingShow).toBe(true);
    expect([contextMenuState.anchorTileX, contextMenuState.anchorTileY]).toEqual([5, 10]);
    expect([contextMenuState.screenX, contextMenuState.screenY]).toEqual([120, 80]);
  });

  it('Open tile → eligible', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Open);
    expect(tryOpenChamberMenu(world, projected(world), makeViewState(), 120, 80, 5, 10)).toBe(true);
  });

  it('Marked tile → NOT eligible (excluded)', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    expect(tryOpenChamberMenu(world, projected(world), makeViewState(), 120, 80, 5, 10)).toBe(
      false,
    );
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('BeingDug tile → NOT eligible', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.BeingDug);
    expect(tryOpenChamberMenu(world, projected(world), makeViewState(), 120, 80, 5, 10)).toBe(
      false,
    );
  });

  it('enemy view → read-only, never opens', () => {
    const world = makeWorld();
    expect(
      tryOpenChamberMenu(world, projected(world), makeViewState(ENEMY_COLONY_ID), 120, 80, 5, 10),
    ).toBe(false);
  });

  it('ceiling row → not eligible', () => {
    const world = makeWorld();
    expect(
      tryOpenChamberMenu(
        world,
        projected(world),
        makeViewState(),
        120,
        80,
        5,
        UNDERGROUND_CEILING_ROW_Y,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paused cap (paint producer)
// ---------------------------------------------------------------------------

describe('paused-queue cap (paint)', () => {
  it('beginPaintStroke drops the mark at the cap while paused but still arms the stroke', () => {
    const pre: SimCommand[] = Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const world = makeWorld({ commandQueue: pre });
    const stroke = createPaintStrokeState();
    const dropped = beginPaintStroke(stroke, world, makeViewState(), 5, 10, true /* paused */);
    expect(dropped).toBe(true);
    expect(markCount(world)).toBe(0);
    // Stroke armed so subsequent moves still paint; the cursor is NOT advanced
    // onto the refused down-tile (Fix 2) — see the dedicated block below.
    expect(stroke.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: beginPaintStroke must NOT advance the cursor onto a markable down-tile
// whose MarkDigTile was REFUSED at the cap — it leaves the cursor at the
// sentinel so the first continuePaintStroke/flush re-emits the down-tile (no
// silently lost begin-tile). A non-markable down-tile still advances the cursor.
// ---------------------------------------------------------------------------

describe('beginPaintStroke cap-refusal holds the cursor (Fix 2)', () => {
  it('a Solid down-tile refused at the cap holds the cursor at the sentinel, re-emits after drain', () => {
    const pre: SimCommand[] = Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const world = makeWorld({ commandQueue: pre });
    const stroke = createPaintStrokeState();
    const dropped = beginPaintStroke(stroke, world, makeViewState(), 5, 10, false /* unpaused */);
    expect(dropped).toBe(true);
    expect(markCount(world)).toBe(0);
    expect(stroke.active).toBe(true);
    // Cursor NOT advanced onto the refused down-tile — held at the sentinel.
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([-1, -1]);

    // Drain the queue, then re-drive toward the SAME down-tile (what the arbiter's
    // flushPaint does). The down-tile (5,10) now enqueues and the cursor advances.
    world.commandQueue.length = 0;
    const capHit = continuePaintStroke(stroke, world, makeViewState(), 5, 10, false);
    expect(capHit).toBe(false);
    const marks = world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    expect(marks).toEqual([[5, 10]]); // the begin-tile is not lost
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([5, 10]);
  });

  it('a non-markable (BeingDug) down-tile still advances the cursor (not a loss)', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.BeingDug);
    const stroke = createPaintStrokeState();
    const dropped = beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    expect(dropped).toBe(false); // no command to defer — not a cap event
    expect(markCount(world)).toBe(0);
    expect(stroke.active).toBe(true);
    // Cursor ADVANCES so the first drag segment interpolates from the down-tile.
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([5, 10]);
  });

  it('a Solid down-tile that enqueues (queue NOT full) advances the cursor as before', () => {
    const world = makeWorld();
    const stroke = createPaintStrokeState();
    const dropped = beginPaintStroke(stroke, world, makeViewState(), 5, 10, false);
    expect(dropped).toBe(false);
    expect(markCount(world)).toBe(1);
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([5, 10]);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: paused dig/command taps resolve the EFFECTIVE tile state against
// PENDING queued commands (not just the frozen grid), so a paused tap-tap
// toggles correctly instead of double-marking / double-cancelling. The sim is
// frozen while bare-user-paused, so ugGet alone would read stale state.
// ---------------------------------------------------------------------------

describe('paused dig-tap effective state (Fix 4)', () => {
  it('paused tap-tap on a Solid tile → MarkDigTile then CancelDigMark (not two marks)', () => {
    const world = makeWorld();
    const vs = makeViewState();
    // First tap: Solid → MarkDigTile (grid stays Solid; sim is paused/frozen).
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true);
    // Second tap on the SAME tile: the REBUILT projection folds the pending
    // MarkDigTile, so the tile reads Marked → CancelDigMark, netting back to Solid
    // on resume. (projected() reads the live queue each call.)
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true);
    const types = world.commandQueue.map((c) => c.type);
    expect(types).toEqual(['MarkDigTile', 'CancelDigMark']);
  });

  it('paused tap-tap-tap on a Solid tile nets Mark/Cancel/Mark (toggles each tap)', () => {
    const world = makeWorld();
    const vs = makeViewState();
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true); // Solid → Mark
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true); // proj Marked → Cancel
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true); // proj Solid → Mark
    expect(world.commandQueue.map((c) => c.type)).toEqual([
      'MarkDigTile',
      'CancelDigMark',
      'MarkDigTile',
    ]);
  });

  it('paused tap-tap on a Marked tile → CancelDigMark then MarkDigTile (nets correctly)', () => {
    const world = makeWorld();
    const vs = makeViewState();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked); // grid already Marked
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true); // Marked → Cancel
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true); // proj Solid (pending cancel) → Mark
    expect(world.commandQueue.map((c) => c.type)).toEqual(['CancelDigMark', 'MarkDigTile']);
  });

  it('the effective state is keyed per-tile: a tap on a different tile is unaffected', () => {
    const world = makeWorld();
    const vs = makeViewState();
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, true); // (5,10) Solid → Mark
    handleUndergroundDigTap(world, projected(world), ff(), vs, 6, 10, true); // (6,10) Solid → Mark (different tile)
    expect(world.commandQueue.map((c) => c.type)).toEqual(['MarkDigTile', 'MarkDigTile']);
  });

  it('unpaused behaviour is unchanged: each tap reads the live (drained) grid', () => {
    // Unpaused, the queue drains every tick, so a second tap sees an empty queue
    // (projection aliases the live world) and the (still-Solid, pre-apply) grid →
    // another MarkDigTile, exactly as before Fix 4. We emulate the drain between taps.
    const world = makeWorld();
    const vs = makeViewState();
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, false);
    expect(world.commandQueue.map((c) => c.type)).toEqual(['MarkDigTile']);
    world.commandQueue.length = 0; // tick() drained it
    handleUndergroundDigTap(world, projected(world), ff(), vs, 5, 10, false);
    expect(world.commandQueue.map((c) => c.type)).toEqual(['MarkDigTile']);
  });

  it('Command-tap respects a pending MarkDigTile (effectively Marked → CancelDigMark)', () => {
    const world = makeWorld();
    const vs = makeViewState(PLAYER_COLONY_ID, 'command');
    // A Dig-tap queued a MarkDigTile on a Solid tile while paused; the grid is
    // still Solid. A Command-tap on it must see the PROJECTED tile = Marked and cancel.
    handleUndergroundDigTap(world, projected(world), ff(), makeViewState(), 5, 10, true); // queue: MarkDigTile
    handleUndergroundCommandTap(world, projected(world), ff(), vs, 5, 10, true);
    expect(world.commandQueue.map((c) => c.type)).toEqual(['MarkDigTile', 'CancelDigMark']);
  });

  it('Command-tap does NOT double-cancel when a CancelDigMark is already pending', () => {
    const world = makeWorld();
    const vs = makeViewState(PLAYER_COLONY_ID, 'command');
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked); // grid Marked
    handleUndergroundCommandTap(world, projected(world), ff(), vs, 5, 10, true); // Marked → Cancel
    // Second Command-tap: the projected tile is Solid (pending cancel) → no-op, NOT
    // a redundant second CancelDigMark.
    handleUndergroundCommandTap(world, projected(world), ff(), vs, 5, 10, true);
    expect(world.commandQueue.map((c) => c.type)).toEqual(['CancelDigMark']);
  });
});

// ---------------------------------------------------------------------------
// Fast-stroke cap deferral (Fix 1): the cap is enforced UNPAUSED too, and the
// stroke cursor HOLDS at the last enqueued tile on a cap refusal so the
// remainder re-emits later with NO lost tiles. Non-markable skips still advance.
// ---------------------------------------------------------------------------

describe('fast-stroke cap deferral (unpaused)', () => {
  it('a single >64-tile segment enqueues exactly the cap and HOLDS the cursor', () => {
    const world = makeWorld();
    const stroke = createPaintStrokeState();
    // Begin at (0,10): one mark for the down-tile.
    beginPaintStroke(stroke, world, makeViewState(), 0, 10, false);
    expect(markCount(world)).toBe(1);
    // One fast move spanning 80 new tiles (x=1..80). The queue holds 1 mark, so
    // 63 more fit before the cap → 64 total enqueued, the rest deferred.
    const capHit = continuePaintStroke(stroke, world, makeViewState(), 80, 10, false);
    expect(capHit).toBe(true);
    expect(markCount(world)).toBe(MAX_COMMANDS_PER_TICK); // exactly the cap
    // Cursor HELD at the last successfully-enqueued tile, NOT advanced to 80.
    // 1 (begin) + 63 (continue) = 64 marks → last enqueued tile is x=63.
    expect(stroke.lastMarkedTileX).toBe(63);
    expect(stroke.lastMarkedTileY).toBe(10);
  });

  it('the deferred remainder re-emits on a subsequent flush with NO lost tiles', () => {
    const world = makeWorld();
    const stroke = createPaintStrokeState();
    beginPaintStroke(stroke, world, makeViewState(), 0, 10, false);
    continuePaintStroke(stroke, world, makeViewState(), 80, 10, false); // caps at 64, holds at 63
    // Collect the first batch's tiles, then simulate tick() draining the queue.
    const firstBatch = world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => (c as { tileX: number }).tileX);
    world.commandQueue.length = 0; // drain
    // Re-drive toward the SAME target (what flushPaint does each frame).
    const capHit2 = continuePaintStroke(stroke, world, makeViewState(), 80, 10, false);
    expect(capHit2).toBe(false); // remainder (16 tiles) fits now
    const secondBatch = world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => (c as { tileX: number }).tileX);
    // Cursor finally reaches the target.
    expect(stroke.lastMarkedTileX).toBe(80);
    // Union of both batches covers x=0..80 contiguously — no lost tiles, no dupes.
    const allX = [...firstBatch, ...secondBatch].sort((a, b) => a - b);
    const expected = Array.from({ length: 81 }, (_, i) => i); // 0..80
    expect(allX).toEqual(expected);
  });

  it('a further flush once the cursor has reached the target is a debounce no-op', () => {
    const world = makeWorld();
    const stroke = createPaintStrokeState();
    beginPaintStroke(stroke, world, makeViewState(), 0, 10, false);
    continuePaintStroke(stroke, world, makeViewState(), 80, 10, false);
    world.commandQueue.length = 0;
    continuePaintStroke(stroke, world, makeViewState(), 80, 10, false); // reaches 80
    const before = markCount(world);
    const capHit = continuePaintStroke(stroke, world, makeViewState(), 80, 10, false); // same tile
    expect(capHit).toBe(false);
    expect(markCount(world)).toBe(before); // no new marks
  });

  it('non-markable (BeingDug) tiles are SKIPPED but the cursor ADVANCES past them', () => {
    const world = makeWorld();
    ugSet(grid(world), 3, 10, UndergroundTileState.BeingDug); // a hole in the row
    const stroke = createPaintStrokeState();
    beginPaintStroke(stroke, world, makeViewState(), 0, 10, false); // mark (0,10)
    const capHit = continuePaintStroke(stroke, world, makeViewState(), 6, 10, false);
    // Not a cap event — BeingDug is a silent skip, not a deferral.
    expect(capHit).toBe(false);
    const marks = world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => (c as { tileX: number }).tileX);
    expect(marks).toEqual([0, 1, 2, 4, 5, 6]); // 3 skipped, rest marked
    // Cursor advanced all the way to the target despite the skip.
    expect(stroke.lastMarkedTileX).toBe(6);
    expect(stroke.lastMarkedTileY).toBe(10);
  });

  it('the sentinel single-tile path HOLDS the cursor at the sentinel on a cap refusal', () => {
    // No prior cursor (lastMarkedTile = -1): the single-tile branch. A cap
    // refusal must NOT advance the sentinel, so the tile re-emits next flush.
    const pre: SimCommand[] = Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const world = makeWorld({ commandQueue: pre });
    const stroke = createPaintStrokeState();
    stroke.active = true; // armed but no cursor recorded yet (sentinel)
    const capHit = continuePaintStroke(stroke, world, makeViewState(), 5, 10, false /* unpaused */);
    expect(capHit).toBe(true);
    expect(markCount(world)).toBe(0);
    expect(stroke.lastMarkedTileX).toBe(-1); // sentinel held
    expect(stroke.lastMarkedTileY).toBe(-1);
    // Drain and retry: now it enqueues and advances.
    world.commandQueue.length = 0;
    const capHit2 = continuePaintStroke(stroke, world, makeViewState(), 5, 10, false);
    expect(capHit2).toBe(false);
    expect(markCount(world)).toBe(1);
    expect([stroke.lastMarkedTileX, stroke.lastMarkedTileY]).toEqual([5, 10]);
  });
});
