// src/platform/settings.ts
// Issue #116 — UI/render preferences persisted across sessions.
//
// Distinct from save.ts:
//   - save.ts stores the simulation snapshot + replay log (subterrans:save:v4).
//     Subject to format-version bumps that intentionally invalidate old saves.
//   - settings.ts stores cosmetic preferences (subterrans:settings:v1). Survives
//     deleteSave(); never round-trips through replay.
//
// Storage shape is permissive: missing keys fall back to defaults so a future
// build that adds a new setting can read older settings files without forcing
// a wipe. A version field is included for forward compatibility — bumping it
// is the explicit opt-out (mirrors save.ts's invalidate-on-bump policy, but
// for settings the bump should be vanishingly rare since defaults can usually
// substitute for unknown keys).

export const SETTINGS_KEY = 'subterrans:settings:v1' as const;
export const SETTINGS_VERSION = 1 as const;

export interface Settings {
  /** Pheromone trail overlay visibility (issue #114). When false, the player's
   *  pheromone overlay is not drawn. Render-only; does not affect simulation. */
  pheromoneOverlay: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  pheromoneOverlay: true,
};

interface SettingsEnvelope {
  version: number;
  settings: Settings;
}

/** Load settings from localStorage. Returns DEFAULT_SETTINGS if missing,
 *  malformed, or for any version beyond SETTINGS_VERSION. Never throws. */
export function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (raw === null) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
  const env = parsed as Partial<SettingsEnvelope>;
  if (typeof env.version !== 'number' || env.version > SETTINGS_VERSION) {
    return { ...DEFAULT_SETTINGS };
  }
  if (env.settings === null || typeof env.settings !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  // Permissive merge: unknown keys ignored, missing keys filled from defaults.
  // Type-check each known field; reject the value (fall back to default) if
  // its type is wrong rather than the whole envelope, so a single corrupt key
  // doesn't wipe valid neighbors.
  const s = env.settings as Partial<Settings>;
  return {
    pheromoneOverlay: typeof s.pheromoneOverlay === 'boolean'
      ? s.pheromoneOverlay
      : DEFAULT_SETTINGS.pheromoneOverlay,
  };
}

/** Persist settings to localStorage. Silent on quota / availability errors —
 *  settings are nice-to-have, not load-bearing. */
export function saveSettings(settings: Settings): void {
  if (typeof localStorage === 'undefined') return;
  const env: SettingsEnvelope = {
    version: SETTINGS_VERSION,
    settings,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(env));
  } catch {
    // Quota exceeded, private browsing restrictions, etc. — best-effort.
  }
}
