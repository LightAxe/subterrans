// enemy-gathering.spec.ts — #372: an enemy army gathering near one of the
// player's entrances shows on the minimap (red fighter dots, a pulsing ring, a
// framed minimap) and raises the gathering warning caption, once, naming the
// entrance, in a real browser.
//
// The detection, the hysteresis and the entrance names are pinned in
// src/render/enemy-gathering.test.ts, and the minimap draw calls in
// src/render/minimap.test.ts. What only a browser proves is the wiring:
// GameScene runs the warning each frame and the caption queue shows it, and
// UIScene draws the dots, ring and frame where the player sees them.
//
// Setup, without touching a running sim: the page imports the sim's raid fixture
// (src/sim/raid-test-utils.ts — two dug-out nests, no spider, no AI state, no
// starting workers) from the Vite dev server, gives the player a second open
// entrance west of its door (so the door at x 24 is the "east" one), puts eight
// enemy fighters on the surface 13 tiles east of that door, rallies the enemy
// there so they hold, and saves through the real save path (manualSave). A
// reload boots it through Continue.
//
// Screenshots (for a human eye; not compared): test-results/enemy-gathering-*.png.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { MINIMAP_RECT, SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';
import { CAPTION_YIELD_FLOOR_MS } from '../src/render/caption-queue.js';
import { GATHER_CAPTION_HOLD_MS } from '../src/render/enemy-gathering.js';

const RALLY_TEXT = 'Fighters will converge here.';
const WARNING =
  'An enemy army is gathering near your east entrance. Train fighters and rally there.';

// The minimap rect and its scale (px per tile; the surface is 128 tiles square).
const MM = MINIMAP_RECT;
const MM_SCALE = MINIMAP_RECT.w / 128;
// Where the army starts (tiles) and the enemy rally it holds at — see
// seedGatheringSave.
const ARMY = { x0: 36, x1: 39, y0: 62, y1: 66 };
const RALLY = { tileX: 37, tileY: 64 };

interface TestHook {
  getCaptionsShown?: () => string[];
  rallyPlayerAt?: (x: number, y: number) => boolean;
  getCaptionHolds?: () => { text: string; holdMs: number; yielded: boolean }[];
  isPaused?: () => boolean;
  getTick?: () => number;
  sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
  surfaceTileScreenPoint?: (x: number, y: number) => { x: number; y: number } | null;
}

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    return t?.getCaptionsShown?.() ?? [];
  });
}

/** Each caption's final full-opacity hold (ms) and whether it gave way, oldest
 *  first, recorded by UIScene as its fade-out is scheduled. */
async function captionHolds(
  page: Page,
): Promise<{ text: string; holdMs: number; yielded: boolean }[]> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionHolds?.() ?? [],
  );
}

/** The recorded hold of the (first) warning, once its hold has ended. */
async function warningHold(page: Page): Promise<{ holdMs: number; yielded: boolean } | null> {
  const h = (await captionHolds(page)).find((c) => c.text === WARNING);
  return h === undefined ? null : { holdMs: h.holdMs, yielded: h.yielded };
}

async function sample(page: Page, x: number, y: number, w: number, h: number): Promise<number[]> {
  return await page.evaluate(
    async ({ x, y, w, h }) => {
      const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
      if (t?.sampleArea === undefined) throw new Error('no sampleArea hook');
      return await t.sampleArea(x, y, w, h);
    },
    { x, y, w, h },
  );
}

/** Pixels in an RGBA array that are the minimap's bright fighter red. */
function redPixels(px: number[]): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i]! > 200 && px[i + 1]! < 90 && px[i + 2]! < 90) n++;
  }
  return n;
}

async function seedGatheringSave(page: Page): Promise<void> {
  await page.evaluate(
    async ({ army, rally }) => {
      const utilsPath = '/src/sim/raid-test-utils.ts';
      const savePath = '/src/platform/save.ts';
      const constantsPath = '/src/sim/constants.ts';
      const typesPath = '/src/sim/types.ts';
      const terrainPath = '/src/sim/terrain.ts';
      type Colony = {
        entrances: {
          entranceId: number;
          surfaceTileX: number;
          surfaceTileY: number;
          isOpen: boolean;
        }[];
        rallyPoint: { tileX: number; tileY: number } | null;
      };
      type World = { undergroundGrids: Record<number, unknown> };
      const utils = (await import(/* @vite-ignore */ utilsPath)) as {
        raidWorld: (fp: number) => { world: World; player: Colony; enemy: Colony };
        addFighter: (w: unknown, c: number, x: number, y: number, g: number | null) => number;
      };
      const save = (await import(/* @vite-ignore */ savePath)) as {
        manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
      };
      const k = (await import(/* @vite-ignore */ constantsPath)) as {
        PLAYER_COLONY_ID: number;
        ENEMY_COLONY_ID: number;
      };
      const types = (await import(/* @vite-ignore */ typesPath)) as {
        allocateEntityId: (w: unknown) => number;
      };
      const terrain = (await import(/* @vite-ignore */ terrainPath)) as {
        ugSet: (g: unknown, x: number, y: number, s: number) => void;
        UndergroundTileState: { Open: number };
      };
      const r = utils.raidWorld(3000);
      // A second open player entrance at (10, 62) (shaft rows 0..1 dug; its
      // surface clearance halo is all walkable, as the save validator requires):
      // the door at x 24 is then east of the middle of the player's entrances.
      const grid = r.world.undergroundGrids[k.PLAYER_COLONY_ID];
      terrain.ugSet(grid, 10, 0, terrain.UndergroundTileState.Open);
      terrain.ugSet(grid, 10, 1, terrain.UndergroundTileState.Open);
      r.player.entrances.push({
        entranceId: types.allocateEntityId(r.world),
        surfaceTileX: 10,
        surfaceTileY: 62,
        isOpen: true,
      });
      // Eight enemy fighters on the surface, 12-15 tiles east of the x-24 door,
      // rallied where they stand so they hold there.
      for (let i = 0; i < 8; i++) {
        const x = army.x0 + (i % 4);
        const y = army.y0 + Math.floor(i / 4) * (army.y1 - army.y0);
        utils.addFighter(r.world, k.ENEMY_COLONY_ID, x, y, null);
      }
      r.enemy.rallyPoint = { tileX: rally.tileX, tileY: rally.tileY };
      if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
    },
    { army: ARMY, rally: RALLY },
  );
}

async function bootGatheringSave(page: Page): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  await seedGatheringSave(page);
  await page.reload();
  await waitForUiHook(page);
  await expect
    .poll(async () => {
      const ui = await page.evaluate(
        () => (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui?.bootScreen,
      );
      return ui ?? '<undefined>';
    })
    .toBe('save-prompt');
  await clickCanvasRect(page, SAVE_PROMPT_CONTINUE_RECT);
  await settleToPlaying(page);
}

test.describe('#372 — enemy army gathering', () => {
  test('the minimap shows the army and the warning names the entrance, once', async ({ page }) => {
    test.setTimeout(60_000);
    await bootGatheringSave(page);

    // The warning shows (after the 2 s dwell) and names the east entrance.
    await expect
      .poll(() => captions(page), { timeout: 15_000, intervals: [50] })
      .toContain(WARNING);
    const box = await page.locator('canvas').first().boundingBox();
    if (!box) throw new Error('no canvas');
    // For the human eye only (asserts nothing): let the warning finish fading in
    // (300 ms) so the screenshot shows it at full opacity.
    await page.waitForTimeout(600);
    await page.screenshot({
      path: 'test-results/enemy-gathering-caption.png',
      clip: box,
    });

    // It holds long enough to read: the full-opacity hold UIScene scheduled for
    // it is GATHER_CAPTION_HOLD_MS (a default caption holds 800 ms), and nothing
    // queued behind it here made it give way. Read from the hold log UIScene
    // records as the caption's fade-out is scheduled — not timed.
    await expect
      .poll(() => warningHold(page), { timeout: 10_000 })
      .toEqual({ holdMs: GATHER_CAPTION_HOLD_MS, yielded: false });

    // The army's dots are on the minimap where it stands: bright red pixels
    // within 3 px of its rally tile. The ring is centred on the army's bounding
    // box (a px or two from the rally tile as fighters mill about it) and its red
    // stroke starts 8 px out (radius >= 9, 2 px wide), so it cannot reach this
    // 6 × 6 box (corners 4.3 px out): these are the dots.
    const armyRed = async (): Promise<number> =>
      redPixels(
        await sample(
          page,
          Math.round(MM.x + (RALLY.tileX + 0.5) * MM_SCALE) - 3,
          Math.round(MM.y + (RALLY.tileY + 0.5) * MM_SCALE) - 3,
          6,
          6,
        ),
      );
    expect(await armyRed()).toBeGreaterThanOrEqual(9);

    // The frame: the light band just outside the minimap's top edge, all along it.
    const band = await sample(page, MM.x, MM.y - 2, MM.w, 1);
    let light = 0;
    for (let i = 0; i < band.length; i += 4) {
      if (band[i]! > 200 && band[i + 1]! > 190 && band[i + 2]! > 150) light++;
    }
    expect(light).toBeGreaterThanOrEqual(MM.w - 2);

    // A close-up of the minimap (and its frame) for the human eye.
    await page.screenshot({
      path: 'test-results/enemy-gathering-minimap.png',
      clip: { x: box.x + MM.x - 8, y: box.y + MM.y - 8, width: MM.w + 16, height: MM.h + 16 },
    });

    // Once per gathering: the army is still there 10 s later — the warning long
    // since faded and the queue idle, so a re-offered warning would have shown —
    // and the warning has not repeated.
    const t0 = await page.evaluate(
      () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getTick?.() ?? -1,
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getTick?.() ?? -1,
          ),
        { timeout: 25_000 },
      )
      .toBeGreaterThan(t0 + 200);
    expect(await armyRed()).toBeGreaterThanOrEqual(9);
    expect((await captions(page)).filter((c) => c === WARNING)).toHaveLength(1);
  });

  test('the long warning gives way to a caption queued behind it', async ({ page }) => {
    test.setTimeout(60_000);
    await bootGatheringSave(page);
    await expect
      .poll(() => captions(page), { timeout: 15_000, intervals: [50] })
      .toContain(WARNING);
    // A player rally raises the one-shot rally caption, queued behind the warning
    // at once (well inside the warning's first CAPTION_YIELD_FLOOR_MS).
    const accepted = await page.evaluate(
      () =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.rallyPlayerAt?.(
          30,
          70,
        ) ?? false,
    );
    expect(accepted).toBe(true);
    // The warning gives way: its recorded hold is cut from GATHER_CAPTION_HOLD_MS
    // to the readable floor — exactly the floor if it gave way within its first
    // CAPTION_YIELD_FLOOR_MS at full opacity, or what it had already held if
    // later (a slow runner): either way below the full hold. Read from the hold
    // log after the fact, so no transient state has to be caught.
    await expect.poll(() => warningHold(page), { timeout: 10_000 }).not.toBeNull();
    const hold = (await warningHold(page))!;
    expect(hold.yielded).toBe(true);
    expect(hold.holdMs).toBeGreaterThanOrEqual(CAPTION_YIELD_FLOOR_MS);
    expect(hold.holdMs).toBeLessThan(GATHER_CAPTION_HOLD_MS);
    // And the rally caption is the next to show.
    await expect.poll(() => captions(page), { timeout: 10_000 }).toContain(RALLY_TEXT);
    const shown = await captions(page);
    expect(shown[shown.indexOf(WARNING) + 1]).toBe(RALLY_TEXT);
  });
});
