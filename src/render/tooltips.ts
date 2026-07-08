// tooltips.ts — Stage 3b controls rework (issue #18, component #5).
//
// Pure hit-test + copy for on-hover tooltips over the HUD CONTROL widgets: the
// tool palette, speed widget, view toggle, colony toggle, the Forage↔Fight
// slider, and the stats bar (hud.STATS, whose tooltip teaches the non-obvious
// "click for ant activity"). EXCLUDED: the minimap (hover vs click-nav
// ambiguity) and the ant-activity panel popup (Codex R1#6/R2).
//
// Phaser-free: UIScene owns the hover-state machine, the delay timers, the
// modal/teardown lifecycle, and the Text object; this module owns only the
// "what is under the cursor + what should it say + where does it anchor" data,
// so it is unit-testable. The tool hit-test uses toolButtonVisualAt so the
// DISABLED Chamber-on-surface still tooltips (Codex R1#7).

import type { ToolId } from './camera.js';
import type { HudLayout } from './hud-layout.js';
import { toolButtonVisualAt, speedControlAt, type SpeedControl } from './hud-controls.js';
import { isInsideSlider } from './triangle-widget.js';
import { glyphFor } from './input-glyphs.js';

export interface TooltipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A control widget under the cursor. `anchor` is the widget's screen rect so
 *  UIScene can place the tooltip clear of it (never covering it). */
export type TooltipTarget =
  | { kind: 'tool'; tool: ToolId; enabled: boolean; anchor: TooltipRect }
  | { kind: 'speed'; control: SpeedControl; anchor: TooltipRect }
  | { kind: 'view-toggle'; anchor: TooltipRect }
  | { kind: 'colony-toggle'; anchor: TooltipRect }
  | { kind: 'slider'; anchor: TooltipRect }
  | { kind: 'stats'; anchor: TooltipRect };

function inRect(px: number, py: number, r: TooltipRect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/**
 * The control widget at (px, py), or null. Precedence mirrors UIScene's
 * pointerdown dispatch (stats → view-toggle → colony → tools → speed → slider);
 * the rects don't overlap, but a stable order keeps hit-test and click in
 * agreement. The colony toggle is underground-only (it isn't rendered on the
 * surface), matching isPointerOverHUD.
 */
export function tooltipTargetAt(
  px: number,
  py: number,
  view: 'surface' | 'underground',
  hud: HudLayout,
): TooltipTarget | null {
  if (inRect(px, py, hud.STATS)) return { kind: 'stats', anchor: hud.STATS };
  if (inRect(px, py, hud.VIEW_TOGGLE)) return { kind: 'view-toggle', anchor: hud.VIEW_TOGGLE };
  if (view === 'underground' && inRect(px, py, hud.UNDERGROUND_COLONY_TOGGLE)) {
    return { kind: 'colony-toggle', anchor: hud.UNDERGROUND_COLONY_TOGGLE };
  }
  const toolHit = toolButtonVisualAt(px, py, view, hud.TOOLS);
  if (toolHit !== null) {
    return { kind: 'tool', tool: toolHit.tool, enabled: toolHit.enabled, anchor: hud.TOOLS };
  }
  const speedHit = speedControlAt(px, py, hud.SPEED);
  if (speedHit !== null) return { kind: 'speed', control: speedHit, anchor: hud.SPEED };
  // The slider lives inside the hud.TRIANGLE box (legacy field name).
  if (isInsideSlider(px, py, hud.TRIANGLE)) return { kind: 'slider', anchor: hud.TRIANGLE };
  return null;
}

/** True if two targets refer to the same widget (so UIScene doesn't restart the
 *  show-delay while the cursor merely jitters within one control). */
export function sameTooltipTarget(a: TooltipTarget | null, b: TooltipTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tool' && b.kind === 'tool') return a.tool === b.tool;
  if (a.kind === 'speed' && b.kind === 'speed') return a.control === b.control;
  return true;
}

/**
 * Tooltip copy for a target — ≤150 chars, action-first, glyphs from the table.
 * The disabled Chamber teaches WHY it's inert; STATS teaches its non-obvious
 * click; the speed presets surface the keyboard step keys too.
 */
function toolTooltipText(tool: ToolId, enabled: boolean): string {
  switch (tool) {
    case 'command':
      return `Command ${glyphFor('TOOL_COMMAND', 'keyboard')} — click food, ground, or the spider to order ants`;
    case 'dig':
      return `Dig ${glyphFor('TOOL_DIG', 'keyboard')} — click or drag to mark tunnels to excavate`;
    case 'chamber':
      return enabled
        ? `Chamber ${glyphFor('TOOL_CHAMBER', 'keyboard')} — place a chamber on dug-out or solid ground`
        : 'Chamber — underground only';
  }
}

export function tooltipTextFor(target: TooltipTarget): string {
  switch (target.kind) {
    case 'tool':
      return toolTooltipText(target.tool, target.enabled);
    case 'speed':
      if (target.control === 'pause')
        return `Pause / resume ${glyphFor('PAUSE_TOGGLE', 'keyboard')}`;
      return `Set speed ${target.control}× — or ${glyphFor('SPEED_STEP_UP', 'keyboard')}/${glyphFor('SPEED_STEP_DOWN', 'keyboard')} to step`;
    case 'view-toggle':
      return `Switch surface / underground view ${glyphFor('VIEW_SWITCH', 'keyboard')}`;
    case 'colony-toggle':
      return `Switch which colony you're viewing ${glyphFor('COLONY_TOGGLE', 'keyboard')}`;
    case 'slider':
      return 'Forage ↔ Fight — drag to balance workers between foraging and fighting';
    case 'stats':
      return 'Colony population & food — click for the ant-activity breakdown';
  }
}
