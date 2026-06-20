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

// Build a full Settings object from a partial, so individual tests only state
// the field(s) they care about (Stage 3b added hintStripVisible + firstUseHints).
function mk(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

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
    const next: Settings = mk({
      pheromoneOverlay: false,
      hintStripVisible: false,
      firstUseHints: { pan: true, zoom: true },
    });
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

  it('migrates an old blob missing the Stage-3b keys by filling defaults (no version bump)', () => {
    // A settings file written before Stage 3b has only pheromoneOverlay. The
    // permissive loader must fill hintStripVisible + firstUseHints from defaults
    // without invalidating the file (Codex: backward-compatible add).
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, settings: { pheromoneOverlay: false } }),
    );
    expect(loadSettings()).toEqual(mk({ pheromoneOverlay: false }));
  });

  it('replaces a wrong-typed field with its default but keeps valid siblings intact', () => {
    // Permissive merge: a single corrupt field shouldn't wipe valid neighbors.
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { pheromoneOverlay: 'not-a-bool', hintStripVisible: false },
      }),
    );
    expect(loadSettings()).toEqual(
      mk({ pheromoneOverlay: DEFAULT_SETTINGS.pheromoneOverlay, hintStripVisible: false }),
    );
  });

  it('sanitizes firstUseHints: keeps boolean entries, drops non-boolean ones', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { firstUseHints: { pan: true, zoom: 'yes', paint: false, view: 1 } },
      }),
    );
    expect(loadSettings().firstUseHints).toEqual({ pan: true, paint: false });
  });

  it('coerces a non-object firstUseHints (e.g. a stringified Set) to an empty record', () => {
    // A pre-fix build that stored a Set serializes to `{}`/array/etc.; either way
    // we must not crash and must yield a clean record (Codex R1#4).
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { firstUseHints: ['pan', 'zoom'] },
      }),
    );
    // Arrays are objects; only string-keyed boolean entries survive → {}.
    expect(loadSettings().firstUseHints).toEqual({});
  });

  it('ignores unknown extra keys in the settings object', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { pheromoneOverlay: false, futureKey: 'whatever' },
      }),
    );
    expect(loadSettings()).toEqual(mk({ pheromoneOverlay: false }));
  });
});

describe('saveSettings', () => {
  it('writes a versioned envelope under SETTINGS_KEY', () => {
    const s = mk({ pheromoneOverlay: false, firstUseHints: { pan: true } });
    saveSettings(s);
    const raw = localStorage.getItem(SETTINGS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({ version: SETTINGS_VERSION, settings: s });
  });

  it('overwrites an earlier saved state', () => {
    saveSettings(mk({ pheromoneOverlay: true }));
    saveSettings(mk({ pheromoneOverlay: false }));
    expect(loadSettings()).toEqual(mk({ pheromoneOverlay: false }));
  });
});
