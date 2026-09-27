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
/** A world at `tick` whose spider is in `state` (null: no spider). */
const at = (tick: number, state: string | null = 'Rampaging'): RampageWorld =>
  ({ tick, spider: state === null ? null : { state } }) as unknown as RampageWorld;

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
    expect(ui.showCaption('invasion', 0, 0, 'aiInvading')).toBe(true);
    expect(ui.droppedKeys).toEqual([]);
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
    noteRampageStart(s, T0);
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
    noteRampageStart(s, T0);
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
      noteRampageStart(s, T0);
      expect(offerOwedRampageCaption(s, at(T0 + 1, state), ui, 0, 0)).toBe(true);
      expect(ui.begun).toEqual([RAMPAGE_TEXT]);
    }
  });

  it('is dropped unshown once the spider has eaten, been driven off, or is gone', () => {
    for (const state of ['Feeding', 'Retreating', null]) {
      const s = createRampageCaptionState();
      const ui = new FakeUi();
      ui.showCaption('rally raid', 0, 0, 'rallyRaid');
      noteRampageStart(s, T0);
      expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
      ui.finish(); // idle now, but the warning is stale
      expect(offerOwedRampageCaption(s, at(T0 + 10, state), ui, 0, 0)).toBe(false);
      expect(offerOwedRampageCaption(s, at(T0 + 11), ui, 0, 0)).toBe(false); // not revived
      expect(ui.begun).toEqual(['rally raid']);
    }
  });

  it('is dropped once RAMPAGE_CAPTION_OWED_TICKS pass; a new rampage restarts the window', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid');
    noteRampageStart(s, T0);
    ui.finish();
    // Last tick of the window: still offered (queue idle now), so it shows.
    const edge = createRampageCaptionState();
    noteRampageStart(edge, T0);
    expect(
      offerOwedRampageCaption(edge, at(T0 + RAMPAGE_CAPTION_OWED_TICKS), new FakeUi(), 0, 0),
    ).toBe(true);
    // One tick later: stale.
    expect(offerOwedRampageCaption(s, at(T0 + RAMPAGE_CAPTION_OWED_TICKS + 1), ui, 0, 0)).toBe(
      false,
    );
    expect(ui.begun).toEqual(['rally raid']);
    // A later rampage owes it again from its own start.
    noteRampageStart(s, T0 + 500);
    expect(offerOwedRampageCaption(s, at(T0 + 500 + RAMPAGE_CAPTION_OWED_TICKS), ui, 0, 0)).toBe(
      true,
    );
  });

  it('fails closed without captionQueueIdle, staying owed', () => {
    const s = createRampageCaptionState();
    const shown: string[] = [];
    noteRampageStart(s, T0);
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
    noteRampageStart(s, T0);
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
      payload: { lairTile: { x: 0, y: 0 }, hungerTicks: 0 },
    }) as unknown as SimEvent;
  const invasionStart = (tick: number): SimEvent =>
    ({
      tick,
      type: 'invasion_start',
      payload: { colonyId: 1, rallyTile: { x: 0, y: 0, grid: 'surface' }, fighterCount: 3 },
    }) as unknown as SimEvent;
  const INVASION_TEXT = 'The enemy is attacking your hive.';

  it('a rampage start behind a busy queue is owed, not queued; the one-shot after it keeps its slot', () => {
    // One GameScene frame: a caption is showing, the sim emitted a rampage start
    // and then an invasion (a one-shot) in the same batch.
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    ui.showCaption('rally raid', 0, 0, 'rallyRaid'); // active
    routeEventCaption(rampageStart(T0), s, ui, 0, 0);
    routeEventCaption(invasionStart(T0), s, ui, 0, 0);
    // The one-shot was queued, not dropped, and the rampage text is not queued.
    expect(ui.droppedKeys).toEqual([]);
    expect(ui.q.pending?.text).toBe(INVASION_TEXT);
    expect(ui.q.active?.text).toBe('rally raid');
    expect(triggered.get('aiInvading')).toBe(true);
    // Rest of the frame (checkQueenStatusForEffects): still busy, still owed.
    expect(offerOwedRampageCaption(s, at(T0), ui, 0, 0)).toBe(false);
    ui.finish(); // the invasion caption shows
    expect(offerOwedRampageCaption(s, at(T0 + 20), ui, 0, 0)).toBe(false);
    ui.finish(); // idle
    expect(offerOwedRampageCaption(s, at(T0 + 40), ui, 0, 0)).toBe(true);
    expect(ui.begun).toEqual(['rally raid', INVASION_TEXT, RAMPAGE_TEXT]);
  });

  it('a one-shot event caption carries its key, so a drop un-marks it', () => {
    const ui = new FakeUi();
    ui.showCaption('a', 0, 0);
    ui.showCaption('b', 0, 0); // queue full
    routeEventCaption(invasionStart(T0), createRampageCaptionState(), ui, 0, 0);
    expect(ui.droppedKeys).toEqual(['aiInvading']);
  });

  it('with no UIScene, the rampage is still owed and a one-shot is still marked', () => {
    const s = createRampageCaptionState();
    routeEventCaption(rampageStart(T0), s, null, 0, 0);
    routeEventCaption(invasionStart(T0), s, null, 0, 0);
    expect(s.owedSinceTick).toBe(T0);
    expect(triggered.get('aiInvading')).toBe(true);
  });

  it('events without a caption do nothing', () => {
    const s = createRampageCaptionState();
    const ui = new FakeUi();
    routeEventCaption({ tick: T0, type: 'spider_rampage_end' } as unknown as SimEvent, s, ui, 0, 0);
    expect(ui.begun).toEqual([]);
    expect(s.owedSinceTick).toBe(-Infinity);
  });
});
