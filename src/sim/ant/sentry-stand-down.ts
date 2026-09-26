// #332 (V47) — surplus sentries stand down to work. Layer-1 ant behaviour
// (issue #212): depends only on Layer 0 and the sim core, re-exported through
// the ant-system barrel for tick.ts's step-8 allocation checkpoint.
import { FIGHT_AGGRO_RADIUS, SURFACE_GRID_HEIGHT, SURFACE_GRID_WIDTH } from '../constants.js';
import { AntTask, FightingSubState } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import { Zone } from '../terrain.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';
import { getScratch } from '../scratch.js';

/** An enemy ant this close (sight, plus the one step it can take before step
 *  10c reacts) keeps a sentry at its post: it is about to chase. */
const STAND_DOWN_ENEMY_RADIUS = FIGHT_AGGRO_RADIUS + 1;
/** The spider this close keeps a sentry at its post: it is about to take cover.
 *  Cover fires with the spider within sight of the sentry, or within twice
 *  sight of the entrance while the sentry is within sight of the entrance, so
 *  12 bounds both. */
const STAND_DOWN_SPIDER_RADIUS = FIGHT_AGGRO_RADIUS * 3;

/**
 * #332 (V47) — release `colony`'s surplus SENTRIES to Idle. Nothing else in the
 * sim turns a fighter back into a worker, so a war ratio left most of a colony
 * fighters for good. While the colony has more than one fighter over
 * `computedAllocation.fight`, all but one of the surplus stand down (the spare
 * absorbs the ±1 wobble of the allocation), highest entity id first.
 *
 * Only settled sentries go: Holding its post (last pass's verdict, since step 8
 * runs before step 10c), no target, on the surface, not paired in combat, and
 * with no threat it is about to react to (enemy reach is stamped onto a surface
 * grid once per call, so each candidate is one lookup) (an enemy ant within
 * STAND_DOWN_ENEMY_RADIUS, the spider within STAND_DOWN_SPIDER_RADIUS). A colony
 * with a rally point, sent at the spider or sounding its alarm releases nobody,
 * and a fighter waiting where its entrance offers no post is never Holding.
 * A released ant is Idle for step 10a THIS tick.
 */
export function standDownSurplusSentries(world: WorldState, colony: ColonyRecord): void {
  if (colony.rallyPoint != null) return;
  if (colony.alarmActive === true) return;
  if (world.spiderPriorityColonyId === colony.colonyId) return;
  const ants = world.ants;
  let surplus = -colony.computedAllocation.fight - 1;
  for (let i = 0; i < colony.workers.length; i++) {
    const id = colony.workers[i]!;
    if (ants.alive[id] === 1 && ants.task[id] === AntTask.Fighting) surplus += 1;
  }
  if (surplus <= 0) return;

  // Stamp every surface tile within STAND_DOWN_ENEMY_RADIUS of an enemy ant, once
  // per enemy tile, so each candidate below is one lookup, never a hostile rescan.
  const scratch = getScratch(world).antTargeting;
  const cells = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;
  if (scratch.standDownThreat.length !== cells) {
    scratch.standDownThreat = new Int32Array(cells);
    scratch.standDownSources = new Int32Array(cells);
    scratch.standDownStamp = 0;
  }
  const threat = scratch.standDownThreat;
  const sources = scratch.standDownSources;
  const stamp = (scratch.standDownStamp += 1);
  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1 || ants.zone[id] !== Zone.Surface) continue;
    if (ants.colonyId[id] === colony.colonyId) continue;
    const hx = ants.posX[id]! >> FP_SHIFT;
    const hy = ants.posY[id]! >> FP_SHIFT;
    if (hx < 0 || hy < 0 || hx >= SURFACE_GRID_WIDTH || hy >= SURFACE_GRID_HEIGHT) continue;
    const src = hy * SURFACE_GRID_WIDTH + hx;
    if (sources[src] === stamp) continue;
    sources[src] = stamp;
    for (let dy = -STAND_DOWN_ENEMY_RADIUS; dy <= STAND_DOWN_ENEMY_RADIUS; dy++) {
      const y = hy + dy;
      if (y < 0 || y >= SURFACE_GRID_HEIGHT) continue;
      const span = STAND_DOWN_ENEMY_RADIUS - Math.abs(dy);
      for (let x = Math.max(0, hx - span); x <= hx + span && x < SURFACE_GRID_WIDTH; x++) {
        threat[y * SURFACE_GRID_WIDTH + x] = stamp;
      }
    }
  }
  const spider = world.spider;

  // Highest id first, in one descending pass over the entity arrays.
  for (let id = ants.alive.length - 1; id >= 0 && surplus > 0; id--) {
    if (ants.alive[id] !== 1 || ants.colonyId[id] !== colony.colonyId) continue;
    if (ants.task[id] !== AntTask.Fighting || ants.zone[id] !== Zone.Surface) continue;
    if (ants.subTask[id] !== FightingSubState.Holding || ants.targetPosX[id] !== -1) continue;
    if (ants.combatOpponentId[id] !== -1) continue;
    const ax = ants.posX[id]! >> FP_SHIFT;
    const ay = ants.posY[id]! >> FP_SHIFT;
    if (
      spider !== null &&
      Math.abs((spider.posX >> FP_SHIFT) - ax) + Math.abs((spider.posY >> FP_SHIFT) - ay) <=
        STAND_DOWN_SPIDER_RADIUS
    ) {
      continue;
    }
    if (
      ax >= 0 &&
      ay >= 0 &&
      ax < SURFACE_GRID_WIDTH &&
      ay < SURFACE_GRID_HEIGHT &&
      threat[ay * SURFACE_GRID_WIDTH + ax] === stamp
    ) {
      continue;
    }
    ants.task[id] = AntTask.Idle;
    ants.subTask[id] = 0;
    surplus -= 1;
  }
}
