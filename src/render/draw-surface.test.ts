// draw-surface.test.ts — Vitest unit tests for the surface view drawing module.
//
// Uses MockGfx (GfxLike spy) for terrain/food/entrance/rally primitives and
// MockAntSprites (AntSpriteLayer spy) for ant draws. All tests run in Node
// via Vitest — no browser, no Phaser install required.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  drawSurfaceTerrain,
  drawSurfaceEntities,
  drawSurface,
} from './draw-surface.js';
import type { GfxLike } from './draw-surface.js';
import type {
  AntSpriteDrawOptions,
  AntSpriteLayer,
  StaticSpriteDrawOptions,
} from './ant-sprite-layer.js';
import type { WorldState } from '../sim/types.js';
import { createWorldState } from '../sim/types.js';
import { sgSet, SurfaceTileState } from '../sim/terrain.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import { AntFacingCache } from './ant-facing-cache.js';
import {
  TILE_SIZE_PX,
  // Issue #40: legacy palette names — kept here only for the small number
  // of remaining surface-entity tests that may still reference them. Surface
  // terrain now uses the procedural-art palette from terrain-atlas.ts.
  COLOR_FOOD_PILE_NORMAL,
  COLOR_FOOD_PILE_MARKED,
  COLOR_PLAYER_COLONY,
  COLOR_ENEMY_COLONY,
  COLOR_RALLY_POINT,
} from './sprites.js';
import { COLOR_BARREN_EARTH } from './terrain-atlas.js';
import type { CameraState } from './camera.js';

// ---------------------------------------------------------------------------
// MockGfx — spy recorder implementing GfxLike
// ---------------------------------------------------------------------------

interface GfxCall {
  method: string;
  args: unknown[];
}

type Rect = { x: number; y: number; w: number; h: number };

class MockGfx implements GfxLike {
  calls: GfxCall[] = [];

  clear(): GfxLike { this.calls.push({ method: 'clear', args: [] }); return this; }
  fillStyle(color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'fillStyle', args: [color, alpha] }); return this;
  }
  lineStyle(width: number, color: number, alpha?: number): GfxLike {
    this.calls.push({ method: 'lineStyle', args: [width, color, alpha] }); return this;
  }
  fillRect(x: number, y: number, w: number, h: number): GfxLike {
    this.calls.push({ method: 'fillRect', args: [x, y, w, h] }); return this;
  }
  fillCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'fillCircle', args: [x, y, r] }); return this;
  }
  strokeCircle(x: number, y: number, r: number): GfxLike {
    this.calls.push({ method: 'strokeCircle', args: [x, y, r] }); return this;
  }
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): GfxLike {
    this.calls.push({ method: 'fillTriangle', args: [x0, y0, x1, y1, x2, y2] }); return this;
  }

  /** Filter calls by method name. */
  callsOf(method: string): GfxCall[] {
    return this.calls.filter(c => c.method === method);
  }

  reset(): void { this.calls = []; }
}

// ---------------------------------------------------------------------------
// MockAntSprites — spy recorder implementing AntSpriteLayer
// ---------------------------------------------------------------------------

class MockAntSprites implements AntSpriteLayer {
  calls: AntSpriteDrawOptions[] = [];
  staticCalls: StaticSpriteDrawOptions[] = [];
  beginFrames = 0;
  endFrames = 0;
  beginFrame(): void { this.beginFrames++; }
  drawAnt(opts: AntSpriteDrawOptions): void { this.calls.push({ ...opts }); }
  drawStatic(opts: StaticSpriteDrawOptions): void { this.staticCalls.push({ ...opts }); }
  endFrame(): void { this.endFrames++; }
  reset(): void {
    this.calls = []; this.staticCalls = [];
    this.beginFrames = 0; this.endFrames = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal camera centered at (cx, cy) with given viewport. */
function makeCamera(cx: number, cy: number, vpW: number, vpH: number): CameraState {
  return { x: cx, y: cy, viewportWidth: vpW, viewportHeight: vpH };
}

/** Build a WorldState with a small surface grid seeded with alternating Grass/Dirt. */
function makeWorld4x4(): WorldState {
  const w = createWorldState(1);
  sgSet(w.surface, 2, 0, SurfaceTileState.Dirt);
  sgSet(w.surface, 3, 0, SurfaceTileState.Dirt);
  sgSet(w.surface, 2, 1, SurfaceTileState.Dirt);
  sgSet(w.surface, 3, 1, SurfaceTileState.Dirt);
  return w;
}

/** Collect every fillRect that falls within a single tile's screen window.
 *  Used by the panning-stability test below — proves the same tile produces
 *  the same draws regardless of where the camera centers it on screen. */
function textureRectsInsideTile(gfx: MockGfx, screenX: number, screenY: number): Rect[] {
  const rects: Rect[] = [];
  for (const call of gfx.calls) {
    if (call.method !== 'fillRect') continue;
    const [x, y, w, h] = call.args as [number, number, number, number];
    if (x >= screenX && y >= screenY && x + w <= screenX + TILE_SIZE_PX && y + h <= screenY + TILE_SIZE_PX) {
      rects.push({ x: x - screenX, y: y - screenY, w, h });
    }
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Tests: drawSurfaceTerrain
// ---------------------------------------------------------------------------

describe('drawSurfaceTerrain', () => {
  let gfx: MockGfx;

  beforeEach(() => { gfx = new MockGfx(); });

  it('renders every visible tile with the barren-earth substrate (issue #40)', () => {
    // Issue #40: surface is universally barren-earth substrate (with motifs
    // scattered on top per tile hash). Every visible tile should produce at
    // least one barren-earth fillStyle.
    const world = makeWorld4x4();
    const cam = makeCamera(1.5, 1.5, 3, 3);
    drawSurfaceTerrain(gfx, world, cam);
    const earthStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_BARREN_EARTH);
    // 4×4 visible tiles = 16; each tile applies the barren-earth fill once.
    expect(earthStyles.length).toBe(16);
  });

  it('keeps texture placement stable for the same world tile as the camera pans', () => {
    const world = createWorldState(1);
    const tileX = 20;
    const tileY = 20;

    const camA = makeCamera(20, 20, 20, 20);
    drawSurfaceTerrain(gfx, world, camA);
    const leftA = Math.floor(camA.x - camA.viewportWidth / 2);
    const topA = Math.floor(camA.y - camA.viewportHeight / 2);
    const rectsA = textureRectsInsideTile(gfx, (tileX - leftA) * TILE_SIZE_PX, (tileY - topA) * TILE_SIZE_PX);

    gfx.reset();
    const camB = makeCamera(21, 20, 20, 20);
    drawSurfaceTerrain(gfx, world, camB);
    const leftB = Math.floor(camB.x - camB.viewportWidth / 2);
    const topB = Math.floor(camB.y - camB.viewportHeight / 2);
    const rectsB = textureRectsInsideTile(gfx, (tileX - leftB) * TILE_SIZE_PX, (tileY - topB) * TILE_SIZE_PX);

    expect(rectsA.length).toBeGreaterThan(0);
    expect(rectsA).toEqual(rectsB);
  });

  it('clips viewport to grid bounds — no fillRect with negative tx or ty offset', () => {
    const world = createWorldState(1);
    const cam = makeCamera(0, 64, 50, 37);
    drawSurfaceTerrain(gfx, world, cam);
    const rects = gfx.callsOf('fillRect');
    for (const r of rects) {
      const screenX = r.args[0] as number;
      expect(screenX).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps right/bottom to grid bounds on large viewport (perf budget — issue #40)', () => {
    const world = createWorldState(1);
    for (let y = 0; y < world.surface.height; y++) {
      for (let x = 0; x < world.surface.width; x++) {
        sgSet(world.surface, x, y, SurfaceTileState.Dirt);
      }
    }
    const cam = makeCamera(0, 0, 200, 200);
    drawSurfaceTerrain(gfx, world, cam);
    // Per-tile fillRect budget — explicit ceiling, bumped intentionally as
    // each kind of large feature has scaled up:
    //   - Issue #40 (PR #41) set the budget at 30 per tile to cover the
    //     procedural-art system (substrate dithering + sparse specks +
    //     small motifs).
    //   - Issue #44 step 3 raises it to 50 per tile. The 3×3 / 4×2 / 3×4
    //     large features added in this step cover up to 12 tiles each
    //     with denser pixel art (boulders ~150 px, big leaves with vein
    //     lines ~200 px) than the old 2×2 sprites; observed worst-case
    //     all-Dirt 200×200 viewport now lands ~640k fillRects (~39/tile).
    //     50/tile leaves headroom without blessing uncapped growth.
    //
    // Beyond 50/tile suggests a regression — uncapped per-pixel iteration
    // creep, accidentally-removed sparseness gates, or a motif probability
    // blown out.
    expect(gfx.callsOf('fillRect').length).toBeLessThanOrEqual(128 * 128 * 50);
  });

  it('produces deterministic terrain renders for the same seed (issue #40 — replay-stable visuals)', () => {
    const world = makeWorld4x4();
    const a = new MockGfx();
    const b = new MockGfx();
    drawSurfaceTerrain(a, world, makeCamera(1.5, 1.5, 3, 3));
    drawSurfaceTerrain(b, world, makeCamera(1.5, 1.5, 3, 3));
    expect(a.calls).toEqual(b.calls);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawSurfaceEntities
// ---------------------------------------------------------------------------

describe('drawSurfaceEntities', () => {
  let gfx: MockGfx;
  let sprites: MockAntSprites;
  let world: WorldState;

  beforeEach(() => {
    gfx = new MockGfx();
    sprites = new MockAntSprites();
    world = createWorldState(1);
  });

  it('draws 2 fillCircle calls for two food piles (one marked, one normal)', () => {
    const playerColony = createColonyRecord(PLAYER_COLONY_ID, 999);
    playerColony.entrances = [];
    playerColony.rallyPoint = null;
    playerColony.digFlowFieldDirty = false;
    playerColony.priorityFoodPileId = 1;
    world.colonies[PLAYER_COLONY_ID] = playerColony;
    world.foodPiles.push({ foodPileId: 1, tileX: 5, tileY: 5 });
    world.foodPiles.push({ foodPileId: 2, tileX: 6, tileY: 5 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    const circles = gfx.callsOf('fillCircle');
    expect(circles.length).toBe(2);
  });

  it('colors the player colony priority pile with COLOR_FOOD_PILE_MARKED', () => {
    const playerColony = createColonyRecord(PLAYER_COLONY_ID, 999);
    playerColony.entrances = [];
    playerColony.rallyPoint = null;
    playerColony.digFlowFieldDirty = false;
    playerColony.priorityFoodPileId = 1;
    world.colonies[PLAYER_COLONY_ID] = playerColony;
    world.foodPiles.push({ foodPileId: 1, tileX: 5, tileY: 5 });
    world.foodPiles.push({ foodPileId: 2, tileX: 6, tileY: 5 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    const markedStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_FOOD_PILE_MARKED);
    const normalStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_FOOD_PILE_NORMAL);
    expect(markedStyles.length).toBe(1);
    expect(normalStyles.length).toBe(1);
  });

  it('does not render an enemy colony priority pile as marked on the player HUD', () => {
    const playerColony = createColonyRecord(PLAYER_COLONY_ID, 999);
    playerColony.entrances = [];
    playerColony.rallyPoint = null;
    playerColony.digFlowFieldDirty = false;
    playerColony.priorityFoodPileId = null;
    const enemyColonyId = PLAYER_COLONY_ID + 1;
    const enemyColony = createColonyRecord(enemyColonyId, 888);
    enemyColony.entrances = [];
    enemyColony.rallyPoint = null;
    enemyColony.digFlowFieldDirty = false;
    enemyColony.priorityFoodPileId = 1;
    world.colonies[PLAYER_COLONY_ID] = playerColony;
    world.colonies[enemyColonyId] = enemyColony;
    world.foodPiles.push({ foodPileId: 1, tileX: 5, tileY: 5 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    const markedStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_FOOD_PILE_MARKED);
    expect(markedStyles.length).toBe(0);
  });

  it('preserves sub-tile fixed-point precision when projecting ant position to pixels', () => {
    // Regression: previous code did `(posX >> FP_SHIFT) * TILE_SIZE_PX`, which
    // truncated sub-tile precision before multiplying by tile size. The sprite
    // layer now receives screen-space pixels directly, so the same assertion
    // applies: an ant at tile 10.5 must land at pixel 10.5 * TILE_SIZE_PX.
    const prev = createWorldState(1);
    const curr = createWorldState(1);
    const workerId = 0;
    const colonyId = PLAYER_COLONY_ID;
    const colony = createColonyRecord(colonyId, 99);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    curr.colonies[colonyId] = colony;
    prev.colonies[colonyId] = colony;

    const HALF_FP = 128;
    initAnt(prev.ants, workerId, {
      colonyId,
      posX: (10 << FP_SHIFT) + HALF_FP,
      posY: (5 << FP_SHIFT)  + HALF_FP,
      zone: 0,
    });
    initAnt(curr.ants, workerId, {
      colonyId,
      posX: (10 << FP_SHIFT) + HALF_FP,
      posY: (5 << FP_SHIFT)  + HALF_FP,
      zone: 0,
    });

    const cam = makeCamera(10, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, prev, curr, 0, cam);

    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const expectedScreenX = 10.5 * TILE_SIZE_PX - left * TILE_SIZE_PX;
    const expectedScreenY = 5.5  * TILE_SIZE_PX - top  * TILE_SIZE_PX;
    const antCall = sprites.calls.find(c =>
      c.kind === 'worker' &&
      Math.abs(c.x - expectedScreenX) < 0.01 &&
      Math.abs(c.y - expectedScreenY) < 0.01,
    );
    expect(antCall).toBeDefined();
  });

  it('interpolates ant position at alpha=0.5 to halfway between prev and curr', () => {
    const prev = createWorldState(1);
    const curr = createWorldState(1);
    const queenId = 99;
    const workerId = 0;
    const colonyId = PLAYER_COLONY_ID;

    const colony = createColonyRecord(colonyId, queenId);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    curr.colonies[colonyId] = colony;
    prev.colonies[colonyId] = colony;

    initAnt(prev.ants, workerId, { colonyId, posX: 10 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });
    initAnt(curr.ants, workerId, { colonyId, posX: 20 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });

    const cam = makeCamera(15, 5, 50, 37);
    drawSurfaceEntities(gfx, sprites, prev, curr, 0.5, cam);

    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const expectedScreenX = (10 * 16 + (20 * 16 - 10 * 16) * 0.5) - left * TILE_SIZE_PX;
    const antCall = sprites.calls.find(c =>
      c.kind === 'worker' && Math.abs(c.x - expectedScreenX) < 0.5,
    );
    expect(antCall).toBeDefined();
  });

  it('draws queen sprite (kind=queen) when ant id matches queenEntityId', () => {
    const antId = 0;
    const colonyId = PLAYER_COLONY_ID;

    const colony = createColonyRecord(colonyId, antId); // queen = antId 0
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[colonyId] = colony;

    initAnt(world.ants, antId, { colonyId, posX: 5 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.kind).toBe('queen');
    expect(sprites.calls[0]!.tint).toBe(COLOR_PLAYER_COLONY);
  });

  it('draws worker sprite (kind=worker) for non-queen ants', () => {
    const antId = 1; // not the queen (queen=0)
    const colonyId = PLAYER_COLONY_ID;

    const colony = createColonyRecord(colonyId, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[colonyId] = colony;

    initAnt(world.ants, antId, { colonyId, posX: 5 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.kind).toBe('worker');
  });

  it('tints player ants with COLOR_PLAYER_COLONY and enemy ants with COLOR_ENEMY_COLONY', () => {
    const playerAntId = 0;
    const enemyAntId  = 1;
    const playerColony = createColonyRecord(PLAYER_COLONY_ID, 99);
    playerColony.entrances = [];
    playerColony.rallyPoint = null;
    playerColony.digFlowFieldDirty = false;
    world.colonies[PLAYER_COLONY_ID] = playerColony;

    const ENEMY_COLONY_ID = 2;
    const enemyColony = createColonyRecord(ENEMY_COLONY_ID, 99);
    enemyColony.entrances = [];
    enemyColony.rallyPoint = null;
    enemyColony.digFlowFieldDirty = false;
    world.colonies[ENEMY_COLONY_ID] = enemyColony;

    initAnt(world.ants, playerAntId, { colonyId: PLAYER_COLONY_ID, posX: 5 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });
    initAnt(world.ants, enemyAntId,  { colonyId: ENEMY_COLONY_ID,  posX: 7 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });

    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);

    const playerTints = sprites.calls.filter(c => c.tint === COLOR_PLAYER_COLONY);
    const enemyTints  = sprites.calls.filter(c => c.tint === COLOR_ENEMY_COLONY);
    expect(playerTints.length).toBe(1);
    expect(enemyTints.length).toBe(1);
  });

  it('does NOT draw ants with zone=1 (underground ants)', () => {
    world.colonies[PLAYER_COLONY_ID] = (() => {
      const c = createColonyRecord(PLAYER_COLONY_ID, 99);
      c.entrances = []; c.rallyPoint = null; c.digFlowFieldDirty = false;
      return c;
    })();
    initAnt(world.ants, 0, { colonyId: PLAYER_COLONY_ID, posX: 5 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 1 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(sprites.calls.length).toBe(0);
    expect(gfx.callsOf('fillCircle').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: ant facing direction (09 render polish)
//
// The SVG sources face -x natively (head on the left of the texture). To make
// the sprite head point along the motion vector (dx, dy), drawSurfaceEntities
// passes rotation = atan2(-dy, -dx). When (dx, dy) ≈ (0, 0) rotation defaults
// to 0 so stationary ants hold a stable pose.
// ---------------------------------------------------------------------------

describe('drawSurfaceEntities — ant facing direction', () => {
  function makeWorldWithSurfaceAnt(): { world: WorldState; antId: number } {
    const world = createWorldState(1);
    const antId = 0;
    const colony = createColonyRecord(PLAYER_COLONY_ID, 999);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[PLAYER_COLONY_ID] = colony;
    initAnt(world.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 0,
    });
    return { world, antId };
  }

  it('rotation defaults to 0 when prev == curr (stationary ant)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const { world } = makeWorldWithSurfaceAnt();
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });

  it('moving right (+x): rotation has magnitude π (head flipped to face +x)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const { world: prev, antId } = makeWorldWithSurfaceAnt();
    const { world: curr } = makeWorldWithSurfaceAnt();
    // Shift curr ant one full tile to the right relative to prev.
    curr.ants.posX[antId] = 6 << FP_SHIFT;
    curr.ants.posY[antId] = 5 << FP_SHIFT;
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, prev, curr, 1, cam);
    expect(sprites.calls.length).toBe(1);
    // atan2(-0, -1) returns -π in JS; +π and -π both rotate the sprite to face right.
    expect(Math.abs(sprites.calls[0]!.rotation!)).toBeCloseTo(Math.PI, 5);
  });

  it('moving down (+y): rotation = -π/2', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const { world: prev, antId } = makeWorldWithSurfaceAnt();
    const { world: curr } = makeWorldWithSurfaceAnt();
    curr.ants.posX[antId] = 5 << FP_SHIFT;
    curr.ants.posY[antId] = 6 << FP_SHIFT;
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, prev, curr, 1, cam);
    expect(sprites.calls[0]!.rotation).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('moving up (-y): rotation = +π/2', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const { world: prev, antId } = makeWorldWithSurfaceAnt();
    const { world: curr } = makeWorldWithSurfaceAnt();
    curr.ants.posX[antId] = 5 << FP_SHIFT;
    curr.ants.posY[antId] = 4 << FP_SHIFT;
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, prev, curr, 1, cam);
    expect(sprites.calls[0]!.rotation).toBeCloseTo(Math.PI / 2, 5);
  });

  it('moving left (-x): rotation = 0', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const { world: prev, antId } = makeWorldWithSurfaceAnt();
    const { world: curr } = makeWorldWithSurfaceAnt();
    curr.ants.posX[antId] = 4 << FP_SHIFT;
    curr.ants.posY[antId] = 5 << FP_SHIFT;
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, prev, curr, 1, cam);
    // Sprite's native head is at -x so zero rotation already points left.
    expect(sprites.calls[0]!.rotation).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: facing-cache smoothing (render-polish follow-up)
//
// Sim movement is cardinal/4-connected, so diagonal travel zig-zags between
// axis-aligned tile moves. Without smoothing the sprite rotation flips axis
// every tick (east→south→east→south…), which reads as flicker. The
// AntFacingCache low-pass-filters delta history so after a few frames the
// blended heading points into the intended diagonal, and the sprite rotation
// follows. These integration tests exercise the full draw-surface → cache
// path rather than just the cache in isolation (see ant-facing-cache.test.ts
// for the unit tests on blending math).
// ---------------------------------------------------------------------------

describe('drawSurfaceEntities — facing cache smoothing', () => {
  function makeSurfaceAntWorld(posX: number, posY: number): WorldState {
    const w = createWorldState(1);
    const colony = createColonyRecord(PLAYER_COLONY_ID, 999);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    w.colonies[PLAYER_COLONY_ID] = colony;
    initAnt(w.ants, 0, {
      colonyId: PLAYER_COLONY_ID,
      posX: posX << FP_SHIFT,
      posY: posY << FP_SHIFT,
      zone: 0,
    });
    return w;
  }

  it('alternating right/down movement settles toward a diagonal rotation (not axis-aligned)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const cam = makeCamera(10, 10, 30, 30);
    const facing = new AntFacingCache();

    // Walk an 8-step southeast zig-zag: (5,5)→(6,5)→(6,6)→(7,6)→(7,7)…
    // Each adjacent pair is one frame's prev→curr. Shared cache accumulates
    // the blended heading across frames.
    let x = 5, y = 5;
    let lastRotation = 0;
    const path: Array<[number, number]> = [];
    for (let i = 0; i < 8; i++) {
      // Alternate axis: 0,2,4,6 move +x; 1,3,5,7 move +y.
      if (i % 2 === 0) x += 1;
      else             y += 1;
      path.push([x, y]);
    }

    let prev = makeSurfaceAntWorld(5, 5);
    for (const [nx, ny] of path) {
      sprites.reset();
      const curr = makeSurfaceAntWorld(nx, ny);
      drawSurfaceEntities(gfx, sprites, prev, curr, 1, cam, null, facing);
      lastRotation = sprites.calls[0]!.rotation!;
      prev = curr;
    }

    // SVG head native on -x → southeast motion lands rotation in (-π, -π/2).
    // A pure-right frame alone would be ≈ π (or -π); a pure-down frame alone
    // would be -π/2. The blend must land strictly between them.
    expect(lastRotation).toBeGreaterThan(-Math.PI);
    expect(lastRotation).toBeLessThan(-Math.PI / 2);
    // And closer to the diagonal (-3π/4) than to either axis.
    const diag = -3 * Math.PI / 4;
    expect(Math.abs(lastRotation - diag)).toBeLessThan(Math.abs(lastRotation - -Math.PI));
    expect(Math.abs(lastRotation - diag)).toBeLessThan(Math.abs(lastRotation - -Math.PI / 2));
  });

  it('spawn frame does not inherit a stale heading from a recycled ant id', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const cam = makeCamera(10, 10, 30, 30);
    const facing = new AntFacingCache();

    // First ant (id=0) builds up a rightward heading over a couple frames.
    let prev = makeSurfaceAntWorld(5, 5);
    for (const [nx, ny] of [[6, 5], [7, 5]] as Array<[number, number]>) {
      const curr = makeSurfaceAntWorld(nx, ny);
      drawSurfaceEntities(gfx, sprites, prev, curr, 1, cam, null, facing);
      prev = curr;
    }

    // Simulate ant death + respawn at the same id: prev slot not alive,
    // curr slot alive at a new position. Draw one frame and confirm the
    // rotation is the stable default (0), not carried over from the old ant.
    const freshPrev = createWorldState(1);
    const freshColony = createColonyRecord(PLAYER_COLONY_ID, 999);
    freshColony.entrances = []; freshColony.rallyPoint = null; freshColony.digFlowFieldDirty = false;
    freshPrev.colonies[PLAYER_COLONY_ID] = freshColony;
    // id=0 intentionally not initialized in freshPrev — isAlive=false.

    const freshCurr = makeSurfaceAntWorld(20, 20);

    sprites.reset();
    drawSurfaceEntities(gfx, sprites, freshPrev, freshCurr, 0.5, cam, null, facing);
    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });

  it('stationary ant keeps its prior smoothed heading across idle frames', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const cam = makeCamera(10, 10, 30, 30);
    const facing = new AntFacingCache();

    // Frame 1: establish a rightward heading. (Cardinal move seeds raw atan2.)
    const prev1 = makeSurfaceAntWorld(5, 5);
    const curr1 = makeSurfaceAntWorld(6, 5);
    drawSurfaceEntities(gfx, sprites, prev1, curr1, 1, cam, null, facing);
    const settledRotation = sprites.calls[0]!.rotation!;
    expect(Math.abs(settledRotation)).toBeCloseTo(Math.PI, 5); // moving +x

    // Frames 2..N: prev == curr (ant stationary). Rotation must hold steady.
    const still = makeSurfaceAntWorld(6, 5);
    for (let i = 0; i < 4; i++) {
      sprites.reset();
      drawSurfaceEntities(gfx, sprites, still, still, 1, cam, null, facing);
      expect(sprites.calls[0]!.rotation).toBe(settledRotation);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: wrong-plane flicker guard (09 render polish)
//
// Interpolating prev→curr is only valid when the slot was alive in prev AND
// prev.zone matches curr.zone. Otherwise we'd briefly draw the ant somewhere
// it never was:
//  - zone flip (e.g. queen descending through an entrance)
//  - spawn frame (prev posX/Y is a stale default like 0)
// In both cases drawSurfaceEntities must snap to the curr position.
// ---------------------------------------------------------------------------

describe('drawSurfaceEntities — wrong-plane flicker guard', () => {
  it('zone flip (prev.zone=1, curr.zone=0) → snap to curr, no interpolation', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const prev = createWorldState(1);
    const curr = createWorldState(1);
    const antId = 0;
    const colonyId = PLAYER_COLONY_ID;
    const colony = createColonyRecord(colonyId, 999);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    prev.colonies[colonyId] = colony;
    curr.colonies[colonyId] = colony;

    initAnt(prev.ants, antId, { colonyId, posX: 10 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 1 });
    initAnt(curr.ants, antId, { colonyId, posX: 20 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });

    const cam = makeCamera(15, 5, 50, 37);
    drawSurfaceEntities(gfx, sprites, prev, curr, 0.5, cam);

    expect(sprites.calls.length).toBe(1);
    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const expectedCurrX = 20 * TILE_SIZE_PX - left * TILE_SIZE_PX;
    expect(sprites.calls[0]!.x).toBeCloseTo(expectedCurrX, 5);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });

  it('spawn frame (prev slot !isAlive) → snap to curr, no pull toward default origin', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const prev = createWorldState(1);
    const curr = createWorldState(1);
    const antId = 0;
    const colonyId = PLAYER_COLONY_ID;
    const colony = createColonyRecord(colonyId, 999);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    prev.colonies[colonyId] = colony;
    curr.colonies[colonyId] = colony;

    // prev deliberately not initialized — slot is !isAlive with default posX=0.
    initAnt(curr.ants, antId, { colonyId, posX: 20 << FP_SHIFT, posY: 5 << FP_SHIFT, zone: 0 });

    const cam = makeCamera(20, 5, 50, 37);
    drawSurfaceEntities(gfx, sprites, prev, curr, 0.5, cam);

    expect(sprites.calls.length).toBe(1);
    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const expectedCurrX = 20 * TILE_SIZE_PX - left * TILE_SIZE_PX;
    expect(sprites.calls[0]!.x).toBeCloseTo(expectedCurrX, 5);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: rally-point marker (Phase 9 usability fix)
// ---------------------------------------------------------------------------

describe('drawSurfaceEntities — rally-point marker', () => {
  let gfx: MockGfx;
  let sprites: MockAntSprites;
  let world: WorldState;

  beforeEach(() => {
    gfx = new MockGfx();
    sprites = new MockAntSprites();
    world = createWorldState(1);
  });

  function addPlayerColony(rallyPoint: { tileX: number; tileY: number } | null): void {
    const colony = createColonyRecord(PLAYER_COLONY_ID, 999);
    colony.entrances = [];
    colony.rallyPoint = rallyPoint;
    colony.digFlowFieldDirty = false;
    colony.priorityFoodPileId = null;
    world.colonies[PLAYER_COLONY_ID] = colony;
  }

  /** The rally marker is white fillRects. Identify them by fill color. */
  function rallyRects(g: MockGfx): GfxCall[] {
    const out: GfxCall[] = [];
    let currentStyleIsRally = false;
    for (const c of g.calls) {
      if (c.method === 'fillStyle') {
        currentStyleIsRally = c.args[0] === COLOR_RALLY_POINT;
      } else if (c.method === 'fillRect' && currentStyleIsRally) {
        out.push(c);
      }
    }
    return out;
  }

  it('renders a rally marker when the player colony has a rally point', () => {
    addPlayerColony({ tileX: 5, tileY: 5 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(rallyRects(gfx).length).toBeGreaterThan(0);
  });

  it('renders no rally marker when rallyPoint is null', () => {
    addPlayerColony(null);
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(rallyRects(gfx).length).toBe(0);
  });

  it('rally marker moves with the rally point tile (camera-relative position)', () => {
    addPlayerColony({ tileX: 10, tileY: 4 });
    const cam = makeCamera(10, 4, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    const rects = rallyRects(gfx);
    expect(rects.length).toBeGreaterThan(0);
    const left = Math.floor(cam.x - cam.viewportWidth  / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const sx = (10 - left) * TILE_SIZE_PX;
    const sy = (4  - top)  * TILE_SIZE_PX;
    for (const r of rects) {
      const rx = r.args[0] as number;
      const ry = r.args[1] as number;
      expect(rx).toBeGreaterThanOrEqual(sx);
      expect(ry).toBeGreaterThanOrEqual(sy);
      expect(rx).toBeLessThan(sx + TILE_SIZE_PX);
      expect(ry).toBeLessThan(sy + TILE_SIZE_PX);
    }
  });

  it('rally marker disappears after rallyPoint is cleared', () => {
    addPlayerColony({ tileX: 5, tileY: 5 });
    const cam = makeCamera(5, 5, 20, 20);

    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(rallyRects(gfx).length).toBeGreaterThan(0);

    world.colonies[PLAYER_COLONY_ID]!.rallyPoint = null;
    gfx.reset();

    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(rallyRects(gfx).length).toBe(0);
  });

  it('does not render an enemy colony rally point on the player HUD', () => {
    addPlayerColony(null);
    const enemyId = PLAYER_COLONY_ID + 1;
    const enemy = createColonyRecord(enemyId, 888);
    enemy.entrances = [];
    enemy.rallyPoint = { tileX: 5, tileY: 5 };
    enemy.digFlowFieldDirty = false;
    enemy.priorityFoodPileId = null;
    world.colonies[enemyId] = enemy;

    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    expect(rallyRects(gfx).length).toBe(0);
  });

  // Phase 09.1-05 Task 1: structural regression guard. The fight-target marker
  // is the only in-game signal that connects the player's Fight rally click to
  // a visible tile. A silent deletion during a future refactor (e.g. the rally
  // block being accidentally commented out while editing the surrounding
  // pending-entrance preview) would not be caught by tests that only assert
  // "at least one rect was drawn" because other debug overlays could
  // incidentally produce white fillRects. This test locks in the three-rect
  // crosshair composition (horizontal bar + vertical bar + center accent) so
  // any reduction below three COLOR_RALLY_POINT rects fails loudly.
  it('renders the full crosshair composition: exactly 3 white rally rects (H-bar + V-bar + center accent)', () => {
    addPlayerColony({ tileX: 5, tileY: 5 });
    const cam = makeCamera(5, 5, 20, 20);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);
    const rects = rallyRects(gfx);
    expect(rects.length).toBe(3);

    // Derive expected pixel coords for the marker's tile.
    const left = Math.floor(cam.x - cam.viewportWidth  / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const sx = (5 - left) * TILE_SIZE_PX;
    const sy = (5 - top)  * TILE_SIZE_PX;

    // Horizontal bar: full-tile-width minus edges, 2-px thick, centered vertically.
    const hBar = rects.find(r =>
      r.args[0] === sx + 1 &&
      r.args[1] === sy + 7 &&
      r.args[2] === TILE_SIZE_PX - 2 &&
      r.args[3] === 2,
    );
    expect(hBar).toBeDefined();

    // Vertical bar: 2-px wide, full-tile-height minus edges, centered horizontally.
    const vBar = rects.find(r =>
      r.args[0] === sx + 7 &&
      r.args[1] === sy + 1 &&
      r.args[2] === 2 &&
      r.args[3] === TILE_SIZE_PX - 2,
    );
    expect(vBar).toBeDefined();

    // Center accent: 4×4 square at tile center — required for pop against busy terrain.
    const accent = rects.find(r =>
      r.args[0] === sx + 6 &&
      r.args[1] === sy + 6 &&
      r.args[2] === 4 &&
      r.args[3] === 4,
    );
    expect(accent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #14 — enemy entrance border cue
// ---------------------------------------------------------------------------

describe('drawSurfaceEntities — enemy entrance border (issue #14)', () => {
  function makeWorldWithEnemyEntrance(tileX = 10, tileY = 0): WorldState {
    const w = createWorldState(1);
    const player = createColonyRecord(PLAYER_COLONY_ID, 99);
    player.entrances = [{ entranceId: 1, surfaceTileX: 0, surfaceTileY: 0, isOpen: true }];
    player.rallyPoint = null;
    player.digFlowFieldDirty = false;
    player.priorityFoodPileId = null;
    const enemyId = PLAYER_COLONY_ID + 1;
    const enemy = createColonyRecord(enemyId, 88);
    enemy.entrances = [{ entranceId: 2, surfaceTileX: tileX, surfaceTileY: tileY, isOpen: true }];
    enemy.rallyPoint = null;
    enemy.digFlowFieldDirty = false;
    enemy.priorityFoodPileId = null;
    w.colonies[PLAYER_COLONY_ID] = player;
    w.colonies[enemyId]         = enemy;
    return w;
  }

  it('emits 4 thin COLOR_ENEMY_COLONY fillRects forming a perimeter ring around the enemy entrance tile', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const tileX = 10;
    const tileY = 0;
    const world = makeWorldWithEnemyEntrance(tileX, tileY);
    const cam = makeCamera(tileX, tileY, 10, 4);
    drawSurfaceEntities(gfx, sprites, world, world, 0, cam);

    // Find every fillRect emitted under COLOR_ENEMY_COLONY style — the
    // perimeter ring is exactly 4 strokes (top/bottom/left/right).
    const enemyRects: Array<[number, number, number, number]> = [];
    let style: number | undefined;
    for (const c of gfx.calls) {
      if (c.method === 'fillStyle') style = c.args[0] as number;
      else if (c.method === 'fillRect' && style === COLOR_ENEMY_COLONY) {
        enemyRects.push(c.args as [number, number, number, number]);
      }
    }
    expect(enemyRects.length).toBe(4);

    // Compute expected screen-space tile origin and assert a 1-pixel ring.
    const left = Math.floor(cam.x - cam.viewportWidth  / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const sx = (tileX - left) * TILE_SIZE_PX;
    const sy = (tileY - top)  * TILE_SIZE_PX;
    const expected = new Set([
      [sx,                  sy,                  TILE_SIZE_PX, 1].join(','),                 // top
      [sx,                  sy + TILE_SIZE_PX-1, TILE_SIZE_PX, 1].join(','),                 // bottom
      [sx,                  sy + 1,              1, TILE_SIZE_PX - 2].join(','),             // left
      [sx + TILE_SIZE_PX-1, sy + 1,              1, TILE_SIZE_PX - 2].join(','),             // right
    ]);
    for (const r of enemyRects) {
      expect(expected.has(r.join(','))).toBe(true);
    }
  });

  it('player entrance does NOT receive the enemy-color border', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    // Setup: only the player colony, no enemy.
    const w = createWorldState(1);
    const player = createColonyRecord(PLAYER_COLONY_ID, 99);
    player.entrances = [{ entranceId: 1, surfaceTileX: 0, surfaceTileY: 0, isOpen: true }];
    player.rallyPoint = null;
    player.digFlowFieldDirty = false;
    player.priorityFoodPileId = null;
    w.colonies[PLAYER_COLONY_ID] = player;
    const cam = makeCamera(0, 0, 10, 4);
    drawSurfaceEntities(gfx, sprites, w, w, 0, cam);

    // No enemy-colored fillRects anywhere.
    let style: number | undefined;
    let enemyRectCount = 0;
    for (const c of gfx.calls) {
      if (c.method === 'fillStyle') style = c.args[0] as number;
      else if (c.method === 'fillRect' && style === COLOR_ENEMY_COLONY) enemyRectCount += 1;
    }
    expect(enemyRectCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawSurface orchestrator
// ---------------------------------------------------------------------------

describe('drawSurface', () => {
  it('calls both terrain and entity draws (terrain rects + entity draws present)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const world = createWorldState(1);
    world.foodPiles.push({ foodPileId: 1, tileX: 5, tileY: 5 });
    const cam = makeCamera(5, 5, 10, 10);
    drawSurface(gfx, sprites, world, world, 0, cam);
    expect(gfx.callsOf('fillRect').length).toBeGreaterThan(0);
    expect(gfx.callsOf('fillCircle').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HUD-05 compliance — draw-surface.ts source
//
// The module itself must still be Phaser-free. Ant sprites now flow through
// the AntSpriteLayer interface (implemented by AntSpritePool in GameScene),
// so draw-surface.ts never references Phaser.GameObjects.Image/Sprite or any
// load.* API directly. The guard below keeps the module Phaser-free and
// positively asserts the sprite-layer integration point.
// ---------------------------------------------------------------------------

describe('HUD-05 compliance — draw-surface.ts source', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, 'draw-surface.ts'), 'utf8');

  it('does not reference Phaser.GameObjects.Image, Sprite, load.image, load.spritesheet, load.atlas', () => {
    expect(src).not.toMatch(/Phaser\.GameObjects\.Image/);
    expect(src).not.toMatch(/Phaser\.GameObjects\.Sprite/);
    expect(src).not.toMatch(/load\.image/);
    expect(src).not.toMatch(/load\.spritesheet/);
    expect(src).not.toMatch(/load\.atlas/);
  });

  it('delegates ant drawing to the AntSpriteLayer interface', () => {
    expect(src).toMatch(/AntSpriteLayer/);
    expect(src).toMatch(/sprites\.drawAnt\(/);
  });
});
