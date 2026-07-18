// pheromone-system.ts — PRD §5b/§5c/§5d pheromone deposit, decay, and gradient sampling
//
// Implements the surviving core pheromone operations (#242 deleted two dead
// exports, depositDanger and sampleGradient — see the DangerTrail note below):
//   depositFoodTrail        — PRD §5b: accumulate food-trail strength at a cell, clamped at PHEROMONE_CAP
//   tickPheromoneDecay      — PRD §5c: O(grid.data.length) sweep; floor-snap prevents zombie trails (PHER-04/PHER-07)
//   sampleForagingDirection — 09 memo: pheromone-first reacquisition sampler for SearchingFood foragers
//
// DangerTrail note (#242, updated for A1 / simVersion V36): deposits come from
// spider.ts seedDangerPheromone (inline, spider-calibrated magnitudes) and the
// V34 cross-colony kill alarm (combat.ts). Since A1, the surface DangerTrail grid
// IS read for routing: sampleForagingDirection (via the penalizedStrength helper
// below), hasNearbyPheromoneSignal, and chooseExcursionDirection penalize/steer
// candidate steps by their danger. Gated at the call sites so pre-V36 replays
// never consult it (dangerGrid === undefined = byte-identical legacy path). The
// penalty is fixed-point (Math.imul >> FP_SHIFT) and consumes NO additional RNG.
//
// MUST NOT use: Math.floor, Math.round, division (/), Date, performance, setTimeout, Math.random.
// All fixed-point operations use >>  and Math.imul.
// Rng is passed explicitly — no module-level singleton (PRD §4 / ARCH principle 4).

import type { PheromoneGrid } from './pheromone-store.js';
import { phGet, phSet } from './pheromone-store.js';
import { Rng } from '../rng.js';
import { FP_SHIFT } from '../fixed.js';
import {
  FOOD_TRAIL_DEPOSIT,
  PHEROMONE_CAP,
  PHEROMONE_FLOOR,
  EXPLORE_RATE_PERCENT,
  DANGER_ROUTE_WEIGHT_FP,
  DANGER_ROUTE_AVOID_THRESHOLD,
} from '../constants.js';
// PHEROMONE_FLOOR is the default floor used in tickPheromoneDecay's signature.
// Callers may pass PHEROMONE_FLOOR_V14 for V14+ food-trail grids.

// ---------------------------------------------------------------------------
// Direction table — fixed order: up, down, left, right (PRD §5d)
// ---------------------------------------------------------------------------

const DIRS = [
  { dx: 0, dy: -1 }, // up
  { dx: 0, dy: 1 }, // down
  { dx: -1, dy: 0 }, // left
  { dx: 1, dy: 0 }, // right
] as const;

// ---------------------------------------------------------------------------
// depositFoodTrail — PRD §5b verbatim
// ---------------------------------------------------------------------------

/**
 * Accumulate food-trail pheromone at (tileX, tileY), clamped to PHEROMONE_CAP.
 *
 * Carry-only rule (PHER-03): callers MUST only invoke this for food-carrying
 * foragers. The function itself does NOT check carry state — enforcement is at
 * call sites.
 *
 * Coordinates are already tile integers (posX >> FP_SHIFT at the call site).
 * Out-of-bounds coordinates are silently ignored (phSet is a no-op out of bounds).
 *
 * @param depositAmount  Amount to add per call. Defaults to FOOD_TRAIL_DEPOSIT
 *   (legacy / V13 value = 512). Pass FOOD_TRAIL_DEPOSIT_V14 (1024) for V14+
 *   worlds — the caller (tickPheromoneDeposit) applies the version gate.
 */
export function depositFoodTrail(
  grid: PheromoneGrid,
  tileX: number,
  tileY: number,
  depositAmount: number = FOOD_TRAIL_DEPOSIT,
): void {
  const current = phGet(grid, tileX, tileY);
  const sum = current + depositAmount;
  phSet(grid, tileX, tileY, sum > PHEROMONE_CAP ? PHEROMONE_CAP : sum);
}

// ---------------------------------------------------------------------------
// tickPheromoneDecay — PRD §5c verbatim (PHER-04, PHER-07)
// ---------------------------------------------------------------------------

/**
 * Sweep every cell in `grid.data`, applying fractional decay.
 *
 * Per-cell operation (PRD §5c):
 *   decayed = s - ((s * decayFp) >> FP_SHIFT)
 *   if decayed < floor → snap to 0 (prevents zombie trails; PRD §5c normative)
 *
 * PHER-07 invariant: cost is O(grid.data.length) — independent of ant count.
 * The early continue on s === 0 is a mandatory fast path (PRD §5c).
 *
 * ESLint compliance: s * decayFp is multiplication (not division); >> FP_SHIFT
 * is a signed right-shift that correctly truncates to integer for positive s.
 * No Math.floor, no division operator, no allocation inside the loop.
 *
 * @param grid     The pheromone grid to decay in-place.
 * @param decayFp  Fixed-point decay rate (e.g., PHEROMONE_DECAY_FP = 5 means
 *                 ~1.95% decay per tick: 5/256 ≈ 0.0195).
 * @param floor    Minimum value before snap-to-zero. Defaults to
 *                 PHEROMONE_FLOOR (64). Pass PHEROMONE_FLOOR_V14 (128) for
 *                 V14+ food-trail grids to prevent the integer-arithmetic
 *                 stall that occurs when decayFp=2 and s < 128.
 */
export function tickPheromoneDecay(
  grid: PheromoneGrid,
  decayFp: number,
  floor: number = PHEROMONE_FLOOR,
): void {
  const data = grid.data;
  const len = data.length;
  for (let i = 0; i < len; i++) {
    const s = data[i]!;
    if (s === 0) continue;
    const decayed = s - ((s * decayFp) >> FP_SHIFT);
    data[i] = decayed < floor ? 0 : decayed;
  }
}

// ---------------------------------------------------------------------------
// sampleForagingDirection — 09 pheromone-reacquisition memo
// ---------------------------------------------------------------------------
//
// A pheromone-first refinement of the plain 4-neighbor explore/exploit sampler
// this module used to export, for SearchingFood foragers.
// Three behavior layers:
//
//   1. Strong local trail (max 4-neighbor ≥ TRAIL_STRONG_THRESHOLD):
//      always exploit, never consume the 10% random-explore roll. Once a
//      route is established and reinforced, foragers commit to it rather than
//      discarding it on coin flips. As the trail fades (decay is 2%/tick,
//      single deposit 512 → threshold 128 in ~70 ticks), the branch drops
//      out and exploration resumes naturally — no permanent route lock.
//
//   2. Weak local trail (0 < max 4-neighbor < TRAIL_STRONG_THRESHOLD):
//      current behavior — 10% random explore / 90% exploit. Preserves the
//      search-and-verify behavior for marginal or decaying trails.
//
//   3. No immediate trail (max 4-neighbor === 0):
//      widen the scan to REACQUIRE_RADIUS Manhattan tiles. If any cell in
//      that diamond has pheromone, step toward the strongest one (ties →
//      closer tile → fixed scan order). This is the reacquisition lever —
//      a forager that drifts 2–3 tiles off a trail no longer has to wander
//      randomly until it happens to stumble back onto it.
//
// RNG consumption:
//   - Layer 1: 0 calls.
//   - Layer 2: 1 call (nextInt(100)); explore branch adds 1 more (nextInt(4)).
//   - Layer 3: 0 calls.
//   - Empty fallback: 0 calls.
// Variable consumption is deterministic given (grid, tileX, tileY) — no
// external state. The ant-system call site preserves its own RNG stream.
//
// Future compatibility (memo §"Future Compatibility"): the thresholds read
// live pheromone values; once food is exhausted and trails decay under
// PHEROMONE_FLOOR snap, cells clear to 0 and layer 3 shrinks to empty →
// layer 4 (wander) takes over. No permanent memory, no lock.
// ---------------------------------------------------------------------------

/**
 * Pheromone strength at which a single 4-neighbor cell counts as a "strong"
 * trail worth following without random-explore interference. Under V13 constants
 * (FOOD_TRAIL_DEPOSIT=512, decayFp=5), 128 corresponds to ~70 ticks of decay.
 * Under V14 constants (FOOD_TRAIL_DEPOSIT_V14=1024, PHEROMONE_DECAY_FP_V14=2),
 * a single 1024-unit deposit decays to 128 in ~260 ticks — the strong-trail
 * window is ~3.7× longer, suppressing random exploration for more ticks before
 * a route fades. This is intentional under V14: active routes stay exploited
 * while any carrier is walking them. Below this threshold, the trail is fading
 * and exploration resumes its 10% share.
 */
const TRAIL_STRONG_THRESHOLD = 128;

/**
 * Manhattan radius scanned for trail reacquisition when no immediate-neighbor
 * trail exists. Chosen small enough to keep the scan cheap (24 cells at r=3)
 * and to stay "local" per the memo's "local information driving decisions"
 * principle. Larger radii would start to feel like memory.
 */
const REACQUIRE_RADIUS = 3;

/**
 * A1 (V36) — apply the DangerTrail penalty to a candidate cell's FoodTrail
 * strength: `net = food − (Math.imul(danger, DANGER_ROUTE_WEIGHT_FP) >> FP_SHIFT)`,
 * clamped ≥ 0. When `dangerGrid` is undefined (pre-V36; gated at the call site)
 * or the food strength is already 0, the raw strength is returned unchanged — the
 * byte-identical legacy path. `Math.imul` per this module's fixed-point rule.
 */
function penalizedStrength(
  foodStrength: number,
  dangerGrid: PheromoneGrid | undefined,
  x: number,
  y: number,
): number {
  if (dangerGrid === undefined || foodStrength <= 0) return foodStrength;
  const penalty = Math.imul(phGet(dangerGrid, x, y), DANGER_ROUTE_WEIGHT_FP) >> FP_SHIFT;
  const net = foodStrength - penalty;
  return net > 0 ? net : 0;
}

/**
 * Return the direction a SearchingFood forager should move based on the
 * pheromone gradient at (tileX, tileY), with stronger trail commitment and
 * wider reacquisition than a plain 4-neighbor sample.
 *
 * Returns {0, 0} when no pheromone is within REACQUIRE_RADIUS — callers fall
 * through to the wander-fallback branch.
 *
 * 09 excursion-foraging follow-up (issue 1): anti-backtrack. When
 * prevTileX/Y identifies the tile the ant was on last tick, that tile and
 * the REACQUIRE-radius pick that would step toward it are filtered out of
 * the candidate set. If the only pheromone signal lives on the prev tile,
 * the function returns {0,0} so the caller falls through to wander —
 * breaking the ABAB scalar-gradient loop that otherwise forms once a few
 * carriers pin two adjacent cells at PHEROMONE_CAP.
 *
 * Pass prevTileX = prevTileY = -1 when the ant has no prior tile (fresh
 * promotion / post-pickup / entrance-return) to retain the original
 * non-anti-backtracked behavior.
 *
 * @param grid        Pheromone grid to read neighbor strengths from.
 * @param tileX       Tile X of the forager (integer).
 * @param tileY       Tile Y of the forager (integer).
 * @param rng         Deterministic world Rng.
 * @param prevTileX   Tile X the ant occupied last tick (-1 = none).
 * @param prevTileY   Tile Y the ant occupied last tick (-1 = none).
 * @param dangerGrid  Optional surface DangerTrail grid (A1 / V36). When provided,
 *   each candidate cell's FoodTrail strength is penalized by its danger
 *   (`net = food − (Math.imul(danger, DANGER_ROUTE_WEIGHT_FP) >> FP_SHIFT)`,
 *   clamped ≥ 0), so foragers prefer safer routes — a SOFT bias, not a wall.
 *   `undefined` (pre-V36, gated at the call site) = byte-identical legacy
 *   behaviour. `hasNearbyPheromoneSignal` MUST be passed the same grid so its
 *   "true ⇒ non-zero pick" invariant still holds under the penalty.
 */
export function sampleForagingDirection(
  grid: PheromoneGrid,
  tileX: number,
  tileY: number,
  rng: Rng,
  prevTileX: number = -1,
  prevTileY: number = -1,
  dangerGrid?: PheromoneGrid,
): { dx: number; dy: number } {
  const hasPrev = prevTileX >= 0 && prevTileY >= 0;

  // Layer 1 / 2: immediate-neighbor scan (DIRS order: up, down, left, right).
  // Track the best non-prev and best-prev candidates separately so we can
  // prefer a non-prev direction whenever one has any pheromone, and fall
  // back to prev only when there's literally nothing else.
  let bestStrength = 0;
  let bestDx = 0;
  let bestDy = 0;
  let prevNeighborStrength = 0;
  for (let d = 0; d < 4; d++) {
    const dir = DIRS[d]!;
    const nx = tileX + dir.dx;
    const ny = tileY + dir.dy;
    const s = penalizedStrength(phGet(grid, nx, ny), dangerGrid, nx, ny);
    if (hasPrev && nx === prevTileX && ny === prevTileY) {
      if (s > prevNeighborStrength) prevNeighborStrength = s;
      continue;
    }
    if (s > bestStrength) {
      bestStrength = s;
      bestDx = dir.dx;
      bestDy = dir.dy;
    }
  }

  // Layer 1 — strong non-prev trail: exploit, no random roll.
  if (bestStrength >= TRAIL_STRONG_THRESHOLD) {
    return { dx: bestDx, dy: bestDy };
  }

  // Layer 2 — weak non-prev trail: 10% explore / 90% exploit.
  if (bestStrength > 0) {
    if (rng.nextInt(100) < EXPLORE_RATE_PERCENT) {
      const idx = rng.nextInt(4);
      const dir = DIRS[idx]!;
      return { dx: dir.dx, dy: dir.dy };
    }
    return { dx: bestDx, dy: bestDy };
  }

  // Immediate-neighbor set had nothing usable once prev was filtered. Fall
  // through to Layer 3 — the widened reacquire scan (also with prev filter).
  // `prevNeighborStrength` is read only for determinism audits and debug
  // tools; no behavior depends on it past this point.
  void prevNeighborStrength;

  // Layer 3 — no immediate trail: widen scan to REACQUIRE_RADIUS Manhattan.
  // Scan order: top-to-bottom, left-to-right for deterministic tie-break.
  // Prev tile is skipped (by exact coord) AND cells whose major-axis step
  // from the ant would land on prev are skipped — routing through the
  // just-vacated tile would reintroduce the backtrack the scalar filter
  // just prevented.
  let reStrength = 0;
  let reDist = REACQUIRE_RADIUS + 1;
  let reDx = 0;
  let reDy = 0;
  for (let dy = -REACQUIRE_RADIUS; dy <= REACQUIRE_RADIUS; dy++) {
    const absY = dy < 0 ? -dy : dy;
    const xRange = REACQUIRE_RADIUS - absY;
    for (let dx = -xRange; dx <= xRange; dx++) {
      const absX = dx < 0 ? -dx : dx;
      const dist = absX + absY;
      if (dist <= 1) continue; // immediate neighbors already handled.
      const sx = tileX + dx;
      const sy = tileY + dy;
      if (hasPrev && sx === prevTileX && sy === prevTileY) continue;
      // Major-axis step from (tileX,tileY) toward (sx,sy). If that step
      // lands on prev, the cell is effectively on the prev-side of the
      // diamond and following it would reverse — skip and let the symmetric
      // non-prev cell (or a lateral cell) win the tie-break.
      if (hasPrev) {
        const stepX = absX >= absY ? (dx > 0 ? 1 : dx < 0 ? -1 : 0) : 0;
        const stepY = absX >= absY ? 0 : dy > 0 ? 1 : dy < 0 ? -1 : 0;
        if (tileX + stepX === prevTileX && tileY + stepY === prevTileY) continue;
      }
      const raw = phGet(grid, sx, sy);
      if (raw === 0) continue;
      const s = penalizedStrength(raw, dangerGrid, sx, sy);
      if (s === 0) continue;
      if (s > reStrength || (s === reStrength && dist < reDist)) {
        reStrength = s;
        reDist = dist;
        reDx = dx;
        reDy = dy;
      }
    }
  }

  if (reStrength > 0) {
    const absX = reDx < 0 ? -reDx : reDx;
    const absY = reDy < 0 ? -reDy : reDy;
    const sdx = absX >= absY ? (reDx > 0 ? 1 : -1) : 0;
    const sdy = absX >= absY ? 0 : reDy > 0 ? 1 : -1;
    // A1 (V36): the reacquire TARGET cell was danger-penalized, but the actual
    // first step toward it can be a different, dangerous tile. Don't step into a
    // spider-wake tile to chase a remote trail — fall through to wander (which is
    // danger-steered) instead (Codex). undefined dangerGrid = the legacy step.
    if (
      dangerGrid !== undefined &&
      phGet(dangerGrid, tileX + sdx, tileY + sdy) >= DANGER_ROUTE_AVOID_THRESHOLD
    ) {
      return { dx: 0, dy: 0 };
    }
    return { dx: sdx, dy: sdy };
  }

  // No trail within REACQUIRE_RADIUS — caller falls through to wander.
  return { dx: 0, dy: 0 };
}
