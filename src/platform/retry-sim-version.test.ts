// #395 (Codex P2 on #402) — Retry plays the newest rules.
//
// Rob's call (2026-10-01): Retry runs under LATEST, the newest rules, as a new game
// does (game-scene-logic.ts createRetryWorld). While V69's food fairness was
// version-gated, a game resumed from a V68 save and lost retried on its seed's V69
// map: the food piles fairness moved and the world rng differed from the V68 map.
// #408 reaped that gate, and MIN === LATEST, so no world-generation step depends on
// the version today; a post-1.0 world-generation gate would bring the difference back.
//
// createRetryWorld takes only the seed and difficulty, so the lost game's own
// version does not reach it; the test builds the retry world directly.
import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { LATEST_SIM_VERSION, type WorldState } from '../sim/types.js';
import { createRetryWorld } from '../render/game-scene-logic.js';
import { serializeWorldState } from './save.js';

type Difficulty = 'Easy' | 'Normal' | 'Hard';

/** Seeds whose map V69's food fairness changed (the pass moves piles on them). */
const CASES: ReadonlyArray<readonly [number, Difficulty]> = [
  [20, 'Normal'],
  [12, 'Hard'],
];

/** Each serialized field of the world, as JSON. */
function fields(world: WorldState): Record<string, string> {
  const s = serializeWorldState(world) as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, JSON.stringify(v)]));
}

describe('#395 — Retry plays the newest rules', () => {
  it.each(CASES)(
    'seed %i %s: Retry (of any game) is the LATEST new game of its seed',
    (seed, difficulty) => {
      const retry = createRetryWorld(seed, difficulty);
      expect(retry.simVersion).toBe(LATEST_SIM_VERSION);
      expect(retry.difficulty).toBe(difficulty);
      expect(fields(retry)).toEqual(fields(createScenario(seed, difficulty)));
    },
  );
});
