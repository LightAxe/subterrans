// src/sim/ant/ant-combat-targeting.ts
// #212 Layer 1 (behavior): hostile/invader target selection + the inverted-BFS step
// search. Depends only on Layer-0 ant-motion primitives (+ sibling sim modules);
// only the orchestrator calls these. Owns the INV_BFS_* scratch arrays.
import { FIGHT_AGGRO_RADIUS } from '../constants.js';
import { AntTask } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import { Zone, type UndergroundGrid } from '../terrain.js';
import type { WorldState } from '../types.js';
import { DIR_DX, DIR_DY, canEnterUndergroundTile, packStep } from './ant-motion.js';
import type { AntComponents } from './ant-store.js';
import type { ScratchArena } from '../scratch.js';

// #212: RALLY_HOLD_RADIUS_TILES lives with its sole consumer (fighter rally hold).
const RALLY_HOLD_RADIUS_TILES = 2;

/**
 * Phase 9 / SURF-04 — route AntTask.Fighting ants to their colony's rallyPoint.
 *
 * Runs at tick.ts step 10c as a GLOBAL pass (after idle-reassignment 10a and
 * tickDigExecution 10b, before checkPendingChambers 11). Separate pass rather
 * than inline in the per-colony 10a loop because this is a per-ant task filter,
 * not a per-colony census mutation — same architectural split as Phase 7's
 * tickDeadDiggerCleanup.
 *
 * Pure-sim: reads world.colonies, writes world.ants.targetPosX/targetPosY only.
 * Deterministic: iterates ant entity IDs ascending (natural SoA order).
 *
 * @param world  WorldState (reads ants, colonies; writes ants.targetPosX/Y).
 */
/**
 * Issue #62 (v12+) — pick the entrance a fighter should route toward.
 *
 * Two-tier preference, matching the design decision in the issue:
 *   1. Nearest OPEN entrance (Manhattan distance from antTileX/Y), tie-break
 *      by `entranceId`. Same pattern as `tickAntMovement` entrance-targeting
 *      and `moveQueens` — fighter routing is the outlier we're fixing.
 *   2. Fallback when no open entrance exists: nearest CLOSED entrance.
 *      Fighters stack near the soon-to-open shaft so they're in position
 *      when `checkEntranceCompletion` flips it. The fighter will walk
 *      toward the surface column, hit the partially-excavated shaft
 *      (Marked/Solid tiles non-Diggers can't traverse), and idle adjacent
 *      to it until the shaft completes — natural "waiting at the door" feel.
 *   3. Final fallback (no entrances at all): null. Defensive only — caller
 *      already checks `hasEntrances` before calling.
 */
export function pickFighterTargetEntrance(
  entrances: ReadonlyArray<{
    entranceId: number;
    surfaceTileX: number;
    surfaceTileY: number;
    isOpen: boolean;
  }>,
  antTileX: number,
  antTileY: number,
): { entranceId: number; surfaceTileX: number; surfaceTileY: number; isOpen: boolean } | null {
  let bestOpen: (typeof entrances)[number] | null = null;
  let bestOpenDist = Infinity;
  let bestOpenId = Infinity;
  let bestClosed: (typeof entrances)[number] | null = null;
  let bestClosedDist = Infinity;
  let bestClosedId = Infinity;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    const dist = Math.abs(ent.surfaceTileX - antTileX) + Math.abs(ent.surfaceTileY - antTileY);
    if (ent.isOpen) {
      if (dist < bestOpenDist || (dist === bestOpenDist && ent.entranceId < bestOpenId)) {
        bestOpen = ent;
        bestOpenDist = dist;
        bestOpenId = ent.entranceId;
      }
    } else {
      if (dist < bestClosedDist || (dist === bestClosedDist && ent.entranceId < bestClosedId)) {
        bestClosed = ent;
        bestClosedDist = dist;
        bestClosedId = ent.entranceId;
      }
    }
  }
  return bestOpen ?? bestClosed;
}

export function updateFightAntTargets(world: WorldState): void {
  const { ants } = world;

  // Precompute: for each colony with a rally, does ANY colony have an OPEN
  // entrance at that rally tile? If yes, the hold-radius anti-oscillation
  // suppression MUST be skipped for that colony's fighters — they must walk
  // onto the EXACT entrance tile so the Surface→Underground descent block
  // in tickAntMovement can fire. This carve-out covers:
  //   - Invasion: player rallies on an enemy open entrance → fighters
  //     descend into the enemy grid (Plan 09.1-03 descent-intent gate).
  //   - Defensive descent: a colony rallies on its OWN open entrance →
  //     fighters enter their own grid. Colony-agnostic by design — the
  //     invariant "rally on entrance → descend" holds regardless of owner.
  // Complexity: O(N²·E) where N = colony count, E = entrances per colony.
  // Realistic values are tiny (2-4 colonies, 1-3 entrances each). Simplicity
  // over microperf — clarity wins for this rarely-hit guard.
  const rallyOnEntrance: Record<number, boolean> = {};
  for (const cidKey in world.colonies) {
    if (!Object.hasOwn(world.colonies, cidKey)) continue;
    const colony = world.colonies[cidKey as unknown as keyof typeof world.colonies];
    if (!colony) continue;
    const rp = colony.rallyPoint;
    if (rp == null) continue;
    let hit = false;
    for (const otherKey in world.colonies) {
      if (!Object.hasOwn(world.colonies, otherKey)) continue;
      if (hit) break;
      const other = world.colonies[otherKey as unknown as keyof typeof world.colonies];
      if (!other || !other.entrances) continue;
      for (let e = 0; e < other.entrances.length; e++) {
        const ent = other.entrances[e]!;
        if (ent.isOpen && ent.surfaceTileX === rp.tileX && ent.surfaceTileY === rp.tileY) {
          hit = true;
          break;
        }
      }
    }
    rallyOnEntrance[colony.colonyId] = hit;
  }

  // Precompute enemy colony refs for V17 aggro scan — iterate workers+queen directly
  // (no array copies; queen checked separately to avoid spreading the workers list).
  type AggroColony = { cid: number; workers: readonly number[]; queenEntityId: number };
  const aggroEnemyColonies: AggroColony[] = [];
  for (const cidKey in world.colonies) {
    if (!Object.hasOwn(world.colonies, cidKey)) continue;
    const col = world.colonies[cidKey as unknown as keyof typeof world.colonies];
    if (col)
      aggroEnemyColonies.push({
        cid: Number(cidKey),
        workers: col.workers,
        queenEntityId: col.queenEntityId,
      });
  }

  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;

    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId as unknown as keyof typeof world.colonies];
    if (colony === undefined) continue;

    const rp = colony.rallyPoint;

    // createColonyRecord intentionally leaves entrances/rallyPoint uninitialized (colony-store.ts:164);
    // callers set them post-construction. Treat both null and undefined as "no value".
    const entrances = colony.entrances;
    const hasEntrances = entrances != null && entrances.length > 0;

    // Invader in enemy underground: recall or active-fight — both handled by tickAntMovement.
    // Recall (fight===0 or rp==null): isForeignGridUnderground routes toward the enemy
    //   entrance exit; skipAscent is cleared so the ant can ascend at tileY=0.
    // Active: isForeignGridUnderground routes via pickNearestHostileUnderground.
    // This block must run before the rp==null and zone===Underground blocks so invaders
    // don't get routed to their own colony's entrance inside a foreign grid.
    const currentGridColonyId = ants.currentGridColonyId[id]!;
    if (ants.zone[id] === 1 /* Underground */ && currentGridColonyId !== colonyId) {
      // Always clear stale targets — tickAntMovement computes the correct direction.
      ants.targetPosX[id] = -1;
      ants.targetPosY[id] = -1;
      continue;
    }

    // No rally point (null or uninitialized): fall back to first entrance (idle-at-nest).
    if (rp == null) {
      if (hasEntrances) {
        // Issue #62 (v12+) — pick nearest open entrance, fallback to nearest
        // closed if none open (fighters stack near soon-to-open shafts).
        // Pre-v12 always used entrances[0] regardless of isOpen.
        const e = pickFighterTargetEntrance(
          entrances,
          ants.posX[id]! >> FP_SHIFT,
          ants.posY[id]! >> FP_SHIFT,
        );
        if (e !== null) {
          ants.targetPosX[id] = (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
          ants.targetPosY[id] = (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
        } else {
          // No entrances at all (defensive — only reachable via a future code
          // path, can't happen with hasEntrances === true). Hold in place.
          ants.targetPosX[id] = -1;
          ants.targetPosY[id] = -1;
        }
      }
      continue;
    }

    // Underground fighter with surface rally: route to nearest entrance first.
    // Zone promotion happens inside tickAntMovement when the ant crosses the shaft;
    // this pass only writes the fixed-point target coord.
    if (ants.zone[id] === 1 /* Underground */ && hasEntrances) {
      const e = pickFighterTargetEntrance(
        entrances,
        ants.posX[id]! >> FP_SHIFT,
        ants.posY[id]! >> FP_SHIFT,
      );
      if (e !== null) {
        ants.targetPosX[id] = (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
        ants.targetPosY[id] = (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
      } else {
        ants.targetPosX[id] = -1;
        ants.targetPosY[id] = -1;
      }
      continue;
    }

    // Proximity aggression: scan for nearest enemy ant within FIGHT_AGGRO_RADIUS tiles
    // in the same zone. Workers and queen are scanned; brood is underground-only so
    // it is never reachable from a surface scan. If an enemy is found, route
    // directly toward it — overrides rally and hold-radius. Phase 4 PRD §3d.
    // V17+ only; surface only (underground fighters use pickNearestHostileUnderground
    // for combat routing); suppressed when the rally is on any open entrance (own OR
    // enemy) — rallyOnEntrance is colony-agnostic (see precompute above): fighters
    // must walk to the exact tile so the descent trigger fires, whether it's an
    // invasion into an enemy grid or a defensive descent into their own grid.
    if (ants.zone[id] === Zone.Surface && !rallyOnEntrance[colony.colonyId]) {
      const aggroZone = ants.zone[id];
      const aggroTileX = ants.posX[id]! >> FP_SHIFT;
      const aggroTileY = ants.posY[id]! >> FP_SHIFT;
      let nearestEnemy = -1;
      let nearestEnemyDist = FIGHT_AGGRO_RADIUS + 1;
      // Scan enemy colony workers + queen directly (no array copies, no per-fighter allocs).
      for (const ec of aggroEnemyColonies) {
        if (ec.cid === colonyId) continue;
        for (const eid of ec.workers) {
          if (ants.alive[eid] !== 1) continue;
          if (ants.zone[eid] !== aggroZone) continue;
          // Underground grids are disjoint spaces — reject candidates in a different grid.
          if (
            aggroZone === Zone.Underground &&
            ants.currentGridColonyId[eid] !== currentGridColonyId
          )
            continue;
          const eTileX = ants.posX[eid]! >> FP_SHIFT;
          const eTileY = ants.posY[eid]! >> FP_SHIFT;
          const dist = Math.abs(eTileX - aggroTileX) + Math.abs(eTileY - aggroTileY);
          if (dist <= FIGHT_AGGRO_RADIUS && dist < nearestEnemyDist) {
            nearestEnemyDist = dist;
            nearestEnemy = eid;
          }
        }
        const qid = ec.queenEntityId;
        if (
          qid >= 0 &&
          ants.alive[qid] === 1 &&
          ants.zone[qid] === aggroZone &&
          (aggroZone !== Zone.Underground || ants.currentGridColonyId[qid] === currentGridColonyId)
        ) {
          const qTileX = ants.posX[qid]! >> FP_SHIFT;
          const qTileY = ants.posY[qid]! >> FP_SHIFT;
          const dist = Math.abs(qTileX - aggroTileX) + Math.abs(qTileY - aggroTileY);
          if (dist <= FIGHT_AGGRO_RADIUS && dist < nearestEnemyDist) {
            nearestEnemyDist = dist;
            nearestEnemy = qid;
          }
        }
      }
      // V23 (#147): the spider is one more candidate in the same nearest-hostile scan
      // (surface-only — this block is already gated to Zone.Surface). A closer enemy ant
      // wins (strict <); a closer spider wins over a farther ant. Routing the fighter onto
      // the spider's tile is enough — the widened spider-combat gate resolves the damage.
      // The spider is targetable in ANY state: fighters may pursue a Feeding spider to
      // interrupt its heal (tickSpiderV23 forfeits the heal once a fighter is adjacent).
      let nearestIsSpider = false;
      if (world.spider !== null) {
        const spTileX = world.spider.posX >> FP_SHIFT;
        const spTileY = world.spider.posY >> FP_SHIFT;
        const dist = Math.abs(spTileX - aggroTileX) + Math.abs(spTileY - aggroTileY);
        if (dist <= FIGHT_AGGRO_RADIUS && dist < nearestEnemyDist) {
          nearestEnemyDist = dist;
          nearestIsSpider = true;
        }
      }
      if (nearestIsSpider) {
        ants.targetPosX[id] = world.spider!.posX;
        ants.targetPosY[id] = world.spider!.posY;
        continue;
      }
      if (nearestEnemy >= 0) {
        ants.targetPosX[id] = ants.posX[nearestEnemy]!;
        ants.targetPosY[id] = ants.posY[nearestEnemy]!;
        continue;
      }
    }

    // No enemy in range: fall back to rally routing.
    //
    // Anti-oscillation: if the ant is already within RALLY_HOLD_RADIUS_TILES
    // Manhattan of the rally tile, clear the target to -1 so the Fighting
    // branch in tickAntMovement holds in place (dx=dy=0). Without this,
    // resolveSameColonyOccupancy bumps clustered ants one tile N/E/S/W and
    // the next tick re-writes the same rally center target → walk →
    // re-collide → re-bump → visible ABAB jitter at fp-resolution.
    //
    // Carve-out: if the rally tile IS an open entrance (any colony's), the
    // hold-radius suppression is skipped — fighters must reach the EXACT
    // entrance tile for the descent block in tickAntMovement to fire.
    if (!rallyOnEntrance[colony.colonyId]) {
      const antTileX = ants.posX[id]! >> FP_SHIFT;
      const antTileY = ants.posY[id]! >> FP_SHIFT;
      const d = Math.abs(antTileX - rp.tileX) + Math.abs(antTileY - rp.tileY);
      if (d <= RALLY_HOLD_RADIUS_TILES) {
        ants.targetPosX[id] = -1;
        ants.targetPosY[id] = -1;
        continue;
      }
    }
    ants.targetPosX[id] = (rp.tileX << FP_SHIFT) + (FP_ONE >> 1);
    ants.targetPosY[id] = (rp.tileY << FP_SHIFT) + (FP_ONE >> 1);
  }
}

/**
 * Manhattan nearest-hostile underground target selector.
 *
 * @param ants           SoA ant component storage.
 * @param selfId         EntityId of the caller (must be alive and underground).
 * @param gridColonyId   Underground-grid id the caller occupies
 *                       (ants.currentGridColonyId[selfId]). Hostiles in OTHER
 *                       grids are ignored — both the caller and the target
 *                       must share the same grid-of-occupancy.
 * @returns              Fixed-point {targetX, targetY} of the nearest hostile,
 *                       or null if no underground hostile shares the grid.
 */
export function pickNearestHostileUnderground(
  ants: AntComponents,
  selfId: number,
  gridColonyId: number,
): { targetX: number; targetY: number } | null {
  const selfColony = ants.colonyId[selfId]!;
  const selfPosX = ants.posX[selfId]!;
  const selfPosY = ants.posY[selfId]!;
  const selfTileX = selfPosX >> FP_SHIFT;
  const selfTileY = selfPosY >> FP_SHIFT;

  let bestPosX = 0;
  let bestPosY = 0;
  let bestDist = -1;

  // alive.length is a safe upper bound for iteration. Post-death slots read
  // alive=0 and are skipped. No allocation inside the loop.
  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1) continue;
    if (id === selfId) continue;
    if (ants.zone[id] !== Zone.Underground) continue;
    if (ants.currentGridColonyId[id] !== gridColonyId) continue;
    if (ants.colonyId[id] === selfColony) continue;

    const theirTileX = ants.posX[id]! >> FP_SHIFT;
    const theirTileY = ants.posY[id]! >> FP_SHIFT;
    const dx = theirTileX - selfTileX;
    const dy = theirTileY - selfTileY;
    const dist = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
    if (bestDist < 0 || dist < bestDist) {
      bestDist = dist;
      bestPosX = ants.posX[id]!;
      bestPosY = ants.posY[id]!;
    }
  }

  if (bestDist < 0) return null;
  return { targetX: bestPosX, targetY: bestPosY };
}

// #231 — the invader-BFS buffers (distance + parallel x/y FIFO) now live on the
// per-world scratch arena (scratch.antTargeting), passed into
// pickInvaderUndergroundStep. The "-1 between calls" invariant is preserved
// per-world: each world's dist buffer keeps its own touched-cell-restored state.

/**
 * @param underground  The grid the invader currently occupies.
 * @param tileX        Invader's current tile X.
 * @param tileY        Invader's current tile Y.
 * @param targetTileX  Target hostile's tile X.
 * @param targetTileY  Target hostile's tile Y.
 * @returns            Cardinal step (dx,dy) \u2208 {-1,0,1}\u00b2 moving closer to the
 *                     target through passable terrain, or (0,0) if stuck.
 */
export function pickInvaderUndergroundStep(
  underground: UndergroundGrid,
  tileX: number,
  tileY: number,
  targetTileX: number,
  targetTileY: number,
  scratch: ScratchArena,
): number {
  // Already on the target tile — nothing to do.
  if (tileX === targetTileX && tileY === targetTileY) return packStep(0, 0);

  const width = underground.width;
  const height = underground.height;
  const cells = width * height;

  // A target or self outside the grid can never be connected — hold. (Callers
  // pass in-bounds tiles; the self guard is defensive.)
  if (targetTileX < 0 || targetTileX >= width || targetTileY < 0 || targetTileY >= height) {
    return packStep(0, 0);
  }
  if (tileX < 0 || tileX >= width || tileY < 0 || tileY >= height) {
    return packStep(0, 0);
  }

  // Grow scratch on demand (one-time as grids first appear / enlarge). A fresh
  // dist buffer is filled with -1 so the "every cell is -1 between calls"
  // invariant holds from the start; each call below restores it by clearing
  // only the cells it touched (never a full-grid wipe).
  const at = scratch.antTargeting;
  if (at.invBfsDist.length < cells) {
    at.invBfsDist = new Int32Array(cells);
    at.invBfsDist.fill(-1);
    at.invBfsQX = new Int32Array(cells);
    at.invBfsQY = new Int32Array(cells);
  }
  const dist = at.invBfsDist;
  const qx = at.invBfsQX;
  const qy = at.invBfsQY;

  // BFS rooted at the target, expanding through passable tiles only in fixed
  // N/E/S/W order. Stop as soon as the invader's own tile is dequeued: at that
  // point every cell with a strictly smaller path distance — including the
  // neighbour the invader must step to — has its final distance.
  dist[targetTileY * width + targetTileX] = 0;
  let head = 0;
  let tail = 0;
  qx[tail] = targetTileX;
  qy[tail] = targetTileY;
  tail++;
  let reached = false;
  while (head < tail) {
    const cx = qx[head]!;
    const cy = qy[head]!;
    head++;
    if (cx === tileX && cy === tileY) {
      reached = true;
      break;
    }
    const nextDist = dist[cy * width + cx]! + 1;
    for (let i = 0; i < DIR_DX.length; i++) {
      const nx = cx + DIR_DX[i]!;
      const ny = cy + DIR_DY[i]!;
      // canEnterUndergroundTile bounds-checks and rejects Solid/Marked terrain.
      if (!canEnterUndergroundTile(underground, nx, ny, AntTask.Fighting)) continue;
      const ncell = ny * width + nx;
      if (dist[ncell] !== -1) continue;
      dist[ncell] = nextDist;
      qx[tail] = nx;
      qy[tail] = ny;
      tail++;
    }
  }

  // Pick the step while `dist` is still populated. When the target was
  // unreachable, `reached` is false and we fall through holding (0,0) — no wall
  // oscillation. Otherwise step to the passable cardinal neighbour with the
  // smallest path distance to the target (== selfDist - 1 along a shortest
  // path). DIR order + strict `<` break ties toward the lowest direction index
  // (N before E before S before W).
  let bestDx = 0;
  let bestDy = 0;
  if (reached) {
    let bestDist = dist[tileY * width + tileX]!;
    for (let i = 0; i < DIR_DX.length; i++) {
      const ax = DIR_DX[i]!;
      const ay = DIR_DY[i]!;
      const nx = tileX + ax;
      const ny = tileY + ay;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nd = dist[ny * width + nx]!;
      if (nd < 0) continue; // unreached this call
      if (nd < bestDist) {
        bestDist = nd;
        bestDx = ax;
        bestDy = ay;
      }
    }
  }

  // Restore the all-`-1` invariant by clearing only the cells this BFS wrote.
  // Every cell that received a distance was enqueued, so qx/qy[0..tail)
  // enumerates exactly the touched cells — the reset cost is proportional to
  // the work done, not the full grid, so dozens of invaders per tick no longer
  // each pay an O(cells) wipe.
  for (let i = 0; i < tail; i++) {
    dist[qy[i]! * width + qx[i]!] = -1;
  }

  return packStep(bestDx, bestDy);
}
