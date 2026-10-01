// minimap.ts — Phase 8 minimap pure draw + click-to-pan helpers.
//
// Renders the surface overview (160x160 at hud.MINIMAP) onto a GfxLike.
// The minimap always shows the surface view regardless of activeView per PRD §7a.
//
// Exports:
//   drawMinimap(gfx, world, viewState, hud, viewerColonyId?, frameTimeMs?) — called
//     per frame from UIScene.update(); #372 adds the frame border, the enemy
//     fighter dots and the pulsing ring round an enemy army gathering near the
//     viewer's entrances (#394: or marching on them, the ring following it)
//   minimapClickToTile(px, py, hud) — converts screen pixel to tile coord, returns null if outside
//   applyMinimapClick(viewState, px, py, hud) — pan surface camera, and (while
//     underground) X-link the underground camera to the click (#399: the view
//     toggle itself no longer X-links)
//   MINIMAP_SCALE_X, MINIMAP_SCALE_Y — default-layout pixel-to-tile scale factors

import {
  TILE_SIZE_PX,
  COLOR_PLAYER_COLONY,
  COLOR_ENEMY_COLONY,
  COLOR_FOOD_PILE_NORMAL,
} from './sprites.js';
import {
  buildHudLayout,
  MINIMAP_BORDER_PX,
  MINIMAP_FRAME_OUT_PX,
  type HudLayout,
} from './hud-layout.js';
import { DEFAULT_LAYOUT } from './layout.js';
import { COLOR_BARREN_EARTH, COLOR_BARREN_EARTH_DARK } from './terrain-atlas.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
} from '../sim/constants.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { sgGet } from '../sim/terrain.js';
import { spatialHash } from './terrain-noise.js';
import type { WorldState } from '../sim/types.js';
import { pileCount, pileSlotAt, pileTileX, pileTileY } from '../sim/food/food-api.js';
import type { ViewState } from './camera.js';
import {
  SURFACE_WORLD_PX_W,
  SURFACE_WORLD_PX_H,
  UNDERGROUND_WORLD_PX_W,
  UNDERGROUND_WORLD_PX_H,
} from './camera.js';
import { clampCameraView, minimapNavTargets, visibleWorldRect } from './camera-adapter.js';
import type { GfxLike } from './draw-surface.js';
import { AntTask } from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { isEnemyGathering, measureEnemyGatheringThisTick } from './enemy-gathering.js';
import { isEnemyMarching, measureEnemyMarchThisTick } from './enemy-march.js';

// Exported for tests + external consumers. Derived from the default 800×592
// layout's minimap rect so they stay byte-identical to the pre-#238 values
// (160/128 = 1.25). Consumers inside this module derive the scale from the
// passed `hud` instead so the minimap reflows with the layout.
const DEFAULT_MINIMAP = buildHudLayout(DEFAULT_LAYOUT).MINIMAP;
export const MINIMAP_SCALE_X = DEFAULT_MINIMAP.w / SURFACE_GRID_WIDTH; // 160 / 128 = 1.25
export const MINIMAP_SCALE_Y = DEFAULT_MINIMAP.h / SURFACE_GRID_HEIGHT; // 1.25

// Issue #76 — memorial marker color/size for fully-dead colonies (queen
// dead AND no live entrances). Distinct dark gray (not a darkened
// colony-color, which could be misread as 'low-health'). Smaller (2×2)
// than the live 4×4 marker — subtler, conveys 'remains' rather than
// active colony.
const COLOR_DEAD_COLONY_MEMORIAL = 0x444444 as const;

// #372 — the minimap frame: a light 2px band round the map inside a 1px dark
// line, both OUTSIDE the map rect (so no map pixel is covered). The playtest
// found the unframed minimap melting into the surface ground behind it.
export const MINIMAP_BORDER_COLOR = 0xe8dcb4;
export const MINIMAP_BORDER_OUTLINE_COLOR = 0x000000;
/** Width (px) of the light band; the dark line sits one px further out. (#399:
 *  defined in hud-layout.ts beside minimapFrameRect, re-exported here.) */
export { MINIMAP_BORDER_PX };

// #372 — enemy fighters on the minimap: a bright red square on a dark backing
// one px wider each side, so a lone fighter reads against both the pale ground
// and the white viewport outline, and a crowd fuses into one outlined red blob.
export const COLOR_MINIMAP_ENEMY_FIGHTER = 0xff2a1f;
export const COLOR_MINIMAP_ENEMY_FIGHTER_BACKING = 0x1a0000;
/** Side (px) of the red square; the backing is 2px larger. */
export const MINIMAP_ENEMY_DOT_PX = 3;

// #372 — the ring round an enemy army (gathering near an entrance, or — #394 —
// marching on one): red, pulsing once a second in radius and alpha, over a dark
// halo.
export const COLOR_MINIMAP_ARMY_RING = 0xff2a1f;
export const MINIMAP_RING_PERIOD_MS = 1000;
/** Ring radius bounds (px) around the army's bounding box. */
export const MINIMAP_RING_MIN_R = 9;
export const MINIMAP_RING_MAX_R = 24;

/** Clamp a scalar to [lo, hi] (render-side float math, ARCHITECTURE.md Principle 6). */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * #278 — bake the STATIC minimap layer (barren-earth base + hash-driven dapple)
 * into a TEXTURE-LOCAL gfx (origin 0,0), sized mmW × mmH. The surface is frozen
 * post-scenario (sgSet is generation-only), so UIScene bakes this ONCE into a
 * RenderTexture positioned at the minimap rect instead of redrawing the ~16k-tile
 * dapple every frame (was an O(world) per-frame pass — #236 debt #2). The dynamic
 * overlays (food, colony markers, viewport, ants) still draw per frame in
 * drawMinimap below.
 *
 * Pixel-identical to the old inline draw: mm.x/mm.y are integers, so a local dapple
 * floored at (tx*sx)|0 and placed at the RT's screen anchor (mm.x, mm.y) equals the
 * old (mm.x + tx*sx)|0 (integer + floor(frac) = floor(integer + frac)).
 */
export function bakeMinimapDapple(gfx: GfxLike, world: WorldState, mmW: number, mmH: number): void {
  const sx = mmW / SURFACE_GRID_WIDTH;
  const sy = mmH / SURFACE_GRID_HEIGHT;
  gfx.fillStyle(COLOR_BARREN_EARTH, 1);
  gfx.fillRect(0, 0, mmW, mmH);
  const surface = world.surface;
  if (surface === undefined) return;
  gfx.fillStyle(COLOR_BARREN_EARTH_DARK, 0.7);
  const SALT_MINIMAP_DAPPLE = 901;
  for (let ty = 0; ty < surface.height; ty++) {
    for (let tx = 0; tx < surface.width; tx++) {
      // Read the surface tile so a future SurfaceTileState extension can bias
      // dapple density per tile type without a renderer rewrite.
      void sgGet(surface, tx, ty);
      const h = spatialHash(tx, ty, SALT_MINIMAP_DAPPLE);
      if ((h & 0xff) >= 32) continue; // ~12% coverage
      gfx.fillRect((tx * sx) | 0, (ty * sy) | 0, 1, 1);
    }
  }
}

export function drawMinimap(
  gfx: GfxLike,
  world: WorldState,
  viewState: ViewState,
  hud: HudLayout,
  viewerColonyId: ColonyId = PLAYER_COLONY_ID,
  frameTimeMs = 0,
): void {
  // Scale + anchor derive from the passed layout's minimap rect so the minimap
  // reflows on resize; at the default 800×592 layout these equal the exported
  // MINIMAP_SCALE_X/Y (1.25) and the former HUD-table MINIMAP anchor.
  const mm = hud.MINIMAP;
  const sx = mm.w / SURFACE_GRID_WIDTH;
  const sy = mm.h / SURFACE_GRID_HEIGHT;

  // #278 — the STATIC barren-earth base + hash-driven dapple now live on a baked
  // RenderTexture (bakeMinimapDapple, drawn once by UIScene behind this gfx layer);
  // this per-frame path draws only the DYNAMIC overlays on top of it.

  // Food piles (2x2 pixels per pile)
  const nPiles = pileCount(world);
  for (let o = 0; o < nPiles; o++) {
    const slot = pileSlotAt(world, o);
    const px = mm.x + pileTileX(world, slot) * sx;
    const py = mm.y + pileTileY(world, slot) * sy;
    gfx.fillStyle(COLOR_FOOD_PILE_NORMAL, 1);
    gfx.fillRect(px - 1, py - 1, 2, 2);
  }

  // Viewport rect — always tracks surfaceCamera (minimap shows surface always per
  // PRD §7a). Stage 2: the visible window is zoom-dependent, so derive it from the
  // adapter's world rect (world px → tiles → minimap px).
  const rect = visibleWorldRect(viewState.surfaceCamera);
  // Clamp the rect to the minimap frame before drawing. Under zoom the visible
  // world window can exceed the world/minimap extent (e.g. at MIN_ZOOM the rect
  // is ~312px wide vs the 160px minimap, and a centered camera pushes its left
  // edge negative), so the unclamped outline would spill outside the 160×160 box
  // onto neighboring HUD zones. Clamp each edge to [mm.x .. x+w] / [.y .. y+h].
  const minX = mm.x;
  const maxX = mm.x + mm.w;
  const minY = mm.y;
  const maxY = mm.y + mm.h;
  const rx = clamp(mm.x + (rect.left / TILE_SIZE_PX) * sx, minX, maxX);
  const ry = clamp(mm.y + (rect.top / TILE_SIZE_PX) * sy, minY, maxY);
  const rRight = clamp(mm.x + (rect.right / TILE_SIZE_PX) * sx, minX, maxX);
  const rBottom = clamp(mm.y + (rect.bottom / TILE_SIZE_PX) * sy, minY, maxY);
  const rw = rRight - rx;
  const rh = rBottom - ry;

  // Four one-pixel fillRects form the viewport outline (GfxLike has no strokeRect)
  gfx.fillStyle(0xffffff, 0.8);
  gfx.fillRect(rx, ry, rw, 1); // top edge
  gfx.fillRect(rx, ry + rh - 1, rw, 1); // bottom edge
  gfx.fillRect(rx, ry, 1, rh); // left edge
  gfx.fillRect(rx + rw - 1, ry, 1, rh); // right edge

  // #372 — enemy fighters and the ring round an army gathering near (or, #394,
  // marching on) the viewer's entrances, on top of the viewport outline so
  // neither hides behind it.
  drawMinimapEnemyFighters(gfx, world, hud, viewerColonyId);
  // Colony markers after the dots, so an enemy nest's own sentries never bury
  // its marker (#372).
  drawMinimapColonyMarkers(gfx, world, mm, sx, sy);
  drawMinimapArmyRing(gfx, world, hud, viewerColonyId, frameTimeMs);

  // #372 — the frame, outside the map rect (nothing above draws there).
  drawMinimapBorder(gfx, hud);
}

/** Colony markers (#76): live 4×4 in colony colour, or a 2×2 memorial. */
function drawMinimapColonyMarkers(
  gfx: GfxLike,
  world: WorldState,
  mm: HudLayout['MINIMAP'],
  sx: number,
  sy: number,
): void {
  // Colony markers — live (4×4 colored) or memorial (2×2 dark gray).
  //
  // Issue #76 — fix the queen-status check. Pre-fix used `queenEntityId >= 0`
  // which is true forever (allocateEntityId never recycles ids and
  // queenEntityId is set once at colony creation). Switched to isAlive()
  // and added a memorial-marker branch for fully-dead colonies (queen
  // dead AND no live entrances), so wiped colonies don't confusingly
  // persist on the minimap.
  for (const colonyIdStr of Object.keys(world.colonies)) {
    const colonyId = Number(colonyIdStr);
    const colony = world.colonies[colonyId]!;
    const liveColor =
      colonyId === PLAYER_COLONY_ID
        ? COLOR_PLAYER_COLONY
        : colonyId === ENEMY_COLONY_ID
          ? COLOR_ENEMY_COLONY
          : COLOR_PLAYER_COLONY;
    // Per #76 design: a 'live foothold' is an OPEN entrance (workers can
    // actively transition zones through it). Merely-designated closed
    // entrances are pre-excavation intent — show as live only if the
    // queen is still alive (then it's a young colony still excavating).
    const liveEntrances = colony.entrances ?? [];
    const firstOpenEntrance = liveEntrances.find((e) => e.isOpen);
    const queenAlive = isAlive(world.ants, colony.queenEntityId);

    let tileX = 0,
      tileY = 0;
    let color = liveColor;
    let size: 2 | 4 = 4;
    let halfOffset: 1 | 2 = 2;

    if (firstOpenEntrance !== undefined) {
      // Prefer the first OPEN entrance position. Live colored marker —
      // an open entrance is a live foothold even if the queen is dead
      // (workers still doing things; it's beheaded, not gone).
      tileX = firstOpenEntrance.surfaceTileX;
      tileY = firstOpenEntrance.surfaceTileY;
    } else if (queenAlive) {
      // No entrances yet but queen alive — pre-excavation colony. Live
      // colored marker at queen's tile. Issue #77 uses FP_SHIFT import.
      const queenId = colony.queenEntityId;
      tileX = world.ants.posX[queenId]! >> FP_SHIFT;
      tileY = world.ants.posY[queenId]! >> FP_SHIFT;
    } else {
      // Fully-dead colony: queen dead AND no live entrances. Memorial
      // marker at queen's last-known position. Entity slots preserve
      // posX/posY after death, so this is the most meaningful 'where
      // was this colony' landmark.
      const queenId = colony.queenEntityId;
      tileX = world.ants.posX[queenId]! >> FP_SHIFT;
      tileY = world.ants.posY[queenId]! >> FP_SHIFT;
      color = COLOR_DEAD_COLONY_MEMORIAL;
      size = 2;
      halfOffset = 1;
    }

    const px = mm.x + tileX * sx;
    const py = mm.y + tileY * sy;
    gfx.fillStyle(color, 1);
    gfx.fillRect(px - halfOffset, py - halfOffset, size, size);
  }
}

/** #372 — frame the minimap: a light band and a dark outer line, outside the rect
 *  (its outer edge is minimapFrameRect, hud-layout.ts). */
export function drawMinimapBorder(gfx: GfxLike, hud: HudLayout): void {
  const mm = hud.MINIMAP;
  const b = MINIMAP_BORDER_PX;
  const o = MINIMAP_FRAME_OUT_PX;
  frameRect(gfx, mm.x - o, mm.y - o, mm.w + 2 * o, mm.h + 2 * o, 1, MINIMAP_BORDER_OUTLINE_COLOR);
  frameRect(gfx, mm.x - b, mm.y - b, mm.w + 2 * b, mm.h + 2 * b, b, MINIMAP_BORDER_COLOR);
}

/** A `t`-px frame whose outer edge is the rect (x, y, w, h). */
function frameRect(
  gfx: GfxLike,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  color: number,
): void {
  gfx.fillStyle(color, 1);
  gfx.fillRect(x, y, w, t); // top
  gfx.fillRect(x, y + h - t, w, t); // bottom
  gfx.fillRect(x, y + t, t, h - 2 * t); // left
  gfx.fillRect(x + w - t, y + t, t, h - 2 * t); // right
}

/**
 * #372 — every enemy fighter on the surface (any colony but the viewer's, doing
 * the Fighting task) as a red dot, always. The minimap shows only the surface
 * (PRD §7a), so fighters in the tunnels are not drawn. Two passes (all backings,
 * then all dots) so a crowd reads as one red blob with a dark outline. Dots are
 * clamped into the map rect.
 */
export function drawMinimapEnemyFighters(
  gfx: GfxLike,
  world: WorldState,
  hud: HudLayout,
  viewerColonyId: ColonyId,
): void {
  const mm = hud.MINIMAP;
  const sx = mm.w / SURFACE_GRID_WIDTH;
  const sy = mm.h / SURFACE_GRID_HEIGHT;
  const ants = world.ants;
  const end = Math.min(world.nextEntityId, ants.alive.length);
  const d = MINIMAP_ENEMY_DOT_PX;
  for (let pass = 0; pass < 2; pass++) {
    const size = pass === 0 ? d + 2 : d;
    gfx.fillStyle(
      pass === 0 ? COLOR_MINIMAP_ENEMY_FIGHTER_BACKING : COLOR_MINIMAP_ENEMY_FIGHTER,
      1,
    );
    for (let id = 0; id < end; id++) {
      if (ants.alive[id] !== 1) continue;
      if (ants.zone[id] !== Zone.Surface) continue;
      if (ants.task[id] !== AntTask.Fighting) continue;
      if (ants.colonyId[id] === viewerColonyId) continue;
      const cx = mm.x + (ants.posX[id]! / FP_ONE) * sx;
      const cy = mm.y + (ants.posY[id]! / FP_ONE) * sy;
      const x = clamp(Math.round(cx - size / 2), mm.x, mm.x + mm.w - size);
      const y = clamp(Math.round(cy - size / 2), mm.y, mm.y + mm.h - size);
      gfx.fillRect(x, y, size, size);
    }
  }
}

/** A bounding box in tile coordinates (fractional). */
interface TileBox {
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
}

/**
 * #372/#394 — ring every enemy army threatening the viewer's entrances: one
 * marching on them (isEnemyMarching, enemy-march.ts), so the ring follows it
 * across the map, and one gathering near an entrance (isEnemyGathering). A march
 * and a gathering at the same entrance are one army — its head at the door, its
 * tail still coming — and share one ring round both, if one ring can enclose
 * them (else, like a march and a gathering at different entrances, one each).
 */
export function drawMinimapArmyRing(
  gfx: GfxLike,
  world: WorldState,
  hud: HudLayout,
  viewerColonyId: ColonyId,
  frameTimeMs: number,
): void {
  const g = measureEnemyGatheringThisTick(world, viewerColonyId);
  const m = measureEnemyMarchThisTick(world, viewerColonyId);
  const gathering = isEnemyGathering(g);
  const marching = isEnemyMarching(m);
  if (marching && gathering && m.entrance === g.entrance) {
    const both: TileBox = {
      minTileX: Math.min(m.minTileX, g.minTileX),
      minTileY: Math.min(m.minTileY, g.minTileY),
      maxTileX: Math.max(m.maxTileX, g.maxTileX),
      maxTileY: Math.max(m.maxTileY, g.maxTileY),
    };
    if (ringBaseRadius(hud, both) <= MINIMAP_RING_MAX_R) {
      drawRingRound(gfx, hud, frameTimeMs, both);
      return;
    }
    // Too far apart for one ring to enclose both: one each.
  }
  if (marching) drawRingRound(gfx, hud, frameTimeMs, m);
  if (gathering) drawRingRound(gfx, hud, frameTimeMs, g);
}

/** The unclamped base radius (px) of a ring round `box`: half its diagonal on
 *  the minimap, plus 4. */
function ringBaseRadius(hud: HudLayout, box: TileBox): number {
  const sx = hud.MINIMAP.w / SURFACE_GRID_WIDTH;
  const sy = hud.MINIMAP.h / SURFACE_GRID_HEIGHT;
  return Math.hypot((box.maxTileX - box.minTileX) * sx, (box.maxTileY - box.minTileY) * sy) / 2 + 4;
}

/**
 * #372 — the ring round one army's bounding box `box`: a red circle pulsing in
 * radius (+2px) and alpha once per MINIMAP_RING_PERIOD_MS, over a dark halo. The
 * radius is clamped to [MINIMAP_RING_MIN_R, MINIMAP_RING_MAX_R] and the centre
 * pulled in so the ring stays inside the map rect.
 */
function drawRingRound(gfx: GfxLike, hud: HudLayout, frameTimeMs: number, box: TileBox): void {
  const mm = hud.MINIMAP;
  const sx = mm.w / SURFACE_GRID_WIDTH;
  const sy = mm.h / SURFACE_GRID_HEIGHT;
  const x0 = box.minTileX * sx;
  const x1 = box.maxTileX * sx;
  const y0 = box.minTileY * sy;
  const y1 = box.maxTileY * sy;
  const phase = 0.5 + 0.5 * Math.sin((2 * Math.PI * frameTimeMs) / MINIMAP_RING_PERIOD_MS);
  const base = clamp(ringBaseRadius(hud, box), MINIMAP_RING_MIN_R, MINIMAP_RING_MAX_R);
  const r = base + 2 * phase;
  const reach = r + 2; // the halo's outer edge
  const cx = clamp(mm.x + (x0 + x1) / 2, mm.x + reach, mm.x + mm.w - reach);
  const cy = clamp(mm.y + (y0 + y1) / 2, mm.y + reach, mm.y + mm.h - reach);
  gfx.lineStyle(4, 0x000000, 0.55);
  gfx.strokeCircle(cx, cy, r);
  gfx.lineStyle(2, COLOR_MINIMAP_ARMY_RING, 0.55 + 0.45 * phase);
  gfx.strokeCircle(cx, cy, r);
}

export function minimapClickToTile(
  px: number,
  py: number,
  hud: HudLayout,
): { tileX: number; tileY: number } | null {
  const mm = hud.MINIMAP;
  const sx = mm.w / SURFACE_GRID_WIDTH;
  const sy = mm.h / SURFACE_GRID_HEIGHT;
  if (px < mm.x || px >= mm.x + mm.w) return null;
  if (py < mm.y || py >= mm.y + mm.h) return null;
  return {
    tileX: (px - mm.x) / sx,
    tileY: (py - mm.y) / sy,
  };
}

export function applyMinimapClick(
  viewState: ViewState,
  px: number,
  py: number,
  hud: HudLayout,
): boolean {
  const tile = minimapClickToTile(px, py, hud);
  if (!tile) return false;
  // Click tile (fractional) → world px. minimapNavTargets sets the SURFACE center to
  // the click and X-links the underground center while PRESERVING its depth (PLAN
  // §A6) — not "centerOn whichever camera is active".
  const worldX = tile.tileX * TILE_SIZE_PX;
  const worldY = tile.tileY * TILE_SIZE_PX;
  const targets = minimapNavTargets(
    viewState.surfaceCamera,
    viewState.undergroundCamera,
    worldX,
    worldY,
  );
  viewState.surfaceCamera.centerX = targets.surfaceCenterX;
  viewState.surfaceCamera.centerY = targets.surfaceCenterY;
  clampCameraView(viewState.surfaceCamera, SURFACE_WORLD_PX_W, SURFACE_WORLD_PX_H);
  // Issue #86 — clamp the underground camera with its OWN dimensions after the
  // X-link (independent constants; underground is shorter, so a different clamp).
  if (viewState.activeView === 'underground') {
    viewState.undergroundCamera.centerX = targets.undergroundCenterX;
    viewState.undergroundCamera.centerY = targets.undergroundCenterY;
    clampCameraView(viewState.undergroundCamera, UNDERGROUND_WORLD_PX_W, UNDERGROUND_WORLD_PX_H);
  }
  return true;
}
