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
import { AntTask, PheromoneType } from '../enums.js';
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
 */
function pickNearestSafeEntrance(
  entrances: readonly NestEntrance[],
  tileX: number,
  tileY: number,
  dangerGrid: PheromoneGrid | undefined,
): NestEntrance | null {
  return pickNearestOpenEntrance(
    entrances,
    tileX,
    tileY,
    (ent) => entranceDanger(dangerGrid, ent) < FLEE_THRESHOLD,
  );
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
 * state machine encoded in `ants.fleeShelterUntilTick`:
 *   -1 not fleeing → 0 dashing (on surface danger) ; or set a mill target
 *    0 dashing      → -1 abort (danger passed / no open entrance) ; underground
 *                     descent promotes it to sheltering (in the movement branch)
 *   >0 sheltering   → poke head out when the timer elapses: resume if the danger
 *                     above the shaft has decayed, else re-arm the cooldown.
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
          } else {
            // No safe/open entrance → HOLD (clear any stale mill target). This
            // holds an IDLE worker (the V34 mill branch needs a non-(-1) target,
            // so it falls through to getTaskDirection → (0,0)). A FORAGING worker
            // does NOT hold — it keeps its own foraging dispatch (SearchingFood
            // wanders outward, away from the nest); freezing it would just make it
            // stationary bait, so letting it keep working is the deliberate v1
            // choice. (Foragers-hold refinement is v2.)
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
          }
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
          const danger = dangerGrid !== undefined ? phGet(dangerGrid, tileX, tileY) : 0;
          // Abort the dash if the immediate danger has passed, OR no SAFE open
          // entrance remains (target closed / went dangerous mid-flight) — never
          // keep dashing into the threat; resume the underlying task next tick.
          // Otherwise re-point at the CURRENT nearest safe entrance + routing (it
          // can change as the danger field shifts or the worker moves).
          if (
            danger < FLEE_THRESHOLD ||
            !setFleeTarget(world, id, entrances, tileX, tileY, dangerGrid)
          ) {
            ants.fleeShelterUntilTick[id] = -1;
            // Clear any explicit straight-line flee target: otherwise movement
            // (later this tick, now phase -1) still sees it — an Idle worker would
            // mill toward it and a forager would follow it as a normal target
            // instead of resuming/holding (Codex P2).
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
          }
        } else {
          // Underground but still phase 0 — defensive (the descent branch
          // normally sets the shelter timer the instant it descends). Promote to
          // sheltering so the ant can't idle underground in the dash phase.
          ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS;
        }
      } else {
        // phase > 0 — sheltering underground at the shaft. "Poke head out" once
        // the cooldown elapses: sample the surface DangerTrail directly above the
        // shaft and resume if it has decayed, else re-arm another cooldown.
        if (tick >= phase) {
          const surfaceDanger = dangerAboveShaft(dangerGrid, entrances, tileX);
          if (surfaceDanger < FLEE_THRESHOLD) {
            ants.fleeShelterUntilTick[id] = -1; // all clear → resume task
          } else {
            ants.fleeShelterUntilTick[id] = tick + SHELTER_COOLDOWN_TICKS; // re-arm
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

/**
 * Danger on the surface above a sheltering ant's shaft — the "poke head out"
 * sample. The ant held at the shaft (underground tileX === the entrance
 * surfaceTileX, since descent preserves posX and the two grids share a width),
 * so the entrance is re-derived by nearest open entrance to that column — no
 * stored entrance id needed. Using the NEAREST open entrance (not an exact
 * column match) tolerates a same-colony-occupancy nudge off the shaft tile and a
 * shaft entrance that closed mid-shelter (the ant emerges via the next open
 * one). No open entrance at all → 0 (stop sheltering; the ant is stuck
 * underground regardless of phase). 0 danger grid → 0.
 */
function dangerAboveShaft(
  dangerGrid: PheromoneGrid | undefined,
  entrances: readonly NestEntrance[],
  shaftTileX: number,
): number {
  if (dangerGrid === undefined) return 0;
  const ent = pickNearestOpenEntrance(entrances, shaftTileX, 0);
  if (ent === null) return 0;
  return phGet(dangerGrid, ent.surfaceTileX, ent.surfaceTileY);
}
