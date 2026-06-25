// survey-overlay-layout.ts — issue #122 end-of-game survey overlay layout.
//
// Pure-TypeScript module (no Phaser, no DOM) mirroring the pattern in
// pause-menu-layout.ts and save-load-dialog-layout.ts: defines geometry +
// hit-testing for the overlay so UIScene can spin up Phaser game objects
// against fixed rects and Vitest can exercise hit-testing headlessly.
//
// Visual layout (canvas-local pixels):
//
//   Title:              "Thanks for playing" / "Tell us what you think"
//   Rating row:         five rating buttons 1..5, horizontal stack
//   Free-text:          single-line edit affordance (full editing happens
//                       via a DOM input — see ui-scene.ts; this layout
//                       reserves the rect)
//   "Report as broken" checkbox row
//   "Upload diagnostic snapshot" checkbox row + consent disclosure text
//   Buttons:            [ Submit ] [ Skip ]
//
// The overlay is shown either at game-over (replacing the bare GameOver
// overlay) or after the pause menu's "Quit & feedback" action. Layout is
// identical between the two — only the title string differs slightly so
// the player can tell the two paths apart (handled in UIScene at draw time).
//
// Issue #213 — layout discipline: canvas-relative geometry (panel bottom, full-
// width rows, horizontally-centered button/rating groups) is a pure function of
// a LayoutContext rather than a local SURVEY_CANVAS_W/H. Canvas-INDEPENDENT
// anchors (the top inset, fixed row Ys, checkbox squares, button sizes) stay
// constants — a resize only has to move the canvas-relative values.

import type { LayoutContext } from './layout.js';

/** Shared rect shape for the overlay's geometry helpers. */
export interface SurveyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Overall modal panel inset from the canvas edges. PANEL_INSET_X and the
 *  PANEL_TOP_Y anchor are canvas-INDEPENDENT; the panel BOTTOM is inset from the
 *  canvas bottom edge, so it derives from the LayoutContext. */
const PANEL_INSET_X = 80;
const PANEL_TOP_Y = 60;
function panelBottomY(layout: LayoutContext): number {
  return layout.h - 60;
}

/** Title baseline Y — fixed offset from the panel top so the title doesn't
 *  drift when other rows resize. */
export const SURVEY_TITLE_Y = PANEL_TOP_Y + 30;

/** Vertical anchor for the rating row — five buttons across, centered. */
export const SURVEY_RATING_ROW_Y = PANEL_TOP_Y + 115;
export const SURVEY_RATING_BUTTON_W = 56;
export const SURVEY_RATING_BUTTON_H = 56;
export const SURVEY_RATING_BUTTON_GAP = 12;

/** Free-text affordance anchors. Y/H are canvas-INDEPENDENT (the checkbox rows
 *  anchor off them); only the WIDTH spans the panel, so the rect itself is a
 *  function of the LayoutContext — see {@link surveyFreeTextRect}. */
export const SURVEY_FREE_TEXT_Y = SURVEY_RATING_ROW_Y + SURVEY_RATING_BUTTON_H + 30;
export const SURVEY_FREE_TEXT_H = 100;

/** Free-text input rect — a single-line affordance. DOM input element is
 *  positioned over this rect at runtime by UIScene. Width spans the panel
 *  (canvas-relative), so this is derived from the LayoutContext. */
export function surveyFreeTextRect(layout: LayoutContext): SurveyRect {
  return {
    x: PANEL_INSET_X,
    y: SURVEY_FREE_TEXT_Y,
    w: layout.w - 2 * PANEL_INSET_X,
    h: SURVEY_FREE_TEXT_H,
  };
}

/** Checkbox row constants — used by both the "Report as broken" and
 *  "Upload diagnostic snapshot" rows. */
export const SURVEY_CHECKBOX_SIZE = 20;
export const SURVEY_CHECKBOX_LABEL_GAP = 12;

export const SURVEY_BROKEN_CHECKBOX_Y = SURVEY_FREE_TEXT_Y + SURVEY_FREE_TEXT_H + 20;
export const SURVEY_UPLOAD_CHECKBOX_Y = SURVEY_BROKEN_CHECKBOX_Y + SURVEY_CHECKBOX_SIZE + 16;
/** Two-line consent disclosure sits below the upload checkbox, indented to
 *  align with the label text. */
export const SURVEY_CONSENT_TEXT_Y = SURVEY_UPLOAD_CHECKBOX_Y + SURVEY_CHECKBOX_SIZE + 6;

/** Visible checkbox square rendered by UIScene. The clickable row hit zone is
 *  wider — see {@link surveyBrokenRowHitRect}. Canvas-independent (fixed inset
 *  + size). */
export const SURVEY_BROKEN_CHECKBOX_RECT = {
  x: PANEL_INSET_X,
  y: SURVEY_BROKEN_CHECKBOX_Y,
  w: SURVEY_CHECKBOX_SIZE,
  h: SURVEY_CHECKBOX_SIZE,
} as const;

/** Visible checkbox square rendered by UIScene. The clickable row hit zone is
 *  wider — see {@link surveyUploadRowHitRect}. Canvas-independent (fixed inset
 *  + size). */
export const SURVEY_UPLOAD_CHECKBOX_RECT = {
  x: PANEL_INSET_X,
  y: SURVEY_UPLOAD_CHECKBOX_Y,
  w: SURVEY_CHECKBOX_SIZE,
  h: SURVEY_CHECKBOX_SIZE,
} as const;

/** Codex P3: the visible checkbox square is only 20×20 but the row also
 *  renders a long label to the right ("Report this as a bug", "Upload
 *  diagnostic snapshot to help us debug…"). The label IS the affordance
 *  most users will aim for — especially on touch devices. These row hit
 *  rects cover the full panel width so clicks on the label register as
 *  checkbox toggles. The visible square is drawn off the narrower
 *  ..._CHECKBOX_RECT constants above. Full width is canvas-relative. */
function rowHitWidth(layout: LayoutContext): number {
  return layout.w - 2 * PANEL_INSET_X;
}

export function surveyBrokenRowHitRect(layout: LayoutContext): SurveyRect {
  return {
    x: PANEL_INSET_X,
    y: SURVEY_BROKEN_CHECKBOX_Y,
    w: rowHitWidth(layout),
    h: SURVEY_CHECKBOX_SIZE,
  };
}

export function surveyUploadRowHitRect(layout: LayoutContext): SurveyRect {
  return {
    x: PANEL_INSET_X,
    y: SURVEY_UPLOAD_CHECKBOX_Y,
    w: rowHitWidth(layout),
    h: SURVEY_CHECKBOX_SIZE,
  };
}

/** Button row at the bottom of the panel. Sizes/gap are canvas-independent; the
 *  row Y (off the panel bottom) and the horizontal centering are not. */
const BUTTON_W = 120;
const BUTTON_H = 36;
const BUTTON_GAP = 16;
function buttonRowY(layout: LayoutContext): number {
  return panelBottomY(layout) - BUTTON_H - 20;
}

/** Submit button — primary action, left side of the pair (centered as
 *  a 2-button group). */
export function surveySubmitButtonRect(layout: LayoutContext): SurveyRect {
  return {
    x: layout.w / 2 - BUTTON_W - BUTTON_GAP / 2,
    y: buttonRowY(layout),
    w: BUTTON_W,
    h: BUTTON_H,
  };
}

/** Skip button — secondary action, right side. */
export function surveySkipButtonRect(layout: LayoutContext): SurveyRect {
  return {
    x: layout.w / 2 + BUTTON_GAP / 2,
    y: buttonRowY(layout),
    w: BUTTON_W,
    h: BUTTON_H,
  };
}

/** Consent disclosure text. ADR 0013 §"Privacy" requires the overlay to
 *  warn the player that an upload leaks client IP + User-Agent at the edge.
 *  Centralized here so the wording is reviewable and only changes via this
 *  module (matching the same approach for the contract's wire shape). */
export const SURVEY_CONSENT_DISCLOSURE =
  'Uploading sends your IP and browser version to the server alongside the diagnostic snapshot.';

// ---------------------------------------------------------------------------
// Rating buttons — five rects across, centered, indexed 1..5 left→right
// ---------------------------------------------------------------------------

export interface SurveyRatingButton {
  rating: 1 | 2 | 3 | 4 | 5;
  rect: SurveyRect;
}

/** Build the five rating-button rects. Computed lazily (called once on
 *  overlay open) — the values are constant for a given canvas size so
 *  caching is not warranted. */
export function surveyRatingButtons(layout: LayoutContext): SurveyRatingButton[] {
  const totalW = 5 * SURVEY_RATING_BUTTON_W + 4 * SURVEY_RATING_BUTTON_GAP;
  const startX = (layout.w - totalW) / 2;
  const out: SurveyRatingButton[] = [];
  for (let i = 0; i < 5; i++) {
    out.push({
      rating: (i + 1) as 1 | 2 | 3 | 4 | 5,
      rect: {
        x: startX + i * (SURVEY_RATING_BUTTON_W + SURVEY_RATING_BUTTON_GAP),
        y: SURVEY_RATING_ROW_Y,
        w: SURVEY_RATING_BUTTON_W,
        h: SURVEY_RATING_BUTTON_H,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

function pointInRect(px: number, py: number, r: SurveyRect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

export type SurveyHitTarget =
  | { kind: 'rating'; rating: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'broken-checkbox' }
  | { kind: 'upload-checkbox' }
  | { kind: 'submit' }
  | { kind: 'skip' }
  | { kind: 'free-text' }
  | null;

/** Topmost interactive element under the pointer, or null on background.
 *  Note: checkbox rows hit-test against the wider ROW_HIT rects so clicks
 *  on the label text register the same as clicks on the visible square. */
export function surveyHitTest(px: number, py: number, layout: LayoutContext): SurveyHitTarget {
  if (pointInRect(px, py, surveySubmitButtonRect(layout))) return { kind: 'submit' };
  if (pointInRect(px, py, surveySkipButtonRect(layout))) return { kind: 'skip' };
  if (pointInRect(px, py, surveyBrokenRowHitRect(layout))) return { kind: 'broken-checkbox' };
  if (pointInRect(px, py, surveyUploadRowHitRect(layout))) return { kind: 'upload-checkbox' };
  if (pointInRect(px, py, surveyFreeTextRect(layout))) return { kind: 'free-text' };
  for (const btn of surveyRatingButtons(layout)) {
    if (pointInRect(px, py, btn.rect)) {
      return { kind: 'rating', rating: btn.rating };
    }
  }
  return null;
}

/** Hit-test for the post-submit/skip confirmation screen. The confirmation
 *  screen reuses the Submit/Skip button positions for New Game and Retry. */
export function surveyConfirmationHitTest(
  px: number,
  py: number,
  layout: LayoutContext,
): { kind: 'new-game' } | { kind: 'retry' } | null {
  if (pointInRect(px, py, surveySubmitButtonRect(layout))) return { kind: 'new-game' };
  if (pointInRect(px, py, surveySkipButtonRect(layout))) return { kind: 'retry' };
  return null;
}
