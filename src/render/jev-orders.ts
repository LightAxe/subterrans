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
  // Playtest 5 (2026-10-09, V74; plan/playtest-5/RESULTS.md "For Jev", B1/B6) rewrote
  // all four for what wins at V74: grow first and add a Food Storage when the stores
  // pass three quarters; mass the army at home and attack all at once; come home when
  // an attack stalls or the stores run low (a stalled raid on a military ratio starved
  // Jev in 6 of 30 stand-in games without that clause); ignore the spider (a camp
  // ends by itself within seconds). The client musters the army for the `assault`
  // posture (jev-enemy-controller.ts), so "gather them at home" is also enforced in
  // code. The older tuning notes (the 2026-09-19 Jev-vs-Jev round-robin, Economy's
  // survival sweep) predate V72/V73 and no longer describe these texts.
  {
    id: 'balanced',
    label: 'Balanced',
    // The tested one: a stand-in reading it literally (with fine buckets, the Assault
    // raid type, the muster and the ¾ storage question) won 6/8/6 of 10 against the
    // scripted human, the Normal novice and the Easy novice, and half its assaults
    // killed the queen (playtest 5, B5 `balanced3`).
    text:
      'Grow first: mostly foragers to about 25 workers, adding storage when stores pass ' +
      'three quarters. Then train mostly fighters, gather them at home and attack all at ' +
      'once: sooner if we outnumber them, later if they outnumber us. If it stalls or ' +
      'stores run low, come home and forage. Ignore the spider.',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    // Same rules as Balanced, earlier and more often. Not stand-in tested.
    text:
      'Grow to about 20 workers, adding food storage whenever stores pass three quarters. ' +
      'Then attack early and often: mostly fighters, gathered at home, all at once. Strike ' +
      'at once when we clearly outnumber them. If an attack stalls or stores run low, come ' +
      'home, regrow and go again. Ignore the spider.',
  },
  {
    id: 'turtle',
    label: 'Turtle',
    // Attacks only when clearly ahead, with a mid-game timer so it cannot wait forever
    // (B1 rule 4a: a Jev that only attacks when ahead stalls). Not stand-in tested.
    text:
      'Never leave the nest undefended. Grow steadily, adding food storage whenever stores ' +
      'pass three quarters, with a strong guard at home. Assault only when we clearly ' +
      'outnumber them, all at once, and come home if it stalls; if neither side has attacked ' +
      'by mid-game, attack anyway. Ignore the spider.',
  },
  {
    id: 'economy',
    label: 'Economy',
    // Never attacks. Not stand-in tested.
    text:
      'Survival first: keep food coming in. Keep most workers foraging the nearest pile, add ' +
      'a food storage chamber whenever stores pass three quarters, keep a small guard on our ' +
      'entrance, and never send fighters away from home. Ignore the spider.',
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
