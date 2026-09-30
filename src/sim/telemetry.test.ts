// telemetry.test.ts — S0b: emitEvent cap enforcement + V15 migration
//
// Run: npx vitest run src/sim/telemetry.test.ts

import { describe, it, expect } from 'vitest';
import {
  emitEvent,
  isTerminalEvent,
  PLAYTRACE_EVENT_CAP_PER_ROUND,
  type SimEvent,
} from './telemetry.js';
import { createScenario } from './scenario.js';
// eslint-disable-next-line no-restricted-imports -- test exercises serialize/deserialize round-trip; must import from platform layer
import { serializeWorldState, deserializeWorldState } from '../platform/save.js';
import { SIM_VERSION_V15_TELEMETRY } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCombatKill(tick: number): SimEvent {
  return {
    tick,
    type: 'combat_kill',
    payload: {
      killer: { kind: 'Ant', id: 1, colonyId: 2 as unknown as ColonyId },
      victim: { kind: 'Ant', id: 2, colonyId: 1 as unknown as ColonyId },
      location: { x: 0, y: 0, grid: 'surface' },
    },
  };
}

function makeQueenDeath(tick: number): SimEvent {
  return {
    tick,
    type: 'queen_death',
    payload: {
      cause: null,
      location: { x: 5, y: 5, grid: 'underground' },
      aiStateAtTime: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cap enforcement tests
// ---------------------------------------------------------------------------

describe('emitEvent — under cap', () => {
  it('appends events normally when under cap', () => {
    const world = createScenario(1);
    expect(world.events).toHaveLength(0);
    emitEvent(world, makeCombatKill(1));
    emitEvent(world, makeCombatKill(2));
    expect(world.events).toHaveLength(2);
    expect(world.droppedCombatKillCount).toBe(0);
    expect(world.droppedStructuralCount).toBe(0);
  });
});

describe('emitEvent — combat_kill eviction at cap', () => {
  it('evicts oldest combat_kill and increments droppedCombatKillCount', () => {
    const world = createScenario(1);
    // Fill to cap with combat_kills (tick 0..CAP-1)
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND; i++) {
      world.events.push(makeCombatKill(i));
    }
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);

    // Emit one more combat_kill: should evict tick=0, append tick=CAP
    const newKill = makeCombatKill(PLAYTRACE_EVENT_CAP_PER_ROUND);
    emitEvent(world, newKill);

    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
    expect(world.droppedCombatKillCount).toBe(1);
    expect(world.droppedStructuralCount).toBe(0);
    // The evicted event was tick=0; tick=1 is now the oldest
    expect(world.events[0]!.tick).toBe(1);
    // The new event is last
    expect(world.events[PLAYTRACE_EVENT_CAP_PER_ROUND - 1]!.tick).toBe(
      PLAYTRACE_EVENT_CAP_PER_ROUND,
    );
  });

  it('evicts oldest combat_kill when a structural event pushes over cap', () => {
    const world = createScenario(1);
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND; i++) {
      world.events.push(makeCombatKill(i));
    }

    const queenDeath = makeQueenDeath(9999);
    emitEvent(world, queenDeath);

    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
    expect(world.droppedCombatKillCount).toBe(1);
    expect(world.droppedStructuralCount).toBe(0);
    // queen_death should be last
    const last = world.events[PLAYTRACE_EVENT_CAP_PER_ROUND - 1]!;
    expect(last.type).toBe('queen_death');
  });
});

describe('emitEvent — structural drop when no combat_kill available', () => {
  it('a buffer full of terminal events (no combat_kills) drops the new one and counts it', () => {
    const world = createScenario(1);
    // Fill with structural events (queen_death, not evictable)
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND; i++) {
      world.events.push(makeQueenDeath(i));
    }

    // Try to emit one more structural event
    emitEvent(world, makeQueenDeath(9999));

    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
    expect(world.droppedStructuralCount).toBe(1);
    expect(world.droppedCombatKillCount).toBe(0);
    // Last event should NOT be tick=9999 (was dropped)
    expect(world.events[PLAYTRACE_EVENT_CAP_PER_ROUND - 1]!.tick).toBe(
      PLAYTRACE_EVENT_CAP_PER_ROUND - 1,
    );
  });

  it('evicts combat_kills before any structural event', () => {
    const world = createScenario(1);
    // Half evictable structural (hunt starts), half combat_kill
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND / 2; i++) {
      world.events.push(makeHuntStart(i));
    }
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND / 2; i++) {
      world.events.push(makeCombatKill(i + 1000));
    }
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);

    // Structural event: should evict a combat_kill, not a hunt start
    emitEvent(world, makeQueenDeath(9999));
    expect(world.droppedCombatKillCount).toBe(1);
    expect(world.droppedStructuralCount).toBe(0);
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
    expect(world.events[0]!.type).toBe('spider_hunt_start'); // the oldest structural event stays
    expect(world.events[0]!.tick).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #388 — terminal events are always recorded
// ---------------------------------------------------------------------------

const CAP = PLAYTRACE_EVENT_CAP_PER_ROUND;

function makeHuntStart(tick: number): SimEvent {
  return {
    tick,
    type: 'spider_hunt_start',
    payload: { reticleTile: { x: 1, y: 1, grid: 'surface' }, targetWorkers: 0 },
  };
}

function makeInvasionStart(tick: number): SimEvent {
  return {
    tick,
    type: 'invasion_start',
    payload: {
      colonyId: 2 as unknown as ColonyId,
      rallyTile: { x: 3, y: 3, grid: 'surface' },
      fighterCount: 4,
      targetGrid: 1 as unknown as ColonyId,
    },
  };
}

function makeStalemateEnd(tick: number): SimEvent {
  return {
    tick,
    type: 'round_end',
    payload: { reason: 'StalemateTiebreak', playerWorkerCount: 0, aiWorkerCount: 0 },
  };
}

/** A world whose buffer is full of non-terminal structural events (ticks 0..CAP-1). */
function fullOfHuntStarts(): ReturnType<typeof createScenario> {
  const world = createScenario(1);
  for (let i = 0; i < CAP; i++) world.events.push(makeHuntStart(i));
  return world;
}

describe('#388 emitEvent — a full buffer of structural events', () => {
  it('records a queen_death: the oldest non-terminal structural event is evicted', () => {
    const world = fullOfHuntStarts();
    emitEvent(world, makeQueenDeath(9999));
    expect(world.events).toHaveLength(CAP);
    expect(world.events[CAP - 1]!.type).toBe('queen_death');
    expect(world.events[0]!.tick).toBe(1); // tick 0 was the oldest
    expect(world.droppedStructuralCount).toBe(1); // one structural event lost, as before
    expect(world.droppedCombatKillCount).toBe(0);
  });

  it('records a round_end the same way', () => {
    const world = fullOfHuntStarts();
    emitEvent(world, makeStalemateEnd(9999));
    expect(world.events[CAP - 1]!.type).toBe('round_end');
    expect(world.droppedStructuralCount).toBe(1);
  });

  it('records a new invasion_start (the render warning keys on it)', () => {
    const world = fullOfHuntStarts();
    emitEvent(world, makeInvasionStart(9999));
    expect(world.events[CAP - 1]!.type).toBe('invasion_start');
    expect(world.events).toHaveLength(CAP);
  });

  it('never evicts a terminal event, however many structural events follow', () => {
    const world = createScenario(1);
    world.events.push(makeQueenDeath(0), makeStalemateEnd(1));
    for (let i = 2; i < CAP; i++) world.events.push(makeHuntStart(i));
    for (let i = 0; i < 3 * CAP; i++) emitEvent(world, makeInvasionStart(10_000 + i));
    expect(world.events).toHaveLength(CAP);
    expect(world.events.filter((e) => e.type === 'queen_death')).toHaveLength(1);
    expect(world.events.filter((e) => e.type === 'round_end')).toHaveLength(1);
    expect(world.droppedStructuralCount).toBe(3 * CAP);
  });

  it('drops a new combat_kill (lowest priority) instead of evicting a structural event', () => {
    const world = fullOfHuntStarts();
    emitEvent(world, makeCombatKill(9999));
    expect(world.events.some((e) => e.type === 'combat_kill')).toBe(false);
    expect(world.events[0]!.tick).toBe(0);
    expect(world.droppedStructuralCount).toBe(1); // counted as before
  });

  it('a buffer of nothing but terminal events drops the new event', () => {
    const world = createScenario(1);
    for (let i = 0; i < CAP; i++) world.events.push(makeQueenDeath(i));
    emitEvent(world, makeInvasionStart(9999));
    expect(world.events[CAP - 1]!.tick).toBe(CAP - 1);
    expect(world.droppedStructuralCount).toBe(1);
  });

  it('isTerminalEvent: queen_death and round_end only', () => {
    expect(isTerminalEvent(makeQueenDeath(0))).toBe(true);
    expect(isTerminalEvent(makeStalemateEnd(0))).toBe(true);
    expect(isTerminalEvent(makeInvasionStart(0))).toBe(false);
    expect(isTerminalEvent(makeHuntStart(0))).toBe(false);
    expect(isTerminalEvent(makeCombatKill(0))).toBe(false);
  });
});

/** The pre-#388 rule, verbatim: evict the oldest combat_kill, else drop the new event. */
function oldRuleEmit(
  ref: { events: SimEvent[]; droppedCombatKillCount: number; droppedStructuralCount: number },
  event: SimEvent,
): void {
  if (ref.events.length < CAP) {
    ref.events.push(event);
    return;
  }
  const idx = ref.events.findIndex((e) => e.type === 'combat_kill');
  if (idx >= 0) {
    ref.events.splice(idx, 1);
    ref.events.push(event);
    ref.droppedCombatKillCount += 1;
  } else {
    ref.droppedStructuralCount += 1;
  }
}

describe('#388 emitEvent — saved state is exactly what the old rule gave (no simVersion gate)', () => {
  it('length, combat_kill count and both saved counters match the old rule at every emit', () => {
    const world = createScenario(1);
    const ref = { events: [] as SimEvent[], droppedCombatKillCount: 0, droppedStructuralCount: 0 };
    // Deterministic LCG (test-only), phases that fill with kills, drain them with
    // structural events until the buffer holds none, then mix — every branch runs
    // except the all-terminal one, which has its own test above.
    let r = 12345;
    const next = (): number => {
      r = (Math.imul(r, 1103515245) + 12345) >>> 0;
      return r >>> 16;
    };
    const phases: Array<[number, number]> = [
      [2600, 80], // mostly kills
      [4200, 5], // mostly structural: the kills get evicted, then structural overflow
      [3000, 40],
      [2500, 0],
    ];
    let t = 0;
    let newBranchHits = 0;
    for (const [count, killPct] of phases) {
      for (let i = 0; i < count; i++, t++) {
        const roll = next() % 100;
        const ev =
          roll < killPct
            ? makeCombatKill(t)
            : roll % 23 === 0
              ? makeQueenDeath(t)
              : roll % 2 === 0
                ? makeInvasionStart(t)
                : makeHuntStart(t);
        const before = world.droppedStructuralCount;
        emitEvent(world, ev);
        oldRuleEmit(ref, ev);
        if (world.droppedStructuralCount > before && ev.type !== 'combat_kill') {
          newBranchHits += 1;
        }
        expect(world.events.length, `emit ${t}`).toBe(ref.events.length);
        expect(world.droppedCombatKillCount, `emit ${t}`).toBe(ref.droppedCombatKillCount);
        expect(world.droppedStructuralCount, `emit ${t}`).toBe(ref.droppedStructuralCount);
        expect(world.events.filter((e) => e.type === 'combat_kill').length, `emit ${t}`).toBe(
          ref.events.filter((e) => e.type === 'combat_kill').length,
        );
      }
    }
    // Non-vacuity: the new branch (keep the new event, evict an old one) ran.
    expect(newBranchHits).toBeGreaterThan(100);
    expect(world.droppedCombatKillCount).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// V15 save migration — events + counters
// ---------------------------------------------------------------------------

describe('V15 migration — deserializeWorldState', () => {
  it('V15 sentinel constant has value 15', () => {
    expect(SIM_VERSION_V15_TELEMETRY).toBe(15);
  });

  it('pre-V15 save (missing droppedCombatKillCount/droppedStructuralCount) loads with counters = 0', () => {
    const world = createScenario(42);
    const serialized = serializeWorldState(world);

    // Simulate a pre-V15 save by deleting the new fields
    const raw = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
    delete raw['droppedCombatKillCount'];
    delete raw['droppedStructuralCount'];

    const restored = deserializeWorldState(
      raw as unknown as Parameters<typeof deserializeWorldState>[0],
    );
    expect(restored.events).toEqual([]);
    expect(restored.droppedCombatKillCount).toBe(0);
    expect(restored.droppedStructuralCount).toBe(0);
  });

  it('round-trips events field not serialized (events always empty after load)', () => {
    const world = createScenario(42);
    // Add some events to the live world
    emitEvent(world, makeCombatKill(1));
    emitEvent(world, makeQueenDeath(2));
    expect(world.events).toHaveLength(2);

    // Serialize -> events should not appear in snapshot
    const serialized = serializeWorldState(world);
    expect((serialized as unknown as Record<string, unknown>)['events']).toBeUndefined();

    // Deserialize -> events reset to []
    const restored = deserializeWorldState(serialized);
    expect(restored.events).toEqual([]);
  });

  it('droppedCombatKillCount and droppedStructuralCount survive round-trip', () => {
    const world = createScenario(42);
    world.droppedCombatKillCount = 7;
    world.droppedStructuralCount = 3;

    const restored = deserializeWorldState(serializeWorldState(world));
    expect(restored.droppedCombatKillCount).toBe(7);
    expect(restored.droppedStructuralCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// queen_death emission
// ---------------------------------------------------------------------------

describe('queen_death emission format', () => {
  it('emits a well-formed queen_death event', () => {
    const world = createScenario(1);
    const ev = makeQueenDeath(42);
    emitEvent(world, ev);

    expect(world.events).toHaveLength(1);
    const emitted = world.events[0]!;
    expect(emitted.type).toBe('queen_death');
    if (emitted.type === 'queen_death') {
      expect(emitted.payload.cause).toBeNull();
      expect(emitted.payload.location.grid).toBe('underground');
      expect(emitted.payload.aiStateAtTime).toBeNull();
    }
  });
});
