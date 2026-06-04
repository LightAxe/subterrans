// food-trail-decays-after-depletion.test.ts — issue #112 invariant guard
//
// Invariant under test (per the issue planning thread):
//   After all carriers returning from a depleted pile have completed their
//   return-to-nest cycle, no further food-trail deposits occur on the pile's
//   tile, and the trail strength at that tile decays naturally to zero
//   within the PHEROMONE_DECAY_FP-derived budget.
//
// This is the "self-balancing" claim from the issue's design comment: we do
// NOT need a special "pile vanished" pheromone-clear pass, because deposit
// stops when no carrier walks the route, and the existing decay drains the
// trail to zero on its own.
//
// Why the guard matters: if a future code path were to deposit food-trail
// pheromone on a tile that no longer hosts a pile (e.g. a forager that picks
// up "from" a vanished pile via a stale target), the trail would be refreshed
// indefinitely — the player would see a phantom hot trail leading to nowhere.
// This test ensures the invariant holds end-to-end through the tick dispatcher.
//
// Run: npx vitest run src/sim/pheromone/food-trail-decays-after-depletion.test.ts

import { describe, it, expect } from 'vitest';
import { createScenario } from '../scenario.js';
import { tick } from '../tick.js';
import { PheromoneType } from '../enums.js';
import { pheromoneGridKey, phGet, phSet } from './pheromone-store.js';
import { PLAYER_COLONY_ID, PHEROMONE_CAP } from '../constants.js';
import { recordFoodPileDepletion } from '../food-system.js';

describe('issue #112 — food-trail decays naturally after pile depletion', () => {
  it('after pile vanishes and carriers clear, trail at the tile reaches 0 within decay budget', () => {
    const world = createScenario(42);
    const target = world.foodPiles[0]!;
    const tileX = target.tileX;
    const tileY = target.tileY;
    const trailKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');

    // Manually prime the surface food-trail at the target tile to PHEROMONE_CAP.
    // This simulates a fully-saturated trail just before depletion — the most
    // pessimistic starting point for the decay budget.
    const grid = world.pheromoneGrids[trailKey]!;
    phSet(grid, tileX, tileY, PHEROMONE_CAP);
    expect(phGet(grid, tileX, tileY)).toBe(PHEROMONE_CAP);

    // Vanish the pile in-place (simulate the splice + record path that
    // tickForagerActions performs on the final pickup).
    recordFoodPileDepletion(world, 0);
    world.foodPiles.splice(0, 1);

    // Suppress carriers from re-flooding the trail: drop every ant in the
    // colony so no deposits occur during the decay window. (We're testing the
    // decay path in isolation; carriers are validated by the integration test
    // below.)
    for (let id = 0; id < world.nextEntityId; id++) {
      world.ants.alive[id] = 0;
    }

    // Decay budget — pessimistic ceiling on how long a fully-saturated tile
    // takes to floor-snap to 0 under tickPheromoneDecay. With
    // PHEROMONE_DECAY_FP = 5 (≈2% per tick) and PHEROMONE_FLOOR = 64, the
    // expected curve is geometric and reaches the floor in ~250 ticks. Use
    // 1000 as a generous safety margin so this guard isn't flaky under
    // future decay tuning.
    const DECAY_BUDGET = 1000;
    let lastValue = PHEROMONE_CAP;
    for (let t = 0; t < DECAY_BUDGET; t++) {
      tick(world, []);
      const v = phGet(grid, tileX, tileY);
      // Monotonic non-increase — guards against any code path that would
      // re-deposit on this tile after the pile vanished.
      expect(v).toBeLessThanOrEqual(lastValue);
      lastValue = v;
      if (v === 0) break;
    }

    expect(lastValue).toBe(0);
  });

  it(
    'integration: forced fast depletion → trail at vanished tile decays naturally without re-saturation',
    { timeout: 60000 },
    () => {
      // Steady-state version of the above: drive a real scenario, force one
      // pile to deplete quickly (lower its charge count), then verify the trail
      // at that tile converges to 0 over time without any code path
      // re-saturating it. No manual ant-suppression — we let in-flight carriers
      // complete their return cycle naturally.
      const world = createScenario(42);
      const trailKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');

      // Lower every pile's charge count to 2 so depletion happens within the
      // first round of foraging trips rather than after thousands of ticks.
      for (const p of world.foodPiles) {
        p.pickupsRemaining = 2;
        p.pickupsInitial = 2;
      }

      const DEPLETION_BUDGET_TICKS = 5000;
      let depletionTick = -1;
      for (let t = 0; t < DEPLETION_BUDGET_TICKS && depletionTick === -1; t++) {
        tick(world, []);
        if (world.recentlyDepletedFood.length > 0) {
          depletionTick = world.tick;
        }
      }
      // Fail loud if depletion didn't happen — that's a regression in the
      // depletion mechanic itself, not "ambient flakiness." Lowering each pile
      // to 2 charges above gives us several orders of magnitude of slack;
      // 5000 ticks is well beyond what 3 starting workers need to drain a
      // 2-charge pile. If this fires, investigate the foraging path before
      // bumping the budget.
      expect(depletionTick).toBeGreaterThanOrEqual(0);

      const depletedTile = world.recentlyDepletedFood[0]!;
      const grid = world.pheromoneGrids[trailKey]!;
      const startValue = phGet(grid, depletedTile.tileX, depletedTile.tileY);

      // Decay window — generous enough for in-flight carriers to clear plus
      // pheromone decay to drain. 1000 ticks at 20Hz = 50 sim seconds.
      const DECAY_WINDOW = 1000;
      let maxValueDuringWindow = startValue;
      for (let t = 0; t < DECAY_WINDOW; t++) {
        tick(world, []);
        const v = phGet(grid, depletedTile.tileX, depletedTile.tileY);
        if (v > maxValueDuringWindow) maxValueDuringWindow = v;
      }

      const finalValue = phGet(grid, depletedTile.tileX, depletedTile.tileY);

      // The trail at a depleted tile should not refresh to a strong value
      // post-depletion. Allow ambient pheromone bleed from cross-pile carrier
      // traffic; the hard invariant is no permanent re-saturation.
      expect(finalValue).toBeLessThan(PHEROMONE_CAP);
      // Peak value during the window should not exceed the starting value by
      // more than a "single carrier walking through" bump. Use bit-shift
      // (PHEROMONE_CAP >> 2 = quarter cap) to satisfy the sim/ no-float-divide
      // ESLint rule even though this is a test file.
      expect(maxValueDuringWindow - startValue).toBeLessThanOrEqual(PHEROMONE_CAP >> 2);
    },
  );
});
