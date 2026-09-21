// src/render/ai-controller-replay-parity.integration.test.ts
// Issue #258 — live loop vs tick()-only replay parity across a full AI operation.
//
// The question: does the sim on its own — `advanceAIState` at tick step 18b, the
// `StartAIOperation` handler, and the combat death-counter increments — reproduce
// `world.aiState` bit-identically under a replay that calls `tick()` alone? Until
// #258 the render controller also pushed a `SyncAIState` echo of the whole record
// whenever a field changed, precisely so the snapshot analyzer's tick()-only
// replay would match. #230 argued the echo was redundant but could not prove it:
// the only AI harness then available (a passive-observer player) never left
// Peacetime, so a stripped-echo replay matched vacuously. This test was the
// acceptance gate for retiring it — it first ran GREEN with the echo emitted and
// stripped from the replayed log, then the emission was deleted — and it stays as
// the permanent live-vs-replay regression test for the AI operation path.
//
// How: run the real matchup the way `createGameLoop` runs it —
// `runAIController(world, ENEMY_COLONY_ID)` in the onBeforeTick slot,
// `commandQueue.splice(0)` as the drain, `stampDrainTick` on the batch, record
// it, `tick()`, and STOP at the first non-None GameOutcome, because the real
// loop pauses there (game-loop.ts `onTickOutcome`) and a recorded inputLog ends
// there; nothing simulated past that tick exists in any real log. The player is
// passive. The run used is the first seed in CANDIDATE_SEEDS whose run
// QUALIFIES: the enemy enters Invading and commits a cohort, at least one
// operation death counter becomes nonzero while Invading, and the run ends —
// by Recovery or by game over — within MAX_TICKS. That run's log is then
// replayed into a fresh `createScenario` world through `tick()` only and
// `serializeWorldState` is byte-compared at every checkpoint.
//
// Non-vacuity is asserted FIRST, and it is why the seed is scanned rather than
// pinned. A seed's timeline is a property of the current sim, so a balance
// retune moves it, and if the enemy stopped reaching Invading the parity
// assertions would pass for the wrong reason (the operation fields would never
// be touched). A candidate that can no longer qualify is dropped the moment that
// is known — its invasion ended with no deaths, the game ended, or the budget
// ran out — so the scan stays bounded; today the first candidate qualifies, so
// the cost is one live run. Only when NO candidate qualifies does the suite
// fail, listing what every seed did and how its run ended.
//
// Qualification wants a death on at least one side, not both. Against a passive
// player the cohort reaches the queen before losing anyone — no candidate
// records an attacker death inside the real window — and both counters are
// written by the same block in killAnt (src/sim/combat.ts): the fact the replay
// has to reproduce is that combat wrote to aiState while an operation was
// running, and either counter shows it.
//
// Documented limitation: against a passive player the invasion ends the game
// (the cohort kills the queen) before the invasion itself ends, so the
// Invading → Recovery exit — `_checkInvadingToRecovery`, `_endInvasion` and its
// invasion-end ClearRallyPoint self-emit — is NOT exercised here. The probe-end
// self-emit, the same drain-lag shape (#296), is exercised whenever the chosen
// run probed, which every qualifying candidate does today. Covering Recovery
// needs a player that survives the invasion (a scripted defender) — a follow-up.
//
// Re-pick procedure, for when the loud failure fires after a sim change: run
// `npm run check:ai-economy -- --difficulty=Hard` and take seeds from its
// `invading` column, earliest invaders first (that harness does not stop at game
// over, so an `invading` tick later than the seed's player-queen death is not a
// real-window invasion). The failure message says how far each current
// candidate got and how its run ended; a new seed is trialled by putting it at
// the head of the list. Raise MAX_TICKS only if every candidate invades too late
// to end the run inside it.
//
// Checkpoints are taken every CHECKPOINT_INTERVAL ticks, on every AI state
// transition, and on the run's final tick, so a divergence is localised to the
// transition that caused it and the failure names the first differing
// serialized field.
//
// Location: src/render/ because the test drives the render-layer controller;
// a src/sim test may not import from src/render (eslint simSafetyConfig).

import { describe, it, expect, beforeAll } from 'vitest';

import { runAIController } from './ai-controller.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { GameOutcome } from '../sim/game-over.js';
import { stampDrainTick, type SimCommand } from '../sim/commands.js';
import { ENEMY_COLONY_ID } from '../sim/constants.js';
import { getAIStateForColony } from '../sim/ai-state.js';
import type { AIState, WorldState } from '../sim/types.js';
import { serializeWorldState } from '../platform/save.js';
import { indexByDrainTick } from '../platform/input-log-replay.js';

// -----------------------------------------------------------------------------
// Scenario constants
// -----------------------------------------------------------------------------

/** Tried in order; the first run that qualifies is the parity subject. Measured
 *  on main at V39, Hard, passive player, runs stopped at game over:
 *  - 23 (first): WarFooting 12471, Probing 12472 (3-fighter probe, ends 13072
 *    with the ClearRallyPoint self-emit), Invading 13073, 15-fighter cohort at
 *    13074, and at 13171 the cohort kills the passive player's queen — one
 *    defender death, Defeat, the run ends. 11 checkpoints.
 *  - 10, 14, 16, 20, 25, 28 also qualify today: each invades before its game
 *    ends and the cohort kills at least one defender (often the queen itself).
 *  - 18 and 27 do not qualify today (18's game is over at 9644 before it
 *    invades; 27 invades at 11995 but its game ends at 12972 with no deaths);
 *    they are kept as fallbacks for a retune.
 *  No candidate loses a cohort fighter before its game ends. */
const CANDIDATE_SEEDS = [23, 10, 14, 16, 18, 20, 25, 27, 28] as const;
const DIFFICULTY = 'Hard';
/** Per-candidate tick budget. Today every candidate's run ends (game over) by
 *  ~13.3k; the headroom is for a retune that lets the passive player live
 *  longer. An invasion lasts at most AI_INVADING_TIMEOUT_TICKS (1800), so a seed
 *  that invades by ~18k still ends its run inside the budget either way. */
const MAX_TICKS = 20_000;
/** Ticks to keep running after Invading → Recovery (reachable only with a player
 *  that survives the invasion), so the ClearRallyPoint the sim self-emits at
 *  invasion end is drained (a tick later) and applied inside the compared
 *  window. */
const POST_RECOVERY_TICKS = 100;
const CHECKPOINT_INTERVAL = 2_000;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface Checkpoint {
  tick: number;
  /** JSON.stringify(serializeWorldState(world)) after the tick numbered `tick`. */
  json: string;
}

interface LiveRun {
  seed: number;
  /** world.tick when the live loop stopped; the replay runs to the same tick. */
  finalTick: number;
  /** Deep copies of every drained command in drain order — exactly what
   *  appendInputLog would have accumulated. */
  inputLog: SimCommand[];
  checkpoints: Checkpoint[];
  /** "tick:from->to" for every enemy AI state change, in order. */
  transitions: string[];
  statesVisited: Set<AIState>;
  invadingTick: number | null;
  recoveryTick: number | null;
  /** The tick tick() first returned a non-None outcome — where the real loop
   *  stops and the recorded log ends — and that outcome. */
  gameOverTick: number | null;
  outcome: GameOutcome;
  /** Largest committed cohort seen while Invading. */
  peakCohort: number;
  /** Largest death counters seen while Invading — they are zeroed on the
   *  Invading → Recovery transition, so the end state alone cannot show them. */
  peakAttackerDeaths: number;
  peakDefenderDeaths: number;
  /** How the run ended, for messages. */
  endedBy: string;
  /** Why this run cannot be the parity subject; null when it qualifies. */
  rejectedBecause: string | null;
}

function snapshot(world: WorldState): string {
  return JSON.stringify(serializeWorldState(world));
}

function outcomeName(o: GameOutcome): string {
  for (const k of Object.keys(GameOutcome) as (keyof typeof GameOutcome)[]) {
    if (GameOutcome[k] === o) return k;
  }
  return String(o);
}

function runLive(seed: number): LiveRun {
  const world = createScenario(seed, DIFFICULTY);
  const inputLog: SimCommand[] = [];
  const checkpoints: Checkpoint[] = [];
  const transitions: string[] = [];
  const statesVisited = new Set<AIState>();
  let invadingTick: number | null = null;
  let recoveryTick: number | null = null;
  let gameOverTick: number | null = null;
  let outcome: GameOutcome = GameOutcome.None;
  let peakCohort = 0;
  let peakAttackerDeaths = 0;
  let peakDefenderDeaths = 0;
  let rejectedBecause: string | null = null;
  let prevState: AIState = 'Peacetime';
  let stopAfterTick: number | null = null;

  for (let t = 0; t < MAX_TICKS; t++) {
    runAIController(world, ENEMY_COLONY_ID); // onBeforeTick slot
    const cmds = world.commandQueue.splice(0); // the drain
    stampDrainTick(cmds, world.tick); // what createGameLoop does
    for (const c of cmds) inputLog.push(structuredClone(c)); // what appendInputLog keeps
    const tickOutcome = tick(world, cmds);

    const rec = getAIStateForColony(world, ENEMY_COLONY_ID)!;
    statesVisited.add(rec.state);
    let transitioned = false;
    if (rec.state !== prevState) {
      transitions.push(`${world.tick}:${prevState}->${rec.state}`);
      if (rec.state === 'Invading' && invadingTick === null) invadingTick = world.tick;
      if (rec.state === 'Recovery' && invadingTick !== null && recoveryTick === null) {
        recoveryTick = world.tick;
        stopAfterTick = world.tick + POST_RECOVERY_TICKS;
      }
      prevState = rec.state;
      transitioned = true;
    }
    if (rec.state === 'Invading') {
      peakCohort = Math.max(peakCohort, rec.operationFighterCount);
      peakAttackerDeaths = Math.max(peakAttackerDeaths, rec.operationAttackerDeaths);
      peakDefenderDeaths = Math.max(peakDefenderDeaths, rec.operationDefenderDeaths);
    }

    // Early rejection: nothing this run does from here on can make it qualify.
    if (recoveryTick !== null && peakAttackerDeaths === 0 && peakDefenderDeaths === 0) {
      rejectedBecause =
        `invaded at tick ${invadingTick} but the invasion ended at tick ${recoveryTick} ` +
        `with no operation deaths`;
      break;
    }

    // The real loop stops on the first non-None outcome; so does this one.
    const gameOver = tickOutcome !== GameOutcome.None;
    if (gameOver) {
      gameOverTick = world.tick;
      outcome = tickOutcome;
    }
    const last = gameOver || (stopAfterTick !== null && world.tick >= stopAfterTick);
    if (transitioned || last || world.tick % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push({ tick: world.tick, json: snapshot(world) });
    }
    if (last) break;
  }

  const endedBy =
    gameOverTick !== null
      ? `game over (${outcomeName(outcome)}) at tick ${gameOverTick}`
      : recoveryTick !== null
        ? `Recovery at tick ${recoveryTick}`
        : `the ${MAX_TICKS}-tick budget`;
  if (rejectedBecause === null) {
    if (invadingTick === null) {
      rejectedBecause = `never entered Invading before ${endedBy}`;
    } else if (peakCohort < 3) {
      rejectedBecause = `invaded at tick ${invadingTick} but committed no cohort before ${endedBy}`;
    } else if (peakAttackerDeaths === 0 && peakDefenderDeaths === 0) {
      rejectedBecause = `invaded at tick ${invadingTick} but recorded no operation death before ${endedBy}`;
    } else if (recoveryTick === null && gameOverTick === null) {
      rejectedBecause = `invaded at tick ${invadingTick} with deaths but neither the invasion nor the game had ended by tick ${MAX_TICKS}`;
    }
  }
  // Budget hit after Recovery but before the post-Recovery tail: still record
  // the end so the final-world comparison has both sides.
  if (rejectedBecause === null && checkpoints[checkpoints.length - 1]?.tick !== world.tick) {
    checkpoints.push({ tick: world.tick, json: snapshot(world) });
  }

  return {
    seed,
    finalTick: world.tick,
    inputLog,
    checkpoints,
    transitions,
    statesVisited,
    invadingTick,
    recoveryTick,
    gameOverTick,
    outcome,
    peakCohort,
    peakAttackerDeaths,
    peakDefenderDeaths,
    endedBy,
    rejectedBecause,
  };
}

interface ReplayRun {
  checkpoints: Checkpoint[];
  /** First tick at which the replaying tick() returned a non-None outcome. */
  outcomeTick: number | null;
}

/**
 * Replay `log` into a fresh scenario world through tick() only, discarding the
 * self-emits the replaying world regenerates (the recorded batches already
 * contain them — see src/platform/input-log-replay.ts), and snapshot at the
 * same ticks the live run did. Runs to the live run's final tick regardless of
 * outcome, the way the snapshot analyzer replays a captured log.
 */
function runReplay(live: LiveRun, log: readonly SimCommand[]): ReplayRun {
  const world = createScenario(live.seed, DIFFICULTY);
  const byTick = indexByDrainTick(log);
  const wanted = new Set(live.checkpoints.map((c) => c.tick));
  const checkpoints: Checkpoint[] = [];
  let outcomeTick: number | null = null;
  for (let t = 0; t < live.finalTick; t++) {
    world.commandQueue.splice(0);
    const outcome = tick(world, byTick[t] ?? []);
    if (outcome !== GameOutcome.None && outcomeTick === null) outcomeTick = world.tick;
    if (wanted.has(world.tick)) checkpoints.push({ tick: world.tick, json: snapshot(world) });
  }
  return { checkpoints, outcomeTick };
}

function show(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/** Path and both values at the first difference between two parsed snapshots,
 *  so a checkpoint failure names the field (e.g. `$.aiState[0].probeCount`)
 *  instead of dumping two 900 KB strings. Null when the parsed values are
 *  deep-equal. */
function firstDifference(live: unknown, replay: unknown, path = '$'): string | null {
  if (live === replay) return null;
  if (
    typeof live !== 'object' ||
    typeof replay !== 'object' ||
    live === null ||
    replay === null ||
    Array.isArray(live) !== Array.isArray(replay)
  ) {
    return `${path}: live=${show(live)} replay=${show(replay)}`;
  }
  const l = live as Record<string, unknown>;
  const r = replay as Record<string, unknown>;
  for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const d = firstDifference(l[k], r[k], Array.isArray(live) ? `${path}[${k}]` : `${path}.${k}`);
    if (d !== null) return d;
  }
  return null;
}

/** Failure text for one divergent checkpoint: the first differing field overall,
 *  plus the aiState-specific one — the field a RED result has to name. */
function describeDivergence(liveJson: string, replayJson: string): string {
  const l = JSON.parse(liveJson) as { aiState: unknown };
  const r = JSON.parse(replayJson) as { aiState: unknown };
  const overall = firstDifference(l, r) ?? 'none in parsed values (serialization order only)';
  const ai = firstDifference(l.aiState, r.aiState, '$.aiState') ?? 'identical';
  return `first difference: ${overall}; aiState: ${ai}`;
}

function isSync(c: SimCommand): c is Extract<SimCommand, { type: 'SyncAIState' }> {
  return c.type === 'SyncAIState';
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('AI live loop vs tick()-only replay parity through an invasion (#258)', () => {
  // The candidate scan and one replay, done once; every `it` is a pure
  // comparison. The timeout covers the worst case — all nine candidates
  // rejected at the 20k budget, 180k ticks — under the v8-instrumented
  // `test:coverage` run. Measured on a dev machine: ~0.25 ms/tick bare and
  // ~1.8 ms/tick instrumented, so today's qualifying run plus its replay
  // (~26k ticks) is ~7 s bare / ~46 s instrumented, and the worst case is
  // ~45 s bare / ~5.5 min instrumented.
  let live: LiveRun;
  let replay: ReplayRun;
  beforeAll(() => {
    const rejections: string[] = [];
    let chosen: LiveRun | null = null;
    for (const seed of CANDIDATE_SEEDS) {
      const run = runLive(seed);
      if (run.rejectedBecause === null) {
        chosen = run;
        break;
      }
      rejections.push(
        `seed ${seed}: ${run.rejectedBecause} (timeline: ${run.transitions.join(' ') || 'none'})`,
      );
    }
    if (chosen === null) {
      throw new Error(
        `No candidate seed produced a qualifying invasion (Invading with a committed ` +
          `cohort, at least one operation death, and the run ending by Recovery or game ` +
          `over within ${MAX_TICKS} ticks). Re-pick per the header comment. Per-seed ` +
          `reasons:\n  ${rejections.join('\n  ')}`,
      );
    }
    live = chosen;
    replay = runReplay(live, live.inputLog);
  }, 600_000);

  it('non-vacuity: the chosen seed invaded with a committed cohort and recorded an operation death before its run ended', () => {
    const ctx =
      `seed ${live.seed}, AI timeline: ${live.transitions.join(' ')}, ended by ` +
      `${live.endedBy} (final tick ${live.finalTick})`;
    for (const s of ['WarFooting', 'Invading'] as const) {
      expect(live.statesVisited.has(s), `enemy never entered ${s}. ${ctx}`).toBe(true);
    }
    expect(
      live.recoveryTick !== null || live.gameOverTick !== null,
      `neither the invasion nor the game ended. ${ctx}`,
    ).toBe(true);
    expect(live.peakCohort, `no invasion cohort was committed. ${ctx}`).toBeGreaterThanOrEqual(3);
    expect(
      live.peakAttackerDeaths + live.peakDefenderDeaths,
      `no operation death was recorded while Invading (attacker ${live.peakAttackerDeaths}, ` +
        `defender ${live.peakDefenderDeaths}). ${ctx}`,
    ).toBeGreaterThan(0);
  });

  it('non-vacuity: the recorded log holds every drain shape the replay must place', () => {
    // Render-controller output is drained on the tick it is issued; a sim
    // self-emit one tick later (#296). The invasion launch is always here. A
    // probe is not guaranteed (WarFooting can go straight to Invading), but a
    // run that probed and then invaded necessarily ended the probe, so its
    // launch AND the probe-end ClearRallyPoint self-emit must be in the log.
    const ops = live.inputLog.filter((c) => c.type === 'StartAIOperation');
    expect(ops.some((c) => c.kind === 'Invasion')).toBe(true);
    for (const c of ops) expect(c.drainTick).toBe(c.issuedAtTick);

    const selfEmits = live.inputLog.filter((c) => c.origin === 'sim');
    if (live.statesVisited.has('Probing') || live.recoveryTick !== null) {
      if (live.statesVisited.has('Probing')) expect(ops.some((c) => c.kind === 'Probe')).toBe(true);
      expect(selfEmits.length).toBeGreaterThan(0);
    }
    expect(selfEmits.every((c) => c.type === 'ClearRallyPoint')).toBe(true);
    for (const c of selfEmits) expect(c.drainTick).toBe(c.issuedAtTick + 1);
  });

  it('the live loop emits no SyncAIState — the echo is retired (#258)', () => {
    // Pins the retirement: the log the parity below replays carries no echo, so a
    // match proves the sim reproduces aiState unaided. Logs recorded before #258
    // still replay — tick.ts keeps the uncapped pre-pass that applies the command.
    expect(live.inputLog.filter(isSync)).toHaveLength(0);
  });

  it('the tick()-only replay reproduces the live world at every checkpoint', () => {
    const r = replay.checkpoints;
    expect(r.map((c) => c.tick)).toEqual(live.checkpoints.map((c) => c.tick));
    for (let i = 0; i < live.checkpoints.length; i++) {
      const lc = live.checkpoints[i]!;
      const rc = r[i]!;
      if (lc.json === rc.json) continue;
      const lastGood = i === 0 ? 'none' : `tick ${live.checkpoints[i - 1]!.tick}`;
      expect.fail(
        `seed ${live.seed}: live and replay diverged at tick ${lc.tick} (checkpoint ${i + 1} ` +
          `of ${live.checkpoints.length}; last matching checkpoint: ${lastGood}). ` +
          `${describeDivergence(lc.json, rc.json)}. ` +
          `AI timeline: ${live.transitions.join(' ')}`,
      );
    }
  });

  it('the tick()-only replay reproduces the live final world and ends the game on the same tick', () => {
    const lc = live.checkpoints[live.checkpoints.length - 1]!;
    const rc = replay.checkpoints[replay.checkpoints.length - 1]!;
    expect(lc.tick).toBe(live.finalTick);
    expect(rc.tick).toBe(live.finalTick);
    expect(
      rc.json === lc.json,
      `seed ${live.seed}: final world differs — ${describeDivergence(lc.json, rc.json)}`,
    ).toBe(true);
    // Where the real loop would have stopped, the replay's tick() reports the
    // same outcome on the same tick (null on both sides if the run ended by
    // Recovery instead).
    expect(replay.outcomeTick).toBe(live.gameOverTick);
  });
});
