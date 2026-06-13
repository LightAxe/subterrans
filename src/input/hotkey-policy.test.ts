// hotkey-policy.test.ts — Vitest unit tests for canAcceptWorldHotkey
// (Stage 1 controls rework, issue #18, Codex R1-11/R4-2/R4-4).

import { describe, it, expect } from 'vitest';
import { canAcceptWorldHotkey, type HotkeyPolicyDeps } from './hotkey-policy.js';

function deps(overrides: Partial<HotkeyPolicyDeps> = {}): HotkeyPolicyDeps {
  return {
    gamePhase: 'playing',
    modalOpen: false,
    contextMenuVisible: false,
    contextMenuPendingShow: false,
    contextMenuPendingHide: false,
    antActivityPanelVisible: false,
    antActivityPanelPendingHide: false,
    ...overrides,
  };
}

describe('canAcceptWorldHotkey', () => {
  it('accepts when Playing with no modal/menu/panel', () => {
    expect(canAcceptWorldHotkey(deps())).toBe(true);
  });

  it('rejects when phase is not playing', () => {
    expect(canAcceptWorldHotkey(deps({ gamePhase: 'paused' }))).toBe(false);
    expect(canAcceptWorldHotkey(deps({ gamePhase: 'gameover' }))).toBe(false);
    expect(canAcceptWorldHotkey(deps({ gamePhase: 'saveprompt' }))).toBe(false);
  });

  it('rejects when a modal is open', () => {
    expect(canAcceptWorldHotkey(deps({ modalOpen: true }))).toBe(false);
  });

  it('rejects when the context menu is visible OR pending-show OR pending-hide (Codex R4-2)', () => {
    expect(canAcceptWorldHotkey(deps({ contextMenuVisible: true }))).toBe(false);
    expect(canAcceptWorldHotkey(deps({ contextMenuPendingShow: true }))).toBe(false);
    expect(canAcceptWorldHotkey(deps({ contextMenuPendingHide: true }))).toBe(false);
  });

  it('rejects when the ant-activity panel is visible', () => {
    expect(canAcceptWorldHotkey(deps({ antActivityPanelVisible: true }))).toBe(false);
  });

  // Stage 1 controls rework advisory fix: a click on a tool/speed button while
  // the ant-activity panel is up sets pendingHide=true (deferred dismiss) but
  // leaves visible=true for THIS dispatch. The same click then routes through
  // this gate. It must be ACCEPTED so the action lands in one click — otherwise
  // the first click is eaten and the user has to click twice.
  it('accepts when the ant-activity panel is dismissing this frame (visible && pendingHide)', () => {
    expect(
      canAcceptWorldHotkey(
        deps({ antActivityPanelVisible: true, antActivityPanelPendingHide: true }),
      ),
    ).toBe(true);
  });

  // pendingHide is only a let-through while the panel is actually up. If a stale
  // pendingHide were set with visible=false, the gate is governed by the other
  // flags (here: still accepted, panel is not blocking).
  it('pendingHide alone (panel not visible) does not block', () => {
    expect(canAcceptWorldHotkey(deps({ antActivityPanelPendingHide: true }))).toBe(true);
  });

  // The pendingHide let-through is specific to the ant panel and must NOT relax
  // the other gates: a modal still blocks even mid-dismiss.
  it('a modal still blocks even when the panel is dismissing', () => {
    expect(
      canAcceptWorldHotkey(
        deps({ modalOpen: true, antActivityPanelVisible: true, antActivityPanelPendingHide: true }),
      ),
    ).toBe(false);
  });
});
