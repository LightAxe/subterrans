// survey-overlay-layout.test.ts — issue #122 layout smoke coverage.
//
// Pure-data tests for the survey overlay's geometry + hit-testing. The
// Phaser scene integration is covered separately (manually + via the
// E2E suite in tests/); this file makes sure the layout module is
// internally consistent before the scene ever consumes it.

import { describe, it, expect } from 'vitest';
import {
  surveyRatingButtons,
  surveyHitTest,
  SURVEY_CANVAS_W,
  SURVEY_SUBMIT_BUTTON_RECT,
  SURVEY_SKIP_BUTTON_RECT,
  SURVEY_BROKEN_CHECKBOX_RECT,
  SURVEY_UPLOAD_CHECKBOX_RECT,
  SURVEY_FREE_TEXT_RECT,
  SURVEY_CONSENT_DISCLOSURE,
} from './survey-overlay-layout.js';

describe('surveyRatingButtons', () => {
  it('emits exactly five buttons numbered 1..5 in order', () => {
    const btns = surveyRatingButtons();
    expect(btns.map(b => b.rating)).toEqual([1, 2, 3, 4, 5]);
  });

  it('button row is centered horizontally on the canvas', () => {
    const btns = surveyRatingButtons();
    const first = btns[0]!.rect;
    const last  = btns[4]!.rect;
    const leftMargin  = first.x;
    const rightMargin = SURVEY_CANVAS_W - (last.x + last.w);
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
    expect(surveyHitTest(
      SURVEY_BROKEN_CHECKBOX_RECT.x + 5,
      SURVEY_BROKEN_CHECKBOX_RECT.y + 5,
    )).toEqual({ kind: 'broken-checkbox' });
    expect(surveyHitTest(
      SURVEY_UPLOAD_CHECKBOX_RECT.x + 5,
      SURVEY_UPLOAD_CHECKBOX_RECT.y + 5,
    )).toEqual({ kind: 'upload-checkbox' });
  });

  it('returns submit / skip hits on the respective buttons', () => {
    expect(surveyHitTest(
      SURVEY_SUBMIT_BUTTON_RECT.x + 5,
      SURVEY_SUBMIT_BUTTON_RECT.y + 5,
    )).toEqual({ kind: 'submit' });
    expect(surveyHitTest(
      SURVEY_SKIP_BUTTON_RECT.x + 5,
      SURVEY_SKIP_BUTTON_RECT.y + 5,
    )).toEqual({ kind: 'skip' });
  });

  it('returns free-text on the textarea rect', () => {
    expect(surveyHitTest(
      SURVEY_FREE_TEXT_RECT.x + 5,
      SURVEY_FREE_TEXT_RECT.y + 5,
    )).toEqual({ kind: 'free-text' });
  });

  it('returns null on the panel background', () => {
    // A point in the title gap above the rating buttons should not hit
    // any interactive element.
    expect(surveyHitTest(SURVEY_CANVAS_W / 2, 30)).toBeNull();
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
