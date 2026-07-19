// risk-aware-foraging.test.ts — A1 (simVersion V36) risk-aware foraging.
//
// Covers the A1 routing surfaces:
//   (a) sampleForagingDirection danger penalty — RNG-free scoring layers, plus
//       the RNG draw-count delta danger introduces when it drops a strong trail
//       into the weak-trail band.
//   (d) chooseExcursionDirection danger-steer (world-edge bounce) at V36.
//   (e) no-revisit alternate selection is danger-aware at V36.
//
// The danger penalty is `net = food − (Math.imul(danger, DANGER_ROUTE_WEIGHT_FP)
// >> FP_SHIFT)`, clamped ≥ 0. With DANGER_ROUTE_WEIGHT_FP = 256 (1.0) an equal
// danger value fully cancels a food-trail cell (net = 0).
//
// The excursion-boundary danger mirror is intentionally absent (Option B) — the
// boundary scan is danger-blind; see hasNearbyPheromoneSignal. V35-gate coverage
// lives in determinism.test.ts (V36-vs-V35 rngState) and the (e) V35 control.

import { describe, it, expect } from 'vitest';
import { sampleForagingDirection } from '../pheromone/pheromone-system.js';
import { chooseExcursionDirection, tickAntMovement } from './ant-system.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER,
  SIM_VERSION_V36_RISK_AWARE_FORAGING,
  type WorldState,
} from '../types.js';
import { createColonyRecord } from '../colony/colony-store.js';
import { initAnt, pushRecentTile } from './ant-store.js';
import { AntTask, ForagingSubState, PheromoneType } from '../enums.js';
import {
  createPheromoneGrid,
  phSet,
  pheromoneGridKey,
  type PheromoneGrid,
} from '../pheromone/pheromone-store.js';
import { Rng } from '../rng.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  DANGER_ROUTE_AVOID_THRESHOLD,
} from '../constants.js';
import { FP_SHIFT } from '../fixed.js';
import { createDigFlowFields } from '../dig-system.js';
import { createEntranceFlowFields } from '../entrance-flow.js';
import { createChamberFlowFields } from '../chamber-flow.js';

const COLONY_ID = 1;
const MAX_TEST_ENTITIES = 64;

// ---------------------------------------------------------------------------
// (a) sampleForagingDirection — danger penalty on the RNG-free scoring layers
// ---------------------------------------------------------------------------

describe('A1 (a) sampleForagingDirection danger penalty', () => {
  it('a strong food trail through danger loses to a weaker CLEAN trail', () => {
    const food = createPheromoneGrid(10, 10);
    const danger = createPheromoneGrid(10, 10);
    // Right neighbor: strong trail (500) but fully poisoned (danger 500 → net 0).
    phSet(food, 6, 5, 500);
    phSet(danger, 6, 5, 500);
    // Up neighbor: weaker but clean (200 → net 200, ≥ strong-trail threshold 128).
    phSet(food, 5, 4, 200);

    const dir = sampleForagingDirection(food, 5, 5, new Rng(1), -1, -1, danger);
    expect(dir).toEqual({ dx: 0, dy: -1 }); // up — the clean trail. Layer 1, no RNG.
  });

  it('WITHOUT the danger grid (legacy path) the strong poisoned trail still wins', () => {
    const food = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 500);
    phSet(food, 5, 4, 200);

    const dir = sampleForagingDirection(food, 5, 5, new Rng(1)); // no danger grid
    expect(dir).toEqual({ dx: 1, dy: 0 }); // right — strongest raw strength.
  });

  it('a fully danger-poisoned trail yields {0,0} → caller falls through to wander', () => {
    const food = createPheromoneGrid(10, 10);
    const danger = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 300);
    phSet(danger, 6, 5, 300); // net 0 — no usable candidate anywhere.

    const dir = sampleForagingDirection(food, 5, 5, new Rng(7), -1, -1, danger);
    expect(dir).toEqual({ dx: 0, dy: 0 });
  });
});

// ---------------------------------------------------------------------------
// RNG draw-count — danger flips the sampler branch (the real V36 vs V35 delta)
// ---------------------------------------------------------------------------

describe('A1 sampler RNG draw-count', () => {
  it('danger dropping a strong trail into the weak-trail band consumes RNG the legacy path does not', () => {
    const food = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 500); // strong (≥ 128) → layer 1 → 0 RNG draws
    const danger = createPheromoneGrid(10, 10);
    phSet(danger, 6, 5, 400); // net 100: weak (0 < net < 128) → layer 2 → consumes RNG

    // Count nextInt() calls via a duck-typed wrapper around a real seeded Rng, so
    // we pin the EXACT draw count (not just "the streams diverged" — that would pass
    // even if V36 over-consumed the RNG). CodeRabbit.
    const countingRng = (seed: number): { rng: Rng; draws: () => number } => {
      const base = new Rng(seed);
      let n = 0;
      const rng = {
        nextInt: (max: number) => {
          n++;
          return base.nextInt(max);
        },
      } as unknown as Rng;
      return { rng, draws: () => n };
    };

    const v35 = countingRng(999);
    sampleForagingDirection(food, 5, 5, v35.rng); // legacy: strong trail → layer 1
    expect(v35.draws()).toBe(0); // strong-trail branch consumes ZERO draws

    const v36 = countingRng(999);
    sampleForagingDirection(food, 5, 5, v36.rng, -1, -1, danger); // V36: weak trail → layer 2
    expect(v36.draws()).toBe(1); // exactly the single explore-roll draw (no explore branch this seed)
  });
});

// ---------------------------------------------------------------------------
// Layer-2 exploration honors danger — the 10% random-explore roll must not step
// into a poisoned neighbor the scoring just rejected (Codex P2). Same RNG draws.
// ---------------------------------------------------------------------------

describe('A1 sampler Layer-2 explore honors danger', () => {
  // A weak East trail (penalized 100, in the 1..127 band → Layer 2) with the explore
  // roll firing and rolling idx 0 = Up (DIRS order up/down/left/right). Up is a
  // spider-wake tile; V36 must fall through to the exploit pick (East) instead of
  // exploring into Up, while the legacy (no danger grid) path takes Up unconditionally.
  const scriptRng = (vals: number[]): Rng => {
    let i = 0;
    return { nextInt: () => vals[i++]! } as unknown as Rng;
  };

  it('a random-explore roll onto a poisoned neighbor falls through to the exploit pick', () => {
    const food = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 100); // East: weak trail → Layer 2 (0 < 100 < 128)
    const danger = createPheromoneGrid(10, 10);
    phSet(danger, 5, 4, DANGER_ROUTE_AVOID_THRESHOLD + 100); // Up (5,4) is a spider-wake tile

    // Explore fires (5 < EXPLORE_RATE_PERCENT=10), idx 0 → Up. V36: Up poisoned →
    // fall through to the exploit direction (East).
    const dir = sampleForagingDirection(food, 5, 5, scriptRng([5, 0]), -1, -1, danger);
    expect(dir).toEqual({ dx: 1, dy: 0 });
  });

  it('control: WITHOUT the danger grid (legacy) the explore roll takes the rolled Up direction', () => {
    const food = createPheromoneGrid(10, 10);
    phSet(food, 6, 5, 100);
    const dir = sampleForagingDirection(food, 5, 5, scriptRng([5, 0])); // no danger grid
    expect(dir).toEqual({ dx: 0, dy: -1 }); // Up — legacy random explore, unchanged
  });
});

// ---------------------------------------------------------------------------
// Layer-3 reacquisition — a remote FoodTrail whose major-axis first step is a
// spider-wake tile must NOT be chased: the sampler returns {0,0} so the caller
// falls through to the danger-steered wander (round-3 C1; Codex P1 test-gap).
// ---------------------------------------------------------------------------

describe('A1 sampler Layer-3 danger-blocked reacquisition', () => {
  // Ant at (5,5) with no immediate-neighbor trail and one remote FoodTrail target
  // 3 tiles east at (8,5) — inside REACQUIRE_RADIUS (=3), so Layer 3 selects it.
  // Its major-axis first step is East, onto (6,5) — the tile the danger check reads.
  function setup(): { food: PheromoneGrid; danger: PheromoneGrid } {
    const food = createPheromoneGrid(10, 10);
    const danger = createPheromoneGrid(10, 10);
    phSet(food, 8, 5, 500); // remote reacquire target; penalized strength > 0
    return { food, danger };
  }

  it('a dangerous first step toward the remote trail yields {0,0} (→ wander)', () => {
    const { food, danger } = setup();
    // Poison ONLY the first-step tile (6,5); the target (8,5) stays clean so the
    // reacquire scan still selects it, but the step toward it is vetoed.
    phSet(danger, 6, 5, DANGER_ROUTE_AVOID_THRESHOLD);
    const dir = sampleForagingDirection(food, 5, 5, new Rng(1), -1, -1, danger);
    expect(dir).toEqual({ dx: 0, dy: 0 });
  });

  it('control: a CLEAN first step reacquires the remote trail (steps East)', () => {
    const { food, danger } = setup(); // danger grid present but 0 at the first step
    const dir = sampleForagingDirection(food, 5, 5, new Rng(1), -1, -1, danger);
    expect(dir).toEqual({ dx: 1, dy: 0 });
  });

  it('WITHOUT the danger grid (legacy path) the same first step is taken', () => {
    const { food } = setup();
    const dir = sampleForagingDirection(food, 5, 5, new Rng(1)); // no danger grid
    expect(dir).toEqual({ dx: 1, dy: 0 });
  });
});

// ---------------------------------------------------------------------------
// (d) chooseExcursionDirection — world-edge bounce danger-steer at V36
// ---------------------------------------------------------------------------

describe('A1 (d) chooseExcursionDirection danger-steer', () => {
  function setupWanderer(): { world: WorldState; antId: number } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.colonies[COLONY_ID] = createColonyRecord(COLONY_ID, 0);
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Committed east heading with time on the clock → the function decrements
    // ticks and drops straight into the edge/danger bounce, leaving the heading
    // pick/turn logic (and its RNG) out of the picture.
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    return { world, antId };
  }

  it('steers away from a dangerous heading tile when the danger grid is provided', () => {
    const { world, antId } = setupWanderer();
    const danger = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
    // East neighbor (11,10) is dangerous; the first rotation (south, (10,11)) is clean.
    phSet(danger, 11, 10, DANGER_ROUTE_AVOID_THRESHOLD + 100);

    const dir = chooseExcursionDirection(world, antId, new Rng(3), danger);
    expect(dir).not.toEqual({ dx: 1, dy: 0 }); // not east (into the danger)
    // First safe in-bounds rotation = south (0,1). The rotation formula yields a
    // negative-zero dx (`-rotHy`), numerically identical to 0 for `tileX + dx`
    // and normalized to 0 by the Int heading store — compare with === semantics.
    expect(dir.dx === 0).toBe(true);
    expect(dir.dy).toBe(1);
  });

  it('WITHOUT the danger grid it keeps the committed heading (legacy bounce)', () => {
    const { world, antId } = setupWanderer();
    const dir = chooseExcursionDirection(world, antId, new Rng(3)); // no danger grid
    expect(dir).toEqual({ dx: 1, dy: 0 }); // east — unchanged.
  });
});

// ---------------------------------------------------------------------------
// (e) no-revisit alternate selection is danger-aware at V36 (Codex round 2) —
// the downstream recent-tiles swap must not undo the sampler's safe choice.
// ---------------------------------------------------------------------------

describe('A1 (e) no-revisit alternate is danger-aware at V36', () => {
  // A wandering SearchingFood forager at (10,10) committed east; the east tile
  // (11,10) is a recent tile, so the no-revisit swap fires. In ALT order the
  // first fresh alternate is North (10,9); we make North a spider-wake tile and
  // leave NE (11,9) clean. Legacy takes North (no +x); V36 skips it for NE (+x).
  function setup(simVersion: number): {
    world: WorldState;
    antId: number;
    x0: number;
    y0: number;
  } {
    const world = createWorldState(42, MAX_TEST_ENTITIES);
    world.simVersion = simVersion;
    const colony = createColonyRecord(COLONY_ID, 0);
    colony.entrances = [
      { entranceId: allocateEntityId(world), surfaceTileX: 0, surfaceTileY: 0, isOpen: true },
    ];
    world.colonies[COLONY_ID] = colony;

    const TX = 10;
    const TY = 10;
    const antId = allocateEntityId(world);
    initAnt(world.ants, antId, {
      colonyId: COLONY_ID,
      posX: TX << FP_SHIFT,
      posY: TY << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
    });
    // Committed east heading with time on the clock → the wander returns east
    // (empty FoodTrail grid + no food piles → sampler returns {0,0}).
    world.ants.searchHeadingX[antId] = 1;
    world.ants.searchHeadingY[antId] = 0;
    world.ants.searchHeadingTicks[antId] = 5;
    world.ants.searchPrevTileX[antId] = -1;
    world.ants.searchPrevTileY[antId] = -1;

    world.pheromoneGrids[pheromoneGridKey(COLONY_ID, PheromoneType.FoodTrail, 'surface')] =
      createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);

    // The proposed east tile (11,10) is recent → triggers the no-revisit swap.
    pushRecentTile(world.ants, antId, TX + 1, TY);

    // North (10,9) — the first fresh alternate — is dangerous; NE (11,9) is clean.
    // (East itself stays clean so the excursion-steer keeps the heading.)
    const danger = createPheromoneGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT);
    phSet(danger, TX, TY - 1, DANGER_ROUTE_AVOID_THRESHOLD + 100);
    world.pheromoneGrids[pheromoneGridKey(COLONY_ID, PheromoneType.DangerTrail, 'surface')] =
      danger;

    return { world, antId, x0: world.ants.posX[antId]!, y0: world.ants.posY[antId]! };
  }

  function move(world: WorldState): void {
    tickAntMovement(
      world,
      new Rng(1),
      createDigFlowFields(),
      createEntranceFlowFields(),
      createChamberFlowFields(),
    );
  }

  it('V36 skips the dangerous North alternate for clean NE (moves +x and −y)', () => {
    const { world, antId, x0, y0 } = setup(SIM_VERSION_V36_RISK_AWARE_FORAGING);
    move(world);
    expect(world.ants.posX[antId]! > x0).toBe(true); // NE: east component
    expect(world.ants.posY[antId]! < y0).toBe(true); // NE: north component
  });

  it('V35 control: takes the first fresh alternate North — only −y, no +x (danger ignored)', () => {
    const { world, antId, x0, y0 } = setup(SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER);
    move(world);
    expect(world.ants.posX[antId]!).toBe(x0); // North: no east component
    expect(world.ants.posY[antId]! < y0).toBe(true); // North: north component
  });
});
