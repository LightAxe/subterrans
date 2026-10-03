// health.ts — #400 (V71): max HP by territory, and healing while fed and safe.
//
// MAX HP BY TERRITORY. An ant's max HP depends on where it stands: COMBAT_HP_BASE
// (16) away, COMBAT_HP_BASE + COMBAT_HP_HOMEGROUND_BONUS (20) on its HOME GROUND —
// underground in its own colony's nest. The queen has the same +4 at home on top of
// her own base (COMBAT_HP_QUEEN; QUEEN_HP_HOME in her nest). Damage just lowers HP
// (combat.ts applyDamage). Leaving home lowers the max, and HP clamps down to it: a
// wounded ant keeps what it has. Coming home raises the max but does not heal.
// (Up to V70 the +4 was a hidden buffer granted on an ant's first fight at home.)
//
// HEALING. Every creature heals slowly while FED and SAFE:
//   - fed: not hungry by its hunger profile (hunger.ts hungerState === 'fed'). The
//     queen eats every tick, so for her that means she ate this tick;
//   - safe: not hit in the last HEAL_SAFE_TICKS ticks (`ants.lastHitTick`,
//     `spider.lastHitTick`, stamped by combat.ts when a blow lands).
// Ants (workers, fighters, nurses and the queen) heal only on their home ground,
// 1 HP on each tick that is a multiple of their interval (ANT_HEAL_INTERVAL_TICKS;
// the queen's QUEEN_HEAL_INTERVAL_TICKS is the same rate since #398, so from 7 HP
// she takes about 1½ minutes to heal to full). The spider has no home: it heals
// anywhere, every SPIDER_HEAL_INTERVAL_TICKS. Brood (eggs and larvae) neither heal
// nor clamp: they never leave the nest, and an egg is laid at its full home HP.
//
// Step 16f of tick(): after movement (so a step out of the nest has already lowered
// an ant's max) and before combat (so the fight sees the clamped HP); the fed check
// reads this tick's meals (step 3). Every rule is colony-agnostic (CLNY-08).
//
// Determinism: integers only, no `/`, no allocation, no module-level mutable state.
// The heal ticks are keyed on world.tick, so they need no saved clock.

import type { EntityId, WorldState } from './types.js';
import type { ColonyRecord } from './colony/colony-store.js';
import { Zone } from './terrain.js';
import {
  hungerState,
  QUEEN_HUNGER,
  SPIDER_HUNGER,
  ticksSinceMeal,
  workerHungerProfile,
} from './hunger.js';
import { tierIndex } from './ai-state.js';
import {
  ANT_HEAL_INTERVAL_TICKS,
  COMBAT_HP_BASE,
  COMBAT_HP_HOMEGROUND_BONUS,
  COMBAT_HP_QUEEN,
  HEAL_SAFE_TICKS,
  QUEEN_HEAL_INTERVAL_TICKS,
  SPIDER_HEAL_INTERVAL_TICKS,
  SPIDER_HP_FULL,
} from './constants.js';

/**
 * Ant `id` stands on its HOME GROUND: underground, in its own colony's nest. (A
 * fighter inside a foreign nest is away; so is every ant on the surface.)
 */
export function antOnHomeGround(world: WorldState, id: EntityId): boolean {
  const ants = world.ants;
  return ants.zone[id] === Zone.Underground && ants.currentGridColonyId[id] === ants.colonyId[id];
}

/**
 * Ant `id`'s max HP where it stands now: its base (COMBAT_HP_QUEEN for its colony's
 * queen, COMBAT_HP_BASE for any other ant), plus COMBAT_HP_HOMEGROUND_BONUS on its
 * home ground.
 */
export function antMaxHp(world: WorldState, id: EntityId): number {
  const colony = world.colonies[world.ants.colonyId[id]!];
  const base =
    colony !== undefined && colony.queenEntityId === id ? COMBAT_HP_QUEEN : COMBAT_HP_BASE;
  return antOnHomeGround(world, id) ? base + COMBAT_HP_HOMEGROUND_BONUS : base;
}

/**
 * A creature last hit at `lastHitTick` (-1 = never) is SAFE at `tick`: at least
 * HEAL_SAFE_TICKS ticks have passed since that blow.
 */
export function isSafeFromHits(lastHitTick: number, tick: number): boolean {
  return lastHitTick < 0 || tick - lastHitTick >= HEAL_SAFE_TICKS;
}

/**
 * One adult ant's step: clamp its HP down to its max where it stands, else heal 1 HP
 * when it is below that max, on its home ground, fed, safe, and this is one of its
 * heal ticks.
 */
function clampOrHealAnt(world: WorldState, id: EntityId, isQueen: boolean): void {
  const ants = world.ants;
  const max = antMaxHp(world, id);
  const hp = ants.hp[id]!;
  if (hp > max) {
    ants.hp[id] = max;
    return;
  }
  if (hp === max) return;
  const interval = isQueen ? QUEEN_HEAL_INTERVAL_TICKS : ANT_HEAL_INTERVAL_TICKS;
  if (world.tick % interval !== 0) return;
  if (!antOnHomeGround(world, id)) return;
  if (!isSafeFromHits(ants.lastHitTick[id]!, world.tick)) return;
  const profile = isQueen ? QUEEN_HUNGER : workerHungerProfile(world, id);
  if (hungerState(ticksSinceMeal(world, id), profile) !== 'fed') return;
  ants.hp[id] = hp + 1;
}

function tickColonyHealth(world: WorldState, colony: ColonyRecord): void {
  const ants = world.ants;
  const queenId = colony.queenEntityId;
  if (ants.alive[queenId] === 1) clampOrHealAnt(world, queenId, true);
  for (let i = 0; i < colony.workers.length; i++) {
    const id = colony.workers[i]!;
    if (ants.alive[id] !== 1) continue;
    clampOrHealAnt(world, id, false);
  }
}

/**
 * Step 16f: every colony's queen and workers clamp to, or heal toward, their max HP
 * (above), and the spider heals 1 HP on each SPIDER_HEAL_INTERVAL_TICKS tick while it
 * is below SPIDER_HP_FULL, fed (not hungry: hungerState against its tier's profile)
 * and safe — anywhere, it has no home.
 */
export function tickHealth(world: WorldState): void {
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    tickColonyHealth(world, world.colonies[key as unknown as number]!);
  }
  const spider = world.spider;
  if (
    spider !== null &&
    spider.hp > 0 &&
    spider.hp < SPIDER_HP_FULL &&
    world.tick % SPIDER_HEAL_INTERVAL_TICKS === 0 &&
    isSafeFromHits(spider.lastHitTick, world.tick) &&
    hungerState(spider.hungerTicks, SPIDER_HUNGER[tierIndex(world.difficulty)]) === 'fed'
  ) {
    spider.hp += 1;
  }
}
