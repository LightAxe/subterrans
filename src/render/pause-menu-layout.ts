// pause-menu-layout.ts — issue #116 pause menu layout + hit-testing.
//
// Pure-TypeScript module: no Phaser, no DOM. UIScene consumes the menu items
// to lay out Game Objects, and reuses the hit-test for pointerdown dispatch.
// Pure-data shape mirrors context-menu-layout.ts so the menu is testable in
// Vitest without spinning up a Phaser scene.
//
// Layout: vertical stack of fixed-size buttons, centered horizontally on the
// canvas (a LayoutContext). Vertical anchor is the canvas centerline minus half
// the stack height, so the stack stays visually centered as page contents change.
//
// State machine (consumer drives, this module renders):
//   main     → Resume / Save+Load / Settings → / Download debug log
//   settings → (page entries, populated by callers — issue #114 adds pheromone
//              toggle) / ← Back
//
// The `Save/Load` row carries an `enabled` flag so it can render disabled
// while issue #115's dialog isn't yet wired in.

// (Settings type was imported here pre-round-6; removed when the
// pheromone-toggle label moved to an in-memory ctx field per Codex P2.)

import type { LayoutContext } from './layout.js';

// ---------------------------------------------------------------------------
// Geometry constants (canvas-local pixels)
//
// Button sizes/gaps/title-height are canvas-INDEPENDENT and stay constants; the
// canvas-relative centering (stackRects) derives from the LayoutContext passed
// in (issue #213). No local CANVAS_W/CANVAS_H — that was the layout debt.
// ---------------------------------------------------------------------------

export const PAUSE_MENU_BUTTON_W = 320;
export const PAUSE_MENU_BUTTON_H = 40;
export const PAUSE_MENU_BUTTON_GAP = 10;

/** Pixels of vertical padding above/below the stack inside the modal panel. */
export const PAUSE_MENU_STACK_VPAD = 32;
/** Pixels of vertical space reserved at the top of the stack for the title. */
export const PAUSE_MENU_TITLE_HEIGHT = 56;

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

export type PauseMenuPage = 'main' | 'settings';

export type PauseMenuItemId =
  | 'resume'
  | 'save-load'
  | 'settings'
  | 'debug-snapshot'
  | 'back'
  | 'pheromone-toggle'
  // Stage 3b (issue #18) — Settings-page rows: toggle the static hint-strip
  // legend, and reset the one-time first-use navigation hints.
  | 'control-hints-toggle'
  | 'reset-first-use-hints'
  | 'speed-cycle'
  // Issue #122 / ADR 0013 — "Quit & feedback" entry. Only emitted when the
  // playtrace feature is enabled (caller passes ctx.quitAndSurveyEnabled);
  // hidden otherwise so the open-source build's pause menu is unchanged.
  | 'quit-and-survey';

/** Allowed speedMultiplier values. Cycled by the Settings sub-screen
 *  speed-cycle row in the order 1 → 2 → 4 → 1. */
export type SpeedMultiplier = 1 | 2 | 4;

export interface MenuItemRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PauseMenuItem {
  id: PauseMenuItemId;
  label: string;
  /** False renders the row dimmer and `itemAt` returns null on hit so the
   *  callback is never fired. Used by Save/Load until issue #115 lands. */
  enabled: boolean;
  rect: MenuItemRect;
}

export interface PauseMenuRenderContext {
  /** True once issue #115's Save/Load dialog is wired in; until then the row
   *  renders disabled to signal "coming soon" without removing the affordance. */
  saveLoadEnabled: boolean;
  /** Current pheromone overlay state. Sourced from ViewState (in-memory) by
   *  the caller, NOT from `loadSettings()` — round-6 P2 (Codex): in degraded-
   *  storage environments saveSettings is a no-op and loadSettings keeps
   *  returning the default, so reading the label from persisted state makes
   *  the toggle look broken. The in-mem flag is the authoritative truth. */
  currentPheromoneOverlay: boolean;
  /** Stage 3b (issue #18) — current hint-strip legend visibility, for the
   *  "Control hints: ON/OFF" row label. Sourced from the in-memory hintStripState
   *  singleton by the caller (same authoritative-in-mem rationale as the
   *  pheromone toggle), NOT from loadSettings(). */
  currentHintStripVisible: boolean;
  /** Current speedMultiplier (1 | 2 | 4). The Settings page renders this in
   *  the "Speed: N×" cycle row. Source of truth is GameScene's live field —
   *  the menu reads via the onSpeedMultiplier callback at render time and
   *  writes via onCycleSpeed when the row is clicked. Session-only (no
   *  settings persistence — matches the Phase 4 fresh-boot contract that
   *  speed resets to 1× on restart). */
  currentSpeedMultiplier: SpeedMultiplier;
  /** Issue #122 / ADR 0013 — true when the playtrace upload feature is
   *  active (VITE_PLAYTRACE_ENDPOINT non-empty). Adds a "Quit & feedback"
   *  row to the main menu; hidden when the feature is off so the open-
   *  source build's menu stays identical to pre-#122. */
  quitAndSurveyEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Compute the vertical center anchor for a stack of n buttons (with the title
 * gap), then derive each button's rect. Returns rects in render order top→bottom.
 */
function stackRects(n: number, layout: LayoutContext): MenuItemRect[] {
  const stackHeight =
    PAUSE_MENU_TITLE_HEIGHT + n * PAUSE_MENU_BUTTON_H + (n - 1) * PAUSE_MENU_BUTTON_GAP;
  const top = (layout.h - stackHeight) / 2 + PAUSE_MENU_TITLE_HEIGHT;
  const x = (layout.w - PAUSE_MENU_BUTTON_W) / 2;
  const rects: MenuItemRect[] = [];
  for (let i = 0; i < n; i++) {
    rects.push({
      x,
      y: top + i * (PAUSE_MENU_BUTTON_H + PAUSE_MENU_BUTTON_GAP),
      w: PAUSE_MENU_BUTTON_W,
      h: PAUSE_MENU_BUTTON_H,
    });
  }
  return rects;
}

/** Y-coordinate of the page title baseline (above the first button rect). */
export function titleCenterY(itemCount: number, layout: LayoutContext): number {
  const rects = stackRects(itemCount, layout);
  return rects[0]!.y - PAUSE_MENU_TITLE_HEIGHT / 2;
}

/** Compose the menu items for the current page. */
export function pauseMenuItems(
  page: PauseMenuPage,
  ctx: PauseMenuRenderContext,
  layout: LayoutContext,
): PauseMenuItem[] {
  if (page === 'main') {
    const labels: Array<{ id: PauseMenuItemId; label: string; enabled: boolean }> = [
      { id: 'resume', label: 'Resume', enabled: true },
      { id: 'save-load', label: 'Save / Load', enabled: ctx.saveLoadEnabled },
      { id: 'settings', label: 'Settings  >', enabled: true },
      { id: 'debug-snapshot', label: 'Download debug log', enabled: true },
    ];
    if (ctx.quitAndSurveyEnabled) {
      labels.push({ id: 'quit-and-survey', label: 'Quit & feedback', enabled: true });
    }
    const rects = stackRects(labels.length, layout);
    return labels.map((l, i) => ({
      id: l.id,
      label: l.label,
      enabled: l.enabled,
      rect: rects[i]!,
    }));
  }
  // settings page
  const labels: Array<{ id: PauseMenuItemId; label: string; enabled: boolean }> = [
    {
      id: 'pheromone-toggle',
      label: `Pheromone trails: ${ctx.currentPheromoneOverlay ? 'ON' : 'OFF'}`,
      enabled: true,
    },
    {
      id: 'control-hints-toggle',
      label: `Control hints: ${ctx.currentHintStripVisible ? 'ON' : 'OFF'}`,
      enabled: true,
    },
    {
      id: 'reset-first-use-hints',
      label: 'Reset first-use hints',
      enabled: true,
    },
    {
      id: 'speed-cycle',
      // Cycles 1→2→4→1 on click. Mirrors the 1/2/4 keyboard shortcuts that
      // are Playing-only-gated; the menu surface gives a discoverable home
      // for the same control while paused.
      label: `Speed: ${ctx.currentSpeedMultiplier}×`,
      enabled: true,
    },
    { id: 'back', label: '<  Back', enabled: true },
  ];
  const rects = stackRects(labels.length, layout);
  return labels.map((l, i) => ({
    id: l.id,
    label: l.label,
    enabled: l.enabled,
    rect: rects[i]!,
  }));
}

/** Page title text. Centralized so the title and items share a single source. */
export function pageTitle(page: PauseMenuPage): string {
  return page === 'main' ? 'Paused' : 'Settings';
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

function pointInRect(px: number, py: number, r: MenuItemRect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/** Returns the topmost ENABLED item under the pointer, or null. Disabled items
 *  swallow no hit so callers can layer additional behavior beneath them later. */
export function itemAt(
  items: readonly PauseMenuItem[],
  px: number,
  py: number,
): PauseMenuItem | null {
  for (const it of items) {
    if (!it.enabled) continue;
    if (pointInRect(px, py, it.rect)) return it;
  }
  return null;
}

/** Next speed in the 1→2→4→1 cycle. Pure function so the menu dispatch
 *  doesn't need branching inline. */
export function nextSpeedMultiplier(current: SpeedMultiplier): SpeedMultiplier {
  if (current === 1) return 2;
  if (current === 2) return 4;
  return 1;
}
