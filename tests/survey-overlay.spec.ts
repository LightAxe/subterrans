// survey-overlay.spec.ts — end-to-end proof of the v3 playtrace survey overlay
// (#294 difficulty, #295 opt-in replay data, #303 optional email).
//
// Why this spec needs a fixture page
// ---------------------------------
// The survey overlay is feature-gated on a non-empty playtrace endpoint, and
// playwright.config.ts deliberately pins VITE_PLAYTRACE_ENDPOINT='' for the
// whole suite (so the pause menu keeps its open-source 4-row shape and the
// coordinate-based menu specs stay deterministic on every machine). The
// overlay therefore can never appear on '/'.
//
// mount()'s `playtraceEndpoint` option is the supported per-embedder override
// (MountOptions, src/main.ts), so tests/fixtures/playtrace-on.html mounts the
// same game with the feature ON at the dev server's built-in mock endpoint
// (playtraceMockPlugin, vite.config.ts). Nothing else about the suite changes.
//
// Geometry: #240 keeps canvas-pixel literals out of the specs. The shared
// helper (tests/helpers/geometry.ts) pins the pause menu to its
// quitAndSurveyEnabled:false shape, which is the opposite of what this spec
// needs, so the rects here are derived from the same pure, Phaser-free layout
// modules the helper itself evaluates — no literals either way.

import { test, expect, type Page } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

import { DEFAULT_LAYOUT } from '../src/render/layout.js';
import { pauseMenuItems, type PauseMenuRenderContext } from '../src/render/pause-menu-layout.js';
import {
  DIFFICULTY_EASY_RECT,
  DIFFICULTY_HARD_RECT,
  DIFFICULTY_NORMAL_RECT,
} from '../src/render/boot-overlay-layout.js';
import {
  SURVEY_EMAIL_LABEL,
  SURVEY_EMAIL_LABEL_Y,
  SURVEY_UPLOAD_LABEL_DEFAULT_ON,
  surveyEmailInputRect,
  surveyFreeTextRect,
  surveyRatingButtons,
  surveySubmitButtonRect,
  surveyUploadRowHitRect,
} from '../src/render/survey-overlay-layout.js';
import { SETTINGS_KEY } from '../src/platform/settings.js';

const FIXTURE = '/tests/fixtures/playtrace-on.html';
const SAVE_KEY = 'subterrans:save:v3';
const EMAIL_INPUT = 'input[type="email"]';

/** Wire schema version the v3 envelope must carry (playtrace-upload.ts).
 *  Pinned as a literal rather than imported: playtrace-upload.ts pulls in the
 *  save/snapshot chain and declares the build-time __APP_VERSION__ define,
 *  neither of which belongs in the Playwright Node runner. */
const EXPECTED_SCHEMA_VERSION = 3;

type Rect = { x: number; y: number; w: number; h: number };
type Difficulty = 'Easy' | 'Normal' | 'Hard';

// Rects the survey needs, evaluated once at the default (800×592) layout.
const EMAIL_RECT = surveyEmailInputRect(DEFAULT_LAYOUT);
const FREE_TEXT_RECT = surveyFreeTextRect(DEFAULT_LAYOUT);
const SUBMIT_RECT = surveySubmitButtonRect(DEFAULT_LAYOUT);
const UPLOAD_ROW_RECT = surveyUploadRowHitRect(DEFAULT_LAYOUT);
const RATING_RECTS = surveyRatingButtons(DEFAULT_LAYOUT);

const DIFFICULTY_RECTS: Record<Difficulty, Rect> = {
  Easy: DIFFICULTY_EASY_RECT,
  Normal: DIFFICULTY_NORMAL_RECT,
  Hard: DIFFICULTY_HARD_RECT,
};

// The pause menu with the playtrace feature ON — five rows, "Quit & feedback"
// last. Only quitAndSurveyEnabled moves the rects (it changes the row count);
// the other flags drive labels/enabled state only.
const PAUSE_CTX: PauseMenuRenderContext = {
  saveLoadEnabled: true,
  currentPheromoneOverlay: true,
  currentHintStripVisible: true,
  currentSpeedMultiplier: 1,
  quitAndSurveyEnabled: true,
};
const QUIT_AND_SURVEY_RECT: Rect = pauseMenuItems('main', PAUSE_CTX, DEFAULT_LAYOUT).find(
  (i) => i.id === 'quit-and-survey',
)!.rect;

function ratingRect(rating: 1 | 2 | 3 | 4 | 5): Rect {
  return RATING_RECTS.find((b) => b.rating === rating)!.rect;
}

async function clickCanvasRect(page: Page, rect: Rect): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
}

async function activeOverlay(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui;
    return ui?.activeOverlay ?? '<undefined>';
  });
}

/** Drive the fresh-boot "Choose Difficulty" overlay to Playing on the given
 *  tier. Same poll-click shape as menu-and-dialog.spec.ts's settleToPlaying —
 *  a click that lands before the buttons are interactive simply retries. */
async function settleToPlaying(page: Page, difficulty: Difficulty): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await activeOverlay(page)) === 'none') return 'none';
        await clickCanvasRect(page, DIFFICULTY_RECTS[difficulty]);
        return activeOverlay(page);
      },
      { timeout: 20_000 },
    )
    .toBe('none');
}

/** Boot the playtrace-on fixture to a clean Playing state on `difficulty`.
 *  `keepSettings` preserves subterrans:settings:v1 across the reload, which is
 *  what the #303 prefill check needs (the save key is always cleared so the
 *  reload lands on Choose Difficulty, never a Continue/New Game SavePrompt). */
async function bootFixture(
  page: Page,
  difficulty: Difficulty,
  opts?: { keepSettings?: boolean },
): Promise<void> {
  await page.goto(FIXTURE);
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined',
  );
  await page.evaluate(
    ([saveKey, settingsKey, keepSettings]) => {
      localStorage.removeItem(saveKey as string);
      if (keepSettings !== true) localStorage.removeItem(settingsKey as string);
    },
    [SAVE_KEY, SETTINGS_KEY, opts?.keepSettings === true] as const,
  );
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await settleToPlaying(page, difficulty);
}

/** Esc → pause menu → "Quit & feedback" → survey overlay up. This is the fast
 *  path to the survey; the envelope records it as quitFromPauseMenu: true. */
async function openSurveyFromPauseMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect.poll(() => activeOverlay(page), { timeout: 10_000 }).toBe('pause-menu');
  await clickCanvasRect(page, QUIT_AND_SURVEY_RECT);
  await expect.poll(() => activeOverlay(page), { timeout: 10_000 }).toBe('survey');
  await page.locator(EMAIL_INPUT).waitFor({ state: 'visible' });
}

interface WireSurvey {
  rating: number;
  freeText: string;
  brokenFlag: boolean;
  email?: string;
}
interface WireEnvelope {
  schemaVersion: number;
  difficulty: string;
  quitFromPauseMenu: boolean;
  survey: WireSurvey;
  snapshot: unknown;
}

/** Captured POST bodies, gunzipped + parsed. One entry per submission. */
function installUploadCapture(page: Page): WireEnvelope[] {
  const captured: WireEnvelope[] = [];
  void page.route('**/api/playtrace', async (route) => {
    const buf = route.request().postDataBuffer();
    if (buf === null) throw new Error('playtrace POST had no body buffer');
    captured.push(JSON.parse(gunzipSync(buf).toString('utf8')) as WireEnvelope);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: true, sessionId: 'e2e' }),
    });
  });
  return captured;
}

/** Pick a rating (Submit is inert at rating 0) and click Submit. */
async function submitSurvey(page: Page, rating: 1 | 2 | 3 | 4 | 5): Promise<void> {
  await clickCanvasRect(page, ratingRect(rating));
  await clickCanvasRect(page, SUBMIT_RECT);
}

test.describe('End-of-game survey overlay — v3 playtrace envelope', () => {
  // A full boot (assets + Choose Difficulty + a live world) plus the pause-menu
  // path runs well past the suite's 30s default on a cold dev server.
  test.describe.configure({ timeout: 90_000 });

  test('#303 — email input is mounted over the canvas at the layout rect', async ({ page }) => {
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    const email = page.locator(EMAIL_INPUT);
    await expect(email).toHaveCount(1);
    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute('autocomplete', 'email');
    await expect(email).toHaveAttribute('maxlength', '254');
    await expect(email).toHaveAttribute('placeholder', 'you@example.com');
    // Prefill is empty on a machine with no remembered address.
    await expect(email).toHaveValue('');

    // The overlay's copy is centralized in survey-overlay-layout.ts (the same
    // rule as the consent disclosure) and drawn onto the canvas by UIScene, so
    // it is asserted at its source of truth.
    expect(SURVEY_EMAIL_LABEL).toBe(
      'Email (optional) — only used to follow up on this report',
    );
    // Asserted on the constant, not the canvas: this label is only DRAWN once
    // PLAYTRACE_INCLUDE_SNAPSHOT_DEFAULT flips to true. Pinning the wording now
    // means the consent copy is reviewed before it can ever ship pre-ticked.
    expect(SURVEY_UPLOAD_LABEL_DEFAULT_ON).toBe(
      'Include replay data with this report (game state only — no personal data)',
    );

    // Positioned over the canvas: the fixture pins the mount box to the logical
    // 800×592, so CSS px map 1:1 to canvas-local px and the DOM rect must land
    // on surveyEmailInputRect.
    const canvasBox = await page.locator('canvas').first().boundingBox();
    const emailBox = await email.boundingBox();
    if (!canvasBox || !emailBox) throw new Error('missing bounding box');
    expect(canvasBox.width).toBeCloseTo(DEFAULT_LAYOUT.w, 0);
    expect(canvasBox.height).toBeCloseTo(DEFAULT_LAYOUT.h, 0);
    expect(emailBox.x - canvasBox.x).toBeCloseTo(EMAIL_RECT.x, 0);
    expect(emailBox.y - canvasBox.y).toBeCloseTo(EMAIL_RECT.y, 0);
    expect(emailBox.width).toBeCloseTo(EMAIL_RECT.w, 0);
    expect(emailBox.height).toBeCloseTo(EMAIL_RECT.h, 0);

    // The email row stays inside the canvas.
    expect(emailBox.y + emailBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height);

    // Clicking the email rect on the canvas routes through surveyHitTest and
    // focuses the DOM input (no second click needed).
    await clickCanvasRect(page, EMAIL_RECT);
    await expect(email).toBeFocused();
  });

  // Regression guard for a defect #303 introduced and this spec caught.
  //
  // The free-text <textarea> is styled with `padding: 6px` + `border: 1px`.
  // positionSurveyElement writes the reserved rect into style.width/height, so
  // without `box-sizing: border-box` the rendered border-box came out 14px
  // wider and taller than surveyFreeTextRect — 654×82 against a reserved
  // 640×68. That overflow was invisible before #303 (a 100-tall box rendered
  // 114 and the next row started 6px further down), but #303 shrank the box to
  // 68 and put SURVEY_EMAIL_LABEL 4px underneath it, so the opaque #222222
  // textarea painted straight over the purpose-limitation copy: rendered bottom
  // 261+82 = 343 against a label baseline of 333.
  //
  // ensureSurveyDomInputs now sets boxSizing on the textarea, matching the
  // email input. This asserts the rendered box equals the reserved rect, which
  // is the assumption every other layout assertion in this file rests on.
  test('#303 — the shrunken free-text box must not paint over the email label', async ({
    page,
  }) => {
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    const canvasBox = await page.locator('canvas').first().boundingBox();
    const taBox = await page.locator('textarea').boundingBox();
    if (!canvasBox || !taBox) throw new Error('missing bounding box');

    // Renders at its reserved size…
    expect(taBox.width).toBeCloseTo(FREE_TEXT_RECT.w, 0);
    expect(taBox.height).toBeCloseTo(FREE_TEXT_RECT.h, 0);
    // …and therefore clears the email label below it.
    expect(taBox.y + taBox.height - canvasBox.y).toBeLessThanOrEqual(SURVEY_EMAIL_LABEL_Y);
  });

  test('#294/#295/#303 — submit with a valid email posts a v3 envelope with a snapshot', async ({
    page,
  }) => {
    const captured = installUploadCapture(page);
    await bootFixture(page, 'Hard');
    await openSurveyFromPauseMenu(page);

    await page.locator(EMAIL_INPUT).fill('  Player@Example.com  ');
    // Tick the replay-data box: PLAYTRACE_INCLUDE_SNAPSHOT_DEFAULT is still
    // false (#295 is measured but the trust/optics call has not been made), so
    // a snapshot only ships when the player opts in. If that default is ever
    // flipped, this click becomes an UNtick and the assertion below flips too —
    // which is exactly the kind of change that should not pass silently.
    await clickCanvasRect(page, UPLOAD_ROW_RECT);
    await submitSurvey(page, 4);

    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    const env = captured[0]!;
    expect(env.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(env.difficulty).toBe('Hard');
    expect(env.quitFromPauseMenu).toBe(true);
    expect(env.survey.rating).toBe(4);
    expect(env.survey.email).toBe('Player@Example.com');
    expect(env.snapshot).not.toBeNull();
  });

  test('#294 — the difficulty tier on the wire follows the chosen tier', async ({ page }) => {
    const captured = installUploadCapture(page);
    await bootFixture(page, 'Easy');
    await openSurveyFromPauseMenu(page);

    await submitSurvey(page, 5);

    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    expect(captured[0]!.difficulty).toBe('Easy');
  });

  test('#303 — a blank email omits survey.email entirely', async ({ page }) => {
    const captured = installUploadCapture(page);
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    await expect(page.locator(EMAIL_INPUT)).toHaveValue('');
    await submitSurvey(page, 3);

    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    const survey = captured[0]!.survey;
    expect('email' in survey).toBe(false);
    expect(Object.keys(survey).sort()).toEqual(['brokenFlag', 'freeText', 'rating']);
  });

  test('#303 — a malformed email omits survey.email entirely', async ({ page }) => {
    const captured = installUploadCapture(page);
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    await page.locator(EMAIL_INPUT).fill('not an email');
    await expect(page.locator(EMAIL_INPUT)).toHaveValue('not an email');
    await submitSurvey(page, 2);

    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    const survey = captured[0]!.survey;
    expect('email' in survey).toBe(false);
    // A typo must never block the submission — the rest of the survey lands.
    expect(survey.rating).toBe(2);
  });

  test('#295 — leaving the replay-data box alone sends snapshot: null', async ({ page }) => {
    const captured = installUploadCapture(page);
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    // Touch nothing: the box ships unticked, so an untouched submission carries
    // the survey and no snapshot. This is the behaviour #295 exists to question
    // — 0 of 2 real submissions opted in — and pinning it here means flipping
    // the default has a failing E2E in front of it, not just a unit assertion.
    await submitSurvey(page, 1);

    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    expect(captured[0]!.snapshot).toBeNull();
  });

  test('#303 — a submitted address is remembered and prefills the next survey', async ({
    page,
  }) => {
    const captured = installUploadCapture(page);
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    await page.locator(EMAIL_INPUT).fill('returning@example.com');
    await submitSurvey(page, 5);
    await expect.poll(() => captured.length, { timeout: 15_000 }).toBe(1);
    expect(captured[0]!.survey.email).toBe('returning@example.com');

    // Reload (settings survive; the save is cleared so we land on Choose
    // Difficulty again) and reopen the survey.
    await bootFixture(page, 'Normal', { keepSettings: true });
    await openSurveyFromPauseMenu(page);
    await expect(page.locator(EMAIL_INPUT)).toHaveValue('returning@example.com');
  });

  test('typing in the email input does not reach the game hotkeys', async ({ page }) => {
    await bootFixture(page, 'Normal');
    await openSurveyFromPauseMenu(page);

    const before = await page.evaluate(
      (key) => localStorage.getItem(key),
      SETTINGS_KEY,
    );
    const speedBefore = await page.evaluate(
      () => (window as { __phase9_ui?: { speedMultiplier?: number } }).__phase9_ui?.speedMultiplier,
    );

    // Focus via the canvas hit-test, then type a string made of live hotkeys:
    // p (pheromone overlay), x (underground colony swap), 1/2/3 (tool select),
    // w/a/s/d + space (camera pan / pause — all preventDefault'd by Phaser's
    // window-level KeyboardManager, so a missing stopPropagation would eat
    // these characters outright).
    await clickCanvasRect(page, EMAIL_RECT);
    const email = page.locator(EMAIL_INPUT);
    await expect(email).toBeFocused();
    await page.keyboard.type('px123wasd tab');

    await expect(email).toHaveValue('px123wasd tab');
    expect(await activeOverlay(page)).toBe('survey');
    expect(
      await page.evaluate(
        () =>
          (window as { __phase9_ui?: { speedMultiplier?: number } }).__phase9_ui?.speedMultiplier,
      ),
    ).toBe(speedBefore);
    // The P handler persists the pheromone-overlay flag through settings, so an
    // untouched settings blob proves the keystroke never reached it.
    expect(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY)).toBe(before);
  });
});
