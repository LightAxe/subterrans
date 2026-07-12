// idle-reserve-flee.test.ts — #209 PR A (V34): surface idle reserve + flee.
//
// Covers pickNearestOpenEntrance, the flee state machine (enter / safe-entrance
// gate / dash → shelter → poke-head-out / fallbacks), idle-reserve milling, the
// cross-colony kill alarm, the V33-vs-V34 byte gate, the copyWorldState
// round-trip, and the backpressure-untouched regression. Save-format round-trip
// + optional-on-load default live in platform/save-flee-column.test.ts.

import { describe, it, expect } from 'vitest';
import { createScenario } from '../scenario.js';
import { tick } from '../tick.js';
import { copyWorldState, allocateEntityId } from '../types.js';
import { SIM_VERSION_V33_OCCUPANCY_CENTER, SIM_VERSION_V34_IDLE_RESERVE_FLEE } from '../types.js';
import type { WorldState } from '../types.js';
import { pickNearestOpenEntrance, type NestEntrance } from '../colony/entrance.js';
import { pheromoneGridKey, phSet, phGet } from '../pheromone/pheromone-store.js';
import { PheromoneType, AntTask, ForagingSubState } from '../enums.js';
import { Zone } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import {
  FLEE_THRESHOLD,
  SHELTER_COOLDOWN_TICKS,
  IDLE_MILL_RADIUS,
  KILL_ALARM_DANGER_DEPOSIT,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  COMBAT_HP_BASE,
} from '../constants.js';
import { initAnt } from './ant-store.js';
import { killAnt } from '../combat.js';
import { colonyForageBackpressure } from '../colony/colony-system.js';
import { tickIdleReserveAndFlee } from './idle-reserve.js';
import { tickAntMovement } from './ant-movement.js';
import { createDigFlowFields } from '../dig-system.js';
import { Rng } from '../rng.js';

const SEED = 4242;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/** First open entrance of a colony in a scenario world. */
function openEntrance(world: WorldState, colonyId: number): NestEntrance {
  const ent = world.colonies[colonyId]!.entrances.find((e) => e.isOpen);
  if (ent === undefined) throw new Error('scenario colony has no open entrance');
  return ent;
}

/** Spawn a controlled adult worker on the surface, registered in colony.workers. */
function spawnWorker(
  world: WorldState,
  colonyId: number,
  tileX: number,
  tileY: number,
  task: number,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: center(tileX),
    posY: center(tileY),
    task,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    hp: COMBAT_HP_BASE,
    zone: Zone.Surface,
  });
  const colony = world.colonies[colonyId]!;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

/** Seed a uniform DangerTrail value across a small square on a colony's surface grid. */
function seedDanger(
  world: WorldState,
  colonyId: number,
  cx: number,
  cy: number,
  radius: number,
  value: number,
): void {
  const grid =
    world.pheromoneGrids[pheromoneGridKey(colonyId, PheromoneType.DangerTrail, 'surface')]!;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      phSet(grid, cx + dx, cy + dy, value);
    }
  }
}

// ---------------------------------------------------------------------------
describe('pickNearestOpenEntrance (#209 PR A)', () => {
  const E = (entranceId: number, x: number, y: number, isOpen: boolean): NestEntrance => ({
    entranceId,
    surfaceTileX: x,
    surfaceTileY: y,
    isOpen,
  });

  it('returns null for an empty list', () => {
    expect(pickNearestOpenEntrance([], 0, 0)).toBeNull();
  });

  it('returns null when every entrance is closed (open-only)', () => {
    expect(pickNearestOpenEntrance([E(0, 1, 1, false), E(1, 2, 2, false)], 0, 0)).toBeNull();
  });

  it('skips a nearer CLOSED entrance in favour of a farther open one', () => {
    const open = E(1, 20, 0, true);
    // The (1,0) closed entrance is far nearer, but flee must never target it.
    expect(pickNearestOpenEntrance([E(0, 1, 0, false), open], 0, 0)).toBe(open);
  });

  it('picks the nearest open entrance by Manhattan distance', () => {
    const near = E(0, 3, 0, true);
    const far = E(1, 10, 0, true);
    expect(pickNearestOpenEntrance([far, near], 0, 0)).toBe(near);
  });

  it('breaks a distance tie by lower entranceId', () => {
    const hi = E(5, 4, 0, true); // dist 4 from origin
    const lo = E(2, 0, 4, true); // dist 4 from origin
    expect(pickNearestOpenEntrance([hi, lo], 0, 0)).toBe(lo);
  });
});

// ---------------------------------------------------------------------------
describe('flee — enter / safe-entrance gate (#209 PR A)', () => {
  it('a surface worker in danger flees toward a SAFE entrance (phase 0)', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    // Worker two tiles from the entrance; danger on the worker, entrance kept safe.
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      0,
      FLEE_THRESHOLD * 4,
    );
    tick(world, []);
    expect(world.ants.fleeShelterUntilTick[id]).not.toBe(-1);
  });

  it('flees to a FARTHER SAFE entrance when the nearest open entrance is camped (Codex P2)', () => {
    // Codex P2: a camped nearest entrance must not suppress fleeing when a farther
    // clear entrance exists — the worker routes to the safe one.
    const world = createScenario(SEED);
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const near = openEntrance(world, PLAYER_COLONY_ID);
    const far: NestEntrance = {
      entranceId: 99,
      surfaceTileX: near.surfaceTileX,
      surfaceTileY: near.surfaceTileY + 10,
      isOpen: true,
    };
    colony.entrances.push(far);
    // Worker just past the near entrance; danger blankets the near entrance AND
    // the worker, but the far entrance stays clear.
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY + 2,
      AntTask.Idle,
    );
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY,
      2,
      FLEE_THRESHOLD * 4,
    );
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0); // fled (not suppressed)
    expect(world.ants.targetPosY[id]! >> FP_SHIFT).toBe(far.surfaceTileY); // straight-lines to the SAFE far exit
  });

  it('routes via BFS (no explicit target) when no entrance is camped — even multi-entrance (Codex P2)', () => {
    // Codex P2 follow-up: the multi-source BFS is danger-UNAWARE, so it may only be
    // used when NO open entrance is camped (every BFS destination is then safe).
    // Danger on the worker's tile alone, both entrances clear → flee via BFS
    // (targetPosX stays -1), preserving obstacle-aware routing.
    const world = createScenario(SEED);
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const near = openEntrance(world, PLAYER_COLONY_ID);
    colony.entrances.push({
      entranceId: 99,
      surfaceTileX: near.surfaceTileX,
      surfaceTileY: near.surfaceTileY + 10,
      isOpen: true,
    });
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY + 2,
      AntTask.Idle,
    );
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY + 2,
      0,
      FLEE_THRESHOLD * 4,
    );
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0); // fled
    expect(world.ants.targetPosX[id]).toBe(-1); // no camp → BFS routing, no explicit target
  });

  it('aborting a dash clears the stale straight-line flee target (Codex P2)', () => {
    // Codex P2 follow-up: on abort, the explicit target must be cleared too, or
    // movement (same tick, now phase -1) still follows it.
    const world = createScenario(SEED);
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const near = openEntrance(world, PLAYER_COLONY_ID);
    colony.entrances.push({
      entranceId: 99,
      surfaceTileX: near.surfaceTileX,
      surfaceTileY: near.surfaceTileY + 10,
      isOpen: true,
    });
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY + 2,
      AntTask.Idle,
    );
    // Camp the near entrance → explicit straight-line target to the far one.
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY,
      2,
      FLEE_THRESHOLD * 4,
    );
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0);
    expect(world.ants.targetPosX[id]).not.toBe(-1); // explicit straight-line target
    // All-clear → the dash aborts and the stale target is cleared.
    seedDanger(world, PLAYER_COLONY_ID, near.surfaceTileX, near.surfaceTileY, 4, 0);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1); // aborted
    expect(world.ants.targetPosX[id]).toBe(-1); // stale target cleared
  });

  it('does NOT flee when the only open entrance is itself dangerous (spider camping it)', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    // Danger blankets both the worker AND the entrance — fleeing home would run
    // the worker into the threat, so it must stay put (phase -1).
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    tick(world, []);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
  });

  it('clears a stale mill target when flee is suppressed so the worker holds (not walks into a raid)', () => {
    // Finding 2 (ship-review): on the suppressed-flee path (dangerous/no safe
    // entrance) the mill target must be cleared, else the un-danger-checked mill
    // branch keeps ambling the worker toward the entrance annulus = the threat.
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    // First, with no danger, the worker acquires a mill target.
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).not.toBe(-1);
    // Now danger blankets the worker AND the entrance → flee suppressed; the mill
    // target must be dropped so the worker holds rather than milling into danger.
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 4, FLEE_THRESHOLD * 4);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1); // did not flee
    expect(world.ants.targetPosX[id]).toBe(-1); // mill target cleared → holds
  });

  it('a sheltering worker reassigned off Idle/Foraging abandons the flee (not frozen)', () => {
    // Finding 1 (ship-review): step 10a allocates by task===Idle with no zone
    // check, so an underground sheltering Idle worker can be recruited to
    // Fighting/Nursing/Digging mid-raid. Its stale flee phase must be cleared or
    // the movement `if (fleePhase > 0) continue` freezes the new defender.
    const world = createScenario(SEED);
    world.spider = null;
    const id = spawnWorker(world, PLAYER_COLONY_ID, 30, 60, AntTask.Idle);
    world.ants.zone[id] = Zone.Underground;
    world.ants.fleeShelterUntilTick[id] = world.tick + SHELTER_COOLDOWN_TICKS; // sheltering
    world.ants.task[id] = AntTask.Fighting; // allocator recruited it for the raid
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
  });

  it('does NOT flee below FLEE_THRESHOLD', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      0,
      FLEE_THRESHOLD - 1,
    );
    tick(world, []);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('flee — full lifecycle: dash → shelter → poke head out (#209 PR A)', () => {
  it('flees to the entrance, shelters underground, then resumes on all-clear', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Idle,
    );

    // Threat window: re-seed danger on the worker each tick (entrance stays safe)
    // until the worker dives underground and shelters.
    let sheltered = false;
    for (let t = 0; t < 40 && !sheltered; t++) {
      if (world.ants.zone[id] === Zone.Surface) {
        seedDanger(
          world,
          PLAYER_COLONY_ID,
          world.ants.posX[id]! >> FP_SHIFT,
          world.ants.posY[id]! >> FP_SHIFT,
          0,
          FLEE_THRESHOLD * 8,
        );
      }
      tick(world, []);
      if (world.ants.zone[id] === Zone.Underground && world.ants.fleeShelterUntilTick[id]! > 0) {
        sheltered = true;
      }
    }
    expect(sheltered).toBe(true);
    expect(world.ants.zone[id]).toBe(Zone.Underground);

    // All-clear: stop seeding + zero the danger grid, advance past the shelter
    // cooldown; the worker pokes its head out and resumes (phase -1).
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX,
      ent.surfaceTileY,
      IDLE_MILL_RADIUS + 2,
      0,
    );
    let resumed = false;
    for (let t = 0; t < SHELTER_COOLDOWN_TICKS + 20 && !resumed; t++) {
      tick(world, []);
      if (world.ants.fleeShelterUntilTick[id] === -1) resumed = true;
    }
    expect(resumed).toBe(true);
  });

  it('a ReturningToNest empty forager that sheltered can ascend (not stuck underground)', () => {
    // Finding A (ship-review): the V34 flee lets an EMPTY forager descend
    // (needsUnderground: fleePhase===0, any subTask). A ReturningToNest forager
    // (over-leash, heading home) that flees + shelters emerges underground with
    // subTask=ReturningToNest, foodCarrying=0; the ascent gate must admit it or it
    // is stranded at the shaft forever. Place it post-all-clear at the shaft and
    // assert movement ascends it.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    world.ants.foodCarrying[id] = 0;
    world.ants.zone[id] = Zone.Underground;
    world.ants.posX[id] = center(ent.surfaceTileX);
    world.ants.posY[id] = 0; // tileY 0 — the shaft mouth
    world.ants.fleeShelterUntilTick[id] = -1; // all-clear
    let ascended = false;
    for (let t = 0; t < 10 && !ascended; t++) {
      tickAntMovement(world, new Rng(t), createDigFlowFields());
      if (world.ants.zone[id] === Zone.Surface) ascended = true;
    }
    expect(ascended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('idle-reserve milling (#209 PR A)', () => {
  it('an idle surface worker gets a mill target inside the entrance annulus', () => {
    // Call step 15b directly so the worker stays Idle (a full tick() would run
    // allocation first and reassign it to Foraging when the colony needs food).
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 1,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    tickIdleReserveAndFlee(world);
    const tx = world.ants.targetPosX[id]! >> FP_SHIFT;
    const ty = world.ants.targetPosY[id]! >> FP_SHIFT;
    expect(world.ants.targetPosX[id]).not.toBe(-1);
    expect(Math.abs(tx - ent.surfaceTileX)).toBeLessThanOrEqual(IDLE_MILL_RADIUS);
    expect(Math.abs(ty - ent.surfaceTileY)).toBeLessThanOrEqual(IDLE_MILL_RADIUS);
  });

  it('does NOT mill toward a dangerous entrance (no clustering next to the threat)', () => {
    // Finding B (ship-review): setMillTarget must be symmetric with the flee-entry
    // guard — never aim the annulus at a camped entrance. The worker's own tile is
    // safe (danger < threshold, so it does not flee), but its nearest open entrance
    // is dangerous, so it must hold (cleared target) rather than amble toward it.
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 3,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 1, FLEE_THRESHOLD * 4);
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('brood (eggs) never mill or flee — step 15b iterates workers[] only', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    // An egg entity: allocated + registered in colony.eggs, NOT workers[].
    const eggId = allocateEntityId(world);
    initAnt(world.ants, eggId, {
      colonyId: PLAYER_COLONY_ID,
      posX: center(ent.surfaceTileX + 1),
      posY: center(ent.surfaceTileY),
      task: AntTask.Idle,
      zone: Zone.Surface,
    });
    world.colonies[PLAYER_COLONY_ID]!.eggs.push(eggId);
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 1,
      ent.surfaceTileY,
      2,
      FLEE_THRESHOLD * 4,
    );
    tick(world, []);
    expect(world.ants.fleeShelterUntilTick[eggId]).toBe(-1);
    expect(world.ants.targetPosX[eggId]).toBe(-1);
  });

  it('de-clumps a frozen cluster: co-located idle workers get distinct mill targets', () => {
    // The #209 report is a 16-ant cluster frozen on one tile. Milling keys the
    // wander on antId, so independent workers pick different tiles and disperse.
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        spawnWorker(world, PLAYER_COLONY_ID, ent.surfaceTileX + 1, ent.surfaceTileY, AntTask.Idle),
      );
    }
    tickIdleReserveAndFlee(world);
    const targets = new Set(
      ids.map((id) => `${world.ants.targetPosX[id]},${world.ants.targetPosY[id]}`),
    );
    expect(targets.size).toBeGreaterThan(1); // not all pinned to the same tile
  });

  it('entrance closes mid-flight → the dashing worker aborts deterministically', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 3,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    // Enter the dash: danger on the worker, entrance safe.
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 3,
      ent.surfaceTileY,
      0,
      FLEE_THRESHOLD * 4,
    );
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0); // dashing
    // Close every entrance while still on the surface; next step 15b aborts (no
    // open entrance to dive into) rather than dashing forever.
    for (const e of world.colonies[PLAYER_COLONY_ID]!.entrances) e.isOpen = false;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
  });

  it('no open entrance → idle worker stays put (no mill target, no pour-out)', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (const e of colony.entrances) e.isOpen = false; // seal every entrance
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      colony.entrances[0]!.surfaceTileX + 1,
      colony.entrances[0]!.surfaceTileY,
      AntTask.Idle,
    );
    tick(world, []);
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('grid-guard (#209 PR A)', () => {
  it('a world with no pheromone grids never crashes and never flees', () => {
    const world = createScenario(SEED);
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 1,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    world.pheromoneGrids = {}; // bare world — danger reads as 0 everywhere
    expect(() => tick(world, [])).not.toThrow();
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('cross-colony kill alarm (#209 PR A)', () => {
  const dangerAt = (world: WorldState, colonyId: number, x: number, y: number): number =>
    phGet(
      world.pheromoneGrids[pheromoneGridKey(colonyId, PheromoneType.DangerTrail, 'surface')]!,
      x,
      y,
    );

  it('an enemy ant killing a surface worker seeds danger on the VICTIM grid', () => {
    const world = createScenario(SEED);
    const vx = 40;
    const vy = 60;
    const victim = spawnWorker(world, PLAYER_COLONY_ID, vx, vy, AntTask.Foraging);
    killAnt(world, victim, ENEMY_COLONY_ID, 999, 'Ant');
    expect(dangerAt(world, PLAYER_COLONY_ID, vx, vy)).toBe(KILL_ALARM_DANGER_DEPOSIT);
  });

  it('a SAME-colony kill does not alarm', () => {
    const world = createScenario(SEED);
    const vx = 41;
    const vy = 61;
    const victim = spawnWorker(world, PLAYER_COLONY_ID, vx, vy, AntTask.Foraging);
    killAnt(world, victim, PLAYER_COLONY_ID, 998, 'Ant');
    expect(dangerAt(world, PLAYER_COLONY_ID, vx, vy)).toBe(0);
  });

  it('a spider kill does not alarm (killerKind !== Ant)', () => {
    const world = createScenario(SEED);
    const vx = 42;
    const vy = 62;
    const victim = spawnWorker(world, PLAYER_COLONY_ID, vx, vy, AntTask.Foraging);
    killAnt(world, victim, null, null, 'Spider');
    expect(dangerAt(world, PLAYER_COLONY_ID, vx, vy)).toBe(0);
  });

  it('a FIGHTER victim does not alarm (task === Fighting)', () => {
    const world = createScenario(SEED);
    const vx = 43;
    const vy = 63;
    const victim = spawnWorker(world, PLAYER_COLONY_ID, vx, vy, AntTask.Fighting);
    killAnt(world, victim, ENEMY_COLONY_ID, 997, 'Ant');
    expect(dangerAt(world, PLAYER_COLONY_ID, vx, vy)).toBe(0);
  });

  it('an UNDERGROUND victim does not alarm (surface-only)', () => {
    const world = createScenario(SEED);
    const vx = 44;
    const vy = 20;
    const victim = spawnWorker(world, PLAYER_COLONY_ID, vx, vy, AntTask.Foraging);
    world.ants.zone[victim] = Zone.Underground;
    killAnt(world, victim, ENEMY_COLONY_ID, 996, 'Ant');
    expect(dangerAt(world, PLAYER_COLONY_ID, vx, vy)).toBe(0);
  });

  it('is inert at V33 (no alarm before the gate)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V33_OCCUPANCY_CENTER;
    const vx = 45;
    const vy = 64;
    const victim = spawnWorker(world, PLAYER_COLONY_ID, vx, vy, AntTask.Foraging);
    killAnt(world, victim, ENEMY_COLONY_ID, 995, 'Ant');
    expect(dangerAt(world, PLAYER_COLONY_ID, vx, vy)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('byte gate + round-trip (#209 PR A)', () => {
  it('flee is INERT at V33 and ACTIVE at V34 for the same setup', () => {
    for (const [simVersion, expectFlee] of [
      [SIM_VERSION_V33_OCCUPANCY_CENTER, false],
      [SIM_VERSION_V34_IDLE_RESERVE_FLEE, true],
    ] as const) {
      const world = createScenario(SEED);
      world.simVersion = simVersion;
      world.spider = null;
      const ent = openEntrance(world, PLAYER_COLONY_ID);
      const id = spawnWorker(
        world,
        PLAYER_COLONY_ID,
        ent.surfaceTileX + 2,
        ent.surfaceTileY,
        AntTask.Idle,
      );
      seedDanger(
        world,
        PLAYER_COLONY_ID,
        ent.surfaceTileX + 2,
        ent.surfaceTileY,
        0,
        FLEE_THRESHOLD * 4,
      );
      tick(world, []);
      expect(world.ants.fleeShelterUntilTick[id] !== -1).toBe(expectFlee);
    }
  });

  it('idle-mill movement is V34-gated: a pre-V34 Idle ant with a target holds', () => {
    // Regression for the ship-review advisory: the mill branch is guarded on
    // `fleePhase === -1`, which is ALSO true on pre-V34 worlds — so it must ALSO
    // check simVersion, or a pre-V34 replay with a surface Idle ant carrying a
    // stray target would step (base main holds) — a byte-identity divergence.
    // Drive tickAntMovement directly so allocation/step-15b don't intervene.
    for (const [simVersion, expectMove] of [
      [SIM_VERSION_V33_OCCUPANCY_CENTER, false],
      [SIM_VERSION_V34_IDLE_RESERVE_FLEE, true],
    ] as const) {
      const world = createScenario(SEED);
      world.simVersion = simVersion;
      world.spider = null;
      const id = spawnWorker(world, PLAYER_COLONY_ID, 30, 60, AntTask.Idle);
      // A stray in-bounds surface target 3 tiles east (posFpSentinel-valid on load).
      world.ants.targetPosX[id] = center(33);
      world.ants.targetPosY[id] = center(60);
      const before = world.ants.posX[id]!;
      tickAntMovement(world, new Rng(1), createDigFlowFields());
      expect(world.ants.posX[id]! !== before).toBe(expectMove);
    }
  });

  it('fleeShelterUntilTick round-trips through copyWorldState', () => {
    const world = createScenario(SEED);
    const id = spawnWorker(world, PLAYER_COLONY_ID, 30, 60, AntTask.Idle);
    world.ants.fleeShelterUntilTick[id] = 777;
    const copy = createScenario(SEED);
    copyWorldState(world, copy);
    expect(copy.ants.fleeShelterUntilTick[id]).toBe(777);
  });
});

// ---------------------------------------------------------------------------
describe('backpressure regression — allocation untouched (#209 PR A)', () => {
  it('a saturated colony still reports forage backpressure at V34', () => {
    // The reserve/flee behaviour is a movement layer over already-idle ants; it
    // must never touch the nurse/forage/dig/fight allocation. Proven by: the
    // backpressure predicate is unchanged whether or not step 15b ran.
    const world = createScenario(SEED);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    // Spawn idle surface reserve workers near the entrance so step 15b runs on them.
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    for (let i = 0; i < 6; i++) {
      spawnWorker(
        world,
        PLAYER_COLONY_ID,
        ent.surfaceTileX + 1 + i,
        ent.surfaceTileY,
        AntTask.Idle,
      );
    }
    const before = colonyForageBackpressure(colony);
    for (let t = 0; t < 30; t++) tick(world, []);
    // Whatever backpressure was, step 15b did not flip idle workers into Foraging
    // via the allocation path — the reserve stays idle-or-milling, re-assignable.
    expect(colonyForageBackpressure(colony)).toBe(before);
  });
});
