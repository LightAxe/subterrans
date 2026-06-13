// underground-input.ts — Stage 1 controls rework (issue #18): pure underground
// tap + paint handlers, called by the single left-button gesture arbiter.
//
// This file no longer registers its own Phaser pointer listeners. The arbiter
// (gesture-arbiter.ts) owns the LEFT button, classifies pan/paint/tap, and calls
// these pure functions; right-click (handled by the arbiter's secondary path)
// opens the chamber menu via the shared tryOpenChamberMenu.
//
// Tap handlers by tool (underground):
//   - Command tap → CancelDigMark on a Marked tile (player view only); otherwise
//     a no-op (no ant-inspect in Stage 1). (PLAN §B5, Codex R2-7.)
//   - Dig tap     → Solid/Open → MarkDigTile (single tile); Marked → CancelDigMark.
//                   Drag → paint (4-connected Bresenham). (PLAN §B6, Codex R1-2.)
//   - Chamber tap → tryOpenChamberMenu (Solid/Open eligibility). (PLAN §B8.)
//
// Player-grid-only invariant (PLAN §B10, Codex R3-2): EVERY underground command
// path — Dig mark/cancel, Command-tap cancel, Chamber-tool tap, and right-click —
// requires activeUndergroundColonyId === PLAYER_COLONY_ID. The enemy underground
// view (X-toggle) is read-only; an in-flight paint stroke is aborted on colony
// switch by the arbiter's cancelGesture.
//
// All commands emitted are the SAME SimCommands as before the rework, pushed via
// enqueueCommand (non-Sync cap guard, enforced paused OR running). A tap handler
// returns whether its command was refused at the cap; the paint handlers return
// a capHit flag the arbiter uses to defer the un-enqueued tiles (re-emitting on a
// later flush/move) and — only while paused — to surface the "paused queue full"
// hint. An unpaused cap hit is silent transient throttling that catches up next
// tick as the queue drains.
//
// UndergroundTileState enum (terrain.ts): Solid=0, Marked=1, BeingDug=2, Open=3

import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { ugGet, UndergroundTileState } from '../sim/terrain.js';
import type { MarkDigTileCommand, CancelDigMarkCommand } from '../sim/commands.js';
import { PLAYER_COLONY_ID, UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { requestShowContextMenu } from '../render/context-menu-state.js';
import { enqueueCommand } from './command-queue.js';

// ---------------------------------------------------------------------------
// PaintStrokeState — mutable per-stroke state owned by the arbiter
// ---------------------------------------------------------------------------

/**
 * Tracks an in-flight underground Dig paint stroke. Created and owned by the
 * gesture arbiter (one per scene); the pure paint functions below read/advance
 * it. `lastMarkedTileX/Y` is the debounce + Bresenham interpolation cursor;
 * -1 is the "no stroke in progress" sentinel.
 */
export interface PaintStrokeState {
  /** True while a paint stroke is active (from begin until cancel/end). */
  active: boolean;
  /** X of the last tile the stroke cursor visited (debounce + Bresenham start). */
  lastMarkedTileX: number;
  /** Y counterpart to lastMarkedTileX. */
  lastMarkedTileY: number;
}

/** Construct an idle PaintStrokeState. */
export function createPaintStrokeState(): PaintStrokeState {
  return { active: false, lastMarkedTileX: -1, lastMarkedTileY: -1 };
}

/** Reset a PaintStrokeState in-place: end any stroke and clear the cursor. */
export function resetPaintStrokeState(state: PaintStrokeState): void {
  state.active = false;
  state.lastMarkedTileX = -1;
  state.lastMarkedTileY = -1;
}

// ---------------------------------------------------------------------------
// isTunnelEnd — pure helper (retained for completeness / tests)
// ---------------------------------------------------------------------------

/**
 * Returns true if (tileX, tileY) in the given colony's underground grid is Open
 * AND at least one orthogonal 4-neighbor is Solid. Out-of-bounds neighbors are
 * skipped. Returns false if the grid does not exist.
 *
 * Stage-1 chamber eligibility is Solid/Open (this is no longer the gate), but the
 * helper is kept for callers/tests that reason about tunnel topology.
 */
export function isTunnelEnd(
  world: WorldState,
  tileX: number,
  tileY: number,
  colonyId: number,
): boolean {
  const grid = world.undergroundGrids[colonyId];
  if (!grid) return false;
  if (ugGet(grid, tileX, tileY) !== UndergroundTileState.Open) return false;
  const neighbors: Array<[number, number]> = [
    [tileX, tileY - 1],
    [tileX + 1, tileY],
    [tileX, tileY + 1],
    [tileX - 1, tileY],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
    if (ugGet(grid, nx, ny) === UndergroundTileState.Solid) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal guards
// ---------------------------------------------------------------------------

/**
 * True iff underground command paths are allowed: the underground view must be
 * showing the PLAYER's own grid. The enemy view (X-toggle) is read-only.
 */
function isPlayerUndergroundEditable(viewState: ViewState): boolean {
  return viewState.activeUndergroundColonyId === PLAYER_COLONY_ID;
}

/** True iff (tileX,tileY) is in-bounds and not the surface-boundary ceiling row. */
function isEditableUndergroundTile(
  grid: { width: number; height: number },
  tileX: number,
  tileY: number,
): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= grid.width || tileY >= grid.height) return false;
  // Issue #30: the renderer paints row 0 with the grass "surface boundary" cue;
  // a mark there gives no visual feedback, so it is excluded everywhere.
  if (tileY === UNDERGROUND_CEILING_ROW_Y) return false;
  return true;
}

// ---------------------------------------------------------------------------
// handleUndergroundCommandTap — Command tool tap
// ---------------------------------------------------------------------------

/**
 * Underground Command tap: cancel a queued dig mark (Codex R2-7). A tap on a
 * Marked tile → CancelDigMark; every other tile is a no-op in Stage 1.
 * Player-grid-only. Returns true iff the command was refused at the cap.
 */
export function handleUndergroundCommandTap(
  world: WorldState,
  viewState: ViewState,
  tileX: number,
  tileY: number,
  isPaused: boolean,
): boolean {
  if (!isPlayerUndergroundEditable(viewState)) return false;
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return false;
  if (!isEditableUndergroundTile(grid, tileX, tileY)) return false;
  if (ugGet(grid, tileX, tileY) !== UndergroundTileState.Marked) return false;
  const cmd: CancelDigMarkCommand = {
    type: 'CancelDigMark',
    colonyId: PLAYER_COLONY_ID,
    tileX,
    tileY,
    issuedAtTick: world.tick,
  };
  return !enqueueCommand(world, cmd, isPaused);
}

// ---------------------------------------------------------------------------
// handleUndergroundDigTap — Dig tool single-tile tap
// ---------------------------------------------------------------------------

/**
 * Underground Dig tap (Codex R1-2): Solid/Open → MarkDigTile; Marked →
 * CancelDigMark; BeingDug → no-op (already claimed). Player-grid-only. Returns
 * true iff a command was refused at the cap.
 */
export function handleUndergroundDigTap(
  world: WorldState,
  viewState: ViewState,
  tileX: number,
  tileY: number,
  isPaused: boolean,
): boolean {
  if (!isPlayerUndergroundEditable(viewState)) return false;
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return false;
  if (!isEditableUndergroundTile(grid, tileX, tileY)) return false;
  const tileState = ugGet(grid, tileX, tileY);
  if (tileState === UndergroundTileState.Marked) {
    const cmd: CancelDigMarkCommand = {
      type: 'CancelDigMark',
      colonyId: PLAYER_COLONY_ID,
      tileX,
      tileY,
      issuedAtTick: world.tick,
    };
    return !enqueueCommand(world, cmd, isPaused);
  }
  if (tileState === UndergroundTileState.Solid || tileState === UndergroundTileState.Open) {
    const cmd: MarkDigTileCommand = {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX,
      tileY,
      issuedAtTick: world.tick,
    };
    return !enqueueCommand(world, cmd, isPaused);
  }
  // BeingDug — no-op.
  return false;
}

// ---------------------------------------------------------------------------
// Paint stroke (underground Dig drag)
// ---------------------------------------------------------------------------

/**
 * Begin a paint stroke at the down-tile. Seeds the stroke cursor (so the first
 * drag segment interpolates from a real coordinate) and emits MarkDigTile for
 * the down-tile itself when it is Solid/Open. Marked/BeingDug down-tiles seed the
 * cursor without emitting (matching the prior eager-arm behavior). Player-grid-
 * only. Returns true iff a command was refused at the cap.
 *
 * Note: unlike continuePaintStroke, the cursor is ALWAYS armed at the down-tile
 * even on a cap refusal — begin marks a single tile, and the first
 * continuePaintStroke segment re-interpolates from the down-tile, so a refused
 * down-tile mark is recovered by the stroke's own subsequent segments (and a
 * stroke that never moves was a single-tile gesture whose one refused mark
 * re-emits on the per-frame flush).
 */
export function beginPaintStroke(
  state: PaintStrokeState,
  world: WorldState,
  viewState: ViewState,
  tileX: number,
  tileY: number,
  isPaused: boolean,
): boolean {
  if (!isPlayerUndergroundEditable(viewState)) {
    state.active = false;
    return false;
  }
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return false;
  if (!isEditableUndergroundTile(grid, tileX, tileY)) {
    // Reject: do not arm a stroke on an out-of-bounds / ceiling down-tile.
    state.active = false;
    return false;
  }
  // Arm the stroke cursor up front so a stroke that begins on a Marked/BeingDug
  // tile still marks subsequently-entered Solid tiles.
  state.active = true;
  state.lastMarkedTileX = tileX;
  state.lastMarkedTileY = tileY;
  const tileState = ugGet(grid, tileX, tileY);
  if (tileState !== UndergroundTileState.Solid && tileState !== UndergroundTileState.Open) {
    return false;
  }
  const cmd: MarkDigTileCommand = {
    type: 'MarkDigTile',
    colonyId: PLAYER_COLONY_ID,
    tileX,
    tileY,
    issuedAtTick: world.tick,
  };
  return !enqueueCommand(world, cmd, isPaused);
}

/**
 * Continue a paint stroke to (tileX, tileY): emit MarkDigTile for every tile
 * along a 4-connected (supercover) integer line from the stroke cursor to the
 * target. Any Bresenham step advancing both axes is split into a horizontal
 * bridge then a vertical step so successive emitted tiles stay Manhattan-
 * adjacent (4-connected underground movement requires it). The starting tile is
 * skipped (already emitted by begin/prior segment).
 *
 * Two distinct kinds of "didn't enqueue" are handled differently so a fast
 * stroke past the MAX_COMMANDS_PER_TICK cap never silently loses tiles:
 *   - NON-MARKABLE skip (out-of-bounds / ceiling / not Solid/Open): not a loss —
 *     there was no command to defer. The cursor ADVANCES past it and the stroke
 *     continues (matching the prior behaviour).
 *   - CAP REFUSAL (enqueueCommand returned false): the command was deferred, not
 *     emitted. The cursor is LEFT at the last successfully-handled tile (it is
 *     NOT advanced onto the refused tile), the loop STOPS, and `capHit` is set
 *     so the refused tile + the remainder re-emit on a later flush/move (the
 *     arbiter re-drives toward the stored target as the queue drains).
 *
 * Player-grid-only. Returns true iff a command in this segment was refused at the
 * cap (capHit). A non-markable skip never sets the return.
 */
export function continuePaintStroke(
  state: PaintStrokeState,
  world: WorldState,
  viewState: ViewState,
  tileX: number,
  tileY: number,
  isPaused: boolean,
): boolean {
  if (!state.active) return false;
  if (!isPlayerUndergroundEditable(viewState)) {
    state.active = false;
    return false;
  }
  // Debounce: same tile as last emission → no work.
  if (tileX === state.lastMarkedTileX && tileY === state.lastMarkedTileY) return false;
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return false;

  const x0 = state.lastMarkedTileX;
  const y0 = state.lastMarkedTileY;
  const x1 = tileX;
  const y1 = tileY;
  let capHit = false;

  // Sentinel start (no prior cursor): single-tile emission.
  if (x0 === -1 && y0 === -1) {
    if (x1 < 0 || y1 < 0 || x1 >= grid.width || y1 >= grid.height) return false;
    if (y1 === UNDERGROUND_CEILING_ROW_Y) {
      // Non-markable: advance the cursor past it (not a loss).
      state.lastMarkedTileX = x1;
      state.lastMarkedTileY = y1;
      return false;
    }
    const ts = ugGet(grid, x1, y1);
    if (ts === UndergroundTileState.Solid || ts === UndergroundTileState.Open) {
      const cmd: MarkDigTileCommand = {
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID,
        tileX: x1,
        tileY: y1,
        issuedAtTick: world.tick,
      };
      if (!enqueueCommand(world, cmd, isPaused)) {
        // Cap refusal: do NOT advance the cursor onto the refused tile, so the
        // next flush/move re-emits it. Leave lastMarkedTile at the sentinel.
        return true;
      }
    }
    // Enqueued OR non-markable: advance the cursor.
    state.lastMarkedTileX = x1;
    state.lastMarkedTileY = y1;
    return false;
  }

  const dx = x1 > x0 ? x1 - x0 : x0 - x1;
  const dy = y1 > y0 ? y1 - y0 : y0 - y1;
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;
  let finalX = x0;
  let finalY = y0;

  // Emit one tile. Returns false to signal a CAP REFUSAL (caller must stop and
  // NOT advance the cursor onto this tile); returns true otherwise (enqueued OR
  // a non-markable skip — both advance the cursor past the tile).
  const emitTile = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) {
      finalX = tx;
      finalY = ty;
      return true; // out-of-bounds: not a loss, advance past it
    }
    if (ty === UNDERGROUND_CEILING_ROW_Y) {
      finalX = tx;
      finalY = ty;
      return true; // ceiling: not a loss, advance past it
    }
    const ts = ugGet(grid, tx, ty);
    if (ts !== UndergroundTileState.Solid && ts !== UndergroundTileState.Open) {
      finalX = tx;
      finalY = ty;
      return true; // non-markable terrain: not a loss, advance past it
    }
    const cmd: MarkDigTileCommand = {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: tx,
      tileY: ty,
      issuedAtTick: world.tick,
    };
    if (!enqueueCommand(world, cmd, isPaused)) {
      // Cap refusal: leave finalX/Y at the prior (successfully-handled) tile so
      // this tile re-emits later. Signal the loop to stop.
      capHit = true;
      return false;
    }
    finalX = tx;
    finalY = ty;
    return true;
  };

  while (cx !== x1 || cy !== y1) {
    const e2 = err * 2;
    const advanceX = e2 > -dy;
    const advanceY = e2 < dx;
    if (advanceX && advanceY) {
      err -= dy;
      cx += sx;
      if (!emitTile(cx, cy)) break; // orthogonal bridge tile (cap refusal → stop)
      err += dx;
      cy += sy;
      if (!emitTile(cx, cy)) break; // diagonal destination (cap refusal → stop)
    } else if (advanceX) {
      err -= dy;
      cx += sx;
      if (!emitTile(cx, cy)) break;
    } else if (advanceY) {
      err += dx;
      cy += sy;
      if (!emitTile(cx, cy)) break;
    } else {
      break;
    }
  }
  state.lastMarkedTileX = finalX;
  state.lastMarkedTileY = finalY;
  return capHit;
}

// ---------------------------------------------------------------------------
// tryOpenChamberMenu — shared by the Chamber-tool tap AND right-click (PLAN §B8/§B9)
// ---------------------------------------------------------------------------

/**
 * Open the chamber-placement context menu anchored at (screenX, screenY) for the
 * world tile (tileX, tileY), iff that tile is eligible. Stage-1 eligibility is
 * Solid OR Open (Marked and BeingDug excluded; bare-dirt/Solid placement is
 * preserved). Player-grid-only — the enemy view never opens the menu.
 *
 * One guarded entry point used by BOTH the Chamber-tool tap and the right-click
 * path so the eligibility + anchor logic can't drift between them. The screen
 * coords are required by requestShowContextMenu (the menu anchors to the click).
 *
 * Returns true iff the menu was requested. No SimCommand is emitted here — the
 * PlaceChamber command is pushed by UIScene when the player picks an item (and
 * that push goes through enqueueCommand for the paused cap).
 */
export function tryOpenChamberMenu(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
  tileX: number,
  tileY: number,
): boolean {
  if (viewState.activeView !== 'underground') return false;
  if (!isPlayerUndergroundEditable(viewState)) return false;
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return false;
  if (!isEditableUndergroundTile(grid, tileX, tileY)) return false;
  const tileState = ugGet(grid, tileX, tileY);
  if (tileState !== UndergroundTileState.Solid && tileState !== UndergroundTileState.Open) {
    // Marked / BeingDug excluded (PLAN §B8).
    return false;
  }
  requestShowContextMenu(screenX, screenY, tileX, tileY);
  return true;
}
