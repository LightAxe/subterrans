// opponent-config.test.ts — the opponent-policy value object shared by the boot
// path, the save envelope and the playtrace envelope.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPPONENT,
  formatOpponentStatusLabel,
  isOpponentConfig,
  jevOpponent,
  type OpponentConfig,
} from './opponent-config.js';
import { JEV_ORDERS_MAX_LENGTH } from './jev-orders.js';

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
  const base = { kind: 'jev', beats: 12, failedBeats: 0, lastLatencyMs: 130 } as const;

  it('renders nothing for the rule-based AI (no HUD chrome by default)', () => {
    expect(
      formatOpponentStatusLabel({
        kind: 'rules',
        status: 'rules',
        beats: 0,
        failedBeats: 0,
        lastLatencyMs: null,
      }),
    ).toBeNull();
  });

  it('renders beat count + last latency while Jev is driving', () => {
    expect(formatOpponentStatusLabel({ ...base, status: 'jev' })).toBe(
      'Opponent: Jev · beat 12 · 130 ms',
    );
  });

  it('omits the latency until the first beat completes', () => {
    expect(
      formatOpponentStatusLabel({ ...base, status: 'jev', beats: 0, lastLatencyMs: null }),
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
});
