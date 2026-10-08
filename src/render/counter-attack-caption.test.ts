// counter-attack-caption.test.ts — playtest 4: "Their army is broken — strike their
// nest now! …" shows once for each fighter rout of a wave launched at the player's
// colony (an invasion_end with outcome 'fighter_rout') that leaves the attacker's
// whole army below its tier's base invasion need (the same-tick Invading → Recovery
// ai_state_transition's aiFighterCount); never for a timeout, a pre-cohort ending or a
// queen kill; never within the cooldown of the last rout it was owed for; never once
// the match is over, nor once the player is already giving that Assault order. Which
// routs owe it is decided on the events' own tick, so it is the same however the game
// loop batches the ticks into frames.

import { describe, it, expect } from 'vitest';
import {
  COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS,
  COUNTER_ATTACK_CAPTION_HOLD_MS,
  COUNTER_ATTACK_CAPTION_OWED_TICKS,
  COUNTER_ATTACK_CAPTION_TEXT,
  COUNTER_ATTACK_BUILD_UP_TEXT,
  COUNTER_ATTACK_READY_FIGHTERS,
  armyBroken,
  counterAttackCaptionOwed,
  counterAttackCaptionStale,
  createCounterAttackCaptionState,
  noteCounterAttackEvent,
  offerCounterAttackCaption,
  routedWaveAttacker,
  type CounterAttackCaptionState,
} from './counter-attack-caption.js';
import {
  admitCaption,
  CAPTION_HOLD_MS,
  completeCaption,
  createCaptionQueueState,
  recurringCaptionMayEnter,
  type CaptionQueueState,
} from './caption-queue.js';
import type { CaptionKey } from './onboarding-captions.js';
import type { RecurringCaptionSink } from './recurring-captions.js';
import { createGameLoop, MAX_CATCHUP_TICKS, MS_PER_TICK } from '../platform/game-loop.js';
import type { SimEvent } from '../sim/telemetry.js';
import type { WorldState } from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { GameOutcome } from '../sim/game-over.js';
import { createDefaultAIStateRecord } from '../sim/ai-state.js';
import { despawnAnt } from '../sim/ant-death.js';
import { RaidType } from '../sim/enums.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';
import { CommandProjection } from './command-projection.js';
import {
  AI_INVADING_FIGHTER_THRESHOLD,
  AI_INVADING_TIMEOUT_TICKS,
  AI_RECOVERY_DURATION_TICKS,
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
} from '../sim/constants.js';

/** A stand-in for UIScene over the real caption queue: showCaption admits an event
 *  caption exactly as UIScene.enqueueCaption does (with its hold), and records what
 *  began and what the queue dropped. */
class FakeUi implements RecurringCaptionSink {
  readonly q: CaptionQueueState = createCaptionQueueState();
  readonly begun: { text: string; holdMs: number | undefined }[] = [];
  readonly dropped: string[] = [];
  showCaption(
    text: string,
    _x: number,
    _y: number,
    captionKey?: CaptionKey,
    holdMs?: number,
  ): boolean {
    const r = admitCaption(this.q, {
      text,
      x: 0,
      y: 0,
      source: 'event',
      captionKey,
      ...(holdMs === undefined ? {} : { holdMs }),
    });
    if (r.begin) this.begun.push({ text: r.begin.text, holdMs: r.begin.holdMs });
    if (r.dropped) this.dropped.push(r.dropped.text);
    return r.dropped === undefined;
  }
  captionQueueIdle(): boolean {
    return recurringCaptionMayEnter(this.q);
  }
  /** The active caption finished its fade. */
  finish(): void {
    const r = completeCaption(this.q);
    if (r.begin) this.begun.push({ text: r.begin.text, holdMs: r.begin.holdMs });
  }
  shown(): string[] {
    return this.begun.map((b) => b.text);
  }
}

/** The world's clock, set by the test (the sim never runs in most cases here). */
function setTick(w: WorldState, t: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock: the scripted tick
  w.tick = t;
}

const LOSSES = { attackerLosses: 20, defenderLosses: 18 };
/** The base invasion need on Normal (freshWorld's tier). */
const NORMAL_NEED = AI_INVADING_FIGHTER_THRESHOLD[1];

/** An invasion by `colonyId` ending with `outcome` on `tick`. */
function invasionEnd(
  tick: number,
  outcome: 'fighter_rout' | 'timeout' | 'queen_kill',
  colonyId = ENEMY_COLONY_ID,
): SimEvent {
  return { tick, type: 'invasion_end', payload: { colonyId, outcome, ...LOSSES } };
}

/** `colonyId` going from Invading to Recovery on `tick` with `fighters` alive: what the
 *  AI step emits right after an invasion_end, or alone for a pre-cohort timeout. */
function toRecovery(tick: number, colonyId = ENEMY_COLONY_ID, fighters = 4): SimEvent {
  return {
    tick,
    type: 'ai_state_transition',
    payload: {
      colonyId,
      from: 'Invading',
      to: 'Recovery',
      triggerValues: {
        aiFighterCount: fighters,
        aiFoodStored: 0,
        aiFoodCap: 0,
        playerWorkerCount: 9,
      },
    },
  };
}

/** A fighter rout as the AI step emits it: the invasion_end, then the transition. */
const routed = (tick: number, fighters = 4, colonyId = ENEMY_COLONY_ID): SimEvent[] => [
  invasionEnd(tick, 'fighter_rout', colonyId),
  toRecovery(tick, colonyId, fighters),
];

function invasionStart(tick: number, colonyId = ENEMY_COLONY_ID): SimEvent {
  return {
    tick,
    type: 'invasion_start',
    payload: {
      colonyId,
      rallyTile: { x: 24, y: 64, grid: 'surface' },
      fighterCount: 24,
      targetGrid: colonyId === ENEMY_COLONY_ID ? PLAYER_COLONY_ID : ENEMY_COLONY_ID,
    },
  };
}

/** GameScene's event drain over `events`, in order. */
function noteAll(
  s: CounterAttackCaptionState,
  events: readonly SimEvent[],
  world: WorldState,
  viewer = PLAYER_COLONY_ID,
): void {
  for (const ev of events) noteCounterAttackEvent(s, ev, world, viewer);
}

/** The frame step at world tick `t`: offer the owed caption to `ui`. */
function offerAt(
  s: CounterAttackCaptionState,
  world: WorldState,
  t: number,
  ui: RecurringCaptionSink,
  viewer = PLAYER_COLONY_ID,
): boolean {
  setTick(world, t);
  return offerCounterAttackCaption(s, world, viewer, ui, 400, 60);
}

/** A fresh two-colony Normal match (both queens alive) at tick 2000, the player's army
 *  ready to strike (COUNTER_ATTACK_READY_FIGHTERS fighters, the enemy none), so the
 *  caption takes its Assault copy. The army gate and its "train more fighters" copy are
 *  in counter-attack-gate.test.ts. */
function freshWorld(difficulty: 'Easy' | 'Normal' | 'Hard' = 'Normal'): WorldState {
  const w = createScenario(7, difficulty);
  setTick(w, 2000);
  for (let i = 0; i < COUNTER_ATTACK_READY_FIGHTERS; i++) {
    addFighter(w, PLAYER_COLONY_ID, 10, 10, null);
  }
  return w;
}

describe('routedWaveAttacker: which events are a wave routed at the viewer', () => {
  const world = freshWorld();

  it("an invasion of the viewer that ends in a fighter rout: its attacker's id", () => {
    expect(routedWaveAttacker(invasionEnd(1000, 'fighter_rout'), world, PLAYER_COLONY_ID)).toBe(
      ENEMY_COLONY_ID,
    );
  });

  it('not a timeout, a queen kill, a pre-cohort ending, or any other event', () => {
    for (const ev of [
      invasionEnd(1000, 'timeout'),
      invasionEnd(1000, 'queen_kill'),
      toRecovery(1000),
      invasionStart(1000),
    ]) {
      expect(routedWaveAttacker(ev, world, PLAYER_COLONY_ID)).toBeNull();
    }
  });

  it("not a wave of the viewer's own colony; the colony it invaded is told (CLNY-08)", () => {
    // A player-colony AI (the --both-ai harness) routed at the enemy's nest.
    const own = invasionEnd(1000, 'fighter_rout', PLAYER_COLONY_ID);
    expect(routedWaveAttacker(own, world, PLAYER_COLONY_ID)).toBeNull();
    expect(routedWaveAttacker(own, world, ENEMY_COLONY_ID)).toBe(PLAYER_COLONY_ID);
    expect(
      routedWaveAttacker(invasionEnd(1000, 'fighter_rout'), world, ENEMY_COLONY_ID),
    ).toBeNull();
  });

  it('with a third colony: only the colony a wave invaded is told (its opponent)', () => {
    // opponentColonyId: the lowest-id other colony. A third colony and the enemy both
    // invade the player; the player's own AI would invade the enemy.
    const THIRD = Math.max(PLAYER_COLONY_ID, ENEMY_COLONY_ID) + 1;
    const w3 = freshWorld();
    w3.colonies[THIRD] = { ...w3.colonies[ENEMY_COLONY_ID]!, colonyId: THIRD };
    const ev = invasionEnd(1000, 'fighter_rout', THIRD);
    expect(routedWaveAttacker(ev, w3, PLAYER_COLONY_ID)).toBe(THIRD);
    expect(routedWaveAttacker(ev, w3, ENEMY_COLONY_ID)).toBeNull();
    expect(routedWaveAttacker(ev, w3, THIRD)).toBeNull();
  });
});

describe('the caption fires once on a routed wave', () => {
  it('on an idle queue it shows on the first frame after the rout, with its long hold, once', () => {
    const world = freshWorld();
    const ui = new FakeUi();
    const s = createCounterAttackCaptionState();
    expect(counterAttackCaptionOwed(s)).toBe(false);
    noteAll(s, routed(2000), world);
    expect(counterAttackCaptionOwed(s)).toBe(true);
    expect(offerAt(s, world, 2001, ui)).toBe(true);
    expect(ui.begun).toEqual([
      { text: COUNTER_ATTACK_CAPTION_TEXT, holdMs: COUNTER_ATTACK_CAPTION_HOLD_MS },
    ]);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    ui.finish();
    for (let t = 2002; t < 2002 + COUNTER_ATTACK_CAPTION_OWED_TICKS + 50; t++) {
      expect(offerAt(s, world, t, ui)).toBe(false);
    }
    expect(ui.shown()).toEqual([COUNTER_ATTACK_CAPTION_TEXT]);
  });

  it('the copy says what to do: the raid menu Assault order, by mouse or touch', () => {
    expect(COUNTER_ATTACK_CAPTION_TEXT).toBe(
      'Their army is broken — strike their nest now! Assault: right-click or long-press their entrance.',
    );
    expect(COUNTER_ATTACK_CAPTION_HOLD_MS).toBeGreaterThan(CAPTION_HOLD_MS); // a long-hold caption
  });

  it('behind a busy queue it waits without taking the pending slot, then shows', () => {
    const world = freshWorld();
    const ui = new FakeUi();
    const s = createCounterAttackCaptionState();
    ui.showCaption('Your queen is in danger.', 0, 0, 'queenDamage');
    noteAll(s, routed(2000), world);
    expect(offerAt(s, world, 2001, ui)).toBe(false);
    expect(ui.q.pending).toBeNull(); // left free for a one-shot
    expect(counterAttackCaptionOwed(s)).toBe(true);
    // A one-shot arriving now keeps its slot (a recurring caption that took it would
    // make it overflow and be lost).
    expect(ui.showCaption('Fighters will converge here.', 0, 0, 'rally')).toBe(true);
    expect(offerAt(s, world, 2002, ui)).toBe(false);
    ui.finish(); // the danger caption ends; the rally caption shows
    expect(offerAt(s, world, 2010, ui)).toBe(false);
    ui.finish(); // the rally caption ends: idle
    expect(offerAt(s, world, 2030, ui)).toBe(true);
    expect(ui.shown()).toEqual([
      'Your queen is in danger.',
      'Fighters will converge here.',
      COUNTER_ATTACK_CAPTION_TEXT,
    ]);
    expect(ui.dropped).toEqual([]);
  });

  it('owed for COUNTER_ATTACK_CAPTION_OWED_TICKS: shown at the last tick of it', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const busy = new FakeUi();
    busy.showCaption('An enemy army is marching on your entrance.', 0, 0);
    noteAll(s, routed(2000), world);
    for (let t = 2001; t < 2000 + COUNTER_ATTACK_CAPTION_OWED_TICKS; t++) {
      expect(offerAt(s, world, t, busy)).toBe(false);
    }
    const idle = new FakeUi();
    expect(offerAt(s, world, 2000 + COUNTER_ATTACK_CAPTION_OWED_TICKS, idle)).toBe(true);
    expect(idle.shown()).toEqual([COUNTER_ATTACK_CAPTION_TEXT]);
  });

  it('dropped unshown once that window has passed', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    noteAll(s, routed(2000), world);
    setTick(world, 2000 + COUNTER_ATTACK_CAPTION_OWED_TICKS + 1);
    expect(counterAttackCaptionStale(s, world, PLAYER_COLONY_ID)).toBe(true);
    const idle = new FakeUi();
    expect(offerAt(s, world, 2000 + COUNTER_ATTACK_CAPTION_OWED_TICKS + 1, idle)).toBe(false);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(offerAt(s, world, 2000 + COUNTER_ATTACK_CAPTION_OWED_TICKS + 2, idle)).toBe(false);
    expect(idle.shown()).toEqual([]);
  });

  it('dropped unshown in a world that went back before the rout', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    noteAll(s, routed(2000), world);
    const idle = new FakeUi();
    expect(offerAt(s, world, 1999, idle)).toBe(false);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(idle.shown()).toEqual([]);
  });

  it('not for a timeout, a pre-cohort ending, a queen kill, or a wave of the viewer', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(
      s,
      [
        invasionStart(1500),
        // the timeout with its cohort standing: invasion_end, then the transition
        invasionEnd(1900, 'timeout'),
        toRecovery(1900),
        // a pre-cohort timeout: the transition alone
        toRecovery(2000),
        // a queen kill (the match is over)
        invasionEnd(2000, 'queen_kill'),
        toRecovery(2000),
        // the player's own wave, routed at the enemy's nest
        ...routed(2000, 4, PLAYER_COLONY_ID),
      ],
      world,
    );
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(s.lastRoutTick).toBeNull(); // nor do they start the cooldown
    for (let t = 2001; t < 2100; t++) expect(offerAt(s, world, t, ui)).toBe(false);
    expect(ui.shown()).toEqual([]);
  });

  it('a rout is decided by its own AI step: no same-tick transition of that colony, no caption', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    // The rout alone; a transition a tick later; one of another colony on its tick.
    noteAll(
      s,
      [
        invasionEnd(2000, 'fighter_rout'),
        toRecovery(2000, PLAYER_COLONY_ID),
        toRecovery(2001),
        // the next rout's transition comes before its invasion_end: not this AI step
        toRecovery(2400),
        invasionEnd(2400, 'fighter_rout'),
      ],
      world,
    );
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(s.lastRoutTick).toBeNull();
  });

  it("only the routed colony's very next AI event decides it, and only an Invading → Recovery", () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    /** A transition of the enemy on `tick` from `from` to `to`. */
    const transition = (
      tick: number,
      from: 'Peacetime' | 'Invading',
      to: 'WarFooting' | 'Recovery',
    ): SimEvent => {
      const ev = toRecovery(tick);
      if (ev.type === 'ai_state_transition') {
        ev.payload.from = from;
        ev.payload.to = to;
      }
      return ev;
    };
    noteAll(
      s,
      [
        // another kind of transition comes next
        invasionEnd(2000, 'fighter_rout'),
        transition(2000, 'Peacetime', 'WarFooting'),
        transition(2000, 'Invading', 'Recovery'),
        // another invasion_end of the colony comes between the rout and its transition
        invasionEnd(2400, 'fighter_rout'),
        invasionEnd(2400, 'timeout'),
        toRecovery(2400),
      ],
      world,
    );
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(s.lastRoutTick).toBeNull();
    // ... while the plain pair, or a rout read again just before its transition, owes it.
    noteAll(s, [invasionEnd(2800, 'fighter_rout'), ...routed(2800)], world);
    expect(s.owedRoutTick).toBe(2800);
  });

  it('a fresh state (what GameScene makes for a new round or a loaded save) owes nothing', () => {
    const s = createCounterAttackCaptionState();
    expect(s.owedRoutTick).toBeNull();
    expect(s.lastRoutTick).toBeNull();
    expect(s.routSeenTick).toBeNull();
    expect(counterAttackCaptionStale(s, freshWorld(), PLAYER_COLONY_ID)).toBe(false);
  });
});

describe("only while the attacker's army is broken", () => {
  it('below the tier base invasion need at the rout: owed; at it or above: not', () => {
    const world = freshWorld(); // Normal
    const s = createCounterAttackCaptionState();
    noteAll(s, routed(2000, NORMAL_NEED), world);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(s.lastRoutTick).toBeNull(); // a rout that owes nothing starts no cooldown
    noteAll(s, routed(2100, 55), world); // a #421 hold: a routed 32-wave, 55 at home
    expect(counterAttackCaptionOwed(s)).toBe(false);
    noteAll(s, routed(2200, NORMAL_NEED - 1), world);
    expect(s.owedRoutTick).toBe(2200);
  });

  it("the threshold is the base invasion need of the world's tier", () => {
    const [easy, normal, hard] = AI_INVADING_FIGHTER_THRESHOLD;
    expect(armyBroken(freshWorld('Easy'), easy - 1)).toBe(true);
    expect(armyBroken(freshWorld('Easy'), easy)).toBe(false);
    expect(armyBroken(freshWorld('Normal'), normal - 1)).toBe(true);
    expect(armyBroken(freshWorld('Normal'), normal)).toBe(false);
    expect(armyBroken(freshWorld('Hard'), hard - 1)).toBe(true);
    expect(armyBroken(freshWorld('Hard'), hard)).toBe(false);
    // the same 14-fighter army: broken on Easy and Normal, not on Hard
    const tiers = ['Easy', 'Normal', 'Hard'] as const;
    expect(tiers.map((d) => armyBroken(freshWorld(d), 14))).toEqual([true, true, false]);
  });
});

describe('it repeats on every routed wave, with a cooldown', () => {
  it('a rout within the cooldown of the last one owes nothing; one at the cooldown does', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world);
    expect(offerAt(s, world, 2001, ui)).toBe(true);
    ui.finish();
    const early = 2000 + COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS - 1;
    noteAll(s, routed(early), world);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(offerAt(s, world, early + 1, ui)).toBe(false);
    const due = 2000 + COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS;
    noteAll(s, routed(due), world);
    expect(offerAt(s, world, due + 1, ui)).toBe(true);
    expect(ui.shown()).toEqual([COUNTER_ATTACK_CAPTION_TEXT, COUNTER_ATTACK_CAPTION_TEXT]);
  });

  it('a rout the cooldown held back does not restart it', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world);
    expect(offerAt(s, world, 2001, ui)).toBe(true);
    ui.finish();
    noteAll(s, routed(2600), world);
    expect(s.lastRoutTick).toBe(2000);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    // Measured from 2000, not 2600: the next rout at 2000 + the cooldown owes it.
    const due = 2000 + COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS;
    noteAll(s, routed(due), world);
    expect(s.owedRoutTick).toBe(due);
    expect(offerAt(s, world, due + 1, ui)).toBe(true);
  });

  it('the cooldown is no longer than Recovery, and longer than the owed window', () => {
    // A rout puts the AI in Recovery for AI_RECOVERY_DURATION_TICKS; it must then muster,
    // march and fight again, so two routs of one colony are always further apart.
    for (const recovery of AI_RECOVERY_DURATION_TICKS) {
      expect(COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS).toBeLessThanOrEqual(recovery);
    }
    // ... and an owed caption is stale long before the next rout may owe it again.
    expect(COUNTER_ATTACK_CAPTION_OWED_TICKS).toBeLessThan(COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS);
  });
});

describe('never once the match is over, nor once the player is already striking', () => {
  /** The world after `colonyId`'s queen has died. */
  function killQueen(world: WorldState, colonyId: number): void {
    despawnAnt(world, world.colonies[colonyId]!.queenEntityId, { cause: 'starvation' });
  }

  it("the player's queen dies before it shows: dropped, never shown", () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    ui.showCaption('Your queen is in danger.', 0, 0, 'queenDamage');
    noteAll(s, routed(2000), world);
    expect(offerAt(s, world, 2001, ui)).toBe(false); // busy: still owed
    killQueen(world, PLAYER_COLONY_ID);
    ui.finish();
    expect(counterAttackCaptionStale(s, world, PLAYER_COLONY_ID)).toBe(true);
    expect(offerAt(s, world, 2003, ui)).toBe(false);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(ui.shown()).toEqual(['Your queen is in danger.']);
  });

  it("the attacker's queen is dead by the frame it would show: dropped (a guard; GameScene stops at game over)", () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world);
    killQueen(world, ENEMY_COLONY_ID);
    expect(offerAt(s, world, 2002, ui)).toBe(false);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(ui.shown()).toEqual([]);
  });

  /** The player rallied on the enemy's first entrance with `raidType`. */
  function rallyOnEnemy(world: WorldState, raidType: RaidType): void {
    const door = world.colonies[ENEMY_COLONY_ID]!.entrances[0]!;
    const player = world.colonies[PLAYER_COLONY_ID]!;
    player.rallyPoint = { tileX: door.surfaceTileX, tileY: door.surfaceTileY };
    player.raidType = raidType;
  }

  it('the player is already giving an Assault order on their entrance: dropped', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world);
    rallyOnEnemy(world, RaidType.Assault);
    expect(offerAt(s, world, 2001, ui)).toBe(false);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(ui.shown()).toEqual([]);
  });

  it('a Loot raid on their entrance, or an Assault order elsewhere, still gets it', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world);
    rallyOnEnemy(world, RaidType.Loot);
    expect(offerAt(s, world, 2001, ui)).toBe(true);
    ui.finish();
    const world2 = freshWorld();
    const s2 = createCounterAttackCaptionState();
    noteAll(s2, routed(2000), world2);
    const player = world2.colonies[PLAYER_COLONY_ID]!;
    player.rallyPoint = { tileX: 30, tileY: 64 }; // open ground
    player.raidType = RaidType.Assault;
    expect(offerAt(s2, world2, 2001, ui)).toBe(true);
  });

  it("with a third colony, an Assault on the third colony's entrance is not striking the routed one", () => {
    const THIRD = Math.max(PLAYER_COLONY_ID, ENEMY_COLONY_ID) + 1;
    const world = freshWorld();
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const door = enemy.entrances[0]!;
    const thirdDoor = { ...door, surfaceTileX: door.surfaceTileX + 20 };
    world.colonies[THIRD] = { ...enemy, colonyId: THIRD, entrances: [thirdDoor] };
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world); // the enemy's wave, routed at the player
    const player = world.colonies[PLAYER_COLONY_ID]!;
    player.rallyPoint = { tileX: thirdDoor.surfaceTileX, tileY: thirdDoor.surfaceTileY };
    player.raidType = RaidType.Assault;
    expect(offerAt(s, world, 2001, ui)).toBe(true);
    // The same order on the routed colony's own entrance is.
    const s2 = createCounterAttackCaptionState();
    noteAll(s2, routed(2000), world);
    player.rallyPoint = { tileX: door.surfaceTileX, tileY: door.surfaceTileY };
    expect(counterAttackCaptionStale(s2, world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('an Assault order still queued (picked while paused) counts, on the projected world', () => {
    const world = freshWorld();
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    noteAll(s, routed(2000), world);
    setTick(world, 2001);
    const door = world.colonies[ENEMY_COLONY_ID]!.entrances[0]!;
    world.commandQueue.push({
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: door.surfaceTileX,
      tileY: door.surfaceTileY,
      raidType: RaidType.Assault,
      issuedAtTick: 2001,
    });
    // The live world does not have it yet; GameScene's projection does.
    expect(world.colonies[PLAYER_COLONY_ID]!.rallyPoint).toBeNull();
    const projected = new CommandProjection().get(world);
    // Control: the projection is the same moment of the same match (the tick, both
    // queens alive), so the order is the only thing that makes it stale there.
    expect(projected.tick).toBe(world.tick);
    for (const id of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
      expect(projected.ants.alive[projected.colonies[id]!.queenEntityId]).toBe(1);
    }
    expect(counterAttackCaptionStale(s, world, PLAYER_COLONY_ID)).toBe(false);
    expect(counterAttackCaptionStale(s, projected, PLAYER_COLONY_ID)).toBe(true);
    // ...and a queued Loot order on that entrance, projected the same way, is not.
    const world3 = freshWorld();
    const s3 = createCounterAttackCaptionState();
    noteAll(s3, routed(2000), world3);
    setTick(world3, 2001);
    world3.commandQueue.push({
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: door.surfaceTileX,
      tileY: door.surfaceTileY,
      raidType: RaidType.Loot,
      issuedAtTick: 2001,
    });
    const projected3 = new CommandProjection().get(world3);
    expect(projected3.colonies[PLAYER_COLONY_ID]!.rallyPoint).not.toBeNull();
    expect(counterAttackCaptionStale(s3, projected3, PLAYER_COLONY_ID)).toBe(false);
    expect(offerCounterAttackCaption(s, projected, PLAYER_COLONY_ID, ui, 400, 60)).toBe(false);
    expect(counterAttackCaptionOwed(s)).toBe(false);
    expect(ui.shown()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the sim: what the AI step (ai-state.ts _checkInvadingToRecovery /
// _endInvasion / advanceAIState) emits for each way an invasion ends is what the
// caption reads.
// ---------------------------------------------------------------------------

describe('through the sim: what advanceAIState reports for each way an invasion ends', () => {
  /**
   * The raid fixture (two dug-out nests, no spider, no AI) at tick `at`, with the
   * enemy Invading the player since `startTick`: `cohort` enemy fighters on the
   * surface are committed (none: the pre-cohort window), `dead` of them killed, and
   * `athome` more enemy fighters at home, not in the cohort.
   */
  function invadingWorld(
    at: number,
    startTick: number,
    cohort: number,
    dead: number,
    athome = 0,
  ): WorldState {
    const r = raidWorld(3000);
    setTick(r.world, at);
    const state = createDefaultAIStateRecord(ENEMY_COLONY_ID);
    state.state = 'Invading';
    state.enteredTick = startTick;
    state.invasionStartTick = startTick;
    state.invasionRallyTileX = r.playerDoor.x;
    state.invasionRallyTileY = r.playerDoor.y;
    if (cohort > 0) {
      state.operationKind = 'Invasion';
      state.operationStartTick = startTick;
      for (let i = 0; i < cohort; i++) {
        state.operationFighterIds[i] = addFighter(r.world, ENEMY_COLONY_ID, 80 + i, 100, null);
      }
      state.operationFighterCount = cohort;
      state.operationStartFighterCount = cohort;
      for (let i = 0; i < dead; i++) {
        despawnAnt(r.world, state.operationFighterIds[i]!, { cause: 'starvation' });
      }
    }
    for (let i = 0; i < athome; i++) addFighter(r.world, ENEMY_COLONY_ID, 100 + (i % 4), 58, null);
    r.world.aiState.push(state);
    return r.world;
  }

  /** One sim tick, its events through the caption, then the frame step on an idle queue. */
  function playTick(world: WorldState): { events: SimEvent[]; shown: string[] } {
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    world.events.length = 0;
    expect(tick(world, [])).toBe(GameOutcome.None);
    noteAll(s, world.events, world);
    offerCounterAttackCaption(s, world, PLAYER_COLONY_ID, ui, 400, 60);
    return { events: [...world.events], shown: ui.shown() };
  }

  const ends = (events: SimEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'invasion_end' ? [e.payload.outcome] : []));

  it('a cohort routed (fewer than 3 alive): fighter_rout, and the caption shows', () => {
    const { events, shown } = playTick(invadingWorld(500, 400, 3, 1));
    expect(ends(events)).toEqual(['fighter_rout']);
    // The raid world's player has no army: the caption takes its build-up copy.
    expect(shown).toEqual([COUNTER_ATTACK_BUILD_UP_TEXT]);
  });

  it('a cohort routed with a big army at home (the #421 hold): no caption', () => {
    const { events, shown } = playTick(invadingWorld(500, 400, 3, 1, NORMAL_NEED));
    expect(ends(events)).toEqual(['fighter_rout']);
    expect(shown).toEqual([]);
  });

  it('a cohort still standing at the timeout: timeout, and no caption', () => {
    const start = 10;
    const { events, shown } = playTick(
      invadingWorld(start + AI_INVADING_TIMEOUT_TICKS, start, 3, 0),
    );
    expect(ends(events)).toEqual(['timeout']);
    expect(shown).toEqual([]);
  });

  it('no cohort committed by the timeout (pre-cohort): Recovery with no invasion_end, no caption', () => {
    const start = 10;
    const { events, shown } = playTick(
      invadingWorld(start + AI_INVADING_TIMEOUT_TICKS, start, 0, 0),
    );
    expect(ends(events)).toEqual([]);
    expect(
      events.some(
        (e) =>
          e.type === 'ai_state_transition' &&
          e.payload.from === 'Invading' &&
          e.payload.to === 'Recovery',
      ),
    ).toBe(true);
    expect(shown).toEqual([]);
  });

  it('a cohort still standing before the timeout: the invasion goes on, no caption', () => {
    const { events, shown } = playTick(invadingWorld(500, 400, 3, 0));
    expect(ends(events)).toEqual([]);
    expect(shown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per tick, not per frame (#416 review, queen-danger.ts): the property test.
//
// GameScene hands every new event to noteCounterAttackEvent once per render frame,
// after the frame's ticks (consumeEventsForRender: each event read once, by tick), and
// offers the owed caption after that. A frame runs 0..MAX_CATCHUP_TICKS ticks. Which
// routs owe the caption is decided on the events alone, in tick order (the army in the
// rout's transition, the cooldown between event ticks), so for any script and any
// batching, on an idle queue, a frame shows the caption iff a rout the per-tick model
// owes it falls among the ticks it ran.
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random event script over `n` ticks: enemy routs (each with its same-tick
 * transition, the army broken or not, now and then missing) at gaps just inside, at
 * and just past the cooldown, or anywhere; between them timeouts, queen kills,
 * pre-cohort endings, invasion starts and the player's own routed waves, several to a
 * tick at times. Returns the events per tick, in emission order.
 */
function randomScript(seed: number, n: number): Map<number, SimEvent[]> {
  const r = prng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const at = new Map<number, SimEvent[]>();
  const add = (ev: SimEvent): void => {
    if (ev.tick >= n) return;
    const list = at.get(ev.tick) ?? [];
    list.push(ev);
    at.set(ev.tick, list);
  };
  let t = int(0, 40);
  while (t < n) {
    add(invasionEnd(t, 'fighter_rout'));
    const k = r();
    if (k < 0.75) add(toRecovery(t, ENEMY_COLONY_ID, int(0, NORMAL_NEED - 1)));
    else if (k < 0.92) add(toRecovery(t, ENEMY_COLONY_ID, int(NORMAL_NEED, 60)));
    // else: no transition on its tick
    // noise around and between the routs
    for (let c = int(0, 4); c > 0; c--) {
      const u = t + int(0, 900);
      const pick = r();
      if (pick < 0.2) {
        add(invasionEnd(u, 'timeout'));
        add(toRecovery(u));
      } else if (pick < 0.35) add(invasionEnd(u, 'queen_kill'));
      else if (pick < 0.55) add(toRecovery(u));
      else if (pick < 0.75) add(invasionStart(u));
      else for (const ev of routed(u, int(0, 20), PLAYER_COLONY_ID)) add(ev);
    }
    const g = r();
    t +=
      g < 0.3
        ? COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS + int(-6, -1)
        : g < 0.6
          ? COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS + int(0, 6)
          : g < 0.75
            ? int(1, 300)
            : int(300, 3000);
  }
  return at;
}

/**
 * A per-tick reference model: the rout ticks that owe the caption, read off the whole
 * event sequence at once. It restates the rule, so it is not an independent check of
 * the rule itself (the cases above pin that); comparing it with the frame-by-frame
 * caption proves only that batching ticks into frames never changes which routs owe
 * it. Over the whole event sequence, an enemy fighter rout owes it iff the enemy's next
 * AI event after it (its next invasion_end or ai_state_transition) is an Invading →
 * Recovery transition on the same tick with fewer fighters than the base need, and the
 * cooldown since the last rout that owed it is up.
 */
function oracle(script: Map<number, SimEvent[]>, n: number): Set<number> {
  const all: SimEvent[] = [];
  for (let t = 0; t < n; t++) all.push(...(script.get(t) ?? []));
  const enemyAiEvent = (e: SimEvent): boolean =>
    (e.type === 'invasion_end' || e.type === 'ai_state_transition') &&
    e.payload.colonyId === ENEMY_COLONY_ID;
  const owed = new Set<number>();
  let last: number | null = null;
  all.forEach((ev, i) => {
    if (ev.type !== 'invasion_end' || ev.payload.outcome !== 'fighter_rout') return;
    if (ev.payload.colonyId !== ENEMY_COLONY_ID) return;
    const next = all.slice(i + 1).find(enemyAiEvent);
    if (next === undefined || next.type !== 'ai_state_transition' || next.tick !== ev.tick) return;
    if (next.payload.from !== 'Invading' || next.payload.to !== 'Recovery') return;
    if (next.payload.triggerValues.aiFighterCount >= NORMAL_NEED) return;
    if (last !== null && ev.tick - last < COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS) return;
    owed.add(ev.tick);
    last = ev.tick;
  });
  return owed;
}

/** Frame sizes (sim ticks per render frame, 0..MAX_CATCHUP_TICKS) by frame index. */
type Batching = { readonly name: string; readonly size: (frame: number) => number };

function batchings(seed: number): Batching[] {
  const out: Batching[] = [{ name: '1', size: () => 1 }];
  for (const n of [2, 3, MAX_CATCHUP_TICKS]) {
    for (let off = 0; off < n; off++) {
      out.push({ name: `${n}+${off}`, size: (i) => (i === 0 && off > 0 ? off : n) });
    }
  }
  const cycle = (name: string, sizes: readonly number[]): Batching => ({
    name,
    size: (i) => sizes[i % sizes.length]!,
  });
  out.push(cycle('irregular A', [1, 5, 2, 0, 4, 3, 5, 0, 1, 1, 5, 2]));
  out.push(cycle('irregular B', [5, 5, 5, 1, 0, 0, 3, 2, 5, 4]));
  const r = prng(seed ^ 0x9e3779b9);
  const sizes = Array.from({ length: 97 }, () => Math.floor(r() * (MAX_CATCHUP_TICKS + 1)));
  sizes[0] = 1;
  out.push(cycle('random', sizes));
  return out;
}

describe('per tick, not per frame: the outcome is the same however the ticks are batched', () => {
  const world = createScenario(7, 'Normal');

  /**
   * Play `script` through GameScene's wiring — the game loop (each tick emits its
   * events), then per frame the event drain (tick cursor) and the offer on an idle
   * queue — with `batching`'s frame sizes. Returns the frames that disagree with the
   * oracle, and the rout ticks the caption was owed for.
   */
  function play(
    script: Map<number, SimEvent[]>,
    n: number,
    batching: Batching,
  ): { bad: string[]; owed: number[] } {
    setTick(world, 0);
    world.events.length = 0;
    const s = createCounterAttackCaptionState();
    const ui = new FakeUi();
    const owedLog: number[] = [];
    const loop = createGameLoop((w) => {
      for (const ev of script.get(w.tick) ?? []) w.events.push(ev);
      setTick(w, w.tick + 1);
      return GameOutcome.None;
    }, world);
    const want = oracle(script, n);
    let lastProcessed = -1;
    const bad: string[] = [];
    for (let i = 0; world.tick < n; i++) {
      const from = world.tick;
      loop.update(Math.min(batching.size(i), n - from) * MS_PER_TICK);
      const to = world.tick;
      // GameScene.consumeEventsForRender: every event newer than the cursor, in order.
      let maxSeen = lastProcessed;
      for (const ev of world.events) {
        if (ev.tick <= lastProcessed) continue;
        if (ev.tick > maxSeen) maxSeen = ev.tick;
        const before = s.owedRoutTick;
        noteCounterAttackEvent(s, ev, world, PLAYER_COLONY_ID);
        if (s.owedRoutTick !== before && s.owedRoutTick !== null) owedLog.push(s.owedRoutTick);
      }
      lastProcessed = maxSeen;
      const shown = offerCounterAttackCaption(s, world, PLAYER_COLONY_ID, ui, 400, 60);
      if (shown) ui.finish();
      let due = false;
      for (let t = from; t < to; t++) if (want.has(t)) due = true;
      if (shown !== due) bad.push(`[${batching.name}] frame ${from}..${to}: shown ${shown}/${due}`);
    }
    return { bad: bad.slice(0, 5), owed: owedLog };
  }

  const SEEDS = [3, 17, 29, 43, 71, 101, 131, 163];
  const N = 30_000;

  it.each(SEEDS)('random script, seed %i: every batching matches the per-tick model', (seed) => {
    const script = randomScript(seed, N);
    const want = [...oracle(script, N)];
    expect(want.length).toBeGreaterThan(5); // the script owes it repeatedly
    for (const b of batchings(seed)) {
      const { bad, owed } = play(script, N, b);
      expect(bad).toEqual([]);
      expect(owed).toEqual(want);
    }
  });

  it('the scripts exercise every rule: the cooldown both ways, big armies, and missing transitions', () => {
    let heldBack = 0;
    let atCooldown = 0;
    let bigArmy = 0;
    let noTransition = 0;
    for (const seed of SEEDS) {
      const script = randomScript(seed, N);
      const owed = [...oracle(script, N)];
      for (const [t, evs] of script) {
        const i = evs.findIndex(
          (e) =>
            e.type === 'invasion_end' &&
            e.payload.outcome === 'fighter_rout' &&
            e.payload.colonyId === ENEMY_COLONY_ID,
        );
        if (i < 0) continue;
        const next = evs[i + 1];
        if (next?.type !== 'ai_state_transition' || next.payload.colonyId !== ENEMY_COLONY_ID) {
          noTransition += 1;
        } else if (next.payload.triggerValues.aiFighterCount >= NORMAL_NEED) {
          bigArmy += 1;
        } else if (!owed.includes(t)) {
          heldBack += 1;
        }
      }
      for (let i = 1; i < owed.length; i++) {
        if (owed[i]! - owed[i - 1]! <= COUNTER_ATTACK_CAPTION_COOLDOWN_TICKS + 6) atCooldown += 1;
      }
    }
    expect(heldBack).toBeGreaterThan(10);
    expect(atCooldown).toBeGreaterThan(5);
    expect(bigArmy).toBeGreaterThan(5);
    expect(noTransition).toBeGreaterThan(3);
  });
});
