// src/sim/raid-order.ts
// #352 (V60) — a colony's raid order: the raid type its rally carries, and the
// enemy entrance a rally targets. Shared by the raid (ant/ant-raid.ts), blockade
// (ant/ant-blockade.ts) and fighter-routing (ant/ant-combat-targeting.ts) behaviour
// modules, which may not import one another (#212 layering), so it lives at the sim
// root like hunger.ts. Reads only; no module-level state.
import type { ColonyRecord } from './colony/colony-store.js';
import type { NestEntrance } from './colony/entrance.js';
import { RaidType } from './enums.js';
import type { WorldState } from './types.js';

/**
 * The entrance (open or closed) of a colony OTHER than `colonyId` whose surface
 * tile is (tileX, tileY), or null. Colonies in key order, entrances in list order
 * (tiles are unique per entrance). The one "is this another colony's entrance?"
 * scan: the sim's rally lookup, the input layer's tap / raid-menu eligibility and
 * the render layer's order caption all read it, so they cannot disagree.
 */
export function enemyEntranceAt(
  world: WorldState,
  colonyId: number,
  tileX: number,
  tileY: number,
): NestEntrance | null {
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const other = world.colonies[key as unknown as keyof typeof world.colonies]!;
    if (other.colonyId === colonyId) continue;
    const ents = other.entrances;
    if (ents == null) continue;
    for (let e = 0; e < ents.length; e++) {
      const ent = ents[e]!;
      if (ent.surfaceTileX === tileX && ent.surfaceTileY === tileY) return ent;
    }
  }
  return null;
}

/**
 * The entrance of ANOTHER colony that `colony`'s rally point sits on (open or
 * closed), or null: no rally, or the rally is not on another colony's entrance.
 */
export function rallyEnemyEntrance(world: WorldState, colony: ColonyRecord): NestEntrance | null {
  const rp = colony.rallyPoint;
  if (rp == null) return null;
  return enemyEntranceAt(world, colony.colonyId, rp.tileX, rp.tileY);
}

/**
 * #352 (V60) — the enemy entrance `colony` is blockading: its raid type is Blockade
 * and its rally is on another colony's entrance (open or closed — fighters hold the
 * ground round a shaft still being dug as well). Null otherwise.
 */
export function blockadedEntrance(world: WorldState, colony: ColonyRecord): NestEntrance | null {
  if (colony.raidType !== RaidType.Blockade) return null;
  return rallyEnemyEntrance(world, colony);
}

/** Surface tile (x, y) is an entrance (open or closed) of any colony. */
export function isEntranceTileOfAnyColony(world: WorldState, x: number, y: number): boolean {
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const ents = world.colonies[key as unknown as keyof typeof world.colonies]!.entrances;
    if (ents == null) continue;
    for (let e = 0; e < ents.length; e++) {
      if (ents[e]!.surfaceTileX === x && ents[e]!.surfaceTileY === y) return true;
    }
  }
  return false;
}
