// draw-pheromone.ts — Phase 8 pheromone heatmap overlay drawing module
// (Stage 2 world-space migration, Phase A).
//
// Pure functions: take a GfxLike + WorldState, issue Graphics API calls.
// No scene management, no input handling, no state mutation.
//
// Renders ONLY the player colony's pheromone grids (PRD §7b — enemy
// pheromones are not visualized).
//
// Uses ONLY Graphics primitives: fillRect, fillStyle — NO Image, NO Sprite,
// NO texture loading (HUD-05).
//
// Stage 2 (issue #18): tiles are drawn in WORLD pixels (worldX = tileX ×
// TILE_SIZE_PX); the Phaser main camera (camera adapter: setZoom + centerOn)
// projects world → screen, so this no longer subtracts a camera offset. The
// visible tile range comes from the zoom-aware visibleTileRange helper (shared
// with draw-surface), not a fixed viewport in tiles.
//
// Draw order: called by GameScene between terrain and entities.

export type { GfxLike } from './draw-surface.js';

import type { GfxLike } from './draw-surface.js';
import { phGet, pheromoneGridKey } from '../sim/pheromone/pheromone-store.js';
import type { Zone } from '../sim/pheromone/pheromone-store.js';
import { PheromoneType } from '../sim/enums.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { WorldState } from '../sim/types.js';
import {
  TILE_SIZE_PX,
  COLOR_PHEROMONE_FOOD_FAINT,
  COLOR_PHEROMONE_FOOD_STRONG,
  COLOR_PHEROMONE_DANGER_FAINT,
  COLOR_PHEROMONE_DANGER_STRONG,
  lerpColor,
} from './sprites.js';
import { type CameraView } from './camera-adapter.js';
import { visibleTileRange } from './draw-surface.js';

// ---------------------------------------------------------------------------
// Constants — PRD §7f
// ---------------------------------------------------------------------------

/**
 * Maximum pheromone intensity value used for visual normalization.
 * Values above this clamp to full strength. (PRD §7f)
 *
 * S0a / issue #119: lowered 2048 → 512 so the steady-state foraging cohort
 * produces a visible trail (≥0.5 alpha) under the V14 deposit constants.
 * Renderer-only; no sim-version gate needed (renderer is always at latest).
 */
export const PHEROMONE_VISUAL_MAX = 512;

/**
 * Maximum alpha (opacity) for a fully-saturated pheromone tile overlay.
 * Keeps the overlay translucent so terrain remains visible. (PRD §7f)
 */
export const MAX_PHEROMONE_ALPHA = 0.6;

// ---------------------------------------------------------------------------
// pheromoneRenderParams
// ---------------------------------------------------------------------------

/**
 * Compute the display color and alpha for a pheromone cell.
 *
 * Normalizes `value` against PHEROMONE_VISUAL_MAX (clamped to 1.0), then:
 *   - alpha  = normalized × MAX_PHEROMONE_ALPHA
 *   - color  = lerpColor(faintColor, strongColor, normalized)
 *
 * @param value       - Raw pheromone integer from phGet (≥ 0).
 * @param faintColor  - 0xRRGGBB color at low intensity.
 * @param strongColor - 0xRRGGBB color at full intensity.
 * @returns { alpha, color } ready to pass to gfx.fillStyle().
 */
export function pheromoneRenderParams(
  value: number,
  faintColor: number,
  strongColor: number,
): { alpha: number; color: number } {
  const normalized = Math.min(value / PHEROMONE_VISUAL_MAX, 1.0);
  return {
    alpha: normalized * MAX_PHEROMONE_ALPHA,
    color: lerpColor(faintColor, strongColor, normalized),
  };
}

// ---------------------------------------------------------------------------
// drawPheromoneOverlay
// ---------------------------------------------------------------------------

/**
 * Draw the pheromone heatmap overlay for the player colony.
 *
 * Iterates FoodTrail and DangerTrail grids for the player colony in the
 * requested zone. Each visible tile with value > 0 gets a translucent fillRect
 * whose color ramps from faint to strong proportional to intensity.
 *
 * Missing grids (key not present in world.pheromoneGrids) are skipped
 * silently — T-08-06 mitigate.
 *
 * Renders ONLY PLAYER_COLONY_ID grids — enemy pheromones are not shown
 * (PRD §7b, T-08-05 accept).
 *
 * @param gfx   - GfxLike graphics recorder / Phaser Graphics object.
 * @param world - Current WorldState (read-only; not mutated).
 * @param cam   - Zoom-aware CameraView (world pixels); drives the visible tile range.
 * @param zone  - 'surface' or 'underground' — selects which pheromone grids to draw.
 */
export function drawPheromoneOverlay(
  gfx: GfxLike,
  world: WorldState,
  cam: CameraView,
  zone: 'surface' | 'underground',
): void {
  const pheromoneTypes = [PheromoneType.FoodTrail, PheromoneType.DangerTrail] as const;

  for (const pheromoneType of pheromoneTypes) {
    const key = pheromoneGridKey(PLAYER_COLONY_ID, pheromoneType, zone as Zone);
    const grid = world.pheromoneGrids[key];
    if (grid === undefined) continue;

    // Visible tile range (zoom-aware), clamped to this grid's bounds.
    const { left, top, right, bottom } = visibleTileRange(cam, grid.width, grid.height);

    // Choose faint/strong palette by pheromone type
    const faintColor =
      pheromoneType === PheromoneType.FoodTrail
        ? COLOR_PHEROMONE_FOOD_FAINT
        : COLOR_PHEROMONE_DANGER_FAINT;
    const strongColor =
      pheromoneType === PheromoneType.FoodTrail
        ? COLOR_PHEROMONE_FOOD_STRONG
        : COLOR_PHEROMONE_DANGER_STRONG;

    for (let ty = Math.max(top, 0); ty < bottom; ty++) {
      for (let tx = Math.max(left, 0); tx < right; tx++) {
        const val = phGet(grid, tx, ty);
        if (val <= 0) continue;

        const params = pheromoneRenderParams(val, faintColor, strongColor);
        gfx.fillStyle(params.color, params.alpha);
        gfx.fillRect(tx * TILE_SIZE_PX, ty * TILE_SIZE_PX, TILE_SIZE_PX, TILE_SIZE_PX);
      }
    }
  }
}
