// nursing — split from ant-system.test.ts (issue #243, seam-aligned).
// Behavior tests for ant-nursing.ts, importing through the ./ant-system.js barrel.

import { describe, it, expect } from 'vitest';
import { tickAntMovement, tickNurseActions } from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V9_CANCEL_DROPS_PENDING,
  SIM_VERSION_V10_VISIBLE_BROOD_CARRY,
  SIM_VERSION_V24_NURSERY_CAPACITY,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt } from './ant-store.js';
import { AntTask, ForagingSubState, NursingSubState, ChamberType } from '../enums.js';
import { Rng } from '../rng.js';
import { UNDERGROUND_GRID_WIDTH, UNDERGROUND_GRID_HEIGHT } from '../constants.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Zone, UndergroundTileState, ugSet, createUndergroundGrid } from '../terrain.js';
import { createDigFlowFields } from '../dig-system.js';
import { createEntranceFlowFields } from '../entrance-flow.js';
import {
  createChamberFlowFields,
  ensureChamberFlowFields,
  computeChamberFlowField,
  computeNursingPickupField,
  computeNurseryDepositField,
  NURSERY_CHAMBER_TYPES,
} from '../chamber-flow.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord, ChamberRecord } from '../colony/colony-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;

const MAX_TEST_ENTITIES = 64;

// ---------------------------------------------------------------------------
// Helper: create world with colony + underground grid for dig/zone tests
// ---------------------------------------------------------------------------

function setupWorldWithUnderground(
  ugWidth = 16,
  ugHeight = 16,
): {
  world: WorldState;
  colony: ColonyRecord;
  underground: ReturnType<typeof createUndergroundGrid>;
  colonyId: number;
} {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  const colonyId = COLONY_ID;
  const colony = createColonyRecord(colonyId, 0);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[colonyId] = colony;

  const underground = createUndergroundGrid(ugWidth, ugHeight);
  world.undergroundGrids[colonyId] = underground;

  return { world, colony, underground, colonyId };
}

// ---------------------------------------------------------------------------
// tickNurseActions — 09 reproduction-gate memo: finite nursing
// ---------------------------------------------------------------------------

describe('tickNurseActions', () => {
  /**
   * Minimal world: one colony with queen entity 0, a Nursery chamber at
   * (chamberTileX, chamberTileY) of width×height, and a nursing ant at the
   * given tile. Returns IDs so individual tests can assert per-entity state.
   */
  function setupNursingAnt(params: {
    antTileX: number;
    antTileY: number;
    chamberTileX: number;
    chamberTileY: number;
    chamberWidth?: number;
    chamberHeight?: number;
    chamberType?: ChamberType;
    subTask?: number;
  }): { world: WorldState; antId: number; colony: ColonyRecord } {
    const world = createWorldState(42, 64);
    // Pin to pre-v10 — these tests exercise the legacy
    // MovingToBrood→Feeding-on-chamber-tile flip + teleport. Phase 1.3
    // (#17) replaced that flip under v10+ with a brood-tile pickup, so
    // tests that expect the legacy flip must explicitly run on a pre-v10
    // sim version. v10-specific tests live in their own describe block
    // below and bump simVersion back to LATEST.
    world.simVersion = SIM_VERSION_V9_CANCEL_DROPS_PENDING;
    // Queen (entity 0) — required for createColonyRecord.
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;
    colony.chambers.push({
      chamberId: 100,
      chamberType: params.chamberType ?? ChamberType.Nursery,
      foodStored: 0,
      posX: params.chamberTileX << FP_SHIFT,
      posY: params.chamberTileY << FP_SHIFT,
      width: params.chamberWidth ?? 2,
      height: params.chamberHeight ?? 2,
    });

    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: params.antTileX << FP_SHIFT,
      posY: params.antTileY << FP_SHIFT,
      task: AntTask.Nursing,
      subTask: params.subTask ?? NursingSubState.MovingToBrood,
    });
    return { world, antId, colony };
  }

  it('MovingToBrood on Nursery tile → Feeding (one-tick service begins)', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10,
      antTileY: 10,
      chamberTileX: 10,
      chamberTileY: 10,
    });

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[antId]).toBe(NursingSubState.Feeding);
  });

  it('MovingToBrood on Queen chamber tile → Feeding', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 5,
      antTileY: 7,
      chamberTileX: 4,
      chamberTileY: 6,
      chamberWidth: 3,
      chamberHeight: 3,
      chamberType: ChamberType.Queen,
    });

    tickNurseActions(world);

    expect(world.ants.subTask[antId]).toBe(NursingSubState.Feeding);
  });

  it('Feeding → Idle (released for step 10a reassignment)', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10,
      antTileY: 10,
      chamberTileX: 10,
      chamberTileY: 10,
      subTask: NursingSubState.Feeding,
    });

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('two-tick arc: MovingToBrood on tile → Feeding → Idle', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10,
      antTileY: 10,
      chamberTileX: 10,
      chamberTileY: 10,
    });

    tickNurseActions(world);
    expect(world.ants.subTask[antId]).toBe(NursingSubState.Feeding);

    tickNurseActions(world);
    expect(world.ants.task[antId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[antId]).toBe(0);
  });

  it('dead ant: ignored', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10,
      antTileY: 10,
      chamberTileX: 10,
      chamberTileY: 10,
    });
    world.ants.alive[antId] = 0;

    tickNurseActions(world);

    expect(world.ants.subTask[antId]).toBe(NursingSubState.MovingToBrood);
  });

  it('non-nursing ant: ignored even on chamber tile', () => {
    const { world, antId } = setupNursingAnt({
      antTileX: 10,
      antTileY: 10,
      chamberTileX: 10,
      chamberTileY: 10,
    });
    world.ants.task[antId] = AntTask.Foraging;
    world.ants.subTask[antId] = ForagingSubState.SearchingFood;

    tickNurseActions(world);

    expect(world.ants.task[antId]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[antId]).toBe(ForagingSubState.SearchingFood);
  });
});

// ---------------------------------------------------------------------------
// Issue #17 Phase 1 — nurseDeposit chamber-flow field. Pure-additive: the
// field is allocated alongside food/nursing/queen and seeded from Nursery
// Open tiles only. Consumed by v10+ carrying nurses (subTask=Feeding with
// carryingBroodId set).
// ---------------------------------------------------------------------------

describe('chamber-flow nurseDeposit field (#17 phase 1)', () => {
  /**
   * Build a 16x16 grid with one Nursery (2x2 Open at 6,6) and one Queen
   * chamber (2x2 Open at 10,3), connected by a tunnel. Compute nurseDeposit
   * with NURSERY_CHAMBER_TYPES and assert that Queen tiles do NOT carry a
   * source/-1 marker — only Nursery tiles do.
   */
  it('seeds from Nursery Open tiles only — Queen Open tiles are NOT sources', () => {
    const { underground, colony, colonyId } = setupWorldWithUnderground(16, 16);
    // Nursery (2x2) at (6,6).
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        ugSet(underground, 6 + dx, 6 + dy, UndergroundTileState.Open);
      }
    }
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 6 << FP_SHIFT,
      posY: 6 << FP_SHIFT,
      width: 2,
      height: 2,
    });
    // Queen chamber (2x2) at (10,3).
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        ugSet(underground, 10 + dx, 3 + dy, UndergroundTileState.Open);
      }
    }
    colony.chambers.push({
      chamberId: 2,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 10 << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      width: 2,
      height: 2,
    });
    // Tunnel connecting them so BFS can reach Queen tiles.
    for (let y = 4; y <= 6; y++) ugSet(underground, 8, y, UndergroundTileState.Open);
    for (let x = 7; x <= 10; x++) ugSet(underground, x, 4, UndergroundTileState.Open);

    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeChamberFlowField(
      underground,
      colony.chambers,
      NURSERY_CHAMBER_TYPES,
      bufs.nurseDeposit,
      bufs.queue,
    );

    const W = underground.width;
    // Nursery footprint tiles ARE sources (-1).
    expect(bufs.nurseDeposit[6 * W + 6]).toBe(-1);
    expect(bufs.nurseDeposit[6 * W + 7]).toBe(-1);
    expect(bufs.nurseDeposit[7 * W + 6]).toBe(-1);
    expect(bufs.nurseDeposit[7 * W + 7]).toBe(-1);
    // Queen footprint tiles are NOT sources — they're reachable, so they
    // carry a step direction (0..3), but never -1.
    for (const [qx, qy] of [
      [10, 3],
      [11, 3],
      [10, 4],
      [11, 4],
    ] as const) {
      const v = bufs.nurseDeposit[qy * W + qx]!;
      expect(v).not.toBe(-1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it('with no Nursery chamber, every reachable tile is unreachable (-2) — there is nothing to seed', () => {
    const { underground, colony, colonyId } = setupWorldWithUnderground(16, 16);
    // Open a small region but NO Nursery chamber.
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        ugSet(underground, 5 + dx, 5 + dy, UndergroundTileState.Open);
      }
    }
    // Push a Queen chamber so we prove only the type filter matters.
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      width: 2,
      height: 2,
    });

    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeChamberFlowField(
      underground,
      colony.chambers,
      NURSERY_CHAMBER_TYPES,
      bufs.nurseDeposit,
      bufs.queue,
    );

    // No seeds → every tile stays at -2.
    const W = underground.width;
    for (let y = 5; y < 8; y++) {
      for (let x = 5; x < 8; x++) {
        expect(bufs.nurseDeposit[y * W + x]).toBe(-2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #17 Phase 1 — nursing PICKUP field. Seeds from uncarried-brood
// entity tiles outside Nursery only. The chamber-flow recompute under v10+
// runs this every tick (brood positions move with carriers).
// ---------------------------------------------------------------------------

describe('chamber-flow nursing pickup field (#17 phase 1)', () => {
  it('UAT regression: routes to brood tiles only, NOT to non-egg Queen tiles', () => {
    // The original Phase 1.3 implementation seeded EVERY Queen-chamber Open
    // tile as a source. A 5×3 Queen chamber with 2 eggs would have 15
    // sources, not 2. The BFS routed nurses to whichever Queen tile was
    // geographically closest, often a NON-egg tile — the nurse arrived,
    // found no brood, and finite-nursing-released. She never reached the
    // egg. This test pins the post-fix contract: only brood-entity tiles
    // are sources, so the BFS routes nurses directly to eggs.
    const { world, underground, colony, colonyId } = setupWorldWithUnderground(40, 30);
    // Excavate a Queen chamber at (30..34, 8..10) — 5×3, matching the
    // F9-debug case from UAT.
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 5; dx++) {
        ugSet(underground, 30 + dx, 8 + dy, UndergroundTileState.Open);
      }
    }
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 30 << FP_SHIFT,
      posY: 8 << FP_SHIFT,
      width: 5,
      height: 3,
    });
    // Two eggs in only 2 of the 15 Queen tiles.
    const eggA = allocateEntityId(world);
    initAnt(world.ants, eggA, {
      colonyId,
      posX: (33 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (8 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(eggA);
    const eggB = allocateEntityId(world);
    initAnt(world.ants, eggB, {
      colonyId,
      posX: (30 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (9 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(eggB);

    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeNursingPickupField(
      underground,
      colony.chambers,
      world.ants,
      colony.eggs,
      colony.larvae,
      bufs.nursing,
      bufs.queue,
    );

    const W = underground.width;
    // The two egg tiles ARE sources (-1).
    expect(bufs.nursing[8 * W + 33]).toBe(-1); // eggA
    expect(bufs.nursing[9 * W + 30]).toBe(-1); // eggB
    // Other Queen tiles are NOT sources — they carry a step direction
    // (0..3) routing them toward the nearest egg, never -1.
    const otherQueenTiles: Array<[number, number]> = [
      [30, 8],
      [31, 8],
      [32, 8],
      [34, 8], // row 8 minus eggA
      [31, 9],
      [32, 9],
      [33, 9],
      [34, 9], // row 9 minus eggB
      [30, 10],
      [31, 10],
      [32, 10],
      [33, 10],
      [34, 10], // row 10
    ];
    for (const [tx, ty] of otherQueenTiles) {
      const v = bufs.nursing[ty * W + tx]!;
      expect(v).not.toBe(-1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it('orphan brood outside any chamber is also seeded (carrier-death reclaim path)', () => {
    // Brood dropped at a tunnel tile after a carrier death must still be
    // reachable. The seed loop's "outside Nursery" exclusion covers that.
    const { world, underground, colony, colonyId } = setupWorldWithUnderground(20, 20);
    // Tunnel at (5, 5).
    ugSet(underground, 5, 5, UndergroundTileState.Open);
    // Orphan brood at the tunnel tile.
    const orphan = allocateEntityId(world);
    initAnt(world.ants, orphan, {
      colonyId,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(orphan);

    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeNursingPickupField(
      underground,
      colony.chambers,
      world.ants,
      colony.eggs,
      colony.larvae,
      bufs.nursing,
      bufs.queue,
    );
    expect(bufs.nursing[5 * underground.width + 5]).toBe(-1);
  });

  it('no uncarried brood: field has no sources (all -2)', () => {
    // No brood at all → no seeds → field is all-(-2). Nurses with no work
    // get nowhere; the finite-nursing release fires when they happen to
    // be on a Queen/Nursery tile (allocateWorkers should produce
    // nurseCount=0 in this case, so it's only a defensive concern).
    const { world, underground, colony, colonyId } = setupWorldWithUnderground(16, 16);
    void world;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      width: 2,
      height: 2,
    });
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        ugSet(underground, 5 + dx, 5 + dy, UndergroundTileState.Open);
      }
    }

    const cache = createChamberFlowFields();
    const gridSize = underground.width * underground.height;
    const bufs = ensureChamberFlowFields(cache, colonyId, gridSize);
    computeNursingPickupField(
      underground,
      colony.chambers,
      world.ants,
      colony.eggs,
      colony.larvae,
      bufs.nursing,
      bufs.queue,
    );
    const W = underground.width;
    // Queen tiles previously seeded as -1 by the dropped Seed (1) are
    // now -2 (no sources at all). This is the regression test that
    // would have failed pre-fix.
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        expect(bufs.nursing[(5 + dy) * W + (5 + dx)]).toBe(-2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #17 Phase 1.3 — v10+ tickNurseActions pickup branch.
//
// Under simVersion >= V10, MovingToBrood → Feeding only flips when the nurse
// is standing on a tile with an alive uncarried brood entity. On the flip
// we set carryingBroodId on the nurse and carriedBy on the brood (the
// reverse pointer keeps a second nurse from racing the same brood).
// ---------------------------------------------------------------------------

describe('tickNurseActions — v10+ pickup (#17 phase 1.3)', () => {
  function setupV10NurseAndBroodOnTile(opts: { sameTile: boolean }): {
    world: WorldState;
    nurseId: number;
    broodId: number;
    colony: ColonyRecord;
  } {
    const world = createWorldState(42, 64);
    // LATEST already includes v10; pin explicitly so the test name describes
    // what's under test even when LATEST advances.
    world.simVersion = SIM_VERSION_V10_VISIBLE_BROOD_CARRY;
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;
    // Queen chamber so the brood is in a "natural" location.
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: 5 << FP_SHIFT,
      posY: 5 << FP_SHIFT,
      width: 2,
      height: 2,
    });
    // Nursery chamber — required for v10 pickup gate. Empty space (no
    // Open tiles needed for these unit tests; the gate just requires
    // hasCompletedChamber to return true).
    colony.chambers.push({
      chamberId: 2,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 12 << FP_SHIFT,
      posY: 12 << FP_SHIFT,
      width: 2,
      height: 2,
    });
    // Brood entity (egg) at tile (5, 5).
    const broodId = allocateEntityId(world);
    initAnt(world.ants, broodId, {
      colonyId: COLONY_ID,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(broodId);
    // Nurse — same tile as brood, OR offset depending on sameTile flag.
    const nurseTileX = opts.sameTile ? 5 : 8;
    const nurseTileY = opts.sameTile ? 5 : 8;
    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: (nurseTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (nurseTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    return { world, nurseId, broodId, colony };
  }

  it('on brood tile: claims the brood and flips to Feeding (carry pointer set both ways)', () => {
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: true });
    tickNurseActions(world);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    expect(world.ants.carryingBroodId[nurseId]).toBe(broodId);
    expect(world.ants.carriedBy[broodId]).toBe(nurseId);
  });

  it('off brood tile: stays in MovingToBrood, no carry claimed', () => {
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    tickNurseActions(world);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.MovingToBrood);
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[broodId]).toBe(-1);
  });

  it('two nurses on the same brood tile: only the lower-id nurse claims', () => {
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: true });
    // Add a second nurse on the same tile (higher id than the first by
    // construction — entity ids are monotonic).
    const nurse2 = allocateEntityId(world);
    initAnt(world.ants, nurse2, {
      colonyId: COLONY_ID,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    expect(nurse2).toBeGreaterThan(nurseId); // entity ids are monotonic
    tickNurseActions(world);
    // The lower-id nurse claims; the second is on a Queen-chamber source
    // tile with no claimable brood — releases via Feeding-without-carry
    // (pre-v10 cadence), which the next tick will flip to Idle.
    expect(world.ants.carriedBy[broodId]).toBe(nurseId);
    expect(world.ants.carryingBroodId[nurseId]).toBe(broodId);
    expect(world.ants.carryingBroodId[nurse2]).toBe(-1);
    expect(world.ants.subTask[nurse2]).toBe(NursingSubState.Feeding);
    // Next tick — defensive Feeding-no-carry guard fires → Idle.
    tickNurseActions(world);
    expect(world.ants.task[nurse2]).toBe(AntTask.Idle);
  });

  it('already-carried brood (carrier ALIVE) is not claimed by another nurse', () => {
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: true });
    // Allocate a separate ALIVE ant to be the existing carrier — the
    // dead-carrier exception in findUncarriedBroodOnTile would let the
    // claim through if the carrier weren't alive.
    const otherCarrier = allocateEntityId(world);
    initAnt(world.ants, otherCarrier, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Nursing,
    });
    world.ants.carriedBy[broodId] = otherCarrier;
    tickNurseActions(world);
    // Original nurse is on a Queen-chamber tile with no claimable brood
    // (other carrier is alive). Per finite-nursing: release via Feeding-
    // without-carry (next tick flips to Idle).
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[broodId]).toBe(otherCarrier);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
  });

  it('dead brood is skipped — even on the same tile, no claim happens', () => {
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: true });
    world.ants.alive[broodId] = 0;
    tickNurseActions(world);
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[broodId]).toBe(-1);
    // Nurse on a Queen-chamber tile with only a dead brood → finite-
    // nursing release via Feeding-without-carry.
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
  });

  it('Feeding nurse with no carry slot drops back to Idle (defensive guard)', () => {
    // Reachable via the finite-nursing release path (#56 codex P1) when a
    // nurse arrives at a source tile with no claimable brood — also via
    // state corruption.
    const { world, nurseId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    // Manually force the nurse into Feeding without a carry slot.
    world.ants.subTask[nurseId] = NursingSubState.Feeding;
    world.ants.carryingBroodId[nurseId] = -1;
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[nurseId]).toBe(0);
  });

  it('finite-nursing release: nurse on Queen tile with no claimable brood completes 2-tick MovingToBrood→Feeding→Idle (#56 codex P1)', () => {
    // The release path covers two real-world cases:
    //   (1) No brood anywhere in the colony (brood pool exhausted).
    //   (2) Another nurse claimed the only brood this tick.
    // Without the release, a v10 nurse would strand in MovingToBrood
    // permanently because step 10a only re-allocates Idle workers.
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: true });
    // Mark the brood as already-carried by an alive carrier — the nurse
    // can't claim, so findUncarriedBroodOnTile returns -1.
    const otherCarrier = allocateEntityId(world);
    initAnt(world.ants, otherCarrier, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Nursing,
    });
    world.ants.carriedBy[broodId] = otherCarrier;
    // Tick 1: MovingToBrood → Feeding (release-pending, no carry).
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    // Tick 2: Feeding-no-carry guard → Idle.
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[nurseId]).toBe(0);
  });

  it('finite-nursing: nurse OFF source tile (in tunnel, no brood here) stays in MovingToBrood', () => {
    // Defensive: the release ONLY fires when the nurse is on a Queen-chamber
    // OR Nursery footprint tile — i.e., she has actually arrived at a
    // pickup source. A nurse mid-walk should keep walking.
    const { world, nurseId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    // Helper sets nurse at (8, 8) — far from Queen chamber at (5, 5) and
    // Nursery at (12, 12). Brood sits at (5, 5).
    tickNurseActions(world);
    // No release — nurse keeps walking next tick.
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.MovingToBrood);
  });

  it('finite-nursing colony-level release: nurse mid-tunnel with no claimable brood releases (#56 codex P1 round 2)', () => {
    // The pickup field has zero seeds when no claimable brood exists,
    // so a mid-tunnel nurse can\'t pathfind anywhere. Without the colony-
    // level release, she\'d strand in MovingToBrood forever. The release
    // fires regardless of source-tile status because there\'s no work
    // anywhere — no point in waiting for her to arrive somewhere.
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    // Kill the only brood so the colony has no claimable brood.
    world.ants.alive[broodId] = 0;
    // Tick 1: colony-level check fires → Feeding (release-pending).
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    // Tick 2: Feeding-no-carry guard → Idle.
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
  });

  it('finite-nursing colony-level release: nurse mid-tunnel WITH brood elsewhere keeps walking', () => {
    // Defensive: if brood exists somewhere in the colony, the colony-level
    // release does NOT fire — the nurse keeps walking toward the brood.
    // Only the on-source-tile release applies in that case.
    const { world, nurseId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.MovingToBrood);
  });

  it('finite-nursing: orphan brood on BeingDug tile DOES count as claimable (#56 codex P1 r3)', () => {
    // Codex round 3 P1: a carrier can die on a BeingDug tile, leaving
    // its orphan brood there. The pickup field's seed-tile guard now
    // allows BeingDug (BFS expansion already traverses it). The
    // colonyHasClaimableBrood predicate must agree — otherwise the
    // colony-level release would incorrectly fire even though the
    // pickup field DOES have a source for that orphan, sending a
    // walking nurse back to Idle prematurely.
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    // Set up an underground grid the predicate will read. Mark the
    // brood's tile (5, 5) as BeingDug.
    const ug = createUndergroundGrid(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        ugSet(ug, x, y, UndergroundTileState.Open);
      }
    }
    ugSet(ug, 5, 5, UndergroundTileState.BeingDug);
    world.undergroundGrids[COLONY_ID] = ug;
    // Mark the brood as orphaned (carriedBy points at a dead nurse).
    const deadCarrier = allocateEntityId(world);
    initAnt(world.ants, deadCarrier, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Nursing,
    });
    world.ants.alive[deadCarrier] = 0;
    world.ants.carriedBy[broodId] = deadCarrier;
    tickNurseActions(world);
    // Nurse keeps walking — colony-level release does NOT fire because
    // the BeingDug-tile orphan is a valid pickup source.
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.MovingToBrood);
  });

  it('finite-nursing colony-level release: brood ALL inside Nursery counts as no-claim (#56 round 3 edge)', () => {
    // colonyHasClaimableBrood must mirror the pickup field's source set —
    // brood inside Nursery is excluded by the seed loop AND by
    // findUncarriedBroodOnTile, so it must also be excluded here.
    // Without the inside-Nursery filter, a queen-dead colony whose brood
    // sits in the Nursery un-matured would still claim "has brood,"
    // pickup field has no sources (brood is inside Nursery), and the
    // mid-tunnel nurse strands.
    const { world, nurseId, broodId } = setupV10NurseAndBroodOnTile({ sameTile: false });
    // Move the brood inside the Nursery footprint (12, 12 — 2x2).
    world.ants.posX[broodId] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[broodId] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    // Now colonyHasClaimableBrood should return false (brood inside
    // Nursery filtered out), so the colony-level release fires.
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
  });
});

// ---------------------------------------------------------------------------
// Issue #17 Phase 1.4 — v10+ carry + deposit.
//
// Once a nurse claims a brood (Phase 1.3), it walks to a Nursery tile while
// syncing the brood's position to its own each tick. On Nursery arrival the
// brood is deposited at a Nursery Open tile (spread by broodId%openCount,
// matching the pre-v10 teleport's distribution), the carry slot clears,
// and the nurse returns to Idle.
// ---------------------------------------------------------------------------

describe('tickNurseActions — v10+ carry + deposit (#17 phase 1.4)', () => {
  function setupV10CarryWorld(opts: {
    nurseTileX: number;
    nurseTileY: number;
    broodTileX: number;
    broodTileY: number;
    nurseryTileX: number;
    nurseryTileY: number;
    nurseryWidth?: number;
    nurseryHeight?: number;
    omitNursery?: boolean;
  }): { world: WorldState; nurseId: number; broodId: number; colony: ColonyRecord } {
    const ugWidth = 16,
      ugHeight = 16;
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V10_VISIBLE_BROOD_CARRY;
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    colony.entrances = [];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[COLONY_ID] = colony;

    // Open the entire grid so the Nursery footprint tiles are Open without
    // any extra dig wiring.
    const underground = createUndergroundGrid(ugWidth, ugHeight);
    for (let y = 0; y < ugHeight; y++) {
      for (let x = 0; x < ugWidth; x++) {
        ugSet(underground, x, y, UndergroundTileState.Open);
      }
    }
    world.undergroundGrids[COLONY_ID] = underground;

    // Queen chamber sized to cover the brood tile — eggs are laid in the
    // queen's chamber per the design, so the test setup needs one for
    // pickup-source tile detection (isInsideQueenChamber). 2×2 anchored at
    // (broodTileX, broodTileY) so the brood always sits inside.
    colony.chambers.push({
      chamberId: 0,
      chamberType: ChamberType.Queen,
      foodStored: 0,
      posX: opts.broodTileX << FP_SHIFT,
      posY: opts.broodTileY << FP_SHIFT,
      width: 2,
      height: 2,
    });

    if (!opts.omitNursery) {
      colony.chambers.push({
        chamberId: 1,
        chamberType: ChamberType.Nursery,
        foodStored: 0,
        posX: opts.nurseryTileX << FP_SHIFT,
        posY: opts.nurseryTileY << FP_SHIFT,
        width: opts.nurseryWidth ?? 2,
        height: opts.nurseryHeight ?? 2,
      });
    }

    const broodId = allocateEntityId(world);
    initAnt(world.ants, broodId, {
      colonyId: COLONY_ID,
      posX: (opts.broodTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (opts.broodTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(broodId);

    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: (opts.nurseTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (opts.nurseTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    return { world, nurseId, broodId, colony };
  }

  it('after claim, brood position syncs to carrier each tick (in-flight, NOT yet at Nursery)', () => {
    // Carrier on brood tile (claim happens) but Nursery is far away —
    // after the tick, brood position equals carrier position; nurse is
    // still in Feeding (not yet at Nursery) and not back to Idle.
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    tickNurseActions(world);
    // Sub-state flipped to Feeding (claim succeeded), brood follows carrier.
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    expect(world.ants.carryingBroodId[nurseId]).toBe(broodId);
    expect(world.ants.posX[broodId]).toBe(world.ants.posX[nurseId]);
    expect(world.ants.posY[broodId]).toBe(world.ants.posY[nurseId]);
    // Now move the carrier manually (simulating one tick of movement) and
    // re-run tickNurseActions: brood follows.
    world.ants.posX[nurseId] = (7 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[nurseId] = (8 << FP_SHIFT) + (FP_ONE >> 1);
    tickNurseActions(world);
    expect(world.ants.posX[broodId]).toBe(world.ants.posX[nurseId]);
    expect(world.ants.posY[broodId]).toBe(world.ants.posY[nurseId]);
    // Still in Feeding (not at Nursery yet).
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
  });

  it('on Nursery-tile arrival: deposits brood, clears carry, returns to Idle', () => {
    // Brood starts OUTSIDE the Nursery (Phase-1.5 W-03: brood inside a
    // Nursery is excluded from pickup). Pickup happens at tile (5, 5);
    // we then pre-position the carrier on a Nursery tile and run a
    // second tick to trigger the deposit branch.
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    // Tick 1 — claim.
    tickNurseActions(world);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    expect(world.ants.carryingBroodId[nurseId]).toBe(broodId);
    // Move the carrier onto a Nursery Open tile (simulating one tick of
    // movement). The next tickNurseActions will sync the brood and deposit.
    world.ants.posX[nurseId] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[nurseId] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    // Tick 2 — deposit. V21+ behavior: nurse goes to Attending before Idle.
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Attending);
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[broodId]).toBe(-1);
    // Brood landed at a Nursery Open tile (broodId % openCount spread).
    const bx = world.ants.posX[broodId]! >> FP_SHIFT;
    const by = world.ants.posY[broodId]! >> FP_SHIFT;
    expect(bx).toBeGreaterThanOrEqual(12);
    expect(bx).toBeLessThan(14);
    expect(by).toBeGreaterThanOrEqual(12);
    expect(by).toBeLessThan(14);
  });

  it('multiple deposits spread across Nursery Open tiles, not stacked at one corner', () => {
    // Two carriers each holding a different brood, both arriving at Nursery
    // on the same tick. broodId differs → spread index differs → tiles differ.
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    // Add a second brood + nurse pair at a second non-Nursery tile.
    const colony = world.colonies[COLONY_ID]!;
    const brood2 = allocateEntityId(world);
    initAnt(world.ants, brood2, {
      colonyId: COLONY_ID,
      posX: (6 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(brood2);
    const nurse2 = allocateEntityId(world);
    initAnt(world.ants, nurse2, {
      colonyId: COLONY_ID,
      posX: (6 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    // Tick 1 — both nurses claim their respective brood.
    tickNurseActions(world);
    // Move both carriers onto Nursery Open tiles (one per tile so deposit
    // branches converge in the same tick).
    world.ants.posX[nurseId] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[nurseId] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posX[nurse2] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[nurse2] = (12 << FP_SHIFT) + (FP_ONE >> 1);
    // Tick 2 — both deposit.
    tickNurseActions(world);
    const allBroodIds = colony.eggs.slice();
    expect(allBroodIds.length).toBe(2);
    expect(allBroodIds).toContain(broodId);
    expect(allBroodIds).toContain(brood2);
    const tilesUsed = new Set<string>();
    for (const bid of allBroodIds) {
      const bx = world.ants.posX[bid]! >> FP_SHIFT;
      const by = world.ants.posY[bid]! >> FP_SHIFT;
      tilesUsed.add(`${bx},${by}`);
    }
    // Two distinct deposit tiles within the 2×2 Nursery footprint.
    expect(tilesUsed.size).toBe(2);
  });

  it('no Nursery: pickup is gated; nurse on a Queen tile releases via Feeding (#56 codex P2)', () => {
    // Phase-1 contract: with no Nursery, no carry happens. The v10
    // pickup path is gated on hasCompletedChamber(Nursery) — without one
    // the gate fires before any claim. Defensive: if a Nursing ant
    // somehow exists pre-Nursery (migrated/corrupted/scripted state),
    // she still needs to release back to Idle so step 10a can reallocate.
    // The release path mirrors the pre-v10 finite-nursing cadence
    // (MovingToBrood→Feeding→Idle two ticks).
    //
    // Test setup: Queen chamber at (5,5) is created by setupV10CarryWorld
    // unconditionally; Nursery is omitted via `omitNursery: true`. The
    // nurse stands on the Queen tile, so onSourceTile=true → release.
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 0,
      nurseryTileY: 0, // ignored
      omitNursery: true,
    });
    tickNurseActions(world); // tick 1 — release-pending
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[broodId]).toBe(-1);
    tickNurseActions(world); // tick 2 — Idle
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
  });

  it('no Nursery: pickup gated, nurse OFF source tile keeps walking (no premature release)', () => {
    // Defensive: the release ONLY fires when the nurse is on a source
    // tile. A nurse mid-walk to a Queen tile with no Nursery yet should
    // continue walking — she may reach the source on a future tick and
    // THEN release.
    const { world, nurseId } = setupV10CarryWorld({
      nurseTileX: 0,
      nurseTileY: 0, // far from any chamber
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 0,
      nurseryTileY: 0, // ignored
      omitNursery: true,
    });
    tickNurseActions(world);
    // No release — nurse keeps walking next tick.
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.MovingToBrood);
  });

  it('1×1 Nursery: deposit collapses to the single Open tile (broodId % 1 === 0)', () => {
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 14,
      nurseryTileY: 14,
      nurseryWidth: 1,
      nurseryHeight: 1,
    });
    tickNurseActions(world); // claim at (5, 5)
    // Move carrier onto the 1×1 Nursery tile.
    world.ants.posX[nurseId] = (14 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[nurseId] = (14 << FP_SHIFT) + (FP_ONE >> 1);
    tickNurseActions(world); // deposit — V21+ goes to Attending, not Idle
    expect(world.ants.task[nurseId]).toBe(AntTask.Nursing);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Attending);
    expect(world.ants.posX[broodId]! >> FP_SHIFT).toBe(14);
    expect(world.ants.posY[broodId]! >> FP_SHIFT).toBe(14);
  });

  it('brood already inside Nursery is NOT re-claimed (W-03 — pre-v10 selection invariant)', () => {
    // A nurse incidentally walks onto a Nursery tile that holds a deposited
    // brood (e.g. immediately after Idle→Nursing re-allocation, before the
    // chamber-flow re-routes her elsewhere). The pre-v10 transport gate
    // skips brood-inside-Nursery in its selection; v10 must too. Without
    // this skip, the brood would be re-picked-up and re-shuffled via
    // broodId%openCount on the next deposit, visible as a brood teleport.
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 12,
      nurseTileY: 12, // Inside the Nursery 2x2 at (12,12).
      broodTileX: 12,
      broodTileY: 12, // Brood already deposited there.
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    tickNurseActions(world);
    // No claim — brood-inside-Nursery is excluded from pickup selection.
    // Nurse releases via finite-nursing (Feeding-without-carry → Idle
    // next tick) since she's on a Nursery source tile.
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[broodId]).toBe(-1);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
  });

  it('integration: carrier + brood share a tile after tickAntMovement (resolveSameColonyOccupancy must not displace carried brood)', () => {
    // Regression for the resolveSameColonyOccupancy interaction: under v10
    // both carrier and brood end at the same tile each tick. The occupancy
    // resolver iterates all alive entities and bumps higher-id same-tile
    // ants to a neighbour. In setupV10CarryWorld the brood is allocated
    // BEFORE the nurse, so brood is the lower id — the resolver would
    // claim the tile for the brood and bump the higher-id NURSE off the
    // tile. Either way the carry-render contract breaks (brood + carrier
    // diverge on a tile every tick of in-tunnel transit until the next
    // 16c sync re-places the brood under the now-displaced carrier).
    // The carry-aware exemption skips both ends of the carry pointer so
    // the resolver never contests the shared tile.
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    tickNurseActions(world); // claim — both at (5, 5), broodId carriedBy nurseId
    expect(world.ants.carryingBroodId[nurseId]).toBe(broodId);
    expect(broodId).toBeLessThan(nurseId); // brood allocated before nurse in helper
    // Direct invocation of tickAntMovement runs resolveSameColonyOccupancy
    // at its tail. The carry-aware exemption must keep the brood at the
    // carrier's tile, not bump it sideways.
    const rng = new Rng(0);
    const digFlowFields = createDigFlowFields();
    // Speed=0 carrier so movement doesn't stretch the tile distance during
    // this tick — the only mutation we care about is the occupancy resolver.
    world.ants.speed[nurseId] = 0;
    tickAntMovement(world, rng, digFlowFields);
    expect(world.ants.posX[broodId]).toBe(world.ants.posX[nurseId]);
    expect(world.ants.posY[broodId]).toBe(world.ants.posY[nurseId]);
  });

  // ----- Issue #17 Phase 1.5 — death + maturation handling -----

  it('carrier dies mid-carry: brood stays at carrier last-synced tile and is reclaimable', () => {
    const { world, nurseId, broodId, colony } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    tickNurseActions(world); // claim
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
    // Move the carrier (simulate one tick of motion) and kill it mid-carry.
    world.ants.posX[nurseId] = (8 << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[nurseId] = (8 << FP_SHIFT) + (FP_ONE >> 1);
    tickNurseActions(world); // sync brood pos to carrier — brood now at (8, 8)
    expect(world.ants.posX[broodId]).toBe(world.ants.posX[nurseId]);
    world.ants.alive[nurseId] = 0;
    // Spawn a second nurse on the same tile (8, 8) — should be able to claim.
    const nurse2 = allocateEntityId(world);
    initAnt(world.ants, nurse2, {
      colonyId: COLONY_ID,
      posX: (8 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (8 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.MovingToBrood,
      zone: Zone.Underground,
    });
    void colony;
    tickNurseActions(world);
    // The new nurse claims the orphaned brood (dead-carrier exception).
    expect(world.ants.carryingBroodId[nurse2]).toBe(broodId);
    expect(world.ants.carriedBy[broodId]).toBe(nurse2);
    expect(world.ants.subTask[nurse2]).toBe(NursingSubState.Feeding);
  });

  it('brood dies mid-carry: carrier drops the carry and returns to Idle', () => {
    const { world, nurseId, broodId } = setupV10CarryWorld({
      nurseTileX: 5,
      nurseTileY: 5,
      broodTileX: 5,
      broodTileY: 5,
      nurseryTileX: 12,
      nurseryTileY: 12,
    });
    tickNurseActions(world); // claim
    expect(world.ants.carryingBroodId[nurseId]).toBe(broodId);
    // Brood dies (combat, starvation, anything).
    world.ants.alive[broodId] = 0;
    tickNurseActions(world);
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[nurseId]).toBe(0);
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Issue #17 Phase 1.5 — larva→worker maturation while carried.
//
// Driven by tickLifecycleTransitions, not tickNurseActions — the lifecycle
// step promotes the larva to worker and (under v10+) drops the carry.
// ---------------------------------------------------------------------------

describe('tickLifecycleTransitions — v10 larva→worker drops carry (#17 phase 1.5)', () => {
  it('larva matures while being carried: carrier drops, returns to Idle, new worker stays put', async () => {
    const { tickLifecycleTransitions } = await import('../colony/lifecycle-system.js');
    const { LARVA_MATURE_TICKS } = await import('../constants.js');
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V10_VISIBLE_BROOD_CARRY;
    // Queen + Nursery so brood-aging gate is satisfied.
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      width: 2,
      height: 2,
    });

    // Larva at age = LARVA_MATURE_TICKS - 1 so a single tick promotes it.
    // Spawn the larva at (5, 5) — its initial pre-carry tile.
    const larvaId = allocateEntityId(world);
    initAnt(world.ants, larvaId, {
      colonyId: COLONY_ID,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    world.ants.age[larvaId] = LARVA_MATURE_TICKS - 1;
    colony.larvae.push(larvaId);
    colony.larvaeCount += 1;

    // Carrier holding the larva — at a DIFFERENT tile (8, 7) so the test
    // can prove the new worker stays at the carrier's tile, not the
    // larva's pre-carry tile. (In normal v10 flow tickNurseActions
    // step 16c keeps brood synced to carrier each tick, so by the time
    // promotion fires both are at the carrier's tile.)
    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: (8 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (7 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.Feeding,
      zone: Zone.Underground,
    });
    world.ants.carryingBroodId[nurseId] = larvaId;
    world.ants.carriedBy[larvaId] = nurseId;
    // Manually pre-sync the larva's position to the carrier (mirrors what
    // tickNurseActions Feeding branch does each tick).
    world.ants.posX[larvaId] = world.ants.posX[nurseId]!;
    world.ants.posY[larvaId] = world.ants.posY[nurseId]!;

    tickLifecycleTransitions(world, colony);
    // Larva promoted to worker; entity id preserved.
    expect(world.colonies[COLONY_ID].workers).toContain(larvaId);
    expect(world.colonies[COLONY_ID].larvae).not.toContain(larvaId);
    // Carry slot dropped on both ends.
    expect(world.ants.carryingBroodId[nurseId]).toBe(-1);
    expect(world.ants.carriedBy[larvaId]).toBe(-1);
    // Carrier returned to Idle.
    expect(world.ants.task[nurseId]).toBe(AntTask.Idle);
    expect(world.ants.subTask[nurseId]).toBe(0);
    // New worker stays at the carrier's tile (8, 7), NOT the larva's
    // pre-carry tile (5, 5). This proves lifecycle promotion does not
    // teleport the new worker.
    expect(world.ants.posX[larvaId] >> FP_SHIFT).toBe(8);
    expect(world.ants.posY[larvaId] >> FP_SHIFT).toBe(7);
  });

  it('egg→larva mid-carry: carry stays attached (entity id preserved)', async () => {
    const { tickLifecycleTransitions } = await import('../colony/lifecycle-system.js');
    const { EGG_HATCH_TICKS } = await import('../constants.js');
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = SIM_VERSION_V10_VISIBLE_BROOD_CARRY;
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;
    colony.chambers.push({
      chamberId: 1,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      width: 2,
      height: 2,
    });
    const eggId = allocateEntityId(world);
    initAnt(world.ants, eggId, {
      colonyId: COLONY_ID,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    world.ants.age[eggId] = EGG_HATCH_TICKS - 1;
    colony.eggs.push(eggId);
    colony.eggCount += 1;
    const nurseId = allocateEntityId(world);
    initAnt(world.ants, nurseId, {
      colonyId: COLONY_ID,
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (5 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Nursing,
      subTask: NursingSubState.Feeding,
      zone: Zone.Underground,
    });
    world.ants.carryingBroodId[nurseId] = eggId;
    world.ants.carriedBy[eggId] = nurseId;

    tickLifecycleTransitions(world, colony);
    // Promoted to larva; carry preserved.
    expect(colony.larvae).toContain(eggId);
    expect(world.ants.carryingBroodId[nurseId]).toBe(eggId);
    expect(world.ants.carriedBy[eggId]).toBe(nurseId);
    expect(world.ants.subTask[nurseId]).toBe(NursingSubState.Feeding);
  });
});

// ---------------------------------------------------------------------------
// Issue #173 — capacity-aware Nursery brood deposit (V24), end-to-end through
// the REAL movement + deposit pipeline (tickAntMovement routes carriers via the
// nurseDeposit field; tickNurseActions deposits only on a field source tile).
//
// Pre-V24: nearest-seed routing + `broodId % openCount` deposit funneled every
// carrier into the nearest Nursery (overflow) while others stayed empty. V24:
// full Nurseries drop out of the preferred deposit field so carriers route to a
// non-full Nursery; a carrier transiting a full Nursery does NOT deposit (it is
// on a step tile, not a source); deposit places brood one-per-tile.
// ---------------------------------------------------------------------------

describe('Nursery brood deposit — capacity-aware spread, real pipeline (#173, V24)', () => {
  const NB_GW = UNDERGROUND_GRID_WIDTH;
  const NB_GH = UNDERGROUND_GRID_HEIGHT;
  const PICKUP_X = 5;
  const PICKUP_Y = 5;

  function mkWorld(simVersion: number): {
    world: WorldState;
    colony: ColonyRecord;
    underground: ReturnType<typeof createUndergroundGrid>;
    A: ChamberRecord;
    B: ChamberRecord;
  } {
    const world = createWorldState(42, 256);
    world.simVersion = simVersion;
    const underground = createUndergroundGrid(NB_GW, NB_GH);
    world.undergroundGrids[COLONY_ID] = underground;
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
    const colony = createColonyRecord(COLONY_ID, queenId);
    world.colonies[COLONY_ID] = colony;
    // Open band y[4..6], x[5..40]: pickup + both Nursery footprints + corridor.
    for (let y = 4; y <= 6; y++) {
      for (let x = 5; x <= 40; x++) ugSet(underground, x, y, UndergroundTileState.Open);
    }
    const A: ChamberRecord = {
      chamberId: 10,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 10 << FP_SHIFT,
      posY: 4 << FP_SHIFT,
      width: 4,
      height: 3,
    };
    const B: ChamberRecord = {
      chamberId: 11,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 30 << FP_SHIFT,
      posY: 4 << FP_SHIFT,
      width: 4,
      height: 3,
    };
    colony.chambers.push(A, B);
    return { world, colony, underground, A, B };
  }

  // Count brood physically resident (deposited, uncarried) inside a footprint.
  function broodCountIn(world: WorldState, colony: ColonyRecord, ch: ChamberRecord): number {
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    let n = 0;
    for (const bid of colony.eggs) {
      if (world.ants.alive[bid] !== 1) continue;
      if (world.ants.carriedBy[bid]! >= 0) continue;
      const tx = world.ants.posX[bid]! >> FP_SHIFT;
      const ty = world.ants.posY[bid]! >> FP_SHIFT;
      if (tx >= bx && tx < bx + ch.width && ty >= by && ty < by + ch.height) n++;
    }
    return n;
  }

  // Place a resident (deposited, uncarried) brood at a tile.
  function placeResident(world: WorldState, colony: ColonyRecord, tx: number, ty: number): void {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: COLONY_ID,
      posX: (tx << FP_SHIFT) + (FP_ONE >> 1),
      posY: (ty << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.eggs.push(id);
  }

  function fillNursery(world: WorldState, colony: ColonyRecord, ch: ChamberRecord): void {
    const bx = ch.posX >> FP_SHIFT;
    const by = ch.posY >> FP_SHIFT;
    for (let ty = 0; ty < ch.height; ty++) {
      for (let tx = 0; tx < ch.width; tx++) placeResident(world, colony, bx + tx, by + ty);
    }
  }

  // Persistent real-pipeline driver: one step = recompute field, move ants,
  // run nurse actions. Spawns carriers sequentially so arrival timing matches
  // real play (a fresh carrier picks up only after the previous deposited).
  function makeDriver(
    world: WorldState,
    colony: ColonyRecord,
    underground: ReturnType<typeof createUndergroundGrid>,
  ) {
    const rng = new Rng(7);
    const dig = createDigFlowFields();
    const ent = createEntranceFlowFields();
    const cff = createChamberFlowFields();
    const gs = underground.width * underground.height;
    function step(): void {
      const bufs = ensureChamberFlowFields(cff, COLONY_ID, gs);
      if (world.simVersion >= SIM_VERSION_V24_NURSERY_CAPACITY) {
        computeNurseryDepositField(
          underground,
          colony.chambers,
          world.ants,
          colony.eggs,
          colony.larvae,
          bufs.nurseDeposit,
          bufs.queue,
        );
      } else {
        computeChamberFlowField(
          underground,
          colony.chambers,
          NURSERY_CHAMBER_TYPES,
          bufs.nurseDeposit,
          bufs.queue,
        );
      }
      tickAntMovement(world, rng, dig, ent, cff);
      tickNurseActions(world, cff);
    }
    // Spawn a carrier (nurse in Feeding carrying a fresh egg) at the pickup tile
    // and step until it deposits (its brood becomes uncarried) or the cap hits.
    function carryOne(maxTicks: number): number {
      const broodId = allocateEntityId(world);
      initAnt(world.ants, broodId, {
        colonyId: COLONY_ID,
        posX: (PICKUP_X << FP_SHIFT) + (FP_ONE >> 1),
        posY: (PICKUP_Y << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Idle,
        speed: 0,
        zone: Zone.Underground,
      });
      colony.eggs.push(broodId);
      const nurseId = allocateEntityId(world);
      initAnt(world.ants, nurseId, {
        colonyId: COLONY_ID,
        posX: (PICKUP_X << FP_SHIFT) + (FP_ONE >> 1),
        posY: (PICKUP_Y << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Nursing,
        subTask: NursingSubState.Feeding,
        zone: Zone.Underground,
      });
      world.ants.carryingBroodId[nurseId] = broodId;
      world.ants.carriedBy[broodId] = nurseId;
      for (let t = 0; t < maxTicks; t++) {
        step();
        if (world.ants.carriedBy[broodId] < 0) return broodId; // deposited
      }
      return broodId;
    }
    return { carryOne };
  }

  it('V24 transit: a carrier routed past a FULL Nursery does not deposit there — it continues to the empty one (no overflow)', () => {
    const { world, colony, underground, A, B } = mkWorld(SIM_VERSION_V24_NURSERY_CAPACITY);
    fillNursery(world, colony, A); // A at capacity (12); the carrier must pass it to reach B
    expect(broodCountIn(world, colony, A)).toBe(12);

    const driver = makeDriver(world, colony, underground);
    const broodId = driver.carryOne(400);

    // The brood deposited in the far EMPTY Nursery B, not the full A it transited.
    expect(world.ants.carriedBy[broodId]).toBe(-1); // deposited (not stranded)
    const tx = world.ants.posX[broodId]! >> FP_SHIFT;
    expect(tx).toBeGreaterThanOrEqual(30); // inside B (x[30..33]), not A (x[10..13])
    expect(broodCountIn(world, colony, A)).toBe(12); // A NOT overflowed by the transit
    expect(broodCountIn(world, colony, B)).toBe(1);
  });

  it('V24 end-to-end: 13 carriers (capacity 12 each) spread into BOTH Nurseries; neither over capacity while another sits empty', () => {
    const { world, colony, underground, A, B } = mkWorld(SIM_VERSION_V24_NURSERY_CAPACITY);
    const driver = makeDriver(world, colony, underground);
    for (let n = 0; n < 13; n++) {
      const broodId = driver.carryOne(400);
      expect(world.ants.carriedBy[broodId]).toBe(-1); // every carrier deposits
    }
    const inA = broodCountIn(world, colony, A);
    const inB = broodCountIn(world, colony, B);
    expect(inA + inB).toBe(13);
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBeGreaterThan(0); // far Nursery is no longer dead space — bug fixed
    expect(inA).toBeLessThanOrEqual(12); // never stacked past capacity
    expect(inB).toBeLessThanOrEqual(12);
  });

  // #247 — "V23 control: carriers funnel into nearest Nursery (pre-V24 modulo)"
  // pinning test removed: V23 unloadable under MIN=V30; the pre-V24 modulo-slot
  // branch it exercised was reaped (occupancy-aware placement is unconditional).

  it('V24 saturation: when EVERY Nursery is full, a carrier overflow-deposits (stacks) rather than piling up forever', () => {
    // When no Nursery has free capacity anywhere, deferring forever would pile up
    // carriers holding brood and starve transport (and time out long-running
    // sims). So the carrier overflow-deposits as a last resort — colony keeps
    // functioning. (The defer-and-reroute path, exercised when ANOTHER Nursery
    // still has room, is covered by the spread test above; see Codex #183.)
    const { world, colony, underground, A, B } = mkWorld(SIM_VERSION_V24_NURSERY_CAPACITY);
    fillNursery(world, colony, A); // 12 (capacity)
    fillNursery(world, colony, B); // 12 (capacity)
    const driver = makeDriver(world, colony, underground);
    const broodId = driver.carryOne(400);

    // Deposited (not held indefinitely), landing inside one of the full Nurseries.
    expect(world.ants.carriedBy[broodId]).toBe(-1);
    expect(world.ants.alive[broodId]).toBe(1);
    const tx = world.ants.posX[broodId]! >> FP_SHIFT;
    const ty = world.ants.posY[broodId]! >> FP_SHIFT;
    const inA = tx >= 10 && tx < 14 && ty >= 4 && ty < 7;
    const inB = tx >= 30 && tx < 34 && ty >= 4 && ty < 7;
    expect(inA || inB).toBe(true);
  });
});
