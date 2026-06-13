// gesture-arbiter.ts — Stage 1 controls rework (issue #18): the single
// left-button gesture arbiter (Codex R1-1).
//
// Before this, three independent GameScene listener sets (camera-input,
// surface-input, underground-input) each claimed the left button. Phaser does
// not guarantee handler order, and camera released first, so a completed pan
// could be misread as a tap. This arbiter EXCLUSIVELY owns the left button:
// pointerdown / move / up / upoutside. Surface & underground tap logic are pure
// functions it calls; left-drag pan and underground-Dig paint are driven here.
//
// Lifecycle of one left press:
//   down (non-HUD)  → snapshot { pointerId, downX/Y, tile, spiderHit, tool,
//                                 view, undergroundColonyId } and arm a pending
//                                 tap; if Dig+underground also begin a paint
//                                 stroke (so the down-tile mark fires eagerly).
//   move            → once past DRAG_THRESHOLD_PX, classify (PLAN §A2):
//                       paint iff (Dig && underground), else pan.
//                       paint → continuePaintStroke; pan → camera delta +
//                       panInputState.isPanning = true.
//   up (no drag)    → TAP: dispatch the pure tap fn for the SNAPSHOTTED tool/view,
//                     acting on the SNAPSHOTTED down-tile.
//   up (after drag) → end the gesture; no tap fires.
//
// cancelGesture() synchronously clears the pending tap, the paint stroke, and
// the pan/drag state, and clears panInputState.isPanning ONLY when the arbiter
// owns the pan (a left-drag pan). It runs on: tool/view/colony change,
// context-menu request, modal / overlay open, gamePhase ≠ Playing, blur, and
// pointerupoutside (PLAN §A3, Codex R1-3/R2-3/R2-5/R3-3). A secondary
// (middle/right) button down instead uses clearLeftGesture so a middle-button
// drag-pan's isPanning claim survives. The GameScene update loop calls
// reconcileContext() each frame to catch tool/view/colony transitions that
// happened via keyboard between pointer events, AND flushPaint() each frame to
// drain any dig tiles a fast stroke deferred past the MAX_COMMANDS_PER_TICK cap.
//
// Fast-stroke cap deferral (Fix 1): continuePaintStroke emits one MarkDigTile per
// 4-connected step. A single fast pointer-move can emit far more than the sim's
// 64-command/tick cap; enqueueCommand now refuses the overflow (paused OR
// running) and continuePaintStroke holds its cursor at the last enqueued tile
// instead of skipping ahead. The arbiter remembers the latest paint TARGET tile
// and re-drives the stroke toward it every frame (flushPaint) plus once on
// pointerup, so the deferred tail emits as the queue drains — no silently lost
// tiles. The "paused queue full" hint fires only when a refusal happens WHILE
// PAUSED (notifyCapHit); an unpaused refusal is silent throttling that catches up
// next tick.
//
// Right-click is handled here too (tool-independent): underground Solid/Open →
// chamber menu via tryOpenChamberMenu; surface RMB → no-op. Middle button is
// reserved for registerDragPan's pan; the arbiter just cancels the left gesture
// when any secondary button goes down so middle-pan can't run concurrently with
// a pending left gesture.
//
// All commands emitted are the SAME SimCommands as today; input enqueues through
// enqueueCommand, never mutating WorldState. Determinism/replay unaffected.

import type { WorldState } from '../sim/types.js';
import type { ViewState, ToolId, CameraState } from '../render/camera.js';
import { clampCamera, screenToTile } from '../render/camera.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
} from '../sim/constants.js';
import { panInputState } from './camera-input.js';
import { classifyDragMode, hasCrossedDragThreshold, DRAG_THRESHOLD_PX } from './gesture.js';
import { handleSurfaceCommandTap, handleSurfaceDigTap, isSpiderHit } from './surface-input.js';
import {
  handleUndergroundCommandTap,
  handleUndergroundDigTap,
  beginPaintStroke,
  continuePaintStroke,
  createPaintStrokeState,
  resetPaintStrokeState,
  tryOpenChamberMenu,
  type PaintStrokeState,
} from './underground-input.js';

/** Pointer button codes, matching Phaser's Pointer button accessors. */
export const LEFT_BUTTON = 0;
export const MIDDLE_BUTTON = 1;
export const RIGHT_BUTTON = 2;

/** A device-agnostic pointer event the arbiter core consumes (no Phaser type). */
export interface ArbiterPointerEvent {
  /** Phaser pointer.id — used to ignore moves/ups from a different pointer. */
  pointerId: number;
  /** 0 = left, 1 = middle, 2 = right. */
  button: number;
  /** Screen X in pixels. */
  x: number;
  /** Screen Y in pixels. */
  y: number;
}

/** Snapshot taken at left pointer-down; the tap acts on these, not live state. */
interface GestureSnapshot {
  pointerId: number;
  downX: number;
  downY: number;
  tileX: number;
  tileY: number;
  spiderHit: boolean;
  tool: ToolId;
  view: 'surface' | 'underground';
  undergroundColonyId: ViewState['activeUndergroundColonyId'];
}

/**
 * Everything the arbiter needs, as injectable functions/values so the core is
 * unit-testable without Phaser.
 */
export interface GestureArbiterDeps {
  /** Live world accessor (lazy — world is swapped on boot/restart). */
  getWorld: () => WorldState | undefined;
  /** Previous-tick world for spider hit-box widening; null when unavailable. */
  getPrevWorld: () => WorldState | null;
  /** Render-layer view state (active view/tool/colony + cameras). */
  viewState: ViewState;
  /** True if the screen point falls on a HUD zone (camera-input.isPointerOverHUD). */
  isPointerOverHUD: (x: number, y: number) => boolean;
  /** True if the render loop is paused (drives the enqueue paused cap). */
  isPaused: () => boolean;
  /**
   * True if a world-EDITING gesture (tap / paint / chamber menu) may run. A bare
   * user-pause must still allow these — they queue through enqueueCommand for
   * application on resume (the whole point of the paused cap) — so this gates on
   * "no modal open", NOT on gamePhase===Playing. A menu pause / GameOver /
   * SavePrompt blocks it.
   */
  canEditWorld: () => boolean;
  /**
   * True if a left-drag PAN may run. Panning is a pure camera move with no world
   * effect, so it is permitted during a bare user-pause exactly like keyboard /
   * middle-button pan. A modal (Esc menu pause / SavePrompt / GameOver) blocks it
   * — GameScene wires this to !isModalOpen(), the same gate as canEditWorld, so
   * the two move together. Blocking the menu/SavePrompt case matters because the
   * arbiter's pan runs from Phaser pointermove handlers independent of update(),
   * and nothing resets the camera on Resume — an un-gated pan would leak the
   * camera behind the menu and persist after it closes. Kept as a SEPARATE dep
   * from canEditWorld so a future caller could re-split them (e.g. allow look-
   * around but not edits) without conflating the two.
   */
  canPan: () => boolean;
  /**
   * True while the chamber context menu is up OR about to (dis)appear —
   * contextMenuState.visible || pendingShow || pendingHide. A left press is then
   * a menu interaction owned by UIScene's pointerdown (select / dismiss), so the
   * arbiter must NOT also run world-tap logic on it (mirrors the retired
   * underground-input `if (contextMenuState.visible) return;` guard). The pending
   * flags cover the deferred-show/hide race window where `visible` lags a frame
   * behind a request issued in the same pointerdown dispatch (cf. hotkey-policy).
   */
  isContextMenuActive: () => boolean;
  /** Called when a command is dropped at the paused cap, to surface the hint. */
  onPausedQueueFull?: () => void;
}

/** Return the active camera for the current view. */
function activeCamera(viewState: ViewState): CameraState {
  return viewState.activeView === 'surface' ? viewState.surfaceCamera : viewState.undergroundCamera;
}

/** Return [worldW, worldH] tile dimensions for the active view. */
function worldDimensions(viewState: ViewState): [number, number] {
  return viewState.activeView === 'surface'
    ? [SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT]
    : [UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT];
}

/**
 * GestureArbiter — the pure core. GameScene constructs one and feeds it pointer
 * events (via registerGestureArbiter) plus a per-frame reconcileContext() call.
 */
export class GestureArbiter {
  private readonly deps: GestureArbiterDeps;
  private readonly paintStroke: PaintStrokeState = createPaintStrokeState();

  /** Snapshot of the active left press, or null when no left gesture is pending. */
  private snapshot: GestureSnapshot | null = null;
  /** Once the threshold is crossed, the resolved drag mode ('paint' | 'pan'); null while still a tap. */
  private dragMode: 'paint' | 'pan' | null = null;
  /** Last pointer position seen during a pan drag (for incremental camera delta). */
  private panLastX = 0;
  private panLastY = 0;
  /**
   * Latest paint TARGET tile — the tile under the pointer on the most recent
   * paintMove. The per-frame flushPaint() re-drives continuePaintStroke toward
   * this so a fast stroke that out-ran the MAX_COMMANDS_PER_TICK cap drains its
   * deferred tail (≤64/tick) even if the pointer then stops. Meaningful only
   * while a paint stroke is active; -1 = none recorded yet.
   */
  private paintTargetX = -1;
  private paintTargetY = -1;

  /**
   * Context fingerprint captured at down + after each frame, so a keyboard-driven
   * tool/view/colony change mid-press is detected and cancels the gesture.
   */
  private ctxTool: ToolId;
  private ctxView: 'surface' | 'underground';
  private ctxColony: ViewState['activeUndergroundColonyId'];

  constructor(deps: GestureArbiterDeps) {
    this.deps = deps;
    this.ctxTool = deps.viewState.activeTool;
    this.ctxView = deps.viewState.activeView;
    this.ctxColony = deps.viewState.activeUndergroundColonyId;
  }

  /** Read the current entrance-hover paint-stroke cursor (debug/tests). */
  isPainting(): boolean {
    return this.dragMode === 'paint' && this.paintStroke.active;
  }

  /** True while a left gesture is pending (down seen, up not yet). */
  hasPendingGesture(): boolean {
    return this.snapshot !== null;
  }

  /**
   * cancelGesture — synchronously abandon any in-flight left gesture: clear the
   * pending tap (snapshot), the paint stroke, the pan/drag state, AND
   * panInputState.isPanning IFF the arbiter currently owns the pan (a left-drag
   * pan, dragMode==='pan'). Idempotent; safe to call when nothing is pending.
   *
   * The isPanning clear is guarded on ownership because that flag is a shared
   * singleton: registerDragPan claims it for a MIDDLE-button drag-pan. Callers
   * such as reconcileContext (tool/view/colony change) and selectTool fire on the
   * frame a hotkey lands, which can be DURING a live middle-drag; an unconditional
   * clear there would flip isPanning off mid-middle-drag and re-open the issue-#85
   * stacked keyboard+drag pan (registerDragPan only re-sets isPanning on its
   * pointerdown, never on move). When dragMode!=='pan' the arbiter does not own
   * isPanning, so it leaves the flag to whoever does.
   */
  cancelGesture(): void {
    const ownsPan = this.dragMode === 'pan';
    this.clearLeftGesture();
    if (ownsPan) panInputState.isPanning = false;
  }

  /**
   * clearLeftGesture — drop only the arbiter's OWN left-gesture state (snapshot,
   * drag mode, paint stroke) without touching panInputState.isPanning. Used by
   * the secondary-button branch: a middle-button down (registerDragPan's pan)
   * runs FIRST and sets isPanning = true to claim the camera; cancelGesture's
   * unconditional clear would then defeat the issue-#85 keyboard-pan suppression
   * for the whole middle-drag. The arbiter never owns isPanning on a secondary
   * button, so it must leave that flag to registerDragPan here.
   */
  private clearLeftGesture(): void {
    this.snapshot = null;
    this.dragMode = null;
    this.paintTargetX = -1;
    this.paintTargetY = -1;
    resetPaintStrokeState(this.paintStroke);
  }

  /**
   * reconcileContext — called once per frame by GameScene. If the tool, view, or
   * underground colony changed since the last check (e.g. via a keyboard hotkey
   * between pointer events), cancel any in-flight gesture so a stroke/pan/tap
   * can't act under the new context. Always refreshes the fingerprint.
   */
  reconcileContext(): void {
    const vs = this.deps.viewState;
    if (
      vs.activeTool !== this.ctxTool ||
      vs.activeView !== this.ctxView ||
      vs.activeUndergroundColonyId !== this.ctxColony
    ) {
      this.cancelGesture();
    }
    this.ctxTool = vs.activeTool;
    this.ctxView = vs.activeView;
    this.ctxColony = vs.activeUndergroundColonyId;
  }

  /**
   * flushPaint — called once per frame by GameScene.update() (alongside
   * reconcileContext). While a paint stroke is active, re-drive
   * continuePaintStroke toward the latest recorded paint TARGET tile so any
   * tiles deferred by the MAX_COMMANDS_PER_TICK cap drain out (≤64/tick) even if
   * the pointer has stopped moving. The whole call is a no-op once the cursor has
   * reached the target (continuePaintStroke's same-tile debounce returns early),
   * and a no-op when no paint stroke is active or no target has been recorded.
   *
   * Pass-through of the live world + paused flag mirrors paintMove. capHit is
   * surfaced through the same paused-gated hint path.
   */
  flushPaint(world: WorldState, isPaused: boolean): void {
    if (this.dragMode !== 'paint' || !this.paintStroke.active) return;
    if (this.paintTargetX === -1 && this.paintTargetY === -1) return;
    // Already at the target → continuePaintStroke debounces to a no-op; calling
    // it is harmless but we can skip the work.
    if (
      this.paintStroke.lastMarkedTileX === this.paintTargetX &&
      this.paintStroke.lastMarkedTileY === this.paintTargetY
    ) {
      return;
    }
    const capHit = continuePaintStroke(
      this.paintStroke,
      world,
      this.deps.viewState,
      this.paintTargetX,
      this.paintTargetY,
      isPaused,
    );
    this.notifyCapHit(capHit);
  }

  onPointerDown(ev: ArbiterPointerEvent): void {
    // Secondary buttons: cancel any pending left gesture first (Codex R2-5), then
    // dispatch the right-click chamber path. Middle is reserved for registerDragPan.
    // Use clearLeftGesture (not cancelGesture) so we don't clear
    // panInputState.isPanning: on a middle-button down registerDragPan has already
    // run and set isPanning = true to claim the camera, and clobbering it here
    // would re-open the issue-#85 stacked keyboard+middle-drag pan.
    if (ev.button === MIDDLE_BUTTON || ev.button === RIGHT_BUTTON) {
      this.clearLeftGesture();
      if (ev.button === RIGHT_BUTTON) this.handleRightClick(ev);
      return;
    }
    if (ev.button !== LEFT_BUTTON) return;
    // While the chamber context menu is up (or about to (dis)appear), a left
    // press is a menu select/dismiss owned by UIScene's pointerdown — don't arm
    // a snapshot, or the same click would also fire a world tap (re-open the
    // menu / mark a dig). Mirrors the retired underground-input guard.
    if (this.deps.isContextMenuActive()) return;
    // Arm a snapshot if EITHER a pan or a world edit could result; the per-mode
    // gate is re-checked when the gesture resolves (canPan in the move→pan
    // branch, canEditWorld at paint-begin / tap dispatch). Gating the whole
    // press on canEditWorld here would kill left-drag pan while user-paused.
    if (!this.deps.canPan() && !this.deps.canEditWorld()) return;
    if (this.deps.isPointerOverHUD(ev.x, ev.y)) return;

    const world = this.deps.getWorld();
    if (!world) return;
    const vs = this.deps.viewState;
    const cam = activeCamera(vs);
    const { tileX, tileY } = screenToTile(ev.x, ev.y, cam);
    const spiderHit =
      vs.activeView === 'surface'
        ? isSpiderHit(world, vs, ev.x, ev.y, this.deps.getPrevWorld())
        : false;

    this.snapshot = {
      pointerId: ev.pointerId,
      downX: ev.x,
      downY: ev.y,
      tileX,
      tileY,
      spiderHit,
      tool: vs.activeTool,
      view: vs.activeView,
      undergroundColonyId: vs.activeUndergroundColonyId,
    };
    this.dragMode = null;
    this.panLastX = ev.x;
    this.panLastY = ev.y;

    // Eagerly begin a paint stroke for underground-Dig so the down-tile mark
    // fires immediately (matching the prior click-then-drag behavior). The
    // stroke only PAINTS once the threshold is crossed; a release before then
    // is a single-tile Dig tap (handled in onPointerUp), so we must not let the
    // eager begin double-emit. We therefore arm the stroke lazily on the first
    // move classified as paint instead — see onPointerMove.
  }

  onPointerMove(ev: ArbiterPointerEvent): void {
    const snap = this.snapshot;
    if (snap === null || ev.pointerId !== snap.pointerId) return;

    // Classify on first crossing of the threshold.
    if (this.dragMode === null) {
      if (!hasCrossedDragThreshold(snap.downX, snap.downY, ev.x, ev.y, DRAG_THRESHOLD_PX)) {
        return; // still a potential tap
      }
      this.dragMode = classifyDragMode(snap.tool, snap.view);
      if (this.dragMode === 'paint') {
        // Paint writes to the world, so it obeys canEditWorld (a menu pause /
        // GameOver blocks it; a bare user-pause queues via the paused cap).
        // Use clearLeftGesture (not cancelGesture): no pan was claimed here, so
        // we must not touch panInputState.isPanning a concurrent owner may hold.
        if (!this.deps.canEditWorld()) {
          this.clearLeftGesture();
          return;
        }
        const world = this.deps.getWorld();
        if (world) {
          // Begin the stroke at the SNAPSHOTTED down-tile so the first painted
          // segment interpolates from there, then extend to the current tile.
          const dropped = beginPaintStroke(
            this.paintStroke,
            world,
            this.deps.viewState,
            snap.tileX,
            snap.tileY,
            this.deps.isPaused(),
          );
          // Seed the flush target at the down-tile; paintMove below overwrites it
          // with the live tile, and subsequent moves keep it current.
          this.paintTargetX = snap.tileX;
          this.paintTargetY = snap.tileY;
          this.notifyCapHit(dropped);
        }
      } else {
        // Pan is a pure camera move, so it obeys canPan (allowed while
        // user-paused, like keyboard / middle-button pan). Bail BEFORE claiming
        // the camera; clearLeftGesture leaves isPanning untouched (we never set
        // it on this path, and a concurrent middle-drag may own it).
        if (!this.deps.canPan()) {
          this.clearLeftGesture();
          return;
        }
        // Claim the camera so keyboard pan is suppressed for the duration.
        panInputState.isPanning = true;
        this.panLastX = ev.x;
        this.panLastY = ev.y;
      }
    }

    if (this.dragMode === 'paint') {
      this.paintMove(ev);
    } else if (this.dragMode === 'pan') {
      this.panMove(ev);
    }
  }

  onPointerUp(ev: ArbiterPointerEvent): void {
    const snap = this.snapshot;
    if (snap === null || ev.pointerId !== snap.pointerId) {
      // A left-up with no matching snapshot: the arbiter has no pending left
      // gesture, so it does NOT own panInputState.isPanning here. Leave the flag
      // alone — a concurrent MIDDLE-button drag-pan (registerDragPan) may own it,
      // and clearing it would flip keyboard-pan suppression off mid-middle-drag
      // (the issue-#85 stacking bug). registerDragPan's own pointerup/upoutside
      // clears it when the middle drag ends.
      return;
    }

    // Drag occurred → no tap; just end the gesture.
    if (this.dragMode !== null) {
      // Stroke-end drain (Fix 1.3b): if this was a paint drag whose last move
      // out-ran the cap, do one final flush toward the stored target so the
      // tail emitted by the final move isn't stranded when the per-frame flush
      // stops (the gesture is cancelled just below). Per-frame flushPaint kept
      // the cursor caught up during the drag, so at most the last move's worth
      // remains here; this clears what fits (≤ the cap as the queue drains).
      if (this.dragMode === 'paint') {
        const world = this.deps.getWorld();
        if (world) this.flushPaint(world, this.deps.isPaused());
      }
      this.cancelGesture();
      return;
    }

    // If the chamber context menu went up (or pending) between this gesture's
    // down and up — e.g. a right-click opened it in the same dispatch that armed
    // a stale left snapshot, or pendingShow/pendingHide was set — the release is
    // part of the menu interaction; swallow the tap so it can't re-open the menu
    // or mark a dig at the menu-anchor tile. (onPointerDown already blocks NEW
    // presses while the menu is active; this covers the in-flight case.)
    if (this.deps.isContextMenuActive()) {
      this.cancelGesture();
      return;
    }

    // No threshold crossing → TAP on the snapshotted down-tile, using the
    // snapshotted tool/view (a later keyboard change can't retarget it — and
    // reconcileContext would already have cancelled on such a change).
    const world = this.deps.getWorld();
    if (world && this.deps.canEditWorld()) {
      this.dispatchTap(snap, world);
    }
    this.cancelGesture();
  }

  /** pointerupoutside / blur — abandon whatever was pending. */
  onPointerUpOutside(): void {
    this.cancelGesture();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Surface the "paused queue full" hint for a cap refusal, but ONLY while
   * paused. An UNPAUSED cap hit is silent transient throttling: the queue drains
   * each tick and the deferred tiles re-emit on the next flush/move, so there is
   * nothing for the player to act on (a hint would be a spurious flash on every
   * fast stroke). While paused the queue genuinely can't drain, so the refusal is
   * actionable — resume to continue.
   */
  private notifyCapHit(capHit: boolean): void {
    if (capHit && this.deps.isPaused()) this.deps.onPausedQueueFull?.();
  }

  private dispatchTap(snap: GestureSnapshot, world: WorldState): void {
    const vs = this.deps.viewState;
    const paused = this.deps.isPaused();
    let dropped = false;
    if (snap.view === 'surface') {
      if (snap.tool === 'command') {
        dropped = handleSurfaceCommandTap(world, snap.tileX, snap.tileY, snap.spiderHit, paused);
      } else if (snap.tool === 'dig') {
        dropped = handleSurfaceDigTap(world, snap.tileX, snap.tileY, paused);
      }
      // surface Chamber is unreachable (no-op).
    } else {
      // underground
      if (snap.tool === 'command') {
        dropped = handleUndergroundCommandTap(world, vs, snap.tileX, snap.tileY, paused);
      } else if (snap.tool === 'dig') {
        dropped = handleUndergroundDigTap(world, vs, snap.tileX, snap.tileY, paused);
      } else if (snap.tool === 'chamber') {
        tryOpenChamberMenu(world, vs, snap.downX, snap.downY, snap.tileX, snap.tileY);
      }
    }
    this.notifyCapHit(dropped);
  }

  private paintMove(ev: ArbiterPointerEvent): void {
    const world = this.deps.getWorld();
    if (!world) return;
    const cam = activeCamera(this.deps.viewState);
    const { tileX, tileY } = screenToTile(ev.x, ev.y, cam);
    // Remember the live target so flushPaint can drain the deferred tail toward
    // it on later frames even if the pointer stops here.
    this.paintTargetX = tileX;
    this.paintTargetY = tileY;
    const capHit = continuePaintStroke(
      this.paintStroke,
      world,
      this.deps.viewState,
      tileX,
      tileY,
      this.deps.isPaused(),
    );
    this.notifyCapHit(capHit);
  }

  private panMove(ev: ArbiterPointerEvent): void {
    const vs = this.deps.viewState;
    // Suppress the camera delta over HUD but keep tracking position so the next
    // valid move is incremental (mirrors registerDragPan's #73 fix).
    if (this.deps.isPointerOverHUD(ev.x, ev.y)) {
      this.panLastX = ev.x;
      this.panLastY = ev.y;
      return;
    }
    const dx = (ev.x - this.panLastX) / TILE_SIZE_PX;
    const dy = (ev.y - this.panLastY) / TILE_SIZE_PX;
    const cam = activeCamera(vs);
    cam.x -= dx;
    cam.y -= dy;
    const [worldW, worldH] = worldDimensions(vs);
    clampCamera(cam, worldW, worldH);
    this.panLastX = ev.x;
    this.panLastY = ev.y;
  }

  private handleRightClick(ev: ArbiterPointerEvent): void {
    if (!this.deps.canEditWorld()) return;
    const vs = this.deps.viewState;
    if (vs.activeView !== 'underground') return; // surface RMB no-op
    if (this.deps.isPointerOverHUD(ev.x, ev.y)) return;
    const world = this.deps.getWorld();
    if (!world) return;
    const cam = activeCamera(vs);
    const { tileX, tileY } = screenToTile(ev.x, ev.y, cam);
    tryOpenChamberMenu(world, vs, ev.x, ev.y, tileX, tileY);
  }
}

// ---------------------------------------------------------------------------
// registerGestureArbiter — Phaser glue
// ---------------------------------------------------------------------------

/**
 * Wire a GestureArbiter to a Phaser.Scene's pointer event bus and return it.
 *
 * The arbiter exclusively owns the left button; registerDragPan stays wired in
 * parallel for the middle-button pan only (its left/Space paths are removed).
 * Both register pointerdown — the arbiter cancels its left gesture on a
 * middle-button down, and registerDragPan ignores left, so they don't fight.
 *
 * Phaser's Pointer carries `.id`, `.x`, `.y`, and `.button` (the button whose
 * state change fired the event: 0=left, 1=middle, 2=right). We forward those as
 * a plain ArbiterPointerEvent so the core stays Phaser-free and unit-testable.
 *
 * `import type` keeps Phaser out of the module runtime (this file is exercised
 * by unit tests without a Phaser runtime via the GestureArbiter class directly).
 */
export function registerGestureArbiter(
  scene: import('phaser').Scene,
  deps: GestureArbiterDeps,
): GestureArbiter {
  const arbiter = new GestureArbiter(deps);

  scene.input.on('pointerdown', (pointer: import('phaser').Input.Pointer) => {
    arbiter.onPointerDown({
      pointerId: pointer.id,
      button: pointer.button,
      x: pointer.x,
      y: pointer.y,
    });
  });
  scene.input.on('pointermove', (pointer: import('phaser').Input.Pointer) => {
    // Only relevant while a button is down; the arbiter also guards on a pending
    // snapshot, but short-circuiting here avoids per-move work on hover.
    if (!pointer.isDown) return;
    arbiter.onPointerMove({
      pointerId: pointer.id,
      button: pointer.button,
      x: pointer.x,
      y: pointer.y,
    });
  });
  scene.input.on('pointerup', (pointer: import('phaser').Input.Pointer) => {
    arbiter.onPointerUp({
      pointerId: pointer.id,
      button: pointer.button,
      x: pointer.x,
      y: pointer.y,
    });
  });
  scene.input.on('pointerupoutside', () => {
    arbiter.onPointerUpOutside();
  });

  return arbiter;
}
