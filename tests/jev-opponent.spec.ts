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
// What this pins (the issue's acceptance list, items 3–5):
//   - the opponent row defaults to Standard AI, and the Jev options (the preset
//     buttons and the free-text box) are hidden until Jev is selected
//   - the free-text box is captioned "Custom instructions for Jev, your
//     opponent" (asserted through the box's accessible name, which is the same
//     string — the drawn caption is canvas text)
//   - nothing above Start starts: opponent rows, presets and the box only move
//     the selection; Start (button or Enter) begins the round, on the selected
//     tier AND opponent; Enter typed INSIDE the box does not
//   - the choice persists across a reload (opponent + orders), and a round
//     against the Standard AI keeps the remembered orders
//   - the DOM <textarea> is torn down when the Jev row is left and on Start (a
//     leaked element would sit over the running game and swallow clicks — the
//     failure mode only a browser can observe)
//
// Geometry comes from tests/helpers/geometry.ts: the Jev-capable screen has TWO
// rect sets (Standard AI selected / Jev selected) because the section grows and
// the stack re-centres, so the difficulty rows and Start move between them.

import { test, expect, type Page } from '@playwright/test';
import {
  JEV_BUILD_JEV_SELECTED as JEV,
  JEV_BUILD_RULES_SELECTED as RULES,
  JEV_ORDERS_PRESETS,
  type OpponentKind,
  type Rect,
} from './helpers/geometry.js';
import {
  activeOverlay,
  bootScreen,
  clickCanvasRect,
  selectedDifficulty,
  selectedOpponent,
} from './helpers/boot.js';
import { SETTINGS_KEY } from '../src/platform/settings.js';
import { JEV_ORDERS_CAPTION } from '../src/render/opponent-copy.js';

const SAVE_KEY = 'subterrans:save:v3';

/** Fresh boot onto the new-game screen with no save and (unless `keepSettings`)
 *  no settings blob, so the defaults are what's under test. */
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

function storedSettings(page: Page): Promise<{ opponent?: unknown; jevOrders?: unknown }> {
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

test.describe('Jev opponent beta — the opponent section of the new-game screen', () => {
  test('defaults to Standard AI with the Jev options hidden; Jev reveals them; Start boots the selected tier + opponent', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    const textarea = page.locator('textarea');

    // Defaults: Normal + Standard AI, and no Jev options (the free-text box is
    // the DOM-observable part of them; the presets live on the canvas).
    await expect.poll(() => selectedOpponent(page), { timeout: 5_000 }).toBe('rules');
    expect(await selectedDifficulty(page)).toBe('Normal');
    await expect(textarea).toHaveCount(0);

    // Selecting Jev moves the selection and reveals the options — and does NOT
    // start the round.
    await selectOpponent(page, 'jev', RULES);
    await expectStillOnScreen(page);
    await expect(textarea).toHaveCount(1);
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

    // The difficulty rows moved with the re-centred stack: the Jev-state rect
    // for Hard selects Hard, and still does not start.
    await expect
      .poll(
        async () => {
          await clickCanvasRect(page, JEV.difficultyRows.Hard);
          return selectedDifficulty(page);
        },
        { timeout: 10_000 },
      )
      .toBe('Hard');
    await expectStillOnScreen(page);

    // Back to Standard AI hides the options (the box is removed, not merely
    // hidden — a leaked element would sit over the canvas and swallow clicks)...
    await selectOpponent(page, 'rules', JEV);
    await expect(textarea).toHaveCount(0);
    await expectStillOnScreen(page);
    // ...and Jev again re-mounts it.
    await selectOpponent(page, 'jev', RULES);
    await expect(textarea).toHaveCount(1);

    // Start (its Jev-state rect) boots Hard + Jev, and tears the box down.
    await startRound(page, JEV.startButton);
    expect(await bootScreen(page)).toBe('none');
    expect(await roundDifficulty(page)).toBe('Hard');
    expect(await roundOpponent(page)).toBe('jev');
    await expect(textarea).toHaveCount(0);
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

    // A fresh player sees the `balanced` preset's tuned text pre-filled
    // (settings.ts's default), not an empty box.
    const balanced = JEV_ORDERS_PRESETS.find((p) => p.id === 'balanced')!.text;
    await expect(textarea).toHaveValue(balanced);

    // Picking a preset overwrites the field with that preset's shipped text.
    const aggressiveIndex = JEV_ORDERS_PRESETS.findIndex((p) => p.id === 'aggressive');
    await clickCanvasRect(page, JEV.jev!.presetButtons[aggressiveIndex]!);
    const aggressive = JEV_ORDERS_PRESETS[aggressiveIndex]!.text;
    await expect(textarea).toHaveValue(aggressive);

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
    await expect(textarea).toHaveValue(`${aggressive} Dig fast.`);

    // Start commits the normalized orders and persists them.
    await startRound(page, JEV.startButton);
    expect(await roundOpponent(page)).toBe('jev');
    const settings = await storedSettings(page);
    expect(settings.opponent).toEqual({ kind: 'jev', orders: `${aggressive} Dig fast.` });
    expect(settings.jevOrders).toBe(`${aggressive} Dig fast.`);
  });

  test('the choice persists across a reload, and a Standard AI round keeps the remembered orders', async ({
    page,
  }) => {
    await bootToNewGameScreen(page);
    await selectOpponent(page, 'jev', RULES);
    const textarea = page.locator('textarea');
    // The box is pre-filled with the `balanced` text, so `fill` (clear + set,
    // dispatching a real `input` event) replaces it wholesale.
    await textarea.fill('Hold the line.');
    await startRound(page, JEV.startButton);
    await expect
      .poll(() => storedSettings(page).then((s) => s.jevOrders), { timeout: 15_000 })
      .toBe('Hold the line.');

    // Reload with the save cleared but the settings kept: the screen comes back
    // with Jev selected, its options up and the remembered text in the box.
    await bootToNewGameScreen(page, { keepSettings: true });
    await expect.poll(() => selectedOpponent(page), { timeout: 5_000 }).toBe('jev');
    await expect(textarea).toHaveCount(1);
    await expect(textarea).toHaveValue('Hold the line.');

    // Pick the Standard AI and start. The opponent flips to `rules` but the
    // text must survive — `{ kind: 'rules' }` has nowhere to carry it, which is
    // exactly why settings.jevOrders exists.
    await selectOpponent(page, 'rules', JEV);
    await expect(textarea).toHaveCount(0);
    await startRound(page, RULES.startButton);
    expect(await roundOpponent(page)).toBe('rules');
    const settings = await storedSettings(page);
    expect(settings.opponent).toEqual({ kind: 'rules' });
    expect(settings.jevOrders).toBe('Hold the line.');

    // And the next screen opens on Standard AI (persisted), with the text still
    // waiting behind the Jev row.
    await bootToNewGameScreen(page, { keepSettings: true });
    await expect.poll(() => selectedOpponent(page), { timeout: 5_000 }).toBe('rules');
    await expect(textarea).toHaveCount(0);
    await selectOpponent(page, 'jev', RULES);
    await expect(textarea).toHaveValue('Hold the line.');
  });
});
