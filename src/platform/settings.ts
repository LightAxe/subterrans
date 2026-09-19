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

import type { WorldState } from '../sim/types.js';
// TYPE-ONLY import (erased at build time), mirroring save.ts: the opponent
// vocabulary is owned by the render layer, and platform/ must not gain a runtime
// dependency on it. The structural validator below is deliberately LOCAL, next to
// the other field validators, for exactly that reason.
import type { OpponentConfig } from '../render/opponent-config.js';

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
  /** Issue #303 — last address typed into the end-of-game survey's optional
   *  email field, so a returning player doesn't retype it. LOCAL ONLY: it is
   *  never read by the sim and leaves the machine only when the player submits
   *  a survey. `''` means "no remembered address". Stored as typed (trimmed +
   *  capped) rather than only-when-valid, so the box round-trips what the
   *  player last saw and a typo stays visible instead of being silently
   *  dropped and forgotten. */
  surveyEmail: string;
  /** Issue #304 — the difficulty tier the player last STARTED a round on, so
   *  the new-game screen comes back with that row selected. Default Normal.
   *  Render-only: the tier a round actually runs at lives on WorldState and
   *  round-trips through the save; this is just the screen's initial selection. */
  difficulty: WorldState['difficulty'];
  /** W3 (Jev opponent beta) — the opponent the difficulty-select overlay
   *  pre-selects for the next new game, including the Jev standing-orders free
   *  text. Written when the player starts a round. Render-only: the simulation
   *  never sees it, and a `jev` preference on a build without the proxy endpoint
   *  is downgraded to the rule-based AI at boot. Default `{ kind: 'rules' }`. */
  opponent: OpponentConfig;
  /** W3 — the last standing-orders text the player wrote, kept SEPARATELY from
   *  `opponent` on purpose. The `rules` arm of OpponentConfig has nowhere to put
   *  it, so persisting only `opponent` would throw a 300-character hand-written
   *  order away the moment the player starts one round against the Standard AI.
   *  Written whenever a Jev round starts; never cleared by choosing Standard AI.
   *  Defaults to the `balanced` preset's tuned text (DEFAULT_JEV_ORDERS below),
   *  so a fresh player's first look at the standing-orders box shows tuned
   *  orders, not a blank one. `''` remains meaningful on its own terms: it is
   *  what a player gets back after explicitly clearing the box, and means "no
   *  standing orders at all" (jevOpponent('') sends no `standing_orders` field).
   *  Render-only. */
  jevOrders: string;
}

/** Cap on the remembered address (RFC 5321 max forward-path length). The wire
 *  boundary enforces the same number as PLAYTRACE_EMAIL_MAX; the two are
 *  duplicated rather than shared because platform/ must not import from render/,
 *  and pulling a wire constant DOWN into platform/ would put the playtrace
 *  contract in the wrong layer. settings.test.ts asserts they are equal so they
 *  cannot drift — same arrangement as save.ts's MAX_OPPONENT_ORDERS_LENGTH. */
export const SURVEY_EMAIL_MAX = 254;

/** The `balanced` preset's text (render/jev-orders.ts's `DEFAULT_ORDERS_TEXT`),
 *  duplicated — not imported — to keep platform/ free of a runtime dependency on
 *  render/ (mirrors `MAX_OPPONENT_ORDERS_LENGTH` in save.ts). settings.test.ts
 *  cross-checks this literal against the render-layer original so the two
 *  cannot drift apart silently. */
const DEFAULT_JEV_ORDERS =
  'Survival first: keep our food stores rising. Keep most workers foraging the nearest pile, ' +
  'keep a small guard on our entrance, dig only when stores are high, and never send fighters ' +
  'away from home.';

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  pheromoneOverlay: true,
  hintStripVisible: true,
  firstUseHints: {},
  surveyEmail: '',
  difficulty: 'Normal',
  opponent: { kind: 'rules' },
  jevOrders: DEFAULT_JEV_ORDERS,
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
  return {
    ...DEFAULT_SETTINGS,
    firstUseHints: { ...DEFAULT_SETTINGS.firstUseHints },
    opponent: cloneOpponent(DEFAULT_SETTINGS.opponent),
  };
}

/** Copy an OpponentConfig field-by-field. Same reason as firstUseHints above: the
 *  default is a module-level object, and handing callers a shared reference is a
 *  footgun waiting for the first caller that decides to mutate it. Written as an
 *  explicit branch rather than a spread so the discriminated union survives. */
function cloneOpponent(value: OpponentConfig): OpponentConfig {
  return value.kind === 'jev' ? { kind: 'jev', orders: value.orders } : { kind: 'rules' };
}

/** Structural validator for the `opponent` field, deliberately local (see the
 *  type-only import note at the top). Accepts only the two shapes
 *  render/opponent-config.ts can produce; anything else falls back to the
 *  default. The orders string is NOT length-capped here — the render layer
 *  normalizes and caps it (`jevOpponent` / `createOpponentPickerState`) before it
 *  can reach the wire, exactly as save.ts's envelope validator does. */
function isOpponentSetting(value: unknown): value is OpponentConfig {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'rules') return true;
  if (kind !== 'jev') return false;
  return typeof (value as { orders?: unknown }).orders === 'string';
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
    surveyEmail: clampStoredSurveyEmail(s.surveyEmail),
    difficulty: isDifficulty(s.difficulty) ? s.difficulty : DEFAULT_SETTINGS.difficulty,
    opponent: isOpponentSetting(s.opponent)
      ? cloneOpponent(s.opponent)
      : cloneOpponent(DEFAULT_SETTINGS.opponent),
    jevOrders: typeof s.jevOrders === 'string' ? s.jevOrders : DEFAULT_SETTINGS.jevOrders,
  };
}

/** Type guard for the stored difficulty tier: exactly one of the three tier
 *  names the sim accepts (CONTEXT.md → "Difficulty"). Anything else — a missing
 *  key on a pre-#304 blob, a hand-edited string, a number — falls back to the
 *  default rather than reaching createScenario as an unknown tier. */
function isDifficulty(raw: unknown): raw is WorldState['difficulty'] {
  return raw === 'Easy' || raw === 'Normal' || raw === 'Hard';
}

/** Coerce an unknown blob into a storable email string: a non-string (missing /
 *  corrupt) yields the default `''`, and an over-long value is TRUNCATED to
 *  SURVEY_EMAIL_MAX rather than rejected, so a settings blob hand-edited to a
 *  huge string can't grow without bound across load/save cycles.
 *
 *  Deliberately NOT named `sanitizeSurveyEmail`: playtrace-upload.ts has a
 *  function by that name with the opposite failure semantics (it DROPS an
 *  over-long or malformed address instead of truncating it), and the two modules
 *  sit one import apart. This one only clamps storage; it does no format
 *  validation at all, because rejecting a half-typed address at load time would
 *  throw away the player's work for no benefit. Validation belongs at the wire
 *  boundary, where dropping is the safe answer. */
function clampStoredSurveyEmail(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS.surveyEmail;
  return raw.length <= SURVEY_EMAIL_MAX ? raw : raw.slice(0, SURVEY_EMAIL_MAX);
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
