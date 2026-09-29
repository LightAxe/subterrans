// src/render/ai-raid-clock-replay.integration.test.ts
// #371 (V62) — the AI raid clock (AIStateRecord.raidSinceTick, kept by the sim from
// the controller's SetAIRaidClock commands) under replay and save/load.
//
// A live run drives the real controller the way createGameLoop does
// (runAIController in the onBeforeTick slot, splice drain, stampDrainTick, record,
// tick) through a raid: three enemy fighters are put by the AI's entrance, the AI
// sees the raid and starts its clock, and the raiders walk home and the clock is
// cleared. The run is asserted to have really started and cleared it. Then:
//   - the recorded drain batches are replayed into a fresh world through tick()
//     alone, and the serialized world is byte-compared at every checkpoint;
//   - a save taken mid-raid, and a copyWorldState clone taken at the same tick,
//     are each run on with the live controller and must end identical to the
//     uninterrupted run, having emitted the same commands.
// Location: src/render/ because it drives the render-layer controller.

import { describe, it, expect } from 'vitest';

import { runAIController } from './ai-controller.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { stampDrainTick, type SimCommand } from '../sim/commands.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { getAIStateForColony } from '../sim/ai-state.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { allocateEntityId, copyWorldState, SIM_VERSION_V62_AI_NEST_DEFENCE } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { AntTask } from '../sim/enums.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { serializeWorldState, deserializeWorldState } from '../platform/save.js';
import { indexByDrainTick } from '../platform/input-log-replay.js';

const SEED = 1;
const DIFFICULTY = 'Normal';
/** Ticks run before the raiders are placed, so the clock does not start at 0. */
const WARMUP_TICKS = 50;
/** Ticks run after they are placed: the raid (~90 ticks today: the raiders walk
 *  home) and a tail. If a retune changes the raid, keep it seen on the first tick,
 *  ending once, after SAVE_AFTER and before RUN_TICKS — the non-vacuity asserts
 *  below say which assumption drifted. */
const RUN_TICKS = 300;
/** Ticks into the run at which the mid-raid save and clone are taken. */
const SAVE_AFTER = 40;
/** Generous for `npm run test:coverage` (~1 200 ticks plus ~15 snapshots). */
const TIMEOUT_MS = 120_000;
const CHECKPOINT_INTERVAL = 25;

const snapshot = (world: WorldState): string => JSON.stringify(serializeWorldState(world));
const load = (json: string): WorldState => deserializeWorldState(JSON.parse(json));

/** One live controller tick; returns the drained batch (as appendInputLog keeps it). */
function liveTick(world: WorldState): SimCommand[] {
  runAIController(world, ENEMY_COLONY_ID);
  const cmds = world.commandQueue.splice(0);
  stampDrainTick(cmds, world.tick);
  const kept = cmds.map((c) => structuredClone(c));
  tick(world, cmds);
  return kept;
}

/** The world the recorded run starts from: WARMUP_TICKS in, raiders by the AI's door. */
function startWorld(): string {
  const world = createScenario(SEED, DIFFICULTY);
  expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V62_AI_NEST_DEFENCE);
  for (let t = 0; t < WARMUP_TICKS; t++) liveTick(world);
  const door = world.colonies[ENEMY_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
  for (let k = 0; k < 3; k++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: (door.surfaceTileX + 3 + k) << FP_SHIFT,
      posY: (door.surfaceTileY + 2) << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
    });
    world.colonies[PLAYER_COLONY_ID]!.workers.push(id);
  }
  return snapshot(world);
}

describe('#371 (V62) — the AI raid clock replays and survives save/load', () => {
  it(
    'a live raid starts and clears the clock; tick()-only replay, a mid-raid save and a copy all match',
    () => {
      const start = startWorld();
      const t0 = WARMUP_TICKS;

      // Live run.
      const live = load(start);
      const log: SimCommand[] = [];
      const checkpoints = new Map<number, string>();
      const clockSeen: number[] = [];
      let midSave = '';
      const midCopy = createScenario(SEED, DIFFICULTY);
      for (let t = 0; t < RUN_TICKS; t++) {
        if (t === SAVE_AFTER) {
          midSave = snapshot(live);
          copyWorldState(live, midCopy);
        }
        log.push(...liveTick(live));
        const since = getAIStateForColony(live, ENEMY_COLONY_ID)!.raidSinceTick;
        if (clockSeen.at(-1) !== since) clockSeen.push(since);
        if (live.tick % CHECKPOINT_INTERVAL === 0 || t === RUN_TICKS - 1) {
          checkpoints.set(live.tick, snapshot(live));
        }
      }
      const final = snapshot(live);

      // Non-vacuity: the clock was started at the raid's first tick and cleared after.
      const clocks = log.filter((c) => c.type === 'SetAIRaidClock') as {
        raiding: boolean;
        issuedAtTick: number;
      }[];
      const drift = 'raid scenario drifted (see RUN_TICKS)';
      expect(
        clocks.map((c) => c.raiding),
        `${drift}: one raid, started then cleared`,
      ).toEqual([true, false]);
      expect(clocks[0]!.issuedAtTick, `${drift}: raid seen on the first tick`).toBe(t0);
      expect(clockSeen, `${drift}: the sim's clock`).toEqual([t0, -1]);
      expect(clocks[1]!.issuedAtTick, `${drift}: raid still on at the save`).toBeGreaterThan(
        t0 + SAVE_AFTER,
      );
      // The mid-raid save and the copy carry the running clock's value.
      expect(getAIStateForColony(load(midSave), ENEMY_COLONY_ID)!.raidSinceTick).toBe(t0);
      expect(getAIStateForColony(midCopy, ENEMY_COLONY_ID)!.raidSinceTick).toBe(t0);

      // tick()-only replay of the recorded drain batches into a fresh world.
      const replay = load(start);
      const byTick = indexByDrainTick(log);
      for (let t = 0; t < RUN_TICKS; t++) {
        replay.commandQueue.splice(0);
        tick(replay, byTick[replay.tick] ?? []);
        const want = checkpoints.get(replay.tick);
        if (want !== undefined) expect(snapshot(replay), `replay @${replay.tick}`).toBe(want);
      }
      expect(snapshot(replay)).toBe(final);

      // A mid-raid save, and a copy, run on with the live controller: the same end,
      // and the same commands as the uninterrupted run from that tick on.
      const tail = log.filter((c) => c.drainTick! >= t0 + SAVE_AFTER);
      for (const [name, world] of [
        ['save/load', load(midSave)],
        ['copyWorldState', midCopy],
      ] as const) {
        const rest: SimCommand[] = [];
        for (let t = SAVE_AFTER; t < RUN_TICKS; t++) {
          rest.push(...liveTick(world));
          const want = checkpoints.get(world.tick);
          if (want !== undefined) expect(snapshot(world), `${name} @${world.tick}`).toBe(want);
        }
        expect(JSON.stringify(rest), name).toBe(JSON.stringify(tail));
        expect(snapshot(world), name).toBe(final);
      }
    },
    TIMEOUT_MS,
  );
});
