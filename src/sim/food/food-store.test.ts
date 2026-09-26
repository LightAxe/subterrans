// food-store.test.ts — #290 PR 2 (V50): the located food store's capacity
// derivation and slot mechanics (allocation, pile order, the tile index, copy),
// and the defensive "store full" refusals. As the store's own unit test it reads
// store columns directly where the facade has no reader (slot kinds); everything
// else goes through the facade or the test utils.

import { describe, it, expect } from 'vitest';
import {
  CHAMBER_FOOD_HEIGHT,
  CHAMBER_FOOD_WIDTH,
  FOOD_CHAMBER_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_INITIAL_PICKUPS_MIN,
  FOOD_STORAGE_CHAMBERS_PER_COLONY_BOUND,
  FOOD_STORE_CAPACITY,
  MAX_COLONIES,
  PLAYER_COLONY_ID,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  UNDERGROUND_CEILING_ROW_Y,
  UNDERGROUND_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
} from '../constants.js';
import { CHAMBER_DIMENSIONS } from '../colony/chamber.js';
import { ChamberType } from '../enums.js';
import { createScenario } from '../scenario.js';
import { allocateEntityId, copyWorldState, createWorldState, type WorldState } from '../types.js';
import { tick } from '../tick.js';
import { checkPendingChambers } from '../colony/colony-system.js';
import { ugSet, UndergroundTileState } from '../terrain.js';
import type { ColonyId } from '../colony/colony-store.js';
import {
  chamberStock,
  colonyPoolFood,
  createColonyPool,
  depositIntoChamber,
  depositIntoPool,
  drainPile,
  foodStoreHasFreeSlot,
  pileAtTile,
  pileCount,
  pileFoodId,
  pileSlotAt,
  spawnPile,
  topUpOrSpawnCorpsePile,
  withdrawFood,
} from './food-api.js';
import { createFoodStore, findFreeFoodSlot, FoodKind } from './food-store.js';
import {
  addChamberForTest,
  assertFoodStoreInvariants,
  clearPilesForTest,
  pilesForTest,
  setColonyFoodForTest,
} from './food-test-utils.js';

const P = FOOD_PICKUP_AMOUNT;
const PC = PLAYER_COLONY_ID as ColonyId;

/** Occupy every free slot of the store with piles-that-are-not-piles (test filler). */
function fillStore(world: WorldState): void {
  const store = world.food;
  for (let s = 0; s < store.kind.length; s++) {
    if (store.kind[s] === FoodKind.None) store.kind[s] = FoodKind.Stock; // filler, unlinked
  }
}

describe('#290 PR 2 — FOOD_STORE_CAPACITY is the physical limit (owner decision D12)', () => {
  it('re-derives the per-colony FoodStorage bound from the grid and footprint constants', () => {
    // Every FoodStorage footprint is disjoint from the colony's other chambers
    // (PlaceChamber's overlap gates) and below the ceiling row.
    expect(UNDERGROUND_CEILING_ROW_Y).toBe(0);
    const rows = UNDERGROUND_GRID_HEIGHT - 1;
    const footprint = CHAMBER_FOOD_WIDTH * CHAMBER_FOOD_HEIGHT;
    // bound = ⌊W × rows / footprint⌋, stated without `/` (sim lint).
    const area = UNDERGROUND_GRID_WIDTH * rows;
    const bound = FOOD_STORAGE_CHAMBERS_PER_COLONY_BOUND;
    expect(bound * footprint).toBeLessThanOrEqual(area);
    expect((bound + 1) * footprint).toBeGreaterThan(area);
    // The canonical footprint is the one the constants name.
    expect(CHAMBER_DIMENSIONS[ChamberType.FoodStorage]).toEqual({
      width: CHAMBER_FOOD_WIDTH,
      height: CHAMBER_FOOD_HEIGHT,
    });
  });

  it('is piles + one pool and the chamber bound per colony (60 + 2 × 673 = 1406)', () => {
    expect(FOOD_STORE_CAPACITY).toBe(
      FOOD_PILE_HARD_CAP + MAX_COLONIES * (1 + FOOD_STORAGE_CHAMBERS_PER_COLONY_BOUND),
    );
    expect(FOOD_STORE_CAPACITY).toBe(1406);
    // The tile index stores slot + 1 in an Int16Array.
    expect(FOOD_STORE_CAPACITY).toBeLessThan(0x7fff);
    expect(createFoodStore().kind.length).toBe(FOOD_STORE_CAPACITY);
  });

  it('a scenario uses one pool per colony and has room for every chamber it could dig', () => {
    const w = createScenario(3);
    expect(Object.keys(w.colonies).length).toBeLessThanOrEqual(MAX_COLONIES);
    let pools = 0;
    let used = 0;
    for (let s = 0; s < w.food.kind.length; s++) {
      if (w.food.kind[s] === FoodKind.Pool) pools++;
      if (w.food.kind[s] !== FoodKind.None) used++;
    }
    expect(pools).toBe(Object.keys(w.colonies).length);
    const worstCase = FOOD_PILE_HARD_CAP + pools * (1 + FOOD_STORAGE_CHAMBERS_PER_COLONY_BOUND);
    expect(worstCase).toBeLessThanOrEqual(FOOD_STORE_CAPACITY);
    expect(used).toBe(pileCount(w) + pools);
  });
});

describe('#290 PR 2 — slots', () => {
  it('allocates the lowest free slot and recycles a freed pile slot', () => {
    const w = createScenario(9);
    clearPilesForTest(w);
    // Pools keep their slots; piles take the lowest free ones in turn.
    const firstFree = findFreeFoodSlot(w.food);
    const a = spawnPile(w, 7001, 10, 10, 20 * P, 0);
    const b = spawnPile(w, 7002, 12, 10, 20 * P, 0);
    const c = spawnPile(w, 7003, 14, 10, 20 * P, 0);
    expect(a).toBe(firstFree);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    drainPile(w, b, 1000 * P); // empties and frees b
    expect(findFreeFoodSlot(w.food)).toBe(b);
    const d = spawnPile(w, 7004, 16, 10, 20 * P, 0);
    expect(d).toBe(b); // reused…
    // …but creation order puts the new pile last.
    expect([0, 1, 2].map((o) => pileFoodId(w, pileSlotAt(w, o)))).toEqual([7001, 7003, 7004]);
  });

  it('keeps the tile index in step with spawns and removals', () => {
    const w = createScenario(9);
    clearPilesForTest(w);
    const a = spawnPile(w, 1, 20, 20, 5 * P, 0);
    expect(pileAtTile(w, 20, 20)).toBe(a);
    expect(pileAtTile(w, 21, 20)).toBe(-1);
    drainPile(w, a, 5 * P);
    expect(pileAtTile(w, 20, 20)).toBe(-1);
    // Off-map tiles read "no pile", never alias into another row.
    expect(pileAtTile(w, -1, 0)).toBe(-1);
    expect(pileAtTile(w, 128, 0)).toBe(-1);
    expect(pileAtTile(w, 0, 128)).toBe(-1);
  });

  it('copyWorldState copies the store (and its tile index) into an independent world', () => {
    const src = createScenario(21);
    for (let t = 0; t < 50; t++) tick(src, []);
    const dst = createWorldState(1);
    copyWorldState(src, dst);
    expect(pilesForTest(dst)).toEqual(pilesForTest(src));
    for (let o = 0; o < pileCount(dst); o++) {
      const s = pileSlotAt(dst, o);
      expect(pileAtTile(dst, dst.food.tileX[s]!, dst.food.tileY[s]!)).toBe(s);
    }
    const pc = src.colonies[PC]!;
    expect(colonyPoolFood(dst, dst.colonies[PC]!)).toBe(colonyPoolFood(src, pc));
    // Independent: draining src leaves dst untouched.
    const before = pilesForTest(dst);
    drainPile(src, pileSlotAt(src, 0), 1000 * P);
    expect(pilesForTest(dst)).toEqual(before);
  });
});

describe('#290 PR 2 — a full store (unreachable in a loadable world) refuses, never corrupts', () => {
  it('spawnPile / createColonyPool refuse; foodStoreHasFreeSlot reports it', () => {
    const w = createScenario(5);
    clearPilesForTest(w);
    fillStore(w);
    expect(foodStoreHasFreeSlot(w)).toBe(false);
    expect(spawnPile(w, 9000, 30, 30, P, 0)).toBe(-1);
    expect(pileCount(w)).toBe(0);
    const colony = w.colonies[PC]!;
    const before = colony.poolSlot;
    expect(createColonyPool(w, colony, 0, 0)).toBe(false);
    expect(colony.poolSlot).toBe(before);
  });

  it('PlaceChamber refuses a FoodStorage chamber, and a completed one stays pending', () => {
    const w = createScenario(5);
    const colony = w.colonies[PC]!;
    const ug = w.undergroundGrids[PC]!;
    const ex = colony.entrances[0]!.surfaceTileX;
    // Pre-open a footprint next to the entrance shaft so placement is reachable
    // and promotion is immediate.
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 4; dx++) ugSet(ug, ex + 1 + dx, 1 + dy, UndergroundTileState.Open);
    }
    fillStore(w);
    tick(w, [
      {
        type: 'PlaceChamber',
        colonyId: PC,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: ex + 1,
        anchorTileY: 1,
        issuedAtTick: 0,
      },
    ]);
    expect(Object.keys(w.pendingChambers)).toHaveLength(0);
    // A pending FoodStorage chamber that completes while the store is full stays pending.
    w.pendingChambers[`${PC}:${ex + 1}:1`] = {
      colonyId: PC,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: ex + 1,
      anchorTileY: 1,
      width: 4,
      height: 3,
    };
    const idBefore = w.nextEntityId;
    checkPendingChambers(w);
    expect(Object.keys(w.pendingChambers)).toHaveLength(1);
    expect(colony.chambers.filter((c) => c.chamberType === ChamberType.FoodStorage)).toHaveLength(
      0,
    );
    expect(w.nextEntityId).toBe(idBefore); // no id burnt
  });

  it('with room, the same PlaceChamber promotes to a chamber with a linked, empty stock', () => {
    const w = createScenario(5);
    const colony = w.colonies[PC]!;
    const ug = w.undergroundGrids[PC]!;
    const ex = colony.entrances[0]!.surfaceTileX;
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 4; dx++) ugSet(ug, ex + 1 + dx, 1 + dy, UndergroundTileState.Open);
    }
    tick(w, [
      {
        type: 'PlaceChamber',
        colonyId: PC,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: ex + 1,
        anchorTileY: 1,
        issuedAtTick: 0,
      },
    ]);
    const fs = colony.chambers.find((c) => c.chamberType === ChamberType.FoodStorage)!;
    expect(fs).toBeDefined();
    expect(fs.foodSlot).toBeGreaterThanOrEqual(0);
    expect(w.food.kind[fs.foodSlot]).toBe(FoodKind.Stock);
    expect(w.food.foodId[fs.foodSlot]).toBe(fs.chamberId);
    expect(chamberStock(w, fs)).toBe(0);
    setColonyFoodForTest(w, colony, 0, [123]);
    expect(chamberStock(w, fs)).toBe(123);
  });
});

describe('#290 PR 2 — store invariants hold under a seeded facade fuzz (plan §2.1)', () => {
  // A seeded mix of every facade mutation, interleaved with real ticks, checking
  // `assertFoodStoreInvariants` after every step. Deterministic (xorshift32).
  function fuzz(seed: number, steps: number): void {
    const world = createScenario(seed);
    let s = seed | 1;
    const rand = (n: number): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) % n;
    };
    const colonies = Object.values(world.colonies);
    let nextChamberX = 20;
    for (let step = 0; step < steps; step++) {
      const colony = colonies[rand(colonies.length)]!;
      switch (rand(9)) {
        case 0: {
          const x = rand(SURFACE_GRID_WIDTH);
          const y = rand(SURFACE_GRID_HEIGHT);
          if (pileAtTile(world, x, y) < 0) {
            const pickups =
              FOOD_PILE_INITIAL_PICKUPS_MIN +
              rand(FOOD_PILE_INITIAL_PICKUPS_MAX - FOOD_PILE_INITIAL_PICKUPS_MIN + 1);
            spawnPile(world, allocateEntityId(world), x, y, pickups * P, 0);
          }
          break;
        }
        case 1:
          if (pileCount(world) > 0) {
            drainPile(world, pileSlotAt(world, rand(pileCount(world))), (1 + rand(4)) * P);
          }
          break;
        case 2:
          topUpOrSpawnCorpsePile(
            world,
            rand(SURFACE_GRID_WIDTH),
            rand(SURFACE_GRID_HEIGHT),
            (1 + rand(6)) * P,
          );
          break;
        case 3:
          depositIntoPool(world, colony, rand(4 * P));
          break;
        case 4: {
          const stores = colony.chambers.filter((c) => c.chamberType === ChamberType.FoodStorage);
          if (stores.length > 0)
            depositIntoChamber(world, colony, stores[rand(stores.length)]!, rand(8 * P));
          break;
        }
        case 5:
          withdrawFood(world, colony, 1 + rand(6 * P));
          break;
        case 6:
          if (nextChamberX < 180 && foodStoreHasFreeSlot(world)) {
            addChamberForTest(world, colony, {
              chamberId: allocateEntityId(world),
              chamberType: rand(2) === 0 ? ChamberType.FoodStorage : ChamberType.Nursery,
              posX: nextChamberX << 8,
              posY: 40 << 8,
              width: CHAMBER_FOOD_WIDTH,
              height: CHAMBER_FOOD_HEIGHT,
            });
            nextChamberX += CHAMBER_FOOD_WIDTH;
          }
          break;
        default:
          tick(world, []);
      }
      assertFoodStoreInvariants(world);
    }
  }

  it.each([1, 7, 42, 1337])('seed %i: 3000 steps', (seed) => {
    fuzz(seed, 3000);
  });

  it('the checker catches a broken pile index, pool link and stock link', () => {
    const world = createScenario(3);
    assertFoodStoreInvariants(world);
    const a = createScenario(3);
    a.food.surfacePileAt[
      a.food.tileY[pileSlotAt(a, 0)]! * SURFACE_GRID_WIDTH + a.food.tileX[pileSlotAt(a, 0)]!
    ] = 0;
    expect(() => assertFoodStoreInvariants(a)).toThrow(/surfacePileAt/);
    const b = createScenario(3);
    b.colonies[PC]!.poolSlot = -1;
    expect(() => assertFoodStoreInvariants(b)).toThrow(/poolSlot/);
    const c = createScenario(3);
    const ch = addChamberForTest(c, c.colonies[PC]!, {
      chamberId: allocateEntityId(c),
      chamberType: ChamberType.FoodStorage,
      posX: 20 << 8,
      posY: 40 << 8,
      width: CHAMBER_FOOD_WIDTH,
      height: CHAMBER_FOOD_HEIGHT,
    });
    assertFoodStoreInvariants(c);
    c.food.amountFp[ch.foodSlot] = FOOD_CHAMBER_CAPACITY + 1;
    expect(() => assertFoodStoreInvariants(c)).toThrow(/cap/);
    c.food.amountFp[ch.foodSlot] = 0;
    ch.foodSlot = -1;
    expect(() => assertFoodStoreInvariants(c)).toThrow(/foodSlot/);
  });
});
