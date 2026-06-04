// summary-builder.test.ts — S6 coverage for buildOutcomeAttribution().
//
// Tests the tiebreak paths added in S6, the updated queen_death narrative
// strings, the null-cause fallback, and the no-events base case.

import { describe, it, expect } from 'vitest';
import { buildOutcomeAttribution } from './summary-builder.js';
import type { SimEvent } from '../sim/telemetry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundEndEvent(
  reason: 'TimeoutTiebreak' | 'StalemateTiebreak',
  playerWorkerCount: number,
  aiWorkerCount: number,
): SimEvent {
  return { tick: 1200, type: 'round_end', payload: { reason, playerWorkerCount, aiWorkerCount } };
}

function queenDeathEvent(
  cause: 'InvasionKill' | 'SpiderRampage' | 'Starvation' | 'MutualDestruction' | null,
): SimEvent {
  return {
    tick: 500,
    type: 'queen_death',
    payload: { cause, location: { x: 0, y: 0, grid: 'underground' }, aiStateAtTime: null },
  };
}

// ---------------------------------------------------------------------------
// TimeoutTiebreak
// ---------------------------------------------------------------------------

describe('buildOutcomeAttribution — TimeoutTiebreak', () => {
  it('player has more workers → outlasted narrative', () => {
    const result = buildOutcomeAttribution([roundEndEvent('TimeoutTiebreak', 10, 5)]);
    expect(result.primaryCause).toBe('TimeoutTiebreak');
    expect(result.narrativeSeed).toBe('The round timed out; your colony outlasted the enemy.');
  });

  it('AI has more workers → enemy outlasted narrative', () => {
    const result = buildOutcomeAttribution([roundEndEvent('TimeoutTiebreak', 3, 8)]);
    expect(result.primaryCause).toBe('TimeoutTiebreak');
    expect(result.narrativeSeed).toBe('The round timed out; the enemy colony outlasted yours.');
  });

  it('equal worker counts → evenly matched narrative', () => {
    const result = buildOutcomeAttribution([roundEndEvent('TimeoutTiebreak', 5, 5)]);
    expect(result.primaryCause).toBe('TimeoutTiebreak');
    expect(result.narrativeSeed).toBe('Both colonies were evenly matched when time ran out.');
  });
});

// ---------------------------------------------------------------------------
// StalemateTiebreak
// ---------------------------------------------------------------------------

describe('buildOutcomeAttribution — StalemateTiebreak', () => {
  it('Victory gameOutcome → enemy starved first narrative', () => {
    const result = buildOutcomeAttribution([roundEndEvent('StalemateTiebreak', 0, 0)], 'Victory');
    expect(result.primaryCause).toBe('StalemateTiebreak');
    expect(result.narrativeSeed).toBe('Both colonies ran out of food; the enemy starved first.');
  });

  it('Defeat gameOutcome → player queen starved narrative', () => {
    const result = buildOutcomeAttribution([roundEndEvent('StalemateTiebreak', 0, 0)], 'Defeat');
    expect(result.primaryCause).toBe('StalemateTiebreak');
    expect(result.narrativeSeed).toBe('Both colonies ran out of food; your queen starved first.');
  });

  it('no gameOutcome provided → draw narrative', () => {
    const result = buildOutcomeAttribution([roundEndEvent('StalemateTiebreak', 0, 0)]);
    expect(result.primaryCause).toBe('StalemateTiebreak');
    expect(result.narrativeSeed).toBe(
      'Both colonies ran out of food and the round ended in a draw.',
    );
  });

  it('MutualDestruction gameOutcome → draw narrative (not Victory/Defeat)', () => {
    const result = buildOutcomeAttribution(
      [roundEndEvent('StalemateTiebreak', 0, 0)],
      'MutualDestruction',
    );
    expect(result.primaryCause).toBe('StalemateTiebreak');
    expect(result.narrativeSeed).toBe(
      'Both colonies ran out of food and the round ended in a draw.',
    );
  });
});

// ---------------------------------------------------------------------------
// round_end takes priority over queen_death when both are present
// ---------------------------------------------------------------------------

describe('buildOutcomeAttribution — round_end before queen_death', () => {
  it('round_end is returned even when a queen_death event also exists', () => {
    const events: SimEvent[] = [
      roundEndEvent('TimeoutTiebreak', 7, 2),
      {
        tick: 501,
        type: 'queen_death',
        payload: {
          cause: 'Starvation',
          location: { x: 0, y: 0, grid: 'underground' },
          aiStateAtTime: null,
        },
      },
    ];
    const result = buildOutcomeAttribution(events);
    expect(result.primaryCause).toBe('TimeoutTiebreak');
  });
});

// ---------------------------------------------------------------------------
// queen_death narrative strings (updated in S6)
// ---------------------------------------------------------------------------

describe('buildOutcomeAttribution — queen_death narratives (Defeat perspective)', () => {
  it('InvasionKill → player-loss invasion narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('InvasionKill')], 'Defeat');
    expect(result.primaryCause).toBe('InvasionKill');
    expect(result.narrativeSeed).toBe(
      'Enemy fighters broke through a tunnel entrance and reached your queen.',
    );
  });

  it('SpiderRampage → player-loss spider narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('SpiderRampage')], 'Defeat');
    expect(result.primaryCause).toBe('SpiderRampage');
    expect(result.narrativeSeed).toBe('The spider reached your nursery and killed the queen.');
  });

  it('Starvation → player-loss starvation narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('Starvation')], 'Defeat');
    expect(result.primaryCause).toBe('Starvation');
    expect(result.narrativeSeed).toBe('Your queen starved after the colony ran out of food.');
  });

  it('MutualDestruction → symmetric narrative (same for both outcomes)', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('MutualDestruction')], 'Defeat');
    expect(result.primaryCause).toBe('MutualDestruction');
    expect(result.narrativeSeed).toBe('Both queens died in the same final fight.');
  });
});

describe('buildOutcomeAttribution — queen_death narratives (Victory perspective)', () => {
  it('InvasionKill Victory → enemy-queen narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('InvasionKill')], 'Victory');
    expect(result.primaryCause).toBe('InvasionKill');
    expect(result.narrativeSeed).toBe('Your fighters broke through to the enemy queen.');
  });

  it('SpiderRampage Victory → enemy spider narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('SpiderRampage')], 'Victory');
    expect(result.primaryCause).toBe('SpiderRampage');
    expect(result.narrativeSeed).toBe(
      'The spider reached the enemy nursery and killed their queen.',
    );
  });

  it('Starvation Victory → enemy starvation narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('Starvation')], 'Victory');
    expect(result.primaryCause).toBe('Starvation');
    expect(result.narrativeSeed).toBe(
      'The enemy queen starved after their colony ran out of food.',
    );
  });

  it('MutualDestruction Victory → same symmetric narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent('MutualDestruction')], 'Victory');
    expect(result.primaryCause).toBe('MutualDestruction');
    expect(result.narrativeSeed).toBe('Both queens died in the same final fight.');
  });

  it('cause === null with no gameOutcome → defeat fallback narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent(null)]);
    expect(result.primaryCause).toBeNull();
    expect(result.narrativeSeed).toBe('Your colony has fallen.');
  });

  it('cause === null with Victory gameOutcome → enemy-fell narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent(null)], 'Victory');
    expect(result.primaryCause).toBeNull();
    expect(result.narrativeSeed).toBe('The enemy colony has fallen.');
  });

  it('cause === null with MutualDestruction gameOutcome → both-fell narrative', () => {
    const result = buildOutcomeAttribution([queenDeathEvent(null)], 'MutualDestruction');
    expect(result.primaryCause).toBeNull();
    expect(result.narrativeSeed).toBe('Both queens fell in the final battle.');
  });
});

// ---------------------------------------------------------------------------
// No events
// ---------------------------------------------------------------------------

describe('buildOutcomeAttribution — no events', () => {
  it('returns {primaryCause: null, narrativeSeed: null} when events array is empty', () => {
    const result = buildOutcomeAttribution([]);
    expect(result.primaryCause).toBeNull();
    expect(result.narrativeSeed).toBeNull();
  });

  it('returns {null, null} when events contain no relevant types', () => {
    const events: SimEvent[] = [
      {
        tick: 10,
        type: 'combat_kill',
        payload: {
          killer: { kind: 'Ant', id: 1, colonyId: 2 as never },
          victim: { kind: 'Ant', id: 2, colonyId: 1 as never },
          location: { x: 5, y: 5, grid: 'surface' },
        },
      },
    ];
    const result = buildOutcomeAttribution(events);
    expect(result.primaryCause).toBeNull();
    expect(result.narrativeSeed).toBeNull();
  });
});
