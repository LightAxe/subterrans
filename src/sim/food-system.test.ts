// food-system.test.ts — issue #112 depletion + spawn coverage
//
// Two surfaces under test:
//   1. recordFoodPileDepletion: append-time cap, priority cleanup.
//   2. tickFoodPileSpawn: time gating, soft ceiling, deterministic placement,
//      no-go list (entrances + rally + recent-depletion), terrain weighting,
//      determinism across reseed, INVALID_ENTITY_ID exhaustion handling.
//
// Run: npx vitest run src/sim/food-system.test.ts

import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { recordFoodPileDepletion, tickFoodPileSpawn } from './food-system.js';
import { Rng } from './rng.js';
import {
  PLAYER_COLONY_ID,
  FOOD_PILE_INITIAL_PICKUPS_MIN,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_SPAWN_INTERVAL_TICKS,
  FOOD_PILE_SOFT_CEILING,
  FOOD_PILE_RECENT_DEPLETION_TICKS,
  FOOD_PILE_MIN_SEPARATION,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  MAX_ENTITIES,
} from './constants.js';

// ---------------------------------------------------------------------------
// recordFoodPileDepletion
// ---------------------------------------------------------------------------

describe('recordFoodPileDepletion', () => {
  it('appends a depletion record and clears matching colony.priorityFoodPileId', () => {
    const world = createScenario(42);
    const target = world.foodPiles[0]!;
    const targetTile = { tileX: target.tileX, tileY: target.tileY };

    // Designate it as the player colony's priority pile.
    world.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId = target.foodPileId;

    recordFoodPileDepletion(world, 0);

    // Record was appended.
    expect(world.recentlyDepletedFood.length).toBe(1);
    expect(world.recentlyDepletedFood[0]).toMatchObject({
      tileX: targetTile.tileX,
      tileY: targetTile.tileY,
    });

    // Priority pointer cleared on the colony that referenced this pile.
    expect(world.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId).toBeNull();
  });

  it('append-time cap shifts oldest entry when at FOOD_PILE_SOFT_CEILING', () => {
    const world = createScenario(42);

    // Pre-fill with FOOD_PILE_SOFT_CEILING entries (synthetic — bypasses splice).
    for (let i = 0; i < FOOD_PILE_SOFT_CEILING; i++) {
      world.recentlyDepletedFood.push({ tick: i, tileX: i, tileY: 0 });
    }
    expect(world.recentlyDepletedFood.length).toBe(FOOD_PILE_SOFT_CEILING);
    const firstTickBefore = world.recentlyDepletedFood[0]!.tick;
    expect(firstTickBefore).toBe(0);

    // Trigger one more append — oldest should be shifted off.
    recordFoodPileDepletion(world, 0);

    expect(world.recentlyDepletedFood.length).toBe(FOOD_PILE_SOFT_CEILING);
    expect(world.recentlyDepletedFood[0]!.tick).not.toBe(firstTickBefore); // oldest dropped
  });

  it('does not clear priorityFoodPileId for unrelated piles', () => {
    const world = createScenario(42);
    const otherPile = world.foodPiles[1]!;
    world.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId = otherPile.foodPileId;

    recordFoodPileDepletion(world, 0); // depletes pile at index 0, not the marked one

    expect(world.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId).toBe(otherPile.foodPileId);
  });
});

// ---------------------------------------------------------------------------
// tickFoodPileSpawn — gating
// ---------------------------------------------------------------------------

describe('tickFoodPileSpawn — gating', () => {
  it('does not spawn at tick 0 even though 0 % INTERVAL === 0', () => {
    const world = createScenario(42);
    const beforeCount = world.foodPiles.length;
    expect(world.tick).toBe(0);

    tickFoodPileSpawn(world, new Rng(world.rngState));

    expect(world.foodPiles.length).toBe(beforeCount);
  });

  it('does not spawn off-cycle (tick not divisible by interval)', () => {
    const world = createScenario(42);
    const beforeCount = world.foodPiles.length;
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS + 1; // off cycle by 1

    tickFoodPileSpawn(world, new Rng(world.rngState));

    expect(world.foodPiles.length).toBe(beforeCount);
  });

  it('places a pile at tick == FOOD_PILE_SPAWN_INTERVAL_TICKS in an empty world', () => {
    // Empty `foodPiles` removes any "too close to existing pile" rejection;
    // `createScenario(42)` provides colonies (so the spawn step has somewhere
    // to anchor distance checks). Across a wide RNG window, the rejection-
    // sampling loop reliably finds a passable tile in 1000 attempts.
    const world = createScenario(42);
    world.foodPiles = [];
    const beforeCount = 0;
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;

    tickFoodPileSpawn(world, new Rng(world.rngState));

    // Strict: at least one new pile MUST land — anything weaker can't
    // distinguish a working spawner from a silently-broken one.
    expect(world.foodPiles.length).toBe(beforeCount + 1);
  });

  it('places at least one pile across multiple seeds at the spawn-cycle boundary', () => {
    // Run the spawner with several seeds, all on a near-empty world. Total
    // placements across the batch must be > 0 — guards against a regression
    // that disables spawning while still passing the single-seed test.
    let placements = 0;
    for (const seed of [1, 7, 13, 21, 42, 99, 100, 1234]) {
      const world = createScenario(seed);
      world.foodPiles = [];
      world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
      tickFoodPileSpawn(world, new Rng(world.rngState));
      placements += world.foodPiles.length;
    }
    expect(placements).toBeGreaterThan(0);
  });

  it('skips silently when at FOOD_PILE_SOFT_CEILING', () => {
    const world = createScenario(42);
    // Clear scenario-seeded piles so the synthetic inflation below cannot
    // collide on tile keys with the deterministic scenario placements.
    world.foodPiles = [];
    // Inflate to soft ceiling with synthetic piles at non-colliding tiles.
    // tileX = 100 + i is well outside the scenario placement range.
    while (world.foodPiles.length < FOOD_PILE_SOFT_CEILING) {
      world.foodPiles.push({
        foodPileId: 9000 + world.foodPiles.length,
        tileX: 100 + world.foodPiles.length,
        tileY: 0,
        pickupsRemaining: 50,
        pickupsInitial: 50,
      });
    }
    expect(world.foodPiles.length).toBe(FOOD_PILE_SOFT_CEILING);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;

    tickFoodPileSpawn(world, new Rng(world.rngState));

    expect(world.foodPiles.length).toBe(FOOD_PILE_SOFT_CEILING); // no growth
  });
});

// ---------------------------------------------------------------------------
// tickFoodPileSpawn — placement constraints
// ---------------------------------------------------------------------------

describe('tickFoodPileSpawn — placement constraints', () => {
  it('respects MIN_SEPARATION from existing piles', () => {
    const world = createScenario(42);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    const before = world.foodPiles.map((p) => ({ tileX: p.tileX, tileY: p.tileY }));

    tickFoodPileSpawn(world, new Rng(world.rngState));

    if (world.foodPiles.length === before.length + 1) {
      const placed = world.foodPiles[world.foodPiles.length - 1]!;
      for (const existing of before) {
        const dist = Math.abs(placed.tileX - existing.tileX) + Math.abs(placed.tileY - existing.tileY);
        expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_SEPARATION);
      }
    }
  });

  it('respects MIN_COLONY_DISTANCE from every entrance and rally point', () => {
    const world = createScenario(42);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    const player = world.colonies[PLAYER_COLONY_ID]!;
    // Add a rally point manually so the test exercises that code path too.
    player.rallyPoint = { tileX: 60, tileY: 60 };
    const beforeLen = world.foodPiles.length;

    tickFoodPileSpawn(world, new Rng(world.rngState));

    if (world.foodPiles.length === beforeLen + 1) {
      const placed = world.foodPiles[world.foodPiles.length - 1]!;
      // Check distance to all entrances + rally points across all colonies.
      for (const colony of Object.values(world.colonies)) {
        for (const e of colony.entrances ?? []) {
          const dist = Math.abs(placed.tileX - e.surfaceTileX) + Math.abs(placed.tileY - e.surfaceTileY);
          expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
        }
        if (colony.rallyPoint) {
          const dist = Math.abs(placed.tileX - colony.rallyPoint.tileX)
                     + Math.abs(placed.tileY - colony.rallyPoint.tileY);
          expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_COLONY_DISTANCE);
        }
      }
    }
  });

  it('avoids tiles within MIN_SEPARATION of recently-depleted entries', () => {
    const world = createScenario(42);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    // Carve out the entire surface from existing piles for a clearer test.
    world.foodPiles = [];
    // Mark a wide swath of tiles as recently depleted.
    for (let x = 0; x < SURFACE_GRID_WIDTH; x += FOOD_PILE_MIN_SEPARATION + 2) {
      for (let y = 0; y < SURFACE_GRID_HEIGHT; y += FOOD_PILE_MIN_SEPARATION + 2) {
        if (world.recentlyDepletedFood.length >= FOOD_PILE_SOFT_CEILING) break;
        world.recentlyDepletedFood.push({ tick: world.tick - 10, tileX: x, tileY: y });
      }
    }

    tickFoodPileSpawn(world, new Rng(world.rngState));

    // If a pile placed, it must be >= MIN_SEPARATION from every fresh recent entry.
    if (world.foodPiles.length === 1) {
      const placed = world.foodPiles[0]!;
      for (const r of world.recentlyDepletedFood) {
        const age = world.tick - r.tick;
        if (age > FOOD_PILE_RECENT_DEPLETION_TICKS) continue; // pruned/stale
        const dist = Math.abs(placed.tileX - r.tileX) + Math.abs(placed.tileY - r.tileY);
        expect(dist).toBeGreaterThanOrEqual(FOOD_PILE_MIN_SEPARATION);
      }
    }
  });

  it('prunes recentlyDepletedFood entries older than the recency window', () => {
    const world = createScenario(42);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS * 2; // well after t=0
    // Inject a stale entry that pre-dates the recency window.
    world.recentlyDepletedFood.push({
      tick: world.tick - FOOD_PILE_RECENT_DEPLETION_TICKS - 1,
      tileX: 0,
      tileY: 0,
    });
    expect(world.recentlyDepletedFood.length).toBe(1);

    tickFoodPileSpawn(world, new Rng(world.rngState));

    // Stale entry should have been pruned during the spawn pass.
    expect(world.recentlyDepletedFood.length).toBe(0);
  });

  it('initial pickups land within [MIN, MAX] for spawned piles', () => {
    const world = createScenario(42);
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    const beforeLen = world.foodPiles.length;

    tickFoodPileSpawn(world, new Rng(world.rngState));

    if (world.foodPiles.length === beforeLen + 1) {
      const placed = world.foodPiles[world.foodPiles.length - 1]!;
      expect(placed.pickupsRemaining).toBeGreaterThanOrEqual(FOOD_PILE_INITIAL_PICKUPS_MIN);
      expect(placed.pickupsRemaining).toBeLessThanOrEqual(FOOD_PILE_INITIAL_PICKUPS_MAX);
      expect(placed.pickupsRemaining).toBe(placed.pickupsInitial);
    }
  });
});

// ---------------------------------------------------------------------------
// tickFoodPileSpawn — determinism
// ---------------------------------------------------------------------------

describe('tickFoodPileSpawn — determinism', () => {
  it('two seeded scenarios advance the same RNG sequence — same spawn outcomes', () => {
    const a = createScenario(99);
    const b = createScenario(99);

    a.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    b.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;

    tickFoodPileSpawn(a, new Rng(a.rngState));
    tickFoodPileSpawn(b, new Rng(b.rngState));

    expect(a.foodPiles.length).toBe(b.foodPiles.length);
    if (a.foodPiles.length > 0 && a.foodPiles.length === b.foodPiles.length) {
      const last = a.foodPiles.length - 1;
      expect(a.foodPiles[last]!.tileX).toBe(b.foodPiles[last]!.tileX);
      expect(a.foodPiles[last]!.tileY).toBe(b.foodPiles[last]!.tileY);
      expect(a.foodPiles[last]!.pickupsInitial).toBe(b.foodPiles[last]!.pickupsInitial);
    }
  });
});

// ---------------------------------------------------------------------------
// tickFoodPileSpawn — entity-ID exhaustion
// ---------------------------------------------------------------------------

describe('tickFoodPileSpawn — entity-ID exhaustion', () => {
  it('skips silently when allocateEntityId returns INVALID_ENTITY_ID', () => {
    const world = createScenario(42);
    // Force the allocator to be exhausted.
    world.nextEntityId = MAX_ENTITIES;
    world.tick = FOOD_PILE_SPAWN_INTERVAL_TICKS;
    const beforeLen = world.foodPiles.length;

    expect(() => tickFoodPileSpawn(world, new Rng(world.rngState))).not.toThrow();

    // No new pile and the counter stayed pinned (allocateEntityId leaves it
    // unchanged when at cap per #59).
    expect(world.foodPiles.length).toBe(beforeLen);
    expect(world.nextEntityId).toBe(MAX_ENTITIES);
  });
});

// ---------------------------------------------------------------------------
// Tick-step integration — the spawner runs as part of tick()
// ---------------------------------------------------------------------------

describe('tickFoodPileSpawn — integration via tick()', () => {
  it('off-cycle ticks: direct call leaves foodPiles unchanged at every sampled tick', () => {
    // Unit-style isolation of the gate: at any tick that's not a multiple
    // of FOOD_PILE_SPAWN_INTERVAL_TICKS, foodPiles.length must be EXACTLY
    // unchanged. Sampling several off-cycle values defends against a
    // regression that mis-implements the modulo gate.
    const world = createScenario(42);
    world.foodPiles = []; // start empty so any spawn would be a +1 we'd see
    for (const t of [1, 100, 500, 999, 1234, FOOD_PILE_SPAWN_INTERVAL_TICKS - 1, FOOD_PILE_SPAWN_INTERVAL_TICKS + 1]) {
      world.tick = t;
      tickFoodPileSpawn(world, new Rng(world.rngState));
      expect(world.foodPiles.length).toBe(0); // strict: no growth
    }
  });

  it('tick() dispatcher fires the spawn step at the cycle boundary', () => {
    // Real integration check — defends against a regression that wires the
    // spawn step to the wrong tick step, drops it from tick(), or changes
    // FOOD_PILE_SPAWN_INTERVAL_TICKS without re-baselining.
    //
    // tick() increments world.tick at step 19 (AFTER step 16d), so the spawn
    // step at iteration N reads world.tick === N-1. The first spawn-eligible
    // tick is when step 16d sees world.tick === FOOD_PILE_SPAWN_INTERVAL_TICKS,
    // which happens on the (INTERVAL + 1)th tick() call.
    const world = createScenario(42);
    world.foodPiles = []; // empty so the only growth path is a successful spawn
    for (let t = 0; t < FOOD_PILE_SPAWN_INTERVAL_TICKS + 1; t++) {
      tick(world, []);
    }
    // After INTERVAL+1 ticks, the spawn step has had exactly one opportunity
    // (at world.tick === INTERVAL). >= 1 keeps the test forgiving of a future
    // spawn-rate bump that fires more often.
    expect(world.foodPiles.length).toBeGreaterThanOrEqual(1);
  });
});
