// caption-queue.test.ts — Stage 3b (#3): the caption-admission policy
// (priority / coalesce / drop / promote).

import { describe, it, expect } from 'vitest';
import {
  admitCaption,
  completeCaption,
  clearPending,
  createCaptionQueueState,
  type CaptionRequest,
} from './caption-queue.js';

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

describe('clearPending', () => {
  it('drops the pending entry but leaves the active one mid-fade', () => {
    const s = createCaptionQueueState();
    admitCaption(s, evt('a'));
    admitCaption(s, fu('pan'));
    clearPending(s);
    expect(s.pending).toBeNull();
    expect(s.active?.text).toBe('a');
  });
});
