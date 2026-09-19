// jev-orders.ts — standing orders the player hands the Jev opponent.
//
// The text is sent verbatim as the encoded state's `standing_orders` field and
// referenced from every question's preamble ("Follow `standing_orders` above
// everything else"). The spike's instruction-sensitivity sweep showed every
// preset below moves Jev's play measurably, which is why they ship as presets
// rather than free text only.
//
// Every preset — including `balanced` — carries tuned, non-empty text.
// `balanced` is also the DEFAULT: a fresh player with no saved preference sees
// it pre-selected (see DEFAULT_ORDERS_TEXT below, and its callers in
// opponent-picker-state.ts / platform/settings.ts). An empty orders string is a
// SEPARATE, deliberate state — "no standing orders at all" — reached only by
// clearing the text box; it highlights no preset and sends no `standing_orders`
// field, so Jev judges from the state alone. `ordersTextForPreset` returning
// `''` for an unrecognized id is an unrelated defensive fallback, not a preset.

/** Hard cap on a standing-orders string, enforced by `normalizeOrders`. */
export const JEV_ORDERS_MAX_LENGTH = 300;

export type JevOrdersPresetId = 'balanced' | 'aggressive' | 'turtle' | 'economy';

export interface JevOrdersPreset {
  readonly id: JevOrdersPresetId;
  readonly label: string;
  /** Always non-empty — see the file header. (An empty `standing_orders` field
   *  is a separate "no orders at all" state, not a preset.) */
  readonly text: string;
}

export const JEV_ORDERS_PRESETS: readonly JevOrdersPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    // Tuned default. Jev-vs-Jev round-robin (2026-09-19, 8 texts × 6 seeds × both seats,
    // 336 matches): 75.0% win rate (Wilson 64.8–83.0), no losing matchup, 40% of its wins
    // by queen kill — a long build followed by a decisive assault.
    text:
      'Spend the early game entirely on food and growth with fighters at home. Once our colony ' +
      'is large and stores are high, switch to mostly fighters and assault the opponent ' +
      'entrance until their queen is dead.',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    // Tournament #2 (63.1%): assaults in ~70% of matches — constant pressure. The old
    // 'strike early, accept losses' text finished last (28.6%, zero queen kills): it starved.
    text:
      'Build a strong economy and a small guard. Watch the opponent: whenever they are weaker ' +
      'than us or their fighters are away, assault their entrance with everything; otherwise ' +
      'stay home and grow.',
  },
  {
    id: 'turtle',
    label: 'Turtle',
    text:
      'Never leave the nest undefended. Keep fighters at home and fight only with overwhelming ' +
      'force. Grow steadily; only assault when we clearly outnumber the opponent.',
  },
  {
    id: 'economy',
    label: 'Economy',
    // Survival-sweep winner (10/20 vs the rule-based AI, median 9,128 ticks); never assaults.
    text:
      'Survival first: keep our food stores rising. Keep most workers foraging the nearest ' +
      'pile, keep a small guard on our entrance, dig only when stores are high, and never send ' +
      'fighters away from home.',
  },
];

/**
 * Canonicalize a standing-orders string before it goes on the wire or into a save:
 * trim, collapse every whitespace run (including newlines) to a single space, and
 * cap at JEV_ORDERS_MAX_LENGTH characters. The cap keeps the encoded state well
 * under the proxy's 16 KB limit even with a hostile paste.
 */
export function normalizeOrders(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, JEV_ORDERS_MAX_LENGTH);
}

/** Look up a preset's normalized text by id; unknown ids yield `''` (a defensive
 *  fallback, NOT the `balanced` preset — every shipped preset's text is
 *  non-empty; see DEFAULT_ORDERS_TEXT for the `balanced` text specifically). */
export function ordersTextForPreset(id: string): string {
  const preset = JEV_ORDERS_PRESETS.find((p) => p.id === id);
  return preset === undefined ? '' : normalizeOrders(preset.text);
}

/**
 * The `balanced` preset's (normalized) text — the DEFAULT standing orders for a
 * player with no saved preference. Consumed by opponent-picker-state.ts's
 * createOpponentPickerState (via the caller-supplied `savedOrders`) and by
 * platform/settings.ts's `DEFAULT_SETTINGS.jevOrders`, which duplicates this
 * string locally rather than importing it, to keep platform/ free of a runtime
 * dependency on render/ (mirrors MAX_OPPONENT_ORDERS_LENGTH in save.ts). A
 * settings.test.ts check cross-references the two so they cannot drift apart
 * silently.
 */
export const DEFAULT_ORDERS_TEXT: string = ordersTextForPreset('balanced');
