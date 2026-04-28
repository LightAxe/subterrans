// allocation-system.test.ts — Tests for PRD §7a/§7b allocation math (Phase 10 amendment).
//
// Phase 10 amendment (CTRL-01' / CTRL-06): BehaviorRatio is two-role
// {forage, fight}; the WorkerAllocation `dig` field is always 0 from
// allocateWorkers. Auto-dig (Plan 02 step 10a) writes
// colony.computedAllocation.dig from need.dig AFTER allocateWorkers runs;
// it consumes from the Idle pool, not from this split (D-02 wait-no-preempt).
//
// Coverage:
//   - computeNurseCount (floor, cap-by-ceil(w/4), cap-by-workerCount, zeroes, no-nursery gate)
//   - computeNurseCount cap table (ceil(w/4) for w=0..17)
//   - allocateWorkers PRD §8b' scenarios (high-brood, two-way split, CLNY-09)
//   - Edge cases (zero ratio, zero workers, high brood cap, remainder=1, fight-heavy, unequal ratio)
//   - 09 reproduction-gate memo: hasNursery=false → nurse=0 regardless of brood
//   - Phase 10 contract: returned `dig` is always 0 (auto-dig owns the live value)
//   - CTRL-04 immediate allocation proof
//   - Sum invariant property sweep — nurse + forage + fight === workerCount

import { describe, it, expect } from 'vitest';
import { computeNurseCount, allocateWorkers } from './allocation-system.js';

// ---------------------------------------------------------------------------
// computeNurseCount
// ---------------------------------------------------------------------------

describe('computeNurseCount', () => {
  it('basic: floor(12/3)=4, cap ceil(10/4)=3 → 3 (09 memo cap wins)', () => {
    expect(computeNurseCount(12, 10, true)).toBe(3);
  });

  it('capped by ceil(w/4): floor(30/3)=10, cap ceil(3/4)=1 → 1', () => {
    expect(computeNurseCount(30, 3, true)).toBe(1);
  });

  it('low brood below cap: floor(3/3)=1, cap ceil(10/4)=3 → 1 (needed wins)', () => {
    expect(computeNurseCount(3, 10, true)).toBe(1);
  });

  it('zero brood: no nurses needed → 0', () => {
    expect(computeNurseCount(0, 10, true)).toBe(0);
  });

  it('zero workers: cap wins → 0', () => {
    expect(computeNurseCount(6, 0, true)).toBe(0);
  });

  it('09 memo gate: hasNursery=false → 0 even with heavy brood', () => {
    expect(computeNurseCount(100, 10, false)).toBe(0);
  });

  it('09 memo gate: hasNursery=false + low brood → 0', () => {
    expect(computeNurseCount(3, 10, false)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeNurseCount — ceil(workerCount/4) cap table
// ---------------------------------------------------------------------------

describe('computeNurseCount — ceil(w/4) cap table', () => {
  // Fixed high brood (1000) so cap is always the binding constraint.
  const HIGH_BROOD = 1000;
  const table: Array<[number, number]> = [
    [0, 0], [1, 1], [2, 1], [3, 1], [4, 1],
    [5, 2], [6, 2], [7, 2], [8, 2],
    [9, 3], [10, 3], [11, 3], [12, 3],
    [13, 4], [16, 4], [17, 5],
  ];
  for (const [workers, expectedCap] of table) {
    it(`workers=${workers} → max nurses=${expectedCap}`, () => {
      expect(computeNurseCount(HIGH_BROOD, workers, true)).toBe(expectedCap);
    });
  }
});

// ---------------------------------------------------------------------------
// allocateWorkers — PRD §8b' scenarios (Phase 10 two-role amendment)
// ---------------------------------------------------------------------------

describe('allocateWorkers — PRD §8b\' scenarios', () => {
  it('5. Nurse Carveout at High Brood: workerCount=3, broodCount=30, forage-only, hasNursery', () => {
    // floor(30/3)=10, cap ceil(3/4)=1 → nurse=1; available=2 → forage=2
    const result = allocateWorkers(3, 30, { forage: 10, fight: 0 }, true);
    expect(result).toEqual({ nurse: 1, forage: 2, dig: 0, fight: 0 });
    expect(result.nurse + result.forage + result.fight).toBe(3);
  });

  it('6. Two-Way Split with Remainder: 10 workers, 1:1 forage:fight, 0 brood — dig:0 from allocateWorkers', () => {
    // Phase 10 amendment: dig is no longer ratio-driven; auto-dig owns the live count.
    // nurseCount=0, available=10; floor(10/2)=5 each, sum=10, no remainder.
    const result = allocateWorkers(10, 0, { forage: 1, fight: 1 }, true);
    expect(result).toEqual({ nurse: 0, forage: 5, dig: 0, fight: 5 });
    expect(result.nurse + result.forage + result.fight).toBe(10);
  });

  it('7. CLNY-09 proof: workerCount=10, broodCount=3, 100% forage → nurse enforced', () => {
    // floor(3/3)=1, cap ceil(10/4)=3 → nurse=1; available=9; all forage → forage=9
    const result = allocateWorkers(10, 3, { forage: 10, fight: 0 }, true);
    expect(result).toEqual({ nurse: 1, forage: 9, dig: 0, fight: 0 });
    expect(result.nurse + result.forage + result.fight).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// allocateWorkers — edge cases
// ---------------------------------------------------------------------------

describe('allocateWorkers — edge cases', () => {
  it('8. Zero ratio sum: all non-nurse workers go idle (returned as 0)', () => {
    const result = allocateWorkers(5, 0, { forage: 0, fight: 0 }, true);
    expect(result).toEqual({ nurse: 0, forage: 0, dig: 0, fight: 0 });
  });

  it('9. Zero workers: all fields are 0', () => {
    const result = allocateWorkers(0, 0, { forage: 10, fight: 0 }, true);
    expect(result).toEqual({ nurse: 0, forage: 0, dig: 0, fight: 0 });
  });

  it('10. High brood with nursery: cap by ceil(5/4)=2', () => {
    // floor(15/3)=5, cap ceil(5/4)=2 → nurse=2; available=3 → forage=3
    const result = allocateWorkers(5, 15, { forage: 10, fight: 0 }, true);
    expect(result).toEqual({ nurse: 2, forage: 3, dig: 0, fight: 0 });
    expect(result.nurse + result.forage + result.fight).toBe(5);
  });

  it('11. Remainder = 1 (forage gets the bonus): 11 workers, 1:1 forage:fight', () => {
    // Phase 10 amendment: with two roles, max remainder is 1 (forage takes it).
    // nurseCount=0, available=11; floor(11/2)=5 each, sum=10, remainder=1 → forage+1
    const result = allocateWorkers(11, 0, { forage: 1, fight: 1 }, true);
    expect(result).toEqual({ nurse: 0, forage: 6, dig: 0, fight: 5 });
    expect(result.nurse + result.forage + result.fight).toBe(11);
  });

  it('12. Fight-heavy: 100% fight → no remainder (exact division)', () => {
    const result = allocateWorkers(10, 0, { forage: 0, fight: 1 }, true);
    expect(result).toEqual({ nurse: 0, forage: 0, dig: 0, fight: 10 });
    expect(result.nurse + result.forage + result.fight).toBe(10);
  });

  it('13. Unequal ratio 3:1 forage:fight: 6 workers → forage=4 (with remainder), fight=1', () => {
    // Phase 10 amendment two-role math:
    // total=4; forage = (6*3/4)|0 = 4; fight = (6*1/4)|0 = 1; remainder = 6 - 4 - 1 = 1 → forage+1=5
    const result = allocateWorkers(6, 0, { forage: 3, fight: 1 }, true);
    expect(result).toEqual({ nurse: 0, forage: 5, dig: 0, fight: 1 });
    expect(result.nurse + result.forage + result.fight).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Phase 10 contract — `dig` is always 0 from allocateWorkers (CTRL-06 owns it)
// ---------------------------------------------------------------------------

describe('allocateWorkers — Phase 10 dig contract', () => {
  it('returned `dig` is 0 across many shape combinations (auto-dig owns the live value)', () => {
    const inputs: Array<[number, number, { forage: number; fight: number }, boolean]> = [
      [10,  0,  { forage: 10, fight: 0 }, true],
      [10,  0,  { forage: 0,  fight: 10 }, true],
      [10,  0,  { forage: 1,  fight: 1 },  true],
      [11,  0,  { forage: 1,  fight: 1 },  true],
      [3,   30, { forage: 10, fight: 0 }, true],
      [10,  3,  { forage: 10, fight: 0 }, true],
      [10,  30, { forage: 1,  fight: 1 },  false],
      [50,  0,  { forage: 10, fight: 5 },  true],
      [0,   0,  { forage: 10, fight: 0 }, true],
      [5,   0,  { forage: 0,  fight: 0 },  true],
    ];
    for (const [workers, brood, ratio, hasNursery] of inputs) {
      const result = allocateWorkers(workers, brood, ratio, hasNursery);
      expect(result.dig).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 09 reproduction-gate memo — hasNursery=false always yields nurse=0
// ---------------------------------------------------------------------------

describe('allocateWorkers — 09 memo: hasNursery=false gate', () => {
  it('no nursery + brood + forage-favored: nurse=0, workers go to forage', () => {
    // Regression shape: 3 workers, heavy brood, forage-favored ratio, NO Nursery.
    // Without the gate, pre-09 allocation would force all 3 into nursing and
    // starve the colony. Post-09: nurse=0, available=3, all → forage.
    const result = allocateWorkers(3, 30, { forage: 10, fight: 0 }, false);
    expect(result).toEqual({ nurse: 0, forage: 3, dig: 0, fight: 0 });
    expect(result.nurse + result.forage + result.fight).toBe(3);
  });

  it('no nursery + high brood + 10 workers, 1:1 forage:fight: nurse=0, full split', () => {
    // 10 workers, 30 brood, 1:1 forage:fight, no Nursery → brood is inert.
    // floor(10/2)=5 each, sum=10, no remainder.
    const result = allocateWorkers(10, 30, { forage: 1, fight: 1 }, false);
    expect(result).toEqual({ nurse: 0, forage: 5, dig: 0, fight: 5 });
    expect(result.nurse + result.forage + result.fight).toBe(10);
  });

  it('no nursery + zero brood: identical to hasNursery=true (nurse=0 both ways)', () => {
    const noNursery  = allocateWorkers(10, 0, { forage: 3, fight: 1 }, false);
    const yesNursery = allocateWorkers(10, 0, { forage: 3, fight: 1 }, true);
    expect(noNursery).toEqual(yesNursery);
  });

  it('no nursery leaves legacy brood inert: workers handle non-nurse tasks only', () => {
    // Save-compat: a legacy save may ship brood without a completed Nursery.
    // The gate must not crash; brood sits inert and workers handle foraging etc.
    const result = allocateWorkers(5, 8, { forage: 5, fight: 0 }, false);
    expect(result.nurse).toBe(0);
    expect(result.nurse + result.forage + result.fight).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CTRL-04 — allocation returns immediately (no tick state)
// ---------------------------------------------------------------------------

describe('allocateWorkers — CTRL-04 immediate allocation', () => {
  it('14. CTRL-04: two consecutive calls with different ratios return independent results', () => {
    const alloc1 = allocateWorkers(10, 0, { forage: 10, fight: 0 }, true);
    expect(alloc1.forage).toBe(10);
    expect(alloc1.dig).toBe(0);
    expect(alloc1.fight).toBe(0);

    const alloc2 = allocateWorkers(10, 0, { forage: 0, fight: 10 }, true);
    expect(alloc2.forage).toBe(0);
    expect(alloc2.dig).toBe(0);
    expect(alloc2.fight).toBe(10);

    // alloc1 is unchanged (pure function, no shared state)
    expect(alloc1.forage).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Sum invariant property sweep — 20 fixed inputs × hasNursery={true,false}
// Phase 10 amendment: dig is 0 from allocateWorkers, so sum is nurse + forage + fight.
// ---------------------------------------------------------------------------

describe('allocateWorkers — sum invariant', () => {
  const cases: Array<[number, number, { forage: number; fight: number }]> = [
    [10,  5,  { forage: 3,  fight: 1 }],
    [100, 50, { forage: 1,  fight: 1 }],
    [1,   0,  { forage: 1,  fight: 0 }],
    [50,  0,  { forage: 10, fight: 5 }],
    [0,   0,  { forage: 10, fight: 0 }],
    [20,  3,  { forage: 7,  fight: 1 }],
    [15,  15, { forage: 1,  fight: 1 }],
    [30,  90, { forage: 10, fight: 0 }],
    [7,   6,  { forage: 2,  fight: 2 }],
    [8,   0,  { forage: 3,  fight: 3 }],
    [12,  9,  { forage: 5,  fight: 2 }],
    [25,  0,  { forage: 10, fight: 0 }],
    [5,   5,  { forage: 10, fight: 5 }],
    [3,   3,  { forage: 1,  fight: 0 }],
    [99,  0,  { forage: 4,  fight: 3 }],
    [10,  30, { forage: 1,  fight: 0 }],
    [6,   6,  { forage: 0,  fight: 10 }],
    [40,  12, { forage: 6,  fight: 2 }],
    [11,  0,  { forage: 1,  fight: 1 }],
    [100, 0,  { forage: 10, fight: 0 }],
  ];

  it('15a. nurse + forage + fight === workerCount — hasNursery=true (Phase 10: dig is 0)', () => {
    for (const [workerCount, broodCount, ratio] of cases) {
      const result = allocateWorkers(workerCount, broodCount, ratio, true);
      expect(result.dig).toBe(0);
      const sum = result.nurse + result.forage + result.fight;
      expect(sum).toBe(workerCount);
    }
  });

  it('15b. nurse + forage + fight === workerCount — hasNursery=false (Phase 10: dig is 0)', () => {
    for (const [workerCount, broodCount, ratio] of cases) {
      const result = allocateWorkers(workerCount, broodCount, ratio, false);
      expect(result.nurse).toBe(0);
      expect(result.dig).toBe(0);
      const sum = result.nurse + result.forage + result.fight;
      expect(sum).toBe(workerCount);
    }
  });
});
