// src/render/draw-command-legibility.ts — Stage 3a (Command Legibility, issue #18).
//
// The render OVERLAY for Feature A: draws the pending-command ghost delta (#6) and the
// feedforward validity tint (#4) into a world-space Graphics under cameras.main (Stage-2
// world coords; tile → world px = tile × TILE_SIZE_PX). A DYNAMIC layer — it reads the
// projected delta each frame and is NEVER baked into the Stage-2 terrain RenderTexture.
//
// 4-state visual vocabulary: green/red/blocked = AIMING (feedforward); dashed/low-alpha =
// QUEUED (ghosts); solid = committed (drawn elsewhere). Exact colours/alpha are UAT-tunable.

import { TILE_SIZE_PX, COLOR_RALLY_POINT } from './sprites.js';
import { chamberSeed, chamberPerimeterPoints } from './chamber-shape.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import type { GfxLike } from './draw-surface.js';
import type { GhostDelta } from './command-ghosts.js';
import type { FeedforwardOutcome } from './command-feedforward.js';

// --- UAT-tunable visual constants ---------------------------------------------
const COLOR_PENDING = 0x3a7bd5; // proto-blue "queued" (slides into committed Marked blue)
const COLOR_REMOVAL = 0xd5773a; // pending un-mark / cancel
const COLOR_VALID = 0x44cc66; // feedforward green
const COLOR_INVALID = 0xcc4444; // feedforward red
const COLOR_BLOCKED = 0x999999; // feedforward "queue full" (distinct from geometric red)
const GHOST_ALPHA = 0.35;
const TINT_ALPHA = 0.4;

/** A hovered placement target + its feedforward outcome (underground chamber/tunnel). */
export interface HoveredFeedforward {
  readonly tileX: number;
  readonly tileY: number;
  readonly width: number; // footprint (1×1 for a tunnel tile)
  readonly height: number;
  readonly chamberType: number | null; // set for a chamber ghost outline; null for a tunnel tile
  readonly outcome: FeedforwardOutcome;
}

function fillCellInset(
  gfx: GfxLike,
  tileX: number,
  tileY: number,
  color: number,
  alpha: number,
): void {
  const t = TILE_SIZE_PX;
  // Inset so a pending mark reads as "not yet the full committed tile".
  gfx.fillStyle(color, alpha);
  gfx.fillRect(tileX * t + 2, tileY * t + 2, t - 4, t - 4);
}

function fillChamberShape(
  gfx: GfxLike,
  colonyId: number,
  chamberType: number,
  anchorTileX: number,
  anchorTileY: number,
  width: number,
  height: number,
  color: number,
  alpha: number,
): void {
  const t = TILE_SIZE_PX;
  const x = anchorTileX * t;
  const y = anchorTileY * t;
  const w = width * t;
  const h = height * t;
  const seed = chamberSeed(colonyId, 0, chamberType);
  const pts = chamberPerimeterPoints(seed, x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h / 2;
  gfx.fillStyle(color, alpha);
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % pts.length]!;
    gfx.fillTriangle(cx, cy, p1.x, p1.y, p2.x, p2.y);
  }
}

/**
 * Draw the player-attributable pending-command ghosts for the active view. Underground
 * ghosts are gated on the player colony being active (Codex R1-12) — player commands carry
 * coords that must not paint over the enemy grid.
 */
export function drawGhostDelta(
  gfx: GfxLike,
  delta: GhostDelta,
  view: 'surface' | 'underground',
  activeUndergroundColonyId: number,
): void {
  if (view === 'underground') {
    if (activeUndergroundColonyId !== PLAYER_COLONY_ID) return; // enemy-view inert
    for (const m of delta.pendingMarks)
      fillCellInset(gfx, m.tileX, m.tileY, COLOR_PENDING, GHOST_ALPHA);
    for (const m of delta.pendingRemovals)
      fillCellInset(gfx, m.tileX, m.tileY, COLOR_REMOVAL, GHOST_ALPHA);
    for (const c of delta.ghostChambers) {
      fillChamberShape(
        gfx,
        c.colonyId,
        c.chamberType,
        c.anchorTileX,
        c.anchorTileY,
        c.width,
        c.height,
        COLOR_PENDING,
        GHOST_ALPHA,
      );
    }
    for (const c of delta.removedChambers) {
      fillChamberShape(
        gfx,
        c.colonyId,
        c.chamberType,
        c.anchorTileX,
        c.anchorTileY,
        c.width,
        c.height,
        COLOR_REMOVAL,
        GHOST_ALPHA,
      );
    }
  } else {
    // surface — pending food-mark marker (Stage 3a): a small queued dot at the food pile the
    // player's queue will newly prioritize. Same COLOR_PENDING + GHOST_ALPHA "queued" treatment
    // as the rally ghost / dig marks; the inset circle reads as "not yet the committed target".
    if (delta.pendingFoodMark !== null) {
      const t = TILE_SIZE_PX;
      gfx.fillStyle(COLOR_PENDING, GHOST_ALPHA);
      gfx.fillCircle(
        delta.pendingFoodMark.tileX * t + t / 2,
        delta.pendingFoodMark.tileY * t + t / 2,
        t / 2 - 2,
      );
    }
    // A queued MarkFoodPile that clears/re-directs the committed priority: draw-surface still
    // paints the OLD committed pile fully marked while paused, so tint a removal cue over it —
    // matching pendingRemovals / rallyCleared (COLOR_REMOVAL at GHOST_ALPHA).
    if (delta.foodMarkCleared !== null) {
      const t = TILE_SIZE_PX;
      gfx.fillStyle(COLOR_REMOVAL, GHOST_ALPHA);
      gfx.fillCircle(
        delta.foodMarkCleared.tileX * t + t / 2,
        delta.foodMarkCleared.tileY * t + t / 2,
        t / 2 - 2,
      );
    }
    // surface — pending entrance designations (plan §B12): a queued shaft glyph (inset square).
    for (const e of delta.pendingEntrances) {
      fillCellInset(gfx, e.tileX, e.tileY, COLOR_PENDING, GHOST_ALPHA);
    }
    // surface — pending rally marker: a FADED copy of the committed rally crosshair (Rob UAT — the
    // queued target should read as the same cross marker, just pending, not a blue dot). Mirrors
    // draw-surface's committed cross (horizontal + vertical bar + center accent) at GHOST_ALPHA.
    if (delta.pendingRally !== null) {
      const t = TILE_SIZE_PX;
      const wx = delta.pendingRally.tileX * t;
      const wy = delta.pendingRally.tileY * t;
      gfx.fillStyle(COLOR_RALLY_POINT, GHOST_ALPHA);
      gfx.fillRect(wx + 1, wy + 7, t - 2, 2); // horizontal bar
      gfx.fillRect(wx + 7, wy + 1, 2, t - 2); // vertical bar
      gfx.fillRect(wx + 6, wy + 6, 4, 4); // center accent
    }
    // A queued ClearRallyPoint: the committed white crosshair (draw-surface.ts) still sits
    // on this tile while paused, so tint a removal crosshair over it as the "pending removal"
    // cue — matching pendingRemovals / removedChambers (COLOR_REMOVAL at GHOST_ALPHA).
    if (delta.rallyCleared !== null) {
      const t = TILE_SIZE_PX;
      const wx = delta.rallyCleared.tileX * t;
      const wy = delta.rallyCleared.tileY * t;
      gfx.fillStyle(COLOR_REMOVAL, GHOST_ALPHA);
      gfx.fillRect(wx + 1, wy + 7, t - 2, 2); // horizontal bar
      gfx.fillRect(wx + 7, wy + 1, 2, t - 2); // vertical bar
      gfx.fillRect(wx + 6, wy + 6, 4, 4); // center accent
    }
  }
}

/**
 * Draw the aim-time feedforward tint for a hovered underground placement (chamber footprint
 * or tunnel tile). Surface dig-entrance feedforward stays on the existing entrance-hover path.
 */
export function drawFeedforwardTint(gfx: GfxLike, hovered: HoveredFeedforward | null): void {
  if (hovered === null) return;
  const color =
    hovered.outcome === 'valid'
      ? COLOR_VALID
      : hovered.outcome === 'invalid'
        ? COLOR_INVALID
        : COLOR_BLOCKED;
  if (hovered.chamberType !== null) {
    fillChamberShape(
      gfx,
      PLAYER_COLONY_ID,
      hovered.chamberType,
      hovered.tileX,
      hovered.tileY,
      hovered.width,
      hovered.height,
      color,
      TINT_ALPHA,
    );
  } else {
    const t = TILE_SIZE_PX;
    gfx.fillStyle(color, TINT_ALPHA);
    gfx.fillRect(hovered.tileX * t, hovered.tileY * t, hovered.width * t, hovered.height * t);
  }
}
