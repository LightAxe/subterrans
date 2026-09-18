import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SURVEY_EMAIL_MAX,
  type Settings,
} from './settings.js';
// Cross-layer import in a TEST only: the point is to prove the two constants
// agree. Production platform/ code must not import from render/.
import { PLAYTRACE_EMAIL_MAX } from '../render/playtrace-upload.js';

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

  // ---------------------------------------------------------------------------
  // W3 — opponent preference (Jev opponent beta)
  // ---------------------------------------------------------------------------

  it('defaults the opponent to the rule-based AI', () => {
    expect(loadSettings().opponent).toEqual({ kind: 'rules' });
  });

  it('round-trips a jev opponent preference including the free text', () => {
    const next = mk({ opponent: { kind: 'jev', orders: 'press the entrance' } });
    saveSettings(next);
    expect(loadSettings()).toEqual(next);
  });

  it('round-trips a jev preference with empty orders (the `balanced` preset)', () => {
    saveSettings(mk({ opponent: { kind: 'jev', orders: '' } }));
    expect(loadSettings().opponent).toEqual({ kind: 'jev', orders: '' });
  });

  it('fills the opponent default for a blob written before W3 (no version bump)', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { pheromoneOverlay: false, hintStripVisible: true, firstUseHints: {} },
      }),
    );
    expect(loadSettings()).toEqual(mk({ pheromoneOverlay: false }));
  });

  it('replaces a malformed opponent with the default but keeps valid siblings', () => {
    const malformed: unknown[] = [
      null,
      'jev',
      42,
      [],
      {},
      { kind: 'random' },
      { kind: 'jev' }, // orders missing
      { kind: 'jev', orders: 7 }, // orders wrong type
      { kind: 'rules', orders: 'ignored' }, // extra key is fine — still `rules`
    ];
    for (const opponent of malformed) {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          version: SETTINGS_VERSION,
          settings: { hintStripVisible: false, opponent },
        }),
      );
      const loaded = loadSettings();
      expect(loaded.opponent).toEqual({ kind: 'rules' });
      expect(loaded.hintStripVisible).toBe(false); // sibling survived
    }
  });

  it('accepts an over-long orders string (the render layer owns the length cap)', () => {
    // Mirrors save.ts: the envelope/settings validator checks SHAPE only, so a
    // tampered blob can't brick the file; jevOpponent / the picker cap the text
    // before it reaches the wire.
    const long = 'z'.repeat(5000);
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { opponent: { kind: 'jev', orders: long } },
      }),
    );
    expect(loadSettings().opponent).toEqual({ kind: 'jev', orders: long });
  });

  it('hands out a fresh opponent object per load (no shared default reference)', () => {
    const a = loadSettings();
    const b = loadSettings();
    expect(a.opponent).not.toBe(b.opponent);
    expect(a.opponent).not.toBe(DEFAULT_SETTINGS.opponent);
    // Mutating a load must not poison the module-level default.
    (a.opponent as { kind: string }).kind = 'jev';
    expect(loadSettings().opponent).toEqual({ kind: 'rules' });
    expect(DEFAULT_SETTINGS.opponent).toEqual({ kind: 'rules' });
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

// ---------------------------------------------------------------------------
// #303 — remembered survey email
// ---------------------------------------------------------------------------

describe('surveyEmail (#303)', () => {
  it('defaults to the empty string (no remembered address)', () => {
    expect(loadSettings().surveyEmail).toBe('');
  });

  it('round-trips a saved address', () => {
    saveSettings(mk({ surveyEmail: 'player@example.com' }));
    expect(loadSettings().surveyEmail).toBe('player@example.com');
  });

  it('loads a pre-#303 settings blob without wiping its other fields', () => {
    // The additive-key contract: SETTINGS_VERSION was deliberately NOT bumped,
    // because a bump invalidates the whole blob and a missing key already falls
    // back to its default. This pins that behaviour.
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: {
          pheromoneOverlay: false,
          hintStripVisible: false,
          firstUseHints: { pan: true },
        },
      }),
    );
    const loaded = loadSettings();
    expect(loaded.surveyEmail).toBe('');
    expect(loaded.pheromoneOverlay).toBe(false);
    expect(loaded.hintStripVisible).toBe(false);
    expect(loaded.firstUseHints).toEqual({ pan: true });
  });

  it('falls back to the default when the stored value is not a string', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, settings: { surveyEmail: 42 } }),
    );
    expect(loadSettings().surveyEmail).toBe('');
  });

  it('caps at the same length the wire boundary does', () => {
    // SURVEY_EMAIL_MAX and PLAYTRACE_EMAIL_MAX are deliberately separate
    // constants (platform/ must not import from render/), so this is the only
    // thing stopping them drifting. If they diverge, a remembered address could
    // be stored at a length the envelope then silently drops.
    expect(SURVEY_EMAIL_MAX).toBe(PLAYTRACE_EMAIL_MAX);
  });

  it('truncates an over-long stored value instead of growing unbounded', () => {
    const huge = 'x'.repeat(SURVEY_EMAIL_MAX + 100);
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, settings: { surveyEmail: huge } }),
    );
    expect(loadSettings().surveyEmail).toHaveLength(SURVEY_EMAIL_MAX);
  });
});

describe('difficulty (#304)', () => {
  it('defaults to Normal', () => {
    expect(DEFAULT_SETTINGS.difficulty).toBe('Normal');
    expect(loadSettings().difficulty).toBe('Normal');
  });

  it('round-trips each tier', () => {
    for (const tier of ['Easy', 'Normal', 'Hard'] as const) {
      saveSettings(mk({ difficulty: tier }));
      expect(loadSettings().difficulty).toBe(tier);
    }
  });

  it('loads a pre-#304 settings blob (no difficulty key) as Normal without wiping its other fields', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: SETTINGS_VERSION,
        settings: {
          pheromoneOverlay: false,
          hintStripVisible: false,
          firstUseHints: { a: true },
          surveyEmail: 'player@example.com',
        },
      }),
    );
    const loaded = loadSettings();
    expect(loaded.difficulty).toBe('Normal');
    expect(loaded.pheromoneOverlay).toBe(false);
    expect(loaded.hintStripVisible).toBe(false);
    expect(loaded.firstUseHints).toEqual({ a: true });
    expect(loaded.surveyEmail).toBe('player@example.com');
  });

  it('falls back to Normal when the stored value is not a tier name, keeping valid siblings', () => {
    for (const bad of ['easy', 'Impossible', 1, null, { tier: 'Hard' }]) {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          version: SETTINGS_VERSION,
          settings: { difficulty: bad, pheromoneOverlay: false },
        }),
      );
      const loaded = loadSettings();
      expect(loaded.difficulty, JSON.stringify(bad)).toBe('Normal');
      expect(loaded.pheromoneOverlay).toBe(false);
    }
  });
});
