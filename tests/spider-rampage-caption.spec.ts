// spider-rampage-caption.spec.ts — #350: the spider-rampage warning still reaches
// the player in a real browser now that it is owed (shown once the caption queue
// is idle) instead of shown straight from the spider_rampage_start event.
//
// The queue policy itself (a busy queue defers the warning, a one-shot arriving
// next keeps its slot, a stale warning is dropped) is pinned in
// src/render/recurring-captions.test.ts. What only a browser proves is the
// GameScene wiring: the event marks the warning owed and the per-frame offer
// actually displays it, and, with a caption already showing, a one-shot raised
// in the same frame shows BEFORE the warning (see seedRampageSave). That second
// case fails if GameScene shows the warning straight from the event again.
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
 *   2. the tick applies the spider priority and the spider starts its rampage;
 *   3. consumeEventsForRender handles spider_rampage_start;
 *   4. checkQueenStatusForEffects raises the one-shot 'spiderPriority' caption.
 * With the fix, step 3 only owes the warning, so the one-shot takes the pending
 * slot and the warning shows after it. A direct show at step 3 would take the
 * pending slot, and the one-shot would be dropped until the queue drained,
 * showing after the warning.
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
    };
    type World = {
      tick: number;
      commandQueue: unknown[];
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
      PLAYER_COLONY_ID: number;
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

/** Seed the save, reload, and Continue into it. */
async function bootRampageSave(page: Page, busyQueue: boolean): Promise<void> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  await seedRampageSave(page, busyQueue);

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

test.describe('#350 — spider-rampage warning', () => {
  test('a rampage start shows the warning through the idle-queue gate', async ({ page }) => {
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
