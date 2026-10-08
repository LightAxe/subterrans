// enemy-gathering.ts — #372: spot an enemy army gathering near one of the
// viewing colony's entrances, for the minimap ring and the army warning
// (army-warning.ts, #394/#409).
//
// The AI used to stage its army on the surface for up to a probe's length before
// it invaded (the playtest's R3: 18 fighters stood about 20 tiles from the
// player's east entrance for 30 s). This module reads such a gathering off world
// state. It is render-side and reads no AI state: any colony's fighters count, so
// it works the same for a human opponent (CLNY-08 — "enemy" is every colony that
// is not the viewer, never a fixed id). Since V64 the AI no longer stages: it
// marches its army straight from home, which enemy-march.ts reads instead.
//
//   - measureEnemyGathering / isEnemyGathering: the geometry, no memory; and
//     measureEnemyGatheringThisTick, the same memoised for one (world, viewer,
//     tick) so the warning and the minimap ring share one scan per tick. The
//     minimap rings the army whenever it holds.
//   - enemyFightersInNest and entranceDirectionName: the readings the army
//     warning (army-warning.ts) also draws on.
//
// Phaser-free: reads WorldState, never writes it; mutates only the one-entry
// render-side memo.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';
import { nearOpenEntrance } from './enemy-march.js';

/** Fewest enemy fighters near one entrance that make a gathering army. Above
 *  the AI's 3-fighter probe, well below its smallest invasion (12, Hard). */
export const GATHER_MIN_FIGHTERS = 6;

/**
 * How far (tiles, straight-line) from an entrance an enemy fighter counts as
 * near it. The AI stages on a food pile close to the player's nest; in the
 * playtest (R3) that was 20 tiles from the entrance it then invaded. Entrances
 * of opposite nests start 80 tiles apart, so this never reaches the enemy's
 * own door in a standard map.
 */
export const GATHER_RADIUS_TILES = 24;

/**
 * An enemy fighter this close (tiles) to one of its own colony's open entrances
 * is guarding home, not gathering, and is not counted. Keeps a player entrance
 * dug next to the enemy nest from reading the enemy's sentries as an army.
 */
export const GATHER_HOME_RADIUS_TILES = 8;

/** How long (ticks, 2 s) a gathering must hold before the warning fires, so a
 *  group that only brushes the edge of the radius does not raise it. (An army
 *  marching straight through the circle can still meet it: at 0.5 tile/tick it
 *  covers 20 tiles in 40 ticks. That army is at the door, so the warning is fair.) */
export const GATHER_DWELL_TICKS = 40;

export interface EnemyGathering {
  /** The viewer's open entrance with the most enemy fighters near it. */
  entrance: NestEntrance;
  /** Enemy fighters within GATHER_RADIUS_TILES of it (a fighter near two
   *  entrances counts for both, so an army between two close doors is whole). */
  fighters: number;
  /** Bounding box (tile coordinates, fractional) of those fighters. */
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
}

/**
 * The biggest group of enemy fighters on the surface near one of the viewer's
 * open entrances, or null when no enemy fighter is near any (or the viewer has
 * no open entrance). No threshold: see isEnemyGathering.
 *
 * A fighter counts when it is alive, on the surface, of another colony, doing
 * the Fighting task, within GATHER_RADIUS_TILES of one of the viewer's open
 * entrances, and not within GATHER_HOME_RADIUS_TILES of its own colony's open
 * entrances. It counts for EVERY viewer entrance it is that near, so an army
 * standing between two close entrances is not split in two. The entrance
 * returned is the one with the most such fighters; on a tie, the one they are
 * nearer to on average (then the one listed first).
 */
export function measureEnemyGathering(
  world: WorldState,
  viewerColonyId: ColonyId,
): EnemyGathering | null {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined) return null;
  const doors = viewer.entrances.filter((e) => e.isOpen);
  const n = doors.length;
  if (n === 0) return null;
  const count = new Array<number>(n).fill(0);
  const sumD = new Array<number>(n).fill(0);
  const minX = new Array<number>(n).fill(Infinity);
  const minY = new Array<number>(n).fill(Infinity);
  const maxX = new Array<number>(n).fill(-Infinity);
  const maxY = new Array<number>(n).fill(-Infinity);
  const r2 = GATHER_RADIUS_TILES * GATHER_RADIUS_TILES;
  const ants = world.ants;
  const end = Math.min(world.nextEntityId, ants.alive.length);
  for (let id = 0; id < end; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.zone[id] !== Zone.Surface) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;
    const cid = ants.colonyId[id]!;
    if (cid === viewerColonyId) continue;
    const x = ants.posX[id]! / FP_ONE;
    const y = ants.posY[id]! / FP_ONE;
    if (nearOpenEntrance(world.colonies[cid], x, y, GATHER_HOME_RADIUS_TILES)) continue;
    for (let d = 0; d < n; d++) {
      const dx = x - (doors[d]!.surfaceTileX + 0.5);
      const dy = y - (doors[d]!.surfaceTileY + 0.5);
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      count[d] = count[d]! + 1;
      sumD[d] = sumD[d]! + Math.sqrt(d2);
      if (x < minX[d]!) minX[d] = x;
      if (y < minY[d]!) minY[d] = y;
      if (x > maxX[d]!) maxX[d] = x;
      if (y > maxY[d]!) maxY[d] = y;
    }
  }
  let top = 0;
  for (let d = 1; d < n; d++) {
    // Equal counts: compare mean distance (sums over the same count).
    if (count[d]! > count[top]! || (count[d] === count[top] && sumD[d]! < sumD[top]!)) top = d;
  }
  if (count[top] === 0) return null;
  return {
    entrance: doors[top]!,
    fighters: count[top]!,
    minTileX: minX[top]!,
    minTileY: minY[top]!,
    maxTileX: maxX[top]!,
    maxTileY: maxY[top]!,
  };
}

/**
 * #372 — measureEnemyGathering, memoised for one (world, viewer, tick). GameScene
 * (the warning) and UIScene (the minimap ring) both need it every frame; the
 * world only changes when a tick runs, so the second call — and every frame of a
 * pause — reuses the first. Keyed by the WorldState object too, since a restart
 * or load swaps in a new world that can sit at the same tick.
 * Render-side memo (not sim state): it holds one result, never feeds the sim.
 */
let memoWorld: WorldState | null = null;
let memoViewer: ColonyId = -1;
let memoTick = -1;
let memoResult: EnemyGathering | null = null;
export function measureEnemyGatheringThisTick(
  world: WorldState,
  viewerColonyId: ColonyId,
): EnemyGathering | null {
  if (memoWorld !== world || memoViewer !== viewerColonyId || memoTick !== world.tick) {
    memoResult = measureEnemyGathering(world, viewerColonyId);
    memoWorld = world;
    memoViewer = viewerColonyId;
    memoTick = world.tick;
  }
  return memoResult;
}

/** True iff `g` is big enough to be an army (GATHER_MIN_FIGHTERS). */
export function isEnemyGathering(g: EnemyGathering | null): g is EnemyGathering {
  return g !== null && g.fighters >= GATHER_MIN_FIGHTERS;
}

/** Enemy fighters (any colony but the viewer's) inside the viewer's tunnels. */
export function enemyFightersInNest(world: WorldState, viewerColonyId: ColonyId): number {
  const ants = world.ants;
  const end = Math.min(world.nextEntityId, ants.alive.length);
  let n = 0;
  for (let id = 0; id < end; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.zone[id] !== Zone.Underground) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;
    if (ants.colonyId[id] === viewerColonyId) continue;
    if (ants.currentGridColonyId[id] !== viewerColonyId) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Entrance names
// ---------------------------------------------------------------------------

/**
 * The compass name of `entrance` among `colony`'s open entrances — 'east',
 * 'north-west', … — or null when a name would not single it out.
 *
 * The direction is taken from the middle (mean position) of the colony's open
 * entrances on the surface map, the nest's footprint where the player sees it.
 * The queen chamber is not used: it is underground, where only the x axis
 * lines up with the surface. Screen right is east and screen up is north. A
 * direction is diagonal when neither axis is more than twice the other (2:1
 * is still diagonal).
 *
 * Null when the colony has one open entrance (nothing to tell apart), when the
 * entrance is within a tile of the middle, or when another open entrance gets
 * the same name (three or more entrances can pair up that way).
 */
export function entranceDirectionName(colony: ColonyRecord, entrance: NestEntrance): string | null {
  const open = colony.entrances.filter((e) => e.isOpen);
  if (open.length < 2 || !open.includes(entrance)) return null;
  let cx = 0;
  let cy = 0;
  for (const e of open) {
    cx += e.surfaceTileX;
    cy += e.surfaceTileY;
  }
  cx /= open.length;
  cy /= open.length;
  const name = compassName(entrance.surfaceTileX - cx, entrance.surfaceTileY - cy);
  if (name === null) return null;
  for (const e of open) {
    if (e !== entrance && compassName(e.surfaceTileX - cx, e.surfaceTileY - cy) === name) {
      return null;
    }
  }
  return name;
}

/** Compass name of the offset (dx east, dy south) in tiles; null within a tile. */
function compassName(dx: number, dy: number): string | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) <= 1) return null;
  const ew = dx > 0 ? 'east' : 'west';
  const ns = dy > 0 ? 'south' : 'north';
  if (ay * 2 < ax) return ew;
  if (ax * 2 < ay) return ns;
  return `${ns}-${ew}`;
}
