// queen-stores-strip-state.ts — #413: the strip the queen's "Waiting for stores" line
// is drawn on this frame (hud-stats.ts queenStoresRect), or null while the line is
// hidden. A module-level singleton like spider-order-chip-state's: UIScene sets it
// every frame and isPointerOverHUD reads it, so the painted strip masks world input
// (clicks, taps, drags, the wheel) only while it is drawn; hidden, its spot is world.
// Kept apart from storage-hint.ts so the input layer imports only this rect.

import type { HudRect } from './hud-layout.js';

export const queenStoresStripState: { rect: HudRect | null } = {
  rect: null,
};

/** Reset to hidden. Used by tests so the shared singleton does not leak between cases. */
export function resetQueenStoresStripState(): void {
  queenStoresStripState.rect = null;
}
