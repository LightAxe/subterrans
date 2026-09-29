// #371 — pinned V61: tunnel defenders chasing invaders past nestmates move exactly as
// they did before #371 (on main at 934a44d).
//
// #380 split defenderPassesThroughFriends (the step-16 occupancy exemption) into a
// shared post-duty helper and added defenderChasesInvader for the V62 hunt. The split
// is not version-gated because it changes nothing: a tunnel defender on post duty
// (no target, or walking to its post) is exempt, and one chasing an invader is
// bumped like any ant — at every version, before and after. This pins that at V61
// through the whole tick: six defenders go down a player entrance, meet three
// invaders in a one-tile tunnel shared with a forager, and chase them; the
// fingerprint of every ant's tile and zone over the run must equal the one main
// produces (GOLDEN was captured by running this file's fingerprint on main, where
// the chase predicate below was the same condition inline: a tunnel defender not
// passing through friends). Non-vacuity: on some tick a live defender is chasing
// (defenderChasesInvader on end-of-tick state; its step-10c scratch lives until the
// next tick) with a live nestmate on its own or a neighbouring tile.
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId } from './types.js';
import type { WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { defenderChasesInvader } from './ant/ant-combat-targeting.js';
import { AntTask } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

/** simVersion 61 (SIM_VERSION_V61_AI_EARLY_STORAGE). */
const V61 = 61;
const TICKS = 220;
/** Captured on main 934a44d (before #371) by running this file there. */
const GOLDEN = '4c931086';

function spawn(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number,
  task: number,
  speed: number,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: task as AntTask,
    subTask: 0,
    speed,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: zone as Zone,
  });
  return id;
}

describe('#371 — pinned V61: the tunnel defenders’ occupancy exemption is unchanged', () => {
  it('six defenders chasing three invaders past a forager move exactly as on main', () => {
    const world = createScenario(7, 'Normal');
    world.simVersion = V61;
    world.spider = null;
    world.aiState = [];
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const e = colony.entrances.find((en) => en.isOpen)!;
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    for (let y = 0; y <= 3; y++) ugSet(grid, e.surfaceTileX, y, UndergroundTileState.Open);
    for (let x = e.surfaceTileX - 14; x <= e.surfaceTileX + 14; x++) {
      ugSet(grid, x, 3, UndergroundTileState.Open);
    }
    colony.digFlowFieldDirty = true;
    const defenders: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = spawn(
        world,
        PLAYER_COLONY_ID,
        e.surfaceTileX + 2,
        e.surfaceTileY,
        Zone.Surface,
        AntTask.Fighting,
        WORKER_BASE_SPEED,
      );
      colony.workers.push(id);
      colony.workerCount += 1;
      defenders.push(id);
    }
    colony.targetRatio.fight = 6;
    colony.rallyPoint = { tileX: e.surfaceTileX, tileY: e.surfaceTileY };
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const others: number[] = [];
    for (let t = 0; t < 150; t++) tick(world, []);
    // A forager nestmate in the tunnel, and three invaders along it.
    const forager = spawn(
      world,
      PLAYER_COLONY_ID,
      e.surfaceTileX + 4,
      3,
      Zone.Underground,
      AntTask.Foraging,
      WORKER_BASE_SPEED,
    );
    world.ants.currentGridColonyId[forager] = PLAYER_COLONY_ID;
    colony.workers.push(forager);
    colony.workerCount += 1;
    others.push(forager);
    for (const x of [e.surfaceTileX + 6, e.surfaceTileX + 9, e.surfaceTileX + 12]) {
      const id = spawn(world, ENEMY_COLONY_ID, x, 3, Zone.Underground, AntTask.Fighting, 0);
      world.ants.hp[id] = 1000;
      world.ants.currentGridColonyId[id] = PLAYER_COLONY_ID;
      enemy.workers.push(id);
      enemy.workerCount += 1;
      others.push(id);
    }
    enemy.rallyPoint = { tileX: e.surfaceTileX, tileY: e.surfaceTileY };

    // FNV-1a over every tracked ant's tile and zone, every tick.
    let h = 0x811c9dc5;
    const mix = (v: number): void => {
      h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
    };
    let chasingByNestmate = 0;
    const all = [...defenders, ...others];
    for (let t = 0; t < TICKS; t++) {
      tick(world, []);
      for (const id of all) {
        mix(world.ants.posX[id]! >> FP_SHIFT);
        mix(world.ants.posY[id]! >> FP_SHIFT);
        mix(world.ants.zone[id]!);
        mix(world.ants.alive[id]!);
      }
      for (const d of defenders) {
        if (world.ants.alive[d] !== 1 || !defenderChasesInvader(world, d)) continue;
        const dx = world.ants.posX[d]! >> FP_SHIFT;
        const dy = world.ants.posY[d]! >> FP_SHIFT;
        if (
          all.some(
            (o) =>
              o !== d &&
              world.ants.alive[o] === 1 &&
              world.ants.colonyId[o] === PLAYER_COLONY_ID &&
              world.ants.zone[o] === Zone.Underground &&
              Math.abs((world.ants.posX[o]! >> FP_SHIFT) - dx) +
                Math.abs((world.ants.posY[o]! >> FP_SHIFT) - dy) <=
                1,
          )
        ) {
          chasingByNestmate += 1;
        }
      }
    }
    expect(chasingByNestmate, 'a defender chases an invader beside a nestmate').toBeGreaterThan(0);
    expect(h.toString(16)).toBe(GOLDEN);
  }, 60_000);
});
