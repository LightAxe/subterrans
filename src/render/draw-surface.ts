// draw-surface.ts — Phase 8 surface view drawing module (Stage 2 world-space migration).
//
// Pure functions: take a GfxLike + AntSpriteLayer + WorldState snapshots, issue
// Graphics API calls and AntSpriteLayer.drawAnt calls. No scene management, no input
// handling, no state mutation.
//
// Stage 2 (issue #18): all drawing is now in WORLD pixels (worldX = tileX × TILE_SIZE_PX).
// The Phaser main camera (driven by the camera adapter: setZoom + centerOn) projects
// world → screen, so these modules no longer subtract a camera offset. Culling is
// against the adapter's visibleWorldRect (zoom-aware), not a fixed canvas rectangle.
// Low-level per-tile/per-sprite helpers are unchanged — they draw at the given px,
// which are now world px.
//
// Draw order: drawSurface calls drawSurfaceTerrain then drawSurfaceEntities.
// Pheromone overlay is NOT called from here — GameScene calls drawPheromoneOverlay
// between terrain and entities.

import { sgGet } from '../sim/terrain.js';
import { AntTask } from '../sim/enums.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { FP_ONE } from '../sim/fixed.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { WorldState } from '../sim/types.js';
import type { AntSpriteLayer } from './ant-sprite-layer.js';
import { computeAntRotation, type AntFacingCache } from './ant-facing-cache.js';
import {
  TILE_SIZE_PX,
  COLOR_FOOD_PILE_NORMAL,
  COLOR_FOOD_PILE_MARKED,
  COLOR_SURFACE_ENTRANCE_HOLE,
  COLOR_PLAYER_COLONY,
  COLOR_ENEMY_COLONY,
  COLOR_RALLY_POINT,
  COLOR_ENTRANCE_HOVER_VALID,
  COLOR_ENTRANCE_HOVER_INVALID,
  COLOR_FIGHTER_TINT,
  COLOR_NEUTRAL_CONTESTED_GLOW,
  lerpColor,
} from './sprites.js';
import {
  drawBarrenEarthTile,
  COLOR_BARREN_EARTH_DAMP,
  COLOR_BARREN_EARTH_MOUND,
} from './terrain-atlas.js';
export type { AntSpriteLayer } from './ant-sprite-layer.js';
import {
  type CameraView,
  visibleWorldRect,
  type WorldRect,
  ANT_DOT_SCREEN_PX,
} from './camera-adapter.js';
import { SPIDER_SPRITE_HEIGHT, SPIDER_SPRITE_WIDTH } from './ant-sprite-layer.js';
import { SPIDER_HUNGER_MAX_TICKS, SPIDER_HP_FULL } from '../sim/constants.js';
import { tierIndex } from '../sim/ai-state.js';

// ---------------------------------------------------------------------------
// GfxLike — minimal Graphics interface (Phaser.GameObjects.Graphics satisfies this)
//
// Defined here; re-exported from draw-underground.ts and draw-pheromone.ts.
// Tests use a spy recorder (MockGfx) that implements this interface.
// ---------------------------------------------------------------------------

export interface GfxLike {
  clear(): GfxLike;
  fillStyle(color: number, alpha?: number): GfxLike;
  lineStyle(width: number, color: number, alpha?: number): GfxLike;
  fillRect(x: number, y: number, w: number, h: number): GfxLike;
  fillCircle(x: number, y: number, r: number): GfxLike;
  strokeCircle(x: number, y: number, r: number): GfxLike;
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): GfxLike;
}

// ---------------------------------------------------------------------------
// Viewport helpers (shared by all draw modules)
// ---------------------------------------------------------------------------

/**
 * Compute the visible TILE range from the camera (zoom-aware), clamped to the grid.
 * Derived from the adapter's world rect; the +1 margin covers tiles straddling the
 * visible edge. Returns { left, top, right, bottom } in tile coordinates.
 */
export function visibleTileRange(
  cam: CameraView,
  gridWidth: number,
  gridHeight: number,
): { left: number; top: number; right: number; bottom: number } {
  const rect = visibleWorldRect(cam);
  const left = Math.floor(rect.left / TILE_SIZE_PX);
  const top = Math.floor(rect.top / TILE_SIZE_PX);
  const right = Math.min(Math.ceil(rect.right / TILE_SIZE_PX) + 1, gridWidth);
  const bottom = Math.min(Math.ceil(rect.bottom / TILE_SIZE_PX) + 1, gridHeight);
  return { left, top, right, bottom };
}

/**
 * World-space cull test for a tile-anchored primitive whose top-left is at world
 * (worldX, worldY). Mirrors the prior screen cull (one-tile left/top margin, right/
 * bottom at the visible edge), now in world px so it is correct under any zoom.
 * `margin` widens the box for primitives that spill past their tile (entrance mounds,
 * spider sprite).
 */
function tileInView(worldX: number, worldY: number, rect: WorldRect, margin: number): boolean {
  return (
    worldX >= rect.left - margin &&
    worldX <= rect.right + margin &&
    worldY >= rect.top - margin &&
    worldY <= rect.bottom + margin
  );
}

// ---------------------------------------------------------------------------
// drawSurfaceTerrain
// ---------------------------------------------------------------------------

/**
 * Draw the surface terrain tiles visible through the camera, in WORLD pixels.
 *
 * Issue #40 reframe: surface is barren-earth-default with grass tufts / pebbles /
 * twigs scattered as deterministic decoration. The per-tile motif scattering creates
 * variety; the dominant readout is "ant-scale ground".
 *
 * Stage 2: this draws at world px and culls to the visible tile range, immediate-mode
 * every frame (it draws tiles at world px into whatever GfxLike target it is given).
 */
export function drawSurfaceTerrain(
  gfx: GfxLike,
  world: WorldState,
  cam: CameraView,
  // Stage 2 §B: when true, draw the WHOLE grid (off-screen RenderTexture bake) instead of
  // culling to the camera's visible window. (Surface is static → baked once.)
  bakeAll: boolean = false,
): void {
  const { left, top, right, bottom } = bakeAll
    ? { left: 0, top: 0, right: world.surface.width, bottom: world.surface.height }
    : visibleTileRange(cam, world.surface.width, world.surface.height);

  for (let ty = Math.max(top, 0); ty < bottom; ty++) {
    for (let tx = Math.max(left, 0); tx < right; tx++) {
      // sgGet is read for future SurfaceTileState-aware decoration biasing.
      void sgGet(world.surface, tx, ty);
      const worldX = tx * TILE_SIZE_PX;
      const worldY = ty * TILE_SIZE_PX;
      drawBarrenEarthTile(gfx, world, worldX, worldY, tx, ty);
    }
  }
}

// ---------------------------------------------------------------------------
// drawSurfaceEntities
// ---------------------------------------------------------------------------

/**
 * Draw food piles, entrance holes, and ants (workers + queens) on the surface, in
 * WORLD pixels (the main camera projects them).
 *
 * Moving entities (ants) are interpolated between prev and curr state at alpha.
 * Static entities (food piles, entrances) read directly from curr. (VIEW-03)
 *
 * `entranceHover` is the Stage 1 controls-rework hover outline (issue #18): when
 * non-null, a 2-px frame is drawn on the tile under the pointer while the Dig tool is
 * active on the surface — GREEN when valid, RED otherwise. GameScene recomputes the
 * tile + validity from the live camera every frame.
 */
export function drawSurfaceEntities(
  gfx: GfxLike,
  sprites: AntSpriteLayer,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  cam: CameraView,
  entranceHover: { tileX: number; tileY: number; valid: boolean } | null = null,
  facing?: AntFacingCache,
  frameTimeMs: number = 0,
  contestedGlowFrames?: Map<number, number>,
  currentFrame: number = 0,
  // Overlay layer for primitives that must render ABOVE the sprite pool
  // (SPIDER_SPRITE_DEPTH = 52). GameScene supplies a higher-depth Graphics; callers
  // that omit it fall back to the base gfx.
  overlayGfx: GfxLike = gfx,
  // Stage 2 §C13: strategic LOD — when true, ants render as screen-constant dots and the
  // ant-derived contested-glow pass is skipped (allocation-free strategic frame).
  dotMode: boolean = false,
): void {
  const rect = visibleWorldRect(cam);

  // --- Food piles ---
  // Issue #112 shrink buckets: each pile renders one of 4 sizes based on
  // pickupsRemaining / pickupsInitial.
  const playerColony = curr.colonies[PLAYER_COLONY_ID];
  const playerPriorityPileId = playerColony ? playerColony.priorityFoodPileId : null;
  const baseRadius = TILE_SIZE_PX / 2 - 2;
  for (const pile of curr.foodPiles) {
    const wx = pile.tileX * TILE_SIZE_PX;
    const wy = pile.tileY * TILE_SIZE_PX;
    if (!tileInView(wx, wy, rect, TILE_SIZE_PX)) continue;
    const isPlayerMarked =
      playerPriorityPileId !== null && pile.foodPileId === playerPriorityPileId;
    const color = isPlayerMarked ? COLOR_FOOD_PILE_MARKED : COLOR_FOOD_PILE_NORMAL;
    const cx = wx + TILE_SIZE_PX / 2;
    const cy = wy + TILE_SIZE_PX / 2;
    // Shrink-bucket radius: percent-remaining buckets in [>75%, >50%, >25%, >0%].
    const pct = pile.pickupsRemaining / pile.pickupsInitial;
    let r = baseRadius;
    if (pct <= 0.75) r = baseRadius - 2;
    if (pct <= 0.5) r = baseRadius - 4;
    if (pct <= 0.25) r = baseRadius - 6;
    // Floor at 1 so a not-yet-vanished pile is always visible.
    if (r < 1) r = 1;
    gfx.fillStyle(color, 1);
    gfx.fillCircle(cx, cy, r);
    gfx.lineStyle(1, 0x000000, 0.6);
    gfx.strokeCircle(cx, cy, r);
  }

  // --- Entrance holes on surface (issue #117) ---
  // Round hole in a piled-dirt mound. Three concentric circles plus, for enemy
  // entrances, a thin enemy-colored ring just outside the mound. The footprint spills
  // MOUND_SPILL_PX onto each adjacent tile, so the cull margin is widened.
  const MOUND_SPILL_PX = 2;
  const MOUND_OUTER_R = TILE_SIZE_PX / 2 + MOUND_SPILL_PX; // 10
  const MOUND_BODY_R = TILE_SIZE_PX / 2 + 1; // 9
  const HOLE_R = TILE_SIZE_PX / 2 - 2; // 6
  for (const colony of Object.values(curr.colonies)) {
    if (!colony.entrances) continue;
    const isEnemy = colony.colonyId !== PLAYER_COLONY_ID;
    for (const entrance of colony.entrances) {
      const wx = entrance.surfaceTileX * TILE_SIZE_PX;
      const wy = entrance.surfaceTileY * TILE_SIZE_PX;
      if (!tileInView(wx, wy, rect, TILE_SIZE_PX + MOUND_SPILL_PX + 1)) continue;
      const cx = wx + TILE_SIZE_PX / 2;
      const cy = wy + TILE_SIZE_PX / 2;
      // Outer mound rim: lighter spoil tone.
      gfx.fillStyle(COLOR_BARREN_EARTH_MOUND, 1);
      gfx.fillCircle(cx, cy, MOUND_OUTER_R);
      // Mound body: darker damp earth.
      gfx.fillStyle(COLOR_BARREN_EARTH_DAMP, 1);
      gfx.fillCircle(cx, cy, MOUND_BODY_R);
      // Hole interior — round dark cavity.
      gfx.fillStyle(COLOR_SURFACE_ENTRANCE_HOLE, 1);
      gfx.fillCircle(cx, cy, HOLE_R);
      if (isEnemy) {
        // 1-px enemy-colony ring just outside the mound.
        gfx.lineStyle(1, COLOR_ENEMY_COLONY, 1);
        gfx.strokeCircle(cx, cy, MOUND_OUTER_R);
      }
    }
  }

  // --- Surface contested tile glow (S1 → S6 polished) ---
  // S6: surface combat uses COLOR_NEUTRAL_CONTESTED_GLOW (yellow). A 5-frame fade-out
  // is tracked via contestedGlowFrames. Skipped in strategic dot mode (allocation-free
  // pass — no per-entity Map/Set scan; §C13/R3-2).
  if (!dotMode) {
    const tileColony = new Map<number, number>(); // tileKey → first colonyId
    const contested = new Set<number>();
    const n = curr.ants.alive.length;
    for (let id = 0; id < n; id++) {
      if (!isAlive(curr.ants, id)) continue;
      if (curr.ants.zone[id] !== 0) continue;
      const tx = curr.ants.posX[id]! >> 8;
      const ty = curr.ants.posY[id]! >> 8;
      const key = (ty << 16) | tx;
      const cid = curr.ants.colonyId[id]!;
      const existing = tileColony.get(key);
      if (existing === undefined) tileColony.set(key, cid);
      else if (existing !== cid) contested.add(key);
    }
    // Stamp active contested tiles with the current frame number.
    if (contestedGlowFrames) {
      for (const key of contested) {
        contestedGlowFrames.set(key, currentFrame);
      }
    }
    // Draw glows for all tiles contested within the last 5 frames.
    const GLOW_FADE_FRAMES = 5;
    const tilesToDraw = contestedGlowFrames ? contestedGlowFrames : null;
    const drawKeys = tilesToDraw
      ? Array.from(tilesToDraw.entries())
          .filter(([, frame]) => currentFrame - frame < GLOW_FADE_FRAMES)
          .map(([key]) => key)
      : Array.from(contested);
    for (const key of drawKeys) {
      const tx = key & 0xffff;
      const ty = (key >> 16) & 0xffff;
      const wx = tx * TILE_SIZE_PX;
      const wy = ty * TILE_SIZE_PX;
      if (!tileInView(wx, wy, rect, TILE_SIZE_PX)) continue;
      // Fade alpha based on frames since last seen.
      const framesAgo = tilesToDraw ? currentFrame - (tilesToDraw.get(key) ?? currentFrame) : 0;
      const alpha_g = 0.15 * (1 - framesAgo / GLOW_FADE_FRAMES);
      if (alpha_g <= 0) continue;
      // Soft edge: center tile at full alpha, then 1px-thin border rects at half alpha.
      gfx.fillStyle(COLOR_NEUTRAL_CONTESTED_GLOW, alpha_g);
      gfx.fillRect(wx + 2, wy + 2, TILE_SIZE_PX - 4, TILE_SIZE_PX - 4);
      gfx.fillStyle(COLOR_NEUTRAL_CONTESTED_GLOW, alpha_g * 0.5);
      gfx.fillRect(wx, wy, TILE_SIZE_PX, 2);
      gfx.fillRect(wx, wy + TILE_SIZE_PX - 2, TILE_SIZE_PX, 2);
      gfx.fillRect(wx, wy + 2, 2, TILE_SIZE_PX - 4);
      gfx.fillRect(wx + TILE_SIZE_PX - 2, wy + 2, 2, TILE_SIZE_PX - 4);
    }
    // Prune stale entries so the map doesn't grow without bound.
    if (tilesToDraw) {
      for (const [key, frame] of tilesToDraw) {
        if (currentFrame - frame >= GLOW_FADE_FRAMES) tilesToDraw.delete(key);
      }
    }
  }

  // --- Hunt reticle (S3 → S6 polished) ---
  if (curr.scatterReticleTile !== null) {
    const { x: rtx, y: rty } = curr.scatterReticleTile;
    const rwx = rtx * TILE_SIZE_PX;
    const rwy = rty * TILE_SIZE_PX;
    if (tileInView(rwx, rwy, rect, TILE_SIZE_PX)) {
      // Pulse: alpha oscillates between 0.4 and 0.7 at 1 Hz.
      const pulse = 0.55 + 0.15 * Math.sin((2 * Math.PI * frameTimeMs) / 1000);
      // Scale: 1.0–1.05× on pulse (shift origin to tile center).
      const scalePulse = 1.0 + 0.025 * Math.sin((2 * Math.PI * frameTimeMs) / 1000);
      const sizeOffset = (TILE_SIZE_PX * (scalePulse - 1)) / 2;
      // Tile fill at 0.3 alpha.
      gfx.fillStyle(0xcc1010, 0.3);
      gfx.fillRect(
        rwx - sizeOffset,
        rwy - sizeOffset,
        TILE_SIZE_PX * scalePulse,
        TILE_SIZE_PX * scalePulse,
      );
      // Border at pulsed alpha: 2-px edge strips.
      const bw = TILE_SIZE_PX * scalePulse;
      const bh = TILE_SIZE_PX * scalePulse;
      const bx = rwx - sizeOffset;
      const by = rwy - sizeOffset;
      gfx.fillStyle(0xcc1010, pulse);
      gfx.fillRect(bx, by, bw, 2);
      gfx.fillRect(bx, by + bh - 2, bw, 2);
      gfx.fillRect(bx, by + 2, 2, bh - 4);
      gfx.fillRect(bx + bw - 2, by + 2, 2, bh - 4);
    }
  }

  // --- Ants on surface (zone === 0) ---
  // Wrong-plane flicker guard: when an ant's zone flipped between prev and curr, OR
  // the slot wasn't alive in prev, snap to curr (interpolating would draw it somewhere
  // it never was).
  const maxId = curr.ants.alive.length;
  for (let id = 0; id < maxId; id++) {
    if (!isAlive(curr.ants, id)) continue;
    if (curr.ants.zone[id] !== 0) continue; // surface only

    const useInterp = isAlive(prev.ants, id) && prev.ants.zone[id] === curr.ants.zone[id];

    // Interpolate position: fixed-point → world px. Multiply BEFORE dividing so
    // sub-tile precision survives.
    const prevPxX = (prev.ants.posX[id]! * TILE_SIZE_PX) / FP_ONE;
    const currPxX = (curr.ants.posX[id]! * TILE_SIZE_PX) / FP_ONE;
    const prevPxY = (prev.ants.posY[id]! * TILE_SIZE_PX) / FP_ONE;
    const currPxY = (curr.ants.posY[id]! * TILE_SIZE_PX) / FP_ONE;

    const worldX = useInterp ? prevPxX + (currPxX - prevPxX) * alpha : currPxX;
    const worldY = useInterp ? prevPxY + (currPxY - prevPxY) * alpha : currPxY;

    // Trivial world-rect cull.
    if (!tileInView(worldX, worldY, rect, TILE_SIZE_PX)) continue;

    // Strategic LOD (§C13): a screen-constant colony-colored dot instead of the detailed
    // sprite — allocation-free (no facing/containment/sprite-pool work). ANT_DOT_SCREEN_PX
    // / zoom keeps it ~constant on screen as the camera zooms out.
    if (dotMode) {
      const dotColor =
        curr.ants.colonyId[id]! === PLAYER_COLONY_ID ? COLOR_PLAYER_COLONY : COLOR_ENEMY_COLONY;
      const ds = ANT_DOT_SCREEN_PX / cam.zoom;
      gfx.fillStyle(dotColor, 1);
      gfx.fillRect(worldX - ds / 2, worldY - ds / 2, ds, ds);
      continue;
    }

    const colonyId = curr.ants.colonyId[id]!;
    const colony = curr.colonies[colonyId];
    const isQueen = colony !== undefined && id === colony.queenEntityId;

    const color = colonyId === PLAYER_COLONY_ID ? COLOR_PLAYER_COLONY : COLOR_ENEMY_COLONY;

    // Facing: rotate the SVG so the head points along the motion vector; smoothing via
    // AntFacingCache when supplied. Stationary ants reuse the prior smoothed rotation.
    const dx = currPxX - prevPxX;
    const dy = currPxY - prevPxY;
    const rotation = computeAntRotation(facing, id, curr.ants.zone[id]!, dx, dy, useInterp);

    const isFighter = curr.ants.task[id] === AntTask.Fighting;
    sprites.drawAnt({
      kind: isQueen ? 'queen' : 'worker',
      x: worldX,
      y: worldY,
      // S1: fighters get a red tint blended over their colony color.
      tint: isFighter && !isQueen ? lerpColor(color, COLOR_FIGHTER_TINT, 0.45) : color,
      rotation,
      // S1: fighters render slightly larger.
      scale: isFighter && !isQueen ? 1.25 : 1.0,
    });
  }

  // --- Spider sprite + hunger ring (S3) ---
  // Drawn above ants (SPIDER_SPRITE_DEPTH = 52 > ANT_SPRITE_DEPTH = 50). Spider is
  // always on the surface regardless of behavior state.
  if (curr.spider !== null) {
    const spiderPrev = prev.spider;
    const currPxX = (curr.spider.posX * TILE_SIZE_PX) / FP_ONE;
    const currPxY = (curr.spider.posY * TILE_SIZE_PX) / FP_ONE;
    const prevPxX = spiderPrev !== null ? (spiderPrev.posX * TILE_SIZE_PX) / FP_ONE : currPxX;
    const prevPxY = spiderPrev !== null ? (spiderPrev.posY * TILE_SIZE_PX) / FP_ONE : currPxY;
    const useSpiderInterp = spiderPrev !== null;
    const spiderWorldX = useSpiderInterp ? prevPxX + (currPxX - prevPxX) * alpha : currPxX;
    const spiderWorldY = useSpiderInterp ? prevPxY + (currPxY - prevPxY) * alpha : currPxY;

    if (
      spiderWorldX > rect.left - SPIDER_SPRITE_WIDTH &&
      spiderWorldX < rect.right + SPIDER_SPRITE_WIDTH &&
      spiderWorldY > rect.top - SPIDER_SPRITE_HEIGHT &&
      spiderWorldY < rect.bottom + SPIDER_SPRITE_HEIGHT
    ) {
      const hungerFraction = Math.min(
        curr.spider.hungerTicks / SPIDER_HUNGER_MAX_TICKS[tierIndex(curr.difficulty)],
        1,
      );
      // S6: linear tint gradient pale (#ffeecc) → deep red (#cc2020) by hungerFraction.
      const tint = lerpColor(0xffeecc, 0xcc2020, hungerFraction);

      sprites.drawSpider({ x: spiderWorldX, y: spiderWorldY, tint });

      // Hunger ring (S3 → S6 polished): appears at 70% hunger, fades to full at 100%.
      if (hungerFraction > 0.7) {
        const baseRingAlpha = ((hungerFraction - 0.7) / 0.3) * 0.85;
        const rampagePulse =
          hungerFraction >= 0.8 ? 0.1 * Math.sin((2 * Math.PI * frameTimeMs) / 2000) : 0;
        const ringAlpha = Math.min(1, baseRingAlpha + rampagePulse);
        const rl = Math.round(spiderWorldX - SPIDER_SPRITE_WIDTH / 2);
        const rt = Math.round(spiderWorldY - SPIDER_SPRITE_HEIGHT / 2);
        const rw = SPIDER_SPRITE_WIDTH;
        const rh = SPIDER_SPRITE_HEIGHT;
        const ringColor = lerpColor(0xffeecc, 0xcc2020, hungerFraction);
        gfx.fillStyle(ringColor, ringAlpha);
        gfx.fillRect(rl, rt, rw, 2);
        gfx.fillRect(rl, rt + rh - 2, rw, 2);
        gfx.fillRect(rl, rt + 2, 2, rh - 4);
        gfx.fillRect(rl + rw - 2, rt + 2, 2, rh - 4);
      }

      // S7/D1: spider priority indicator — white border when player has set priority.
      if (curr.spiderPriorityColonyId === PLAYER_COLONY_ID) {
        const pl = Math.round(spiderWorldX - SPIDER_SPRITE_WIDTH / 2) - 2;
        const pt = Math.round(spiderWorldY - SPIDER_SPRITE_HEIGHT / 2) - 2;
        const pw = SPIDER_SPRITE_WIDTH + 4;
        const ph = SPIDER_SPRITE_HEIGHT + 4;
        gfx.fillStyle(0xffffff, 1);
        gfx.fillRect(pl, pt, pw, 2);
        gfx.fillRect(pl, pt + ph - 2, pw, 2);
        gfx.fillRect(pl, pt + 2, 2, ph - 4);
        gfx.fillRect(pl + pw - 2, pt + 2, 2, ph - 4);
      }

      // Health bar (issue #148): render-only HP indicator above the sprite, drawn on
      // overlayGfx so it renders above the spider sprite.
      const hpRatio = Math.max(0, Math.min(1, curr.spider.hp / SPIDER_HP_FULL));
      if (hpRatio < 1) {
        const barW = 24;
        const barH = 4;
        const barX = Math.round(spiderWorldX - barW / 2);
        const barY = Math.round(spiderWorldY - SPIDER_SPRITE_HEIGHT / 2 - barH - 4);
        const fillColor =
          hpRatio > 0.5
            ? lerpColor(0xffcc00, 0x33cc33, (hpRatio - 0.5) / 0.5)
            : lerpColor(0xcc2020, 0xffcc00, hpRatio / 0.5);
        const fillW =
          hpRatio <= 0 ? 0 : Math.max(1, Math.min(barW - 1, Math.round(barW * hpRatio)));
        overlayGfx.fillStyle(0x000000, 0.7);
        overlayGfx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
        overlayGfx.fillStyle(0x333333, 0.85);
        overlayGfx.fillRect(barX, barY, barW, barH);
        overlayGfx.fillStyle(fillColor, 1);
        overlayGfx.fillRect(barX, barY, fillW, barH);
      }
    }
  }

  // --- Rally-point marker (Phase 9 usability fix) ---
  // Player-colony only: a white crosshair on the rally tile. Enemy rally points are
  // never drawn (leaks AI intent).
  if (playerColony && playerColony.rallyPoint !== null) {
    const rp = playerColony.rallyPoint;
    const wx = rp.tileX * TILE_SIZE_PX;
    const wy = rp.tileY * TILE_SIZE_PX;
    if (tileInView(wx, wy, rect, TILE_SIZE_PX)) {
      gfx.fillStyle(COLOR_RALLY_POINT, 1);
      // Horizontal bar across the tile (leave 1-px edges so adjacent tiles don't fuse).
      gfx.fillRect(wx + 1, wy + 7, TILE_SIZE_PX - 2, 2);
      // Vertical bar across the tile.
      gfx.fillRect(wx + 7, wy + 1, 2, TILE_SIZE_PX - 2);
      // Center square accent.
      gfx.fillRect(wx + 6, wy + 6, 4, 4);
    }
  }

  // --- Entrance hover outline (Stage 1 controls rework, issue #18) ---
  // A 2-px frame on the tile under the pointer while the Dig tool is active: GREEN when
  // DesignateEntrance would accept, RED otherwise. GameScene re-resolves tile + validity
  // from the live camera every frame.
  if (entranceHover !== null) {
    const wx = entranceHover.tileX * TILE_SIZE_PX;
    const wy = entranceHover.tileY * TILE_SIZE_PX;
    if (tileInView(wx, wy, rect, TILE_SIZE_PX)) {
      gfx.fillStyle(
        entranceHover.valid ? COLOR_ENTRANCE_HOVER_VALID : COLOR_ENTRANCE_HOVER_INVALID,
        0.8,
      );
      gfx.fillRect(wx, wy, TILE_SIZE_PX, 2); // top
      gfx.fillRect(wx, wy + TILE_SIZE_PX - 2, TILE_SIZE_PX, 2); // bottom
      gfx.fillRect(wx, wy, 2, TILE_SIZE_PX); // left
      gfx.fillRect(wx + TILE_SIZE_PX - 2, wy, 2, TILE_SIZE_PX); // right
    }
  }
}

// ---------------------------------------------------------------------------
// drawSurface — orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrator: draw terrain then entities for the surface view.
 *
 * Note: pheromone overlay is drawn by GameScene between terrain and entities; it is
 * NOT called from here.
 */
export function drawSurface(
  gfx: GfxLike,
  sprites: AntSpriteLayer,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  cam: CameraView,
  entranceHover: { tileX: number; tileY: number; valid: boolean } | null = null,
  facing?: AntFacingCache,
): void {
  drawSurfaceTerrain(gfx, curr, cam);
  drawSurfaceEntities(gfx, sprites, prev, curr, alpha, cam, entranceHover, facing);
}
