// camera-input.test.ts — Vitest unit tests for src/input/camera-input.ts
//
// Tests cover:
//   - isPointerOverHUD: boundary conditions for each HUD zone
//   - processCameraInput: keyboard pan (arrow + WASD), clamp after pan
//   - processCameraInput: dual-axis surface vs underground world dimensions
//   - processCameraInput: edge-pan is NOT fired (Phase 8.5 regression guards)
//
// registerDragPan involves Phaser scene events — verified by browser smoke test only.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPointerOverHUD,
  processCameraInput,
  panInputState,
  resetPanInputStateForTests,
  resetPanInputState,
  resetDragState,
  type DragState,
  type PanInputs,
} from './camera-input.js';

beforeEach(() => {
  resetPanInputStateForTests();
});
import type { ViewState } from '../render/camera.js';
import {
  VIEWPORT_WIDTH_TILES,
  VIEWPORT_HEIGHT_TILES,
  CAMERA_SCROLL_SPEED,
} from '../render/camera.js';
import { HUD } from '../render/sprites.js';
import {
  UNDERGROUND_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PLAYER_COLONY_ID,
} from '../sim/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ViewState for tests. */
function makeViewState(
  view: 'surface' | 'underground' = 'surface',
  camX = 64,
  camY = 64,
): ViewState {
  return {
    activeView: view,
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
  };
}

/** Build a minimal mock PanInputs with all keys up. */
function makePanInputs(overrides: Partial<{
  leftDown: boolean;
  rightDown: boolean;
  upDown: boolean;
  downDown: boolean;
  wasdA: boolean;
  wasdD: boolean;
  wasdW: boolean;
  wasdS: boolean;
}> = {}): PanInputs {
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
    left:  key(opts.leftDown),
    right: key(opts.rightDown),
    up:    key(opts.upDown),
    down:  key(opts.downDown),
  } as unknown as import('phaser').Types.Input.Keyboard.CursorKeys;

  const wasd = {
    W: key(opts.wasdW),
    A: key(opts.wasdA),
    S: key(opts.wasdS),
    D: key(opts.wasdD),
  };

  const dragState = { isDragging: false, lastX: 0, lastY: 0, active: false };

  return {
    cursors,
    wasd,
    dragState,
  };
}

// ---------------------------------------------------------------------------
// isPointerOverHUD
// ---------------------------------------------------------------------------

describe('isPointerOverHUD', () => {
  describe('STATS zone (x:8, y:8, w:200, h:24)', () => {
    it('returns true for point inside STATS', () => {
      expect(isPointerOverHUD(10, 10)).toBe(true);
    });
    it('returns true for top-left corner of STATS', () => {
      expect(isPointerOverHUD(HUD.STATS.x, HUD.STATS.y)).toBe(true);
    });
    it('returns false for point one pixel above STATS', () => {
      expect(isPointerOverHUD(10, HUD.STATS.y - 1)).toBe(false);
    });
    it('returns false for point one pixel left of STATS', () => {
      expect(isPointerOverHUD(HUD.STATS.x - 1, 10)).toBe(false);
    });
    it('returns false for point at right edge (exclusive)', () => {
      // Right edge: x + w = 8 + 200 = 208 → 208 is outside
      expect(isPointerOverHUD(HUD.STATS.x + HUD.STATS.w, HUD.STATS.y)).toBe(false);
    });
    it('returns false for point at bottom edge (exclusive)', () => {
      // Bottom edge: y + h = 8 + 24 = 32 → 32 is outside
      expect(isPointerOverHUD(HUD.STATS.x, HUD.STATS.y + HUD.STATS.h)).toBe(false);
    });
    it('returns true for point at (right-1, bottom-1) inside STATS', () => {
      expect(isPointerOverHUD(
        HUD.STATS.x + HUD.STATS.w - 1,
        HUD.STATS.y + HUD.STATS.h - 1,
      )).toBe(true);
    });
  });

  describe('TRIANGLE zone', () => {
    it('returns true for point inside TRIANGLE', () => {
      expect(isPointerOverHUD(HUD.TRIANGLE.x + 5, HUD.TRIANGLE.y + 5)).toBe(true);
    });
    it('returns false for point outside TRIANGLE', () => {
      expect(isPointerOverHUD(HUD.TRIANGLE.x - 1, HUD.TRIANGLE.y + 5)).toBe(false);
    });
  });

  describe('MINIMAP zone', () => {
    it('returns true for point inside MINIMAP', () => {
      expect(isPointerOverHUD(HUD.MINIMAP.x + 1, HUD.MINIMAP.y + 1)).toBe(true);
    });
    it('returns false for point below MINIMAP', () => {
      expect(isPointerOverHUD(HUD.MINIMAP.x + 1, HUD.MINIMAP.y + HUD.MINIMAP.h)).toBe(false);
    });
  });

  describe('VIEW_TOGGLE zone', () => {
    it('returns true for point inside VIEW_TOGGLE', () => {
      expect(isPointerOverHUD(HUD.VIEW_TOGGLE.x + 5, HUD.VIEW_TOGGLE.y + 5)).toBe(true);
    });
  });

  describe('UNDERGROUND_COLONY_TOGGLE zone (issue #14)', () => {
    // Helper: a minimal viewState fixture for the conditional-mask path.
    function vs(activeView: 'surface' | 'underground'): import('../render/camera.js').ViewState {
      return {
        activeView,
        surfaceCamera: { x: 0, y: 0, viewportWidth: 1, viewportHeight: 1 },
        undergroundCamera: { x: 0, y: 0, viewportWidth: 1, viewportHeight: 1 },
        undergroundVisited: true,
        activeUndergroundColonyId: 1,
      };
    }

    it('masks the colony-toggle zone ONLY when activeView === underground', () => {
      const inside = [HUD.UNDERGROUND_COLONY_TOGGLE.x + 5, HUD.UNDERGROUND_COLONY_TOGGLE.y + 5] as const;
      // Underground view → the toggle is rendered → click zone is masked.
      expect(isPointerOverHUD(inside[0], inside[1], vs('underground'))).toBe(true);
      // Surface view → the toggle is invisible → masking it would create a
      // dead zone above the minimap. Click zone must NOT be masked.
      expect(isPointerOverHUD(inside[0], inside[1], vs('surface'))).toBe(false);
      // Legacy / no-viewState path stays unmasked too (safe default).
      expect(isPointerOverHUD(inside[0], inside[1])).toBe(false);
    });

    it('returns false for a point above the colony-toggle button', () => {
      expect(isPointerOverHUD(
        HUD.UNDERGROUND_COLONY_TOGGLE.x + 5,
        HUD.UNDERGROUND_COLONY_TOGGLE.y - 1,
        vs('underground'),
      )).toBe(false);
    });
  });

  describe('Phase 9 reservation zones (intentionally unmasked in Phase 8)', () => {
    it('does NOT mask SAVE_ICON — Phase 8 renders nothing there, so masking creates an invisible dead zone', () => {
      expect(isPointerOverHUD(HUD.SAVE_ICON.x + 5, HUD.SAVE_ICON.y + 5)).toBe(false);
    });
    it('does NOT mask SPEED — Phase 8 renders nothing there, so masking creates an invisible dead zone', () => {
      expect(isPointerOverHUD(HUD.SPEED.x + 5, HUD.SPEED.y + 5)).toBe(false);
    });
  });

  describe('mid-canvas point (no zone)', () => {
    it('returns false for point in center of canvas with no HUD zone', () => {
      expect(isPointerOverHUD(400, 300)).toBe(false);
    });
  });

  describe('ant-activity popup — full-canvas mask while panel is open', () => {
    // While the ant-activity popup is visible (or already pending dismissal),
    // isPointerOverHUD must treat the ENTIRE canvas as HUD. Reason: UIScene's
    // pointerdown handler and world-input pointerdown handlers fire on the
    // same Phaser event, cross-scene dispatch order is not guaranteed, and
    // the first outside click must never also become a world action. Masking
    // both `visible` and `pendingHide` closes both listener orderings.
    // See ant-activity-panel-state.ts.
    //
    // Imports are scoped to this block to keep the existing test cases using
    // only the original import set.
    it('does NOT mask the panel rect when panel is hidden', async () => {
      const { antActivityPanelState, hideAntActivityPanel } =
        await import('../render/ant-activity-panel-state.js');
      const { ANT_ACTIVITY_PANEL } = await import('../render/ant-activity.js');
      hideAntActivityPanel();
      expect(antActivityPanelState.visible).toBe(false);
      // Panel rect is safely outside every other HUD zone, so this is a
      // clean conditional-mask test.
      expect(isPointerOverHUD(
        ANT_ACTIVITY_PANEL.x + 5,
        ANT_ACTIVITY_PANEL.y + 5,
      )).toBe(false);
    });

    it('masks the panel rect when panel is visible', async () => {
      const { showAntActivityPanel, hideAntActivityPanel } =
        await import('../render/ant-activity-panel-state.js');
      const { ANT_ACTIVITY_PANEL } = await import('../render/ant-activity.js');
      showAntActivityPanel();
      try {
        expect(isPointerOverHUD(
          ANT_ACTIVITY_PANEL.x + 5,
          ANT_ACTIVITY_PANEL.y + 5,
        )).toBe(true);
      } finally {
        hideAntActivityPanel();
      }
    });

    it('masks every screen position while panel is visible (world-input-first race guard)', async () => {
      // Regression test for the world-input-first dispatch ordering. If a
      // world-input pointerdown handler runs BEFORE UIScene gets a chance to
      // call requestHideAntActivityPanel(), `pendingHide` is still false.
      // The click must still be consumed — otherwise it leaks through as a
      // food mark / rally placement / entrance designation / dig mark, and
      // UIScene would then also dismiss the popup, so one physical click
      // produces both a world action AND a dismissal. Masking on `visible`
      // alone forces the world handler to drop the click regardless of
      // listener order.
      const {
        showAntActivityPanel,
        hideAntActivityPanel,
        antActivityPanelState,
      } = await import('../render/ant-activity-panel-state.js');
      showAntActivityPanel();
      try {
        expect(antActivityPanelState.visible).toBe(true);
        expect(antActivityPanelState.pendingHide).toBe(false);
        // Deep middle of the world map — must be masked.
        expect(isPointerOverHUD(400, 300)).toBe(true);
        // A point near a map edge — also masked.
        expect(isPointerOverHUD(50, 300)).toBe(true);
        // A point over an empty region of the top HUD strip — masked.
        expect(isPointerOverHUD(600, 4)).toBe(true);
      } finally {
        hideAntActivityPanel();
      }
    });

    it('masks every screen position while pendingHide is set (UIScene-first race guard)', async () => {
      // Regression test for the UIScene-first dispatch ordering. UIScene sees
      // the outside click, calls requestHideAntActivityPanel() (pendingHide=
      // true), and returns. A subsequent world-input handler running later
      // in the SAME Phaser dispatch consults isPointerOverHUD with the raw
      // screen coords; those coords may be anywhere on the map.
      const {
        showAntActivityPanel,
        requestHideAntActivityPanel,
        hideAntActivityPanel,
        antActivityPanelState,
      } = await import('../render/ant-activity-panel-state.js');
      const { ANT_ACTIVITY_PANEL } = await import('../render/ant-activity.js');
      showAntActivityPanel();
      requestHideAntActivityPanel();
      try {
        expect(antActivityPanelState.visible).toBe(true);
        expect(antActivityPanelState.pendingHide).toBe(true);
        // Panel rect itself — masked.
        expect(isPointerOverHUD(
          ANT_ACTIVITY_PANEL.x + 5,
          ANT_ACTIVITY_PANEL.y + 5,
        )).toBe(true);
        // Deep middle of the world map — must ALSO be masked.
        expect(isPointerOverHUD(400, 300)).toBe(true);
        // A point near a map edge — also masked.
        expect(isPointerOverHUD(50, 300)).toBe(true);
      } finally {
        hideAntActivityPanel();
      }
    });

    it('still flags Stats / View / Minimap / Triangle zones while panel is visible (HUD hit-rects preserved)', async () => {
      // Sanity: UIScene checks its own HUD hit-rects directly (it does not
      // consult isPointerOverHUD for its own dispatch), but isPointerOverHUD
      // is also used by drag-pan to decide whether a pointerdown is a pan
      // trigger. These zones must keep reporting true while the panel is up.
      const { showAntActivityPanel, hideAntActivityPanel } =
        await import('../render/ant-activity-panel-state.js');
      showAntActivityPanel();
      try {
        expect(isPointerOverHUD(HUD.STATS.x + 5, HUD.STATS.y + 5)).toBe(true);
        expect(isPointerOverHUD(HUD.VIEW_TOGGLE.x + 5, HUD.VIEW_TOGGLE.y + 5)).toBe(true);
        expect(isPointerOverHUD(HUD.MINIMAP.x + 5, HUD.MINIMAP.y + 5)).toBe(true);
        expect(isPointerOverHUD(HUD.TRIANGLE.x + 5, HUD.TRIANGLE.y + 5)).toBe(true);
      } finally {
        hideAntActivityPanel();
      }
    });

    it('restores normal masking after the panel is hidden', async () => {
      const { showAntActivityPanel, hideAntActivityPanel, antActivityPanelState } =
        await import('../render/ant-activity-panel-state.js');
      showAntActivityPanel();
      hideAntActivityPanel();
      expect(antActivityPanelState.visible).toBe(false);
      expect(antActivityPanelState.pendingHide).toBe(false);
      // Mid-canvas — no longer masked.
      expect(isPointerOverHUD(400, 300)).toBe(false);
      // HUD zones — still masked as usual.
      expect(isPointerOverHUD(HUD.STATS.x + 5, HUD.STATS.y + 5)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// processCameraInput — keyboard pan
// ---------------------------------------------------------------------------

describe('processCameraInput — keyboard pan', () => {
  it('moves camera left by CAMERA_SCROLL_SPEED when left arrow is down', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ leftDown: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(64 - CAMERA_SCROLL_SPEED);
    expect(vs.surfaceCamera.y).toBeCloseTo(64);
  });

  it('moves camera right by CAMERA_SCROLL_SPEED when right arrow is down', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ rightDown: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(64 + CAMERA_SCROLL_SPEED);
  });

  it('moves camera up by CAMERA_SCROLL_SPEED when up arrow is down', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ upDown: true }));
    expect(vs.surfaceCamera.y).toBeCloseTo(64 - CAMERA_SCROLL_SPEED);
  });

  it('moves camera down by CAMERA_SCROLL_SPEED when down arrow is down', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ downDown: true }));
    expect(vs.surfaceCamera.y).toBeCloseTo(64 + CAMERA_SCROLL_SPEED);
  });

  it('WASD A also pans left', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ wasdA: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(64 - CAMERA_SCROLL_SPEED);
  });

  it('left arrow AND wasd.A simultaneously decrements camera.x by ONE CAMERA_SCROLL_SPEED (|| semantics)', () => {
    // Both down → single decrement (OR, not sum)
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ leftDown: true, wasdA: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(64 - CAMERA_SCROLL_SPEED);
  });

  it('WASD D pans right', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ wasdD: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(64 + CAMERA_SCROLL_SPEED);
  });

  it('WASD W pans up', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ wasdW: true }));
    expect(vs.surfaceCamera.y).toBeCloseTo(64 - CAMERA_SCROLL_SPEED);
  });

  it('WASD S pans down', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs({ wasdS: true }));
    expect(vs.surfaceCamera.y).toBeCloseTo(64 + CAMERA_SCROLL_SPEED);
  });

  it('no keys down → camera unchanged (after clamp keeps it in place)', () => {
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs());
    expect(vs.surfaceCamera.x).toBeCloseTo(64);
    expect(vs.surfaceCamera.y).toBeCloseTo(64);
  });
});

// ---------------------------------------------------------------------------
// processCameraInput — edge-pan is retired (Phase 8.5)
// ---------------------------------------------------------------------------
//
// Regression guard: processCameraInput no longer consumes pointer position or
// canvas dimensions. Calling it with only keyboard inputs must not move the
// camera based on cursor proximity to any edge. These tests exercise the
// specific historical edge-band positions to make sure nothing reintroduces
// edge-pan silently.

describe('processCameraInput — edge-pan is retired (Phase 8.5 regression guard)', () => {
  it('does NOT pan even when the pointer would historically have been in the left edge band', () => {
    // We can't pass a pointer anymore — the only way to see the regression is
    // to confirm that with all keys up the camera stays put.
    const vs = makeViewState('surface', 64, 64);
    processCameraInput(vs, makePanInputs());
    expect(vs.surfaceCamera.x).toBeCloseTo(64);
    expect(vs.surfaceCamera.y).toBeCloseTo(64);
  });

  it('PanInputs no longer has pointer / canvasW / canvasH fields', () => {
    const inputs = makePanInputs();
    expect('pointer' in inputs).toBe(false);
    expect('canvasW' in inputs).toBe(false);
    expect('canvasH' in inputs).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processCameraInput — clamp after pan
// ---------------------------------------------------------------------------

describe('processCameraInput — clamp after pan', () => {
  it('clamps camera to minimum x after left pan near the west edge', () => {
    // viewportWidth=50 → min cam.x = 25
    // Start at cam.x=25.3, left key down → 24.8 → clamp → 25.0
    const vs = makeViewState('surface', 25.3, 64);
    processCameraInput(vs, makePanInputs({ leftDown: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(25.0);
  });

  it('clamps camera to maximum x after right pan near the east edge', () => {
    // worldW=SURFACE_GRID_WIDTH=128, viewportWidth=50 → max cam.x = 128 - 25 = 103
    // Start at cam.x=103, right key → 103.5 → clamp → 103
    const vs = makeViewState('surface', 103, 64);
    processCameraInput(vs, makePanInputs({ rightDown: true }));
    expect(vs.surfaceCamera.x).toBeCloseTo(103);
  });

  it('keyboard pan on underground view uses underground world dimensions', () => {
    // UNDERGROUND_GRID_HEIGHT=64, viewportHeight=37 → max cam.y = 64 - 18.5 = 45.5
    // Start at cam.y=45, down key → 45.5 → at boundary; another down → clamped to 45.5
    const vs = makeViewState('underground', 64, 45);
    processCameraInput(vs, makePanInputs({ downDown: true }));
    // 45 + 0.5 = 45.5, exactly at max → no further clamping
    expect(vs.undergroundCamera.y).toBeCloseTo(45.5);

    // Second call with cam at 45.5 → tries 46.0 → clamped back to 45.5
    processCameraInput(vs, makePanInputs({ downDown: true }));
    expect(vs.undergroundCamera.y).toBeCloseTo(45.5);
  });

  it('underground view uses UNDERGROUND_GRID_WIDTH for x clamping', () => {
    // max cam.x = UNDERGROUND_GRID_WIDTH - viewportWidth/2 = 128 - 25 = 103
    const vs = makeViewState('underground', 103, 32);
    processCameraInput(vs, makePanInputs({ rightDown: true }));
    expect(vs.undergroundCamera.x).toBeCloseTo(103);
  });

  it('surface view uses SURFACE_GRID_HEIGHT for y clamping', () => {
    // max cam.y = SURFACE_GRID_HEIGHT - viewportHeight/2 = 128 - 18.5 = 109.5
    const vs = makeViewState('surface', 64, 109.5);
    processCameraInput(vs, makePanInputs({ downDown: true }));
    expect(vs.surfaceCamera.y).toBeCloseTo(109.5);
  });
});

// ---------------------------------------------------------------------------
// processCameraInput — surface vs underground world dimensions sanity
// ---------------------------------------------------------------------------

describe('processCameraInput — world dimension constants', () => {
  it('SURFACE_GRID_WIDTH and SURFACE_GRID_HEIGHT are 128×128', () => {
    expect(SURFACE_GRID_WIDTH).toBe(128);
    expect(SURFACE_GRID_HEIGHT).toBe(128);
  });

  it('UNDERGROUND_GRID_WIDTH is 128, UNDERGROUND_GRID_HEIGHT is 64', () => {
    expect(UNDERGROUND_GRID_WIDTH).toBe(128);
    expect(UNDERGROUND_GRID_HEIGHT).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// panInputState — Phase 8.5 Space+left-drag contract
// ---------------------------------------------------------------------------

describe('panInputState', () => {
  it('defaults to both flags false', () => {
    expect(panInputState.spaceHeld).toBe(false);
    expect(panInputState.isPanning).toBe(false);
  });

  it('resetPanInputStateForTests clears both flags', () => {
    panInputState.spaceHeld = true;
    panInputState.isPanning = true;
    resetPanInputStateForTests();
    expect(panInputState.spaceHeld).toBe(false);
    expect(panInputState.isPanning).toBe(false);
  });

  it('resetPanInputState (production alias) clears both flags', () => {
    // Same behavior as the test helper; callable at session-restart boundaries.
    panInputState.spaceHeld = true;
    panInputState.isPanning = true;
    resetPanInputState();
    expect(panInputState.spaceHeld).toBe(false);
    expect(panInputState.isPanning).toBe(false);
  });

  it('resetPanInputState === resetPanInputStateForTests (alias identity)', () => {
    expect(resetPanInputState).toBe(resetPanInputStateForTests);
  });
});

// ---------------------------------------------------------------------------
// resetDragState — Phase 9 session reset
// ---------------------------------------------------------------------------

describe('resetDragState', () => {
  it('clears active/isDragging and zeroes lastX/lastY', () => {
    const dragState: DragState = { isDragging: true, lastX: 42, lastY: 99, active: true };
    resetDragState(dragState);
    expect(dragState).toEqual({ isDragging: false, lastX: 0, lastY: 0, active: false });
  });

  it('preserves the DragState object identity (mutates in place)', () => {
    // Critical: registerDragPan's pointermove handler captured this reference.
    const dragState: DragState = { isDragging: true, lastX: 10, lastY: 20, active: true };
    const ref = dragState;
    resetDragState(dragState);
    expect(dragState).toBe(ref);
  });

  it('is idempotent on an already-cleared state', () => {
    const dragState: DragState = { isDragging: false, lastX: 0, lastY: 0, active: false };
    resetDragState(dragState);
    expect(dragState).toEqual({ isDragging: false, lastX: 0, lastY: 0, active: false });
  });
});
