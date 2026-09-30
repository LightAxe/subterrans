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
// pure adapter, sim world dimensions, persisted settings, and (#378) read-only sim
// types/helpers to find a colony's nest. Fully testable under Node + Vitest.

import { TILE_SIZE_PX } from './sprites.js';
import {
  type CameraView,
  makeCameraView,
  DEFAULT_ZOOM,
  cancelZoomLerp,
  settleEnteringView,
  initialUndergroundCenterYPx,
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
import type { WorldState } from '../sim/types.js';
import { ChamberType } from '../sim/enums.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { colonyPoolTileX } from '../sim/food/food-api.js';
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
   * to initialUndergroundCenterYPx() (shaft row near the top) on the FIRST
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
   * #378 — where the underground camera was (world px) when the player last left
   * each colony's underground view with the colony toggle, keyed by colony. The
   * toggle restores it on the way back; a colony not yet looked at has none and
   * the camera centres on its nest instead (toggleUndergroundColony). Cleared by
   * resetViewState; mutated in place.
   */
  undergroundCenterByColony: Map<ColonyId, { centerX: number; centerY: number }>;
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
 * initialUndergroundCenterYPx() so the shaft / surface-entrance row sits near
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
      initialUndergroundCenterYPx(),
      DEFAULT_ZOOM,
    ),
    undergroundVisited: false,
    // 09.1 Chunk 2 — fresh boot always starts looking at the player's own
    // underground so the first Tab to underground shows "Your Colony".
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    undergroundCenterByColony: new Map(),
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
  viewState.undergroundCamera.centerY = initialUndergroundCenterYPx();
  viewState.undergroundCamera.zoom = DEFAULT_ZOOM;
  viewState.undergroundCamera.targetZoom = DEFAULT_ZOOM;

  viewState.undergroundVisited = false;
  // 09.1 Chunk 2 — restart always re-anchors the underground view on the
  // player's own grid. Save files do not persist which enemy nest was inspected.
  viewState.activeUndergroundColonyId = PLAYER_COLONY_ID;
  // #378 — a new round (or a load) has looked at no colony's nest yet.
  viewState.undergroundCenterByColony.clear();
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
      viewState.undergroundCamera.centerY = initialUndergroundCenterYPx();
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
// toggleUndergroundColony — 09.1 Chunk 2 (+ #378 camera)
// ---------------------------------------------------------------------------

/**
 * #378 — the world-pixel point the underground camera centres on to show
 * `colonyId`'s nest, or null when the colony has nothing to find (no such colony,
 * or none of the below). In order:
 *   1. its Queen chamber's centre — the heart of the nest;
 *   2. else the column of its first open entrance, else of its first entrance,
 *      else of its entrance pool (the colony's start column), at the "shaft at
 *      the top" depth a first underground visit uses (initialUndergroundCenterYPx).
 * Colony-agnostic (CLNY-08): the same rule for the player's colony and any other.
 * Pure; the caller clamps.
 */
export function undergroundNestCenterPx(
  world: WorldState,
  colonyId: ColonyId,
): { x: number; y: number } | null {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return null;
  for (const ch of colony.chambers) {
    if (ch.chamberType !== ChamberType.Queen) continue;
    return {
      x: ((ch.posX >> FP_SHIFT) + ch.width / 2) * TILE_SIZE_PX,
      y: ((ch.posY >> FP_SHIFT) + ch.height / 2) * TILE_SIZE_PX,
    };
  }
  const entrances = colony.entrances ?? [];
  const entrance = entrances.find((e) => e.isOpen) ?? entrances[0];
  const column = entrance !== undefined ? entrance.surfaceTileX : colonyPoolTileX(world, colony);
  if (column < 0) return null;
  return { x: tileCenterPx(column), y: initialUndergroundCenterYPx() };
}

/**
 * toggleUndergroundColony — flip `activeUndergroundColonyId` between the player's
 * colony and the enemy's colony. Binary toggle (09.1 has exactly 2 colonies).
 *
 * #378 — and move the underground camera to the colony it switches to. Each
 * colony's view keeps its own spot, the way the surface and underground views
 * keep theirs across Tab: the camera's centre is remembered for the colony being
 * left (undergroundCenterByColony) and the one being entered gets its remembered
 * centre back, so peeking at the enemy and toggling back returns the player to
 * exactly where they were working in their own nest. A colony not looked at yet
 * (none remembered) is shown centred on its nest (undergroundNestCenterPx); if
 * it has none to find, or no `world` is given, the camera stays where it is (only
 * clamped). Zoom is untouched (it belongs to the underground view); the move
 * settles like a view toggle (in-flight zoom-lerp cancelled, clamped). Nothing
 * here names a colony but the flip itself. A remembered spot is only ever written
 * by this toggle: a Tab or minimap trip in between does not update it, so toggling
 * back returns to where the player last left that colony's view.
 *
 * The callers (game-scene.ts X-keybind handler, ui-scene.ts colony-toggle button)
 * must gate dispatch on `activeView === 'underground'`. Mutates in place so
 * UIScene / input handlers that captured a ViewState reference keep seeing the
 * update.
 */
export function toggleUndergroundColony(viewState: ViewState, world?: WorldState): void {
  const leaving = viewState.activeUndergroundColonyId;
  const entering = leaving === PLAYER_COLONY_ID ? ENEMY_COLONY_ID : PLAYER_COLONY_ID;
  const cam = viewState.undergroundCamera;
  viewState.undergroundCenterByColony.set(leaving, { centerX: cam.centerX, centerY: cam.centerY });
  const remembered = viewState.undergroundCenterByColony.get(entering);
  const nest =
    remembered === undefined && world !== undefined
      ? undergroundNestCenterPx(world, entering)
      : null;
  if (remembered !== undefined) {
    cam.centerX = remembered.centerX;
    cam.centerY = remembered.centerY;
  } else if (nest !== null) {
    cam.centerX = nest.x;
    cam.centerY = nest.y;
  }
  settleEnteringView(cam, UNDERGROUND_WORLD_PX_W, UNDERGROUND_WORLD_PX_H);
  viewState.activeUndergroundColonyId = entering;
}
