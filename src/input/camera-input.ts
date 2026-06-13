// camera-input.ts — camera pan input (Stage 1 controls rework, issue #18).
//
// Pan triggers after the controls rework:
//   1. Left-drag — driven by the gesture arbiter (gesture-arbiter.ts), NOT here.
//      Command / Dig-surface / Chamber drags pan; underground-Dig drags paint.
//      The arbiter sets/clears `panInputState.isPanning` while a left-drag pan
//      is active so keyboard pan is suppressed for the duration.
//   2. Middle-button drag — secondary pan gesture for three-button mice, owned
//      by registerDragPan below. Independent of the arbiter (the arbiter cancels
//      any pending left gesture when a middle button goes down).
//   3. Keyboard pan — arrow keys + WASD (per-frame poll in processCameraInput).
//
// Space no longer pans (the Space modifier was retired in the rework — Space is
// now the pause toggle, bound in game-scene.ts). All `spaceHeld` handling is
// gone; `panInputState` carries only `isPanning`.
//
// `panInputState` remains a module-level singleton so the arbiter and the
// keyboard-pan poll can coordinate (keyboard pan no-ops while a drag pan claims
// the camera).
//
// No Phaser *runtime* dependency at module level — Phaser types are `import
// type` only so this file is testable without Phaser.

import type * as Phaser from 'phaser';
import { HUD, TILE_SIZE_PX } from '../render/sprites.js';
import { antActivityPanelState } from '../render/ant-activity-panel-state.js';
import {
  type ViewState,
  type CameraState,
  clampCamera,
  CAMERA_SCROLL_SPEED,
} from '../render/camera.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
} from '../sim/constants.js';

// ---------------------------------------------------------------------------
// panInputState — module-level singleton
// ---------------------------------------------------------------------------

/**
 * Shared pan-gesture state.
 *
 * - `isPanning` is true while a drag pan (middle-button via registerDragPan, or
 *   left-drag via the gesture arbiter) is in flight. processCameraInput skips
 *   keyboard pan while it is true so the two pan systems don't stack deltas.
 *
 * The Space modifier was removed in the controls rework, so `spaceHeld` is gone.
 */
export const panInputState = {
  isPanning: false,
};

/**
 * Reset the module-level panInputState singleton back to defaults.
 *
 * Used at session-restart boundaries (bootFresh / bootFromSave / restartGame)
 * and by the GameOver guard so a pan gesture in flight at the moment of restart
 * does not leak into the new session.
 *
 * Also used by unit tests as `resetPanInputStateForTests` (aliased below).
 */
export function resetPanInputState(): void {
  panInputState.isPanning = false;
}

/** @deprecated Alias kept for test back-compat — use resetPanInputState. */
export const resetPanInputStateForTests = resetPanInputState;

/**
 * Reset a DragState object in-place. registerDragPan owns the canonical
 * instance; at session restart we clear any in-flight middle-button gesture
 * without replacing the object (the input handlers closed over the original).
 */
export function resetDragState(dragState: DragState): void {
  dragState.isDragging = false;
  dragState.lastX = 0;
  dragState.lastY = 0;
  dragState.active = false;
}

// ---------------------------------------------------------------------------
// isPointerOverHUD
// ---------------------------------------------------------------------------

/**
 * isPointerOverHUD — return true if the screen-pixel point (px, py) falls
 * inside any *visible* HUD zone rectangle.
 *
 * Used by drag-pan and the gesture arbiter to suppress pointer events that land
 * on HUD widgets.
 *
 * Stage 1 controls rework (issue #18): HUD.TOOLS (tool palette), HUD.HINTS (hint
 * strip), and HUD.SPEED (speed widget) are now DRAWN and interactive, so all
 * three are masked here. HUD.SPEED was deliberately left unmasked pre-rework
 * (reserved/undrawn); now that the speed widget renders there, masking it stops
 * speed-button clicks leaking into the world arbiter (Codex R5-1). HUD.SAVE_ICON
 * stays unmasked (still undrawn).
 *
 * Inclusion rule: x in [rect.x, rect.x + rect.w) and y in [rect.y, rect.y + rect.h).
 */
export function isPointerOverHUD(px: number, py: number, viewState?: ViewState): boolean {
  // Ant-activity popup full-canvas mask — while the panel is visible OR already
  // dismissing (pendingHide), treat every screen pixel as HUD. (See the long
  // rationale retained below: Phaser does not guarantee cross-scene dispatch
  // order, so masking the whole canvas closes both UIScene-first and
  // world-input-first orderings of the dismissal click.)
  if (antActivityPanelState.visible || antActivityPanelState.pendingHide) {
    return true;
  }

  const zones: Array<{ x: number; y: number; w: number; h: number }> = [
    HUD.STATS,
    HUD.TRIANGLE,
    HUD.SPEED,
    HUD.TOOLS,
    HUD.HINTS,
    HUD.MINIMAP,
    HUD.VIEW_TOGGLE,
  ];
  // Issue #14 — colony toggle is rendered ONLY on the underground view. Mask the
  // click zone only when it's actually visible — otherwise a patch above the
  // minimap on the surface view becomes a silent dead zone. Callers without a
  // ViewState (legacy/test) pass undefined and the toggle stays unmasked.
  if (viewState !== undefined && viewState.activeView === 'underground') {
    zones.push(HUD.UNDERGROUND_COLONY_TOGGLE);
  }
  for (const zone of zones) {
    if (px >= zone.x && px < zone.x + zone.w && py >= zone.y && py < zone.y + zone.h) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// PanInputs
// ---------------------------------------------------------------------------

/**
 * PanInputs — shape of everything processCameraInput needs per frame.
 *
 * Passed from GameScene.update() each frame. Keyboard pan is evaluated
 * synchronously in processCameraInput; drag-pan mutations happen inside
 * registerDragPan's / the arbiter's event handlers.
 */
export interface PanInputs {
  /** Phaser cursor-key state (arrow keys). */
  cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  /** WASD key state. */
  wasd: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };
  /**
   * Drag state reference returned from registerDragPan. processCameraInput does
   * NOT read this — drag-pan mutations happen directly in the pointermove
   * handler. Included for debugging.
   */
  dragState: { isDragging: boolean; lastX: number; lastY: number; active: boolean };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return [worldW, worldH] tile dimensions for the currently active view. */
function worldDimensions(viewState: ViewState): [number, number] {
  return viewState.activeView === 'surface'
    ? [SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT]
    : [UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT];
}

/** Return the active camera for the current view. */
function activeCamera(viewState: ViewState): CameraState {
  return viewState.activeView === 'surface' ? viewState.surfaceCamera : viewState.undergroundCamera;
}

// ---------------------------------------------------------------------------
// processCameraInput
// ---------------------------------------------------------------------------

/**
 * processCameraInput — apply keyboard pan triggers then clamp.
 *
 * Called once per frame from GameScene.update(). Drag-pan mutations happen in
 * the event handlers; this applies the keyboard triggers and the single
 * end-of-frame clamp.
 */
export function processCameraInput(viewState: ViewState, inputs: PanInputs): void {
  const cam = activeCamera(viewState);
  const [worldW, worldH] = worldDimensions(viewState);

  // Issue #85 — suppress keyboard pan while a drag pan claims the camera. Drag
  // is a 'claim the camera' gesture; keyboard resumes as soon as the drag ends.
  if (panInputState.isPanning) {
    clampCamera(cam, worldW, worldH);
    return;
  }

  // --- Keyboard pan ---
  if (inputs.cursors.left.isDown || inputs.wasd.A.isDown) {
    cam.x -= CAMERA_SCROLL_SPEED;
  }
  if (inputs.cursors.right.isDown || inputs.wasd.D.isDown) {
    cam.x += CAMERA_SCROLL_SPEED;
  }
  if (inputs.cursors.up.isDown || inputs.wasd.W.isDown) {
    cam.y -= CAMERA_SCROLL_SPEED;
  }
  if (inputs.cursors.down.isDown || inputs.wasd.S.isDown) {
    cam.y += CAMERA_SCROLL_SPEED;
  }

  // --- Single clamp at end of frame ---
  clampCamera(cam, worldW, worldH);
}

// ---------------------------------------------------------------------------
// registerDragPan — middle-button pan only
// ---------------------------------------------------------------------------

/**
 * DragState — shared mutable object tracking middle-button drag-pan progress.
 */
export interface DragState {
  /** True when a middle-button drag has moved at least one pixel. */
  isDragging: boolean;
  /** Last pointer X seen during drag (pixels). */
  lastX: number;
  /** Last pointer Y seen during drag (pixels). */
  lastY: number;
  /** True from pointerdown (middle, non-HUD) until pointerup. */
  active: boolean;
}

/**
 * registerDragPan — wire MIDDLE-button drag-pan handlers on a Phaser.Scene.
 *
 * The Space+left and plain-left pan paths were removed in the controls rework
 * (left is now exclusively the gesture arbiter's). This retains only the
 * middle-button pan for three-button mice. While it is active it sets
 * `panInputState.isPanning` so keyboard pan is suppressed; the gesture arbiter
 * also cancels any pending left gesture on a middle-button down so the two
 * never run concurrently.
 *
 * HUD-zone pointerdown / pointermove are ignored so a drag starting inside a HUD
 * widget never pans, and a mid-drag HUD crossing doesn't jump the camera.
 *
 * Returns the shared dragState object (kept for PanInputs back-compat;
 * processCameraInput ignores it). `isBlocked` lets GameScene suspend pan during
 * GameOver.
 */
export function registerDragPan(
  scene: Phaser.Scene,
  viewState: ViewState,
  isBlocked?: () => boolean,
): DragState {
  const dragState: DragState = {
    isDragging: false,
    lastX: 0,
    lastY: 0,
    active: false,
  };

  scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    if (isBlocked?.()) return;
    if (!pointer.middleButtonDown()) return;
    if (isPointerOverHUD(pointer.x, pointer.y, viewState)) return;
    dragState.active = true;
    dragState.lastX = pointer.x;
    dragState.lastY = pointer.y;
    dragState.isDragging = false;
    panInputState.isPanning = true;
  });

  const releaseDrag = (): void => {
    dragState.active = false;
    dragState.isDragging = false;
    panInputState.isPanning = false;
  };

  scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
    if (isBlocked?.()) {
      releaseDrag();
      return;
    }
    if (!dragState.active) return;
    // Continue only while the middle button is still held.
    if (!pointer.middleButtonDown()) return;
    // Issue #73 — over a HUD widget mid-drag, suppress the camera delta but
    // still track lastX/lastY so the next non-HUD move is incremental.
    if (isPointerOverHUD(pointer.x, pointer.y, viewState)) {
      dragState.lastX = pointer.x;
      dragState.lastY = pointer.y;
      return;
    }

    const dx = (pointer.x - dragState.lastX) / TILE_SIZE_PX;
    const dy = (pointer.y - dragState.lastY) / TILE_SIZE_PX;

    const cam = activeCamera(viewState);
    cam.x -= dx;
    cam.y -= dy;

    const [worldW, worldH] = worldDimensions(viewState);
    clampCamera(cam, worldW, worldH);

    dragState.lastX = pointer.x;
    dragState.lastY = pointer.y;
    dragState.isDragging = true;
  });

  // Register on BOTH pointerup and pointerupoutside so a drag ending off-canvas
  // still clears isPanning (issue #85 follow-up).
  scene.input.on('pointerup', releaseDrag);
  scene.input.on('pointerupoutside', releaseDrag);

  return dragState;
}
