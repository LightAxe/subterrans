// enemy-march.test.ts — #394: the march geometry (which fighters count, heading,
// home radius, entrance aim), the position history it needs, and CLNY-08.

import { describe, it, expect } from 'vitest';
import {
  MARCH_AIM_TIE_TILES,
  MARCH_CHASE_HOME_RADIUS_TILES,
  MARCH_CHASE_TILES,
  MARCH_HOME_RADIUS_TILES,
  MARCH_LEG_MIN_HEADING,
  MARCH_MAX_LOOKBACK_TICKS,
  MARCH_MIN_FIGHTERS,
  MARCH_MIN_HEADING,
  MARCH_MIN_STEP_TILES,
  MARCH_SAMPLE_TICKS,
  MARCH_WINDOW_TICKS,
  armyWarningLogEntry,
  createMarchHistory,
  isEnemyMarching,
  measureEnemyMarch,
  measureEnemyMarchThisTick,
  observeMarchHistory,
  resetMarchHistory,
  type MarchHistory,
} from './enemy-march.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { allocateEntityId, type WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask } from '../sim/enums.js';
import { FP_ONE } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';
import { addFighter, raidWorld } from '../sim/raid-test-utils.js';
import { AI_DEFENCE_HOLD_RADIUS_TILES } from './ai-controller.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;

// raidWorld (seed 7): player door (24, 64), enemy door (104, 64); no spider,
// no AI state, no starting workers. The enemy fighters below start at x 60..73,
// well beyond MARCH_HOME_RADIUS_TILES of their own door.
const DOOR = { x: 24, y: 64 };

function advance(w: WorldState, n: number): void {
  // eslint-disable-next-line no-restricted-syntax -- test fixture clock, not a render write
  w.tick += n;
}

/** Ant `id`'s position in fractional tiles. */
function pos(w: WorldState, id: number): [number, number] {
  return [w.ants.posX[id]! / FP_ONE, w.ants.posY[id]! / FP_ONE];
}

/** Place an ant at fractional tile (x, y). */
function place(w: WorldState, id: number, x: number, y: number): void {
  w.ants.posX[id] = Math.round(x * FP_ONE);
  w.ants.posY[id] = Math.round(y * FP_ONE);
}

/** `n` fighters of `colonyId` on the surface around (x, y), a 4-wide block. */
function army(w: WorldState, n: number, x: number, y: number, colonyId = E): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++)
    ids.push(addFighter(w, colonyId, x + (i % 4), y + ((i / 4) | 0), null));
  return ids;
}

function addEntrance(w: WorldState, c: ColonyRecord, x: number, y: number): NestEntrance {
  const e: NestEntrance = {
    entranceId: allocateEntityId(w),
    surfaceTileX: x,
    surfaceTileY: y,
    isOpen: true,
  };
  c.entrances.push(e);
  return e;
}

/**
 * The history sees `w` now, then MARCH_WINDOW_TICKS ticks pass (one frame a
 * tick) with nobody moving, then every ant in `ids` moves (dx, dy) tiles and the
 * history sees that frame too: their heading is exactly (dx, dy), measured
 * against the sample from MARCH_WINDOW_TICKS ago.
 */
function stride(w: WorldState, h: MarchHistory, ids: readonly number[], dx: number, dy: number) {
  for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
    observeMarchHistory(h, w);
    advance(w, 1);
  }
  for (const id of ids) {
    const [x, y] = pos(w, id);
    place(w, id, x + dx, y + dy);
  }
  observeMarchHistory(h, w);
}

/** A fresh world and history, the history having seen it once. */
function setup() {
  const r = raidWorld();
  const h = createMarchHistory();
  return { ...r, h };
}

describe('measureEnemyMarch — which fighters march', () => {
  it('an army walking straight at the door marches on it, with its bounding box', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    stride(w, h, ids, -10, 0);
    const m = measureEnemyMarch(w, P, h);
    expect(m).not.toBeNull();
    expect(m!.fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(m!.entrance.surfaceTileX).toBe(DOOR.x);
    // x 60..63 → 50.5..53.5 after the stride; rows 63..64 (tile centres).
    expect([m!.minTileX, m!.maxTileX, m!.minTileY, m!.maxTileY]).toEqual([50.5, 53.5, 63.5, 64.5]);
    expect(isEnemyMarching(m)).toBe(true);
  });

  it('isEnemyMarching: MARCH_MIN_FIGHTERS make an army, one fewer (or none) does not', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS - 1, 60, 63);
    stride(w, h, ids, -10, 0);
    expect(measureEnemyMarch(w, P, h)!.fighters).toBe(MARCH_MIN_FIGHTERS - 1);
    expect(isEnemyMarching(measureEnemyMarch(w, P, h))).toBe(false);
    expect(isEnemyMarching(null)).toBe(false);
  });

  it('no heading without a sample MARCH_WINDOW_TICKS old', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    observeMarchHistory(h, w);
    advance(w, MARCH_WINDOW_TICKS - 1);
    for (const id of ids) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    observeMarchHistory(h, w);
    expect(measureEnemyMarch(w, P, h)).toBeNull();
    advance(w, 1);
    observeMarchHistory(h, w);
    expect(measureEnemyMarch(w, P, h)!.fighters).toBe(MARCH_MIN_FIGHTERS);
  });

  it('a fighter that has stopped or turned back since the last sample is not marching', () => {
    // It walks west at the door at 0.5 tile a tick for 30 ticks, then does
    // `then` for 10 ticks (the history seeing every tick). Its heading over the
    // window still points west at the door, 5+ tiles; what it did since the
    // newest sample at least MARCH_SAMPLE_TICKS old decides.
    const run = (thenDx: number, first = 30, then = 10) => {
      const { world: w, h } = setup();
      const id = addFighter(w, E, 70, 64, null);
      const walk = (dx: number, ticks: number) => {
        for (let t = 0; t < ticks; t++) {
          observeMarchHistory(h, w);
          advance(w, 1);
          const [x, y] = pos(w, id);
          place(w, id, x + dx, y);
        }
      };
      walk(-0.5, first);
      walk(thenDx, then);
      observeMarchHistory(h, w);
      return measureEnemyMarch(w, P, h);
    };
    expect(run(-0.5)?.fighters).toBe(1); // still marching
    expect(run(0)).toBeNull(); // stopped (a sally giving up the chase)
    expect(run(0.5)).toBeNull(); // turned back (and its window heading is gone too)
    // Turned back just since the last sample: still 5 tiles west of where it was a
    // window ago (a heading at the door), but 2.5 tiles back east since then.
    expect(run(0.5, 35, 5)).toBeNull();
    // Slowed: at least the window's pace (MARCH_MIN_STEP_TILES a window) still marches.
    const pace = MARCH_MIN_STEP_TILES / MARCH_WINDOW_TICKS;
    expect(run(-(pace + 0.01))?.fighters).toBe(1);
    expect(run(-(pace - 0.01))).toBeNull();
  });

  it('a fighter that has turned off the door since the last sample is not marching (#404 review)', () => {
    // West at the door at 0.5 tile a tick for 35 ticks, then `deg` off west (to the
    // north) for the last `leg` ticks — its whole latest leg, since the newest
    // sample at least MARCH_SAMPLE_TICKS old. Over the window its heading still
    // points at the door, and it is still making ground along it: the leg decides.
    const run = (deg: number, leg: number) => {
      const { world: w, h } = setup();
      const id = addFighter(w, E, 70, 64, null);
      const walk = (dx: number, dy: number, ticks: number) => {
        for (let t = 0; t < ticks; t++) {
          observeMarchHistory(h, w);
          advance(w, 1);
          const [x, y] = pos(w, id);
          place(w, id, x + dx, y + dy);
        }
      };
      walk(-0.5, 0, 35);
      const r = (deg * Math.PI) / 180;
      walk(-0.5 * Math.cos(r), -0.5 * Math.sin(r), leg);
      observeMarchHistory(h, w);
      return measureEnemyMarch(w, P, h);
    };
    for (let leg = MARCH_SAMPLE_TICKS; leg < 2 * MARCH_SAMPLE_TICKS; leg++) {
      expect(run(0, leg)?.fighters).toBe(1);
      expect(run(30, leg)?.fighters).toBe(1); // a bend that still aims at the door
      // A diagonal step round a rock: off the door's row, it reads about 46-52°
      // off the line to the door — within MARCH_LEG_MIN_HEADING, still marching.
      expect(run(45, leg)?.fighters).toBe(1);
      expect(run(60, leg)).toBeNull(); // turned off it, at every sample phase
      expect(run(90, leg)).toBeNull();
    }
    expect(MARCH_LEG_MIN_HEADING).toBe(0.5);
  });

  it('standing or milling is not marching: under MARCH_MIN_STEP_TILES moved', () => {
    const a = setup();
    const ida = army(a.world, 1, 60, 64);
    stride(a.world, a.h, ida, -(MARCH_MIN_STEP_TILES - 0.05), 0);
    expect(measureEnemyMarch(a.world, P, a.h)).toBeNull();
    const b = setup();
    const idb = army(b.world, 1, 60, 64);
    stride(b.world, b.h, idb, -MARCH_MIN_STEP_TILES, 0);
    expect(measureEnemyMarch(b.world, P, b.h)!.fighters).toBe(1);
  });

  it('heading: within MARCH_MIN_HEADING of the line to the door, not beyond', () => {
    // MARCH_MIN_HEADING is the cosine; step 5 tiles at an angle just inside and
    // just outside it, from a point due east of the door.
    const step = (cos: number): [number, number] => [-5 * cos, 5 * Math.sqrt(1 - cos * cos)];
    const run = (cos: number) => {
      const { world: w, h } = setup();
      const [dx, dy] = step(cos);
      // Start so that the fighter ends due east of the door (heading measured there).
      const id = addFighter(w, E, 60, 64, null);
      place(w, id, 60.5 - dx, 64.5 - dy);
      stride(w, h, [id], dx, dy);
      return measureEnemyMarch(w, P, h);
    };
    expect(run(MARCH_MIN_HEADING + 0.02)?.fighters).toBe(1);
    expect(run(MARCH_MIN_HEADING - 0.02)).toBeNull();
    // Walking straight past (north) or away (east) is not marching.
    expect(run(0)).toBeNull();
    expect(run(-1)).toBeNull();
  });

  it('a fighter within a tile of the door counts whatever its last step', () => {
    // It walks due south and ends 0.7 tiles east of the door centre: its heading
    // is square to the line to the door (cosine 0), yet it is at the door.
    const run = (offset: number) => {
      const { world: w, h } = setup();
      const id = addFighter(w, E, 30, 64, null);
      place(w, id, DOOR.x + 0.5 + offset, DOOR.y + 0.5 - 4);
      stride(w, h, [id], 0, 4);
      return measureEnemyMarch(w, P, h);
    };
    expect(run(0.7)!.fighters).toBe(1);
    // 1.2 tiles off, walking past it: not at the door, not heading for it.
    expect(run(1.2)).toBeNull();
  });

  it('skips the viewer’s own fighters, dead ones, underground ones and non-fighters', () => {
    const { world: w, h } = setup();
    const own = army(w, 2, 60, 60, P);
    const dead = army(w, 2, 60, 62);
    const worker = addFighter(w, E, 60, 66, null);
    w.ants.task[worker] = AntTask.Foraging;
    // In the player's tunnels: never on the surface.
    const below = addFighter(w, E, 60, 5, P);
    // On the surface all window, gone below (down an entrance) now.
    const diver = addFighter(w, E, 60, 58, null);
    stride(w, h, [...own, ...dead, worker, below, diver], -10, 0);
    for (const id of dead) w.ants.alive[id] = 0;
    w.ants.zone[diver] = Zone.Underground;
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('a fighter that was not on the surface in the heading sample has no heading yet', () => {
    const { world: w, h } = setup();
    const id = addFighter(w, E, 60, 5, P); // below ground in the sample
    stride(w, h, [], 0, 0);
    // It comes up and is seen 10 tiles on: no earlier surface position.
    w.ants.zone[id] = Zone.Surface;
    place(w, id, 50.5, 64.5);
    observeMarchHistory(h, w);
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('a fighter within MARCH_HOME_RADIUS_TILES of its own open entrance is at home', () => {
    const run = (dist: number, open = true) => {
      const { world: w, h, enemy } = setup();
      const home = enemy.entrances.find((e) => e.isOpen)!;
      home.isOpen = open;
      const id = addFighter(w, E, 60, 64, null);
      // Ends `dist` tiles west of its own door centre, having walked 5 tiles west.
      place(w, id, home.surfaceTileX + 0.5 - dist + 5, home.surfaceTileY + 0.5);
      stride(w, h, [id], -5, 0);
      return measureEnemyMarch(w, P, h);
    };
    expect(run(MARCH_HOME_RADIUS_TILES)).toBeNull();
    expect(run(MARCH_HOME_RADIUS_TILES + 0.05)?.fighters).toBe(1);
    // A closed entrance is not home.
    expect(run(MARCH_HOME_RADIUS_TILES - 5, false)?.fighters).toBe(1);
  });

  it('a counter-attack about 23 tiles out from its own door is not a march (measured, #394)', () => {
    // On real AI matches a colony chasing raiders home sent its whole army up to
    // about 23 tiles out toward their nest before turning back.
    const { world: w, h, enemy } = setup();
    const home = enemy.entrances.find((e) => e.isOpen)!;
    const ids: number[] = [];
    for (let i = 0; i < MARCH_MIN_FIGHTERS; i++) {
      const id = addFighter(w, E, 90, 64, null);
      // Ends 22.5 tiles west of its door centre (rows ±0.5), having walked 10 west.
      place(w, id, home.surfaceTileX + 0.5 - 22.5 + 10, home.surfaceTileY + (i % 2));
      ids.push(id);
    }
    stride(w, h, ids, -10, 0);
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('heading for another colony’s door that lies nearer ahead (home) is not marching on the viewer', () => {
    // The player has a door far east, beyond the enemy's; an enemy army walking
    // home (east) points at both, but reaches its own first.
    const { world: w, h, player } = setup();
    addEntrance(w, player, 120, 64);
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    stride(w, h, ids, 10, 0); // to x 70..73: 31+ tiles short of home
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('another of its own doors ahead beyond home radius, nearer than the viewer’s: not marching', () => {
    // A forward enemy door at x 50, 28 tiles ahead of an army walking west from
    // x 78 (26 tiles out from the x-104 door): it is going there, not to x 24.
    const { world: w, h, enemy } = setup();
    addEntrance(w, enemy, 50, 64);
    const ids: number[] = [];
    for (let i = 0; i < MARCH_MIN_FIGHTERS; i++) ids.push(addFighter(w, E, 88, 64, null));
    stride(w, h, ids, -10, 0); // to x 78.5
    expect(measureEnemyMarch(w, P, h)).toBeNull();
    // With that door closed it marches on the viewer's.
    enemy.entrances.at(-1)!.isOpen = false;
    expect(measureEnemyMarch(w, P, h)!.fighters).toBe(MARCH_MIN_FIGHTERS);
  });

  it('another colony’s door ahead but beyond the viewer’s: still marching on the viewer', () => {
    const { world: w, h, enemy } = setup();
    addEntrance(w, enemy, 4, 64); // west of the player's x-24 door, on the same line
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    stride(w, h, ids, -10, 0);
    expect(measureEnemyMarch(w, P, h)!.fighters).toBe(MARCH_MIN_FIGHTERS);
  });

  it('chasing one of the viewer’s fighters running the same way, close in front, is not marching', () => {
    // Six enemy fighters walk west at the door, 10 tiles over the window, ending
    // 31-34 tiles out from their own door (x 70.5..73.5). One player fighter
    // moves (dx, dy) over the same window and ends `gap` tiles in front of the
    // block's lead fighter (or behind its tail). `after` changes it once the
    // history has seen it running.
    type Opts = {
      run?: [number, number];
      armyX?: number;
      colony?: number;
      after?: (w: WorldState, own: number) => void;
    };
    const run = (gap: number, opts: Opts = {}) => {
      const { world: w, h } = setup();
      const x0 = opts.armyX ?? 80;
      const ids = army(w, MARCH_MIN_FIGHTERS, x0, 64);
      const own = addFighter(w, opts.colony ?? P, 40, 64, null);
      const [dx, dy] = opts.run ?? [-10, 0]; // default: running west with them
      const lead = x0 - 10 + 0.5;
      // Ends in front of the lead when gap > 0; behind the tail when < 0.
      place(w, own, (gap > 0 ? lead - gap : lead + 3 - gap) - dx, 65 - dy);
      for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
        observeMarchHistory(h, w);
        advance(w, 1);
      }
      for (const id of ids) {
        const [x, y] = pos(w, id);
        place(w, id, x - 10, y);
      }
      const [ox, oy] = pos(w, own);
      place(w, own, ox + dx, oy + dy);
      opts.after?.(w, own);
      observeMarchHistory(h, w);
      return measureEnemyMarch(w, P, h)!;
    };
    // Measured: a sally ran 3-7 tiles behind the raiders it chased (#394).
    expect(MARCH_CHASE_TILES).toBe(10);
    // 3 tiles in front of the lead, running west too: every one of them (the
    // tail is 6 tiles off, well inside) is chasing — no army, but still reported.
    const close = run(3);
    expect(close.fighters).toBe(0);
    expect(close.chasing).toBe(MARCH_MIN_FIGHTERS);
    expect(isEnemyMarching(close)).toBe(false);
    // The boundary is MARCH_CHASE_TILES from each fighter: from the lead in, from
    // the tail (3 tiles further back) out.
    const edge = run(MARCH_CHASE_TILES - 3);
    expect(edge.chasing).toBeGreaterThan(0);
    expect(edge.fighters).toBeGreaterThan(0);
    expect(run(MARCH_CHASE_TILES + 0.05).chasing).toBe(0);
    // Behind them it is not being chased.
    expect(run(-3).fighters).toBe(MARCH_MIN_FIGHTERS);
    // Further from their home than MARCH_CHASE_HOME_RADIUS_TILES (51-54 tiles
    // out), they are following it home: marching.
    expect(run(3, { armyX: 60 })).toMatchObject({ fighters: MARCH_MIN_FIGHTERS, chasing: 0 });
    // Coming the other way (an army out to meet them), standing (defenders),
    // too slow to be running (under MARCH_MIN_STEP_TILES), or crossing their path:
    // not a chase — they are marching.
    expect(run(3, { run: [10, 0] }).fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(run(3, { run: [0, 0] }).fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(run(3, { run: [-(MARCH_MIN_STEP_TILES - 0.1), 0] }).fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(run(3, { run: [0, -10] }).fighters).toBe(MARCH_MIN_FIGHTERS);
    // Running within MARCH_MIN_HEADING of their heading is still a chase; beyond, not.
    const at = (cos: number): [number, number] => [-10 * cos, -10 * Math.sqrt(1 - cos * cos)];
    expect(run(3, { run: at(MARCH_MIN_HEADING + 0.02) }).fighters).toBe(0);
    expect(run(3, { run: at(MARCH_MIN_HEADING - 0.02) }).fighters).toBe(MARCH_MIN_FIGHTERS);
    // Only the viewer's own fighters on the surface, now: one that has just gone
    // below or stopped fighting is no quarry.
    const below = run(3, { after: (w, own) => void (w.ants.zone[own] = Zone.Underground) });
    expect(below.fighters).toBe(MARCH_MIN_FIGHTERS);
    const forager = run(3, { after: (w, own) => void (w.ants.task[own] = AntTask.Foraging) });
    expect(forager.fighters).toBe(MARCH_MIN_FIGHTERS);
    // Another colony's fighter in front is no quarry of theirs to chase (it marches
    // with them: seven, none chasing).
    expect(run(3, { colony: E })).toMatchObject({ fighters: MARCH_MIN_FIGHTERS + 1, chasing: 0 });
    const other = run(3, { after: (w, own) => void (w.ants.colonyId[own] = 7) });
    expect(other).toMatchObject({ fighters: MARCH_MIN_FIGHTERS + 1, chasing: 0 });
  });

  it('a runner that has stopped or turned is no longer being chased: those behind it march (#404 review)', () => {
    // Six enemy fighters walk west at the door, half a tile a tick, ending 30-37
    // tiles from their own door (inside MARCH_CHASE_HOME_RADIUS_TILES, however
    // long it runs). One player fighter runs ahead of them at their pace, 6 tiles
    // in front of the lead; for the last `late` ticks it instead moves `turn` a
    // tick (stops, by default), staying in front of them.
    const go = (
      late: number,
      turn: [number, number] = [0, 0],
      total = MARCH_WINDOW_TICKS + 2 * MARCH_SAMPLE_TICKS,
    ) => {
      const { world: w, h } = setup();
      const ids = army(w, MARCH_MIN_FIGHTERS, 84, 64);
      const own = addFighter(w, P, 78, 65, null);
      for (let t = 0; t < total; t++) {
        observeMarchHistory(h, w);
        for (const id of ids) {
          const [x, y] = pos(w, id);
          place(w, id, x - 0.5, y);
        }
        const [x, y] = pos(w, own);
        if (t < total - late) place(w, own, x - 0.5, y);
        else place(w, own, x + turn[0], y + turn[1]);
        advance(w, 1);
      }
      observeMarchHistory(h, w);
      return measureEnemyMarch(w, P, h)!;
    };
    const running = go(0);
    expect([running.fighters, running.chasing]).toEqual([0, MARCH_MIN_FIGHTERS]);
    // Stopped two sample intervals ago: over the window it still ran 5 tiles west,
    // but it is not running now — the army behind it marches.
    const stopped = go(2 * MARCH_SAMPLE_TICKS);
    expect([stopped.fighters, stopped.chasing]).toEqual([MARCH_MIN_FIGHTERS, 0]);
    expect(isEnemyMarching(stopped)).toBe(true);
    // Turned back north-east for the last 6 ticks: its heading over the window is
    // still west-north-west (their way), but it is not running that way now.
    const turned = go(6, [0.35, -0.35]);
    expect([turned.fighters, turned.chasing]).toEqual([MARCH_MIN_FIGHTERS, 0]);
    // Turned 60° (north-west) for its whole latest leg, at every sample phase: its
    // window heading is still theirs, and it is still making ground along it, but
    // it runs its new way now — they are not chasing it.
    const r60 = Math.PI / 3;
    const v60: [number, number] = [-0.5 * Math.cos(r60), -0.5 * Math.sin(r60)];
    for (let leg = MARCH_SAMPLE_TICKS; leg < 2 * MARCH_SAMPLE_TICKS; leg++) {
      const veered = go(leg, v60, MARCH_WINDOW_TICKS + MARCH_SAMPLE_TICKS + leg);
      expect([veered.fighters, veered.chasing]).toEqual([MARCH_MIN_FIGHTERS, 0]);
    }
    // Crawling on below the window's pace (0.05 tile a tick): not running.
    const crawling = go(2 * MARCH_SAMPLE_TICKS, [-0.05, 0]);
    expect([crawling.fighters, crawling.chasing]).toEqual([MARCH_MIN_FIGHTERS, 0]);
    // A 45° bend in its path (a diagonal step round a rock, the whole latest leg)
    // is still their way: it still leads them, at every sample phase.
    const r45 = Math.PI / 4;
    const v45: [number, number] = [-0.5 * Math.cos(r45), -0.5 * Math.sin(r45)];
    for (let leg = MARCH_SAMPLE_TICKS; leg < 2 * MARCH_SAMPLE_TICKS; leg++) {
      const bent = go(leg, v45, MARCH_WINDOW_TICKS + MARCH_SAMPLE_TICKS + leg);
      expect([bent.fighters, bent.chasing]).toEqual([0, MARCH_MIN_FIGHTERS]);
    }
  });

  it('a chase spares only a fighter within MARCH_CHASE_HOME_RADIUS_TILES of its own door', () => {
    // The AI's sally holds raiders within AI_DEFENCE_HOLD_RADIUS_TILES (Manhattan)
    // of its door; the chase radius must reach past it.
    expect(MARCH_CHASE_HOME_RADIUS_TILES).toBe(40);
    expect(MARCH_CHASE_HOME_RADIUS_TILES).toBeGreaterThan(AI_DEFENCE_HOLD_RADIUS_TILES);
    // One enemy fighter ends `dist` tiles due west of its door centre (104.5,
    // 64.5) with a player fighter running 3 tiles in front of it.
    const run = (dist: number) => {
      const { world: w, h } = setup();
      const id = addFighter(w, E, 60, 64, null);
      const own = addFighter(w, P, 40, 64, null);
      place(w, id, 104.5 - dist + 10, 64.5);
      place(w, own, 104.5 - dist - 3 + 10, 64.5);
      stride(w, h, [id, own], -10, 0);
      return measureEnemyMarch(w, P, h)!;
    };
    expect(run(MARCH_CHASE_HOME_RADIUS_TILES)).toMatchObject({ fighters: 0, chasing: 1 });
    expect(run(MARCH_CHASE_HOME_RADIUS_TILES + 0.05)).toMatchObject({ fighters: 1, chasing: 0 });
  });

  it('null with no open viewer entrance, no such viewer, or a history of another world', () => {
    const { world: w, h, player } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    stride(w, h, ids, -10, 0);
    expect(measureEnemyMarch(w, 99, h)).toBeNull();
    // Another world whose fighters (same ids) stand 10 tiles west of where this
    // history last saw them: no march read off a history it was not taken from.
    const other = raidWorld().world;
    expect(army(other, MARCH_MIN_FIGHTERS, 50, 63)).toEqual(ids);
    advance(other, w.tick - other.tick);
    expect(measureEnemyMarch(other, P, h)).toBeNull();
    for (const e of player.entrances) e.isOpen = false;
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('CLNY-08: the enemy as viewer sees the player’s army marching on its door; a third colony counts', () => {
    const { world: w, h } = setup();
    const mine = army(w, MARCH_MIN_FIGHTERS, 50, 63, P);
    // Well clear of the player's army's path (not a fighter it is chasing).
    const theirs = army(w, MARCH_MIN_FIGHTERS, 60, 40, E);
    stride(w, h, mine, 10, 0);
    // The enemy's own army walked nowhere; the player's walked east at 104.
    const m = measureEnemyMarch(w, E, h)!;
    expect(m.entrance.surfaceTileX).toBe(104);
    expect(m.fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(measureEnemyMarch(w, P, h)).toBeNull(); // own fighters never count
    // A third colony (any id but the viewer's) marching on the player.
    for (const id of theirs) w.ants.colonyId[id] = 7;
    stride(w, h, theirs, -8, 6);
    expect(measureEnemyMarch(w, P, h)!.fighters).toBe(MARCH_MIN_FIGHTERS);
  });
});

describe('measureEnemyMarch — which entrance', () => {
  it('an army heading between two doors counts once, not once per door', () => {
    const { world: w, h, player } = setup();
    addEntrance(w, player, 24, 58);
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 60);
    stride(w, h, ids, -10, 0);
    expect(measureEnemyMarch(w, P, h)!.fighters).toBe(MARCH_MIN_FIGHTERS);
  });

  it('the door the heading points at, not the nearer one beside it', () => {
    const { world: w, h, player } = setup();
    // A second door 20 tiles north of the first; the army heads at it from the
    // south-east, passing nearer the first door's side.
    const north = addEntrance(w, player, 24, 44);
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 70);
    // Heading at (24.5, 44.5) from about (60.5, 70.5): (-36, -26) → step (-6, -4.33).
    stride(w, h, ids, -6, -4.33);
    expect(measureEnemyMarch(w, P, h)!.entrance).toBe(north);
  });

  it('two doors in line with the heading: the nearer one, which the army reaches first', () => {
    const { world: w, h, player } = setup();
    const west = addEntrance(w, player, 8, 64);
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 64);
    stride(w, h, ids, -10, 0);
    const m = measureEnemyMarch(w, P, h)!;
    expect(m.entrance.surfaceTileX).toBe(DOOR.x);
    expect(m.entrance).not.toBe(west);
  });

  it('aims within MARCH_AIM_TIE_TILES are a tie, won by the nearer door ahead; beyond it, the better aim', () => {
    // A fighter walks due west along row `row` + 0.5. The far door (x 4) lies on
    // that line; the x-24 door's centre (row 64.5) is 64 - row tiles off it.
    const run = (row: number) => {
      const { world: w, h, player } = setup();
      const far = addEntrance(w, player, 4, row);
      const id = addFighter(w, E, 60, row, null);
      stride(w, h, [id], -10, 0);
      return { m: measureEnemyMarch(w, P, h)!, far };
    };
    const tie = run(64 - (MARCH_AIM_TIE_TILES - 1));
    expect(tie.m.entrance.surfaceTileX).toBe(DOOR.x);
    const clear = run(64 - (MARCH_AIM_TIE_TILES + 2));
    expect(clear.m.entrance).toBe(clear.far);
  });

  it('the tie is with the best aim, not chained door to door (order-independent)', () => {
    // Walking due west along row 60.5, ending at x 50.5. Aims: the x-24 door
    // (row 64.5) misses by 4; `a` (row 60.5, far) by 0; `b` (row 61.5) by 1,
    // nearer ahead; `c` (row 63.5) by 3, nearer still. Within MARCH_AIM_TIE_TILES
    // of the best aim (0) are `a` and `b`: `b`, the nearer, wins — not `c`, which
    // is only within the tie of `b`.
    expect(MARCH_AIM_TIE_TILES).toBe(2);
    const { world: w, h, player } = setup();
    const a = addEntrance(w, player, 4, 60);
    const b = addEntrance(w, player, 30, 61);
    const c = addEntrance(w, player, 40, 63);
    const id = addFighter(w, E, 60, 60, null);
    stride(w, h, [id], -10, 0);
    expect(measureEnemyMarch(w, P, h)!.entrance).toBe(b);
    // Listed the other way round, the same.
    player.entrances.reverse();
    expect(measureEnemyMarch(w, P, h)!.entrance).toBe(b);
    expect([a, c]).not.toContain(measureEnemyMarch(w, P, h)!.entrance);
  });

  it('the bounding box is of the fighters aiming at the entrance named, not of every marcher', () => {
    // Four walk due west at the row-64 door, two at a row-30 door: the box is the
    // four's, not one spanning both groups.
    const { world: w, h, player } = setup();
    addEntrance(w, player, 24, 30);
    const south = army(w, 4, 60, 64);
    const north: number[] = [];
    for (let i = 0; i < 2; i++) north.push(addFighter(w, E, 60 + i, 30, null));
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      observeMarchHistory(h, w);
      advance(w, 1);
    }
    for (const id of [...south, ...north]) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    observeMarchHistory(h, w);
    const m = measureEnemyMarch(w, P, h)!;
    expect(m.fighters).toBe(6);
    expect(m.entrance.surfaceTileY).toBe(DOOR.y);
    expect([m.minTileX, m.maxTileX, m.minTileY, m.maxTileY]).toEqual([50.5, 53.5, 64.5, 64.5]);
  });

  it('the entrance and box are the army’s, not a bigger chasing sally’s', () => {
    // Six march (51+ tiles from their home) due west at the row-64 door; seven
    // more, 28 tiles out from home, chase the player's runners toward a row-30
    // door. The seven are chasers: the six's door and box win.
    const { world: w, h, player } = setup();
    const top = addEntrance(w, player, 24, 30);
    const marchers = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    const chasers = army(w, MARCH_MIN_FIGHTERS + 1, 80, 50);
    const [ux, uy] = [24.5 - 81.5, 30.5 - 50.5];
    const len = Math.hypot(ux, uy);
    const runners = [0, 1].map(() => addFighter(w, P, 40, 40, null));
    runners.forEach((id, i) => place(w, id, 81.5 + (5 * ux) / len, 50.5 + i + (5 * uy) / len));
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      observeMarchHistory(h, w);
      advance(w, 1);
    }
    for (const id of marchers) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    for (const id of [...chasers, ...runners]) {
      const [x, y] = pos(w, id);
      place(w, id, x + (10 * ux) / len, y + (10 * uy) / len);
    }
    observeMarchHistory(h, w);
    const m = measureEnemyMarch(w, P, h)!;
    expect(m.fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(m.chasing).toBe(MARCH_MIN_FIGHTERS + 1);
    expect(m.entrance).not.toBe(top);
    expect(m.entrance.surfaceTileY).toBe(DOOR.y);
    expect([m.minTileX, m.maxTileX, m.minTileY, m.maxTileY]).toEqual([50.5, 53.5, 63.5, 64.5]);
  });

  it('with no army, the entrance and box are the chasers’', () => {
    // The chase of `close` above, with a north door listed first that no one heads
    // for: the chasers aim at the row-64 door, and that is the one named.
    const { world: w, h, player } = setup();
    player.entrances.unshift({
      entranceId: allocateEntityId(w),
      surfaceTileX: 24,
      surfaceTileY: 10,
      isOpen: true,
    });
    const ids = army(w, MARCH_MIN_FIGHTERS, 80, 64);
    const own = addFighter(w, P, 40, 64, null);
    place(w, own, 77.5, 65);
    stride(w, h, [...ids, own], -10, 0);
    const m = measureEnemyMarch(w, P, h)!;
    expect(m).toMatchObject({ fighters: 0, chasing: MARCH_MIN_FIGHTERS });
    expect(m.entrance.surfaceTileY).toBe(DOOR.y);
    expect([m.minTileX, m.maxTileX, m.minTileY, m.maxTileY]).toEqual([70.5, 73.5, 64.5, 65.5]);
  });

  it('most fighters’ aim wins; equal aims go to the door its aimers are nearer on average', () => {
    // `west` fighters walk due west at the row-64 door; `north` fighters walk at
    // a row-30 door, ending `northX` tiles east.
    const run = (west: number, north: number, northX: number) => {
      const { world: w, h, player } = setup();
      const top = addEntrance(w, player, 24, 30);
      const a = army(w, west, 60, 64);
      const b = army(w, north, northX + 6, 46);
      for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
        observeMarchHistory(h, w);
        advance(w, 1);
      }
      for (const id of a) {
        const [x, y] = pos(w, id);
        place(w, id, x - 10, y);
      }
      for (const id of b) {
        const [x, y] = pos(w, id);
        const dx = 24.5 - x;
        const dy = 30.5 - y;
        const d = Math.hypot(dx, dy);
        place(w, id, x + (6 * dx) / d, y + (6 * dy) / d);
      }
      observeMarchHistory(h, w);
      return { m: measureEnemyMarch(w, P, h)!, top };
    };
    const most = run(4, 2, 40);
    expect(most.m.fighters).toBe(6);
    expect(most.m.entrance.surfaceTileY).toBe(DOOR.y);
    // 3 and 3: the row-64 aimers end about 26 tiles off their door; the row-30
    // aimers about 20 (x 36..39 from x 40) or about 44 (from x 64).
    const nearTop = run(3, 3, 36);
    expect(nearTop.m.fighters).toBe(6);
    expect(nearTop.m.entrance).toBe(nearTop.top);
    const farTop = run(3, 3, 60);
    expect(farTop.m.entrance.surfaceTileY).toBe(DOOR.y);
  });
});

describe('measureEnemyMarch — reused scratch buffers (#404 review)', () => {
  /** `h` with its own fresh scratch, sharing `h`'s samples. */
  const freshScratch = (h: MarchHistory): MarchHistory => ({
    ...h,
    scratch: createMarchHistory().scratch,
  });

  it('allocates its buffers once: the same arrays measurement after measurement', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    const { doors, own, army: tally, all } = h.scratch;
    const [aim, ox] = [tally.aim, own.x];
    stride(w, h, ids, -10, 0);
    measureEnemyMarch(w, P, h);
    advance(w, MARCH_SAMPLE_TICKS);
    observeMarchHistory(h, w);
    measureEnemyMarch(w, P, h);
    expect(h.scratch.doors).toBe(doors);
    expect(h.scratch.own).toBe(own);
    expect(h.scratch.army).toBe(tally);
    expect(h.scratch.all).toBe(all);
    expect(h.scratch.army.aim).toBe(aim);
    expect(h.scratch.own.x).toBe(ox);
  });

  it('a runner seen by one measurement is not left over for the next', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 80, 64);
    const own = addFighter(w, P, 40, 64, null);
    place(w, own, 70.5 - 3 + 10, 65); // ends 3 tiles in front of the lead
    stride(w, h, [...ids, own], -10, 0);
    expect(measureEnemyMarch(w, P, h)).toMatchObject({ fighters: 0, chasing: MARCH_MIN_FIGHTERS });
    // The quarry goes below: nobody is chased now.
    w.ants.zone[own] = Zone.Underground;
    const after = measureEnemyMarch(w, P, h);
    expect(after).toMatchObject({ fighters: MARCH_MIN_FIGHTERS, chasing: 0 });
    expect(after).toEqual(measureEnemyMarch(w, P, freshScratch(h)));
  });

  it('aims tallied by one measurement are not left over for the next (nor a door since closed)', () => {
    const { world: w, h, player } = setup();
    const top = addEntrance(w, player, 24, 30);
    const west = army(w, 2, 60, 64);
    const north = army(w, 4, 46, 46);
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      observeMarchHistory(h, w);
      advance(w, 1);
    }
    for (const id of west) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    for (const id of north) {
      const [x, y] = pos(w, id);
      const dx = 24.5 - x;
      const dy = 30.5 - y;
      const d = Math.hypot(dx, dy);
      place(w, id, x + (6 * dx) / d, y + (6 * dy) / d);
    }
    observeMarchHistory(h, w);
    expect(measureEnemyMarch(w, P, h)!.entrance).toBe(top); // four aim at it
    // The four die: the two aiming at the row-64 door are the march now.
    for (const id of north) w.ants.alive[id] = 0;
    const two = measureEnemyMarch(w, P, h)!;
    expect(two).toMatchObject({ fighters: 2, entrance: { surfaceTileY: DOOR.y } });
    expect(two).toEqual(measureEnemyMarch(w, P, freshScratch(h)));
    // And with the top door closed (one door fewer than the buffers last held).
    for (const id of north) w.ants.alive[id] = 1;
    measureEnemyMarch(w, P, h);
    top.isOpen = false;
    expect(measureEnemyMarch(w, P, h)).toEqual(measureEnemyMarch(w, P, freshScratch(h)));
  });
});

describe('MarchHistory — sampling', () => {
  it('samples every MARCH_SAMPLE_TICKS; a frame on the same tick takes nothing new', () => {
    const { world: w, h } = setup();
    observeMarchHistory(h, w);
    observeMarchHistory(h, w);
    expect(h.count).toBe(1);
    advance(w, MARCH_SAMPLE_TICKS - 1);
    observeMarchHistory(h, w);
    expect(h.count).toBe(1);
    advance(w, 1);
    observeMarchHistory(h, w);
    expect(h.count).toBe(2);
  });

  it('a new world or a tick that runs backwards starts afresh', () => {
    const { world: w, h } = setup();
    observeMarchHistory(h, w);
    advance(w, MARCH_SAMPLE_TICKS);
    observeMarchHistory(h, w);
    expect(h.count).toBe(2);
    advance(w, -1);
    observeMarchHistory(h, w);
    expect(h.count).toBe(1);
    const other = raidWorld().world;
    observeMarchHistory(h, other);
    expect(h.world).toBe(other);
    expect(h.count).toBe(1);
    resetMarchHistory(h);
    expect(h.world).toBeNull();
    expect(h.count).toBe(0);
  });

  it('after a gap longer than MARCH_MAX_LOOKBACK_TICKS there is no heading', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    observeMarchHistory(h, w);
    advance(w, MARCH_MAX_LOOKBACK_TICKS + 1);
    for (const id of ids) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    observeMarchHistory(h, w);
    expect(measureEnemyMarch(w, P, h)).toBeNull();
    // Exactly at the lookback limit it still counts.
    const b = setup();
    const idb = army(b.world, MARCH_MIN_FIGHTERS, 60, 63);
    observeMarchHistory(b.h, b.world);
    advance(b.world, MARCH_MAX_LOOKBACK_TICKS);
    for (const id of idb) {
      const [x, y] = pos(b.world, id);
      place(b.world, id, x - 10, y);
    }
    observeMarchHistory(b.h, b.world);
    expect(measureEnemyMarch(b.world, P, b.h)!.fighters).toBe(MARCH_MIN_FIGHTERS);
  });

  it('a stalled gap: a fresh recent sample does not make a stale heading sample usable', () => {
    // Samples at t0 and t0+35 (a long gap, as from a stalled tab), now t0+45: the
    // newest sample a window old is t0's, 45 ticks back — past the lookback.
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    observeMarchHistory(h, w);
    advance(w, 35);
    observeMarchHistory(h, w);
    advance(w, 10);
    for (const id of ids) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    observeMarchHistory(h, w);
    expect(45).toBeGreaterThan(MARCH_MAX_LOOKBACK_TICKS);
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('a fighter that was below ground at the last sample has no recent motion: not marching', () => {
    // On the surface at the window's sample and now, but down a tunnel when the
    // newest sample at least MARCH_SAMPLE_TICKS old was taken.
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      const dipped = t === MARCH_WINDOW_TICKS - MARCH_SAMPLE_TICKS;
      for (const id of ids) w.ants.zone[id] = dipped ? Zone.Underground : Zone.Surface;
      observeMarchHistory(h, w);
      advance(w, 1);
    }
    for (const id of ids) {
      w.ants.zone[id] = Zone.Surface;
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    observeMarchHistory(h, w);
    expect(measureEnemyMarch(w, P, h)).toBeNull();
  });

  it('the ring wraps: a long walk keeps measuring against the sample a window back', () => {
    const { world: w, h } = setup();
    const ids = army(w, MARCH_MIN_FIGHTERS, 84, 63);
    // Walk 0.5 tile a tick for 120 ticks (60 tiles), observing every tick.
    for (let t = 0; t < 120; t++) {
      observeMarchHistory(h, w);
      advance(w, 1);
      for (const id of ids) {
        const [x, y] = pos(w, id);
        place(w, id, x - 0.5, y);
      }
    }
    observeMarchHistory(h, w);
    const m = measureEnemyMarch(w, P, h)!;
    expect(m.fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(m.minTileX).toBeCloseTo(84.5 - 60, 5);
  });
});

describe('measureEnemyMarchThisTick — shared history, one measurement per world, viewer and tick', () => {
  it('feeds its own history from the frames it is called on, and memoises per tick', () => {
    const { world: w } = raidWorld();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      expect(measureEnemyMarchThisTick(w, P)).toBeNull();
      advance(w, 1);
    }
    for (const id of ids) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    const first = measureEnemyMarchThisTick(w, P);
    expect(first!.fighters).toBe(MARCH_MIN_FIGHTERS);
    w.ants.alive[ids[0]!] = 0; // no tick has run: the memo stands
    expect(measureEnemyMarchThisTick(w, P)).toBe(first);
    expect(measureEnemyMarchThisTick(w, E)).toBeNull(); // other viewer
    expect(measureEnemyMarchThisTick(w, P)!.fighters).toBe(MARCH_MIN_FIGHTERS - 1);
    // A new world at the same tick (a restart or load) starts a new history.
    const other = raidWorld().world;
    advance(other, w.tick - other.tick);
    expect(measureEnemyMarchThisTick(other, P)).toBeNull();
  });

  it('keeps a history per world: frames of another world in between do not wipe it', () => {
    const a = raidWorld().world;
    const b = raidWorld().world;
    const ids = army(a, MARCH_MIN_FIGHTERS, 60, 63);
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      measureEnemyMarchThisTick(a, P);
      measureEnemyMarchThisTick(b, P);
      advance(a, 1);
      advance(b, 1);
    }
    for (const id of ids) {
      const [x, y] = pos(a, id);
      place(a, id, x - 10, y);
    }
    measureEnemyMarchThisTick(b, P);
    expect(measureEnemyMarchThisTick(a, P)!.fighters).toBe(MARCH_MIN_FIGHTERS);
    expect(measureEnemyMarchThisTick(b, P)).toBeNull();
  });
});

describe('armyWarningLogEntry — what the dev log records of a warning', () => {
  it('the tick, the text, the march size and its nearest distance from the door', () => {
    const quiet = raidWorld().world;
    expect(armyWarningLogEntry(quiet, P, 'x', quiet.tick - 3)).toEqual({
      tick: quiet.tick,
      owedTick: quiet.tick - 3,
      text: 'x',
      marching: 0,
      marchDistanceTiles: null,
    });
    const { world: w } = raidWorld();
    const ids = army(w, MARCH_MIN_FIGHTERS, 60, 63);
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      measureEnemyMarchThisTick(w, P);
      advance(w, 1);
    }
    for (const id of ids) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    // Box x 50.5..53.5, rows 63.5..64.5; the door centre (24.5, 64.5) is 26 tiles
    // west of its near edge, inside its rows.
    const e = armyWarningLogEntry(w, P, 'march', w.tick - 7);
    expect(e.tick).toBe(w.tick);
    expect(e.owedTick).toBe(w.tick - 7);
    expect(e.marching).toBe(MARCH_MIN_FIGHTERS);
    expect(e.marchDistanceTiles).toBeCloseTo(26, 5);
  });

  it('chasers only (a warning they kept owed) log as no march', () => {
    const { world: w } = raidWorld();
    const ids = army(w, MARCH_MIN_FIGHTERS, 80, 64);
    const own = addFighter(w, P, 40, 64, null);
    place(w, own, 77.5, 65);
    for (let t = 0; t < MARCH_WINDOW_TICKS; t++) {
      measureEnemyMarchThisTick(w, P);
      advance(w, 1);
    }
    for (const id of [...ids, own]) {
      const [x, y] = pos(w, id);
      place(w, id, x - 10, y);
    }
    expect(measureEnemyMarchThisTick(w, P)).toMatchObject({
      fighters: 0,
      chasing: MARCH_MIN_FIGHTERS,
    });
    expect(armyWarningLogEntry(w, P, 'march', w.tick)).toMatchObject({
      marching: 0,
      marchDistanceTiles: null,
    });
  });
});
