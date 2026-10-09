// opponent-config.test.ts — the opponent-policy value object shared by the boot
// path, the save envelope and the playtrace envelope.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPPONENT,
  defaultScreenOpponent,
  formatOpponentStatusLabel,
  isOpponentConfig,
  jevOpponent,
  matchDifficulty,
  type OpponentConfig,
} from './opponent-config.js';
import { DEFAULT_ORDERS_TEXT, JEV_ORDERS_MAX_LENGTH, ordersTextForPreset } from './jev-orders.js';

describe('DEFAULT_OPPONENT', () => {
  it('is the rule-based AI — the opponent every pre-feature save implies', () => {
    expect(DEFAULT_OPPONENT).toEqual({ kind: 'rules' });
  });
});

describe('jevOpponent', () => {
  it('normalizes the orders text it is given', () => {
    const cfg = jevOpponent('  turtle   up \n now ');
    expect(cfg).toEqual({ kind: 'jev', orders: 'turtle up now' });
  });

  it('caps hostile input at the orders length limit', () => {
    const cfg = jevOpponent('z'.repeat(5000));
    expect(cfg.kind === 'jev' && cfg.orders.length).toBe(JEV_ORDERS_MAX_LENGTH);
  });
});

describe('isOpponentConfig', () => {
  it('accepts both legal shapes', () => {
    expect(isOpponentConfig({ kind: 'rules' })).toBe(true);
    expect(isOpponentConfig({ kind: 'jev', orders: '' })).toBe(true);
    expect(isOpponentConfig(jevOpponent('press the entrance'))).toBe(true);
  });

  it('rejects anything else', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'rules',
      42,
      [],
      {},
      { kind: 'random' },
      { kind: 'jev' }, // orders missing
      { kind: 'jev', orders: 7 },
    ];
    for (const value of bad) expect(isOpponentConfig(value)).toBe(false);
  });

  it('narrows the type for a validated value', () => {
    const raw: unknown = { kind: 'jev', orders: 'hold the line' };
    if (!isOpponentConfig(raw)) throw new Error('expected a valid config');
    const cfg: OpponentConfig = raw;
    expect(cfg.kind === 'jev' && cfg.orders).toBe('hold the line');
  });
});

describe('formatOpponentStatusLabel', () => {
  const base = {
    kind: 'jev',
    beats: 12,
    failedBeats: 0,
    lastLatencyMs: 130,
    probe: 'ok',
  } as const;

  it('renders nothing for the rule-based AI (no HUD chrome by default)', () => {
    expect(
      formatOpponentStatusLabel({
        kind: 'rules',
        status: 'rules',
        beats: 0,
        failedBeats: 0,
        lastLatencyMs: null,
        probe: null,
      }),
    ).toBeNull();
  });

  it('renders beat count + last latency while Jev is driving', () => {
    expect(formatOpponentStatusLabel({ ...base, status: 'jev' })).toBe(
      'Opponent: Jev · beat 12 · 130 ms',
    );
  });

  it('omits the latency until the first beat completes (probe already failed, no opening/connecting text)', () => {
    expect(
      formatOpponentStatusLabel({
        ...base,
        status: 'jev',
        beats: 0,
        lastLatencyMs: null,
        probe: 'failed',
      }),
    ).toBe('Opponent: Jev · beat 0');
  });

  it('rounds a fractional latency to whole milliseconds', () => {
    expect(formatOpponentStatusLabel({ ...base, status: 'jev', lastLatencyMs: 129.6 })).toBe(
      'Opponent: Jev · beat 12 · 130 ms',
    );
  });

  it('reports the mid-round handover once Jev has given up', () => {
    expect(formatOpponentStatusLabel({ ...base, status: 'fallback', failedBeats: 3 })).toBe(
      'Opponent: Jev → Standard AI (fallback)',
    );
  });

  it('shows "opening" + latency before the first beat once the probe has succeeded', () => {
    expect(formatOpponentStatusLabel({ ...base, status: 'jev', beats: 0, probe: 'ok' })).toBe(
      'Opponent: Jev · opening · 130 ms',
    );
  });

  it('shows "connecting…" before the first beat while the probe is pending', () => {
    expect(
      formatOpponentStatusLabel({
        ...base,
        status: 'jev',
        beats: 0,
        probe: 'pending',
        lastLatencyMs: null,
      }),
    ).toBe('Opponent: Jev · connecting…');
  });

  it('shows "connecting…" before the first beat when no probe has been sent yet', () => {
    expect(
      formatOpponentStatusLabel({
        ...base,
        status: 'jev',
        beats: 0,
        probe: null,
        lastLatencyMs: null,
      }),
    ).toBe('Opponent: Jev · connecting…');
  });

  it('falls back to the plain "beat 0" form when the probe has failed', () => {
    expect(
      formatOpponentStatusLabel({
        ...base,
        status: 'jev',
        beats: 0,
        probe: 'failed',
        lastLatencyMs: null,
      }),
    ).toBe('Opponent: Jev · beat 0');
  });

  it('ignores probe state once real beats have started', () => {
    expect(formatOpponentStatusLabel({ ...base, status: 'jev', beats: 3, probe: 'failed' })).toBe(
      'Opponent: Jev · beat 3 · 130 ms',
    );
  });
});

// Rob, 2026-10-09: the beta defaults to Jev + Balanced; a Jev match is Normal.
describe('defaultScreenOpponent', () => {
  it('is Jev with the Balanced preset on a build with a Jev endpoint', () => {
    expect(defaultScreenOpponent(true)).toEqual({ kind: 'jev', orders: DEFAULT_ORDERS_TEXT });
    expect(DEFAULT_ORDERS_TEXT).toBe(ordersTextForPreset('balanced'));
  });

  it('is the Standard AI on a build without one', () => {
    expect(defaultScreenOpponent(false)).toEqual(DEFAULT_OPPONENT);
  });
});

describe('matchDifficulty', () => {
  it('a Jev match is Normal whatever tier was asked for', () => {
    for (const d of ['Easy', 'Normal', 'Hard'] as const) {
      expect(matchDifficulty(d, jevOpponent('Hold.'))).toBe('Normal');
      expect(matchDifficulty(d, jevOpponent(''))).toBe('Normal');
    }
  });

  it('the Standard AI plays the tier asked for', () => {
    for (const d of ['Easy', 'Normal', 'Hard'] as const) {
      expect(matchDifficulty(d, DEFAULT_OPPONENT)).toBe(d);
    }
  });
});
