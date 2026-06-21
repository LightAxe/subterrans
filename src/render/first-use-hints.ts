// first-use-hints.ts — Stage 3b controls rework (issue #18, component #3).
//
// One-time, cross-session nudges for the affordance-less gestures a new player
// can't see: drag-to-pan, scroll-to-zoom, drag-to-paint-tunnels, and the ONE
// proactive nudge — [Tab] to view underground (which has no preceding gesture
// to react to: a fresh game starts on the surface with an open entrance, so the
// underground is relevant from t=0 — Codex R3).
//
// Render-only: reads ViewState + persisted settings, NEVER mutates WorldState.
// Phaser-free and decoupled from UIScene via the FirstUseHintSink interface, so
// the gating + persistence are unit-testable. UIScene supplies the sink and is
// the thing that actually queues the caption AND marks the hint shown — only
// when it begins displaying (Codex R1#9), not here at trigger time.
//
// Triggers fire on the EFFECT, not raw input (Codex R1#10): the seams that call
// triggerReactiveHint live at the input sites (gesture arbiter / wheel handler)
// and only fire once the camera actually moved / a mark was actually enqueued.

import { loadSettings, saveSettings } from '../platform/settings.js';
import { glyphFor } from './input-glyphs.js';

/** The four first-use hints. 'view-tab' is the proactive one; the rest are
 *  reactive (fired on their gesture's effect). */
export type HintFirstUseId = 'pan' | 'zoom' | 'paint' | 'view-tab';

/** Caption copy, composed from the glyph table so the symbol has one home.
 *  Wording is UAT-tuned (Rob). */
export function firstUseHintText(id: HintFirstUseId): string {
  switch (id) {
    case 'pan':
      return `${glyphFor('PAN', 'mouse')} to look around`;
    case 'zoom':
      return `${glyphFor('ZOOM', 'mouse')} to zoom`;
    case 'paint':
      return `${glyphFor('DIG_PAINT', 'mouse')} to paint tunnels`;
    case 'view-tab':
      return `Press ${glyphFor('VIEW_SWITCH', 'keyboard')} to view underground`;
  }
}

/** Sink the triggers route through. UIScene implements it (enqueue + mark-on-
 *  display); tests pass a spy. */
export interface FirstUseHintSink {
  showFirstUseHint(id: HintFirstUseId, text: string): void;
}

// ---------------------------------------------------------------------------
// Persistence (cross-session) — in-memory cache write-through to settings.
// ---------------------------------------------------------------------------

// Lazily loaded once from settings, then kept in lockstep with persisted state
// by writing through on every mutation. Null until first access so a fresh page
// load picks up the stored flags.
let shownCache: Record<string, boolean> | null = null;

function ensureLoaded(): Record<string, boolean> {
  if (shownCache === null) shownCache = loadSettings().firstUseHints;
  return shownCache;
}

export function isFirstUseHintShown(id: HintFirstUseId): boolean {
  return ensureLoaded()[id] === true;
}

/** Mark a hint shown and persist. Called by the sink the moment the caption
 *  BEGINS displaying — never at trigger/enqueue (so a dropped/interrupted queue
 *  entry isn't lost forever). Best-effort persist (saveSettings is silent on
 *  quota), but the in-mem cache is authoritative for the session. */
export function markFirstUseHintShown(id: HintFirstUseId): void {
  const cache = ensureLoaded();
  if (cache[id] === true) return;
  cache[id] = true;
  const persisted = loadSettings();
  persisted.firstUseHints = { ...persisted.firstUseHints, [id]: true };
  saveSettings(persisted);
}

/** "Reset first-use hints" (pause-menu action): clear every shown flag in memory
 *  AND persistence so the hints surface again. Also clears the per-session
 *  first-world-input latch — without this, the proactive [Tab] nudge could never
 *  re-surface in the current session, because notifyFirstWorldInput early-returns
 *  on firstWorldInputSeen (already true, since the player has, by definition, made
 *  a world input before reaching the pause menu) before it consults the
 *  now-cleared shown flag. Pending queue entries are cleared separately by
 *  UIScene. */
export function resetFirstUseHints(): void {
  shownCache = {};
  firstWorldInputSeen = false;
  const persisted = loadSettings();
  persisted.firstUseHints = {};
  saveSettings(persisted);
}

// ---------------------------------------------------------------------------
// Reactive triggers
// ---------------------------------------------------------------------------

/** Show a reactive hint if it has not been shown. The EFFECT gate (camera moved
 *  / mark enqueued) is enforced at the call site; this only guards show-once. */
export function triggerReactiveHint(sink: FirstUseHintSink, id: 'pan' | 'zoom' | 'paint'): void {
  if (isFirstUseHintShown(id)) return;
  sink.showFirstUseHint(id, firstUseHintText(id));
}

// ---------------------------------------------------------------------------
// Proactive [Tab] nudge — fired once, on the first world input of a session.
// ---------------------------------------------------------------------------

/** Pure gate for the proactive nudge: on the surface, underground not yet
 *  visited this session, and at least one entrance exists to descend through. */
export function tabNudgeGateOpen(
  activeView: 'surface' | 'underground',
  undergroundVisited: boolean,
  entranceCount: number,
): boolean {
  return activeView === 'surface' && !undergroundVisited && entranceCount > 0;
}

// Per-session: true once the player has made their first world input. Reset on
// every new round (resetFirstUseSession), alongside onboarding-captions reset.
let firstWorldInputSeen = false;

/** Reset the per-session first-world-input latch (NOT the cross-session shown
 *  flags). Called on round start. */
export function resetFirstUseSession(): void {
  firstWorldInputSeen = false;
}

/**
 * Called AFTER the player's first world input of the session is handled (Codex
 * R4): on the very first input only, evaluate the proactive [Tab] nudge. Because
 * it runs post-input, a first input that IS Tab/view-toggle has already set
 * undergroundVisited, so the gate closes and the nudge self-suppresses. Marks
 * nothing here — the sink marks on display.
 */
export function notifyFirstWorldInput(
  sink: FirstUseHintSink,
  ctx: {
    activeView: 'surface' | 'underground';
    undergroundVisited: boolean;
    entranceCount: number;
  },
): void {
  if (firstWorldInputSeen) return;
  firstWorldInputSeen = true;
  if (isFirstUseHintShown('view-tab')) return;
  if (!tabNudgeGateOpen(ctx.activeView, ctx.undergroundVisited, ctx.entranceCount)) return;
  sink.showFirstUseHint('view-tab', firstUseHintText('view-tab'));
}

/** Test-only: drop the in-memory persistence cache so the next access re-reads
 *  settings. */
export function resetFirstUseHintCacheForTests(): void {
  shownCache = null;
  firstWorldInputSeen = false;
}
