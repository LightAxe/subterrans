// #373 — pinned V64: the colony alarm and its shelterers during an invasion behave
// exactly as before V65.
//
// #373 changes step 10a under the alarm (it recruits fighters, sheltering workers
// included), step 15b for shelterers while the nest is invaded (no poke-out; a
// retreat field) and after it (a shelterer below the shaft-top row is released),
// and step 16 for a shelterer (the retreat step). Below V65 each is gated off. The
// byte gate's scenarios never sound the alarm and rarely put an intruder in a nest
// with shelterers, so this pins those paths at V64 through the whole tick: the
// fingerprint of every tracked ant's tile, zone, task, sub-task and flee phase over
// the run must equal the one the base tree produces (GOLDEN was captured by running
// this file on fix/372-auto-defence at b7f481a, before #373).
// Non-vacuity: the run has the alarm on with fighter demand and Idle workers, shelterers at the
// shaft top while enemy fighters are below in the nest, a kill, and the all-clear.
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId } from './types.js';
import type { WorldState } from './types.js';
import type { SimCommand } from './commands.js';
import { initAnt } from './ant/ant-store.js';
import { addChamberForTest } from './food/food-test-utils.js';
import { AntTask, ChamberType } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SHELTER_COOLDOWN_TICKS,
} from './constants.js';

/** simVersion 64 (SIM_VERSION_V64_AUTO_DEFENCE). */
const V64 = 64;
const TICKS = 700;
/** Captured on fix/372-auto-defence at b7f481a (before #373) by running this file there. */
const GOLDEN: string = '708dd46e';

function spawn(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number,
  task: number,
  grid = colonyId,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: task as AntTask,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    lastMealTick: world.tick,
    zone: zone as Zone,
  });
  world.ants.currentGridColonyId[id] = grid;
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

/** FNV-1a over a string: a short, stable fingerprint. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('#373 — pinned V64: the alarm and its shelterers during an invasion are unchanged below V65', () => {
  it('recruitment under the alarm, shelterers with intruders below, the all-clear', () => {
    const world = createScenario(7, 'Normal', V64);
    world.spider = null;
    const P = PLAYER_COLONY_ID;
    const E = ENEMY_COLONY_ID;
    const player = world.colonies[P]!;
    const pa = player.entrances.find((en) => en.isOpen)!;
    const ax = pa.surfaceTileX;
    // The player's nest: a shaft to a tunnel along row 3, a chamber at each end.
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= 3; y++) ugSet(grid, ax, y, UndergroundTileState.Open);
    for (let x = ax - 12; x <= ax + 12; x++) ugSet(grid, x, 3, UndergroundTileState.Open);
    for (const x0 of [ax - 14, ax + 12]) {
      for (let y = 2; y <= 4; y++) {
        for (let x = x0; x < x0 + 3; x++) ugSet(grid, x, y, UndergroundTileState.Open);
      }
      addChamberForTest(world, player, {
        chamberId: allocateEntityId(world),
        chamberType: ChamberType.Nursery,
        posX: x0 << FP_SHIFT,
        posY: 2 << FP_SHIFT,
        width: 3,
        height: 3,
      });
    }
    player.digFlowFieldDirty = true;
    // Shelterers at the shaft top, idle workers on the surface and deep, a carrier.
    const mine: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = spawn(world, P, ax, 0, Zone.Underground, AntTask.Idle);
      world.ants.fleeShelterUntilTick[id] = world.tick + SHELTER_COOLDOWN_TICKS;
      mine.push(id);
    }
    for (let i = 0; i < 4; i++)
      mine.push(spawn(world, P, ax + 3 + i, pa.surfaceTileY, Zone.Surface, AntTask.Idle));
    for (let i = 0; i < 3; i++)
      mine.push(spawn(world, P, ax + 13, 3, Zone.Underground, AntTask.Idle));
    // Enemy fighters below in the player's nest, west of the shaft (their rally on
    // the player's entrance: invaders).
    world.colonies[E]!.rallyPoint = { tileX: ax, tileY: pa.surfaceTileY };
    const foes: number[] = [];
    for (let i = 0; i < 3; i++)
      foes.push(spawn(world, E, ax - 8 - i, 3, Zone.Underground, AntTask.Fighting, P));

    const tracked = [...mine, ...foes, player.queenEntityId];
    const frames: string[] = [];
    let recruitedUnderAlarm = 0;
    let shelteringWhileInvaded = 0;
    for (let t = 0; t < TICKS; t++) {
      const cmds: SimCommand[] = [];
      if (t === 2) {
        cmds.push(
          { type: 'SetColonyAlarm', colonyId: P, active: true, issuedAtTick: world.tick },
          {
            type: 'SetBehaviorRatio',
            colonyId: P,
            ratio: { forage: 2, fight: 8 },
            issuedAtTick: world.tick,
          },
        );
      }
      if (t === 400) {
        cmds.push({ type: 'SetColonyAlarm', colonyId: P, active: false, issuedAtTick: world.tick });
      }
      tick(world, cmds);
      const a = world.ants;
      const invaded = foes.some(
        (f) => a.alive[f] === 1 && a.zone[f] === Zone.Underground && a.currentGridColonyId[f] === P,
      );
      for (const id of mine) {
        if (a.alive[id] !== 1) continue;
        if (t > 2 && t < 400 && a.task[id] === AntTask.Fighting) recruitedUnderAlarm++;
        if (invaded && a.zone[id] === Zone.Underground && a.fleeShelterUntilTick[id]! > 0) {
          shelteringWhileInvaded++;
        }
      }
      frames.push(
        tracked
          .map(
            (id) =>
              `${a.alive[id]}:${a.task[id]}:${a.subTask[id]}:${a.zone[id]}:${a.posX[id]! >> FP_SHIFT},${a.posY[id]! >> FP_SHIFT}:${a.fleeShelterUntilTick[id]}`,
          )
          .join(';'),
      );
    }
    const hash = fnv(frames.join('\n'));
    if (GOLDEN === 'CAPTURE') console.log(`GOLDEN ${hash}`);
    // Non-vacuity: at V64 the alarm recruits nobody, and shelterers sat out an
    // invasion below.
    expect(recruitedUnderAlarm).toBe(0);
    expect(shelteringWhileInvaded).toBeGreaterThan(0);
    expect(foes.some((f) => world.ants.alive[f] !== 1)).toBe(true); // a kill
    expect(hash).toBe(GOLDEN);
  }, 60_000);
});
