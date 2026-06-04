// survey-overlay-layout.ts — issue #122 end-of-game survey overlay layout.
//
// Pure-TypeScript module (no Phaser, no DOM) mirroring the pattern in
// pause-menu-layout.ts and save-load-dialog-layout.ts: defines geometry +
// hit-testing for the overlay so UIScene can spin up Phaser game objects
// against fixed rects and Vitest can exercise hit-testing headlessly.
//
// Visual layout (canvas-local pixels, 800×592):
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

export const SURVEY_CANVAS_W = 800;
export const SURVEY_CANVAS_H = 592;

/** Overall modal panel inset from the canvas edges. */
const PANEL_INSET_X = 80;
const PANEL_TOP_Y = 60;
const PANEL_BOTTOM_Y = SURVEY_CANVAS_H - 60;

/** Title baseline Y — fixed offset from the panel top so the title doesn't
 *  drift when other rows resize. */
export const SURVEY_TITLE_Y = PANEL_TOP_Y + 30;

/** Vertical anchor for the rating row — five buttons across, centered. */
export const SURVEY_RATING_ROW_Y = PANEL_TOP_Y + 115;
export const SURVEY_RATING_BUTTON_W = 56;
export const SURVEY_RATING_BUTTON_H = 56;
export const SURVEY_RATING_BUTTON_GAP = 12;

/** Free-text input rect — a single-line affordance. DOM input element is
 *  positioned over this rect at runtime by UIScene. */
export const SURVEY_FREE_TEXT_RECT = {
  x: PANEL_INSET_X,
  y: SURVEY_RATING_ROW_Y + SURVEY_RATING_BUTTON_H + 30,
  w: SURVEY_CANVAS_W - 2 * PANEL_INSET_X,
  h: 100,
} as const;

/** Checkbox row constants — used by both the "Report as broken" and
 *  "Upload diagnostic snapshot" rows. */
export const SURVEY_CHECKBOX_SIZE = 20;
export const SURVEY_CHECKBOX_LABEL_GAP = 12;

export const SURVEY_BROKEN_CHECKBOX_Y = SURVEY_FREE_TEXT_RECT.y + SURVEY_FREE_TEXT_RECT.h + 20;
export const SURVEY_UPLOAD_CHECKBOX_Y = SURVEY_BROKEN_CHECKBOX_Y + SURVEY_CHECKBOX_SIZE + 16;
/** Two-line consent disclosure sits below the upload checkbox, indented to
 *  align with the label text. */
export const SURVEY_CONSENT_TEXT_Y = SURVEY_UPLOAD_CHECKBOX_Y + SURVEY_CHECKBOX_SIZE + 6;

/** Visible checkbox square rendered by UIScene. The clickable row hit
 *  zone is wider — see {@link SURVEY_BROKEN_ROW_HIT_RECT}. */
export const SURVEY_BROKEN_CHECKBOX_RECT = {
  x: PANEL_INSET_X,
  y: SURVEY_BROKEN_CHECKBOX_Y,
  w: SURVEY_CHECKBOX_SIZE,
  h: SURVEY_CHECKBOX_SIZE,
} as const;

/** Visible checkbox square rendered by UIScene. The clickable row hit
 *  zone is wider — see {@link SURVEY_UPLOAD_ROW_HIT_RECT}. */
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
 *  rects cover the full row width so clicks on the label register as
 *  checkbox toggles. The visible square is drawn off the narrower
 *  ..._CHECKBOX_RECT constants above. */
const ROW_HIT_W = SURVEY_CANVAS_W - 2 * PANEL_INSET_X;

export const SURVEY_BROKEN_ROW_HIT_RECT = {
  x: PANEL_INSET_X,
  y: SURVEY_BROKEN_CHECKBOX_Y,
  w: ROW_HIT_W,
  h: SURVEY_CHECKBOX_SIZE,
} as const;

export const SURVEY_UPLOAD_ROW_HIT_RECT = {
  x: PANEL_INSET_X,
  y: SURVEY_UPLOAD_CHECKBOX_Y,
  w: ROW_HIT_W,
  h: SURVEY_CHECKBOX_SIZE,
} as const;

/** Button row at the bottom of the panel. */
const BUTTON_W = 120;
const BUTTON_H = 36;
const BUTTON_GAP = 16;
const BUTTON_ROW_Y = PANEL_BOTTOM_Y - BUTTON_H - 20;

/** Submit button — primary action, left side of the pair (centered as
 *  a 2-button group). */
export const SURVEY_SUBMIT_BUTTON_RECT = {
  x: SURVEY_CANVAS_W / 2 - BUTTON_W - BUTTON_GAP / 2,
  y: BUTTON_ROW_Y,
  w: BUTTON_W,
  h: BUTTON_H,
} as const;

/** Skip button — secondary action, right side. */
export const SURVEY_SKIP_BUTTON_RECT = {
  x: SURVEY_CANVAS_W / 2 + BUTTON_GAP / 2,
  y: BUTTON_ROW_Y,
  w: BUTTON_W,
  h: BUTTON_H,
} as const;

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
  rect: { x: number; y: number; w: number; h: number };
}

/** Build the five rating-button rects. Computed lazily (called once on
 *  overlay open) — the values are constant for the fixed canvas size so
 *  caching is not warranted. */
export function surveyRatingButtons(): SurveyRatingButton[] {
  const totalW = 5 * SURVEY_RATING_BUTTON_W + 4 * SURVEY_RATING_BUTTON_GAP;
  const startX = (SURVEY_CANVAS_W - totalW) / 2;
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

function pointInRect(
  px: number,
  py: number,
  r: { x: number; y: number; w: number; h: number },
): boolean {
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
export function surveyHitTest(px: number, py: number): SurveyHitTarget {
  if (pointInRect(px, py, SURVEY_SUBMIT_BUTTON_RECT)) return { kind: 'submit' };
  if (pointInRect(px, py, SURVEY_SKIP_BUTTON_RECT)) return { kind: 'skip' };
  if (pointInRect(px, py, SURVEY_BROKEN_ROW_HIT_RECT)) return { kind: 'broken-checkbox' };
  if (pointInRect(px, py, SURVEY_UPLOAD_ROW_HIT_RECT)) return { kind: 'upload-checkbox' };
  if (pointInRect(px, py, SURVEY_FREE_TEXT_RECT)) return { kind: 'free-text' };
  for (const btn of surveyRatingButtons()) {
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
): { kind: 'new-game' } | { kind: 'retry' } | null {
  if (pointInRect(px, py, SURVEY_SUBMIT_BUTTON_RECT)) return { kind: 'new-game' };
  if (pointInRect(px, py, SURVEY_SKIP_BUTTON_RECT)) return { kind: 'retry' };
  return null;
}
