// touch-smoke.spec.ts — #237 PR2 end-to-end touch smoke (chromium-touch project).
//
// Proves the touch plumbing works through the real stack: main.ts's
// input.activePointers:3 surfaces a 2nd finger, Phaser forwards both pointers to
// the GestureArbiter, and a two-finger spread drives beginPinch/applyPinch on the
// active camera. The pinch MATH is unit-tested in camera-adapter.test.ts and the
// arbiter WIRING in gesture-arbiter.test.ts; this only guards the browser-level
// touch → Phaser → arbiter path that unit tests can't reach.
//
// Runs ONLY in the `chromium-touch` project (hasTouch:true) — see
// playwright.config.ts. Reads zoom via the dev-only window.__phase9_test
// observability hook (getActiveZoom); it mutates nothing and crosses no
// sim/render boundary.

import { test, expect, type Page } from '@playwright/test';
import { DIFFICULTY_NORMAL_RECT, centerOf } from './helpers/geometry.js';

/** The active camera's live zoom, via the dev-build observability hook. */
async function getZoom(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: { getActiveZoom?: () => number } })
      .__phase9_test;
    if (!t?.getActiveZoom) throw new Error('__phase9_test.getActiveZoom not installed');
    return t.getActiveZoom();
  });
}

async function activeOverlay(page: Page): Promise<string> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_ui?: { activeOverlay?: string } }).__phase9_ui
        ?.activeOverlay ?? '<undefined>',
  );
}

/** Boot to a clean Playing state (mirrors menu-and-dialog.spec.ts's bootGame). */
async function bootToPlaying(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => typeof (window as { __phase9_ui?: unknown }).__phase9_ui !== 'undefined',
  );
  await page.evaluate(() => localStorage.removeItem('subterrans:save:v3'));
  await page.reload();
  await page.locator('canvas').first().waitFor({ state: 'attached' });
  // Poll-click "Normal" until the Choose-Difficulty overlay clears to Playing.
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const norm = centerOf(DIFFICULTY_NORMAL_RECT);
  await expect
    .poll(
      async () => {
        if ((await activeOverlay(page)) === 'none') return 'none';
        await page.mouse.click(box.x + norm.x, box.y + norm.y);
        return activeOverlay(page);
      },
      { timeout: 15_000 },
    )
    .toBe('none');
}

test('two-finger spread pinch-zooms the camera in', async ({ page }) => {
  await bootToPlaying(page);
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  // Midpoint at the canvas center (world region — the HUD lives at the edges).
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const z0 = await getZoom(page);
  expect(z0).toBeCloseTo(1, 5); // fresh game boots at DEFAULT_ZOOM

  const client = await page.context().newCDPSession(page);
  // Two fingers start 60px apart on a horizontal line through the midpoint...
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: cx - 30, y: cy },
      { x: cx + 30, y: cy },
    ],
  });
  // ...then spread apart in steps (dist 60 → ~460, a >3× ratio → clamps toward MAX_ZOOM).
  for (let s = 1; s <= 5; s++) {
    const half = 30 + s * 40; // 70, 110, 150, 190, 230
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: cx - half, y: cy },
        { x: cx + half, y: cy },
      ],
    });
  }

  // Phaser processes the queued touches on its rAF loop, then the arbiter drives
  // applyPinch — poll until the zoom reflects the spread.
  await expect.poll(async () => getZoom(page), { timeout: 5_000 }).toBeGreaterThan(z0 + 0.1);

  // Release the gesture. CDP requires touchEnd/touchCancel to carry NO points —
  // it ends ALL active touches at once (a partial one-finger release is not
  // expressible via Input.dispatchTouchEvent, and the survivor→single path is
  // covered in gesture-arbiter.test.ts). A non-empty touchEnd is a protocol
  // violation Chrome may reject.
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
});

test('a single-finger tap does not pinch-zoom (single-pointer path intact)', async ({ page }) => {
  await bootToPlaying(page);
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const z0 = await getZoom(page);
  await page.touchscreen.tap(cx, cy);
  // Give Phaser a few frames to process the tap, then assert it neither zoomed
  // nor left the Playing state (a lone finger must never enter pinch).
  await expect.poll(async () => activeOverlay(page), { timeout: 5_000 }).toBe('none');
  expect(await getZoom(page)).toBeCloseTo(z0, 5);
});
