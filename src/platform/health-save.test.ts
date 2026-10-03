// health-save.test.ts — #400 (V71): the health model across a save/load.
//
// V71 serializes two new clocks — `ants.lastHitTick` and `spider.lastHitTick` — and
// derives everything else (max HP by territory, fed, the heal ticks) from saved state
// and world.tick. So a world saved mid-drain or inside a creature's safe window must
// load and continue hash-for-hash with the world that was never saved, through the
// healing that follows. (Moved from queen-starvation-v65-parity.test.ts's V66 arm when
// #400 retired that file's pinned-V65 golden.) Lives in platform/ for the save
// serializer and hashWorldState.
import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import {
  ANT_HEAL_INTERVAL_TICKS,
  ENEMY_COLONY_ID,
  HEAL_SAFE_TICKS,
  PLAYER_COLONY_ID,
  QUEEN_HEAL_INTERVAL_TICKS,
  QUEEN_HP_HOME,
  QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS,
  SPIDER_HEAL_INTERVAL_TICKS,
} from '../sim/constants.js';
import { Zone } from '../sim/terrain.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';
import { stageQueenInNest } from '../sim/health-test-utils.js';
import { runAIController } from '../render/ai-controller.js';
import { hashWorldState } from './world-hash.js';
import { deserializeWorldState, serializeWorldState } from './save.js';

const D = QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS;

/** One tick with the enemy AI; `famine` lists the colonies whose food is zeroed first. */
function step(world: WorldState, famine: readonly number[]): void {
  for (const cid of famine) setColonyFoodForTest(world, world.colonies[cid]!, 0);
  runAIController(world, ENEMY_COLONY_ID);
  tick(world, world.commandQueue.splice(0));
}

function saveLoad(world: WorldState): WorldState {
  return deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
}

describe('#400 (V71) — a world saved mid-drain continues byte-identically', () => {
  it('saved mid-famine, fed (she heals in her nest), then starved: same hashes and death tick', () => {
    const famine = [PLAYER_COLONY_ID];
    const world = createScenario(7, 'Normal');
    const pq = stageQueenInNest(world, world.colonies[PLAYER_COLONY_ID]!);
    world.ants.hp[pq] = 20;
    const drains = 15;
    for (let t = 0; t < drains * D + 5; t++) step(world, famine);
    expect(world.ants.hp[pq]).toBe(20 - drains);
    const loaded = saveLoad(world);
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
    // Fed: she ate this tick, nobody has hit her, she is in her nest — both heal alike.
    const feed = (w: WorldState): void => {
      setColonyFoodForTest(w, w.colonies[PLAYER_COLONY_ID]!, 1 << 12);
      runAIController(w, ENEMY_COLONY_ID);
      tick(w, w.commandQueue.splice(0));
    };
    const fedTicks = 10 * QUEEN_HEAL_INTERVAL_TICKS;
    for (let t = 0; t < fedTicks; t++) {
      feed(world);
      feed(loaded);
      if (t % 5 === 0) expect(hashWorldState(loaded), `fed ${t}`).toBe(hashWorldState(world));
    }
    const healedHp = world.ants.hp[pq];
    expect(healedHp).toBe(20 - drains + 10); // one per heal tick
    expect(loaded.ants.hp[pq]).toBe(healedHp);
    const lastMeal = world.ants.lastMealTick[pq]!;
    let deathA = -1;
    let deathB = -1;
    for (let t = 0; t < 400 && (deathA < 0 || deathB < 0); t++) {
      const now = world.tick;
      step(world, famine);
      step(loaded, famine);
      if (t % 5 === 0) expect(hashWorldState(loaded), `famine ${t}`).toBe(hashWorldState(world));
      if (deathA < 0 && world.ants.alive[pq] === 0) deathA = now;
      if (deathB < 0 && loaded.ants.alive[pq] === 0) deathB = now;
    }
    expect(deathA).toBe(lastMeal + healedHp * D);
    expect(deathB).toBe(deathA);
    expect(healedHp).toBeLessThan(QUEEN_HP_HOME);
  }, 60_000);
});

describe('#400 (V71) — the last-hit clocks survive a save/load inside the safe window', () => {
  it('a wounded worker at home and a wounded spider, saved mid-window, heal on the same ticks', () => {
    const world = createScenario(7, 'Normal');
    world.aiState = [];
    for (let t = 0; t < 30; t++) step(world, []); // a past to have been hit in
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    // A worker below in its own nest (home ground), wounded, hit 10 ticks ago.
    const worker = colony.workers[0]!;
    stageQueenInNest(world, colony); // opens the shaft and a chamber below the door
    world.ants.zone[worker] = Zone.Underground;
    world.ants.posX[worker] = world.ants.posX[colony.queenEntityId]!;
    world.ants.posY[worker] = world.ants.posY[colony.queenEntityId]!;
    world.ants.speed[worker] = 0;
    world.ants.hp[worker] = 8;
    world.ants.lastHitTick[worker] = world.tick - 10;
    // The spider wounded, fed, hit 10 ticks ago, parked out of everyone's way.
    world.spider!.hp = 40;
    world.spider!.hungerTicks = 0;
    world.spider!.lastHitTick = world.tick - 10;
    for (let t = 0; t < 20; t++) step(world, []);
    const loaded = saveLoad(world);
    expect(loaded.ants.lastHitTick[worker]).toBe(world.ants.lastHitTick[worker]);
    expect(loaded.spider!.lastHitTick).toBe(world.spider!.lastHitTick);
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
    const window =
      HEAL_SAFE_TICKS + 2 * Math.max(ANT_HEAL_INTERVAL_TICKS, SPIDER_HEAL_INTERVAL_TICKS);
    for (let t = 0; t < window; t++) {
      for (const w of [world, loaded]) {
        w.ants.lastMealTick[worker] = w.tick; // keep it fed
        step(w, []);
      }
      if (t % 10 === 0)
        expect(hashWorldState(loaded), `tick ${world.tick}`).toBe(hashWorldState(world));
    }
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
    // Non-vacuous: both healed once safe.
    expect(world.ants.hp[worker]).toBeGreaterThan(8);
    expect(world.spider!.hp).toBeGreaterThan(40);
  }, 60_000);
});
