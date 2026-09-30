// raid-order-replay.test.ts — #352 (V60): raid orders replay deterministically.
//
// AGENTS.md's replay-coverage rule for a save-format / command change: a recorded
// input sequence must reproduce the same world, and must keep doing so across a
// save/load and a copyWorldState taken mid-order. raid-replay.test.ts covers the
// V52 raid with an untyped (Loot) rally; this file records each V60 raid type —
// Deny, Spoil, Blockade, Assault, Loot going queen-first — plus one sequence that
// changes the type mid-raid and then clears the rally.
//
// Each scenario is the raid world (sim/raid-test-utils.ts) with three player
// fighters by their own entrance and a recorded command log. It is run four
// times: A (recorded), B (independent replay), C (saved and reloaded at SPLIT),
// D (copyWorldState into a fresh world at SPLIT). B, C and D must match A's
// hashWorldState at every checkpoint. Run A also asserts the order really had its
// effect, and each scenario asserts the order is under way at SPLIT, so the
// save/copy lands mid-order.
//
// A per-tick harness hook (`before`) may reset state the log cannot express (the
// Deny scenario keeps the player's stores full; the Spoil, Loot-with-nothing and
// change scenarios keep the enemy fed). It is a pure function of the world, applied identically in
// every run, before the tick. It re-sets those fields (pool food, chamber stock,
// meal ticks) after a load or copy too, so runs C and D do not by themselves prove
// that they round-trip — their own save tests do.

import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType, FightingSubState, RaidType } from '../sim/enums.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  BLOCKADE_POST_RADIUS_TILES,
} from '../sim/constants.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { copyWorldState, createWorldState, type WorldState } from '../sim/types.js';
import { forEachPile } from '../sim/food/food-api.js';
import { setChamberStockForTest, setPoolFoodForTest } from '../sim/food/food-test-utils.js';
import { addFighter, raidWorld, type RaidWorld } from '../sim/raid-test-utils.js';
import { hashWorldState } from './world-hash.js';
import { serializeWorldState, deserializeWorldState } from './save.js';

const TICKS = 2400;
const SPLIT = 1200;
const CHECK_EVERY = 100;
const P = PLAYER_COLONY_ID;

function rally(t: number, r: RaidWorld, raidType?: RaidType): SimCommand {
  return {
    type: 'SetRallyPoint',
    colonyId: P as ColonyId,
    tileX: r.enemyDoor.x,
    tileY: r.enemyDoor.y,
    ...(raidType === undefined ? {} : { raidType }),
    issuedAtTick: t,
  };
}

interface Scenario {
  larderFp: number;
  log: (r: RaidWorld) => SimCommand[][];
  before?: (w: WorldState) => void;
  /** The order is under way at SPLIT (so the save / copy lands mid-order). */
  midOrder: (w: WorldState) => boolean;
}

interface Run {
  hashes: string[];
  world: WorldState;
  midOrderAtSplit: boolean;
  /** Per-tick observations of run A (the effect checks read them). */
  everUnderground: boolean;
  maxHolding: number;
  stolenAtChange: number;
  lostAtChange: number;
  /** Fighter-ticks a fighter in the enemy nest was aimed at the enemy queen (step
   *  10e's raidQueenTarget sets the aim; the plain hunt sets none). */
  aimedAtQueen: number;
  /** The enemy queen's lowest HP over the run (0 once dead). From V66 (#375) a fed
   *  queen heals, so the end state no longer shows a wound taken mid-run. */
  enemyQueenMinHp: number;
}

function fighters(w: WorldState): number[] {
  const out: number[] = [];
  for (const id of w.colonies[P]!.workers) if (w.ants.alive[id] === 1) out.push(id);
  return out;
}

function inEnemyNest(w: WorldState): boolean {
  return fighters(w).some(
    (id) =>
      w.ants.zone[id] === Zone.Underground && w.ants.currentGridColonyId[id] === ENEMY_COLONY_ID,
  );
}

/** Keep the enemy queen and larvae fed, so its larder changes only by the raid. */
function feedEnemy(w: WorldState): void {
  const e = w.colonies[ENEMY_COLONY_ID]!;
  w.ants.lastMealTick[e.queenEntityId] = w.tick;
  for (const l of e.larvae) w.ants.lastMealTick[l] = w.tick;
}

/** Food (fp) in surface piles within a tile of the player's open entrance. */
function pilesByOwnDoor(w: WorldState): number {
  const door = w.colonies[P]!.entrances.find((e) => e.isOpen)!;
  let fp = 0;
  forEachPile(w, (pile) => {
    if (Math.abs(pile.x - door.surfaceTileX) <= 1 && Math.abs(pile.y - door.surfaceTileY) <= 1) {
      fp += pile.amountFp;
    }
  });
  return fp;
}

function run(sc: Scenario, split: 'none' | 'save' | 'copy', changeAt = -1): Run {
  const r = raidWorld(sc.larderFp);
  for (const x of [20, 22, 26]) addFighter(r.world, P, x, r.playerDoor.y - 2, null);
  const log = sc.log(r);
  let world = r.world;
  const out: Run = {
    hashes: [],
    world,
    midOrderAtSplit: false,
    everUnderground: false,
    maxHolding: 0,
    stolenAtChange: -1,
    lostAtChange: -1,
    aimedAtQueen: 0,
    enemyQueenMinHp: Number.MAX_SAFE_INTEGER,
  };
  for (let t = 0; t < TICKS; t++) {
    if (world.tick === SPLIT) {
      out.midOrderAtSplit = sc.midOrder(world);
      if (split === 'save') {
        world = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
      } else if (split === 'copy') {
        const dst = createWorldState(0);
        copyWorldState(world, dst);
        world = dst;
      }
    }
    if (world.tick === changeAt) {
      out.stolenAtChange = world.colonies[P]!.foodRaidedFp;
      out.lostAtChange = world.colonies[ENEMY_COLONY_ID]!.foodLostToRaidsFp;
    }
    sc.before?.(world);
    tick(world, log[world.tick] ?? []);
    let holding = 0;
    const q = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
    const qHp = world.ants.alive[q] === 1 ? world.ants.hp[q]! : 0;
    if (qHp < out.enemyQueenMinHp) out.enemyQueenMinHp = qHp;
    for (const id of fighters(world)) {
      if (world.ants.zone[id] === Zone.Underground) out.everUnderground = true;
      if (world.ants.subTask[id] === FightingSubState.Holding) holding += 1;
      if (
        q >= 0 &&
        world.ants.alive[q] === 1 &&
        world.ants.currentGridColonyId[id] === ENEMY_COLONY_ID &&
        world.ants.targetPosX[id] === world.ants.posX[q] &&
        world.ants.targetPosY[id] === world.ants.posY[q]
      ) {
        out.aimedAtQueen += 1;
      }
    }
    if (holding > out.maxHolding) out.maxHolding = holding;
    if (world.tick % CHECK_EVERY === 0) out.hashes.push(hashWorldState(world));
  }
  out.world = world;
  return out;
}

/** Runs A–D of `sc`; B, C and D must match A at every checkpoint. Returns A. */
function replayed(sc: Scenario, changeAt = -1): Run {
  const a = run(sc, 'none', changeAt);
  expect(a.midOrderAtSplit).toBe(true);
  expect(run(sc, 'none', changeAt).hashes).toEqual(a.hashes);
  const c = run(sc, 'save', changeAt);
  expect(c.midOrderAtSplit).toBe(true);
  expect(c.hashes).toEqual(a.hashes);
  const d = run(sc, 'copy', changeAt);
  expect(d.midOrderAtSplit).toBe(true);
  expect(d.hashes).toEqual(a.hashes);
  return a;
}

const SLOW = 120_000; // four multi-thousand-tick runs; slow on a loaded CI box

describe('V60 raid orders replay deterministically, across save/load and copy (#352)', () => {
  it('a non-integer raid type drops the whole command (float literal: not in src/sim/)', () => {
    const r = raidWorld(0);
    tick(r.world, [rally(0, r, 3.5 as RaidType)]);
    expect(r.player.rallyPoint).toBeNull();
    expect(r.player.raidType).toBe(RaidType.Loot);
  });

  it(
    'Deny (own stores kept full): steals, and drops what it cannot store by its entrance',
    () => {
      const sc: Scenario = {
        larderFp: 6000,
        log: (r) => {
          const log: SimCommand[][] = [];
          log[5] = [rally(5, r, RaidType.Deny)];
          return log;
        },
        before: (w) => {
          const c = w.colonies[P]!;
          setPoolFoodForTest(w, c, BASE_FOOD_STORAGE_CAPACITY);
          for (const ch of c.chambers) {
            if (ch.chamberType === ChamberType.FoodStorage) {
              setChamberStockForTest(w, c, ch, FOOD_CHAMBER_CAPACITY);
            }
          }
        },
        // A load already dropped by the raiders' own entrance before the split.
        midOrder: (w) => pilesByOwnDoor(w) > 0,
      };
      const a = replayed(sc);
      const p = a.world.colonies[P]!;
      expect(p.raidType).toBe(RaidType.Deny);
      expect(p.foodRaidedFp).toBeGreaterThan(0);
      expect(p.raidTrips).toBeGreaterThan(0);
      // Dropped by its entrance (no forager takes it in: the fixture has none).
      expect(pilesByOwnDoor(a.world)).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'Spoil: destroys the enemy’s stored food in place and brings none home',
    () => {
      const sc: Scenario = {
        larderFp: 6000,
        log: (r) => {
          const log: SimCommand[][] = [];
          log[5] = [rally(5, r, RaidType.Spoil)];
          return log;
        },
        before: feedEnemy,
        midOrder: (w) => w.colonies[ENEMY_COLONY_ID]!.foodLostToRaidsFp > 0,
      };
      const a = replayed(sc);
      expect(a.world.colonies[ENEMY_COLONY_ID]!.foodLostToRaidsFp).toBeGreaterThan(0);
      expect(a.world.colonies[P]!.foodRaidedFp).toBe(0);
    },
    SLOW,
  );

  it(
    'Blockade: holds a ring round the enemy entrance and never goes down',
    () => {
      const sc: Scenario = {
        larderFp: 6000,
        log: (r) => {
          const log: SimCommand[][] = [];
          log[5] = [rally(5, r, RaidType.Blockade)];
          return log;
        },
        midOrder: (w) => fighters(w).some((id) => w.ants.subTask[id] === FightingSubState.Holding),
      };
      const a = replayed(sc);
      expect(a.everUnderground).toBe(false);
      expect(a.maxHolding).toBeGreaterThan(0);
      const r = raidWorld(0); // only for the door position (same fixture)
      for (const id of fighters(a.world)) {
        const dx = (a.world.ants.posX[id]! >> FP_SHIFT) - r.enemyDoor.x;
        const dy = (a.world.ants.posY[id]! >> FP_SHIFT) - r.enemyDoor.y;
        expect(Math.abs(dx) + Math.abs(dy)).toBeLessThanOrEqual(BLOCKADE_POST_RADIUS_TILES + 2);
      }
      expect(a.world.colonies[P]!.foodRaidedFp).toBe(0);
    },
    SLOW,
  );

  it(
    'Assault: ignores a stocked larder and goes for the queen',
    () => {
      const sc: Scenario = {
        larderFp: 6000,
        log: (r) => {
          const log: SimCommand[][] = [];
          log[5] = [rally(5, r, RaidType.Assault)];
          return log;
        },
        midOrder: inEnemyNest,
      };
      const a = replayed(sc);
      expect(a.aimedAtQueen).toBeGreaterThan(0);
      const e = a.world.colonies[ENEMY_COLONY_ID]!;
      const q = e.queenEntityId;
      const fresh = raidWorld(6000).world;
      expect(a.enemyQueenMinHp).toBeLessThan(fresh.ants.hp[q]!); // hurt at some point
      expect(a.world.colonies[P]!.foodRaidedFp).toBe(0);
      expect(e.foodLostToRaidsFp).toBe(0);
    },
    SLOW,
  );

  it(
    'Loot with nothing to take goes queen-first',
    () => {
      const sc: Scenario = {
        larderFp: 0,
        log: (r) => {
          const log: SimCommand[][] = [];
          log[5] = [rally(5, r)]; // a plain tap: Loot
          return log;
        },
        midOrder: inEnemyNest,
        // Keep her fed so only the fighters can hurt her (unfed, the 2000 fp pool
        // runs dry near tick 1000 and starvation alone would lower her HP).
        before: feedEnemy,
      };
      const a = replayed(sc);
      expect(a.aimedAtQueen).toBeGreaterThan(0);
      const q = a.world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
      const fresh = raidWorld(0).world;
      expect(a.enemyQueenMinHp).toBeLessThan(fresh.ants.hp[q]!); // hurt at some point
      expect(a.world.colonies[P]!.raidType).toBe(RaidType.Loot);
    },
    SLOW,
  );

  it(
    'a type change mid-raid (Loot → Spoil) and then a clear',
    () => {
      // Loot's first load is taken at ~tick 210; at 250 the raiders are hauling it.
      const CHANGE = 250;
      const CLEAR = 2000;
      const sc: Scenario = {
        larderFp: 6000,
        log: (r) => {
          const log: SimCommand[][] = [];
          log[5] = [rally(5, r, RaidType.Loot)];
          log[CHANGE] = [rally(CHANGE, r, RaidType.Spoil)];
          log[CLEAR] = [{ type: 'ClearRallyPoint', colonyId: P as ColonyId, issuedAtTick: CLEAR }];
          return log;
        },
        before: feedEnemy,
        // SPLIT lies between the change and the clear: a Spoil order in force.
        midOrder: (w) =>
          w.colonies[P]!.raidType === RaidType.Spoil && w.colonies[P]!.rallyPoint !== null,
      };
      const a = replayed(sc, CHANGE);
      const p = a.world.colonies[P]!;
      const e = a.world.colonies[ENEMY_COLONY_ID]!;
      // Loot stole before the change; after it, Spoil destroyed more than was stolen.
      expect(a.stolenAtChange).toBeGreaterThan(0);
      const stolenAfter = p.foodRaidedFp - a.stolenAtChange;
      const lostAfter = e.foodLostToRaidsFp - a.lostAtChange;
      expect(lostAfter).toBeGreaterThan(stolenAfter);
      // The clear resets the order.
      expect(p.rallyPoint).toBeNull();
      expect(p.raidType).toBe(RaidType.Loot);
    },
    SLOW,
  );
});
