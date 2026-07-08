// hud-controls.ts — Stage 1 controls rework (issue #18): pure geometry + hit-
// testing for the new interactive HUD widgets (tool palette, speed widget) and
// the static per-tool/per-view hint strip text.
//
// No Phaser, no DOM — pure functions over HUD rects passed in by the caller
// (built via buildHudLayout in hud-layout.ts), so they are unit-testable. UIScene
// draws using these positions and routes clicks through these hit-tests; the
// gesture arbiter / camera-input mask the same rects via isPointerOverHUD.

import type { ToolId } from './camera.js';
import type { HudLayout } from './hud-layout.js';
import { glyphFor } from './input-glyphs.js';

// ---------------------------------------------------------------------------
// Tool palette (hud.TOOLS) — 3 buttons: Command / Dig / Chamber
// ---------------------------------------------------------------------------

/** The three tools in palette order (left → right). */
export const TOOL_ORDER: readonly ToolId[] = ['command', 'dig', 'chamber'];

/** Short button glyph/label for each tool. */
export const TOOL_LABEL: Record<ToolId, string> = {
  command: 'Cmd',
  dig: 'Dig',
  chamber: 'Chmb',
};

/** Screen rect of the i-th tool button (0..2) within the tools rect (hud.TOOLS). */
export function toolButtonRect(
  index: number,
  tools: HudLayout['TOOLS'],
): { x: number; y: number; w: number; h: number } {
  const x = tools.x + index * (tools.BUTTON_W + tools.GAP);
  return { x, y: tools.y, w: tools.BUTTON_W, h: tools.h };
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
  tools: HudLayout['TOOLS'],
): ToolId | null {
  for (let i = 0; i < TOOL_ORDER.length; i++) {
    const tool = TOOL_ORDER[i]!;
    if (tool === 'chamber' && view === 'surface') continue; // greyed on surface
    const r = toolButtonRect(i, tools);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Speed widget (hud.SPEED) — ⏸ / 1× / 2× / 4×
// ---------------------------------------------------------------------------

/** A speed-widget control: the pause toggle or a multiplier preset. */
export type SpeedControl = 'pause' | 1 | 2 | 4;

/** The four speed-widget controls in left → right order. */
export const SPEED_CONTROL_ORDER: readonly SpeedControl[] = ['pause', 1, 2, 4];

/** Screen rect of the i-th speed control (0=⏸, 1=1×, 2=2×, 3=4×) within the speed rect (hud.SPEED). */
export function speedControlRect(
  index: number,
  speed: HudLayout['SPEED'],
): { x: number; y: number; w: number; h: number } {
  // ⏸ button is PAUSE_BUTTON_W wide; each multiplier is SPEED_BUTTON_W wide.
  if (index <= 0) {
    return { x: speed.x, y: speed.y, w: speed.PAUSE_BUTTON_W, h: speed.h };
  }
  const x = speed.x + speed.PAUSE_BUTTON_W + (index - 1) * speed.SPEED_BUTTON_W;
  return { x, y: speed.y, w: speed.SPEED_BUTTON_W, h: speed.h };
}

/**
 * Hit-test the speed widget. Returns the control at (px, py): 'pause' for the ⏸
 * button, or 1/2/4 for the multiplier presets; null if outside.
 */
export function speedControlAt(
  px: number,
  py: number,
  speed: HudLayout['SPEED'],
): SpeedControl | null {
  for (let i = 0; i < SPEED_CONTROL_ORDER.length; i++) {
    const r = speedControlRect(i, speed);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
      return SPEED_CONTROL_ORDER[i]!;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hint strip (hud.HINTS) — static per-tool / per-view legend
// ---------------------------------------------------------------------------

/**
 * The static hint string for the active tool + view. Stage 1 is a fixed legend
 * (hover-sensitive hints are Stage 3). Surface Chamber is unreachable, so the
 * surface map has no Chamber entry — callers pass the effective tool.
 */
export function hintTextFor(tool: ToolId, view: 'surface' | 'underground'): string {
  // Stage 3b (#2): compose the gesture verbs from the glyph table instead of
  // hardcoding them, so "Click"/"Drag"/"RMB" have ONE source of truth. All
  // left-click tool actions share the same glyph, so any one of them yields the
  // canonical click token; likewise drag/right-click. `?? …` is defensive — the
  // table always defines these mouse glyphs.
  const click = glyphFor('DIG_MARK', 'mouse') ?? 'Click';
  const drag = glyphFor('DIG_PAINT', 'mouse') ?? 'Drag';
  const rmb = glyphFor('CHAMBER_MENU', 'mouse') ?? 'RMB';
  if (view === 'surface') {
    switch (tool) {
      case 'dig':
        return `Dig: ${click} valid ground to designate an entrance`;
      case 'command':
      default:
        // Chamber on the surface is inert; show the Command legend as a fallback.
        return `Cmd: ${click} food to forage, empty ground to rally, the spider to target it`;
    }
  }
  // underground
  switch (tool) {
    case 'command':
      return `Cmd: ${click} a marked tile to cancel its dig`;
    case 'dig':
      return `Dig: ${click} or ${drag} to mark tunnels; ${click} a marked tile to cancel`;
    case 'chamber':
      return `Chamber: ${click} dug-out or solid ground to place a chamber (${rmb} anywhere)`;
  }
}

/**
 * VISUAL hit-test of the tool palette for tooltips (Stage 3b #5). Unlike
 * toolButtonAt — which returns null for the inert Chamber-on-surface so a click
 * is a no-op — this returns every button the player can SEE, with an `enabled`
 * flag, so the disabled Chamber button still surfaces a tooltip ("underground
 * only") while its click stays inert (Codex R1#7).
 */
export function toolButtonVisualAt(
  px: number,
  py: number,
  view: 'surface' | 'underground',
  tools: HudLayout['TOOLS'],
): { tool: ToolId; enabled: boolean } | null {
  for (let i = 0; i < TOOL_ORDER.length; i++) {
    const tool = TOOL_ORDER[i]!;
    const r = toolButtonRect(i, tools);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
      return { tool, enabled: !(tool === 'chamber' && view === 'surface') };
    }
  }
  return null;
}

/** The queue-full hint surfaced when enqueueCommand drops a one-shot command at
 *  the cap WHILE PAUSED — the queue can't drain, so the player must resume. */
export const PAUSED_QUEUE_FULL_HINT = 'Paused queue full — resume to continue';

/** The queue-full hint surfaced when a one-shot command is dropped at the cap
 *  while RUNNING (not paused) — a transient burst (e.g. a big dig-paint stroke)
 *  momentarily filled the queue; it drains on its own, so "resume" would be
 *  wrong/misleading. The player just retries. */
export const RUNNING_QUEUE_FULL_HINT = 'Too many commands at once — try again';

/**
 * queueFullHint — pick the queue-full hint text for the current pause state.
 * Paused: the queue genuinely can't drain → "resume to continue". Running: it's
 * transient throttling that self-clears → "try again". Pulled out as a pure
 * function so the paused-vs-running message choice is unit-testable without
 * booting a Phaser scene (Stage 1 controls rework, Fix 3 / Codex P2).
 */
export function queueFullHint(paused: boolean): string {
  return paused ? PAUSED_QUEUE_FULL_HINT : RUNNING_QUEUE_FULL_HINT;
}
