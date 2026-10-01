// #395 — pinned V68: map generation is unchanged below V69.
//
// V69 adds a pass to createScenario (food-fairness.ts ensureFoodNearEachColony) that
// may move a pile and draw from world.rngState. It is gated on the simVersion the
// world is created at, so createScenario(seed, difficulty, 68) must still generate
// exactly the V68 world, and a replay from seed at V68 must run exactly as before.
// GOLDEN_WORLDS and GOLDEN_RUNS were captured on main at 88b53fe (V68 = LATEST there)
// with createScenario(seed, difficulty), hashing the full serialized world.
import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { createDefaultAIStateRecord } from '../sim/ai-state.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { LATEST_SIM_VERSION, SIM_VERSION_V69_FOOD_FAIRNESS } from '../sim/types.js';
import { pilesForTest } from '../sim/food/food-test-utils.js';
import { runAIController } from '../render/ai-controller.js';
import { hashWorldState } from './world-hash.js';

/** simVersion 68 (SIM_VERSION_V68_RAMPAGE_SHELTER). */
const V68 = 68;
type Difficulty = 'Easy' | 'Normal' | 'Hard';

/** hashWorldState(createScenario(seed, difficulty)) on main at 88b53fe. */
const GOLDEN_WORLDS: ReadonlyArray<readonly [number, Difficulty, string]> = [
  [1, 'Easy', '03fcec1b'],
  [1, 'Normal', '3a9ac9b9'],
  [1, 'Hard', '630915ee'],
  [5, 'Easy', 'ba958623'],
  [5, 'Normal', '0fd671a1'],
  [5, 'Hard', '11314746'],
  [12, 'Easy', '22d172c7'],
  [12, 'Normal', '2c6d7659'],
  [12, 'Hard', '6a7c5a2e'],
  [20, 'Easy', '7792faad'],
  [20, 'Normal', '68ce340f'],
  [20, 'Hard', '31c805bc'],
  [24, 'Easy', '7e768d75'],
  [24, 'Normal', '9e073f61'],
  [24, 'Hard', '486a0620'],
  [27, 'Easy', 'cb75ae71'],
  [27, 'Normal', '482d9cbb'],
  [27, 'Hard', '29dd0f6c'],
  [101, 'Easy', 'f0bf9fbe'],
  [101, 'Normal', '1a93d970'],
  [101, 'Hard', 'd7c44c0f'],
  [333, 'Easy', '692231e9'],
  [333, 'Normal', 'e7b0a8af'],
  [333, 'Hard', '497a7658'],
];

/** Both colonies AI-driven for 600 ticks from the V68 world: the hash every 200 ticks, on 88b53fe. */
const GOLDEN_RUNS: ReadonlyArray<readonly [number, Difficulty, readonly string[]]> = [
  [1, 'Normal', ['32168843', '097730e9', '25ece414']],
  [12, 'Hard', ['fb097108', 'f4835868', 'e4267bee']],
  [24, 'Easy', ['49211e3b', 'cabb7a17', 'be14c238']],
];

describe('#395 — pinned V68: map generation is unchanged below V69', () => {
  it('createScenario at V68 generates the V68 world, byte for byte', () => {
    let changedAtLatest = 0;
    for (const [seed, difficulty, golden] of GOLDEN_WORLDS) {
      const world = createScenario(seed, difficulty, V68);
      expect(world.simVersion).toBe(V68);
      expect(hashWorldState(world), `seed ${seed} ${difficulty}`).toBe(golden);
      // Non-vacuity: on most of these seeds V69 moves a pile.
      const latest = createScenario(seed, difficulty);
      if (JSON.stringify(pilesForTest(latest)) !== JSON.stringify(pilesForTest(world))) {
        changedAtLatest++;
      }
    }
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V69_FOOD_FAIRNESS);
    expect(changedAtLatest).toBeGreaterThanOrEqual(12);
  });

  it('a replay from seed at V68 runs as before', () => {
    for (const [seed, difficulty, golden] of GOLDEN_RUNS) {
      const world = createScenario(seed, difficulty, V68);
      world.aiState.push(createDefaultAIStateRecord(PLAYER_COLONY_ID));
      const hashes: string[] = [];
      for (let t = 1; t <= 600; t++) {
        runAIController(world, ENEMY_COLONY_ID);
        runAIController(world, PLAYER_COLONY_ID);
        tick(world, world.commandQueue.splice(0));
        if (t % 200 === 0) hashes.push(hashWorldState(world));
      }
      expect(hashes, `seed ${seed} ${difficulty}`).toEqual(golden);
    }
  }, 60_000);
});
