// camera-input.test.ts — Vitest unit tests for src/input/camera-input.ts
//
// Stage 1 controls rework (issue #18): Space-pan is gone (panInputState carries
// only `isPanning`); the new interactive HUD zones (TOOLS / HINTS / SPEED) are
// masked by isPointerOverHUD. registerDragPan handles middle-button only.
//
// Tests cover:
//   - isPointerOverHUD: each masked zone (incl. TOOLS / HINTS / SPEED) + misses
//   - isPointerOverHUD: underground-only colony toggle masking
//   - processCameraInput: keyboard pan (arrow + WASD), clamp after pan
//   - processCameraInput: suppressed while panInputState.isPanning
//   - registerDragPan: an in-flight middle-drag stops when isBlocked flips true
//     (Codex P2 — a modal opening mid-drag must suspend the pan, not just block
//     new drags)
//   - reset helpers

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPointerOverHUD,
  processCameraInput,
  registerDragPan,
  panInputState,
  resetPanInputState,
  resetDragState,
  type DragState,
  type PanInputs,
} from './camera-input.js';
import type * as Phaser from 'phaser';
import { TILE_SIZE_PX } from '../render/sprites.js';

beforeEach(() => {
  resetPanInputState();
});
import type { ViewState } from '../render/camera.js';
import { SURFACE_WORLD_PX_W } from '../render/camera.js';
import { makeCameraView, KEYBOARD_PAN_SPEED_PX_PER_SEC } from '../render/camera-adapter.js';
import { HUD, CANVAS_W } from '../render/sprites.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { hintStripState, resetHintStripState } from '../render/hint-strip-state.js';

// Stage 3b: the hint-strip visibility singleton gates HUD.HINTS masking. Reset
// it after each test so a hidden-legend case doesn't leak into its neighbors.
afterEach(() => {
  resetHintStripState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ViewState with world-pixel CameraView cameras centered on
 * (centerX, centerY) at DEFAULT_ZOOM (1). World-space camera model (issue #18
 * Stage 2): centerX/centerY are WORLD PIXELS, not tiles. Both cameras are
 * independent CameraView instances.
 */
function makeViewState(
  view: 'surface' | 'underground' = 'surface',
  centerX = 1024,
  centerY = 1024,
): ViewState {
  return {
    activeView: view,
    activeTool: view === 'surface' ? 'command' : 'dig',
    surfaceCamera: makeCameraView(centerX, centerY),
    undergroundCamera: makeCameraView(centerX, centerY),
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

  it('Stage 3b: drops HUD.HINTS from the mask when the legend is hidden, keeps TOOLS/SPEED', () => {
    const vs = makeViewState('surface');
    hintStripState.visible = false;
    const [hx, hy] = center(HUD.HINTS);
    // The freed legend band is no longer a dead input zone…
    expect(isPointerOverHUD(hx, hy, vs)).toBe(false);
    // …but the other interactive widgets stay masked.
    for (const rect of [HUD.TOOLS, HUD.SPEED]) {
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

// Time-based keyboard pan (issue #18 Stage 2): one frame at 60fps.
const DT_60FPS = 1 / 60;
// World-px the camera center moves per held direction at zoom 1, one 60fps frame:
// KEYBOARD_PAN_SPEED_PX_PER_SEC × dt ÷ zoom. (600/60 = 10 at zoom 1.)
const PAN_STEP_60FPS = (KEYBOARD_PAN_SPEED_PX_PER_SEC * DT_60FPS) / 1;
// Clamp half-window in world px at zoom 1: viewWorldWidth(1)/2 = CANVAS_W/2.
const HALF_VIEW_W_AT_ZOOM_1 = CANVAS_W / 2;

describe('processCameraInput', () => {
  it('pans left/right/up/down by the time-based step per held key (arrow keys)', () => {
    // Start well clear of the world edges so the clamp doesn't mask the pan delta.
    const vs = makeViewState('surface', 1000, 1000);
    processCameraInput(vs, makePanInputs({ leftDown: true }), DT_60FPS);
    // Left moves centerX in the −X direction by the time-based step.
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 - PAN_STEP_60FPS);

    const vs2 = makeViewState('surface', 1000, 1000);
    processCameraInput(vs2, makePanInputs({ downDown: true }), DT_60FPS);
    // Down moves centerY in the +Y direction by the same step.
    expect(vs2.surfaceCamera.centerY).toBeCloseTo(1000 + PAN_STEP_60FPS);
  });

  it('WASD pans identically to the arrow keys', () => {
    const vs = makeViewState('surface', 1000, 1000);
    processCameraInput(vs, makePanInputs({ wasdD: true }), DT_60FPS);
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 + PAN_STEP_60FPS);
  });

  it('is frame-rate independent: a 2× dt pans 2× as far', () => {
    const vs = makeViewState('surface', 1000, 1000);
    processCameraInput(vs, makePanInputs({ wasdD: true }), 2 * DT_60FPS);
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 + 2 * PAN_STEP_60FPS);
  });

  it('is suppressed while panInputState.isPanning is true (drag claims the camera)', () => {
    const vs = makeViewState('surface', 1000, 1000);
    panInputState.isPanning = true;
    processCameraInput(vs, makePanInputs({ leftDown: true }), DT_60FPS);
    expect(vs.surfaceCamera.centerX).toBe(1000); // unchanged
  });

  it('clamps the camera into world bounds after a pan', () => {
    // Push left hard against the world edge; clamp pins centerX at the half-window.
    const vs = makeViewState('surface', 0, 1000);
    processCameraInput(vs, makePanInputs({ leftDown: true }), DT_60FPS);
    expect(vs.surfaceCamera.centerX).toBeGreaterThanOrEqual(HALF_VIEW_W_AT_ZOOM_1);
    expect(vs.surfaceCamera.centerX).toBeLessThanOrEqual(
      SURFACE_WORLD_PX_W - HALF_VIEW_W_AT_ZOOM_1,
    );
  });
});

// ---------------------------------------------------------------------------
// registerDragPan — in-flight suspend when isBlocked flips true
// ---------------------------------------------------------------------------

/**
 * Minimal fake Phaser.Scene that captures the input handlers registerDragPan
 * registers (keyed by event name) so a test can dispatch synthetic pointer
 * events at them. Only the surface registerDragPan touches (scene.input.on) is
 * modelled.
 */
function makeFakeScene(): {
  scene: Phaser.Scene;
  emit: (event: string, pointer: unknown) => void;
} {
  const handlers = new Map<string, (pointer: unknown) => void>();
  const scene = {
    input: {
      on: (event: string, fn: (pointer: unknown) => void) => {
        handlers.set(event, fn);
      },
    },
  } as unknown as Phaser.Scene;
  const emit = (event: string, pointer: unknown): void => {
    handlers.get(event)?.(pointer);
  };
  return { scene, emit };
}

/** Fake middle-button pointer at (x, y). */
function middlePointer(x: number, y: number): Phaser.Input.Pointer {
  return { x, y, middleButtonDown: () => true } as unknown as Phaser.Input.Pointer;
}

describe('registerDragPan (middle-button)', () => {
  it('pans the active camera on a middle-button drag', () => {
    // Center clear of the clamp edges so the pan delta isn't masked by clamping.
    const vs = makeViewState('surface', 1000, 1000);
    const { scene, emit } = makeFakeScene();
    registerDragPan(scene, vs);
    // Non-HUD points (mid play-area, clear of every HUD rect).
    emit('pointerdown', middlePointer(400, 300));
    expect(panInputState.isPanning).toBe(true);
    emit('pointermove', middlePointer(400 + TILE_SIZE_PX, 300));
    // Pointer moved +TILE_SIZE_PX px in x → at zoom 1 the camera center pans
    // −delta/zoom = −TILE_SIZE_PX world px (drag-the-world: panByScreenDelta).
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 - TILE_SIZE_PX);
    emit('pointerup', middlePointer(400 + TILE_SIZE_PX, 300));
    expect(panInputState.isPanning).toBe(false);
  });

  // Codex P2: a modal (Esc menu / SavePrompt / GameOver) opening DURING an active
  // middle-drag must suspend the pan — not merely block new drags. isBlocked
  // flips true mid-gesture; the very next pointermove must release the drag and
  // stop moving the camera (pointermove calls releaseDrag() when isBlocked()).
  it('stops an in-flight middle-drag when isBlocked flips true mid-gesture', () => {
    const vs = makeViewState('surface', 1000, 1000);
    const { scene, emit } = makeFakeScene();
    const blocked = { value: false };
    registerDragPan(scene, vs, () => blocked.value);

    // Drag starts and pans while unblocked.
    emit('pointerdown', middlePointer(400, 300));
    emit('pointermove', middlePointer(400 + TILE_SIZE_PX, 300));
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 - TILE_SIZE_PX);
    expect(panInputState.isPanning).toBe(true);

    // Modal opens: isBlocked → true. The next pointermove must release the drag,
    // clearing isPanning and leaving the camera where it was (no further delta).
    blocked.value = true;
    emit('pointermove', middlePointer(400 + 5 * TILE_SIZE_PX, 300));
    expect(panInputState.isPanning).toBe(false);
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 - TILE_SIZE_PX); // unchanged since the block

    // A further move while still blocked is a no-op (drag is no longer active).
    emit('pointermove', middlePointer(400 + 9 * TILE_SIZE_PX, 300));
    expect(vs.surfaceCamera.centerX).toBeCloseTo(1000 - TILE_SIZE_PX);
    expect(panInputState.isPanning).toBe(false);
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
