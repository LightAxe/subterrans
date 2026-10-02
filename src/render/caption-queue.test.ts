// caption-queue.test.ts — Stage 3b (#3): the caption-admission policy
// (priority / coalesce / drop / promote).

import { describe, it, expect } from 'vitest';
import {
  admitCaption,
  completeCaption,
  clearPendingFirstUse,
  createCaptionQueueState,
  recurringCaptionMayEnter,
  captionHoldMs,
  captionTotalMs,
  yieldedHoldMs,
  captionFadeInMs,
  CAPTION_FADE_IN_MS,
  CAPTION_HOLD_MS,
  CAPTION_YIELD_FLOOR_MS,
  type CaptionRequest,
} from './caption-queue.js';

describe('#372 caption hold', () => {
  it('800 ms hold and 1500 ms total by default; a request may hold longer', () => {
    const plain: CaptionRequest = { text: 'a', x: 0, y: 0, source: 'event' };
    expect(CAPTION_HOLD_MS).toBe(800);
    expect(captionHoldMs(plain)).toBe(800);
    expect(captionTotalMs(plain)).toBe(1500);
    const long: CaptionRequest = { ...plain, holdMs: 4000 };
    expect(captionHoldMs(long)).toBe(4000);
    expect(captionTotalMs(long)).toBe(4700);
  });

  it('a long hold yields to what the readable floor would have left; a default hold never yields', () => {
    const plain: CaptionRequest = { text: 'a', x: 0, y: 0, source: 'event' };
    const long: CaptionRequest = { ...plain, holdMs: 4000 };
    expect(CAPTION_YIELD_FLOOR_MS).toBe(2000);
    expect(yieldedHoldMs(plain, 0)).toBeNull();
    expect(yieldedHoldMs({ ...plain, holdMs: CAPTION_HOLD_MS }, 0)).toBeNull();
    expect(yieldedHoldMs(long, 0)).toBe(CAPTION_YIELD_FLOOR_MS);
    expect(yieldedHoldMs(long, 300)).toBe(CAPTION_YIELD_FLOOR_MS - 300);
    expect(yieldedHoldMs(long, 2500)).toBe(0);
    // A hold between the default and the floor keeps its own length.
    expect(yieldedHoldMs({ ...plain, holdMs: 1200 }, 0)).toBe(1200);
  });
});

const evt = (text: string): CaptionRequest => ({ text, x: 0, y: 0, source: 'event' });
const fu = (hintId: string): CaptionRequest => ({
  text: hintId,
  x: 0,
  y: 0,
  source: 'first-use',
  hintId,
});

describe('admitCaption', () => {
  it('displays immediately when nothing is active', () => {
    const s = createCaptionQueueState();
    const r = admitCaption(s, evt('a'));
    expect(r.begin?.text).toBe('a');
    expect(s.active?.text).toBe('a');
    expect(s.pending).toBeNull();
  });

  it('never preempts the active caption — second goes to pending', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a'));
    const r = admitCaption(s, evt('b'));
    expect(r.begin).toBeUndefined();
    expect(r.queued?.text).toBe('b');
    expect(s.active?.text).toBe('a');
    expect(s.pending?.text).toBe('b');
  });

  it('coalesces a duplicate first-use against the ACTIVE one', () => {
    const s = createCaptionQueueState();
    admitCaption(s, fu('pan'));
    const r = admitCaption(s, fu('pan'));
    expect(r.coalesced).toBe(true);
    expect(s.pending).toBeNull();
  });

  it('coalesces a duplicate first-use against the PENDING one', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a')); // active
    admitCaption(s, fu('zoom')); // pending
    const r = admitCaption(s, fu('zoom'));
    expect(r.coalesced).toBe(true);
    expect(s.pending?.hintId).toBe('zoom');
  });

  it('an incoming EVENT evicts a pending FIRST-USE (event outranks)', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a')); // active
    admitCaption(s, fu('pan')); // pending first-use
    const r = admitCaption(s, evt('b'));
    expect(r.queued?.text).toBe('b');
    expect(r.droppedFirstUse?.hintId).toBe('pan');
    expect(s.pending?.text).toBe('b');
  });

  it('an incoming FIRST-USE is dropped when the slot is occupied (overflow)', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a')); // active
    admitCaption(s, evt('b')); // pending event
    const r = admitCaption(s, fu('paint'));
    expect(r.dropped?.hintId).toBe('paint');
    expect(s.pending?.text).toBe('b'); // unchanged
  });

  it('a second EVENT loses to the first queued event (order preserved)', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a'));
    admitCaption(s, evt('b'));
    const r = admitCaption(s, evt('c'));
    expect(r.dropped?.text).toBe('c');
    expect(s.pending?.text).toBe('b');
  });

  it('a dropped one-shot event carries its captionKey so UIScene can un-mark it', () => {
    // Regression guard: a one-shot caption is marked-triggered before it reaches
    // the queue; if overflow drops it the key must travel back so UIScene un-marks
    // it (otherwise the first-occurrence caption is lost for the session).
    const s = createCaptionQueueState();
    admitCaption(s, evt('a')); // active
    admitCaption(s, evt('b')); // pending
    const r = admitCaption(s, { ...evt('c'), captionKey: 'dig' });
    expect(r.dropped?.captionKey).toBe('dig');
  });
});

describe('completeCaption', () => {
  it('promotes pending to active and signals begin', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a'));
    admitCaption(s, evt('b'));
    const r = completeCaption(s);
    expect(r.begin?.text).toBe('b');
    expect(s.active?.text).toBe('b');
    expect(s.pending).toBeNull();
  });

  it('goes idle when nothing is pending', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a'));
    const r = completeCaption(s);
    expect(r.begin).toBeUndefined();
    expect(s.active).toBeNull();
  });
});

describe('clearPendingFirstUse', () => {
  it('drops a pending FIRST-USE entry but leaves the active one mid-fade', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a'));
    admitCaption(s, fu('pan'));
    clearPendingFirstUse(s);
    expect(s.pending).toBeNull();
    expect(s.active?.text).toBe('a');
  });

  it('LEAVES a pending EVENT caption intact (Codex PR #218 — do not drop unrelated events)', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a')); // active
    admitCaption(s, evt('queen-damage')); // pending EVENT caption
    clearPendingFirstUse(s);
    expect(s.pending?.text).toBe('queen-damage'); // survives the first-use reset
  });
});

describe('recurringCaptionMayEnter (#290 PR 6)', () => {
  it('only when nothing is showing and nothing is pending', () => {
    const s = createCaptionQueueState();
    expect(recurringCaptionMayEnter(s)).toBe(true);
    admitCaption(s, evt('active'));
    expect(recurringCaptionMayEnter(s)).toBe(false); // active, pending free
    admitCaption(s, evt('pending'));
    expect(recurringCaptionMayEnter(s)).toBe(false);
  });

  it('why: recurring news in the pending slot would drop an arriving one-shot', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('queen damage'));
    // Were raid news admitted behind the active caption...
    admitCaption(s, evt('raid news'));
    // ...a one-shot event arriving next overflows and is lost.
    expect(admitCaption(s, evt('rally raid')).dropped?.text).toBe('rally raid');
    // With the gate, raid news waits, and the one-shot takes the slot instead.
    const g = createCaptionQueueState();
    admitCaption(g, evt('queen damage'));
    if (recurringCaptionMayEnter(g)) admitCaption(g, evt('raid news'));
    expect(admitCaption(g, evt('rally raid')).queued?.text).toBe('rally raid');
  });
});

describe('#378 — a newer version of a caption replaces the older one', () => {
  const KEY = 'raidOrder';
  const order = (text: string): CaptionRequest => ({ ...evt(text), supersedeKey: KEY });

  it('on screen: the newer version takes the active slot at once, cutting the old one short', () => {
    const s = createCaptionQueueState();
    const blockade = order('Raiding: Blockade.');
    const assault = order('Raiding: Assault.');
    expect(admitCaption(s, blockade)).toEqual({ begin: blockade });
    const r = admitCaption(s, assault);
    expect(r).toEqual({ begin: assault, replacedActive: blockade });
    expect(s.active).toBe(assault);
    expect(s.pending).toBeNull();
    // It then finishes like any caption: nothing old is promoted after it.
    expect(completeCaption(s)).toEqual({});
    expect(s.active).toBeNull();
  });

  it('pending: the newer version swaps in and keeps that place in line', () => {
    const s = createCaptionQueueState();
    const other = evt('Your queen is in danger.');
    const deny = order('Raiding: Deny.');
    const spoil = order('Raiding: Spoil.');
    admitCaption(s, other);
    expect(admitCaption(s, deny)).toEqual({ queued: deny });
    expect(admitCaption(s, spoil)).toEqual({ queued: spoil, replacedPending: deny });
    expect(s.active).toBe(other); // the other caption is not cut short
    expect(s.pending).toBe(spoil);
    expect(completeCaption(s)).toEqual({ begin: spoil });
  });

  it('a different caption waiting behind the old version still waits — no longer: the new one keeps the old schedule', () => {
    const s = createCaptionQueueState();
    const loot = order('Raiding: Loot.');
    const danger = evt('Your queen is in danger.');
    const assault = order('Raiding: Assault.');
    admitCaption(s, loot);
    admitCaption(s, danger);
    expect(admitCaption(s, assault)).toEqual({
      begin: assault,
      replacedActive: loot,
      keepSchedule: true,
    });
    expect(s.pending).toBe(danger);
    expect(completeCaption(s)).toEqual({ begin: danger });
  });

  it('with nothing waiting, the newer version gets a fresh lifetime (no keepSchedule)', () => {
    const s = createCaptionQueueState();
    admitCaption(s, order('a'));
    expect(admitCaption(s, order('b')).keepSchedule).toBeUndefined();
    // An older version waiting too is cleared, and then nothing else waits.
    const s2 = createCaptionQueueState();
    s2.active = order('a');
    s2.pending = order('b');
    expect(admitCaption(s2, order('c')).keepSchedule).toBeUndefined();
  });

  it('an older version both on screen and waiting is replaced in both slots', () => {
    const s = createCaptionQueueState();
    const a = order('a');
    const b = order('b');
    const c = order('c');
    s.active = a;
    s.pending = b; // not reachable through admitCaption, but the rule still holds
    expect(admitCaption(s, c)).toEqual({ begin: c, replacedActive: a, replacedPending: b });
    expect(s.active).toBe(c);
    expect(s.pending).toBeNull();
  });

  it('only the same key supersedes: other keys and keyless captions queue as before', () => {
    const s = createCaptionQueueState();
    const raid = order('Raiding: Deny.');
    const otherKey: CaptionRequest = { ...evt('x'), supersedeKey: 'somethingElse' };
    admitCaption(s, raid);
    expect(admitCaption(s, otherKey)).toEqual({ queued: otherKey });
    // A keyless event behind an occupied pending slot still overflows.
    expect(admitCaption(s, evt('y'))).toEqual({ dropped: evt('y') });
    expect(s.active).toBe(raid);
  });

  it('a keyless caption never replaces a keyed one, nor a keyed one a keyless one', () => {
    const s = createCaptionQueueState();
    const plain = evt('Raiding: Deny.'); // same words, no key
    const keyed = order('Raiding: Assault.');
    admitCaption(s, plain);
    expect(admitCaption(s, keyed)).toEqual({ queued: keyed });
    expect(s.active).toBe(plain);
    const s2 = createCaptionQueueState();
    admitCaption(s2, keyed);
    expect(admitCaption(s2, plain)).toEqual({ queued: plain });
    expect(s2.active).toBe(keyed);
  });

  it('a first-use hint waiting behind the old version does not hold the newer one to its schedule', () => {
    const s = createCaptionQueueState();
    const loot = order('Raiding: Loot.');
    const hint = fu('zoom');
    const deny = order('Raiding: Deny.');
    admitCaption(s, loot);
    admitCaption(s, hint);
    // Events outrank hints: the order caption gets a full lifetime; the hint waits.
    expect(admitCaption(s, deny)).toEqual({ begin: deny, replacedActive: loot });
    expect(s.pending).toBe(hint);
  });

  it('a first-use hint on screen is not cut short, and a keyed caption still evicts a pending hint', () => {
    const s = createCaptionQueueState();
    const hint = fu('tabNudge');
    const hint2 = fu('pinchNudge');
    const raid = order('Raiding: Loot.');
    admitCaption(s, hint);
    admitCaption(s, hint2);
    expect(admitCaption(s, raid)).toEqual({ queued: raid, droppedFirstUse: hint2 });
    expect(s.active).toBe(hint);
  });
});

describe('#378 — captionFadeInMs', () => {
  it('is the full fade-in from 0, only the rest of it from part-way, at least 1 ms', () => {
    expect(captionFadeInMs(0)).toBe(CAPTION_FADE_IN_MS);
    expect(captionFadeInMs(0.5)).toBe(Math.round(CAPTION_FADE_IN_MS / 2));
    expect(captionFadeInMs(1)).toBe(1);
    expect(captionFadeInMs(-3)).toBe(CAPTION_FADE_IN_MS); // clamped
    expect(captionFadeInMs(7)).toBe(1);
  });
});
