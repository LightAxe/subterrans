// game-scene.ts — Phase 9 Phaser GameScene: drives game loop, renders world, handles keyboard/camera.
//
// Owns: createGameLoop wiring, draw dispatch, Tab view-toggle, camera-pan triggers,
//       GamePhase FSM (Playing|Paused|GameOver|SavePrompt), save boot flow,
//       AI controller wiring (onBeforeTick → runAIController per AI colony),
//       outcome handling (gameLoop.pause() + UIScene overlay), autosave.
//
// Coordinate model (Stage 2 continuous-zoom rework, issue #18):
//   The render layer draws everything in WORLD pixels (worldX = tileX × TILE_SIZE_PX).
//   The Phaser main camera IS the projection: CameraController drives
//   cameras.main.setZoom + centerOn from the active view's world-pixel CameraView
//   (camera-adapter.ts is the single screen↔world authority). Input never reads a
//   Phaser matrix — it uses the adapter's pure formula. No setBounds (custom
//   center-aware clamp instead). Pre-Stage-2 this used manual screen-space projection
//   in the draw modules with cameras.main left at scroll=0; that is gone.
//
// Pitfall 1: All world drawing is in world px; the camera projects. Do NOT re-introduce
//            manual screen offsets in the draw modules, and do NOT setScrollFactor(0) on
//            world objects (that cancels scroll but NOT zoom — see screen-effects).
// Pitfall 2: Keyboard registration is GameScene-only — UIScene must NOT call createCursorKeys().
// Pitfall 3: logical resolution is fixed at CANVAS_W×CANVAS_H; Phaser.Scale.FIT (see
//            main.ts scale config) scales only the canvas's CSS box to fit the parent
//            while preserving aspect ratio, so game pixels are never DPR-distorted.
// Pitfall 4: NEVER use .keys()/.entries()/.get() on world.colonies — it is a PLAIN OBJECT (ADR-0006).
// Pitfall 5: No setMsPerTick(Infinity) for pause — use gameLoop.pause()/resume() (Plan 06 Task 1).
// Pitfall 6: Pause is opened via Esc (issue #116) and routed through the UIScene pause-menu
//            overlay — there is no bare keyboard pause anymore. The previous P-binding moved
//            to the pheromone toggle in issue #114. Space stays reserved for the pan gesture.

import * as Phaser from 'phaser';
import { createScenario } from '../sim/scenario.js';
import { copyWorldState, type WorldState } from '../sim/types.js';
import { tick, resetFlowFieldCaches } from '../sim/tick.js';
import { createGameLoop, type GameLoop, MS_PER_TICK } from '../platform/game-loop.js';
import {
  classifySaveCompatibility,
  loadSave,
  deleteSave,
  tickAutosave,
  FutureSimVersionError,
  OldSimVersionError,
  manualSave,
} from '../platform/save.js';
import { deserializeWorldState } from '../platform/save.js';
import { loadSettings, saveSettings } from '../platform/settings.js';
import { runAIController, resetAIControllerCache } from './ai-controller.js';
import { buildDebugSnapshot } from '../platform/debug-snapshot.js';
import { downloadDebugSnapshot } from './debug-snapshot-download.js';
import { submitPlaytrace, type PlaytraceSurvey } from './playtrace-upload.js';
import {
  GamePhase,
  deriveAIColonyIds,
  appendInputLog,
  generateFreshSeed,
  decideBootMode,
  resetInputLog,
  canArbiterPan,
  resolveCursorTool,
  cursorToolChanged,
  computeInterpAlpha,
  type CursorTool,
} from './game-scene-logic.js';
import {
  type ViewState,
  type ToolId,
  createViewState,
  resetViewState,
  toggleView,
  toggleUndergroundColony,
  worldPxDimensions,
  SURFACE_WORLD_PX_W,
  SURFACE_WORLD_PX_H,
  UNDERGROUND_WORLD_PX_W,
  UNDERGROUND_WORLD_PX_H,
} from './camera.js';
import {
  type CameraView,
  clampCameraView,
  screenToTileZoom,
  resolveDotMode,
  setViewportSize,
} from './camera-adapter.js';
import { CameraController } from './camera-controller.js';
import {
  TerrainCache,
  surfaceCacheKey,
  undergroundCacheKey,
  createTerrainShadow,
  diffTerrainShadow,
} from './terrain-bake.js';
import {
  PLAYER_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  STARVATION_GRACE_TICKS,
  UNDERGROUND_CEILING_ROW_Y,
} from '../sim/constants.js';
import { GameOutcome } from '../sim/game-over.js';
import { drawSurfaceTerrain, drawSurfaceEntities, type GfxLike } from './draw-surface.js';
import {
  drawUndergroundTerrain,
  drawUndergroundEntities,
  restampUndergroundTiles,
} from './draw-underground.js';
import { drawPheromoneOverlay } from './draw-pheromone.js';
import { publishSpeedMultiplier } from './ui-scene.js';
import { AntFacingCache } from './ant-facing-cache.js';
import {
  ANT_TEXTURE_QUEEN,
  ANT_TEXTURE_WORKER,
  EGG_SPRITE_HEIGHT,
  EGG_SPRITE_WIDTH,
  EGG_TEXTURE,
  FOOD_CACHE_SPRITE_HEIGHT,
  FOOD_CACHE_SPRITE_WIDTH,
  FOOD_CACHE_TEXTURE,
  LARVA_SPRITE_HEIGHT,
  LARVA_SPRITE_WIDTH,
  LARVA_TEXTURE,
  QUEEN_SPRITE_HEIGHT,
  QUEEN_SPRITE_WIDTH,
  SPIDER_SPRITE_DEPTH,
  SPIDER_SPRITE_HEIGHT,
  SPIDER_SPRITE_WIDTH,
  SPIDER_TEXTURE,
  WORKER_SPRITE_HEIGHT,
  WORKER_SPRITE_WIDTH,
} from './ant-sprite-layer.js';
import { AntSpritePool } from './ant-sprite-pool.js';
import { SUBTERRANS_READY_EVENT } from './lifecycle.js';

// Sprite assets are served from code/public/ as real files. Vite's
// `new URL(..., import.meta.url)` pattern inlines SVGs under ~4KB as
// `data:image/svg+xml;base64,...` URIs in dev mode. Phaser's load.svg
// assumes a file URL and routes through its XHR loader — when handed an
// inlined data URI it feeds the full `data:...` string to atob(), which
// throws on the URL-safe encoded prefix and black-screens preload. Keep
// the SVGs in code/public/assets/sprites/ so they are served as real HTTP
// resources; stable paths survive `npm run build`.
//
// Sprite URLs are composed inside preload() from the `assetsBase` registry
// value (set by main.ts in callbacks.preBoot). Default is
// `${import.meta.env.BASE_URL}assets/` (Vite `--base`-aware). Embedders can
// override at runtime via MountOptions.assetsBase so the same library bundle
// can be reused under different deploy paths without rebuilding.
import {
  processCameraInput,
  registerDragPan,
  registerWheelZoom,
  resetDragState,
  resetPanInputState,
  isPointerOverHUD,
  panInputState,
} from '../input/camera-input.js';
import { registerGestureArbiter, type GestureArbiter } from '../input/gesture-arbiter.js';
import { thresholdLogicalPx, DRAG_THRESHOLD_PX } from '../input/gesture.js';
import { CommandProjection } from './command-projection.js';
import { CommandFeedforward, type FeedforwardOutcome } from './command-feedforward.js';
import { computeGhostDelta } from './command-ghosts.js';
import {
  drawGhostDelta,
  drawFeedforwardTint,
  type HoveredFeedforward,
} from './draw-command-legibility.js';
import { ugGet, UndergroundTileState } from '../sim/terrain.js';
import { visibleContextMenuItems, contextMenuItemAt } from './context-menu-layout.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import {
  type PauseReasonState,
  createPauseReasonState,
  setPauseReason,
  clearPauseReason,
  togglePauseReason,
  isPausedByAny,
  clearAllPauseReasons,
} from './pause-reasons.js';
import { canAcceptWorldHotkey, type HotkeyGamePhase } from '../input/hotkey-policy.js';
import { contextMenuState, hideContextMenu } from './context-menu-state.js';
import { antActivityPanelState } from './ant-activity-panel-state.js';
import { buildPlaytraceSummary, type GameOutcomeLabel } from './summary-builder.js';
import {
  captionForEvent,
  checkAndTrigger,
  oneShotKeyForEvent,
  resetCaptions,
  type CaptionKey,
} from './onboarding-captions.js';
// Stage 3b controls rework (issue #18, #3) — first-use navigation hints.
import {
  triggerReactiveHint,
  notifyFirstWorldInput,
  resetFirstUseSession,
  type HintFirstUseId,
} from './first-use-hints.js';
import {
  triggerQueenDamagePulse,
  inferFlashDirection,
  QUEEN_DAMAGE_SUPPRESS_TICKS,
  type FlashDirection,
} from './screen-effects.js';
import { ChamberType } from '../sim/enums.js';
import { DEFAULT_LAYOUT, cssScaleX } from './layout.js';
import { buildHudLayout } from './hud-layout.js';
// UIScenePhase9 — subset of UIScene public API added in Plan 06 Task 3.
// Typed here to avoid circular imports; UIScene implements these methods.
interface UIScenePhase9 {
  showGameOverOverlay(
    outcome: GameOutcome,
    cause: import('./ui-scene-logic.js').QueenDeathCause,
    onRestart: () => void,
    narrativeSeed?: string | null,
  ): void;
  hideGameOverOverlay(): void;
  showSavePromptOverlay(callbacks: { onContinue: () => void; onNewGame: () => void }): void;
  hideSavePromptOverlay(): void;
  // Issue #116 — pause menu overlay. The callbacks object is intentionally
  // open-ended: onOpenSaveLoad is omitted until issue #115 wires the dialog,
  // at which point the menu's Save/Load row activates.
  showPauseMenuOverlay(callbacks: {
    onResume: () => void;
    onDownloadDebug: () => void;
    onOpenSaveLoad?: () => void;
    onQuitAndSurvey?: () => void;
  }): void;
  hidePauseMenuOverlay(): void;
  isPauseMenuVisible(): boolean;
  // Issue #115 — Save/Load dialog overlay. Shown on top of the pause menu;
  // GameScene hides the pause menu before showing the dialog so the layered
  // chrome stays clean, and re-shows the menu when Back is pressed.
  showSaveLoadDialogOverlay(callbacks: {
    onContinue: () => void;
    onNewGame: () => void;
    onSaveNow: () => Promise<boolean>;
    onDelete: () => void;
    onBack: () => void;
  }): void;
  hideSaveLoadDialogOverlay(): void;
  // Issue #131 — survey overlay. After submit or skip, the overlay shows a
  // confirmation screen with New Game / Retry. onNewGame restarts with a new
  // seed; onRetry restarts with the same seed. onSkip was removed.
  showSurveyOverlay(callbacks: {
    quitFromPauseMenu: boolean;
    outcome?: import('../sim/game-over.js').GameOutcome;
    cause?: import('./ui-scene-logic.js').QueenDeathCause;
    onSubmit(survey: PlaytraceSurvey & { includeSnapshot: boolean }): void;
    onNewGame(): void;
    onRetry(): void;
  }): void;
  hideSurveyOverlay(): void;
  // S5 — difficulty select overlay. Shown before every new game.
  showDifficultySelectOverlay(callbacks: {
    onSelect: (d: 'Easy' | 'Normal' | 'Hard') => void;
  }): void;
  hideDifficultySelectOverlay(): void;
  // S6 — first-occurrence caption overlay (light onboarding). Optional captionKey
  // (Stage 3b #3) lets a dropped one-shot caption un-mark its trigger so it re-fires.
  showCaption(text: string, screenX: number, screenY: number, captionKey?: CaptionKey): void;
  // Stage 3b (issue #18, #3) — display a one-time first-use navigation hint via
  // the shared caption queue. UIScene satisfies first-use-hints' FirstUseHintSink.
  showFirstUseHint(id: HintFirstUseId, text: string): void;
  // Stage 3b (ship-review R1#1/#3) — clear the caption queue + any in-flight
  // caption on round restart (UIScene survives restartGame, so its caption state
  // must be reset explicitly, like resetCaptions/resetFirstUseSession).
  resetCaptionsForRound(): void;
  // Stage 2 controls rework (issue #18) — the invasion screen-edge flash renders
  // on UIScene (non-zooming camera), NOT GameScene (zoom-driven main camera), so
  // setScrollFactor(0)'s scroll-but-not-zoom gap can't miscale the edge strips.
  triggerScreenEdgeFlash(direction: FlashDirection): void;
  // Stage 1 controls rework (issue #18) — surface the queue-full hint when
  // enqueueCommand drops a command at the cap. `paused` selects the message:
  // paused → "resume to continue"; running → "try again" (transient burst).
  // Optional so other UIScene consumers (tests) need not implement it.
  flashPausedQueueFull?(paused: boolean): void;
}
import type { SimCommand } from '../sim/commands.js';

// Re-export GamePhase for Plan 07 and other consumers
export { GamePhase, decideBootMode, deriveAIColonyIds, appendInputLog, generateFreshSeed };
export type { GamePhase as GamePhaseType };

declare global {
  interface Window {
    /** Dev/E2E-only test seam, separate from the read-only __phase9_ui
     *  observability hook. Installed by GameScene only when import.meta.env.DEV
     *  is true (Playwright runs the Vite dev server), so the whole thing is
     *  tree-shaken out of the production library build. Issue #193. */
    __phase9_test?: {
      /** Return the layer draw order recorded on the most recent rendered frame
       *  (e.g. ['terrain','pheromone','entities']). Lets a Playwright test assert
       *  the pheromone overlay is drawn between terrain and entities — the exact
       *  invariant the historical draw-order bug violated (terrain overpainted a
       *  too-early overlay). Pure render-side observability: it records nothing
       *  from and mutates nothing in the sim (a pixel test would have to inject
       *  sim state, crossing the sim/render boundary). Empty until the first
       *  frame renders. Issue #193. */
      getDrawOrder(): string[];
      /** Return the ACTIVE camera's current zoom (surface or underground per the
       *  active view). Render-side observability for the #237 pinch-zoom e2e
       *  (touch-smoke.spec.ts): reads viewState, mutates nothing, crosses no
       *  sim/render boundary. Dev-build only. */
      getActiveZoom(): number;
    };
  }
}

export class GameScene extends Phaser.Scene {
  private world!: WorldState;
  private prevState!: WorldState;
  private viewState!: ViewState;
  // Issue #213 / #238 — the LayoutContext seam + its built HUD anchor table.
  // Fixed at the canvas size today (DEFAULT_LAYOUT = 800×592); the eventual
  // responsive work recomputes `layout` from the real canvas and rebuilds `hud`.
  // `hud` is threaded into isPointerOverHUD / registerDragPan so the pan/zoom
  // masks read the same zone rects the HUD draws.
  private layout = DEFAULT_LAYOUT;
  private hud = buildHudLayout(this.layout);
  // #237 PR3 — scale-tuned drag threshold in LOGICAL px, recomputed from the
  // canvas CSS width at boot + on resize (recomputeDragThreshold) and read by the
  // arbiter via getDragThreshold. Starts at the fixed desktop default until the
  // first real measurement (a pre-layout width of 0 is ignored).
  private dragThresholdPx = DRAG_THRESHOLD_PX;
  private gameLoop!: GameLoop;
  private gfx!: Phaser.GameObjects.Graphics;
  // Overlay layer for world-space primitives that must render above the sprite
  // pool (e.g. the spider health bar, issue #148). Depth sits just above
  // SPIDER_SPRITE_DEPTH so it clears every in-world sprite.
  private overlayGfx!: Phaser.GameObjects.Graphics;
  // #236 PR1 — the pheromone overlay on its OWN persistent layer (not the
  // per-frame-cleared gfx) so it can be cached: the grids mutate only on a sim
  // tick, so a static detailed view redraws at 20 Hz not 60 fps. Sentinels drive
  // the cache; reset on session boot/restart/load (next to antFacingCache.reset).
  private pheromoneGfx!: Phaser.GameObjects.Graphics;
  private lastPheromoneTick = -1;
  private readonly lastPheromoneCam = { centerX: NaN, centerY: NaN, zoom: NaN };
  private lastPheromoneView = '';
  private antSprites!: AntSpritePool;
  // Stage 2 (issue #18): the Phaser-bound camera driver. Wraps cameras.main and is
  // driven from the active view's world-pixel CameraView every frame (setZoom +
  // centerOn); the only place that touches cameras.main's transform.
  private cameraController!: CameraController;
  // Stage 2 §B: baked-terrain RenderTexture cache (one RT per view, lazy enemy) + a
  // reusable off-screen Graphics used to stamp terrain into the RTs (full bake / dirty
  // re-stamp). The RTs are world-space GOs at origin (0,0) that cameras.main projects.
  private terrainCache!: TerrainCache<Phaser.GameObjects.RenderTexture>;
  private terrainBaker!: Phaser.GameObjects.Graphics;
  // Stage 2 §C13: strategic ant-dot LOD mode, resolved each frame from the smoothed zoom
  // via the hysteresis resolver (held across frames so the 0.55/0.65 band doesn't thrash).
  // PER VIEW (Codex P2): surface + underground keep independent zooms, so their LOD modes
  // must be tracked separately — a single shared flag carries the leaving view's mode onto
  // the entering view and strands it in the wrong mode inside the hysteresis band on toggle.
  private readonly dotModeByView: { surface: boolean; underground: boolean } = {
    surface: false,
    underground: false,
  };
  // Render-only ant-facing smoothing (see ant-facing-cache.ts). One instance
  // per scene, threaded into drawSurface + drawUnderground each frame so
  // cardinal zig-zag movement settles into a diagonal heading instead of
  // flipping sprite rotation every tick. Reset on boot / restart / save-load
  // so a recycled ant id never inherits a stale heading across sessions.
  private readonly antFacingCache: AntFacingCache = new AntFacingCache();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };
  private tabKey!: Phaser.Input.Keyboard.Key;
  private dragState!: { isDragging: boolean; lastX: number; lastY: number; active: boolean };
  // Stage 1 controls rework (issue #18) — the single left-button gesture arbiter
  // replaces the old surface/underground pointer listener sets.
  private arbiter!: GestureArbiter;
  // Stage 3a (issue #18): the projected world (live queue folded) — single source of
  // truth for underground tap/menu decisions AND feedforward/ghosts. Lazy + memoized.
  private readonly projection = new CommandProjection();
  // Stage 3a: trial-apply feedforward (owns a scratch clone). Paired with `projection`.
  private readonly feedforward = new CommandFeedforward();
  // Reconciled pause-reason set: the loop is paused iff any reason is set.
  // 'user' = Space / ⏸; 'menu' = Esc-driven overlay. Reconciled to
  // gameLoop.pause()/resume() centrally so the two pause independently.
  private readonly pauseReasons: PauseReasonState = createPauseReasonState();
  // Entrance hover (Dig + surface): the POINTER screen coords, re-resolved to a
  // tile + validity every render frame (Codex R1-9/R2-9/R3-4). null when the
  // pointer is off-canvas / over HUD / not in Dig+surface mode.
  private hoverScreenX: number | null = null;
  private hoverScreenY: number | null = null;
  // Last tool/view we set the canvas cursor for, so update() only writes the
  // cursor when it actually changes. Stores the 'default' sentinel as the literal
  // string (CursorTool), NOT null, so the change-detection compare short-circuits
  // on consecutive default frames instead of re-issuing setDefaultCursor.
  private lastCursorTool: CursorTool | null = null;
  private lastCursorView: ViewState['activeView'] | null = null;
  private lastActiveView: ViewState['activeView'] | null = null;

  // Phase 9 — GamePhase FSM + session fields
  private gamePhase: GamePhase = GamePhase.Playing;
  private currentOutcome: GameOutcome = GameOutcome.None;
  private currentCause: import('./ui-scene-logic.js').QueenDeathCause = null;
  // S5 — difficulty chosen by the player before each new game; preserved for retry.
  private currentDifficulty: 'Easy' | 'Normal' | 'Hard' = 'Normal';
  private aiColonyIds: ReturnType<typeof deriveAIColonyIds> = [];
  private readonly inputLog: SimCommand[] = [];
  private lastAutosaveMs: number = 0;
  /**
   * Issue #66 — set when bootFromSave catches a deserialize throw and falls
   * through to bootFresh, indicating an existing localStorage save couldn't
   * be loaded by this build. Suspends the autosave path in `update()` so
   * the preserved bytes aren't overwritten by the fresh game state. The
   * preserved save can be recovered on a future build / reload.
   * Cleared on resetSessionState so an explicit restartGame re-enables it.
   */
  private autosaveSuspended: boolean = false;
  // #234 — guards against overlapping fire-and-forget autosave writes (the async
  // storage set can outlast the 30s interval); scene.update never awaits.
  private autosaveInFlight: boolean = false;
  private resumedFromSave: boolean = false;
  private currentSeed: number = 0;
  // Issue #114 UAT — Settings sub-screen has a "Speed: N×" cycle row that
  // reads/writes this field via callbacks. The 1/2/4 keyboard shortcuts
  // below set the same field directly. Narrowed to the cycle set so the
  // type aligns with PauseMenuLayout's SpeedMultiplier.
  private speedMultiplier: 1 | 2 | 4 = 1;

  /** Set the live game speed and mirror it to the Playwright observability hook
   *  (window.__phase9_ui.speedMultiplier, issue #193). Every speedMultiplier
   *  write — the 1/2/4 keyboard shortcuts, the pause-menu Settings cycle, and
   *  the fresh-boot reset — routes through here so the hook never drifts from the
   *  field. Lets the speed-cycle e2e assert by value instead of pixel-diffing the
   *  rendered label (the old approach was CI-flaky under screenshot pressure). */
  private setSpeedMultiplier(next: 1 | 2 | 4): void {
    this.speedMultiplier = next;
    publishSpeedMultiplier(next);
  }

  /**
   * Step the speed multiplier among {1, 2, 4}. dir=+1 steps up (clamped at 4),
   * dir=-1 steps down (clamped at 1). Used by the =/-/numpad keys and the speed
   * widget. Never changes pause reasons (Codex R2-11).
   */
  private stepSpeed(dir: 1 | -1): void {
    const order: Array<1 | 2 | 4> = [1, 2, 4];
    const idx = order.indexOf(this.speedMultiplier);
    const nextIdx = Math.max(0, Math.min(order.length - 1, idx + dir));
    this.setSpeedMultiplier(order[nextIdx]!);
  }

  /** Live UIScene handle (null before launch / mid-restart). UIScene satisfies
   *  the first-use-hints sink + the caption/overlay API. */
  private getUIScene(): UIScenePhase9 | null {
    return this.scene.get('UIScene') as unknown as UIScenePhase9 | null;
  }

  /**
   * Stage 3b (#3): fire a reactive first-use hint on a gesture's EFFECT. The
   * effect gate (camera moved / mark enqueued / zoom accepted) is enforced at the
   * call site; first-use-hints enforces show-once.
   */
  private firstUseReactive(id: 'pan' | 'zoom' | 'paint'): void {
    const ui = this.getUIScene();
    if (ui) triggerReactiveHint(ui, id);
  }

  /**
   * Stage 3b (#3): note a world input and evaluate the proactive [Tab] nudge on
   * the player's FIRST world input of the session. Called AFTER the input is
   * handled (Codex R4) — from the arbiter (pointer gestures), the wheel handler,
   * and the Tab key — so a Tab first-input has already set undergroundVisited and
   * self-suppresses. notifyFirstWorldInput latches to the first call per session.
   */
  private noteWorldInput(): void {
    const ui = this.getUIScene();
    if (ui === null) return;
    const entranceCount = this.world?.colonies[PLAYER_COLONY_ID]?.entrances.length ?? 0;
    notifyFirstWorldInput(ui, {
      activeView: this.viewState.activeView,
      undergroundVisited: this.viewState.undergroundVisited,
      entranceCount,
    });
  }

  /**
   * #237 PR3 — recompute the scale-tuned drag threshold (logical px) from the
   * canvas's current CSS width. Called at boot and on Scale RESIZE. A pre-layout
   * or hidden canvas can report width 0; skip then and keep the current value
   * (the fixed default at boot) rather than dividing by zero into a bogus scale.
   *
   * A bound arrow property (not a method) so the SAME reference registers and
   * de-registers on the game-global Scale Manager, and `this` stays the scene.
   */
  private readonly recomputeDragThreshold = (): void => {
    const cssWidth = this.game.canvas?.getBoundingClientRect().width ?? 0;
    if (!(cssWidth > 0)) return; // negated so NaN (NaN > 0 is false) is also skipped
    this.dragThresholdPx = thresholdLogicalPx(cssScaleX(cssWidth, this.layout));
  };

  /** DEV/E2E-only render-order trace (issue #193). The draw section of update()
   *  records the layer sequence each frame so a Playwright test can assert the
   *  pheromone overlay is drawn between terrain and entities — the exact
   *  invariant the historical draw-order bug violated (terrain overpainted a
   *  too-early overlay). Pure render-side observability: nothing here reads or
   *  mutates the sim, so the sim/render boundary is respected (a pixel-based test
   *  would have to inject pheromone into the sim store from render, which is a
   *  boundary violation). The bodies are gated on import.meta.env.DEV, which Vite
   *  statically replaces with false in the library build, so they vanish there. */
  private readonly drawOrder: string[] = [];
  private beginDrawTrace(): void {
    if (import.meta.env.DEV) this.drawOrder.length = 0;
  }
  private recordDrawLayer(layer: 'terrain' | 'pheromone' | 'entities'): void {
    if (import.meta.env.DEV) this.drawOrder.push(layer);
  }

  /** Dev/E2E-only: install Playwright test seams on window. Guarded by
   *  import.meta.env.DEV so the whole block is tree-shaken out of production
   *  library builds (Playwright runs the Vite dev server, where DEV is true). */
  private installTestHooks(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    window.__phase9_test = {
      getDrawOrder: (): string[] => [...this.drawOrder],
      getActiveZoom: (): number =>
        (this.viewState.activeView === 'surface'
          ? this.viewState.surfaceCamera
          : this.viewState.undergroundCamera
        ).zoom,
    };
  }

  // S6 — render-side scratch (per-session, reset in resetSessionState).
  private lastProcessedEventTick = -1; // tick-based cursor for consumeEventsForRender
  private prevQueenCombinedHp: number | null = null; // queen HP tracking for damage pulse
  private queenStarvationTriggered = false; // starvation onset caption/pulse guard
  private renderFrame = 0; // frame counter for glow fade maps
  private readonly contestedGlowFrames: Map<number, number> = new Map(); // surface glow fade
  private readonly undergroundGlowFrames: Map<number, number> = new Map(); // underground glow fade

  // Issue #122 / ADR 0013 — playtrace upload state. The endpoint string is
  // sourced from the registry (set by main.ts from VITE_PLAYTRACE_ENDPOINT
  // or MountOptions.playtraceEndpoint); empty string = feature off. The
  // sessionId is a per-session UUID generated render-side via crypto;
  // regenerated on restart so each session has its own row server-side.
  private playtraceEndpoint: string = '';
  private playtraceSessionId: string = '';

  constructor() {
    super({ key: 'GameScene' });
  }

  preload() {
    // Load ant SVG sprites. Phaser rasterizes at the given width/height; the
    // texture is then reused for every pooled ant image. Tinting in the pool
    // multiplies the white SVG fill by the colony color.
    //
    // `assetsBase` is plumbed in by main.ts via callbacks.preBoot. A missing
    // or non-string registry value means GameScene was instantiated outside
    // mount() (e.g. ad-hoc test harness, hand-built Phaser.Game) — fail loud
    // rather than letting `String(undefined)` produce 404s on every sprite.
    const assetsBaseRaw: unknown = this.registry.get('assetsBase');
    if (typeof assetsBaseRaw !== 'string' || assetsBaseRaw.length === 0) {
      throw new Error(
        'GameScene.preload: assetsBase registry value missing or invalid. ' +
          'GameScene must be mounted via main.ts mount() (sets the registry in callbacks.preBoot).',
      );
    }
    const spriteBase = `${assetsBaseRaw}sprites/`;
    this.load.svg(ANT_TEXTURE_WORKER, `${spriteBase}worker-ant.svg`, {
      width: WORKER_SPRITE_WIDTH,
      height: WORKER_SPRITE_HEIGHT,
    });
    this.load.svg(ANT_TEXTURE_QUEEN, `${spriteBase}queen-ant.svg`, {
      width: QUEEN_SPRITE_WIDTH,
      height: QUEEN_SPRITE_HEIGHT,
    });
    this.load.svg(EGG_TEXTURE, `${spriteBase}egg.svg`, {
      width: EGG_SPRITE_WIDTH,
      height: EGG_SPRITE_HEIGHT,
    });
    this.load.svg(LARVA_TEXTURE, `${spriteBase}larva.svg`, {
      width: LARVA_SPRITE_WIDTH,
      height: LARVA_SPRITE_HEIGHT,
    });
    this.load.svg(FOOD_CACHE_TEXTURE, `${spriteBase}food-cache.svg`, {
      width: FOOD_CACHE_SPRITE_WIDTH,
      height: FOOD_CACHE_SPRITE_HEIGHT,
    });
    this.load.svg(SPIDER_TEXTURE, `${spriteBase}spider.svg`, {
      width: SPIDER_SPRITE_WIDTH,
      height: SPIDER_SPRITE_HEIGHT,
    });
  }

  create() {
    // #238 PR3 — publish this scene's logical canvas size to the camera-adapter
    // projection before any camera/projection math runs this frame. Byte-identical
    // to CANVAS_W×CANVAS_H today; both scenes set it at boot (idempotent).
    setViewportSize(this.layout.w, this.layout.h);
    this.viewState = createViewState(PLAYER_START_X, PLAYER_START_Y);
    this.gfx = this.add.graphics();
    this.overlayGfx = this.add.graphics();
    this.overlayGfx.setDepth(SPIDER_SPRITE_DEPTH + 1);
    // #236 PR1 — pheromone overlay layer. Depth -5: above the terrain RT (-10),
    // below the dynamic gfx (0) → pheromone under entities, over terrain,
    // preserving the pre-#236 draw order. Persistent (not cleared each frame) so
    // updatePheromoneLayer can skip the redraw when nothing changed.
    this.pheromoneGfx = this.add.graphics();
    this.pheromoneGfx.setDepth(-5);
    this.antSprites = new AntSpritePool(this);
    // Stage 2 (issue #18): bind the continuous-zoom camera. cameras.main is now the
    // world→screen projection (driven from the CameraView each frame); roundPixels is
    // disabled inside the controller for smooth sub-pixel pan.
    this.cameraController = new CameraController(this.cameras.main);

    // Stage 2 §B: baked-terrain RenderTextures (one RT per view, origin (0,0); surface
    // 2048², underground 2048×1024 per colony, enemy lazily on first X-toggle). NEAREST
    // filtering for crisp scaling; depth below all dynamic layers; hidden until shown.
    // cameras.main projects/zooms the RT each frame.
    this.terrainCache = new TerrainCache<Phaser.GameObjects.RenderTexture>((key) => {
      const [w, h] =
        key === surfaceCacheKey()
          ? [SURFACE_WORLD_PX_W, SURFACE_WORLD_PX_H]
          : [UNDERGROUND_WORLD_PX_W, UNDERGROUND_WORLD_PX_H];
      const rt = this.add.renderTexture(0, 0, w, h);
      rt.setOrigin(0, 0);
      rt.setDepth(-10); // below the dynamic gfx (depth 0) + ant pool (50)
      rt.setVisible(false);
      rt.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      return rt;
    });
    // Off-screen reusable Graphics for stamping terrain into the RTs (not on the display list).
    this.terrainBaker = this.make.graphics({}, false);

    // Stage 2 §B (R2-11/R4-6): a WebGL context restore leaves RT framebuffers blank — flag
    // every allocated cache for a full rebake. The WebGLRenderer (game.renderer) emits
    // 'restorewebgl' (game.events does NOT). Unsubscribe + destroy the RTs on shutdown.
    const renderer = this.game.renderer as unknown as Phaser.Events.EventEmitter;
    renderer.on('restorewebgl', this.onWebglRestore);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      renderer.off('restorewebgl', this.onWebglRestore);
      this.terrainCache.destroyAll((rt) => rt.destroy());
      // terrainBaker is off the display list (make.graphics addToScene=false), so Phaser
      // won't auto-destroy it on shutdown — free its WebGL batch explicitly.
      this.terrainBaker.destroy();
      // #237 PR3 — the RESIZE listener is on the game-global Scale Manager, which
      // outlives the scene; drop it so a restart can't accumulate stale callbacks.
      this.scale.off(Phaser.Scale.Events.RESIZE, this.recomputeDragThreshold);
    });

    // Issue #122 — pull the playtrace endpoint out of the registry (set by
    // main.ts in callbacks.preBoot). Treat any non-string value as "feature
    // off" so a programming error in main.ts doesn't accidentally turn the
    // overlay on with an undefined endpoint and 404 the submission.
    const endpointRaw: unknown = this.registry.get('playtraceEndpoint');
    // Trim whitespace so a templated env var that resolved to spaces
    // is treated as feature-off here too. main.ts normalizes at the
    // boundary; this is defense-in-depth for the registry value.
    this.playtraceEndpoint = typeof endpointRaw === 'string' ? endpointRaw.trim() : '';

    // Input registration — keyboard is GameScene-only (Pitfall 2).
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd;
    this.tabKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    // Prevent Tab from moving focus to browser UI:
    this.input.keyboard!.addCapture('TAB');
    this.input.mouse!.disableContextMenu();

    // Stage 1 controls rework (issue #18): Space is now the pause toggle, not a
    // pan modifier. addKey creates a real Key object (the second arg also adds
    // the global capture so Space never scrolls the host page while focused,
    // replacing the bare addCapture this used to do). The Key is required so
    // Phaser de-dupes OS key auto-repeat on the scene-level keydown-SPACE event:
    // without a Key, KeyboardPlugin emits keydown-SPACE every repeat tick and a
    // held Space strobes the pause toggle on/off (see handler below). We only
    // need the Key to exist in the plugin's key map, so we don't retain the ref.
    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE, true);

    // Middle-button drag-pan registration (left/Space pan paths removed —
    // left is now exclusively the gesture arbiter's). Returns dragState ref
    // for processCameraInput. Suspended during any modal (menu / SavePrompt /
    // GameOver): isModalOpen() is exactly the left arbiter's pan gate
    // (canPan: () => canArbiterPan(this.isModalOpen())), so an Esc menu opened
    // mid middle-drag suspends the camera move and it doesn't persist after
    // Resume (Codex P2). A bare user-pause (Space) is NOT modal, so middle-pan
    // still works while paused — intended.
    this.dragState = registerDragPan(this, this.viewState, this.hud, () => this.isModalOpen());

    // Stage 2 (issue #18): mouse-wheel / trackpad zoom. #237 PR5 — relocated to
    // camera-input.registerWheelZoom (mirrors registerDragPan) so the gesture the
    // pinch extends has an input-layer home + a unit test. Gated exactly like world
    // pan (canAcceptWorldHotkey + HUD); ctrl/cmd-wheel is left to the OS/browser
    // pinch-zoom; wheel-up (dy < 0) zooms IN. onZoomAccepted fires the "Scroll to
    // zoom" hint only when targetZoom actually changed (not a clamped no-op).
    registerWheelZoom(this, {
      canAcceptWorldHotkey: () => this.canAcceptWorldHotkey(),
      isPointerOverHUD: (x, y) => isPointerOverHUD(x, y, this.hud, this.viewState),
      getActiveCamera: () =>
        this.viewState.activeView === 'surface'
          ? this.viewState.surfaceCamera
          : this.viewState.undergroundCamera,
      beginZoom: (cam, factor, sx, sy) => this.cameraController.beginZoom(cam, factor, sx, sy),
      onZoomAccepted: () => this.firstUseReactive('zoom'),
      noteWorldInput: () => this.noteWorldInput(),
    });

    // Issue #116 — Esc opens the pause menu overlay (which also pauses the
    // sim). The Esc keybinding itself lives in UIScene (which already owned
    // Esc for the ant-activity panel hide and the dialog/menu close paths);
    // routing all Esc through one scene avoids the dual-handler race that
    // had GameScene open the menu and UIScene immediately close it on the
    // same press. UIScene calls back to openPauseMenu via the onEscape
    // callback supplied below at scene.launch.
    // Speed-multiplier keys (1/2/4) and the P pheromone toggle (issue #114)
    // stay on GameScene because they're game-state actions, not UI chrome.
    // Speed-multiplier keys (1/2/4), the pheromone toggle (P), and the
    // underground colony toggle (X) all mutate state that the player
    // expects the menu to be the modal source of truth for while paused.
    // Round-2 review: gating these on `gamePhase === Playing` prevents
    // a P press while the pause menu's Settings page is up from desyncing
    // the on-screen "ON/OFF" label from the persisted setting (the menu
    // captures the label at render time and would no longer match), and
    // prevents Resume from snapping the camera to the enemy nest because
    // X was pressed while paused.
    // Stage 1 controls rework (issue #18) — tool palette hotkeys. 1/2/4 no
    // longer set speed (freed for tools): 1→Command, 2→Dig, 3→Chamber. All
    // gated through canAcceptWorldHotkey (selectTool enforces the gate + the
    // Chamber-is-underground-only rule).
    this.input.keyboard!.on('keydown-ONE', () => this.selectTool('command'));
    this.input.keyboard!.on('keydown-TWO', () => this.selectTool('dig'));
    this.input.keyboard!.on('keydown-THREE', () => this.selectTool('chamber'));

    // Speed step keys: top-row '='/'+' (keycode 187) and numpad-add step UP;
    // top-row '-' (keycode 189) and numpad-subtract step DOWN, among {1,2,4}.
    // Ctrl/Cmd combos are ignored so browser zoom shortcuts pass through
    // (Codex R1-13/R4-3). Gated like the other world hotkeys; speed changes
    // never touch pause reasons (Codex R2-11).
    const stepSpeedKey = (dir: 1 | -1) => (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey) return;
      if (!this.canAcceptWorldHotkey()) return;
      this.stepSpeed(dir);
    };
    this.input.keyboard!.on('keydown-PLUS', stepSpeedKey(1)); // keycode 187 ('='/'+')
    this.input.keyboard!.on('keydown-MINUS', stepSpeedKey(-1)); // keycode 189 (top-row '-')
    this.input.keyboard!.on('keydown-NUMPAD_ADD', stepSpeedKey(1));
    this.input.keyboard!.on('keydown-NUMPAD_SUBTRACT', stepSpeedKey(-1));

    // Space toggles the 'user' pause (edge-triggered on keydown; the Key
    // registered above makes Phaser de-dupe OS auto-repeat on this event). The
    // event.repeat guard is belt-and-suspenders so a held Space can never strobe
    // the pause on/off. Gated through canAcceptWorldHotkey so a Space behind a
    // modal/menu can't flip the pause reason underneath it.
    this.input.keyboard!.on('keydown-SPACE', (ev: KeyboardEvent) => {
      if (ev.repeat) return;
      if (!this.canAcceptWorldHotkey()) return;
      this.toggleUserPause();
    });
    // Issue #114 — P toggles the player's pheromone overlay. Render-only:
    // the flag lives on ViewState (so the next frame skips drawPheromoneOverlay)
    // AND in persisted settings (so the choice survives reloads). The pause
    // menu's Settings sub-screen drives the same write path; gating P on
    // Playing means the menu is the only writer while paused (no label
    // desync — see comment block above).
    //
    // Round-6 P2 (Codex): flip from in-memory state, NOT from loadSettings().
    // If localStorage writes are blocked (quota / private-mode), saveSettings
    // is a no-op; loadSettings then returns DEFAULT_SETTINGS on the NEXT
    // press and we'd recompute `!true = false` every time — the toggle gets
    // stuck OFF. ViewState is the authoritative in-mem source; persist is
    // best-effort and survives reload only when storage cooperates.
    this.input.keyboard!.on('keydown-P', () => {
      if (!this.canAcceptWorldHotkey()) return;
      const next = !this.viewState.showPheromoneOverlay;
      this.viewState.showPheromoneOverlay = next;
      const persisted = loadSettings();
      persisted.pheromoneOverlay = next;
      saveSettings(persisted);
    });

    // 09.1 Chunk 2 — X toggles the active underground colony view. Only
    // flips when activeView === 'underground'; inert on the surface view
    // (the HUD label is also hidden there). Event-based to match the
    // P/F9/speed-multiplier pattern above — the keyboard-plugin event bus
    // handles edge-trigger semantics for us (one keydown event per press),
    // avoiding the key-repeat DoS that Phase 08-04 guarded against for
    // Tab via JustDown. Gated on Playing so a paused player doesn't Resume
    // into a surprise camera flip onto the enemy nest.
    this.input.keyboard!.on('keydown-X', () => {
      if (!this.canAcceptWorldHotkey()) return;
      if (this.viewState.activeView !== 'underground') return;
      toggleUndergroundColony(this.viewState);
      // Toggling the active colony retargets where a Dig/Command lands, so it
      // must abort any pending gesture eagerly — same as selectTool on a tool
      // change. Otherwise a same-frame keydown-X batched before a queued
      // pointerup would dispatch the tap onto the now-live colony's grid at a
      // tile picked while inspecting the OTHER colony (the down-time snapshot's
      // colony is bypassed in dispatchTap; reconcileContext only covers the
      // cross-frame case).
      this.arbiter.cancelGesture();
      // Clear stale glow entries from the previous colony grid — tile keys are
      // not scoped to a colony, so entries from one grid must not bleed into
      // the other when the view switches.
      this.undergroundGlowFrames.clear();
    });

    // 09 excursion-foraging follow-up — F9 exports a debug snapshot JSON
    // (seed, tick, inputLog, world snapshot, enriched per-ant trace) so QA
    // can attach the full repro state to a bug report. No sim mutation, no
    // wall-clock in src/sim — the payload builder lives in src/platform and
    // the DOM download sits in src/render.
    this.input.keyboard!.on('keydown-F9', () => {
      if (this.world === undefined) return; // pre-boot guard
      const snap = buildDebugSnapshot(this.world, this.currentSeed, this.inputLog);
      downloadDebugSnapshot(snap);
    });

    // UIScene + input handlers take a LAZY world accessor — `this.world` is
    // assigned by bootFresh/bootFromSave below, and may be replaced again on
    // restart. Capturing the current (undefined) reference here would freeze
    // the HUD + world input against a pre-boot world (see Phase 9 stabilization).
    const getWorld = (): WorldState | undefined => this.world;
    const getPrevWorld = (): WorldState | null => (this.world ? this.prevState : null);

    // Launch HUD scene on top.
    this.scene.launch('UIScene', {
      viewState: this.viewState,
      getWorld,
      // Stage 3a (issue #18): projected world for the chamber-menu filtering (R5-2) + the
      // forage/fight requested marker (reads projected.targetRatio). NOTE: scene.launch data
      // is not type-checked against UIScene.init, so this MUST be passed explicitly here.
      getProjectedWorld: () => this.projection.get(this.world),
      // Stage 3a (issue #18): the same trial-apply feedforward the render cue + underground
      // taps use. The chamber-menu click gates its PlaceChamber emit on willTakeEffect so the
      // chamber tint and the emitted command can never disagree (cue/command parity, R2-3/4).
      getFeedforward: () => this.feedforward,
      // Issue #116 — UIScene owns Esc; this callback fires on Esc when no
      // UIScene overlay/panel is open and is the trigger to spawn the pause
      // menu. GameScene was previously binding keydown-ESC alongside
      // UIScene's escKey handler, which raced (open → close in one press).
      onEscape: () => this.openPauseMenu(),
      // Stage 1 controls rework (issue #18) — the HUD tool palette + speed widget
      // route through these GameScene-owned, gated handlers so a palette/speed
      // click obeys the same gate as the 1/2/3 and =/- hotkeys.
      onSelectTool: (tool: ToolId) => this.selectTool(tool),
      onSpeedControl: (control: 'pause' | 1 | 2 | 4) => {
        if (!this.canAcceptWorldHotkey()) return;
        if (control === 'pause') {
          // ⏸ toggles the 'user' pause (same as Space). canAcceptWorldHotkey is
          // true during a bare user-pause (no menu) so ⏸ can also un-pause.
          this.toggleUserPause();
        } else {
          // 1×/2×/4× set the multiplier WITHOUT changing pause reasons (Codex R2-11).
          this.setSpeedMultiplier(control);
        }
      },
      // A minimap click-to-nav has just recentered the active camera. Cancel any
      // in-flight wheel zoom-lerp/anchor on it so the next tickZoomLerp doesn't
      // re-anchor centerX/Y from the fixed cursor point and overwrite the nav —
      // same cancel the keyboard/drag-pan path does below in update().
      onMinimapNav: () => {
        const cam =
          this.viewState.activeView === 'surface'
            ? this.viewState.surfaceCamera
            : this.viewState.undergroundCamera;
        this.cameraController.cancel(cam);
      },
      isPaused: () => isPausedByAny(this.pauseReasons),
      getSpeedMultiplier: () => this.speedMultiplier,
    });
    this.scene.bringToTop('UIScene');

    // Stage 1 controls rework (issue #18): the single left-button gesture
    // arbiter replaces registerSurfaceInput + registerUndergroundInput. It owns
    // the left button exclusively (and the right-click chamber path); the
    // middle-button pan stays on registerDragPan above. Tap logic lives in the
    // pure surface/underground handlers the arbiter calls.
    this.arbiter = registerGestureArbiter(this, {
      getWorld,
      getPrevWorld,
      // Stage 3a (issue #18): projected world for underground tap/menu decisions —
      // the live queue folded, the same state feedforward uses (cue/command agree).
      getProjectedWorld: () => this.projection.get(this.world),
      // Stage 3a (issue #18): the same trial-apply feedforward the render cue uses, so
      // the underground tap gate and the on-screen cue can never disagree. Shared with
      // computeUndergroundDigHover's outcome() — willTakeEffect never touches its memo.
      getFeedforward: () => this.feedforward,
      viewState: this.viewState,
      isPointerOverHUD: (x, y) => isPointerOverHUD(x, y, this.hud, this.viewState),
      isPaused: () => isPausedByAny(this.pauseReasons),
      // World edits (tap / paint / chamber) are allowed whenever no modal is up —
      // crucially that INCLUDES a bare user-pause, so a click/dig-paint while
      // paused queues through enqueueCommand for application on resume (the
      // paused-cap behaviour). isModalOpen() already covers GameOver/SavePrompt
      // and the Esc menu pause, which DO block edits.
      canEditWorld: () => !this.isModalOpen(),
      // Pan is a pure camera move with no world effect, so — like keyboard /
      // middle-button pan — it stays available whenever the world is interactive:
      // while Playing AND during a bare user-pause (Space / ⏸). It is BLOCKED
      // while a modal owns input: the Esc pause menu, SavePrompt, or GameOver.
      // The arbiter's pan runs from Phaser pointermove handlers that fire
      // independently of update() (and no overlay calls stopPropagation here), so
      // this gate is the ONLY thing stopping a left-drag from panning behind a
      // modal — and closePauseMenu()/reconcilePause() never reset the camera, so
      // an un-gated pan would persist after Resume. isModalOpen() is exactly the
      // non-interactive set (GameOver/SavePrompt/menu) and is false for a bare
      // user-pause, so `!isModalOpen()` is the correct gate. Do NOT revert this to
      // a GameOver-only check: SavePrompt and the menu DO reach here.
      canPan: () => canArbiterPan(this.isModalOpen()),
      // The chamber context menu is anchored at an arbitrary WORLD tile (not a
      // HUD zone), so isPointerOverHUD can't catch it and canEditWorld stays true
      // while it's open. Gate left taps on it directly: a click that selects /
      // dismisses a menu item (UIScene owns that on its own pointerdown) must not
      // ALSO fire a world tap. pendingShow/pendingHide cover the deferred-(dis)appear
      // race where `visible` lags a frame behind a same-dispatch request.
      isContextMenuActive: () =>
        contextMenuState.visible || contextMenuState.pendingShow || contextMenuState.pendingHide,
      onPausedQueueFull: (paused: boolean) => {
        const ui = this.scene.get('UIScene') as unknown as UIScenePhase9 | null;
        ui?.flashPausedQueueFull?.(paused);
      },
      // Stage 3b (#3) — first-use teaching seams. The arbiter fires these on the
      // EFFECT (camera moved / ≥1 mark enqueued / a world gesture began); the
      // teaching policy (show-once, queue) lives entirely on the UIScene side.
      onPanEffect: () => this.firstUseReactive('pan'),
      onPaintEffect: () => this.firstUseReactive('paint'),
      onWorldInput: () => this.noteWorldInput(),
      // #237 PR3 — scale-tuned drag threshold; recomputeDragThreshold keeps the
      // stored value current across resizes.
      getDragThreshold: () => this.dragThresholdPx,
      // #237 PR4 — Phaser timer seam for the touch long-press → chamber menu. The
      // returned canceller removes the pending event; Phaser's remove() is a no-op
      // once the event has fired, matching the dep's "safe after fire" contract.
      scheduleTimeout: (cb: () => void, ms: number): (() => void) => {
        const event = this.time.delayedCall(ms, cb);
        return () => event.remove();
      },
      // #237 PR5 — touch press-and-hold drives the SAME hover fields the mouse
      // pointermove handler sets (below), so the existing per-frame feedforward
      // hover resolution renders the touch preview. onHoverPreviewEnd clears it on
      // release — pointerout/gameout don't fire on a touch-up inside the canvas.
      onHoverPreview: (x: number, y: number) => {
        this.hoverScreenX = x;
        this.hoverScreenY = y;
      },
      onHoverPreviewEnd: () => {
        this.hoverScreenX = null;
        this.hoverScreenY = null;
      },
    });
    // Seed the threshold from the real canvas size now the scene is live, and keep
    // it current as the FIT-scaled canvas resizes (window resize / rotate).
    this.recomputeDragThreshold();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.recomputeDragThreshold);

    // Entrance hover (Dig + surface): track the POINTER screen coords so the
    // hover outline can be re-resolved to a tile + validity from the LIVE camera
    // every frame (Codex R3-4 — a stationary cursor over a panning camera must
    // still highlight the tile under it). Cleared on pointer-out.
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      // #237 PR5 — MOUSE hover only. Touch has no real hover; its feedforward
      // preview is the arbiter's press-and-hold (onHoverPreview above), so a raw
      // touch-drag must NOT paint the hover outline the instant a finger moves.
      if (pointer.wasTouch) return;
      this.hoverScreenX = pointer.x;
      this.hoverScreenY = pointer.y;
    });
    this.input.on('pointerout', () => {
      // #237 PR5 — sync the arbiter's touch hover preview (cancel its timer, end it
      // if showing) so a canvas exit can't resurrect it at the stale down-point;
      // then clear the fields for the mouse case (endHoverPreview no-ops on mouse).
      this.arbiter.endHoverPreview();
      this.hoverScreenX = null;
      this.hoverScreenY = null;
    });
    // Fix 2: 'pointerout' fires only when the pointer leaves an interactive game
    // OBJECT — it does NOT fire when the pointer leaves the CANVAS. Phaser emits
    // 'gameout' for canvas exits (Phaser.Input.Events.GAME_OUT, since 3.16.1;
    // we're on 3.90). Without this, leaving the canvas while surface Dig is
    // selected left stale hover coords, so the entrance hover outline lingered
    // and drifted across tiles during keyboard pan. Clear the hover here too.
    this.input.on('gameout', () => {
      this.arbiter.endHoverPreview(); // #237 PR5 — as pointerout above
      this.hoverScreenX = null;
      this.hoverScreenY = null;
    });
    // Cancel any in-flight gesture if the canvas loses focus (blur).
    this.game.events.on('blur', () => this.arbiter.cancelGesture());

    // Phase 9 boot: classify any existing save and dispatch the right boot path.
    // classifySaveCompatibility now hits the async storage driver (#234), so
    // create() can't await it — fire-and-forget. The overlay/fresh-boot dispatch
    // lands one microtask later (same frame under the sync-backed driver).
    //
    // Hold at SavePrompt synchronously first: update() early-returns on
    // SavePrompt, so this closes the boot window in which it would otherwise
    // tick an unbuilt world/gameLoop (gamePhase is field-initialised Playing).
    // Both dispatch branches converge on SavePrompt anyway — the prompt branch
    // sets it directly, the fresh branch via showDifficultySelectThenBoot — so
    // this is a no-op under today's sync driver and hardens the seam for a
    // future macrotask-resolving driver (Phase 6 IndexedDB/OPFS), which would
    // otherwise have a pre-boot frame to crash on.
    this.gamePhase = GamePhase.SavePrompt;
    void this.dispatchInitialBoot();

    // Lifecycle signal — preload assets are loaded (we're in create()), the
    // scene graph is constructed, and the chosen boot path (fresh world or
    // SavePrompt overlay) has been dispatched. Phaser's first render tick
    // runs after create() returns, so the canvas paints on the next frame;
    // "ready" here means "interactive imminently", which is the right
    // moment for a host page to hide a loading spinner. Emit after the
    // bootMode branch so both paths reach it. main.ts converts this to
    // `MountedGame.ready: Promise<void>` for the host page.
    this.game.events.emit(SUBTERRANS_READY_EVENT);

    // Dev/E2E-only test seams (no-op in production builds). Installed last so
    // the world/viewState the hooks read are already constructed.
    this.installTestHooks();
  }

  // ---------------------------------------------------------------------------
  // Boot helpers
  // ---------------------------------------------------------------------------

  /**
   * Phase 9 boot dispatch — classify any existing save ONCE and route to the
   * right boot path. A loadable ('compatible') save shows the Continue/New Game
   * SavePrompt; everything else boots fresh — but a future-build save
   * ('incompatible-future': simVersion > LATEST) is recoverable on a newer build,
   * so the fresh boot must NOT let autosave / Save Now overwrite its bytes
   * (issue #196). Corrupt / absent saves get no such protection — the new game's
   * first autosave overwrites them freely.
   *
   * Async because classifySaveCompatibility now awaits the storage driver (#234);
   * create() fires this and returns (it can't await). Callbacks that touch async
   * save fns fire-and-forget (`void`), preserving each fn's own try/catch.
   */
  private async dispatchInitialBoot(): Promise<void> {
    const saveCompat = await classifySaveCompatibility();
    const bootMode = decideBootMode(() => saveCompat === 'compatible');
    if (bootMode === 'prompt') {
      this.gamePhase = GamePhase.SavePrompt;
      const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
      uiScene.showSavePromptOverlay({
        onContinue: () => void this.bootFromSave(),
        onNewGame: () => {
          void deleteSave();
          this.showDifficultySelectThenBoot();
        },
      });
    } else {
      this.showDifficultySelectThenBoot(saveCompat === 'incompatible-future');
    }
  }

  /**
   * Clear every piece of per-session state that lives on the GameScene
   * instance or on module-level singletons shared with input handlers.
   *
   * Must be called at the start of bootFresh AND bootFromSave, even on the
   * first boot. restartGame reaches this via bootFresh. The authoritative
   * invariants after this returns:
   *   - inputLog is empty — (seed, inputLog) describes the new session only
   *   - viewState is back to the surface default (first-visit flag cleared)
   *   - no in-flight pan / drag / dig / entrance-preview state leaks across
   *   - contextMenuState is hidden
   *   - lastActiveView diff sentinel is cleared so the next frame re-syncs
   *   - speedMultiplier is back to 1x (Phase 4 fresh-boot contract) — save
   *     files don't persist speed, so continue-from-save also restarts at 1x
   *
   * All mutations are in-place so references already captured by UIScene
   * and by the gesture arbiter / registerDragPan stay valid. Reassigning would
   * strand those references (same failure class as the stale-world bug fixed
   * earlier in Phase 9). The pause-reason set is cleared entirely here.
   */
  private resetSessionState(): void {
    resetInputLog(this.inputLog);
    resetViewState(this.viewState, PLAYER_START_X, PLAYER_START_Y);
    // Stage 1 controls rework (issue #18): abandon any in-flight gesture and
    // clear the whole pause-reason set so a new game can't inherit a stuck
    // 'menu'/'user' pause (Codex R2-1). Hover outline + cursor caches reset too.
    this.arbiter.cancelGesture();
    clearAllPauseReasons(this.pauseReasons);
    this.hoverScreenX = null;
    this.hoverScreenY = null;
    this.lastCursorTool = null;
    this.lastCursorView = null;
    resetDragState(this.dragState);
    resetPanInputState();
    hideContextMenu();
    this.lastActiveView = null;
    this.currentOutcome = GameOutcome.None;
    this.currentCause = null;
    this.setSpeedMultiplier(1);
    // Re-enable autosave for the next session. The flag is set only by
    // bootFromSave's deserialize-throw catch (see issue #66 in the field
    // doc); a fresh start via restartGame should resume normal autosave.
    this.autosaveSuspended = false;
    this.resumedFromSave = false;
    // tick.ts owns entrance/dig/chamber flow-field scratch per-world (issue
    // #160): each WorldState gets its own caches, so bootFresh/bootFromSave
    // already start the new world with empty caches and this call is no longer
    // required for cross-world correctness. Kept as an explicit teardown that
    // drops the retired session's cache eagerly rather than waiting for GC.
    resetFlowFieldCaches();
    // SyncAIState change-detection cache: must be cleared alongside flow-field caches so an
    // in-session bootFromSave whose loaded aiState matches the stale prior-session cache
    // doesn't suppress the first-tick SyncAIState, which would cause inputLog to diverge
    // from a fresh-page replay of the same save.
    resetAIControllerCache();
    // Render-only ant-facing smoothing: same rationale as the flow-field
    // caches. The AntFacingCache is keyed by ant id, and the new session
    // reuses ids 0..N from scratch — a stale heading from the prior session
    // would lock a freshly-spawned ant into the prior ant's direction until
    // the smoothing relaxes. Clearing here keeps boot visually clean.
    this.antFacingCache.reset();
    // #236 PR1 — a new session replaces the pheromone grids (and tick resets), so
    // force a pheromone-layer redraw next frame rather than trusting a coincidental
    // tick match against the prior session.
    this.lastPheromoneTick = -1;
    // S6 — reset per-session render-side scratch.
    this.lastProcessedEventTick = -1;
    this.prevQueenCombinedHp = null;
    this.queenStarvationTriggered = false;
    this.contestedGlowFrames.clear();
    this.undergroundGlowFrames.clear();
    resetCaptions();
    // Stage 3b (#3): reset the per-session first-world-input latch so the
    // proactive [Tab] nudge can re-evaluate on a fresh round (the cross-session
    // shown-flags persist in settings and are NOT cleared here).
    resetFirstUseSession();
    // Stage 3b (ship-review R1#1/#3): UIScene survives round restarts, so clear
    // its caption queue + any in-flight caption here too — otherwise a prior
    // round's queued caption can surface (and falsely mark a hint shown) in the
    // new game. No-op before UIScene exists (first boot).
    this.getUIScene()?.resetCaptionsForRound();
    // Issue #122 — rotate the session UUID so each (re)start gets its own
    // telemetry row server-side.
    //
    // Note: we intentionally do NOT cancel any in-flight playtrace upload
    // here. The end-of-game survey flow is fire-and-forget: onSubmit kicks
    // off submitPlaytrace AND then calls restartGame, which routes through
    // this method. Cancelling the upload here would race-cancel the very
    // request we just dispatched, dropping the survey row server-side.
    // The single-in-flight discipline is instead enforced inside
    // submitPlaytrace itself — each new submission cancels its predecessor.
    this.playtraceSessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '';
  }

  // ---------------------------------------------------------------------------
  // S6 — render-side event cursor and queen status checks
  // ---------------------------------------------------------------------------

  /**
   * Drain world.events from the last-seen index, dispatching each new event
   * to render-side effects (screen flash, camera nudge, captions).
   * Called once per render frame while Playing.
   */
  private consumeEventsForRender(): void {
    if (!this.world) return;
    const events = this.world.events;
    if (events.length === 0) return;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9 | null;

    // Use tick-based filtering rather than an array-index cursor. The event
    // buffer evicts old combat_kills via splice when it reaches capacity, which
    // shifts array indices and makes a length-based cursor stale. Tick-based
    // filtering is invariant to splice position because structural events
    // (invasion_start, spider_rampage_start, etc.) are never evicted.
    //
    // Safety of `ev.tick <= lastProcessedEventTick` (strict skip on boundary tick):
    // All sim ticks for a render frame complete synchronously before this method
    // runs. A tick N emits all its events in one call; there is no mechanism for
    // a tick-N event to arrive in a later render frame. Same-tick events are
    // therefore always fully present when we first scan that tick, and
    // `lastProcessedEventTick` only advances after all of them are processed.
    // `resetSessionState()` is the only path that resets this field to -1.
    let maxTickSeen = this.lastProcessedEventTick;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.tick <= this.lastProcessedEventTick) continue;
      if (ev.tick > maxTickSeen) maxTickSeen = ev.tick;

      if (ev.type === 'invasion_start') {
        // Screen-edge flash in the direction of the invasion entrance.
        const playerColony = this.world.colonies[PLAYER_COLONY_ID];
        const queenChamber = playerColony?.chambers.find(
          (ch) => ch.chamberType === ChamberType.Queen,
        );
        if (queenChamber) {
          const queenTileX = queenChamber.posX >> 8;
          const queenTileY = queenChamber.posY >> 8;
          const direction = inferFlashDirection(
            queenTileX,
            queenTileY,
            ev.payload.rallyTile?.x ?? queenTileX,
            ev.payload.rallyTile?.y ?? queenTileY,
          );
          uiScene?.triggerScreenEdgeFlash(direction);
        } else {
          uiScene?.triggerScreenEdgeFlash('right');
        }
        // Caption #7: AI invasion (one-shot, via the event→caption policy). Pass
        // the one-shot key so a dropped caption un-marks and re-fires.
        const captionText = captionForEvent(ev.type);
        if (captionText && uiScene) {
          uiScene.showCaption(
            captionText,
            this.layout.w / 2,
            60,
            oneShotKeyForEvent(ev.type) ?? undefined,
          );
        }
      }

      if (ev.type === 'spider_rampage_start') {
        // Spider rampage caption: fires on EVERY rampage, not just the first.
        // The recurring-vs-one-shot decision lives in captionForEvent; the
        // spider is surface-only now (#146/#176/#177) so the copy no longer
        // mentions tunnels. No one-shot key — recurring captions never dedup.
        const captionText = captionForEvent(ev.type);
        if (captionText && uiScene) {
          uiScene.showCaption(captionText, this.layout.w / 2, 60);
        }
      }

      if (ev.type === 'ai_state_transition' && ev.payload.to === 'Invading') {
        // Belt-and-suspenders: invasion_start is the primary trigger above.
        // This handles any Invading transition not paired with invasion_start.
        // Gate flash + caption on checkAndTrigger so they fire exactly once:
        // when invasion_start already fired the caption this pass, captionText
        // is null and neither flash nor caption fires again here.
        const captionText = checkAndTrigger('aiInvading');
        if (captionText) {
          uiScene?.triggerScreenEdgeFlash('right');
          if (uiScene) uiScene.showCaption(captionText, this.layout.w / 2, 60, 'aiInvading');
        }
      }
    }

    this.lastProcessedEventTick = maxTickSeen;
  }

  /**
   * Check per-frame world state for queen damage pulse and starvation onset.
   * Also fires world-state-based captions (spider visible, spiderPriority, etc.).
   * Called once per render frame while Playing.
   */
  private checkQueenStatusForEffects(): void {
    if (!this.world) return;
    const playerColony = this.world.colonies[PLAYER_COLONY_ID];
    if (!playerColony) return;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9 | null;

    // Queen damage pulse.
    const queenId = playerColony.queenEntityId;
    const hp = this.world.ants.hp[queenId] ?? 0;
    const bonusHp = this.world.ants.homeGroundBonusHp[queenId] ?? 0;
    const combinedHp = hp + bonusHp;
    if (
      this.prevQueenCombinedHp !== null &&
      combinedHp < this.prevQueenCombinedHp &&
      this.world.tick > QUEEN_DAMAGE_SUPPRESS_TICKS
    ) {
      triggerQueenDamagePulse(this.cameras.main);
      // Caption #9: first queen damage.
      const captionText = checkAndTrigger('queenDamage');
      if (captionText && uiScene) {
        uiScene.showCaption(captionText, this.layout.w / 2, this.layout.h / 2 - 40, 'queenDamage');
      }
    }
    this.prevQueenCombinedHp = combinedHp;

    // Starvation onset. The timer starts at STARVATION_GRACE_TICKS (300) and
    // decrements only when the queen fails to eat; < STARVATION_GRACE_TICKS means
    // at least one feeding failed (starvation has actually started).
    if (
      !this.queenStarvationTriggered &&
      playerColony.queenStarvationTimer < STARVATION_GRACE_TICKS &&
      this.world.tick > QUEEN_DAMAGE_SUPPRESS_TICKS
    ) {
      this.queenStarvationTriggered = true;
      triggerQueenDamagePulse(this.cameras.main);
      // Caption #10: queen starvation onset.
      const captionText = checkAndTrigger('queenStarvation');
      if (captionText && uiScene) {
        uiScene.showCaption(
          captionText,
          this.layout.w / 2,
          this.layout.h / 2 - 40,
          'queenStarvation',
        );
      }
    }

    // World-state-based captions.
    // Gate spider caption on Hunting/Striking — spider exists from tick 0 while
    // Patrolling, so triggering on mere existence fires before any visible threat.
    const spiderState = this.world.spider?.state;
    if (spiderState === 'Hunting' || spiderState === 'Striking') {
      const captionText = checkAndTrigger('spider');
      if (captionText && uiScene) {
        uiScene.showCaption(captionText, this.layout.w / 2, 60, 'spider');
      }
    }
    if (this.world.spiderPriorityColonyId !== null) {
      const captionText = checkAndTrigger('spiderPriority');
      if (captionText && uiScene) {
        uiScene.showCaption(captionText, this.layout.w / 2, 60, 'spiderPriority');
      }
    }
  }

  private bootFresh(difficulty: 'Easy' | 'Normal' | 'Hard' = 'Normal'): void {
    this.resetSessionState();
    this.currentDifficulty = difficulty;
    // W1: seed formula — Date.now() is ~1.7e12, exceeds int32. Bitmask-clamp to positive int32.
    // Bitwise ops truncate to int32; 0x7fffffff mask ensures sign bit is clear.
    const seed = generateFreshSeed(Date.now());
    this.currentSeed = seed;
    // createScenario creates BOTH colonies (PLAYER_COLONY_ID + ENEMY_COLONY_ID) unconditionally.
    this.world = createScenario(seed, difficulty);
    this.finishBoot();
  }

  // S5 — show difficulty selector then boot. Used for every new-game path.
  // Sets gamePhase to SavePrompt so update() returns early (line ~913 guard)
  // before this.gameLoop is initialized by bootFresh → finishBoot.
  //
  // preserveFutureSave (issue #196): true only when the fresh boot was chosen
  // because the existing save is a recoverable future-build save
  // (simVersion > LATEST). In that case, arm autosaveSuspended AFTER bootFresh
  // so autosave + Save Now don't clobber the preserved bytes — mirroring
  // bootFromSave's FutureSimVersionError catch on the Continue path. The flag
  // MUST be set after bootFresh because resetSessionState (run inside it)
  // clears it. Corrupt-save / explicit New Game callers pass false (default)
  // and overwrite freely.
  private showDifficultySelectThenBoot(preserveFutureSave = false): void {
    this.gamePhase = GamePhase.SavePrompt;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.showDifficultySelectOverlay({
      onSelect: (d) => {
        this.bootFresh(d);
        if (preserveFutureSave) {
          // Set after bootFresh — resetSessionState clears the flag.
          this.autosaveSuspended = true;
        }
      },
    });
  }

  private async bootFromSave(): Promise<void> {
    const loaded = await loadSave();
    if (loaded === null) {
      // Corrupt save: fall through to fresh (bootFresh runs its own reset)
      await deleteSave();
      this.bootFresh();
      return;
    }
    // Reset BEFORE restoring so the new session starts from a clean slate,
    // then restore exactly the persisted inputLog. Without the reset, any
    // commands already in memory (from a prior session on the same scene
    // instance) would concatenate with loaded.inputLog and break replay truth.
    this.resetSessionState();
    // Plan 04 SaveFile shape: { version, seed, inputLog, snapshot }
    // Issue #65/#66 — deserializeWorldState throws for two distinct cases:
    //
    //   1. FutureSimVersionError — simVersion > LATEST. The save was written
    //      by a NEWER build (rollback / cached-older-client) and is intact;
    //      this build just doesn't know the gate semantics. Preserve the
    //      bytes (don't deleteSave) AND suspend autosave for the session
    //      so a fresh game's progress doesn't overwrite the preserved save.
    //      User can recover by reloading on the newer build.
    //
    //   2. Plain Error — definitively corrupt (tampered ants.count, malformed
    //      snapshot/ants shape, simVersion < LEGACY). No future build can
    //      load this — bytes are gibberish. Delete the save so subsequent
    //      Continue prompts don't loop the user through forced fresh boots
    //      with autosave suspended (per codex P1 on PR #88: that loop
    //      causes silent total progress loss when the tab closes).
    //
    // The asymmetry mirrors the null path above (loaded === null → delete:
    // envelope structurally broken, no recovery possible).
    let nextWorld: WorldState;
    try {
      nextWorld = deserializeWorldState(loaded.snapshot);
    } catch (err) {
      if (err instanceof FutureSimVersionError) {
        this.bootFresh();
        // Set after bootFresh — resetSessionState clears the flag.
        this.autosaveSuspended = true;
        return;
      }
      if (err instanceof OldSimVersionError) {
        // Pre-V22 save — no migration path; discard and start fresh.
        console.error(err.message);
        await deleteSave();
        this.bootFresh();
        return;
      }
      // Genuine corruption: discard so we don't loop the user.
      await deleteSave();
      this.bootFresh();
      return;
    }
    this.currentSeed = loaded.seed;
    this.world = nextWorld;
    this.currentDifficulty = nextWorld.difficulty; // S5 — restore difficulty from save
    this.resumedFromSave = true;
    // Seed the render event cursor from the saved world so the first render
    // frame after resume doesn't replay historical events as new and re-fire
    // screen flashes / captions for invasions that already happened.
    if (nextWorld.events.length > 0) {
      this.lastProcessedEventTick = nextWorld.events.reduce(
        (m, e) => (e.tick > m ? e.tick : m),
        -1,
      );
    }
    // If the queen's starvation timer was already running at save time, mark the
    // starvation caption as triggered so the first render frame after resume does
    // not fire a spurious flash + onboarding caption for a condition that already
    // started before the save.
    const playerColonyOnLoad = nextWorld.colonies[PLAYER_COLONY_ID];
    if (playerColonyOnLoad && playerColonyOnLoad.queenStarvationTimer < STARVATION_GRACE_TICKS) {
      this.queenStarvationTriggered = true;
    }
    // SCEN-06 replay truth: restore inputLog completely so the continued session
    // can be replayed byte-for-byte from (seed, inputLog) per Plan 04 Task 1.
    for (const c of loaded.inputLog) this.inputLog.push(c);
    this.finishBoot();
  }

  private finishBoot(): void {
    // Stage 2 §B: a fresh/loaded world must rebake every allocated terrain RT (the prior
    // session's RTs are stale). Optional chaining — finishBoot can run before create() has
    // instantiated the cache in some boot orderings; the first frame then lazily bakes.
    this.terrainCache?.invalidateAll();

    this.prevState = createScenario(this.currentSeed, this.currentDifficulty);
    copyWorldState(this.world, this.prevState);

    // B1: world.colonies is a PLAIN OBJECT per ADR-0006.
    // Use Object.keys — NEVER .keys()/.entries()/.get() (those are Map APIs).
    this.aiColonyIds = deriveAIColonyIds(this.world, PLAYER_COLONY_ID);

    this.gameLoop = createGameLoop(tick, this.world, {
      onBeforeTick: (w) => {
        // Run AI for all AI colonies FIRST (AI commands enqueued before drain)
        for (const aiCid of this.aiColonyIds) {
          runAIController(w, aiCid);
        }
        // Then snapshot prevState for render interpolation
        copyWorldState(w, this.prevState);
      },
      onAfterDrain: (cmds) => {
        // SCEN-06 replay truth: never truncate — appendInputLog handles all commands
        appendInputLog(this.inputLog, cmds);
        // S6: fire first-occurrence captions for player command types.
        const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9 | null;
        for (const cmd of cmds) {
          // Only fire onboarding captions for player-issued commands; AI colonies
          // enqueue commands in the same drain pass and would consume captions early.
          if ('colonyId' in cmd && cmd.colonyId !== PLAYER_COLONY_ID) continue;
          if (cmd.type === 'MarkDigTile') {
            const text = checkAndTrigger('dig');
            if (text && uiScene)
              uiScene.showCaption(text, this.layout.w / 2, this.layout.h - 80, 'dig');
          } else if (cmd.type === 'PlaceChamber') {
            const chamberTypeLabel: Record<number, string> = {
              [ChamberType.Queen]: 'Queen',
              [ChamberType.Nursery]: 'Nursery',
              [ChamberType.FoodStorage]: 'Food Storage',
            };
            const chamberTypeName =
              chamberTypeLabel[cmd.chamberType] ?? `chamber type ${cmd.chamberType}`;
            const text = checkAndTrigger('chamber', chamberTypeName);
            if (text && uiScene)
              uiScene.showCaption(text, this.layout.w / 2, this.layout.h - 80, 'chamber');
          } else if (cmd.type === 'MarkFoodPile') {
            const text = checkAndTrigger('foodMark');
            if (text && uiScene)
              uiScene.showCaption(text, this.layout.w / 2, this.layout.h - 80, 'foodMark');
          } else if (cmd.type === 'SetRallyPoint') {
            const text = checkAndTrigger('rally');
            if (text && uiScene)
              uiScene.showCaption(text, this.layout.w / 2, this.layout.h - 80, 'rally');
          }
        }
      },
      onTickOutcome: (outcome) => {
        this.currentOutcome = outcome;
        this.gamePhase = GamePhase.GameOver;
        // W2: first-class pause via Plan 06 Task 1 API — no setMsPerTick(Infinity)
        this.gameLoop.pause();
        // Issue #129 — clear any in-flight pan/drag/gesture so it doesn't leak
        // into the GameOver overlay state (the middle-button drag-pan handlers
        // are independent of processCameraInput and otherwise fire unguarded; the
        // gesture arbiter must also abandon any pending tap/paint/pan).
        this.arbiter.cancelGesture();
        resetPanInputState();
        resetDragState(this.dragState);

        // Extract death cause from the first queen_death event emitted this tick.
        // Forward scan: player is added to diedThisTick first, so the player's event
        // comes before enemy events — Defeat gives the player's cause, Victory gives
        // the enemy's. Tick filter prevents stale events from earlier ticks matching.
        // world.tick was incremented at step 19 (tick.ts) after checkQueenDeath (step 18),
        // so the queen_death event carries world.tick - 1.
        const deathTick = (this.world?.tick ?? 1) - 1;
        const evts = this.world?.events ?? [];
        let cause: import('./ui-scene-logic.js').QueenDeathCause = null;
        for (let i = 0; i < evts.length; i++) {
          const ev = evts[i];
          if (ev && ev.type === 'queen_death' && ev.tick === deathTick) {
            cause = ev.payload.cause;
            break;
          }
        }
        this.currentCause = cause;

        // S6: build narrative for the loss screen.
        const outcomeLabel: GameOutcomeLabel | undefined =
          outcome === GameOutcome.Victory
            ? 'Victory'
            : outcome === GameOutcome.Defeat
              ? 'Defeat'
              : outcome === GameOutcome.MutualDestruction
                ? 'MutualDestruction'
                : undefined;
        const summary = buildPlaytraceSummary(this.world, this.resumedFromSave, outcomeLabel);
        const narrativeSeed = summary.outcomeAttribution.narrativeSeed;

        const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
        // Issue #122 — when the playtrace feature is enabled, the survey
        // overlay replaces the bare game-over panel at end-of-game. Skip
        // from the survey transitions to restart, matching the prior UX.
        // When the feature is off, fall back to the original game-over
        // overlay so the open-source build's behavior is unchanged.
        if (this.playtraceEndpoint !== '') {
          this.openSurveyOverlay(false /* quitFromPauseMenu */);
        } else {
          uiScene.showGameOverOverlay(outcome, cause, () => this.restartGame(), narrativeSeed);
        }
      },
      getMsPerTick: () => MS_PER_TICK / this.speedMultiplier,
    });

    this.gamePhase = GamePhase.Playing;
    this.gameLoop.resume(); // ensure running (createGameLoop default is not paused)
    this.lastAutosaveMs = performance.now();
    // UIScene and world-input handlers resolve `this.world` lazily via the
    // getWorld accessor installed in create(), so the new reference is picked
    // up automatically on bootFresh, bootFromSave, and restartGame.
  }

  // ---------------------------------------------------------------------------
  // Issue #116 — pause menu open/close
  //
  // Opens the UIScene pause-menu overlay AND pauses the game loop in one
  // gesture; closing reverses both. Phase transitions are gated through
  // gamePhase so concurrent SavePrompt / GameOver phases don't get clobbered
  // (the Esc handler also early-returns in those phases as a belt-and-braces
  // guard).
  // ---------------------------------------------------------------------------

  /**
   * Round-2 review: the openPauseMenu callbacks were duplicated inline
   * inside openSaveLoadDialog's onBack — silent drift waiting to happen
   * when a future change adds an entry to one but not the other. This
   * helper is the single source of truth for what callbacks the menu
   * receives; both call sites pass through it.
   */
  private buildPauseMenuCallbacks(): {
    onResume: () => void;
    onDownloadDebug: () => void;
    onOpenSaveLoad: () => void;
    getSpeedMultiplier: () => 1 | 2 | 4;
    onCycleSpeed: (next: 1 | 2 | 4) => void;
    onQuitAndSurvey?: () => void;
  } {
    const cb: ReturnType<GameScene['buildPauseMenuCallbacks']> = {
      onResume: () => this.closePauseMenu(),
      onDownloadDebug: () => {
        if (this.world === undefined) return;
        const snap = buildDebugSnapshot(this.world, this.currentSeed, this.inputLog);
        downloadDebugSnapshot(snap);
      },
      onOpenSaveLoad: () => this.openSaveLoadDialog(),
      // Issue #114 UAT — read/write the live speedMultiplier so the menu's
      // Settings sub-screen has parity with the 1/2/4 keyboard shortcuts.
      // The shortcuts are Playing-only-gated; the menu surface gives the
      // same control a discoverable home while paused.
      getSpeedMultiplier: () => this.speedMultiplier,
      onCycleSpeed: (next: 1 | 2 | 4) => {
        this.setSpeedMultiplier(next);
      },
    };
    // Issue #122 — only attach onQuitAndSurvey when the feature flag is on.
    // The pause menu treats `undefined` as "hide the row" so an open-source
    // build with no endpoint set never even sees the affordance.
    if (this.playtraceEndpoint !== '') {
      cb.onQuitAndSurvey = () => this.openSurveyOverlay(true /* quitFromPauseMenu */);
    }
    return cb;
  }

  /** Issue #122 — open the survey overlay. Called at end-of-game (when
   *  the feature flag is on; falls back to game-over overlay otherwise)
   *  and from the pause menu's "Quit & feedback" entry. The survey
   *  collects rating / free-text / brokenFlag / upload opt-in, then dispatches
   *  the upload and transitions to a confirmation screen with New Game / Retry.
   *  Issue #131: onSkip replaced by onNewGame + onRetry from the confirmation. */
  private openSurveyOverlay(quitFromPauseMenu: boolean): void {
    if (this.world === undefined) return; // pre-boot guard
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    // Capture the values the survey needs BEFORE handing control away.
    // The submission flow is async; meanwhile the player will start the
    // next session and the live references would otherwise change beneath us.
    const outcome = this.currentOutcome;
    // Capture seed now — retryGame() needs it but resetSessionState runs first.
    const retrySeed = this.currentSeed;
    // Issue #131 — when opened from the pause menu's "Quit & feedback" action,
    // dismiss the pause menu and transition to GameOver. GameOver is the
    // correct semantic state: the player has quit, the loop is already paused,
    // and the survey/confirmation overlay is functionally equivalent to a
    // game-over overlay. This also enables the GameOver keyboard-suppression
    // guard (issue #129) so WASD/Space don't fire under the survey here either.
    if (quitFromPauseMenu) {
      uiScene.hidePauseMenuOverlay();
      this.gamePhase = GamePhase.GameOver;
    }
    uiScene.showSurveyOverlay({
      quitFromPauseMenu,
      outcome: quitFromPauseMenu ? undefined : outcome,
      cause: quitFromPauseMenu ? undefined : this.currentCause,
      onSubmit: (survey) => {
        // Capture the live world / seed / inputLog right now, before the
        // restart path overwrites them. The snapshot is built lazily
        // inside submitPlaytrace's downgrade loop, so we still need the
        // live world reference there.
        const world = this.world;
        const seed = this.currentSeed;
        // Deep copy of the inputLog. `structuredClone` covers nested
        // objects (e.g. SetBehaviorRatio.ratio: { forage, fight }) that a
        // shallow `{...c}` would still share by reference with the live
        // array. resetSessionState clears the live array shortly after;
        // a shared nested reference would let that clear corrupt the
        // in-flight payload.
        const inputLogCopy: SimCommand[] = this.inputLog.map((c) => structuredClone(c));
        // The ADR contract requires outcome to be one of Victory / Defeat /
        // MutualDestruction on the wire — `None` is not a valid value. The
        // pause-menu-quit path may fire with a live queen (outcome=None), so
        // treat that as a concession and map to Defeat. quitFromPauseMenu
        // remains true on the envelope so the receiver can distinguish a
        // "player abandoned" run from an actual queen-death defeat.
        const wireOutcome: GameOutcome =
          outcome === GameOutcome.None ? GameOutcome.Defeat : outcome;
        if (world !== undefined) {
          // Issue #131: Fire-and-forget. The overlay now stays open showing the
          // confirmation screen; onNewGame / onRetry handle the actual restart.
          // cancelInFlight in resetSessionState handles abort if restart fires
          // before the request completes.
          void submitPlaytrace({
            endpoint: this.playtraceEndpoint,
            sessionId: this.playtraceSessionId,
            outcome: wireOutcome,
            quitFromPauseMenu,
            includeSnapshot: survey.includeSnapshot,
            world,
            seed,
            inputLog: inputLogCopy,
            resumedFromSave: this.resumedFromSave,
            survey: {
              rating: survey.rating,
              freeText: survey.freeText,
              brokenFlag: survey.brokenFlag,
            },
          });
        }
        // Do NOT call restartGame here — overlay transitions to confirmation
        // screen; the player clicks New Game or Retry from there.
      },
      onNewGame: () => {
        this.restartGame();
      },
      onRetry: () => {
        this.retryGame(retrySeed);
      },
    });
  }

  /** Issue #131 — restart the game with the same seed the player just lost on.
   *  Mirrors restartGame() but skips generateFreshSeed, using the captured
   *  seed instead so the player gets the exact same map to retry. */
  private retryGame(seed: number): void {
    const wasSuspended = this.autosaveSuspended;
    if (!wasSuspended) {
      void deleteSave();
    }
    this.currentOutcome = GameOutcome.None;
    this.currentCause = null;
    this.resetSessionState();
    this.currentSeed = seed;
    // S5: retry preserves the previous game's difficulty (same seed + same difficulty).
    this.world = createScenario(seed, this.currentDifficulty);
    this.finishBoot();
    if (wasSuspended) {
      this.autosaveSuspended = true;
    }
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.hideGameOverOverlay();
  }

  // ---------------------------------------------------------------------------
  // Stage 1 controls rework (issue #18) — pause reason reconciliation
  //
  // The render loop is paused iff ANY reason is set (pause-reasons.ts). Two
  // reasons pause independently: 'user' (Space / ⏸) and 'menu' (Esc overlay).
  // reconcilePause() maps the set to the imperative gameLoop.pause()/resume() and
  // keeps gamePhase in sync (Paused iff any reason set, while Playing-eligible).
  // Pausing here never touches speedMultiplier (Codex R2-11). The Esc-driven
  // overlays toggle 'menu'; Space/⏸ toggle 'user'. resetSessionState clears all.
  // ---------------------------------------------------------------------------

  /**
   * Map GameScene's state to the hotkey-policy phase string. A BARE 'user' pause
   * (Space / ⏸ with no Esc overlay open) reports 'playing' so Space can un-pause
   * and speed/tool hotkeys still work while user-paused — the loop being frozen
   * is not a modal. Only GameOver / SavePrompt / a 'menu'-driven overlay report a
   * non-playing phase that blocks world hotkeys.
   */
  private hotkeyPhase(): HotkeyGamePhase {
    if (this.gamePhase === GamePhase.GameOver) return 'gameover';
    if (this.gamePhase === GamePhase.SavePrompt) return 'saveprompt';
    // Paused-by-menu blocks; paused-by-user-only does not.
    if (this.pauseReasons.menu) return 'paused';
    return 'playing';
  }

  /**
   * True if a modal overlay (Esc pause menu / Save-Load dialog / survey /
   * game-over / save-prompt) is up. A bare 'user' pause is NOT a modal.
   */
  private isModalOpen(): boolean {
    if (this.gamePhase === GamePhase.GameOver || this.gamePhase === GamePhase.SavePrompt) {
      return true;
    }
    return this.pauseReasons.menu;
  }

  /**
   * canAcceptWorldHotkey — the single gate for 1/2/3 (tools), the speed keys,
   * Space (user pause), Tab (view toggle), and X/P. Delegates to the pure policy
   * predicate (hotkey-policy.ts) with today's flag values.
   */
  private canAcceptWorldHotkey(): boolean {
    return canAcceptWorldHotkey({
      gamePhase: this.hotkeyPhase(),
      modalOpen: this.isModalOpen(),
      contextMenuVisible: contextMenuState.visible,
      contextMenuPendingShow: contextMenuState.pendingShow,
      contextMenuPendingHide: contextMenuState.pendingHide,
      antActivityPanelVisible: antActivityPanelState.visible,
      antActivityPanelPendingHide: antActivityPanelState.pendingHide,
    });
  }

  /**
   * selectTool — set the active input tool from a hotkey / palette click. Gated
   * by canAcceptWorldHotkey. Chamber is underground-only: selecting it on the
   * surface is a no-op (PLAN §A1/A4). Cancels any in-flight gesture and a deferred
   * context-menu show on a tool transition (Codex R4-2).
   */
  private selectTool(tool: ToolId): void {
    if (!this.canAcceptWorldHotkey()) return;
    if (tool === 'chamber' && this.viewState.activeView !== 'underground') return;
    if (this.viewState.activeTool === tool) return;
    this.viewState.activeTool = tool;
    // A tool change must abort any pending tap / paint / pan and cancel a menu
    // that was about to appear under the old tool.
    this.arbiter.cancelGesture();
    if (contextMenuState.pendingShow) hideContextMenu();
  }

  /** Reconcile the pause-reason set to the game loop + gamePhase. */
  private reconcilePause(): void {
    // Never override the terminal/transitional phases — GameOver/SavePrompt own
    // the loop, and bootFromSave/restart flip Playing themselves.
    if (this.gamePhase === GamePhase.GameOver || this.gamePhase === GamePhase.SavePrompt) {
      return;
    }
    if (isPausedByAny(this.pauseReasons)) {
      this.gamePhase = GamePhase.Paused;
      this.gameLoop.pause();
    } else {
      this.gamePhase = GamePhase.Playing;
      this.gameLoop.resume();
    }
  }

  /** Space / ⏸ — edge-triggered toggle of the 'user' pause reason. */
  private toggleUserPause(): void {
    togglePauseReason(this.pauseReasons, 'user');
    // Toggling 'user' off while 'menu' is still set must NOT resume — the menu is
    // still up. reconcilePause handles that (paused iff any reason set). But if
    // the 'menu' reason is set we should leave the menu chrome alone; Space only
    // moves the 'user' bit.
    this.reconcilePause();
  }

  private openPauseMenu(): void {
    if (this.gamePhase !== GamePhase.Playing && this.gamePhase !== GamePhase.Paused) return;
    // Codex P1 (PR #210): cancel any in-flight left gesture as the modal opens.
    // The arbiter checks canPan/canEditWorld only at drag CLASSIFICATION; once a
    // pan/paint is in flight, panMove/paintMove don't re-gate, so without this an
    // active drag would keep panning the camera / enqueuing dig marks behind the
    // pause menu, and a pending tap could survive an open→close and fire on
    // release. Mirrors the GameOver and resetSessionState cancel paths.
    this.arbiter.cancelGesture();
    // Codex P2: also reset the MIDDLE-button drag-pan synchronously. cancelGesture
    // only clears the LEFT arbiter; registerDragPan's dragState.active and
    // panInputState.isPanning stay set, and its modal gate (isBlocked → releaseDrag)
    // only clears them on the NEXT pointermove. So opening + closing the menu via
    // Esc WITHOUT moving, while still holding the middle button, would let the next
    // movement resume the old drag and apply the accumulated delta as a camera jump.
    // Clearing both here makes the suspend synchronous with the modal open.
    resetDragState(this.dragState);
    resetPanInputState();
    setPauseReason(this.pauseReasons, 'menu');
    this.reconcilePause();
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.showPauseMenuOverlay(this.buildPauseMenuCallbacks());
  }

  private closePauseMenu(): void {
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.hidePauseMenuOverlay();
    uiScene.hideSaveLoadDialogOverlay();
    // Esc-close clears ONLY the 'menu' reason; a concurrent Space ('user') pause
    // survives (Codex R1-5). reconcilePause resumes only if no reason remains.
    clearPauseReason(this.pauseReasons, 'menu');
    this.reconcilePause();
  }

  // Issue #115 — opens the Save/Load dialog on top of the pause menu. Hides
  // the menu first so the dialog has the canvas to itself; Back re-shows
  // the menu via openPauseMenu's flow path. The game stays Paused throughout
  // — Continue / New Game are the only paths that resume the loop.
  private openSaveLoadDialog(): void {
    if (this.gamePhase !== GamePhase.Paused) return;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    // Hide the menu before showing the dialog so the menu's button rects
    // don't bleed through hit-testing while the dialog is up.
    uiScene.hidePauseMenuOverlay();
    uiScene.showSaveLoadDialogOverlay({
      onContinue: () => {
        // bootFromSave does its own resetSessionState + finishBoot, including
        // gameLoop.resume(). We just need to flip out of Paused phase first
        // so finishBoot's `gamePhase = Playing` overwrite is consistent.
        this.gamePhase = GamePhase.Playing;
        void this.bootFromSave();
      },
      onNewGame: () => {
        // restartGame deletes the existing save (preserving the issue #66
        // guard) and bootFreshes; finishBoot resumes the loop and flips to
        // Playing. Set Playing here too so the transitional moment between
        // dialog dismissal and finishBoot doesn't observe a dangling Paused.
        this.gamePhase = GamePhase.Playing;
        this.restartGame();
      },
      onSaveNow: async () => {
        if (this.world === undefined) return false;
        // Round-5 P1 (Codex): bootFromSave sets autosaveSuspended = true when
        // it catches a FutureSimVersionError so the preserved newer-build
        // save bytes survive in localStorage for recovery (user reloads on
        // a newer build that knows the simVersion). The tickAutosave path
        // already respects this flag (see update() below). The dialog's
        // Save Now must respect it too — without this gate a manual save
        // from the fall-through fresh session silently destroys those
        // preserved bytes. Surface as a failed save so the player gets a
        // flash and can recover via Delete / a newer-build reload.
        if (this.autosaveSuspended) return false;
        const ok = await manualSave(this.currentSeed, this.inputLog, this.world);
        // Round-2 review: bump the autosave cooldown so the next autosave
        // window doesn't fire seconds later and overwrite the manual save's
        // timestamp. The dialog's "Saved 15:32" line otherwise jumps to
        // 15:33 the next time the player opens it, with no action of theirs.
        if (ok) this.lastAutosaveMs = performance.now();
        return ok;
      },
      onDelete: () => {
        // Issue #196 (Codex P2): the dialog just deleted the save. If autosave
        // was suspended to preserve a future-build save's bytes, that reason is
        // gone now — clear the flag so the running fresh session can save and
        // autosave normally again (otherwise onSaveNow keeps returning false and
        // the autosave guard skips every write until a page reload).
        this.autosaveSuspended = false;
      },
      onBack: () => {
        // Re-open the pause menu — gamePhase is still Paused, gameLoop is
        // still paused, so this just restores the menu chrome. Same callback
        // payload as the initial openPauseMenu via the shared helper.
        uiScene.showPauseMenuOverlay(this.buildPauseMenuCallbacks());
      },
    });
  }

  private restartGame(): void {
    // Issue #66 — capture suspend state BEFORE bootFresh (which clears it
    // via resetSessionState). Two distinct flows:
    //
    //   - autosaveSuspended === false (normal restart): delete the save
    //     so the new game starts clean; autosave resumes naturally.
    //   - autosaveSuspended === true (restart inside a future-build
    //     preserved-save session): do NOT delete — the localStorage bytes
    //     belong to a save the user can recover by reloading on the newer
    //     build; restartGame must not destroy them. Re-suspend autosave
    //     after bootFresh so the new fresh session also can't clobber the
    //     preserved bytes via tickAutosave. Suspension stays sticky until
    //     the page reloads (the only path back is reloading on a build
    //     that knows the simVersion).
    const wasSuspended = this.autosaveSuspended;
    if (!wasSuspended) {
      void deleteSave();
    }
    this.currentOutcome = GameOutcome.None;
    this.currentCause = null;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.hideGameOverOverlay();
    // S5: show difficulty selector before creating the new world.
    // bootFresh is invoked inside the callback so wasSuspended is captured.
    this.gamePhase = GamePhase.SavePrompt; // prevent update() from ticking the old world during overlay
    uiScene.showDifficultySelectOverlay({
      onSelect: (d) => {
        this.bootFresh(d);
        if (wasSuspended) {
          this.autosaveSuspended = true;
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Update loop
  // ---------------------------------------------------------------------------

  /**
   * Stage 2 §B: (re)bake the active view's terrain into its RenderTexture, then show only
   * that RT (hide the others). Surface is static → baked once on first visit; underground
   * full-bakes on first visit / WebGL-restore / restart, then incrementally re-stamps only
   * the tiles the render-owned shadow-diff reports dirty (AI digging). The RT is a
   * world-space GO the main camera projects, so this replaces the per-frame immediate-mode
   * terrain draw. Pixels are validated in UAT (no GPU here).
   */
  private bakeAndShowTerrain(cam: CameraView): void {
    if (this.world === undefined) return;
    const isSurface = this.viewState.activeView === 'surface';
    const colonyId = this.viewState.activeUndergroundColonyId;
    const key = isSurface ? surfaceCacheKey() : undergroundCacheKey(colonyId);
    const entry = this.terrainCache.ensure(key);
    const baker = this.terrainBaker as unknown as GfxLike;

    // Entrance ceiling-gap columns for the viewed underground colony (used by the
    // shadow-diff + autotile ceiling row).
    const entranceCols = (): Set<number> => {
      const set = new Set<number>();
      const colony = this.world?.colonies[colonyId];
      if (colony?.entrances) {
        for (const e of colony.entrances) set.add(e.surfaceTileX);
      }
      return set;
    };

    if (entry.needsRebake) {
      this.terrainBaker.clear();
      entry.rt.clear();
      if (isSurface) {
        drawSurfaceTerrain(baker, this.world, cam, true);
        entry.rt.draw(this.terrainBaker);
        this.terrainCache.markBaked(key); // surface is static → no shadow
      } else {
        drawUndergroundTerrain(baker, this.world, cam, colonyId, true);
        entry.rt.draw(this.terrainBaker);
        const grid = this.world.undergroundGrids[colonyId];
        this.terrainCache.markBaked(key, grid ? createTerrainShadow(grid, entranceCols()) : null);
      }
    } else if (!isSurface && entry.shadow !== null) {
      const grid = this.world.undergroundGrids[colonyId];
      if (grid !== undefined) {
        const dirty = diffTerrainShadow(entry.shadow, grid, entranceCols());
        if (dirty.size > 0) {
          this.terrainBaker.clear();
          restampUndergroundTiles(baker, this.world, colonyId, dirty);
          entry.rt.draw(this.terrainBaker);
        }
      }
    }
    // Free the off-screen baker's command buffer now — a full bake holds the entire
    // 128×128 procedural-terrain Graphics (hundreds of thousands of primitives) and would
    // otherwise be retained until the next bake, which may never happen in a surface-only
    // session (Codex P2).
    this.terrainBaker.clear();

    // Show only the active view's RT.
    for (const k of this.terrainCache.allocatedKeys()) {
      const e = this.terrainCache.get(k);
      if (e !== undefined) e.rt.setVisible(k === key);
    }
  }

  /** Stage 2 §B: WebGL context restored → RT framebuffers are blank → flag for rebake.
   *  Arrow field so the reference is stably bound (lint-safe + same ref for on/off). */
  private readonly onWebglRestore = (): void => {
    this.terrainCache.invalidateAll();
  };

  update(time: number, delta: number) {
    // SavePrompt phase: overlay handles input; no tick updates expected.
    if (this.gamePhase === GamePhase.SavePrompt) return;

    // Keyboard PAN gate (Fix 3 / Codex P2). processCameraInput applies held
    // WASD/arrow pan every frame; it must be BLOCKED whenever a modal owns input
    // — GameOver, SavePrompt, OR the Esc pause menu (pauseReasons.menu) — and
    // STILL run during a bare user-pause (Space), where look-around is expected.
    // Reuse the SAME pure gate the left-arbiter pan uses (canArbiterPan, the
    // negation of isModalOpen) so all three pan paths — keyboard, left-drag, and
    // middle-button (registerDragPan, also wired to !isModalOpen) — move together.
    //
    // This supersedes the prior GameOver-only check (issue #129): that left
    // held WASD/arrows panning the camera behind the Esc menu (gamePhase=Paused,
    // not GameOver) and persisting after Resume, because nothing resets the
    // camera on close. SavePrompt is also covered now. Tab is gated separately
    // via canAcceptWorldHotkey() below; this only governs the pan.
    const keyboardPanActive = canArbiterPan(this.isModalOpen());

    // Tab toggles view (JustDown handles key-press edge, not held). Stage 1
    // controls rework (issue #18): Tab now goes through canAcceptWorldHotkey so a
    // Tab behind the Esc pause menu can no longer slip a view change underneath
    // it (Codex R4-4 — previously Tab polled even while Paused).
    if (Phaser.Input.Keyboard.JustDown(this.tabKey) && this.canAcceptWorldHotkey()) {
      toggleView(this.viewState);
      // Stage 3b (#3): Tab is a world input. Evaluate the [Tab] nudge AFTER the
      // toggle so a Tab first-input has set undergroundVisited and self-suppresses.
      this.noteWorldInput();
    }

    // Stage 1: detect tool/view/colony transitions (incl. keyboard-driven ones
    // between pointer events) and cancel any in-flight gesture under the old
    // context. Also refreshes the arbiter's context fingerprint.
    this.arbiter.reconcileContext();

    // Track active view for anything that needs to diff on toggle.
    if (this.viewState.activeView !== this.lastActiveView) {
      this.lastActiveView = this.viewState.activeView;
    }

    // Drive platform accumulator. When paused/GameOver, gameLoop.pause() already
    // freezes tick execution via its internal flag — update() is safe to call.
    this.gameLoop.update(delta);

    // Apply keyboard-pan + final clamp. Blocked behind any modal (menu /
    // SavePrompt / GameOver); still active during a bare user-pause (Fix 3).
    let keyboardPanned = false;
    if (keyboardPanActive) {
      keyboardPanned = processCameraInput(
        this.viewState,
        {
          cursors: this.cursors,
          wasd: this.wasd,
          dragState: this.dragState,
        },
        delta / 1000, // time-based keyboard pan: screen-px/sec × dt ÷ zoom
      );
    }

    const cam =
      this.viewState.activeView === 'surface'
        ? this.viewState.surfaceCamera
        : this.viewState.undergroundCamera;
    const [worldPxW, worldPxH] = worldPxDimensions(this.viewState.activeView);
    // Controls rework (issue #18): if the user moved the camera by ANY other input
    // this frame — keyboard pan above, or a left/middle drag-pan (panInputState.isPanning,
    // set async by the arbiter / registerDragPan) — drop the in-flight wheel-zoom anchor.
    // Otherwise the next tickZoomLerp re-anchors centerX/Y purely from the fixed cursor
    // point and overwrites the pan on the same frame, stuttering/freezing pan for ~0.5s
    // per notch while a zoom lerps.
    if (keyboardPanned || panInputState.isPanning) {
      this.cameraController.cancel(cam);
    }
    // Advance any in-flight cursor-anchored wheel zoom (it re-anchors + clamps as it
    // lerps), keep the active camera valid, then push zoom + center onto Phaser's
    // camera for this frame. cameras.main IS the projection now.
    this.cameraController.tickZoomLerp(cam, worldPxW, worldPxH);
    clampCameraView(cam, worldPxW, worldPxH);
    this.cameraController.apply(cam);

    // Stage 2 §C13: resolve the strategic dot-LOD mode from the smoothed zoom (stateful
    // hysteresis — the 0.55/0.65 band holds the prior mode) for the ACTIVE view, using
    // that view's own prior mode so a toggle never carries the other view's LOD state
    // across (Codex P2). Threaded into the entity draw so strategic zoom-out renders ants
    // as batched dots instead of full sprites.
    const activeViewKey = this.viewState.activeView;
    this.dotModeByView[activeViewKey] = resolveDotMode(cam.zoom, this.dotModeByView[activeViewKey]);
    const dotMode = this.dotModeByView[activeViewKey];

    // Stage 1 controls rework (issue #18): set the per-tool canvas cursor. Reset
    // to the default cursor over any HUD zone / the context menu / any modal so
    // the Dig/Chamber cursors never bleed onto chrome (Codex R1-12/R2-10).
    this.updateToolCursor();

    // S6: advance render frame counter and drain events for render effects.
    this.renderFrame++;
    if (this.gamePhase === GamePhase.Playing) {
      this.consumeEventsForRender();
      this.checkQueenStatusForEffects();
    }

    // Draw world.
    const alpha = computeInterpAlpha(
      this.gameLoop.accumulatorMs,
      MS_PER_TICK / this.speedMultiplier,
    );
    const gfx = this.gfx as unknown as GfxLike;
    const overlayGfx = this.overlayGfx as unknown as GfxLike;
    gfx.clear();
    overlayGfx.clear();
    this.antSprites.beginFrame();
    // UAT regression fix: pheromone overlay MUST render between terrain and
    // entities, not before the orchestrator. drawSurface / drawUnderground
    // paint opaque terrain THEN entities; an overlay drawn before the
    // orchestrator gets wiped by the terrain pass. The bug had been
    // invisible since the Phase 9.06 wiring (9f5b23f) — pheromones were in
    // the world state but never showed up on canvas. Issue #114 surfaced it
    // when the toggle had no visible effect (both ON and OFF rendered the
    // same — because ON was always being overpainted).
    //
    // Fix: call the split terrain + entities functions explicitly so the
    // pheromone overlay lands in the middle. The orchestrator wrappers
    // (drawSurface / drawUnderground) stay for callers that don't need
    // the overlay slot (e.g. unit tests).
    //
    // Player colony only — enemy pheromones stay hidden regardless of toggle
    // state (PRD §7b / T-08-05).
    this.beginDrawTrace();
    // Stage 2 §B: (re)bake the active view's terrain into its RenderTexture and show it
    // (cameras.main projects/zooms the RT). Replaces the per-frame immediate-mode terrain
    // draw — the dynamic layers (pheromone, entities, chambers, dots) still draw into gfx.
    this.bakeAndShowTerrain(cam);
    // Stage 3a (issue #18): the projected world + pending-command ghost delta for this
    // frame (memoized — the arbiter's getProjectedWorld shares the same cached result).
    const projected = this.projection.get(this.world);
    const ghostDelta = computeGhostDelta(this.world, projected);
    // Stage 3a §11/§19: the legibility overlay is always-on except over a blocking modal (pause
    // MENU / GameOver / SavePrompt); see canShowWorldPreview for the §11/§19 reconciliation.
    const showPreview = this.canShowWorldPreview();
    if (this.viewState.activeView === 'surface') {
      this.recordDrawLayer('terrain');
      this.updatePheromoneLayer(cam, 'surface', dotMode); // #236 PR1 — cached persistent layer
      this.recordDrawLayer('entities');
      // Stage 1 controls rework (issue #18): the entrance hover outline. Shown
      // only while the Dig tool is active on the surface and the pointer is on
      // canvas (and not over HUD). Re-resolve the tile + validity from the LIVE
      // camera every frame so a keyboard/drag pan under a stationary cursor keeps
      // the outline under the pointer and never stale (Codex R1-9/R2-9/R3-4).
      // Stage 3a (Codex round 2): gate the entrance feedforward on showPreview like every other cue,
      // so the green/red/blocked outline hides behind a blocking modal (and skips the trial-apply
      // clone when suppressed). showPreview is the §11/§19 gate computed above.
      const entranceHover = showPreview ? this.computeEntranceHover(cam, projected) : null;
      drawSurfaceEntities(
        gfx,
        this.antSprites,
        this.prevState,
        this.world,
        alpha,
        cam,
        entranceHover,
        this.antFacingCache,
        this.time.now, // S6: frameTimeMs for reticle/hunger pulse
        this.contestedGlowFrames, // S6: surface glow fade map
        this.renderFrame, // S6: current render frame
        overlayGfx, // #148: health bar renders above sprites
        dotMode, // §C13: strategic dot-LOD
        // Stage 3a (Codex): pass the player's PENDING spider-priority change (from the ghost delta),
        // not the projected value — draw-surface keeps the committed white border and draws a queued
        // change distinctly, so a pending toggle never looks already-applied. null over a modal (or
        // when preview is off) → committed border only.
        showPreview ? ghostDelta.pendingSpiderPriority : null,
        // (Food priority is deliberately NOT previewed through draw-surface — that would paint a
        // queued mark in the full committed tint. The ghost overlay below carries the queued cue.)
      );
      // Stage 3a: pending-command ghosts (surface rally) above the entity layer.
      if (showPreview) drawGhostDelta(overlayGfx, ghostDelta, 'surface', PLAYER_COLONY_ID);
    } else {
      this.recordDrawLayer('terrain');
      this.updatePheromoneLayer(cam, 'underground', dotMode); // #236 PR1 — cached persistent layer
      this.recordDrawLayer('entities');
      drawUndergroundEntities(
        gfx,
        this.antSprites,
        this.prevState,
        this.world,
        alpha,
        cam,
        this.viewState.activeUndergroundColonyId,
        this.antFacingCache,
        this.undergroundGlowFrames, // S6: underground glow fade map
        this.renderFrame, // S6: current render frame
        dotMode, // §C13: strategic dot-LOD
      );
      // Stage 3a: feedforward tint (chamber-menu highlight, else the hovered dig tile) +
      // the pending-command ghosts — gated to not draw over a modal.
      if (showPreview) {
        const hover =
          this.computeChamberHover(projected) ?? this.computeUndergroundDigHover(cam, projected);
        drawFeedforwardTint(overlayGfx, hover);
        drawGhostDelta(
          overlayGfx,
          ghostDelta,
          'underground',
          this.viewState.activeUndergroundColonyId,
        );
      }
    }
    this.antSprites.endFrame();

    // Autosave — only while actively Playing, and not while a preserved
    // incompatible save is sitting in localStorage waiting for recovery
    // (issue #66: bootFromSave's deserialize-throw catch suspends autosave
    // so the preserved bytes aren't overwritten by this fresh session).
    if (this.gamePhase === GamePhase.Playing && !this.autosaveSuspended && !this.autosaveInFlight) {
      // Fire-and-forget (#234): scene.update never awaits — the async storage
      // write must not block the frame. The in-flight guard prevents overlapping
      // 30s writes; tickAutosave keeps its own interval gate, so a not-due call
      // resolves immediately and just clears the guard the same microtask.
      this.autosaveInFlight = true;
      void tickAutosave(
        this.currentSeed,
        this.inputLog,
        this.world,
        this.lastAutosaveMs,
        time,
        () => this.notifyAutosaveFailed(),
      )
        .then((next) => {
          this.lastAutosaveMs = next;
        })
        .finally(() => {
          this.autosaveInFlight = false;
        });
    }
  }

  /**
   * #234 PR2 — surface an autosave-persist failure to the player, once per
   * session. tickAutosave calls this from its catch when the storage write
   * throws (quota / private-mode / blocked storage).
   *
   * Routed through the one-shot caption registry (checkAndTrigger + the
   * 'autosaveFailed' key) rather than a bespoke boolean: checkAndTrigger gates
   * once-per-session, resetCaptions() (in resetSessionState) re-arms it per
   * session, and — crucially — passing the key lets UIScene's untrigger re-fire
   * the caption if the bounded caption queue DROPS it under overflow, so a real
   * failure is never silently swallowed (a keyless caption + a latched boolean
   * would be: the flag stays set even though nothing displayed).
   */
  private notifyAutosaveFailed(): void {
    const text = checkAndTrigger('autosaveFailed');
    if (text === null) return;
    const ui = this.scene.get('UIScene') as unknown as UIScenePhase9;
    ui.showCaption(text, this.layout.w / 2, 60, 'autosaveFailed');
  }

  /**
   * #236 PR1 — redraw the persistent pheromone layer only when it can have
   * changed. The grids mutate ONLY on a sim tick, and the culled tile set
   * (visibleTileRange) is camera-dependent, so a STATIC detailed view redraws at
   * the 20 Hz tick rate instead of 60 fps; a pan/zoom/view-switch still redraws
   * (new tiles enter the visible window). In the strategic dot-LOD zoom-out — the
   * MIN_ZOOM worst case #236 names — the overlay is dropped entirely (it was never
   * legible there). Output is byte-identical to the old per-frame draw: the layer
   * is world-space so cameras.main re-projects it, and any change forces a full
   * clear + redraw.
   */
  private updatePheromoneLayer(
    cam: CameraView,
    view: 'surface' | 'underground',
    dotMode: boolean,
  ): void {
    // Gate (a) — dot-LOD / toggle-off: no overlay. Clear it and force a redraw
    // (lastPheromoneTick = -1) for when it next becomes visible.
    if (dotMode || !this.viewState.showPheromoneOverlay) {
      this.pheromoneGfx.clear();
      this.lastPheromoneTick = -1;
      return;
    }
    // The overlay is logically active this frame — record it for the draw-order
    // telemetry EVERY active frame (the persistent layer sits at depth -5 between
    // terrain and entities whether or not it redrew), so the e2e trace stays
    // consistent. Only the drawPheromoneOverlay call below is cache-gated.
    this.recordDrawLayer('pheromone');
    // Gate (b) — redraw only on a tick / camera / view change.
    if (
      this.world.tick === this.lastPheromoneTick &&
      cam.centerX === this.lastPheromoneCam.centerX &&
      cam.centerY === this.lastPheromoneCam.centerY &&
      cam.zoom === this.lastPheromoneCam.zoom &&
      view === this.lastPheromoneView
    ) {
      return;
    }
    this.pheromoneGfx.clear();
    drawPheromoneOverlay(this.pheromoneGfx as unknown as GfxLike, this.world, cam, view);
    this.lastPheromoneTick = this.world.tick;
    this.lastPheromoneCam.centerX = cam.centerX;
    this.lastPheromoneCam.centerY = cam.centerY;
    this.lastPheromoneCam.zoom = cam.zoom;
    this.lastPheromoneView = view;
  }

  /**
   * Compute the entrance hover outline for the current frame, or null when it
   * should not show. Shown only for Dig + surface, with the pointer on canvas
   * and not over a HUD zone. The tile + validity are recomputed here every frame from
   * the LIVE camera so the outline tracks the pointer even under a moving camera.
   */
  private computeEntranceHover(
    cam: CameraView,
    projected: WorldState,
  ): { tileX: number; tileY: number; outcome: FeedforwardOutcome } | null {
    if (this.viewState.activeView !== 'surface') return null;
    if (this.viewState.activeTool !== 'dig') return null;
    if (this.hoverScreenX === null || this.hoverScreenY === null) return null;
    if (isPointerOverHUD(this.hoverScreenX, this.hoverScreenY, this.hud, this.viewState))
      return null;
    if (this.world === undefined) return null;
    const { tileX, tileY } = screenToTileZoom(this.hoverScreenX, this.hoverScreenY, cam);
    // Reject off-grid tiles on BOTH axes. Zoomed out, the visible world rect can extend
    // past the grid edge (clampCameraView centers an undersized-vs-viewport world), so a
    // cursor in that margin maps to an out-of-bounds tile; without the upper-bound guard a
    // spurious red (invalid) hover frame paints over the empty margin past the right/bottom
    // edge (a Stage-2 zoom regression — the pre-zoom fixed viewport never exposed margins).
    if (tileX < 0 || tileY < 0) return null;
    if (tileX >= this.world.surface.width || tileY >= this.world.surface.height) return null;
    // Stage 3a (Codex): the verdict is the feedforward outcome for the DesignateEntrance this tap
    // would emit, trial-applied against the PROJECTED world (the live queue folded) — green/red/
    // blocked. Reading the projection makes an already-queued entrance turn the tile red, so the
    // hover (and the tap it gates) stop spamming duplicate no-ops the sim rejects while paused.
    const candidate = {
      type: 'DesignateEntrance',
      colonyId: PLAYER_COLONY_ID,
      surfaceTileX: tileX,
      surfaceTileY: tileY,
      issuedAtTick: this.world.tick,
    } as const;
    let nonSync = 0;
    for (const c of this.world.commandQueue) if (c.type !== 'SyncAIState') nonSync++;
    const outcome = this.feedforward.outcome(
      projected,
      candidate,
      nonSync,
      this.projection.revision,
    );
    return { tileX, tileY, outcome };
  }

  /**
   * Stage 3a (issue #18): the hovered underground dig tile + its feedforward outcome.
   * Resolves the command a tap would emit (mark vs cancel) from the PROJECTED grid — the
   * same decision the input layer makes — then trial-applies it for green/red/blocked.
   * (Chamber feedforward, which needs the open menu's highlighted type, is a follow-on.)
   */
  private computeUndergroundDigHover(
    cam: CameraView,
    projected: WorldState,
  ): HoveredFeedforward | null {
    if (this.viewState.activeView !== 'underground') return null;
    if (this.viewState.activeTool !== 'dig') return null;
    // Stage 3a (Codex round 3): suppress the tap feedforward during an active paint DRAG. The drag
    // path (continuePaintStroke) only ever emits MarkDigTile, but once a painted tile reads Marked in
    // the projection this tap-hover would preview CancelDigMark — the opposite of what painting does.
    if (this.arbiter.isPainting()) return null;
    if (this.viewState.activeUndergroundColonyId !== PLAYER_COLONY_ID) return null;
    if (this.hoverScreenX === null || this.hoverScreenY === null) return null;
    if (isPointerOverHUD(this.hoverScreenX, this.hoverScreenY, this.hud, this.viewState))
      return null;
    if (this.world === undefined) return null;
    const grid = this.world.undergroundGrids[PLAYER_COLONY_ID];
    const projGrid = projected.undergroundGrids[PLAYER_COLONY_ID];
    if (grid === undefined || projGrid === undefined) return null;
    const { tileX, tileY } = screenToTileZoom(this.hoverScreenX, this.hoverScreenY, cam);
    if (tileX < 0 || tileY < 0) return null;
    if (tileX >= grid.width || tileY >= grid.height) return null;
    // Mirror the input layer's exclusions so the cue never paints a (red) tint over a tile
    // the tap silently skips (ship-review LOW advisories): the ceiling row gives no dig
    // feedback anywhere (issue #30), and a BeingDug tile is an intentional neutral no-op —
    // not a geometric rejection — so neither should show feedforward.
    if (tileY === UNDERGROUND_CEILING_ROW_Y) return null;
    const projState = ugGet(projGrid, tileX, tileY);
    if (projState === UndergroundTileState.BeingDug) return null;
    const candidate =
      projState === UndergroundTileState.Marked
        ? ({
            type: 'CancelDigMark',
            colonyId: PLAYER_COLONY_ID,
            tileX,
            tileY,
            issuedAtTick: this.world.tick,
          } as const)
        : ({
            type: 'MarkDigTile',
            colonyId: PLAYER_COLONY_ID,
            tileX,
            tileY,
            issuedAtTick: this.world.tick,
          } as const);
    let nonSync = 0;
    for (const c of this.world.commandQueue) if (c.type !== 'SyncAIState') nonSync++;
    // Pass the projection revision so feedforward skips the world deep-clone when neither
    // the projection nor the hovered candidate changed (Codex R3-2 — avoids a ~300K-element
    // copyWorldState every hover frame). `projected` is this.projection.get(...) above.
    const outcome = this.feedforward.outcome(
      projected,
      candidate,
      nonSync,
      this.projection.revision,
    );
    return { tileX, tileY, width: 1, height: 1, chamberType: null, outcome };
  }

  /**
   * Stage 3a (issue #18): chamber feedforward. While the chamber context-menu is open, the
   * item highlighted under the pointer is the chamber TYPE; its footprint (anchored at the
   * menu's tile) is trial-applied against the projected world for green/red/blocked. The menu
   * items are filtered against the PROJECTED colony (R5-2) so a queued Queen-cancel re-enables
   * the Queen option. Returns null when no menu is up / no item is highlighted.
   */
  private computeChamberHover(projected: WorldState): HoveredFeedforward | null {
    if (!contextMenuState.visible) return null;
    if (this.world === undefined) return null;
    if (this.hoverScreenX === null || this.hoverScreenY === null) return null;
    const colony = projected.colonies[PLAYER_COLONY_ID];
    if (colony === undefined) return null;
    const items = visibleContextMenuItems(colony, projected);
    const type = contextMenuItemAt(
      this.hoverScreenX,
      this.hoverScreenY,
      contextMenuState.screenX,
      contextMenuState.screenY,
      items,
    );
    if (type === null) return null;
    const dims = CHAMBER_DIMENSIONS[type];
    const anchorTileX = contextMenuState.anchorTileX;
    const anchorTileY = contextMenuState.anchorTileY;
    const candidate = {
      type: 'PlaceChamber',
      colonyId: PLAYER_COLONY_ID,
      chamberType: type,
      anchorTileX,
      anchorTileY,
      issuedAtTick: this.world.tick,
    } as const;
    let nonSync = 0;
    for (const c of this.world.commandQueue) if (c.type !== 'SyncAIState') nonSync++;
    const outcome = this.feedforward.outcome(
      projected,
      candidate,
      nonSync,
      this.projection.revision,
    );
    return {
      tileX: anchorTileX,
      tileY: anchorTileY,
      width: dims.width,
      height: dims.height,
      chamberType: type,
      outcome,
    };
  }

  /**
   * Stage 3a §11/§19: may the command-legibility overlay (feedforward + ghosts) draw this frame?
   * Always-on (§19): true except over a blocking modal (Esc pause-MENU / GameOver / SavePrompt).
   * It is therefore also live during normal running play — but the queue drains each tick, so
   * ghosts are then near-empty and only live hover-feedforward shows; the SALIENT cases §11 calls
   * out are a bare user-pause and the open chamber menu, where queued ghosts accumulate and stay
   * visible. NOT canAcceptWorldHotkey (that blocks pause). Per-pointer HUD / minimap / ant-panel
   * exclusion is handled by the hover computations + draw order (world-space ghosts are occluded
   * by the HUD), not here. [UAT lever: to suppress running-play hover-feedforward, gate this on a
   * bare user-pause OR an open chamber menu instead of merely !isModalOpen().]
   */
  private canShowWorldPreview(): boolean {
    return !this.isModalOpen();
  }

  /**
   * Set the canvas cursor for the active tool, resetting to the default cursor
   * over any HUD zone, the context menu, the inspector panel, or while a modal
   * owns input. GameScene is the single owner of the tool-cursor (Codex
   * R1-12/R2-10). Only writes when the resolved cursor changes, to avoid
   * per-frame DOM churn.
   *
   * Note: the modal check is isModalOpen(), NOT gamePhase !== Playing. A bare
   * user-pause keeps tools/taps/entrance-hover live (canEditWorld = !isModalOpen),
   * so the tool cursor must persist while user-paused — otherwise the cursor
   * shows a plain arrow while a click would still queue an edit.
   */
  private updateToolCursor(): void {
    const overHud =
      this.hoverScreenX !== null &&
      this.hoverScreenY !== null &&
      isPointerOverHUD(this.hoverScreenX, this.hoverScreenY, this.hud, this.viewState);
    const effectiveTool: CursorTool = resolveCursorTool({
      activeTool: this.viewState.activeTool,
      activeView: this.viewState.activeView,
      isModalOpen: this.isModalOpen(),
      contextMenuVisible: contextMenuState.visible,
      antActivityPanelVisible: antActivityPanelState.visible,
      overHud,
    });

    // Diff against the last applied (tool, view) so we only touch the DOM cursor
    // on a real change. The 'default' sentinel is stored as the literal string
    // (not null) so consecutive default frames compare equal and short-circuit.
    if (
      !cursorToolChanged(
        effectiveTool,
        this.viewState.activeView,
        this.lastCursorTool,
        this.lastCursorView,
      )
    ) {
      return;
    }
    this.lastCursorTool = effectiveTool;
    this.lastCursorView = this.viewState.activeView;

    const cursorCss: Record<CursorTool, string> = {
      // 'command' uses the OS default arrow; dig/chamber use crosshair so the
      // commit/paint affordance reads as "place precisely".
      command: 'default',
      dig: 'crosshair',
      chamber: 'cell',
      default: 'default',
    };
    this.input.setDefaultCursor(cursorCss[effectiveTool]);
  }

  /** Accessor for UIScene / Plan 05 / Plan 06 — safe read-only reference. */
  getWorld(): WorldState {
    return this.world;
  }
  getViewState(): ViewState {
    return this.viewState;
  }

  /** Test/Playwright accessor for the gesture arbiter. */
  getArbiter(): GestureArbiter {
    return this.arbiter;
  }
}
