// queens — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-queens.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import { tickAntMovement } from './ant-system.js';
import { createWorldState, allocateEntityId } from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { AntTask, ChamberType } from '../enums.js';
import { Rng } from '../rng.js';
import { WORKER_BASE_SPEED, QUEEN_EGG_INTERVAL_TICKS } from '../constants.js';
import { FP_SHIFT } from '../fixed.js';
import { Zone, UndergroundTileState, ugSet, createUndergroundGrid } from '../terrain.js';
import { createDigFlowFields } from '../dig-system.js';
import {
  createChamberFlowFields,
  ensureChamberFlowFields,
  computeChamberFlowField,
} from '../chamber-flow.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from '../colony/colony-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;

const MAX_TEST_ENTITIES = 64;

// ---------------------------------------------------------------------------
// P1 queen relocation — seed936214196-tick2401 debug-snapshot fix.
// tickAntMovement drives moveQueens for every alive queen; these tests pin
// that contract: no Queen chamber → hold; already home → hold; underground
// transit consumes queen flow-field; Solid dirt is never traversed; surface
// queen descends through nearest open entrance.
// ---------------------------------------------------------------------------

describe('tickAntMovement — P1 queen relocation', () => {
  /**
   * Build a world with a 16×16 all-Open underground grid, one colony whose
   * queen is entity 0 placed at (queenTileX, queenTileY) in the chosen zone.
   * The Queen chamber and chamber flow-field are added only if requested.
   */
  function setupQueenWorld(params: {
    queenTileX: number;
    queenTileY: number;
    zone?: number;
    addQueenChamber?: boolean;
    queenChamberTileX?: number;
    queenChamberTileY?: number;
    queenChamberWidth?: number;
    queenChamberHeight?: number;
    addEntrance?: { tileX: number; tileY: number; isOpen: boolean } | null;
    computeQueenField?: boolean;
    ugWidth?: number;
    ugHeight?: number;
  }): {
    world: WorldState;
    colony: ColonyRecord;
    chamberFlowFields: ReturnType<typeof createChamberFlowFields>;
    queenId: number;
  } {
    const ugWidth = params.ugWidth ?? 16;
    const ugHeight = params.ugHeight ?? 16;
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // All-Open underground grid so underground movement is unconstrained by default.
    const underground = createUndergroundGrid(ugWidth, ugHeight);
    for (let y = 0; y < ugHeight; y++) {
      for (let x = 0; x < ugWidth; x++) {
        ugSet(underground, x, y, UndergroundTileState.Open);
      }
    }
    world.undergroundGrids[COLONY_ID] = underground;

    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: COLONY_ID,
      // Tile-aligned (no half-tile offset) so a single WORKER_BASE_SPEED step
      // (FP_ONE / 2) reliably crosses the tile boundary in tests that assert
      // tile-index deltas.
      posX: params.queenTileX << FP_SHIFT,
      posY: params.queenTileY << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      zone: params.zone ?? Zone.Underground,
    });
    colony.queenEntityId = queenId;

    if (params.addQueenChamber) {
      colony.chambers.push({
        chamberId: 500,
        chamberType: ChamberType.Queen,
        foodStored: 0,
        posX: (params.queenChamberTileX ?? 2) << FP_SHIFT,
        posY: (params.queenChamberTileY ?? 2) << FP_SHIFT,
        width: params.queenChamberWidth ?? 2,
        height: params.queenChamberHeight ?? 2,
      });
    }

    if (params.addEntrance) {
      colony.entrances.push({
        entranceId: 1,
        surfaceTileX: params.addEntrance.tileX,
        surfaceTileY: params.addEntrance.tileY,
        isOpen: params.addEntrance.isOpen,
      });
    }

    const chamberFlowFields = createChamberFlowFields();
    if (params.computeQueenField) {
      const bufs = ensureChamberFlowFields(chamberFlowFields, COLONY_ID, ugWidth * ugHeight);
      computeChamberFlowField(
        underground,
        colony.chambers,
        [ChamberType.Queen],
        bufs.queen,
        bufs.queue,
      );
    }

    return { world, colony, chamberFlowFields, queenId };
  }

  it('Q-1. no Queen chamber → queen holds in place (any starting tile is home)', () => {
    const { world, queenId } = setupQueenWorld({
      queenTileX: 5,
      queenTileY: 5,
      addQueenChamber: false,
    });
    const beforeX = world.ants.posX[queenId]!;
    const beforeY = world.ants.posY[queenId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[queenId]).toBe(beforeX);
    expect(world.ants.posY[queenId]).toBe(beforeY);
  });

  it('Q-2. queen inside Queen chamber footprint → wanders toward a chamber Open tile (Issue #16)', () => {
    // Queen at (3,3). 2×2 chamber footprint = {(2,2),(3,2),(2,3),(3,3)}. The
    // wander targets a non-self tile each cycle, so the queen must move and
    // stay inside the footprint. We deliberately avoid pinning the exact
    // direction here — Q-2c covers "visits every tile" and Q-2b pins the
    // cadence; this case only asserts the bug fix's user-facing claim:
    // "she does not sit motionless on her arrival corner."
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 3,
      queenTileY: 3, // inside chamber (2,2)-(3,3)
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      queenChamberWidth: 2,
      queenChamberHeight: 2,
      computeQueenField: true,
    });
    const beforeX = world.ants.posX[queenId]!;
    const beforeY = world.ants.posY[queenId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    const afterX = world.ants.posX[queenId]!;
    const afterY = world.ants.posY[queenId]!;
    // She moved (wander step is always one Manhattan dimension at speed 128 fp).
    expect(afterX !== beforeX || afterY !== beforeY).toBe(true);
    // She stayed inside the chamber footprint (no dirt-cut, no escape).
    const afterTileX = afterX >> FP_SHIFT;
    const afterTileY = afterY >> FP_SHIFT;
    expect(afterTileX).toBeGreaterThanOrEqual(2);
    expect(afterTileX).toBeLessThanOrEqual(3);
    expect(afterTileY).toBeGreaterThanOrEqual(2);
    expect(afterTileY).toBeLessThanOrEqual(3);
  });

  it('Q-2b. wander target advances every QUEEN_EGG_INTERVAL_TICKS (Issue #16)', () => {
    // Same fixture as Q-2. At tick=0 the target is chamber Open tile index 0
    // = (2,2). After advancing tick by QUEEN_EGG_INTERVAL_TICKS the target
    // index becomes 1 = (3,2). The queen, having had ample time to reach
    // (2,2), now drifts back toward (3,2). This pins the cadence contract:
    // the wander cycle is tied to the egg-laying interval.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 2,
      queenTileY: 2, // already at cycle-0 target
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      queenChamberWidth: 2,
      queenChamberHeight: 2,
      computeQueenField: true,
    });
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    // Cycle 0: she's already at target (2,2) → holds.
    const t0X = world.ants.posX[queenId]!;
    const t0Y = world.ants.posY[queenId]!;
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    expect(world.ants.posX[queenId]).toBe(t0X);
    expect(world.ants.posY[queenId]).toBe(t0Y);

    // Mid-cycle: still inside cycle 0 — target must not have advanced. A
    // regression that uses `world.tick % interval` instead of `floor(world.tick
    // / interval)` would compute a different cycleIndex here (150 → a
    // different tile) and the queen would step away from her current tile.
    world.tick = 150; // half of QUEEN_EGG_INTERVAL_TICKS (300)
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    expect(world.ants.posX[queenId]).toBe(t0X);
    expect(world.ants.posY[queenId]).toBe(t0Y);

    // Advance to cycle 1 (target = (3,2)) and verify she now steps east.
    world.tick = QUEEN_EGG_INTERVAL_TICKS;
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    expect(world.ants.posX[queenId]).toBeGreaterThan(t0X);
  });

  it('Q-2c. queen visits every chamber Open tile across one full wander cycle (Issue #16)', () => {
    // 2×2 chamber → 4 Open tiles. Across QUEEN_EGG_INTERVAL_TICKS × 4 ticks,
    // the wander target advances four times and the queen should occupy every
    // tile in the chamber footprint at least once. A regression where the
    // modulo is wrong (e.g. `% 1` collapses every cycle to tile 0, or
    // openCount is computed as width*height including non-Open tiles) would
    // fail by leaving at least one tile unvisited.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 2,
      queenTileY: 2,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      queenChamberWidth: 2,
      queenChamberHeight: 2,
      computeQueenField: true,
    });
    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    const visited = new Set<string>();
    for (let t = 0; t < 4 * QUEEN_EGG_INTERVAL_TICKS; t++) {
      world.tick = t;
      tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
      const tx = world.ants.posX[queenId]! >> FP_SHIFT;
      const ty = world.ants.posY[queenId]! >> FP_SHIFT;
      visited.add(`${tx},${ty}`);
    }
    expect(visited.has('2,2')).toBe(true);
    expect(visited.has('3,2')).toBe(true);
    expect(visited.has('2,3')).toBe(true);
    expect(visited.has('3,3')).toBe(true);
    // She also never escaped the chamber.
    expect(visited.size).toBe(4);
  });

  it('Q-2d. wander counts only Open tiles when the chamber has a Solid corner (Issue #16)', () => {
    // 3×3 chamber footprint with one Solid corner tile (4,2). The wander
    // must count Open tiles (8) — a regression that uses width*height (9)
    // would shift the modulo and miss a tile, or pick the Solid tile and
    // get blocked indefinitely. Run 8 cycles and verify the queen
    // (a) never occupies the Solid tile and (b) visits every Open tile.
    //
    // Solid placed in a corner rather than the chamber center because the
    // queen's Manhattan stepping is not a path-finder: a center Solid tile
    // would force Manhattan paths through it and would expose a separate
    // limitation (no diagonal routing) unrelated to the "count Open tiles"
    // contract under test here.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 2,
      queenTileY: 2,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      queenChamberWidth: 3,
      queenChamberHeight: 3,
      computeQueenField: true,
    });
    const underground = world.undergroundGrids[COLONY_ID]!;
    ugSet(underground, 4, 2, UndergroundTileState.Solid);

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    const visited = new Set<string>();
    for (let t = 0; t < 8 * QUEEN_EGG_INTERVAL_TICKS; t++) {
      world.tick = t;
      tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
      const tx = world.ants.posX[queenId]! >> FP_SHIFT;
      const ty = world.ants.posY[queenId]! >> FP_SHIFT;
      visited.add(`${tx},${ty}`);
    }
    expect(visited.has('4,2')).toBe(false); // never on the Solid tile
    const expectedOpen = ['2,2', '3,2', '2,3', '3,3', '4,3', '2,4', '3,4', '4,4'];
    for (const k of expectedOpen) expect(visited.has(k)).toBe(true);
    expect(visited.size).toBe(expectedOpen.length);
  });

  it('Q-3. underground queen routes toward Queen chamber (flow-field step)', () => {
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 5,
      queenTileY: 5,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      queenChamberWidth: 2,
      queenChamberHeight: 2,
      computeQueenField: true,
    });
    const beforeTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const beforeTileY = world.ants.posY[queenId]! >> FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    const afterTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const afterTileY = world.ants.posY[queenId]! >> FP_SHIFT;
    const beforeDist = Math.abs(beforeTileX - 2) + Math.abs(beforeTileY - 2);
    const afterDist = Math.abs(afterTileX - 2) + Math.abs(afterTileY - 2);
    expect(afterDist).toBeLessThan(beforeDist);
  });

  it('Q-4. queen cannot cut through Solid dirt — blocked boundary holds position', () => {
    // Queen at (5,5). Queen chamber at (2,2)-(3,3). Solidify column 4 (full
    // height) AND row 4 (x ≥ 4) so EVERY NW move from (5,5) is blocked: west
    // (4,5) and north (5,4) are solid; the v4 diagonal target (4,4) is also
    // solid; both diagonal intermediates (4,5) and (5,4) are solid. With no
    // safe step toward (2,2) the queen must hold position.
    //
    // Pre-v4 (cardinal): the row-4 wall is redundant — column 4 alone is
    // enough since Bresenham picks west or north, both blocked. v4 adds the
    // NW diagonal escape via the row-4 wall: without it the queen would
    // legitimately move N along column 5 (corner-cut helper drops X axis
    // when only Y intermediate is open). The expanded wall closes that
    // escape so the test still asserts "cannot cut through dirt".
    const { world, queenId } = setupQueenWorld({
      queenTileX: 5,
      queenTileY: 5,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      queenChamberWidth: 2,
      queenChamberHeight: 2,
      computeQueenField: false, // force Manhattan-fallback path
    });
    const underground = world.undergroundGrids[COLONY_ID]!;
    for (let y = 0; y < underground.height; y++) {
      ugSet(underground, 4, y, UndergroundTileState.Solid);
    }
    for (let x = 4; x < underground.width; x++) {
      ugSet(underground, x, 4, UndergroundTileState.Solid);
    }
    const beforeX = world.ants.posX[queenId]!;
    const beforeY = world.ants.posY[queenId]!;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    expect(world.ants.posX[queenId]).toBe(beforeX);
    expect(world.ants.posY[queenId]).toBe(beforeY);
  });

  it('Q-5. surface queen steps toward nearest open entrance (Manhattan)', () => {
    const { world, queenId } = setupQueenWorld({
      queenTileX: 10,
      queenTileY: 10,
      zone: Zone.Surface,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      computeQueenField: true,
      addEntrance: { tileX: 5, tileY: 10, isOpen: true },
    });
    const beforeTileX = world.ants.posX[queenId]! >> FP_SHIFT;

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    const afterTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    // Manhattan step reduces distance to entrance at (5,10).
    expect(afterTileX).toBeLessThan(beforeTileX);
    // Still on surface — she hasn't reached the entrance yet.
    expect(world.ants.zone[queenId]).toBe(Zone.Surface);
  });

  it('Q-6. surface queen already on the open entrance tile descends on the first tick', () => {
    // Regression for the (dx=0,dy=0) early-return bug: without the pre-move
    // descent short-circuit, the Manhattan step from (5,5) toward an entrance
    // at (5,5) yielded rawDx=rawDy=0, the early return fired, and the
    // Surface→Underground transition never ran — the queen sat on the
    // entrance forever with Gate 6 blocking egg production.
    const { world, chamberFlowFields, queenId } = setupQueenWorld({
      queenTileX: 5,
      queenTileY: 5,
      zone: Zone.Surface,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      computeQueenField: true,
      addEntrance: { tileX: 5, tileY: 5, isOpen: true },
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);

    expect(world.ants.zone[queenId]).toBe(Zone.Underground);
    expect(world.ants.posY[queenId]).toBe(0); // shaft top
    expect(world.ants.posX[queenId]).toBe(5 << FP_SHIFT); // column preserved

    // Second tick: queen flow-field should steer her toward the Queen
    // chamber at (2,2). Distance to (2,2) must strictly decrease.
    const beforeTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const beforeTileY = world.ants.posY[queenId]! >> FP_SHIFT;
    tickAntMovement(world, rng, digFlowFields, undefined, chamberFlowFields);
    const afterTileX = world.ants.posX[queenId]! >> FP_SHIFT;
    const afterTileY = world.ants.posY[queenId]! >> FP_SHIFT;
    const beforeDist = Math.abs(beforeTileX - 2) + Math.abs(beforeTileY - 2);
    const afterDist = Math.abs(afterTileX - 2) + Math.abs(afterTileY - 2);
    expect(afterDist).toBeLessThan(beforeDist);
    expect(world.ants.zone[queenId]).toBe(Zone.Underground); // no surfacing back
  });

  it('Q-7. surface queen does NOT descend through a closed (designated) entrance', () => {
    const { world, queenId } = setupQueenWorld({
      queenTileX: 5,
      queenTileY: 5,
      zone: Zone.Surface,
      addQueenChamber: true,
      queenChamberTileX: 2,
      queenChamberTileY: 2,
      computeQueenField: true,
      addEntrance: { tileX: 5, tileY: 5, isOpen: false },
    });

    const digFlowFields = createDigFlowFields();
    const rng = new Rng(42);
    tickAntMovement(world, rng, digFlowFields);

    // No open entrance → queen stays on the surface (holds, because the
    // Manhattan routing finds no target).
    expect(world.ants.zone[queenId]).toBe(Zone.Surface);
  });
});
