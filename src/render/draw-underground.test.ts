// draw-underground.test.ts — Vitest unit tests for the underground cross-section drawing module.
//
// Uses MockGfx (GfxLike spy) for terrain/chamber/egg/larva primitives and
// MockAntSprites (AntSpriteLayer spy) for ant draws. Tests run in Node via
// Vitest — no browser, no Phaser install required.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  drawUndergroundTerrain,
  drawUndergroundEntities,
  drawUnderground,
  projectFoodStorageFill,
} from './draw-underground.js';
import type { GfxLike } from './draw-surface.js';
import type {
  AntSpriteDrawOptions,
  AntSpriteLayer,
  StaticSpriteDrawOptions,
} from './ant-sprite-layer.js';
import type { WorldState } from '../sim/types.js';
import { createWorldState } from '../sim/types.js';
import { ugSet, UndergroundTileState, createUndergroundGrid } from '../sim/terrain.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { ChamberType } from '../sim/enums.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import { createColonyRecord } from '../sim/colony/colony-store.js';
import type { ChamberRecord } from '../sim/colony/colony-store.js';
import {
  TILE_SIZE_PX,
  COLOR_UNDERGROUND_CEILING_STRIP,
  COLOR_UNDERGROUND_OPEN,
  COLOR_UNDERGROUND_SOLID,
  COLOR_MARKED_TILE_OVERLAY,
  COLOR_BEING_DUG_OVERLAY,
  COLOR_CHAMBER_QUEEN,
  COLOR_CHAMBER_FOOD_STORAGE,
  COLOR_CHAMBER_FOOD_STORAGE_FILL,
  COLOR_PLAYER_COLONY,
} from './sprites.js';
import { FOOD_CHAMBER_CAPACITY } from '../sim/constants.js';
import type { CameraState } from './camera.js';
import { AntFacingCache } from './ant-facing-cache.js';

// ---------------------------------------------------------------------------
// MockGfx — spy recorder implementing GfxLike
// ---------------------------------------------------------------------------

interface GfxCall {
  method: string;
  args: unknown[];
}

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
  staticOfKind(kind: StaticSpriteDrawOptions['kind']): StaticSpriteDrawOptions[] {
    return this.staticCalls.filter(c => c.kind === kind);
  }
  reset(): void {
    this.calls = []; this.staticCalls = [];
    this.beginFrames = 0; this.endFrames = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCamera(cx: number, cy: number, vpW: number, vpH: number): CameraState {
  return { x: cx, y: cy, viewportWidth: vpW, viewportHeight: vpH };
}

/** Build a WorldState with a player colony and a 10×10 underground grid. */
function makeWorldWithUnderground(): WorldState {
  const w = createWorldState(1);
  w.undergroundGrids[PLAYER_COLONY_ID] = createUndergroundGrid(10, 10);
  const colony = createColonyRecord(PLAYER_COLONY_ID, 999);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  w.colonies[PLAYER_COLONY_ID] = colony;
  return w;
}

// ---------------------------------------------------------------------------
// Tests: drawUndergroundTerrain
// ---------------------------------------------------------------------------

describe('drawUndergroundTerrain', () => {
  let gfx: MockGfx;
  let world: WorldState;

  beforeEach(() => {
    gfx = new MockGfx();
    world = makeWorldWithUnderground();
  });

  it('returns immediately (no draws) when player underground grid is absent', () => {
    const w = createWorldState(1);
    const cam = makeCamera(5, 5, 10, 10);
    drawUndergroundTerrain(gfx, w, cam);
    expect(gfx.calls.length).toBe(0);
  });

  it('draws ceiling row with COLOR_UNDERGROUND_CEILING_STRIP for non-entrance columns', () => {
    const cam = makeCamera(5, 0.5, 10, 1);
    drawUndergroundTerrain(gfx, world, cam);
    const ceilingStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_CEILING_STRIP);
    expect(ceilingStyles.length).toBeGreaterThan(0);
  });

  it('draws COLOR_UNDERGROUND_OPEN at entrance column in ceiling row', () => {
    world.colonies[PLAYER_COLONY_ID]!.entrances = [
      { entranceId: 1, surfaceTileX: 3, surfaceTileY: 64, isOpen: true },
    ];
    const cam = makeCamera(5, 0.5, 10, 1);
    drawUndergroundTerrain(gfx, world, cam);

    const openStyles    = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_OPEN);
    const ceilingStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_CEILING_STRIP);
    expect(openStyles.length).toBe(1);
    expect(ceilingStyles.length).toBe(9);
  });

  it('draws Solid tiles with COLOR_UNDERGROUND_SOLID', () => {
    const cam = makeCamera(5, 5, 4, 4);
    drawUndergroundTerrain(gfx, world, cam);
    const solidStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_SOLID);
    expect(solidStyles.length).toBeGreaterThan(0);
  });

  it('draws Open tiles with COLOR_UNDERGROUND_OPEN', () => {
    ugSet(world.undergroundGrids[PLAYER_COLONY_ID]!, 5, 5, UndergroundTileState.Open);
    const cam = makeCamera(5, 5, 2, 2);
    drawUndergroundTerrain(gfx, world, cam);
    const openStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_OPEN);
    expect(openStyles.length).toBeGreaterThan(0);
  });

  it('draws Marked tiles: open base + overlay with COLOR_MARKED_TILE_OVERLAY', () => {
    ugSet(world.undergroundGrids[PLAYER_COLONY_ID]!, 5, 5, UndergroundTileState.Marked);
    const cam = makeCamera(5.5, 5.5, 2, 2);
    drawUndergroundTerrain(gfx, world, cam);
    const openStyles   = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_OPEN);
    const markedStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_MARKED_TILE_OVERLAY);
    expect(openStyles.length).toBeGreaterThan(0);
    expect(markedStyles.length).toBeGreaterThan(0);
  });

  it('draws BeingDug tiles: open base + overlay with COLOR_BEING_DUG_OVERLAY', () => {
    ugSet(world.undergroundGrids[PLAYER_COLONY_ID]!, 5, 5, UndergroundTileState.BeingDug);
    const cam = makeCamera(5.5, 5.5, 2, 2);
    drawUndergroundTerrain(gfx, world, cam);
    const beingDugStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_BEING_DUG_OVERLAY);
    expect(beingDugStyles.length).toBeGreaterThan(0);
  });

  it('places ceiling gap at exactly the entrance tileX, leaves other columns as ceiling', () => {
    world.colonies[PLAYER_COLONY_ID]!.entrances = [
      { entranceId: 1, surfaceTileX: 2, surfaceTileY: 64, isOpen: true },
      { entranceId: 2, surfaceTileX: 7, surfaceTileY: 64, isOpen: true },
    ];
    const cam = makeCamera(5, 0.5, 10, 1);
    drawUndergroundTerrain(gfx, world, cam);
    const openStyles    = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_OPEN);
    const ceilingStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_UNDERGROUND_CEILING_STRIP);
    expect(openStyles.length).toBe(2);
    expect(ceilingStyles.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawUndergroundEntities
// ---------------------------------------------------------------------------

describe('drawUndergroundEntities', () => {
  let gfx: MockGfx;
  let sprites: MockAntSprites;
  let world: WorldState;

  beforeEach(() => {
    gfx = new MockGfx();
    sprites = new MockAntSprites();
    world = makeWorldWithUnderground();
  });

  it('preserves sub-tile fixed-point precision when projecting underground ant position to pixels', () => {
    const antId = 0;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;

    const HALF_FP = 128;
    initAnt(world.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: (5 << FP_SHIFT) + HALF_FP,
      posY: (3 << FP_SHIFT) + HALF_FP,
      zone: 1,
    });

    const cam = makeCamera(5, 3, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const expectedX = 5.5 * TILE_SIZE_PX - left * TILE_SIZE_PX;
    const expectedY = 3.5 * TILE_SIZE_PX - top  * TILE_SIZE_PX;
    const antCall = sprites.calls.find(c =>
      c.kind === 'worker' &&
      Math.abs(c.x - expectedX) < 0.01 &&
      Math.abs(c.y - expectedY) < 0.01,
    );
    expect(antCall).toBeDefined();
  });

  it('draws worker ant at pixel position matching integer tile coords', () => {
    const antId = 0;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;

    initAnt(world.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      zone: 1,
    });

    const cam = makeCamera(5, 3, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const expectedX = (5 - left) * TILE_SIZE_PX;
    const expectedY = (3 - top)  * TILE_SIZE_PX;
    const antCall = sprites.calls.find(c =>
      c.kind === 'worker' &&
      Math.abs(c.x - expectedX) < 0.5 &&
      Math.abs(c.y - expectedY) < 0.5,
    );
    expect(antCall).toBeDefined();
  });

  it('does NOT draw ants with zone=0 (surface ants excluded from underground renderer)', () => {
    const antId = 0;
    initAnt(world.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 0,
    });

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.calls.length).toBe(0);
  });

  it('draws queen sprite (kind=queen) when ant id matches queenEntityId', () => {
    const queenId = 0;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = queenId;
    initAnt(world.ants, queenId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.kind).toBe('queen');
    expect(sprites.calls[0]!.tint).toBe(COLOR_PLAYER_COLONY);
  });

  it('draws a queen chamber fillRect with COLOR_CHAMBER_QUEEN covering chamber dimensions', () => {
    const queenDims = CHAMBER_DIMENSIONS[ChamberType.Queen];
    const chamber: ChamberRecord = {
      chamberId:   1,
      chamberType: ChamberType.Queen,
      foodStored:  0,
      posX:        5 << FP_SHIFT,
      posY:        10 << FP_SHIFT,
      width:       queenDims.width,
      height:      queenDims.height,
    };
    world.colonies[PLAYER_COLONY_ID]!.chambers = [chamber];

    const cam = makeCamera(5, 10, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    const rects = gfx.callsOf('fillRect');
    const chamberRect = rects.find(r => r.args[2] === queenDims.width * TILE_SIZE_PX && r.args[3] === queenDims.height * TILE_SIZE_PX);
    expect(chamberRect).toBeDefined();

    const queenStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_CHAMBER_QUEEN);
    expect(queenStyles.length).toBeGreaterThanOrEqual(1);
  });

  it('draws eggs via sprites.drawStatic (kind=egg) from brood entity position', () => {
    const eggId = 5;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    initAnt(world.ants, eggId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 4 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    world.colonies[PLAYER_COLONY_ID]!.eggs = [eggId];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    // SVG-backed render path: egg goes through the sprite layer, NOT fillCircle.
    expect(sprites.staticOfKind('egg').length).toBe(1);
    expect(gfx.callsOf('fillCircle').length).toBe(0);
    // Issue #22 regression guard — the egg entity must NOT also be drawn as
    // a worker ant sprite. Pre-fix this test passed even with the bug because
    // it only asserted the egg sprite was emitted, not that no ant sprite was.
    expect(sprites.calls.length).toBe(0);
    // Sprite is positioned at the tile center.
    const left = Math.floor(cam.x - cam.viewportWidth  / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const eggCall = sprites.staticOfKind('egg')[0]!;
    expect(eggCall.x).toBe((4 - left) * TILE_SIZE_PX + TILE_SIZE_PX / 2);
    expect(eggCall.y).toBe((5 - top)  * TILE_SIZE_PX + TILE_SIZE_PX / 2);
  });

  it('does NOT draw enemy-colony ants even when underground in view (PRD §7b)', () => {
    // Regression guard: prior revision rendered all zone=1 ants and just
    // colored them by colony, which leaked enemy positions into the player's
    // underground view.
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    const enemyColonyId = 2;

    const enemyId = 3;
    initAnt(world.ants, enemyId, {
      colonyId: enemyColonyId,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.calls.length).toBe(0);
  });

  it('FoodStorage chamber with colony.foodStored=0 draws NO food-cache sprites', () => {
    const foodDims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage];
    world.colonies[PLAYER_COLONY_ID]!.foodStored = 0;
    world.colonies[PLAYER_COLONY_ID]!.chambers = [{
      chamberId:   9,
      chamberType: ChamberType.FoodStorage,
      foodStored:  0,
      posX:        5 << FP_SHIFT,
      posY:        5 << FP_SHIFT,
      width:       foodDims.width,
      height:      foodDims.height,
    }];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.staticOfKind('food-cache').length).toBe(0);
    // Legacy overlay path must also be gone — no amber fillRect.
    const fillStyles = gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_CHAMBER_FOOD_STORAGE_FILL);
    expect(fillStyles.length).toBe(0);
  });

  it('FoodStorage half-full → proportional count of food-cache sprites', () => {
    const foodDims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage];
    const totalTiles = foodDims.width * foodDims.height;
    // Issue #15: chamber.foodStored is the authoritative per-chamber stockpile.
    world.colonies[PLAYER_COLONY_ID]!.chambers = [{
      chamberId:   10,
      chamberType: ChamberType.FoodStorage,
      foodStored:  Math.floor(FOOD_CHAMBER_CAPACITY / 2),
      posX:        5 << FP_SHIFT,
      posY:        5 << FP_SHIFT,
      width:       foodDims.width,
      height:      foodDims.height,
    }];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    const caches = sprites.staticOfKind('food-cache');
    // Roughly half-full: between 1 tile and all tiles exclusive. Use round-half.
    expect(caches.length).toBeGreaterThan(0);
    expect(caches.length).toBeLessThan(totalTiles);
    // With Math.round(0.5 * totalTiles) we expect exactly half (rounding up).
    expect(caches.length).toBe(Math.round(0.5 * totalTiles));
  });

  it('FoodStorage full → food-cache sprite per tile, bottom row included', () => {
    const foodDims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage];
    world.colonies[PLAYER_COLONY_ID]!.chambers = [{
      chamberId:   11,
      chamberType: ChamberType.FoodStorage,
      foodStored:  FOOD_CHAMBER_CAPACITY,
      posX:        5 << FP_SHIFT,
      posY:        5 << FP_SHIFT,
      width:       foodDims.width,
      height:      foodDims.height,
    }];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    const caches = sprites.staticOfKind('food-cache');
    expect(caches.length).toBe(foodDims.width * foodDims.height);
    // Caches are tinted with the amber storage color so the white SVG reads
    // as stored grain.
    for (const c of caches) {
      expect(c.tint).toBe(COLOR_CHAMBER_FOOD_STORAGE_FILL);
    }
    // At least one cache sits on the chamber floor row (bottom tiles).
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const bottomRowY = (5 - top) * TILE_SIZE_PX + (foodDims.height - 1) * TILE_SIZE_PX + TILE_SIZE_PX / 2;
    const bottomCaches = caches.filter(c => Math.abs(c.y - bottomRowY) < 0.01);
    expect(bottomCaches.length).toBe(foodDims.width);
    // And at least one sits on the top row — chamber is fully packed.
    const topRowY = (5 - top) * TILE_SIZE_PX + TILE_SIZE_PX / 2;
    expect(caches.some(c => Math.abs(c.y - topRowY) < 0.01)).toBe(true);
    // Chamber floor is still drawn as COLOR_CHAMBER_FOOD_STORAGE (unchanged
    // baseline). Just make sure the legacy amber fillRect path isn't emitted.
    expect(gfx.callsOf('fillStyle').filter(c => c.args[0] === COLOR_CHAMBER_FOOD_STORAGE).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('FoodStorage fill reads chamber.foodStored directly (issue #15 chamber-authoritative)', () => {
    // Issue #15 changed the model: chamber.foodStored is the authoritative
    // per-chamber stockpile, written by ant deposits inside the footprint and
    // read directly by render. There's no projection from colony.foodStored.
    const foodDims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage];
    const totalTiles = foodDims.width * foodDims.height;
    // Set the entrance pool full just to confirm it does NOT bleed into the
    // chamber visual — the bug we fixed.
    world.colonies[PLAYER_COLONY_ID]!.foodStored = 9999;
    world.colonies[PLAYER_COLONY_ID]!.chambers = [{
      chamberId:   12,
      chamberType: ChamberType.FoodStorage,
      foodStored:  FOOD_CHAMBER_CAPACITY, // full per chamber.foodStored
      posX:        5 << FP_SHIFT,
      posY:        5 << FP_SHIFT,
      width:       foodDims.width,
      height:      foodDims.height,
    }];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.staticOfKind('food-cache').length).toBe(totalTiles);
  });

  it('projectFoodStorageFill returns each chamber.foodStored independently (issue #15)', () => {
    // Per-chamber authoritative model: each chamber stands on its own. Reading
    // one does NOT consume from the others.
    const foodDims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage];
    const capa = FOOD_CHAMBER_CAPACITY;
    const colony = createColonyRecord(PLAYER_COLONY_ID, 999);
    colony.chambers = [
      { chamberId: 1, chamberType: ChamberType.FoodStorage, foodStored: capa,
        posX: 0, posY: 0, width: foodDims.width, height: foodDims.height },
      { chamberId: 2, chamberType: ChamberType.FoodStorage, foodStored: Math.floor(capa / 2),
        posX: 0, posY: 0, width: foodDims.width, height: foodDims.height },
      { chamberId: 3, chamberType: ChamberType.FoodStorage, foodStored: 0,
        posX: 0, posY: 0, width: foodDims.width, height: foodDims.height },
    ];
    // Entrance pool is irrelevant to the per-chamber readout.
    colony.foodStored = 12345;

    expect(projectFoodStorageFill(colony, 1)).toBe(capa);
    expect(projectFoodStorageFill(colony, 2)).toBe(Math.floor(capa / 2));
    expect(projectFoodStorageFill(colony, 3)).toBe(0);
    // Unknown chamber id → 0.
    expect(projectFoodStorageFill(colony, 99)).toBe(0);
  });

  it('draws larvae via sprites.drawStatic (kind=larva) from brood entity position', () => {
    const larvaId = 6;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    initAnt(world.ants, larvaId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 4 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    world.colonies[PLAYER_COLONY_ID]!.larvae = [larvaId];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    expect(sprites.staticOfKind('larva').length).toBe(1);
    expect(gfx.callsOf('fillCircle').length).toBe(0);
    // Issue #22 regression guard — see notes on the egg test above.
    expect(sprites.calls.length).toBe(0);
  });

  it('issue #22 — eggs and larvae are NOT drawn as worker ant sprites', () => {
    // Bug repro: eggs/larvae share the AntComponents SoA store and are alive
    // in zone=Underground with currentGridColonyId set. Pre-fix the underground
    // ant loop iterated all such entities and emitted a worker-ant sprite at
    // depth 50 for every brood, which painted on top of the egg/larva sprite
    // (depth 48) emitted by the brood loop. User-visible artifact: "eggs
    // appear to have ants drawn on them".
    const eggId   = 5;
    const larvaId = 6;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999; // avoid id-collision with brood
    initAnt(world.ants, eggId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 4 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    initAnt(world.ants, larvaId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 6 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    world.colonies[PLAYER_COLONY_ID]!.eggs   = [eggId];
    world.colonies[PLAYER_COLONY_ID]!.larvae = [larvaId];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    // Brood gets static sprites at the right kind…
    expect(sprites.staticOfKind('egg').length).toBe(1);
    expect(sprites.staticOfKind('larva').length).toBe(1);
    // …and crucially, NO ant sprites at all (no worker, no queen) — the brood
    // entities must not leak through the ant loop and overdraw the brood SVGs.
    expect(sprites.calls.length).toBe(0);
  });

  it('issue #22 — workers + brood in same grid: only workers render as ants, brood as static sprites', () => {
    // Mixed-occupancy regression: a real chamber has worker nurses tending
    // brood. The fix must skip ONLY brood from the ant loop, not workers.
    const workerId = 4;
    const eggId    = 5;
    const larvaId  = 6;
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    initAnt(world.ants, workerId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    initAnt(world.ants, eggId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 4 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    initAnt(world.ants, larvaId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 6 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      zone: 1,
    });
    world.colonies[PLAYER_COLONY_ID]!.eggs   = [eggId];
    world.colonies[PLAYER_COLONY_ID]!.larvae = [larvaId];

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);

    // Exactly one worker ant sprite (the nurse), and the two brood static sprites.
    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.kind).toBe('worker');
    expect(sprites.staticOfKind('egg').length).toBe(1);
    expect(sprites.staticOfKind('larva').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: ant facing direction (09 render polish)
// ---------------------------------------------------------------------------

describe('drawUndergroundEntities — ant facing direction', () => {
  function setupAnt(world: WorldState, antId: number, tileX: number, tileY: number): void {
    initAnt(world.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: tileX << FP_SHIFT,
      posY: tileY << FP_SHIFT,
      zone: 1,
    });
  }

  it('stationary ant → rotation = 0 (stable default)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const world = makeWorldWithUnderground();
    world.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    setupAnt(world, 0, 5, 5);
    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, world, world, 0, cam);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });

  it('moving right → rotation is π (or equivalently -π)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const prev = makeWorldWithUnderground();
    const curr = makeWorldWithUnderground();
    prev.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    curr.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    setupAnt(prev, 0, 5, 5);
    setupAnt(curr, 0, 6, 5);
    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, prev, curr, 1, cam);
    expect(Math.abs(sprites.calls[0]!.rotation!)).toBeCloseTo(Math.PI, 5);
  });

  it('moving down → rotation = -π/2', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const prev = makeWorldWithUnderground();
    const curr = makeWorldWithUnderground();
    prev.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    curr.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    setupAnt(prev, 0, 5, 5);
    setupAnt(curr, 0, 5, 6);
    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, prev, curr, 1, cam);
    expect(sprites.calls[0]!.rotation).toBeCloseTo(-Math.PI / 2, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: facing-cache smoothing (render-polish follow-up)
//
// Mirrors the surface-path smoothing tests. Underground ants travel on the
// same cardinal grid, so diagonal movement zig-zags between axis-aligned
// deltas and without smoothing the sprite rotation flips axis every tick.
// The AntFacingCache threaded through drawUnderground[Entities] low-pass-
// filters the heading so the blended rotation settles into the diagonal.
// ---------------------------------------------------------------------------

describe('drawUndergroundEntities — facing cache smoothing', () => {
  function makeUndergroundAntWorld(posX: number, posY: number): WorldState {
    const w = makeWorldWithUnderground();
    w.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    initAnt(w.ants, 0, {
      colonyId: PLAYER_COLONY_ID,
      posX: posX << FP_SHIFT,
      posY: posY << FP_SHIFT,
      zone: 1,
    });
    return w;
  }

  it('alternating right/down movement settles toward a diagonal rotation (not axis-aligned)', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const cam = makeCamera(5, 5, 30, 30);
    const facing = new AntFacingCache();

    let x = 3, y = 3;
    const path: Array<[number, number]> = [];
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) x += 1;
      else             y += 1;
      path.push([x, y]);
    }

    let prev = makeUndergroundAntWorld(3, 3);
    let lastRotation = 0;
    for (const [nx, ny] of path) {
      sprites.reset();
      const curr = makeUndergroundAntWorld(nx, ny);
      drawUndergroundEntities(gfx, sprites, prev, curr, 1, cam, PLAYER_COLONY_ID, facing);
      lastRotation = sprites.calls[0]!.rotation!;
      prev = curr;
    }

    // SVG head native on -x → southeast motion lands rotation in (-π, -π/2).
    expect(lastRotation).toBeGreaterThan(-Math.PI);
    expect(lastRotation).toBeLessThan(-Math.PI / 2);
    const diag = -3 * Math.PI / 4;
    expect(Math.abs(lastRotation - diag)).toBeLessThan(Math.abs(lastRotation - -Math.PI));
    expect(Math.abs(lastRotation - diag)).toBeLessThan(Math.abs(lastRotation - -Math.PI / 2));
  });

  it('stationary ant keeps its prior smoothed heading across idle frames', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const cam = makeCamera(5, 5, 30, 30);
    const facing = new AntFacingCache();

    const prev1 = makeUndergroundAntWorld(3, 3);
    const curr1 = makeUndergroundAntWorld(4, 3);
    drawUndergroundEntities(gfx, sprites, prev1, curr1, 1, cam, PLAYER_COLONY_ID, facing);
    const settledRotation = sprites.calls[0]!.rotation!;
    expect(Math.abs(settledRotation)).toBeCloseTo(Math.PI, 5);

    const still = makeUndergroundAntWorld(4, 3);
    for (let i = 0; i < 4; i++) {
      sprites.reset();
      drawUndergroundEntities(gfx, sprites, still, still, 1, cam, PLAYER_COLONY_ID, facing);
      expect(sprites.calls[0]!.rotation).toBe(settledRotation);
    }
  });

  it('spawn frame does not inherit a stale heading from a recycled ant id', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const cam = makeCamera(5, 5, 30, 30);
    const facing = new AntFacingCache();

    // Build up a heading for id=0.
    let prev = makeUndergroundAntWorld(3, 3);
    for (const [nx, ny] of [[4, 3], [5, 3]] as Array<[number, number]>) {
      const curr = makeUndergroundAntWorld(nx, ny);
      drawUndergroundEntities(gfx, sprites, prev, curr, 1, cam, PLAYER_COLONY_ID, facing);
      prev = curr;
    }

    // Simulate death + respawn at same id: prev slot not alive, curr alive
    // at a fresh tile. Rotation must reset to 0, not inherit prior heading.
    const freshPrev = makeWorldWithUnderground();
    freshPrev.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    // id=0 intentionally not initialized in freshPrev.

    const freshCurr = makeUndergroundAntWorld(7, 7);

    sprites.reset();
    drawUndergroundEntities(gfx, sprites, freshPrev, freshCurr, 0.5, cam, PLAYER_COLONY_ID, facing);
    expect(sprites.calls.length).toBe(1);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: wrong-plane flicker guard (09 render polish)
//
// Mirrors draw-surface.test.ts: interpolating prev→curr is only valid when
// the slot was alive in prev AND prev.zone matches curr.zone. The underground
// renderer must snap to curr in those cases so an ant descending from the
// surface (prev.zone=0 → curr.zone=1) doesn't render a frame at its surface
// position projected into the underground view.
// ---------------------------------------------------------------------------

describe('drawUndergroundEntities — wrong-plane flicker guard', () => {
  it('zone flip (prev.zone=0, curr.zone=1) → snap to curr, no interpolation', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const prev = makeWorldWithUnderground();
    const curr = makeWorldWithUnderground();
    prev.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    curr.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;

    const antId = 0;
    initAnt(prev.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 2 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      zone: 0,
    });
    initAnt(curr.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 6 << FP_SHIFT,
      posY: 7 << FP_SHIFT,
      zone: 1,
    });

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, prev, curr, 0.5, cam);

    expect(sprites.calls.length).toBe(1);
    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const expectedCurrX = 6 * TILE_SIZE_PX - left * TILE_SIZE_PX;
    const expectedCurrY = 7 * TILE_SIZE_PX - top  * TILE_SIZE_PX;
    expect(sprites.calls[0]!.x).toBeCloseTo(expectedCurrX, 5);
    expect(sprites.calls[0]!.y).toBeCloseTo(expectedCurrY, 5);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });

  it('spawn frame (prev slot !isAlive) → snap to curr, no pull toward default origin', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const prev = makeWorldWithUnderground();
    const curr = makeWorldWithUnderground();
    prev.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;
    curr.colonies[PLAYER_COLONY_ID]!.queenEntityId = 999;

    const antId = 0;
    // prev deliberately not initialized — slot is !isAlive with default posX=0.
    initAnt(curr.ants, antId, {
      colonyId: PLAYER_COLONY_ID,
      posX: 6 << FP_SHIFT,
      posY: 7 << FP_SHIFT,
      zone: 1,
    });

    const cam = makeCamera(5, 5, 20, 20);
    drawUndergroundEntities(gfx, sprites, prev, curr, 0.5, cam);

    expect(sprites.calls.length).toBe(1);
    const left = Math.floor(cam.x - cam.viewportWidth / 2);
    const top  = Math.floor(cam.y - cam.viewportHeight / 2);
    const expectedCurrX = 6 * TILE_SIZE_PX - left * TILE_SIZE_PX;
    const expectedCurrY = 7 * TILE_SIZE_PX - top  * TILE_SIZE_PX;
    expect(sprites.calls[0]!.x).toBeCloseTo(expectedCurrX, 5);
    expect(sprites.calls[0]!.y).toBeCloseTo(expectedCurrY, 5);
    expect(sprites.calls[0]!.rotation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: drawUnderground (orchestrator)
// ---------------------------------------------------------------------------

describe('drawUnderground', () => {
  it('returns without throw when player underground grid is undefined', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const w = createWorldState(1);
    const cam = makeCamera(5, 5, 10, 10);
    expect(() => drawUnderground(gfx, sprites, w, w, 0, cam)).not.toThrow();
    expect(gfx.callsOf('fillRect').length).toBe(0);
  });

  it('produces terrain draws (fillRect) and no throw for standard world', () => {
    const gfx = new MockGfx();
    const sprites = new MockAntSprites();
    const world = makeWorldWithUnderground();
    const cam = makeCamera(5, 5, 10, 10);
    expect(() => drawUnderground(gfx, sprites, world, world, 0, cam)).not.toThrow();
    expect(gfx.callsOf('fillRect').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HUD-05 compliance — draw-underground.ts source
//
// Module itself stays Phaser-free. Ants go through the AntSpriteLayer
// interface (implemented by AntSpritePool in GameScene).
// ---------------------------------------------------------------------------

describe('HUD-05 compliance — draw-underground.ts source', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, 'draw-underground.ts'), 'utf8');

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
