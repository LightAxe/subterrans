// underground-input.test.ts — Vitest unit tests for the Stage 1 controls-rework
// underground tap + paint handlers (issue #18).
//
// Tests cover:
//   - isTunnelEnd (pure topology helper, retained)
//   - handleUndergroundCommandTap: CancelDigMark on Marked; no-op otherwise;
//     player-grid-only guard
//   - handleUndergroundDigTap: Solid/Open → MarkDigTile; Marked → CancelDigMark;
//     BeingDug → no-op; player-grid-only guard; ceiling-row guard
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
import { UndergroundTileState, ugSet, createUndergroundGrid } from '../sim/terrain.js';
import { contextMenuState, hideContextMenu } from '../render/context-menu-state.js';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES } from '../render/camera.js';
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
    surfaceCamera: {
      x: 10,
      y: 10,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundCamera: {
      x: 10,
      y: 10,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundVisited: true,
    activeUndergroundColonyId: colonyId,
    showPheromoneOverlay: true,
  };
}

function makeWorld(
  overrides: {
    tick?: number;
    gridWidth?: number;
    gridHeight?: number;
    commandQueue?: SimCommand[];
  } = {},
): WorldState {
  const w = overrides.gridWidth ?? 20;
  const h = overrides.gridHeight ?? 20;
  const grid = createUndergroundGrid(w, h);
  return {
    tick: overrides.tick ?? 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: overrides.commandQueue ?? ([] as SimCommand[]),
    ants: {} as WorldState['ants'],
    colonies: {},
    pheromoneGrids: {},
    surface: { data: new Uint8Array(0), width: 0, height: 0 },
    undergroundGrids: { [PLAYER_COLONY_ID]: grid },
    foodPiles: [],
    pendingChambers: {},
  } as unknown as WorldState;
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
    handleUndergroundCommandTap(world, makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('CancelDigMark');
  });
  it('Solid / Open / BeingDug → no-op', () => {
    const world = makeWorld();
    ugSet(grid(world), 6, 10, UndergroundTileState.Open);
    ugSet(grid(world), 7, 10, UndergroundTileState.BeingDug);
    handleUndergroundCommandTap(world, makeViewState(), 5, 10, false); // Solid
    handleUndergroundCommandTap(world, makeViewState(), 6, 10, false); // Open
    handleUndergroundCommandTap(world, makeViewState(), 7, 10, false); // BeingDug
    expect(world.commandQueue).toHaveLength(0);
  });
  it('enemy-view read-only: no command on the enemy grid', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    handleUndergroundCommandTap(world, makeViewState(ENEMY_COLONY_ID), 5, 10, false);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleUndergroundDigTap
// ---------------------------------------------------------------------------

describe('handleUndergroundDigTap', () => {
  it('Solid → MarkDigTile', () => {
    const world = makeWorld();
    handleUndergroundDigTap(world, makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('MarkDigTile');
  });
  it('Open → MarkDigTile', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Open);
    handleUndergroundDigTap(world, makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('MarkDigTile');
  });
  it('Marked → CancelDigMark', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    handleUndergroundDigTap(world, makeViewState(), 5, 10, false);
    expect((lastCmd(world) as { type: string }).type).toBe('CancelDigMark');
  });
  it('BeingDug → no-op', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.BeingDug);
    handleUndergroundDigTap(world, makeViewState(), 5, 10, false);
    expect(world.commandQueue).toHaveLength(0);
  });
  it('ceiling row → no-op', () => {
    const world = makeWorld();
    handleUndergroundDigTap(world, makeViewState(), 5, UNDERGROUND_CEILING_ROW_Y, false);
    expect(world.commandQueue).toHaveLength(0);
  });
  it('enemy view → no-op', () => {
    const world = makeWorld();
    handleUndergroundDigTap(world, makeViewState(ENEMY_COLONY_ID), 5, 10, false);
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
    const ok = tryOpenChamberMenu(world, makeViewState(), 120, 80, 5, 10);
    expect(ok).toBe(true);
    expect(contextMenuState.pendingShow).toBe(true);
    expect([contextMenuState.anchorTileX, contextMenuState.anchorTileY]).toEqual([5, 10]);
    expect([contextMenuState.screenX, contextMenuState.screenY]).toEqual([120, 80]);
  });

  it('Open tile → eligible', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Open);
    expect(tryOpenChamberMenu(world, makeViewState(), 120, 80, 5, 10)).toBe(true);
  });

  it('Marked tile → NOT eligible (excluded)', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.Marked);
    expect(tryOpenChamberMenu(world, makeViewState(), 120, 80, 5, 10)).toBe(false);
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('BeingDug tile → NOT eligible', () => {
    const world = makeWorld();
    ugSet(grid(world), 5, 10, UndergroundTileState.BeingDug);
    expect(tryOpenChamberMenu(world, makeViewState(), 120, 80, 5, 10)).toBe(false);
  });

  it('enemy view → read-only, never opens', () => {
    const world = makeWorld();
    expect(tryOpenChamberMenu(world, makeViewState(ENEMY_COLONY_ID), 120, 80, 5, 10)).toBe(false);
  });

  it('ceiling row → not eligible', () => {
    const world = makeWorld();
    expect(tryOpenChamberMenu(world, makeViewState(), 120, 80, 5, UNDERGROUND_CEILING_ROW_Y)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Paused cap (paint producer)
// ---------------------------------------------------------------------------

describe('paused-queue cap (paint)', () => {
  it('beginPaintStroke drops the mark at the cap while paused but still arms the cursor', () => {
    const pre: SimCommand[] = Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => ({
      type: 'NoOp',
      issuedAtTick: i,
    }));
    const world = makeWorld({ commandQueue: pre });
    const stroke = createPaintStrokeState();
    const dropped = beginPaintStroke(stroke, world, makeViewState(), 5, 10, true /* paused */);
    expect(dropped).toBe(true);
    expect(markCount(world)).toBe(0);
    // Cursor still armed so the gesture is coherent on resume.
    expect(stroke.active).toBe(true);
  });
});
