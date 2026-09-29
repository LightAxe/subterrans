// enemy-gathering.ts — #372: spot an enemy army gathering near one of the
// viewing colony's entrances, for the minimap ring and the gathering warning
// caption.
//
// The AI stages its army on the surface for up to a probe's length before it
// invades (the playtest's R3: 18 fighters stood about 20 tiles from the player's
// east entrance for 30 s, and the only warning was the invasion caption itself,
// 10 s before the queen died). This module reads that staging off world state.
// It is render-side and reads no AI state: any colony's fighters count, so it
// works the same for a human opponent (CLNY-08 — "enemy" is every colony that
// is not the viewer, never a fixed id).
//
// Two layers:
//   - measureEnemyGathering / isEnemyGathering: the geometry, no memory; and
//     measureEnemyGatheringThisTick, the same memoised for one (world, viewer,
//     tick) so the warning and the minimap ring share one scan per tick. The
//     minimap rings the army whenever it holds.
//   - GatheringWarningState + nextGatheringWarning: the caption, with
//     hysteresis so it fires once per gathering (see nextGatheringWarning).
//
// Phaser-free: reads WorldState, never writes it; mutates only its own state
// object and the one-entry render-side memo.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';

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

/** After a warning, the gathering is over (and the warning re-arms) once at most
 *  this many enemy fighters are near any entrance and none is invading... */
export const GATHER_REARM_MAX_FIGHTERS = 2;
/** ...continuously for this long (ticks, 10 s). */
export const GATHER_REARM_QUIET_TICKS = 200;

/** This many enemy fighters inside the viewer's tunnels is an invasion: the army
 *  is no longer gathering, and the invasion caption takes over. Three, not one,
 *  so a lone raider does not silence the warning. */
export const INVASION_NEST_MIN_FIGHTERS = 3;

/** How long (ticks, 10 s) a warning the busy caption queue could not take yet is
 *  still offered, the same window as the other recurring captions. */
export const GATHER_CAPTION_OWED_TICKS = 200;

/** Full-opacity hold (ms) of the warning. The default 800 ms is too short to read
 *  its two or three lines, and it shows once per gathering. */
export const GATHER_CAPTION_HOLD_MS = 4000;

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

/** True iff `x,y` (tiles) is within `r` tiles of one of `colony`'s open entrances. */
function nearOwnOpenEntrance(colony: ColonyRecord | undefined, x: number, y: number, r: number) {
  if (colony === undefined) return false;
  const r2 = r * r;
  for (const e of colony.entrances) {
    if (!e.isOpen) continue;
    const dx = x - (e.surfaceTileX + 0.5);
    const dy = y - (e.surfaceTileY + 0.5);
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
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
    if (nearOwnOpenEntrance(world.colonies[cid], x, y, GATHER_HOME_RADIUS_TILES)) continue;
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

/** The warning caption naming `entrance` of `colony`. */
export function gatheringWarningText(colony: ColonyRecord, entrance: NestEntrance): string {
  const hint = 'Train fighters and rally them there.';
  if (colony.entrances.filter((e) => e.isOpen).length < 2) {
    return `An enemy army is gathering near your entrance. ${hint}`;
  }
  const name = entranceDirectionName(colony, entrance);
  if (name === null) {
    return `An enemy army is gathering near one of your entrances, ringed on the minimap. ${hint}`;
  }
  return `An enemy army is gathering near your ${name} entrance. ${hint}`;
}

// ---------------------------------------------------------------------------
// The warning caption (hysteresis)
// ---------------------------------------------------------------------------

export interface GatheringWarningState {
  /** True while the next gathering may raise a warning. */
  armed: boolean;
  /** world.tick since which a gathering has held while armed (-Infinity: none). */
  gatherSinceTick: number;
  /** world.tick since which things have been quiet while disarmed (-Infinity: not quiet). */
  quietSinceTick: number;
  /** world.tick the current warning became owed (-Infinity: none owed). */
  owedSinceTick: number;
}

export function createGatheringWarningState(): GatheringWarningState {
  return {
    armed: true,
    gatherSinceTick: -Infinity,
    quietSinceTick: -Infinity,
    owedSinceTick: -Infinity,
  };
}

/** New round or loaded save: armed, nothing owed. */
export function resetGatheringWarningState(state: GatheringWarningState): void {
  state.armed = true;
  state.gatherSinceTick = -Infinity;
  state.quietSinceTick = -Infinity;
  state.owedSinceTick = -Infinity;
}

/**
 * Called each frame. Returns the warning text to offer the caption queue this
 * frame, or null. The caller offers it through offerRecurringCaption and, if
 * the queue took it, calls markGatheringWarningShown.
 *
 * Once per gathering:
 *   - Armed, a gathering (isEnemyGathering) with no invasion under way
 *     (fewer than INVASION_NEST_MIN_FIGHTERS enemy fighters in the viewer's
 *     tunnels) that holds for GATHER_DWELL_TICKS disarms the warning and makes
 *     it owed. An invasion that begins while armed disarms it with nothing
 *     owed (the invasion itself is the signal: the screen-edge flash, and the
 *     first time the invasion caption), so its survivors walking back out do
 *     not raise the warning afterwards.
 *   - Disarmed, it re-arms once at most GATHER_REARM_MAX_FIGHTERS enemy
 *     fighters are near any entrance and none invading, continuously for
 *     GATHER_REARM_QUIET_TICKS: the army dispersed, or its invasion ended. An
 *     army still standing near the door, or still inside the nest, keeps it
 *     disarmed however long it takes.
 *   - An owed warning is offered each frame until the queue takes it. It is
 *     dropped unshown once it is stale: the gathering broke up (at most
 *     GATHER_REARM_MAX_FIGHTERS left near), the invasion began (a warning for
 *     an army already inside is too late), or GATHER_CAPTION_OWED_TICKS passed.
 *     A dropped warning does not re-arm; the next one needs a new gathering.
 *
 * Text names the entrance the army is near now (it may have moved since the
 * warning became owed).
 */
export function nextGatheringWarning(
  state: GatheringWarningState,
  world: WorldState,
  viewerColonyId: ColonyId,
): string | null {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined) return null;
  const g = measureEnemyGatheringThisTick(world, viewerColonyId);
  const gathering = isEnemyGathering(g);
  const invading = enemyFightersInNest(world, viewerColonyId) >= INVASION_NEST_MIN_FIGHTERS;
  const tick = world.tick;

  if (state.armed) {
    if (invading) {
      // An invasion that began before any warning uses the gathering up: its
      // survivors walking back out past the door must not raise one.
      state.armed = false;
      state.gatherSinceTick = -Infinity;
      state.quietSinceTick = -Infinity;
    } else if (gathering) {
      if (state.gatherSinceTick === -Infinity || state.gatherSinceTick > tick) {
        state.gatherSinceTick = tick;
      }
      if (tick - state.gatherSinceTick >= GATHER_DWELL_TICKS) {
        state.armed = false;
        state.gatherSinceTick = -Infinity;
        state.quietSinceTick = -Infinity;
        state.owedSinceTick = tick;
      }
    } else {
      state.gatherSinceTick = -Infinity;
    }
  } else {
    const quiet = !invading && (g === null || g.fighters <= GATHER_REARM_MAX_FIGHTERS);
    if (!quiet) {
      state.quietSinceTick = -Infinity;
    } else {
      if (state.quietSinceTick === -Infinity || state.quietSinceTick > tick) {
        state.quietSinceTick = tick;
      }
      if (tick - state.quietSinceTick >= GATHER_REARM_QUIET_TICKS) {
        state.armed = true;
        state.quietSinceTick = -Infinity;
      }
    }
  }

  if (state.owedSinceTick === -Infinity) return null;
  // Broken up by the same test that re-arms (at most GATHER_REARM_MAX_FIGHTERS
  // near), not by a dip under GATHER_MIN_FIGHTERS: one fighter stepping out of
  // the radius must not lose the warning for good.
  if (
    g === null ||
    g.fighters <= GATHER_REARM_MAX_FIGHTERS ||
    invading ||
    state.owedSinceTick > tick ||
    tick - state.owedSinceTick > GATHER_CAPTION_OWED_TICKS
  ) {
    state.owedSinceTick = -Infinity; // stale: drop it
    return null;
  }
  return gatheringWarningText(viewer, g.entrance);
}

/** The caption queue took the owed warning. */
export function markGatheringWarningShown(state: GatheringWarningState): void {
  state.owedSinceTick = -Infinity;
}
