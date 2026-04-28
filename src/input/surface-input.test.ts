// surface-input.test.ts — Vitest unit tests for src/input/surface-input.ts
//
// Tests cover pure dispatch logic only.
// Phaser scene integration (registerSurfaceInput) is verified by Plan 07 Playwright smoke test.
//
// Key invariants:
//   - Food-pile mark pushes MarkFoodPileCommand with correct tile coords.
//   - Entrance designation: right-click sets preview; left-click same tileX confirms.
//   - Both handlers are no-ops when activeView !== 'surface'.
//   - Both handlers are no-ops when pointer is over a HUD zone.
//   - Tile out-of-bounds (tileX/Y < 0) → no command.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  findFoodPileAt,
  handleSurfaceLeftClick,
  handleSurfaceRightClick,
  isEmptySurfaceTile,
  handleSetRallyPoint,
  resetSurfaceInputState,
  type SurfaceInputState,
} from './surface-input.js';
import { panInputState, resetPanInputStateForTests } from './camera-input.js';

beforeEach(() => {
  resetPanInputStateForTests();
});
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES } from '../render/camera.js';
import { HUD, TILE_SIZE_PX } from '../render/sprites.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';

// Re-export TILE_SIZE_PX from sprites where it actually lives — camera.ts re-exports via void
// but we need the numeric value. It is 16 per Plan 01.
// We derive screen coords from tile coords: screenX = tile * 16 - (cam.x - vw/2) * 16
// i.e. screenX = (tile - cam.x + vw/2) * TILE_SIZE_PX

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ViewState pointing to the given view, camera centered at cx,cy. */
function makeViewState(
  view: 'surface' | 'underground' = 'surface',
  camX = 64,
  camY = 64,
): ViewState {
  return {
    activeView: view,
    surfaceCamera: { x: camX, y: camY, viewportWidth: VIEWPORT_WIDTH_TILES, viewportHeight: VIEWPORT_HEIGHT_TILES },
    undergroundCamera: { x: camX, y: camY, viewportWidth: VIEWPORT_WIDTH_TILES, viewportHeight: VIEWPORT_HEIGHT_TILES },
    undergroundVisited: false,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
  };
}

/**
 * Convert tile coords to screen pixel coords given the surface camera at (camX, camY).
 * Mirrors the renderer's integer-tile snap (`Math.floor(cam.x - vw/2)`) so tests
 * target the pixel the player would actually see the tile at. Using the raw
 * fractional camera here caused a 1-tile drift whenever the half-viewport was
 * fractional (e.g. VIEWPORT_HEIGHT_TILES=37 → vh/2 = 18.5).
 */
function tileToScreen(tileX: number, tileY: number, camX: number, camY: number): { x: number; y: number } {
  const left = Math.floor(camX - VIEWPORT_WIDTH_TILES / 2);
  const top = Math.floor(camY - VIEWPORT_HEIGHT_TILES / 2);
  const px = (tileX - left) * TILE_SIZE_PX;
  const py = (tileY - top) * TILE_SIZE_PX;
  return { x: px, y: py };
}

/** Build a minimal WorldState stub with given foodPiles, colonies, and commandQueue. */
function makeWorld(overrides: {
  tick?: number;
  foodPiles?: WorldState['foodPiles'];
  colonies?: WorldState['colonies'];
  surfaceWidth?: number;
  surfaceHeight?: number;
} = {}): WorldState {
  const sw = overrides.surfaceWidth ?? 128;
  const sh = overrides.surfaceHeight ?? 4;
  return {
    tick: overrides.tick ?? 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: [] as SimCommand[],
    ants: { posX: new Int32Array(0), posY: new Int32Array(0), colonyId: new Int32Array(0), task: new Int32Array(0), subTask: new Int32Array(0), speed: new Int32Array(0), foodCarrying: new Int32Array(0), starvationTimer: new Int32Array(0), age: new Int32Array(0), alive: new Int32Array(0), lifespan: new Int32Array(0), zone: new Int32Array(0), digTileX: new Int32Array(0), digTileY: new Int32Array(0), digTicksRemaining: new Int32Array(0), targetPosX: new Int32Array(0), targetPosY: new Int32Array(0) },
    colonies: overrides.colonies ?? {},
    pheromoneGrids: {},
    surface: { data: new Uint8Array(sw * sh), width: sw, height: sh },
    undergroundGrids: {},
    foodPiles: overrides.foodPiles ?? [],
    pendingChambers: {},
  } as unknown as WorldState;
}

/** Build a minimal colony record stub with an optional rally point and entrances. */
function makeColony(overrides: {
  rallyPoint?: { tileX: number; tileY: number } | null;
  entrances?: Array<{ surfaceTileX: number; surfaceTileY: number }>;
} = {}) {
  return {
    colonyId: PLAYER_COLONY_ID as ColonyId,
    queenEntityId: 0,
    queenStarvationTimer: 0,
    foodStored: 0,
    workerCount: 0,
    eggCount: 0,
    larvaeCount: 0,
    nurseCount: 0,
    eggs: [],
    larvae: [],
    workers: [],
    chambers: [],
    // Phase 10 / CTRL-01' (LOCKED): targetRatio is two-field {forage, fight};
    // dig is auto-assigned via CTRL-06. Original 33/33/34 was the percentage
    // convention; rebalanced here to 50/50 (preserves the original "balanced"
    // semantic intent — dig:33 dropped, residual forage/fight evened).
    // computedAllocation + taskCensus remain 4-field (WorkerAllocation per D-03).
    targetRatio: { forage: 50, fight: 50 },
    computedAllocation: { nurse: 0, forage: 0, dig: 0, fight: 0 },
    taskCensus: { nurse: 0, forage: 0, dig: 0, fight: 0 },
    defeated: false,
    reconcileCountdown: 0,
    entrances: overrides.entrances ?? [],
    rallyPoint: overrides.rallyPoint ?? null,
    digFlowFieldDirty: false,
    killCount: 0,
  };
}

/** A SurfaceInputState equivalent (the exported interface in surface-input.ts). */
function makeState(pendingEntranceTileX: number | null = null, pendingEntranceTileY: number | null = null) {
  return { pendingEntranceTileX, pendingEntranceTileY };
}

// ---------------------------------------------------------------------------
// findFoodPileAt
// ---------------------------------------------------------------------------

describe('findFoodPileAt', () => {
  it('returns the pile at the exact tile coordinate', () => {
    const world = makeWorld({
      foodPiles: [
        { foodPileId: 1, tileX: 10, tileY: 20 },
        { foodPileId: 2, tileX: 30, tileY: 40 },
        { foodPileId: 3, tileX: 50, tileY: 60 },
      ],
    });
    expect(findFoodPileAt(world, 30, 40)).toEqual({ foodPileId: 2, tileX: 30, tileY: 40 });
  });

  it('returns null when no pile is at the given tile', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 1, tileX: 10, tileY: 20 }],
    });
    expect(findFoodPileAt(world, 11, 20)).toBeNull();
  });

  it('returns null on an empty food piles array', () => {
    const world = makeWorld({ foodPiles: [] });
    expect(findFoodPileAt(world, 0, 0)).toBeNull();
  });

  it('returns first match when multiple piles share coords (edge case)', () => {
    const world = makeWorld({
      foodPiles: [
        { foodPileId: 1, tileX: 5, tileY: 5 },
        { foodPileId: 2, tileX: 5, tileY: 5 },
      ],
    });
    const result = findFoodPileAt(world, 5, 5);
    expect(result?.foodPileId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleSurfaceLeftClick — food pile mark
// ---------------------------------------------------------------------------

describe('handleSurfaceLeftClick — food pile mark', () => {
  it('pushes MarkFoodPileCommand for a pile at the clicked tile', () => {
    const world = makeWorld({
      tick: 5,
      foodPiles: [{ foodPileId: 7, tileX: 10, tileY: 20 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; tileX: number; tileY: number; issuedAtTick: number };
    expect(cmd.type).toBe('MarkFoodPile');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.tileX).toBe(10);
    expect(cmd.tileY).toBe(20);
    expect(cmd.issuedAtTick).toBe(5);
  });

  it('pushes no command when no food pile exists at the clicked tile', () => {
    const world = makeWorld({ foodPiles: [{ foodPileId: 1, tileX: 5, tileY: 5 }] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(6, 5, 64, 64);
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when activeView is underground', () => {
    const world = makeWorld({ foodPiles: [{ foodPileId: 1, tileX: 10, tileY: 20 }] });
    const vs = makeViewState('underground', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when pointer is over HUD TRIANGLE zone', () => {
    const world = makeWorld({ foodPiles: [{ foodPileId: 1, tileX: 10, tileY: 20 }] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    // HUD.TRIANGLE zone — use a point guaranteed inside it.
    const hudX = HUD.TRIANGLE.x + 5;
    const hudY = HUD.TRIANGLE.y + 5;
    handleSurfaceLeftClick(world, vs, hudX, hudY, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op while panInputState.spaceHeld is true (Space+left-drag is pan, not world action)', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 7, tileX: 10, tileY: 20 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);
    panInputState.spaceHeld = true;
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op while panInputState.isPanning is true (mid-pan left-click is pan continuation)', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 7, tileX: 10, tileY: 20 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);
    panInputState.isPanning = true;
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('is a no-op when tileX < 0 (out-of-bounds click)', () => {
    const world = makeWorld({ foodPiles: [] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    // Camera at x=64, vw=50 → left edge at tile (64-25)=39, screen 0
    // Pixel -1 → tileX = floor((-1 + (64-25)*16)/16) = floor(-1/16 + 39) = 38 which is valid
    // To get tileX<0, we need screenX such that floor(screenX/16 + (64-50/2)) < 0
    // tileX = floor((screenX + (camX - vw/2) * TS) / TS) < 0 when screenX + (64-25)*16 < 0
    // screenX < -624; use screenX=-640
    handleSurfaceLeftClick(world, vs, -640, 0, state);
    expect(world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleSurfaceLeftClick — ant-activity popup dismissal race
// ---------------------------------------------------------------------------

describe('handleSurfaceLeftClick — ant-activity popup dismissal must not fall through', () => {
  // Scenario reproduction:
  //   1. Player opens the HUD ant-activity popup by clicking `Ants`.
  //   2. Player clicks on the surface map to dismiss the popup.
  //   3. UIScene's pointerdown handler runs first, detects the outside click,
  //      calls requestHideAntActivityPanel() (pendingHide=true), and returns.
  //   4. surface-input's pointerdown handler runs second in the same Phaser
  //      dispatch — it consults isPointerOverHUD(screenX, screenY).
  //   5. With the race fix, pendingHide short-circuits isPointerOverHUD to
  //      return true regardless of (screenX, screenY), so handleSurfaceLeftClick
  //      early-returns without pushing a MarkFoodPile / SetRallyPoint command.
  it('does NOT push MarkFoodPile when pendingHide is set (popup click-away race)', async () => {
    const { showAntActivityPanel, requestHideAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({
      tick: 5,
      foodPiles: [{ foodPileId: 7, tileX: 10, tileY: 20 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);

    showAntActivityPanel();
    requestHideAntActivityPanel();
    try {
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('does NOT push SetRallyPoint on empty-tile fallthrough when pendingHide is set', async () => {
    const { showAntActivityPanel, requestHideAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({
      tick: 1,
      foodPiles: [], // empty tile → would normally trigger SetRallyPoint
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);

    showAntActivityPanel();
    requestHideAntActivityPanel();
    try {
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('does NOT push DesignateEntrance confirmation when pendingHide is set', async () => {
    const { showAntActivityPanel, requestHideAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({ tick: 3 });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(15, 30); // pending entrance preview at (15, 30)
    const { x, y } = tileToScreen(15, 30, 64, 64);

    showAntActivityPanel();
    requestHideAntActivityPanel();
    try {
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
      // Preview also preserved — a dismissal click should not eat the
      // player's pending entrance selection.
      expect(state.pendingEntranceTileX).toBe(15);
      expect(state.pendingEntranceTileY).toBe(30);
    } finally {
      hideAntActivityPanel();
    }
  });

  // World-input-first dispatch order: UIScene hasn't called
  // requestHideAntActivityPanel() yet, so pendingHide is still false while
  // the surface-input pointerdown runs. The click must still be consumed.
  // This is the race `isPointerOverHUD` now closes by masking on `visible`
  // alone (not just pendingHide).
  it('does NOT push MarkFoodPile when panel is visible and pendingHide=false (world-input-first race)', async () => {
    const { showAntActivityPanel, hideAntActivityPanel, antActivityPanelState } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({
      tick: 5,
      foodPiles: [{ foodPileId: 7, tileX: 10, tileY: 20 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);

    showAntActivityPanel();
    try {
      expect(antActivityPanelState.visible).toBe(true);
      expect(antActivityPanelState.pendingHide).toBe(false);
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('does NOT push SetRallyPoint when panel is visible and pendingHide=false (world-input-first race)', async () => {
    const { showAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({ tick: 1, foodPiles: [] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);

    showAntActivityPanel();
    try {
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('does NOT push DesignateEntrance confirmation when panel is visible and pendingHide=false (world-input-first race)', async () => {
    const { showAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({ tick: 3 });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(15, 30);
    const { x, y } = tileToScreen(15, 30, 64, 64);

    showAntActivityPanel();
    try {
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
      // Preview preserved — dismissal must not eat pending entrance state.
      expect(state.pendingEntranceTileX).toBe(15);
      expect(state.pendingEntranceTileY).toBe(30);
    } finally {
      hideAntActivityPanel();
    }
  });

  it('right-click ALSO no-ops when panel is visible and pendingHide=false (entrance preview guard)', async () => {
    // A right-click that would normally stage an entrance preview must be
    // suppressed while the panel is up, regardless of listener order.
    const { showAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const { handleSurfaceRightClick } = await import('./surface-input.js');
    const world = makeWorld({ tick: 4, foodPiles: [] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);

    showAntActivityPanel();
    try {
      handleSurfaceRightClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(0);
      expect(state.pendingEntranceTileX).toBeNull();
      expect(state.pendingEntranceTileY).toBeNull();
    } finally {
      hideAntActivityPanel();
    }
  });

  it('processes clicks normally after pendingHide is cleared (state cleanup)', async () => {
    const { showAntActivityPanel, hideAntActivityPanel } =
      await import('../render/ant-activity-panel-state.js');
    const world = makeWorld({
      tick: 5,
      foodPiles: [{ foodPileId: 7, tileX: 10, tileY: 20 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(10, 20, 64, 64);

    // Simulate a full open→dismiss→next-frame cycle.
    showAntActivityPanel();
    hideAntActivityPanel(); // simulates applyPendingAntActivityPanelHide at next frame
    try {
      handleSurfaceLeftClick(world, vs, x, y, state);
      expect(world.commandQueue).toHaveLength(1);
      const cmd = world.commandQueue[0] as { type: string };
      expect(cmd.type).toBe('MarkFoodPile');
    } finally {
      hideAntActivityPanel();
    }
  });
});

// ---------------------------------------------------------------------------
// handleSurfaceLeftClick — entrance designation confirmation
// ---------------------------------------------------------------------------

describe('handleSurfaceLeftClick — entrance designation confirmation', () => {
  it('pushes DesignateEntranceCommand and clears preview when clicked tile matches pending (X and Y)', () => {
    const world = makeWorld({ tick: 3 });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(15, 30); // pending entrance at tile (15, 30)
    const { x, y } = tileToScreen(15, 30, 64, 64);
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; surfaceTileX: number; surfaceTileY: number; issuedAtTick: number };
    expect(cmd.type).toBe('DesignateEntrance');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.surfaceTileX).toBe(15);
    expect(cmd.surfaceTileY).toBe(30);
    expect(cmd.issuedAtTick).toBe(3);
    expect(state.pendingEntranceTileX).toBeNull();
    expect(state.pendingEntranceTileY).toBeNull();
  });

  it('does NOT push DesignateEntrance when clicked tileX differs from pending', () => {
    const world = makeWorld({ foodPiles: [] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(15, 30); // pending entrance at (15, 30)
    const { x, y } = tileToScreen(20, 30, 64, 64); // click at tileX=20
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    // Preview persists (not cleared on mismatch)
    expect(state.pendingEntranceTileX).toBe(15);
    expect(state.pendingEntranceTileY).toBe(30);
  });

  it('does NOT push DesignateEntrance when clicked tileY differs from pending (same column, different row)', () => {
    // Phase 8.5 regression guard: this was the reported "preview shows on tile
    // A, but confirm fires on tile B in the same column" bug.
    const world = makeWorld({ foodPiles: [] });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(15, 30); // pending entrance at (15, 30)
    const { x, y } = tileToScreen(15, 45, 64, 64); // same column, row 45
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
    // Preview persists (not cleared on mismatch)
    expect(state.pendingEntranceTileX).toBe(15);
    expect(state.pendingEntranceTileY).toBe(30);
  });

  it('falls through to food-pile check when tileX does not match pending', () => {
    const world = makeWorld({
      foodPiles: [{ foodPileId: 99, tileX: 20, tileY: 30 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(15, 30); // pending entrance at (15, 30)
    const { x, y } = tileToScreen(20, 30, 64, 64); // click at food pile tileX=20 != 15
    handleSurfaceLeftClick(world, vs, x, y, state);
    // Should push MarkFoodPile (not DesignateEntrance)
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string };
    expect(cmd.type).toBe('MarkFoodPile');
    // Preview still persists
    expect(state.pendingEntranceTileX).toBe(15);
    expect(state.pendingEntranceTileY).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// handleSurfaceRightClick
// ---------------------------------------------------------------------------

describe('handleSurfaceRightClick', () => {
  it('sets pendingEntranceTileX and pendingEntranceTileY to the clicked tile', () => {
    const world = makeWorld({ surfaceWidth: 128, surfaceHeight: 128 });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(40, 50, 64, 64);
    handleSurfaceRightClick(world, vs, x, y, state);
    expect(state.pendingEntranceTileX).toBe(40);
    expect(state.pendingEntranceTileY).toBe(50);
  });

  it('is a no-op when activeView is underground', () => {
    const world = makeWorld();
    const vs = makeViewState('underground', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(40, 50, 64, 64);
    handleSurfaceRightClick(world, vs, x, y, state);
    expect(state.pendingEntranceTileX).toBeNull();
  });

  it('is a no-op when pointer is over HUD', () => {
    const world = makeWorld();
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    handleSurfaceRightClick(world, vs, HUD.STATS.x + 5, HUD.STATS.y + 5, state);
    expect(state.pendingEntranceTileX).toBeNull();
  });

  it('is a no-op when tile coords are out of bounds (tileX < 0)', () => {
    const world = makeWorld();
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    handleSurfaceRightClick(world, vs, -640, 0, state);
    expect(state.pendingEntranceTileX).toBeNull();
  });

  it('overwrites an existing pending entrance with the new tile (X and Y)', () => {
    const world = makeWorld({ surfaceWidth: 128, surfaceHeight: 128 });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(10, 20); // previous pending at (10, 20)
    const { x, y } = tileToScreen(40, 50, 64, 64);
    handleSurfaceRightClick(world, vs, x, y, state);
    expect(state.pendingEntranceTileX).toBe(40);
    expect(state.pendingEntranceTileY).toBe(50);
  });

  // Phase 9 playability bug: right-clicking a food pile was previewing an
  // entrance box even though DesignateEntrance rejects food-pile tiles. The
  // preview is now suppressed on any tile the sim will reject.
  it('does NOT set entrance preview on a food pile tile', () => {
    const world = makeWorld({
      surfaceWidth: 128,
      surfaceHeight: 128,
      foodPiles: [{ foodPileId: 1, tileX: 40, tileY: 50 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(40, 50, 64, 64);
    handleSurfaceRightClick(world, vs, x, y, state);
    expect(state.pendingEntranceTileX).toBeNull();
    expect(state.pendingEntranceTileY).toBeNull();
  });

  it('does NOT set entrance preview on a tile already occupied by an entrance', () => {
    const colony = makeColony({ entrances: [{ surfaceTileX: 40, surfaceTileY: 50 }] });
    const world = makeWorld({
      surfaceWidth: 128,
      surfaceHeight: 128,
      colonies: { [PLAYER_COLONY_ID]: colony } as unknown as WorldState['colonies'],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState();
    const { x, y } = tileToScreen(40, 50, 64, 64);
    handleSurfaceRightClick(world, vs, x, y, state);
    expect(state.pendingEntranceTileX).toBeNull();
    expect(state.pendingEntranceTileY).toBeNull();
  });

  it('previewing an invalid tile does NOT clear an existing valid preview', () => {
    const world = makeWorld({
      surfaceWidth: 128,
      surfaceHeight: 128,
      foodPiles: [{ foodPileId: 1, tileX: 40, tileY: 50 }],
    });
    const vs = makeViewState('surface', 64, 64);
    const state = makeState(10, 20); // prior valid preview
    const { x, y } = tileToScreen(40, 50, 64, 64);
    handleSurfaceRightClick(world, vs, x, y, state);
    // Invalid click is a no-op — prior preview survives for the player's follow-up
    expect(state.pendingEntranceTileX).toBe(10);
    expect(state.pendingEntranceTileY).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// isEmptySurfaceTile
// ---------------------------------------------------------------------------

describe('isEmptySurfaceTile', () => {
  it('returns true for a tile within bounds with no food pile or entrance', () => {
    const world = makeWorld({ surfaceWidth: 128, surfaceHeight: 4 });
    expect(isEmptySurfaceTile(world, 10, 1)).toBe(true);
  });

  it('returns false when tile has a food pile', () => {
    const world = makeWorld({
      surfaceWidth: 128, surfaceHeight: 4,
      foodPiles: [{ foodPileId: 1, tileX: 10, tileY: 1 }],
    });
    expect(isEmptySurfaceTile(world, 10, 1)).toBe(false);
  });

  it('returns false when tile is a colony entrance (plain-object colonies check)', () => {
    const colony = makeColony({ entrances: [{ surfaceTileX: 20, surfaceTileY: 0 }] });
    const world = makeWorld({
      surfaceWidth: 128, surfaceHeight: 4,
      colonies: { [PLAYER_COLONY_ID]: colony } as unknown as WorldState['colonies'],
    });
    expect(isEmptySurfaceTile(world, 20, 0)).toBe(false);
  });

  it('returns false when tileX < 0 (out of bounds)', () => {
    const world = makeWorld({ surfaceWidth: 128, surfaceHeight: 4 });
    expect(isEmptySurfaceTile(world, -1, 1)).toBe(false);
  });

  it('returns false when tile is beyond surface width', () => {
    const world = makeWorld({ surfaceWidth: 128, surfaceHeight: 4 });
    expect(isEmptySurfaceTile(world, 128, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// surface-input rally-point fall-through (SURF-04)
// ---------------------------------------------------------------------------

describe('surface-input rally-point fall-through (SURF-04)', () => {
  it('left-click on empty surface tile pushes SetRallyPointCommand for player colony', () => {
    const world = makeWorld({ tick: 5, surfaceWidth: 128, surfaceHeight: 4 });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    // Click on tile (10, 1) — within surface bounds, no food pile, no entrance
    const { x, y } = tileToScreen(10, 1, 64, 2);
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; tileX: number; tileY: number; issuedAtTick: number };
    expect(cmd.type).toBe('SetRallyPoint');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.tileX).toBe(10);
    expect(cmd.tileY).toBe(1);
    expect(cmd.issuedAtTick).toBe(5);
  });

  it('pushed SetRallyPointCommand carries issuedAtTick = world.tick', () => {
    const world = makeWorld({ tick: 42, surfaceWidth: 128, surfaceHeight: 4 });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    const { x, y } = tileToScreen(5, 1, 64, 2);
    handleSurfaceLeftClick(world, vs, x, y, state);
    const cmd = world.commandQueue[0] as { issuedAtTick: number };
    expect(cmd.issuedAtTick).toBe(42);
  });

  it('does NOT push SetRallyPoint when tile has a food pile', () => {
    const world = makeWorld({
      tick: 0,
      surfaceWidth: 128, surfaceHeight: 4,
      foodPiles: [{ foodPileId: 1, tileX: 10, tileY: 1 }],
    });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    const { x, y } = tileToScreen(10, 1, 64, 2);
    handleSurfaceLeftClick(world, vs, x, y, state);
    // Should push MarkFoodPile, not SetRallyPoint
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string };
    expect(cmd.type).toBe('MarkFoodPile');
  });

  it('does NOT push SetRallyPoint when tile is an existing entrance', () => {
    const colony = makeColony({ entrances: [{ surfaceTileX: 10, surfaceTileY: 0 }] });
    const world = makeWorld({
      tick: 0,
      surfaceWidth: 128, surfaceHeight: 4,
      colonies: { [PLAYER_COLONY_ID]: colony } as unknown as WorldState['colonies'],
    });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    const { x, y } = tileToScreen(10, 0, 64, 2);
    handleSurfaceLeftClick(world, vs, x, y, state);
    expect(world.commandQueue).toHaveLength(0);
  });

  it('right-click on current rallyPoint pushes ClearRallyPointCommand', () => {
    const colony = makeColony({ rallyPoint: { tileX: 15, tileY: 1 } });
    const world = makeWorld({
      tick: 7,
      surfaceWidth: 128, surfaceHeight: 4,
      colonies: { [PLAYER_COLONY_ID]: colony } as unknown as WorldState['colonies'],
    });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    const { x, y } = tileToScreen(15, 1, 64, 2);
    handleSurfaceRightClick(world, vs, x, y, state, PLAYER_COLONY_ID as ColonyId);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; issuedAtTick: number };
    expect(cmd.type).toBe('ClearRallyPoint');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.issuedAtTick).toBe(7);
  });

  it('right-click elsewhere does NOT clear rally (sets entrance preview instead)', () => {
    const colony = makeColony({ rallyPoint: { tileX: 15, tileY: 1 } });
    const world = makeWorld({
      surfaceWidth: 128, surfaceHeight: 4,
      colonies: { [PLAYER_COLONY_ID]: colony } as unknown as WorldState['colonies'],
    });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    // Click at different tile (20, 1) — not the rally point
    const { x, y } = tileToScreen(20, 1, 64, 2);
    handleSurfaceRightClick(world, vs, x, y, state, PLAYER_COLONY_ID as ColonyId);
    expect(world.commandQueue).toHaveLength(0);
    // Should set entrance preview instead
    expect(state.pendingEntranceTileX).toBe(20);
  });

  it('empty-tile click has colonyId === playerColonyId (never AI colonyId)', () => {
    const world = makeWorld({ tick: 0, surfaceWidth: 128, surfaceHeight: 4 });
    const vs = makeViewState('surface', 64, 2);
    const state = makeState();
    const { x, y } = tileToScreen(10, 1, 64, 2);
    handleSurfaceLeftClick(world, vs, x, y, state);
    if (world.commandQueue.length > 0) {
      const cmd = world.commandQueue[0] as { colonyId: number };
      expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    }
  });

  it('handleSetRallyPoint pushes SetRallyPointCommand with correct fields', () => {
    const world = makeWorld({ tick: 3 });
    handleSetRallyPoint(world, 7, 2, PLAYER_COLONY_ID as ColonyId);
    expect(world.commandQueue).toHaveLength(1);
    const cmd = world.commandQueue[0] as { type: string; colonyId: number; tileX: number; tileY: number; issuedAtTick: number };
    expect(cmd.type).toBe('SetRallyPoint');
    expect(cmd.colonyId).toBe(PLAYER_COLONY_ID);
    expect(cmd.tileX).toBe(7);
    expect(cmd.tileY).toBe(2);
    expect(cmd.issuedAtTick).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resetSurfaceInputState — Phase 9 session reset
// ---------------------------------------------------------------------------

describe('resetSurfaceInputState', () => {
  it('clears a pending entrance-preview set by a prior right-click', () => {
    const state: SurfaceInputState = { pendingEntranceTileX: 12, pendingEntranceTileY: 3 };
    resetSurfaceInputState(state);
    expect(state.pendingEntranceTileX).toBeNull();
    expect(state.pendingEntranceTileY).toBeNull();
  });

  it('preserves the state object identity (mutates in place)', () => {
    // Required so registerSurfaceInput's closure keeps seeing the same state.
    const state: SurfaceInputState = { pendingEntranceTileX: 1, pendingEntranceTileY: 1 };
    const ref = state;
    resetSurfaceInputState(state);
    expect(state).toBe(ref);
  });

  it('is idempotent on an already-cleared state', () => {
    const state: SurfaceInputState = { pendingEntranceTileX: null, pendingEntranceTileY: null };
    resetSurfaceInputState(state);
    expect(state.pendingEntranceTileX).toBeNull();
    expect(state.pendingEntranceTileY).toBeNull();
  });

  it('restart simulation: after reset a fresh right-click still sets preview', () => {
    const state: SurfaceInputState = { pendingEntranceTileX: 5, pendingEntranceTileY: 5 };
    resetSurfaceInputState(state);
    const world = makeWorld({ surfaceWidth: 128, surfaceHeight: 64 });
    const vs = makeViewState('surface', 64, 32);
    const tile = tileToScreen(20, 10, 64, 32);
    handleSurfaceRightClick(world, vs, tile.x, tile.y, state);
    expect(state.pendingEntranceTileX).toBe(20);
    expect(state.pendingEntranceTileY).toBe(10);
  });
});
