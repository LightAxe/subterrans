// army-warning.ts — #394/#409: the army warning caption, raised by an enemy army
// gathering near one of the viewing colony's entrances (enemy-gathering.ts),
// marching on one (enemy-march.ts), or invading (an invasion_start event, or
// enemy fighters inside the viewer's tunnels).
//
// The state machine (ArmyWarningState + nextArmyWarning) shows the caption once
// per wave, with hysteresis (see nextArmyWarning); with the warning texts, the
// invasion fallback and the dev-only log entry. The two detectors are geometry
// and history only and know nothing of the caption.
//
// Phaser-free: reads WorldState, never writes it; mutates only its own state
// object.

import type { WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AI_INVADING_TIMEOUT_TICKS } from '../sim/constants.js';
import { opponentColonyId } from '../sim/ai-state.js';
import {
  GATHER_DWELL_TICKS,
  enemyFightersInNest,
  entranceDirectionName,
  isEnemyGathering,
  measureEnemyGatheringThisTick,
  type EnemyGathering,
} from './enemy-gathering.js';
import {
  MARCH_DWELL_TICKS,
  isEnemyMarching,
  measureEnemyMarchThisTick,
  type EnemyMarch,
} from './enemy-march.js';

/** After a warning, the wave is over (and the warning re-arms) once at most this
 *  many enemy fighters are near any entrance, at most this many are marching on
 *  them (#394), and no invasion is under way (INVASION_NEST_MIN_FIGHTERS, or one
 *  launched and not yet ended)... Three (#394; 2 at #372): the size of the AI's
 *  probe cohort (AI_PROBE_FIGHTER_COUNT, pinned against it in the tests),
 *  which can stand at a food pile by the door for 30 s and must not keep the
 *  warning disarmed into the invasion that follows it — half an army
 *  (GATHER_MIN_FIGHTERS) is not one. */
export const ARMY_REARM_MAX_FIGHTERS = 3;
/** ...continuously for this long (ticks, 10 s). */
export const ARMY_REARM_QUIET_TICKS = 200;

/** This many enemy fighters inside the viewer's tunnels is an invasion: the army
 *  at the door is no longer gathering, it is going in (no gathering warning for
 *  it). Three, not one, so a lone raider does not silence the warning. */
export const INVASION_NEST_MIN_FIGHTERS = 3;

/** How long (ticks, 10 s) a warning the busy caption queue could not take yet is
 *  still offered, the same window as the other recurring captions. (Not a launch
 *  warning, #404 review: that is owed until shown or its invasion ends.) */
export const ARMY_CAPTION_OWED_TICKS = 200;

/** Full-opacity hold (ms) of the army warning (#394: marching or gathering). The
 *  default 800 ms is too short to read its two or three lines, and it shows once
 *  per wave. */
export const ARMY_CAPTION_HOLD_MS = 4000;

/** The hint both army warnings end with (#394: one wording for a march and a
 *  gathering, so the two read the same). */
export const ARMY_WARNING_HINT = 'Train fighters and rally there.';

/**
 * The army warning caption: an enemy army `doing` ("is gathering near", "is
 * marching on") `entrance` of `colony`, named by its compass direction — no name
 * with one open entrance, nor when the direction would not single it out. Then,
 * if `ringed`, it points to the minimap ring around the army instead.
 */
function armyWarningText(
  doing: string,
  colony: ColonyRecord,
  entrance: NestEntrance,
  ringed: boolean,
): string {
  const hint = ARMY_WARNING_HINT;
  if (colony.entrances.filter((e) => e.isOpen).length < 2) {
    return `An enemy army ${doing} your entrance. ${hint}`;
  }
  const name = entranceDirectionName(colony, entrance);
  if (name !== null) return `An enemy army ${doing} your ${name} entrance. ${hint}`;
  const ring = ringed ? ', ringed on the minimap' : '';
  return `An enemy army ${doing} one of your entrances${ring}. ${hint}`;
}

/** The warning caption naming `entrance` of `colony`, an army gathering near it. */
export function gatheringWarningText(colony: ColonyRecord, entrance: NestEntrance): string {
  return armyWarningText('is gathering near', colony, entrance, true);
}

/** #394 — the warning caption naming `entrance` of `colony`, an army marching on it. */
export function marchWarningText(colony: ColonyRecord, entrance: NestEntrance): string {
  return armyWarningText('is marching on', colony, entrance, true);
}

/**
 * #404 review — the fallback's caption, naming `entrance` of `colony`, which an
 * invasion has just set out for. As marchWarningText, but it never points to a
 * minimap ring: as the army sets out it may still read as at home (no ring).
 */
export function invasionWarningText(colony: ColonyRecord, entrance: NestEntrance): string {
  return armyWarningText('is marching on', colony, entrance, false);
}

// ---------------------------------------------------------------------------
// The army warning caption (hysteresis)
// ---------------------------------------------------------------------------

/** What an army warning reports: an army marching on an entrance, or gathering
 *  near one; or ('invasion', #404 review) an invasion launched at an entrance
 *  before either reading warned of it. */
export type ArmyWarningKind = 'march' | 'gather' | 'invasion';

export interface ArmyWarningState {
  /** True while the next wave may raise a warning. */
  armed: boolean;
  /** Armed only: an invasion (INVASION_NEST_MIN_FIGHTERS enemy fighters in the
   *  viewer's tunnels) has begun in this wave before any warning — one the
   *  fallback could not warn of (no launch noted for it while armed: a human
   *  attacker's). Its own army at the door, or its
   *  survivors, then raise no gathering warning; an army still marching on the
   *  entrances does raise a march warning. Cleared once things are quiet. */
  invadedUnwarned: boolean;
  /** world.tick since which a gathering has held while armed (-Infinity: none). */
  gatherSinceTick: number;
  /** world.tick since which a march has held while armed (-Infinity: none). */
  marchSinceTick: number;
  /** world.tick since which things have been quiet (-Infinity: not quiet), while
   *  disarmed (to re-arm) or armed after an invasion (to clear invadedUnwarned). */
  quietSinceTick: number;
  /** world.tick the current warning became owed (-Infinity: none owed). */
  owedSinceTick: number;
  /** What the owed warning reports (meaningful only while one is owed). */
  owedKind: ArmyWarningKind;
  /** #404 review — the invasion launched at the viewer that is under way (its
   *  invasion_start, noteArmyWarningEvent; or, after a load, its operation,
   *  noteInvasionUnderWay): the attacking colony (-1: none), the
   *  tile it rallies on (at the entrance it targets) and the tick it was launched.
   *  Kept until that attacker's invasion_end — or INVASION_WATCH_TICKS, should that
   *  never come — and while kept the wave cannot end. One at a time: a two-colony
   *  match has one attacker. */
  invasionAttacker: number;
  invasionRallyX: number;
  invasionRallyY: number;
  invasionSinceTick: number;
  /** That invasion was launched while armed and nothing has warned of its wave
   *  yet: the fallback warning is due. */
  invasionUnwarned: boolean;
}

export function createArmyWarningState(): ArmyWarningState {
  return {
    armed: true,
    invadedUnwarned: false,
    gatherSinceTick: -Infinity,
    marchSinceTick: -Infinity,
    quietSinceTick: -Infinity,
    owedSinceTick: -Infinity,
    owedKind: 'march',
    invasionAttacker: -1,
    invasionRallyX: 0,
    invasionRallyY: 0,
    invasionSinceTick: -Infinity,
    invasionUnwarned: false,
  };
}

/** New round or loaded save: armed, nothing owed. */
export function resetArmyWarningState(state: ArmyWarningState): void {
  state.armed = true;
  state.invadedUnwarned = false;
  state.gatherSinceTick = -Infinity;
  state.marchSinceTick = -Infinity;
  state.quietSinceTick = -Infinity;
  state.owedSinceTick = -Infinity;
  state.owedKind = 'march';
  forgetInvasion(state);
}

/** How long (ticks) an invasion is taken as under way without its invasion_end:
 *  the AI gives one up after AI_INVADING_TIMEOUT_TICKS, so a missing end (an
 *  evicted event) cannot hold the warning disarmed for good. */
export const INVASION_WATCH_TICKS = AI_INVADING_TIMEOUT_TICKS + ARMY_REARM_QUIET_TICKS;

function forgetInvasion(state: ArmyWarningState): void {
  state.invasionAttacker = -1;
  state.invasionSinceTick = -Infinity;
  state.invasionUnwarned = false;
}

/**
 * #404 review — GameScene hands every new sim event here, before the frame's
 * nextArmyWarning. An invasion launched at `viewerColonyId` (invasion_start: its
 * target is the viewer, its attacker another colony) is noted as under way, with
 * the tile it rallies on; launched while the warning is armed, its fallback
 * warning is due. That attacker's invasion_end forgets it. Nothing else is read.
 */
export function noteArmyWarningEvent(
  state: ArmyWarningState,
  ev: SimEvent,
  viewerColonyId: ColonyId,
): void {
  if (ev.type === 'invasion_start') {
    const p = ev.payload;
    if (p.targetGrid !== viewerColonyId || p.colonyId === viewerColonyId) return;
    noteLaunch(state, p.colonyId, p.rallyTile.x, p.rallyTile.y, ev.tick);
  } else if (ev.type === 'invasion_end' && ev.payload.colonyId === state.invasionAttacker) {
    forgetInvasion(state);
  }
}

/**
 * #404 review — at boot, after resetArmyWarningState: an invasion of
 * `viewerColonyId` already under way in the world (a save taken after its
 * launch) is noted as its invasion_start would have been. A save keeps no
 * events, so that launch never reaches noteArmyWarningEvent, and without this a
 * resumed invasion of a door the readings cannot see would go unwarned. Reads the
 * attacker's AI operation record — the same facts its invasion_start carried: the
 * attacker, the tile it rallies on, its launch tick, and its target (the
 * attacker's opponent, as invasion_start's targetGrid) — and nothing else.
 */
export function noteInvasionUnderWay(
  state: ArmyWarningState,
  world: WorldState,
  viewerColonyId: ColonyId,
): void {
  for (const ai of world.aiState) {
    // Its target is its opponent (never itself, so never the viewer's own AI).
    if (ai.operationKind !== 'Invasion') continue;
    if (opponentColonyId(world, ai.colonyId) !== viewerColonyId) continue;
    noteLaunch(
      state,
      ai.colonyId,
      ai.operationTargetTileX,
      ai.operationTargetTileY,
      ai.operationStartTick,
    );
  }
}

/** Note an invasion launched at the viewer: under way from `tick`, rallying on
 *  (x, y); its warning due if the warning is armed. */
function noteLaunch(
  state: ArmyWarningState,
  attacker: number,
  x: number,
  y: number,
  tick: number,
): void {
  state.invasionAttacker = attacker;
  state.invasionRallyX = x;
  state.invasionRallyY = y;
  state.invasionSinceTick = tick;
  state.invasionUnwarned = state.armed;
}

/** The viewer's open entrance nearest the noted invasion's rally tile (the one it
 *  targets), or null (none open, or no invasion noted). */
function invasionTarget(state: ArmyWarningState, viewer: ColonyRecord): NestEntrance | null {
  if (state.invasionAttacker < 0) return null;
  let best: NestEntrance | null = null;
  let bestD = Infinity;
  for (const e of viewer.entrances) {
    if (!e.isOpen) continue;
    const d = Math.hypot(
      e.surfaceTileX - state.invasionRallyX,
      e.surfaceTileY - state.invasionRallyY,
    );
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** More than ARMY_REARM_MAX_FIGHTERS of `g` are near an entrance: the
 *  gathering has not broken up. */
function gatheringRemains(g: EnemyGathering | null): g is EnemyGathering {
  return g !== null && g.fighters > ARMY_REARM_MAX_FIGHTERS;
}

/** More than ARMY_REARM_MAX_FIGHTERS of `m` are marching (chasers not
 *  counted): the march has not broken up (or arrived). Keeps a wave from ending —
 *  a sally chasing raiders, again and again, must not hold the warning disarmed
 *  into the next invasion. */
function marchRemains(m: EnemyMarch | null): m is EnemyMarch {
  return m !== null && m.fighters > ARMY_REARM_MAX_FIGHTERS;
}

/** More than ARMY_REARM_MAX_FIGHTERS of `m` are marching or chasing: the army is
 *  still out on the move, so a march warning owed for it — outside an invasion —
 *  still stands (a battle on the move with the viewer's fighters does not make it
 *  stale). */
function armyStillOut(m: EnemyMarch | null): m is EnemyMarch {
  return m !== null && m.fighters + m.chasing > ARMY_REARM_MAX_FIGHTERS;
}

/** Advance `state.quietSinceTick`; true once it has been quiet for
 *  ARMY_REARM_QUIET_TICKS (and the clock is then cleared). */
function quietLongEnough(state: ArmyWarningState, quiet: boolean, tick: number): boolean {
  if (!quiet) {
    state.quietSinceTick = -Infinity;
    return false;
  }
  if (state.quietSinceTick === -Infinity || state.quietSinceTick > tick) {
    state.quietSinceTick = tick;
  }
  if (tick - state.quietSinceTick < ARMY_REARM_QUIET_TICKS) return false;
  state.quietSinceTick = -Infinity;
  return true;
}

/**
 * Called each frame. Returns the warning text to offer the caption queue this
 * frame, or null. The caller offers it through offerRecurringCaption and, if
 * the queue took it, calls markArmyWarningShown.
 *
 * Once per wave — an army marching on the viewer's entrances (isEnemyMarching,
 * enemy-march.ts) or gathering near one (isEnemyGathering):
 *   - Armed, an army marching disarms the warning and makes it owed once it has
 *     held MARCH_DWELL_TICKS ('march'); a gathering does so once it has held
 *     GATHER_DWELL_TICKS ('gather'). A march outranks a gathering on the same
 *     frame.
 *   - An invasion (at least INVASION_NEST_MIN_FIGHTERS enemy fighters in the
 *     viewer's tunnels) that the fallback (below) could not warn of — no
 *     invasion_start for it while armed — does not use the warning up: a
 *     vanguard can slip in before the main army has marched far enough from home
 *     to be read as a march, and that army still gets its warning. But an
 *     invasion under way, or one that began this wave before any warning
 *     (invadedUnwarned), raises no gathering warning: the army at the door is
 *     the invasion itself, and its survivors walking back out must not raise one
 *     afterwards. That lasts until things are quiet (below) for
 *     ARMY_REARM_QUIET_TICKS.
 *   - #404 review — the fallback, so every invasion gets its one warning: an
 *     invasion launched at the viewer while armed (its invasion_start,
 *     noteArmyWarningEvent) is warned of ('invasion') at once, as its army sets
 *     out, unless a reading warned of the wave first. The AI's army does not move
 *     before its launch, so against the AI this warns of nearly every invasion
 *     (the readings alone would miss some: an army marching on a door within
 *     MARCH_HOME_RADIUS_TILES of its own nest counts as at home all the way
 *     there). It names the viewer's open entrance nearest the invasion's rally
 *     tile, and stays owed until the queue takes it or that invasion ends. An
 *     invasion already under way when a save loads is noted at boot
 *     (noteInvasionUnderWay) and warned of then. While an invasion is under way
 *     the wave does not end (no re-arming), so it gets one warning however its
 *     army comes and goes.
 *   - Disarmed, it re-arms once things are quiet — at most
 *     ARMY_REARM_MAX_FIGHTERS enemy fighters near any entrance, at most that
 *     many marching (EnemyMarch.fighters: a sally chasing raiders does not count),
 *     and no invasion (in the nest, or launched and not yet ended) — continuously
 *     for ARMY_REARM_QUIET_TICKS:
 *     the army dispersed, or its invasion ended. An army still marching, still
 *     standing near the door, or still inside the nest keeps it disarmed however
 *     long it takes.
 *   - An owed warning is offered each frame until the queue takes it. It is
 *     dropped unshown once it is stale: the army broke up — at most
 *     ARMY_REARM_MAX_FIGHTERS still marching (for a march warning outside an
 *     invasion, marching or chasing: a battle on the move is the army still out)
 *     and, outside an invasion, at most that many near (a warning for an army
 *     already inside is too late) — or ARMY_CAPTION_OWED_TICKS passed. (A
 *     launch warning is never dropped so: only when its invasion ends.) A
 *     dropped warning does not re-arm; the next one needs a new wave.
 *
 * Text: the owed kind while it still holds (else the other: a march that has
 * reached the door is a gathering there), naming the entrance the army is
 * marching on or near now (it may have changed since the warning became owed);
 * for the fallback, invasionWarningText naming the entrance the invasion targets.
 */
export function nextArmyWarning(
  state: ArmyWarningState,
  world: WorldState,
  viewerColonyId: ColonyId,
): string | null {
  const viewer = world.colonies[viewerColonyId];
  if (viewer === undefined) return null;
  const g = measureEnemyGatheringThisTick(world, viewerColonyId);
  const m = measureEnemyMarchThisTick(world, viewerColonyId);
  const invading = enemyFightersInNest(world, viewerColonyId) >= INVASION_NEST_MIN_FIGHTERS;
  const tick = world.tick;
  // A launched invasion stops counting as under way once INVASION_WATCH_TICKS pass
  // without its end (or if the clock ran back past its launch).
  if (
    state.invasionAttacker >= 0 &&
    (state.invasionSinceTick > tick || tick - state.invasionSinceTick > INVASION_WATCH_TICKS)
  ) {
    forgetInvasion(state);
  }
  const quiet = !invading && !gatheringRemains(g) && !marchRemains(m) && state.invasionAttacker < 0;

  if (state.armed) {
    if (invading) state.invadedUnwarned = true;
    // A gathering only counts toward a warning outside an invasion wave.
    const gathering = isEnemyGathering(g) && !state.invadedUnwarned;
    if (!gathering) {
      state.gatherSinceTick = -Infinity;
    } else if (state.gatherSinceTick === -Infinity || state.gatherSinceTick > tick) {
      state.gatherSinceTick = tick;
    }
    const marching = isEnemyMarching(m);
    if (!marching) {
      state.marchSinceTick = -Infinity;
    } else if (state.marchSinceTick === -Infinity || state.marchSinceTick > tick) {
      state.marchSinceTick = tick;
    }
    let kind: ArmyWarningKind | null =
      marching && tick - state.marchSinceTick >= MARCH_DWELL_TICKS
        ? 'march'
        : gathering && tick - state.gatherSinceTick >= GATHER_DWELL_TICKS
          ? 'gather'
          : null;
    // #404 review — the fallback: an invasion launched at the viewer while armed
    // that no reading has warned of yet is warned of now, as its army sets out.
    if (kind === null && state.invasionUnwarned) kind = 'invasion';
    if (kind !== null) {
      state.armed = false;
      state.invadedUnwarned = false;
      state.gatherSinceTick = -Infinity;
      state.marchSinceTick = -Infinity;
      state.quietSinceTick = -Infinity;
      state.owedSinceTick = tick;
      state.owedKind = kind;
      // This wave is warned of: no fallback for it (nor if this warning is dropped
      // unshown: a dropped warning does not re-arm).
      state.invasionUnwarned = false;
    } else if (state.invadedUnwarned && quietLongEnough(state, quiet, tick)) {
      state.invadedUnwarned = false; // that wave is over unwarned
    }
  } else if (quietLongEnough(state, quiet, tick)) {
    state.armed = true;
  }

  if (state.owedSinceTick === -Infinity) return null;
  if (state.owedKind === 'invasion') {
    // Owed until the queue takes it or the invasion ends (or the viewer has no
    // open entrance) — not dropped after ARMY_CAPTION_OWED_TICKS, nor at the
    // breach, as a march or gathering warning is: the warning is disarmed, so no
    // reading could make up for it, and the invasion gets its one warning however
    // long a busy queue (at 4x, 200 ticks is 2.5 s) holds it.
    const target = invasionTarget(state, viewer);
    if (target === null || state.owedSinceTick > tick) {
      state.owedSinceTick = -Infinity;
      return null;
    }
    return invasionWarningText(viewer, target);
  }
  // Broken up by much the same test that re-arms (at most ARMY_REARM_MAX_FIGHTERS
  // marching — chasing counts for a march warning outside an invasion — and near),
  // not by a dip under the army threshold: one fighter stepping out of the radius,
  // or pausing, must not lose the warning for good.
  // Chasers keep only a march warning, and only outside an invasion: once the
  // army is inside — or for a gathering that has broken up — a sally elsewhere
  // must not keep a warning on offer (nor turn it into a march caption).
  const stillOut = invading || state.owedKind === 'gather' ? marchRemains(m) : armyStillOut(m);
  const near = gatheringRemains(g) && !invading;
  if (
    (!stillOut && !near) ||
    state.owedSinceTick > tick ||
    tick - state.owedSinceTick > ARMY_CAPTION_OWED_TICKS
  ) {
    state.owedSinceTick = -Infinity; // stale: drop it
    return null;
  }
  const marchText = stillOut && m !== null ? marchWarningText(viewer, m.entrance) : null;
  const gatherText = near && g !== null ? gatheringWarningText(viewer, g.entrance) : null;
  return state.owedKind === 'march' ? (marchText ?? gatherText) : (gatherText ?? marchText);
}

/** The caption queue took the owed warning. */
export function markArmyWarningShown(state: ArmyWarningState): void {
  state.owedSinceTick = -Infinity;
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
