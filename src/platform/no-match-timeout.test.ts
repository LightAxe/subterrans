// #376 (V67) — no match timeout, through the whole tick.
//
// Up to V66 a match with both queens alive at MATCH_TIMEOUT_TICKS (24 000) ended
// there, won by living worker count. From V67 it goes on until a queen dies. Running
// a real match to tick 24 000 takes seconds per seed, so each world here is a fresh
// scenario moved to just before the old cap (its hunger clocks moved with it, as a
// real long session would have them), then played with the enemy AI through it.
//
// Pins:
//   - a new (V67) world crosses the old cap with no outcome and no round_end, and
//     then ends the ordinary way, when a queen dies — with that death's end-screen
//     copy, never the timeout's;
//   - a V66 world still ends on the tick it always did, won by worker count, with
//     the timeout copy;
//   - save/load exactly at the old cap: a V67 world plays on byte-identically to
//     the unsaved one (the V66-save arm was retired by #400: MIN_ACCEPTED is V71);
//   - control: a queen death long before the old cap still ends a V67 match.
//
// #388 — such a long match can fill the 2000-event telemetry buffer with structural
// events. The event that ends it must still be recorded: with the buffer full, a
// queen death still gives the end screen its cause and narrative and the playtrace
// its roundEndReason, and a stalemate its narrative and roundEndReason.
//
// #389 — the end screen's cause line (the survey's line; the GameOver overlay's
// fallback when there is no narrative) names how the match really ended — a
// stalemate or timeout with both queens alive is never "both queens died" — even
// with the event that ended it lost.
import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import {
  allocateEntityId,
  LATEST_SIM_VERSION,
  SIM_VERSION_V66_QUEEN_STARVES_HP,
  SIM_VERSION_V67_NO_MATCH_TIMEOUT,
  type WorldState,
} from '../sim/types.js';
import {
  ENEMY_COLONY_ID,
  MATCH_TIMEOUT_TICKS,
  PLAYER_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../sim/constants.js';
import { GameOutcome } from '../sim/game-over.js';
import { QUEEN_HUNGER } from '../sim/hunger.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { AntTask } from '../sim/enums.js';
import {
  setColonyFoodForTest,
  setMealsUntilStarvationForTest,
  setPilesForTest,
} from '../sim/food/food-test-utils.js';
import { emitEvent, PLAYTRACE_EVENT_CAP_PER_ROUND } from '../sim/telemetry.js';
import { runAIController } from '../render/ai-controller.js';
import { buildOutcomeAttribution, buildPlaytraceSummary } from '../render/summary-builder.js';
import { buildPlaytraceEnvelope } from '../render/playtrace-upload.js';
import {
  formatCauseSubtitle,
  formatOutcomeTitle,
  queenDeathCauseAt,
  roundEndReasonAt,
} from '../render/ui-scene-logic.js';
import { hashWorldState } from './world-hash.js';
import { deserializeWorldState, serializeWorldState } from './save.js';

const V66 = SIM_VERSION_V66_QUEEN_STARVES_HP; // the last version with the Timeout
/** Where each world starts: 40 ticks short of the old cap. */
const START_TICK = MATCH_TIMEOUT_TICKS - 40;
/** Copy that only the timeout's end screen uses. */
const TIMEOUT_COPY = /timed out|time ran out/i;

/**
 * A fresh scenario at `simVersion` (LATEST when omitted), moved to START_TICK, with
 * one extra player worker so the worker count has a winner (the player). The
 * queens and workers are just fed, as they would be in a long session. Other
 * tick-stamped clocks stay at 0, so schedules keyed on elapsed time (eggs, the
 * spider, the AI's minimum ticks) all come due at once: an unrealistic world, but
 * every near-cap V67 case here has a V66 twin on the same seed and fixture, so the
 * A/B holds.
 */
function worldNearOldCap(seed: number, simVersion?: number): WorldState {
  const world = createScenario(seed, 'Normal');
  if (simVersion !== undefined) world.simVersion = simVersion;
  const player = world.colonies[PLAYER_COLONY_ID]!;
  const twin = player.workers[0]!; // the extra worker starts where this one stands
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX: world.ants.posX[twin]!,
    posY: world.ants.posY[twin]!,
    task: AntTask.Idle,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    zone: world.ants.zone[twin]!,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  player.workers.push(id);
  player.workerCount += 1;
  // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
  world.tick = START_TICK;
  for (const c of Object.values(world.colonies)) {
    setMealsUntilStarvationForTest(world, c.queenEntityId, QUEEN_HUNGER, 300);
    for (const w of c.workers) world.ants.lastMealTick[w] = world.tick - 1;
  }
  return world;
}

/** One tick with the enemy AI; returns tick()'s outcome. */
function step(world: WorldState): GameOutcome {
  runAIController(world, ENEMY_COLONY_ID);
  return tick(world, world.commandQueue.splice(0));
}

function livingWorkers(world: WorldState, cid: number): number {
  return world.colonies[cid]!.workers.filter((id) => world.ants.alive[id] === 1).length;
}

function roundEnds(world: WorldState): number {
  return world.events.filter((e) => e.type === 'round_end').length;
}

/** Save/load through JSON, as an autosave round-trip does. */
function saveLoad(world: WorldState): WorldState {
  return deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(world))));
}

describe('#376 V67 — a match has no time limit (whole tick)', () => {
  it('a new world plays through the old cap with no outcome, then ends when a queen starves', () => {
    const world = worldNearOldCap(7);
    expect(world.simVersion).toBe(LATEST_SIM_VERSION);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V67_NO_MATCH_TIMEOUT);
    // Through the old cap and well past it: nothing ends the match.
    while (world.tick < MATCH_TIMEOUT_TICKS + 200) {
      expect(step(world), `tick ${world.tick}`).toBe(GameOutcome.None);
    }
    expect(roundEnds(world)).toBe(0);
    // Non-vacuity: both queens alive and a worker-count winner, so a V66 world
    // would have ended at the cap (the V66 test below).
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      expect(world.ants.alive[world.colonies[cid]!.queenEntityId], `queen ${cid}`).toBe(1);
    }
    expect(livingWorkers(world, PLAYER_COLONY_ID)).toBeGreaterThan(
      livingWorkers(world, ENEMY_COLONY_ID),
    );
    // Starve the enemy: the match ends the ordinary way, on her death.
    let outcome: GameOutcome = GameOutcome.None;
    const deadline = world.tick + 400;
    while (outcome === GameOutcome.None && world.tick < deadline) {
      setColonyFoodForTest(world, world.colonies[ENEMY_COLONY_ID]!, 0);
      outcome = step(world);
    }
    expect(outcome).toBe(GameOutcome.Victory);
    expect(world.ants.alive[world.colonies[ENEMY_COLONY_ID]!.queenEntityId]).toBe(0);
    expect(roundEnds(world)).toBe(0);
    // The end screen tells the queen's death, never the timeout.
    const attribution = buildOutcomeAttribution(world.events, 'Victory');
    expect(attribution.primaryCause).toBe('Starvation');
    expect(attribution.narrativeSeed).toBe(
      'The enemy queen starved after their colony ran out of food.',
    );
    expect(attribution.narrativeSeed).not.toMatch(TIMEOUT_COPY);
  }, 60_000);

  it('a V66 world still ends at the cap, won by worker count, with the timeout copy', () => {
    const world = worldNearOldCap(7, V66);
    let outcome: GameOutcome = GameOutcome.None;
    let endTick = -1;
    while (world.tick < MATCH_TIMEOUT_TICKS + 5) {
      outcome = step(world);
      if (outcome !== GameOutcome.None) {
        endTick = world.tick;
        break;
      }
    }
    // The tick run with world.tick === MATCH_TIMEOUT_TICKS ends it; tick() has
    // advanced the counter by one on return.
    expect(endTick).toBe(MATCH_TIMEOUT_TICKS + 1);
    expect(outcome).toBe(GameOutcome.Victory);
    const ev = world.events.find((e) => e.type === 'round_end');
    expect(ev?.type === 'round_end' && ev.payload).toEqual({
      reason: 'TimeoutTiebreak',
      playerWorkerCount: livingWorkers(world, PLAYER_COLONY_ID),
      aiWorkerCount: livingWorkers(world, ENEMY_COLONY_ID),
    });
    const attribution = buildOutcomeAttribution(world.events, 'Victory');
    expect(attribution.primaryCause).toBe('TimeoutTiebreak');
    expect(attribution.narrativeSeed).toBe('The round timed out; your colony outlasted the enemy.');
  }, 60_000);

  it('save/load exactly at the old cap: a V67 world plays on byte-identically, with no outcome', () => {
    const world = worldNearOldCap(11);
    while (world.tick < MATCH_TIMEOUT_TICKS) step(world);
    const loaded = saveLoad(world);
    expect(loaded.simVersion).toBe(world.simVersion); // sticky
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
    while (world.tick < MATCH_TIMEOUT_TICKS + 100) {
      expect(step(world), `live tick ${world.tick}`).toBe(GameOutcome.None);
      expect(step(loaded), `loaded tick ${loaded.tick}`).toBe(GameOutcome.None);
      if (world.tick % 10 === 0) {
        expect(hashWorldState(loaded), `tick ${world.tick}`).toBe(hashWorldState(world));
      }
    }
    expect(roundEnds(world)).toBe(0);
    expect(roundEnds(loaded)).toBe(0);
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      expect(loaded.ants.alive[loaded.colonies[cid]!.queenEntityId], `queen ${cid}`).toBe(1);
    }
  }, 60_000);

  // (#400 retired 'a V66 save loaded at the old cap still times out': MIN_ACCEPTED is
  // V71, so no V66 save loads.)

  it('control: a queen death well before the old cap ends a V67 match, with no timeout copy', () => {
    const world = worldNearOldCap(7);
    // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick
    world.tick = 5000;
    for (const c of Object.values(world.colonies)) {
      setMealsUntilStarvationForTest(world, c.queenEntityId, QUEEN_HUNGER, 300);
      for (const w of c.workers) world.ants.lastMealTick[w] = world.tick - 1;
    }
    let outcome: GameOutcome = GameOutcome.None;
    while (outcome === GameOutcome.None && world.tick < 5400) {
      setColonyFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 0);
      outcome = step(world);
    }
    expect(outcome).toBe(GameOutcome.Defeat);
    const attribution = buildOutcomeAttribution(world.events, 'Defeat');
    expect(attribution.narrativeSeed).not.toMatch(TIMEOUT_COPY);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #388 — a full telemetry buffer still records how the match ended
// ---------------------------------------------------------------------------

/** Fill the buffer to its cap with non-terminal structural events from a past tick. */
function fillEventBuffer(world: WorldState): void {
  while (world.events.length < PLAYTRACE_EVENT_CAP_PER_ROUND) {
    emitEvent(world, {
      tick: 1000,
      type: 'spider_hunt_start',
      payload: { reticleTile: { x: 1, y: 1, grid: 'surface' }, targetWorkers: 0 },
    });
  }
}

/** What the game-over screen and the playtrace upload read, built as game-scene builds them. */
function endOfMatchView(
  world: WorldState,
  outcome: GameOutcome,
): {
  title: string;
  subtitle: string;
  narrative: string | null;
  roundEndReason: string | null;
  droppedStructural: number;
} {
  const label =
    outcome === GameOutcome.Victory
      ? 'Victory'
      : outcome === GameOutcome.Defeat
        ? 'Defeat'
        : 'MutualDestruction';
  const deathTick = world.tick - 1;
  const cause = queenDeathCauseAt(world.events, deathTick);
  const reason = roundEndReasonAt(world, deathTick, outcome);
  const summary = buildPlaytraceSummary(world, false, label);
  const envelope = buildPlaytraceEnvelope(
    {
      endpoint: '/api/playtrace',
      sessionId: 'test',
      outcome,
      quitFromPauseMenu: false,
      includeSnapshot: false,
      world,
      seed: 7,
      inputLog: [],
      survey: { rating: 5, freeText: '', brokenFlag: false },
      resumedFromSave: false,
    },
    null,
    world.events.slice(),
    summary,
  );
  return {
    title: formatOutcomeTitle(outcome, reason).text,
    subtitle: formatCauseSubtitle(outcome, cause, reason),
    narrative: summary.outcomeAttribution.narrativeSeed,
    roundEndReason: envelope.roundEndReason,
    droppedStructural: summary.eventOverflow.droppedStructural,
  };
}

describe('#388 — a full event buffer still records the end of the match', () => {
  it('a queen death after the buffer filled: cause, narrative and roundEndReason survive', () => {
    const world = worldNearOldCap(7);
    fillEventBuffer(world);
    while (world.tick < MATCH_TIMEOUT_TICKS + 50) step(world); // play on with it full
    let outcome: GameOutcome = GameOutcome.None;
    const deadline = world.tick + 400;
    while (outcome === GameOutcome.None && world.tick < deadline) {
      setColonyFoodForTest(world, world.colonies[ENEMY_COLONY_ID]!, 0);
      outcome = step(world);
    }
    expect(outcome).toBe(GameOutcome.Victory);
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
    const view = endOfMatchView(world, outcome);
    expect(view.droppedStructural).toBeGreaterThan(0); // the buffer really overflowed
    expect(view.subtitle).toBe('Their queen starved');
    expect(view.narrative).toBe('The enemy queen starved after their colony ran out of food.');
    expect(view.roundEndReason).toBe('QueenDeath');
  }, 60_000);

  it('a stalemate after the buffer filled: its narrative and roundEndReason survive', () => {
    const world = worldNearOldCap(7);
    setPilesForTest(world, []);
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      setColonyFoodForTest(world, world.colonies[cid]!, 0);
    }
    fillEventBuffer(world);
    const outcome = step(world);
    expect(outcome).toBe(GameOutcome.MutualDestruction);
    expect(world.events).toHaveLength(PLAYTRACE_EVENT_CAP_PER_ROUND);
    const view = endOfMatchView(world, outcome);
    expect(view.droppedStructural).toBeGreaterThan(0);
    expect(view.narrative).toBe('Both colonies ran out of food and the round ended in a draw.');
    expect(view.roundEndReason).toBe('StalemateTiebreak');
    // #389 — the cause line (the survey's, and the GameOver fallback) says so too.
    expect(view.subtitle).toBe('Both colonies ran out of food — a draw');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #389 — the end screen's cause line keys off how the match really ended
// ---------------------------------------------------------------------------

/** Drop every terminal event, as a buffer that lost the one that ended the match. */
function loseTerminalEvents(world: WorldState): void {
  const kept = world.events.filter((e) => e.type !== 'round_end' && e.type !== 'queen_death');
  world.events.length = 0;
  world.events.push(...kept);
}

describe('#389 — the end-screen title and cause line name the real round-end reason', () => {
  it('a stalemate: a draw for want of food, with both queens alive — and still so with its round_end lost', () => {
    const world = worldNearOldCap(7);
    setPilesForTest(world, []);
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      setColonyFoodForTest(world, world.colonies[cid]!, 0);
    }
    const outcome = step(world);
    expect(outcome).toBe(GameOutcome.MutualDestruction);
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      expect(world.ants.alive[world.colonies[cid]!.queenEntityId], `queen ${cid}`).toBe(1);
    }
    expect(endOfMatchView(world, outcome).subtitle).toBe('Both colonies ran out of food — a draw');
    expect(endOfMatchView(world, outcome).title).toBe('DRAW');
    // The issue's case: no narrative, so the GameOver overlay falls back to the
    // cause line — which must not claim the (living) queens died.
    loseTerminalEvents(world);
    const view = endOfMatchView(world, outcome);
    expect(view.narrative).toBeNull();
    expect(view.subtitle).toBe('Both colonies ran out of food — a draw');
    expect(view.title).toBe('DRAW');
  }, 60_000);

  it('a double queen death: both queens died at the same time — with or without its events', () => {
    const world = worldNearOldCap(7);
    let outcome: GameOutcome = GameOutcome.None;
    const deadline = world.tick + 400;
    while (outcome === GameOutcome.None && world.tick < deadline) {
      for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
        setColonyFoodForTest(world, world.colonies[cid]!, 0);
      }
      outcome = step(world);
    }
    expect(outcome).toBe(GameOutcome.MutualDestruction);
    for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      expect(world.ants.alive[world.colonies[cid]!.queenEntityId], `queen ${cid}`).toBe(0);
    }
    expect(roundEnds(world)).toBe(0);
    const view = endOfMatchView(world, outcome);
    expect(view.roundEndReason).toBe('QueenDeath');
    expect(view.title).toBe('MUTUAL DESTRUCTION');
    expect(view.subtitle).toBe('Both queens died at the same time');
    // They starved — the narrative names no fight.
    expect(view.narrative).toBe('Both queens died at the same time.');
    loseTerminalEvents(world);
    expect(endOfMatchView(world, outcome).subtitle).toBe('Both queens died at the same time');
    expect(endOfMatchView(world, outcome).title).toBe('MUTUAL DESTRUCTION');
  }, 60_000);

  it('a single queen death: her cause; with the event lost, no line rather than a draw', () => {
    const world = worldNearOldCap(7);
    let outcome: GameOutcome = GameOutcome.None;
    const deadline = world.tick + 400;
    while (outcome === GameOutcome.None && world.tick < deadline) {
      setColonyFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 0);
      outcome = step(world);
    }
    expect(outcome).toBe(GameOutcome.Defeat);
    expect(endOfMatchView(world, outcome).subtitle).toBe('Your queen starved');
    loseTerminalEvents(world);
    expect(endOfMatchView(world, outcome).subtitle).toBe('');
  }, 60_000);

  it('a V66 timeout: says time ran out — and still so with its round_end lost', () => {
    const world = worldNearOldCap(7, V66);
    let outcome: GameOutcome = GameOutcome.None;
    while (outcome === GameOutcome.None && world.tick <= MATCH_TIMEOUT_TICKS) outcome = step(world);
    expect(outcome).toBe(GameOutcome.Victory); // the player has the extra worker
    expect(endOfMatchView(world, outcome).subtitle).toBe(
      'Time ran out — your colony had more workers',
    );
    loseTerminalEvents(world);
    const view = endOfMatchView(world, outcome);
    expect(view.narrative).toBeNull();
    expect(view.subtitle).toBe('Time ran out — your colony had more workers');
  }, 60_000);
});
