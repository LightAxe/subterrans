// onboarding-captions.test.ts — S6 coverage for the first-occurrence caption registry.

import { describe, it, expect, beforeEach } from 'vitest';
import { checkAndTrigger, resetCaptions, triggered } from './onboarding-captions.js';

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
      'dig', 'chamber', 'spider', 'foodMark', 'rally',
      'spiderPriority', 'aiInvading', 'spiderRampage',
      'queenDamage', 'queenStarvation',
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
    expect(checkAndTrigger('spider')).toBe('A spider is hunting your ants. Use fighters to protect your queen.');
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
