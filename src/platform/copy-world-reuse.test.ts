// src/platform/copy-world-reuse.test.ts
//
// #340 — copyWorldState into a destination that has ALREADY been ticked, then
// ticking that destination, must match ticking a fresh copy hash-for-hash.
//
// Root cause of the original divergence: tick.ts keeps per-world flow-field
// caches (dig / entrance / chamber BFS fields) OFF WorldState, rebuilt only when
// a colony's dirty flags are set or on a world's first tick. A copy brings over
// the source's (normally clear) dirty flags, so a previously-ticked destination
// kept routing on the flow fields of its OWN old topology and drifted within a
// few dozen ticks. copyWorldState now drops the destination's off-WorldState
// caches (flow fields + scratch arena) and its own transient events.
//
// Lives in platform/ (not sim/) for hashWorldState (save serializer), like
// byte-gate.test.ts. Both colonies run the rule-based AI so the worlds dig and
// build chambers (topology changes the stale flow fields would miss).
import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick, __getChamberFlowFieldsForTest } from '../sim/tick.js';
import { copyWorldState, type WorldState } from '../sim/types.js';
import { getScratch } from '../sim/scratch.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { runAIController } from '../render/ai-controller.js';
import { hashWorldState } from './world-hash.js';

/** One tick as the game (and check:ai-economy --both-ai) drives it. */
function step(w: WorldState): void {
  runAIController(w, ENEMY_COLONY_ID);
  runAIController(w, PLAYER_COLONY_ID);
  tick(w, w.commandQueue.splice(0));
}

function run(w: WorldState, ticks: number): WorldState {
  for (let i = 0; i < ticks; i++) step(w);
  return w;
}

/** A never-ticked destination holding a copy of `src`. */
function freshCopy(src: WorldState): WorldState {
  const dst = createScenario(0);
  copyWorldState(src, dst);
  return dst;
}

/** Full-state hashes are compared every HASH_EVERY ticks (and at the end): a
 *  full save serialize per tick would dominate the test's runtime. */
const HASH_EVERY = 10;

/** Tick both worlds `ticks` times; return the first checked tick whose hashes differ, or -1. */
function firstDivergence(reused: WorldState, fresh: WorldState, ticks: number): number {
  expect(hashWorldState(reused)).toBe(hashWorldState(fresh));
  for (let t = 1; t <= ticks; t++) {
    step(reused);
    step(fresh);
    if ((t % HASH_EVERY === 0 || t === ticks) && hashWorldState(reused) !== hashWorldState(fresh))
      return t;
  }
  return -1;
}

const COMPARE_TICKS = 300;

describe('#340: a reused (previously ticked) copyWorldState destination ticks like a fresh copy', () => {
  it('rollback: a world rolled back onto its own earlier snapshot', () => {
    // The world digs on between the snapshot and the rollback, so its flow
    // fields describe a later topology than the snapshot's.
    const world = run(createScenario(4), 1500);
    const snapshot = freshCopy(world);
    run(world, 1500);
    copyWorldState(snapshot, world);
    const fresh = freshCopy(snapshot);
    expect(firstDivergence(world, fresh, COMPARE_TICKS)).toBe(-1);
  }, 120_000);

  it('cross-world: a destination previously ticked as a different seed', () => {
    const src = run(createScenario(1), 2500);
    const dst = run(createScenario(2), 3000);
    copyWorldState(src, dst);
    const fresh = freshCopy(src);
    expect(firstDivergence(dst, fresh, COMPARE_TICKS)).toBe(-1);
  }, 120_000);

  it('drops the destination off-WorldState caches and transient session state', () => {
    const src = createScenario(3);
    const dst = run(createScenario(5), 50);
    const arenaBefore = getScratch(dst);
    const flowBefore = __getChamberFlowFieldsForTest(dst);
    dst.events.push({
      tick: 1,
      type: 'spider_hunt_end',
      payload: { outcome: 'kill', deaths: 1 },
    });
    dst.droppedCommandOverflowCount = 7;
    dst.pendingQueenDeathContexts[1] = null;
    const eventsArray = dst.events;

    copyWorldState(src, dst);

    expect(getScratch(dst)).not.toBe(arenaBefore);
    expect(__getChamberFlowFieldsForTest(dst)).not.toBe(flowBefore);
    expect(dst.events).toBe(eventsArray); // emptied in place, not reallocated
    expect(dst.events.length).toBe(0);
    expect(dst.droppedCommandOverflowCount).toBe(0);
    expect(dst.pendingQueenDeathContexts.length).toBe(0);
  });

  it('a self-copy is a no-op: the world keeps its caches and events', () => {
    const w = run(createScenario(7), 50);
    const arena = getScratch(w);
    w.events.push({ tick: 1, type: 'spider_hunt_end', payload: { outcome: 'kill', deaths: 1 } });
    const before = hashWorldState(w);
    copyWorldState(w, w);
    expect(getScratch(w)).toBe(arena);
    expect(w.events.length).toBeGreaterThan(0);
    expect(hashWorldState(w)).toBe(before);
  });
});
