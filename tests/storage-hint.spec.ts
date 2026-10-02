// storage-hint.spec.ts — #395: "Build a Food Storage chamber so your queen can lay
// eggs." reaches the player in a real browser when storage is what stops the queen
// laying (the V70 egg reserve tops storage capacity), and stays quiet once the
// player has designated a Food Storage chamber that would cover it. Its 4 s hold
// gives way to an army warning (#394) owed behind it, as the army warning's own
// long hold gives way to news owed behind it.
//
// The condition, the dwell, the re-arm and the pending-chamber rule are pinned in
// src/render/storage-hint.test.ts. What only a browser proves is the GameScene
// wiring: the per-frame step runs for the player's colony and its caption reaches
// UIScene's queue, and a hint left waiting behind another caption is withdrawn once
// the player designates a larder (Codex P2), playing or paused, before the
// designation's own 'chamber' caption needs the slot. And it never shows over the
// end screen when the queen dies while it waits (Codex P2), nor over the new-game
// screen after a restart from the pause menu's Save/Load.
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
import { ENEMY_COLONY_ID } from '../src/sim/constants.js';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import {
  DIALOG_NEW_GAME_RECT,
  SAVE_LOAD_ROW_RECT,
  SAVE_PROMPT_CONTINUE_RECT,
} from './helpers/geometry.js';

const HINT = 'Build a Food Storage chamber so your queen can lay eggs.';
/** storage-hint.ts STORAGE_HINT_DWELL_TICKS. */
const DWELL_TICKS = 200;
/** storage-hint.ts STORAGE_HINT_HOLD_MS. */
const HOLD_MS = 4000;
/** caption-queue.ts CAPTION_YIELD_FLOOR_MS: what a long hold keeps once it gives way. */
const YIELD_FLOOR_MS = 2000;
/** caption-queue.ts CAPTION_FADE_IN_MS + CAPTION_HOLD_MS + CAPTION_FADE_OUT_MS: a
 *  caption's whole course at the default hold (the rally caption's). */
const CAPTION_COURSE_MS = 300 + 800 + 400;
/** Scene time past a rally caption's whole course and then a hint promoted behind
 *  it (fade-in, its 4 s hold, fade-out), with a margin. */
const PAST_RALLY_AND_HINT_MS = CAPTION_COURSE_MS + 300 + HOLD_MS + 400 + 1_000;
/** Every army warning (a march, a gathering, an invasion: enemy-gathering.ts). */
const ARMY_WARNING_PREFIX = 'An enemy army is';
const RALLY_TEXT = 'Fighters will converge here.';
const CHAMBER_TEXT = 'Chambers give workers and brood a purpose. This one is a Food Storage.';
/** ChamberType.FoodStorage. */
const FOOD_STORAGE = 2;

interface TestHook {
  getCaptionsShown?: () => string[];
  getCaptionHolds?: () => { text: string; holdMs: number; yielded: boolean }[];
  getArmyWarningLog?: () => { tick: number; owedTick: number; text: string }[];
  getTick?: () => number;
  freezeCaptionClock?: (frozen: boolean) => void;
  advanceCaptionClock?: (ms: number) => void;
  getCaptionQueue?: () => { active: string | null; pending: string | null };
  rallyPlayerAt?: (tileX: number, tileY: number) => boolean;
  rallyColonyAt?: (colonyId: number, tileX: number, tileY: number) => boolean;
  isPaused?: () => boolean;
  placePlayerChamberAt?: (chamberType: number, tileX: number, tileY: number) => boolean;
  offerCaption?: (text: string) => boolean;
}

async function freezeCaptionClock(page: Page, frozen: boolean): Promise<void> {
  await page.evaluate((f: boolean) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.freezeCaptionClock === undefined) throw new Error('no freezeCaptionClock hook');
    t.freezeCaptionClock(f);
  }, frozen);
}

/** With the caption clock stopped, run it forward `ms` of scene time in fixed steps
 *  (UIScene.advanceCaptionClock): deterministic, unlike a wall-clock wait. */
async function advanceCaptionClock(page: Page, ms: number): Promise<void> {
  await page.evaluate((m: number) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.advanceCaptionClock === undefined) throw new Error('no advanceCaptionClock hook');
    t.advanceCaptionClock(m);
  }, ms);
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

/** The caption showing and the one waiting behind it (UIScene's queue). */
async function captionQueue(
  page: Page,
): Promise<{ active: string | null; pending: string | null }> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    const q = t?.getCaptionQueue?.();
    if (q === undefined) throw new Error('no getCaptionQueue hook');
    return { active: q.active, pending: q.pending };
  });
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

/** Hold a rally caption on screen (caption clock stopped) before the hint is due,
 *  and wait for the hint to queue behind it. The clock is stopped only once the
 *  queue is idle: in the 'starve' save the queen's starvation and danger captions
 *  run back to back from about tick 41 to about tick 101. */
async function queueHintBehindRally(page: Page): Promise<void> {
  await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThanOrEqual(100);
  await expect
    .poll(() => captionQueue(page), { timeout: 10_000 })
    .toEqual({ active: null, pending: null });
  await freezeCaptionClock(page, true);
  expect(await simTick(page)).toBeLessThan(DWELL_TICKS);
  const rallied = await page.evaluate(() =>
    (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.rallyPlayerAt?.(40, 62),
  );
  expect(rallied).toBe(true);
  await expect
    .poll(() => captionQueue(page), { timeout: 40_000 })
    .toEqual({ active: RALLY_TEXT, pending: HINT });
}

/** Designate a larder that would cover the reserve (tick.ts gate i: just below the
 *  row-6 tunnel), through the real enqueue. */
async function designateLarder(page: Page): Promise<void> {
  const placed = await page.evaluate(
    (t: number) =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.placePlayerChamberAt?.(
        t,
        28,
        7,
      ),
    FOOD_STORAGE,
  );
  expect(placed).toBe(true);
}

async function activeOverlay(page: Page): Promise<string> {
  return await page.evaluate(
    () =>
      (window as { __phase9_ui?: { activeOverlay?: string } }).__phase9_ui?.activeOverlay ??
      '<undefined>',
  );
}

async function simTick(page: Page): Promise<number> {
  return await page.evaluate(
    () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getTick?.() ?? -1,
  );
}

type Variant = 'plain' | 'designate' | 'army' | 'starve';

/** Seed the save.
 *  - 'starve': no food at all, so the queen starves on the real tick path at tick
 *    300 (QUEEN_STARVE_AFTER_TICKS; no fighter dies first, and storage blocks her on
 *    every tick before), after the hint is due.
 *  - 'designate': the player has designated a Food Storage chamber: a real
 *    PlaceChamber applied by one sim tick before the save (checked there).
 *  - 'army': eight enemy fighters stand far down the map to the south-east (where
 *    army-warning.spec.ts starts its army: all eight read as marching the whole
 *    way), rallied where they stand, so they hold there until the spec rallies
 *    them 13 tiles east of the player's door (rallyColonyAt). The march warning
 *    (#394) is owed about 75 ticks after the rally; the army then stands near the
 *    door without going in, so the warning stays owed (GATHER_CAPTION_OWED_TICKS). */
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
      setPoolFoodForTest: (w: unknown, c: unknown, fp: number) => void;
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
    foodUtils.setChamberStockForTest(
      r.world,
      r.player,
      r.playerLarder,
      variant === 'starve' ? 0 : 5000,
    );
    if (variant === 'starve') foodUtils.setPoolFoodForTest(r.world, r.player, 0);
    const shortfall = lifecycle.eggReserveStorageShortfallFp(r.world, r.player);
    // Storage blocks the queen, and one more Food Storage chamber would cover it.
    if (shortfall <= 0 || shortfall > k.FOOD_CHAMBER_CAPACITY) {
      throw new Error(`unexpected storage shortfall ${shortfall}`);
    }
    if (variant === 'army') {
      for (let i = 0; i < 8; i++) {
        utils.addFighter(r.world, k.ENEMY_COLONY_ID, 80 + (i % 4), 108 + (i >> 2), null);
      }
      // Rallied where it stands, the army holds there (with no rally it would drift
      // home and later read as at home, not marching).
      r.enemy.rallyPoint = { tileX: 81, tileY: 108 };
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

  test('its long hold gives way to an army warning owed behind it', async ({ page }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'army');
    await expect.poll(() => captions(page), { timeout: 40_000, intervals: [50] }).toContain(HINT);
    // Keep the hint up, however slow the machine, while the army marches: the
    // caption clock stops, the sim runs on.
    await freezeCaptionClock(page, true);
    expect((await captions(page)).some((c) => c.startsWith(ARMY_WARNING_PREFIX))).toBe(false);
    // Send the enemy army at the player's door now, behind the hint.
    const rallied = await page.evaluate(
      (enemy: number) =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.rallyColonyAt?.(
          enemy,
          37,
          64,
        ),
      ENEMY_COLONY_ID,
    );
    expect(rallied).toBe(true);
    const t0 = await simTick(page);
    // The march warning is owed behind the hint for a while (from about t0 + 75; a
    // march warning stays owed for 200 ticks); the hint is asked to give way.
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(t0 + 115);
    // Nothing queued behind the hint (an event caption would make it give way too):
    // the owed army warning is what asks it to.
    expect(await captionQueue(page)).toEqual({ active: HINT, pending: null });
    const unfrozenAt = await simTick(page);
    await freezeCaptionClock(page, false);
    // It held only the floor, and the warning followed it.
    await expect
      .poll(() => hintHold(page), { timeout: 10_000 })
      .toEqual({
        holdMs: YIELD_FLOOR_MS,
        yielded: true,
      });
    await expect
      .poll(async () => (await captions(page)).some((c) => c.startsWith(ARMY_WARNING_PREFIX)), {
        timeout: 15_000,
      })
      .toBe(true);
    // It was owed by the march the spec started, while the hint held the queue.
    const log = await page.evaluate(
      () =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getArmyWarningLog?.() ??
        [],
    );
    expect(log).toHaveLength(1);
    expect(log[0]!.owedTick).toBeGreaterThan(t0);
    expect(log[0]!.owedTick).toBeLessThan(unfrozenAt);
  });

  test('a hint waiting behind another caption is withdrawn once Food Storage is designated', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'plain');
    await queueHintBehindRally(page);
    await designateLarder(page);
    // The hint is withdrawn before the designation drains, so its own 'chamber'
    // caption takes the slot.
    await expect
      .poll(() => captionQueue(page), { timeout: 10_000 })
      .toEqual({ active: RALLY_TEXT, pending: CHAMBER_TEXT });
    // The advance hook plays the rally caption through and promotes the one waiting
    // (what the end-screen tests below rely on).
    await advanceCaptionClock(page, CAPTION_COURSE_MS + 300);
    expect(await captionQueue(page)).toEqual({ active: CHAMBER_TEXT, pending: null });
    // The captions run out and the hint never follows.
    await freezeCaptionClock(page, false);
    const t0 = await simTick(page);
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(t0 + 200);
    const shown = await captions(page);
    expect(shown).toContain(CHAMBER_TEXT);
    expect(shown).not.toContain(HINT);
  });

  test('designated while paused, the waiting hint is withdrawn before it can show', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'plain');
    await queueHintBehindRally(page);
    // Paused, the command waits undrained; the projected world counts it.
    await setPaused(page, true);
    await designateLarder(page);
    await expect
      .poll(() => captionQueue(page), { timeout: 10_000 })
      .toEqual({ active: RALLY_TEXT, pending: null });
    // The caption clock runs while paused: the rally caption ends with nothing behind it.
    await advanceCaptionClock(page, CAPTION_COURSE_MS + 300);
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    await freezeCaptionClock(page, false);
    await setPaused(page, false);
    const t0 = await simTick(page);
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(t0 + 200);
    const shown = await captions(page);
    expect(shown).toContain(CHAMBER_TEXT);
    expect(shown).not.toContain(HINT);
  });

  test('a waiting hint never shows over the end screen when the queen dies', async ({ page }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'starve');
    await queueHintBehindRally(page);
    // The queen starves at tick 300 through the sim's own Defeat path (no seam).
    await expect.poll(() => activeOverlay(page), { timeout: 40_000 }).toBe('game-over');
    // With the caption clock still stopped, the game over itself emptied the queue.
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    // The caption clock runs on behind the end screen: past the rally's whole course
    // and a promoted hint's, nothing comes up over it.
    await advanceCaptionClock(page, PAST_RALLY_AND_HINT_MS);
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    expect(await captions(page)).not.toContain(HINT);
    // A late caption source (an autosave failure resolving now) is not admitted either.
    const offered = await page.evaluate(() => {
      const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
      if (t?.offerCaption === undefined) throw new Error('no offerCaption hook');
      return t.offerCaption('late caption');
    });
    expect(offered).toBe(false);
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    expect(await activeOverlay(page)).toBe('game-over');
  });

  test('a waiting hint never shows over the new-game screen after a restart from Save/Load', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'plain');
    await queueHintBehindRally(page);
    // Pause menu → Save/Load → New Game: a restart with no game over.
    await page.keyboard.press('Escape');
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('pause-menu');
    await clickCanvasRect(page, SAVE_LOAD_ROW_RECT);
    await expect.poll(() => activeOverlay(page), { timeout: 5_000 }).toBe('save-load');
    // The booted save is in storage, so the first click asks to confirm.
    await clickCanvasRect(page, DIALOG_NEW_GAME_RECT);
    expect(await activeOverlay(page)).toBe('save-load');
    await clickCanvasRect(page, DIALOG_NEW_GAME_RECT);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as { __phase9_ui?: { bootScreen?: string } }).__phase9_ui?.bootScreen,
          ),
        { timeout: 5_000 },
      )
      .toBe('difficulty-select');
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    await advanceCaptionClock(page, PAST_RALLY_AND_HINT_MS);
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    expect(await captions(page)).not.toContain(HINT);
  });
});
