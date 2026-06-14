// camera-adapter.ts — Stage 2 controls rework (issue #18): the pure, zoom-aware
// screen↔world projection + camera-control math that is the SINGLE source of truth
// for the continuous-zoom camera.
//
// This file is in src/render/ — float arithmetic is permitted (ARCHITECTURE.md
// Principle 6). It has NO Phaser imports and NO DOM globals, so it is fully testable
// under Node + Vitest. The thin Phaser-bound driver (which calls cameras.main.setZoom
// / centerOn) lives elsewhere (camera-controller / game-scene) and delegates ALL math
// to these functions.
//
// Why a hand-rolled projection rather than Phaser's getWorldPoint()/preRender():
//   - getWorldPoint() reads matrices that are only refreshed in preRender; right after
//     an input-driven zoom change they are STALE, so hit-testing against them drifts.
//   - Input must never call preRender() itself.
// So we keep an authoritative {centerX, centerY, zoom} in WORLD PIXELS and DRIVE the
// Phaser camera from it (setZoom + centerOn). Every screen↔world / clamp / cull / pan /
// zoom computation goes through the pure formulas here, never through Phaser.
//
// Plan: plan/controls-rework/PLAN-stage2.md §A (camera adapter, projection, per-view
// state) and §D (pan/WASD ÷zoom). Grilled via Codex (R1-2/4, R2-1/2/3/4, R3, R4).

import { CANVAS_W, CANVAS_H, TILE_SIZE_PX } from './sprites.js';

// ---------------------------------------------------------------------------
// Zoom limits
// ---------------------------------------------------------------------------

/** Minimum (most zoomed-OUT) camera zoom — strategic whole-nest view. PLAN §A3. */
export const MIN_ZOOM = 0.2;

/** Maximum (most zoomed-IN) camera zoom. PLAN §A3. */
export const MAX_ZOOM = 2;

/** Default camera zoom on fresh boot / reset — 1 world px = 1 screen px (parity with
 *  the pre-Stage-2 fixed 50×37-tile viewport). PLAN §A3. */
export const DEFAULT_ZOOM = 1;

/** Clamp a zoom value to [MIN_ZOOM, MAX_ZOOM]. */
export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

// ---------------------------------------------------------------------------
// Ant-dot LOD hysteresis (PLAN §C13)
// ---------------------------------------------------------------------------

/**
 * Two thresholds, NOT one, so the smoothed zoom oscillating around a single boundary
 * cannot thrash the renderer between detailed sprites and strategic dots:
 *   - zooming OUT, detailed sprites persist until zoom drops to LOD_DOT_ENTER_ZOOM;
 *   - zooming IN, strategic dots persist until zoom rises to LOD_SPRITE_RETURN_ZOOM.
 * The worst-case DETAILED frame is therefore at ~LOD_DOT_ENTER_ZOOM (most world still
 * drawn as sprites), NOT at the upper edge (R5-1). Consumed by the Phase-B dot-LOD
 * renderer; exported + unit-tested now as the foundation for that wiring (§E18).
 */
export const LOD_DOT_ENTER_ZOOM = 0.55;
export const LOD_SPRITE_RETURN_ZOOM = 0.65;

/**
 * Resolve the LOD mode from the current zoom and the PREVIOUS mode (hysteresis is
 * stateful — the band between the two thresholds keeps whatever mode was already
 * active). Returns true when strategic dot mode should be active.
 *
 * @param zoom - current (smoothed) camera zoom
 * @param wasDotMode - whether dot mode was active last frame
 */
export function resolveDotMode(zoom: number, wasDotMode: boolean): boolean {
  if (zoom <= LOD_DOT_ENTER_ZOOM) return true;
  if (zoom >= LOD_SPRITE_RETURN_ZOOM) return false;
  return wasDotMode; // inside the hysteresis band — hold the prior mode
}

/**
 * Screen-constant size (px) of a strategic ant/brood dot. Drawn at ANT_DOT_SCREEN_PX /
 * zoom world px so it stays ~constant on screen as the camera zooms out (§C13).
 */
export const ANT_DOT_SCREEN_PX = 2;

// ---------------------------------------------------------------------------
// CameraView — the authoritative per-view camera state (WORLD PIXELS)
// ---------------------------------------------------------------------------

/**
 * CameraView — authoritative camera state for ONE view, in world pixels.
 *
 * centerX/centerY are the world-pixel coordinates the viewport is centered on (what
 * Phaser's centerOn(centerX, centerY) is fed). zoom is the Phaser camera zoom (screen
 * px per world px). targetZoom is the in-flight wheel-zoom destination; it equals zoom
 * whenever no zoom-lerp is running. These four fields ARE the per-view snapshot stored
 * for the inactive view and published read-only for the Playwright hook (PLAN §A4).
 *
 * NB: Phaser scrollX/scrollY terminology is deliberately NOT used here — under zoom,
 * Phaser scrollX ≠ the visible-left world pixel, so exposing it would invite the exact
 * projection bugs this adapter exists to prevent. scrollX lives only inside the driver.
 */
export interface CameraView {
  centerX: number;
  centerY: number;
  zoom: number;
  targetZoom: number;
}

/** Construct a CameraView centered on a world-pixel point at a given zoom. */
export function makeCameraView(
  centerX: number,
  centerY: number,
  zoom: number = DEFAULT_ZOOM,
): CameraView {
  const z = clampZoom(zoom);
  return { centerX, centerY, zoom: z, targetZoom: z };
}

// ---------------------------------------------------------------------------
// Visible-window helpers
// ---------------------------------------------------------------------------

/** Width in world pixels of the visible window at a given zoom (CANVAS_W / zoom). */
export function viewWorldWidth(zoom: number): number {
  return CANVAS_W / zoom;
}

/** Height in world pixels of the visible window at a given zoom (CANVAS_H / zoom). */
export function viewWorldHeight(zoom: number): number {
  return CANVAS_H / zoom;
}

/**
 * World-pixel rectangle currently visible, for culling dynamic layers. Computed from
 * the CURRENT {centerX, centerY, zoom} (NOT a stale Phaser worldView). PLAN §C14.
 */
export interface WorldRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export function visibleWorldRect(v: CameraView): WorldRect {
  const halfW = viewWorldWidth(v.zoom) / 2;
  const halfH = viewWorldHeight(v.zoom) / 2;
  return {
    left: v.centerX - halfW,
    top: v.centerY - halfH,
    right: v.centerX + halfW,
    bottom: v.centerY + halfH,
  };
}

// ---------------------------------------------------------------------------
// Pure screen↔world projection (the ONLY conversion in the codebase)
// ---------------------------------------------------------------------------

/**
 * screen→world (world pixels). Derivation: the visible window is CANVAS_W/zoom world px
 * wide, centered on centerX; a screen pixel sx maps linearly across it, so
 *   worldX = centerX + (sx − CANVAS_W/2) / zoom.
 * This agrees with Phaser's render of camera.centerOn(centerX, centerY) at zoom, but is
 * computed without touching any Phaser matrix (no staleness after a zoom change).
 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  v: CameraView,
): { worldX: number; worldY: number } {
  return {
    worldX: v.centerX + (screenX - CANVAS_W / 2) / v.zoom,
    worldY: v.centerY + (screenY - CANVAS_H / 2) / v.zoom,
  };
}

/** world→screen (screen pixels) — exact inverse of screenToWorld. */
export function worldToScreen(
  worldX: number,
  worldY: number,
  v: CameraView,
): { screenX: number; screenY: number } {
  return {
    screenX: (worldX - v.centerX) * v.zoom + CANVAS_W / 2,
    screenY: (worldY - v.centerY) * v.zoom + CANVAS_H / 2,
  };
}

/**
 * screen→tile. Projects to continuous world pixels then floors to the tile grid.
 *
 * Unlike the pre-Stage-2 screenToTile, the camera CENTER is NOT floored first: the
 * baked-RT + Phaser-camera projection is continuous, so flooring the camera position
 * would reintroduce the sub-pixel snapping PR6 removed. Only the final tile index is
 * floored (a click resolves to the tile it visually lands on). PLAN §D / Risks.
 */
export function screenToTileZoom(
  screenX: number,
  screenY: number,
  v: CameraView,
): { tileX: number; tileY: number } {
  const { worldX, worldY } = screenToWorld(screenX, screenY, v);
  return {
    tileX: Math.floor(worldX / TILE_SIZE_PX),
    tileY: Math.floor(worldY / TILE_SIZE_PX),
  };
}

// ---------------------------------------------------------------------------
// Custom center-aware clamp (PLAN §A2)
// ---------------------------------------------------------------------------

/**
 * Clamp the camera center so the visible window never shows outside the world, with a
 * PER-AXIS center-when-undersized rule. Mutates v in place.
 *
 * Phaser's setBounds can't do this: useBounds is a single flag (not per-axis) and it
 * PINS (does not center) an undersized world — fatal underground, where at mid zoom
 * only the Y axis is undersized (2048×1024 world vs a taller-than-1024 window) while X
 * is not. So we never enable setBounds and run this after every camera mutation:
 *   - if the world is narrower/shorter than the zoomed viewport on an axis → CENTER it;
 *   - otherwise clamp the center to [halfView, worldPx − halfView] on that axis.
 *
 * @param v - camera view (mutated)
 * @param worldPxW - world width in pixels (e.g. 128 tiles × 16 = 2048)
 * @param worldPxH - world height in pixels (e.g. 64 tiles × 16 = 1024 underground)
 */
export function clampCameraView(v: CameraView, worldPxW: number, worldPxH: number): void {
  const viewW = viewWorldWidth(v.zoom);
  const viewH = viewWorldHeight(v.zoom);
  const halfW = viewW / 2;
  const halfH = viewH / 2;

  if (worldPxW <= viewW) {
    v.centerX = worldPxW / 2;
  } else {
    v.centerX = Math.max(halfW, Math.min(worldPxW - halfW, v.centerX));
  }

  if (worldPxH <= viewH) {
    v.centerY = worldPxH / 2;
  } else {
    v.centerY = Math.max(halfH, Math.min(worldPxH - halfH, v.centerY));
  }
}

// ---------------------------------------------------------------------------
// Cursor-anchored zoom (PLAN §A3)
// ---------------------------------------------------------------------------

/**
 * ZoomAnchor — the fixed screen point + the world point under it at the moment the
 * wheel fired. Re-applied every interpolation frame so the world point under the cursor
 * stays put while zoom lerps (anchoring only on the wheel event drifts mid-lerp).
 */
export interface ZoomAnchor {
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
}

/**
 * Begin a cursor-anchored zoom. Multiplies targetZoom by `factor` (clamped) and returns
 * the anchor (the world point currently under the cursor) for the lerp to hold fixed.
 * Does NOT mutate the current zoom — only the target; the per-frame lerp moves zoom.
 *
 * @param v - camera view (only targetZoom is mutated)
 * @param factor - zoom multiplier (>1 zoom in, <1 zoom out)
 * @param screenX - cursor screen X (anchor)
 * @param screenY - cursor screen Y (anchor)
 */
export function beginWheelZoom(
  v: CameraView,
  factor: number,
  screenX: number,
  screenY: number,
): ZoomAnchor {
  const { worldX, worldY } = screenToWorld(screenX, screenY, v);
  v.targetZoom = clampZoom(v.targetZoom * factor);
  return { screenX, screenY, worldX, worldY };
}

/**
 * Re-anchor the camera center so the anchor's world point sits under its screen point at
 * the current zoom. Solving screenToWorld(screenX) == worldX for centerX:
 *   worldX = centerX + (screenX − CANVAS_W/2)/zoom  ⇒  centerX = worldX − (screenX − CANVAS_W/2)/zoom.
 * Mutates v. Call AFTER each zoom-lerp step, then clamp.
 */
export function applyZoomAnchor(v: CameraView, anchor: ZoomAnchor): void {
  v.centerX = anchor.worldX - (anchor.screenX - CANVAS_W / 2) / v.zoom;
  v.centerY = anchor.worldY - (anchor.screenY - CANVAS_H / 2) / v.zoom;
}

/** Smallest zoom delta treated as "arrived" — snaps to target and ends the lerp. */
export const ZOOM_LERP_EPSILON = 0.0005;

/**
 * Advance the zoom toward targetZoom by interpolation factor t (0..1). Returns true when
 * the lerp has completed (zoom snapped exactly to targetZoom this step). Mutates v.zoom.
 *
 * The caller drives anchoring: after this returns, call applyZoomAnchor + clampCameraView
 * so the cursor-anchored world point is preserved at the new zoom every frame.
 */
export function stepZoomLerp(v: CameraView, t: number): boolean {
  const diff = v.targetZoom - v.zoom;
  if (Math.abs(diff) <= ZOOM_LERP_EPSILON) {
    v.zoom = v.targetZoom;
    return true;
  }
  v.zoom += diff * t;
  return false;
}

/** Cancel any in-flight zoom-lerp by snapping targetZoom to the current zoom. */
export function cancelZoomLerp(v: CameraView): void {
  v.targetZoom = v.zoom;
}

// ---------------------------------------------------------------------------
// Pan (PLAN §D15)
// ---------------------------------------------------------------------------

/**
 * Grab-pan by a screen-pixel delta (gesture-arbiter drag + middle-drag). The dragged
 * world point follows the cursor, so a +dx screen move (pointer →) shifts the camera
 * center by −dx/zoom world px (content moves right with the cursor). ÷zoom keeps the
 * drag 1:1 with the cursor at any zoom. Mutates v. Caller clamps afterward.
 */
export function panByScreenDelta(v: CameraView, deltaScreenX: number, deltaScreenY: number): void {
  v.centerX -= deltaScreenX / v.zoom;
  v.centerY -= deltaScreenY / v.zoom;
}

/** Keyboard pan speed in SCREEN pixels per second (frame-rate independent). PLAN §D15. */
export const KEYBOARD_PAN_SPEED_PX_PER_SEC = 600;

/**
 * Time-based WASD/arrow pan. Applies speed × dt ÷ zoom world px along the unit-ish
 * direction (dirX/dirY ∈ {−1,0,1}). Replaces the old fixed per-frame tile delta, which
 * was frame-rate dependent. Mutates v. Caller clamps afterward.
 *
 * @param v - camera view (mutated)
 * @param dirX - −1 (left) / 0 / +1 (right)
 * @param dirY - −1 (up) / 0 / +1 (down)
 * @param dtSeconds - frame delta in seconds
 * @param speedPxPerSec - screen px/sec (defaults to KEYBOARD_PAN_SPEED_PX_PER_SEC)
 */
export function panByKeyboard(
  v: CameraView,
  dirX: number,
  dirY: number,
  dtSeconds: number,
  speedPxPerSec: number = KEYBOARD_PAN_SPEED_PX_PER_SEC,
): void {
  const stepWorld = (speedPxPerSec * dtSeconds) / v.zoom;
  v.centerX += dirX * stepWorld;
  v.centerY += dirY * stepWorld;
}

// ---------------------------------------------------------------------------
// Per-view toggle (PLAN §A5) and minimap nav (PLAN §A6)
// ---------------------------------------------------------------------------

/**
 * Apply the entering-view restore half of the atomic toggle algorithm (PLAN §A5). The
 * leaving view's snapshot is preserved automatically because both CameraViews persist
 * (mutated in place). For the entering view we:
 *   1. cancel any in-flight zoom-lerp (targetZoom ← zoom) so the toggle doesn't carry a
 *      stale zoom destination across views;
 *   2. (caller has already restored the entering view's stored zoom and, for a first
 *      underground visit, its initial center BEFORE the X-link — see game-scene wiring);
 *   3. clamp the restored center at the restored zoom.
 * Restoring zoom BEFORE clamping matters: the clamp's center-when-undersized test
 * depends on the zoomed viewport size, which depends on zoom.
 *
 * @param entering - the view being switched TO (mutated)
 * @param worldPxW - entering view's world width px
 * @param worldPxH - entering view's world height px
 */
export function settleEnteringView(entering: CameraView, worldPxW: number, worldPxH: number): void {
  cancelZoomLerp(entering);
  clampCameraView(entering, worldPxW, worldPxH);
}

/**
 * Minimap-nav target (PLAN §A6). The minimap is a SURFACE map; a click sets the SURFACE
 * view's center to the clicked world point, and — when underground is the active view —
 * the underground view's center X is linked to it while its DEPTH (centerY) is preserved
 * (NOT "centerOn whichever camera is active", which would jump the underground depth).
 *
 * This helper computes the new centers without committing them, so the caller can clamp
 * each view with its own world dimensions. Mutates neither input view.
 *
 * @param surface - current surface CameraView (read)
 * @param underground - current underground CameraView (read)
 * @param worldX - clicked world-pixel X
 * @param worldY - clicked world-pixel Y (surface depth)
 */
export function minimapNavTargets(
  surface: CameraView,
  underground: CameraView,
  worldX: number,
  worldY: number,
): {
  surfaceCenterX: number;
  surfaceCenterY: number;
  undergroundCenterX: number;
  undergroundCenterY: number;
} {
  return {
    surfaceCenterX: worldX,
    surfaceCenterY: worldY,
    undergroundCenterX: worldX, // X-link
    undergroundCenterY: underground.centerY, // preserve underground depth
  };
}
