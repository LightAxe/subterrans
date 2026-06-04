// game-scene.ts — Phase 9 Phaser GameScene: drives game loop, renders world, handles keyboard/camera.
//
// Owns: createGameLoop wiring, draw dispatch, Tab view-toggle, camera-pan triggers,
//       GamePhase FSM (Playing|Paused|GameOver|SavePrompt), save boot flow,
//       AI controller wiring (onBeforeTick → runAIController per AI colony),
//       outcome handling (gameLoop.pause() + UIScene overlay), autosave.
//
// Coordinate model (Phase 8.5 stabilization):
//   The project owns the camera. `CameraState` is in tile units; the draw modules
//   project world tiles into screen pixels manually by subtracting `left/top` in
//   visibleRange(). Phaser's own camera (`this.cameras.main`) is left at
//   scroll=0 and bounds=default — it is NOT synced to CameraState. Previously we
//   also set `cameras.main.scrollX/scrollY` from CameraState, which double-
//   translated the Graphics object and pushed the world offscreen (this was the
//   "surface appears all black" + "underground click Y-offset" bug). The fix is
//   a single transform: manual projection in the draw modules.
//
// Pitfall 1: Do not sync `cameras.main.scrollX/scrollY` from CameraState. The
//            draw modules already project to screen space.
// Pitfall 2: Keyboard registration is GameScene-only — UIScene must NOT call createCursorKeys().
// Pitfall 3: scale.mode = NONE, fixed 800x592 — no DPR scaling.
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
  hasSave,
  hasIncompatibleSave,
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
} from './game-scene-logic.js';
import {
  type ViewState,
  createViewState,
  resetViewState,
  toggleView,
  toggleUndergroundColony,
  clampCamera,
} from './camera.js';
import {
  PLAYER_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  STARVATION_GRACE_TICKS,
} from '../sim/constants.js';
import { GameOutcome } from '../sim/game-over.js';
import { drawSurfaceTerrain, drawSurfaceEntities, type GfxLike } from './draw-surface.js';
import { drawUndergroundTerrain, drawUndergroundEntities } from './draw-underground.js';
import { drawPheromoneOverlay } from './draw-pheromone.js';
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
  resetDragState,
  resetPanInputState,
} from '../input/camera-input.js';
import {
  registerSurfaceInput,
  resetSurfaceInputState,
  type SurfaceInputState,
} from '../input/surface-input.js';
import {
  registerUndergroundInput,
  resetUndergroundInputState,
  type UndergroundInputState,
} from '../input/underground-input.js';
import { hideContextMenu } from './context-menu-state.js';
import { buildPlaytraceSummary, type GameOutcomeLabel } from './summary-builder.js';
import { checkAndTrigger, resetCaptions } from './onboarding-captions.js';
import {
  triggerScreenEdgeFlash,
  triggerQueenDamagePulse,
  inferFlashDirection,
  QUEEN_DAMAGE_SUPPRESS_TICKS,
} from './screen-effects.js';
import { ChamberType } from '../sim/enums.js';
import { CANVAS_W, CANVAS_H } from './sprites.js';
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
    onSaveNow: () => boolean;
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
  // S6 — first-occurrence caption overlay (light onboarding).
  showCaption(text: string, screenX: number, screenY: number): void;
}
import type { SimCommand } from '../sim/commands.js';

// Re-export GamePhase for Plan 07 and other consumers
export { GamePhase, decideBootMode, deriveAIColonyIds, appendInputLog, generateFreshSeed };
export type { GamePhase as GamePhaseType };

export class GameScene extends Phaser.Scene {
  private world!: WorldState;
  private prevState!: WorldState;
  private viewState!: ViewState;
  private gameLoop!: GameLoop;
  private gfx!: Phaser.GameObjects.Graphics;
  // Overlay layer for world-space primitives that must render above the sprite
  // pool (e.g. the spider health bar, issue #148). Depth sits just above
  // SPIDER_SPRITE_DEPTH so it clears every in-world sprite.
  private overlayGfx!: Phaser.GameObjects.Graphics;
  private antSprites!: AntSpritePool;
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
  private surfaceInputState!: SurfaceInputState;
  private undergroundInputState!: UndergroundInputState;
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
  private resumedFromSave: boolean = false;
  private currentSeed: number = 0;
  // Issue #114 UAT — Settings sub-screen has a "Speed: N×" cycle row that
  // reads/writes this field via callbacks. The 1/2/4 keyboard shortcuts
  // below set the same field directly. Narrowed to the cycle set so the
  // type aligns with PauseMenuLayout's SpeedMultiplier.
  private speedMultiplier: 1 | 2 | 4 = 1;

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
    const assetsBaseRaw = this.registry.get('assetsBase');
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
    this.viewState = createViewState(PLAYER_START_X, PLAYER_START_Y);
    this.gfx = this.add.graphics();
    this.overlayGfx = this.add.graphics();
    this.overlayGfx.setDepth(SPIDER_SPRITE_DEPTH + 1);
    this.antSprites = new AntSpritePool(this);

    // Issue #122 — pull the playtrace endpoint out of the registry (set by
    // main.ts in callbacks.preBoot). Treat any non-string value as "feature
    // off" so a programming error in main.ts doesn't accidentally turn the
    // overlay on with an undefined endpoint and 404 the submission.
    const endpointRaw = this.registry.get('playtraceEndpoint');
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

    // Drag-pan registration — returns dragState ref for processCameraInput
    this.dragState = registerDragPan(
      this,
      this.viewState,
      () => this.gamePhase === GamePhase.GameOver,
    );

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
    this.input.keyboard!.on('keydown-ONE', () => {
      if (this.gamePhase !== GamePhase.Playing) return;
      this.speedMultiplier = 1;
    });
    this.input.keyboard!.on('keydown-TWO', () => {
      if (this.gamePhase !== GamePhase.Playing) return;
      this.speedMultiplier = 2;
    });
    this.input.keyboard!.on('keydown-FOUR', () => {
      if (this.gamePhase !== GamePhase.Playing) return;
      this.speedMultiplier = 4;
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
      if (this.gamePhase !== GamePhase.Playing) return;
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
      if (this.gamePhase !== GamePhase.Playing) return;
      if (this.viewState.activeView !== 'underground') return;
      toggleUndergroundColony(this.viewState);
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
      // Issue #116 — UIScene owns Esc; this callback fires on Esc when no
      // UIScene overlay/panel is open and is the trigger to spawn the pause
      // menu. GameScene was previously binding keydown-ESC alongside
      // UIScene's escKey handler, which raced (open → close in one press).
      onEscape: () => this.openPauseMenu(),
    });
    this.scene.bringToTop('UIScene');

    // World input dispatchers — internally guard on viewState.activeView.
    // Both return the per-registration state object so restartGame / boot
    // helpers can reset them in place without invalidating the closures that
    // Phaser now holds on pointerdown/pointermove/pointerup.
    this.surfaceInputState = registerSurfaceInput(this, getWorld, this.viewState, getPrevWorld);
    this.undergroundInputState = registerUndergroundInput(this, getWorld, this.viewState);

    // Phase 9 boot: check for existing save. If found and loadable, show
    // SavePrompt overlay. Otherwise boot fresh (incompatible saves are
    // silently skipped here; the new game's first autosave will overwrite them).
    const bootMode = decideBootMode(() => hasSave() && !hasIncompatibleSave());
    if (bootMode === 'prompt') {
      this.gamePhase = GamePhase.SavePrompt;
      const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
      uiScene.showSavePromptOverlay({
        onContinue: () => this.bootFromSave(),
        onNewGame: () => {
          deleteSave();
          this.showDifficultySelectThenBoot();
        },
      });
    } else {
      this.showDifficultySelectThenBoot();
    }

    // Lifecycle signal — preload assets are loaded (we're in create()), the
    // scene graph is constructed, and the chosen boot path (fresh world or
    // SavePrompt overlay) has been dispatched. Phaser's first render tick
    // runs after create() returns, so the canvas paints on the next frame;
    // "ready" here means "interactive imminently", which is the right
    // moment for a host page to hide a loading spinner. Emit after the
    // bootMode branch so both paths reach it. main.ts converts this to
    // `MountedGame.ready: Promise<void>` for the host page.
    this.game.events.emit(SUBTERRANS_READY_EVENT);
  }

  // ---------------------------------------------------------------------------
  // Boot helpers
  // ---------------------------------------------------------------------------

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
   * and by registerSurfaceInput / registerUndergroundInput / registerDragPan
   * stay valid. Reassigning would strand those references (same failure
   * class as the stale-world bug fixed earlier in Phase 9).
   */
  private resetSessionState(): void {
    resetInputLog(this.inputLog);
    resetViewState(this.viewState, PLAYER_START_X, PLAYER_START_Y);
    resetSurfaceInputState(this.surfaceInputState);
    resetUndergroundInputState(this.undergroundInputState);
    resetDragState(this.dragState);
    resetPanInputState();
    hideContextMenu();
    this.lastActiveView = null;
    this.currentOutcome = GameOutcome.None;
    this.currentCause = null;
    this.speedMultiplier = 1;
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
    // S6 — reset per-session render-side scratch.
    this.lastProcessedEventTick = -1;
    this.prevQueenCombinedHp = null;
    this.queenStarvationTriggered = false;
    this.contestedGlowFrames.clear();
    this.undergroundGlowFrames.clear();
    resetCaptions();
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
          triggerScreenEdgeFlash(this, direction, CANVAS_W, CANVAS_H);
        } else {
          triggerScreenEdgeFlash(this, 'right', CANVAS_W, CANVAS_H);
        }
        // Caption #7: first AI invasion.
        const captionText = checkAndTrigger('aiInvading');
        if (captionText && uiScene) {
          uiScene.showCaption(captionText, CANVAS_W / 2, 60);
        }
      }

      if (ev.type === 'spider_rampage_start') {
        // Caption #8: first spider rampage.
        const captionText = checkAndTrigger('spiderRampage');
        if (captionText && uiScene) {
          uiScene.showCaption(captionText, CANVAS_W / 2, 60);
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
          triggerScreenEdgeFlash(this, 'right', CANVAS_W, CANVAS_H);
          if (uiScene) uiScene.showCaption(captionText, CANVAS_W / 2, 60);
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
        uiScene.showCaption(captionText, CANVAS_W / 2, CANVAS_H / 2 - 40);
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
        uiScene.showCaption(captionText, CANVAS_W / 2, CANVAS_H / 2 - 40);
      }
    }

    // World-state-based captions.
    // Gate spider caption on Hunting/Striking — spider exists from tick 0 while
    // Patrolling, so triggering on mere existence fires before any visible threat.
    const spiderState = this.world.spider?.state;
    if (spiderState === 'Hunting' || spiderState === 'Striking') {
      const captionText = checkAndTrigger('spider');
      if (captionText && uiScene) {
        uiScene.showCaption(captionText, CANVAS_W / 2, 60);
      }
    }
    if (this.world.spiderPriorityColonyId !== null) {
      const captionText = checkAndTrigger('spiderPriority');
      if (captionText && uiScene) {
        uiScene.showCaption(captionText, CANVAS_W / 2, 60);
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
  private showDifficultySelectThenBoot(): void {
    this.gamePhase = GamePhase.SavePrompt;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.showDifficultySelectOverlay({
      onSelect: (d) => this.bootFresh(d),
    });
  }

  private bootFromSave(): void {
    const loaded = loadSave();
    if (loaded === null) {
      // Corrupt save: fall through to fresh (bootFresh runs its own reset)
      deleteSave();
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
        deleteSave();
        this.bootFresh();
        return;
      }
      // Genuine corruption: discard so we don't loop the user.
      deleteSave();
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
            if (text && uiScene) uiScene.showCaption(text, CANVAS_W / 2, CANVAS_H - 80);
          } else if (cmd.type === 'PlaceChamber') {
            const chamberTypeLabel: Record<number, string> = {
              [ChamberType.Queen]: 'Queen',
              [ChamberType.Nursery]: 'Nursery',
              [ChamberType.FoodStorage]: 'Food Storage',
            };
            const chamberTypeName =
              chamberTypeLabel[cmd.chamberType] ?? `chamber type ${cmd.chamberType}`;
            const text = checkAndTrigger('chamber', chamberTypeName);
            if (text && uiScene) uiScene.showCaption(text, CANVAS_W / 2, CANVAS_H - 80);
          } else if (cmd.type === 'MarkFoodPile') {
            const text = checkAndTrigger('foodMark');
            if (text && uiScene) uiScene.showCaption(text, CANVAS_W / 2, CANVAS_H - 80);
          } else if (cmd.type === 'SetRallyPoint') {
            const text = checkAndTrigger('rally');
            if (text && uiScene) uiScene.showCaption(text, CANVAS_W / 2, CANVAS_H - 80);
          }
        }
      },
      onTickOutcome: (outcome) => {
        this.currentOutcome = outcome;
        this.gamePhase = GamePhase.GameOver;
        // W2: first-class pause via Plan 06 Task 1 API — no setMsPerTick(Infinity)
        this.gameLoop.pause();
        // Issue #129 — clear any in-flight pan/drag so spaceHeld and dragState.active
        // don't leak into the GameOver overlay state (drag-pan event handlers are
        // independent of processCameraInput and otherwise fire unguarded).
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
        this.speedMultiplier = next;
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
      deleteSave();
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

  private openPauseMenu(): void {
    if (this.gamePhase !== GamePhase.Playing) return;
    this.gamePhase = GamePhase.Paused;
    this.gameLoop.pause();
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.showPauseMenuOverlay(this.buildPauseMenuCallbacks());
  }

  private closePauseMenu(): void {
    if (this.gamePhase !== GamePhase.Paused) return;
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.hidePauseMenuOverlay();
    uiScene.hideSaveLoadDialogOverlay();
    this.gamePhase = GamePhase.Playing;
    this.gameLoop.resume();
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
        this.bootFromSave();
      },
      onNewGame: () => {
        // restartGame deletes the existing save (preserving the issue #66
        // guard) and bootFreshes; finishBoot resumes the loop and flips to
        // Playing. Set Playing here too so the transitional moment between
        // dialog dismissal and finishBoot doesn't observe a dangling Paused.
        this.gamePhase = GamePhase.Playing;
        this.restartGame();
      },
      onSaveNow: () => {
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
        const ok = manualSave(this.currentSeed, this.inputLog, this.world);
        // Round-2 review: bump the autosave cooldown so the next autosave
        // window doesn't fire seconds later and overwrite the manual save's
        // timestamp. The dialog's "Saved 15:32" line otherwise jumps to
        // 15:33 the next time the player opens it, with no action of theirs.
        if (ok) this.lastAutosaveMs = performance.now();
        return ok;
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
      deleteSave();
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

  update(time: number, delta: number) {
    // SavePrompt phase: overlay handles input; no tick updates expected.
    if (this.gamePhase === GamePhase.SavePrompt) return;

    // Issue #129 — suppress keyboard input while the GameOver overlay (survey or
    // game-over panel) is visible. WASD/Space/Tab fire through to the world
    // beneath the modal otherwise, which the player can feel even though the
    // canvas is obscured. Tab and processCameraInput are the two per-frame
    // keyboard consumers; both are skipped in GameOver. The Paused phase is
    // intentionally left untouched: the pause menu is not full-screen and
    // panning while paused is expected behaviour.
    const keyboardActive = this.gamePhase !== GamePhase.GameOver;

    // Tab toggles view (JustDown handles key-press edge, not held).
    if (keyboardActive && Phaser.Input.Keyboard.JustDown(this.tabKey)) {
      toggleView(this.viewState);
    }

    // Track active view for anything that needs to diff on toggle.
    if (this.viewState.activeView !== this.lastActiveView) {
      this.lastActiveView = this.viewState.activeView;
    }

    // Drive platform accumulator. When paused/GameOver, gameLoop.pause() already
    // freezes tick execution via its internal flag — update() is safe to call.
    this.gameLoop.update(delta);

    // Apply keyboard-pan + final clamp.
    if (keyboardActive) {
      processCameraInput(this.viewState, {
        cursors: this.cursors,
        wasd: this.wasd,
        dragState: this.dragState,
      });
    }

    const cam =
      this.viewState.activeView === 'surface'
        ? this.viewState.surfaceCamera
        : this.viewState.undergroundCamera;
    const worldW =
      this.viewState.activeView === 'surface' ? SURFACE_GRID_WIDTH : UNDERGROUND_GRID_WIDTH;
    const worldH =
      this.viewState.activeView === 'surface' ? SURFACE_GRID_HEIGHT : UNDERGROUND_GRID_HEIGHT;
    clampCamera(cam, worldW, worldH);

    // S6: advance render frame counter and drain events for render effects.
    this.renderFrame++;
    if (this.gamePhase === GamePhase.Playing) {
      this.consumeEventsForRender();
      this.checkQueenStatusForEffects();
    }

    // Draw world.
    const alpha = this.gameLoop.accumulatorMs / MS_PER_TICK;
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
    if (this.viewState.activeView === 'surface') {
      drawSurfaceTerrain(gfx, this.world, cam);
      if (this.viewState.showPheromoneOverlay) {
        drawPheromoneOverlay(gfx, this.world, cam, 'surface');
      }
      const pending =
        this.surfaceInputState.pendingEntranceTileX !== null &&
        this.surfaceInputState.pendingEntranceTileY !== null
          ? {
              tileX: this.surfaceInputState.pendingEntranceTileX,
              tileY: this.surfaceInputState.pendingEntranceTileY,
            }
          : null;
      drawSurfaceEntities(
        gfx,
        this.antSprites,
        this.prevState,
        this.world,
        alpha,
        cam,
        pending,
        this.antFacingCache,
        this.time.now, // S6: frameTimeMs for reticle/hunger pulse
        this.contestedGlowFrames, // S6: surface glow fade map
        this.renderFrame, // S6: current render frame
        overlayGfx, // #148: health bar renders above sprites
      );
    } else {
      drawUndergroundTerrain(gfx, this.world, cam, this.viewState.activeUndergroundColonyId);
      if (this.viewState.showPheromoneOverlay) {
        drawPheromoneOverlay(gfx, this.world, cam, 'underground');
      }
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
      );
    }
    this.antSprites.endFrame();

    // Autosave — only while actively Playing, and not while a preserved
    // incompatible save is sitting in localStorage waiting for recovery
    // (issue #66: bootFromSave's deserialize-throw catch suspends autosave
    // so the preserved bytes aren't overwritten by this fresh session).
    if (this.gamePhase === GamePhase.Playing && !this.autosaveSuspended) {
      this.lastAutosaveMs = tickAutosave(
        this.currentSeed,
        this.inputLog,
        this.world,
        this.lastAutosaveMs,
        time,
      );
    }
  }

  /** Accessor for UIScene / Plan 05 / Plan 06 — safe read-only reference. */
  getWorld(): WorldState {
    return this.world;
  }
  getViewState(): ViewState {
    return this.viewState;
  }
}
