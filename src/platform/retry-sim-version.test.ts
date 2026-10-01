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
// createScenario(seed, d, 68) itself is pinned to main's V68 bytes (88b53fe) by
// food-fairness-v68-parity.test.ts, so equal bytes here mean the V68 map of main.
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

const V68 = SIM_VERSION_V68_RAMPAGE_SHELTER;
type Difficulty = 'Easy' | 'Normal' | 'Hard';

/** Seeds whose V69 map differs from their V68 map. */
const CASES: ReadonlyArray<readonly [number, Difficulty]> = [
  [20, 'Normal'],
  [12, 'Hard'],
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
  const saved = play(createScenario(seed, difficulty, V68), 100);
  const resumed = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(saved))));
  expect(resumed.simVersion).toBe(V68);
  return play(resumed, 100);
}

describe('#395 — Retry rebuilds the lost map at the lost world’s simVersion', () => {
  it.each(CASES)(
    'seed %i %s: Retry on a game resumed from a V68 save is the V68 map, byte for byte',
    (seed, difficulty) => {
      // The case discriminates: the LATEST map of this seed, re-stamped to V68 (the
      // bug: create at LATEST, keep the version), is not the V68 world.
      const restamped = createScenario(seed, difficulty);
      restamped.simVersion = V68;
      expect(bytes(restamped)).not.toBe(bytes(createScenario(seed, difficulty, V68)));

      const lost = lostResumedGame(seed, difficulty);
      const retry = createRetryWorld(captureRetryTarget(lost, seed));

      expect(retry.simVersion).toBe(V68);
      expect(retry.difficulty).toBe(difficulty);
      expect(retry.tick).toBe(0);
      expect(bytes(retry)).toBe(bytes(createScenario(seed, difficulty, V68)));
    },
    60_000,
  );

  it('Retry on a current game is the LATEST map of its seed, as a new game generates it', () => {
    const lost = play(createScenario(20, 'Easy'), 100);
    const target = captureRetryTarget(lost, 20);
    expect(target).toEqual({ seed: 20, difficulty: 'Easy', simVersion: LATEST_SIM_VERSION });
    expect(bytes(createRetryWorld(target))).toBe(bytes(createScenario(20, 'Easy')));
  }, 60_000);

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
    // The target is captured from the world this survey is about.
    expect(src).toMatch(
      /const retryTarget = captureRetryTarget\(this\.world, this\.currentSeed\);/,
    );
    expect(src).toMatch(/onRetry: \(\) => \{\s*this\.retryGame\(retryTarget\);/);
  });
});
