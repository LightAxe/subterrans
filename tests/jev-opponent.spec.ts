// tests/jev-opponent.spec.ts
// W3 — the ONE E2E axis that runs with a Jev proxy endpoint configured.
//
// Every other Playwright project boots with VITE_JEV_ENDPOINT pinned empty (the
// open-source default), which means the Jev toggle is disabled, the
// standing-orders section is never drawn and the DOM <textarea> is never mounted
// — so nothing in that suite can see the feature at all. This project runs its
// own dev server (port 5174, see playwright.config.ts `webServer[1]`) with the
// endpoint set, which is what makes the picker's interactive path reachable.
//
// The endpoint is the proxy's BASE path (the client POSTs to `<base>/session`
// and `<base>/beat`) and deliberately points at a path that does NOT exist and
// is NOT under `/api` (which vite.config proxies to the deployed site): the
// point is to flip `isJevAvailable()`, not to talk to the model. The session
// mint 404s, the controller falls back to the rule-based AI after three
// failures, and no request leaves the machine.
//
// What this spec is for, and why unit tests cannot replace it: `ui-scene.ts` is
// excluded from the coverage gate because it is a Phaser scene, and the riskiest
// thing W3 added there is a real DOM element mounted over the canvas. A leaked
// <textarea> surviving the overlay would sit on top of the running game,
// swallowing clicks — the one failure mode only a browser can observe.

import { test, expect, type Page } from '@playwright/test';

import {
  DIFFICULTY_NORMAL_RECT,
  OPPONENT_JEV_RECT,
  OPPONENT_RULES_RECT,
  OPPONENT_PRESET_RECTS,
  OPPONENT_TEXTAREA_RECT,
  JEV_ORDERS_PRESETS,
  centerOf,
  type Rect,
} from './helpers/geometry.js';

const SAVE_KEY = 'subterrans:save:v3';
const SETTINGS_KEY = 'subterrans:settings:v1';

/** Click a canvas-local rect's center. */
async function clickRect(page: Page, rect: Rect): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const c = centerOf(rect);
  await page.mouse.click(box.x + c.x, box.y + c.y);
}

/** Boot to a fresh "Choose Difficulty" overlay with no save and no settings. */
async function bootToPicker(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined',
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(
    ([save, settings]) => {
      localStorage.removeItem(save!);
      localStorage.removeItem(settings!);
    },
    [SAVE_KEY, SETTINGS_KEY],
  );
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui?.bootScreen,
        ),
      { timeout: 15_000 },
    )
    .toBe('difficulty-select');
}

function storedSettings(page: Page): Promise<{ opponent?: unknown; jevOrders?: unknown }> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    return (JSON.parse(raw) as { settings?: Record<string, unknown> }).settings ?? {};
  }, SETTINGS_KEY);
}

test.describe('W3 — opponent picker with the Jev endpoint configured', () => {
  test('mounts the standing-orders textarea only while Jev is selected, and tears it down on start', async ({
    page,
  }) => {
    await bootToPicker(page);
    const textarea = page.locator('textarea');

    // Standard AI is the default: no standing orders, no DOM element.
    await expect(textarea).toHaveCount(0);

    // Selecting Jev mounts the textarea over the free-text rect.
    await clickRect(page, OPPONENT_JEV_RECT);
    await expect(textarea).toHaveCount(1);
    await expect(textarea).toHaveJSProperty('maxLength', 300);

    // It is positioned over the rect the overlay drew for it. The canvas renders
    // at its logical size in this viewport, so rect coordinates map 1:1.
    const canvasBox = await page.locator('canvas').first().boundingBox();
    const taBox = await textarea.boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(taBox).not.toBeNull();
    expect(taBox!.x - canvasBox!.x).toBeCloseTo(OPPONENT_TEXTAREA_RECT.x, 0);
    expect(taBox!.y - canvasBox!.y).toBeCloseTo(OPPONENT_TEXTAREA_RECT.y, 0);
    expect(taBox!.width).toBeCloseTo(OPPONENT_TEXTAREA_RECT.w, 0);
    expect(taBox!.height).toBeCloseTo(OPPONENT_TEXTAREA_RECT.h, 0);

    // Toggling back to the Standard AI removes it again — a leaked element would
    // sit over the canvas and swallow clicks.
    await clickRect(page, OPPONENT_RULES_RECT);
    await expect(textarea).toHaveCount(0);

    // ...and selecting Jev again re-mounts it, then starting the game removes it
    // for good. This is the leak that only a browser can catch.
    await clickRect(page, OPPONENT_JEV_RECT);
    await expect(textarea).toHaveCount(1);
    await clickRect(page, DIFFICULTY_NORMAL_RECT);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui?.activeOverlay,
          ),
        { timeout: 15_000 },
      )
      .toBe('none');
    await expect(textarea).toHaveCount(0);
  });

  test('presets overwrite the free text, typing makes it custom, and the choice persists', async ({
    page,
  }) => {
    await bootToPicker(page);
    await clickRect(page, OPPONENT_JEV_RECT);
    const textarea = page.locator('textarea');
    await expect(textarea).toHaveCount(1);

    // Default preset is `balanced` — pre-filled with its tuned (non-empty) text
    // for a fresh player (no saved preference), from settings.ts's default.
    const balancedIndex = JEV_ORDERS_PRESETS.findIndex((p) => p.id === 'balanced');
    expect(balancedIndex).toBeGreaterThanOrEqual(0);
    const balanced = JEV_ORDERS_PRESETS[balancedIndex]!.text;
    await expect(textarea).toHaveValue(balanced);

    // Picking a preset overwrites the field with that preset's shipped text.
    const aggressiveIndex = JEV_ORDERS_PRESETS.findIndex((p) => p.id === 'aggressive');
    expect(aggressiveIndex).toBeGreaterThanOrEqual(0);
    await clickRect(page, OPPONENT_PRESET_RECTS[aggressiveIndex]!);
    const aggressive = JEV_ORDERS_PRESETS[aggressiveIndex]!.text;
    await expect(textarea).toHaveValue(aggressive);

    // Typing appends to it; the overlay re-renders (preset -> custom) WITHOUT
    // destroying the element or losing focus, so the appended text survives.
    await textarea.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Dig fast.');
    await expect(textarea).toHaveValue(`${aggressive} Dig fast.`);

    // Starting the game commits the normalized orders and persists them.
    await clickRect(page, DIFFICULTY_NORMAL_RECT);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui?.activeOverlay,
          ),
        { timeout: 15_000 },
      )
      .toBe('none');

    const settings = await storedSettings(page);
    expect(settings.opponent).toEqual({ kind: 'jev', orders: `${aggressive} Dig fast.` });
    expect(settings.jevOrders).toBe(`${aggressive} Dig fast.`);
  });

  test('a round against the Standard AI keeps the remembered standing orders', async ({ page }) => {
    await bootToPicker(page);

    // Write some orders and start a Jev round so the preference is persisted.
    // The box is pre-filled with the `balanced` default text (a fresh player),
    // so `fill` (clear + set, dispatching a real `input` event) replaces it
    // wholesale rather than typing into the middle of the existing text.
    await clickRect(page, OPPONENT_JEV_RECT);
    const textarea = page.locator('textarea');
    await textarea.fill('Hold the line.');
    await clickRect(page, DIFFICULTY_NORMAL_RECT);
    await expect
      .poll(() => storedSettings(page).then((s) => s.jevOrders), { timeout: 15_000 })
      .toBe('Hold the line.');

    // Reboot, pick the Standard AI, start. The opponent flips to `rules` but the
    // text must survive — `{ kind: 'rules' }` has nowhere to carry it, which is
    // exactly why settings.jevOrders exists.
    await page.evaluate((key) => localStorage.removeItem(key), SAVE_KEY);
    await page.reload();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui?.bootScreen,
          ),
        { timeout: 15_000 },
      )
      .toBe('difficulty-select');

    // The overlay reopened pre-selected on Jev, so the textarea is already up
    // with the remembered text.
    await expect(textarea).toHaveValue('Hold the line.');

    await clickRect(page, OPPONENT_RULES_RECT);
    await expect(textarea).toHaveCount(0);
    await clickRect(page, DIFFICULTY_NORMAL_RECT);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as { __phase9_ui?: { activeOverlay: string } }).__phase9_ui?.activeOverlay,
          ),
        { timeout: 15_000 },
      )
      .toBe('none');

    const settings = await storedSettings(page);
    expect(settings.opponent).toEqual({ kind: 'rules' });
    expect(settings.jevOrders).toBe('Hold the line.');
  });
});
