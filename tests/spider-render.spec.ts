import { test, expect, type ConsoleMessage } from '@playwright/test';

test('spider boot smoke — no JS errors, canvas live after 6s of sim', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err: Error) => consoleErrors.push(err.message));

  await page.goto('/');
  const canvas = page.locator('canvas').first();
  await canvas.waitFor({ state: 'attached', timeout: 10_000 });

  // Let the round run: ants settle, spider initializes, first patrol ticks
  await page.waitForTimeout(6000);

  await page.screenshot({ path: 'test-results/spider-render-6s.png', fullPage: false });

  // No JS errors at any point during boot + 6s of sim
  expect(consoleErrors, `console errors: ${consoleErrors.join('; ')}`).toHaveLength(0);

  // Canvas still live
  await expect(canvas).toBeAttached();
});
