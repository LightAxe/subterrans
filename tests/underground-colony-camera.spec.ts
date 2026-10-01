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
import { UNDERGROUND_WORLD_PX_W } from '../src/render/camera.js';
import { initialUndergroundCenterYPx } from '../src/render/camera-adapter.js';
import { chamberCenterTile } from '../src/render/chamber-tiles.js';
import { PLAYER_COLONY_ID, PLAYER_START_X } from '../src/sim/constants.js';
import { createScenario } from '../src/sim/scenario.js';
import { ChamberType } from '../src/sim/enums.js';
import type { SimCommand } from '../src/sim/commands.js';
import { bootFromSave, runUntil, saveOf } from './helpers/save.js';

interface CameraState {
  activeView: 'surface' | 'underground';
  undergroundColonyId: number;
  /** viewW: the visible world width (world px) at the camera's zoom — the
   *  logical viewport over the zoom, read from the game (not the canvas's
   *  backing-store size, which a device pixel ratio would scale). */
  surface: { centerX: number; centerY: number; zoom: number; viewW: number };
  underground: { centerX: number; centerY: number; zoom: number; viewW: number };
}

/** Where the camera clamp lets a centre at `x` sit in a world `worldW` px wide,
 *  with `viewW` px of it visible (camera-adapter.ts clampCameraView): centred
 *  when the whole world fits the view, else held half a view in from each edge. */
function clampedCenter(x: number, viewW: number, worldW: number): number {
  if (worldW <= viewW) return worldW / 2;
  return Math.max(viewW / 2, Math.min(worldW - viewW / 2, x));
}

interface TestHook {
  getCameraState?: () => CameraState;
  getEnemyEntrances?: () => Array<{ tileX: number; tileY: number; isOpen: boolean }>;
  surfaceTileScreenPoint?: (tileX: number, tileY: number) => { x: number; y: number } | null;
  isPaused?: () => boolean;
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
    // The entrance the camera looks for: the first open one, else the first.
    const door = doors.find((d) => d.isOpen) ?? doors[0]!;
    const enemyDoorX = (door.tileX + 0.5) * TILE_SIZE_PX;

    // Underground, on the player's own nest (#399: always its own, at its entrance
    // column in a fresh game).
    await clickCanvasRect(page, VIEW_TOGGLE_RECT);
    await expect.poll(() => activeView(page)).toBe('underground');
    const own = await cameraState(page);
    const viewW = own.underground.viewW;
    // The enemy's entrance is nowhere near the player's view to begin with.
    expect(Math.abs(own.underground.centerX - enemyDoorX)).toBeGreaterThan(viewW / 2);

    // First look at the enemy's underground: centred on its nest.
    await toggleColony(page, first);
    await expect.poll(() => undergroundLabel(page)).toBe('Enemy Colony');
    const enemy = await cameraState(page);
    expect(enemy.undergroundColonyId).not.toBe(own.undergroundColonyId);
    // Centred on its entrance column (a fresh game: no chambers yet), exactly, as
    // far as the clamp allows at the world's edge; at the same "shaft at the top"
    // depth a first look at the player's own nest has.
    expect(enemy.underground.centerX).toBe(
      clampedCenter(enemyDoorX, viewW, UNDERGROUND_WORLD_PX_W),
    );
    expect(enemy.underground.centerY).toBe(own.underground.centerY);
    // And so its entrance is in view.
    expect(Math.abs(enemy.underground.centerX - enemyDoorX)).toBeLessThan(viewW / 2);
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

/** Pause the game (Space) and wait until it is. */
async function pause(page: Page): Promise<void> {
  const isPaused = () =>
    page.evaluate(
      () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.isPaused?.() ?? null,
    );
  if ((await isPaused()) !== true) await page.keyboard.press('Space');
  await expect.poll(isPaused).toBe(true);
}

/** Centre the surface camera on surface tile (tileX, tileY) (the
 *  surfaceTileScreenPoint hook does, as a spec's right-click on an entrance needs). */
async function surfaceCameraTo(page: Page, tileX: number, tileY: number): Promise<void> {
  const pt = await page.evaluate(
    ({ x, y }) =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.surfaceTileScreenPoint?.(
        x,
        y,
      ) ?? null,
    { x: tileX, y: tileY },
  );
  expect(pt).not.toBeNull();
}

/** Hold an arrow key until the underground camera's centre has moved more than
 *  `minPx` from `fromX` (a keyboard pan; how far it goes is not asserted). */
async function panUnderground(page: Page, key: string, fromX: number, minPx: number) {
  await page.keyboard.down(key);
  await expect
    .poll(async () => Math.abs((await cameraState(page)).underground.centerX - fromX), {
      timeout: 10_000,
    })
    .toBeGreaterThan(minPx);
  await page.keyboard.up(key);
  // Let the pan settle (its last frame) before reading where it stopped.
  let last = (await cameraState(page)).underground;
  await expect
    .poll(async () => {
      const now = (await cameraState(page)).underground;
      const still = now.centerX === last.centerX && now.centerY === last.centerY;
      last = now;
      return still;
    })
    .toBe(true);
  return last;
}

// #399 — the playtest pressed Underground while its surface camera was over an enemy
// entrance (it had just given a raid order there) and was shown its own colony's
// empty dirt under that entrance. The Underground button now always goes to the
// player's own nest: the first time centred on it, then where they last were in it,
// wherever the surface camera is. The colony toggle stays the way to see the
// enemy's; and the surface keeps its own camera, so going up returns to it.
test('#399 — Underground goes to your own nest wherever the surface camera is, then back to your spot; the colony toggle composes', async ({
  page,
}) => {
  await page.goto('/');
  await waitForUiHook(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settleToPlaying(page);
  // Paused, so neither colony digs a new chamber or entrance (which would move
  // its nest) while the cameras are walked about; the views, the colony toggle
  // and the camera all work while paused.
  await pause(page);

  const doors = await page.evaluate(
    () =>
      (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getEnemyEntrances?.() ??
      [],
  );
  const door = doors.find((d) => d.isOpen) ?? doors[0]!;
  const enemyDoorX = (door.tileX + 0.5) * TILE_SIZE_PX;
  const ownDoorX = (PLAYER_START_X + 0.5) * TILE_SIZE_PX; // a fresh game's own entrance

  // On the surface, over the enemy's entrance (as after a raid order there).
  await surfaceCameraTo(page, door.tileX, door.tileY);
  const atDoor = await cameraState(page);
  expect(Math.abs(atDoor.surface.centerX - enemyDoorX)).toBeLessThan(atDoor.surface.viewW / 2);

  // Underground, by the HUD button: YOUR nest, centred on it (a fresh game has no
  // chambers, so on its entrance column, the shaft at the top) — not the dirt
  // under the enemy's entrance.
  await clickCanvasRect(page, VIEW_TOGGLE_RECT);
  await expect.poll(() => activeView(page)).toBe('underground');
  const first = await cameraState(page);
  const viewW = first.underground.viewW;
  expect(first.undergroundColonyId).toBe(PLAYER_COLONY_ID);
  expect(await undergroundLabel(page)).toBe('Your Colony');
  expect(first.underground.centerX).toBe(clampedCenter(ownDoorX, viewW, UNDERGROUND_WORLD_PX_W));
  expect(first.underground.centerY).toBe(initialUndergroundCenterYPx());
  expect(Math.abs(first.underground.centerX - enemyDoorX)).toBeGreaterThan(viewW / 2);
  await shot(page, 'own-nest-from-enemy-door');

  // Move about in the nest (an arrow-key pan of the underground camera only).
  const spot = await panUnderground(page, 'ArrowRight', first.underground.centerX, 48);
  expect((await cameraState(page)).surface).toEqual(atDoor.surface);

  // Up (Tab): the surface where it was left — over the enemy entrance, not the
  // nest's column (the views are not X-linked).
  await page.keyboard.press('Tab');
  await expect.poll(() => activeView(page)).toBe('surface');
  expect((await cameraState(page)).surface).toEqual(atDoor.surface);

  // The surface camera moves on, somewhere else again; down (Tab): the own nest,
  // exactly where the player was in it.
  await surfaceCameraTo(page, door.tileX - 20, door.tileY + 10);
  await page.keyboard.press('Tab');
  await expect.poll(() => activeView(page)).toBe('underground');
  let now = await cameraState(page);
  expect(now.undergroundColonyId).toBe(PLAYER_COLONY_ID);
  expect(now.underground).toEqual(spot);

  // The colony toggle still shows the enemy's nest, and back returns to the spot.
  await page.keyboard.press('x');
  await expect.poll(() => undergroundLabel(page)).toBe('Enemy Colony');
  const enemy = (await cameraState(page)).underground;
  expect(enemy.centerX).toBe(clampedCenter(enemyDoorX, viewW, UNDERGROUND_WORLD_PX_W));
  await clickCanvasRect(page, COLONY_TOGGLE_RECT);
  await expect.poll(() => undergroundLabel(page)).toBe('Your Colony');
  expect((await cameraState(page)).underground).toEqual(spot);

  // Left while looking at the enemy's nest: the button still goes to YOUR nest,
  // at your spot; and the toggle then finds the enemy's where it was left.
  await page.keyboard.press('x');
  await expect.poll(() => undergroundLabel(page)).toBe('Enemy Colony');
  await clickCanvasRect(page, VIEW_TOGGLE_RECT);
  await expect.poll(() => activeView(page)).toBe('surface');
  await clickCanvasRect(page, VIEW_TOGGLE_RECT);
  await expect.poll(() => activeView(page)).toBe('underground');
  now = await cameraState(page);
  expect(now.undergroundColonyId).toBe(PLAYER_COLONY_ID);
  expect(await undergroundLabel(page)).toBe('Your Colony');
  expect(now.underground).toEqual(spot);
  await shot(page, 'own-nest-after-enemy');
  await page.keyboard.press('x');
  await expect.poll(() => undergroundLabel(page)).toBe('Enemy Colony');
  expect((await cameraState(page)).underground).toEqual(enemy);
});

// #399 — the first trip down centres on the nest's heart, the Queen chamber, by
// either way down (the HUD button in UIScene, Tab in GameScene: each must hand the
// live world to toggleView to find it). In a fresh game the nest is only its
// entrance column, where the underground camera already starts, so this world
// digs a deep Queen chamber first — with the sim's own commands, in Node — and
// is loaded as a save.
/** A world whose colony has dug a deep shaft and a Queen chamber at its foot
 *  (the sim's own commands, run in Node), saved; built on first use (not at
 *  import: Playwright imports the spec to list its tests), once for both ways down. */
let deepNestCache: ReturnType<typeof buildDeepNest> | undefined;
const deepNest = () => (deepNestCache ??= buildDeepNest());
function buildDeepNest() {
  const seed = 7;
  const world = createScenario(seed, 'Normal');
  const x = PLAYER_START_X;
  const depth = 30;
  const commands: SimCommand[] = [];
  for (let y = 2; y <= depth; y++) {
    commands.push({
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: x,
      tileY: y,
      issuedAtTick: 0,
    });
  }
  commands.push({
    type: 'PlaceChamber',
    colonyId: PLAYER_COLONY_ID,
    chamberType: ChamberType.Queen,
    anchorTileX: x - 2,
    anchorTileY: depth + 1,
    issuedAtTick: 0,
  });
  const queenChamber = (w: typeof world) =>
    w.colonies[PLAYER_COLONY_ID]!.chambers.find((c) => c.chamberType === ChamberType.Queen);
  const dugAt = runUntil(world, commands, (w) => queenChamber(w) !== undefined, 3000);
  const chamber = queenChamber(world);
  return {
    dugAt,
    centre: chamber === undefined ? null : chamberCenterTile(chamber),
    save: saveOf(world, seed),
  };
}

for (const via of ['button', 'tab'] as const) {
  test(`#399 — the first trip down (${via}) centres on the own Queen chamber, from over the enemy entrance`, async ({
    page,
  }) => {
    const nest = deepNest();
    expect(nest.dugAt).toBeGreaterThan(0);
    const centre = nest.centre!;
    await bootFromSave(page, nest.save);
    await pause(page);
    const doors = await page.evaluate(
      () =>
        (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getEnemyEntrances?.() ??
        [],
    );
    const door = doors.find((d) => d.isOpen) ?? doors[0]!;
    await surfaceCameraTo(page, door.tileX, door.tileY);

    if (via === 'button') await clickCanvasRect(page, VIEW_TOGGLE_RECT);
    else await page.keyboard.press('Tab');
    await expect.poll(() => activeView(page)).toBe('underground');
    const cam = await cameraState(page);
    const viewW = cam.underground.viewW;
    expect(cam.undergroundColonyId).toBe(PLAYER_COLONY_ID);
    expect(cam.underground.centerX).toBe(
      clampedCenter(centre.tileX * TILE_SIZE_PX, viewW, UNDERGROUND_WORLD_PX_W),
    );
    // Deep enough that the clamp leaves its depth alone, and well below where a
    // camera that was not moved (the shaft-top start) would sit.
    expect(cam.underground.centerY).toBe(centre.tileY * TILE_SIZE_PX);
    expect(cam.underground.centerY - initialUndergroundCenterYPx()).toBeGreaterThan(
      TILE_SIZE_PX * 8,
    );
    await shot(page, `queen-chamber-first-trip-${via}`);
  });
}
