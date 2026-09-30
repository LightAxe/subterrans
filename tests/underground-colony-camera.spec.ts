// underground-colony-camera.spec.ts — #378: switching the underground view to
// another colony takes the camera to that colony's nest, and switching back
// returns it to where the player was in their own, in a real browser.
//
// The rule (Queen chamber, else entrance column; a remembered spot per colony) is
// pinned in camera.test.ts. What only a browser proves is the wiring of both ways
// the player switches: the "Your Colony [X]" button (UIScene) and the X key
// (GameScene) each hand the live world to toggleUndergroundColony, and GameScene
// then draws from the moved camera. Before #378 the toggle only flipped the colony
// id, so the enemy's grid was shown at the player's own x: blank dirt.
//
// In a fresh game neither colony has chambers yet, so the enemy's nest is found by
// its entrance column. Positions are read through the Dev-only
// __phase9_test.getCameraState hook — no pixels, no timing.
//
// Screenshots (for a human eye; not compared): test-results/colony-camera-*.png.

import { test, expect, type Page } from '@playwright/test';
import { activeView, clickCanvasRect, settleToPlaying, waitForUiHook } from './helpers/boot.js';
import { COLONY_TOGGLE_RECT, VIEW_TOGGLE_RECT } from './helpers/geometry.js';
import { TILE_SIZE_PX } from '../src/render/sprites.js';

interface CameraState {
  activeView: 'surface' | 'underground';
  undergroundColonyId: number;
  surface: { centerX: number; centerY: number; zoom: number };
  underground: { centerX: number; centerY: number; zoom: number };
}

interface TestHook {
  getCameraState?: () => CameraState;
  getEnemyEntrances?: () => Array<{ tileX: number; tileY: number; isOpen: boolean }>;
}

async function cameraState(page: Page): Promise<CameraState> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.getCameraState === undefined) throw new Error('no getCameraState hook');
    return t.getCameraState();
  });
}

async function undergroundLabel(page: Page): Promise<string> {
  return await page.evaluate(
    () =>
      (window as unknown as { __phase9_ui?: { activeUndergroundLabel?: string } }).__phase9_ui
        ?.activeUndergroundLabel ?? '<undefined>',
  );
}

async function shot(page: Page, name: string): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.screenshot({
    path: `test-results/colony-camera-${name}.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
}

/** Switch the underground colony by the HUD button or by the X key. */
async function toggleColony(page: Page, via: 'button' | 'key'): Promise<void> {
  if (via === 'button') await clickCanvasRect(page, COLONY_TOGGLE_RECT);
  else await page.keyboard.press('x');
}

// Each way of switching is used once for a FIRST look at the enemy (the one that
// needs the world, to find the nest) and once for the way back (the remembered spot).
for (const [first, back] of [
  ['button', 'key'],
  ['key', 'button'],
] as const) {
  test(`#378 — the colony toggle (${first} there, ${back} back) takes the underground camera to that colony’s nest, and back`, async ({
    page,
  }) => {
    await page.goto('/');
    await waitForUiHook(page);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await settleToPlaying(page);

    const doors = await page.evaluate(
      () =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getEnemyEntrances?.() ??
        [],
    );
    expect(doors.length).toBeGreaterThan(0);
    const enemyDoorX = (doors[0]!.tileX + 0.5) * TILE_SIZE_PX;
    // The canvas's logical width, for half the visible world's width at a zoom.
    const canvasW = await page.evaluate(() => document.querySelector('canvas')!.width);

    // Underground, on the player's own nest (the camera X-linked from the surface).
    await clickCanvasRect(page, VIEW_TOGGLE_RECT);
    await expect.poll(() => activeView(page)).toBe('underground');
    const own = await cameraState(page);
    const halfView = canvasW / 2 / own.underground.zoom;
    // The enemy's entrance is nowhere near the player's view to begin with.
    expect(Math.abs(own.underground.centerX - enemyDoorX)).toBeGreaterThan(halfView);

    // First look at the enemy's underground: centred on its nest.
    await toggleColony(page, first);
    await expect.poll(() => undergroundLabel(page)).toBe('Enemy Colony');
    const enemy = await cameraState(page);
    expect(enemy.undergroundColonyId).not.toBe(own.undergroundColonyId);
    // Its entrance column is in view, away from the edge (the clamp may hold the
    // camera short of centring it exactly at the world's edge).
    expect(Math.abs(enemy.underground.centerX - enemyDoorX)).toBeLessThan(halfView - TILE_SIZE_PX);
    // Zoom and the surface camera are untouched.
    expect(enemy.underground.zoom).toBe(own.underground.zoom);
    expect(enemy.surface).toEqual(own.surface);
    await shot(page, `enemy-${first}`);

    // Back: exactly where the player was in their own nest.
    await toggleColony(page, back);
    await expect.poll(() => undergroundLabel(page)).toBe('Your Colony');
    const home = await cameraState(page);
    expect(home.undergroundColonyId).toBe(own.undergroundColonyId);
    expect(home.underground).toEqual(own.underground);
    await shot(page, `own-${back}`);

    // And across again: the enemy's nest, the spot the player left it at.
    await toggleColony(page, back);
    await expect.poll(() => undergroundLabel(page)).toBe('Enemy Colony');
    expect((await cameraState(page)).underground).toEqual(enemy.underground);
  });
}
