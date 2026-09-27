// src/sim/ant/ant-blockade.ts
// #212 Layer 1 (behavior): the Blockade raid order (#352, V60). Depends only on
// Layer-0 ant-motion (+ sibling sim modules: the raid order, the scratch arena,
// the surface component). tick.ts calls updateBlockaders (step 10c2); the
// orchestrator (ant-movement.ts) asks the two predicates at the shafts.
//
// A blockade, in one paragraph. A colony whose rally is on an enemy entrance with
// raid type Blockade never goes down: its fighters hold a ring of posts round that
// entrance on the surface (BLOCKADE_POST_RADIUS_TILES from it, a second ring one
// tile further out for any more) and go for every enemy ant — fighters included,
// the queen too — that comes within BLOCKADE_RADIUS_TILES of the entrance. An enemy
// that leaves that radius is let go and the blockader walks back to its post; one
// farther than BLOCKADE_LEASH_TILES from the entrance (arriving, or back from a
// meal) chases nothing and walks to the entrance round obstacles (the surface goal
// field, as a V57 tunnel defender does), taking its post once inside the leash. Hunger works as for any rallied
// fighter (step 10c walks a hungry one home to eat), the spider as for any rallied
// fighter (a spider priority, step 10d, overrides the blockade; otherwise the
// blockaders pay it no mind), and a blockader caught in an enemy nest when the
// order is given climbs out the way a recalled invader does.
//
// Hand-off: step 10c (updateFightAntTargets) routes every fighter as before up to
// the rally routing, and there leaves a surface fighter of a blockading colony to
// this module by marking it in `getScratch(world).blockade.mark`; step 10c2 reads
// the mark. Holding is this pass's verdict, like a sentry's: step 10c clears it
// first and records "was holding" in the mark.
//
// Determinism: integers only, no `/`, no RNG, no module-level mutable state (all
// buffers live in the per-world scratch arena). Fighters are visited in ascending
// id order and take posts in that order. Every rule is behind
// `blockadedEntrance`, which is null below V60.
import type { ColonyRecord } from '../colony/colony-store.js';
import type { NestEntrance } from '../colony/entrance.js';
import {
  BLOCKADE_LEASH_TILES,
  BLOCKADE_POST_RADIUS_TILES,
  BLOCKADE_RADIUS_TILES,
} from '../constants.js';
import { AntTask, FightingSubState } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import { blockadedEntrance, isAnyEntranceTile } from '../raid-order.js';
import {
  BLOCKADE_MARK_AT_POST,
  BLOCKADE_MARK_HELD,
  BLOCKADE_MARK_ROUTED,
  BLOCKADE_MARK_TO_POST,
  BLOCKADE_MARK_WALKING,
  getScratch,
} from '../scratch.js';
import { isSurfaceTileInComponent } from '../surface-features.js';
import { Zone } from '../terrain.js';
import { SIM_VERSION_V60_RAID_ORDERS, type WorldState } from '../types.js';
import { canEnterSurfaceTile } from './ant-motion.js';

/** A blockader within this many tiles (Manhattan) of its post holds there. */
const BLOCKADE_HOLD_RADIUS_TILES = 1;
/** One already holding keeps holding within this (an occupancy bump moves it a tile). */
const BLOCKADE_KEEP_HOLD_RADIUS_TILES = BLOCKADE_HOLD_RADIUS_TILES + 1;

/** Fighter `id`'s colony is blockading an enemy entrance (V60). */
function onBlockade(world: WorldState, id: number): boolean {
  if (world.simVersion < SIM_VERSION_V60_RAID_ORDERS) return false;
  if (world.ants.task[id] !== AntTask.Fighting) return false;
  const colony = world.colonies[world.ants.colonyId[id]!];
  return colony !== undefined && blockadedEntrance(world, colony) !== null;
}

/**
 * The descent rule, for tickAntMovement's descent block: true bars fighter `id`
 * from going down a FOREIGN entrance — its colony is blockading one (a blockade
 * never goes in, even when a chase takes a blockader onto the shaft tile).
 */
export function blockaderBarredFromShaft(world: WorldState, id: number): boolean {
  return onBlockade(world, id);
}

/**
 * Fighter `id`, below ground in a FOREIGN nest, climbs out: its colony is
 * blockading an enemy entrance (the order came while it was inside). The
 * orchestrator walks it out as it does a recalled invader — by the nest's entrance
 * flow field, else the reachable-exit step — and lets it ascend.
 */
export function blockaderLeavesForeignNest(world: WorldState, id: number): boolean {
  const ants = world.ants;
  if (ants.zone[id] !== Zone.Underground) return false;
  if (ants.currentGridColonyId[id] === ants.colonyId[id]) return false;
  return onBlockade(world, id);
}

/**
 * Step 10c2 sent surface blockader `id` to a fixed tile this tick — its blockaded
 * entrance from beyond BLOCKADE_LEASH_TILES, or its post: step 16 steps it down the
 * surface goal field seeded at its target tile, round obstacles, not in a straight
 * line (straight at a tile behind an obstacle pinned it). A chase stays straight
 * (the target moves). Same-tick scratch.
 */
export function blockaderRoutesToTarget(world: WorldState, id: number): boolean {
  const mark = getScratch(world).blockade.mark;
  if (id >= mark.length) return false;
  return mark[id] === BLOCKADE_MARK_ROUTED || mark[id] === BLOCKADE_MARK_TO_POST;
}

/**
 * The occupancy rule: blockader `id` neither claims a tile nor is bumped while it
 * walks to its post or holds it. Posts go by rank, not nearness, so one bound for
 * the far side of the ring crosses the holders' tiles; bumped back off them every
 * tick it froze there (the sentry freeze V43 fixed the same way), and a holder
 * claiming its tile would bump the colony's own workers off the ring.
 */
export function blockaderPassesThroughFriends(world: WorldState, id: number): boolean {
  const mark = getScratch(world).blockade.mark;
  if (id >= mark.length) return false;
  return mark[id] === BLOCKADE_MARK_TO_POST || mark[id] === BLOCKADE_MARK_AT_POST;
}

/**
 * The ring of posts round `ent`: every surface tile at Manhattan distance
 * BLOCKADE_POST_RADIUS_TILES from it, then every one a tile further out, each ring
 * clockwise from due north — keeping only tiles a fighter can stand on (walkable,
 * in the surface component) that are no colony's entrance. Written into `out` as
 * [x0, y0, x1, y1, …].
 */
function buildPosts(world: WorldState, ent: NestEntrance, out: number[]): void {
  out.length = 0;
  for (let r = BLOCKADE_POST_RADIUS_TILES; r <= BLOCKADE_POST_RADIUS_TILES + 1; r++) {
    // Four sides of the diamond, each r tiles long: N→E, E→S, S→W, W→N.
    for (let side = 0; side < 4; side++) {
      for (let k = 0; k < r; k++) {
        let dx: number;
        let dy: number;
        if (side === 0) {
          dx = k;
          dy = k - r;
        } else if (side === 1) {
          dx = r - k;
          dy = k;
        } else if (side === 2) {
          dx = -k;
          dy = r - k;
        } else {
          dx = k - r;
          dy = -k;
        }
        const x = ent.surfaceTileX + dx;
        const y = ent.surfaceTileY + dy;
        if (!canEnterSurfaceTile(world, x, y) || !isSurfaceTileInComponent(world, x, y)) continue;
        if (isAnyEntranceTile(world, x, y)) continue;
        out.push(x, y);
      }
    }
  }
}

/**
 * The surface enemy ants — every live ant of a colony other than `colonyId`
 * (workers, fighters and the queen) — within BLOCKADE_RADIUS_TILES (Manhattan) of
 * `ent`, in id order, into `out`. One scan per entrance and colony per pass.
 */
function collectIntruders(
  world: WorldState,
  colonyId: number,
  ent: NestEntrance,
  out: number[],
): void {
  out.length = 0;
  const ants = world.ants;
  for (let o = 0; o < world.nextEntityId; o++) {
    if (ants.alive[o] !== 1 || ants.zone[o] !== Zone.Surface) continue;
    const c = ants.colonyId[o]!;
    if (c === colonyId || world.colonies[c] === undefined) continue;
    const ex = (ants.posX[o]! >> FP_SHIFT) - ent.surfaceTileX;
    const ey = (ants.posY[o]! >> FP_SHIFT) - ent.surfaceTileY;
    if ((ex < 0 ? -ex : ex) + (ey < 0 ? -ey : ey) <= BLOCKADE_RADIUS_TILES) out.push(o);
  }
}

/** Of `intruders`, the one nearest blockader `id` (Manhattan; lower id on a tie), or -1. */
function nearestOf(world: WorldState, id: number, intruders: readonly number[]): number {
  const ants = world.ants;
  const ax = ants.posX[id]! >> FP_SHIFT;
  const ay = ants.posY[id]! >> FP_SHIFT;
  let best = -1;
  let bestDist = 0;
  for (let i = 0; i < intruders.length; i++) {
    const o = intruders[i]!;
    const dx = (ants.posX[o]! >> FP_SHIFT) - ax;
    const dy = (ants.posY[o]! >> FP_SHIFT) - ay;
    const d = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
    if (best < 0 || d < bestDist) {
      best = o;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Step 10c2 (V60; after 10c, before the spider priority 10d, which overrides it):
 * route the surface fighters step 10c left to the blockade (`blockade.mark`), in
 * ascending id order. For each, with `ent` its colony's blockaded entrance:
 *   - in a duel with an enemy ant → stay on it (a fight is never dropped mid-way
 *     because the foe stepped out of the radius);
 *   - farther than BLOCKADE_LEASH_TILES from `ent` → target `ent`, routed round
 *     obstacles (ROUTED);
 *   - the nearest intruder (collectIntruders) → target it, straight at it;
 *   - else its post: the rank-th post of `ent`'s ring (rank = its order among its
 *     colony's blockaders this pass; past the last post the ring wraps). Within
 *     BLOCKADE_HOLD_RADIUS_TILES of the post (BLOCKADE_KEEP_HOLD_RADIUS_TILES if it
 *     was holding) it holds (Holding, no target; AT_POST), else it walks to the
 *     post routed round obstacles (TO_POST). With no post at all it holds in place.
 */
export function updateBlockaders(world: WorldState): void {
  if (world.simVersion < SIM_VERSION_V60_RAID_ORDERS) return;
  const ants = world.ants;
  const scratch = getScratch(world).blockade;
  const mark = scratch.mark;
  const posts = scratch.posts;
  const rank = scratch.rank;
  rank.clear();
  scratch.postsEntranceId = -1;
  scratch.intrudersEntranceId = -1;
  scratch.intrudersColonyId = -1;
  const n = mark.length < world.nextEntityId ? mark.length : world.nextEntityId;
  for (let id = 0; id < n; id++) {
    const m = mark[id]!;
    if (m === 0) continue;
    const colonyId = ants.colonyId[id]!;
    const colony: ColonyRecord | undefined = world.colonies[colonyId];
    if (colony === undefined) continue;
    const ent = blockadedEntrance(world, colony);
    if (ent === null) continue;
    const r = rank.get(colonyId) ?? 0;
    rank.set(colonyId, r + 1);

    const foeInDuel = ants.combatOpponentId[id]!;
    if (foeInDuel >= 0 && ants.alive[foeInDuel] === 1) {
      ants.targetPosX[id] = ants.posX[foeInDuel]!;
      ants.targetPosY[id] = ants.posY[foeInDuel]!;
      continue;
    }
    const ax = ants.posX[id]! >> FP_SHIFT;
    const ay = ants.posY[id]! >> FP_SHIFT;
    const ex = ax - ent.surfaceTileX;
    const ey = ay - ent.surfaceTileY;
    if ((ex < 0 ? -ex : ex) + (ey < 0 ? -ey : ey) > BLOCKADE_LEASH_TILES) {
      // Beyond the leash: make for the entrance, round obstacles (step 16 steps it
      // down the surface goal field seeded there); its post takes over once in.
      ants.targetPosX[id] = (ent.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
      ants.targetPosY[id] = (ent.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
      mark[id] = BLOCKADE_MARK_ROUTED;
      continue;
    }
    if (scratch.intrudersEntranceId !== ent.entranceId || scratch.intrudersColonyId !== colonyId) {
      collectIntruders(world, colonyId, ent, scratch.intruders);
      scratch.intrudersEntranceId = ent.entranceId;
      scratch.intrudersColonyId = colonyId;
    }
    const foe = nearestOf(world, id, scratch.intruders);
    if (foe >= 0) {
      ants.targetPosX[id] = ants.posX[foe]!;
      ants.targetPosY[id] = ants.posY[foe]!;
      mark[id] = BLOCKADE_MARK_WALKING;
      continue;
    }

    if (scratch.postsEntranceId !== ent.entranceId) {
      buildPosts(world, ent, posts);
      scratch.postsEntranceId = ent.entranceId;
    }
    const count = posts.length >> 1;
    if (count === 0) {
      ants.targetPosX[id] = -1;
      ants.targetPosY[id] = -1;
      mark[id] = BLOCKADE_MARK_WALKING;
      continue;
    }
    let slot = r;
    while (slot >= count) slot -= count;
    const px = posts[slot * 2]!;
    const py = posts[slot * 2 + 1]!;
    const dx = ax - px;
    const dy = ay - py;
    const d = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
    const hold =
      m === BLOCKADE_MARK_HELD ? BLOCKADE_KEEP_HOLD_RADIUS_TILES : BLOCKADE_HOLD_RADIUS_TILES;
    if (d <= hold) {
      ants.targetPosX[id] = -1;
      ants.targetPosY[id] = -1;
      ants.subTask[id] = FightingSubState.Holding;
      mark[id] = BLOCKADE_MARK_AT_POST;
      continue;
    }
    ants.targetPosX[id] = (px << FP_SHIFT) + (FP_ONE >> 1);
    ants.targetPosY[id] = (py << FP_SHIFT) + (FP_ONE >> 1);
    mark[id] = BLOCKADE_MARK_TO_POST;
  }
}

/**
 * Step 10d (the spider priority) retargeted blockader `id` onto the spider: it is
 * no longer walking to the entrance or a post, nor holding one.
 */
export function releaseBlockaderToSpider(world: WorldState, id: number): void {
  const mark = getScratch(world).blockade.mark;
  if (id >= mark.length || mark[id] === 0) return;
  mark[id] = 0;
  if (world.ants.subTask[id] === FightingSubState.Holding) {
    world.ants.subTask[id] = FightingSubState.MovingToRally;
  }
}
