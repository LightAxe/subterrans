// code/src/render/key-event-dedupe.test.ts
import { describe, it, expect } from 'vitest';
import { KeyEventDedupe } from './key-event-dedupe.js';

// Node has no KeyboardEvent; the guard only ever uses object identity.
const domEvent = (): KeyboardEvent => ({}) as KeyboardEvent;

describe('KeyEventDedupe (#306 / #311)', () => {
  it('claims a DOM event exactly once — every re-walk of it is refused', () => {
    const guard = new KeyEventDedupe();
    const ev = domEvent();
    expect(guard.claim(ev)).toBe(true);
    expect(guard.claim(ev)).toBe(false);
    expect(guard.claim(ev)).toBe(false);
  });

  it('tracks distinct events independently (one press = one new object)', () => {
    const guard = new KeyEventDedupe();
    const first = domEvent();
    const second = domEvent();
    expect(guard.claim(first)).toBe(true);
    expect(guard.claim(second)).toBe(true);
    expect(guard.claim(first)).toBe(false);
    expect(guard.claim(second)).toBe(false);
  });

  it('is per instance — scenes do not share handled state', () => {
    const ev = domEvent();
    expect(new KeyEventDedupe().claim(ev)).toBe(true);
    expect(new KeyEventDedupe().claim(ev)).toBe(true);
  });
});
