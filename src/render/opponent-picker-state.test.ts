// opponent-picker-state.test.ts — W3. The difficulty-select overlay's opponent
// section is a Phaser scene (untestable headlessly), so ALL of its decision logic
// lives in the pure module exercised here: which toggle is lit, which preset is
// highlighted, what the free text is, and what OpponentConfig a start commits to.

import { describe, it, expect } from 'vitest';
import {
  createOpponentPickerState,
  editText,
  formatOrdersCounter,
  isPresetSelected,
  selectPreset,
  toConfig,
  toggleKind,
  type OpponentPickerState,
} from './opponent-picker-state.js';
import { DEFAULT_OPPONENT, jevOpponent } from './opponent-config.js';
import { JEV_ORDERS_MAX_LENGTH, JEV_ORDERS_PRESETS, ordersTextForPreset } from './jev-orders.js';

/** A picker on a build where the Jev proxy endpoint IS configured. */
function available(saved = DEFAULT_OPPONENT): OpponentPickerState {
  return createOpponentPickerState({ saved, jevAvailable: true });
}

const AGGRESSIVE = ordersTextForPreset('aggressive');

describe('createOpponentPickerState', () => {
  it('defaults to the rule-based AI with no orders', () => {
    const s = available();
    expect(s.kind).toBe('rules');
    expect(s.text).toBe('');
    expect(s.jevAvailable).toBe(true);
  });

  it('restores a persisted jev preference, orders and all', () => {
    const s = available(jevOpponent(AGGRESSIVE));
    expect(s.kind).toBe('jev');
    expect(s.text).toBe(AGGRESSIVE);
    expect(s.presetId).toBe('aggressive');
  });

  it('re-highlights `balanced` for an empty orders string (the empty preset)', () => {
    const s = available(jevOpponent(''));
    expect(s.presetId).toBe('balanced');
  });

  it('marks freehand orders as custom (no preset highlighted)', () => {
    const s = available(jevOpponent('rush the queen at once'));
    expect(s.presetId).toBeNull();
    expect(s.text).toBe('rush the queen at once');
  });

  it('downgrades a jev preference to rules on a build without the endpoint', () => {
    const s = createOpponentPickerState({
      saved: jevOpponent(AGGRESSIVE),
      jevAvailable: false,
    });
    expect(s.kind).toBe('rules');
    // ...but remembers the orders, so the choice survives a build that has it.
    expect(s.text).toBe(AGGRESSIVE);
  });

  it('caps over-long persisted orders (hand-edited localStorage)', () => {
    // settings.ts validates the SHAPE only; the cap is the render layer's job.
    const tampered = { kind: 'jev', orders: 'z'.repeat(5000) } as const;
    const s = createOpponentPickerState({ saved: tampered, jevAvailable: true });
    expect(s.text).toHaveLength(JEV_ORDERS_MAX_LENGTH);
    expect(toConfig(s)).toEqual({ kind: 'jev', orders: 'z'.repeat(JEV_ORDERS_MAX_LENGTH) });
  });
});

describe('toggleKind', () => {
  it('switches to jev and back', () => {
    const rules = available();
    const jev = toggleKind(rules, 'jev');
    expect(jev.kind).toBe('jev');
    expect(toggleKind(jev, 'rules').kind).toBe('rules');
  });

  it('returns the SAME state object when nothing changes (no pointless redraw)', () => {
    const s = available();
    expect(toggleKind(s, 'rules')).toBe(s);
  });

  it('refuses jev when the build has no proxy endpoint', () => {
    const s = createOpponentPickerState({ saved: DEFAULT_OPPONENT, jevAvailable: false });
    expect(toggleKind(s, 'jev').kind).toBe('rules');
  });

  it('preserves the orders text and preset across a rules round-trip', () => {
    const s = selectPreset(toggleKind(available(), 'jev'), 'turtle');
    const back = toggleKind(toggleKind(s, 'rules'), 'jev');
    expect(back.text).toBe(s.text);
    expect(back.presetId).toBe('turtle');
  });

  it('does not mutate its input', () => {
    const s = available();
    toggleKind(s, 'jev');
    expect(s.kind).toBe('rules');
  });
});

describe('selectPreset', () => {
  it('overwrites the free text with the preset text and highlights it', () => {
    const s = selectPreset(toggleKind(available(), 'jev'), 'economy');
    expect(s.presetId).toBe('economy');
    expect(s.text).toBe(ordersTextForPreset('economy'));
    expect(isPresetSelected(s, 'economy')).toBe(true);
    expect(isPresetSelected(s, 'turtle')).toBe(false);
  });

  it('overwrites custom text the player had typed', () => {
    const custom = editText(toggleKind(available(), 'jev'), 'my own plan');
    const preset = selectPreset(custom, 'aggressive');
    expect(preset.text).toBe(AGGRESSIVE);
  });

  it('selects `balanced` as the empty-orders preset', () => {
    const s = selectPreset(toggleKind(available(), 'jev'), 'balanced');
    expect(s.text).toBe('');
    expect(toConfig(s)).toEqual({ kind: 'jev', orders: '' });
  });

  it('handles every shipped preset', () => {
    for (const preset of JEV_ORDERS_PRESETS) {
      const s = selectPreset(toggleKind(available(), 'jev'), preset.id);
      expect(s.presetId).toBe(preset.id);
      expect(s.text).toBe(ordersTextForPreset(preset.id));
    }
  });
});

describe('editText', () => {
  it('un-highlights every preset — the orders are now custom', () => {
    const preset = selectPreset(toggleKind(available(), 'jev'), 'turtle');
    const edited = editText(preset, `${preset.text} and dig deep`);
    expect(edited.presetId).toBeNull();
    for (const p of JEV_ORDERS_PRESETS) expect(isPresetSelected(edited, p.id)).toBe(false);
  });

  it('keeps whitespace as typed so a trailing space is possible', () => {
    const s = editText(toggleKind(available(), 'jev'), 'hold the  line ');
    expect(s.text).toBe('hold the  line ');
  });

  it('caps at JEV_ORDERS_MAX_LENGTH', () => {
    const s = editText(toggleKind(available(), 'jev'), 'x'.repeat(JEV_ORDERS_MAX_LENGTH + 250));
    expect(s.text).toHaveLength(JEV_ORDERS_MAX_LENGTH);
  });

  it('accepts an empty edit (clearing the field)', () => {
    const s = editText(selectPreset(toggleKind(available(), 'jev'), 'economy'), '');
    expect(s.text).toBe('');
    expect(s.presetId).toBeNull();
  });
});

describe('toConfig', () => {
  it('yields the rule-based default for the Standard AI toggle', () => {
    expect(toConfig(available())).toEqual(DEFAULT_OPPONENT);
  });

  it('normalizes the free text on commit (trim + collapse + cap)', () => {
    const s = editText(toggleKind(available(), 'jev'), '  press   the\n entrance  ');
    expect(toConfig(s)).toEqual({ kind: 'jev', orders: 'press the entrance' });
  });

  it('never commits jev on a build without the proxy endpoint', () => {
    // Defense in depth: toggleKind already refuses, so hand-build the state.
    const forced: OpponentPickerState = {
      kind: 'jev',
      presetId: null,
      text: 'attack',
      jevAvailable: false,
    };
    expect(toConfig(forced)).toEqual(DEFAULT_OPPONENT);
  });

  it('round-trips through createOpponentPickerState', () => {
    const committed = toConfig(selectPreset(toggleKind(available(), 'jev'), 'aggressive'));
    const reopened = createOpponentPickerState({ saved: committed, jevAvailable: true });
    expect(reopened.kind).toBe('jev');
    expect(reopened.presetId).toBe('aggressive');
    expect(toConfig(reopened)).toEqual(committed);
  });
});

describe('formatOrdersCounter', () => {
  it('counts the raw characters typed against the cap', () => {
    expect(formatOrdersCounter(available())).toBe(`0/${JEV_ORDERS_MAX_LENGTH}`);
    const s = editText(toggleKind(available(), 'jev'), 'abcde');
    expect(formatOrdersCounter(s)).toBe(`5/${JEV_ORDERS_MAX_LENGTH}`);
  });

  it('tops out at the cap rather than reporting the over-long paste', () => {
    const s = editText(toggleKind(available(), 'jev'), 'y'.repeat(9999));
    expect(formatOrdersCounter(s)).toBe(`${JEV_ORDERS_MAX_LENGTH}/${JEV_ORDERS_MAX_LENGTH}`);
  });
});
