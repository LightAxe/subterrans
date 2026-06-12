// harness.test.ts — committed regression guards for the flurry PR-2
// investigation harness (plan/flurry/PR2-REPLAN.md Phase 0).
//
// These tests prove the harness's load-bearing properties so PR 2 / 2b can
// trust it as a pre/post instrument:
//   1. The three seed sets are disjoint.
//   2. Tracing is observationally neutral (instrumented == clean, incl. rngState).
//   3. The traced sweep is deterministic.
//   4. #127 surface confinement reproduces on discovery seeds.
//   5. #128 underground embedding reproduces (structural class-iv + class-ii).
//   6. The static-terrain feature-field oracle detects today's dynamic mutation
//      and is invariant across save/load.
//
// Heavy full-sweep data collection (all seeds × 3 difficulties × 3000 ticks)
// runs offline to populate INVESTIGATION.md; the committed tests use bounded
// subsets so `npm run verify` stays green and fast.
//
// Synthetic world construction below mutates WorldState directly. That is the
// accepted determinism.test.ts pattern and is legal here because this is a
// *.test.ts file (excluded from the FNDN-07 sim-boundary grep).

import { describe, it, expect } from 'vitest';
import { tick } from '../../sim/tick.js';
import { createScenario } from '../../sim/scenario.js';
import { allocateEntityId } from '../../sim/types.js';
import { initAnt } from '../../sim/ant/ant-store.js';
import { canEnterUndergroundTile } from '../../sim/ant/ant-system.js';
import { Zone, ugSet, ugGet, UndergroundTileState } from '../../sim/terrain.js';
import { AntTask, ForagingSubState, DiggingSubState } from '../../sim/enums.js';
import { FP_SHIFT, FP_ONE } from '../../sim/fixed.js';
import {
  PLAYER_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../../sim/constants.js';
import { serializeWorldState, deserializeWorldState, MIN_ACCEPTED_SIM_VERSION } from '../save.js';
import { LATEST_SIM_VERSION } from '../../sim/types.js';
import {
  isSurfaceTileInComponent,
  validateSurfaceConnectivity,
  surfaceMovementAt,
  SurfaceMovementEffect,
} from '../../sim/surface-features.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from '../../sim/constants.js';
import type { ColonyId } from '../../sim/colony/colony-store.js';
import type { SimCommand } from '../../sim/commands.js';
import {
  DISCOVERY_SEEDS,
  CALIBRATION_SEEDS,
  ACCEPTANCE_SEEDS,
  DIFFICULTIES,
  seedSetsAreDisjoint,
} from './seeds.js';
import { emptyLog, playerConstructionLog } from './input-logs.js';
import {
  runTracedScenario,
  checkObservationalNeutrality,
  featureFieldHash,
  featureFieldDiffCount,
} from './harness.js';

// ---------------------------------------------------------------------------
// 1. Seed-set hygiene
// ---------------------------------------------------------------------------

describe('investigation seed sets', () => {
  it('discovery / calibration / acceptance are mutually disjoint', () => {
    expect(seedSetsAreDisjoint()).toBe(true);
  });

  it('seed 11 (Codex scent-vs-wall repro) is in discovery, not acceptance', () => {
    expect(DISCOVERY_SEEDS).toContain(11);
    expect(ACCEPTANCE_SEEDS).not.toContain(11);
    expect(CALIBRATION_SEEDS).not.toContain(11);
  });
});

// ---------------------------------------------------------------------------
// 2. Observational neutrality (plan §1, R3-P0-3)
// ---------------------------------------------------------------------------

describe('observational neutrality: tracing perturbs nothing', () => {
  it('empty-log run: instrumented == clean (serialized state + rngState)', () => {
    const r = checkObservationalNeutrality(11, 'Normal', 400, emptyLog(400));
    expect(r.serializedEqual).toBe(true);
    expect(r.rngStateClean).toBe(r.rngStateTraced);
    expect(r.neutral).toBe(true);
  }, 30_000);

  it('construction-log run: instrumented == clean (serialized state + rngState)', () => {
    const ticks = 400;
    const r = checkObservationalNeutrality(42, 'Normal', ticks, playerConstructionLog(ticks));
    expect(r.serializedEqual).toBe(true);
    expect(r.rngStateClean).toBe(r.rngStateTraced);
    expect(r.neutral).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Traced sweep determinism
// ---------------------------------------------------------------------------

describe('traced sweep determinism', () => {
  it('two identical traced runs produce identical episode catalogs', () => {
    const a = runTracedScenario(11, 'Normal', 600, emptyLog(600));
    const b = runTracedScenario(11, 'Normal', 600, emptyLog(600));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. #127 surface confinement reproduces
// ---------------------------------------------------------------------------

describe('#127 surface confinement reproduces on discovery seeds', () => {
  it('finds at least one confinement episode across a discovery subset', () => {
    const seeds = [11, 42, 99];
    let total = 0;
    let worst = 0;
    for (const seed of seeds) {
      const r = runTracedScenario(seed, 'Normal', 1500, emptyLog(1500));
      total += r.confinement.length;
      worst = Math.max(worst, r.worstConfinementTicks);
    }
    // The bug is severe (STEP0-FINDINGS: ~13 episodes/difficulty over 3000
    // ticks); over 3 seeds × 1500 ticks we expect several.
    expect(total).toBeGreaterThan(0);
    expect(worst).toBeGreaterThanOrEqual(12);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. #128 underground embedding — structural reproductions
// ---------------------------------------------------------------------------

/** Add a worker ant to the player colony and return its id. */
function addPlayerAnt(
  world: ReturnType<typeof createScenario>,
  spec: Parameters<typeof initAnt>[2],
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, spec);
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

describe('#128 class-iv: terrain mutation reverts under a standing occupant', () => {
  it('CancelDigMark reverts Marked→Solid under a digger, embedding it', () => {
    const world = createScenario(42, 'Normal');
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    const colonyId = PLAYER_COLONY_ID as ColonyId;

    // A Solid tile away from the pre-open shaft; surround stays Solid so the
    // embedded digger cannot wander out and self-resolve.
    const tx = PLAYER_START_X + 10;
    const ty = 6;
    ugSet(grid, tx, ty, UndergroundTileState.Marked);

    // A digger standing on the Marked tile (legal for AntTask.Digging).
    const digger = addPlayerAnt(world, {
      colonyId: PLAYER_COLONY_ID,
      posX: (tx << FP_SHIFT) + (FP_ONE >> 1),
      posY: (ty << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Digging,
      subTask: DiggingSubState.MovingToTile,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Underground,
    });

    // Before: Marked is passable for a digger.
    expect(canEnterUndergroundTile(grid, tx, ty, AntTask.Digging)).toBe(true);

    // Cancel the mark this tick — handler reverts Marked→Solid with no
    // occupancy check (tick.ts CancelDigMark).
    tick(world, [{ type: 'CancelDigMark', colonyId, tileX: tx, tileY: ty, issuedAtTick: 0 }]);

    // After: tile is Solid; the digger is still on it and now embedded.
    expect(ugGet(grid, tx, ty)).toBe(UndergroundTileState.Solid);
    const stillThere =
      world.ants.posX[digger]! >> FP_SHIFT === tx && world.ants.posY[digger]! >> FP_SHIFT === ty;
    expect(stillThere).toBe(true);
    expect(canEnterUndergroundTile(grid, tx, ty, world.ants.task[digger]! as AntTask)).toBe(false);
  });
});

describe('#128 class-ii: descent places an ant without validating the landing tile', () => {
  it('a CarryingFood forager descends onto a non-Open landing tile and embeds', () => {
    const world = createScenario(42, 'Normal');
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;

    // Corrupt the entrance landing tile (entrance column, tileY=0) to Solid.
    // Descent sets posY=0 unconditionally; it never checks the tile is Open.
    ugSet(grid, PLAYER_START_X, 0, UndergroundTileState.Solid);

    // A CarryingFood forager sitting exactly on the open entrance surface tile.
    const forager = addPlayerAnt(world, {
      colonyId: PLAYER_COLONY_ID,
      posX: (PLAYER_START_X << FP_SHIFT) + (FP_ONE >> 1),
      posY: (PLAYER_START_Y << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: Zone.Surface,
    });
    world.ants.foodCarrying[forager] = 256;

    // Step until the forager descends (zone flips to Underground).
    let descended = false;
    for (let t = 0; t < 20 && !descended; t++) {
      tick(world, []);
      if (world.ants.zone[forager] === Zone.Underground) descended = true;
    }
    expect(descended).toBe(true);

    // It landed at tileY=0 on the Solid tile we planted → embedded.
    expect(world.ants.posY[forager]! >> FP_SHIFT).toBe(0);
    const lx = world.ants.posX[forager]! >> FP_SHIFT;
    expect(ugGet(grid, lx, 0)).toBe(UndergroundTileState.Solid);
    expect(canEnterUndergroundTile(grid, lx, 0, AntTask.Foraging)).toBe(false);
  }, 20_000);
});

describe('#128 natural reproduction via the construction input log', () => {
  it('the construction log runs cleanly and the harness catalogs underground state', () => {
    const ticks = 600;
    const r = runTracedScenario(42, 'Normal', ticks, playerConstructionLog(ticks));
    // The run must complete and produce a well-formed result. Embedding counts
    // depend on digger timing; the structural cases above are the guaranteed
    // repros. Here we assert the harness exercised the construction path.
    expect(r.ticks).toBe(ticks);
    expect(Array.isArray(r.embedding)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. Static-terrain feature-field oracle (plan §3, R3-P1-6)
// ---------------------------------------------------------------------------

/** First walkable, in-component surface tile not already occupied by a food pile
 *  (PR 4 helper for spawn placement). */
function firstFreeInComponentTile(world: ReturnType<typeof createScenario>): {
  x: number;
  y: number;
} {
  const occupied = new Set(world.foodPiles.map((p) => `${p.tileX},${p.tileY}`));
  for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
      if (isSurfaceTileInComponent(world, x, y) && !occupied.has(`${x},${y}`)) return { x, y };
    }
  }
  throw new Error('no free in-component tile — connectivity is broken');
}

describe('PR 4 — static-terrain feature-field oracle (full SurfaceFeatureSlice)', () => {
  it('feature field is EXACTLY invariant across pile spawn/deplete, entrance designate/open, save/load', () => {
    const world = createScenario(42, 'Normal');
    const base = featureFieldHash(world);
    const colonyId = PLAYER_COLONY_ID as ColonyId;
    const assertSame = (label: string): void => {
      expect(featureFieldHash(world), `feature field changed after ${label}`).toBe(base);
    };

    // 1. Pile depletion — remove a pile (what depletion does).
    const removed = world.foodPiles.length > 0 ? world.foodPiles.splice(0, 1)[0]! : null;
    assertSame('pile-deplete');

    // 2. Pile spawn — re-add a pile (valid pickup values from the removed one) on
    //    a free in-component tile; must not flip terrain.
    if (removed !== null) {
      const spot = firstFreeInComponentTile(world);
      world.foodPiles.push({ ...removed, tileX: spot.x, tileY: spot.y });
    }
    assertSame('pile-spawn');

    // 3. Entrance designation — issue commands across many columns; terrain is
    //    frozen so the hash must not move whether or not each is accepted.
    const entrancesBefore = world.colonies[colonyId]!.entrances.length;
    for (let col = 28; col < 100; col += 4) {
      const cmd: SimCommand = {
        type: 'DesignateEntrance',
        colonyId,
        surfaceTileX: col,
        surfaceTileY: PLAYER_START_Y,
        issuedAtTick: 0,
      };
      tick(world, [cmd]);
    }
    // Prove the ACCEPTED path is exercised, not just the rejection path: at least
    // one designation must have actually added an entrance (else this step would
    // only cover hash-invariance under rejection — Fable P3).
    expect(world.colonies[colonyId]!.entrances.length).toBeGreaterThan(entrancesBefore);
    assertSame('entrance-designate');

    // 4. Entrance opening — toggle isOpen on every entrance (no terrain effect).
    for (const key of Object.keys(world.colonies)) {
      for (const e of world.colonies[Number(key)]!.entrances) e.isOpen = !e.isOpen;
    }
    assertSame('entrance-open');

    // 5. Run ticks (drives pile/AI churn) — still invariant.
    for (let t = 0; t < 60; t++) tick(world, []);
    assertSame('ticks');

    // 6. Save / load round-trip — diff must be 0 over the FULL slice.
    const restored = deserializeWorldState(serializeWorldState(world));
    expect(featureFieldDiffCount(world, restored)).toBe(0);
    expect(featureFieldHash(restored)).toBe(base);

    console.log(
      `PASS static-terrain oracle: featureFieldHash invariant (0 mutate) across pile spawn/deplete, entrance designate/open, ticks, save/load — hash=${base}`,
    );
  }, 30_000);
});

describe('PR 4 — connectivity + reachable-spawn', () => {
  it('one walkable component holds every colony root, food pile, and entrance', () => {
    const seeds = [11, 42, 99];
    for (const seed of seeds) {
      for (const diff of DIFFICULTIES) {
        const world = createScenario(seed, diff);
        // validateSurfaceConnectivity asserts every entrance + every pile is in
        // the single connected component.
        expect(validateSurfaceConnectivity(world)).toBe(true);
        // Every food pile + entrance is walkable (non-HardBlock) AND in-component.
        for (const pile of world.foodPiles) {
          expect(isSurfaceTileInComponent(world, pile.tileX, pile.tileY)).toBe(true);
          expect(surfaceMovementAt(world, pile.tileX, pile.tileY)).not.toBe(
            SurfaceMovementEffect.HardBlock,
          );
        }
        for (const key of Object.keys(world.colonies)) {
          for (const e of world.colonies[Number(key)]!.entrances) {
            expect(isSurfaceTileInComponent(world, e.surfaceTileX, e.surfaceTileY)).toBe(true);
          }
        }
      }
    }
    console.log(
      `PASS connectivity: single component contains all roots/piles/entrances over ${seeds.length} seeds × ${DIFFICULTIES.length} difficulties`,
    );
  }, 30_000);
});

describe('PR 4 — simVersion rejection boundary (posture 2)', () => {
  it('a save at the new LATEST loads; a save below MIN_ACCEPTED is rejected', () => {
    const ser = serializeWorldState(createScenario(42, 'Normal'));
    expect(LATEST_SIM_VERSION).toBe(28);
    // At LATEST → loads.
    expect(() => deserializeWorldState({ ...ser, simVersion: LATEST_SIM_VERSION })).not.toThrow();
    // Below MIN_ACCEPTED → rejected.
    expect(() =>
      deserializeWorldState({ ...ser, simVersion: MIN_ACCEPTED_SIM_VERSION - 1 }),
    ).toThrow();
    console.log(
      `PASS simVersion boundary: LATEST=${LATEST_SIM_VERSION} loads, ${MIN_ACCEPTED_SIM_VERSION - 1} (< MIN_ACCEPTED=${MIN_ACCEPTED_SIM_VERSION}) rejected`,
    );
  });
});
