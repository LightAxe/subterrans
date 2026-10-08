// counter-attack-gate.test.ts — economy captions (Fable's review of #429): after a
// routed wave the counter-attack caption says "strike their nest now" only when the
// player's army can win (counterAttackArmyReady: at least
// COUNTER_ATTACK_READY_FIGHTERS fighters and COUNTER_ATTACK_READY_MARGIN more than the
// attacker's whole army). Otherwise it says to train more fighters, and the Assault
// copy follows the first tick the army is ready, unless the window lapses, the
// attacker invades or probes again, or a queen dies.
import { describe, it, expect } from 'vitest';
import {
  COUNTER_ATTACK_BUILD_UP_TEXT,
  COUNTER_ATTACK_CAPTION_TEXT,
  COUNTER_ATTACK_FOLLOW_UP_TICKS,
  COUNTER_ATTACK_READY_FIGHTERS,
  COUNTER_ATTACK_READY_MARGIN,
  counterAttackArmyReady,
  createCounterAttackCaptionState,
  noteCounterAttackEvent,
  noteCounterAttackTick,
  offerCounterAttackCaption,
  type CounterAttackCaptionState,
} from './counter-attack-caption.js';
import { createRampageCaptionState, type RecurringCaptionSink } from './recurring-captions.js';
import { createQueenDangerState } from './queen-danger.js';
import { createEnemyQueenWoundState } from './enemy-queen-wound.js';
import { beforeSimTick } from './sim-tick-hook.js';
import { createGameLoop, MS_PER_TICK } from '../platform/game-loop.js';
import { GameOutcome } from '../sim/game-over.js';
import type { SimEvent } from '../sim/telemetry.js';
import type { WorldState } from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { createDefaultAIStateRecord, getAIStateForColony } from '../sim/ai-state.js';
import { addFighter } from '../sim/raid-test-utils.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
const READY = COUNTER_ATTACK_READY_FIGHTERS;
const MARGIN = COUNTER_ATTACK_READY_MARGIN;

function setTick(w: WorldState, t: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
  w.tick = t;
}

/** A Normal match at tick 2000 with `mine` player fighters and `theirs` enemy ones,
 *  the enemy AI in Recovery. */
function world(mine: number, theirs: number): WorldState {
  const w = createScenario(7, 'Normal');
  setTick(w, 2000);
  if (getAIStateForColony(w, E) === null) w.aiState.push(createDefaultAIStateRecord(E));
  getAIStateForColony(w, E)!.state = 'Recovery';
  for (let i = 0; i < mine; i++) addFighter(w, P, 5, 5, null);
  for (let i = 0; i < theirs; i++) addFighter(w, E, 90, 5, null);
  return w;
}

/** The rout of an enemy wave at `t` with its army then `fighters` (broken on Normal). */
function rout(s: CounterAttackCaptionState, w: WorldState, t: number, fighters = 4): void {
  const evs: SimEvent[] = [
    {
      tick: t,
      type: 'invasion_end',
      payload: { colonyId: E, outcome: 'fighter_rout', attackerLosses: 20, defenderLosses: 18 },
    },
    {
      tick: t,
      type: 'ai_state_transition',
      payload: {
        colonyId: E,
        from: 'Invading',
        to: 'Recovery',
        triggerValues: { aiFighterCount: fighters },
      },
    } as SimEvent,
  ];
  for (const ev of evs) noteCounterAttackEvent(s, ev, w, P);
}

function sink(): RecurringCaptionSink & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    captionQueueIdle: () => true,
    showCaption: (t: string) => {
      shown.push(t);
      return true;
    },
  };
}

describe('counterAttackArmyReady', () => {
  it('needs READY fighters and MARGIN more than their whole army', () => {
    expect(counterAttackArmyReady(world(READY, READY - MARGIN), P, E)).toBe(true);
    expect(counterAttackArmyReady(world(READY - 1, 0), P, E)).toBe(false);
    expect(counterAttackArmyReady(world(READY, READY - MARGIN + 1), P, E)).toBe(false);
    expect(counterAttackArmyReady(world(READY + 10, READY + 10 - MARGIN), P, E)).toBe(true);
  });
});

describe('the gated counter-attack caption', () => {
  it('a ready army gets the Assault copy, and nothing follows', () => {
    const w = world(READY + 4, 2);
    const s = createCounterAttackCaptionState();
    rout(s, w, 2000);
    const ui = sink();
    expect(offerCounterAttackCaption(s, w, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_CAPTION_TEXT]);
    expect(s.buildUpTick).toBeNull();
  });

  it('an army not ready gets the build-up copy; the Assault copy follows once it is', () => {
    const w = world(5, 6);
    const s = createCounterAttackCaptionState();
    rout(s, w, 2000);
    const ui = sink();
    expect(offerCounterAttackCaption(s, w, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT]);
    expect(s.buildUpTick).toBe(2000);
    // still short: nothing owed
    setTick(w, 2600);
    noteCounterAttackTick(s, w, P);
    expect(s.owedRoutTick).toBeNull();
    // trained up to the gate
    for (let i = 0; i < READY + 6 - 5; i++) addFighter(w, P, 5, 5, null);
    setTick(w, 2601);
    noteCounterAttackTick(s, w, P);
    expect(s.owedRoutTick).toBe(2601);
    expect(offerCounterAttackCaption(s, w, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT, COUNTER_ATTACK_CAPTION_TEXT]);
    expect(s.buildUpTick).toBeNull();
  });

  it('the follow-up takes the Assault copy even if the army dips before it shows, so the build-up copy shows once', () => {
    const w = world(5, 6);
    const s = createCounterAttackCaptionState();
    rout(s, w, 2000);
    const ui = sink();
    offerCounterAttackCaption(s, w, P, ui, 0, 0);
    const added: number[] = [];
    for (let i = 0; i < READY + 6; i++) added.push(addFighter(w, P, 5, 5, null));
    setTick(w, 2100);
    noteCounterAttackTick(s, w, P);
    expect(s.owedRoutTick).toBe(2100);
    // a busy queue, then the army falls below the gate before the queue is idle
    for (const id of added) w.ants.alive[id] = 0;
    setTick(w, 2110);
    expect(offerCounterAttackCaption(s, w, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT, COUNTER_ATTACK_CAPTION_TEXT]);
    expect(s.buildUpTick).toBeNull();
  });

  it('a new rout takes its copy afresh (a ready army: the Assault copy, the old follow-up gone)', () => {
    const w = world(5, 6);
    const s = createCounterAttackCaptionState();
    rout(s, w, 2000);
    const ui = sink();
    offerCounterAttackCaption(s, w, P, ui, 0, 0);
    expect(s.buildUpTick).toBe(2000);
    for (let i = 0; i < READY + 6; i++) addFighter(w, P, 5, 5, null);
    setTick(w, 4000);
    rout(s, w, 4000);
    expect(offerCounterAttackCaption(s, w, P, ui, 0, 0)).toBe(true);
    expect(ui.shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT, COUNTER_ATTACK_CAPTION_TEXT]);
    expect(s.buildUpTick).toBeNull();
    setTick(w, 4001);
    noteCounterAttackTick(s, w, P);
    expect(s.owedRoutTick).toBeNull();
  });

  it('the follow-up holds to the last tick of its window, and lapses after it', () => {
    for (const [at, owed] of [
      [2000 + COUNTER_ATTACK_FOLLOW_UP_TICKS, true],
      [2000 + COUNTER_ATTACK_FOLLOW_UP_TICKS + 1, false],
    ] as const) {
      const w = world(5, 6);
      const s = createCounterAttackCaptionState();
      rout(s, w, 2000);
      offerCounterAttackCaption(s, w, P, sink(), 0, 0);
      for (let i = 0; i < 20; i++) addFighter(w, P, 5, 5, null);
      setTick(w, at);
      noteCounterAttackTick(s, w, P);
      expect(s.owedRoutTick).toBe(owed ? at : null);
      expect(s.buildUpTick).toBeNull();
    }
  });

  it('the follow-up lapses once the attacker invades or probes again', () => {
    for (const st of ['Invading', 'Probing'] as const) {
      const w = world(5, 6);
      const s = createCounterAttackCaptionState();
      rout(s, w, 2000);
      offerCounterAttackCaption(s, w, P, sink(), 0, 0);
      getAIStateForColony(w, E)!.state = st;
      for (let i = 0; i < 20; i++) addFighter(w, P, 5, 5, null);
      setTick(w, 2100);
      noteCounterAttackTick(s, w, P);
      expect(s.owedRoutTick).toBeNull();
      expect(s.buildUpTick).toBeNull();
    }
  });

  it('the follow-up holds through Peacetime and WarFooting', () => {
    for (const st of ['Peacetime', 'WarFooting'] as const) {
      const w = world(5, 6);
      const s = createCounterAttackCaptionState();
      rout(s, w, 2000);
      offerCounterAttackCaption(s, w, P, sink(), 0, 0);
      getAIStateForColony(w, E)!.state = st;
      for (let i = 0; i < 20; i++) addFighter(w, P, 5, 5, null);
      setTick(w, 2100);
      noteCounterAttackTick(s, w, P);
      expect(s.owedRoutTick).toBe(2100);
    }
  });

  it('the follow-up lapses once either queen is dead', () => {
    for (const cid of [P, E]) {
      const w = world(5, 6);
      const s = createCounterAttackCaptionState();
      rout(s, w, 2000);
      offerCounterAttackCaption(s, w, P, sink(), 0, 0);
      w.ants.alive[w.colonies[cid]!.queenEntityId] = 0;
      for (let i = 0; i < 20; i++) addFighter(w, P, 5, 5, null);
      setTick(w, 2100);
      noteCounterAttackTick(s, w, P);
      expect(s.owedRoutTick).toBeNull();
    }
  });

  it('a world that went back drops the follow-up', () => {
    const w = world(5, 6);
    const s = createCounterAttackCaptionState();
    rout(s, w, 2000);
    offerCounterAttackCaption(s, w, P, sink(), 0, 0);
    for (let i = 0; i < 20; i++) addFighter(w, P, 5, 5, null);
    setTick(w, 1999);
    noteCounterAttackTick(s, w, P);
    expect(s.owedRoutTick).toBeNull();
    expect(s.buildUpTick).toBeNull();
  });
});

describe('the follow-up is decided per sim tick, however the ticks are batched', () => {
  // The army is ready from tick N (fighters added by the sim tick that ends there),
  // and the attacker probes from N + 2: the look before each sim tick owes the Assault
  // copy at N, whether those ticks run as one render frame or one per frame; a look
  // only at each frame's end would see the probe first and lapse it.
  const N = 2003;
  function play(frames: readonly number[]): { s: CounterAttackCaptionState; w: WorldState } {
    const w = world(5, 6);
    const prev = createScenario(7, 'Normal');
    const s = createCounterAttackCaptionState();
    rout(s, w, 2000);
    offerCounterAttackCaption(s, w, P, sink(), 0, 0);
    expect(s.buildUpTick).toBe(2000);
    const loop = createGameLoop(
      (wd) => {
        const next = wd.tick + 1;
        if (next === N) for (let i = 0; i < READY + 6; i++) addFighter(wd, P, 5, 5, null);
        if (next === N + 2) getAIStateForColony(wd, E)!.state = 'Probing';
        setTick(wd, next);
        return GameOutcome.None;
      },
      w,
      {
        onBeforeTick: (wd) =>
          beforeSimTick(
            wd,
            [],
            createRampageCaptionState(),
            P,
            prev,
            createQueenDangerState(),
            createEnemyQueenWoundState(),
            s,
          ),
      },
    );
    for (const n of frames) {
      loop.update(n * MS_PER_TICK);
      noteCounterAttackTick(s, w, P); // GameScene's own look, for the frame's last tick
    }
    expect(w.tick).toBe(2000 + frames.reduce((a, b) => a + b, 0));
    return { s, w };
  }

  it('one frame of five ticks, or five of one: owed at N either way', () => {
    for (const frames of [[5], [1, 1, 1, 1, 1], [2, 3]]) {
      const { s } = play(frames);
      expect(s.owedRoutTick).toBe(N);
      expect(s.owedFollowUp).toBe(true);
      expect(s.buildUpTick).toBeNull();
    }
  });

  it('a second look at the same tick changes nothing', () => {
    const { s, w } = play([5]);
    const before = { ...s };
    noteCounterAttackTick(s, w, P);
    noteCounterAttackTick(s, w, P);
    expect(s).toEqual(before);
  });
});
