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
} from './sprites.js';
import { drawBarrenEarthTile, COLOR_BARREN_EARTH_DAMP } from './terrain-atlas.js';
export type { AntSpriteLayer } from './ant-sprite-layer.js';
import type { CameraState } from './camera.js';

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
  const playerColony = curr.colonies[PLAYER_COLONY_ID];
  const playerPriorityPileId = playerColony ? playerColony.priorityFoodPileId : null;
  for (const pile of curr.foodPiles) {
    const sx = (pile.tileX - left) * TILE_SIZE_PX;
    const sy = (pile.tileY - top)  * TILE_SIZE_PX;
    // Trivial viewport cull
    if (sx < -TILE_SIZE_PX || sx > canvasW || sy < -TILE_SIZE_PX || sy > canvasH) continue;
    const isPlayerMarked = playerPriorityPileId !== null && pile.foodPileId === playerPriorityPileId;
    const color = isPlayerMarked ? COLOR_FOOD_PILE_MARKED : COLOR_FOOD_PILE_NORMAL;
    const cx = sx + TILE_SIZE_PX / 2;
    const cy = sy + TILE_SIZE_PX / 2;
    const r  = TILE_SIZE_PX / 2 - 2;
    gfx.fillStyle(color, 1);
    gfx.fillCircle(cx, cy, r);
    gfx.lineStyle(1, 0x000000, 0.6);
    gfx.strokeCircle(cx, cy, r);
  }

  // --- Entrance holes on surface ---
  // Phase 8.5 readability: render a 2-px dirt rim around the dark hole interior
  // so the entrance reads as a dug-out hole with a piled-dirt mound, not an
  // arbitrary black square.
  //
  // Issue #14 cue: enemy entrances also get a 1-px enemy-colony perimeter
  // overlaid on the dirt rim so the player reads them as "rally here to
  // invade" targets rather than just neutral terrain features. Player
  // entrances are unchanged — the existing brown-mound style still reads
  // as "my entrance."
  for (const colony of Object.values(curr.colonies)) {
    if (!colony.entrances) continue;
    const isEnemy = colony.colonyId !== PLAYER_COLONY_ID;
    for (const entrance of colony.entrances) {
      const sx = (entrance.surfaceTileX - left) * TILE_SIZE_PX;
      const sy = (entrance.surfaceTileY - top)  * TILE_SIZE_PX;
      if (sx < -TILE_SIZE_PX || sx > canvasW || sy < -TILE_SIZE_PX || sy > canvasH) continue;
      // Entrance backplate — dampened earth so the dark hole reads against
      // the lighter barren-earth surrounding.
      gfx.fillStyle(COLOR_BARREN_EARTH_DAMP, 1);
      gfx.fillRect(sx, sy, TILE_SIZE_PX, TILE_SIZE_PX);
      gfx.fillStyle(COLOR_SURFACE_ENTRANCE_HOLE, 1);
      gfx.fillRect(sx + 2, sy + 2, TILE_SIZE_PX - 4, TILE_SIZE_PX - 4);
      if (isEnemy) {
        // 1-px enemy-colony border. Four thin fillRects draw a perimeter
        // ring inside the tile's outermost pixel (no GfxLike.strokeRect
        // available; the four-rect pattern is the established alternative).
        gfx.fillStyle(COLOR_ENEMY_COLONY, 1);
        gfx.fillRect(sx,                  sy,                  TILE_SIZE_PX, 1); // top
        gfx.fillRect(sx,                  sy + TILE_SIZE_PX-1, TILE_SIZE_PX, 1); // bottom
        gfx.fillRect(sx,                  sy + 1,              1, TILE_SIZE_PX - 2); // left
        gfx.fillRect(sx + TILE_SIZE_PX-1, sy + 1,              1, TILE_SIZE_PX - 2); // right
      }
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

    sprites.drawAnt({
      kind: isQueen ? 'queen' : 'worker',
      x: screenX,
      y: screenY,
      tint: color,
      rotation,
    });
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
