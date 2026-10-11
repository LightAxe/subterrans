// save-last-raid-type.test.ts — #366 (V77): the AIStateRecord.lastRaidType save field.
//
// The AI's raid-type choice reads the type of its last wave (no two Blockades running;
// a siege after a repelled Loot raid), so it must survive a save. It is written only
// when not Loot, so a colony that never ended a non-Loot wave serializes as before,
// and a save lacking it (or holding junk) loads as Loot.

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { ENEMY_COLONY_ID } from '../sim/constants.js';
import { getAIStateForColony } from '../sim/ai-state.js';
import { copyWorldState } from '../sim/types.js';
import { RaidType } from '../sim/enums.js';

describe('#366 (V77) — AIStateRecord.lastRaidType save field', () => {
  it('round-trips when set', () => {
    for (const t of [RaidType.Deny, RaidType.Spoil, RaidType.Blockade, RaidType.Assault]) {
      const world = createScenario(7);
      getAIStateForColony(world, ENEMY_COLONY_ID)!.lastRaidType = t;
      const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
      expect(getAIStateForColony(loaded, ENEMY_COLONY_ID)!.lastRaidType).toBe(t);
    }
  });

  it('is omitted when Loot, and a save lacking it (or with junk) loads as Loot', () => {
    const world = createScenario(7);
    expect(getAIStateForColony(world, ENEMY_COLONY_ID)!.lastRaidType).toBe(RaidType.Loot);
    const raw = JSON.parse(JSON.stringify(serializeWorldState(world))) as {
      aiState: Record<string, unknown>[];
    };
    expect(raw.aiState.length).toBeGreaterThan(0);
    expect(raw.aiState.every((r) => !('lastRaidType' in r))).toBe(true);
    const load = (): number =>
      getAIStateForColony(deserializeWorldState(raw as never), ENEMY_COLONY_ID)!.lastRaidType;
    expect(load()).toBe(RaidType.Loot);
    for (const junk of ['x', 1.5, -1, 5, 99, null, true]) {
      raw.aiState[0]!['lastRaidType'] = junk;
      expect(load(), String(junk)).toBe(RaidType.Loot);
    }
    raw.aiState[0]!['lastRaidType'] = RaidType.Blockade;
    expect(load()).toBe(RaidType.Blockade);
  });

  it('copyWorldState carries it (reused and grown records)', () => {
    const src = createScenario(7);
    getAIStateForColony(src, ENEMY_COLONY_ID)!.lastRaidType = RaidType.Blockade;
    const reuse = createScenario(7);
    copyWorldState(src, reuse);
    expect(getAIStateForColony(reuse, ENEMY_COLONY_ID)!.lastRaidType).toBe(RaidType.Blockade);
    const grow = createScenario(7);
    grow.aiState.length = 0;
    copyWorldState(src, grow);
    expect(getAIStateForColony(grow, ENEMY_COLONY_ID)!.lastRaidType).toBe(RaidType.Blockade);
  });
});
