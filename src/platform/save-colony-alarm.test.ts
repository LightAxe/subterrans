// save-colony-alarm.test.ts — C1 (V42): the ColonyRecord.alarmActive save column.
//
// The alarm is the first PLAYER STANCE that survives a save: reload during a raid
// and the colony must still be sheltering, not pour back onto the surface. These
// pin the column's three obligations — it round-trips, it is optional-on-load so
// pre-V42 saves keep working, and a tampered non-boolean cannot smuggle a truthy
// value into a sim branch.

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import type { SerializedWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { LATEST_SIM_VERSION, SIM_VERSION_V42_COLONY_ALARM } from '../sim/types.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';

describe('C1 (V42) — ColonyRecord.alarmActive save column', () => {
  it('the alarm column ships from V42 onward', () => {
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V42_COLONY_ALARM);
    expect(createScenario(42).simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V42_COLONY_ALARM);
  });

  it('round-trips per colony through serialize → deserialize', () => {
    const world = createScenario(7);
    world.colonies[PLAYER_COLONY_ID]!.alarmActive = true;
    world.colonies[ENEMY_COLONY_ID]!.alarmActive = false;
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
    expect(loaded).not.toBeNull();
    expect(loaded.colonies[PLAYER_COLONY_ID]!.alarmActive).toBe(true);
    expect(loaded.colonies[ENEMY_COLONY_ID]!.alarmActive).toBe(false);
  });

  it('is OPTIONAL-on-load: a pre-V42 save lacking the column loads with the false default', () => {
    const world = createScenario(7);
    world.colonies[PLAYER_COLONY_ID]!.alarmActive = true;
    const raw = JSON.parse(
      JSON.stringify(serializeWorldState(world)),
    ) as unknown as SerializedWorldState & Record<string, unknown>;
    const colonies = raw['colonies'] as unknown as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(colonies)) delete colonies[key]!['alarmActive'];
    const loaded = deserializeWorldState(raw);
    expect(loaded).not.toBeNull();
    expect(loaded.colonies[PLAYER_COLONY_ID]!.alarmActive).toBe(false);
  });

  it('coerces a tampered non-boolean to false rather than letting it reach a sim branch', () => {
    const world = createScenario(7);
    const raw = JSON.parse(
      JSON.stringify(serializeWorldState(world)),
    ) as unknown as SerializedWorldState & Record<string, unknown>;
    const colonies = raw['colonies'] as unknown as Record<string, Record<string, unknown>>;
    // A truthy non-boolean is the dangerous shape: `if (colony.alarmActive)` would
    // accept it, so the loader must narrow with `=== true`, not coerce.
    colonies[String(PLAYER_COLONY_ID)]!['alarmActive'] = 'yes';
    const loaded = deserializeWorldState(raw);
    expect(loaded).not.toBeNull();
    expect(loaded.colonies[PLAYER_COLONY_ID]!.alarmActive).toBe(false);
  });
});
