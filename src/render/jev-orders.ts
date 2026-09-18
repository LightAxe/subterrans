// jev-orders.ts — standing orders the player hands the Jev opponent.
//
// The text is sent verbatim as the encoded state's `standing_orders` field and
// referenced from every question's preamble ("Follow `standing_orders` above
// everything else"). The spike's instruction-sensitivity sweep showed the three
// non-empty presets below move Jev's play measurably, which is why they ship as
// presets rather than free text only.
//
// `balanced` is the empty preset: no `standing_orders` field is sent at all, so
// Jev judges from the state alone.

/** Hard cap on a standing-orders string, enforced by `normalizeOrders`. */
export const JEV_ORDERS_MAX_LENGTH = 300;

export type JevOrdersPresetId = 'balanced' | 'aggressive' | 'turtle' | 'economy';

export interface JevOrdersPreset {
  readonly id: JevOrdersPresetId;
  readonly label: string;
  /** Empty string = send no `standing_orders` field. */
  readonly text: string;
}

export const JEV_ORDERS_PRESETS: readonly JevOrdersPreset[] = [
  { id: 'balanced', label: 'Balanced', text: '' },
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

/** Look up a preset's normalized text by id; unknown ids yield `''` (= balanced). */
export function ordersTextForPreset(id: string): string {
  const preset = JEV_ORDERS_PRESETS.find((p) => p.id === id);
  return preset === undefined ? '' : normalizeOrders(preset.text);
}
