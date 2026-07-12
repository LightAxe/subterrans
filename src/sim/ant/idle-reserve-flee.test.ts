// idle-reserve-flee.test.ts — #209 PR A (V34): surface idle reserve + flee.
//
// Covers pickOpenEntranceAtColumn, the flee state machine (enter / safe-entrance
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
import { pickOpenEntranceAtColumn, type NestEntrance } from '../colony/entrance.js';
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
import { initAnt, pushRecentTile } from './ant-store.js';
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
describe('pickOpenEntranceAtColumn (#209 PR A)', () => {
  // Selects the OPEN entrance an ant sheltering at a shaft column ascends through
  // — the first open entrance with surfaceTileX === column, mirroring the ascent
  // in ant-movement.ts. NOT nearest-by-distance (that would sample a different
  // column's entrance the ant never uses — Codex P2).
  const E = (entranceId: number, x: number, y: number, isOpen: boolean): NestEntrance => ({
    entranceId,
    surfaceTileX: x,
    surfaceTileY: y,
    isOpen,
  });

  it('returns null for an empty list', () => {
    expect(pickOpenEntranceAtColumn([], 5)).toBeNull();
  });

  it('returns null when the column has no entrance at all', () => {
    expect(pickOpenEntranceAtColumn([E(0, 1, 0, true), E(1, 9, 3, true)], 5)).toBeNull();
  });

  it('returns null when the only entrance at the column is closed (cannot ascend)', () => {
    expect(pickOpenEntranceAtColumn([E(0, 5, 0, false)], 5)).toBeNull();
  });

  it('returns the OPEN entrance at the column, ignoring other columns', () => {
    const atCol = E(1, 5, 12, true);
    // A nearer-by-Manhattan entrance at a DIFFERENT column must be ignored — the
    // ant ascends only through its own column.
    expect(pickOpenEntranceAtColumn([E(0, 6, 0, true), atCol], 5)).toBe(atCol);
  });

  it('picks the FIRST open entrance at the column (matches ascent order)', () => {
    const first = E(0, 5, 8, true);
    const second = E(1, 5, 20, true);
    expect(pickOpenEntranceAtColumn([first, second], 5)).toBe(first);
  });

  it('skips a closed entrance at the column in favour of an open one at the same column', () => {
    const open = E(1, 5, 20, true);
    expect(pickOpenEntranceAtColumn([E(0, 5, 8, false), open], 5)).toBe(open);
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
describe('flee — homebound-forager surface hold (#209 PR A, Codex P2)', () => {
  // A homebound forager (carrying food / ReturningToNest) with NO safe entrance
  // must NOT be handed back to the normal danger-unaware dispatcher (which routes
  // it into a camped sole entrance). It holds in place — fleeShelterUntilTick > 0
  // on the SURFACE (zone disambiguates it from underground sheltering) — and
  // re-evaluates each tick until an entrance clears (dash) or it stops being
  // homebound (release).

  const HOMEBOUND = [
    { label: 'CarryingFood', subTask: ForagingSubState.CarryingFood, food: FP_ONE },
    { label: 'ReturningToNest (empty)', subTask: ForagingSubState.ReturningToNest, food: 0 },
  ] as const;

  for (const v of HOMEBOUND) {
    it(`holds a ${v.label} forager in place when every entrance is dangerous (direct step 15b)`, () => {
      const world = createScenario(SEED);
      world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
      world.spider = null;
      const ent = openEntrance(world, PLAYER_COLONY_ID);
      const id = spawnWorker(
        world,
        PLAYER_COLONY_ID,
        ent.surfaceTileX + 2,
        ent.surfaceTileY,
        AntTask.Foraging,
      );
      world.ants.subTask[id] = v.subTask;
      world.ants.foodCarrying[id] = v.food;
      world.ants.speed[id] = FP_ONE;
      // Danger blankets the worker AND the sole open entrance → no safe entrance.
      seedDanger(
        world,
        PLAYER_COLONY_ID,
        ent.surfaceTileX,
        ent.surfaceTileY,
        3,
        FLEE_THRESHOLD * 4,
      );
      const startX = world.ants.posX[id]!;
      const startY = world.ants.posY[id]!;
      tickIdleReserveAndFlee(world);
      expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0); // surface hold, not -1
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      // Movement then FREEZES it (fleePhase > 0): no step into the camped entrance.
      tickAntMovement(world, new Rng(1), createDigFlowFields());
      expect(world.ants.posX[id]).toBe(startX);
      expect(world.ants.posY[id]).toBe(startY);
    });
  }

  it('the hold survives a full tick for a CarryingFood forager (step-order guard)', () => {
    // Codex round 1: the excursion boundary runs before step 15b and can flip an
    // empty ReturningToNest ant to SearchingFood if food signals exist. A
    // CarryingFood carrier (foodCarrying > 0) is stable across a whole tick, so
    // use it to prove the hold is not defeated by step ordering. No food signals
    // are seeded, so nothing pulls the carrier off its homebound state.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.CarryingFood;
    world.ants.foodCarrying[id] = FP_ONE;
    world.ants.speed[id] = FP_ONE;
    const startX = world.ants.posX[id]!;
    const startY = world.ants.posY[id]!;
    // Re-seed danger each tick (it decays) so the entrance stays camped.
    for (let t = 0; t < 3; t++) {
      seedDanger(
        world,
        PLAYER_COLONY_ID,
        ent.surfaceTileX,
        ent.surfaceTileY,
        3,
        FLEE_THRESHOLD * 8,
      );
      tick(world, []);
    }
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0); // still held
    expect(world.ants.zone[id]).toBe(Zone.Surface); // never walked into the entrance
    expect(world.ants.posX[id]).toBe(startX);
    expect(world.ants.posY[id]).toBe(startY);
  });

  it('a phase-0 homebound dasher whose OWN tile is safe but last entrance went dangerous enters the hold (not -1)', () => {
    // The behavioral delta vs the old code: with the dasher's own tile decayed
    // below threshold and no safe entrance left, the old non-homebound path
    // released to -1 (handing it back to the camped-entrance dispatcher); the
    // homebound path must instead drop into the surface hold.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    world.ants.fleeShelterUntilTick[id] = 0; // already dashing
    // Camp the entrance (radius 1) but leave the worker's own tile (+2) SAFE.
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 1, FLEE_THRESHOLD * 4);
    expect(
      phGet(
        world.pheromoneGrids[
          pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.DangerTrail, 'surface')
        ]!,
        ent.surfaceTileX + 2,
        ent.surfaceTileY,
      ),
    ).toBeLessThan(FLEE_THRESHOLD); // own tile safe
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(0); // held, not released to -1
  });

  it('re-arms while unsafe, then dashes toward the entrance once it clears', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    world.ants.speed[id] = FP_ONE;
    // Camp worker + entrance → enter the hold.
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0);
    // Next tick, still camped → re-arm (stays > 0).
    world.tick += 1;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0);
    // Clear the danger → the entrance is safe → transition to a dash (phase 0).
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, 0);
    world.tick += 1;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0); // dashing
    // Movement steps it TOWARD the selected safe entrance (Manhattan distance drops).
    const distBefore =
      Math.abs((world.ants.posX[id]! >> FP_SHIFT) - ent.surfaceTileX) +
      Math.abs((world.ants.posY[id]! >> FP_SHIFT) - ent.surfaceTileY);
    tickAntMovement(world, new Rng(1), createDigFlowFields());
    const distAfter =
      Math.abs((world.ants.posX[id]! >> FP_SHIFT) - ent.surfaceTileX) +
      Math.abs((world.ants.posY[id]! >> FP_SHIFT) - ent.surfaceTileY);
    expect(distAfter).toBeLessThan(distBefore);
  });

  it('a surface-held worker that flips to SearchingFood releases to -1 (no longer homebound)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0); // held
    // The forager stops heading home (breakout back to searching).
    world.ants.subTask[id] = ForagingSubState.SearchingFood;
    world.tick += 1;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1); // released
  });

  it('a SearchingFood forager with no safe entrance is NOT held — it keeps foraging (v1 exception)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.SearchingFood; // outward, not homebound
    world.ants.foodCarrying[id] = 0;
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1); // no hold; keeps its own dispatch
  });

  it('the suppressed-flee path PRESERVES a SearchingFood forager’s spider-scatter target (ship-review advisory)', () => {
    // A SearchingFood forager (not homebound) on a danger tile with no safe
    // entrance must NOT have its target cleared: step 13e (spider scatter) may
    // have written an away-from-reticle target this tick, and clearing it would
    // revert the forager to scent-wander back toward the threat. Only Idle
    // workers get the target cleared (they need -1 to hold). Symmetric with
    // setMillTarget's reticle-preservation guard.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const forager = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[forager] = ForagingSubState.SearchingFood;
    world.ants.foodCarrying[forager] = 0;
    // Simulate step 13e having written an away-from-reticle scatter target.
    const scatterX = center(ent.surfaceTileX + 6);
    const scatterY = center(ent.surfaceTileY);
    world.ants.targetPosX[forager] = scatterX;
    world.ants.targetPosY[forager] = scatterY;
    // Danger blankets the worker AND the sole entrance → suppressed flee.
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    // An Idle worker in the SAME situation, to prove the asymmetry.
    const idle = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 1,
      ent.surfaceTileY,
      AntTask.Idle,
    );
    world.ants.targetPosX[idle] = center(ent.surfaceTileX + 6);
    world.ants.targetPosY[idle] = center(ent.surfaceTileY);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[forager]).toBe(-1); // not held
    expect(world.ants.targetPosX[forager]).toBe(scatterX); // scatter target preserved
    expect(world.ants.targetPosY[forager]).toBe(scatterY);
    expect(world.ants.targetPosX[idle]).toBe(-1); // Idle worker's target IS cleared (holds)
  });

  it('a phase-0 homebound dasher whose own tile danger decays STAYS dashing (entrance still safe)', () => {
    // Entrance safety — not the worker's own tile — governs a homebound dasher.
    // With its own tile safe AND a safe entrance present, the old non-homebound
    // path would have released to -1; the homebound path keeps dashing (phase 0)
    // so normal routing can't re-aim it at a camped entrance.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    world.ants.fleeShelterUntilTick[id] = 0; // dashing
    // No danger anywhere: own tile safe, entrance safe.
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0); // still dashing, NOT released to -1
  });

  it('a held homebound forager reassigned to Fighting abandons the hold (top guard)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX + 2,
      ent.surfaceTileY,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    seedDanger(world, PLAYER_COLONY_ID, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0); // held
    world.ants.task[id] = AntTask.Fighting; // allocator recruited it
    world.tick += 1;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1); // hold abandoned; free to fight
  });

  it('descends at an INTERMEDIATE own open entrance en route and shelters (intentional; Codex round 2)', () => {
    // A phase-0 dasher with an explicit farther-safe target that crosses a
    // DIFFERENT own open entrance descends THERE — descent is not gated to the
    // selected target. This is correct: the spider threat is surface-only, so an
    // earlier shaft is a strictly safer exit. The poke-head-out then re-arms
    // while the surface above the shaft stays dangerous, rather than resuming.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const near = openEntrance(world, PLAYER_COLONY_ID); // the intermediate entrance (real shaft)
    const far: NestEntrance = {
      entranceId: 99,
      surfaceTileX: near.surfaceTileX,
      surfaceTileY: near.surfaceTileY + 10, // the "selected safe" target, farther along +Y
      isOpen: true,
    };
    colony.entrances.push(far);
    // Worker ONE tile before `near` on the straight-line path to `far`, so a
    // single dash step lands it ON the intermediate entrance and the post-move
    // descent fires there (descent uses the ant's own column shaft, which `near`
    // genuinely owns — `far` shares the column purely to keep the dash collinear).
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY - 1,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.ReturningToNest;
    world.ants.speed[id] = FP_ONE; // whole-tile step → lands exactly on `near`
    world.ants.fleeShelterUntilTick[id] = 0;
    world.ants.targetPosX[id] = center(far.surfaceTileX);
    world.ants.targetPosY[id] = center(far.surfaceTileY);
    tickAntMovement(world, new Rng(1), createDigFlowFields());
    expect(world.ants.zone[id]).toBe(Zone.Underground); // descended at the intermediate shaft
    const shelterUntil = world.ants.fleeShelterUntilTick[id];
    expect(shelterUntil).toBeGreaterThan(0); // now sheltering, not still dashing
    // Surface above the shaft stays dangerous → poke head out re-arms, not -1.
    seedDanger(
      world,
      PLAYER_COLONY_ID,
      near.surfaceTileX,
      near.surfaceTileY,
      1,
      FLEE_THRESHOLD * 4,
    );
    world.tick = shelterUntil + 1; // past the cooldown
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(world.tick); // re-armed
  });
});

// ---------------------------------------------------------------------------
describe('flee — no-revisit bypass (Codex P2)', () => {
  // A fleeing SearchingFood forager's step toward shelter must NOT be diverted by
  // the generic recent-tiles anti-backtrack filter (returning toward the entrance
  // commonly steps onto just-vacated tiles). The bypass is gated to an active V34
  // surface flee, so ordinary foraging anti-oscillation is unchanged.

  /** Set up a SearchingFood forager 2 tiles below `ent`, with the entrance-ward tile recent. */
  function setupForager(world: WorldState, ent: NestEntrance): number {
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      ent.surfaceTileX,
      ent.surfaceTileY + 2,
      AntTask.Foraging,
    );
    world.ants.subTask[id] = ForagingSubState.SearchingFood;
    world.ants.speed[id] = FP_ONE; // whole-tile step so a crossing is observable
    // The immediately entrance-ward tile is recently visited.
    pushRecentTile(world.ants, id, ent.surfaceTileX, ent.surfaceTileY + 1);
    return id;
  }

  it('a fleeing SearchingFood forager steps toward shelter despite the recent tile (explicit-target route)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = setupForager(world, ent);
    // Explicit-target flee dash straight at the entrance (the multi-entrance
    // camped-nearest route writes exactly this).
    world.ants.fleeShelterUntilTick[id] = 0;
    world.ants.targetPosX[id] = center(ent.surfaceTileX);
    world.ants.targetPosY[id] = center(ent.surfaceTileY);
    const startTileY = world.ants.posY[id]! >> FP_SHIFT;
    tickAntMovement(world, new Rng(1), createDigFlowFields());
    // Without the bypass the no-revisit filter would divert the step sideways
    // (tileY unchanged); with it the ant steps onto the recent entrance-ward tile.
    expect(world.ants.posY[id]! >> FP_SHIFT).toBeLessThan(startTileY);
  });

  it('a NON-fleeing SearchingFood forager is unaffected — the bypass is pinned to flee (V33 gate)', () => {
    // Same explicit setup but pre-V34: fleePhase is inert, so the flee-dash never
    // runs and bypassRecentTiles === targetedStep (false here). The ant does NOT
    // get the emergency straight-line-to-shelter treatment.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V33_OCCUPANCY_CENTER;
    world.spider = null;
    const ent = openEntrance(world, PLAYER_COLONY_ID);
    const id = setupForager(world, ent);
    world.ants.fleeShelterUntilTick[id] = 0; // inert at V33
    const startTileY = world.ants.posY[id]! >> FP_SHIFT;
    tickAntMovement(world, new Rng(1), createDigFlowFields());
    // No V34 flee dash → the ant forages normally and does NOT beeline toward the
    // entrance (tileY does not decrease); the emergency bypass is V34-flee-gated.
    expect(world.ants.posY[id]! >> FP_SHIFT).not.toBeLessThan(startTileY);
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

  it('a sheltering worker with NO open entrance stays sheltered (does not resume into a stuck state)', () => {
    // Advisory (b): if all entrances closed while sheltering, "poke head out" must
    // NOT resume (which would surface the ant to the allocator as a mobile-but-
    // immobile reserve) — re-arm the cooldown instead; it recovers when an
    // entrance reopens.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (const e of colony.entrances) e.isOpen = false; // no open entrance
    const id = spawnWorker(world, PLAYER_COLONY_ID, 40, 20, AntTask.Idle);
    world.ants.zone[id] = Zone.Underground;
    world.ants.fleeShelterUntilTick[id] = 100; // sheltering until tick 100
    world.tick = 200; // past the cooldown → poke head out fires
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(200 + SHELTER_COOLDOWN_TICKS); // re-armed, not -1
  });

  it('poke-head-out samples the ant’s OWN shaft-column entrance, not a nearer safe one in another column (Codex P2)', () => {
    // Codex P2: the ascent matches by surfaceTileX, so the poke-head-out must
    // sample DangerTrail at the entrance in the ant's shaft column — the one it
    // will actually emerge through. A Manhattan-nearest entrance in a DIFFERENT
    // column could be safe while the ant's own column entrance is still camped;
    // releasing on the wrong entrance surfaces the worker straight into danger.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const own = openEntrance(world, PLAYER_COLONY_ID); // the ant's column (24, 64)
    // A DIFFERENT-column entrance that is nearer to the shaft mouth (col, 0) by
    // Manhattan distance but which the ant can never ascend through.
    colony.entrances.push({
      entranceId: 99,
      surfaceTileX: own.surfaceTileX + 2,
      surfaceTileY: own.surfaceTileY - 40, // much nearer to y=0 → the old buggy pick
      isOpen: true,
    });
    // Shelter an ant at the OWN column; camp only the own-column surface tile,
    // leaving the other-column entrance clear.
    const id = spawnWorker(
      world,
      PLAYER_COLONY_ID,
      own.surfaceTileX,
      own.surfaceTileY,
      AntTask.Idle,
    );
    world.ants.zone[id] = Zone.Underground;
    world.ants.posX[id] = center(own.surfaceTileX); // shaft column
    world.ants.posY[id] = 0;
    world.ants.fleeShelterUntilTick[id] = 100;
    seedDanger(world, PLAYER_COLONY_ID, own.surfaceTileX, own.surfaceTileY, 1, FLEE_THRESHOLD * 4);
    world.tick = 200; // past the cooldown → poke head out fires
    tickIdleReserveAndFlee(world);
    // Own column still camped → STAY sheltered (must NOT release off the safe
    // other-column entrance).
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(world.tick);
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

  it('milling preserves the spider-scatter target when inside the reticle radius (advisory a)', () => {
    // Advisory (a): step 15b runs after spider-scatter (step 13e). An idle worker
    // within SPIDER_SCATTER_RADIUS_TILES of the reticle must keep the away-target
    // scatter wrote, not have it overwritten by a mill-toward-entrance target.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    world.spider = null;
    const id = spawnWorker(world, PLAYER_COLONY_ID, 40, 60, AntTask.Idle);
    // Simulate step 13e having written an away-from-reticle target for this worker.
    const scatterX = center(45);
    const scatterY = center(60);
    world.ants.targetPosX[id] = scatterX;
    world.ants.targetPosY[id] = scatterY;
    world.scatterReticleTile = { x: 40, y: 60 }; // reticle on the worker's tile
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(scatterX); // scatter target preserved
    expect(world.ants.targetPosY[id]).toBe(scatterY);
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
