// pause-menu-layout.ts — issue #116 pause menu layout + hit-testing.
//
// Pure-TypeScript module: no Phaser, no DOM. UIScene consumes the menu items
// to lay out Game Objects, and reuses the hit-test for pointerdown dispatch.
// Pure-data shape mirrors context-menu-layout.ts so the menu is testable in
// Vitest without spinning up a Phaser scene.
//
// Layout: vertical stack of fixed-size buttons, centered horizontally on the
// 800×592 canvas. Vertical anchor is the canvas centerline minus half the
// stack height, so the stack stays visually centered as page contents change.
//
// State machine (consumer drives, this module renders):
//   main     → Resume / Save+Load / Settings → / Download debug log
//   settings → (page entries, populated by callers — issue #114 adds pheromone
//              toggle) / ← Back
//
// The `Save/Load` row carries an `enabled` flag so it can render disabled
// while issue #115's dialog isn't yet wired in.

import type { Settings } from '../platform/settings.js';

// ---------------------------------------------------------------------------
// Geometry constants (canvas-local pixels)
// ---------------------------------------------------------------------------

export const CANVAS_W = 800;
export const CANVAS_H = 592;

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
  | 'speed-cycle';

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
  /** Latest settings snapshot — Settings page reads this to render toggle state. */
  settings: Settings;
  /** Current speedMultiplier (1 | 2 | 4). The Settings page renders this in
   *  the "Speed: N×" cycle row. Source of truth is GameScene's live field —
   *  the menu reads via the onSpeedMultiplier callback at render time and
   *  writes via onCycleSpeed when the row is clicked. Session-only (no
   *  settings persistence — matches the Phase 4 fresh-boot contract that
   *  speed resets to 1× on restart). */
  currentSpeedMultiplier: SpeedMultiplier;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Compute the vertical center anchor for a stack of n buttons (with the title
 * gap), then derive each button's rect. Returns rects in render order top→bottom.
 */
function stackRects(n: number): MenuItemRect[] {
  const stackHeight =
    PAUSE_MENU_TITLE_HEIGHT
    + n * PAUSE_MENU_BUTTON_H
    + (n - 1) * PAUSE_MENU_BUTTON_GAP;
  const top = (CANVAS_H - stackHeight) / 2 + PAUSE_MENU_TITLE_HEIGHT;
  const x = (CANVAS_W - PAUSE_MENU_BUTTON_W) / 2;
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
export function titleCenterY(itemCount: number): number {
  const rects = stackRects(itemCount);
  return rects[0]!.y - PAUSE_MENU_TITLE_HEIGHT / 2;
}

/** Compose the menu items for the current page. */
export function pauseMenuItems(
  page: PauseMenuPage,
  ctx: PauseMenuRenderContext,
): PauseMenuItem[] {
  if (page === 'main') {
    const labels: Array<{ id: PauseMenuItemId; label: string; enabled: boolean }> = [
      { id: 'resume',         label: 'Resume',             enabled: true },
      { id: 'save-load',      label: 'Save / Load',        enabled: ctx.saveLoadEnabled },
      { id: 'settings',       label: 'Settings  >',        enabled: true },
      { id: 'debug-snapshot', label: 'Download debug log', enabled: true },
    ];
    const rects = stackRects(labels.length);
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
      label: `Pheromone trails: ${ctx.settings.pheromoneOverlay ? 'ON' : 'OFF'}`,
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
  const rects = stackRects(labels.length);
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
export function itemAt(items: readonly PauseMenuItem[], px: number, py: number): PauseMenuItem | null {
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
