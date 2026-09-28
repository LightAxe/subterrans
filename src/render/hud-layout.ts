// src/render/hud-layout.ts — #238 PR1: the HUD anchor table as a pure function
// of LayoutContext (phase 2 of the layout seam; follow-up to #213).
//
// buildHudLayout(DEFAULT_LAYOUT) reproduces the former `HUD` constant that lived
// in sprites.ts at 800×592, except for zones added or resized since (C1's
// ALARM_TOGGLE; #320's right-column toggle widths) — hud-layout.test.ts pins the
// legacy zones by deep equality and those separately. Anchors are expressed
// relative to layout.w / layout.h so the HUD reflows on resize (the Phase-6
// mobile goal). Intentionally does NOT import CANVAS_W/H — geometry derives from
// the passed LayoutContext (PR5's discipline guard enforces this).

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
  /** C1 — colony alarm toggle. Sits above the colony toggle in the right column. */
  ALARM_TOGGLE: HudRect;
  SAVE_ICON: HudRect;
}

/**
 * Build the HUD anchor table for a given layout. At 800×592 every legacy anchor
 * evaluates to the former sprites.ts `HUD` constant (deep-equality-gated); the
 * right-column toggles' shared width is #320's (see below). Other anchor
 * rationale (TRIANGLE h≥44 invariant, TOOLS band placement, etc.) is unchanged —
 * see PRD §6b and the prior HUD block's comments.
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
    // #320 — the three right-column toggles share one width, sized to hold the
    // widest label any of them shows ('Enemy Colony [X]', ~115px at 12px Courier)
    // plus the label's 4px side padding; it matches TOOLS above. They were 80 /
    // 112 / 112, and VIEW_TOGGLE's 'Underground >' painted ~26px past its rect.
    VIEW_TOGGLE: { x: w - 168, y: h - 196, w: 128, h: 24 },
    UNDERGROUND_COLONY_TOGGLE: { x: w - 168, y: h - 220, w: 128, h: 22 },
    ALARM_TOGGLE: { x: w - 168, y: h - 246, w: 128, h: 22 },
    SAVE_ICON: { x: w - 28, y: 8, w: 20, h: 20 },
  };
}

/** Caption Text side padding (px), as UIScene.beginCaption styles it. */
export const CAPTION_PAD_X = 8;
/** Widest a caption line may wrap to (px); the pre-#372 fixed wrap width. */
export const CAPTION_MAX_WRAP_W = 500;
/** Narrowest wrap width, so a far-right caption never collapses. */
export const CAPTION_MIN_WRAP_W = 200;
/** Gap (px) kept between a caption's box and the tool palette. */
const CAPTION_TOOLS_GAP = 4;

/**
 * #372 — word-wrap width for a caption centred at `centerX` at the captions' top
 * band, so its box (wrap width + 2 × CAPTION_PAD_X) stays clear of the tool
 * palette (hud.TOOLS) on its right. At the default layout a centred caption
 * wraps at 440 px: at the old fixed 500 a two-line caption (the gathering
 * warning, raid-order news) ran under the Cmd button.
 */
export function captionWrapWidth(centerX: number, hud: HudLayout): number {
  const halfRoom = hud.TOOLS.x - CAPTION_TOOLS_GAP - centerX;
  const w = 2 * (halfRoom - CAPTION_PAD_X);
  return Math.max(CAPTION_MIN_WRAP_W, Math.min(CAPTION_MAX_WRAP_W, w));
}
