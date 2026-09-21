// tests/new-game-screen.spec.ts — #304 new-game screen boot flow.
//
// Options first, one Start button last. Pins the contract the issue asks for:
//   - the default selection is Normal
//   - clicking a difficulty row moves the selection and does NOT start a round
//   - Start begins the round on the selected tier; Enter does the same
//   - the last-used tier is persisted (settings.difficulty) and the screen
//     comes back with it selected after a reload
//
// Geometry comes from tests/helpers/geometry.ts (the pure layout function
// evaluated at the default layout); the drive-to-Playing loop is the shared
// tests/helpers/boot.ts helper every other spec uses. State is read through
// window.__phase9_ui (selectedDifficulty / bootScreen / activeOverlay) and the
// dev-only window.__phase9_test.getRoundDifficulty() for the running round.

import { test, expect, type Page } from '@playwright/test';
import { DIFFICULTY_ROW_RECTS, NEW_GAME_START_RECT } from './helpers/geometry.js';
import {
  activeOverlay,
  bootScreen,
  clickCanvasRect,
  selectedDifficulty,
  settleToPlaying,
} from './helpers/boot.js';
import { SETTINGS_KEY } from '../src/platform/settings.js';

const SAVE_KEY = 'subterrans:save:v3';

/** Fresh boot onto the new-game screen: no save (so no Continue/New Game
 *  SavePrompt) and, unless `keepSettings`, no settings blob (so the default
 *  selection is what's under test, not a tier left over from another spec). */
async function bootToNewGameScreen(page: Page, opts?: { keepSettings?: boolean }): Promise<void> {
  await page.goto('/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.evaluate(
    ([saveKey, settingsKey, keepSettings]) => {
      localStorage.removeItem(saveKey as string);
      if (keepSettings !== true) localStorage.removeItem(settingsKey as string);
    },
    [SAVE_KEY, SETTINGS_KEY, opts?.keepSettings === true] as const,
  );
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await expect.poll(() => bootScreen(page), { timeout: 15_000 }).toBe('difficulty-select');
}

/** The tier the RUNNING round was created with (undefined before any boot). */
async function roundDifficulty(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => {
    const t = (
      window as unknown as { __phase9_test?: { getRoundDifficulty?: () => string | undefined } }
    ).__phase9_test;
    if (!t?.getRoundDifficulty) throw new Error('__phase9_test.getRoundDifficulty not installed');
    return t.getRoundDifficulty();
  });
}

/** The persisted settings.difficulty, or null when no settings blob exists. */
async function storedDifficulty(page: Page): Promise<string | null> {
  return await page.evaluate((key) => {
    const raw = localStorage.getItem(key as string);
    if (raw === null) return null;
    const env = JSON.parse(raw) as { settings?: { difficulty?: unknown } };
    const d = env.settings?.difficulty;
    return typeof d === 'string' ? d : null;
  }, SETTINGS_KEY);
}

/** Poll-click a row until the screen reports it selected (a click that lands
 *  before the row is interactive simply retries). */
async function selectRow(page: Page, tier: 'Easy' | 'Normal' | 'Hard'): Promise<void> {
  await expect
    .poll(
      async () => {
        await clickCanvasRect(page, DIFFICULTY_ROW_RECTS[tier]);
        return selectedDifficulty(page);
      },
      { timeout: 10_000 },
    )
    .toBe(tier);
}

test.describe('#304 new-game screen — options first, Start last', () => {
  test('defaults to Normal; a row click moves the selection without starting; Start boots the selected tier', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await expect.poll(() => selectedDifficulty(page), { timeout: 5_000 }).toBe('Normal');
    expect(await roundDifficulty(page)).toBeUndefined();

    // Pick Hard. The selection moves, and nothing above Start starts a round:
    // the screen is still up after a generous settle window.
    await selectRow(page, 'Hard');
    await page.waitForTimeout(750);
    expect(await bootScreen(page)).toBe('difficulty-select');
    expect(await activeOverlay(page)).toBe('save-prompt');
    expect(await roundDifficulty(page)).toBeUndefined();

    // Start → Playing, and the running round is the Hard one.
    await clickCanvasRect(page, NEW_GAME_START_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 10_000 }).toBe('none');
    expect(await bootScreen(page)).toBe('none');
    expect(await roundDifficulty(page)).toBe('Hard');
  });

  test('Enter starts the round on the current selection', async ({ page }) => {
    await bootToNewGameScreen(page);
    await expect.poll(() => selectedDifficulty(page), { timeout: 5_000 }).toBe('Normal');
    // Move the selection off the default first, so the assertion below can
    // tell "Enter commits the selection" from "Enter boots Normal". (The row
    // click also gives the document focus for the key event.)
    await selectRow(page, 'Easy');
    await page.waitForTimeout(300);
    expect(await bootScreen(page)).toBe('difficulty-select');

    // Enter is bound by UIScene.create(), which ran before the screen appeared,
    // so a single press suffices; poll anyway so a press swallowed by a not-yet-
    // focused document retries instead of flaking.
    await expect
      .poll(
        async () => {
          if ((await activeOverlay(page)) === 'none') return 'none';
          await page.keyboard.press('Enter');
          return activeOverlay(page);
        },
        { timeout: 10_000 },
      )
      .toBe('none');
    expect(await roundDifficulty(page)).toBe('Easy');
  });

  test('the last-used tier is persisted and pre-selected after a reload', async ({ page }) => {
    await bootToNewGameScreen(page);
    expect(await storedDifficulty(page)).toBeNull();

    // Start a Hard round through the shared helper (row, then Start).
    await settleToPlaying(page, 'Hard');
    expect(await roundDifficulty(page)).toBe('Hard');
    expect(await storedDifficulty(page)).toBe('Hard');

    // Reload with the save cleared (so we land on the new-game screen, not a
    // SavePrompt) but the settings kept: the screen comes back on Hard.
    await bootToNewGameScreen(page, { keepSettings: true });
    await expect.poll(() => selectedDifficulty(page), { timeout: 5_000 }).toBe('Hard');
    expect(await roundDifficulty(page)).toBeUndefined();

    // And Start, with no further input, boots that remembered tier.
    await clickCanvasRect(page, NEW_GAME_START_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 10_000 }).toBe('none');
    expect(await roundDifficulty(page)).toBe('Hard');
  });

  test('a stored tier the build does not know falls back to Normal', async ({ page }) => {
    await page.goto('/');
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.evaluate(
      ([saveKey, settingsKey]) => {
        localStorage.removeItem(saveKey as string);
        localStorage.setItem(
          settingsKey as string,
          JSON.stringify({ version: 1, settings: { difficulty: 'Impossible' } }),
        );
      },
      [SAVE_KEY, SETTINGS_KEY] as const,
    );
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await expect.poll(() => bootScreen(page), { timeout: 15_000 }).toBe('difficulty-select');
    await expect.poll(() => selectedDifficulty(page), { timeout: 5_000 }).toBe('Normal');
  });
});
