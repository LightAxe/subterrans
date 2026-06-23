// ant-facing-cache.ts — render-only smoothing for ant sprite rotation.
//
// Background: the sim paths ants on a 4-connected cardinal grid. A diagonal
// trajectory becomes an alternating right/down (or up/left, etc.) sequence,
// one tile per tick. Rotation derived directly from the latest prev→curr
// delta therefore flips ~every tick between horizontal and vertical, which
// reads as rapid head-flicker.
//
// This module blends recent deltas into a low-pass-filtered heading vector
// per ant id so an east-then-south zig-zag relaxes toward a stable southeast
// facing. Render-only: it never mutates sim state, never participates in
// saves, and lives entirely in the render layer. GameScene owns a single
// instance and hands it to drawSurface / drawUnderground each frame.
//
// Cache entries are evicted on zone change, spawn, and death — detected via
// the `useInterp` flag the draw modules already compute. That flag is false
// whenever prev→curr interpolation isn't valid (zone mismatch or the slot
// wasn't alive in prev), which covers all three cases in one condition.

/**
 * Low-pass blend ratio. Each sample is `prior * SMOOTHING_PREV + new *
 * SMOOTHING_NEW`. 0.65 / 0.35 lets a two-tick zig-zag pair ([1,0],[0,1])
 * land on a heading whose x and y magnitudes sit well inside the diagonal
 * band while still reacting fast enough that a genuine direction change
 * (e.g. reversing course) converges within a few frames.
 */
const SMOOTHING_PREV = 0.65;
const SMOOTHING_NEW = 0.35;

/** Pixel-space delta threshold below which we treat motion as "no signal". */
const DELTA_EPSILON = 0.01;

/** Minimum blended heading magnitude to emit a rotation from. */
const HEADING_EPSILON = 0.001;

/**
 * Reserved facing-cache key for the singleton surface spider. The cache is keyed
 * by entity id, and ant ids are non-negative array indices, so a negative id can
 * never collide with one. The spider reuses the exact same smoothing — its sprite,
 * like the ants', has its head on -x — it just needs one stable key of its own.
 */
export const SPIDER_FACING_ID = -1;

export interface AntFacingSample {
  id: number;
  /** Current zone (0 = surface, 1 = underground). Used for stale-zone eviction. */
  zone: number;
  /**
   * Pixel-space curr - prev delta. Renderer computes this already; we reuse
   * the same number so the facing vector is in the same units the sprite is
   * moving in. (Fixed-point → pixel conversion happens upstream.)
   */
  dx: number;
  dy: number;
  /**
   * True iff prev→curr interpolation is valid: alive in prev AND same zone.
   * When false the prev delta represents either a spawn frame or a zone flip —
   * either way the delta is meaningless and any cached heading is stale.
   */
  useInterp: boolean;
}

interface HeadingEntry {
  zone: number;
  hx: number;
  hy: number;
  /** Last rotation we emitted. Kept so stationary ants reuse the prior pose. */
  rotation: number;
}

export class AntFacingCache {
  private readonly entries = new Map<number, HeadingEntry>();

  /**
   * Smoothed rotation (radians) for the given ant sample. SVG convention:
   * head natively on -x, so a heading vector (hx, hy) maps to
   * `Math.atan2(-hy, -hx)` (same math the pre-smoothing renderer used).
   *
   * Behavior contract:
   * - useInterp=false  → evict stale entry, return 0. (Spawn / zone flip /
   *                       post-death reuse all land here. The draw module
   *                       already snaps position to curr in this case.)
   * - No prior entry   → seed from the current delta (if any) and return the
   *                       raw atan2 rotation. Matches the pre-smoothing first
   *                       observation so preserved tests continue to pass.
   * - Prior + motion   → low-pass blend hx/hy toward the new delta.
   * - Prior + still    → keep prior heading untouched; reuse last rotation so
   *                       a stationary ant holds its pose instead of snapping
   *                       back to the default when delta happens to be zero.
   */
  sample(s: AntFacingSample): number {
    if (!s.useInterp) {
      this.entries.delete(s.id);
      return 0;
    }

    const prior = this.entries.get(s.id);
    const meaningful = Math.abs(s.dx) + Math.abs(s.dy) >= DELTA_EPSILON;

    if (prior === undefined || prior.zone !== s.zone) {
      if (!meaningful) return 0;
      const rotation = Math.atan2(-s.dy, -s.dx);
      this.entries.set(s.id, {
        zone: s.zone,
        hx: s.dx,
        hy: s.dy,
        rotation,
      });
      return rotation;
    }

    if (!meaningful) {
      return prior.rotation;
    }

    prior.hx = prior.hx * SMOOTHING_PREV + s.dx * SMOOTHING_NEW;
    prior.hy = prior.hy * SMOOTHING_PREV + s.dy * SMOOTHING_NEW;

    if (Math.abs(prior.hx) + Math.abs(prior.hy) < HEADING_EPSILON) {
      return prior.rotation;
    }

    prior.rotation = Math.atan2(-prior.hy, -prior.hx);
    return prior.rotation;
  }

  /** Drop every cached heading. Called by GameScene on boot / restart. */
  reset(): void {
    this.entries.clear();
  }

  /** Test accessor: how many ants we currently hold heading state for. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Derive sprite rotation for one ant sample. Centralised here so draw-surface
 * and draw-underground share identical fallback + smoothing semantics.
 *
 * If `facing` is omitted (early tests that don't care about smoothing) the
 * rotation is the raw atan2 of the pixel delta — the pre-smoothing behavior.
 * GameScene always passes a cache, so production rendering always smooths.
 */
export function computeAntRotation(
  facing: AntFacingCache | undefined,
  id: number,
  zone: number,
  dx: number,
  dy: number,
  useInterp: boolean,
): number {
  if (facing !== undefined) {
    return facing.sample({ id, zone, dx, dy, useInterp });
  }
  if (!useInterp || Math.abs(dx) + Math.abs(dy) < DELTA_EPSILON) return 0;
  return Math.atan2(-dy, -dx);
}
