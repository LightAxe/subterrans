// draw-surface.ts — Phase 8 surface view drawing module.
//
// Pure functions: take a GfxLike + AntSpriteLayer + WorldState snapshots,
// issue Graphics API calls and AntSpriteLayer.drawAnt calls. No scene
// management, no input handling, no state mutation.
//
// Non-ant primitives use ONLY Graphics: fillRect, fillCircle, strokeCircle,
// fillTriangle, lineStyle, fillStyle. Ants go through the AntSpriteLayer —
// GameScene plugs in a Phaser-backed sprite pool; tests plug in a recording
// mock. draw-surface.ts itself remains Phaser-free.
//
// Draw order: drawSurface calls drawSurfaceTerrain then drawSurfaceEntities.
// Pheromone overlay is NOT called from here — GameScene calls drawPheromoneOverlay
// between terrain and entities per RESEARCH §Architecture draw-order diagram.

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
  COLOR_QUEEN_OUTLINE,
  COLOR_RALLY_POINT,
  COLOR_FIGHTER_TINT,
  COLOR_CONTESTED_TILE,
  COLOR_NEUTRAL_CONTESTED_GLOW,
  lerpColor,
} from './sprites.js';
import {
  drawBarrenEarthTile,
  COLOR_BARREN_EARTH_DAMP,
  COLOR_BARREN_EARTH_MOUND,
} from './terrain-atlas.js';
export type { AntSpriteLayer } from './ant-sprite-layer.js';
import type { CameraState } from './camera.js';
import {
  SPIDER_SPRITE_HEIGHT,
  SPIDER_SPRITE_WIDTH,
} from './ant-sprite-layer.js';
import { SPIDER_HUNGER_MAX_TICKS } from '../sim/constants.js';
import { NORMAL_TIER_INDEX, tierIndex } from '../sim/ai-state.js';
import { SIM_VERSION_V22_DIFFICULTY } from '../sim/types.js';

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

/** Compute visible tile range from camera state. Returns { left, top, right, bottom }. */
function visibleRange(
  cam: CameraState,
  gridWidth: number,
  gridHeight: number,
): { left: number; top: number; right: number; bottom: number } {
  const left   = Math.floor(cam.x - cam.viewportWidth  / 2);
  const top    = Math.floor(cam.y - cam.viewportHeight / 2);
  const right  = Math.min(left + cam.viewportWidth  + 1, gridWidth);
  const bottom = Math.min(top  + cam.viewportHeight + 1, gridHeight);
  return { left, top, right, bottom };
}

// ---------------------------------------------------------------------------
// drawSurfaceTerrain
// ---------------------------------------------------------------------------

/**
 * Draw the surface terrain tiles visible through the camera.
 *
 * Issue #40 reframe: surface is barren-earth-default with grass tufts /
 * pebbles / twigs / dead leaves / stones scattered as deterministic
 * decoration. The sim-layer SurfaceTileState (Dirt vs. Grass) no longer maps
 * to dramatically different colors — we render the same earthy substrate
 * everywhere and let the per-tile motif scattering create variety. Grass
 * tiles still bias slightly toward live-grass tufts (vs. dry-grass on dirt
 * tiles), but the dominant readout is "ant-scale ground", not "lawn vs.
 * dirt patch". This puts the visual focus on the ants where it belongs.
 */
export function drawSurfaceTerrain(gfx: GfxLike, world: WorldState, cam: CameraState): void {
  const { left, top, right, bottom } = visibleRange(cam, world.surface.width, world.surface.height);

  for (let ty = Math.max(top, 0); ty < bottom; ty++) {
    for (let tx = Math.max(left, 0); tx < right; tx++) {
      // sgGet is read for future SurfaceTileState-aware decoration biasing
      // (live-grass density on grass tiles, etc.). Right now barren-earth is
      // the universal substrate.
      void sgGet(world.surface, tx, ty);
      const screenX = (tx - left) * TILE_SIZE_PX;
      const screenY = (ty - top)  * TILE_SIZE_PX;
      drawBarrenEarthTile(gfx, world, screenX, screenY, tx, ty);
    }
  }
}

// ---------------------------------------------------------------------------
// drawSurfaceEntities
// ---------------------------------------------------------------------------

/**
 * Draw food piles, entrance holes, and ants (workers + queens) on the surface.
 *
 * Moving entities (ants) are interpolated between prev and curr state at alpha.
 * Static entities (food piles, entrances) read directly from curr. (VIEW-03)
 *
 * `pendingEntrance` is the Phase 8.5 right-click preview: when non-null, a
 * gold frame is drawn on that tile so the player can see which tile a
 * confirming left-click will place the entrance at.
 */
export function drawSurfaceEntities(
  gfx: GfxLike,
  sprites: AntSpriteLayer,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  cam: CameraState,
  pendingEntrance: { tileX: number; tileY: number } | null = null,
  facing?: AntFacingCache,
  frameTimeMs: number = 0,
  contestedGlowFrames?: Map<number, number>,
  currentFrame: number = 0,
): void {
  const left = Math.floor(cam.x - cam.viewportWidth  / 2);
  const top  = Math.floor(cam.y - cam.viewportHeight / 2);

  const canvasW = cam.viewportWidth  * TILE_SIZE_PX;
  const canvasH = cam.viewportHeight * TILE_SIZE_PX;

  // --- Food piles ---
  // Phase 8.5 readability: add a 1-px dark outline to separate the green pile
  // circle from the green grass tile underneath.
  //
  // Per Phase 9 food-mark fix: the "marked" flag was moved off the shared
  // FoodPile entity (which is not per-colony) onto ColonyRecord. The HUD
  // renders the PLAYER colony's perspective only — enemy priority targets
  // stay invisible so the player can't read the enemy AI's intent.
  //
  // Issue #112 shrink buckets: each pile renders one of 4 sizes based on
  // `pickupsRemaining / pickupsInitial`. Bucketing against `pickupsInitial`
  // (per-pile starting size) ensures small ephemeral piles and large strategic
  // anchors both visibly shrink across their lifetime — a 30-pickup pile and
  // a 150-pickup pile both go full → ¾ → ½ → ¼ as they drain.
  const playerColony = curr.colonies[PLAYER_COLONY_ID];
  const playerPriorityPileId = playerColony ? playerColony.priorityFoodPileId : null;
  const baseRadius = TILE_SIZE_PX / 2 - 2;
  for (const pile of curr.foodPiles) {
    const sx = (pile.tileX - left) * TILE_SIZE_PX;
    const sy = (pile.tileY - top)  * TILE_SIZE_PX;
    // Trivial viewport cull
    if (sx < -TILE_SIZE_PX || sx > canvasW || sy < -TILE_SIZE_PX || sy > canvasH) continue;
    const isPlayerMarked = playerPriorityPileId !== null && pile.foodPileId === playerPriorityPileId;
    const color = isPlayerMarked ? COLOR_FOOD_PILE_MARKED : COLOR_FOOD_PILE_NORMAL;
    const cx = sx + TILE_SIZE_PX / 2;
    const cy = sy + TILE_SIZE_PX / 2;
    // Shrink-bucket radius: percent-remaining buckets in [>75%, >50%, >25%, >0%].
    // pickupsInitial > 0 by validator + scenario contract, so the divide is safe.
    // Reads as floats are fine here — render layer is float-permitted (the sim
    // float-ban only applies to src/sim/).
    const pct = pile.pickupsRemaining / pile.pickupsInitial;
    let r = baseRadius;
    if (pct <= 0.75) r = baseRadius - 2;
    if (pct <= 0.50) r = baseRadius - 4;
    if (pct <= 0.25) r = baseRadius - 6;
    // Floor at 1: with TILE_SIZE_PX = 16, baseRadius = 6, so the smallest
    // bucket would compute to r = 0 — invisible. Snap to 1px so a not-yet-
    // vanished pile is always visible. Once the pile drains to 0 charges,
    // the sim splices it out of foodPiles (food-system.ts) and this loop
    // never sees it again, so there's no "ghost 1px circle" risk.
    if (r < 1) r = 1;
    gfx.fillStyle(color, 1);
    gfx.fillCircle(cx, cy, r);
    gfx.lineStyle(1, 0x000000, 0.6);
    gfx.strokeCircle(cx, cy, r);
  }

  // --- Entrance holes on surface (issue #117) ---
  // Round hole in a piled-dirt mound. Three concentric circles (mound rim →
  // mound body → hole interior) plus, for enemy entrances, a thin
  // enemy-colored ring traced just outside the mound.
  //
  // Footprint spills 2 px onto each adjacent tile so the entrance reads as a
  // 3-D bump on the surface, not a flat painted disc. The viewport cull
  // margin below is widened from `TILE_SIZE_PX` to `TILE_SIZE_PX + MOUND_SPILL_PX + 1`
  // so a tile whose mound spills onto a visible neighbor is still drawn even
  // when its own center sits slightly off-screen.
  //
  // Diameters / radii at TILE_SIZE_PX = 16:
  //   mound (outer)   = 10 px → spills 2 px onto each neighbor
  //   mound (body)    = 9 px  → 1 px lighter rim around the body for shading
  //   hole (interior) = 6 px  → matches food-pile baseRadius for visual weight
  //
  // Issue #14 cue: enemy entrances get a 1-px enemy-colony stroke around the
  // mound so the player reads them as "rally here to invade" targets.
  const MOUND_SPILL_PX = 2;
  const MOUND_OUTER_R  = TILE_SIZE_PX / 2 + MOUND_SPILL_PX; // 10
  const MOUND_BODY_R   = TILE_SIZE_PX / 2 + 1;              // 9 — 1px lighter rim shows around the body
  const HOLE_R         = TILE_SIZE_PX / 2 - 2;              // 6 — matches food pile baseRadius
  for (const colony of Object.values(curr.colonies)) {
    if (!colony.entrances) continue;
    const isEnemy = colony.colonyId !== PLAYER_COLONY_ID;
    for (const entrance of colony.entrances) {
      const sx = (entrance.surfaceTileX - left) * TILE_SIZE_PX;
      const sy = (entrance.surfaceTileY - top)  * TILE_SIZE_PX;
      const cullMargin = TILE_SIZE_PX + MOUND_SPILL_PX + 1;
      if (sx < -cullMargin || sx > canvasW + MOUND_SPILL_PX
        || sy < -cullMargin || sy > canvasH + MOUND_SPILL_PX) continue;
      const cx = sx + TILE_SIZE_PX / 2;
      const cy = sy + TILE_SIZE_PX / 2;
      // Outer mound rim: lighter spoil tone — reads as "raised dirt edge."
      gfx.fillStyle(COLOR_BARREN_EARTH_MOUND, 1);
      gfx.fillCircle(cx, cy, MOUND_OUTER_R);
      // Mound body: darker damp earth — reads as the "shadowed inside" of the mound.
      gfx.fillStyle(COLOR_BARREN_EARTH_DAMP, 1);
      gfx.fillCircle(cx, cy, MOUND_BODY_R);
      // Hole interior — round dark cavity.
      gfx.fillStyle(COLOR_SURFACE_ENTRANCE_HOLE, 1);
      gfx.fillCircle(cx, cy, HOLE_R);
      if (isEnemy) {
        // 1-px enemy-colony ring traced just outside the mound. Replaces the
        // four-rect rectangle with a stroke that follows the mound's circular
        // silhouette so the cue reads as "this is an enemy entrance" without
        // visually fighting the round shape.
        gfx.lineStyle(1, COLOR_ENEMY_COLONY, 1);
        gfx.strokeCircle(cx, cy, MOUND_OUTER_R);
      }
    }
  }

  // --- Surface contested tile glow (S1 → S6 polished) ---
  // S6: surface combat uses COLOR_NEUTRAL_CONTESTED_GLOW (yellow) instead of
  // the raw orange. A 5-frame fade-out is tracked via contestedGlowFrames.
  {
    const tileColony = new Map<number, number>(); // tileKey → first colonyId
    const contested  = new Set<number>();
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
    // Draw glows for all tiles that were contested within the last 5 frames.
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
      const sx = (tx - left) * TILE_SIZE_PX;
      const sy = (ty - top)  * TILE_SIZE_PX;
      if (sx < -TILE_SIZE_PX || sx > canvasW || sy < -TILE_SIZE_PX || sy > canvasH) continue;
      // Fade alpha based on frames since last seen.
      const framesAgo = tilesToDraw ? (currentFrame - (tilesToDraw.get(key) ?? currentFrame)) : 0;
      const alpha_g = 0.15 * (1 - framesAgo / GLOW_FADE_FRAMES);
      if (alpha_g <= 0) continue;
      // Soft edge: draw the center tile at full alpha, then draw 1px-thin
      // border rects at half alpha to create a soft halo effect.
      gfx.fillStyle(COLOR_NEUTRAL_CONTESTED_GLOW, alpha_g);
      gfx.fillRect(sx + 2, sy + 2, TILE_SIZE_PX - 4, TILE_SIZE_PX - 4);
      gfx.fillStyle(COLOR_NEUTRAL_CONTESTED_GLOW, alpha_g * 0.5);
      gfx.fillRect(sx,      sy,      TILE_SIZE_PX, 2);
      gfx.fillRect(sx,      sy + TILE_SIZE_PX - 2, TILE_SIZE_PX, 2);
      gfx.fillRect(sx,      sy + 2,  2, TILE_SIZE_PX - 4);
      gfx.fillRect(sx + TILE_SIZE_PX - 2, sy + 2, 2, TILE_SIZE_PX - 4);
    }
    // Prune stale entries so the map doesn't grow without bound.
    if (tilesToDraw) {
      for (const [key, frame] of tilesToDraw) {
        if (currentFrame - frame >= GLOW_FADE_FRAMES) tilesToDraw.delete(key);
      }
    }
  }

  // --- Hunt reticle (S3 → S6 polished) ---
  // S6: deep red border with animated alpha pulse; subtle fill at 0.3 alpha.
  if (curr.scatterReticleTile !== null) {
    const { x: rtx, y: rty } = curr.scatterReticleTile;
    const rsx = (rtx - left) * TILE_SIZE_PX;
    const rsy = (rty - top)  * TILE_SIZE_PX;
    if (rsx > -TILE_SIZE_PX && rsx < canvasW && rsy > -TILE_SIZE_PX && rsy < canvasH) {
      // Pulse: alpha oscillates between 0.4 and 0.7 at 1 Hz.
      const pulse = 0.55 + 0.15 * Math.sin((2 * Math.PI * frameTimeMs) / 1000);
      // Scale: 1.0–1.05× on pulse (shift origin to tile center).
      const scalePulse = 1.0 + 0.025 * Math.sin((2 * Math.PI * frameTimeMs) / 1000);
      const sizeOffset = (TILE_SIZE_PX * (scalePulse - 1)) / 2;
      // Tile fill at 0.3 alpha.
      gfx.fillStyle(0xcc1010, 0.3);
      gfx.fillRect(
        rsx - sizeOffset, rsy - sizeOffset,
        TILE_SIZE_PX * scalePulse, TILE_SIZE_PX * scalePulse,
      );
      // Border at pulsed alpha: draw as 2-px edge strips.
      const bw = TILE_SIZE_PX * scalePulse;
      const bh = TILE_SIZE_PX * scalePulse;
      const bx = rsx - sizeOffset;
      const by = rsy - sizeOffset;
      gfx.fillStyle(0xcc1010, pulse);
      gfx.fillRect(bx,          by,          bw, 2);
      gfx.fillRect(bx,          by + bh - 2, bw, 2);
      gfx.fillRect(bx,          by + 2,      2,  bh - 4);
      gfx.fillRect(bx + bw - 2, by + 2,      2,  bh - 4);
    }
  }

  // --- Ants on surface (zone === 0) ---
  // Wrong-plane flicker guard (09 render polish): when an ant's zone flipped
  // between prev and curr (e.g. queen descending through an entrance), OR when
  // the slot wasn't alive in prev (a freshly-spawned ant whose prev.posX/Y is
  // a stale default like 0), interpolating prev→curr briefly draws the ant
  // somewhere it never actually was. Snap to the curr position in those cases.
  const maxId = curr.ants.alive.length;
  for (let id = 0; id < maxId; id++) {
    if (!isAlive(curr.ants, id)) continue;
    if (curr.ants.zone[id] !== 0) continue; // surface only

    const useInterp = isAlive(prev.ants, id) && prev.ants.zone[id] === curr.ants.zone[id];

    // Interpolate position: fixed-point → pixel. Multiply BEFORE dividing so
    // sub-tile precision survives — truncating with `>> FP_SHIFT` first would
    // snap the ant to its tile's upper-left corner and it would appear
    // pinned to tile origins instead of moving smoothly within a tile.
    const prevPxX = (prev.ants.posX[id]! * TILE_SIZE_PX) / FP_ONE;
    const currPxX = (curr.ants.posX[id]! * TILE_SIZE_PX) / FP_ONE;
    const prevPxY = (prev.ants.posY[id]! * TILE_SIZE_PX) / FP_ONE;
    const currPxY = (curr.ants.posY[id]! * TILE_SIZE_PX) / FP_ONE;

    const baseX = useInterp ? prevPxX + (currPxX - prevPxX) * alpha : currPxX;
    const baseY = useInterp ? prevPxY + (currPxY - prevPxY) * alpha : currPxY;
    const screenX = baseX - left * TILE_SIZE_PX;
    const screenY = baseY - top  * TILE_SIZE_PX;

    // Trivial viewport cull
    if (screenX < -TILE_SIZE_PX || screenX > canvasW || screenY < -TILE_SIZE_PX || screenY > canvasH) continue;

    const colonyId = curr.ants.colonyId[id]!;
    const colony = curr.colonies[colonyId];
    const isQueen = colony !== undefined && id === colony.queenEntityId;

    const color = colonyId === PLAYER_COLONY_ID ? COLOR_PLAYER_COLONY : COLOR_ENEMY_COLONY;

    // Facing: rotate the SVG (head on -x natively) so the head points along
    // the motion vector. Smoothing is applied by the AntFacingCache when one
    // is supplied (GameScene owns the instance and hands it to every frame)
    // — blends recent deltas so cardinal zig-zag movement reads as a diagonal
    // facing instead of flipping axis every tick. Stationary ants reuse the
    // prior smoothed rotation so the sprite holds its pose instead of
    // snapping back to the default. When useInterp is false (zone flip or
    // spawn frame) the delta is meaningless and the cache evicts stale state;
    // rotation falls back to the sprite's default pose. See
    // AntSpriteDrawOptions.rotation for the math and ant-facing-cache.ts for
    // the blending contract.
    const dx = currPxX - prevPxX;
    const dy = currPxY - prevPxY;
    const rotation = computeAntRotation(facing, id, curr.ants.zone[id]!, dx, dy, useInterp);

    const isFighter = curr.ants.task[id] === AntTask.Fighting;
    sprites.drawAnt({
      kind: isQueen ? 'queen' : 'worker',
      x: screenX,
      y: screenY,
      // S1: fighters get a red tint blended over their colony color.
      tint: isFighter && !isQueen ? lerpColor(color, COLOR_FIGHTER_TINT, 0.45) : color,
      rotation,
      // S1: fighters render slightly larger (+1px equivalent at TILE_SIZE_PX=16).
      scale: isFighter && !isQueen ? 1.25 : 1.0,
    });
  }

  // --- Spider sprite + hunger ring (S3) ---
  // Drawn above ants (SPIDER_SPRITE_DEPTH = 52 > ANT_SPRITE_DEPTH = 50).
  // Spider is always on the surface regardless of behavior state.
  if (curr.spider !== null) {
    const spiderPrev = prev.spider;
    const currPxX = (curr.spider.posX * TILE_SIZE_PX) / FP_ONE;
    const currPxY = (curr.spider.posY * TILE_SIZE_PX) / FP_ONE;
    const prevPxX = spiderPrev !== null ? (spiderPrev.posX * TILE_SIZE_PX) / FP_ONE : currPxX;
    const prevPxY = spiderPrev !== null ? (spiderPrev.posY * TILE_SIZE_PX) / FP_ONE : currPxY;
    // Spider has no zone field (surface-only) and never teleports between ticks,
    // so a null-check on prev.spider suffices as the interp guard.
    const useSpiderInterp = spiderPrev !== null;
    const baseSX = useSpiderInterp ? prevPxX + (currPxX - prevPxX) * alpha : currPxX;
    const baseSY = useSpiderInterp ? prevPxY + (currPxY - prevPxY) * alpha : currPxY;
    const spiderScreenX = baseSX - left * TILE_SIZE_PX;
    const spiderScreenY = baseSY - top  * TILE_SIZE_PX;

    if (spiderScreenX > -SPIDER_SPRITE_WIDTH  && spiderScreenX < canvasW + SPIDER_SPRITE_WIDTH
      && spiderScreenY > -SPIDER_SPRITE_HEIGHT && spiderScreenY < canvasH + SPIDER_SPRITE_HEIGHT) {

      const hungerFraction = Math.min(
        curr.spider.hungerTicks / SPIDER_HUNGER_MAX_TICKS[curr.simVersion >= SIM_VERSION_V22_DIFFICULTY ? tierIndex(curr.difficulty) : NORMAL_TIER_INDEX],
        1,
      );
      // S6: linear tint gradient pale (#ffeecc) → deep red (#cc2020) by hungerFraction.
      const tint = lerpColor(0xffeecc, 0xcc2020, hungerFraction);

      sprites.drawSpider({ x: spiderScreenX, y: spiderScreenY, tint });

      // Hunger ring (S3 → S6 polished):
      // Appears at 70% hunger, fades in to full alpha at 100%.
      // At ≥80%, an additional faster pulse (0.5 Hz) signals rampage warning.
      if (hungerFraction > 0.7) {
        const baseRingAlpha = ((hungerFraction - 0.7) / 0.3) * 0.85;
        // S6: rampage warning pulse at ≥80% hunger.
        const rampagePulse = hungerFraction >= 0.8
          ? 0.1 * Math.sin((2 * Math.PI * frameTimeMs) / 2000)
          : 0;
        const ringAlpha = Math.min(1, baseRingAlpha + rampagePulse);
        const rl = Math.round(spiderScreenX - SPIDER_SPRITE_WIDTH  / 2);
        const rt = Math.round(spiderScreenY - SPIDER_SPRITE_HEIGHT / 2);
        const rw = SPIDER_SPRITE_WIDTH;
        const rh = SPIDER_SPRITE_HEIGHT;
        // S6: smooth gradient by color-lerping the ring toward deep red.
        const ringColor = lerpColor(0xffeecc, 0xcc2020, hungerFraction);
        gfx.fillStyle(ringColor, ringAlpha);
        gfx.fillRect(rl,          rt,          rw, 2);
        gfx.fillRect(rl,          rt + rh - 2, rw, 2);
        gfx.fillRect(rl,          rt + 2,      2,  rh - 4);
        gfx.fillRect(rl + rw - 2, rt + 2,      2,  rh - 4);
      }

      // S7/D1: spider priority indicator — white border when player has set priority.
      if (curr.spiderPriorityColonyId === PLAYER_COLONY_ID) {
        const pl = Math.round(spiderScreenX - SPIDER_SPRITE_WIDTH  / 2);
        const pt = Math.round(spiderScreenY - SPIDER_SPRITE_HEIGHT / 2);
        const pw = SPIDER_SPRITE_WIDTH;
        const ph = SPIDER_SPRITE_HEIGHT;
        gfx.fillStyle(0xffffff, 1);
        gfx.fillRect(pl,          pt,          pw, 2);
        gfx.fillRect(pl,          pt + ph - 2, pw, 2);
        gfx.fillRect(pl,          pt + 2,      2,  ph - 4);
        gfx.fillRect(pl + pw - 2, pt + 2,      2,  ph - 4);
      }
    }
  }

  // --- Rally-point marker (Phase 9 usability fix) ---
  // Player-colony only: a crosshair on the rally tile so the fight-control loop
  // is visible and discoverable. Distinct from every other surface symbol:
  //   - food piles         → filled green circle w/ dark outline
  //   - marked food pile   → filled gold circle
  //   - entrance           → dark hole w/ dirt rim (filled rects)
  //   - queen              → gold strokeCircle around a filled body
  //   - pending entrance   → gold 2-px tile frame
  //   - rally point        → white crosshair: + bars across the tile, center dot
  // Enemy colonies' rally points are never drawn (leaks AI intent).
  if (playerColony && playerColony.rallyPoint !== null) {
    const rp = playerColony.rallyPoint;
    const sx = (rp.tileX - left) * TILE_SIZE_PX;
    const sy = (rp.tileY - top)  * TILE_SIZE_PX;
    if (sx > -TILE_SIZE_PX && sx < canvasW && sy > -TILE_SIZE_PX && sy < canvasH) {
      gfx.fillStyle(COLOR_RALLY_POINT, 1);
      // Horizontal bar across the tile (leave 1-px edges so adjacent tiles don't fuse)
      gfx.fillRect(sx + 1, sy + 7, TILE_SIZE_PX - 2, 2);
      // Vertical bar across the tile
      gfx.fillRect(sx + 7, sy + 1, 2, TILE_SIZE_PX - 2);
      // Center square accent — makes the crosshair pop against busy backgrounds
      gfx.fillRect(sx + 6, sy + 6, 4, 4);
    }
  }

  // --- Pending-entrance preview (Phase 8.5) ---
  // A 2-px gold frame drawn on the tile the player right-clicked. Reads from
  // the mutable SurfaceInputState exposed by registerSurfaceInput. Clears
  // automatically once the player left-clicks the same tileX to confirm.
  if (pendingEntrance !== null) {
    const sx = (pendingEntrance.tileX - left) * TILE_SIZE_PX;
    const sy = (pendingEntrance.tileY - top)  * TILE_SIZE_PX;
    if (sx > -TILE_SIZE_PX && sx < canvasW && sy > -TILE_SIZE_PX && sy < canvasH) {
      gfx.fillStyle(COLOR_QUEEN_OUTLINE, 0.7);
      gfx.fillRect(sx,                      sy,                      TILE_SIZE_PX, 2);            // top
      gfx.fillRect(sx,                      sy + TILE_SIZE_PX - 2,   TILE_SIZE_PX, 2);            // bottom
      gfx.fillRect(sx,                      sy,                      2,            TILE_SIZE_PX); // left
      gfx.fillRect(sx + TILE_SIZE_PX - 2,   sy,                      2,            TILE_SIZE_PX); // right
    }
  }
}

// ---------------------------------------------------------------------------
// drawSurface — orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrator: draw terrain then entities for the surface view.
 *
 * Note: pheromone overlay is drawn by GameScene between terrain and entities;
 * it is NOT called from here.
 *
 * `pendingEntrance` (Phase 8.5) is forwarded to drawSurfaceEntities so the
 * right-click preview frame renders on top of all other surface layers.
 */
export function drawSurface(
  gfx: GfxLike,
  sprites: AntSpriteLayer,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  cam: CameraState,
  pendingEntrance: { tileX: number; tileY: number } | null = null,
  facing?: AntFacingCache,
): void {
  drawSurfaceTerrain(gfx, curr, cam);
  drawSurfaceEntities(gfx, sprites, prev, curr, alpha, cam, pendingEntrance, facing);
}
