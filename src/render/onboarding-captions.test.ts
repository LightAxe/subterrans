// onboarding-captions.test.ts — S6 coverage for the first-occurrence caption registry.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  captionForEvent,
  captionKeyRetries,
  checkAndTrigger,
  resetCaptions,
  triggered,
  untrigger,
} from './onboarding-captions.js';
import type { SimEvent } from '../sim/telemetry.js';

// Always start each test with a clean slate.
beforeEach(() => {
  resetCaptions();
});

// ---------------------------------------------------------------------------
// First-trigger behaviour
// ---------------------------------------------------------------------------

describe('checkAndTrigger — first occurrence', () => {
  it('returns non-null text on the first call for every key', () => {
    const keys = [
      'dig',
      'chamber',
      'spider',
      'foodMark',
      'rally',
      'rallyRaid',
      'spiderPriority',
      'spiderRampage',
      'queenDamage',
      'queenStarvation',
      'foodStorageNeeded',
      'autosaveFailed',
    ] as const;
    for (const key of keys) {
      resetCaptions();
      const result = checkAndTrigger(key);
      expect(result, `key="${key}" should return text on first call`).not.toBeNull();
      expect(typeof result).toBe('string');
    }
  });

  it('"rallyRaid" (#290 PR 6) tells the player the fighters will raid, and is its own one-shot', () => {
    expect(checkAndTrigger('rally')).toBe('Fighters will converge here.');
    // The generic rally caption having shown does not suppress the raid variant.
    expect(checkAndTrigger('rallyRaid')).toMatch(/raid its larder/);
    expect(checkAndTrigger('rallyRaid')).toBeNull();
  });

  it('returns the expected text for "dig"', () => {
    expect(checkAndTrigger('dig')).toBe('Your workers will excavate the marked tile.');
  });

  it('returns the expected text for "spider"', () => {
    expect(checkAndTrigger('spider')).toBe(
      'A spider is hunting your ants. Use fighters to protect your queen.',
    );
  });

  it('returns the expected text for "queenDamage"', () => {
    expect(checkAndTrigger('queenDamage')).toBe('Your queen is in danger.');
  });

  it('returns the expected text for "foodStorageNeeded" (#395)', () => {
    expect(checkAndTrigger('foodStorageNeeded')).toBe(
      'Build a Food Storage chamber so your queen can lay eggs.',
    );
  });

  it('returns the expected text for "autosaveFailed" (#234 PR2)', () => {
    expect(checkAndTrigger('autosaveFailed')).toBe('Autosave failed — storage full or blocked.');
  });
});

// ---------------------------------------------------------------------------
// Second-call suppression
// ---------------------------------------------------------------------------

describe('checkAndTrigger — second call returns null', () => {
  it('dig: second call is null', () => {
    checkAndTrigger('dig');
    expect(checkAndTrigger('dig')).toBeNull();
  });

  it('spider: second call is null', () => {
    checkAndTrigger('spider');
    expect(checkAndTrigger('spider')).toBeNull();
  });

  it('each key suppresses independently (one key fired does not affect another)', () => {
    checkAndTrigger('dig');
    // rally has not been triggered yet
    expect(checkAndTrigger('rally')).not.toBeNull();
    // but dig is now suppressed
    expect(checkAndTrigger('dig')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetCaptions
// ---------------------------------------------------------------------------

describe('resetCaptions', () => {
  it('clears all triggered flags so keys fire again', () => {
    checkAndTrigger('dig');
    checkAndTrigger('spider');
    resetCaptions();
    expect(triggered.size).toBe(0);
    expect(checkAndTrigger('dig')).not.toBeNull();
    expect(checkAndTrigger('spider')).not.toBeNull();
  });

  it('a key returns its text again after reset', () => {
    const first = checkAndTrigger('queenStarvation');
    resetCaptions();
    const second = checkAndTrigger('queenStarvation');
    expect(first).toBe(second);
    expect(first).toBe('Your queen is growing hungry.');
  });
});

// ---------------------------------------------------------------------------
// Chamber text substitution
// ---------------------------------------------------------------------------

describe('checkAndTrigger — chamber type substitution', () => {
  it('replaces [Chamber Type] with the provided override text', () => {
    const result = checkAndTrigger('chamber', 'Nursery');
    expect(result).toBe('Chambers give workers and brood a purpose. This one is a Nursery.');
  });

  it('replaces [Chamber Type] with "Food Storage"', () => {
    const result = checkAndTrigger('chamber', 'Food Storage');
    expect(result).toBe('Chambers give workers and brood a purpose. This one is a Food Storage.');
  });

  it('returns the raw template when no override is passed', () => {
    const result = checkAndTrigger('chamber');
    expect(result).toContain('[Chamber Type]');
  });

  it('substitution only happens on first trigger; second call still returns null', () => {
    checkAndTrigger('chamber', 'Queen');
    expect(checkAndTrigger('chamber', 'Nursery')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Event → caption policy (captionForEvent)
// ---------------------------------------------------------------------------

describe('captionForEvent — recurring alerts fire every time', () => {
  it('spider_rampage_start returns its caption on EVERY call (per-event dispatch)', () => {
    const expected = 'The spider has gone hungry and is hunting on the surface.';
    // Two separate rampage events must both produce the caption — this is the
    // regression guard for #190 (rampage popup only fired on the first rampage).
    expect(captionForEvent('spider_rampage_start')).toBe(expected);
    expect(captionForEvent('spider_rampage_start')).toBe(expected);
    // ...and again after many occurrences.
    expect(captionForEvent('spider_rampage_start')).toBe(expected);
  });

  it('the spider rampage copy no longer mentions tunnels (#190)', () => {
    const text = captionForEvent('spider_rampage_start');
    expect(text).not.toBeNull();
    expect(text?.toLowerCase()).not.toContain('tunnel');
  });

  it('recurring dispatch does not touch the one-shot triggered map', () => {
    captionForEvent('spider_rampage_start');
    captionForEvent('spider_rampage_start');
    expect(triggered.has('spiderRampage')).toBe(false);
  });
});

describe('captionForEvent — #394: no invasion caption', () => {
  it('invasion_start has no caption: the army warning announces every wave instead', () => {
    expect(captionForEvent('invasion_start')).toBeNull();
    expect(captionForEvent('invasion_start')).toBeNull();
    expect(triggered.size).toBe(0);
  });
});

describe('captionForEvent — unknown / caption-less events', () => {
  it('returns null for events with no caption', () => {
    expect(captionForEvent('combat_kill')).toBeNull();
    expect(captionForEvent('ai_state_transition')).toBeNull();
    // Defensive runtime check: an event type outside the union (e.g. one that
    // existed in an older save/telemetry stream) must still map to null. The
    // cast is required because the signature now narrows to SimEvent['type'].
    expect(captionForEvent('not_a_real_event' as SimEvent['type'])).toBeNull();
  });
});

describe('captionForEvent vs checkAndTrigger — one-shot onboarding unaffected', () => {
  it('genuine onboarding one-shots still fire exactly once', () => {
    // Per-event recurring dispatch must not regress the one-shot onboarding tips.
    for (const key of ['dig', 'chamber', 'foodMark', 'rally'] as const) {
      resetCaptions();
      expect(checkAndTrigger(key)).not.toBeNull();
      expect(checkAndTrigger(key)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// triggered map state
// ---------------------------------------------------------------------------

describe('triggered map state', () => {
  it('is empty before any captions fire', () => {
    expect(triggered.size).toBe(0);
  });

  it('records each triggered key', () => {
    checkAndTrigger('dig');
    checkAndTrigger('rally');
    expect(triggered.get('dig')).toBe(true);
    expect(triggered.get('rally')).toBe(true);
    expect(triggered.has('spider')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// untrigger — un-mark a dropped one-shot so it can re-fire (caption-queue overflow)
// ---------------------------------------------------------------------------

describe('untrigger', () => {
  it('lets a previously-fired one-shot caption fire again', () => {
    // checkAndTrigger marks the key BEFORE the caption reaches the bounded queue;
    // if the queue drops it, untrigger restores the key so the next occurrence
    // re-fires (the dropped caption never displayed).
    expect(checkAndTrigger('dig')).not.toBeNull();
    expect(checkAndTrigger('dig')).toBeNull();
    untrigger('dig');
    expect(triggered.has('dig')).toBe(false);
    expect(checkAndTrigger('dig')).not.toBeNull();
  });

  it('only un-marks the given key', () => {
    checkAndTrigger('dig');
    checkAndTrigger('rally');
    untrigger('dig');
    expect(checkAndTrigger('dig')).not.toBeNull(); // re-fires
    expect(checkAndTrigger('rally')).toBeNull(); // still suppressed
  });

  it('is a no-op for a key that never fired', () => {
    expect(() => untrigger('spiderRampage')).not.toThrow();
    expect(triggered.has('spiderRampage')).toBe(false);
    // ...and the key still fires normally afterward.
    expect(checkAndTrigger('spiderRampage')).not.toBeNull();
  });
});

describe('captionKeyRetries (#395)', () => {
  it('only the storage hint is offered again every frame (retryable in the queue)', () => {
    expect(captionKeyRetries('foodStorageNeeded')).toBe(true);
    for (const key of [
      'rally',
      'queenDamage',
      'queenStarvation',
      'spiderRampage',
      'chamber',
      'autosaveFailed',
    ] as const) {
      expect(captionKeyRetries(key)).toBe(false);
    }
  });
});
