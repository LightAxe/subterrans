// hotkey-policy.ts — Stage 1 controls rework (issue #18): one predicate that
// gates every world-affecting hotkey.
//
// Codex R1-11, R4-2, R4-4. Before this, the world hotkeys had divergent gates:
//   - the 1/2/4 speed keys checked only `gamePhase === Playing`;
//   - Tab polled JustDown every frame regardless of phase (game-scene.ts:1312-),
//     so a Tab press behind the Esc pause menu still flipped the view;
//   - X/P checked Playing only.
// A single predicate, `canAcceptWorldHotkey()`, now gates 1/2/3 (tools), the
// speed keys (= / - / numpad), Space (user pause), AND Tab (view toggle). X/P
// are gated the same way at the call site; Esc is UIScene-owned (it is what
// OPENS/closes the modals, so it must work while a modal is up); F9 is
// intentionally global (debug export must work whenever a world exists).
//
// A hotkey is accepted iff ALL hold:
//   - gamePhase === 'playing'                  (not Paused / GameOver / SavePrompt)
//   - no modal overlay is open                 (pause menu / Save-Load dialog /
//                                                survey / game-over / save-prompt)
//   - the chamber context menu is NOT visible || pendingShow || pendingHide
//     (the deferred-show race: requestShowContextMenu sets pendingShow=true with
//     visible=false until the next frame, so a tool hotkey fired in that gap
//     would switch tools beneath a menu about to appear — Codex R4-2)
//   - the ant-activity inspector panel is NOT visible, UNLESS it is dismissing
//     this frame (pendingHide). The panel uses a deferred hide: a click on a
//     tool/speed button while the panel is up calls requestHideAntActivityPanel()
//     — which sets pendingHide=true but leaves visible=true for the rest of THIS
//     dispatch (so the dismissal click can't fall through to world input). The
//     SAME click then routes to selectTool/onSpeedControl. If we blocked on bare
//     `visible`, that first click would be eaten and the user would have to click
//     twice. Treating `visible && pendingHide` as the panel-is-going-away state
//     lets the action through in one click. (This is the dual of the context
//     menu: there pendingHide blocks because the dismissal is a menu-item SELECT
//     that must not also fire a tool change; here the click IS the tool action.)
//
// Pure: takes a plain snapshot of the relevant flags and returns a boolean. No
// Phaser, no singleton reads inside — the caller passes today's values so the
// predicate is trivially unit-testable across the whole matrix.

/** Phase values relevant to hotkey gating (mirror of GameScene's GamePhase). */
export type HotkeyGamePhase = 'playing' | 'paused' | 'gameover' | 'saveprompt';

/** Everything canAcceptWorldHotkey needs, captured as plain values. */
export interface HotkeyPolicyDeps {
  /** Current GameScene phase. Only 'playing' accepts world hotkeys. */
  gamePhase: HotkeyGamePhase;
  /** True if any modal overlay (pause menu, Save-Load, survey, game-over, save-prompt) is open. */
  modalOpen: boolean;
  /** contextMenuState.visible. */
  contextMenuVisible: boolean;
  /** contextMenuState.pendingShow — the deferred-show race window (Codex R4-2). */
  contextMenuPendingShow: boolean;
  /** contextMenuState.pendingHide — symmetric deferred-hide window. */
  contextMenuPendingHide: boolean;
  /** antActivityPanelState.visible — the inspector panel eats clicks while up. */
  antActivityPanelVisible: boolean;
  /**
   * antActivityPanelState.pendingHide — the deferred-hide window. When true the
   * panel is being dismissed THIS dispatch (the same click that triggers a tool
   * /speed action), so it must NOT block: see the module header.
   */
  antActivityPanelPendingHide: boolean;
}

/**
 * canAcceptWorldHotkey — the single gate for 1/2/3, =/-, Space, and Tab.
 * Returns true only when the world is interactive and no modal/menu/panel is
 * (about to be) up.
 */
export function canAcceptWorldHotkey(deps: HotkeyPolicyDeps): boolean {
  if (deps.gamePhase !== 'playing') return false;
  if (deps.modalOpen) return false;
  if (deps.contextMenuVisible || deps.contextMenuPendingShow || deps.contextMenuPendingHide) {
    return false;
  }
  // Block while the panel is up, EXCEPT when it is dismissing this frame
  // (pendingHide) — then the same click should both close the panel and perform
  // the tool/speed action. See the module header for the context-menu contrast.
  if (deps.antActivityPanelVisible && !deps.antActivityPanelPendingHide) return false;
  return true;
}
