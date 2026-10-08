// stores-filling-caption.spec.ts — economy captions: "Your stores are nearly full —
// build another Food Storage so your foragers have room." reaches the player in a real
// browser once the stores have read three-quarters full, with a Food Storage chamber
// built and none designated, for the dwell; held long enough to read; once within its
// cooldown. A caption owed while the queue is busy is dropped, never shown, once the
// player designates a Food Storage chamber.
//
// The trigger, the dwell, the cooldown, the storage-hint coupling and the stale rules
// are pinned in src/render/stores-filling-caption.test.ts. What only a browser proves is
// the GameScene wiring: the per-tick look (beforeSimTick) and the frame step get the
// caption through UIScene's queue, and a caption waiting behind another one is
// dropped once its trigger no longer holds.
//
// Setup, without touching a running sim: the page builds the raid world
// (raid-test-utils.ts: the player has a completed Queen chamber with the queen in it and
// a completed Food Storage chamber, no workers, spider and AI off) and fills the
// entrance pool and the larder. No Nursery, so the queen is not ready to lay and storage
// cannot hold her back (that is the storage hint's case). Only the queen eats, so the
// stores stay above three-quarters for the length of a test. The save goes through the
// real save path (manualSave); a reload boots it through Continue.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';
import {
  STORES_FILLING_CAPTION_TEXT,
  STORES_FILLING_DWELL_TICKS,
  STORES_FILLING_HOLD_MS,
  STORES_FILLING_OWED_TICKS,
} from '../src/render/stores-filling-caption.js';

/** ChamberType.FoodStorage. */
const FOOD_STORAGE = 2;
/** A caption that holds the queue while the stores-filling caption comes due. */
const HOLDER = 'A caption that holds the queue.';

interface TestHook {
  getCaptionsShown?: () => string[];
  getCaptionHolds?: () => { text: string; holdMs: number; yielded: boolean }[];
  getCaptionQueue?: () => { active: string | null; pending: string | null };
  getTick?: () => number;
  freezeCaptionClock?: (frozen: boolean) => void;
  advanceCaptionClock?: (ms: number) => void;
  offerCaption?: (text: string) => boolean;
  placePlayerChamberAt?: (chamberType: number, tileX: number, tileY: number) => boolean;
}

type Win = Window & { __phase9_test?: TestHook };

const captions = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getCaptionsShown?.() ?? []);
const simTick = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getTick?.() ?? -1);
const captionQueue = (page: Page) =>
  page.evaluate(() => {
    const q = (window as Win).__phase9_test?.getCaptionQueue?.();
    return { active: q?.active ?? null, pending: q?.pending ?? null };
  });

async function hold(page: Page): Promise<{ holdMs: number; yielded: boolean } | null> {
  const holds = await page.evaluate(() => (window as Win).__phase9_test?.getCaptionHolds?.() ?? []);
  const h = holds.find((c) => c.text === STORES_FILLING_CAPTION_TEXT);
  return h === undefined ? null : { holdMs: h.holdMs, yielded: h.yielded };
}

async function freezeCaptionClock(page: Page, frozen: boolean): Promise<void> {
  await page.evaluate((f: boolean) => {
    const t = (window as Win).__phase9_test;
    if (t?.freezeCaptionClock === undefined) throw new Error('no freezeCaptionClock hook');
    t.freezeCaptionClock(f);
  }, frozen);
}

/** Seed the save: the raid world with the player's pool and larder full. */
async function seedFullStoresSave(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const utilsPath = '/src/sim/raid-test-utils.ts';
    const foodUtilsPath = '/src/sim/food/food-test-utils.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    const captionPath = '/src/render/stores-filling-caption.ts';
    const utils = (await import(/* @vite-ignore */ utilsPath)) as {
      raidWorld: (fp: number) => { world: unknown; player: unknown; playerLarder: unknown };
    };
    const foodUtils = (await import(/* @vite-ignore */ foodUtilsPath)) as {
      setChamberStockForTest: (w: unknown, c: unknown, ch: unknown, fp: number) => void;
      setPoolFoodForTest: (w: unknown, c: unknown, fp: number) => void;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      PLAYER_COLONY_ID: number;
      FOOD_CHAMBER_CAPACITY: number;
      BASE_FOOD_STORAGE_CAPACITY: number;
    };
    const caption = (await import(/* @vite-ignore */ captionPath)) as {
      storesFillingCondition: (w: unknown, c: number) => boolean;
    };
    const r = utils.raidWorld(3000);
    foodUtils.setPoolFoodForTest(r.world, r.player, k.BASE_FOOD_STORAGE_CAPACITY);
    foodUtils.setChamberStockForTest(r.world, r.player, r.playerLarder, k.FOOD_CHAMBER_CAPACITY);
    if (!caption.storesFillingCondition(r.world, k.PLAYER_COLONY_ID)) {
      throw new Error('the fixture does not meet the trigger');
    }
    if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
  });
}

async function bootFullStoresSave(page: Page): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  await seedFullStoresSave(page);
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

test.describe('economy captions — the stores-filling caption', () => {
  test('stores three-quarters full with no Food Storage designated: it shows after the dwell, held to be read, once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootFullStoresSave(page);
    await expect
      .poll(() => captions(page), { timeout: 40_000, intervals: [50] })
      .toContain(STORES_FILLING_CAPTION_TEXT);
    // The save starts at tick 0, so the dwell puts the caption at tick 200 or later.
    const shownBy = await simTick(page);
    expect(shownBy).toBeGreaterThanOrEqual(STORES_FILLING_DWELL_TICKS);
    // Held long enough to read: nothing queued behind it made it give way.
    await expect
      .poll(() => hold(page), { timeout: 15_000 })
      .toEqual({ holdMs: STORES_FILLING_HOLD_MS, yielded: false });
    // Once within its cooldown: 300 ticks on, the stores still full, it has not repeated.
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(shownBy + 300);
    expect((await captions(page)).filter((c) => c === STORES_FILLING_CAPTION_TEXT)).toHaveLength(1);
  });

  test('owed behind a busy queue, it is dropped once a Food Storage is designated', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootFullStoresSave(page);
    // Hold the queue (caption clock stopped) before the caption comes due.
    await expect
      .poll(() => captionQueue(page), { timeout: 10_000 })
      .toEqual({ active: null, pending: null });
    await freezeCaptionClock(page, true);
    expect(await simTick(page)).toBeLessThan(STORES_FILLING_DWELL_TICKS);
    const held = await page.evaluate(
      (t: string) => (window as Win).__phase9_test?.offerCaption?.(t) ?? false,
      HOLDER,
    );
    expect(held).toBe(true);
    // Let it come due behind the holder (a recurring caption waits for an idle queue,
    // and stays owed for STORES_FILLING_OWED_TICKS).
    await expect
      .poll(() => simTick(page), { timeout: 40_000 })
      .toBeGreaterThan(STORES_FILLING_DWELL_TICKS + 20);
    expect(await captionQueue(page)).toEqual({ active: HOLDER, pending: null });
    // Designate a Food Storage chamber (just below the row-6 tunnel) through the real
    // enqueue, then free the queue while the caption would still be owed.
    const placed = await page.evaluate(
      (t: number) => (window as Win).__phase9_test?.placePlayerChamberAt?.(t, 28, 7) ?? false,
      FOOD_STORAGE,
    );
    expect(placed).toBe(true);
    expect(await simTick(page)).toBeLessThan(
      STORES_FILLING_DWELL_TICKS + STORES_FILLING_OWED_TICKS,
    );
    await freezeCaptionClock(page, false);
    const t0 = await simTick(page);
    await expect
      .poll(() => simTick(page), { timeout: 40_000 })
      .toBeGreaterThan(t0 + STORES_FILLING_OWED_TICKS + 20);
    expect(await captions(page)).not.toContain(STORES_FILLING_CAPTION_TEXT);
  });
});
