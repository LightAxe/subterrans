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
import { serializeWorldState, deserializeWorldState } from '../save.js';
import type { ColonyId } from '../../sim/colony/colony-store.js';
import type { SimCommand } from '../../sim/commands.js';
import {
  DISCOVERY_SEEDS,
  CALIBRATION_SEEDS,
  ACCEPTANCE_SEEDS,
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

describe('static-terrain feature-field oracle', () => {
  it('the 128×128 feature-effect field MUTATES when a food pile is removed (today bug)', () => {
    const world = createScenario(99, 'Normal');
    const before = featureFieldHash(world);

    // Removing a food pile lifts its suppression halo, potentially REVEALING a
    // procedural HardBlock under/near it. If the chosen seed's piles never
    // overlap a suppressed feature, scan a few seeds until one demonstrates the
    // mutation (the class is known to exist — 348/3000 in the Codex probe).
    let demonstrated = mutationOnPileRemoval(world, before);
    if (!demonstrated) {
      for (const seed of [11, 42, 7, 123, 256, 777]) {
        const w = createScenario(seed, 'Normal');
        if (mutationOnPileRemoval(w, featureFieldHash(w))) {
          demonstrated = true;
          break;
        }
      }
    }
    expect(demonstrated).toBe(true);
  });

  it('the feature-effect field is invariant across save/load round-trip', () => {
    const world = createScenario(42, 'Normal');
    for (let t = 0; t < 50; t++) tick(world, []);
    const restored = deserializeWorldState(serializeWorldState(world));
    expect(featureFieldHash(restored)).toBe(featureFieldHash(world));
    expect(featureFieldDiffCount(world, restored)).toBe(0);
  });

  it('designating an entrance can change the feature-effect field (suppression halo)', () => {
    // Designation adds an entrance whose Chebyshev-radius halo suppresses
    // features. Whether a given column flips depends on the procedural field;
    // scan a few columns to demonstrate the dynamic-suppression class exists.
    let changed = false;
    for (const seed of [42, 11, 99, 7]) {
      const world = createScenario(seed, 'Normal');
      const before = featureFieldHash(world);
      const colonyId = PLAYER_COLONY_ID as ColonyId;
      for (let col = 30; col < 90 && !changed; col += 1) {
        const w = createScenario(seed, 'Normal');
        const cmd: SimCommand = {
          type: 'DesignateEntrance',
          colonyId,
          surfaceTileX: col,
          surfaceTileY: PLAYER_START_Y,
          issuedAtTick: 0,
        };
        tick(w, [cmd]);
        if (featureFieldHash(w) !== before) changed = true;
      }
      if (changed) break;
    }
    expect(changed).toBe(true);
  }, 30_000);
});

/** Remove the first food pile and report whether the feature-effect field
 *  changed (proving the dynamic-suppression mutation). Mutates `world`. */
function mutationOnPileRemoval(world: ReturnType<typeof createScenario>, before: number): boolean {
  if (world.foodPiles.length === 0) return false;
  // Splice out one pile (the same operation depletion performs) and re-hash.
  world.foodPiles.splice(0, 1);
  return featureFieldHash(world) !== before;
}
