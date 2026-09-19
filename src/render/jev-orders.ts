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
    // Tuned default (2026-09-19 sweep, 6 texts × 20 seeds): 10/20 wins, median survival
    // 9,128 ticks, 12.6 workers at end — vs 4/20 / 6,454 / 3.4 with no orders at all.
    text:
      'Survival first: keep our food stores rising. Keep most workers foraging the nearest pile, ' +
      'keep a small guard on our entrance, dig only when stores are high, and never send fighters ' +
      'away from home.',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    text:
      'Strike early and keep striking. Accept losses. Keep pressure on the opponent entrance ' +
      'whenever we have any fighters to send; favor fight over forage.',
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
    text:
      'Maximize colony growth and stored food. Keep almost everyone foraging and digging. ' +
      'Fight only when we are attacked or the spider threatens our entrance.',
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
