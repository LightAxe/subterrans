// save-flee-column.test.ts — #209 PR A (V34): save-shape for the new
// `fleeShelterUntilTick` ant SoA column.
//
// Proves the column round-trips serialize→deserialize AND is OPTIONAL-on-load:
// a pre-V34 in-window save (MIN_ACCEPTED..V33) predates the column, so it is
// absent and every ant loads with the -1 ("not fleeing") default — MIN_ACCEPTED
// stays put, so those saves keep loading.

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { LATEST_SIM_VERSION, SIM_VERSION_V34_IDLE_RESERVE_FLEE } from '../sim/types.js';

describe('#209 PR A — fleeShelterUntilTick save column', () => {
  it('LATEST_SIM_VERSION is V34', () => {
    expect(LATEST_SIM_VERSION).toBe(SIM_VERSION_V34_IDLE_RESERVE_FLEE);
    expect(createScenario(42).simVersion).toBe(SIM_VERSION_V34_IDLE_RESERVE_FLEE);
  });

  it('round-trips distinct flee/shelter phases through serialize→deserialize', () => {
    const w = createScenario(42);
    // Stamp three representative phases onto live ant slots: -1, 0, a tick value.
    w.ants.fleeShelterUntilTick[0] = -1;
    w.ants.fleeShelterUntilTick[1] = 0;
    w.ants.fleeShelterUntilTick[2] = 9321;
    const restored = deserializeWorldState(serializeWorldState(w));
    expect(restored.ants.fleeShelterUntilTick[0]).toBe(-1);
    expect(restored.ants.fleeShelterUntilTick[1]).toBe(0);
    expect(restored.ants.fleeShelterUntilTick[2]).toBe(9321);
  });

  it('is OPTIONAL-on-load: a save lacking the column loads with the -1 default', () => {
    const w = createScenario(42);
    w.ants.fleeShelterUntilTick[3] = 555; // would be lost — the column is dropped below
    const s = serializeWorldState(w);
    // Simulate a pre-V34 save: strip the column entirely.
    delete (s.ants as { fleeShelterUntilTick?: number[] }).fleeShelterUntilTick;
    const restored = deserializeWorldState(s);
    // Every ant defaults to -1 (not fleeing); no throw on the missing column.
    for (let i = 0; i < restored.nextEntityId; i++) {
      expect(restored.ants.fleeShelterUntilTick[i]).toBe(-1);
    }
  });

  it('rejects an out-of-range flee value (validation guard)', () => {
    const w = createScenario(42);
    const s = serializeWorldState(w);
    s.ants.fleeShelterUntilTick![0] = -2; // only -1, 0, or >=0 are valid
    expect(() => deserializeWorldState(s)).toThrow(/fleeShelterUntilTick/);
  });
});
