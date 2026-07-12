// save-flee-column.test.ts — #209 PR A (V34): save-shape for the new
// `fleeShelterUntilTick` ant SoA column.
//
// Proves the column round-trips serialize→deserialize AND is OPTIONAL-on-load:
// a pre-V34 in-window save (MIN_ACCEPTED..V33) predates the column, so it is
// absent and every ant loads with the -1 ("not fleeing") default — MIN_ACCEPTED
// stays put, so those saves keep loading.

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import {
  LATEST_SIM_VERSION,
  SIM_VERSION_V34_IDLE_RESERVE_FLEE,
  allocateEntityId,
} from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { tick } from '../sim/tick.js';
import { tickIdleReserveAndFlee } from '../sim/ant/idle-reserve.js';
import { AntTask, ForagingSubState, PheromoneType } from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import { pheromoneGridKey, phSet } from '../sim/pheromone/pheromone-store.js';
import {
  FLEE_THRESHOLD,
  PLAYER_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  COMBAT_HP_BASE,
} from '../sim/constants.js';

const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/** Blanket a colony's surface DangerTrail over a square (0 clears it). */
function seedDanger(
  world: WorldState,
  cx: number,
  cy: number,
  radius: number,
  value: number,
): void {
  const grid =
    world.pheromoneGrids[pheromoneGridKey(PLAYER_COLONY_ID, PheromoneType.DangerTrail, 'surface')]!;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) phSet(grid, cx + dx, cy + dy, value);
  }
}

describe('#209 PR A — fleeShelterUntilTick save column', () => {
  it('the flee column ships from V34 onward (LATEST is at least V34)', () => {
    // The flee feature landed in V34; later versions (e.g. PR C's V35) keep it.
    // Version-agnostic so a later LATEST bump doesn't spuriously fail this PR A test.
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V34_IDLE_RESERVE_FLEE);
    expect(createScenario(42).simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V34_IDLE_RESERVE_FLEE);
  });

  it('round-trips distinct flee/shelter phases through serialize→deserialize', () => {
    const w = createScenario(42);
    // Stamp three representative phases onto live ant slots: -1, 0, a tick value.
    w.ants.fleeShelterUntilTick[0] = -1;
    w.ants.fleeShelterUntilTick[1] = 0;
    w.ants.fleeShelterUntilTick[2] = 9321;
    const restored = deserializeWorldState(serializeWorldState(w));
    expect(restored.ants.fleeShelterUntilTick[0]).toBe(-1);
    expect(restored.ants.fleeShelterUntilTick[1]).toBe(0);
    expect(restored.ants.fleeShelterUntilTick[2]).toBe(9321);
  });

  it('is OPTIONAL-on-load: a save lacking the column loads with the -1 default', () => {
    const w = createScenario(42);
    w.ants.fleeShelterUntilTick[3] = 555; // would be lost — the column is dropped below
    const s = serializeWorldState(w);
    // Simulate a pre-V34 save: strip the column entirely.
    delete (s.ants as { fleeShelterUntilTick?: number[] }).fleeShelterUntilTick;
    const restored = deserializeWorldState(s);
    // Every ant defaults to -1 (not fleeing); no throw on the missing column.
    for (let i = 0; i < restored.nextEntityId; i++) {
      expect(restored.ants.fleeShelterUntilTick[i]).toBe(-1);
    }
  });

  it('rejects an out-of-range flee value (validation guard)', () => {
    const w = createScenario(42);
    const s = serializeWorldState(w);
    s.ants.fleeShelterUntilTick![0] = -2; // only -1, 0, or >=0 are valid
    expect(() => deserializeWorldState(s)).toThrow(/fleeShelterUntilTick/);
  });

  it('a SURFACE homebound hold (phase>0, zone Surface) round-trips and re-arms/resumes', () => {
    // The zone-disambiguated `>0` meaning (Surface = homebound hold, not
    // underground shelter) must survive a save/load: a positive value already
    // round-trips, and the restored world must keep treating a surface-held
    // homebound forager as held while no entrance is safe, then dash once one is.
    // (The retry hold is re-evaluated when `tick >= phase`; the test pokes phase
    // down to the current tick to fire that re-eval without a top-level tick
    // write — nested ants[] writes are the sim's own state, set here as fixture.)
    const w = createScenario(42);
    w.spider = null;
    // Advance the clock a few ticks so the surface hold (phase = tick+1) can be
    // re-evaluated after restore (the re-eval fires on tick >= phase, and a fresh
    // scenario starts at tick 0). Base ticks touch no worker we care about.
    for (let t = 0; t < 5; t++) tick(w, []);
    const colony = w.colonies[PLAYER_COLONY_ID]!;
    const ent = colony.entrances.find((e) => e.isOpen)!;
    const id = allocateEntityId(w);
    initAnt(w.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX: center(ent.surfaceTileX + 2),
      posY: center(ent.surfaceTileY),
      task: AntTask.Foraging,
      subTask: ForagingSubState.ReturningToNest,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      hp: COMBAT_HP_BASE,
      zone: Zone.Surface,
    });
    colony.workers.push(id);
    w.ants.fleeShelterUntilTick[id] = w.tick + 1; // surface hold

    const restored = deserializeWorldState(serializeWorldState(w));
    expect(restored.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0); // hold survived
    expect(restored.ants.zone[id]).toBe(Zone.Surface);

    // While the sole entrance stays camped, the restored machine re-arms the hold.
    seedDanger(restored, ent.surfaceTileX, ent.surfaceTileY, 3, FLEE_THRESHOLD * 4);
    restored.ants.fleeShelterUntilTick[id] = restored.tick; // elapse the timer → re-eval fires
    tickIdleReserveAndFlee(restored);
    expect(restored.ants.fleeShelterUntilTick[id]).toBeGreaterThan(restored.tick); // re-armed, still held

    // Clear the danger → the entrance is safe → the hold resumes into a dash.
    seedDanger(restored, ent.surfaceTileX, ent.surfaceTileY, 3, 0);
    restored.ants.fleeShelterUntilTick[id] = restored.tick; // elapse again
    tickIdleReserveAndFlee(restored);
    expect(restored.ants.fleeShelterUntilTick[id]).toBe(0); // dashing
  });
});
