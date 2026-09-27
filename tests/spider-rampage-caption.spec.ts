// spider-rampage-caption.spec.ts — #350: the spider-rampage warning still reaches
// the player in a real browser now that it is owed (shown once the caption queue
// is idle) instead of shown straight from the spider_rampage_start event.
//
// The queue policy itself (a busy queue defers the warning, a one-shot arriving
// next keeps its slot, a stale warning is dropped) is pinned in
// src/render/recurring-captions.test.ts. What only a browser proves is the
// GameScene wiring: the event marks the warning owed and the per-frame offer
// actually displays it. (It does not tell the owed path from the old direct
// show; that difference is the queue policy the unit tests pin.)
//
// Setup, without touching a running sim: the page builds a normal scenario from
// the Vite dev server, moves it past the spider's grace window, makes the spider
// starving with its telegraphed density hunt on cooldown, and saves it through
// the real save path (manualSave). With no ant in chase range of the lair (true
// for seed 7 at the start) and the hunt on cooldown, a hungry Patrolling
// spider's only move is to camp an entrance (spider.ts: Rampaging), so the first
// tick emits spider_rampage_start. Should it then divert to chase an ant, the
// warning stays owed (the spider is still hunting). A reload boots the save
// through Continue.

import { test, expect, type Page } from '@playwright/test';
import { clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';

const RAMPAGE_TEXT = 'The spider has gone hungry and is hunting on the surface.';

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: { getCaptionsShown?: () => string[] } })
      .__phase9_test;
    return t?.getCaptionsShown?.() ?? [];
  });
}

async function seedRampageSave(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Paths are served by the Vite dev server (Playwright always runs it).
    const scenarioPath = '/src/sim/scenario.ts';
    const savePath = '/src/platform/save.ts';
    const constantsPath = '/src/sim/constants.ts';
    type Spider = {
      state: string;
      hungerTicks: number;
      nextHuntTick: number;
    };
    type World = {
      tick: number;
      spider: Spider | null;
      ants: { alive: Uint8Array; lastMealTick: Int32Array };
    };
    const scenario = (await import(/* @vite-ignore */ scenarioPath)) as {
      createScenario: (seed: number, d: 'Easy' | 'Normal' | 'Hard') => World;
    };
    const save = (await import(/* @vite-ignore */ savePath)) as {
      manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
    };
    const k = (await import(/* @vite-ignore */ constantsPath)) as {
      SPIDER_GRACE_TICKS: number;
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
    if (!(await save.manualSave(7, [], w))) throw new Error('manualSave failed');
  });
}

test.describe('#350 — spider-rampage warning', () => {
  test('a rampage start shows the warning through the idle-queue gate', async ({ page }) => {
    await page.goto('/');
    await waitForUiHook(page);
    await page.evaluate(() => localStorage.clear());
    await seedRampageSave(page);

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

    await expect.poll(() => captions(page), { timeout: 15_000 }).toContain(RAMPAGE_TEXT);
  });
});
