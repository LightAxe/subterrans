// input-glyphs.test.ts — Stage 3b (#1). The anti-drift guard: assert the EXACT
// glyph string for every action (not mere coverage). If a binding changes in
// game-scene.ts, the matching assertion here must change too — that mismatch is
// the signal to keep the table in sync (Codex R1#13).

import { describe, it, expect } from 'vitest';
import { GLYPHS, glyphFor, type ActionId, type Device } from './input-glyphs.js';

describe('glyphFor — exact canonical glyphs', () => {
  // Every (action, device) that HAS a glyph, asserted exactly. Actions are
  // keyboard- or mouse-only by design; the absent device is asserted null below.
  const EXACT: Array<[ActionId, Device, string]> = [
    ['TOOL_COMMAND', 'keyboard', '[1]'],
    ['TOOL_DIG', 'keyboard', '[2]'],
    ['TOOL_CHAMBER', 'keyboard', '[3]'],
    ['SPEED_STEP_UP', 'keyboard', '[=]'],
    ['SPEED_STEP_DOWN', 'keyboard', '[-]'],
    ['SET_SPEED_1', 'mouse', '1×'],
    ['SET_SPEED_2', 'mouse', '2×'],
    ['SET_SPEED_4', 'mouse', '4×'],
    ['PAUSE_TOGGLE', 'keyboard', '[Space]'],
    ['VIEW_SWITCH', 'keyboard', '[Tab]'],
    ['COLONY_TOGGLE', 'keyboard', '[X]'],
    ['PHEROMONE_TOGGLE', 'keyboard', '[P]'],
    ['PAN', 'mouse', 'Drag'],
    ['ZOOM', 'mouse', 'Scroll'],
    ['DIG_MARK', 'mouse', 'Click'],
    ['DIG_PAINT', 'mouse', 'Drag'],
    ['CHAMBER_PLACE', 'mouse', 'Click'],
    ['CHAMBER_MENU', 'mouse', 'RMB'],
    ['ORDER_RALLY', 'mouse', 'Click'],
    ['ORDER_FOOD', 'mouse', 'Click'],
    ['ORDER_SPIDER', 'mouse', 'Click'],
    ['ENTRANCE_DESIGNATE', 'mouse', 'Click'],
  ];

  it.each(EXACT)('glyphFor(%s, %s) === "%s"', (action, device, expected) => {
    expect(glyphFor(action, device)).toBe(expected);
  });

  it('returns null on the device an action does not bind', () => {
    // Keyboard-only actions have no mouse glyph, and vice-versa.
    expect(glyphFor('VIEW_SWITCH', 'mouse')).toBeNull();
    expect(glyphFor('PAUSE_TOGGLE', 'mouse')).toBeNull();
    expect(glyphFor('PAN', 'keyboard')).toBeNull();
    expect(glyphFor('DIG_PAINT', 'keyboard')).toBeNull();
    expect(glyphFor('SET_SPEED_2', 'keyboard')).toBeNull();
  });

  it('defines exactly one device glyph for every action (one canonical glyph)', () => {
    const actions = Object.keys(GLYPHS) as ActionId[];
    // Every action in the union is present and has at least one glyph; none has
    // both devices (the "one canonical glyph per action" rule from the grill).
    for (const a of actions) {
      const devices = Object.values(GLYPHS[a]).filter((g) => g !== undefined);
      expect(devices.length, `${a} should have exactly one glyph`).toBe(1);
    }
    // Guard the table size so an accidental drop/add trips the test.
    expect(actions.length).toBe(22);
  });
});
