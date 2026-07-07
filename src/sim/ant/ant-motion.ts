// src/sim/ant/ant-motion.ts
// #212 Layer 0 (leaf): motion + geometry primitives shared by every ant behavior
// and the movement orchestrator. Depends only on sibling sim modules — NEVER on
// another ant/ sub-module — so it sits at the bottom of the acyclic ant graph.
//
// Holds: cardinal/diagonal stepping + packed-step codec, tile passability, surface
// detour, the descent gate, the queen-chamber geometry predicate, the direction
// lookup tables, and the per-call scratch buffers those primitives own.
import type { WorldState } from '../types.js';
import { SurfaceMovementEffect, surfaceMovementAt } from '../surface-features.js';
import type { AntComponents } from './ant-store.js';
import { isRecentTile } from './ant-store.js';
import type { ColonyRecord } from '../colony/colony-store.js';
import { AntTask, DiggingSubState, NursingSubState, ChamberType } from '../enums.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from '../constants.js';
import { getScratch } from '../scratch.js';
import { FP_SHIFT } from '../fixed.js';
import type { DigFlowFields } from '../dig-system.js';
import type { ChamberFlowFields } from '../chamber-flow.js';
import { Zone, ugGet, type UndergroundGrid } from '../terrain.js';
import { isUndergroundStateEnterable } from '../underground-occupancy.js';

// ---------------------------------------------------------------------------
// Direction tables for dig flow-field to dx/dy conversion
// Flow-field direction encoding: 0=N, 1=E, 2=S, 3=W
// ---------------------------------------------------------------------------
export const DIR_DX = [0, 1, 0, -1] as const; // N, E, S, W

export const DIR_DY = [-1, 0, 1, 0] as const; // N, E, S, W

// Issue #42 fix #3 — 8-connected alternate-step ordering, clockwise from N.
// Used by the surface SearchingFood no-revisit filter when the proposed step
// is in the recent-tiles buffer; iterating these in fixed order picks a
// deterministic alternate.
export const ALT_DX = [0, 1, 1, 1, 0, -1, -1, -1] as const; // N, NE, E, SE, S, SW, W, NW

export const ALT_DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const;

export interface CardinalStep {
  dx: number;
  dy: number;
}

/**
 * Issue #69 — return a primitive packed int instead of a shared scratch
 * struct. Pre-fix `pickCardinalStep` wrote into a module-level singleton
 * `cardinalStepScratch` and returned it. The shared mutable was safe for
 * current call paths (each consumer read dx/dy immediately before any
 * other call), but a latent footgun: a future refactor that calls
 * pickCardinalStep twice within the same expression would silently
 * corrupt the first caller's dx/dy.
 *
 * Output encoding:
 *   bits 0..1: dx + 1 (so dx ∈ {-1, 0, 1} maps to {0, 1, 2})
 *   bits 2..3: dy + 1
 * Decode helpers below: `unpackStepDx(p)` / `unpackStepDy(p)`.
 *
 * Returning a number sidesteps the scratch-aliasing problem entirely:
 * two consecutive calls produce two independent integer results.
 */
export function pickCardinalStep(
  ants: AntComponents,
  id: number,
  rawDx: number,
  rawDy: number,
  _simVersion?: number,
): number {
  void ants;
  void id;
  void _simVersion;
  const absDx = rawDx < 0 ? -rawDx : rawDx;
  const absDy = rawDy < 0 ? -rawDy : rawDy;
  if (absDx === 0 && absDy === 0) return packStep(0, 0);
  if (absDx === 0) return packStep(0, rawDy > 0 ? 1 : -1);
  if (absDy === 0) return packStep(rawDx > 0 ? 1 : -1, 0);

  // Both axes non-zero — 8-connected diagonal step.
  return packStep(rawDx > 0 ? 1 : -1, rawDy > 0 ? 1 : -1);
}

/** Encode a (dx, dy) cardinal step into a 4-bit int. dx, dy ∈ {-1, 0, 1}. */
export function packStep(dx: number, dy: number): number {
  return ((dy + 1) << 2) | (dx + 1);
}

/** Decode dx from a packStep result. */
export function unpackStepDx(packed: number): number {
  return (packed & 3) - 1;
}

/** Decode dy from a packStep result. */
export function unpackStepDy(packed: number): number {
  return ((packed >> 2) & 3) - 1;
}

/**
 * Module-level scratch for `diagonalizeFlowStep`'s `out` parameter.
 *
 * Issue #69 narrowed scope to `pickCardinalStep` (which now returns a
 * primitive). `diagonalizeFlowStep` retains a struct out-param because
 * it writes the cardinal as a fallback then conditionally upgrades to a
 * diagonal — encoding both axes' independent state cleanly into a single
 * int while preserving the in-place mutation contract is awkward.
 *
 * #231 — the `out` buffer now lives on the per-world scratch arena; each caller
 * passes getScratch(world).motion.cardinalStep as the `out` arg and reads dx/dy
 * immediately after (diagonalizeFlowStep's signature is unchanged).
 */

export function diagonalizeFlowStep(
  underground: UndergroundGrid,
  flowField: Int32Array,
  tileX: number,
  tileY: number,
  cardDx: number,
  cardDy: number,
  task: AntTask,
  _simVersion: number,
  out: CardinalStep,
): void {
  void _simVersion;
  out.dx = cardDx;
  out.dy = cardDy;
  const nextX = tileX + cardDx;
  const nextY = tileY + cardDy;
  if (nextX < 0 || nextX >= underground.width || nextY < 0 || nextY >= underground.height) return;
  const dirB = flowField[nextY * underground.width + nextX]!;
  if (dirB < 0 || dirB >= 4) return;
  const cardB_dx = DIR_DX[dirB]!;
  const cardB_dy = DIR_DY[dirB]!;
  // Perpendicular-only: one of (current, next) must vary X and the other Y.
  // Same-axis (parallel or anti-parallel) means no diagonal staircase to
  // collapse.
  if ((cardDx === 0) === (cardB_dx === 0)) return;
  const diagDx = cardDx + cardB_dx;
  const diagDy = cardDy + cardB_dy;
  // Destination tile passable.
  if (!canEnterUndergroundTile(underground, tileX + diagDx, tileY + diagDy, task)) return;
  // Corner-cut prevention: at least one intermediate tile must be passable.
  const passXOnly = canEnterUndergroundTile(underground, tileX + diagDx, tileY, task);
  const passYOnly = canEnterUndergroundTile(underground, tileX, tileY + diagDy, task);
  if (!passXOnly && !passYOnly) return;
  out.dx = diagDx;
  out.dy = diagDy;
}

/**
 * Compute movement direction for a non-forager ant based on task and context.
 * PURE — reads world state but MUST NOT mutate tiles, ant sub-state, or colony flags.
 * All dig-worker state transitions (Marked→BeingDug claim, BeingDug→Open open)
 * live in `tickDigExecution` and run at tick step 10 per accepted Phase 3 PRD §9a.
 *
 * Dig workers in MovingToTile: read flow-field direction, convert to dx/dy.
 *   Direction=-1 (ant is ON the Marked tile) → return {0,0} so the ant holds
 *   position until step 10 claims the tile next tick.
 * Dig workers in Excavating: return {0,0} (stationary while digging).
 * Nursing ants: read the nursing chamber flow-field (seeded from Queen+Nursery
 *   Open tiles). -1 (on chamber tile) → {0,0} so tickNurseActions can flip
 *   subTask=Feeding. -2 (no tunnel connection) → {0,0} as a deterministic
 *   failsafe. When no cache is supplied (legacy test harnesses) falls back to
 *   Manhattan steering.
 * Fighting ants: {0,0} here — rally steering lives in tickAntMovement so the
 *   fighter can consume ants.targetPosX/Y (written by updateFightAntTargets)
 *   with the same Manhattan step pattern as the priority-forager branch.
 * Idle ants: {0,0} (awaiting task assignment).
 *
 * @param world              WorldState (reads ants, colonies, undergroundGrids).
 * @param antId              Entity ID of the ant.
 * @param digFlowFields      Per-colony flow-field cache (dig targets).
 * @param chamberFlowFields  Optional per-colony chamber flow-field cache. When
 *                           provided, nurses consume the `nursing` field
 *                           instead of Manhattan steering.
 * @returns                  Direction vector {dx, dy}.
 */
export function getTaskDirection(
  world: WorldState,
  antId: number,
  digFlowFields: DigFlowFields,
  chamberFlowFields?: ChamberFlowFields,
): { dx: number; dy: number } {
  const ants = world.ants;
  const task = ants.task[antId]!;
  const subTask = ants.subTask[antId]!;

  if (task === AntTask.Digging) {
    if (subTask === DiggingSubState.Excavating) {
      // Stationary while digging — countdown happens in tickDigExecution at step 10
      return { dx: 0, dy: 0 };
    }

    // MovingToTile: read flow-field direction.
    // colonyId keys the dig flow-field (indexed by the digger's OWN colony —
    // diggers never cross grids); gridColonyId keys the underground grid the
    // ant currently occupies (Phase 09.1 Chunk 0). Today both values are
    // identical for every ant; Chunks 3+4 break that for Fighter invaders.
    const colonyId = ants.colonyId[antId]!;
    const gridColonyId = ants.currentGridColonyId[antId]!;
    const flowField = digFlowFields.fields[colonyId];
    if (!flowField) return { dx: 0, dy: 0 };

    const underground = world.undergroundGrids[gridColonyId];
    if (!underground) return { dx: 0, dy: 0 };

    const tileX = ants.posX[antId]! >> FP_SHIFT;
    const tileY = ants.posY[antId]! >> FP_SHIFT;
    const direction = flowField[tileY * underground.width + tileX];

    if (direction === undefined || direction === -1 || direction === -2) {
      // -1 = source (ant is ON Marked tile, claim happens in tickDigExecution)
      // -2 = unreachable
      return { dx: 0, dy: 0 };
    }

    return { dx: DIR_DX[direction]!, dy: DIR_DY[direction]! };
  }

  if (task === AntTask.Nursing) {
    // S4 V21+ Attending nurses are stationary at their Nursery tile.
    if (ants.subTask[antId] === NursingSubState.Attending) return { dx: 0, dy: 0 };
    // colonyId keys the nursing chamber flow-field (indexed by the nurse's
    // OWN colony — nurses never cross grids); gridColonyId keys the
    // underground grid the ant currently occupies (Phase 09.1 Chunk 0).
    // Today both values are identical for every ant.
    const colonyId = ants.colonyId[antId]!;
    const gridColonyId = ants.currentGridColonyId[antId]!;

    // Prefer the nursing flow-field. Seeded from Open tiles inside every
    // Queen/Nursery chamber footprint, so the nurse routes through tunnels
    // instead of straight-line stepping into Solid dirt on bends. See the
    // seed-920076605 debug snapshot: ant 19 at (14,16) targeted Nursery
    // (13,9) and straight-line steering picked (14,15) = Solid every tick.
    //
    // Issue #17 Phase 1 (v10+): a nurse currently carrying a brood routes
    // via the Nursery-only `nurseDeposit` field instead. Detection: subTask
    // === Feeding AND carryingBroodId set. The empty-handed pickup phase
    // (subTask = MovingToBrood) keeps using the `nursing` field, which v10
    // re-seeds to Queen tiles + uncarried-brood tiles outside Nursery.
    if (chamberFlowFields !== undefined) {
      const v10Carrying =
        ants.subTask[antId] === NursingSubState.Feeding && ants.carryingBroodId[antId] !== -1;
      const flowField = v10Carrying
        ? chamberFlowFields.nurseDeposit[colonyId]
        : chamberFlowFields.nursing[colonyId];
      const underground = world.undergroundGrids[gridColonyId];
      if (flowField && underground) {
        const tileX = ants.posX[antId]! >> FP_SHIFT;
        const tileY = ants.posY[antId]! >> FP_SHIFT;
        const dir = flowField[tileY * underground.width + tileX];
        if (dir === undefined) return { dx: 0, dy: 0 };
        if (dir === -1) {
          // On a Queen/Nursery chamber tile — hold. tickNurseActions flips
          // subTask to Feeding this same tick (it runs at step 16c after
          // tickAntMovement at step 16) and to Idle next tick.
          return { dx: 0, dy: 0 };
        }
        if (dir === -2) {
          // Unreachable. Failsafe: hold. Better than oscillating into dirt;
          // the debug trace reports 'nursing-chamber' so the stuck ant is
          // still visually attributable to the nursing path.
          return { dx: 0, dy: 0 };
        }
        return { dx: DIR_DX[dir]!, dy: DIR_DY[dir]! };
      }
      // flowField/grid absent — fall through to Manhattan legacy path.
    }

    // Legacy Manhattan path (test harnesses without chamberFlowFields).
    const colony = world.colonies[colonyId];
    if (!colony || colony.chambers.length === 0) return { dx: 0, dy: 0 };

    const antTileX = ants.posX[antId]! >> FP_SHIFT;
    const antTileY = ants.posY[antId]! >> FP_SHIFT;

    let bestDx = 0;
    let bestDy = 0;
    let bestDist = -1;
    let bestChamberTileX = -1;
    let bestChamberTileY = -1;

    for (let i = 0; i < colony.chambers.length; i++) {
      const chamber = colony.chambers[i]!;
      const ct = chamber.chamberType;
      if (ct !== (0 as typeof ChamberType.Queen) && ct !== (1 as typeof ChamberType.Nursery))
        continue;

      const chamberTileX = chamber.posX >> FP_SHIFT;
      const chamberTileY = chamber.posY >> FP_SHIFT;
      const dist = Math.abs(antTileX - chamberTileX) + Math.abs(antTileY - chamberTileY);

      if (bestDist < 0 || dist < bestDist) {
        bestDist = dist;
        bestChamberTileX = chamberTileX;
        bestChamberTileY = chamberTileY;
      }
    }

    // Compute the cardinal step once outside the loop (one step per tick
    // regardless of how many chambers were considered).
    if (bestDist >= 0) {
      const step = pickCardinalStep(
        ants,
        antId,
        bestChamberTileX - antTileX,
        bestChamberTileY - antTileY,
      );
      bestDx = unpackStepDx(step);
      bestDy = unpackStepDy(step);
    }

    return { dx: bestDx, dy: bestDy };
  }

  // Fighting, Idle, and anything else: stationary
  return { dx: 0, dy: 0 };
}

export function canEnterUndergroundTile(
  underground: UndergroundGrid,
  tileX: number,
  tileY: number,
  task: AntTask,
): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= underground.width || tileY >= underground.height) {
    return false;
  }
  return isUndergroundStateEnterable(ugGet(underground, tileX, tileY), task);
}

export function canEnterSurfaceTile(world: WorldState, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= SURFACE_GRID_WIDTH || tileY >= SURFACE_GRID_HEIGHT) {
    return false;
  }
  return surfaceMovementAt(world, tileX, tileY) !== SurfaceMovementEffect.HardBlock;
}

// 8 compass directions in N-clockwise order: N, NE, E, SE, S, SW, W, NW.
// Direction-agnostic — same set probed regardless of caller's intended
// direction. Order doubles as the deterministic tie-break: at equal
// Manhattan distance to target, earlier compass direction wins.
const PROBE_COMPASS_DX = [0, 1, 1, 1, 0, -1, -1, -1] as const;

const PROBE_COMPASS_DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const;

// #231 — pickSurfaceDetour's result object now lives on the per-world scratch
// arena (getScratch(world).motion.detourResult). Caller MUST consume the values
// immediately (the helper does NOT clone), invoked once per blocked-step per
// surface ant per tick (AGENTS.md hot-loop).

export function pickSurfaceDetour(
  world: WorldState,
  prevTileX: number,
  prevTileY: number,
  intendedDx: number,
  intendedDy: number,
  /**
   * Optional ant id. When provided (>= 0), the detour SKIPS any candidate
   * tile that's in this ant's recent-tiles ring buffer (`isRecentTile`).
   * Fixes the two-tile oscillation pattern observed in the 2026-05-02T15:10
   * stuck-ant UAT report: ant tries N (blocked by 4×4 boulder); per-axis
   * revert in the surface guard takes the W-only step → ant moves to the
   * tile west; next tick tries N again (still blocked), detour picks E
   * back to the original tile because E and W tied on Manhattan to the
   * blocked tile and compass tie-break favored E. With recent-tiles
   * consult, the candidate that would step back to the just-vacated tile
   * is filtered, breaking the cycle.
   *
   * Pass `-1` (or omit) to disable the recent-tiles filter — useful for
   * unit tests that don't have an ant-id context.
   */
  antId: number = -1,
): { dx: number; dy: number } {
  // Intended destination tile (where the ant wanted to be).
  const targetX = prevTileX + intendedDx;
  const targetY = prevTileY + intendedDy;

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = -1;
  // Recent-tile fallback (Codex P2 on PR #49 round 3): if every walkable
  // neighbor is in the recent-tiles buffer, returning (0, 0) holds the
  // ant in place. The recent buffer only advances on tile crossings, so
  // the buffer never ages out and the ant is permanently deadlocked in
  // one-way pockets around HardBlock features. Track the best RECENT
  // candidate separately and fall back to it when no fresh option
  // exists — backtracking is preferable to permanent stall.
  let bestRecentDx = 0;
  let bestRecentDy = 0;
  let bestRecentScore = -1;

  // Walk all 8 compass directions. Originally this used 8 probes derived
  // from `intendedDx/intendedDy` (cardinal X slip, perpendicular sidestep,
  // diagonal-away, etc.) which seemed natural — but Codex flagged P2 on
  // PR #49: when intendedDx OR intendedDy is zero (cardinal blocked
  // step), the "diagonal-away" probes collapsed into duplicate cardinal
  // moves and the picker never considered ANY actual diagonal escape.
  // Concrete: intent (1, 0) east-blocked → probes generated (1, 0),
  // (0, 0), (0, 1), (0, -1), (-1, 0), (0, 0), (-1, 0), (1, 0) —
  // 4 collapsed and the only "off-axis" candidates were the cardinal
  // sidesteps; no NE/NW/SE/SW probe at all. Result: the ant could pick
  // a reverse-cardinal step even when a legal diagonal escape was
  // closer to its target → avoidable jitter/stalling around corners.
  //
  // Fix: probe all 8 compass directions unconditionally and score each
  // by Manhattan distance to the intended-destination tile. The probe
  // order N→NE→E→SE→S→SW→W→NW doubles as the deterministic tie-break.
  for (let p = 0; p < 8; p++) {
    const pdx = PROBE_COMPASS_DX[p]!;
    const pdy = PROBE_COMPASS_DY[p]!;
    const cx = prevTileX + pdx;
    const cy = prevTileY + pdy;
    if (!canEnterSurfaceTile(world, cx, cy)) continue;
    // Diagonal corner-cut prevention. For diagonal candidates, require
    // at least one of the two intermediate cardinal tiles to be walkable.
    // Otherwise the ant would squeeze through a HardBlock corner between
    // two boulders/leaves — same failure mode the underground guard
    // explicitly prevents (see the diagonal block in tickAntMovement and
    // moveQueens).
    if (pdx !== 0 && pdy !== 0) {
      const passXOnly = canEnterSurfaceTile(world, prevTileX + pdx, prevTileY);
      const passYOnly = canEnterSurfaceTile(world, prevTileX, prevTileY + pdy);
      if (!passXOnly && !passYOnly) continue;
    }
    let score = Math.abs(cx - targetX) + Math.abs(cy - targetY);
    // Issue #63 (v11+) — pocket-escape penalty. Pre-v11 the score above
    // is purely Manhattan distance to target, which deadlocks ants in
    // pockets formed by clusters of multi-tile HardBlocks (4×4 boulders,
    // 6×3 twigs, 3×4 BigLeaves): every candidate inside the pocket has a
    // similar Manhattan score, the picker locks onto one, and the post-
    // step guard's 1-tile detour can't see far enough to escape. Add a
    // 2-tile lookahead: penalize candidates whose onward step is blocked
    // by HardBlock features that themselves continue beyond — a real
    // pocket is at least 2 deep in the same direction. Pre-v11 keeps the
    // pure-Manhattan score for replay byte-identity (SCEN-06).
    //
    // Edge-cases handled to avoid false positives:
    //   - OOB (world boundary) ahead is NOT a pocket — boundaries are
    //     a normal terminus, not a HardBlock cluster. Skip the penalty.
    //   - Single-tile dead-ends (ahead blocked, ahead2 walkable or OOB)
    //     are not "pockets"; the post-step guard's existing handling
    //     escapes them in one detour cycle. Don't penalize.
    const aheadX = cx + pdx;
    const aheadY = cy + pdy;
    const aheadInBounds =
      aheadX >= 0 && aheadY >= 0 && aheadX < SURFACE_GRID_WIDTH && aheadY < SURFACE_GRID_HEIGHT;
    // Only penalize when (ahead in-bounds AND blocked) AND (ahead2 in-bounds AND blocked).
    // This isolates the multi-tile-feature pocket case from OOB + shallow dead-ends.
    if (aheadInBounds && !canEnterSurfaceTile(world, aheadX, aheadY)) {
      const ahead2X = aheadX + pdx;
      const ahead2Y = aheadY + pdy;
      const ahead2InBounds =
        ahead2X >= 0 &&
        ahead2Y >= 0 &&
        ahead2X < SURFACE_GRID_WIDTH &&
        ahead2Y < SURFACE_GRID_HEIGHT;
      if (ahead2InBounds && !canEnterSurfaceTile(world, ahead2X, ahead2Y)) {
        // Real pocket: dominate Manhattan differences in this 128x128 grid.
        score += 1000;
      }
    }
    // Recent-tiles preference (not a hard filter): a Foraging ant whose
    // direct path is blocked otherwise oscillates between the blocked
    // tile and a sideways alternate every other tick. We prefer fresh
    // tiles, but tracking the best recent candidate ensures we always
    // have a fallback step if no fresh option exists. See the docstring
    // for the antId param above and the recent-tiles ring buffer in
    // `pushRecentTile`.
    const isRecent = antId >= 0 && isRecentTile(world.ants, antId, cx, cy);
    if (isRecent) {
      if (bestRecentScore < 0 || score < bestRecentScore) {
        bestRecentDx = pdx;
        bestRecentDy = pdy;
        bestRecentScore = score;
      }
      continue;
    }
    if (bestScore < 0 || score < bestScore) {
      bestDx = pdx;
      bestDy = pdy;
      bestScore = score;
    }
  }
  // Recent-tile fallback (v8+): only used when no fresh candidate was
  // found. Backtracking through the recent buffer breaks deadlock
  // pockets at the cost of one revisited tile — that revisit pushes a
  // NEW entry into the ring buffer (via the caller's pushRecentTile),
  // eventually rotating the original blocker out and re-enabling
  // forward progress. Pre-v8 keeps the original "(0, 0) hold on
  // exhaustion" behaviour for byte-identical replay (SCEN-06).
  if (bestScore < 0 && bestRecentScore >= 0) {
    bestDx = bestRecentDx;
    bestDy = bestRecentDy;
  }
  const detour = getScratch(world).motion.detourResult;
  detour.dx = bestDx;
  detour.dy = bestDy;
  return detour;
}

/**
 * True if tile (tileX, tileY) lies inside any completed Queen chamber
 * footprint in `colony`. Inclusive of the anchor tile; exclusive of tiles at
 * anchor + dims boundary (the footprint is [anchor, anchor + dims)).
 */
export function isInsideQueenChamber(colony: ColonyRecord, tileX: number, tileY: number): boolean {
  for (let c = 0; c < colony.chambers.length; c++) {
    const ch = colony.chambers[c]!;
    if (ch.chamberType !== ChamberType.Queen) continue;
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    if (tileX >= bx && tileX < bx + ch.width && tileY >= by && tileY < by + ch.height) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pre-descent gate (#164, #165)
//
// Descent (Surface → Underground) is a zone transition performed during step-16
// movement, which runs BEFORE step-17 combat and step-17.5 spider. Without a
// gate, an ant standing on an entrance slips underground in the same tick a
// surface blocker should have stopped or fought it — combat never sees the
// encounter. This holds the ant on the entrance's surface tile so the relevant
// combat pass resolves it this tick. Reads only existing WorldState; no RNG,
// no serialized scratch.
// ---------------------------------------------------------------------------
export function isDescentBlocked(
  world: WorldState,
  task: AntTask,
  isOwnEntrance: boolean,
  entranceColony: ColonyRecord,
  entranceTileX: number,
  entranceTileY: number,
): boolean {
  const ants = world.ants;

  // #165 — spider blockade. A Rampaging spider parked on the entrance tile is the
  // blockade footprint; hold every descender on the surface so step-17.5 spider
  // combat (which only scans the spider's own tile) catches it instead of letting
  // carriers slip through the zone transition. Applies to any ant. Only Rampaging
  // camps an entrance (both V22 and V23); a sated V23 spider meandering over an
  // entrance must NOT trap descenders, so the narrow state check is intentional.
  const spider = world.spider;
  if (spider !== null && spider.state === 'Rampaging') {
    const sx = spider.posX >> FP_SHIFT;
    const sy = spider.posY >> FP_SHIFT;
    if (sx === entranceTileX && sy === entranceTileY) {
      return true;
    }
  }

  // #164 — foreign fighter vs. a surface queen on the entrance tile. In the
  // pre-Queen-chamber opening state the queen sits on her colony's start tile,
  // which is also the starting entrance. An invading Fighter must engage her on
  // the surface (step-17 ant combat buckets both on the shared surface tile)
  // rather than descend past her unharmed.
  if (!isOwnEntrance && task === AntTask.Fighting) {
    const queenId = entranceColony.queenEntityId;
    if (
      queenId >= 0 &&
      ants.alive[queenId] === 1 &&
      ants.zone[queenId] === Zone.Surface &&
      ants.posX[queenId]! >> FP_SHIFT === entranceTileX &&
      ants.posY[queenId]! >> FP_SHIFT === entranceTileY
    ) {
      return true;
    }
  }

  return false;
}
