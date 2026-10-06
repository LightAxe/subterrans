// enemy-queen-wound.spec.ts — #427: the enemy queen's wound is visible in a real
// browser. With her below half her max HP, "Their queen is wounded!" reaches the
// caption queue (once), and the enemy-nest view (Tab underground, then X) draws her
// HP bar over her at her HP over her max HP there, clear of the HUD; the player's own
// nest, with its own queen in it, draws none.
//
// The rules (the bar's visibility and fill, the caption's once-per-spell re-arm at ¾,
// per-tick decisions, nothing after the round) are pinned in
// src/render/enemy-queen-wound.test.ts, draw-underground.test.ts and hp-bar.test.ts.
// What only a browser proves is the GameScene wiring: the per-tick look and frame step
// reach UIScene's queue, and the underground pass hands the overlay layer to the draw
// so the bar is actually painted, above her sprite.
//
// Setup (tests/helpers/save.ts): a fresh Normal scenario, the spider and the AI off,
// each queen staged in a Queen chamber at her colony's door (her home ground: max HP
// 50; the player's, so the player's own nest has a queen the bar must not label), 20
// ticks of sim, then the enemy queen wounded to 12 HP by a blow on the last of them.
// She cannot heal for HEAL_SAFE_TICKS, then heals 1 HP per 40 ticks, so she stays
// below half until about sim tick 600 (30 s of game time at 1x); the bar is measured
// with the game paused, well before that. The game boots it through Continue.
// Positions and HP are read through the Dev-only __phase9_test.getEnemyQueenHpBar
// hook; two pixel probes check the fill is drawn at that fraction.
//
// Screenshot (for a human eye; not compared): test-results/enemy-queen-wound-bar.png.

import { test, expect, type Page } from '@playwright/test';
import { activeView, clickCanvasRect } from './helpers/boot.js';
import { HUD_ZONE_RECTS, VIEW_TOGGLE_RECT, type Rect } from './helpers/geometry.js';
import { bootFromSave, runUntil, saveOf } from './helpers/save.js';
import { createScenario } from '../src/sim/scenario.js';
import { stageQueenInNest } from '../src/sim/health-test-utils.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID, QUEEN_HP_HOME } from '../src/sim/constants.js';
import { HP_BAR_H, HP_BAR_W } from '../src/render/hp-bar.js';

const WOUNDED = 'Their queen is wounded!';
/** Her HP in the save: below half of her 50 in her nest. */
const HP = 12;

interface Bar {
  hp: number;
  maxHp: number;
  ratio: number;
  fillW: number;
  color: number;
  world: Rect;
  screen: Rect;
}

interface TestHook {
  getEnemyQueenHpBar?: () => Bar | null;
  getCaptionsShown?: () => string[];
  isPaused?: () => boolean;
  getTick?: () => number;
  sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
}

/** The save: the enemy queen staged in her nest, the sim run a few ticks on the real
 *  tick path, then a blow on its last tick (stamped as combat.ts does) leaves her at
 *  `hp`. */
function woundedEnemyQueenSave(hp: number): string {
  const world = createScenario(7, 'Normal');
  world.spider = null;
  world.aiState = [];
  const q = stageQueenInNest(world, world.colonies[ENEMY_COLONY_ID]!);
  stageQueenInNest(world, world.colonies[PLAYER_COLONY_ID]!);
  expect(runUntil(world, [], (w) => w.tick >= 20, 40)).toBe(20);
  world.ants.hp[q] = hp;
  world.ants.lastHitTick[q] = world.tick - 1; // no healing for HEAL_SAFE_TICKS (5 s)
  return saveOf(world, 7);
}

async function enemyQueenBar(page: Page): Promise<Bar | null> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.getEnemyQueenHpBar === undefined) throw new Error('no getEnemyQueenHpBar hook');
    return t.getEnemyQueenHpBar();
  });
}

async function captions(page: Page): Promise<string[]> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getCaptionsShown?.() ?? [],
  );
}

async function simTick(page: Page): Promise<number> {
  return await page.evaluate(
    () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getTick?.() ?? -1,
  );
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

/** RGB of the canvas pixel at (x, y), as rendered on the next frame. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const px = await page.evaluate(
    async ([ax, ay]) => {
      const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
      if (t?.sampleArea === undefined) throw new Error('no sampleArea hook');
      return await t.sampleArea(ax, ay, 1, 1);
    },
    [x, y] as const,
  );
  return [px[0]!, px[1]!, px[2]!];
}

const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
const near = (a: readonly number[], b: readonly number[], tol: number): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('#427 — a wounded enemy queen: "Their queen is wounded!" once, and her HP bar in the enemy nest view', async ({
  page,
}) => {
  await bootFromSave(page, woundedEnemyQueenSave(HP));

  // The caption: decided at the first look at her (below half, armed), shown once.
  await expect.poll(() => captions(page), { timeout: 10_000 }).toContain(WOUNDED);

  // No bar in the player's own nest, over her own queen (drawn there: frames run on).
  await clickCanvasRect(page, VIEW_TOGGLE_RECT);
  await expect.poll(() => activeView(page)).toBe('underground');
  const t1 = await simTick(page);
  await expect.poll(() => simTick(page)).toBeGreaterThan(t1 + 5);
  expect(await enemyQueenBar(page)).toBeNull();

  // The enemy's nest (X centres the camera on her Queen chamber): her bar.
  await page.keyboard.press('x');
  await expect.poll(() => enemyQueenBar(page), { timeout: 10_000 }).not.toBeNull();
  // Freeze the sim so her HP holds while the bar is measured (the draw runs on), then
  // wait for a frame rendered after the pause (sampleArea settles on the next frame's
  // snapshot) so the bar the hook reports is the paused world's.
  await setPaused(page, true);
  await pixel(page, 0, 0);
  const bar = (await enemyQueenBar(page))!;

  // Her HP over her max HP where she stands (her nest: 50), still below half.
  expect(bar.maxHp).toBe(QUEEN_HP_HOME);
  expect(bar.hp).toBeGreaterThanOrEqual(HP);
  expect(bar.hp).toBeLessThan(QUEEN_HP_HOME / 2);
  expect(bar.ratio).toBe(bar.hp / QUEEN_HP_HOME);
  expect(bar.world.w).toBe(HP_BAR_W);
  expect(bar.world.h).toBe(HP_BAR_H);

  // On screen, clear of every HUD zone: the track's box grown by its 1-world-px
  // outline on each side (zoom canvas px).
  const s = bar.screen;
  const zoom = s.w / bar.world.w;
  const painted: Rect = { x: s.x - zoom, y: s.y - zoom, w: s.w + 2 * zoom, h: s.h + 2 * zoom };
  expect(painted.x).toBeGreaterThanOrEqual(0);
  expect(painted.y).toBeGreaterThanOrEqual(0);
  for (const zone of HUD_ZONE_RECTS) {
    expect(
      intersects(painted, zone.rect),
      `bar ${JSON.stringify(painted)} overlaps ${zone.name}`,
    ).toBe(false);
  }

  // Drawn at that fraction: on the canvas, the middle of the fill — the track's width
  // times her HP fraction, rounded — is the fill colour, and the middle of the track
  // past it is not.
  const fillW = Math.round(HP_BAR_W * bar.ratio);
  const midY = Math.floor(s.y + s.h / 2);
  const filled = await pixel(page, Math.floor(s.x + (fillW * zoom) / 2), midY);
  expect(near(filled, rgb(bar.color), 12), `fill pixel ${filled.join(',')}`).toBe(true);
  const unfilled = await pixel(page, Math.floor(s.x + ((fillW + HP_BAR_W) * zoom) / 2), midY);
  expect(near(unfilled, rgb(bar.color), 40), `track pixel ${unfilled.join(',')}`).toBe(false);

  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.screenshot({
    path: 'test-results/enemy-queen-wound-bar.png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });

  // Still one caption after running on. This guards only against a re-fire on every
  // frame or tick while she stays wounded; it cannot catch a re-arm bug (her earliest
  // re-arm, healed from 12 HP to ¾, is at about sim tick 1120, far past this check;
  // the unit tests pin the re-arm).
  await setPaused(page, false);
  const t0 = await simTick(page);
  await expect.poll(() => simTick(page), { timeout: 10_000 }).toBeGreaterThan(t0 + 40);
  expect((await captions(page)).filter((c) => c === WOUNDED)).toHaveLength(1);
});
