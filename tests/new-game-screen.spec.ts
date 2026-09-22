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
import {
  DIALOG_SAVE_NOW_RECT,
  DIFFICULTY_ROW_RECTS,
  GAME_OVER_RESTART_RECT,
  NEW_GAME_START_RECT,
  SAVE_LOAD_ROW_RECT,
  SAVE_PROMPT_NEW_GAME_RECT,
  type Rect,
} from './helpers/geometry.js';
import {
  activeOverlay,
  activeView,
  bootScreen,
  clickCanvasPoint,
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

/** The live speed multiplier published by GameScene (1 after any boot). */
async function speedMultiplier(page: Page): Promise<number | undefined> {
  return await page.evaluate(
    () => (window as { __phase9_ui?: { speedMultiplier?: number } }).__phase9_ui?.speedMultiplier,
  );
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

/** Centre of the band where `button` overlaps `row` vertically, at the
 *  button's horizontal centre — i.e. a click on the button that would ALSO be
 *  a click on that row, were the row up. Throws if they don't overlap, since
 *  the replay regression this pins needs the overlap to exist at all. */
function overlapPoint(button: Rect, row: Rect): { x: number; y: number } {
  const top = Math.max(button.y, row.y);
  const bottom = Math.min(button.y + button.h, row.y + row.h);
  if (bottom <= top) {
    throw new Error('the button and the row no longer overlap — re-evaluate this test');
  }
  return { x: button.x + button.w / 2, y: (top + bottom) / 2 };
}

/** Save the running round through the pause menu's Save Now (a REAL,
 *  current-format save), then reload onto the Continue/New Game SavePrompt. */
async function saveAndReloadToSavePrompt(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
  await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
  await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');
  await page.evaluate((key) => localStorage.removeItem(key), SAVE_KEY);
  await clickCanvasRect(page, DIALOG_SAVE_NOW_RECT);
  await page.waitForFunction((key) => localStorage.getItem(key) !== null, SAVE_KEY, {
    timeout: 5_000,
  });
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await expect.poll(() => bootScreen(page), { timeout: 15_000 }).toBe('save-prompt');
}

/** After a click that OPENS the new-game screen, the screen must come up on
 *  the persisted tier and STAY there — the opening click must not be replayed
 *  onto the freshly built rows. */
async function expectScreenOpensOn(page: Page, tier: 'Easy' | 'Normal' | 'Hard'): Promise<void> {
  await expect.poll(() => bootScreen(page), { timeout: 10_000 }).toBe('difficulty-select');
  await expect.poll(() => selectedDifficulty(page), { timeout: 5_000 }).toBe(tier);
  await page.waitForTimeout(400);
  expect(await selectedDifficulty(page)).toBe(tier);
  expect(await bootScreen(page)).toBe('difficulty-select');
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

    // Regression guard: the Start click must be absorbed by the screen. If it
    // fell through to the HUD chain beneath the scrim (a per-object handler
    // that hid the screen before the scene-level dispatch ran), the same
    // click would land on whatever HUD widget sits under Start — the speed
    // widget once the opponent section pushes Start down — so nothing else
    // may have fired: speed still 1×, surface view, no overlay.
    await page.waitForTimeout(400);
    expect(await speedMultiplier(page)).toBe(1);
    expect(await activeView(page)).toBe('surface');
    expect(await activeOverlay(page)).toBe('none');
  });

  test('Enter typed into a host-page input does not start the round (website embed)', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await expect.poll(() => selectedDifficulty(page), { timeout: 5_000 }).toBe('Normal');
    // The library build mounts the game inline in the website page; a form
    // field there must keep its Enter. Simulate one: inject an <input>, focus
    // it, press Enter — the keydown still bubbles to Phaser's window listener.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'host-page-input';
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await bootScreen(page)).toBe('difficulty-select');
    expect(await roundDifficulty(page)).toBeUndefined();

    // Focus back on the game (a row click — the selected row, so no change)
    // and Enter starts as usual.
    await page.evaluate(() => document.getElementById('host-page-input')?.remove());
    await selectRow(page, 'Normal');
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
    expect(await roundDifficulty(page)).toBe('Normal');
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

  // Regression (#304 re-review): the rows are hit-tested in the scene-level
  // pointerdown handler. A click that OPENS the screen from a previous overlay
  // (SavePrompt "New Game", GameOver "Restart") used to open it mid-dispatch
  // and then be hit-tested against the new rows by the same handler — and
  // both buttons sit inside the Hard/Normal row bands, so a persisted Easy
  // came up as Hard or Normal. All three boot overlays now dispatch through
  // the scene-level handler, which returns after the opening branch.
  test('SavePrompt "New Game" clicked inside the Hard and Normal row bands opens on the persisted Easy', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await settleToPlaying(page, 'Easy'); // persists Easy
    expect(await storedDifficulty(page)).toBe('Easy');

    // Lower part of New Game — the pixels the Hard row would own.
    await saveAndReloadToSavePrompt(page);
    await clickCanvasPoint(
      page,
      overlapPoint(SAVE_PROMPT_NEW_GAME_RECT, DIFFICULTY_ROW_RECTS.Hard),
    );
    await expectScreenOpensOn(page, 'Easy');

    // Upper part of New Game — the pixels the Normal row would own.
    await settleToPlaying(page, 'Easy');
    await saveAndReloadToSavePrompt(page);
    await clickCanvasPoint(
      page,
      overlapPoint(SAVE_PROMPT_NEW_GAME_RECT, DIFFICULTY_ROW_RECTS.Normal),
    );
    await expectScreenOpensOn(page, 'Easy');
  });

  test('GameOver "Restart" (inside the Hard row band) opens on the persisted Easy', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await settleToPlaying(page, 'Easy');
    // Reach game over deterministically through the dev-only seam — the same
    // render-side transition a terminal tick outcome takes, sim untouched.
    await page.evaluate(() => {
      const t = (window as unknown as { __phase9_test?: { forceGameOver?: () => void } })
        .__phase9_test;
      if (!t?.forceGameOver) throw new Error('__phase9_test.forceGameOver not installed');
      t.forceGameOver();
    });
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');

    await clickCanvasPoint(page, overlapPoint(GAME_OVER_RESTART_RECT, DIFFICULTY_ROW_RECTS.Hard));
    await expectScreenOpensOn(page, 'Easy');
    // And the screen still works normally afterwards: Start boots Easy.
    await clickCanvasRect(page, NEW_GAME_START_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 10_000 }).toBe('none');
    expect(await roundDifficulty(page)).toBe('Easy');
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
