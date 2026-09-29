// save-raid-clock.test.ts — #371 (V62): the AIStateRecord.raidSinceTick save field.
//
// The raid clock times how long a raid has held the AI's operations, so it must
// survive a save (a reload mid-raid resumes the same count). It is written only
// when set, so a world that never raids — every world below V62 — serializes
// exactly as before, and a save lacking it loads with the -1 (no raid) default.

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { ENEMY_COLONY_ID } from '../sim/constants.js';
import { getAIStateForColony } from '../sim/ai-state.js';
import { copyWorldState } from '../sim/types.js';

describe('#371 (V62) — AIStateRecord.raidSinceTick save field', () => {
  it('round-trips when set', () => {
    const world = createScenario(7);
    getAIStateForColony(world, ENEMY_COLONY_ID)!.raidSinceTick = 4321;
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
    expect(getAIStateForColony(loaded, ENEMY_COLONY_ID)!.raidSinceTick).toBe(4321);
  });

  it('is omitted when unset, and a save lacking it (or with junk) loads as -1', () => {
    const world = createScenario(7);
    const rec = getAIStateForColony(world, ENEMY_COLONY_ID)!;
    expect(rec.raidSinceTick).toBe(-1);
    const raw = JSON.parse(JSON.stringify(serializeWorldState(world))) as {
      aiState: Record<string, unknown>[];
    };
    expect(raw.aiState.every((r) => !('raidSinceTick' in r))).toBe(true);
    const load = (): number =>
      getAIStateForColony(deserializeWorldState(raw as never), ENEMY_COLONY_ID)!.raidSinceTick;
    expect(load()).toBe(-1);
    for (const junk of ['soon', 1.5, -7]) {
      raw.aiState[0]!['raidSinceTick'] = junk;
      expect(load()).toBe(-1);
    }
  });

  it('copyWorldState copies it (into a fresh and into a reused record)', () => {
    const world = createScenario(7);
    getAIStateForColony(world, ENEMY_COLONY_ID)!.raidSinceTick = 99;
    const dst = createScenario(8);
    dst.aiState.length = 0;
    copyWorldState(world, dst);
    expect(getAIStateForColony(dst, ENEMY_COLONY_ID)!.raidSinceTick).toBe(99);
    getAIStateForColony(world, ENEMY_COLONY_ID)!.raidSinceTick = 123;
    copyWorldState(world, dst);
    expect(getAIStateForColony(dst, ENEMY_COLONY_ID)!.raidSinceTick).toBe(123);
  });
});
