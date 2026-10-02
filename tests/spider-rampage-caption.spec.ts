// spider-rampage-caption.spec.ts — #350: the spider-rampage warning reaches the
// player in a real browser while it is owed (shown once the caption queue is
// idle), not shown straight away. #397: it is owed from world state — while the
// rampage threatens the player's colony — and shown once per hungry spell, not
// on every spider_rampage_start.
//
// The queue policy itself (a busy queue defers the warning, a one-shot arriving
// next keeps its slot, a stale warning is dropped) and the once-per-spell rule
// are pinned in src/render/recurring-captions.test.ts. What only a browser proves
// is the GameScene wiring: the threat check marks the warning owed and the
// per-frame offer actually displays it, and, with a caption already showing, a
// one-shot raised in the same frame shows BEFORE the warning (see
// seedRampageSave). That second case fails if the warning is shown from the
// event loop, before the frame's one-shots, as before #350 (the idle gate itself
// is pinned in recurring-captions.test.ts). The #397 case (seedRestartSave)
// fails if a rampage start owes the warning again.
//
// Setup, without touching a running sim: the page builds a normal scenario from
// the Vite dev server, moves it past the spider's grace window, makes the spider
// starving with its telegraphed density hunt on cooldown, and saves it through
// the real save path (manualSave). With no ant in chase range of the lair (true
// for seed 7 at the start) and the hunt on cooldown, a hungry Patrolling
// spider's only move is to camp an entrance (spider.ts: Rampaging), from the
// first tick. Which entrance is pinned, not left to the 60/40 colony pick: the
// save marks the enemy's door as the one its last rampage timed out at, so the
// V54 rotation sends it to the player's door. From that tick the rampage
// threatens the player, and the warning is owed. Should the spider then divert
// to chase an ant, the warning stays owed (it is still hunting). A reload boots
// the save through Continue.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';
import { RAMPAGE_CAPTION_OWED_TICKS } from '../src/render/recurring-captions.js';

const RAMPAGE_TEXT = 'The spider has gone hungry and is hunting on the surface.';
const DIG_TEXT = 'Your workers will excavate the marked tile.';
const SPIDER_PRIORITY_TEXT = 'Your fighters are engaging the spider.';

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: { getCaptionsShown?: () => string[] } })
      .__phase9_test;
    return t?.getCaptionsShown?.() ?? [];
  });
}

/**
 * Seed the rampage save. With `busyQueue`, the save's command queue also holds a
 * player MarkDigTile and a MarkSpiderPriority. The platform loop drains them
 * before the first tick, so the first frame goes, in order:
 *   1. the one-shot 'dig' caption (onAfterDrain) starts showing;
 *   2. the tick applies the spider priority and the spider starts its rampage,
 *      on the player's door;
 *   3. checkQueenStatusForEffects raises the one-shot 'spiderPriority' caption,
 *      and the rampage warning is owed (the rampage threatens the player: by
 *      beforeSimTick if the frame ran another tick, else here) and offered only
 *      after it.
 * The warning only enters an idle queue, so the one-shot keeps the pending slot
 * and the warning shows after it. Shown straight away (as before #350, from the
 * spider_rampage_start event, which GameScene handles before step 3) it would
 * take the pending slot, and the one-shot would be dropped until the queue
 * drained, showing after the warning.
 */
async function seedRampageSave(page: Page, busyQueue: boolean): Promise<void> {
  await page.evaluate(async (busyQueue: boolean) => {
    // Paths are served by the Vite dev server (Playwright always runs it).
    const scenarioPath = '/src/sim/scenario.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    type Spider = {
      state: string;
      hungerTicks: number;
      nextHuntTick: number;
      rampageRotationEntranceId: number;
      rampageRotationTick: number;
    };
    type World = {
      tick: number;
      commandQueue: unknown[];
      spider: Spider | null;
      ants: { alive: Uint8Array; lastMealTick: Int32Array };
      colonies: Record<number, { entrances: { entranceId: number }[] }>;
    };
    const scenario = (await import(/* @vite-ignore */ scenarioPath)) as {
      createScenario: (seed: number, d: 'Easy' | 'Normal' | 'Hard') => World;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      SPIDER_GRACE_TICKS: number;
      PLAYER_COLONY_ID: number;
      ENEMY_COLONY_ID: number;
    };
    const w = scenario.createScenario(7, 'Normal');
    if (w.spider === null) throw new Error('scenario has no spider');
    // Move the round to the end of the spider's grace window. Every meal tick
    // moves with it, or the save validator rejects the fed ants as starved.
    w.tick = k.SPIDER_GRACE_TICKS;
    for (let i = 0; i < w.ants.alive.length; i++) {
      if (w.ants.alive[i] === 1) w.ants.lastMealTick[i]! += k.SPIDER_GRACE_TICKS;
    }
    w.spider.state = 'Patrolling';
    w.spider.hungerTicks = 1_000_000;
    w.spider.nextHuntTick = 2_000_000_000; // density hunt on cooldown
    // Its last rampage timed out at the enemy's door (seed 7: one door each), so
    // it rotates (V54) to the next open entrance, wrapping: the player's.
    w.spider.rampageRotationEntranceId = w.colonies[k.ENEMY_COLONY_ID]!.entrances[0]!.entranceId;
    w.spider.rampageRotationTick = w.tick;
    if (busyQueue) {
      const colonyId = k.PLAYER_COLONY_ID;
      w.commandQueue.push(
        { type: 'MarkDigTile', colonyId, tileX: 10, tileY: 10, issuedAtTick: w.tick },
        { type: 'MarkSpiderPriority', colonyId, isPriority: true, issuedAtTick: w.tick },
      );
    }
    if (!(await save.manualSave(7, [], w))) throw new Error('manualSave failed');
  }, busyQueue);
}

/** Seed the save (`seed`), reload, and Continue into it. Returns what `seed` did. */
async function bootSave<T>(page: Page, seed: () => Promise<T>): Promise<T> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  const seeded = await seed();

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

const bootRampageSave = (page: Page, busyQueue: boolean): Promise<void> =>
  bootSave(page, () => seedRampageSave(page, busyQueue));

interface Spider {
  state: string;
  hungerTicks: number;
  rampageStartTick: number;
  rampageTargetColonyId: number;
  rampageEntranceId: number;
}
interface TestHook {
  getTick?: () => number;
  getSpider?: () => Spider | null;
  getRampageWarningTicks?: () => number[];
}
type Win = Window & { __phase9_test?: TestHook };
const tick = (page: Page) => page.evaluate(() => (window as Win).__phase9_test?.getTick?.() ?? -1);
const spider = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getSpider?.() ?? null);
const warningTicks = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getRampageWarningTicks?.() ?? []);

/** Ticks from the load until the seeded rampage times out. */
const TIMEOUT_IN = 100;

interface RestartSeed {
  /** The seeded rampage's start tick, and the entrance it camps (the player's
   *  second door) and the one it rotates to next (the player's first door). */
  firstStart: number;
  campedId: number;
  nextId: number;
  playerColonyId: number;
}

/**
 * #397 — a seed-7 round past the spider's grace, with no workers (nothing for the
 * spider to eat) and no AI, the player given a second open entrance at (10, 62)
 * (the highest entrance id). The spider, starving, is camping that second door on
 * a rampage that times out TIMEOUT_IN ticks after the load. It then rotates (V54)
 * to the next open entrance by id, wrapping: the player's first door at (24, 64),
 * 16 tiles away — a new rampage start, threatening the player all the way, in the
 * same hungry spell. Under #350 that start showed the warning a second time.
 */
async function seedRestartSave(page: Page): Promise<RestartSeed> {
  return await page.evaluate(async (timeoutIn: number) => {
    const scenarioPath = '/src/sim/scenario.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    const typesPath = '/src/sim/types.ts';
    const terrainPath = '/src/sim/terrain.ts';
    const deathPath = '/src/sim/ant-death.ts';
    type Entrance = {
      entranceId: number;
      surfaceTileX: number;
      surfaceTileY: number;
      isOpen: boolean;
    };
    type World = {
      tick: number;
      aiState: unknown[];
      undergroundGrids: Record<number, unknown>;
      colonies: Record<number, { workers: number[]; entrances: Entrance[] }>;
      ants: { alive: Uint8Array; lastMealTick: Int32Array };
      spider: Record<string, number | string> | null;
    };
    const scenario = (await import(/* @vite-ignore */ scenarioPath)) as {
      createScenario: (seed: number, d: 'Easy' | 'Normal' | 'Hard') => World;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      SPIDER_GRACE_TICKS: number;
      SPIDER_RAMPAGE_MAX_TICKS: number;
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
    const death = (await import(/* @vite-ignore */ deathPath)) as {
      despawnAnt: (w: unknown, id: number, o: { cause: string }) => void;
    };
    const P = k.PLAYER_COLONY_ID;
    const w = scenario.createScenario(7, 'Normal');
    w.aiState = [];
    for (const cid of [P, k.ENEMY_COLONY_ID]) {
      for (const id of [...w.colonies[cid]!.workers]) {
        death.despawnAnt(w, id, { cause: 'starvation' });
      }
    }
    // Past the grace window. Every meal tick moves with the round, or the save
    // validator rejects the fed ants (the queens) as starved.
    w.tick = k.SPIDER_GRACE_TICKS + 100;
    for (let i = 0; i < w.ants.alive.length; i++) {
      if (w.ants.alive[i] === 1) w.ants.lastMealTick[i]! += w.tick;
    }
    // The second door (shaft rows 0..1 dug; its surface clearance halo is all
    // walkable, as the save validator requires).
    const grid = w.undergroundGrids[P];
    terrain.ugSet(grid, 10, 0, terrain.UndergroundTileState.Open);
    terrain.ugSet(grid, 10, 1, terrain.UndergroundTileState.Open);
    const second: Entrance = {
      entranceId: types.allocateEntityId(w),
      surfaceTileX: 10,
      surfaceTileY: 62,
      isOpen: true,
    };
    const first = w.colonies[P]!.entrances[0]!;
    w.colonies[P]!.entrances.push(second);
    const sp = w.spider;
    if (sp === null) throw new Error('scenario has no spider');
    const firstStart = w.tick - k.SPIDER_RAMPAGE_MAX_TICKS + timeoutIn;
    Object.assign(sp, {
      state: 'Rampaging',
      posX: (second.surfaceTileX << 8) + 128,
      posY: (second.surfaceTileY << 8) + 128,
      hungerTicks: 1_000_000,
      nextHuntTick: 2_000_000_000, // density hunt on cooldown
      rampageTargetColonyId: P,
      rampageEntranceId: second.entranceId,
      rampageStartTick: firstStart,
      rampageKillsThisRampage: 0,
    });
    if (!(await save.manualSave(7, [], w))) throw new Error('manualSave failed');
    return {
      firstStart,
      campedId: second.entranceId,
      nextId: first.entranceId,
      playerColonyId: P,
    };
  }, TIMEOUT_IN);
}

test.describe('#350 — spider-rampage warning', () => {
  test('a rampage threatening the player shows the warning through the idle-queue gate', async ({
    page,
  }) => {
    await bootRampageSave(page, false);
    await expect.poll(() => captions(page), { timeout: 15_000 }).toContain(RAMPAGE_TEXT);
  });

  test('behind a busy queue, the warning waits and the one-shot after it keeps its slot', async ({
    page,
  }) => {
    await bootRampageSave(page, true);
    // Wait for both, so a wrong order fails on the order, not on a timeout.
    await expect
      .poll(() => captions(page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([RAMPAGE_TEXT, SPIDER_PRIORITY_TEXT]));
    const shown = await captions(page);
    expect(shown.slice(0, 3)).toEqual([DIG_TEXT, SPIDER_PRIORITY_TEXT, RAMPAGE_TEXT]);
  });
});

test.describe('#397 — the rampage warning, once per hungry spell', () => {
  test("a rampage that restarts at another of the player's doors is not announced again", async ({
    page,
  }) => {
    test.setTimeout(90_000); // about 16 s of game time at 1x, plus boot
    const seed = await bootSave(page, () => seedRestartSave(page));
    // The seeded rampage threatens the player: the warning shows on its own,
    // before any rampage start.
    await expect.poll(() => warningTicks(page), { timeout: 15_000 }).toHaveLength(1);
    await page.screenshot({ path: 'test-results/rampage-warning-shown.png' });
    // It times out and the spider rotates to the player's other door: a new
    // rampage, in the same hungry spell.
    await expect
      .poll(async () => (await spider(page))?.rampageStartTick ?? -1, { timeout: 30_000 })
      .toBeGreaterThan(seed.firstStart);
    const restarted = (await spider(page))!;
    expect(restarted).toMatchObject({
      rampageTargetColonyId: seed.playerColonyId,
      rampageEntranceId: seed.nextId,
    });
    expect(restarted.rampageEntranceId).not.toBe(seed.campedId);
    // Long enough for a warning owed at that start to have shown or gone stale.
    const restart = restarted.rampageStartTick;
    await expect
      .poll(() => tick(page), { timeout: 30_000 })
      .toBeGreaterThan(restart + RAMPAGE_CAPTION_OWED_TICKS + 20);
    // No meal since (a meal resets hunger to 0): still the one hungry spell.
    expect((await spider(page))!.hungerTicks).toBeGreaterThan(restarted.hungerTicks);
    // Shown once, before the restart.
    const shownAt = await warningTicks(page);
    expect(shownAt).toHaveLength(1);
    expect(shownAt[0]!).toBeLessThan(restart);
    expect((await captions(page)).filter((c) => c === RAMPAGE_TEXT)).toEqual([RAMPAGE_TEXT]);
    await page.screenshot({ path: 'test-results/rampage-warning-once.png' });
  });
});
