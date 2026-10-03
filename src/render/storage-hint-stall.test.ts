// storage-hint-stall.test.ts — #413: storage is the colony's population cap (the V70
// egg reserve counts the brood waiting, so one larder holds about 3 brood), and the
// game now says so:
//   - the Food Storage hint fires whenever the reserve the queen needs now is more
//     than storage can hold (the full-larder stall), not only when the colony has no
//     larder at all, and never while a larder with room is being filled;
//   - with a larder it says the stores are full; it shows once per stall, re-armed
//     only after the stall clears, and at most once per cooldown;
//   - the queen's "Waiting for stores: 24/30" line shows while the reserve holds
//     her back, with the numbers the sim's egg gate compares.
// The #395 rules this builds on (dwell, pending larders, withdrawal) are pinned in
// storage-hint.test.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  advanceStorageHint,
  createStorageHintState,
  formatQueenStoresLine,
  queenStoresWait,
  storageHintCondition,
  STORAGE_FULL_HINT_TEXT,
  STORAGE_HINT_COOLDOWN_TICKS,
  STORAGE_HINT_DWELL_TICKS,
  STORAGE_HINT_REARM_TICKS,
  type StorageHintState,
} from './storage-hint.js';
import { resetCaptions, untrigger } from './onboarding-captions.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import { allocateEntityId, SIM_VERSION_V69_FOOD_FAIRNESS } from '../sim/types.js';
import type { ChamberRecord, ColonyRecord } from '../sim/colony/colony-store.js';
import {
  eggReserveFp,
  eggReserveStorageShortfallFp,
  tickQueenEggProduction,
} from '../sim/colony/lifecycle-system.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/food/food-api.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { despawnAnt } from '../sim/ant-death.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import {
  addChamberForTest,
  setChamberStockForTest,
  setPoolFoodForTest,
} from '../sim/food/food-test-utils.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  PLAYER_COLONY_ID,
  QUEEN_EGG_RESERVE_RUNWAY_TICKS,
  WORKER_BASE_SPEED,
} from '../sim/constants.js';
import { LARVA_HUNGER, QUEEN_HUNGER, WORKER_HUNGER, runwayFoodFp } from '../sim/hunger.js';

const NO_LARDER_TEXT = 'Build a Food Storage chamber so your queen can lay eggs.';
const FULL = STORAGE_FULL_HINT_TEXT;
const RUNWAY = QUEEN_EGG_RESERVE_RUNWAY_TICKS;
const QUEEN_FP = runwayFoodFp(QUEEN_HUNGER, RUNWAY);
const LARVA_FP = runwayFoodFp(LARVA_HUNGER, RUNWAY);
const WORKER_FP = runwayFoodFp(WORKER_HUNGER, RUNWAY);
const ONE_LARDER = BASE_FOOD_STORAGE_CAPACITY + FOOD_CHAMBER_CAPACITY;
const DWELL = STORAGE_HINT_DWELL_TICKS;
const REARM = STORAGE_HINT_REARM_TICKS;
const COOLDOWN = STORAGE_HINT_COOLDOWN_TICKS;

/** createScenario(7)'s colonies start with three workers each and no chambers. */
const START_WORKERS = 3;

let nextChamberId = 95_000;

function scenario(simVersion?: number): { world: WorldState; colony: ColonyRecord } {
  const world =
    simVersion === undefined
      ? createScenario(7, 'Normal')
      : createScenario(7, 'Normal', simVersion);
  return { world, colony: world.colonies[PLAYER_COLONY_ID]! };
}

/** Give `colony` a completed chamber of `type` (a FoodStorage one gets an empty stock). */
function addChamber(world: WorldState, colony: ColonyRecord, type: ChamberType): ChamberRecord {
  const shape = {
    chamberId: nextChamberId++,
    chamberType: type,
    posX: 20 << FP_SHIFT,
    posY: 10 << FP_SHIFT,
    width: 4,
    height: 3,
  };
  if (type === ChamberType.FoodStorage) return addChamberForTest(world, colony, shape);
  const ch: ChamberRecord = { ...shape, foodSlot: -1 };
  colony.chambers.push(ch);
  return ch;
}

/** Queen chamber + Nursery: every egg gate the hint checks but storage. */
function readyToLay(world: WorldState, colony: ColonyRecord): void {
  addChamber(world, colony, ChamberType.Queen);
  addChamber(world, colony, ChamberType.Nursery);
}

/** Add `n` living workers (or eggs) to `colony`. */
function addAnts(
  world: WorldState,
  colony: ColonyRecord,
  n: number,
  role: 'worker' | 'egg' = 'worker',
): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: colony.colonyId,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      zone: Zone.Underground,
      lastMealTick: world.tick,
    });
    if (role === 'egg') {
      colony.eggs.push(id);
      colony.eggCount += 1;
    } else {
      colony.workers.push(id);
      colony.workerCount += 1;
    }
    ids.push(id);
  }
  return ids;
}

/** An egg of `colony` matures into a worker (the reserve falls by a larva, rises by a worker). */
function mature(colony: ColonyRecord): void {
  const id = colony.eggs.pop()!;
  colony.eggCount -= 1;
  colony.workers.push(id);
  colony.workerCount += 1;
}

/** Designate a FoodStorage chamber for the player colony (pending, not dug). */
function pendStorage(world: WorldState, anchorX: number): void {
  world.pendingChambers[`${PLAYER_COLONY_ID}:${anchorX}:9`] = {
    colonyId: PLAYER_COLONY_ID,
    chamberType: ChamberType.FoodStorage,
    anchorTileX: anchorX,
    anchorTileY: 9,
    width: 4,
    height: 3,
  };
}

/**
 * The opening stall, as playtest 3 found it at 1:00 (#413): Queen chamber, Nursery and
 * one Food Storage chamber, the larder near full (26 food: the pool's 8 and 18 in the
 * chamber), three workers and three eggs. The reserve (the queen, four larvae' worth
 * and three workers) is 28.9 food, more than the 28 the larder can hold.
 */
function stall(): { world: WorldState; colony: ColonyRecord; larder: ChamberRecord } {
  const { world, colony } = scenario();
  readyToLay(world, colony);
  const larder = addChamber(world, colony, ChamberType.FoodStorage);
  setPoolFoodForTest(world, colony, BASE_FOOD_STORAGE_CAPACITY);
  setChamberStockForTest(world, colony, larder, 18 * FP_ONE);
  addAnts(world, colony, 3, 'egg');
  return { world, colony, larder };
}

/** Run frames from tick `from` to `to` (inclusive); the captions shown, as `tick:text`. */
function run(state: StorageHintState, world: WorldState, from: number, to: number): string[] {
  const shown: string[] = [];
  for (let t = from; t <= to; t++) {
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    world.tick = t;
    const text = advanceStorageHint(state, world, PLAYER_COLONY_ID);
    if (text !== null) shown.push(`${t}:${text}`);
  }
  return shown;
}

describe('#413 — storageHintCondition: the reserve the queen needs now against capacity', () => {
  it('the opening stall (one larder near full, 3 brood waiting) is blocked; #395 missed it', () => {
    const { world, colony } = stall();
    const reserve = eggReserveFp(world, colony);
    expect(reserve).toBe(QUEEN_FP + 4 * LARVA_FP + START_WORKERS * WORKER_FP);
    expect(colonyFoodCapacity(colony)).toBe(ONE_LARDER);
    expect(reserve).toBeGreaterThan(ONE_LARDER);
    expect(colonyFoodTotal(world, colony)).toBe(26 * FP_ONE);
    // The #395 trigger: storage covers the reserve with no brood waiting.
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(0);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
  });

  it('a larder with room being filled is covered, however low the stores (a wait for food)', () => {
    const { world, colony, larder } = stall();
    mature(colony); // two eggs: the reserve (24.2 food) fits in the larder
    setPoolFoodForTest(world, colony, 5 * FP_ONE);
    setChamberStockForTest(world, colony, larder, 0);
    expect(eggReserveFp(world, colony)).toBeLessThanOrEqual(ONE_LARDER);
    expect(colonyFoodTotal(world, colony)).toBeLessThan(eggReserveFp(world, colony));
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
  });

  it('the edge: a reserve exactly at capacity is covered, one worker more is blocked', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    addChamber(world, colony, ChamberType.FoodStorage);
    addAnts(world, colony, 1, 'egg');
    // QUEEN_FP + 2 larvae' worth + W workers = one larder's capacity, exactly.
    const workers = (ONE_LARDER - QUEEN_FP - 2 * LARVA_FP) / WORKER_FP;
    expect(Number.isInteger(workers)).toBe(true);
    addAnts(world, colony, workers - START_WORKERS);
    expect(eggReserveFp(world, colony)).toBe(ONE_LARDER);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
    addAnts(world, colony, 1);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
  });

  it('stores at the reserve are covered whatever capacity says: she is not held back', () => {
    const { world, colony, larder } = stall();
    // Only the test setter can push the stores past capacity: all of them in the pool.
    setChamberStockForTest(world, colony, larder, 0);
    setPoolFoodForTest(world, colony, eggReserveFp(world, colony));
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
    setPoolFoodForTest(world, colony, eggReserveFp(world, colony) - 1);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
  });

  it('a designated larder that would cover the stall silences it', () => {
    const { world } = stall();
    pendStorage(world, 30);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
  });

  it('a brood stall past one more larder needs two designated', () => {
    const { world, colony } = stall();
    // Five more eggs: the reserve tops the larder by more than one more chamber.
    addAnts(world, colony, 5, 'egg');
    expect(eggReserveFp(world, colony) - ONE_LARDER).toBeGreaterThan(FOOD_CHAMBER_CAPACITY);
    pendStorage(world, 30);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
    pendStorage(world, 36);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
  });
});

describe('#413 — advanceStorageHint: copy, once per stall, cooldown', () => {
  beforeEach(() => resetCaptions());

  it('no larder: the build-the-first copy', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    expect(run(createStorageHintState(), world, 0, 3 * DWELL)).toEqual([
      `${DWELL}:${NO_LARDER_TEXT}`,
    ]);
  });

  it('the full-larder stall: "Your stores are full" after the dwell', () => {
    const { world } = stall();
    const s = createStorageHintState();
    expect(run(s, world, 0, DWELL - 1)).toEqual([]);
    expect(run(s, world, DWELL, 3 * DWELL)).toEqual([`${DWELL}:${FULL}`]);
  });

  it('never fires while a larder with room is filled up to the reserve', () => {
    const { world, colony, larder } = stall();
    mature(colony);
    const reserve = eggReserveFp(world, colony);
    const s = createStorageHintState();
    // Foragers bring the stores from 5 food to just under the reserve over 4000 ticks:
    // the queen is held back the whole time, storage never.
    const from = 5 * FP_ONE;
    for (let t = 0; t <= 4000; t++) {
      const stores = from + Math.floor(((reserve - 1 - from) * t) / 4000);
      const pool = Math.min(stores, BASE_FOOD_STORAGE_CAPACITY);
      setPoolFoodForTest(world, colony, pool);
      setChamberStockForTest(world, colony, larder, stores - pool);
      expect(run(s, world, t, t)).toEqual([]);
      expect(queenStoresWait(world, PLAYER_COLONY_ID)?.capped).toBe(false);
    }
  });

  it('a stall is told once, however the brood cycles through it', () => {
    const { world, colony } = stall();
    const s = createStorageHintState();
    const shown: string[] = [];
    let t = 0;
    // Ten cycles: blocked until a larva matures, covered for 30 ticks until she lays.
    for (let cycle = 0; cycle < 10; cycle++) {
      shown.push(...run(s, world, t, t + 900));
      mature(colony);
      expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
      shown.push(...run(s, world, t + 901, t + 930));
      addAnts(world, colony, 1, 'egg');
      expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
      t += 931;
    }
    expect(t).toBeGreaterThan(3 * COOLDOWN);
    expect(shown).toEqual([`${DWELL}:${FULL}`]);
  });

  it('a stall that clears and comes back is told again, but not before the cooldown', () => {
    const { world, colony } = stall();
    const s = createStorageHintState();
    expect(run(s, world, 0, DWELL)).toEqual([`${DWELL}:${FULL}`]);
    // Two brood mature: storage covers the reserve for the re-arm time (the stall clears).
    mature(colony);
    mature(colony);
    expect(run(s, world, DWELL + 1, DWELL + 1 + REARM)).toEqual([]);
    // She lays them again: stalled again, but told only once the cooldown is up.
    addAnts(world, colony, 2, 'egg');
    const back = DWELL + 2 + REARM;
    const due = DWELL + COOLDOWN;
    expect(due).toBeGreaterThan(back + DWELL);
    expect(run(s, world, back, due - 1)).toEqual([]);
    expect(run(s, world, due, due + 3 * DWELL)).toEqual([`${due}:${FULL}`]);
  });

  it('a stall that never clears is not told again, even long after the cooldown', () => {
    const { world } = stall();
    expect(run(createStorageHintState(), world, 0, 3 * COOLDOWN)).toEqual([`${DWELL}:${FULL}`]);
  });

  it('a hint offered again after the queue withdrew it spends a re-arm already due', () => {
    const { world, colony } = stall();
    const s = createStorageHintState();
    expect(run(s, world, 0, DWELL)).toEqual([`${DWELL}:${FULL}`]);
    untrigger('foodStorageNeeded'); // UIScene: withdrawn from the pending slot, never shown
    mature(colony);
    mature(colony);
    run(s, world, DWELL + 1, DWELL + 1 + REARM); // the stall clears: a re-arm is due
    addAnts(world, colony, 2, 'egg');
    const back = DWELL + 2 + REARM;
    // Un-marked, it is offered again after the dwell, within the cooldown.
    expect(run(s, world, back, back + DWELL)).toEqual([`${back + DWELL}:${FULL}`]);
    // That offer used up the re-arm: the stall goes on, and nothing more is shown.
    expect(run(s, world, back + DWELL + 1, back + DWELL + 3 * COOLDOWN)).toEqual([]);
  });

  it('a load to an earlier tick restarts the cooldown there', () => {
    const { world, colony } = stall();
    const s = createStorageHintState();
    expect(run(s, world, 5000, 5000 + DWELL)).toEqual([`${5000 + DWELL}:${FULL}`]);
    // An older save: the cooldown runs from the load, not from a tick still to come.
    mature(colony);
    mature(colony);
    run(s, world, 1000, 1000 + REARM);
    addAnts(world, colony, 2, 'egg');
    const due = 1000 + COOLDOWN;
    expect(run(s, world, 1001 + REARM, due - 1)).toEqual([]);
    expect(run(s, world, due, due)).toEqual([`${due}:${FULL}`]);
  });
});

describe('#413 — queenStoresWait / formatQueenStoresLine: "Waiting for stores"', () => {
  it('null without a colony, before the Queen chamber and Nursery, or with no queen', () => {
    const { world, colony } = scenario();
    expect(queenStoresWait(world, 9)).toBeNull();
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).toBeNull(); // no chambers yet
    addChamber(world, colony, ChamberType.Queen);
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).toBeNull(); // no Nursery
    addChamber(world, colony, ChamberType.Nursery);
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).not.toBeNull();
    despawnAnt(world, colony.queenEntityId, { cause: 'starvation' });
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).toBeNull();
  });

  it('null before V70 (no egg reserve gates her)', () => {
    const { world, colony } = scenario(SIM_VERSION_V69_FOOD_FAIRNESS);
    readyToLay(world, colony);
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).toBeNull();
  });

  it('the stall: the stores against the reserve, capped, as the HUD rounds them', () => {
    const { world } = stall();
    const wait = queenStoresWait(world, PLAYER_COLONY_ID)!;
    // 26 food stored; the reserve, 28.875 food, reads 29.
    expect(wait).toEqual({ storedFood: 26, reserveFood: 29, capped: true });
    expect(formatQueenStoresLine(wait)).toBe('Waiting for stores: 26/29');
  });

  it('a wait the larder can hold is not capped', () => {
    const { world, colony, larder } = stall();
    mature(colony);
    setChamberStockForTest(world, colony, larder, 0);
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).toEqual({
      storedFood: 8,
      reserveFood: Math.ceil(eggReserveFp(world, colony) / FP_ONE),
      capped: false,
    });
  });

  it('the stores always read below the reserve while she waits (floor against ceiling)', () => {
    const { world, colony } = stall();
    const reserve = eggReserveFp(world, colony);
    for (const stores of [reserve - 1, reserve - FP_ONE, reserve - FP_ONE - 1, 0]) {
      setPoolFoodForTest(world, colony, stores);
      for (const ch of colony.chambers) {
        if (ch.chamberType === ChamberType.FoodStorage)
          setChamberStockForTest(world, colony, ch, 0);
      }
      const wait = queenStoresWait(world, PLAYER_COLONY_ID)!;
      expect(wait.storedFood).toBe(stores >> FP_SHIFT);
      expect(wait.storedFood).toBeLessThan(wait.reserveFood);
    }
    // A reserve of whole food reads as itself: the queen, two larvae' worth (one egg
    // and the next) and one worker come to exactly 19 food.
    const { world: w2, colony: c2 } = scenario();
    readyToLay(w2, c2);
    for (const id of c2.workers.slice(1)) despawnAnt(w2, id, { cause: 'starvation' });
    addAnts(w2, c2, 1, 'egg');
    expect(eggReserveFp(w2, c2)).toBe(QUEEN_FP + 2 * LARVA_FP + WORKER_FP);
    expect(eggReserveFp(w2, c2)).toBe(19 * FP_ONE);
    setPoolFoodForTest(w2, c2, 19 * FP_ONE - 1);
    expect(queenStoresWait(w2, PLAYER_COLONY_ID)).toEqual({
      storedFood: 18,
      reserveFood: 19,
      capped: true, // the pool alone holds 8
    });
    setPoolFoodForTest(w2, c2, 19 * FP_ONE);
    expect(queenStoresWait(w2, PLAYER_COLONY_ID)).toBeNull();
  });

  it('matches the sim: shown exactly while the egg gate holds her back', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    // Every other egg gate open: the queen at home in her Queen chamber (tiles 20..23 x
    // 10..12) and her interval long past.
    const q = colony.queenEntityId;
    world.ants.zone[q] = Zone.Underground;
    world.ants.posX[q] = 21 << FP_SHIFT;
    world.ants.posY[q] = 11 << FP_SHIFT;
    colony.queenLastEggTick = 0;
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    world.tick = 100_000;
    const reserve = eggReserveFp(world, colony);
    setPoolFoodForTest(world, colony, reserve - 1);
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).not.toBeNull();
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(0);
    setPoolFoodForTest(world, colony, reserve);
    expect(queenStoresWait(world, PLAYER_COLONY_ID)).toBeNull();
    tickQueenEggProduction(world, colony);
    expect(colony.eggCount).toBe(1);
  });
});
