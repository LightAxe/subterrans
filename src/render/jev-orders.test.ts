// jev-orders.test.ts — standing-orders presets + normalization.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORDERS_TEXT,
  JEV_ORDERS_MAX_LENGTH,
  JEV_ORDERS_PRESETS,
  normalizeOrders,
  ordersTextForPreset,
} from './jev-orders.js';

describe('JEV_ORDERS_PRESETS', () => {
  it('offers exactly balanced / aggressive / turtle / economy, in that order', () => {
    expect(JEV_ORDERS_PRESETS.map((p) => p.id)).toEqual([
      'balanced',
      'aggressive',
      'turtle',
      'economy',
    ]);
  });

  it('every preset — including balanced — has a non-empty label and text within the cap', () => {
    for (const preset of JEV_ORDERS_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.text.length).toBeGreaterThan(0);
      expect(preset.text.length).toBeLessThanOrEqual(JEV_ORDERS_MAX_LENGTH);
      // Presets must survive normalization unchanged, or the text the player
      // sees in the picker would differ from the text Jev receives.
      expect(normalizeOrders(preset.text)).toBe(preset.text);
    }
  });

  it('an empty standing-orders string is a separate state, not a preset', () => {
    // "No standing orders at all" is reached by clearing the text box; it does
    // not belong to `balanced` or to any other preset (jev-orders.ts header).
    for (const preset of JEV_ORDERS_PRESETS) expect(preset.text).not.toBe('');
  });
});

describe('normalizeOrders', () => {
  it('trims and collapses every whitespace run, including newlines and tabs', () => {
    expect(normalizeOrders('  attack \n\n  early \t\t now  ')).toBe('attack early now');
  });

  it('caps at JEV_ORDERS_MAX_LENGTH characters', () => {
    const out = normalizeOrders('x'.repeat(JEV_ORDERS_MAX_LENGTH + 500));
    expect(out.length).toBe(JEV_ORDERS_MAX_LENGTH);
  });

  it('collapses BEFORE capping, so whitespace cannot eat the budget', () => {
    const padded = `${'a '.repeat(400)}`; // 800 chars, 400 of them spaces
    expect(normalizeOrders(padded).length).toBe(JEV_ORDERS_MAX_LENGTH);
  });

  it('maps a whitespace-only string to the empty string (no standing orders)', () => {
    expect(normalizeOrders('   \n\t ')).toBe('');
  });
});

describe('ordersTextForPreset', () => {
  it('returns the preset text for a known id', () => {
    expect(ordersTextForPreset('aggressive')).toContain('assault their entrance');
  });

  it("returns balanced's own tuned (non-empty) text for 'balanced'", () => {
    const text = ordersTextForPreset('balanced');
    expect(text).not.toBe('');
    expect(text).toBe(JEV_ORDERS_PRESETS.find((p) => p.id === 'balanced')!.text);
  });

  it('returns empty for an unknown id (a defensive fallback, not a preset)', () => {
    expect(ordersTextForPreset('not-a-preset')).toBe('');
  });
});

describe('DEFAULT_ORDERS_TEXT', () => {
  it("equals balanced's tuned text and is non-empty", () => {
    expect(DEFAULT_ORDERS_TEXT).toBe(ordersTextForPreset('balanced'));
    expect(DEFAULT_ORDERS_TEXT.length).toBeGreaterThan(0);
  });
});
