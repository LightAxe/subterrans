// minimap.test.ts — Vitest unit tests for minimap.ts pure helpers.
//
// Uses the MockGfx recorder pattern from draw-surface.test.ts.
// Runs under Node with no Phaser.

import { describe, it, expect } from 'vitest';
import { HUD, TILE_SIZE_PX } from './sprites.js';
import { COLOR_BARREN_EARTH, COLOR_BARREN_EARTH_DARK } from './terrain-atlas.js';
import { createViewState } from './camera.js';
import {
  minimapClickToTile,
  applyMinimapClick,
  MINIMAP_SCALE_X,
  MINIMAP_SCALE_Y,
  drawMinimap,
} from './minimap.js';
import type { GfxLike } from './draw-surface.js';
import type { WorldState } from '../sim/types.js';
import {
  PLAYER_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from '../sim/constants.js';
import { SurfaceTileState, sgSet } from '../sim/terrain.js';

// ---------------------------------------------------------------------------
// MockGfx — records calls, does not render anything
// ---------------------------------------------------------------------------

interface GfxCall {
  method: string;
  args: unknown[];
}

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];
  private rec(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }
  clear() {
    return this.rec('clear', []);
  }
  fillStyle(c: number, a?: number) {
    return this.rec('fillStyle', [c, a]);
  }
  lineStyle(w: number, c: number, a?: number) {
    return this.rec('lineStyle', [w, c, a]);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    return this.rec('fillRect', [x, y, w, h]);
  }
  fillCircle(x: number, y: number, r: number) {
    return this.rec('fillCircle', [x, y, r]);
  }
  strokeCircle(x: number, y: number, r: number) {
    return this.rec('strokeCircle', [x, y, r]);
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
    return this.rec('fillTriangle', [x0, y0, x1, y1, x2, y2]);
  }
  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

// ---------------------------------------------------------------------------
// Minimal WorldState stub for minimap tests
// ---------------------------------------------------------------------------

const stubAnts = {
  posX: new Int32Array(10),
  posY: new Int32Array(10),
  alive: new Int32Array(10),
  task: new Int32Array(10),
  subTask: new Int32Array(10),
  colonyId: new Int32Array(10),
  speed: new Int32Array(10),
  foodCarrying: new Int32Array(10),
  starvationTimer: new Int32Array(10),
  age: new Int32Array(10),
  lifespan: new Int32Array(10),
  zone: new Int32Array(10),
  digTileX: new Int32Array(10).fill(-1),
  digTileY: new Int32Array(10).fill(-1),
  digTicksRemaining: new Int32Array(10),
  targetPosX: new Int32Array(10).fill(-1),
  targetPosY: new Int32Array(10).fill(-1),
} as unknown as WorldState['ants'];

const stubSurface = {
  width: 128,
  height: 128,
  data: new Uint8Array(128 * 128),
} as unknown as WorldState['surface'];

function makeMinimalWorld(overrides?: {
  foodPiles?: WorldState['foodPiles'];
  colonies?: WorldState['colonies'];
}): WorldState {
  return {
    tick: 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: [],
    ants: stubAnts,
    colonies: overrides?.colonies ?? {},
    pheromoneGrids: {},
    surface: stubSurface,
    undergroundGrids: {},
    foodPiles: overrides?.foodPiles ?? [],
    pendingChambers: {},
  } as unknown as WorldState;
}

// ---------------------------------------------------------------------------
// minimapClickToTile
// ---------------------------------------------------------------------------

describe('minimapClickToTile', () => {
  it('top-left corner of minimap returns tileX=0, tileY=0', () => {
    const result = minimapClickToTile(HUD.MINIMAP.x, HUD.MINIMAP.y);
    expect(result).not.toBeNull();
    expect(result!.tileX).toBeCloseTo(0, 5);
    expect(result!.tileY).toBeCloseTo(0, 5);
  });

  it('center of minimap returns tileX=64, tileY=64', () => {
    const cx = HUD.MINIMAP.x + HUD.MINIMAP.w / 2;
    const cy = HUD.MINIMAP.y + HUD.MINIMAP.h / 2;
    const result = minimapClickToTile(cx, cy);
    expect(result).not.toBeNull();
    expect(result!.tileX).toBeCloseTo(64, 5);
    expect(result!.tileY).toBeCloseTo(64, 5);
  });

  it('point (0, 0) far outside minimap returns null', () => {
    expect(minimapClickToTile(0, 0)).toBeNull();
  });

  it('x just outside right edge returns null', () => {
    expect(minimapClickToTile(HUD.MINIMAP.x + HUD.MINIMAP.w, HUD.MINIMAP.y)).toBeNull();
  });

  it('y just outside bottom edge returns null', () => {
    expect(minimapClickToTile(HUD.MINIMAP.x, HUD.MINIMAP.y + HUD.MINIMAP.h)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyMinimapClick
// ---------------------------------------------------------------------------

describe('applyMinimapClick', () => {
  it('click at center sets surfaceCamera center to world px (1024, 1024) and returns true', () => {
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    const cx = HUD.MINIMAP.x + HUD.MINIMAP.w / 2;
    const cy = HUD.MINIMAP.y + HUD.MINIMAP.h / 2;
    const result = applyMinimapClick(vs, cx, cy);
    expect(result).toBe(true);
    // Minimap center → tile (64, 64) → world px (64×16, 64×16) = (1024, 1024).
    // At zoom 1 the surface clamp ([400,1648]×[296,1752]) leaves both untouched.
    const clickedTileX = SURFACE_GRID_WIDTH / 2; // 64
    const clickedTileY = SURFACE_GRID_HEIGHT / 2; // 64
    expect(vs.surfaceCamera.centerX).toBeCloseTo(clickedTileX * TILE_SIZE_PX, 0);
    expect(vs.surfaceCamera.centerY).toBeCloseTo(clickedTileY * TILE_SIZE_PX, 0);
    expect(vs.activeView).toBe('surface'); // unchanged
  });

  it('click outside minimap returns false and does not mutate', () => {
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    const origX = vs.surfaceCamera.centerX;
    const origY = vs.surfaceCamera.centerY;
    const result = applyMinimapClick(vs, 0, 0);
    expect(result).toBe(false);
    expect(vs.surfaceCamera.centerX).toBe(origX);
    expect(vs.surfaceCamera.centerY).toBe(origY);
  });

  it('when activeView=underground, click syncs undergroundCamera.centerX but PRESERVES centerY (depth)', () => {
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    vs.activeView = 'underground';
    // Pick a depth (world px) that survives the underground clamp at zoom 1
    // (centerY range [296, 728] for the 1024-px-tall underground world), so the
    // depth-preservation assertion tests preservation, not the clamp. §A6.
    const depthY = 500;
    vs.undergroundCamera.centerY = depthY;
    const cx = HUD.MINIMAP.x + HUD.MINIMAP.w / 2;
    const cy = HUD.MINIMAP.y + HUD.MINIMAP.h / 2;
    applyMinimapClick(vs, cx, cy);
    // X should be X-linked to the surface camera's clamped center X.
    expect(vs.undergroundCamera.centerX).toBe(vs.surfaceCamera.centerX);
    // centerY (depth) must be UNCHANGED — underground depth is independent (§A6).
    expect(vs.undergroundCamera.centerY).toBe(depthY);
  });

  it('when activeView=surface, click does NOT touch undergroundCamera.centerX', () => {
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    const origUnderX = vs.undergroundCamera.centerX;
    const cx = HUD.MINIMAP.x + HUD.MINIMAP.w / 2;
    const cy = HUD.MINIMAP.y + HUD.MINIMAP.h / 2;
    applyMinimapClick(vs, cx, cy);
    // undergroundCamera.centerX should NOT change when in surface view
    expect(vs.undergroundCamera.centerX).toBe(origUnderX);
  });
});

// ---------------------------------------------------------------------------
// drawMinimap smoke test — checks basic call presence
// ---------------------------------------------------------------------------

const stubColonies: WorldState['colonies'] = {
  [PLAYER_COLONY_ID]: {
    colonyId: PLAYER_COLONY_ID,
    queenEntityId: 0,
    entrances: [],
    workerCount: 3,
    foodStored: 0,
    queenStarvationTimer: 100,
    taskCensus: { nurse: 0, forage: 0, dig: 0, fight: 0 },
    // Phase 10 / CTRL-01' (LOCKED): targetRatio is two-field {forage, fight};
    // dig is auto-assigned via CTRL-06. Original 100/0/0 was the percentage
    // convention; preserved here as forage:100/fight:0 (matches D-04 default
    // "100% forage" semantic). taskCensus + computedAllocation remain 4-field
    // (WorkerAllocation per D-03).
    targetRatio: { forage: 100, fight: 0 },
    computedAllocation: { nurse: 0, forage: 0, dig: 0, fight: 0 },
    eggCount: 0,
    larvaeCount: 0,
    nurseCount: 0,
    eggs: [],
    larvae: [],
    workers: [],
    chambers: [],
    defeated: false,
    reconcileCountdown: 0,
    rallyPoint: null,
    digFlowFieldDirty: false,
    foodFlowFieldDirty: false,
    killCount: 0,
    priorityFoodPileId: null,
    queenLastEggTick: -300,
    eggIntervalNumerator: 4,
  } as WorldState['colonies'][number],
};

const stubFoodPiles: WorldState['foodPiles'] = [
  {
    foodPileId: 1,
    tileX: 20,
    tileY: 30,
    pickupsRemaining: 50,
    pickupsInitial: 50,
  } as WorldState['foodPiles'][0],
];

describe('drawMinimap smoke test', () => {
  it('calls fillRect for background, food piles, colonies, and viewport outline', () => {
    const gfx = new MockGfx();
    const world = makeMinimalWorld({ foodPiles: stubFoodPiles, colonies: stubColonies });
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    drawMinimap(gfx, world, vs);

    const fillRects = gfx.callsOf('fillRect');
    // Should have at least: 1 background + 1 food pile + 1 colony + 4 viewport outline = 7
    expect(fillRects.length).toBeGreaterThanOrEqual(7);

    // First fillRect is the grass background covering the full minimap
    const bg = fillRects[0]!;
    expect(bg.args[0]).toBe(HUD.MINIMAP.x);
    expect(bg.args[1]).toBe(HUD.MINIMAP.y);
    expect(bg.args[2]).toBe(HUD.MINIMAP.w);
    expect(bg.args[3]).toBe(HUD.MINIMAP.h);
  });

  it('MINIMAP_SCALE_X and MINIMAP_SCALE_Y equal 1.25 for 128-tile world', () => {
    expect(MINIMAP_SCALE_X).toBeCloseTo(1.25, 5);
    expect(MINIMAP_SCALE_Y).toBeCloseTo(1.25, 5);
  });

  it('renders a surface overview (not a black box) — PRD §7a', () => {
    // Regression: prior version hardcoded 0x000000 as the minimap background,
    // so the minimap read as a black debug overlay. The fix uses grass as the
    // base and overlays dirt tiles from world.surface.
    const gfx = new MockGfx();
    // Scatter a few dirt tiles so we can assert the dirt path fires
    sgSet(stubSurface, 10, 10, SurfaceTileState.Dirt);
    sgSet(stubSurface, 20, 30, SurfaceTileState.Dirt);
    sgSet(stubSurface, 50, 50, SurfaceTileState.Dirt);

    const world = makeMinimalWorld({ foodPiles: [], colonies: stubColonies });
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    drawMinimap(gfx, world, vs);

    const styles = gfx.callsOf('fillStyle');
    // No black background anywhere.
    const hasBlack = styles.some((c) => c.args[0] === 0x000000);
    expect(hasBlack).toBe(false);
    // Issue #40 reframe: minimap base is barren-earth, not grass-green. The
    // surface terrain at large now reads as ant-scale ground, and the
    // minimap must mirror that so the player's mental model matches.
    const hasEarth = styles.some((c) => c.args[0] === COLOR_BARREN_EARTH);
    expect(hasEarth).toBe(true);
    // A darker dapple is sprinkled deterministically per tile — gives the
    // minimap a textured feel rather than a flat brown rectangle.
    const hasDapple = styles.some((c) => c.args[0] === COLOR_BARREN_EARTH_DARK);
    expect(hasDapple).toBe(true);

    // Cleanup so other tests see a clean surface
    sgSet(stubSurface, 10, 10, SurfaceTileState.Grass);
    sgSet(stubSurface, 20, 30, SurfaceTileState.Grass);
    sgSet(stubSurface, 50, 50, SurfaceTileState.Grass);
  });
});
