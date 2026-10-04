// src/render/ai-invasion-escalation.integration.test.ts
// #398 (V72) — the AI escalates after a repelled invasion, end to end with the real
// controller, under replay and save/load.
//
// A live run drives the real controller the way createGameLoop does (runAIController
// in the onBeforeTick slot, splice drain, stampDrainTick, record, tick). The player
// orders the standard opening at tick 0. The enemy AI launches its first invasion; at
// that moment a strong player defence is put at the player's door and rallied there
// (the player's only other order), so the wave is routed. The run goes on until the AI's second
// invasion. Two Hard maps: on one the AI grows to its floor before the floor's
// patience runs out; on the other patience runs out first. It is asserted that:
//   - wave 1 ended in a fighter rout and raised the invasion floor to
//     min(cap, n1 + step);
//   - the floor really held the launch: on some tick in WarFooting before the floor's
//     patience ran out the colony had the base need of fighters and the food, and the
//     V71 gate would have launched, but it did not;
//   - the gate then fired (WarFooting → Invading) with at least the floor's
//     fighters before patience ran out (the first map), or, with fewer, once
//     patience had run out (the second).
// Then:
//   - the recorded drain batches are replayed into a fresh world through tick()
//     alone, and the serialized world is byte-compared at every checkpoint;
//   - a save taken mid-muster (at the first such held tick), and a copyWorldState
//     clone taken at the same tick, are each run on with the live controller and
//     must launch wave 2 on the same tick with the same size, emit the same commands
//     and end identical to the uninterrupted run.
// Location: src/render/ because it drives the render-layer controller.

import { describe, it, expect } from 'vitest';

import { runAIController } from './ai-controller.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { GameOutcome } from '../sim/game-over.js';
import { pushCommand, stampDrainTick, type SimCommand } from '../sim/commands.js';
import {
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  AI_INVADING_FIGHTER_THRESHOLD,
  AI_INVADING_FOOD_FRAC_PCT,
  AI_INVADING_MIN_TICK,
  AI_INVASION_FLOOR_MAX,
  AI_INVASION_FLOOR_STEP,
  AI_INVASION_FLOOR_PATIENCE_TICKS,
} from '../sim/constants.js';
import { aiFighterCount, getAIStateForColony, tierIndex } from '../sim/ai-state.js';
import { colonyFoodCapacity, colonyFoodTotal } from '../sim/food/food-api.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { allocateEntityId, copyWorldState, LATEST_SIM_VERSION } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { serializeWorldState, deserializeWorldState } from '../platform/save.js';
import { indexByDrainTick } from '../platform/input-log-replay.js';

const DIFFICULTY = 'Hard';
/** Hard maps scanned for this test: wave 1 is routed, and wave 2 comes once the AI has
 *  its floor (seed 3, ~2 900 ticks after wave 1) or after patience runs out (seed 20). */
const CASES = [
  { seed: 3, branch: 'floor' },
  { seed: 20, branch: 'patience' },
] as const;
/** Player fighters put at the door at wave 1's launch: enough to rout it. */
const DEFENDERS = 40;
/** Tick budget to the first invasion. */
const WAVE1_BUDGET = 20_000;
/** Tick budget from wave 1's launch to wave 2's. Patience bounds it: the timeout
 *  (1 800) + Recovery (1 200) + AI_INVASION_FLOOR_PATIENCE_TICKS, plus slack for the
 *  food gate. */
const WAVE2_BUDGET = 12_000;
/** Ticks run after wave 2's launch. */
const TAIL_TICKS = 40;
/** Generous for `npm run test:coverage`. */
const TIMEOUT_MS = 300_000;
const CHECKPOINT_INTERVAL = 1000;

const snapshot = (world: WorldState): string => JSON.stringify(serializeWorldState(world));
const load = (json: string): WorldState => deserializeWorldState(JSON.parse(json));

/** One live controller tick; returns the drained batch (as appendInputLog keeps it). */
function liveTick(world: WorldState): SimCommand[] {
  runAIController(world, ENEMY_COLONY_ID);
  const cmds = world.commandQueue.splice(0);
  stampDrainTick(cmds, world.tick);
  const kept = cmds.map((c) => structuredClone(c));
  // The real loop stops at a match end; a scenario that drifts into one is caught here.
  expect(tick(world, cmds), `match ended @${world.tick}`).toBe(GameOutcome.None);
  return kept;
}

/** The enemy's events of `type` emitted on the tick just run (newest first). */
function justEmitted(world: WorldState, type: SimEvent['type']): SimEvent[] {
  const out: SimEvent[] = [];
  const t = world.tick - 1;
  for (let i = world.events.length - 1; i >= 0; i--) {
    const ev = world.events[i]!;
    if (ev.tick < t) break;
    const p = ev.payload as { colonyId?: number };
    if (ev.type === type && p.colonyId === ENEMY_COLONY_ID) out.push(ev);
  }
  return out;
}

/** The fighter count of an enemy invasion launched on the tick just run, else -1. */
function launchedThisTick(world: WorldState): number {
  const ev = justEmitted(world, 'invasion_start')[0];
  return ev === undefined ? -1 : (ev.payload as { fighterCount: number }).fighterCount;
}

/** A player command, issued now. */
function order(world: WorldState, c: Record<string, unknown>): void {
  pushCommand(
    world,
    { ...c, colonyId: PLAYER_COLONY_ID, issuedAtTick: world.tick } as unknown as SimCommand,
    'player',
  );
}

/** The standard opening (Queen, Nursery, FoodStorage), so the player's queen has a nest. */
function orderStandardOpening(world: WorldState): void {
  for (let y = 2; y <= 8; y++) order(world, { type: 'MarkDigTile', tileX: 24, tileY: y });
  order(world, {
    type: 'PlaceChamber',
    chamberType: ChamberType.Queen,
    anchorTileX: 22,
    anchorTileY: 9,
  });
  for (let x = 25; x <= 30; x++) order(world, { type: 'MarkDigTile', tileX: x, tileY: 5 });
  order(world, {
    type: 'PlaceChamber',
    chamberType: ChamberType.Nursery,
    anchorTileX: 31,
    anchorTileY: 4,
  });
  for (let x = 21; x <= 23; x++) order(world, { type: 'MarkDigTile', tileX: x, tileY: 5 });
  order(world, {
    type: 'PlaceChamber',
    chamberType: ChamberType.FoodStorage,
    anchorTileX: 17,
    anchorTileY: 4,
  });
}

/** The world at wave 1's launch, with the defence at the player's door and rallied
 *  there (the rally is queued, so the recorded run drains it on its first tick). */
function startWorld(seed: number): { start: string; n1: number } {
  const world = createScenario(seed, DIFFICULTY);
  expect(world.simVersion).toBe(LATEST_SIM_VERSION);
  orderStandardOpening(world);
  let n1 = -1;
  while (n1 < 0) {
    expect(world.tick, 'wave 1 drifted past WAVE1_BUDGET').toBeLessThan(WAVE1_BUDGET);
    liveTick(world);
    n1 = launchedThisTick(world);
  }
  expect(getAIStateForColony(world, ENEMY_COLONY_ID)!.invasionFloor).toBe(0);
  const door = world.colonies[PLAYER_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
  for (let k = 0; k < DEFENDERS; k++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: (door.surfaceTileX + (k % 5) - 2) << FP_SHIFT,
      posY: (door.surfaceTileY - 1 - (Math.trunc(k / 5) % 3)) << FP_SHIFT,
      task: AntTask.Fighting,
      subTask: 0,
      lastMealTick: world.tick - 1, // just fed: a valid hunger clock in the snapshot
    });
    world.colonies[PLAYER_COLONY_ID]!.workers.push(id);
  }
  order(world, { type: 'SetRallyPoint', tileX: door.surfaceTileX, tileY: door.surfaceTileY });
  return { start: snapshot(world), n1 };
}

describe('#398 (V72) — the AI escalates after a repelled invasion', () => {
  it.each(CASES)(
    'seed $seed ($branch): wave 1 routs and raises the floor; the floor holds the next launch; replay, a mid-muster save and a copy all match',
    ({ seed, branch }) => {
      const { start, n1 } = startWorld(seed);
      const tier = tierIndex(DIFFICULTY);
      const base = AI_INVADING_FIGHTER_THRESHOLD[tier];

      // Live run: from wave 1's launch to wave 2's, plus a tail.
      const live = load(start);
      const t0 = live.tick;
      const log: SimCommand[] = [];
      const checkpoints = new Map<number, string>();
      let end1Outcome = '';
      let floor = -1;
      // The first WarFooting → Invading transition after wave 1 (the gate firing): its
      // tick, the fighters the gate counted, and the patience clock it read.
      let gateTick = -1;
      let gateFighters = -1;
      let gateRecoveryEnd = -1;
      let heldTicks = 0;
      let saveTick = -1;
      let midSave = '';
      const midCopy = createScenario(seed, DIFFICULTY);
      let wave2Tick = -1;
      let n2 = -1;
      while (wave2Tick < 0 || live.tick < wave2Tick + 1 + TAIL_TICKS) {
        expect(live.tick - t0, 'wave 2 drifted past WAVE2_BUDGET').toBeLessThan(WAVE2_BUDGET);
        const wasWarFooting = getAIStateForColony(live, ENEMY_COLONY_ID)!.state === 'WarFooting';
        log.push(...liveTick(live));
        // A held tick: the colony was in WarFooting through the tick's state step and
        // had, there, what the V71 gate needed (base fighters, food, minimum tick),
        // yet did not launch, before the floor's patience ran out.
        const rec = getAIStateForColony(live, ENEMY_COLONY_ID)!;
        const colony = live.colonies[ENEMY_COLONY_ID]!;
        const ran = live.tick - 1;
        const held =
          floor > base &&
          gateTick < 0 &&
          wasWarFooting &&
          rec.state === 'WarFooting' &&
          aiFighterCount(live, ENEMY_COLONY_ID) >= base &&
          colonyFoodTotal(live, colony) * 100 >=
            colonyFoodCapacity(colony) * AI_INVADING_FOOD_FRAC_PCT &&
          ran >= AI_INVADING_MIN_TICK &&
          ran - rec.recoveryEndTick < AI_INVASION_FLOOR_PATIENCE_TICKS;
        if (held) {
          heldTicks += 1;
          if (saveTick < 0) {
            saveTick = live.tick;
            midSave = snapshot(live);
            copyWorldState(live, midCopy);
          }
        }
        const end = justEmitted(live, 'invasion_end')[0];
        if (end !== undefined && end1Outcome === '') {
          end1Outcome = (end.payload as { outcome: string }).outcome;
          floor = rec.invasionFloor;
        }
        if (end1Outcome !== '' && gateTick < 0) {
          const gate = justEmitted(live, 'ai_state_transition').find((e) => {
            const p = e.payload as { from: string; to: string };
            return p.from === 'WarFooting' && p.to === 'Invading';
          });
          if (gate !== undefined) {
            gateTick = live.tick - 1;
            gateFighters = (gate.payload as { triggerValues: { aiFighterCount: number } })
              .triggerValues.aiFighterCount;
            gateRecoveryEnd = rec.recoveryEndTick;
          }
        }
        const n = launchedThisTick(live);
        if (n >= 0 && wave2Tick < 0) {
          wave2Tick = live.tick - 1;
          n2 = n;
        }
        if (live.tick % CHECKPOINT_INTERVAL === 0) checkpoints.set(live.tick, snapshot(live));
      }
      checkpoints.set(live.tick, snapshot(live));
      const final = snapshot(live);
      const runTicks = live.tick - t0;

      // Non-vacuity: wave 1 was routed and raised the floor; the floor held a launch
      // the V71 gate would have made; wave 2 came with the floor or after patience.
      const drift = `escalation scenario drifted (seed ${seed}; see CASES / DEFENDERS)`;
      expect(end1Outcome, `${drift}: wave 1 routed`).toBe('fighter_rout');
      expect(n1, `${drift}: wave 1 below the cap`).toBeLessThan(AI_INVASION_FLOOR_MAX[tier]);
      expect(floor, 'floor = min(cap, n1 + step)').toBe(
        Math.min(AI_INVASION_FLOOR_MAX[tier], n1 + AI_INVASION_FLOOR_STEP),
      );
      expect(floor, `${drift}: the floor is above the base`).toBeGreaterThan(base);
      expect(
        heldTicks,
        `${drift}: the floor held a launch the base would have made`,
      ).toBeGreaterThan(0);
      expect(gateTick, `${drift}: the gate fired after the held muster`).toBeGreaterThan(saveTick);
      expect(wave2Tick, `${drift}: wave 2 committed`).toBeGreaterThanOrEqual(gateTick);
      // The gate fired with the floor's fighters before patience ran out, or with
      // fewer (but the base's) once it had run out.
      const sinceRecovery = gateTick - gateRecoveryEnd;
      const where = `wave 2's gate @${gateTick} with ${gateFighters} (Recovery ended @${gateRecoveryEnd})`;
      if (branch === 'floor') {
        expect(sinceRecovery, `${drift}: ${where} before patience`).toBeLessThan(
          AI_INVASION_FLOOR_PATIENCE_TICKS,
        );
        expect(gateFighters, where).toBeGreaterThanOrEqual(floor);
      } else {
        expect(sinceRecovery, `${drift}: ${where} once patience ran out`).toBeGreaterThanOrEqual(
          AI_INVASION_FLOOR_PATIENCE_TICKS,
        );
        expect(gateFighters, `${drift}: ${where} short of the floor`).toBeLessThan(floor);
        expect(gateFighters, where).toBeGreaterThanOrEqual(base);
      }
      // The mid-muster save and the copy carry the floor.
      expect(getAIStateForColony(load(midSave), ENEMY_COLONY_ID)!.invasionFloor).toBe(floor);
      expect(getAIStateForColony(midCopy, ENEMY_COLONY_ID)!.invasionFloor).toBe(floor);

      // tick()-only replay of the recorded drain batches into a fresh world.
      const replay = load(start);
      const byTick = indexByDrainTick(log);
      for (let t = 0; t < runTicks; t++) {
        replay.commandQueue.splice(0);
        tick(replay, byTick[replay.tick] ?? []);
        const want = checkpoints.get(replay.tick);
        if (want !== undefined) expect(snapshot(replay), `replay @${replay.tick}`).toBe(want);
      }
      expect(snapshot(replay)).toBe(final);

      // A mid-muster save, and a copy, run on with the live controller: wave 2 on the
      // same tick with the same size, the same commands, and the same end.
      const tail = log.filter((c) => c.drainTick! >= saveTick);
      for (const [name, world] of [
        ['save/load', load(midSave)],
        ['copyWorldState', midCopy],
      ] as const) {
        expect(world.tick, name).toBe(saveTick);
        const rest: SimCommand[] = [];
        let w2 = -1;
        let size = -1;
        while (world.tick < t0 + runTicks) {
          rest.push(...liveTick(world));
          const n = launchedThisTick(world);
          if (n >= 0 && w2 < 0) {
            w2 = world.tick - 1;
            size = n;
          }
          const want = checkpoints.get(world.tick);
          if (want !== undefined) expect(snapshot(world), `${name} @${world.tick}`).toBe(want);
        }
        expect([w2, size], `${name}: wave 2`).toEqual([wave2Tick, n2]);
        expect(JSON.stringify(rest), name).toBe(JSON.stringify(tail));
        expect(snapshot(world), name).toBe(final);
      }
    },
    TIMEOUT_MS,
  );
});
