// #377 — pinned V67: idle workers during a spider rampage behave exactly as before V68.
//
// #377 changes step 10a (an Idle worker sheltering during a rampage stays
// recruitable), step 15b (idle surface workers go in and idle shelterers stay in
// during a rampage) and step 16 (the routed dash; an idle worker at the shaft top is
// held). Below V68 each is gated off. The byte gate's scenarios have the spider but
// few idle workers on the surface when it hunts, so this pins those paths at V67
// through the whole tick: the fingerprint of every tracked ant's tile, zone, task,
// sub-task, flee phase and target, and the spider's, over the run must equal the one
// the base tree produces (GOLDEN was captured by running this file on main at
// 6528941, before #377).
// Non-vacuity: the run has the spider hungry and hunting, idle workers on the
// surface and sheltering below while it does, two open entrances, the alarm sounded
// and cleared, the fight ratio raised, and a spider kill.
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId } from './types.js';
import type { WorldState } from './types.js';
import type { SimCommand } from './commands.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, ForagingSubState } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SHELTER_COOLDOWN_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
} from './constants.js';

/** simVersion 67 (SIM_VERSION_V67_NO_MATCH_TIMEOUT). */
const V67 = 67;
const TICKS = 2400;
/** Captured on main at 6528941 (before #377) by running this file there. */
const GOLDEN: string = 'd5e32e83';

function spawn(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number,
  task: number,
  subTask = 0,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: task as AntTask,
    subTask,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    lastMealTick: world.tick,
    zone: zone as Zone,
  });
  world.ants.currentGridColonyId[id] = colonyId;
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

describe('#377 — pinned V67: idle workers during a spider rampage are unchanged below V68', () => {
  it('the reserve on the surface and below, two doors, the alarm, the fight ratio, a kill', () => {
    const world = createScenario(7, 'Normal');
    world.simVersion = V67;
    world.aiState = [];
    world.tick = SPIDER_GRACE_TICKS + 200;
    const P = PLAYER_COLONY_ID;
    const player = world.colonies[P]!;
    const pa = player.entrances.find((en) => en.isOpen)!;
    const ax = pa.surfaceTileX;
    const ay = pa.surfaceTileY;
    // The player's nest: a shaft to a tunnel along row 3, and a second open entrance
    // 12 tiles east with its own shaft to the tunnel.
    const grid = world.undergroundGrids[P]!;
    const bx = ax + 12;
    for (let y = 0; y <= 3; y++) {
      ugSet(grid, ax, y, UndergroundTileState.Open);
      ugSet(grid, bx, y, UndergroundTileState.Open);
    }
    for (let x = ax - 4; x <= bx; x++) ugSet(grid, x, 3, UndergroundTileState.Open);
    player.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: bx,
      surfaceTileY: ay,
      isOpen: true,
    });
    player.digFlowFieldDirty = true;
    player.targetRatio = { forage: 0, fight: 0 };
    world.colonies[ENEMY_COLONY_ID]!.targetRatio = { forage: 0, fight: 0 };
    const mine: number[] = [];
    // Idle workers milling round both doors, and one far out.
    for (let i = 0; i < 6; i++)
      mine.push(spawn(world, P, ax + 2 + (i % 3), ay - 1 + (i >> 1), Zone.Surface, AntTask.Idle));
    for (let i = 0; i < 3; i++)
      mine.push(spawn(world, P, bx + 2, ay - 1 + i, Zone.Surface, AntTask.Idle));
    mine.push(spawn(world, P, ax + 25, ay, Zone.Surface, AntTask.Idle));
    // Sheltering at the shaft top, and idle at the shaft top about to climb out.
    for (let i = 0; i < 3; i++) {
      const id = spawn(world, P, ax, 0, Zone.Underground, AntTask.Idle);
      world.ants.fleeShelterUntilTick[id] = world.tick + 5 + i * 40;
      mine.push(id);
    }
    for (let i = 0; i < 2; i++) mine.push(spawn(world, P, ax, 0, Zone.Underground, AntTask.Idle));
    // Foragers searching near the door.
    for (let i = 0; i < 2; i++)
      mine.push(
        spawn(
          world,
          P,
          ax + 4 + i,
          ay + 2,
          Zone.Surface,
          AntTask.Foraging,
          ForagingSubState.SearchingFood,
        ),
      );
    // The spider goes hungry 20 tiles from the door and hunts.
    const sp = world.spider!;
    sp.posX = (ax + 20) << FP_SHIFT;
    sp.posY = (ay + 14) << FP_SHIFT;
    sp.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;
    sp.nextHuntTick = world.tick + 400;
    const script: SimCommand[][] = [];
    const at = (t: number, cmd: SimCommand): void => {
      (script[t] ??= []).push(cmd);
    };
    at(300, { type: 'SetColonyAlarm', colonyId: P, active: true, issuedAtTick: 0 });
    at(420, { type: 'SetColonyAlarm', colonyId: P, active: false, issuedAtTick: 0 });
    at(700, {
      type: 'SetBehaviorRatio',
      colonyId: P,
      ratio: { forage: 0, fight: 10 },
      issuedAtTick: 0,
    });
    at(760, {
      type: 'SetBehaviorRatio',
      colonyId: P,
      ratio: { forage: 0, fight: 0 },
      issuedAtTick: 0,
    });
    let frames = '';
    let hungryTicks = 0;
    let idleSurfaceWhileHungry = 0;
    let shelteringWhileHungry = 0;
    let spiderKills = 0;
    for (let t = 0; t < TICKS; t++) {
      // Keep it coming back hungry: every 300 ticks a spider not Feeding is set
      // hungry again (a scripted edit, the same on both trees).
      if (t % 300 === 0 && world.spider !== null && world.spider.state !== 'Feeding') {
        world.spider.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;
      }
      const s = world.spider;
      const hungry =
        s !== null &&
        s.state !== 'Feeding' &&
        s.hungerTicks >= SPIDER_HUNGER_THRESHOLD_TICKS[1] &&
        world.tick >= SPIDER_GRACE_TICKS;
      if (hungry) hungryTicks++;
      for (const id of mine) {
        if (world.ants.alive[id] !== 1 || world.ants.task[id] !== AntTask.Idle || !hungry) continue;
        if (world.ants.zone[id] === Zone.Surface) idleSurfaceWhileHungry++;
        else if (world.ants.fleeShelterUntilTick[id]! > 0) shelteringWhileHungry++;
      }
      const ev0 = world.events.length;
      tick(
        world,
        (script[t] ?? []).map((c) => ({ ...c, issuedAtTick: world.tick })),
      );
      for (let i = ev0; i < world.events.length; i++) {
        const ev = world.events[i]!;
        if (ev.type === 'combat_kill' && ev.payload.killer.kind === 'Spider') spiderKills++;
      }
      const a = world.ants;
      let line = `${t}`;
      for (const id of mine) {
        line += `|${a.alive[id]},${a.task[id]},${a.subTask[id]},${a.zone[id]},${a.posX[id]! >> FP_SHIFT},${a.posY[id]! >> FP_SHIFT},${a.fleeShelterUntilTick[id]},${a.targetPosX[id]},${a.targetPosY[id]}`;
      }
      const w = world.spider;
      line += w === null ? '|-' : `|${w.state},${w.posX},${w.posY},${w.hungerTicks}`;
      frames += line + '\n';
    }
    if (GOLDEN === 'CAPTURE') {
      console.log(
        `PARITY-COUNTS ${hungryTicks} ${idleSurfaceWhileHungry} ${shelteringWhileHungry} ${spiderKills}`,
      );
    }
    expect(hungryTicks).toBeGreaterThan(300);
    expect(idleSurfaceWhileHungry).toBeGreaterThan(300);
    expect(shelteringWhileHungry).toBeGreaterThan(50);
    expect(spiderKills).toBeGreaterThan(1);
    expect(SHELTER_COOLDOWN_TICKS).toBe(100);
    if (GOLDEN === 'CAPTURE') console.log(`PARITY-CAPTURE ${fnv(frames)}`);
    expect(fnv(frames)).toBe(GOLDEN);
  });
});
