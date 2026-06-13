// camera-input.test.ts — Vitest unit tests for src/input/camera-input.ts
//
// Stage 1 controls rework (issue #18): Space-pan is gone (panInputState carries
// only `isPanning`); the new interactive HUD zones (TOOLS / HINTS / SPEED) are
// masked by isPointerOverHUD. registerDragPan now handles middle-button only and
// is verified by the browser smoke test (Phaser scene events).
//
// Tests cover:
//   - isPointerOverHUD: each masked zone (incl. TOOLS / HINTS / SPEED) + misses
//   - isPointerOverHUD: underground-only colony toggle masking
//   - processCameraInput: keyboard pan (arrow + WASD), clamp after pan
//   - processCameraInput: suppressed while panInputState.isPanning
//   - reset helpers

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPointerOverHUD,
  processCameraInput,
  panInputState,
  resetPanInputState,
  resetDragState,
  type DragState,
  type PanInputs,
} from './camera-input.js';

beforeEach(() => {
  resetPanInputState();
});
import type { ViewState } from '../render/camera.js';
import {
  VIEWPORT_WIDTH_TILES,
  VIEWPORT_HEIGHT_TILES,
  CAMERA_SCROLL_SPEED,
} from '../render/camera.js';
import { HUD } from '../render/sprites.js';
import { SURFACE_GRID_WIDTH, PLAYER_COLONY_ID } from '../sim/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeViewState(
  view: 'surface' | 'underground' = 'surface',
  camX = 64,
  camY = 64,
): ViewState {
  return {
    activeView: view,
    activeTool: view === 'surface' ? 'command' : 'dig',
    surfaceCamera: {
      x: camX,
      y: camY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundCamera: {
      x: camX,
      y: camY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundVisited: false,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    showPheromoneOverlay: true,
  };
}

function makePanInputs(
  overrides: Partial<{
    leftDown: boolean;
    rightDown: boolean;
    upDown: boolean;
    downDown: boolean;
    wasdA: boolean;
    wasdD: boolean;
    wasdW: boolean;
    wasdS: boolean;
  }> = {},
): PanInputs {
  const opts = {
    leftDown: false,
    rightDown: false,
    upDown: false,
    downDown: false,
    wasdA: false,
    wasdD: false,
    wasdW: false,
    wasdS: false,
    ...overrides,
  };
  function key(isDown: boolean) {
    return { isDown } as unknown as import('phaser').Input.Keyboard.Key;
  }
  const cursors = {
    left: key(opts.leftDown),
    right: key(opts.rightDown),
    up: key(opts.upDown),
    down: key(opts.downDown),
  } as unknown as import('phaser').Types.Input.Keyboard.CursorKeys;
  const wasd = {
    W: key(opts.wasdW),
    A: key(opts.wasdA),
    S: key(opts.wasdS),
    D: key(opts.wasdD),
  };
  const dragState = { isDragging: false, lastX: 0, lastY: 0, active: false };
  return { cursors, wasd, dragState };
}

/** Center point of a HUD rect. */
function center(rect: { x: number; y: number; w: number; h: number }): [number, number] {
  return [rect.x + rect.w / 2, rect.y + rect.h / 2];
}

// ---------------------------------------------------------------------------
// isPointerOverHUD
// ---------------------------------------------------------------------------

describe('isPointerOverHUD', () => {
  it('masks STATS / TRIANGLE / MINIMAP / VIEW_TOGGLE', () => {
    const vs = makeViewState('surface');
    for (const rect of [HUD.STATS, HUD.TRIANGLE, HUD.MINIMAP, HUD.VIEW_TOGGLE]) {
      const [x, y] = center(rect);
      expect(isPointerOverHUD(x, y, vs)).toBe(true);
    }
  });

  it('masks the Stage 1 interactive zones: TOOLS, HINTS, and SPEED', () => {
    const vs = makeViewState('surface');
    for (const rect of [HUD.TOOLS, HUD.HINTS, HUD.SPEED]) {
      const [x, y] = center(rect);
      expect(isPointerOverHUD(x, y, vs)).toBe(true);
    }
  });

  it('returns false for a clearly-empty world point', () => {
    const vs = makeViewState('surface');
    // A point in the mid-canvas play area clear of every rect.
    expect(isPointerOverHUD(400, 300, vs)).toBe(false);
  });

  it('uses a half-open inclusion rule [x, x+w) × [y, y+h)', () => {
    const vs = makeViewState('surface');
    // Top-left corner is inside.
    expect(isPointerOverHUD(HUD.TOOLS.x, HUD.TOOLS.y, vs)).toBe(true);
    // The exclusive right/bottom edge is outside.
    expect(isPointerOverHUD(HUD.TOOLS.x + HUD.TOOLS.w, HUD.TOOLS.y, vs)).toBe(false);
    expect(isPointerOverHUD(HUD.TOOLS.x, HUD.TOOLS.y + HUD.TOOLS.h, vs)).toBe(false);
  });

  it('masks UNDERGROUND_COLONY_TOGGLE only on the underground view', () => {
    const [x, y] = center(HUD.UNDERGROUND_COLONY_TOGGLE);
    expect(isPointerOverHUD(x, y, makeViewState('surface'))).toBe(false);
    expect(isPointerOverHUD(x, y, makeViewState('underground'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processCameraInput
// ---------------------------------------------------------------------------

describe('processCameraInput', () => {
  it('pans left/right/up/down by CAMERA_SCROLL_SPEED per held key (arrow keys)', () => {
    const vs = makeViewState('surface', 100, 100);
    processCameraInput(vs, makePanInputs({ leftDown: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(100 - CAMERA_SCROLL_SPEED);

    const vs2 = makeViewState('surface', 100, 100);
    processCameraInput(vs2, makePanInputs({ downDown: true }));
    expect(vs2.surfaceCamera.y).toBeCloseTo(100 + CAMERA_SCROLL_SPEED);
  });

  it('WASD pans identically to the arrow keys', () => {
    const vs = makeViewState('surface', 100, 100);
    processCameraInput(vs, makePanInputs({ wasdD: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(100 + CAMERA_SCROLL_SPEED);
  });

  it('is suppressed while panInputState.isPanning is true (drag claims the camera)', () => {
    const vs = makeViewState('surface', 100, 100);
    panInputState.isPanning = true;
    processCameraInput(vs, makePanInputs({ leftDown: true }));
    expect(vs.surfaceCamera.x).toBe(100); // unchanged
  });

  it('clamps the camera into world bounds after a pan', () => {
    // Push left hard against the world edge; clamp pins x at half-viewport.
    const vs = makeViewState('surface', 0, 100);
    processCameraInput(vs, makePanInputs({ leftDown: true }));
    expect(vs.surfaceCamera.x).toBeGreaterThanOrEqual(VIEWPORT_WIDTH_TILES / 2);
    expect(vs.surfaceCamera.x).toBeLessThanOrEqual(SURFACE_GRID_WIDTH - VIEWPORT_WIDTH_TILES / 2);
  });
});

// ---------------------------------------------------------------------------
// reset helpers
// ---------------------------------------------------------------------------

describe('reset helpers', () => {
  it('resetPanInputState clears isPanning', () => {
    panInputState.isPanning = true;
    resetPanInputState();
    expect(panInputState.isPanning).toBe(false);
  });

  it('resetDragState clears the drag fields in place', () => {
    const ds: DragState = { isDragging: true, lastX: 42, lastY: 99, active: true };
    const ref = ds;
    resetDragState(ds);
    expect(ds).toBe(ref);
    expect(ds).toEqual({ isDragging: false, lastX: 0, lastY: 0, active: false });
  });
});
