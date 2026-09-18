// opponent-picker-state.ts — the pure state machine behind the difficulty-select
// overlay's opponent section (W3).
//
// UIScene owns the Phaser objects and the DOM <textarea>; ALL of the decision
// logic — which toggle is lit, which preset is highlighted, what the free text
// currently is, and what OpponentConfig the choice commits to — lives here so it
// can be unit-tested headlessly (same split as context-menu-state.ts /
// survey-overlay-layout.ts). Every transition returns a NEW state object; nothing
// here mutates its input or touches Phaser, the DOM, or storage.
//
// Two rules the overlay depends on:
//   1. Picking a preset OVERWRITES the free text with that preset's text.
//   2. Editing the free text un-highlights every preset (the choice is "custom").
// A `balanced` preset is the empty string, which is the "send no standing_orders
// field at all" convention documented in jev-orders.ts.

import { DEFAULT_OPPONENT, jevOpponent, type OpponentConfig } from './opponent-config.js';
import {
  JEV_ORDERS_MAX_LENGTH,
  JEV_ORDERS_PRESETS,
  normalizeOrders,
  ordersTextForPreset,
  type JevOrdersPresetId,
} from './jev-orders.js';

export interface OpponentPickerState {
  /** Which opponent the player currently has selected. */
  readonly kind: OpponentConfig['kind'];
  /** Highlighted preset, or null when the free text has been edited ("custom"). */
  readonly presetId: JevOrdersPresetId | null;
  /** Live free-text contents. Capped at JEV_ORDERS_MAX_LENGTH but NOT otherwise
   *  normalized — the player must be able to type a trailing space. Trimming /
   *  whitespace collapsing happens once, in {@link toConfig}. */
  readonly text: string;
  /** False when the build has no Jev proxy endpoint: the Jev toggle renders
   *  disabled and `kind` can never leave `'rules'`. */
  readonly jevAvailable: boolean;
}

/** The preset whose text matches `text`, or null when nothing matches. Used to
 *  re-highlight a preset when a persisted preference is loaded back. */
function presetMatching(text: string): JevOrdersPresetId | null {
  const normalized = normalizeOrders(text);
  const preset = JEV_ORDERS_PRESETS.find((p) => normalizeOrders(p.text) === normalized);
  return preset === undefined ? null : preset.id;
}

/**
 * Seed the picker from the player's persisted preference (settings.opponent).
 * A `jev` preference on a build without the endpoint is downgraded to `rules`
 * here — the same downgrade GameScene.effectiveOpponent applies at boot — while
 * the remembered orders text is kept so the choice survives a build that has the
 * endpoint again. Over-long persisted text (hand-edited localStorage) is capped.
 */
export function createOpponentPickerState(args: {
  saved: OpponentConfig;
  jevAvailable: boolean;
}): OpponentPickerState {
  const { saved, jevAvailable } = args;
  const text = saved.kind === 'jev' ? saved.orders.slice(0, JEV_ORDERS_MAX_LENGTH) : '';
  return {
    kind: saved.kind === 'jev' && jevAvailable ? 'jev' : 'rules',
    presetId: presetMatching(text),
    text,
    jevAvailable,
  };
}

/**
 * Flip the Standard AI / Jev toggle. Selecting Jev on a build without the proxy
 * endpoint is a no-op (the button renders disabled, but the guard is kept here so
 * the state can never describe something the build cannot run). The orders text
 * and preset survive a round-trip through `rules`.
 */
export function toggleKind(
  state: OpponentPickerState,
  kind: OpponentConfig['kind'],
): OpponentPickerState {
  const next = kind === 'jev' && !state.jevAvailable ? 'rules' : kind;
  if (next === state.kind) return state;
  return { ...state, kind: next };
}

/** Highlight a preset and overwrite the free text with its (normalized) text. */
export function selectPreset(
  state: OpponentPickerState,
  id: JevOrdersPresetId,
): OpponentPickerState {
  return { ...state, presetId: id, text: ordersTextForPreset(id) };
}

/**
 * Accept a free-text edit. The text is capped at JEV_ORDERS_MAX_LENGTH (the DOM
 * textarea enforces the same cap, so this is the belt to its braces) and every
 * preset is un-highlighted — the orders are now the player's own.
 */
export function editText(state: OpponentPickerState, raw: string): OpponentPickerState {
  return { ...state, presetId: null, text: raw.slice(0, JEV_ORDERS_MAX_LENGTH) };
}

/**
 * The OpponentConfig this choice commits to. `rules` (including every
 * Jev-unavailable case) yields DEFAULT_OPPONENT; `jev` normalizes the free text
 * through jevOpponent, so trailing whitespace and newlines never reach the wire
 * or the save envelope.
 */
export function toConfig(state: OpponentPickerState): OpponentConfig {
  if (state.kind !== 'jev' || !state.jevAvailable) return DEFAULT_OPPONENT;
  return jevOpponent(state.text);
}

/** True when `id` is the highlighted preset. */
export function isPresetSelected(state: OpponentPickerState, id: JevOrdersPresetId): boolean {
  return state.presetId === id;
}

/** The live "n/300" counter drawn under the textarea. Counts the RAW characters
 *  the player has typed (what the textarea's own maxlength limits), not the
 *  post-normalization length — otherwise the counter would jump around while
 *  typing a space run. */
export function formatOrdersCounter(state: OpponentPickerState): string {
  return `${state.text.length}/${JEV_ORDERS_MAX_LENGTH}`;
}
