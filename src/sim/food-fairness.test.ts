// #395 (V69) — food-fairness.ts ensureFoodNearEachColony: every colony starts with at
// least FOOD_FAIRNESS_MIN_PICKUPS pickups of food of its own within
// FOOD_FAIRNESS_RADIUS_TILES of one of its open entrances, by surface path.
//
// The oracle below re-derives "serves" independently (a fresh BFS per entrance via
// computeSurfaceGoalField, not the world's goal-field cache): a natural pile serves
// colony c when it is within the radius of c and strictly nearer c than every other
// colony.
import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { ensureFoodNearEachColony } from './food-fairness.js';
import { createWorldState, allocateEntityId, LATEST_SIM_VERSION } from './types.js';
import type { WorldState } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { Rng } from './rng.js';
import { computeSurfaceGoalField, SURFACE_GOAL_UNREACHED } from './surface-routing.js';
import { isSurfaceTileInComponent, SurfaceMovementEffect } from './surface-features.js';
import {
  pileCount,
  pileFoodId,
  pileIsCorpse,
  pileSlotAt,
  pileTileX,
  pileTileY,
} from './food/food-api.js';
import {
  assertFoodStoreInvariants,
  ensureColonyPoolForTest,
  pilesForTest,
  setPilesForTest,
  type TestPile,
} from './food/food-test-utils.js';
import {
  FOOD_FAIRNESS_MIN_PICKUPS,
  FOOD_FAIRNESS_RADIUS_TILES,
  FOOD_PILE_COUNT,
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_INITIAL_PICKUPS_MIN,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
  MAX_ENTITIES,
  SURFACE_GRID_WIDTH,
} from './constants.js';

const R = FOOD_FAIRNESS_RADIUS_TILES;
const MIN = FOOD_FAIRNESS_MIN_PICKUPS;
const FAR = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

// A fresh BFS per (world, entrance tile), memoised: tests finish editing a world's
// terrain before the first oracle call on it.
const fields = new WeakMap<WorldState, Map<number, Int32Array>>();
function entranceField(world: WorldState, x: number, y: number): Int32Array {
  let m = fields.get(world);
  if (m === undefined) {
    m = new Map();
    fields.set(world, m);
  }
  const key = y * SURFACE_GRID_WIDTH + x;
  let f = m.get(key);
  if (f === undefined) {
    f = computeSurfaceGoalField(world.bakedSurfaceEffect, x, y);
    m.set(key, f);
  }
  return f;
}

/** Path distance from tile (x, y) to colony `cid`'s nearest open entrance (FAR if none reaches). */
function colonyDist(world: WorldState, cid: number, x: number, y: number): number {
  let best = FAR;
  for (const e of world.colonies[cid]!.entrances) {
    if (!e.isOpen) continue;
    const f = entranceField(world, e.surfaceTileX, e.surfaceTileY);
    const d = f[y * SURFACE_GRID_WIDTH + x]!;
    if (d !== SURFACE_GOAL_UNREACHED && d < best) best = d;
  }
  return best;
}

function colonyIds(world: WorldState): number[] {
  return Object.keys(world.colonies)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The colony a pile on (x, y) serves, or null. */
function servedBy(world: WorldState, x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = FAR;
  let tied = false;
  for (const cid of colonyIds(world)) {
    const d = colonyDist(world, cid, x, y);
    if (d === FAR) continue;
    if (d < bestD) {
      best = cid;
      bestD = d;
      tied = false;
    } else if (d === bestD) tied = true;
  }
  if (tied || best === null || bestD > R) return null;
  return best;
}

function ownPiles(world: WorldState, cid: number): TestPile[] {
  return pilesForTest(world).filter(
    (p) => p.isCorpse !== true && servedBy(world, p.tileX, p.tileY) === cid,
  );
}

/** Pickups the piles serving colony `cid` hold between them. */
function ownPickups(world: WorldState, cid: number): number {
  return ownPiles(world, cid).reduce((n, p) => n + p.pickupsRemaining, 0);
}

/** Colonies with an open entrance whose own piles hold fewer than the minimum. */
function unservedColonies(world: WorldState): number[] {
  return colonyIds(world).filter(
    (cid) => world.colonies[cid]!.entrances.some((e) => e.isOpen) && ownPickups(world, cid) < MIN,
  );
}

/** The scatter's spacing rules for a pile at (x, y), against every other pile. */
function expectSpacing(world: WorldState, p: TestPile): void {
  expect(isSurfaceTileInComponent(world, p.tileX, p.tileY)).toBe(true);
  for (const c of Object.values(world.colonies)) {
    for (const e of c.entrances) {
      expect(
        Math.abs(p.tileX - e.surfaceTileX) + Math.abs(p.tileY - e.surfaceTileY),
      ).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
    }
  }
  for (const q of pilesForTest(world)) {
    if (q.foodPileId === p.foodPileId) continue;
    expect(Math.abs(p.tileX - q.tileX) + Math.abs(p.tileY - q.tileY)).toBeGreaterThanOrEqual(
      FOOD_PILE_MIN_SEPARATION,
    );
  }
}

// ---------------------------------------------------------------------------
// Synthetic worlds: open terrain, hand-placed colonies and piles
// ---------------------------------------------------------------------------

/** A world with every surface tile walkable and no colonies or piles. */
function openWorld(seed = 1): WorldState {
  const world = createWorldState(seed);
  world.bakedSurfaceEffect.fill(SurfaceMovementEffect.Cosmetic);
  world.surfaceComponentMask = null;
  world.surfaceGoalFields = null;
  return world;
}

/** Add colony `cid` with entrances at `tiles` (open unless `[x, y, false]`). */
function addColony(
  world: WorldState,
  cid: number,
  tiles: ReadonlyArray<readonly [number, number] | readonly [number, number, boolean]>,
): void {
  const colony = createColonyRecord(cid, allocateEntityId(world));
  colony.entrances = tiles.map((d) => ({
    entranceId: allocateEntityId(world),
    surfaceTileX: d[0],
    surfaceTileY: d[1],
    isOpen: d[2] ?? true,
  }));
  colony.rallyPoint = null;
  world.colonies[cid] = colony;
  ensureColonyPoolForTest(world, colony);
  world.surfaceComponentMask = null;
}

let nextPileId = 5000;
function pile(x: number, y: number, pickups = 60, isCorpse = false): TestPile {
  const p: TestPile = {
    foodPileId: nextPileId++,
    tileX: x,
    tileY: y,
    pickupsRemaining: pickups,
    pickupsInitial: pickups,
  };
  if (isCorpse) p.isCorpse = true;
  return p;
}

function tileOf(world: WorldState, id: number): [number, number] {
  const p = pilesForTest(world).find((q) => q.foodPileId === id)!;
  return [p.tileX, p.tileY];
}

// ---------------------------------------------------------------------------
// Scenario maps
// ---------------------------------------------------------------------------

describe('#395 ensureFoodNearEachColony on scenario maps (V69)', () => {
  it('gives every colony its own food within the radius on 300 seeds, keeping the pile count and sizes', () => {
    for (let seed = 0; seed < 300; seed++) {
      const world = createScenario(seed);
      expect(world.simVersion).toBe(LATEST_SIM_VERSION);

      // The scatter's piles in creation order, each still its natural size: on these
      // maps the pass only moves piles, it neither adds one nor resizes one.
      const piles = pilesForTest(world);
      expect(piles.map((p) => p.foodPileId)).toEqual(piles.map((_, i) => i));
      expect(piles.length).toBe(FOOD_PILE_COUNT);
      for (const p of piles) {
        expect(p.isCorpse).toBeUndefined();
        expect(p.pickupsRemaining).toBe(p.pickupsInitial);
        expect(p.pickupsInitial).toBeGreaterThanOrEqual(FOOD_PILE_INITIAL_PICKUPS_MIN);
        expect(p.pickupsInitial).toBeLessThanOrEqual(FOOD_PILE_INITIAL_PICKUPS_MAX);
        expectSpacing(world, p);
      }

      for (const cid of colonyIds(world)) {
        expect(ownPickups(world, cid), `seed ${seed} colony ${cid}`).toBeGreaterThanOrEqual(MIN);
      }
      assertFoodStoreInvariants(world);
    }
  }, 120_000); // generous for v8-instrumented coverage runs (#227)

  it('pins the maps of the #395 playtest seeds: where the moved piles stand, and the rng after', () => {
    // [seed, [[pile id, x, y] moved], rngState after generation] — Normal, LATEST. On
    // the scatter each colony listed here lacked food of its own; these piles are the
    // ones the donor rule moved to it. A later change to the rule bumps simVersion
    // (pre-1.0: no gate) and re-pins these.
    const GOLDEN: ReadonlyArray<readonly [number, ReadonlyArray<readonly number[]>, number]> = [
      [
        1,
        [
          [0, 93, 57],
          [7, 11, 57],
        ],
        3980938825,
      ],
      [
        12,
        [
          [0, 21, 71],
          [9, 99, 44],
        ],
        317807210,
      ],
      [24, [[10, 32, 78]], 2149373035],
      [27, [[5, 38, 70]], 2149373038],
      [5, [[12, 4, 66]], 4044880026],
      [20, [[10, 19, 69]], 3413044371],
    ];
    for (const [seed, moves, rngState] of GOLDEN) {
      const world = createScenario(seed, 'Normal');
      for (const [id, x, y] of moves) {
        expect(tileOf(world, id!), `seed ${seed} pile ${id}`).toEqual([x, y]);
        expect(servedBy(world, x!, y!), `seed ${seed} pile ${id}`).not.toBeNull();
      }
      expect(world.rngState, `seed ${seed}`).toBe(rngState);
    }
  });

  it('is the same map for the same seed (determinism)', () => {
    for (const seed of [1, 12, 24, 27, 5, 20, 101, 333]) {
      for (const diff of ['Easy', 'Normal', 'Hard'] as const) {
        const a = createScenario(seed, diff);
        const b = createScenario(seed, diff);
        expect(pilesForTest(b)).toEqual(pilesForTest(a));
        expect(b.rngState).toBe(a.rngState);
        expect(b.nextEntityId).toBe(a.nextEntityId);
      }
    }
  });

  it('does not depend on the difficulty', () => {
    for (const seed of [1, 12, 24, 27]) {
      const n = pilesForTest(createScenario(seed, 'Normal'));
      expect(pilesForTest(createScenario(seed, 'Easy'))).toEqual(n);
      expect(pilesForTest(createScenario(seed, 'Hard'))).toEqual(n);
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic worlds
// ---------------------------------------------------------------------------

describe('#395 ensureFoodNearEachColony on hand-built worlds', () => {
  it('serves four colonies at arbitrary positions, none of them at the scenario start tiles', () => {
    const world = openWorld();
    addColony(world, 1, [[10, 10]]);
    addColony(world, 2, [[110, 20]]);
    addColony(world, 3, [[60, 70]]);
    addColony(world, 4, [[30, 115]]);
    const piles = [
      pile(64, 3, 30),
      pile(3, 60, 150),
      pile(124, 90, 20),
      pile(100, 124, 75),
      pile(80, 40, 99),
      pile(30, 80, 44),
    ];
    setPilesForTest(world, piles);
    expect(unservedColonies(world)).toEqual([1, 2, 3, 4]);

    ensureFoodNearEachColony(world, new Rng(42));

    expect(unservedColonies(world)).toEqual([]);
    const after = pilesForTest(world);
    expect(after.map((p) => [p.foodPileId, p.pickupsInitial])).toEqual(
      piles.map((p) => [p.foodPileId, p.pickupsInitial]),
    );
    expect(after.filter((p, i) => p.tileX !== piles[i]!.tileX).length).toBeGreaterThan(0);
    const servedIds = new Set<number>();
    for (const cid of [1, 2, 3, 4]) {
      const own = ownPiles(world, cid);
      expect(own.length).toBe(1);
      expectSpacing(world, own[0]!);
      servedIds.add(own[0]!.foodPileId);
    }
    expect(servedIds.size).toBe(4);
    assertFoodStoreInvariants(world);
  });

  it('follows a colony that moved: the guarantee reads its entrances, not a start tile', () => {
    const world = openWorld();
    addColony(world, 1, [[90, 100]]);
    addColony(world, 2, [[20, 20]]);
    setPilesForTest(world, [pile(24, 40), pile(60, 64), pile(124, 3)]); // (24,40) serves 2
    ensureFoodNearEachColony(world, new Rng(7));
    expect(ownPiles(world, 1).length).toBe(1);
    expect(
      colonyDist(world, 1, ...tileOf(world, ownPiles(world, 1)[0]!.foodPileId)),
    ).toBeLessThanOrEqual(R);
    expect(tileOf(world, ownPiles(world, 2)[0]!.foodPileId)).toEqual([24, 40]);
  });

  it('two close colonies: a pile equally near both serves neither, and a pile nearer the other serves only it', () => {
    const world = openWorld();
    addColony(world, 1, [[50, 64]]);
    addColony(world, 2, [[70, 64]]);
    const mid = pile(60, 74); // 20 from each: within the radius of both, but contested
    setPilesForTest(world, [mid, pile(10, 3), pile(120, 120)]);
    expect(servedBy(world, 60, 74)).toBeNull();
    expect(unservedColonies(world)).toEqual([1, 2]);

    ensureFoodNearEachColony(world, new Rng(3));

    for (const cid of [1, 2]) {
      const own = ownPiles(world, cid);
      expect(own.length).toBe(1);
      const [x, y] = [own[0]!.tileX, own[0]!.tileY];
      const other = cid === 1 ? 2 : 1;
      expect(colonyDist(world, cid, x, y)).toBeLessThan(colonyDist(world, other, x, y));
    }

    // A pile within the radius of colony 1 but nearer colony 2 serves only 2.
    const w2 = openWorld();
    addColony(w2, 1, [[50, 64]]);
    addColony(w2, 2, [[70, 64]]);
    const nearer2 = pile(64, 72); // 22 from colony 1, 14 from colony 2
    setPilesForTest(w2, [nearer2, pile(10, 3)]);
    expect(unservedColonies(w2)).toEqual([1]);
    ensureFoodNearEachColony(w2, new Rng(3));
    expect(tileOf(w2, nearer2.foodPileId)).toEqual([64, 72]);
    expect(ownPiles(w2, 1).length).toBe(1);
    expect(ownPiles(w2, 2).map((p) => p.foodPileId)).toEqual([nearer2.foodPileId]);
  });

  it('never takes a pile that serves another colony, even when it is the nearest', () => {
    const world = openWorld();
    addColony(world, 1, [[20, 64]]);
    addColony(world, 2, [[60, 64]]);
    const servesTwo = pile(45, 64); // 25 from colony 1, 15 from colony 2
    const far = pile(20, 110); // 46 from colony 1
    setPilesForTest(world, [servesTwo, far]);
    ensureFoodNearEachColony(world, new Rng(11));
    expect(tileOf(world, servesTwo.foodPileId)).toEqual([45, 64]);
    expect(ownPiles(world, 1).map((p) => p.foodPileId)).toEqual([far.foodPileId]);
  });

  it('takes the nearest free pile, preferring one on its own side of the map', () => {
    const world = openWorld();
    addColony(world, 1, [[20, 64]]);
    addColony(world, 2, [[60, 64]]);
    const otherSide = pile(41, 30); // 55 from colony 1, 53 from colony 2: colony 2's side
    const ownFar = pile(5, 3); // 76 from colony 1, its own side
    const ownNear = pile(3, 110); // 63 from colony 1
    setPilesForTest(world, [otherSide, ownFar, ownNear]);
    ensureFoodNearEachColony(world, new Rng(5));
    // Colony 1 took its own side's nearest; colony 2 then took the one on its side.
    expect(ownPiles(world, 1).map((p) => p.foodPileId)).toEqual([ownNear.foodPileId]);
    expect(ownPiles(world, 2).map((p) => p.foodPileId)).toEqual([otherSide.foodPileId]);
    expect(tileOf(world, ownFar.foodPileId)).toEqual([5, 3]);

    // With no free pile on its own side it takes the nearest on another's.
    const w2 = openWorld();
    addColony(w2, 1, [[20, 64]]);
    addColony(w2, 2, [[60, 64]]);
    const a = pile(90, 64); // 70 from colony 1
    const b = pile(110, 64); // 90 from colony 1
    setPilesForTest(w2, [b, a]);
    ensureFoodNearEachColony(w2, new Rng(5));
    expect(ownPiles(w2, 1).map((p) => p.foodPileId)).toEqual([a.foodPileId]);
  });

  it('breaks a donor tie on creation order', () => {
    const world = openWorld();
    addColony(world, 1, [[64, 64]]);
    const first = pile(64, 104); // 40 below
    const second = pile(64, 24); // 40 above
    setPilesForTest(world, [first, second]);
    ensureFoodNearEachColony(world, new Rng(9));
    expect(ownPiles(world, 1).map((p) => p.foodPileId)).toEqual([first.foodPileId]);
    expect(tileOf(world, second.foodPileId)).toEqual([64, 24]);
  });

  it('leaves a world where every colony has its food untouched, with no draw', () => {
    const world = openWorld();
    addColony(world, 1, [[20, 64]]);
    addColony(world, 2, [[100, 64]]);
    const piles = [pile(20, 84), pile(100, 40), pile(64, 3)];
    setPilesForTest(world, piles);
    const rng = new Rng(1234);
    const ids = world.nextEntityId;
    ensureFoodNearEachColony(world, rng);
    expect(rng.getState()).toBe(1234);
    expect(pilesForTest(world)).toEqual(piles);
    expect(world.nextEntityId).toBe(ids);
  });

  it('counts a pile exactly on the radius, not one past it', () => {
    for (const [d, moves] of [
      [R, false],
      [R + 1, true],
    ] as const) {
      const world = openWorld();
      addColony(world, 1, [[64, 64]]);
      const p = pile(64, 64 + d);
      setPilesForTest(world, [p, pile(3, 3)]);
      const rng = new Rng(77);
      ensureFoodNearEachColony(world, rng);
      expect(rng.getState() !== 77).toBe(moves);
      expect(ownPiles(world, 1).length).toBe(1);
    }
  });

  it('counts the food its own piles hold: one pickup short of the minimum gets more, the minimum none', () => {
    for (const [own, moves] of [
      [MIN - 1, true],
      [MIN, false],
    ] as const) {
      const world = openWorld();
      addColony(world, 1, [[64, 64]]);
      const small = pile(64, 80, own);
      setPilesForTest(world, [small, pile(3, 3, 100)]);
      const rng = new Rng(31);
      ensureFoodNearEachColony(world, rng);
      expect(rng.getState() !== 31).toBe(moves);
      expect(tileOf(world, small.foodPileId)).toEqual([64, 80]); // its own pile stays
      expect(ownPickups(world, 1)).toBe(moves ? own + 100 : own);
    }
    // Two small piles that make the minimum between them are enough.
    const world = openWorld();
    addColony(world, 1, [[64, 64]]);
    setPilesForTest(world, [pile(64, 80, MIN >> 1), pile(64, 48, MIN >> 1), pile(3, 3, 100)]);
    const rng = new Rng(31);
    ensureFoodNearEachColony(world, rng);
    expect(rng.getState()).toBe(31);
  });

  it('moves only a pile holding at least the minimum, passing over a nearer small one', () => {
    const world = openWorld();
    addColony(world, 1, [[64, 64]]);
    const smallNear = pile(64, 100, MIN - 1); // 36 away
    const bigFar = pile(3, 3, MIN); // 122 away
    setPilesForTest(world, [smallNear, bigFar]);
    ensureFoodNearEachColony(world, new Rng(5));
    expect(tileOf(world, smallNear.foodPileId)).toEqual([64, 100]);
    expect(ownPiles(world, 1).map((p) => p.foodPileId)).toEqual([bigFar.foodPileId]);
    // With only small free piles a new pile is made, of at least the minimum.
    for (let s = 0; s < 20; s++) {
      const w2 = openWorld();
      addColony(w2, 1, [[64, 64]]);
      setPilesForTest(w2, [pile(64, 100, MIN - 1)]);
      ensureFoodNearEachColony(w2, new Rng(s + 1));
      expect(pileCount(w2)).toBe(2);
      const made = pilesForTest(w2)[1]!;
      expect(made.pickupsInitial).toBeGreaterThanOrEqual(MIN);
      expect(made.pickupsInitial).toBeLessThanOrEqual(FOOD_PILE_INITIAL_PICKUPS_MAX);
      expect(ownPickups(w2, 1)).toBe(made.pickupsInitial);
    }
  });

  it('measures by surface path: a pile behind a wall is as far as the walk round it', () => {
    const world = openWorld();
    // A wall at x = 70 from y = 30 to y = 98, the colony at (64, 64) west of it.
    for (let y = 30; y <= 98; y++) world.bakedSurfaceEffect[y * SURFACE_GRID_WIDTH + 70] = 2;
    addColony(world, 1, [[64, 64]]);
    const behind = pile(76, 64); // 12 Manhattan, ~80 by path
    setPilesForTest(world, [behind]);
    expect(colonyDist(world, 1, 76, 64)).toBeGreaterThan(R);
    ensureFoodNearEachColony(world, new Rng(2));
    const own = ownPiles(world, 1);
    expect(own.map((p) => p.foodPileId)).toEqual([behind.foodPileId]);
    expect(colonyDist(world, 1, own[0]!.tileX, own[0]!.tileY)).toBeLessThanOrEqual(R);
    expect(own[0]!.tileX).toBeLessThan(70);
  });

  it('ignores corpse piles: one near home does not count, and none is moved', () => {
    const world = openWorld();
    addColony(world, 1, [[64, 64]]);
    const corpse = pile(64, 76, 2 * MIN, true); // plenty, but battlefield food
    const natural = pile(3, 3);
    setPilesForTest(world, [corpse, natural]);
    ensureFoodNearEachColony(world, new Rng(4));
    expect(tileOf(world, corpse.foodPileId)).toEqual([64, 76]);
    expect(ownPiles(world, 1).map((p) => p.foodPileId)).toEqual([natural.foodPileId]);
    // A colony whose only free piles are corpses gets a new natural pile.
    const w2 = openWorld();
    addColony(w2, 1, [[64, 64]]);
    const farCorpse = pile(3, 3, 2 * MIN, true);
    setPilesForTest(w2, [farCorpse]);
    ensureFoodNearEachColony(w2, new Rng(4));
    expect(tileOf(w2, farCorpse.foodPileId)).toEqual([3, 3]);
    expect(pileCount(w2)).toBe(2);
    expect(ownPiles(w2, 1).length).toBe(1);
  });

  it('reads home from the open entrances: a closed one does not count, any open one does', () => {
    // A closed entrance 16 tiles north of the open one, inside its radius: a pile
    // near the closed one does not serve, and the closed one still keeps piles at
    // the scatter's distance.
    for (let s = 1; s <= 30; s++) {
      const world = openWorld();
      addColony(world, 1, [
        [20, 84, false],
        [20, 100],
      ]);
      const nearClosed = pile(20, 70); // 14 from the closed entrance, 30 from the open one
      setPilesForTest(world, [nearClosed]);
      expect(unservedColonies(world)).toEqual([1]);
      ensureFoodNearEachColony(world, new Rng(s));
      const [x, y] = tileOf(world, nearClosed.foodPileId);
      expect(Math.abs(x - 20) + Math.abs(y - 100)).toBeLessThanOrEqual(R);
      expect(Math.abs(x - 20) + Math.abs(y - 84)).toBeGreaterThanOrEqual(
        FOOD_PILE_MIN_COLONY_DISTANCE,
      );
    }

    const w2 = openWorld();
    addColony(w2, 1, [
      [20, 20],
      [100, 100],
    ]);
    const nearSecond = pile(100, 80);
    setPilesForTest(w2, [nearSecond]);
    const rng = new Rng(6);
    ensureFoodNearEachColony(w2, rng);
    expect(rng.getState()).toBe(6);
    expect(tileOf(w2, nearSecond.foodPileId)).toEqual([100, 80]);
  });

  it('gives a colony with no open entrance nothing, and draws nothing for it', () => {
    const world = openWorld();
    addColony(world, 1, [[64, 64, false]]);
    setPilesForTest(world, [pile(3, 3)]);
    const rng = new Rng(8);
    ensureFoodNearEachColony(world, rng);
    expect(rng.getState()).toBe(8);
    expect(tileOf(world, pilesForTest(world)[0]!.foodPileId)).toEqual([3, 3]);
  });

  it('keeps the spacing rules: off every entrance, open or closed, clear of other piles, inside the walkable component', () => {
    // Four piles round colony 1 just past the radius hem its ring in; a closed
    // entrance of colony 2 sits inside the ring; a wall cuts the ring to the north.
    const ring = [pile(64, 92), pile(36, 64), pile(92, 64), pile(64, 36)];
    let moved = 0;
    for (let s = 1; s <= 40; s++) {
      const w = openWorld();
      for (let x = 40; x <= 88; x++) w.bakedSurfaceEffect[50 * SURFACE_GRID_WIDTH + x] = 2;
      addColony(w, 1, [[64, 64]]);
      addColony(w, 2, [[64, 80, false]]);
      setPilesForTest(w, ring);
      expect(unservedColonies(w)).toEqual([1]);
      ensureFoodNearEachColony(w, new Rng(s));
      const own = ownPiles(w, 1);
      expect(own.length).toBe(1);
      expectSpacing(w, own[0]!);
      moved += pilesForTest(w).filter(
        (p, i) => p.tileX !== ring[i]!.tileX || p.tileY !== ring[i]!.tileY,
      ).length;
    }
    expect(moved).toBe(40);
  });

  it("keeps clear of the other piles only, not of the moved pile's old tile", () => {
    // The donor sits just outside the ring (30 tiles south); ring tiles within
    // FOOD_PILE_MIN_SEPARATION of where it stood are still fair destinations.
    let nearOld = 0;
    for (let s = 0; s < 200; s++) {
      const world = openWorld();
      addColony(world, 1, [[64, 64]]);
      const donor = pile(64, 94);
      setPilesForTest(world, [donor]);
      ensureFoodNearEachColony(world, new Rng(s * 7919 + 1));
      const [x, y] = tileOf(world, donor.foodPileId);
      if (Math.abs(x - 64) + Math.abs(y - 94) < FOOD_PILE_MIN_SEPARATION) nearOld++;
    }
    expect(nearOld).toBeGreaterThan(0);
  });

  it('puts a pile only in the single walkable component (a colony walled off from it gets none)', () => {
    const world = openWorld();
    // A full wall down x = 64: colony 2 is cut off from colony 1's component.
    for (let y = 0; y < 128; y++) world.bakedSurfaceEffect[y * SURFACE_GRID_WIDTH + 64] = 2;
    addColony(world, 1, [[20, 64]]);
    addColony(world, 2, [[100, 64]]);
    setPilesForTest(world, [pile(3, 3), pile(40, 120)]); // both on colony 1's side
    ensureFoodNearEachColony(world, new Rng(23));
    expect(ownPiles(world, 1).length).toBe(1);
    for (const p of pilesForTest(world)) {
      expect(isSurfaceTileInComponent(world, p.tileX, p.tileY)).toBe(true);
    }
    expect(ownPiles(world, 2)).toEqual([]);
  });

  it('draws the destination uniformly from every valid tile', () => {
    const tiles = new Set<string>();
    for (let s = 0; s < 200; s++) {
      const world = openWorld();
      addColony(world, 1, [[64, 64]]);
      setPilesForTest(world, [pile(3, 3)]);
      ensureFoodNearEachColony(world, new Rng(s * 7919 + 1));
      const [x, y] = tileOf(world, pilesForTest(world)[0]!.foodPileId);
      tiles.add(`${x},${y}`);
      const d = Math.abs(x - 64) + Math.abs(y - 64);
      expect(d).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
      expect(d).toBeLessThanOrEqual(R);
    }
    // 1,188 valid tiles (radius 8..25 round the entrance): 200 draws land on many.
    expect(tiles.size).toBeGreaterThan(150);
  });

  it('makes a new pile when every natural pile already serves a colony', () => {
    const world = openWorld();
    addColony(world, 1, [[20, 20]]);
    addColony(world, 2, [[100, 20]]);
    addColony(world, 3, [[64, 110]]);
    const piles = [pile(20, 40), pile(100, 40)];
    setPilesForTest(world, piles);
    const id = world.nextEntityId;
    const rng = new Rng(21);
    ensureFoodNearEachColony(world, rng);
    expect(pileCount(world)).toBe(3);
    const made = pilesForTest(world)[2]!;
    expect(made.foodPileId).toBe(id);
    expect(world.nextEntityId).toBe(id + 1);
    expect(made.pickupsInitial).toBeGreaterThanOrEqual(MIN);
    expect(made.pickupsInitial).toBeLessThanOrEqual(FOOD_PILE_INITIAL_PICKUPS_MAX);
    expect(servedBy(world, made.tileX, made.tileY)).toBe(3);
    expect(pilesForTest(world).slice(0, 2)).toEqual(piles);
    expect(pileIsCorpse(world, pileSlotAt(world, 2))).toBe(false);
    assertFoodStoreInvariants(world);
  });

  it('makes no new pile when the store is at the hard cap, and draws nothing', () => {
    const world = openWorld();
    addColony(world, 1, [[64, 64]]);
    // FOOD_PILE_HARD_CAP small piles far from home: none to move, no room for another.
    const piles: TestPile[] = [];
    for (let i = 0; i < FOOD_PILE_HARD_CAP; i++) piles.push(pile(i * 2, i < 64 ? 0 : 127, 5));
    setPilesForTest(world, piles);
    const rng = new Rng(19);
    const ids = world.nextEntityId;
    ensureFoodNearEachColony(world, rng);
    expect(rng.getState()).toBe(19);
    expect(pileCount(world)).toBe(FOOD_PILE_HARD_CAP);
    expect(world.nextEntityId).toBe(ids);
    // One under the cap, the pile is made.
    const w2 = openWorld();
    addColony(w2, 1, [[64, 64]]);
    setPilesForTest(w2, piles.slice(1));
    ensureFoodNearEachColony(w2, new Rng(19));
    expect(pileCount(w2)).toBe(FOOD_PILE_HARD_CAP);
    expect(ownPickups(w2, 1)).toBeGreaterThanOrEqual(MIN);
  });

  it('makes no new pile when the entity ids have run out, and draws nothing', () => {
    for (const [next, makes] of [
      [MAX_ENTITIES, false],
      [MAX_ENTITIES - 1, true],
    ] as const) {
      const world = openWorld();
      addColony(world, 1, [[64, 64]]);
      setPilesForTest(world, [pile(3, 3, MIN - 1)]); // nothing big enough to move
      world.nextEntityId = next;
      const rng = new Rng(29);
      ensureFoodNearEachColony(world, rng);
      expect(rng.getState() !== 29).toBe(makes);
      expect(pileCount(world)).toBe(makes ? 2 : 1);
      expect(world.nextEntityId).toBe(makes ? MAX_ENTITIES : next);
      if (makes) expect(pileFoodId(world, pileSlotAt(world, 1))).toBe(MAX_ENTITIES - 1);
    }
  });

  it('leaves a colony with nowhere to put a pile as it is, with no draw', () => {
    const world = openWorld();
    // Everything blocked but a 7x7 pocket round the entrance: no tile 8 away.
    world.bakedSurfaceEffect.fill(SurfaceMovementEffect.HardBlock);
    for (let y = 61; y <= 67; y++) {
      for (let x = 61; x <= 67; x++) world.bakedSurfaceEffect[y * SURFACE_GRID_WIDTH + x] = 0;
    }
    addColony(world, 1, [[64, 64]]);
    setPilesForTest(world, []);
    const rng = new Rng(13);
    ensureFoodNearEachColony(world, rng);
    expect(rng.getState()).toBe(13);
    expect(pileCount(world)).toBe(0);
  });

  it('serves the colonies in ascending colony id, whatever order they were added in', () => {
    const world = openWorld();
    addColony(world, 2, [[100, 64]]);
    addColony(world, 1, [[28, 64]]);
    const only = pile(64, 64); // 36 from each: free and contested
    setPilesForTest(world, [only]);
    ensureFoodNearEachColony(world, new Rng(17));
    // Colony 1 goes first and gets the one free pile; colony 2 gets a new one.
    expect(servedBy(world, ...tileOf(world, only.foodPileId))).toBe(1);
    expect(pileCount(world)).toBe(2);
    expect(
      servedBy(
        world,
        pileTileX(world, pileSlotAt(world, 1)),
        pileTileY(world, pileSlotAt(world, 1)),
      ),
    ).toBe(2);
    expect(pileFoodId(world, pileSlotAt(world, 0))).toBe(only.foodPileId);
  });
});
