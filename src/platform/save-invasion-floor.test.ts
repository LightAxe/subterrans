// save-invasion-floor.test.ts — #398 (V72): the AIStateRecord.invasionFloor save field.
//
// The invasion floor holds the AI's next launch until it has the fighters (or its
// patience runs out), so it must survive a save: a reload mid-muster keeps waiting for
// the same wave. It is written only when non-zero, so a colony whose invasions were
// never repelled serializes as before, and a save lacking it loads with 0 (no floor).

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { ENEMY_COLONY_ID, AI_RECOVERY_DURATION_TICKS } from '../sim/constants.js';
import { getAIStateForColony } from '../sim/ai-state.js';
import { copyWorldState } from '../sim/types.js';

describe('#398 (V72) — AIStateRecord.invasionFloor save field', () => {
  it('round-trips when set', () => {
    const world = createScenario(7);
    getAIStateForColony(world, ENEMY_COLONY_ID)!.invasionFloor = 26;
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
    expect(getAIStateForColony(loaded, ENEMY_COLONY_ID)!.invasionFloor).toBe(26);
  });

  it('is omitted when 0, and a save lacking it (or with junk) loads as 0', () => {
    const world = createScenario(7);
    const rec = getAIStateForColony(world, ENEMY_COLONY_ID)!;
    expect(rec.invasionFloor).toBe(0);
    const raw = JSON.parse(JSON.stringify(serializeWorldState(world))) as {
      aiState: Record<string, unknown>[];
    };
    expect(raw.aiState.length).toBeGreaterThan(0);
    expect(raw.aiState.every((r) => !('invasionFloor' in r))).toBe(true);
    const load = (): number =>
      getAIStateForColony(deserializeWorldState(raw as never), ENEMY_COLONY_ID)!.invasionFloor;
    expect(load()).toBe(0);
    for (const junk of ['x', 1.5, -7, null, true]) {
      raw.aiState[0]!['invasionFloor'] = junk;
      expect(load(), String(junk)).toBe(0);
    }
    raw.aiState[0]!['invasionFloor'] = 30;
    expect(load()).toBe(30);
    // An edited value above the tier's cap (Normal: 32) is clamped.
    raw.aiState[0]!['invasionFloor'] = 1000;
    expect(load()).toBe(32);
  });

  it("an edited value loads clamped to the save's own tier cap (Easy 24, Normal and Hard 32)", () => {
    for (const [difficulty, v, want] of [
      ['Easy', 30, 24],
      ['Easy', 24, 24],
      ['Easy', 20, 20],
      ['Normal', 40, 32],
      ['Hard', 40, 32],
    ] as const) {
      const raw = JSON.parse(
        JSON.stringify(serializeWorldState(createScenario(7, difficulty))),
      ) as { aiState: Record<string, unknown>[] };
      raw.aiState[0]!['invasionFloor'] = v;
      const loaded = deserializeWorldState(raw as never);
      expect(loaded.difficulty).toBe(difficulty);
      expect(
        getAIStateForColony(loaded, ENEMY_COLONY_ID)!.invasionFloor,
        `${difficulty} ${v}`,
      ).toBe(want);
    }
  });

  it("recoveryEndTick (the floor's patience clock) loads as an integer no later than a Recovery begun now could end", () => {
    const world = createScenario(7); // tick 0
    const raw = JSON.parse(JSON.stringify(serializeWorldState(world))) as {
      aiState: Record<string, unknown>[];
    };
    const load = (): number =>
      getAIStateForColony(deserializeWorldState(raw as never), ENEMY_COLONY_ID)!.recoveryEndTick;
    const latest = world.tick + Math.max(...AI_RECOVERY_DURATION_TICKS);
    for (const [v, want] of [
      [600, 600],
      [latest, latest],
      [latest + 1, latest],
      [1e12, latest],
      [1.5, 0],
      [-5, 0],
      ['9', 0],
    ] as const) {
      raw.aiState[0]!['recoveryEndTick'] = v;
      expect(load(), String(v)).toBe(want);
    }
  });

  it('operationStartFighterCount, which the escalation reads into it, loads as an integer in 0..32', () => {
    const world = createScenario(7);
    const raw = JSON.parse(JSON.stringify(serializeWorldState(world))) as {
      aiState: Record<string, unknown>[];
    };
    const load = (): number =>
      getAIStateForColony(deserializeWorldState(raw as never), ENEMY_COLONY_ID)!
        .operationStartFighterCount;
    for (const [v, want] of [
      [18, 18],
      [0, 0],
      [17.5, 0],
      ['18', 0],
      [-3, 0],
      [40, 32],
    ] as const) {
      raw.aiState[0]!['operationStartFighterCount'] = v;
      expect(load(), String(v)).toBe(want);
    }
  });

  it('copyWorldState copies it (into a fresh and into a reused record)', () => {
    const world = createScenario(7);
    getAIStateForColony(world, ENEMY_COLONY_ID)!.invasionFloor = 24;
    const dst = createScenario(8);
    dst.aiState.length = 0;
    copyWorldState(world, dst);
    expect(getAIStateForColony(dst, ENEMY_COLONY_ID)!.invasionFloor).toBe(24);
    getAIStateForColony(world, ENEMY_COLONY_ID)!.invasionFloor = 30;
    copyWorldState(world, dst);
    expect(getAIStateForColony(dst, ENEMY_COLONY_ID)!.invasionFloor).toBe(30);
  });
});
