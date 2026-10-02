// storage-hint.test.ts — #395: "Build a Food Storage chamber so your queen can lay
// eggs." shows when storage is what stops the queen laying (V70 egg reserve), once
// per spell, re-armed after storage has covered the reserve for a while.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  advanceStorageHint,
  createStorageHintState,
  storageHintCondition,
  STORAGE_HINT_DWELL_TICKS,
  STORAGE_HINT_REARM_TICKS,
  type StorageHintState,
} from './storage-hint.js';
import { resetCaptions, untrigger } from './onboarding-captions.js';
import { createScenario } from '../sim/scenario.js';
import type { WorldState } from '../sim/types.js';
import { allocateEntityId, SIM_VERSION_V69_FOOD_FAIRNESS } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { eggReserveFp, eggReserveStorageShortfallFp } from '../sim/colony/lifecycle-system.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { despawnAnt } from '../sim/ant-death.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { addChamberForTest } from '../sim/food/food-test-utils.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  FOOD_CHAMBER_CAPACITY,
  PLAYER_COLONY_ID,
  QUEEN_EGG_RESERVE_RUNWAY_TICKS,
  WORKER_BASE_SPEED,
} from '../sim/constants.js';
import {
  FIGHTER_HUNGER,
  LARVA_HUNGER,
  QUEEN_HUNGER,
  WORKER_HUNGER,
  runwayFoodFp,
} from '../sim/hunger.js';

const TEXT = 'Build a Food Storage chamber so your queen can lay eggs.';
const RUNWAY = QUEEN_EGG_RESERVE_RUNWAY_TICKS;
const QUEEN_FP = runwayFoodFp(QUEEN_HUNGER, RUNWAY);
const LARVA_FP = runwayFoodFp(LARVA_HUNGER, RUNWAY);
const WORKER_FP = runwayFoodFp(WORKER_HUNGER, RUNWAY);

/** createScenario(7)'s colonies start with three workers each and no chambers. */
const START_WORKERS = 3;

function scenario(simVersion?: number): { world: WorldState; colony: ColonyRecord } {
  const world =
    simVersion === undefined
      ? createScenario(7, 'Normal')
      : createScenario(7, 'Normal', simVersion);
  return { world, colony: world.colonies[PLAYER_COLONY_ID]! };
}

let nextChamberId = 90_000;

/** Give `colony` a completed chamber of `type` (FoodStorage gets its food stock). */
function addChamber(world: WorldState, colony: ColonyRecord, type: ChamberType): void {
  const shape = {
    chamberId: nextChamberId++,
    chamberType: type,
    posX: 20 << FP_SHIFT,
    posY: 10 << FP_SHIFT,
    width: 4,
    height: 3,
  };
  if (type === ChamberType.FoodStorage) addChamberForTest(world, colony, shape);
  else colony.chambers.push({ ...shape, foodSlot: -1 });
}

/** Queen chamber + Nursery: every egg gate the hint checks but storage. */
function readyToLay(world: WorldState, colony: ColonyRecord): void {
  addChamber(world, colony, ChamberType.Queen);
  addChamber(world, colony, ChamberType.Nursery);
}

/** Add `n` living ants of `task` to `colony`'s worker roster (or its larvae). */
function addAnts(
  world: WorldState,
  colony: ColonyRecord,
  n: number,
  role: 'worker' | 'fighter' | 'larva' | 'egg' = 'worker',
): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: colony.colonyId,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      task: role === 'fighter' ? AntTask.Fighting : AntTask.Idle,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      zone: Zone.Underground,
      lastMealTick: world.tick,
    });
    if (role === 'larva') {
      colony.larvae.push(id);
      colony.larvaeCount += 1;
    } else if (role === 'egg') {
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

/** Designate a FoodStorage chamber for `colonyId` (pending, not dug). */
function pendStorage(world: WorldState, colonyId: number, anchorX: number): void {
  world.pendingChambers[`${colonyId}:${anchorX}:9`] = {
    colonyId,
    chamberType: ChamberType.FoodStorage,
    anchorTileX: anchorX,
    anchorTileY: 9,
    width: 4,
    height: 3,
  };
}

/** The no-brood reserve: the queen, the new egg's larva, `workers` living workers. */
function noBroodReserve(workers: number): number {
  return QUEEN_FP + LARVA_FP + workers * WORKER_FP;
}

/** Storage capacity with `chambers` completed FoodStorage chambers. */
function capacity(chambers: number): number {
  return BASE_FOOD_STORAGE_CAPACITY + chambers * FOOD_CHAMBER_CAPACITY;
}

/** Fewest workers whose no-brood reserve tops `chambers` chambers' capacity. */
function workersToOutgrow(chambers: number): number {
  let w = 0;
  while (noBroodReserve(w) <= capacity(chambers)) w += 1;
  return w;
}

describe('eggReserveStorageShortfallFp (#395, V70)', () => {
  it('fighters count at the fighter profile', () => {
    // Both profiles eat the same over the runway today; the shortfall must still
    // read the fighter profile, as eggReserveFp does.
    const { world, colony } = scenario();
    addAnts(world, colony, 40, 'fighter');
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(
      QUEEN_FP +
        LARVA_FP +
        START_WORKERS * WORKER_FP +
        40 * runwayFoodFp(FIGHTER_HUNGER, RUNWAY) -
        capacity(0),
    );
  });

  // 0 chambers: short even with no workers (the next test).
  it.each([1, 2, 3])('is the no-brood reserve less capacity, %i FoodStorage chambers', (n) => {
    // Just under the edge storage covers it; at the edge it is short by the exact gap.
    const edge = workersToOutgrow(n);
    for (const workers of [START_WORKERS, edge - 1, edge]) {
      const { world, colony } = scenario();
      for (let i = 0; i < n; i++) addChamber(world, colony, ChamberType.FoodStorage);
      addAnts(world, colony, workers - START_WORKERS);
      const gap = noBroodReserve(workers) - capacity(n);
      expect(eggReserveStorageShortfallFp(world, colony)).toBe(gap > 0 ? gap : 0);
    }
    expect(noBroodReserve(edge - 1)).toBeLessThanOrEqual(capacity(n));
    expect(noBroodReserve(edge)).toBeGreaterThan(capacity(n));
  });

  it('the pool alone never covers it, even with no workers', () => {
    const { world, colony } = scenario();
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(
      noBroodReserve(START_WORKERS) - capacity(0),
    );
    for (const id of [...colony.workers]) despawnAnt(world, id, { cause: 'starvation' });
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(noBroodReserve(0) - capacity(0));
    expect(noBroodReserve(0)).toBeGreaterThan(capacity(0));
  });

  it('brood already laid does not count (the larder brood ceiling is not a build problem)', () => {
    const { world, colony } = scenario();
    addChamber(world, colony, ChamberType.FoodStorage);
    addAnts(world, colony, 10, 'larva');
    addAnts(world, colony, 6, 'egg');
    // The full reserve tops the one chamber; the no-brood reserve does not.
    expect(eggReserveFp(world, colony)).toBeGreaterThan(capacity(1));
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(0);
  });

  it('dead workers still on the roster do not count', () => {
    const { world, colony } = scenario();
    addChamber(world, colony, ChamberType.FoodStorage);
    const edge = workersToOutgrow(1);
    const ids = addAnts(world, colony, edge - START_WORKERS);
    expect(eggReserveStorageShortfallFp(world, colony)).toBeGreaterThan(0);
    despawnAnt(world, ids[0]!, { cause: 'starvation' });
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(0);
  });

  it('pending FoodStorage does not count as capacity', () => {
    const { world, colony } = scenario();
    pendStorage(world, PLAYER_COLONY_ID, 30);
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(
      noBroodReserve(START_WORKERS) - capacity(0),
    );
  });

  it('is 0 before V70 (no egg reserve; the hint never shows on an older save)', () => {
    const { world, colony } = scenario(SIM_VERSION_V69_FOOD_FAIRNESS);
    expect(eggReserveStorageShortfallFp(world, colony)).toBe(0);
  });

  it('reads each colony alone (CLNY-08): the enemy colony the same way', () => {
    const { world } = scenario();
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    addChamber(world, enemy, ChamberType.FoodStorage);
    expect(eggReserveStorageShortfallFp(world, enemy)).toBe(0);
    expect(eggReserveStorageShortfallFp(world, world.colonies[PLAYER_COLONY_ID]!)).toBe(
      noBroodReserve(START_WORKERS) - capacity(0),
    );
  });
});

describe('storageHintCondition', () => {
  it('neither before the Queen chamber and Nursery are both done', () => {
    const { world, colony } = scenario();
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
    addChamber(world, colony, ChamberType.Queen);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
    addChamber(world, colony, ChamberType.Nursery);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
  });

  it('neither with a Nursery but no Queen chamber', () => {
    const { world, colony } = scenario();
    addChamber(world, colony, ChamberType.Nursery);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
  });

  it('neither when the queen is dead', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    despawnAnt(world, colony.queenEntityId, { cause: 'starvation' });
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
  });

  it('neither for a colony id with no colony', () => {
    const { world } = scenario();
    expect(storageHintCondition(world, 9)).toBe('neither');
  });

  it('covered once a FoodStorage chamber is completed', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    addChamber(world, colony, ChamberType.FoodStorage);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
  });

  it('covered does not need a Queen chamber, Nursery or living queen', () => {
    const { world, colony } = scenario();
    addChamber(world, colony, ChamberType.FoodStorage);
    despawnAnt(world, colony.queenEntityId, { cause: 'starvation' });
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
  });

  it('a pending FoodStorage of the colony silences it; another colony’s does not', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    pendStorage(world, ENEMY_COLONY_ID, 30);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
    pendStorage(world, PLAYER_COLONY_ID, 30);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
  });

  it('a pending chamber of another type does not silence it', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    world.pendingChambers[`${PLAYER_COLONY_ID}:30:9`] = {
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.Nursery,
      anchorTileX: 30,
      anchorTileY: 9,
      width: 4,
      height: 3,
    };
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
  });

  it('a colony outgrown its chambers: blocked until enough are pending', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    addChamber(world, colony, ChamberType.FoodStorage);
    // Past one more chamber's worth: one pending chamber is not enough, two are.
    const workers = workersToOutgrow(2);
    addAnts(world, colony, workers - START_WORKERS);
    expect(eggReserveStorageShortfallFp(world, colony)).toBeGreaterThan(FOOD_CHAMBER_CAPACITY);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
    pendStorage(world, PLAYER_COLONY_ID, 30);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
    pendStorage(world, PLAYER_COLONY_ID, 36);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('neither');
  });

  it('the edge of one chamber: covered one worker under, blocked at it', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    addChamber(world, colony, ChamberType.FoodStorage);
    const edge = workersToOutgrow(1);
    addAnts(world, colony, edge - 1 - START_WORKERS);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
    addAnts(world, colony, 1);
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('blocked');
  });

  it('a big brood in an adequate larder is covered (not a build problem)', () => {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    addChamber(world, colony, ChamberType.FoodStorage);
    addAnts(world, colony, 12, 'larva');
    expect(storageHintCondition(world, PLAYER_COLONY_ID)).toBe('covered');
  });
});

describe('advanceStorageHint', () => {
  beforeEach(() => resetCaptions());

  /** A world where storage blocks the queen, and a switch to cover it. */
  function blockedWorld(): {
    world: WorldState;
    cover: () => void;
    uncover: () => void;
    neither: () => void;
  } {
    const { world, colony } = scenario();
    readyToLay(world, colony);
    // One completed chamber and one worker past its edge: removing that worker covers.
    addChamber(world, colony, ChamberType.FoodStorage);
    const edge = workersToOutgrow(1);
    addAnts(world, colony, edge - 1 - START_WORKERS);
    let extra: number | null = addAnts(world, colony, 1)[0]!;
    return {
      world,
      cover: () => {
        if (extra !== null) despawnAnt(world, extra, { cause: 'starvation' });
        extra = null;
      },
      uncover: () => {
        if (extra === null) extra = addAnts(world, colony, 1)[0]!;
      },
      neither: () => pendStorage(world, PLAYER_COLONY_ID, 30),
    };
  }

  /** Run frames from tick `from` to `to` (inclusive); the captions shown. */
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

  it('shows once after blocking for the dwell, then not again', () => {
    const { world } = blockedWorld();
    const s = createStorageHintState();
    expect(run(s, world, 1000, 1000 + STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
    expect(run(s, world, 1000 + STORAGE_HINT_DWELL_TICKS, 5000)).toEqual([
      `${1000 + STORAGE_HINT_DWELL_TICKS}:${TEXT}`,
    ]);
  });

  it('a break in the blocking (a pending larder) restarts the dwell', () => {
    const { world, neither } = blockedWorld();
    const s = createStorageHintState();
    expect(run(s, world, 0, STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
    neither();
    expect(run(s, world, STORAGE_HINT_DWELL_TICKS, STORAGE_HINT_DWELL_TICKS)).toEqual([]);
    delete world.pendingChambers[`${PLAYER_COLONY_ID}:30:9`];
    const back = STORAGE_HINT_DWELL_TICKS + 1;
    expect(run(s, world, back, back + STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
    expect(run(s, world, back + STORAGE_HINT_DWELL_TICKS, back + STORAGE_HINT_DWELL_TICKS)).toEqual(
      [`${back + STORAGE_HINT_DWELL_TICKS}:${TEXT}`],
    );
  });

  it('a covered spell restarts the dwell too', () => {
    const { world, cover, uncover } = blockedWorld();
    const s = createStorageHintState();
    expect(run(s, world, 0, STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
    cover();
    expect(run(s, world, STORAGE_HINT_DWELL_TICKS, STORAGE_HINT_DWELL_TICKS)).toEqual([]);
    uncover();
    const back = STORAGE_HINT_DWELL_TICKS + 1;
    expect(run(s, world, back, back + STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
  });

  it('re-arms only after storage covers the reserve for the re-arm time', () => {
    const { world, cover, uncover } = blockedWorld();
    const s = createStorageHintState();
    const t0 = STORAGE_HINT_DWELL_TICKS;
    expect(run(s, world, 0, t0)).toEqual([`${t0}:${TEXT}`]);

    // Covered one tick short of the re-arm time, then blocked again: no second hint.
    cover();
    const c1 = t0 + 1;
    expect(run(s, world, c1, c1 + STORAGE_HINT_REARM_TICKS - 1)).toEqual([]);
    uncover();
    const b1 = c1 + STORAGE_HINT_REARM_TICKS;
    expect(run(s, world, b1, b1 + 3 * STORAGE_HINT_DWELL_TICKS)).toEqual([]);

    // Covered for the full re-arm time: blocked again shows it again, after the dwell.
    cover();
    const c2 = b1 + 3 * STORAGE_HINT_DWELL_TICKS + 1;
    expect(run(s, world, c2, c2 + STORAGE_HINT_REARM_TICKS)).toEqual([]);
    uncover();
    const b2 = c2 + STORAGE_HINT_REARM_TICKS + 1;
    expect(run(s, world, b2, b2 + STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
    expect(run(s, world, b2 + STORAGE_HINT_DWELL_TICKS, b2 + 2 * STORAGE_HINT_DWELL_TICKS)).toEqual(
      [`${b2 + STORAGE_HINT_DWELL_TICKS}:${TEXT}`],
    );
  });

  it('a neither spell between covered frames restarts the re-arm clock', () => {
    const { world, cover, uncover, neither } = blockedWorld();
    const s = createStorageHintState();
    const t0 = STORAGE_HINT_DWELL_TICKS;
    run(s, world, 0, t0);
    cover();
    const c1 = t0 + 1;
    run(s, world, c1, c1 + STORAGE_HINT_REARM_TICKS - 2);
    // One 'neither' frame (blocked, but a larder is pending) breaks the covered run.
    uncover();
    neither();
    run(s, world, c1 + STORAGE_HINT_REARM_TICKS - 1, c1 + STORAGE_HINT_REARM_TICKS - 1);
    delete world.pendingChambers[`${PLAYER_COLONY_ID}:30:9`];
    cover();
    const c2 = c1 + STORAGE_HINT_REARM_TICKS;
    run(s, world, c2, c2 + STORAGE_HINT_REARM_TICKS - 1);
    uncover();
    const b = c2 + STORAGE_HINT_REARM_TICKS;
    expect(run(s, world, b, b + 3 * STORAGE_HINT_DWELL_TICKS)).toEqual([]);
  });

  it('a caption the queue dropped (untriggered) shows again on the next blocked frame', () => {
    const { world } = blockedWorld();
    const s = createStorageHintState();
    const t0 = STORAGE_HINT_DWELL_TICKS;
    expect(run(s, world, 0, t0)).toEqual([`${t0}:${TEXT}`]);
    untrigger('foodStorageNeeded'); // UIScene: dropped on overflow
    expect(run(s, world, t0 + 1, t0 + 5)).toEqual([`${t0 + 1}:${TEXT}`]);
  });

  it('a tick that goes back (a load) restarts the dwell rather than firing at once', () => {
    const { world } = blockedWorld();
    const s = createStorageHintState();
    run(s, world, 5000, 5000 + STORAGE_HINT_DWELL_TICKS - 1);
    expect(run(s, world, 100, 100 + STORAGE_HINT_DWELL_TICKS - 1)).toEqual([]);
    expect(run(s, world, 100 + STORAGE_HINT_DWELL_TICKS, 100 + STORAGE_HINT_DWELL_TICKS)).toEqual([
      `${100 + STORAGE_HINT_DWELL_TICKS}:${TEXT}`,
    ]);
  });

  it('a tick that goes back restarts the re-arm clock too', () => {
    const { world, cover, uncover } = blockedWorld();
    const s = createStorageHintState();
    run(s, world, 0, STORAGE_HINT_DWELL_TICKS);
    cover();
    run(s, world, 9000, 9000 + STORAGE_HINT_REARM_TICKS - 2);
    // Load an older save: the covered clock restarts at the earlier tick, so the
    // full re-arm time from there re-arms it.
    run(s, world, 300, 300 + STORAGE_HINT_REARM_TICKS);
    uncover();
    const b = 300 + STORAGE_HINT_REARM_TICKS + 1;
    expect(run(s, world, b, b + STORAGE_HINT_DWELL_TICKS)).toEqual([
      `${b + STORAGE_HINT_DWELL_TICKS}:${TEXT}`,
    ]);
  });

  it('never shows on a V69 save', () => {
    const { world, colony } = scenario(SIM_VERSION_V69_FOOD_FAIRNESS);
    readyToLay(world, colony);
    const s = createStorageHintState();
    expect(run(s, world, 0, 3 * STORAGE_HINT_DWELL_TICKS)).toEqual([]);
  });

  it('the enemy colony blocked does not show the player the hint', () => {
    const { world } = scenario();
    readyToLay(world, world.colonies[ENEMY_COLONY_ID]!);
    // Player colony: no Queen chamber or Nursery (neither).
    const s = createStorageHintState();
    expect(run(s, world, 0, 3 * STORAGE_HINT_DWELL_TICKS)).toEqual([]);
    expect(storageHintCondition(world, ENEMY_COLONY_ID)).toBe('blocked');
  });
});
