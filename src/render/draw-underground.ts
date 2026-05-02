// draw-underground.ts — Phase 8 underground cross-section drawing module.
//
// Pure functions: take a GfxLike + AntSpriteLayer + WorldState snapshots,
// issue Graphics API calls and AntSpriteLayer.drawAnt calls. Renders the
// currently-viewed colony's underground grid (09.1 Chunk 2 replaced the
// Phase 8 "player only" contract from PRD §7b with a per-view contract,
// driven by the `activeUndergroundColonyId` parameter defaulting to
// PLAYER_COLONY_ID for backward compat).
//
// Non-ant primitives use ONLY Graphics: fillRect, fillCircle, strokeCircle,
// fillTriangle, lineStyle, fillStyle. Ants go through the AntSpriteLayer —
// GameScene plugs in a Phaser-backed sprite pool; tests plug in a recording
// mock. draw-underground.ts itself remains Phaser-free.
//
// Draw order: drawUnderground calls drawUndergroundTerrain then drawUndergroundEntities.
// Pheromone overlay is called externally by GameScene between terrain and entities.

export type { GfxLike } from './draw-surface.js';

import type { GfxLike } from './draw-surface.js';
import type { AntSpriteLayer } from './ant-sprite-layer.js';
import { computeAntRotation, type AntFacingCache } from './ant-facing-cache.js';
import { ugGet, UndergroundTileState } from '../sim/terrain.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import { PLAYER_COLONY_ID, FOOD_CHAMBER_CAPACITY } from '../sim/constants.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import {
  TILE_SIZE_PX,
  COLOR_MARKED_TILE_OVERLAY,
  COLOR_BEING_DUG_OVERLAY,
  COLOR_UNDERGROUND_CEILING_STRIP,
  COLOR_CHAMBER_QUEEN,
  COLOR_CHAMBER_NURSERY,
  COLOR_CHAMBER_FOOD_STORAGE,
  COLOR_CHAMBER_FOOD_STORAGE_FILL,
  COLOR_PLAYER_COLONY,
  COLOR_ENEMY_COLONY,
  COLOR_QUEEN_OUTLINE,
} from './sprites.js';
import {
  drawBarrenEarthSubstrate,
  drawOpenFloorTile,
} from './terrain-atlas.js';
import { drawAutotiledUndergroundTile, drawUndergroundRim } from './underground-autotile.js';
import { gatherUnderground3x3Neighbors, type Neighbors3x3 } from './underground-neighbors.js';
import type { CameraState } from './camera.js';

// ---------------------------------------------------------------------------
// Chamber color map
// ---------------------------------------------------------------------------

const CHAMBER_COLORS: Record<number, number> = {
  [ChamberType.Queen]:       COLOR_CHAMBER_QUEEN,
  [ChamberType.Nursery]:     COLOR_CHAMBER_NURSERY,
  [ChamberType.FoodStorage]: COLOR_CHAMBER_FOOD_STORAGE,
};

// ---------------------------------------------------------------------------
// projectFoodStorageFill — per-chamber fill readout
//
// Issue #15: ChamberRecord.foodStored is now the authoritative per-chamber
// stockpile (it grows when an ant deposits inside the chamber footprint, drains
// when the queen withdraws). Render reads it directly — there is nothing to
// "project" anymore, but the function name is preserved so callers don't
// need to know the model changed.
// ---------------------------------------------------------------------------

/**
 * Fill (0..FOOD_CHAMBER_CAPACITY) for the named FoodStorage chamber. Returns 0
 * if chamberId isn't a FoodStorage chamber in this colony.
 */
export function projectFoodStorageFill(colony: ColonyRecord, chamberId: number): number {
  for (const ch of colony.chambers) {
    if (ch.chamberType !== ChamberType.FoodStorage) continue;
    if (ch.chamberId !== chamberId) continue;
    const fill = ch.foodStored;
    if (fill <= 0) return 0;
    return fill < FOOD_CHAMBER_CAPACITY ? fill : FOOD_CHAMBER_CAPACITY;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// drawUndergroundTerrain
// ---------------------------------------------------------------------------

/**
 * Draw the underground terrain tiles for the currently-viewed colony's grid.
 *
 * Ceiling strip (ty=0): drawn with COLOR_UNDERGROUND_CEILING_STRIP everywhere,
 * except at entrance surfaceTileX positions where COLOR_UNDERGROUND_OPEN is used.
 *
 * Interior (ty≥1): Solid → solid color + texture; Open → open color + texture;
 * Marked → open + texture + overlay; BeingDug → open + texture + overlay
 * (PRD §7e, UNDR-09).
 *
 * Returns immediately if the viewed colony's underground grid is undefined
 * (safety for early game states — T-08-06 mitigate, and before createScenario
 * completes for the enemy grid).
 *
 * @param activeUndergroundColonyId - 09.1 Chunk 2. Which colony's underground
 *   grid to render (grid data + entrance positions). Defaults to
 *   PLAYER_COLONY_ID so existing test fixtures keep their behavior.
 */
export function drawUndergroundTerrain(
  gfx: GfxLike,
  world: WorldState,
  cam: CameraState,
  activeUndergroundColonyId: ColonyId = PLAYER_COLONY_ID,
): void {
  const grid = world.undergroundGrids[activeUndergroundColonyId];
  if (grid === undefined) return;

  const left   = Math.floor(cam.x - cam.viewportWidth  / 2);
  const top    = Math.floor(cam.y - cam.viewportHeight / 2);
  const right  = Math.min(left + cam.viewportWidth  + 1, grid.width);
  const bottom = Math.min(top  + cam.viewportHeight + 1, grid.height);

  // Collect entrance X positions for ceiling gap rendering — uses the viewed
  // colony's entrances so the player sees enemy entrances when inspecting the
  // enemy underground.
  const colony = world.colonies[activeUndergroundColonyId];
  const entranceXSet = new Set<number>();
  if (colony?.entrances) {
    for (const entrance of colony.entrances) {
      entranceXSet.add(entrance.surfaceTileX);
    }
  }

  // Reusable neighbor scratch — gatherUnderground3x3Neighbors mutates this
  // in place so the per-frame tile loop doesn't allocate a fresh
  // Neighbors3x3 per visible tile. Per codex P2 review: a 200-tile
  // viewport at 60fps was spawning ~12k short-lived objects/sec.
  const neighbors: Neighbors3x3 = {
    nw: 'wall', n: 'wall', ne: 'wall',
    w:  'wall', c: 'wall', e:  'wall',
    sw: 'wall', s: 'wall', se: 'wall',
  };

  for (let ty = Math.max(top, 0); ty < bottom; ty++) {
    for (let tx = Math.max(left, 0); tx < right; tx++) {
      const screenX = (tx - left) * TILE_SIZE_PX;
      const screenY = (ty - top)  * TILE_SIZE_PX;

      if (ty === 0) {
        // Ceiling strip: open gap at entrance columns, surface earth elsewhere.
        // The ceiling reads as the underside of the surface — same barren
        // earth substrate the player sees on the surface view (issue #40
        // reframe), so the two views feel like the same continuous world.
        if (entranceXSet.has(tx)) {
          // Open shaft top — render as Open floor + gold tint highlight.
          drawOpenFloorTile(gfx, screenX, screenY, tx, ty);
          // Phase 8.5 usability (PRD §7c.1): translucent gold tint marks
          // the "way in" so the entrance reads even on a near-full Solid
          // grid (first-visit state).
          gfx.fillStyle(COLOR_QUEEN_OUTLINE, 0.28);
          gfx.fillRect(screenX, screenY, TILE_SIZE_PX, TILE_SIZE_PX);
        } else {
          // Plain ceiling — surface-style barren-earth SUBSTRATE only
          // (codex P2 follow-up: drawBarrenEarthTile would intermittently
          // paint multi-tile boulders / bushes into the ceiling strip,
          // which is supposed to be a consistent texture row).
          drawBarrenEarthSubstrate(gfx, screenX, screenY, tx, ty);
          // Subtle ceiling-strip tint to differentiate from a real surface
          // tile. Half-transparent so the underlying texture still shows.
          gfx.fillStyle(COLOR_UNDERGROUND_CEILING_STRIP, 0.35);
          gfx.fillRect(screenX, screenY, TILE_SIZE_PX, TILE_SIZE_PX);
        }
      } else {
        // Issue #43 — quarter-tile autotiling. The classifier treats Solid
        // (and OOB / non-entrance ceiling) as wall, and Open / Marked /
        // BeingDug as open. The tile's substrate plus opposite-kind
        // chamfer/inner-corner masks together resolve stair-step diagonals
        // into smooth silhouettes across tile boundaries.
        gatherUnderground3x3Neighbors(grid, tx, ty, entranceXSet, neighbors);
        drawAutotiledUndergroundTile(gfx, screenX, screenY, tx, ty, neighbors.c, neighbors);
        // Rim pass — subtle 2-pixel darker band on the open side of each
        // wall boundary. The shape is correct without it but the corridor
        // reads as flat black; the rim is what gives it the "carved out
        // of packed earth" feel.
        drawUndergroundRim(gfx, screenX, screenY, tx, ty, neighbors.c, neighbors);

        // Marked / BeingDug tint overlay — applied AFTER autotile so the
        // tint reads through the dug silhouette. Ensures the player sees
        // what's queued / in progress without losing the smooth shape.
        const state = ugGet(grid, tx, ty);
        if (state === UndergroundTileState.Marked) {
          gfx.fillStyle(COLOR_MARKED_TILE_OVERLAY, 0.55);
          gfx.fillRect(screenX, screenY, TILE_SIZE_PX, TILE_SIZE_PX);
        } else if (state === UndergroundTileState.BeingDug) {
          gfx.fillStyle(COLOR_BEING_DUG_OVERLAY, 0.65);
          gfx.fillRect(screenX, screenY, TILE_SIZE_PX, TILE_SIZE_PX);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// drawUndergroundEntities
// ---------------------------------------------------------------------------

/**
 * Draw chambers, ants, queen, eggs, and larvae in the underground view.
 *
 * Renders the currently-viewed colony's chambers + brood + queen (09.1 Chunk 2
 * replaces the Phase 8 "player only" contract from PRD §7b with a per-view
 * contract). Ants are filtered by `ants.currentGridColonyId` rather than
 * `ants.colonyId` so player Fighters inside the enemy grid still render when
 * the player is inspecting the enemy underground (Research Risk D — depends
 * on Chunk 0's grid-of-occupancy byte).
 *
 * Ant posX = surface X coordinate; posY = depth (PRD §7e / Pitfall 6).
 * Moving entities (ants) are interpolated between prev and curr at alpha.
 *
 * @param activeUndergroundColonyId - 09.1 Chunk 2. Which colony's underground
 *   grid the player is viewing. Drives chamber / queen / brood rendering and
 *   the ant grid-occupancy filter. Defaults to PLAYER_COLONY_ID for backward
 *   compat with existing test fixtures.
 */
export function drawUndergroundEntities(
  gfx: GfxLike,
  sprites: AntSpriteLayer,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  cam: CameraState,
  activeUndergroundColonyId: ColonyId = PLAYER_COLONY_ID,
  facing?: AntFacingCache,
): void {
  const colony = curr.colonies[activeUndergroundColonyId];
  if (colony === undefined) return;

  const left = Math.floor(cam.x - cam.viewportWidth  / 2);
  const top  = Math.floor(cam.y - cam.viewportHeight / 2);

  const canvasW = cam.viewportWidth  * TILE_SIZE_PX;
  const canvasH = cam.viewportHeight * TILE_SIZE_PX;

  // --- Chambers ---
  // Phase 8.5 usability (PRD §7c.1): after drawing the chamber fill, queen
  // chambers get a 2-px gold outline so at least one landmark is visible on
  // the first underground Tab, even when the rest of the grid is all-Solid.
  for (const chamber of colony.chambers) {
    const dims = CHAMBER_DIMENSIONS[chamber.chamberType];
    if (dims === undefined) continue;
    const tileX = chamber.posX >> FP_SHIFT;
    const tileY = chamber.posY >> FP_SHIFT;
    const screenX = (tileX - left) * TILE_SIZE_PX;
    const screenY = (tileY - top)  * TILE_SIZE_PX;
    const color = CHAMBER_COLORS[chamber.chamberType] ?? COLOR_CHAMBER_QUEEN;
    const w = dims.width  * TILE_SIZE_PX;
    const h = dims.height * TILE_SIZE_PX;
    gfx.fillStyle(color, 1);
    gfx.fillRect(screenX, screenY, w, h);
    if (chamber.chamberType === ChamberType.Queen) {
      gfx.fillStyle(COLOR_QUEEN_OUTLINE, 0.7);
      gfx.fillRect(screenX,         screenY,         w, 2);     // top
      gfx.fillRect(screenX,         screenY + h - 2, w, 2);     // bottom
      gfx.fillRect(screenX,         screenY,         2, h);     // left
      gfx.fillRect(screenX + w - 2, screenY,         2, h);     // right
    }
    // FoodStorage fill visualization — per-tile amber food-cache sprites
    // stacked from the chamber floor upward. Issue #15: ChamberRecord.foodStored
    // IS the authoritative source — `projectFoodStorageFill` returns it directly,
    // not a lagging projection of colony.foodStored as before the chamber-
    // authoritative refactor. Deposits show the moment antDepositFood writes
    // the chamber, no reconcile lag.
    //
    // Each tile in the chamber footprint can hold one food-cache SVG; the
    // ratio `projected / FOOD_CHAMBER_CAPACITY` maps to the number of filled
    // tiles, bottom-row first. Tiles are sprite-layer draws (drawStatic)
    // rather than Graphics primitives — draw-underground.ts stays Phaser-free
    // and GameScene's AntSpritePool handles the actual image objects.
    if (chamber.chamberType === ChamberType.FoodStorage) {
      const projected = projectFoodStorageFill(colony, chamber.chamberId);
      if (projected > 0) {
        const totalTiles = dims.width * dims.height;
        const frac = Math.min(1, projected / FOOD_CHAMBER_CAPACITY);
        const filledTiles = Math.min(totalTiles, Math.max(1, Math.round(frac * totalTiles)));
        // Fill bottom-row first so the pile appears to stack upward. Walk
        // rows from the chamber floor (bottom) toward the ceiling; within
        // each row, walk left→right. Stop once `filledTiles` are placed.
        let placed = 0;
        for (let row = dims.height - 1; row >= 0 && placed < filledTiles; row--) {
          for (let col = 0; col < dims.width && placed < filledTiles; col++) {
            const cx = screenX + col * TILE_SIZE_PX + TILE_SIZE_PX / 2;
            const cy = screenY + row * TILE_SIZE_PX + TILE_SIZE_PX / 2;
            sprites.drawStatic({
              kind: 'food-cache',
              x: cx,
              y: cy,
              tint: COLOR_CHAMBER_FOOD_STORAGE_FILL,
            });
            placed++;
          }
        }
      }
    }
  }

  // --- Underground ants (zone === 1, filtered by grid-of-occupancy) ---
  //
  // 09.1 Chunk 2 (Research Risk D): filter by `ants.currentGridColonyId` not
  // `ants.colonyId`. The viewer should see every ant currently IN the viewed
  // grid regardless of which colony owns them — so player Fighters that
  // descended into the enemy nest (Chunk 3) render when we're looking at the
  // enemy underground, and enemy ants that somehow end up in the player's
  // grid would render too (symmetric). Per RESEARCH.md §draw-underground.ts
  // hardcoded sites and 09.1-00-SUMMARY (Chunk 0 descent-write invariant).
  //
  // Wrong-plane flicker guard (09 render polish): mirror draw-surface. When
  // prev.zone !== curr.zone (queen descending/ascending through an entrance)
  // or the slot wasn't alive in prev (freshly-spawned ant whose prev.posX/Y
  // is a stale default), interpolating prev→curr briefly renders the ant on
  // the wrong plane or at the origin. Snap to curr in those cases.
  //
  // Issue #22 — exclude brood entities from this loop. Eggs and larvae share
  // the same AntComponents entity IDs as workers/queens (single SoA store),
  // and after Gate 6 they live in zone=Underground with currentGridColonyId
  // set to their own colony. Without this skip, the loop draws each brood as
  // a worker-ant sprite at depth 50, hiding the egg/larva sprite that the
  // brood loop below paints at depth 48. The user-visible artifact is "eggs
  // appear to have ants drawn on them" — the actual root cause of issue #22
  // (the earlier egg-position-spread fix in lifecycle-system.ts addresses a
  // related visual concern but does not fix this one).
  //
  // We collect brood IDs across every colony as a defensive over-collection.
  // Today brood-never-invades (mirror of queens-never-invade), so only the
  // active colony's brood would actually appear in this grid; widening the
  // Set keeps this loop correct if a future Phase introduces cross-grid
  // brood movement and a corresponding draw-brood update walks all colonies.
  // Note the asymmetry with the per-active-colony `isQueen` check below: the
  // queen check stays single-colony because queens never cross grids and
  // entity IDs are world-globally unique (no collision risk).
  const broodIds = new Set<number>();
  for (const c of Object.values(curr.colonies)) {
    if (c === undefined) continue;
    for (let i = 0; i < c.eggs.length;   i++) broodIds.add(c.eggs[i]!);
    for (let i = 0; i < c.larvae.length; i++) broodIds.add(c.larvae[i]!);
  }
  const maxId = curr.ants.alive.length;
  for (let id = 0; id < maxId; id++) {
    if (!isAlive(curr.ants, id)) continue;
    if (curr.ants.zone[id] !== 1) continue; // underground only
    if (curr.ants.currentGridColonyId[id] !== activeUndergroundColonyId) continue; // grid-of-occupancy filter
    if (broodIds.has(id)) continue; // issue #22 — brood is rendered by drawBrood, not as worker sprites

    const useInterp = isAlive(prev.ants, id) && prev.ants.zone[id] === curr.ants.zone[id];

    // Interpolate: posX = surface X, posY = depth (Pitfall 6). Multiply BEFORE
    // dividing so sub-tile precision survives — truncating with `>> FP_SHIFT`
    // first would snap the ant to its tile's upper-left corner, and it would
    // appear pinned to the entrance/chamber origin instead of moving through it.
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

    // Facing: rotate the SVG (head on -x natively) toward the motion vector.
    // Smoothing is applied by the AntFacingCache when one is supplied — the
    // sim moves ants on a cardinal/4-connected grid, so a diagonal trajectory
    // zig-zags axis every tick. The cache low-pass-filters the per-frame
    // delta so the blended heading settles into the intended diagonal
    // instead of snapping between horizontal and vertical. Stationary ants
    // reuse the prior smoothed rotation; zone flips / spawn frames evict the
    // stale cache entry and fall back to the default pose (rotation=0). See
    // AntSpriteDrawOptions.rotation for the math and ant-facing-cache.ts for
    // the blending contract.
    const dx = currPxX - prevPxX;
    const dy = currPxY - prevPxY;
    const rotation = computeAntRotation(facing, id, curr.ants.zone[id]!, dx, dy, useInterp);

    // Queen identity: the only queen who legitimately occupies this grid is
    // the grid-owner's queen (queens never invade per 09.1 design). isQueen
    // by-id comparison against the VIEWED colony's queenEntityId is correct
    // regardless of which colony we're viewing. A player Fighter wearing the
    // enemy queen's id would be impossible — world-global nextEntityId.
    const isQueen = id === colony.queenEntityId;

    // Tint by OWNING colony (colonyId) not by grid-of-occupancy. A player
    // Fighter invading the enemy nest (Chunk 3) must still render in the
    // player colour so the player can follow their own ant into the enemy
    // grid visually. Symmetric for any enemy ant that ever occupies the
    // player grid. Uses colonyId, NOT currentGridColonyId (09.1 Chunk 0
    // distinction — grid-of-occupancy vs colony identity).
    const owningColonyId = curr.ants.colonyId[id];
    const tint = owningColonyId === PLAYER_COLONY_ID ? COLOR_PLAYER_COLONY : COLOR_ENEMY_COLONY;
    sprites.drawAnt({
      kind: isQueen ? 'queen' : 'worker',
      x: screenX,
      y: screenY,
      tint,
      rotation,
    });
  }

  // Eggs + larvae (nursery brood). Route through the sprite layer so both
  // stages use the repo-owned SVGs in code/public/assets/sprites/. Drawn
  // from the brood entity positions exactly — the sim's nurses have already
  // moved them into the nursery footprint, so rendering at the entity's
  // current tile is what places them inside the chamber visually.
  drawBrood(sprites, curr, colony.eggs, 'egg', left, top, canvasW, canvasH);
  drawBrood(sprites, curr, colony.larvae, 'larva', left, top, canvasW, canvasH);
}

/** Shared loop for rendering a list of brood entity IDs as static sprites. */
function drawBrood(
  sprites: AntSpriteLayer,
  curr: WorldState,
  entityIds: readonly number[],
  kind: 'egg' | 'larva',
  left: number,
  top: number,
  canvasW: number,
  canvasH: number,
): void {
  for (const id of entityIds) {
    if (!isAlive(curr.ants, id)) continue;
    const tileX = curr.ants.posX[id]! >> FP_SHIFT;
    const tileY = curr.ants.posY[id]! >> FP_SHIFT;
    const screenX = (tileX - left) * TILE_SIZE_PX;
    const screenY = (tileY - top)  * TILE_SIZE_PX;
    if (screenX < -TILE_SIZE_PX || screenX > canvasW || screenY < -TILE_SIZE_PX || screenY > canvasH) continue;
    sprites.drawStatic({
      kind,
      x: screenX + TILE_SIZE_PX / 2,
      y: screenY + TILE_SIZE_PX / 2,
    });
  }
}

// ---------------------------------------------------------------------------
// drawUnderground — orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrator: draw terrain then entities for the underground cross-section view.
 *
 * Note: pheromone overlay is drawn by GameScene between terrain and entities;
 * it is NOT called from here.
 *
 * @param activeUndergroundColonyId - 09.1 Chunk 2. Which colony's underground
 *   grid to render. Threaded through terrain + entities. Defaults to
 *   PLAYER_COLONY_ID for backward compat with existing test fixtures.
 */
export function drawUnderground(
  gfx: GfxLike,
  sprites: AntSpriteLayer,
  prev: WorldState,
  curr: WorldState,
  alpha: number,
  cam: CameraState,
  activeUndergroundColonyId: ColonyId = PLAYER_COLONY_ID,
  facing?: AntFacingCache,
): void {
  drawUndergroundTerrain(gfx, curr, cam, activeUndergroundColonyId);
  drawUndergroundEntities(gfx, sprites, prev, curr, alpha, cam, activeUndergroundColonyId, facing);
}
