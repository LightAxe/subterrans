// onboarding-captions.test.ts — S6 coverage for the first-occurrence caption registry.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  captionForEvent,
  checkAndTrigger,
  resetCaptions,
  triggered,
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
      'spiderPriority',
      'aiInvading',
      'spiderRampage',
      'queenDamage',
      'queenStarvation',
    ] as const;
    for (const key of keys) {
      resetCaptions();
      const result = checkAndTrigger(key);
      expect(result, `key="${key}" should return text on first call`).not.toBeNull();
      expect(typeof result).toBe('string');
    }
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

describe('captionForEvent — one-shot events fire once', () => {
  it('invasion_start returns its caption once then null', () => {
    expect(captionForEvent('invasion_start')).toBe('The enemy is attacking your hive.');
    expect(captionForEvent('invasion_start')).toBeNull();
  });

  it('shares one-shot state with checkAndTrigger for the same CaptionKey', () => {
    // invasion_start maps to the 'aiInvading' caption; once the event fires it,
    // a direct checkAndTrigger('aiInvading') (the ai_state_transition
    // belt-and-suspenders path) must be suppressed, and vice versa.
    expect(captionForEvent('invasion_start')).not.toBeNull();
    expect(checkAndTrigger('aiInvading')).toBeNull();

    resetCaptions();

    expect(checkAndTrigger('aiInvading')).not.toBeNull();
    expect(captionForEvent('invasion_start')).toBeNull();
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
