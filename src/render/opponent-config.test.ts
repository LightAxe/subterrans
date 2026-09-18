// opponent-config.test.ts — the opponent-policy value object shared by the boot
// path, the save envelope and the playtrace envelope.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPPONENT,
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
