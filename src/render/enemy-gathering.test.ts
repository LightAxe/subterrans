// enemy-gathering.test.ts — #372: the gathering geometry, the entrance names and
// the army warning's hysteresis (#394: once per wave, marching or gathering).

import { describe, it, expect } from 'vitest';
import {
  ARMY_WARNING_HINT,
  GATHER_CAPTION_OWED_TICKS,
  GATHER_DWELL_TICKS,
  GATHER_HOME_RADIUS_TILES,
  GATHER_MIN_FIGHTERS,
  GATHER_RADIUS_TILES,
  GATHER_REARM_MAX_FIGHTERS,
  GATHER_REARM_QUIET_TICKS,
  INVASION_NEST_MIN_FIGHTERS,
  INVASION_WATCH_TICKS,
  createArmyWarningState,
  enemyFightersInNest,
  entranceDirectionName,
  gatheringWarningText,
  invasionWarningText,
  isEnemyGathering,
  marchWarningText,
  markArmyWarningShown,
  measureEnemyGathering,
  measureEnemyGatheringThisTick,
  nextArmyWarning,
  noteArmyWarningEvent,
  resetArmyWarningState,
  type ArmyWarningState,
} from './enemy-gathering.js';
import type { SimEvent } from '../sim/telemetry.js';
import { AI_PROBE_FIGHTER_COUNT, ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { allocateEntityId, type WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';
import {
  measureEnemyMarchThisTick,
  MARCH_DWELL_TICKS,
  MARCH_HOME_RADIUS_TILES,
  MARCH_MIN_FIGHTERS,
  MARCH_SAMPLE_TICKS,
  MARCH_WINDOW_TICKS,
} from './enemy-march.js';

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
function run(s: ArmyWarningState, w: WorldState, frames: number, take = true): string[] {
  const out: string[] = [];
  for (let i = 0; i < frames; i++) {
    const t = nextArmyWarning(s, w, P);
    if (t !== null) {
      out.push(t);
      if (take) markArmyWarningShown(s);
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
      'An enemy army is gathering near your entrance. Train fighters and rally there.',
    );
    addEntrance(w, player, 40, 64);
    expect(gatheringWarningText(player, door)).toBe(
      'An enemy army is gathering near your west entrance. Train fighters and rally there.',
    );
    addEntrance(w, player, 32, 64); // the old door is still the west one
    const mid = player.entrances[2]!;
    expect(gatheringWarningText(player, mid)).toBe(
      'An enemy army is gathering near one of your entrances, ringed on the minimap. Train fighters and rally there.',
    );
  });
});

describe('nextArmyWarning — a gathering, once per wave', () => {
  it('fires after GATHER_DWELL_TICKS of gathering, then not again while the army stays', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS)).toEqual([]); // ticks +0 .. +DWELL-1
    expect(run(s, w, 1)).toEqual([
      'An enemy army is gathering near your entrance. Train fighters and rally there.',
    ]);
    expect(s.armed).toBe(false);
    expect(run(s, w, 2000)).toEqual([]);
  });

  it('the dwell restarts when the gathering breaks up', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
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
    const s = createArmyWarningState();
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
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS - 1; i++) addFighter(w, E, 30 + i, 5, P);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toHaveLength(1);
  });

  it('re-arms after GATHER_REARM_QUIET_TICKS with the army gone, then fires for the next one', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
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

  it('a 3-fighter probe cohort lingering by the door does not keep it disarmed (#394)', () => {
    // The AI's probe sends AI_PROBE_FIGHTER_COUNT (3) fighters, which can stand at
    // a food pile by the door for 30 s; the invasion that follows must still be
    // warned of. A retuned probe must not silently bring that back: the re-arm
    // allowance covers it, and stays below an army of either kind.
    expect(GATHER_REARM_MAX_FIGHTERS).toBe(3);
    expect(GATHER_REARM_MAX_FIGHTERS).toBeGreaterThanOrEqual(AI_PROBE_FIGHTER_COUNT);
    expect(GATHER_REARM_MAX_FIGHTERS).toBeLessThan(GATHER_MIN_FIGHTERS);
    expect(GATHER_REARM_MAX_FIGHTERS).toBeLessThan(MARCH_MIN_FIGHTERS);
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toHaveLength(1);
    kill(w, ids.slice(3));
    run(s, w, GATHER_REARM_QUIET_TICKS + 1);
    expect(s.armed).toBe(true);
  });

  it('stays disarmed while more than GATHER_REARM_MAX_FIGHTERS linger, however long', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1);
    kill(w, ids.slice(GATHER_REARM_MAX_FIGHTERS + 1));
    run(s, w, GATHER_REARM_QUIET_TICKS * 5);
    expect(s.armed).toBe(false);
  });

  it('stays disarmed while the invasion is inside the nest, re-arms once it ends', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
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
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    // The queue never takes it (take = false): offered every frame of its window.
    const offered = run(s, w, GATHER_DWELL_TICKS + 1 + GATHER_CAPTION_OWED_TICKS + 50, false);
    expect(offered).toHaveLength(GATHER_CAPTION_OWED_TICKS + 1);
    expect(s.owedSinceTick).toBe(-Infinity); // expired
    expect(s.armed).toBe(false); // an expired warning does not re-arm
  });

  it('an owed warning survives a dip under GATHER_MIN_FIGHTERS, goes stale when the army breaks up', () => {
    const a = raidWorld().world;
    const sa = createArmyWarningState();
    const ids = army(a, GATHER_MIN_FIGHTERS, 36, 62);
    run(sa, a, GATHER_DWELL_TICKS, false);
    expect(run(sa, a, 1, false)).toHaveLength(1);
    kill(a, [ids[0]!]); // 5 left: still owed
    expect(run(sa, a, 1, false)).toHaveLength(1);
    kill(a, ids.slice(1, GATHER_MIN_FIGHTERS - GATHER_REARM_MAX_FIGHTERS - 1)); // MAX + 1 left
    expect(run(sa, a, 1, false)).toHaveLength(1);
    kill(a, [ids[GATHER_MIN_FIGHTERS - GATHER_REARM_MAX_FIGHTERS - 1]!]); // MAX left: broken up
    expect(run(sa, a, 1, false)).toEqual([]);
    army(a, 4, 36, 66);
    expect(run(sa, a, 50, false)).toEqual([]); // dropped for good, still disarmed

    const b = raidWorld().world;
    const sb = createArmyWarningState();
    army(b, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(sb, b, GATHER_DWELL_TICKS + 1, false)).toHaveLength(1);
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++) addFighter(b, E, 30 + i, 5, P);
    expect(run(sb, b, 1, false)).toEqual([]);
  });

  it('an invasion before any warning uses the gathering up: retreating survivors raise no gathering warning', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const inNest: number[] = [];
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++)
      inNest.push(addFighter(w, E, 30 + i, 5, P));
    run(s, w, 1);
    // #394: still armed (an army marching behind it would yet be warned of), but
    // this wave raises no gathering warning.
    expect(s.armed).toBe(true);
    expect(s.invadedUnwarned).toBe(true);
    expect(s.owedSinceTick).toBe(-Infinity);
    // The invaders come back out and walk off past the door.
    kill(w, inNest);
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS * 5)).toEqual([]);
  });

  it('an owed warning from a later tick (a clock that ran backwards) is dropped', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1, false);
    expect(s.owedSinceTick).not.toBe(-Infinity);
    advance(w, -100);
    expect(run(s, w, 1, false)).toEqual([]);
  });

  it('names the entrance the army is near when offered', () => {
    const { world: w, player } = raidWorld();
    addEntrance(w, player, 8, 62);
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toEqual([
      'An enemy army is gathering near your east entrance. Train fighters and rally there.',
    ]);
  });

  it('a clock that runs backwards (a loaded save) restarts the dwell rather than firing', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    advance(w, 1000);
    run(s, w, 10);
    advance(w, -500);
    expect(run(s, w, GATHER_DWELL_TICKS)).toEqual([]);
    expect(run(s, w, 1)).toHaveLength(1);
  });

  it('reset re-arms and clears anything owed', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    run(s, w, GATHER_DWELL_TICKS + 1, false);
    expect(s.armed).toBe(false);
    resetArmyWarningState(s);
    expect(s).toEqual(createArmyWarningState());
  });

  it('no viewer colony: nothing', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    for (let i = 0; i < GATHER_DWELL_TICKS + 5; i++) {
      expect(nextArmyWarning(s, w, 99)).toBeNull();
      advance(w, 1);
    }
  });
});

describe('ARMY_WARNING_HINT (#394)', () => {
  it('both army warnings end with the same hint', () => {
    const { world: w, player } = raidWorld();
    const door = player.entrances[0]!;
    expect(ARMY_WARNING_HINT).toBe('Train fighters and rally there.');
    expect(gatheringWarningText(player, door).endsWith(` ${ARMY_WARNING_HINT}`)).toBe(true);
    expect(marchWarningText(player, door).endsWith(` ${ARMY_WARNING_HINT}`)).toBe(true);
    addEntrance(w, player, 10, 64);
    expect(gatheringWarningText(player, door).endsWith(` ${ARMY_WARNING_HINT}`)).toBe(true);
    expect(marchWarningText(player, door).endsWith(` ${ARMY_WARNING_HINT}`)).toBe(true);
  });
});

describe('marchWarningText (#394)', () => {
  it('names the entrance, or says "your entrance" with only one', () => {
    const { world: w, player } = raidWorld();
    const door = player.entrances[0]!;
    expect(marchWarningText(player, door)).toBe(
      'An enemy army is marching on your entrance. Train fighters and rally there.',
    );
    addEntrance(w, player, 8, 64);
    expect(marchWarningText(player, door)).toBe(
      'An enemy army is marching on your east entrance. Train fighters and rally there.',
    );
    addEntrance(w, player, 16, 64); // the middle one has no name
    expect(marchWarningText(player, player.entrances[2]!)).toBe(
      'An enemy army is marching on one of your entrances, ringed on the minimap. Train fighters and rally there.',
    );
  });
});

describe('nextArmyWarning — an army marching (#394)', () => {
  const ONE_DOOR = 'An enemy army is marching on your entrance. Train fighters and rally there.';

  /** Run the warning `frames` times, one tick apart, moving every ant in `ids`
   *  (dx, dy) tiles each tick first; return the texts it offered. */
  function march(
    s: ArmyWarningState,
    w: WorldState,
    ids: readonly number[],
    frames: number,
    dx: number,
    dy = 0,
    take = true,
  ): string[] {
    const out: string[] = [];
    for (let i = 0; i < frames; i++) {
      for (const id of ids) {
        w.ants.posX[id] = w.ants.posX[id]! + Math.round(dx * FP_ONE);
        w.ants.posY[id] = w.ants.posY[id]! + Math.round(dy * FP_ONE);
      }
      const t = nextArmyWarning(s, w, P);
      if (t !== null) {
        out.push(t);
        if (take) markArmyWarningShown(s);
      }
      advance(w, 1);
    }
    return out;
  }

  /** Frames an army marching from tick 0 of a fresh world goes unwarned: its
   *  heading is first known at MARCH_WINDOW_TICKS, and the march must then hold
   *  MARCH_DWELL_TICKS. It is warned of on the frame after. */
  const DUE = MARCH_WINDOW_TICKS + MARCH_DWELL_TICKS;

  /** `n` enemy fighters well out from both nests (x 70..73), a 4-wide block. */
  const host = (w: WorldState, n: number, x = 70, y = 62) => army(w, n, x, y);

  /** Put INVASION_NEST_MIN_FIGHTERS enemy fighters in the player's tunnels. */
  function breach(w: WorldState): number[] {
    const ids: number[] = [];
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++) ids.push(addFighter(w, E, 30 + i, 5, P));
    return ids;
  }

  it('warns once the march has held MARCH_DWELL_TICKS, then not again for that wave', () => {
    // A quarter-second: one sample interval. The measured warning lead (#394)
    // assumes it; a longer dwell eats into the march.
    expect(MARCH_DWELL_TICKS).toBe(5);
    expect(MARCH_DWELL_TICKS).toBe(MARCH_SAMPLE_TICKS);
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS);
    // Ticks 0..WINDOW-1 have no sample a window old; the first heading is at
    // WINDOW, and the march must hold MARCH_DWELL_TICKS from then.
    expect(march(s, w, ids, DUE, -0.5)).toEqual([]);
    expect(s.armed).toBe(true);
    expect(march(s, w, ids, 1, -0.5)).toEqual([ONE_DOOR]);
    expect(s.armed).toBe(false);
    // On to the door (about 46 tiles at 0.5 a tick) and standing there: nothing more.
    expect(march(s, w, ids, 90, -0.5)).toEqual([]);
    expect(run(s, w, 1000)).toEqual([]);
  });

  it('a march that breaks before MARCH_DWELL_TICKS (a surge, one frame) restarts the dwell', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, ids, DUE - 1, -0.5)).toEqual([]);
    // One frame they stand 20 tiles east (heading away: no march), then back.
    expect(march(s, w, ids, 1, 20)).toEqual([]);
    expect(march(s, w, ids, 1, -20.5)).toEqual([]);
    // The dwell runs again from that frame.
    expect(march(s, w, ids, MARCH_DWELL_TICKS - 1, -0.5)).toEqual([]);
    expect(s.armed).toBe(true);
    expect(march(s, w, ids, 1, -0.5)).toEqual([ONE_DOOR]);
  });

  it('MARCH_MIN_FIGHTERS - 1 marching (a probe) raise none', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS - 1);
    expect(march(s, w, ids, 90, -0.5)).toEqual([]);
    expect(s.armed).toBe(true);
  });

  it('an army still within MARCH_HOME_RADIUS_TILES of its own nest is not yet marching', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    // Beside the enemy door (centre 104.5, 64.5), walking west: the last of them
    // (from 103.5, 63.5) is past MARCH_HOME_RADIUS_TILES after `steps` steps — well
    // after its heading is known (MARCH_WINDOW_TICKS).
    const ids = army(w, MARCH_MIN_FIGHTERS, 100, 63);
    const R = MARCH_HOME_RADIUS_TILES;
    const steps = Math.floor(2 * (Math.sqrt(R * R - 1) - 1)) + 1; // of 0.5 tile
    expect(steps).toBeGreaterThan(MARCH_WINDOW_TICKS + 5);
    // The last of them is out on step `steps`; the march then holds the dwell.
    expect(march(s, w, ids, steps - 1 + MARCH_DWELL_TICKS, -0.5)).toEqual([]);
    expect(march(s, w, ids, 1, -0.5)).toEqual([ONE_DOOR]);
  });

  it('names the entrance it marches on', () => {
    const { world: w, player } = raidWorld();
    addEntrance(w, player, 24, 30); // a north door
    const s = createArmyWarningState();
    // From (70, 62) straight at the row-64 door: the south one.
    const ids = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, ids, DUE + 1, -0.5)).toEqual([
      'An enemy army is marching on your south entrance. Train fighters and rally there.',
    ]);
  });

  it('a march outranks a gathering that comes due on the same frame', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62); // standing near the door
    // The gathering's dwell ends on the frame the march's does (a fresh world's
    // history samples every MARCH_SAMPLE_TICKS from tick 0, so the host appearing
    // at GATHER_DWELL_TICKS - DUE is sampled at once).
    expect((GATHER_DWELL_TICKS - DUE) % MARCH_SAMPLE_TICKS).toBe(0);
    expect(run(s, w, GATHER_DWELL_TICKS - DUE)).toEqual([]);
    const ids = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, ids, DUE, -0.5)).toEqual([]);
    expect(march(s, w, ids, 1, -0.5)).toEqual([ONE_DOOR]);
  });

  it('a second wave after things go quiet warns again (every invasion, not only the first)', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const first = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, first, DUE + 1, -0.5)).toEqual([ONE_DOOR]);
    // It goes in, and is beaten.
    kill(w, first);
    const inside = breach(w);
    expect(run(s, w, 300)).toEqual([]);
    kill(w, inside);
    run(s, w, GATHER_REARM_QUIET_TICKS + 1);
    expect(s.armed).toBe(true);
    // (Its heading is known a window after the first sample that sees it, which
    // may be up to MARCH_SAMPLE_TICKS after it appears.)
    const second = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, second, DUE + MARCH_SAMPLE_TICKS, -0.5)).toEqual([ONE_DOOR]);
  });

  it('a vanguard breaching first does not use the wave up: the army marching behind it warns', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    breach(w);
    expect(run(s, w, 5)).toEqual([]);
    expect(s.armed).toBe(true);
    expect(s.invadedUnwarned).toBe(true);
    const ids = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, ids, DUE + MARCH_SAMPLE_TICKS, -0.5)).toEqual([ONE_DOOR]);
  });

  it('a wave that broke in unwarned ends once quiet; a later gathering then warns', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const inside = breach(w);
    run(s, w, 50);
    kill(w, inside);
    run(s, w, GATHER_REARM_QUIET_TICKS);
    expect(s.invadedUnwarned).toBe(true);
    run(s, w, 1);
    expect(s.invadedUnwarned).toBe(false);
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toEqual([
      'An enemy army is gathering near your entrance. Train fighters and rally there.',
    ]);
  });

  it('stays disarmed while more than GATHER_REARM_MAX_FIGHTERS are still marching, however long', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    // From the far north-east, slowly (0.16 tile a tick, 3.2 tiles a window)
    // straight at the door, never coming within GATHER_RADIUS_TILES of it: only the
    // march itself can keep the warning disarmed.
    const ids = army(w, MARCH_MIN_FIGHTERS, 84, 4);
    const dx = -0.16 * (61 / Math.hypot(61, 60));
    const dy = 0.16 * (60 / Math.hypot(61, 60));
    expect(march(s, w, ids, DUE + 1, dx, dy)).toEqual([ONE_DOOR]);
    kill(w, ids.slice(GATHER_REARM_MAX_FIGHTERS + 1));
    const left = ids.slice(0, GATHER_REARM_MAX_FIGHTERS + 1);
    expect(march(s, w, left, GATHER_REARM_QUIET_TICKS + 50, dx, dy)).toEqual([]);
    expect(s.armed).toBe(false);
    expect(measureEnemyGathering(w, P)).toBeNull();
    // They are killed: quiet from then on.
    kill(w, left);
    run(s, w, GATHER_REARM_QUIET_TICKS + 1);
    expect(s.armed).toBe(true);
  });

  it('a sally chasing the player’s raiders home is no march; once they are gone it is', () => {
    // Six enemy fighters 25-28 tiles out from their door chase three of the
    // player's, running west 4-9 tiles in front of them (an AI sally after a
    // hit-and-run raid), slowly enough to stay near home.
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS, 76, 62);
    const raiders = [70, 71, 72].map((x) => addFighter(w, P, x, 62 + (x % 2), null));
    expect(march(s, w, [...ids, ...raiders], DUE + 15, -0.2)).toEqual([]);
    expect(s.armed).toBe(true);
    expect(measureEnemyMarchThisTick(w, P)).toMatchObject({
      fighters: 0,
      chasing: MARCH_MIN_FIGHTERS,
    });
    advance(w, 1); // (that measurement is this tick's: frames go on from the next)
    // The raiders are gone (below ground at home, say): the six march on alone.
    kill(w, raiders);
    expect(march(s, w, ids, MARCH_DWELL_TICKS, -0.2)).toEqual([]);
    expect(march(s, w, ids, 1, -0.2)).toEqual([ONE_DOOR]);
  });

  it('a sally’s chase does not hold a finished wave open: the warning re-arms on time', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const first = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, first, DUE + 1, -0.5)).toEqual([ONE_DOOR]);
    kill(w, first); // beaten in the field: quiet from here
    // A sally then chases three of the player's raiders home, near its own door.
    const sally = host(w, MARCH_MIN_FIGHTERS, 76, 62);
    const raiders = [70, 71, 72].map((x) => addFighter(w, P, x, 62 + (x % 2), null));
    const both = [...sally, ...raiders];
    expect(march(s, w, both, 45, -0.2)).toEqual([]);
    expect(measureEnemyMarchThisTick(w, P)).toMatchObject({
      fighters: 0,
      chasing: MARCH_MIN_FIGHTERS,
    });
    advance(w, 1); // (that measurement is this tick's: frames go on from the next)
    kill(w, both);
    // Quiet since the first army fell, the chase included: re-armed on time.
    run(s, w, GATHER_REARM_QUIET_TICKS - 46);
    expect(s.armed).toBe(false);
    run(s, w, 1);
    expect(s.armed).toBe(true);
  });

  it('chasers do not keep an owed gathering warning that broke up (nor make it a march)', () => {
    // A gathering by the door comes due while the queue is busy (owed), and a
    // sally near the enemy's home chases three of the player's raiders. The
    // gathering then breaks up: the warning is stale — the sally is no march.
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const gathered = army(w, GATHER_MIN_FIGHTERS, 36, 62);
    const sally = host(w, MARCH_MIN_FIGHTERS, 76, 62);
    const raiders = [70, 71, 72].map((x) => addFighter(w, P, x, 62 + (x % 2), null));
    const both = [...sally, ...raiders];
    expect(march(s, w, both, GATHER_DWELL_TICKS + 1, -0.2, 0, false).at(-1)).toBe(
      'An enemy army is gathering near your entrance. Train fighters and rally there.',
    );
    expect(measureEnemyMarchThisTick(w, P)).toMatchObject({
      fighters: 0,
      chasing: MARCH_MIN_FIGHTERS,
    });
    advance(w, 1); // (that measurement is this tick's: frames go on from the next)
    kill(w, gathered.slice(GATHER_REARM_MAX_FIGHTERS));
    expect(march(s, w, both, 1, -0.2, 0, false)).toEqual([]);
    expect(s.owedSinceTick).toBe(-Infinity);
  });

  it('an owed march warning stays owed while its army chases the player’s fighters', () => {
    // Warned of (owed, not yet taken) near its own home; then three of the
    // player's fighters run before it. Every one is chasing — no army — but the
    // wave is not over, so the warning is still offered.
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS, 76, 62);
    expect(march(s, w, ids, DUE + 1, -0.2, 0, false)).toEqual([ONE_DOOR]);
    const lead = w.ants.posX[ids[0]!]! / FP_ONE;
    const runners = [0, 1, 2].map(() => addFighter(w, P, 40, 40, null));
    runners.forEach((id, i) => place(w, id, lead - 4 - i, 62.5 + (i % 2)));
    const all = [...ids, ...runners];
    // (The runners' headings are known a window after the first sample that sees
    // them, which may be up to MARCH_SAMPLE_TICKS after they appear.)
    march(s, w, all, MARCH_WINDOW_TICKS + MARCH_SAMPLE_TICKS, -0.2, 0, false);
    expect(measureEnemyMarchThisTick(w, P)).toMatchObject({
      fighters: 0,
      chasing: MARCH_MIN_FIGHTERS,
    });
    advance(w, 1); // (that measurement is this tick's: frames go on from the next)
    expect(march(s, w, all, 1, -0.2, 0, false)).toEqual([ONE_DOOR]);
    // An invasion breaks in: chasers no longer keep it — it is stale, dropped.
    breach(w);
    expect(march(s, w, all, 1, -0.2, 0, false)).toEqual([]);
    expect(s.owedSinceTick).toBe(-Infinity);
  });

  it('an owed march warning: offered while it marches, then as a gathering once at the door', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS, 43, 62);
    expect(march(s, w, ids, DUE + 1, -0.5, 0, false)).toEqual([ONE_DOOR]);
    // Still marching: the march text; then it stops 6 tiles short of the door.
    expect(march(s, w, ids, 1, -0.5, 0, false)).toEqual([ONE_DOOR]);
    expect(run(s, w, MARCH_WINDOW_TICKS + 1, false).at(-1)).toBe(
      'An enemy army is gathering near your entrance. Train fighters and rally there.',
    );
    // In it goes: an army already inside is too late to warn of.
    kill(w, ids);
    breach(w);
    expect(run(s, w, 1, false)).toEqual([]);
    expect(s.owedSinceTick).toBe(-Infinity);
  });

  it('an owed march warning survives a breach while the army is still marching', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = host(w, MARCH_MIN_FIGHTERS);
    expect(march(s, w, ids, DUE + 1, -0.5, 0, false)).toEqual([ONE_DOOR]);
    breach(w);
    expect(march(s, w, ids, 1, -0.5, 0, false)).toEqual([ONE_DOOR]);
  });

  it('CLNY-08: the enemy as viewer is warned of the player’s army marching on its door', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = army(w, MARCH_MIN_FIGHTERS, 40, 62, P);
    const out: string[] = [];
    for (let i = 0; i < DUE + 1; i++) {
      for (const id of ids) w.ants.posX[id] = w.ants.posX[id]! + FP_ONE / 2;
      const t = nextArmyWarning(s, w, E);
      if (t !== null) out.push(t);
      advance(w, 1);
    }
    expect(out).toEqual([ONE_DOOR]);
  });
});

describe('nextArmyWarning — the invasion fallback (#404 review)', () => {
  const HINT = 'Train fighters and rally there.';
  const ONE_DOOR = `An enemy army is marching on your entrance. ${HINT}`;
  const EAST = `An enemy army is marching on your east entrance. ${HINT}`;
  // raidWorld's enemy door is (104, 64). A player door opened 8 tiles from it.
  const NEAR = { x: 96, y: 64 };

  const start = (w: WorldState, rally: { x: number; y: number }, from = E, at = P): SimEvent =>
    ({
      tick: w.tick,
      type: 'invasion_start',
      payload: {
        colonyId: from,
        rallyTile: { x: rally.x, y: rally.y, grid: 'surface' },
        fighterCount: 12,
        targetGrid: at,
      },
    }) satisfies SimEvent;
  const end = (w: WorldState, from = E): SimEvent =>
    ({
      tick: w.tick,
      type: 'invasion_end',
      payload: { colonyId: from, outcome: 'fighter_rout', attackerLosses: 0, defenderLosses: 0 },
    }) satisfies SimEvent;

  /** Put INVASION_NEST_MIN_FIGHTERS enemy fighters in the player's tunnels. */
  function breach(w: WorldState): number[] {
    const ids: number[] = [];
    for (let i = 0; i < INVASION_NEST_MIN_FIGHTERS; i++) ids.push(addFighter(w, E, 30 + i, 5, P));
    return ids;
  }

  /** Move every ant in `ids` (dx, 0) tiles a tick for `frames` frames, running the
   *  warning each frame; the texts it offered. */
  function marchFrames(s: ArmyWarningState, w: WorldState, ids: readonly number[], frames: number) {
    const out: string[] = [];
    for (let i = 0; i < frames; i++) {
      for (const id of ids) w.ants.posX[id] = w.ants.posX[id]! - FP_ONE / 2;
      out.push(...run(s, w, 1));
    }
    return out;
  }

  /** A world with the player's door by the enemy nest as well as its own (24, 64),
   *  and the enemy's army standing at home: neither reading sees it, ever. */
  function nearDoorWorld() {
    const r = raidWorld();
    const near = addEntrance(r.world, r.player, NEAR.x, NEAR.y);
    const host = army(r.world, 12, 100, 60);
    return { ...r, near, host };
  }

  it('an invasion of a door by the enemy nest is warned of as it sets out, naming it — once', () => {
    const { world: w, player, near, host } = nearDoorWorld();
    const s = createArmyWarningState();
    expect(run(s, w, 60)).toEqual([]); // the army at home: neither reading sees it
    expect(entranceDirectionName(player, near)).toBe('east');
    noteArmyWarningEvent(s, start(w, NEAR), P);
    expect(run(s, w, 1)).toEqual([EAST]);
    // It walks over and gets in, and stands about: no second warning for it.
    for (const id of host) place(w, id, NEAR.x + 1.5, NEAR.y + 0.5);
    const inside = breach(w);
    expect(run(s, w, 300)).toEqual([]);
    kill(w, inside);
    expect(run(s, w, GATHER_REARM_QUIET_TICKS + 50)).toEqual([]);
  });

  it('why: without it that invasion gets no warning at all', () => {
    const { world: w, host } = nearDoorWorld();
    const s = createArmyWarningState();
    for (const id of host) place(w, id, NEAR.x + 1.5, NEAR.y + 0.5);
    breach(w);
    expect(run(s, w, 300)).toEqual([]);
  });

  it('any invasion is warned of as it sets out, before the march can be read — and not again', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    const ids = army(w, MARCH_MIN_FIGHTERS, 70, 62);
    noteArmyWarningEvent(s, start(w, { x: 25, y: 64 }), P);
    expect(run(s, w, 1)).toEqual([ONE_DOOR]);
    // The march it then reads, and the breach, are that same wave.
    expect(marchFrames(s, w, ids, MARCH_WINDOW_TICKS + MARCH_DWELL_TICKS + 20)).toEqual([]);
    breach(w);
    expect(run(s, w, 50)).toEqual([]);
  });

  it('a reading that warned of the wave first: no fallback when the invasion launches', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62); // gathering by the door
    expect(run(s, w, GATHER_DWELL_TICKS + 1)).toHaveLength(1);
    noteArmyWarningEvent(s, start(w, { x: 25, y: 64 }), P);
    expect(s.invasionUnwarned).toBe(false);
    expect(run(s, w, 50)).toEqual([]);
  });

  it('a reading due on the launch frame warns instead (one warning, the reading’s)', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    army(w, GATHER_MIN_FIGHTERS, 36, 62);
    expect(run(s, w, GATHER_DWELL_TICKS)).toEqual([]);
    noteArmyWarningEvent(s, start(w, { x: 25, y: 64 }), P);
    expect(run(s, w, 50)).toEqual([`An enemy army is gathering near your entrance. ${HINT}`]);
    expect(s.invasionUnwarned).toBe(false); // nothing left due: the wave is warned of
  });

  it('only an invasion of the viewer by another colony counts', () => {
    const { world: w } = nearDoorWorld();
    const s = createArmyWarningState();
    noteArmyWarningEvent(s, start(w, NEAR, E, E), P); // at another colony
    noteArmyWarningEvent(s, start(w, NEAR, P, P), P); // by the viewer itself
    expect(s.invasionAttacker).toBe(-1);
    expect(run(s, w, 5)).toEqual([]);
  });

  it('while its invasion runs the wave does not end: no re-arming, so no second warning', () => {
    const { world: w, host } = nearDoorWorld();
    const s = createArmyWarningState();
    noteArmyWarningEvent(s, start(w, NEAR), P);
    expect(run(s, w, 1)).toEqual([EAST]);
    // Its army stands at home, unseen (quiet to the readings), for a long while...
    expect(run(s, w, GATHER_REARM_QUIET_TICKS * 3)).toEqual([]);
    expect(s.armed).toBe(false);
    // ...then the fight drifts out by the door and lingers: still that wave.
    for (const id of host) place(w, id, 84, 62);
    expect(run(s, w, GATHER_DWELL_TICKS * 3)).toEqual([]);
    // Over: things go quiet, it re-arms, and the next invasion is warned of.
    kill(w, host);
    noteArmyWarningEvent(s, end(w), P);
    run(s, w, GATHER_REARM_QUIET_TICKS + 1);
    expect(s.armed).toBe(true);
    noteArmyWarningEvent(s, start(w, NEAR), P);
    expect(run(s, w, 1)).toEqual([EAST]);
  });

  it('an invasion with no end in sight stops holding the wave after INVASION_WATCH_TICKS', () => {
    const { world: w } = nearDoorWorld();
    const s = createArmyWarningState();
    noteArmyWarningEvent(s, start(w, NEAR), P);
    run(s, w, INVASION_WATCH_TICKS);
    expect(s.armed).toBe(false);
    run(s, w, GATHER_REARM_QUIET_TICKS + 2);
    expect(s.armed).toBe(true);
    expect(s.invasionAttacker).toBe(-1);
  });

  it('launched while disarmed (an earlier wave not yet over): noted, but no fallback', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    s.armed = false;
    noteArmyWarningEvent(s, start(w, { x: 25, y: 64 }), P);
    expect([s.invasionAttacker, s.invasionUnwarned]).toEqual([E, false]);
    expect(run(s, w, 50)).toEqual([]);
  });

  it('its invasion_end forgets it; another attacker’s does not', () => {
    const { world: w } = raidWorld();
    const s = createArmyWarningState();
    s.armed = false;
    noteArmyWarningEvent(s, start(w, { x: 25, y: 64 }), P);
    noteArmyWarningEvent(s, end(w, 7 as typeof E), P);
    expect(s.invasionAttacker).toBe(E);
    noteArmyWarningEvent(s, end(w), P);
    expect(s.invasionAttacker).toBe(-1);
  });

  it('an owed fallback is offered until taken; stale once its invasion ends, or after the window', () => {
    const owe = () => {
      const r = nearDoorWorld();
      const s = createArmyWarningState();
      noteArmyWarningEvent(s, start(r.world, NEAR), P);
      return { w: r.world, s };
    };
    const a = owe();
    expect(run(a.s, a.w, 3, false)).toEqual([EAST, EAST, EAST]);
    noteArmyWarningEvent(a.s, end(a.w), P);
    expect(run(a.s, a.w, 3, false)).toEqual([]);
    const b = owe();
    expect(run(b.s, b.w, GATHER_CAPTION_OWED_TICKS + 1, false)).toHaveLength(
      GATHER_CAPTION_OWED_TICKS + 1,
    );
    expect(run(b.s, b.w, 1, false)).toEqual([]);
    // Dropped unshown, it is not owed again that wave.
    breach(b.w);
    expect(run(b.s, b.w, 50)).toEqual([]);
  });

  it('names the viewer’s open entrance nearest the rally tile, and points to no minimap ring', () => {
    const { world: w, player } = raidWorld();
    addEntrance(w, player, 24, 30);
    const s = createArmyWarningState();
    noteArmyWarningEvent(s, start(w, { x: 25, y: 31 }), P);
    expect(run(s, w, 1)).toEqual([`An enemy army is marching on your north entrance. ${HINT}`]);
    // Three doors, two sharing a name: no name, and no "ringed on the minimap"
    // (as it sets out the army may read as at home, with no ring).
    const r = raidWorld();
    const a = addEntrance(r.world, r.player, 90, 64);
    addEntrance(r.world, r.player, 96, 64);
    expect(entranceDirectionName(r.player, a)).toBeNull();
    const unnamed = `An enemy army is marching on one of your entrances. ${HINT}`;
    expect(invasionWarningText(r.player, a)).toBe(unnamed);
    expect(marchWarningText(r.player, a)).toContain('ringed on the minimap');
    const s3 = createArmyWarningState();
    noteArmyWarningEvent(s3, start(r.world, { x: 91, y: 64 }), P);
    expect(run(s3, r.world, 1)).toEqual([unnamed]);
  });

  it('CLNY-08: the enemy as viewer is warned of the player’s invasion of its door', () => {
    const r = raidWorld();
    addEntrance(r.world, r.enemy, 32, 64); // the enemy's door 8 tiles from the player's
    const s = createArmyWarningState();
    noteArmyWarningEvent(s, start(r.world, { x: 32, y: 64 }, P, E), E);
    expect(nextArmyWarning(s, r.world, E)).toBe(
      `An enemy army is marching on your west entrance. ${HINT}`,
    );
  });

  it('reset forgets a launched invasion', () => {
    const { world: w } = nearDoorWorld();
    const s = createArmyWarningState();
    noteArmyWarningEvent(s, start(w, NEAR), P);
    resetArmyWarningState(s);
    expect([s.invasionAttacker, s.invasionUnwarned]).toEqual([-1, false]);
    expect(run(s, w, 5)).toEqual([]);
  });
});
