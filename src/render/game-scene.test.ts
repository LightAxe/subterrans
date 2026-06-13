// game-scene.test.ts — unit tests for pure-logic helpers extracted from GameScene.
//
// Scope: pure functions only (no Phaser scene booting).
// Phaser-coupled integration (boot flow, overlay triggers, keyboard) is covered by Plan 07 Playwright.
//
// Helpers under test (all exported from game-scene.ts):
//   - decideBootMode(hasSaveFn): 'prompt' | 'fresh'
//   - deriveAIColonyIds(world, playerColonyId): ColonyId[]
//   - appendInputLog(log, cmds): void
//   - generateFreshSeed(nowMs): number

import { describe, it, expect } from 'vitest';
import {
  decideBootMode,
  deriveAIColonyIds,
  appendInputLog,
  resetInputLog,
  generateFreshSeed,
  GamePhase,
  canArbiterPan,
  resolveCursorTool,
  cursorToolChanged,
  type CursorTool,
} from './game-scene-logic.js';
import {
  createViewState,
  resetViewState,
  toggleView,
  UNDERGROUND_INITIAL_CAMERA_Y,
} from './camera.js';
import { resetPaintStrokeState, type PaintStrokeState } from '../input/underground-input.js';
import {
  panInputState,
  resetPanInputState,
  resetDragState,
  type DragState,
} from '../input/camera-input.js';
import { clearAllPauseReasons, type PauseReasonState } from './pause-reasons.js';
import { contextMenuState, hideContextMenu } from './context-menu-state.js';
import { PLAYER_START_X, PLAYER_START_Y } from '../sim/constants.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import type { SimCommand } from '../sim/commands.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WorldState-like object with a given colonies plain object. */
function makeWorldWithColonies(coloniesObj: Record<number, object>): WorldState {
  return {
    tick: 0,
    rngState: 0,
    nextEntityId: 0,
    commandQueue: [],
    ants: {
      posX: new Int32Array(0),
      posY: new Int32Array(0),
      colonyId: new Int32Array(0),
      task: new Int32Array(0),
      subTask: new Int32Array(0),
      speed: new Int32Array(0),
      foodCarrying: new Int32Array(0),
      starvationTimer: new Int32Array(0),
      age: new Int32Array(0),
      alive: new Int32Array(0),
      lifespan: new Int32Array(0),
      zone: new Int32Array(0),
      digTileX: new Int32Array(0),
      digTileY: new Int32Array(0),
      digTicksRemaining: new Int32Array(0),
      targetPosX: new Int32Array(0),
      targetPosY: new Int32Array(0),
    },
    colonies: coloniesObj as WorldState['colonies'],
    pheromoneGrids: {},
    surface: { data: new Uint8Array(0), width: 0, height: 0 },
    undergroundGrids: {},
    foodPiles: [],
    pendingChambers: {},
  } as unknown as WorldState;
}

// ---------------------------------------------------------------------------
// GamePhase object-const
// ---------------------------------------------------------------------------

describe('GamePhase object-const', () => {
  it('has exactly 4 states: Playing, Paused, GameOver, SavePrompt', () => {
    expect(GamePhase.Playing).toBeDefined();
    expect(GamePhase.Paused).toBeDefined();
    expect(GamePhase.GameOver).toBeDefined();
    expect(GamePhase.SavePrompt).toBeDefined();
  });

  it('values are all distinct numbers', () => {
    const values = Object.values(GamePhase);
    const unique = new Set(values);
    expect(unique.size).toBe(4);
    for (const v of values) {
      expect(typeof v).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// canArbiterPan — left-drag pan gate (advisory fix: block behind modal/menu)
// ---------------------------------------------------------------------------

describe('canArbiterPan', () => {
  // The gate is the negation of isModalOpen(). isModalOpen() is FALSE while
  // Playing and during a bare user-pause, and TRUE for GameOver/SavePrompt/menu.
  it('allows pan when no modal is open (Playing or bare user-pause)', () => {
    // isModalOpen=false covers both Playing and a bare 'user'-only pause.
    expect(canArbiterPan(false)).toBe(true);
  });

  it('blocks pan when a modal owns input (Esc menu / SavePrompt / GameOver)', () => {
    // isModalOpen=true is the GameOver || SavePrompt || pauseReasons.menu set.
    expect(canArbiterPan(true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveCursorTool — tool cursor over chrome / during pause (advisory fix)
// ---------------------------------------------------------------------------

describe('resolveCursorTool', () => {
  function cursorDeps(
    overrides: Partial<Parameters<typeof resolveCursorTool>[0]> = {},
  ): Parameters<typeof resolveCursorTool>[0] {
    return {
      activeTool: 'dig',
      activeView: 'surface',
      isModalOpen: false,
      contextMenuVisible: false,
      antActivityPanelVisible: false,
      overHud: false,
      ...overrides,
    };
  }

  it('returns the active tool when interactive and not over chrome', () => {
    expect(resolveCursorTool(cursorDeps({ activeTool: 'dig' }))).toBe('dig');
    expect(
      resolveCursorTool(cursorDeps({ activeTool: 'chamber', activeView: 'underground' })),
    ).toBe('chamber');
    expect(resolveCursorTool(cursorDeps({ activeTool: 'command' }))).toBe('command');
  });

  it("collapses Chamber to 'command' outside the underground view", () => {
    expect(resolveCursorTool(cursorDeps({ activeTool: 'chamber', activeView: 'surface' }))).toBe(
      'command',
    );
  });

  it("returns 'default' over HUD / context menu / inspector panel", () => {
    expect(resolveCursorTool(cursorDeps({ overHud: true }))).toBe('default');
    expect(resolveCursorTool(cursorDeps({ contextMenuVisible: true }))).toBe('default');
    expect(resolveCursorTool(cursorDeps({ antActivityPanelVisible: true }))).toBe('default');
  });

  it("returns 'default' while a modal owns input (menu / SavePrompt / GameOver)", () => {
    expect(resolveCursorTool(cursorDeps({ isModalOpen: true }))).toBe('default');
  });

  // Advisory fix (line 1727): a bare user-pause is NOT a modal, so tap/paint and
  // entrance-hover stay live — the tool cursor must persist, not revert to arrow.
  it('keeps the active tool during a bare user-pause (isModalOpen=false)', () => {
    expect(resolveCursorTool(cursorDeps({ activeTool: 'dig', isModalOpen: false }))).toBe('dig');
  });
});

// ---------------------------------------------------------------------------
// cursorToolChanged — memoization short-circuit (advisory fix: 'default' sentinel)
// ---------------------------------------------------------------------------

describe('cursorToolChanged', () => {
  it('reports a change when the resolved tool differs', () => {
    expect(cursorToolChanged('dig', 'surface', 'command', 'surface')).toBe(true);
  });

  it('reports a change when the view differs', () => {
    expect(cursorToolChanged('command', 'underground', 'command', 'surface')).toBe(true);
  });

  it('reports NO change when tool and view are unchanged (dedups the DOM write)', () => {
    expect(cursorToolChanged('dig', 'surface', 'dig', 'surface')).toBe(false);
  });

  // The core advisory bug: the 'default' sentinel was previously stored as null
  // while compared against the 'default' string, so 'default' === null was always
  // false and setDefaultCursor ran EVERY frame over chrome. Storing/comparing the
  // literal 'default' makes consecutive default frames short-circuit.
  it("short-circuits consecutive 'default' frames (sentinel round-trips)", () => {
    const effective: CursorTool = 'default';
    // First default frame: last is null → a write is needed.
    expect(cursorToolChanged(effective, 'surface', null, 'surface')).toBe(true);
    // After storing 'default' (literal, not null), the next frame must dedup.
    expect(cursorToolChanged(effective, 'surface', 'default', 'surface')).toBe(false);
  });

  it('initial frame always writes (lastTool/lastView null)', () => {
    expect(cursorToolChanged('dig', 'surface', null, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideBootMode
// ---------------------------------------------------------------------------

describe('decideBootMode', () => {
  it("returns 'prompt' when hasSave returns true", () => {
    expect(decideBootMode(() => true)).toBe('prompt');
  });

  it("returns 'fresh' when hasSave returns false", () => {
    expect(decideBootMode(() => false)).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// deriveAIColonyIds
// ---------------------------------------------------------------------------

describe('deriveAIColonyIds', () => {
  it('returns all colony ids except the player colony', () => {
    const world = makeWorldWithColonies({ 1: {}, 2: {} });
    const result = deriveAIColonyIds(world, 1 as ColonyId);
    expect(result).toEqual([2]);
  });

  it('returns [] for a single-colony world (no AI)', () => {
    const world = makeWorldWithColonies({ 1: {} });
    const result = deriveAIColonyIds(world, 1 as ColonyId);
    expect(result).toEqual([]);
  });

  it('returns [2, 3] in ascending order for three colonies with player=1', () => {
    const world = makeWorldWithColonies({ 1: {}, 2: {}, 3: {} });
    const result = deriveAIColonyIds(world, 1 as ColonyId);
    expect(result).toEqual([2, 3]);
  });

  it('uses Object.keys on world.colonies (plain object, NOT Map API)', () => {
    // This test verifies deriveAIColonyIds does not call .keys()/.entries() on colonies.
    // If it did, Map-style access would throw because colonies is a plain object.
    // We verify by using a plain object — Map.prototype.keys would throw.
    const world = makeWorldWithColonies({ 1: {}, 2: {} });
    // Should not throw
    expect(() => deriveAIColonyIds(world, 1 as ColonyId)).not.toThrow();
    const result = deriveAIColonyIds(world, 1 as ColonyId);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// appendInputLog
// ---------------------------------------------------------------------------

describe('appendInputLog', () => {
  it('appends all commands to the log in order', () => {
    const log: SimCommand[] = [];
    const cmds: SimCommand[] = [
      { type: 'NoOp', issuedAtTick: 0 },
      { type: 'NoOp', issuedAtTick: 1 },
    ];
    appendInputLog(log, cmds);
    expect(log).toHaveLength(2);
    expect(log[0]!.issuedAtTick).toBe(0);
    expect(log[1]!.issuedAtTick).toBe(1);
  });

  it('never drops commands — no truncation at any size (SCEN-06 replay truth)', () => {
    const log: SimCommand[] = [];
    const bigBatch: SimCommand[] = Array.from({ length: 200 }, (_, i) => ({
      type: 'NoOp' as const,
      issuedAtTick: i,
    }));
    appendInputLog(log, bigBatch);
    expect(log).toHaveLength(200);
  });

  it('handles empty cmds array — log unchanged', () => {
    const log: SimCommand[] = [{ type: 'NoOp', issuedAtTick: 99 }];
    appendInputLog(log, []);
    expect(log).toHaveLength(1);
  });

  it('appends across multiple calls (cumulative)', () => {
    const log: SimCommand[] = [];
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 0 }]);
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 1 }]);
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 2 }]);
    expect(log).toHaveLength(3);
    expect(log[2]!.issuedAtTick).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resetInputLog — session ownership (Phase 9 stabilization)
// ---------------------------------------------------------------------------

describe('resetInputLog', () => {
  it('empties a populated log in-place', () => {
    const log: SimCommand[] = [
      { type: 'NoOp', issuedAtTick: 0 },
      { type: 'NoOp', issuedAtTick: 1 },
    ];
    resetInputLog(log);
    expect(log).toHaveLength(0);
  });

  it('preserves the array reference (mutates in place)', () => {
    const log: SimCommand[] = [{ type: 'NoOp', issuedAtTick: 0 }];
    const ref = log;
    resetInputLog(log);
    // Same reference — required so captured closures (autosave) see the reset.
    expect(log).toBe(ref);
    expect(log).toHaveLength(0);
  });

  it('is idempotent on an already-empty log', () => {
    const log: SimCommand[] = [];
    resetInputLog(log);
    expect(log).toHaveLength(0);
  });

  it('bootFresh simulation: new session replaces contents with a fresh log', () => {
    // Model bootFresh's sequence: reset then subsequent appends.
    const log: SimCommand[] = [
      { type: 'NoOp', issuedAtTick: 0 },
      { type: 'NoOp', issuedAtTick: 1 },
    ];
    resetInputLog(log);
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 99 }]);
    expect(log).toHaveLength(1);
    expect(log[0]!.issuedAtTick).toBe(99);
  });

  it('bootFromSave simulation: reset then restore persisted log exactly', () => {
    // Model bootFromSave: reset clears stale commands, then we push loaded.inputLog.
    const log: SimCommand[] = [{ type: 'NoOp', issuedAtTick: 42 }]; // prior session
    const persisted: SimCommand[] = [
      { type: 'NoOp', issuedAtTick: 10 },
      { type: 'NoOp', issuedAtTick: 20 },
    ];
    resetInputLog(log);
    for (const c of persisted) log.push(c);
    expect(log).toHaveLength(2);
    expect(log[0]!.issuedAtTick).toBe(10);
    expect(log[1]!.issuedAtTick).toBe(20);
    // Prior-session command does not survive.
    expect(log.find((c) => c.issuedAtTick === 42)).toBeUndefined();
  });

  it('restart simulation: inputLog does not accumulate across consecutive sessions', () => {
    // Three simulated lifetimes: boot, play, reset, play again.
    const log: SimCommand[] = [];
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 0 }]);
    expect(log).toHaveLength(1);
    // Restart cycle 1
    resetInputLog(log);
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 0 }]);
    expect(log).toHaveLength(1);
    // Restart cycle 2
    resetInputLog(log);
    appendInputLog(log, [{ type: 'NoOp', issuedAtTick: 0 }]);
    expect(log).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Session reset orchestration — Phase 9 fresh-boot / restart integration
// ---------------------------------------------------------------------------
//
// GameScene.resetSessionState() is Phaser-coupled and can't be executed under
// Vitest, but it is a pure fan-out to a set of in-place reset helpers over
// state that IS unit-testable. These tests pin the orchestration contract:
// after the fan-out runs, every piece of session state is back to defaults
// while object identities are preserved (so already-registered handlers keep
// seeing the live state, as established by the Phase 9 stale-world fix).

describe('session reset orchestration (bootFresh / bootFromSave precondition)', () => {
  // Stage 1 controls rework (issue #18): resetSessionState's fan-out changed —
  // the surface/underground input-state resets are replaced by the gesture
  // arbiter's cancelGesture (modeled here as a PaintStrokeState reset) and the
  // pause-reason set is cleared entirely. The object-identity contract is
  // unchanged (in-place resets so captured closures keep seeing live state).
  interface SessionState {
    inputLog: SimCommand[];
    viewState: ReturnType<typeof createViewState>;
    paintStroke: PaintStrokeState;
    pauseReasons: PauseReasonState;
    dragState: DragState;
    /** GameScene scalar — modeled here so the harness exercises the same fan-out. */
    speedMultiplier: number;
  }

  function makeDirtySession(): SessionState {
    // Emulate a mid-session GameScene: mid-game, mid-paint-stroke, context menu
    // open, pan in flight, paused via Esc + Space, game sped up.
    const inputLog: SimCommand[] = [
      { type: 'NoOp', issuedAtTick: 0 },
      { type: 'NoOp', issuedAtTick: 1 },
    ];
    const viewState = createViewState(PLAYER_START_X, PLAYER_START_Y);
    toggleView(viewState); // → underground, visited
    viewState.undergroundCamera.x = 100;
    viewState.undergroundCamera.y = 40;
    viewState.surfaceCamera.x = 90;
    viewState.activeTool = 'chamber'; // non-default tool
    const paintStroke: PaintStrokeState = {
      active: true,
      lastMarkedTileX: 14,
      lastMarkedTileY: 6,
    };
    const pauseReasons: PauseReasonState = { user: true, menu: true };
    const dragState: DragState = { isDragging: true, lastX: 42, lastY: 99, active: true };
    panInputState.isPanning = true;
    contextMenuState.visible = true;
    contextMenuState.screenX = 300;
    return {
      inputLog,
      viewState,
      paintStroke,
      pauseReasons,
      dragState,
      speedMultiplier: 4, // player had sped up to 4x before the restart
    };
  }

  // Matches resetSessionState's fan-out exactly — kept here so the contract is
  // covered by a real test even though the owning method lives on the Phaser-
  // coupled GameScene. (arbiter.cancelGesture() == resetPaintStrokeState +
  // isPanning=false, both exercised here.)
  function runSessionReset(s: SessionState): void {
    resetInputLog(s.inputLog);
    resetViewState(s.viewState, PLAYER_START_X, PLAYER_START_Y);
    resetPaintStrokeState(s.paintStroke);
    clearAllPauseReasons(s.pauseReasons);
    resetDragState(s.dragState);
    resetPanInputState();
    hideContextMenu();
    s.speedMultiplier = 1;
  }

  it('clears every piece of session state back to defaults', () => {
    const s = makeDirtySession();
    runSessionReset(s);

    expect(s.inputLog).toHaveLength(0);
    expect(s.viewState.activeView).toBe('surface');
    expect(s.viewState.activeTool).toBe('command'); // surface default
    expect(s.viewState.surfaceCamera.x).toBe(PLAYER_START_X);
    expect(s.viewState.surfaceCamera.y).toBe(PLAYER_START_Y);
    expect(s.viewState.undergroundCamera.x).toBe(PLAYER_START_X);
    expect(s.viewState.undergroundCamera.y).toBe(UNDERGROUND_INITIAL_CAMERA_Y);
    expect(s.viewState.undergroundVisited).toBe(false);
    expect(s.paintStroke.active).toBe(false);
    expect(s.paintStroke.lastMarkedTileX).toBe(-1);
    expect(s.paintStroke.lastMarkedTileY).toBe(-1);
    expect(s.pauseReasons.user).toBe(false);
    expect(s.pauseReasons.menu).toBe(false);
    expect(s.dragState).toEqual({ isDragging: false, lastX: 0, lastY: 0, active: false });
    expect(panInputState.isPanning).toBe(false);
    expect(contextMenuState.visible).toBe(false);
    expect(s.speedMultiplier).toBe(1);
  });

  it('clears the ENTIRE pause-reason set (Codex R2-1 — no stuck menu/user pause)', () => {
    // A new-game-from-Esc / Save-Load path must not leave 'menu' (or 'user') set.
    for (const reasons of [
      { user: true, menu: false },
      { user: false, menu: true },
      { user: true, menu: true },
    ]) {
      const s = makeDirtySession();
      s.pauseReasons.user = reasons.user;
      s.pauseReasons.menu = reasons.menu;
      runSessionReset(s);
      expect(s.pauseReasons.user).toBe(false);
      expect(s.pauseReasons.menu).toBe(false);
    }
  });

  it('speedMultiplier resets to 1x regardless of prior 2x / 4x setting', () => {
    for (const prior of [1, 2, 4]) {
      const s = makeDirtySession();
      s.speedMultiplier = prior;
      runSessionReset(s);
      expect(s.speedMultiplier).toBe(1);
    }
  });

  it('preserves every object identity — no captured handler is stranded', () => {
    const s = makeDirtySession();
    const inputLogRef = s.inputLog;
    const viewStateRef = s.viewState;
    const surfaceCamRef = s.viewState.surfaceCamera;
    const undergroundCamRef = s.viewState.undergroundCamera;
    const paintStrokeRef = s.paintStroke;
    const pauseReasonsRef = s.pauseReasons;
    const dragStateRef = s.dragState;

    runSessionReset(s);

    expect(s.inputLog).toBe(inputLogRef);
    expect(s.viewState).toBe(viewStateRef);
    expect(s.viewState.surfaceCamera).toBe(surfaceCamRef);
    expect(s.viewState.undergroundCamera).toBe(undergroundCamRef);
    expect(s.paintStroke).toBe(paintStrokeRef);
    expect(s.pauseReasons).toBe(pauseReasonsRef);
    expect(s.dragState).toBe(dragStateRef);
  });

  it('bootFromSave: reset then restore persisted inputLog yields exactly the saved log', () => {
    const s = makeDirtySession();
    const persisted: SimCommand[] = [
      { type: 'NoOp', issuedAtTick: 10 },
      { type: 'NoOp', issuedAtTick: 20 },
      { type: 'NoOp', issuedAtTick: 30 },
    ];
    runSessionReset(s);
    for (const c of persisted) s.inputLog.push(c);
    expect(s.inputLog).toHaveLength(3);
    expect(s.inputLog.map((c) => c.issuedAtTick)).toEqual([10, 20, 30]);
  });

  it('restartGame path: successive fresh sessions remain idempotent on a reused scene', () => {
    const s = makeDirtySession();
    runSessionReset(s);
    appendInputLog(s.inputLog, [{ type: 'NoOp', issuedAtTick: 5 }]);
    s.viewState.surfaceCamera.x = 70;
    s.paintStroke.active = true;
    s.pauseReasons.user = true;
    s.speedMultiplier = 2;

    runSessionReset(s);

    expect(s.inputLog).toHaveLength(0);
    expect(s.viewState.surfaceCamera.x).toBe(PLAYER_START_X);
    expect(s.paintStroke.active).toBe(false);
    expect(s.pauseReasons.user).toBe(false);
    expect(s.speedMultiplier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generateFreshSeed
// ---------------------------------------------------------------------------

describe('generateFreshSeed', () => {
  it('returns a positive int32 for a typical wall-clock timestamp (0 ≤ seed ≤ 0x7fffffff)', () => {
    const nowMs = Date.now(); // ~1.7e12
    const seed = generateFreshSeed(nowMs);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0x7fffffff);
    expect(Number.isInteger(seed)).toBe(true);
  });

  it('is pure — same nowMs always produces the same seed', () => {
    const nowMs = 1234567890;
    expect(generateFreshSeed(nowMs)).toBe(generateFreshSeed(nowMs));
  });

  it('computes (nowMs & 0x7fffffff) | 0 — positive int32 clamp', () => {
    const nowMs = 1234567890;
    expect(generateFreshSeed(nowMs)).toBe((nowMs & 0x7fffffff) | 0);
  });

  it('result is non-negative for very large timestamps (Date.now() range)', () => {
    // Date.now() is ~1.7e12 — exceeds int32; bitmask clamps correctly
    const bigNow = 1_700_000_000_000;
    const seed = generateFreshSeed(bigNow);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});
