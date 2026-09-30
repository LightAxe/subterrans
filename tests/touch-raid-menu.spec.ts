// touch-raid-menu.spec.ts — #378: the raid menu on touch (chromium-touch project).
//
// A touch screen has no hover. The raid menu opens by long-pressing an enemy
// entrance, anchored where the finger is, so when the finger lifts the pointer
// rests on the menu's first row (Loot). Read as a hover, that would light Loot and
// describe it on every long-press. On touch no row is lit; the description line
// explains the order already in force on the entrance (the outlined row), if any.
// The rule is unit-tested (raid-order-view.test.ts, raidMenuHoveredOrder); this
// proves UIScene tells a real touch pointer from a mouse in the browser.
//
// Runs ONLY in the `chromium-touch` project (hasTouch:true) — see
// playwright.config.ts. State is read through the Dev-only __phase9_test hooks.

import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { contextMenuRowRect } from './helpers/geometry.js';

interface TestHook {
  getPlayerRaidOrder?: () => {
    raidType: number;
    rally: { tileX: number; tileY: number } | null;
  } | null;
  surfaceTileScreenPoint?: (x: number, y: number) => { x: number; y: number } | null;
  getEnemyEntrances?: () => Array<{ tileX: number; tileY: number; isOpen: boolean }>;
  getContextMenu?: () => { visible: boolean; kind: string; screenX: number; screenY: number };
  getRaidMenu?: () => { hovered: number | null; description: string | null } | null;
}

/** RaidType values (src/sim/enums.ts): also the raid menu's row order. */
const RAID = { Loot: 0, Deny: 1 } as const;

async function contextMenu(
  page: Page,
): Promise<{ visible: boolean; kind: string; screenX: number; screenY: number } | null> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getContextMenu?.() ?? null,
  );
}

async function raidMenu(
  page: Page,
): Promise<{ hovered: number | null; description: string | null } | null> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getRaidMenu?.() ?? null,
  );
}

async function canvasBox(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return box;
}

/** Hold a finger on the enemy entrance until the raid menu opens, then lift it. */
async function longPressDoor(
  page: Page,
  client: CDPSession,
  door: { tileX: number; tileY: number },
): Promise<{ screenX: number; screenY: number }> {
  const pt = await page.evaluate(
    ({ x, y }) =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.surfaceTileScreenPoint?.(
        x,
        y,
      ) ?? null,
    { x: door.tileX, y: door.tileY },
  );
  expect(pt).not.toBeNull();
  const box = await canvasBox(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + pt!.x, y: box.y + pt!.y }],
  });
  await expect
    .poll(async () => {
      const m = await contextMenu(page);
      return m !== null && m.visible && m.kind === 'raid';
    })
    .toBe(true);
  // The finger drifts a couple of px before it lifts, as a real one does (well
  // under the drag threshold). The pointer has now moved since the menu opened, so
  // only the touch check keeps its resting place on the Loot row from reading as
  // a hover.
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: box.x + pt!.x + 2, y: box.y + pt!.y + 2 }],
  });
  // CDP ends every touch at once with an empty touchPoints list.
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const m = (await contextMenu(page))!;
  return { screenX: m.screenX, screenY: m.screenY };
}

test('#378 — on touch the raid menu lights no row and explains the order in force', async ({
  page,
}) => {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settleToPlaying(page, 'Normal', { via: 'touch' });

  const doors = await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getEnemyEntrances?.() ??
      [],
  );
  expect(doors.length).toBeGreaterThan(0);
  const door = doors[0]!;
  const client = await page.context().newCDPSession(page);

  // The finger lifted on the menu's first row (Loot) — no hover, and no order yet.
  let menu = await longPressDoor(page, client, door);
  await expect.poll(() => raidMenu(page)).toEqual({ hovered: null, description: null });

  // Tap Deny.
  const box = await canvasBox(page);
  const deny = contextMenuRowRect(menu.screenX, menu.screenY, RAID.Deny);
  await page.touchscreen.tap(box.x + deny.x + deny.w / 2, box.y + deny.y + deny.h / 2);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            (
              window as unknown as { __phase9_test?: TestHook }
            ).__phase9_test?.getPlayerRaidOrder?.()?.raidType ?? -1,
        ),
      { timeout: 10_000 },
    )
    .toBe(RAID.Deny);
  await expect.poll(async () => (await contextMenu(page))?.visible ?? true).toBe(false);

  // Long-press again: still no row lit, and the line explains Deny, the order in
  // force — not Loot, the row under the lifted finger.
  menu = await longPressDoor(page, client, door);
  await expect
    .poll(() => raidMenu(page))
    .toEqual({
      hovered: null,
      description: 'Deny: Fighters steal food; what won’t fit is left by your entrance.',
    });
  await page.screenshot({
    path: 'test-results/touch-raid-menu.png',
    clip: { x: box.x + menu.screenX - 40, y: box.y + menu.screenY - 40, width: 560, height: 200 },
  });
});
