// enemy-march.ts — #394: spot an enemy army marching on one of the viewing
// colony's entrances, for the army warning caption and the minimap ring.
//
// Since V64 an AI probe sends only its 3-fighter cohort, so the AI no longer
// stages an army near the player's nest before it invades: it commits the whole
// army at home and marches it about 80 tiles in about 8 s. The gathering warning
// (enemy-gathering.ts) then only fires as the army reaches the door. This module
// reads the march itself off world state, the way enemy-gathering.ts reads a
// gathering. It is render-side and reads no AI state: any colony's fighters count,
// so it works the same for a human opponent (CLNY-08 — "enemy" is every colony
// that is not the viewer, never a fixed id).
//
// A heading needs memory, which world state does not hold. MarchHistory samples
// where every surface fighter is every MARCH_SAMPLE_TICKS ticks; a fighter's
// heading is the line from where it stood about MARCH_WINDOW_TICKS ago to where it
// stands now. The history is render-side scratch, never sim state.
//
// Phaser-free: reads WorldState, never writes it; mutates only its own histories
// and render-side memos (one of each per world, held weakly).

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';

/** Fewest enemy fighters marching on the viewer's entrances that make an army:
 *  the same number as the gathering threshold (GATHER_MIN_FIGHTERS) — above the
 *  AI's 3-fighter probe, well below its smallest invasion (12, Hard). */
export const MARCH_MIN_FIGHTERS = 6;

/** How far back (ticks, 1 s) a fighter's heading is measured over. A fighter
 *  walks 0.5 tile a tick on open ground, so a marching one covers about 10 tiles. */
export const MARCH_WINDOW_TICKS = 20;

/** How often (ticks) the history samples fighter positions. */
export const MARCH_SAMPLE_TICKS = 5;

/** A sample older than this (ticks) gives no heading: after a long gap (a load, a
 *  stalled tab) a stale position would make a heading out of two unrelated moments. */
export const MARCH_MAX_LOOKBACK_TICKS = 2 * MARCH_WINDOW_TICKS;

/** A fighter that moved less than this (tiles, straight-line) over the window is
 *  standing or milling, not marching. */
export const MARCH_MIN_STEP_TILES = 3;

/** A fighter marches on an entrance when the cosine of the angle between its
 *  heading and the line to the entrance is at least this (about 45°): a detour
 *  round a rock still counts, a fighter walking past does not. */
export const MARCH_MIN_HEADING = 0.7;

/**
 * An enemy fighter this close (tiles, straight-line) to one of its own colony's
 * open entrances is not counted: it is at home, defending it or chasing an
 * intruder off, not marching. Far wider than the gathering's home radius
 * (GATHER_HOME_RADIUS_TILES, 8): measured on real AI matches (#394), a colony
 * that counter-attacks a raid sends its whole army up to about 23 tiles out
 * toward the raiders' nest before it turns back, which at 20 tiles still read as
 * a march now and then. An invasion's march covers the 80 tiles between the
 * nests (about 8 s at 0.5 tile a tick), so counting it from 24 tiles out still
 * warns with most of the march to go (about 5 s).
 */
export const MARCH_HOME_RADIUS_TILES = 24;

/** Two entrances whose lines a fighter's heading passes within this many tiles of
 *  each other are tied for its aim; the nearer one ahead wins (it gets there first). */
export const MARCH_AIM_TIE_TILES = 2;

/**
 * An enemy fighter with one of the viewer's own surface fighters within this many
 * tiles (straight-line) in front of it, running the same way (its heading within
 * MARCH_MIN_HEADING of the enemy's), is chasing that fighter, not marching on the
 * nest: it does not make an army or hold a wave open, but (outside an invasion)
 * keeps a march warning already owed for its army from going stale
 * (EnemyMarch.chasing).
 * Measured on hit-and-run raids (#394): an AI sallying after a player's raiders as
 * they ran home stayed 3-7 tiles behind them, out to 38 tiles from its own door —
 * past MARCH_HOME_RADIUS_TILES, and heading straight for the player's door. A
 * viewer's fighter coming the other way (the player's own army out to attack,
 * meeting an invasion head-on — measured, a chase rule without the heading test
 * lost those invasions' warnings) is not being chased; nor is one standing still,
 * so a charge at the player's fighters standing in the field near the attacker's
 * home still reads as a march on the door it faces (accepted: not seen in the
 * measured raids, where the AI drove off raiders that ran).
 */
export const MARCH_CHASE_TILES = 10;

/**
 * The chase rule (MARCH_CHASE_TILES) spares a fighter only within this many tiles
 * (straight-line) of its own colony's open entrances. A sally stays near home: the
 * AI drives raiders off only while they are within AI_DEFENCE_HOLD_RADIUS_TILES
 * (36, Manhattan) of its entrance, and its chasers trail them. Further out, an
 * army on the heels of the viewer's fighters is following them home — marching on
 * the nest. Measured (#394, AI vs AI): without this limit, an invasion that
 * followed the other colony's army home was warned of 2 ticks before it reached
 * the door instead of about 100.
 */
export const MARCH_CHASE_HOME_RADIUS_TILES = 40;

/** How long (ticks) a march must hold before the army warning takes it as one,
 *  so a single frame of a battle surging toward the nest does not raise it. One
 *  sample interval: the march must still be there at the next sample. */
export const MARCH_DWELL_TICKS = MARCH_SAMPLE_TICKS;

export interface EnemyMarch {
  /** The viewer's open entrance most of the army (the marching fighters not
   *  chasing; with none, the chasers) is heading for. */
  entrance: NestEntrance;
  /** Enemy fighters marching on any of the viewer's open entrances, not counting
   *  those chasing one of the viewer's fighters (`chasing`): the army. */
  fighters: number;
  /** Enemy fighters that would be marching but are chasing one of the viewer's
   *  fighters near their own home (MARCH_CHASE_TILES, MARCH_CHASE_HOME_RADIUS_TILES).
   *  They do not make an army or hold a wave open, but (outside an invasion) keep
   *  a march warning already owed from going stale (a battle on the move). */
  chasing: number;
  /** Bounding box (tile coordinates, fractional) of those of them that aim at
   *  `entrance` (an army split between doors is ringed where most of it is). */
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Where every surface fighter (of any colony) stood at one tick, by ascending id. */
interface MarchSample {
  /** world.tick it was taken at (-1: never). */
  atTick: number;
  ids: number[];
  x: number[];
  y: number[];
}

/** Ring of MARCH_HISTORY_SAMPLES samples, enough to reach MARCH_MAX_LOOKBACK_TICKS. */
const MARCH_HISTORY_SAMPLES = Math.ceil(MARCH_MAX_LOOKBACK_TICKS / MARCH_SAMPLE_TICKS) + 1;

export interface MarchHistory {
  /** The world the samples were taken from (a new world starts afresh). */
  world: WorldState | null;
  /** world.tick last seen (-1: none); a tick going backwards starts afresh. */
  lastTick: number;
  /** Ring slots; `count` of them are in use, the newest at `head`. */
  samples: MarchSample[];
  head: number;
  count: number;
  /** measureEnemyMarch's working buffers, reused every measurement (it runs every
   *  tick, so it allocates none of them anew). Render-side scratch. */
  scratch: MarchScratch;
}

/** Per entrance: how many fighters aim at it, their summed distance to it, and
 *  their bounding box. */
interface AimTally {
  aim: number[];
  dist: number[];
  minX: number[];
  minY: number[];
  maxX: number[];
  maxY: number[];
}

/** The viewer's surface fighters on the move: positions and unit headings. */
interface OwnRunners {
  x: number[];
  y: number[];
  hx: number[];
  hy: number[];
}

/** The working buffers of one measureEnemyMarch call (contents are meaningless
 *  between calls). */
interface MarchScratch {
  /** The viewer's open entrances. */
  doors: NestEntrance[];
  own: OwnRunners;
  /** Per door, of the army (fighters not chasing), and of every marcher. */
  army: AimTally;
  all: AimTally;
}

function emptyTally(): AimTally {
  return { aim: [], dist: [], minX: [], minY: [], maxX: [], maxY: [] };
}

export function createMarchHistory(): MarchHistory {
  const samples: MarchSample[] = [];
  for (let i = 0; i < MARCH_HISTORY_SAMPLES; i++) {
    samples.push({ atTick: -1, ids: [], x: [], y: [] });
  }
  const scratch: MarchScratch = {
    doors: [],
    own: { x: [], y: [], hx: [], hy: [] },
    army: emptyTally(),
    all: emptyTally(),
  };
  return { world: null, lastTick: -1, samples, head: 0, count: 0, scratch };
}

/** Forget every sample. */
export function resetMarchHistory(h: MarchHistory): void {
  h.world = null;
  h.lastTick = -1;
  h.head = 0;
  h.count = 0;
}

/**
 * Note `world` as it stands now: a new world (restart, load) or a tick that went
 * backwards drops the history, and a sample is taken when none has been for
 * MARCH_SAMPLE_TICKS. Call it with every frame's world; frames that see the same
 * tick take nothing new.
 */
export function observeMarchHistory(h: MarchHistory, world: WorldState): void {
  if (h.world !== world || world.tick < h.lastTick) {
    resetMarchHistory(h);
    h.world = world;
  }
  h.lastTick = world.tick;
  if (h.count > 0 && world.tick - h.samples[h.head]!.atTick < MARCH_SAMPLE_TICKS) return;
  const next = h.count === 0 ? h.head : (h.head + 1) % h.samples.length;
  const s = h.samples[next]!;
  s.atTick = world.tick;
  s.ids.length = 0;
  s.x.length = 0;
  s.y.length = 0;
  const ants = world.ants;
  const end = Math.min(world.nextEntityId, ants.alive.length);
  for (let id = 0; id < end; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.zone[id] !== Zone.Surface) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;
    s.ids.push(id);
    s.x.push(ants.posX[id]! / FP_ONE);
    s.y.push(ants.posY[id]! / FP_ONE);
  }
  h.head = next;
  if (h.count < h.samples.length) h.count++;
}

/** The newest sample at least MARCH_WINDOW_TICKS before `tick` and no more than
 *  MARCH_MAX_LOOKBACK_TICKS before it, or null. */
function headingSample(h: MarchHistory, tick: number): MarchSample | null {
  for (let k = 0; k < h.count; k++) {
    const s = h.samples[(h.head - k + h.samples.length) % h.samples.length]!;
    const age = tick - s.atTick;
    if (age < MARCH_WINDOW_TICKS) continue;
    return age <= MARCH_MAX_LOOKBACK_TICKS ? s : null;
  }
  return null;
}

/** The newest sample at least MARCH_SAMPLE_TICKS before `tick` (and no more than
 *  MARCH_MAX_LOOKBACK_TICKS before it), or null: where a fighter's last stretch
 *  of motion starts. */
function recentSample(h: MarchHistory, tick: number): MarchSample | null {
  for (let k = 0; k < h.count; k++) {
    const s = h.samples[(h.head - k + h.samples.length) % h.samples.length]!;
    const age = tick - s.atTick;
    if (age < MARCH_SAMPLE_TICKS) continue;
    return age <= MARCH_MAX_LOOKBACK_TICKS ? s : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** True iff `x,y` (tiles) is within `r` tiles (straight-line, from the tile
 *  centre) of one of `colony`'s open entrances. */
export function nearOpenEntrance(
  colony: ColonyRecord | undefined,
  x: number,
  y: number,
  r: number,
): boolean {
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

/** True iff a fighter at `x,y` heading (hx, hy) (a unit vector) heads for
 *  `e` — within MARCH_MIN_HEADING of the line to it, or on it (within a tile) —
 *  and if so how far ahead along the heading it lies; else -1. */
function aheadAlong(e: NestEntrance, x: number, y: number, hx: number, hy: number): number {
  const tx = e.surfaceTileX + 0.5 - x;
  const ty = e.surfaceTileY + 0.5 - y;
  const dist = Math.hypot(tx, ty);
  const along = hx * tx + hy * ty;
  if (dist <= 1) return Math.max(along, 0);
  return along >= MARCH_MIN_HEADING * dist ? along : -1;
}

/** True iff an open entrance of a colony other than the viewer lies ahead of a
 *  fighter at `x,y` heading (hx, hy), nearer along its heading than `along`: it
 *  is heading there (home, or with three or more colonies, a third one), not at
 *  the viewer. */
function otherDoorNearerAhead(
  world: WorldState,
  viewerColonyId: ColonyId,
  x: number,
  y: number,
  hx: number,
  hy: number,
  along: number,
): boolean {
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const c = world.colonies[key as unknown as ColonyId]!;
    if (c.colonyId === viewerColonyId) continue;
    for (const e of c.entrances) {
      if (!e.isOpen) continue;
      const a = aheadAlong(e, x, y, hx, hy);
      if (a >= 0 && a < along) return true;
    }
  }
  return false;
}

/** Clear `t` for `n` entrances: no aims, empty boxes. */
function resetTally(t: AimTally, n: number): void {
  t.aim.length = n;
  t.dist.length = n;
  t.minX.length = n;
  t.minY.length = n;
  t.maxX.length = n;
  t.maxY.length = n;
  for (let d = 0; d < n; d++) {
    t.aim[d] = 0;
    t.dist[d] = 0;
    t.minX[d] = Infinity;
    t.minY[d] = Infinity;
    t.maxX[d] = -Infinity;
    t.maxY[d] = -Infinity;
  }
}

/** Count a fighter at `x,y`, `dist` tiles from entrance `d`, as aiming at it. */
function tallyAim(t: AimTally, d: number, dist: number, x: number, y: number): void {
  t.aim[d] = t.aim[d]! + 1;
  t.dist[d] = t.dist[d]! + dist;
  if (x < t.minX[d]!) t.minX[d] = x;
  if (y < t.minY[d]!) t.minY[d] = y;
  if (x > t.maxX[d]!) t.maxX[d] = x;
  if (y > t.maxY[d]!) t.maxY[d] = y;
}

/** Index of ant `id` in `s.ids` (ascending), or -1. */
function sampleIndexOf(s: MarchSample, id: number): number {
  let lo = 0;
  let hi = s.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = s.ids[mid]!;
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** True iff one of the viewer's running fighters (`own`) is within
 *  MARCH_CHASE_TILES of a fighter at `x,y` heading (hx, hy), in front of it (not
 *  behind its side-line), and running the same way (headings within
 *  MARCH_MIN_HEADING): the fighter is chasing it. */
function runnerAhead(own: OwnRunners, x: number, y: number, hx: number, hy: number): boolean {
  const r2 = MARCH_CHASE_TILES * MARCH_CHASE_TILES;
  for (let k = 0; k < own.x.length; k++) {
    const dx = own.x[k]! - x;
    const dy = own.y[k]! - y;
    if (dx * dx + dy * dy > r2 || hx * dx + hy * dy < 0) continue;
    if (hx * own.hx[k]! + hy * own.hy[k]! >= MARCH_MIN_HEADING) return true;
  }
  return false;
}

/**
 * The enemy fighters marching on the viewer's open entrances, or null when none
 * is (or the viewer has no open entrance, or `history` holds no sample old
 * enough). No threshold: see isEnemyMarching. `history` must have been observed
 * on this world (observeMarchHistory); this reads its samples and writes only its
 * scratch buffers (history.scratch), so it allocates nothing per call but the
 * result (and none when there is no march).
 *
 * A fighter marches when it is alive, on the surface, of another colony, doing
 * the Fighting task, more than MARCH_HOME_RADIUS_TILES from its own colony's open
 * entrances, was on the surface in the heading sample too, has moved at least
 * MARCH_MIN_STEP_TILES since — and is still going that way at that pace since the
 * newest sample at least MARCH_SAMPLE_TICKS old — and its heading points at one
 * of the viewer's open
 * entrances (cosine at least MARCH_MIN_HEADING) — unless another colony's open
 * entrance lies ahead of it, nearer along that heading than the one it aims at
 * (it is heading there). It counts once however many entrances it points at, so
 * an army heading between two doors is not split. One still within
 * MARCH_CHASE_HOME_RADIUS_TILES of its own open entrances with a viewer's fighter on
 * the surface within MARCH_CHASE_TILES in front of it (ahead of its side-line),
 * running the same way (headings within MARCH_MIN_HEADING, each over the same
 * window), counts as `chasing`, not in `fighters`.
 *
 * The entrance returned is the one most of the army (`fighters`; with none, the
 * chasers) aims at, and the box is of those of them aiming at it. A fighter aims
 * at the entrance its heading passes closest to (perpendicular miss distance) or,
 * among those within MARCH_AIM_TIE_TILES of that one, the nearest ahead along its
 * heading (it gets there first). On a tie between entrances, the one its aimers
 * are nearer to on average (then the one listed first).
 */
export function measureEnemyMarch(
  world: WorldState,
  viewerColonyId: ColonyId,
  history: MarchHistory,
): EnemyMarch | null {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined) return null;
  if (history.world !== world) return null;
  const sc = history.scratch;
  const doors = sc.doors;
  doors.length = 0;
  for (const e of viewer.entrances) if (e.isOpen) doors.push(e);
  const n = doors.length;
  if (n === 0) return null;
  const old = headingSample(history, world.tick);
  if (old === null) return null;
  const recent = recentSample(history, world.tick);
  if (recent === null) return null;
  // The least progress along its heading since `recent` that is still marching:
  // the window's minimum pace (MARCH_MIN_STEP_TILES a window).
  const minProgress = (MARCH_MIN_STEP_TILES * (world.tick - recent.atTick)) / MARCH_WINDOW_TICKS;
  // Per entrance, of the army (fighters not chasing) and of every marcher.
  const army = sc.army;
  const all = sc.all;
  resetTally(army, n);
  resetTally(all, n);
  let fighters = 0;
  let chasing = 0;
  const ants = world.ants;
  // The viewer's own surface fighters on the move, with their headings: an enemy
  // close behind one, going the same way, is chasing it.
  const own = sc.own;
  own.x.length = 0;
  own.y.length = 0;
  own.hx.length = 0;
  own.hy.length = 0;
  for (const id of viewer.workers) {
    if (ants.alive[id] !== 1) continue;
    if (ants.colonyId[id] !== viewerColonyId) continue;
    if (ants.zone[id] !== Zone.Surface) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;
    const k = sampleIndexOf(old, id);
    if (k < 0) continue;
    const x = ants.posX[id]! / FP_ONE;
    const y = ants.posY[id]! / FP_ONE;
    const step = Math.hypot(x - old.x[k]!, y - old.y[k]!);
    if (step < MARCH_MIN_STEP_TILES) continue;
    own.x.push(x);
    own.y.push(y);
    own.hx.push((x - old.x[k]!) / step);
    own.hy.push((y - old.y[k]!) / step);
  }
  const end = Math.min(world.nextEntityId, ants.alive.length);
  let j = 0; // merge-walk cursor into old.ids (both ascending)
  for (let id = 0; id < end; id++) {
    if (ants.alive[id] !== 1) continue;
    if (ants.zone[id] !== Zone.Surface) continue;
    if (ants.task[id] !== AntTask.Fighting) continue;
    const cid = ants.colonyId[id]!;
    if (cid === viewerColonyId) continue;
    while (j < old.ids.length && old.ids[j]! < id) j++;
    if (j >= old.ids.length || old.ids[j] !== id) continue;
    const x = ants.posX[id]! / FP_ONE;
    const y = ants.posY[id]! / FP_ONE;
    if (nearOpenEntrance(world.colonies[cid], x, y, MARCH_HOME_RADIUS_TILES)) continue;
    const sx = x - old.x[j]!;
    const sy = y - old.y[j]!;
    const step = Math.hypot(sx, sy);
    if (step < MARCH_MIN_STEP_TILES) continue;
    const hx = sx / step;
    const hy = sy / step;
    // Still going that way now: a fighter that has stopped or turned since the
    // last sample (a sally giving up the chase) is no longer marching, though its
    // heading over the window still points at the door.
    const r = sampleIndexOf(recent, id);
    if (r < 0) continue;
    if ((x - recent.x[r]!) * hx + (y - recent.y[r]!) * hy < minProgress) continue;
    // Pass 1: the least miss among the doors it heads for (none: not marching).
    let bestMiss = Infinity;
    for (let d = 0; d < n; d++) {
      if (aheadAlong(doors[d]!, x, y, hx, hy) < 0) continue;
      const tx = doors[d]!.surfaceTileX + 0.5 - x;
      const ty = doors[d]!.surfaceTileY + 0.5 - y;
      bestMiss = Math.min(bestMiss, Math.abs(hx * ty - hy * tx));
    }
    if (bestMiss === Infinity) continue;
    // Pass 2: of those within the tie of it, the nearest ahead.
    let best = -1;
    let bestAlong = Infinity;
    for (let d = 0; d < n; d++) {
      const along = aheadAlong(doors[d]!, x, y, hx, hy);
      if (along < 0) continue;
      const tx = doors[d]!.surfaceTileX + 0.5 - x;
      const ty = doors[d]!.surfaceTileY + 0.5 - y;
      if (Math.abs(hx * ty - hy * tx) > bestMiss + MARCH_AIM_TIE_TILES) continue;
      if (along < bestAlong) {
        best = d;
        bestAlong = along;
      }
    }
    if (otherDoorNearerAhead(world, viewerColonyId, x, y, hx, hy, bestAlong)) continue;
    const bestDist = Math.hypot(
      doors[best]!.surfaceTileX + 0.5 - x,
      doors[best]!.surfaceTileY + 0.5 - y,
    );
    const nearHome = nearOpenEntrance(world.colonies[cid], x, y, MARCH_CHASE_HOME_RADIUS_TILES);
    tallyAim(all, best, bestDist, x, y);
    if (nearHome && runnerAhead(own, x, y, hx, hy)) {
      chasing++;
    } else {
      fighters++;
      tallyAim(army, best, bestDist, x, y);
    }
  }
  if (fighters + chasing === 0) return null;
  // The entrance and box are the army's; only with no army, the chasers'.
  const t = fighters > 0 ? army : all;
  let top = 0;
  for (let d = 1; d < n; d++) {
    // Equal aims: compare mean distance (sums over the same count).
    if (t.aim[d]! > t.aim[top]! || (t.aim[d] === t.aim[top] && t.dist[d]! < t.dist[top]!)) {
      top = d;
    }
  }
  return {
    entrance: doors[top]!,
    fighters,
    chasing,
    minTileX: t.minX[top]!,
    minTileY: t.minY[top]!,
    maxTileX: t.maxX[top]!,
    maxTileY: t.maxY[top]!,
  };
}

/** True iff `m` is big enough to be an army (MARCH_MIN_FIGHTERS). */
export function isEnemyMarching(m: EnemyMarch | null): m is EnemyMarch {
  return m !== null && m.fighters >= MARCH_MIN_FIGHTERS;
}

/**
 * measureEnemyMarch over a render-side history observed every call, memoised for
 * one (viewer, tick) per world. GameScene (the warning) and UIScene (the minimap
 * ring) both call it every frame, so the history sees every frame's world, and
 * the second call of a tick — and every frame of a pause — reuses the first.
 * History and memo are kept per WorldState object (weakly, so a finished round's
 * world is not held): a restart or load starts a new history, and two games on
 * one page do not share one. Render-side scratch (not sim state): it never feeds
 * the sim.
 */
const histories = new WeakMap<WorldState, MarchHistory>();
const memos = new WeakMap<
  WorldState,
  { viewer: ColonyId; atTick: number; result: EnemyMarch | null }
>();
export function measureEnemyMarchThisTick(
  world: WorldState,
  viewerColonyId: ColonyId,
): EnemyMarch | null {
  let history = histories.get(world);
  if (history === undefined) {
    history = createMarchHistory();
    histories.set(world, history);
  }
  observeMarchHistory(history, world);
  let memo = memos.get(world);
  if (memo === undefined) {
    memo = { viewer: -1, atTick: -1, result: null };
    memos.set(world, memo);
  } else if (memo.viewer === viewerColonyId && memo.atTick === world.tick) {
    return memo.result;
  }
  memo.result = measureEnemyMarch(world, viewerColonyId, history);
  memo.viewer = viewerColonyId;
  memo.atTick = world.tick;
  return memo.result;
}

/** #394 — one army warning as the caption queue took it, for the dev-only
 *  __phase9_test.getArmyWarningLog (GameScene): when, what, and how far off the
 *  march it reported still was, so a spec can check the warning came early in
 *  the march without timing it. */
export interface ArmyWarningLogEntry {
  /** world.tick the queue took the warning. */
  tick: number;
  /** world.tick it became owed (#404 review: when the fallback fired, say, apart
   *  from how long it then waited for the queue). */
  owedTick: number;
  text: string;
  /** Enemy fighters marching on the viewer's entrances then (0: none). */
  marching: number;
  /** Tiles (straight-line) from the centre of the entrance the march heads for to
   *  the nearest point of the bounding box of the marching fighters aiming at it
   *  (null: no march). */
  marchDistanceTiles: number | null;
}

/** The log entry for an army warning `text`, owed since `owedTick`, that the queue
 *  took now (see ArmyWarningLogEntry). */
export function armyWarningLogEntry(
  world: WorldState,
  viewerColonyId: ColonyId,
  text: string,
  owedTick: number,
): ArmyWarningLogEntry {
  const m = measureEnemyMarchThisTick(world, viewerColonyId);
  const tick = world.tick;
  // Chasers only (a warning they kept owed) is no march to measure.
  if (m === null || m.fighters === 0) {
    return { tick, owedTick, text, marching: 0, marchDistanceTiles: null };
  }
  const ex = m.entrance.surfaceTileX + 0.5;
  const ey = m.entrance.surfaceTileY + 0.5;
  const dx = Math.max(m.minTileX - ex, 0, ex - m.maxTileX);
  const dy = Math.max(m.minTileY - ey, 0, ey - m.maxTileY);
  const marchDistanceTiles = Math.hypot(dx, dy);
  return { tick, owedTick, text, marching: m.fighters, marchDistanceTiles };
}
