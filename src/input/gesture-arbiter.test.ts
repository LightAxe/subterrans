// gesture-arbiter.test.ts — Vitest unit tests for the single left-button gesture
// arbiter core (Stage 1 controls rework, issue #18). Exercises the pure
// GestureArbiter directly with mock deps (no Phaser).
//
// Covers: tap-on-up; drag-then-no-tap; the view×tool drag matrix (pan vs paint);
// cancelGesture on every trigger; snapshot acts on the DOWN tile; the enemy-view
// read-only guard; reconcileContext cancelling on a mid-press tool/view/colony
// change; the right-click chamber path.
//
// Stage 2 controls rework: cameras are world-pixel `CameraView`s (centerX,
// centerY, zoom, targetZoom) instead of tile-based `CameraState`. tileCenter()
// projects a tile to its screen point via the SAME pure adapter math the arbiter
// uses (worldToScreen), so a down/up round-trips to the same tile through
// screenToTileZoom. Pan assertions read centerX/centerY: a screen drag of dx px
// at zoom 1 moves centerX by dx world px (panByScreenDelta: centerX -= dx/zoom),
// NOT dx/16 as in the old tile-camera model.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GestureArbiter,
  LEFT_BUTTON,
  MIDDLE_BUTTON,
  RIGHT_BUTTON,
  type GestureArbiterDeps,
  type ArbiterPointerEvent,
} from './gesture-arbiter.js';
import { panInputState, resetPanInputState } from './camera-input.js';
import { contextMenuState, hideContextMenu } from '../render/context-menu-state.js';
import { CommandProjection } from '../render/command-projection.js';
import { CommandFeedforward } from '../render/command-feedforward.js';
import { createScenario } from '../sim/scenario.js';
import { UndergroundTileState, ugSet } from '../sim/terrain.js';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { makeCameraView, worldToScreen } from '../render/camera-adapter.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import { DRAG_THRESHOLD_PX } from './gesture.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeViewState(
  view: 'surface' | 'underground',
  tool: 'command' | 'dig' | 'chamber',
  // World-pixel camera CENTER. Default frames on tile (10,10): 10 × 16 = 160.
  centerX = 10 * TILE_SIZE_PX,
  centerY = 10 * TILE_SIZE_PX,
): ViewState {
  return {
    activeView: view,
    activeTool: tool,
    surfaceCamera: makeCameraView(centerX, centerY),
    undergroundCamera: makeCameraView(centerX, centerY),
    undergroundVisited: true,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    showPheromoneOverlay: true,
  };
}

// Stage 3a: the arbiter feeds the underground tap/menu handlers a PROJECTED world
// (deps.getProjectedWorld → CommandProjection.get), which deep-clones the live world
// and drains its command queue through the real sim handlers. That requires a REAL
// WorldState, not the former hand-stub — so build from createScenario, then restore the
// stub's CONTROLLED surface (no spider, no food piles) so the surface-tap / spider-hit
// assertions stay deterministic. The scenario's player underground grid is all-Solid by
// default (the entrance shaft is at column 24, away from every coord these tests use)
// and is a fixed 128×64, large enough that the old per-test grid-size knobs are moot.
function makeWorld(): WorldState {
  const world = createScenario(12345, 'Normal');
  world.spider = null; // controlled surface: no spider sprite under any Command tap
  world.foodPiles = []; // controlled surface: no pile under a rally/dig tap
  return world;
}

/**
 * Screen px at the CENTER of a tile, projected through the SAME pure adapter math
 * the arbiter uses (worldToScreen). The tile center in world px is (t+0.5)·16;
 * projecting it and flooring back via screenToTileZoom returns the same tile, so a
 * down/up here resolves to (tileX,tileY) exactly.
 */
function tileCenter(tileX: number, tileY: number, vs: ViewState) {
  const cam = vs.activeView === 'surface' ? vs.surfaceCamera : vs.undergroundCamera;
  const { screenX, screenY } = worldToScreen(
    (tileX + 0.5) * TILE_SIZE_PX,
    (tileY + 0.5) * TILE_SIZE_PX,
    cam,
  );
  return { x: screenX, y: screenY };
}

interface Harness {
  arbiter: GestureArbiter;
  world: WorldState;
  vs: ViewState;
  paused: { value: boolean };
  /** Toggle the world-edit gate (tap / paint / chamber); defaults to allowed. */
  canEditWorld: { value: boolean };
  /** Toggle the pan gate (left-drag camera move); defaults to allowed. */
  canPan: { value: boolean };
  /** Toggle the chamber-context-menu-active gate; defaults to inactive. */
  contextMenuActive: { value: boolean };
  hudHit: (x: number, y: number) => boolean;
  setHudHit: (fn: (x: number, y: number) => boolean) => void;
  pausedFullCount: () => number;
  /** The `paused` argument from the most recent onPausedQueueFull call (Fix 3). */
  lastQueueFullPaused: () => boolean | undefined;
  /** Every `paused` argument passed to onPausedQueueFull, in order (Fix 3). */
  queueFullPausedCalls: () => boolean[];
}

function makeHarness(
  view: 'surface' | 'underground',
  tool: 'command' | 'dig' | 'chamber',
): Harness {
  const world = makeWorld();
  const vs = makeViewState(view, tool);
  const paused = { value: false };
  const canEditWorld = { value: true };
  const canPan = { value: true };
  const contextMenuActive = { value: false };
  let hudHit: (x: number, y: number) => boolean = () => false;
  let pausedFull = 0;
  const queueFullPaused: boolean[] = [];
  const feedforward = new CommandFeedforward();
  const deps: GestureArbiterDeps = {
    getWorld: () => world,
    getPrevWorld: () => null,
    // Stage 3a: a FRESH projection per call, reading the LIVE queue — exactly what the
    // production wiring passes. Empty queue → aliases `world` (the common case here);
    // a non-empty queue (e.g. the paused-cap tests' 64 NoOps) → a drained clone whose
    // underground grid the tap handlers read for mark-vs-cancel + menu eligibility.
    getProjectedWorld: () => new CommandProjection().get(world),
    // Stage 3a: the same trial-apply feedforward the cue uses — the underground taps
    // gate their emit on it (willTakeEffect), so an Open-tile mark / embedded-ant cancel
    // is dropped here rather than enqueued. One shared instance, as the production wiring.
    getFeedforward: () => feedforward,
    viewState: vs,
    isPointerOverHUD: (x, y) => hudHit(x, y),
    isPaused: () => paused.value,
    canEditWorld: () => canEditWorld.value,
    canPan: () => canPan.value,
    isContextMenuActive: () => contextMenuActive.value,
    onPausedQueueFull: (p) => {
      pausedFull++;
      queueFullPaused.push(p);
    },
  };
  const arbiter = new GestureArbiter(deps);
  return {
    arbiter,
    world,
    vs,
    paused,
    canEditWorld,
    canPan,
    contextMenuActive,
    hudHit: (x, y) => hudHit(x, y),
    setHudHit: (fn) => {
      hudHit = fn;
    },
    pausedFullCount: () => pausedFull,
    lastQueueFullPaused: () => queueFullPaused[queueFullPaused.length - 1],
    queueFullPausedCalls: () => queueFullPaused,
  };
}

function ev(button: number, x: number, y: number, pointerId = 1): ArbiterPointerEvent {
  return { pointerId, button, x, y };
}

beforeEach(() => {
  resetPanInputState();
  hideContextMenu();
});

// ---------------------------------------------------------------------------
// Tap vs drag
// ---------------------------------------------------------------------------

describe('tap on up (no threshold crossing)', () => {
  it('underground Dig: down+up on a Solid tile → one MarkDigTile on the DOWN tile', () => {
    const h = makeHarness('underground', 'dig');
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    const marks = h.world.commandQueue.filter((c) => c.type === 'MarkDigTile');
    expect(marks).toHaveLength(1);
    expect([(marks[0] as { tileX: number }).tileX, (marks[0] as { tileY: number }).tileY]).toEqual([
      5, 8,
    ]);
  });

  it('surface Command: tap on empty ground → SetRallyPoint', () => {
    const h = makeHarness('surface', 'command');
    const p = tileCenter(6, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.world.commandQueue.some((c) => c.type === 'SetRallyPoint')).toBe(true);
  });

  it('the tap acts on the DOWN tile even if the pointer drifts within threshold by up', () => {
    const h = makeHarness('underground', 'dig');
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    // Up a few px away but under the threshold — still a tap on (5,8).
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x + DRAG_THRESHOLD_PX, p.y));
    const marks = h.world.commandQueue.filter((c) => c.type === 'MarkDigTile');
    expect(marks).toHaveLength(1);
    expect((marks[0] as { tileX: number }).tileX).toBe(5);
  });
});

describe('drag then no tap', () => {
  it('a pan drag (Command surface) moves the camera and fires NO tap on up', () => {
    const h = makeHarness('surface', 'command');
    const start = tileCenter(10, 10, h.vs);
    const centerXBefore = h.vs.surfaceCamera.centerX;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // crosses threshold → pan
    expect(panInputState.isPanning).toBe(true);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.vs.surfaceCamera.centerX).not.toBe(centerXBefore); // camera panned
    expect(h.world.commandQueue).toHaveLength(0); // no tap command
    expect(panInputState.isPanning).toBe(false); // cleared on up
  });

  it('a paint drag (Dig underground) marks multiple tiles and fires no tap', () => {
    const h = makeHarness('underground', 'dig');
    const start = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    const end = tileCenter(8, 8, h.vs);
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // crosses threshold → paint
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y));
    const marks = h.world.commandQueue.filter((c) => c.type === 'MarkDigTile');
    expect(marks.length).toBeGreaterThan(1);
    // No pan claim was made for a paint drag.
    expect(panInputState.isPanning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flick-pan: the first panMove applies the displacement from the pointer-DOWN
// coords (Fix 1). A quick drag delivered as ONE coalesced move past the
// threshold then pointer-up must actually move the camera by (current − down),
// not 0px. Multi-move drags must then continue incrementally with no first-
// increment loss and no double-count.
//
// Stage 2: pan is world-px. panByScreenDelta moves centerX -= dx/zoom, so at
// zoom 1 a dx-px screen drag moves centerX by dx world px (NOT dx/16). The test
// world is 20×20 but the arbiter clamps against the REAL grid (SURFACE 2048 px
// wide). Center the camera at world (800,480) so a small flick stays inside the
// zoom-1 clamp window [400,1648]×[296,1752] and the assertion is exact.
// ---------------------------------------------------------------------------

describe('flick-pan first-move displacement (Fix 1)', () => {
  it('a single coalesced move past the threshold then up pans by (current − down)', () => {
    const h = makeHarness('surface', 'command');
    h.vs.surfaceCamera.centerX = 800;
    h.vs.surfaceCamera.centerY = 480;
    const downX = 200;
    const downY = 200;
    const flickPx = 48; // 3 tiles; well past the 6px threshold
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, downX, downY));
    // ONE move that both crosses the threshold AND is the whole flick, then up.
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, downX + flickPx, downY));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, downX + flickPx, downY));
    // centerX -= (current − down)/zoom; at zoom 1 that's −flickPx world px. The OLD
    // bug seeded panLast to the current move, making this delta 0 (camera
    // unchanged) — this asserts the fix.
    expect(h.vs.surfaceCamera.centerX).toBeCloseTo(800 - flickPx, 10);
    expect(h.vs.surfaceCamera.centerY).toBeCloseTo(480, 10); // no vertical flick
    expect(panInputState.isPanning).toBe(false); // released on up
  });

  it('the first increment is not lost on a vertical flick either', () => {
    const h = makeHarness('underground', 'command');
    h.vs.undergroundCamera.centerX = 800;
    h.vs.undergroundCamera.centerY = 480;
    const downX = 200;
    const downY = 200;
    const flickPx = 32; // 2 tiles down
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, downX, downY));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, downX, downY + flickPx));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, downX, downY + flickPx));
    expect(h.vs.undergroundCamera.centerX).toBeCloseTo(800, 10);
    expect(h.vs.undergroundCamera.centerY).toBeCloseTo(480 - flickPx, 10);
  });

  it('a multi-move drag pans by the cumulative delta — no first-increment loss, no double-count', () => {
    const h = makeHarness('surface', 'command');
    h.vs.surfaceCamera.centerX = 800;
    h.vs.surfaceCamera.centerY = 480;
    const downX = 200;
    const downY = 200;
    // Three successive moves; total horizontal displacement from DOWN = 96px.
    // The first move both classifies (crosses threshold) and applies (m1 − down).
    const xs = [downX + 16, downX + 48, downX + 96];
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, downX, downY));
    for (const x of xs) h.arbiter.onPointerMove(ev(LEFT_BUTTON, x, downY));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, xs[xs.length - 1]!, downY));
    // Cumulative pan = (last − down)/zoom = 96 world px at zoom 1. If the first
    // increment were lost the total would be 96−16; if double-counted it would
    // exceed 96. Exact equality pins both failure modes.
    expect(h.vs.surfaceCamera.centerX).toBeCloseTo(800 - 96, 10);
    expect(h.vs.surfaceCamera.centerY).toBeCloseTo(480, 10);
  });

  it('intermediate moves each apply their own increment (cumulative == final − down)', () => {
    // Same as above but assert the camera AFTER each move equals the running
    // (x − down) displacement, proving no per-move double-application.
    const h = makeHarness('surface', 'command');
    h.vs.surfaceCamera.centerX = 800;
    h.vs.surfaceCamera.centerY = 480;
    const downX = 200;
    const downY = 200;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, downX, downY));
    const checkpoints = [downX + 8, downX + 24, downX + 40, downX + 64];
    for (const x of checkpoints) {
      h.arbiter.onPointerMove(ev(LEFT_BUTTON, x, downY));
      // centerX -= (x − down)/zoom; at zoom 1 that's −(x − down) world px.
      expect(h.vs.surfaceCamera.centerX).toBeCloseTo(800 - (x - downX), 10);
    }
  });
});

describe('the drag matrix', () => {
  it('Dig + underground drag = paint (no camera move)', () => {
    const h = makeHarness('underground', 'dig');
    const start = tileCenter(5, 8, h.vs);
    const camBefore = h.vs.undergroundCamera.centerX;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.vs.undergroundCamera.centerX).toBe(camBefore); // paint, not pan
    expect(h.world.commandQueue.some((c) => c.type === 'MarkDigTile')).toBe(true);
  });

  it.each([
    ['surface', 'command'],
    ['surface', 'dig'],
    ['underground', 'command'],
    ['underground', 'chamber'],
  ] as const)('%s + %s drag = pan', (view, tool) => {
    const h = makeHarness(view, tool);
    const cam = view === 'surface' ? h.vs.surfaceCamera : h.vs.undergroundCamera;
    const start = tileCenter(10, 10, h.vs);
    const before = cam.centerX;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(cam.centerX).not.toBe(before); // panned
    expect(panInputState.isPanning).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancelGesture triggers
// ---------------------------------------------------------------------------

describe('cancelGesture', () => {
  it('a middle-button down cancels a pending left gesture but leaves isPanning to registerDragPan', () => {
    // Issue #85: registerDragPan's pointerdown fires FIRST on a middle-button
    // down and sets isPanning = true to claim the camera for the middle-drag.
    // The arbiter must cancel its own pending left gesture WITHOUT clearing that
    // flag, or keyboard pan would stack with the middle-drag (the #85 regression).
    const h = makeHarness('surface', 'command');
    const start = tileCenter(10, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // pan claim
    expect(panInputState.isPanning).toBe(true);
    h.arbiter.onPointerDown(ev(MIDDLE_BUTTON, start.x, start.y));
    expect(panInputState.isPanning).toBe(true); // left to registerDragPan
    expect(h.arbiter.hasPendingGesture()).toBe(false);
  });

  it('a RIGHT-button down DURING an active left-drag pan releases isPanning (Fix 2)', () => {
    // The left gesture is itself the active PAN (it set isPanning = true). A
    // right-click has no registerDragPan release handler, so the arbiter MUST
    // release the flag here or keyboard pan stays suppressed (the #85 lock) until
    // another full pan / session reset. clearLeftGesture's ownership-gated release
    // (dragMode==='pan') handles it.
    const h = makeHarness('surface', 'command');
    const start = tileCenter(10, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // left-drag PAN claim
    expect(panInputState.isPanning).toBe(true);
    h.arbiter.onPointerDown(ev(RIGHT_BUTTON, start.x, start.y)); // right-click during the pan
    expect(panInputState.isPanning).toBe(false); // released → keyboard pan re-enabled
    expect(h.arbiter.hasPendingGesture()).toBe(false);
  });

  it('a MIDDLE-button down while NOT left-panning leaves a registerDragPan-set isPanning intact (Fix 2 guard)', () => {
    // Mirror of registerDragPan's claim: the left gesture is NOT panning (no move
    // past threshold → dragMode null), so the arbiter does not own isPanning. A
    // middle-down (registerDragPan already set isPanning = true) must NOT clear it.
    const h = makeHarness('surface', 'command');
    const start = tileCenter(10, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y)); // pending tap, dragMode null
    panInputState.isPanning = true; // registerDragPan's middle-down claim (runs first)
    h.arbiter.onPointerDown(ev(MIDDLE_BUTTON, start.x, start.y));
    expect(panInputState.isPanning).toBe(true); // preserved for the middle-drag
    expect(h.arbiter.hasPendingGesture()).toBe(false);
  });

  it('a RIGHT-button down while NOT left-panning leaves a foreign isPanning intact (Fix 2 guard)', () => {
    // Symmetric guard for right-click: if the left gesture never panned, the
    // arbiter does not own isPanning and must not clear a flag another owner set.
    const h = makeHarness('underground', 'command');
    const start = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y)); // pending tap, dragMode null
    panInputState.isPanning = true; // some other owner's claim
    h.arbiter.onPointerDown(ev(RIGHT_BUTTON, start.x, start.y));
    expect(panInputState.isPanning).toBe(true); // not the arbiter's to clear
  });

  it('pointerupoutside abandons the gesture with no tap', () => {
    const h = makeHarness('underground', 'dig');
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUpOutside();
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    expect(h.world.commandQueue).toHaveLength(0);
  });

  it('reconcileContext cancels a pending paint when the tool changes mid-press', () => {
    const h = makeHarness('underground', 'dig');
    const start = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // paint armed
    // Player presses a tool hotkey mid-stroke.
    h.vs.activeTool = 'command';
    h.arbiter.reconcileContext();
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    expect(h.arbiter.isPainting()).toBe(false);
  });

  it('reconcileContext cancels when the underground colony switches mid-press', () => {
    const h = makeHarness('underground', 'dig');
    const start = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.vs.activeUndergroundColonyId = ENEMY_COLONY_ID;
    h.arbiter.reconcileContext();
    expect(h.arbiter.hasPendingGesture()).toBe(false);
  });

  it('explicit cancelGesture clears a pending tap (no command on a later up)', () => {
    const h = makeHarness('surface', 'command');
    const p = tileCenter(6, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.cancelGesture();
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Enemy-view read-only guard
// ---------------------------------------------------------------------------

describe('enemy-view read-only guard', () => {
  it('a Dig tap on the enemy underground grid emits no command', () => {
    const h = makeHarness('underground', 'dig');
    h.vs.activeUndergroundColonyId = ENEMY_COLONY_ID;
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.world.commandQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HUD guard + right-click
// ---------------------------------------------------------------------------

describe('HUD + right-click', () => {
  it('a left down over HUD never starts a gesture', () => {
    const h = makeHarness('underground', 'dig');
    h.setHudHit(() => true);
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.world.commandQueue).toHaveLength(0);
  });

  it('right-click underground on Solid → requests chamber menu', () => {
    const h = makeHarness('underground', 'command');
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(RIGHT_BUTTON, p.x, p.y));
    expect(contextMenuState.pendingShow).toBe(true);
    expect([contextMenuState.anchorTileX, contextMenuState.anchorTileY]).toEqual([5, 8]);
  });

  it('right-click on the SURFACE is a no-op (no menu)', () => {
    const h = makeHarness('surface', 'command');
    const p = tileCenter(5, 1, h.vs);
    h.arbiter.onPointerDown(ev(RIGHT_BUTTON, p.x, p.y));
    expect(contextMenuState.pendingShow).toBe(false);
  });

  it('right-click chamber menu excludes a Marked tile', () => {
    const h = makeHarness('underground', 'chamber');
    ugSet(h.world.undergroundGrids[PLAYER_COLONY_ID]!, 5, 8, UndergroundTileState.Marked);
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(RIGHT_BUTTON, p.x, p.y));
    expect(contextMenuState.pendingShow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paused-cap surfacing
// ---------------------------------------------------------------------------

describe('paused-queue-full surfacing', () => {
  it('onPausedQueueFull fires when a one-shot tap is dropped at the cap WHILE PAUSED', () => {
    // A down+up with no move is a single Dig TAP (a one-shot), not a paint drag.
    const h = makeHarness('underground', 'dig');
    h.paused.value = true;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y)); // Dig tap dropped at the cap
    expect(h.pausedFullCount()).toBeGreaterThan(0);
    expect(h.lastQueueFullPaused()).toBe(true); // paused drop → "resume" message (Fix 3)
  });

  it('a dropped one-shot tap surfaces the hint even WHILE UNPAUSED (Codex P2)', () => {
    // A one-shot (a single Dig tap here) does NOT re-emit, so a cap drop is a real
    // loss — surface the hint regardless of pause state. (Contrast PAINT, whose
    // unpaused cap hit IS silent because it re-drives from its held cursor on the
    // next move — covered in the fast-stroke deferral block below.) The queue is
    // momentarily full, e.g. right after a big dig-paint burst.
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y)); // Dig tap refused at the cap (unpaused)
    expect(h.pausedFullCount()).toBeGreaterThan(0); // one-shot drop → hint fires
    expect(h.lastQueueFullPaused()).toBe(false); // unpaused drop → "try again" message (Fix 3)
    // The command really was refused (nothing enqueued past the cap).
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0);
  });

  it('a dropped surface Command tap (rally) surfaces the hint WHILE UNPAUSED (Codex P2)', () => {
    // The surface Command tap is another one-shot. Unpaused, a drop at the cap is
    // still a real loss and must flash the hint.
    const h = makeHarness('surface', 'command');
    h.paused.value = false;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(6, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y)); // SetRallyPoint refused at the cap (unpaused)
    expect(h.pausedFullCount()).toBeGreaterThan(0);
    expect(h.lastQueueFullPaused()).toBe(false); // unpaused drop → "try again" (Fix 3)
    expect(h.world.commandQueue.filter((c) => c.type === 'SetRallyPoint')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — accurate queue-full message: the arbiter threads the LIVE pause state
// to onPausedQueueFull so the hint reads "resume to continue" when paused and a
// running-state message when not. (The paused→true / unpaused→false threading is
// also pinned on the existing one-shot tests above; these isolate the contract.)
// ---------------------------------------------------------------------------

describe('queue-full message pause-state threading (Fix 3)', () => {
  it('an UNPAUSED one-shot drop requests the running-state message (paused=false)', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.queueFullPausedCalls()).toEqual([false]);
  });

  it('a PAUSED one-shot drop requests the paused message (paused=true)', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = true;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.queueFullPausedCalls()).toEqual([true]);
  });

  it('a PAUSED paint cap hit requests the paused message (paint hints only while paused)', () => {
    // The paint path (notifyCapHit) fires only while paused and always reports
    // paused=true. An UNPAUSED paint cap hit stays silent (no call) — verified
    // separately in the fast-stroke deferral block.
    const h = makeHarness('underground', 'dig');
    h.paused.value = true;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(8, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // refused at cap while paused
    expect(h.queueFullPausedCalls().length).toBeGreaterThan(0);
    expect(h.queueFullPausedCalls().every((p) => p === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fast-stroke cap deferral: cursor-hold + re-emit on the NEXT move (Fix 1).
//
// The minimal mechanism (no per-frame flush, no post-release drain): a paint move
// that out-runs the MAX_COMMANDS_PER_TICK cap holds the stroke cursor at the last
// enqueued tile. The held tiles re-emit when the NEXT pointermove drives
// continuePaintStroke from that same cursor — by then the sim has drained the
// queue, so the next move has fresh cap budget. A continuous drag therefore loses
// nothing. Release ENDS the stroke (no draining). cancelGesture clears.
// ---------------------------------------------------------------------------

describe('fast-stroke cap deferral (cursor-hold + re-emit on next move)', () => {
  it('a move that out-runs the cap holds the cursor; the NEXT move continues from there', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    // Leave exactly 3 free slots: the begin-tile (1,10) takes one, then the
    // classify→paint move emits 2 more tiles (2,10)+(3,10) before the cap refuses
    // (4,10) — so the cursor is HELD at the real tile (3,10), not the sentinel.
    for (let i = 0; i < 61; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const start = tileCenter(1, 10, h.vs);
    const mid = tileCenter(8, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, mid.x, mid.y)); // classify → paint; caps mid-segment
    const firstMarks = h.world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    expect(firstMarks).toEqual([
      [1, 10],
      [2, 10],
      [3, 10],
    ]); // begin + 2 steps, then the cap held the cursor at (3,10)
    expect(h.pausedFullCount()).toBe(0); // unpaused → silent
    expect(h.arbiter.isPainting()).toBe(true); // stroke live, cursor held at (3,10)

    // Simulate tick() draining the queue, then the player keeps dragging (the
    // NEXT pointermove — this is what re-emits the held tail, NOT a per-frame flush).
    h.world.commandQueue.length = 0;
    const end = tileCenter(10, 10, h.vs);
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y));
    const marks = h.world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    // Continues from the held cursor (3,10): no gap, no duplicate, reaches target.
    expect(marks).toContainEqual([4, 10]); // the tile the cap refused last move
    expect(marks).toContainEqual([10, 10]); // reached the latest target tile
    expect(marks).not.toContainEqual([3, 10]); // already enqueued — not re-emitted
  });

  it('a continuous drag across many moves digs EVERY tile (queue drains between moves)', () => {
    // Wide grid; drag in single-tile steps, draining the queue between each move
    // (one tick per frame). Every stepped tile must be dug exactly once.
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    const startTile = 1;
    const endTile = 90;
    const start = tileCenter(startTile, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    const marks: number[][] = [];
    for (let x = startTile + 1; x <= endTile; x++) {
      const p = tileCenter(x, 10, h.vs);
      h.arbiter.onPointerMove(ev(LEFT_BUTTON, p.x, p.y));
      for (const c of h.world.commandQueue) {
        if (c.type === 'MarkDigTile') {
          marks.push([(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
        }
      }
      h.world.commandQueue.length = 0; // tick() drains between moves
    }
    h.arbiter.onPointerUp(
      ev(LEFT_BUTTON, tileCenter(endTile, 10, h.vs).x, tileCenter(endTile, 10, h.vs).y),
    );
    const xs = marks.map((m) => m[0]).sort((a, b) => a! - b!);
    expect(xs).toEqual(Array.from({ length: 90 }, (_, i) => i + 1)); // 1..90 each once
    expect(h.arbiter.isPainting()).toBe(false); // release ended the stroke
  });

  it('begin: a down-tile refused at the cap leaves the cursor at the sentinel; the stroke still paints once the queue drains', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    // Jam the queue so the eager begin-tile mark (fired on the classify→paint
    // move) is refused at the cap. beginPaintStroke leaves the cursor at the
    // sentinel (-1,-1) so the stroke is not corrupted by a phantom start tile.
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const start = tileCenter(5, 10, h.vs);
    const firstMove = tileCenter(5, 13, h.vs); // crosses threshold; begin-tile (5,10) refused
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, firstMove.x, firstMove.y));
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0); // all refused
    expect(h.arbiter.isPainting()).toBe(true); // stroke armed, cursor at sentinel

    // Drain; the next move from the sentinel emits its target via the single-tile
    // path and the stroke resumes painting normally (it was not left broken by the
    // refused begin). The begin-tile that the cap dropped is the documented
    // accepted residual of a coalesced refusal — what matters is the stroke heals.
    h.world.commandQueue.length = 0;
    const next = tileCenter(5, 13, h.vs);
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, next.x, next.y));
    expect(
      h.world.commandQueue
        .filter((c) => c.type === 'MarkDigTile')
        .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]),
    ).toContainEqual([5, 13]); // stroke resumed and painted the move target

    // And a later move continues 4-connected from there with no gap.
    h.world.commandQueue.length = 0;
    const further = tileCenter(5, 15, h.vs);
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, further.x, further.y));
    const tail = h.world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    expect(tail).toEqual([
      [5, 14],
      [5, 15],
    ]);
  });

  it('paused: a cap refusal on a paint move surfaces the hint', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = true; // bare user-pause: queue never drains
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(8, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // refused at cap while paused → hint
    expect(h.pausedFullCount()).toBeGreaterThan(0);
  });

  it('release ENDS the stroke immediately — no post-release draining', () => {
    // Even when a move out-ran the cap and the tail is held, release clears the
    // stroke. (The minimal design relies on intervening moves, not a drain.)
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(90, 10, h.vs); // single coalesced >64-tile move
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // caps, holds the tail
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y)); // IMMEDIATE release, no intervening move
    // Stroke is fully ended; nothing lingers active to drain on later frames.
    expect(h.arbiter.isPainting()).toBe(false);
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    // Accepted residual: the held tail past the cap is NOT recovered (there is no
    // later move and deliberately no flush). Draining the queue + further input
    // must not resurrect the old stroke.
    h.world.commandQueue.length = 0;
    const tap = tileCenter(3, 5, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, tap.x, tap.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, tap.x, tap.y)); // a fresh, independent tap
    const marks = h.world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    expect(marks).toEqual([[3, 5]]); // only the new tap; the old stroke did not resume
  });

  it('cancelGesture mid-stroke clears the paint — a later move does not resume it', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    const start = tileCenter(1, 10, h.vs);
    const mid = tileCenter(5, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, mid.x, mid.y)); // paint a few tiles
    expect(h.arbiter.isPainting()).toBe(true);

    // A modal opens / view switches mid-stroke → cancelGesture abandons.
    h.arbiter.cancelGesture();
    expect(h.arbiter.isPainting()).toBe(false);
    expect(h.arbiter.hasPendingGesture()).toBe(false);

    // A stray pointermove with no live snapshot must emit nothing.
    h.world.commandQueue.length = 0;
    const stray = tileCenter(9, 10, h.vs);
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, stray.x, stray.y));
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// World-edit gate vs pan gate (bare user-pause): edits queue, pan still works
// ---------------------------------------------------------------------------

describe('canEditWorld / canPan split', () => {
  // The real wiring during a bare user-pause: pan allowed, edits allowed (they
  // queue via the paused cap). A modal (Esc menu pause / SavePrompt / GameOver)
  // sets BOTH canEditWorld AND canPan false — GameScene wires both to
  // !isModalOpen(), so they move together; a bare user-pause is not a modal, so
  // both stay true. (These arbiter-layer tests inject canPan/canEditWorld
  // directly, so they pin the arbiter's response to each combination regardless
  // of how GameScene derives the two flags.)

  it('paused (edits allowed): a Dig tap still queues a MarkDigTile', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = true; // canEditWorld stays true (bare user-pause)
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(1);
  });

  it('canEditWorld false (e.g. menu pause): a tap fires NO command', () => {
    const h = makeHarness('underground', 'dig');
    h.canEditWorld.value = false;
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y));
    expect(h.world.commandQueue).toHaveLength(0);
  });

  it('canEditWorld false but canPan true: left-drag pan still moves the camera', () => {
    // The finding-2 case: bare-user-pause look-around must not be dead. Even with
    // world edits blocked, a left-drag still pans.
    const h = makeHarness('surface', 'command');
    h.canEditWorld.value = false;
    h.canPan.value = true;
    const start = tileCenter(10, 10, h.vs);
    const centerXBefore = h.vs.surfaceCamera.centerX;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // crosses threshold → pan
    expect(panInputState.isPanning).toBe(true);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.vs.surfaceCamera.centerX).not.toBe(centerXBefore);
    expect(h.world.commandQueue).toHaveLength(0);
  });

  it('canPan false (GameOver): a left-drag does NOT move the camera', () => {
    const h = makeHarness('surface', 'command');
    h.canPan.value = false;
    h.canEditWorld.value = false; // GameOver blocks both
    const start = tileCenter(10, 10, h.vs);
    const centerXBefore = h.vs.surfaceCamera.centerX;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(panInputState.isPanning).toBe(false);
    expect(h.vs.surfaceCamera.centerX).toBe(centerXBefore);
  });

  it('canEditWorld false: an underground-Dig paint drag paints nothing', () => {
    const h = makeHarness('underground', 'dig');
    h.canEditWorld.value = false;
    const start = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // would classify as paint
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.world.commandQueue).toHaveLength(0);
    expect(h.arbiter.isPainting()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #237 PR1 — two-pointer transition table
//
// The arbiter tracks up to two button-0 (touch) pointers through an
// idle → single → pinch → single state machine. PR1 only wires the state
// bookkeeping (which finger owns the gesture, when a tap is / isn't emitted,
// and the load-bearing pan-ownership handoff); the actual pinch-zoom camera
// math lands in PR2. These tests pin the transitions by their OBSERVABLE
// effects — hasPendingGesture() (a single is armed), panInputState.isPanning
// (pan ownership), and world.commandQueue (a tap fired) — since mode/pointers
// are private. Two fingers are distinct pointerIds on the same LEFT_BUTTON.
// ---------------------------------------------------------------------------

describe('#237 PR1 — two-pointer transition table', () => {
  it('idle→single→pinch→single: a 2nd finger clears the single; lifting one re-arms the survivor', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 1, h.vs);
    const f2 = tileCenter(10, 1, h.vs);
    // idle → single
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
    // single → pinch: the single snapshot is cleared (no pending tap while pinching)
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2));
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    // pinch → single: lifting finger 1 re-snapshots the survivor (finger 2)
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
  });

  it('a re-down of the SAME finger while single does NOT enter pinch', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    // Same pointerId down again → ignored; still a live single (not pinch).
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
    // Lifting it taps (proves it stayed 'single', not 'pinch' which emits no tap).
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.world.commandQueue.some((c) => c.type === 'SetRallyPoint')).toBe(true);
  });

  it('lifting a pinch finger emits NO tap (pinch fingers are not taps)', () => {
    const h = makeHarness('surface', 'command'); // a surface tap would enqueue SetRallyPoint
    const f1 = tileCenter(6, 1, h.vs);
    const f2 = tileCenter(10, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2)); // → pinch
    const before = h.world.commandQueue.length;
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f1.x, f1.y, 1)); // lift a pinch finger
    expect(h.world.commandQueue.length).toBe(before); // no tap enqueued
  });

  it('entering pinch from a live left-drag pan RELEASES the pan claim (#85 ownership protocol)', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 4, h.vs);
    const f2 = tileCenter(12, 4, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, f1.x + 40, f1.y, 1)); // cross threshold → pan
    expect(panInputState.isPanning).toBe(true);
    // 2nd finger → pinch. The handoff MUST go through cancelGesture (ownership-gated)
    // so the live pan's isPanning claim is dropped — else keyboard pan stays locked.
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2));
    expect(panInputState.isPanning).toBe(false);
  });

  it('a 3rd finger during pinch is ignored and does not disturb the two tracked fingers', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 1, h.vs);
    const f2 = tileCenter(10, 1, h.vs);
    const f3 = tileCenter(14, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2)); // → pinch
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f3.x, f3.y, 3)); // 3rd → ignored (untracked)
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f3.x, f3.y, 3)); // untracked up → ignored
    expect(h.arbiter.hasPendingGesture()).toBe(false); // still pinch, undisturbed
    // Lifting a REAL pinch finger still re-arms the survivor → proves f1/f2 intact.
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f2.x, f2.y, 2));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
  });

  it('onPointerUpOutside abandons a pinch: releases the pan claim, clears pointers, re-idles', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 4, h.vs);
    const f2 = tileCenter(12, 4, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, f1.x + 40, f1.y, 1)); // pan
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2)); // → pinch (releases pan)
    h.arbiter.onPointerUpOutside();
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    expect(panInputState.isPanning).toBe(false);
    // A fresh single works after the reset — the arbiter is not stranded in 'pinch'.
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
  });

  it('a full two-finger pinch that lifts BOTH fingers returns to idle (no residual tap)', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 1, h.vs);
    const f2 = tileCenter(10, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2)); // → pinch
    const before = h.world.commandQueue.length;
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f1.x, f1.y, 1)); // → survivor f2 single (no tap)
    // Lifting the survivor with no intervening move IS a tap on its snapshot tile —
    // that's the survivor behaving as a real single, which is correct. Assert only
    // that the FIRST lift (the pinch finger) emitted nothing.
    expect(h.world.commandQueue.length).toBe(before);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f2.x, f2.y, 2)); // survivor up → back to idle
    expect(h.arbiter.hasPendingGesture()).toBe(false);
  });

  // --- Codex-review regressions (abandon paths must reset the two-pointer
  // bookkeeping, or the NEXT down mis-routes; the invariant is
  // `mode==='single' ⇒ single!==null`). ------------------------------------

  it('reconcileContext during a pinch abandons it: the fingers lift with no tap, then a fresh tap works once (F1)', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 1, h.vs);
    const f2 = tileCenter(10, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f2.x, f2.y, 2)); // → pinch
    // A keyboard tool switch lands mid-pinch; the per-frame reconcile aborts it.
    h.vs.activeTool = 'dig';
    h.arbiter.reconcileContext();
    const before = h.world.commandQueue.length;
    // Teeth: lifting one finger must NOT re-arm the survivor as a single. Pre-fix
    // the reconcile stranded mode='pinch' with both pointers, so this up re-armed
    // finger 2 (hasPendingGesture → true) and its later lift could tap. Post-fix
    // the pinch is fully reset, so the lift is a no-op against an idle arbiter.
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.arbiter.hasPendingGesture()).toBe(false); // survivor NOT re-armed
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f2.x, f2.y, 2));
    expect(h.world.commandQueue.length).toBe(before); // neither lift emitted a tap
    // Settle the context back and prove a fresh single taps exactly once.
    h.vs.activeTool = 'command';
    h.arbiter.reconcileContext();
    const tap = tileCenter(7, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, tap.x, tap.y, 1));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, tap.x, tap.y, 1));
    expect(h.world.commandQueue.filter((c) => c.type === 'SetRallyPoint')).toHaveLength(1);
  });

  it('cancelGesture during a single (matching pointerup LOST), then a fresh same-finger tap fires once — not swallowed (F2)', () => {
    const h = makeHarness('surface', 'command');
    const f1 = tileCenter(6, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    // A blur / tool-select cancels the gesture; the matching pointerup never arrives.
    h.arbiter.cancelGesture();
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    // A fresh press of the SAME pointerId must arm a NEW single (idle→single), not
    // fall through the stale mode==='single' path into the 2nd-finger pinch branch.
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, f1.x, f1.y, 1));
    expect(h.world.commandQueue.filter((c) => c.type === 'SetRallyPoint')).toHaveLength(1);
  });

  it('a mid-drag pan-bail (canPan→false) resets tracking so a later fresh tap fires once (F2)', () => {
    const h = makeHarness('surface', 'command');
    const start = tileCenter(6, 4, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y, 1));
    h.canPan.value = false; // the pan gate flips off before the drag classifies
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y, 1)); // classify=pan → bail
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    expect(panInputState.isPanning).toBe(false); // never claimed
    // The bail must have reset the two-pointer bookkeeping to idle; a fresh press
    // (same id) therefore arms a clean single and taps once.
    h.canPan.value = true;
    const tap = tileCenter(7, 1, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, tap.x, tap.y, 1));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, tap.x, tap.y, 1));
    expect(h.world.commandQueue.filter((c) => c.type === 'SetRallyPoint')).toHaveLength(1);
  });

  it('a mid-drag paint-bail (canEditWorld→false) resets tracking so a later fresh dig tap marks once (F2 paint twin)', () => {
    const h = makeHarness('underground', 'dig'); // underground+Dig → a drag classifies as paint
    h.canEditWorld.value = false;
    const start = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y, 1));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y, 1)); // classify=paint → bail
    expect(h.arbiter.hasPendingGesture()).toBe(false);
    expect(h.arbiter.isPainting()).toBe(false);
    // The bail reset the two-pointer bookkeeping; a fresh dig tap now marks once.
    h.canEditWorld.value = true;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y, 1));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x, start.y, 1));
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(1);
  });

  it('a pinch survivor over the HUD is NOT re-armed as a world tap (idle guards re-applied on re-snapshot) (Codex #271)', () => {
    const h = makeHarness('surface', 'command');
    const worldPt = tileCenter(6, 1, h.vs);
    const hudPt = { x: 4, y: 4 };
    // Only finger 2's location reads as HUD. The 2nd-finger→pinch handoff does NOT
    // HUD-guard, so finger 2 is tracked; the guard must bite on the survivor lift.
    h.setHudHit((x, y) => x === hudPt.x && y === hudPt.y);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, worldPt.x, worldPt.y, 1)); // finger 1: world single
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, hudPt.x, hudPt.y, 2)); // finger 2 on HUD → pinch
    const before = h.world.commandQueue.length;
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, worldPt.x, worldPt.y, 1)); // lift world finger → survivor = HUD finger
    expect(h.arbiter.hasPendingGesture()).toBe(false); // survivor over HUD → dropped, not re-armed
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, hudPt.x, hudPt.y, 2)); // lift the HUD finger
    expect(h.world.commandQueue.length).toBe(before); // no world tap from HUD coordinates
  });
});

// ---------------------------------------------------------------------------
// #237 PR2 — the arbiter drives the pinch zoom on the active camera. (The pinch
// math itself is unit-tested in camera-adapter.test.ts; here we assert the
// arbiter wires two-finger geometry into beginPinch/applyPinch + clears it.)
// ---------------------------------------------------------------------------

describe('#237 PR2 — pinch zoom drive', () => {
  it('spreading two fingers apart zooms the active camera IN, driving zoom directly (no lerp)', () => {
    const h = makeHarness('surface', 'command');
    const cam = h.vs.surfaceCamera;
    cam.zoom = cam.targetZoom = 1; // known mid-range start
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, 350, 300, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, 450, 300, 2)); // enter pinch (dist 100)
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, 300, 300, 1)); // dist 150
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, 500, 300, 2)); // dist 200 → 2×
    expect(cam.zoom).toBeGreaterThan(1);
    expect(cam.zoom).toBe(cam.targetZoom); // zoom===targetZoom → tickZoomLerp is a no-op
  });

  it('a two-finger drag ending at the same spread pans the camera (net zoom unchanged, center shifts)', () => {
    const h = makeHarness('surface', 'command');
    const cam = h.vs.surfaceCamera;
    // Seat the camera well inside the world so clampCameraView is a no-op and the
    // raw pan shift is observable (the default harness center hugs an edge).
    cam.zoom = cam.targetZoom = 1;
    cam.centerX = 1000;
    cam.centerY = 500;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, 350, 300, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, 450, 300, 2)); // dist 100
    // Slide both fingers +60px right (final spread back to 100) → net pan, no net zoom.
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, 410, 300, 1));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, 510, 300, 2));
    expect(cam.zoom).toBeCloseTo(1, 6); // final spread == start spread → no net zoom
    expect(cam.centerX).toBeCloseTo(940, 6); // 1000 − 60: content followed the fingers
  });

  it('lifting one pinch finger ends the zoom drive — a later single-finger move pans, not zooms', () => {
    const h = makeHarness('surface', 'command');
    const cam = h.vs.surfaceCamera;
    cam.zoom = cam.targetZoom = 1;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, 350, 300, 1));
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, 450, 300, 2)); // pinch
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, 300, 300, 1)); // zoom in
    const zoomedIn = cam.zoom;
    expect(zoomedIn).toBeGreaterThan(1);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, 450, 300, 2)); // lift finger 2 → survivor finger 1 becomes a single
    // A single-finger drag now pans; it must NOT keep driving the (ended) pinch zoom.
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, 340, 300, 1)); // 40px from re-snapshot (300) → crosses threshold → pan
    expect(cam.zoom).toBe(zoomedIn); // zoom frozen at the pinch's last value
    expect(panInputState.isPanning).toBe(true); // it resolved as a pan
  });
});
