// enemy-gathering.test.ts — #372: the gathering geometry, the entrance names and
// the once-per-gathering warning hysteresis.

import { describe, it, expect } from 'vitest';
import {
  GATHER_CAPTION_OWED_TICKS,
  GATHER_DWELL_TICKS,
  GATHER_HOME_RADIUS_TILES,
  GATHER_MIN_FIGHTERS,
  GATHER_RADIUS_TILES,
  GATHER_REARM_MAX_FIGHTERS,
  GATHER_REARM_QUIET_TICKS,
  INVASION_NEST_MIN_FIGHTERS,
  createGatheringWarningState,
  enemyFightersInNest,
  entranceDirectionName,
  gatheringWarningText,
  isEnemyGathering,
  markGatheringWarningShown,
  measureEnemyGathering,
  measureEnemyGatheringThisTick,
  nextGatheringWarning,
  resetGatheringWarningState,
  type GatheringWarningState,
} from './enemy-gathering.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { allocateEntityId, type WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;

// raidWorld (seed 7): player door (24, 64), enemy door (104, 64); no spider,
// no AI state, no starting workers.
const DOOR = { x: 24, y: 64 };

/** Move the test world's clock on by `n` ticks (the warning keys on world.tick). */
function advance(w: WorldState, n: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock, not a render write
  w.tick += n;
}

/** Put `n` enemy fighters on the surface around (x, y) (a 4-wide block). */
function army(w: WorldState, n: number, x: number, y: number, colonyId = E): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++)
    ids.push(addFighter(w, colonyId, x + (i % 4), y + ((i / 4) | 0), null));
  return ids;
}

/** Kill fighters (their slots stay, alive = 0). */
function kill(w: WorldState, ids: readonly number[]): void {
  for (const id of ids) w.ants.alive[id] = 0;
}

/** Place an ant at fractional tile (x, y). */
function place(w: WorldState, id: number, x: number, y: number): void {
  w.ants.posX[id] = Math.round(x * FP_ONE);

  w.ants.posY[id] = Math.round(y * FP_ONE);
}

function addEntrance(w: WorldState, c: ColonyRecord, x: number, y: number, isOpen = true) {
  const e: NestEntrance = {
    entranceId: allocateEntityId(w),
    surfaceTileX: x,
    surfaceTileY: y,
    isOpen,
  };
  c.entrances.push(e);
  return e;
}

/** Run the warning `frames` times, one tick apart; return the texts it offered. */
function run(s: GatheringWarningState, w: WorldState, frames: number, take = true): string[] {
  const out: string[] = [];
  for (let i = 0; i < frames; i++) {
    const t = nextGatheringWarning(s, w, P);
    if (t !== null) {
      out.push(t);
      if (take) markGatheringWarningShown(s);
    }
    advance(w, 1);
  }
  return out;
}

describe('measureEnemyGathering — which fighters count', () => {
  it('counts enemy surface fighters near the door, with their bounding box', () => {
    const { world: w } = raidWorld();
    army(w, 6, 36, 62);
    const g = measureEnemyGathering(w, P);
    expect(g).not.toBeNull();
    expect(g!.fighters).toBe(6);
    expect(g!.entrance.surfaceTileX).toBe(DOOR.x);
    // Ant positions are tile centres: x 36..39 → 36.5..39.5, rows 62..63.
    expect([g!.minTileX, g!.maxTileX, g!.minTileY, g!.maxTileY]).toEqual([36.5, 39.5, 62.5, 63.5]);
    expect(isEnemyGathering(g)).toBe(true);
  });

  it('null with no enemy fighter near, or no open viewer entrance', () => {
    const { world: w, player } = raidWorld();
    expect(measureEnemyGathering(w, P)).toBeNull();
    army(w, 6, 36, 62);
    for (const e of player.entrances) e.isOpen = false;
    expect(measureEnemyGathering(w, P)).toBeNull();
    expect(measureEnemyGathering(w, 99)).toBeNull(); // no such colony
  });

  it('skips the viewer’s own fighters, dead ones, underground ones and non-fighters', () => {
    const { world: w } = raidWorld();
    army(w, 3, 36, 62, P); // own
    kill(w, army(w, 3, 36, 62)); // dead
    // In the player's tunnels, at a depth that would put it within reach of the
    // door were it on the surface.
    addFighter(w, E, 36, 62, P);
    const worker = addFighter(w, E, 36, 66, null);

    w.ants.task[worker] = AntTask.Foraging;
    expect(measureEnemyGathering(w, P)).toBeNull();
    const one = addFighter(w, E, 36, 66, null);
    expect(measureEnemyGathering(w, P)!.fighters).toBe(1);
    kill(w, [one]);
  });

  it('radius: GATHER_RADIUS_TILES in, a hair beyond out (straight-line from the door centre)', () => {
    const { world: w } = raidWorld();
    const [id] = army(w, 1, 0, 0);
    const cx = DOOR.x + 0.5;
    const cy = DOOR.y + 0.5;
    place(w, id!, cx + GATHER_RADIUS_TILES, cy);
    expect(measureEnemyGathering(w, P)?.fighters).toBe(1);
    place(w, id!, cx + GATHER_RADIUS_TILES + 0.02, cy);
    expect(measureEnemyGathering(w, P)).toBeNull();
    // Diagonal: 17,17 is 24.04 tiles off — out; 16,17 is 23.35 — in.
    place(w, id!, cx + 17, cy + 17);
    expect(measureEnemyGathering(w, P)).toBeNull();
    place(w, id!, cx + 16, cy + 17);
    expect(measureEnemyGathering(w, P)?.fighters).toBe(1);
  });

  it('a fighter guarding its own entrance is not gathering', () => {
    const { world: w, enemy } = raidWorld();
    // An enemy entrance dug 20 tiles east of the player door.
    const home = addEntrance(w, enemy, DOOR.x + 20, DOOR.y);
    const [id] = army(w, 1, 0, 0);
    const hx = home.surfaceTileX + 0.5;
    const hy = home.surfaceTileY + 0.5;
    place(w, id!, hx - GATHER_HOME_RADIUS_TILES, hy);
    expect(measureEnemyGathering(w, P)).toBeNull();
    place(w, id!, hx - GATHER_HOME_RADIUS_TILES - 0.02, hy);
    expect(measureEnemyGathering(w, P)?.fighters).toBe(1);
    // A closed entrance is not home.
    home.isOpen = false;
    place(w, id!, hx, hy);
    expect(measureEnemyGathering(w, P)?.fighters).toBe(1);
  });

  it('a fighter counts for every entrance it is near; the biggest count wins', () => {
    const { world: w, player } = raidWorld();
    const west = addEntrance(w, player, 4, 64);
    army(w, 2, 8, 66); // within reach of both doors (x 4 and x 24)
    army(w, 3, 30, 66); // 26+ tiles from x 4: only the x-24 door
    const g = measureEnemyGathering(w, P)!;
    expect(g.entrance.surfaceTileX).toBe(DOOR.x);
    expect(g.fighters).toBe(5);
    expect([g.minTileX, g.maxTileX]).toEqual([8.5, 32.5]);
    army(w, 4, 0, 78); // 24+ tiles from x 24: only the west door (2 + 4 = 6)
    expect(measureEnemyGathering(w, P)!.entrance).toBe(west);
    expect(measureEnemyGathering(w, P)!.fighters).toBe(6);
    // A closed entrance draws nobody.
    west.isOpen = false;
    expect(measureEnemyGathering(w, P)!.fighters).toBe(5);
  });

  it('an army between two close entrances is counted whole, not split between them', () => {
    const { world: w, player } = raidWorld();
    addEntrance(w, player, 30, 64);
    // 8 fighters at x 26..29 — half nearer each door.
    army(w, 8, 26, 70);
    const g = measureEnemyGathering(w, P)!;
    expect(g.fighters).toBe(8);
    expect(isEnemyGathering(g)).toBe(true);
  });

  it('equal counts: the entrance the fighters are nearer to on average', () => {
    const { world: w, player } = raidWorld();
    const east = addEntrance(w, player, 28, 64);
    army(w, 6, 40, 60); // all within 24 of both; nearer the x-28 door
    expect(measureEnemyGathering(w, P)!.entrance).toBe(east);
  });

  it('isEnemyGathering: GATHER_MIN_FIGHTERS makes an army, one fewer does not', () => {
    const { world: w } = raidWorld();
    army(w, GATHER_MIN_FIGHTERS - 1, 36, 62);
    expect(isEnemyGathering(measureEnemyGathering(w, P))).toBe(false);
    army(w, 1, 36, 66);
    expect(isEnemyGathering(measureEnemyGathering(w, P))).toBe(true);
    expect(isEnemyGathering(null)).toBe(false);
  });

  it('CLNY-08: the enemy colony as viewer sees the player’s fighters near its own door', () => {
    const { world: w } = raidWorld();
    army(w, 6, 92, 62, P);
    army(w, 6, 36, 62, E);
    const g = measureEnemyGathering(w, E)!;
    expect(g.entrance.surfaceTileX).toBe(104);
    expect(g.fighters).toBe(6);
  });
});

describe('measureEnemyGatheringThisTick — one measurement per world, viewer and tick', () => {
  it('reuses within a tick; measures again on a new tick, world or viewer', () => {
    const { world: w } = raidWorld();
    const ids = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    const first = measureEnemyGatheringThisTick(w, P);
    expect(first!.fighters).toBe(GATHER_MIN_FIGHTERS);
    kill(w, [ids[0]!]); // no tick has run: the memo stands
    expect(measureEnemyGatheringThisTick(w, P)).toBe(first);
    expect(measureEnemyGatheringThisTick(w, E)).toBeNull(); // other viewer
    expect(measureEnemyGatheringThisTick(w, P)!.fighters).toBe(GATHER_MIN_FIGHTERS - 1);
    kill(w, [ids[1]!]);
    advance(w, 1);
    expect(measureEnemyGatheringThisTick(w, P)!.fighters).toBe(GATHER_MIN_FIGHTERS - 2);
    // A new world at the same tick (a restart or load) is measured afresh.
    const other = raidWorld().world;
    advance(other, w.tick - other.tick);
    expect(measureEnemyGatheringThisTick(other, P)).toBeNull();
  });
});

describe('enemyFightersInNest', () => {
  it('counts other colonies’ fighters in the viewer’s tunnels only', () => {
    const { world: w } = raidWorld();
    addFighter(w, E, 30, 5, P);
    addFighter(w, E, 31, 5, P);
    addFighter(w, E, 100, 5, E); // in its own nest
    addFighter(w, P, 30, 6, P); // the viewer's own
    addFighter(w, E, 30, 62, null); // on the surface
    kill(w, [addFighter(w, E, 32, 5, P)]); // dead
    const worker = addFighter(w, E, 33, 5, P);

    w.ants.task[worker] = AntTask.Foraging;
    expect(enemyFightersInNest(w, P)).toBe(2);
  });
});

describe('entranceDirectionName — compass from the middle of the open entrances', () => {
  function colonyWith(points: [number, number][]): { c: ColonyRecord; es: NestEntrance[] } {
    const { world: w, player } = raidWorld();
    player.entrances.length = 0;
    const es = points.map(([x, y]) => addEntrance(w, player, x, y));
    return { c: player, es };
  }

  it('one open entrance: no name', () => {
    const { c, es } = colonyWith([[24, 64]]);
    expect(entranceDirectionName(c, es[0]!)).toBeNull();
  });

  it('two side by side: east and west (screen right is east)', () => {
    const { c, es } = colonyWith([
      [24, 64],
      [40, 62],
    ]);
    expect(entranceDirectionName(c, es[0]!)).toBe('west');
    expect(entranceDirectionName(c, es[1]!)).toBe('east');
  });

  it('stacked: north (screen up) and south', () => {
    const { c, es } = colonyWith([
      [30, 40],
      [31, 70],
    ]);
    expect(entranceDirectionName(c, es[0]!)).toBe('north');
    expect(entranceDirectionName(c, es[1]!)).toBe('south');
  });

  it('diagonal when neither axis is more than twice the other; straight when one is', () => {
    const d = colonyWith([
      [20, 40],
      [40, 60],
    ]);
    expect(entranceDirectionName(d.c, d.es[0]!)).toBe('north-west');
    expect(entranceDirectionName(d.c, d.es[1]!)).toBe('south-east');
    // dx 10, dy 5: exactly 2:1 is still diagonal; dy 4.5 would not be.
    const e = colonyWith([
      [20, 55],
      [40, 65],
    ]);
    expect(entranceDirectionName(e.c, e.es[1]!)).toBe('south-east');
    const f = colonyWith([
      [20, 56],
      [40, 64],
    ]);
    expect(entranceDirectionName(f.c, f.es[1]!)).toBe('east');
    const g = colonyWith([
      [26, 40],
      [34, 60],
    ]);
    expect(entranceDirectionName(g.c, g.es[1]!)).toBe('south');
    // dy 10, dx 5: exactly 2:1 the other way is diagonal too.
    const h = colonyWith([
      [25, 50],
      [35, 70],
    ]);
    expect(entranceDirectionName(h.c, h.es[1]!)).toBe('south-east');
  });

  it('no name for the middle one, or when two share a name', () => {
    const mid = colonyWith([
      [20, 64],
      [30, 64],
      [40, 64],
    ]);
    expect(entranceDirectionName(mid.c, mid.es[0]!)).toBe('west');
    expect(entranceDirectionName(mid.c, mid.es[1]!)).toBeNull();
    expect(entranceDirectionName(mid.c, mid.es[2]!)).toBe('east');
    // Two east of the middle: neither is "the east entrance".
    const pair = colonyWith([
      [10, 64],
      [40, 60],
      [40, 68],
    ]);
    expect(entranceDirectionName(pair.c, pair.es[0]!)).toBe('west');
    expect(entranceDirectionName(pair.c, pair.es[1]!)).toBeNull();
    expect(entranceDirectionName(pair.c, pair.es[2]!)).toBeNull();
  });

  it('closed entrances do not count, and a closed one gets no name', () => {
    const { c, es } = colonyWith([
      [24, 64],
      [40, 64],
      [60, 64],
    ]);
    es[2]!.isOpen = false;
    expect(entranceDirectionName(c, es[1]!)).toBe('east');
    expect(entranceDirectionName(c, es[2]!)).toBeNull();
  });
});

describe('gatheringWarningText', () => {
  it('names the entrance, or says "your entrance" with only one', () => {
    const { world: w, player } = raidWorld();
    const door = player.entrances[0]!;
    expect(gatheringWarningText(player, door)).toBe(
      'An enemy army is gathering near your entrance. Train fighters and rally them there.',
    );
    addEntrance(w, player, 40, 64);
    expect(gatheringWarningText(player, door)).toBe(
      'An enemy army is gathering near your west entrance. Train fighters and rally them there.',
    );
    addEntrance(w, player, 32, 64); // the old door is still the west one
    const mid = player.entrances[2]!;
    expect(gatheringWarningText(player, mid)).toBe(
      'An enemy army is gathering near one of your entrances, ringed on the minimap. Train fighters and rally them there.',
    );
  });
});

describe('nextGatheringWarning — once per gathering', () => {
  it('fires after GATHER_DWELL_TICKS of gathering, then not again while the army stays', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS)).toEqual([]); // ticks +0 .. +DWELL-1
    expect(run(s, w, 1)).toEqual([
      'An enemy army is gathering near your entrance. Train fighters and rally them there.',
    ]);
    expect(s.armed).toBe(false);
    expect(run(s, w, 2000)).toEqual([]);
  });

  it('the dwell restarts when the gathering breaks up', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    const ids = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS - 1);
    kill(w, [ids[0]!]);
    run(s, w, 1);
    army(w, 1, 36, 66);
    expect(run(s, w, GATHER_DWELL_TICKS)).toEqual([]);
    expect(run(s, w, 1)).toHaveLength(1);
  });

  it('does not fire while an invasion is under way (INVASION_NEST_MIN_FIGHTERS in the nest)', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    const inNest: number[] = [];
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++)
      inNest.push(addFighter(w, E, 30 + i, 5, P));
    expect(run(s, w, 500)).toEqual([]);
    // Even once the invasion ends and the army still stands there: used up.
    kill(w, inNest);
    expect(run(s, w, GATHER_REARM_QUIET_TICKS * 2)).toEqual([]);
  });

  it('one fewer than INVASION_NEST_MIN_FIGHTERS in the nest (a raider or two) is no invasion', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS - 1; i++) addFighter(w, E, 30 + i, 5, P);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toHaveLength(1);
  });

  it('re-arms after GATHER_REARM_QUIET_TICKS with the army gone, then fires for the next one', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    const first = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toHaveLength(1);
    // Disperse to GATHER_REARM_MAX_FIGHTERS stragglers.
    kill(w, first.slice(GATHER_REARM_MAX_FIGHTERS));
    run(s, w, GATHER_REARM_QUIET_TICKS);
    expect(s.armed).toBe(false);
    run(s, w, 1);
    expect(s.armed).toBe(true);
    army(w, GATHER_MIN_FIGHTERS, 36, 66);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toHaveLength(1);
  });

  it('stays disarmed while more than GATHER_REARM_MAX_FIGHTERS linger, however long', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    const ids = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1);
    kill(w, ids.slice(GATHER_REARM_MAX_FIGHTERS + 1));
    run(s, w, GATHER_REARM_QUIET_TICKS * 5);
    expect(s.armed).toBe(false);
  });

  it('stays disarmed while the invasion is inside the nest, re-arms once it ends', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    const ids = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1);
    // The army goes down the entrance: off the surface, into the tunnels.
    kill(w, ids);
    const inNest: number[] = [];
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++)
      inNest.push(addFighter(w, E, 30 + i, 5, P));
    run(s, w, GATHER_REARM_QUIET_TICKS * 3);
    expect(s.armed).toBe(false);
    // Beaten: the invaders die.
    kill(w, inNest);
    run(s, w, GATHER_REARM_QUIET_TICKS + 1);
    expect(s.armed).toBe(true);
  });

  it('an owed warning is offered each frame until taken', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    // The queue never takes it (take = false): offered every frame of its window.
    const offered = run(s, w, GATHER_DWELL_TICKS + 1 + GATHER_CAPTION_OWED_TICKS + 50, false);
    expect(offered).toHaveLength(GATHER_CAPTION_OWED_TICKS + 1);
    expect(s.owedSinceTick).toBe(-Infinity); // expired
    expect(s.armed).toBe(false); // an expired warning does not re-arm
  });

  it('an owed warning survives a dip under GATHER_MIN_FIGHTERS, goes stale when the army breaks up', () => {
    const a = raidWorld().world;
    const sa = createGatheringWarningState();
    const ids = army(a, GATHER_MIN_FIGHTERS, 36, 62);
    run(sa, a, GATHER_DWELL_TICKS, false);
    expect(run(sa, a, 1, false)).toHaveLength(1);
    kill(a, [ids[0]!]); // 5 left: still owed
    expect(run(sa, a, 1, false)).toHaveLength(1);
    kill(a, ids.slice(1, GATHER_MIN_FIGHTERS - GATHER_REARM_MAX_FIGHTERS - 1)); // 3 left
    expect(run(sa, a, 1, false)).toHaveLength(1);
    kill(a, [ids[GATHER_MIN_FIGHTERS - GATHER_REARM_MAX_FIGHTERS - 1]!]); // 2 left: broken up
    expect(run(sa, a, 1, false)).toEqual([]);
    army(a, 4, 36, 66);
    expect(run(sa, a, 50, false)).toEqual([]); // dropped for good, still disarmed

    const b = raidWorld().world;
    const sb = createGatheringWarningState();
    army(b, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(sb, b, GATHER_DWELL_TICKS + 1, false)).toHaveLength(1);
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++) addFighter(b, E, 30 + i, 5, P);
    expect(run(sb, b, 1, false)).toEqual([]);
  });

  it('an invasion before any warning uses the gathering up: retreating survivors raise none', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    const inNest: number[] = [];
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++)
      inNest.push(addFighter(w, E, 30 + i, 5, P));
    run(s, w, 1);
    expect(s.armed).toBe(false);
    expect(s.owedSinceTick).toBe(-Infinity);
    // The invaders come back out and walk off past the door.
    kill(w, inNest);
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS * 5)).toEqual([]);
  });

  it('an owed warning from a later tick (a clock that ran backwards) is dropped', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1, false);
    expect(s.owedSinceTick).not.toBe(-Infinity);
    advance(w, -100);
    expect(run(s, w, 1, false)).toEqual([]);
  });

  it('names the entrance the army is near when offered', () => {
    const { world: w, player } = raidWorld();
    addEntrance(w, player, 8, 62);
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toEqual([
      'An enemy army is gathering near your east entrance. Train fighters and rally them there.',
    ]);
  });

  it('a clock that runs backwards (a loaded save) restarts the dwell rather than firing', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    advance(w, 1000);
    run(s, w, 10);
    advance(w, -500);
    expect(run(s, w, GATHER_DWELL_TICKS)).toEqual([]);
    expect(run(s, w, 1)).toHaveLength(1);
  });

  it('reset re-arms and clears anything owed', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1, false);
    expect(s.armed).toBe(false);
    resetGatheringWarningState(s);
    expect(s).toEqual(createGatheringWarningState());
  });

  it('no viewer colony: nothing', () => {
    const { world: w } = raidWorld();
    const s = createGatheringWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    for (let i = 0; i < GATHER_DWELL_TICKS + 5; i++) {
      expect(nextGatheringWarning(s, w, 99)).toBeNull();
      advance(w, 1);
    }
  });
});
