import { describe, it, expect } from 'vitest';
import { tickPheromoneDecay } from '../src/sim/pheromone/pheromone-system.js';
import { createPheromoneGrid, phSet } from '../src/sim/pheromone/pheromone-store.js';
import { PHEROMONE_DECAY_FP, FOOD_TRAIL_DEPOSIT } from '../src/sim/constants.js';

// PHER-07 / Phase 6 SC 10 — decay cost is proportional to grid.data.length, NOT deposit count.
// Ran outside src/sim/** so performance.now is allowed (simSafetyConfig ESLint glob does not apply here).
describe('pheromone decay wall-clock benchmark (PHER-07 / Phase 6 SC 10)', () => {
  it('decay time with 10000 deposits < 3x decay time with 100 deposits on identical grid size', () => {
    const WIDTH = 128;
    const HEIGHT = 128;
    const ITERATIONS = 200; // amortize per-run noise
    const WARMUP_RUNS = 20; // JIT warmup

    function buildGrid(depositCount: number): ReturnType<typeof createPheromoneGrid> {
      const grid = createPheromoneGrid(WIDTH, HEIGHT);
      // Deterministic "random" scatter via a simple index walker (no Rng import needed; this is prep work).
      let idx = 17;
      for (let i = 0; i < depositCount; i++) {
        idx = (idx * 1103515245 + 12345) & 0x7fffffff;
        const x = idx % WIDTH;
        const y = (idx >>> 7) % HEIGHT;
        phSet(grid, x, y, FOOD_TRAIL_DEPOSIT);
      }
      return grid;
    }

    function timeDecay(depositCount: number): number {
      const grid = buildGrid(depositCount);
      // Warmup
      for (let i = 0; i < WARMUP_RUNS; i++) tickPheromoneDecay(grid, PHEROMONE_DECAY_FP);
      // Re-prime after warmup erodes deposits
      const primed = buildGrid(depositCount);
      const start = performance.now();
      for (let i = 0; i < ITERATIONS; i++) tickPheromoneDecay(primed, PHEROMONE_DECAY_FP);
      return performance.now() - start;
    }

    const timeAt100 = timeDecay(100);
    const timeAt10k = timeDecay(10000);

    // Tolerance: 3x generous upper bound. On a well-behaved O(grid_size) implementation
    // the ratio should be close to 1.0 because both runs visit the same 128*128 = 16384 cells.
    // The 3x tolerance absorbs CI jitter, GC pauses, and inner-loop branch-prediction effects
    // from the higher deposit density (more non-zero cells means more decay arithmetic, but that
    // is a constant-factor delta, not an O(n) dependency on deposit count).
    expect(timeAt10k).toBeLessThan(3 * timeAt100);
    // Sanity: both should complete in reasonable wall time (soft assertion)
    expect(timeAt10k).toBeLessThan(5000); // 5 seconds absolute ceiling per 200 iterations
    expect(timeAt100).toBeGreaterThan(0);
  });
});
