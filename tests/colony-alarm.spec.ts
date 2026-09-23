// colony-alarm.spec.ts — C1: the colony alarm reaches the sim from a real browser.
//
// The sim behaviour is pinned in unit tests; what only a browser can prove is
// that the HUD button and the R keybind actually enqueue SetColonyAlarm and that
// tick() applies it. Asserted through window.__phase9_ui.alarmActive, which
// UIScene republishes every frame from the live ColonyRecord — so a green run
// means the command round-tripped through the queue into sim state, not merely
// that a local flag flipped.

import { test, expect, type ConsoleMessage } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { ALARM_TOGGLE_RECT } from './helpers/geometry.js';

/** Live sim tick, or -1 before the DEV hook is installed. */
async function simTick(page: import('@playwright/test').Page): Promise<number> {
  return await page.evaluate(() => {
    const w = window as unknown as { __phase9_test?: { getTick?: () => number } };
    return w.__phase9_test?.getTick?.() ?? -1;
  });
}

/** Wait until the sim has advanced `n` ticks, i.e. the command queue has
 *  definitely drained. Deterministic where a fixed sleep is not: the value this
 *  file asserts after a resume EQUALS the pre-drain value, so a sleep that is
 *  too short on a loaded machine turns the assertion into a tautology instead of
 *  failing. */
async function advanceTicks(page: import('@playwright/test').Page, n = 3): Promise<void> {
  const from = await simTick(page);
  await expect.poll(() => simTick(page), { timeout: 10_000 }).toBeGreaterThan(from + n);
}

/** The live alarm flag, or '<undefined>' before the hook has published it. */
async function alarmActive(page: import('@playwright/test').Page): Promise<boolean | string> {
  return await page.evaluate(() => {
    const ui = (window as { __phase9_ui?: { alarmActive?: boolean } }).__phase9_ui;
    return ui?.alarmActive ?? '<undefined>';
  });
}

test.describe('C1 — colony alarm', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* private-mode / blocked storage — the boot path handles it */
      }
    });
  });

  test('the HUD button toggles the alarm, and toggles it back', async ({ page }) => {
    await page.goto('/');
    await waitForUiHook(page);
    await settleToPlaying(page);
    await expect.poll(() => alarmActive(page)).toBe(false);

    await clickCanvasRect(page, ALARM_TOGGLE_RECT);
    await expect.poll(() => alarmActive(page)).toBe(true);

    await clickCanvasRect(page, ALARM_TOGGLE_RECT);
    await expect.poll(() => alarmActive(page)).toBe(false);
  });

  test('stays a true toggle while paused: two clicks net out, and the sim applies them on resume', async ({
    page,
  }) => {
    // Regression pin for the projected-world read. While paused the game loop is
    // a no-op so the queue never drains and the LIVE flag is frozen; a button
    // that read the live colony would enqueue the same `active` twice and leave
    // the alarm ON. The hook reports LIVE sim state, so it only moves once the
    // sim actually runs — which is the point of asserting after resume.
    await page.goto('/');
    await waitForUiHook(page);
    await settleToPlaying(page);
    await expect.poll(() => alarmActive(page)).toBe(false);

    await page.keyboard.press(' '); // pause
    await clickCanvasRect(page, ALARM_TOGGLE_RECT);
    await page.waitForTimeout(400);
    // The hook reports LIVE sim state, so a click that is only QUEUED must not
    // move it: the sim has not run. If this ever reads true while paused, the
    // hook is publishing the projection and every assertion in this file
    // degrades to "the command reached the queue" instead of "tick applied it".
    expect(await alarmActive(page)).toBe(false);
    // Space the clicks: two at the same point with no gap are coalesced (the
    // second arrives as a dblclick and never reaches the button handler), which
    // would make this test pass even with the projected read reverted.
    await page.waitForTimeout(400);
    await clickCanvasRect(page, ALARM_TOGGLE_RECT);
    await page.waitForTimeout(400);
    await page.keyboard.press(' '); // resume — the two queued commands drain

    // Net effect of on-then-off is off. A stale live read would land on ON here.
    //
    // A settled read, NOT expect.poll: poll succeeds on its first matching
    // sample, and the first sample after resume lands before the queue drains —
    // it would see the still-false pre-drain value and pass even when the two
    // commands are about to set the alarm ON. Wait for the drain, then assert.
    await advanceTicks(page);
    expect(await alarmActive(page)).toBe(false);

    // And one click from the resumed state still works.
    await clickCanvasRect(page, ALARM_TOGGLE_RECT);
    await expect.poll(() => alarmActive(page)).toBe(true);
  });

  test('the R keybind is a true toggle while paused too, not just the button', async ({ page }) => {
    // The hotkey had the same stale-read bug the button did, one round later:
    // a bare user pause leaves the hotkey accepted, the loop is a no-op, and a
    // live read makes both presses enqueue `active: true`.
    await page.goto('/');
    await waitForUiHook(page);
    await settleToPlaying(page);
    await expect.poll(() => alarmActive(page)).toBe(false);

    await page.keyboard.press(' '); // pause
    await page.keyboard.press('r');
    await page.waitForTimeout(200);
    await page.keyboard.press('r');
    await page.keyboard.press(' '); // resume — both queued commands drain
    await advanceTicks(page);
    expect(await alarmActive(page)).toBe(false);
  });

  test('the R keybind toggles it too', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err: Error) => consoleErrors.push(err.message));

    await page.goto('/');
    await waitForUiHook(page);
    await settleToPlaying(page);
    await expect.poll(() => alarmActive(page)).toBe(false);

    await page.keyboard.press('r');
    await expect.poll(() => alarmActive(page)).toBe(true);

    // A second press toggles back. (The #311 same-frame / auto-repeat guards are
    // pinned in phase-09-session.spec.ts's re-walk suite with synthetic events —
    // Playwright's keyboard.down/up never synthesizes `repeat: true`, so asserting
    // it here would be vacuous.)
    await page.keyboard.press('r');
    await expect.poll(() => alarmActive(page)).toBe(false);

    expect(consoleErrors, `console errors: ${consoleErrors.join('; ')}`).toHaveLength(0);
  });
});
