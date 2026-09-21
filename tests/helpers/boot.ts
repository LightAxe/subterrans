// tests/helpers/boot.ts
// Shared drive-the-boot-overlays helpers for the Playwright specs (#304).
//
// Every spec that needs a running game used to carry its own copy of a
// "poll-click Normal until Playing" loop. The new-game screen has two steps —
// pick a difficulty row, then press Start (only Start, or Enter, begins the
// round) — so the loop lives here once, and a future change to the boot flow
// is a one-file edit instead of a suite-wide hunt (#186 is how that goes).
//
// Observability comes from window.__phase9_ui (published by ui-scene.ts):
//   activeOverlay       'save-prompt' while any boot overlay is up, 'none' when
//                       Playing
//   bootScreen          'difficulty-select' (the new-game screen) vs
//                       'save-prompt' (a real Continue/New Game prompt) — both
//                       report activeOverlay 'save-prompt', so this is the
//                       discriminator
//   selectedDifficulty  the row currently selected on the new-game screen

import { expect, type Page } from '@playwright/test';
import {
  DIFFICULTY_ROW_RECTS,
  NEW_GAME_START_RECT,
  type Difficulty,
  type Rect,
} from './geometry.js';

/** Click the center of a canvas-local rect. */
export async function clickCanvasRect(page: Page, rect: Rect): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
}

/** Click an exact canvas-local point (for off-centre clicks inside a rect). */
export async function clickCanvasPoint(page: Page, pt: { x: number; y: number }): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
}

/** Single-finger tap on the center of a canvas-local rect (a real touch
 *  pointer — needs a project with hasTouch, e.g. chromium-touch). */
export async function tapCanvasRect(page: Page, rect: Rect): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.touchscreen.tap(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
}

/** Raw activeOverlay read. Returns '<undefined>' (NOT 'none') before the hook
 *  has been published, so a still-booting page can't pass as Playing. */
export async function activeOverlay(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { activeOverlay?: string } }).__phase9_ui;
    return ui?.activeOverlay ?? '<undefined>';
  });
}

/** Which boot overlay is up: 'difficulty-select' | 'save-prompt' | 'none', or
 *  '<undefined>' before the hook has been published. */
export async function bootScreen(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui;
    return ui?.bootScreen ?? '<undefined>';
  });
}

/** Which view is showing ('surface' | 'underground'), published every frame
 *  once the game is running; '<undefined>' before then. */
export async function activeView(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { activeView?: string } }).__phase9_ui;
    return ui?.activeView ?? '<undefined>';
  });
}

/** The difficulty row currently selected on the new-game screen, or
 *  '<undefined>' before the screen has published one. */
export async function selectedDifficulty(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { selectedDifficulty?: string } }).__phase9_ui;
    return ui?.selectedDifficulty ?? '<undefined>';
  });
}

/** Wait until UIScene.create() has published the observability hook. */
export async function waitForUiHook(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined',
    undefined,
    { timeout: 15_000 },
  );
}

/**
 * Drive the boot to Playing (activeOverlay === 'none') on `difficulty`.
 *
 * Poll-clicks so a click that lands before the overlay is interactive simply
 * retries: while the selected row is not the requested tier, click that row;
 * once it is, click Start. Exits the moment Playing is reached and never
 * over-clicks into the game. Requires no real Continue/New Game SavePrompt to
 * be up (clear the save first, or dismiss the prompt before calling) — the
 * Normal row overlaps the SavePrompt's Continue button.
 *
 * `via: 'touch'` drives the same two steps with single-finger taps (a real
 * touch pointer; chromium-touch project) so the touch path is pinned too.
 */
export async function settleToPlaying(
  page: Page,
  difficulty: Difficulty = 'Normal',
  opts: { via?: 'mouse' | 'touch' } = {},
): Promise<void> {
  const press = opts.via === 'touch' ? tapCanvasRect : clickCanvasRect;
  await waitForUiHook(page);
  // Don't mistake the pre-overlay frame for Playing: the hook's activeOverlay
  // DEFAULTS to 'none' on its first publish, before any boot overlay has been
  // shown, while bootScreen is unpublished ('<undefined>') until one has. So
  // wait until either the new-game screen is up, or a boot overlay has already
  // come and gone and the game is genuinely Playing (a caller that dismissed a
  // SavePrompt via Continue lands here) — only then drive the click loop.
  await expect
    .poll(
      async () => {
        const screen = await bootScreen(page);
        if (screen === 'difficulty-select') return 'ready';
        if (screen === 'none' && (await activeOverlay(page)) === 'none') return 'ready';
        return screen;
      },
      { timeout: 15_000 },
    )
    .toBe('ready');
  await expect
    .poll(
      async () => {
        if ((await activeOverlay(page)) === 'none') return 'none';
        if ((await selectedDifficulty(page)) === difficulty) {
          await press(page, NEW_GAME_START_RECT);
        } else {
          await press(page, DIFFICULTY_ROW_RECTS[difficulty]);
        }
        return activeOverlay(page);
      },
      { timeout: 15_000 },
    )
    .toBe('none');
}
