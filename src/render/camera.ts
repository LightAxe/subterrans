// camera.ts — render-layer two-view state (surface + underground) for the
// continuous-zoom camera (Stage 2 controls rework, issue #18).
//
// Stage 2 replaced the fixed 50×37-tile viewport with a continuous Phaser-camera
// zoom. The per-view camera is now a world-pixel `CameraView` ({centerX, centerY,
// zoom, targetZoom}) owned by the pure adapter (camera-adapter.ts) — the SINGLE
// screen↔world authority. This file keeps only the two-view lifecycle: create /
// reset / toggle / colony-flip, plus the tool palette. All projection / clamp /
// pan / zoom math lives in camera-adapter.ts.
//
// This file is in src/render/ — no Phaser imports, no DOM globals. It imports the
// pure adapter, sim world dimensions, and persisted settings only. Fully testable
// under Node + Vitest.

import { CANVAS_H, TILE_SIZE_PX } from './sprites.js';
import {
  type CameraView,
  makeCameraView,
  DEFAULT_ZOOM,
  cancelZoomLerp,
  settleEnteringView,
} from './camera-adapter.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
} from '../sim/constants.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { loadSettings } from '../platform/settings.js';

// ---------------------------------------------------------------------------
// World-pixel dimensions per view (tiles × TILE_SIZE_PX)
// ---------------------------------------------------------------------------

/** Surface world width in pixels (128 tiles × 16 = 2048). */
export const SURFACE_WORLD_PX_W = SURFACE_GRID_WIDTH * TILE_SIZE_PX;
/** Surface world height in pixels (2048). */
export const SURFACE_WORLD_PX_H = SURFACE_GRID_HEIGHT * TILE_SIZE_PX;
/** Underground world width in pixels (128 tiles × 16 = 2048). */
export const UNDERGROUND_WORLD_PX_W = UNDERGROUND_GRID_WIDTH * TILE_SIZE_PX;
/** Underground world height in pixels (64 tiles × 16 = 1024). */
export const UNDERGROUND_WORLD_PX_H = UNDERGROUND_GRID_HEIGHT * TILE_SIZE_PX;

/**
 * Initial underground-camera CENTER Y (world px) on fresh boot / reset / first
 * view toggle. CANVAS_H/2 places world y=0 (the ceiling / surface-entrance row)
 * at the very top of the viewport at zoom 1 — the same "shaft anchored to the
 * top" framing as before Stage 2. It is also the clamp minimum for the 1024-px-
 * tall underground world at zoom 1, so the shaft stays anchored as zoom changes.
 */
export const UNDERGROUND_INITIAL_CENTER_Y_PX = CANVAS_H / 2;

/** World-pixel [width, height] for a view. */
export function worldPxDimensions(view: 'surface' | 'underground'): [number, number] {
  return view === 'surface'
    ? [SURFACE_WORLD_PX_W, SURFACE_WORLD_PX_H]
    : [UNDERGROUND_WORLD_PX_W, UNDERGROUND_WORLD_PX_H];
}

// ---------------------------------------------------------------------------
// Tool palette (Stage 1 controls rework — issue #18)
// ---------------------------------------------------------------------------

/**
 * The active input tool. Render/input-only state; lives on ViewState (not a
 * module singleton — it resets on every view switch, so the view already owns
 * its lifecycle; Codex R1-16). `chamber` is underground-only.
 */
export type ToolId = 'command' | 'dig' | 'chamber';

/**
 * Per-view default tool. The active tool RESETS to this on every view switch
 * (toggleView): surface is command-first (direct taps), underground is
 * dig-first (immediately paint-ready). Within a view the tool persists until
 * the player changes it.
 */
export function defaultToolForView(view: 'surface' | 'underground'): ToolId {
  return view === 'surface' ? 'command' : 'dig';
}

// ---------------------------------------------------------------------------
// ViewState
// ---------------------------------------------------------------------------

/**
 * ViewState — render-layer state for the two-view system (surface + underground).
 *
 * Not part of WorldState — this is render-layer state only (PRD §7c). Each view
 * owns an independent world-pixel CameraView; X positions are linked on toggle
 * (PRD §7c Pattern 9), and each view's zoom is preserved across toggles
 * (PLAN-stage2 §A5).
 */
export interface ViewState {
  /** Which view is currently displayed. */
  activeView: 'surface' | 'underground';
  /** World-pixel camera for the surface top-down view. */
  surfaceCamera: CameraView;
  /** World-pixel camera for the underground side-view cross-section. */
  undergroundCamera: CameraView;
  /**
   * Whether the underground view has been visited at least once.
   * Used for first-visit Y-centering (PRD §7c): undergroundCamera.centerY is set
   * to UNDERGROUND_INITIAL_CENTER_Y_PX (shaft row near the top) on the FIRST
   * toggle to underground only.
   */
  undergroundVisited: boolean;
  /**
   * 09.1 Chunk 2 — which colony's underground grid the player is currently
   * viewing. Defaults to PLAYER_COLONY_ID on fresh boot and after
   * resetViewState. Toggled between PLAYER and ENEMY by the X keybind (via
   * toggleUndergroundColony) while activeView === 'underground'.
   */
  activeUndergroundColonyId: ColonyId;
  /**
   * Issue #114 — render-only flag controlling whether the player's pheromone
   * overlay is drawn. Hydrated from persisted settings on create/reset; toggled
   * by the P key and the pause-menu Settings sub-screen.
   */
  showPheromoneOverlay: boolean;
  /**
   * Stage 1 controls rework (issue #18) — the active input tool. Resets to the
   * view default on every `toggleView`; persists within a view.
   */
  activeTool: ToolId;
}

/** Center (world px) of a tile, used to frame the camera on a tile coordinate. */
function tileCenterPx(tile: number): number {
  return (tile + 0.5) * TILE_SIZE_PX;
}

// ---------------------------------------------------------------------------
// createViewState factory
// ---------------------------------------------------------------------------

/**
 * createViewState — construct initial ViewState for a new game session.
 *
 * surfaceCamera is centered (world px) on the start tile. undergroundCamera is
 * centered horizontally on the starter entrance column and vertically at
 * UNDERGROUND_INITIAL_CENTER_Y_PX so the shaft / surface-entrance row sits near
 * the top of the viewport. Both start at DEFAULT_ZOOM. undergroundVisited is
 * false; activeView is 'surface'. Each camera is an independent object instance.
 *
 * @param startTileX - Starting tile X (typically PLAYER_START_X from constants.ts)
 * @param startTileY - Starting tile Y (typically PLAYER_START_Y from constants.ts)
 */
export function createViewState(startTileX: number, startTileY: number): ViewState {
  return {
    activeView: 'surface',
    activeTool: 'command',
    surfaceCamera: makeCameraView(tileCenterPx(startTileX), tileCenterPx(startTileY), DEFAULT_ZOOM),
    undergroundCamera: makeCameraView(
      tileCenterPx(startTileX),
      UNDERGROUND_INITIAL_CENTER_Y_PX,
      DEFAULT_ZOOM,
    ),
    undergroundVisited: false,
    // 09.1 Chunk 2 — fresh boot always starts looking at the player's own
    // underground so the first Tab to underground shows "Your Colony".
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    // Issue #114 — hydrate the pheromone overlay flag from persisted settings.
    showPheromoneOverlay: loadSettings().pheromoneOverlay,
  };
}

// ---------------------------------------------------------------------------
// resetViewState — in-place reset for session restart
// ---------------------------------------------------------------------------

/**
 * Reset an existing ViewState back to createViewState defaults, MUTATING IN PLACE
 * so references captured by UIScene / input handlers remain valid (reassigning to
 * a fresh object would strand those references — same failure class as the
 * stale-world bug). CameraView fields are written individually for the same reason.
 *
 * Used by bootFresh / bootFromSave / restartGame. Save files do not persist camera
 * state, so continue-from-save also starts back at the default surface view/zoom.
 */
export function resetViewState(viewState: ViewState, startTileX: number, startTileY: number): void {
  viewState.activeView = 'surface';
  viewState.activeTool = 'command';

  viewState.surfaceCamera.centerX = tileCenterPx(startTileX);
  viewState.surfaceCamera.centerY = tileCenterPx(startTileY);
  viewState.surfaceCamera.zoom = DEFAULT_ZOOM;
  viewState.surfaceCamera.targetZoom = DEFAULT_ZOOM;

  viewState.undergroundCamera.centerX = tileCenterPx(startTileX);
  viewState.undergroundCamera.centerY = UNDERGROUND_INITIAL_CENTER_Y_PX;
  viewState.undergroundCamera.zoom = DEFAULT_ZOOM;
  viewState.undergroundCamera.targetZoom = DEFAULT_ZOOM;

  viewState.undergroundVisited = false;
  // 09.1 Chunk 2 — restart always re-anchors the underground view on the
  // player's own grid. Save files do not persist which enemy nest was inspected.
  viewState.activeUndergroundColonyId = PLAYER_COLONY_ID;
  // Issue #114 — re-read the persisted overlay preference.
  viewState.showPheromoneOverlay = loadSettings().pheromoneOverlay;
}

// ---------------------------------------------------------------------------
// toggleView — atomic toggle algorithm (PLAN-stage2 §A5)
// ---------------------------------------------------------------------------

/**
 * toggleView — instant view switch with per-view zoom/center preserved.
 *
 * Algorithm (PLAN-stage2 §A5), order matters:
 *   1. Snapshot the LEAVING view — automatic: its CameraView persists in place; we
 *      only cancel any in-flight zoom-lerp so a later return doesn't resume a stale
 *      target.
 *   2. For the ENTERING view: its stored zoom is already restored (it persists on
 *      the CameraView). Apply the first-underground-visit centering BEFORE the
 *      X-link, then the X-link (centerX), then settle = cancel-lerp + custom clamp
 *      at the restored zoom (clamp depends on the zoomed viewport size, so zoom is
 *      restored before clamping).
 *   3. Reset the active tool to the entering view's default.
 *
 * Mutates viewState in-place. No animation — instant switch (VIEW-02).
 */
export function toggleView(viewState: ViewState): void {
  if (viewState.activeView === 'surface') {
    cancelZoomLerp(viewState.surfaceCamera); // freeze the leaving view's snapshot
    // First-underground-visit centering BEFORE the X-link (independent axes, but
    // spec order): set the shaft-at-top Y on the first visit only.
    if (!viewState.undergroundVisited) {
      viewState.undergroundCamera.centerY = UNDERGROUND_INITIAL_CENTER_Y_PX;
      viewState.undergroundVisited = true;
    }
    viewState.undergroundCamera.centerX = viewState.surfaceCamera.centerX; // X-link (world px)
    settleEnteringView(viewState.undergroundCamera, UNDERGROUND_WORLD_PX_W, UNDERGROUND_WORLD_PX_H);
    viewState.activeView = 'underground';
    viewState.activeTool = defaultToolForView('underground');
  } else {
    cancelZoomLerp(viewState.undergroundCamera); // freeze the leaving view's snapshot
    viewState.surfaceCamera.centerX = viewState.undergroundCamera.centerX; // X-link (world px)
    settleEnteringView(viewState.surfaceCamera, SURFACE_WORLD_PX_W, SURFACE_WORLD_PX_H);
    viewState.activeView = 'surface';
    viewState.activeTool = defaultToolForView('surface');
  }
}

// ---------------------------------------------------------------------------
// toggleUndergroundColony — 09.1 Chunk 2
// ---------------------------------------------------------------------------

/**
 * toggleUndergroundColony — flip `activeUndergroundColonyId` between the player's
 * colony and the enemy's colony. Binary toggle (09.1 has exactly 2 colonies).
 *
 * The caller (game-scene.ts X-keybind handler) must gate dispatch on
 * `activeView === 'underground'`. Mutates in place so UIScene / input handlers
 * that captured a ViewState reference keep seeing the update.
 */
export function toggleUndergroundColony(viewState: ViewState): void {
  viewState.activeUndergroundColonyId =
    viewState.activeUndergroundColonyId === PLAYER_COLONY_ID ? ENEMY_COLONY_ID : PLAYER_COLONY_ID;
}
