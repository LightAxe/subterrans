// survey-overlay-layout.test.ts — issue #122 layout smoke coverage.
//
// Pure-data tests for the survey overlay's geometry + hit-testing. The
// Phaser scene integration is covered separately (manually + via the
// E2E suite in tests/); this file makes sure the layout module is
// internally consistent before the scene ever consumes it.

import { describe, it, expect } from 'vitest';
import {
  surveyRatingButtons as surveyRatingButtonsAt,
  surveyHitTest as surveyHitTestAt,
  surveyConfirmationHitTest as surveyConfirmationHitTestAt,
  surveySubmitButtonRect,
  surveySkipButtonRect,
  surveyFreeTextRect,
  surveyBrokenRowHitRect,
  surveyUploadRowHitRect,
  SURVEY_BROKEN_CHECKBOX_RECT,
  SURVEY_UPLOAD_CHECKBOX_RECT,
  SURVEY_CONSENT_DISCLOSURE,
  type SurveyRect,
} from './survey-overlay-layout.js';
import { DEFAULT_LAYOUT, createLayoutContext } from './layout.js';

// Issue #213: the overlay geometry is now a function of a LayoutContext. Bind the
// fixed default layout (800×592) and evaluate the rect helpers to constants so
// the existing parity assertions are unchanged. The seam describe at the bottom
// proves the geometry responds to a different layout.
const L = DEFAULT_LAYOUT;
const surveyRatingButtons = () => surveyRatingButtonsAt(L);
const surveyHitTest = (px: number, py: number) => surveyHitTestAt(px, py, L);
const surveyConfirmationHitTest = (px: number, py: number) =>
  surveyConfirmationHitTestAt(px, py, L);
const SURVEY_SUBMIT_BUTTON_RECT = surveySubmitButtonRect(L);
const SURVEY_SKIP_BUTTON_RECT = surveySkipButtonRect(L);
const SURVEY_FREE_TEXT_RECT = surveyFreeTextRect(L);

describe('surveyRatingButtons', () => {
  it('emits exactly five buttons numbered 1..5 in order', () => {
    const btns = surveyRatingButtons();
    expect(btns.map((b) => b.rating)).toEqual([1, 2, 3, 4, 5]);
  });

  it('button row is centered horizontally on the canvas', () => {
    const btns = surveyRatingButtons();
    const first = btns[0]!.rect;
    const last = btns[4]!.rect;
    const leftMargin = first.x;
    const rightMargin = L.w - (last.x + last.w);
    // Allow a 1px slack for rounding.
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);
  });
});

describe('surveyHitTest — disjoint targets', () => {
  it('returns a rating hit when the pointer is inside a rating button', () => {
    const btns = surveyRatingButtons();
    const r = btns[2]!.rect; // rating 3
    const hit = surveyHitTest(r.x + 5, r.y + 5);
    expect(hit).toEqual({ kind: 'rating', rating: 3 });
  });

  it('returns broken-checkbox / upload-checkbox hits on the respective rects', () => {
    expect(
      surveyHitTest(SURVEY_BROKEN_CHECKBOX_RECT.x + 5, SURVEY_BROKEN_CHECKBOX_RECT.y + 5),
    ).toEqual({ kind: 'broken-checkbox' });
    expect(
      surveyHitTest(SURVEY_UPLOAD_CHECKBOX_RECT.x + 5, SURVEY_UPLOAD_CHECKBOX_RECT.y + 5),
    ).toEqual({ kind: 'upload-checkbox' });
  });

  it('checkbox-row clicks register over the label area too (codex P3)', () => {
    // The visible checkbox square is only 20×20, but the row also renders
    // a long label to the right. A click on the label must toggle the
    // checkbox — otherwise users (especially on touch) aim at the obvious
    // target and nothing happens.
    const labelX = SURVEY_BROKEN_CHECKBOX_RECT.x + SURVEY_BROKEN_CHECKBOX_RECT.w + 50;
    expect(surveyHitTest(labelX, SURVEY_BROKEN_CHECKBOX_RECT.y + 5)).toEqual({
      kind: 'broken-checkbox',
    });
    expect(surveyHitTest(labelX, SURVEY_UPLOAD_CHECKBOX_RECT.y + 5)).toEqual({
      kind: 'upload-checkbox',
    });
  });

  it('returns submit / skip hits on the respective buttons', () => {
    expect(surveyHitTest(SURVEY_SUBMIT_BUTTON_RECT.x + 5, SURVEY_SUBMIT_BUTTON_RECT.y + 5)).toEqual(
      { kind: 'submit' },
    );
    expect(surveyHitTest(SURVEY_SKIP_BUTTON_RECT.x + 5, SURVEY_SKIP_BUTTON_RECT.y + 5)).toEqual({
      kind: 'skip',
    });
  });

  it('returns free-text on the textarea rect', () => {
    expect(surveyHitTest(SURVEY_FREE_TEXT_RECT.x + 5, SURVEY_FREE_TEXT_RECT.y + 5)).toEqual({
      kind: 'free-text',
    });
  });

  it('returns null on the panel background', () => {
    // A point in the title gap above the rating buttons should not hit
    // any interactive element.
    expect(surveyHitTest(L.w / 2, 30)).toBeNull();
  });
});

describe('consent disclosure', () => {
  it('mentions both IP and browser/UA leakage per ADR 0013 §"Privacy"', () => {
    // The exact wording is allowed to drift, but the two pieces of
    // information the player needs to consent to MUST be named. Failing
    // this assertion is a privacy-disclosure regression and should block
    // the PR until the copy is fixed.
    expect(SURVEY_CONSENT_DISCLOSURE.toLowerCase()).toMatch(/ip/);
    expect(SURVEY_CONSENT_DISCLOSURE.toLowerCase()).toMatch(/browser|user[- ]agent|ua/);
  });
});

describe('surveyConfirmationHitTest — issue #131', () => {
  it('returns new-game when pointer is over the Submit button position', () => {
    expect(
      surveyConfirmationHitTest(SURVEY_SUBMIT_BUTTON_RECT.x + 5, SURVEY_SUBMIT_BUTTON_RECT.y + 5),
    ).toEqual({ kind: 'new-game' });
  });

  it('returns retry when pointer is over the Skip button position', () => {
    expect(
      surveyConfirmationHitTest(SURVEY_SKIP_BUTTON_RECT.x + 5, SURVEY_SKIP_BUTTON_RECT.y + 5),
    ).toEqual({ kind: 'retry' });
  });

  it('returns null on background (outside both button rects)', () => {
    expect(
      surveyConfirmationHitTest(SURVEY_SUBMIT_BUTTON_RECT.x - 10, SURVEY_SUBMIT_BUTTON_RECT.y - 10),
    ).toBeNull();
  });
});

describe('survey layout — LayoutContext seam (issue #213)', () => {
  it('keeps the submit/skip pair centered on a wider layout', () => {
    const wide = createLayoutContext(1000, 700);
    const submit = surveySubmitButtonRect(wide);
    const skip = surveySkipButtonRect(wide);
    // Group spans submit.x → skip.x+skip.w; its center tracks the layout center.
    const groupCenter = (submit.x + (skip.x + skip.w)) / 2;
    expect(groupCenter).toBeCloseTo(wide.w / 2, 5);
  });

  it('pushes the button row down on a taller layout (panel bottom follows height)', () => {
    const tall = createLayoutContext(L.w, L.h + 200);
    expect(surveySubmitButtonRect(tall).y).toBeGreaterThan(surveySubmitButtonRect(L).y);
  });

  it('spans the free-text + row-hit width across the layout (inset 80px each side)', () => {
    const wide = createLayoutContext(1000, 700);
    expect(surveyFreeTextRect(wide).w).toBe(wide.w - 160);
  });
});

// ---------------------------------------------------------------------------
// Small-context regression fixtures (#238 PR4). Guard the PR1–3 LayoutContext
// reflow + the Phase 6 mobile work: at a phone-portrait 360×640 context every
// clickable rect must stay on-screen and none may overlap. These PASS today
// (verified in #238) — they exist to fail loudly if a future reflow regresses.
// The clickable set is the checkbox ROW-hit rects (not the narrow visible
// squares), the free-text affordance, the five rating buttons, and Submit/Skip.
//
// Heights below ~490 need genuine reflow (scroll / re-order), NOT proportional
// row compression (which fails its own no-overlap test at real phone heights —
// see #238). That reflow is owned by Phase 6.
// ---------------------------------------------------------------------------

/** True iff rect r lies fully inside the 0..w × 0..h canvas. */
function within(r: SurveyRect, w: number, h: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;
}

/** True iff any two rects overlap (strict — touching edges do not count). */
function anyOverlap(rects: readonly SurveyRect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  }
  return false;
}

describe('survey overlay — small-context regression (#238 PR4, 360×640)', () => {
  const phone = createLayoutContext(360, 640);
  const rects: SurveyRect[] = [
    ...surveyRatingButtonsAt(phone).map((b) => b.rect),
    surveyFreeTextRect(phone),
    surveyBrokenRowHitRect(phone),
    surveyUploadRowHitRect(phone),
    surveySubmitButtonRect(phone),
    surveySkipButtonRect(phone),
  ];

  it('every interactive rect is within the 360×640 canvas', () => {
    for (const r of rects) expect(within(r, 360, 640)).toBe(true);
  });

  it('no interactive rects overlap', () => {
    expect(anyOverlap(rects)).toBe(false);
  });
});
