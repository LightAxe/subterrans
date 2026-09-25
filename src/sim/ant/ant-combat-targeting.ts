// src/sim/ant/ant-combat-targeting.ts
// #212 Layer 1 (behavior): hostile/invader target selection + the inverted-BFS step
// search. Depends only on Layer-0 ant-motion primitives (+ sibling sim modules);
// only the orchestrator calls these. Owns the INV_BFS_* scratch arrays.
import { ENTRANCE_SHAFT_DEPTH, FIGHT_AGGRO_RADIUS } from '../constants.js';
import { AntTask, FightingSubState } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import { Zone, type UndergroundGrid } from '../terrain.js';
import {
  SIM_VERSION_V43_FIGHTER_SENTRIES,
  SIM_VERSION_V44_TUNNEL_DEFENCE,
  SIM_VERSION_V45_SENTRY_RING_PASSABLE,
  SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE,
  type WorldState,
} from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';
import { isSurfaceTileInComponent } from '../surface-features.js';
import { getScratch } from '../scratch.js';
import { DIR_DX, DIR_DY, canEnterUndergroundTile, packStep } from './ant-motion.js';
import type { AntComponents } from './ant-store.js';
import type { ScratchArena } from '../scratch.js';

// #212: RALLY_HOLD_RADIUS_TILES lives with its sole consumer (fighter rally hold).
const RALLY_HOLD_RADIUS_TILES = 2;

// V43 (#323) — sentry posts for fighters with no rally point. The ring sits one
// tile inside the fighters' sight (FIGHT_AGGRO_RADIUS) of the door, so every
// sentry sees an enemy standing ON the entrance tile. It also lies inside the
// entrance's guaranteed-clear halo (SURFACE_ROOT_CLEARANCE_RADIUS, Chebyshev 3).
const SENTRY_POST_RING_RADIUS = FIGHT_AGGRO_RADIUS - 1;
// V45 (#327) — the outer ring of posts, for sentries past the inner ring's count:
// ON the sight radius, so these sentries still see the entrance tile.
const SENTRY_OUTER_RING_RADIUS = FIGHT_AGGRO_RADIUS;
// A sentry within this many tiles of its post holds in place — the same
// anti-jitter role RALLY_HOLD_RADIUS_TILES plays for a rally (same-colony
// occupancy displacement bumps a doubled-up sentry onto a neighbouring tile).
const SENTRY_HOLD_RADIUS_TILES = 1;
// A sentry already holding keeps holding within this of its post. Occupancy
// displacement moves an ant one tile, so a holder bumped off its hold tile lands
// inside this radius and stays put instead of walking back onto the taken tile.
const SENTRY_KEEP_HOLD_RADIUS_TILES = SENTRY_HOLD_RADIUS_TILES + 1;
// What routeToSentryPost did with a sentry.
const SENTRY_HOME = 0; // walking home to its entrance, from outside the guard area
const SENTRY_TO_POST = 1; // walking to its post
const SENTRY_HOLD = 2; // holding its post
const SENTRY_NO_POST = 3; // its entrance has no post
// A sentry spots the spider at the same range it sees anything else.
const SENTRY_SPIDER_WATCH_RADIUS = FIGHT_AGGRO_RADIUS;
// A sentry within this of its door is AT the door: on an inner post, on one of its
// hold tiles, or nearer the door than that (a sentry that has just climbed out
// stands ON it). An outer post (V45) is at this distance itself; its hold tiles lie
// just outside.
const SENTRY_DOOR_AREA_RADIUS = SENTRY_POST_RING_RADIUS + SENTRY_HOLD_RADIUS_TILES;
// A sentry guards the area its door's ring of posts watches: everything within
// this of the door (sight 4 past the door area). It chases an enemy only inside
// it, and from farther out it walks to the door itself, as idle fighters did
// before V43, taking its post once
// inside. Without the first, one passing forager could lure a sentry across the
// map, and recalled invaders fought on at the enemy's door instead of coming home.
// Without the second, steering straight at an off-row post from across the map
// stranded more fighters against multi-tile obstacles than the old route did.
const SENTRY_GUARD_RADIUS = FIGHT_AGGRO_RADIUS + SENTRY_DOOR_AREA_RADIUS;
// While the spider is within this of a door, sentries at that door take cover.
// Past it, no inner post — nor any of its ±1 hold tiles — is within the spider
// watch radius, so a sentry coming back out to its post does not walk straight back
// into sight and turn round: the door-relative test gives cover the hysteresis a
// purely ant-relative "sees it" test lacked. (An outer post's outward hold tile can
// be in sight of a spider just past this radius; the sentry then walks in and holds
// on the post itself, out of its sight, so it does not bounce either: measured.)
const SENTRY_COVER_DOOR_RADIUS = SENTRY_SPIDER_WATCH_RADIUS + SENTRY_DOOR_AREA_RADIUS;
// A sentry sheltering below a door climbs back out only once the spider is past
// this radius of it: two tiles beyond the cover radius. The spider steps one tile a
// tick (V31+), so a spider pacing across the cover radius can neither send a
// sentry that just climbed out straight back down nor let one that just went down
// straight back out. With one shared threshold it bounced them every tick.
const SENTRY_ALL_CLEAR_RADIUS = SENTRY_COVER_DOOR_RADIUS + 2;

/** The enemy colonies a surface fighter scans (workers + queen, no copies). */
type AggroColony = { cid: number; workers: readonly number[]; queenEntityId: number };

/** V43 (#323) — (tileX, tileY) lies inside the guard area of the sentry door at
 *  (doorX, doorY). Always true for doorX < 0: a scan with no door to guard. */
function inGuardArea(tileX: number, tileY: number, doorX: number, doorY: number): boolean {
  return doorX < 0 || Math.abs(tileX - doorX) + Math.abs(tileY - doorY) <= SENTRY_GUARD_RADIUS;
}

/**
 * Point a SURFACE fighter at the nearest hostile it can see — an enemy ant
 * (worker or queen) or the spider within FIGHT_AGGRO_RADIUS Manhattan tiles of
 * it — and return true; return false (target untouched) if none is in sight.
 * A closer enemy ant beats the spider (strict <); a closer spider beats a
 * farther ant. Shared by rallied fighters (V17 ants / V23 spider) and, from V43,
 * sentries (#323), which pass their door as (guardDoorX, guardDoorY): a sentry
 * chases only enemy ants inside its guard area (within SENTRY_GUARD_RADIUS of the
 * door), and never the spider, which it takes cover from instead. Allocation-free.
 */
function targetNearestHostileInSight(
  world: WorldState,
  id: number,
  colonyId: number,
  currentGridColonyId: number,
  aggroEnemyColonies: readonly AggroColony[],
  guardDoorX = -1,
  guardDoorY = -1,
): boolean {
  const ants = world.ants;
  const aggroZone = ants.zone[id];
  const aggroTileX = ants.posX[id]! >> FP_SHIFT;
  const aggroTileY = ants.posY[id]! >> FP_SHIFT;
  let nearestEnemy = -1;
  let nearestEnemyDist = FIGHT_AGGRO_RADIUS + 1;
  // Scan enemy colony workers + queen directly (no array copies, no per-fighter allocs).
  // Indexed loops: for…of here ran this hot scan ~1.9× slower on V8.
  for (let c = 0; c < aggroEnemyColonies.length; c++) {
    const ec = aggroEnemyColonies[c]!;
    if (ec.cid === colonyId) continue;
    const workers = ec.workers;
    for (let w = 0; w < workers.length; w++) {
      const eid = workers[w]!;
      if (ants.alive[eid] !== 1) continue;
      if (ants.zone[eid] !== aggroZone) continue;
      // Underground grids are disjoint spaces — reject candidates in a different grid.
      if (aggroZone === Zone.Underground && ants.currentGridColonyId[eid] !== currentGridColonyId)
        continue;
      const eTileX = ants.posX[eid]! >> FP_SHIFT;
      const eTileY = ants.posY[eid]! >> FP_SHIFT;
      const dist = Math.abs(eTileX - aggroTileX) + Math.abs(eTileY - aggroTileY);
      if (
        dist <= FIGHT_AGGRO_RADIUS &&
        dist < nearestEnemyDist &&
        inGuardArea(eTileX, eTileY, guardDoorX, guardDoorY)
      ) {
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
      if (
        dist <= FIGHT_AGGRO_RADIUS &&
        dist < nearestEnemyDist &&
        inGuardArea(qTileX, qTileY, guardDoorX, guardDoorY)
      ) {
        nearestEnemyDist = dist;
        nearestEnemy = qid;
      }
    }
  }
  // V23 (#147): the spider is one more candidate in the same nearest-hostile scan
  // (surface-only — callers gate this to Zone.Surface). A closer enemy ant wins
  // (strict <); a closer spider wins over a farther ant. Routing the fighter onto
  // the spider's tile is enough — the widened spider-combat gate resolves the damage.
  // The spider is targetable in ANY state: fighters may pursue a Feeding spider to
  // interrupt its heal (tickSpiderV23 forfeits the heal once a fighter is adjacent).
  if (guardDoorX < 0 && world.spider !== null) {
    const spTileX = world.spider.posX >> FP_SHIFT;
    const spTileY = world.spider.posY >> FP_SHIFT;
    const dist = Math.abs(spTileX - aggroTileX) + Math.abs(spTileY - aggroTileY);
    if (dist <= FIGHT_AGGRO_RADIUS && dist < nearestEnemyDist) {
      ants.targetPosX[id] = world.spider.posX;
      ants.targetPosY[id] = world.spider.posY;
      return true;
    }
  }
  if (nearestEnemy >= 0) {
    ants.targetPosX[id] = ants.posX[nearestEnemy]!;
    ants.targetPosY[id] = ants.posY[nearestEnemy]!;
    return true;
  }
  return false;
}

/** Manhattan tile distance from the spider to (tileX, tileY); Infinity if there is
 *  no spider. */
function spiderDistance(world: WorldState, tileX: number, tileY: number): number {
  if (world.spider === null) return Number.POSITIVE_INFINITY;
  return (
    Math.abs((world.spider.posX >> FP_SHIFT) - tileX) +
    Math.abs((world.spider.posY >> FP_SHIFT) - tileY)
  );
}

/** V43 (#323) — `id` is a Fighter whose colony has no rally point: it has no orders. */
function hasNoOrders(world: WorldState, id: number): boolean {
  if (world.simVersion < SIM_VERSION_V43_FIGHTER_SENTRIES) return false;
  if (world.ants.task[id] !== AntTask.Fighting) return false;
  const colony = world.colonies[world.ants.colonyId[id]!];
  return colony !== undefined && colony.rallyPoint == null;
}

/**
 * V43 (#323) — sentry `id` is on the move among the posts round its door: step
 * 10c's sentry branch sent it this tick into cover or to its post. The same-colony
 * occupancy pass lets it through tiles its colony's ants hold instead of bumping
 * it. (Walking home from outside the guard area, or chasing, it is bumped like
 * any ant: those bumps are what slide it round obstacles, and without them more
 * fighters stranded in the field after a rally was cleared.) Sentries hold posts all round their
 * door, and one bumped back off a holder's tile every tick, on its way to a post
 * on the far side, froze there.
 */
export function sentryPassesThroughFriends(world: WorldState, id: number): boolean {
  // Not under spider priority: step 10d retargets those fighters onto the spider
  // after step 10c flagged them, and let through they all stacked on its tile.
  if (!isSentry(world, id)) return false;
  if (world.ants.zone[id] !== Zone.Surface) return false;
  // V45 (#327): a sentry HOLDING its post does not claim its tile either, so
  // workers walk through the sentry ring. Claiming it, a ring of returned
  // fighters bumped every forager back and the colony starved at its own door.
  if (
    world.simVersion >= SIM_VERSION_V45_SENTRY_RING_PASSABLE &&
    world.ants.subTask[id] === FightingSubState.Holding &&
    // Holding is only ever written with target -1; kept as a guard.
    world.ants.targetPosX[id] === -1
  )
    return true;
  const moving = getScratch(world).antTargeting.sentryMoving;
  return id < moving.length && moving[id] === 1;
}

/**
 * V43 (#323) — `id` is a SENTRY: a fighter with no orders, whose colony has not
 * sent its fighters at the spider. Under spider priority (step 10d retargets
 * surface fighters onto the spider) fighters must not take cover from it or
 * stay below while it is near: that is exactly when they were told to fight it.
 */
function isSentry(world: WorldState, id: number): boolean {
  if (!hasNoOrders(world, id)) return false;
  return world.spiderPriorityColonyId !== world.ants.colonyId[id];
}

/**
 * V43 (#323) — sentry `id`, bound for the door at (entranceX, entranceY), takes
 * cover from the spider: it sees the spider (within SENTRY_SPIDER_WATCH_RADIUS),
 * or it is at its door while the spider is within SENTRY_COVER_DOOR_RADIUS of
 * it. It then heads for the door (updateFightAntTargets) and may go down it
 * (fighterBarredFromOwnShaft). The door-relative half keeps it heading in —
 * rather than pacing between post and door — once the spider is near.
 */
export function sentryTakesCover(
  world: WorldState,
  id: number,
  entranceX: number,
  entranceY: number,
): boolean {
  if (!isSentry(world, id)) return false;
  const ants = world.ants;
  const ax = ants.posX[id]! >> FP_SHIFT;
  const ay = ants.posY[id]! >> FP_SHIFT;
  if (spiderDistance(world, ax, ay) <= SENTRY_SPIDER_WATCH_RADIUS) return true;
  const atDoor = Math.abs(ax - entranceX) + Math.abs(ay - entranceY) <= SENTRY_DOOR_AREA_RADIUS;
  return atDoor && spiderDistance(world, entranceX, entranceY) <= SENTRY_COVER_DOOR_RADIUS;
}

/**
 * V43 (#323) — a sentry sheltering in its OWN nest stays below while the spider is
 * within SENTRY_ALL_CLEAR_RADIUS of the door it would climb out of: two tiles past
 * the radius that sends sentries at the door down, so it comes back out only once
 * the spider could not send it straight back in. Called from the ascent block in
 * tickAntMovement; true means skip this ascent.
 */
export function sentryHoldsBelow(
  world: WorldState,
  id: number,
  inOwnGrid: boolean,
  entranceX: number,
  entranceY: number,
): boolean {
  if (!inOwnGrid || !isSentry(world, id)) return false;
  return spiderDistance(world, entranceX, entranceY) <= SENTRY_ALL_CLEAR_RADIUS;
}

/**
 * V43 (#323) — the own-shaft rule, for tickAntMovement's descent block: true bars
 * Fighter `id` from going down its OWN open entrance. A fighter goes down its
 * own shaft only when its colony's rally point is on that entrance (the Plan
 * 09.1-03 defensive descent) or, as a sentry, to take cover from the spider. A
 * sentry, or a fighter crossing its door on the way to a surface rally, walks
 * over it — dropping in just meant climbing straight back out next tick.
 */
export function fighterBarredFromOwnShaft(
  world: WorldState,
  id: number,
  ownColony: { rallyPoint: { tileX: number; tileY: number } | null },
  entranceX: number,
  entranceY: number,
): boolean {
  if (world.simVersion < SIM_VERSION_V43_FIGHTER_SENTRIES) return false;
  if (world.ants.task[id] !== AntTask.Fighting) return false;
  const rp = ownColony.rallyPoint;
  if (rp != null && rp.tileX === entranceX && rp.tileY === entranceY) return false;
  return !sentryTakesCover(world, id, entranceX, entranceY);
}

/**
 * V43 (#323) — the foreign-shaft rule, for tickAntMovement's descent block: true
 * bars Fighter `id` from going down a FOREIGN open entrance. Invading needs
 * orders: a fighter with no rally point — a sentry that chased an enemy onto its
 * door, or a recalled invader surfacing at the door it just left — stays out.
 */
export function fighterBarredFromForeignShaft(world: WorldState, id: number): boolean {
  return hasNoOrders(world, id);
}

/**
 * V43 (#323) — ring offset of index `i` on the ring at Manhattan distance `r`:
 * index 0 is due north and the ring runs clockwise (N → E → S → W). Written
 * with subtraction instead of division (the src/sim division ban).
 */
function sentryRingOffsetX(i: number, r: number): number {
  let d = i;
  let side = 0;
  while (d >= r) {
    d -= r;
    side += 1;
  }
  if (side === 0) return d;
  if (side === 1) return r - d;
  if (side === 2) return -d;
  return -r + d;
}
function sentryRingOffsetY(i: number, r: number): number {
  let d = i;
  let side = 0;
  while (d >= r) {
    d -= r;
    side += 1;
  }
  if (side === 0) return -r + d;
  if (side === 1) return d;
  if (side === 2) return r - d;
  return -d;
}

/** True iff (tileX, tileY) is an entrance tile of ANY colony, open or closed.
 *  `entranceTiles` is the flat [x0, y0, x1, y1, …] list updateFightAntTargets
 *  fills once per pass. A post whose hold area touches a doorway would park its
 *  sentry in the traffic in and out of a nest. */
function isAnyEntranceTile(
  entranceTiles: readonly number[],
  tileX: number,
  tileY: number,
): boolean {
  for (let i = 0; i < entranceTiles.length; i += 2) {
    if (entranceTiles[i] === tileX && entranceTiles[i + 1] === tileY) return true;
  }
  return false;
}

/** The entrance shape pickFighterTargetEntrance works over. */
type FighterEntrance = {
  entranceId: number;
  surfaceTileX: number;
  surfaceTileY: number;
  isOpen: boolean;
};

/**
 * V44 (#325) — the colony's own OPEN entrance its rally point is on, or null.
 * A rally there makes its fighters tunnel defenders — unless the colony has sent
 * its fighters at the spider (MarkSpiderPriority), which overrides it, as it does
 * for sentries.
 */
function defendedEntrance(world: WorldState, colony: ColonyRecord): FighterEntrance | null {
  if (world.simVersion < SIM_VERSION_V44_TUNNEL_DEFENCE) return null;
  // Sent at the spider (step 10d), its fighters come out to fight it instead.
  if (world.spiderPriorityColonyId === colony.colonyId) return null;
  const rp = colony.rallyPoint;
  const ents = colony.entrances;
  if (rp == null || ents == null) return null;
  for (let e = 0; e < ents.length; e++) {
    const ent = ents[e]!;
    if (ent.isOpen && ent.surfaceTileX === rp.tileX && ent.surfaceTileY === rp.tileY) return ent;
  }
  return null;
}

/**
 * V44 (#325) — fighter `id` is a TUNNEL DEFENDER below ground in its own nest:
 * its colony's rally point is on one of its own open entrances, and it stands in
 * the part of the nest that entrance's shaft reaches. It stays below (no routing
 * to an entrance, no climbing out) until the rally moves or clears. Reads the
 * reach step 10c's survey stamped this tick (surveyDefendedNests).
 */
export function fighterDefendsTunnels(world: WorldState, id: number): boolean {
  if (world.simVersion < SIM_VERSION_V44_TUNNEL_DEFENCE) return false;
  const ants = world.ants;
  if (ants.task[id] !== AntTask.Fighting || ants.zone[id] !== Zone.Underground) return false;
  const colonyId = ants.colonyId[id]!;
  if (ants.currentGridColonyId[id] !== colonyId) return false;
  const colony = world.colonies[colonyId];
  if (colony === undefined) return false;
  const defended = defendedEntrance(world, colony);
  if (defended === null) return false;
  // Only where the defended shaft reaches (this tick's survey, step 10c): a
  // fighter in a part of the nest not joined to it climbs out and walks round.
  const reach = getScratch(world).antTargeting.defenderReach.get(colonyId);
  const grid = world.undergroundGrids[colonyId];
  if (reach === undefined || grid === undefined || reach.entranceId !== defended.entranceId) {
    return false;
  }
  const tx = ants.posX[id]! >> FP_SHIFT;
  const ty = ants.posY[id]! >> FP_SHIFT;
  if (tx < 0 || tx >= grid.width || ty < 0 || ty >= grid.height) return false;
  return reach.cells[ty * grid.width + tx] === reach.stamp;
}

/**
 * V44 (#325) — tunnel defender `id` takes no part in step 16's same-colony
 * occupancy pass while it holds its post or walks to it (step 10c flagged it):
 * it neither claims a tile nor is bumped. Posts fill the tunnels at the foot of
 * the shaft, the way every worker comes and goes; a holder claiming its tile
 * bumped foragers back off it every tick (the V40 queen livelock), trapped them
 * below and starved the queen. A walker bumped back off a holder's tile in a
 * one-tile tunnel never reached a post beyond it. (A defender chasing an invader
 * is bumped like any ant.)
 */
export function defenderPassesThroughFriends(world: WorldState, id: number): boolean {
  if (!fighterDefendsTunnels(world, id)) return false;
  if (world.ants.targetPosX[id] === -1) return true;
  const moving = getScratch(world).antTargeting.sentryMoving;
  return id < moving.length && moving[id] === 1;
}

/**
 * V44 (#325) — the step tunnel defender `id` takes this tick toward its target
 * (an invader or its post, in its own grid's coordinates; written by step 10c),
 * through passable tunnel by BFS. (0, 0) if it has no target or none is reachable.
 */
export function defenderUndergroundStep(world: WorldState, id: number): number {
  const ants = world.ants;
  const grid = world.undergroundGrids[ants.colonyId[id]!];
  if (grid === undefined || ants.targetPosX[id] === -1) return packStep(0, 0);
  return pickInvaderUndergroundStep(
    grid,
    ants.posX[id]! >> FP_SHIFT,
    ants.posY[id]! >> FP_SHIFT,
    ants.targetPosX[id]! >> FP_SHIFT,
    ants.targetPosY[id]! >> FP_SHIFT,
    getScratch(world),
  );
}

/** Grow the per-world invader-BFS buffers to `cells`, keeping every cell -1. */
function ensureInvBfs(scratch: ScratchArena, cells: number): void {
  const at = scratch.antTargeting;
  if (at.invBfsDist.length < cells) {
    at.invBfsDist = new Int32Array(cells);
    at.invBfsDist.fill(-1);
    at.invBfsQX = new Int32Array(cells);
    at.invBfsQY = new Int32Array(cells);
  }
}

/**
 * V44 (#325) — the part of `colony`'s own nest reachable from the top of
 * `entrance`'s shaft: a BFS through tiles passable to a fighter, in N/E/S/W
 * order. Fills `posts` with up to `n` tunnel posts — the tiles it reaches first,
 * leaving the top ENTRANCE_SHAFT_DEPTH + 1 rows of every own entrance's shaft
 * column clear so ants still get in and out — and stamps every reached cell of
 * `reach` with `stamp`. Uses the invader-BFS scratch queue; nothing else of it.
 */
function surveyDefendedNest(
  world: WorldState,
  grid: UndergroundGrid,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  n: number,
  posts: number[],
  reach: Int32Array,
  stamp: number,
): void {
  const width = grid.width;
  const x0 = entrance.surfaceTileX;
  if (x0 < 0 || x0 >= width || grid.height <= 0) return;
  if (!canEnterUndergroundTile(grid, x0, 0, AntTask.Fighting)) return;
  const scratch = getScratch(world);
  ensureInvBfs(scratch, width * grid.height);
  const at = scratch.antTargeting;
  const qx = at.invBfsQX;
  const qy = at.invBfsQY;
  reach[x0] = stamp;
  qx[0] = x0;
  qy[0] = 0;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cx = qx[head]!;
    const cy = qy[head]!;
    head++;
    if (posts.length < n << 1 && !isOwnShaftTop(entrances, cx, cy)) posts.push(cx, cy);
    for (let i = 0; i < DIR_DX.length; i++) {
      const nx = cx + DIR_DX[i]!;
      const ny = cy + DIR_DY[i]!;
      if (!canEnterUndergroundTile(grid, nx, ny, AntTask.Fighting)) continue;
      const ncell = ny * width + nx;
      if (reach[ncell] === stamp) continue;
      reach[ncell] = stamp;
      qx[tail] = nx;
      qy[tail] = ny;
      tail++;
    }
  }
}

/**
 * V44 (#325) — step 10c, after ranking: survey each defended nest once for this
 * pass (surveyDefendedNest), for the `nextRank` defenders ranked at its entrance.
 * Its posts go in `postsByEntrance` under -1 - entranceId (apart from the sentry
 * posts), marked in `postsBuilt`; its reach in the colony's `defenderReach`
 * record, read by fighterDefendsTunnels in this tick's step 16 too.
 */
function surveyDefendedNests(
  world: WorldState,
  nextRank: Map<number, number>,
  postsByEntrance: Map<number, number[]>,
  postsBuilt: Set<number>,
): void {
  const reachByColony = getScratch(world).antTargeting.defenderReach;
  for (const cidKey in world.colonies) {
    if (!Object.hasOwn(world.colonies, cidKey)) continue;
    const col = world.colonies[cidKey as unknown as keyof typeof world.colonies];
    if (col === undefined || col.entrances == null) continue;
    const defended = defendedEntrance(world, col);
    const grid = world.undergroundGrids[col.colonyId];
    if (defended === null || grid === undefined) continue;
    const cells = grid.width * grid.height;
    let reach = reachByColony.get(col.colonyId);
    if (reach === undefined || reach.cells.length < cells) {
      reach = { cells: new Int32Array(cells), stamp: 0, entranceId: -1, invaders: [] };
      reachByColony.set(col.colonyId, reach);
    }
    reach.stamp += 1;
    reach.entranceId = defended.entranceId;
    const key = -1 - defended.entranceId;
    let posts = postsByEntrance.get(key);
    if (posts === undefined) {
      posts = [];
      postsByEntrance.set(key, posts);
    }
    posts.length = 0;
    const n = nextRank.get(defended.entranceId) ?? 0;
    surveyDefendedNest(world, grid, defended, col.entrances, n, posts, reach.cells, reach.stamp);
    reach.invaders.length = 0;
    listReachableInvaders(world, col.colonyId, grid, reach.cells, reach.stamp, reach.invaders);
    postsBuilt.add(key);
  }
}

/** (x, y) is in the top ENTRANCE_SHAFT_DEPTH + 1 rows of an own open entrance's shaft. */
function isOwnShaftTop(entrances: ReadonlyArray<FighterEntrance>, x: number, y: number): boolean {
  if (y > ENTRANCE_SHAFT_DEPTH) return false;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (ent.isOpen && ent.surfaceTileX === x) return true;
  }
  return false;
}

/**
 * V44 (#325) — fill `out`, in id order, with the enemy ants below ground in
 * colony `colonyId`'s grid on a tile stamped `stamp` in `reach`: the invaders its
 * defenders can get to. One scan per defended colony per pass; nothing moves
 * during step 10c, so it holds for every defender routed after it.
 */
function listReachableInvaders(
  world: WorldState,
  colonyId: number,
  grid: UndergroundGrid,
  reach: Int32Array,
  stamp: number,
  out: number[],
): void {
  const ants = world.ants;
  for (let other = 0; other < ants.alive.length; other++) {
    if (ants.alive[other] !== 1) continue;
    if (ants.zone[other] !== Zone.Underground) continue;
    if (ants.currentGridColonyId[other] !== colonyId) continue;
    if (ants.colonyId[other] === colonyId) continue;
    const tx = ants.posX[other]! >> FP_SHIFT;
    const ty = ants.posY[other]! >> FP_SHIFT;
    if (tx < 0 || tx >= grid.width || ty < 0 || ty >= grid.height) continue;
    if (reach[ty * grid.width + tx] !== stamp) continue;
    out.push(other);
  }
}

/**
 * V44 (#325) — the nearest (Manhattan; lower id on a tie) of `invaders` (in id
 * order, from listReachableInvaders) to ant `id`, or -1 if there are none.
 */
function nearestReachableInvader(
  world: WorldState,
  id: number,
  invaders: readonly number[],
): number {
  const ants = world.ants;
  const selfX = ants.posX[id]! >> FP_SHIFT;
  const selfY = ants.posY[id]! >> FP_SHIFT;
  let best = -1;
  let bestDist = -1;
  for (let i = 0; i < invaders.length; i++) {
    const other = invaders[i]!;
    const d =
      Math.abs((ants.posX[other]! >> FP_SHIFT) - selfX) +
      Math.abs((ants.posY[other]! >> FP_SHIFT) - selfY);
    if (bestDist < 0 || d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

/**
 * V44 (#325) — step-10c routing for tunnel defender `id` below ground in its own
 * nest, defending `entrance`: after the nearest invader it can reach (any enemy
 * ant in the part of the nest joined to the defended shaft, however deep), else
 * to its tunnel post (entry `slot` mod count of the entrance's post list, from
 * this pass's survey, surveyDefendedNests), holding (target -1) on it. A defender
 * walking to its post is flagged in `moving` (see defenderPassesThroughFriends).
 */
function routeTunnelDefender(
  world: WorldState,
  id: number,
  entrance: FighterEntrance,
  slot: number,
  postsByEntrance: Map<number, number[]>,
  moving: Uint8Array,
): void {
  const ants = world.ants;
  const colonyId = ants.colonyId[id]!;
  const grid = world.undergroundGrids[colonyId];
  if (grid === undefined) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }
  const at = getScratch(world).antTargeting;
  const reach = at.defenderReach.get(colonyId);
  // Surveyed this pass (surveyDefendedNests), keyed apart from the sentry posts.
  const posts = postsByEntrance.get(-1 - entrance.entranceId);
  if (reach === undefined || posts === undefined) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }
  const invader = nearestReachableInvader(world, id, reach.invaders);
  if (invader !== -1) {
    ants.targetPosX[id] = ants.posX[invader]!;
    ants.targetPosY[id] = ants.posY[invader]!;
    return;
  }
  if (posts.length === 0) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }
  const k = (slot % (posts.length >> 1)) << 1;
  const px = posts[k]!;
  const py = posts[k + 1]!;
  if (ants.posX[id]! >> FP_SHIFT === px && ants.posY[id]! >> FP_SHIFT === py) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    return;
  }
  ants.targetPosX[id] = (px << FP_SHIFT) + (FP_ONE >> 1);
  ants.targetPosY[id] = (py << FP_SHIFT) + (FP_ONE >> 1);
  moving[id] = 1;
}

/**
 * V43 (#323) — the open entrance a fighter below ground in its OWN nest, at
 * (tileX, tileY), will climb out of, where that is certain: the colony's only open
 * entrance, or else the shaft it stands in (that shaft's column, in its top
 * ENTRANCE_SHAFT_DEPTH rows, where a sheltering sentry waits; lower entranceId if
 * two share the column). Null otherwise: deeper in the tunnels the entrance flow
 * field picks the shaft, so such a fighter is ranked once it surfaces.
 * (pickFighterTargetEntrance would measure its depth against the doors' surface
 * rows.)
 */
function shaftOfFighterBelow(
  entrances: ReadonlyArray<FighterEntrance>,
  tileX: number,
  tileY: number,
): FighterEntrance | null {
  let openCount = 0;
  let lastOpen: FighterEntrance | null = null;
  let inShaft: FighterEntrance | null = null;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    openCount += 1;
    lastOpen = ent;
    if (
      ent.surfaceTileX === tileX &&
      tileY < ENTRANCE_SHAFT_DEPTH &&
      (inShaft === null || ent.entranceId < inShaft.entranceId)
    ) {
      inShaft = ent;
    }
  }
  return openCount === 1 ? lastOpen : inShaft;
}

/**
 * V43 (#323) — true iff no tile of the hold area of a post at (px, py) (the post
 * and its four neighbours, SENTRY_HOLD_RADIUS_TILES = 1) is ANY colony's entrance
 * and, when `stable`, a sentry anywhere in it would still be bound for `entrance`.
 * With two open entrances close together, a post on one's ring can be nearer the
 * other: the sentry then re-binds every tick and ping-pongs between the two rings.
 */
function sentryHoldAreaQualifies(
  entranceTiles: readonly number[],
  px: number,
  py: number,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  stable: boolean,
): boolean {
  for (let n = 0; n < 5; n++) {
    const tx = n === 1 ? px + 1 : n === 2 ? px - 1 : px;
    const ty = n === 3 ? py + 1 : n === 4 ? py - 1 : py;
    if (isAnyEntranceTile(entranceTiles, tx, ty)) return false;
    if (stable && pickFighterTargetEntrance(entrances, tx, ty) !== entrance) return false;
  }
  return true;
}

/**
 * V43 (#323) — fill `out` with the sentry posts of `entrance`, as a flat
 * [x0, y0, x1, y1, …] list in spread order: ring index k·(2R−1) mod 4R for
 * k = 0, 1, 2, …, a stride coprime with the ring size 4R, so consecutive slots
 * land around the door rather than bunching. Only walkable ring tiles whose hold
 * area qualifies (sentryHoldAreaQualifies) are kept: the stable ones, or, if the
 * door has none (other own doors crowding its ring, as with three in adjacent
 * columns), any clear of entrances, and a sentry sent to one of those usually
 * walks out of the crowded spot and re-binds to a neighbouring door. Empty only
 * if no ring tile is walkable and clear of entrances: every legal entrance's ring
 * lies inside its guaranteed-clear halo (SURFACE_ROOT_CLEARANCE_RADIUS), so that
 * takes a door beside every ring tile.
 */
function listSentryPosts(
  world: WorldState,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  entranceTiles: readonly number[],
  out: number[],
): void {
  addSentryRingPosts(world, entrance, entrances, entranceTiles, SENTRY_POST_RING_RADIUS, out);
  // V45 (#327): an outer ring of posts one tile farther out, still in sight of the
  // entrance, taken once the inner ring is full, so a big garrison (fighters home
  // from an invasion) spreads out instead of stacking several to a post.
  if (world.simVersion >= SIM_VERSION_V45_SENTRY_RING_PASSABLE) {
    addSentryRingPosts(world, entrance, entrances, entranceTiles, SENTRY_OUTER_RING_RADIUS, out);
  }
}

/**
 * Append the qualifying posts of the ring at Manhattan distance `r` round
 * `entrance` to `out`, in spread order (see listSentryPosts): the stable ones, or
 * if that ring has none, any clear of entrances.
 */
function addSentryRingPosts(
  world: WorldState,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  entranceTiles: readonly number[],
  r: number,
  out: number[],
): void {
  const ringSize = 4 * r;
  const stride = 2 * r - 1;
  const before = out.length;
  for (let pass = 0; pass < 2 && out.length === before; pass++) {
    for (let k = 0; k < ringSize; k++) {
      const idx = (k * stride) % ringSize;
      const px = entrance.surfaceTileX + sentryRingOffsetX(idx, r);
      const py = entrance.surfaceTileY + sentryRingOffsetY(idx, r);
      if (!isSurfaceTileInComponent(world, px, py)) continue;
      if (!sentryHoldAreaQualifies(entranceTiles, px, py, entrance, entrances, pass === 0)) {
        continue;
      }
      out.push(px, py);
    }
  }
}

/**
 * V43 (#323) — `entrance`'s sentry posts (listSentryPosts), built once per pass.
 * #328 (V46): only the ones it OWNS (sentryPostOwner). Entrances close together
 * list the same ring tiles, and an entrance handing out a post another entrance
 * owned sent a sentry back and forth between the two every tick.
 */
function sentryPostsOf(
  world: WorldState,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  entranceTiles: readonly number[],
  postsByEntrance: Map<number, number[]>,
  postsBuilt: Set<number>,
): number[] {
  let posts = postsByEntrance.get(entrance.entranceId);
  if (posts === undefined) {
    posts = [];
    postsByEntrance.set(entrance.entranceId, posts);
  }
  if (!postsBuilt.has(entrance.entranceId)) {
    posts.length = 0;
    if (world.simVersion < SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE) {
      listSentryPosts(world, entrance, entrances, entranceTiles, posts);
    } else {
      const raw = rawSentryPostsOf(world, entrance, entrances, entranceTiles);
      for (let k = 0; k < raw.length; k += 2) {
        if (sentryPostOwner(world, raw[k]!, raw[k + 1]!, entrances, entranceTiles) === entrance) {
          posts.push(raw[k]!, raw[k + 1]!);
        }
      }
    }
    postsBuilt.add(entrance.entranceId);
  }
  return posts;
}

/** #328 (V46) — every post listSentryPosts accepts for `entrance`, built once per pass. */
function rawSentryPostsOf(
  world: WorldState,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  entranceTiles: readonly number[],
): number[] {
  const scratch = getScratch(world).antTargeting;
  let posts = scratch.sentryRawPosts.get(entrance.entranceId);
  if (posts === undefined) {
    posts = [];
    scratch.sentryRawPosts.set(entrance.entranceId, posts);
  }
  if (!scratch.sentryRawPostsBuilt.has(entrance.entranceId)) {
    posts.length = 0;
    listSentryPosts(world, entrance, entrances, entranceTiles, posts);
    scratch.sentryRawPostsBuilt.add(entrance.entranceId);
  }
  return posts;
}

function listsPost(posts: readonly number[], x: number, y: number): boolean {
  for (let k = 0; k < posts.length; k += 2) {
    if (posts[k] === x && posts[k + 1] === y) return true;
  }
  return false;
}

/**
 * #328 (V46) — the one open entrance that owns post (x, y): the entrance nearest
 * it (pickFighterTargetEntrance) if that one lists it, else the lowest-id open
 * entrance that does; null if none lists it. A fixed function of the post, so a
 * sentry's binding cannot change as it steps.
 */
function sentryPostOwner(
  world: WorldState,
  x: number,
  y: number,
  entrances: ReadonlyArray<FighterEntrance>,
  entranceTiles: readonly number[],
): FighterEntrance | null {
  const nearest = pickFighterTargetEntrance(entrances, x, y);
  if (
    nearest !== null &&
    nearest.isOpen &&
    listsPost(rawSentryPostsOf(world, nearest, entrances, entranceTiles), x, y)
  ) {
    return nearest;
  }
  let best: FighterEntrance | null = null;
  for (let i = 0; i < entrances.length; i++) {
    const e = entrances[i]!;
    if (!e.isOpen) continue;
    if (best !== null && e.entranceId >= best.entranceId) continue;
    if (listsPost(rawSentryPostsOf(world, e, entrances, entranceTiles), x, y)) best = e;
  }
  return best;
}

/**
 * #328 (V46) — the entrance surface sentry `id` at (tileX, tileY) is bound for.
 * Before V46 a sentry re-picked its entrance from its own tile every tick; with
 * own entrances close together a step toward its post could land nearer another
 * entrance whose post lay back the other way, and a sentry holding a post nearer
 * another entrance re-bound and shifted the rank, and so the post, of every sentry
 * after it: sentries turned round every tick forever.
 *
 * From V46 the binding follows the sentry's POST, which does not move as it steps:
 * walking to it (ToPost), its target (serialized); holding (it held last pass, target -1), the
 * post nearest where it stands within SENTRY_KEEP_HOLD_RADIUS_TILES. It is bound
 * to the entrance that owns that post (sentryPostOwner; every post has exactly
 * one) if it is inside that entrance's guard area. (Binding every shared post to
 * the lowest-id entrance instead drained a crowded garrison onto one entrance.)
 * Anything else — walking home, taking cover, chasing, or a target the spider
 * override or a rally left — binds to its nearest entrance, as before: only a
 * target sentry routing set as the post (FightingSubState.ToPost, `previous` =
 * last pass's sub-state) is read as one. No new field.
 */
function sentryEntrance(
  world: WorldState,
  id: number,
  entrances: ReadonlyArray<FighterEntrance>,
  tileX: number,
  tileY: number,
  entranceTiles: readonly number[],
  postsByEntrance: Map<number, number[]>,
  postsBuilt: Set<number>,
  previous: number,
): FighterEntrance | null {
  const nearest = pickFighterTargetEntrance(entrances, tileX, tileY);
  if (world.simVersion < SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE) return nearest;
  const tx = world.ants.targetPosX[id]!;
  let owner: FighterEntrance | null = null;
  // Only a target sentry routing set as its post (ToPost) is read as one: a chase,
  // a rally or the spider override can leave any tile, a post included, as target.
  if (previous === FightingSubState.ToPost && tx !== -1) {
    owner = sentryPostOwner(
      world,
      tx >> FP_SHIFT,
      world.ants.targetPosY[id]! >> FP_SHIFT,
      entrances,
      entranceTiles,
    );
  } else if (previous === FightingSubState.Holding && tx === -1) {
    // The post nearest where it stands (first in entrance, then post order). An
    // entrance's post list holds only the posts it owns, so that entrance is the
    // post's owner.
    let bestDist = SENTRY_KEEP_HOLD_RADIUS_TILES + 1;
    for (let i = 0; i < entrances.length; i++) {
      const e = entrances[i]!;
      if (!e.isOpen) continue;
      // No post of an entrance this far off can be within reach.
      if (
        Math.abs(tileX - e.surfaceTileX) + Math.abs(tileY - e.surfaceTileY) >
        SENTRY_OUTER_RING_RADIUS + SENTRY_KEEP_HOLD_RADIUS_TILES
      ) {
        continue;
      }
      const posts = sentryPostsOf(world, e, entrances, entranceTiles, postsByEntrance, postsBuilt);
      for (let k = 0; k < posts.length; k += 2) {
        const d = Math.abs(posts[k]! - tileX) + Math.abs(posts[k + 1]! - tileY);
        if (d < bestDist) {
          bestDist = d;
          owner = e;
        }
      }
    }
  }
  if (
    owner !== null &&
    Math.abs(tileX - owner.surfaceTileX) + Math.abs(tileY - owner.surfaceTileY) <=
      SENTRY_GUARD_RADIUS
  ) {
    return owner;
  }
  return nearest;
}

/**
 * V43 (#323) — route sentry `id` holding `slot` to its post around the entrance
 * `entrance`. Outside its guard area (SENTRY_GUARD_RADIUS) it walks to the door
 * itself, the route home idle fighters took before V43. Inside, its post is entry
 * `slot` mod count of the door's post list (listSentryPosts, built once per door
 * per pass into `postsByEntrance`), so a door's first `count` sentries take
 * distinct posts — skipping to the next ring tile instead collapsed a run of
 * rejected tiles' slots onto one post, and sentries queued for it froze on the
 * door; past `count`, sentries share posts. (From V45 the list also holds an
 * outer ring, so that takes about 28 sentries.) It starts holding (target -1) within
 * SENTRY_HOLD_RADIUS_TILES of the post, but only on the ring or outside it, never
 * nearer the door. Once holding, it keeps holding within
 * SENTRY_KEEP_HOLD_RADIUS_TILES of the post and at most one tile inside the ring:
 * same-colony occupancy displacement bumps a holder one tile (a sentry sharing a
 * post, or one stopped on a tile a neighbour holds), and without the wider radius
 * it walked back onto the taken tile and was bumped off again every tick. (A
 * sentry walking to its post is never bumped: see sentryPassesThroughFriends.)
 * Holding is recorded as FightingSubState.Holding, so a fighter that merely
 * starts with no target (newly promoted, or stopped at a rally since cleared)
 * isn't taken for one already holding its post. Returns what it did: SENTRY_HOME,
 * SENTRY_TO_POST, SENTRY_HOLD, or SENTRY_NO_POST if the entrance has no post (see
 * listSentryPosts).
 */
function routeToSentryPost(
  world: WorldState,
  id: number,
  entrance: FighterEntrance,
  entrances: ReadonlyArray<FighterEntrance>,
  slot: number,
  entranceTiles: readonly number[],
  postsByEntrance: Map<number, number[]>,
  postsBuilt: Set<number>,
  wasHolding: boolean,
): number {
  const ants = world.ants;
  const entranceX = entrance.surfaceTileX;
  const entranceY = entrance.surfaceTileY;
  const antTileX = ants.posX[id]! >> FP_SHIFT;
  const antTileY = ants.posY[id]! >> FP_SHIFT;
  const doorDist = Math.abs(antTileX - entranceX) + Math.abs(antTileY - entranceY);
  if (doorDist > SENTRY_GUARD_RADIUS) {
    ants.targetPosX[id] = (entranceX << FP_SHIFT) + (FP_ONE >> 1);
    ants.targetPosY[id] = (entranceY << FP_SHIFT) + (FP_ONE >> 1);
    return SENTRY_HOME;
  }
  const posts = sentryPostsOf(
    world,
    entrance,
    entrances,
    entranceTiles,
    postsByEntrance,
    postsBuilt,
  );
  if (posts.length === 0) return SENTRY_NO_POST;
  const k = (slot % (posts.length >> 1)) << 1;
  const px = posts[k]!;
  const py = posts[k + 1]!;
  const postDist = Math.abs(antTileX - px) + Math.abs(antTileY - py);
  // The post's own ring: it holds only on that ring or outside it. (Inner posts all
  // lie SENTRY_POST_RING_RADIUS out; from V45 an outer post lies one farther, and
  // measured from the inner ring a sentry bound for it stopped a tile short.)
  const ring = Math.abs(px - entranceX) + Math.abs(py - entranceY);
  const holding = wasHolding && ants.targetPosX[id] === -1;
  // V45 (#327): and never beyond sight of the entrance. Inner posts' hold tiles are
  // all in sight; an outer post's outward neighbour is not, and a sentry holding
  // there could not see an enemy standing on the entrance.
  const inSight =
    world.simVersion < SIM_VERSION_V45_SENTRY_RING_PASSABLE || doorDist <= FIGHT_AGGRO_RADIUS;
  if (
    inSight &&
    (holding
      ? postDist <= SENTRY_KEEP_HOLD_RADIUS_TILES && doorDist >= ring - 1
      : postDist <= SENTRY_HOLD_RADIUS_TILES && doorDist >= ring)
  ) {
    ants.targetPosX[id] = -1;
    ants.targetPosY[id] = -1;
    ants.subTask[id] = FightingSubState.Holding;
    return SENTRY_HOLD;
  }
  ants.targetPosX[id] = (px << FP_SHIFT) + (FP_ONE >> 1);
  ants.targetPosY[id] = (py << FP_SHIFT) + (FP_ONE >> 1);
  return SENTRY_TO_POST;
}

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

/**
 * V40 (#299) — small-colony fighter stand-down. Nothing in the sim ever demotes a
 * Fighting ant (step 10a reassigns Idle ants only; fighters hold ground), so a
 * colony that collapses to 1-2 workers while they are Fighting keeps zero foragers
 * and starves — the render-side survival policy can only steer NEW assignments
 * through the ratio. Called from the step-8 allocation checkpoint only when the
 * colony is below NURSE_MIN_WORKERS living workers (tick.ts gates it to V40+ via
 * `nurseMinWorkersFor`, so pre-V40 worlds never reach here). Releases fighters in
 * EXCESS of `computedAllocation.fight` — never the ones the ratio still asks for,
 * so a fight-heavy ratio at 2 workers does not churn Idle→Fighting→Idle each tick.
 * A fighter inside a FOREIGN underground grid (an invader) is never released here:
 * only Fighters may be in a foreign grid (REQ-C3c descent gate), and a forager's
 * movement routes by its HOME entrance field at those coordinates — which would
 * strand it. It keeps Fighting, the rally-clear recall walks it out, and the
 * checkpoint (which runs every tick below the floor) releases it once it is home
 * or on the surface. `colony.workers` array order; no RNG. A released ant is Idle
 * for step 10a THIS tick, which promotes it into whatever the ratio needs
 * (forage, under the AI's survival ratio).
 */
export function releaseSurplusFightersBelowFloor(
  world: WorldState,
  colony: { workers: number[]; computedAllocation: { fight: number } },
): void {
  const ants = world.ants;
  let fighting = 0;
  for (let i = 0; i < colony.workers.length; i++) {
    const id = colony.workers[i]!;
    if (ants.alive[id] === 1 && ants.task[id] === AntTask.Fighting) fighting += 1;
  }
  let surplus = fighting - colony.computedAllocation.fight;
  for (let i = 0; i < colony.workers.length && surplus > 0; i++) {
    const id = colony.workers[i]!;
    if (ants.alive[id] !== 1 || ants.task[id] !== AntTask.Fighting) continue;
    if (ants.zone[id] === Zone.Underground && ants.currentGridColonyId[id] !== ants.colonyId[id]) {
      continue; // invader inside a foreign nest: walks home as a Fighter first
    }
    ants.task[id] = AntTask.Idle;
    ants.subTask[id] = 0;
    surplus -= 1;
  }
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

  // V43 (#323) — sentry slots. Each fighter of a colony with no rally point is
  // ranked, in entity-id order, among that colony's fighters bound for the same
  // entrance, so posts fill the ring in a stable order. Entity ids, not
  // colony.workers: removing a dead worker swaps the last worker into its place,
  // so ranking by that list let any worker's death reshuffle every post. (A
  // sentry's own death still moves up the sentries ranked after it.) On the
  // surface a fighter is bound for the entrance it would pick itself
  // (pickFighterTargetEntrance); sheltering in its own nest, for the shaft it will
  // climb out of, so it keeps its slot and the sentries outside keep their posts.
  // Fighters inside a FOREIGN grid (recalled invaders) are left out; they rank
  // once they surface, and then walk home. Only the ranks of fighters bound for an
  // OPEN entrance are read below.
  const sentries = world.simVersion >= SIM_VERSION_V43_FIGHTER_SENTRIES;
  let sentrySlot: Int32Array | null = null;
  let sentryMoving: Uint8Array | null = null;
  let entranceTiles: number[] | null = null;
  // entranceId → that door's sentry posts (listSentryPosts), built on first use.
  let postsByEntrance: Map<number, number[]> | null = null;
  let postsBuilt: Set<number> | null = null;
  if (sentries) {
    const scratch = getScratch(world).antTargeting;
    postsByEntrance = scratch.sentryPosts;
    postsBuilt = scratch.sentryPostsBuilt;
    postsBuilt.clear();
    scratch.sentryRawPostsBuilt.clear();
    if (scratch.sentrySlot.length < ants.alive.length) {
      scratch.sentrySlot = new Int32Array(ants.alive.length);
    }
    sentrySlot = scratch.sentrySlot;
    if (scratch.sentryMoving.length < ants.alive.length) {
      scratch.sentryMoving = new Uint8Array(ants.alive.length);
    }
    sentryMoving = scratch.sentryMoving;
    sentryMoving.fill(0);
    entranceTiles = scratch.sentryEntranceTiles;
    entranceTiles.length = 0;
    for (const cidKey in world.colonies) {
      if (!Object.hasOwn(world.colonies, cidKey)) continue;
      const c = world.colonies[cidKey as unknown as keyof typeof world.colonies];
      const ents = c?.entrances;
      if (ents == null) continue;
      for (let e = 0; e < ents.length; e++) {
        entranceTiles.push(ents[e]!.surfaceTileX, ents[e]!.surfaceTileY);
      }
    }
    // entranceId → the next rank at that entrance. (An entrance belongs to one
    // colony, and a fighter only binds to its own colony's entrances.)
    const nextRank = scratch.sentryNextRank;
    nextRank.clear();
    for (let wid = 0; wid < ants.alive.length; wid++) {
      if (ants.alive[wid] !== 1 || ants.task[wid] !== AntTask.Fighting) continue;
      const cid = ants.colonyId[wid]!;
      const col = world.colonies[cid];
      if (!col || col.entrances == null) continue;
      // V44 (#325) — tunnel defenders rank at the entrance they defend: every
      // fighter of the colony outside foreign grids, in entity-id order.
      const defended = defendedEntrance(world, col);
      if (defended !== null) {
        if (ants.zone[wid] === Zone.Underground && ants.currentGridColonyId[wid] !== cid) continue;
        const rank = nextRank.get(defended.entranceId) ?? 0;
        sentrySlot[wid] = rank;
        nextRank.set(defended.entranceId, rank + 1);
        continue;
      }
      if (col.rallyPoint != null) continue;
      const ents = col.entrances;
      if (ents.length === 0) continue;
      const tileX = ants.posX[wid]! >> FP_SHIFT;
      const tileY = ants.posY[wid]! >> FP_SHIFT;
      let e: FighterEntrance | null;
      if (ants.zone[wid] === Zone.Underground) {
        if (ants.currentGridColonyId[wid] !== cid) continue;
        e = shaftOfFighterBelow(ents, tileX, tileY);
      } else {
        e = sentryEntrance(
          world,
          wid,
          ents,
          tileX,
          tileY,
          entranceTiles,
          postsByEntrance,
          postsBuilt,
          ants.subTask[wid]!,
        );
      }
      if (e === null || !e.isOpen) continue;
      const rank = nextRank.get(e.entranceId) ?? 0;
      sentrySlot[wid] = rank;
      nextRank.set(e.entranceId, rank + 1);
    }
    // V44 (#325) — the defended nests' posts and reach, for step 10c and 16.
    surveyDefendedNests(world, nextRank, postsByEntrance, postsBuilt);
  }

  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;

    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId as unknown as keyof typeof world.colonies];
    if (colony === undefined) continue;
    // V43: Holding is only ever this pass's verdict. Clear it up front, so every
    // other branch (rally, invader, closed-entrance wait, cover, chase) leaves the
    // fighter not holding, and a sentry held at a rally that is then cleared
    // doesn't pass for one still holding its post.
    const previousSubTask = ants.subTask[id]!;
    const wasHolding = sentrySlot !== null && previousSubTask === FightingSubState.Holding;
    if (wasHolding) ants.subTask[id] = FightingSubState.MovingToRally;
    // #328 (V46): ToPost is this pass's verdict too (only V46 routing writes it).
    if (previousSubTask === FightingSubState.ToPost) {
      ants.subTask[id] = FightingSubState.MovingToRally;
    }

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

    // V44 (#325) — below ground in its own nest, where its rally entrance's shaft
    // reaches: a tunnel defender. (On the surface, or cut off below, it walks to
    // that entrance and goes down, by the routing below.)
    if (sentrySlot !== null && fighterDefendsTunnels(world, id)) {
      routeTunnelDefender(
        world,
        id,
        defendedEntrance(world, colony)!,
        sentrySlot[id]!,
        postsByEntrance!,
        sentryMoving!,
      );
      continue;
    }

    // No rally point (null or uninitialized): fall back to first entrance (idle-at-nest).
    if (rp == null) {
      // V43 (#323) — on the surface, bound for an OPEN entrance: a SENTRY. Take
      // cover from the spider (head for the door), else chase an enemy in sight
      // inside the guard area, else walk home or take the post. It never holds on
      // the entrance tile: parked there, pre-V43 idle fighters bounced down and up
      // the shaft every tick. Underground (own grid) or with only closed entrances,
      // fall through to the pre-V43 routing: climb out / wait at the shaft.
      if (sentrySlot !== null && ants.zone[id] === Zone.Surface && hasEntrances) {
        const e = sentryEntrance(
          world,
          id,
          entrances,
          ants.posX[id]! >> FP_SHIFT,
          ants.posY[id]! >> FP_SHIFT,
          entranceTiles!,
          postsByEntrance!,
          postsBuilt!,
          previousSubTask,
        );
        if (e !== null && e.isOpen) {
          // Take cover from the spider: head for the door (the descent block
          // lets a sentry taking cover down its own shaft).
          if (sentryTakesCover(world, id, e.surfaceTileX, e.surfaceTileY)) {
            ants.targetPosX[id] = (e.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
            ants.targetPosY[id] = (e.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
            sentryMoving![id] = 1;
            continue;
          }
          // Otherwise chase an enemy ANT it can see inside its guard area — never
          // the spider. (With the watch radius equal to the sight radius, cover
          // above already caught a spider in sight; the door argument keeps that
          // true if the two are ever tuned apart.)
          if (
            targetNearestHostileInSight(
              world,
              id,
              colonyId,
              currentGridColonyId,
              aggroEnemyColonies,
              e.surfaceTileX,
              e.surfaceTileY,
            )
          ) {
            continue;
          }
          const routed = routeToSentryPost(
            world,
            id,
            e,
            entrances,
            sentrySlot[id]!,
            entranceTiles!,
            postsByEntrance!,
            postsBuilt!,
            wasHolding,
          );
          if (routed === SENTRY_NO_POST) {
            // No walkable ring tile clear of entrances: hold in place rather than
            // fall back to the entrance tile.
            ants.targetPosX[id] = -1;
            ants.targetPosY[id] = -1;
          }
          // Walking to its post passes through friends; walking home from outside
          // the guard area it takes the ordinary bumps round obstacles, like any ant.
          if (routed === SENTRY_TO_POST) {
            sentryMoving![id] = 1;
            // #328 (V46): its target is its post (sentryEntrance reads this).
            if (world.simVersion >= SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE) {
              ants.subTask[id] = FightingSubState.ToPost;
            }
          }
          continue;
        }
      }
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
      if (
        targetNearestHostileInSight(world, id, colonyId, currentGridColonyId, aggroEnemyColonies)
      ) {
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
