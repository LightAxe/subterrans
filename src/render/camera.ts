// camera.ts — Phase 8 render-layer camera state, view state, and camera utilities.
//
// Source: PRD §7a/§7b/§7c (03-PRD-world-interaction.md)
//
// This file is in src/render/ — no Phaser imports, no DOM globals.
// Only imports: src/sim/constants.js (world dimensions) and src/render/sprites.js (TILE_SIZE_PX).
// Pure TypeScript functions, fully testable under Node + Vitest.

import { TILE_SIZE_PX } from './sprites.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { loadSettings } from '../platform/settings.js';

// Suppress unused import warning — TILE_SIZE_PX is used in screenToTile below.
void TILE_SIZE_PX;

// ---------------------------------------------------------------------------
// CameraState
// ---------------------------------------------------------------------------

/**
 * CameraState — pure TypeScript render-layer camera position.
 *
 * All values are in tile units. x/y are the CENTER of the viewport (not top-left).
 * This is distinct from Phaser's camera `scrollX`/`scrollY` which are top-left pixel offsets.
 *
 * To convert for Phaser: `scrollX = (cam.x - cam.viewportWidth / 2) * TILE_SIZE_PX`
 */
export interface CameraState {
  /** Tile-unit X coordinate of the viewport center. */
  x: number;
  /** Tile-unit Y coordinate of the viewport center. */
  y: number;
  /** Viewport width in tiles. */
  viewportWidth: number;
  /** Viewport height in tiles. */
  viewportHeight: number;
}

// ---------------------------------------------------------------------------
// Camera constants (PRD §7a)
// ---------------------------------------------------------------------------

/** Number of tiles visible horizontally at the default 800×592 canvas / 16px tiles. PRD §7a. */
export const VIEWPORT_WIDTH_TILES = 50;

/** Number of tiles visible vertically at the default 800×592 canvas / 16px tiles. PRD §7a. */
export const VIEWPORT_HEIGHT_TILES = 37;

/**
 * Camera pan speed in tiles per render frame.
 * Applied each frame arrow/WASD key is held. PRD §7a.
 */
export const CAMERA_SCROLL_SPEED = 0.5;

/**
 * Distance from canvas edge (in pixels) that triggers mouse edge-pan. PRD §7a.
 */
export const EDGE_PAN_THRESHOLD_PX = 32;

/**
 * Initial underground-camera Y on fresh boot / session reset / first view
 * toggle. Set to half the viewport so tile y=0 sits at the very top of the
 * visible region — this places the surface entrance / starter shaft row
 * near the top-center of the underground view, giving the player an
 * immediate spatial connection between the surface hole they just dug and
 * the tunnel they're about to excavate.
 *
 * Derived from VIEWPORT_HEIGHT_TILES rather than UNDERGROUND_GRID_HEIGHT —
 * the old mid-depth start (UNDERGROUND_GRID_HEIGHT/2) left the shaft
 * entirely off-screen and made the first underground visit disorienting.
 * Using the viewport half puts this value exactly at clampCamera's minimum
 * Y, so if viewport dimensions change the shaft stays anchored to the top.
 */
export const UNDERGROUND_INITIAL_CAMERA_Y = VIEWPORT_HEIGHT_TILES / 2;

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
 * Not part of WorldState — this is render-layer state only (PRD §7c).
 * Surface and underground cameras maintain independent Y positions.
 * X positions are linked on toggle (PRD §7c algorithm: Pattern 9).
 */
export interface ViewState {
  /** Which view is currently displayed. */
  activeView: 'surface' | 'underground';
  /** Camera state for the surface top-down view. */
  surfaceCamera: CameraState;
  /** Camera state for the underground side-view cross-section. */
  undergroundCamera: CameraState;
  /**
   * Whether the underground view has been visited at least once.
   * Used for first-visit Y-centering (PRD §7c): undergroundCamera.y is set to
   * UNDERGROUND_INITIAL_CAMERA_Y (shaft row near the top) on the FIRST
   * toggle to underground only.
   */
  undergroundVisited: boolean;
  /**
   * 09.1 Chunk 2 — which colony's underground grid the player is currently
   * viewing. Defaults to PLAYER_COLONY_ID on fresh boot and after
   * resetViewState. Toggled between PLAYER and ENEMY by the X keybind (via
   * toggleUndergroundColony) while activeView === 'underground'. 09.1 has
   * exactly two colonies, so a binary flip is sufficient; future N-colony
   * expansion is out of scope per 09.1-CONTEXT.
   *
   * draw-underground.ts reads this field for all four grid-keyed lookups
   * (grid, entrances, chambers, ant filter). Ant filter also consults
   * ants.currentGridColonyId so player Fighters inside the enemy grid
   * still render (Research Risk D, Chunk 0 dependency).
   */
  activeUndergroundColonyId: ColonyId;
  /**
   * Issue #114 — render-only flag controlling whether the player's pheromone
   * overlay is drawn. Hydrated from persisted settings (subterrans:settings:v1)
   * on createViewState / resetViewState; toggled by the P key and by the pause
   * menu Settings sub-screen, both of which write back through saveSettings.
   * Skipped at draw time in game-scene.ts; never round-trips through save.ts.
   */
  showPheromoneOverlay: boolean;
  /**
   * Stage 1 controls rework (issue #18) — the active input tool. Resets to the
   * view default on every `toggleView`; persists within a view. `chamber` is
   * underground-only (selecting it on the surface is a no-op upstream).
   */
  activeTool: ToolId;
}

// ---------------------------------------------------------------------------
// createViewState factory
// ---------------------------------------------------------------------------

/**
 * createViewState — construct initial ViewState for a new game session.
 *
 * surfaceCamera is centered at (startTileX, startTileY).
 * undergroundCamera is centered horizontally on the starter entrance column
 * (startTileX) and vertically at UNDERGROUND_INITIAL_CAMERA_Y so the shaft /
 * surface-entrance row sits near the top of the viewport.
 * undergroundVisited is false; activeView is 'surface'.
 *
 * Each camera is an independent object instance (no shared references).
 *
 * @param startTileX - Starting tile X (typically PLAYER_START_X from constants.ts)
 * @param startTileY - Starting tile Y (typically PLAYER_START_Y from constants.ts)
 */
export function createViewState(startTileX: number, startTileY: number): ViewState {
  return {
    activeView: 'surface',
    activeTool: 'command',
    surfaceCamera: {
      x: startTileX,
      y: startTileY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundCamera: {
      x: startTileX,
      y: UNDERGROUND_INITIAL_CAMERA_Y,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundVisited: false,
    // 09.1 Chunk 2 — fresh boot always starts looking at the player's own
    // underground so the first Tab to underground shows "Your Colony".
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    // Issue #114 — hydrate the pheromone overlay flag from persisted settings.
    // localStorage may be unavailable (Node test runs); loadSettings falls back
    // to DEFAULT_SETTINGS, which keeps the overlay ON to match the prior
    // always-visible behavior.
    showPheromoneOverlay: loadSettings().pheromoneOverlay,
  };
}

// ---------------------------------------------------------------------------
// resetViewState — in-place reset for session restart
// ---------------------------------------------------------------------------

/**
 * Reset an existing ViewState back to the same defaults as createViewState,
 * but MUTATING IN PLACE so references captured by UIScene / input handlers
 * remain valid. Reassigning to a fresh object would strand those references
 * on the pre-restart ViewState (same failure class as the stale-world bug).
 *
 * Used by bootFresh / bootFromSave / restartGame: a new session must not
 * inherit the prior session's activeView, camera position, drag state, or
 * first-visit flag. Save files do not persist camera state, so continue-from-
 * save also starts the player back at the default surface view.
 */
export function resetViewState(viewState: ViewState, startTileX: number, startTileY: number): void {
  viewState.activeView = 'surface';
  viewState.activeTool = 'command';
  viewState.surfaceCamera.x = startTileX;
  viewState.surfaceCamera.y = startTileY;
  viewState.surfaceCamera.viewportWidth = VIEWPORT_WIDTH_TILES;
  viewState.surfaceCamera.viewportHeight = VIEWPORT_HEIGHT_TILES;
  viewState.undergroundCamera.x = startTileX;
  viewState.undergroundCamera.y = UNDERGROUND_INITIAL_CAMERA_Y;
  viewState.undergroundCamera.viewportWidth = VIEWPORT_WIDTH_TILES;
  viewState.undergroundCamera.viewportHeight = VIEWPORT_HEIGHT_TILES;
  viewState.undergroundVisited = false;
  // 09.1 Chunk 2 — restart always re-anchors the underground view on the
  // player's own grid. Save files do not persist which enemy nest was being
  // inspected, so continue-from-save also defaults to "Your Colony".
  viewState.activeUndergroundColonyId = PLAYER_COLONY_ID;
  // Issue #114 — re-read the persisted overlay preference. The setting is a
  // cosmetic preference, not session state, so a restart should respect the
  // current localStorage value rather than snap back to ON unconditionally.
  viewState.showPheromoneOverlay = loadSettings().pheromoneOverlay;
}

// ---------------------------------------------------------------------------
// toggleView
// ---------------------------------------------------------------------------

/**
 * toggleView — PRD §7c algorithm (Pattern 9) for instant view switching.
 *
 * Surface → Underground:
 *   - Copies surfaceCamera.x → undergroundCamera.x (X-link sync)
 *   - If first visit: sets undergroundCamera.y = UNDERGROUND_INITIAL_CAMERA_Y
 *     (shaft/starter-hole row near the top) and marks visited
 *   - Sets activeView = 'underground'
 *
 * Underground → Surface:
 *   - Copies undergroundCamera.x → surfaceCamera.x (X-link sync)
 *   - Surface Y is NOT changed (PRD §7c: "Surface Y is preserved across toggles")
 *   - Sets activeView = 'surface'
 *
 * Mutates viewState in-place. No animation — instant switch (VIEW-02).
 *
 * @param viewState - The current ViewState to toggle
 */
export function toggleView(viewState: ViewState): void {
  if (viewState.activeView === 'surface') {
    viewState.undergroundCamera.x = viewState.surfaceCamera.x;
    if (!viewState.undergroundVisited) {
      viewState.undergroundCamera.y = UNDERGROUND_INITIAL_CAMERA_Y;
      viewState.undergroundVisited = true;
    }
    viewState.activeView = 'underground';
    viewState.activeTool = defaultToolForView('underground');
  } else {
    viewState.surfaceCamera.x = viewState.undergroundCamera.x;
    viewState.activeView = 'surface';
    viewState.activeTool = defaultToolForView('surface');
  }
}

// ---------------------------------------------------------------------------
// toggleUndergroundColony — 09.1 Chunk 2
// ---------------------------------------------------------------------------

/**
 * toggleUndergroundColony — flip `activeUndergroundColonyId` between the
 * player's colony and the enemy's colony.
 *
 * Binary toggle: 09.1 has exactly 2 colonies, so flipping between
 * PLAYER_COLONY_ID and ENEMY_COLONY_ID is sufficient. Any future N-colony
 * expansion should replace this helper with a parameterized version (cycle
 * forward / set explicit).
 *
 * The caller (game-scene.ts X-keybind handler) must gate dispatch on
 * `activeView === 'underground'`. The reducer itself is pure with respect
 * to other fields — it only touches `activeUndergroundColonyId`, so a stray
 * dispatch while on the surface view cannot flip the player out of surface
 * mode. Mutates in place so UIScene and input handlers that captured a
 * reference to the ViewState in create() keep seeing the update (same
 * in-place contract as toggleView / resetViewState).
 *
 * @param viewState - The current ViewState to toggle
 */
export function toggleUndergroundColony(viewState: ViewState): void {
  viewState.activeUndergroundColonyId =
    viewState.activeUndergroundColonyId === PLAYER_COLONY_ID ? ENEMY_COLONY_ID : PLAYER_COLONY_ID;
}

// ---------------------------------------------------------------------------
// clampCamera
// ---------------------------------------------------------------------------

/**
 * clampCamera — constrain camera center position to valid world bounds.
 *
 * Enforces that the camera center stays at least half a viewport from each world edge,
 * so the visible window never shows outside the world bounds (VIEW-04).
 *
 * Mutates cam in-place.
 *
 * Degenerate guard: if worldW < viewportWidth, cam.x = worldW/2 (centers on the world).
 *
 * @param cam - The CameraState to clamp (mutated in-place)
 * @param worldW - World width in tiles
 * @param worldH - World height in tiles
 */
export function clampCamera(cam: CameraState, worldW: number, worldH: number): void {
  const hw = cam.viewportWidth / 2;
  const hh = cam.viewportHeight / 2;

  // X axis
  if (worldW < cam.viewportWidth) {
    cam.x = worldW / 2;
  } else {
    cam.x = Math.max(hw, Math.min(worldW - hw, cam.x));
  }

  // Y axis
  if (worldH < cam.viewportHeight) {
    cam.y = worldH / 2;
  } else {
    cam.y = Math.max(hh, Math.min(worldH - hh, cam.y));
  }
}

// ---------------------------------------------------------------------------
// screenToTile
// ---------------------------------------------------------------------------

/**
 * screenToTile — convert screen pixel coordinates to tile coordinates.
 *
 * Converts a screen pixel position (e.g., mouse cursor) to the tile coordinates
 * it corresponds to, given the current camera state.
 *
 * Mirrors the renderer's integer-tile snap: draw-surface / draw-underground /
 * draw-pheromone all compute `left = Math.floor(cam.x - viewportWidth/2)` so
 * world tiles are drawn at integer-aligned pixel offsets. We apply the same
 * floor here so a click lands on the tile the player sees. Using the raw
 * fractional camera caused up to a ~15px drift between the rendered food
 * pile and the tile `findFoodPileAt` resolved to, making clicks miss unless
 * they struck near the tile center.
 *
 * @param screenX - Screen X in pixels (0 = left edge of canvas)
 * @param screenY - Screen Y in pixels (0 = top edge of canvas)
 * @param cam - The active CameraState
 * @returns Tile coordinates { tileX, tileY }
 */
export function screenToTile(
  screenX: number,
  screenY: number,
  cam: CameraState,
): { tileX: number; tileY: number } {
  const left = Math.floor(cam.x - cam.viewportWidth / 2);
  const top = Math.floor(cam.y - cam.viewportHeight / 2);
  return {
    tileX: Math.floor(screenX / TILE_SIZE_PX) + left,
    tileY: Math.floor(screenY / TILE_SIZE_PX) + top,
  };
}
