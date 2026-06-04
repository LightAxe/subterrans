import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  type Settings,
} from './settings.js';

// jsdom provides a real localStorage in the test environment (test-setup.ts
// mounts it). Each test resets the namespace key to ensure isolation.
beforeEach(() => {
  localStorage.removeItem(SETTINGS_KEY);
});

describe('loadSettings', () => {
  it('returns DEFAULT_SETTINGS when localStorage is empty', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh copy each call (caller can mutate freely)', () => {
    const a = loadSettings();
    const b = loadSettings();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('round-trips a saved Settings object losslessly', () => {
    const next: Settings = { pheromoneOverlay: false };
    saveSettings(next);
    expect(loadSettings()).toEqual(next);
  });

  it('falls back to DEFAULT_SETTINGS on malformed JSON', () => {
    localStorage.setItem(SETTINGS_KEY, '{not-json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to DEFAULT_SETTINGS when envelope is missing version', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ settings: { pheromoneOverlay: false } }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to DEFAULT_SETTINGS when version is newer than this build supports', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION + 1,
        settings: { pheromoneOverlay: false },
      }),
    );
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('replaces a wrong-typed pheromoneOverlay with the default but keeps siblings intact', () => {
    // Permissive merge: a single corrupt field shouldn't wipe valid neighbors.
    // Today we only have one boolean field; this guards the merge logic so a
    // future field is safe to add.
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { pheromoneOverlay: 'not-a-bool' },
      }),
    );
    expect(loadSettings()).toEqual({ pheromoneOverlay: DEFAULT_SETTINGS.pheromoneOverlay });
  });

  it('ignores unknown extra keys in the settings object', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { pheromoneOverlay: false, futureKey: 'whatever' },
      }),
    );
    expect(loadSettings()).toEqual({ pheromoneOverlay: false });
  });
});

describe('saveSettings', () => {
  it('writes a versioned envelope under SETTINGS_KEY', () => {
    saveSettings({ pheromoneOverlay: false });
    const raw = localStorage.getItem(SETTINGS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({
      version: SETTINGS_VERSION,
      settings: { pheromoneOverlay: false },
    });
  });

  it('overwrites an earlier saved state', () => {
    saveSettings({ pheromoneOverlay: true });
    saveSettings({ pheromoneOverlay: false });
    expect(loadSettings()).toEqual({ pheromoneOverlay: false });
  });
});
