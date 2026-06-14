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
  pheromoneRenderParams,
  PHEROMONE_VISUAL_MAX,
  MAX_PHEROMONE_ALPHA,
} from './draw-pheromone.js';
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
// Tests: pheromoneRenderParams
// ---------------------------------------------------------------------------

describe('pheromoneRenderParams', () => {
  it('value=0 → alpha=0, color=faintColor', () => {
    const result = pheromoneRenderParams(
      0,
      COLOR_PHEROMONE_FOOD_FAINT,
      COLOR_PHEROMONE_FOOD_STRONG,
    );
    expect(result.alpha).toBe(0);
    expect(result.color).toBe(COLOR_PHEROMONE_FOOD_FAINT);
  });

  it('value=PHEROMONE_VISUAL_MAX → alpha=MAX_PHEROMONE_ALPHA (0.6), color=strongColor', () => {
    const result = pheromoneRenderParams(
      PHEROMONE_VISUAL_MAX,
      COLOR_PHEROMONE_FOOD_FAINT,
      COLOR_PHEROMONE_FOOD_STRONG,
    );
    expect(result.alpha).toBeCloseTo(MAX_PHEROMONE_ALPHA, 10);
    expect(result.color).toBe(COLOR_PHEROMONE_FOOD_STRONG);
  });

  it('value=2×PHEROMONE_VISUAL_MAX → alpha capped at MAX_PHEROMONE_ALPHA (0.6)', () => {
    const result = pheromoneRenderParams(
      2 * PHEROMONE_VISUAL_MAX,
      COLOR_PHEROMONE_FOOD_FAINT,
      COLOR_PHEROMONE_FOOD_STRONG,
    );
    expect(result.alpha).toBeCloseTo(MAX_PHEROMONE_ALPHA, 10);
  });

  it('value=PHEROMONE_VISUAL_MAX/2, black→white → alpha≈0.3, color≈0x7f7f7f', () => {
    const result = pheromoneRenderParams(PHEROMONE_VISUAL_MAX / 2, 0x000000, 0xffffff);
    expect(result.alpha).toBeCloseTo(0.3, 10);
    // lerpColor(0, 0xffffff, 0.5) — each channel: 0 + 255*0.5 = 127 → 0x7f7f7f
    expect(result.color).toBe(0x7f7f7f);
  });

  it('normalized is correctly proportional for arbitrary values', () => {
    const quarter = pheromoneRenderParams(PHEROMONE_VISUAL_MAX / 4, 0x000000, 0xffffff);
    expect(quarter.alpha).toBeCloseTo(MAX_PHEROMONE_ALPHA * 0.25, 10);

    const threeQuarters = pheromoneRenderParams(PHEROMONE_VISUAL_MAX * 0.75, 0x000000, 0xffffff);
    expect(threeQuarters.alpha).toBeCloseTo(MAX_PHEROMONE_ALPHA * 0.75, 10);
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
    // 4×1 row: values at [0, ¼, ½, full] of PHEROMONE_VISUAL_MAX so the
    // ramp test sees strictly increasing alpha regardless of what VISUAL_MAX is.
    world = makeWorldWithFoodGrid(4, 1);
    const key = pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface');
    const grid = world.pheromoneGrids[key]!;
    phSet(grid, 0, 0, 0);
    phSet(grid, 1, 0, PHEROMONE_VISUAL_MAX >> 2); // ¼ → normalized 0.25
    phSet(grid, 2, 0, PHEROMONE_VISUAL_MAX >> 1); // ½ → normalized 0.5
    phSet(grid, 3, 0, PHEROMONE_VISUAL_MAX); // full → normalized 1.0
  });

  it('produces exactly 3 fillRect calls (skips the zero tile)', () => {
    const cam = makeCamera(2, 0.5);
    drawPheromoneOverlay(gfx, world, cam, 'surface');
    const rects = gfx.callsOf('fillRect');
    expect(rects.length).toBe(3);
  });

  it('alpha increases from first to last non-zero tile (ramp behavior)', () => {
    const cam = makeCamera(2, 0.5);
    drawPheromoneOverlay(gfx, world, cam, 'surface');
    const styles = gfx.callsOf('fillStyle');
    // fillStyle is called once per non-zero tile, in order tx=1,2,3
    expect(styles.length).toBe(3);
    const alphas = styles.map((s) => s.args[1] as number);
    // alpha should be strictly increasing
    expect(alphas[0]).toBeLessThan(alphas[1]!);
    expect(alphas[1]).toBeLessThan(alphas[2]!);
  });

  it('color at ¼-scale value (PHEROMONE_VISUAL_MAX >> 2) is between faint and strong (not equal to either endpoint)', () => {
    const cam = makeCamera(2, 0.5);
    drawPheromoneOverlay(gfx, world, cam, 'surface');
    const styles = gfx.callsOf('fillStyle');
    // First non-zero tile (tx=1, value = PHEROMONE_VISUAL_MAX >> 2 = 128) → normalized=0.25
    const color = styles[0]!.args[0] as number;
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
    phSet(ugGrid, 1, 1, 1024);
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
    phSet(smallGrid, 0, 0, 1024);
    phSet(smallGrid, 1, 0, 1024);
    phSet(smallGrid, 0, 1, 1024);
    phSet(smallGrid, 1, 1, 1024);
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
