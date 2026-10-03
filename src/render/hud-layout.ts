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
  /** #400 — the spider-order chip ("Call off spider"), shown only while the player's
   *  spider order is in force (spider-order-chip.ts). Above the alarm toggle. */
  SPIDER_ORDER: HudRect;
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
    // #400 — one 26px step above the alarm toggle, as the alarm sits above the colony toggle.
    SPIDER_ORDER: { x: w - 168, y: h - 272, w: 128, h: 22 },
    SAVE_ICON: { x: w - 28, y: 8, w: 20, h: 20 },
  };
}

/** #372 — width (px) of the minimap frame's light band (minimap.ts draws it); a
 *  1-px dark line sits one px further out. */
export const MINIMAP_BORDER_PX = 2;
/** How far (px) the minimap's frame reaches outside its map rect: the band and
 *  its 1-px line. */
export const MINIMAP_FRAME_OUT_PX = MINIMAP_BORDER_PX + 1;

/** #399 — the minimap's whole painted box: the map rect and the frame round it
 *  (drawMinimapBorder's outer edge). What an overlay keeps clear of. */
export function minimapFrameRect(hud: HudLayout): HudRect {
  const mm = hud.MINIMAP;
  const o = MINIMAP_FRAME_OUT_PX;
  return { x: mm.x - o, y: mm.y - o, w: mm.w + 2 * o, h: mm.h + 2 * o };
}

/** Caption Text side padding (px), as UIScene.beginCaption styles it. */
export const CAPTION_PAD_X = 8;
/** Widest a caption line may wrap to (px); the pre-#372 fixed wrap width. */
export const CAPTION_MAX_WRAP_W = 500;
/** Narrowest wrap width, so a far-right caption never collapses. */
export const CAPTION_MIN_WRAP_W = 200;
/** Gap (px) kept between a caption's box and the tool palette. */
const CAPTION_TOOLS_GAP = 4;
/** Half the height (px) of the tallest caption box we expect (three 14px lines
 *  plus padding): a caption centred farther than this below the tool palette
 *  cannot reach it. */
const CAPTION_MAX_HALF_H = 32;

/**
 * #372 — word-wrap width for a caption centred at (`centerX`, `centerY`). A
 * caption whose box could reach the tool palette's band (hud.TOOLS) wraps so
 * its box (wrap width + 2 × CAPTION_PAD_X) ends CAPTION_TOOLS_GAP px left of
 * the palette; at the default layout a centred top caption wraps at 440 px (at
 * the old fixed 500 a two-line caption — the army warning, raid-order
 * news — ran under the Cmd button). Captions clear of the band keep
 * CAPTION_MAX_WRAP_W. CAPTION_MIN_WRAP_W wins over clearance: a caption centred
 * within about 112 px of the palette still wraps at 200 and overlaps it (no
 * caption is placed there today).
 */
export function captionWrapWidth(centerX: number, centerY: number, hud: HudLayout): number {
  const t = hud.TOOLS;
  const inBand = centerY - CAPTION_MAX_HALF_H < t.y + t.h && centerY + CAPTION_MAX_HALF_H > t.y;
  if (!inBand) return CAPTION_MAX_WRAP_W;
  const halfRoom = t.x - CAPTION_TOOLS_GAP - centerX;
  const w = 2 * (halfRoom - CAPTION_PAD_X);
  return Math.max(CAPTION_MIN_WRAP_W, Math.min(CAPTION_MAX_WRAP_W, w));
}
