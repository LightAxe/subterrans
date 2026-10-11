// ai-raid-type-replay.test.ts — #366 (V77): an AI invasion committed with a non-Loot
// raid type replays and saves deterministically.
//
// AGENTS.md's replay-coverage rule for a command / save-format change. The AI replay
// parity test (render/ai-controller-replay-parity.integration.test.ts) stops at the
// first invasion, which is always Loot. Here the AI colony of the raid world starts in
// Invading with an invasion floor (a repelled wave already), with an army and an
// opponent sized so that the rule picks a Blockade (or an Assault); the real
// controller commits the cohort, and:
//   (a) the recorded command log, replayed through tick() alone, reproduces the
//       world byte for byte (the sim applies StartAIOperation.raidType itself);
//   (b) a save taken mid-wave and loaded carries on identically to the original, and
//       its next wave's choice reads the saved lastRaidType.

import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import { stampDrainTick, type SimCommand } from '../sim/commands.js';
import { RaidType } from '../sim/enums.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { createDefaultAIStateRecord } from '../sim/ai-state.js';
import type { WorldState } from '../sim/types.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';
import { aiInvasionRaidType, runAIController } from '../render/ai-controller.js';
import { indexByDrainTick } from './input-log-replay.js';
import { hashWorldState } from './world-hash.js';
import { serializeWorldState, deserializeWorldState } from './save.js';

const AI = ENEMY_COLONY_ID;
const TICKS = 100;
const SPLIT = 30;
const CHECK_EVERY = 25;
/** Hashing a world is slow: checkpoints, not every tick. */
const SLOW_MS = 120_000;

/** A raid world whose AI colony is Invading with a floor of 21, `army` AI fighters
 *  and `foes` player fighters in their nests. */
function scenario(army: number, foes: number): WorldState {
  const r = raidWorld();
  const w = r.world;
  const rec = createDefaultAIStateRecord(AI);
  rec.state = 'Invading';
  rec.invasionStartTick = w.tick;
  rec.invasionFloor = 21; // a repelled wave already: not the first
  w.aiState.push(rec);
  for (let i = 0; i < army; i++) addFighter(w, AI, r.enemyDoor.x, 6, AI);
  for (let i = 0; i < foes; i++)
    addFighter(w, PLAYER_COLONY_ID, r.playerDoor.x, 6, PLAYER_COLONY_ID);
  return w;
}

const aiRec = (w: WorldState) => w.aiState.find((r) => r.colonyId === AI)!;

/** One live tick as createGameLoop runs it; the drained batch is appended to `log`. */
function liveTick(w: WorldState, log: SimCommand[]): void {
  runAIController(w, AI);
  const cmds = w.commandQueue.splice(0);
  stampDrainTick(cmds, w.tick);
  for (const c of cmds) log.push(structuredClone(c));
  tick(w, cmds);
}

const CASES: readonly { name: string; army: number; foes: number; type: RaidType }[] = [
  { name: 'Blockade', army: 22, foes: 40, type: RaidType.Blockade },
  { name: 'Assault', army: 30, foes: 5, type: RaidType.Assault },
];

describe.each(CASES)('#366 AI $name commit', ({ army, foes, type }) => {
  it('the rule picks the type this scenario is built for', () => {
    expect(aiInvasionRaidType(scenario(army, foes), aiRec(scenario(army, foes)))).toBe(type);
  });

  it(
    'replays through tick() alone to the same world',
    () => {
      const live = scenario(army, foes);
      const log: SimCommand[] = [];
      const liveHashes: (string | undefined)[] = [];
      for (let t = 0; t < TICKS; t++) {
        liveTick(live, log);
        if ((t + 1) % CHECK_EVERY === 0) liveHashes[t] = hashWorldState(live);
      }
      // Non-vacuous: the commit carried the type, and the sim recorded it.
      const start = log.find((c) => c.type === 'StartAIOperation');
      expect(start).toEqual(expect.objectContaining({ kind: 'Invasion', raidType: type }));
      expect(aiRec(live).lastRaidType).toBe(type);
      expect(live.colonies[AI]!.raidType).toBe(type);
      expect(live.colonies[AI]!.rallyPoint).not.toBeNull();

      const replay = scenario(army, foes);
      const byTick = indexByDrainTick(log);
      for (let t = 0; t < TICKS; t++) {
        replay.commandQueue.splice(0); // the recorded batches hold the self-emits
        tick(replay, byTick[replay.tick] ?? []);
        if (liveHashes[t] !== undefined)
          expect(hashWorldState(replay), `tick ${t}`).toBe(liveHashes[t]);
      }
      expect(aiRec(replay).lastRaidType).toBe(type);
      expect(replay.colonies[AI]!.raidType).toBe(type);
      expect(replay.colonies[AI]!.rallyPoint).toEqual(live.colonies[AI]!.rallyPoint);
    },
    SLOW_MS,
  );

  it(
    'a save taken mid-wave carries on identically, and the next wave reads lastRaidType',
    () => {
      const live = scenario(army, foes);
      const log: SimCommand[] = [];
      for (let t = 0; t < SPLIT; t++) liveTick(live, log);
      expect(aiRec(live).operationKind).toBe('Invasion');
      expect(aiRec(live).lastRaidType).toBe(type);

      const loaded = deserializeWorldState(serializeWorldState(live));
      expect(aiRec(loaded).lastRaidType).toBe(type);
      expect(loaded.colonies[AI]!.raidType).toBe(type);
      expect(hashWorldState(loaded)).toBe(hashWorldState(live));

      for (let t = SPLIT; t < TICKS; t++) {
        liveTick(live, log);
        liveTick(loaded, []);
      }
      expect(hashWorldState(loaded)).toBe(hashWorldState(live));
      expect(aiRec(loaded).lastRaidType).toBe(aiRec(live).lastRaidType);
      expect(loaded.colonies[AI]!.raidType).toBe(live.colonies[AI]!.raidType);

      // The next wave's choice reads the saved lastRaidType: a Blockade is never followed
      // by a Blockade, whereas the same situation after a Loot raid is one again.
      if (type === RaidType.Blockade) {
        const next = deserializeWorldState(serializeWorldState(live));
        const rec = aiRec(next);
        expect(aiInvasionRaidType(next, rec)).toBe(RaidType.Loot);
        rec.lastRaidType = RaidType.Loot;
        expect(aiInvasionRaidType(next, rec)).toBe(RaidType.Blockade);
      }
    },
    SLOW_MS,
  );
});
