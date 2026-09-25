// #332 (V47) — surplus sentries stand down to work. Layer-1 ant behaviour
// (issue #212): depends only on Layer 0 and the sim core, re-exported through
// the ant-system barrel for tick.ts's step-8 allocation checkpoint.
import { FIGHT_AGGRO_RADIUS } from '../constants.js';
import { AntTask, FightingSubState } from '../enums.js';
import { FP_SHIFT } from '../fixed.js';
import { Zone } from '../terrain.js';
import { SIM_VERSION_V47_SENTRY_STAND_DOWN, type WorldState } from '../types.js';
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
 * with no threat it is about to react to (an enemy ant within
 * STAND_DOWN_ENEMY_RADIUS, the spider within STAND_DOWN_SPIDER_RADIUS). A colony
 * with a rally point, sent at the spider or sounding its alarm releases nobody,
 * and a fighter waiting where its entrance offers no post is never Holding.
 * A released ant is Idle for step 10a THIS tick.
 */
export function standDownSurplusSentries(world: WorldState, colony: ColonyRecord): void {
  if (world.simVersion < SIM_VERSION_V47_SENTRY_STAND_DOWN) return;
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

  // Enemy ants on the surface, as packed tile pairs, gathered once.
  const hostiles = getScratch(world).antTargeting.standDownHostiles;
  hostiles.length = 0;
  for (let id = 0; id < ants.alive.length; id++) {
    if (ants.alive[id] !== 1 || ants.zone[id] !== Zone.Surface) continue;
    if (ants.colonyId[id] === colony.colonyId) continue;
    hostiles.push(ants.posX[id]! >> FP_SHIFT, ants.posY[id]! >> FP_SHIFT);
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
    let threatened = false;
    for (let h = 0; h < hostiles.length; h += 2) {
      if (
        Math.abs(hostiles[h]! - ax) + Math.abs(hostiles[h + 1]! - ay) <=
        STAND_DOWN_ENEMY_RADIUS
      ) {
        threatened = true;
        break;
      }
    }
    if (threatened) continue;
    ants.task[id] = AntTask.Idle;
    ants.subTask[id] = 0;
    surplus -= 1;
  }
}
