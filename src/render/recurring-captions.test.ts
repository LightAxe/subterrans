// recurring-captions.test.ts — #350: recurring captions (the spider-rampage
// warning, raid news) never take the caption queue's pending slot from a
// one-shot caption, and the rampage warning is owed until it shows.

import { beforeEach, describe, it, expect } from 'vitest';
import {
  admitCaption,
  completeCaption,
  createCaptionQueueState,
  recurringCaptionMayEnter,
  type CaptionQueueState,
} from './caption-queue.js';
import { resetCaptions, triggered, type CaptionKey } from './onboarding-captions.js';
import {
  RAMPAGE_CAPTION_OWED_TICKS,
  createRampageCaptionState,
  noteRampageStart,
  offerOwedRampageCaption,
  offerRecurringCaption,
  recurringCaptionStillOwed,
  resetRampageCaptionState,
  routeEventCaption,
  type RecurringCaptionSink,
} from './recurring-captions.js';
import type { WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';

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
/** The spider's hungerTicks at the rampage start (past every tier's threshold). */
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
    noteRampageStart(r, 10, 100);
    expect(recurringCaptionStillOwed(r, null, false)).toBe(true);
  });

  it('true while an untaken gathering warning is owed (#395: behind the storage hint)', () => {
    const r = createRampageCaptionState();
    expect(recurringCaptionStillOwed(r, null, true)).toBe(true);
    expect(recurringCaptionStillOwed(r, 'raided', true)).toBe(true);
    noteRampageStart(r, 10, 100);
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
    noteRampageStart(s, T0, H0);
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
    noteRampageStart(s, T0, H0);
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
      noteRampageStart(s, T0, H0);
      expect(offerOwedRampageCaption(s, at(T0 + 1, state), ui, 0, 0)).toBe(true);
      expect(ui.begun).toEqual([RAMPAGE_TEXT]);
    }
  });

  it('is dropped unshown once the spider has eaten, been driven off, or is gone', () => {
    for (const state of ['Feeding', 'Retreating', null]) {
      const s = createRampageCaptionState();
      const ui = new FakeUi();
      ui.showCaption('rally raid', 0, 0, 'rallyRaid');
      noteRampageStart(s, T0, H0);
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
      noteRampageStart(s, T0, H0);
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
    noteRampageStart(s, T0, H0);
    expect(offerOwedRampageCaption(s, at(T0 + 10, 'Rampaging', H0 + 10), ui, 0, 0)).toBe(false);
    ui.finish();
    // Hunger equal to or above its value at the start: no meal since.
    expect(offerOwedRampageCaption(s, at(T0 + 20, 'Rampaging', H0), ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', RAMPAGE_TEXT]);
  });

  it('is dropped once RAMPAGE_CAPTION_OWED_TICKS pass; a new rampage restarts the window', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    noteRampageStart(s, T0, H0);
    ui.finish();
    // Last tick of the window: still offered (queue idle now), so it shows.
    const edge = createRampageCaptionState();
    noteRampageStart(edge, T0, H0);
    expect(
      offerOwedRampageCaption(edge, at(T0 + RAMPAGE_CAPTION_OWED_TICKS), new FakeUi(), 0, 0),
    ).toBe(true);
    // One tick later: stale.
    expect(offerOwedRampageCaption(s, at(T0 + RAMPAGE_CAPTION_OWED_TICKS + 1), ui, 0, 0)).toBe(
      false,
    );
    expect(ui.begun).toEqual(['rally raid']);
    // A later rampage owes it again from its own start.
    noteRampageStart(s, T0 + 500, H0);
    expect(offerOwedRampageCaption(s, at(T0 + 500 + RAMPAGE_CAPTION_OWED_TICKS), ui, 0, 0)).toBe(
      true,
    );
  });

  it('fails closed without captionQueueIdle, staying owed', () => {
    const s = createRampageCaptionState();
    const shown: string[] = [];
    noteRampageStart(s, T0, H0);
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

  it('nothing is owed before a rampage starts, or after a reset', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
    noteRampageStart(s, T0, H0);
    resetRampageCaptionState(s);
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
    expect(ui.begun).toEqual([]);
  });
});

describe('routeEventCaption — GameScene event captions (#350)', () => {
  beforeEach(() => resetCaptions());

  const rampageStart = (tick: number): SimEvent =>
    ({
      tick,
      type: 'spider_rampage_start',
      payload: { lairTile: { x: 0, y: 0 }, hungerTicks: H0 },
    }) as unknown as SimEvent;
  const invasionStart = (tick: number): SimEvent =>
    ({
      tick,
      type: 'invasion_start',
      payload: { colonyId: 1, rallyTile: { x: 0, y: 0, grid: 'surface' }, fighterCount: 3 },
    }) as unknown as SimEvent;

  it('a rampage start is owed, not queued: shown once the queue is idle', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid'); // active
    routeEventCaption(rampageStart(T0), s);
    expect(s.owedSinceTick).toBe(T0);
    expect(s.owedHungerTicks).toBe(H0); // from the event payload
    expect(ui.q.pending).toBeNull();
    // Rest of the frame (checkQueenStatusForEffects): still busy, still owed.
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
    ui.finish(); // idle
    expect(offerOwedRampageCaption(s, at(T0 + 20), ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', RAMPAGE_TEXT]);
  });

  it('#394: invasion_start raises no caption and marks nothing (the army warning covers it)', () => {
    const s = createRampageCaptionState();
    routeEventCaption(invasionStart(T0), s);
    expect(s.owedSinceTick).toBe(-Infinity);
    expect(triggered.size).toBe(0);
  });

  it('events without a caption do nothing', () => {
    const s = createRampageCaptionState();
    routeEventCaption({ tick: T0, type: 'spider_rampage_end' } as unknown as SimEvent, s);
    expect(s.owedSinceTick).toBe(-Infinity);
  });
});
