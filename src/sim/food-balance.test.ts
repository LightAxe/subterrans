// #403 — food-fairness.ts balanceHomeFood: the natural food within
// FOOD_BALANCE_RADIUS_TILES of the colonies is dealt out again in matched sets, one
// pile per colony at the same path distance from home and the same size.
//
// The oracle re-derives distances with a fresh BFS per entrance
// (computeSurfaceGoalField), not the world's goal-field cache.
import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { balanceHomeFood } from './food-fairness.js';
import { createWorldState, allocateEntityId } from './types.js';
import type { WorldState } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { Rng } from './rng.js';
import { computeSurfaceGoalField, SURFACE_GOAL_UNREACHED } from './surface-routing.js';
import { isSurfaceTileInComponent, SurfaceMovementEffect } from './surface-features.js';
import {
  assertFoodStoreInvariants,
  ensureColonyPoolForTest,
  pilesForTest,
  setPilesForTest,
  type TestPile,
} from './food/food-test-utils.js';
import {
  FOOD_BALANCE_RADIUS_TILES,
  FOOD_FAIRNESS_MIN_PICKUPS,
  FOOD_FAIRNESS_RADIUS_TILES,
  FOOD_PILE_COUNT,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
  FOOD_SCENT_RADIUS_TILES,
  SURFACE_GRID_WIDTH,
} from './constants.js';

const RB = FOOD_BALANCE_RADIUS_TILES;
const FAR = Number.POSITIVE_INFINITY;

function colonyDist(world: WorldState, cid: number, x: number, y: number): number {
  let best = FAR;
  for (const e of world.colonies[cid]!.entrances) {
    if (!e.isOpen) continue;
    const f = computeSurfaceGoalField(world.bakedSurfaceEffect, e.surfaceTileX, e.surfaceTileY);
    const d = f[y * SURFACE_GRID_WIDTH + x]!;
    if (d !== SURFACE_GOAL_UNREACHED && d < best) best = d;
  }
  return best;
}

/** Each colony's piles within the balance radius (strictly nearest it): [dist, pickups], sorted. */
function homeRings(world: WorldState): Map<number, Array<[number, number]>> {
  const ids = Object.keys(world.colonies)
    .map(Number)
    .sort((a, b) => a - b);
  const rings = new Map<number, Array<[number, number]>>(ids.map((id) => [id, []]));
  for (const p of pilesForTest(world)) {
    if (p.isCorpse === true) continue;
    const ds = ids.map((id) => colonyDist(world, id, p.tileX, p.tileY));
    const min = Math.min(...ds);
    if (min > RB) continue;
    const at = ds.indexOf(min);
    if (ds.lastIndexOf(min) !== at) continue; // tied: nobody's
    rings.get(ids[at]!)!.push([min, p.pickupsRemaining]);
  }
  for (const r of rings.values()) r.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return rings;
}

function expectSpacing(world: WorldState): void {
  const piles = pilesForTest(world);
  for (const p of piles) {
    expect(isSurfaceTileInComponent(world, p.tileX, p.tileY)).toBe(true);
    for (const c of Object.values(world.colonies)) {
      for (const e of c.entrances) {
        expect(
          Math.abs(p.tileX - e.surfaceTileX) + Math.abs(p.tileY - e.surfaceTileY),
        ).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
      }
    }
    for (const q of piles) {
      if (q.foodPileId === p.foodPileId) continue;
      expect(Math.abs(p.tileX - q.tileX) + Math.abs(p.tileY - q.tileY)).toBeGreaterThanOrEqual(
        FOOD_PILE_MIN_SEPARATION,
      );
    }
  }
}

function openWorld(seed = 1): WorldState {
  const world = createWorldState(seed);
  world.bakedSurfaceEffect.fill(SurfaceMovementEffect.Cosmetic);
  world.surfaceComponentMask = null;
  world.surfaceGoalFields = null;
  return world;
}

/**
 * A world whose only walkable ground is the row y = 64 from x = 10 to x = 120: each
 * path distance from a colony at either end has exactly one tile, so what a tile
 * rules out (spacing, the colony clearance) can be placed to the tile.
 */
function corridorWorld(): WorldState {
  const world = createWorldState(1);
  world.bakedSurfaceEffect.fill(SurfaceMovementEffect.HardBlock);
  for (let x = 10; x <= 120; x++) {
    world.bakedSurfaceEffect[64 * SURFACE_GRID_WIDTH + x] = SurfaceMovementEffect.Cosmetic;
  }
  world.surfaceComponentMask = null;
  world.surfaceGoalFields = null;
  return world;
}

function addColony(world: WorldState, cid: number, x: number, y: number): void {
  const colony = createColonyRecord(cid, allocateEntityId(world));
  colony.entrances = [
    { entranceId: allocateEntityId(world), surfaceTileX: x, surfaceTileY: y, isOpen: true },
  ];
  colony.rallyPoint = null;
  world.colonies[cid] = colony;
  ensureColonyPoolForTest(world, colony);
  world.surfaceComponentMask = null;
}

let nextPileId = 7000;
function pile(x: number, y: number, pickups: number): TestPile {
  return {
    foodPileId: nextPileId++,
    tileX: x,
    tileY: y,
    pickupsRemaining: pickups,
    pickupsInitial: pickups,
  };
}

describe('#403 balanceHomeFood on scenario maps', () => {
  it('gives every colony the same piles near home on 200 seeds, keeping the count, spacing and #395 food', () => {
    for (let seed = 0; seed < 200; seed++) {
      const world = createScenario(seed);
      const piles = pilesForTest(world);
      expect(piles.length).toBe(FOOD_PILE_COUNT);
      const rings = homeRings(world);
      const [a, b] = [...rings.values()];
      expect(b!.length, `seed ${seed}`).toBe(a!.length);
      for (let i = 0; i < a!.length; i++) {
        expect(b![i]![1], `seed ${seed} set ${i} size`).toBe(a![i]![1]);
        expect(b![i]![0], `seed ${seed} set ${i} dist`).toBe(a![i]![0]);
        // never straddles the scent radius
        expect(b![i]![0] <= FOOD_SCENT_RADIUS_TILES, `seed ${seed} set ${i} scent`).toBe(
          a![i]![0] <= FOOD_SCENT_RADIUS_TILES,
        );
      }
      // #395 guarantee: each colony has >= the minimum within the fairness radius.
      for (const ring of rings.values()) {
        const near = ring
          .filter(([d]) => d <= FOOD_FAIRNESS_RADIUS_TILES)
          .reduce((n, [, p]) => n + p, 0);
        expect(near, `seed ${seed}`).toBeGreaterThanOrEqual(FOOD_FAIRNESS_MIN_PICKUPS);
      }
      expectSpacing(world);
      assertFoodStoreInvariants(world);
    }
  }, 180_000);

  it('is the same map for the same seed, whatever the difficulty', () => {
    for (const seed of [1, 14, 18, 66]) {
      const a = createScenario(seed, 'Normal');
      for (const diff of ['Easy', 'Normal', 'Hard'] as const) {
        const b = createScenario(seed, diff);
        expect(pilesForTest(b)).toEqual(pilesForTest(a));
        expect(b.rngState).toBe(a.rngState);
      }
    }
  });
});

describe('#403 balanceHomeFood on hand-built worlds', () => {
  it('matches a near pile on one side with a far one on the other: both at the mean distance and size', () => {
    const world = openWorld();
    addColony(world, 1, 24, 64);
    addColony(world, 2, 104, 64);
    setPilesForTest(world, [pile(33, 64, 100), pile(104 - 18, 64, 60)]);
    balanceHomeFood(world, new Rng(5));
    const rings = homeRings(world);
    expect(rings.get(1)).toEqual([[13, 80]]);
    expect(rings.get(2)).toEqual([[13, 80]]);
    expectSpacing(world);
  });

  it('leaves an already matched layout untouched and draws nothing', () => {
    const world = openWorld();
    addColony(world, 1, 24, 64);
    addColony(world, 2, 104, 64);
    const before = [
      pile(24, 64 - 12, 70),
      pile(104, 64 + 12, 70),
      pile(24 + 20, 64, 90),
      pile(104 - 20, 64, 90),
    ];
    setPilesForTest(world, before);
    const rng = new Rng(9);
    const state = rng.getState();
    balanceHomeFood(world, rng);
    expect(rng.getState()).toBe(state);
    expect(pilesForTest(world).map((p) => [p.tileX, p.tileY, p.pickupsRemaining])).toEqual(
      before.map((p) => [p.tileX, p.tileY, p.pickupsRemaining]),
    );
  });

  it('keeps a set inside the scent radius when its mean distance is inside it', () => {
    const world = openWorld();
    addColony(world, 1, 24, 64);
    addColony(world, 2, 104, 64);
    // mean distance (9 + 21) / 2 = 15: both land at 15, never 16.
    setPilesForTest(world, [pile(24 + 9, 64, 50), pile(104 - 21, 64, 50)]);
    balanceHomeFood(world, new Rng(3));
    const rings = homeRings(world);
    expect(rings.get(1)![0]![0]).toBe(15);
    expect(rings.get(2)![0]![0]).toBe(15);
  });

  it('moves an odd pile out past the radius, about as far from every colony', () => {
    const world = openWorld();
    addColony(world, 1, 24, 64);
    addColony(world, 2, 104, 64);
    const odd = pile(24 + 25, 64, 120);
    setPilesForTest(world, [pile(24 + 12, 64, 60), pile(104 - 12, 64, 60), odd]);
    balanceHomeFood(world, new Rng(11));
    const moved = pilesForTest(world).find((p) => p.foodPileId === odd.foodPileId)!;
    const d1 = colonyDist(world, 1, moved.tileX, moved.tileY);
    const d2 = colonyDist(world, 2, moved.tileX, moved.tileY);
    expect(d1).toBeGreaterThan(RB);
    expect(d2).toBeGreaterThan(RB);
    expect(d1).toBe(d2);
    expect(moved.pickupsRemaining).toBe(120);
  });

  it('raises the nearest set to the #395 minimum', () => {
    const world = openWorld();
    addColony(world, 1, 24, 64);
    addColony(world, 2, 104, 64);
    setPilesForTest(world, [pile(24 + 12, 64, 20), pile(104 - 14, 64, 30)]);
    balanceHomeFood(world, new Rng(2));
    for (const ring of homeRings(world).values())
      expect(ring).toEqual([[13, FOOD_FAIRNESS_MIN_PICKUPS]]);
  });

  it('does nothing with a single colony', () => {
    const world = openWorld();
    addColony(world, 1, 24, 64);
    setPilesForTest(world, [pile(24 + 9, 64, 50)]);
    const rng = new Rng(1);
    balanceHomeFood(world, rng);
    expect(rng.getState()).toBe(new Rng(1).getState());
    expect(pilesForTest(world)[0]!.tileX).toBe(33);
  });

  // Corridor worlds: colonies at x = 10 and x = 120, so the tile at path distance d
  // from colony 1 is x = 10 + d and from colony 2 is x = 120 - d. A pile at distance
  // 41+ is in nobody's pool, and (spacing 12) rules out the tiles within 11 of it.
  it('widens the band by a tile when the exact distance has no valid tile', () => {
    const world = corridorWorld();
    addColony(world, 1, 10, 64);
    addColony(world, 2, 120, 64);
    // The blocker at d = 43 (x = 53) rules out x >= 42, i.e. d >= 32 from colony 1.
    // The set's mean distance is (30 + 34) / 2 = 32: colony 1 has no tile at 32 but
    // has one at 31.
    const blocker = pile(10 + 43, 64, 25);
    const p1 = pile(10 + 30, 64, 50);
    const p2 = pile(120 - 34, 64, 70);
    setPilesForTest(world, [p1, p2, blocker]);
    balanceHomeFood(world, new Rng(4));
    const piles = pilesForTest(world);
    const m1 = piles.find((p) => p.foodPileId === p1.foodPileId)!;
    const m2 = piles.find((p) => p.foodPileId === p2.foodPileId)!;
    expect(colonyDist(world, 1, m1.tileX, m1.tileY)).toBe(31);
    expect(m1.tileX).toBe(10 + 31);
    expect(colonyDist(world, 2, m2.tileX, m2.tileY)).toBe(32);
    expect(m1.pickupsRemaining).toBe(60);
    expect(m2.pickupsRemaining).toBe(60);
    const b = piles.find((p) => p.foodPileId === blocker.foodPileId)!;
    expect([b.tileX, b.pickupsRemaining]).toEqual([53, 25]);
    assertFoodStoreInvariants(world);
  });

  it('falls back to the nearest valid distance when no band tile exists at all (#403 review S1)', () => {
    const world = corridorWorld();
    addColony(world, 1, 10, 64);
    addColony(world, 2, 120, 64);
    // The blocker at d = 41 (x = 51) rules out d >= 30 from colony 1. The set's mean
    // distance is (30 + 38) / 2 = 34: even widened by 3 (31..37) colony 1 has no tile,
    // so the pile goes to the nearest valid distance, 29.
    const blocker = pile(10 + 41, 64, 25);
    const p1 = pile(10 + 30, 64, 50);
    const p2 = pile(120 - 38, 64, 70);
    setPilesForTest(world, [p1, p2, blocker]);
    balanceHomeFood(world, new Rng(6));
    const piles = pilesForTest(world);
    const m1 = piles.find((p) => p.foodPileId === p1.foodPileId)!;
    const m2 = piles.find((p) => p.foodPileId === p2.foodPileId)!;
    expect(colonyDist(world, 1, m1.tileX, m1.tileY)).toBe(29);
    expect(colonyDist(world, 2, m2.tileX, m2.tileY)).toBe(34);
    expect(m1.pickupsRemaining).toBe(60);
    expect(m2.pickupsRemaining).toBe(60);
    expectSpacing(world);
    assertFoodStoreInvariants(world);
  });

  it('leaves a pile in place, unresized, when its colony has no valid tile at all (#403 review S1)', () => {
    const world = corridorWorld();
    // 10 tiles apart: the colony clearance (8) leaves colony 1 no tile of its own side.
    addColony(world, 1, 10, 64);
    addColony(world, 2, 20, 64);
    const p1 = pile(14, 64, 50);
    const p2 = pile(16, 64, 70);
    setPilesForTest(world, [p1, p2]);
    balanceHomeFood(world, new Rng(8));
    const piles = pilesForTest(world);
    const m1 = piles.find((p) => p.foodPileId === p1.foodPileId)!;
    expect([m1.tileX, m1.tileY, m1.pickupsRemaining, m1.pickupsInitial]).toEqual([14, 64, 50, 50]);
  });

  it('forms no set from fewer piles than colonies: a lone near pile stays put (#403 review S2)', () => {
    const world = corridorWorld();
    addColony(world, 1, 10, 64);
    addColony(world, 2, 120, 64);
    const near = pile(10 + 20, 64, 70);
    const far = pile(65, 64, 90); // 55 from both: in nobody's pool
    setPilesForTest(world, [near, far]);
    const rng = new Rng(12);
    const state = rng.getState();
    balanceHomeFood(world, rng);
    expect(rng.getState()).toBe(state);
    expect(pilesForTest(world).map((p) => [p.tileX, p.tileY, p.pickupsRemaining])).toEqual([
      [30, 64, 70],
      [65, 64, 90],
    ]);
  });
});
