// #395 (Codex P2 on #402) — Retry rebuilds the map the player lost on, at the lost
// world's simVersion.
//
// From V69 map generation is version-gated (food-fairness.ts moves piles), so the
// same seed generates a different map at V69 than at V68. Retry promises "the exact
// same map" (#131): a game resumed from a V68 save and lost must retry on the V68
// map, not on the V69 map of its seed. Retry captures the lost world's seed,
// difficulty and simVersion (game-scene-logic.ts captureRetryTarget) and rebuilds
// from them (createRetryWorld). A new game is still created at LATEST.
//
// The V68 hashes are food-fairness-v68-parity.test.ts's GOLDEN_WORLDS, captured on
// main at 88b53fe (V68 = LATEST there).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import {
  LATEST_SIM_VERSION,
  SIM_VERSION_V68_RAMPAGE_SHELTER,
  type WorldState,
} from '../sim/types.js';
import { runAIController } from '../render/ai-controller.js';
import { captureRetryTarget, createRetryWorld } from '../render/game-scene-logic.js';
import { deserializeWorldState, serializeWorldState } from './save.js';
import { hashWorldState } from './world-hash.js';

const V68 = SIM_VERSION_V68_RAMPAGE_SHELTER;
type Difficulty = 'Easy' | 'Normal' | 'Hard';

/** Seeds whose V69 map differs from their V68 map, with their V68 hash on 88b53fe. */
const CASES: ReadonlyArray<readonly [number, Difficulty, string]> = [
  [20, 'Normal', '68ce340f'],
  [12, 'Hard', '6a7c5a2e'],
];

/** The full serialized world: equal strings mean byte-identical worlds. */
function bytes(world: WorldState): string {
  return JSON.stringify(serializeWorldState(world));
}

function play(world: WorldState, ticks: number): WorldState {
  for (let i = 0; i < ticks; i++) {
    runAIController(world, ENEMY_COLONY_ID);
    runAIController(world, PLAYER_COLONY_ID);
    tick(world, world.commandQueue.splice(0));
  }
  return world;
}

/** A V68 game played a while, saved, resumed from the save, then played on (and lost). */
function lostResumedGame(seed: number, difficulty: Difficulty): WorldState {
  const saved = play(createScenario(seed, difficulty, V68), 200);
  const resumed = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(saved))));
  expect(resumed.simVersion).toBe(V68);
  return play(resumed, 200);
}

describe('#395 — Retry rebuilds the lost map at the lost world’s simVersion', () => {
  it.each(CASES)(
    'seed %i %s: Retry on a game resumed from a V68 save is the V68 map, byte for byte',
    (seed, difficulty, v68Hash) => {
      // The case discriminates: at LATEST this seed generates a different map.
      expect(hashWorldState(createScenario(seed, difficulty))).not.toBe(v68Hash);

      const lost = lostResumedGame(seed, difficulty);
      const retry = createRetryWorld(captureRetryTarget(lost, seed));

      expect(retry.simVersion).toBe(V68);
      expect(retry.difficulty).toBe(difficulty);
      expect(retry.tick).toBe(0);
      expect(hashWorldState(retry)).toBe(v68Hash);
      expect(bytes(retry)).toBe(bytes(createScenario(seed, difficulty, V68)));
    },
  );

  it('Retry on a current game is the LATEST map of its seed, as a new game generates it', () => {
    const lost = play(createScenario(20, 'Easy'), 200);
    const target = captureRetryTarget(lost, 20);
    expect(target).toEqual({ seed: 20, difficulty: 'Easy', simVersion: LATEST_SIM_VERSION });
    expect(bytes(createRetryWorld(target))).toBe(bytes(createScenario(20, 'Easy')));
  });

  it('GameScene wires Retry through the captured target (source scan)', () => {
    // GameScene is Phaser-bound and has no unit harness; this pins the wiring the
    // tests above rely on. Comments are stripped so prose may name createScenario.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../render/game-scene.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const start = src.indexOf('private retryGame(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n  }\n', start);
    const retryGame = src.slice(start, end);
    expect(retryGame).toMatch(/private retryGame\(target: RetryTarget\)/);
    expect(retryGame).toMatch(/this\.world = createRetryWorld\(target\);/);
    expect(retryGame).not.toMatch(/createScenario\(/);
    // The target is captured from the world the player is leaving, before any reset.
    expect(src).toMatch(
      /const retryTarget = captureRetryTarget\(this\.world, this\.currentSeed\);/,
    );
    expect(src).toMatch(/onRetry: \(\) => \{\s*this\.retryGame\(retryTarget\);/);
  });
});
