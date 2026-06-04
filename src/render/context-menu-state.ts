// context-menu-state.ts — Module-level singleton ContextMenuState.
//
// Shared state between UIScene (renderer) and underground-input (trigger).
// underground-input calls requestShowContextMenu() when the player right-clicks
// an Open tunnel-end; UIScene reads the state each frame to draw the menu.
//
// Deferred show AND hide: UIScene and underground-input both register pointerdown
// handlers in Phaser. The firing order across scenes is not guaranteed, so
// synchronously flipping `visible` inside a handler causes races:
//
//   - HIDE race: if UIScene synchronously flipped visible=false on selection, a
//     cross-scene handler running second would see visible=false and misinterpret
//     the click (e.g. dig-mark the tile beneath the menu).
//   - SHOW race: if underground-input synchronously flipped visible=true on a
//     right-click, UIScene's handler running SECOND in the same dispatch would
//     see visible=true and interpret the SAME right-click as a menu item
//     selection (the menu is anchored at the click, so the pointer lands on the
//     first item). The player would never see the menu — UIScene would push a
//     bogus PlaceChamberCommand and requestHideContextMenu() would clean it up
//     on the next frame.
//
// Both show and hide are deferred to the next UIScene.update frame. All handlers
// in the current pointerdown dispatch observe a consistent `visible` state.
//
// Tests use `hideContextMenu()` for immediate synchronous reset between cases.

export interface ContextMenuState {
  visible: boolean;
  screenX: number;
  screenY: number;
  anchorTileX: number;
  anchorTileY: number;
  /** Set by requestHideContextMenu; cleared by applyPendingContextMenuHide on the next update frame. */
  pendingHide: boolean;
  /** Set by requestShowContextMenu; cleared by applyPendingContextMenuShow on the next update frame. */
  pendingShow: boolean;
}

export const contextMenuState: ContextMenuState = {
  visible: false,
  screenX: 0,
  screenY: 0,
  anchorTileX: 0,
  anchorTileY: 0,
  pendingHide: false,
  pendingShow: false,
};

/**
 * Immediately hide the menu. Use in tests for state reset and in the
 * view-change auto-dismiss path (UIScene.update already runs once per frame,
 * so there is no race to worry about). Also clears any pending show so a
 * stale request doesn't resurrect the menu a frame later.
 */
export function hideContextMenu(): void {
  contextMenuState.visible = false;
  contextMenuState.pendingHide = false;
  contextMenuState.pendingShow = false;
}

/**
 * Request the menu be hidden on the next frame. Use inside pointerdown
 * handlers so all cross-scene handlers in the current dispatch observe
 * a consistent `visible=true` state.
 */
export function requestHideContextMenu(): void {
  contextMenuState.pendingHide = true;
}

/**
 * Request the menu be shown on the next frame, anchored at (screenX, screenY)
 * with the world tile under the click stored for later PlaceChamberCommand
 * dispatch. Sets pendingShow=true but leaves `visible` at its current value.
 * The anchor coordinates are stored immediately so any read that happens
 * between now and applyPendingContextMenuShow sees the fresh target.
 *
 * Use inside pointerdown handlers so UIScene's cross-scene pointerdown running
 * in the same dispatch does NOT see `visible=true` and mis-interpret the
 * right-click as a menu item selection.
 */
export function requestShowContextMenu(
  screenX: number,
  screenY: number,
  anchorTileX: number,
  anchorTileY: number,
): void {
  contextMenuState.screenX = screenX;
  contextMenuState.screenY = screenY;
  contextMenuState.anchorTileX = anchorTileX;
  contextMenuState.anchorTileY = anchorTileY;
  contextMenuState.pendingShow = true;
}

/**
 * Apply any pending hide. Call at the start of UIScene.update each frame,
 * before any state is read for rendering.
 */
export function applyPendingContextMenuHide(): void {
  if (contextMenuState.pendingHide) {
    contextMenuState.visible = false;
    contextMenuState.pendingHide = false;
  }
}

/**
 * Apply any pending show. Call at the start of UIScene.update each frame,
 * alongside applyPendingContextMenuHide. If both a hide and a show are pending
 * in the same frame (unusual — would require two pointerdowns within one
 * frame), hide runs first so the pending show wins, reflecting the most
 * recently-requested state.
 */
export function applyPendingContextMenuShow(): void {
  if (contextMenuState.pendingShow) {
    contextMenuState.visible = true;
    contextMenuState.pendingShow = false;
  }
}
