// jev-enemy-controller.test.ts — the Jev opponent's tick behavior, against a
// scripted client (no network) and real createScenario worlds driven through
// real tick()s, exactly as the game loop drives them.

import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { copyWorldState, type WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { FP_SHIFT } from '../sim/fixed.js';
import type { JevAnswerMap } from './jev-encode.js';
import {
  assertRequestValid,
  type JevAskResult,
  type JevClient,
  type JevMintResult,
} from './jev-client.js';
import type { Seats } from './jev-types.js';
import { JevCommandLedger } from './jev-commands.js';
import { createJevOpeningState, isHandoffComplete, runJevOpeningTick } from './jev-opening.js';

/** Every tile of every pending footprint `colonyId` owns, as "x,y" keys. */
function pendingFootprintTiles(world: WorldState, colonyId: number): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(world.pendingChambers)) {
    if (p.colonyId !== colonyId) continue;
    for (let dy = 0; dy < p.height; dy++) {
      for (let dx = 0; dx < p.width; dx++) out.add(`${p.anchorTileX + dx},${p.anchorTileY + dy}`);
    }
  }
  return out;
}

// The fallback path must be the REAL import, observed. Everything else the
// opening and the cadence executor use (aiInitialSetup, the AI_DIG_* constants)
// passes through untouched.
vi.mock('./ai-controller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-controller.js')>();
  return { ...actual, runAIController: vi.fn(actual.runAIController) };
});

import { AI_DIG_INTERVAL, resetAIControllerCache, runAIController } from './ai-controller.js';
import { JEV_DEFAULT_BEAT_TICKS, JevEnemyController } from './jev-enemy-controller.js';

const SEED = 1;
const BEAT = JEV_DEFAULT_BEAT_TICKS;
const SEATS: Seats = { mySeat: ENEMY_COLONY_ID, opponentSeat: PLAYER_COLONY_ID };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Scripted stand-in for the proxy client (contract v2). Resolves/rejects on a
 * microtask. `mints` counts session mints — the readiness probe is one — and
 * `calls` counts beats; the controller's accounting distinguishes the two.
 */
class ScriptedClient implements JevClient {
  mints = 0;
  calls = 0;
  lastState: Record<string, unknown> | null = null;
  constructor(
    private readonly respond: (state: Record<string, unknown>, n: number) => JevAnswerMap | Error,
    /** null = the endpoint is alive; an Error = every mint fails too. */
    private readonly mintFailure: Error | null = null,
  ) {}
  mintSession(): Promise<JevMintResult> {
    this.mints++;
    if (this.mintFailure !== null) return Promise.reject(this.mintFailure);
    return Promise.resolve({
      expiresInSeconds: 600,
      beatBudget: 50,
      minBeatIntervalMs: 250,
      latencyMs: 7,
    });
  }
  beat(state: Record<string, unknown>): Promise<JevAskResult> {
    const n = this.calls++;
    this.lastState = state;
    const out = this.respond(state, n);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve({ answers: out, usage: null, model: 'scripted', latencyMs: 7 });
  }
}

/** A client whose endpoint is dead: the mint fails and so does every beat. */
function deadClient(message = 'dead endpoint'): ScriptedClient {
  return new ScriptedClient(() => new Error(message), new Error(message));
}

const choice = (c: string): JevAnswerMap[string] => ({
  type: 'choice',
  choice: c,
  confidence: 1,
  probabilities: { [c]: 1 },
});

/**
 * Answer every question the proxy would build from `state.candidates` —
 * an options object is a choice, a bare string is a yes/no — preferring `picks`
 * when the option is live. Answers are keyed by the CANDIDATE id, which is what
 * the proxy names its questions after.
 */
function scripted(
  picks: Record<string, string> = {},
  nouls: Record<string, number> = {},
): (state: Record<string, unknown>) => JevAnswerMap {
  return (state) => {
    const groups = state.candidates as Record<string, unknown>;
    const out: Record<string, JevAnswerMap[string]> = {};
    for (const [id, group] of Object.entries(groups)) {
      if (typeof group === 'string') {
        out[id] = { type: 'noul', noul: nouls[id] ?? 0.1 };
        continue;
      }
      const keys = Object.keys(group as Record<string, string>);
      const want = picks[id];
      out[id] = choice(want !== undefined && keys.includes(want) ? want : keys[0]!);
    }
    return out;
  };
}

/** The candidate groups the last beat offered — what the proxy turns into questions. */
function offeredCandidates(client: ScriptedClient): string[] {
  return Object.keys(client.lastState!.candidates as Record<string, unknown>);
}

interface IssuedRecord {
  tick: number;
  cmd: SimCommand;
}

/** One game-loop iteration: onBeforeTick seam → drain → tick. */
function stepOnce(world: WorldState, ctl: JevEnemyController, log?: IssuedRecord[]): void {
  const t = world.tick;
  ctl.onBeforeTick(world);
  if (log) for (const cmd of world.commandQueue) log.push({ tick: t, cmd });
  tick(world, world.commandQueue.splice(0));
}

/** Let a resolved/rejected client promise settle through .then/.finally. */
async function settleClient(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

async function step(
  world: WorldState,
  ctl: JevEnemyController,
  n: number,
  log?: IssuedRecord[],
): Promise<void> {
  for (let i = 0; i < n; i++) {
    stepOnce(world, ctl, log);
    await settleClient();
  }
}

/** Advance until `world.tick` is the next beat boundary (0 steps if already on one). */
async function alignToBeat(
  world: WorldState,
  ctl: JevEnemyController,
  log?: IssuedRecord[],
  beat = BEAT,
) {
  await step(world, ctl, (beat - (world.tick % beat)) % beat, log);
}

/**
 * The live-phase fixture: a world whose nest is not merely planned but fully
 * EXCAVATED (`isHandoffComplete`, the stricter of jev-opening's two predicates).
 * The controller itself hands off far earlier than this — on `isOpeningPlanned`,
 * within a couple of ticks — but the live phase is where frontier digs, storage
 * expansion and rally points live, and those want a real nest under them rather
 * than a field of pending footprints.
 *
 * It is a few hundred ticks of real simulation, so it runs ONCE for the file and
 * each test gets a clone. #227 precedent: the build carries an explicit generous
 * timeout so the local coverage gate passes under v8 instrumentation, while the
 * default 5s stays the tripwire for every individual test below.
 */
let handoffTemplate!: WorldState;
beforeAll(() => {
  resetAIControllerCache();
  const built = createScenario(SEED, 'Normal');
  const ledger = new JevCommandLedger();
  const st = createJevOpeningState();
  while (!isHandoffComplete(built, ENEMY_COLONY_ID)) {
    if (built.tick >= 8000) throw new Error('nest not excavated by tick 8000');
    runJevOpeningTick(built, ENEMY_COLONY_ID, ledger, st);
    tick(built, built.commandQueue.splice(0));
  }
  handoffTemplate = built;
}, 120_000);

/** A fresh, independently-mutable copy of the fully-excavated world. */
function handoffWorld(): WorldState {
  const clone = createScenario(SEED, 'Normal');
  copyWorldState(handoffTemplate, clone);
  return clone;
}

/**
 * A world the opening can never finish planning, so the controller stays in
 * 'opening' for as long as a test needs it to.
 *
 * The colony's one entrance is moved off the side of the grid. The whole plan
 * hangs off the entrance column, so `computeNestPlan` returns null: nothing is
 * marked, nothing is placed, and `isOpeningPlanned` never becomes true.
 * `aiInitialSetup` does not rescue it either, because the colony still HAS an
 * entrance.
 *
 * Synthetic on purpose, and worth being honest about WHY it is needed: the
 * probe's repeat-on-the-beat-cadence branch only runs while the phase is
 * 'opening', and a real opening is now over on tick 2 — long before the first
 * beat boundary. So in a real round the probe fires once, at tick 0, and the
 * retry branch never runs. These tests still pin its behavior, but a world has
 * to be bent to reach it. If the branch is ever deliberately retired, these
 * three tests and this fixture go with it.
 */
function unplannableWorld(): WorldState {
  const world = createScenario(SEED, 'Normal');
  const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
  world.colonies[ENEMY_COLONY_ID]!.entrances[0]!.surfaceTileX = grid.width + 4;
  return world;
}

beforeEach(() => {
  vi.mocked(runAIController).mockClear();
  resetAIControllerCache();
});

// ---------------------------------------------------------------------------

describe('JevEnemyController — opening phase', () => {
  it('plans the nest and hands off within a handful of ticks, issuing only opening commands', async () => {
    const client = new ScriptedClient(scripted());
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');
    const log: IssuedRecord[] = [];

    await step(world, ctl, 6, log);

    expect(ctl.phase).toBe('live');
    expect(ctl.handoffTick).not.toBeNull();
    expect(ctl.handoffTick!).toBeLessThanOrEqual(5);
    // The whole nest is committed — three chambers, none of them excavated yet.
    const colony = world.colonies[ENEMY_COLONY_ID]!;
    expect(
      Object.values(world.pendingChambers).filter((p) => p.colonyId === ENEMY_COLONY_ID),
    ).toHaveLength(3);
    expect(colony.chambers).toHaveLength(0);
    // Nothing but opening-shaped commands, and nothing rejected.
    expect(log.length).toBeGreaterThan(0);
    const types = new Set(log.map((r) => r.cmd.type));
    for (const t of types) {
      expect(['SetBehaviorRatio', 'MarkDigTile', 'PlaceChamber', 'DesignateEntrance']).toContain(t);
    }
    ctl.ledger.settle(world);
    expect(ctl.ledger.counts.rejected).toBe(0);
    // The opening's behavior ratio is applied, seat-correctly.
    expect(colony.targetRatio).toEqual({ forage: 7, fight: 3 });
    // Handoff is not a beat: the probe is still the only request sent.
    expect(client.mints).toBe(1);
    expect(client.calls).toBe(0);
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();
  });

  it('fires the first beat on the first beat boundary after handoff', async () => {
    const client = new ScriptedClient(scripted());
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');

    // Handoff lands inside the first beat window, so nothing is asked until the
    // boundary itself — and then exactly one beat.
    await step(world, ctl, BEAT);
    expect(ctl.phase).toBe('live');
    expect(client.calls).toBe(0);
    expect(world.tick).toBe(BEAT);

    await step(world, ctl, 1);
    expect(client.calls).toBe(1);
    expect(ctl.beats).toBe(1);
  });

  it('takes no decision-shaped action while the opening is unfinished, beyond the probe', async () => {
    // The probe (a session mint) succeeds on its first and only attempt, so this
    // exercises the "opening is otherwise inert" invariant with the probe folded
    // in: still no beats, still no rule-based AI.
    const client = new ScriptedClient(scripted());
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = unplannableWorld();
    const log: IssuedRecord[] = [];

    await step(world, ctl, BEAT * 5 + 1, log);

    expect(client.mints).toBe(1);
    expect(client.calls).toBe(0);
    expect(ctl.probe).toBe('ok');
    expect(ctl.phase).toBe('opening');
    expect(ctl.beats).toBe(0);
    expect(ctl.handoffTick).toBeNull();
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();
    // With no plannable column the planner's ONE remaining job is the opening
    // ratio, and it still does it seat-correctly. Asserting the exact set (not
    // "every type is in the allowlist") keeps this from passing vacuously if the
    // fixture ever stops producing commands at all.
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log.map((r) => r.cmd.type))).toEqual(new Set(['SetBehaviorRatio']));
    expect(world.colonies[ENEMY_COLONY_ID]!.targetRatio).toEqual({ forage: 7, fight: 3 });
  });

  it('leaves world.aiState alone so the rule-based machine stays warm', async () => {
    const client = new ScriptedClient(() => new Error('unused'));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');
    await step(world, ctl, 200);
    // tick.ts owns aiState transitions; the controller never pushes SyncAIState.
    expect(world.aiState.some((r) => r.colonyId === ENEMY_COLONY_ID)).toBe(true);
    expect(ctl.ledger.counts.rejected).toBe(0);
  });
});

describe('JevEnemyController — readiness probe', () => {
  it('mints the session on tick 0, and only once when that succeeds', async () => {
    const client = new ScriptedClient(scripted());
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');

    expect(ctl.probe).toBeNull();
    await step(world, ctl, 1);

    // The probe IS the mint: no state, no questions, no answers to decode — the
    // whole signal is whether the request itself succeeded.
    expect(client.mints).toBe(1);
    expect(client.calls).toBe(0);
    expect(client.lastState).toBeNull();
    expect(ctl.probe).toBe('ok');
    expect(ctl.beats).toBe(0);
    expect(ctl.lastLatencyMs).toBe(7);

    // Well past several beat boundaries: one success is enough for the round, so
    // the mint is never repeated even though real beats are now going out.
    await step(world, ctl, BEAT * 3);
    expect(client.mints).toBe(1);
    expect(client.calls).toBeGreaterThan(0);
  });

  it('repeats every beatTicks while it keeps failing, counting each as a failed beat', async () => {
    const client = deadClient();
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    // The repeat cadence only applies while the opening is unfinished, which on
    // a normal world is two ticks — so this needs a world that never gets there.
    const world = unplannableWorld();

    await step(world, ctl, 1); // tick 0
    expect(client.mints).toBe(1);
    expect(ctl.probe).toBe('failed');
    expect(ctl.failedBeats).toBe(1);

    await step(world, ctl, BEAT - 1); // ticks 1..BEAT-1: not aligned, no repeat yet
    expect(client.mints).toBe(1);

    await step(world, ctl, 1); // tick BEAT: second probe
    expect(client.mints).toBe(2);
    expect(ctl.probe).toBe('failed');
    expect(ctl.failedBeats).toBe(2);

    await step(world, ctl, BEAT); // tick 2*BEAT: third probe
    expect(client.mints).toBe(3);
    expect(ctl.failedBeats).toBe(3);

    // Never a real beat and never a decision, no matter how many probes fired.
    expect(client.calls).toBe(0);
    expect(ctl.beats).toBe(0);
  });

  it('flips to the rule-based AI after three failed probes, well before handoff', async () => {
    const onFallback = vi.fn();
    const client = deadClient();
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '', onFallback });
    const world = unplannableWorld();

    // Three probes land at tick 0, BEAT and 2*BEAT — three failures, but the
    // flip itself is a tick-seam decision, not something the promise handler
    // does (same rule as a normal beat failure).
    await step(world, ctl, BEAT * 2 + 1);
    expect(client.mints).toBe(3);
    expect(ctl.failedBeats).toBe(3);
    expect(ctl.status).toBe('jev');
    expect(onFallback).not.toHaveBeenCalled();
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();
    expect(ctl.handoffTick).toBeNull();

    await step(world, ctl, 1);
    expect(ctl.status).toBe('fallback');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAIController)).toHaveBeenCalled();
    expect(vi.mocked(runAIController).mock.calls[0]![1]).toBe(ENEMY_COLONY_ID);
    expect(ctl.beats).toBe(0);
    expect(ctl.phase).toBe('opening'); // handoff was never reached
  });

  it('never applies a decision from a probe, even with a client primed to answer beats', async () => {
    const client = new ScriptedClient(scripted({ fight_ratio: 'military', posture: 'assault' }));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = unplannableWorld();
    const log: IssuedRecord[] = [];

    await step(world, ctl, BEAT + 1, log);
    expect(ctl.probe).toBe('ok');
    expect(client.mints).toBe(1);
    expect(client.calls).toBe(0);
    expect(ctl.beats).toBe(0);

    // Only the opening's own commands were issued — nothing resembling the
    // "military"/"assault" answers the client would give to a REAL beat (a mint
    // carries no state and returns no answers, so decodeAnswers is never even
    // invoked for it).
    const types = new Set(log.map((r) => r.cmd.type));
    for (const t of types) {
      expect(['SetBehaviorRatio', 'MarkDigTile', 'PlaceChamber', 'DesignateEntrance']).toContain(t);
    }
    expect(world.colonies[ENEMY_COLONY_ID]!.targetRatio).toEqual({ forage: 7, fight: 3 });
    expect(world.colonies[ENEMY_COLONY_ID]!.rallyPoint).toBeNull();
  });
});

describe('JevEnemyController — live phase', () => {
  it('detects the live phase from a resumed world and beats on the beat boundary', async () => {
    const client = new ScriptedClient(scripted({ fight_ratio: 'military' }));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();

    // A controller constructed fresh against a mid-round world (the bootFromSave
    // path) starts in 'opening' and flips on its very first tick seam. That same
    // first seam also fires the one-time readiness probe (the session mint).
    expect(ctl.phase).toBe('opening');
    stepOnce(world, ctl);
    expect(ctl.phase).toBe('live');
    expect(ctl.handoffTick).not.toBeNull();
    expect(client.mints).toBe(1);
    expect(client.calls).toBe(0);

    await alignToBeat(world, ctl);
    expect(ctl.probe).toBe('ok');
    expect(client.calls).toBe(0);
    stepOnce(world, ctl); // this tick IS a beat boundary
    expect(client.calls).toBe(1);
    expect(ctl.beats).toBe(1);
    // The state a real beat sends passes the client's own pre-flight guard.
    expect(() => assertRequestValid(client.lastState!)).not.toThrow();
  });

  it('holds the dig direction at handoff so the one digger finishes the planned nest', async () => {
    const client = new ScriptedClient(scripted());
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');
    const log: IssuedRecord[] = [];

    // Handoff leaves three unexcavated chambers behind; until Jev says otherwise
    // the cadence executor must not queue a frontier that competes for the
    // colony's single digger.
    await step(world, ctl, AI_DIG_INTERVAL * 2, log);
    expect(ctl.phase).toBe('live');
    expect(ctl.digDirection).toBe('hold');
    const afterHandoff = log.filter(
      (r) => r.cmd.type === 'MarkDigTile' && r.tick > ctl.handoffTick!,
    );
    expect(afterHandoff).toHaveLength(0);
  });

  it('never marks a frontier tile inside one of its own pending chamber footprints', async () => {
    // The live phase now runs alongside an unexcavated nest, so the two dig
    // paths overlap in time for the first time. They still cannot collide:
    // PlaceChamber flipped every footprint tile to Marked and digFrontier only
    // ever returns Solid tiles. Pin it, because the day digFrontier widens is
    // the day the nest starts getting re-marked out from under the digger.
    const client = new ScriptedClient(
      scripted({ dig: 'deeper', posture: 'recall', fight_ratio: 'economy' }),
    );
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');
    const log: IssuedRecord[] = [];

    await step(world, ctl, 6, log);
    const footprint = pendingFootprintTiles(world, ENEMY_COLONY_ID);
    expect(footprint.size).toBe(5 * 3 + 4 * 3 + 4 * 3);

    await step(world, ctl, BEAT * 3, log);
    expect(ctl.digDirection).toBe('deeper');
    const marks = log.filter((r) => r.cmd.type === 'MarkDigTile');
    expect(marks.filter((r) => r.tick > ctl.handoffTick!).length).toBeGreaterThan(0);
    for (const r of marks) {
      if (r.cmd.type !== 'MarkDigTile') continue;
      expect(footprint.has(`${r.cmd.tileX},${r.cmd.tileY}`)).toBe(false);
    }
    expect(ctl.ledger.counts.rejected).toBe(0);
  });

  it('does not apply inside the promise — the decision lands on the NEXT tick seam', async () => {
    const client = new ScriptedClient(scripted({ fight_ratio: 'military', posture: 'assault' }));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();
    const colony = world.colonies[ENEMY_COLONY_ID]!;

    stepOnce(world, ctl); // the readiness probe (a mint)
    await alignToBeat(world, ctl);

    // Beat tick: the request goes out, but nothing is queued from it.
    ctl.onBeforeTick(world);
    expect(client.calls).toBe(1);
    expect(world.commandQueue.some((c) => c.type === 'SetBehaviorRatio')).toBe(false);
    tick(world, world.commandQueue.splice(0));
    await settleClient();

    // Promise resolved. The world must still be untouched by it.
    expect(colony.targetRatio).toEqual({ forage: 7, fight: 3 });
    expect(colony.rallyPoint).toBeNull();

    // Next seam applies it.
    ctl.onBeforeTick(world);
    const queued = world.commandQueue.map((c) => c.type);
    expect(queued).toContain('SetBehaviorRatio');
    expect(queued).toContain('SetRallyPoint');
    tick(world, world.commandQueue.splice(0));
    expect(colony.targetRatio).toEqual({ forage: 3, fight: 7 });
    expect(colony.rallyPoint).not.toBeNull();
    expect(ctl.lastLatencyMs).toBe(7);
  });

  it('pushes only what changed: an identical next beat re-issues nothing', async () => {
    const client = new ScriptedClient(
      scripted({ fight_ratio: 'military', posture: 'assault', dig: 'deeper' }),
    );
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();
    const log: IssuedRecord[] = [];

    stepOnce(world, ctl, log);
    await alignToBeat(world, ctl, log);
    await step(world, ctl, 2, log); // beat + apply
    const afterFirst = {
      ratio: log.filter((r) => r.cmd.type === 'SetBehaviorRatio').length,
      rally: log.filter((r) => r.cmd.type === 'SetRallyPoint').length,
    };
    expect(afterFirst.ratio).toBe(1);
    expect(afterFirst.rally).toBe(1);
    expect(world.colonies[ENEMY_COLONY_ID]!.targetRatio).toEqual({ forage: 3, fight: 7 });

    // Two more beats with the same answers.
    await step(world, ctl, BEAT * 2 + 2, log);
    expect(client.calls).toBeGreaterThanOrEqual(3);
    expect(log.filter((r) => r.cmd.type === 'SetBehaviorRatio').length).toBe(afterFirst.ratio);
    expect(log.filter((r) => r.cmd.type === 'SetRallyPoint').length).toBe(afterFirst.rally);
    expect(ctl.ledger.counts.noop).toBe(0);
  });

  it('marks dig tiles only on AI_DIG_INTERVAL boundaries, in the chosen direction', async () => {
    const client = new ScriptedClient(
      scripted({ dig: 'deeper', posture: 'recall', fight_ratio: 'economy' }),
    );
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();
    const log: IssuedRecord[] = [];

    stepOnce(world, ctl, log);
    await alignToBeat(world, ctl, log);
    await step(world, ctl, BEAT * 2, log);

    expect(ctl.digDirection).toBe('deeper');
    const marks = log.filter((r) => r.cmd.type === 'MarkDigTile');
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m.tick % AI_DIG_INTERVAL).toBe(0);
  });

  it('sends standing orders when configured, and omits the field when empty', async () => {
    const withOrders = new ScriptedClient(scripted());
    const ctlA = new JevEnemyController({
      seats: SEATS,
      client: withOrders,
      orders: 'Strike early and keep striking.',
    });
    const worldA = handoffWorld();
    stepOnce(worldA, ctlA);
    await alignToBeat(worldA, ctlA);
    stepOnce(worldA, ctlA);
    expect(withOrders.lastState!.standing_orders).toBe('Strike early and keep striking.');

    const noOrders = new ScriptedClient(scripted());
    const ctlB = new JevEnemyController({ seats: SEATS, client: noOrders, orders: '' });
    const worldB = handoffWorld();
    stepOnce(worldB, ctlB);
    await alignToBeat(worldB, ctlB);
    stepOnce(worldB, ctlB);
    expect('standing_orders' in noOrders.lastState!).toBe(false);
  });

  it('applies food priority, spider priority and storage expansion when offered', async () => {
    const SHORT_BEAT = 20;
    const picks: Record<string, string> = {
      fight_ratio: 'economy',
      posture: 'recall',
      dig: 'hold',
      food_priority: 'pile_a',
    };
    const client = new ScriptedClient((state) =>
      scripted(picks, { spider_priority: 0.9, expand_storage: 0.9 })(state),
    );
    const ctl = new JevEnemyController({
      seats: SEATS,
      client,
      orders: '',
      beatTicks: SHORT_BEAT,
    });
    const world = handoffWorld();
    const colony = world.colonies[ENEMY_COLONY_ID]!;
    const entrance = colony.entrances[0]!;

    stepOnce(world, ctl);
    await alignToBeat(world, ctl, undefined, SHORT_BEAT);

    // Put the spider on our doorstep and fill the stores, so both optional
    // questions are offered on this beat.
    world.spider!.posX = entrance.surfaceTileX << FP_SHIFT;
    world.spider!.posY = entrance.surfaceTileY << FP_SHIFT;
    colony.foodStored = 1_000_000;

    const log: IssuedRecord[] = [];
    await step(world, ctl, 1, log); // beat fires
    expect(offeredCandidates(client)).toEqual(
      expect.arrayContaining(['spider_priority', 'expand_storage']),
    );
    await step(world, ctl, 1, log); // decision applied

    const types = log.map((r) => r.cmd.type);
    expect(types).toContain('MarkFoodPile');
    expect(types).toContain('MarkSpiderPriority');
    expect(types).toContain('PlaceChamber');
    expect(colony.priorityFoodPileId).not.toBeNull();
    expect(world.spiderPriorityColonyId).toBe(ENEMY_COLONY_ID);

    // Switching to "no priority pile" re-marks the CURRENT pile, because
    // MarkFoodPile toggles in tick.ts.
    picks.food_priority = 'none';
    const log2: IssuedRecord[] = [];
    await step(world, ctl, SHORT_BEAT + 1, log2);
    expect(log2.filter((r) => r.cmd.type === 'MarkFoodPile').length).toBeGreaterThanOrEqual(1);
    expect(colony.priorityFoodPileId).toBeNull();
  });

  it('does not overlap requests — a beat while one is in flight is skipped', async () => {
    let release: (() => void) | null = null;
    let mints = 0;
    let calls = 0;
    const client: JevClient = {
      mintSession(): Promise<JevMintResult> {
        // The readiness probe resolves immediately so it doesn't mask the
        // in-flight BEAT this test is actually about.
        mints += 1;
        return Promise.resolve({
          expiresInSeconds: 600,
          beatBudget: 50,
          minBeatIntervalMs: 250,
          latencyMs: 1,
        });
      },
      beat(): Promise<JevAskResult> {
        calls += 1;
        return new Promise<JevAskResult>((resolve) => {
          release = () => resolve({ answers: {}, usage: null, model: 'slow', latencyMs: 1 });
        });
      },
    };
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();

    stepOnce(world, ctl); // the probe
    await alignToBeat(world, ctl);
    expect(ctl.probe).toBe('ok');
    expect(mints).toBe(1);
    expect(calls).toBe(0);

    await step(world, ctl, BEAT * 3 + 1); // three beat boundaries pass
    expect(calls).toBe(1); // only the first boundary's beat got sent; it never resolved
    expect(ctl.beats).toBe(1);

    release!();
    await settleClient();
    await step(world, ctl, BEAT + 1);
    expect(calls).toBe(2);
  });
});

describe('JevEnemyController — failure policy', () => {
  it('falls back to the rule-based AI after three consecutive failed beats, notifying once', async () => {
    const onFallback = vi.fn();
    const client = deadClient('503 from the proxy');
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '', onFallback });
    const world = handoffWorld();

    // The mandatory readiness probe runs first; this world is already past
    // handoff, so it fails too and counts as the first of the three failures.
    stepOnce(world, ctl);
    await alignToBeat(world, ctl);
    expect(ctl.probe).toBe('failed');
    expect(ctl.failedBeats).toBe(1);
    expect(ctl.status).toBe('jev');

    // Two more beat boundaries (T and T+BEAT) — three failures total, still on
    // Jev: the status flip is a tick-seam decision, not something the promise
    // handler does.
    await step(world, ctl, BEAT + 1);
    expect(ctl.failedBeats).toBe(3);
    expect(ctl.status).toBe('jev');
    expect(onFallback).not.toHaveBeenCalled();
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();

    await step(world, ctl, 1);
    expect(ctl.status).toBe('fallback');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAIController)).toHaveBeenCalled();
    expect(vi.mocked(runAIController).mock.calls[0]![1]).toBe(ENEMY_COLONY_ID);

    // Sticky: the rule-based AI keeps driving and nothing else is ever sent.
    const requestsAtFallback = client.mints + client.calls;
    vi.mocked(runAIController).mockClear();
    await step(world, ctl, BEAT * 2);
    expect(client.mints + client.calls).toBe(requestsAtFallback);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAIController).mock.calls.length).toBe(BEAT * 2);
  });

  it('a success resets the consecutive-failure streak', async () => {
    const onFallback = vi.fn();
    // The readiness probe is a session mint and succeeds, so it never joins the
    // streak. Of the five real beats that follow (0-4): fail, fail, succeed,
    // fail, fail — never three in a row.
    const client = new ScriptedClient((state, n) =>
      n === 2 ? scripted()(state) : new Error('transient'),
    );
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '', onFallback });
    const world = handoffWorld();

    stepOnce(world, ctl);
    await alignToBeat(world, ctl);
    expect(ctl.probe).toBe('ok');
    await step(world, ctl, BEAT * 4 + 1); // five beat boundaries

    expect(client.mints).toBe(1);
    expect(client.calls).toBe(5);
    expect(ctl.failedBeats).toBe(4);
    expect(ctl.status).toBe('jev');
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('counts a malformed 200 body as a failed beat instead of throwing', async () => {
    // A proxy that answers 200 with garbage must not be able to take the page
    // down from inside the promise handler.
    const client: JevClient = {
      mintSession: () =>
        Promise.resolve({
          expiresInSeconds: 600,
          beatBudget: 50,
          minBeatIntervalMs: 250,
          latencyMs: 1,
        }),
      beat: () =>
        Promise.resolve({
          answers: { fight_ratio: null } as unknown as JevAnswerMap,
          usage: null,
          model: 'broken',
          latencyMs: 1,
        }),
    };
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();
    stepOnce(world, ctl);
    await alignToBeat(world, ctl);
    await step(world, ctl, 2);
    expect(ctl.failedBeats).toBe(1);
    expect(ctl.status).toBe('jev');
  });

  it('is inert for a defeated colony', async () => {
    const client = new ScriptedClient(() => new Error('must not be asked'));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();
    world.colonies[ENEMY_COLONY_ID]!.defeated = true;
    await step(world, ctl, BEAT + 1);
    expect(client.mints).toBe(0);
    expect(client.calls).toBe(0);
    expect(ctl.phase).toBe('opening');
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();
  });
});
