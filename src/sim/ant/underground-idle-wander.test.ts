// underground-idle-wander.test.ts — #209 PR C (V35): idle underground reserve wander.
//
// Idle UNDERGROUND workers (PR A's surface-only milling left them motionless) take a
// gentle deterministic one-tile wander so a food-saturated colony's surplus de-clumps.
// The wander is CONFINED to occupancy-EXEMPT chamber footprints: moving idle ants
// through non-exempt tiles bumps productive foragers/diggers via
// resolveSameColonyOccupancy (a ~44% economy drag), so idle ants only wander when both
// their current tile AND the target are inside a chamber; idle ants elsewhere (tunnels)
// hold. Idle ants at the shaft row ALWAYS clear + ascend to the surface reserve.
// Reuses targetPosX/Y (no new save field); V35-gated.
//
// Covers: chamber-confined wander target + step, de-clump, tunnel/tunnel-adjacent HOLD,
// shaft-row ALWAYS clears + ascends, the pre-V35 byte gate (absolute), passability +
// blocked-mid-window, the shelter-release V35 target-clear, exclusions, LATEST === V35.

import { describe, it, expect } from 'vitest';
import { createScenario } from '../scenario.js';
import { allocateEntityId, copyWorldState } from '../types.js';
import {
  LATEST_SIM_VERSION,
  SIM_VERSION_V34_IDLE_RESERVE_FLEE,
  SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER,
} from '../types.js';
import type { WorldState } from '../types.js';
import { AntTask, ChamberType } from '../enums.js';
import { Zone, UndergroundTileState, ugSet, type UndergroundGrid } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { IDLE_MILL_RETARGET_SHIFT, PLAYER_COLONY_ID, COMBAT_HP_BASE } from '../constants.js';
import { initAnt } from './ant-store.js';
import { tickIdleReserveAndFlee } from './idle-reserve.js';
import { tickAntMovement } from './ant-movement.js';
import { createDigFlowFields } from '../dig-system.js';
import { Rng } from '../rng.js';

const SEED = 4242;
const BUCKET = 1 << IDLE_MILL_RETARGET_SHIFT; // 64
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);
const tileOf = (fp: number): number => fp >> FP_SHIFT;

/** The player colony's underground grid (exists in a scenario world). */
function ug(world: WorldState): UndergroundGrid {
  return world.undergroundGrids[PLAYER_COLONY_ID]!;
}

/** Carve an inclusive rectangle of Open tiles (no chamber record). */
function carveOpen(grid: UndergroundGrid, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) ugSet(grid, x, y, UndergroundTileState.Open);
}

/**
 * Carve a `w × h` CHAMBER at top-left tile (ax, ay): Open tiles + a ChamberRecord
 * (occupancy-exempt footprint). Only posX/posY/width/height matter to the wander.
 */
function carveChamber(world: WorldState, ax: number, ay: number, w: number, h: number): void {
  carveOpen(ug(world), ax, ay, ax + w - 1, ay + h - 1);
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  colony.chambers.push({
    chamberId: 900 + colony.chambers.length,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: ax << FP_SHIFT,
    posY: ay << FP_SHIFT,
    width: w,
    height: h,
  });
}

/** Spawn an idle worker UNDERGROUND at (tileX, tileY), registered in colony.workers. */
function spawnUndergroundIdle(world: WorldState, tileX: number, tileY: number): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX: center(tileX),
    posY: center(tileY),
    task: AntTask.Idle,
    speed: FP_ONE,
    hp: COMBAT_HP_BASE,
    zone: Zone.Underground,
  });
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

const move = (world: WorldState, t: number): void =>
  tickAntMovement(world, new Rng(t), createDigFlowFields());

// ---------------------------------------------------------------------------
describe('underground idle wander — chamber-confined target (#209 PR C)', () => {
  it('an idle worker INSIDE a chamber gets an in-chamber cardinal-neighbour target', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0; // bucket boundary → fresh pick
    carveChamber(world, 18, 4, 5, 5); // chamber tiles (18..22, 4..8)
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    const tx = tileOf(world.ants.targetPosX[id]!);
    const ty = tileOf(world.ants.targetPosY[id]!);
    expect(world.ants.targetPosX[id]).not.toBe(-1);
    expect(Math.abs(tx - 20) + Math.abs(ty - 6)).toBe(1); // one cardinal step
    expect(ty).not.toBe(0); // never the shaft row
    expect(tx).toBeGreaterThanOrEqual(18); // inside the chamber footprint
    expect(tx).toBeLessThan(23);
    expect(ty).toBeGreaterThanOrEqual(4);
    expect(ty).toBeLessThan(9);
  });

  it('steps toward the in-chamber wander target on a divisor tick', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 18, 4, 5, 5);
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    const target = {
      x: tileOf(world.ants.targetPosX[id]!),
      y: tileOf(world.ants.targetPosY[id]!),
    };
    const before =
      Math.abs(tileOf(world.ants.posX[id]!) - target.x) +
      Math.abs(tileOf(world.ants.posY[id]!) - target.y);
    move(world, 0);
    const after =
      Math.abs(tileOf(world.ants.posX[id]!) - target.x) +
      Math.abs(tileOf(world.ants.posY[id]!) - target.y);
    expect(after).toBeLessThan(before);
  });

  it('de-clumps: co-located idle workers in a chamber get >1 distinct target', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 16, 4, 9, 5);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(spawnUndergroundIdle(world, 20, 6));
    tickIdleReserveAndFlee(world);
    const targets = new Set(
      ids.map((id) => `${world.ants.targetPosX[id]},${world.ants.targetPosY[id]}`),
    );
    expect(targets.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
describe('underground idle wander — chamber CONFINEMENT (#209 PR C, the drag fix)', () => {
  it('an idle worker in a TUNNEL (no chamber) HOLDS — never wanders into non-exempt tiles', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveOpen(ug(world), 18, 4, 22, 8); // open, but NOT a chamber
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(-1); // current tile not in a chamber → hold
  });

  it('an idle worker in a tunnel ADJACENT to a chamber HOLDS (no bumping transition move)', () => {
    // Codex round 10: confining only the target leaks a tunnel→chamber transition move
    // (the ant occupies the non-exempt tunnel during it). Requiring the CURRENT tile
    // in-chamber too closes it: a tunnel-adjacent idle ant holds.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 20, 4, 3, 3); // chamber (20..22, 4..6)
    carveOpen(ug(world), 20, 7, 20, 7); // a tunnel tile just below the chamber
    const id = spawnUndergroundIdle(world, 20, 7); // in the tunnel, adjacent to chamber tile (20,6)
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(-1); // current not in chamber → hold (no step up)
  });

  it('never picks an out-of-chamber neighbour (target stays inside the footprint)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    // A 1-wide vertical chamber; the E/W neighbours are open tunnel but NOT chamber.
    carveChamber(world, 20, 4, 1, 5); // chamber (20, 4..8)
    carveOpen(ug(world), 19, 6, 21, 6); // open E/W of (20,6) but outside the chamber
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    if (world.ants.targetPosX[id] !== -1) {
      expect(tileOf(world.ants.targetPosX[id]!)).toBe(20); // only the in-chamber N/S column
    }
  });

  it('over a long run the wanderer NEVER leaves the chamber footprint (no non-exempt tile)', () => {
    // Structural proof of confinement over time: drive 15b + movement across several
    // retarget buckets and assert the ant's tile stays inside the chamber every tick.
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    const ax = 16;
    const ay = 4;
    const w = 7;
    const h = 7;
    carveChamber(world, ax, ay, w, h);
    const id = spawnUndergroundIdle(world, ax + 3, ay + 3);
    for (let t = 0; t < 300; t++) {
      world.tick = t;
      tickIdleReserveAndFlee(world);
      move(world, t);
      const tx = tileOf(world.ants.posX[id]!);
      const ty = tileOf(world.ants.posY[id]!);
      expect(tx).toBeGreaterThanOrEqual(ax);
      expect(tx).toBeLessThan(ax + w);
      expect(ty).toBeGreaterThanOrEqual(ay);
      expect(ty).toBeLessThan(ay + h);
      expect(world.ants.zone[id]).toBe(Zone.Underground); // never ascends from deep in-chamber
    }
  });
});

// ---------------------------------------------------------------------------
describe('underground idle wander — passability + drift (#209 PR C)', () => {
  it('an in-chamber worker with no enterable in-chamber neighbour clears + holds', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 20, 6, 1, 1); // a 1×1 chamber — no in-chamber neighbour
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('a target that goes Solid mid-window is revalidated and cleared on the next step', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    const grid = ug(world);
    carveChamber(world, 18, 4, 5, 5);
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    const tx = tileOf(world.ants.targetPosX[id]!);
    const ty = tileOf(world.ants.targetPosY[id]!);
    expect(world.ants.targetPosX[id]).not.toBe(-1);
    ugSet(grid, tx, ty, UndergroundTileState.Solid); // a digger digs the target tile
    move(world, 0);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('holds its target across a mid-window tick (no directional re-pick until the bucket boundary)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 16, 2, 9, 9);
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world); // fresh pick at bucket boundary
    const t0 = `${world.ants.targetPosX[id]},${world.ants.targetPosY[id]}`;
    world.tick = 1; // mid-window
    tickIdleReserveAndFlee(world);
    expect(`${world.ants.targetPosX[id]},${world.ants.targetPosY[id]}`).toBe(t0);
  });
});

// ---------------------------------------------------------------------------
describe('underground idle wander — shaft row ALWAYS clears + ascends (#209 PR C)', () => {
  // Codex round 12: with chamber confinement the old "preserve a local (x,1) target"
  // exception leaks (an (x,1) step lands on the non-exempt shaft tunnel). Shaft-row is
  // now unconditional clear + ascend for EVERY target state.
  function shaftSetup(world: WorldState): { id: number; ex: number } {
    const ent = world.colonies[PLAYER_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
    carveOpen(ug(world), ent.surfaceTileX, 0, ent.surfaceTileX, 2); // ensure the shaft is Open
    const id = spawnUndergroundIdle(world, ent.surfaceTileX, 0);
    return { id, ex: ent.surfaceTileX };
  }

  const VARIANTS = [
    { label: 'no target', set: (_w: WorldState, _id: number, _ex: number) => undefined },
    {
      label: 'a stale DISTANT target',
      set: (w: WorldState, id: number, _ex: number) => {
        w.ants.targetPosX[id] = center(60);
        w.ants.targetPosY[id] = center(30);
      },
    },
    {
      label: 'a local (x,1) target',
      set: (w: WorldState, id: number, ex: number) => {
        w.ants.targetPosX[id] = center(ex);
        w.ants.targetPosY[id] = center(1);
      },
    },
  ];

  for (const variant of VARIANTS) {
    it(`a V35 idle worker at the shaft with ${variant.label} clears its target and ASCENDS`, () => {
      const world = createScenario(SEED);
      world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
      world.tick = 0;
      const { id, ex } = shaftSetup(world);
      variant.set(world, id, ex);
      tickIdleReserveAndFlee(world);
      expect(world.ants.targetPosX[id]).toBe(-1); // unconditionally cleared
      move(world, 0);
      expect(world.ants.zone[id]).toBe(Zone.Surface); // ascended, not captured
    });
  }
});

// ---------------------------------------------------------------------------
describe('underground idle wander — byte gate + round-trip (#209 PR C)', () => {
  it('is INERT at V34 across the target-writing path AND movement (absolute, deep in-chamber)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE; // pre-V35
    carveChamber(world, 16, 2, 9, 9);
    const id = spawnUndergroundIdle(world, 20, 6); // DEEP (tileY 6), in a chamber
    world.ants.targetPosX[id] = center(21); // a stray VALID target
    world.ants.targetPosY[id] = center(6);
    const px = world.ants.posX[id]!;
    const py = world.ants.posY[id]!;
    const tpx = world.ants.targetPosX[id];
    const tpy = world.ants.targetPosY[id];
    for (const t of [0, BUCKET, 2 * BUCKET, 3 * BUCKET]) {
      world.tick = t;
      tickIdleReserveAndFlee(world);
      move(world, t);
    }
    expect(world.ants.posX[id]).toBe(px);
    expect(world.ants.posY[id]).toBe(py);
    expect(world.ants.targetPosX[id]).toBe(tpx);
    expect(world.ants.targetPosY[id]).toBe(tpy);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
  });

  it('is ACTIVE at V35 for the same setup (behavioural delta proves the gate)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 16, 2, 9, 9);
    const id = spawnUndergroundIdle(world, 20, 6);
    const px = world.ants.posX[id]!;
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).not.toBe(-1);
    move(world, 0);
    expect(world.ants.posX[id] !== px || world.ants.posY[id] !== center(6)).toBe(true);
  });

  it('LATEST_SIM_VERSION is V35 and new scenarios start there', () => {
    expect(LATEST_SIM_VERSION).toBe(SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER);
    expect(createScenario(42).simVersion).toBe(SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER);
  });

  it('targetPosX/Y wander target round-trips through copyWorldState (no new column)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 18, 4, 5, 5);
    const id = spawnUndergroundIdle(world, 20, 6);
    tickIdleReserveAndFlee(world);
    const tx = world.ants.targetPosX[id]!;
    const ty = world.ants.targetPosY[id]!;
    const copy = createScenario(SEED);
    copyWorldState(world, copy);
    expect(copy.ants.targetPosX[id]).toBe(tx);
    expect(copy.ants.targetPosY[id]).toBe(ty);
  });
});

// ---------------------------------------------------------------------------
describe('underground idle wander — exclusions (#209 PR C)', () => {
  it('a sheltering (phase > 0) underground ant gets no wander target', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 18, 4, 5, 5);
    const id = spawnUndergroundIdle(world, 20, 6);
    world.ants.fleeShelterUntilTick[id] = 100; // sheltering
    world.ants.targetPosX[id] = -1;
    world.ants.targetPosY[id] = -1;
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('a non-Idle underground worker (Digging) gets no wander target', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    world.tick = 0;
    carveChamber(world, 18, 4, 5, 5);
    const id = spawnUndergroundIdle(world, 20, 6);
    world.ants.task[id] = AntTask.Digging;
    world.ants.targetPosX[id] = -1;
    world.ants.targetPosY[id] = -1;
    tickIdleReserveAndFlee(world);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
describe('shelter-release V35 target-clear (#209 PR C, byte-gated)', () => {
  function setupSheltered(world: WorldState): number {
    const ent = world.colonies[PLAYER_COLONY_ID]!.entrances.find((e) => e.isOpen)!;
    carveOpen(ug(world), ent.surfaceTileX, 0, ent.surfaceTileX, 2);
    const id = spawnUndergroundIdle(world, ent.surfaceTileX, 0);
    world.ants.fleeShelterUntilTick[id] = 100;
    world.ants.targetPosX[id] = center(ent.surfaceTileX); // stale camped-flee surface target
    world.ants.targetPosY[id] = center(ent.surfaceTileY);
    world.tick = 200; // past the cooldown → poke head out (all-clear)
    return id;
  }

  it('V35: resume clears the stale surface target (ant not captured underground)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER;
    const id = setupSheltered(world);
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    expect(world.ants.targetPosX[id]).toBe(-1);
  });

  it('V34: resume leaves the serialized target UNCHANGED (byte identity)', () => {
    const world = createScenario(SEED);
    world.simVersion = SIM_VERSION_V34_IDLE_RESERVE_FLEE;
    const id = setupSheltered(world);
    const tpx = world.ants.targetPosX[id]!;
    const tpy = world.ants.targetPosY[id]!;
    tickIdleReserveAndFlee(world);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    expect(world.ants.targetPosX[id]).toBe(tpx);
    expect(world.ants.targetPosY[id]).toBe(tpy);
  });
});
