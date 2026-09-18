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
import type { JevAnswerMap, JevQuestionMap } from './jev-encode.js';
import type { JevAskResult, JevClient } from './jev-client.js';
import type { Seats } from './jev-types.js';
import { JevCommandLedger } from './jev-commands.js';
import { createJevOpeningState, isHandoffComplete, runJevOpeningTick } from './jev-opening.js';

// The fallback path must be the REAL import, observed. Everything else the
// opening uses (aiInitialSetup / aiDigHeuristic / aiChamberPlacement, the
// AI_DIG_* constants) passes through untouched.
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

/** Scripted stand-in for the proxy client. Resolves/rejects on a microtask. */
class ScriptedClient implements JevClient {
  calls = 0;
  lastState: Record<string, unknown> | null = null;
  lastQuestions: JevQuestionMap | null = null;
  constructor(private readonly respond: (q: JevQuestionMap, n: number) => JevAnswerMap | Error) {}
  ask(state: Record<string, unknown>, questions: JevQuestionMap): Promise<JevAskResult> {
    const n = this.calls++;
    this.lastState = state;
    this.lastQuestions = questions;
    const out = this.respond(questions, n);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve({ answers: out, usage: null, model: 'scripted', latencyMs: 7 });
  }
}

const choice = (c: string): JevAnswerMap[string] => ({
  type: 'choice',
  choice: c,
  confidence: 1,
  probabilities: { [c]: 1 },
});

/** Answer every offered question, preferring `picks` when the option is live. */
function scripted(
  picks: Record<string, string>,
  nouls: Record<string, number> = {},
): (q: JevQuestionMap) => JevAnswerMap {
  return (q) => {
    const out: Record<string, JevAnswerMap[string]> = {};
    for (const [id, question] of Object.entries(q)) {
      if (question.type === 'choice') {
        const want = picks[id];
        const keys = Object.keys(question.criteria);
        out[id] = choice(want !== undefined && keys.includes(want) ? want : keys[0]!);
      } else {
        out[id] = { type: 'noul', noul: nouls[id] ?? 0.1 };
      }
    }
    return out;
  };
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
 * The opening is ~4k ticks of real simulation, so it runs ONCE for the file and
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
    if (built.tick >= 8000) throw new Error('no handoff by tick 8000');
    runJevOpeningTick(built, ENEMY_COLONY_ID, ledger, st);
    tick(built, built.commandQueue.splice(0));
  }
  handoffTemplate = built;
}, 120_000);

/** A fresh, independently-mutable copy of the post-handoff world. */
function handoffWorld(): WorldState {
  const clone = createScenario(SEED, 'Normal');
  copyWorldState(handoffTemplate, clone);
  return clone;
}

beforeEach(() => {
  vi.mocked(runAIController).mockClear();
  resetAIControllerCache();
});

// ---------------------------------------------------------------------------

describe('JevEnemyController — opening phase', () => {
  it('is inert before handoff: no beats, only opening commands, no rule-based AI', async () => {
    const client = new ScriptedClient(() => new Error('must not be asked during the opening'));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = createScenario(SEED, 'Normal');
    const log: IssuedRecord[] = [];

    await step(world, ctl, BEAT * 5 + 1, log);

    expect(client.calls).toBe(0);
    expect(ctl.phase).toBe('opening');
    expect(ctl.beats).toBe(0);
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();
    expect(log.length).toBeGreaterThan(0);
    const types = new Set(log.map((r) => r.cmd.type));
    for (const t of types) {
      expect(['SetBehaviorRatio', 'MarkDigTile', 'PlaceChamber', 'DesignateEntrance']).toContain(t);
    }
    // The opening's behavior ratio is applied, seat-correctly.
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

describe('JevEnemyController — live phase', () => {
  it('detects the live phase from a resumed world and asks on the beat boundary', async () => {
    const client = new ScriptedClient(scripted({ ratio: 'military' }));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();

    // A controller constructed fresh against a mid-round world (the bootFromSave
    // path) starts in 'opening' and flips on its very first tick seam.
    expect(ctl.phase).toBe('opening');
    stepOnce(world, ctl);
    expect(ctl.phase).toBe('live');
    expect(ctl.handoffTick).not.toBeNull();

    await alignToBeat(world, ctl);
    expect(client.calls).toBe(0);
    stepOnce(world, ctl); // this tick IS a beat boundary
    expect(client.calls).toBe(1);
    expect(ctl.beats).toBe(1);
  });

  it('does not apply inside the promise — the decision lands on the NEXT tick seam', async () => {
    const client = new ScriptedClient(scripted({ ratio: 'military', posture: 'assault' }));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();
    const colony = world.colonies[ENEMY_COLONY_ID]!;

    stepOnce(world, ctl);
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
      scripted({ ratio: 'military', posture: 'assault', dig: 'deeper' }),
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
      scripted({ dig: 'deeper', posture: 'recall', ratio: 'economy' }),
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
    const withOrders = new ScriptedClient(scripted({}));
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

    const noOrders = new ScriptedClient(scripted({}));
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
      ratio: 'economy',
      posture: 'recall',
      dig: 'hold',
      food_priority: 'pile_a',
    };
    const client = new ScriptedClient((q) =>
      scripted(picks, { spider_priority: 0.9, expand_storage: 0.9 })(q),
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
    expect(Object.keys(client.lastQuestions!)).toEqual(
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
    const client: JevClient = {
      calls: 0,
      ask(): Promise<JevAskResult> {
        (client as unknown as { calls: number }).calls += 1;
        return new Promise<JevAskResult>((resolve) => {
          release = () => resolve({ answers: {}, usage: null, model: 'slow', latencyMs: 1 });
        });
      },
    } as JevClient & { calls: number };
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '' });
    const world = handoffWorld();

    stepOnce(world, ctl);
    await alignToBeat(world, ctl);
    await step(world, ctl, BEAT * 3 + 1); // three beat boundaries pass
    expect((client as unknown as { calls: number }).calls).toBe(1);
    expect(ctl.beats).toBe(1);

    release!();
    await settleClient();
    await step(world, ctl, BEAT + 1);
    expect((client as unknown as { calls: number }).calls).toBe(2);
  });
});

describe('JevEnemyController — failure policy', () => {
  it('falls back to the rule-based AI after three consecutive failed beats, notifying once', async () => {
    const onFallback = vi.fn();
    const client = new ScriptedClient(() => new Error('503 from the proxy'));
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '', onFallback });
    const world = handoffWorld();

    stepOnce(world, ctl);
    await alignToBeat(world, ctl);

    // Two beat boundaries (T and T+BEAT) — two failures, still on Jev.
    await step(world, ctl, BEAT + 1);
    expect(ctl.failedBeats).toBe(2);
    expect(ctl.status).toBe('jev');
    expect(onFallback).not.toHaveBeenCalled();
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();

    // Third boundary: the third failure lands, but the status flip is a tick-seam
    // decision, not something the promise handler does.
    await step(world, ctl, BEAT);
    expect(ctl.failedBeats).toBe(3);
    expect(ctl.status).toBe('jev');
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();

    await step(world, ctl, 1);
    expect(ctl.status).toBe('fallback');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAIController)).toHaveBeenCalled();
    expect(vi.mocked(runAIController).mock.calls[0]![1]).toBe(ENEMY_COLONY_ID);

    // Sticky: the rule-based AI keeps driving and no further beats are attempted.
    const callsAtFallback = client.calls;
    vi.mocked(runAIController).mockClear();
    await step(world, ctl, BEAT * 2);
    expect(client.calls).toBe(callsAtFallback);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAIController).mock.calls.length).toBe(BEAT * 2);
  });

  it('a success resets the consecutive-failure streak', async () => {
    const onFallback = vi.fn();
    // Fail, fail, succeed, fail, fail — never three in a row.
    const client = new ScriptedClient((q, n) =>
      n === 2 ? scripted({})(q) : new Error('transient'),
    );
    const ctl = new JevEnemyController({ seats: SEATS, client, orders: '', onFallback });
    const world = handoffWorld();

    stepOnce(world, ctl);
    await alignToBeat(world, ctl);
    await step(world, ctl, BEAT * 4 + 1); // five beat boundaries

    expect(client.calls).toBe(5);
    expect(ctl.failedBeats).toBe(4);
    expect(ctl.status).toBe('jev');
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('counts a malformed 200 body as a failed beat instead of throwing', async () => {
    // A proxy that answers 200 with garbage must not be able to take the page
    // down from inside the promise handler.
    const client: JevClient = {
      ask: () =>
        Promise.resolve({
          answers: { ratio: null } as unknown as JevAnswerMap,
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
    expect(client.calls).toBe(0);
    expect(ctl.phase).toBe('opening');
    expect(vi.mocked(runAIController)).not.toHaveBeenCalled();
  });
});
