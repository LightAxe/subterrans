// src/sim/nest-retreat.ts
// #373 (V65) — sheltering civilians retreat from invaders inside their nest.
//
// While an enemy ant is below ground in a colony's nest, that colony's SHELTERERS
// (workers holding underground on the flee timer, ants.fleeShelterUntilTick > 0 —
// the ones waiting at the shaft top under the colony alarm or after a V34 flee)
// walk by tunnel path to the chamber farthest from the invaders. Everyone else
// below ground (workers already deep in the nest, nurses, the queen) is untouched.
//
// Step 15b (tickIdleReserveAndFlee) calls computeNestRetreat once per colony, first
// thing for that colony, and keeps the colony's shelterers sheltering while it
// returns true (the nest is invaded). Step 16 (tickAntMovement) steps a shelterer by
// shelterRetreatDir instead of freezing it. The fields are per-tick scratch
// (stamped with world.tick), recomputed at step 15b before step 16 reads them, and
// nothing between the two moves an ant or changes a grid. (Within step 16 a
// lower-id invader may move before a shelterer steps; the clearance still keeps
// the shelterer off the invaders' tiles, though it can end the tick beside one.)
//
// The way to the retreat tile is checked tile by tile: a shelterer stops wherever
// it stands farther from the invaders than the retreat tile (on a looped nest that
// can be in a tunnel), as one that started there would.
//
// Sits at src/sim/ root (outside the ant-cycle graph, like fighter-orders.ts) so
// both idle-reserve.ts (a behaviour) and ant-movement.ts (the orchestrator) may use
// it. Allocation-free after the first invaded tick of a colony (buffers grow once).

import { SIM_VERSION_V65_ALARM_INVASION, type WorldState } from './types.js';
import type { ColonyRecord } from './colony/colony-store.js';
import { AntTask } from './enums.js';
import { FP_SHIFT } from './fixed.js';
import { UndergroundTileState, Zone, type UndergroundGrid } from './terrain.js';
import { getScratch, type NestRetreatField } from './scratch.js';

/** 4-cardinal steps N, E, S, W — the same encoding as ant-motion.ts DIR_DX/DIR_DY,
 *  which step 16 applies to the direction shelterRetreatDir returns. */
const STEP_DX = [0, 1, 0, -1] as const;
const STEP_DY = [-1, 0, 1, 0] as const;
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
    if (
      ants.alive[id] === 1 &&
      ants.zone[id] === Zone.Underground &&
      ants.fleeShelterUntilTick[id]! > 0 &&
      ants.currentGridColonyId[id] === cid &&
      (ants.task[id] === AntTask.Idle || ants.task[id] === AntTask.Foraging)
    ) {
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
      const nx = x + STEP_DX[d]!;
      const ny = y + STEP_DY[d]!;
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
  const ants = world.ants;
  if (ants.zone[id] !== Zone.Underground || ants.fleeShelterUntilTick[id]! <= 0) return -1;
  const task = ants.task[id]!;
  if (task !== AntTask.Idle && task !== AntTask.Foraging) return -1;
  const cid = ants.colonyId[id]!;
  if (ants.currentGridColonyId[id] !== cid) return -1;
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
      const nx = x + STEP_DX[d]!;
      const ny = y + STEP_DY[d]!;
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
  const ants = world.ants;
  if (ants.zone[id] !== Zone.Underground || ants.fleeShelterUntilTick[id]! <= 0) return false;
  const task = ants.task[id]!;
  if (task !== AntTask.Idle && task !== AntTask.Foraging) return false;
  const cid = ants.colonyId[id]!;
  if (ants.currentGridColonyId[id] !== cid) return false;
  const rec = getScratch(world).nestRetreat.get(cid);
  return rec !== undefined && rec.tick === world.tick;
}
