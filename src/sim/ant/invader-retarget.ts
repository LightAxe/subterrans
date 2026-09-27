// src/sim/ant/invader-retarget.ts
// #212 Layer 1 (behavior): #364 (V59) — an invader hunting in an enemy nest goes
// for the nearest reachable enemy whose tile is not SATURATED, instead of queuing
// behind a duel its colony already holds. Depends only on Layer-0 ant-motion
// primitives (+ sibling sim modules); the orchestrator (ant-movement.ts) calls it
// for an invader on the hunt with no step-10e aim.
//
// Combat fights ONE pair per tile per tick: the lowest-id ant of each colony on the
// tile (combat.ts resolveCombatOnTile_v16). Up to V58 every invader in a nest went
// for the same nearest hostile (by Manhattan distance), so a pile of them waited
// behind one duel while other enemies stood free (#349's diagnosis: about 60% of
// in-match invader time). Saturated, concretely (ant-motion.ts tileSaturatedFor):
// the invader's own tile when a LOWER-id friend stands on it too, any other tile
// when ANY friend stands on it. Capacity is one attacker per tile, because combat's
// is.
//
// From V59 the invader steps toward the nearest hostile BY PATH (a BFS from its
// tile) on a tile not saturated for it. Path distance, not Manhattan: with a fixed
// goal every step shortens the path, so the choice cannot flip back and forth the
// way a Manhattan pick checked against a path step could. The BFS does not route
// through a tile a LOWER-id friend holds (unless friends stack there,
// isOccupancyExempt): the occupancy pass runs in id order, so the lower id keeps
// the tile and the invader would be bumped back off it. (A higher-id friend's
// tile is a way through: that friend is the one bumped. Lower ids have already
// moved this tick, so their tiles are the ones the occupancy pass will see.)
// With no free hostile it can reach past its friends, it keeps to the same path
// metric: it holds its place when the tunnels reach a free hostile beyond its
// friends; else it walks to the nearest QUEUE by path (a saturated hostile's
// tile, or the tile beside one a friend's claim keeps it off); else, with hostiles
// only beyond its friends, it holds. Only with no hostile the tunnels reach at all
// does it hunt as before V59 (the nearest by Manhattan, the wall-aware step).
//
// Cost: two passes over the ants (friends, then hostiles) and one BFS that stops
// at the first free hostile — in place of V58's one pass and one BFS to the target
// — plus, only when a friend was in the way and no free hostile was reached, one
// walls-only BFS.
// Deterministic: id-order scans, fixed N/E/S/W expansion.
import { AntTask } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import { getScratch } from '../scratch.js';
import { Zone } from '../terrain.js';
import { SIM_VERSION_V59_INVADER_RETARGET, type WorldState } from '../types.js';
import {
  DIR_DX,
  DIR_DY,
  canEnterUndergroundTile,
  isOccupancyExempt,
  packStep,
} from './ant-motion.js';

/** invaderHuntStep's result when the tunnels reach no hostile at all (or below V59). */
export const NO_FREE_HOSTILE = -1;

/**
 * #364 (V59) — the packed step (unpackStepDx/Dy) invader `id`, hunting below ground
 * in enemy nest `gridColonyId`, takes toward the nearest hostile by path whose
 * tile is not saturated for it (tileSaturatedFor's rule). Hostiles are the ants of
 * any other non-neutral colony in the nest — workers, the queen and brood, the set
 * pickNearestHostileUnderground hunts (brood included; the raid reach check,
 * ant-raid.ts hostileInReach, counts adults only). With none it can reach past its
 * friends: (0, 0) when the tunnels reach a free one beyond them; else a step toward
 * the nearest queue by path (0, 0 beside it); else (0, 0) when hostiles lie only
 * beyond its friends. NO_FREE_HOSTILE when the tunnels reach no hostile at all,
 * the nest has no grid, or below V59. `claimsNoTile` is the occupancy pass's
 * per-ant rule (ant-movement.ts): a friend it holds for neither bumps nor blocks.
 */
export function invaderHuntStep(
  world: WorldState,
  id: number,
  gridColonyId: number,
  claimsNoTile: (world: WorldState, id: number) => boolean,
): number {
  if (world.simVersion < SIM_VERSION_V59_INVADER_RETARGET) return NO_FREE_HOSTILE;
  const grid = world.undergroundGrids[gridColonyId];
  if (grid === undefined) return NO_FREE_HOSTILE;

  const ants = world.ants;
  const width = grid.width;
  const height = grid.height;
  const selfX = ants.posX[id]! >> FP_SHIFT;
  const selfY = ants.posY[id]! >> FP_SHIFT;
  if (selfX < 0 || selfY < 0 || selfX >= width || selfY >= height) return NO_FREE_HOSTILE;

  const rt = getScratch(world).antTargeting.retarget;
  const cells = width * height;
  if (rt.friend.length < cells) {
    rt.friend = new Int32Array(cells);
    rt.block = new Int32Array(cells);
    rt.hostile = new Int32Array(cells);
    rt.anyHostile = new Int32Array(cells);
    rt.seen = new Int32Array(cells);
    rt.firstStep = new Int32Array(cells);
    rt.queueX = new Int32Array(cells);
    rt.queueY = new Int32Array(cells);
    rt.stamp = 0;
  }
  if (rt.stamp >= 0x7fffffff) {
    rt.friend.fill(0);
    rt.block.fill(0);
    rt.hostile.fill(0);
    rt.anyHostile.fill(0);
    rt.seen.fill(0);
    rt.stamp = 0;
  }
  const stamp = (rt.stamp += 1);
  const friend = rt.friend;
  const block = rt.block;
  const hostile = rt.hostile;
  const anyHostile = rt.anyHostile;
  const seen = rt.seen;
  const firstStep = rt.firstStep;
  const queueX = rt.queueX;
  const queueY = rt.queueY;
  const start = selfY * width + selfX;

  // Pass 1 — the tiles other ants of its colony stand on in this nest (`friend`),
  // those a lower-id one claims in the occupancy pass (`block`), and whether a
  // lower-id one shares its own tile.
  const self = ants.colonyId[id]!;
  let ownTileHeld = false;
  for (let o = 0; o < ants.alive.length; o++) {
    if (o === id || ants.alive[o] !== 1 || ants.colonyId[o] !== self) continue;
    if (ants.zone[o] !== Zone.Underground || ants.currentGridColonyId[o] !== gridColonyId) {
      continue;
    }
    const ox = ants.posX[o]! >> FP_SHIFT;
    const oy = ants.posY[o]! >> FP_SHIFT;
    if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue;
    const cell = oy * width + ox;
    friend[cell] = stamp;
    if (o < id) {
      if (cell === start) ownTileHeld = true;
      if (!claimsNoTile(world, o)) block[cell] = stamp;
    }
  }
  // Pass 2 — the tiles holding a hostile (`anyHostile`), and of those the ones not
  // saturated for it (`hostile`, free).
  let hostiles = 0;
  for (let o = 0; o < ants.alive.length; o++) {
    if (ants.alive[o] !== 1) continue;
    const cid = ants.colonyId[o]!;
    if (cid === self || cid === 0) continue; // own colony, or neutral (never in combat)
    if (ants.zone[o] !== Zone.Underground || ants.currentGridColonyId[o] !== gridColonyId) {
      continue;
    }
    const hx = ants.posX[o]! >> FP_SHIFT;
    const hy = ants.posY[o]! >> FP_SHIFT;
    if (hx < 0 || hy < 0 || hx >= width || hy >= height) continue;
    const cell = hy * width + hx;
    anyHostile[cell] = stamp;
    hostiles++;
    if (cell === start ? ownTileHeld : friend[cell] === stamp) continue;
    hostile[cell] = stamp;
  }
  if (hostiles === 0) return NO_FREE_HOSTILE;

  // Pass 3 — BFS from its tile, fixed N/E/S/W order, through tiles a fighter can
  // enter and no lower-id friend claims (unless friends stack there), to the first
  // tile holding a free hostile; each cell carries the first step of the path to it.
  // On the way it notes the nearest QUEUE: the first saturated hostile's tile it
  // reaches, or the tile next to the first one a friend's claim keeps it off.
  let blocked = false;
  let queueStep = NO_FREE_HOSTILE;
  seen[start] = stamp;
  firstStep[start] = packStep(0, 0);
  queueX[0] = selfX;
  queueY[0] = selfY;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cx = queueX[head]!;
    const cy = queueY[head]!;
    head++;
    const cell = cy * width + cx;
    if (hostile[cell] === stamp) return firstStep[cell]!;
    if (anyHostile[cell] === stamp && queueStep === NO_FREE_HOSTILE) queueStep = firstStep[cell]!;
    for (let i = 0; i < DIR_DX.length; i++) {
      const nx = cx + DIR_DX[i]!;
      const ny = cy + DIR_DY[i]!;
      // canEnterUndergroundTile bounds-checks and rejects Solid/Marked terrain.
      if (!canEnterUndergroundTile(grid, nx, ny, AntTask.Fighting)) continue;
      const ncell = ny * width + nx;
      if (seen[ncell] === stamp) continue;
      seen[ncell] = stamp;
      // A free hostile's tile holds no friend; a tile a lower-id friend claims is
      // a way through only where friends stack.
      if (
        block[ncell] === stamp &&
        !isOccupancyExempt(world, gridColonyId, Zone.Underground, nx, ny)
      ) {
        blocked = true;
        if (anyHostile[ncell] === stamp && queueStep === NO_FREE_HOSTILE) {
          queueStep = firstStep[cell]!; // up to the tile beside it, then hold
        }
        continue;
      }
      firstStep[ncell] = cell === start ? packStep(DIR_DX[i]!, DIR_DY[i]!) : firstStep[cell]!;
      queueX[tail] = nx;
      queueY[tail] = ny;
      tail++;
    }
  }

  // No free hostile it can reach past its friends. Which hostiles do the tunnels
  // reach when friends are ignored? (Only asked when a friend was in the way; a
  // fresh `seen` stamp, `hostile`/`anyHostile` keep this call's.)
  let freeBeyond = false;
  let anyBeyond = false;
  if (blocked && rt.stamp < 0x7fffffff) {
    const reach = (rt.stamp += 1);
    seen[start] = reach;
    queueX[0] = selfX;
    queueY[0] = selfY;
    head = 0;
    tail = 1;
    while (head < tail && !freeBeyond) {
      const cx = queueX[head]!;
      const cy = queueY[head]!;
      head++;
      const cell = cy * width + cx;
      if (hostile[cell] === stamp) freeBeyond = true;
      if (anyHostile[cell] === stamp) anyBeyond = true;
      for (let i = 0; i < DIR_DX.length; i++) {
        const nx = cx + DIR_DX[i]!;
        const ny = cy + DIR_DY[i]!;
        if (!canEnterUndergroundTile(grid, nx, ny, AntTask.Fighting)) continue;
        const ncell = ny * width + nx;
        if (seen[ncell] === reach) continue;
        seen[ncell] = reach;
        queueX[tail] = nx;
        queueY[tail] = ny;
        tail++;
      }
    }
  }
  // A free hostile beyond its friends: hold its place until they move on.
  if (freeBeyond) return packStep(0, 0);
  // Else the nearest queue by path (one metric throughout, V59).
  if (queueStep !== NO_FREE_HOSTILE) return queueStep;
  // Hostiles only beyond its friends: hold.
  if (anyBeyond) return packStep(0, 0);
  return NO_FREE_HOSTILE;
}
