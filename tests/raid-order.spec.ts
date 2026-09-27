// raid-order.spec.ts — #352: choosing a raid order from the raid menu, in a real
// browser.
//
// The raid types themselves are pinned in the sim tests (raid-orders.test.ts) and
// the menu's pieces in unit tests (raid-order-view.test.ts, gesture-arbiter.test.ts).
// What only a browser proves is the whole loop the player drives: a real
// right-click on the enemy's entrance opens the raid menu (arbiter → surface input
// → context-menu state → UIScene draws it), a real left-click on a row sends the
// SetRallyPoint with that order through the input layer, the sim stores it on the
// colony, and the caption names it. Choosing again on the same entrance changes it.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { contextMenuRowRect } from './helpers/geometry.js';

interface TestHook {
  getCaptionsShown?: () => string[];
  getPlayerRaidOrder?: () => {
    raidType: number;
    rally: { tileX: number; tileY: number } | null;
  } | null;
  surfaceTileScreenPoint?: (x: number, y: number) => { x: number; y: number } | null;
  getEnemyEntrances?: () => Array<{ tileX: number; tileY: number; isOpen: boolean }>;
  getContextMenu?: () => { visible: boolean; kind: string; screenX: number; screenY: number };
}

/** RaidType values (src/sim/enums.ts): also the raid menu's row order. */
const RAID = { Loot: 0, Deny: 1, Spoil: 2, Blockade: 3, Assault: 4 } as const;

type Order = { raidType: number; rally: { tileX: number; tileY: number } | null } | null;
type Menu = { visible: boolean; kind: string; screenX: number; screenY: number } | null;

async function raidOrder(page: Page): Promise<Order> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getPlayerRaidOrder?.() ??
      null,
  );
}

async function contextMenu(page: Page): Promise<Menu> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getContextMenu?.() ?? null,
  );
}

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionsShown?.() ?? [],
  );
}

async function enemyEntrances(page: Page): Promise<Array<{ tileX: number; tileY: number }>> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getEnemyEntrances?.() ??
      [],
  );
}

async function canvasBox(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return box;
}

/** Right-click the enemy's first entrance; resolves once the raid menu is up. */
async function openRaidMenu(
  page: Page,
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
  await page.mouse.click(box.x + pt!.x, box.y + pt!.y, { button: 'right' });
  await expect
    .poll(async () => {
      const m = await contextMenu(page);
      return m !== null && m.visible && m.kind === 'raid';
    })
    .toBe(true);
  const menu = (await contextMenu(page))!;
  return { screenX: menu.screenX, screenY: menu.screenY };
}

/** Left-click row `row` of the open raid menu (its geometry: tests/helpers/geometry.ts). */
async function pickRow(
  page: Page,
  menu: { screenX: number; screenY: number },
  row: number,
): Promise<void> {
  await clickCanvasRect(page, contextMenuRowRect(menu.screenX, menu.screenY, row));
}

test.describe('#352 — raid orders', () => {
  test('right-click an enemy entrance, pick Deny: the rally carries it and the caption names it', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForUiHook(page);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await settleToPlaying(page);

    const doors = await enemyEntrances(page);
    expect(doors.length).toBeGreaterThan(0);
    const door = doors[0]!;
    expect(await raidOrder(page)).toEqual({
      raidType: RAID.Loot,
      rally: null,
    });

    // Deny.
    let menu = await openRaidMenu(page, door);
    await pickRow(page, menu, RAID.Deny);
    await expect
      .poll(() => raidOrder(page), { timeout: 10_000 })
      .toEqual({ raidType: RAID.Deny, rally: { tileX: door.tileX, tileY: door.tileY } });
    await expect
      .poll(() => captions(page), { timeout: 10_000 })
      .toContainEqual(expect.stringMatching(/^Raiding: Deny\. Fighters steal food/));
    // The menu closed with the pick.
    await expect.poll(async () => (await contextMenu(page))?.visible ?? true).toBe(false);

    // Choosing again on the same entrance changes the order.
    menu = await openRaidMenu(page, door);
    await pickRow(page, menu, RAID.Blockade);
    await expect
      .poll(async () => (await raidOrder(page))?.raidType ?? -1, { timeout: 10_000 })
      .toBe(RAID.Blockade);
    await expect
      .poll(() => captions(page), { timeout: 10_000 })
      .toContainEqual(expect.stringMatching(/^Raiding: Blockade\. /));

    // A right-click on the open menu picks nothing (the row under it is Loot).
    menu = await openRaidMenu(page, door);
    const row0 = contextMenuRowRect(menu.screenX, menu.screenY, RAID.Loot);
    const box = await canvasBox(page);
    await page.mouse.click(box.x + row0.x + (row0.w >> 1), box.y + row0.y + (row0.h >> 1), {
      button: 'right',
    });
    // The menu is still up (reopened, or left open); pick Assault. Had the
    // right-click picked Loot, that order would have gone first, and its caption
    // would be among those shown.
    await expect
      .poll(async () => {
        const m = await contextMenu(page);
        return m !== null && m.visible && m.kind === 'raid';
      })
      .toBe(true);
    menu = (await contextMenu(page))!;
    await pickRow(page, menu, RAID.Assault);
    await expect
      .poll(async () => (await raidOrder(page))?.raidType ?? -1, { timeout: 10_000 })
      .toBe(RAID.Assault);
    expect(await captions(page)).not.toContainEqual(expect.stringMatching(/^Raiding: Loot\. /));
  });
});
