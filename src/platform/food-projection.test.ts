// food-projection.test.ts — #290 food-equivalence projection (smoke + contract).
import { describe, it, expect } from 'vitest';
import {
  PROJECTION_STRIPPED_ANT_KEYS,
  PROJECTION_STRIPPED_CHAMBER_KEYS,
  PROJECTION_STRIPPED_COLONY_KEYS,
  PROJECTION_STRIPPED_WORLD_KEYS,
  hashFoodProjection,
  hungerProjection,
  projectForEquivalence,
} from './food-projection.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { PLAYER_COLONY_ID, STARVATION_GRACE_TICKS } from '../sim/constants.js';
import {
  colonyFoodTotal,
  depositIntoPool,
  drainPile,
  pileAmountFp,
  pileCount,
  pileSlotAt,
  withdrawFood,
} from '../sim/food/food-api.js';
import {
  setColonyFoodForTest,
  setMealsUntilStarvationForTest,
} from '../sim/food/food-test-utils.js';
import { LARVA_HUNGER } from '../sim/hunger.js';
import { serializeWorldState } from './save.js';

interface Projection {
  snapshot: Record<string, unknown> & {
    ants: Record<string, unknown>;
    colonies: Record<
      string,
      Record<string, unknown> & { chambers: Array<Record<string, unknown>> }
    >;
  };
  food: {
    colonies: Record<string, { pool: number; total: number; capacity: number; stock: number[][] }>;
    piles: number[][];
  };
  hunger: number[][];
}

function parse(world: Parameters<typeof projectForEquivalence>[0]): Projection {
  return JSON.parse(projectForEquivalence(world)) as Projection;
}

describe('#290 food projection', () => {
  it('is deterministic across identical runs and does not mutate the world', () => {
    const a = createScenario(11);
    const b = createScenario(11);
    for (let t = 0; t < 300; t++) {
      tick(a, []);
      tick(b, []);
    }
    const before = pileCount(a);
    const snapBefore = JSON.stringify(serializeWorldState(a));
    expect(projectForEquivalence(a)).toBe(projectForEquivalence(b));
    expect(hashFoodProjection(a)).toBe(hashFoodProjection(b));
    expect(pileCount(a)).toBe(before);
    expect(JSON.stringify(serializeWorldState(a))).toBe(snapBefore);
  });

  it('strips every storage-shaped key and re-reads food through the facade', () => {
    const world = createScenario(12);
    const p = parse(world);
    for (const k of PROJECTION_STRIPPED_WORLD_KEYS) expect(k in p.snapshot).toBe(false);
    for (const k of PROJECTION_STRIPPED_ANT_KEYS) expect(k in p.snapshot.ants).toBe(false);
    for (const c of Object.values(p.snapshot.colonies)) {
      for (const k of PROJECTION_STRIPPED_COLONY_KEYS) expect(k in c).toBe(false);
      for (const ch of c.chambers) {
        for (const k of PROJECTION_STRIPPED_CHAMBER_KEYS) expect(k in ch).toBe(false);
      }
    }
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    expect(p.food.colonies[String(PLAYER_COLONY_ID)]!.total).toBe(colonyFoodTotal(world, colony));
    expect(p.food.piles.length).toBe(pileCount(world));
    expect(p.food.piles[0]![3]).toBe(pileAmountFp(world, pileSlotAt(world, 0)));
    // Non-food snapshot content survives (e.g. rngState, tick, nextEntityId).
    expect(p.snapshot['nextEntityId']).toBe(world.nextEntityId);
  });

  it('changes when pile food, pool food or hunger changes', () => {
    const world = createScenario(13);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const h0 = hashFoodProjection(world);
    drainPile(world, pileSlotAt(world, 0), 512);
    const h1 = hashFoodProjection(world);
    expect(h1).not.toBe(h0);
    expect(withdrawFood(world, colony, 10)).toBe(true);
    const h2 = hashFoodProjection(world);
    expect(h2).not.toBe(h1);
    depositIntoPool(world, colony, 10);
    expect(hashFoodProjection(world)).toBe(h1); // back to the same food state
    world.ants.lastMealTick[colony.queenEntityId]! -= 1; // one more missed meal
    expect(hashFoodProjection(world)).not.toBe(h1);
  });

  it('hungerProjection reads the queen and larva countdowns, null otherwise', () => {
    const world = createScenario(14);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    expect(hungerProjection(world, colony.queenEntityId)).toBe(STARVATION_GRACE_TICKS);
    const worker = colony.workers[0]!;
    expect(hungerProjection(world, worker)).toBeNull();
    // A synthetic larva membership is picked up with its own clock.
    colony.larvae.push(worker);
    setMealsUntilStarvationForTest(world, worker, LARVA_HUNGER, 42);
    expect(hungerProjection(world, worker)).toBe(42);
    world.ants.alive[worker] = 0;
    expect(hungerProjection(world, worker)).toBeNull();
    expect(parse(world).hunger.some(([id]) => id === colony.queenEntityId)).toBe(true);
  });
});

describe('#290 PR 2 — hungerProjection reproduces the pre-V50 countdown', () => {
  it('queen: 300 at world creation, 300 while fed, −1 per missed meal', () => {
    const world = createScenario(15);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const q = colony.queenEntityId;
    expect(hungerProjection(world, q)).toBe(STARVATION_GRACE_TICKS); // tick 0, before any meal
    tick(world, []);
    expect(hungerProjection(world, q)).toBe(STARVATION_GRACE_TICKS); // fed at tick 0
    setColonyFoodForTest(world, colony, 0);
    tick(world, []);
    tick(world, []);
    expect(hungerProjection(world, q)).toBe(STARVATION_GRACE_TICKS - 2); // two missed meals
  });
});
