// foraging-excursion.test.ts — 09 excursion-foraging memo.
//
// Deterministic multi-seed survival harness for the autonomous-forage bootstrap.
// The memo makes three behavioral claims that only show up at the seed/survival
// level (not at the unit-test level): bounded outward excursions + correlated
// heading + explicit failed-search returns should raise queen survival and
// lower first-deposit latency across a population of seeds compared to the
// pre-change baseline (random-walk fallback).
//
// This file is the CI-runnable floor of that validation — a small sample
// (SEEDS × TICKS chosen to stay under a few seconds at the vitest boundary).
// The larger 200-seed × 2000-tick run lives in scripts/check-foraging-survival.ts
// for local verification against the memo's acceptance targets.
//
// All numbers derive deterministically from the Mulberry32 seed → same seeds
// always produce the same counters, so regression CI catches drift.

import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from './constants.js';
import { isAlive } from './ant/ant-store.js';
import { colonyFoodTotal } from './colony/colony-system.js';

interface SeedStats {
  playerQueenAlive: boolean;
  enemyQueenAlive: boolean;
  playerFoodStored: number;
  enemyFoodStored: number;
  playerFirstDepositTick: number | null;
  enemyFirstDepositTick: number | null;
}

function runSeed(seed: number, maxTicks: number): SeedStats {
  const world = createScenario(seed);
  let playerFirstDepositTick: number | null = null;
  let enemyFirstDepositTick: number | null = null;
  // Issue #15: deposits land in chamber.foodStored, not colony.foodStored
  // alone. Track the colony total (entrance pool + every chamber) so the
  // first-deposit detector remains accurate after the chamber-authoritative
  // refactor. Pre-#15 a pool-only read worked because reconcile projected
  // chamber slices from the pool — a single source of truth — and any
  // deposit grew the pool. Post-#15 only chamberless-fallback deposits
  // grow the pool, so a pool-only detector goes silent the moment the
  // first ant reaches a chamber.
  let prevPlayerFood = colonyFoodTotal(world.colonies[PLAYER_COLONY_ID]!);
  let prevEnemyFood  = colonyFoodTotal(world.colonies[ENEMY_COLONY_ID]!);

  for (let t = 0; t < maxTicks; t++) {
    const cmds = world.commandQueue.splice(0);
    tick(world, cmds);

    const playerFood = colonyFoodTotal(world.colonies[PLAYER_COLONY_ID]!);
    const enemyFood  = colonyFoodTotal(world.colonies[ENEMY_COLONY_ID]!);

    if (playerFirstDepositTick === null && playerFood > prevPlayerFood) {
      playerFirstDepositTick = t;
    }
    if (enemyFirstDepositTick === null && enemyFood > prevEnemyFood) {
      enemyFirstDepositTick = t;
    }
    prevPlayerFood = playerFood;
    prevEnemyFood  = enemyFood;
  }

  const playerColony = world.colonies[PLAYER_COLONY_ID]!;
  const enemyColony  = world.colonies[ENEMY_COLONY_ID]!;

  return {
    playerQueenAlive: isAlive(world.ants, playerColony.queenEntityId),
    enemyQueenAlive:  isAlive(world.ants, enemyColony.queenEntityId),
    playerFoodStored: colonyFoodTotal(playerColony),
    enemyFoodStored:  colonyFoodTotal(enemyColony),
    playerFirstDepositTick,
    enemyFirstDepositTick,
  };
}

describe('foraging excursion survival harness (09 memo)', () => {
  // Small sample for CI — 12 seeds × 1000 ticks keeps this test under a
  // few seconds while still exercising the full tick loop across enough
  // seeds to catch regressions. The 200-seed/2000-tick benchmark lives in
  // scripts/check-foraging-survival.ts for local runs against the memo's
  // acceptance targets.
  const SEEDS = 12;
  const TICKS = 1000;
  const TEST_TIMEOUT_MS = 30000;

  it('queens survive across the seed sample (no-command autonomous foraging)', () => {
    let playerAlive = 0;
    let enemyAlive  = 0;
    let playerDeposits = 0;
    let enemyDeposits  = 0;

    for (let seed = 0; seed < SEEDS; seed++) {
      const s = runSeed(seed, TICKS);
      if (s.playerQueenAlive) playerAlive += 1;
      if (s.enemyQueenAlive)  enemyAlive  += 1;
      if (s.playerFirstDepositTick !== null) playerDeposits += 1;
      if (s.enemyFirstDepositTick  !== null) enemyDeposits  += 1;
    }

    // Acceptance target from the memo is ≥95% at 200 seeds × 2000 ticks.
    // At SEEDS=24 × TICKS=1200 the bar is set conservatively (≥3/4) so a
    // single seed unlucky at this shorter horizon doesn't false-alarm CI.
    // The local 200-seed run (scripts/check-foraging-survival.ts) is the
    // authoritative acceptance gate.
    // Integer threshold arithmetic — no float literals in src/sim/.
    const threshold = (SEEDS * 3) >> 2;
    expect(playerAlive).toBeGreaterThanOrEqual(threshold);
    expect(enemyAlive ).toBeGreaterThanOrEqual(threshold);

    // Autonomous foraging must actually deliver food — if deposits are zero
    // across the sample the autonomy claim is dead on arrival.
    expect(playerDeposits).toBeGreaterThanOrEqual(threshold);
    expect(enemyDeposits ).toBeGreaterThanOrEqual(threshold);
  }, TEST_TIMEOUT_MS);

  it('harness is deterministic — same seed → same stats across runs', () => {
    // Replay regression guard: two runs with the same seed must produce
    // byte-identical outputs. Any accidental non-determinism (per-tick
    // allocation, floats, Date.now, etc.) surfaces here immediately.
    const a = runSeed(7, 600);
    const b = runSeed(7, 600);
    expect(a).toEqual(b);
  });
});
