// minimap.test.ts — Vitest unit tests for minimap.ts pure helpers.
//
// Uses the MockGfx recorder pattern from draw-surface.test.ts.
// Runs under Node with no Phaser.

import { describe, it, expect } from 'vitest';
import { TILE_SIZE_PX } from './sprites.js';
import { buildHudLayout } from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';
import { COLOR_BARREN_EARTH, COLOR_BARREN_EARTH_DARK } from './terrain-atlas.js';
import { createViewState } from './camera.js';
import {
  minimapClickToTile,
  applyMinimapClick,
  MINIMAP_SCALE_X,
  MINIMAP_SCALE_Y,
  drawMinimap,
  bakeMinimapDapple,
  drawMinimapBorder,
  drawMinimapEnemyFighters,
  drawMinimapGatheringRing,
  MINIMAP_BORDER_COLOR,
  MINIMAP_BORDER_OUTLINE_COLOR,
  MINIMAP_ENEMY_DOT_PX,
  COLOR_MINIMAP_ENEMY_FIGHTER,
  COLOR_MINIMAP_ENEMY_FIGHTER_BACKING,
  COLOR_MINIMAP_GATHERING_RING,
  MINIMAP_RING_MIN_R,
  MINIMAP_RING_MAX_R,
  MINIMAP_RING_PERIOD_MS,
} from './minimap.js';
import { GATHER_MIN_FIGHTERS } from './enemy-gathering.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';
import { AntTask } from '../sim/enums.js';
import type { GfxLike } from './draw-surface.js';
import { createWorldState } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import {
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from '../sim/constants.js';
import { SurfaceTileState, sgSet } from '../sim/terrain.js';
import { createColonyRecord, type ColonyRecord } from '../sim/colony/colony-store.js';
import { addPileForTest, type TestPile } from '../sim/food/food-test-utils.js';

// #238: minimap.ts now takes the built HUD layout; at the default 800×592 layout
// hud.MINIMAP == the former hud.MINIMAP, so these tests stay byte-identical.
const hud = buildHudLayout(DEFAULT_LAYOUT);

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
  piles?: readonly TestPile[];
  colonies?: WorldState['colonies'];
}): WorldState {
  // Base off a real WorldState (for its located food store, `world.food`) rather
  // than hand-building the storage shape — food-api-guard.test.ts pins storage
  // access to the facade / test-utils, so this stub only overrides the fields the
  // minimap tests actually stub out.
  const world = {
    ...createWorldState(0),
    tick: 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: [],
    ants: stubAnts,
    colonies: overrides?.colonies ?? {},
    pheromoneGrids: {},
    surface: stubSurface,
    undergroundGrids: {},
    pendingChambers: {},
  } as unknown as WorldState;
  for (const p of overrides?.piles ?? []) addPileForTest(world, p);
  return world;
}

// ---------------------------------------------------------------------------
// minimapClickToTile
// ---------------------------------------------------------------------------

describe('minimapClickToTile', () => {
  it('top-left corner of minimap returns tileX=0, tileY=0', () => {
    const result = minimapClickToTile(hud.MINIMAP.x, hud.MINIMAP.y, hud);
    expect(result).not.toBeNull();
    expect(result!.tileX).toBeCloseTo(0, 5);
    expect(result!.tileY).toBeCloseTo(0, 5);
  });

  it('center of minimap returns tileX=64, tileY=64', () => {
    const cx = hud.MINIMAP.x + hud.MINIMAP.w / 2;
    const cy = hud.MINIMAP.y + hud.MINIMAP.h / 2;
    const result = minimapClickToTile(cx, cy, hud);
    expect(result).not.toBeNull();
    expect(result!.tileX).toBeCloseTo(64, 5);
    expect(result!.tileY).toBeCloseTo(64, 5);
  });

  it('point (0, 0) far outside minimap returns null', () => {
    expect(minimapClickToTile(0, 0, hud)).toBeNull();
  });

  it('x just outside right edge returns null', () => {
    expect(minimapClickToTile(hud.MINIMAP.x + hud.MINIMAP.w, hud.MINIMAP.y, hud)).toBeNull();
  });

  it('y just outside bottom edge returns null', () => {
    expect(minimapClickToTile(hud.MINIMAP.x, hud.MINIMAP.y + hud.MINIMAP.h, hud)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyMinimapClick
// ---------------------------------------------------------------------------

describe('applyMinimapClick', () => {
  it('click at center sets surfaceCamera center to world px (1024, 1024) and returns true', () => {
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    const cx = hud.MINIMAP.x + hud.MINIMAP.w / 2;
    const cy = hud.MINIMAP.y + hud.MINIMAP.h / 2;
    const result = applyMinimapClick(vs, cx, cy, hud);
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
    const result = applyMinimapClick(vs, 0, 0, hud);
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
    const cx = hud.MINIMAP.x + hud.MINIMAP.w / 2;
    const cy = hud.MINIMAP.y + hud.MINIMAP.h / 2;
    applyMinimapClick(vs, cx, cy, hud);
    // X should be X-linked to the surface camera's clamped center X.
    expect(vs.undergroundCamera.centerX).toBe(vs.surfaceCamera.centerX);
    // centerY (depth) must be UNCHANGED — underground depth is independent (§A6).
    expect(vs.undergroundCamera.centerY).toBe(depthY);
  });

  it('when activeView=surface, click does NOT touch undergroundCamera.centerX', () => {
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    const origUnderX = vs.undergroundCamera.centerX;
    const cx = hud.MINIMAP.x + hud.MINIMAP.w / 2;
    const cy = hud.MINIMAP.y + hud.MINIMAP.h / 2;
    applyMinimapClick(vs, cx, cy, hud);
    // undergroundCamera.centerX should NOT change when in surface view
    expect(vs.undergroundCamera.centerX).toBe(origUnderX);
  });
});

// ---------------------------------------------------------------------------
// drawMinimap smoke test — checks basic call presence
// ---------------------------------------------------------------------------

function makeStubColony(): ColonyRecord {
  const colony = createColonyRecord(PLAYER_COLONY_ID, 0);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  colony.alarmActive = false;
  colony.workerCount = 3;
  // Phase 10 / CTRL-01' (LOCKED): targetRatio is two-field {forage, fight};
  // dig is auto-assigned via CTRL-06. Original 100/0/0 was the percentage
  // convention; preserved here as forage:100/fight:0 (matches D-04 default
  // "100% forage" semantic). taskCensus + computedAllocation remain 4-field
  // (WorkerAllocation per D-03).
  colony.targetRatio = { forage: 100, fight: 0 };
  return colony;
}

const stubColonies: WorldState['colonies'] = {
  [PLAYER_COLONY_ID]: makeStubColony(),
};

const stubPiles: TestPile[] = [
  {
    foodPileId: 1,
    tileX: 20,
    tileY: 30,
    pickupsRemaining: 50,
    pickupsInitial: 50,
  },
];

describe('drawMinimap smoke test', () => {
  it('calls fillRect for food piles, colonies, and viewport outline (base baked separately)', () => {
    const gfx = new MockGfx();
    const world = makeMinimalWorld({ piles: stubPiles, colonies: stubColonies });
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    drawMinimap(gfx, world, vs, hud);

    const fillRects = gfx.callsOf('fillRect');
    // #278 — the static base + dapple moved to bakeMinimapDapple, so drawMinimap
    // now emits only the DYNAMIC overlays: 1 food pile + 1 colony + 4 viewport = 6.
    expect(fillRects.length).toBeGreaterThanOrEqual(6);

    // #278 regression guard: drawMinimap must NOT redraw the full-minimap base —
    // no fillRect should span the whole minimap rect (that's the baked layer's job).
    const drawsFullBase = fillRects.some(
      (r) => r.args[2] === hud.MINIMAP.w && r.args[3] === hud.MINIMAP.h,
    );
    expect(drawsFullBase).toBe(false);

    // The first overlay is the food pile (2×2 centered on its minimap px).
    const mm = hud.MINIMAP;
    const sx = mm.w / SURFACE_GRID_WIDTH;
    const sy = mm.h / SURFACE_GRID_HEIGHT;
    const food = fillRects[0]!;
    expect(food.args[0]).toBeCloseTo(mm.x + 20 * sx - 1, 5);
    expect(food.args[1]).toBeCloseTo(mm.y + 30 * sy - 1, 5);
  });

  it('MINIMAP_SCALE_X and MINIMAP_SCALE_Y equal 1.25 for 128-tile world', () => {
    expect(MINIMAP_SCALE_X).toBeCloseTo(1.25, 5);
    expect(MINIMAP_SCALE_Y).toBeCloseTo(1.25, 5);
  });
});

// ---------------------------------------------------------------------------
// bakeMinimapDapple — the STATIC minimap layer (#278). UIScene stamps this once
// into a RenderTexture behind the per-frame overlays instead of redrawing the
// ~16k-tile dapple every frame. Coords are TEXTURE-LOCAL (origin 0,0).
// ---------------------------------------------------------------------------

describe('bakeMinimapDapple', () => {
  it('fills a barren-earth base + darker dapple, never a black box — PRD §7a', () => {
    // Regression (issue #40): the old minimap hardcoded 0x000000 as its base and
    // read as a black debug overlay. The baked layer uses barren-earth + a
    // deterministic darker dapple. Scatter dirt so the per-tile scan is exercised.
    const gfx = new MockGfx();
    sgSet(stubSurface, 10, 10, SurfaceTileState.Dirt);
    sgSet(stubSurface, 20, 30, SurfaceTileState.Dirt);
    sgSet(stubSurface, 50, 50, SurfaceTileState.Dirt);

    const world = makeMinimalWorld({ piles: [], colonies: stubColonies });
    bakeMinimapDapple(gfx, world, hud.MINIMAP.w, hud.MINIMAP.h);

    const styles = gfx.callsOf('fillStyle');
    const hasBlack = styles.some((c) => c.args[0] === 0x000000);
    expect(hasBlack).toBe(false);
    const hasEarth = styles.some((c) => c.args[0] === COLOR_BARREN_EARTH);
    expect(hasEarth).toBe(true);
    const hasDapple = styles.some((c) => c.args[0] === COLOR_BARREN_EARTH_DARK);
    expect(hasDapple).toBe(true);

    sgSet(stubSurface, 10, 10, SurfaceTileState.Grass);
    sgSet(stubSurface, 20, 30, SurfaceTileState.Grass);
    sgSet(stubSurface, 50, 50, SurfaceTileState.Grass);
  });

  it('bakes in TEXTURE-LOCAL coords: base at (0,0,w,h) and every dapple inside the rect', () => {
    // The RT is positioned at (mm.x, mm.y), so the bake must use 0-based coords —
    // NOT mm.x/mm.y offsets — or it would double-offset once drawn into the RT.
    // This guards the pixel-identity rationale (integer anchor + floored local
    // dapple == the old mm-anchored inline draw).
    const gfx = new MockGfx();
    const world = makeMinimalWorld({ piles: [], colonies: {} });
    const mmW = hud.MINIMAP.w;
    const mmH = hud.MINIMAP.h;
    bakeMinimapDapple(gfx, world, mmW, mmH);

    const fillRects = gfx.callsOf('fillRect');
    // First fillRect is the full-rect base at the texture origin.
    const base = fillRects[0]!;
    expect(base.args).toEqual([0, 0, mmW, mmH]);
    // Every subsequent dapple pixel is a 1×1 rect strictly inside [0,mmW)×[0,mmH).
    for (const r of fillRects.slice(1)) {
      const [x, y, w, h] = r.args as [number, number, number, number];
      expect(w).toBe(1);
      expect(h).toBe(1);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(mmW);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(mmH);
    }
  });
});

// ---------------------------------------------------------------------------
// #372 — the frame, enemy fighter dots and the gathering ring
// ---------------------------------------------------------------------------

/** fillRects grouped by the fillStyle colour in force when each was drawn. */
function rectsByColor(gfx: MockGfx): Map<number, number[][]> {
  const out = new Map<number, number[][]>();
  let color = -1;
  for (const c of gfx.calls) {
    if (c.method === 'fillStyle') color = c.args[0] as number;
    if (c.method === 'fillRect') {
      const list = out.get(color) ?? [];
      list.push(c.args as number[]);
      out.set(color, list);
    }
  }
  return out;
}

/** strokeCircle calls with the lineStyle [width, color, alpha] in force. */
function circles(gfx: MockGfx): { style: number[]; args: number[] }[] {
  const out: { style: number[]; args: number[] }[] = [];
  let style: number[] = [];
  for (const c of gfx.calls) {
    if (c.method === 'lineStyle') style = c.args as number[];
    if (c.method === 'strokeCircle') out.push({ style, args: c.args as number[] });
  }
  return out;
}

describe('#372 drawMinimapBorder — a visible frame outside the map', () => {
  it('a light 2px band hugging the rect inside a 1px dark line, covering no map pixel', () => {
    const gfx = new MockGfx();
    drawMinimapBorder(gfx, hud);
    const mm = hud.MINIMAP;
    const by = rectsByColor(gfx);
    const light = by.get(MINIMAP_BORDER_COLOR)!;
    const dark = by.get(MINIMAP_BORDER_OUTLINE_COLOR)!;
    expect(light).toEqual([
      [mm.x - 2, mm.y - 2, mm.w + 4, 2],
      [mm.x - 2, mm.y + mm.h, mm.w + 4, 2],
      [mm.x - 2, mm.y, 2, mm.h],
      [mm.x + mm.w, mm.y, 2, mm.h],
    ]);
    expect(dark).toEqual([
      [mm.x - 3, mm.y - 3, mm.w + 6, 1],
      [mm.x - 3, mm.y + mm.h + 2, mm.w + 6, 1],
      [mm.x - 3, mm.y - 2, 1, mm.h + 4],
      [mm.x + mm.w + 2, mm.y - 2, 1, mm.h + 4],
    ]);
    // Nothing overlaps the map rect.
    for (const [x, y, w, h] of [...light, ...dark]) {
      const inside = x! < mm.x + mm.w && x! + w! > mm.x && y! < mm.y + mm.h && y! + h! > mm.y;
      expect(inside).toBe(false);
    }
  });

  it('drawMinimap draws the frame', () => {
    const gfx = new MockGfx();
    const world = makeMinimalWorld({ colonies: stubColonies });
    drawMinimap(gfx, world, createViewState(PLAYER_START_X, PLAYER_START_Y), hud);
    expect(rectsByColor(gfx).get(MINIMAP_BORDER_COLOR)).toHaveLength(4);
  });
});

describe('#372 drawMinimapEnemyFighters — every enemy surface fighter, always', () => {
  const mm = hud.MINIMAP;
  const d = MINIMAP_ENEMY_DOT_PX;

  it('one dark backing + one red dot per enemy surface fighter, centred on it', () => {
    const { world: w } = raidWorld();
    addFighter(w, ENEMY_COLONY_ID, 40, 64, null);
    addFighter(w, ENEMY_COLONY_ID, 80, 20, null);
    const gfx = new MockGfx();
    drawMinimapEnemyFighters(gfx, w, hud, PLAYER_COLONY_ID);
    const by = rectsByColor(gfx);
    const red = by.get(COLOR_MINIMAP_ENEMY_FIGHTER)!;
    const back = by.get(COLOR_MINIMAP_ENEMY_FIGHTER_BACKING)!;
    expect(red).toHaveLength(2);
    expect(back).toHaveLength(2);
    // Tile centre 40.5 → mm.x + 50.625 → a 3px dot from round(49.125) = 49.
    expect(red[0]).toEqual([mm.x + 49, mm.y + Math.round(64.5 * 1.25 - 1.5), d, d]);
    expect(back[0]).toEqual([mm.x + 48, mm.y + Math.round(64.5 * 1.25 - 2.5), d + 2, d + 2]);
    // Backings all come before the dots (a crowd reads as one outlined blob).
    const firstRed = gfx.calls.findIndex(
      (c) => c.method === 'fillStyle' && c.args[0] === COLOR_MINIMAP_ENEMY_FIGHTER,
    );
    let lastBackRect = -1;
    gfx.calls.forEach((c, i) => {
      if (c.method === 'fillRect' && c.args[2] === d + 2) lastBackRect = i;
    });
    expect(lastBackRect).toBeLessThan(firstRed);
  });

  it('skips own, dead, underground and non-fighting ants', () => {
    const { world: w } = raidWorld();
    addFighter(w, PLAYER_COLONY_ID, 40, 64, null);
    addFighter(w, ENEMY_COLONY_ID, 40, 5, PLAYER_COLONY_ID);
    const dead = addFighter(w, ENEMY_COLONY_ID, 41, 64, null);

    w.ants.alive[dead] = 0;
    const worker = addFighter(w, ENEMY_COLONY_ID, 42, 64, null);

    w.ants.task[worker] = AntTask.Foraging;
    const gfx = new MockGfx();
    drawMinimapEnemyFighters(gfx, w, hud, PLAYER_COLONY_ID);
    expect(rectsByColor(gfx).get(COLOR_MINIMAP_ENEMY_FIGHTER) ?? []).toHaveLength(0);
  });

  it('CLNY-08: "enemy" is every colony but the viewer’s', () => {
    const { world: w } = raidWorld();
    addFighter(w, PLAYER_COLONY_ID, 40, 64, null);
    const gfx = new MockGfx();
    drawMinimapEnemyFighters(gfx, w, hud, ENEMY_COLONY_ID);
    expect(rectsByColor(gfx).get(COLOR_MINIMAP_ENEMY_FIGHTER)).toHaveLength(1);
  });

  it('dots at the map edge stay inside the map rect', () => {
    const { world: w } = raidWorld();
    const a = addFighter(w, ENEMY_COLONY_ID, 0, 0, null);
    const b = addFighter(w, ENEMY_COLONY_ID, 127, 127, null);

    w.ants.posX[a] = 0;

    w.ants.posY[a] = 0;

    w.ants.posX[b] = 128 * 256 - 1;
    const gfx = new MockGfx();
    drawMinimapEnemyFighters(gfx, w, hud, PLAYER_COLONY_ID);
    for (const [x, y, rw, rh] of [
      ...rectsByColor(gfx).get(COLOR_MINIMAP_ENEMY_FIGHTER)!,
      ...rectsByColor(gfx).get(COLOR_MINIMAP_ENEMY_FIGHTER_BACKING)!,
    ]) {
      expect(x).toBeGreaterThanOrEqual(mm.x);
      expect(y).toBeGreaterThanOrEqual(mm.y);
      expect(x! + rw!).toBeLessThanOrEqual(mm.x + mm.w);
      expect(y! + rh!).toBeLessThanOrEqual(mm.y + mm.h);
    }
  });

  it('drawMinimap draws the dots after the viewport outline (never hidden by it)', () => {
    const { world: w } = raidWorld();
    addFighter(w, ENEMY_COLONY_ID, 40, 64, null);
    const gfx = new MockGfx();
    drawMinimap(gfx, w, createViewState(PLAYER_START_X, PLAYER_START_Y), hud);
    const viewport = gfx.calls.findIndex((c) => c.method === 'fillStyle' && c.args[0] === 0xffffff);
    const red = gfx.calls.findIndex(
      (c) => c.method === 'fillStyle' && c.args[0] === COLOR_MINIMAP_ENEMY_FIGHTER,
    );
    expect(viewport).toBeGreaterThanOrEqual(0);
    expect(red).toBeGreaterThan(viewport);
  });
});

describe('#372 drawMinimapGatheringRing — a pulsing ring round a gathering army', () => {
  const mm = hud.MINIMAP;

  function gathered(n: number, x = 36, y = 62): WorldState {
    const { world: w } = raidWorld();
    for (let i = 0; i < n; i++)
      addFighter(w, ENEMY_COLONY_ID, x + (i % 4), y + ((i / 4) | 0), null);
    return w;
  }

  it('no ring below GATHER_MIN_FIGHTERS', () => {
    const gfx = new MockGfx();
    drawMinimapGatheringRing(gfx, gathered(GATHER_MIN_FIGHTERS - 1), hud, PLAYER_COLONY_ID, 0);
    expect(circles(gfx)).toHaveLength(0);
  });

  it('a red ring over a dark halo, centred on the army, pulsing in radius and alpha', () => {
    const w = gathered(GATHER_MIN_FIGHTERS);
    // Army box: tile centres 36.5..39.5 × 62.5..63.5.
    const cx = mm.x + ((36.5 + 39.5) / 2) * 1.25;
    const cy = mm.y + ((62.5 + 63.5) / 2) * 1.25;
    const period = MINIMAP_RING_PERIOD_MS;
    const low = new MockGfx();
    drawMinimapGatheringRing(low, w, hud, PLAYER_COLONY_ID, (period * 3) / 4); // sin = -1
    const high = new MockGfx();
    drawMinimapGatheringRing(high, w, hud, PLAYER_COLONY_ID, period / 4); // sin = +1
    const [haloLo, ringLo] = circles(low);
    const [, ringHi] = circles(high);
    expect(haloLo!.style).toEqual([4, 0x000000, 0.55]);
    expect(ringLo!.style[0]).toBe(2);
    expect(ringLo!.style[1]).toBe(COLOR_MINIMAP_GATHERING_RING);
    expect(ringLo!.style[2]).toBeCloseTo(0.55, 5);
    expect(ringHi!.style[2]).toBeCloseTo(1, 5);
    expect(ringLo!.args[0]).toBeCloseTo(cx, 5);
    expect(ringLo!.args[1]).toBeCloseTo(cy, 5);
    // A small army gets the minimum radius, +2 px at the pulse peak.
    expect(ringLo!.args[2]).toBeCloseTo(MINIMAP_RING_MIN_R, 5);
    expect(ringHi!.args[2]).toBeCloseTo(MINIMAP_RING_MIN_R + 2, 5);
    expect(haloLo!.args).toEqual(ringLo!.args);
  });

  it('the radius grows with a spread-out army, up to MINIMAP_RING_MAX_R', () => {
    const { world: w } = raidWorld();
    // Spread over 20 tiles east-west (all within 24 of the x-24 door).
    for (let i = 0; i < GATHER_MIN_FIGHTERS; i++)
      addFighter(w, ENEMY_COLONY_ID, 26 + 4 * i, 70, null);
    const gfx = new MockGfx();
    drawMinimapGatheringRing(gfx, w, hud, PLAYER_COLONY_ID, (MINIMAP_RING_PERIOD_MS * 3) / 4);
    const r = circles(gfx)[1]!.args[2]!;
    expect(r).toBeCloseTo((20 * 1.25) / 2 + 4, 5); // half the box diagonal + 4
    expect(r).toBeGreaterThan(MINIMAP_RING_MIN_R);
    const { world: far } = raidWorld();
    for (let i = 0; i < GATHER_MIN_FIGHTERS; i++) {
      const [x, y] = i % 2 === 0 ? [10 + i, 54] : [34 + i, 76]; // 14..18 tiles off the door
      addFighter(far, ENEMY_COLONY_ID, x, y, null);
    }
    const g2 = new MockGfx();
    drawMinimapGatheringRing(g2, far, hud, PLAYER_COLONY_ID, (MINIMAP_RING_PERIOD_MS * 3) / 4);
    expect(circles(g2)[1]!.args[2]).toBeCloseTo(MINIMAP_RING_MAX_R, 5);
  });

  it('near the map edge the ring is pulled inside the rect', () => {
    const { world: w, player } = raidWorld();
    player.entrances.push({ entranceId: 9000, surfaceTileX: 2, surfaceTileY: 2, isOpen: true });
    for (let i = 0; i < GATHER_MIN_FIGHTERS; i++)
      addFighter(w, ENEMY_COLONY_ID, i % 3, (i / 3) | 0, null);
    const gfx = new MockGfx();
    drawMinimapGatheringRing(gfx, w, hud, PLAYER_COLONY_ID, MINIMAP_RING_PERIOD_MS / 4);
    const [cx, cy, r] = circles(gfx)[0]!.args as [number, number, number];
    const reach = r + 2;
    expect(cx - reach).toBeGreaterThanOrEqual(mm.x - 1e-9);
    expect(cy - reach).toBeGreaterThanOrEqual(mm.y - 1e-9);
  });

  it('drawMinimap rings the army, on the frame time it is given', () => {
    const w = gathered(GATHER_MIN_FIGHTERS);
    const vs = createViewState(PLAYER_START_X, PLAYER_START_Y);
    const a = new MockGfx();
    drawMinimap(a, w, vs, hud, PLAYER_COLONY_ID, MINIMAP_RING_PERIOD_MS / 4);
    const b = new MockGfx();
    drawMinimap(b, w, vs, hud, PLAYER_COLONY_ID, (MINIMAP_RING_PERIOD_MS * 3) / 4);
    expect(circles(a)).toHaveLength(2);
    expect(circles(a)[1]!.args[2]).not.toBeCloseTo(circles(b)[1]!.args[2]!, 3);
    // Viewed from the enemy side, there is no army near its door.
    const c = new MockGfx();
    drawMinimap(c, w, vs, hud, ENEMY_COLONY_ID, 0);
    expect(circles(c)).toHaveLength(0);
  });
});
