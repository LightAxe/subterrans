// src/sim/raid-order.ts
// #352 (V60) — a colony's raid order: the raid type its rally carries, and the
// enemy entrance a rally targets. Shared by the raid (ant/ant-raid.ts), blockade
// (ant/ant-blockade.ts) and fighter-routing (ant/ant-combat-targeting.ts) behaviour
// modules, which may not import one another (#212 layering), so it lives at the sim
// root like hunger.ts. Reads only; no module-level state.
import type { ColonyRecord } from './colony/colony-store.js';
import type { NestEntrance } from './colony/entrance.js';
import { RaidType } from './enums.js';
import { SIM_VERSION_V60_RAID_ORDERS, type WorldState } from './types.js';

/**
 * The raid type `colony`'s fighters act by: its stored `raidType` from V60, Loot
 * before (the only raid there was). It matters only while the rally is on an enemy
 * entrance; a colony whose rally is anywhere else behaves the same whatever it holds.
 */
export function colonyRaidType(world: WorldState, colony: ColonyRecord): RaidType {
  return world.simVersion >= SIM_VERSION_V60_RAID_ORDERS ? colony.raidType : RaidType.Loot;
}

/**
 * The entrance of ANOTHER colony that `colony`'s rally point sits on (open or
 * closed), or null: no rally, or the rally is not on another colony's entrance.
 * Colonies in key order, entrances in list order (tiles are unique per entrance).
 */
export function rallyEnemyEntrance(world: WorldState, colony: ColonyRecord): NestEntrance | null {
  const rp = colony.rallyPoint;
  if (rp == null) return null;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const other = world.colonies[key as unknown as keyof typeof world.colonies]!;
    if (other.colonyId === colony.colonyId) continue;
    const ents = other.entrances;
    if (ents == null) continue;
    for (let e = 0; e < ents.length; e++) {
      const ent = ents[e]!;
      if (ent.surfaceTileX === rp.tileX && ent.surfaceTileY === rp.tileY) return ent;
    }
  }
  return null;
}

/**
 * #352 (V60) — the enemy entrance `colony` is blockading: its raid type is Blockade
 * and its rally is on another colony's entrance (open or closed — fighters hold the
 * ground round a shaft still being dug as well). Null otherwise, and always below V60.
 */
export function blockadedEntrance(world: WorldState, colony: ColonyRecord): NestEntrance | null {
  if (colonyRaidType(world, colony) !== RaidType.Blockade) return null;
  return rallyEnemyEntrance(world, colony);
}
