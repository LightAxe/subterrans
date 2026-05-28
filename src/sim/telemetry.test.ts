// telemetry.test.ts — S0b: emitEvent cap enforcement + V15 migration
//
// Run: npx vitest run src/sim/telemetry.test.ts

import { describe, it, expect } from 'vitest';
import { emitEvent, PLAYTRACE_EVENT_CAP_PER_ROUND, type SimEvent } from './telemetry.js';
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
    expect(world.events[PLAYTRACE_EVENT_CAP_PER_ROUND - 1]!.tick).toBe(PLAYTRACE_EVENT_CAP_PER_ROUND);
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
  it('drops new structural event and increments droppedStructuralCount when buffer full with no combat_kills', () => {
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
    expect(world.events[PLAYTRACE_EVENT_CAP_PER_ROUND - 1]!.tick).toBe(PLAYTRACE_EVENT_CAP_PER_ROUND - 1);
  });

  it('evicts combat_kills before falling back to structural drop', () => {
    const world = createScenario(1);
    // Half structural, half combat_kill
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND / 2; i++) {
      world.events.push(makeQueenDeath(i));
    }
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < PLAYTRACE_EVENT_CAP_PER_ROUND / 2; i++) {
      world.events.push(makeCombatKill(i + 1000));
    }
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);

    // Structural event: should evict a combat_kill, not drop
    emitEvent(world, makeQueenDeath(9999));
    expect(world.droppedCombatKillCount).toBe(1);
    expect(world.droppedStructuralCount).toBe(0);
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
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

    const restored = deserializeWorldState(raw as unknown as Parameters<typeof deserializeWorldState>[0]);
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
