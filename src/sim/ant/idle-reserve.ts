// idle-reserve.ts — #209 PR A (V34) step 15b: surface idle reserve + flee.
//
// Runs after pheromone decay (step 15) and before tickAntMovement (step 16). It
// owns ALL flee-state and idle-mill TARGET writes; the actual movement (dash to
// entrance, descent, shelter hold, mill amble) is executed by the V34 branch in
// ant-movement.ts / ant-motion.ts, which reads `ants.fleeShelterUntilTick` and
// `ants.targetPosX/Y`. Keeping every decision here (and out of the movement
// dispatch) is why the flee state machine stays legible and testable.
//
// The whole pass is inert below V34 (early return), so pre-V34 saves replay
// byte-identically. Reads are grid-guarded — a bare/test world with no
// DangerTrail grid sees danger = 0 everywhere (no flee, plain milling).
//
// Determinism: flee/mill decisions are pure functions of the serialized
// pheromone grids, ant positions, and `fleeShelterUntilTick`. The mill wander is
// a hash of (tick-bucket ^ antId) — no world.rngState draw.

import type { WorldState } from '../types.js';
import { SIM_VERSION_V34_IDLE_RESERVE_FLEE } from '../types.js';
import type { ColonyId } from '../colony/colony-store.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { phGet, pheromoneGridKey, type PheromoneGrid } from '../pheromone/pheromone-store.js';
import { pickNearestOpenEntrance, type NestEntrance } from '../colony/entrance.js';
import { hash32 } from '../hash.js';
import {
  FLEE_THRESHOLD,
  SHELTER_COOLDOWN_TICKS,
  IDLE_MILL_RADIUS,
  IDLE_MILL_RETARGET_SHIFT,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  SPIDER_SCATTER_RADIUS_TILES,
} from '../constants.js';
import { canEnterSurfaceTile } from './ant-motion.js';

const ZONE_SURFACE = 0; // Zone.Surface (raw; terrain.ts not imported into this leaf-ish behavior)

// `colony.entrances` is a Phase-3 caller-side extension (createColonyRecord does
// not set it), so minimal test worlds can leave it undefined. Fall back to this
// shared empty tuple — pickNearestOpenEntrance then returns null (no milling /
// no flee target), matching the movement code's `colony.entrances && …` guard.
const NO_ENTRANCES = [] as const;

/** Fixed-point centre of tile `t` (matches the sim's tile-centre convention). */
function tileCenter(t: number): number {
  return (t << FP_SHIFT) + (FP_ONE >> 1);
}

/**
 * Nearest OPEN entrance whose surface tile is SAFE (DangerTrail < FLEE_THRESHOLD).
 * Skipping camped entrances is what lets a worker flee to a farther clear exit
 * instead of being suppressed because its nearest open entrance is dangerous
 * (Codex P2). Returns null when no safe open entrance exists.
 *
 * Inlined scan (NOT a filtered `pickNearestOpenEntrance` call): this runs per
 * worker per tick inside `tickIdleReserveAndFlee`, so it must not allocate a
 * fresh `accept` closure each call (repo hot-loop rule; Codex P2 + CodeRabbit).
 * Same Manhattan-distance / lower-`entranceId` tie-break as
 * `pickNearestOpenEntrance`, with the danger skip folded into the loop.
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
 */
export function tickIdleReserveAndFlee(world: WorldState): void {
  if (world.simVersion < SIM_VERSION_V34_IDLE_RESERVE_FLEE) return;
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
        // Not fleeing. Only surface, non-combat workers (idle or forager)
        // participate; Digging/Nursing/Fighting keep their own movement.
        if (zone !== ZONE_SURFACE) continue;
        if (task !== AntTask.Idle && task !== AntTask.Foraging) continue;
        const danger = dangerGrid !== undefined ? phGet(dangerGrid, tileX, tileY) : 0;
        if (danger >= FLEE_THRESHOLD) {
          // Flee toward the nearest SAFE open entrance (skipping camped ones): a
          // camped nearest entrance must NOT suppress fleeing when a farther clear
          // entrance exists (Codex P2). setFleeTarget also picks the routing
          // (BFS vs straight-line) — see its doc.
          if (setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)) {
            ants.fleeShelterUntilTick[id] = 0; // dashing toward the safe entrance
          } else if (isHomeboundForager) {
            // No safe entrance, but this forager is heading HOME (carrying food /
            // ReturningToNest). Normal movement would route it to the nearest
            // OPEN — possibly camped — entrance without the safe filter, walking
            // it into the threat (Codex P2). Instead HOLD it in place for one
            // tick: clear the target and set a positive surface timer. Movement
            // skips every fleePhase > 0, so it freezes here and re-evaluates next
            // tick (the phase>0 surface branch), dashing once an entrance clears.
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
            ants.fleeShelterUntilTick[id] = tick + 1;
          } else if (task === AntTask.Idle) {
            // No safe/open entrance and NOT homebound → an IDLE worker HOLDS:
            // clear its (stale mill) target so the V34 mill branch falls through
            // to getTaskDirection → (0,0) and it stays put.
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
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
            // governs it. Do NOT release just because local danger decayed:
            // normal routing would immediately re-aim it at a still-camped
            // entrance (Codex P2). Keep dashing while a safe entrance exists
            // (refresh routing each tick); if the last safe entrance is lost,
            // drop into the surface timed hold rather than back to normal
            // routing. It leaves flee only by reaching a shaft (descent →
            // shelter, in movement) or being reassigned off Foraging (top guard).
            if (!setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)) {
              ants.targetPosX[id] = -1;
              ants.targetPosY[id] = -1;
              ants.fleeShelterUntilTick[id] = tick + 1;
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
              danger < FLEE_THRESHOLD ||
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
          } else {
            // Still no safe entrance → re-arm the hold for another tick.
            ants.fleeShelterUntilTick[id] = tick + 1;
          }
        }
      } else {
        // phase > 0 UNDERGROUND — sheltering at the shaft. "Poke head out" once
        // the cooldown elapses.
        if (tick >= phase) {
          // Re-derive the exit by nearest open entrance to the shaft column (the
          // ant held there; descent preserves posX and the two grids share a
          // width). No open entrance at all → STAY sheltered (re-arm) rather than
          // resuming into a stuck-underground state that would read as an active-
          // but-immobile reserve; it recovers when an entrance reopens.
          const exit = pickNearestOpenEntrance(entrances, tileX, 0);
          if (exit === null) {
            ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS;
          } else {
            // Sample the surface DangerTrail above the exit: resume if it has
            // decayed below the threshold, else re-arm another cooldown.
            const surfaceDanger =
              dangerGrid !== undefined
                ? phGet(dangerGrid, exit.surfaceTileX, exit.surfaceTileY)
                : 0;
            ants.fleeShelterUntilTick[id] =
              surfaceDanger < FLEE_THRESHOLD ? -1 : tick + SHELTER_COOLDOWN_TICKS;
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

/** DangerTrail at an entrance's surface tile (0 if no grid). Guards the flee gate. */
function entranceDanger(dangerGrid: PheromoneGrid | undefined, ent: NestEntrance): number {
  if (dangerGrid === undefined) return 0;
  return phGet(dangerGrid, ent.surfaceTileX, ent.surfaceTileY);
}
