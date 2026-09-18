// src/render/boot-overlay-layout.ts
// Phaser-free canvas-local rects for the boot-time overlays (SavePrompt,
// GameOver, DifficultySelect). Extracted from ui-scene.ts (#240) so Playwright
// specs — which run in Node and crash if they import ui-scene.ts (it transitively
// imports Phaser, which touches `window` at module load) — can import these
// coordinates from ONE source of truth instead of hand-duplicating them.
// ui-scene.ts re-exports them to preserve its public surface; values unchanged.
//
// LAYOUT DISCIPLINE NOTE (#213 / #238): these are canvas-tied absolute rects
// relocated VERBATIM from ui-scene.ts (they were already module-scope constants
// there on main). #240 is a pure decoupling refactor with a zero-coordinate-change
// invariant, so it does not convert them. Making them pure functions of
// `LayoutContext` (like pause-menu-layout.ts) is #238's tracked scope ("residual
// fixed-canvas geometry") — the save-prompt rects in particular are NOT cleanly
// centered (x=300 → button-center 360, not canvas-center 400), so their reflow
// anchors are a deliberate #238 design decision, not a mechanical rewrite. Do not
// add NEW canvas-tied constants here; the conversion happens in #238.

/** Canvas-local rect for the SavePrompt "Continue" button. */
export const SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 } as const;
/** Canvas-local rect for the SavePrompt "New Game" button. */
export const SAVE_PROMPT_NEW_GAME_RECT = { x: 300, y: 320, w: 120, h: 32 } as const;
/** Canvas-local rect for the GameOver "Restart" button. */
export const GAME_OVER_RESTART_RECT = { x: 300, y: 345, w: 120, h: 32 } as const;
/** Canvas-local rects for the DifficultySelect buttons (Easy / Normal / Hard).
 *  W3 moved the row UP (y 260 → 136) to make room for the opponent section added
 *  below it — see the "opponent picker" block at the bottom of this file. Only the
 *  Y changed; the x/w/h and the centered-as-a-group spacing are untouched, and the
 *  Playwright specs pick the values up through tests/helpers/geometry.ts. */
export const DIFFICULTY_EASY_RECT = { x: 180, y: 136, w: 140, h: 40 } as const;
export const DIFFICULTY_NORMAL_RECT = { x: 330, y: 136, w: 140, h: 40 } as const;
export const DIFFICULTY_HARD_RECT = { x: 480, y: 136, w: 140, h: 40 } as const;

// ---------------------------------------------------------------------------
// W3 — opponent picker (Jev opponent beta)
//
// The difficulty-select overlay now carries an opponent section below the three
// difficulty buttons: an "Opponent:" toggle pair (Standard AI / Jev (beta)) and,
// when Jev is chosen, a standing-orders row of presets plus an editable free-text
// field. The three difficulty buttons remain the start action, so the difficulty
// row moved UP (y 260 → 136) to make room; nothing else about it changed.
//
// Unlike the legacy rects above (which #238 still owns), this section follows the
// current layout discipline: everything canvas-RELATIVE (the horizontal centering
// of each row) is derived from `layout.w`, while canvas-INDEPENDENT values (row
// Ys measured from the overlay top, button sizes, gaps) stay plain constants —
// exactly the split survey-overlay-layout.ts uses.
// ---------------------------------------------------------------------------

import type { LayoutContext } from './layout.js';

/** Rect shape shared by the overlay geometry helpers. */
export interface BootOverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A text anchor (the Phaser Text origin is documented per field below). */
export interface BootOverlayPoint {
  x: number;
  y: number;
}

/** Title / subtitle / hint baselines for the difficulty-select overlay. All three
 *  are drawn centered on `layout.w / 2`; only the Y is fixed here. */
export const DIFFICULTY_TITLE_Y = 56;
export const DIFFICULTY_SUBTITLE_Y = 92;
export const DIFFICULTY_HINT_Y = 114;

/** Width of the opponent section's content column, centered on the canvas. The
 *  textarea and the preset row both span it, so the section reads as one block. */
const PICKER_CONTENT_W = 520;

/** Opponent-kind toggle pair ("Standard AI" / "Jev (beta)"). */
const KIND_BUTTON_W = 170;
const KIND_BUTTON_H = 34;
const KIND_BUTTON_GAP = 12;

/** Standing-orders preset buttons (Balanced / Aggressive / Turtle / Economy). */
const PRESET_BUTTON_W = 124;
const PRESET_BUTTON_H = 28;
const PRESET_BUTTON_GAP = 8;

/** Row anchors, measured down from the overlay top (canvas-independent). */
const KIND_LABEL_Y = 200;
const KIND_ROW_Y = 218;
const UNAVAILABLE_NOTE_Y = 258;
const ORDERS_LABEL_Y = 288;
const ORDERS_PRESET_ROW_Y = 306;
const ORDERS_TEXTAREA_Y = 344;
const ORDERS_TEXTAREA_H = 104;
const ORDERS_FOOTER_Y = 454;

/** Left edge of the centered content column. */
function contentX(layout: LayoutContext): number {
  return (layout.w - PICKER_CONTENT_W) / 2;
}

/** Every rect / anchor the opponent section of the overlay draws. `presetCount`
 *  is `JEV_ORDERS_PRESETS.length`, passed in so this module stays free of the
 *  orders vocabulary (and so the row re-centers if a preset is ever added). */
export interface OpponentPickerLayout {
  /** "Opponent:" caption. Text origin (0, 0). */
  kindLabel: BootOverlayPoint;
  /** "Standard AI" toggle button. */
  rulesButton: BootOverlayRect;
  /** "Jev (beta)" toggle button. */
  jevButton: BootOverlayRect;
  /** "(unavailable in this build)" note under the toggle pair. Origin (0.5, 0). */
  unavailableNote: BootOverlayPoint;
  /** "Standing orders" caption. Origin (0, 0). */
  ordersLabel: BootOverlayPoint;
  /** Preset buttons, index-aligned with JEV_ORDERS_PRESETS. */
  presetButtons: BootOverlayRect[];
  /** Free-text rect. A DOM <textarea> is positioned over it at runtime. */
  textarea: BootOverlayRect;
  /** "n/300" counter, right-aligned under the textarea. Origin (1, 0). */
  counter: BootOverlayPoint;
  /** Editing hint, left-aligned under the textarea. Origin (0, 0). */
  hint: BootOverlayPoint;
}

export function opponentPickerLayout(
  layout: LayoutContext,
  presetCount: number,
): OpponentPickerLayout {
  const left = contentX(layout);
  const kindRowW = 2 * KIND_BUTTON_W + KIND_BUTTON_GAP;
  const kindStartX = (layout.w - kindRowW) / 2;
  const presetRowW =
    presetCount > 0 ? presetCount * PRESET_BUTTON_W + (presetCount - 1) * PRESET_BUTTON_GAP : 0;
  const presetStartX = (layout.w - presetRowW) / 2;
  const presetButtons: BootOverlayRect[] = [];
  for (let i = 0; i < presetCount; i++) {
    presetButtons.push({
      x: presetStartX + i * (PRESET_BUTTON_W + PRESET_BUTTON_GAP),
      y: ORDERS_PRESET_ROW_Y,
      w: PRESET_BUTTON_W,
      h: PRESET_BUTTON_H,
    });
  }
  return {
    kindLabel: { x: left, y: KIND_LABEL_Y },
    rulesButton: { x: kindStartX, y: KIND_ROW_Y, w: KIND_BUTTON_W, h: KIND_BUTTON_H },
    jevButton: {
      x: kindStartX + KIND_BUTTON_W + KIND_BUTTON_GAP,
      y: KIND_ROW_Y,
      w: KIND_BUTTON_W,
      h: KIND_BUTTON_H,
    },
    unavailableNote: { x: layout.w / 2, y: UNAVAILABLE_NOTE_Y },
    ordersLabel: { x: left, y: ORDERS_LABEL_Y },
    presetButtons,
    textarea: { x: left, y: ORDERS_TEXTAREA_Y, w: PICKER_CONTENT_W, h: ORDERS_TEXTAREA_H },
    counter: { x: left + PICKER_CONTENT_W, y: ORDERS_FOOTER_Y },
    hint: { x: left, y: ORDERS_FOOTER_Y },
  };
}
