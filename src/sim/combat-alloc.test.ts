// src/sim/combat-alloc.test.ts — allocation regression guard for the combat sweep (#162).
//
// The per-tick combat sweep (detectAndResolveCombat) must not allocate
// Map/Set/Array.from on every tick — it runs on EVERY sim tick, including
// steady-state and no-combat ticks (AGENTS.md hot-loop no-alloc rule). This
// test pins that contract: it patches the global Map/Set constructors and
// Array.from to count constructions while the sweep runs many ticks, and
// asserts the count stays at zero. A regression that re-introduces a per-tick
// Map/Set/Array.from (the structures the old bucketing sweep used) fails here.
//
// Scope note: this catches the specific named offenders that were removed
// (Map, Set, Array.from). It deliberately does NOT try to count array/object
// literals or Array.prototype.sort's internal scratch — those cannot be
// intercepted without a global heap profiler, which would be flaky in CI and
// is banned (wall-clock/perf APIs) in src/sim anyway. The guard is deterministic.

import { describe, it, expect } from 'vitest';
import { detectAndResolveCombat } from './combat.js';
import { createWorldState, allocateEntityId } from './types.js';
import { Rng } from './rng.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { WORKER_BASE_SPEED, WORKER_LIFESPAN_TICKS } from './constants.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

function makeWorldWith2Colonies(seed = 42): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const world = createWorldState(seed);
  const queen1 = allocateEntityId(world);
  initAnt(world.ants, queen1, { colonyId: 1, posX: 0 << FP_SHIFT, posY: 0 << FP_SHIFT, task: AntTask.Idle, subTask: 0, speed: 0, lifespan: WORKER_LIFESPAN_TICKS });
  const colony1 = createColonyRecord(1 as ColonyId, queen1);
  colony1.entrances = [];
  colony1.rallyPoint = null;
  colony1.digFlowFieldDirty = false;
  world.colonies[1] = colony1;

  const queen2 = allocateEntityId(world);
  initAnt(world.ants, queen2, { colonyId: 2, posX: 1 << FP_SHIFT, posY: 0 << FP_SHIFT, task: AntTask.Idle, subTask: 0, speed: 0, lifespan: WORKER_LIFESPAN_TICKS });
  const colony2 = createColonyRecord(2 as ColonyId, queen2);
  colony2.entrances = [];
  colony2.rallyPoint = null;
  colony2.digFlowFieldDirty = false;
  world.colonies[2] = colony2;

  return { world, cid1: 1 as ColonyId, cid2: 2 as ColonyId };
}

function spawnAnt(world: WorldState, colonyId: ColonyId, tileX: number, tileY: number, zone: Zone): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId, posX: (tileX << FP_SHIFT) + (FP_ONE >> 1), posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle, subTask: 0, speed: WORKER_BASE_SPEED, zone,
  });
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

/**
 * Run `fn` with global Map/Set constructors and Array.from instrumented to
 * count constructions. Restores the originals afterwards (even on throw).
 */
function countMapSetArrayFromDuring(fn: () => void): number {
  const RealMap = globalThis.Map;
  const RealSet = globalThis.Set;
  const realArrayFrom = Array.from;
  let allocCount = 0;

  class CountingMap<K, V> extends RealMap<K, V> {
    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
      allocCount += 1;
    }
  }
  class CountingSet<T> extends RealSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      allocCount += 1;
    }
  }
  const countingFrom = function from(this: unknown, ...args: unknown[]): unknown[] {
    allocCount += 1;
    return (realArrayFrom as (...a: unknown[]) => unknown[]).apply(Array, args);
  };

  globalThis.Map = CountingMap as unknown as MapConstructor;
  globalThis.Set = CountingSet as unknown as SetConstructor;
  Array.from = countingFrom as unknown as typeof Array.from;
  try {
    fn();
  } finally {
    globalThis.Map = RealMap;
    globalThis.Set = RealSet;
    Array.from = realArrayFrom;
  }
  return allocCount;
}

describe('detectAndResolveCombat — per-tick allocation guard (#162)', () => {
  it('instrumentation actually counts Map/Set/Array.from (self-check)', () => {
    // Guards against a false pass: if the patching ever silently stopped
    // intercepting, the zero-allocation assertions below would be meaningless.
    const counted = countMapSetArrayFromDuring(() => {
      new Map();
      new Set();
      Array.from([1, 2, 3]);
    });
    expect(counted).toBe(3);
  });

  it('allocates no Map/Set/Array.from over many no-combat ticks', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    // Many live, colony-affiliated ants on DISTINCT tiles: exercises the full
    // bucket → sort → contested-clear sweep, but no tile is contested.
    for (let x = 2; x < 30; x++) {
      spawnAnt(world, cid1, x, 5, Zone.Surface);
      spawnAnt(world, cid2, x, 9, Zone.Surface);
    }
    // Warm up: the first call grows the reusable typed-array scratch (a one-time
    // allocation), so measure only steady-state ticks afterward.
    detectAndResolveCombat(world, new Rng(world.rngState));

    const allocs = countMapSetArrayFromDuring(() => {
      for (let t = 0; t < 300; t++) {
        detectAndResolveCombat(world, new Rng(world.rngState));
      }
    });
    expect(allocs).toBe(0);
  });

  it('allocates no Map/Set/Array.from while resolving an ongoing fight', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    // Two fighters share a contested tile; give them large HP so they trade
    // strikes for many ticks without dying — exercises the resolver hot path.
    const a = spawnAnt(world, cid1, 7, 7, Zone.Surface);
    const b = spawnAnt(world, cid2, 7, 7, Zone.Surface);
    world.ants.task[a] = AntTask.Fighting;
    world.ants.task[b] = AntTask.Fighting;
    world.ants.hp[a] = 1_000_000;
    world.ants.hp[b] = 1_000_000;
    detectAndResolveCombat(world, new Rng(world.rngState)); // warm up scratch

    const allocs = countMapSetArrayFromDuring(() => {
      for (let t = 0; t < 300; t++) {
        detectAndResolveCombat(world, new Rng(world.rngState));
      }
    });
    expect(allocs).toBe(0);
    // Sanity: both fighters are still alive (HP was high enough to keep the
    // resolver on its strike/cooldown path, not the kill path).
    expect(world.ants.alive[a]).toBe(1);
    expect(world.ants.alive[b]).toBe(1);
  });
});
