// ant-activity-panel-state.ts — module-level visibility flag for the HUD
// ant-activity breakdown popup.
//
// Mirrors the `contextMenuState` pattern: a single mutable object imported
// by UIScene (to draw), camera-input (to mask pointer click-through via
// isPointerOverHUD), and surface/underground-input indirectly through that
// mask. Keeping the state out of UIScene decouples the masking decision
// from scene lifetime — camera-input doesn't need a Phaser scene reference
// to read visibility.
//
// Deferred hide — why this matters:
//   UIScene's pointerdown handler and surface-input / underground-input's
//   pointerdown handlers are separate Phaser listeners that fire on the
//   same pointer event. Cross-scene dispatch order is not guaranteed.
//
//   If UIScene synchronously flipped `visible=false` when dismissing the
//   panel via a click outside it, a world-input handler running second
//   in the same dispatch would see `visible=false`, so `isPointerOverHUD`
//   (which consults this state) would return false, and the world handler
//   would interpret the dismissal click as (for example) a food-mark or
//   a rally placement or an entrance designation.
//
//   Instead, the dismissal path calls `requestHideAntActivityPanel()`,
//   which sets `pendingHide=true` but leaves `visible=true` for the
//   remainder of the current dispatch. `isPointerOverHUD` still masks
//   the click. At the top of the next UIScene.update frame,
//   `applyPendingAntActivityPanelHide()` commits the flip.
//
// Tests use `hideAntActivityPanel()` for immediate synchronous reset.

export interface AntActivityPanelState {
  visible: boolean;
  /** Set by requestHideAntActivityPanel; cleared by applyPendingAntActivityPanelHide on the next update frame. */
  pendingHide: boolean;
}

export const antActivityPanelState: AntActivityPanelState = {
  visible: false,
  pendingHide: false,
};

export function toggleAntActivityPanel(): void {
  antActivityPanelState.visible = !antActivityPanelState.visible;
  antActivityPanelState.pendingHide = false;
}

export function showAntActivityPanel(): void {
  antActivityPanelState.visible = true;
  antActivityPanelState.pendingHide = false;
}

/**
 * Immediately hide the panel. Use for Esc, scene shutdown, and tests —
 * contexts where there is no concurrent pointer dispatch to race with.
 */
export function hideAntActivityPanel(): void {
  antActivityPanelState.visible = false;
  antActivityPanelState.pendingHide = false;
}

/**
 * Request the panel be hidden on the next frame. Use inside pointerdown
 * handlers so all cross-scene handlers in the current dispatch observe
 * a consistent `visible=true` state — preventing the dismissal click
 * from falling through to world input.
 */
export function requestHideAntActivityPanel(): void {
  antActivityPanelState.pendingHide = true;
}

/**
 * Apply any pending hide. Call at the start of UIScene.update each frame,
 * before any state is read for rendering.
 */
export function applyPendingAntActivityPanelHide(): void {
  if (antActivityPanelState.pendingHide) {
    antActivityPanelState.visible = false;
    antActivityPanelState.pendingHide = false;
  }
}
