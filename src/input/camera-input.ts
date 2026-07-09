// camera-input.ts — camera pan input (Stage 1 controls rework, issue #18;
// Stage 2 continuous-zoom migration).
//
// Pan triggers:
//   1. Left-drag — driven by the gesture arbiter (gesture-arbiter.ts), NOT here.
//      Command / Dig-surface / Chamber drags pan; underground-Dig drags paint.
//      The arbiter sets/clears `panInputState.isPanning` while a left-drag pan
//      is active so keyboard pan is suppressed for the duration.
//   2. Middle-button drag — secondary pan gesture for three-button mice, owned
//      by registerDragPan below. Independent of the arbiter.
//   3. Keyboard pan — arrow keys + WASD (per-frame poll in processCameraInput).
//
// Stage 2: the camera is now a world-pixel CameraView with continuous zoom. Pan
// deltas go through the pure adapter — drag uses panByScreenDelta (screen-delta
// ÷ zoom, so the drag stays 1:1 with the cursor at any zoom) and keyboard pan is
// time-based (panByKeyboard: screen-px/sec × dt ÷ zoom), replacing the old fixed
// per-frame tile delta. Clamp is the custom center-aware clampCameraView.
//
// `panInputState` remains a module-level singleton so the arbiter and the
// keyboard-pan poll can coordinate (keyboard pan no-ops while a drag pan claims
// the camera).
//
// No Phaser *runtime* dependency at module level — Phaser types are `import
// type` only so this file is testable without Phaser.

import type * as Phaser from 'phaser';
import type { HudLayout } from '../render/hud-layout.js';
import { antActivityPanelState } from '../render/ant-activity-panel-state.js';
import { hintStripState } from '../render/hint-strip-state.js';
import { type ViewState, worldPxDimensions } from '../render/camera.js';
import {
  type CameraView,
  clampCameraView,
  panByScreenDelta,
  panByKeyboard,
} from '../render/camera-adapter.js';
// #237 PR5 — wheel-zoom constants (type-free numbers; camera-controller has no
// Phaser runtime import, so this keeps camera-input Phaser-runtime-free).
import { WHEEL_ZOOM_STEP, WHEEL_NOTCH_PX } from '../render/camera-controller.js';

// ---------------------------------------------------------------------------
// panInputState — module-level singleton
// ---------------------------------------------------------------------------

/**
 * Shared pan-gesture state.
 *
 * - `isPanning` is true while a drag pan (middle-button via registerDragPan, or
 *   left-drag via the gesture arbiter) is in flight. processCameraInput skips
 *   keyboard pan while it is true so the two pan systems don't stack deltas.
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
 * Used by drag-pan, the gesture arbiter, and the wheel-zoom handler to suppress
 * pointer/wheel events that land on HUD widgets.
 *
 * Zones come from the passed `hud` (buildHudLayout output) so this reflows with
 * the layout instead of reading a fixed table.
 *
 * Inclusion rule: x in [rect.x, rect.x + rect.w) and y in [rect.y, rect.y + rect.h).
 */
export function isPointerOverHUD(
  px: number,
  py: number,
  hud: HudLayout,
  viewState?: ViewState,
): boolean {
  // Ant-activity popup full-canvas mask — while the panel is visible OR already
  // dismissing (pendingHide), treat every screen pixel as HUD (Phaser does not
  // guarantee cross-scene dispatch order, so masking the whole canvas closes both
  // dismissal-click orderings).
  if (antActivityPanelState.visible || antActivityPanelState.pendingHide) {
    return true;
  }

  const zones: Array<{ x: number; y: number; w: number; h: number }> = [
    hud.STATS,
    hud.TRIANGLE,
    hud.SPEED,
    hud.TOOLS,
    hud.MINIMAP,
    hud.VIEW_TOGGLE,
  ];
  // Stage 3b (issue #18, Codex R1#2) — the hint strip masks world input ONLY
  // while its legend is visible. When the player hides the legend (settings
  // toggle → hintStripState.visible=false), drop hud.HINTS so the freed band is
  // not a dead input zone. Default visible → the band stays masked as before.
  if (hintStripState.visible) {
    zones.push(hud.HINTS);
  }
  // Issue #14 — colony toggle is rendered ONLY on the underground view. Mask the
  // click zone only when it's actually visible. Callers without a ViewState
  // (legacy/test) pass undefined and the toggle stays unmasked.
  if (viewState !== undefined && viewState.activeView === 'underground') {
    zones.push(hud.UNDERGROUND_COLONY_TOGGLE);
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

/** Return the active CameraView for the current view. */
function activeCamera(viewState: ViewState): CameraView {
  return viewState.activeView === 'surface' ? viewState.surfaceCamera : viewState.undergroundCamera;
}

// ---------------------------------------------------------------------------
// processCameraInput
// ---------------------------------------------------------------------------

/**
 * processCameraInput — apply time-based keyboard pan then clamp.
 *
 * Called once per frame from GameScene.update(). Drag-pan mutations happen in
 * the event handlers; this applies the keyboard triggers and the single
 * end-of-frame clamp. Keyboard pan is frame-rate independent: panByKeyboard
 * moves screen-px/sec × dtSeconds ÷ zoom world px.
 *
 * Returns true when held WASD/arrow keys actually moved the camera this frame,
 * so the caller can cancel any in-flight cursor-anchored wheel zoom (whose
 * per-frame re-anchor would otherwise immediately overwrite the keyboard pan).
 *
 * @param viewState - current view state (active CameraView is mutated)
 * @param inputs - per-frame key state
 * @param dtSeconds - frame delta in seconds (GameScene update delta ÷ 1000)
 */
export function processCameraInput(
  viewState: ViewState,
  inputs: PanInputs,
  dtSeconds: number,
): boolean {
  const cam = activeCamera(viewState);
  const [worldW, worldH] = worldPxDimensions(viewState.activeView);

  // Issue #85 — suppress keyboard pan while a drag pan claims the camera.
  if (panInputState.isPanning) {
    clampCameraView(cam, worldW, worldH);
    return false;
  }

  // --- Keyboard pan (time-based) ---
  let dirX = 0;
  let dirY = 0;
  if (inputs.cursors.left.isDown || inputs.wasd.A.isDown) dirX -= 1;
  if (inputs.cursors.right.isDown || inputs.wasd.D.isDown) dirX += 1;
  if (inputs.cursors.up.isDown || inputs.wasd.W.isDown) dirY -= 1;
  if (inputs.cursors.down.isDown || inputs.wasd.S.isDown) dirY += 1;
  const panned = dirX !== 0 || dirY !== 0;
  if (panned) {
    panByKeyboard(cam, dirX, dirY, dtSeconds);
  }

  // --- Single clamp at end of frame ---
  clampCameraView(cam, worldW, worldH);
  return panned;
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
 * Retains only the middle-button pan for three-button mice (left is the gesture
 * arbiter's). While active it sets `panInputState.isPanning` so keyboard pan is
 * suppressed. HUD-zone pointerdown / pointermove are ignored so a drag starting
 * inside a HUD widget never pans, and a mid-drag HUD crossing doesn't jump the
 * camera. Stage 2: pan delta goes through panByScreenDelta (÷ zoom).
 *
 * `hud` is the built HUD layout, threaded into the isPointerOverHUD masks.
 * Returns the shared dragState object. `isBlocked` lets GameScene suspend pan
 * during GameOver.
 */
export function registerDragPan(
  scene: Phaser.Scene,
  viewState: ViewState,
  hud: HudLayout,
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
    if (isPointerOverHUD(pointer.x, pointer.y, hud, viewState)) return;
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
    if (isPointerOverHUD(pointer.x, pointer.y, hud, viewState)) {
      dragState.lastX = pointer.x;
      dragState.lastY = pointer.y;
      return;
    }

    const cam = activeCamera(viewState);
    panByScreenDelta(cam, pointer.x - dragState.lastX, pointer.y - dragState.lastY);

    const [worldW, worldH] = worldPxDimensions(viewState.activeView);
    clampCameraView(cam, worldW, worldH);

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

// ---------------------------------------------------------------------------
// Wheel zoom (#237 PR5 — relocated from game-scene's inline closure)
// ---------------------------------------------------------------------------

/**
 * wheelZoomFactor — the multiplicative zoom for one wheel event:
 * `step ** (−dy / notch)`. dy < 0 (scroll up) → factor > 1 (zoom in). Scaling by
 * the deltaY magnitude keeps a continuous trackpad / high-res wheel (many small
 * events per gesture) smooth instead of slamming a full step per event and
 * hitting the zoom limit (Codex P1). Pure — unit-tested.
 */
export function wheelZoomFactor(dy: number, step: number, notch: number): number {
  return Math.pow(step, -dy / notch);
}

/** Injected seams for registerWheelZoom (keeps the wire Phaser-testable). */
export interface WheelZoomDeps {
  /** World input allowed right now (no modal / menu / game-over owns input). */
  canAcceptWorldHotkey: () => boolean;
  /** True if a screen point falls on a HUD zone (bind hud + viewState at the call site). */
  isPointerOverHUD: (x: number, y: number) => boolean;
  /** The active CameraView to zoom. */
  getActiveCamera: () => CameraView;
  /** Apply an anchored zoom (cameraController.beginZoom). */
  beginZoom: (cam: CameraView, factor: number, screenX: number, screenY: number) => void;
  /** Fired when the zoom was ACCEPTED (targetZoom changed — not a clamped no-op). */
  onZoomAccepted?: () => void;
  /** A wheel is a world input (proactive [Tab] nudge). */
  noteWorldInput?: () => void;
}

/**
 * registerWheelZoom — wire mouse-wheel / trackpad zoom to a scene, mirroring
 * registerDragPan. Gated exactly like world pan (canAcceptWorldHotkey + HUD);
 * ctrl/cmd-wheel is left to the OS/browser pinch-zoom, and dy===0 is ignored.
 * Wheel-up (dy < 0) zooms IN. #237 PR5 — moved out of game-scene so the gesture
 * the pinch extends has an input-layer home + a unit test.
 */
export function registerWheelZoom(scene: Phaser.Scene, deps: WheelZoomDeps): void {
  scene.input.on(
    'wheel',
    (pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      if (!deps.canAcceptWorldHotkey()) return;
      if (deps.isPointerOverHUD(pointer.x, pointer.y)) return;
      const native = pointer.event as WheelEvent | undefined;
      if (native?.ctrlKey || native?.metaKey) return;
      if (dy === 0) return;
      const cam = deps.getActiveCamera();
      const factor = wheelZoomFactor(dy, WHEEL_ZOOM_STEP, WHEEL_NOTCH_PX);
      const beforeZoom = cam.targetZoom;
      deps.beginZoom(cam, factor, pointer.x, pointer.y);
      if (cam.targetZoom !== beforeZoom) deps.onZoomAccepted?.();
      deps.noteWorldInput?.();
    },
  );
}
