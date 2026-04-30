// underground-input.ts — Phase 8 underground-click dispatcher.
//
// Handles:
//   - Left-click / drag: MarkDigTileCommand on Solid or Open tiles (debounced per tile).
//   - Right-click on Marked tile: CancelDigMarkCommand (CTRL-04: BeingDug is NOT cancellable).
//   - Right-click on Open tunnel-end: contextMenuState mutation (UNDR-04).
//   - Right-click on other tiles: no-op.
//
// Guards:
//   - viewState.activeView must be 'underground' before dispatching any command.
//   - isPointerOverHUD rejects clicks that land on HUD zones (Pitfall 2).
//   - Tile bounds check before accessing grid or pushing commands.
//   - When contextMenuState.visible is true, left-click is suppressed (no dig-mark).
//     Dismissal is owned by UIScene (requestHideContextMenu → applied next frame),
//     which prevents a scene-order race with chamber-placement selection.
//
// UndergroundTileState enum (terrain.ts):
//   Solid=0, Marked=1, BeingDug=2, Open=3

import * as Phaser from 'phaser';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { screenToTile } from '../render/camera.js';
import { ugGet, UndergroundTileState } from '../sim/terrain.js';
import type { MarkDigTileCommand, CancelDigMarkCommand } from '../sim/commands.js';
import { PLAYER_COLONY_ID, UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { isPointerOverHUD, panInputState } from './camera-input.js';
import { contextMenuState, requestShowContextMenu } from '../render/context-menu-state.js';

// ---------------------------------------------------------------------------
// UndergroundInputState — mutable per-registration state
// ---------------------------------------------------------------------------

/**
 * Exported so GameScene can hold the reference returned by
 * registerUndergroundInput and call resetUndergroundInputState at session
 * restart boundaries. Direct external callers (tests) also use the shape to
 * assert reset semantics.
 */
export interface UndergroundInputState {
  /** True from the first pointerdown until pointerup — enables drag tile-mark. */
  isDragging: boolean;
  /**
   * X coord of the last tile the drag cursor has visited (debounce + Bresenham
   * interpolation start). Seeded by the pointerdown click — including clicks
   * on Marked/BeingDug tiles where no MarkDigTileCommand was emitted — so the
   * subsequent drag interpolates from the actual click point, not from the
   * last *emitted* mark. -1 sentinel means no drag in progress.
   */
  lastMarkedTileX: number;
  /** Y coord counterpart to lastMarkedTileX. Same semantics — see above. */
  lastMarkedTileY: number;
}

/**
 * Reset an UndergroundInputState in-place: ends any in-flight drag and
 * clears the last-marked debounce. Preserves the object identity captured
 * by registerUndergroundInput's pointerdown / pointermove closures.
 */
export function resetUndergroundInputState(state: UndergroundInputState): void {
  state.isDragging = false;
  state.lastMarkedTileX = -1;
  state.lastMarkedTileY = -1;
}

// ---------------------------------------------------------------------------
// isTunnelEnd
// ---------------------------------------------------------------------------

/**
 * Returns true if (tileX, tileY) in the given colony's underground grid is:
 *   (a) Open (UndergroundTileState.Open === 3), AND
 *   (b) at least one orthogonal 4-neighbor is Solid (UndergroundTileState.Solid === 0).
 *
 * Used by handleUndergroundRightClick to decide whether to open the chamber
 * context menu (UNDR-04 / PRD §8b).
 *
 * Out-of-bounds neighbors are skipped (not counted as Solid) — this preserves
 * correctness for tiles on the grid boundary, but a boundary-adjacent Open tile
 * with valid Solid neighbors still returns true.
 *
 * Returns false if the undergroundGrid for colonyId does not exist.
 */
export function isTunnelEnd(world: WorldState, tileX: number, tileY: number, colonyId: number): boolean {
  const grid = world.undergroundGrids[colonyId];
  if (!grid) return false;
  if (ugGet(grid, tileX, tileY) !== UndergroundTileState.Open) return false;
  const neighbors: Array<[number, number]> = [
    [tileX, tileY - 1],  // N
    [tileX + 1, tileY],  // E
    [tileX, tileY + 1],  // S
    [tileX - 1, tileY],  // W
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
    if (ugGet(grid, nx, ny) === UndergroundTileState.Solid) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// handleUndergroundLeftClick
// ---------------------------------------------------------------------------

/**
 * Handles a left-click (or drag initiation) on the underground view.
 *
 * If context menu is open, suppresses the world click entirely — no dig mark,
 * no state mutation. UIScene owns menu dismissal so the dismissal happens on
 * a deterministic frame boundary, not mid-pointerdown dispatch.
 *
 * Otherwise, arms the drag state (isDragging + lastMarkedTile) on every
 * pointerdown that lands on a valid in-bounds tile, regardless of whether the
 * tile is markable. This is intentional: a click-then-drag stroke that starts
 * on an already-Marked or BeingDug tile must still mark newly-entered Solid
 * tiles. Without the eager arm, the subsequent pointermove would observe
 * isDragging=false and silently no-op for the rest of the gesture.
 *
 * Pushes MarkDigTileCommand only when the clicked tile is Solid or Open;
 * Marked/BeingDug tiles are already claimed so emitting a command would just
 * clutter the queue and replay log (the sim's MarkDigTile handler also drops
 * non-Solid tiles, so a duplicate would be a no-op there too).
 *
 * No-ops entirely if: activeView !== 'underground', pointer over HUD, pan
 * mode active, context menu visible, missing grid, or out of bounds. In all
 * those cases the drag state is NOT armed — the gesture was rejected, not
 * accepted-and-skipped.
 */
export function handleUndergroundLeftClick(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
  state: UndergroundInputState,
): void {
  if (viewState.activeView !== 'underground') return;
  // Issue #14: when the player flips to view the enemy underground (X
  // keybind), all underground commands target the PLAYER's grid (every
  // dispatch below uses PLAYER_COLONY_ID as the colonyId). A click on the
  // enemy view at screen coords (sx, sy) would silently mark a dig tile in
  // the player's grid at the same world coords — the player can't see it,
  // and replay would diverge from the visual state on screen. Treat the
  // enemy view as read-only.
  //
  // Defensive: clear any lingering `isDragging` flag from a prior gesture
  // that didn't get a clean mouseup (e.g., focus-loss). Without the
  // explicit reset, a stale `isDragging=true` paired with a stale
  // lastMarkedTile from the player view could resume scribbling dig
  // marks if the player flips back via X. Symmetric with the abort path
  // in handleUndergroundDrag.
  if (viewState.activeUndergroundColonyId !== PLAYER_COLONY_ID) {
    state.isDragging = false;
    return;
  }
  if (isPointerOverHUD(screenX, screenY, viewState)) return;
  // Pan-mode guard: while Space is held or a pan gesture is already in flight,
  // the left-click/drag is the pan trigger — not a dig-mark.
  if (panInputState.spaceHeld || panInputState.isPanning) return;
  // If context menu is visible, suppress this click — UIScene handles the
  // interaction (selection or dismissal) on its own pointerdown and applies
  // the hide on the next frame. No state mutation here: modifying visibility
  // mid-dispatch races with UIScene's handler on the same event.
  if (contextMenuState.visible) return;
  const { tileX, tileY } = screenToTile(screenX, screenY, viewState.undergroundCamera);
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return;
  if (tileX < 0 || tileY < 0 || tileX >= grid.width || tileY >= grid.height) return;
  // Issue #30: skip the ceiling-strip row. The renderer paints `tileY === 0`
  // with the grass texture as a "this is the surface boundary" cue (see
  // `ty === 0` branch in draw-underground.ts:137-153). Without this gate a
  // click on the visible grass silently dispatches MarkDigTile against the
  // tile beneath, which the renderer keeps painting as grass — the player
  // gets no visual feedback the click did anything.
  //
  // Codex P2 follow-up: also clear any stale drag state on this guard
  // path. If a prior gesture left `isDragging=true` (focus-loss / missed
  // pointerup), simply returning here without the reset would let the
  // next pointermove resume the stale stroke from the old cursor — the
  // exact "hidden marking" behavior this fix is supposed to eliminate.
  // Symmetric with the enemy-view guard's defensive reset.
  if (tileY === UNDERGROUND_CEILING_ROW_Y) {
    state.isDragging = false;
    return;
  }
  // Arm drag state up front (before the tile-state branch) so a stroke that
  // begins on a Marked/BeingDug tile still marks subsequent Solid tiles. The
  // debounce cursor is seeded to the clicked tile so the first Bresenham
  // interpolation in handleUndergroundDrag starts from a real coordinate.
  state.isDragging = true;
  state.lastMarkedTileX = tileX;
  state.lastMarkedTileY = tileY;
  // Only mark Solid or Open tiles (Marked/BeingDug are already claimed).
  const tileState = ugGet(grid, tileX, tileY);
  if (tileState !== UndergroundTileState.Solid && tileState !== UndergroundTileState.Open) return;
  const cmd: MarkDigTileCommand = {
    type: 'MarkDigTile',
    colonyId: PLAYER_COLONY_ID,
    tileX,
    tileY,
    issuedAtTick: world.tick,
  };
  world.commandQueue.push(cmd);
}

// ---------------------------------------------------------------------------
// handleUndergroundDrag
// ---------------------------------------------------------------------------

/**
 * Handles pointer-move-while-down (drag) on the underground view.
 *
 * Emits MarkDigTileCommand for every tile along a 4-connected (supercover)
 * integer line from (lastMarkedTileX, lastMarkedTileY) to the current tile.
 * Any Bresenham step that would advance both axes at once is split into two
 * emissions — a horizontal bridge tile followed by the vertical step — so
 * successive emitted tiles are always Manhattan-adjacent (|Δx|+|Δy| === 1).
 * Underground movement and dig-task connectivity are 4-connected, so an
 * 8-connected (corner-touching) path would leave broken tunnels. The
 * starting tile is skipped (the prior click/drag emission already marked it).
 *
 * Non-markable path tiles (already Marked or BeingDug, out of bounds) are
 * skipped silently; the stroke continues past them. After processing,
 * lastMarkedTileX/Y tracks the final tile of the stroke so subsequent drags
 * interpolate from there.
 *
 * Flips isDragging to false and returns if the active view has changed
 * since drag started (prevents ghost tile marks on view-toggle mid-drag).
 */
export function handleUndergroundDrag(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
  state: UndergroundInputState,
): void {
  if (!state.isDragging) return;
  if (viewState.activeView !== 'underground') { state.isDragging = false; return; }
  // Issue #14: same read-only guard as handleUndergroundLeftClick. If the
  // player flipped to the enemy view mid-drag (X keybind), abort the stroke
  // so it can't write through to the player's grid silently.
  if (viewState.activeUndergroundColonyId !== PLAYER_COLONY_ID) {
    state.isDragging = false;
    return;
  }
  if (isPointerOverHUD(screenX, screenY, viewState)) return;
  // Pan-mode guard: if the player pressed Space mid-drag, treat it as a
  // clean cancel of the excavation drag so further pointer movement goes
  // through the pan handler exclusively.
  if (panInputState.spaceHeld || panInputState.isPanning) { state.isDragging = false; return; }
  const { tileX, tileY } = screenToTile(screenX, screenY, viewState.undergroundCamera);
  // Debounce: same tile as last emission → no work.
  if (tileX === state.lastMarkedTileX && tileY === state.lastMarkedTileY) return;
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return;

  // Bresenham integer line from (lastMarkedTileX/Y) to (tileX, tileY).
  // Skip the starting tile (already handled by the prior click/drag emission).
  // If lastMarked is the sentinel (-1,-1), fall back to single-tile emission.
  const x0 = state.lastMarkedTileX;
  const y0 = state.lastMarkedTileY;
  const x1 = tileX;
  const y1 = tileY;

  let finalX = x0;
  let finalY = y0;

  if (x0 === -1 && y0 === -1) {
    if (x1 < 0 || y1 < 0 || x1 >= grid.width || y1 >= grid.height) return;
    if (y1 === UNDERGROUND_CEILING_ROW_Y) {
      // Issue #30: drag-into-ceiling-strip silently rebases the cursor without
      // emitting a mark. The stroke can continue from here onto regular rows.
      state.lastMarkedTileX = x1;
      state.lastMarkedTileY = y1;
      return;
    }
    const tileStateSingle = ugGet(grid, x1, y1);
    if (tileStateSingle === UndergroundTileState.Solid || tileStateSingle === UndergroundTileState.Open) {
      const cmd: MarkDigTileCommand = {
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID,
        tileX: x1,
        tileY: y1,
        issuedAtTick: world.tick,
      };
      world.commandQueue.push(cmd);
    }
    state.lastMarkedTileX = x1;
    state.lastMarkedTileY = y1;
    return;
  }

  const dx = x1 > x0 ? x1 - x0 : x0 - x1;
  const dy = y1 > y0 ? y1 - y0 : y0 - y1;
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;

  // Emit one tile — advances finalX/Y (always, even for out-of-bounds or
  // non-markable tiles — matches the stroke-cursor semantics the drag tests
  // exercise). Pushes a MarkDigTileCommand only when the tile is Solid/Open
  // and in bounds; returns silently otherwise so the stroke continues.
  const emitTile = (tx: number, ty: number): void => {
    finalX = tx;
    finalY = ty;
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return;
    // Issue #30: skip the ceiling-strip row inside the stroke — same gate as
    // handleUndergroundLeftClick. The stroke cursor still advances (finalX/Y
    // already updated above) so a drag that starts on a regular row, crosses
    // the ceiling, and continues on the other side keeps interpolating; only
    // the row-0 tiles themselves are skipped.
    if (ty === UNDERGROUND_CEILING_ROW_Y) return;
    const ts = ugGet(grid, tx, ty);
    if (ts !== UndergroundTileState.Solid && ts !== UndergroundTileState.Open) return;
    const cmd: MarkDigTileCommand = {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: tx,
      tileY: ty,
      issuedAtTick: world.tick,
    };
    world.commandQueue.push(cmd);
  };

  // Supercover / 4-connected Bresenham. Each iteration inspects the classic
  // Bresenham "advance X" and "advance Y" flags. When BOTH fire on the same
  // step we deterministically insert an orthogonal bridge tile before the
  // diagonal completes: horizontal step first (emit the (cx+sx, cy) bridge),
  // then the vertical step (emit (cx+sx, cy+sy)). This keeps successive
  // emissions Manhattan-adjacent, which is what the 4-connected underground
  // grid requires for a continuous tunnel. When only one axis advances the
  // behavior is identical to plain Bresenham.
  while (cx !== x1 || cy !== y1) {
    const e2 = err * 2;
    const advanceX = e2 > -dy;
    const advanceY = e2 < dx;
    if (advanceX && advanceY) {
      err -= dy;
      cx += sx;
      emitTile(cx, cy); // orthogonal bridge tile
      err += dx;
      cy += sy;
      emitTile(cx, cy); // diagonal destination
    } else if (advanceX) {
      err -= dy;
      cx += sx;
      emitTile(cx, cy);
    } else if (advanceY) {
      err += dx;
      cy += sy;
      emitTile(cx, cy);
    } else {
      // Degenerate state (both axes already at target) — break defensively
      // so a malformed input can never spin. In practice the loop guard
      // (cx !== x1 || cy !== y1) prevents entry when both are at target.
      break;
    }
  }
  // Update debounce cursor to the last tile we actually visited (may be
  // outside bounds only if the entire stroke was clipped; in that case
  // finalX/Y stay at the start, which is fine — the next drag call will
  // re-run the debounce check).
  state.lastMarkedTileX = finalX;
  state.lastMarkedTileY = finalY;
}

// ---------------------------------------------------------------------------
// handleUndergroundRightClick
// ---------------------------------------------------------------------------

/**
 * Handles a right-click on the underground view.
 *
 * Dispatch:
 *   - Marked tile → push CancelDigMarkCommand (CTRL-04: BeingDug is NOT cancellable).
 *   - Open tile that is a tunnel end → open context menu (UNDR-04).
 *   - All other tiles (Solid, BeingDug, non-tunnel-end Open) → no-op.
 *
 * No-ops if: activeView !== 'underground', pointer over HUD, or out of bounds.
 */
export function handleUndergroundRightClick(
  world: WorldState,
  viewState: ViewState,
  screenX: number,
  screenY: number,
): void {
  if (viewState.activeView !== 'underground') return;
  // Issue #14: read-only guard for the enemy underground view (X-toggle).
  // Mirrors handleUndergroundLeftClick — every dispatch below targets
  // PLAYER_COLONY_ID, so a right-click on the enemy view would silently
  // hit the player's grid at the matching coords.
  if (viewState.activeUndergroundColonyId !== PLAYER_COLONY_ID) return;
  if (isPointerOverHUD(screenX, screenY, viewState)) return;
  const { tileX, tileY } = screenToTile(screenX, screenY, viewState.undergroundCamera);
  const grid = world.undergroundGrids[PLAYER_COLONY_ID];
  if (!grid) return;
  if (tileX < 0 || tileY < 0 || tileX >= grid.width || tileY >= grid.height) return;
  const tileState = ugGet(grid, tileX, tileY);

  if (tileState === UndergroundTileState.Marked) {
    // CancelDigMark — only on Marked tiles (CTRL-04: BeingDug finish-then-switch).
    const cmd: CancelDigMarkCommand = {
      type: 'CancelDigMark',
      colonyId: PLAYER_COLONY_ID,
      tileX,
      tileY,
      issuedAtTick: world.tick,
    };
    world.commandQueue.push(cmd);
    return;
  }

  if (tileState === UndergroundTileState.Open && isTunnelEnd(world, tileX, tileY, PLAYER_COLONY_ID)) {
    // Open tunnel end → request context menu for next frame (UNDR-04).
    // Deferred show: UIScene's pointerdown handler runs in the same dispatch as
    // this one and would otherwise see visible=true and mis-interpret this same
    // right-click as a menu-item selection (the menu is anchored at the click).
    // requestShowContextMenu stores the anchor but defers the visible flip to
    // the next UIScene.update frame. See context-menu-state.ts for the full
    // rationale — the SHOW race is symmetric with the HIDE race that module
    // already defends against.
    requestShowContextMenu(screenX, screenY, tileX, tileY);
  }
  // Solid / BeingDug / non-tunnel-end Open → no-op (including no context menu).
}

// ---------------------------------------------------------------------------
// registerUndergroundInput — wires Phaser pointer events
// ---------------------------------------------------------------------------

/**
 * registerUndergroundInput — attach underground-click + drag handlers to a Phaser.Scene.
 *
 * Called from GameScene.create() (Plan 06 Task 3).
 *
 * getWorld is a LAZY accessor — called on every pointer event — so the
 * handler always dispatches against the live WorldState even if
 * GameScene swaps references mid-session (bootFresh, bootFromSave,
 * restartGame). Direct world-reference capture was a stale-closure bug.
 * Returns undefined pre-boot; all handlers short-circuit.
 *
 * Coexistence with registerDragPan: both register pointerdown/pointermove/pointerup.
 * Phaser fires multiple handlers; drag-pan guards on middle-button only, so left-click
 * and right-click reach only the world-input handlers here. Both sets of handlers
 * also guard on isPointerOverHUD so HUD widgets never receive world-click fallthrough.
 *
 * @param scene     - Phaser.Scene (GameScene) providing the input event bus.
 * @param getWorld  - Lazy accessor for the live WorldState.
 * @param viewState - Render-layer ViewState; activeView is read for guard.
 */
export function registerUndergroundInput(
  scene: Phaser.Scene,
  getWorld: () => WorldState | undefined,
  viewState: ViewState,
): UndergroundInputState {
  const state: UndergroundInputState = {
    isDragging: false,
    lastMarkedTileX: -1,
    lastMarkedTileY: -1,
  };

  scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    const world = getWorld();
    if (!world) return;
    if (pointer.leftButtonDown()) {
      handleUndergroundLeftClick(world, viewState, pointer.x, pointer.y, state);
    } else if (pointer.rightButtonDown()) {
      handleUndergroundRightClick(world, viewState, pointer.x, pointer.y);
    }
  });

  scene.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
    if (pointer.isDown && pointer.leftButtonDown()) {
      const world = getWorld();
      if (!world) return;
      handleUndergroundDrag(world, viewState, pointer.x, pointer.y, state);
    }
  });

  scene.input.on('pointerup', () => {
    state.isDragging = false;
  });

  return state;
}
