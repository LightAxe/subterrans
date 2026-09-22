// src/render/ai-controller.integration.test.ts
// Phase 09.1 Plan 01 (REQ-C1) — AI-only 6000-tick integration test.
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
// Issue #33 — extended from 3000 to 6000 ticks. The deeper Queen target
// (AI_QUEEN_CHAMBER_DEPTH = 18, was 10) lengthens bootstrap dig time before
// the Queen chamber can land at its acceptable depth band; the OLD shallow
// target placed the Queen at Y≈1 by tick 100. The new depth gate is the
// whole point of issue #33 (chambers spread vertically, max chamber Y > 15
// per the acceptance criteria), so the slower bootstrap is the intended
// trade-off.
const TOTAL_TICKS = 8000;
const TRAJECTORY_WINDOW_START = 7000; // track workerCount from tick 7000..8000
// S4 change: queen now lays on first eligible tick (elapsed-since-last-lay gate), not at modulo
// boundaries. In the AI scenario, chambers complete ~tick 4000; first egg lays immediately,
// creating ~6 larvae by tick 6000. First new worker matures at ~tick 6700 (4000+2700).
// Window extended from 5500..6000 → 7000..8000 so the monitoring window contains the
// stable post-first-worker-maturation state.
const DIAGNOSTIC_INTERVAL = 500; // log snapshot every 500 ticks (pre-audit)

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

describe('AI-only scenario 6000 ticks', () => {
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
    // world.tick at each trajectory sample, so the predation floor below can be
    // evaluated per sample without guessing how loop index maps onto event ticks.
    const trajectoryTicks: number[] = [];
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
        trajectoryTicks.push(world.tick);
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
    const ctx =
      `Final state: ${JSON.stringify(finalState)}. ` +
      `Trajectory[${TRAJECTORY_WINDOW_START}..${TOTAL_TICKS}] workerCount (${workerCountTrajectory.length} samples): ` +
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
      expect(total, `AI colony food total is not > 0 (found ${total}). ${ctx}`).toBeGreaterThan(0);
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

    // 8. workerCount does not decline across the trajectory window for any reason the
    //    colony itself controls (it is self-sustaining in steady state).
    //
    // The bar is start-of-window headcount MINUS the workers the neutral spider ate
    // during the window, so predation is accounted for rather than ignored. Losing an
    // ant to the spider is not a failure of the colony's economy; failing to hold its
    // own population otherwise is.
    //
    // The floor is a RUNNING one: at every sample it is start-of-window headcount
    // minus the spider kills reflected in workerCount SO FAR (see the offset note at
    // the loop below). A single end-of-window figure would let a late kill
    // retroactively excuse an early non-predation dip; this cannot.
    //
    // This replaces a strict `endWC >= startWC`, which was measuring noise: the AI
    // colony holds a 2-4 worker steady state here, so a single spider kill flipped it.
    // That fragility is PRE-EXISTING and seed-dependent — the strict form already
    // fails today at seed 10 (workerCount 3 -> 2) while passing at seed 42. V39 (the
    // spider tie-break seat-bias fix) swapped which ant the spider bites, so the
    // strict form would now fail at seed 42 and pass at seed 10; neither outcome says
    // anything about self-sustenance. The running floor holds at BOTH the pre-V39
    // behaviour and V39, on all 17 seeds sampled (1-16 + 42), and is strictly sharper
    // than the old form in the case that matters: it checks EVERY sample, so a
    // mid-window dip that recovers by tick 8000 is caught where an endpoint
    // comparison missed it.
    //
    // Counting from the event log is safe here: the cap in emitEvent
    // (PLAYTRACE_EVENT_CAP_PER_ROUND = 2000, oldest combat_kill evicted first) is
    // nowhere near reached — this run emits ~20-30 events total with
    // droppedCombatKillCount === 0 — so no in-window kill can have been evicted. The
    // assertion below fails loudly if that ever stops being true.
    expect(
      world.droppedCombatKillCount,
      `combat_kill events were evicted (${world.droppedCombatKillCount}), so the ` +
        `in-window spider-kill count below would undercount. ${ctx}`,
    ).toBe(0);
    const spiderKillTicks: number[] = [];
    for (const ev of world.events) {
      if (ev.type !== 'combat_kill') continue;
      const { killer, victim } = ev.payload;
      if (killer.kind !== 'Spider') continue;
      if (victim.colonyId !== ENEMY_COLONY_ID || victim.kind === 'Queen') continue;
      spiderKillTicks.push(ev.tick);
    }
    spiderKillTicks.sort((a, b) => a - b);

    const startWC = workerCountTrajectory[0]!;
    const startTick = trajectoryTicks[0]!;
    for (let i = 0; i < workerCountTrajectory.length; i++) {
      const sampleTick = trajectoryTicks[i]!;
      // Two one-tick offsets sit between a combat_kill event and the workerCount a
      // sample reads, so a kill stamped K first shows up in the sample stamped K + 2:
      //   - tick() stamps combat_kill with the tick being simulated (despawnAnt, Step 17)
      //     and increments world.tick only at its end (Step 19), while each sample
      //     reads world.tick AFTER tick() returns — so the call that emitted K is the
      //     one whose sample is stamped K + 1.
      //   - despawnAnt never touches colony.workers/workerCount (it only zeroes
      //     ants.alive); the decrement is done by tickDeathCleanup at Step 5 (or by
      //     tickReconcile at Step 2 on a recount tick — same call either way), which
      //     runs BEFORE Step 17 within one call, so it lands in the NEXT call — the
      //     sample stamped K + 2.
      // The (start, sample] window therefore applies to the tick at which a kill is
      // REFLECTED in workerCount, not to its event tick: a kill reflected at or before
      // the baseline sample is already in startWC; one reflected at or before this
      // sample lowers the floor.
      let killsSoFar = 0;
      for (const kt of spiderKillTicks) {
        const reflectedAt = kt + 2;
        if (reflectedAt > startTick && reflectedAt <= sampleTick) killsSoFar += 1;
      }
      const floor = startWC - killsSoFar;
      expect(
        workerCountTrajectory[i]!,
        `workerCount fell below its running predation floor at tick ${sampleTick} ` +
          `(sample ${i} of ${workerCountTrajectory.length}): started=${startWC} at tick ` +
          `${startTick}, spider kills reflected in workerCount since then: ` +
          `${killsSoFar}, so the floor is ${floor}; ` +
          `observed ${workerCountTrajectory[i]!}. ${ctx}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  }, 120_000); // 8000 ticks at ~8ms/tick; allow 120s budget (S4 extended window).
});

// -----------------------------------------------------------------------------
// Issue #33 — spatial-diversity acceptance test.
// Per the issue's acceptance criteria: after ~15 minutes of sim time
// (18000 ticks at 20Hz) with the default scenario, the enemy colony
// footprint should span at least 30% of the underground grid width OR have
// at least one chamber at depth y > 15. The current fix achieves the depth
// criterion via a deeper Queen target (AI_QUEEN_CHAMBER_DEPTH = 18) plus a
// depth gate on findOpenChamberSpot.
// -----------------------------------------------------------------------------

describe('AI-only scenario 18000 ticks (issue #33)', () => {
  it('enemy colony max chamber Y > 15 OR footprint spans >= 30% of grid width', () => {
    const world = createScenario(SEED);
    const aiColony = world.colonies[ENEMY_COLONY_ID]!;

    for (let t = 0; t < 18000; t++) {
      runAIController(world, ENEMY_COLONY_ID);
      const cmds = world.commandQueue.splice(0);
      tick(world, cmds);
    }

    const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    let minX = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const ch of aiColony.chambers) {
      const x = ch.posX >> FP_SHIFT;
      const y = ch.posY >> FP_SHIFT;
      if (x < minX) minX = x;
      if (x + ch.width > maxX) maxX = x + ch.width;
      if (y + ch.height > maxY) maxY = y + ch.height;
    }
    const widthSpan = aiColony.chambers.length > 0 ? maxX - minX : 0;
    const widthRatio = widthSpan / grid.width;
    const ctx =
      `chambers=${aiColony.chambers.length}, ` +
      `widthSpan=${widthSpan} (${(widthRatio * 100).toFixed(1)}%), ` +
      `maxChamberY=${maxY}`;
    expect(
      widthRatio >= 0.3 || maxY > 15,
      `Issue #33 acceptance: span >= 30% width OR max chamber Y > 15. Got ${ctx}.`,
    ).toBe(true);
  }, 120_000);

  it('layout is deterministic — two seeded runs produce identical chamber positions', () => {
    function run(): Array<{ type: number; x: number; y: number }> {
      const world = createScenario(SEED);
      // Smaller tick budget for the determinism check — Queen + FS + Nursery
      // are all in place by tick 6000 (verified by REQ-C1 above), and
      // determinism failures show up immediately, not asymptotically.
      for (let t = 0; t < 6000; t++) {
        runAIController(world, ENEMY_COLONY_ID);
        const cmds = world.commandQueue.splice(0);
        tick(world, cmds);
      }
      const colony = world.colonies[ENEMY_COLONY_ID]!;
      return colony.chambers.map((ch) => ({
        type: ch.chamberType,
        x: ch.posX >> FP_SHIFT,
        y: ch.posY >> FP_SHIFT,
      }));
    }
    expect(run()).toEqual(run());
  }, 60_000);
});
