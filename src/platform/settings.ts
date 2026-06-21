// src/platform/settings.ts
// Issue #116 — UI/render preferences persisted across sessions.
//
// Distinct from save.ts:
//   - save.ts stores the simulation snapshot + replay log (subterrans:save:v3).
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
  /** Stage 3b (issue #18) — visibility of the static per-tool hint-strip legend.
   *  When false, only the legend is hidden; the paused-queue-full warning and
   *  caption-yield still render. Default true. Render-only. */
  hintStripVisible: boolean;
  /** Stage 3b (issue #18) — cross-session "already shown" flags for the one-time
   *  first-use navigation hints, keyed by HintFirstUseId. A JSON-safe Record
   *  (NOT a Set, which JSON.stringify flattens to `{}` — Codex R1#4). A hint is
   *  marked here only once it actually begins displaying (Codex R1#9). Render-only. */
  firstUseHints: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  pheromoneOverlay: true,
  hintStripVisible: true,
  firstUseHints: {},
};

interface SettingsEnvelope {
  version: number;
  settings: Settings;
}

/** A fresh defaults object. NEVER return `{ ...DEFAULT_SETTINGS }` directly: the
 *  shallow spread copies primitives but SHARES the nested `firstUseHints` object,
 *  so a caller that mutates it (markFirstUseHintShown) would poison the module-
 *  level default for every later load. This deep-copies the mutable field. */
function freshDefaults(): Settings {
  return { ...DEFAULT_SETTINGS, firstUseHints: { ...DEFAULT_SETTINGS.firstUseHints } };
}

/** Load settings from localStorage. Returns DEFAULT_SETTINGS if missing,
 *  malformed, or for any version beyond SETTINGS_VERSION. Never throws. */
export function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return freshDefaults();
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return freshDefaults();
  }
  if (raw === null) return freshDefaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshDefaults();
  }
  if (parsed === null || typeof parsed !== 'object') return freshDefaults();
  const env = parsed as Partial<SettingsEnvelope>;
  if (typeof env.version !== 'number' || env.version > SETTINGS_VERSION) {
    return freshDefaults();
  }
  if (env.settings === null || typeof env.settings !== 'object') {
    return freshDefaults();
  }
  // Permissive merge: unknown keys ignored, missing keys filled from defaults.
  // Type-check each known field; reject the value (fall back to default) if
  // its type is wrong rather than the whole envelope, so a single corrupt key
  // doesn't wipe valid neighbors.
  const s = env.settings as Partial<Settings>;
  return {
    pheromoneOverlay:
      typeof s.pheromoneOverlay === 'boolean'
        ? s.pheromoneOverlay
        : DEFAULT_SETTINGS.pheromoneOverlay,
    hintStripVisible:
      typeof s.hintStripVisible === 'boolean'
        ? s.hintStripVisible
        : DEFAULT_SETTINGS.hintStripVisible,
    firstUseHints: sanitizeFirstUseHints(s.firstUseHints),
  };
}

/** Coerce an unknown blob into a clean Record<string, boolean>: keep only own
 *  string keys whose value is a boolean, drop everything else. A non-object
 *  (missing / corrupt / a stringified Set's `{}` from an older build) yields an
 *  empty record. Keeps a single corrupt entry from poisoning the whole field. */
function sanitizeFirstUseHints(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
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
