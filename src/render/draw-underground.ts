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
import {
  WORKER_SPRITE_WIDTH,
  WORKER_SPRITE_HEIGHT,
  QUEEN_SPRITE_WIDTH,
  QUEEN_SPRITE_HEIGHT,
} from './ant-sprite-layer.js';
import { containSpritePlacement } from './sprite-containment.js';
import { computeAntRotation, type AntFacingCache } from './ant-facing-cache.js';
import { ugGet, UndergroundTileState, type UndergroundGrid } from '../sim/terrain.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import {
  PLAYER_COLONY_ID,
  FOOD_CHAMBER_CAPACITY,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
} from '../sim/constants.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { AntTask } from '../sim/enums.js';
import {
  TILE_SIZE_PX,
  COLOR_MARKED_TILE_OVERLAY,
  COLOR_BEING_DUG_OVERLAY,
  COLOR_UNDERGROUND_CEILING_STRIP,
  COLOR_UNDERGROUND_SOLID,
  COLOR_CHAMBER_QUEEN,
  COLOR_CHAMBER_NURSERY,
  COLOR_CHAMBER_FOOD_STORAGE,
  COLOR_CHAMBER_FOOD_STORAGE_FILL,
  COLOR_PLAYER_COLONY,
  COLOR_ENEMY_COLONY,
  COLOR_QUEEN_OUTLINE,
  COLOR_FIGHTER_TINT,
  COLOR_PLAYER_HOME_GLOW,
  COLOR_ENEMY_HOME_GLOW,
} from './sprites.js';
import { drawBarrenEarthSubstrate, drawOpenFloorTile } from './terrain-atlas.js';
import { drawAutotiledUndergroundTile, drawUndergroundRim } from './underground-autotile.js';
import { gatherUnderground3x3Neighbors, type Neighbors3x3 } from './underground-neighbors.js';
import { chamberSeed, chamberPerimeterPoints } from './chamber-shape.js';
import {
  type CameraView,
  visibleWorldRect,
  type WorldRect,
  ANT_DOT_SCREEN_PX,
} from './camera-adapter.js';
import { visibleTileRange } from './draw-surface.js';

// Guard: the glow key `((colonyId << 24) | (ty << 16) | tx)` (packed ~L565,
// decoded ~L587) packs tx in bits 0..7 and ty in bits 16..23 — one byte each,
// with the colony id in the top byte. The underground grid must stay within a
// byte per axis. Fails to compile if a dimension drifts. (entrance-flow.ts:36 pattern)
const _GLOW_UG_WIDTH_IS_128: 128 = UNDERGROUND_GRID_WIDTH;
const _GLOW_UG_HEIGHT_IS_64: 64 = UNDERGROUND_GRID_HEIGHT;
void _GLOW_UG_WIDTH_IS_128;
void _GLOW_UG_HEIGHT_IS_64;

// ---------------------------------------------------------------------------
// Chamber color map
// ---------------------------------------------------------------------------

const CHAMBER_COLORS: Record<number, number> = {
  [ChamberType.Queen]: COLOR_CHAMBER_QUEEN,
  [ChamberType.Nursery]: COLOR_CHAMBER_NURSERY,
  [ChamberType.FoodStorage]: COLOR_CHAMBER_FOOD_STORAGE,
};

// issue #18 Stage 3a — alpha of the faint committed-pending chamber silhouette (drawn while
// the chamber is dug-out but not yet promoted to colony.chambers). Low so it reads as
// "forming" against the solid built-chamber fill.
const PENDING_CHAMBER_OUTLINE_ALPHA = 0.25;

// ---------------------------------------------------------------------------
// drawOutlineSegment — draw a thick line segment between two arbitrary points
//
// GfxLike has fillRect, fillCircle, strokeCircle, fillTriangle — no
// `strokeLineSegment(a, b, w)` primitive. For non-axis-aligned segments
// (which the wavy chamber outline produces), we approximate a stroked line
// with a thin quadrilateral built from two fillTriangle calls. Caller sets
// fillStyle before calling; this function only emits geometry.
//
// Half-pixel-or-less segments are skipped (perpendicular vector would be
// ill-defined).
// ---------------------------------------------------------------------------

function drawOutlineSegment(
  gfx: GfxLike,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  thickness: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  // Perpendicular direction × half-thickness. (-dy, dx) is the 90° rotation.
  const halfT = thickness * 0.5;
  const px = (-dy / len) * halfT;
  const py = (dx / len) * halfT;
  // Quad as two triangles. Vertex order: a+, b+, a-, b-, a-.
  gfx.fillTriangle(ax + px, ay + py, bx + px, by + py, ax - px, ay - py);
  gfx.fillTriangle(bx + px, by + py, bx - px, by - py, ax - px, ay - py);
}

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
  cam: CameraView,
  activeUndergroundColonyId: ColonyId = PLAYER_COLONY_ID,
  // Stage 2 §B: when true, draw the WHOLE grid (off-screen RenderTexture bake) instead of
  // culling to the camera's visible window.
  bakeAll: boolean = false,
): void {
  const grid = world.undergroundGrids[activeUndergroundColonyId];
  if (grid === undefined) return;

  const { left, top, right, bottom } = bakeAll
    ? { left: 0, top: 0, right: grid.width, bottom: grid.height }
    : visibleTileRange(cam, grid.width, grid.height);

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
    nw: 'wall',
    n: 'wall',
    ne: 'wall',
    w: 'wall',
    c: 'wall',
    e: 'wall',
    sw: 'wall',
    s: 'wall',
    se: 'wall',
  };

  for (let ty = Math.max(top, 0); ty < bottom; ty++) {
    for (let tx = Math.max(left, 0); tx < right; tx++) {
      drawOneUndergroundTile(gfx, grid, entranceXSet, tx, ty, neighbors);
    }
  }
}

/**
 * Draw ONE underground terrain tile (ceiling row or autotiled interior + Marked/BeingDug
 * tints) at world px. Shared by the per-frame/full-bake loop and the incremental dirty
 * re-stamp (§B). `neighbors` is a reused scratch buffer so the caller can avoid
 * per-tile allocation.
 */
function drawOneUndergroundTile(
  gfx: GfxLike,
  grid: UndergroundGrid,
  entranceXSet: ReadonlySet<number>,
  tx: number,
  ty: number,
  neighbors: Neighbors3x3,
): void {
  const worldX = tx * TILE_SIZE_PX;
  const worldY = ty * TILE_SIZE_PX;

  if (ty === 0) {
    // Ceiling strip: open gap at entrance columns, surface earth elsewhere.
    if (entranceXSet.has(tx)) {
      // Open shaft top — render as Open floor + gold tint highlight.
      drawOpenFloorTile(gfx, worldX, worldY, tx, ty);
      gfx.fillStyle(COLOR_QUEEN_OUTLINE, 0.28);
      gfx.fillRect(worldX, worldY, TILE_SIZE_PX, TILE_SIZE_PX);
    } else {
      // Plain ceiling — surface-style barren-earth SUBSTRATE only.
      drawBarrenEarthSubstrate(gfx, worldX, worldY, tx, ty);
      gfx.fillStyle(COLOR_UNDERGROUND_CEILING_STRIP, 0.35);
      gfx.fillRect(worldX, worldY, TILE_SIZE_PX, TILE_SIZE_PX);
    }
  } else {
    // Issue #43 — quarter-tile autotiling resolves stair-step diagonals into smooth
    // silhouettes across tile boundaries.
    gatherUnderground3x3Neighbors(grid, tx, ty, entranceXSet, neighbors);
    drawAutotiledUndergroundTile(gfx, worldX, worldY, tx, ty, neighbors.c, neighbors);
    // Rim pass — subtle darker band on the open side of each wall boundary.
    drawUndergroundRim(gfx, worldX, worldY, tx, ty, neighbors.c, neighbors);

    // Marked / BeingDug tint overlay — AFTER autotile so the tint reads through the shape.
    const state = ugGet(grid, tx, ty);
    if (state === UndergroundTileState.Marked) {
      gfx.fillStyle(COLOR_MARKED_TILE_OVERLAY, 0.55);
      gfx.fillRect(worldX, worldY, TILE_SIZE_PX, TILE_SIZE_PX);
    } else if (state === UndergroundTileState.BeingDug) {
      gfx.fillStyle(COLOR_BEING_DUG_OVERLAY, 0.65);
      gfx.fillRect(worldX, worldY, TILE_SIZE_PX, TILE_SIZE_PX);
    }
  }
}

/**
 * Incrementally re-stamp specific dirty tiles into a bake target (§B10). Each tile is
 * first painted with an opaque Solid base so re-stamping fully OVERWRITES the prior RT
 * pixels (autotile chamfers don't cover every corner — without the opaque base, stale
 * pixels would bleed through on a state change). `dirtyKeys` are ty*width+tx indices
 * (from diffTerrainShadow). The caller draws the returned Graphics into the RenderTexture.
 */
export function restampUndergroundTiles(
  gfx: GfxLike,
  world: WorldState,
  colonyId: ColonyId,
  dirtyKeys: Iterable<number>,
): void {
  const grid = world.undergroundGrids[colonyId];
  if (grid === undefined) return;
  const colony = world.colonies[colonyId];
  const entranceXSet = new Set<number>();
  if (colony?.entrances) {
    for (const entrance of colony.entrances) entranceXSet.add(entrance.surfaceTileX);
  }
  const neighbors: Neighbors3x3 = {
    nw: 'wall',
    n: 'wall',
    ne: 'wall',
    w: 'wall',
    c: 'wall',
    e: 'wall',
    sw: 'wall',
    s: 'wall',
    se: 'wall',
  };
  for (const key of dirtyKeys) {
    const tx = key % grid.width;
    const ty = (key / grid.width) | 0;
    // Opaque base so the re-stamp cleanly overwrites the prior RT pixels.
    gfx.fillStyle(COLOR_UNDERGROUND_SOLID, 1);
    gfx.fillRect(tx * TILE_SIZE_PX, ty * TILE_SIZE_PX, TILE_SIZE_PX, TILE_SIZE_PX);
    drawOneUndergroundTile(gfx, grid, entranceXSet, tx, ty, neighbors);
  }
}

// ---------------------------------------------------------------------------
// tileInView — world-space cull (copied verbatim from draw-surface.ts, where it
// is a private helper and not exported). A tile-anchored primitive whose top-left
// is at world (worldX, worldY) is kept when it lies within the visible world rect
// expanded by `margin`. `margin` widens the box for primitives that spill past
// their tile.
// ---------------------------------------------------------------------------

function tileInView(worldX: number, worldY: number, rect: WorldRect, margin: number): boolean {
  return (
    worldX >= rect.left - margin &&
    worldX <= rect.right + margin &&
    worldY >= rect.top - margin &&
    worldY <= rect.bottom + margin
  );
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
  cam: CameraView,
  activeUndergroundColonyId: ColonyId = PLAYER_COLONY_ID,
  facing?: AntFacingCache,
  undergoundGlowFrames?: Map<number, number>,
  currentFrame: number = 0,
  // Stage 2 §C13: strategic LOD — ants render as screen-constant dots; the ant-derived
  // contested-glow + brood detail are skipped (allocation-free strategic frame).
  dotMode: boolean = false,
): void {
  const colony = curr.colonies[activeUndergroundColonyId];
  if (colony === undefined) return;
  // PR 6-render (#128 class-iii) — the grid for sprite-containment scale clamping.
  const ugGrid = curr.undergroundGrids[activeUndergroundColonyId];

  const rect = visibleWorldRect(cam);

  // --- Chambers ---
  // Phase 8.5 usability (PRD §7c.1): after drawing the chamber fill, queen
  // chambers get a gold outline so at least one landmark is visible on the
  // first underground Tab, even when the rest of the grid is all-Solid.
  //
  // Issue #97: chambers render with WAVY walls (32 perimeter points, each
  // displaced along its outward normal by a smooth deterministic per-chamber
  // wave) so the shape reads as hand-carved earth rather than tile-grid
  // rectangles. The simulation footprint is unchanged — collision, capacity,
  // BFS, and chamber-tile checks still use the rectangular CHAMBER_DIMENSIONS
  // bounding box. The wavy polygon is rendered as a triangle fan from the
  // chamber center; the queen-chamber gold outline traces the SAME wavy
  // perimeter via 2-px-thick line-segment quads (each segment is two
  // fillTriangle calls forming a thin parallelogram).
  //
  // Anchors of promoted chambers (issue #18) — so the pending-outline pass below can skip a
  // pending entry that has already promoted to a real chamber this frame (avoids drawing the
  // faint silhouette on top of the solid built fill at the same tile).
  const completedChamberAnchors = new Set<number>();
  for (const chamber of colony.chambers) {
    const dims = CHAMBER_DIMENSIONS[chamber.chamberType];
    if (dims === undefined) continue;
    const tileX = chamber.posX >> FP_SHIFT;
    const tileY = chamber.posY >> FP_SHIFT;
    completedChamberAnchors.add(tileX * 100000 + tileY);
    const worldX = tileX * TILE_SIZE_PX;
    const worldY = tileY * TILE_SIZE_PX;
    const color = CHAMBER_COLORS[chamber.chamberType] ?? COLOR_CHAMBER_QUEEN;
    const w = dims.width * TILE_SIZE_PX;
    const h = dims.height * TILE_SIZE_PX;
    const seed = chamberSeed(colony.colonyId, chamber.chamberId, chamber.chamberType);
    const points = chamberPerimeterPoints(seed, worldX, worldY, w, h);
    const cx = worldX + w / 2;
    const cy = worldY + h / 2;

    // Fill via fan triangulation from chamber center. The polygon is nearly
    // convex (small jitter on a rectangle), so any "bowtie" overdraw from
    // a non-convex dip is harmless — same fill color, additive draws are
    // pixel-identical.
    gfx.fillStyle(color, 1);
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i]!;
      const p2 = points[(i + 1) % points.length]!;
      gfx.fillTriangle(cx, cy, p1.x, p1.y, p2.x, p2.y);
    }

    if (chamber.chamberType === ChamberType.Queen) {
      // Gold outline tracing the wavy perimeter. Each segment between
      // adjacent perimeter points is rendered as a 2-px-thick quad via
      // two fillTriangle calls; a small fillCircle is drawn at each
      // vertex as a round-cap, hiding the small over/under-lap artifacts
      // that occur at the joints between non-axis-aligned segments
      // (perpendicular vectors don't align across direction changes, so
      // raw quad-only outlines show subtle dots at every joint under
      // alpha 0.7).
      //
      // We use line-segment quads rather than axis-aligned fillRects
      // because the wave produces non-axis-aligned segments — fillRect
      // would mis-render diagonals.
      gfx.fillStyle(COLOR_QUEEN_OUTLINE, 0.7);
      const halfThickness = 1; // half of the 2-px outline thickness
      for (let i = 0; i < points.length; i++) {
        const p1 = points[i]!;
        const p2 = points[(i + 1) % points.length]!;
        drawOutlineSegment(gfx, p1.x, p1.y, p2.x, p2.y, 2);
        gfx.fillCircle(p1.x, p1.y, halfThickness);
      }
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
            const cx = worldX + col * TILE_SIZE_PX + TILE_SIZE_PX / 2;
            const cy = worldY + row * TILE_SIZE_PX + TILE_SIZE_PX / 2;
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

  // --- Committed-PENDING chamber outline (issue #18 Stage 3a) ---
  // A chamber in world.pendingChambers is committed + dug-out underway but not yet promoted
  // to colony.chambers (colony-system deletes the pending entry on promotion). It otherwise
  // shows only as blue Marked footprint tiles until BUILT. Draw a faint wavy fill of the SAME
  // shape the queued ghost / built chamber use (chamberSeed id 0) so the silhouette is
  // continuous across aim → queued → pending → built. Active-colony only; world-space; cheap
  // (a triangle fan per pending chamber, view-culled). Defensive anchorKey guard skips any
  // pending entry that already coincides with a promoted chamber this frame (no double-draw).
  for (const key in curr.pendingChambers) {
    const pc = curr.pendingChambers[key]!;
    if (pc.colonyId !== activeUndergroundColonyId) continue;
    const anchorKey = pc.anchorTileX * 100000 + pc.anchorTileY;
    if (completedChamberAnchors.has(anchorKey)) continue;
    const pcWorldX = pc.anchorTileX * TILE_SIZE_PX;
    const pcWorldY = pc.anchorTileY * TILE_SIZE_PX;
    const pcW = pc.width * TILE_SIZE_PX;
    const pcH = pc.height * TILE_SIZE_PX;
    if (!tileInView(pcWorldX, pcWorldY, rect, Math.max(pcW, pcH))) continue;
    const seed = chamberSeed(pc.colonyId, 0, pc.chamberType);
    const pts = chamberPerimeterPoints(seed, pcWorldX, pcWorldY, pcW, pcH);
    const cx = pcWorldX + pcW / 2;
    const cy = pcWorldY + pcH / 2;
    gfx.fillStyle(
      CHAMBER_COLORS[pc.chamberType] ?? COLOR_CHAMBER_QUEEN,
      PENDING_CHAMBER_OUTLINE_ALPHA,
    );
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i]!;
      const p2 = pts[(i + 1) % pts.length]!;
      gfx.fillTriangle(cx, cy, p1.x, p1.y, p2.x, p2.y);
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
  // --- Underground home-ground combat tile glow (S6) ---
  // Per-grid color: blue for player grid, orange for enemy grid.
  // Fade-out over 5 frames once combat ants leave a tile. Skipped in strategic dot mode
  // (allocation-free pass — no per-entity Map/Set scan; §C13/R3-2).
  if (!dotMode) {
    const glowColor =
      activeUndergroundColonyId === PLAYER_COLONY_ID
        ? COLOR_PLAYER_HOME_GLOW
        : COLOR_ENEMY_HOME_GLOW;
    const BASE_ALPHA = 0.2;
    const GLOW_FADE_FRAMES = 5;

    // Collect tiles that have ants from 2+ colonies.
    const tileColony = new Map<number, number>(); // tileKey → first colonyId
    const contested = new Set<number>();
    const n = curr.ants.alive.length;
    for (let id = 0; id < n; id++) {
      if (!isAlive(curr.ants, id)) continue;
      if (curr.ants.zone[id] !== 1) continue;
      if (curr.ants.currentGridColonyId[id] !== activeUndergroundColonyId) continue;
      const tx = curr.ants.posX[id]! >> 8;
      const ty = curr.ants.posY[id]! >> 8;
      // Include activeUndergroundColonyId in the high byte so entries for
      // different colony views don't collide when the player switches grids.
      const key = (activeUndergroundColonyId << 24) | (ty << 16) | tx;
      const cid = curr.ants.colonyId[id]!;
      const existing = tileColony.get(key);
      if (existing === undefined) tileColony.set(key, cid);
      else if (existing !== cid) contested.add(key);
    }
    // Stamp active tiles with current frame.
    if (undergoundGlowFrames) {
      for (const key of contested) {
        undergoundGlowFrames.set(key, currentFrame);
      }
    }
    // Draw glows for all contested or recently-contested tiles.
    const drawKeys = undergoundGlowFrames
      ? Array.from(undergoundGlowFrames.entries())
          .filter(
            ([key, frame]) =>
              key >>> 24 === activeUndergroundColonyId && currentFrame - frame < GLOW_FADE_FRAMES,
          )
          .map(([key]) => key)
      : Array.from(contested);
    for (const key of drawKeys) {
      const tx = key & 0xff; // bits 0-7; tx max = 127
      const ty = (key >> 16) & 0xff; // bits 16-23; top byte (24+) holds colony ID
      const worldX = tx * TILE_SIZE_PX;
      const worldY = ty * TILE_SIZE_PX;
      if (!tileInView(worldX, worldY, rect, TILE_SIZE_PX)) continue;
      const framesAgo = undergoundGlowFrames
        ? currentFrame - (undergoundGlowFrames.get(key) ?? currentFrame)
        : 0;
      const alpha_g = BASE_ALPHA * (1 - framesAgo / GLOW_FADE_FRAMES);
      if (alpha_g <= 0) continue;
      // Soft edge.
      gfx.fillStyle(glowColor, alpha_g);
      gfx.fillRect(worldX + 2, worldY + 2, TILE_SIZE_PX - 4, TILE_SIZE_PX - 4);
      gfx.fillStyle(glowColor, alpha_g * 0.5);
      gfx.fillRect(worldX, worldY, TILE_SIZE_PX, 2);
      gfx.fillRect(worldX, worldY + TILE_SIZE_PX - 2, TILE_SIZE_PX, 2);
      gfx.fillRect(worldX, worldY + 2, 2, TILE_SIZE_PX - 4);
      gfx.fillRect(worldX + TILE_SIZE_PX - 2, worldY + 2, 2, TILE_SIZE_PX - 4);
    }
    // Prune stale entries.
    if (undergoundGlowFrames) {
      for (const [key, frame] of undergoundGlowFrames) {
        if (currentFrame - frame >= GLOW_FADE_FRAMES) undergoundGlowFrames.delete(key);
      }
    }
  }

  const broodIds = new Set<number>();
  for (const c of Object.values(curr.colonies)) {
    if (c === undefined) continue;
    for (let i = 0; i < c.eggs.length; i++) broodIds.add(c.eggs[i]!);
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

    // baseX/baseY are already world px (posX/posY → px), so they double as the
    // draw position; the main camera projects them to screen.
    const baseX = useInterp ? prevPxX + (currPxX - prevPxX) * alpha : currPxX;
    const baseY = useInterp ? prevPxY + (currPxY - prevPxY) * alpha : currPxY;

    // Trivial world-rect cull.
    if (!tileInView(baseX, baseY, rect, TILE_SIZE_PX)) continue;

    // Strategic LOD (§C13): a screen-constant colony-colored dot instead of the detailed
    // sprite — allocation-free (no facing/containment/sprite-pool work).
    if (dotMode) {
      const dotColor =
        curr.ants.colonyId[id]! === PLAYER_COLONY_ID ? COLOR_PLAYER_COLONY : COLOR_ENEMY_COLONY;
      const ds = ANT_DOT_SCREEN_PX / cam.zoom;
      gfx.fillStyle(dotColor, 1);
      gfx.fillRect(baseX - ds / 2, baseY - ds / 2, ds, ds);
      continue;
    }

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
    const isFighter2 = curr.ants.task[id] === AntTask.Fighting;
    // PR 6-render (#128 class-iii) — contain the sprite's rotated footprint so
    // it never paints over a Solid/off-grid neighbour. baseX/baseY are the
    // interpolated world-pixel center, which is what the containment math is in
    // terms of. Containment nudges POSITION before scale
    // (containSpritePlacement): the sim pins shaft/descent ants to exact
    // tile-edge coordinates, where a pure scale clamp against the Solid shaft
    // wall would collapse them to scale 0 (invisible). Workers at natural size
    // already fit a tile, so they adjust only when rotation enlarges their AABB
    // near dirt or they sit on a tile edge beside it.
    //
    // Continuity (issue #18): the containment input/output stays a continuous
    // float — the world px are NOT rounded — so the main camera's zoom
    // projection keeps the sub-tile precision PR6 introduced.
    const desiredScale = isFighter2 && !isQueen ? 1.25 : 1.0;
    const nativeW = isQueen ? QUEEN_SPRITE_WIDTH : WORKER_SPRITE_WIDTH;
    const nativeH = isQueen ? QUEEN_SPRITE_HEIGHT : WORKER_SPRITE_HEIGHT;
    let scale = desiredScale;
    let drawX = baseX;
    let drawY = baseY;
    if (ugGrid !== undefined) {
      const placed = containSpritePlacement(
        ugGrid,
        baseX,
        baseY,
        nativeW,
        nativeH,
        rotation,
        desiredScale,
      );
      scale = placed.scale;
      drawX = placed.cxPx;
      drawY = placed.cyPx;
    }
    sprites.drawAnt({
      kind: isQueen ? 'queen' : 'worker',
      x: drawX,
      y: drawY,
      tint: isFighter2 && !isQueen ? COLOR_FIGHTER_TINT : tint,
      rotation,
      scale,
    });
  }

  // Eggs + larvae (nursery brood). Route through the sprite layer so both
  // stages use the repo-owned SVGs in code/public/assets/sprites/. Drawn
  // from the brood entity positions exactly — the sim's nurses have already
  // moved them into the nursery footprint, so rendering at the entity's
  // current tile is what places them inside the chamber visually.
  // Brood detail is skipped in strategic dot mode (§C13).
  if (!dotMode) {
    drawBrood(sprites, curr, colony.eggs, 'egg', rect, activeUndergroundColonyId);
    drawBrood(sprites, curr, colony.larvae, 'larva', rect, activeUndergroundColonyId);
  }
}

/**
 * Issue #17 Phase 1.6 — visible carry render offset. When a brood entity
 * is being carried by an alive nurse (carriedBy !== -1 and the carrier is
 * alive), nudge the sprite up by ~1/4 tile so it sits "in arms" above the
 * carrier instead of perfectly stacked on the carrier's body. Under v10+
 * only — pre-v10 saves never set carriedBy to a non-(-1) value, so this
 * is a no-op for them by construction.
 */
const CARRY_RENDER_DY_PX = -Math.round(TILE_SIZE_PX / 4);

/** Shared loop for rendering a list of brood entity IDs as static sprites. */
function drawBrood(
  sprites: AntSpriteLayer,
  curr: WorldState,
  entityIds: readonly number[],
  kind: 'egg' | 'larva',
  rect: WorldRect,
  activeUndergroundColonyId: ColonyId,
): void {
  const ants = curr.ants;
  for (const id of entityIds) {
    if (!isAlive(ants, id)) continue;
    // Issue #84 — mirror the ant-loop grid filter at line 351. Today
    // brood-never-invades is a sim invariant (carry/lay/transition all stay
    // in-grid), but if a future change lets brood cross grids (carrier-led
    // evacuation, debug tools, etc.) the sprite would otherwise render at the
    // wrong screen offset using the active grid's camera. Fail safe.
    if (ants.currentGridColonyId[id] !== activeUndergroundColonyId) continue;
    const tileX = ants.posX[id]! >> FP_SHIFT;
    const tileY = ants.posY[id]! >> FP_SHIFT;
    const worldX = tileX * TILE_SIZE_PX;
    const worldY = tileY * TILE_SIZE_PX;
    if (!tileInView(worldX, worldY, rect, TILE_SIZE_PX)) continue;
    // Visible-carry offset: when this brood is on a carrier's tile and
    // the carrier is alive, lift it ~1/4 tile so it visually sits
    // above the carrier instead of being hidden under the ant sprite.
    const carrierId = ants.carriedBy[id]!;
    const carryDy = carrierId !== -1 && isAlive(ants, carrierId) ? CARRY_RENDER_DY_PX : 0;
    sprites.drawStatic({
      kind,
      x: worldX + TILE_SIZE_PX / 2,
      y: worldY + TILE_SIZE_PX / 2 + carryDy,
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
  cam: CameraView,
  activeUndergroundColonyId: ColonyId = PLAYER_COLONY_ID,
  facing?: AntFacingCache,
): void {
  drawUndergroundTerrain(gfx, curr, cam, activeUndergroundColonyId);
  drawUndergroundEntities(gfx, sprites, prev, curr, alpha, cam, activeUndergroundColonyId, facing);
}
