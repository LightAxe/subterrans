// context-menu-state.test.ts — Vitest tests for the shared context-menu
// singleton and deferred-hide helpers.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  contextMenuState,
  hideContextMenu,
  requestHideContextMenu,
  applyPendingContextMenuHide,
  requestShowContextMenu,
  applyPendingContextMenuShow,
} from './context-menu-state.js';

beforeEach(() => {
  contextMenuState.visible = false;
  contextMenuState.pendingHide = false;
  contextMenuState.pendingShow = false;
  contextMenuState.screenX = 0;
  contextMenuState.screenY = 0;
  contextMenuState.anchorTileX = 0;
  contextMenuState.anchorTileY = 0;
});

describe('hideContextMenu (immediate)', () => {
  it('sets visible=false synchronously and clears pendingHide and pendingShow', () => {
    contextMenuState.visible = true;
    contextMenuState.pendingHide = true;
    contextMenuState.pendingShow = true;
    hideContextMenu();
    expect(contextMenuState.visible).toBe(false);
    expect(contextMenuState.pendingHide).toBe(false);
    expect(contextMenuState.pendingShow).toBe(false);
  });
});

describe('requestShowContextMenu (deferred)', () => {
  it('stores anchor coords immediately but leaves visible=false until applyPendingContextMenuShow runs', () => {
    requestShowContextMenu(120, 80, 10, 6);
    // Anchor is set so the next frame knows where to render.
    expect(contextMenuState.screenX).toBe(120);
    expect(contextMenuState.screenY).toBe(80);
    expect(contextMenuState.anchorTileX).toBe(10);
    expect(contextMenuState.anchorTileY).toBe(6);
    // visible stays false this frame so any cross-scene pointerdown handler
    // running in the same dispatch does NOT see visible=true.
    expect(contextMenuState.visible).toBe(false);
    expect(contextMenuState.pendingShow).toBe(true);
  });

  it('applyPendingContextMenuShow flips visible to true and clears pendingShow', () => {
    requestShowContextMenu(120, 80, 10, 6);
    applyPendingContextMenuShow();
    expect(contextMenuState.visible).toBe(true);
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('applyPendingContextMenuShow is a no-op when no show is pending', () => {
    expect(contextMenuState.visible).toBe(false);
    applyPendingContextMenuShow();
    expect(contextMenuState.visible).toBe(false);
  });

  it('prevents cross-scene race: second pointerdown handler in the same dispatch sees visible=false', () => {
    // This is the exact bug the deferred-show pattern fixes. Scenario:
    //   1. User right-clicks tunnel end.
    //   2. Handler A (underground-input) calls requestShowContextMenu.
    //   3. Handler B (UIScene pointerdown) runs in the SAME dispatch.
    //      If visible flipped synchronously, B would see visible=true and
    //      interpret the same right-click as a menu item selection — the
    //      anchor is at the pointer, so the click lands on the first item.
    // With deferred show, B sees visible=false and falls through correctly.
    requestShowContextMenu(200, 150, 7, 3);
    const visibleInSameDispatch = contextMenuState.visible;
    expect(visibleInSameDispatch).toBe(false);

    // Only on the next frame does the renderer observe visible=true.
    applyPendingContextMenuShow();
    expect(contextMenuState.visible).toBe(true);
  });
});

describe('requestHideContextMenu (deferred)', () => {
  it('sets pendingHide but leaves visible=true until applyPendingContextMenuHide runs', () => {
    contextMenuState.visible = true;
    requestHideContextMenu();
    expect(contextMenuState.visible).toBe(true);
    expect(contextMenuState.pendingHide).toBe(true);
  });

  it('applyPendingContextMenuHide flips visible to false and clears pendingHide', () => {
    contextMenuState.visible = true;
    requestHideContextMenu();
    applyPendingContextMenuHide();
    expect(contextMenuState.visible).toBe(false);
    expect(contextMenuState.pendingHide).toBe(false);
  });

  it('applyPendingContextMenuHide is a no-op when no hide is pending', () => {
    contextMenuState.visible = true;
    applyPendingContextMenuHide();
    expect(contextMenuState.visible).toBe(true);
  });
});

describe('race-free semantics for pointerdown dispatch', () => {
  it('two consecutive handlers in the same frame both observe visible=true after requestHideContextMenu', () => {
    contextMenuState.visible = true;

    // Handler A (e.g., UIScene): processes menu selection and requests hide.
    const handlerAObservedVisible = contextMenuState.visible;
    requestHideContextMenu();

    // Handler B (e.g., underground-input) runs on the same pointerdown event,
    // still in the same JS event-loop turn. It must also see visible=true.
    const handlerBObservedVisible = contextMenuState.visible;

    expect(handlerAObservedVisible).toBe(true);
    expect(handlerBObservedVisible).toBe(true);

    // Only at the start of the NEXT frame does the hide apply.
    applyPendingContextMenuHide();
    expect(contextMenuState.visible).toBe(false);
  });
});
