// end-screen-cause.spec.ts — #389: the end screen's title and cause line name
// how the match really ended.
//
// A stalemate ends a match as a draw (GameOutcome.MutualDestruction) with both
// queens alive. Its title used to read MUTUAL DESTRUCTION; it now reads DRAW
// (MUTUAL DESTRUCTION is kept for a real double queen death). When the round_end
// that says it was a stalemate is missing, the GameOver overlay has no narrative
// and falls back to the cause line — which used to read "Both queens died at the
// same time". The survey (playtrace on) never shows the narrative, so it read
// that line on every stalemate.
//
// The dev-only __phase9_test.forceGameOver('MutualDestruction') seam reaches
// exactly that state through the real render-side game-over path: a live world
// with both queens alive and no terminal event, ending as a draw — a stalemate
// whose round_end was lost. getEndScreenTitle() / getEndScreenCauseLine() read
// what the overlay drew (Phaser text on the canvas, which DOM locators cannot see).

import { test, expect, type Page } from '@playwright/test';

import { activeOverlay, clickCanvasRect, settleToPlaying } from './helpers/boot.js';
import { GAME_OVER_RESTART_RECT } from './helpers/geometry.js';
import { SETTINGS_KEY } from '../src/platform/settings.js';

const SAVE_KEY = 'subterrans:save:v3';
/** The same game mounted with the playtrace feature (and so the survey) ON. */
const PLAYTRACE_ON_FIXTURE = '/tests/fixtures/playtrace-on.html';

type ForcedOutcome = 'Victory' | 'Defeat' | 'MutualDestruction';
interface EndScreenTestHooks {
  forceGameOver?: (outcome?: ForcedOutcome) => void;
  getEndScreenCauseLine?: () => string | null;
  getEndScreenTitle?: () => string | null;
}

/** Load `path` with no save and default settings, then start a Normal round. */
async function bootToPlaying(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.evaluate(
    ([saveKey, settingsKey]) => {
      localStorage.removeItem(saveKey as string);
      localStorage.removeItem(settingsKey as string);
    },
    [SAVE_KEY, SETTINGS_KEY] as const,
  );
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await settleToPlaying(page, 'Normal');
}

async function forceGameOver(page: Page, outcome: ForcedOutcome): Promise<void> {
  await page.evaluate((o) => {
    const t = (window as unknown as { __phase9_test?: EndScreenTestHooks }).__phase9_test;
    if (!t?.forceGameOver) throw new Error('__phase9_test.forceGameOver not installed');
    t.forceGameOver(o);
  }, outcome);
}

async function endScreenCauseLine(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: EndScreenTestHooks }).__phase9_test;
    if (!t?.getEndScreenCauseLine) throw new Error('getEndScreenCauseLine not installed');
    return t.getEndScreenCauseLine();
  });
}

async function endScreenTitle(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: EndScreenTestHooks }).__phase9_test;
    if (!t?.getEndScreenTitle) throw new Error('getEndScreenTitle not installed');
    return t.getEndScreenTitle();
  });
}

const STALEMATE_LINE = 'Both colonies ran out of food — a draw';
/** The title of a draw no queen died in — never MUTUAL DESTRUCTION. */
const DRAW_TITLE = 'DRAW';

test.describe('#389 — end-screen title and cause line on a draw with both queens alive', () => {
  // A full boot (assets + the new-game screen + a live world) runs past the
  // suite's 30s default on a cold dev server.
  test.describe.configure({ timeout: 90_000 });

  test('GameOver overlay: DRAW, and with no narrative the fallback line names the stalemate', async ({
    page,
  }) => {
    await bootToPlaying(page, '/');
    await forceGameOver(page, 'MutualDestruction');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');
    expect(await endScreenTitle(page)).toBe(DRAW_TITLE);
    expect(await endScreenCauseLine(page)).toBe(STALEMATE_LINE);
    // Restart takes the overlay down, and its title and line with it.
    await clickCanvasRect(page, GAME_OVER_RESTART_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).not.toBe('game-over');
    expect(await endScreenTitle(page)).toBeNull();
    expect(await endScreenCauseLine(page)).toBeNull();
  });

  test('survey overlay (playtrace on): DRAW, and its cause line names the stalemate', async ({
    page,
  }) => {
    await bootToPlaying(page, PLAYTRACE_ON_FIXTURE);
    await forceGameOver(page, 'MutualDestruction');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('survey');
    expect(await endScreenTitle(page)).toBe(DRAW_TITLE);
    expect(await endScreenCauseLine(page)).toBe(STALEMATE_LINE);
  });

  test('control: a Defeat with no terminal event: DEFEAT, and no cause (nothing to say)', async ({
    page,
  }) => {
    await bootToPlaying(page, '/');
    await forceGameOver(page, 'Defeat');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');
    expect(await endScreenTitle(page)).toBe('DEFEAT');
    expect(await endScreenCauseLine(page)).toBe('');
  });
});
