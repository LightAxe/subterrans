// draw-pheromone.test.ts — Vitest unit tests for the pheromone heatmap overlay module.
//
// Uses MockGfx (spy recorder) to capture GfxLike calls without Phaser.
// All tests run in Node via Vitest — no browser, no Phaser install required.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  drawPheromoneOverlay,
  pheromoneIntensity,
  PHEROMONE_OVERLAY_DEPTH,
  PHEROMONE_VISUAL_MIN,
  PHEROMONE_VISUAL_MAX,
  MAX_PHEROMONE_ALPHA,
} from './draw-pheromone.js';
import {
  ANT_SPRITE_DEPTH,
  CARRIED_FOOD_DEPTH,
  ENTITY_GFX_DEPTH,
  SPIDER_SPRITE_DEPTH,
  STATIC_SPRITE_DEPTH,
} from './ant-sprite-layer.js';
import type { GfxLike } from './draw-surface.js';
import type { WorldState } from '../sim/types.js';
import { createWorldState } from '../sim/types.js';
import { createPheromoneGrid, phSet, pheromoneGridKey } from '../sim/pheromone/pheromone-store.js';
import { PheromoneType } from '../sim/enums.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import {
  TILE_SIZE_PX,
  COLOR_PHEROMONE_FOOD_FAINT,
  COLOR_PHEROMONE_FOOD_STRONG,
  lerpColor,
} from './sprites.js';
import { makeCameraView, type CameraView } from './camera-adapter.js';

// ---------------------------------------------------------------------------
// MockGfx — spy recorder implementing GfxLike
// ---------------------------------------------------------------------------

interface GfxCall {
  method: string;
  args: unknown[];
}

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];

  clear(): GfxLike {
    this.calls.push({ method: 'clear', args: [] });
    return this;
  }
  fillStyle(color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'fillStyle', args: [color, alpha] });
    return this;
  }
  lineStyle(width: number, color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'lineStyle', args: [width, color, alpha] });
    return this;
  }
  fillRect(x: number, y: number, w: number, h: number): GfxLike {
    this.calls.push({ method: 'fillRect', args: [x, y, w, h] });
    return this;
  }
  fillCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'fillCircle', args: [x, y, r] });
    return this;
  }
  strokeCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'strokeCircle', args: [x, y, r] });
    return this;
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): GfxLike {
    this.calls.push({ method: 'fillTriangle', args: [x0, y0, x1, y1, x2, y2] });
    return this;
  }

  callsOf(method: string): GfxCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Stage 2 world-space camera: the per-view camera is now a world-pixel
// CameraView. To frame on tile (cx, cy) we center on (cx × TILE_SIZE_PX,
// cy × TILE_SIZE_PX) at zoom 1, where the visible window is CANVAS_W/zoom ×
// CANVAS_H/zoom = 800 × 592 world px. The old viewport-in-tiles args (vpW/vpH)
// are gone — every fixture grid in this file is small enough to sit entirely
// inside that window, so the visible-tile counts these tests assert (non-zero
// tiles only, clamped to grid bounds) are unchanged by the wider window.
function makeCamera(cx: number, cy: number): CameraView {
  return makeCameraView(cx * TILE_SIZE_PX, cy * TILE_SIZE_PX);
}

/**
 * Build a WorldState and install a FoodTrail pheromone grid for the player
 * colony on the surface. Tiles are zero by default.
 */
function makeWorldWithFoodGrid(width: number, height: number): WorldState {
  const w = createWorldState(1);
  const key = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');
  w.pheromoneGrids[key] = createPheromoneGrid(width, height);
  return w;
}

// ---------------------------------------------------------------------------
// Tests: pheromoneIntensity (#399 — see-through, scaled by trail strength)
// ---------------------------------------------------------------------------

describe('#399 — pheromoneIntensity: alpha and colour follow trail strength', () => {
  it('a full-strength tile is see-through: at most 35% alpha (Rob: about 30–40%)', () => {
    expect(MAX_PHEROMONE_ALPHA).toBe(0.35);
    expect(MAX_PHEROMONE_ALPHA).toBeGreaterThanOrEqual(0.3);
    expect(MAX_PHEROMONE_ALPHA).toBeLessThanOrEqual(0.4);
  });

  it('weak trail is not drawn at all: 0 at or below PHEROMONE_VISUAL_MIN', () => {
    expect(PHEROMONE_VISUAL_MIN).toBe(1024);
    expect(pheromoneIntensity(0)).toBe(0);
    expect(pheromoneIntensity(128)).toBe(0); // the V14 food-trail floor
    expect(pheromoneIntensity(1024)).toBe(0); // one tick's deposit (FOOD_TRAIL_DEPOSIT_V14)
    expect(pheromoneIntensity(PHEROMONE_VISUAL_MIN)).toBe(0);
    expect(pheromoneIntensity(PHEROMONE_VISUAL_MIN + 1)).toBeGreaterThan(0);
  });

  it('rises with the log of the strength — a quarter per doubling — to 1 at PHEROMONE_VISUAL_MAX, and stays there', () => {
    expect(PHEROMONE_VISUAL_MAX).toBe(16384);
    expect(pheromoneIntensity(2048)).toBeCloseTo(0.25, 10);
    expect(pheromoneIntensity(4096)).toBeCloseTo(0.5, 10);
    expect(pheromoneIntensity(8192)).toBeCloseTo(0.75, 10);
    expect(pheromoneIntensity(Math.round(1024 * Math.SQRT2))).toBeCloseTo(0.125, 3);
    expect(pheromoneIntensity(PHEROMONE_VISUAL_MAX)).toBe(1);
    expect(pheromoneIntensity(65280)).toBe(1); // PHEROMONE_CAP
    // Monotone over the whole range a grid cell can hold.
    let prev = -1;
    for (let v = 0; v <= 65280; v += 64) {
      const t = pheromoneIntensity(v);
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      prev = t;
    }
  });

  it('only strong trails stand out: one deposit not drawn, a single pass faint, a busy route in full', () => {
    const alpha = (v: number) => pheromoneIntensity(v) * MAX_PHEROMONE_ALPHA;
    // One tick's deposit (1024): not drawn; a little more, barely.
    expect(alpha(1024)).toBe(0);
    expect(alpha(1500)).toBeLessThan(0.05);
    // A single forager pass (about two ticks' deposits a tile, ~2048): faint.
    expect(alpha(2048)).toBeLessThan(0.1);
    // A typical trail tile (the V68 playtest saves' per-save medians ran 270–3950):
    // faint — visible, but at most about half of full strength.
    expect(alpha(2200)).toBeGreaterThan(0.05);
    expect(alpha(2200)).toBeLessThan(MAX_PHEROMONE_ALPHA / 3);
    expect(alpha(3950)).toBeLessThan(MAX_PHEROMONE_ALPHA / 2);
    // A well-used route (≥ 16384) and the spider's lair (~32768): the full 35%.
    expect(alpha(16384)).toBe(MAX_PHEROMONE_ALPHA);
    expect(alpha(32768)).toBe(MAX_PHEROMONE_ALPHA);
  });
});

describe('#399 — the overlay draws beneath every layer ants are drawn on', () => {
  it('PHEROMONE_OVERLAY_DEPTH is below the entity gfx (ant dots), brood, ants, carried food and the spider', () => {
    for (const antLayer of [
      ENTITY_GFX_DEPTH,
      STATIC_SPRITE_DEPTH,
      ANT_SPRITE_DEPTH,
      CARRIED_FOOD_DEPTH,
      SPIDER_SPRITE_DEPTH,
    ]) {
      expect(PHEROMONE_OVERLAY_DEPTH).toBeLessThan(antLayer);
    }
    // …and above the terrain RenderTexture (depth -10, game-scene.ts).
    expect(PHEROMONE_OVERLAY_DEPTH).toBeGreaterThan(-10);
  });

  it('GameScene puts the overlay layer at PHEROMONE_OVERLAY_DEPTH and the entity gfx at ENTITY_GFX_DEPTH', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, 'game-scene.ts'), 'utf8');
    expect(src).toMatch(/this\.pheromoneGfx\.setDepth\(PHEROMONE_OVERLAY_DEPTH\)/);
    expect(src).toMatch(/this\.gfx\.setDepth\(ENTITY_GFX_DEPTH\)/);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawPheromoneOverlay — FoodTrail grid
// ---------------------------------------------------------------------------

describe('drawPheromoneOverlay — FoodTrail grid', () => {
  let gfx: MockGfx;
  let world: WorldState;

  beforeEach(() => {
    gfx = new MockGfx();
    // 5×1 row: [0, at the visibility floor, one doubling above it (¼), two (½),
    // full], so the ramp test sees strictly increasing alpha.
    world = makeWorldWithFoodGrid(5, 1);
    const key = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');
    const grid = world.pheromoneGrids[key]!;
    phSet(grid, 0, 0, 0);
    phSet(grid, 1, 0, PHEROMONE_VISUAL_MIN); // weak: not drawn
    phSet(grid, 2, 0, 2 * PHEROMONE_VISUAL_MIN); // ¼
    phSet(grid, 3, 0, 4 * PHEROMONE_VISUAL_MIN); // ½
    phSet(grid, 4, 0, PHEROMONE_VISUAL_MAX); // full
  });

  it('draws only the tiles strong enough to show (skips zero and weak tiles)', () => {
    const cam = makeCamera(2, 0.5);
    drawPheromoneOverlay(gfx, world, cam, 'surface');
    const rects = gfx.callsOf('fillRect');
    expect(rects.map((r) => r.args[0])).toEqual([2, 3, 4].map((tx) => tx * TILE_SIZE_PX));
  });

  it('each tile’s alpha is its intensity × MAX_PHEROMONE_ALPHA, its colour lerped faint → strong', () => {
    const cam = makeCamera(2, 0.5);
    drawPheromoneOverlay(gfx, world, cam, 'surface');
    const styles = gfx.callsOf('fillStyle');
    expect(styles.length).toBe(3);
    const expected = [0.25, 0.5, 1];
    styles.forEach((st, i) => {
      expect(st.args[1] as number).toBeCloseTo(expected[i]! * MAX_PHEROMONE_ALPHA, 10);
      expect(st.args[0]).toBe(
        lerpColor(COLOR_PHEROMONE_FOOD_FAINT, COLOR_PHEROMONE_FOOD_STRONG, expected[i]!),
      );
    });
    // Strictly increasing with strength; the strongest at the 35% cap, never above.
    const alphas = styles.map((st) => st.args[1] as number);
    expect(alphas[0]).toBeLessThan(alphas[1]!);
    expect(alphas[1]).toBeLessThan(alphas[2]!);
    expect(Math.max(...alphas)).toBe(MAX_PHEROMONE_ALPHA);
  });

  it('colour at ¼ strength is between faint and strong (not equal to either endpoint)', () => {
    const cam = makeCamera(2, 0.5);
    drawPheromoneOverlay(gfx, world, cam, 'surface');
    const color = gfx.callsOf('fillStyle')[0]!.args[0] as number;
    expect(color).not.toBe(COLOR_PHEROMONE_FOOD_FAINT);
    expect(color).not.toBe(COLOR_PHEROMONE_FOOD_STRONG);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawPheromoneOverlay — missing grid
// ---------------------------------------------------------------------------

describe('drawPheromoneOverlay — missing grid', () => {
  it('produces no fillRect calls and does not throw when grid key is absent', () => {
    const gfx = new MockGfx();
    const world = createWorldState(1); // no pheromoneGrids installed
    const cam = makeCamera(5, 5);
    expect(() => drawPheromoneOverlay(gfx, world, cam, 'surface')).not.toThrow();
    expect(gfx.callsOf('fillRect').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawPheromoneOverlay — both FoodTrail and DangerTrail
// ---------------------------------------------------------------------------

describe('drawPheromoneOverlay — both pheromone types', () => {
  it('produces 2 fillRect calls when one tile in each type grid is non-zero', () => {
    const gfx = new MockGfx();
    const world = createWorldState(1);

    // Install FoodTrail grid with one non-zero tile
    const foodKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');
    const foodGrid = createPheromoneGrid(4, 4);
    phSet(foodGrid, 2, 2, PHEROMONE_VISUAL_MAX);
    world.pheromoneGrids[foodKey] = foodGrid;

    // Install DangerTrail grid with one non-zero tile (different position)
    const dangerKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.DangerTrail, 'surface');
    const dangerGrid = createPheromoneGrid(4, 4);
    phSet(dangerGrid, 1, 1, PHEROMONE_VISUAL_MAX);
    world.pheromoneGrids[dangerKey] = dangerGrid;

    const cam = makeCamera(2, 2);
    drawPheromoneOverlay(gfx, world, cam, 'surface');

    expect(gfx.callsOf('fillRect').length).toBe(2);
  });

  it('FoodTrail uses FOOD colors, DangerTrail uses DANGER colors', () => {
    const gfx = new MockGfx();
    const world = createWorldState(1);

    // FoodTrail at (0,0)
    const foodKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');
    const foodGrid = createPheromoneGrid(4, 4);
    phSet(foodGrid, 0, 0, PHEROMONE_VISUAL_MAX);
    world.pheromoneGrids[foodKey] = foodGrid;

    // DangerTrail at (0,0) as well (same tile, separate grid iteration)
    const dangerKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.DangerTrail, 'surface');
    const dangerGrid = createPheromoneGrid(4, 4);
    phSet(dangerGrid, 0, 0, PHEROMONE_VISUAL_MAX);
    world.pheromoneGrids[dangerKey] = dangerGrid;

    const cam = makeCamera(2, 2);
    drawPheromoneOverlay(gfx, world, cam, 'surface');

    const styles = gfx.callsOf('fillStyle');
    const colors = styles.map((s) => s.args[0] as number);

    // At full intensity: food → FOOD_STRONG, danger → DANGER_STRONG
    expect(colors).toContain(COLOR_PHEROMONE_FOOD_STRONG);
    // Danger strong is 0xff4000 — just verify it's different from food
    const dangerStrongColor = 0xff4000;
    expect(colors).toContain(dangerStrongColor);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawPheromoneOverlay — underground zone
// ---------------------------------------------------------------------------

describe('drawPheromoneOverlay — underground zone', () => {
  it('reads underground pheromone grids (not surface) when zone="underground"', () => {
    const gfx = new MockGfx();
    const world = createWorldState(1);

    // Install underground FoodTrail grid
    const ugKey = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'underground');
    const ugGrid = createPheromoneGrid(4, 4);
    phSet(ugGrid, 1, 1, 4096);
    world.pheromoneGrids[ugKey] = ugGrid;

    // Surface key should NOT be read
    // (no surface grid installed)

    const cam = makeCamera(2, 2);
    drawPheromoneOverlay(gfx, world, cam, 'underground');

    expect(gfx.callsOf('fillRect').length).toBe(1); // one non-zero underground tile
  });
});

// ---------------------------------------------------------------------------
// Tests: drawPheromoneOverlay — enemy pheromones not rendered
// ---------------------------------------------------------------------------

describe('drawPheromoneOverlay — enemy colony pheromones excluded', () => {
  it('does not render enemy colony pheromone grids', () => {
    const gfx = new MockGfx();
    const world = createWorldState(1);
    const ENEMY_COLONY_ID = 2;

    // Install enemy FoodTrail grid with non-zero tiles
    const enemyKey = pheromoneGridKey(ENEMY_COLONY_ID, PheromoneType.FoodTrail, 'surface');
    const enemyGrid = createPheromoneGrid(4, 4);
    phSet(enemyGrid, 2, 2, PHEROMONE_VISUAL_MAX);
    world.pheromoneGrids[enemyKey] = enemyGrid;

    const cam = makeCamera(2, 2);
    drawPheromoneOverlay(gfx, world, cam, 'surface');

    // No player grids → no draws; enemy grid is never accessed
    expect(gfx.callsOf('fillRect').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawPheromoneOverlay — viewport clipping
// ---------------------------------------------------------------------------

describe('drawPheromoneOverlay — viewport clipping', () => {
  it('clips to grid bounds — does not render out-of-grid tiles', () => {
    const gfx = new MockGfx();
    // 2×2 grid, all non-zero
    const world = createWorldState(1);
    const key = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');
    const smallGrid = createPheromoneGrid(2, 2);
    phSet(smallGrid, 0, 0, 4096);
    phSet(smallGrid, 1, 0, 4096);
    phSet(smallGrid, 0, 1, 4096);
    phSet(smallGrid, 1, 1, 4096);
    world.pheromoneGrids[key] = smallGrid;

    // Huge viewport — should still produce only 4 fillRect calls (2×2 grid)
    const cam = makeCamera(0, 0);
    drawPheromoneOverlay(gfx, world, cam, 'surface');

    // Only 4 tiles exist; DangerTrail grid is absent (no calls from it)
    expect(gfx.callsOf('fillRect').length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// HUD-05 enforcement: draw-pheromone.ts source must not reference Image/Sprite etc.
// ---------------------------------------------------------------------------

describe('HUD-05 compliance — draw-pheromone.ts source', () => {
  it('contains no Phaser.GameObjects.Image, Sprite, load.image, load.spritesheet, load.atlas', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, 'draw-pheromone.ts'), 'utf8');
    expect(src).not.toMatch(/Phaser\.GameObjects\.Image/);
    expect(src).not.toMatch(/Phaser\.GameObjects\.Sprite/);
    expect(src).not.toMatch(/load\.image/);
    expect(src).not.toMatch(/load\.spritesheet/);
    expect(src).not.toMatch(/load\.atlas/);
  });
});
