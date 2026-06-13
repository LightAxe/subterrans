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
  it('onPausedQueueFull fires when a one-shot tap is dropped at the cap WHILE PAUSED', () => {
    // A down+up with no move is a single Dig TAP (a one-shot), not a paint drag.
    const h = makeHarness('underground', 'dig');
    h.paused.value = true;
    for (let i = 0; i < 64; i++) h.world.commandQueue.push({ type: 'NoOp', issuedAtTick: i });
    const p = tileCenter(5, 8, h.vs);
    h.arbiter.onPointerDown(ev(LEFT_BUTTON, p.x, p.y));
    h.arbiter.onPointerUp(ev(LEFT_BUTTON, p.x, p.y)); // Dig tap dropped at the cap
    expect(h.pausedFullCount()).toBeGreaterThan(0);
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
    expect(h.world.commandQueue.filter((c) => c.type === 'SetRallyPoint')).toHaveLength(0);
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
    const h = makeHarness('underground', 'dig', 100, 20);
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
    const h = makeHarness('underground', 'dig', 100, 20);
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
    const h = makeHarness('underground', 'dig', 100, 20);
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
    const h = makeHarness('underground', 'dig', 100, 20);
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
    const h = makeHarness('underground', 'dig', 100, 20);
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
    const h = makeHarness('underground', 'dig', 100, 20);
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
