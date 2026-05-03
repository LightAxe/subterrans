// constants.test.ts — PRD §9c regression guard
//
// Each assertion pins the constant to its PRD §9c specification value.
// If a refactor changes a constant, the diff is immediately visible in
// the failure message alongside the PRD section reference.
//
// Run: npx vitest run src/sim/constants.test.ts

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BEHAVIOR_RATIO,
  DANGER_DECAY_FP,
  EGG_HATCH_TICKS,
  EXPLORE_RATE_PERCENT,
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  FOOD_PICKUP_AMOUNT,
  FOOD_TRAIL_DEPOSIT,
  FORAGER_ROUND_TRIP_TICKS,
  LARVA_FOOD_PER_TICK,
  LARVA_MATURE_TICKS,
  MAX_ENTITIES,
  NURSE_RATIO,
  PHEROMONE_CAP,
  PHEROMONE_DECAY_FP,
  PHEROMONE_FLOOR,
  QUEEN_EGG_FOOD_THRESHOLD,
  QUEEN_EGG_INTERVAL_TICKS,
  QUEEN_FOOD_PER_TICK,
  RECONCILE_INTERVAL_TICKS,
  STARVATION_GRACE_TICKS,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  WORKER_BASE_SPEED,
  WORKER_CARRY_CAPACITY,
  WORKER_FOOD_PER_TICK,
  WORKER_LIFESPAN_TICKS,
} from './constants';

describe('PRD §9c lifecycle tick constants', () => {
  it('EGG_HATCH_TICKS === 1200', () => {
    expect(EGG_HATCH_TICKS).toBe(1200);
  });

  it('LARVA_MATURE_TICKS === 2400', () => {
    expect(LARVA_MATURE_TICKS).toBe(2400);
  });

  it('WORKER_LIFESPAN_TICKS === 0x7FFFFFFF (INT32_MAX)', () => {
    expect(WORKER_LIFESPAN_TICKS).toBe(0x7FFFFFFF);
  });

  it('QUEEN_EGG_INTERVAL_TICKS === 300', () => {
    expect(QUEEN_EGG_INTERVAL_TICKS).toBe(300);
  });

  it('QUEEN_EGG_FOOD_THRESHOLD === 768', () => {
    expect(QUEEN_EGG_FOOD_THRESHOLD).toBe(768);
  });

  it('STARVATION_GRACE_TICKS === 300 (Phase 8.5 stabilization bump from PRD target 100)', () => {
    expect(STARVATION_GRACE_TICKS).toBe(300);
  });

  it('RECONCILE_INTERVAL_TICKS === 100', () => {
    expect(RECONCILE_INTERVAL_TICKS).toBe(100);
  });

  it('FORAGER_ROUND_TRIP_TICKS === 200', () => {
    expect(FORAGER_ROUND_TRIP_TICKS).toBe(200);
  });
});

describe('PRD §9c food economy constants', () => {
  it('QUEEN_FOOD_PER_TICK === 2', () => {
    expect(QUEEN_FOOD_PER_TICK).toBe(2);
  });

  it('LARVA_FOOD_PER_TICK === 1', () => {
    expect(LARVA_FOOD_PER_TICK).toBe(1);
  });

  it('WORKER_FOOD_PER_TICK === 0', () => {
    expect(WORKER_FOOD_PER_TICK).toBe(0);
  });

  it('WORKER_CARRY_CAPACITY === 1024 (4 × FP_ONE)', () => {
    expect(WORKER_CARRY_CAPACITY).toBe(1024);
  });

  it('FOOD_PICKUP_AMOUNT === 512 (2 × FP_ONE)', () => {
    expect(FOOD_PICKUP_AMOUNT).toBe(512);
  });

  it('FOOD_CHAMBER_CAPACITY === 5120 (20 × FP_ONE)', () => {
    expect(FOOD_CHAMBER_CAPACITY).toBe(5120);
  });

  it('BASE_FOOD_STORAGE_CAPACITY === 2048 (8 × FP_ONE, 09 backlog memo)', () => {
    expect(BASE_FOOD_STORAGE_CAPACITY).toBe(2048);
  });

  it('WORKER_BASE_SPEED === 128 (0.5 × FP_ONE)', () => {
    expect(WORKER_BASE_SPEED).toBe(128);
  });
});

describe('PRD §9c pheromone constants', () => {
  it('PHEROMONE_DECAY_FP === 5', () => {
    expect(PHEROMONE_DECAY_FP).toBe(5);
  });

  it('DANGER_DECAY_FP === 10', () => {
    expect(DANGER_DECAY_FP).toBe(10);
  });

  it('PHEROMONE_FLOOR === 64', () => {
    expect(PHEROMONE_FLOOR).toBe(64);
  });

  it('PHEROMONE_CAP === 65280', () => {
    expect(PHEROMONE_CAP).toBe(65280);
  });

  it('FOOD_TRAIL_DEPOSIT === 512 (2 × FP_ONE)', () => {
    expect(FOOD_TRAIL_DEPOSIT).toBe(512);
  });

  it('EXPLORE_RATE_PERCENT === 10', () => {
    expect(EXPLORE_RATE_PERCENT).toBe(10);
  });
});

describe('PRD §9c allocation and budget constants', () => {
  it('NURSE_RATIO === 3', () => {
    expect(NURSE_RATIO).toBe(3);
  });

  it('MAX_ENTITIES === 8192', () => {
    expect(MAX_ENTITIES).toBe(8192);
  });
});

describe('PRD §9c grid dimension constants', () => {
  it('SURFACE_GRID_WIDTH === 128', () => {
    expect(SURFACE_GRID_WIDTH).toBe(128);
  });

  it('SURFACE_GRID_HEIGHT === 128', () => {
    expect(SURFACE_GRID_HEIGHT).toBe(128);
  });

  it('UNDERGROUND_GRID_WIDTH === 128', () => {
    expect(UNDERGROUND_GRID_WIDTH).toBe(128);
  });

  it('UNDERGROUND_GRID_HEIGHT === 64', () => {
    expect(UNDERGROUND_GRID_HEIGHT).toBe(64);
  });
});

describe('PRD §7 §2 + Phase 10 amendment (CTRL-01\') DEFAULT_BEHAVIOR_RATIO', () => {
  it('forage === 10', () => {
    expect(DEFAULT_BEHAVIOR_RATIO.forage).toBe(10);
  });

  it('fight === 0', () => {
    expect(DEFAULT_BEHAVIOR_RATIO.fight).toBe(0);
  });

  it('has exactly forage, fight keys (Phase 10: dig dropped — auto-assigned per CTRL-06)', () => {
    expect(Object.keys(DEFAULT_BEHAVIOR_RATIO).sort()).toStrictEqual(['fight', 'forage']);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 constants regression tests
// ---------------------------------------------------------------------------

import {
  DIG_TICKS_PER_TILE,
  ENTRANCE_SHAFT_DEPTH,
  MAX_ENTRANCES_PER_COLONY,
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
  FOOD_PILE_MAX_ATTEMPTS,
  DIRT_SCATTER_RATIO_FP,
  CHAMBER_QUEEN_WIDTH,
  CHAMBER_QUEEN_HEIGHT,
  CHAMBER_NURSERY_WIDTH,
  CHAMBER_NURSERY_HEIGHT,
  CHAMBER_FOOD_WIDTH,
  CHAMBER_FOOD_HEIGHT,
  SEARCH_LEASH_RADII,
  LEASH_HYSTERESIS_TILES,
} from './constants';

describe('Phase 7 excavation & terrain constants (PRD §2d, §3)', () => {
  it('DIG_TICKS_PER_TILE === 10 (0.5s at 20 Hz)', () => {
    expect(DIG_TICKS_PER_TILE).toBe(10);
  });

  it('ENTRANCE_SHAFT_DEPTH === 2', () => {
    expect(ENTRANCE_SHAFT_DEPTH).toBe(2);
  });

  it('MAX_ENTRANCES_PER_COLONY === 4', () => {
    expect(MAX_ENTRANCES_PER_COLONY).toBe(4);
  });
});

describe('Phase 7 scenario generation constants (PRD §6a, §6b)', () => {
  it('PLAYER_COLONY_ID === 1', () => {
    expect(PLAYER_COLONY_ID).toBe(1);
  });

  it('ENEMY_COLONY_ID === 2', () => {
    expect(ENEMY_COLONY_ID).toBe(2);
  });

  it('PLAYER_START_X === 24', () => {
    expect(PLAYER_START_X).toBe(24);
  });

  it('PLAYER_START_Y === 64', () => {
    expect(PLAYER_START_Y).toBe(64);
  });

  it('ENEMY_START_X === 104', () => {
    expect(ENEMY_START_X).toBe(104);
  });

  it('ENEMY_START_Y === 64', () => {
    expect(ENEMY_START_Y).toBe(64);
  });

  it('STARTING_FOOD === 1280 (Phase 8.5 stabilization bump from PRD target 500)', () => {
    expect(STARTING_FOOD).toBe(1280);
  });

  it('STARTING_WORKERS === 3', () => {
    expect(STARTING_WORKERS).toBe(3);
  });
});

describe('Phase 7 food pile scatter constants (PRD §6a)', () => {
  it('FOOD_PILE_COUNT === 15', () => {
    expect(FOOD_PILE_COUNT).toBe(15);
  });

  it('FOOD_PILE_MIN_COLONY_DISTANCE === 8', () => {
    expect(FOOD_PILE_MIN_COLONY_DISTANCE).toBe(8);
  });

  it('FOOD_PILE_MIN_SEPARATION === 12', () => {
    expect(FOOD_PILE_MIN_SEPARATION).toBe(12);
  });

  it('FOOD_PILE_MAX_ATTEMPTS === 1000', () => {
    expect(FOOD_PILE_MAX_ATTEMPTS).toBe(1000);
  });
});

describe('Phase 7 surface scatter constants (PRD §6a)', () => {
  it('DIRT_SCATTER_RATIO_FP === 38 (~15% dirt at 38/256)', () => {
    expect(DIRT_SCATTER_RATIO_FP).toBe(38);
  });
});

describe('Phase 7 chamber dimension constants (PRD §2d)', () => {
  it('CHAMBER_QUEEN_WIDTH === 5', () => {
    expect(CHAMBER_QUEEN_WIDTH).toBe(5);
  });

  it('CHAMBER_QUEEN_HEIGHT === 3', () => {
    expect(CHAMBER_QUEEN_HEIGHT).toBe(3);
  });

  it('CHAMBER_NURSERY_WIDTH === 4', () => {
    expect(CHAMBER_NURSERY_WIDTH).toBe(4);
  });

  it('CHAMBER_NURSERY_HEIGHT === 3', () => {
    expect(CHAMBER_NURSERY_HEIGHT).toBe(3);
  });

  it('CHAMBER_FOOD_WIDTH === 4', () => {
    expect(CHAMBER_FOOD_WIDTH).toBe(4);
  });

  it('CHAMBER_FOOD_HEIGHT === 3', () => {
    expect(CHAMBER_FOOD_HEIGHT).toBe(3);
  });
});

describe('Issue #44 UAT round 3 — leash hysteresis invariants', () => {
  it('LEASH_HYSTERESIS_TILES is strictly less than SEARCH_LEASH_RADII[0]', () => {
    // The v8 deadband threshold is `radius - LEASH_HYSTERESIS_TILES`.
    // If hysteresis ever ≥ smallest radius, the threshold goes ≤ 0 and
    // the gate `bestDist > threshold` becomes always-true — a v8+ RTN
    // ant could never break out, permanently stranding wave-0
    // foragers. Pin the invariant so a future tuning change can't
    // silently regress.
    expect(LEASH_HYSTERESIS_TILES).toBeGreaterThan(0);
    expect(LEASH_HYSTERESIS_TILES).toBeLessThan(SEARCH_LEASH_RADII[0]!);
  });
});
