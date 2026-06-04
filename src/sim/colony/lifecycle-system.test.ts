// lifecycle-system.test.ts — CLNY-01, CLNY-02, CLNY-03 + Phase 6 SC 1 integration
//
// Test coverage:
//   CLNY-01: tickQueenEggProduction gates (tick-modulo, food threshold, queen alive)
//   CLNY-02: egg→larva transition at EGG_HATCH_TICKS
//   CLNY-03: larva→worker transition at LARVA_MATURE_TICKS
//   Integration: full queen→egg→larva→worker pipeline over 3700 ticks

import { describe, it, expect } from 'vitest';
import { tickQueenEggProduction, tickLifecycleTransitions } from './lifecycle-system.js';
import { createWorldState } from '../types.js';
import { createColonyRecord } from './colony-store.js';
import { initAnt } from '../ant/ant-store.js';
import { AntTask, ChamberType } from '../enums.js';
import { Zone, createUndergroundGrid, ugSet, UndergroundTileState } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import {
  QUEEN_EGG_INTERVAL_TICKS,
  QUEEN_EGG_FOOD_THRESHOLD,
  EGG_HATCH_TICKS,
  LARVA_MATURE_TICKS,
  WORKER_BASE_SPEED,
  STARVATION_GRACE_TICKS,
} from '../constants.js';
import type { WorldState } from '../types.js';
import type { ColonyRecord } from './colony-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1;
const MAX_TEST_ENTITIES = 512;

/**
 * Create a fresh world + colony with a live queen at position (queenX, queenY).
 * The queen entity is allocated as entity 0; the colony record references it.
 * foodStored defaults to 10_000 (well above QUEEN_EGG_FOOD_THRESHOLD).
 *
 * By default, both a Queen chamber and a Nursery chamber are pushed to
 * colony.chambers as "completed" so the 09 reproduction-gate memo unlocks
 * egg-laying for the baseline test scenarios. Tests that need to exercise
 * the chamber gates themselves pass `chambers = []` (or a subset).
 */
function setupWorldWithQueen(
  foodStored: number = 10_000,
  queenX = 1024,
  queenY = 512,
  chambers: ReadonlyArray<{ chamberType: ChamberType }> = [
    { chamberType: ChamberType.Queen },
    { chamberType: ChamberType.Nursery },
  ],
): { world: WorldState; colony: ColonyRecord } {
  const world = createWorldState(42, MAX_TEST_ENTITIES);
  const queenId = world.nextEntityId; // 0
  world.nextEntityId += 1;

  initAnt(world.ants, queenId, {
    colonyId: COLONY_ID,
    posX: queenX,
    posY: queenY,
    task: AntTask.Idle,
    speed: 0,
  });

  const colony = createColonyRecord(COLONY_ID, queenId);
  colony.foodStored = foodStored;
  // Gate 6 (seed936214196-tick2401): tickQueenEggProduction requires the
  // queen to be Underground AND inside a Queen chamber footprint. For tests
  // that include a Queen chamber, size it around the queen's tile so the
  // gate passes; also flip the queen's zone to Underground. Tests that pass
  // chambers explicitly without a Queen (chamber gate tests) keep their
  // original assertions — Gate 4 short-circuits before Gate 6.
  const queenTileX = queenX >> FP_SHIFT;
  const queenTileY = queenY >> FP_SHIFT;
  world.ants.zone[queenId] = Zone.Underground;
  for (let i = 0; i < chambers.length; i++) {
    const isQueen = chambers[i]!.chamberType === ChamberType.Queen;
    colony.chambers.push({
      chamberId: 1000 + i,
      chamberType: chambers[i]!.chamberType,
      foodStored: 0,
      posX: isQueen ? queenTileX << FP_SHIFT : 0,
      posY: isQueen ? queenTileY << FP_SHIFT : 0,
      width: 2,
      height: 2,
    });
  }
  world.colonies[COLONY_ID] = colony;

  return { world, colony };
}

// ---------------------------------------------------------------------------
// CLNY-01: tickQueenEggProduction gates
// ---------------------------------------------------------------------------

describe('tickQueenEggProduction — CLNY-01', () => {
  it('1. produces one egg at tick 0 when all gates pass', () => {
    const { world, colony } = setupWorldWithQueen(QUEEN_EGG_FOOD_THRESHOLD);
    world.tick = 0; // 0 % 300 === 0

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(1);
    expect(colony.eggCount).toBe(1);

    const eggId = colony.eggs[0]!;
    expect(world.ants.age[eggId]).toBe(0);
    expect(world.ants.alive[eggId]).toBe(1);
  });

  it('2. does NOT produce an egg when foodStored is below threshold', () => {
    const { world, colony } = setupWorldWithQueen(QUEEN_EGG_FOOD_THRESHOLD - 1);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('3. does NOT produce an egg when queen is dead', () => {
    const { world, colony } = setupWorldWithQueen();
    world.tick = 0;
    world.ants.alive[colony.queenEntityId] = 0; // kill the queen

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('4. does NOT produce an egg when fewer ticks have elapsed than the interval', () => {
    // S4 V21+: gate is elapsed-since-last-lay, not global modulo.
    // Simulate a queen who laid 1 tick ago — interval hasn't elapsed yet.
    const { world, colony } = setupWorldWithQueen();
    world.tick = 1;
    colony.queenLastEggTick = 0; // laid 1 tick ago; 1 < 300 → no lay

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('5. produces an egg at tick 300 (second interval)', () => {
    const { world, colony } = setupWorldWithQueen();
    world.tick = QUEEN_EGG_INTERVAL_TICKS; // 300 % 300 === 0

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(1);
    expect(colony.eggCount).toBe(1);
  });

  it('6. new egg spawns at queen position', () => {
    const QUEEN_X = 1024;
    const QUEEN_Y = 512;
    const { world, colony } = setupWorldWithQueen(10_000, QUEEN_X, QUEEN_Y);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    const eggId = colony.eggs[0]!;
    expect(world.ants.posX[eggId]).toBe(QUEEN_X);
    expect(world.ants.posY[eggId]).toBe(QUEEN_Y);
  });
});

// ---------------------------------------------------------------------------
// 09 reproduction-gate memo — chamber gates (Queen AND Nursery required)
// ---------------------------------------------------------------------------

describe('tickQueenEggProduction — 09 reproduction-gate memo', () => {
  it('6a. does NOT produce an egg with zero chambers (pre-excavation)', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, []);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('6b. does NOT produce an egg with only a Queen chamber (Nursery missing)', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, [
      { chamberType: ChamberType.Queen },
    ]);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('6c. does NOT produce an egg with only a Nursery chamber (Queen missing)', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, [
      { chamberType: ChamberType.Nursery },
    ]);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('6d. produces an egg once both Queen and Nursery are present', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, [
      { chamberType: ChamberType.Queen },
      { chamberType: ChamberType.Nursery },
    ]);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(1);
    expect(colony.eggCount).toBe(1);
  });

  it('6e. FoodStorage alone does not satisfy either gate', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, [
      { chamberType: ChamberType.FoodStorage },
    ]);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate 6 — queen must be Underground and inside Queen chamber footprint.
// seed936214196-tick2401 fix: eggs no longer spawn while the queen is still
// routing (Surface or tunnel). Once she arrives, eggs spawn at her tile,
// which is guaranteed to be inside the Queen chamber.
// ---------------------------------------------------------------------------

describe('tickQueenEggProduction — Gate 6 queen-in-chamber', () => {
  it('6f. does NOT lay egg while queen is on the surface (in transit)', () => {
    const { world, colony } = setupWorldWithQueen();
    world.tick = 0;
    world.ants.zone[colony.queenEntityId] = Zone.Surface;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
  });

  it('6g. does NOT lay egg while queen is underground but outside Queen chamber', () => {
    const { world, colony } = setupWorldWithQueen();
    world.tick = 0;
    // Move queen outside any Queen chamber footprint (far-away tile).
    world.ants.posX[colony.queenEntityId] = 40 << FP_SHIFT;
    world.ants.posY[colony.queenEntityId] = 40 << FP_SHIFT;
    // zone already Underground from setup helper.

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(0);
  });

  it('6h. lays egg (Zone.Underground) at queen position once she is inside Queen chamber', () => {
    const QUEEN_X = 10 << FP_SHIFT;
    const QUEEN_Y = 10 << FP_SHIFT;
    const { world, colony } = setupWorldWithQueen(10_000, QUEEN_X, QUEEN_Y);
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(1);
    const eggId = colony.eggs[0]!;
    // Without an undergroundGrid the issue-#22 drop-tile scan short-circuits
    // and the egg falls back to the queen's exact fixed-point position.
    // 6i below is the with-grid variant that exercises the new placement.
    expect(world.ants.posX[eggId]).toBe(QUEEN_X);
    expect(world.ants.posY[eggId]).toBe(QUEEN_Y);
    expect(world.ants.zone[eggId]).toBe(Zone.Underground);
  });

  it('6i. issue #22 — lays egg at a non-queen Open chamber tile when underground grid is present', () => {
    // Bug repro: pre-fix the egg was always placed at the queen's exact
    // tile, so the queen sprite (depth 50) covered the egg sprite (depth
    // 48). With an undergroundGrid available, the lay step scans the
    // Queen chamber footprint and spreads eggs across all non-queen Open
    // tiles by `eggId % openCount`. Asserts the egg lands on a chamber tile
    // distinct from the queen's tile.
    const QUEEN_TILE_X = 10;
    const QUEEN_TILE_Y = 10;
    const QUEEN_X = (QUEEN_TILE_X << FP_SHIFT) + (FP_ONE >> 1);
    const QUEEN_Y = (QUEEN_TILE_Y << FP_SHIFT) + (FP_ONE >> 1);
    const { world, colony } = setupWorldWithQueen(10_000, QUEEN_X, QUEEN_Y);
    // Queen chamber footprint = (10..11, 10..11). Mark every chamber tile Open
    // in a 16×16 grid so the scan can pick a non-queen tile.
    const grid = createUndergroundGrid(16, 16);
    for (let ty = QUEEN_TILE_Y; ty < QUEEN_TILE_Y + 2; ty++) {
      for (let tx = QUEEN_TILE_X; tx < QUEEN_TILE_X + 2; tx++) {
        ugSet(grid, tx, ty, UndergroundTileState.Open);
      }
    }
    world.undergroundGrids[COLONY_ID] = grid;
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(1);
    const eggId = colony.eggs[0]!;
    expect(eggId).toBe(1); // queen=0, first egg=1
    const eggTileX = world.ants.posX[eggId]! >> FP_SHIFT;
    const eggTileY = world.ants.posY[eggId]! >> FP_SHIFT;
    // Inside the Queen chamber footprint…
    expect(eggTileX).toBeGreaterThanOrEqual(QUEEN_TILE_X);
    expect(eggTileX).toBeLessThan(QUEEN_TILE_X + 2);
    expect(eggTileY).toBeGreaterThanOrEqual(QUEEN_TILE_Y);
    expect(eggTileY).toBeLessThan(QUEEN_TILE_Y + 2);
    // …and NOT on the queen's tile (visual de-overlap, the bug's user-facing claim).
    expect(eggTileX === QUEEN_TILE_X && eggTileY === QUEEN_TILE_Y).toBe(false);
    // 3 non-queen Open tiles in row-major order: (11,10), (10,11), (11,11).
    // eggId=1, openCount=3, targetIndex = 1 % 3 = 1 → second tile (10, 11).
    expect(eggTileX).toBe(QUEEN_TILE_X);
    expect(eggTileY).toBe(QUEEN_TILE_Y + 1);
  });

  it('6i-spread. issue #22 — successive eggs spread across distinct non-queen Open tiles', () => {
    // Pre-spread fix every queen-laid egg landed on the same row-major-first
    // non-queen tile, recreating the visual stack one tile over. With
    // eggId % openCount distribution, four sequential eggs in a 2×2 chamber
    // (3 non-queen Open tiles) should visit at least 2 distinct tiles
    // (cycle 1→2→0→1 over openCount=3).
    const QUEEN_TILE_X = 10;
    const QUEEN_TILE_Y = 10;
    const QUEEN_X = (QUEEN_TILE_X << FP_SHIFT) + (FP_ONE >> 1);
    const QUEEN_Y = (QUEEN_TILE_Y << FP_SHIFT) + (FP_ONE >> 1);
    const { world, colony } = setupWorldWithQueen(10_000_000, QUEEN_X, QUEEN_Y);
    const grid = createUndergroundGrid(16, 16);
    for (let ty = QUEEN_TILE_Y; ty < QUEEN_TILE_Y + 2; ty++) {
      for (let tx = QUEEN_TILE_X; tx < QUEEN_TILE_X + 2; tx++) {
        ugSet(grid, tx, ty, UndergroundTileState.Open);
      }
    }
    world.undergroundGrids[COLONY_ID] = grid;

    // Lay 3 eggs by re-firing tickQueenEggProduction on tick 0, 300, 600
    // (multiples of QUEEN_EGG_INTERVAL_TICKS so Gate 1 passes each time).
    const tiles = new Set<string>();
    for (let i = 0; i < 3; i++) {
      world.tick = i * QUEEN_EGG_INTERVAL_TICKS;
      tickQueenEggProduction(world, colony);
    }
    expect(colony.eggs.length).toBe(3);
    for (const eggId of colony.eggs) {
      const tx = world.ants.posX[eggId]! >> FP_SHIFT;
      const ty = world.ants.posY[eggId]! >> FP_SHIFT;
      tiles.add(`${tx},${ty}`);
    }
    // 3 eggs into 3 non-queen Open tiles → all 3 distinct (full coverage).
    // eggIds 1,2,3 → indices 1,2,0 → tiles (10,11), (11,11), (11,10).
    expect(tiles.size).toBe(3);
    expect(tiles.has(`${QUEEN_TILE_X + 1},${QUEEN_TILE_Y}`)).toBe(true);
    expect(tiles.has(`${QUEEN_TILE_X},${QUEEN_TILE_Y + 1}`)).toBe(true);
    expect(tiles.has(`${QUEEN_TILE_X + 1},${QUEEN_TILE_Y + 1}`)).toBe(true);
  });

  it('6j. issue #22 fallback — degenerate 1×1 chamber lays egg at queen tile (no other Open tile)', () => {
    // Edge case: when the chamber has no Open tile other than the queen's,
    // the drop-tile scan finds nothing and the lay falls back to the
    // queen's tile. This keeps reproduction working in pathological
    // chamber configurations rather than blocking egg-laying entirely.
    const QUEEN_X = (5 << FP_SHIFT) + (FP_ONE >> 1);
    const QUEEN_Y = (5 << FP_SHIFT) + (FP_ONE >> 1);
    const { world, colony } = setupWorldWithQueen(10_000, QUEEN_X, QUEEN_Y);
    // Shrink the Queen chamber footprint to 1×1 around the queen tile.
    for (const ch of colony.chambers) {
      if (ch.chamberType === ChamberType.Queen) {
        ch.width = 1;
        ch.height = 1;
      }
    }
    const grid = createUndergroundGrid(16, 16);
    ugSet(grid, 5, 5, UndergroundTileState.Open);
    world.undergroundGrids[COLONY_ID] = grid;
    world.tick = 0;

    tickQueenEggProduction(world, colony);

    expect(colony.eggs.length).toBe(1);
    const eggId = colony.eggs[0]!;
    expect(world.ants.posX[eggId]).toBe(QUEEN_X);
    expect(world.ants.posY[eggId]).toBe(QUEEN_Y);
  });
});

// ---------------------------------------------------------------------------
// CLNY-02: Egg hatch transitions
// ---------------------------------------------------------------------------

describe('tickLifecycleTransitions — CLNY-02 egg hatch', () => {
  it('7. egg hatches into larva after EGG_HATCH_TICKS transitions', () => {
    const { world, colony } = setupWorldWithQueen();

    // Manually add one egg entity
    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[eggId] = 0;
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    // Run exactly EGG_HATCH_TICKS transitions
    for (let t = 0; t < EGG_HATCH_TICKS; t++) {
      tickLifecycleTransitions(world, colony);
    }

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
    expect(colony.larvae.length).toBe(1);
    expect(colony.larvaeCount).toBe(1);
    expect(world.ants.age[eggId]).toBe(0); // age reset on transition
  });

  it('8. egg does NOT hatch at 1199 ticks (one tick short)', () => {
    const { world, colony } = setupWorldWithQueen();

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    for (let t = 0; t < EGG_HATCH_TICKS - 1; t++) {
      tickLifecycleTransitions(world, colony);
    }

    expect(colony.eggs.length).toBe(1);
    expect(colony.larvae.length).toBe(0);
    expect(world.ants.age[eggId]).toBe(EGG_HATCH_TICKS - 1);
  });

  it('9. two eggs both hatch in the same tick when both reach EGG_HATCH_TICKS', () => {
    const { world, colony } = setupWorldWithQueen();

    const e1 = world.nextEntityId++;
    const e2 = world.nextEntityId++;
    initAnt(world.ants, e1, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    initAnt(world.ants, e2, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    colony.eggs.push(e1, e2);
    colony.eggCount = 2;

    for (let t = 0; t < EGG_HATCH_TICKS; t++) {
      tickLifecycleTransitions(world, colony);
    }

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
    expect(colony.larvae.length).toBe(2);
    expect(colony.larvaeCount).toBe(2);
  });

  it('10. swap-remove preserves remaining eggs (set, not order)', () => {
    const { world, colony } = setupWorldWithQueen();

    // e1 at age 1200 (will hatch), e2 and e3 at age 500 (will NOT hatch)
    const e1 = world.nextEntityId++;
    const e2 = world.nextEntityId++;
    const e3 = world.nextEntityId++;
    initAnt(world.ants, e1, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    initAnt(world.ants, e2, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    initAnt(world.ants, e3, { colonyId: COLONY_ID, posX: 0, posY: 0 });

    // Pre-age: run e1 to hatch point, e2/e3 to mid-point
    world.ants.age[e1] = EGG_HATCH_TICKS - 1; // one more tick to hatch
    world.ants.age[e2] = 500;
    world.ants.age[e3] = 500;
    colony.eggs.push(e1, e2, e3);
    colony.eggCount = 3;

    // One transition call: e1 hatches (age 1200), e2 and e3 stay (age 501)
    tickLifecycleTransitions(world, colony);

    expect(colony.eggs.length).toBe(2);
    expect(colony.eggCount).toBe(2);
    // Both e2 and e3 must be in eggs (order may differ after swap-remove)
    expect(colony.eggs).toContain(e2);
    expect(colony.eggs).toContain(e3);
    expect(colony.eggs).not.toContain(e1);

    expect(colony.larvae.length).toBe(1);
    expect(colony.larvae[0]).toBe(e1);
  });
});

// ---------------------------------------------------------------------------
// CLNY-03: Larva mature transitions
// ---------------------------------------------------------------------------

describe('tickLifecycleTransitions — CLNY-03 larva mature', () => {
  it('11. larva matures into worker after LARVA_MATURE_TICKS transitions', () => {
    const { world, colony } = setupWorldWithQueen();

    const larvaId = world.nextEntityId++;
    initAnt(world.ants, larvaId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[larvaId] = 0;
    colony.larvae.push(larvaId);
    colony.larvaeCount = 1;

    for (let t = 0; t < LARVA_MATURE_TICKS; t++) {
      tickLifecycleTransitions(world, colony);
    }

    expect(colony.larvae.length).toBe(0);
    expect(colony.larvaeCount).toBe(0);
    expect(colony.workers.length).toBe(1);
    expect(colony.workerCount).toBe(1);
    expect(world.ants.age[larvaId]).toBe(0); // age reset on transition
    expect(world.ants.task[larvaId]).toBe(AntTask.Idle);
    expect(world.ants.speed[larvaId]).toBe(WORKER_BASE_SPEED);
  });
});

// ---------------------------------------------------------------------------
// Starvation timer reset on promotion (PRD §4b)
// ---------------------------------------------------------------------------

describe('tickLifecycleTransitions — starvation timer reset on promotion', () => {
  it('15. egg→larva promotion resets starvationTimer to STARVATION_GRACE_TICKS', () => {
    const { world, colony } = setupWorldWithQueen();

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[eggId] = EGG_HATCH_TICKS - 1; // one tick to hatch
    world.ants.starvationTimer[eggId] = 0; // worst case — should be reset
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    tickLifecycleTransitions(world, colony);

    expect(colony.larvae).toContain(eggId);
    expect(world.ants.starvationTimer[eggId]).toBe(STARVATION_GRACE_TICKS);
  });

  it('16. larva→worker promotion resets starvationTimer to STARVATION_GRACE_TICKS', () => {
    const { world, colony } = setupWorldWithQueen();

    const larvaId = world.nextEntityId++;
    initAnt(world.ants, larvaId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[larvaId] = LARVA_MATURE_TICKS - 1; // one tick to mature
    world.ants.starvationTimer[larvaId] = 5; // low timer — should be reset
    colony.larvae.push(larvaId);
    colony.larvaeCount = 1;

    tickLifecycleTransitions(world, colony);

    expect(colony.workers).toContain(larvaId);
    expect(world.ants.starvationTimer[larvaId]).toBe(STARVATION_GRACE_TICKS);
  });
});

// ---------------------------------------------------------------------------
// Dead entity cleanup in lifecycle pass
// ---------------------------------------------------------------------------

describe('tickLifecycleTransitions — dead entity cleanup', () => {
  it('12. dead egg is swap-removed and eggCount decremented', () => {
    const { world, colony } = setupWorldWithQueen();

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.alive[eggId] = 0; // mark dead before entering lifecycle
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    tickLifecycleTransitions(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
  });

  it('13. dead larva is swap-removed and larvaeCount decremented', () => {
    const { world, colony } = setupWorldWithQueen();

    const larvaId = world.nextEntityId++;
    initAnt(world.ants, larvaId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.alive[larvaId] = 0; // mark dead
    colony.larvae.push(larvaId);
    colony.larvaeCount = 1;

    tickLifecycleTransitions(world, colony);

    expect(colony.larvae.length).toBe(0);
    expect(colony.larvaeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 09 reproduction-gate memo — brood-aging gate (legacy / save-loaded brood)
//
// Even though tickQueenEggProduction cannot lay eggs without a completed
// Nursery, the brood-aging loops must also be frozen if the colony lacks a
// completed Nursery at this tick. Otherwise a save file with brood but no
// Nursery could still produce workers, violating the design rule that brood
// requires Nursery support. Worker aging (Loop 3) is unaffected.
// ---------------------------------------------------------------------------

describe('tickLifecycleTransitions — brood-aging gate (09 reproduction-gate memo)', () => {
  it('17. egg does NOT age without a completed Nursery chamber', () => {
    // No chambers at all — brood should freeze.
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, []);

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[eggId] = 0;
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    // Run well past EGG_HATCH_TICKS — without a Nursery the egg must not age.
    for (let t = 0; t < EGG_HATCH_TICKS + 500; t++) {
      tickLifecycleTransitions(world, colony);
    }

    expect(world.ants.age[eggId]).toBe(0);
    expect(colony.eggs.length).toBe(1);
    expect(colony.eggs).toContain(eggId);
    expect(colony.larvae.length).toBe(0);
    expect(colony.workers.length).toBe(0);
  });

  it('18. larva does NOT age or promote without a completed Nursery chamber', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, []);

    const larvaId = world.nextEntityId++;
    initAnt(world.ants, larvaId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[larvaId] = 0;
    colony.larvae.push(larvaId);
    colony.larvaeCount = 1;

    for (let t = 0; t < LARVA_MATURE_TICKS + 500; t++) {
      tickLifecycleTransitions(world, colony);
    }

    expect(world.ants.age[larvaId]).toBe(0);
    expect(colony.larvae.length).toBe(1);
    expect(colony.larvae).toContain(larvaId);
    expect(colony.workers.length).toBe(0);
  });

  it('19. Queen chamber alone (Nursery missing) still freezes brood', () => {
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, [
      { chamberType: ChamberType.Queen },
    ]);

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[eggId] = EGG_HATCH_TICKS - 1; // one tick from hatching
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    tickLifecycleTransitions(world, colony);

    // Without a Nursery, the egg must not hatch even when on the hatch threshold.
    expect(world.ants.age[eggId]).toBe(EGG_HATCH_TICKS - 1);
    expect(colony.eggs).toContain(eggId);
    expect(colony.larvae.length).toBe(0);
  });

  it('20. dead brood is still cleaned up when Nursery is missing', () => {
    // Freeze does NOT delay death cleanup — dead entries must still be
    // swap-removed so starvation / death pipelines stay responsive.
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, []);

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.alive[eggId] = 0;
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    const larvaId = world.nextEntityId++;
    initAnt(world.ants, larvaId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.alive[larvaId] = 0;
    colony.larvae.push(larvaId);
    colony.larvaeCount = 1;

    tickLifecycleTransitions(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.eggCount).toBe(0);
    expect(colony.larvae.length).toBe(0);
    expect(colony.larvaeCount).toBe(0);
  });

  it('21. workers continue aging even when Nursery is missing', () => {
    // The brood freeze applies only to eggs/larvae. Adult workers keep aging
    // regardless of chamber state — losing the Nursery does not freeze
    // existing adults.
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, []);

    const workerId = world.nextEntityId++;
    initAnt(world.ants, workerId, {
      colonyId: COLONY_ID,
      posX: 0,
      posY: 0,
      task: AntTask.Idle,
      speed: WORKER_BASE_SPEED,
    });
    world.ants.age[workerId] = 0;
    colony.workers.push(workerId);
    colony.workerCount = 1;

    tickLifecycleTransitions(world, colony);
    tickLifecycleTransitions(world, colony);
    tickLifecycleTransitions(world, colony);

    expect(world.ants.age[workerId]).toBe(3);
    expect(colony.workers).toContain(workerId);
  });

  it('22. adding a Nursery mid-life unfreezes brood (hatch completes)', () => {
    // Legacy brood carried over from a save: if the player completes a Nursery
    // later, brood must resume aging and promote normally.
    const { world, colony } = setupWorldWithQueen(10_000, 1024, 512, []);

    const eggId = world.nextEntityId++;
    initAnt(world.ants, eggId, { colonyId: COLONY_ID, posX: 0, posY: 0 });
    world.ants.age[eggId] = 0;
    colony.eggs.push(eggId);
    colony.eggCount = 1;

    // Freeze for 500 ticks without Nursery
    for (let t = 0; t < 500; t++) tickLifecycleTransitions(world, colony);
    expect(world.ants.age[eggId]).toBe(0);

    // Complete a Nursery — brood unfreezes.
    colony.chambers.push({
      chamberId: 2001,
      chamberType: ChamberType.Nursery,
      foodStored: 0,
      posX: 0,
      posY: 0,
      width: 2,
      height: 2,
    });

    for (let t = 0; t < EGG_HATCH_TICKS; t++) tickLifecycleTransitions(world, colony);

    expect(colony.eggs.length).toBe(0);
    expect(colony.larvae).toContain(eggId);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline integration — Phase 6 SC 1
// ---------------------------------------------------------------------------

describe('Full pipeline integration — Phase 6 SC 1', () => {
  it('14. queen→egg→larva→worker pipeline first worker emerges after EGG_HATCH_TICKS + LARVA_MATURE_TICKS', () => {
    // The first egg is laid on the first production tick and becomes a worker
    // EGG_HATCH_TICKS + LARVA_MATURE_TICKS ticks later. Run past that latency
    // (+ margin) and assert the first worker emerged exactly on schedule, with
    // later eggs still occupying the egg and larva stages.
    const { world, colony } = setupWorldWithQueen(10_000);
    world.tick = 0;

    const pipelineLatency = EGG_HATCH_TICKS + LARVA_MATURE_TICKS;
    let firstWorkerTick = -1;
    for (let t = 0; t < pipelineLatency + 200; t++) {
      tickQueenEggProduction(world, colony);
      tickLifecycleTransitions(world, colony);
      world.tick += 1;
      if (firstWorkerTick < 0 && colony.workerCount >= 1) firstWorkerTick = world.tick;
    }

    expect(firstWorkerTick).toBe(pipelineLatency);
    // Pipeline still flowing: later eggs occupy the larva and egg stages.
    expect(colony.larvaeCount).toBeGreaterThan(0);
    expect(colony.eggCount).toBeGreaterThan(0);
  });
});
