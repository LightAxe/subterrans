// stores-filling-caption.test.ts — economy captions: "Your stores are nearly full —
// build another Food Storage so your foragers have room." is owed once the stores have
// read three-quarters full, with no Food Storage designated, for the dwell; not again
// within the cooldown (of itself or of the storage hint); dropped once stale; (#435)
// quiet during an attack, and backing off when shown and ignored.
import { describe, it, expect } from 'vitest';
import {
  createStoresFillingCaptionState,
  noteStoresFillingTick,
  offerStoresFillingCaption,
  storesFillingCaptionRecent,
  storesFillingCaptionStale,
  storesFillingCondition,
  STORES_FILLING_CAPTION_TEXT,
  STORES_FILLING_COOLDOWN_MAX_TICKS,
  STORES_FILLING_COOLDOWN_TICKS,
  STORES_FILLING_DWELL_TICKS,
  STORES_FILLING_OWED_TICKS,
  type StoresFillingCaptionState,
} from './stores-filling-caption.js';
import { createArmyWarningState, type ArmyWarningState } from './army-warning.js';
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
/** An army warning with no wave under way (armed). */
const calm = createArmyWarningState();
let nextChamberId = 91_000;

/** The world's clock, set by the test (the sim never runs here). */
function setTick(w: WorldState, t: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
  w.tick = t;
}

function scenario(foodStorageChambers = 1): { world: WorldState; colony: ColonyRecord } {
  const world = createScenario(7, 'Normal');
  const colony = world.colonies[P]!;
  for (let i = 0; i < foodStorageChambers; i++) {
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

/** Fill the stores to `num/den` of capacity (the pool full first, then the Food Storage chambers). */
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
  army: ArmyWarningState = calm,
): number[] {
  const owed: number[] = [];
  for (let t = world.tick; t <= until; t++) {
    setTick(world, t);
    const before = state.owedTick;
    noteStoresFillingTick(state, world, P, hintOffered, army);
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
  it('holds at three-quarters full with a Food Storage chamber and none designated', () => {
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
    noteStoresFillingTick(st, world, P, null, calm);
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
    noteStoresFillingTick(st, world, P, null, calm);
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
    noteStoresFillingTick(st, world, P, null, calm);
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
    noteStoresFillingTick(st, world, P, null, calm);
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
        noteStoresFillingTick(st, world, P, null, calm);
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
        armyWarning: calm,
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
        armyWarning: calm,
        storageHint: hint,
      });
    }
    expect(st2.owedTick).toBeNull();
  });
});

/** The back-off and attack tests drive the caption as GameScene does: every tick is looked
 *  at (`note`), and the frame step runs at the end of each frame of `batch` ticks.
 *  Unlike GameScene, `armed` is flipped per tick here (GameScene advances the army warning
 *  once per frame), so these tests pin the module's per-tick rule, not frame-exact wiring. */
function drive(
  batch: number,
  end: number,
  opts: {
    /** Is the army warning disarmed (a wave under way) on tick `t`? */
    wave?: (t: number) => boolean;
    /** Is the caption queue idle on tick `t`? */
    idle?: (t: number) => boolean;
    /** Tick on which the player designates a Food Storage, and tick it completes. */
    designateAt?: number;
    completeAt?: number;
    /** Tick on which the session resets. */
    resetAt?: number;
  } = {},
): { owedTicks: number[]; shownTicks: number[]; cooldowns: number[] } {
  const { world, colony } = scenario(1);
  fillTo(world, colony, 1, 1);
  let st = createStoresFillingCaptionState();
  const army = createArmyWarningState();
  const t0 = world.tick;
  const owedTicks: number[] = [];
  const shownTicks: number[] = [];
  const cooldowns: number[] = [];
  let t = t0;
  while (t < end) {
    for (let i = 0; i < batch && t < end; i++) {
      t++;
      setTick(world, t);
      if (t === opts.resetAt) st = createStoresFillingCaptionState();
      if (t === opts.designateAt) designateStorage(world);
      if (t === opts.completeAt) {
        for (const key of Object.keys(world.pendingChambers)) delete world.pendingChambers[key];
        addChamberForTest(world, colony, {
          chamberId: nextChamberId++,
          chamberType: ChamberType.FoodStorage,
          posX: 40 << FP_SHIFT,
          posY: 10 << FP_SHIFT,
          width: 4,
          height: 3,
        });
        fillTo(world, colony, 1, 1);
      }
      army.armed = !(opts.wave?.(t) ?? false);
      const before = st.owedTick;
      noteStoresFillingTick(st, world, P, null, army);
      if (st.owedTick !== null && st.owedTick !== before) owedTicks.push(t);
    }
    const ui = sink(opts.idle?.(t) ?? true);
    if (offerStoresFillingCaption(st, world, P, ui, 0, 0)) {
      shownTicks.push(t);
      cooldowns.push(st.cooldownTicks);
    }
  }
  return { owedTicks, shownTicks, cooldowns };
}

const BATCHES = [1, 2, 3, 5];

describe('quiet during an attack (#435)', () => {
  it('is not owed while the army warning is disarmed, and is owed once it re-arms', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    const t0 = world.tick;
    const wave = createArmyWarningState();
    wave.armed = false;
    // The warning fires before the dwell is up and stays disarmed well past it.
    expect(lookThrough(st, world, t0 + 3 * STORES_FILLING_DWELL_TICKS, null, wave)).toEqual([]);
    expect(st.owedTick).toBeNull();
    // Re-armed (the invasion ended): the dwell has run on, so it is owed at once.
    setTick(world, t0 + 3 * STORES_FILLING_DWELL_TICKS + 1);
    expect(lookThrough(st, world, world.tick, null, calm)).toEqual([world.tick]);
  });
  it('drops an owed-unshown caption when the warning fires, freeing its cooldown', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    const t0 = world.tick;
    lookThrough(st, world, t0 + STORES_FILLING_DWELL_TICKS);
    expect(st.owedTick).toBe(t0 + STORES_FILLING_DWELL_TICKS);
    const wave = createArmyWarningState();
    wave.armed = false;
    setTick(world, world.tick + 1);
    noteStoresFillingTick(st, world, P, null, wave);
    expect(st.owedTick).toBeNull();
    expect(st.lastOwedTick).toBeNull();
    expect(offerStoresFillingCaption(st, world, P, sink(), 0, 0)).toBe(false);
  });
  it('a shown caption keeps its cooldown through the attack', () => {
    const wave = (t: number): boolean => t >= 250 && t < 700;
    const { owedTicks, shownTicks } = drive(1, 5000, { wave });
    const owed0 = owedTicks[0]!;
    expect(shownTicks[0]).toBe(owed0);
    // Shown before the warning fired; its cooldown still holds afterwards.
    expect(owedTicks[1]).toBe(owed0 + STORES_FILLING_COOLDOWN_TICKS);
  });
  it('owes again after the attack ends, however the ticks are batched', () => {
    // Busy until the wave's end: owed at the dwell, dropped when the wave begins.
    const wave = (t: number): boolean => t >= 250 && t < 700;
    const idle = (t: number): boolean => t >= 700;
    const ref = drive(1, 1500, { wave, idle });
    const t0 = ref.owedTicks[0]! - STORES_FILLING_DWELL_TICKS;
    expect(ref.owedTicks).toEqual([t0 + STORES_FILLING_DWELL_TICKS, 700]);
    expect(ref.shownTicks.length).toBe(1);
    expect(ref.shownTicks[0]! >= 700).toBe(true);
    for (const batch of BATCHES) {
      const r = drive(batch, 1500, { wave, idle });
      expect(r.owedTicks, `batch ${batch}`).toEqual(ref.owedTicks);
      expect(r.shownTicks.length, `batch ${batch}`).toBe(1);
      expect(r.shownTicks[0]! - 700, `batch ${batch}`).toBeLessThan(batch);
    }
  });
});

describe('backs off when ignored (#435)', () => {
  it('waits 1, 2, 4, 8 and 8 minutes after successive ignored shows (the cap)', () => {
    const { owedTicks, shownTicks, cooldowns } = drive(1, 80_000);
    const gaps = owedTicks.slice(1).map((t, i) => t - owedTicks[i]!);
    expect(gaps.slice(0, 5)).toEqual([
      STORES_FILLING_COOLDOWN_TICKS,
      2 * STORES_FILLING_COOLDOWN_TICKS,
      4 * STORES_FILLING_COOLDOWN_TICKS,
      STORES_FILLING_COOLDOWN_MAX_TICKS,
      STORES_FILLING_COOLDOWN_MAX_TICKS,
    ]);
    expect(STORES_FILLING_COOLDOWN_MAX_TICKS).toBe(8 * STORES_FILLING_COOLDOWN_TICKS);
    expect(shownTicks.length).toBe(owedTicks.length);
    expect(cooldowns.slice(0, 5)).toEqual([1200, 2400, 4800, 9600, 9600]);
  });
  it('a new Food Storage designation resets the cooldown', () => {
    // Shown at the dwell (cooldown 1200) and again 1200 later (then 2400); the player
    // designates a Food Storage after that, and it completes a tick later.
    const ref = drive(1, 6000);
    const first = ref.owedTicks[0]!;
    const second = first + STORES_FILLING_COOLDOWN_TICKS;
    expect(ref.owedTicks.slice(0, 3)).toEqual([
      first,
      second,
      second + 2 * STORES_FILLING_COOLDOWN_TICKS,
    ]);
    const opts = { designateAt: second + 100, completeAt: second + 101 };
    const r = drive(1, 6000, opts);
    expect(r.owedTicks.slice(0, 2)).toEqual([first, second]);
    // Back to the first cooldown from the second owing, not the doubled one.
    expect(r.owedTicks[2]).toBe(second + STORES_FILLING_COOLDOWN_TICKS);
    expect(r.cooldowns.slice(0, 3)).toEqual([
      STORES_FILLING_COOLDOWN_TICKS,
      2 * STORES_FILLING_COOLDOWN_TICKS,
      STORES_FILLING_COOLDOWN_TICKS,
    ]);
    for (const batch of BATCHES) {
      const b = drive(batch, 6000, opts);
      expect(b.owedTicks, `batch ${batch}`).toEqual(r.owedTicks);
    }
  });
  it('a caption dropped unshown does not advance the back-off', () => {
    const { world, colony } = scenario(1);
    fillTo(world, colony, 1, 1);
    const st = createStoresFillingCaptionState();
    lookThrough(st, world, world.tick + STORES_FILLING_DWELL_TICKS);
    // Behind a busy queue until it is stale: dropped unshown.
    setTick(world, st.owedTick! + STORES_FILLING_OWED_TICKS + 1);
    expect(offerStoresFillingCaption(st, world, P, sink(false), 0, 0)).toBe(false);
    expect(st.owedTick).toBeNull();
    expect(st.cooldownTicks).toBe(STORES_FILLING_COOLDOWN_TICKS);
    expect(st.shownStorageCount).toBeNull();
    // Owed again at once and shown: that is the first show, so the cooldown stays; the
    // next show (with no Food Storage built) is the one that doubles it.
    noteStoresFillingTick(st, world, P, null, calm);
    expect(offerStoresFillingCaption(st, world, P, sink(), 0, 0)).toBe(true);
    expect(st.cooldownTicks).toBe(STORES_FILLING_COOLDOWN_TICKS);
    setTick(world, world.tick + STORES_FILLING_COOLDOWN_TICKS);
    noteStoresFillingTick(st, world, P, null, calm);
    expect(offerStoresFillingCaption(st, world, P, sink(), 0, 0)).toBe(true);
    expect(st.cooldownTicks).toBe(2 * STORES_FILLING_COOLDOWN_TICKS);
  });
  it('the session reset starts the back-off over', () => {
    const ref = drive(1, 20_000);
    const r = drive(1, 20_000, { resetAt: ref.owedTicks[1]! + 50 });
    // The fresh state owes after its own dwell, and its cooldown is the first one again.
    const resetTick = ref.owedTicks[1]! + 50;
    expect(r.owedTicks[2]).toBe(resetTick + STORES_FILLING_DWELL_TICKS);
    expect(ref.cooldowns[1]).toBe(2 * STORES_FILLING_COOLDOWN_TICKS);
    expect(r.cooldowns[2]).toBe(STORES_FILLING_COOLDOWN_TICKS);
    expect(r.owedTicks[3]! - r.owedTicks[2]!).toBe(STORES_FILLING_COOLDOWN_TICKS);
    expect(r.owedTicks[4]! - r.owedTicks[3]!).toBe(2 * STORES_FILLING_COOLDOWN_TICKS);
    expect(createStoresFillingCaptionState().cooldownTicks).toBe(STORES_FILLING_COOLDOWN_TICKS);
    expect(createStoresFillingCaptionState().shownStorageCount).toBeNull();
  });
  it('owes at the same ticks however the ticks are batched', () => {
    const ref = drive(1, 40_000);
    for (const batch of BATCHES) {
      const r = drive(batch, 40_000);
      expect(r.owedTicks, `batch ${batch}`).toEqual(ref.owedTicks);
      expect(r.cooldowns.slice(0, 4), `batch ${batch}`).toEqual(ref.cooldowns.slice(0, 4));
    }
  });
});
