// src/render/ai-controller.integration.test.ts
// Phase 09.1 Plan 01 (REQ-C1) — AI-only 3000-tick integration test.
//
// Validates that the rule-based AI controller from plan 09-05 drives a cold
// scenario to a functional nest (Queen + FoodStorage + Nursery chambers on
// anchor-Open tiles, ≥1 open entrance, foodStored > 0, non-declining worker
// count across the last 500 ticks).
//
// ESLint FNDN-04 disposition: B (relocate).
//   The sim→render boundary rule (eslint.config.ts §simSafetyConfig) has NO
//   *.test.ts exemption, so a test file at src/sim/*.test.ts importing from
//   src/render/ would fail lint. This file lives at src/render/ alongside
//   ai-controller.test.ts (the existing unit test) and ai-controller.ts —
//   matching project convention (tests colocate with the module under test)
//   and requiring zero ESLint exceptions.
//
// Unlike the makeWorld shortcut used by ai-controller.test.ts (which bypasses
// sim), this test drives a real createScenario world through the real tick()
// dispatcher, exactly as GameScene.onBeforeTick would.

import { describe, it, expect } from 'vitest';

import { runAIController } from './ai-controller.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { ChamberType } from '../sim/enums.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { colonyFoodTotal } from '../sim/colony/colony-system.js';

// -----------------------------------------------------------------------------
// Scenario constants
// -----------------------------------------------------------------------------

const SEED = 42;
const TOTAL_TICKS = 3000;
const TRAJECTORY_WINDOW_START = 2500;   // track workerCount from tick 2500..3000
const DIAGNOSTIC_INTERVAL = 500;         // log snapshot every 500 ticks (pre-audit)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface Snapshot {
  tick: number;
  workerCount: number;
  foodStored: number;
  eggCount: number;
  larvaeCount: number;
  chamberTypes: ChamberType[];
  openEntranceCount: number;
}

function snapshotColony(world: WorldState, colony: ColonyRecord): Snapshot {
  return {
    tick: world.tick,
    workerCount: colony.workerCount,
    // Issue #15: deposits now land in chamber.foodStored, not the pool. The
    // diagnostic snapshot reads colonyFoodTotal so the value reflects the
    // colony's actual stockpile rather than just the entrance-shaft fallback.
    foodStored: colonyFoodTotal(colony),
    eggCount: colony.eggCount,
    larvaeCount: colony.larvaeCount,
    chamberTypes: colony.chambers.map((c) => c.chamberType),
    openEntranceCount: colony.entrances.filter((e) => e.isOpen).length,
  };
}

function countChamber(colony: ColonyRecord, type: ChamberType): number {
  return colony.chambers.filter((c) => c.chamberType === type).length;
}

function findChamber(colony: ColonyRecord, type: ChamberType) {
  return colony.chambers.find((c) => c.chamberType === type);
}

// -----------------------------------------------------------------------------
// Test
// -----------------------------------------------------------------------------

describe('AI-only scenario 3000 ticks', () => {
  it('AI colony autonomously builds Queen + FoodStorage + Nursery and sustains itself (REQ-C1)', () => {
    // --- Setup: real scenario world; AI drives ENEMY colony only ---
    const world = createScenario(SEED);

    // Sanity: both colonies exist after createScenario
    const aiColony = world.colonies[ENEMY_COLONY_ID];
    const playerColony = world.colonies[PLAYER_COLONY_ID];
    expect(aiColony, 'AI colony should exist at ENEMY_COLONY_ID').toBeDefined();
    expect(playerColony, 'Player colony should exist at PLAYER_COLONY_ID').toBeDefined();

    // --- Trajectory tracking + pre-audit diagnostics ---
    const workerCountTrajectory: number[] = [];
    const diagnostics: Snapshot[] = [];

    // --- 3000-tick loop: runAIController → drain queue → tick ---
    //
    // Exactly mirrors platform/game-loop.ts:76-80 (onBeforeTick →
    // commandQueue.splice(0) → tickFn(world, cmds)), except onBeforeTick here
    // is "call runAIController for the AI colony only". The player colony is
    // a no-op observer: no input, no commands — just processed by the sim.
    for (let t = 0; t < TOTAL_TICKS; t++) {
      runAIController(world, ENEMY_COLONY_ID);
      const cmds = world.commandQueue.splice(0);
      tick(world, cmds);

      // Track workerCount across the final 500-tick window
      if (t >= TRAJECTORY_WINDOW_START) {
        workerCountTrajectory.push(aiColony!.workerCount);
      }

      // Diagnostic checkpoint — retained as a sparse snapshot array so that
      // the failure messages below can show the AI colony's trajectory if an
      // assertion fires. No per-checkpoint console.log: the pre-audit
      // diagnostics from Task 1 (grid-state breakdown, allocation, queen
      // pose) were removed in Task 3 REFACTOR once the GREEN fix landed.
      if ((t + 1) % DIAGNOSTIC_INTERVAL === 0) {
        diagnostics.push(snapshotColony(world, aiColony!));
      }
    }

    // --- End-state snapshot (for failure diagnostics) ---
    const finalState = snapshotColony(world, aiColony!);
    const ctx = `Final state: ${JSON.stringify(finalState)}. ` +
      `Trajectory[2500..3000] workerCount (${workerCountTrajectory.length} samples): ` +
      `first=${workerCountTrajectory[0]} last=${workerCountTrajectory[workerCountTrajectory.length - 1]}. ` +
      `Diagnostics: ${JSON.stringify(diagnostics)}`;

    // --- Assertions ---

    // 1. ≥1 open entrance
    const openEntrances = aiColony!.entrances.filter((e) => e.isOpen);
    expect(openEntrances.length, `Expected ≥1 open entrance. ${ctx}`).toBeGreaterThanOrEqual(1);

    // 2. Queen chamber exists
    const queen = findChamber(aiColony!, ChamberType.Queen);
    expect(queen, `Queen chamber missing. ${ctx}`).toBeDefined();

    // 3. Queen anchor tile is Open in the AI colony's underground grid
    const aiGrid = world.undergroundGrids[ENEMY_COLONY_ID];
    expect(aiGrid, 'AI underground grid should exist').toBeDefined();
    const queenAnchorX = queen!.posX >> FP_SHIFT;
    const queenAnchorY = queen!.posY >> FP_SHIFT;
    expect(
      ugGet(aiGrid!, queenAnchorX, queenAnchorY),
      `Queen anchor (${queenAnchorX},${queenAnchorY}) is not Open. ${ctx}`,
    ).toBe(UndergroundTileState.Open);

    // 4. FoodStorage chamber exists
    expect(
      findChamber(aiColony!, ChamberType.FoodStorage),
      `FoodStorage chamber missing. ${ctx}`,
    ).toBeDefined();

    // 5. Nursery chamber exists
    expect(
      findChamber(aiColony!, ChamberType.Nursery),
      `Nursery chamber missing. ${ctx}`,
    ).toBeDefined();

    // 6. Food stored > 0 (issue #15: read total stash — entrance pool plus
    // every FoodStorage chamber. Post-#15 deposits land in chambers, not the
    // pool, so reading colony.foodStored alone would silently regress to
    // "did the entrance-shaft fallback fire at least once" — not what this
    // assertion is testing.)
    {
      const total = colonyFoodTotal(aiColony!);
      expect(total, `AI colony food total is not > 0 (found ${total}). ${ctx}`)
        .toBeGreaterThan(0);
    }

    // 7. Chamber uniqueness: exactly 1 Queen, exactly 1 Nursery, ≥1 FoodStorage
    expect(
      countChamber(aiColony!, ChamberType.Queen),
      `Expected exactly 1 Queen chamber. ${ctx}`,
    ).toBe(1);
    expect(
      countChamber(aiColony!, ChamberType.Nursery),
      `Expected exactly 1 Nursery chamber. ${ctx}`,
    ).toBe(1);
    expect(
      countChamber(aiColony!, ChamberType.FoodStorage),
      `Expected ≥1 FoodStorage chamber. ${ctx}`,
    ).toBeGreaterThanOrEqual(1);

    // 8. Non-declining workerCount across ticks 2500..3000 (colony is
    //    self-sustaining in steady state).
    const startWC = workerCountTrajectory[0]!;
    const endWC = workerCountTrajectory[workerCountTrajectory.length - 1]!;
    expect(
      endWC,
      `workerCount declined across ticks ${TRAJECTORY_WINDOW_START}..${TOTAL_TICKS}: ` +
      `started=${startWC} ended=${endWC}. ${ctx}`,
    ).toBeGreaterThanOrEqual(startWC);
  }, 60_000); // 3000 ticks + assertions may take >5s default; allow 60s budget.
});
