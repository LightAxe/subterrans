// gesture-arbiter.test.ts — Vitest unit tests for the single left-button gesture
// arbiter core (Stage 1 controls rework, issue #18). Exercises the pure
// GestureArbiter directly with mock deps (no Phaser).
//
// Covers: tap-on-up; drag-then-no-tap; the view×tool drag matrix (pan vs paint);
// cancelGesture on every trigger; snapshot acts on the DOWN tile; the enemy-view
// read-only guard; reconcileContext cancelling on a mid-press tool/view/colony
// change; the right-click chamber path.

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
import { UndergroundTileState, ugSet, createUndergroundGrid } from '../sim/terrain.js';
import type { WorldState } from '../sim/types.js';
import type { ViewState } from '../render/camera.js';
import { VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES } from '../render/camera.js';
import { TILE_SIZE_PX } from '../render/sprites.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import { DRAG_THRESHOLD_PX } from './gesture.js';
import type { SimCommand } from '../sim/commands.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeViewState(
  view: 'surface' | 'underground',
  tool: 'command' | 'dig' | 'chamber',
  camX = 10,
  camY = 10,
): ViewState {
  return {
    activeView: view,
    activeTool: tool,
    surfaceCamera: {
      x: camX,
      y: camY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundCamera: {
      x: camX,
      y: camY,
      viewportWidth: VIEWPORT_WIDTH_TILES,
      viewportHeight: VIEWPORT_HEIGHT_TILES,
    },
    undergroundVisited: true,
    activeUndergroundColonyId: PLAYER_COLONY_ID,
    showPheromoneOverlay: true,
  };
}

function makeWorld(gridW = 20, gridH = 20): WorldState {
  return {
    tick: 0,
    commandQueue: [] as SimCommand[],
    colonies: {
      [PLAYER_COLONY_ID]: { colonyId: PLAYER_COLONY_ID, entrances: [], rallyPoint: null },
    },
    surface: { data: new Uint8Array(gridW * gridH), width: gridW, height: gridH },
    bakedSurfaceEffect: new Uint8Array(gridW * gridH),
    surfaceComponentMask: null,
    undergroundGrids: { [PLAYER_COLONY_ID]: createUndergroundGrid(gridW, gridH) },
    foodPiles: [],
    spider: null,
    spiderPriorityColonyId: null,
  } as unknown as WorldState;
}

/** Screen px at the CENTER of a tile, mirroring the renderer's integer snap. */
function tileCenter(tileX: number, tileY: number, vs: ViewState) {
  const cam = vs.activeView === 'surface' ? vs.surfaceCamera : vs.undergroundCamera;
  const left = Math.floor(cam.x - cam.viewportWidth / 2);
  const top = Math.floor(cam.y - cam.viewportHeight / 2);
  return { x: (tileX - left) * TILE_SIZE_PX + 1, y: (tileY - top) * TILE_SIZE_PX + 1 };
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
}

function makeHarness(
  view: 'surface' | 'underground',
  tool: 'command' | 'dig' | 'chamber',
  gridW = 20,
  gridH = 20,
): Harness {
  const world = makeWorld(gridW, gridH);
  const vs = makeViewState(view, tool);
  const paused = { value: false };
  const canEditWorld = { value: true };
  const canPan = { value: true };
  const contextMenuActive = { value: false };
  let hudHit: (x: number, y: number) => boolean = () => false;
  let pausedFull = 0;
  const deps: GestureArbiterDeps = {
    getWorld: () => world,
    getPrevWorld: () => null,
    viewState: vs,
    isPointerOverHUD: (x, y) => hudHit(x, y),
    isPaused: () => paused.value,
    canEditWorld: () => canEditWorld.value,
    canPan: () => canPan.value,
    isContextMenuActive: () => contextMenuActive.value,
    onPausedQueueFull: () => {
      pausedFull++;
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
    const camXBefore = h.vs.surfaceCamera.x;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // crosses threshold → pan
    expect(panInputState.isPanning).toBe(true);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.vs.surfaceCamera.x).not.toBe(camXBefore); // camera panned
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

describe('the drag matrix', () => {
  it('Dig + underground drag = paint (no camera move)', () => {
    const h = makeHarness('underground', 'dig');
    const start = tileCenter(5, 8, h.vs);
    const camBefore = h.vs.undergroundCamera.x;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.vs.undergroundCamera.x).toBe(camBefore); // paint, not pan
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
    const before = cam.x;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(cam.x).not.toBe(before); // panned
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
  it('onPausedQueueFull fires when a paint tap is dropped at the cap WHILE PAUSED', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = true;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y)); // Dig tap dropped at the cap
    expect(h.pausedFullCount()).toBeGreaterThan(0);
  });

  it('an UNPAUSED cap hit is SILENT — no hint (transient throttling)', () => {
    // Same overflow, but running: the queue drains each tick and the deferred
    // tiles re-emit on the next flush, so the hint must NOT fire.
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y)); // Dig tap refused at the cap (unpaused)
    expect(h.pausedFullCount()).toBe(0);
    // The command really was refused (nothing enqueued past the cap).
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fast-stroke deferral + per-frame flushPaint (Fix 1)
// ---------------------------------------------------------------------------

describe('flushPaint drains the deferred tail', () => {
  it('a paint move that out-runs the cap holds the cursor; a later flush re-emits', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    // Fill the queue to the cap so EVERY mark this stroke emits is refused.
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const start = tileCenter(5, 8, h.vs);
    const end = tileCenter(8, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // classify → paint; all marks refused
    // Nothing got through (queue still exactly the 64 NoOps); silent (unpaused).
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0);
    expect(h.pausedFullCount()).toBe(0);
    expect(h.arbiter.isPainting()).toBe(true); // stroke still live, cursor held

    // Simulate tick() draining the queue, then the per-frame flush.
    h.world.commandQueue.length = 0;
    h.arbiter.flushPaint(h.world, false);
    const marks = h.world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    // The deferred tiles (5,8)..(8,8) now emit toward the stored target.
    expect(marks.length).toBeGreaterThan(0);
    expect(marks).toContainEqual([8, 8]); // reached the target tile
  });

  it('flushPaint is a no-op when no paint stroke is active', () => {
    const h = makeHarness('underground', 'dig');
    h.arbiter.flushPaint(h.world, false);
    expect(h.world.commandQueue).toHaveLength(0);
  });

  it('flushPaint itself surfaces the hint on a paused cap refusal during drain', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = true;
    const start = tileCenter(5, 8, h.vs);
    const end = tileCenter(8, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // paint a few tiles while paused
    // Jam the queue, then move the target further so the cursor can't reach it.
    while (h.world.commandQueue.length < 64)
      h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: 0 });
    const far = tileCenter(12, 8, h.vs);
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, far.x, far.y)); // records target, refused at cap (fires hint)
    // Capture the count AFTER the move so the next assertion isolates flushPaint.
    const afterMove = h.pausedFullCount();
    h.arbiter.flushPaint(h.world, true); // still capped, target unreached → flushPaint fires the hint
    expect(h.pausedFullCount()).toBeGreaterThan(afterMove);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: the deferred-paint drain OUTLIVES the gesture. On pointerup of a paint
// stroke whose cursor has not reached the target, the arbiter enters a "draining"
// state — the stored stroke + target persist and the per-frame flushPaint keeps
// draining toward the target across ticks (and across pause→resume) until every
// tile is dug, THEN clears. cancelGesture ABANDONS (clear immediately). A new
// pointerdown supersedes a still-draining stroke.
// ---------------------------------------------------------------------------

describe('deferred-paint drain outlives the gesture (Fix 1)', () => {
  /** Drain the queue and flush until the stroke finishes (or a tick budget runs out). */
  function drainToCompletion(h: Harness, paused: boolean, marks: number[][]): void {
    for (let i = 0; i < 20 && h.arbiter.isPainting(); i++) {
      // Collect this frame's marks, then simulate tick() draining the queue.
      for (const c of h.world.commandQueue) {
        if (c.type === 'MarkDigTile') {
          marks.push([(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
        }
      }
      h.world.commandQueue.length = 0;
      h.arbiter.flushPaint(h.world, paused);
    }
    // Capture the final partial frame (the flush that finished the stroke).
    for (const c of h.world.commandQueue) {
      if (c.type === 'MarkDigTile') {
        marks.push([(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
      }
    }
  }

  it('a >64-tile stroke released before the queue drains digs EVERY tile (no loss)', () => {
    // Wide grid so a single straight stroke spans far more than the 64/tick cap.
    const h = makeHarness('underground', 'dig', 100, 20);
    h.paused.value = false;
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(90, 10, h.vs); // 90 new tiles → well past the cap
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // classify → paint; caps at 64, holds
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(64);

    // Release with the queue STILL FULL (the tick hasn't drained it yet) — the
    // cursor is parked mid-stroke, so the pointerup flush can't finish and the
    // stroke must hand off to the per-frame drain.
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y));
    expect(h.arbiter.hasPendingGesture()).toBe(false); // gesture over for new input
    expect(h.arbiter.isPainting()).toBe(true); // but still draining the tail

    const marks: number[][] = [];
    drainToCompletion(h, false, marks);

    // Every tile x=1..90 dug exactly once — the tail was NOT lost on release.
    const xs = marks.map((m) => m[0]).sort((a, b) => a! - b!);
    expect(xs).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    // Drain finished → stroke cleared.
    expect(h.arbiter.isPainting()).toBe(false);
  });

  it('a PAUSED >64-tile stroke released then resumed digs all tiles', () => {
    const h = makeHarness('underground', 'dig', 100, 20);
    h.paused.value = true; // bare user-pause: edits queue, sim frozen
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(90, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // 64 queued, rest held (paused)
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(64);

    // Release while still paused — the target must survive so resume can finish it.
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y));
    expect(h.arbiter.isPainting()).toBe(true); // draining, target preserved

    // While paused the sim never ticks → the queue never drains, so it stays at
    // the cap and a flush makes NO progress. The stroke must remain held (the
    // deferred tail must not be discarded just because frames pass while paused).
    h.arbiter.flushPaint(h.world, true);
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(64); // unchanged
    expect(h.arbiter.isPainting()).toBe(true);

    // Resume: now ticks drain the queue each frame and the deferred tail emits
    // until every tile is dug.
    h.paused.value = false;
    const marks: number[][] = [];
    drainToCompletion(h, false, marks);
    const xs = marks.map((m) => m[0]).sort((a, b) => a! - b!);
    expect(xs).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    expect(h.arbiter.isPainting()).toBe(false);
  });

  it('a small stroke whose cursor already reached the target clears immediately on up (no draining)', () => {
    const h = makeHarness('underground', 'dig');
    h.paused.value = false;
    const start = tileCenter(5, 8, h.vs);
    const end = tileCenter(8, 8, h.vs); // few tiles, well under the cap
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y));
    // Cursor reached the target during the stroke → no leftover drain.
    expect(h.arbiter.isPainting()).toBe(false);
    expect(h.arbiter.hasPendingGesture()).toBe(false);
  });

  it('cancelGesture mid-stroke ABANDONS the paint — no further tiles drain', () => {
    const h = makeHarness('underground', 'dig', 100, 20);
    h.paused.value = false;
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(90, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y)); // caps at 64, holds, would defer the rest

    // A modal opens / view switches mid-stroke → cancelGesture abandons.
    h.arbiter.cancelGesture();
    expect(h.arbiter.isPainting()).toBe(false);
    expect(h.arbiter.hasPendingGesture()).toBe(false);

    // Drain the queue and flush repeatedly — NOTHING more should emit.
    h.world.commandQueue.length = 0;
    for (let i = 0; i < 5; i++) h.arbiter.flushPaint(h.world, false);
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0);
  });

  it('cancelGesture ABANDONS a stroke that is already in the draining state', () => {
    const h = makeHarness('underground', 'dig', 100, 20);
    h.paused.value = false;
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(90, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y)); // → draining
    expect(h.arbiter.isPainting()).toBe(true);

    h.arbiter.cancelGesture(); // e.g. blur / colony switch during the drain
    expect(h.arbiter.isPainting()).toBe(false);
    h.world.commandQueue.length = 0;
    for (let i = 0; i < 5; i++) h.arbiter.flushPaint(h.world, false);
    expect(h.world.commandQueue.filter((c) => c.type === 'MarkDigTile')).toHaveLength(0);
  });

  it('a new pointerdown SUPERSEDES a still-draining stroke (fresh gesture, old target dropped)', () => {
    const h = makeHarness('underground', 'dig', 100, 20);
    h.paused.value = false;
    const start = tileCenter(1, 10, h.vs);
    const end = tileCenter(90, 10, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, end.x, end.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, end.x, end.y)); // → draining toward (90,10)
    expect(h.arbiter.isPainting()).toBe(true);

    // A brand-new press elsewhere: the draining stroke is cleared, a fresh tap is
    // armed. A quick down+up taps the new tile only — the old (90,10) target is
    // gone, so a later flush does not resume it.
    h.world.commandQueue.length = 0;
    const tap = tileCenter(3, 5, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, tap.x, tap.y));
    expect(h.arbiter.hasPendingGesture()).toBe(true);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, tap.x, tap.y)); // tap → one mark on (3,5)
    h.arbiter.flushPaint(h.world, false); // old drain must NOT resume
    const marks = h.world.commandQueue
      .filter((c) => c.type === 'MarkDigTile')
      .map((c) => [(c as { tileX: number }).tileX, (c as { tileY: number }).tileY]);
    expect(marks).toEqual([[3, 5]]);
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
    const camXBefore = h.vs.surfaceCamera.x;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y)); // crosses threshold → pan
    expect(panInputState.isPanning).toBe(true);
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(h.vs.surfaceCamera.x).not.toBe(camXBefore);
    expect(h.world.commandQueue).toHaveLength(0);
  });

  it('canPan false (GameOver): a left-drag does NOT move the camera', () => {
    const h = makeHarness('surface', 'command');
    h.canPan.value = false;
    h.canEditWorld.value = false; // GameOver blocks both
    const start = tileCenter(10, 10, h.vs);
    const camXBefore = h.vs.surfaceCamera.x;
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, start.x, start.y));
    h.arbiter.onPointerMove(ev(LEFT_BUTTON, start.x + 40, start.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, start.x + 40, start.y));
    expect(panInputState.isPanning).toBe(false);
    expect(h.vs.surfaceCamera.x).toBe(camXBefore);
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
