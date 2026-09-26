// food-store-save.test.ts — #290 PR 2 (V50): the located food store through
// save/load. Replaces corpse-food-save.test.ts (its A2 cases are re-expressed
// here against the store) and pins validateFoodStore's tamper matrix, one case
// per invariant in save.ts's validator doc. Lives in platform/ because it
// exercises the save serializer (the sim/platform boundary forbids src/sim/ tests
// from importing platform/).

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState, type SerializedWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { allocateEntityId } from '../sim/types.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { LARVA_HUNGER } from '../sim/hunger.js';
import { spawnCorpseFood } from '../sim/food-system.js';
import type { WorldState } from '../sim/types.js';
import { isSurfaceTileInComponent } from '../sim/surface-features.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  FOOD_CHAMBER_CAPACITY,
  FOOD_PILE_HARD_CAP,
  FOOD_STORAGE_CHAMBERS_PER_COLONY_BOUND,
  FOOD_STORE_CAPACITY,
  PLAYER_COLONY_ID,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
} from '../sim/constants.js';
import { ChamberType } from '../sim/enums.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import {
  chamberStock,
  colonyPoolFood,
  drainPile,
  pileAtTile,
  pileCount,
  pileSlotAt,
  pileTileX,
  pileTileY,
  spawnPile,
} from '../sim/food/food-api.js';
import { FoodKind } from '../sim/food/food-store.js';
import {
  addChamberForTest,
  pilesForTest,
  setPilesForTest,
  setPoolFoodForTest,
} from '../sim/food/food-test-utils.js';

const PC = PLAYER_COLONY_ID as ColonyId;
const EC = ENEMY_COLONY_ID as ColonyId;
const P = 512;

/** First `n` walkable-component tiles — load rejects any food pile off the walkable component. */
function walkableTiles(world: WorldState, n: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SURFACE_GRID_HEIGHT && out.length < n; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH && out.length < n; x++) {
      if (isSurfaceTileInComponent(world, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** A scenario world with two stocked FoodStorage chambers (player) and a Nursery. */
function stockedWorld(): WorldState {
  const w = createScenario(42);
  const pc = w.colonies[PC]!;
  const fs = { chamberType: ChamberType.FoodStorage, posY: 5 << 8, width: 4, height: 3 };
  addChamberForTest(w, pc, { ...fs, chamberId: 900, posX: 30 << 8 }, 1234);
  addChamberForTest(w, pc, {
    chamberId: 901,
    chamberType: ChamberType.Nursery,
    posX: 36 << 8,
    posY: 5 << 8,
    width: 4,
    height: 3,
  });
  addChamberForTest(w, pc, { ...fs, chamberId: 902, posX: 42 << 8 }, FOOD_CHAMBER_CAPACITY);
  setPoolFoodForTest(w, w.colonies[EC]!, 777);
  return w;
}

/** Serialize `w`, apply `tamper` to the snapshot, and expect the load to throw `msg`. */
function rejects(
  w: WorldState,
  tamper: (s: SerializedWorldState) => void,
  msg: RegExp = /food|pool|Slot|pile/i,
): void {
  const s = serializeWorldState(w);
  tamper(s);
  expect(() => deserializeWorldState(s)).toThrow(msg);
}

/** Slot of the first live record of `kind` owned by `owner` in a snapshot. */
function slotOf(s: SerializedWorldState, kind: number, owner = -1): number {
  for (let i = 0; i < s.food.kind.length; i++) {
    if (s.food.kind[i] === kind && (owner < 0 || s.food.owner[i] === owner)) return i;
  }
  throw new Error('no such slot');
}

describe('#290 PR 2 food store — round trip', () => {
  it('piles, pools, stocks and every link survive serialize → deserialize exactly', () => {
    const w = stockedWorld();
    drainPile(w, pileSlotAt(w, 2), P); // a partly-eaten pile
    const s = serializeWorldState(w);
    const w2 = deserializeWorldState(s);
    expect(pilesForTest(w2)).toEqual(pilesForTest(w));
    for (const cid of [PC, EC]) {
      const [a, b] = [w.colonies[cid]!, w2.colonies[cid]!];
      expect(b.poolSlot).toBe(a.poolSlot);
      expect(colonyPoolFood(w2, b)).toBe(colonyPoolFood(w, a));
      expect(b.chambers.map((c) => [c.foodSlot, chamberStock(w2, c)])).toEqual(
        a.chambers.map((c) => [c.foodSlot, chamberStock(w, c)]),
      );
    }
    // The derived tile index is rebuilt on load.
    for (let o = 0; o < pileCount(w2); o++) {
      const slot = pileSlotAt(w2, o);
      expect(pileAtTile(w2, pileTileX(w2, slot), pileTileY(w2, slot))).toBe(slot);
    }
    // Re-serializing the loaded world reproduces the snapshot byte for byte.
    expect(JSON.stringify(serializeWorldState(w2))).toBe(JSON.stringify(s));
  });

  it('serializes columns only up to the highest live slot, and a freed slot mid-table as zeros', () => {
    const w = createScenario(42);
    const s0 = serializeWorldState(w);
    const n = s0.food.kind.length;
    expect(n).toBeLessThan(FOOD_STORE_CAPACITY);
    expect(s0.food.kind[n - 1]).not.toBe(FoodKind.None);
    // Empty a pile in the middle of the table: its slot becomes a zero row.
    const mid = pileSlotAt(w, 1);
    drainPile(w, mid, 1000 * P);
    const s = serializeWorldState(w);
    expect(s.food.kind[mid]).toBe(FoodKind.None);
    expect(s.food.foodId[mid]).toBe(0);
    expect(s.food.pileOrder).not.toContain(mid);
    // The loaded world reuses that same lowest free slot next, as the live one does.
    const w2 = deserializeWorldState(s);
    const t = walkableTiles(w, 400).find((q) => pileAtTile(w, q.x, q.y) < 0)!;
    expect(spawnPile(w2, 5000, t.x, t.y, 20 * P, 0)).toBe(mid);
    expect(spawnPile(w, 5000, t.x, t.y, 20 * P, 0)).toBe(mid);
    expect(JSON.stringify(serializeWorldState(w2))).toBe(JSON.stringify(serializeWorldState(w)));
  });
});

describe('#290 PR 2 food store — A2 corpse piles (was corpse-food-save.test.ts)', () => {
  it('a 1-pickup CORPSE pile loads and keeps its corpse flag', () => {
    const w = createScenario(42);
    const t = pilesForTest(w)[0]!; // a known-walkable tile
    setPilesForTest(w, [{ ...t, pickupsRemaining: 1, pickupsInitial: 1, isCorpse: true }]);
    const w2 = deserializeWorldState(serializeWorldState(w));
    expect(pilesForTest(w2)).toEqual([
      { ...t, pickupsRemaining: 1, pickupsInitial: 1, isCorpse: true },
    ]);
  });

  it('a 1-pickup NATURAL pile is rejected (a state the sim cannot generate)', () => {
    const w = createScenario(42);
    const t = pilesForTest(w)[0]!;
    setPilesForTest(w, [{ ...t, pickupsRemaining: 1, pickupsInitial: 1 }]);
    rejects(w, () => {}, /initialFp/);
  });

  it('a corpse-topped-up natural pile round-trips (stays natural)', () => {
    const w = createScenario(42);
    const t = pilesForTest(w)[0]!;
    setPilesForTest(w, [{ ...t, pickupsRemaining: 30, pickupsInitial: 30 }]);
    spawnCorpseFood(w, t.tileX, t.tileY, 100); // top up -> 130, still natural
    const w2 = deserializeWorldState(serializeWorldState(w));
    expect(pilesForTest(w2)).toEqual([{ ...t, pickupsRemaining: 130, pickupsInitial: 130 }]);
  });

  it('a full FOOD_PILE_HARD_CAP set of corpse piles serializes + deserializes', () => {
    const w = createScenario(42);
    const tiles = walkableTiles(w, FOOD_PILE_HARD_CAP);
    expect(tiles.length).toBe(FOOD_PILE_HARD_CAP);
    setPilesForTest(
      w,
      tiles.map((t, i) => ({
        foodPileId: 1000 + i,
        tileX: t.x,
        tileY: t.y,
        pickupsRemaining: 1,
        pickupsInitial: 1,
        isCorpse: true,
      })),
    );
    expect(pileCount(deserializeWorldState(serializeWorldState(w)))).toBe(FOOD_PILE_HARD_CAP);
  });
});

describe('#290 PR 2 validateFoodStore — tamper matrix', () => {
  // 1. Column shape.
  it('rejects a missing / non-array / short column', () => {
    const w = stockedWorld();
    rejects(
      w,
      (s) => {
        (s.food as unknown as { owner: unknown }).owner = 'x';
      },
      /food\.owner/,
    );
    rejects(
      w,
      (s) => {
        s.food.amountFp.pop();
      },
      /food\.amountFp/,
    );
    rejects(
      w,
      (s) => {
        delete (s.food as unknown as Record<string, unknown>)['flags'];
      },
      /food\.flags/,
    );
  });

  it('rejects a table longer than FOOD_STORE_CAPACITY', () => {
    rejects(
      stockedWorld(),
      (s) => {
        for (const k of Object.keys(s.food) as Array<keyof typeof s.food>) {
          if (k === 'pileOrder') continue;
          const col = s.food[k];
          while (col.length <= FOOD_STORE_CAPACITY) col.push(0);
        }
      },
      /food\.kind/,
    );
  });

  it('rejects a non-integer or out-of-range column value', () => {
    const w = stockedWorld();
    rejects(w, (s) => (s.food.amountFp[0] = 1.5), /food\.amountFp\[0\]/);
    rejects(w, (s) => (s.food.kind[0] = 4), /food\.kind\[0\]/);
    rejects(w, (s) => (s.food.zone[0] = 2), /food\.zone\[0\]/);
    rejects(w, (s) => (s.food.foodId[0] = -2), /food\.foodId\[0\]/);
  });

  // 2. Per-kind bounds.
  it('rejects a free slot that is not all zeros', () => {
    const w = createScenario(42);
    drainPile(w, pileSlotAt(w, 1), 1000 * P); // frees a mid-table slot
    const free = serializeWorldState(w).food.kind.indexOf(FoodKind.None);
    expect(free).toBeGreaterThanOrEqual(0);
    rejects(w, (s) => (s.food.amountFp[free] = 512), /free slot/);
  });

  it('rejects a pile that is owned, underground, or carries unknown flags', () => {
    const w = stockedWorld();
    const p = (s: SerializedWorldState): number => s.food.pileOrder[0]!;
    rejects(w, (s) => (s.food.owner[p(s)] = PC), /unowned/);
    rejects(w, (s) => (s.food.zone[p(s)] = 1), /unowned/);
    rejects(w, (s) => (s.food.flags[p(s)] = 2), /flags/);
  });

  it('rejects pile amounts that are not whole pickups', () => {
    const w = stockedWorld();
    rejects(w, (s) => (s.food.amountFp[s.food.pileOrder[0]!]! -= 1), /amountFp/);
    rejects(w, (s) => (s.food.initialFp[s.food.pileOrder[0]!]! += 1), /initialFp/);
  });

  it('rejects a pool over BASE_FOOD_STORAGE_CAPACITY and a stock over FOOD_CHAMBER_CAPACITY', () => {
    const w = stockedWorld();
    rejects(
      w,
      (s) => (s.food.amountFp[slotOf(s, FoodKind.Pool)] = BASE_FOOD_STORAGE_CAPACITY + 1),
      /cap/,
    );
    rejects(
      w,
      (s) => (s.food.amountFp[slotOf(s, FoodKind.Stock)] = FOOD_CHAMBER_CAPACITY + 1),
      /cap/,
    );
  });

  it('rejects a pool / stock outside its owner’s grid, or owned by no colony', () => {
    const w = stockedWorld();
    rejects(w, (s) => (s.food.grid[slotOf(s, FoodKind.Pool)] = 0), /owning colony/);
    rejects(w, (s) => (s.food.zone[slotOf(s, FoodKind.Stock)] = 0), /owning colony/);
    rejects(
      w,
      (s) => {
        const i = slotOf(s, FoodKind.Pool, EC);
        s.food.owner[i] = 7;
        s.food.grid[i] = 7;
      },
      /owning colony/,
    );
    rejects(w, (s) => (s.food.tileY[slotOf(s, FoodKind.Pool)] = 100), /tile/);
  });

  it('rejects a pool / stock carrying pile-only data, and a pool with a foodId', () => {
    const w = stockedWorld();
    rejects(w, (s) => (s.food.initialFp[slotOf(s, FoodKind.Pool)] = 512), /initialFp or flags/);
    rejects(w, (s) => (s.food.flags[slotOf(s, FoodKind.Stock)] = 1), /initialFp or flags/);
    rejects(w, (s) => (s.food.foodId[slotOf(s, FoodKind.Pool)] = 3), /foodId/);
  });

  // 3. Colony pool links.
  it('rejects a colony whose poolSlot is not its own Pool', () => {
    const w = stockedWorld();
    rejects(
      w,
      (s) => {
        s.colonies[String(PC)]!.poolSlot = s.food.pileOrder[0]!; // a pile
      },
      /poolSlot/,
    );
    rejects(
      w,
      (s) => {
        s.colonies[String(PC)]!.poolSlot = s.colonies[String(EC)]!.poolSlot; // the enemy's pool
      },
      /poolSlot/,
    );
    rejects(
      w,
      (s) => {
        s.colonies[String(PC)]!.poolSlot = s.food.kind.length + 3; // past the table
      },
      /poolSlot/,
    );
  });

  it('rejects more colonies than MAX_COLONIES (the store is sized for them)', () => {
    const w = stockedWorld();
    const extra: ColonyRecord = createColonyRecord(3 as ColonyId, 0);
    extra.entrances = [];
    extra.rallyPoint = null;
    w.colonies[3 as ColonyId] = extra;
    setPoolFoodForTest(w, extra, 0);
    rejects(w, () => {}, /Too many colonies/);
  });

  // 4. Chamber stock links.
  it('rejects a FoodStorage chamber with no stock, a wrong stock, or a shared stock', () => {
    const w = stockedWorld();
    const chambers = (s: SerializedWorldState): Array<{ foodSlot: number }> =>
      s.colonies[String(PC)]!.chambers;
    rejects(w, (s) => (chambers(s)[0]!.foodSlot = -1), /foodSlot/);
    rejects(w, (s) => (chambers(s)[0]!.foodSlot = s.colonies[String(PC)]!.poolSlot), /foodSlot/);
    rejects(w, (s) => (chambers(s)[2]!.foodSlot = chambers(s)[0]!.foodSlot), /foodSlot|Shared/);
  });

  it('rejects a colony with more FoodStorage chambers than the physical bound (so the store can never fill)', () => {
    const w = createScenario(42);
    const pc = w.colonies[PC]!;
    // Legit up to the bound (overlapping footprints are fine for the validator).
    for (let i = 0; i < FOOD_STORAGE_CHAMBERS_PER_COLONY_BOUND; i++) {
      addChamberForTest(w, pc, {
        chamberId: 2000 + i,
        chamberType: ChamberType.FoodStorage,
        posX: 30 << 8,
        posY: 5 << 8,
        width: 4,
        height: 3,
      });
    }
    expect(() => deserializeWorldState(serializeWorldState(w))).not.toThrow();
    addChamberForTest(w, pc, {
      chamberId: 4000,
      chamberType: ChamberType.FoodStorage,
      posX: 30 << 8,
      posY: 5 << 8,
      width: 4,
      height: 3,
    });
    rejects(w, () => {}, /Too many FoodStorage chambers/);
  });

  it("rejects a stock whose foodId or tile is not its chamber's", () => {
    const w = stockedWorld();
    rejects(w, (s) => (s.food.foodId[slotOf(s, FoodKind.Stock)] = 4000), /foodSlot/);
    rejects(w, (s) => (s.food.tileX[slotOf(s, FoodKind.Stock)]! += 1), /foodSlot/);
  });

  it('rejects a non-FoodStorage chamber that claims a stock', () => {
    rejects(
      stockedWorld(),
      (s) => {
        const chs = s.colonies[String(PC)]!.chambers;
        chs[1]!.foodSlot = chs[0]!.foodSlot; // the Nursery
      },
      /not FoodStorage/,
    );
  });

  it('rejects an orphan stock or pool that nothing links to', () => {
    rejects(
      stockedWorld(),
      (s) => {
        // Drop the second FoodStorage chamber but keep its stock record.
        s.colonies[String(PC)]!.chambers.pop();
      },
      /no colony or chamber links/,
    );
  });

  // The hunger clock of a live queen / larva (#288).
  it('rejects a live queen whose last meal is in the future or past starve-after', () => {
    const w = createScenario(42);
    for (let t = 0; t < 5; t++) tick(w, []);
    const q = w.colonies[PC]!.queenEntityId;
    expect(() => deserializeWorldState(serializeWorldState(w))).not.toThrow();
    rejects(w, (s) => (s.ants.lastMealTick[q] = s.tick), /lastMealTick/);
    rejects(w, (s) => (s.ants.lastMealTick[q] = s.tick - 301), /lastMealTick/);
    // The edges load: fed last tick, or one meal from starving.
    const s = serializeWorldState(w);
    s.ants.lastMealTick[q] = s.tick - 300;
    expect(() => deserializeWorldState(s)).not.toThrow();
  });

  it('rejects a live larva whose last meal is in the future or past starve-after', () => {
    const w = createScenario(42);
    for (let t = 0; t < 5; t++) tick(w, []);
    const pc = w.colonies[PC]!;
    const larva = allocateEntityId(w);
    initAnt(w.ants, larva, {
      colonyId: PC,
      posX: 30 << 8,
      posY: 6 << 8,
      zone: 1,
      lastMealTick: w.tick - 1, // fed on the last tick
    });
    pc.larvae.push(larva);
    pc.larvaeCount += 1;
    expect(() => deserializeWorldState(serializeWorldState(w))).not.toThrow();
    rejects(w, (s) => (s.ants.lastMealTick[larva] = s.tick), /lastMealTick.*larva/);
    const oldest = w.tick - LARVA_HUNGER.starveAfterTicks; // the window's far edge
    w.ants.lastMealTick[larva] = oldest;
    expect(() => deserializeWorldState(serializeWorldState(w))).not.toThrow();
    rejects(w, (s) => (s.ants.lastMealTick[larva] = oldest - 1), /lastMealTick.*larva/);
    // A DEAD larva's clock is not checked (it stopped when it died).
    w.ants.alive[larva] = 0;
    const s = serializeWorldState(w);
    s.ants.lastMealTick[larva] = s.tick + 1000;
    expect(() => deserializeWorldState(s)).not.toThrow();
  });

  // 5. Pile order.
  it('rejects a pile order that repeats, misses or mislabels a pile', () => {
    const w = stockedWorld();
    rejects(w, (s) => (s.food.pileOrder[1] = s.food.pileOrder[0]!), /pileOrder\[1\]/);
    rejects(w, (s) => s.food.pileOrder.pop(), /entries for/);
    rejects(w, (s) => (s.food.pileOrder[0] = slotOf(s, FoodKind.Pool)), /pileOrder\[0\]/);
    rejects(w, (s) => (s.food.pileOrder[0] = -1), /pileOrder\[0\]/);
  });

  it('still rejects a pile off the walkable surface component (connectivity)', () => {
    const w = createScenario(42);
    let off: { x: number; y: number } | null = null;
    for (let y = 0; y < SURFACE_GRID_HEIGHT && off === null; y++) {
      for (let x = 0; x < SURFACE_GRID_WIDTH && off === null; x++) {
        if (!isSurfaceTileInComponent(w, x, y)) off = { x, y };
      }
    }
    expect(off).not.toBeNull();
    rejects(
      w,
      (s) => {
        s.food.tileX[s.food.pileOrder[0]!] = off!.x;
        s.food.tileY[s.food.pileOrder[0]!] = off!.y;
      },
      /connectivity/,
    );
  });
});
