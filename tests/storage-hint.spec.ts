// storage-hint.spec.ts — #395: "Build a Food Storage chamber so your queen can lay
// eggs." reaches the player in a real browser when storage is what stops the queen
// laying (the V70 egg reserve tops storage capacity), and stays quiet once the
// player has designated a Food Storage chamber that would cover it. Its 4 s hold
// gives way to an enemy-army gathering warning owed behind it, as the gathering
// warning's own long hold gives way to news owed behind it.
//
// The condition, the dwell, the re-arm and the pending-chamber rule are pinned in
// src/render/storage-hint.test.ts. What only a browser proves is the GameScene
// wiring: the per-frame step runs for the player's colony and its caption reaches
// UIScene's queue.
//
// Setup, without touching a running sim: the page builds the raid world
// (raid-test-utils.ts: the player has a completed Queen chamber with the queen in
// it and a completed Food Storage chamber, no workers, spider and AI off), carves
// and adds a completed Nursery, and adds 60 fighters, so the reserve the queen needs
// with no brood (her own runway, the new egg's larva and 60 workers) tops the one
// larder's capacity. Food in the larder keeps everyone fed. Before saving through
// the real save path (manualSave), the page checks the storage shortfall: above 0,
// and no more than one Food Storage chamber would close. A reload boots the save
// through Continue.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';

const HINT = 'Build a Food Storage chamber so your queen can lay eggs.';
/** storage-hint.ts STORAGE_HINT_DWELL_TICKS. */
const DWELL_TICKS = 200;
/** storage-hint.ts STORAGE_HINT_HOLD_MS. */
const HOLD_MS = 4000;
/** caption-queue.ts CAPTION_YIELD_FLOOR_MS: what a long hold keeps once it gives way. */
const YIELD_FLOOR_MS = 2000;
const GATHERING_PREFIX = 'An enemy army is gathering near your';

interface TestHook {
  getCaptionsShown?: () => string[];
  getCaptionHolds?: () => { text: string; holdMs: number; yielded: boolean }[];
  getTick?: () => number;
  freezeCaptionClock?: (frozen: boolean) => void;
}

async function freezeCaptionClock(page: Page, frozen: boolean): Promise<void> {
  await page.evaluate((f: boolean) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.freezeCaptionClock === undefined) throw new Error('no freezeCaptionClock hook');
    t.freezeCaptionClock(f);
  }, frozen);
}

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionsShown?.() ?? [],
  );
}

/** The hold UIScene scheduled for the hint (null: not scheduled yet). */
async function hintHold(page: Page): Promise<{ holdMs: number; yielded: boolean } | null> {
  return await page.evaluate((hint: string) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    const h = t?.getCaptionHolds?.().find((c) => c.text === hint);
    return h ? { holdMs: h.holdMs, yielded: h.yielded } : null;
  }, HINT);
}

async function simTick(page: Page): Promise<number> {
  return await page.evaluate(
    () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getTick?.() ?? -1,
  );
}

type Variant = 'plain' | 'designate' | 'army';

/** Seed the save.
 *  - 'designate': the player has designated a Food Storage chamber: a real
 *    PlaceChamber applied by one sim tick before the save (checked there).
 *  - 'army': eight enemy fighters stand in the far north-east corner, rallied 13
 *    tiles east of the player's door. They march there and, headless, gather near
 *    it from tick 180, so the gathering warning is owed from tick 220: after the
 *    hint has shown (tick 200 or later, after its dwell). */
async function seedStorageSave(page: Page, variant: Variant): Promise<void> {
  await page.evaluate(async (variant: Variant) => {
    // Paths are served by the Vite dev server (Playwright always runs it).
    const utilsPath = '/src/sim/raid-test-utils.ts';
    const foodUtilsPath = '/src/sim/food/food-test-utils.ts';
    const lifecyclePath = '/src/sim/colony/lifecycle-system.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    const typesPath = '/src/sim/types.ts';
    const enumsPath = '/src/sim/enums.ts';
    const fixedPath = '/src/sim/fixed.ts';
    const tickPath = '/src/sim/tick.ts';
    type Colony = {
      chambers: unknown[];
      colonyId: number;
      rallyPoint: { tileX: number; tileY: number } | null;
    };
    type World = {
      undergroundGrids: Record<number, unknown>;
      pendingChambers: Record<string, unknown>;
    };
    const utils = (await import(/* @vite-ignore */ utilsPath)) as {
      raidWorld: (fp: number) => {
        world: World;
        player: Colony;
        enemy: Colony;
        playerLarder: unknown;
      };
      addFighter: (w: unknown, c: number, x: number, y: number, g: number | null) => number;
      carve: (g: unknown, x0: number, y0: number, x1: number, y1: number) => void;
    };
    const foodUtils = (await import(/* @vite-ignore */ foodUtilsPath)) as {
      setChamberStockForTest: (w: unknown, c: unknown, ch: unknown, fp: number) => void;
    };
    const lifecycle = (await import(/* @vite-ignore */ lifecyclePath)) as {
      eggReserveStorageShortfallFp: (w: unknown, c: unknown) => number;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      PLAYER_COLONY_ID: number;
      ENEMY_COLONY_ID: number;
      FOOD_CHAMBER_CAPACITY: number;
    };
    const types = (await import(/* @vite-ignore */ typesPath)) as {
      allocateEntityId: (w: unknown) => number;
    };
    const enums = (await import(/* @vite-ignore */ enumsPath)) as {
      ChamberType: { Nursery: number; FoodStorage: number };
    };
    const fixed = (await import(/* @vite-ignore */ fixedPath)) as { FP_SHIFT: number };
    const sim = (await import(/* @vite-ignore */ tickPath)) as {
      tick: (w: unknown, commands: unknown[]) => unknown;
    };

    const r = utils.raidWorld(3000);
    const id = k.PLAYER_COLONY_ID;
    const grid = r.world.undergroundGrids[id];
    // A completed Nursery on the row-6 tunnel between the Queen chamber (x 10..14)
    // and the door shaft (x 24).
    utils.carve(grid, 17, 5, 20, 7);
    r.player.chambers.push({
      chamberId: types.allocateEntityId(r.world),
      chamberType: enums.ChamberType.Nursery,
      foodSlot: -1,
      posX: 17 << fixed.FP_SHIFT,
      posY: 5 << fixed.FP_SHIFT,
      width: 4,
      height: 3,
    });
    for (let i = 0; i < 60; i++) utils.addFighter(r.world, id, 26 + (i % 8), 6, id);
    foodUtils.setChamberStockForTest(r.world, r.player, r.playerLarder, 5000);
    const shortfall = lifecycle.eggReserveStorageShortfallFp(r.world, r.player);
    // Storage blocks the queen, and one more Food Storage chamber would cover it.
    if (shortfall <= 0 || shortfall > k.FOOD_CHAMBER_CAPACITY) {
      throw new Error(`unexpected storage shortfall ${shortfall}`);
    }
    if (variant === 'army') {
      for (let i = 0; i < 8; i++) {
        utils.addFighter(r.world, k.ENEMY_COLONY_ID, 122 + (i % 4), Math.floor(i / 4), null);
      }
      r.enemy.rallyPoint = { tileX: 37, tileY: 64 };
    }
    if (variant === 'designate') {
      sim.tick(r.world, [
        {
          type: 'PlaceChamber',
          colonyId: id,
          chamberType: enums.ChamberType.FoodStorage,
          // Just below the row-6 tunnel, so the footprint is reachable (tick.ts gate i).
          anchorTileX: 28,
          anchorTileY: 7,
          issuedAtTick: 0,
        },
      ]);
      if (r.world.pendingChambers[`${id}:28:7`] === undefined) {
        throw new Error('PlaceChamber was refused');
      }
    }
    if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
  }, variant);
}

async function bootStorageSave(page: Page, variant: Variant): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  await seedStorageSave(page, variant);
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

test.describe('#395 — Food Storage hint', () => {
  test('storage short of the reserve shows the hint once, after the dwell', async ({ page }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'plain');
    await expect.poll(() => captions(page), { timeout: 40_000, intervals: [50] }).toContain(HINT);
    // The save starts at tick 0, so the dwell puts the caption at tick 200 or later.
    const shownBy = await simTick(page);
    expect(shownBy).toBeGreaterThanOrEqual(DWELL_TICKS);
    // Held long enough to read (nothing queued behind it here to make it give way).
    await expect
      .poll(() => hintHold(page), { timeout: 10_000 })
      .toEqual({
        holdMs: HOLD_MS,
        yielded: false,
      });
    // Once: 300 ticks later it has not repeated (nothing in the colony changes that
    // would cover the reserve, so a re-shown one-shot would have shown by now).
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(shownBy + 300);
    expect((await captions(page)).filter((c) => c === HINT)).toHaveLength(1);
  });

  test('a designated Food Storage chamber that would cover it keeps it quiet', async ({ page }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'designate');
    await expect.poll(() => simTick(page), { timeout: 60_000 }).toBeGreaterThan(3 * DWELL_TICKS);
    expect(await captions(page)).not.toContain(HINT);
  });

  test('its long hold gives way to a gathering warning owed behind it', async ({ page }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'army');
    await expect.poll(() => captions(page), { timeout: 40_000, intervals: [50] }).toContain(HINT);
    // Keep the hint up, however slow the machine, while the army gathers: the
    // caption clock stops, the sim runs on.
    await freezeCaptionClock(page, true);
    const shownBy = await simTick(page);
    // The hint showed first and the army is not yet owed its warning (from tick 220).
    expect(shownBy).toBeLessThan(215);
    expect((await captions(page)).some((c) => c.startsWith(GATHERING_PREFIX))).toBe(false);
    // The warning is owed behind the hint for a while; the hint is asked to give way.
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(260);
    await freezeCaptionClock(page, false);
    // It held only the floor, and the warning followed it.
    await expect
      .poll(() => hintHold(page), { timeout: 10_000 })
      .toEqual({
        holdMs: YIELD_FLOOR_MS,
        yielded: true,
      });
    await expect
      .poll(async () => (await captions(page)).some((c) => c.startsWith(GATHERING_PREFIX)), {
        timeout: 15_000,
      })
      .toBe(true);
  });
});
