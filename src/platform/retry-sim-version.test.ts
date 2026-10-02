// #395 (Codex P2 on #402) — Retry plays the newest rules.
//
// From V69 map generation is version-gated (food-fairness.ts moves piles), so the
// same seed generates a different map at V69 than at V68. Rob's call (2026-10-01):
// Retry runs under LATEST, the newest rules, as a new game does
// (game-scene-logic.ts createRetryWorld). A game resumed from a V68 save and lost
// therefore retries on its seed's V69 map. The terrain and colonies are the V68
// map's; only the food piles fairness moves or adds (and the world rng) differ.
// That difference is accepted and pinned here.
//
// createRetryWorld takes only the seed and difficulty, so the lost game's own
// version does not reach it; the test builds the retry world directly.
import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import {
  LATEST_SIM_VERSION,
  SIM_VERSION_V68_RAMPAGE_SHELTER,
  type WorldState,
} from '../sim/types.js';
import { createRetryWorld } from '../render/game-scene-logic.js';
import { serializeWorldState } from './save.js';

const V68 = SIM_VERSION_V68_RAMPAGE_SHELTER;
type Difficulty = 'Easy' | 'Normal' | 'Hard';

/** Seeds whose V69 map differs from their V68 map. */
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
    'seed %i %s: Retry (of a V68 game or any other) is the LATEST new game of its seed',
    (seed, difficulty) => {
      const retry = createRetryWorld(seed, difficulty);
      expect(retry.simVersion).toBe(LATEST_SIM_VERSION);
      expect(retry.difficulty).toBe(difficulty);
      expect(fields(retry)).toEqual(fields(createScenario(seed, difficulty)));

      // The accepted difference from the V68 map: the food fairness moved (and the
      // rng it drew). Everything else (terrain, colonies, spider) is the same.
      // A tripwire: a later world-generation change fails this list. Then update
      // ARCHITECTURE.md's "same terrain" sentence and createRetryWorld's doc too.
      const got = fields(retry);
      const v68 = fields(createScenario(seed, difficulty, V68));
      const differing = Object.keys(v68).filter((k) => got[k] !== v68[k]);
      expect(differing.sort()).toEqual(['food', 'rngState', 'simVersion']);
    },
  );
});
