// #375 — pinned V65: queen starvation behaves exactly as before V66; and a V66
// drain survives save/load.
//
// #375 changes step 3 for the queen: from V66 a failed meal drains her HP and she
// starves at 0 HP. Below V66 it is gated off. The byte gate's scenarios rarely
// starve a queen, and never a wounded one, so this pins those paths at V65 through
// the whole tick (both colonies, the enemy AI running): famines with full-HP and
// wounded queens, a famine broken by food, and a queen starving to death. The
// fingerprint of the full serialized world every 25 ticks must equal the one the
// base tree produces (GOLDEN was captured by running this file on
// fix/373-alarm-invasion at 7ab0897, before #375).
//
// Save/load: the drain is keyed on the saved hunger clock and HP alone, so a V66
// world saved mid-drain and loaded continues byte-identically.
import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';
import { runAIController } from '../render/ai-controller.js';
import { fnv1a, hashWorldState } from './world-hash.js';
import { deserializeWorldState, serializeWorldState } from './save.js';

/** simVersion 65 (SIM_VERSION_V65_ALARM_INVASION). */
const V65 = 65;
/** Captured on fix/373-alarm-invasion at 7ab0897 (before #375) by running this file there. */
const GOLDEN: string = '363e4d63';

/** One tick with the enemy AI; `famine` lists the colonies whose food is zeroed first. */
function step(world: WorldState, famine: readonly number[]): void {
  for (const cid of famine) setColonyFoodForTest(world, world.colonies[cid]!, 0);
  runAIController(world, ENEMY_COLONY_ID);
  tick(world, world.commandQueue.splice(0));
}

interface Run {
  readonly trace: string[];
  readonly playerQueenDeath: number;
  readonly enemyQueenDeath: number;
}

function run(seed: number, setup: (w: WorldState) => void, famineAt: (t: number) => number[]): Run {
  const world = createScenario(seed, 'Normal');
  world.simVersion = V65;
  setup(world);
  const trace: string[] = [];
  let playerQueenDeath = -1;
  let enemyQueenDeath = -1;
  const pq = world.colonies[PLAYER_COLONY_ID]!.queenEntityId;
  const eq = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
  for (let t = 0; t < 700; t++) {
    step(world, famineAt(t));
    if (playerQueenDeath < 0 && world.ants.alive[pq] === 0) playerQueenDeath = t;
    if (enemyQueenDeath < 0 && world.ants.alive[eq] === 0) enemyQueenDeath = t;
    if (t % 25 === 24) trace.push(hashWorldState(world));
  }
  return { trace, playerQueenDeath, enemyQueenDeath };
}

describe('#375 — pinned V65: queen starvation is unchanged below V66', () => {
  it('famines with full-HP and wounded queens, broken and fatal, match the base tree', () => {
    // A: the player's full-HP queen starves outright (dies at tick 299).
    const a = run(
      7,
      () => {},
      () => [PLAYER_COLONY_ID],
    );
    // B: both queens wounded (player 5 HP, enemy 3 HP); a famine on both for
    // 150 ticks, food again for 100, then a fatal famine on both.
    const b = run(
      11,
      (w) => {
        w.ants.hp[w.colonies[PLAYER_COLONY_ID]!.queenEntityId] = 5;
        w.ants.hp[w.colonies[ENEMY_COLONY_ID]!.queenEntityId] = 3;
      },
      (t) => (t < 150 || t >= 250 ? [PLAYER_COLONY_ID, ENEMY_COLONY_ID] : []),
    );
    // Non-vacuity: at V65 HP never shortens starvation.
    expect(a.playerQueenDeath).toBe(299);
    expect(b.playerQueenDeath).toBeGreaterThanOrEqual(250 + 299);
    expect(b.enemyQueenDeath).toBeGreaterThanOrEqual(250 + 299);
    const fingerprint = fnv1a(
      [...a.trace, String(a.playerQueenDeath), ...b.trace, String(b.playerQueenDeath)].join('|'),
    );
    expect(fingerprint).toBe(GOLDEN);
  }, 60_000);
});

describe('#375 V66 — a world saved mid-drain continues byte-identically', () => {
  it('save/load at tick 155 of a famine: same hashes, same starvation tick', () => {
    const famine = [PLAYER_COLONY_ID];
    const world = createScenario(7, 'Normal');
    const pq = world.colonies[PLAYER_COLONY_ID]!.queenEntityId;
    world.ants.hp[pq] = 20;
    for (let t = 0; t < 155; t++) step(world, famine);
    expect(world.ants.hp[pq]).toBe(5); // 15 drains
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
    let deathA = -1;
    let deathB = -1;
    for (let t = 155; t < 260; t++) {
      step(world, famine);
      step(loaded, famine);
      if (t % 5 === 0) expect(hashWorldState(loaded), `tick ${t}`).toBe(hashWorldState(world));
      if (deathA < 0 && world.ants.alive[pq] === 0) deathA = t;
      if (deathB < 0 && loaded.ants.alive[pq] === 0) deathB = t;
    }
    expect(deathA).toBe(199); // 20 HP × 10 ticks, from lastMealTick −1
    expect(deathB).toBe(deathA);
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
  }, 60_000);
});
