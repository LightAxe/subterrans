// surface-input.ts — Phase 9 surface-click dispatcher.
//
// Handles left-click (food-pile mark + entrance designation confirmation + rally point set)
// and right-click (entrance preview + rally point clear) on the surface view.
//
// Priority order for left-click:
//   1. Entrance designation confirmation (if pendingEntrance matches both X+Y)
//   2. Food-pile mark (if tile has a food pile)
//   3. (empty) fall-through: SetRallyPoint (SURF-04)
//
// Guards:
//   - viewState.activeView must be 'surface' before dispatching any command.
//   - isPointerOverHUD rejects clicks that land on HUD zones (Pitfall 2).
//   - Tile bounds check (tileX/Y >= 0) before pushing commands.
//   - ADR-0006: world.colonies accessed via plain-object bracket notation — never .get().

import * as Phaser from 'phaser';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { screenToTile } from '../render/camera.js';
import type { FoodPile } from '../sim/food.js';
import type {
  MarkFoodPileCommand,
  DesignateEntranceCommand,
  SetRallyPointCommand,
  ClearRallyPointCommand,
} from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { isPointerOverHUD, panInputState } from './camera-input.js';

// ---------------------------------------------------------------------------
// SurfaceInputState — mutable per-registration state
// ---------------------------------------------------------------------------

/**
 * Exported so the render layer (draw-surface.ts) can read `pendingEntranceTileX`
 * / `pendingEntranceTileY` and draw a preview outline on the tile the player
 * right-clicked. Phase 8.5 interaction-feedback fix: before, the right-click
 * preview was invisible and players had to remember the exact tile between
 * right-click and the confirming left-click.
 */
export interface SurfaceInputState {
  /** Right-click preview state: null = no pending designation, number = tileX of pending entrance. */
  pendingEntranceTileX: number | null;
  /** TileY companion to pendingEntranceTileX — needed so the render layer can outline the right cell. */
  pendingEntranceTileY: number | null;
}

/**
 * Reset a SurfaceInputState in-place so the new session starts without any
 * pending entrance-preview left over from the previous game. Called at
 * session-restart boundaries; preserves the object identity captured by
 * registerSurfaceInput's pointerdown closure and by the render layer.
 */
export function resetSurfaceInputState(state: SurfaceInputState): void {
  state.pendingEntranceTileX = null;
  state.pendingEntranceTileY = null;
}

// ---------------------------------------------------------------------------
// isEmptySurfaceTile — checks whether a tile is empty (not entrance, not food pile)
// ---------------------------------------------------------------------------

/**
 * Returns true when (tileX, tileY) is a valid surface tile that is:
 *   - within grid bounds
 *   - NOT occupied by any colony entrance (checked across all colonies via Object.keys)
 *   - NOT a food pile location
 *
 * ADR-0006: world.colonies is a PLAIN OBJECT. Uses Object.keys — never .keys()/.entries()/.get().
 * SURF-04: empty-tile fallthrough → SetRallyPointCommand.
 */
export function isEmptySurfaceTile(world: WorldState, tileX: number, tileY: number): boolean {
  // Bounds check
  if (tileX < 0 || tileY < 0) return false;
  if (tileX >= world.surface.width || tileY >= world.surface.height) return false;

  // Check not a food pile
  for (const pile of world.foodPiles) {
    if (pile.tileX === tileX && pile.tileY === tileY) return false;
  }

  // Check not a colony entrance — iterate colonies via Object.keys (ADR-0006)
  for (const key of Object.keys(world.colonies)) {
    const colony = world.colonies[Number(key) as ColonyId];
    if (colony === undefined) continue;
    for (const entrance of colony.entrances) {
      if (entrance.surfaceTileX === tileX && entrance.surfaceTileY === tileY) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// isForeignColonyEntrance — issue #14 invasion enabler
// ---------------------------------------------------------------------------

/**
 * Returns true when (tileX, tileY) is the surface tile of an entrance owned
 * by a colony OTHER than `ownColonyId`. Bounds and food-pile checks are not
 * required here — handleSurfaceLeftClick has already evaluated those.
 *
 * Issue #14: enables the player to left-click an enemy entrance to rally
 * Fighting ants there. The Phase 09.1 cross-grid descent + combat path is
 * already wired (REQ-C3a, REQ-C4a); the rally input was the missing seam.
 *
 * Closed enemy entrances are intentionally still eligible — the rally-tile
 * carve-out in updateFightAntTargets walks fighters onto the exact tile,
 * but the descent-intent gate in tickAntMovement requires `isOpen` before
 * crossing into the enemy grid. So a rally on a closed enemy entrance
 * piles fighters at the door, ready to invade the moment the enemy AI
 * opens it. That's the right read of "I want to attack here" — no need
 * for the input layer to second-guess open/closed.
 *
 * ADR-0006: world.colonies is a PLAIN OBJECT. Uses Object.keys (per the
 * existing isEmptySurfaceTile pattern).
 */
export function isForeignColonyEntrance(
  world: WorldState,
  tileX: number,
  tileY: number,
  ownColonyId: ColonyId,
): boolean {
  if (tileX < 0 || tileY < 0) return false;
  if (tileX >= world.surface.width || tileY >= world.surface.height) return false;
  for (const key of Object.keys(world.colonies)) {
    const cid = Number(key) as ColonyId;
    if (cid === ownColonyId) continue;
    const colony = world.colonies[cid];
    if (colony === undefined) continue;
    for (const entrance of colony.entrances) {
      if (entrance.surfaceTileX === tileX && entrance.surfaceTileY === tileY) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// findFoodPileAt — O(n) scan over world.foodPiles
// ---------------------------------------------------------------------------

/**
 * Returns the FoodPile at (tileX, tileY) or null if none.
 * Called by handleSurfaceLeftClick when no entrance confirmation is pending.
 */
export function findFoodPileAt(world: WorldState, tileX: number, tileY: number): FoodPile | null {
  for (const pile of world.foodPiles) {
    if (pile.tileX === tileX && pile.tileY === tileY) return pile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// handleSurfaceLeftClick
// ---------------------------------------------------------------------------

/**
 * Handles a left-click on the surface view.
 *
 * Priority order:
 *   1. If the clicked tile matches the pending entrance preview in BOTH X and Y,
 *      push DesignateEntranceCommand and clear the preview.
 *   2. Else → try food-pile mark at the clicked tile.
 *
 * No-ops if: activeView !== 'surface', pointer over HUD, or tile out of bounds.
 *
 * Phase 8.5 fix: confirmation previously matched only `tileX`, which meant a
 * player could right-click to preview tile (X, Y1), left-click a different row
 * (X, Y2) on the same column, and still confirm — but the command fired with
 * the second tile's Y. The preview frame and the placed entrance could
 * disagree. Confirmation now requires both tile coordinates to match the
 * previewed tile exactly; a non-matching left-click falls through to food-pile
 * mark and leaves the preview intact so the player can try again.
 */
export function handleSurfaceLeftClick(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
  state: SurfaceInputState,
): void {
  if (viewState.activeView !== 'surface') return;
  if (isPointerOverHUD(screenX, screenY, viewState)) return;
  // Pan-mode guard: while Space is held or a pan gesture is already in flight,
  // the left-click is the pan trigger — not a world action.
  if (panInputState.spaceHeld || panInputState.isPanning) return;
  const { tileX, tileY } = screenToTile(screenX, screenY, viewState.surfaceCamera);
  if (tileX < 0 || tileY < 0) return;

  // Entrance designation confirmation: left-click on the exact tile that was
  // previewed by a prior right-click (both X and Y must match).
  if (
    state.pendingEntranceTileX !== null &&
    state.pendingEntranceTileY !== null &&
    state.pendingEntranceTileX === tileX &&
    state.pendingEntranceTileY === tileY
  ) {
    const cmd: DesignateEntranceCommand = {
      type: 'DesignateEntrance',
      colonyId: PLAYER_COLONY_ID,
      surfaceTileX: tileX,
      surfaceTileY: tileY,
      issuedAtTick: world.tick,
    };
    world.commandQueue.push(cmd);
    state.pendingEntranceTileX = null;
    state.pendingEntranceTileY = null;
    return;
  }

  // Food-pile mark at clicked tile (priority 2).
  const pile = findFoodPileAt(world, tileX, tileY);
  if (pile) {
    const cmd: MarkFoodPileCommand = {
      type: 'MarkFoodPile',
      colonyId: PLAYER_COLONY_ID,
      tileX: pile.tileX,
      tileY: pile.tileY,
      issuedAtTick: world.tick,
    };
    world.commandQueue.push(cmd);
    return;
  }

  // Foreign-colony entrance rally (priority 3 — issue #14): left-click on an
  // enemy colony's open entrance tile sets the player's rally point there.
  // This is the input piece that unlocks Phase 09.1's invasion mechanic —
  // Fighting ants rally to the tile, the rally-on-entrance carve-out in
  // updateFightAntTargets keeps them walking onto it, and the descent-intent
  // gate in tickAntMovement crosses them into the enemy underground grid.
  // Own-colony entrance left-click stays a no-op so the right-click → left-
  // click entrance designation flow is undisturbed.
  //
  // Ordering note: food-pile mark (priority 2) wins over foreign-entrance
  // rally if a food pile and an enemy entrance somehow share a tile. The
  // scenario seeder (createScenario) places enemy entrances at the colony
  // start tile and food piles at distinct tiles, so this collision can't
  // arise in practice today. If a future feature lets food piles spawn
  // anywhere, prefer the food-mark — the player can always rally on an
  // adjacent tile (the rally-on-entrance carve-out only requires the EXACT
  // entrance tile, but a one-tile-off rally still routes fighters to the
  // entrance via the existing path-to-rally walk).
  if (isForeignColonyEntrance(world, tileX, tileY, PLAYER_COLONY_ID)) {
    handleSetRallyPoint(world, tileX, tileY, PLAYER_COLONY_ID);
    return;
  }

  // Empty-tile fallthrough (priority 4): set rally point for player colony (SURF-04).
  if (isEmptySurfaceTile(world, tileX, tileY)) {
    handleSetRallyPoint(world, tileX, tileY, PLAYER_COLONY_ID);
  }
}

// ---------------------------------------------------------------------------
// handleSetRallyPoint — inner helper (pure dispatch, extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Pushes SetRallyPointCommand for the given colony at (tileX, tileY).
 * Called by handleSurfaceLeftClick's empty-tile fallthrough (SURF-04).
 * colonyId argument is always the player colony — AI colonies are never passed here.
 */
export function handleSetRallyPoint(
  world: WorldState,
  tileX: number,
  tileY: number,
  playerColonyId: ColonyId,
): void {
  const cmd: SetRallyPointCommand = {
    type: 'SetRallyPoint',
    colonyId: playerColonyId,
    tileX,
    tileY,
    issuedAtTick: world.tick,
  };
  world.commandQueue.push(cmd);
}

// ---------------------------------------------------------------------------
// handleSurfaceRightClick
// ---------------------------------------------------------------------------

/**
 * Handles a right-click on the surface view.
 *
 * Priority order:
 *   1. If the clicked tile matches the current rally-point tile, push ClearRallyPointCommand.
 *   2. Otherwise, if the tile is a valid entrance target, set pendingEntranceTileX/Y
 *      for entrance designation preview. A subsequent left-click on the same tile
 *      confirms and pushes DesignateEntranceCommand.
 *   3. Invalid entrance tiles (food piles, existing colony entrances, out-of-bounds) do nothing —
 *      the preview is suppressed so the UI never advertises a target the sim would reject.
 *
 * No-ops if: activeView !== 'surface', pointer over HUD, or tile out of bounds.
 *
 * ADR-0006: world.colonies accessed via plain-object bracket notation.
 */
export function handleSurfaceRightClick(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
  state: SurfaceInputState,
  playerColonyId: ColonyId = PLAYER_COLONY_ID,
): void {
  if (viewState.activeView !== 'surface') return;
  if (isPointerOverHUD(screenX, screenY, viewState)) return;
  const { tileX, tileY } = screenToTile(screenX, screenY, viewState.surfaceCamera);
  if (tileX < 0 || tileY < 0) return;

  // Rally-point clear: right-click on the current rally point tile (SURF-04)
  const playerColony = world.colonies[playerColonyId];  // plain-object bracket access (ADR-0006)
  if (playerColony !== undefined && playerColony.rallyPoint !== null) {
    if (playerColony.rallyPoint.tileX === tileX && playerColony.rallyPoint.tileY === tileY) {
      const cmd: ClearRallyPointCommand = {
        type: 'ClearRallyPoint',
        colonyId: playerColonyId,
        issuedAtTick: world.tick,
      };
      world.commandQueue.push(cmd);
      return;
    }
  }

  // Entrance preview — only on valid entrance target tiles. The sim rejects
  // DesignateEntrance on food piles and tiles already occupied by any colony's
  // entrance; previewing those would advertise a target the sim will silently
  // drop and mislead the player. Invalid click: do nothing (no preview, no
  // state change). isEmptySurfaceTile already does the bounds check.
  if (!isEmptySurfaceTile(world, tileX, tileY)) return;
  state.pendingEntranceTileX = tileX;
  state.pendingEntranceTileY = tileY;
}

// ---------------------------------------------------------------------------
// registerSurfaceInput — wires Phaser pointer events
// ---------------------------------------------------------------------------

/**
 * registerSurfaceInput — attach surface-click handlers to a Phaser.Scene.
 *
 * Called from GameScene.create() (Plan 06 Task 3). Each handler internally
 * guards on viewState.activeView === 'surface', so surface + underground
 * handlers may both be registered without interference.
 *
 * getWorld is a LAZY accessor — called on every pointer event — so the
 * handler always dispatches against the live WorldState even if
 * GameScene swaps references mid-session (bootFresh, bootFromSave,
 * restartGame). Direct world-reference capture was a stale-closure bug:
 * the world assigned after registration was invisible to the handler.
 * Returns undefined pre-boot; all handlers short-circuit.
 *
 * @param scene     - Phaser.Scene (GameScene) providing the input event bus.
 * @param getWorld  - Lazy accessor for the live WorldState.
 * @param viewState - Render-layer ViewState; activeView is read for guard.
 */
export function registerSurfaceInput(
  scene: Phaser.Scene,
  getWorld: () => WorldState | undefined,
  viewState: ViewState,
): SurfaceInputState {
  const state: SurfaceInputState = {
    pendingEntranceTileX: null,
    pendingEntranceTileY: null,
  };
  scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    const world = getWorld();
    if (!world) return;
    if (pointer.leftButtonDown()) {
      handleSurfaceLeftClick(world, viewState, pointer.x, pointer.y, state);
    } else if (pointer.rightButtonDown()) {
      handleSurfaceRightClick(world, viewState, pointer.x, pointer.y, state);
    }
  });
  return state;
}
