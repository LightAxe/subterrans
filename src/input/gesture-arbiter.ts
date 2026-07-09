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
// happened via keyboard between pointer events.
//
// Fast-stroke cap deferral (Fix 1): continuePaintStroke emits one MarkDigTile per
// 4-connected step. A single fast pointer-move can emit far more than the sim's
// 64-command/tick cap; enqueueCommand refuses the overflow (paused OR running)
// and continuePaintStroke holds its cursor at the last enqueued tile instead of
// skipping ahead. The held tiles re-emit from that cursor on the NEXT
// pointermove — during a continuous drag the queue drains between moves, so each
// subsequent move re-drives the stroke from the held cursor and no tiles are
// lost. There is no per-frame flush and no post-release draining: the pointer's
// own moves are the only thing that advances the stroke. ACCEPTED narrow
// residual: a single coalesced >64-tile pointer-move followed by an IMMEDIATE
// release with NO intervening move can lose the tail past the cap (there is no
// later move to re-emit it from the held cursor). The "paused queue full" hint
// fires only when a refusal happens WHILE PAUSED (notifyCapHit); an unpaused
// refusal is silent throttling that catches up on the next move.
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
import type { ViewState, ToolId } from '../render/camera.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import {
  type CameraView,
  type PinchState,
  beginPinch,
  applyPinch,
  cancelZoomLerp,
  clampCameraView,
  screenToTileZoom,
  panByScreenDelta,
} from '../render/camera-adapter.js';
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
import type { CommandFeedforward } from '../render/command-feedforward.js';

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
  /**
   * #237 — Phaser `pointer.wasTouch`: true when this event came from touch. The
   * stable boolean to gate touch-only behavior (pinch entry / long-press / hover
   * preview). Optional so existing unit tests need not set it (mouse paths).
   */
  wasTouch?: boolean;
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
  /** #237 PR3 — was this gesture started by a touch pointer? Only touch gets the
   *  scale-tuned drag threshold; mouse/trackpad keeps the fixed DRAG_THRESHOLD_PX. */
  wasTouch: boolean;
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
  /**
   * Projected world (Stage 3a): the live world with the whole command queue folded
   * through the real handlers. Underground tap/menu decisions resolve against it so the
   * cue and the emitted command can never disagree (Codex R2-3/4). Aliases the live
   * world when the queue is empty, so it is cheap to call per tap.
   */
  getProjectedWorld: () => WorldState;
  /**
   * Trial-apply feedforward (Stage 3a), paired with getProjectedWorld. The underground
   * Dig/Command taps gate their emit on feedforward.willTakeEffect against the projected
   * world — the SAME trial-apply the on-screen cue uses — so a tap never enqueues a
   * command the cue painted red (an Open-tile mark or an embedded-ant cancel both no-op
   * in the sim). Shared with the render hover path; cheap to call per tap.
   */
  getFeedforward: () => CommandFeedforward;
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
  /**
   * Called when a command is dropped at the queue cap, to surface the queue-full
   * hint. `paused` carries the live pause state at the moment of the drop so the
   * hint can be accurate: a PAUSED drop means the queue can't drain ("resume to
   * continue"), while a RUNNING drop is transient throttling ("try again"). Paint
   * only calls this while paused (an unpaused paint cap hit is silent — it re-emits
   * on the next move); one-shot taps call it on ANY drop (no re-emit) (Codex P2).
   */
  onPausedQueueFull?: (paused: boolean) => void;
  // Stage 3b (issue #18, #3) — thin teaching seams. Fired on the EFFECT, not the
  // raw input (Codex R1#10), so first-use hints react to what actually happened.
  // Optional: tests and any non-teaching caller simply omit them.
  /** The camera actually moved on a left-drag pan ("Drag to look around"). */
  onPanEffect?: () => void;
  /** A dig-paint drag actually enqueued ≥1 mark ("Drag to paint tunnels"). */
  onPaintEffect?: () => void;
  /** A world gesture began (a left press that armed a snapshot) — the signal
   *  GameScene uses to evaluate the proactive [Tab] nudge on first world input. */
  onWorldInput?: () => void;
  /**
   * #237 PR3 — the TOUCH drag threshold in LOGICAL pixels, scale-tuned for the
   * current display (see gesture.thresholdLogicalPx). GameScene computes it from
   * the canvas's CSS width at boot and on resize; the arbiter reads it per move
   * but applies it ONLY to touch gestures (snap.wasTouch). Mouse/trackpad always
   * uses the fixed, UAT-tuned DRAG_THRESHOLD_PX, so desktop click-vs-drag is
   * unchanged regardless of this value. Optional: omitted (as in every existing
   * unit test) → even touch falls back to DRAG_THRESHOLD_PX.
   */
  getDragThreshold?: () => number;
}

/** Return the active CameraView for the current view. */
function activeCamera(viewState: ViewState): CameraView {
  return viewState.activeView === 'surface' ? viewState.surfaceCamera : viewState.undergroundCamera;
}

/** Return [worldPxW, worldPxH] world-pixel dimensions for the active view. */
function worldDimensions(viewState: ViewState): [number, number] {
  return viewState.activeView === 'surface'
    ? [SURFACE_GRID_WIDTH * TILE_SIZE_PX, SURFACE_GRID_HEIGHT * TILE_SIZE_PX]
    : [UNDERGROUND_GRID_WIDTH * TILE_SIZE_PX, UNDERGROUND_GRID_HEIGHT * TILE_SIZE_PX];
}

/**
 * GestureArbiter — the pure core. GameScene constructs one and feeds it pointer
 * events (via registerGestureArbiter) plus a per-frame reconcileContext() call.
 */
export class GestureArbiter {
  private readonly deps: GestureArbiterDeps;
  private readonly paintStroke: PaintStrokeState = createPaintStrokeState();

  /**
   * #237 two-pointer state. `mode` gates the handlers; `pointers` tracks every
   * down button-0/touch pointer's live position (the source for a pinch's
   * midpoint/distance, and for re-snapshotting the survivor when one pinch finger
   * lifts). `single` is the tap/drag gesture (the former `snapshot`). `pinch`
   * (PR2) is the captured pinch-start state; non-null iff `mode === 'pinch'`.
   */
  private mode: 'idle' | 'single' | 'pinch' = 'idle';
  private pointers = new Map<
    number,
    { pointerId: number; x: number; y: number; wasTouch: boolean }
  >();
  /** Snapshot of the active single (tap/drag) press, or null when none is pending. */
  private single: GestureSnapshot | null = null;
  /** #237 PR2 — captured pinch-start (zoom/dist/anchor); non-null iff mode==='pinch'. */
  private pinch: PinchState | null = null;
  /**
   * #237 — true when `single` was re-armed from a pinch SURVIVOR (one finger of a
   * two-finger pinch lifted while the other stayed down). Such a single may still
   * pan/paint if it MOVES, but a lift with no intervening move is the paired
   * release of the pinch (both fingers up ~together), NOT a one-finger tap — so it
   * must not dispatch a tap (Codex #272 P1). Reset on every fresh arm / abandon.
   */
  private singleFromPinch = false;
  /** Once the threshold is crossed, the resolved drag mode ('paint' | 'pan'); null while still a tap. */
  private dragMode: 'paint' | 'pan' | null = null;
  /** Last pointer position seen during a pan drag (for incremental camera delta). */
  private panLastX = 0;
  private panLastY = 0;

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

  /** True while a single (tap/drag) gesture is pending (down seen, up not yet). */
  hasPendingGesture(): boolean {
    return this.single !== null;
  }

  /**
   * cancelGesture — FULLY abandon any in-flight gesture: release the single
   * (tap/drag) snapshot + paint stroke, drop panInputState.isPanning IFF the
   * arbiter owns the pan (dragMode==='pan'), AND reset the two-pointer
   * bookkeeping (mode→idle, every tracked pointer forgotten). Idempotent; safe
   * when nothing is pending.
   *
   * This is the "abandon everything" primitive every abort caller wants —
   * reconcileContext (tool/view/colony change), selectTool, blur, the RIGHT
   * button, and the pan/menu/tap teardowns in handleSingleUp. The two-pointer
   * reset (#237 PR1) is load-bearing: a keyboard-driven cancel DURING a pinch
   * must not strand mode='pinch' with live `pointers`, or a later finger-lift
   * would re-arm a stray single / emit a tap under the changed context (Codex
   * F1). Likewise it guarantees the invariant `mode==='single' ⇒ single!==null`:
   * a cancel can never leave mode='single' with a null snapshot for the next
   * down to mis-route into the 2nd-finger (pinch) branch (Codex F2).
   *
   * The single→pinch handoff (onPointerDown) deliberately does NOT use this — it
   * needs the ownership-gated release WITHOUT the pointer reset (finger 1 stays
   * tracked for the pinch), so it calls releaseSingle directly.
   */
  cancelGesture(): void {
    this.releaseSingle();
    this.resetPointerTracking();
  }

  /**
   * releaseSingle — ownership-gated teardown of the single (tap/drag) gesture:
   * clear its snapshot + paint stroke, and drop panInputState.isPanning IFF this
   * gesture owned the pan (dragMode==='pan'). Does NOT touch the two-pointer
   * bookkeeping — cancelGesture layers resetPointerTracking on top; the
   * single→pinch handoff calls this ALONE so finger 1 stays tracked.
   *
   * The isPanning clear is ownership-guarded because that flag is a shared
   * singleton: registerDragPan claims it for a MIDDLE-button drag-pan. Callers
   * such as reconcileContext (tool/view/colony change) and selectTool fire on the
   * frame a hotkey lands, which can be DURING a live middle-drag; an unconditional
   * clear there would flip isPanning off mid-middle-drag and re-open the issue-#85
   * stacked keyboard+drag pan (registerDragPan only re-sets isPanning on its
   * pointerdown, never on move). When dragMode!=='pan' the arbiter does not own
   * isPanning, so it leaves the flag to whoever does.
   *
   * Fix 2 — cancelGesture (via releaseSingle, NOT clearLeftGesture) is what the
   * RIGHT-button branch uses, so a right-click DURING an active left-drag pan
   * (dragMode==='pan') releases the pan claim: right-click has no registerDragPan
   * release handler, so without this the flag would stay set and keyboard pan
   * would remain suppressed (the #85 lock) until another full pan or a session
   * reset. The ownership guard keeps it safe when the left gesture was NOT panning
   * (dragMode null → a foreign isPanning, e.g. set by some other owner, is left
   * intact).
   */
  private releaseSingle(): void {
    const ownsPan = this.dragMode === 'pan';
    this.clearLeftGesture();
    if (ownsPan) panInputState.isPanning = false;
  }

  /**
   * resetPointerTracking — return the two-pointer state machine to idle: forget
   * every tracked pointer and set mode='idle'. Paired with releaseSingle by
   * cancelGesture, and with clearLeftGesture by the mid-drag paint/pan bails and
   * the secondary-button branch — i.e. anywhere a gesture is abandoned WITHOUT a
   * matching pointerup. Keeping it out of those paths would let mode='single'
   * linger with a null single (or mode='pinch' linger with dead pointers), which
   * mis-routes the next down (Codex F1/F2).
   */
  private resetPointerTracking(): void {
    this.pointers.clear();
    this.mode = 'idle';
    this.pinch = null; // #237 PR2 — pinch state lives only while mode==='pinch'
  }

  /**
   * clearLeftGesture — drop ONLY the arbiter's own left-gesture state (snapshot,
   * drag mode, paint stroke) WITHOUT touching panInputState.isPanning.
   *
   * Used by the MIDDLE-button secondary branch, where the flag must survive even
   * when the left gesture was itself an active pan: on a middle-button down
   * registerDragPan's pointerdown runs (and sets/keeps isPanning = true to claim
   * the camera for the MIDDLE drag), so clearing it here — even though the left
   * gesture "owned" a pan a moment ago — would clobber registerDragPan's fresh
   * claim and re-open the issue-#85 stacked keyboard+middle-drag pan. The middle
   * drag is now the owner; its own pointerup/upoutside clears the flag.
   *
   * This is why the right-click path uses cancelGesture (ownership-gated release)
   * while the middle path uses clearLeftGesture (release nothing): right-click has
   * NO successor pan claim, middle-down DOES. The paint-bail / paint-up sites also
   * use clearLeftGesture, but there dragMode==='paint' so there is no pan claim to
   * release anyway.
   */
  private clearLeftGesture(): void {
    this.single = null;
    this.dragMode = null;
    this.singleFromPinch = false;
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

  onPointerDown(ev: ArbiterPointerEvent): void {
    // Secondary buttons: abandon any pending left gesture first (Codex R2-5), then
    // dispatch the right-click chamber path. The two buttons differ ONLY in how
    // they treat panInputState.isPanning (Fix 2):
    //   - MIDDLE: registerDragPan's pointerdown runs on the same event and sets
    //     isPanning = true to claim the camera for the MIDDLE drag. Use
    //     clearLeftGesture, which leaves the flag ALONE — even if the left gesture
    //     was itself an active pan a moment ago — so we don't clobber
    //     registerDragPan's fresh claim and re-open the issue-#85 stacked
    //     keyboard+middle-drag pan. The middle drag's own pointerup clears it.
    //   - RIGHT: there is NO successor pan claim and right-click has no
    //     registerDragPan release handler. Use cancelGesture, whose ownership-
    //     gated release drops isPanning IFF the LEFT gesture owned the pan
    //     (dragMode==='pan') — otherwise keyboard pan would stay suppressed (the
    //     #85 lock) until another full pan / session reset. A right-click while
    //     the left gesture was NOT panning leaves a foreign isPanning intact.
    if (ev.button === MIDDLE_BUTTON || ev.button === RIGHT_BUTTON) {
      if (ev.button === RIGHT_BUTTON) {
        this.cancelGesture();
        this.handleRightClick(ev);
      } else {
        // MIDDLE: clearLeftGesture leaves isPanning ALONE (registerDragPan just
        // claimed it for the middle drag); resetPointerTracking still abandons the
        // left gesture's two-pointer bookkeeping so a stale mode/pointer can't
        // outlive it (without touching isPanning).
        this.clearLeftGesture();
        this.resetPointerTracking();
      }
      return;
    }
    if (ev.button !== LEFT_BUTTON) return;

    // #237 PR1 — two-pointer transitions (button-0 / touch). `pointers` tracks
    // every down button-0 pointer; `mode` gates the handlers.
    if (this.mode === 'pinch') {
      // A 3rd+ finger while pinching → ignore (not tracked).
      return;
    }
    if (this.mode === 'single') {
      // A 2nd distinct pointer while a single gesture is live → enter pinch.
      if (this.single !== null && ev.pointerId === this.single.pointerId) return; // same id re-down
      // Hand off via releaseSingle (NOT cancelGesture) so a live left-drag pan
      // releases its panInputState.isPanning claim through the load-bearing
      // ownership protocol (see releaseSingle / issue #85 / Fix 2) while finger 1
      // stays tracked in `pointers` — cancelGesture would additionally reset the
      // very bookkeeping we are about to build the pinch from.
      this.releaseSingle();
      this.pointers.set(ev.pointerId, {
        pointerId: ev.pointerId,
        x: ev.x,
        y: ev.y,
        wasTouch: ev.wasTouch ?? false,
      });
      this.mode = 'pinch';
      // #237 PR2 — capture the pinch anchor from the two tracked fingers. Math.max
      // (dist, 1) guards a zero startDist (two touches reported at the same point)
      // so applyPinch's distance ratio stays finite.
      const cam = activeCamera(this.deps.viewState);
      // The pinch takes over the zoom NOW: cancel any in-flight wheel-zoom lerp
      // (targetZoom≠zoom) so a STATIONARY two-finger hold can't keep lerping toward
      // a stale targetZoom under the fingers before the first pinch move (Codex
      // PR2). applyPinch then drives zoom===targetZoom directly.
      cancelZoomLerp(cam);
      const { midX, midY, dist } = this.twoPointerMidDist();
      this.pinch = beginPinch(cam, midX, midY, Math.max(dist, 1));
      return;
    }

    // mode === 'idle' — arm a single from the first pointer if the admission
    // guards pass (context-menu / pan-or-edit / HUD; see canArmSingleAt).
    if (!this.canArmSingleAt(ev.x, ev.y)) return;
    if (!this.armSingle(ev.pointerId, ev.x, ev.y, ev.wasTouch ?? false)) return; // world unavailable
    this.mode = 'single';
    this.pointers.set(ev.pointerId, {
      pointerId: ev.pointerId,
      x: ev.x,
      y: ev.y,
      wasTouch: ev.wasTouch ?? false,
    });

    // Stage 3b (#3): a world gesture has begun. Signal it so GameScene can evaluate
    // the proactive [Tab] first-use nudge on the player's first world input of the
    // session (the nudge gate reads view/undergroundVisited, which a pan/dig press
    // does not change, so firing at press-time is safe).
    this.deps.onWorldInput?.();
  }

  /**
   * canArmSingleAt — the idle-down ADMISSION guards for arming a single (tap/drag)
   * at a screen point. Applied both to a fresh first-pointer down AND to the
   * survivor re-snapshot when one pinch finger lifts. The survivor re-check is
   * load-bearing (Codex #271): the 2nd-finger→pinch handoff does NOT HUD-guard its
   * pointer, so without re-checking here a finger placed on the HUD could outlive
   * the pinch and dispatch a world tap from HUD coordinates.
   *
   *  - isContextMenuActive: while the chamber menu is up (or about to (dis)appear)
   *    a left press is a menu select/dismiss owned by UIScene's pointerdown — don't
   *    arm, or the same click would also fire a world tap.
   *  - canPan || canEditWorld: arm if EITHER a pan or a world edit could result;
   *    the per-mode gate is re-checked when the gesture resolves (canPan in the
   *    move→pan branch, canEditWorld at paint-begin / tap dispatch). Gating the
   *    whole press on canEditWorld would kill left-drag pan while user-paused.
   *  - isPointerOverHUD: a press on a HUD zone belongs to the HUD, not the world.
   */
  private canArmSingleAt(x: number, y: number): boolean {
    if (this.deps.isContextMenuActive()) return false;
    if (!this.deps.canPan() && !this.deps.canEditWorld()) return false;
    if (this.deps.isPointerOverHUD(x, y)) return false;
    return true;
  }

  /**
   * armSingle — capture a fresh single (tap/drag) snapshot at a screen position.
   * Shared by a first left/touch down and by the survivor re-snapshot when one
   * pinch finger lifts (#237 PR1). Returns false (nothing armed) when the world is
   * unavailable. Callers gate on canArmSingleAt FIRST (HUD/menu/edit admission);
   * this only fails on an unavailable world. The tap acts on the SNAPSHOTTED
   * tile/tool/view, not live state (a later keyboard change can't retarget it;
   * reconcileContext cancels on such changes).
   *
   * Paint note: the underground-Dig stroke is NOT begun here — it is armed lazily
   * on the first move classified as paint (see onPointerMove), so a release before
   * the threshold is a single-tile Dig tap (onPointerUp) and cannot double-emit.
   */
  private armSingle(pointerId: number, x: number, y: number, wasTouch: boolean): boolean {
    const world = this.deps.getWorld();
    if (!world) return false;
    const vs = this.deps.viewState;
    const cam = activeCamera(vs);
    const { tileX, tileY } = screenToTileZoom(x, y, cam);
    const spiderHit =
      vs.activeView === 'surface' ? isSpiderHit(world, vs, x, y, this.deps.getPrevWorld()) : false;
    this.single = {
      pointerId,
      downX: x,
      downY: y,
      tileX,
      tileY,
      spiderHit,
      tool: vs.activeTool,
      view: vs.activeView,
      undergroundColonyId: vs.activeUndergroundColonyId,
      wasTouch,
    };
    this.dragMode = null;
    this.singleFromPinch = false; // fresh arm; the survivor re-arm re-sets this true
    this.panLastX = x;
    this.panLastY = y;
    return true;
  }

  /**
   * twoPointerMidDist — the midpoint and finger-distance of the two tracked pinch
   * pointers (#237 PR2), the source for beginPinch/applyPinch. Only called while
   * pinching (exactly two tracked fingers); the undefined-guard satisfies
   * noUncheckedIndexedAccess and degrades to a no-op zoom (dist=1) if ever reached
   * with fewer.
   */
  private twoPointerMidDist(): { midX: number; midY: number; dist: number } {
    const [a, b] = [...this.pointers.values()];
    if (a === undefined || b === undefined) {
      return { midX: a?.x ?? b?.x ?? 0, midY: a?.y ?? b?.y ?? 0, dist: 1 };
    }
    return { midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  onPointerMove(ev: ArbiterPointerEvent): void {
    // #237 pinch: track each tracked finger's live position, then recompute the
    // midpoint/distance and drive the anchored zoom (PR2).
    if (this.mode === 'pinch') {
      const p = this.pointers.get(ev.pointerId);
      if (p === undefined) return; // untracked 3rd finger — its moves don't drive the pinch
      p.x = ev.x;
      p.y = ev.y;
      if (this.pinch !== null) {
        const vs = this.deps.viewState;
        const cam = activeCamera(vs);
        const { midX, midY, dist } = this.twoPointerMidDist();
        // Anchored zoom about the CURRENT midpoint folds the two-finger pan in.
        applyPinch(cam, this.pinch, midX, midY, dist);
        const [worldW, worldH] = worldDimensions(vs);
        clampCameraView(cam, worldW, worldH);
      }
      return;
    }
    if (this.mode !== 'single') return; // idle — no gesture pending

    const snap = this.single;
    if (snap === null || ev.pointerId !== snap.pointerId) return;
    // Keep the tracked position current so a 2nd finger's pinch begins from this
    // pointer's live (moved) position, not its stale down position.
    const tracked = this.pointers.get(ev.pointerId);
    if (tracked !== undefined) {
      tracked.x = ev.x;
      tracked.y = ev.y;
    }

    // Classify on first crossing of the threshold. #237 PR3: TOUCH uses the
    // scale-tuned threshold (finger jitter grows in logical px as the FIT-scaled
    // canvas shrinks) when GameScene provides it; mouse/trackpad keeps the fixed,
    // UAT-tuned DRAG_THRESHOLD_PX so desktop click-vs-drag is unchanged.
    if (this.dragMode === null) {
      const threshold =
        snap.wasTouch && this.deps.getDragThreshold !== undefined
          ? this.deps.getDragThreshold()
          : DRAG_THRESHOLD_PX;
      if (!hasCrossedDragThreshold(snap.downX, snap.downY, ev.x, ev.y, threshold)) {
        return; // still a potential tap
      }
      this.dragMode = classifyDragMode(snap.tool, snap.view);
      if (this.dragMode === 'paint') {
        // Paint writes to the world, so it obeys canEditWorld (a menu pause /
        // GameOver blocks it; a bare user-pause queues via the paused cap).
        // Use clearLeftGesture (not cancelGesture): no pan was claimed here, so
        // we must not touch panInputState.isPanning a concurrent owner may hold.
        if (!this.deps.canEditWorld()) {
          // Abandon the whole gesture: clearLeftGesture (no isPanning to release —
          // paint never claimed it) + resetPointerTracking so mode/pointers don't
          // linger as a stale 'single' the next down would mis-route (Codex F2).
          this.clearLeftGesture();
          this.resetPointerTracking();
          return;
        }
        const world = this.deps.getWorld();
        if (world) {
          // Begin the stroke at the SNAPSHOTTED down-tile so the first painted
          // segment interpolates from there, then extend to the current tile.
          const queuedBefore = world.commandQueue.length;
          const dropped = beginPaintStroke(
            this.paintStroke,
            world,
            this.deps.viewState,
            snap.tileX,
            snap.tileY,
            this.deps.isPaused(),
          );
          // Stage 3b (#3): fire the paint hint only if a mark actually enqueued
          // (queue grew) — not on a no-op drag over already-open tiles.
          if (world.commandQueue.length > queuedBefore) this.deps.onPaintEffect?.();
          this.notifyCapHit(dropped);
        }
      } else {
        // Pan is a pure camera move, so it obeys canPan (allowed while
        // user-paused, like keyboard / middle-button pan). Bail BEFORE claiming
        // the camera; clearLeftGesture leaves isPanning untouched (we have not set
        // it yet on this path — the claim below is the only setter — and a
        // concurrent middle-drag may own it).
        if (!this.deps.canPan()) {
          // Abandon before claiming the camera: clearLeftGesture leaves isPanning
          // untouched (we never set it on this path; a concurrent middle-drag may
          // own it) and resets dragMode→null; resetPointerTracking clears the stale
          // 'single' bookkeeping so the next down isn't mis-routed (Codex F2).
          this.clearLeftGesture();
          this.resetPointerTracking();
          return;
        }
        // Claim the camera so keyboard pan is suppressed for the duration.
        panInputState.isPanning = true;
        // Seed the pan reference at the pointer-DOWN coords, NOT this move's
        // coords. The first panMove below then applies the full (current − down)
        // displacement, so a fast flick delivered as ONE coalesced move past the
        // threshold actually moves the camera (seeding from ev here would make
        // the first delta zero — the flick would classify as a drag but pan 0px).
        // panMove updates panLastX/Y to the current point afterwards, so
        // subsequent incremental moves are not double-counted.
        this.panLastX = snap.downX;
        this.panLastY = snap.downY;
      }
    }

    if (this.dragMode === 'paint') {
      this.paintMove(ev);
    } else if (this.dragMode === 'pan') {
      this.panMove(ev);
    }
  }

  onPointerUp(ev: ArbiterPointerEvent): void {
    // #237 PR1 — a pinch finger lifted: NO tap. Drop it and re-snapshot the
    // survivor as a fresh single (so lifting it later taps, moving it pans/paints).
    if (this.mode === 'pinch') {
      if (!this.pointers.has(ev.pointerId)) return; // untracked 3rd-finger up — ignore
      this.pointers.delete(ev.pointerId);
      const survivor = [...this.pointers.values()][0];
      // Re-apply the idle-down admission guards before re-arming (Codex #271): a
      // survivor now over the HUD / under an open menu / with the world gone must
      // NOT become a tap. If it can't arm, cancelGesture drops everything → idle
      // (the still-down finger then no-ops until it lifts and a fresh press starts).
      if (
        survivor !== undefined &&
        this.canArmSingleAt(survivor.x, survivor.y) &&
        // Carry the survivor's OWN wasTouch (usually a touch pinch finger, but a
        // mixed mouse+touch pinch can leave the mouse as survivor) so its drag
        // threshold matches its real device (Fable #273 F2).
        this.armSingle(survivor.pointerId, survivor.x, survivor.y, survivor.wasTouch)
      ) {
        this.mode = 'single';
        this.pinch = null; // #237 PR2 — pinch ended; the survivor is a plain single now
        // Mark it pinch-derived: it can pan/paint if it MOVES, but a lift with no
        // move is the pinch's paired release, not a tap (suppressed in handleSingleUp).
        this.singleFromPinch = true;
      } else {
        this.cancelGesture(); // drops pinch via resetPointerTracking
      }
      return;
    }
    if (this.mode !== 'single') return; // idle — nothing pending

    // Remove this pointer up-front so every exit path of the single-up teardown
    // leaves `pointers` correct; then run today's single-gesture up handling.
    this.pointers.delete(ev.pointerId);
    this.handleSingleUp(ev);
    if (this.pointers.size === 0) this.mode = 'idle';
  }

  /**
   * handleSingleUp — today's single-pointer up handling (drag-end / menu-swallow /
   * TAP). Operates on `this.single`; onPointerUp above owns the two-pointer
   * bookkeeping. Extracted verbatim in #237 PR1.
   */
  private handleSingleUp(ev: ArbiterPointerEvent): void {
    const snap = this.single;
    if (snap === null || ev.pointerId !== snap.pointerId) {
      // A left-up with no matching snapshot: the arbiter has no pending left
      // gesture, so it does NOT own panInputState.isPanning here. Leave the flag
      // alone — a concurrent MIDDLE-button drag-pan (registerDragPan) may own it,
      // and clearing it would flip keyboard-pan suppression off mid-middle-drag
      // (the issue-#85 stacking bug). registerDragPan's own pointerup/upoutside
      // clears it when the middle drag ends.
      return;
    }

    // Drag occurred → no tap; end the gesture for new input.
    if (this.dragMode !== null) {
      if (this.dragMode === 'paint') {
        // Release ENDS the stroke — no post-release draining. Each pointermove
        // during the drag already re-emitted any cap-deferred tiles from the held
        // cursor (the queue drains between moves), so a continuous drag has
        // nothing left outstanding at release. The one accepted residual is a
        // single coalesced >64-tile move followed by an IMMEDIATE release with no
        // intervening move: its tail past the cap is lost because there is no
        // later move to re-drive from the held cursor. A paint stroke never owns
        // the pan (no isPanning claim), so clearLeftGesture (which never touches
        // isPanning) is the right teardown here.
        this.clearLeftGesture();
        return;
      }
      // Pan drag: end the gesture and release the camera claim.
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

    // A pinch SURVIVOR that never moved is the paired release of the two-finger
    // pinch (both fingers lift ~together), NOT a one-finger tap — suppress it so a
    // pinch-zoom release can't move the rally point / mark a dig tile (Codex #272
    // P1). A survivor that MOVED took the dragMode!==null path above (pan/paint),
    // so this only gates the no-move release; a genuine tap needs a fresh press.
    if (this.singleFromPinch) {
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

  /** pointerupoutside / blur — abandon everything pending. */
  onPointerUpOutside(): void {
    // cancelGesture fully resets: releases the single (dropping pan iff owned) AND
    // clears the two-pointer bookkeeping via resetPointerTracking (mode→idle,
    // pointers cleared, pinch=null), so a stray finger can't strand the arbiter.
    this.cancelGesture();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Surface the queue-full hint for a PAINT cap refusal, but ONLY while paused.
   * An UNPAUSED paint cap hit is silent transient throttling: the queue drains
   * each tick and the deferred tiles re-emit on the next flush/move, so there is
   * nothing for the player to act on (a hint would be a spurious flash on every
   * fast stroke). While paused the queue genuinely can't drain, so the refusal is
   * actionable — resume to continue. (One-shot taps use notifyOneShotDrop, which
   * fires on ANY drop — see below.) This path only fires while paused, so it
   * always passes paused=true to the hint.
   */
  private notifyCapHit(capHit: boolean): void {
    if (capHit && this.deps.isPaused()) this.deps.onPausedQueueFull?.(true);
  }

  /**
   * Surface the queue-full hint for a ONE-SHOT command drop, paused OR unpaused
   * (Codex P2). Unlike paint (which holds its cursor and re-emits the deferred
   * tail on the next move), a one-shot — a surface/underground command tap, a
   * single Dig tap — does NOT re-emit: a drop at the cap is a real, silent loss.
   * So whenever enqueueCommand refuses a one-shot we flash the hint regardless of
   * pause state, passing the LIVE pause state so the message is accurate: a paused
   * drop says "resume to continue", an unpaused (transient-burst) drop says "try
   * again". (When unpaused this is rare: the queue is momentarily full, e.g. right
   * after a big dig-paint burst.)
   */
  private notifyOneShotDrop(dropped: boolean): void {
    if (dropped) this.deps.onPausedQueueFull?.(this.deps.isPaused());
  }

  private dispatchTap(snap: GestureSnapshot, world: WorldState): void {
    const vs = this.deps.viewState;
    const paused = this.deps.isPaused();
    let dropped = false;
    if (snap.view === 'surface') {
      if (snap.tool === 'command') {
        dropped = handleSurfaceCommandTap(world, snap.tileX, snap.tileY, snap.spiderHit, paused);
      } else if (snap.tool === 'dig') {
        // Gate the entrance on feedforward.willTakeEffect against the projected world (Stage 3a)
        // — the SAME trial-apply the hover cue uses — so the cue and the tap can never disagree
        // and a paused repeat-tap can't re-queue a duplicate (or column-dup / capped) no-op (Codex).
        dropped = handleSurfaceDigTap(
          world,
          this.deps.getProjectedWorld(),
          this.deps.getFeedforward(),
          snap.tileX,
          snap.tileY,
          paused,
        );
      }
      // surface Chamber is unreachable (no-op).
    } else {
      // underground — resolve mark-vs-cancel + menu eligibility against the projected
      // world (Stage 3a): the whole queue folded, the same state feedforward uses.
      const projected = this.deps.getProjectedWorld();
      const feedforward = this.deps.getFeedforward();
      if (snap.tool === 'command') {
        dropped = handleUndergroundCommandTap(
          world,
          projected,
          feedforward,
          vs,
          snap.tileX,
          snap.tileY,
          paused,
        );
      } else if (snap.tool === 'dig') {
        dropped = handleUndergroundDigTap(
          world,
          projected,
          feedforward,
          vs,
          snap.tileX,
          snap.tileY,
          paused,
        );
      } else if (snap.tool === 'chamber') {
        tryOpenChamberMenu(world, projected, vs, snap.downX, snap.downY, snap.tileX, snap.tileY);
      }
    }
    // A tap is a ONE-SHOT command (no re-emit): surface the hint on ANY drop,
    // paused or not (Codex P2). Paint, by contrast, re-drives from its held
    // cursor on the next move, so it uses the paused-only notifyCapHit.
    this.notifyOneShotDrop(dropped);
  }

  private paintMove(ev: ArbiterPointerEvent): void {
    const world = this.deps.getWorld();
    if (!world) return;
    const cam = activeCamera(this.deps.viewState);
    const { tileX, tileY } = screenToTileZoom(ev.x, ev.y, cam);
    // A cap-deferred tail from the previous move stays held at the stroke cursor;
    // this move re-drives continuePaintStroke from that cursor (the queue has
    // drained between moves), so the held tiles re-emit and the stroke advances.
    // Accepted residual: a single coalesced >64-tile move + immediate release
    // (no later move) loses the tail past the cap — see continuePaintStroke and
    // the file header.
    const queuedBefore = world.commandQueue.length;
    const capHit = continuePaintStroke(
      this.paintStroke,
      world,
      this.deps.viewState,
      tileX,
      tileY,
      this.deps.isPaused(),
    );
    if (world.commandQueue.length > queuedBefore) this.deps.onPaintEffect?.();
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
    const cam = activeCamera(vs);
    // Snapshot the camera CENTER before the move so the first-use hint fires on
    // the actual EFFECT, not the raw pointer delta (ship-review R1#2): at a
    // clamped world edge the pointer can move while the camera stays put. Mirrors
    // the zoom seam (targetZoom before/after) and the paint seam (queue length).
    const beforeCenterX = cam.centerX;
    const beforeCenterY = cam.centerY;
    panByScreenDelta(cam, ev.x - this.panLastX, ev.y - this.panLastY);
    const [worldW, worldH] = worldDimensions(vs);
    clampCameraView(cam, worldW, worldH);
    this.panLastX = ev.x;
    this.panLastY = ev.y;
    // Stage 3b (#3): the camera ACTUALLY moved → first-use "Drag to look around".
    if (cam.centerX !== beforeCenterX || cam.centerY !== beforeCenterY) {
      this.deps.onPanEffect?.();
    }
  }

  private handleRightClick(ev: ArbiterPointerEvent): void {
    if (!this.deps.canEditWorld()) return;
    const vs = this.deps.viewState;
    if (vs.activeView !== 'underground') return; // surface RMB no-op
    if (this.deps.isPointerOverHUD(ev.x, ev.y)) return;
    const world = this.deps.getWorld();
    if (!world) return;
    const cam = activeCamera(vs);
    const { tileX, tileY } = screenToTileZoom(ev.x, ev.y, cam);
    tryOpenChamberMenu(world, this.deps.getProjectedWorld(), vs, ev.x, ev.y, tileX, tileY);
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
      wasTouch: pointer.wasTouch,
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
      wasTouch: pointer.wasTouch,
    });
  });
  scene.input.on('pointerup', (pointer: import('phaser').Input.Pointer) => {
    arbiter.onPointerUp({
      pointerId: pointer.id,
      button: pointer.button,
      x: pointer.x,
      y: pointer.y,
      wasTouch: pointer.wasTouch,
    });
  });
  scene.input.on('pointerupoutside', () => {
    arbiter.onPointerUpOutside();
  });

  return arbiter;
}
