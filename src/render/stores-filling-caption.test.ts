// stores-filling-caption.test.ts — economy captions: "Your stores are nearly full —
// build another Food Storage so your foragers have room." is owed once the stores have
// read three-quarters full, with no Food Storage designated, for the dwell; not again
// within the cooldown (of itself or of the storage hint); dropped once stale.
import { describe, it, expect } from 'vitest';
import {
  createStoresFillingCaptionState,
  noteStoresFillingTick,
  offerStoresFillingCaption,
  storesFillingCaptionRecent,
  storesFillingCaptionStale,
  storesFillingCondition,
  STORES_FILLING_CAPTION_TEXT,
  STORES_FILLING_COOLDOWN_TICKS,
  STORES_FILLING_DWELL_TICKS,
  STORES_FILLING_OWED_TICKS,
  type StoresFillingCaptionState,
} from './stores-filling-caption.js';
import type { RecurringCaptionSink } from './recurring-captions.js';
import { createRampageCaptionState } from './recurring-captions.js';
import { createStorageHintState, storageHintCondition } from './storage-hint.js';
import { createQueenDangerState } from './queen-danger.js';
import { createEnemyQueenWoundState } from './enemy-queen-wound.js';
import { createCounterAttackCaptionState } from './counter-attack-caption.js';
import { beforeSimTick } from './sim-tick-hook.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { addChamberForTest, setColonyFoodForTest } from '../sim/food/food-test-utils.js';
import { colonyFoodCapacity } from '../sim/food/food-api.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  FOOD_CHAMBER_CAPACITY,
  PLAYER_COLONY_ID,
} from '../sim/constants.js';

const P = PLAYER_COLONY_ID;
let nextChamberId = 91_000;

/** The world's clock, set by the test (the sim never runs here). */
function setTick(w: WorldState, t: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
  w.tick = t;
}

function scenario(larders = 1): { world: WorldState; colony: ColonyRecord } {
  const world = createScenario(7, 'Normal');
  const colony = world.colonies[P]!;
  for (let i = 0; i < larders; i++) {
    addChamberForTest(world, colony, {
      chamberId: nextChamberId++,
      chamberType: ChamberType.FoodStorage,
      posX: (10 + 5 * i) << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      width: 4,
      height: 3,
    });
  }
  return { world, colony };
}

/** Fill the stores to `num/den` of capacity (the pool full first, then the larders). */
function fillTo(world: WorldState, colony: ColonyRecord, num: number, den: number): void {
  const want = Math.ceil((colonyFoodCapacity(colony) * num) / den);
  const pool = Math.min(want, BASE_FOOD_STORAGE_CAPACITY);
  let rest = want - pool;
  const stocks: number[] = [];
  for (const ch of colony.chambers) {
    if (ch.chamberType !== ChamberType.FoodStorage) continue;
    const s = Math.min(rest, FOOD_CHAMBER_CAPACITY);
    stocks.push(s);
    rest -= s;
  }
  setColonyFoodForTest(world, colony, pool, stocks);
}

function designateStorage(world: WorldState, colonyId: number = P): void {
  world.pendingChambers[`${colonyId}:30:9`] = {
    colonyId,
    chamberType: ChamberType.FoodStorage,
    anchorTileX: 30,
    anchorTileY: 9,
    width: 4,
    height: 3,
  };
}

/** Look at every tick from world.tick to `until` (inclusive), as beforeSimTick does. */
function lookThrough(
  state: StoresFillingCaptionState,
  world: WorldState,
  until: number,
  hintOffered: number | null = null,
): number[] {
  const owed: number[] = [];
  for (let t = world.tick; t <= until; t++) {
    setTick(world, t);
    const before = state.owedTick;
    noteStoresFillingTick(state, world, P, hintOffered);
    if (state.owedTick !== before && state.owedTick !== null) owed.push(t);
  }
  return owed;
}

function sink(idle = true): RecurringCaptionSink & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    captionQueueIdle: () => idle,
    showCaption: (t: string) => {
      shown.push(t);
      return true;
    },
  };
}

describe('storesFillingCondition', () => {
  it('holds at three-quarters full with a larder and none designated', () => {
    const { world, colony } = scenario(2);
    fillTo(world, colony, 3, 4);
    expect(storesFillingCondition(world, P)).toBe(true);
  });
  it('not below three-quarters', () => {
    const { world, colony } = scenario(2);
    fillTo(world, colony, 1, 2);
    expect(storesFillingCondition(world, P)).toBe(false);
  });
  it('not without a completed Food Storage (the storage hint covers the first one)', () => {
    const { world, colony } = scenario(0);
    fillTo(world, colony, 1, 1);
    expect(storesFillingCondition(world, P)).toBe(false);
  });
  it('not while a Food Storage is designated', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    designateStorage(world);
    expect(storesFillingCondition(world, P)).toBe(false);
  });
  it('not while storage already holds the queen back (the storage hint says that)', () => {
    const { world, colony } = scenario(1);
    for (const chamberType of [ChamberType.Queen, ChamberType.Nursery]) {
      colony.chambers.push({
        chamberId: nextChamberId++,
        chamberType,
        posX: 30 << FP_SHIFT,
        posY: 10 << FP_SHIFT,
        width: 4,
        height: 3,
        foodSlot: -1,
      });
    }
    fillTo(world, colony, 1, 1);
    expect(storesFillingCondition(world, P)).toBe(true);
    colony.eggCount = 20; // twenty eggs' larvae on the reserve: more than storage holds
    expect(storageHintCondition(world, P)).toBe('blocked');
    expect(storesFillingCondition(world, P)).toBe(false);
  });
  it("another colony's Food Storage designation does not silence it", () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    designateStorage(world, ENEMY_COLONY_ID);
    expect(storesFillingCondition(world, P)).toBe(true);
  });
  it('not once the queen is dead', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    world.ants.alive[colony.queenEntityId] = 0;
    expect(storesFillingCondition(world, P)).toBe(false);
  });
});

describe('noteStoresFillingTick: dwell and cooldown', () => {
  it('is owed after exactly the dwell, once', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    const t0 = world.tick;
    const owed = lookThrough(st, world, t0 + STORES_FILLING_COOLDOWN_TICKS - 1);
    expect(owed).toEqual([t0 + STORES_FILLING_DWELL_TICKS]);
  });
  it('is owed again only after the cooldown (and a fresh dwell)', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    const t0 = world.tick;
    const owed = lookThrough(st, world, t0 + 3 * STORES_FILLING_COOLDOWN_TICKS);
    expect(owed[0]).toBe(t0 + STORES_FILLING_DWELL_TICKS);
    expect(owed[1]).toBe(owed[0]! + STORES_FILLING_COOLDOWN_TICKS);
  });
  it('a dip below the threshold restarts the dwell', () => {
    const { world, colony } = scenario(1);
    const st = createStoresFillingCaptionState();
    fillTo(world, colony, 1, 1);
    const t0 = world.tick;
    lookThrough(st, world, t0 + STORES_FILLING_DWELL_TICKS - 2);
    fillTo(world, colony, 1, 2);
    setTick(world, world.tick + 1);
    noteStoresFillingTick(st, world, P, null);
    fillTo(world, colony, 1, 1);
    const t1 = world.tick + 1;
    setTick(world, t1);
    const owed = lookThrough(st, world, t1 + STORES_FILLING_DWELL_TICKS + 5);
    expect(owed).toEqual([t1 + STORES_FILLING_DWELL_TICKS]);
  });
  it('the storage hint offered within the cooldown holds it back', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    const t0 = world.tick;
    const owed = lookThrough(st, world, t0 + STORES_FILLING_COOLDOWN_TICKS + 10, t0);
    expect(owed).toEqual([t0 + STORES_FILLING_COOLDOWN_TICKS]);
  });
  it('a second look at the same tick changes nothing', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    lookThrough(st, world, world.tick + STORES_FILLING_DWELL_TICKS);
    const snap = { ...st };
    noteStoresFillingTick(st, world, P, null);
    expect(st).toEqual(snap);
  });
  it('storesFillingCaptionRecent covers exactly the cooldown after it was owed', () => {
    const st = createStoresFillingCaptionState();
    st.lastOwedTick = 1000;
    expect(storesFillingCaptionRecent(st, 999)).toBe(false);
    expect(storesFillingCaptionRecent(st, 1000)).toBe(true);
    expect(storesFillingCaptionRecent(st, 1000 + STORES_FILLING_COOLDOWN_TICKS - 1)).toBe(true);
    expect(storesFillingCaptionRecent(st, 1000 + STORES_FILLING_COOLDOWN_TICKS)).toBe(false);
  });
});

describe('offerStoresFillingCaption', () => {
  function owedWorld(): { world: WorldState; colony: ColonyRecord; st: StoresFillingCaptionState } {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    lookThrough(st, world, world.tick + STORES_FILLING_DWELL_TICKS);
    expect(st.owedTick).not.toBeNull();
    return { world, colony, st };
  }
  it('shows on an idle queue, once', () => {
    const { world, st } = owedWorld();
    const ui = sink();
    expect(offerStoresFillingCaption(st, world, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([STORES_FILLING_CAPTION_TEXT]);
    expect(offerStoresFillingCaption(st, world, P, ui, 0, 0)).toBe(false);
  });
  it('waits behind a busy queue, owed for the owed window, then is dropped', () => {
    const { world, st } = owedWorld();
    const busy = sink(false);
    const owedAt = st.owedTick!;
    setTick(world, owedAt + STORES_FILLING_OWED_TICKS);
    expect(offerStoresFillingCaption(st, world, P, busy, 0, 0)).toBe(false);
    expect(st.owedTick).toBe(owedAt);
    setTick(world, world.tick + 1);
    expect(storesFillingCaptionStale(st, world, P)).toBe(true);
    expect(offerStoresFillingCaption(st, world, P, sink(), 0, 0)).toBe(false);
    expect(st.owedTick).toBeNull();
    // Dropped unshown, its cooldown holds nothing back: the trigger still holds, so the
    // next look owes it again (the dwell has run on), and an idle queue then shows it.
    expect(st.lastOwedTick).toBeNull();
    noteStoresFillingTick(st, world, P, null);
    expect(st.owedTick).toBe(world.tick);
    const ui = sink();
    expect(offerStoresFillingCaption(st, world, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([STORES_FILLING_CAPTION_TEXT]);
  });
  it('is dropped once a Food Storage is designated (a queued order counts)', () => {
    const { world, st } = owedWorld();
    designateStorage(world);
    const ui = sink();
    expect(offerStoresFillingCaption(st, world, P, ui, 0, 0)).toBe(false);
    expect(ui.shown).toEqual([]);
    expect(st.owedTick).toBeNull();
    // ...and while it stays designated, nothing is owed again.
    noteStoresFillingTick(st, world, P, null);
    expect(st.owedTick).toBeNull();
  });
  it('is dropped once the stores fall below three-quarters', () => {
    const { world, colony, st } = owedWorld();
    fillTo(world, colony, 1, 2);
    expect(offerStoresFillingCaption(st, world, P, sink(), 0, 0)).toBe(false);
    expect(st.owedTick).toBeNull();
  });
});

describe('an owed caption is dropped when any tick invalidates its trigger (#431 review)', () => {
  /** Owe the caption behind a busy queue, then run the ticks after it in frames of
   *  `batch` ticks: the stores fall below three-quarters on the first tick and are back
   *  on the second, and each frame ends with the frame step on an idle queue. */
  function run(batch: number): { owedTicks: number[]; shownAt: number[]; flipAt: number } {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    lookThrough(st, world, world.tick + STORES_FILLING_DWELL_TICKS);
    const owedAt = st.owedTick!;
    expect(owedAt).toBe(world.tick);
    const flipAt = owedAt + 2; // the first tick the stores are back
    const end = flipAt + STORES_FILLING_DWELL_TICKS + 2 * batch;
    const ui = sink();
    const owedTicks: number[] = [];
    const shownAt: number[] = [];
    while (world.tick < end) {
      for (let i = 0; i < batch && world.tick < end; i++) {
        const t = world.tick + 1;
        setTick(world, t);
        fillTo(world, colony, 1, t === owedAt + 1 ? 2 : 1);
        const before = st.owedTick;
        noteStoresFillingTick(st, world, P, null);
        if (st.owedTick !== null && st.owedTick !== before) owedTicks.push(t);
      }
      // The frame step, on the world the frame leaves, an idle queue.
      if (offerStoresFillingCaption(st, world, P, ui, 0, 0)) shownAt.push(world.tick);
    }
    return { owedTicks, shownAt, flipAt };
  }

  it('a false-then-true flip inside one frame needs a fresh dwell, however the ticks are batched', () => {
    for (const batch of [1, 2, 3, 5]) {
      const { owedTicks, shownAt, flipAt } = run(batch);
      // Owed again only after a full fresh dwell from the first tick the trigger held
      // again, never on the old owed state: nothing shows at the flip's frame...
      expect(owedTicks, `batch ${batch}`).toEqual([flipAt + STORES_FILLING_DWELL_TICKS]);
      // ...and it shows at the first frame end that is past that fresh dwell.
      expect(shownAt.length, `batch ${batch}`).toBe(1);
      expect(shownAt[0]! >= flipAt + STORES_FILLING_DWELL_TICKS, `batch ${batch}`).toBe(true);
      expect(shownAt[0]! - (flipAt + STORES_FILLING_DWELL_TICKS), `batch ${batch}`).toBeLessThan(
        batch,
      );
    }
  });
});

describe('beforeSimTick looks at the stores before every sim tick', () => {
  it('owes the caption on the dwell tick, and passes the storage hint clock', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const prev = createScenario(7, 'Normal');
    const st = createStoresFillingCaptionState();
    const hint = createStorageHintState();
    const t0 = world.tick;
    const look = (): void =>
      beforeSimTick(world, [], P, prev, {
        rampage: createRampageCaptionState(),
        queenDanger: createQueenDangerState(),
        enemyQueenWound: createEnemyQueenWoundState(),
        counterAttack: createCounterAttackCaptionState(),
        storesFilling: st,
        storageHint: hint,
      });
    for (let t = t0; t < t0 + STORES_FILLING_DWELL_TICKS; t++) {
      setTick(world, t);
      look();
    }
    expect(st.owedTick).toBeNull();
    setTick(world, t0 + STORES_FILLING_DWELL_TICKS);
    look();
    expect(st.owedTick).toBe(t0 + STORES_FILLING_DWELL_TICKS);
    // A storage hint offered just now holds the next one back for the cooldown.
    const st2 = createStoresFillingCaptionState();
    hint.lastOfferedTick = world.tick;
    const t1 = world.tick;
    for (let t = t1; t <= t1 + STORES_FILLING_DWELL_TICKS; t++) {
      setTick(world, t);
      beforeSimTick(world, [], P, prev, {
        rampage: createRampageCaptionState(),
        queenDanger: createQueenDangerState(),
        enemyQueenWound: createEnemyQueenWoundState(),
        counterAttack: createCounterAttackCaptionState(),
        storesFilling: st2,
        storageHint: hint,
      });
    }
    expect(st2.owedTick).toBeNull();
  });
});
