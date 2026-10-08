// counter-attack-caption.spec.ts — playtest 4: once an invasion of the player's
// colony ends in a fighter rout that leaves the attacker's army broken, "Their army
// is broken — strike their nest now! …" reaches the player in a real browser, soon
// after the rout, held long enough to read, and once. With an army too small to win
// (the economy-captions army gate) it says "… train more fighters, then strike …"
// instead.
//
// The trigger (a fighter_rout invasion_end and the same AI step's Invading → Recovery
// transition with the army below the base invasion need; never a timeout, a
// pre-cohort ending or a queen kill), the cooldown, the stale rules and the batching
// invariance are pinned in src/render/counter-attack-caption.test.ts, through the
// sim's own advanceAIState too; the army gate and its follow-up in
// src/render/counter-attack-gate.test.ts. What only a browser proves is the GameScene wiring:
// its event drain hands the rout to the caption, its per-frame step gets the caption
// through UIScene's queue, a long caption on screen gives way to it (the
// recurringOwed flag), and nothing shows it over the end screen.
//
// Setup, without touching a running sim: the page builds the raid world
// (raid-test-utils.ts: two dug-out nests, no spider, no AI, no workers) and puts the
// enemy mid-invasion of the player's door: its AI state is Invading with a cohort of
// three fighters committed. The rout comes from the sim's own path
// (ai-state.ts _checkInvadingToRecovery: fewer than three of the cohort alive), with
// no seam:
//   - 'dead': one of the three has already died, so the save's first tick routs it.
//     The player has COUNTER_ATTACK_READY_FIGHTERS fighters at home, an army ready to
//     strike, so the caption takes its Assault copy;
//   - 'fight': the three are in the player's tunnels beside six player fighters, who
//     kill one about 15 ticks in. GameScene notes the invasion under way as the save
//     loads, so the army warning is on screen by then: the caption waits for it, and
//     it gives way. Six fighters are not an army ready to strike: the caption takes
//     its build-up copy.
// The save goes through the real save path (manualSave); a reload boots it through
// Continue.
//
// Screenshot (for a human eye; not compared): test-results/counter-attack-caption.png.

import { test, expect, type Page } from '@playwright/test';
import { activeOverlay, clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { SAVE_PROMPT_CONTINUE_RECT } from './helpers/geometry.js';
import { CAPTION_FADE_IN_MS } from '../src/render/caption-queue.js';
import {
  COUNTER_ATTACK_BUILD_UP_TEXT,
  COUNTER_ATTACK_CAPTION_HOLD_MS,
  COUNTER_ATTACK_CAPTION_TEXT,
  COUNTER_ATTACK_READY_FIGHTERS,
} from '../src/render/counter-attack-caption.js';

/** Every army warning (army-warning.ts). */
const ARMY_WARNING_PREFIX = 'An enemy army is';

interface CounterAttackCaption {
  owedRoutTick: number | null;
  shown: { routTick: number; tick: number }[];
}

interface TestHook {
  getCaptionsShown?: () => string[];
  getCaptionHolds?: () => { text: string; holdMs: number; yielded: boolean }[];
  getCaptionQueue?: () => { active: string | null; pending: string | null };
  getCounterAttackCaption?: () => CounterAttackCaption;
  freezeCaptionClock?: (frozen: boolean) => void;
  advanceCaptionClock?: (ms: number) => void;
  forceGameOver?: (outcome?: 'Victory' | 'Defeat' | 'MutualDestruction') => void;
  getTick?: () => number;
}

/** The dev-only test seam (window.__phase9_test), read inside the page. */
type Win = Window & { __phase9_test?: TestHook };

const captions = (page: Page) =>
  page.evaluate(() => (window as Win).__phase9_test?.getCaptionsShown?.() ?? []);
const counter = (page: Page) =>
  page.evaluate(
    (): CounterAttackCaption =>
      (window as Win).__phase9_test?.getCounterAttackCaption?.() ?? {
        owedRoutTick: null,
        shown: [],
      },
  );
const captionQueue = (page: Page) =>
  page.evaluate(() => {
    const q = (window as Win).__phase9_test?.getCaptionQueue?.();
    return { active: q?.active ?? null, pending: q?.pending ?? null };
  });
const tick = (page: Page) => page.evaluate(() => (window as Win).__phase9_test?.getTick?.() ?? -1);

async function freezeCaptionClock(page: Page, frozen: boolean): Promise<void> {
  await page.evaluate((f: boolean) => {
    const t = (window as Win).__phase9_test;
    if (t?.freezeCaptionClock === undefined) throw new Error('no freezeCaptionClock hook');
    t.freezeCaptionClock(f);
  }, frozen);
}

/** With the caption clock stopped, run it forward `ms` of scene time (UIScene). */
async function advanceCaptionClock(page: Page, ms: number): Promise<void> {
  await page.evaluate((m: number) => {
    const t = (window as Win).__phase9_test;
    if (t?.advanceCaptionClock === undefined) throw new Error('no advanceCaptionClock hook');
    t.advanceCaptionClock(m);
  }, ms);
}

/** The recorded hold of the first caption whose text starts with `prefix`, once its
 *  hold has ended (null: not yet). */
async function holdOf(
  page: Page,
  prefix: string,
): Promise<{ holdMs: number; yielded: boolean } | null> {
  const holds = await page.evaluate(() => (window as Win).__phase9_test?.getCaptionHolds?.() ?? []);
  const h = holds.find((c) => c.text.startsWith(prefix));
  return h === undefined ? null : { holdMs: h.holdMs, yielded: h.yielded };
}

/**
 * The raid fixture with the enemy invading the player's door, its committed cohort of
 * three about to rout (see the header). Returns the save's tick.
 */
async function seedRoutSave(page: Page, how: 'dead' | 'fight'): Promise<number> {
  return await page.evaluate(
    async ({ how, ready }) => {
      const utilsPath = '/src/sim/raid-test-utils.ts';
      const savePath = '/src/platform/save.ts';
      const constantsPath = '/src/sim/constants.ts';
      const aiPath = '/src/sim/ai-state.ts';
      const deathPath = '/src/sim/ant-death.ts';
      type World = { tick: number; aiState: unknown[] };
      const utils = (await import(/* @vite-ignore */ utilsPath)) as {
        raidWorld: (fp: number) => { world: World; playerDoor: { x: number; y: number } };
        addFighter: (w: unknown, c: number, x: number, y: number, g: number | null) => number;
      };
      const save = (await import(/* @vite-ignore */ savePath)) as {
        manualSave: (seed: number, log: unknown[], w: unknown) => Promise<boolean>;
      };
      const k = (await import(/* @vite-ignore */ constantsPath)) as {
        PLAYER_COLONY_ID: number;
        ENEMY_COLONY_ID: number;
      };
      const ai = (await import(/* @vite-ignore */ aiPath)) as {
        createDefaultAIStateRecord: (cid: number) => Record<string, unknown>;
      };
      const death = (await import(/* @vite-ignore */ deathPath)) as {
        despawnAnt: (w: unknown, id: number, d: { cause: 'starvation' }) => void;
      };
      const r = utils.raidWorld(3000);
      const t = r.world.tick;
      const state = ai.createDefaultAIStateRecord(k.ENEMY_COLONY_ID);
      state.state = 'Invading';
      state.enteredTick = t;
      state.invasionStartTick = t;
      state.invasionRallyTileX = r.playerDoor.x;
      state.invasionRallyTileY = r.playerDoor.y;
      state.operationKind = 'Invasion';
      state.operationStartTick = t;
      state.operationTargetTileX = r.playerDoor.x;
      state.operationTargetTileY = r.playerDoor.y;
      const cohort = state.operationFighterIds as Int32Array;
      for (let i = 0; i < 3; i++) {
        cohort[i] =
          how === 'dead'
            ? // at home, by the enemy door (104, 64)
              utils.addFighter(r.world, k.ENEMY_COLONY_ID, 100 + i, 58, null)
            : // in the player's tunnel (row 6), beside its fighters
              utils.addFighter(r.world, k.ENEMY_COLONY_ID, 20 + i, 6, k.PLAYER_COLONY_ID);
      }
      state.operationFighterCount = 3;
      state.operationStartFighterCount = 3;
      if (how === 'dead') {
        death.despawnAnt(r.world, cohort[0]!, { cause: 'starvation' });
        // An army ready to strike, at home in the player's tunnel (row 6).
        for (let i = 0; i < ready; i++) {
          utils.addFighter(r.world, k.PLAYER_COLONY_ID, 17 + (i % 6), 6, k.PLAYER_COLONY_ID);
        }
      } else {
        for (let i = 0; i < 6; i++) {
          utils.addFighter(r.world, k.PLAYER_COLONY_ID, 17 + i, 6, k.PLAYER_COLONY_ID);
        }
      }
      r.world.aiState.push(state);
      if (!(await save.manualSave(7, [], r.world))) throw new Error('manualSave failed');
      return t;
    },
    { how, ready: COUNTER_ATTACK_READY_FIGHTERS },
  );
}

/** Seed the save, reload, and Continue into it. Returns the save's tick. */
async function bootRoutSave(page: Page, how: 'dead' | 'fight'): Promise<number> {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  const saveTick = await seedRoutSave(page, how);
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
  return saveTick;
}

test.describe('playtest 4 — the counter-attack caption after a fighter rout', () => {
  test('a wave routed at the player shows it soon after the rout, held to be read, once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const saveTick = await bootRoutSave(page, 'dead');

    // It shows, on the queue the other captions use.
    await expect
      .poll(async () => (await captionQueue(page)).active, { timeout: 20_000, intervals: [50] })
      .toBe(COUNTER_ATTACK_CAPTION_TEXT);
    // For the human eye only (asserts nothing): the caption over the game, its
    // clock stopped just past its fade-in, so it is at full opacity for the shot.
    await freezeCaptionClock(page, true);
    await advanceCaptionClock(page, CAPTION_FADE_IN_MS + 100);
    const box = await page.locator('canvas').first().boundingBox();
    if (!box) throw new Error('no canvas');
    await page.screenshot({ path: 'test-results/counter-attack-caption.png', clip: box });
    await freezeCaptionClock(page, false);

    // Owed for the rout on the save's first tick, and taken soon after: at once on an
    // idle queue, or behind the army warning noted as the save loaded, which gives way
    // to it (its 2 s readable floor, 2.7 s with its fades: ~54 ticks at 1x).
    const [entry] = (await counter(page)).shown;
    expect(entry).toBeDefined();
    expect(entry!.routTick).toBe(saveTick);
    expect(entry!.tick).toBeGreaterThan(saveTick);
    expect(entry!.tick).toBeLessThanOrEqual(saveTick + 100);

    // Held long enough to read: nothing queued behind it made it give way.
    await expect
      .poll(() => holdOf(page, COUNTER_ATTACK_CAPTION_TEXT), { timeout: 15_000 })
      .toEqual({ holdMs: COUNTER_ATTACK_CAPTION_HOLD_MS, yielded: false });

    // Once per rout: 10 s of game time on, the queue long idle, it has not come back.
    const t0 = await tick(page);
    await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(t0 + 200);
    expect((await captions(page)).filter((c) => c === COUNTER_ATTACK_CAPTION_TEXT)).toHaveLength(1);
    expect((await counter(page)).shown).toHaveLength(1);
    expect((await counter(page)).owedRoutTick).toBeNull();
  });

  test('routed while the army warning is up, with a small army: the warning gives way, and the build-up copy comes next', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const saveTick = await bootRoutSave(page, 'fight');

    // Six fighters are no army to strike with: the caption takes its build-up copy.
    await expect
      .poll(async () => (await captionQueue(page)).active, { timeout: 20_000, intervals: [50] })
      .toBe(COUNTER_ATTACK_BUILD_UP_TEXT);
    // The army warning came first, then this caption, nothing between.
    const shown = await captions(page);
    expect(shown).not.toContain(COUNTER_ATTACK_CAPTION_TEXT);
    const at = shown.indexOf(COUNTER_ATTACK_BUILD_UP_TEXT);
    expect(at).toBeGreaterThan(0);
    expect(shown[at - 1]!.startsWith(ARMY_WARNING_PREFIX)).toBe(true);
    // The warning gave way to it (the counter-attack caption owed behind it is a
    // recurring caption: GameScene's recurringOwed), rather than holding its full 4 s.
    expect(await holdOf(page, ARMY_WARNING_PREFIX)).toMatchObject({ yielded: true });
    // Owed from the rout, a few ticks into the fight.
    const [entry] = (await counter(page)).shown;
    expect(entry).toBeDefined();
    expect(entry!.routTick).toBeGreaterThan(saveTick);
    expect(entry!.tick).toBeGreaterThan(entry!.routTick);
    expect(entry!.tick).toBeLessThanOrEqual(entry!.routTick + 100);
  });

  test('waiting behind another caption at the game over, it never shows over the end screen', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await bootRoutSave(page, 'fight');
    // Hold the army warning on screen (caption clock stopped), and let the fight rout
    // the cohort: the caption is owed, waiting behind it.
    await expect
      .poll(async () => (await captionQueue(page)).active ?? '', {
        timeout: 20_000,
        intervals: [20],
      })
      .toMatch(/^An enemy army is/);
    await freezeCaptionClock(page, true);
    await expect
      .poll(async () => (await counter(page)).owedRoutTick, { timeout: 20_000 })
      .not.toBeNull();
    expect((await captionQueue(page)).active).toMatch(/^An enemy army is/);

    // The match ends (as the queen dying would end it).
    await page.evaluate(() => (window as Win).__phase9_test?.forceGameOver?.('Defeat'));
    await expect.poll(() => activeOverlay(page), { timeout: 10_000 }).toBe('game-over');
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    // The caption clock runs on behind the end screen: nothing comes up over it.
    await advanceCaptionClock(page, 10_000);
    expect(await captionQueue(page)).toEqual({ active: null, pending: null });
    expect(await captions(page)).not.toContain(COUNTER_ATTACK_CAPTION_TEXT);
    expect(await captions(page)).not.toContain(COUNTER_ATTACK_BUILD_UP_TEXT);
    expect((await counter(page)).shown).toEqual([]);
  });
});
