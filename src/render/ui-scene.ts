// ui-scene.ts — Phase 9 UIScene: full HUD + GameOver/SavePrompt overlays.
//
// Renders per-frame: colony stats, behavior triangle widget, minimap, view-toggle button,
// and the context menu (when visible).
//
// Phase 9 Plan 06 additions:
//   - showGameOverOverlay / hideGameOverOverlay — Victory/Defeat/MutualDestruction screen
//   - showSavePromptOverlay / hideSavePromptOverlay — Continue or New Game on refresh
//   - window.__phase9_ui.activeOverlay — published for Plan 07 Playwright observability
//   - SAVE_PROMPT_CONTINUE_RECT / SAVE_PROMPT_NEW_GAME_RECT / GAME_OVER_RESTART_RECT exports
//
// Two-scene topology: UIScene runs on top of GameScene. Phaser camera for UIScene is
// non-scrolling by default, so HUD elements stay screen-fixed.
//
// IMPORTANT: setScrollFactor(0) applied to all Text objects created in create().
// Graphics objects in UIScene do not need setScrollFactor since the UIScene camera
// does not scroll (no cameras.setBounds / no camera.scrollX mutation in UIScene).
//
// See CLAUDE.md note: do NOT write JSDoc comments with double-dash dividers in production
// files that touch world fields — check-sim-boundary.sh would false-positive on FNDN-07.

import * as Phaser from 'phaser';
import type { ViewState, ToolId } from './camera.js';
import { toggleView, toggleUndergroundColony } from './camera.js';
import type { SpeedControl } from './hud-controls.js';
import type { WorldState } from '../sim/types.js';
import { HUD } from './sprites.js';
import { GameOutcome } from '../sim/game-over.js';
import {
  formatOutcomeTitle,
  formatKillStatsSubtitle,
  formatCauseSubtitle,
  type QueenDeathCause,
} from './ui-scene-logic.js';
import { PLAYER_COLONY_ID as _PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import {
  triggerScreenEdgeFlash as drawScreenEdgeFlash,
  type FlashDirection,
} from './screen-effects.js';
import { CANVAS_W, CANVAS_H } from './sprites.js';

// Re-export pure helpers for Plan 07 and external consumers
export { formatOutcomeTitle, formatKillStatsSubtitle, formatCauseSubtitle, type QueenDeathCause };

// ---------------------------------------------------------------------------
// Plan 07 Playwright observability contract
// ---------------------------------------------------------------------------

export type ActiveOverlay =
  | 'none'
  | 'save-prompt'
  | 'game-over'
  | 'pause-menu'
  | 'save-load'
  // Issue #122 / ADR 0013 — end-of-game survey overlay. Shown either after
  // a terminal outcome (taking precedence over the bare game-over panel
  // when the feature flag is on) or via the pause menu's "Quit & feedback"
  // action. See showSurveyOverlay / hideSurveyOverlay for the lifecycle.
  | 'survey';

// Phase 09.1 Chunk 2 — enemy underground observability. Exposed via the same
// __phase9_ui global so Playwright can read which colony the underground view
// is currently scoped to without OCR against the canvas-drawn HUD.
export type ActiveUndergroundLabel = 'Your Colony' | 'Enemy Colony';

// Distinguishes the two boot overlays that both report activeOverlay
// 'save-prompt': the fresh-boot "Choose Difficulty" overlay vs a real
// Continue/New Game SavePrompt. Without this, a Playwright test cannot tell a
// fresh boot (Choose Difficulty) from a wrongly-shown SavePrompt, since the
// activeOverlay HUD state is reused for both. 'none' when neither is up.
export type BootScreen = 'none' | 'save-prompt' | 'difficulty-select';

declare global {
  interface Window {
    __phase9_ui?: {
      activeOverlay: ActiveOverlay;
      activeUndergroundLabel?: ActiveUndergroundLabel;
      bootScreen?: BootScreen;
      // Issue #193 — live game speed (1×/2×/4×), so Playwright can assert the
      // speed-cycle control by value instead of pixel-diffing the rendered label.
      speedMultiplier?: SpeedMultiplier;
    };
  }
}

/** Single publisher for window.__phase9_ui (Playwright observability). Merges a
 *  partial patch over the previously-published fields so each caller states only
 *  what it changes and the other observability fields survive. Guarded by a
 *  typeof window check so Vitest (Node) contexts don't crash.
 *
 *  Preservation uses `??`, so a field is never cleared back to undefined here:
 *  every published field is set-once-then-sticky. That matches how all callers
 *  use it — they only ever publish a concrete value, never clear one (the union
 *  members like 'none' are real strings, not undefined, so they publish fine). */
function publishPhase9(patch: Partial<NonNullable<Window['__phase9_ui']>>): void {
  if (typeof window === 'undefined') return;
  const prev = window.__phase9_ui;
  const next: NonNullable<Window['__phase9_ui']> = {
    activeOverlay: patch.activeOverlay ?? prev?.activeOverlay ?? 'none',
  };
  const undergroundLabel = patch.activeUndergroundLabel ?? prev?.activeUndergroundLabel;
  if (undergroundLabel !== undefined) next.activeUndergroundLabel = undergroundLabel;
  const boot = patch.bootScreen ?? prev?.bootScreen;
  if (boot !== undefined) next.bootScreen = boot;
  const speed = patch.speedMultiplier ?? prev?.speedMultiplier;
  if (speed !== undefined) next.speedMultiplier = speed;
  window.__phase9_ui = next;
}

/** Publishes the active overlay. Preserves the other observability fields. */
function setActiveOverlay(next: ActiveOverlay): void {
  publishPhase9({ activeOverlay: next });
}

/** Publishes the current underground colony label for Playwright observability.
 *  Called every UIScene.update() frame. Preserves the other published fields. */
function setActiveUndergroundLabel(next: ActiveUndergroundLabel): void {
  publishPhase9({ activeUndergroundLabel: next });
}

/** Publishes which boot overlay is up so Playwright can distinguish the fresh-boot
 *  "Choose Difficulty" overlay from a real Continue/New Game SavePrompt — both
 *  report activeOverlay 'save-prompt'. Preserves the other published fields. */
function setBootScreen(next: BootScreen): void {
  publishPhase9({ bootScreen: next });
}

/** Publishes the live speed multiplier (1×/2×/4×) so Playwright can assert the
 *  speed-cycle control deterministically instead of pixel-diffing the rendered
 *  label (issue #193). GameScene calls this on every speedMultiplier write.
 *  Preserves the other published fields. */
export function publishSpeedMultiplier(next: SpeedMultiplier): void {
  publishPhase9({ speedMultiplier: next });
}

// ---------------------------------------------------------------------------
// Overlay button rects — exported for Plan 07 Playwright coordinate-based clicks
// ---------------------------------------------------------------------------

/** Canvas-local rect for the SavePrompt "Continue" button. */
export const SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 } as const;
/** Canvas-local rect for the SavePrompt "New Game" button. */
export const SAVE_PROMPT_NEW_GAME_RECT = { x: 300, y: 320, w: 120, h: 32 } as const;
/** Canvas-local rect for the GameOver "Restart" button. */
export const GAME_OVER_RESTART_RECT = { x: 300, y: 345, w: 120, h: 32 } as const;
/** Canvas-local rects for the DifficultySelect buttons (Easy / Normal / Hard). */
export const DIFFICULTY_EASY_RECT = { x: 180, y: 260, w: 140, h: 40 } as const;
export const DIFFICULTY_NORMAL_RECT = { x: 330, y: 260, w: 140, h: 40 } as const;
export const DIFFICULTY_HARD_RECT = { x: 480, y: 260, w: 140, h: 40 } as const;
import {
  createSliderDragState,
  drawSlider,
  screenToSliderRatio,
  isInsideSlider,
  SLIDER_GEOMETRY,
  type SliderDragState,
} from './triangle-widget.js';
import { drawMinimap, applyMinimapClick } from './minimap.js';
import {
  TOOL_ORDER,
  TOOL_LABEL,
  toolButtonRect,
  toolButtonAt,
  SPEED_CONTROL_ORDER,
  speedControlRect,
  speedControlAt,
  hintTextFor,
  queueFullHint,
} from './hud-controls.js';
import {
  contextMenuState,
  hideContextMenu,
  requestHideContextMenu,
  applyPendingContextMenuHide,
  applyPendingContextMenuShow,
} from './context-menu-state.js';
import {
  CONTEXT_MENU_ITEMS,
  contextMenuItemAt,
  isInsideContextMenu,
  itemLabelPos,
  drawContextMenuGeometry,
  visibleContextMenuItems,
  type ContextMenuItem,
} from './context-menu-layout.js';
import {
  computeHudStats,
  formatAntsLabel,
  formatFoodLabel,
  formatQueenLabel,
  queenBarRect,
  queenLabelRect,
  queenHealthBarColor,
  queenHealthBarFillWidth,
  HUD_STATS_COLORS,
  HUD_STATS_LAYOUT,
} from './hud-stats.js';
import {
  computeAntActivity,
  formatAntActivityLines,
  ANT_ACTIVITY_PANEL,
  ANT_ACTIVITY_PANEL_COLORS,
} from './ant-activity.js';
import {
  antActivityPanelState,
  toggleAntActivityPanel,
  hideAntActivityPanel,
  requestHideAntActivityPanel,
  applyPendingAntActivityPanelHide,
} from './ant-activity-panel-state.js';
import {
  pauseMenuItems,
  pageTitle,
  itemAt as pauseMenuItemAt,
  titleCenterY as pauseMenuTitleCenterY,
  nextSpeedMultiplier,
  CANVAS_W as PAUSE_MENU_CANVAS_W,
  CANVAS_H as PAUSE_MENU_CANVAS_H,
  type PauseMenuPage,
  type PauseMenuItem,
  type PauseMenuItemId,
  type SpeedMultiplier,
} from './pause-menu-layout.js';
import {
  saveLoadDialogItems,
  formatSaveInfoLine,
  dialogTitle as saveLoadDialogTitle,
  itemAt as saveLoadDialogItemAt,
  DIALOG_TITLE_Y,
  DIALOG_INFO_Y,
  type SaveLoadDialogItem,
  type SaveLoadDialogItemId,
} from './save-load-dialog-layout.js';
import {
  SURVEY_CANVAS_W,
  SURVEY_CANVAS_H,
  SURVEY_TITLE_Y,
  SURVEY_RATING_ROW_Y,
  SURVEY_FREE_TEXT_RECT,
  SURVEY_BROKEN_CHECKBOX_RECT,
  SURVEY_UPLOAD_CHECKBOX_RECT,
  SURVEY_CONSENT_TEXT_Y,
  SURVEY_CONSENT_DISCLOSURE,
  SURVEY_SUBMIT_BUTTON_RECT,
  SURVEY_SKIP_BUTTON_RECT,
  SURVEY_CHECKBOX_LABEL_GAP,
  surveyRatingButtons,
  surveyHitTest,
  surveyConfirmationHitTest,
} from './survey-overlay-layout.js';
import {
  PLAYTRACE_FREE_TEXT_MAX,
  truncateFreeText,
  type PlaytraceSurvey,
} from './playtrace-upload.js';

/** Issue #115 — duration of the post-Save-Now "Saved" / "Save failed" flash
 *  rendered above the dialog's info line. 1500 ms is long enough to be
 *  noticed without slowing down a player who wants to chain Save → Continue. */
const SAVE_FLASH_MS = 1500;

/** Stage 1 controls rework (issue #18) — total visible lifetime of an onboarding
 *  caption (300ms fade-in + 800ms hold + 400ms fade-out), used to size the hint-
 *  strip yield window so the strip reappears exactly as the caption clears. */
const CAPTION_TOTAL_MS = 1500;

/** Stage 1 controls rework — how long the "paused queue full" hint stays up. */
const PAUSED_QUEUE_FULL_HINT_MS = 1500;
import { loadSettings, saveSettings } from '../platform/settings.js';
import { hasSave, hasIncompatibleSave, getSaveInfo, deleteSave } from '../platform/save.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { SetBehaviorRatioCommand, PlaceChamberCommand } from '../sim/commands.js';
import { enqueueCommand } from '../input/command-queue.js';
import type { CommandFeedforward } from './command-feedforward.js';

// ---------------------------------------------------------------------------
// Pause menu callbacks (issue #116)
// ---------------------------------------------------------------------------

/** Callbacks the pause menu invokes; supplied by GameScene when it opens the
 *  menu so the menu module stays free of GameScene type knowledge. */
export interface PauseMenuCallbacks {
  /** Called when the player chooses Resume (or closes the menu via Esc). */
  onResume(): void;
  /** Called when the player picks "Download debug log". */
  onDownloadDebug(): void;
  /** Issue #115 — invoked when the Save/Load row is clicked. Until that issue
   *  lands, the row is rendered disabled and this is never called. */
  onOpenSaveLoad?(): void;
  /** Read the live speedMultiplier so the Settings page can render the
   *  current value in the "Speed: N×" cycle row. Session-only (no settings
   *  persistence — speed resets to 1× on restart per the Phase 4 contract). */
  getSpeedMultiplier?(): SpeedMultiplier;
  /** Apply a new speed value when the Settings page's speed-cycle row is
   *  clicked. The 1/2/4 keyboard shortcuts on GameScene call the same
   *  setter under the hood; both paths converge on speedMultiplier writes. */
  onCycleSpeed?(next: SpeedMultiplier): void;
  /** Issue #122 / ADR 0013 — invoked when the player picks the "Quit &
   *  feedback" entry, taking them to the survey overlay before they
   *  abandon the session. Only present when the feature flag is enabled
   *  (empty VITE_PLAYTRACE_ENDPOINT → undefined → row hidden). */
  onQuitAndSurvey?(): void;
}

/** Issue #115 — callbacks the Save/Load dialog invokes. The dialog reads
 *  save state via the save.ts API directly (hasSave, getSaveInfo, deleteSave);
 *  the callbacks cover GameScene-side actions that the dialog cannot perform
 *  on its own — loading a save into the running scene, restarting the game,
 *  and writing a manual save (which needs GameScene's live seed + inputLog +
 *  world reference). */
export interface SaveLoadDialogCallbacks {
  /** Load the existing save into the running scene and resume play.
   *  Closes the dialog AND the pause menu so the player lands back in game. */
  onContinue(): void;
  /** Discard any existing save and restart with a fresh scenario.
   *  Closes the dialog AND the pause menu. */
  onNewGame(): void;
  /** Write the current world to localStorage via manualSave. Returns true on
   *  success, false on storage failure. The dialog re-renders afterward so
   *  the info line picks up the new saved tick. */
  onSaveNow(): boolean;
  /** Issue #196 — the player committed Delete on the existing save. The dialog
   *  performs the actual `deleteSave()`; this notifies GameScene so it can
   *  release any autosave suspension armed to protect a future-build save (the
   *  bytes being protected are now gone, so the running session must be saveable
   *  again). No-op when nothing was suspended. */
  onDelete(): void;
  /** Close the dialog and return to the pause menu (no game-state change). */
  onBack(): void;
}

// HUD-02 stats row lives entirely inside the 200x24 HUD.STATS rect so
// isPointerOverHUD() correctly masks world-input click-through. Per PRD §6c
// + 09 HUD clarity pass:
//   - Semi-transparent dark background (0x000000, α=0.6) fills the full rect.
//   - Two-row micro-layout inside the 24px rect:
//       Row 1: "Ants: N" (white, left) + "Food: C/M" (green, right-anchored)
//       Row 2: "Queen" label (white, left) + queen health bar (right-anchored)
//   - "Food: C/M" shows current stored over colonyFoodCapacity, both in human
//     units (>> FP_SHIFT). Gives immediate feedback when a FoodStorage chamber
//     completes and capacity grows.
//   - Queen label restored to "Queen" from the prior single-char 'Q' — the
//     bar color alone was not enough for players to tell what it measured.
const STATS_ROW1_Y = HUD.STATS.y + HUD_STATS_LAYOUT.row1YOffset;
const STATS_ROW2_Y = HUD.STATS.y + HUD_STATS_LAYOUT.row2YOffset;
const STATS_TEXT_X = HUD.STATS.x + HUD_STATS_LAYOUT.leftTextInset;

export class UIScene extends Phaser.Scene {
  private viewState!: ViewState;
  // Lazy accessor — returns the live WorldState or undefined pre-boot.
  // GameScene stores a class-field world reference that is undefined until
  // bootFresh/bootFromSave runs; direct capture in init() was a stale-reference
  // bug that froze the HUD on the pre-boot (undefined) world.
  private getWorld!: () => WorldState | undefined;
  // Stage 3a controls rework (issue #18) — the "projected world": the command
  // queue folded through the real sim handlers. Source of truth for the chamber
  // menu's filtering (Codex R5-2) and the forage/fight requested (target) marker.
  // Always defined once a world exists (it aliases the live world when the queue
  // is empty), unlike getWorld which is WorldState|undefined pre-boot.
  private getProjectedWorld!: () => WorldState;
  // Stage 3a controls rework (issue #18) — the same trial-apply feedforward the
  // render cue and underground taps use (GameScene owns the instance). The chamber-
  // menu click gates its PlaceChamber emit on feedforward.willTakeEffect against the
  // projected world, mirroring the underground dig/command taps, so the cue the
  // chamber tint paints and the emitted command can never disagree (cue/command parity).
  private getFeedforward!: () => CommandFeedforward;
  // Issue #116 / dual-handler-fix: GameScene supplies an Esc callback that
  // fires only when no UIScene overlay is currently open. Optional so older
  // call sites (none today, but kept for safety) can still launch UIScene
  // without it; without the callback Esc on a clean canvas is a no-op.
  private onEscape: (() => void) | null = null;
  // Stage 1 controls rework (issue #18) — gated, GameScene-owned callbacks for
  // the tool palette + speed widget, and a paused-state accessor for the
  // enqueueCommand cap on chamber/behavior commands.
  private onSelectTool: ((tool: ToolId) => void) | null = null;
  private onSpeedControl: ((control: SpeedControl) => void) | null = null;
  // Fires after a successful minimap click-to-nav so GameScene can cancel any
  // in-flight wheel zoom-lerp/anchor on the active camera; otherwise the next
  // tickZoomLerp re-anchors centerX/Y from the fixed cursor point and throws the
  // minimap recenter away (mirrors the keyboard/drag-pan cancel in game-scene.ts).
  private onMinimapNav: (() => void) | null = null;
  private isPausedFn: (() => boolean) | null = null;
  private getSpeedMultiplierFn: (() => 1 | 2 | 4) | null = null;
  // Tool palette button labels (3) and the hint strip text + speed widget labels.
  private toolButtonTexts: Phaser.GameObjects.Text[] = [];
  private hintText!: Phaser.GameObjects.Text;
  private speedControlTexts: Phaser.GameObjects.Text[] = [];
  // Caption-yield: showCaption sets this to `time.now + duration` when a caption
  // that overlaps the hint strip is active; the hint strip yields (hides) until
  // then so the two don't visually collide (Codex R4-1). Cleared naturally as
  // time passes.
  private hintYieldUntilMs = 0;
  // Queue-full flash: set to time.now + duration when enqueueCommand drops a
  // command at the cap; the hint strip shows the warning until then, overriding
  // the static legend. `pausedQueueFullWasPaused` records the pause state at the
  // moment of the drop so renderHintStrip picks the accurate message (paused →
  // "resume to continue"; running → "try again"). (Fix 3 / Codex P2.)
  private pausedQueueFullUntilMs = 0;
  private pausedQueueFullWasPaused = false;
  private gfx!: Phaser.GameObjects.Graphics;
  private antsText!: Phaser.GameObjects.Text;
  private foodText!: Phaser.GameObjects.Text;
  private queenLabelText!: Phaser.GameObjects.Text;
  private triangleLabels!: Phaser.GameObjects.Text[];
  private viewToggleText!: Phaser.GameObjects.Text;
  // Phase 09.1 Chunk 2 — underground colony label. Visible only when
  // viewState.activeView === 'underground'. Reads 'Your Colony' vs
  // 'Enemy Colony' from viewState.activeUndergroundColonyId each frame.
  private undergroundLabelText!: Phaser.GameObjects.Text;
  private contextMenuLabels!: Phaser.GameObjects.Text[];
  // Snapshot of the items last rendered so pointerdown hit-testing (which fires
  // BEFORE the next update frame) uses the same filtered list the player saw.
  // Updated at the end of each update() when the menu is visible.
  private contextMenuVisibleItems: readonly ContextMenuItem[] = CONTEXT_MENU_ITEMS;
  private antActivityText!: Phaser.GameObjects.Text;
  private dragState!: SliderDragState;

  // Phase 9 Plan 06 — overlay groups (null = overlay not currently shown)
  private gameOverGroup: Phaser.GameObjects.GameObject[] = [];
  private savePromptGroup: Phaser.GameObjects.GameObject[] = [];
  private difficultySelectGroup: Phaser.GameObjects.GameObject[] = [];
  // Issue #116 — pause menu overlay state. Empty group means "not visible";
  // page tracks which sub-screen is currently rendered. callbacks/saveLoadEnabled
  // are captured at show time so we can re-render on page navigation without
  // the caller re-supplying them.
  private pauseMenuGroup: Phaser.GameObjects.GameObject[] = [];
  private pauseMenuPage: PauseMenuPage = 'main';
  private pauseMenuCallbacks: PauseMenuCallbacks | null = null;
  private pauseMenuSaveLoadEnabled: boolean = false;
  // Items snapshot used for hit-testing the click that fires after the next
  // pointerdown — kept aligned with what was last drawn so a re-render between
  // mouse events doesn't leave the hit-test against stale rects.
  private pauseMenuVisibleItems: readonly PauseMenuItem[] = [];

  // Issue #115 — Save/Load dialog overlay state. Mirrors the pause menu
  // shape (group + visible-items snapshot + captured callbacks) and adds
  // per-row confirm flags for destructive actions (Delete / New Game).
  // The dialog REPLACES the pause menu visually while open; Back re-shows
  // the pause menu. Game loop stays paused throughout — gameLoop.pause()
  // was called when the menu opened and is reversed only by Resume / Continue.
  private saveLoadDialogGroup: Phaser.GameObjects.GameObject[] = [];
  private saveLoadDialogCallbacks: SaveLoadDialogCallbacks | null = null;
  private saveLoadDialogVisibleItems: readonly SaveLoadDialogItem[] = [];
  private saveLoadDialogConfirming: { delete: boolean; newGame: boolean } = {
    delete: false,
    newGame: false,
  };
  // Issue #115 — Save Now feedback. After a manualSave call, the dialog
  // flashes a brief "Saved" / "Save failed" line above the regular info
  // text for SAVE_FLASH_MS so the player sees an explicit acknowledgement
  // instead of having to spot the (already-correct) tick increment.
  // Cleared by a Phaser delayedCall so the dialog quietly returns to the
  // standard info-line state.
  private saveLoadDialogFlash: 'none' | 'saved' | 'failed' = 'none';
  private saveLoadDialogFlashTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super({ key: 'UIScene' });
  }

  init(data: {
    viewState: ViewState;
    getWorld: () => WorldState | undefined;
    getProjectedWorld: () => WorldState;
    getFeedforward: () => CommandFeedforward;
    onEscape?: () => void;
    // Stage 1 controls rework (issue #18) — GameScene-owned, gated callbacks so
    // the HUD palette/speed widget route through the same gates as the hotkeys.
    onSelectTool?: (tool: ToolId) => void;
    onSpeedControl?: (control: SpeedControl) => void;
    onMinimapNav?: () => void;
    isPaused?: () => boolean;
    getSpeedMultiplier?: () => 1 | 2 | 4;
  }) {
    this.viewState = data.viewState;
    this.getWorld = data.getWorld;
    this.getProjectedWorld = data.getProjectedWorld;
    this.getFeedforward = data.getFeedforward;
    this.onEscape = data.onEscape ?? null;
    this.onSelectTool = data.onSelectTool ?? null;
    this.onSpeedControl = data.onSpeedControl ?? null;
    this.onMinimapNav = data.onMinimapNav ?? null;
    this.isPausedFn = data.isPaused ?? null;
    this.getSpeedMultiplierFn = data.getSpeedMultiplier ?? null;
  }

  create() {
    this.gfx = this.add.graphics();
    this.dragState = createSliderDragState();

    // HUD-02 stats row — three Texts confined to the 200x24 HUD.STATS rect,
    // two-row layout. Row 1: antsText (white, left) + foodText (green, right-
    // anchored). Row 2: queenLabelText (white, left) + queen health bar
    // (drawn in update() via gfx so its color can change per frame without
    // Text churn).
    this.antsText = this.add.text(STATS_TEXT_X, STATS_ROW1_Y, 'Ants: 0', {
      color: HUD_STATS_COLORS.antsTextCss,
      fontSize: '10px',
      fontFamily: 'monospace',
    });
    this.antsText.setScrollFactor(0);

    this.foodText = this.add.text(STATS_TEXT_X, STATS_ROW1_Y, 'Food: 0/0', {
      color: HUD_STATS_COLORS.foodTextCss,
      fontSize: '10px',
      fontFamily: 'monospace',
    });
    this.foodText.setScrollFactor(0);

    // Queen label — "Queen" text sits on row 2 (09 HUD clarity pass).
    // Position is set in update() from queenLabelRect so layout constants
    // remain single-sourced in hud-stats.ts.
    this.queenLabelText = this.add.text(STATS_TEXT_X, STATS_ROW2_Y, formatQueenLabel(), {
      color: HUD_STATS_COLORS.queenLabelCss,
      fontSize: '10px',
      fontFamily: 'monospace',
    });
    this.queenLabelText.setScrollFactor(0);

    // Slider extreme labels — static text, created once. Phase 10 / D-01:
    // 2 labels (Forage / Fight) replace the prior 3 triangle vertex labels.
    // Field name `triangleLabels` retained to minimize diff churn — a future
    // cleanup may rename to `sliderLabels` alongside the file rename.
    //
    // Phase 8.5 invariant preserved: labels render INSIDE HUD.TRIANGLE zone
    // (x: [8,128), y: [532,576)) so pointer clicks on the visible text don't
    // fall through to world input. After issue #13's slider-zone shrink the
    // label sits flush at the top edge — trackY=554 - 22 = 532 = HUD.TRIANGLE.y,
    // and the 10px label text occupies y:[532,542], inside the zone.
    this.triangleLabels = [
      this.add.text(HUD.TRIANGLE.x + 4, SLIDER_GEOMETRY.trackY - 22, 'Forage', {
        color: '#ffffff',
        fontSize: '10px',
      }),
      this.add.text(HUD.TRIANGLE.x + HUD.TRIANGLE.w - 28, SLIDER_GEOMETRY.trackY - 22, 'Fight', {
        color: '#ffffff',
        fontSize: '10px',
      }),
    ];
    for (const label of this.triangleLabels) {
      label.setScrollFactor(0);
    }

    // View toggle button label — text updated per-frame.
    this.viewToggleText = this.add.text(
      HUD.VIEW_TOGGLE.x + 4,
      HUD.VIEW_TOGGLE.y + 6,
      'Underground >',
      { color: '#ffffff', fontSize: '12px', backgroundColor: '#333333' },
    );
    this.viewToggleText.setPadding(4);
    this.viewToggleText.setScrollFactor(0);

    // Phase 09.1 Chunk 2 + issue #14 — underground colony toggle button.
    // Sits above VIEW_TOGGLE (HUD.UNDERGROUND_COLONY_TOGGLE) so the two
    // underground-only HUD elements stack vertically. Visibility is bound
    // to activeView === 'underground' in update(); text follows
    // activeUndergroundColonyId (binary toggle).
    //
    // Issue #14 made this a CLICKABLE button (was a passive label) — the
    // X keybind alone left invasion undiscoverable. Click + key both
    // dispatch toggleUndergroundColony. The "(X)" hint surfaces the key
    // for keyboard players. Background matches VIEW_TOGGLE styling so the
    // two read as a stacked pair of toggle buttons.
    this.undergroundLabelText = this.add.text(
      HUD.UNDERGROUND_COLONY_TOGGLE.x + 4,
      HUD.UNDERGROUND_COLONY_TOGGLE.y + 4,
      'Your Colony (X)',
      { color: '#ffffff', fontSize: '12px' },
    );
    this.undergroundLabelText.setScrollFactor(0);
    this.undergroundLabelText.setVisible(false);

    // Stage 1 controls rework (issue #18) — tool palette (HUD.TOOLS), hint strip
    // (HUD.HINTS), and speed widget (HUD.SPEED). Backgrounds + active-tool
    // highlight are drawn in update() via gfx; these Text objects carry the
    // labels. All scroll-locked so they stay pinned to the HUD.
    this.toolButtonTexts = TOOL_ORDER.map((tool, i) => {
      const r = toolButtonRect(i);
      const t = this.add.text(r.x + 4, r.y + r.h / 2 - 6, TOOL_LABEL[tool], {
        color: '#ffffff',
        fontSize: '11px',
        fontFamily: 'monospace',
      });
      t.setScrollFactor(0);
      t.setDepth(5);
      return t;
    });
    this.hintText = this.add.text(HUD.HINTS.x + 2, HUD.HINTS.y + 2, '', {
      color: '#cfd8dc',
      fontSize: '11px',
      fontFamily: 'monospace',
    });
    this.hintText.setScrollFactor(0);
    this.hintText.setDepth(5);
    this.speedControlTexts = SPEED_CONTROL_ORDER.map((control, i) => {
      const r = speedControlRect(i);
      const label = control === 'pause' ? '||' : `${control}x`;
      const t = this.add.text(r.x + 4, r.y + r.h / 2 - 7, label, {
        color: '#ffffff',
        fontSize: '12px',
        fontFamily: 'monospace',
      });
      t.setScrollFactor(0);
      t.setDepth(5);
      return t;
    });

    // Context menu item labels — created once, positioned/shown per frame.
    // One Phaser.Text per ChamberType (Queen / Nursery / Food Storage) so the
    // player can actually read the choices instead of seeing unlabeled stripes.
    this.contextMenuLabels = CONTEXT_MENU_ITEMS.map((item) => {
      const t = this.add.text(0, 0, item.label, {
        color: '#ffffff',
        fontSize: '13px',
        fontFamily: 'monospace',
      });
      t.setScrollFactor(0);
      t.setVisible(false);
      t.setDepth(10); // draw above the gfx stripes
      return t;
    });

    // Ant-activity popup body — single multi-line Text widget anchored to the
    // top-left of ANT_ACTIVITY_PANEL. Created once, shown/hidden and retargeted
    // per frame in update() based on antActivityPanelState.visible.
    this.antActivityText = this.add.text(ANT_ACTIVITY_PANEL.x + 8, ANT_ACTIVITY_PANEL.y + 8, '', {
      color: ANT_ACTIVITY_PANEL_COLORS.textCss,
      fontSize: '11px',
      fontFamily: 'monospace',
    });
    this.antActivityText.setScrollFactor(0);
    this.antActivityText.setVisible(false);
    this.antActivityText.setDepth(11);

    // UIScene is the single owner of Esc. Precedence (close topmost UI first):
    //   1. Save/Load dialog visible → close + onBack (returns to pause menu)
    //   2. Pause menu visible       → close + onResume (resumes game loop)
    //   3. Ant-activity panel open  → hide it
    //   4. Nothing open             → call onEscape (GameScene opens menu)
    //
    // Routing all Esc through one scene avoids the dual-handler race that
    // existed when GameScene also bound keydown-ESC: GameScene opened the
    // menu, then UIScene's escKey handler immediately closed it on the same
    // press, leaving __phase9_ui.activeOverlay stuck at "none".
    const escKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    if (escKey) {
      escKey.on('down', () => {
        // Issue #131 — Esc on the survey form is equivalent to Skip (transitions
        // to the New Game/Retry confirmation). Esc on the confirmation screen
        // defaults to New Game so the player always has a keyboard escape hatch.
        if (this.isSurveyVisible()) {
          if (this.surveyState.showConfirmation) {
            const cb = this.surveyCallbacks;
            this.hideSurveyOverlay();
            cb?.onNewGame();
          } else {
            this.surveyState.showConfirmation = true;
            this.surveyState.confirmedSubmit = false;
            this.renderSurveyOverlay();
          }
          return;
        }
        if (this.isSaveLoadDialogVisible()) {
          const cb = this.saveLoadDialogCallbacks;
          this.hideSaveLoadDialogOverlay();
          cb?.onBack();
          return;
        }
        if (this.isPauseMenuVisible()) {
          const cb = this.pauseMenuCallbacks;
          this.hidePauseMenuOverlay();
          cb?.onResume();
          return;
        }
        if (antActivityPanelState.visible) {
          hideAntActivityPanel();
          return;
        }
        // No UIScene overlay was up — let GameScene handle it (open menu).
        this.onEscape?.();
      });
    }

    // Pointer events for HUD interactions.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      // Issue #122 — survey overlay takes top priority. Once it's open the
      // game is over (or about to be — quit-from-pause path) and no HUD
      // interaction should leak through.
      if (this.isSurveyVisible()) {
        this.dispatchSurveyClick(pointer.x, pointer.y);
        return;
      }

      // Issue #115 — Save/Load dialog absorbs every click while visible.
      // Same guard rationale as the pause menu below; precedence here is
      // strict (dialog > pause menu > HUD) so a click on a dialog button
      // never falls through to a co-located pause-menu button rect.
      if (this.isSaveLoadDialogVisible()) {
        const items = this.saveLoadDialogVisibleItems;
        const hit = saveLoadDialogItemAt(items, pointer.x, pointer.y);
        if (hit !== null) {
          this.dispatchSaveLoadDialogItem(hit.id);
        } else {
          // Click on the dialog background — clear any pending confirm flags
          // so a stray miss doesn't leave a destructive button armed.
          this.saveLoadDialogConfirming = { delete: false, newGame: false };
          this.renderSaveLoadDialog();
        }
        return;
      }

      // Issue #116 — pause menu absorbs every click. Buttons fire their own
      // callbacks via Phaser interactive handlers; this guard prevents a click
      // outside any button from falling through to HUD widgets / world input
      // and is also a safety net against double-firing if a button click and
      // a HUD-zone click happen to coincide.
      if (this.isPauseMenuVisible()) {
        const items = this.pauseMenuVisibleItems;
        const hit = pauseMenuItemAt(items, pointer.x, pointer.y);
        if (hit !== null) {
          this.dispatchPauseMenuItem(hit.id);
        }
        return;
      }

      // Context menu takes precedence when visible. A click inside selects an
      // item; a click anywhere else dismisses the menu AND falls through so
      // the underlying HUD control still receives the click — prevents the
      // menu from lingering after unrelated HUD interactions.
      if (contextMenuState.visible) {
        const items = this.contextMenuVisibleItems;
        if (
          isInsideContextMenu(
            pointer.x,
            pointer.y,
            contextMenuState.screenX,
            contextMenuState.screenY,
            items,
          )
        ) {
          const choice = contextMenuItemAt(
            pointer.x,
            pointer.y,
            contextMenuState.screenX,
            contextMenuState.screenY,
            items,
          );
          const world = this.getWorld();
          if (choice !== null && world) {
            const cmd: PlaceChamberCommand = {
              type: 'PlaceChamber',
              colonyId: PLAYER_COLONY_ID,
              chamberType: choice,
              anchorTileX: contextMenuState.anchorTileX,
              anchorTileY: contextMenuState.anchorTileY,
              issuedAtTick: world.tick,
            };
            // Stage 3a controls rework (issue #18) — gate the emit on the SAME
            // trial-apply the chamber tint paints (computeChamberHover →
            // feedforward.outcome), mirroring handleUndergroundDigTap/CommandTap, so
            // the cue and the emitted command can never disagree (cue/command parity,
            // Codex R2-3/4). visibleContextMenuItems only filters the Queen option on
            // ownership/pending; a Nursery/FoodStorage (or allowed Queen) whose multi-
            // tile footprint is unreachable / overlaps / clips the ceiling paints red
            // yet stays clickable — without this gate that click enqueues a doomed
            // no-op the sim silently drops, wasting a non-Sync cap slot. willTakeEffect
            // runs against the PROJECTED world (queue folded), as the cue does.
            if (this.getFeedforward().willTakeEffect(this.getProjectedWorld(), cmd)) {
              // Stage 1 controls rework (issue #18) — route through enqueueCommand
              // so the non-Sync cap is enforced across ALL producers (Codex R2-8).
              // PlaceChamber is a ONE-SHOT command: it does NOT re-emit, so a drop
              // at the cap is a real loss. Surface the queue-full hint on ANY drop,
              // paused OR unpaused (Codex P2) — unlike the re-emitting paint stroke,
              // which only hints while paused. Pass `paused` so the message is
              // accurate (resume-to-continue vs try-again; Fix 3).
              const paused = this.isPausedFn ? this.isPausedFn() : false;
              if (!enqueueCommand(world, cmd, paused)) this.flashPausedQueueFull(paused);
            }
          }
          requestHideContextMenu();
          return;
        }
        requestHideContextMenu();
        // fall through — process the actual HUD target. The deferred hide
        // lets any cross-scene pointerdown handler that runs after this one
        // still observe visible=true and suppress its own world-click logic.
      }

      // Ant-activity popup — STATS rect click toggles the panel open/closed.
      // Checked before other HUD zones so a click on the stats row can never
      // fall through to world input regardless of panel state.
      if (this.isInsideRect(pointer.x, pointer.y, HUD.STATS)) {
        toggleAntActivityPanel();
        return;
      }
      // Panel-specific click handling while visible:
      //   - click inside the panel body absorbs the click (no-op, don't fall through)
      //   - click outside the panel dismisses it the same way context menus
      //     dismiss — by clicking away. The hide is DEFERRED via
      //     requestHideAntActivityPanel so the panel still registers as
      //     "visible" for any world-input pointerdown handler running later
      //     in the same Phaser dispatch. isPointerOverHUD consults
      //     antActivityPanelState.visible; keeping it true here is what
      //     prevents the dismissal click from falling through to food-mark,
      //     rally placement, entrance designation, or underground dig
      //     marking. applyPendingAntActivityPanelHide commits the flip at
      //     the top of the next UIScene.update frame.
      if (antActivityPanelState.visible) {
        if (this.isInsideRect(pointer.x, pointer.y, ANT_ACTIVITY_PANEL)) {
          return;
        }
        const overHud =
          this.isInsideRect(pointer.x, pointer.y, HUD.TRIANGLE) ||
          this.isInsideRect(pointer.x, pointer.y, HUD.MINIMAP) ||
          this.isInsideRect(pointer.x, pointer.y, HUD.VIEW_TOGGLE) ||
          // Issue #14 — colony-toggle button. Without this entry, a click
          // on the new toggle while the ant-activity panel is up would
          // be classified as "world click", dismissing the panel and
          // dropping the toggle dispatch.
          this.isInsideRect(pointer.x, pointer.y, HUD.UNDERGROUND_COLONY_TOGGLE) ||
          // Stage 1 controls rework (issue #18) — the new interactive HUD zones
          // (tool palette, hint strip, speed widget) must be on the ant-panel
          // allow-list too, else a click on them while the panel is up dismisses
          // the panel and drops the palette/speed dispatch.
          this.isInsideRect(pointer.x, pointer.y, HUD.TOOLS) ||
          this.isInsideRect(pointer.x, pointer.y, HUD.HINTS) ||
          this.isInsideRect(pointer.x, pointer.y, HUD.SPEED);
        if (!overHud) {
          // Click on the world — dismiss and consume. `return` prevents
          // any further UIScene handling; the deferred hide prevents the
          // concurrent world-input handler from interpreting this click.
          requestHideAntActivityPanel();
          return;
        }
        // Click landed on another HUD widget — schedule the dismiss and
        // fall through so that widget still gets its click (triangle drag
        // start, view toggle, minimap). The HUD zone was already masked
        // against world input, so no world race here either.
        requestHideAntActivityPanel();
      }

      // View toggle button
      if (this.isInsideRect(pointer.x, pointer.y, HUD.VIEW_TOGGLE)) {
        toggleView(this.viewState);
        return;
      }
      // Issue #14 — underground colony toggle button. Mirrors the X
      // keybind in game-scene.ts. Gated on activeView === 'underground'
      // so a stray click on the surface view (where the button is
      // invisible) doesn't flip the underground colony invisibly.
      if (
        this.viewState.activeView === 'underground' &&
        this.isInsideRect(pointer.x, pointer.y, HUD.UNDERGROUND_COLONY_TOGGLE)
      ) {
        toggleUndergroundColony(this.viewState);
        return;
      }
      // Stage 1 controls rework (issue #18) — tool palette click. Routes through
      // the GameScene-owned, gated selectTool so a palette pick obeys the same
      // gate as the 1/2/3 hotkeys (and the Chamber-on-surface no-op). Consume the
      // click so it never falls through to the world arbiter.
      const toolHit = toolButtonAt(pointer.x, pointer.y, this.viewState.activeView);
      if (toolHit !== null) {
        this.onSelectTool?.(toolHit);
        return;
      }
      // Speed widget click — ⏸ toggles the 'user' pause; 1×/2×/4× set the
      // multiplier (without changing pause reasons). Both via GameScene.
      const speedHit = speedControlAt(pointer.x, pointer.y);
      if (speedHit !== null) {
        this.onSpeedControl?.(speedHit);
        return;
      }
      // Minimap click. On a successful recenter, notify GameScene so it can drop
      // any in-flight wheel zoom-lerp/anchor on the active camera — otherwise the
      // next tickZoomLerp re-anchors from the fixed cursor point and overrides the
      // minimap nav (same class of bug the keyboard/drag-pan cancel prevents).
      if (applyMinimapClick(this.viewState, pointer.x, pointer.y)) {
        this.onMinimapNav?.();
        return;
      }
      // Behavior slider drag start (Phase 10 / D-01 — 1-D Forage↔Fight axis)
      if (isInsideSlider(pointer.x, pointer.y)) {
        this.dragState.isDragging = true;
        this.dragState.targetRatio = screenToSliderRatio(pointer.x);
        return;
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.dragState.isDragging) return;
      if (!pointer.isDown) return;
      // 1-D slider: only x is consulted; pointer y is ignored within drag.
      this.dragState.targetRatio = screenToSliderRatio(pointer.x);
    });

    // Belt-and-suspenders: clear overlay window state on scene shutdown to
    // prevent stale __phase9_ui surviving a scene restart.
    const teardown = () => {
      this.hideGameOverOverlay();
      this.hideSavePromptOverlay();
      this.hideSaveLoadDialogOverlay();
      this.hidePauseMenuOverlay();
      this.hideSurveyOverlay();
      hideAntActivityPanel();
      setActiveOverlay('none');
    };
    this.events.on('shutdown', teardown);
    // Defensive: Phaser fires `shutdown` before `destroy`, but a race
    // between game.destroy(true) and a pending overlay state could leave
    // the DOM textarea or its resize listener attached if `shutdown`
    // didn't reach hideSurveyOverlay. Wiring `destroy` too costs nothing
    // and guarantees the DOM leak doesn't outlive the game instance.
    this.events.on('destroy', teardown);

    this.input.on('pointerup', () => {
      if (this.dragState.isDragging) {
        const world = this.getWorld();
        if (world) {
          // Emit exactly one SetBehaviorRatioCommand per drag session (T-08-12).
          const cmd: SetBehaviorRatioCommand = {
            type: 'SetBehaviorRatio',
            colonyId: PLAYER_COLONY_ID,
            ratio: this.dragState.targetRatio,
            issuedAtTick: world.tick,
          };
          // Stage 1 controls rework (issue #18) — route through enqueueCommand
          // (non-Sync cap across all producers; Codex R2-8). SetBehaviorRatio is
          // a ONE-SHOT command: it does NOT re-emit, so a drop at the cap is a
          // real loss. Surface the queue-full hint on ANY drop, paused OR unpaused
          // (Codex P2) — unlike the re-emitting paint stroke, which only hints
          // while paused. Pass `paused` so the message is accurate (Fix 3).
          const paused = this.isPausedFn ? this.isPausedFn() : false;
          if (!enqueueCommand(world, cmd, paused)) this.flashPausedQueueFull(paused);
        }
        this.dragState.isDragging = false;
      }
    });
  }

  update() {
    // Apply any pending show/hide from the previous frame's pointerdown dispatch
    // BEFORE reading the state, so cross-scene race conditions are resolved
    // deterministically at the frame boundary. Hide runs first so if both are
    // pending (rare — would need two pointerdowns in one frame) the most
    // recently-requested show wins.
    applyPendingContextMenuHide();
    applyPendingContextMenuShow();
    applyPendingAntActivityPanelHide();
    this.gfx.clear();

    // Pull the live world each frame via the lazy getter. Returns undefined
    // pre-boot (SavePrompt phase) and on any future world swap between frames.
    const world = this.getWorld();
    if (!world) return;

    // Auto-dismiss the underground context menu if the player switches away
    // from the underground view (via Tab key, toggle button, or minimap click).
    // The menu only makes sense while underground; leaving it visible on the
    // surface view would be a stale artifact.
    if (contextMenuState.visible && this.viewState.activeView !== 'underground') {
      hideContextMenu();
    }

    const colony = world.colonies[PLAYER_COLONY_ID];

    // HUD-02 stats bar per PRD §6c:
    //   - semi-transparent dark background over the full 200x24 rect
    //   - "Ants: N" white text, "Food: N" green-tinted text, "Queen:" label
    //   - visual queen-health bar right-anchored inside the rect, color by pct
    this.gfx.fillStyle(HUD_STATS_COLORS.background, HUD_STATS_COLORS.backgroundAlpha);
    this.gfx.fillRect(HUD.STATS.x, HUD.STATS.y, HUD.STATS.w, HUD.STATS.h);

    if (colony) {
      const s = computeHudStats(world, colony);
      this.antsText.setText(formatAntsLabel(s));
      this.foodText.setText(formatFoodLabel(s));

      // Two-row layout (09 HUD clarity pass). Row 1: Ants left-anchored,
      // Food right-anchored against the stats rect's right edge (minus a
      // small inset). Row 2: "Queen" left-anchored, queen health bar right-
      // anchored. Rows are disjoint so "Food: C/M" can grow without fighting
      // the queen label for horizontal budget.
      const bar = queenBarRect(HUD.STATS);
      const label = queenLabelRect(HUD.STATS);
      this.queenLabelText.setPosition(label.x, label.y);
      const FOOD_RIGHT_INSET = 6;
      const foodX = HUD.STATS.x + HUD.STATS.w - FOOD_RIGHT_INSET - this.foodText.width;
      this.foodText.setPosition(foodX, STATS_ROW1_Y);

      // Queen health bar — track + proportional fill.
      this.gfx.fillStyle(HUD_STATS_COLORS.barTrack, 1);
      this.gfx.fillRect(bar.x, bar.y, bar.w, bar.h);
      const fillW = queenHealthBarFillWidth(s, bar.w);
      if (fillW > 0) {
        this.gfx.fillStyle(queenHealthBarColor(s), 1);
        this.gfx.fillRect(bar.x, bar.y, fillW, bar.h);
      }
    }

    // Behavior slider widget (Phase 10 / D-01 — 1-D Forage↔Fight axis).
    // currentRatio denominator is forage + fight only — auto-dig (CTRL-06)
    // and auto-nurse (CLNY-09) are demand-driven roles outside the player
    // ratio and are visualized elsewhere (status indicators / future BACKLOG
    // HUD). The slider's domain is the player-controlled axis; dual markers
    // track player input (target) vs catch-up task census (current) on that
    // axis only.
    if (colony) {
      const ff = colony.taskCensus.forage + colony.taskCensus.fight;
      // WR-03: when no worker is currently Foraging or Fighting (e.g. transient
      // pure-nurse / pure-dig states in small colonies during a brood spike or
      // a 1-worker colony with auto-dig active), the prior `{forage:100,fight:0}`
      // fallback pinned the current marker to the forage extreme — visually
      // contradicting the actual (zero-on-axis) state. Fall back to the player's
      // intent (`targetRatio`) so the current marker overlays the target marker
      // rather than fabricating an extreme position.
      const currentRatio =
        ff > 0
          ? {
              forage: Math.round((colony.taskCensus.forage * 100) / ff),
              fight: Math.round((colony.taskCensus.fight * 100) / ff),
            }
          : { forage: colony.targetRatio.forage, fight: colony.targetRatio.fight };
      // Stage 3a controls rework (issue #18): the TARGET (requested) marker reads
      // the PROJECTED colony's targetRatio so a queued SetBehaviorRatio shows the
      // requested position immediately while paused; the CURRENT marker above
      // stays on the LIVE colony's taskCensus. An in-progress drag still wins so
      // the marker tracks the live drag state (don't break direct manipulation).
      // projColony is the projected PLAYER colony; it aliases the live colony when
      // the queue is empty, and is guarded to fall back to the live targetRatio if
      // (defensively) absent so the marker never reads undefined.
      const projColony = this.getProjectedWorld().colonies[PLAYER_COLONY_ID];
      const targetRatio = this.dragState.isDragging
        ? this.dragState.targetRatio
        : (projColony?.targetRatio ?? colony.targetRatio);
      drawSlider(
        this.gfx as unknown as import('./draw-surface.js').GfxLike,
        currentRatio,
        targetRatio,
      );
    }

    // Minimap
    drawMinimap(this.gfx as unknown as import('./draw-surface.js').GfxLike, world, this.viewState);

    // View toggle button background
    this.gfx.fillStyle(0x333333, 1);
    this.gfx.fillRect(HUD.VIEW_TOGGLE.x, HUD.VIEW_TOGGLE.y, HUD.VIEW_TOGGLE.w, HUD.VIEW_TOGGLE.h);
    this.viewToggleText.setText(
      this.viewState.activeView === 'surface' ? 'Underground >' : '< Surface',
    );

    // Phase 09.1 Chunk 2 + issue #14 — underground colony toggle button.
    // Only visible in the underground view; driven by the binary toggle
    // reducer in camera.ts. The Playwright label feed
    // (window.__phase9_ui.activeUndergroundLabel) keeps the bare data
    // string ('Your Colony' / 'Enemy Colony') so existing tests don't have
    // to know about the (X) hint affordance the button now renders.
    const undergroundLabel: ActiveUndergroundLabel =
      this.viewState.activeUndergroundColonyId === ENEMY_COLONY_ID ? 'Enemy Colony' : 'Your Colony';
    const undergroundShowing = this.viewState.activeView === 'underground';
    if (undergroundShowing) {
      // Draw the toggle background as a Graphics fill (matches VIEW_TOGGLE
      // pattern below) so the click zone reads as a button.
      this.gfx.fillStyle(0x333333, 1);
      this.gfx.fillRect(
        HUD.UNDERGROUND_COLONY_TOGGLE.x,
        HUD.UNDERGROUND_COLONY_TOGGLE.y,
        HUD.UNDERGROUND_COLONY_TOGGLE.w,
        HUD.UNDERGROUND_COLONY_TOGGLE.h,
      );
    }
    this.undergroundLabelText.setText(`${undergroundLabel} (X)`);
    this.undergroundLabelText.setVisible(undergroundShowing);
    // Expose regardless of visibility so tests can assert the underlying
    // toggle state even if the surface view is active. Cheap string write.
    setActiveUndergroundLabel(undergroundLabel);

    // Stage 1 controls rework (issue #18) — tool palette + hint strip + speed.
    this.renderToolPalette();
    this.renderHintStrip();
    this.renderSpeedWidget();

    // Ant-activity popup — live refresh when visible. Drawn before the
    // context menu so a visible chamber menu stays on top (the underground
    // right-click menu is transient and should never be occluded by a
    // non-essential overlay).
    if (antActivityPanelState.visible && colony) {
      const activity = computeAntActivity(world, colony);
      const body = formatAntActivityLines(activity).join('\n');
      this.antActivityText.setText(body);
      this.antActivityText.setVisible(true);

      this.gfx.fillStyle(
        ANT_ACTIVITY_PANEL_COLORS.background,
        ANT_ACTIVITY_PANEL_COLORS.backgroundAlpha,
      );
      this.gfx.fillRect(
        ANT_ACTIVITY_PANEL.x,
        ANT_ACTIVITY_PANEL.y,
        ANT_ACTIVITY_PANEL.w,
        ANT_ACTIVITY_PANEL.h,
      );
      this.gfx.lineStyle(1, ANT_ACTIVITY_PANEL_COLORS.border, 1);
      this.gfx.strokeRect(
        ANT_ACTIVITY_PANEL.x,
        ANT_ACTIVITY_PANEL.y,
        ANT_ACTIVITY_PANEL.w,
        ANT_ACTIVITY_PANEL.h,
      );
    } else {
      this.antActivityText.setVisible(false);
    }

    // Context menu (drawn last so it appears on top of other HUD elements).
    // Filter the choice list against colony state each frame so the player
    // never sees a disabled Queen option once the colony already owns or has
    // queued a Queen chamber.
    //
    // Stage 3a controls rework (issue #18, Codex R5-2): filter against the
    // PROJECTED world/colony (the queue folded through the sim handlers) rather
    // than the live one, so e.g. a queued Queen-cancel re-enables the Queen
    // option immediately while paused. getProjectedWorld() is non-undefined here
    // (the live `world` exists past the early return above; the projected world
    // aliases it when the queue is empty), so the projected colony lookup mirrors
    // the live `colonies[PLAYER_COLONY_ID]` shape and is guarded the same way.
    const projWorld = this.getProjectedWorld();
    const projColony = projWorld.colonies[PLAYER_COLONY_ID];
    if (contextMenuState.visible && projColony) {
      const items = visibleContextMenuItems(projColony, projWorld);
      this.contextMenuVisibleItems = items;
      drawContextMenuGeometry(
        this.gfx as unknown as import('./draw-surface.js').GfxLike,
        contextMenuState.screenX,
        contextMenuState.screenY,
        items,
      );
      // Show exactly one label per visible item, in order, reusing pooled
      // label texts by chamberType so the correct string lands at each row.
      const labelByType = new Map<number, Phaser.GameObjects.Text>();
      for (let i = 0; i < CONTEXT_MENU_ITEMS.length; i++) {
        labelByType.set(CONTEXT_MENU_ITEMS[i]!.chamberType, this.contextMenuLabels[i]!);
      }
      for (const label of this.contextMenuLabels) label.setVisible(false);
      for (let i = 0; i < items.length; i++) {
        const label = labelByType.get(items[i]!.chamberType);
        if (!label) continue;
        const pos = itemLabelPos(i, contextMenuState.screenX, contextMenuState.screenY);
        label.setPosition(pos.x, pos.y);
        label.setVisible(true);
      }
    } else {
      for (const label of this.contextMenuLabels) {
        label.setVisible(false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 9 Plan 06 — GameOver overlay
  // ---------------------------------------------------------------------------

  public showGameOverOverlay(
    outcome: GameOutcome,
    cause: QueenDeathCause,
    onRestart: () => void,
    narrativeSeed?: string | null,
  ): void {
    this.hideGameOverOverlay(); // clear any prior instance first

    const W = 800;
    const H = 592;

    // Semi-transparent background — input-blocking to absorb clicks behind overlay.
    const bg = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.6);
    bg.setInteractive();
    bg.setDepth(20);

    const { text: titleText, color: titleColor } = formatOutcomeTitle(outcome);
    const title = this.add.text(W / 2, H / 2 - 70, titleText, {
      fontSize: '40px',
      fontFamily: 'monospace',
      color: '#' + titleColor.toString(16).padStart(6, '0'),
    });
    title.setOrigin(0.5);
    title.setDepth(21);

    // S6: prefer narrativeSeed from summary-builder; fall back to formatCauseSubtitle
    // for pre-V22 saves or cases where buildPlaytraceSummary returns null.
    const causeText =
      narrativeSeed != null && narrativeSeed !== ''
        ? narrativeSeed
        : formatCauseSubtitle(outcome, cause);
    const causeLabel = this.add.text(W / 2, H / 2 - 25, causeText, {
      fontSize: '18px',
      fontFamily: 'monospace',
      color: '#ffffff',
      wordWrap: { width: 680 },
      align: 'center',
    });
    causeLabel.setOrigin(0.5);
    causeLabel.setDepth(21);

    // Kill stats subtitle — read via plain-object bracket access (ADR-0006).
    // GameScene only triggers this overlay after a tick produces an outcome,
    // so getWorld() must be defined; optional-chain the colony read regardless.
    const world = this.getWorld();
    const playerColony = world?.colonies[_PLAYER_COLONY_ID];
    const killCount = playerColony?.killCount ?? 0;
    const subtitle = this.add.text(W / 2, H / 2 + 20, formatKillStatsSubtitle(killCount), {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#cccccc',
    });
    subtitle.setOrigin(0.5);
    subtitle.setDepth(21);

    // Restart button
    const btnR = GAME_OVER_RESTART_RECT;
    const btnBg = this.add.rectangle(
      btnR.x + btnR.w / 2,
      btnR.y + btnR.h / 2,
      btnR.w,
      btnR.h,
      0x444444,
      1,
    );
    btnBg.setInteractive();
    btnBg.setDepth(21);
    btnBg.on('pointerdown', () => {
      onRestart();
    });

    const btnLabel = this.add.text(btnR.x + btnR.w / 2, btnR.y + btnR.h / 2, 'Restart', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    btnLabel.setOrigin(0.5);
    btnLabel.setDepth(22);

    this.gameOverGroup = [bg, title, causeLabel, subtitle, btnBg, btnLabel];
    this.recomputeActiveOverlay();
  }

  // S6 — first-occurrence caption overlay (light onboarding).
  public showCaption(text: string, screenX: number, screenY: number): void {
    // Stage 1 controls rework (issue #18, Codex R4-1): captions render centered
    // and can overlap the HUD.HINTS strip (e.g. the command captions at
    // y≈CANVAS_H-80). When the caption's vertical band overlaps the strip, yield
    // (hide) the strip for the caption's lifetime so the two don't collide.
    // Caption height is ~22px (14px font + padding); HINTS is y..y+h.
    const capTop = screenY - 14;
    const capBottom = screenY + 14;
    const stripTop = HUD.HINTS.y;
    const stripBottom = HUD.HINTS.y + HUD.HINTS.h;
    if (capTop < stripBottom && capBottom > stripTop) {
      this.hintYieldUntilMs = this.time.now + CAPTION_TOTAL_MS;
    }
    const captionText = this.add.text(screenX, screenY, text, {
      fontSize: '14px',
      fontFamily: 'monospace',
      color: '#ffffcc',
      backgroundColor: '#00000088',
      padding: { x: 8, y: 4 },
      align: 'center',
      wordWrap: { width: 500 },
    });
    captionText.setOrigin(0.5, 0.5);
    captionText.setDepth(30);
    captionText.setAlpha(0);

    // Fade in, hold, fade out over 1500ms total.
    this.tweens.add({
      targets: captionText,
      alpha: { from: 0, to: 1 },
      duration: 300,
      ease: 'Linear',
      onComplete: () => {
        this.tweens.add({
          targets: captionText,
          alpha: { from: 1, to: 0 },
          duration: 400,
          delay: 800,
          ease: 'Linear',
          onComplete: () => {
            captionText.destroy();
          },
        });
      },
    });
  }

  // Stage 2 controls rework (issue #18) — the invasion screen-edge flash MUST
  // render on UIScene, NOT GameScene. GameScene's main camera is zoom-driven
  // (CameraController.apply → setZoom + centerOn), and setScrollFactor(0)
  // cancels scroll but NOT zoom, so a flash drawn there is scaled/offset at any
  // zoom != 1 (see game-scene.ts Pitfall 1). UIScene's camera never zooms or
  // scrolls, so the fixed-canvas edge strips land correctly. Delegates the draw
  // to the pure screen-effects helper with `this` = UIScene.
  public triggerScreenEdgeFlash(direction: FlashDirection): void {
    drawScreenEdgeFlash(this, direction, CANVAS_W, CANVAS_H);
  }

  public hideGameOverOverlay(): void {
    for (const obj of this.gameOverGroup) obj.destroy();
    this.gameOverGroup = [];
    this.recomputeActiveOverlay();
  }

  // ---------------------------------------------------------------------------
  // Stage 1 controls rework (issue #18) — tool palette / hint strip / speed
  // ---------------------------------------------------------------------------

  /** The tool the cursor reflects (Chamber is greyed/inert on the surface). */
  private effectiveTool(): ToolId {
    const t = this.viewState.activeTool;
    if (t === 'chamber' && this.viewState.activeView !== 'underground') return 'command';
    return t;
  }

  /** Draw the 3-button tool palette with an active-tool highlight; Chamber is
   *  greyed on the surface (where it is inert). */
  private renderToolPalette(): void {
    const surface = this.viewState.activeView === 'surface';
    const active = this.viewState.activeTool;
    for (let i = 0; i < TOOL_ORDER.length; i++) {
      const tool = TOOL_ORDER[i]!;
      const r = toolButtonRect(i);
      const greyed = tool === 'chamber' && surface;
      const isActive = tool === active && !greyed;
      // Background: brighter when active, dim when greyed.
      this.gfx.fillStyle(isActive ? 0x2a6cc0 : greyed ? 0x222222 : 0x444444, 1);
      this.gfx.fillRect(r.x, r.y, r.w, r.h);
      if (isActive) {
        this.gfx.lineStyle(2, 0xffffff, 1);
        this.gfx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      }
      const t = this.toolButtonTexts[i];
      if (t) t.setAlpha(greyed ? 0.35 : 1);
    }
  }

  /** Draw the hint strip: the static per-tool/per-view legend, overridden by the
   *  transient "paused queue full" warning, and yielded while an overlapping
   *  caption is active. */
  private renderHintStrip(): void {
    const now = this.time.now;
    if (now < this.hintYieldUntilMs) {
      this.hintText.setVisible(false);
      return;
    }
    this.hintText.setVisible(true);
    if (now < this.pausedQueueFullUntilMs) {
      // Accurate message for the pause state captured at the drop (Fix 3): paused
      // → "resume to continue"; running → "try again" (transient burst). Reading
      // the live isPausedFn here instead would mis-message a drop whose state has
      // since flipped, so we use the recorded flag.
      this.hintText.setText(queueFullHint(this.pausedQueueFullWasPaused));
      this.hintText.setColor('#ffcc66');
      return;
    }
    this.hintText.setText(hintTextFor(this.effectiveTool(), this.viewState.activeView));
    this.hintText.setColor('#cfd8dc');
  }

  /** Draw the speed widget (⏸ / 1× / 2× / 4×): highlight the ⏸ button while
   *  paused, and the multiplier preset matching the live speed. */
  private renderSpeedWidget(): void {
    const paused = this.isPausedFn ? this.isPausedFn() : false;
    const speed = this.getSpeedMultiplierFn ? this.getSpeedMultiplierFn() : 1;
    for (let i = 0; i < SPEED_CONTROL_ORDER.length; i++) {
      const control = SPEED_CONTROL_ORDER[i]!;
      const r = speedControlRect(i);
      const isActive = control === 'pause' ? paused : control === speed;
      this.gfx.fillStyle(isActive ? 0x2a6cc0 : 0x444444, 1);
      this.gfx.fillRect(r.x, r.y, r.w, r.h);
      if (isActive) {
        this.gfx.lineStyle(2, 0xffffff, 1);
        this.gfx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      }
    }
  }

  /**
   * Surface the queue-full hint for a moment. `paused` selects the message
   * (paused → "resume to continue"; running → "try again") and is recorded so
   * renderHintStrip shows the right one for the whole flash window (Fix 3).
   */
  public flashPausedQueueFull(paused: boolean): void {
    this.pausedQueueFullUntilMs = this.time.now + PAUSED_QUEUE_FULL_HINT_MS;
    this.pausedQueueFullWasPaused = paused;
  }

  // ---------------------------------------------------------------------------
  // Phase 9 Plan 06 — SavePrompt overlay
  // ---------------------------------------------------------------------------

  public showSavePromptOverlay(callbacks: { onContinue: () => void; onNewGame: () => void }): void {
    this.hideSavePromptOverlay(); // clear any prior instance first

    const W = 800;
    const H = 592;

    // Semi-transparent background
    const bg = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.7);
    bg.setInteractive();
    bg.setDepth(20);

    const title = this.add.text(W / 2, H / 2 - 80, 'Resume saved game?', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    title.setOrigin(0.5);
    title.setDepth(21);

    const subtitle = this.add.text(
      W / 2,
      H / 2 - 40,
      'Found a previous session. Continue or start new?',
      {
        fontSize: '14px',
        fontFamily: 'monospace',
        color: '#aaaaaa',
      },
    );
    subtitle.setOrigin(0.5);
    subtitle.setDepth(21);

    // Continue button
    const contR = SAVE_PROMPT_CONTINUE_RECT;
    const contBg = this.add.rectangle(
      contR.x + contR.w / 2,
      contR.y + contR.h / 2,
      contR.w,
      contR.h,
      0x226622,
      1,
    );
    contBg.setInteractive();
    contBg.setDepth(21);
    contBg.on('pointerdown', () => {
      this.hideSavePromptOverlay();
      callbacks.onContinue();
    });

    const contLabel = this.add.text(contR.x + contR.w / 2, contR.y + contR.h / 2, 'Continue', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    contLabel.setOrigin(0.5);
    contLabel.setDepth(22);

    // New Game button
    const ngR = SAVE_PROMPT_NEW_GAME_RECT;
    const ngBg = this.add.rectangle(
      ngR.x + ngR.w / 2,
      ngR.y + ngR.h / 2,
      ngR.w,
      ngR.h,
      0x662222,
      1,
    );
    ngBg.setInteractive();
    ngBg.setDepth(21);
    ngBg.on('pointerdown', () => {
      this.hideSavePromptOverlay();
      callbacks.onNewGame();
    });

    const ngLabel = this.add.text(ngR.x + ngR.w / 2, ngR.y + ngR.h / 2, 'New Game', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    ngLabel.setOrigin(0.5);
    ngLabel.setDepth(22);

    this.savePromptGroup = [bg, title, subtitle, contBg, contLabel, ngBg, ngLabel];
    this.recomputeActiveOverlay();
  }

  public hideSavePromptOverlay(): void {
    for (const obj of this.savePromptGroup) obj.destroy();
    this.savePromptGroup = [];
    this.recomputeActiveOverlay();
  }

  // ---------------------------------------------------------------------------
  // S5 — Difficulty select overlay
  //
  // Shown before every new game. Player chooses Easy / Normal / Hard; the
  // choice is passed to createScenario via the onSelect callback. No cancel
  // button — the player must choose before the world is created.
  // ---------------------------------------------------------------------------

  public showDifficultySelectOverlay(callbacks: {
    onSelect: (d: 'Easy' | 'Normal' | 'Hard') => void;
  }): void {
    this.hideDifficultySelectOverlay();

    const W = 800;
    const H = 592;

    const bg = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.75);
    bg.setInteractive();
    bg.setDepth(20);

    const title = this.add.text(W / 2, H / 2 - 100, 'Choose Difficulty', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    title.setOrigin(0.5);
    title.setDepth(21);

    const subtitle = this.add.text(
      W / 2,
      H / 2 - 60,
      "Affects the enemy colony's aggression and reproduction rate.",
      {
        fontSize: '13px',
        fontFamily: 'monospace',
        color: '#aaaaaa',
      },
    );
    subtitle.setOrigin(0.5);
    subtitle.setDepth(21);

    const makeButton = (
      label: string,
      desc: string,
      rect: { x: number; y: number; w: number; h: number },
      color: number,
      difficulty: 'Easy' | 'Normal' | 'Hard',
    ): Phaser.GameObjects.GameObject[] => {
      const btnBg = this.add.rectangle(
        rect.x + rect.w / 2,
        rect.y + rect.h / 2,
        rect.w,
        rect.h,
        color,
        1,
      );
      btnBg.setInteractive();
      btnBg.setDepth(21);
      btnBg.on('pointerdown', () => {
        this.hideDifficultySelectOverlay();
        callbacks.onSelect(difficulty);
      });

      const btnLabel = this.add.text(rect.x + rect.w / 2, rect.y + 12, label, {
        fontSize: '15px',
        fontFamily: 'monospace',
        color: '#ffffff',
      });
      btnLabel.setOrigin(0.5, 0);
      btnLabel.setDepth(22);

      const btnDesc = this.add.text(rect.x + rect.w / 2, rect.y + 28, desc, {
        fontSize: '10px',
        fontFamily: 'monospace',
        color: '#cccccc',
        wordWrap: { width: rect.w - 8 },
      });
      btnDesc.setOrigin(0.5, 0);
      btnDesc.setDepth(22);

      return [btnBg, btnLabel, btnDesc];
    };

    const easyR = DIFFICULTY_EASY_RECT;
    const normR = DIFFICULTY_NORMAL_RECT;
    const hardR = DIFFICULTY_HARD_RECT;

    const easyObjs = makeButton('Easy', 'Slower AI', easyR, 0x226622, 'Easy');
    const normObjs = makeButton('Normal', 'Balanced', normR, 0x224466, 'Normal');
    const hardObjs = makeButton('Hard', 'Faster AI', hardR, 0x662222, 'Hard');

    this.difficultySelectGroup = [bg, title, subtitle, ...easyObjs, ...normObjs, ...hardObjs];
    this.recomputeActiveOverlay();
  }

  public hideDifficultySelectOverlay(): void {
    for (const obj of this.difficultySelectGroup) obj.destroy();
    this.difficultySelectGroup = [];
    this.recomputeActiveOverlay();
  }

  // ---------------------------------------------------------------------------
  // Issue #116 — Pause menu overlay
  //
  // Same Phaser-overlay-on-UIScene pattern as SavePrompt and GameOver: a
  // semi-transparent input-blocking background, a centered button stack drawn
  // from pause-menu-layout, click handlers via Phaser interactive objects, and
  // setActiveOverlay('pause-menu') for Playwright observability.
  //
  // Two pages:
  //   - main: Resume / Save+Load / Settings → / Download debug log
  //   - settings: pheromone-toggle (issue #114) / Back
  //
  // Page navigation goes through `renderPauseMenuPage` which destroys the
  // current group and rebuilds against the new page state. saveLoadEnabled
  // reflects whether issue #115's dialog is wired in; until then the row
  // renders disabled and is a no-op on click.
  // ---------------------------------------------------------------------------

  public showPauseMenuOverlay(callbacks: PauseMenuCallbacks): void {
    this.hidePauseMenuOverlay(); // idempotent — clear any prior instance first
    this.pauseMenuCallbacks = callbacks;
    this.pauseMenuSaveLoadEnabled = callbacks.onOpenSaveLoad !== undefined;
    this.pauseMenuPage = 'main';
    this.renderPauseMenuPage();
    this.recomputeActiveOverlay();
  }

  /**
   * Round-2 review (orphan-overlay): closing the pause menu while the
   * Save/Load dialog is on top would have left the dialog stranded — its
   * onBack callback would re-show a menu the caller just dismissed. Tear
   * down the dialog first so layered state stays coherent regardless of
   * which scene calls hidePauseMenuOverlay.
   */
  public hidePauseMenuOverlay(): void {
    if (this.saveLoadDialogGroup.length > 0) this.hideSaveLoadDialogOverlay();
    for (const obj of this.pauseMenuGroup) obj.destroy();
    this.pauseMenuGroup = [];
    this.pauseMenuVisibleItems = [];
    this.pauseMenuCallbacks = null;
    this.pauseMenuPage = 'main';
    this.recomputeActiveOverlay();
  }

  public isPauseMenuVisible(): boolean {
    return this.pauseMenuGroup.length > 0;
  }

  /** Render (or re-render) the current pause menu page in place. */
  private renderPauseMenuPage(): void {
    // Tear down any previously-drawn buttons/title before rebuilding so a
    // page navigation doesn't leave the prior page's text on top of the new one.
    for (const obj of this.pauseMenuGroup) obj.destroy();
    this.pauseMenuGroup = [];

    const page = this.pauseMenuPage;
    const ctx = {
      saveLoadEnabled: this.pauseMenuSaveLoadEnabled,
      // Round-6 P2 (Codex): the Settings page reads the pheromone overlay
      // state from in-memory ViewState (the authoritative source) rather
      // than from loadSettings(). In degraded-storage environments (private
      // mode, quota), saveSettings drops the write and loadSettings keeps
      // returning the default, which would freeze the label and make the
      // toggle look broken. ViewState always reflects the current value.
      currentPheromoneOverlay: this.viewState.showPheromoneOverlay,
      // Settings page's "Speed: N×" row reads this each render so it
      // reflects writes from EITHER the row click OR the live 1/2/4
      // keyboard shortcuts on GameScene.
      currentSpeedMultiplier: this.pauseMenuCallbacks?.getSpeedMultiplier?.() ?? 1,
      // Issue #122 — only show the Quit & feedback row when GameScene
      // supplied the callback. Empty VITE_PLAYTRACE_ENDPOINT → undefined
      // callback → row hidden.
      quitAndSurveyEnabled: this.pauseMenuCallbacks?.onQuitAndSurvey !== undefined,
    };
    const items = pauseMenuItems(page, ctx);
    this.pauseMenuVisibleItems = items;

    // Background scrim — input-blocking absorbs background clicks. Click-on-
    // background does NOT dismiss the menu (see pointerdown handler above);
    // dismissal is via Resume button or Esc key only.
    const bg = this.add.rectangle(
      PAUSE_MENU_CANVAS_W / 2,
      PAUSE_MENU_CANVAS_H / 2,
      PAUSE_MENU_CANVAS_W,
      PAUSE_MENU_CANVAS_H,
      0x000000,
      0.7,
    );
    bg.setInteractive();
    bg.setDepth(20);
    this.pauseMenuGroup.push(bg);

    // Title — "Paused" or "Settings" depending on page.
    const title = this.add.text(
      PAUSE_MENU_CANVAS_W / 2,
      pauseMenuTitleCenterY(items.length),
      pageTitle(page),
      { fontSize: '32px', fontFamily: 'monospace', color: '#ffffff' },
    );
    title.setOrigin(0.5);
    title.setDepth(21);
    this.pauseMenuGroup.push(title);

    // Buttons — one rectangle + one text per item. Disabled rows render
    // dimmer and skip dispatch (itemAt returns null for them).
    //
    // Dispatch flows ONLY through the scene-level pointerdown handler; we
    // intentionally do NOT bind per-button `pointerdown` callbacks. Phaser
    // fires object-level handlers BEFORE scene-level, so binding both
    // dispatched the same item twice on a single click — flipping the
    // pheromone toggle off-then-on (apparent no-op) and bypassing the
    // confirm gate on Save/Load destructive rows. setInteractive() stays
    // so the button rectangle absorbs the pointer hit and Phaser draws
    // the input cursor; the scene handler does the work.
    for (const item of items) {
      const r = item.rect;
      const fillColor = item.enabled ? 0x333333 : 0x202020;
      const labelColor = item.enabled ? '#ffffff' : '#777777';
      const btn = this.add.rectangle(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, fillColor, 1);
      btn.setInteractive();
      btn.setDepth(21);
      this.pauseMenuGroup.push(btn);

      const label = this.add.text(r.x + r.w / 2, r.y + r.h / 2, item.label, {
        fontSize: '16px',
        fontFamily: 'monospace',
        color: labelColor,
      });
      label.setOrigin(0.5);
      label.setDepth(22);
      this.pauseMenuGroup.push(label);
    }
  }

  /** Map menu item id to its action. Lives here (not in the layout module) so
   *  the layout stays Phaser-free — only UIScene knows about callbacks. */
  private dispatchPauseMenuItem(id: PauseMenuItemId): void {
    const cb = this.pauseMenuCallbacks;
    switch (id) {
      case 'resume':
        this.hidePauseMenuOverlay();
        cb?.onResume();
        return;
      case 'save-load':
        cb?.onOpenSaveLoad?.();
        return;
      case 'settings':
        this.pauseMenuPage = 'settings';
        this.renderPauseMenuPage();
        return;
      case 'back':
        this.pauseMenuPage = 'main';
        this.renderPauseMenuPage();
        return;
      case 'debug-snapshot':
        cb?.onDownloadDebug();
        return;
      case 'pheromone-toggle': {
        // Round-6 P2 (Codex): flip from in-memory state, NOT from
        // loadSettings(). In degraded-storage environments saveSettings
        // is a no-op; loadSettings then returns DEFAULT_SETTINGS on the
        // next press and we'd recompute `!true = false` every time —
        // the toggle gets stuck OFF. ViewState is the authoritative
        // in-mem source; persist is best-effort and survives reload
        // only when storage cooperates.
        const next = !this.viewState.showPheromoneOverlay;
        this.viewState.showPheromoneOverlay = next;
        const persisted = loadSettings();
        persisted.pheromoneOverlay = next;
        saveSettings(persisted);
        this.renderPauseMenuPage();
        return;
      }
      case 'speed-cycle': {
        // Cycle the live speedMultiplier 1→2→4→1 via GameScene's setter.
        // Session-only: speed is not persisted to settings (Phase 4 fresh-
        // boot contract resets to 1× on restart). The 1/2/4 keyboard
        // shortcuts on GameScene write to the same field, so both paths
        // converge on a single source of truth.
        const cur = cb?.getSpeedMultiplier?.() ?? 1;
        cb?.onCycleSpeed?.(nextSpeedMultiplier(cur));
        this.renderPauseMenuPage();
        return;
      }
      case 'quit-and-survey':
        // Issue #122 — close the menu and hand control to GameScene's
        // callback, which opens the survey overlay. The menu was already
        // gated on `onQuitAndSurvey !== undefined` to even render this
        // row, so the `?` here is defensive against state desync.
        this.hidePauseMenuOverlay();
        cb?.onQuitAndSurvey?.();
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #115 — Save/Load dialog overlay
  //
  // Reuses the Phaser-overlay pattern. Visually replaces the pause menu while
  // open (GameScene hides the menu before showing the dialog and restores it
  // on Back). The dialog reads save state via the save.ts API directly so
  // GameScene doesn't have to plumb every read through callbacks; the
  // callbacks only cover state changes that need scene-level coordination
  // (loading a save into the running scene, restarting).
  // ---------------------------------------------------------------------------

  public showSaveLoadDialogOverlay(callbacks: SaveLoadDialogCallbacks): void {
    this.hideSaveLoadDialogOverlay(); // idempotent — clear any prior instance
    this.saveLoadDialogCallbacks = callbacks;
    this.saveLoadDialogConfirming = { delete: false, newGame: false };
    this.renderSaveLoadDialog();
    this.recomputeActiveOverlay();
  }

  public hideSaveLoadDialogOverlay(): void {
    for (const obj of this.saveLoadDialogGroup) obj.destroy();
    this.saveLoadDialogGroup = [];
    this.saveLoadDialogVisibleItems = [];
    this.saveLoadDialogCallbacks = null;
    this.saveLoadDialogConfirming = { delete: false, newGame: false };
    // Cancel any in-flight Save Now flash timer so an old "Saved" message
    // can't fire renderSaveLoadDialog after the dialog is gone.
    if (this.saveLoadDialogFlashTimer !== null) {
      this.saveLoadDialogFlashTimer.remove();
      this.saveLoadDialogFlashTimer = null;
    }
    this.saveLoadDialogFlash = 'none';
    this.recomputeActiveOverlay();
  }

  public isSaveLoadDialogVisible(): boolean {
    return this.saveLoadDialogGroup.length > 0;
  }

  /** Render (or re-render) the dialog in place. Called on show, on confirm
   *  flag flip, and after every state-changing action (Save Now, Delete) so
   *  the info line and button enable states stay current. */
  private renderSaveLoadDialog(): void {
    for (const obj of this.saveLoadDialogGroup) obj.destroy();
    this.saveLoadDialogGroup = [];

    // Cache hasIncompatibleSave once per render — round-5 made it run a
    // full deserialize, so calling it twice for the ctx fields below
    // would deserialize the entire WorldState twice per frame.
    const incompatible = hasIncompatibleSave();
    const ctx = {
      // Round-3 (Codex P2): a future-sim save still passes parseSaveFile
      // (so hasSave returns true) but bootFromSave would reject it via
      // FutureSimVersionError. Treat the save as compatible only when
      // BOTH envelope is parseable AND deserialize succeeds. The
      // hasIncompatibleSave check covers parse-fails, future-sim, and
      // (round-4) any other shape error that would make Continue a
      // silent fall-through to bootFresh. See save.ts for the full
      // classification.
      //
      // Round-5 (cache): hasIncompatibleSave now performs a full
      // deserialize on the saved envelope. Local-cache the result so
      // a single renderSaveLoadDialog() doesn't pay the cost twice.
      hasCompatibleSave: hasSave() && !incompatible,
      hasIncompatibleSave: incompatible,
      confirming: { ...this.saveLoadDialogConfirming },
    };
    const items = saveLoadDialogItems(ctx);
    this.saveLoadDialogVisibleItems = items;
    const info = getSaveInfo();

    // Background scrim — slightly darker than the pause menu so the layered
    // overlay reads as "deeper than the menu underneath."
    const bg = this.add.rectangle(
      PAUSE_MENU_CANVAS_W / 2,
      PAUSE_MENU_CANVAS_H / 2,
      PAUSE_MENU_CANVAS_W,
      PAUSE_MENU_CANVAS_H,
      0x000000,
      0.85,
    );
    bg.setInteractive();
    bg.setDepth(30);
    this.saveLoadDialogGroup.push(bg);

    // Title
    const title = this.add.text(PAUSE_MENU_CANVAS_W / 2, DIALOG_TITLE_Y, saveLoadDialogTitle(), {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    title.setOrigin(0.5);
    title.setDepth(31);
    this.saveLoadDialogGroup.push(title);

    // Info line — live state of saved-game (or "no save" / "incompatible save").
    const infoLineColor = ctx.hasIncompatibleSave && info === null ? '#ffaa00' : '#aaaaaa';
    const infoLine = this.add.text(
      PAUSE_MENU_CANVAS_W / 2,
      DIALOG_INFO_Y,
      formatSaveInfoLine(info, ctx.hasIncompatibleSave),
      { fontSize: '13px', fontFamily: 'monospace', color: infoLineColor },
    );
    infoLine.setOrigin(0.5);
    infoLine.setDepth(31);
    this.saveLoadDialogGroup.push(infoLine);

    // Save Now flash — sits between info line and buttons. Empty when no
    // save was just attempted; replaced by "✓ Saved" or "✗ Save failed"
    // for SAVE_FLASH_MS after a manual save (cleared by a delayedCall).
    if (this.saveLoadDialogFlash !== 'none') {
      const flashColor = this.saveLoadDialogFlash === 'saved' ? '#88ee88' : '#ff7766';
      const flashText = this.saveLoadDialogFlash === 'saved' ? 'Saved' : 'Save failed';
      const flash = this.add.text(PAUSE_MENU_CANVAS_W / 2, DIALOG_INFO_Y + 18, flashText, {
        fontSize: '12px',
        fontFamily: 'monospace',
        color: flashColor,
      });
      flash.setOrigin(0.5);
      flash.setDepth(31);
      this.saveLoadDialogGroup.push(flash);
    }

    // Buttons. Confirming rows render in a warning color so the second-click
    // target is unambiguous.
    //
    // Same single-dispatcher rule as the pause menu: NO per-button pointerdown
    // handlers. Without that constraint Phaser fires both object-level and
    // scene-level pointerdown on a single click, and dispatchSaveLoadDialogItem
    // runs twice — turning the two-click Delete/New Game confirm into a
    // one-click destructive action. The scene-level pointerdown handler above
    // is the sole entry point.
    for (const item of items) {
      const r = item.rect;
      const fillColor = !item.enabled ? 0x202020 : item.confirming ? 0x884422 : 0x333333;
      const labelColor = !item.enabled ? '#777777' : item.confirming ? '#ffeecc' : '#ffffff';
      const btn = this.add.rectangle(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, fillColor, 1);
      btn.setInteractive();
      btn.setDepth(31);
      this.saveLoadDialogGroup.push(btn);

      const label = this.add.text(r.x + r.w / 2, r.y + r.h / 2, item.label, {
        fontSize: '14px',
        fontFamily: 'monospace',
        color: labelColor,
      });
      label.setOrigin(0.5);
      label.setDepth(32);
      this.saveLoadDialogGroup.push(label);
    }
  }

  /** Map dialog item id to its action. Destructive actions (delete, new-game
   *  with an existing save) require a second click on the same row to commit.
   *
   *  cb is captured at the top because Continue / New Game's success paths
   *  hide the dialog (which nulls saveLoadDialogCallbacks) BEFORE invoking
   *  the callback. Reading from `this.saveLoadDialogCallbacks` after the hide
   *  would silently land on null. The local `cb` keeps the original
   *  reference alive — the round-2 review flagged this as fragile if a
   *  future case is added without also capturing locally. */
  private dispatchSaveLoadDialogItem(id: SaveLoadDialogItemId): void {
    const cb = this.saveLoadDialogCallbacks;
    // Any non-confirm-target click clears the OTHER row's pending confirm so
    // the player can't end up with both armed simultaneously.
    if (id !== 'delete') this.saveLoadDialogConfirming.delete = false;
    if (id !== 'new-game') this.saveLoadDialogConfirming.newGame = false;

    switch (id) {
      case 'continue':
        // Continue path consumes both overlays — GameScene re-runs bootFromSave
        // and resumes the loop. Hide the dialog locally first so the scene
        // graph is clean before bootFromSave's resetSessionState fires.
        this.hideSaveLoadDialogOverlay();
        this.hidePauseMenuOverlay();
        cb?.onContinue();
        return;
      case 'save-now': {
        // GameScene owns (seed, inputLog, world) — the onSaveNow callback
        // closes over those references and calls manualSave. We surface the
        // boolean as a brief flash above the info line so the player gets
        // an explicit acknowledgement (issue #115 asked for a confirmation
        // toast — the flash plays the same role without a separate Phaser
        // tween / DOM-toast layer). Failure most often means quota /
        // private-mode; retry once or close other tabs.
        const ok = cb?.onSaveNow() ?? false;
        this.saveLoadDialogFlash = ok ? 'saved' : 'failed';
        // Cancel any in-flight prior flash timer so a second Save Now in
        // quick succession doesn't clear the new flash early.
        if (this.saveLoadDialogFlashTimer !== null) {
          this.saveLoadDialogFlashTimer.remove();
        }
        this.saveLoadDialogFlashTimer = this.time.delayedCall(SAVE_FLASH_MS, () => {
          this.saveLoadDialogFlashTimer = null;
          this.saveLoadDialogFlash = 'none';
          // Guard: dialog may have closed between Save Now and the timer
          // firing (e.g. player clicked Continue or Back). Re-render only
          // if the dialog is still on screen.
          if (this.isSaveLoadDialogVisible()) this.renderSaveLoadDialog();
        });
        this.renderSaveLoadDialog();
        return;
      }
      case 'delete': {
        if (!this.saveLoadDialogConfirming.delete) {
          this.saveLoadDialogConfirming.delete = true;
          this.renderSaveLoadDialog();
          return;
        }
        deleteSave();
        // Issue #196 — releasing the save means any autosave suspension that
        // was protecting a future-build save's bytes is no longer warranted
        // (the bytes are gone). Notify GameScene so the running fresh session
        // can save / autosave again instead of staying frozen until reload.
        cb?.onDelete();
        this.saveLoadDialogConfirming.delete = false;
        this.renderSaveLoadDialog();
        return;
      }
      case 'new-game': {
        // Confirm gate is only needed when a save exists — clicking New Game
        // with no save is just "restart the running scenario" and has no
        // hidden destructive consequence.
        if (hasSave() && !this.saveLoadDialogConfirming.newGame) {
          this.saveLoadDialogConfirming.newGame = true;
          this.renderSaveLoadDialog();
          return;
        }
        // Reset before commit (matches the delete case's pattern). The
        // hideSaveLoadDialogOverlay below also clears the flags, but doing
        // it explicitly here documents the intent and protects against a
        // future change that exits this branch without hiding.
        this.saveLoadDialogConfirming.newGame = false;
        this.hideSaveLoadDialogOverlay();
        this.hidePauseMenuOverlay();
        cb?.onNewGame();
        return;
      }
      case 'back':
        this.hideSaveLoadDialogOverlay();
        cb?.onBack();
        return;
    }
  }

  private isInsideRect(
    px: number,
    py: number,
    r: { x: number; y: number; w: number; h: number },
  ): boolean {
    return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  }

  /** Round-2 review: every `hide…Overlay()` previously called
   *  `setActiveOverlay('none')` unconditionally. With layered overlays (e.g.
   *  Save/Load dialog over pause menu, closed via Esc → re-shows menu) that
   *  briefly published `activeOverlay = 'none'` between the hide and the
   *  re-show — exactly the kind of observability lie round 1 was supposed
   *  to fix. This recompute reflects whatever overlay is still on screen. */
  private recomputeActiveOverlay(): void {
    // Survey takes precedence over the bare game-over overlay so the
    // end-of-game flow lands on the highest-value screen for diagnostics.
    if (this.surveyGroup.length > 0) setActiveOverlay('survey');
    else if (this.saveLoadDialogGroup.length > 0) setActiveOverlay('save-load');
    else if (this.pauseMenuGroup.length > 0) setActiveOverlay('pause-menu');
    else if (this.gameOverGroup.length > 0) setActiveOverlay('game-over');
    else if (this.savePromptGroup.length > 0) setActiveOverlay('save-prompt');
    else if (this.difficultySelectGroup.length > 0)
      setActiveOverlay('save-prompt'); // reuse 'save-prompt' HUD state
    else setActiveOverlay('none');

    // bootScreen discriminates the two overlays that share activeOverlay
    // 'save-prompt' (a real Continue/New Game SavePrompt vs the fresh-boot
    // Choose Difficulty overlay) so Playwright can verify the "no SavePrompt on
    // fresh boot" contract. 'none' once neither boot overlay is on screen.
    if (this.savePromptGroup.length > 0) setBootScreen('save-prompt');
    else if (this.difficultySelectGroup.length > 0) setBootScreen('difficulty-select');
    else setBootScreen('none');
  }

  // ---------------------------------------------------------------------------
  // Issue #122 / ADR 0013 — survey overlay
  //
  // End-of-game survey overlay with optional debug-snapshot upload. Same
  // Phaser-overlay-on-UIScene pattern as the other panels: a semi-transparent
  // input-blocking background, rating buttons, a DOM <textarea> overlaid at
  // SURVEY_FREE_TEXT_RECT for native text entry, two checkbox rows
  // ("Report as broken", "Upload diagnostic snapshot" + consent disclosure),
  // and Submit / Skip buttons.
  //
  // The DOM textarea is added because Phaser does not ship a text input
  // primitive; rolling one over the canvas via keyboard events would
  // require us to reimplement caret, selection, IME composition, paste, and
  // accessibility. Anchoring a real `<textarea>` over the canvas defers all
  // of that to the browser. The textarea is removed in hideSurveyOverlay
  // (cleanup is also wired into the scene shutdown handler).
  // ---------------------------------------------------------------------------

  private surveyGroup: Phaser.GameObjects.GameObject[] = [];
  private surveyCallbacks: SurveyOverlayCallbacks | null = null;
  private surveyState: {
    rating: 0 | 1 | 2 | 3 | 4 | 5;
    freeText: string;
    brokenFlag: boolean;
    includeSnapshot: boolean;
    quitFromPauseMenu: boolean;
    showConfirmation: boolean;
    confirmedSubmit: boolean;
    outcome: GameOutcome;
    cause: QueenDeathCause;
  } = {
    rating: 0,
    freeText: '',
    brokenFlag: false,
    includeSnapshot: false,
    quitFromPauseMenu: false,
    showConfirmation: false,
    confirmedSubmit: false,
    outcome: 0, // GameOutcome.None
    cause: null,
  };
  private surveyTextarea: HTMLTextAreaElement | null = null;
  /** Bound handler kept on the instance so addEventListener / removeEventListener
   *  observe the same function reference. Window resize while the survey is
   *  open repositions the DOM textarea over the canvas; without this the
   *  textarea drifts off-canvas after a layout change (sidebar collapse,
   *  devtools open, mobile orientation flip). */
  private surveyResizeHandler: (() => void) | null = null;

  public showSurveyOverlay(callbacks: SurveyOverlayCallbacks): void {
    this.hideSurveyOverlay(); // idempotent clear
    this.surveyCallbacks = callbacks;
    this.surveyState = {
      rating: 0,
      freeText: '',
      brokenFlag: false,
      includeSnapshot: false,
      quitFromPauseMenu: callbacks.quitFromPauseMenu,
      showConfirmation: false,
      confirmedSubmit: false,
      outcome: callbacks.outcome ?? 0,
      cause: callbacks.cause ?? null,
    };
    this.renderSurveyOverlay();
    this.recomputeActiveOverlay();
  }

  public hideSurveyOverlay(): void {
    for (const obj of this.surveyGroup) obj.destroy();
    this.surveyGroup = [];
    this.surveyCallbacks = null;
    if (this.surveyTextarea !== null) {
      this.surveyTextarea.remove();
      this.surveyTextarea = null;
    }
    if (this.surveyResizeHandler !== null && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.surveyResizeHandler);
      this.surveyResizeHandler = null;
    }
    this.recomputeActiveOverlay();
  }

  public isSurveyVisible(): boolean {
    return this.surveyGroup.length > 0;
  }

  /** Render (or re-render) the survey overlay in place. Called on show and
   *  after every state mutation (rating click, checkbox toggle) so the
   *  selected-state highlight reflects the latest input. When showConfirmation
   *  is true, renders the post-submit/skip confirmation screen instead. */
  private renderSurveyOverlay(): void {
    for (const obj of this.surveyGroup) obj.destroy();
    this.surveyGroup = [];

    if (this.surveyState.showConfirmation) {
      // Tear down the DOM textarea before the confirmation screen replaces the
      // form — it is not part of surveyGroup and must be removed explicitly.
      if (this.surveyTextarea !== null) {
        this.surveyTextarea.remove();
        this.surveyTextarea = null;
      }
      if (this.surveyResizeHandler !== null && typeof window !== 'undefined') {
        window.removeEventListener('resize', this.surveyResizeHandler);
        this.surveyResizeHandler = null;
      }
      this.renderSurveyConfirmation();
      return;
    }

    // Background scrim — opaque-ish so the game beneath reads as paused.
    const bg = this.add.rectangle(
      SURVEY_CANVAS_W / 2,
      SURVEY_CANVAS_H / 2,
      SURVEY_CANVAS_W,
      SURVEY_CANVAS_H,
      0x000000,
      0.85,
    );
    bg.setInteractive();
    bg.setDepth(40);
    this.surveyGroup.push(bg);

    // Title row: for natural game-over, show VICTORY/DEFEAT + cause.
    // For pause-menu-quit, show a generic "Quitting" heading.
    if (this.surveyState.quitFromPauseMenu) {
      const title = this.add.text(
        SURVEY_CANVAS_W / 2,
        SURVEY_TITLE_Y,
        'Quitting — tell us what you think',
        { fontSize: '22px', fontFamily: 'monospace', color: '#ffffff' },
      );
      title.setOrigin(0.5, 0);
      title.setDepth(41);
      this.surveyGroup.push(title);
    } else {
      const { text: outcomeText, color: outcomeColor } = formatOutcomeTitle(
        this.surveyState.outcome,
      );
      const outcomeLabel = this.add.text(SURVEY_CANVAS_W / 2, SURVEY_TITLE_Y - 5, outcomeText, {
        fontSize: '28px',
        fontFamily: 'monospace',
        color: '#' + outcomeColor.toString(16).padStart(6, '0'),
      });
      outcomeLabel.setOrigin(0.5, 0);
      outcomeLabel.setDepth(41);
      this.surveyGroup.push(outcomeLabel);

      const causeText = formatCauseSubtitle(this.surveyState.outcome, this.surveyState.cause);
      const secondLine = causeText !== '' ? causeText : 'Tell us what you think:';
      const causeLabel = this.add.text(SURVEY_CANVAS_W / 2, SURVEY_TITLE_Y + 33, secondLine, {
        fontSize: '16px',
        fontFamily: 'monospace',
        color: '#cccccc',
      });
      causeLabel.setOrigin(0.5, 0);
      causeLabel.setDepth(41);
      this.surveyGroup.push(causeLabel);
    }

    // Rating label — clarifies what 1–5 means.
    const ratingLabel = this.add.text(
      SURVEY_CANVAS_W / 2,
      SURVEY_RATING_ROW_Y - 26,
      'Rate your experience (1 = poor, 5 = great)',
      { fontSize: '13px', fontFamily: 'monospace', color: '#aaaaaa' },
    );
    ratingLabel.setOrigin(0.5, 0);
    ratingLabel.setDepth(41);
    this.surveyGroup.push(ratingLabel);

    // Rating row — five buttons. Selected button renders with a green
    // fill so the choice is visible at a glance.
    const ratings = surveyRatingButtons();
    for (const btn of ratings) {
      const selected = this.surveyState.rating === btn.rating;
      const fillColor = selected ? 0x22aa22 : 0x333333;
      const r = btn.rect;
      const rect = this.add.rectangle(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, fillColor, 1);
      rect.setInteractive();
      rect.setDepth(41);
      this.surveyGroup.push(rect);
      const label = this.add.text(r.x + r.w / 2, r.y + r.h / 2, String(btn.rating), {
        fontSize: '20px',
        fontFamily: 'monospace',
        color: '#ffffff',
      });
      label.setOrigin(0.5);
      label.setDepth(42);
      this.surveyGroup.push(label);
    }

    // Free-text rect background (the actual editable surface is a DOM
    // textarea positioned over the canvas below — see ensureSurveyTextarea).
    const ft = SURVEY_FREE_TEXT_RECT;
    const ftBg = this.add.rectangle(ft.x + ft.w / 2, ft.y + ft.h / 2, ft.w, ft.h, 0x222222, 1);
    ftBg.setDepth(41);
    this.surveyGroup.push(ftBg);
    this.ensureSurveyTextarea();

    // Checkbox rows. Each row is a small square + label; the row's full
    // horizontal span is treated as the click target via surveyHitTest.
    this.drawCheckboxRow(
      SURVEY_BROKEN_CHECKBOX_RECT,
      this.surveyState.brokenFlag,
      'Report this as a bug',
    );
    this.drawCheckboxRow(
      SURVEY_UPLOAD_CHECKBOX_RECT,
      this.surveyState.includeSnapshot,
      'Upload diagnostic snapshot to help us debug',
    );

    // Consent disclosure — only meaningful when the upload checkbox is
    // ticked, but always rendered so the player sees the privacy
    // implication BEFORE deciding to tick. ADR 0013 §"Privacy" requires
    // the overlay to disclose IP + UA leakage at the edge.
    const consent = this.add.text(
      SURVEY_BROKEN_CHECKBOX_RECT.x + SURVEY_BROKEN_CHECKBOX_RECT.w + SURVEY_CHECKBOX_LABEL_GAP,
      SURVEY_CONSENT_TEXT_Y,
      SURVEY_CONSENT_DISCLOSURE,
      {
        fontSize: '11px',
        fontFamily: 'monospace',
        color: '#aaaaaa',
        wordWrap: { width: SURVEY_CANVAS_W - 2 * SURVEY_BROKEN_CHECKBOX_RECT.x },
      },
    );
    consent.setDepth(42);
    this.surveyGroup.push(consent);

    // Submit + Skip buttons. Submit is disabled until a rating is picked
    // so the survey row always carries a 1-5 value; Skip is always live.
    const submitEnabled = this.surveyState.rating !== 0;
    this.drawSurveyButton(SURVEY_SUBMIT_BUTTON_RECT, 'Submit', submitEnabled);
    this.drawSurveyButton(SURVEY_SKIP_BUTTON_RECT, 'Skip', true);
  }

  /** Issue #131 — render the post-submit/skip confirmation screen. Shows a
   *  result message and two buttons: New Game (fresh seed) and Retry (same
   *  seed). The buttons reuse the Submit/Skip positions from the form phase. */
  private renderSurveyConfirmation(): void {
    const bg = this.add.rectangle(
      SURVEY_CANVAS_W / 2,
      SURVEY_CANVAS_H / 2,
      SURVEY_CANVAS_W,
      SURVEY_CANVAS_H,
      0x000000,
      0.85,
    );
    bg.setInteractive();
    bg.setDepth(40);
    this.surveyGroup.push(bg);

    const resultText = this.surveyState.confirmedSubmit
      ? 'Survey submitted — thanks for playing!'
      : 'Thanks for playing!';
    const title = this.add.text(SURVEY_CANVAS_W / 2, SURVEY_CANVAS_H / 2 - 40, resultText, {
      fontSize: '22px',
      fontFamily: 'monospace',
      color: '#ffffff',
    });
    title.setOrigin(0.5);
    title.setDepth(41);
    this.surveyGroup.push(title);

    this.drawSurveyButton(SURVEY_SUBMIT_BUTTON_RECT, 'New Game', true);
    this.drawSurveyButton(SURVEY_SKIP_BUTTON_RECT, 'Retry', true);
  }

  /** Helper — draw a checkbox square + label for the survey overlay. */
  private drawCheckboxRow(
    rect: { x: number; y: number; w: number; h: number },
    checked: boolean,
    label: string,
  ): void {
    const box = this.add.rectangle(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      rect.w,
      rect.h,
      checked ? 0x22aa22 : 0x333333,
      1,
    );
    box.setInteractive();
    box.setDepth(41);
    this.surveyGroup.push(box);
    if (checked) {
      // Simple check mark — a Phaser-Text "✓" reads more cleanly than
      // drawing line segments at this resolution.
      const tick = this.add.text(rect.x + rect.w / 2, rect.y + rect.h / 2, '✓', {
        fontSize: '16px',
        fontFamily: 'monospace',
        color: '#ffffff',
      });
      tick.setOrigin(0.5);
      tick.setDepth(42);
      this.surveyGroup.push(tick);
    }
    const text = this.add.text(
      rect.x + rect.w + SURVEY_CHECKBOX_LABEL_GAP,
      rect.y + rect.h / 2,
      label,
      { fontSize: '14px', fontFamily: 'monospace', color: '#ffffff' },
    );
    text.setOrigin(0, 0.5);
    text.setDepth(42);
    this.surveyGroup.push(text);
  }

  /** Helper — draw a Submit/Skip button. Disabled buttons render dimmer
   *  and do not register clicks (caller checks via surveyHitTest + state). */
  private drawSurveyButton(
    rect: { x: number; y: number; w: number; h: number },
    label: string,
    enabled: boolean,
  ): void {
    const fillColor = enabled ? 0x335577 : 0x202020;
    const labelColor = enabled ? '#ffffff' : '#777777';
    const btn = this.add.rectangle(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      rect.w,
      rect.h,
      fillColor,
      1,
    );
    btn.setInteractive();
    btn.setDepth(41);
    this.surveyGroup.push(btn);
    const text = this.add.text(rect.x + rect.w / 2, rect.y + rect.h / 2, label, {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: labelColor,
    });
    text.setOrigin(0.5);
    text.setDepth(42);
    this.surveyGroup.push(text);
  }

  /** Mount a <textarea> over the canvas at SURVEY_FREE_TEXT_RECT for free-
   *  text input. Created once per overlay open and torn down in
   *  hideSurveyOverlay. Position is recomputed each render so a canvas
   *  resize between renders is handled correctly. */
  private ensureSurveyTextarea(): void {
    if (typeof document === 'undefined') return; // headless Vitest path
    const canvas = this.game.canvas;
    if (canvas === null) return;
    if (this.surveyTextarea === null) {
      const ta = document.createElement('textarea');
      ta.placeholder = 'What stood out? (optional)';
      ta.maxLength = PLAYTRACE_FREE_TEXT_MAX;
      ta.style.position = 'absolute';
      ta.style.zIndex = '1000';
      ta.style.background = '#222222';
      ta.style.color = '#ffffff';
      ta.style.border = '1px solid #444444';
      ta.style.fontFamily = 'monospace';
      ta.style.fontSize = '13px';
      ta.style.padding = '6px';
      ta.style.resize = 'none';
      ta.addEventListener('input', () => {
        this.surveyState.freeText = truncateFreeText(ta.value);
      });
      // Phaser's KeyboardManager listens on window (bubble phase) and calls
      // preventDefault() for any key in its captures list — which includes
      // WASD and Space by default. stopPropagation prevents the keydown from
      // reaching Phaser so the textarea receives every character normally.
      ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      });
      // Append to the canvas's parent so embedded-in-shadow-DOM hosts
      // (the library-mode embed on the website may eventually mount
      // inside a custom element) keep the textarea inside the same
      // stacking context as the canvas. Fall back to document.body only
      // when the canvas has no parent yet (defensive — shouldn't happen
      // after Phaser's create()).
      const parent = canvas.parentElement ?? document.body;
      parent.appendChild(ta);
      this.surveyTextarea = ta;
    }
    // Bind the resize handler once per overlay open so a window-resize
    // mid-overlay (devtools open, sidebar toggle, mobile rotate) keeps the
    // textarea aligned with the canvas. Removed in hideSurveyOverlay.
    if (this.surveyResizeHandler === null && typeof window !== 'undefined') {
      this.surveyResizeHandler = () => this.positionSurveyTextarea();
      window.addEventListener('resize', this.surveyResizeHandler);
    }
    this.positionSurveyTextarea();
  }

  private positionSurveyTextarea(): void {
    if (this.surveyTextarea === null) return;
    const canvas = this.game.canvas;
    if (canvas === null) return;
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / SURVEY_CANVAS_W;
    const scaleY = canvasRect.height / SURVEY_CANVAS_H;
    const ta = this.surveyTextarea;
    // The textarea is absolutely-positioned and sits in `document.body` or
    // in `canvas.parentElement` (see ensureSurveyTextarea). For an
    // absolutely-positioned element, the `left`/`top` values are measured
    // against the nearest positioned ancestor (i.e. the same offsetParent
    // resolution the browser uses). We compute the canvas's position in
    // that same coordinate space by taking the bounding-rect delta against
    // the textarea's own offsetParent — which is guaranteed to be the
    // coordinate space `left`/`top` are interpreted in. This survives a
    // scrolled page, an embedder whose canvas-parent isn't positioned, and
    // shadow-DOM hosts. Codex P1 (round 3) — earlier `canvas.offsetLeft`
    // approach landed in the wrong coordinate space when canvas.parentElement
    // wasn't a positioned ancestor; the textarea drifted off-canvas.
    const offsetParent = ta.offsetParent as HTMLElement | null;
    let originX = 0;
    let originY = 0;
    if (offsetParent !== null) {
      const opRect = offsetParent.getBoundingClientRect();
      // Bounding-client-rect deltas use viewport coordinates; add the
      // offsetParent's scrollLeft/Top so a scrolled overflow container
      // (rare for the game canvas, but defensible) is handled too.
      //
      // Subtract clientLeft/Top — these equal the offsetParent's
      // left/top border width. getBoundingClientRect() returns the
      // border-box rect, but absolutely-positioned children's left/top
      // are measured from the parent's PADDING-box (i.e. inside the
      // border). Without this, an embedder whose canvas wrapper has a
      // non-zero CSS border would see the textarea shift by the border
      // width. (Codex round-3 review follow-up.)
      originX = canvasRect.left - opRect.left - offsetParent.clientLeft + offsetParent.scrollLeft;
      originY = canvasRect.top - opRect.top - offsetParent.clientTop + offsetParent.scrollTop;
    } else {
      // Textarea is positioned relative to the viewport (e.g. when its
      // offsetParent is the initial containing block / document.body
      // with no positioned ancestor in between). Fall back to viewport
      // coordinates from canvasRect directly.
      originX = canvasRect.left;
      originY = canvasRect.top;
    }
    ta.style.left = `${originX + SURVEY_FREE_TEXT_RECT.x * scaleX}px`;
    ta.style.top = `${originY + SURVEY_FREE_TEXT_RECT.y * scaleY}px`;
    ta.style.width = `${SURVEY_FREE_TEXT_RECT.w * scaleX}px`;
    ta.style.height = `${SURVEY_FREE_TEXT_RECT.h * scaleY}px`;
  }

  /** Dispatch a click on the survey overlay. Called from the pointerdown
   *  handler in create() when the overlay is visible. Routes to the
   *  confirmation hit-test when showConfirmation is true. */
  private dispatchSurveyClick(px: number, py: number): void {
    // Issue #131 — when the confirmation screen is showing, use the
    // confirmation hit-test (New Game / Retry) instead of the form hit-test.
    if (this.surveyState.showConfirmation) {
      const hit = surveyConfirmationHitTest(px, py);
      if (hit === null) return;
      const cb = this.surveyCallbacks;
      this.hideSurveyOverlay();
      if (hit.kind === 'new-game') cb?.onNewGame();
      else cb?.onRetry();
      return;
    }

    const hit = surveyHitTest(px, py);
    if (hit === null) return;
    switch (hit.kind) {
      case 'rating':
        this.surveyState.rating = hit.rating;
        this.renderSurveyOverlay();
        return;
      case 'broken-checkbox':
        this.surveyState.brokenFlag = !this.surveyState.brokenFlag;
        this.renderSurveyOverlay();
        return;
      case 'upload-checkbox':
        this.surveyState.includeSnapshot = !this.surveyState.includeSnapshot;
        this.renderSurveyOverlay();
        return;
      case 'free-text':
        // Focus the underlying DOM textarea so the player can start typing
        // immediately without a second click.
        this.surveyTextarea?.focus();
        return;
      case 'submit': {
        if (this.surveyState.rating === 0) return; // disabled — defensive
        const cb = this.surveyCallbacks;
        const result: PlaytraceSurvey & { includeSnapshot: boolean } = {
          rating: this.surveyState.rating,
          freeText: this.surveyState.freeText,
          brokenFlag: this.surveyState.brokenFlag,
          includeSnapshot: this.surveyState.includeSnapshot,
        };
        // Issue #131 — fire the upload callback immediately, then transition
        // to the confirmation screen instead of closing the overlay. The
        // player chooses New Game or Retry from the confirmation screen.
        cb?.onSubmit(result);
        this.surveyState.showConfirmation = true;
        this.surveyState.confirmedSubmit = true;
        this.renderSurveyOverlay();
        return;
      }
      case 'skip': {
        // Issue #131 — skip transitions to the New Game/Retry choice without
        // a submission confirmation message.
        this.surveyState.showConfirmation = true;
        this.surveyState.confirmedSubmit = false;
        this.renderSurveyOverlay();
        return;
      }
    }
  }
}

/** Issue #131 — callbacks the survey overlay invokes. After submit or skip,
 *  the overlay shows a confirmation screen with New Game / Retry buttons;
 *  onNewGame and onRetry fire when the player makes that choice. */
export interface SurveyOverlayCallbacks {
  /** True when this overlay was opened from the pause menu's "Quit &
   *  feedback" action rather than after a natural game-over. The overlay
   *  uses it to pick a slightly different title; the game-scene passes it
   *  through to the upload as the wire envelope's quitFromPauseMenu flag. */
  quitFromPauseMenu: boolean;
  /** Terminal outcome to display at the top of the survey (Victory/Defeat/etc).
   *  Omitted on pause-menu-quit path (no queen died). */
  outcome?: GameOutcome;
  /** Why the relevant queen died — passed to formatCauseSubtitle. Omitted on
   *  pause-menu-quit or when cause is unknown (pre-V16 saves). */
  cause?: QueenDeathCause;
  /** Player submitted. The callback fires the upload (fire-and-forget) then
   *  the overlay transitions to the confirmation screen — do NOT call
   *  restartGame here; wait for onNewGame / onRetry. */
  onSubmit(survey: PlaytraceSurvey & { includeSnapshot: boolean }): void;
  /** Player chose New Game from the confirmation screen (fresh seed). The
   *  overlay is already closed by the time this fires. */
  onNewGame(): void;
  /** Player chose Retry from the confirmation screen (same seed). The
   *  overlay is already closed by the time this fires. */
  onRetry(): void;
}
