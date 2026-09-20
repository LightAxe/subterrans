// input-log-replay.integration.test.ts — issue #296 regression.
//
// The bug: a replay that regroups a recorded inputLog by `issuedAtTick` applies
// every SIM-emitted command one tick early, because the sim pushes those from
// inside tick T and the platform loop only drains them at the start of tick T+1.
// `scripts/analyze-snapshot.ts` did exactly that, so its SCEN-06 byte-compare
// forked from the live session at the first Probing→WarFooting transition.
//
// This test drives an AI probe, records the drain batches the way the platform
// loop does, and replays the same log four ways: grouped by the recorded
// drainTick, grouped by issuedAtTick (the pre-#296 behaviour), grouped by the
// derived fallback used for logs that predate drainTick, and with no provenance
// at all (pre-#230 logs, which genuinely cannot be rescued). The first and third
// must reproduce the live run's per-tick hashWorldState exactly; the second and
// fourth must not. Mutation-checked — reverting indexByDrainTick to the
// issuedAtTick grouping fails three of the six assertions below.
//
// Why a forced probe instead of a real long match: the earliest sim self-emit in
// an unattended AI-vs-passive match lands around tick 13,500 (measured across
// seeds by scripts/measure-playtrace-size.ts), which is far too slow for the
// unit suite. The transition exercised here is the same one — the enemy colony
// is put into Probing through the ordinary SyncAIState command path, its empty
// cohort makes advanceAIState take the documented "zero-cohort → allDead"
// branch, and that branch emits ClearRallyPoint at tick step 18b — it is just
// reached in a handful of ticks instead of thousands.

import { describe, it, expect, beforeAll } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { pushCommand, stampDrainTick, type SimCommand } from '../sim/commands.js';
import { AntTask } from '../sim/enums.js';
import { ENEMY_COLONY_ID } from '../sim/constants.js';
import { hashWorldState } from './world-hash.js';
import { indexByDrainTick } from './input-log-replay.js';
import type { WorldState } from '../sim/types.js';

/** The pre-#296 grouping: every command applied at its `issuedAtTick`. Lives
 *  here, not in the production module, because nothing but this test may ever
 *  use it — it is the bug, kept only so the assertions below can show it. */
function indexByIssuedAtTick(log: readonly SimCommand[]): SimCommand[][] {
  const byTick: SimCommand[][] = [];
  for (const cmd of log) (byTick[cmd.issuedAtTick] ??= []).push(cmd);
  return byTick;
}

const SEED = 7;
const TICKS = 40;
/** The tick the probe is started on — late enough that the colony has settled,
 *  early enough that the whole run stays cheap. */
const PROBE_START_TICK = 4;
const RALLY_TILE_X = 40;
const RALLY_TILE_Y = 10;

/**
 * Shared starting state for the live run and both replays — they must begin
 * byte-identically or the comparison proves nothing. Promotes one AI ant to
 * Fighting so the rally point actually steers something: without a fighter the
 * one-tick-early clear only changes `colony.rallyPoint` for a single tick and
 * the two runs re-converge, which would hide the divergence from a
 * final-state-only comparison.
 */
function makeScenario(): WorldState {
  const world = createScenario(SEED, 'Normal');
  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (world.ants.alive[id] !== 1) continue;
    if (world.ants.colonyId[id] !== ENEMY_COLONY_ID) continue;
    if (id === enemy.queenEntityId) continue;
    world.ants.task[id] = AntTask.Fighting;
    world.ants.subTask[id] = 0;
    break;
  }
  return world;
}

/**
 * Stand-in for the render AI controller: pushes the two 'ai'-origin commands
 * that put the enemy colony into Probing with a rally point. Runs in the slot
 * the platform loop calls onBeforeTick — i.e. BEFORE the drain — so both are
 * drained on the tick they are stamped with, which is exactly what makes them
 * differ from the sim's own self-emit.
 *
 * SyncAIState (rather than StartAIOperation) because the probe is launched with
 * an EMPTY cohort: `_checkProbingToWarFooting` calls that the "zero-cohort case
 * → allDead=true, recovers immediately" and ends the probe on the very next
 * tick, which is what keeps this test at tens of ticks instead of the 600-tick
 * probe timeout. SyncAIState is the command runAIController already pushes
 * every tick to mirror its state into the sim, so this is the real path.
 */
function driveAI(world: WorldState): void {
  if (world.tick !== PROBE_START_TICK) return;
  pushCommand(
    world,
    {
      type: 'SetRallyPoint',
      colonyId: ENEMY_COLONY_ID,
      tileX: RALLY_TILE_X,
      tileY: RALLY_TILE_Y,
      issuedAtTick: world.tick,
    },
    'ai',
  );
  pushCommand(
    world,
    {
      type: 'SyncAIState',
      colonyId: ENEMY_COLONY_ID,
      state: 'Probing',
      enteredTick: world.tick,
      probeCount: 0,
      lastProbeEndTick: 0,
      invasionStartTick: 0,
      invasionRallyTileX: RALLY_TILE_X,
      invasionRallyTileY: RALLY_TILE_Y,
      recoveryEndTick: 0,
      operationKind: 'Probe',
      operationStartTick: world.tick,
      operationTargetTileX: RALLY_TILE_X,
      operationTargetTileY: RALLY_TILE_Y,
      operationFighterIds: [],
      operationFighterCount: 0,
      operationStartFighterCount: 0,
      operationAttackerDeaths: 0,
      operationDefenderDeaths: 0,
      issuedAtTick: world.tick,
    },
    'ai',
  );
}

interface LiveRun {
  /** hashWorldState after each tick, index = tick number. */
  hashes: string[];
  /** Deep copies of every drained command, in drain order — i.e. exactly what
   *  appendInputLog would have accumulated. */
  inputLog: SimCommand[];
}

function runLive(): LiveRun {
  const world = makeScenario();
  const hashes: string[] = [];
  const inputLog: SimCommand[] = [];
  for (let t = 0; t < TICKS; t++) {
    driveAI(world); // onBeforeTick slot
    const cmds = world.commandQueue.splice(0);
    stampDrainTick(cmds, world.tick); // what createGameLoop does
    for (const c of cmds) inputLog.push(structuredClone(c));
    tick(world, cmds);
    hashes.push(hashWorldState(world));
  }
  return { hashes, inputLog };
}

/** Replay the recorded log with the given grouping, discarding the self-emits
 *  the replaying world regenerates (they are already in the recorded batches). */
function replay(byTick: SimCommand[][]): string[] {
  const world = makeScenario();
  const hashes: string[] = [];
  for (let t = 0; t < TICKS; t++) {
    world.commandQueue.splice(0);
    tick(world, byTick[t] ?? []);
    hashes.push(hashWorldState(world));
  }
  return hashes;
}

describe('inputLog replay — drain batches vs issuedAtTick (#296)', () => {
  // Every run replays the whole scenario and hashes every tick, so do ALL of
  // them once in beforeAll and leave each `it` as a pure comparison. Keeping the
  // work out of the test bodies means only one generous timeout is needed —
  // sized for the v8-instrumented `test:coverage` run (which multiplies this
  // several-fold over the un-instrumented ~2s; AGENTS.md §"80% coverage gate")
  // and for a loaded dev machine.
  let live: LiveRun;
  let byDrainBatch: string[];
  let byIssuedAt: string[];
  let byDerivedFallback: string[];
  let byPreProvenance: string[];
  beforeAll(() => {
    live = runLive();
    byDrainBatch = replay(indexByDrainTick(live.inputLog));
    byIssuedAt = replay(indexByIssuedAtTick(live.inputLog));
    // A snapshot captured before `drainTick` existed still carries `origin`
    // (#230), so the derived rule has to recover exactly the same batches.
    // Strip drainTick to simulate such a log.
    const legacy = live.inputLog.map((c) => {
      const { drainTick: _d, ...rest } = c;
      return rest as SimCommand;
    });
    byDerivedFallback = replay(indexByDrainTick(legacy));
    // And a pre-#230 log: no drainTick AND no origin, so there is nothing left
    // to derive from. This one is EXPECTED to diverge — see the test below.
    const preProvenance = live.inputLog.map((c) => {
      const { drainTick: _d, origin: _o, ...rest } = c;
      return rest as SimCommand;
    });
    byPreProvenance = replay(indexByDrainTick(preProvenance));
  }, 120_000);

  it('the scenario actually contains a sim self-emit drained a tick after it was issued', () => {
    // Guards against the test silently going vacuous: if the AI state machine
    // stops emitting ClearRallyPoint here, both groupings would agree and the
    // regression assertions below would pass for the wrong reason.
    const selfEmits = live.inputLog.filter((c) => c.origin === 'sim');
    expect(selfEmits.length).toBeGreaterThan(0);
    for (const c of selfEmits) {
      expect(c.drainTick).toBe(c.issuedAtTick + 1);
    }
    expect(selfEmits.some((c) => c.type === 'ClearRallyPoint')).toBe(true);
  });

  it('replaying by drain batch reproduces the live run tick for tick', () => {
    expect(byDrainBatch).toEqual(live.hashes);
  });

  it('replaying by drain batch reproduces the live final world hash', () => {
    expect(byDrainBatch[byDrainBatch.length - 1]).toBe(live.hashes[live.hashes.length - 1]);
  });

  it('replaying by issuedAtTick diverges — the pre-#296 analyzer behaviour', () => {
    // Divergence starts on the tick the self-emit was issued: the old grouping
    // applies ClearRallyPoint at step 1 of that tick, before advanceAIState has
    // even decided to emit it, so the rally point is already gone while the live
    // run still had it.
    const firstDivergence = byIssuedAt.findIndex((h, i) => h !== live.hashes[i]);
    expect(firstDivergence).toBe(PROBE_START_TICK);
    // And it does not heal: the fighter took a different step on that tick, so
    // every later tick differs too. This is the assertion that fails if
    // indexByDrainTick is reverted to the issuedAtTick grouping.
    expect(byIssuedAt[byIssuedAt.length - 1]).not.toBe(live.hashes[live.hashes.length - 1]);
  });

  it('falls back correctly when drainTick is absent (pre-#296 recorded log)', () => {
    expect(byDerivedFallback).toEqual(live.hashes);
  });

  it('still diverges on a pre-#230 log with no provenance at all', () => {
    // Documented limitation, not an oversight: with neither `drainTick` nor
    // `origin` there is no way to tell a sim-emitted ClearRallyPoint from a
    // player-issued one, and guessing by command type would mis-place the
    // player's. Such a log is left exactly where it was — which means it still
    // fails the byte-compare, same as before #296. Pinned so the fallback's
    // reach is never overstated.
    expect(byPreProvenance).not.toEqual(live.hashes);
    expect(byPreProvenance).toEqual(byIssuedAt);
  });
});
