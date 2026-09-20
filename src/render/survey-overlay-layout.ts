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
//   Email row:          optional address (#303) — label + a DOM <input> rect,
//                       same reserve-the-rect arrangement as the free text
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

/** Free-text affordance anchors. Y/H are canvas-INDEPENDENT (the email row and
 *  the checkbox rows anchor off them); only the WIDTH spans the panel, so the
 *  rect itself is a function of the LayoutContext — see {@link surveyFreeTextRect}.
 *
 *  #303 shrank H from 100 to 68 to make room for the optional-email row below
 *  it. The 32 px come out of the textarea rather than out of the rows beneath,
 *  so every anchor from SURVEY_BROKEN_CHECKBOX_Y down keeps the exact Y it had
 *  before — the overlay still fits the 592-tall canvas with the same slack. */
export const SURVEY_FREE_TEXT_Y = SURVEY_RATING_ROW_Y + SURVEY_RATING_BUTTON_H + 30;
export const SURVEY_FREE_TEXT_H = 68;

/** Free-text input rect — the multi-line feedback box. A DOM <textarea> is
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

// ---------------------------------------------------------------------------
// Optional email row (#303)
// ---------------------------------------------------------------------------

/** Label above the email input. Canvas-INDEPENDENT anchor; the label itself is
 *  word-wrapped to the panel width by UIScene. */
export const SURVEY_EMAIL_LABEL_Y = SURVEY_FREE_TEXT_Y + SURVEY_FREE_TEXT_H + 4;
/** Single-line input height, and its Y below the label. Both canvas-independent. */
export const SURVEY_EMAIL_INPUT_H = 24;
export const SURVEY_EMAIL_INPUT_Y = SURVEY_EMAIL_LABEL_Y + 14;

/** Copy for the email row. Centralized here for the same reason as
 *  {@link SURVEY_CONSENT_DISCLOSURE}: the purpose limitation is a privacy
 *  promise, so it changes only via this module. */
export const SURVEY_EMAIL_LABEL =
  'Email (optional) — only used to reply about this report; deleted after 90 days';

/** Email input rect — a single-line affordance. The DOM <input type="email">
 *  is positioned over this rect at runtime by UIScene, exactly the way the
 *  free-text <textarea> is. Width spans the panel, so this derives from the
 *  LayoutContext. */
export function surveyEmailInputRect(layout: LayoutContext): SurveyRect {
  return {
    x: PANEL_INSET_X,
    y: SURVEY_EMAIL_INPUT_Y,
    w: layout.w - 2 * PANEL_INSET_X,
    h: SURVEY_EMAIL_INPUT_H,
  };
}

/** Checkbox row constants — used by both the "Report as broken" row and the
 *  snapshot row (whose label is SURVEY_UPLOAD_LABEL_OPT_IN or
 *  SURVEY_UPLOAD_LABEL_DEFAULT_ON, picked by UIScene). */
export const SURVEY_CHECKBOX_SIZE = 20;
export const SURVEY_CHECKBOX_LABEL_GAP = 12;

/** Anchored off the email row (#303). The arithmetic is chosen so this still
 *  evaluates to the pre-#303 value — everything below it is unmoved. */
export const SURVEY_BROKEN_CHECKBOX_Y = SURVEY_EMAIL_INPUT_Y + SURVEY_EMAIL_INPUT_H + 10;
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

/** Label for the snapshot checkbox while it is OPT-IN (unticked by default).
 *  "diagnostic snapshot" is fine for a box the player deliberately reaches for. */
export const SURVEY_UPLOAD_LABEL_OPT_IN = 'Upload diagnostic snapshot to help us debug';

/** Label for the same checkbox if PLAYTRACE_INCLUDE_SNAPSHOT_DEFAULT is flipped
 *  to true (#295). A box that is already ticked has to say plainly what is going
 *  to be sent — silently uploading a world snapshot by default is a different
 *  social contract from an opt-in box, even though the payload is only game
 *  state. UIScene picks between the two off that constant. */
export const SURVEY_UPLOAD_LABEL_DEFAULT_ON =
  'Include replay data with this report (game state only — no personal data)';

/** Consent disclosure text. ADR 0013 §"Privacy" requires the overlay to
 *  warn the player that an upload leaks client IP + User-Agent at the edge.
 *  Centralized here so the wording is reviewable and only changes via this
 *  module (matching the same approach for the contract's wire shape). */
export const SURVEY_CONSENT_DISCLOSURE =
  'Uploading sends your IP and browser version with the replay data, plus your email if you enter one.';

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
  | { kind: 'email' }
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
  if (pointInRect(px, py, surveyEmailInputRect(layout))) return { kind: 'email' };
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
