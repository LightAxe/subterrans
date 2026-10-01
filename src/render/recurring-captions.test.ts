// recurring-captions.test.ts — #350: recurring captions (the spider-rampage
// warning, raid news) never take the caption queue's pending slot from a
// one-shot caption, and the rampage warning is owed until it shows. #397: the
// rampage warning is owed from world state — while the rampage threatens the
// viewing colony — and shown once per hungry spell.

import { describe, it, expect } from 'vitest';
import {
  admitCaption,
  completeCaption,
  createCaptionQueueState,
  recurringCaptionMayEnter,
  type CaptionQueueState,
} from './caption-queue.js';
import type { CaptionKey } from './onboarding-captions.js';
import {
  RAMPAGE_CAPTION_OWED_TICKS,
  createRampageCaptionState,
  noteRampageThreat,
  offerOwedRampageCaption,
  offerRecurringCaption,
  oweRampageCaption,
  rampageThreatensViewer,
  recurringCaptionStillOwed,
  resetRampageCaptionState,
  type RampageCaptionState,
  type RecurringCaptionSink,
} from './recurring-captions.js';
import {
  SIM_VERSION_V67_NO_MATCH_TIMEOUT,
  SIM_VERSION_V68_RAMPAGE_SHELTER,
  type SpiderBehaviorState,
  type WorldState,
} from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { rampageThreatens } from '../sim/ant/idle-reserve.js';
import { spiderOnRampage } from '../sim/spider.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import {
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  RAMPAGE_THREAT_RADIUS_TILES,
  SPIDER_GRACE_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
} from '../sim/constants.js';

const RAMPAGE_TEXT = 'The spider has gone hungry and is hunting on the surface.';

/** A stand-in for UIScene over the real caption queue: showCaption admits an
 *  event caption exactly as UIScene.enqueueCaption does, and records what began
 *  and which one-shot keys were dropped (UIScene would untrigger them). */
class FakeUi implements RecurringCaptionSink {
  readonly q: CaptionQueueState = createCaptionQueueState();
  readonly begun: string[] = [];
  readonly droppedKeys: CaptionKey[] = [];
  showCaption(text: string, _x: number, _y: number, captionKey?: CaptionKey): boolean {
    const r = admitCaption(this.q, { text, x: 0, y: 0, source: 'event', captionKey });
    if (r.begin) this.begun.push(r.begin.text);
    if (r.dropped?.captionKey !== undefined) this.droppedKeys.push(r.dropped.captionKey);
    return r.dropped === undefined;
  }
  captionQueueIdle(): boolean {
    return recurringCaptionMayEnter(this.q);
  }
  /** The active caption finished its fade. */
  finish(): void {
    const r = completeCaption(this.q);
    if (r.begin) this.begun.push(r.begin.text);
  }
}

type RampageWorld = Pick<WorldState, 'spider' | 'tick'>;
const T0 = 2000;
/** The spider's hungerTicks when the warning became owed. */
const H0 = 1500;
/** A world at `tick` whose spider is in `state` (null: no spider). By default the
 *  spider has not eaten since T0: its hunger has grown one per tick from H0. */
const at = (
  tick: number,
  state: string | null = 'Rampaging',
  hungerTicks: number = H0 + Math.max(0, tick - T0),
): RampageWorld =>
  ({ tick, spider: state === null ? null : { state, hungerTicks } }) as unknown as RampageWorld;

describe('recurringCaptionStillOwed (#372)', () => {
  it('true while the rampage warning or an untaken raid caption is owed', () => {
    const r = createRampageCaptionState();
    expect(recurringCaptionStillOwed(r, null, false)).toBe(false);
    expect(recurringCaptionStillOwed(r, 'raided', false)).toBe(true);
    oweRampageCaption(r, 10, 100);
    expect(recurringCaptionStillOwed(r, null, false)).toBe(true);
  });

  it('true while an untaken army warning is owed (#395: behind the storage hint)', () => {
    const r = createRampageCaptionState();
    expect(recurringCaptionStillOwed(r, null, true)).toBe(true);
    expect(recurringCaptionStillOwed(r, 'raided', true)).toBe(true);
    oweRampageCaption(r, 10, 100);
    expect(recurringCaptionStillOwed(r, null, true)).toBe(true);
  });
});

describe('offerRecurringCaption (#350)', () => {
  it('enters an idle queue at once', () => {
    const ui = new FakeUi();
    expect(offerRecurringCaption(ui, 'news', 0, 0)).toBe(true);
    expect(ui.begun).toEqual(['news']);
  });

  it('waits while a caption is showing, leaving the pending slot to a one-shot', () => {
    const ui = new FakeUi();
    ui.showCaption('queen damage', 0, 0, 'queenDamage');
    expect(offerRecurringCaption(ui, 'news', 0, 0)).toBe(false);
    expect(ui.q.pending).toBeNull();
    // The one-shot arriving next is queued, not dropped.
    expect(ui.showCaption('rally', 0, 0, 'rally')).toBe(true);
    expect(ui.droppedKeys).toEqual([]);
  });

  it('#372: passes a hold time through, and leaves it off when none is given', () => {
    const calls: unknown[][] = [];
    const sink: RecurringCaptionSink = {
      captionQueueIdle: () => true,
      showCaption: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    };
    offerRecurringCaption(sink, 'warning', 1, 2, 4000);
    offerRecurringCaption(sink, 'news', 1, 2);
    expect(calls).toEqual([
      ['warning', 1, 2, undefined, 4000],
      ['news', 1, 2],
    ]);
  });

  it('fails closed: a sink without captionQueueIdle takes no recurring caption', () => {
    const q = createCaptionQueueState();
    const sink: RecurringCaptionSink = {
      showCaption: (text) =>
        admitCaption(q, { text, x: 0, y: 0, source: 'event' }).dropped === undefined,
    };
    expect(offerRecurringCaption(sink, 'news', 0, 0)).toBe(false);
    expect(q.active).toBeNull();
  });
});

describe('spider-rampage warning (#350)', () => {
  it('shows at once on an idle queue', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    oweRampageCaption(s, T0, H0);
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual([RAMPAGE_TEXT]);
    // Shown once, not every frame.
    expect(offerOwedRampageCaption(s, at(T0 + 1), ui, 0, 0)).toBe(false);
    expect(ui.begun).toEqual([RAMPAGE_TEXT]);
  });

  it('behind a busy queue: the next one-shot keeps its slot, and the warning still shows', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid'); // active
    oweRampageCaption(s, T0, H0);
    // Frame 1: the queue is busy, so the warning waits (owed)...
    const tookIt = offerOwedRampageCaption(s, at(T0), ui, 0, 0);
    // ...and a one-shot arriving next takes the pending slot instead of being dropped.
    const oneShotKept = ui.showCaption('Your queen is in danger.', 0, 0, 'queenDamage');
    expect(ui.droppedKeys).toEqual([]);
    expect(oneShotKept).toBe(true);
    expect(tookIt).toBe(false);
    // Still busy (the one-shot is pending, then active): still owed.
    ui.finish();
    expect(offerOwedRampageCaption(s, at(T0 + 30), ui, 0, 0)).toBe(false);
    ui.finish();
    // Idle, spider still hunting: the warning shows.
    expect(offerOwedRampageCaption(s, at(T0 + 60), ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', 'Your queen is in danger.', RAMPAGE_TEXT]);
  });

  it('why: the old unconditional show took the pending slot and the one-shot was dropped', () => {
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    ui.showCaption(RAMPAGE_TEXT, 0, 0); // pre-#350: shown straight from the event
    expect(ui.showCaption('Your queen is in danger.', 0, 0, 'queenDamage')).toBe(false);
    expect(ui.droppedKeys).toEqual(['queenDamage']);
  });

  it('still shows once the rampage turned into a chase or patrol (still hungry)', () => {
    // A rampage ends the moment the spider diverts to chase a nearby ant, and at
    // 4x speed that can happen in the same render frame as the start.
    for (const state of ['Chasing', 'Patrolling', 'Hunting', 'Striking']) {
      const s = createRampageCaptionState();
      const ui = new FakeUi();
      oweRampageCaption(s, T0, H0);
      expect(offerOwedRampageCaption(s, at(T0 + 1, state), ui, 0, 0)).toBe(true);
      expect(ui.begun).toEqual([RAMPAGE_TEXT]);
    }
  });

  it('is dropped unshown once the spider has eaten, is gone, or is in leftover Retreating', () => {
    for (const state of ['Feeding', 'Retreating', null]) {
      const s = createRampageCaptionState();
      const ui = new FakeUi();
      ui.showCaption('rally raid', 0, 0, 'rallyRaid');
      oweRampageCaption(s, T0, H0);
      expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
      ui.finish(); // idle now, but the warning is stale
      expect(offerOwedRampageCaption(s, at(T0 + 10, state), ui, 0, 0)).toBe(false);
      expect(offerOwedRampageCaption(s, at(T0 + 11), ui, 0, 0)).toBe(false); // not revived
      expect(ui.begun).toEqual(['rally raid']);
    }
  });

  it('is dropped once the spider has eaten, even without entering Feeding (defended kill)', () => {
    // tickSpiderV23 step 3: a kill resets hungerTicks to 0, but with a fighter
    // still adjacent the spider does not enter Feeding; it stays in its state
    // (Rampaging, Chasing, ...) and keeps fighting. It has eaten all the same.
    for (const state of ['Rampaging', 'Chasing', 'Patrolling']) {
      const s = createRampageCaptionState();
      const ui = new FakeUi();
      ui.showCaption('rally raid', 0, 0, 'rallyRaid');
      oweRampageCaption(s, T0, H0);
      expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false); // busy
      ui.finish(); // idle now
      // Killed an ant at T0 + 5; five ticks of hunger since.
      expect(offerOwedRampageCaption(s, at(T0 + 10, state, 5), ui, 0, 0)).toBe(false);
      expect(offerOwedRampageCaption(s, at(T0 + 11, state), ui, 0, 0)).toBe(false); // not revived
      expect(ui.begun).toEqual(['rally raid']);
    }
  });

  it('still shows while the same rampage is ongoing and the spider has not eaten', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    oweRampageCaption(s, T0, H0);
    expect(offerOwedRampageCaption(s, at(T0 + 10, 'Rampaging', H0 + 10), ui, 0, 0)).toBe(false);
    ui.finish();
    // Hunger equal to or above its value at the start: no meal since.
    expect(offerOwedRampageCaption(s, at(T0 + 20, 'Rampaging', H0), ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', RAMPAGE_TEXT]);
  });

  it('is dropped once RAMPAGE_CAPTION_OWED_TICKS pass; owing it again restarts the window', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    oweRampageCaption(s, T0, H0);
    ui.finish();
    // Last tick of the window: still offered (queue idle now), so it shows.
    const edge = createRampageCaptionState();
    oweRampageCaption(edge, T0, H0);
    expect(
      offerOwedRampageCaption(edge, at(T0 + RAMPAGE_CAPTION_OWED_TICKS), new FakeUi(), 0, 0),
    ).toBe(true);
    // One tick later: stale.
    expect(offerOwedRampageCaption(s, at(T0 + RAMPAGE_CAPTION_OWED_TICKS + 1), ui, 0, 0)).toBe(
      false,
    );
    expect(ui.begun).toEqual(['rally raid']);
    // Owed again later: the window runs from then.
    oweRampageCaption(s, T0 + 500, H0);
    expect(offerOwedRampageCaption(s, at(T0 + 500 + RAMPAGE_CAPTION_OWED_TICKS), ui, 0, 0)).toBe(
      true,
    );
  });

  it('fails closed without captionQueueIdle, staying owed', () => {
    const s = createRampageCaptionState();
    const shown: string[] = [];
    oweRampageCaption(s, T0, H0);
    const sink: RecurringCaptionSink = {
      showCaption: (text) => {
        shown.push(text);
        return true;
      },
    };
    expect(offerOwedRampageCaption(s, at(T0), sink, 0, 0)).toBe(false);
    expect(shown).toEqual([]);
    // Still owed: a sink with the gate shows it next frame.
    const ui = new FakeUi();
    expect(offerOwedRampageCaption(s, at(T0 + 1), ui, 0, 0)).toBe(true);
  });

  it('nothing is owed before it is owed, or after a reset', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
    oweRampageCaption(s, T0, H0);
    resetRampageCaptionState(s);
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
    expect(ui.begun).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #397 — owed from world state: once per hungry spell, while the rampage
// threatens the viewing colony.
// ---------------------------------------------------------------------------

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
/** Seed 7: the player's entrance, the enemy's, and the spider's lair (far from both). */
const P_DOOR = { x: 24, y: 64 } as const;
const E_DOOR = { x: 104, y: 64 } as const;
const LAIR = { x: 67, y: 117 } as const;
/** Below the player's door at exactly the threat radius, and one tile beyond it. */
const THREAT_EDGE = { x: 24, y: 64 + RAMPAGE_THREAT_RADIUS_TILES } as const;
const THREAT_OUT = { x: 24, y: 64 + RAMPAGE_THREAT_RADIUS_TILES + 1 } as const;
/** Past the start-of-match grace, so a hungry spider hunts. */
const T1 = SPIDER_GRACE_TICKS + 500;
/** Hungry on Normal. */
const HUNGRY = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;

function setTick(world: WorldState, tick: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock, not a render write
  world.tick = tick;
}

/** A seed-7 Normal world at `version` and tick T1, its spider hungry at its lair. */
function spiderWorld(version: number = SIM_VERSION_V68_RAMPAGE_SHELTER): WorldState {
  const world = createScenario(7, 'Normal');
  world.simVersion = version;
  setTick(world, T1);
  put(world, LAIR, 'Patrolling');
  return world;
}

/** The spider at `tile` in `state` (camping `target`'s door when Rampaging), hungry
 *  unless `hunger` says otherwise. */
function put(
  world: WorldState,
  tile: { x: number; y: number },
  state: SpiderBehaviorState,
  target = -1,
  hunger = HUNGRY,
): void {
  const sp = world.spider!;
  sp.state = state;
  sp.posX = (tile.x << FP_SHIFT) + (FP_ONE >> 1);
  sp.posY = (tile.y << FP_SHIFT) + (FP_ONE >> 1);
  sp.rampageTargetColonyId = target;
  sp.hungerTicks = hunger;
}

/** One GameScene frame for `viewer`: the threat check, then the offer. */
function frame(
  s: RampageCaptionState,
  world: WorldState,
  ui: RecurringCaptionSink,
  viewer = P,
): boolean {
  noteRampageThreat(s, world, viewer);
  return offerOwedRampageCaption(s, world, ui, 0, 0);
}

/** `n` ticks pass without a meal: the spider's hunger grows with them. */
function pass(world: WorldState, n: number): void {
  setTick(world, world.tick + n);
  world.spider!.hungerTicks += n;
}

describe('noteRampageThreat — the rampage warning, once per hungry spell (#397)', () => {
  it('is owed the first frame the rampage threatens the viewer, with the hunger then', () => {
    const w = spiderWorld();
    const s = createRampageCaptionState();
    // Hungry and hunting, but at its lair, far from the player's door: not yet.
    noteRampageThreat(s, w, P);
    expect(s.owedSinceTick).toBe(-Infinity);
    put(w, THREAT_OUT, 'Hunting');
    noteRampageThreat(s, w, P);
    expect(s.owedSinceTick).toBe(-Infinity);
    pass(w, 7);
    put(w, THREAT_EDGE, 'Hunting', -1, HUNGRY + 7);
    noteRampageThreat(s, w, P);
    expect([s.owedSinceTick, s.owedHungerTicks]).toEqual([T1 + 7, HUNGRY + 7]);
    // Owed already: a later frame does not move the window.
    pass(w, 5);
    noteRampageThreat(s, w, P);
    expect(s.owedSinceTick).toBe(T1 + 7);
  });

  it("a rampage set on the viewer's door is a threat from the start, however far off", () => {
    const w = spiderWorld();
    put(w, LAIR, 'Rampaging', P); // just started: still at its lair
    const s = createRampageCaptionState();
    noteRampageThreat(s, w, P);
    expect(s.owedSinceTick).toBe(T1);
  });

  it('shows once across rampage restarts, chase diverts and the threat coming and going', () => {
    // The #397 repro: every chase divert ends the sim's rampage and the camp after
    // it starts a new one; #350 re-showed the warning on every start.
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    const shown: number[] = [];
    const steps: [{ x: number; y: number }, SpiderBehaviorState, number][] = [
      [LAIR, 'Rampaging', P], // set on the player's door: shown
      [P_DOOR, 'Rampaging', P], // camping it
      [THREAT_EDGE, 'Chasing', -1], // diverted to chase a straggler
      [THREAT_OUT, 'Chasing', -1], // and out of the threat radius
      [THREAT_OUT, 'Patrolling', -1],
      [P_DOOR, 'Rampaging', P], // a new rampage at the same door
      [E_DOOR, 'Rampaging', E], // rotated to the enemy's door
      [THREAT_EDGE, 'Hunting', -1], // hunting by the player's door
      [P_DOOR, 'Rampaging', P], // and camping it again
    ];
    for (const [tile, state, target] of steps) {
      put(w, tile, state, target, w.spider!.hungerTicks);
      if (frame(s, w, ui)) shown.push(w.tick);
      for (let i = 0; i < 4; i++) ui.finish(); // the queue drains between steps
      pass(w, 40);
    }
    expect(shown).toEqual([T1]);
    expect(ui.begun).toEqual([RAMPAGE_TEXT]);
    expect(s.owedSinceTick).toBe(-Infinity);
  });

  it('is shown again in the next hungry spell, once the spider has fed', () => {
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(true);
    ui.finish();
    // It eats: hunger reset, Feeding. Over until it is hungry again.
    pass(w, 30);
    put(w, P_DOOR, 'Feeding', -1, 0);
    expect(frame(s, w, ui)).toBe(false);
    put(w, P_DOOR, 'Patrolling', -1, HUNGRY - 20); // not hungry yet
    expect(frame(s, w, ui)).toBe(false);
    pass(w, 500);
    put(w, P_DOOR, 'Rampaging', P, HUNGRY);
    expect(frame(s, w, ui)).toBe(true);
    expect(ui.begun).toEqual([RAMPAGE_TEXT, RAMPAGE_TEXT]);
  });

  it('a meal without Feeding (a defended kill) ends the spell too', () => {
    // A kill always resets hungerTicks to 0; with a fighter still adjacent the
    // spider keeps its state (tickSpiderV23 step 3).
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(true);
    ui.finish();
    pass(w, 30);
    put(w, P_DOOR, 'Rampaging', P, 0); // ate, still camping
    expect(frame(s, w, ui)).toBe(false);
    pass(w, 500);
    put(w, P_DOOR, 'Rampaging', P, HUNGRY);
    expect(frame(s, w, ui)).toBe(true);
    expect(ui.begun).toEqual([RAMPAGE_TEXT, RAMPAGE_TEXT]);
  });

  it('a spider that is gone ends the spell', () => {
    const w = spiderWorld();
    const sp = w.spider!;
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(true);
    ui.finish();
    w.spider = null;
    expect(frame(s, w, ui)).toBe(false);
    w.spider = sp;
    pass(w, 10);
    expect(frame(s, w, ui)).toBe(true);
    expect(ui.begun).toEqual([RAMPAGE_TEXT, RAMPAGE_TEXT]);
  });

  it('only a meal ends the spell, not a state: still hungry in leftover Retreating, not shown again', () => {
    // Retreating is a pre-V23 state that tickSpiderV23 normalizes away every
    // tick; a defensive check that no state but a meal re-arms the warning.
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(true);
    ui.finish();
    pass(w, 30);
    put(w, LAIR, 'Retreating', -1, w.spider!.hungerTicks);
    expect(frame(s, w, ui)).toBe(false);
    pass(w, 30);
    put(w, P_DOOR, 'Rampaging', P, w.spider!.hungerTicks);
    expect(frame(s, w, ui)).toBe(false);
    expect(ui.begun).toEqual([RAMPAGE_TEXT]);
  });

  it('a rampage that does not threaten the viewer owes nothing; the colony it threatens is warned (CLNY-08)', () => {
    for (const [tile, state, target] of [
      [E_DOOR, 'Rampaging', E],
      [LAIR, 'Rampaging', E],
      [E_DOOR, 'Chasing', -1],
      [{ x: E_DOOR.x - RAMPAGE_THREAT_RADIUS_TILES, y: E_DOOR.y }, 'Hunting', -1],
    ] as const) {
      const w = spiderWorld();
      put(w, tile, state, target);
      const player = createRampageCaptionState();
      const enemy = createRampageCaptionState();
      const pUi = new FakeUi();
      const eUi = new FakeUi();
      expect(frame(player, w, pUi, P)).toBe(false);
      expect(player.owedSinceTick).toBe(-Infinity);
      expect(frame(enemy, w, eUi, E)).toBe(true);
      expect(eUi.begun).toEqual([RAMPAGE_TEXT]);
    }
  });

  it('nothing while the spider is not on a rampage: in the grace window, or not hungry', () => {
    const grace = spiderWorld();
    setTick(grace, SPIDER_GRACE_TICKS - 1);
    put(grace, P_DOOR, 'Rampaging', P);
    const lateFed = spiderWorld();
    put(lateFed, P_DOOR, 'Patrolling', -1, SPIDER_HUNGER_THRESHOLD_TICKS[1] - 1);
    for (const w of [grace, lateFed]) {
      const s = createRampageCaptionState();
      noteRampageThreat(s, w, P);
      expect(s.owedSinceTick).toBe(-Infinity);
    }
  });

  it('behind a busy queue: owed while the threat is gone, still shown once', () => {
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(false); // busy: owed
    pass(w, 50);
    put(w, THREAT_OUT, 'Chasing', -1, w.spider!.hungerTicks); // off after a straggler
    expect(frame(s, w, ui)).toBe(false);
    ui.finish();
    expect(frame(s, w, ui)).toBe(true); // still hungry, in the window: shown
    pass(w, 50);
    put(w, P_DOOR, 'Rampaging', P, w.spider!.hungerTicks);
    expect(frame(s, w, ui)).toBe(false);
    expect(ui.begun).toEqual(['rally raid', RAMPAGE_TEXT]);
  });

  it('dropped unshown when its window runs out: a threat still there owes it afresh', () => {
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(false);
    pass(w, RAMPAGE_CAPTION_OWED_TICKS + 1);
    // This frame: the old one is stale (dropped), and the threat still there owes
    // it again from now.
    expect(frame(s, w, ui)).toBe(false);
    noteRampageThreat(s, w, P);
    expect(s.owedSinceTick).toBe(w.tick);
    ui.finish();
    pass(w, 1);
    expect(frame(s, w, ui)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', RAMPAGE_TEXT]);
  });

  it('dropped unshown with the threat gone: owed again if the spider threatens later', () => {
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(false);
    put(w, E_DOOR, 'Rampaging', E, w.spider!.hungerTicks); // moved on
    pass(w, RAMPAGE_CAPTION_OWED_TICKS + 1);
    ui.finish();
    expect(frame(s, w, ui)).toBe(false); // stale: dropped, and no threat to owe it
    expect(s.owedSinceTick).toBe(-Infinity);
    pass(w, 100);
    put(w, P_DOOR, 'Rampaging', P, w.spider!.hungerTicks);
    expect(frame(s, w, ui)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', RAMPAGE_TEXT]);
  });

  it('a reset (new round, loaded save) forgets that it was shown', () => {
    const w = spiderWorld();
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    put(w, P_DOOR, 'Rampaging', P);
    expect(frame(s, w, ui)).toBe(true);
    ui.finish();
    resetRampageCaptionState(s);
    expect(frame(s, w, ui)).toBe(true);
    expect(ui.begun).toEqual([RAMPAGE_TEXT, RAMPAGE_TEXT]);
  });
});

describe('rampageThreatensViewer (#397)', () => {
  /** Spider placements around the player's door and the enemy's, each state. */
  function cases(): [{ x: number; y: number }, SpiderBehaviorState, number, number][] {
    const tiles = [
      P_DOOR,
      THREAT_EDGE,
      THREAT_OUT,
      { x: P_DOOR.x + 6, y: P_DOOR.y - 6 }, // Manhattan 12
      { x: P_DOOR.x + 7, y: P_DOOR.y - 6 }, // 13
      E_DOOR,
      { x: E_DOOR.x - RAMPAGE_THREAT_RADIUS_TILES, y: E_DOOR.y },
      LAIR,
    ];
    const states: SpiderBehaviorState[] = [
      'Patrolling',
      'Hunting',
      'Chasing',
      'Striking',
      'Feeding',
      'Rampaging',
      'Retreating',
    ];
    const out: [{ x: number; y: number }, SpiderBehaviorState, number, number][] = [];
    for (const tile of tiles) {
      for (const state of states) {
        for (const target of [-1, P, E]) {
          for (const hunger of [HUNGRY, SPIDER_HUNGER_THRESHOLD_TICKS[1] - 1, 0]) {
            out.push([tile, state, target, hunger]);
          }
        }
      }
    }
    return out;
  }

  it("from V68 it is the rampage shelter's own rampageThreatens", () => {
    let threats = 0;
    const w = spiderWorld();
    for (const [tile, state, target, hunger] of cases()) {
      put(w, tile, state, target, hunger);
      for (const cid of [P, E]) {
        const want = rampageThreatens(w, w.colonies[cid]!);
        expect(rampageThreatensViewer(w, cid)).toBe(want);
        if (want) threats++;
      }
    }
    expect(threats).toBeGreaterThan(20); // not vacuous
  });

  it('below V68 (no shelter rule) it is that same test, without the version gate', () => {
    // An older save: rampageThreatens is always false there, so the warning
    // applies the rule itself. Parity with the V68 copy of the same world,
    // closed entrances and the grace window included.
    let threats = 0;
    const old = spiderWorld(SIM_VERSION_V67_NO_MATCH_TIMEOUT);
    const now = spiderWorld();
    for (const grace of [false, true]) {
      for (const closed of [false, true]) {
        for (const [tile, state, target, hunger] of cases()) {
          for (const w of [old, now]) {
            setTick(w, grace ? SPIDER_GRACE_TICKS - 1 : T1);
            w.colonies[P]!.entrances[0]!.isOpen = !closed;
            put(w, tile, state, target, hunger);
          }
          for (const cid of [P, E]) {
            expect(rampageThreatens(old, old.colonies[cid]!)).toBe(false);
            const want = rampageThreatens(now, now.colonies[cid]!);
            expect(rampageThreatensViewer(old, cid)).toBe(want);
            if (want) threats++;
          }
        }
      }
    }
    expect(threats).toBeGreaterThan(20);
  });

  it('a closed entrance is no threat; the camp target still is', () => {
    const w = spiderWorld(SIM_VERSION_V67_NO_MATCH_TIMEOUT);
    w.colonies[P]!.entrances[0]!.isOpen = false;
    put(w, P_DOOR, 'Hunting');
    expect(rampageThreatensViewer(w, P)).toBe(false);
    put(w, LAIR, 'Rampaging', P);
    expect(rampageThreatensViewer(w, P)).toBe(true);
    expect(spiderOnRampage(w)).toBe(true);
  });

  it('a colony that does not exist is never threatened', () => {
    const w = spiderWorld();
    put(w, P_DOOR, 'Rampaging', P);
    expect(rampageThreatensViewer(w, 7 as typeof P)).toBe(false);
  });
});
