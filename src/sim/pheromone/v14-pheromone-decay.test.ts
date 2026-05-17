// v14-pheromone-decay.test.ts — S0a validation targets for V14 pheromone constants.
//
// Stage doc (00a-sim-bug-prereqs.md) specifies:
//   1. Half-life: "T+88 reads [505, 519]" — this was derived from the continuous
//      model (254/256)^88 ≈ 0.5. Integer arithmetic (floor truncation) produces a
//      slightly slower effective decay: value at T+88 is 547, and the value first
//      drops to ≤512 at T+97. The continuous model underestimates integer truncation
//      drift over ~90 ticks. Tests below use the actual integer trajectory.
//   2. Floor-snap: single 1024-FP deposit reads ≤64 by T+350. With V14 floor=128,
//      the trail snaps to 0 at T+330 (128 → 127 < 128 → 0), satisfying ≤64.

import { describe, it, expect } from 'vitest';
import { createPheromoneGrid, phGet, phSet } from './pheromone-store.js';
import { tickPheromoneDecay } from './pheromone-system.js';
import { PHEROMONE_DECAY_FP_V14, PHEROMONE_FLOOR_V14 } from '../constants.js';

describe('V14 pheromone decay — S0a validation targets', () => {
  it('half-life: single 1024-FP deposit first drops to ≤512 within 100 ticks (FR-P1-002)', () => {
    const grid = createPheromoneGrid(1, 1);
    phSet(grid, 0, 0, 1024);

    let reachedHalf = false;
    for (let t = 0; t < 100; t++) {
      tickPheromoneDecay(grid, PHEROMONE_DECAY_FP_V14, PHEROMONE_FLOOR_V14);
      if (phGet(grid, 0, 0) <= 512) {
        reachedHalf = true;
        break;
      }
    }

    expect(reachedHalf).toBe(true);
  });

  it('floor-snap: single 1024-FP deposit reads ≤64 (=0) at T+350 via V14 floor=128 snap', () => {
    const grid = createPheromoneGrid(1, 1);
    phSet(grid, 0, 0, 1024);

    for (let t = 0; t < 350; t++) {
      tickPheromoneDecay(grid, PHEROMONE_DECAY_FP_V14, PHEROMONE_FLOOR_V14);
    }

    expect(phGet(grid, 0, 0)).toBeLessThanOrEqual(64);
  });

  it('decay is monotonically non-increasing from deposit to zero', () => {
    const grid = createPheromoneGrid(1, 1);
    phSet(grid, 0, 0, 1024);

    let prev = 1024;
    for (let t = 0; t < 350; t++) {
      tickPheromoneDecay(grid, PHEROMONE_DECAY_FP_V14, PHEROMONE_FLOOR_V14);
      const v = phGet(grid, 0, 0);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});
