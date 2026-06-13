// surface-input.ts — Stage 1 controls rework (issue #18): pure surface tap
// handlers, called by the single left-button gesture arbiter.
//
// The arbiter (gesture-arbiter.ts) exclusively owns the LEFT pointer button. It
// classifies a press as a pan / paint / tap, and on a tap-without-drag calls the
// pure handler matching the snapshotted tool + view. This file no longer
// registers its own Phaser pointer listeners — it exports the pure tap logic and
// the pure helpers the arbiter and renderer depend on.
//
// Tap handlers by tool (surface):
//   - Command tap → priority: spider (sprite bounds) → food pile →
//     clear-rally (iff down-tile == current rally) → foreign/enemy entrance rally
//     → empty-tile set-rally. (PLAN §B5, Codex R1-4.)
//   - Dig tap → DesignateEntrance on a valid target (one tap; PLAN §B6).
//   - Chamber → underground-only, so there is no surface Chamber tap.
//
// All commands emitted here are the SAME SimCommands as before the rework and
// are pushed through enqueueCommand (the paused-cap guard); a handler reports
// whether its command was dropped at the cap so the arbiter can surface the
// "paused queue full" hint.
//
// Guards: the arbiter has already rejected HUD / pan / wrong-view presses before
// calling these. Each handler still bounds-checks the tile defensively.
// ADR-0006: world.colonies accessed via plain-object bracket notation — never .get().

import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import type { FoodPile } from '../sim/food.js';
import type {
  MarkFoodPileCommand,
  DesignateEntranceCommand,
  SetRallyPointCommand,
  ClearRallyPointCommand,
  MarkSpiderPriorityCommand,
} from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import {
  PLAYER_COLONY_ID,
  SURFACE_ROOT_CLEARANCE_RADIUS,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from '../sim/constants.js';
import { getSurfaceComponentMaskReadOnly } from '../sim/surface-features.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import { SPIDER_SPRITE_WIDTH, SPIDER_SPRITE_HEIGHT } from '../render/ant-sprite-layer.js';
import { enqueueCommand } from './command-queue.js';

// ---------------------------------------------------------------------------
// isEmptySurfaceTile — checks whether a tile is empty (not entrance, not food pile)
// ---------------------------------------------------------------------------

/**
 * Returns true when (tileX, tileY) is a valid surface tile that is:
 *   - within grid bounds
 *   - NOT occupied by any colony entrance (checked across all colonies via Object.keys)
 *   - NOT a food pile location
 *
 * ADR-0006: world.colonies is a PLAIN OBJECT. Uses Object.keys — never .keys()/.entries()/.get().
 * SURF-04: empty-tile fallthrough → SetRallyPointCommand.
 */
export function isEmptySurfaceTile(world: WorldState, tileX: number, tileY: number): boolean {
  // Bounds check
  if (tileX < 0 || tileY < 0) return false;
  if (tileX >= world.surface.width || tileY >= world.surface.height) return false;

  // Check not a food pile
  for (const pile of world.foodPiles) {
    if (pile.tileX === tileX && pile.tileY === tileY) return false;
  }

  // Check not a colony entrance — iterate colonies via Object.keys (ADR-0006)
  for (const key of Object.keys(world.colonies)) {
    const colony = world.colonies[Number(key)];
    if (colony === undefined) continue;
    for (const entrance of colony.entrances) {
      if (entrance.surfaceTileX === tileX && entrance.surfaceTileY === tileY) return false;
    }
  }

  return true;
}

/**
 * PR 4 — true iff `DesignateEntrance` would ACCEPT this tile, so the preview
 * never advertises a target the (now stricter) sim gate will silently drop.
 * Mirrors `tick.ts`'s gate: the tile is an empty surface tile AND it plus its
 * whole `SURFACE_ROOT_CLEARANCE_RADIUS` neighbourhood are in the single connected
 * walkable component of the frozen terrain (terrain can no longer be carved at
 * designation time). Bounds-clamped halo tiles are skipped, matching the gate.
 */
export function isValidEntranceTarget(world: WorldState, tileX: number, tileY: number): boolean {
  if (!isEmptySurfaceTile(world, tileX, tileY)) return false;
  // Read-only mask access: `isSurfaceTileInComponent` lazily writes the memoised
  // mask back to the world on a miss, and input code must never mutate sim state
  // (sim/render boundary) — fetch the mask once, without filling the cache.
  const mask = getSurfaceComponentMaskReadOnly(world);
  if (tileX < 0 || tileY < 0 || tileX >= SURFACE_GRID_WIDTH || tileY >= SURFACE_GRID_HEIGHT) {
    return false;
  }
  if (mask[tileY * SURFACE_GRID_WIDTH + tileX] !== 1) return false;
  for (let dy = -SURFACE_ROOT_CLEARANCE_RADIUS; dy <= SURFACE_ROOT_CLEARANCE_RADIUS; dy++) {
    for (let dx = -SURFACE_ROOT_CLEARANCE_RADIUS; dx <= SURFACE_ROOT_CLEARANCE_RADIUS; dx++) {
      const cx = tileX + dx;
      const cy = tileY + dy;
      // Bound with the grid CONSTANTS (not world.surface.*) so the preview gate
      // clamps identically to the sim gate + the mask indexing (which use the
      // constants). Identical in production; consistent for hand-built worlds.
      if (cx < 0 || cy < 0 || cx >= SURFACE_GRID_WIDTH || cy >= SURFACE_GRID_HEIGHT) continue;
      if (mask[cy * SURFACE_GRID_WIDTH + cx] !== 1) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// isForeignColonyEntrance — issue #14 invasion enabler
// ---------------------------------------------------------------------------

/**
 * Returns true when (tileX, tileY) is the surface tile of an entrance owned
 * by a colony OTHER than `ownColonyId`. Bounds and food-pile checks are not
 * required here — the Command-tap handler has already evaluated those.
 *
 * Issue #14: enables the player to tap an enemy entrance to rally Fighting ants
 * there. Closed enemy entrances are intentionally still eligible — the
 * rally-tile carve-out in updateFightAntTargets walks fighters onto the exact
 * tile, but the descent-intent gate requires `isOpen` before crossing into the
 * enemy grid, so a rally on a closed enemy entrance piles fighters at the door.
 *
 * ADR-0006: world.colonies is a PLAIN OBJECT. Uses Object.keys.
 */
export function isForeignColonyEntrance(
  world: WorldState,
  tileX: number,
  tileY: number,
  ownColonyId: ColonyId,
): boolean {
  if (tileX < 0 || tileY < 0) return false;
  if (tileX >= world.surface.width || tileY >= world.surface.height) return false;
  for (const key of Object.keys(world.colonies)) {
    const cid = Number(key);
    if (cid === ownColonyId) continue;
    const colony = world.colonies[cid];
    if (colony === undefined) continue;
    for (const entrance of colony.entrances) {
      if (entrance.surfaceTileX === tileX && entrance.surfaceTileY === tileY) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// findFoodPileAt — O(n) scan over world.foodPiles
// ---------------------------------------------------------------------------

/**
 * Returns the FoodPile at (tileX, tileY) or null if none.
 * Called by handleSurfaceCommandTap when no spider was hit.
 */
export function findFoodPileAt(world: WorldState, tileX: number, tileY: number): FoodPile | null {
  for (const pile of world.foodPiles) {
    if (pile.tileX === tileX && pile.tileY === tileY) return pile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// isSpiderHit — pure spider sprite-bounds hit test (snapshotted at pointer-down)
// ---------------------------------------------------------------------------

/**
 * Returns true if screen point (screenX, screenY) lands within the spider's
 * rendered sprite bounds. The hit box is the union of the current-tick and
 * previous-tick 48×48px bounding boxes, so the trailing visual edge (which lags
 * the sim position during interpolation) always registers. When prevWorld is
 * null (stationary or unavailable) the box is exactly the current sprite.
 *
 * Extracted unchanged from the former right-click spider-priority path so the
 * Command-tap snapshot can record "did this press start on the spider?" at
 * pointer-down. Returns false when there is no spider.
 */
export function isSpiderHit(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
  prevWorld: WorldState | null = null,
): boolean {
  if (world.spider === null) return false;
  const cam = viewState.surfaceCamera;
  const camLeft = Math.floor(cam.x - cam.viewportWidth / 2);
  const camTop = Math.floor(cam.y - cam.viewportHeight / 2);
  const currScrX = (world.spider.posX >> FP_SHIFT) * TILE_SIZE_PX - camLeft * TILE_SIZE_PX;
  const currScrY = (world.spider.posY >> FP_SHIFT) * TILE_SIZE_PX - camTop * TILE_SIZE_PX;
  const prevScrX =
    prevWorld?.spider != null
      ? (prevWorld.spider.posX >> FP_SHIFT) * TILE_SIZE_PX - camLeft * TILE_SIZE_PX
      : currScrX;
  const prevScrY =
    prevWorld?.spider != null
      ? (prevWorld.spider.posY >> FP_SHIFT) * TILE_SIZE_PX - camTop * TILE_SIZE_PX
      : currScrY;
  const halfW = SPIDER_SPRITE_WIDTH / 2;
  const halfH = SPIDER_SPRITE_HEIGHT / 2;
  return (
    screenX >= Math.min(currScrX, prevScrX) - halfW &&
    screenX < Math.max(currScrX, prevScrX) + halfW &&
    screenY >= Math.min(currScrY, prevScrY) - halfH &&
    screenY < Math.max(currScrY, prevScrY) + halfH
  );
}

// ---------------------------------------------------------------------------
// handleSetRallyPoint — inner helper (pure dispatch, extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Enqueues SetRallyPointCommand for the given colony at (tileX, tileY).
 * colonyId argument is always the player colony — AI colonies are never passed here.
 * Returns true iff the command was dropped at the paused cap.
 */
export function handleSetRallyPoint(
  world: WorldState,
  tileX: number,
  tileY: number,
  playerColonyId: ColonyId,
  isPaused: boolean,
): boolean {
  const cmd: SetRallyPointCommand = {
    type: 'SetRallyPoint',
    colonyId: playerColonyId,
    tileX,
    tileY,
    issuedAtTick: world.tick,
  };
  return !enqueueCommand(world, cmd, isPaused);
}

// ---------------------------------------------------------------------------
// handleSurfaceCommandTap — the Command-tool tap on the surface view
// ---------------------------------------------------------------------------

/**
 * Surface Command tap. Priority (PLAN §B5, Codex R1-4):
 *   1. spider hit (snapshotted at pointer-down) → toggle MarkSpiderPriority
 *   2. food pile at the down-tile → MarkFoodPile
 *   3. clear-rally — ONLY if the down-tile is the current rally point → ClearRallyPoint
 *   4. foreign/enemy entrance at the down-tile → SetRallyPoint (invasion rally)
 *   5. empty tile → SetRallyPoint
 *
 * `spiderHit` is passed in (snapshotted at down by the arbiter) rather than
 * recomputed, so a camera pan between down and up can't move the spider out from
 * under the press. Returns true iff a command was dropped at the paused cap.
 */
export function handleSurfaceCommandTap(
  world: WorldState,
  tileX: number,
  tileY: number,
  spiderHit: boolean,
  isPaused: boolean,
  playerColonyId: ColonyId = PLAYER_COLONY_ID,
): boolean {
  if (tileX < 0 || tileY < 0) return false;

  // 1. Spider priority toggle (was right-click pre-rework; now a Command tap).
  if (spiderHit && world.spider !== null) {
    const cmd: MarkSpiderPriorityCommand = {
      type: 'MarkSpiderPriority',
      colonyId: playerColonyId,
      isPriority: world.spiderPriorityColonyId !== playerColonyId,
      issuedAtTick: world.tick,
    };
    return !enqueueCommand(world, cmd, isPaused);
  }

  // 2. Food-pile mark.
  const pile = findFoodPileAt(world, tileX, tileY);
  if (pile) {
    const cmd: MarkFoodPileCommand = {
      type: 'MarkFoodPile',
      colonyId: playerColonyId,
      tileX: pile.tileX,
      tileY: pile.tileY,
      issuedAtTick: world.tick,
    };
    return !enqueueCommand(world, cmd, isPaused);
  }

  // 3. Clear-rally — only when the tapped tile IS the current rally point. This
  //    precedes foreign-entrance so a rally placed ON an enemy entrance can be
  //    cleared by tapping it again (Codex R1-4: enemy-entrance rallies were
  //    otherwise unclearable).
  const playerColony = world.colonies[playerColonyId]; // plain-object bracket access (ADR-0006)
  if (
    playerColony !== undefined &&
    playerColony.rallyPoint !== null &&
    playerColony.rallyPoint.tileX === tileX &&
    playerColony.rallyPoint.tileY === tileY
  ) {
    const cmd: ClearRallyPointCommand = {
      type: 'ClearRallyPoint',
      colonyId: playerColonyId,
      issuedAtTick: world.tick,
    };
    return !enqueueCommand(world, cmd, isPaused);
  }

  // 4. Foreign/enemy entrance rally (issue #14): tap an enemy entrance tile to
  //    rally Fighting ants there. Own-colony entrances fall through (no-op).
  if (isForeignColonyEntrance(world, tileX, tileY, playerColonyId)) {
    return handleSetRallyPoint(world, tileX, tileY, playerColonyId, isPaused);
  }

  // 5. Empty-tile set-rally (SURF-04).
  if (isEmptySurfaceTile(world, tileX, tileY)) {
    return handleSetRallyPoint(world, tileX, tileY, playerColonyId, isPaused);
  }
  return false;
}

// ---------------------------------------------------------------------------
// handleSurfaceDigTap — the Dig-tool tap on the surface view
// ---------------------------------------------------------------------------

/**
 * Surface Dig tap → DesignateEntrance on a valid target (PLAN §B6). One tap,
 * irreversible in Stage 1 (entrance undo is a deferred sim-touch). A tap on an
 * invalid target is a no-op (the hover outline already shows red there). Returns
 * true iff the command was dropped at the paused cap.
 */
export function handleSurfaceDigTap(
  world: WorldState,
  tileX: number,
  tileY: number,
  isPaused: boolean,
  playerColonyId: ColonyId = PLAYER_COLONY_ID,
): boolean {
  if (tileX < 0 || tileY < 0) return false;
  if (!isValidEntranceTarget(world, tileX, tileY)) return false;
  const cmd: DesignateEntranceCommand = {
    type: 'DesignateEntrance',
    colonyId: playerColonyId,
    surfaceTileX: tileX,
    surfaceTileY: tileY,
    issuedAtTick: world.tick,
  };
  return !enqueueCommand(world, cmd, isPaused);
}
