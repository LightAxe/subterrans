// spider-order-chip.spec.ts — #400: the HUD shows a spider order for as long as it is
// in force, and a click on that chip calls it off, in a real browser.
//
// From V71 a spider order lasts until the player clears it or the spider dies, so it
// needs a cue that does not depend on the spider being on screen. The chip's logic
// is unit-tested (spider-order-chip.test.ts); what only a browser can prove is that
// UIScene draws it, routes a click on it to the sim, and stops masking its band when
// it is gone. Asserted through window.__phase9_ui: `spiderOrderChip` (the chip is
// drawn) and `spiderPriorityActive` (the LIVE sim flag), so a green run means the
// clear round-tripped through the queue into sim state.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SPIDER_ORDER_RECT } from './helpers/geometry.js';

type SpiderUi = { spiderOrderChip?: boolean; spiderPriorityActive?: boolean };

async function ui(page: Page, field: keyof SpiderUi): Promise<boolean | string> {
  return await page.evaluate(
    (f) => (window as unknown as { __phase9_ui?: SpiderUi }).__phase9_ui?.[f] ?? '<undefined>',
    field,
  );
}

/** A Command tap on the spider through the real tap handler (DEV hook). */
async function tapSpider(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: { tapSpiderAsPlayer?: () => boolean } })
      .__phase9_test;
    if (t?.tapSpiderAsPlayer === undefined) throw new Error('tapSpiderAsPlayer is not installed');
    return t.tapSpiderAsPlayer();
  });
}

async function simTick(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = window as unknown as { __phase9_test?: { getTick?: () => number } };
    return w.__phase9_test?.getTick?.() ?? -1;
  });
}

/** Wait until the sim has advanced more than `n` ticks (the queue has drained). */
async function advanceTicks(page: Page, n = 3): Promise<void> {
  const from = await simTick(page);
  await expect.poll(() => simTick(page), { timeout: 15_000 }).toBeGreaterThan(from + n);
}

async function chipGeometry(page: Page) {
  return await page.evaluate(() => {
    const t = (
      window as unknown as {
        __phase9_test?: {
          getHudButtonGeometry?: () => Array<{ id: string; text: string; visible: boolean }>;
        };
      }
    ).__phase9_test;
    return t?.getHudButtonGeometry?.().find((g) => g.id === 'spider-order') ?? null;
  });
}

test.describe('#400 — spider-order chip', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* private-mode / blocked storage — the boot path handles it */
      }
    });
    await page.goto('/');
    await waitForUiHook(page);
    await settleToPlaying(page);
    // No order at the start of a round: no chip.
    await expect.poll(() => ui(page, 'spiderPriorityActive')).toBe(false);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
  });

  test('shows while the order is in force, stays up, and a click calls the order off', async ({
    page,
  }) => {
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderPriorityActive')).toBe(true);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(true);
    expect(await chipGeometry(page)).toMatchObject({ text: 'Call off spider', visible: true });

    // It stays up as the match runs. (That a meal no longer ends the order is pinned
    // in the unit tests; this checks the HUD keeps drawing it.)
    await advanceTicks(page, 60);
    expect(await ui(page, 'spiderPriorityActive')).toBe(true);
    expect(await ui(page, 'spiderOrderChip')).toBe(true);

    await clickCanvasRect(page, SPIDER_ORDER_RECT);
    await expect.poll(() => ui(page, 'spiderPriorityActive')).toBe(false);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
    expect(await chipGeometry(page)).toMatchObject({ visible: false });
  });

  test('while paused a click hides the chip at once, and the sim applies the clear on resume', async ({
    page,
  }) => {
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderPriorityActive')).toBe(true);

    await page.keyboard.press(' '); // pause
    await clickCanvasRect(page, SPIDER_ORDER_RECT);
    // The chip reads the queued clear, so it goes at once…
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
    // …while the LIVE order stays on: the sim has not run. (If this reads false
    // while paused, the hook is publishing the projection, and the assertions
    // below would only prove the command reached the queue.)
    await page.waitForTimeout(400);
    expect(await ui(page, 'spiderPriorityActive')).toBe(true);

    await page.keyboard.press(' '); // resume — the queued clear drains
    await advanceTicks(page);
    expect(await ui(page, 'spiderPriorityActive')).toBe(false);
    expect(await ui(page, 'spiderOrderChip')).toBe(false);
  });

  test('its tooltip goes with it: never shown, nor left up, over an empty band', async ({
    page,
  }) => {
    const tooltip = async (): Promise<string | null> =>
      await page.evaluate(
        () =>
          (
            window as unknown as { __phase9_test?: { getTooltipShown?: () => string | null } }
          ).__phase9_test?.getTooltipShown?.() ?? null,
      );
    const box = await page.locator('canvas').first().boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    const cx = box.x + SPIDER_ORDER_RECT.x + SPIDER_ORDER_RECT.w / 2;
    const cy = box.y + SPIDER_ORDER_RECT.y + SPIDER_ORDER_RECT.h / 2;

    // 1. Hover until the tooltip shows, then click without moving: the chip goes,
    //    and so must its tooltip (the tooltip only re-checks on pointermove).
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(true);
    await page.mouse.move(cx, cy);
    await expect.poll(tooltip).toContain('until it dies');
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
    await expect.poll(tooltip).toBeNull();

    // 2. Click before the tooltip's show delay ends: it must not appear afterwards
    //    over the band the chip left.
    await page.mouse.move(cx - 300, cy);
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(true);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
    await page.waitForTimeout(900); // past the 400 ms show delay
    expect(await tooltip()).toBeNull();

    // 3. The pointer has left the chip and its tooltip is in the 1.5 s mouse-out
    //    grace when the order ends (here by a Command tap on the spider): the
    //    tooltip goes with the chip, not at the end of the grace.
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(true);
    await page.mouse.move(cx, cy);
    await expect.poll(tooltip).toContain('until it dies');
    await page.mouse.move(cx - 300, cy); // off the chip: the grace starts
    expect(await tooltip()).toContain('until it dies');
    expect(await tapSpider(page)).toBe(true); // the order ends
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
    await expect.poll(tooltip, { timeout: 1000 }).toBeNull();
  });

  test('the chip is framed like the spider mark: proto-blue while queued, white once applied', async ({
    page,
  }) => {
    // One pixel of the chip's top border (2 px tall; the label's glyphs start 5 px
    // down), as rendered.
    const borderPixel = async (): Promise<number[]> =>
      await page.evaluate(
        async ([x, y]) => {
          const t = (
            window as unknown as {
              __phase9_test?: {
                sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
              };
            }
          ).__phase9_test;
          if (t?.sampleArea === undefined) throw new Error('sampleArea is not installed');
          return (await t.sampleArea(x, y, 1, 1)).slice(0, 3);
        },
        [SPIDER_ORDER_RECT.x + SPIDER_ORDER_RECT.w / 2, SPIDER_ORDER_RECT.y] as const,
      );
    const near = (got: number[], want: number[]): boolean =>
      got.length === 3 && got.every((v, i) => Math.abs(v - want[i]!) <= 8);
    const QUEUED = [0x3a, 0x7b, 0xd5];
    const WHITE = [0xff, 0xff, 0xff];

    await page.keyboard.press(' '); // pause: a tap only queues the order
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(true);
    expect(await ui(page, 'spiderPriorityActive')).toBe(false);
    await expect.poll(async () => near(await borderPixel(), QUEUED)).toBe(true);

    await page.keyboard.press(' '); // resume: the order is applied
    await expect.poll(() => ui(page, 'spiderPriorityActive')).toBe(true);
    await expect.poll(async () => near(await borderPixel(), WHITE)).toBe(true);
  });

  test('a Command tap on the spider still toggles the order off too', async ({ page }) => {
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(true);
    expect(await tapSpider(page)).toBe(true);
    await expect.poll(() => ui(page, 'spiderPriorityActive')).toBe(false);
    await expect.poll(() => ui(page, 'spiderOrderChip')).toBe(false);
  });
});
