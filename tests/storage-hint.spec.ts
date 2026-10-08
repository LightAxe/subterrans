// storage-hint.spec.ts — #395/#413: the Food Storage hint reaches the player in a real
// browser when storage is what stops the queen laying (the V70 egg reserve tops
// storage capacity), and stays quiet once the player has designated a Food Storage
// chamber that would cover it. Its 4 s hold gives way to an army warning (#394) owed
// behind it, as the army warning's own long hold gives way to news owed behind it.
// These fixtures have a Food Storage chamber already, so the hint reads "Your stores
// are full — …", or with the stores under 3/4 full (the 'starve' save) "Your Food
// Storage is too small — …" (#413; with none it says to build one,
// storage-hint.test.ts).
//
// #413 (the last describe): the opening's full-larder stall, built by the colony's
// own workers from the standard opening, shows that hint and the queen's
// "Waiting for stores" line under the HUD stats; a larder with room shows the line
// (not in the warning colour) and no hint.
//
// The condition, the dwell, the re-arm and the pending-chamber rule are pinned in
// src/render/storage-hint.test.ts. What only a browser proves is the GameScene
// wiring: the per-frame step runs for the player's colony and its caption reaches
// UIScene's queue, and a hint left waiting behind another caption is withdrawn once
// the player designates a larder (Codex P2), playing or paused, before the
// designation's own 'chamber' caption needs the slot. And it never shows over the
// end screen when the queen dies while it waits (Codex P2), nor over the new-game
// screen after a restart from the pause menu's Save/Load. Waiting, it gives way to
// every caption but a first-use hint (Codex P2): an event caption takes its slot and
// it comes back after, and an owed army warning goes ahead of it with its full hold.
//
// Setup, without touching a running sim: the page builds the raid world
// (raid-test-utils.ts: the player has a completed Queen chamber with the queen in
// it and a completed Food Storage chamber, no workers, spider and AI off), carves
// and adds a completed Nursery, and adds 3 fighters and 3 eggs, so what the queen
// needs to lay (storage-hint.ts queenStoresNeedFp: her own runway, four larvae' worth
// and 3 workers) tops the one larder's capacity: #413's full-larder stall. The
// larder and the pool start full, which keeps everyone fed for the length of a test
// and keeps the hint's copy "Your stores are full" (no one forages, so the stores
// only fall: slowly, 3 fighters and the queen eating about 2.2 fp a tick, under 3/4
// full near tick 830 — a test that offers the hint later would get the "too small"
// copy). Before saving through the real
// save path (manualSave), the page checks that storage is short, by no more than one
// Food Storage chamber would close. A reload boots the save through Continue.

import { test, expect, type Page } from '@playwright/test';
import { ENEMY_COLONY_ID } from '../src/sim/constants.js';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import {
  DIALOG_NEW_GAME_RECT,
  SAVE_LOAD_ROW_RECT,
  SAVE_PROMPT_CONTINUE_RECT,
  STATS_RECT,
  TOP_CAPTION_MIN_LEFT,
} from './helpers/geometry.js';

/** storage-hint.ts STORAGE_FULL_HINT_TEXT: the hint for a colony with a larder (#413). */
const HINT = 'Your stores are full — build another Food Storage so your queen can keep laying.';
/** storage-hint.ts STORAGE_SMALL_HINT_TEXT: the same with the stores under 3/4 full
 *  (the 'starve' save: none at all). */
const SMALL_HINT = 'Your Food Storage is too small for your queen to keep laying — build another.';
/** hud-stats.ts HUD_STATS_COLORS: the "Waiting for stores" line's two colours (#413). */
const STORES_CAPPED_CSS = '#ddaa22';
const STORES_WAITING_CSS = '#bbbbbb';
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
/** Every army warning (a march, a gathering, an invasion: army-warning.ts). */
const ARMY_WARNING_PREFIX = 'An enemy army is';
const RALLY_TEXT = 'Fighters will converge here.';
/** onboarding-captions.ts foodMark: a Command tap on a food pile. */
const FOOD_MARK_TEXT = 'Your foragers will prioritize this pile.';
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
  getPlayerRaidOrder?: () => {
    raidType: number;
    rally: { tileX: number; tileY: number } | null;
  } | null;
  getCameraState?: () => {
    surface: { centerX: number; centerY: number; zoom: number };
  };
  rallyColonyAt?: (colonyId: number, tileX: number, tileY: number) => boolean;
  isPaused?: () => boolean;
  placePlayerChamberAt?: (chamberType: number, tileX: number, tileY: number) => boolean;
  offerCaption?: (text: string) => boolean;
  getQueenStoresLine?: () => {
    text: string;
    color: string;
    rect: { x: number; y: number; w: number; h: number };
  } | null;
  getPlayerStores?: () => {
    foodTotalFp: number;
    capacityFp: number;
    eggReserveFp: number;
    needFp: number;
    larvaeCount: number;
  } | null;
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

/** Hold a caption on screen (caption clock stopped) before the hint is due — a
 *  rally caption, or `holder` offered through the dev hook — and wait for the hint
 *  (`hint`: its copy for the save) to queue behind it. The clock is stopped only once
 *  the queue is idle: in the 'starve' save the queen's starvation and danger captions
 *  run back to back from about tick 41 to about tick 101. */
async function queueHintBehindRally(page: Page, holder?: string, hint = HINT): Promise<void> {
  await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThanOrEqual(100);
  await expect
    .poll(() => captionQueue(page), { timeout: 10_000 })
    .toEqual({ active: null, pending: null });
  await freezeCaptionClock(page, true);
  expect(await simTick(page)).toBeLessThan(DWELL_TICKS);
  const held =
    holder === undefined
      ? await page.evaluate(() =>
          (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.rallyPlayerAt?.(
            40,
            62,
          ),
        )
      : await offerCaption(page, holder);
  expect(held).toBe(true);
  await expect
    .poll(() => captionQueue(page), { timeout: 40_000 })
    .toEqual({ active: holder ?? RALLY_TEXT, pending: hint });
}

/** Offer a keyless event caption through UIScene's real showCaption (dev hook). */
async function offerCaption(page: Page, text: string): Promise<boolean> {
  return await page.evaluate((t: string) => {
    const hook = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (hook?.offerCaption === undefined) throw new Error('no offerCaption hook');
    return hook.offerCaption(t);
  }, text);
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

type Variant = 'plain' | 'designate' | 'army' | 'starve' | 'room' | 'hidden';

/** Seed the save.
 *  - 'hidden' (#413): 'plain' with no Nursery (its tunnel is still carved), so the
 *    queen is not ready to lay: no "Waiting for stores" line, and no hint.
 *  - 'room' (#413): 3 fighters, not 60, and 13.7 food stored (the larder 1500 fp,
 *    the pool 2000): the reserve (14.8 food) fits in the larder, so the queen only
 *    waits for food, which no one fetches (no foragers): she never lays, the
 *    reserve never grows.
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
 *    door without going in, so the warning stays owed (ARMY_CAPTION_OWED_TICKS). */
async function seedStorageSave(page: Page, variant: Variant): Promise<void> {
  await page.evaluate(async (variant: Variant) => {
    // Paths are served by the Vite dev server (Playwright always runs it).
    const utilsPath = '/src/sim/raid-test-utils.ts';
    const foodUtilsPath = '/src/sim/food/food-test-utils.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    const typesPath = '/src/sim/types.ts';
    const enumsPath = '/src/sim/enums.ts';
    const fixedPath = '/src/sim/fixed.ts';
    const tickPath = '/src/sim/tick.ts';
    const foodApiPath = '/src/sim/food/food-api.ts';
    const hintPath = '/src/render/storage-hint.ts';
    const antStorePath = '/src/sim/ant/ant-store.ts';
    const terrainPath = '/src/sim/terrain.ts';
    type Colony = {
      chambers: unknown[];
      colonyId: number;
      rallyPoint: { tileX: number; tileY: number } | null;
      queenEntityId: number;
      eggs: number[];
      eggCount: number;
    };
    type World = {
      undergroundGrids: Record<number, unknown>;
      pendingChambers: Record<string, unknown>;
      tick: number;
      ants: { posX: Int32Array; posY: Int32Array };
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
    const hint = (await import(/* @vite-ignore */ hintPath)) as {
      queenStoresNeedFp: (w: unknown, c: unknown) => number;
    };
    const antStore = (await import(/* @vite-ignore */ antStorePath)) as {
      initAnt: (ants: unknown, id: number, spec: Record<string, number>) => void;
    };
    const foodApi = (await import(/* @vite-ignore */ foodApiPath)) as {
      colonyFoodTotal: (w: unknown, c: unknown) => number;
      colonyFoodCapacity: (c: unknown) => number;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      PLAYER_COLONY_ID: number;
      ENEMY_COLONY_ID: number;
      FOOD_CHAMBER_CAPACITY: number;
      BASE_FOOD_STORAGE_CAPACITY: number;
      WORKER_LIFESPAN_TICKS: number;
    };
    const types = (await import(/* @vite-ignore */ typesPath)) as {
      allocateEntityId: (w: unknown) => number;
    };
    const enums = (await import(/* @vite-ignore */ enumsPath)) as {
      ChamberType: { Nursery: number; FoodStorage: number };
    };
    const fixed = (await import(/* @vite-ignore */ fixedPath)) as { FP_SHIFT: number };
    const zones = (await import(/* @vite-ignore */ terrainPath)) as {
      Zone: { Underground: number };
    };
    const sim = (await import(/* @vite-ignore */ tickPath)) as {
      tick: (w: unknown, commands: unknown[]) => unknown;
    };

    const r = utils.raidWorld(3000);
    const id = k.PLAYER_COLONY_ID;
    const grid = r.world.undergroundGrids[id];
    // A completed Nursery on the row-6 tunnel between the Queen chamber (x 10..14)
    // and the door shaft (x 24).
    utils.carve(grid, 17, 5, 20, 7);
    if (variant !== 'hidden') {
      r.player.chambers.push({
        chamberId: types.allocateEntityId(r.world),
        chamberType: enums.ChamberType.Nursery,
        foodSlot: -1,
        posX: 17 << fixed.FP_SHIFT,
        posY: 5 << fixed.FP_SHIFT,
        width: 4,
        height: 3,
      });
    }
    for (let i = 0; i < 3; i++) utils.addFighter(r.world, id, 26 + i, 6, id);
    if (variant !== 'room') {
      // Three eggs, where the queen lays them (eggs do not eat; none hatches in a test).
      const q = r.player.queenEntityId;
      for (let i = 0; i < 3; i++) {
        const egg = types.allocateEntityId(r.world);
        antStore.initAnt((r.world as unknown as { ants: unknown }).ants, egg, {
          colonyId: id,
          posX: r.world.ants.posX[q]!,
          posY: r.world.ants.posY[q]!,
          speed: 0,
          lifespan: k.WORKER_LIFESPAN_TICKS,
          zone: zones.Zone.Underground,
          lastMealTick: r.world.tick,
        });
        r.player.eggs.push(egg);
        r.player.eggCount += 1;
      }
    }
    const larderFp = variant === 'starve' ? 0 : variant === 'room' ? 1500 : k.FOOD_CHAMBER_CAPACITY;
    foodUtils.setChamberStockForTest(r.world, r.player, r.playerLarder, larderFp);
    if (variant === 'starve') foodUtils.setPoolFoodForTest(r.world, r.player, 0);
    else if (variant !== 'room') {
      foodUtils.setPoolFoodForTest(r.world, r.player, k.BASE_FOOD_STORAGE_CAPACITY);
    }
    const need = hint.queenStoresNeedFp(r.world, r.player);
    const capacity = foodApi.colonyFoodCapacity(r.player);
    if (variant === 'room') {
      // The larder can hold what she needs; the stores fall short of it.
      const stores = foodApi.colonyFoodTotal(r.world, r.player);
      if (need > capacity || stores >= need) {
        throw new Error(`unexpected stores ${stores} / need ${need}`);
      }
    } else if (need <= capacity || need - capacity > k.FOOD_CHAMBER_CAPACITY) {
      // Storage blocks the queen, and one more Food Storage chamber would cover it.
      throw new Error(`unexpected storage shortfall ${need - capacity}`);
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

/**
 * #413 — seed the opening's full-larder stall the way playtest 3 found it: a fresh
 * Easy game (seed 3) given the standard opening at tick 0 (a shaft down, the Queen
 * chamber, the Nursery and one Food Storage chamber, as `./p e3` plays it), run on
 * the real tick path, without the enemy AI, until the storage hint's condition
 * holds (about tick 1050: the queen has laid three eggs and her reserve, 28.9 food,
 * is more than the larder's 28). Checked before saving: one larder, and the #395
 * trigger (storage short with no brood waiting) does not fire. Returns the tick saved.
 */
async function seedOpeningStallSave(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    // Paths are served by the Vite dev server (Playwright always runs it).
    const scenarioPath = '/src/sim/scenario.ts';
    const tickPath = '/src/sim/tick.ts';
    const hintPath = '/src/render/storage-hint.ts';
    const lifecyclePath = '/src/sim/colony/lifecycle-system.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    const enumsPath = '/src/sim/enums.ts';
    type World = {
      tick: number;
      colonies: Record<number, { chambers: { chamberType: number }[] }>;
    };
    const scenario = (await import(/* @vite-ignore */ scenarioPath)) as {
      createScenario: (seed: number, difficulty: string) => World;
    };
    const sim = (await import(/* @vite-ignore */ tickPath)) as {
      tick: (w: unknown, commands: unknown[]) => unknown;
    };
    const hint = (await import(/* @vite-ignore */ hintPath)) as {
      storageHintCondition: (w: unknown, colonyId: number) => string;
    };
    const lifecycle = (await import(/* @vite-ignore */ lifecyclePath)) as {
      eggReserveStorageShortfallFp: (w: unknown, c: unknown) => number;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      PLAYER_COLONY_ID: number;
    };
    const enums = (await import(/* @vite-ignore */ enumsPath)) as {
      ChamberType: { Queen: number; Nursery: number; FoodStorage: number };
    };
    const id = k.PLAYER_COLONY_ID;
    const T = enums.ChamberType;
    const w = scenario.createScenario(3, 'Easy');
    const cmds: unknown[] = [];
    const dig = (tileX: number, tileY: number): void => {
      cmds.push({ type: 'MarkDigTile', colonyId: id, tileX, tileY, issuedAtTick: 0 });
    };
    const chamber = (chamberType: number, anchorTileX: number, anchorTileY: number): void => {
      cmds.push({
        type: 'PlaceChamber',
        colonyId: id,
        chamberType,
        anchorTileX,
        anchorTileY,
        issuedAtTick: 0,
      });
    };
    for (let y = 2; y <= 8; y++) dig(24, y);
    chamber(T.Queen, 22, 9);
    for (let x = 25; x <= 30; x++) dig(x, 5);
    chamber(T.Nursery, 31, 4);
    for (let x = 21; x <= 23; x++) dig(x, 5);
    chamber(T.FoodStorage, 17, 4);
    sim.tick(w, cmds);
    while (hint.storageHintCondition(w, id) !== 'blocked') {
      if (w.tick > 4000) throw new Error('no storage stall by tick 4000');
      sim.tick(w, []);
    }
    const colony = w.colonies[id]!;
    const larders = colony.chambers.filter((c) => c.chamberType === T.FoodStorage).length;
    if (larders !== 1) throw new Error(`expected one larder, found ${larders}`);
    if (lifecycle.eggReserveStorageShortfallFp(w, colony) !== 0) {
      throw new Error('the #395 trigger fires here: not the full-larder stall');
    }
    if (!(await save.manualSave(3, [], w))) throw new Error('manualSave failed');
    return w.tick;
  });
}

/** The queen's "Waiting for stores" line as drawn: text and colour (the strip it
 *  sits on is checked once, in the stall test). */
async function storesLine(page: Page): Promise<{ text: string; color: string } | null> {
  const line = await storesLineDrawn(page);
  return line === null ? null : { text: line.text, color: line.color };
}

async function storesLineDrawn(page: Page): Promise<{
  text: string;
  color: string;
  rect: { x: number; y: number; w: number; h: number };
} | null> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.getQueenStoresLine === undefined) throw new Error('no getQueenStoresLine hook');
    return t.getQueenStoresLine();
  });
}

interface CamView {
  centerX: number;
  centerY: number;
  zoom: number;
}

/** The surface camera (getCameraState). */
async function surfaceCamera(page: Page): Promise<CamView> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.getCameraState === undefined) throw new Error('no getCameraState hook');
    const c = t.getCameraState().surface;
    return { centerX: c.centerX, centerY: c.centerY, zoom: c.zoom };
  });
}

/** The player's rally (getPlayerRaidOrder), live. */
async function playerRally(page: Page): Promise<{ tileX: number; tileY: number } | null> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    const o = t?.getPlayerRaidOrder?.();
    if (o === undefined || o === null) throw new Error('no getPlayerRaidOrder hook / no world');
    return o.rally;
  });
}

/** The centre of canvas rect `r`, in page coordinates. */
async function pageCentre(
  page: Page,
  r: { x: number; y: number; w: number; h: number },
): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  return { x: box.x + r.x + r.w / 2, y: box.y + r.y + r.h / 2 };
}

/** A left drag from the centre of canvas rect `r`, 120 px right and 60 px down. */
async function dragFrom(page: Page, r: { x: number; y: number; w: number; h: number }) {
  const c = await pageCentre(page, r);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 120, c.y + 60, { steps: 8 });
  await page.mouse.up();
}

/** A wheel notch toward zoom-in at the centre of canvas rect `r`. */
async function wheelAt(page: Page, r: { x: number; y: number; w: number; h: number }) {
  const c = await pageCentre(page, r);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -300);
}

async function playerStores(page: Page): Promise<{
  foodTotalFp: number;
  capacityFp: number;
  eggReserveFp: number;
  needFp: number;
  larvaeCount: number;
}> {
  return await page.evaluate(() => {
    const s = (
      window as unknown as { __phase9_test?: TestHook }
    ).__phase9_test?.getPlayerStores?.();
    if (s === undefined || s === null) throw new Error('no getPlayerStores hook / no world');
    return s;
  });
}

async function bootStorageSave(page: Page, variant: Variant | 'stall'): Promise<number> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  let savedAt = 0;
  if (variant === 'stall') savedAt = await seedOpeningStallSave(page);
  else await seedStorageSave(page, variant);
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
  return savedAt;
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
    // The hint is out of date (and, retryable, would give the slot to the
    // designation's own 'chamber' caption anyway): the 'chamber' caption takes the
    // slot, and the hint is not offered again. (The paused test below is the one
    // that needs the withdrawal: there nothing drains.)
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
    await queueHintBehindRally(page, undefined, SMALL_HINT);
    // The queen starves at tick 300 through the sim's own Defeat path (no seam).
    await expect.poll(() => activeOverlay(page), { timeout: 40_000 }).toBe('game-over');
    // With the caption clock still stopped, the game over itself emptied the queue.
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    // The caption clock runs on behind the end screen: past the rally's whole course
    // and a promoted hint's, nothing comes up over it.
    await advanceCaptionClock(page, PAST_RALLY_AND_HINT_MS);
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    expect(await captions(page)).not.toContain(SMALL_HINT);
    // A late caption source (an autosave failure resolving now) is not admitted either.
    expect(await offerCaption(page, 'late caption')).toBe(false);
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

  test('a waiting hint gives its slot to an event caption and comes back after it', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'plain');
    await queueHintBehindRally(page);
    // A one-shot caption arrives (as the queen's starvation alert would): it is not
    // dropped for the hint — it takes the slot, and the hint steps out.
    const URGENT = 'An urgent caption.';
    expect(await offerCaption(page, URGENT)).toBe(true);
    expect(await captionQueue(page)).toEqual({ active: RALLY_TEXT, pending: URGENT });
    // Both play through; the hint, offered again, follows them.
    await advanceCaptionClock(page, 2 * CAPTION_COURSE_MS + 300);
    await expect
      .poll(() => captionQueue(page), { timeout: 10_000 })
      .toMatchObject({ active: HINT });
    const shown = await captions(page);
    expect(shown.slice(-3)).toEqual([RALLY_TEXT, URGENT, HINT]);
  });

  test('an owed army warning goes ahead of a waiting hint, with its full hold', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'army');
    const HOLDER = 'A caption on screen.';
    await queueHintBehindRally(page, HOLDER);
    // Send the enemy army at the player's door: its march warning becomes owed
    // while the queue is busy.
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
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(t0 + 115);
    // The owed warning withdrew the waiting hint, and holds it back.
    expect(await captionQueue(page)).toEqual({ active: HOLDER, pending: null });
    // The caption on screen ends: the army warning comes next, the hint behind it.
    await advanceCaptionClock(page, CAPTION_COURSE_MS + 300);
    await expect
      .poll(async () => {
        const q = await captionQueue(page);
        return { warning: q.active?.startsWith(ARMY_WARNING_PREFIX) ?? false, pending: q.pending };
      })
      .toEqual({ warning: true, pending: HINT });
    // The hint waiting behind it does not cut the warning short.
    await advanceCaptionClock(page, 300 + 4000 + 400 + 300);
    await expect
      .poll(() => captionQueue(page), { timeout: 10_000 })
      .toMatchObject({ active: HINT });
    const holds = await page.evaluate(
      () =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionHolds?.() ??
        [],
    );
    const warningHold = holds.find((h) => h.text.startsWith(ARMY_WARNING_PREFIX));
    expect(warningHold).toEqual(expect.objectContaining({ holdMs: 4000, yielded: false }));
  });
});

test.describe('#413 — storage is the population cap: the stall is taught', () => {
  test('the opening stall shows the queen waiting for stores, then the stores-full hint once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const savedAt = await bootStorageSave(page, 'stall');
    // Under the stats bar, from the first frames: the queen waits for stores the larder
    // cannot hold, in the warning colour.
    await expect
      .poll(async () => (await storesLine(page))?.color ?? null, { timeout: 10_000 })
      .toBe(STORES_CAPPED_CSS);
    // Paused, the line and the colony's numbers come from the same world: the stores
    // (the Food count's number) against what they must hold for her to lay (the egg
    // reserve and the next meal of the queen and of each larva), which tops the 28 the
    // larder holds.
    await setPaused(page, true);
    const stores = await playerStores(page);
    expect(stores.capacityFp).toBe(28 * 256);
    expect(stores.eggReserveFp).toBeGreaterThan(stores.capacityFp);
    expect(stores.needFp - stores.eggReserveFp).toBe(2 + stores.larvaeCount);
    const want = `Waiting for stores: ${stores.foodTotalFp >> 8}/${Math.ceil(stores.needFp / 256)}`;
    await expect.poll(() => storesLine(page)).toEqual({ text: want, color: STORES_CAPPED_CSS });
    // Its strip, measured in the real renderer, sits under the stats bar and ends left
    // of the widest caption at the top (the hint, below, is a two-line one) — and so
    // would a three-digit line ("Waiting for stores: 100/108", 27 chars), at the
    // measured width a char (padding included, so an over-estimate).
    const drawn = (await storesLineDrawn(page))!;
    const strip = drawn.rect;
    expect(strip.y).toBeGreaterThanOrEqual(STATS_RECT.y + STATS_RECT.h);
    expect(strip.x + strip.w).toBeLessThanOrEqual(TOP_CAPTION_MIN_LEFT);
    expect(strip.x + (27 * strip.w) / drawn.text.length).toBeLessThanOrEqual(TOP_CAPTION_MIN_LEFT);
    await setPaused(page, false);
    // The hint, after the dwell.
    await expect.poll(() => captions(page), { timeout: 40_000, intervals: [50] }).toContain(HINT);
    const shownBy = await simTick(page);
    expect(shownBy).toBeGreaterThanOrEqual(savedAt + DWELL_TICKS);
    // Once: the stall goes on (the line is still up) and it does not repeat.
    await expect.poll(() => simTick(page), { timeout: 40_000 }).toBeGreaterThan(shownBy + 300);
    expect((await captions(page)).filter((c) => c === HINT)).toHaveLength(1);
    expect((await storesLine(page))?.color).toBe(STORES_CAPPED_CSS);
  });

  test('a larder with room: the queen waits for food, the line is no warning, and no hint', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootStorageSave(page, 'room');
    // The reserve, 14.8 food, reads 15; the larder could hold it.
    await expect
      .poll(() => storesLine(page), { timeout: 10_000 })
      .toEqual({
        text: expect.stringMatching(/^Waiting for stores: \d+\/15$/),
        color: STORES_WAITING_CSS,
      });
    await expect.poll(() => simTick(page), { timeout: 60_000 }).toBeGreaterThan(3 * DWELL_TICKS);
    const shown = await captions(page);
    expect(shown.filter((c) => c.includes('Food Storage'))).toEqual([]);
    expect((await storesLine(page))?.color).toBe(STORES_WAITING_CSS);
  });

  test("the line's strip takes clicks, drags and the wheel off the world; hidden, it is world", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Up (the 'plain' stall): a click, a drag and a wheel notch on the strip issue no
    // command and leave the camera where it was.
    await bootStorageSave(page, 'plain');
    await expect.poll(() => storesLine(page), { timeout: 10_000 }).not.toBeNull();
    const strip = (await storesLineDrawn(page))!.rect;
    const camUp = await surfaceCamera(page);
    await clickCanvasRect(page, strip);
    await dragFrom(page, strip);
    await wheelAt(page, strip);
    const t0 = await simTick(page);
    await expect.poll(() => simTick(page), { timeout: 20_000 }).toBeGreaterThan(t0 + 20);
    expect(await playerRally(page)).toBeNull();
    expect(await surfaceCamera(page)).toEqual(camUp);
    const shownUp = await captions(page);
    expect(shownUp).not.toContain(RALLY_TEXT);
    expect(shownUp).not.toContain(FOOD_MARK_TEXT);
    // Hidden (the same world with no Nursery: the queen is not held back), the same
    // spot is world. The click is a Command tap there: a rally on empty ground (what
    // lies under the strip in this world), or a food mark on a pile.
    await bootStorageSave(page, 'hidden');
    const tHidden = await simTick(page);
    await expect.poll(() => simTick(page), { timeout: 20_000 }).toBeGreaterThan(tHidden + 5);
    expect(await storesLine(page)).toBeNull();
    expect(await surfaceCamera(page)).toEqual(camUp);
    await clickCanvasRect(page, strip);
    await expect
      .poll(
        async () =>
          (await playerRally(page)) !== null || (await captions(page)).includes(FOOD_MARK_TEXT),
        { timeout: 20_000 },
      )
      .toBe(true);
    // The drag pans: down 60 px moves the camera up (the camera sits on the world's
    // left edge, so the rightward part is clamped away; centerY is not).
    const camBeforeDrag = await surfaceCamera(page);
    await dragFrom(page, strip);
    await expect
      .poll(async () => (await surfaceCamera(page)).centerY, { timeout: 10_000 })
      .not.toBe(camBeforeDrag.centerY);
    // The wheel zooms.
    const camBeforeWheel = await surfaceCamera(page);
    await wheelAt(page, strip);
    await expect
      .poll(async () => (await surfaceCamera(page)).zoom, { timeout: 10_000 })
      .not.toBe(camBeforeWheel.zoom);
  });
});
