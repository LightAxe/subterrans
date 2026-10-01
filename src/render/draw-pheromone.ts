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
// Draw order: called by GameScene between terrain and entities, on its own
// layer at PHEROMONE_OVERLAY_DEPTH, below every layer ants are drawn on (#399).
//
// #399: see-through and quiet — at most MAX_PHEROMONE_ALPHA (0.35), each tile's
// alpha scaled by its trail's strength (pheromoneIntensity), so weak trail fades
// into the terrain and only strong trails stand out.

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
// Constants — PRD §7f (#399 retune)
// ---------------------------------------------------------------------------

/**
 * #399 — trail strength (raw phGet value) at or below which a tile is not drawn:
 * one tick's deposit (FOOD_TRAIL_DEPOSIT_V14 = 1024; a forager carrying food lays
 * one every tick, so a single pass — about two ticks a tile — leaves ~2048, which
 * shows only faintly, ~9%). A trail no one walks any more fades out of the
 * overlay as it decays below this, ahead of the sim's 128 floor. Renderer-only;
 * no sim-version gate (the renderer is always at latest).
 */
export const PHEROMONE_VISUAL_MIN = 1024;

/**
 * Trail strength at which a tile reaches full overlay alpha (MAX_PHEROMONE_ALPHA):
 * a busy route; the spider's lair (its danger equilibrium is ~32768) and above.
 * #399: between PHEROMONE_VISUAL_MIN and this the intensity rises with the
 * LOGARITHM of the strength — a quarter of full for each doubling — because trail
 * strength spans orders of magnitude (128 … 65280): on a linear ramp the
 * moderate trails (a few thousand) all but vanished, while on this one they show
 * faintly and only the strong ones stand out. (Most of a match's trail tiles are
 * weaker still — the V68 playtest saves' per-save medians ran 270–3950 — and
 * draw faintly or not at all.)
 *
 * S0a / issue #119 had lowered it 2048 → 512, so any trail a forager had walked
 * drew at full strength; #399 found that read as large opaque neon blocks.
 */
export const PHEROMONE_VISUAL_MAX = 16384;

/**
 * Maximum alpha (opacity) for a full-strength pheromone tile. #399: 0.6 → 0.35
 * (Rob: "about 30–40%") so even the strongest trail is see-through and the
 * terrain under it stays legible. (PRD §7f)
 */
export const MAX_PHEROMONE_ALPHA = 0.35;

/**
 * #399 — the overlay's depth in GameScene: above the terrain RenderTexture
 * (depth -10), BELOW every layer an ant (or anything an ant stands on or
 * carries) is drawn on — the entity Graphics with the strategic-zoom ant dots
 * (ENTITY_GFX_DEPTH), brood and food caches, ants, carried food, the spider —
 * so ants always draw above it (draw-pheromone.test.ts pins the order; the
 * pheromone-overlay e2e reads the live scene's).
 */
export const PHEROMONE_OVERLAY_DEPTH = -5;

/** The grids the overlay draws, in draw order (module-level so a redraw does not
 *  allocate it). */
const OVERLAY_TYPES = [PheromoneType.FoodTrail, PheromoneType.DangerTrail] as const;

// ---------------------------------------------------------------------------
// pheromoneIntensity
// ---------------------------------------------------------------------------

/** log2(PHEROMONE_VISUAL_MAX / PHEROMONE_VISUAL_MIN): the doublings from not
 *  drawn to full strength (4). */
const VISUAL_OCTAVES = Math.log2(PHEROMONE_VISUAL_MAX / PHEROMONE_VISUAL_MIN);

/**
 * #399 — a tile's overlay intensity, 0–1, from its trail strength (raw phGet
 * value): 0 at or below PHEROMONE_VISUAL_MIN (not drawn), rising with the log of
 * the strength — +¼ per doubling — to 1 at PHEROMONE_VISUAL_MAX and above. The
 * tile draws with alpha `intensity × MAX_PHEROMONE_ALPHA`, its colour lerped
 * faint → strong by the same intensity. A number, not an object, so the per-tile
 * loop allocates nothing.
 */
export function pheromoneIntensity(value: number): number {
  if (value <= PHEROMONE_VISUAL_MIN) return 0;
  if (value >= PHEROMONE_VISUAL_MAX) return 1;
  return Math.log2(value / PHEROMONE_VISUAL_MIN) / VISUAL_OCTAVES;
}

// ---------------------------------------------------------------------------
// drawPheromoneOverlay
// ---------------------------------------------------------------------------

/**
 * Draw the pheromone heatmap overlay for the player colony.
 *
 * Iterates FoodTrail and DangerTrail grids for the player colony in the
 * requested zone. Each visible tile whose trail is strong enough to show
 * (pheromoneIntensity > 0) gets a see-through fillRect whose alpha and colour
 * (faint → strong) follow its intensity. Allocation-free per tile.
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
  for (const pheromoneType of OVERLAY_TYPES) {
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
        const t = pheromoneIntensity(phGet(grid, tx, ty));
        if (t <= 0) continue;
        gfx.fillStyle(lerpColor(faintColor, strongColor, t), t * MAX_PHEROMONE_ALPHA);
        gfx.fillRect(tx * TILE_SIZE_PX, ty * TILE_SIZE_PX, TILE_SIZE_PX, TILE_SIZE_PX);
      }
    }
  }
}
