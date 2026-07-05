import { test, expect, type ConsoleMessage } from '@playwright/test';
import { VIEW_TOGGLE_RECT } from './helpers/geometry.js';

const errorFilter = (msg: ConsoleMessage) => msg.type() === 'error';

test.describe('Phase 8 smoke — boot, toggle, pan', () => {
  test('boot shows 800×592 canvas at :5173', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (errorFilter(msg)) consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 10_000 });

    // Fixed canvas size per HUD/VIEW spec (Phaser.Scale.NONE)
    await expect(canvas).toHaveAttribute('width', '800');
    await expect(canvas).toHaveAttribute('height', '592');

    // No pageerror or console error during boot
    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('Tab toggles view without error', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (errorFilter(msg)) consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');
    await page.locator('canvas').first().waitFor({ state: 'attached' });

    // Give Phaser a few frames to settle before keyboard events.
    await page.waitForTimeout(200);

    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);

    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('ArrowRight produces camera pan without error', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (errorFilter(msg)) consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(200);

    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(150);

    // Canvas still mounted (no crash)
    await expect(page.locator('canvas').first()).toBeAttached();

    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('screenshot artifact produced for human review', async ({ page }) => {
    await page.goto('/');
    await page.locator('canvas').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'test-results/phase-08-smoke.png',
      fullPage: false,
    });
  });

  // Phase 8.5 regression guards — the render/camera double-transform used to
  // push the world offscreen, and the primary pan gesture did not work on
  // laptops without a middle mouse button.

  test('underground screenshot captured for human review (Phase 8.5)', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached' });
    await page.waitForTimeout(300);

    // Click the VIEW_TOGGLE HUD button (more reliable than Tab keyboard — no
    // focus dependency). Rect from geometry.ts (#240) — no inline pixels.
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    const r = VIEW_TOGGLE_RECT;
    await page.mouse.click(box.x + r.x + r.w / 2, box.y + r.y + r.h / 2);
    await page.waitForTimeout(300);

    await page.screenshot({
      path: 'test-results/phase-08-smoke-underground.png',
      fullPage: false,
    });
  });

  test('left-drag pans the surface camera (Command tool); Space toggles pause — controls rework', async ({
    page,
  }) => {
    // Stage 1 controls rework (issue #18): Space no longer modifies pan — it is
    // the pause toggle. On the surface the default Command tool left-drags = pan
    // (the single gesture arbiter classifies it). This smoke test exercises both
    // a plain left-drag pan and a Space pause/resume cycle, asserting no errors.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (errorFilter(msg)) consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached' });
    await page.waitForTimeout(200);

    // Plain left-button drag over a non-HUD mid-canvas region → pan (no Space).
    // Mid-canvas (500, 300) sits clear of HUD.STATS (top-left), HUD.TRIANGLE
    // (bottom-left), HUD.MINIMAP (bottom-right), HUD.VIEW_TOGGLE (above minimap).
    await canvas.focus();
    await page.mouse.move(500, 300);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 10 });
    await page.mouse.up();

    // Space toggles the user pause, then again to resume.
    await page.keyboard.press('Space');
    await page.waitForTimeout(50);
    await page.keyboard.press('Space');

    await page.waitForTimeout(150);
    await expect(page.locator('canvas').first()).toBeAttached();
    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });
});
