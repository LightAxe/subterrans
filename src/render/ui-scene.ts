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
import type { ViewState } from './camera.js';
import { toggleView, toggleUndergroundColony } from './camera.js';
import type { WorldState } from '../sim/types.js';
import { HUD } from './sprites.js';
import { GameOutcome } from '../sim/game-over.js';
import { formatOutcomeTitle, formatKillStatsSubtitle } from './ui-scene-logic.js';
import { PLAYER_COLONY_ID as _PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';

// Re-export pure helpers for Plan 07 and external consumers
export { formatOutcomeTitle, formatKillStatsSubtitle };

// ---------------------------------------------------------------------------
// Plan 07 Playwright observability contract
// ---------------------------------------------------------------------------

export type ActiveOverlay = 'none' | 'save-prompt' | 'game-over';

// Phase 09.1 Chunk 2 — enemy underground observability. Exposed via the same
// __phase9_ui global so Playwright can read which colony the underground view
// is currently scoped to without OCR against the canvas-drawn HUD.
export type ActiveUndergroundLabel = 'Your Colony' | 'Enemy Colony';

declare global {
  interface Window {
    __phase9_ui?: {
      activeOverlay: ActiveOverlay;
      activeUndergroundLabel?: ActiveUndergroundLabel;
    };
  }
}

/** Publishes current overlay state to window.__phase9_ui for Playwright observability.
 *  Guarded by typeof window check so Vitest (Node) contexts don't crash.
 *  Preserves activeUndergroundLabel if already set by setActiveUndergroundLabel. */
function setActiveOverlay(next: ActiveOverlay): void {
  if (typeof window !== 'undefined') {
    const prev = window.__phase9_ui;
    window.__phase9_ui = {
      activeOverlay: next,
      ...(prev?.activeUndergroundLabel !== undefined
        ? { activeUndergroundLabel: prev.activeUndergroundLabel }
        : {}),
    };
  }
}

/** Publishes the current underground colony label for Playwright observability.
 *  Preserves activeOverlay if already set. Called every UIScene.update() frame. */
function setActiveUndergroundLabel(next: ActiveUndergroundLabel): void {
  if (typeof window !== 'undefined') {
    const prev = window.__phase9_ui;
    window.__phase9_ui = {
      activeOverlay: prev?.activeOverlay ?? 'none',
      activeUndergroundLabel: next,
    };
  }
}

// ---------------------------------------------------------------------------
// Overlay button rects — exported for Plan 07 Playwright coordinate-based clicks
// ---------------------------------------------------------------------------

/** Canvas-local rect for the SavePrompt "Continue" button. */
export const SAVE_PROMPT_CONTINUE_RECT = { x: 300, y: 280, w: 120, h: 32 } as const;
/** Canvas-local rect for the SavePrompt "New Game" button. */
export const SAVE_PROMPT_NEW_GAME_RECT = { x: 300, y: 320, w: 120, h: 32 } as const;
/** Canvas-local rect for the GameOver "Restart" button. */
export const GAME_OVER_RESTART_RECT    = { x: 300, y: 320, w: 120, h: 32 } as const;
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
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { SetBehaviorRatioCommand, PlaceChamberCommand } from '../sim/commands.js';

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

  constructor() { super({ key: 'UIScene' }); }

  init(data: { viewState: ViewState; getWorld: () => WorldState | undefined }) {
    this.viewState = data.viewState;
    this.getWorld = data.getWorld;
  }

  create() {
    this.gfx = this.add.graphics();
    this.dragState = createSliderDragState();

    // HUD-02 stats row — three Texts confined to the 200x24 HUD.STATS rect,
    // two-row layout. Row 1: antsText (white, left) + foodText (green, right-
    // anchored). Row 2: queenLabelText (white, left) + queen health bar
    // (drawn in update() via gfx so its color can change per frame without
    // Text churn).
    this.antsText = this.add.text(
      STATS_TEXT_X,
      STATS_ROW1_Y,
      'Ants: 0',
      { color: HUD_STATS_COLORS.antsTextCss, fontSize: '10px', fontFamily: 'monospace' },
    );
    this.antsText.setScrollFactor(0);

    this.foodText = this.add.text(
      STATS_TEXT_X,
      STATS_ROW1_Y,
      'Food: 0/0',
      { color: HUD_STATS_COLORS.foodTextCss, fontSize: '10px', fontFamily: 'monospace' },
    );
    this.foodText.setScrollFactor(0);

    // Queen label — "Queen" text sits on row 2 (09 HUD clarity pass).
    // Position is set in update() from queenLabelRect so layout constants
    // remain single-sourced in hud-stats.ts.
    this.queenLabelText = this.add.text(
      STATS_TEXT_X,
      STATS_ROW2_Y,
      formatQueenLabel(),
      { color: HUD_STATS_COLORS.queenLabelCss, fontSize: '10px', fontFamily: 'monospace' },
    );
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
      this.add.text(
        HUD.TRIANGLE.x + 4,
        SLIDER_GEOMETRY.trackY - 22,
        'Forage',
        { color: '#ffffff', fontSize: '10px' },
      ),
      this.add.text(
        HUD.TRIANGLE.x + HUD.TRIANGLE.w - 28,
        SLIDER_GEOMETRY.trackY - 22,
        'Fight',
        { color: '#ffffff', fontSize: '10px' },
      ),
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

    // Context menu item labels — created once, positioned/shown per frame.
    // One Phaser.Text per ChamberType (Queen / Nursery / Food Storage) so the
    // player can actually read the choices instead of seeing unlabeled stripes.
    this.contextMenuLabels = CONTEXT_MENU_ITEMS.map(item => {
      const t = this.add.text(
        0,
        0,
        item.label,
        { color: '#ffffff', fontSize: '13px', fontFamily: 'monospace' },
      );
      t.setScrollFactor(0);
      t.setVisible(false);
      t.setDepth(10); // draw above the gfx stripes
      return t;
    });

    // Ant-activity popup body — single multi-line Text widget anchored to the
    // top-left of ANT_ACTIVITY_PANEL. Created once, shown/hidden and retargeted
    // per frame in update() based on antActivityPanelState.visible.
    this.antActivityText = this.add.text(
      ANT_ACTIVITY_PANEL.x + 8,
      ANT_ACTIVITY_PANEL.y + 8,
      '',
      {
        color: ANT_ACTIVITY_PANEL_COLORS.textCss,
        fontSize: '11px',
        fontFamily: 'monospace',
      },
    );
    this.antActivityText.setScrollFactor(0);
    this.antActivityText.setVisible(false);
    this.antActivityText.setDepth(11);

    // Esc hides the panel. UIScene owns this key so GameScene's world
    // keyboard handlers aren't forced to know about UI state.
    const escKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    if (escKey) {
      escKey.on('down', () => {
        hideAntActivityPanel();
      });
    }

    // Pointer events for HUD interactions.
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      // Context menu takes precedence when visible. A click inside selects an
      // item; a click anywhere else dismisses the menu AND falls through so
      // the underlying HUD control still receives the click — prevents the
      // menu from lingering after unrelated HUD interactions.
      if (contextMenuState.visible) {
        const items = this.contextMenuVisibleItems;
        if (isInsideContextMenu(
          pointer.x, pointer.y,
          contextMenuState.screenX, contextMenuState.screenY,
          items,
        )) {
          const choice = contextMenuItemAt(
            pointer.x, pointer.y,
            contextMenuState.screenX, contextMenuState.screenY,
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
            world.commandQueue.push(cmd);
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
             this.isInsideRect(pointer.x, pointer.y, HUD.TRIANGLE)
          || this.isInsideRect(pointer.x, pointer.y, HUD.MINIMAP)
          || this.isInsideRect(pointer.x, pointer.y, HUD.VIEW_TOGGLE)
          // Issue #14 — colony-toggle button. Without this entry, a click
          // on the new toggle while the ant-activity panel is up would
          // be classified as "world click", dismissing the panel and
          // dropping the toggle dispatch.
          || this.isInsideRect(pointer.x, pointer.y, HUD.UNDERGROUND_COLONY_TOGGLE);
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
      // Minimap click
      if (applyMinimapClick(this.viewState, pointer.x, pointer.y)) return;
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
    this.events.on('shutdown', () => {
      this.hideGameOverOverlay();
      this.hideSavePromptOverlay();
      hideAntActivityPanel();
      setActiveOverlay('none');
    });

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
          world.commandQueue.push(cmd);
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
      const bar   = queenBarRect(HUD.STATS);
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
      const currentRatio = ff > 0
        ? {
            forage: Math.round(colony.taskCensus.forage * 100 / ff),
            fight:  Math.round(colony.taskCensus.fight  * 100 / ff),
          }
        : { forage: colony.targetRatio.forage, fight: colony.targetRatio.fight };
      const targetRatio = this.dragState.isDragging
        ? this.dragState.targetRatio
        : colony.targetRatio;
      drawSlider(this.gfx as unknown as import('./draw-surface.js').GfxLike, currentRatio, targetRatio);
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
      this.viewState.activeUndergroundColonyId === ENEMY_COLONY_ID
        ? 'Enemy Colony'
        : 'Your Colony';
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
    if (contextMenuState.visible && colony) {
      const items = visibleContextMenuItems(colony, world);
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

  public showGameOverOverlay(outcome: GameOutcome, onRestart: () => void): void {
    this.hideGameOverOverlay(); // clear any prior instance first

    const W = 800;
    const H = 592;

    // Semi-transparent background — input-blocking to absorb clicks behind overlay.
    const bg = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.6);
    bg.setInteractive();
    bg.setDepth(20);

    const { text: titleText, color: titleColor } = formatOutcomeTitle(outcome);
    const title = this.add.text(W / 2, H / 2 - 60, titleText, {
      fontSize: '40px',
      fontFamily: 'monospace',
      color: '#' + titleColor.toString(16).padStart(6, '0'),
    });
    title.setOrigin(0.5);
    title.setDepth(21);

    // Kill stats subtitle — read via plain-object bracket access (ADR-0006).
    // GameScene only triggers this overlay after a tick produces an outcome,
    // so getWorld() must be defined; optional-chain the colony read regardless.
    const world = this.getWorld();
    const playerColony = world?.colonies[_PLAYER_COLONY_ID];
    const killCount = playerColony?.killCount ?? 0;
    const subtitle = this.add.text(W / 2, H / 2 - 10, formatKillStatsSubtitle(killCount), {
      fontSize: '18px',
      fontFamily: 'monospace',
      color: '#cccccc',
    });
    subtitle.setOrigin(0.5);
    subtitle.setDepth(21);

    // Restart button
    const btnR = GAME_OVER_RESTART_RECT;
    const btnBg = this.add.rectangle(
      btnR.x + btnR.w / 2, btnR.y + btnR.h / 2,
      btnR.w, btnR.h,
      0x444444, 1,
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

    this.gameOverGroup = [bg, title, subtitle, btnBg, btnLabel];
    setActiveOverlay('game-over');
  }

  public hideGameOverOverlay(): void {
    for (const obj of this.gameOverGroup) obj.destroy();
    this.gameOverGroup = [];
    setActiveOverlay('none');
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

    const subtitle = this.add.text(W / 2, H / 2 - 40, 'Found a previous session. Continue or start new?', {
      fontSize: '14px',
      fontFamily: 'monospace',
      color: '#aaaaaa',
    });
    subtitle.setOrigin(0.5);
    subtitle.setDepth(21);

    // Continue button
    const contR = SAVE_PROMPT_CONTINUE_RECT;
    const contBg = this.add.rectangle(
      contR.x + contR.w / 2, contR.y + contR.h / 2,
      contR.w, contR.h,
      0x226622, 1,
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
      ngR.x + ngR.w / 2, ngR.y + ngR.h / 2,
      ngR.w, ngR.h,
      0x662222, 1,
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
    setActiveOverlay('save-prompt');
  }

  public hideSavePromptOverlay(): void {
    for (const obj of this.savePromptGroup) obj.destroy();
    this.savePromptGroup = [];
    setActiveOverlay('none');
  }

  private isInsideRect(
    px: number,
    py: number,
    r: { x: number; y: number; w: number; h: number },
  ): boolean {
    return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
  }
}
