// #373 (V65) — the colony alarm during an invasion.
//
// 1. The ratio always wins: under the alarm, step 10a still recruits Idle workers
//    (sheltering ones too) into FIGHTING when the ratio asks for fighters, and into
//    nothing else.
// 2. Shelter away from invaders: while an enemy ant is below ground in a colony's
//    nest, its shelterers walk by tunnel path to the chamber tile farthest from the
//    invaders (per connected part of the nest), unless they already stand farther;
//    they keep sheltering until the nest is clear, then a shelterer that retreated is
//    released where it stands. With no intruder inside nothing changes.
//
// The state-space audit (alarm × invaders × worker position × ratio) runs every case
// through tick() at V64 and at V65 and checks the V65 outcome is the recruitment or
// the retreat where one should happen, and exactly the V64 outcome everywhere else.
// The rules are pinned through tick() below it.
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import {
  allocateEntityId,
  SIM_VERSION_V64_AUTO_DEFENCE,
  SIM_VERSION_V65_ALARM_INVASION,
} from './types.js';
import type { WorldState } from './types.js';
import type { ChamberRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { killAnt } from './ant-death.js';
import { addChamberForTest } from './food/food-test-utils.js';
import { tickIdleReserveAndFlee, tickAntMovement } from './ant/ant-system.js';
import { createDigFlowFields } from './dig-system.js';
import { Rng } from './rng.js';
import { AntTask, ChamberType, FightingSubState, ForagingSubState } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SHELTER_COOLDOWN_TICKS,
} from './constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
const V64 = SIM_VERSION_V64_AUTO_DEFENCE;
const V65 = SIM_VERSION_V65_ALARM_INVASION;
/** Row of the nest's tunnel (the shaft runs down to it). */
const TUNNEL_Y = 3;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

interface Nest {
  world: WorldState;
  /** Entrance column and its surface row. */
  ax: number;
  ay: number;
}

/**
 * A quiet scenario world (no spider, no AI records, no starting workers in either
 * colony) whose player nest has a shaft under its open entrance down to a tunnel
 * along TUNNEL_Y, from ax - 8 to ax + 12. No chambers yet (addChamber).
 */
function nest(version: number): Nest {
  const world = createScenario(7, 'Normal');
  world.simVersion = version;
  world.spider = null;
  world.aiState = [];
  for (const cid of [P, E]) {
    const colony = world.colonies[cid]!;
    for (const id of [...colony.workers]) killAnt(world, id, null, null, 'Spider');
  }
  const colony = world.colonies[P]!;
  const ea = colony.entrances.find((en) => en.isOpen)!;
  const grid = world.undergroundGrids[P]!;
  const ax = ea.surfaceTileX;
  for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, ax, y, UndergroundTileState.Open);
  for (let x = ax - 8; x <= ax + 12; x++) ugSet(grid, x, TUNNEL_Y, UndergroundTileState.Open);
  colony.digFlowFieldDirty = true;
  return { world, ax, ay: ea.surfaceTileY };
}

/** A completed chamber of the player's, dug out: tiles [x0, x0+w) × [y0, y0+h). */
function addChamber(n: Nest, x0: number, y0: number, w: number, h: number): ChamberRecord {
  const grid = n.world.undergroundGrids[P]!;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) ugSet(grid, x, y, UndergroundTileState.Open);
  }
  n.world.colonies[P]!.digFlowFieldDirty = true;
  return addChamberForTest(n.world, n.world.colonies[P]!, {
    chamberId: allocateEntityId(n.world),
    chamberType: ChamberType.Nursery,
    posX: x0 << FP_SHIFT,
    posY: y0 << FP_SHIFT,
    width: w,
    height: h,
  });
}

function spawn(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number,
  opts: { task?: number; subTask?: number; speed?: number; grid?: number } = {},
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: center(x),
    posY: center(y),
    task: (opts.task ?? AntTask.Idle) as AntTask,
    subTask: opts.subTask ?? 0,
    speed: opts.speed ?? WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    lastMealTick: world.tick,
    zone: zone as Zone,
  });
  world.ants.currentGridColonyId[id] = opts.grid ?? colonyId;
  const colony = world.colonies[colonyId]!;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

/** An enemy fighter standing still (speed 0) below ground in the player's nest. */
function intruder(world: WorldState, x: number, y: number): number {
  return spawn(world, E, x, y, Zone.Underground, { task: AntTask.Fighting, speed: 0, grid: P });
}

/** A player worker sheltering at tile (x, y) below ground until `until`. */
function shelterer(
  world: WorldState,
  x: number,
  y: number,
  until: number,
  task: number = AntTask.Idle,
): number {
  // A forager shelterer is an empty one heading home (a carrier at the shaft top
  // would bank its load into the entrance pool there and turn Idle).
  const id = spawn(world, P, x, y, Zone.Underground, {
    task,
    subTask: task === AntTask.Foraging ? ForagingSubState.ReturningToNest : 0,
  });
  world.ants.fleeShelterUntilTick[id] = until;
  return id;
}

const tileX = (w: WorldState, id: number): number => w.ants.posX[id]! >> FP_SHIFT;
const tileY = (w: WorldState, id: number): number => w.ants.posY[id]! >> FP_SHIFT;
const inChamber = (w: WorldState, id: number, ch: ChamberRecord): boolean => {
  const x = tileX(w, id);
  const y = tileY(w, id);
  const bx = ch.posX >> FP_SHIFT;
  const by = ch.posY >> FP_SHIFT;
  return x >= bx && x < bx + ch.width && y >= by && y < by + ch.height;
};
const fingerprint = (w: WorldState, id: number): string => {
  const a = w.ants;
  return [
    a.alive[id],
    a.task[id],
    a.subTask[id],
    a.zone[id],
    tileX(w, id),
    tileY(w, id),
    a.fleeShelterUntilTick[id],
    a.targetPosX[id],
    a.targetPosY[id],
  ].join(',');
};

// ---------------------------------------------------------------------------
// The state-space audit
// ---------------------------------------------------------------------------

type Alarm = 'on' | 'off';
/** Where the enemy is: nowhere, on the surface by the door, or below in the nest. */
type Invaders = 'none' | 'outside' | 'inside';
/** Where the player worker stands, and as what. */
type Position =
  | 'surface' // an Idle worker on the surface, three tiles from the door
  | 'shaft' // an Idle worker sheltering at the shaft top
  | 'shaftForager' // a forager (Foraging, ReturningToNest) sheltering at the shaft top
  | 'deep'; // an Idle worker in the chamber, not sheltering (a wanderer)
/** The behaviour ratio after the change: all foragers, or all fighters. */
type Ratio = 'forage' | 'fight';

type Expect = 'recruit' | 'retreat' | 'same';

/** What V65 must do differently from V64 in this case (the rules above). */
function expected(alarm: Alarm, inv: Invaders, pos: Position, ratio: Ratio): Expect {
  // Every position is a recruitable worker under the alarm: Idle ones, and the
  // empty forager sheltering at the shaft top.
  if (alarm === 'on' && ratio === 'fight') return 'recruit';
  // A shelterer — at the shaft top already, or (under the alarm) a surface worker
  // it recalls there — retreats while the enemy is below in the nest.
  const shelters =
    pos === 'shaft' || pos === 'shaftForager' || (pos === 'surface' && alarm === 'on');
  if (inv === 'inside' && shelters) return 'retreat';
  return 'same';
}

const TICKS = 80;

interface Run {
  frames: string[];
  final: { task: number; zone: number; x: number; y: number; phase: number };
  taskAfterOne: number;
  phaseAfterOne: number;
  inChamber: boolean;
  shaftX: number;
}

function runCase(version: number, alarm: Alarm, inv: Invaders, pos: Position, ratio: Ratio): Run {
  const n = nest(version);
  const { world, ax, ay } = n;
  const ch = addChamber(n, ax + 10, 2, 3, 3);
  const colony = world.colonies[P]!;
  colony.targetRatio = ratio === 'fight' ? { forage: 0, fight: 10 } : { forage: 10, fight: 0 };
  colony.alarmActive = alarm === 'on';
  if (inv === 'inside') intruder(world, ax - 6, TUNNEL_Y);
  if (inv === 'outside')
    spawn(world, E, ax - 6, ay, Zone.Surface, { task: AntTask.Fighting, speed: 0 });
  const until = world.tick + SHELTER_COOLDOWN_TICKS;
  let id: number;
  if (pos === 'surface') id = spawn(world, P, ax + 3, ay, Zone.Surface);
  else if (pos === 'shaft') id = shelterer(world, ax, 0, until);
  else if (pos === 'shaftForager') id = shelterer(world, ax, 0, until, AntTask.Foraging);
  else id = spawn(world, P, ax + 11, 3, Zone.Underground);
  const frames: string[] = [];
  let taskAfterOne = -1;
  let phaseAfterOne = 0;
  for (let t = 0; t < TICKS; t++) {
    tick(world, []);
    if (t === 0) {
      taskAfterOne = world.ants.task[id]!;
      phaseAfterOne = world.ants.fleeShelterUntilTick[id]!;
    }
    frames.push(fingerprint(world, id));
  }
  return {
    frames,
    final: {
      task: world.ants.task[id]!,
      zone: world.ants.zone[id]!,
      x: tileX(world, id),
      y: tileY(world, id),
      phase: world.ants.fleeShelterUntilTick[id]!,
    },
    taskAfterOne,
    phaseAfterOne,
    inChamber: world.ants.alive[id] === 1 && inChamber(world, id, ch),
    shaftX: ax,
  };
}

describe('#373 (V65) — state-space audit: alarm × invaders × position × ratio, V64 vs V65', () => {
  const ALARMS: Alarm[] = ['on', 'off'];
  const INVADERS: Invaders[] = ['none', 'outside', 'inside'];
  const POSITIONS: Position[] = ['surface', 'shaft', 'shaftForager', 'deep'];
  const RATIOS: Ratio[] = ['forage', 'fight'];
  const tally: Record<Expect, number> = { recruit: 0, retreat: 0, same: 0 };
  for (const alarm of ALARMS) {
    for (const inv of INVADERS) {
      for (const pos of POSITIONS) {
        for (const ratio of RATIOS) {
          const want = expected(alarm, inv, pos, ratio);
          tally[want] += 1;
          it(`alarm ${alarm}, invaders ${inv}, ${pos}, ratio → ${ratio}: ${want}`, () => {
            const v64 = runCase(V64, alarm, inv, pos, ratio);
            const v65 = runCase(V65, alarm, inv, pos, ratio);
            if (want === 'same') {
              expect(v65.frames).toEqual(v64.frames);
            } else if (want === 'recruit') {
              // V65: a fighter on the first tick, its shelter (if any) over.
              expect(v65.taskAfterOne).toBe(AntTask.Fighting);
              expect(v65.phaseAfterOne).toBe(-1);
              // V64: the alarm recruits nobody.
              expect(v64.taskAfterOne).not.toBe(AntTask.Fighting);
            } else {
              // V64: waits at the shaft top, sheltering.
              expect(v64.final.zone).toBe(Zone.Underground);
              expect([v64.final.x, v64.final.y]).toEqual([v64.shaftX, 0]);
              expect(v64.final.phase).toBeGreaterThan(0);
              // V65: in the chamber farthest from the intruder, still sheltering.
              expect(v65.final.zone).toBe(Zone.Underground);
              expect(v65.inChamber).toBe(true);
              expect(v65.final.phase).toBeGreaterThan(0);
            }
          }, 30_000);
        }
      }
    }
  }
  it('the audit covers every class', () => {
    expect(tally.recruit).toBe(12); // alarm on × 3 invader states × 4 positions, ratio fight
    expect(tally.retreat).toBeGreaterThanOrEqual(4);
    expect(tally.same).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 1. The ratio always wins
// ---------------------------------------------------------------------------

describe('#373 (V65) — under the alarm the ratio still recruits fighters', () => {
  function recruitWorld(version: number): { world: WorldState; ids: number[] } {
    const n = nest(version);
    const { world, ax, ay } = n;
    addChamber(n, ax + 10, 2, 3, 3);
    const colony = world.colonies[P]!;
    colony.alarmActive = true;
    const until = world.tick + SHELTER_COOLDOWN_TICKS;
    const ids: number[] = [];
    // Four shelterers at the shaft top, two musterers on the surface, two foragers
    // heading home sheltering, two wanderers deep.
    for (let i = 0; i < 4; i++) ids.push(shelterer(world, ax, 0, until));
    for (let i = 0; i < 2; i++) ids.push(spawn(world, P, ax + 5 + i, ay, Zone.Surface));
    for (let i = 0; i < 2; i++) ids.push(shelterer(world, ax, 0, until, AntTask.Foraging));
    for (let i = 0; i < 2; i++) ids.push(spawn(world, P, ax + 11, 3, Zone.Underground));
    colony.targetRatio = { forage: 2, fight: 8 };
    return { world, ids };
  }

  it('2:8 turns 8 of 10 into fighters, lowest id first, sheltering or not, and nothing else', () => {
    const { world, ids } = recruitWorld(V65);
    // A leash wave the alarm recall parked on one sheltering forager.
    world.ants.searchWave[ids[6]!] = -(3 + 1);
    tick(world, []);
    const a = world.ants;
    const fighters = ids.filter((id) => a.task[id] === AntTask.Fighting);
    // 10 workers, 2:8 → fight 8: the 8 lowest ids, sheltering foragers included.
    expect(fighters).toEqual(ids.slice(0, 8));
    for (const id of fighters) expect(a.fleeShelterUntilTick[id]).toBe(-1);
    expect(a.searchWave[ids[6]!]).toBe(3); // restored, as the recall would
    // The two left (deep wanderers) stay Idle.
    for (const id of ids.slice(8)) expect(a.task[id]).toBe(AntTask.Idle);
    // Nobody went to forage, dig or nurse.
    for (const id of ids) {
      expect([AntTask.Fighting, AntTask.Idle]).toContain(a.task[id]);
    }
  });

  it('a sheltering forager still carrying food is not recruited', () => {
    const n = nest(V65);
    const { world, ax } = n;
    world.colonies[P]!.alarmActive = true;
    world.colonies[P]!.targetRatio = { forage: 0, fight: 10 };
    const id = shelterer(
      world,
      ax + 3,
      TUNNEL_Y,
      world.tick + SHELTER_COOLDOWN_TICKS,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = 256;
    tick(world, []);
    expect(world.ants.task[id]).toBe(AntTask.Foraging);
  });

  it('forage demand under the alarm recruits nobody (the civilian roles wait)', () => {
    const { world, ids } = recruitWorld(V65);
    world.colonies[P]!.targetRatio = { forage: 10, fight: 0 };
    tick(world, []);
    for (const id of ids) expect(world.ants.task[id]).not.toBe(AntTask.Fighting);
    for (const id of [...ids.slice(0, 6), ...ids.slice(8)]) {
      expect(world.ants.task[id]).toBe(AntTask.Idle);
    }
  });

  it('a Mark with no digger at work does not cost the ratio a fighter', () => {
    const n = nest(V65);
    const { world, ax } = n;
    addChamber(n, ax + 10, 2, 3, 3);
    ugSet(world.undergroundGrids[P]!, ax + 13, TUNNEL_Y, UndergroundTileState.Marked);
    const colony = world.colonies[P]!;
    colony.digFlowFieldDirty = true;
    colony.alarmActive = true;
    colony.targetRatio = { forage: 0, fight: 10 };
    const ids: number[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS));
    tick(world, []);
    expect(ids.filter((id) => world.ants.task[id] === AntTask.Fighting).length).toBe(6);
  });

  it('recruited shelterers with no intruder and no rally become sentries at their posts', () => {
    const n = nest(V65);
    const { world, ax } = n;
    addChamber(n, ax + 10, 2, 3, 3);
    const colony = world.colonies[P]!;
    colony.alarmActive = true;
    colony.targetRatio = { forage: 0, fight: 10 };
    const ids: number[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS));
    for (let t = 0; t < 300; t++) tick(world, []);
    for (const id of ids) {
      expect(world.ants.task[id]).toBe(AntTask.Fighting);
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(world.ants.subTask[id]).toBe(FightingSubState.Holding);
    }
  });

  it('pinned V64: under the alarm nobody is recruited', () => {
    const { world, ids } = recruitWorld(V64);
    tick(world, []);
    for (const id of ids) expect(world.ants.task[id]).not.toBe(AntTask.Fighting);
  });

  it('the new fighters join the defence: with an intruder below they hunt it, and it dies', () => {
    const { world, ids } = recruitWorld(V65);
    const ent = world.colonies[P]!.entrances.find((e) => e.isOpen)!;
    const foe = intruder(world, ent.surfaceTileX - 6, TUNNEL_Y);
    let dead = -1;
    for (let t = 0; t < 400 && dead < 0; t++) {
      tick(world, []);
      if (world.ants.alive[foe] !== 1) dead = t;
    }
    expect(dead).toBeGreaterThanOrEqual(0);
    expect(ids.filter((id) => world.ants.task[id] === AntTask.Fighting).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Shelter away from the invaders
// ---------------------------------------------------------------------------

describe('#373 (V65) — shelterers retreat from invaders in the nest', () => {
  it('to the chamber FARTHEST from the invaders, not the nearer one', () => {
    for (const version of [V64, V65]) {
      const n = nest(version);
      const { world, ax } = n;
      const near = addChamber(n, ax - 4, 4, 3, 2); // just below the tunnel, west
      const far = addChamber(n, ax + 10, 2, 3, 3);
      // The intruder is west of the shaft: the east chamber is the farther.
      intruder(world, ax - 8, TUNNEL_Y);
      const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
      for (let t = 0; t < 60; t++) tick(world, []);
      if (version === V65) {
        expect(inChamber(world, id, far)).toBe(true);
        expect(inChamber(world, id, near)).toBe(false);
      } else {
        expect([tileX(world, id), tileY(world, id)]).toEqual([ax, 0]);
      }
    }
  });

  it('and away from them when they come from the other side', () => {
    const n = nest(V65);
    const { world, ax } = n;
    const west = addChamber(n, ax - 8, 4, 3, 2);
    const east = addChamber(n, ax + 10, 2, 3, 3);
    intruder(world, ax + 12, TUNNEL_Y); // in the east chamber
    const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    for (let t = 0; t < 60; t++) tick(world, []);
    expect(inChamber(world, id, west)).toBe(true);
    expect(inChamber(world, id, east)).toBe(false);
  });

  it('two chambers equally far: the one listed first', () => {
    for (const order of ['eastFirst', 'westFirst'] as const) {
      const n = nest(V65);
      const { world, ax } = n;
      // Mirror images about the shaft; the intruder at the foot of a dead end
      // straight below it.
      for (let y = TUNNEL_Y + 1; y <= TUNNEL_Y + 3; y++) {
        ugSet(world.undergroundGrids[P]!, ax, y, UndergroundTileState.Open);
      }
      const mk = (x0: number): ChamberRecord => addChamber(n, x0, 2, 3, 3);
      const first = order === 'eastFirst' ? mk(ax + 6) : mk(ax - 8);
      const second = order === 'eastFirst' ? mk(ax - 8) : mk(ax + 6);
      intruder(world, ax, TUNNEL_Y + 3);
      const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
      for (let t = 0; t < 60; t++) tick(world, []);
      expect(inChamber(world, id, first)).toBe(true);
      expect(inChamber(world, id, second)).toBe(false);
    }
  });

  it('a shelterer already farther from the invaders than any chamber stays put', () => {
    const n = nest(V65);
    const { world, ax, ay } = n;
    // A second entrance B far east of the shaft, joined to the tunnel; the only
    // chamber lies between the intruder and B.
    const bx = ax + 12;
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, bx, y, UndergroundTileState.Open);
    world.colonies[P]!.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: bx,
      surfaceTileY: ay,
      isOpen: true,
    });
    addChamber(n, ax + 2, 4, 3, 2);
    intruder(world, ax - 6, TUNNEL_Y);
    const id = shelterer(world, bx, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    for (let t = 0; t < 60; t++) tick(world, []);
    expect([tileX(world, id), tileY(world, id)]).toEqual([bx, 0]);
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(0);
  });

  it('workers not sheltering (a wanderer in a chamber near the invaders) and the queen do not move for it', () => {
    const run = (version: number): string[] => {
      const n = nest(version);
      const { world, ax } = n;
      addChamber(n, ax - 4, 4, 3, 2);
      addChamber(n, ax + 10, 2, 3, 3);
      intruder(world, ax - 8, TUNNEL_Y);
      const wanderer = spawn(world, P, ax - 3, 4, Zone.Underground);
      const queen = world.colonies[P]!.queenEntityId;
      const frames: string[] = [];
      for (let t = 0; t < 60; t++) {
        tick(world, []);
        frames.push(`${fingerprint(world, wanderer)}|${fingerprint(world, queen)}`);
      }
      return frames;
    };
    expect(run(V65)).toEqual(run(V64));
  });

  it('each connected part of the nest to its own farthest chamber; a part with no intruder holds', () => {
    const n = nest(V65);
    const { world, ax, ay } = n;
    // Part 2: a separate shaft + tunnel at depth 8 under entrance B, not joined.
    const bx = ax + 30;
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= 8; y++) ugSet(grid, bx, y, UndergroundTileState.Open);
    for (let x = bx - 6; x <= bx + 10; x++) ugSet(grid, x, 8, UndergroundTileState.Open);
    world.colonies[P]!.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: bx,
      surfaceTileY: ay,
      isOpen: true,
    });
    const c1 = addChamber(n, ax + 10, 2, 3, 3);
    const c2 = addChamber(n, bx + 8, 9, 3, 2);
    intruder(world, ax - 6, TUNNEL_Y);
    const a = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    const b = shelterer(world, bx, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    for (let t = 0; t < 60; t++) tick(world, []);
    expect(inChamber(world, a, c1)).toBe(true);
    // No intruder in part 2: its shelterer waits at its shaft top.
    expect([tileX(world, b), tileY(world, b)]).toEqual([bx, 0]);
    // An intruder in part 2 as well: it goes to part 2's own chamber.
    intruder(world, bx - 6, 8);
    for (let t = 0; t < 60; t++) tick(world, []);
    expect(inChamber(world, b, c2)).toBe(true);
    expect(inChamber(world, a, c1)).toBe(true);
  });

  it('with the invaders between the shaft and the chamber it holds', () => {
    for (const version of [V64, V65]) {
      const n = nest(version);
      const { world, ax } = n;
      const grid = world.undergroundGrids[P]!;
      for (let x = ax + 13; x <= ax + 20; x++) ugSet(grid, x, TUNNEL_Y, UndergroundTileState.Open);
      addChamber(n, ax + 18, 2, 3, 3);
      intruder(world, ax + 5, TUNNEL_Y); // in the corridor, on the way to the chamber
      const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
      for (let t = 0; t < 60; t++) tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      expect([tileX(world, id), tileY(world, id)]).toEqual([ax, 0]);
    }
  });

  it('a shelterer an invader comes up beside steps away from it, and on to the chamber', () => {
    const n = nest(V65);
    const { world, ax } = n;
    const far = addChamber(n, ax + 10, 2, 3, 3);
    // Mid-corridor, the invader one tile behind it (west), the way ahead clear.
    const id = shelterer(world, ax + 3, TUNNEL_Y, world.tick + SHELTER_COOLDOWN_TICKS);
    intruder(world, ax + 2, TUNNEL_Y);
    for (let t = 0; t < 40; t++) tick(world, []);
    expect(world.ants.alive[id]).toBe(1);
    expect(inChamber(world, id, far)).toBe(true);
  });

  it('shelterers stopped in a one-wide tunnel are not bumped back and forth', () => {
    const n = nest(V65);
    const { world, ax } = n;
    // A loop: a second shaft B joined to the tunnel; the only chamber is nearer the
    // invader than B's shaft, so shelterers at B stay put, stacked on its shaft.
    const bx = ax + 12;
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, bx, y, UndergroundTileState.Open);
    addChamber(n, ax + 2, 4, 3, 2);
    intruder(world, ax - 6, TUNNEL_Y);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(shelterer(world, bx, 2, world.tick + SHELTER_COOLDOWN_TICKS));
    }
    // Stopped, they stay together where they stopped: none is bumped off the tile
    // (a bumped one would step back onto it next tick, and so on).
    for (let t = 0; t < 30; t++) {
      tick(world, []);
      for (const i of ids) expect([tileX(world, i), tileY(world, i)]).toEqual([bx, 2]);
    }
  });

  it('several shelterers file down a one-wide shaft past a friend standing in it', () => {
    const n = nest(V65);
    const { world, ax } = n;
    const far = addChamber(n, ax + 10, 2, 3, 3);
    world.colonies[P]!.alarmActive = true;
    // A lower-id worker standing still in the shaft (idle, not in a chamber: it holds).
    const friend = spawn(world, P, ax, 2, Zone.Underground);
    intruder(world, ax - 6, TUNNEL_Y);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS));
    for (let t = 0; t < 90; t++) tick(world, []);
    expect([tileX(world, friend), tileY(world, friend)]).toEqual([ax, 2]);
    for (const id of ids) expect(inChamber(world, id, far)).toBe(true);
  });

  it('a part of the nest with an intruder but no chamber: the shelterer holds at the shaft top', () => {
    const n = nest(V65);
    const { world, ax } = n;
    intruder(world, ax - 6, TUNNEL_Y);
    const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    for (let t = 0; t < 40; t++) tick(world, []);
    expect([tileX(world, id), tileY(world, id)]).toEqual([ax, 0]);
  });

  it('a retreating shelterer does not poke out while the nest is invaded (V64 does)', () => {
    for (const version of [V64, V65]) {
      const n = nest(version);
      const { world, ax } = n;
      addChamber(n, ax + 10, 2, 3, 3);
      intruder(world, ax - 6, TUNNEL_Y);
      // Alarm off, the timer about to run out, the surface quiet: V34 releases it.
      const id = shelterer(world, ax, 0, world.tick + 1);
      for (let t = 0; t < 3; t++) tick(world, []);
      if (version === V65) {
        expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(world.tick);
        expect(world.ants.zone[id]).toBe(Zone.Underground);
        expect(tileY(world, id)).toBeGreaterThan(0);
      } else {
        expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
      }
    }
  });

  it('a shelterer at the shaft top with nowhere to retreat pokes out exactly as at V64', () => {
    const run = (version: number): string[] => {
      const n = nest(version);
      const { world, ax } = n;
      intruder(world, ax - 6, TUNNEL_Y); // no chamber: nowhere to retreat
      const id = shelterer(world, ax, 0, world.tick + 1);
      const frames: string[] = [];
      for (let t = 0; t < 20; t++) {
        tick(world, []);
        frames.push(fingerprint(world, id));
      }
      return frames;
    };
    const v65 = run(V65);
    expect(v65).toEqual(run(V64));
    expect(v65.some((f) => f.split(',')[6] === '-1')).toBe(true); // it did poke out
  });

  it('the way to the chamber keeps clear of an invader beside it, not only on it', () => {
    const n = nest(V65);
    const { world, ax } = n;
    const grid = world.undergroundGrids[P]!;
    // The invader in a one-tile niche just off the corridor, the chamber beyond it
    // (farther from it than the shaft top: 12 steps against 6).
    ugSet(grid, ax + 2, TUNNEL_Y + 1, UndergroundTileState.Open);
    addChamber(n, ax + 10, 2, 3, 3);
    intruder(world, ax + 2, TUNNEL_Y + 1);
    const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    for (let t = 0; t < 60; t++) tick(world, []);
    expect(world.ants.alive[id]).toBe(1);
    // It never walks past the tile beside the invader: it holds at the shaft.
    expect([tileX(world, id), tileY(world, id)]).toEqual([ax, 0]);
  });

  it('once the nest is clear a retreated shelterer stops sheltering where it stands', () => {
    for (const alarm of [true, false]) {
      const n = nest(V65);
      const { world, ax } = n;
      const far = addChamber(n, ax + 10, 2, 3, 3);
      world.colonies[P]!.alarmActive = alarm;
      // All-forage ratio, so a released worker is recruited unless the alarm holds it.
      world.colonies[P]!.targetRatio = { forage: 10, fight: 0 };
      const foe = intruder(world, ax - 6, TUNNEL_Y);
      const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
      for (let t = 0; t < 60; t++) tick(world, []);
      expect(inChamber(world, id, far)).toBe(true);
      killAnt(world, foe, null, null, 'Spider');
      // Sheltering until its timer runs out (at most SHELTER_COOLDOWN_TICKS)...
      tick(world, []);
      expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(0);
      let released = -1;
      for (let t = 0; t <= SHELTER_COOLDOWN_TICKS && released < 0; t++) {
        tick(world, []);
        if (world.ants.fleeShelterUntilTick[id] === -1) released = t;
      }
      expect(released).toBeGreaterThanOrEqual(0);
      // ...then an ordinary worker below ground, in the chamber it reached.
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(inChamber(world, id, far)).toBe(true);
      tick(world, []);
      if (alarm) expect(world.ants.task[id]).toBe(AntTask.Idle);
      else expect(world.ants.task[id]).toBe(AntTask.Foraging);
    }
  });

  it('a retreat field is read only on the tick it was built', () => {
    const n = nest(V65);
    const { world, ax } = n;
    addChamber(n, ax + 10, 2, 3, 3);
    intruder(world, ax - 6, TUNNEL_Y);
    const id = shelterer(world, ax, 0, world.tick + SHELTER_COOLDOWN_TICKS);
    for (let t = 0; t < 4; t++) tick(world, []);
    // Step 16 alone on the next tick (no step 15b to rebuild the field): it holds.
    const x = world.ants.posX[id];
    const y = world.ants.posY[id];
    tickAntMovement(world, new Rng(1), createDigFlowFields());
    expect([world.ants.posX[id], world.ants.posY[id]]).toEqual([x, y]);
    // With step 15b first, it moves on.
    tickIdleReserveAndFlee(world);
    tickAntMovement(world, new Rng(1), createDigFlowFields());
    expect([world.ants.posX[id], world.ants.posY[id]]).not.toEqual([x, y]);
  });

  it('pinned V64: a shelterer below the shaft-top row with no open entrance at its column stays sheltered', () => {
    const n = nest(V64);
    const { world } = n;
    for (const e of world.colonies[P]!.entrances) e.isOpen = false;
    const id = shelterer(world, 40, 20, 1);
    world.tick = 200;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(200 + SHELTER_COOLDOWN_TICKS);
  });

  it('with no intruder inside, alarm shelterers wait at the shaft top exactly as at V64', () => {
    const run = (version: number): string[] => {
      const n = nest(version);
      const { world, ax, ay } = n;
      addChamber(n, ax + 10, 2, 3, 3);
      world.colonies[P]!.alarmActive = true;
      spawn(world, E, ax - 6, ay, Zone.Surface, { task: AntTask.Fighting, speed: 0 });
      const ids = [
        shelterer(world, ax, 0, world.tick + 5),
        spawn(world, P, ax + 4, ay, Zone.Surface),
        spawn(world, P, ax + 11, 3, Zone.Underground),
      ];
      const frames: string[] = [];
      for (let t = 0; t < 250; t++) {
        tick(world, []);
        frames.push(ids.map((i) => fingerprint(world, i)).join('|'));
      }
      return frames;
    };
    expect(run(V65)).toEqual(run(V64));
  });
});
