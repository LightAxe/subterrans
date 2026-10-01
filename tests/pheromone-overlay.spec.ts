// pheromone-overlay.spec.ts — #399: the pheromone overlay, switched on, is
// see-through and quiet, and ants draw above it, in a real browser.
//
// The mapping (intensity by trail strength, 35% alpha at full strength, weak
// trail not drawn) and the depth constants are pinned in draw-pheromone.test.ts.
// What only a browser proves is the real picture: the colour the canvas ends up
// with over the terrain when the overlay is on (so the alpha the renderer
// applies), and the live scene's layer order — terrain, overlay, then every
// layer an ant is drawn on — on the surface and underground, and in pixels, that
// the overlay laid round the queen leaves the entity layers there (her chamber's
// fill, the queen) as they were.
//
// The world is built here, in Node: a fresh scenario whose colony digs a shaft
// and a Queen chamber with the sim's own commands until the queen has moved in,
// then trail laid on chosen tiles (test setup writing its own fixture, before the
// game loads it as a save — the render layer writes nothing). The game is paused
// once loaded, so nothing moves under the sampled pixels. No wall-clock
// assertions: state through the Dev-only __phase9_test hooks (getCameraState,
// getLayerDepths, getDrawOrder), pixels through sampleArea.
//
// Screenshots (for a human eye; not compared): test-results/pheromone-399-*.png.

import { test, expect, type Page } from '@playwright/test';
import { activeView } from './helpers/boot.js';
import { type Rect } from './helpers/geometry.js';
import { bootFromSave, runUntil, saveOf } from './helpers/save.js';
import { createScenario } from '../src/sim/scenario.js';
import type { SimCommand } from '../src/sim/commands.js';
import { pheromoneGridKey, phGet, phSet } from '../src/sim/pheromone/pheromone-store.js';
import { ChamberType, PheromoneType } from '../src/sim/enums.js';
import { Zone } from '../src/sim/terrain.js';
import { FP_SHIFT } from '../src/sim/fixed.js';
import { PLAYER_COLONY_ID, PLAYER_START_X, PLAYER_START_Y } from '../src/sim/constants.js';
import { TILE_SIZE_PX } from '../src/render/sprites.js';
import { DEFAULT_LAYOUT } from '../src/render/layout.js';
import {
  ANT_TEXTURE_QUEEN,
  ANT_TEXTURE_WORKER,
  EGG_TEXTURE,
  FOOD_CACHE_TEXTURE,
  LARVA_TEXTURE,
  SPIDER_TEXTURE,
} from '../src/render/ant-sprite-layer.js';

interface LayerDepths {
  terrain: number[];
  pheromone: number;
  pheromoneDrawn: boolean;
  entityGfx: number;
  sprites: Array<{ texture: string; depth: number }>;
}

interface CamView {
  centerX: number;
  centerY: number;
  zoom: number;
  viewW: number;
}

interface TestHook {
  getCameraState?: () => { surface: CamView; underground: CamView };
  getLayerDepths?: () => LayerDepths;
  getDrawOrder?: () => string[];
  sampleArea?: (x: number, y: number, w: number, h: number) => Promise<number[]>;
  isPaused?: () => boolean;
}

const SEED = 4242;
/** A full-strength trail (well above PHEROMONE_VISUAL_MAX) and a weak one (just
 *  under the visibility floor, PHEROMONE_VISUAL_MIN 1024; it only decays). */
const STRONG = 60_000;
const WEAK = 1000;
/** Surface tiles of the two strips, six tiles long and three apart: at the left
 *  of the view the camera opens on (over the nest entrance), far from the forage
 *  route the colony lays from its entrance — so no forager can reach them, and
 *  deposit on them, in the few ticks that run before the spec pauses
 *  (plantedWorld asserts the clearance). */
const STRIP_LEN = 6;
const STRONG_TILE = { tileX: 2, tileY: PLAYER_START_Y - 14 };
const WEAK_TILE = { tileX: 2, tileY: PLAYER_START_Y - 11 };
/** No ant on the surface within this many tiles (Chebyshev) of either strip: at
 *  half a tile a tick, twice as many ticks as the pause can take to land. */
const STRIP_ANT_CLEARANCE = 12;
/** Every texture a sprite is drawn with for an ant, its brood, a food cache, the
 *  spider (carried food is drawn with the food-cache texture). */
const ANT_LAYER_TEXTURES = new Set([
  ANT_TEXTURE_WORKER,
  ANT_TEXTURE_QUEEN,
  EGG_TEXTURE,
  LARVA_TEXTURE,
  FOOD_CACHE_TEXTURE,
  SPIDER_TEXTURE,
]);
/** Half the side (tiles) of the square of underground trail laid round the queen. */
const QUEEN_PATCH_HALF = 2;

/** The world: the colony digs the usual opening shaft and a Queen chamber at its
 *  foot, the queen moves in and settles; then the trail is laid — the two surface
 *  strips, and a strong square underground round the queen and a second one in
 *  solid earth well away from the nest (nothing drawn above it). Built on first
 *  use (not at import: Playwright imports the spec to list its tests). */
let plantedCache: ReturnType<typeof buildPlanted> | undefined;
const plantedWorld = () => (plantedCache ??= buildPlanted());
function buildPlanted() {
  const world = createScenario(SEED, 'Normal');
  const x = PLAYER_START_X;
  const commands: SimCommand[] = [];
  for (let y = 2; y <= 8; y++) {
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
    anchorTileY: 9,
    issuedAtTick: 0,
  });
  const queen = world.colonies[PLAYER_COLONY_ID]!.queenEntityId;
  let downAt = -1;
  const settled = runUntil(
    world,
    commands,
    (w) => {
      if (downAt < 0 && w.ants.zone[queen] === Zone.Underground) downAt = w.tick;
      return downAt >= 0 && w.tick >= downAt + 200;
    },
    3000,
  );
  const queenTile = {
    tileX: world.ants.posX[queen]! >> FP_SHIFT,
    tileY: world.ants.posY[queen]! >> FP_SHIFT,
  };
  const surface =
    world.pheromoneGrids[pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface')]!;
  const below =
    world.pheromoneGrids[
      pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'underground')
    ]!;
  // The strips' preconditions: no trail there yet, and no ant near.
  let trailBefore = 0;
  for (let i = 0; i < STRIP_LEN; i++) {
    trailBefore += phGet(surface, STRONG_TILE.tileX + i, STRONG_TILE.tileY);
    trailBefore += phGet(surface, WEAK_TILE.tileX + i, WEAK_TILE.tileY);
  }
  let antDistance = Infinity;
  for (let id = 0; id < world.ants.alive.length; id++) {
    if (!world.ants.alive[id] || world.ants.zone[id] !== Zone.Surface) continue;
    const ax = world.ants.posX[id]! >> FP_SHIFT;
    const ay = world.ants.posY[id]! >> FP_SHIFT;
    for (const strip of [STRONG_TILE, WEAK_TILE]) {
      const dx = Math.max(strip.tileX - ax, 0, ax - (strip.tileX + STRIP_LEN - 1));
      antDistance = Math.min(antDistance, Math.max(dx, Math.abs(ay - strip.tileY)));
    }
  }
  for (let i = 0; i < STRIP_LEN; i++) {
    phSet(surface, STRONG_TILE.tileX + i, STRONG_TILE.tileY, STRONG);
    phSet(surface, WEAK_TILE.tileX + i, WEAK_TILE.tileY, WEAK);
  }
  const earthTile = { tileX: queenTile.tileX + 10, tileY: queenTile.tileY + 10 };
  for (let dy = -QUEEN_PATCH_HALF; dy <= QUEEN_PATCH_HALF; dy++) {
    for (let dx = -QUEEN_PATCH_HALF; dx <= QUEEN_PATCH_HALF; dx++) {
      phSet(below, queenTile.tileX + dx, queenTile.tileY + dy, STRONG);
      phSet(below, earthTile.tileX + dx, earthTile.tileY + dy, STRONG);
    }
  }
  return {
    save: saveOf(world, SEED),
    settled,
    queenUnderground: world.ants.zone[queen] === Zone.Underground,
    queenTile,
    earthTile,
    trailBefore,
    antDistance,
  };
}

async function layerDepths(page: Page): Promise<LayerDepths> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.getLayerDepths === undefined) throw new Error('no getLayerDepths hook');
    return t.getLayerDepths();
  });
}

async function drawOrder(page: Page): Promise<string[]> {
  return await page.evaluate(
    () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.getDrawOrder?.() ?? [],
  );
}

async function sample(page: Page, r: Rect): Promise<number[]> {
  return await page.evaluate(async ({ x, y, w, h }) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.sampleArea === undefined) throw new Error('no sampleArea hook');
    return await t.sampleArea(x, y, w, h);
  }, r);
}

async function camera(page: Page, view: 'surface' | 'underground'): Promise<CamView> {
  return await page.evaluate((v) => {
    const t = (window as unknown as { __phase9_test?: TestHook }).__phase9_test;
    if (t?.getCameraState === undefined) throw new Error('no getCameraState hook');
    return t.getCameraState()[v];
  }, view);
}

/** The canvas rect (logical px) of `cols` × `rows` tiles from (tileX, tileY), inset
 *  `inset` px from the outer tile edges, under camera `cam`. */
function tileRect(
  cam: CamView,
  tileX: number,
  tileY: number,
  cols: number,
  rows: number,
  inset: number,
): Rect {
  const viewportW = cam.viewW * cam.zoom;
  const sx = (tileX * TILE_SIZE_PX - cam.centerX) * cam.zoom + viewportW / 2;
  const sy = (tileY * TILE_SIZE_PX - cam.centerY) * cam.zoom + DEFAULT_LAYOUT.h / 2;
  const tile = TILE_SIZE_PX * cam.zoom;
  return {
    x: Math.round(sx + inset),
    y: Math.round(sy + inset),
    w: Math.round(cols * tile - 2 * inset),
    h: Math.round(rows * tile - 2 * inset),
  };
}

/** Whether the pixel at byte offset `i` (RGBA rows) differs between `a` and `b`
 *  by more than 2 in any of its three colour channels. */
function changed(a: number[], b: number[], i: number): boolean {
  return (
    Math.abs(a[i]! - b[i]!) > 2 ||
    Math.abs(a[i + 1]! - b[i + 1]!) > 2 ||
    Math.abs(a[i + 2]! - b[i + 2]!) > 2
  );
}

async function setOverlay(page: Page, on: boolean): Promise<void> {
  const showing = (await drawOrder(page)).includes('pheromone');
  if (showing !== on) await page.keyboard.press('p');
  await expect
    .poll(() => drawOrder(page))
    .toEqual(on ? ['terrain', 'pheromone', 'entities'] : ['terrain', 'entities']);
  if (on) await expect.poll(async () => (await layerDepths(page)).pheromoneDrawn).toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.screenshot({
    path: `test-results/pheromone-399-${name}.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
}

/** Load the planted save (overlay off: a fresh profile) and pause at once. */
async function bootPlanted(page: Page): Promise<void> {
  await bootFromSave(page, plantedWorld().save);
  const paused = await page.evaluate(
    () => (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.isPaused?.() ?? false,
  );
  if (!paused) await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __phase9_test?: TestHook }).__phase9_test?.isPaused?.() ?? null,
      ),
    )
    .toBe(true);
}

/** Terrain below the overlay, the overlay below the entity layer (strategic-zoom
 *  ant dots) and below every sprite an ant (or brood, food, the spider) is drawn
 *  with — and at least one ant sprite on show, so the check is not vacuous. */
function assertAntsAboveOverlay(d: LayerDepths, where: string): void {
  expect(d.pheromoneDrawn, where).toBe(true);
  expect(d.terrain.length, where).toBeGreaterThan(0);
  for (const t of d.terrain) expect(t, `${where} terrain`).toBeLessThan(d.pheromone);
  expect(d.pheromone, `${where} entity gfx`).toBeLessThan(d.entityGfx);
  const antSprites = d.sprites.filter((s) => ANT_LAYER_TEXTURES.has(s.texture));
  expect(
    antSprites.some((s) => s.texture === ANT_TEXTURE_WORKER || s.texture === ANT_TEXTURE_QUEEN),
    `${where}: ${JSON.stringify(d.sprites)}`,
  ).toBe(true);
  for (const s of antSprites) {
    expect(s.depth, `${where} ${s.texture}`).toBeGreaterThan(d.pheromone);
  }
}

test('#399 — overlay on: a strong trail is see-through (~35% alpha), a weak one not drawn; ants draw above it', async ({
  page,
}) => {
  const planted = plantedWorld();
  expect(planted.settled).toBeGreaterThan(0);
  expect(planted.queenUnderground).toBe(true);
  expect(planted.trailBefore).toBe(0);
  expect(planted.antDistance).toBeGreaterThanOrEqual(STRIP_ANT_CLEARANCE);
  await bootPlanted(page);
  expect(await drawOrder(page)).not.toContain('pheromone'); // off by default

  // --- Surface: the two strips, off / on / off again (frame-to-frame noise). ---
  const sc = await camera(page, 'surface');
  const strong = tileRect(sc, STRONG_TILE.tileX, STRONG_TILE.tileY, STRIP_LEN, 1, 2);
  const weak = tileRect(sc, WEAK_TILE.tileX, WEAK_TILE.tileY, STRIP_LEN, 1, 2);
  const offStrong = await sample(page, strong);
  const offWeak = await sample(page, weak);
  await shot(page, 'surface-off');
  await setOverlay(page, true);
  const onStrong = await sample(page, strong);
  const onWeak = await sample(page, weak);
  await setOverlay(page, false);
  const offStrong2 = await sample(page, strong);
  const offWeak2 = await sample(page, weak);
  await setOverlay(page, true);
  await shot(page, 'surface-on');

  // The strong strip: each overlay pixel blends the full-strength food colour
  // (0x00ff80: green 255) over the terrain at alpha a, so its green moves a of
  // the way to 255. Estimate a per pixel (where nothing else changed and the
  // terrain's green leaves room to read it); the median is the overlay's alpha.
  const alphas: number[] = [];
  let still = 0;
  for (let i = 0; i < offStrong.length; i += 4) {
    if (changed(offStrong, offStrong2, i)) continue;
    still++;
    const g0 = offStrong[i + 1]!;
    if (g0 > 200) continue;
    alphas.push((onStrong[i + 1]! - g0) / (255 - g0));
  }
  alphas.sort((a, b) => a - b);
  // Most of the strip is plain overlay over terrain (an ant or a tuft may cover a
  // little of it, and draws above).
  expect(alphas.length).toBeGreaterThan(still / 2);
  const median = alphas[alphas.length >> 1]!;
  expect(median).toBeGreaterThan(0.28);
  expect(median).toBeLessThan(0.42); // was 0.6 before #399
  // Nowhere on the strip is it near opaque.
  expect(alphas[Math.floor(alphas.length * 0.95)]!).toBeLessThan(0.45);

  // The weak strip: not drawn — it changes no more than the frame-to-frame noise.
  let diffOn = 0;
  let diffNoise = 0;
  for (let i = 0; i < offWeak.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      diffOn += Math.abs(onWeak[i + c]! - offWeak[i + c]!);
      diffNoise += Math.abs(offWeak2[i + c]! - offWeak[i + c]!);
    }
  }
  const px = offWeak.length / 4;
  expect(diffOn / px).toBeLessThanOrEqual(diffNoise / px + 1.5);

  // Surface layer order in the live scene: terrain < overlay < every ant layer.
  assertAntsAboveOverlay(await layerDepths(page), 'surface');

  // --- Underground (Tab → the own nest, on the Queen chamber where she sits). ---
  await page.keyboard.press('Tab');
  await expect.poll(() => activeView(page)).toBe('underground');
  await setOverlay(page, true);
  const below = await layerDepths(page);
  assertAntsAboveOverlay(below, 'underground');
  expect(below.sprites.some((s) => s.texture === ANT_TEXTURE_QUEEN)).toBe(true);
  await shot(page, 'underground-on');

  // In pixels: the trail square round the queen and the one in bare earth, on /
  // off / on again. Over bare earth the overlay changes (nearly) every pixel; over
  // the queen's square, what the entity layers draw there — the chamber's fill and
  // the queen in it — stays as it was: the overlay lies beneath them. (Which
  // sprite is the queen's, and its depth, the layer check above pins.)
  const uc = await camera(page, 'underground');
  const side = 2 * QUEEN_PATCH_HALF + 1;
  const queenBox = tileRect(
    uc,
    planted.queenTile.tileX - QUEEN_PATCH_HALF,
    planted.queenTile.tileY - QUEEN_PATCH_HALF,
    side,
    side,
    1,
  );
  const earthBox = tileRect(
    uc,
    planted.earthTile.tileX - QUEEN_PATCH_HALF,
    planted.earthTile.tileY - QUEEN_PATCH_HALF,
    side,
    side,
    1,
  );
  for (const r of [queenBox, earthBox]) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(DEFAULT_LAYOUT.w);
    expect(r.y + r.h).toBeLessThanOrEqual(DEFAULT_LAYOUT.h);
  }
  const onQueen = await sample(page, queenBox);
  const onEarth = await sample(page, earthBox);
  await setOverlay(page, false);
  const offQueen = await sample(page, queenBox);
  const offEarth = await sample(page, earthBox);
  await setOverlay(page, true);
  const onQueen2 = await sample(page, queenBox);
  const onEarth2 = await sample(page, earthBox);
  /** Pixels that stayed still on/on and did not change on/off: what the overlay
   *  does not reach. */
  const untouched = (on: number[], off: number[], on2: number[]): number => {
    let n = 0;
    for (let i = 0; i < on.length; i += 4) {
      if (!changed(on, on2, i) && !changed(on, off, i)) n++;
    }
    return n;
  };
  const earthUntouched = untouched(onEarth, offEarth, onEarth2);
  const queenUntouched = untouched(onQueen, offQueen, onQueen2);
  // Bare earth: the overlay covers it all.
  expect(earthUntouched).toBeLessThanOrEqual(onEarth.length / 4 / 50);
  // Round the queen: her chamber and her sprite stay untouched.
  expect(queenUntouched).toBeGreaterThan(40);
});
