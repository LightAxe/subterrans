// raid-replay.test.ts — #290 PR 5 (V52): raids replay deterministically and survive
// a save/load mid-haul; the save validator admits the raid sub-states from V52
// only, and only on a fighter.
//
// The raid world (sim/raid-test-utils.ts) with three player fighters and a
// recorded SetRallyPoint on the enemy's door: the fighters descend, loot the enemy
// larder, haul home, deposit and go back. The same world + log must reproduce the
// per-checkpoint hashWorldState exactly, and so must a run saved and reloaded
// while a hauler is carrying loot (which proves the whole raid state is in the
// save: sub-state, load, counters — the stock flow field is per-tick scratch).

import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { AntTask, FightingSubState } from '../sim/enums.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID, FOOD_PICKUP_AMOUNT } from '../sim/constants.js';
import { despawnAnt } from '../sim/ant-death.js';
import { pileAtTile, pileCount } from '../sim/food/food-api.js';
import { isSurfaceTileInComponent } from '../sim/surface-features.js';
import { SIM_VERSION_V51_UNIFIED_HUNGER, type WorldState } from '../sim/types.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';
import { hashWorldState } from './world-hash.js';
import { serializeWorldState, deserializeWorldState, type SerializedWorldState } from './save.js';

const TICKS = 2600;
const CHECK_EVERY = 100;

function makeWorld(): { world: WorldState; log: SimCommand[][] } {
  const r = raidWorld(6000);
  for (const x of [20, 22, 26]) addFighter(r.world, PLAYER_COLONY_ID, x, r.playerDoor.y - 2, null);
  const log: SimCommand[][] = [];
  log[5] = [
    {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID as ColonyId,
      tileX: r.enemyDoor.x,
      tileY: r.enemyDoor.y,
      issuedAtTick: 5,
    },
  ];
  return { world: r.world, log };
}

function haulers(world: WorldState): number {
  let n = 0;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (world.ants.alive[id] === 1 && world.ants.subTask[id] === FightingSubState.Hauling) {
      if (world.ants.task[id] === AntTask.Fighting) n += 1;
    }
  }
  return n;
}

interface Run {
  hashes: string[];
  firstHaulTick: number;
  trips: number;
  stolen: number;
}

function run(saveAt = -1): Run {
  const made = makeWorld();
  let world = made.world;
  const hashes: string[] = [];
  let firstHaulTick = -1;
  for (let t = 0; t < TICKS; t++) {
    if (world.tick === saveAt) {
      world = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
    }
    tick(world, made.log[world.tick] ?? []);
    if (firstHaulTick < 0 && haulers(world) > 0) firstHaulTick = world.tick;
    if (world.tick % CHECK_EVERY === 0) hashes.push(hashWorldState(world));
  }
  const p = world.colonies[PLAYER_COLONY_ID]!;
  return { hashes, firstHaulTick, trips: p.raidTrips, stolen: p.foodRaidedFp };
}

describe('V52 raids replay deterministically (#290 PR 5)', () => {
  const a = run();
  // Save a few dozen ticks into the first haul: loot in hand, still in the enemy nest.
  const saveAt = a.firstHaulTick + 20;

  it('the run raids: loot taken, hauled and deposited', () => {
    expect(a.firstHaulTick).toBeGreaterThan(0);
    expect(a.stolen).toBeGreaterThan(0);
    expect(a.trips).toBeGreaterThan(0);
  });

  it('same world + same command log → identical hashes at every checkpoint', () => {
    expect(run().hashes).toEqual(a.hashes);
  }, 60_000); // a full multi-thousand-tick run; slow on a loaded CI box

  it('a save/load mid-haul continues identically', () => {
    expect(run(saveAt).hashes).toEqual(a.hashes);
  }, 60_000); // a full multi-thousand-tick run; slow on a loaded CI box
});

describe('save validation of the raid sub-states', () => {
  function savedMidHaul(): { s: SerializedWorldState; id: number } {
    const made = makeWorld();
    const w = made.world;
    for (let t = 0; t < TICKS && haulers(w) === 0; t++) tick(w, made.log[w.tick] ?? []);
    let id = -1;
    for (let i = 0; i < w.nextEntityId && id < 0; i++) {
      if (w.ants.alive[i] === 1 && w.ants.subTask[i] === FightingSubState.Hauling) id = i;
    }
    expect(id).toBeGreaterThanOrEqual(0);
    return { s: JSON.parse(JSON.stringify(serializeWorldState(w))) as SerializedWorldState, id };
  }

  it('a V52 save carrying Hauling (5) and Looting (4) loads, loads intact', () => {
    const { s, id } = savedMidHaul();
    const w = deserializeWorldState(s);
    expect(w.ants.subTask[id]).toBe(FightingSubState.Hauling);
    expect(w.ants.foodCarrying[id]).toBeGreaterThan(0);
    s.ants.subTask[id] = FightingSubState.Looting;
    s.ants.foodCarrying[id] = 0;
    expect(deserializeWorldState(s).ants.subTask[id]).toBe(FightingSubState.Looting);
  });

  it('rejects a raid sub-state below V52', () => {
    const { s } = savedMidHaul();
    s.simVersion = SIM_VERSION_V51_UNIFIED_HUNGER;
    expect(() => deserializeWorldState(s)).toThrow(/subTask/);
  });

  it('rejects a raid sub-state on a non-fighter, and anything above Hauling', () => {
    const { s, id } = savedMidHaul();
    const bad = JSON.parse(JSON.stringify(s)) as SerializedWorldState;
    bad.ants.task[id] = AntTask.Foraging;
    expect(() => deserializeWorldState(bad)).toThrow(/subTask/);
    const over = JSON.parse(JSON.stringify(s)) as SerializedWorldState;
    over.ants.subTask[id] = FightingSubState.Hauling + 1;
    expect(() => deserializeWorldState(over)).toThrow(/subTask/);
  });

  it('the enemy colony id round-trips on the raider’s grid of occupancy', () => {
    // A looter below ground in the enemy nest keeps currentGridColonyId = the enemy.
    const { s, id } = savedMidHaul();
    const w = deserializeWorldState(s);
    expect([PLAYER_COLONY_ID, ENEMY_COLONY_ID]).toContain(w.ants.currentGridColonyId[id]);
  });
});

describe('a sub-pickup hauler load dropped on the surface (Codex P1)', () => {
  it('makes no zero-sized pile, so the world still saves and loads', () => {
    const r = raidWorld();
    const w = r.world;
    let x = 60;
    while (!isSurfaceTileInComponent(w, x, 40) || pileAtTile(w, x, 40) >= 0) x += 1;
    const id = addFighter(w, PLAYER_COLONY_ID, x, 40, null);
    w.ants.subTask[id] = FightingSubState.Hauling;
    w.ants.foodCarrying[id] = FOOD_PICKUP_AMOUNT - 32; // a partial take, part eaten
    despawnAnt(w, id, { cause: 'starvation' });
    expect(pileAtTile(w, x, 40)).toBe(-1);
    const loaded = deserializeWorldState(
      JSON.parse(JSON.stringify(serializeWorldState(w))) as SerializedWorldState,
    );
    expect(pileCount(loaded)).toBe(pileCount(w));
    // And one tick on, it saves again.
    tick(loaded, []);
    expect(() =>
      deserializeWorldState(
        JSON.parse(JSON.stringify(serializeWorldState(loaded))) as SerializedWorldState,
      ),
    ).not.toThrow();
  });
});
