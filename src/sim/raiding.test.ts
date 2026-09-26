// raiding.test.ts — #290 PR 5 (V52): automatic fighter raids.
//
// Driven through tick() on the raid world (raid-test-utils.ts) so step 10e
// (updateRaiders: who loots), step 16 (tickAntMovement: the stock / entrance /
// food flow-field walks, the climb out, the own-shaft descent) and step 16e
// (tickRaidActions: loot and deposit) run at their real call sites. The predicate
// and the verbs are also pinned directly.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { SIM_VERSION_V51_UNIFIED_HUNGER, type WorldState } from './types.js';
import {
  fighterMayLoot,
  releaseSurplusFightersBelowFloor,
  tickPheromoneDeposit,
  tickRaidActions,
  updateFightAntTargets,
  updateRaiders,
} from './ant/ant-system.js';
import { dropHaulerLoad } from './ant/ant-raid.js';
import { despawnAnt } from './ant-death.js';
import { AntTask, FightingSubState, ForagingSubState, PheromoneType } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT } from './fixed.js';
import {
  chamberStock,
  colonyPoolFood,
  pileAmountFp,
  pileAtTile,
  pileCount,
  topUpOrSpawnCorpsePile,
} from './food/food-api.js';
import { setChamberStockForTest, setPoolFoodForTest } from './food/food-test-utils.js';
import { phGet, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { isSurfaceTileInComponent } from './surface-features.js';
import { FIGHTER_HUNGER } from './hunger.js';
import { computeStockFlowField } from './chamber-flow.js';
import { getScratch } from './scratch.js';
import { Rng } from './rng.js';
import { createDigFlowFields } from './dig-system.js';
import { tickAntMovement } from './ant/ant-system.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  FIGHTER_WALK_HOME_HUNGER_TICKS,
  FOOD_CHAMBER_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  PLAYER_COLONY_ID,
  RAID_CARRY_FP,
  RAID_ENGAGE_RADIUS_TILES,
  RAID_LOOT_START_STOCK_FP,
  RAID_START_CLEAR_RADIUS_TILES,
} from './constants.js';
import {
  addEnemyWorker,
  addFighter,
  carve,
  centre,
  raidWorld,
  rallyOn,
  type RaidWorld,
} from './raid-test-utils.js';

const E = ENEMY_COLONY_ID;
const P = PLAYER_COLONY_ID;

function tileOf(world: WorldState, id: number): { x: number; y: number } {
  return { x: world.ants.posX[id]! >> FP_SHIFT, y: world.ants.posY[id]! >> FP_SHIFT };
}

/**
 * Freeze the player's stores for the coming tick: a full pool (so a hauler's whole
 * load goes to the larder — a hauler, like a forager, tops the pool up at the foot
 * of its shaft on the way in) and a queen and larvae that are not due a meal (so
 * nothing is drawn from the larder). Call before each tick.
 */
function freezePlayerStores(r: RaidWorld): void {
  const w = r.world;
  setPoolFoodForTest(w, r.player, BASE_FOOD_STORAGE_CAPACITY);
  w.ants.lastMealTick[r.player.queenEntityId] = w.tick;
  for (const l of r.player.larvae) w.ants.lastMealTick[l] = w.tick;
}

/** A player raider standing below ground in the enemy nest at (x, 6), rallied on the enemy door. */
function raiderInEnemyNest(r: RaidWorld, x = 100): number {
  rallyOn(r.player, r.enemyDoor);
  return addFighter(r.world, P, x, 6, E);
}

function run(world: WorldState, ticks: number, until?: () => boolean, before?: () => void): number {
  for (let t = 0; t < ticks; t++) {
    before?.();
    tick(world, []);
    if (until?.()) return t + 1;
  }
  return -1;
}

describe('fighterMayLoot — the raid predicate (V52)', () => {
  it('holds for a rallied, fed, empty-handed fighter in the enemy nest with food in reach of it', () => {
    const r = raidWorld();
    const id = raiderInEnemyNest(r);
    expect(fighterMayLoot(r.world, r.player, id)).toBe(true);
  });

  it('fails without a rally on that nest’s entrance, in its own nest, laden, hungry, or in a duel', () => {
    const r = raidWorld();
    const id = raiderInEnemyNest(r);
    const w = r.world;
    r.player.rallyPoint = null;
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    rallyOn(r.player, { x: r.enemyDoor.x + 5, y: r.enemyDoor.y }); // near, but not on, the door
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    rallyOn(r.player, r.enemyDoor);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
    w.ants.foodCarrying[id] = 1;
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    w.ants.foodCarrying[id] = 0;
    w.ants.lastMealTick[id] = w.tick - FIGHTER_WALK_HOME_HUNGER_TICKS;
    expect(fighterMayLoot(w, r.player, id)).toBe(false); // D11: goes home to eat first
    w.ants.lastMealTick[id] = w.tick - 1;
    w.ants.combatOpponentId[id] = 0;
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    w.ants.combatOpponentId[id] = -1;
    w.ants.currentGridColonyId[id] = P; // in its own nest
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
  });

  it('never targets the entrance pool (D3): an empty larder and a full pool is nothing to loot', () => {
    const r = raidWorld(0);
    setPoolFoodForTest(r.world, r.enemy, BASE_FOOD_STORAGE_CAPACITY);
    const id = raiderInEnemyNest(r);
    expect(fighterMayLoot(r.world, r.player, id)).toBe(false);
    const pool = colonyPoolFood(r.world, r.enemy);
    let looted = false;
    for (let t = 0; t < 400; t++) {
      tick(r.world, []);
      if (r.world.ants.subTask[id] === FightingSubState.Looting) looted = true;
      expect(r.world.ants.foodCarrying[id]).toBe(0);
    }
    expect(looted).toBe(false);
    expect(r.player.foodRaidedFp).toBe(0);
    // The enemy pool only ever feeds the enemy (its queen eats); nothing was stolen.
    expect(colonyPoolFood(r.world, r.enemy)).toBeLessThanOrEqual(pool);
    expect(r.enemy.foodLostToRaidsFp).toBe(0);
  });

  it('a LOOTING raider stops for a hostile RAID_ENGAGE_RADIUS_TILES path tiles away, not one further', () => {
    const r = raidWorld();
    const w = r.world;
    const id = raiderInEnemyNest(r, 100);
    w.ants.subTask[id] = FightingSubState.Looting;
    // In the tunnel, RAID_ENGAGE_RADIUS_TILES along it (path = Manhattan = R): in reach.
    const near = addEnemyWorker(w, 100 - RAID_ENGAGE_RADIUS_TILES, 6);
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    // One tile further: out of reach, so it keeps looting.
    w.ants.posX[near] = centre(100 - RAID_ENGAGE_RADIUS_TILES - 1);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
    // Step 10e drops a blocked looter to MovingToRally and aims it at the blocker.
    w.ants.posX[near] = centre(100 - RAID_ENGAGE_RADIUS_TILES);
    updateRaiders(w);
    expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    expect(w.ants.targetPosX[id]).toBe(w.ants.posX[near]);
    // The queen counts as a hostile.
    w.ants.posX[near] = centre(60);
    w.ants.subTask[id] = FightingSubState.Looting;
    const q = r.enemy.queenEntityId;
    w.ants.posX[q] = centre(102);
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
  });

  it('a raider not yet looting STARTS only with nothing within RAID_START_CLEAR_RADIUS_TILES', () => {
    const r = raidWorld();
    const w = r.world;
    const id = raiderInEnemyNest(r, 100);
    const h = addEnemyWorker(w, 100 - RAID_START_CLEAR_RADIUS_TILES, 6);
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    w.ants.posX[h] = centre(100 - RAID_START_CLEAR_RADIUS_TILES - 1);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
  });

  it('no toggling at the reach edge: a hostile pacing between 4 and 6 tiles neither starts nor stops it', () => {
    const r = raidWorld();
    const w = r.world;
    const id = raiderInEnemyNest(r, 100);
    w.ants.speed[id] = 0; // hold it in place: only the hostile moves
    const h = addEnemyWorker(w, 94, 6);
    // Not looting, hostile 6 away: does not start, however the hostile paces 5↔6.
    for (let t = 0; t < 6; t++) {
      w.ants.posX[h] = centre(t % 2 === 0 ? 95 : 94);
      updateRaiders(w);
      expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
    }
    // Looting, hostile 5↔6 away: keeps looting throughout.
    w.ants.subTask[id] = FightingSubState.Looting;
    for (let t = 0; t < 6; t++) {
      w.ants.posX[h] = centre(t % 2 === 0 ? 95 : 94);
      updateRaiders(w);
      expect(w.ants.subTask[id]).toBe(FightingSubState.Looting);
    }
  });

  it('a trickling larder does not pull a queen-hunter back: it starts again only at a full load', () => {
    const r = raidWorld(0);
    const w = r.world;
    const id = raiderInEnemyNest(r);
    // A forager's pickup lands in the empty larder: less than a load.
    setChamberStockForTest(w, r.enemy, r.enemyLarder, RAID_LOOT_START_STOCK_FP - 1);
    updateRaiders(w);
    expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
    setChamberStockForTest(w, r.enemy, r.enemyLarder, RAID_LOOT_START_STOCK_FP);
    updateRaiders(w);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Looting);
    // Once looting, any food left keeps it on.
    setChamberStockForTest(w, r.enemy, r.enemyLarder, 1);
    updateRaiders(w);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Looting);
  });

  it('reach is by path, not Manhattan: a hostile behind a wall, or round a bend, is out of reach', () => {
    const r = raidWorld();
    const w = r.world;
    const grid = w.undergroundGrids[E]!;
    const id = raiderInEnemyNest(r, 100);
    w.ants.subTask[id] = FightingSubState.Looting; // the 4-tile stay radius
    // A sealed pocket 3 rows up: Manhattan 3, no path at all.
    carve(grid, 100, 2, 100, 3);
    const walled = addEnemyWorker(w, 100, 3);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
    // Open a bend to it: (100,6) → (101,6) → (101,5) → (101,4) → (101,3) → (100,3)
    // is 5 path tiles — still out of reach, though inside the BFS window.
    carve(grid, 101, 3, 101, 5);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
    // Move it round the corner to (101,3): 4 path tiles — in reach.
    w.ants.posX[walled] = centre(101);
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
  });

  it('its own colony’s ants are never hostile, however close', () => {
    const r = raidWorld();
    const w = r.world;
    const id = raiderInEnemyNest(r, 100);
    addFighter(w, P, 100, 6, E);
    addFighter(w, P, 99, 6, E);
    expect(fighterMayLoot(w, r.player, id)).toBe(true);
  });

  it('a rally on a CLOSED enemy entrance does not make it loot', () => {
    const r = raidWorld();
    const w = r.world;
    const id = raiderInEnemyNest(r, 100);
    const door = r.enemy.entrances.find((e) => e.surfaceTileX === r.enemyDoor.x)!;
    door.isOpen = false;
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
  });

  it('never loots its own nest, even rallied on its own entrance over a stocked larder', () => {
    const r = raidWorld();
    const w = r.world;
    setChamberStockForTest(w, r.player, r.playerLarder, 3000);
    rallyOn(r.player, r.playerDoor);
    const id = addFighter(w, P, 36, 6, P);
    expect(fighterMayLoot(w, r.player, id)).toBe(false);
    updateRaiders(w);
    expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
  });

  it('is false in a V51 world, and a V51 world never raids (byte-inert rules)', () => {
    const r = raidWorld();
    r.world.simVersion = SIM_VERSION_V51_UNIFIED_HUNGER;
    const id = raiderInEnemyNest(r);
    expect(fighterMayLoot(r.world, r.player, id)).toBe(false);
    for (let t = 0; t < 600; t++) {
      tick(r.world, []);
      expect(r.world.ants.subTask[id] === FightingSubState.Looting).toBe(false);
      expect(r.world.ants.subTask[id] === FightingSubState.Hauling).toBe(false);
      expect(r.world.ants.foodCarrying[id]).toBe(0);
    }
    expect(r.player.foodRaidedFp).toBe(0);
    expect(r.enemy.foodLostToRaidsFp).toBe(0);
  });
});

describe('the raid loop through tick() (V52)', () => {
  it('loots the larder, climbs out, walks home, goes down its own shaft and deposits; then returns', () => {
    const r = raidWorld(3000);
    const w = r.world;
    const id = raiderInEnemyNest(r);
    const fullPool = (): void => freezePlayerStores(r);

    // 1. Loot: walks the stock field to the larder and takes one load.
    const took = run(w, 200, () => w.ants.subTask[id] === FightingSubState.Hauling);
    expect(took).toBeGreaterThan(0);
    expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP);
    // (The enemy queen also eats from her larder, fullest store first.)
    expect(chamberStock(w, r.enemyLarder)).toBeLessThanOrEqual(3000 - RAID_CARRY_FP);
    expect(r.player.foodRaidedFp).toBe(RAID_CARRY_FP);
    expect(r.enemy.foodLostToRaidsFp).toBe(RAID_CARRY_FP);
    const t = tileOf(w, id);
    expect(t.x >= 86 && t.x <= 89 && t.y >= 5 && t.y <= 7).toBe(true);

    // 2. Climb out of the enemy nest.
    expect(run(w, 200, () => w.ants.zone[id] === Zone.Surface)).toBeGreaterThan(0);
    expect(w.ants.currentGridColonyId[id]).toBe(P);
    expect(tileOf(w, id)).toEqual(r.enemyDoor);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);

    // 3. Walk home and go down its own shaft (never back down the enemy's).
    let wentDownEnemy = false;
    const home = run(
      w,
      1500,
      () => {
        if (w.ants.zone[id] === Zone.Underground && w.ants.currentGridColonyId[id] === E) {
          wentDownEnemy = true;
        }
        return w.ants.zone[id] === Zone.Underground;
      },
      fullPool,
    );
    expect(home).toBeGreaterThan(0);
    expect(wentDownEnemy).toBe(false);
    expect(w.ants.currentGridColonyId[id]).toBe(P);
    expect(tileOf(w, id).x).toBe(r.playerDoor.x);

    // 4. Deposit into its own FoodStorage chamber; the trip counts.
    const load = w.ants.foodCarrying[id]!;
    expect(
      run(w, 200, () => w.ants.subTask[id] !== FightingSubState.Hauling, fullPool),
    ).toBeGreaterThan(0);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(chamberStock(w, r.playerLarder)).toBe(load);
    expect(r.player.raidTrips).toBe(1);
    expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);

    // 5. Back to the rally: out of its own nest and down the enemy's again.
    expect(
      run(
        w,
        1500,
        () => w.ants.zone[id] === Zone.Underground && w.ants.currentGridColonyId[id] === E,
      ),
    ).toBeGreaterThan(0);
  });

  it('once the larder is empty it hunts the queen (D10: loot first, then the queen)', () => {
    const r = raidWorld(RAID_CARRY_FP); // exactly one load
    const w = r.world;
    const a = raiderInEnemyNest(r, 100);
    const b = addFighter(w, P, 101, 6, E);
    // Both head for the larder; the first there empties it. (The enemy queen is
    // kept fed meanwhile, so she draws nothing from it.)
    const q0 = r.enemy.queenEntityId;
    run(
      w,
      200,
      () => chamberStock(w, r.enemyLarder) === 0,
      () => {
        w.ants.lastMealTick[q0] = w.tick;
      },
    );
    expect(chamberStock(w, r.enemyLarder)).toBe(0);
    const hauler = w.ants.subTask[a] === FightingSubState.Hauling ? a : b;
    const other = hauler === a ? b : a;
    expect(w.ants.subTask[hauler]).toBe(FightingSubState.Hauling);
    // The other no longer loots; it closes on the queen (29 path tiles from the larder).
    const q = r.enemy.queenEntityId;
    const d0 = Math.abs(tileOf(w, other).x - tileOf(w, q).x);
    run(w, 40);
    expect(w.ants.subTask[other]).not.toBe(FightingSubState.Looting);
    expect(Math.abs(tileOf(w, other).x - tileOf(w, q).x)).toBeLessThan(d0);
  });

  it('two raiders on one larder tile take in ascending id order', () => {
    const r = raidWorld(1500);
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    const lo = addFighter(w, P, 88, 6, E);
    const hi = addFighter(w, P, 88, 6, E);
    updateRaiders(w);
    expect(w.ants.subTask[lo]).toBe(FightingSubState.Looting);
    expect(w.ants.subTask[hi]).toBe(FightingSubState.Looting);
    tickRaidActions(w);
    expect(w.ants.foodCarrying[lo]).toBe(RAID_CARRY_FP);
    expect(w.ants.foodCarrying[hi]).toBe(1500 - RAID_CARRY_FP);
    expect(chamberStock(w, r.enemyLarder)).toBe(0);
    expect(r.player.foodRaidedFp).toBe(1500);
  });

  it('raiders stack on an enemy larder tile (occupancy exempts the nest they stand in)', () => {
    const r = raidWorld(0); // nothing to take, so they stay put as invaders
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    const a = addFighter(w, P, 88, 6, E);
    const b = addFighter(w, P, 88, 6, E);
    // Freeze them: hunting targets the queen, so pin speed to 0.
    w.ants.speed[a] = 0;
    w.ants.speed[b] = 0;
    tick(w, []);
    expect(tileOf(w, a)).toEqual({ x: 88, y: 6 });
    expect(tileOf(w, b)).toEqual({ x: 88, y: 6 });
  });

  it('… where a V51 world bumped them apart (it read the raider’s own colony’s chambers)', () => {
    const r = raidWorld(0);
    const w = r.world;
    w.simVersion = SIM_VERSION_V51_UNIFIED_HUNGER;
    rallyOn(r.player, r.enemyDoor);
    const a = addFighter(w, P, 88, 6, E);
    const b = addFighter(w, P, 88, 6, E);
    w.ants.speed[a] = 0;
    w.ants.speed[b] = 0;
    tick(w, []);
    expect(tileOf(w, a)).toEqual({ x: 88, y: 6 });
    expect(tileOf(w, b)).not.toEqual({ x: 88, y: 6 });
  });

  it('a cleared rally mid-haul still gets the food home', () => {
    const r = raidWorld(3000);
    const w = r.world;
    const id = raiderInEnemyNest(r);
    run(w, 200, () => w.ants.subTask[id] === FightingSubState.Hauling);
    r.player.rallyPoint = null;
    const done = run(w, 2000, () => w.ants.subTask[id] !== FightingSubState.Hauling);
    expect(done).toBeGreaterThan(0);
    expect(r.player.raidTrips).toBe(1);
    expect(chamberStock(w, r.playerLarder)).toBeGreaterThan(0);
  });

  it('the food is conserved: the victim’s loss = the stolen counters = what reached the store', () => {
    const r = raidWorld(3000);
    const w = r.world;
    const id = raiderInEnemyNest(r);
    // Keep it fed, so no meal comes out of the load (pinned separately below), and
    // the player's pool full, so the haul all goes to its larder.
    for (let t = 0; t < 3000 && r.player.raidTrips < 1; t++) {
      w.ants.lastMealTick[id] = w.tick - 1;
      freezePlayerStores(r);
      tick(w, []);
    }
    expect(r.player.raidTrips).toBe(1);
    // Checked on the deposit tick itself (step 16e runs after the queens eat).
    const lost = r.enemy.foodLostToRaidsFp;
    expect(lost).toBe(RAID_CARRY_FP);
    expect(r.player.foodRaidedFp).toBe(lost);
    expect(chamberStock(w, r.playerLarder) + w.ants.foodCarrying[id]!).toBe(lost);
  });

  it('a hauler whose meal comes due eats it from its load (V51 carried rations)', () => {
    const r = raidWorld();
    const w = r.world;
    // Far from home on the surface, laden, a meal overdue.
    const id = addFighter(w, P, 64, 30, null);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = RAID_CARRY_FP;
    w.ants.lastMealTick[id] = w.tick - FIGHTER_WALK_HOME_HUNGER_TICKS;
    tick(w, []);
    expect(w.ants.foodCarrying[id]).toBe(RAID_CARRY_FP - FIGHTER_HUNGER.mealFp);
    expect(w.ants.lastMealTick[id]).toBe(w.tick - 1);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
  });
});

describe('a hauler that dies drops its load (V52, D13)', () => {
  function laden(r: RaidWorld, x: number, y: number, grid: number | null, load: number): number {
    const id = addFighter(r.world, P, x, y, grid);
    r.world.ants.subTask[id] = FightingSubState.Hauling;
    r.world.ants.foodCarrying[id] = load;
    return id;
  }

  it('on the surface: a corpse pile of whole pickups at its tile', () => {
    const r = raidWorld();
    const w = r.world;
    let x = 60;
    while (!isSurfaceTileInComponent(w, x, 40) || pileAtTile(w, x, 40) >= 0) x += 1;
    const id = laden(r, x, 40, null, 1000);
    despawnAnt(w, id, { cause: 'starvation' });
    const slot = pileAtTile(w, x, 40);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(pileAmountFp(w, slot)).toBe(FOOD_PICKUP_AMOUNT); // 1000 fp → 1 whole pickup
    expect(w.ants.foodCarrying[id]).toBe(0);
  });

  it('on the surface under one whole pickup: no pile at all (save round-trip: raid-replay.test.ts)', () => {
    const r = raidWorld();
    const w = r.world;
    let x = 60;
    while (!isSurfaceTileInComponent(w, x, 40) || pileAtTile(w, x, 40) >= 0) x += 1;
    const id = laden(r, x, 40, null, FOOD_PICKUP_AMOUNT - 1);
    const piles = pileCount(w);
    const nextId = w.nextEntityId;
    despawnAnt(w, id, { cause: 'starvation' });
    expect(pileAtTile(w, x, 40)).toBe(-1);
    expect(pileCount(w)).toBe(piles);
    expect(w.nextEntityId).toBe(nextId); // no entity id burnt on a pile never made
  });

  it('a sub-pickup drop onto an existing pile leaves it untouched (no zero top-up)', () => {
    const r = raidWorld();
    const w = r.world;
    let x = 60;
    while (!isSurfaceTileInComponent(w, x, 41) || pileAtTile(w, x, 41) >= 0) x += 1;
    topUpOrSpawnCorpsePile(w, x, 41, FOOD_PICKUP_AMOUNT);
    const slot = pileAtTile(w, x, 41);
    topUpOrSpawnCorpsePile(w, x, 41, FOOD_PICKUP_AMOUNT - 1);
    expect(pileAmountFp(w, slot)).toBe(FOOD_PICKUP_AMOUNT);
    topUpOrSpawnCorpsePile(w, x + 1, 41, 0);
    expect(pileAtTile(w, x + 1, 41)).toBe(-1);
  });

  it('in the enemy nest: into the victim’s pool (capped), and the stolen counters give it back', () => {
    const r = raidWorld();
    const w = r.world;
    setPoolFoodForTest(w, r.enemy, BASE_FOOD_STORAGE_CAPACITY - 300);
    r.player.foodRaidedFp = 2000;
    r.enemy.foodLostToRaidsFp = 2000;
    const id = laden(r, 100, 6, E, 1000);
    despawnAnt(w, id, { cause: 'kill', killerKind: 'Ant', killerColonyId: E, killerId: null });
    expect(colonyPoolFood(w, r.enemy)).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(r.player.foodRaidedFp).toBe(1700);
    expect(r.enemy.foodLostToRaidsFp).toBe(1700);
  });

  it('in its own nest: into its own pool; the counters are untouched', () => {
    const r = raidWorld();
    const w = r.world;
    setPoolFoodForTest(w, r.player, 0);
    const id = laden(r, 30, 6, P, 800);
    despawnAnt(w, id, { cause: 'starvation' });
    expect(colonyPoolFood(w, r.player)).toBe(800);
    expect(r.player.foodRaidedFp).toBe(0);
  });

  it('is inert below V52 and for an empty-handed fighter', () => {
    const r = raidWorld();
    const w = r.world;
    const id = laden(r, 30, 6, P, 800);
    const latest = w.simVersion;
    w.simVersion = SIM_VERSION_V51_UNIFIED_HUNGER;
    expect(dropHaulerLoad(w, id)).toBe(false);
    expect(w.ants.foodCarrying[id]).toBe(800);
    w.simVersion = latest;
    const empty = addFighter(w, P, 31, 6, P);
    expect(dropHaulerLoad(w, empty)).toBe(false);
  });
});

describe('side effects neutralised (V52)', () => {
  it('a hauler lays no FoodTrail; a forager at the same spot does', () => {
    const r = raidWorld();
    const w = r.world;
    const grid = w.pheromoneGrids[pheromoneGridKey(P, PheromoneType.FoodTrail, 'surface')]!;
    const x = 64;
    const y = 30;
    const id = addFighter(w, P, x, y, null);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = RAID_CARRY_FP;
    const before = phGet(grid, x, y);
    tickPheromoneDeposit(w);
    expect(phGet(grid, x, y)).toBe(before);
    w.ants.task[id] = AntTask.Foraging;
    w.ants.subTask[id] = ForagingSubState.CarryingFood;
    tickPheromoneDeposit(w);
    expect(phGet(grid, x, y)).toBeGreaterThan(before);
  });

  it('step 10c leaves a hauler’s routing to step 10e; the small-colony stand-down never releases one', () => {
    const r = raidWorld();
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    const id = addFighter(w, P, 64, 30, null);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = RAID_CARRY_FP;
    w.ants.targetPosX[id] = 12345;
    updateFightAntTargets(w);
    expect(w.ants.targetPosX[id]).toBe(12345);
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(centre(r.playerDoor.x));
    expect(w.ants.targetPosY[id]).toBe(centre(r.playerDoor.y));
    releaseSurplusFightersBelowFloor(w, {
      workers: r.player.workers,
      computedAllocation: { fight: 0 },
    });
    expect(w.ants.task[id]).toBe(AntTask.Fighting);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
  });

  it('a hauler that has eaten its whole load goes back to its rally without counting a trip', () => {
    const r = raidWorld();
    const w = r.world;
    const id = addFighter(w, P, 64, 30, null);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = 0;
    updateRaiders(w);
    expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    expect(r.player.raidTrips).toBe(0);
  });

  it('a larder emptied under one looter re-routes it on the next tick', () => {
    const r = raidWorld(3000);
    const w = r.world;
    const id = raiderInEnemyNest(r);
    run(w, 5);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Looting);
    setChamberStockForTest(w, r.enemy, r.enemyLarder, 0);
    tick(w, []);
    expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
  });
});

describe('computeStockFlowField (V52)', () => {
  it('seeds only FoodStorage chambers holding food — full ones included, empty ones not', () => {
    const r = raidWorld(FOOD_CHAMBER_CAPACITY); // a FULL larder is still raidable
    const w = r.world;
    const grid = w.undergroundGrids[E]!;
    const out = new Int32Array(grid.width * grid.height);
    const queue = new Int32Array(grid.width * grid.height);
    computeStockFlowField(w, grid, r.enemy.chambers, out, queue);
    const at = (x: number, y: number): number => out[y * grid.width + x]!;
    expect(at(88, 6)).toBe(-1); // in the larder
    expect(at(95, 6)).toBe(3); // west, toward it
    expect(at(118, 6)).toBe(3); // the Queen chamber is not a source
    expect(at(104, 0)).toBe(2); // down the shaft
    expect(at(60, 30)).toBe(-2); // solid rock
    setChamberStockForTest(w, r.enemy, r.enemyLarder, 0);
    computeStockFlowField(w, grid, r.enemy.chambers, out, queue);
    expect(at(88, 6)).toBe(-2); // empty: nothing to raid anywhere
    expect(at(95, 6)).toBe(-2);
  });
});

describe('hauling edge cases (V52)', () => {
  function hauler(r: RaidWorld, x: number, y: number, grid: number | null, load: number): number {
    const id = addFighter(r.world, P, x, y, grid);
    r.world.ants.subTask[id] = FightingSubState.Hauling;
    r.world.ants.foodCarrying[id] = load;
    return id;
  }

  it('a full deposit ends the haul on that very tick (trip counted, back to the rally)', () => {
    const r = raidWorld();
    const w = r.world;
    const id = hauler(r, 36, 6, P, 700);
    tickRaidActions(w);
    expect(chamberStock(w, r.playerLarder)).toBe(700);
    expect(w.ants.foodCarrying[id]).toBe(0);
    expect(w.ants.subTask[id]).toBe(FightingSubState.MovingToRally);
    expect(r.player.raidTrips).toBe(1);
  });

  it('at the top of its own shaft it tops up the pool (as a forager does), leftover kept', () => {
    const r = raidWorld();
    const w = r.world;
    setPoolFoodForTest(w, r.player, BASE_FOOD_STORAGE_CAPACITY - 100);
    const id = hauler(r, r.playerDoor.x, 0, P, 300);
    tickRaidActions(w);
    expect(colonyPoolFood(w, r.player)).toBe(BASE_FOOD_STORAGE_CAPACITY);
    expect(w.ants.foodCarrying[id]).toBe(200);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
    expect(r.player.raidTrips).toBe(0);
  });

  it('a hauler standing on an enemy entrance never goes back down it', () => {
    const r = raidWorld();
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    const id = hauler(r, r.enemyDoor.x, r.enemyDoor.y, null, RAID_CARRY_FP);
    w.ants.speed[id] = 0; // stays on the door tile for the descent check
    tick(w, []);
    expect(w.ants.zone[id]).toBe(Zone.Surface);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
  });

  it('climbs out of the enemy nest by the entrance flow field, round a bend', () => {
    const r = raidWorld();
    const w = r.world;
    const grid = w.undergroundGrids[E]!;
    // A U-shaped side passage: down from (108,6) to row 12, west to (98,12).
    carve(grid, 108, 6, 108, 12);
    carve(grid, 98, 12, 108, 12);
    rallyOn(r.player, r.enemyDoor);
    const id = hauler(r, 98, 12, E, RAID_CARRY_FP);
    expect(run(w, 200, () => w.ants.zone[id] === Zone.Surface)).toBeGreaterThan(0);
    expect(tileOf(w, id)).toEqual(r.enemyDoor);
  });

  it('a hauler in its own nest while its colony defends its tunnels still deposits (pool at the shaft)', () => {
    const r = raidWorld();
    const w = r.world;
    // Larder saturated: only the pool at the shaft top takes food.
    setChamberStockForTest(w, r.player, r.playerLarder, FOOD_CHAMBER_CAPACITY);
    setPoolFoodForTest(w, r.player, 0);
    rallyOn(r.player, r.playerDoor); // tunnel-defence rally (V44)
    const id = hauler(r, 30, 6, P, 500);
    const done = run(w, 200, () => w.ants.subTask[id] !== FightingSubState.Hauling);
    expect(done).toBeGreaterThan(0);
    expect(r.player.raidTrips).toBe(1);
  });

  it('a hauler takes no sentry post: the sentries rank as if it were not there', () => {
    const r = raidWorld();
    const w = r.world;
    r.player.rallyPoint = null;
    const h = hauler(r, r.playerDoor.x + 10, r.playerDoor.y - 10, null, RAID_CARRY_FP);
    const sentry = addFighter(w, P, r.playerDoor.x + 1, r.playerDoor.y - 1, null);
    expect(h).toBeLessThan(sentry);
    updateFightAntTargets(w);
    expect(getScratch(w).antTargeting.sentrySlot[sentry]).toBe(0);
  });
});

describe('review follow-ups (V52)', () => {
  it('a raider stopped by a hostile in reach goes at THAT hostile, not the nearest one elsewhere', () => {
    const r = raidWorld();
    const w = r.world;
    const grid = w.undergroundGrids[E]!;
    // A pocket just below the raider holds the queen: 2 Manhattan tiles away,
    // but 20+ path tiles (sealed off here entirely).
    carve(grid, 100, 8, 100, 9);
    const q = r.enemy.queenEntityId;
    w.ants.posX[q] = centre(100);
    w.ants.posY[q] = centre(8);
    const id = raiderInEnemyNest(r, 100);
    const blocker = addEnemyWorker(w, 96, 6); // 4 path tiles west, toward the larder
    updateFightAntTargets(w);
    updateRaiders(w);
    expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
    expect(w.ants.targetPosX[id]).toBe(w.ants.posX[blocker]);
    // It closes on the blocker over the next ticks instead of flip-flopping.
    const d = (): number => Math.abs(tileOf(w, id).x - tileOf(w, blocker).x);
    const d0 = d();
    run(w, 12);
    expect(d()).toBeLessThan(d0);
  });

  it('a between-ticks fighterMayLoot query cannot freeze the next tick’s stock field', () => {
    const r = raidWorld(3000);
    const w = r.world;
    const id = raiderInEnemyNest(r);
    expect(fighterMayLoot(w, r.player, id)).toBe(true); // caches a field now
    setChamberStockForTest(w, r.enemy, r.enemyLarder, 0); // larder emptied before the tick
    tick(w, []);
    expect(w.ants.subTask[id]).not.toBe(FightingSubState.Looting);
  });

  it('a hauler dying in its own FoodStorage chamber stores the load there when the pool is full', () => {
    const r = raidWorld();
    const w = r.world;
    setPoolFoodForTest(w, r.player, BASE_FOOD_STORAGE_CAPACITY);
    const id = addFighter(w, P, 36, 6, P);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = 900;
    despawnAnt(w, id, { cause: 'starvation' });
    expect(chamberStock(w, r.playerLarder)).toBe(900);
  });

  it('a hauler dying on the surface leaves the stolen counters as they were', () => {
    const r = raidWorld();
    const w = r.world;
    r.player.foodRaidedFp = 1024;
    r.enemy.foodLostToRaidsFp = 1024;
    let x = 60;
    while (!isSurfaceTileInComponent(w, x, 40) || pileAtTile(w, x, 40) >= 0) x += 1;
    const id = addFighter(w, P, x, 40, null);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = 1024;
    despawnAnt(w, id, { cause: 'starvation' });
    expect(pileAmountFp(w, pileAtTile(w, x, 40))).toBe(1024);
    expect(r.player.foodRaidedFp).toBe(1024);
    expect(r.enemy.foodLostToRaidsFp).toBe(1024);
  });
});

describe('second review follow-ups (V52)', () => {
  function hauler(r: RaidWorld, x: number, y: number, grid: number | null, load: number): number {
    const id = addFighter(r.world, P, x, y, grid);
    r.world.ants.subTask[id] = FightingSubState.Hauling;
    r.world.ants.foodCarrying[id] = load;
    return id;
  }

  it('a surface hauler heads for an OPEN home entrance, never a closed nearer one', () => {
    const r = raidWorld();
    const w = r.world;
    // A second, closed player entrance much nearer the hauler.
    r.player.entrances.push({
      entranceId: 9999,
      surfaceTileX: 70,
      surfaceTileY: 40,
      isOpen: false,
    } as (typeof r.player.entrances)[number]);
    const id = hauler(r, 72, 40, null, RAID_CARRY_FP);
    updateRaiders(w);
    expect(w.ants.targetPosX[id]).toBe(centre(r.playerDoor.x));
    expect(w.ants.targetPosY[id]).toBe(centre(r.playerDoor.y));
  });

  it('a hauler still in the enemy nest never deposits there, not even on a larder tile or its shaft top', () => {
    const r = raidWorld(0);
    const w = r.world;
    setPoolFoodForTest(w, r.enemy, 0);
    const onLarder = hauler(r, 88, 6, E, 700);
    const onShaft = hauler(r, r.enemyDoor.x, 0, E, 700);
    // At the coordinates of its OWN larder and its OWN shaft top, but in the enemy
    // nest: still not a deposit site (sites are looked up in the nest it is in).
    const atOwnLarderXY = hauler(r, 36, 6, E, 700);
    const atOwnShaftXY = hauler(r, r.playerDoor.x, 0, E, 700);
    setPoolFoodForTest(w, r.player, 0);
    tickRaidActions(w);
    expect(w.ants.foodCarrying[onLarder]).toBe(700);
    expect(w.ants.foodCarrying[onShaft]).toBe(700);
    expect(w.ants.foodCarrying[atOwnLarderXY]).toBe(700);
    expect(w.ants.foodCarrying[atOwnShaftXY]).toBe(700);
    expect(chamberStock(w, r.playerLarder)).toBe(0);
    expect(colonyPoolFood(w, r.player)).toBe(0);
    expect(chamberStock(w, r.enemyLarder)).toBe(0);
    expect(colonyPoolFood(w, r.enemy)).toBe(0);
  });

  it('a hauler passes through its own idle invaders in a one-wide enemy shaft', () => {
    const r = raidWorld();
    const w = r.world;
    rallyOn(r.player, r.enemyDoor);
    // Two lower-id player fighters parked in the shaft above it, frozen.
    const x = r.enemyDoor.x;
    const b1 = addFighter(w, P, x, 2, E);
    const b2 = addFighter(w, P, x, 1, E);
    w.ants.speed[b1] = 0;
    w.ants.speed[b2] = 0;
    const id = hauler(r, x, 3, E, RAID_CARRY_FP);
    expect(id).toBeGreaterThan(b2);
    expect(run(w, 60, () => w.ants.zone[id] === Zone.Surface)).toBeGreaterThan(0);
  });
});

describe('hauler exit off the entrance flow field (V52, rebased on PR 4’s hungryExitStep)', () => {
  function uBendHauler(): { r: RaidWorld; id: number } {
    const r = raidWorld();
    const w = r.world;
    const grid = w.undergroundGrids[E]!;
    // A U-bend: down from (108,6) to row 12, west to (98,12). Straight at the
    // shaft column from (98,12) runs into rock at (98,11).
    carve(grid, 108, 6, 108, 12);
    carve(grid, 98, 12, 108, 12);
    // A nearer "open" stub entrance that joins nothing (its two shaft tiles only).
    carve(grid, 96, 0, 96, 1);
    r.enemy.entrances.push({ entranceId: 9998, surfaceTileX: 96, surfaceTileY: 64, isOpen: true });
    rallyOn(r.player, r.enemyDoor);
    const id = addFighter(w, P, 98, 12, E);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = RAID_CARRY_FP;
    return { r, id };
  }

  it('without the entrance field it still gets out (reachable-exit BFS), past the stub', () => {
    const { r, id } = uBendHauler();
    const w = r.world;
    const rng = new Rng(1);
    const dig = createDigFlowFields();
    let out = -1;
    for (let t = 0; t < 200 && out < 0; t++) {
      tickAntMovement(w, rng, dig); // no entrance / chamber fields: the fallback route
      if (w.ants.zone[id] === Zone.Surface) out = t;
    }
    expect(out).toBeGreaterThanOrEqual(0);
    expect(tileOf(w, id).x).toBe(r.enemyDoor.x); // by the real shaft, not the stub
  });

  it('through tick() it climbs out by the entrance flow field, past the stub', () => {
    const { r, id } = uBendHauler();
    const w = r.world;
    expect(run(w, 200, () => w.ants.zone[id] === Zone.Surface)).toBeGreaterThan(0);
    expect(tileOf(w, id).x).toBe(r.enemyDoor.x);
  });
});
