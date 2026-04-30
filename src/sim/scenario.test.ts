// scenario.test.ts — tests for createScenario (PRD §6a)
//
// Requirements covered:
//   SCEN-02 — Symmetric colony placement
//   SCEN-03 — Food pile scatter with separation constraints
//   SURF-01 — Surface grid dimensions
//   SURF-02 — Food piles are static/infinite (no quantity field)
//   UNDR-08 — Independent underground grids
//   SCEN-06 — Determinism (same seed → identical output)

import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { isAlive } from './ant/ant-store.js';
import { AntTask, PheromoneType } from './enums.js';
import { pheromoneGridKey } from './pheromone/pheromone-store.js';
import { FP_SHIFT } from './fixed.js';
import { UndergroundTileState, ugGet } from './terrain.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  PLAYER_START_X,
  PLAYER_START_Y,
  ENEMY_START_X,
  ENEMY_START_Y,
  STARTING_FOOD,
  STARTING_WORKERS,
  FOOD_PILE_COUNT,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  ENTRANCE_SHAFT_DEPTH,
} from './constants.js';

describe('createScenario', () => {

  // -------------------------------------------------------------------------
  // SCEN-02 — Symmetric colony placement
  // -------------------------------------------------------------------------

  describe('SCEN-02: colony placement', () => {
    it('creates both player and enemy colonies', () => {
      const world = createScenario(42);
      expect(world.colonies[PLAYER_COLONY_ID]).toBeDefined();
      expect(world.colonies[ENEMY_COLONY_ID]).toBeDefined();
    });

    it('player queen is at PLAYER_START_X/Y in fixed-point, task=Idle', () => {
      const world = createScenario(42);
      const colony = world.colonies[PLAYER_COLONY_ID]!;
      const qId = colony.queenEntityId;
      expect(world.ants.posX[qId]).toBe(PLAYER_START_X << FP_SHIFT);
      expect(world.ants.posY[qId]).toBe(PLAYER_START_Y << FP_SHIFT);
      expect(world.ants.task[qId]).toBe(AntTask.Idle);
    });

    it('enemy queen is at ENEMY_START_X/Y in fixed-point, task=Idle', () => {
      const world = createScenario(42);
      const colony = world.colonies[ENEMY_COLONY_ID]!;
      const qId = colony.queenEntityId;
      expect(world.ants.posX[qId]).toBe(ENEMY_START_X << FP_SHIFT);
      expect(world.ants.posY[qId]).toBe(ENEMY_START_Y << FP_SHIFT);
      expect(world.ants.task[qId]).toBe(AntTask.Idle);
    });

    it('all player workers start at same tile as player queen', () => {
      const world = createScenario(42);
      const colony = world.colonies[PLAYER_COLONY_ID]!;
      const expectedX = PLAYER_START_X << FP_SHIFT;
      const expectedY = PLAYER_START_Y << FP_SHIFT;
      for (const wId of colony.workers) {
        expect(world.ants.posX[wId]).toBe(expectedX);
        expect(world.ants.posY[wId]).toBe(expectedY);
        expect(world.ants.task[wId]).toBe(AntTask.Idle);
      }
    });

    it('all enemy workers start at same tile as enemy queen', () => {
      const world = createScenario(42);
      const colony = world.colonies[ENEMY_COLONY_ID]!;
      const expectedX = ENEMY_START_X << FP_SHIFT;
      const expectedY = ENEMY_START_Y << FP_SHIFT;
      for (const wId of colony.workers) {
        expect(world.ants.posX[wId]).toBe(expectedX);
        expect(world.ants.posY[wId]).toBe(expectedY);
        expect(world.ants.task[wId]).toBe(AntTask.Idle);
      }
    });

    it('each colony has workerCount === STARTING_WORKERS (3)', () => {
      const world = createScenario(42);
      expect(world.colonies[PLAYER_COLONY_ID]!.workerCount).toBe(STARTING_WORKERS);
      expect(world.colonies[ENEMY_COLONY_ID]!.workerCount).toBe(STARTING_WORKERS);
    });

    it('each colony workers array has exactly STARTING_WORKERS entries', () => {
      const world = createScenario(42);
      expect(world.colonies[PLAYER_COLONY_ID]!.workers.length).toBe(STARTING_WORKERS);
      expect(world.colonies[ENEMY_COLONY_ID]!.workers.length).toBe(STARTING_WORKERS);
    });

    it('each colony queen is alive', () => {
      const world = createScenario(42);
      const playerQueenId = world.colonies[PLAYER_COLONY_ID]!.queenEntityId;
      const enemyQueenId  = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
      expect(isAlive(world.ants, playerQueenId)).toBe(true);
      expect(isAlive(world.ants, enemyQueenId)).toBe(true);
    });

    it('each colony has foodStored === STARTING_FOOD', () => {
      const world = createScenario(42);
      expect(world.colonies[PLAYER_COLONY_ID]!.foodStored).toBe(STARTING_FOOD);
      expect(world.colonies[ENEMY_COLONY_ID]!.foodStored).toBe(STARTING_FOOD);
    });
  });

  // -------------------------------------------------------------------------
  // SCEN-03 — Food pile scatter
  // -------------------------------------------------------------------------

  describe('SCEN-03: food pile scatter', () => {
    it('places FOOD_PILE_COUNT food piles (or fewer if rejection exhausted)', () => {
      const world = createScenario(42);
      // With 1000 attempts and 15 piles on 128×128 grid, seed 42 should reach 15
      expect(world.foodPiles.length).toBeLessThanOrEqual(FOOD_PILE_COUNT);
      expect(world.foodPiles.length).toBeGreaterThan(0);
    });

    it('places exactly FOOD_PILE_COUNT piles for seed 42', () => {
      const world = createScenario(42);
      expect(world.foodPiles.length).toBe(FOOD_PILE_COUNT);
    });

    it('no two food piles are within FOOD_PILE_MIN_SEPARATION of each other', () => {
      const world = createScenario(42);
      const piles = world.foodPiles;
      for (let i = 0; i < piles.length; i++) {
        for (let j = i + 1; j < piles.length; j++) {
          const dist =
            Math.abs(piles[i]!.tileX - piles[j]!.tileX) +
            Math.abs(piles[i]!.tileY - piles[j]!.tileY);
          expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_SEPARATION);
        }
      }
    });

    it('no food pile is within FOOD_PILE_MIN_COLONY_DISTANCE of player start', () => {
      const world = createScenario(42);
      for (const pile of world.foodPiles) {
        const dist =
          Math.abs(pile.tileX - PLAYER_START_X) +
          Math.abs(pile.tileY - PLAYER_START_Y);
        expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
      }
    });

    it('no food pile is within FOOD_PILE_MIN_COLONY_DISTANCE of enemy start', () => {
      const world = createScenario(42);
      for (const pile of world.foodPiles) {
        const dist =
          Math.abs(pile.tileX - ENEMY_START_X) +
          Math.abs(pile.tileY - ENEMY_START_Y);
        expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
      }
    });

    it('fresh scenario has no priorityFoodPileId set on any colony', () => {
      const world = createScenario(42);
      for (const key in world.colonies) {
        const colony = world.colonies[key as unknown as number]!;
        expect(colony.priorityFoodPileId).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // SURF-01 — Surface grid dimensions
  // -------------------------------------------------------------------------

  describe('SURF-01: surface grid', () => {
    it('surface grid has correct width', () => {
      const world = createScenario(42);
      expect(world.surface.width).toBe(128);
    });

    it('surface grid has correct height', () => {
      const world = createScenario(42);
      expect(world.surface.height).toBe(128);
    });

    it('surface grid data length === 128 × 128 = 16384', () => {
      const world = createScenario(42);
      expect(world.surface.data.length).toBe(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT);
    });

    it('surface grid has some dirt tiles (dirt scatter not all grass)', () => {
      const world = createScenario(42);
      let dirtCount = 0;
      for (let i = 0; i < world.surface.data.length; i++) {
        if (world.surface.data[i] === 1) dirtCount++; // SurfaceTileState.Dirt = 1
      }
      // ~15% dirt expected (~2450); allow very wide tolerance for PRNG variance
      expect(dirtCount).toBeGreaterThan(1000);
      expect(dirtCount).toBeLessThan(5000);
    });
  });

  // -------------------------------------------------------------------------
  // SURF-02 — Food piles are static/infinite (no quantity field)
  // -------------------------------------------------------------------------

  describe('SURF-02: food piles are static/infinite', () => {
    it('FoodPile has no quantity field — existence means infinite food', () => {
      const world = createScenario(42);
      expect(world.foodPiles.length).toBeGreaterThan(0);
      const pile = world.foodPiles[0]!;
      // Should have exactly the four canonical fields; no quantity
      expect(Object.prototype.hasOwnProperty.call(pile, 'foodPileId')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(pile, 'tileX')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(pile, 'tileY')).toBe(true);
      // Phase 9: priority lives on ColonyRecord, not on the pile itself.
      expect(Object.prototype.hasOwnProperty.call(pile, 'isMarkedPriority')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(pile, 'quantity')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // UNDR-08 — Independent underground grids
  // -------------------------------------------------------------------------

  describe('UNDR-08: independent underground grids', () => {
    it('player underground grid data length === 128 × 64 = 8192', () => {
      const world = createScenario(42);
      expect(world.undergroundGrids[PLAYER_COLONY_ID]!.data.length).toBe(
        UNDERGROUND_GRID_WIDTH * UNDERGROUND_GRID_HEIGHT,
      );
    });

    it('enemy underground grid data length === 128 × 64 = 8192', () => {
      const world = createScenario(42);
      expect(world.undergroundGrids[ENEMY_COLONY_ID]!.data.length).toBe(
        UNDERGROUND_GRID_WIDTH * UNDERGROUND_GRID_HEIGHT,
      );
    });

    // Phase 9 playability: each colony's starting shaft tiles (2 tiles at the
    // entrance column) are pre-excavated Open so ants can transit underground
    // on tick 0. Every other tile remains Solid.
    it('player underground grid is all-Solid except the starting shaft', () => {
      const world = createScenario(42);
      const ug = world.undergroundGrids[PLAYER_COLONY_ID]!;
      for (let y = 0; y < UNDERGROUND_GRID_HEIGHT; y++) {
        for (let x = 0; x < UNDERGROUND_GRID_WIDTH; x++) {
          const isShaft = x === PLAYER_START_X && y < ENTRANCE_SHAFT_DEPTH;
          const expected = isShaft ? UndergroundTileState.Open : UndergroundTileState.Solid;
          expect(ugGet(ug, x, y)).toBe(expected);
        }
      }
    });

    it('enemy underground grid is all-Solid except the starting shaft', () => {
      const world = createScenario(42);
      const ug = world.undergroundGrids[ENEMY_COLONY_ID]!;
      for (let y = 0; y < UNDERGROUND_GRID_HEIGHT; y++) {
        for (let x = 0; x < UNDERGROUND_GRID_WIDTH; x++) {
          const isShaft = x === ENEMY_START_X && y < ENTRANCE_SHAFT_DEPTH;
          const expected = isShaft ? UndergroundTileState.Open : UndergroundTileState.Solid;
          expect(ugGet(ug, x, y)).toBe(expected);
        }
      }
    });

    it('mutating player underground tile does not affect enemy underground tile', () => {
      const world = createScenario(42);
      world.undergroundGrids[PLAYER_COLONY_ID]!.data[0] = 3; // Open
      expect(world.undergroundGrids[ENEMY_COLONY_ID]!.data[0]).toBe(0); // still Solid
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3 colony extensions — caller-initialized per PRD §2a
  // -------------------------------------------------------------------------

  describe('Phase 3 colony extensions', () => {
    // Phase 9 playability: each colony starts with one pre-excavated open
    // entrance at its start column so the forage loop closes on tick 0
    // (aligns with Phase 8 Stabilization Memo item #4).
    it('player colony has one starting open entrance at its start column', () => {
      const world = createScenario(42);
      const entrances = world.colonies[PLAYER_COLONY_ID]!.entrances;
      expect(entrances.length).toBe(1);
      expect(entrances[0]!.surfaceTileX).toBe(PLAYER_START_X);
      expect(entrances[0]!.surfaceTileY).toBe(PLAYER_START_Y);
      expect(entrances[0]!.isOpen).toBe(true);
    });

    it('enemy colony has one starting open entrance at its start column', () => {
      const world = createScenario(42);
      const entrances = world.colonies[ENEMY_COLONY_ID]!.entrances;
      expect(entrances.length).toBe(1);
      expect(entrances[0]!.surfaceTileX).toBe(ENEMY_START_X);
      expect(entrances[0]!.surfaceTileY).toBe(ENEMY_START_Y);
      expect(entrances[0]!.isOpen).toBe(true);
    });

    it('player colony starting-shaft tiles are Open in underground grid', () => {
      const world = createScenario(42);
      const ug = world.undergroundGrids[PLAYER_COLONY_ID]!;
      for (let sy = 0; sy < ENTRANCE_SHAFT_DEPTH; sy++) {
        expect(ugGet(ug, PLAYER_START_X, sy)).toBe(UndergroundTileState.Open);
      }
    });

    it('enemy colony starting-shaft tiles are Open in underground grid', () => {
      const world = createScenario(42);
      const ug = world.undergroundGrids[ENEMY_COLONY_ID]!;
      for (let sy = 0; sy < ENTRANCE_SHAFT_DEPTH; sy++) {
        expect(ugGet(ug, ENEMY_START_X, sy)).toBe(UndergroundTileState.Open);
      }
    });

    it('player colony digFlowFieldDirty === false', () => {
      const world = createScenario(42);
      expect(world.colonies[PLAYER_COLONY_ID]!.digFlowFieldDirty).toBe(false);
    });

    it('enemy colony digFlowFieldDirty === false', () => {
      const world = createScenario(42);
      expect(world.colonies[ENEMY_COLONY_ID]!.digFlowFieldDirty).toBe(false);
    });

    it('player colony rallyPoint === null', () => {
      const world = createScenario(42);
      expect(world.colonies[PLAYER_COLONY_ID]!.rallyPoint).toBeNull();
    });

    it('enemy colony rallyPoint === null', () => {
      const world = createScenario(42);
      expect(world.colonies[ENEMY_COLONY_ID]!.rallyPoint).toBeNull();
    });

    it('entrances arrays of both colonies are independent references', () => {
      const world = createScenario(42);
      const player = world.colonies[PLAYER_COLONY_ID]!;
      const enemy  = world.colonies[ENEMY_COLONY_ID]!;
      const enemyStart = enemy.entrances.length;
      // Push into player entrances; enemy's array length must not change.
      player.entrances.push({ entranceId: 99, surfaceTileX: 0, surfaceTileY: 0, isOpen: false });
      expect(enemy.entrances.length).toBe(enemyStart);
    });
  });

  // -------------------------------------------------------------------------
  // Determinism (SCEN-06) — same seed produces identical result
  // -------------------------------------------------------------------------

  describe('SCEN-06: determinism', () => {
    it('two calls with seed 42 produce identical food pile coordinates', () => {
      const world1 = createScenario(42);
      const world2 = createScenario(42);
      expect(world1.foodPiles.length).toBe(world2.foodPiles.length);
      for (let i = 0; i < world1.foodPiles.length; i++) {
        expect(world1.foodPiles[i]!.tileX).toBe(world2.foodPiles[i]!.tileX);
        expect(world1.foodPiles[i]!.tileY).toBe(world2.foodPiles[i]!.tileY);
      }
    });

    it('two calls with seed 42 produce identical surface grids', () => {
      const world1 = createScenario(42);
      const world2 = createScenario(42);
      for (let i = 0; i < world1.surface.data.length; i++) {
        expect(world1.surface.data[i]).toBe(world2.surface.data[i]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pheromone grids — all 8 must exist at scenario creation
  // -------------------------------------------------------------------------

  describe('Pheromone grids', () => {
    it('all 8 pheromone grids exist (2 colonies × 2 types × 2 zones)', () => {
      const world = createScenario(42);
      for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
        for (const pType of [PheromoneType.FoodTrail, PheromoneType.DangerTrail]) {
          const surfaceKey     = pheromoneGridKey(cid, pType, 'surface');
          const undergroundKey = pheromoneGridKey(cid, pType, 'underground');
          expect(world.pheromoneGrids[surfaceKey]).toBeDefined();
          expect(world.pheromoneGrids[undergroundKey]).toBeDefined();
        }
      }
    });

    it('surface pheromone grids are 128×128', () => {
      const world = createScenario(42);
      for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
        for (const pType of [PheromoneType.FoodTrail, PheromoneType.DangerTrail]) {
          const grid = world.pheromoneGrids[pheromoneGridKey(cid, pType, 'surface')]!;
          expect(grid.width).toBe(SURFACE_GRID_WIDTH);
          expect(grid.height).toBe(SURFACE_GRID_HEIGHT);
        }
      }
    });

    it('underground pheromone grids are 128×64', () => {
      const world = createScenario(42);
      for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
        for (const pType of [PheromoneType.FoodTrail, PheromoneType.DangerTrail]) {
          const grid = world.pheromoneGrids[pheromoneGridKey(cid, pType, 'underground')]!;
          expect(grid.width).toBe(UNDERGROUND_GRID_WIDTH);
          expect(grid.height).toBe(UNDERGROUND_GRID_HEIGHT);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 09 foraging-autonomy memo: both colonies bootstrap food gathering
  // without any player input. Prior to the outward-wander fallback,
  // SearchingFood foragers stood still on an empty pheromone grid, the
  // starting food pool drained in ~640 ticks, and queens starved before
  // any autonomous discovery could happen.
  // -------------------------------------------------------------------------

  describe('autonomous forage bootstrap (09 foraging-autonomy memo)', () => {
    it('both queens survive ≥2000 ticks with no commands issued', () => {
      // Starting foodStored = 1280. Queen consumes 2/tick. Without food
      // influx the colony pool hits 0 at tick ~640, starvation grace is
      // 300 ticks → queen would die at ~940. Surviving past 2000 ticks
      // is only possible if foragers autonomously bring food back.
      const world = createScenario(42);
      for (let t = 0; t < 2000; t++) {
        tick(world, []);
      }
      const player = world.colonies[PLAYER_COLONY_ID]!;
      const enemy  = world.colonies[ENEMY_COLONY_ID]!;
      expect(world.ants.alive[player.queenEntityId]).toBe(1);
      expect(world.ants.alive[enemy.queenEntityId]).toBe(1);
      expect(player.defeated).toBe(false);
      expect(enemy.defeated).toBe(false);
    });

    it('pheromone food-trail grids were laid at some point during 1500 ticks — foragers discovered piles', () => {
      // The carry-only deposit rule (PHER-03) means the surface food-trail
      // grid can only accumulate strength if at least one forager picked
      // food up and started carrying it. Rather than sample a specific tick
      // (trails decay to 0 between round trips), we track the peak trail
      // total observed over the run — any non-zero peak proves the bootstrap
      // loop closed at least once for each colony.
      const world = createScenario(42);
      const peak: Record<number, number> = {
        [PLAYER_COLONY_ID]: 0,
        [ENEMY_COLONY_ID]: 0,
      };
      for (let t = 0; t < 1500; t++) {
        tick(world, []);
        for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
          const grid = world.pheromoneGrids[pheromoneGridKey(cid, PheromoneType.FoodTrail, 'surface')]!;
          let totalStrength = 0;
          for (let i = 0; i < grid.data.length; i++) totalStrength += grid.data[i]!;
          if (totalStrength > peak[cid]!) peak[cid] = totalStrength;
        }
      }
      expect(peak[PLAYER_COLONY_ID]).toBeGreaterThan(0);
      expect(peak[ENEMY_COLONY_ID]).toBeGreaterThan(0);
    });

    it('route reuse (09 pheromone-reacquisition memo): searchers stay near the trail once it exists', () => {
      // Run the full scenario until trail+forager population coexist, then
      // sample over a window of ticks. The memo's contract is that
      // sampleForagingDirection's widened reacquisition + explore suppression
      // should keep SearchingFood foragers near the trail geometry instead
      // of scattering uniformly across the map.
      //
      // Measure: over a 300-tick window after bootstrap, count the number of
      // (tick, searcher) samples where the searcher is within REACQUIRE_RADIUS
      // (3 Manhattan) of any active trail cell. If route reuse is working at
      // all, this fraction must be substantially higher than the uniform
      // baseline.
      const world = createScenario(42);
      const REACQUIRE_RADIUS = 3;
      const trailKey = pheromoneGridKey(
        PLAYER_COLONY_ID, PheromoneType.FoodTrail, 'surface',
      );

      // Phase A — tick forward until pheromone exists and stays alive for 10
      // consecutive ticks (confirms the forage loop is actively maintained,
      // not a one-shot deposit that immediately decays).
      let aliveStreak = 0;
      let bootstrapTick = -1;
      for (let t = 0; t < 2000 && bootstrapTick === -1; t++) {
        tick(world, []);
        const grid = world.pheromoneGrids[trailKey]!;
        let total = 0;
        for (let i = 0; i < grid.data.length; i++) total += grid.data[i]!;
        aliveStreak = total > 0 ? aliveStreak + 1 : 0;
        if (aliveStreak >= 10) bootstrapTick = t + 1;
      }
      expect(bootstrapTick).toBeGreaterThan(0);

      // Phase B — measure searcher-near-trail frequency over the next 300 ticks.
      let searcherTicks = 0;
      let nearTrailTicks = 0;
      for (let w = 0; w < 300; w++) {
        tick(world, []);
        const player = world.colonies[PLAYER_COLONY_ID]!;
        const grid = world.pheromoneGrids[trailKey]!;
        // Skip ticks where no trail exists (between round trips).
        let totalStrength = 0;
        for (let i = 0; i < grid.data.length; i++) totalStrength += grid.data[i]!;
        if (totalStrength === 0) continue;
        for (const wid of player.workers) {
          if (world.ants.alive[wid] !== 1) continue;
          if (world.ants.foodCarrying[wid]! > 0) continue; // only searchers
          searcherTicks++;
          const ax = world.ants.posX[wid]! >> 8;
          const ay = world.ants.posY[wid]! >> 8;
          let nearby = false;
          for (let dy = -REACQUIRE_RADIUS; dy <= REACQUIRE_RADIUS && !nearby; dy++) {
            const absY = dy < 0 ? -dy : dy;
            const xRange = REACQUIRE_RADIUS - absY;
            for (let dx = -xRange; dx <= xRange && !nearby; dx++) {
              const tx = ax + dx;
              const ty = ay + dy;
              if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) continue;
              if (grid.data[ty * grid.width + tx]! > 0) nearby = true;
            }
          }
          if (nearby) nearTrailTicks++;
        }
      }
      expect(searcherTicks).toBeGreaterThan(0);
      // Route reuse means searchers cluster near the trail significantly more
      // often than a uniform-over-map baseline (few percent of tiles have
      // trail at any moment). Assert a substantial share.
      //
      // Threshold: nearTrailTicks > 10% of searcherTicks, written as integer
      // comparison (nearTrailTicks * 10 > searcherTicks) to satisfy the
      // sim/ no-float-literal rule. Uniform baseline is a few %, so 10% is
      // still strong clustering evidence.
      //
      // v4 follow-up (issue #34): with 8-connected carrier motion, the
      // food-trail tile coverage is roughly halved — a diagonal carrier
      // visits one cell per tick along the diagonal instead of two cells
      // along a cardinal staircase. The reacquisition fan is unchanged
      // (REACQUIRE_RADIUS Manhattan) but the per-cell pheromone density is
      // lower, so searchers cluster less tightly than under v3. Threshold
      // tuned from the original 25% (`* 4`) to 10% (`* 10`) to track v4
      // observed ratios in the 12-15% range.
      expect(nearTrailTicks * 10).toBeGreaterThan(searcherTicks);
    });

    it('both colonies collect food — queens or chambers hold food after 1500 ticks', () => {
      // After 1500 ticks, each colony should have either:
      //   (a) non-zero colony.foodStored (a round trip already completed), or
      //   (b) at least one worker carrying food (delivery in progress).
      // Either proves the forage loop is closing autonomously.
      const world = createScenario(42);
      for (let t = 0; t < 1500; t++) {
        tick(world, []);
      }
      for (const cid of [PLAYER_COLONY_ID, ENEMY_COLONY_ID]) {
        const colony = world.colonies[cid]!;
        let workersCarrying = 0;
        for (let i = 0; i < colony.workers.length; i++) {
          const wid = colony.workers[i]!;
          if (world.ants.alive[wid] === 1 && world.ants.foodCarrying[wid]! > 0) {
            workersCarrying += 1;
          }
        }
        const chamberFood = colony.chambers.reduce((s, c) => s + c.foodStored, 0);
        const evidence = colony.foodStored > 0 || chamberFood > 0 || workersCarrying > 0;
        expect(evidence).toBe(true);
      }
    });
  });

});
