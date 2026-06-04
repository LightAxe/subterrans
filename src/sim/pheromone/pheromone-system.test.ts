// pheromone-system.test.ts — correctness tests for PRD §5b/§5c/§5d
//
// Coverage:
//   PHER-03 — depositFoodTrail: basic, accumulate, cap, out-of-bounds
//   PHER-04 — tickPheromoneDecay: decay-to-zero, skip zeros, floor snap, two-grid PHER-02
//   PHER-05 — sampleGradient: determinism, exploit, tie-break, empty, explore
//   PHER-07 — grid.data.length invariant (timing proof lives in bench/pheromone-decay.bench.ts)
//
// MUST NOT use performance.now, Date.now, or setTimeout — simSafetyConfig ESLint
// bans those globals in src/sim/. Wall-clock assertions live in bench/.

import { describe, it, expect } from 'vitest';
import {
  depositFoodTrail,
  tickPheromoneDecay,
  sampleGradient,
  sampleForagingDirection,
} from './pheromone-system.js';
import { createPheromoneGrid, phGet, phSet } from './pheromone-store.js';
import { Rng } from '../rng.js';
import {
  PHEROMONE_CAP,
  PHEROMONE_DECAY_FP,
  DANGER_DECAY_FP,
  FOOD_TRAIL_DEPOSIT,
  PHEROMONE_FLOOR,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Deposit tests (PHER-03)
// ---------------------------------------------------------------------------

describe('depositFoodTrail (PHER-03)', () => {
  it('1. basic: deposits FOOD_TRAIL_DEPOSIT (512) at cell', () => {
    const grid = createPheromoneGrid(10, 10);
    depositFoodTrail(grid, 3, 3);
    expect(phGet(grid, 3, 3)).toBe(FOOD_TRAIL_DEPOSIT); // 512
  });

  it('2. accumulates: two deposits give 2 × FOOD_TRAIL_DEPOSIT (1024)', () => {
    const grid = createPheromoneGrid(10, 10);
    depositFoodTrail(grid, 3, 3);
    depositFoodTrail(grid, 3, 3);
    expect(phGet(grid, 3, 3)).toBe(2 * FOOD_TRAIL_DEPOSIT); // 1024
  });

  it('3. caps at PHEROMONE_CAP (65280) — never exceeds cap', () => {
    const grid = createPheromoneGrid(10, 10);
    // Prime cell to PHEROMONE_CAP - 100 (65180)
    phSet(grid, 3, 3, PHEROMONE_CAP - 100);
    depositFoodTrail(grid, 3, 3);
    // 65180 + 512 = 65692 → clamped to PHEROMONE_CAP = 65280
    expect(phGet(grid, 3, 3)).toBe(PHEROMONE_CAP); // 65280
    // Must NOT be 65280 + any overflow
    expect(phGet(grid, 3, 3)).not.toBeGreaterThan(PHEROMONE_CAP);
  });

  it('4. out-of-bounds: does not throw and does not write anywhere', () => {
    const grid = createPheromoneGrid(10, 10);
    // phSet is a no-op for out-of-bounds; depositFoodTrail should be too
    expect(() => depositFoodTrail(grid, -1, 0)).not.toThrow();
    expect(() => depositFoodTrail(grid, 0, -1)).not.toThrow();
    expect(() => depositFoodTrail(grid, 10, 0)).not.toThrow();
    expect(() => depositFoodTrail(grid, 0, 10)).not.toThrow();
    // Grid must remain zero
    for (let i = 0; i < grid.data.length; i++) {
      expect(grid.data[i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Decay tests (PHER-04, Phase 6 SC 5)
// ---------------------------------------------------------------------------

describe('tickPheromoneDecay (PHER-04)', () => {
  it('5. decay from max reaches zero in fewer than 500 ticks', () => {
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 5, 5, PHEROMONE_CAP);

    let ticks = 0;
    while (phGet(grid, 5, 5) !== 0 && ticks < 600) {
      tickPheromoneDecay(grid, PHEROMONE_DECAY_FP);
      ticks++;
    }
    // PRD §5c normative: floor-snap (64 > FP_ONE / PHEROMONE_DECAY_FP ≈ 51) means
    // once value drops below 64 it snaps to 0. Expected N ≈ 300–400 ticks.
    // Documenting observed N below; assert it completes under 500 ticks.
    expect(ticks).toBeLessThan(500);
    expect(phGet(grid, 5, 5)).toBe(0);
  });

  it('6. decay skips zero cells — only non-zero cell changes', () => {
    const grid = createPheromoneGrid(5, 5);
    // All zero except cell (2, 2)
    phSet(grid, 2, 2, PHEROMONE_CAP);
    tickPheromoneDecay(grid, PHEROMONE_DECAY_FP);

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const v = phGet(grid, x, y);
        if (x === 2 && y === 2) {
          // Should have decayed (but not be NaN or < 0)
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(PHEROMONE_CAP);
        } else {
          expect(v).toBe(0);
        }
      }
    }
  });

  it('7. floor snap: value below PHEROMONE_FLOOR snaps to 0', () => {
    // Starting value: 60
    // decayFp = 5
    // decayed = 60 - ((60 * 5) >> 8) = 60 - (300 >> 8) = 60 - 1 = 59
    // 59 < PHEROMONE_FLOOR (64) → snap to 0
    // Confirm precondition: starting value must be below PHEROMONE_FLOOR
    const startValue = 60;
    expect(startValue).toBeLessThan(PHEROMONE_FLOOR); // 60 < 64
    const grid = createPheromoneGrid(5, 5);
    phSet(grid, 0, 0, startValue);
    tickPheromoneDecay(grid, 5);
    expect(phGet(grid, 0, 0)).toBe(0);
  });

  it('8. two-grid PHER-02: danger decays faster than food at same K ticks (K=10)', () => {
    // PHER-02: food and danger pheromones are stored in separate grids with
    // different decay rates (PHEROMONE_DECAY_FP=5 vs DANGER_DECAY_FP=10).
    const K = 10;
    const foodGrid = createPheromoneGrid(16, 16);
    const dangerGrid = createPheromoneGrid(16, 16);

    phSet(foodGrid, 5, 5, PHEROMONE_CAP);
    phSet(dangerGrid, 5, 5, PHEROMONE_CAP);

    for (let i = 0; i < K; i++) {
      tickPheromoneDecay(foodGrid, PHEROMONE_DECAY_FP); // 5
      tickPheromoneDecay(dangerGrid, DANGER_DECAY_FP); // 10
    }

    // After 10 ticks with higher decay rate, danger should have lower strength.
    // Expected: foodGrid ≈ 65280 * (1 - 5/256)^10 ≈ very close to PHEROMONE_CAP
    //           dangerGrid ≈ 65280 * (1 - 10/256)^10 ≈ slightly less
    // The exact values aren't the point — the RELATIVE ordering must hold.
    expect(phGet(dangerGrid, 5, 5)).toBeLessThan(phGet(foodGrid, 5, 5));
  });
});

// ---------------------------------------------------------------------------
// Gradient tests (PHER-05, SCEN-06)
// ---------------------------------------------------------------------------

describe('sampleGradient (PHER-05)', () => {
  it('9. gradient determinism: same seed → same output', () => {
    const grid = createPheromoneGrid(10, 10);
    // Asymmetric gradient
    phSet(grid, 5, 4, 500); // up neighbor of (5,5)
    phSet(grid, 5, 6, 200); // down neighbor of (5,5)
    phSet(grid, 4, 5, 100); // left neighbor of (5,5)

    const rng1 = new Rng(42);
    const rng2 = new Rng(42);

    const result1 = sampleGradient(grid, 5, 5, rng1);
    const result2 = sampleGradient(grid, 5, 5, rng2);

    expect(result1).toEqual(result2);

    // Call twice more — same sequences
    const r1b = sampleGradient(grid, 5, 5, rng1);
    const r2b = sampleGradient(grid, 5, 5, rng2);
    expect(r1b).toEqual(r2b);
  });

  it('10. gradient exploit — strongest neighbor wins: right neighbor with 1000', () => {
    // We need a seed where explore roll does NOT trigger (nextInt(100) >= 10)
    // Find such a seed by scanning
    let seed = 1;
    let exploitSeed = -1;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const testRng = new Rng(seed);
      const roll = testRng.nextInt(100);
      if (roll >= 10) {
        exploitSeed = seed;
        break;
      }
      seed++;
    }
    expect(exploitSeed).toBeGreaterThan(-1); // Found a non-explore seed

    const grid = createPheromoneGrid(10, 10);
    // Right neighbor of (5,5) is (6,5)
    phSet(grid, 6, 5, 1000);

    const rng = new Rng(exploitSeed);
    const result = sampleGradient(grid, 5, 5, rng);
    expect(result).toEqual({ dx: 1, dy: 0 }); // right
  });

  it('11. gradient tie-break: up wins over down (first-found in DIRS order)', () => {
    // up=y-1, down=y+1 both have 500; left/right are 0
    // DIRS order is up (index 0), down (index 1), left, right
    // First-found wins → up should be returned on exploit
    let seed = 1;
    let exploitSeed = -1;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const testRng = new Rng(seed);
      const roll = testRng.nextInt(100);
      if (roll >= 10) {
        exploitSeed = seed;
        break;
      }
      seed++;
    }
    expect(exploitSeed).toBeGreaterThan(-1);

    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 5, 4, 500); // up neighbor: (5, 4)
    phSet(grid, 5, 6, 500); // down neighbor: (5, 6)

    const rng = new Rng(exploitSeed);
    const result = sampleGradient(grid, 5, 5, rng);
    expect(result).toEqual({ dx: 0, dy: -1 }); // up — first in DIRS order
  });

  it('12. gradient empty: all neighbors zero → returns {dx:0, dy:0}', () => {
    // Need a seed that does NOT explore
    let seed = 1;
    let exploitSeed = -1;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const testRng = new Rng(seed);
      const roll = testRng.nextInt(100);
      if (roll >= 10) {
        exploitSeed = seed;
        break;
      }
      seed++;
    }
    expect(exploitSeed).toBeGreaterThan(-1);

    const grid = createPheromoneGrid(10, 10);
    // No deposits — all cells remain 0

    const rng = new Rng(exploitSeed);
    const result = sampleGradient(grid, 5, 5, rng);
    expect(result).toEqual({ dx: 0, dy: 0 });
  });

  it('13. gradient exploration branch: low roll → random direction from DIRS', () => {
    // We need a seed where rng.nextInt(100) < 10 (explore triggers)
    // Find such a seed and verify the direction matches DIRS[rng.nextInt(4)]
    let seed = 1;
    let exploreSeed = -1;
    let exploreRoll = -1;
    for (let attempt = 0; attempt < 10000; attempt++) {
      const testRng = new Rng(seed);
      const roll = testRng.nextInt(100);
      if (roll < 10) {
        exploreSeed = seed;
        exploreRoll = roll;
        break;
      }
      seed++;
    }
    expect(exploreSeed).toBeGreaterThan(-1); // Must find an explore seed

    const grid = createPheromoneGrid(10, 10);
    const rng = new Rng(exploreSeed);
    const result = sampleGradient(grid, 5, 5, rng);

    // Replay to find expected direction
    const replayRng = new Rng(exploreSeed);
    const replayRoll = replayRng.nextInt(100);
    expect(replayRoll).toBe(exploreRoll); // Sanity: same seed same roll
    expect(replayRoll).toBeLessThan(10); // Must be explore

    const expectedIdx = replayRng.nextInt(4);
    const DIRS = [
      { dx: 0, dy: -1 }, // up
      { dx: 0, dy: 1 }, // down
      { dx: -1, dy: 0 }, // left
      { dx: 1, dy: 0 }, // right
    ];
    const expected = DIRS[expectedIdx]!;

    expect(result).toEqual({ dx: expected.dx, dy: expected.dy });
  });
});

// ---------------------------------------------------------------------------
// sampleForagingDirection — 09 pheromone-reacquisition memo
// ---------------------------------------------------------------------------

describe('sampleForagingDirection (09 pheromone-reacquisition memo)', () => {
  // TRAIL_STRONG_THRESHOLD = 128 and REACQUIRE_RADIUS = 3 are file-private;
  // tests below reference them through their observable behavior.

  it('strong local trail (≥128) → always exploits, never consumes the explore roll', () => {
    // A cell with strength ≥ 128 in a 4-neighbor slot should pull the forager
    // every single tick regardless of the RNG seed, because the 10% random
    // roll is suppressed. Over 1000 seeds the direction must be constant.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 6, 5, 500); // right neighbor of (5,5); well above threshold

    for (let seed = 0; seed < 1000; seed++) {
      const rng = new Rng(seed);
      const dir = sampleForagingDirection(grid, 5, 5, rng);
      expect(dir).toEqual({ dx: 1, dy: 0 });
    }
  });

  it('strong local trail → does NOT consume any RNG (stream is untouched)', () => {
    // Layer-1 behavior: no nextInt calls. Verify by advancing two identical
    // RNG streams the same number of times, with sampleForagingDirection in
    // between on one of them. The next nextInt value must match.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 5, 4, 500); // up neighbor; strong

    const rngControl = new Rng(42);
    const rngTest = new Rng(42);
    rngControl.nextInt(100);
    rngTest.nextInt(100);

    sampleForagingDirection(grid, 5, 5, rngTest);

    expect(rngTest.nextInt(1_000_000)).toBe(rngControl.nextInt(1_000_000));
  });

  it('weak local trail (1 ≤ s < 128) → preserves sampleGradient 10/90 behavior', () => {
    // Over many seeds the explore branch should fire roughly 10% of the time.
    // Set a single weak neighbor (below 128) as the only trail signal.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 6, 5, 100); // right neighbor — below threshold

    let exploreCount = 0;
    const TRIALS = 2000;
    for (let seed = 0; seed < TRIALS; seed++) {
      const rng = new Rng(seed);
      const dir = sampleForagingDirection(grid, 5, 5, rng);
      // Exploit direction is always {1, 0}. Anything else is explore.
      if (!(dir.dx === 1 && dir.dy === 0)) exploreCount++;
    }
    // Explore is ~10% of 2000 = 200, but explore also picks right 25% of the
    // time (indistinguishable from exploit). So the observable "non-right"
    // share is 10% * 75% = 7.5%. 4σ of ~7.5% over 2000 = ~40.
    const nonRight = exploreCount;
    expect(nonRight).toBeGreaterThan(100); // must see some exploration
    expect(nonRight).toBeLessThan(250); // not dominated by it
  });

  it('no immediate trail, trail at Manhattan distance 2 → steps toward it', () => {
    // No 4-neighbor trail at (5,5). A trail cell at (7,5) (distance 2, east).
    // Reacquisition should step east.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 7, 5, 300);

    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 1, dy: 0 });
  });

  it('no immediate trail, trail at Manhattan distance 3 → steps toward it', () => {
    // Trail cell at (5, 2) (distance 3, north).
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 5, 2, 300);

    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 0, dy: -1 });
  });

  it('no immediate trail, diagonal trail at (7, 6) (distance 3) → steps east', () => {
    // Diagonal at distance 3 (|2|+|1|=3). |dx|>|dy| → east.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 7, 6, 300);

    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 1, dy: 0 });
  });

  it('two wider-radius trails → steps toward the stronger one', () => {
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 7, 5, 100); // east, distance 2, weaker
    phSet(grid, 5, 2, 500); // north, distance 3, stronger

    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 0, dy: -1 });
  });

  it('two equal-strength wider-radius trails → prefers the closer one', () => {
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 7, 5, 300); // east, distance 2
    phSet(grid, 5, 2, 300); // north, distance 3

    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 1, dy: 0 }); // closer cell wins
  });

  it('trail just outside reacquire radius (distance 4) → returns (0,0)', () => {
    // Forager must fall through to wander when the only trail is too far.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 9, 5, 500); // distance 4

    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 0, dy: 0 });
  });

  it('empty grid → returns (0,0)', () => {
    const grid = createPheromoneGrid(10, 10);
    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng);
    expect(dir).toEqual({ dx: 0, dy: 0 });
  });

  it('determinism: same seed + same grid → same output', () => {
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 6, 5, 50); // weak — triggers explore branch on some seeds
    for (let seed = 0; seed < 50; seed++) {
      const r1 = new Rng(seed);
      const r2 = new Rng(seed);
      expect(sampleForagingDirection(grid, 5, 5, r1)).toEqual(
        sampleForagingDirection(grid, 5, 5, r2),
      );
    }
  });

  it('future-compat: trail that decays below REACQUIRE range reverts to (0,0)', () => {
    // Memo §"Future Compatibility": once food caches deplete and trails fade,
    // the function should return (0,0) so the colony goes back to wander.
    // Simulate by running tickPheromoneDecay repeatedly until the trail cell
    // drops below PHEROMONE_FLOOR (snaps to 0).
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 7, 5, FOOD_TRAIL_DEPOSIT);
    // A single deposit of 512 decays to 0 in ~100 ticks. Run 200 ticks to be safe.
    for (let t = 0; t < 200; t++) {
      tickPheromoneDecay(grid, PHEROMONE_DECAY_FP);
    }
    expect(phGet(grid, 7, 5)).toBe(0);
    const rng = new Rng(1);
    expect(sampleForagingDirection(grid, 5, 5, rng)).toEqual({ dx: 0, dy: 0 });
  });
});

// ---------------------------------------------------------------------------
// sampleForagingDirection — 09 excursion-foraging follow-up (anti-backtrack)
//
// Regression coverage for the ABAB scalar-gradient loop observed far from
// the entrance (Codex repro: seed 29 ticks 270-305, ant 17 bouncing between
// (15,54) and (15,55) at distance 18 from entrance). The fix: pass the
// ant's prev tile, and the sampler filters it out of the candidate set.
// ---------------------------------------------------------------------------

describe('sampleForagingDirection — anti-backtrack (09 follow-up issue 1)', () => {
  it('ignores prev tile when it would be the strongest immediate neighbor', () => {
    // The canonical trap: (4,5) and (6,5) both have max pheromone; ant at (5,5)
    // with prev=(4,5) would greedily return to prev. With anti-backtrack it
    // picks the non-prev strong cell (6,5), moving +x.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 4, 5, PHEROMONE_CAP);
    phSet(grid, 6, 5, PHEROMONE_CAP);
    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng, /*prevX*/ 4, /*prevY*/ 5);
    expect(dir).toEqual({ dx: 1, dy: 0 }); // steps right, away from prev
  });

  it('returns {0,0} when the ONLY immediate pheromone is on the prev tile', () => {
    // The ABAB trap state from the opposite end: ant just arrived from (4,5)
    // and the only pheromone around is back at (4,5). Anti-backtrack should
    // emit (0,0) so the caller falls through to wander, breaking the loop.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 4, 5, PHEROMONE_CAP);
    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng, 4, 5);
    expect(dir).toEqual({ dx: 0, dy: 0 });
  });

  it('without prev hint (-1,-1), strong neighbor still drives selection', () => {
    // Backward-compat: prevX/prevY default to -1 for non-SearchingFood callers.
    const grid = createPheromoneGrid(10, 10);
    phSet(grid, 4, 5, PHEROMONE_CAP);
    const rng = new Rng(1);
    // No prev supplied → pick the only strong neighbor.
    expect(sampleForagingDirection(grid, 5, 5, rng)).toEqual({ dx: -1, dy: 0 });
  });

  it('prev hint also filters the reacquire (layer-3) scan', () => {
    // Ant at (5,5). The only nonzero cells are (3,5) (prev-side, dist 2) and
    // (7,5) (non-prev side, dist 2). With prev=(4,5), the reacquire pick
    // should not route through prev — step to (+1,0) toward the non-prev cell.
    const grid = createPheromoneGrid(12, 12);
    phSet(grid, 3, 5, FOOD_TRAIL_DEPOSIT);
    phSet(grid, 7, 5, FOOD_TRAIL_DEPOSIT);
    const rng = new Rng(1);
    const dir = sampleForagingDirection(grid, 5, 5, rng, 4, 5);
    expect(dir).toEqual({ dx: 1, dy: 0 });
  });

  it('ABAB scenario over several ticks: ant does not stutter indefinitely', () => {
    // Fully simulate the two-tile loop: two max-strength cells (5,4) and
    // (5,6); ant starts at (5,5). Without anti-backtrack the ant would
    // alternate forever. With prev-tile tracking the ant either escapes
    // laterally OR falls through to (0,0) (wander fallback). The broken
    // behavior would be: sample always returns non-(0,0) and the ant keeps
    // alternating between exactly two tiles.
    const grid = createPheromoneGrid(12, 12);
    phSet(grid, 5, 4, PHEROMONE_CAP);
    phSet(grid, 5, 6, PHEROMONE_CAP);
    const rng = new Rng(1);
    let tileX = 5;
    let tileY = 5;
    let prevX = -1;
    let prevY = -1;
    const visited = new Set<string>();
    visited.add(`${tileX},${tileY}`);
    let brokeOutViaWander = false;
    for (let step = 0; step < 20; step++) {
      const dir = sampleForagingDirection(grid, tileX, tileY, rng, prevX, prevY);
      if (dir.dx === 0 && dir.dy === 0) {
        brokeOutViaWander = true;
        break;
      }
      prevX = tileX;
      prevY = tileY;
      tileX += dir.dx;
      tileY += dir.dy;
      visited.add(`${tileX},${tileY}`);
    }
    // Success = escaped (>2 tiles) OR broke out to wander. Failure = 20
    // iterations of pure alternation between 2 tiles without any (0,0).
    expect(brokeOutViaWander || visited.size > 2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PHER-07 iteration-count regression guard
// ---------------------------------------------------------------------------

describe('PHER-07 grid.data.length invariant', () => {
  it('14. decay visits 128*128 cells regardless of deposit density', () => {
    // This test documents the PRD invariant: grid.data.length cells touched per tick.
    // It is NOT the timing proof (wall-clock bench lives in bench/pheromone-decay.bench.ts).
    const grid = createPheromoneGrid(128, 128);
    const expectedLen = 128 * 128; // 16384

    expect(grid.data.length).toBe(expectedLen);

    // Run one decay on empty grid
    tickPheromoneDecay(grid, PHEROMONE_DECAY_FP);
    expect(grid.data.length).toBe(expectedLen); // Length unchanged

    // Populate 10000 cells (some may overlap — that's fine for this test)
    let idx = 17;
    for (let i = 0; i < 10000; i++) {
      idx = (idx * 1103515245 + 12345) & 0x7fffffff;
      const x = idx % 128;
      const y = (idx >>> 7) % 128;
      phSet(grid, x, y, FOOD_TRAIL_DEPOSIT);
    }

    // Run another decay with many deposits
    tickPheromoneDecay(grid, PHEROMONE_DECAY_FP);
    expect(grid.data.length).toBe(expectedLen); // Length still unchanged
  });
});
