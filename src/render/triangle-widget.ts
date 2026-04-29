// triangle-widget.ts — Phase 10 / D-01 1-D Forage↔Fight slider widget.
//
// File-name note: this file used to host the 3-vertex behavior triangle
// and is kept under the same name to minimize the diff against ui-scene.ts.
// The exported symbols are slider-prefixed (`screenToSliderRatio`, etc.).
// A future cleanup phase may rename the file to slider-widget.ts; until then,
// the file name is a known misnomer documented here.
//
// Provides: track geometry, screen/ratio conversion, drag state, hit-test, draw.
// All functions pure (no side effects). HUD-05: Graphics + Text only.
//
// This file has no Phaser imports — only GfxLike from draw-surface.ts.

import { HUD, COLOR_PLAYER_COLONY } from './sprites.js';
import type { GfxLike } from './draw-surface.js';

// ---------------------------------------------------------------------------
// Slider track geometry inside HUD.TRIANGLE zone (x:[8,128), y:[532,576))
//
// Track centerline at the vertical midpoint of the zone. Track length spans
// from a 16px inset on the left to a 16px inset on the right of the zone,
// giving an 88-pixel-wide horizontal track. 4-pixel-thick rendered track.
// ---------------------------------------------------------------------------

const TRACK_LEFT  = HUD.TRIANGLE.x + 16;                  // 24
const TRACK_RIGHT = HUD.TRIANGLE.x + HUD.TRIANGLE.w - 16; // 112
const TRACK_Y     = HUD.TRIANGLE.y + HUD.TRIANGLE.h / 2;  // 554
const TRACK_LEN   = TRACK_RIGHT - TRACK_LEFT;             // 88

export const SLIDER_GEOMETRY = {
  trackLeft:  TRACK_LEFT,
  trackRight: TRACK_RIGHT,
  trackY:     TRACK_Y,
  trackLen:   TRACK_LEN,
} as const;

// ---------------------------------------------------------------------------
// SliderDragState — mutable drag tracking (owned by UIScene)
// ---------------------------------------------------------------------------

export interface SliderDragState {
  isDragging:  boolean;
  targetRatio: { forage: number; fight: number };
}

export function createSliderDragState(): SliderDragState {
  return { isDragging: false, targetRatio: { forage: 10, fight: 0 } };
}

// ---------------------------------------------------------------------------
// screenToSliderRatio — pixel x → integer 0–10 ratio
//
// Position 0 (left) = full forage. Position 1 (right) = full fight.
// Out-of-track px clamps to the nearest extreme. Output is always integer
// 0–10 with `forage + fight === 10` exactly (snaps to 11 discrete steps).
// y is intentionally ignored — slider is 1-D.
// ---------------------------------------------------------------------------

export function screenToSliderRatio(px: number): { forage: number; fight: number } {
  // WR-05: defensive guard against degenerate track geometry (TRACK_LEN <= 0).
  // The test suite asserts `SLIDER_GEOMETRY.trackLen > 0` so this branch is
  // currently unreachable in production, but a future HUD constants change
  // could silently zero the denominator — `(px - TRACK_LEFT) / 0` is +/-Inf
  // or NaN, `Math.max(0, Math.min(1, NaN)) === NaN`, and the function would
  // return `{forage: NaN, fight: NaN}`, corrupting colony.targetRatio. Fall
  // back to the safe default rather than poisoning state.
  if (TRACK_LEN <= 0) return { forage: 10, fight: 0 };
  const t = (px - TRACK_LEFT) / TRACK_LEN;       // float in [0,1] (clamped below)
  const tc = Math.max(0, Math.min(1, t));
  // 11 discrete steps: 0,1,...,10. fight gets `Math.round(tc * 10)`; forage = 10 - fight.
  const fight  = Math.round(tc * 10);
  const forage = 10 - fight;
  return { forage, fight };
}

// ---------------------------------------------------------------------------
// ratioToSliderPos — inverse of screenToSliderRatio: ratio → pixel position
//
// Returns the centerline pixel position for a given ratio. If both fields
// are zero (degenerate save-migration edge case), pins to the track center.
// ---------------------------------------------------------------------------

export function ratioToSliderPos(ratio: { forage: number; fight: number }): { x: number; y: number } {
  const total = ratio.forage + ratio.fight;
  // Degenerate: pin to center if both are 0.
  const t = total === 0 ? 0.5 : ratio.fight / total;
  return { x: TRACK_LEFT + t * TRACK_LEN, y: TRACK_Y };
}

// ---------------------------------------------------------------------------
// isInsideSlider — hit-test against the full HUD.TRIANGLE zone
//
// Uses the full HUD slot (not just the visible track) so vertical slop on
// click/drag still registers as a slider gesture. Matches the prior triangle
// widget's hit zone for input continuity.
// ---------------------------------------------------------------------------

export function isInsideSlider(px: number, py: number): boolean {
  return (
    px >= HUD.TRIANGLE.x &&
    px < HUD.TRIANGLE.x + HUD.TRIANGLE.w &&
    py >= HUD.TRIANGLE.y &&
    py < HUD.TRIANGLE.y + HUD.TRIANGLE.h
  );
}

// ---------------------------------------------------------------------------
// drawSlider — render the slider widget onto a GfxLike (called per frame)
//
// Draws (in order): zone background, track line, forage icon (left, green
// programmer-art square), fight icon (right, red programmer-art square),
// current marker (filled circle in player-colony color), target marker
// (white outline circle). Text labels ("Forage" / "Fight") live in UIScene.
//
// HUD-05 compliant: only fillRect / fillCircle / strokeCircle / fillStyle /
// lineStyle calls. Zero asset loading; programmer-art icons.
// ---------------------------------------------------------------------------

export function drawSlider(
  gfx:          GfxLike,
  currentRatio: { forage: number; fight: number },
  targetRatio:  { forage: number; fight: number },
): void {
  // Zone background — semi-transparent dark fill behind the slider so labels
  // and markers stay readable against the surface beneath.
  gfx.fillStyle(0x222222, 0.9);
  gfx.fillRect(HUD.TRIANGLE.x, HUD.TRIANGLE.y, HUD.TRIANGLE.w, HUD.TRIANGLE.h);
  // Track line (4px thick, mid-gray).
  gfx.fillStyle(0x666666, 1);
  gfx.fillRect(TRACK_LEFT, TRACK_Y - 2, TRACK_LEN, 4);
  // Forage icon (left extreme): 12x12 green programmer-art square.
  gfx.fillStyle(0x66cc66, 1);
  gfx.fillRect(HUD.TRIANGLE.x + 4, TRACK_Y - 6, 12, 12);
  // Fight icon (right extreme): 12x12 red programmer-art square.
  gfx.fillStyle(0xcc6666, 1);
  gfx.fillRect(HUD.TRIANGLE.x + HUD.TRIANGLE.w - 16, TRACK_Y - 6, 12, 12);
  // Current marker (filled circle — current task census).
  const cur = ratioToSliderPos(currentRatio);
  gfx.fillStyle(COLOR_PLAYER_COLONY, 1);
  gfx.fillCircle(cur.x, cur.y, 6);
  // Target marker (outline circle — player-set target / drag preview).
  const tgt = ratioToSliderPos(targetRatio);
  gfx.lineStyle(2, 0xffffff, 1);
  gfx.strokeCircle(tgt.x, tgt.y, 6);
}
