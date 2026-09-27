// raid-orders.test.ts — #352 (V60): raid orders. A rally on an enemy entrance
// carries a raid type — Loot, Deny, Spoil, Blockade or Assault — stored on the
// colony, and its fighters act by it.
//
// Driven through tick() on the raid world (raid-test-utils.ts) so step 10c (the
// blockade hand-off), 10c2 (updateBlockaders), 10e (updateRaiders: loot / Deny drop
// / Assault target), 16 (movement, the shaft rules) and 16e (tickRaidActions: take /
// spoil / deposit) run at their real call sites. Each type is pinned against what
// the others (and Loot) do in the same setup, so a type that fell back to Loot
// fails its test.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import {
  copyWorldState,
  createWorldState,
  SIM_VERSION_V59_INVADER_RETARGET,
  SIM_VERSION_V60_RAID_ORDERS,
  type WorldState,
} from './types.js';
import {
  fighterMayLoot,
  tickRaidActions,
  updateBlockaders,
  updateRaiders,
} from './ant/ant-system.js';
import { createScenario } from './scenario.js';
import { blockaderPassesThroughFriends, blockaderRoutesToTarget } from './ant/ant-blockade.js';
import { AntTask, FightingSubState, RaidType } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT } from './fixed.js';
import {
  chamberStock,
  colonyPoolFood,
  pileAmountFp,
  pileAtTile,
  pileCount,
  pileSlotAt,
  pileTileX,
  pileTileY,
} from './food/food-api.js';
import {
  addPileForTest,
  setChamberStockForTest,
  setPoolFoodForTest,
} from './food/food-test-utils.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  BLOCKADE_LEASH_TILES,
  BLOCKADE_POST_RADIUS_TILES,
  BLOCKADE_RADIUS_TILES,
  ENEMY_COLONY_ID,
  FOOD_CHAMBER_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  PLAYER_COLONY_ID,
  RAID_CARRY_FP,
  RAID_ENGAGE_RADIUS_TILES,
  SPOIL_TICKS_PER_LOAD,
} from './constants.js';
import {
  addEnemyWorker,
  addFighter,
  addHauler,
  centre,
  freeSurfaceTile,
  raidWorld,
  rallyOn,
  type RaidWorld,
} from './raid-test-utils.js';
import { initAnt } from './ant/ant-store.js';
import { allocateEntityId } from './types.js';
import { getScratch } from './scratch.js';

const E = ENEMY_COLONY_ID;
/** A non-integer raid type (no float literal in src/sim/). */
const FP_HALF_FRACTION = Number.parseFloat('0' + '.5');
const P = PLAYER_COLONY_ID;

function tileOf(world: WorldState, id: number): { x: number; y: number } {
  return { x: world.ants.posX[id]! >> FP_SHIFT, y: world.ants.posY[id]! >> FP_SHIFT };
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function run(world: WorldState, ticks: number, until?: () => boolean, before?: () => void): number {
  for (let t = 0; t < ticks; t++) {
    before?.();
    tick(world, []);
    if (until?.()) return t + 1;
  }
  return -1;
}

/** Rally the player on the enemy door with raid type `type` (as the command does). */
function order(r: RaidWorld, type: RaidType): void {
  rallyOn(r.player, r.enemyDoor);
  r.player.raidType = type;
}

/** Fill the player's pool and larder and keep its queen and larvae from eating. */
function fillPlayerStores(r: RaidWorld): void {
  const w = r.world;
  setPoolFoodForTest(w, r.player, BASE_FOOD_STORAGE_CAPACITY);
  setChamberStockForTest(w, r.player, r.playerLarder, FOOD_CHAMBER_CAPACITY);
  w.ants.lastMealTick[r.player.queenEntityId] = w.tick;
  for (const l of r.player.larvae) w.ants.lastMealTick[l] = w.tick;
}

/** Keep the enemy queen and larvae fed, so the enemy larder changes only by the raid. */
function feedEnemy(r: RaidWorld): void {
  const w = r.world;
  w.ants.lastMealTick[r.enemy.queenEntityId] = w.tick;
  for (const l of r.enemy.larvae) w.ants.lastMealTick[l] = w.tick;
}

/** Add a motionless enemy FIGHTER on the surface at (x, y). */
function addEnemySurfaceAnt(
  world: WorldState,
  x: number,
  y: number,
  task: AntTask = AntTask.Fighting,
): number {
  const colony = world.colonies[E]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: E,
    posX: centre(x),
    posY: centre(y),
    task,
    subTask: 0,
    speed: 0,
    zone: Zone.Surface,
    lastMealTick: world.tick - 1,
  });
  colony.workers.push(id);
  colony.workerCount += 1;
  // Keep a fighter Fighting: the small-colony stand-down releases fighters past
  // the ratio's allocation, so ask for every fighter the colony has.
  let fight = 0;
  for (const w of colony.workers) if (world.ants.task[w] === AntTask.Fighting) fight += 1;
  colony.targetRatio.fight = fight;
  colony.targetRatio.forage = colony.workers.length - fight;
  return id;
}

// ---------------------------------------------------------------------------
// The order itself: command, colony record, copy.
// ---------------------------------------------------------------------------

describe('the raid order on the colony (V60)', () => {
  it('SetRallyPoint carries the raid type; absent is Loot; a cleared rally resets it', () => {
    const r = raidWorld();
    const w = r.world;
    expect(r.player.raidType).toBe(RaidType.Loot);
    const at = { colonyId: P, tileX: r.enemyDoor.x, tileY: r.enemyDoor.y, issuedAtTick: 0 };
    tick(w, [{ type: 'SetRallyPoint', ...at, raidType: RaidType.Deny }]);
    expect(r.player.raidType).toBe(RaidType.Deny);
    expect(r.player.rallyPoint).toEqual({ tileX: r.enemyDoor.x, tileY: r.enemyDoor.y });
    // Choosing again on the same entrance changes the type.
    tick(w, [{ type: 'SetRallyPoint', ...at, raidType: RaidType.Blockade }]);
    expect(r.player.raidType).toBe(RaidType.Blockade);
    // A plain tap (no type) is Loot.
    tick(w, [{ type: 'SetRallyPoint', ...at }]);
    expect(r.player.raidType).toBe(RaidType.Loot);
    tick(w, [{ type: 'SetRallyPoint', ...at, raidType: RaidType.Assault }]);
    tick(w, [{ type: 'ClearRallyPoint', colonyId: P, issuedAtTick: 0 }]);
    expect(r.player.rallyPoint).toBeNull();
    expect(r.player.raidType).toBe(RaidType.Loot);
  });

  it('a malformed raid type drops the whole command', () => {
    const r = raidWorld();
    const w = r.world;
    const at = { colonyId: P, tileX: r.enemyDoor.x, tileY: r.enemyDoor.y, issuedAtTick: 0 };
    for (const bad of [5, -1, 3 + FP_HALF_FRACTION, Number.NaN, '1', null]) {
      tick(w, [{ type: 'SetRallyPoint', ...at, raidType: bad as unknown as RaidType }]);
      expect(r.player.rallyPoint).toBeNull();
      expect(r.player.raidType).toBe(RaidType.Loot);
    }
  });

  it('below V60 the raid type is ignored: the rally is set, the colony stays Loot', () => {
    const r = raidWorld();
    const w = r.world;
    w.simVersion = SIM_VERSION_V59_INVADER_RETARGET;
    const at = { colonyId: P, tileX: r.enemyDoor.x, tileY: r.enemyDoor.y, issuedAtTick: 0 };
    tick(w, [{ type: 'SetRallyPoint', ...at, raidType: RaidType.Spoil }]);
    expect(r.player.rallyPoint).toEqual({ tileX: r.enemyDoor.x, tileY: r.enemyDoor.y });
    expect(r.player.raidType).toBe(RaidType.Loot);
    // Nor does a stored type act below V60 (a hand-set one here).
    r.player.raidType = RaidType.Assault;
    const id = addFighter(w, P, 100, 6, E);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
  });

  it('copyWorldState copies the raid type', () => {
    const r = raidWorld();
    r.player.raidType = RaidType.Spoil;
    const dst = createWorldState(1);
    copyWorldState(r.world, dst);
    expect(dst.colonies[P]!.raidType).toBe(RaidType.Spoil);
    r.player.raidType = RaidType.Loot;
    copyWorldState(r.world, dst);
    expect(dst.colonies[P]!.raidType).toBe(RaidType.Loot);
  });

  it('the AI colony is no different: its rally carries a type the same way (CLNY-08)', () => {
    const r = raidWorld();
    const at = { colonyId: E, tileX: r.playerDoor.x, tileY: r.playerDoor.y, issuedAtTick: 0 };
    tick(r.world, [{ type: 'SetRallyPoint', ...at, raidType: RaidType.Spoil }]);
    expect(r.enemy.raidType).toBe(RaidType.Spoil);
  });
});

// ---------------------------------------------------------------------------
// The loot predicate per type.
// ---------------------------------------------------------------------------

describe('who may loot, per raid type (V60)', () => {
  function verdicts(full: boolean): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [name, type] of Object.entries(RaidType)) {
      const r = raidWorld(3000);
      order(r, type);
      const id = addFighter(r.world, P, 100, 6, E);
      if (full) fillPlayerStores(r);
      out[name] = fighterMayLoot(r.world, r.player, id);
    }
    return out;
  }

  it('with room at home: Loot, Deny and Spoil loot; Blockade and Assault do not', () => {
    expect(verdicts(false)).toEqual({
      Loot: true,
      Deny: true,
      Spoil: true,
      Blockade: false,
      Assault: false,
    });
  });

  it('with the stores full: only Deny and Spoil still go for the larder (Loot is the V53 raid)', () => {
    expect(verdicts(true)).toEqual({
      Loot: false,
      Deny: true,
      Spoil: true,
      Blockade: false,
      Assault: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Deny.
// ---------------------------------------------------------------------------

describe('Deny (V60)', () => {
  it('steals with full stores, carries it home and drops it as a pile beside its own entrance', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Deny);
    const id = addFighter(w, P, 100, 6, E);
    const keep = (): void => {
      fillPlayerStores(r);
      feedEnemy(r);
    };
    expect(
      run(w, 200, () => w.ants.subTask[id] === FightingSubState.Hauling, keep),
    ).toBeGreaterThan(0);
    expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP);
    expect(r.player.foodRaidedFp).toBe(RAID_CARRY_FP);
    const piles = pileCount(w);
    // Home: it drops at the door and turns back, never going down its own shaft.
    let wentDown = false;
    const done = run(
      w,
      2000,
      () => {
        if (w.ants.zone[id] === Zone.Underground && w.ants.currentGridColonyId[id] === P) {
          wentDown = true;
        }
        return w.ants.foodCarrying[id] === 0;
      },
      keep,
    );
    expect(done).toBeGreaterThan(0);
    expect(wentDown).toBe(false);
    expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    expect(r.player.raidTrips).toBe(1);
    // The new pile: RAID_CARRY_FP (two whole pickups) within a tile of the door, not on it.
    expect(pileCount(w)).toBe(piles + 1);
    const slot = pileSlotAt(w, pileCount(w) - 1);
    const at = { x: pileTileX(w, slot), y: pileTileY(w, slot) };
    expect(Math.abs(at.x - r.playerDoor.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(at.y - r.playerDoor.y)).toBeLessThanOrEqual(1);
    expect(at).not.toEqual(r.playerDoor);
    expect(pileAmountFp(w, slot)).toBe(RAID_CARRY_FP);
    // The stores were full all along: nothing went in.
    expect(colonyPoolFood(w, r.player)).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(chamberStock(w, r.playerLarder)).toBe(FOOD_CHAMBER_CAPACITY);
  });

  it('with room at home it deposits like Loot (no pile)', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    const x = r.playerDoor.x + 1;
    const id = addHauler(w, P, x, r.playerDoor.y, null, RAID_CARRY_FP);
    const piles = pileCount(w);
    updateRaiders(w);
    expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP);
    expect(pileCount(w)).toBe(piles);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
  });

  it('Loot at the same door with full stores keeps its load (it parks until there is room)', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Loot);
    fillPlayerStores(r);
    const id = addHauler(w, P, r.playerDoor.x + 1, r.playerDoor.y, null, RAID_CARRY_FP);
    const piles = pileCount(w);
    updateRaiders(w);
    expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP);
    expect(pileCount(w)).toBe(piles);
  });

  it('drops only within a tile of an open entrance of its own', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    fillPlayerStores(r);
    const far = addHauler(w, P, r.playerDoor.x + 2, r.playerDoor.y, null, RAID_CARRY_FP);
    const diag = addHauler(w, P, r.playerDoor.x - 1, r.playerDoor.y + 1, null, RAID_CARRY_FP);
    updateRaiders(w);
    expect(w.ants.foodCarrying[far]).toBe(RAID_CARRY_FP);
    expect(w.ants.foodCarrying[diag]).toBe(0);
    expect(pileAtTile(w, r.playerDoor.x - 1, r.playerDoor.y + 1)).toBeGreaterThanOrEqual(0);
  });

  it('on the entrance tile itself it drops on a free neighbour, never on the shaft', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    fillPlayerStores(r);
    const id = addHauler(w, P, r.playerDoor.x, r.playerDoor.y, null, RAID_CARRY_FP);
    updateRaiders(w);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(pileAtTile(w, r.playerDoor.x, r.playerDoor.y)).toBe(-1);
    let found = 0;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      if (pileAtTile(w, r.playerDoor.x + dx, r.playerDoor.y + dy) >= 0) found += 1;
    }
    expect(found).toBe(1);
  });

  /** A full pile (FOOD_PILE_INITIAL_PICKUPS_MAX pickups) at (x, y). */
  function fullPile(w: WorldState, x: number, y: number): void {
    addPileForTest(w, {
      foodPileId: allocateEntityId(w),
      tileX: x,
      tileY: y,
      pickupsRemaining: FOOD_PILE_INITIAL_PICKUPS_MAX,
      pickupsInitial: FOOD_PILE_INITIAL_PICKUPS_MAX,
    });
  }

  it('never drops onto a full pile: it takes a free neighbour, else keeps its load (no trip)', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    fillPlayerStores(r);
    const x = r.playerDoor.x - 1;
    const y = r.playerDoor.y + 1;
    fullPile(w, x, y);
    const id = addHauler(w, P, x, y, null, RAID_CARRY_FP);
    updateRaiders(w);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(r.player.raidTrips).toBe(1);
    let placed = 0;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const slot = pileAtTile(w, x + dx, y + dy);
      if (slot >= 0) placed += pileAmountFp(w, slot);
    }
    expect(placed).toBe(RAID_CARRY_FP);
    // Every candidate tile full: it keeps its load and counts no trip.
    const r2 = raidWorld();
    const w2 = r2.world;
    order(r2, RaidType.Deny);
    fillPlayerStores(r2);
    const x2 = r2.playerDoor.x - 1;
    const y2 = r2.playerDoor.y + 1;
    fullPile(w2, x2, y2);
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      if (pileAtTile(w2, x2 + dx, y2 + dy) < 0) fullPile(w2, x2 + dx, y2 + dy);
    }
    const id2 = addHauler(w2, P, x2, y2, null, RAID_CARRY_FP);
    updateRaiders(w2);
    expect(w2.ants.foodCarrying[id2]).toBe(RAID_CARRY_FP);
    expect(r2.player.raidTrips).toBe(0);
  });

  it('a load under one pickup is let go without a pile or a trip', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    fillPlayerStores(r);
    const piles = pileCount(w);
    const id = addHauler(
      w,
      P,
      r.playerDoor.x - 1,
      r.playerDoor.y + 1,
      null,
      FOOD_PICKUP_AMOUNT - 1,
    );
    updateRaiders(w);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    expect(pileCount(w)).toBe(piles);
    expect(r.player.raidTrips).toBe(0);
  });

  it('at its shaft top with only the pool full it walks on to the larder (no pile)', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    setPoolFoodForTest(w, r.player, BASE_FOOD_STORAGE_CAPACITY);
    setChamberStockForTest(w, r.player, r.playerLarder, 0);
    const piles = pileCount(w);
    const id = addHauler(w, P, r.playerDoor.x, 0, P, RAID_CARRY_FP);
    tickRaidActions(w);
    expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP);
    expect(pileCount(w)).toBe(piles);
    const keep = (): void => {
      w.ants.lastMealTick[r.player.queenEntityId] = w.tick;
      for (const l of r.player.larvae) w.ants.lastMealTick[l] = w.tick;
      w.ants.lastMealTick[id] = w.tick;
    };
    expect(run(w, 400, () => w.ants.foodCarrying[id] === 0, keep)).toBeGreaterThan(0);
    expect(chamberStock(w, r.playerLarder)).toBe(RAID_CARRY_FP);
    expect(pileCount(w)).toBe(piles);
    expect(r.player.raidTrips).toBe(1);
  });

  it('in its larder with every store full it walks back up its shaft and drops by the door', () => {
    const r = raidWorld();
    const w = r.world;
    order(r, RaidType.Deny);
    const piles = pileCount(w);
    const l = r.playerLarder;
    const id = addHauler(
      w,
      P,
      (l.posX >> FP_SHIFT) + 1,
      (l.posY >> FP_SHIFT) + 1,
      P,
      RAID_CARRY_FP,
    );
    const done = run(
      w,
      600,
      () => w.ants.foodCarrying[id] === 0,
      () => {
        fillPlayerStores(r);
        w.ants.lastMealTick[id] = w.tick;
      },
    );
    expect(done).toBeGreaterThan(0);
    expect(r.player.raidTrips).toBe(1);
    expect(pileCount(w)).toBe(piles + 1);
    const slot = pileSlotAt(w, pileCount(w) - 1);
    expect(manhattan({ x: pileTileX(w, slot), y: pileTileY(w, slot) }, r.playerDoor)).toBe(1);
  });

  it('down its own shaft with no room after all, it leaves the load outside by the door (Loot waits)', () => {
    for (const type of [RaidType.Deny, RaidType.Loot]) {
      const r = raidWorld();
      const w = r.world;
      order(r, type);
      fillPlayerStores(r);
      const piles = pileCount(w);
      const id = addHauler(w, P, r.playerDoor.x, 0, P, RAID_CARRY_FP);
      tickRaidActions(w);
      if (type === RaidType.Deny) {
        expect(w.ants.foodCarrying[id]).toBe(0);
        expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
        expect(r.player.raidTrips).toBe(1);
        expect(pileCount(w)).toBe(piles + 1);
        const slot = pileSlotAt(w, pileCount(w) - 1);
        const at = { x: pileTileX(w, slot), y: pileTileY(w, slot) };
        expect(manhattan(at, r.playerDoor)).toBe(1);
      } else {
        expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP);
        expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
        expect(pileCount(w)).toBe(piles);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Spoil.
// ---------------------------------------------------------------------------

describe('Spoil (V60)', () => {
  it('destroys one load per SPOIL_TICKS_PER_LOAD ticks in place and never hauls', () => {
    const r = raidWorld(5000);
    const w = r.world;
    order(r, RaidType.Spoil);
    const id = addFighter(w, P, 100, 6, E);
    // Reaches the larder and destroys a first load.
    expect(
      run(
        w,
        300,
        () => chamberStock(w, r.enemyLarder) < 5000,
        () => feedEnemy(r),
      ),
    ).toBeGreaterThan(0);
    expect(chamberStock(w, r.enemyLarder)).toBe(5000 - RAID_CARRY_FP);
    // Then exactly one more per SPOIL_TICKS_PER_LOAD ticks.
    for (let k = 2; k <= 4; k++) {
      run(w, SPOIL_TICKS_PER_LOAD, undefined, () => feedEnemy(r));
      expect(chamberStock(w, r.enemyLarder)).toBe(5000 - k * RAID_CARRY_FP);
    }
    expect(w.ants.subTask[id]).toBe(FightingSubState.Looting);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(w.ants.zone[id]).toBe(Zone.Underground);
    // Lost to the victim, gained by nobody.
    expect(r.enemy.foodLostToRaidsFp).toBe(4 * RAID_CARRY_FP);
    expect(r.player.foodRaidedFp).toBe(0);
    expect(r.player.raidTrips).toBe(0);
  });

  it('spoils even with the raider’s own stores full', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Spoil);
    addFighter(w, P, 88, 6, E);
    run(w, SPOIL_TICKS_PER_LOAD + 1, undefined, () => {
      fillPlayerStores(r);
      feedEnemy(r);
    });
    expect(chamberStock(w, r.enemyLarder)).toBe(3000 - RAID_CARRY_FP);
  });

  it('two spoilers on one larder each destroy a load per beat', () => {
    const r = raidWorld(5000);
    const w = r.world;
    order(r, RaidType.Spoil);
    addFighter(w, P, 88, 6, E);
    addFighter(w, P, 87, 6, E);
    run(w, SPOIL_TICKS_PER_LOAD, undefined, () => feedEnemy(r));
    expect(chamberStock(w, r.enemyLarder)).toBe(5000 - 2 * RAID_CARRY_FP);
  });
});

// ---------------------------------------------------------------------------
// Assault.
// ---------------------------------------------------------------------------

describe('Assault (V60)', () => {
  it('ignores a stocked larder and goes for the queen, past a nearer enemy worker', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Assault);
    const id = addFighter(w, P, 100, 6, E);
    // A nearer hostile the other way: the ordinary hunt would go at it (x 95).
    addEnemyWorker(w, 95, 6);
    const q = r.enemy.queenEntityId;
    const d0 = manhattan(tileOf(w, id), tileOf(w, q));
    run(w, 30, undefined, () => feedEnemy(r));
    expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(chamberStock(w, r.enemyLarder)).toBe(3000);
    expect(manhattan(tileOf(w, id), tileOf(w, q))).toBeLessThan(d0);
    expect(tileOf(w, id).x).toBeGreaterThan(100);
  });

  it('step 10e points it at the queen; in a duel it stays on its fight', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Assault);
    const id = addFighter(w, P, 100, 6, E);
    const q = r.enemy.queenEntityId;
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(w.ants.posX[q]);
    expect(w.ants.targetPosY[id]).toBe(w.ants.posY[q]);
    const foe = addEnemyWorker(w, 100, 6);
    w.ants.combatOpponentId[id] = foe;
    w.ants.targetPosX[id] = -1;
    w.ants.targetPosY[id] = -1;
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(-1);
  });

  it('Loot in the same spot takes the larder instead', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Loot);
    const id = addFighter(w, P, 100, 6, E);
    addEnemyWorker(w, 60, 6); // far out of reach, so it may loot
    run(
      w,
      200,
      () => w.ants.subTask[id] === FightingSubState.Hauling,
      () => feedEnemy(r),
    );
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
  });
});

// ---------------------------------------------------------------------------
// Nothing left: Loot, Deny and Spoil press on to the queen.
// ---------------------------------------------------------------------------

describe('with nothing left to take Loot, Deny and Spoil go for the queen first (V60)', () => {
  const ALL = [RaidType.Loot, RaidType.Deny, RaidType.Spoil] as const;
  for (const type of ALL) {
    it(`raid type ${type}: queen-first, past a nearer enemy worker the hunt would take`, () => {
      const r = raidWorld(0);
      const w = r.world;
      order(r, type);
      const id = addFighter(w, P, 100, 6, E);
      addEnemyWorker(w, 95, 6); // nearer, the other way: the V59 hunt goes at it
      const q = r.enemy.queenEntityId;
      updateRaiders(w);
      expect(w.ants.targetPosX[id]).toBe(w.ants.posX[q]);
      expect(w.ants.targetPosY[id]).toBe(w.ants.posY[q]);
      const d0 = manhattan(tileOf(w, id), tileOf(w, q));
      run(w, 30, undefined, () => feedEnemy(r));
      expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
      expect(manhattan(tileOf(w, id), tileOf(w, q))).toBeLessThan(d0);
      expect(tileOf(w, id).x).toBeGreaterThan(100);
    });
  }

  it('below V60 the same raider is left to the hunt (no aim from step 10e)', () => {
    const r = raidWorld(0);
    const w = r.world;
    w.simVersion = SIM_VERSION_V59_INVADER_RETARGET;
    rallyOn(r.player, r.enemyDoor);
    const id = addFighter(w, P, 100, 6, E);
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(-1);
  });

  it('Loot with full stores: queen-first only once the larder is empty too', () => {
    const r = raidWorld(0);
    const w = r.world;
    order(r, RaidType.Loot);
    fillPlayerStores(r);
    const id = addFighter(w, P, 100, 6, E);
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(w.ants.posX[r.enemy.queenEntityId]);
    // A stocked larder it has no room for: it hunts, as the V53 raid did.
    const r2 = raidWorld(3000);
    const w2 = r2.world;
    order(r2, RaidType.Loot);
    fillPlayerStores(r2);
    const id2 = addFighter(w2, P, 100, 6, E);
    updateRaiders(w2);
    expect(w2.ants.targetPosX[id2]).toBe(-1);
  });

  it('a stocked larder: none of them is sent at the queen', () => {
    for (const type of ALL) {
      const r = raidWorld(3000);
      const w = r.world;
      order(r, type);
      const id = addFighter(w, P, 100, 6, E);
      updateRaiders(w);
      expect(w.ants.targetPosX[id]).not.toBe(w.ants.posX[r.enemy.queenEntityId]);
    }
  });
});

describe('the queen held by a friend: a free enemy worker in sight first (V60)', () => {
  /** A raid world with the player's `type` order, the larder empty (so Loot, Deny
   *  and Spoil are queen-first), a player fighter already on the queen's tile, and
   *  the raider under test at (110, 6). */
  function held(type: RaidType): { r: RaidWorld; id: number; q: number } {
    const r = raidWorld(0);
    const w = r.world;
    order(r, type);
    const q = r.enemy.queenEntityId;
    addFighter(w, P, w.ants.posX[q]! >> FP_SHIFT, w.ants.posY[q]! >> FP_SHIFT, E);
    const id = addFighter(w, P, 110, 6, E);
    return { r, id, q };
  }

  for (const type of [RaidType.Assault, RaidType.Loot, RaidType.Deny, RaidType.Spoil]) {
    it(`raid type ${type}: a free worker within sight is attacked; out of sight, it queues for the queen`, () => {
      const a = held(type);
      const near = addEnemyWorker(a.r.world, 110 - RAID_ENGAGE_RADIUS_TILES, 6);
      updateRaiders(a.r.world);
      expect(a.r.world.ants.targetPosX[a.id]).toBe(a.r.world.ants.posX[near]);
      const b = held(type);
      addEnemyWorker(b.r.world, 110 - RAID_ENGAGE_RADIUS_TILES - 1, 6);
      updateRaiders(b.r.world);
      expect(b.r.world.ants.targetPosX[b.id]).toBe(b.r.world.ants.posX[b.q]);
    });
  }

  it('an enemy fighter, or a worker on a tile a friend holds, is not a free worker', () => {
    const a = held(RaidType.Assault);
    const w = a.r.world;
    const fighter = addEnemyWorker(w, 108, 6);
    w.ants.task[fighter] = AntTask.Fighting;
    updateRaiders(w);
    expect(w.ants.targetPosX[a.id]).toBe(w.ants.posX[a.q]);
    const b = held(RaidType.Assault);
    const w2 = b.r.world;
    addEnemyWorker(w2, 108, 6);
    addFighter(w2, P, 108, 6, E); // a friend already on that worker
    updateRaiders(w2);
    expect(w2.ants.targetPosX[b.id]).toBe(w2.ants.posX[b.q]);
  });

  it('with the queen’s tile free it goes for her, past a free worker in sight', () => {
    const r = raidWorld(0);
    const w = r.world;
    order(r, RaidType.Assault);
    const id = addFighter(w, P, 110, 6, E);
    addEnemyWorker(w, 108, 6);
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(w.ants.posX[r.enemy.queenEntityId]);
  });
});

// ---------------------------------------------------------------------------
// Blockade.
// ---------------------------------------------------------------------------

describe('Blockade (V60)', () => {
  /** `n` player fighters on the surface west of the enemy door. */
  function blockaders(r: RaidWorld, n: number): number[] {
    const ids: number[] = [];
    const y = r.enemyDoor.y;
    const x = freeSurfaceTile(r.world, y, r.enemyDoor.x - 14, 8);
    for (let i = 0; i < n; i++) ids.push(addFighter(r.world, P, x, y, null));
    return ids;
  }
  /** `n` player fighters on the surface just inside the leash, west of the door. */
  function blockadersNear(r: RaidWorld, n: number): number[] {
    const y = r.enemyDoor.y;
    const x = freeSurfaceTile(r.world, y, r.enemyDoor.x - BLOCKADE_LEASH_TILES + 1, 4);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(addFighter(r.world, P, x, y, null));
    return ids;
  }

  it('holds a ring of posts round the enemy entrance and never goes down', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const ids = blockaders(r, 4);
    let wentDown = false;
    run(w, 300, () => {
      for (const id of ids) if (w.ants.zone[id] !== Zone.Surface) wentDown = true;
      return false;
    });
    expect(wentDown).toBe(false);
    for (const id of ids) {
      const d = manhattan(tileOf(w, id), r.enemyDoor);
      expect(d).toBeGreaterThanOrEqual(BLOCKADE_POST_RADIUS_TILES - 2);
      expect(d).toBeLessThanOrEqual(BLOCKADE_POST_RADIUS_TILES + 2);
      expect(w.ants.subTask[id]).toBe(FightingSubState.Holding);
      expect(w.ants.targetPosX[id]).toBe(-1);
    }
    expect(chamberStock(w, r.enemyLarder)).toBeGreaterThan(0);
    expect(r.player.foodRaidedFp).toBe(0);
  });

  it('Loot from the same start goes down the enemy entrance', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Loot);
    const [id] = blockaders(r, 1);
    expect(run(w, 300, () => w.ants.zone[id!] === Zone.Underground)).toBeGreaterThan(0);
    expect(w.ants.currentGridColonyId[id!]).toBe(E);
  });

  it('goes for every enemy ant inside the radius, fighters included, and none outside it', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const [id] = blockaders(r, 1);
    run(w, 300, () => w.ants.subTask[id!] === FightingSubState.Holding);
    expect(w.ants.subTask[id!]).toBe(FightingSubState.Holding);
    const d = r.enemyDoor;
    // An enemy fighter just outside the radius (east of the door): left alone.
    const outside = addEnemySurfaceAnt(w, d.x + BLOCKADE_RADIUS_TILES + 1, d.y);
    tick(w, []);
    expect(w.ants.targetPosX[id!]).toBe(-1);
    // Inside the radius: chased — a fighter too.
    w.ants.posX[outside] = centre(d.x + BLOCKADE_RADIUS_TILES);
    tick(w, []);
    expect(w.ants.task[outside]).toBe(AntTask.Fighting);
    // (Compared by tile: the target is its position at step 10c2, before movement.)
    expect(w.ants.targetPosX[id!]! >> FP_SHIFT).toBe(w.ants.posX[outside] >> FP_SHIFT);
    expect(w.ants.targetPosY[id!]! >> FP_SHIFT).toBe(w.ants.posY[outside]! >> FP_SHIFT);
    // A forager too.
    const r2 = raidWorld(3000);
    order(r2, RaidType.Blockade);
    const [b] = blockaders(r2, 1);
    run(r2.world, 300, () => r2.world.ants.subTask[b!] === FightingSubState.Holding);
    const forager = addEnemySurfaceAnt(
      r2.world,
      r2.enemyDoor.x,
      r2.enemyDoor.y + 2,
      AntTask.Foraging,
    );
    tick(r2.world, []);
    expect(r2.world.ants.targetPosX[b!]).toBe(r2.world.ants.posX[forager]);
  });

  it('lets an enemy go once it leaves the radius and walks back to its post (leash)', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const [id] = blockaders(r, 1);
    run(w, 300, () => w.ants.subTask[id!] === FightingSubState.Holding);
    const post = tileOf(w, id!);
    const d = r.enemyDoor;
    const foe = addEnemySurfaceAnt(w, d.x + 4, d.y + 2);
    // Keep the foe just ahead of the blockader, then run it out of the radius.
    run(w, 6);
    expect(manhattan(tileOf(w, id!), post)).toBeGreaterThan(0);
    w.ants.posX[foe] = centre(d.x + BLOCKADE_RADIUS_TILES + 6);
    w.ants.posY[foe] = centre(d.y);
    expect(run(w, 200, () => w.ants.subTask[id!] === FightingSubState.Holding)).toBeGreaterThan(0);
    expect(manhattan(tileOf(w, id!), post)).toBeLessThanOrEqual(2);
    expect(manhattan(tileOf(w, id!), d)).toBeLessThanOrEqual(BLOCKADE_POST_RADIUS_TILES + 2);
  });

  it('chasing an enemy onto the entrance tile it still never goes down', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const ids = blockaders(r, 2);
    run(w, 300, () => ids.every((id) => w.ants.subTask[id] === FightingSubState.Holding));
    const foe = addEnemySurfaceAnt(w, r.enemyDoor.x, r.enemyDoor.y);
    w.ants.hp[foe] = 1_000_000; // it stays on the shaft tile for the whole test
    let onDoor = false;
    let wentDown = false;
    run(w, 200, () => {
      for (const id of ids) {
        if (w.ants.zone[id] !== Zone.Surface) wentDown = true;
        const t = tileOf(w, id);
        if (t.x === r.enemyDoor.x && t.y === r.enemyDoor.y) onDoor = true;
      }
      return false;
    });
    expect(onDoor).toBe(true);
    expect(wentDown).toBe(false);
  });

  it('a fighter already inside the enemy nest climbs out and takes a post', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const id = addFighter(w, P, 100, 6, E);
    expect(run(w, 300, () => w.ants.zone[id] === Zone.Surface)).toBeGreaterThan(0);
    expect(tileOf(w, id)).toEqual(r.enemyDoor);
    expect(run(w, 200, () => w.ants.subTask[id] === FightingSubState.Holding)).toBeGreaterThan(0);
    expect(w.ants.zone[id]).toBe(Zone.Surface);
  });

  it('takes no post on an entrance tile (any colony’s)', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const d = r.enemyDoor;
    // A (closed) enemy entrance on the first ring post, due north of the door.
    const nx = d.x;
    const ny = d.y - BLOCKADE_POST_RADIUS_TILES;
    r.enemy.entrances.push({
      entranceId: 999_999,
      surfaceTileX: nx,
      surfaceTileY: ny,
      isOpen: false,
    });
    const ids = blockadersNear(r, 12);
    tick(w, []);
    for (const id of ids) {
      expect([w.ants.targetPosX[id]! >> FP_SHIFT, w.ants.targetPosY[id]! >> FP_SHIFT]).not.toEqual([
        nx,
        ny,
      ]);
    }
  });

  it('beyond the leash it chases nothing and makes for the entrance, routed round obstacles', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const d = r.enemyDoor;
    const x = freeSurfaceTile(w, d.y, d.x - BLOCKADE_LEASH_TILES - 4, 3);
    const far = addFighter(w, P, x, d.y, null);
    const foe = addEnemySurfaceAnt(w, d.x + BLOCKADE_RADIUS_TILES - 1, d.y);
    tick(w, []);
    const t = { x: w.ants.targetPosX[far]! >> FP_SHIFT, y: w.ants.targetPosY[far]! >> FP_SHIFT };
    expect(t).toEqual(d);
    expect(blockaderRoutesToTarget(w, far)).toBe(true);
    // Inside the leash the same foe is chased (by tile: its target was set before
    // this tick's movement), in a straight line.
    w.ants.posX[far] = centre(d.x - BLOCKADE_LEASH_TILES + 1);
    tick(w, []);
    expect(w.ants.targetPosX[far]! >> FP_SHIFT).toBe(w.ants.posX[foe]! >> FP_SHIFT);
    expect(blockaderRoutesToTarget(w, far)).toBe(false);
  });

  it('posts are ranked in id order round the ring (one post each)', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    // Inside the leash, so each walks to its post (farther out it makes for the entrance).
    const ids = blockadersNear(r, 3);
    tick(w, []);
    const targets = ids.map((id) => [w.ants.targetPosX[id], w.ants.targetPosY[id]].join(','));
    expect(new Set(targets).size).toBe(3);
    for (const id of ids) {
      const t = {
        x: w.ants.targetPosX[id]! >> FP_SHIFT,
        y: w.ants.targetPosY[id]! >> FP_SHIFT,
      };
      expect(manhattan(t, r.enemyDoor)).toBe(BLOCKADE_POST_RADIUS_TILES);
    }
  });

  it('walks to its post routed round obstacles and passes through its own ants on the way', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const [id] = blockadersNear(r, 1);
    tick(w, []);
    expect(w.ants.subTask[id!]).not.toBe(FightingSubState.Holding);
    expect(blockaderRoutesToTarget(w, id!)).toBe(true);
    expect(blockaderPassesThroughFriends(w, id!)).toBe(true);
    // Holding its post it still claims no tile; chasing a foe it is an ordinary fighter.
    run(w, 300, () => w.ants.subTask[id!] === FightingSubState.Holding);
    expect(w.ants.subTask[id!]).toBe(FightingSubState.Holding);
    expect(blockaderPassesThroughFriends(w, id!)).toBe(true);
    expect(blockaderRoutesToTarget(w, id!)).toBe(false);
    addEnemySurfaceAnt(w, r.enemyDoor.x + 2, r.enemyDoor.y + 1);
    tick(w, []);
    expect(blockaderPassesThroughFriends(w, id!)).toBe(false);
    expect(blockaderRoutesToTarget(w, id!)).toBe(false);
  });

  it('holding its post it claims no tile: its colony’s ant on that tile is not bumped off', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const [id] = blockaders(r, 1);
    run(w, 300, () => w.ants.subTask[id!] === FightingSubState.Holding);
    const post = tileOf(w, id!);
    // A motionless forager of its own on the post (a higher id than the holder).
    const worker = allocateEntityId(w);
    initAnt(w.ants, worker, {
      colonyId: P,
      posX: centre(post.x),
      posY: centre(post.y),
      task: AntTask.Foraging,
      subTask: 0,
      speed: 0,
      zone: Zone.Surface,
      lastMealTick: w.tick,
    });
    r.player.workers.push(worker);
    r.player.workerCount += 1;
    tick(w, []);
    expect(w.ants.subTask[id!]).toBe(FightingSubState.Holding);
    expect(tileOf(w, worker)).toEqual(post);
  });

  it('a large blockade fills the ring: every fighter reaches a post and holds it', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const ids = blockaders(r, 12);
    const held = run(w, 600, () =>
      ids.every((id) => w.ants.subTask[id] === FightingSubState.Holding),
    );
    expect(held).toBeGreaterThan(0);
    const tiles = new Set(ids.map((id) => `${tileOf(w, id).x},${tileOf(w, id).y}`));
    expect(tiles.size).toBe(ids.length);
    for (const id of ids) {
      expect(manhattan(tileOf(w, id), r.enemyDoor)).toBeLessThanOrEqual(
        BLOCKADE_POST_RADIUS_TILES + 3,
      );
    }
  });

  it('in a duel it stays on its foe (the fight is not dropped for a nearer intruder)', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const [id] = blockaders(r, 1);
    run(w, 300, () => w.ants.subTask[id!] === FightingSubState.Holding);
    const d = r.enemyDoor;
    const nearer = addEnemySurfaceAnt(w, d.x + 1, d.y);
    const duel = addEnemySurfaceAnt(w, d.x + BLOCKADE_RADIUS_TILES + 5, d.y);
    w.ants.combatOpponentId[id!] = duel;
    // (Step 10c2 alone, on the mark the last tick's step 10c left it.)
    expect(getScratch(w).blockade.mark[id!]).not.toBe(0);
    updateBlockaders(w);
    expect(w.ants.targetPosX[id!]).toBe(w.ants.posX[duel]);
    w.ants.combatOpponentId[id!] = -1;
    updateBlockaders(w);
    expect(w.ants.targetPosX[id!]).toBe(w.ants.posX[nearer]);
  });

  it('a spider priority releases the blockaders from their posts', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const ids = blockaders(r, 3);
    run(w, 300, () => ids.every((id) => w.ants.subTask[id] === FightingSubState.Holding));
    w.spider = createScenario(7, 'Normal').spider;
    expect(w.spider).not.toBeNull();
    w.spiderPriorityColonyId = P;
    const sx0 = w.spider!.posX >> FP_SHIFT;
    tick(w, []);
    const sx1 = w.spider!.posX >> FP_SHIFT;
    for (const id of ids) {
      expect(getScratch(w).blockade.mark[id]).toBe(0);
      expect(w.ants.subTask[id]).not.toBe(FightingSubState.Holding);
      expect(blockaderPassesThroughFriends(w, id)).toBe(false);
      expect(blockaderRoutesToTarget(w, id)).toBe(false);
      expect([sx0, sx1]).toContain(w.ants.targetPosX[id]! >> FP_SHIFT);
    }
  });

  it('posts stay put while a blockader is away (ranks count every fighter of the colony)', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    const ids = blockadersNear(r, 3);
    tick(w, []);
    const before = ids.map((id) => [w.ants.targetPosX[id], w.ants.targetPosY[id]].join(','));
    // The lowest-id one goes below ground (step 10c leaves it unmarked).
    w.ants.zone[ids[0]!] = Zone.Underground;
    w.ants.currentGridColonyId[ids[0]!] = P;
    tick(w, []);
    for (let k = 1; k < ids.length; k++) {
      const id = ids[k]!;
      expect([w.ants.targetPosX[id], w.ants.targetPosY[id]].join(',')).toBe(before[k]);
    }
  });

  it('is inert below V60 and without the order: step 10c marks nobody and 10c2 routes nobody', () => {
    const r = raidWorld(3000);
    const w = r.world;
    order(r, RaidType.Blockade);
    w.simVersion = SIM_VERSION_V59_INVADER_RETARGET;
    const [id] = blockaders(r, 1);
    expect(run(w, 300, () => w.ants.zone[id!] === Zone.Underground)).toBeGreaterThan(0);
    const w2 = raidWorld(3000);
    order(w2, RaidType.Loot);
    const [b] = blockaders(w2, 1);
    tick(w2.world, []);
    expect(getScratch(w2.world).blockade.mark[b!]).toBe(0);
    w2.world.ants.targetPosX[b!] = 12345;
    updateBlockaders(w2.world);
    expect(w2.world.ants.targetPosX[b!]).toBe(12345);
    expect(w2.world.simVersion).toBe(SIM_VERSION_V60_RAID_ORDERS);
  });
});
