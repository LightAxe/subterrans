// food-api.test.ts — the food facade (#290) over the located food store.
//
// Every facade function is exercised here against the store it wraps (piles, the
// entrance pool, FoodStorage chamber stock). PR 1 wrote these assertions against
// the old storage; PR 2 (V50) re-implemented the facade over `world.food` and
// re-runs them (adapted only where they named array indices, which are now
// stable store slots). The store-level invariants (slot allocation, pile order,
// the tile index) are pinned in food-store.test.ts. The deeper behaviour suites
// (colony-system, forager-backpressure, corpse-food, food-system, ant-foraging)
// keep covering the callers.

import { describe, it, expect } from 'vitest';
import {
  FOOD_FLAG_CORPSE,
  chamberStock,
  clampColonyFoodStores,
  colonyFoodCapacity,
  colonyFoodTotal,
  colonyForageBackpressure,
  colonyHasNoDepositTarget,
  colonyPoolFood,
  createChamberStock,
  depositIntoChamber,
  depositIntoPool,
  drainPile,
  forEachPile,
  freeChamberStock,
  isFoodChamberDepositable,
  naturalPileCount,
  pileAmountFp,
  pileAtTile,
  pileCount,
  pileFoodId,
  pileInitialFp,
  pileIsCorpse,
  pileRender,
  pileSlotAt,
  pileSlotById,
  pileTileX,
  pileTileY,
  recordFoodPileDepletion,
  spawnPile,
  topUpOrSpawnCorpsePile,
  withdrawFood,
  type PileView,
} from './food-api.js';
import {
  addChamberForTest,
  clearPilesForTest,
  setColonyFoodForTest,
  type TestChamber,
} from './food-test-utils.js';
import {
  createWorldState,
  SIM_VERSION_V36_RISK_AWARE_FORAGING,
  SIM_VERSION_V37_CORPSE_FOOD,
} from '../types.js';
import type { WorldState } from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import type { ChamberRecord, ColonyId, ColonyRecord } from '../colony/colony-store.js';
import { ChamberType } from '../enums.js';
import { createScenario } from '../scenario.js';
import { isSurfaceTileInComponent } from '../surface-features.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_SOFT_CEILING,
  MAX_ENTITIES,
  STARTING_FOOD,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
} from '../constants.js';

const CID = 1 as ColonyId;
const P = FOOD_PICKUP_AMOUNT;

/** A chamber to add to a colony: its record (no stock link yet) and its stock. */
interface ChamberSpec {
  rec: TestChamber;
  stock: number;
}

function chamber(id: number, type: ChamberType, stock: number): ChamberSpec {
  return {
    rec: { chamberId: id, chamberType: type, posX: 0, posY: 0, width: 4, height: 3 },
    stock,
  };
}

/**
 * A bare world with one colony (pool `poolFp`) and the given chambers, added as
 * `checkPendingChambers` would (a FoodStorage chamber gets its stock). `chs` are
 * the stored records, in order.
 */
function colonyWorld(
  poolFp: number,
  specs: ChamberSpec[] = [],
): { world: WorldState; colony: ColonyRecord; chs: ChamberRecord[] } {
  const world = createWorldState(7);
  const colony = createColonyRecord(CID, 0);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  colony.foodFlowFieldDirty = false;
  colony.broodFieldDirty = false;
  world.colonies[CID] = colony;
  setColonyFoodForTest(world, colony, poolFp);
  const chs = specs.map((c) => addChamberForTest(world, colony, c.rec, c.stock));
  return { world, colony, chs };
}

/** A lone chamber in a fresh colony world (for the per-chamber readers). */
function lone(spec: ChamberSpec): { world: WorldState; ch: ChamberRecord } {
  const { world, chs } = colonyWorld(0, [spec]);
  return { world, ch: chs[0]! };
}

/** A scenario world with its seeded piles removed, plus `n` walkable surface tiles. */
function emptyPileWorld(n: number): { world: WorldState; tiles: Array<{ x: number; y: number }> } {
  const world = createScenario(4242);
  clearPilesForTest(world);
  const tiles: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SURFACE_GRID_HEIGHT && tiles.length < n; y += 3) {
    for (let x = 0; x < SURFACE_GRID_WIDTH && tiles.length < n; x += 3) {
      if (isSurfaceTileInComponent(world, x, y)) tiles.push({ x, y });
    }
  }
  return { world, tiles };
}

// ---------------------------------------------------------------------------
// Totals and capacity
// ---------------------------------------------------------------------------

describe('food-api — totals and capacity', () => {
  it('STARTING_FOOD fits in the entrance pool (createScenario seeds it via depositIntoPool)', () => {
    // A retune above the pool cap would be silently clamped by depositIntoPool.
    expect(STARTING_FOOD).toBeLessThanOrEqual(BASE_FOOD_STORAGE_CAPACITY);
    const world = createScenario(5);
    for (const colony of Object.values(world.colonies)) {
      expect(colonyPoolFood(world, colony)).toBe(STARTING_FOOD);
    }
  });

  it('colonyFoodTotal sums the pool and FoodStorage stock only', () => {
    const { world, colony } = colonyWorld(100, [
      chamber(1, ChamberType.FoodStorage, 200),
      chamber(2, ChamberType.Queen, 9999), // never food; ignored
      chamber(3, ChamberType.FoodStorage, 50),
    ]);
    expect(colonyFoodTotal(world, colony)).toBe(350);
    expect(colonyPoolFood(world, colony)).toBe(100);
  });

  it('chamberStock reads FoodStorage stock and 0 for any other chamber type', () => {
    const a = lone(chamber(1, ChamberType.FoodStorage, 777));
    expect(chamberStock(a.world, a.ch)).toBe(777);
    const b = lone(chamber(2, ChamberType.Nursery, 777));
    expect(b.ch.foodSlot).toBe(-1); // only FoodStorage chambers get a stock
    expect(chamberStock(b.world, b.ch)).toBe(0);
  });

  it('colonyFoodCapacity = BASE + N × chamber capacity over completed FoodStorage chambers', () => {
    const { colony } = colonyWorld(0, [
      chamber(1, ChamberType.FoodStorage, 0),
      chamber(2, ChamberType.Queen, 0),
      chamber(3, ChamberType.FoodStorage, 0),
    ]);
    expect(colonyFoodCapacity(colony)).toBe(BASE_FOOD_STORAGE_CAPACITY + 2 * FOOD_CHAMBER_CAPACITY);
  });

  it('isFoodChamberDepositable honours the hysteresis band and chamber type', () => {
    const edge = FOOD_CHAMBER_CAPACITY - FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP;
    const a = lone(chamber(1, ChamberType.FoodStorage, edge));
    expect(isFoodChamberDepositable(a.world, a.ch)).toBe(true);
    const b = lone(chamber(1, ChamberType.FoodStorage, edge + 1));
    expect(isFoodChamberDepositable(b.world, b.ch)).toBe(false);
    const c = lone(chamber(2, ChamberType.Nursery, 0));
    expect(isFoodChamberDepositable(c.world, c.ch)).toBe(false);
  });

  it('colonyHasNoDepositTarget / colonyForageBackpressure', () => {
    // Pool below cap → a target exists.
    const a = colonyWorld(BASE_FOOD_STORAGE_CAPACITY - 1);
    expect(colonyHasNoDepositTarget(a.world, a.colony)).toBe(false);
    expect(colonyForageBackpressure(a.world, a.colony)).toBe(false);
    // Pool at cap, chamberless → no target, but no backpressure (chamber required).
    const b = colonyWorld(BASE_FOOD_STORAGE_CAPACITY);
    expect(colonyHasNoDepositTarget(b.world, b.colony)).toBe(true);
    expect(colonyForageBackpressure(b.world, b.colony)).toBe(false);
    // Pool at cap and a saturated FoodStorage chamber → backpressure.
    const c = colonyWorld(BASE_FOOD_STORAGE_CAPACITY, [
      chamber(1, ChamberType.FoodStorage, FOOD_CHAMBER_CAPACITY),
    ]);
    expect(colonyHasNoDepositTarget(c.world, c.colony)).toBe(true);
    expect(colonyForageBackpressure(c.world, c.colony)).toBe(true);
    // Pool at cap but a depositable chamber → a target exists.
    const d = colonyWorld(BASE_FOOD_STORAGE_CAPACITY, [chamber(1, ChamberType.FoodStorage, 0)]);
    expect(colonyHasNoDepositTarget(d.world, d.colony)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moving food
// ---------------------------------------------------------------------------

describe('food-api — withdraw / deposit / clamp', () => {
  it('withdrawFood is all-or-nothing', () => {
    const { world, colony } = colonyWorld(10, [chamber(1, ChamberType.FoodStorage, 5)]);
    expect(withdrawFood(world, colony, 16)).toBe(false);
    expect(colonyFoodTotal(world, colony)).toBe(15);
    expect(withdrawFood(world, colony, 15)).toBe(true);
    expect(colonyFoodTotal(world, colony)).toBe(0);
  });

  it('withdrawFood drains the fullest chamber first (lowest index on ties), then the pool', () => {
    const { world, colony, chs } = colonyWorld(1000, [
      chamber(1, ChamberType.FoodStorage, 300),
      chamber(2, ChamberType.FoodStorage, 500),
      chamber(3, ChamberType.FoodStorage, 500),
    ]);
    expect(withdrawFood(world, colony, 100)).toBe(true);
    expect(chs.map((c) => chamberStock(world, c))).toEqual([300, 400, 500]);
    // A draw spanning chambers: 500 (#3) then 400 (#2) then 300 (#1) then pool.
    expect(withdrawFood(world, colony, 1300)).toBe(true);
    expect(chs.map((c) => chamberStock(world, c))).toEqual([0, 0, 0]);
    expect(colonyPoolFood(world, colony)).toBe(900);
  });

  it('withdrawFood marks the food field dirty only on a saturated→depositable crossing', () => {
    const { world, colony } = colonyWorld(0, [
      chamber(1, ChamberType.FoodStorage, FOOD_CHAMBER_CAPACITY),
    ]);
    withdrawFood(world, colony, 1); // still saturated
    expect(colony.foodFlowFieldDirty).toBe(false);
    withdrawFood(world, colony, FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP); // crosses
    expect(colony.foodFlowFieldDirty).toBe(true);
  });

  it('depositIntoChamber caps at free space and flags dirty when it saturates', () => {
    const { world, colony, chs } = colonyWorld(0, [
      chamber(1, ChamberType.FoodStorage, FOOD_CHAMBER_CAPACITY - 1000),
    ]);
    const ch = chs[0]!;
    expect(depositIntoChamber(world, colony, ch, 100)).toBe(100);
    expect(colony.foodFlowFieldDirty).toBe(false);
    expect(depositIntoChamber(world, colony, ch, 5000)).toBe(900);
    expect(chamberStock(world, ch)).toBe(FOOD_CHAMBER_CAPACITY);
    expect(colony.foodFlowFieldDirty).toBe(true);
  });

  it('depositIntoPool caps at BASE and never accepts a negative amount', () => {
    const { world, colony } = colonyWorld(BASE_FOOD_STORAGE_CAPACITY - 10);
    expect(depositIntoPool(world, colony, 100)).toBe(10);
    expect(colonyPoolFood(world, colony)).toBe(BASE_FOOD_STORAGE_CAPACITY);
    setColonyFoodForTest(world, colony, BASE_FOOD_STORAGE_CAPACITY + 50); // over cap (tamper)
    expect(depositIntoPool(world, colony, 100)).toBe(0);
    expect(colonyPoolFood(world, colony)).toBe(BASE_FOOD_STORAGE_CAPACITY + 50);
  });

  it('clampColonyFoodStores clamps pool and FoodStorage stock, never other chambers', () => {
    const { world, colony } = colonyWorld(-5, [
      chamber(1, ChamberType.FoodStorage, 0),
      chamber(2, ChamberType.Queen, 0),
    ]);
    setColonyFoodForTest(world, colony, BASE_FOOD_STORAGE_CAPACITY + 1, [
      FOOD_CHAMBER_CAPACITY + 7,
    ]);
    clampColonyFoodStores(world, colony);
    expect(colonyPoolFood(world, colony)).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(chamberStock(world, colony.chambers[0]!)).toBe(FOOD_CHAMBER_CAPACITY);
    setColonyFoodForTest(world, colony, -3, [-9]);
    clampColonyFoodStores(world, colony);
    expect(colonyPoolFood(world, colony)).toBe(0);
    expect(chamberStock(world, colony.chambers[0]!)).toBe(0);
  });

  it('createChamberStock links an empty stock to a FoodStorage chamber only; freeChamberStock unlinks it', () => {
    const { world, colony } = colonyWorld(0);
    const ch: ChamberRecord = {
      chamberId: 77,
      chamberType: ChamberType.FoodStorage,
      foodSlot: -1,
      posX: 5 << 8,
      posY: 6 << 8,
      width: 4,
      height: 3,
    };
    colony.chambers.push(ch);
    expect(createChamberStock(world, colony, ch)).toBe(true);
    expect(ch.foodSlot).toBeGreaterThanOrEqual(0);
    expect(ch.foodSlot).not.toBe(colony.poolSlot);
    expect(chamberStock(world, ch)).toBe(0);
    expect(isFoodChamberDepositable(world, ch)).toBe(true);
    setColonyFoodForTest(world, colony, 0, [4000]);
    expect(colonyFoodTotal(world, colony)).toBe(4000);
    freeChamberStock(world, colony, ch);
    expect(ch.foodSlot).toBe(-1);
    expect(chamberStock(world, ch)).toBe(0);
    expect(colonyFoodTotal(world, colony)).toBe(0);
    // A non-FoodStorage chamber gets no stock.
    const q: ChamberRecord = { ...ch, chamberId: 78, chamberType: ChamberType.Queen, foodSlot: 5 };
    expect(createChamberStock(world, colony, q)).toBe(true);
    expect(q.foodSlot).toBe(-1);
  });

  it('a hand-built colony with no pool reads 0 and its pool accepts nothing', () => {
    const world = createWorldState(7);
    const colony = createColonyRecord(CID, 0);
    colony.entrances = [];
    world.colonies[CID] = colony;
    expect(colony.poolSlot).toBe(-1);
    expect(colonyPoolFood(world, colony)).toBe(0);
    expect(depositIntoPool(world, colony, 100)).toBe(0);
    expect(withdrawFood(world, colony, 1)).toBe(false);
    expect(colonyHasNoDepositTarget(world, colony)).toBe(true);
    clampColonyFoodStores(world, colony); // no throw
  });

  it('setColonyFoodForTest writes pool and the i-th FoodStorage chamber in order', () => {
    const { world, colony, chs } = colonyWorld(0, [
      chamber(1, ChamberType.FoodStorage, 0),
      chamber(2, ChamberType.Nursery, 0),
      chamber(3, ChamberType.FoodStorage, 0),
      chamber(4, ChamberType.FoodStorage, 11),
    ]);
    setColonyFoodForTest(world, colony, 1, [2, 3]);
    expect(colonyPoolFood(world, colony)).toBe(1);
    expect(chs.map((c) => chamberStock(world, c))).toEqual([2, 0, 3, 11]);
  });
});

// ---------------------------------------------------------------------------
// Piles
// ---------------------------------------------------------------------------

describe('food-api — piles', () => {
  it('spawnPile appends in order; readers report fp and the corpse flag', () => {
    const { world, tiles } = emptyPileWorld(2);
    const a = spawnPile(world, 500, tiles[0]!.x, tiles[0]!.y, 40 * P, 0);
    const b = spawnPile(world, 501, tiles[1]!.x, tiles[1]!.y, 3 * P, FOOD_FLAG_CORPSE);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).not.toBe(a);
    expect(pileCount(world)).toBe(2);
    expect(pileSlotAt(world, 0)).toBe(a);
    expect(pileSlotAt(world, 1)).toBe(b);
    expect(pileFoodId(world, a)).toBe(500);
    expect([pileTileX(world, b), pileTileY(world, b)]).toEqual([tiles[1]!.x, tiles[1]!.y]);
    expect(pileAmountFp(world, a)).toBe(40 * P);
    expect(pileInitialFp(world, a)).toBe(40 * P);
    expect(pileIsCorpse(world, a)).toBe(false);
    expect(pileIsCorpse(world, b)).toBe(true);
    expect(naturalPileCount(world)).toBe(1);
  });

  it('spawnPile refuses at the hard cap', () => {
    const { world } = emptyPileWorld(0);
    for (let i = 0; i < FOOD_PILE_HARD_CAP; i++) {
      expect(spawnPile(world, 1000 + i, i, 0, P, 0)).toBeGreaterThanOrEqual(0);
    }
    expect(spawnPile(world, 9999, 0, 1, P, 0)).toBe(-1);
    expect(pileCount(world)).toBe(FOOD_PILE_HARD_CAP);
  });

  it('pileAtTile / pileSlotById find a pile or return -1', () => {
    const { world, tiles } = emptyPileWorld(2);
    spawnPile(world, 70, tiles[0]!.x, tiles[0]!.y, P, 0);
    const s = spawnPile(world, 71, tiles[1]!.x, tiles[1]!.y, P, 0);
    expect(pileAtTile(world, tiles[1]!.x, tiles[1]!.y)).toBe(s);
    expect(pileSlotById(world, 71)).toBe(s);
    expect(pileAtTile(world, -1, -1)).toBe(-1);
    expect(pileSlotById(world, 12345)).toBe(-1);
  });

  it('drainPile drains whole pickups and removes an emptied pile, keeping creation order', () => {
    const { world, tiles } = emptyPileWorld(4);
    const slots: number[] = [];
    for (let i = 0; i < 4; i++) {
      slots.push(spawnPile(world, 80 + i, tiles[i]!.x, tiles[i]!.y, 2 * P, 0));
    }
    world.colonies[1]!.priorityFoodPileId = 81;
    expect(drainPile(world, slots[1]!, P)).toBe(false);
    expect(pileAmountFp(world, slots[1]!)).toBe(P);
    const before = world.recentlyDepletedFood.length;
    expect(drainPile(world, slots[1]!, P)).toBe(true);
    expect(pileAtTile(world, tiles[1]!.x, tiles[1]!.y)).toBe(-1); // its tile is free again
    // Order-preserving removal: a swap-pop would give [80, 83, 82].
    const order = (): number[] => {
      const ids: number[] = [];
      for (let o = 0; o < pileCount(world); o++) ids.push(pileFoodId(world, pileSlotAt(world, o)));
      return ids;
    };
    expect(order()).toEqual([80, 82, 83]);
    expect(world.recentlyDepletedFood.length).toBe(before + 1);
    expect(world.colonies[1]!.priorityFoodPileId).toBeNull();
    // Slots are stable: the survivors kept theirs.
    expect(pileSlotById(world, 82)).toBe(slots[2]);
    // Over-drain clamps at 0 and removes.
    expect(drainPile(world, slots[0]!, 10 * P)).toBe(true);
    expect(order()).toEqual([82, 83]);
  });

  it('recordFoodPileDepletion: V37+ corpse piles skip the barren cooldown; the log is capped', () => {
    const { world, tiles } = emptyPileWorld(2);
    world.simVersion = SIM_VERSION_V37_CORPSE_FOOD;
    const s = spawnPile(world, 90, tiles[0]!.x, tiles[0]!.y, P, FOOD_FLAG_CORPSE);
    const n = world.recentlyDepletedFood.length;
    recordFoodPileDepletion(world, s);
    expect(world.recentlyDepletedFood.length).toBe(n);
    world.simVersion = SIM_VERSION_V36_RISK_AWARE_FORAGING; // pre-V37 always records
    recordFoodPileDepletion(world, s);
    expect(world.recentlyDepletedFood.length).toBe(n + 1);
    // Append-time cap: the oldest entry is dropped.
    world.recentlyDepletedFood.length = 0;
    for (let i = 0; i < FOOD_PILE_SOFT_CEILING; i++) {
      world.recentlyDepletedFood.push({ tick: i, tileX: 0, tileY: 0 });
    }
    recordFoodPileDepletion(world, s);
    expect(world.recentlyDepletedFood.length).toBe(FOOD_PILE_SOFT_CEILING);
    expect(world.recentlyDepletedFood[0]!.tick).toBe(1);
    // A slot that holds no pile (free, a pool, or out of range) is a no-op.
    recordFoodPileDepletion(world, 99_999);
    recordFoodPileDepletion(world, -1);
    recordFoodPileDepletion(world, world.colonies[1]!.poolSlot);
    expect(world.recentlyDepletedFood.length).toBe(FOOD_PILE_SOFT_CEILING);
  });

  it('topUpOrSpawnCorpsePile tops up an occupied tile (clamped, flag kept) or spawns a corpse pile', () => {
    const { world, tiles } = emptyPileWorld(2);
    const s0 = spawnPile(
      world,
      60,
      tiles[0]!.x,
      tiles[0]!.y,
      (FOOD_PILE_INITIAL_PICKUPS_MAX - 2) * P,
      0,
    );
    drainPile(world, s0, P);
    topUpOrSpawnCorpsePile(world, tiles[0]!.x, tiles[0]!.y, 5 * P);
    expect(pileCount(world)).toBe(1);
    expect(pileInitialFp(world, s0)).toBe(FOOD_PILE_INITIAL_PICKUPS_MAX * P);
    expect(pileAmountFp(world, s0)).toBe(FOOD_PILE_INITIAL_PICKUPS_MAX * P);
    expect(pileIsCorpse(world, s0)).toBe(false); // a top-up never changes the flag
    const idBefore = world.nextEntityId;
    topUpOrSpawnCorpsePile(world, tiles[1]!.x, tiles[1]!.y, 7 * P);
    expect(pileCount(world)).toBe(2);
    const s1 = pileSlotAt(world, 1);
    expect(pileAtTile(world, tiles[1]!.x, tiles[1]!.y)).toBe(s1);
    expect(pileFoodId(world, s1)).toBe(idBefore);
    expect(pileIsCorpse(world, s1)).toBe(true);
    expect(pileAmountFp(world, s1)).toBe(7 * P);
  });

  it('topUpOrSpawnCorpsePile skips a new pile off-component, at the hard cap, or on id exhaustion', () => {
    const { world, tiles } = emptyPileWorld(1);
    let off: { x: number; y: number } | null = null;
    for (let y = 0; y < SURFACE_GRID_HEIGHT && off === null; y++) {
      for (let x = 0; x < SURFACE_GRID_WIDTH && off === null; x++) {
        if (!isSurfaceTileInComponent(world, x, y)) off = { x, y };
      }
    }
    if (off !== null) {
      const id0 = world.nextEntityId;
      topUpOrSpawnCorpsePile(world, off.x, off.y, P);
      expect(pileCount(world)).toBe(0);
      expect(world.nextEntityId).toBe(id0); // no id burnt
    }
    world.nextEntityId = MAX_ENTITIES; // exhausted: allocateEntityId → INVALID_ENTITY_ID
    topUpOrSpawnCorpsePile(world, tiles[0]!.x, tiles[0]!.y, P);
    expect(pileCount(world)).toBe(0);
    expect(world.nextEntityId).toBe(MAX_ENTITIES);
    // At the hard cap a NEW pile is skipped too (a top-up would still be allowed).
    world.nextEntityId = 100;
    for (let i = 0; i < FOOD_PILE_HARD_CAP; i++) spawnPile(world, 5000 + i, i, 1, P, 0);
    topUpOrSpawnCorpsePile(world, tiles[0]!.x, tiles[0]!.y, P);
    expect(pileCount(world)).toBe(FOOD_PILE_HARD_CAP);
    expect(world.nextEntityId).toBe(100);
  });

  it('pileRender / forEachPile give read-only views in creation order', () => {
    const { world, tiles } = emptyPileWorld(2);
    const s = spawnPile(world, 31, tiles[0]!.x, tiles[0]!.y, 4 * P, 0);
    spawnPile(world, 32, tiles[1]!.x, tiles[1]!.y, 2 * P, FOOD_FLAG_CORPSE);
    drainPile(world, s, P);
    expect(pileRender(world, s)).toEqual({
      foodId: 31,
      x: tiles[0]!.x,
      y: tiles[0]!.y,
      amountFp: 3 * P,
      initialFp: 4 * P,
      corpse: false,
    });
    const seen: PileView[] = [];
    forEachPile(world, (v) => seen.push(v));
    expect(seen.map((v) => [v.foodId, v.corpse])).toEqual([
      [31, false],
      [32, true],
    ]);
  });
});
