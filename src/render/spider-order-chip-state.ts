// spider-order-chip-state.ts — #400: whether the HUD's spider-order chip is drawn
// this frame (spider-order-chip.ts). A module-level singleton like hint-strip-state's:
// UIScene sets it every frame, and isPointerOverHUD / tooltipTargetAt read it, so the
// chip's band masks world input (and tooltips) only while the chip is drawn. Kept
// apart from spider-order-chip.ts so the input layer imports only this flag.

export const spiderOrderChipState: { visible: boolean } = {
  visible: false,
};

/** Reset to hidden. Used by tests so the shared singleton does not leak between cases. */
export function resetSpiderOrderChipState(): void {
  spiderOrderChipState.visible = false;
}
