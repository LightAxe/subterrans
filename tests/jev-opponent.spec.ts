// tests/jev-opponent.spec.ts
// Jev opponent beta — the ONE E2E axis that runs with a Jev proxy endpoint
// configured, i.e. the only project where the new-game screen draws its
// opponent section (#304 items 3–4).
//
// Every other Playwright project boots with VITE_JEV_ENDPOINT pinned empty (the
// open-source default): no opponent section, the screen is exactly main's, and
// tests/new-game-screen.spec.ts covers it. This project runs its own dev server
// (port 5174, see playwright.config.ts `webServer[1]`) with the endpoint set.
//
// The endpoint is the proxy's BASE path (the client POSTs to `<base>/session`
// and `<base>/beat`) and deliberately points at a path that does NOT exist and
// is NOT under `/api` (which vite.config proxies to the deployed site): the
// point is to flip `isJevAvailable()`, not to talk to the model. A Jev round
// started here has its readiness probe 404, the controller falls back to the
// rule-based AI, and no request leaves the machine.
//
// What this pins (the issue's acceptance list, items 3–5, and Rob's 2026-10-09
// decisions on the default opponent and difficulty under Jev):
//   - the beta build's screen opens on Jev with the Balanced preset (its
//     default), the free-text box up and pre-filled; the Standard AI stays
//     selectable, and a choice made earlier in the session (restart, the next
//     New Game) is kept, while a new visit opens on the default again
//   - with Jev selected the difficulty rows are hidden and the match is played
//     at Normal; the Standard AI row brings them back with the player's tier,
//     which a Jev round does not overwrite
//   - a build WITHOUT a Jev endpoint (the :5173 server) defaults to the
//     Standard AI and never shows Jev, even with a Jev preference stored
//   - the free-text box is captioned "Custom instructions for Jev, your
//     opponent" (asserted through the box's accessible name, which is the same
//     string — the drawn caption is canvas text)
//   - nothing above Start starts: opponent rows, presets and the box only move
//     the selection; Start (button or Enter) begins the round, on the selected
//     tier AND opponent; Enter typed INSIDE the box does not
//   - the DOM <textarea> is torn down when the Jev row is left and on Start (a
//     leaked element would sit over the running game and swallow clicks — the
//     failure mode only a browser can observe)
//
// Geometry comes from tests/helpers/geometry.ts: the Jev-capable screen has TWO
// rect sets (Standard AI selected / Jev selected) because the opponent section
// grows, the difficulty rows come and go, and the stack re-centres, so Start
// moves between them.

import { test, expect, type Page } from '@playwright/test';
import {
  DIFFICULTY_ROW_RECTS,
  GAME_OVER_RESTART_RECT,
  JEV_BUILD_JEV_SELECTED as JEV,
  JEV_BUILD_RULES_SELECTED as RULES,
  JEV_ORDERS_PRESETS,
  NEW_GAME_START_RECT,
  type Difficulty,
  type OpponentKind,
  type Rect,
} from './helpers/geometry.js';
import {
  activeOverlay,
  bootScreen,
  clickCanvasRect,
  difficultyRowsVisible,
  selectedDifficulty,
  selectedOpponent,
} from './helpers/boot.js';
import { SETTINGS_KEY } from '../src/platform/settings.js';
import { JEV_ORDERS_CAPTION } from '../src/render/opponent-copy.js';

const SAVE_KEY = 'subterrans:save:v3';

/** The :5173 dev server (playwright.config.ts `webServer[0]`): the same game with
 *  NO Jev endpoint — what every non-beta build is. Both servers run for every
 *  project, so this spec can visit it for the no-endpoint case. */
const NO_ENDPOINT_URL = 'http://localhost:5173/';

/** Fresh boot onto the new-game screen with no save and (unless `keepSettings`)
 *  no settings blob, so the defaults are what's under test. `url` defaults to this
 *  project's server (the Jev endpoint configured). */
async function bootToNewGameScreen(
  page: Page,
  opts?: { keepSettings?: boolean; url?: string; settings?: Record<string, unknown> },
): Promise<void> {
  await page.goto(opts?.url ?? '/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.evaluate(
    ([saveKey, settingsKey, keepSettings, settings]) => {
      localStorage.removeItem(saveKey as string);
      if (keepSettings !== true) localStorage.removeItem(settingsKey as string);
      if (settings !== null) {
        localStorage.setItem(settingsKey as string, JSON.stringify({ version: 1, settings }));
      }
    },
    [SAVE_KEY, SETTINGS_KEY, opts?.keepSettings === true, opts?.settings ?? null] as const,
  );
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await expect.poll(() => bootScreen(page), { timeout: 15_000 }).toBe('difficulty-select');
}

/** Poll-click an opponent row until the screen reports it selected (a click
 *  that lands before the row is interactive simply retries). `rects` is the
 *  set for the state the screen is in BEFORE the click. */
async function selectOpponent(
  page: Page,
  kind: OpponentKind,
  rects: { opponentRows: Readonly<Record<OpponentKind, Rect>> },
): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await selectedOpponent(page)) === kind) return kind;
        await clickCanvasRect(page, rects.opponentRows[kind]);
        return selectedOpponent(page);
      },
      { timeout: 10_000 },
    )
    .toBe(kind);
}

/** Poll-click a difficulty row (at `rects`, the Standard AI set: with Jev selected
 *  there are none) until the screen reports it selected. */
async function selectTier(
  page: Page,
  tier: Difficulty,
  rects: Readonly<Record<Difficulty, Rect>>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await selectedDifficulty(page)) === tier) return tier;
        await clickCanvasRect(page, rects[tier]);
        return selectedDifficulty(page);
      },
      { timeout: 10_000 },
    )
    .toBe(tier);
}

/** Poll-click Start (at `startRect`) until the round is Playing. */
async function startRound(page: Page, startRect: Rect): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await activeOverlay(page)) === 'none') return 'none';
        await clickCanvasRect(page, startRect);
        return activeOverlay(page);
      },
      { timeout: 15_000 },
    )
    .toBe('none');
}

/** The opponent kind / difficulty the RUNNING round was created with. */
async function roundOpponent(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => {
    const t = (
      window as unknown as { __phase9_test?: { getRoundOpponent?: () => string | undefined } }
    ).__phase9_test;
    if (!t?.getRoundOpponent) throw new Error('__phase9_test.getRoundOpponent not installed');
    return t.getRoundOpponent();
  });
}
async function roundDifficulty(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => {
    const t = (
      window as unknown as { __phase9_test?: { getRoundDifficulty?: () => string | undefined } }
    ).__phase9_test;
    if (!t?.getRoundDifficulty) throw new Error('__phase9_test.getRoundDifficulty not installed');
    return t.getRoundDifficulty();
  });
}

function storedSettings(
  page: Page,
): Promise<{ opponent?: unknown; jevOrders?: unknown; difficulty?: unknown }> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    return (JSON.parse(raw) as { settings?: Record<string, unknown> }).settings ?? {};
  }, SETTINGS_KEY);
}

/** The screen must still be up after a generous settle window — the control
 *  just clicked is above Start and must not have started anything. */
async function expectStillOnScreen(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  expect(await bootScreen(page)).toBe('difficulty-select');
  expect(await roundOpponent(page)).toBeUndefined();
}

/** game-scene.ts notifyJevFallback's caption. */
const JEV_FALLBACK_CAPTION = 'Jev is unavailable — the standard AI has taken over';

interface EndScreenTestHooks {
  forceGameOver?: (outcome?: 'Victory' | 'Defeat' | 'MutualDestruction') => void;
  getEndScreenCauseLine?: () => string | null;
  getEndScreenTitle?: () => string | null;
  getCaptionsShown?: () => string[];
}

/** Drive the render-side game-over transition (the dev-only #304 seam). */
async function forceGameOver(
  page: Page,
  outcome: 'Victory' | 'Defeat' | 'MutualDestruction',
): Promise<void> {
  await page.evaluate((o) => {
    const t = (window as unknown as { __phase9_test?: EndScreenTestHooks }).__phase9_test;
    if (!t?.forceGameOver) throw new Error('__phase9_test.forceGameOver not installed');
    t.forceGameOver(o);
  }, outcome);
}

/** What the end screen drew (canvas text DOM locators cannot see). */
function endScreenTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: EndScreenTestHooks }).__phase9_test;
    if (!t?.getEndScreenTitle) throw new Error('getEndScreenTitle not installed');
    return t.getEndScreenTitle();
  });
}
function endScreenCauseLine(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: EndScreenTestHooks }).__phase9_test;
    if (!t?.getEndScreenCauseLine) throw new Error('getEndScreenCauseLine not installed');
    return t.getEndScreenCauseLine();
  });
}

/** Every caption shown this round, oldest first. */
function captionsShown(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as { __phase9_test?: EndScreenTestHooks }
      ).__phase9_test?.getCaptionsShown?.() ?? [],
  );
}

test.describe('Jev opponent beta — the opponent section of the new-game screen', () => {
  test('the beta opens on Jev with Balanced and no difficulty rows; Standard AI brings them back; a Jev match is Normal', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    const textarea = page.locator('textarea');
    const balanced = JEV_ORDERS_PRESETS.find((p) => p.id === 'balanced')!.text;

    // The beta's default: Jev, the Balanced preset's text in the box, and the
    // difficulty rows hidden (a Jev match is Normal).
    await expect.poll(() => selectedOpponent(page), { timeout: 5_000 }).toBe('jev');
    await expect(textarea).toHaveCount(1);
    await expect(textarea).toHaveValue(balanced);
    expect(await difficultyRowsVisible(page)).toBe(false);
    expect(await selectedDifficulty(page)).toBe('Normal');
    expect(JEV.difficultyRows).toBeNull();
    await expect(textarea).toHaveJSProperty('maxLength', 300);

    // The free-text box is captioned "Custom instructions for Jev, your
    // opponent": the drawn caption is canvas text, so the same string is the
    // box's accessible name.
    await expect(textarea).toHaveAttribute('aria-label', JEV_ORDERS_CAPTION);
    expect(JEV_ORDERS_CAPTION).toBe('Custom instructions for Jev, your opponent');

    // ...and it sits over the rect the layout reserved for it in the
    // Jev-selected state (the canvas renders at its logical size here, so rect
    // coordinates map 1:1).
    const canvasBox = await page.locator('canvas').first().boundingBox();
    const taBox = await textarea.boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(taBox).not.toBeNull();
    expect(taBox!.x - canvasBox!.x).toBeCloseTo(JEV.jev!.textarea.x, 0);
    expect(taBox!.y - canvasBox!.y).toBeCloseTo(JEV.jev!.textarea.y, 0);
    expect(taBox!.width).toBeCloseTo(JEV.jev!.textarea.w, 0);
    expect(taBox!.height).toBeCloseTo(JEV.jev!.textarea.h, 0);

    // A preset click only moves the highlight; still no round.
    const aggressive = JEV_ORDERS_PRESETS.findIndex((p) => p.id === 'aggressive');
    expect(aggressive).toBeGreaterThanOrEqual(0);
    await clickCanvasRect(page, JEV.jev!.presetButtons[aggressive]!);
    await expect(textarea).toHaveValue(JEV_ORDERS_PRESETS[aggressive]!.text);
    await expectStillOnScreen(page);

    // The Standard AI row hides the Jev options (the box is removed, not merely
    // hidden — a leaked element would sit over the canvas and swallow clicks)
    // and brings the difficulty rows back...
    await selectOpponent(page, 'rules', JEV);
    await expect(textarea).toHaveCount(0);
    await expect.poll(() => difficultyRowsVisible(page)).toBe(true);
    await expectStillOnScreen(page);
    // ...where a row click selects a tier, and does not start.
    await selectTier(page, 'Hard', RULES.difficultyRows!);
    await expectStillOnScreen(page);

    // Jev again: the box re-mounts and the rows go; the tier is kept, unseen...
    await selectOpponent(page, 'jev', RULES);
    await expect(textarea).toHaveCount(1);
    await expect.poll(() => difficultyRowsVisible(page)).toBe(false);
    expect(await selectedDifficulty(page)).toBe('Hard');
    // ...and comes back with the Standard AI row.
    await selectOpponent(page, 'rules', JEV);
    await expect.poll(() => difficultyRowsVisible(page)).toBe(true);
    expect(await selectedDifficulty(page)).toBe('Hard');

    // Start with Jev selected: a Jev round at Normal, the box torn down — and the
    // player's own tier (Hard) is still the one remembered for the next screen.
    await selectOpponent(page, 'jev', RULES);
    await startRound(page, JEV.startButton);
    expect(await bootScreen(page)).toBe('none');
    expect(await roundOpponent(page)).toBe('jev');
    expect(await roundDifficulty(page)).toBe('Normal');
    await expect(textarea).toHaveCount(0);
    expect((await storedSettings(page)).difficulty).toBe('Hard');
  });

  test('a Standard AI round plays the tier chosen for it', async ({ page }) => {
    await bootToNewGameScreen(page);
    await selectOpponent(page, 'rules', JEV);
    await selectTier(page, 'Easy', RULES.difficultyRows!);
    await startRound(page, RULES.startButton);
    expect(await roundOpponent(page)).toBe('rules');
    expect(await roundDifficulty(page)).toBe('Easy');
  });

  test('Enter typed inside the instructions box does not start; Enter on the screen does', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await selectOpponent(page, 'jev', RULES);
    const textarea = page.locator('textarea');
    await expect(textarea).toHaveCount(1);

    // Enter inside the box is the box's newline: the keydown stops propagating
    // before Phaser's window listener, and the Enter binding ignores editable
    // targets besides. The screen stays up.
    await textarea.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    // The keystroke landed in the box as a newline, so the first half is not
    // merely "nothing happened".
    await expect(textarea).toHaveValue(/\n/);
    expect(await bootScreen(page)).toBe('difficulty-select');
    expect(await roundOpponent(page)).toBeUndefined();

    // Give the focus back to the game — a click on the already-selected Jev
    // row, which changes nothing but blurs the box — and Enter starts the Jev
    // round.
    await clickCanvasRect(page, JEV.opponentRows.jev);
    await expect(textarea).not.toBeFocused();
    expect(await selectedOpponent(page)).toBe('jev');
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
    expect(await roundOpponent(page)).toBe('jev');
    await expect(textarea).toHaveCount(0);
  });

  test('presets overwrite the free text, typing makes it custom, and Start persists opponent + orders', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await selectOpponent(page, 'jev', RULES);
    const textarea = page.locator('textarea');
    await expect(textarea).toHaveCount(1);

    // A fresh visit opens on Jev with the `balanced` preset's text pre-filled
    // (the beta's default, defaultScreenOpponent), not an empty box.
    const balanced = JEV_ORDERS_PRESETS.find((p) => p.id === 'balanced')!.text;
    await expect(textarea).toHaveValue(balanced);

    // Picking a preset overwrites the field with that preset's shipped text.
    // (Economy: the shortest, so the typed suffix below stays under the 300 cap.)
    const economyIndex = JEV_ORDERS_PRESETS.findIndex((p) => p.id === 'economy');
    await clickCanvasRect(page, JEV.jev!.presetButtons[economyIndex]!);
    const economy = JEV_ORDERS_PRESETS[economyIndex]!.text;
    await expect(textarea).toHaveValue(economy);
    expect(economy.length + ' Dig fast.'.length).toBeLessThanOrEqual(300);

    // Typing appends; the screen re-renders (preset -> custom) WITHOUT destroying
    // the element or losing focus, so the appended text survives. The caret is
    // placed at the very end through the DOM (End only reaches the end of the
    // current WRAPPED line in a multi-line box).
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    await expect(textarea).toBeFocused();
    await page.keyboard.type(' Dig fast.');
    await expect(textarea).toHaveValue(`${economy} Dig fast.`);

    // Start commits the normalized orders and persists them.
    await startRound(page, JEV.startButton);
    expect(await roundOpponent(page)).toBe('jev');
    const settings = await storedSettings(page);
    expect(settings.opponent).toEqual({ kind: 'jev', orders: `${economy} Dig fast.` });
    expect(settings.jevOrders).toBe(`${economy} Dig fast.`);
  });

  test('a choice is kept for the session (Restart), and a new visit opens on the default again', async ({
    page,
  }) => {
    const balanced = JEV_ORDERS_PRESETS.find((p) => p.id === 'balanced')!.text;
    const textarea = page.locator('textarea');

    // The Standard AI on Hard...
    await bootToNewGameScreen(page);
    await selectOpponent(page, 'rules', JEV);
    await selectTier(page, 'Hard', RULES.difficultyRows!);
    await startRound(page, RULES.startButton);
    expect(await roundOpponent(page)).toBe('rules');
    expect(await roundDifficulty(page)).toBe('Hard');

    // ...is what Restart reopens on: not reset to the beta's Jev default.
    await forceGameOver(page, 'Defeat');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');
    await clickCanvasRect(page, GAME_OVER_RESTART_RECT);
    await expect.poll(() => bootScreen(page), { timeout: 10_000 }).toBe('difficulty-select');
    expect(await selectedOpponent(page)).toBe('rules');
    expect(await difficultyRowsVisible(page)).toBe(true);
    expect(await selectedDifficulty(page)).toBe('Hard');
    await expect(textarea).toHaveCount(0);

    // Jev with the player's own text, and Restart keeps that too. The box is
    // pre-filled with the Balanced text, so `fill` (clear + set, dispatching a
    // real `input` event) replaces it wholesale.
    await selectOpponent(page, 'jev', RULES);
    await textarea.fill('Hold the line.');
    await startRound(page, JEV.startButton);
    expect(await roundOpponent(page)).toBe('jev');
    expect(await roundDifficulty(page)).toBe('Normal');
    await forceGameOver(page, 'Defeat');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');
    await clickCanvasRect(page, GAME_OVER_RESTART_RECT);
    await expect.poll(() => bootScreen(page), { timeout: 10_000 }).toBe('difficulty-select');
    expect(await selectedOpponent(page)).toBe('jev');
    await expect(textarea).toHaveValue('Hold the line.');
    // The choice is still written down (the save-recovery fallbacks read it).
    const settings = await storedSettings(page);
    expect(settings.opponent).toEqual({ kind: 'jev', orders: 'Hold the line.' });
    expect(settings.jevOrders).toBe('Hold the line.');

    // A new visit (a reload, the settings kept) opens on the default again: Jev
    // with the Balanced preset, the rows hidden.
    await bootToNewGameScreen(page, { keepSettings: true });
    await expect.poll(() => selectedOpponent(page), { timeout: 5_000 }).toBe('jev');
    await expect(textarea).toHaveValue(balanced);
    expect(await difficultyRowsVisible(page)).toBe(false);
    // ...and the Standard AI row shows the tier the player last chose.
    await selectOpponent(page, 'rules', JEV);
    expect(await selectedDifficulty(page)).toBe('Hard');
  });

  test('a build with no Jev endpoint defaults to the Standard AI and never shows Jev', async ({
    page,
  }) => {
    // Even with a Jev preference stored on that origin.
    await bootToNewGameScreen(page, {
      url: NO_ENDPOINT_URL,
      settings: { opponent: { kind: 'jev', orders: 'Hold the line.' }, jevOrders: 'Hold.' },
    });
    await expect.poll(() => selectedOpponent(page), { timeout: 5_000 }).toBe('rules');
    expect(await difficultyRowsVisible(page)).toBe(true);
    await expect(page.locator('textarea')).toHaveCount(0);
    // The plain screen's rects (no opponent section): the tier and Start are where
    // main puts them.
    await selectTier(page, 'Hard', DIFFICULTY_ROW_RECTS);
    await startRound(page, NEW_GAME_START_RECT);
    expect(await roundOpponent(page)).toBe('rules');
    expect(await roundDifficulty(page)).toBe('Hard');
  });

  test('a Jev round that fell back: the end screen names how it ended, and Restart reopens the screen on Jev', async ({
    page,
  }) => {
    // Waits out a real fallback (~10 s of game time) on top of a full boot.
    test.setTimeout(120_000);
    await bootToNewGameScreen(page);
    await selectOpponent(page, 'jev', RULES);
    await startRound(page, JEV.startButton);
    expect(await roundOpponent(page)).toBe('jev');

    // The stub endpoint 404s: the readiness probe and the first two beats fail,
    // and the standard AI takes over for the round.
    await expect
      .poll(() => captionsShown(page), { timeout: 60_000 })
      .toContain(JEV_FALLBACK_CAPTION);

    // #389 — the end screen keys its title and cause line off how the match ended,
    // whoever drives the enemy colony: a draw with both queens alive is a DRAW.
    await forceGameOver(page, 'MutualDestruction');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');
    expect(await endScreenTitle(page)).toBe('DRAW');
    expect(await endScreenCauseLine(page)).toBe('Both colonies ran out of food — a draw');

    // Restart takes the end screen down and reopens the new-game screen with Jev
    // still selected; Start boots a fresh Jev round.
    await clickCanvasRect(page, GAME_OVER_RESTART_RECT);
    await expect.poll(() => bootScreen(page), { timeout: 10_000 }).toBe('difficulty-select');
    expect(await endScreenTitle(page)).toBeNull();
    expect(await endScreenCauseLine(page)).toBeNull();
    expect(await selectedOpponent(page)).toBe('jev');
    await startRound(page, JEV.startButton);
    expect(await roundOpponent(page)).toBe('jev');

    // Nothing of the last round's ending carries into this one's.
    await forceGameOver(page, 'Defeat');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('game-over');
    expect(await endScreenTitle(page)).toBe('DEFEAT');
    expect(await endScreenCauseLine(page)).toBe('');
  });
});
