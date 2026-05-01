// underground-input.test.ts — Vitest unit tests for src/input/underground-input.ts
//
// Tests cover pure dispatch logic only.
// Phaser scene integration (registerUndergroundInput) is verified by Plan 07 Playwright smoke test.
//
// Key invariants:
//   - isTunnelEnd: Open + at least one Solid 4-neighbor → true.
//   - Left-click on Solid/Open tile → MarkDigTileCommand; Marked/BeingDug → no command.
//   - Drag debounce: only new tile coordinates emit commands.
//   - Right-click on Marked → CancelDigMarkCommand (CTRL-04: BeingDug NOT cancellable).
//   - Right-click on Open tunnel-end → contextMenuState.visible=true.
//   - Right-click on BeingDug → no state change.
//   - contextMenuState reset between tests using hideContextMenu().
//
// UndergroundTileState values (terrain.ts): Solid=0, Marked=1, BeingDug=2, Open=3

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isTunnelEnd,
  handleUndergroundLeftClick,
  handleUndergroundDrag,
  handleUndergroundRightClick,
  resetUndergroundInputState,
  type UndergroundInputState,
} from './underground-input.js';
import {
  contextMenuState,
  hideContextMenu,
  applyPendingContextMenuShow,
} from '../render/context-menu-state.js';
import { panInputState, resetPanInputStateForTests } from './camera-input.js';
import { UndergroundTileState, ugSet, createUndergroundGrid } from '../sim/terrain.js';
import type { WorldState } from '../sim/types.js';
import {
  LEGACY_SIM_VERSION,
  SIM_VERSION_V5_CHAMBER_ON_MARKED,
} from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES } from '../render/camera.js';
import { HUD, TILE_SIZE_PX } from '../render/sprites.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import type { SimCommand } from '../sim/commands.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ViewState for tests. */
function makeViewState(
  view: 'surface' | 'underground' = 'underground',
  camX = 64,
  camY = 32,
): ViewState {
  return {
    activeView: view,
    surfaceCamera: { x: camX, y: camY, viewportWidth: VIEWPORT_WIDTH_TILES, viewportHeight: VIEWPORT_HEIGHT_TILES },
    undergroundCamera: { x: camX, y: camY, viewportWidth: VIEWPORT_WIDTH_TILES, viewportHeight: VIEWPORT_HEIGHT_TILES },
    undergroundVisited: true,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
  };
}

/**
 * Convert tile coords to screen pixel coords for the underground camera.
 * Mirrors the renderer's integer-tile snap so tests hit the pixel the player
 * sees the tile at.
 */
function tileToScreen(tileX: number, tileY: number, camX: number, camY: number): { x: number; y: number } {
  const left = Math.floor(camX - VIEWPORT_WIDTH_TILES / 2);
  const top = Math.floor(camY - VIEWPORT_HEIGHT_TILES / 2);
  const px = (tileX - left) * TILE_SIZE_PX;
  const py = (tileY - top) * TILE_SIZE_PX;
  return { x: px, y: py };
}

/**
 * Build a WorldState stub with a single underground grid for PLAYER_COLONY_ID.
 * gridWidth/gridHeight default to 20x20 for test convenience.
 */
function makeWorld(overrides: {
  tick?: number;
  gridWidth?: number;
  gridHeight?: number;
} = {}): WorldState {
  const w = overrides.gridWidth ?? 20;
  const h = overrides.gridHeight ?? 20;
  const grid = createUndergroundGrid(w, h);
  return {
    tick: overrides.tick ?? 0,
    // Default to LEGACY so existing right-click-on-Solid is-a-no-op tests
    // pass. Issue #38 v5+ tests set simVersion explicitly.
    simVersion: LEGACY_SIM_VERSION,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: [] as SimCommand[],
    ants: { posX: new Int32Array(0), posY: new Int32Array(0), colonyId: new Int32Array(0), task: new Int32Array(0), subTask: new Int32Array(0), speed: new Int32Array(0), foodCarrying: new Int32Array(0), starvationTimer: new Int32Array(0), age: new Int32Array(0), alive: new Int32Array(0), lifespan: new Int32Array(0), zone: new Int32Array(0), digTileX: new Int32Array(0), digTileY: new Int32Array(0), digTicksRemaining: new Int32Array(0), targetPosX: new Int32Array(0), targetPosY: new Int32Array(0) },
    colonies: {},
    pheromoneGrids: {},
    surface: { data: new Uint8Array(0), width: 0, height: 0 },
    undergroundGrids: { [PLAYER_COLONY_ID]: grid },
    foodPiles: [],
    pendingChambers: {},
  } as unknown as WorldState;
}

/** UndergroundInputState equivalent (the private interface in underground-input.ts). */
function makeState(isDragging = false, lastX = -1, lastY = -1) {
  return { isDragging, lastMarkedTileX: lastX, lastMarkedTileY: lastY };
}

// ---------------------------------------------------------------------------
// Reset contextMenuState singleton between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // hideContextMenu clears visible + pendingHide + pendingShow.
  hideContextMenu();
  contextMenuState.screenX = 0;
  contextMenuState.screenY = 0;
  contextMenuState.anchorTileX = 0;
  contextMenuState.anchorTileY = 0;
  resetPanInputStateForTests();
});

// ---------------------------------------------------------------------------
// isTunnelEnd
// ---------------------------------------------------------------------------

describe('isTunnelEnd', () => {
  it('returns true for an Open tile surrounded by 4 Solid neighbors', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // Center tile (5,5): set Open; all 4 neighbors remain Solid (default)
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(true);
  });

  it('returns false for an Open tile with no Solid neighbors (surrounded by Open)', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // Set (5,5) and all 4 neighbors to Open
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    ugSet(grid, 5, 4, UndergroundTileState.Open); // N
    ugSet(grid, 6, 5, UndergroundTileState.Open); // E
    ugSet(grid, 5, 6, UndergroundTileState.Open); // S
    ugSet(grid, 4, 5, UndergroundTileState.Open); // W
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(false);
  });

  it('returns false for a Solid tile (must be Open)', () => {
    const world = makeWorld();
    // (5,5) stays Solid by default
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(false);
  });

  it('returns false for a Marked tile (must be Open)', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Marked);
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(false);
  });

  it('returns false for a BeingDug tile (must be Open)', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.BeingDug);
    expect(isTunnelEnd(world, 5, 5, PLAYER_COLONY_ID)).toBe(false);
  });

  it('returns true when Open tile is at the left edge with a valid Solid neighbor (not skipping valid neighbors at boundary)', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // (0, 5) at the left edge: W neighbor (−1, 5) is out-of-bounds (skipped),
    // but N (0,4), E (1,5), S (0,6) remain Solid — so still true.
    ugSet(grid, 0, 5, UndergroundTileState.Open);
    expect(isTunnelEnd(world, 0, 5, PLAYER_COLONY_ID)).toBe(true);
  });

  it('returns false when all valid (in-bounds) neighbors are Open at an edge tile', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // (0, 5): W is out-of-bounds; set N, E, S all to Open → no Solid neighbors
    ugSet(grid, 0, 5, UndergroundTileState.Open);
    ugSet(grid, 0, 4, UndergroundTileState.Open); // N
    ugSet(grid, 1, 5, UndergroundTileState.Open); // E
    ugSet(grid, 0, 6, UndergroundTileState.Open); // S
    expect(isTunnelEnd(world, 0, 5, PLAYER_COLONY_ID)).toBe(false);
  });

  it('returns false when the undergroundGrid for colonyId is missing', () => {
    const world = makeWorld();
    // Query a non-existent colony (2)
    expect(isTunnelEnd(world, 5, 5, 2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleUndergroundLeftClick
// ---------------------------------------------------------------------------

describe('handleUndergroundLeftClick', () => {
  it('pushes MarkDigTileCommand for a Solid tile', () => {
    const world = makeWorld({ tick: 7 });
    // (5,10) stays Solid by default
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; tileX: number; tileY: number; issuedAtTick: number };
    expect(cmd.type).toBe('MarkDigTile');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.tileX).toBe(5);
    expect(cmd.tileY).toBe(10);
    expect(cmd.issuedAtTick).toBe(7);
  });

  it('pushes MarkDigTileCommand for an Open tile', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.Open);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    expect((world.commandQueue[0] as { type: string }).type).toBe('MarkDigTile');
  });

  it('is a no-op when activeView is surface', () => {
    const world = makeWorld();
    const vs = makeViewState('surface', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when pointer is over a HUD zone', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    handleUndergroundLeftClick(world, vs, HUD.TRIANGLE.x + 5, HUD.TRIANGLE.y + 5, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('does not push a command for a Marked tile but still arms drag state', () => {
    // Click on already-Marked tile must arm isDragging + lastMarkedTile so a
    // continuation drag into adjacent Solid still marks dirt. Without the
    // arming, the subsequent pointermove would observe isDragging=false and
    // silently no-op for the rest of the gesture (the bug this fix addresses).
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(true);
    expect(state.lastMarkedTileX).toBe(5);
    expect(state.lastMarkedTileY).toBe(10);
  });

  it('does not push a command for a BeingDug tile but still arms drag state', () => {
    // Same arming contract as the Marked case — BeingDug tiles are also
    // already-claimed, so no command is emitted, but a click that lands on
    // one must arm the drag so the rest of the stroke can mark dirt.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.BeingDug);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(true);
    expect(state.lastMarkedTileX).toBe(5);
    expect(state.lastMarkedTileY).toBe(10);
  });

  it('is a no-op for out-of-bounds tile coordinates and does not arm drag state', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    // screen coord that maps to tileX < 0
    handleUndergroundLeftClick(world, vs, -640, 0, state);
    expect(world.commandQueue).toHaveLength(0);
    // Out-of-bounds is a rejection, not an accept-and-skip — drag must NOT arm.
    expect(state.isDragging).toBe(false);
    expect(state.lastMarkedTileX).toBe(-1);
    expect(state.lastMarkedTileY).toBe(-1);
  });

  it('sets isDragging=true and records lastMarkedTile after a successful click', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(state.isDragging).toBe(true);
    expect(state.lastMarkedTileX).toBe(5);
    expect(state.lastMarkedTileY).toBe(10);
  });

  it('does NOT push MarkDigTile when ant-activity panel pendingHide is set (UIScene-first race)', async () => {
    // Scenario: player opens HUD ant-activity popup, then clicks on the
    // underground map to dismiss it. UIScene's pointerdown handler sets
    // pendingHide=true before returning. The subsequent underground-input
    // pointerdown must observe the click as HUD-consumed and drop it —
    // otherwise the dismissal click would also mark the tile for digging.
    const { showAntActivityPanel, requestHideAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({ tick: 7 });
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);

    showAntActivityPanel();
    requestHideAntActivityPanel();
    try {
      handleUndergroundLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
      expect(state.isDragging).toBe(false);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('does NOT push MarkDigTile when panel is visible and pendingHide=false (world-input-first race)', async () => {
    // World-input-first dispatch ordering: UIScene has NOT yet called
    // requestHideAntActivityPanel(), so pendingHide is still false when the
    // underground-input pointerdown runs. The click must still be consumed
    // — otherwise the dismissal click would also mark a dig tile. isPointer-
    // OverHUD now masks on `visible` alone (not just pendingHide) to close
    // both listener orderings.
    const { showAntActivityPanel, hideAntActivityPanel, antActivityPanelState } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({ tick: 7 });
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(5, 10, 64, 32);

    showAntActivityPanel();
    try {
      expect(antActivityPanelState.visible).toBe(true);
      expect(antActivityPanelState.pendingHide).toBe(false);
      handleUndergroundLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
      expect(state.isDragging).toBe(false);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('right-click also no-ops when panel is visible and pendingHide=false (world-input-first race)', async () => {
    // Right-click on Marked or Open-tunnel-end would normally emit
    // CancelDigMark / open a context menu. Must be suppressed while the
    // panel is up, regardless of listener order.
    const { showAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({ tick: 4 });
    // Seed a Marked tile at (5, 10) so a normal right-click would emit
    // CancelDigMarkCommand.
    ugSet(world.undergroundGrids[PLAYER_COLONY_ID]!, 5, 10, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 10, 64, 32);

    showAntActivityPanel();
    try {
      handleUndergroundRightClick(world, vs, x, y);
      expect(world.commandQueue).toHaveLength(0);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('suppresses click without mutating menu state when menu is visible', () => {
    // UIScene owns menu dismissal (requestHideContextMenu → applied next frame).
    // handleUndergroundLeftClick must NOT flip `visible` synchronously or it
    // races with UIScene's pointerdown handler on the same event.
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    contextMenuState.visible = true;
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(contextMenuState.visible).toBe(true);
    expect(contextMenuState.pendingHide).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  it('is a no-op while panInputState.spaceHeld is true (Space+left-drag is pan, not dig-mark)', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    panInputState.spaceHeld = true;
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  it('is a no-op while panInputState.isPanning is true (mid-pan clicks are pan continuation)', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    panInputState.isPanning = true;
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  // The eager arm-on-click for already-claimed tiles must NOT bypass the
  // rejection guards (HUD / pan / context menu). These are symmetric
  // counterparts to the Solid-tile guard tests above — they pin the contract
  // that arming only happens AFTER all guards have passed, regardless of
  // tile state. A future refactor that moves arming above a guard would
  // break these.
  it('Marked-tile click does NOT arm drag when context menu is visible', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    contextMenuState.visible = true;
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(state.isDragging).toBe(false);
    expect(state.lastMarkedTileX).toBe(-1);
    expect(state.lastMarkedTileY).toBe(-1);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('Marked-tile click does NOT arm drag when panInputState.spaceHeld is true', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    panInputState.spaceHeld = true;
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(state.isDragging).toBe(false);
    expect(state.lastMarkedTileX).toBe(-1);
    expect(state.lastMarkedTileY).toBe(-1);
  });

  it('Marked-tile click does NOT arm drag when pointer is over HUD', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    // HUD-overlap rejection runs before screenToTile, so the underlying tile
    // state at the world coord is irrelevant here — we just verify that the
    // arm code never executes when HUD eats the click.
    handleUndergroundLeftClick(world, vs, HUD.TRIANGLE.x + 5, HUD.TRIANGLE.y + 5, state);
    expect(state.isDragging).toBe(false);
    expect(state.lastMarkedTileX).toBe(-1);
    expect(state.lastMarkedTileY).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// handleUndergroundDrag
// ---------------------------------------------------------------------------

describe('handleUndergroundDrag', () => {
  it('pushes MarkDigTileCommand when drag enters a new tile', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    // Start dragging from (5,10), move to (6,10)
    const state = makeState(true, 5, 10);
    const { x, y } = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; tileX: number; tileY: number };
    expect(cmd.type).toBe('MarkDigTile');
    expect(cmd.tileX).toBe(6);
    expect(cmd.tileY).toBe(10);
    expect(state.lastMarkedTileX).toBe(6);
    expect(state.lastMarkedTileY).toBe(10);
  });

  it('does NOT push a command when pointer stays on the same tile (debounce)', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    // isDragging=true, last tile was (5,10), drag stays at (5,10)
    const state = makeState(true, 5, 10);
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when isDragging is false', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(false, 5, 10);
    const { x, y } = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('sets isDragging=false when activeView switches to surface mid-drag', () => {
    const world = makeWorld();
    const vs = makeViewState('surface', 64, 32); // view switched
    const state = makeState(true, 5, 10);
    const { x, y } = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(state.isDragging).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('does NOT push a command for a Marked tile during drag', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 6, 10, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 5, 10);
    const { x, y } = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('cancels drag and no-ops when Space is pressed mid-drag (gesture switches to pan)', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 5, 10);
    panInputState.spaceHeld = true;
    const { x, y } = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  // 09 backlog memo — drag interpolation must emit a 4-connected (Manhattan-
  // adjacent) tile sequence. A pure diagonal between successive tiles would
  // leave them touching only by a corner, which breaks the 4-connected
  // underground movement/dig graph and creates unreachable tunnel segments.
  // Each diagonal step is split into an orthogonal bridge + the destination.
  it('single-step diagonal drag from (10,10) to (11,11) emits an orthogonal bridge tile plus the final tile', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 10, 10);
    const { x, y } = tileToScreen(11, 11, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    const marks = world.commandQueue.map((c) => {
      const cc = c as { type: string; tileX: number; tileY: number };
      return `${cc.tileX},${cc.tileY}`;
    });
    // At least one bridge tile (11,10) or (10,11) must be emitted; the
    // destination (11,11) is always emitted. Starting tile is not re-emitted.
    const bridgeEmitted = marks.includes('11,10') || marks.includes('10,11');
    expect(bridgeEmitted).toBe(true);
    expect(marks).toContain('11,11');
    expect(marks).not.toContain('10,10');
    // Every successive emitted tile — measured from the prior marked tile
    // (10,10) — must be Manhattan-adjacent (4-connected).
    const prev: Array<[number, number]> = [[10, 10]];
    for (const m of marks) {
      const [xs, ys] = m.split(',').map(Number) as [number, number];
      const [px, py] = prev[prev.length - 1]!;
      expect(Math.abs(xs - px) + Math.abs(ys - py)).toBe(1);
      prev.push([xs, ys]);
    }
    expect(state.lastMarkedTileX).toBe(11);
    expect(state.lastMarkedTileY).toBe(11);
  });

  it('diagonal drag from (10,10) to (12,12) produces a continuous 4-connected path', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 10, 10);
    const { x, y } = tileToScreen(12, 12, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    const marks = world.commandQueue.map((c) => {
      const cc = c as { type: string; tileX: number; tileY: number };
      return `${cc.tileX},${cc.tileY}`;
    });
    expect(marks).toContain('12,12');
    expect(marks).not.toContain('10,10');
    // Continuous 4-connected sequence starting from (10,10).
    const prev: Array<[number, number]> = [[10, 10]];
    for (const m of marks) {
      const [xs, ys] = m.split(',').map(Number) as [number, number];
      const [px, py] = prev[prev.length - 1]!;
      expect(Math.abs(xs - px) + Math.abs(ys - py)).toBe(1);
      prev.push([xs, ys]);
    }
    expect(state.lastMarkedTileX).toBe(12);
    expect(state.lastMarkedTileY).toBe(12);
  });

  it('shallow diagonal drag from (10,10) to (13,11) emits a continuous 4-connected path', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 10, 10);
    const { x, y } = tileToScreen(13, 11, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    const marks = world.commandQueue.map((c) => {
      const cc = c as { tileX: number; tileY: number };
      return `${cc.tileX},${cc.tileY}`;
    });
    // Final tile is (13,11).
    expect(marks[marks.length - 1]).toBe('13,11');
    // Every successive tile is Manhattan-adjacent (4-connectivity), not just
    // 8-connected. This is the contract the underground grid requires.
    const prev: Array<[number, number]> = [[10, 10]];
    for (const m of marks) {
      const [xs, ys] = m.split(',').map(Number) as [number, number];
      const [px, py] = prev[prev.length - 1]!;
      expect(Math.abs(xs - px) + Math.abs(ys - py)).toBe(1);
      prev.push([xs, ys]);
    }
  });

  it('diagonal drag skips non-markable tiles without aborting the stroke', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // Put a Marked tile somewhere along the path from (10,10) to (12,12).
    ugSet(grid, 11, 11, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 10, 10);
    const { x, y } = tileToScreen(12, 12, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    const marks = world.commandQueue.map((c) => {
      const cc = c as { tileX: number; tileY: number };
      return `${cc.tileX},${cc.tileY}`;
    });
    // (11,11) was Marked already → no command emitted. (12,12) still emitted.
    expect(marks).not.toContain('11,11');
    expect(marks).toContain('12,12');
    expect(state.lastMarkedTileX).toBe(12);
    expect(state.lastMarkedTileY).toBe(12);
  });

  it('same-tile drag does not emit extra commands (debounce)', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(true, 10, 10);
    const { x, y } = tileToScreen(10, 10, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Click + drag handoff: starting on an already-claimed tile must still mark
// newly-entered Solid tiles. Regression coverage for the "click on blue
// to-be-dug tile then drag through dirt" bug.
// ---------------------------------------------------------------------------

describe('left-click + drag handoff', () => {
  it('click on Marked then drag into adjacent Solid emits MarkDigTile on the Solid tile', () => {
    const world = makeWorld({ tick: 3 });
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // Player previously marked (5,10); now they click there and drag east
    // through Solid dirt at (6,10). The dirt must end up marked.
    ugSet(grid, 5, 10, UndergroundTileState.Marked);
    // (6,10) stays Solid by default
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();

    // 1. pointerdown on the Marked tile.
    const start = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, start.x, start.y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(true);

    // 2. pointermove into the adjacent Solid tile.
    const dragTo = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, dragTo.x, dragTo.y, state);

    // The Solid tile must have been marked.
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; tileX: number; tileY: number };
    expect(cmd.type).toBe('MarkDigTile');
    expect(cmd.tileX).toBe(6);
    expect(cmd.tileY).toBe(10);
  });

  it('click on BeingDug then drag into adjacent Solid emits MarkDigTile on the Solid tile', () => {
    // Same contract for BeingDug — the click is on an already-claimed tile,
    // but the drag must still mark dirt encountered after the start.
    const world = makeWorld({ tick: 5 });
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.BeingDug);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();

    const start = tileToScreen(5, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, start.x, start.y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(true);

    const dragTo = tileToScreen(6, 10, 64, 32);
    handleUndergroundDrag(world, vs, dragTo.x, dragTo.y, state);

    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; tileX: number; tileY: number };
    expect(cmd.type).toBe('MarkDigTile');
    expect(cmd.tileX).toBe(6);
    expect(cmd.tileY).toBe(10);
  });

  it('click on Marked then drag across multiple Solid tiles produces a continuous 4-connected mark sequence', () => {
    // Multi-tile stroke variant — exercises the Bresenham interpolation
    // starting from a Marked tile. Covers the realistic gesture: player taps
    // an already-marked tile and sweeps through dirt to mark a corridor.
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 10, 10, UndergroundTileState.Marked);
    // (11,10) through (13,10) stay Solid by default

    const start = tileToScreen(10, 10, 64, 32);
    handleUndergroundLeftClick(world, vs, start.x, start.y, state);
    expect(world.commandQueue).toHaveLength(0);

    const dragTo = tileToScreen(13, 10, 64, 32);
    handleUndergroundDrag(world, vs, dragTo.x, dragTo.y, state);

    const marks = world.commandQueue.map((c) => {
      const cc = c as { tileX: number; tileY: number };
      return `${cc.tileX},${cc.tileY}`;
    });
    // Every dirt tile crossed during the drag must be in the queue. The
    // starting (Marked) tile is not re-emitted.
    expect(marks).toContain('11,10');
    expect(marks).toContain('12,10');
    expect(marks).toContain('13,10');
    expect(marks).not.toContain('10,10');
  });
});

// ---------------------------------------------------------------------------
// handleUndergroundRightClick
// ---------------------------------------------------------------------------

describe('handleUndergroundRightClick', () => {
  it('pushes CancelDigMarkCommand for a Marked tile', () => {
    const world = makeWorld({ tick: 2 });
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 10, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 10, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; tileX: number; tileY: number; issuedAtTick: number };
    expect(cmd.type).toBe('CancelDigMark');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.tileX).toBe(5);
    expect(cmd.tileY).toBe(10);
    expect(cmd.issuedAtTick).toBe(2);
  });

  it('requests a deferred show for an Open tunnel-end tile (anchor stored immediately, visible flipped on next update)', () => {
    // Deferred show is required because UIScene's pointerdown handler runs in
    // the same dispatch as this one. If visible flipped synchronously, UIScene
    // would see visible=true on the SAME right-click event and interpret it as
    // a menu item selection — the bug this deferred-show pattern exists to fix.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // (5,5) Open; N (5,4) stays Solid → tunnel end
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    // Immediately after the handler: visible is still false, pendingShow is true,
    // and the anchor (tile + screen coords) is stored for rendering on next frame.
    expect(contextMenuState.visible).toBe(false);
    expect(contextMenuState.pendingShow).toBe(true);
    expect(contextMenuState.anchorTileX).toBe(5);
    expect(contextMenuState.anchorTileY).toBe(5);
    expect(contextMenuState.screenX).toBeCloseTo(x);
    expect(contextMenuState.screenY).toBeCloseTo(y);
    expect(world.commandQueue).toHaveLength(0);
    // On the next frame, UIScene.update calls applyPendingContextMenuShow and
    // the menu becomes visible to the renderer.
    applyPendingContextMenuShow();
    expect(contextMenuState.visible).toBe(true);
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('cross-scene race: a pointerdown handler running after handleUndergroundRightClick sees visible=false for this same dispatch', () => {
    // This is the exact scenario the deferred-show pattern defends against.
    // UIScene's pointerdown handler runs in the same JS dispatch as the
    // underground-input pointerdown handler. It MUST NOT see visible=true from
    // the show that is pending for the next frame, or it would misinterpret
    // the right-click as a menu-item selection (the menu anchor is at the
    // pointer, so the click lands on the first item).
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);

    handleUndergroundRightClick(world, vs, x, y);

    // Simulate the "UIScene handler running second in the same dispatch"
    // observing the state. It must see visible=false so its menu-selection
    // branch does not fire on this right-click.
    const visibleAtSecondHandlerEntry = contextMenuState.visible;
    expect(visibleAtSecondHandlerEntry).toBe(false);

    // No PlaceChamberCommand should have been pushed by either handler
    // on this dispatch — only the anchor metadata is set for next-frame render.
    expect(world.commandQueue).toHaveLength(0);
  });

  it('menu remains visible across multiple frames after pendingShow applies (no auto-hide)', () => {
    // Once the menu is shown on frame N+1, it stays visible until an explicit
    // hide is requested (menu selection, click outside, or view toggle). This
    // gives the player time to read the items and pick one.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    applyPendingContextMenuShow();
    expect(contextMenuState.visible).toBe(true);
    // Multiple frames pass with no pointerdown — menu stays visible.
    applyPendingContextMenuShow(); // no-op on second call
    expect(contextMenuState.visible).toBe(true);
    applyPendingContextMenuShow();
    expect(contextMenuState.visible).toBe(true);
  });

  it('does NOT open context menu for an Open tile that is NOT a tunnel end', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // (5,5) Open; all 4 neighbors Open → not a tunnel end
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    ugSet(grid, 5, 4, UndergroundTileState.Open);
    ugSet(grid, 6, 5, UndergroundTileState.Open);
    ugSet(grid, 5, 6, UndergroundTileState.Open);
    ugSet(grid, 4, 5, UndergroundTileState.Open);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.visible).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op for a Solid tile', () => {
    const world = makeWorld();
    // (5,5) stays Solid by default
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.visible).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op for a BeingDug tile (CTRL-04: finish-then-switch)', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.BeingDug);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.visible).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when activeView is surface', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Marked);
    const vs = makeViewState('surface', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when pointer is over HUD', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    handleUndergroundRightClick(world, vs, HUD.STATS.x + 5, HUD.STATS.y + 5);
    expect(world.commandQueue).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Issue #38 — v5+ right-click on Solid OR Open opens the chamber menu.
  // -------------------------------------------------------------------------

  it('v5+: right-click on a Solid tile opens the chamber-placement menu (issue #38)', () => {
    const world = makeWorld();
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;
    // (5,5) stays Solid by default. Pre-v5 this was a no-op; v5 should
    // surface the menu so the player can plan a chamber in untouched dirt.
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.pendingShow).toBe(true);
    expect(contextMenuState.anchorTileX).toBe(5);
    expect(contextMenuState.anchorTileY).toBe(5);
  });

  it('v5+: right-click on an Open tile that is NOT a tunnel end opens the menu (issue #38)', () => {
    const world = makeWorld();
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // 3×3 Open region — interior tile (5,5) has no Solid 4-neighbor, so
    // pre-v5 isTunnelEnd would reject. v5 should still open the menu.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        ugSet(grid, 5 + dx, 5 + dy, UndergroundTileState.Open);
      }
    }
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.pendingShow).toBe(true);
  });

  it('v5+: right-click on a Marked tile still pushes CancelDigMark (existing UX preserved)', () => {
    const world = makeWorld();
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Marked);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    // CancelDigMark wins over chamber-placement menu on Marked tiles —
    // the existing right-click muscle memory is preserved.
    const cancelCmd = world.commandQueue.find((c) => c.type === 'CancelDigMark');
    expect(cancelCmd).toBeDefined();
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('v5+: right-click on a BeingDug tile is still a no-op (sim would reject)', () => {
    const world = makeWorld();
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.BeingDug);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.pendingShow).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('v5+: right-click on the ceiling row is a no-op (sim ceiling guard mirrored)', () => {
    const world = makeWorld();
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 0, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.pendingShow).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('legacy (pre-v5): right-click on Solid is a no-op (replay determinism)', () => {
    const world = makeWorld();
    world.simVersion = LEGACY_SIM_VERSION;
    // (5,5) stays Solid by default.
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(contextMenuState.pendingShow).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resetUndergroundInputState — Phase 9 session reset
// ---------------------------------------------------------------------------

describe('resetUndergroundInputState', () => {
  it('ends an in-flight drag and clears the last-marked debounce', () => {
    const state: UndergroundInputState = {
      isDragging: true,
      lastMarkedTileX: 12,
      lastMarkedTileY: 7,
    };
    resetUndergroundInputState(state);
    expect(state.isDragging).toBe(false);
    expect(state.lastMarkedTileX).toBe(-1);
    expect(state.lastMarkedTileY).toBe(-1);
  });

  it('preserves the state object identity (mutates in place)', () => {
    // registerUndergroundInput closed over this reference; must not swap it.
    const state: UndergroundInputState = {
      isDragging: true,
      lastMarkedTileX: 5,
      lastMarkedTileY: 5,
    };
    const ref = state;
    resetUndergroundInputState(state);
    expect(state).toBe(ref);
  });

  it('is idempotent on an already-reset state', () => {
    const state: UndergroundInputState = {
      isDragging: false,
      lastMarkedTileX: -1,
      lastMarkedTileY: -1,
    };
    resetUndergroundInputState(state);
    expect(state).toEqual({ isDragging: false, lastMarkedTileX: -1, lastMarkedTileY: -1 });
  });

  it('restart simulation: a post-reset drag does not inherit the old debounce', () => {
    // Starting state after restart — no prior drag, no prior tile mark.
    const state: UndergroundInputState = { isDragging: true, lastMarkedTileX: 5, lastMarkedTileY: 5 };
    resetUndergroundInputState(state);
    // After reset: a pointerdown on tile (5,5) in the new session must mark
    // it, because lastMarkedTile was cleared. handleUndergroundLeftClick
    // issues the command unconditionally on a Solid tile so we model the
    // drag-debounce contract directly: the next tile differs from (-1,-1).
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Solid);
    const vs = makeViewState('underground', 64, 32);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    expect(state.isDragging).toBe(true);
    expect(state.lastMarkedTileX).toBe(5);
    expect(state.lastMarkedTileY).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Issue #14 — read-only when viewing enemy underground
// ---------------------------------------------------------------------------

describe('underground-input read-only when activeUndergroundColonyId !== PLAYER_COLONY_ID', () => {
  // Helper: viewport pointing at the enemy underground.
  function makeEnemyView(): ViewState {
    return {
      activeView: 'underground',
      surfaceCamera: { x: 64, y: 32, viewportWidth: VIEWPORT_WIDTH_TILES, viewportHeight: VIEWPORT_HEIGHT_TILES },
      undergroundCamera: { x: 64, y: 32, viewportWidth: VIEWPORT_WIDTH_TILES, viewportHeight: VIEWPORT_HEIGHT_TILES },
      undergroundVisited: true,
      activeUndergroundColonyId: ENEMY_COLONY_ID,
    };
  }

  it('handleUndergroundLeftClick is a no-op while viewing the enemy hive', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Solid);
    const vs = makeEnemyView();
    const state = makeState();
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    // No command emitted, no drag armed. The click was rejected silently —
    // dispatching a MarkDigTile against PLAYER_COLONY_ID at the same coords
    // would silently scribble on the player's grid the player can't see.
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  it('handleUndergroundLeftClick on the enemy view clears any lingering isDragging flag', () => {
    // Defensive: a prior gesture that didn't see a clean mouseup (e.g.,
    // focus-loss) could leave isDragging=true. The enemy-view guard must
    // also reset it so a subsequent flip back to the player view doesn't
    // resume the stale stroke from a stale lastMarkedTile.
    const world = makeWorld();
    ugSet(world.undergroundGrids[PLAYER_COLONY_ID]!, 5, 5, UndergroundTileState.Solid);
    const vs = makeEnemyView();
    const state = makeState(/*isDragging*/ true, 4, 4);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(state.isDragging).toBe(false);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('handleUndergroundDrag aborts and clears isDragging when activeUndergroundColonyId flips to enemy mid-drag', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Solid);
    const vs = makeEnemyView();
    const state = makeState(/*isDragging*/ true, 4, 5);
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  it('handleUndergroundRightClick is a no-op while viewing the enemy hive', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 5, 5, UndergroundTileState.Marked);
    const vs = makeEnemyView();
    const { x, y } = tileToScreen(5, 5, 64, 32);
    handleUndergroundRightClick(world, vs, x, y);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #30 — ceiling-strip click rejection
// ---------------------------------------------------------------------------

describe('underground-input — ceiling-strip row gate (issue #30)', () => {
  it('handleUndergroundLeftClick on tileY=0 is a no-op (no MarkDigTile, no drag arm)', () => {
    // The renderer paints the topmost underground row with the grass texture
    // as a "this is the surface boundary, not a diggable wall" cue. Without
    // this gate, a click on the visible grass dispatched MarkDigTile against
    // the tile beneath, the renderer kept painting grass on top, and the
    // mark was effectively invisible to the player. See draw-underground.ts
    // (`ty === 0` branch) for the matching renderer logic.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 10, 0, UndergroundTileState.Solid);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(10, 0, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  it('handleUndergroundLeftClick on the ceiling strip clears any stale isDragging flag (codex P2)', () => {
    // Defensive: a prior gesture that didn't see a clean pointerup (focus-
    // loss) could leave isDragging=true. The ceiling-row guard must also
    // reset it so a subsequent pointermove doesn't resume the stale stroke
    // from a stale lastMarkedTile and emit hidden marks — the exact
    // pre-fix behavior this PR is supposed to eliminate.
    const world = makeWorld();
    ugSet(world.undergroundGrids[PLAYER_COLONY_ID]!, 10, 0, UndergroundTileState.Solid);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(/*isDragging*/ true, 4, 4);
    const { x, y } = tileToScreen(10, 0, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.isDragging).toBe(false);
  });

  it('handleUndergroundLeftClick on tileY=1 still emits MarkDigTile (sanity — only y=0 is gated)', () => {
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 10, 1, UndergroundTileState.Solid);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState();
    const { x, y } = tileToScreen(10, 1, 64, 32);
    handleUndergroundLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; tileY: number };
    expect(cmd.type).toBe('MarkDigTile');
    expect(cmd.tileY).toBe(1);
  });

  it('handleUndergroundDrag stroke that crosses tileY=0 skips the row-0 tiles but continues on row 1+', () => {
    // Drag stroke from (10, 1) → (20, 0) → (20, 1) (synthesized via two
    // emit calls). The row-0 tile must NOT emit a MarkDigTile; the row-1
    // tiles bracketing it MUST emit. Bresenham continues across the gap.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // Solid corridor along the path so each tile would otherwise be markable.
    for (let x = 10; x <= 20; x++) {
      ugSet(grid, x, 0, UndergroundTileState.Solid);
      ugSet(grid, x, 1, UndergroundTileState.Solid);
    }
    const vs = makeViewState('underground', 64, 32);
    // Seed drag at (10, 1) with isDragging=true (sentinel-free path).
    const state = makeState(/*isDragging*/ true, 10, 1);
    // Drag to (20, 0) — Bresenham stroke runs along row 0 and row 1.
    const { x, y } = tileToScreen(20, 0, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    // Every emitted command must have tileY > 0 — no ceiling-row marks.
    const tileYsEmitted = world.commandQueue.map((c) => (c as { tileY: number }).tileY);
    expect(tileYsEmitted.length).toBeGreaterThan(0); // sanity — some marks fired
    expect(tileYsEmitted.every((ty) => ty > 0)).toBe(true);
  });

  it('handleUndergroundDrag stroke that grazes ty=0 mid-stroke still emits row-1+ tiles past the crossing', () => {
    // Strengthens the prior "crosses ceiling" test by ending the stroke on
    // a regular row, not on row 0. The Bresenham loop must keep emitting
    // for tiles past the row-0 crossing — the row-0 gate must be a
    // per-tile skip inside emitTile, not a stroke-level early return.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    for (let x = 5; x <= 15; x++) {
      for (let y = 0; y <= 2; y++) {
        ugSet(grid, x, y, UndergroundTileState.Solid);
      }
    }
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(/*isDragging*/ true, 5, 2);
    // Drag end at (15, 2) — Bresenham line passes through tiles at multiple
    // rows including y=0 if the stepper takes a diagonal turn through it.
    // For our straight-row stroke (5,2)→(15,2), no row-0 tiles are touched,
    // but we explicitly synthesize a stroke that does cross y=0 by routing
    // through (10, 0).
    let { x: x1, y: y1 } = tileToScreen(10, 0, 64, 32);
    handleUndergroundDrag(world, vs, x1, y1, state); // first leg dips through row 0
    ({ x: x1, y: y1 } = tileToScreen(15, 2, 64, 32));
    handleUndergroundDrag(world, vs, x1, y1, state); // second leg returns to row 2
    const tileYsEmitted = world.commandQueue.map((c) => (c as { tileY: number }).tileY);
    expect(tileYsEmitted.length).toBeGreaterThan(0);
    expect(tileYsEmitted.every((ty) => ty > 0)).toBe(true);
    // Specifically: (15, 2) reached and emitted past the ceiling crossing.
    expect(tileYsEmitted).toContain(2);
  });

  it('handleUndergroundDrag from sentinel (-1,-1) into tileY=0 is a no-op but rebases the cursor', () => {
    // First-tick drag fall-back: when lastMarkedTile is the (-1,-1) sentinel
    // and the pointer lands on the ceiling strip, we don't mark anything
    // but we DO rebase the cursor so a subsequent drag onto a regular row
    // can interpolate from a valid origin.
    const world = makeWorld();
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    ugSet(grid, 10, 0, UndergroundTileState.Solid);
    const vs = makeViewState('underground', 64, 32);
    const state = makeState(/*isDragging*/ true, -1, -1);
    const { x, y } = tileToScreen(10, 0, 64, 32);
    handleUndergroundDrag(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    expect(state.lastMarkedTileX).toBe(10);
    expect(state.lastMarkedTileY).toBe(0);
    expect(state.isDragging).toBe(true);
  });
});
