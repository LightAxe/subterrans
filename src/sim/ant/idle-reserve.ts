// idle-reserve.ts — #209 PR A (V34) step 15b: surface idle reserve + flee.
//
// Runs after pheromone decay (step 15) and before tickAntMovement (step 16). It
// owns ALL flee-state and idle-mill TARGET writes; the actual movement (dash to
// entrance, descent, shelter hold, mill amble) is executed by the V34 branch in
// ant-movement.ts / ant-motion.ts, which reads `ants.fleeShelterUntilTick` and
// `ants.targetPosX/Y`. Keeping every decision here (and out of the movement
// dispatch) is why the flee state machine stays legible and testable.
//
// #373 (V65): the shelter retreat (its section at the end of this file) is read
// by step 16 too.
//
// #377 (V68): the rampage shelter — while the spider on a rampage threatens their
// colony (rampageThreatens), idle workers go in (pickRampageShelterEntrance; step
// 16 walks them there by path, rampageShelterDashRoutes) and stay in; step 10a
// reads rampageThreatens to keep them recruitable.
//
// One hook runs INSIDE step 16 rather than at 15b: holdAlarmedCivilianAtShaft
// (C1, V42), which movement's ascent calls so the colony alarm can keep a
// civilian from climbing out. It writes the same flee column this pass owns, so
// the decision lives here with the rest of the alarm and shelter logic.
//
// The V38 doorstep push-through and local-all-clear release (#297) run inside
// the per-worker loop. Reads are grid-guarded — a bare/test world with no
// DangerTrail grid sees danger = 0 everywhere (no flee, plain milling).
//
// Determinism: flee/mill decisions are pure functions of the serialized
// pheromone grids, ant positions, and `fleeShelterUntilTick` (from V68 also the
// spider's saved state, world.tick and world.difficulty, and the surface goal
// fields, a cache derived from the saved terrain). The mill wander is a hash of
// (tick-bucket ^ antId) — no world.rngState draw.

import {
  SIM_VERSION_V55_ROUTED_HOMING,
  SIM_VERSION_V65_ALARM_INVASION,
  SIM_VERSION_V68_RAMPAGE_SHELTER,
  type WorldState,
} from '../types.js';
import { spiderOnRampage } from '../spider.js';
import {
  SURFACE_GOAL_UNREACHED,
  stepTowardReachable,
  surfaceGoalDistance,
} from '../surface-routing.js';
import { isInChamberFootprint, type ColonyId, type ColonyRecord } from '../colony/colony-store.js';
import { getScratch, type NestRetreatField } from '../scratch.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { phGet, pheromoneGridKey, type PheromoneGrid } from '../pheromone/pheromone-store.js';
import { pickOpenEntranceAtColumn, type NestEntrance } from '../colony/entrance.js';
import { UndergroundTileState, Zone, type UndergroundGrid } from '../terrain.js';
import { hash32 } from '../hash.js';
import { antIsAtHome } from '../hunger.js';
import {
  FLEE_THRESHOLD,
  SHELTER_COOLDOWN_TICKS,
  IDLE_MILL_RADIUS,
  IDLE_MILL_RETARGET_SHIFT,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  SPIDER_SCATTER_RADIUS_TILES,
  FLEE_HOMEBOUND_PUSH_THROUGH_TILES,
  SPIDER_CHASE_TRIGGER_RADIUS,
  RAMPAGE_THREAT_RADIUS_TILES,
} from '../constants.js';
import {
  canEnterSurfaceTile,
  canEnterUndergroundTile,
  isDescentBlocked,
  unpackStepDx,
  unpackStepDy,
  DIR_DX,
  DIR_DY,
} from './ant-motion.js';

const ZONE_SURFACE = Zone.Surface;

// `colony.entrances` is a Phase-3 caller-side extension (createColonyRecord does
// not set it), so minimal test worlds can leave it undefined. Fall back to this
// shared empty tuple — the entrance scans then find nothing (no milling / no flee
// target), matching the movement code's `colony.entrances && …` guard.
const NO_ENTRANCES = [] as const;

/** Fixed-point centre of tile `t` (matches the sim's tile-centre convention). */
function tileCenter(t: number): number {
  return (t << FP_SHIFT) + (FP_ONE >> 1);
}

/**
 * #209 PR C — true iff tile `(x, y)` is inside a CHAMBER FOOTPRINT of the ant's own
 * colony. Chamber footprints are occupancy-EXEMPT (`resolveSameColonyOccupancy` via
 * `isOccupancyExempt`), so a wander confined to them causes zero occupancy contention
 * with productive ants (the mechanism behind the ~44% economy drag the confinement
 * fixes). Keyed on `ants.colonyId[id]` to mirror `isOccupancyExempt` EXACTLY (the grid
 * is keyed on `currentGridColonyId` for passability; equal for an Idle worker today).
 * Missing colony (bare/test world) → not in a chamber (hold), mirroring the guard in
 * `isOccupancyExempt`.
 */
function isInOwnChamber(world: WorldState, id: number, x: number, y: number): boolean {
  const colony = world.colonies[world.ants.colonyId[id]! as unknown as ColonyId];
  if (colony === undefined) return false; // bare/test world — mirrors isOccupancyExempt's guard
  return isInChamberFootprint(colony, x, y);
}

/**
 * #209 PR C — true iff the ant's existing `targetPosX/Y` is a valid underground
 * wander target to PRESERVE this tick: set, on a NON-shaft (`tileY !== 0`) tile
 * that is the ant's current tile or exactly one cardinal step away, still enterable,
 * AND inside a chamber footprint (so every wander move stays chamber→chamber =
 * occupancy-exempt). This is the ownership + drift + shaft + confinement guard in one:
 * it rejects a stale DISTANT target from a prior task (`targetPosX/Y` is shared and not
 * universally cleared on task transitions), a stale shaft-row target, a target whose
 * tile went Solid/Marked mid-window, and a target that drifted out of the chamber.
 */
function keepLocalWanderTarget(
  world: WorldState,
  id: number,
  tileX: number,
  tileY: number,
  grid: UndergroundGrid,
): boolean {
  const ants = world.ants;
  const tpx = ants.targetPosX[id]!;
  if (tpx === -1) return false;
  const tx = tpx >> FP_SHIFT;
  const ty = ants.targetPosY[id]! >> FP_SHIFT;
  if (ty === 0) return false; // never preserve a shaft-row target (must ascend, not wander)
  // Current tile (0,0) or exactly one cardinal step (Manhattan ≤ 1; diagonals = 2 rejected).
  if (Math.abs(tx - tileX) + Math.abs(ty - tileY) > 1) return false;
  if (!canEnterUndergroundTile(grid, tx, ty, AntTask.Idle)) return false;
  return isInOwnChamber(world, id, tx, ty);
}

/**
 * #209 PR C (V35) — advance an idle UNDERGROUND worker's one-tile wander so a
 * saturated-colony surplus de-clumps instead of freezing in a motionless blob.
 * The ant steps toward a hash-chosen enterable CARDINAL neighbour, re-picked once
 * per retarget bucket and held when reached — local (always reachable),
 * drift-free, no RNG draw. Reuses `targetPosX/Y` (no new save column); the
 * movement branch consumes + revalidates it.
 *
 * Invariants:
 *  - Grid = `undergroundGrids[currentGridColonyId]` — the grid the ant occupies
 *    and ascends in (NOT `colonyId`). Missing grid → clear + return.
 *  - **Shaft row ⇒ ALWAYS clear + ascend:** an idle ant AT the shaft (`tileY 0`)
 *    unconditionally has its target cleared so it takes the V34 defensive
 *    Idle-ascent to the surface reserve, not be captured (a fresh-pick / preserved
 *    target at row 0 would let the ascent gate suppress the ascent). No preserve
 *    exception: a chamber wanderer never reaches the shaft (chambers exclude row 0)
 *    and an exempt chamber resident is never occupancy-shifted onto it, so the only
 *    row-0 target would be a stale one whose step onto the non-exempt `(x,1)` shaft
 *    tile would re-introduce occupancy contention.
 *  - **Chamber confinement:** the ant's CURRENT tile and every wander target must be
 *    inside a chamber footprint (occupancy-EXEMPT). Moving idle ants through
 *    non-exempt tiles bumps productive foragers/diggers via the occupancy resolver
 *    (a ~44% economy drag); confined to exempt chamber tiles the motion is free and
 *    de-clumps exactly the #209 chamber cluster. Idle ants outside a chamber hold.
 *  - **Drift-free:** re-pick only at a retarget-bucket boundary; mid-window keep
 *    the target only if it is still a valid LOCAL non-shaft in-chamber step.
 */
function setUndergroundWanderStep(
  world: WorldState,
  id: number,
  tileX: number,
  tileY: number,
): void {
  const ants = world.ants;
  const grid = world.undergroundGrids[ants.currentGridColonyId[id]!];
  if (grid === undefined) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }

  // Shaft row → ALWAYS clear so the V34 defensive Idle-ascent surfaces it (no
  // preserve: any row-0 target is stale and would step onto the non-exempt shaft).
  // Not in a chamber (tunnel / non-exempt open area) → clear + hold: moving there
  // would bump productive ants via the occupancy resolver.
  if (tileY === 0 || !isInOwnChamber(world, id, tileX, tileY)) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }

  // Mid-window: preserve a still-valid local, non-shaft, enterable, IN-CHAMBER step
  // (drift-free + rejects stale distant cross-task targets, and keeps every move
  // chamber→chamber). Parenthesize the mask-AND: `===` binds tighter than `&`.
  const atBoundary = (world.tick & ((1 << IDLE_MILL_RETARGET_SHIFT) - 1)) === 0;
  if (!atBoundary && keepLocalWanderTarget(world, id, tileX, tileY, grid)) return;

  // Fresh pick: hash-rotate the 4 cardinals, take the first in-bounds, non-shaft,
  // enterable, IN-CHAMBER neighbour. None qualifies → clear (deterministic hold).
  const r = hash32((world.tick >> IDLE_MILL_RETARGET_SHIFT) ^ id) & 3;
  for (let k = 0; k < 4; k++) {
    const dir = (r + k) & 3;
    const nx = tileX + DIR_DX[dir]!;
    const ny = tileY + DIR_DY[dir]!;
    if (ny === 0) continue; // never target the shaft row
    if (!canEnterUndergroundTile(grid, nx, ny, AntTask.Idle)) continue;
    if (!isInOwnChamber(world, id, nx, ny)) continue; // confine to occupancy-exempt tiles
    ants.targetPosX[id] = tileCenter(nx);
    ants.targetPosY[id] = tileCenter(ny);
    return;
  }
  ants.targetPosX[id] = -1;
  ants.targetPosY[id] = -1;
}

/**
 * #297 (V38) — LOCAL ALL-CLEAR exit from the homebound surface hold: true when the
 * held worker's OWN tile has decayed below FLEE_THRESHOLD.
 *
 * V34 armed the hold on the worker's own-tile danger but then re-armed it on
 * ENTRANCE safety alone, never re-reading where the worker actually stands. A
 * carrier that armed the hold on a one-shot pulse — a spider walking past, or a
 * cross-colony kill alarm (`KILL_ALARM_DANGER_DEPOSIT`, which has no leash at all)
 * — therefore stayed frozen for as long as ANY door stayed camped, standing in
 * zero danger, holding food the colony could never bank. And because the hold
 * freezes movement, such a worker could never walk into the doorstep band either,
 * so the doorstep exit alone could not reach it.
 *
 * Releasing a worker that is not in danger is the bound this hold was missing: if
 * it walks back into the threat the phase -1 entry branch re-arms the hold, so the
 * behaviour is bounded by the THREAT rather than unbounded in time. Applied at
 * BOTH hold sites (entry-from-dash and re-arm) so the outcome never depends on
 * which site evaluated the worker.
 */
function releaseOnLocalAllClear(
  world: WorldState,
  dangerGrid: PheromoneGrid | undefined,
  tileX: number,
  tileY: number,
): boolean {
  // #322 (V49) — local quiet releases a held carrier even while the colony alarm
  // sounds (C1/V42 kept it frozen, which stranded carriers far from home for the
  // whole alarm under a full camp); released, it walks home to wait at the edge
  // of the danger (see the V49 note in types.ts).
  const danger = dangerGrid !== undefined ? phGet(dangerGrid, tileX, tileY) : 0;
  return danger < FLEE_THRESHOLD;
}

/**
 * #297 (V38) — true when a homebound forager is on its own DOORSTEP: within
 * FLEE_HOMEBOUND_PUSH_THROUGH_TILES Manhattan tiles of an own entrance that is
 * both OPEN and actually ENTERABLE. Such a carrier pushes through the danger on
 * normal routing instead of taking V34's hold; see
 * SIM_VERSION_V38_FORAGER_DOORSTEP_PUSH.
 *
 * OPEN, not safe: safety is exactly what has failed wherever this is consulted
 * (the hold only arms when every open entrance reads >= FLEE_THRESHOLD), so
 * requiring safety here would make the predicate constantly false.
 *
 * ENTERABLE is the load-bearing half. `isDescentBlocked` (#165) pins ANY
 * descender on the surface while a RAMPAGING spider occupies the entrance tile,
 * and the rampage state machine deliberately holds that camper in place exactly
 * while a surface ant stands there so the tile-coincident bite lands. Releasing
 * a carrier toward such a door therefore does not get it home — it walks onto
 * the bite tile, cannot descend, and is eaten. Measured in a real camp (spider
 * set Rampaging once, the sim's own state machine running, carrier 2 tiles out,
 * 12 seeds): WITHOUT this guard 12/12 carriers died; WITH it 12/12 banked their
 * load, versus 11/12 under the plain V34 hold. Pushing through DANGER is the
 * point; pushing into a blockade you provably cannot pass is pure loss, so a
 * blockaded door does not count as a doorstep and the ant keeps the V34 hold
 * until the camper moves.
 *
 * "ENTERABLE" is judged across ALL open doors, not just the near one, because the
 * released forager's route is chosen by a BFS this function cannot predict — see
 * the body for why that makes the difference between sound and merely likely.
 *
 * Inlined scan for the same reason as `pickNearestSafeEntrance`: it runs per
 * worker per tick and must not allocate (repo hot-loop rule). A colony holds at
 * most MAX_ENTRANCES_PER_COLONY = 4 entrances, so the loop is trivially bounded.
 */
function onEnterableDoorstep(
  world: WorldState,
  colony: ColonyRecord,
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
): boolean {
  // Two conditions, and the second is the load-bearing one.
  //
  // (1) SOME open door is within the radius — measured to the nearest, which is
  //     equivalent (a Manhattan-nearest door outside the radius means they all
  //     are). Lowest-`entranceId` tie-break, matching `pickNearestSafeEntrance`.
  //
  // (2) NO open door is blockaded. This is what makes the release sound rather
  //     than merely likely-safe. A released forager is routed by NORMAL homebound
  //     routing — ant-movement.ts's multi-source surface entrance BFS, seeded
  //     from every open door and expanded by OBSTACLE distance — so we cannot
  //     predict from here which door it will actually reach: a HardBlock between
  //     the ant and its Manhattan-nearest door can make a farther door the closer
  //     one by path. Qualifying one door therefore proves nothing about the door
  //     the ant walks to. Requiring every open door to be enterable removes the
  //     question: whichever one the BFS picks, the ant can get in.
  //
  //     Cheap: only a RAMPAGING spider blockades an own entrance, and it occupies
  //     one tile, so at most one door is ever blocked, and a colony holds at most
  //     MAX_ENTRANCES_PER_COLONY = 4. Allocation-free, ≤4 calls per held worker.
  //
  // Releasing into a door the ant provably cannot enter is pure loss (it is
  // pinned on the surface by `isDescentBlocked` and the camper is held in place
  // to bite it), so when any door is blockaded the ant keeps the V34 hold. Never
  // worse than V34; strictly better than releasing blind.
  let best: NestEntrance | null = null;
  let bestDist = -1;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    // `isDescentBlocked` is called rather than re-implemented so the two can
    // never drift. `isOwnEntrance = true` + `AntTask.Foraging` reduces it to the
    // #165 spider arm by construction (the #164 arm needs a FOREIGN Fighter).
    if (
      isDescentBlocked(world, AntTask.Foraging, true, colony, ent.surfaceTileX, ent.surfaceTileY)
    ) {
      return false; // some door the BFS might pick is impassable — hold
    }
    const dist = Math.abs(ent.surfaceTileX - tileX) + Math.abs(ent.surfaceTileY - tileY);
    if (
      bestDist < 0 ||
      dist < bestDist ||
      (dist === bestDist && best !== null && ent.entranceId < best.entranceId)
    ) {
      bestDist = dist;
      best = ent;
    }
  }
  return best !== null && bestDist <= FLEE_HOMEBOUND_PUSH_THROUGH_TILES;
}

/**
 * Nearest OPEN entrance whose surface tile is SAFE (DangerTrail < FLEE_THRESHOLD).
 * Skipping camped entrances is what lets a worker flee to a farther clear exit
 * instead of being suppressed because its nearest open entrance is dangerous
 * (Codex P2). Returns null when no safe open entrance exists.
 *
 * Inlined scan (NOT a filtered helper call): this runs per worker per tick inside
 * `tickIdleReserveAndFlee`, so it must not allocate a fresh `accept` closure each
 * call (repo hot-loop rule; Codex P2 + CodeRabbit). Nearest by Manhattan distance
 * with lower-`entranceId` tie-break, with the danger skip folded into the loop.
 */
function pickNearestSafeEntrance(
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
  dangerGrid: PheromoneGrid | undefined,
): NestEntrance | null {
  let best: NestEntrance | null = null;
  let bestDist = -1;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    if (entranceDanger(dangerGrid, ent) >= FLEE_THRESHOLD) continue;
    const dist = Math.abs(ent.surfaceTileX - tileX) + Math.abs(ent.surfaceTileY - tileY);
    if (
      bestDist < 0 ||
      dist < bestDist ||
      (dist === bestDist && best !== null && ent.entranceId < best.entranceId)
    ) {
      bestDist = dist;
      best = ent;
    }
  }
  return best;
}

/**
 * Point a fleeing worker at a SAFE entrance and choose its routing. Returns true
 * if a safe open entrance exists (the caller sets phase 0), false if none does
 * (the caller holds).
 *
 * Routing is a HYBRID so the P2 safe-entrance fix doesn't cost obstacle-aware
 * routing in the common case:
 *   - If NO open entrance is dangerous (single-entrance colonies while fleeing —
 *     they only flee when their one entrance is safe — and multi-entrance colonies
 *     with no camp) → leave targetPosX/Y = -1 so the movement routes via the
 *     obstacle-aware multi-source surface BFS. Every BFS destination is provably
 *     safe here, so the danger-UNAWARE BFS cannot misroute into a camp.
 *   - If SOME open entrance IS dangerous (a camp exists) → write the chosen safe
 *     entrance's tile so the movement flee-dash STRAIGHT-LINES there. The BFS is
 *     seeded from every open entrance (incl. the camped one) and routes by
 *     obstacle distance, so it could pull the worker to the camp even when the
 *     Manhattan-nearest entrance is safe (Codex P2); straight-line is danger-safe
 *     but obstacle-blind, so it is used ONLY when a camp is present. Single-
 *     entrance colonies never hit this branch (they hold if camped), keeping the
 *     REQ-C1 economy on the BFS path.
 */
function setFleeTarget(
  world: WorldState,
  id: number,
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
  dangerGrid: PheromoneGrid | undefined,
): boolean {
  const safe = pickNearestSafeEntrance(entrances, tileX, tileY, dangerGrid);
  if (safe === null) return false;
  let anyDangerousEntrance = false;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (ent.isOpen && entranceDanger(dangerGrid, ent) >= FLEE_THRESHOLD) {
      anyDangerousEntrance = true;
      break;
    }
  }
  if (!anyDangerousEntrance) {
    world.ants.targetPosX[id] = -1; // no camp → obstacle-aware BFS is danger-safe
    world.ants.targetPosY[id] = -1;
  } else {
    world.ants.targetPosX[id] = tileCenter(safe.surfaceTileX); // camp present → straight-line to safe
    world.ants.targetPosY[id] = tileCenter(safe.surfaceTileY);
  }
  return true;
}

/**
 * C1 (V42) — the colony alarm's hold at the shaft. Called by movement's ascent
 * (ant-movement.ts, the only production underground → surface write) from INSIDE
 * its matching-open-entrance branch, for an ant that would otherwise climb out.
 * Returns true if the alarm holds it; the caller then skips the ascent.
 *
 * That ascent admits an Idle worker with no target and any SearchingFood /
 * ReturningToNest forager, and never consulted the alarm. Under the alarm those
 * are an Idle worker at the shaft row (a post-deposit ant at a chamberless shaft
 * pool, a V35 wander clear at row 0, a matured larva or dropped carrier) and any
 * forager that was STILL searching or returning underground when the alarm
 * sounded — a one-shot population before V49, because a full deposit sets
 * task=Idle and step 10a's alarm gate stops re-promotion. (From V49, #322, every
 * forager the alarm musters home descends and is held here: the normal case.) Each climbed out: with a safe door
 * step 15b recalled it next tick, and under a full camp it was never recalled at
 * all (Codex P2).
 *
 * A held ant is turned into a SHELTERER, exactly as a dashing flee ant is on
 * descent, rather than merely skipped — so it leaves through this module's
 * poke-out, which re-reads REAL danger at the exit. A bare skip released held
 * ants on the player's all-clear alone, and a held forager could climb straight
 * onto a spider-camped door the tick the alarm was cleared.
 *
 * Why the caller must only ask from inside the matching-entrance branch: the
 * poke-out re-arms any shelterer whose column has no open entrance, indefinitely,
 * until one opens there — so sheltering an ant that could not have ascended
 * anyway would strand it.
 *
 * Adults only: brood are alive Idle entities with no target and pass the ascent
 * too, but tickIdleReserveAndFlee walks only colony.workers and maturation does
 * not reset the flee column, so a brood shelterer would mature into a worker
 * already held. Brood spawn at speed 0 and both promotion sites set
 * WORKER_BASE_SPEED, so speed separates them exactly (and excludes the queen).
 *
 * Own colony AND own grid: the stance belongs to the colony that sounded it, and
 * a player ant sheltered inside the ENEMY nest would poke out against its own
 * colony's entrances, find none at that column, and be held there. Fighters are
 * not civilians and keep movement's existing rule.
 *
 * #377 (V68): while the spider on a rampage threatens its colony an IDLE worker is
 * held the same way, alarm or not (rampageThreatens), so an idle worker that surfaces from
 * below — a carrier that has just banked its load, a matured larva, a worker the
 * #373 retreat released below — stays in instead of climbing out into the hunt
 * and fleeing back down. A forager still climbs out to work (the alarm alone holds
 * it). (This hold also makes the poke-out's rampage hold, below, belt and braces:
 * an Idle shelterer the poke-out let out would be held here the same tick.)
 */
export function holdAlarmedCivilianAtShaft(
  world: WorldState,
  id: number,
  inOwnGrid: boolean,
): boolean {
  if (!inOwnGrid) return false;
  const ants = world.ants;
  const task = ants.task[id]!;
  if (task !== AntTask.Idle && task !== AntTask.Foraging) return false;
  if (ants.speed[id]! <= 0) return false; // brood (and the queen)
  const colony = world.colonies[ants.colonyId[id]!];
  if (
    colony?.alarmActive !== true &&
    !(task === AntTask.Idle && colony !== undefined && rampageThreatens(world, colony))
  ) {
    return false;
  }
  ants.fleeShelterUntilTick[id] = world.tick + SHELTER_COOLDOWN_TICKS;
  return true;
}

/**
 * #377 (V68) — the rampage shelter's global gate: the spider is on a rampage
 * (spider.ts spiderOnRampage — out hunting hungry, until it eats or dies) and the
 * world is V68 or later. rampageThreatens (below) decides per colony; it is what
 * step 10a (sheltering idle workers stay recruitable), step 15b (idle surface
 * workers go in, idle shelterers stay in) and step 16 (the routed dash, the hold at
 * the shaft) read. The spider does not move or change state between those steps
 * (it ticks at 17.5), so all three read the same answer within a tick. Always
 * false below V68.
 */
export function rampageShelterActive(world: WorldState): boolean {
  return world.simVersion >= SIM_VERSION_V68_RAMPAGE_SHELTER && spiderOnRampage(world);
}

/**
 * #377 (V68) — the spider THREATENS `colony`: it is on a rampage
 * (rampageShelterActive) and it is
 *  - camping, or on its way to camp, one of this colony's entrances (Rampaging with
 *    rampageTargetColonyId this colony — a V54 rotation's target included), or
 *  - within RAMPAGE_THREAT_RADIUS_TILES (Manhattan) of one of its open entrances,
 *    whatever it is doing: chasing a straggler between camps (the camper's divert
 *    clears its target), hunting, patrolling hungry, or camping the other colony's
 *    door nearby.
 * Only then does the rampage shelter apply to the colony — every V68 rule reads
 * this (steps 10a, 15b and 16), not rampageShelterActive — so a colony the spider is
 * not hunting keeps its idle reserve out, as at V67. Pure: the spider's saved state
 * and position, and the colony's entrances. Always false below V68.
 */
export function rampageThreatens(world: WorldState, colony: ColonyRecord): boolean {
  if (!rampageShelterActive(world)) return false;
  const spider = world.spider!; // rampageShelterActive: a spider on a rampage
  if (spider.state === 'Rampaging' && spider.rampageTargetColonyId === colony.colonyId) {
    return true;
  }
  const sx = spider.posX >> FP_SHIFT;
  const sy = spider.posY >> FP_SHIFT;
  const entrances = colony.entrances ?? NO_ENTRANCES;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    if (
      Math.abs(ent.surfaceTileX - sx) + Math.abs(ent.surfaceTileY - sy) <=
      RAMPAGE_THREAT_RADIUS_TILES
    ) {
      return true;
    }
  }
  return false;
}

/**
 * #377 (V68) — the entrance an Idle surface worker at (tileX, tileY) goes down to
 * shelter from the spider's rampage, or null (it holds). With m the worker's
 * Manhattan distance from the spider, of its colony's OPEN entrances:
 *  - not one whose surface tile reads real danger (DangerTrail at FLEE_THRESHOLD
 *    or more — the spider is on it, beside it or just left it, or an enemy killed
 *    there: the V34 flee's own rule, pickNearestSafeEntrance) — unless the spider
 *    stands on the worker's own tile (m = 0): then any way out beats staying, and
 *    a door beside it reads the spider's own danger;
 *  - out of the spider's chase range (m > SPIDER_CHASE_TRIGGER_RADIUS, R: the
 *    Manhattan distance, through walls, at which it turns to chase an ant —
 *    spider.ts findChaseTarget), not one whose way there passes within that range
 *    of it, the door included. With d the worker's path distance to the door (the
 *    surface goal field seeded at it) and ds the spider's Manhattan distance to
 *    the door, that is tested as
 *        m + ds <= d + 2 * R,
 *    which every spider within R of a point P on a shortest path satisfies
 *    (m <= path(W,P) + R, ds <= R + path(P,E)); the test errs toward excluding,
 *    and the worker then holds, out of range (it may hold one whose actual route
 *    would have kept clear, e.g. a tile out of range after a diagonal). So the
 *    entrance the spider is camping or about to reach is never chosen, nor one it
 *    stands in the way of. With the spider standing still, a door allowed stays
 *    allowed as the worker walks its way (m + ds - d never falls along a shortest
 *    path), and its way never comes within range. (Parity: m + ds has d's parity, so the values next to the bound
 *    are d + 2R, excluded, and d + 2R + 2, the first allowed.)
 *  - within its chase range ("cornered", 1 <= m <= R), every way passes within
 *    range, so the worker must only not walk toward the spider: not a door whose
 *    next step (stepTowardReachable, the step step 16 takes it) lands nearer the
 *    spider than it stands. Re-chosen every tick, its steps never end nearer the
 *    spider (a diagonal, taken an axis at a time at half a tile a tick, may pass a
 *    tile nearer for a tick); with the spider standing still it turns to another
 *    door, or holds, once its way turns toward it. (With m = 0 every step leads
 *    away, and the door's danger is not read; one tile out, at m = 1, it is again,
 *    so a worker that ran from under the spider toward a door an enemy kill has
 *    flagged holds there.)
 *  - of the rest, the nearest by path; ties to the lower entranceId.
 * A worker standing on one of the entrances goes down it, whatever the tests say,
 * unless the descent there is blocked (isDescentBlocked: the #165 blockade, a
 * Rampaging spider on it): movement's descent is this tick's, before the bite.
 * A worker cut off from an entrance (unreachable on the goal field) skips it.
 *
 * Inlined scan like pickNearestSafeEntrance (per worker per tick, no allocation;
 * at most MAX_ENTRANCES_PER_COLONY entrances). The goal fields are the cached
 * per-tile surface fields (surface-routing.ts: one BFS per entrance tile, kept
 * until the cache is cleared).
 */
function pickRampageShelterEntrance(
  world: WorldState,
  colony: ColonyRecord,
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
  dangerGrid: PheromoneGrid | undefined,
): NestEntrance | null {
  const spider = world.spider;
  if (spider === null) return null; // unreachable under rampageShelterActive
  const sx = spider.posX >> FP_SHIFT;
  const sy = spider.posY >> FP_SHIFT;
  const apart = Math.abs(tileX - sx) + Math.abs(tileY - sy);
  let best: NestEntrance | null = null;
  let bestDist = -1;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    const ex = ent.surfaceTileX;
    const ey = ent.surfaceTileY;
    // Standing on it: it goes down this tick (movement's descent follows its step),
    // whatever the danger round it, unless the descent is blocked there.
    if (tileX === ex && tileY === ey) {
      if (!isDescentBlocked(world, AntTask.Idle, true, colony, ex, ey)) return ent;
      continue;
    }
    if (apart > 0 && entranceDanger(dangerGrid, ent) >= FLEE_THRESHOLD) continue;
    const dist = surfaceGoalDistance(world, tileX, tileY, ex, ey);
    if (dist === SURFACE_GOAL_UNREACHED) continue;
    if (apart > SPIDER_CHASE_TRIGGER_RADIUS) {
      // Out of its chase range: the way there passes within it.
      const spiderDist = Math.abs(sx - ex) + Math.abs(sy - ey);
      if (apart + spiderDist <= dist + 2 * SPIDER_CHASE_TRIGGER_RADIUS) continue;
    } else if (apart > 0) {
      // Cornered: the next step there lands nearer the spider.
      const step = stepTowardReachable(world, tileX, tileY, ex, ey);
      const nextX = tileX + unpackStepDx(step);
      const nextY = tileY + unpackStepDy(step);
      if (Math.abs(nextX - sx) + Math.abs(nextY - sy) < apart) continue;
    }
    if (
      bestDist < 0 ||
      dist < bestDist ||
      (dist === bestDist && best !== null && ent.entranceId < best.entranceId)
    ) {
      bestDist = dist;
      best = ent;
    }
  }
  return best;
}

/**
 * #377 (V68) — point an Idle surface worker at the entrance it shelters down
 * (pickRampageShelterEntrance) and return true; step 16 walks it there by the
 * surface goal field (rampageShelterDashRoutes). With none, return false and hold
 * it: clear its target — unless it stands within the spider's scatter radius of
 * the reticle, where it keeps the away target step 13e just wrote (as the mill
 * and the muster do), so it is not left standing where the strike lands. A
 * dasher's way in is not checked against the reticle (only against the spider).
 *
 * A worker holding stays where it is even if its own tile reads real danger (an
 * enemy kill beside it): the V34 flee would take it to a door past the spider.
 */
function setRampageShelterTarget(
  world: WorldState,
  colony: ColonyRecord,
  id: number,
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
  dangerGrid: PheromoneGrid | undefined,
): boolean {
  const ants = world.ants;
  const ent = pickRampageShelterEntrance(world, colony, entrances, tileX, tileY, dangerGrid);
  if (ent !== null) {
    ants.targetPosX[id] = tileCenter(ent.surfaceTileX);
    ants.targetPosY[id] = tileCenter(ent.surfaceTileY);
    return true;
  }
  const reticle = world.scatterReticleTile;
  if (
    reticle === null ||
    Math.abs(tileX - reticle.x) + Math.abs(tileY - reticle.y) > SPIDER_SCATTER_RADIUS_TILES
  ) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
  }
  return false;
}

/**
 * #377 (V68) — `id` is an Idle worker dashing in from the spider's rampage: on the
 * surface, flee phase 0, of a colony whose alarm is off, with the entrance step
 * 15b chose (setRampageShelterTarget) as its target. Step 16 walks it there by the
 * surface goal field seeded at that entrance rather than the V34 flee dash's
 * straight line, which a wall between it and the door would pin; and it claims no
 * tile in the same-colony occupancy pass (ant-movement.ts claimsNoTile), so no
 * friend bumps it sideways off its way. Always false below V68.
 */
export function rampageShelterDashRoutes(world: WorldState, id: number): boolean {
  const ants = world.ants;
  if (ants.task[id] !== AntTask.Idle || ants.zone[id] !== ZONE_SURFACE) return false;
  if (ants.fleeShelterUntilTick[id] !== 0 || ants.targetPosX[id] === -1) return false;
  const colony = world.colonies[ants.colonyId[id]!];
  if (colony === undefined || colony.alarmActive === true) return false;
  return rampageThreatens(world, colony);
}

/**
 * Step 15b — surface idle-reserve milling + general pheromone-driven flee.
 *
 * For every adult worker (`colony.workers[]` — adult identity; never scan by
 * task alone, since Idle is shared with queens/brood) this advances the flee
 * state machine encoded in `ants.fleeShelterUntilTick` (a `>0` hold is
 * disambiguated by `zone`: underground = sheltering, surface = homebound hold):
 *   -1 not fleeing → 0 dashing (surface danger + safe entrance) ; >0 surface
 *                     hold (homebound forager, danger but NO safe entrance) ;
 *                     or set a mill target
 *    0 dashing      → -1 abort (non-homebound: danger passed / no safe entrance);
 *                     >0 surface hold (homebound: lost its last safe entrance) ;
 *                     underground descent promotes it to sheltering (movement)
 *   >0 underground  → poke head out when the timer elapses: resume if the danger
 *                     above the shaft has decayed, else re-arm the cooldown
 *   >0 surface      → re-check each tick: dash (0) once a safe entrance appears,
 *                     release (-1) if no longer homebound, else re-arm the hold
 *
 * #377 (V68), while the spider on a rampage threatens the colony (rampageThreatens)
 * and its alarm is off, an
 * IDLE surface worker takes the rampage shelter's rules instead of the mill and the
 * V34 danger flee:
 *   -1 → 0 dashing (pickRampageShelterEntrance found a door; step 16 walks it
 *          there by path), or stays -1 holding (none)
 *    0 → re-picks every tick; -1 holding once no door is left
 *   >0 underground → the poke-out re-arms an Idle shelterer while the rampage
 *          lasts, alarm or not (a forager keeps the alarm-or-danger poke-out)
 * An Idle worker climbing up from below is held at the shaft top as a shelterer
 * (holdAlarmedCivilianAtShaft).
 *
 * #297 (V38) adds the two exits the surface hold was missing, so it is bounded by
 * the THREAT rather than unbounded in time:
 *   - doorstep — the carrier is within FLEE_HOMEBOUND_PUSH_THROUGH_TILES of an own
 *     entrance that is open AND enterable (`onEnterableDoorstep`); it pushes
 *     through the danger rather than starving the colony three tiles out.
 *   - local all-clear — the re-arm site re-reads the carrier's OWN tile and
 *     releases it once that has decayed below FLEE_THRESHOLD. V34 keyed on
 *     entrance safety alone, so a carrier could stay frozen in zero danger
 *     indefinitely (and, being frozen, could never reach the doorstep band).
 * See SIM_VERSION_V38_FORAGER_DOORSTEP_PUSH.
 */
export function tickIdleReserveAndFlee(world: WorldState): void {
  const ants = world.ants;
  const tick = world.tick;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as ColonyId];
    if (colony === undefined) continue;
    const entrances: readonly NestEntrance[] = colony.entrances ?? NO_ENTRANCES;
    // Grid-guard: absent danger grid → danger reads as 0 (bare/test worlds never
    // allocate pheromoneGrids). Never call phGet on undefined.
    const dangerKey = pheromoneGridKey(colony.colonyId, PheromoneType.DangerTrail, 'surface');
    const dangerGrid = world.pheromoneGrids[dangerKey];
    // C1 (V42) — colony alarm. Read once per colony: while it is sounding, the
    // four own-tile/own-exit danger reads below all behave as "dangerous", which
    // routes every surface civilian down the existing V34 flee path. The
    // ENTRANCE-safety reads (setFleeTarget → pickNearestSafeEntrance,
    // entranceDanger) are deliberately untouched, so the alarm never TARGETS a
    // camped door — a fully-camped colony holds instead (from V49, #322, walks
    // home and waits at the edge of the danger). The chosen target is
    // safe; the straight-line path to it is not checked (pre-existing V34
    // behaviour — see the V42 note in types.ts).
    // #322 (V49) — the alarm musters civilians home instead of freezing them.
    const alarmed = colony.alarmActive === true;
    // #377 (V68) — the spider on a rampage threatens this colony: its idle workers go
    // in and stay in (see SIM_VERSION_V68_RAMPAGE_SHELTER). Always false below V68.
    const threatened = rampageThreatens(world, colony);
    // ... by the rampage shelter's way in. Not while its alarm sounds: the alarm
    // already brings every civilian in and keeps its own V42/V49 rules for how.
    const rampageShelters = threatened && !alarmed;
    // #373 (V65) — an enemy ant is below ground in this colony's nest and it has a
    // shelterer below: build this tick's retreat field (read here and by step 16).
    // Always false below V65.
    const invaded = computeNestRetreat(world, colony);
    const workers = colony.workers;

    for (let w = 0; w < workers.length; w++) {
      const id = workers[w]!;
      if (ants.alive[id] !== 1) continue;
      const phase = ants.fleeShelterUntilTick[id]!;
      const zone = ants.zone[id]!;
      const task = ants.task[id]!;
      const tileX = ants.posX[id]! >> FP_SHIFT;
      const tileY = ants.posY[id]! >> FP_SHIFT;
      // A HOMEBOUND forager is one heading back to the nest — carrying food, or
      // ReturningToNest. It is the only worker normal movement routes to the
      // nearest OPEN entrance *without* the safe filter, so it (and only it)
      // needs the surface hold below (Codex P2). A SearchingFood forager wanders
      // outward and never gets the hold; an Idle worker holds via a cleared
      // target with no timer. Cheap (no allocation) — read once per worker.
      const isHomeboundForager =
        task === AntTask.Foraging &&
        (ants.foodCarrying[id]! > 0 || ants.subTask[id]! === ForagingSubState.ReturningToNest);
      // #297 (V38) — doorstep push-through. Computed once per worker and read by
      // all three hold sites below (entry, dasher-loses-its-door, hold re-arm) so
      // they can never disagree about whether this carrier waits or runs.
      // `zone === ZONE_SURFACE` first: every read site below is inside a
      // surface-only branch, but an UNDERGROUND carrier's (tileX, tileY) are
      // underground-grid coordinates, and comparing those against
      // `ent.surfaceTileX/Y` is meaningless (a carrier at the shaft row would
      // measure `dist = surfaceTileY` and often score a spurious `true`). Gate it
      // here so the value is never wrong rather than merely never read, and so
      // the scan is skipped for the colony's largest ant population.
      const doorstepPush =
        zone === ZONE_SURFACE &&
        // HOMEBOUND, not merely laden. Restricting the push to `foodCarrying > 0`
        // is the intuitive call — "don't risk an ant that has nothing to bank" —
        // and it MEASURES WORSE: 30 seeds, Normal, laden-only vs homebound gives
        // queen@12k 83.3% vs 86.7%, queen@24k 76.7% vs 86.7%, WarFooting 83.3% vs
        // 86.7%. The mechanism: an EMPTY ReturningToNest forager frozen out here
        // is a DISABLED FORAGER. It never descends (movement's `needsUnderground`
        // admits Foraging only at subTask CarryingFood, or fleePhase === 0; from
        // V49, #322, also a returning forager under the alarm), and
        // it is still bite-able where it stands. Released, it walks to the
        // entrance tile, flips to SearchingFood with its wave bumped, and starts a
        // fresh excursion — which is the colony's next load of food. Frozen, it
        // does none of that. The bite risk is the same either way; only the upside
        // differs, and the upside is real.
        isHomeboundForager &&
        onEnterableDoorstep(world, colony, entrances, tileX, tileY);

      // A fleeing/sheltering worker the allocator reassigned AWAY from its reserve
      // task (Idle/Foraging) — e.g. recruited to Fighting/Nursing/Digging during
      // the very raid it sheltered from — must abandon the flee. Step 10a
      // allocates by `task === Idle` with NO zone check, so an underground
      // sheltering Idle worker IS eligible; without this clear its stale
      // fleeShelterUntilTick keeps the movement `if (fleePhase > 0) continue`
      // freezing the new fighter/nurse/digger for the whole threat window (and the
      // shelter branch below would keep re-arming it). Runs before movement (step
      // 16), so the reassigned worker moves for its new task this tick.
      if (phase !== -1 && task !== AntTask.Idle && task !== AntTask.Foraging) {
        ants.fleeShelterUntilTick[id] = -1;
        continue;
      }

      if (phase === -1) {
        // Not fleeing. Surface non-combat workers (idle or forager) mill/flee
        // below; underground IDLE workers wander (#209 PR C, V35).
        if (zone !== ZONE_SURFACE) {
          // Underground, not fleeing. V35: an idle underground worker de-clumps
          // via a one-tile wander. Underground NON-Idle workers keep the bare
          // `continue` — they must NOT fall through to the surface danger read
          // below (that would sample the SURFACE DangerTrail at underground
          // coordinates and could spuriously flee).
          if (task === AntTask.Idle) {
            setUndergroundWanderStep(world, id, tileX, tileY);
          }
          continue;
        }
        if (task !== AntTask.Idle && task !== AntTask.Foraging) continue;
        if (rampageShelters && task === AntTask.Idle) {
          // #377 (V68) — the spider on a rampage threatens the colony: go in, by path, down the
          // nearest entrance whose way keeps out of its reach (dash, phase 0), or
          // hold where it stands. Replaces the milling and the V34 danger flee for
          // an Idle worker while the rampage lasts.
          if (setRampageShelterTarget(world, colony, id, entrances, tileX, tileY, dangerGrid)) {
            ants.fleeShelterUntilTick[id] = 0;
          }
          continue;
        }
        const danger = dangerGrid !== undefined ? phGet(dangerGrid, tileX, tileY) : 0;
        if (alarmed || danger >= FLEE_THRESHOLD) {
          // Flee toward the nearest SAFE open entrance (skipping camped ones): a
          // camped nearest entrance must NOT suppress fleeing when a farther clear
          // entrance exists (Codex P2). setFleeTarget also picks the routing
          // (BFS vs straight-line) — see its doc.
          if (setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)) {
            ants.fleeShelterUntilTick[id] = 0; // dashing toward the safe entrance
          } else if (
            isHomeboundForager &&
            !doorstepPush &&
            // #322 (V49): under the alarm, hold only where this tile reads real
            // danger; elsewhere walk home on normal routing and wait at the edge
            // of the danger by the entrance.
            !(alarmed && danger < FLEE_THRESHOLD)
          ) {
            // No safe entrance, but this forager is heading HOME (carrying food /
            // ReturningToNest) and is still far from any of its own doors.
            // Normal movement would route it to the nearest OPEN — possibly
            // camped — entrance without the safe filter, walking it the whole way
            // into the threat (Codex P2). Instead HOLD it in place for one tick:
            // clear the target and set a positive surface timer. Movement skips
            // every fleePhase > 0, so it freezes here and re-evaluates next tick
            // (the phase>0 surface branch), dashing once an entrance clears.
            //
            // #297 (V38): a carrier already ON its doorstep takes the `else`
            // (no hold) and pushes through — waiting there is what starved the
            // colony. A Rampaging camper does eventually leave (the chase-divert,
            // or SPIDER_RAMPAGE_MAX_TICKS), but the camp outlasts
            // STARVATION_GRACE_TICKS several times over: measured on `main`, the
            // longest contiguous camp while the queen was still alive runs a
            // median 1 197.5 ticks and up to 1 635, ~4× the 300-tick grace.
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
            ants.fleeShelterUntilTick[id] = tick + 1;
          } else if (task === AntTask.Idle) {
            if (alarmed && danger < FLEE_THRESHOLD) {
              // #322 (V49): under the alarm an idle worker on a quiet tile walks
              // home too, and waits at the edge of the danger by the entrance
              // (it holds, below, once its own tile reads real danger).
              setMusterTarget(world, id, entrances, tileX, tileY);
            } else {
              // No safe/open entrance and NOT homebound → an IDLE worker HOLDS:
              // clear its (stale mill) target so the V34 mill branch falls through
              // to getTaskDirection → (0,0) and it stays put.
              ants.targetPosX[id] = -1;
              ants.targetPosY[id] = -1;
            }
          }
          // else: a SearchingFood forager (not homebound, not Idle). It does NOT
          // hold — it keeps its own foraging dispatch (wanders outward, away from
          // the nest); freezing it would just make it stationary bait, so letting
          // it keep searching is the deliberate v1 choice. Crucially we must NOT
          // clear its target here: step 13e (spider scatter) may have written an
          // away-from-reticle target this tick, and clearing it would revert the
          // forager to scent-wander back toward the threat — defeating scatter
          // exactly while the spider hunts. Symmetric with setMillTarget's
          // reticle-radius preservation guard.
          continue;
        }
        // No danger → milling. Only Idle workers mill; surface foragers keep
        // foraging (their own dispatch owns their target).
        if (task === AntTask.Idle) {
          setMillTarget(world, id, entrances, tileX, tileY, dangerGrid);
        }
      } else if (phase === 0) {
        // Dashing toward an entrance.
        if (zone === ZONE_SURFACE) {
          if (isHomeboundForager) {
            // Homebound dasher: entrance SAFETY — not the worker's own tile —
            // governs the DASH. Keep dashing while a safe entrance exists
            // (refresh routing each tick); do not hand it back to normal routing
            // merely because local danger decayed, which would re-aim it at a
            // still-camped entrance (Codex P2). If the last safe entrance is
            // lost, it drops into the surface timed hold — except, since V38, on
            // its own doorstep or when its own tile is clear AND no safe entrance
            // exists, where holding is the worse of the two evils (see below).
            // Otherwise it leaves flee only by reaching a shaft (descent →
            // shelter, in movement) or being reassigned off Foraging (top guard).
            if (!setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)) {
              ants.targetPosX[id] = -1;
              ants.targetPosY[id] = -1;
              // #297 (V38) — the SAME two exits the phase>0 re-arm site uses, so a
              // carrier's fate never depends on which site happened to evaluate it:
              // release to normal routing on the doorstep, or when its own tile is
              // not actually dangerous; otherwise drop into the timed hold.
              ants.fleeShelterUntilTick[id] =
                doorstepPush || releaseOnLocalAllClear(world, dangerGrid, tileX, tileY)
                  ? -1
                  : tick + 1;
            }
          } else if (rampageShelters && task === AntTask.Idle) {
            // #377 (V68) — an Idle worker dashing in from the rampage re-chooses its
            // entrance every tick (the spider moves); with none left it stops
            // dashing and holds (phase -1 next tick re-chooses too).
            if (!setRampageShelterTarget(world, colony, id, entrances, tileX, tileY, dangerGrid)) {
              ants.fleeShelterUntilTick[id] = -1;
            }
          } else {
            const danger = dangerGrid !== undefined ? phGet(dangerGrid, tileX, tileY) : 0;
            // Non-homebound dasher (Idle / SearchingFood): abort the dash if the
            // immediate danger has passed, OR no SAFE open entrance remains
            // (target closed / went dangerous mid-flight) — never keep dashing
            // into the threat; resume the underlying task next tick. Otherwise
            // re-point at the CURRENT nearest safe entrance + routing (it can
            // change as the danger field shifts or the worker moves).
            if (
              (!alarmed && danger < FLEE_THRESHOLD) ||
              !setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)
            ) {
              ants.fleeShelterUntilTick[id] = -1;
              // Clear any explicit straight-line flee target: otherwise movement
              // (later this tick, now phase -1) still sees it — an Idle worker
              // would mill toward it and a forager would follow it as a normal
              // target instead of resuming/holding (Codex P2).
              ants.targetPosX[id] = -1;
              ants.targetPosY[id] = -1;
            }
          }
        } else {
          // Underground but still phase 0 — defensive (the descent branch
          // normally sets the shelter timer the instant it descends). Promote to
          // sheltering so the ant can't idle underground in the dash phase.
          ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS;
        }
      } else if (zone === ZONE_SURFACE) {
        // phase > 0 on the SURFACE — a homebound forager held in place because no
        // safe entrance exists (set above). Re-evaluate every tick (the +1 timer
        // makes `tick >= phase` true the very next tick):
        if (tick >= phase) {
          if (!isHomeboundForager) {
            // No longer heading home (subtask flipped to SearchingFood in step
            // 9c, or the task changed) → release; resume normal behavior.
            ants.fleeShelterUntilTick[id] = -1;
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
          } else if (setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)) {
            // A safe entrance appeared → dash toward it.
            ants.fleeShelterUntilTick[id] = 0;
          } else if (doorstepPush || releaseOnLocalAllClear(world, dangerGrid, tileX, tileY)) {
            // #297 (V38) — two ways to stop waiting, both handed back to normal
            // homebound routing by clearing the target:
            //
            //  (a) doorstepPush — home is within reach through an enterable door:
            //      make the final dash rather than starve three tiles out.
            //
            //  (b) the ant's OWN tile has decayed below FLEE_THRESHOLD. This site
            //      previously re-armed on entrance safety ALONE and never
            //      re-read local danger, so a carrier that armed the hold on a
            //      one-shot pulse (a spider walking past, a kill alarm) stayed
            //      frozen for as long as ANY door stayed camped — standing in
            //      zero danger, unable to move, holding food the colony could
            //      never bank. Because the hold freezes movement it could not
            //      even walk toward the doorstep band, so (a) alone could never
            //      rescue it. Releasing an ant that is not actually in danger is
            //      the bound this hold was missing; if it walks back into the
            //      threat the phase -1 entry branch re-arms the hold, so the
            //      behaviour stays bounded by the threat rather than unbounded
            //      in time.
            ants.fleeShelterUntilTick[id] = -1;
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
          } else {
            // Still no safe entrance → re-arm the hold for another tick.
            ants.fleeShelterUntilTick[id] = tick + 1;
          }
        }
      } else if (invaded && (tileY !== 0 || shelterRetreatDir(world, id) >= 0)) {
        // #373 (V65) — phase > 0 UNDERGROUND while invaders are in the nest, and
        // this shelterer is retreating (step 16 walks it to the chamber farthest
        // from them, shelterRetreatDir below) or has retreated below the
        // shaft-top row: no poke-out, it keeps sheltering until the nest is clear.
        // A shelterer at the shaft top with nowhere to retreat to keeps the V34
        // poke-out below (the alarm, if on, still holds it there).
        if (tick >= phase) ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS;
      } else if (
        tick >= phase &&
        world.simVersion >= SIM_VERSION_V65_ALARM_INVASION &&
        tileY !== 0
      ) {
        // #373 (V65) — the invasion is over and this shelterer retreated: it is
        // below the shaft-top row (row 0), where a shelterer otherwise always is —
        // the descent and the alarm's hold both put it there, the shaft top is
        // occupancy-exempt so nothing shifts it, and row 0 is never dug. The poke-out
        // below could not let it out (only an ant on row 0 ascends, and it re-arms a
        // shelterer with no open entrance at its column indefinitely), so it stops
        // sheltering where it stands, as a worker already deep.
        ants.fleeShelterUntilTick[id] = -1;
        ants.targetPosX[id] = -1;
        ants.targetPosY[id] = -1;
      } else {
        // phase > 0 UNDERGROUND — sheltering at the shaft. "Poke head out" once
        // the cooldown elapses.
        if (tick >= phase) {
          // Re-derive the exit as the open entrance at the ant's OWN shaft column
          // (descent preserves posX; the two grids share a width) — the one the
          // ant will actually ASCEND through, since the ascent matches by
          // surfaceTileX. Using the Manhattan-nearest entrance instead could
          // sample a safe entrance in a DIFFERENT column and release the ant up
          // through its own still-camped column entrance (Codex P2). No open
          // entrance at the column → STAY sheltered (re-arm): the ant cannot
          // ascend there anyway, so resuming would strand it as an active-but-
          // immobile reserve; it recovers when an entrance at its column reopens.
          const exit = pickOpenEntranceAtColumn(entrances, tileX);
          if (exit === null) {
            ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS;
          } else {
            // Sample the surface DangerTrail above the exit: resume if it has
            // decayed below the threshold, else re-arm another cooldown.
            const surfaceDanger =
              dangerGrid !== undefined
                ? phGet(dangerGrid, exit.surfaceTileX, exit.surfaceTileY)
                : 0;
            // #377 (V68): an Idle shelterer stays in while the spider on a rampage
            // threatens its colony, alarm or not; a forager keeps the alarm-or-danger
            // poke-out.
            if (
              !alarmed &&
              !(threatened && task === AntTask.Idle) &&
              surfaceDanger < FLEE_THRESHOLD
            ) {
              ants.fleeShelterUntilTick[id] = -1; // all-clear → resume (ascend + mill)
              // #209 PR C (V35) — clear the stale camped-entrance SURFACE flee
              // target that survived descent + shelter. On this release tick the
              // phase>0 branch runs (not the phase===-1 wander sanitizer), so
              // movement's V35 underground-idle-wander branch would otherwise
              // consume the stale surface tile as an underground destination and
              // the V35 ascent gate would suppress the V34 resume-ascent —
              // capturing the released reserve underground.
              ants.targetPosX[id] = -1;
              ants.targetPosY[id] = -1;
            } else {
              ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS; // re-arm
            }
          }
        }
      }
    }
  }
}

/**
 * Set an idle worker's mill target: a deterministic wander tile in the Chebyshev
 * annulus (radius 1..IDLE_MILL_RADIUS, exact entrance tile excluded) around its
 * nearest own open entrance. No RNG draw — two hash32 draws of (tick-bucket ^
 * antId) give independent X/Y offsets. No open entrance → clear the target so
 * the ant holds in place (no pour-out with nowhere to gather).
 */
function setMillTarget(
  world: WorldState,
  id: number,
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
  dangerGrid: PheromoneGrid | undefined,
): void {
  const ants = world.ants;
  // Step 15b runs AFTER spider-scatter (tick step 13e), which writes an
  // away-from-reticle target for surface non-fighters within
  // SPIDER_SCATTER_RADIUS_TILES of world.scatterReticleTile. Milling must NOT
  // clobber that safety target: the scatter reticle is the spider's HUNT TARGET,
  // which can differ from the current DangerTrail (danger 0 on the worker's own
  // tile, so it would otherwise mill toward the incoming threat). Preserve the
  // scatter target when the worker is inside the reticle radius.
  const reticle = world.scatterReticleTile;
  if (reticle !== null) {
    const manh = Math.abs(tileX - reticle.x) + Math.abs(tileY - reticle.y);
    if (manh <= SPIDER_SCATTER_RADIUS_TILES) return;
  }
  // Mill around the nearest SAFE open entrance — symmetric with the flee-entry
  // pick. Never mill TOWARD a camped entrance: the spider's DangerTrail is a tight
  // 5-tile cross (radius 1, no diffusion), so an idle worker at radius 2-3 reads
  // danger 0 on its OWN tile and would otherwise keep ambling toward the threat,
  // clustering next to it before the per-tile flee gate trips (REQ-C1); it would
  // also OVERWRITE the away-target spider-scatter (tick step 13e) just wrote. No
  // safe open entrance → clear the target and hold in place.
  const ent = pickNearestSafeEntrance(entrances, tileX, tileY, dangerGrid);
  if (ent === null) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }
  const seed = (world.tick >> IDLE_MILL_RETARGET_SHIFT) ^ id;
  const span = 2 * IDLE_MILL_RADIUS + 1;
  let ox = (hash32(seed) % span) - IDLE_MILL_RADIUS;
  const oy = (hash32(seed ^ 0x9e3779b9) % span) - IDLE_MILL_RADIUS;
  // Exclude the exact entrance tile (offset 0,0 — the spider hunt-counts it);
  // nudge into the ring.
  if (ox === 0 && oy === 0) ox = 1;
  let tx = ent.surfaceTileX + ox;
  let ty = ent.surfaceTileY + oy;
  if (tx < 0) tx = 0;
  else if (tx >= SURFACE_GRID_WIDTH) tx = SURFACE_GRID_WIDTH - 1;
  if (ty < 0) ty = 0;
  else if (ty >= SURFACE_GRID_HEIGHT) ty = SURFACE_GRID_HEIGHT - 1;
  // Passable probe: if the annulus tile is blocked (feature/off-map), fall back
  // to the entrance tile (always reachable) so the target is never inside a wall.
  if (!canEnterSurfaceTile(world, tx, ty)) {
    tx = ent.surfaceTileX;
    ty = ent.surfaceTileY;
  }
  ants.targetPosX[id] = (tx << FP_SHIFT) + (FP_ONE >> 1);
  ants.targetPosY[id] = (ty << FP_SHIFT) + (FP_ONE >> 1);
}

/**
 * #322 (V49): an idle worker mustering home under the alarm with no safe
 * entrance heads for its nearest own open entrance and waits just outside the
 * doorstep (or earlier, where its own tile reads real danger). Once an entrance
 * reads safe, the ordinary recall dashes it in. Like milling, it keeps a spider-scatter target inside the reticle
 * radius. No open entrance → clear the target and hold in place.
 */
function setMusterTarget(
  world: WorldState,
  id: number,
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
): void {
  const ants = world.ants;
  const reticle = world.scatterReticleTile;
  if (reticle !== null) {
    const manh = Math.abs(tileX - reticle.x) + Math.abs(tileY - reticle.y);
    if (manh <= SPIDER_SCATTER_RADIUS_TILES) return;
  }
  let best: NestEntrance | null = null;
  let bestDist = 0;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    const d = Math.abs(tileX - ent.surfaceTileX) + Math.abs(tileY - ent.surfaceTileY);
    if (best === null || d < bestDist) {
      best = ent;
      bestDist = d;
    }
  }
  // Wait just outside the doorstep (the lane homebound carriers push through,
  // FLEE_HOMEBOUND_PUSH_THROUGH_TILES): idle workers queued on the approach would
  // otherwise bump carriers off it. Measured: carriers home 74/80 → 79/80.
  if (best === null || bestDist <= FLEE_HOMEBOUND_PUSH_THROUGH_TILES) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }
  ants.targetPosX[id] = (best.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
  ants.targetPosY[id] = (best.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
}

/**
 * #322 (V49): an idle surface worker mustering home under its colony's alarm
 * (not fleeing: step 15b found no safe entrance). It neither claims a tile nor
 * is bumped in the same-colony occupancy pass, so idle workers waiting outside
 * the doorstep never block the carriers' approach lane.
 */
export function idleMusterPassesThroughFriends(world: WorldState, id: number): boolean {
  const ants = world.ants;
  if (ants.task[id] !== AntTask.Idle || ants.zone[id] !== ZONE_SURFACE) return false;
  if (ants.fleeShelterUntilTick[id] !== -1) return false;
  return world.colonies[ants.colonyId[id]!]?.alarmActive === true;
}

/**
 * #322 (V49): an idle worker walking home to muster — its target is one of its
 * own open entrance tiles (setMusterTarget) — steps by the colony's surface
 * entrance flow field, as a homebound forager does, so it gets round obstacles.
 * A spider-scatter target is never an entrance tile, so it keeps its own step.
 */
export function idleMustersHome(world: WorldState, id: number): boolean {
  if (!idleMusterPassesThroughFriends(world, id)) return false;
  const ants = world.ants;
  const tx = ants.targetPosX[id]!;
  if (tx === -1) return false;
  const colony = world.colonies[ants.colonyId[id]!];
  if (!colony || !colony.entrances) return false;
  const tileX = tx >> FP_SHIFT;
  const tileY = ants.targetPosY[id]! >> FP_SHIFT;
  for (let e = 0; e < colony.entrances.length; e++) {
    const ent = colony.entrances[e]!;
    if (ent.isOpen && ent.surfaceTileX === tileX && ent.surfaceTileY === tileY) return true;
  }
  return false;
}

/**
 * #343 (V55): an idle surface worker walking back from beyond home range steps by
 * its colony's surface entrance flow field (obstacle-aware), as a homebound
 * forager, a V48 sentry and a V49 musterer do. Before V55 it stepped in a straight
 * line at its mill target, so an obstacle between it and home pinned it there,
 * out of reach of the colony's food, until it starved.
 *
 * True only for a worker whose ordinary mill step (targetPosX set by step 15b's
 * setMillTarget) is taking it home — every one of these holds:
 *  - Idle, on the surface, not fleeing, with a target;
 *  - its colony is not under the alarm (a musterer has its own route,
 *    idleMustersHome);
 *  - not within the spider's scatter radius (setMillTarget keeps the scatter
 *    target there, and the ant must keep dodging, not walk home);
 *  - beyond home range (antIsAtHome false) — at home it mills as before;
 *  - no open entrance of its colony reads real danger. The field leads to the
 *    NEAREST open entrance, which may be a camped one the mill avoids
 *    (setMillTarget aims at the nearest SAFE entrance), so while any entrance is
 *    camped the worker keeps its straight-line mill step (so a far worker behind an
 *    obstacle can still be pinned for as long as a camp lasts).
 * `dangerGrid` is the colony's surface DangerTrail grid (undefined = no danger);
 * the movement loop passes the one it resolved once per tick, so this hot path
 * builds no grid-key string per ant (AGENTS.md hot-loop rule).
 * Always false below V55.
 */
export function idleWalksHome(
  world: WorldState,
  id: number,
  dangerGrid: PheromoneGrid | undefined,
): boolean {
  if (world.simVersion < SIM_VERSION_V55_ROUTED_HOMING) return false;
  const ants = world.ants;
  if (ants.task[id] !== AntTask.Idle || ants.zone[id] !== ZONE_SURFACE) return false;
  if (ants.fleeShelterUntilTick[id] !== -1 || ants.targetPosX[id] === -1) return false;
  const colonyId = ants.colonyId[id]!;
  const colony = world.colonies[colonyId];
  if (colony === undefined || colony.alarmActive === true) return false;
  const reticle = world.scatterReticleTile;
  if (reticle !== null) {
    const manh =
      Math.abs((ants.posX[id]! >> FP_SHIFT) - reticle.x) +
      Math.abs((ants.posY[id]! >> FP_SHIFT) - reticle.y);
    if (manh <= SPIDER_SCATTER_RADIUS_TILES) return false;
  }
  if (antIsAtHome(world, id)) return false;
  const entrances: readonly NestEntrance[] = colony.entrances ?? NO_ENTRANCES;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (ent.isOpen && entranceDanger(dangerGrid, ent) >= FLEE_THRESHOLD) return false;
  }
  return true;
}

/** DangerTrail at an entrance's surface tile (0 if no grid). Guards the flee gate. */
function entranceDanger(dangerGrid: PheromoneGrid | undefined, ent: NestEntrance): number {
  if (dangerGrid === undefined) return 0;
  return phGet(dangerGrid, ent.surfaceTileX, ent.surfaceTileY);
}

// ---------------------------------------------------------------------------
// #373 (V65) — shelter retreat: sheltering civilians retreat from invaders
// inside their nest.
//
// While an enemy ant is below ground in a colony's nest, that colony's SHELTERERS
// (workers holding underground on the flee timer — the ones waiting at the shaft
// top under the colony alarm or after a V34 flee) walk by tunnel path to the
// chamber farthest from the invaders. Everyone else below ground (workers already
// deep in the nest, nurses, the queen) is untouched.
//
// Step 15b (tickIdleReserveAndFlee, above) calls computeNestRetreat once per
// colony, first thing for that colony, and keeps the colony's retreating
// shelterers sheltering while it returns true (the nest is invaded). Step 16
// (tickAntMovement) steps a shelterer by shelterRetreatDir instead of freezing it,
// and exempts it from the occupancy pass (shelterPassesThroughFriends). The fields
// are per-tick scratch (stamped with world.tick), recomputed at step 15b before
// step 16 reads them, and nothing between the two moves an ant or changes a grid.
// (Within step 16 a lower-id invader may move before a shelterer steps; the
// clearance still keeps the shelterer off the invaders' tiles, though it can end
// the tick beside one.)
//
// The way to the retreat tile is checked tile by tile: a shelterer stops wherever
// it stands farther from the invaders than the retreat tile (on a looped nest that
// can be in a tunnel), as one that started there would.
//
// It lives here, with the rest of the shelter state machine, so the whole of it
// is one Layer-1 behaviour (#212): the orchestrator reads it, no behaviour does.
// Allocation-free after the first invaded tick of a colony (buffers grow once).
// ---------------------------------------------------------------------------

/**
 * A retreat never passes a tile within this many steps of an intruder (its own tile
 * and its four neighbours): the per-part floods do not enter them and no retreat
 * tile is one. So the way to the chamber goes round the invaders or not at all —
 * a shelterer whose only way to the farthest chamber runs past them holds where it
 * is. Combat is per tile, so walking beside a moving invader is a fight a tick
 * later.
 */
const RETREAT_CLEARANCE = 1;

/** The direction back along step d (N↔S, E↔W). */
const REVERSE = [2, 3, 0, 1] as const;

/** A tile an ant can walk: Open or BeingDug (the flow fields' traversal rule). */
function walkable(data: Uint8Array, idx: number): boolean {
  const s = data[idx]!;
  return s === UndergroundTileState.Open || s === UndergroundTileState.BeingDug;
}

/**
 * #373 (V65) — `id` is an OWN-NEST SHELTERER: below ground in its own colony's grid,
 * on the flee timer, Idle or Foraging. The one definition the field build
 * (computeNestRetreat), the retreat step (shelterRetreatDir) and the occupancy
 * exemption (shelterPassesThroughFriends) all use, so they cannot drift apart: a
 * shelterer the build ignored would go unserved, and one the exemption ignored
 * would be bumped back off its retreat every tick. Aliveness is the caller's.
 */
function isOwnNestShelterer(world: WorldState, id: number): boolean {
  const ants = world.ants;
  if (ants.zone[id] !== Zone.Underground || ants.fleeShelterUntilTick[id]! <= 0) return false;
  const task = ants.task[id]!;
  if (task !== AntTask.Idle && task !== AntTask.Foraging) return false;
  return ants.currentGridColonyId[id] === ants.colonyId[id];
}

/** The colony's retreat record, created on first use and grown to the grid. */
function retreatRecord(world: WorldState, colonyId: number, cells: number): NestRetreatField {
  const map = getScratch(world).nestRetreat;
  let rec = map.get(colonyId);
  if (rec === undefined) {
    rec = {
      tick: -1,
      dist: new Int32Array(cells),
      label: new Int32Array(cells),
      dir: new Int32Array(cells),
      qx: new Int32Array(cells),
      qy: new Int32Array(cells),
      targetDist: [],
    };
    map.set(colonyId, rec);
  } else if (rec.dist.length < cells) {
    rec.dist = new Int32Array(cells);
    rec.label = new Int32Array(cells);
    rec.dir = new Int32Array(cells);
    rec.qx = new Int32Array(cells);
    rec.qy = new Int32Array(cells);
  }
  return rec;
}

/**
 * #373 (V65) — step 15b, first thing for `colony`: if an enemy ant stands below
 * ground in its nest and one of its workers shelters below, build this tick's
 * retreat field for it and return true (the nest is INVADED); otherwise return
 * false. Always false below V65.
 *
 *  1. `dist`: tunnel distance (BFS over walkable tiles) from the nearest intruder.
 *     A tile no intruder can reach is -1.
 *  2. The nest minus the tiles within RETREAT_CLEARANCE of an intruder falls into
 *     connected parts. Each part an intruder can reach that holds a chamber tile
 *     gets ONE retreat tile: its chamber tile farthest from the intruders (ties: the
 *     chamber listed first, then row-major). Parts are taken best-first, and a
 *     part's flood (below) marks all of it, so each part's tile is its own farthest.
 *  3. `dir`/`label`: a BFS from each retreat tile gives every tile of its part the
 *     step toward it and the part's index; `targetDist` holds that tile's distance.
 * A part with intruders but no chamber has no retreat tile (its tiles keep label -1).
 */
export function computeNestRetreat(world: WorldState, colony: ColonyRecord): boolean {
  if (world.simVersion < SIM_VERSION_V65_ALARM_INVASION) return false;
  const cid = colony.colonyId;
  const grid = world.undergroundGrids[cid];
  if (grid === undefined) return false;
  const ants = world.ants;
  const w = grid.width;
  const h = grid.height;
  const map = getScratch(world).nestRetreat;
  // Only a colony with a shelterer below needs the field (it is read for nobody
  // else), so a raid on a nest with no one sheltering costs no BFS.
  let sheltering = false;
  const workers = colony.workers;
  for (let i = 0; i < workers.length; i++) {
    const id = workers[i]!;
    if (ants.alive[id] === 1 && isOwnNestShelterer(world, id)) {
      sheltering = true;
      break;
    }
  }
  if (!sheltering) {
    const old = map.get(cid);
    if (old !== undefined) old.tick = -1;
    return false;
  }
  // One scan: every intruder (an enemy ant below ground in this colony's grid) is
  // a seed of the distance BFS. The record is only touched once one is found.
  let rec: NestRetreatField | undefined;
  let tail = 0;
  for (let o = 0; o < world.nextEntityId; o++) {
    if (ants.alive[o] !== 1 || ants.zone[o] !== Zone.Underground) continue;
    if (ants.currentGridColonyId[o] !== cid || ants.colonyId[o] === cid) continue;
    if (rec === undefined) {
      rec = retreatRecord(world, cid, w * h);
      rec.dist.fill(-1);
      rec.label.fill(-1);
      rec.dir.fill(-1);
      rec.targetDist.length = 0;
    }
    const x = ants.posX[o]! >> FP_SHIFT;
    const y = ants.posY[o]! >> FP_SHIFT;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const idx = y * w + x;
    if (rec.dist[idx] !== -1) continue;
    rec.dist[idx] = 0;
    rec.qx[tail] = x;
    rec.qy[tail] = y;
    tail++;
  }
  if (rec === undefined || tail === 0) {
    // Not invaded (or no intruder on the grid): no earlier field can be read as
    // this tick's.
    const old = map.get(cid);
    if (old !== undefined) old.tick = -1;
    return false;
  }
  const { dist, label, dir, qx, qy } = rec;

  // 1. Distance from the nearest intruder (multi-source BFS).
  bfs(grid, qx, qy, tail, dist, null, -1, null);

  // 2 + 3. Best-first: the farthest unlabelled chamber tile starts the next part.
  const chambers = colony.chambers;
  for (;;) {
    let best = -1;
    let bestX = 0;
    let bestY = 0;
    let bestD = -1;
    for (let c = 0; c < chambers.length; c++) {
      const ch = chambers[c]!;
      const bx = ch.posX >> FP_SHIFT;
      const by = ch.posY >> FP_SHIFT;
      for (let y = by; y < by + ch.height; y++) {
        if (y < 0 || y >= h) continue;
        for (let x = bx; x < bx + ch.width; x++) {
          if (x < 0 || x >= w) continue;
          const idx = y * w + x;
          const d = dist[idx]!;
          if (d > RETREAT_CLEARANCE && d > bestD && label[idx] === -1 && walkable(grid.data, idx)) {
            best = idx;
            bestX = x;
            bestY = y;
            bestD = d;
          }
        }
      }
    }
    if (best < 0) break;
    const part = rec.targetDist.length;
    rec.targetDist.push(bestD);
    label[best] = part;
    dir[best] = -1; // the retreat tile itself: arrived
    qx[0] = bestX;
    qy[0] = bestY;
    bfs(grid, qx, qy, 1, label, dir, part, dist);
  }
  rec.tick = world.tick;
  return true;
}

/**
 * BFS from the `tail` seeds in (qx, qy) over walkable tiles. With `dir === null` it
 * writes distances into `mark` (-1 = unvisited, seeds already 0). Otherwise it
 * floods `mark` with `value` (-1 = unvisited, seeds already marked) and writes into
 * `dir` each reached tile's step back toward the seed it came from, never entering a
 * tile whose `clearance` (intruder distance) is RETREAT_CLEARANCE or less.
 */
function bfs(
  grid: UndergroundGrid,
  qx: Int32Array,
  qy: Int32Array,
  tail: number,
  mark: Int32Array,
  dir: Int32Array | null,
  value: number,
  clearance: Int32Array | null,
): void {
  const w = grid.width;
  const h = grid.height;
  let head = 0;
  while (head < tail) {
    const x = qx[head]!;
    const y = qy[head]!;
    head++;
    const here = mark[y * w + x]!;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_DX[d]!;
      const ny = y + DIR_DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (mark[n] !== -1 || !walkable(grid.data, n)) continue;
      // A flood toward a retreat tile keeps clear of the intruders.
      if (clearance !== null && clearance[n]! <= RETREAT_CLEARANCE) continue;
      if (dir === null) {
        mark[n] = here + 1;
      } else {
        mark[n] = value;
        dir[n] = REVERSE[d]!;
      }
      qx[tail] = nx;
      qy[tail] = ny;
      tail++;
    }
  }
}

/**
 * #373 (V65) — the step (0..3: N, E, S, W) shelterer `id` takes this tick to retreat
 * from the invaders in its nest, or -1: it holds. It retreats while its own nest is
 * invaded (this tick's field, computeNestRetreat), it stands in its own nest, in a
 * part of it with a retreat tile, and that tile is FARTHER from the invaders than
 * where it stands (a worker already as deep as it can get stays put). Parts are
 * cut at the invaders (RETREAT_CLEARANCE), so the way to the tile never runs
 * through or beside one: where it would, the shelterer's part has no chamber and
 * it holds. One already beside an invader steps away from it into a part. Always -1
 * below V65 and for anything but an Idle/Foraging ant on the flee timer
 * below ground.
 */
export function shelterRetreatDir(world: WorldState, id: number): number {
  if (world.simVersion < SIM_VERSION_V65_ALARM_INVASION) return -1;
  if (!isOwnNestShelterer(world, id)) return -1;
  const ants = world.ants;
  const cid = ants.colonyId[id]!;
  const rec = getScratch(world).nestRetreat.get(cid);
  const grid = world.undergroundGrids[cid];
  if (rec === undefined || rec.tick !== world.tick || grid === undefined) return -1;
  const x = ants.posX[id]! >> FP_SHIFT;
  const y = ants.posY[id]! >> FP_SHIFT;
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return -1;
  const idx = y * grid.width + x;
  const part = rec.label[idx]!;
  const here = rec.dist[idx]!;
  if (part < 0) {
    // Within RETREAT_CLEARANCE of an invader (the floods leave those tiles out):
    // step off to the first neighbour (N, E, S, W) that is in a part and farther
    // from the invaders, rather than freeze beside them.
    if (here < 0 || here > RETREAT_CLEARANCE) return -1;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_DX[d]!;
      const ny = y + DIR_DY[d]!;
      if (nx < 0 || nx >= grid.width || ny < 0 || ny >= grid.height) continue;
      const n = ny * grid.width + nx;
      if (rec.label[n]! >= 0 && rec.dist[n]! > here) return d;
    }
    return -1;
  }
  if (rec.targetDist[part]! <= here) return -1;
  return rec.dir[idx]!;
}

/**
 * #373 (V65) — shelterer `id` stands below ground in its own nest while that nest's
 * retreat field is current (it is invaded): it neither claims a tile nor is bumped
 * in the occupancy pass, whether it is stepping or has stopped. A shelterer that
 * stops in a tunnel (already farther than the retreat tile) would otherwise be
 * bumped back by every shelterer filing in behind it, and step onto the tile again,
 * every tick. Always false below V65.
 */
export function shelterPassesThroughFriends(world: WorldState, id: number): boolean {
  if (world.simVersion < SIM_VERSION_V65_ALARM_INVASION) return false;
  if (!isOwnNestShelterer(world, id)) return false;
  const rec = getScratch(world).nestRetreat.get(world.ants.colonyId[id]!);
  return rec !== undefined && rec.tick === world.tick;
}
