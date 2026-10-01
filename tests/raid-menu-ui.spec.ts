// raid-menu-ui.spec.ts — #378: the raid menu's hover highlight and description,
// and the order caption on a quick switch, in a real browser. #399: the
// description stays on screen and clear of the HUD wherever the menu opens.
//
// The pieces are pinned in unit tests (raid-order-view.test.ts: the hovered row,
// its lit colour, the description and where it goes; caption-queue.test.ts: a
// newer order caption replacing an older one). What only a browser proves is the
// wiring: UIScene reads the real mouse pointer each frame, lights the row it is
// over and paints the description line; and GameScene sends each order caption
// as a newer version of the last, so the caption queue swaps it in instead of
// queueing it behind the old order's words.
//
// No wall-clock assertions: state is read through the Dev-only __phase9_test
// hooks (getRaidMenu, getCaptionQueue, getCaptionsReplaced), pixels through
// sampleArea, and the caption clock is frozen (freezeCaptionClock) while the
// quick switch is given, so the old caption is still up however slow the machine.
//
// Screenshots (for a human eye; not compared): test-results/raid-menu-*.png.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import {
  ALARM_TOGGLE_RECT,
  VIEW_TOGGLE_RECT,
  contextMenuRowRect,
  type Rect,
} from './helpers/geometry.js';
import { TILE_SIZE_PX } from '../src/render/sprites.js';
import { buildHudLayout, minimapFrameRect } from '../src/render/hud-layout.js';
import { DEFAULT_LAYOUT } from '../src/render/layout.js';
import { RAID_ORDER_OPTIONS, raidOrderCaption } from '../src/render/raid-order-view.js';

interface TestHook {
  getCaptionsShown?: () => string[];
  getCaptionsReplaced?: () => string[];
  getCaptionQueue?: () => {
    active: string | null;
    pending: string | null;
    onScreen: string[];
    textsCreated: number;
  };
  freezeCaptionClock?: (frozen: boolean) => void;
  getPlayerRaidOrder?: () => {
    raidType: number;
    rally: { tileX: number; tileY: number } | null;
  } | null;
  surfaceTileScreenPoint?: (x: number, y: number) => { x: number; y: number } | null;
  getEnemyEntrances?: () => Array<{ tileX: number; tileY: number; isOpen: boolean }>;
  getContextMenu?: () => { visible: boolean; kind: string; screenX: number; screenY: number };
  getRaidMenu?: () => { hovered: number | null; description: string | null } | null;
  getRaidMenuDescriptionRect?: () => { x: number; y: number; w: number; h: number } | null;
  getCameraState?: () => {
    surface: { centerX: number; centerY: number; zoom: number; viewW: number };
  };
  sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
  isPaused?: () => boolean;
}

/** RaidType values (src/sim/enums.ts): also the raid menu's row order. */
const RAID = { Loot: 0, Deny: 1, Spoil: 2, Blockade: 3, Assault: 4 } as const;

async function raidOrder(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getPlayerRaidOrder?.()
        ?.raidType ?? -1,
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

/** The caption queue per its policy (active / pending) and the caption Texts
 *  actually alive on screen. */
async function captionQueue(page: Page): Promise<{
  active: string | null;
  pending: string | null;
  onScreen: string[];
  textsCreated: number;
}> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionQueue?.() ?? {
        active: '<no hook>',
        pending: '<no hook>',
        onScreen: ['<no hook>'],
        textsCreated: -1,
      },
  );
}

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionsShown?.() ?? [],
  );
}

async function replacedCaptions(page: Page): Promise<string[]> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionsReplaced?.() ??
      [],
  );
}

async function freezeCaptionClock(page: Page, frozen: boolean): Promise<void> {
  await page.evaluate((f) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.freezeCaptionClock === undefined) throw new Error('no freezeCaptionClock hook');
    t.freezeCaptionClock(f);
  }, frozen);
}

async function enemyDoor(page: Page): Promise<{ tileX: number; tileY: number }> {
  const doors = await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getEnemyEntrances?.() ??
      [],
  );
  expect(doors.length).toBeGreaterThan(0);
  return doors[0]!;
}

async function canvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return box;
}

/** The raid menu description's box as last drawn (canvas px), or null. */
async function descriptionRect(page: Page): Promise<Rect | null> {
  return await page.evaluate(
    () =>
      (
        window as unknown as { __phase9_test?: TestHook }
      ).__phase9_test?.getRaidMenuDescriptionRect?.() ?? null,
  );
}

/** #399 — move the surface camera so the enemy entrance's tile centre lands near
 *  canvas point `at` (the camera centres on a whole tile, so within a tile of it),
 *  and return where it landed. */
async function putDoorAt(
  page: Page,
  door: { tileX: number; tileY: number },
  at: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const cam0 = await page.evaluate(() =>
    (window as unknown as { __phase9_test?: TestHook }).__phase9_test!.getCameraState!(),
  );
  const zoom = cam0.surface.zoom;
  const viewportW = cam0.surface.viewW * zoom;
  const viewportH = DEFAULT_LAYOUT.h;
  // Centre the camera on the tile `at` is that many tiles from the door.
  const dx = Math.round((at.x - viewportW / 2) / (TILE_SIZE_PX * zoom));
  const dy = Math.round((at.y - viewportH / 2) / (TILE_SIZE_PX * zoom));
  await page.evaluate(
    ({ x, y }) =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.surfaceTileScreenPoint?.(
        x,
        y,
      ) ?? null,
    { x: door.tileX - dx, y: door.tileY - dy },
  );
  const cam = (
    await page.evaluate(() =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test!.getCameraState!(),
    )
  ).surface;
  const wx = (door.tileX + 0.5) * TILE_SIZE_PX;
  const wy = (door.tileY + 0.5) * TILE_SIZE_PX;
  return {
    x: Math.round((wx - cam.centerX) * cam.zoom + viewportW / 2),
    y: Math.round((wy - cam.centerY) * cam.zoom + viewportH / 2),
  };
}

/** Right-click the enemy entrance; resolves once the raid menu is up (its top-left). */
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
      const m = await page.evaluate(
        () =>
          (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getContextMenu?.() ??
          null,
      );
      return m !== null && m.visible && m.kind === 'raid';
    })
    .toBe(true);
  const menu = await page.evaluate(() =>
    (window as unknown as { __phase9_test?: TestHook }).__phase9_test!.getContextMenu!(),
  );
  return { screenX: menu.screenX, screenY: menu.screenY };
}

/** Move the mouse (no click) to a canvas-local point. */
async function pointAt(page: Page, x: number, y: number): Promise<void> {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + x, box.y + y);
}

/** Move the mouse to the middle of row `row` of the menu at `menu`. */
async function hoverRow(
  page: Page,
  menu: { screenX: number; screenY: number },
  row: number,
): Promise<void> {
  const r = contextMenuRowRect(menu.screenX, menu.screenY, row);
  await pointAt(page, r.x + r.w / 2, r.y + r.h / 2);
}

/** A patch of row `row`'s stripe right of its label (no text in it). */
function stripePatch(menu: { screenX: number; screenY: number }, row: number): Rect {
  const r = contextMenuRowRect(menu.screenX, menu.screenY, row);
  return { x: r.x + (r.w >> 1) + 10, y: r.y + (r.h >> 1) - 4, w: 40, h: 8 };
}

/** Mean luminance (0–255) of the canvas pixels in `rect`. */
async function meanLuma(page: Page, rect: Rect): Promise<number> {
  const px = await page.evaluate(async ({ x, y, w, h }) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.sampleArea === undefined) throw new Error('no sampleArea hook');
    return await t.sampleArea(x, y, w, h);
  }, rect);
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
  }
  return sum / (px.length / 4);
}

async function setPaused(page: Page, on: boolean): Promise<void> {
  const paused = await page.evaluate(
    () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.isPaused?.() ?? false,
  );
  if (paused !== on) await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.isPaused?.() ?? null,
      ),
    )
    .toBe(on);
}

/** A fresh game. `shownHints`: the first-use hints to mark already shown, so
 *  they cannot come up (and take a caption slot) mid-test. */
async function freshGame(page: Page, shownHints: readonly string[] = []): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate((ids) => {
    localStorage.clear();
    if (ids.length === 0) return;
    const firstUseHints: Record<string, boolean> = {};
    for (const id of ids) firstUseHints[id] = true;
    localStorage.setItem(
      'subterrans:settings:v1',
      JSON.stringify({ version: 1, settings: { firstUseHints } }),
    );
  }, shownHints);
  await page.reload();
  await settleToPlaying(page);
}

/** The one-shot rally caption (src/render/onboarding-captions.ts, 'rally'). */
const RALLY_CAPTION = 'Fighters will converge here.';

/** Every first-use hint (src/render/first-use-hints.ts HintFirstUseId). */
const ALL_HINTS = ['pan', 'zoom', 'paint', 'view-tab'] as const;

const isBlockade = (t: string | null): boolean => t !== null && t.startsWith('Raiding: Blockade. ');
const isAssault = (t: string | null): boolean => t !== null && t.startsWith('Raiding: Assault. ');

/** Nothing on screen, nothing waiting. */
function queueIdle(q: {
  active: string | null;
  pending: string | null;
  onScreen: string[];
}): boolean {
  return q.active === null && q.pending === null && q.onScreen.length === 0;
}

/** Give the raid order `row` on the enemy entrance through the menu, and wait
 *  until the sim holds it (its caption was admitted in that same drain). */
async function giveOrder(
  page: Page,
  door: { tileX: number; tileY: number },
  row: number,
): Promise<void> {
  const menu = await openRaidMenu(page, door);
  await clickCanvasRect(page, contextMenuRowRect(menu.screenX, menu.screenY, row));
  await expect.poll(() => raidOrder(page), { timeout: 10_000 }).toBe(row);
}

test.describe('#378 — the raid menu', () => {
  test('the row under the mouse is lit and its order explained; off the menu, the order in force', async ({
    page,
  }) => {
    await freshGame(page);
    const door = await enemyDoor(page);
    // Paused, so nothing moves under the pixels sampled below (a pick still queues).
    await setPaused(page, true);

    const menu = await openRaidMenu(page, door);
    // The menu opens with its corner under the cursor, on the Loot row. A cursor
    // that has not moved has pointed at nothing: no row lit, nothing described
    // (no order is in force yet).
    await expect.poll(() => raidMenu(page)).toEqual({ hovered: null, description: null });
    // Hover Spoil once to learn where its description goes (#399: wrapped, and
    // placed clear of the HUD — not always flush under the menu). A patch inside
    // the box's 6-px left padding is all backing, no letters.
    await hoverRow(page, menu, RAID.Spoil);
    await expect.poll(async () => (await raidMenu(page))?.hovered ?? null).toBe(RAID.Spoil);
    const d = await descriptionRect(page);
    expect(d).not.toBeNull();
    const backing: Rect = {
      x: Math.ceil(d!.x) + 1,
      y: Math.ceil(d!.y) + 2,
      w: 4,
      h: Math.floor(d!.h) - 6,
    };

    // Off the menu, with no order in force yet: nothing lit, nothing described.
    await pointAt(page, menu.screenX - 60, menu.screenY + 40);
    await expect.poll(() => raidMenu(page)).toEqual({ hovered: null, description: null });
    const spoilUnlit = await meanLuma(page, stripePatch(menu, RAID.Spoil));
    const groundUnderBox = await meanLuma(page, backing);

    // Hover Spoil: its row is lit and the description says what it does, in the
    // order caption's words.
    await hoverRow(page, menu, RAID.Spoil);
    await expect
      .poll(() => raidMenu(page))
      .toEqual({
        hovered: RAID.Spoil,
        description: 'Spoil: Fighters destroy the enemy’s stored food.',
      });
    await expect
      .poll(() => meanLuma(page, stripePatch(menu, RAID.Spoil)))
      .toBeGreaterThan(spoilUnlit + 40);
    // The description's dark backing now covers the ground there.
    await expect.poll(() => meanLuma(page, backing)).toBeLessThan(groundUnderBox - 20);
    expect(await descriptionRect(page)).toEqual(d);
    const box = await canvasBox(page);
    await page.screenshot({
      path: 'test-results/raid-menu-hover-spoil.png',
      clip: { x: box.x + menu.screenX - 40, y: box.y + menu.screenY - 40, width: 560, height: 200 },
    });

    // Down to Deny: the light and the words move with the mouse.
    await hoverRow(page, menu, RAID.Deny);
    await expect.poll(async () => (await raidMenu(page))?.hovered ?? -1).toBe(RAID.Deny);
    expect((await raidMenu(page))?.description).toMatch(/^Deny: Fighters steal food; /);
    await expect
      .poll(async () =>
        Math.abs((await meanLuma(page, stripePatch(menu, RAID.Spoil))) - spoilUnlit),
      )
      .toBeLessThan(8);

    // Pick Deny (queued: paused). Reopened under a still cursor (on the Loot row),
    // the menu lights nothing and explains the order in force, Deny — as it does
    // for a touch player, who cannot hover — and again with the pointer off it.
    await clickCanvasRect(page, contextMenuRowRect(menu.screenX, menu.screenY, RAID.Deny));
    await expect.poll(async () => (await raidMenu(page)) === null, { timeout: 10_000 }).toBe(true); // closed with the pick
    const again = await openRaidMenu(page, door);
    await expect
      .poll(() => raidMenu(page))
      .toEqual({
        hovered: null,
        description: 'Deny: Fighters steal food; what won’t fit is left by your entrance.',
      });
    await pointAt(page, again.screenX - 60, again.screenY + 40);
    await expect
      .poll(() => raidMenu(page))
      .toEqual({
        hovered: null,
        description: 'Deny: Fighters steal food; what won’t fit is left by your entrance.',
      });
  });

  test('a quick switch of order replaces the old order’s caption instead of queueing behind it', async ({
    page,
  }) => {
    // No first-use hint can come up and take the screen before the orders do.
    await freshGame(page, ALL_HINTS);
    const door = await enemyDoor(page);
    // Start from an empty caption queue, then stop the caption clock: every caption
    // stays exactly where it is (on screen or waiting) until the clock restarts.
    await expect
      .poll(async () => queueIdle(await captionQueue(page)), { timeout: 15_000 })
      .toBe(true);
    await freezeCaptionClock(page, true);
    try {
      await giveOrder(page, door, RAID.Blockade);
      // It went straight on screen (the queue was empty).
      await expect.poll(async () => isBlockade((await captionQueue(page)).active)).toBe(true);
      const created = (await captionQueue(page)).textsCreated;
      // Nothing waits behind it (a sim event, e.g. the spider's first hunt, landing
      // in this window would; say so rather than fail obscurely below).
      expect((await captionQueue(page)).pending).toBeNull();

      // Switch to Assault while "Raiding: Blockade" is still up.
      await giveOrder(page, door, RAID.Assault);
      // The Assault caption was admitted in the same drain as the order. The old
      // order's caption was cut short: Assault is on screen now, not waiting behind
      // it, and on a new Text (nothing else waits, so it gets a full lifetime) —
      // the one caption Text in the scene; the old one's is gone, not left to fade
      // over it.
      const q = await captionQueue(page);
      expect(isAssault(q.active)).toBe(true);
      expect(q.pending).toBeNull();
      expect(q.onScreen).toHaveLength(1);
      expect(isAssault(q.onScreen[0]!)).toBe(true);
      expect(q.textsCreated).toBe(created + 1);
      expect(await replacedCaptions(page)).toContainEqual(
        expect.stringMatching(/^Raiding: Blockade\. /),
      );
    } finally {
      await freezeCaptionClock(page, false);
    }
    // Let it run out: the Blockade caption never comes back after Assault.
    await expect
      .poll(async () => queueIdle(await captionQueue(page)), { timeout: 15_000 })
      .toBe(true);
    const shown = (await captions(page)).filter((c) => c.startsWith('Raiding: '));
    expect(shown.map((c) => c.split('.')[0])).toEqual(['Raiding: Blockade', 'Raiding: Assault']);
  });

  test('a switch while an event caption waits keeps the old caption’s time, so the event is not held back', async ({
    page,
  }) => {
    await freshGame(page, ALL_HINTS);
    const door = await enemyDoor(page);
    await expect
      .poll(async () => queueIdle(await captionQueue(page)), { timeout: 15_000 })
      .toBe(true);
    await freezeCaptionClock(page, true);
    try {
      await giveOrder(page, door, RAID.Blockade);
      await expect.poll(async () => isBlockade((await captionQueue(page)).active)).toBe(true);
      const created = (await captionQueue(page)).textsCreated;

      // A plain rally a few tiles off the entrance: its one-shot event caption
      // queues behind "Raiding: Blockade" (and the raid order lapses).
      const rallied = await page.evaluate(
        ({ x, y }) =>
          (
            window as unknown as {
              __phase9_test?: { rallyPlayerAt?: (x: number, y: number) => boolean };
            }
          ).__phase9_test?.rallyPlayerAt?.(x, y) ?? false,
        { x: door.tileX - 4, y: door.tileY },
      );
      expect(rallied).toBe(true);
      await expect.poll(async () => (await captionQueue(page)).pending).toBe(RALLY_CAPTION);

      // Order Assault on the entrance. Its words take over the Blockade caption's
      // Text and the time it had left — no new Text, no fresh lifetime — so the
      // rally caption comes up exactly when it would have after Blockade.
      await giveOrder(page, door, RAID.Assault);
      const q = await captionQueue(page);
      expect(isAssault(q.active)).toBe(true);
      expect(q.pending).toBe(RALLY_CAPTION);
      expect(q.onScreen).toHaveLength(1);
      expect(isAssault(q.onScreen[0]!)).toBe(true);
      expect(q.textsCreated).toBe(created);
      expect(await replacedCaptions(page)).toContainEqual(
        expect.stringMatching(/^Raiding: Blockade\. /),
      );
    } finally {
      await freezeCaptionClock(page, false);
    }
    await expect
      .poll(async () => queueIdle(await captionQueue(page)), { timeout: 15_000 })
      .toBe(true);
    const shown = await captions(page);
    const order = [
      shown.findIndex(isBlockade),
      shown.findIndex(isAssault),
      shown.indexOf(RALLY_CAPTION),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // Blockade, Assault, the rally
  });

  test('a switch while only a first-use hint waits gives the order caption a full lifetime (events outrank hints)', async ({
    page,
  }) => {
    // Every first-use hint but the zoom one is marked shown: a wheel zoom brings it
    // up, to wait behind the order caption.
    await freshGame(
      page,
      ALL_HINTS.filter((h) => h !== 'zoom'),
    );
    const door = await enemyDoor(page);
    await expect
      .poll(async () => queueIdle(await captionQueue(page)), { timeout: 15_000 })
      .toBe(true);
    await freezeCaptionClock(page, true);
    let zoomHint = '';
    try {
      await giveOrder(page, door, RAID.Blockade);
      await expect.poll(async () => isBlockade((await captionQueue(page)).active)).toBe(true);
      const created = (await captionQueue(page)).textsCreated;

      // A wheel zoom over the map (the canvas centre: the enemy entrance, the menu
      // closed): the zoom hint queues behind "Raiding: Blockade".
      const cbox = await page.locator('canvas').first().boundingBox();
      if (!cbox) throw new Error('canvas has no bounding box');
      await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
      await page.mouse.wheel(0, -120);
      await expect.poll(async () => (await captionQueue(page)).pending ?? '').toMatch(/ to zoom$/);
      zoomHint = (await captionQueue(page)).pending!;

      // Switch to Assault: Blockade is cut short and Assault starts on a new Text
      // with a full lifetime; the hint keeps waiting behind it.
      await giveOrder(page, door, RAID.Assault);
      const q = await captionQueue(page);
      expect(isAssault(q.active)).toBe(true);
      expect(q.pending).toBe(zoomHint);
      expect(q.onScreen).toHaveLength(1);
      expect(isAssault(q.onScreen[0]!)).toBe(true);
      expect(q.textsCreated).toBe(created + 1);
    } finally {
      await freezeCaptionClock(page, false);
    }
    await expect
      .poll(async () => queueIdle(await captionQueue(page)), { timeout: 15_000 })
      .toBe(true);
    const shown = await captions(page);
    expect(shown.indexOf(zoomHint)).toBeGreaterThan(shown.findIndex(isAssault));
  });

  // #399: the description no longer lies over a HUD control (where #378's version
  // of this test clicked, on the minimap), so what is left to see is that a click
  // on its words is like any click off the menu: it closes it and gives no order.
  test('a click on the description closes the menu: no order, no camera move', async ({ page }) => {
    await freshGame(page, ALL_HINTS);
    const door = await enemyDoor(page);
    await giveOrder(page, door, RAID.Deny); // an order in force, so the description shows
    await setPaused(page, true);

    await openRaidMenu(page, door);
    await expect.poll(async () => (await raidMenu(page))?.description ?? null).toMatch(/^Deny: /);
    const d = await descriptionRect(page);
    expect(d).not.toBeNull();
    const before = await page.evaluate(() =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test!.getCameraState!(),
    );
    const rallyBefore = await page.evaluate(
      () =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getPlayerRaidOrder?.() ??
        null,
    );

    // A click on the words: the menu closes; the world under them takes nothing
    // (no rally moved there) and the camera stays.
    await clickCanvasRect(page, { ...d!, w: Math.min(d!.w, 40) });
    await expect.poll(async () => (await raidMenu(page)) === null).toBe(true);
    const after = await page.evaluate(() =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test!.getCameraState!(),
    );
    expect(after.surface).toEqual(before.surface);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { __phase9_test?: TestHook }
          ).__phase9_test?.getPlayerRaidOrder?.() ?? null,
      ),
    ).toEqual(rallyBefore);
  });
});

// #399 — the playtest found the description strip over the minimap's top border
// and the Blockade line running to the canvas's right edge (shots/04-raid-menu-
// hover-3-blockade.png). Every order's description, with the menu opened by the
// right edge, near the bottom HUD strip, and over the minimap, must lie wholly on
// screen above the strip, off the menu, and clear of every HUD control. The oracle
// is the HUD layout itself, not the placement code (raid-order-view.ts).
test.describe('#399 — the raid menu description stays on screen and clear of the HUD', () => {
  const hud = buildHudLayout(DEFAULT_LAYOUT);
  /** The minimap as painted: its rect and the frame round it (#372). Same
   *  outline the minimap's painter draws to (MINIMAP_FRAME_OUT_PX, hud-layout.ts). */
  const minimapFrame: Rect = minimapFrameRect(hud);
  const HUD_CONTROLS: ReadonlyArray<[string, Rect]> = [
    ['minimap', minimapFrame],
    ['view toggle', VIEW_TOGGLE_RECT],
    ['alarm toggle', ALARM_TOGGLE_RECT],
    ['tool palette', hud.TOOLS],
    ['stats', hud.STATS],
    ['save icon', hud.SAVE_ICON],
  ];
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // Where on the canvas the enemy entrance is put before the right-click, and what
  // that must do to the menu (checked, so the case is really the one named).
  const CASES = [
    {
      name: 'right-edge',
      at: { x: DEFAULT_LAYOUT.w - 20, y: hud.ALARM_TOGGLE.y - 160 },
      menuIs: (m: Rect) => m.x + m.w === DEFAULT_LAYOUT.w,
    },
    {
      name: 'bottom',
      at: { x: DEFAULT_LAYOUT.w / 2 + 40, y: hud.HINTS.y - 8 },
      menuIs: (m: Rect) => m.y + m.h === hud.HINTS.y,
    },
    {
      name: 'over-minimap',
      at: { x: hud.MINIMAP.x - 30, y: hud.HINTS.y - 30 },
      menuIs: (m: Rect) => overlaps(m, minimapFrame) && overlaps(m, VIEW_TOGGLE_RECT),
    },
  ] as const;

  for (const c of CASES) {
    test(`menu ${c.name}: every order's description`, async ({ page }) => {
      await freshGame(page, ALL_HINTS);
      await setPaused(page, true);
      const door = await enemyDoor(page);
      const pt = await putDoorAt(page, door, c.at);
      // The click lands where asked, give or take the tile-snapped camera.
      expect(Math.abs(pt.x - c.at.x)).toBeLessThanOrEqual(TILE_SIZE_PX);
      expect(Math.abs(pt.y - c.at.y)).toBeLessThanOrEqual(TILE_SIZE_PX);
      const box = await canvasBox(page);
      await page.mouse.click(box.x + pt.x, box.y + pt.y, { button: 'right' });
      await expect
        .poll(async () => {
          const m = await page.evaluate(
            () =>
              (
                window as unknown as { __phase9_test?: TestHook }
              ).__phase9_test?.getContextMenu?.() ?? null,
          );
          return m !== null && m.visible && m.kind === 'raid';
        })
        .toBe(true);
      const m = await page.evaluate(() =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test!.getContextMenu!(),
      );
      const lastRow = contextMenuRowRect(m.screenX, m.screenY, RAID.Assault);
      const menu: Rect = {
        x: m.screenX,
        y: m.screenY,
        w: lastRow.w,
        h: lastRow.y + lastRow.h - m.screenY,
      };
      expect(c.menuIs(menu), `menu at ${JSON.stringify(menu)}`).toBe(true);

      const boxes: Rect[] = [];
      for (const option of RAID_ORDER_OPTIONS) {
        await hoverRow(page, { screenX: m.screenX, screenY: m.screenY }, option.raidType);
        // The menu's words are the order caption's (one blurb, single-sourced).
        await expect
          .poll(async () => (await raidMenu(page))?.description ?? null)
          .toBe(`${option.label}: ${option.blurb}`);
        expect(raidOrderCaption(option.raidType)).toBe(`Raiding: ${option.label}. ${option.blurb}`);
        const d = (await descriptionRect(page))!;
        boxes.push(d);
        const where = `${option.label} at ${JSON.stringify(d)}`;
        // Wholly on the canvas, above the bottom HUD strip.
        expect(d.x, where).toBeGreaterThanOrEqual(0);
        expect(d.y, where).toBeGreaterThanOrEqual(0);
        expect(d.x + d.w, where).toBeLessThanOrEqual(DEFAULT_LAYOUT.w);
        expect(d.y + d.h, where).toBeLessThanOrEqual(hud.HINTS.y);
        // Wrapped: never a ~500-px line, at most a couple of lines.
        expect(d.w, where).toBeLessThanOrEqual(320);
        expect(d.h, where).toBeLessThanOrEqual(60);
        // Off the menu, and clear of every HUD control.
        expect(overlaps(d, menu), where).toBe(false);
        for (const [control, r] of HUD_CONTROLS) {
          expect(overlaps(d, r), `${where} over the ${control}`).toBe(false);
        }
        if (option.raidType === RAID.Blockade) {
          await page.screenshot({
            path: `test-results/raid-menu-399-${c.name}-blockade.png`,
            clip: { x: box.x, y: box.y, width: box.width, height: box.height },
          });
        }
      }
      // One box for every order: it keeps its place as the pointer moves down
      // the menu, not each order's own width moving it about.
      for (const d of boxes) expect(d).toEqual(boxes[0]);
    });
  }
});
