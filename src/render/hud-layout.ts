// src/render/hud-layout.ts — #238 PR1: the HUD anchor table as a pure function
// of LayoutContext (phase 2 of the layout seam; follow-up to #213).
//
// buildHudLayout(DEFAULT_LAYOUT) is byte-identical to the former `HUD` constant
// that lived in sprites.ts at 800×592 — locked by the deep-equality snapshot in
// hud-layout.test.ts. Anchors are expressed relative to layout.w / layout.h so
// the HUD reflows on resize (the Phase-6 mobile goal). Intentionally does NOT
// import CANVAS_W/H — geometry derives from the passed LayoutContext (PR5's
// discipline guard enforces this).

import type { LayoutContext } from './layout.js';

export interface HudRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudLayout {
  STATS: HudRect;
  TRIANGLE: HudRect;
  SPEED: HudRect & { PAUSE_BUTTON_W: number; SPEED_BUTTON_W: number };
  HINTS: HudRect;
  TOOLS: HudRect & { BUTTON_W: number; GAP: number };
  MINIMAP: HudRect;
  VIEW_TOGGLE: HudRect;
  UNDERGROUND_COLONY_TOGGLE: HudRect;
  SAVE_ICON: HudRect;
}

/**
 * Build the HUD anchor table for a given layout. Every anchor evaluates to the
 * former sprites.ts `HUD` constant at 800×592 (deep-equality-gated). Anchor
 * rationale (TRIANGLE h≥44 invariant, TOOLS band placement, colony-toggle
 * width, etc.) is unchanged — see PRD §6b and the prior HUD block's comments.
 */
export function buildHudLayout(layout: LayoutContext): HudLayout {
  const { w, h } = layout;
  return {
    STATS: { x: 8, y: 8, w: 200, h: 24 },
    TRIANGLE: { x: 8, y: h - 60, w: 120, h: 44 },
    SPEED: { x: w / 2 - 80, y: h - 40, w: 160, h: 32, PAUSE_BUTTON_W: 40, SPEED_BUTTON_W: 32 },
    HINTS: { x: 8, y: h - 84, w: w - 184, h: 18 },
    TOOLS: { x: w - 168, y: 36, w: 128, h: 40, BUTTON_W: 40, GAP: 4 },
    MINIMAP: { x: w - 168, y: h - 168, w: 160, h: 160 },
    VIEW_TOGGLE: { x: w - 168, y: h - 196, w: 80, h: 24 },
    UNDERGROUND_COLONY_TOGGLE: { x: w - 168, y: h - 220, w: 112, h: 22 },
    SAVE_ICON: { x: w - 28, y: 8, w: 20, h: 20 },
  };
}
