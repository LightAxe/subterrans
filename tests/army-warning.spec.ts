// army-warning.spec.ts — #394: an enemy army marching on one of the player's
// entrances raises the army warning early in the march, once, naming the
// entrance, and the minimap ring follows the army as it marches — in a real
// browser.
//
// The detection, the hysteresis (once per wave, every wave), the entrance aim and
// CLNY-08 are pinned in src/render/enemy-march.test.ts,
// src/render/enemy-gathering.test.ts and src/render/army-warning.test.ts, and the ring's draw calls in
// src/render/minimap.test.ts. What only a browser proves is the wiring: GameScene
// feeds the march history and runs the warning each frame, the caption queue shows
// it, and UIScene rings the moving army on the minimap.
//
// Setup, without touching a running sim: the page imports the sim's raid fixture
// (src/sim/raid-test-utils.ts — two dug-out nests, no spider, no AI state, no
// starting workers) from the Vite dev server, gives the player a second open
// entrance west of its door (so the door at x 24 is the "east" one), puts eight
// enemy fighters on the surface far down the map to the south-east — about 72
// tiles from that door and 50 from their own (off the line between the nests, so
// they start further out than an army can stand on it without being at home, on a
// route that stays clear of their own door: all eight read as marching the whole
// way) — rallies the enemy just short of the door so they march at it,
// and saves through the real save path (manualSave). A reload boots it through
// Continue. No AI operation launches them (no invasion_start): this is the march
// reading's own path, as for a human opponent's army — an invasion the AI
// launches is warned of at its launch (the fallback case below).
//
// No wall-clock assertions: how early the warning came is read from the dev-only
// army warning log (the march's distance from the door on the tick the caption
// queue took it), and how long it held from UIScene's caption hold log.
//
// The fallback case (#404 review, seedNearDoorSave): an invasion of a player door
// opened by the enemy nest, which neither reading can see (its army counts as at
// home all the way there), is warned of as the AI launches it — the GameScene
// event wiring (invasion_start → noteArmyWarningEvent) that only a browser runs.
// And the same invasion saved after its launch is warned of as the save loads —
// the boot wiring (finishBoot → noteInvasionUnderWay), since saves keep no events.
//
// Screenshots (for a human eye; not compared): test-results/army-warning-*.png.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { MINIMAP_RECT, SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';
import { ARMY_CAPTION_HOLD_MS } from '../src/render/army-warning.js';
import { GATHER_RADIUS_TILES } from '../src/render/enemy-gathering.js';
import { MINIMAP_RING_MAX_R, MINIMAP_RING_MIN_R } from '../src/render/minimap.js';
import { MAX_CATCHUP_TICKS } from '../src/platform/game-loop.js';

const WARNING = 'An enemy army is marching on your east entrance. Train fighters and rally there.';

const MM = MINIMAP_RECT;
const MM_SCALE = MINIMAP_RECT.w / 128;
// Where the army starts (tiles) and the enemy rally it marches to — see seedMarchSave.
const ARMY = { x0: 80, y0: 108 };
const RALLY = { tileX: 30, tileY: 64 };
const DOOR = { tileX: 24, tileY: 64 };

interface March {
  fighters: number;
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
  entranceTileX: number;
  entranceTileY: number;
}

interface TestHook {
  getCaptionsShown?: () => string[];
  getCaptionHolds?: () => { text: string; holdMs: number; yielded: boolean }[];
  getArmyWarningLog?: () => {
    tick: number;
    owedTick: number;
    text: string;
    marching: number;
    marchDistanceTiles: number | null;
  }[];
  getEnemyMarch?: () => March | null;
  isPaused?: () => boolean;
  getTick?: () => number;
  sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
}

/** The dev-only test seam (window.__phase9_test), read inside the page. */
type Win = Window & { __phase9_test?: TestHook };

const captions = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getCaptionsShown?.() ?? []);
const march = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getEnemyMarch?.() ?? null);
const warningLog = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getArmyWarningLog?.() ?? []);
const paused = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.isPaused?.() ?? false);
const tick = (page: Page) => page.evaluate(() => (window as Win).__phase9_test?.getTick?.() ?? -1);

/** The recorded hold of the warning, once its hold has ended. */
async function warningHold(page: Page): Promise<{ holdMs: number; yielded: boolean } | null> {
  const holds = await page.evaluate(() => (window as Win).__phase9_test?.getCaptionHolds?.() ?? []);
  const h = holds.find((c) => c.text === WARNING);
  return h === undefined ? null : { holdMs: h.holdMs, yielded: h.yielded };
}

async function sample(page: Page, x: number, y: number, w: number, h: number): Promise<number[]> {
  return await page.evaluate(
    async ({ x, y, w, h }) => {
      const t = (window as Win).__phase9_test;
      if (t?.sampleArea === undefined) throw new Error('no sampleArea hook');
      return await t.sampleArea(x, y, w, h);
    },
    { x, y, w, h },
  );
}

/** True iff an RGBA pixel is the ring's red (at any point of its alpha pulse,
 *  over its dark halo) — not the pale ground, the white viewport or a nest marker. */
function reddish(px: number[], i: number): boolean {
  const r = px[i]!;
  return r >= 120 && r >= 2 * px[i + 1]! && r >= 2 * px[i + 2]!;
}

/**
 * The ring round `m` on the minimap: red pixels on the row through the ring's
 * centre, on both sides, where the ring is drawn — half the box's diagonal on the
 * minimap plus 4 px, clamped to MINIMAP_RING_MIN_R..MINIMAP_RING_MAX_R, pulsing up
 * to 2 px wider, its stroke 2 px. That is outside the box on that row, so the
 * army's own dots (also red) are not mistaken for it.
 */
async function ringAround(page: Page, m: March): Promise<boolean> {
  const cx = Math.round(MM.x + ((m.minTileX + m.maxTileX) / 2) * MM_SCALE);
  const cy = Math.round(MM.y + ((m.minTileY + m.maxTileY) / 2) * MM_SCALE);
  const diag = Math.hypot(
    (m.maxTileX - m.minTileX) * MM_SCALE,
    (m.maxTileY - m.minTileY) * MM_SCALE,
  );
  const base = Math.min(Math.max(diag / 2 + 4, MINIMAP_RING_MIN_R), MINIMAP_RING_MAX_R);
  const lo = Math.floor(base - 2);
  const hi = Math.ceil(base + 4);
  const px = await sample(page, cx - hi, cy, 2 * hi + 1, 1);
  let left = false;
  let right = false;
  for (let dx = -hi; dx <= hi; dx++) {
    if (Math.abs(dx) < lo) continue;
    if (!reddish(px, (dx + hi) * 4)) continue;
    if (dx < 0) left = true;
    else right = true;
  }
  return left && right;
}

async function setPaused(page: Page, want: boolean): Promise<void> {
  if ((await paused(page)) === want) return;
  await page.locator('canvas').first().focus();
  await page.keyboard.press('Space');
  await expect.poll(() => paused(page)).toBe(want);
}

async function seedMarchSave(page: Page): Promise<void> {
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
      // Eight enemy fighters on the surface, about 72 tiles south-east of the x-24
      // door (and 50 from their own), rallied 6 tiles short of it: they march at it.
      for (let i = 0; i < 8; i++) {
        utils.addFighter(r.world, k.ENEMY_COLONY_ID, army.x0 + (i % 4), army.y0 + (i >> 2), null);
      }
      r.enemy.rallyPoint = { tileX: rally.tileX, tileY: rally.tileY };
      if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
    },
    { army: ARMY, rally: RALLY },
  );
}

async function bootMarchSave(page: Page): Promise<void> {
  await bootSave(page, seedMarchSave);
}

/** The player's door opened 8 tiles from the enemy's door (104, 64). */
const NEAR = { tileX: 96, tileY: 64 };
const NEAR_WARNING =
  'An enemy army is marching on your east entrance. Train fighters and rally there.';

/**
 * #404 review — the raid fixture with a second player door at NEAR, by the enemy
 * nest, and the enemy AI set to invade it: its AI state is Invading with no cohort
 * committed yet and NEAR as the last probe's target, and 12 of its fighters stand at
 * home (within GATHER_HOME_RADIUS_TILES of their door). On its first tick the AI
 * controller commits them against NEAR (StartAIOperation → invasion_start); they
 * are inside within a few seconds, read neither as a march nor as a gathering.
 */
async function seedNearDoorSave(page: Page, launched = false): Promise<number> {
  return await page.evaluate(
    async ({ near, launched }) => {
      const utilsPath = '/src/sim/raid-test-utils.ts';
      const savePath = '/src/platform/save.ts';
      const constantsPath = '/src/sim/constants.ts';
      const typesPath = '/src/sim/types.ts';
      const terrainPath = '/src/sim/terrain.ts';
      const aiPath = '/src/sim/ai-state.ts';
      type Colony = {
        entrances: {
          entranceId: number;
          surfaceTileX: number;
          surfaceTileY: number;
          isOpen: boolean;
        }[];
      };
      type World = { tick: number; aiState: unknown[]; undergroundGrids: Record<number, unknown> };
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
      const ai = (await import(/* @vite-ignore */ aiPath)) as {
        createDefaultAIStateRecord: (cid: number) => Record<string, unknown>;
        invasionFighterNeed: (w: unknown, rec: unknown) => number;
      };
      const r = utils.raidWorld(3000);
      const grid = r.world.undergroundGrids[k.PLAYER_COLONY_ID];
      terrain.ugSet(grid, near.tileX, 0, terrain.UndergroundTileState.Open);
      terrain.ugSet(grid, near.tileX, 1, terrain.UndergroundTileState.Open);
      r.player.entrances.push({
        entranceId: types.allocateEntityId(r.world),
        surfaceTileX: near.tileX,
        surfaceTileY: near.tileY,
        isOpen: true,
      });
      const state = ai.createDefaultAIStateRecord(k.ENEMY_COLONY_ID);
      state.state = 'Invading';
      state.enteredTick = r.world.tick;
      state.invasionStartTick = r.world.tick;
      state.operationTargetTileX = near.tileX;
      state.operationTargetTileY = near.tileY;
      r.world.aiState.push(state);
      const ids: number[] = [];
      // At least the colony's need (#426, V75: below it nothing launches), and no fewer
      // than the 12 this fixture always had.
      const n = Math.max(12, ai.invasionFighterNeed(r.world, state));
      for (let i = 0; i < n; i++) {
        ids.push(utils.addFighter(r.world, k.ENEMY_COLONY_ID, 100 + (i % 4), 58 + (i >> 2), null));
      }
      if (launched) {
        // Taken after the launch: the cohort committed on the save's tick (the save
        // keeps the operation, not the invasion_start event).
        state.operationKind = 'Invasion';
        state.operationStartTick = r.world.tick;
        state.invasionRallyTileX = near.tileX;
        state.invasionRallyTileY = near.tileY;
        const cohort = state.operationFighterIds as Int32Array;
        ids.forEach((id, i) => (cohort[i] = id));
        state.operationFighterCount = ids.length;
        state.operationStartFighterCount = ids.length;
      }
      if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
      return r.world.tick;
    },
    { near: NEAR, launched },
  );
}

/** Seed a save with `seed`, reload, and Continue into it. Returns what `seed` did. */
async function bootSave<T>(page: Page, seed: (page: Page) => Promise<T>): Promise<T> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  const seeded = await seed(page);
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
  return seeded;
}

test.describe('#394 — an enemy army marching on an entrance', () => {
  test('warns early in the march, once, naming the entrance; the minimap ring follows the army', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootMarchSave(page);

    // The warning shows and names the east entrance.
    await expect
      .poll(() => captions(page), { timeout: 20_000, intervals: [50] })
      .toContain(WARNING);
    const box = await page.locator('canvas').first().boundingBox();
    if (!box) throw new Error('no canvas');

    // It came early in the march: on the tick the caption queue took it, the
    // marching army was still at least 30 tiles (3 s at a fighter's 0.5 tile a
    // tick) from the door it named. It started about 72 out and needs a second or
    // so of heading.
    const [entry] = await warningLog(page);
    expect(entry).toBeDefined();
    expect(entry!.text).toBe(WARNING);
    expect(entry!.marching).toBeGreaterThanOrEqual(6);
    expect(entry!.marchDistanceTiles).not.toBeNull();
    expect(entry!.marchDistanceTiles!).toBeGreaterThanOrEqual(30);

    // The ring is round the army where it is, and follows it. Paused at A...
    await setPaused(page, true);
    const a = await march(page);
    expect(a).not.toBeNull();
    expect(a!.entranceTileX).toBe(DOOR.tileX);
    expect(a!.entranceTileY).toBe(DOOR.tileY);
    // Still well out of GATHER_RADIUS_TILES of the door (about 55 tiles off, with
    // some 30 tiles of margin): no gathering to ring, so the ring found below is
    // the march's.
    const ax = Math.max(a!.minTileX - (DOOR.tileX + 0.5), DOOR.tileX + 0.5 - a!.maxTileX, 0);
    const ay = Math.max(a!.minTileY - (DOOR.tileY + 0.5), DOOR.tileY + 0.5 - a!.maxTileY, 0);
    expect(Math.hypot(ax, ay)).toBeGreaterThan(GATHER_RADIUS_TILES);
    expect(await ringAround(page, a!)).toBe(true);
    // For the human eye only (asserts nothing): the caption over the paused game.
    await page.screenshot({ path: 'test-results/army-warning-caption.png', clip: box });
    await page.screenshot({
      path: 'test-results/army-warning-minimap-a.png',
      clip: { x: box.x + MM.x - 8, y: box.y + MM.y - 8, width: MM.w + 16, height: MM.h + 16 },
    });
    // ...then on, until it has marched at least 6 tiles further (7.5 px on the
    // minimap), paused at B.
    await setPaused(page, false);
    await expect
      .poll(async () => (await march(page))?.minTileX ?? Infinity, {
        timeout: 15_000,
        intervals: [50],
      })
      .toBeLessThanOrEqual(a!.minTileX - 6);
    await setPaused(page, true);
    // (B may be inside GATHER_RADIUS_TILES on a slow runner; a ring round a march
    // and a gathering at one door is round both, so it is still round the army.)
    const b = await march(page);
    expect(b).not.toBeNull();
    expect(await ringAround(page, b!)).toBe(true);
    await page.screenshot({
      path: 'test-results/army-warning-minimap-b.png',
      clip: { x: box.x + MM.x - 8, y: box.y + MM.y - 8, width: MM.w + 16, height: MM.h + 16 },
    });
    await setPaused(page, false);

    // It holds long enough to read: ARMY_CAPTION_HOLD_MS at full opacity, and
    // nothing queued behind it made it give way. Read from UIScene's hold log.
    await expect
      .poll(() => warningHold(page), { timeout: 15_000 })
      .toEqual({ holdMs: ARMY_CAPTION_HOLD_MS, yielded: false });

    // Once per wave: the army has reached its rally by the door and stands there
    // 10 s of game time later, the queue long idle — and no second warning (of
    // either kind) has shown.
    const t0 = await tick(page);
    await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(t0 + 200);
    const shown = await captions(page);
    expect(shown.filter((c) => c.startsWith('An enemy army'))).toEqual([WARNING]);
    expect(await warningLog(page)).toHaveLength(1);
  });

  test('an invasion of a door by the enemy nest, which no reading sees, is warned of as it launches', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const saveTick = await bootSave(page, seedNearDoorSave);
    await expect.poll(() => warningLog(page), { timeout: 20_000, intervals: [50] }).toHaveLength(1);
    const [entry] = await warningLog(page);
    // The fallback: no march behind it (the army counts as at home all the way)...
    expect(entry).toMatchObject({ text: NEAR_WARNING, marching: 0, marchDistanceTiles: null });
    // ...owed as the AI launched the invasion on the save's first tick: on the first
    // frame, which may run up to MAX_CATCHUP_TICKS ticks — not at the breach, which
    // its army, 6+ tiles from the door at half a tile a tick, takes over a dozen.
    expect(entry!.owedTick).toBeGreaterThanOrEqual(saveTick);
    expect(entry!.owedTick).toBeLessThanOrEqual(saveTick + MAX_CATCHUP_TICKS + 1);
    // Once per wave: the army walks in and the invasion runs on, 10 s of game time
    // later, with no second warning.
    const t0 = await tick(page);
    await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(t0 + 200);
    expect((await captions(page)).filter((c) => c.startsWith('An enemy army'))).toEqual([
      NEAR_WARNING,
    ]);
    expect(await warningLog(page)).toHaveLength(1);
  });

  test('an invasion a save was taken in the middle of is warned of as the save loads', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // The same invasion, saved 30 ticks after its launch: a save keeps no events, so
    // no invasion_start reaches the warning — GameScene's boot notes the operation.
    const saveTick = await bootSave(page, (p) => seedNearDoorSave(p, true));
    await expect.poll(() => warningLog(page), { timeout: 20_000, intervals: [50] }).toHaveLength(1);
    const [entry] = await warningLog(page);
    expect(entry).toMatchObject({ text: NEAR_WARNING, marching: 0, marchDistanceTiles: null });
    expect(entry!.owedTick).toBeGreaterThanOrEqual(saveTick);
    expect(entry!.owedTick).toBeLessThanOrEqual(saveTick + MAX_CATCHUP_TICKS + 1);
    // Once: 10 s of game time on, with the invasion running, no second warning.
    const t0 = await tick(page);
    await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(t0 + 200);
    expect(await warningLog(page)).toHaveLength(1);
  });
});
