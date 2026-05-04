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
// Pitfall 6: Pause key is P, NOT Space — Space+left-drag is the primary map-pan gesture (Phase 8.5).

import * as Phaser from 'phaser';
import { createScenario } from '../sim/scenario.js';
import { copyWorldState, type WorldState } from '../sim/types.js';
import { tick, resetFlowFieldCaches } from '../sim/tick.js';
import { createGameLoop, type GameLoop, MS_PER_TICK } from '../platform/game-loop.js';
import { hasSave, loadSave, deleteSave, tickAutosave, FutureSimVersionError } from '../platform/save.js';
import { deserializeWorldState } from '../platform/save.js';
import { runAIController } from './ai-controller.js';
import { buildDebugSnapshot } from '../platform/debug-snapshot.js';
import { downloadDebugSnapshot } from './debug-snapshot-download.js';
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
  PLAYER_START_X, PLAYER_START_Y,
  SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT,
} from '../sim/constants.js';
import { GameOutcome } from '../sim/game-over.js';
import { drawSurface, type GfxLike } from './draw-surface.js';
import { drawUnderground } from './draw-underground.js';
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
// UIScenePhase9 — subset of UIScene public API added in Plan 06 Task 3.
// Typed here to avoid circular imports; UIScene implements these methods.
interface UIScenePhase9 {
  showGameOverOverlay(outcome: GameOutcome, onRestart: () => void): void;
  hideGameOverOverlay(): void;
  showSavePromptOverlay(callbacks: { onContinue: () => void; onNewGame: () => void }): void;
  hideSavePromptOverlay(): void;
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
  private antSprites!: AntSpritePool;
  // Render-only ant-facing smoothing (see ant-facing-cache.ts). One instance
  // per scene, threaded into drawSurface + drawUnderground each frame so
  // cardinal zig-zag movement settles into a diagonal heading instead of
  // flipping sprite rotation every tick. Reset on boot / restart / save-load
  // so a recycled ant id never inherits a stale heading across sessions.
  private readonly antFacingCache: AntFacingCache = new AntFacingCache();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private tabKey!: Phaser.Input.Keyboard.Key;
  private dragState!: { isDragging: boolean; lastX: number; lastY: number; active: boolean };
  private surfaceInputState!: SurfaceInputState;
  private undergroundInputState!: UndergroundInputState;
  private lastActiveView: ViewState['activeView'] | null = null;

  // Phase 9 — GamePhase FSM + session fields
  private gamePhase: GamePhase = GamePhase.Playing;
  private currentOutcome: GameOutcome = GameOutcome.None;
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
  private currentSeed: number = 0;
  private speedMultiplier: number = 1;

  constructor() { super({ key: 'GameScene' }); }

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
      width: WORKER_SPRITE_WIDTH, height: WORKER_SPRITE_HEIGHT,
    });
    this.load.svg(ANT_TEXTURE_QUEEN, `${spriteBase}queen-ant.svg`, {
      width: QUEEN_SPRITE_WIDTH, height: QUEEN_SPRITE_HEIGHT,
    });
    this.load.svg(EGG_TEXTURE, `${spriteBase}egg.svg`, {
      width: EGG_SPRITE_WIDTH, height: EGG_SPRITE_HEIGHT,
    });
    this.load.svg(LARVA_TEXTURE, `${spriteBase}larva.svg`, {
      width: LARVA_SPRITE_WIDTH, height: LARVA_SPRITE_HEIGHT,
    });
    this.load.svg(FOOD_CACHE_TEXTURE, `${spriteBase}food-cache.svg`, {
      width: FOOD_CACHE_SPRITE_WIDTH, height: FOOD_CACHE_SPRITE_HEIGHT,
    });
  }

  create() {
    this.viewState = createViewState(PLAYER_START_X, PLAYER_START_Y);
    this.gfx = this.add.graphics();
    this.antSprites = new AntSpritePool(this);

    // Input registration — keyboard is GameScene-only (Pitfall 2).
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof this.wasd;
    this.tabKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    // Prevent Tab from moving focus to browser UI:
    this.input.keyboard!.addCapture('TAB');
    this.input.mouse!.disableContextMenu();

    // Drag-pan registration — returns dragState ref for processCameraInput
    this.dragState = registerDragPan(this, this.viewState);

    // Phase 9 Plan 06 keyboard — P toggles pause; 1/2/4 set speed.
    // SPACE is reserved for pan gesture (Phase 8.5 decision — see file header Pitfall 6).
    this.input.keyboard!.on('keydown-P', () => {
      if (this.gamePhase === GamePhase.Playing) {
        this.gamePhase = GamePhase.Paused;
        this.gameLoop.pause();
      } else if (this.gamePhase === GamePhase.Paused) {
        this.gamePhase = GamePhase.Playing;
        this.gameLoop.resume();
      }
    });
    this.input.keyboard!.on('keydown-ONE', () => { this.speedMultiplier = 1; });
    this.input.keyboard!.on('keydown-TWO', () => { this.speedMultiplier = 2; });
    this.input.keyboard!.on('keydown-FOUR', () => { this.speedMultiplier = 4; });

    // 09.1 Chunk 2 — X toggles the active underground colony view. Only
    // flips when activeView === 'underground'; inert on the surface view
    // (the HUD label is also hidden there). Event-based to match the
    // P/F9/speed-multiplier pattern above — the keyboard-plugin event bus
    // handles edge-trigger semantics for us (one keydown event per press),
    // avoiding the key-repeat DoS that Phase 08-04 guarded against for
    // Tab via JustDown. SavePrompt phase early-returns in update() but
    // this listener fires from Phaser's keyboard plugin; the SavePrompt
    // overlay is click-driven (no X binding) so a spurious X press during
    // SavePrompt is harmless — it mutates a ViewState field the overlay
    // does not render.
    this.input.keyboard!.on('keydown-X', () => {
      if (this.gamePhase === GamePhase.SavePrompt) return;
      if (this.viewState.activeView !== 'underground') return;
      toggleUndergroundColony(this.viewState);
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

    // Launch HUD scene on top.
    this.scene.launch('UIScene', { viewState: this.viewState, getWorld });
    this.scene.bringToTop('UIScene');

    // World input dispatchers — internally guard on viewState.activeView.
    // Both return the per-registration state object so restartGame / boot
    // helpers can reset them in place without invalidating the closures that
    // Phaser now holds on pointerdown/pointermove/pointerup.
    this.surfaceInputState = registerSurfaceInput(this, getWorld, this.viewState);
    this.undergroundInputState = registerUndergroundInput(this, getWorld, this.viewState);

    // Phase 9 boot: check for existing save. If found, show SavePrompt overlay.
    // Otherwise boot a fresh scenario directly.
    const bootMode = decideBootMode(hasSave);
    if (bootMode === 'prompt') {
      this.gamePhase = GamePhase.SavePrompt;
      const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
      uiScene.showSavePromptOverlay({
        onContinue: () => this.bootFromSave(),
        onNewGame: () => {
          deleteSave();
          this.bootFresh();
        },
      });
    } else {
      this.bootFresh();
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
    this.speedMultiplier = 1;
    // Re-enable autosave for the next session. The flag is set only by
    // bootFromSave's deserialize-throw catch (see issue #66 in the field
    // doc); a fresh start via restartGame should resume normal autosave.
    this.autosaveSuspended = false;
    // tick.ts caches entrance/dig/chamber flow-fields at module scope keyed by
    // colonyId. bootFresh/bootFromSave replace `world` but those singletons
    // survive, so a new session with the same colony IDs would otherwise route
    // ants against the previous world's topology. Clear them here, before the
    // new world first ticks.
    resetFlowFieldCaches();
    // Render-only ant-facing smoothing: same rationale as the flow-field
    // caches. The AntFacingCache is keyed by ant id, and the new session
    // reuses ids 0..N from scratch — a stale heading from the prior session
    // would lock a freshly-spawned ant into the prior ant's direction until
    // the smoothing relaxes. Clearing here keeps boot visually clean.
    this.antFacingCache.reset();
  }

  private bootFresh(): void {
    this.resetSessionState();
    // W1: seed formula — Date.now() is ~1.7e12, exceeds int32. Bitmask-clamp to positive int32.
    // Bitwise ops truncate to int32; 0x7fffffff mask ensures sign bit is clear.
    const seed = generateFreshSeed(Date.now());
    this.currentSeed = seed;
    // createScenario creates BOTH colonies (PLAYER_COLONY_ID + ENEMY_COLONY_ID) unconditionally.
    this.world = createScenario(seed);
    this.finishBoot();
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
      // Genuine corruption: discard so we don't loop the user.
      deleteSave();
      this.bootFresh();
      return;
    }
    this.currentSeed = loaded.seed;
    this.world = nextWorld;
    // SCEN-06 replay truth: restore inputLog completely so the continued session
    // can be replayed byte-for-byte from (seed, inputLog) per Plan 04 Task 1.
    for (const c of loaded.inputLog) this.inputLog.push(c);
    this.finishBoot();
  }

  private finishBoot(): void {
    this.prevState = createScenario(this.currentSeed);
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
      },
      onTickOutcome: (outcome) => {
        this.currentOutcome = outcome;
        this.gamePhase = GamePhase.GameOver;
        // W2: first-class pause via Plan 06 Task 1 API — no setMsPerTick(Infinity)
        this.gameLoop.pause();
        const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
        uiScene.showGameOverOverlay(outcome, () => this.restartGame());
      },
      getMsPerTick: () => MS_PER_TICK / this.speedMultiplier,
    });

    this.gamePhase = GamePhase.Playing;
    this.gameLoop.resume();  // ensure running (createGameLoop default is not paused)
    this.lastAutosaveMs = performance.now();
    // UIScene and world-input handlers resolve `this.world` lazily via the
    // getWorld accessor installed in create(), so the new reference is picked
    // up automatically on bootFresh, bootFromSave, and restartGame.
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
    // bootFresh → finishBoot resumes the loop; this is the authoritative restart path.
    this.bootFresh();
    if (wasSuspended) {
      this.autosaveSuspended = true;
    }
    const uiScene = this.scene.get('UIScene') as unknown as UIScenePhase9;
    uiScene.hideGameOverOverlay();
  }

  // ---------------------------------------------------------------------------
  // Update loop
  // ---------------------------------------------------------------------------

  update(time: number, delta: number) {
    // SavePrompt phase: overlay handles input; no tick updates expected.
    if (this.gamePhase === GamePhase.SavePrompt) return;

    // Tab toggles view (JustDown handles key-press edge, not held).
    if (Phaser.Input.Keyboard.JustDown(this.tabKey)) {
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
    processCameraInput(this.viewState, {
      cursors: this.cursors,
      wasd: this.wasd,
      dragState: this.dragState,
    });

    const cam = this.viewState.activeView === 'surface' ? this.viewState.surfaceCamera : this.viewState.undergroundCamera;
    const worldW = this.viewState.activeView === 'surface' ? SURFACE_GRID_WIDTH : UNDERGROUND_GRID_WIDTH;
    const worldH = this.viewState.activeView === 'surface' ? SURFACE_GRID_HEIGHT : UNDERGROUND_GRID_HEIGHT;
    clampCamera(cam, worldW, worldH);

    // Draw world.
    const alpha = this.gameLoop.accumulatorMs / MS_PER_TICK;
    const gfx = this.gfx as unknown as GfxLike;
    gfx.clear();
    this.antSprites.beginFrame();
    drawPheromoneOverlay(gfx, this.world, cam, this.viewState.activeView);
    if (this.viewState.activeView === 'surface') {
      const pending =
        this.surfaceInputState.pendingEntranceTileX !== null &&
        this.surfaceInputState.pendingEntranceTileY !== null
          ? {
              tileX: this.surfaceInputState.pendingEntranceTileX,
              tileY: this.surfaceInputState.pendingEntranceTileY,
            }
          : null;
      drawSurface(
        gfx,
        this.antSprites,
        this.prevState,
        this.world,
        alpha,
        cam,
        pending,
        this.antFacingCache,
      );
    } else {
      drawUnderground(
        gfx,
        this.antSprites,
        this.prevState,
        this.world,
        alpha,
        cam,
        this.viewState.activeUndergroundColonyId,
        this.antFacingCache,
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
  getWorld(): WorldState { return this.world; }
  getViewState(): ViewState { return this.viewState; }
}
