// save-raid-order.test.ts — #352 (V60): the ColonyRecord.raidType save field.
//
// A raid order is a player stance that must survive a reload (reload mid-blockade
// and the fighters must still hold the ring, not go down). These pin the field's
// obligations: it round-trips; it is written only when it is not Loot, so every
// Loot colony serializes exactly as before V60; absent loads as Loot; and a tampered
// value — out of range or a written Loot — is rejected. (#400 retired the pre-V60
// save arms: MIN_ACCEPTED is V71 or later, so no pre-V60 save loads.)

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import type { SerializedWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { RaidType } from '../sim/enums.js';

type RawColonies = Record<string, Record<string, unknown>>;

function raw(world: ReturnType<typeof createScenario>): {
  save: SerializedWorldState;
  colonies: RawColonies;
} {
  const save = JSON.parse(JSON.stringify(serializeWorldState(world))) as SerializedWorldState;
  return { save, colonies: (save as unknown as { colonies: RawColonies }).colonies };
}

describe('#352 (V60) — ColonyRecord.raidType save field', () => {
  it('round-trips every raid type', () => {
    for (const type of Object.values(RaidType)) {
      const world = createScenario(7);
      world.colonies[PLAYER_COLONY_ID]!.raidType = type;
      const loaded = deserializeWorldState(raw(world).save);
      expect(loaded.colonies[PLAYER_COLONY_ID]!.raidType).toBe(type);
      expect(loaded.colonies[ENEMY_COLONY_ID]!.raidType).toBe(RaidType.Loot);
    }
  });

  it('is written only when not Loot (a Loot colony serializes as before V60)', () => {
    const world = createScenario(7);
    world.colonies[PLAYER_COLONY_ID]!.raidType = RaidType.Blockade;
    const { colonies } = raw(world);
    expect(colonies[String(PLAYER_COLONY_ID)]!['raidType']).toBe(RaidType.Blockade);
    expect('raidType' in colonies[String(ENEMY_COLONY_ID)]!).toBe(false);
  });

  it('a save with no raidType field anywhere loads, every colony Loot', () => {
    const world = createScenario(7);
    const { save, colonies } = raw(world);
    for (const c of Object.values(colonies)) expect('raidType' in c).toBe(false);
    const loaded = deserializeWorldState(save);
    for (const c of Object.values(loaded.colonies)) expect(c.raidType).toBe(RaidType.Loot);
  });

  it('rejects a tampered value: out of range, non-integer, a written Loot, a string', () => {
    for (const bad of [5, -1, 1.5, 0, '2', null]) {
      const world = createScenario(7);
      const { save, colonies } = raw(world);
      colonies[String(PLAYER_COLONY_ID)]!['raidType'] = bad;
      expect(() => deserializeWorldState(save)).toThrow(/raidType/);
    }
  });
});
