// hud-controls.ts — Stage 1 controls rework (issue #18): pure geometry + hit-
// testing for the new interactive HUD widgets (tool palette, speed widget) and
// the static per-tool/per-view hint strip text.
//
// No Phaser, no DOM — pure functions over the locked HUD rects in sprites.ts, so
// they are unit-testable. UIScene draws using these positions and routes clicks
// through these hit-tests; the gesture arbiter / camera-input mask the same rects
// via isPointerOverHUD.

import { HUD } from './sprites.js';
import type { ToolId } from './camera.js';

// ---------------------------------------------------------------------------
// Tool palette (HUD.TOOLS) — 3 buttons: Command / Dig / Chamber
// ---------------------------------------------------------------------------

/** The three tools in palette order (left → right). */
export const TOOL_ORDER: readonly ToolId[] = ['command', 'dig', 'chamber'];

/** Short button glyph/label for each tool. */
export const TOOL_LABEL: Record<ToolId, string> = {
  command: 'Cmd',
  dig: 'Dig',
  chamber: 'Chmb',
};

/** Screen rect of the i-th tool button (0..2) within HUD.TOOLS. */
export function toolButtonRect(index: number): { x: number; y: number; w: number; h: number } {
  const x = HUD.TOOLS.x + index * (HUD.TOOLS.BUTTON_W + HUD.TOOLS.GAP);
  return { x, y: HUD.TOOLS.y, w: HUD.TOOLS.BUTTON_W, h: HUD.TOOLS.h };
}

/**
 * Hit-test the tool palette. Returns the ToolId at (px, py), or null if the
 * point is outside every button. On the surface view the Chamber button is
 * greyed/inert: a click on it returns null (selecting Chamber on the surface is
 * a no-op — PLAN §A1/A4).
 */
export function toolButtonAt(
  px: number,
  py: number,
  view: 'surface' | 'underground',
): ToolId | null {
  for (let i = 0; i < TOOL_ORDER.length; i++) {
    const tool = TOOL_ORDER[i]!;
    if (tool === 'chamber' && view === 'surface') continue; // greyed on surface
    const r = toolButtonRect(i);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Speed widget (HUD.SPEED) — ⏸ / 1× / 2× / 4×
// ---------------------------------------------------------------------------

/** A speed-widget control: the pause toggle or a multiplier preset. */
export type SpeedControl = 'pause' | 1 | 2 | 4;

/** The four speed-widget controls in left → right order. */
export const SPEED_CONTROL_ORDER: readonly SpeedControl[] = ['pause', 1, 2, 4];

/** Screen rect of the i-th speed control (0=⏸, 1=1×, 2=2×, 3=4×) within HUD.SPEED. */
export function speedControlRect(index: number): { x: number; y: number; w: number; h: number } {
  // ⏸ button is PAUSE_BUTTON_W wide; each multiplier is SPEED_BUTTON_W wide.
  if (index <= 0) {
    return { x: HUD.SPEED.x, y: HUD.SPEED.y, w: HUD.SPEED.PAUSE_BUTTON_W, h: HUD.SPEED.h };
  }
  const x = HUD.SPEED.x + HUD.SPEED.PAUSE_BUTTON_W + (index - 1) * HUD.SPEED.SPEED_BUTTON_W;
  return { x, y: HUD.SPEED.y, w: HUD.SPEED.SPEED_BUTTON_W, h: HUD.SPEED.h };
}

/**
 * Hit-test the speed widget. Returns the control at (px, py): 'pause' for the ⏸
 * button, or 1/2/4 for the multiplier presets; null if outside.
 */
export function speedControlAt(px: number, py: number): SpeedControl | null {
  for (let i = 0; i < SPEED_CONTROL_ORDER.length; i++) {
    const r = speedControlRect(i);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
      return SPEED_CONTROL_ORDER[i]!;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hint strip (HUD.HINTS) — static per-tool / per-view legend
// ---------------------------------------------------------------------------

/**
 * The static hint string for the active tool + view. Stage 1 is a fixed legend
 * (hover-sensitive hints are Stage 3). Surface Chamber is unreachable, so the
 * surface map has no Chamber entry — callers pass the effective tool.
 */
export function hintTextFor(tool: ToolId, view: 'surface' | 'underground'): string {
  if (view === 'surface') {
    switch (tool) {
      case 'command':
        return 'Cmd: click food to forage, empty ground to rally, the spider to target it';
      case 'dig':
        return 'Dig: click valid ground to designate an entrance';
      default:
        // Chamber on the surface is inert; show the Command legend as a fallback.
        return 'Cmd: click food to forage, empty ground to rally, the spider to target it';
    }
  }
  // underground
  switch (tool) {
    case 'command':
      return 'Cmd: click a marked tile to cancel its dig';
    case 'dig':
      return 'Dig: click or drag to mark tunnels; click a marked tile to cancel';
    case 'chamber':
      return 'Chamber: click dug-out or solid ground to place a chamber';
  }
}

/** The "paused queue full" hint surfaced when enqueueCommand drops at the cap. */
export const PAUSED_QUEUE_FULL_HINT = 'Paused queue full — resume to continue';
