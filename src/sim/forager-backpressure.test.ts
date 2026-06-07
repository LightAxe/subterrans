// forager-backpressure.test.ts — #126 (V27) forager storage backpressure.
//
// When a colony has genuinely nowhere to deposit (entrance pool at capacity AND
// no FoodStorage chamber depositable), step-10a idle→Foraging promotion is
// suppressed so idle ants are not churned into searchers the leash would demote
// the same tick (the entrance-shaft pile-up of #126). Suppression is gated
// behind simVersion >= V27 and must never mutate colony.computedAllocation.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createWorldState, allocateEntityId } from './types.js';
import {
  SIM_VERSION_V26_SPIDER_EDGE_MARGIN,
  SIM_VERSION_V27_FORAGE_BACKPRESSURE,
} from './types.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord, type ColonyId } from './colony/colony-store.js';
import { colonyHasNoDepositTarget, colonyForageBackpressure } from './colony/colony-system.js';
import { AntTask, ChamberType } from './enums.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';
import type { WorldState } from './types.js';

interface SaturatedOpts {
  simVersion: number;
  /** entrance-pool fill (default: at cap). */
  poolFill?: number;
  /** FoodStorage chamber fill (default: full → non-depositable). */
  chamberFill?: number;
  /** build with NO FoodStorage chamber (pool is the only deposit target). */
  noChamber?: boolean;
  /** number of Idle workers eligible for step-10a promotion. */
  idleWorkers?: number;
}

/**
 * Build a single-colony world whose storage saturation is fully controlled.
 * Default = the #126 pile-up state: pool at cap AND one full (non-depositable)
 * FoodStorage chamber. Workers start Idle with a forage-only target ratio, so
 * step 10a wants to promote them to Foraging unless backpressure suppresses it.
 */
function buildSaturatedWorld(opts: SaturatedOpts): {
  world: WorldState;
  colonyId: ColonyId;
  idleIds: number[];
} {
  const world = createWorldState(42);
  world.simVersion = opts.simVersion;

  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId: 1,
    posX: 1024,
    posY: 1024,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  const colony = createColonyRecord(1, queenId);
  world.colonies[1] = colony;

  const idleCount = opts.idleWorkers ?? 4;
  const idleIds: number[] = [];
  for (let i = 0; i < idleCount; i++) {
    const wid = allocateEntityId(world);
    initAnt(world.ants, wid, {
      colonyId: 1,
      posX: 1024,
      posY: 1024,
      task: AntTask.Idle,
      subTask: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    colony.workers.push(wid);
    idleIds.push(wid);
  }
  colony.workerCount = idleCount;
  colony.eggCount = 0;
  colony.larvaeCount = 0;
  // Forage-only ratio so step 8 allocates every (non-nurse) worker to forage.
  colony.targetRatio = { forage: 10, fight: 0 };

  colony.foodStored = opts.poolFill ?? BASE_FOOD_STORAGE_CAPACITY;
  if (!opts.noChamber) {
    colony.chambers.push({
      chamberId: 100,
      chamberType: ChamberType.FoodStorage,
      foodStored: opts.chamberFill ?? FOOD_CHAMBER_CAPACITY,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
  }

  return { world, colonyId: 1 as ColonyId, idleIds };
}

function taskCount(world: WorldState, ids: number[], task: number): number {
  let n = 0;
  for (const id of ids) if (world.ants.task[id] === task) n += 1;
  return n;
}

function foragerCount(world: WorldState, ids: number[]): number {
  return taskCount(world, ids, AntTask.Foraging);
}

describe('#126 V27 forager storage backpressure', () => {
  // (a) — saturated storage halts promotion, and it RESUMES when either a
  // chamber becomes depositable or the pool drains. Pause-aware target: we
  // assert the specific promotion suppression, not "no ant ever moves".
  describe('(a) saturated-storage suppression + resume', () => {
    it('halts idle→Foraging promotion when there is nowhere to deposit (V27)', () => {
      const { world, colonyId, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
      });
      const colony = world.colonies[colonyId]!;
      expect(colonyHasNoDepositTarget(colony, world.simVersion)).toBe(true);

      tick(world, []);

      // No idle ant was promoted to Foraging — bounded parking, not a churn.
      expect(foragerCount(world, idleIds)).toBe(0);
      // The canonical allocation is UNTOUCHED — only the local needForage was
      // suppressed. Step 8 set forage to the worker budget (4 workers, no nurse).
      expect(colony.computedAllocation.forage).toBe(4);
    });

    it('resumes promotion once a FoodStorage chamber becomes depositable (V27)', () => {
      const { world, colonyId, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
      });
      const colony = world.colonies[colonyId]!;
      tick(world, []);
      expect(foragerCount(world, idleIds)).toBe(0); // suppressed

      // Free a chamber slot → deposit target exists again.
      colony.chambers[0]!.foodStored = 0;
      expect(colonyHasNoDepositTarget(colony, world.simVersion)).toBe(false);
      tick(world, []);

      expect(foragerCount(world, idleIds)).toBeGreaterThan(0);
    });

    it('resumes promotion once the entrance pool drains below cap (V27)', () => {
      const { world, colonyId, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
      });
      const colony = world.colonies[colonyId]!;
      tick(world, []);
      expect(foragerCount(world, idleIds)).toBe(0); // suppressed

      // Drain the pool to full carry-headroom → the pool is a deposit target again.
      colony.foodStored = 0;
      expect(colonyHasNoDepositTarget(colony, world.simVersion)).toBe(false);
      tick(world, []);

      expect(foragerCount(world, idleIds)).toBeGreaterThan(0);
    });
  });

  // Backpressure suppresses FORAGE promotion only — it does not force idle ants
  // to park. An idle ant that would have foraged still fills any remaining
  // dig/fight/nurse demand (the eligibles carve is a sequential need chain).
  describe('(a2) suppressed-forage idle ants still fill other demand (not parked)', () => {
    it('V27: with saturated storage AND fight demand, idle ants go Fighting, not Foraging', () => {
      const { world, colonyId, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
      });
      const colony = world.colonies[colonyId]!;
      // Half the worker budget wants to fight; forage is backpressured.
      colony.targetRatio = { forage: 5, fight: 5 };

      tick(world, []);

      expect(foragerCount(world, idleIds)).toBe(0); // forage promotion suppressed
      expect(taskCount(world, idleIds, AntTask.Fighting)).toBeGreaterThan(0); // reallocated
    });
  });

  // (d) — backpressure is SCOPED to colonies that own a FoodStorage chamber (the
  // mature-colony pile-up of #126). A chamberless early-game colony keeps
  // foraging into its entrance pool rather than idling its workers — only its
  // CARRIERS park (the universal #27 wait-wake, which keys on
  // colonyHasNoDepositTarget directly, so a full chamberless pool still doesn't
  // thrash carriers). The carry-headroom hysteresis (codex P1) lives in
  // colonyHasNoDepositTarget so that wait-wake survives the queen's 2-fp churn.
  describe('(d) chamberless colonies keep foraging — backpressure scoped to chambered colonies', () => {
    it('V27: a full chamberless pool does NOT suppress idle→Foraging promotion', () => {
      const { world, colonyId, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
        noChamber: true,
      });
      const colony = world.colonies[colonyId]!;

      // The pool is full → carriers WOULD park (no deposit target)...
      expect(colonyHasNoDepositTarget(colony, world.simVersion)).toBe(true);
      // ...but promotion/demotion backpressure is NOT applied to a chamberless colony.
      expect(colonyForageBackpressure(colony, world.simVersion)).toBe(false);

      tick(world, []);
      expect(foragerCount(world, idleIds)).toBeGreaterThan(0); // idle ants still promoted
    });

    it('V27: carry-headroom hysteresis holds the chamberless wait-wake through the 2fp queen meal (codex P1)', () => {
      const { world, colonyId } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
        noChamber: true,
      });
      const colony = world.colonies[colonyId]!;

      tick(world, []); // queen eats 2 fp from the pool before any deposit

      // Pool dropped below cap but by far less than one pickup → V27 still has no
      // deposit target, so a CarryingFood ant's wait-wake gate keeps it parked
      // (no 2-fp thrash). Pre-V27 strict at-cap would have flipped this false.
      expect(colony.foodStored).toBeLessThan(BASE_FOOD_STORAGE_CAPACITY);
      expect(colony.foodStored).toBeGreaterThan(
        BASE_FOOD_STORAGE_CAPACITY - FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP,
      );
      expect(colonyHasNoDepositTarget(colony, world.simVersion)).toBe(true);
      expect(colonyHasNoDepositTarget(colony, SIM_VERSION_V26_SPIDER_EDGE_MARGIN)).toBe(false);
    });
  });

  // (c) — version gate. Identical saturated setup: V26 still promotes (the old
  // churn), V27 suppresses. This proves the gate, not just same-version parity.
  describe('(c) V26-vs-V27 gate', () => {
    it('V26 promotes idle ants into Foraging (pre-fix churn)', () => {
      const { world, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V26_SPIDER_EDGE_MARGIN,
      });
      tick(world, []);
      expect(foragerCount(world, idleIds)).toBeGreaterThan(0);
    });

    it('V27 suppresses promotion under the identical saturated state', () => {
      const { world, idleIds } = buildSaturatedWorld({
        simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE,
      });
      tick(world, []);
      expect(foragerCount(world, idleIds)).toBe(0);
    });
  });

  // (b) — the V27 suppression path is deterministic: two independent saturated
  // worlds from the same seed produce byte-identical state after 120 ticks
  // (the chamber stays non-depositable for ~256 ticks of 2/tick queen drain, so
  // the suppression branch is exercised every tick of the window).
  describe('(b) V27 fresh-run determinism', () => {
    function serialize(w: WorldState): string {
      const c = w.colonies[1]!;
      const ants: Array<[number, number, number, number, number]> = [];
      for (let id = 0; id < w.nextEntityId; id++) {
        ants.push([
          w.ants.alive[id]!,
          w.ants.task[id]!,
          w.ants.subTask[id]!,
          w.ants.posX[id]!,
          w.ants.posY[id]!,
        ]);
      }
      return JSON.stringify({
        tick: w.tick,
        rngState: w.rngState,
        foodStored: c.foodStored,
        chambers: c.chambers.map((ch) => ch.foodStored),
        computedAllocation: c.computedAllocation,
        taskCensus: c.taskCensus,
        ants,
      });
    }

    it('two V27 saturated worlds run byte-identical over 120 ticks', () => {
      const a = buildSaturatedWorld({ simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE });
      const b = buildSaturatedWorld({ simVersion: SIM_VERSION_V27_FORAGE_BACKPRESSURE });
      for (let t = 0; t < 120; t++) {
        tick(a.world, []);
        tick(b.world, []);
      }
      // Suppression actually exercised the whole window (chamber still full-ish).
      expect(colonyHasNoDepositTarget(a.world.colonies[1]!, a.world.simVersion)).toBe(true);
      expect(serialize(a.world)).toBe(serialize(b.world));
    });
  });
});
