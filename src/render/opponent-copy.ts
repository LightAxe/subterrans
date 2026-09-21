// src/render/opponent-copy.ts
// #304 items 3–4 (Jev opponent beta) — the new-game screen's opponent section
// strings: the section caption, the two radio rows' name + one-liner, and the
// caption over the free-text box. Kept apart from difficulty-copy.ts (main's
// file) so the Jev branch's copy rebases without touching it; pinned by
// opponent-copy.test.ts the same way. Pure TypeScript, no Phaser.

import type { OpponentKind } from './boot-overlay-layout.js';

/** Caption over the two opponent rows — the "Difficulty" caption's twin. */
export const NEW_GAME_OPPONENT_CAPTION = 'Opponent';

/** Name + ONE-line description per row. The rows are a single line tall
 *  (OPPONENT_ROW_H), so a description must fit the row's description column
 *  without wrapping — opponent-copy.test.ts guards the length. */
export const OPPONENT_ROW_COPY: Readonly<
  Record<OpponentKind, { readonly name: string; readonly desc: string }>
> = {
  rules: { name: 'Standard AI', desc: 'The built-in rule-based enemy colony.' },
  jev: { name: 'Jev (beta)', desc: "TypeSafe's Jev model plays the enemy; you can instruct it." },
};

/** Caption over the free-text box, and the box's accessible name: it says whose
 *  instructions these are (the issue's item 4 — "Standing orders" did not). */
export const JEV_ORDERS_CAPTION = 'Custom instructions for Jev, your opponent';

/** The empty box's placeholder. */
export const JEV_ORDERS_PLACEHOLDER = 'Tell Jev how to play (optional)';
