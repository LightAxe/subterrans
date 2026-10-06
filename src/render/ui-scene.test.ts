// ui-scene.test.ts — unit tests for pure-logic helpers extracted from UIScene.
//
// Scope: pure functions only (no Phaser scene booting).
// Overlay rendering and interaction (Phaser-coupled) is covered by Plan 07 Playwright.
//
// Helpers under test (exported from ui-scene-logic.ts):
//   - formatOutcomeTitle(outcome, reason): { text: string; color: number } (#389 — DRAW)
//   - formatKillStatsSubtitle(killCount): string
//   - formatCauseSubtitle(outcome, cause, reason): string (#389 — keyed on reason)
//   - queenDeathCauseAt(events, deathTick): QueenDeathCause (#388)
//   - roundEndReasonAt(world, deathTick, outcome): RoundEndReason | null (#389)

import { describe, it, expect } from 'vitest';
import {
  formatOutcomeTitle,
  formatKillStatsSubtitle,
  formatCauseSubtitle,
  queenDeathCauseAt,
  roundEndReasonAt,
} from './ui-scene-logic.js';
import { GameOutcome } from '../sim/game-over.js';
import type { SimEvent } from '../sim/telemetry.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';

// ---------------------------------------------------------------------------
// formatOutcomeTitle
// ---------------------------------------------------------------------------

describe('formatOutcomeTitle', () => {
  it('Victory returns green text', () => {
    const result = formatOutcomeTitle(GameOutcome.Victory, 'QueenDeath');
    expect(result.text).toBe('VICTORY');
    expect(result.color).toBe(0x00ff00);
  });

  it('Defeat returns red text', () => {
    const result = formatOutcomeTitle(GameOutcome.Defeat, 'QueenDeath');
    expect(result.text).toBe('DEFEAT');
    expect(result.color).toBe(0xff0000);
  });

  it('MutualDestruction by a double queen death returns orange/yellow MUTUAL DESTRUCTION', () => {
    const result = formatOutcomeTitle(GameOutcome.MutualDestruction, 'QueenDeath');
    expect(result.text).toBe('MUTUAL DESTRUCTION');
    expect(result.color).toBe(0xffaa00);
  });

  it('#389 — a stalemate draw (both queens alive) reads DRAW, same color', () => {
    const result = formatOutcomeTitle(GameOutcome.MutualDestruction, 'StalemateTiebreak');
    expect(result.text).toBe('DRAW');
    expect(result.color).toBe(0xffaa00);
  });

  it('#389 — a timeout draw (a TimeoutTiebreak round_end, both queens alive) reads DRAW', () => {
    const result = formatOutcomeTitle(GameOutcome.MutualDestruction, 'TimeoutTiebreak');
    expect(result.text).toBe('DRAW');
    expect(result.color).toBe(0xffaa00);
  });

  it('#389 — a draw with an unknown reason reads DRAW, not a double queen death', () => {
    expect(formatOutcomeTitle(GameOutcome.MutualDestruction, null).text).toBe('DRAW');
  });

  it('a timeout win or loss keeps VICTORY / DEFEAT', () => {
    expect(formatOutcomeTitle(GameOutcome.Victory, 'TimeoutTiebreak').text).toBe('VICTORY');
    expect(formatOutcomeTitle(GameOutcome.Defeat, 'TimeoutTiebreak').text).toBe('DEFEAT');
  });

  it('None returns empty text graceful fallback', () => {
    const result = formatOutcomeTitle(GameOutcome.None, null);
    expect(result.text).toBe('');
    expect(result.color).toBe(0x000000);
  });
});

// ---------------------------------------------------------------------------
// formatKillStatsSubtitle
// ---------------------------------------------------------------------------

describe('formatKillStatsSubtitle', () => {
  it('killCount=0 returns "Your colony killed 0 enemies"', () => {
    expect(formatKillStatsSubtitle(0)).toBe('Your colony killed 0 enemies');
  });

  it('killCount=1 returns singular "enemy"', () => {
    expect(formatKillStatsSubtitle(1)).toBe('Your colony killed 1 enemy');
  });

  it('killCount=2 returns plural "enemies"', () => {
    expect(formatKillStatsSubtitle(2)).toBe('Your colony killed 2 enemies');
  });

  it('killCount=100 returns plural "enemies"', () => {
    expect(formatKillStatsSubtitle(100)).toBe('Your colony killed 100 enemies');
  });
});

// ---------------------------------------------------------------------------
// formatCauseSubtitle
// ---------------------------------------------------------------------------

describe('formatCauseSubtitle — Victory', () => {
  it('InvasionKill: your fighters killed their queen', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, 'InvasionKill', 'QueenDeath')).toBe(
      'Your fighters killed their queen',
    );
  });

  it('Starvation: their queen starved', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, 'Starvation', 'QueenDeath')).toBe(
      'Their queen starved',
    );
  });

  it('SpiderRampage: their queen killed by spider', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, 'SpiderRampage', 'QueenDeath')).toBe(
      'Their queen was killed by a spider',
    );
  });

  it('null cause returns empty string', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, null, 'QueenDeath')).toBe('');
  });
});

describe('formatCauseSubtitle — Defeat', () => {
  it('InvasionKill: your queen killed by enemy', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, 'InvasionKill', 'QueenDeath')).toBe(
      'Your queen was killed by the enemy',
    );
  });

  it('Starvation: your queen starved', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, 'Starvation', 'QueenDeath')).toBe(
      'Your queen starved',
    );
  });

  it('SpiderRampage: your queen killed by spider', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, 'SpiderRampage', 'QueenDeath')).toBe(
      'Your queen was killed by a spider',
    );
  });

  it('null cause returns empty string', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, null, 'QueenDeath')).toBe('');
  });
});

describe('formatCauseSubtitle — MutualDestruction', () => {
  it('a double queen death: both-queens message, whatever its recorded cause', () => {
    expect(
      formatCauseSubtitle(GameOutcome.MutualDestruction, 'MutualDestruction', 'QueenDeath'),
    ).toBe('Both queens died at the same time');
    expect(formatCauseSubtitle(GameOutcome.MutualDestruction, null, 'QueenDeath')).toBe(
      'Both queens died at the same time',
    );
  });

  it('#389 — a stalemate draw (both queens alive): says the food ran out, not that they died', () => {
    expect(formatCauseSubtitle(GameOutcome.MutualDestruction, null, 'StalemateTiebreak')).toBe(
      'Both colonies ran out of food — a draw',
    );
  });

  it('#389 — a timeout draw (a TimeoutTiebreak round_end): says time ran out, not that they died', () => {
    expect(formatCauseSubtitle(GameOutcome.MutualDestruction, null, 'TimeoutTiebreak')).toBe(
      'Time ran out — the colonies were evenly matched',
    );
  });

  it('#389 — an unknown reason: no line rather than a guess', () => {
    expect(formatCauseSubtitle(GameOutcome.MutualDestruction, null, null)).toBe('');
  });
});

// The sim no longer emits a TimeoutTiebreak (#376 removed the match timeout at V67; #408
// reaped its gate). The copy stays with the wire enum's value, so these pin it.
describe('formatCauseSubtitle — TimeoutTiebreak won on worker count', () => {
  it('Victory: time ran out with more workers', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, null, 'TimeoutTiebreak')).toBe(
      'Time ran out — your colony had more workers',
    );
  });

  it('Defeat: time ran out with fewer workers', () => {
    expect(formatCauseSubtitle(GameOutcome.Defeat, null, 'TimeoutTiebreak')).toBe(
      'Time ran out — the enemy had more workers',
    );
  });
});

describe('formatCauseSubtitle — StalemateTiebreak with an outcome the sim never gives it', () => {
  it('Victory / Defeat: no line (a stalemate is always a draw)', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, null, 'StalemateTiebreak')).toBe('');
    expect(formatCauseSubtitle(GameOutcome.Defeat, null, 'StalemateTiebreak')).toBe('');
  });
});

describe('formatCauseSubtitle — None', () => {
  it('returns empty string', () => {
    expect(formatCauseSubtitle(GameOutcome.None, null, null)).toBe('');
    expect(formatCauseSubtitle(GameOutcome.None, null, 'TimeoutTiebreak')).toBe('');
  });
});

describe('formatCauseSubtitle — unknown reason (the forceGameOver seam, no terminal event)', () => {
  it('Victory / Defeat with no cause: no line', () => {
    expect(formatCauseSubtitle(GameOutcome.Victory, null, null)).toBe('');
    expect(formatCauseSubtitle(GameOutcome.Defeat, null, null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// queenDeathCauseAt (#388 — extracted from GameScene.enterGameOver)
// ---------------------------------------------------------------------------

describe('queenDeathCauseAt', () => {
  const death = (tick: number, cause: 'InvasionKill' | 'Starvation'): SimEvent => ({
    tick,
    type: 'queen_death',
    payload: { cause, location: { x: 0, y: 0, grid: 'underground' }, aiStateAtTime: null },
  });
  const hunt = (tick: number): SimEvent => ({
    tick,
    type: 'spider_hunt_start',
    payload: { reticleTile: { x: 0, y: 0, grid: 'surface' }, targetWorkers: 0 },
  });

  it('returns the cause of the first queen_death on the death tick', () => {
    const events = [hunt(9), death(10, 'Starvation'), death(10, 'InvasionKill')];
    expect(queenDeathCauseAt(events, 10)).toBe('Starvation');
  });

  it('ignores a queen_death from another tick', () => {
    expect(queenDeathCauseAt([death(9, 'InvasionKill')], 10)).toBeNull();
  });

  it('returns null with no queen_death', () => {
    expect(queenDeathCauseAt([hunt(10)], 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// roundEndReasonAt (#389 — how the match ended, for the cause line)
// ---------------------------------------------------------------------------

describe('roundEndReasonAt', () => {
  const DEATH_TICK = 500;
  const roundEnd = (tick: number, reason: 'TimeoutTiebreak' | 'StalemateTiebreak'): SimEvent => ({
    tick,
    type: 'round_end',
    payload: { reason, playerWorkerCount: 3, aiWorkerCount: 3 },
  });
  const queenDeath = (tick: number): SimEvent => ({
    tick,
    type: 'queen_death',
    payload: {
      cause: 'MutualDestruction',
      location: { x: 0, y: 0, grid: 'underground' },
      aiStateAtTime: null,
    },
  });

  /** A fresh world: both queens alive, no events. */
  function freshWorld(): WorldState {
    const world = createScenario(7, 'Normal');
    world.events.length = 0;
    return world;
  }
  function killQueen(world: WorldState, colonyId: number): void {
    world.ants.alive[world.colonies[colonyId]!.queenEntityId] = 0;
  }

  it('a round_end on the death tick names its tiebreak', () => {
    const world = freshWorld();
    world.events.push(roundEnd(DEATH_TICK, 'StalemateTiebreak'));
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.MutualDestruction)).toBe(
      'StalemateTiebreak',
    );
    // A TimeoutTiebreak round_end (the sim no longer emits one) is read the same way.
    const timeout = freshWorld();
    timeout.events.push(roundEnd(DEATH_TICK, 'TimeoutTiebreak'));
    expect(roundEndReasonAt(timeout, DEATH_TICK, GameOutcome.Victory)).toBe('TimeoutTiebreak');
  });

  it('a round_end on the death tick wins over a queen_death on it (as the playtrace)', () => {
    const world = freshWorld();
    world.events.push(queenDeath(DEATH_TICK), roundEnd(DEATH_TICK, 'StalemateTiebreak'));
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.MutualDestruction)).toBe(
      'StalemateTiebreak',
    );
  });

  it('a queen_death on the death tick is a queen death', () => {
    const world = freshWorld();
    killQueen(world, PLAYER_COLONY_ID);
    killQueen(world, ENEMY_COLONY_ID);
    world.events.push(queenDeath(DEATH_TICK), queenDeath(DEATH_TICK));
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.MutualDestruction)).toBe('QueenDeath');
  });

  it('ignores terminal events from another tick', () => {
    const world = freshWorld();
    world.events.push(queenDeath(DEATH_TICK - 1), roundEnd(DEATH_TICK + 1, 'TimeoutTiebreak'));
    // Both queens alive: the world says a stalemate, not the stale events.
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.MutualDestruction)).toBe(
      'StalemateTiebreak',
    );
  });

  it('#389 — no terminal event, both queens alive, a draw: the stalemate', () => {
    const world = freshWorld();
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.MutualDestruction)).toBe(
      'StalemateTiebreak',
    );
  });

  it('no terminal event and a dead queen: a queen death', () => {
    const one = freshWorld();
    killQueen(one, PLAYER_COLONY_ID);
    expect(roundEndReasonAt(one, DEATH_TICK, GameOutcome.Defeat)).toBe('QueenDeath');
    const enemy = freshWorld();
    killQueen(enemy, ENEMY_COLONY_ID);
    expect(roundEndReasonAt(enemy, DEATH_TICK, GameOutcome.Victory)).toBe('QueenDeath');
    const both = freshWorld();
    killQueen(both, PLAYER_COLONY_ID);
    killQueen(both, ENEMY_COLONY_ID);
    expect(roundEndReasonAt(both, DEATH_TICK, GameOutcome.MutualDestruction)).toBe('QueenDeath');
  });

  it('no match timeout (#376): at and past the old 24 000-tick cap a draw is the stalemate, a win or loss unknown', () => {
    const OLD_MATCH_CAP_TICKS = 24_000;
    const world = freshWorld();
    for (const t of [OLD_MATCH_CAP_TICKS, OLD_MATCH_CAP_TICKS + 10]) {
      expect(roundEndReasonAt(world, t, GameOutcome.MutualDestruction)).toBe('StalemateTiebreak');
      expect(roundEndReasonAt(world, t, GameOutcome.Victory)).toBeNull();
      expect(roundEndReasonAt(world, t, GameOutcome.Defeat)).toBeNull();
    }
  });

  it('no terminal event, both queens alive, and a win or loss no tiebreak gives: unknown', () => {
    // The forceGameOver dev seam's Defeat.
    const world = freshWorld();
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.Defeat)).toBeNull();
    expect(roundEndReasonAt(world, DEATH_TICK, GameOutcome.Victory)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The end screen's cause line, as GameScene builds it (#389)
// ---------------------------------------------------------------------------

describe('end-screen cause line when the narrative is missing (#389)', () => {
  /** formatCauseSubtitle fed as GameScene.enterGameOver feeds it. */
  function causeLine(world: WorldState, deathTick: number, outcome: GameOutcome): string {
    return formatCauseSubtitle(
      outcome,
      queenDeathCauseAt(world.events, deathTick),
      roundEndReasonAt(world, deathTick, outcome),
    );
  }

  it('a stalemate whose round_end was lost: a draw for want of food, not a double queen death', () => {
    const world = createScenario(7, 'Normal');
    world.events.length = 0; // the round_end is gone — the issue's case
    const line = causeLine(world, 900, GameOutcome.MutualDestruction);
    expect(line).toBe('Both colonies ran out of food — a draw');
    expect(line).not.toMatch(/queens died/);
  });

  it('a double queen death whose events were lost: still a double queen death', () => {
    const world = createScenario(7, 'Normal');
    world.events.length = 0;
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      world.ants.alive[world.colonies[cid]!.queenEntityId] = 0;
    }
    expect(causeLine(world, 900, GameOutcome.MutualDestruction)).toBe(
      'Both queens died at the same time',
    );
  });

  it('a single queen death whose event was lost: no cause line (the cause is unknown)', () => {
    const world = createScenario(7, 'Normal');
    world.events.length = 0;
    world.ants.alive[world.colonies[PLAYER_COLONY_ID]!.queenEntityId] = 0;
    expect(causeLine(world, 900, GameOutcome.Defeat)).toBe('');
  });
});
