// hint-strip-state.ts — Stage 3b controls rework (issue #18, component #2).
//
// Module-level singleton for the hint-strip legend's visibility, mirroring the
// antActivityPanelState pattern: it is the in-memory authoritative source two
// layers must agree on without UIScene reaching into camera-input (and vice-
// versa):
//   - UIScene.renderHintStrip() gates ONLY the static legend on it (the paused-
//     queue-full warning + caption-yield stay visible regardless — Codex R1#3).
//   - isPointerOverHUD() drops hud.HINTS from the world-input mask when the
//     legend is hidden, so a hidden strip leaves no dead input zone (Codex R1#2).
//
// Authoritative in-memory truth (like ViewState.showPheromoneOverlay): the
// pause-menu toggle flips this AND best-effort persists `hintStripVisible` to
// settings. On boot UIScene seeds it from loadSettings(). Default true.

export const hintStripState: { visible: boolean } = {
  visible: true,
};

/** Reset to the default (visible). Used by tests so the shared singleton does
 *  not leak state between cases. */
export function resetHintStripState(): void {
  hintStripState.visible = true;
}
