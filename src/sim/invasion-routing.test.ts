// invasion-routing.test.ts — Phase 09.1 Chunk 3 (plan 09.1-03) VALIDATION tests.
//
// Validates the descent-intent gate that lets player Fighting ants cross
// colony boundaries through open enemy entrances:
//   - Positive: Fighting ant standing on an OPEN enemy entrance descends into
//     the enemy underground grid and ants.currentGridColonyId switches to the
//     enemy colony id (REQ-C3a).
//   - Negative (closed entrance): Fighting ant over a CLOSED enemy entrance
//     does NOT descend (REQ-C3b).
//   - Negative (wrong task): Non-Fighting ant (Foraging) over an OPEN enemy
//     entrance does NOT descend — descent-intent gate keys on AntTask.Fighting
//     (REQ-C3c).
//
// Assertion discipline — MANDATORY for every test:
//   - t=0 precondition assertions confirm the test harness actually staged
//     the scenario correctly (ant zone, tile coords, task, entrance state).
//     Without them a negative test could pass "accidentally" because setup
//     broke, not because the descent gate correctly rejected the ant.
//   - t=N outcome assertions confirm the descent gate produced the expected
//     zone / currentGridColonyId / tile-position / task result.
//
// Scenario: uses createScenario(seed) as the world harness. createScenario
// already seeds:
//   - 2 colonies (PLAYER_COLONY_ID=1, ENEMY_COLONY_ID=2)
//   - Each colony with exactly 1 pre-excavated open entrance at its start tile
//     (ENEMY_START_X=104, ENEMY_START_Y=64 for the enemy colony)
//   - Queen + STARTING_WORKERS workers at each colony's start tile
//
// Test setup places a single additional player ant at the enemy entrance tile
// on the surface and ticks the world forward. The scenario's own workers
// (player forage/enemy forage traffic) are still present but are filtered
// by id when asserting the test-specific ant.

import { describe, it, expect } from 'vitest';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import {
  allocateEntityId,
  LATEST_SIM_VERSION,
  SIM_VERSION_V25_RALLY_RECALL,
} from './types.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  ENEMY_START_X,
  ENEMY_START_Y,
  WORKER_BASE_SPEED,
} from './constants.js';
import type { WorldState } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface InvasionWorld {
  world: WorldState;
  playerAntId: number;
  enemyEntTileX: number;
  enemyEntTileY: number;
}

/**
 * Build an invasion-harness world.
 *
 * Starts from createScenario (2 colonies, each with one pre-excavated open
 * entrance at its start tile — enemy entrance lives at (ENEMY_START_X,
 * ENEMY_START_Y)). Spawns ONE extra player-colony ant sitting exactly on the
 * enemy entrance tile on the surface. Caller chooses task and mutates
 * entrance.isOpen as needed.
 */
function buildInvasionWorld(seed = 42): InvasionWorld {
  const world = createScenario(seed);

  const enemyEntTileX = ENEMY_START_X;
  const enemyEntTileY = ENEMY_START_Y;

  // #164 pre-descent gate: createScenario spawns the enemy queen ON her start
  // tile, which is also the enemy entrance. A foreign Fighter must now engage a
  // surface queen on an entrance rather than descend past her. These tests
  // exercise the descent/routing mechanic on a developed colony, so relocate
  // the enemy queen off the entrance tile (she holds position — no completed
  // Queen chamber) to keep the descent path clear.
  const enemyQueenId = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
  world.ants.posX[enemyQueenId] = (ENEMY_START_X + 6) << FP_SHIFT;

  // Place one player-colony ant at the enemy entrance tile. Position uses
  // tile-center fixed-point coords so the tile-lookup (posX >> FP_SHIFT)
  // lands squarely on (enemyEntTileX, enemyEntTileY).
  const playerAntId = allocateEntityId(world);
  initAnt(world.ants, playerAntId, {
    colonyId: PLAYER_COLONY_ID,
    posX: (enemyEntTileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (enemyEntTileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle, // caller overrides to Fighting / Foraging per test
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    zone: Zone.Surface,
  });
  world.colonies[PLAYER_COLONY_ID]!.workers.push(playerAntId);
  world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;
  // Model real game state: player rallied fighters to enemy entrance with fight ratio > 0.
  // Without these, recall logic fires immediately after descent (targetRatio.fight=0, rp=null).
  world.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: enemyEntTileX, tileY: enemyEntTileY };
  world.colonies[PLAYER_COLONY_ID]!.targetRatio.fight = 5;

  return { world, playerAntId, enemyEntTileX, enemyEntTileY };
}

/**
 * Tile-X of ant (fixed-point → tile coord).
 */
function tileXOf(world: WorldState, id: number): number {
  return world.ants.posX[id]! >> FP_SHIFT;
}
function tileYOf(world: WorldState, id: number): number {
  return world.ants.posY[id]! >> FP_SHIFT;
}

/**
 * Fetch the enemy colony's (single) entrance. createScenario seeds exactly one
 * per colony; if that changes, these tests must be updated.
 */
function enemyEntrance(world: WorldState) {
  const entrances = world.colonies[ENEMY_COLONY_ID]!.entrances;
  expect(entrances.length).toBe(1);
  return entrances[0]!;
}

/**
 * Advance the world N ticks. Drain the command queue each tick (no player
 * commands in these tests).
 */
function tickN(world: WorldState, n: number): void {
  for (let t = 0; t < n; t++) {
    const cmds = world.commandQueue.splice(0);
    tick(world, cmds);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('invasion-routing — Fighting ant descent-intent gate (REQ-C3)', () => {
  // Number of ticks to allow descent. A single tick is enough for the
  // zone-transition block (PRD §5d) to fire once the ant is on an open
  // entrance tile with the right task; we give a few extra ticks so any
  // minor intermediate steering has time to settle.
  const DESCENT_TICKS = 5;

  it('REQ-C3a: Fighting ant descends through OPEN enemy entrance', () => {
    const { world, playerAntId, enemyEntTileX, enemyEntTileY } = buildInvasionWorld();
    world.ants.task[playerAntId] = AntTask.Fighting;
    const entrance = enemyEntrance(world);
    entrance.isOpen = true; // scenario default — restated for clarity

    // MANDATORY t=0 precondition assertions -----------------------------------
    expect(world.ants.zone[playerAntId]).toBe(Zone.Surface);
    expect(tileXOf(world, playerAntId)).toBe(enemyEntTileX);
    expect(tileYOf(world, playerAntId)).toBe(enemyEntTileY);
    expect(world.ants.task[playerAntId]).toBe(AntTask.Fighting);
    expect(entrance.isOpen).toBe(true);
    // Ant's owning colony is PLAYER, but the grid-of-occupancy byte still
    // matches colonyId at spawn time (descent-write invariant from 09.1-00).
    expect(world.ants.colonyId[playerAntId]).toBe(PLAYER_COLONY_ID);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(PLAYER_COLONY_ID);

    // Act --------------------------------------------------------------------
    tickN(world, DESCENT_TICKS);

    // MANDATORY t=N outcome assertions ---------------------------------------
    expect(world.ants.zone[playerAntId]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(ENEMY_COLONY_ID);
  });

  it('REQ-C3a extension: Fighting ant inside foreign grid steps TOWARD nearest hostile (BFS routing)', () => {
    // Strengthened positive test (Task 3): after descent, a Fighter inside
    // the enemy underground grid should consume pickNearestHostileUnderground
    // for target selection and its Manhattan distance to the target should
    // DECREASE across a few more ticks. We don't assert reaching — combat
    // resolution is Chunk 4's concern.
    const { world, playerAntId } = buildInvasionWorld();
    world.ants.task[playerAntId] = AntTask.Fighting;

    // Place an enemy "hostile" ant underground in the enemy grid, a few
    // tiles away from the entrance column so the player invader must step
    // toward it after descent. Uses the same minimal-spawn pattern as
    // buildInvasionWorld but for an ENEMY_COLONY_ID ant.
    const hostileTileX = ENEMY_START_X + 3; // 3 tiles east of shaft column
    const hostileTileY = 5; // 5 tiles below surface
    const hostileId = allocateEntityId(world);
    initAnt(world.ants, hostileId, {
      colonyId: ENEMY_COLONY_ID,
      posX: (hostileTileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (hostileTileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      subTask: 0,
      speed: 0, // pin hostile in place so distance-decrease is unambiguous
      zone: Zone.Underground,
    });
    world.ants.currentGridColonyId[hostileId] = ENEMY_COLONY_ID;
    world.colonies[ENEMY_COLONY_ID]!.workers.push(hostileId);
    world.colonies[ENEMY_COLONY_ID]!.workerCount += 1;
    // Carve an OPEN rectangle (shaft..hostileX, 0..hostileTileY) as a simple
    // connected region for the invader to approach through. (Historically this
    // had to be a rectangle rather than a thin L-corridor because the greedy
    // Manhattan stepper froze at any elbow; issue #163 replaced that with BFS
    // routing, which handles bent corridors — see the dedicated bent-L-corridor
    // regression in ant-system.test.ts.)
    const enemyGrid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    for (let y = 0; y <= hostileTileY; y++) {
      for (let x = ENEMY_START_X; x <= hostileTileX; x++) {
        ugSet(enemyGrid, x, y, UndergroundTileState.Open);
      }
    }

    // Descend the invader first (no pre-check on hostile distance yet —
    // descent-phase doesn't apply hostile targeting).
    tickN(world, DESCENT_TICKS);

    // Precondition for the targeting phase: invader is underground in the
    // enemy grid, hostile is alive and reachable. If these fail, the
    // test harness broke — not the targeting gate.
    expect(world.ants.zone[playerAntId]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(ENEMY_COLONY_ID);
    expect(world.ants.alive[hostileId]).toBe(1);
    expect(world.ants.zone[hostileId]).toBe(Zone.Underground);

    // Distance at the start of the targeting phase.
    const d0 =
      Math.abs(tileXOf(world, playerAntId) - hostileTileX) +
      Math.abs(tileYOf(world, playerAntId) - hostileTileY);

    // Tick forward enough for a visible approach. At WORKER_BASE_SPEED the
    // invader moves ~0.5 tiles/tick along the chosen axis, so 10 ticks
    // gives roughly 5 tiles of motion — enough to close the initial
    // Manhattan gap which is at most ~10 tiles (shaft→hostile).
    tickN(world, 10);

    const dN =
      Math.abs(tileXOf(world, playerAntId) - hostileTileX) +
      Math.abs(tileYOf(world, playerAntId) - hostileTileY);

    // MANDATORY outcome assertions — invader moved toward the hostile.
    expect(world.ants.zone[playerAntId]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(ENEMY_COLONY_ID);
    expect(dN).toBeLessThan(d0); // distance strictly decreased
  });

  it('REQ-C3b: Fighting ant does NOT descend through CLOSED enemy entrance', () => {
    const { world, playerAntId, enemyEntTileX, enemyEntTileY } = buildInvasionWorld();
    world.ants.task[playerAntId] = AntTask.Fighting;
    const entrance = enemyEntrance(world);
    entrance.isOpen = false; // KEY: closed entrance
    // createScenario pre-excavates the shaft (y=0 and y=1 at entrance column)
    // so entrance.isOpen=true on tick 0. checkEntranceCompletion (step 12)
    // re-opens the entrance every tick while the shaft stays Open. Revert
    // the shaft to Solid so the closed-entrance scenario is actually stable
    // across all DESCENT_TICKS.
    const enemyGrid = world.undergroundGrids[ENEMY_COLONY_ID]!;
    ugSet(enemyGrid, entrance.surfaceTileX, 0, UndergroundTileState.Solid);
    ugSet(enemyGrid, entrance.surfaceTileX, 1, UndergroundTileState.Solid);

    // MANDATORY t=0 precondition assertions -----------------------------------
    // Prevents a false green from wrong setup (ant not at tile, or entrance
    // accidentally still open).
    expect(world.ants.zone[playerAntId]).toBe(Zone.Surface);
    expect(tileXOf(world, playerAntId)).toBe(enemyEntTileX);
    expect(tileYOf(world, playerAntId)).toBe(enemyEntTileY);
    expect(world.ants.task[playerAntId]).toBe(AntTask.Fighting);
    expect(entrance.isOpen).toBe(false);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(PLAYER_COLONY_ID);

    // Act --------------------------------------------------------------------
    tickN(world, DESCENT_TICKS);

    // MANDATORY t=N outcome assertions ---------------------------------------
    // Ant must be on Surface (descent was rejected because entrance is closed).
    expect(world.ants.zone[playerAntId]).toBe(Zone.Surface);
    // Reach-decrease proxy: ant didn't wander off. A Fighting ant with no
    // rally / no own-colony entrance fallback in target may not be perfectly
    // stationary — but updateFightAntTargets writes targetPosX/Y to the
    // player's own entrance when no rallyPoint is set, which is at
    // (PLAYER_START_X, PLAYER_START_Y)=(24,64). Over 5 ticks at
    // WORKER_BASE_SPEED=128 (0.5 tiles/tick) that is at most ~2 tiles of
    // drift; we assert it did NOT descend rather than asserting stationary.
    // Critical: currentGridColonyId never flipped to enemy (descent-write did
    // not fire).
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(PLAYER_COLONY_ID);
    // Task is still Fighting — no mid-test task flip confounding the result.
    expect(world.ants.task[playerAntId]).toBe(AntTask.Fighting);
  });

  it('REQ-C3c: Foraging ant does NOT descend through OPEN enemy entrance', () => {
    const { world, playerAntId, enemyEntTileX, enemyEntTileY } = buildInvasionWorld();
    world.ants.task[playerAntId] = AntTask.Foraging; // KEY: wrong task
    const entrance = enemyEntrance(world);
    entrance.isOpen = true;

    // MANDATORY t=0 precondition assertions -----------------------------------
    expect(world.ants.zone[playerAntId]).toBe(Zone.Surface);
    expect(tileXOf(world, playerAntId)).toBe(enemyEntTileX);
    expect(tileYOf(world, playerAntId)).toBe(enemyEntTileY);
    // Confirms Foraging, not accidentally Fighting.
    expect(world.ants.task[playerAntId]).toBe(AntTask.Foraging);
    expect(entrance.isOpen).toBe(true);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(PLAYER_COLONY_ID);

    // Act --------------------------------------------------------------------
    tickN(world, DESCENT_TICKS);

    // MANDATORY t=N outcome assertions ---------------------------------------
    // Ant must be on Surface, task still Foraging, grid-of-occupancy byte
    // still player (the descent-intent gate correctly rejected the descent
    // because task !== AntTask.Fighting, and the existing own-entrance
    // carrier path requires subTask===CarryingFood which this ant lacks).
    expect(world.ants.zone[playerAntId]).toBe(Zone.Surface);
    expect(world.ants.task[playerAntId]).toBe(AntTask.Foraging);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(PLAYER_COLONY_ID);
  });
});

// ---------------------------------------------------------------------------
// #174 — foreign-grid recall keys on the rally point, not the fight ratio.
//
// Repro: the player rallies fighters to an OPEN enemy entrance (an explicit
// "invade here" command) but leaves the fight ratio at 0 ("don't make MORE
// fighters"). Pre-V25, the `targetRatio.fight === 0` disjunct in the recall
// predicate fired, so each invader ascended the instant it reached tileY=0 on
// the enemy entrance column, then re-descended next tick — a descend/ascend
// bounce that never let fighters commit inside the enemy colony.
//
// V25 keys recall on `rallyPoint == null` alone: with a rally still set, a
// fight ratio of 0 no longer pulls existing fighters out. The control test
// pins simVersion to V24 to lock in the pre-fix bounce as the version boundary.
// ---------------------------------------------------------------------------
describe('invasion-routing — foreign recall keys on rally, not fight ratio (#174)', () => {
  const DESCENT_TICKS = 5;
  // Window long enough to catch the period-≈2 descend/ascend bounce many times
  // over (the bug surfaces within 1–2 ticks of fight=0), but short enough to
  // stay inside the committed-Fighting state.
  const HOLD_TICKS = 20;

  /**
   * Stage a player Fighter committed inside the enemy underground grid, with the
   * rally still on the enemy entrance. Returns once descent is confirmed; the
   * caller then zeroes the fight ratio and asserts hold-vs-bounce.
   */
  function descendCommittedInvader(seed = 4242) {
    const ctx = buildInvasionWorld(seed);
    const { world, playerAntId } = ctx;
    world.ants.task[playerAntId] = AntTask.Fighting;
    // buildInvasionWorld already set rally = enemy entrance and fight = 5, so the
    // invader descends and commits rather than recalling on contact.
    tickN(world, DESCENT_TICKS);
    // Precondition: invader is underground in the ENEMY grid. If this fails the
    // harness broke (descent never happened) — not the recall gate.
    expect(world.ants.zone[playerAntId]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(ENEMY_COLONY_ID);
    expect(world.ants.task[playerAntId]).toBe(AntTask.Fighting);
    return ctx;
  }

  it('V25: invader HOLDS underground when rally is set and fight ratio drops to 0 (no bounce)', () => {
    const { world, playerAntId, enemyEntTileX, enemyEntTileY } = descendCommittedInvader();

    // Player stops reinforcing (fight → 0) but leaves the rally on the enemy
    // entrance: "hold what you have inside, don't make more".
    world.colonies[PLAYER_COLONY_ID]!.targetRatio.fight = 0;

    // Preconditions for the gate under test.
    expect(world.simVersion).toBe(LATEST_SIM_VERSION);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V25_RALLY_RECALL);
    expect(world.colonies[PLAYER_COLONY_ID]!.rallyPoint).toEqual({
      tileX: enemyEntTileX,
      tileY: enemyEntTileY,
    });
    expect(world.colonies[PLAYER_COLONY_ID]!.targetRatio.fight).toBe(0);

    // Act + assert: the invader must stay underground in the enemy grid for the
    // whole window — never surfacing. Checking every tick catches the period-≈2
    // bounce that the pre-V25 predicate produced.
    for (let t = 0; t < HOLD_TICKS; t++) {
      const cmds = world.commandQueue.splice(0);
      tick(world, cmds);
      expect(world.ants.zone[playerAntId]).toBe(Zone.Underground);
    }
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(ENEMY_COLONY_ID);
    // Still a committed fighter — fight=0 never demoted the existing invader
    // (reassignment only promotes Idle ants; see tick.ts §10a).
    expect(world.ants.task[playerAntId]).toBe(AntTask.Fighting);
  });

  // #247 — the "V24 control (pre-fix bounce)" test was removed: it pinned the sim
  // to V24 to exercise the pre-V25 fight===0 recall disjunct, which the V25 gate reap
  // deleted. MIN_ACCEPTED_SIM_VERSION is V30, so no V24 world can load in production.
});
