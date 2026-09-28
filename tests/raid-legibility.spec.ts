// raid-legibility.spec.ts — #290 PR 6: a player rally on an AI entrance moves food,
// and the player is told so, in a real browser.
//
// The raid itself is pinned in the sim tests (raiding.test.ts, raid-replay.test.ts);
// what only a browser proves is the whole loop the player sees: a rally issued
// through the input layer's enqueue reaches the sim, the player's fighters in the
// enemy nest take food from its larder (the colony's stolen counter rises), and the
// rally-on-an-enemy-entrance and "raiding" captions actually display.
//
// Setup, without touching a running sim: the page imports the sim's raid fixture
// (src/sim/raid-test-utils.ts — two dug-out nests, the enemy's larder stocked, no
// spider, no starting workers) straight from the Vite dev server, adds two player
// fighters beside the enemy larder, and saves it through the real save path
// (manualSave). A reload then boots it through the real Continue → load path. The
// rally is issued with __phase9_test.rallyPlayerAt, which calls the same
// handleSetRallyPoint the surface Command tap does.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';

interface RaidStats {
  foodRaidedFp: number;
  foodLostToRaidsFp: number;
  raidTrips: number;
  foodTotalFp: number;
}

interface TestHook {
  getCaptionsShown?: () => string[];
  getPlayerRaidStats?: () => RaidStats | null;
  rallyPlayerAt?: (x: number, y: number) => boolean;
  getTick?: () => number;
}

async function raidStats(page: Page): Promise<RaidStats | null> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    return t?.getPlayerRaidStats?.() ?? null;
  });
}

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    return t?.getCaptionsShown?.() ?? [];
  });
}

/** Build the raid world in the page and store it as the save. Returns the enemy door. */
async function seedRaidSave(page: Page): Promise<{ x: number; y: number }> {
  return await page.evaluate(async () => {
    // Paths are served by the Vite dev server (Playwright always runs it).
    const utilsPath = '/src/sim/raid-test-utils.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    type RaidMod = {
      raidWorld: (fp: number) => {
        world: unknown;
        enemyDoor: { x: number; y: number };
      };
      addFighter: (w: unknown, c: number, x: number, y: number, g: number | null) => number;
    };
    const utils = (await import(/* @vite-ignore */ utilsPath)) as RaidMod;
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      PLAYER_COLONY_ID: number;
      ENEMY_COLONY_ID: number;
    };
    // 5000 fp: a full load several times over, under the 5120 fp chamber cap the
    // save validator enforces.
    const r = utils.raidWorld(5000);
    // Two player fighters in the enemy nest's row-6 tunnel, just past its larder
    // (x 86..89); the enemy queen is 25+ tiles off, so nothing hostile is in reach.
    utils.addFighter(r.world, k.PLAYER_COLONY_ID, 91, 6, k.ENEMY_COLONY_ID);
    utils.addFighter(r.world, k.PLAYER_COLONY_ID, 92, 6, k.ENEMY_COLONY_ID);
    if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
    return r.enemyDoor;
  });
}

test.describe('#290 PR 6 — raid legibility', () => {
  test('a player rally on the AI entrance: fighters loot its larder, and the captions say so', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForUiHook(page);
    await page.evaluate(() => localStorage.clear());
    const door = await seedRaidSave(page);

    await page.reload();
    await waitForUiHook(page);
    // The seeded save puts up the Continue / New Game prompt: Continue loads it.
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

    const before = await raidStats(page);
    expect(before).not.toBeNull();
    expect(before!.foodRaidedFp).toBe(0);

    const accepted = await page.evaluate(
      ({ x, y }) => {
        const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
        return t?.rallyPlayerAt?.(x, y) ?? false;
      },
      { x: door.x, y: door.y },
    );
    expect(accepted).toBe(true);

    // The rally caption names the raid (not the generic "Fighters will converge here."):
    // from V60 (#352) it names the raid order, Loot for a plain rally.
    await expect
      .poll(() => captions(page), { timeout: 10_000 })
      .toContainEqual(expect.stringMatching(/^Raiding: Loot\. /));
    // Food moves: the player's stolen counter rises as a fighter takes a load...
    await expect
      .poll(async () => (await raidStats(page))?.foodRaidedFp ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // ...and the player is told the fighters are raiding.
    await expect
      .poll(() => captions(page), { timeout: 10_000 })
      .toContain('Your fighters are raiding the enemy larder.');
  });
});
