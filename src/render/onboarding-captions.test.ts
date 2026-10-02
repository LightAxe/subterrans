// onboarding-captions.test.ts — S6 coverage for the first-occurrence caption registry.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  captionKeyRetries,
  captionText,
  checkAndTrigger,
  resetCaptions,
  triggered,
  untrigger,
} from './onboarding-captions.js';

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
// Caption text outside the one-shot registry (captionText)
// ---------------------------------------------------------------------------

describe('captionText — the rampage warning text, not a one-shot', () => {
  it('spiderRampage returns its text on EVERY call', () => {
    // A text lookup that marks nothing: the warning recurs once per hungry spell
    // (#397, recurring-captions.ts), not only in the first one (#190).
    const expected = 'The spider has gone hungry and is hunting on the surface.';
    expect(captionText('spiderRampage')).toBe(expected);
    expect(captionText('spiderRampage')).toBe(expected);
    expect(captionText('spiderRampage')).toBe(expected);
  });

  it('the spider rampage copy no longer mentions tunnels (#190)', () => {
    expect(captionText('spiderRampage').toLowerCase()).not.toContain('tunnel');
  });

  it('the lookup does not touch the one-shot triggered map', () => {
    captionText('spiderRampage');
    captionText('spiderRampage');
    expect(triggered.has('spiderRampage')).toBe(false);
    expect(triggered.size).toBe(0);
  });
});

describe('captionText vs checkAndTrigger — one-shot onboarding unaffected', () => {
  it('genuine onboarding one-shots still fire exactly once', () => {
    // Recurring text lookups must not regress the one-shot onboarding tips.
    for (const key of ['dig', 'chamber', 'foodMark', 'rally'] as const) {
      resetCaptions();
      expect(checkAndTrigger(key)).not.toBeNull();
      expect(checkAndTrigger(key)).toBeNull();
    }
  });

  it("reading a one-shot key's text does not use up its one showing", () => {
    expect(captionText('dig')).toBe(checkAndTrigger('dig'));
    resetCaptions();
    captionText('rally');
    expect(checkAndTrigger('rally')).toBe(captionText('rally'));
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
