// first-use-hints.test.ts — Stage 3b (#3): gating, mark-shown persistence,
// reset, and the proactive [Tab] first-world-input nudge.

import { describe, it, expect, beforeEach } from 'vitest';
import { SETTINGS_KEY, loadSettings } from '../platform/settings.js';
import {
  firstUseHintText,
  isFirstUseHintShown,
  markFirstUseHintShown,
  resetFirstUseHints,
  resetFirstUseSession,
  resetFirstUseHintCacheForTests,
  triggerReactiveHint,
  tabNudgeGateOpen,
  notifyFirstWorldInput,
  type HintFirstUseId,
  type FirstUseHintSink,
} from './first-use-hints.js';

// A spy sink that records what the triggers asked to display.
function makeSink(): FirstUseHintSink & { shown: Array<{ id: HintFirstUseId; text: string }> } {
  const shown: Array<{ id: HintFirstUseId; text: string }> = [];
  return {
    shown,
    showFirstUseHint(id, text) {
      shown.push({ id, text });
    },
  };
}

beforeEach(() => {
  localStorage.removeItem(SETTINGS_KEY);
  resetFirstUseHintCacheForTests();
});

describe('firstUseHintText', () => {
  it('composes copy from the glyph table', () => {
    expect(firstUseHintText('pan')).toBe('Drag to look around');
    expect(firstUseHintText('zoom')).toBe('Scroll to zoom');
    expect(firstUseHintText('paint')).toBe('Drag to paint tunnels');
    expect(firstUseHintText('view-tab')).toBe('Press [Tab] to view underground');
  });
});

describe('persistence: mark-shown + reset', () => {
  it('a freshly-loaded hint is not shown', () => {
    expect(isFirstUseHintShown('pan')).toBe(false);
  });

  it('markFirstUseHintShown persists to settings and survives a cache reload', () => {
    markFirstUseHintShown('pan');
    expect(isFirstUseHintShown('pan')).toBe(true);
    // Persisted, not just in-memory:
    expect(loadSettings().firstUseHints).toEqual({ pan: true });
    // A fresh page load (cache cleared) re-reads the flag from settings.
    resetFirstUseHintCacheForTests();
    expect(isFirstUseHintShown('pan')).toBe(true);
  });

  it('resetFirstUseHints clears every flag in memory and persistence', () => {
    markFirstUseHintShown('pan');
    markFirstUseHintShown('view-tab');
    resetFirstUseHints();
    expect(isFirstUseHintShown('pan')).toBe(false);
    expect(isFirstUseHintShown('view-tab')).toBe(false);
    expect(loadSettings().firstUseHints).toEqual({});
  });
});

describe('triggerReactiveHint (show-once)', () => {
  it('shows the hint the first time, then never again until reset', () => {
    const sink = makeSink();
    triggerReactiveHint(sink, 'pan');
    expect(sink.shown).toEqual([{ id: 'pan', text: 'Drag to look around' }]);

    // It is the SINK (UIScene) that marks on display; simulate that here so the
    // second trigger is correctly suppressed.
    markFirstUseHintShown('pan');
    triggerReactiveHint(sink, 'pan');
    expect(sink.shown).toHaveLength(1);

    // After reset it surfaces again.
    resetFirstUseHints();
    triggerReactiveHint(sink, 'pan');
    expect(sink.shown).toHaveLength(2);
  });
});

describe('tabNudgeGateOpen (effect gate)', () => {
  it('opens only on surface, underground unvisited, with an entrance', () => {
    expect(tabNudgeGateOpen('surface', false, 1)).toBe(true);
    expect(tabNudgeGateOpen('underground', false, 1)).toBe(false);
    expect(tabNudgeGateOpen('surface', true, 1)).toBe(false);
    expect(tabNudgeGateOpen('surface', false, 0)).toBe(false);
  });
});

describe('notifyFirstWorldInput (proactive [Tab] nudge)', () => {
  it('fires the nudge on the first world input when the gate is open', () => {
    const sink = makeSink();
    resetFirstUseSession();
    notifyFirstWorldInput(sink, {
      activeView: 'surface',
      undergroundVisited: false,
      entranceCount: 2,
    });
    expect(sink.shown).toEqual([{ id: 'view-tab', text: 'Press [Tab] to view underground' }]);
  });

  it('fires at most once per session (only the FIRST input)', () => {
    const sink = makeSink();
    resetFirstUseSession();
    notifyFirstWorldInput(sink, {
      activeView: 'surface',
      undergroundVisited: false,
      entranceCount: 2,
    });
    notifyFirstWorldInput(sink, {
      activeView: 'surface',
      undergroundVisited: false,
      entranceCount: 2,
    });
    expect(sink.shown).toHaveLength(1);
  });

  it('self-suppresses when the first input was Tab (undergroundVisited already set)', () => {
    const sink = makeSink();
    resetFirstUseSession();
    // Post-input state after a Tab first-input: underground has been visited.
    notifyFirstWorldInput(sink, {
      activeView: 'underground',
      undergroundVisited: true,
      entranceCount: 2,
    });
    expect(sink.shown).toHaveLength(0);
    // And the latch is consumed — a later surface input does not revive it.
    notifyFirstWorldInput(sink, {
      activeView: 'surface',
      undergroundVisited: false,
      entranceCount: 2,
    });
    expect(sink.shown).toHaveLength(0);
  });

  it('does not fire if the [Tab] hint was already shown in a prior session', () => {
    const sink = makeSink();
    markFirstUseHintShown('view-tab');
    resetFirstUseSession();
    notifyFirstWorldInput(sink, {
      activeView: 'surface',
      undergroundVisited: false,
      entranceCount: 2,
    });
    expect(sink.shown).toHaveLength(0);
  });
});
