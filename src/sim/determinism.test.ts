// src/sim/determinism.test.ts
// SCEN-06 proof — two runs from the same seed produce byte-identical serialized WorldState
// after N ticks. Phase 6 SCs 1-4 end-to-end integration proofs.
// Phase 7 adds: createScenario + MarkDigTile determinism proof.
//
// All constant assertions reference imported symbols from constants.ts — never hardcoded
// PRD §9c literals. If balance constants change, these tests adapt automatically.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V13_INVARIANT_FIXES,
  SIM_VERSION_V20_SPIDER,
  SIM_VERSION_V23_SPIDER_AGGRO,
  SIM_VERSION_V32_AI_OP_VALIDATION,
} from './types.js';
import { initAnt } from './ant/ant-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import { createPheromoneGrid, phGet, pheromoneGridKey } from './pheromone/pheromone-store.js';
import { AntTask, PheromoneType, ForagingSubState, ChamberType } from './enums.js';
import {
  WORKER_LIFESPAN_TICKS,
  WORKER_BASE_SPEED,
  STARVATION_GRACE_TICKS,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  ENEMY_START_X,
  ENEMY_START_Y,
  SPIDER_HUNGER_MAX_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_HP_FULL,
} from './constants.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import type { WorldState } from './types.js';
import type { SimCommand } from './commands.js';
import type { ColonyId } from './colony/colony-store.js';
import { createScenario } from './scenario.js';

// ---------------------------------------------------------------------------
// Helper: deterministic serialization
// ---------------------------------------------------------------------------

function serializeWorldState(w: WorldState): string {
  return JSON.stringify({
    tick: w.tick,
    rngState: w.rngState,
    nextEntityId: w.nextEntityId,
    simVersion: w.simVersion,
    commandQueue: w.commandQueue.map((c) => ({ ...c })),
    ants: {
      posX: Array.from(w.ants.posX),
      posY: Array.from(w.ants.posY),
      alive: Array.from(w.ants.alive),
      age: Array.from(w.ants.age),
      task: Array.from(w.ants.task),
      subTask: Array.from(w.ants.subTask),
      speed: Array.from(w.ants.speed),
      lifespan: Array.from(w.ants.lifespan),
      colonyId: Array.from(w.ants.colonyId),
      foodCarrying: Array.from(w.ants.foodCarrying),
      starvationTimer: Array.from(w.ants.starvationTimer),
      // Phase 7 ant fields:
      zone: Array.from(w.ants.zone),
      digTileX: Array.from(w.ants.digTileX),
      digTileY: Array.from(w.ants.digTileY),
      digTicksRemaining: Array.from(w.ants.digTicksRemaining),
      targetPosX: Array.from(w.ants.targetPosX),
      targetPosY: Array.from(w.ants.targetPosY),
      // Phase 09.1 Chunk 0 — grid-of-occupancy byte (new SoA field).
      currentGridColonyId: Array.from(w.ants.currentGridColonyId),
      // Phase 9 — 6 previously-omitted SoA fields (pre-existing serializer
      // gap closed here per 09.1-00-PLAN). If closure surfaces a latent
      // non-deterministic divergence in one of these fields, revert ONLY the
      // 6 search* lines and document in 09.1-MEMO.md §5 Deviations Log.
      searchWave: Array.from(w.ants.searchWave),
      searchHeadingX: Array.from(w.ants.searchHeadingX),
      searchHeadingY: Array.from(w.ants.searchHeadingY),
      searchHeadingTicks: Array.from(w.ants.searchHeadingTicks),
      searchPrevTileX: Array.from(w.ants.searchPrevTileX),
      searchPrevTileY: Array.from(w.ants.searchPrevTileY),
      // Issue #27 — carrier wait flag (new SoA field). Must round-trip in
      // determinism asserts so a divergence in wait-state would break the
      // byte-identical compare.
      waitingDeposit: Array.from(w.ants.waitingDeposit),
      // Issue #34 / #35 — Bresenham accumulator + pause counter. Same
      // round-trip rationale: divergence in either field changes future
      // tick output, so determinism compare must include them.
      pathErr: Array.from(w.ants.pathErr),
      searchPauseTicks: Array.from(w.ants.searchPauseTicks),
      // Phase 9 / S3 combat fields — spider writes these every tick; omitting
      // them would silently pass even if resolveSpiderCombatOnTile diverges.
      hp: Array.from(w.ants.hp),
      homeGroundBonusHp: Array.from(w.ants.homeGroundBonusHp),
      attackCooldown: Array.from(w.ants.attackCooldown),
      combatOpponentId: Array.from(w.ants.combatOpponentId),
      carryingBroodId: Array.from(w.ants.carryingBroodId),
      carriedBy: Array.from(w.ants.carriedBy),
      recentTilesX: Array.from(w.ants.recentTilesX),
      recentTilesY: Array.from(w.ants.recentTilesY),
      recentTilesHead: Array.from(w.ants.recentTilesHead),
    },
    colonies: Object.keys(w.colonies)
      .sort()
      .reduce(
        (acc, k) => {
          const c = w.colonies[Number(k)]!;
          acc[k] = {
            colonyId: c.colonyId,
            queenEntityId: c.queenEntityId,
            queenStarvationTimer: c.queenStarvationTimer,
            foodStored: c.foodStored,
            workerCount: c.workerCount,
            eggCount: c.eggCount,
            larvaeCount: c.larvaeCount,
            nurseCount: c.nurseCount,
            defeated: c.defeated,
            reconcileCountdown: c.reconcileCountdown,
            killCount: c.killCount,
            digFlowFieldDirty: c.digFlowFieldDirty,
            eggs: [...c.eggs],
            larvae: [...c.larvae],
            workers: [...c.workers],
            chambers: c.chambers.map((ch) => ({ ...ch })),
            entrances: c.entrances.map((e) => ({ ...e })),
            targetRatio: { ...c.targetRatio },
            computedAllocation: { ...c.computedAllocation },
            taskCensus: { ...c.taskCensus },
          };
          return acc;
        },
        {} as Record<string, unknown>,
      ),
    pheromoneGrids: Object.keys(w.pheromoneGrids)
      .sort()
      .reduce(
        (acc, k) => {
          const g = w.pheromoneGrids[k]!;
          acc[k] = { width: g.width, height: g.height, data: Array.from(g.data) };
          return acc;
        },
        {} as Record<string, unknown>,
      ),
    // Phase 7: underground grids
    undergroundGrids: Object.keys(w.undergroundGrids)
      .sort()
      .reduce(
        (acc, k) => {
          const g = w.undergroundGrids[Number(k)]!;
          acc[k] = { width: g.width, height: g.height, data: Array.from(g.data) };
          return acc;
        },
        {} as Record<string, unknown>,
      ),
    // PR 4: baked static surface terrain — a divergence in the frozen grid must
    // break byte-identity.
    bakedSurfaceEffect: Array.from(w.bakedSurfaceEffect),
    // Phase 7: food piles and pending chambers
    foodPiles: w.foodPiles.map((p) => ({ ...p })),
    pendingChambers: Object.keys(w.pendingChambers)
      .sort()
      .reduce(
        (acc, k) => {
          acc[k] = { ...w.pendingChambers[k]! };
          return acc;
        },
        {} as Record<string, unknown>,
      ),
    // S3 V20 — spider entity and priority/scatter shadow fields
    spider: w.spider === null ? null : { ...w.spider },
    spiderPriorityColonyId: w.spiderPriorityColonyId,
    scatterReticleTile: w.scatterReticleTile === null ? null : { ...w.scatterReticleTile },
  });
}

// ---------------------------------------------------------------------------
// Helper: build + run a simulation, return serialized state
// ---------------------------------------------------------------------------

function buildWorld(seed: number): { world: WorldState; queenId: number; colonyId: ColonyId } {
  const world = createWorldState(seed);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId: 1,
    posX: 32 << FP_SHIFT,
    posY: 32 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  world.colonies[1] = createColonyRecord(1, queenId);
  // Issue #15: chamber.foodStored is now per-chamber authoritative. The
  // synthetic 100000fp head-start has to live in chambers, not the entrance
  // pool — reconcile clamps colony.foodStored to BASE alone so dumping 100000
  // into the pool would collapse to 2048 on the first reconcile and starve
  // the queen well before Test 6's pipeline completes. Spread the head-start
  // across 20 chambers (5000fp each, all under FOOD_CHAMBER_CAPACITY=5120).
  world.colonies[1].foodStored = 0;
  for (let i = 0; i < 20; i++) {
    world.colonies[1].chambers.push({
      chamberId: 1000 + i,
      chamberType: ChamberType.FoodStorage,
      foodStored: 5000,
      posX: 0,
      posY: 0,
      width: 3,
      height: 3,
    });
  }
  // 09 reproduction-gate memo: queen egg production requires a completed
  // Queen chamber AND a completed Nursery chamber. Seed both so the lifecycle
  // pipeline (Test 6) reaches the first worker by tick 2700.
  //
  // seed936214196-tick2401 Gate 6: tickQueenEggProduction now also requires
  // the queen to be Underground AND physically inside the Queen chamber
  // footprint. Anchor the Queen chamber around the queen's tile (32,32) and
  // flip her zone to Underground so the pipeline is unblocked without having
  // to simulate relocation via entrances (Test 6 has no entrances or
  // underground grid — it's a behavior-free lifecycle harness).
  world.colonies[1].chambers.push({
    chamberId: 1100,
    chamberType: ChamberType.Queen,
    foodStored: 0,
    posX: 32 << FP_SHIFT,
    posY: 32 << FP_SHIFT,
    width: 2,
    height: 2,
  });
  world.colonies[1].chambers.push({
    chamberId: 1101,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: 0,
    posY: 0,
    width: 2,
    height: 2,
  });
  world.ants.zone[queenId] = 1; // Zone.Underground — Gate 6 precondition
  // Phase 3 PRD §2a caller-side extension fields (factory does not set these):
  world.colonies[1].entrances = [];
  world.colonies[1].rallyPoint = null;
  world.colonies[1].digFlowFieldDirty = false;
  world.colonies[1].foodFlowFieldDirty = false;
  world.pheromoneGrids[pheromoneGridKey(1, PheromoneType.FoodTrail, 'surface')] =
    createPheromoneGrid(64, 64);
  return { world, queenId, colonyId: 1 as ColonyId };
}

function runSimulation(
  seed: number,
  ticks: number,
  commandsPerTick: readonly SimCommand[][] = [],
): string {
  const { world } = buildWorld(seed);
  for (let t = 0; t < ticks; t++) {
    tick(world, commandsPerTick[t] ?? []);
  }
  return serializeWorldState(world);
}

function runSimulationWithState(
  seed: number,
  ticks: number,
  commandsPerTick: readonly SimCommand[][] = [],
): { world: WorldState; queenId: number; colonyId: ColonyId } {
  const result = buildWorld(seed);
  for (let t = 0; t < ticks; t++) {
    tick(result.world, commandsPerTick[t] ?? []);
  }
  return result;
}

// ---------------------------------------------------------------------------
// SCEN-06 tests — Phase 6 SC 9 (determinism)
// ---------------------------------------------------------------------------

describe('SCEN-06: Determinism proof', () => {
  // Test 1: Seed 42 × 100 ticks — byte-for-byte identical
  it('Test 1: seed 42 × 100 ticks — byte-for-byte identical across two independent runs', () => {
    const r1 = runSimulation(42, 100);
    const r2 = runSimulation(42, 100);
    expect(r1).toBe(r2);
  });

  // Test 2: Seed 42 × 1000 ticks — byte-for-byte identical
  it('Test 2: seed 42 × 1000 ticks — byte-for-byte identical across two independent runs', () => {
    const r1 = runSimulation(42, 1000);
    const r2 = runSimulation(42, 1000);
    expect(r1).toBe(r2);
  });

  // Test 3: Different seeds produce different state
  it('Test 3: different seeds produce different serialized state after 100 ticks', () => {
    const r1 = runSimulation(42, 100);
    const r3 = runSimulation(99, 100);
    expect(r1).not.toBe(r3);
  });

  // Test 4: Same seed, same commands, identical output
  it('Test 4: same seed + same commands produce identical state', () => {
    const ratioCmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId: 1 as ColonyId,
      ratio: { forage: 7, fight: 1 },
      issuedAtTick: 50,
    };
    const digCmd: SimCommand = {
      type: 'MarkDigTile',
      colonyId: 1 as ColonyId,
      tileX: 10,
      tileY: 10,
      issuedAtTick: 70,
    };
    const cmds: SimCommand[][] = [];
    cmds[50] = [ratioCmd];
    cmds[70] = [digCmd];

    const r1 = runSimulation(42, 100, cmds);
    const r2 = runSimulation(42, 100, cmds);
    expect(r1).toBe(r2);
  });

  // Test 5: Same seed, different commands, different state
  it('Test 5: same seed + different commands at tick 50 produce different state', () => {
    const cmdsA: SimCommand[][] = [];
    cmdsA[50] = [
      {
        type: 'SetBehaviorRatio',
        colonyId: 1 as ColonyId,
        ratio: { forage: 10, fight: 0 },
        issuedAtTick: 50,
      },
    ];

    const cmdsB: SimCommand[][] = [];
    // Phase 10 (CTRL-01'): pivot is forage↔fight, not forage↔dig (dig is auto-assigned per CTRL-06).
    // Both runs still produce non-equal serialized state since the ratio drives a different forage/fight split.
    cmdsB[50] = [
      {
        type: 'SetBehaviorRatio',
        colonyId: 1 as ColonyId,
        ratio: { forage: 0, fight: 10 },
        issuedAtTick: 50,
      },
    ];

    const r1 = runSimulation(42, 100, cmdsA);
    const r2 = runSimulation(42, 100, cmdsB);
    expect(r1).not.toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// Issue #27 — simVersion plumbing
//
// Coverage:
//   - createWorldState defaults to LATEST_SIM_VERSION
//   - copyWorldState round-trips simVersion (double-buffer preserves the value)
//   - Two LATEST runs from the same seed produce byte-identical state
//   - Different simVersion produces different state (different drain order)
//   - waitingDeposit field round-trips through copyWorldState
// ---------------------------------------------------------------------------

describe('issue #27: simVersion plumbing', () => {
  it('createWorldState defaults to LATEST_SIM_VERSION', async () => {
    const { LATEST_SIM_VERSION } = await import('./types.js');
    const w = createWorldState(42);
    expect(w.simVersion).toBe(LATEST_SIM_VERSION);
  });

  it('copyWorldState round-trips simVersion and waitingDeposit', async () => {
    const { copyWorldState } = await import('./types.js');
    const src = createWorldState(42);
    const dst = createWorldState(99);

    src.simVersion = 7; // arbitrary marker
    src.ants.waitingDeposit[3] = 1;
    src.ants.waitingDeposit[10] = 1;

    copyWorldState(src, dst);

    expect(dst.simVersion).toBe(7);
    expect(dst.ants.waitingDeposit[3]).toBe(1);
    expect(dst.ants.waitingDeposit[10]).toBe(1);
    expect(dst.ants.waitingDeposit[5]).toBe(0); // untouched slots stay zero
  });

  it('copyWorldState round-trips bakedSurfaceEffect (PR 4 — R1-12 per-field copy)', async () => {
    const { copyWorldState } = await import('./types.js');
    const src = createWorldState(42);
    const dst = createWorldState(99);
    // Mutate distinct effect codes so a copy that re-derives from terrainSeed (or
    // drops the field) is caught — both worlds have DIFFERENT terrainSeeds.
    src.bakedSurfaceEffect[0] = 1; // SoftCost
    src.bakedSurfaceEffect[1] = 2; // HardBlock
    src.bakedSurfaceEffect[2] = 0; // Cosmetic
    copyWorldState(src, dst);
    expect(dst.bakedSurfaceEffect[0]).toBe(1);
    expect(dst.bakedSurfaceEffect[1]).toBe(2);
    expect(dst.bakedSurfaceEffect[2]).toBe(0);
    expect(dst.bakedSurfaceEffect.length).toBe(src.bakedSurfaceEffect.length);
  });

  it('two LATEST runs at the same seed produce byte-identical state (drain-fullest determinism)', () => {
    // Direct duplicate of base SCEN-06 Test 1 but with extra runtime to push
    // colonies into chamber-saturation territory where v3's drain-fullest
    // diverges from v2's array-order. A non-deterministic chamber pick (bug
    // in tie-breaking) would surface as a state divergence here.
    const r1 = runSimulation(42, 800);
    const r2 = runSimulation(42, 800);
    expect(r1).toBe(r2);
  });

  it('LEGACY vs LATEST simVersion produce different state at the same seed when chambers diverge', async () => {
    // No tools to flip simVersion mid-run — but we can construct a colony
    // with two chambers of unequal fill and compare the two drain orders
    // directly. The integration-level test above proves determinism within
    // a version; this test proves the algorithms genuinely differ.
    const { withdrawFood } = await import('./colony/colony-system.js');
    const { createColonyRecord } = await import('./colony/colony-store.js');
    const { ChamberType } = await import('./enums.js');
    const { LEGACY_SIM_VERSION, LATEST_SIM_VERSION } = await import('./types.js');

    function buildColony() {
      const c = createColonyRecord(1, 0);
      c.entrances = [];
      c.rallyPoint = null;
      c.digFlowFieldDirty = false;
      c.foodFlowFieldDirty = false;
      c.foodStored = 0;
      c.chambers.push({
        chamberId: 1,
        chamberType: ChamberType.FoodStorage,
        foodStored: 100,
        posX: 0,
        posY: 0,
        width: 1,
        height: 1,
      });
      c.chambers.push({
        chamberId: 2,
        chamberType: ChamberType.FoodStorage,
        foodStored: 200,
        posX: 0,
        posY: 0,
        width: 1,
        height: 1,
      });
      return c;
    }

    const cLegacy = buildColony();
    withdrawFood(cLegacy, 50, LEGACY_SIM_VERSION);
    // v2: array-order — chambers[0] (100) drains first → 50, chambers[1] untouched.
    expect(cLegacy.chambers[0]!.foodStored).toBe(50);
    expect(cLegacy.chambers[1]!.foodStored).toBe(200);

    const cLatest = buildColony();
    withdrawFood(cLatest, 50, LATEST_SIM_VERSION);
    // v3: fullest-first — chambers[1] (200) drains first → 150, chambers[0] untouched.
    expect(cLatest.chambers[0]!.foodStored).toBe(100);
    expect(cLatest.chambers[1]!.foodStored).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 1 — full pipeline (queen → egg → larva → worker)
// ---------------------------------------------------------------------------

describe('Phase 6 SC 1: queen → egg → larva → worker pipeline', () => {
  // Test 6: Full lifecycle pipeline
  it('Test 6: queen produces egg → egg becomes larva → larva becomes worker after 3700 ticks', () => {
    const { world, colonyId } = runSimulationWithState(42, 3700);
    const colony = world.colonies[colonyId]!;
    // At least one worker must have been produced from the pipeline
    expect(colony.workerCount).toBeGreaterThanOrEqual(1);
    // Pipeline is still producing — eggs and/or larvae present
    expect(colony.eggCount + colony.larvaeCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 2 — starvation cascade
// ---------------------------------------------------------------------------

describe('Phase 6 SC 2: starvation cascade', () => {
  // Test 7: Unfed queen dies after STARVATION_GRACE_TICKS
  it('Test 7: unfed queen dies after STARVATION_GRACE_TICKS + 1 ticks', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: 1,
      posX: 1024,
      posY: 1024,
      task: AntTask.Idle,
      subTask: 0,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1].foodStored = 0; // no food — queen cannot eat
    world.colonies[1].queenStarvationTimer = STARVATION_GRACE_TICKS; // timer at full grace

    // Run STARVATION_GRACE_TICKS + 1 ticks — timer decrements by 1 each tick until <= 0 → death
    for (let t = 0; t < STARVATION_GRACE_TICKS + 1; t++) {
      tick(world, []);
    }

    expect(world.ants.alive[queenId]).toBe(0);
    expect(world.colonies[1].defeated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 3 — pheromone deposit on traversed cells
// ---------------------------------------------------------------------------

describe('Phase 6 SC 3: pheromone deposit on traversed cells', () => {
  // Test 8: Food-carrying worker leaves trail
  it('Test 8: food-carrying worker at tile (10,10) leaves a food-trail deposit after 1 tick', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: 1,
      posX: 1024,
      posY: 1024,
      task: AntTask.Idle,
      subTask: 0,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1].foodStored = 100000;

    const workerId = allocateEntityId(world);
    initAnt(world.ants, workerId, {
      colonyId: 1,
      posX: 10 << FP_SHIFT,
      posY: 10 << FP_SHIFT,
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.ants.foodCarrying[workerId] = 512; // carrying food — deposit rule activates
    world.colonies[1].workers.push(workerId);
    world.colonies[1].workerCount = 1;

    const gridKey = pheromoneGridKey(1, PheromoneType.FoodTrail, 'surface');
    const foodGrid = createPheromoneGrid(64, 64);
    world.pheromoneGrids[gridKey] = foodGrid;

    tick(world, []);

    // Step 10 deposited food trail; step 11 decayed it slightly but not to 0
    expect(phGet(foodGrid, 10, 10)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 SC 4 — CTRL-04 one-tick allocation
// ---------------------------------------------------------------------------

describe('Phase 6 SC 4: CTRL-04 one-tick immediate allocation', () => {
  // Test 9: SetBehaviorRatio at tick N updates computedAllocation in tick N output
  it('Test 9: issuing SetBehaviorRatio at tick N updates computedAllocation at tick N (not N+1)', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: 1,
      posX: 1024,
      posY: 1024,
      task: AntTask.Idle,
      subTask: 0,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1].foodStored = 100000;

    // Add 10 workers (all Idle — no brood)
    for (let i = 0; i < 10; i++) {
      const wid = allocateEntityId(world);
      initAnt(world.ants, wid, {
        colonyId: 1,
        posX: 1024,
        posY: 1024,
        task: AntTask.Idle,
        subTask: 0,
      });
      world.colonies[1].workers.push(wid);
      world.colonies[1].workerCount += 1;
    }

    // Set initial targetRatio → forage:10 (all 10 workers allocated to forage)
    world.colonies[1].targetRatio.forage = 10;
    world.colonies[1].targetRatio.fight = 0;

    // Tick 0 (no commands): allocation reflects forage:10 ratio
    tick(world, []);
    expect(world.colonies[1].computedAllocation.forage).toBe(10);
    expect(world.colonies[1].computedAllocation.dig).toBe(0);

    // Tick 1: issue SetBehaviorRatio pivoting forage↔fight (Phase 10 CTRL-01': dig is auto-assigned per CTRL-06)
    const cmd: SimCommand = {
      type: 'SetBehaviorRatio',
      colonyId: 1 as ColonyId,
      ratio: { forage: 0, fight: 10 },
      issuedAtTick: 1,
    };
    tick(world, [cmd]);

    // The new ratio takes effect in the SAME tick the command is issued (CTRL-04).
    // NOT in the "next tick after this one".
    expect(world.colonies[1].computedAllocation.forage).toBe(0);
    expect(world.colonies[1].computedAllocation.dig).toBe(0);
    expect(world.colonies[1].computedAllocation.fight).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// No-allocation invariant (object-identity proof)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 7: createScenario determinism proof
// ---------------------------------------------------------------------------

describe('Phase 7: createScenario determinism with MarkDigTile commands', () => {
  // Test 11: createScenario(42) + 100 ticks with MarkDigTile commands → byte-identical across two runs
  it('Test 11: createScenario(42) × 100 ticks with MarkDigTile — byte-for-byte identical', () => {
    const colonyId = PLAYER_COLONY_ID as ColonyId;

    // Build a fixed command schedule: mark several tiles at specific ticks
    const cmds: SimCommand[][] = [];
    cmds[0] = [{ type: 'MarkDigTile', colonyId, tileX: 10, tileY: 5, issuedAtTick: 0 }];
    cmds[10] = [{ type: 'MarkDigTile', colonyId, tileX: 15, tileY: 8, issuedAtTick: 10 }];
    cmds[20] = [{ type: 'MarkDigTile', colonyId, tileX: 20, tileY: 10, issuedAtTick: 20 }];
    cmds[30] = [{ type: 'CancelDigMark', colonyId, tileX: 10, tileY: 5, issuedAtTick: 30 }];
    cmds[50] = [
      {
        type: 'SetBehaviorRatio',
        colonyId,
        // Phase 10 (CTRL-01'): pivot forage↔fight (dig is auto-assigned per CTRL-06).
        ratio: { forage: 0, fight: 10 },
        issuedAtTick: 50,
      },
    ];

    function runScenario(): string {
      const world = createScenario(42);
      for (let t = 0; t < 100; t++) {
        tick(world, cmds[t] ?? []);
      }
      return serializeWorldState(world);
    }

    const r1 = runScenario();
    const r2 = runScenario();
    expect(r1).toBe(r2);
  });
});

describe('No-allocation invariant: object identity in steady state', () => {
  // Test 10: targetRatio, computedAllocation, taskCensus are mutated in-place (not replaced)
  it('Test 10: colony.targetRatio/computedAllocation/taskCensus are the SAME objects after 100 ticks', () => {
    const world = createWorldState(42);
    const queenId = allocateEntityId(world);
    initAnt(world.ants, queenId, {
      colonyId: 1,
      posX: 32 << FP_SHIFT,
      posY: 32 << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      speed: 0,
      lifespan: WORKER_LIFESPAN_TICKS,
    });
    world.colonies[1] = createColonyRecord(1, queenId);
    world.colonies[1].foodStored = 100000;

    // 10 warm-up ticks to stabilize
    for (let i = 0; i < 10; i++) tick(world, []);

    // Capture object references after warmup
    const colony = world.colonies[1];
    const targetRatioRef = colony.targetRatio;
    const computedAllocationRef = colony.computedAllocation;
    const taskCensusRef = colony.taskCensus;

    // Run 100 more ticks
    for (let i = 0; i < 100; i++) tick(world, []);

    // Objects must be the SAME reference — tick.ts mutates fields in-place, never replaces objects
    expect(colony.targetRatio).toBe(targetRatioRef);
    expect(colony.computedAllocation).toBe(computedAllocationRef);
    expect(colony.taskCensus).toBe(taskCensusRef);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 SC 5 — two-colony determinism proof (appended)
// ---------------------------------------------------------------------------

describe('Phase 9 determinism (SC 5) — two-colony parity', () => {
  // Test A: pure determinism — same seed, no commands, 500 ticks, byte-identical serialized state.
  it('500-tick two-colony parity: identical seeds produce byte-identical serialized states', () => {
    const seed = 424242;
    const worldA = createScenario(seed);
    const worldB = createScenario(seed);

    const TICKS = 500;
    for (let i = 0; i < TICKS; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }

    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 20_000);

  // Test B: combat-surface determinism — forcing ants together then running 500 ticks still parity-clean.
  // We don't need a full "force workers to tile" helper — createScenario already spawns both colonies
  // near each other per PLAYER_START_X/Y and ENEMY_START_X/Y (constants.ts). Over 500 ticks foragers
  // naturally wander, encounter enemies, and trigger combat. If Phase 9 combat/AI/rally paths are
  // non-deterministic, the serialized states will diverge even without artificial placement.
  it('500-tick two-colony parity with natural combat: worlds still serialize identically', () => {
    const seed = 31415;
    const worldA = createScenario(seed);
    const worldB = createScenario(seed);

    for (let i = 0; i < 500; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }

    // Sanity: both colonies still present (no freak ENOENT on colony lookup).
    expect(worldA.colonies[PLAYER_COLONY_ID]).toBeDefined();
    expect(worldA.colonies[ENEMY_COLONY_ID]).toBeDefined();

    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 20_000);

  // Test C: rngState scalar parity — cheaper fast-fail on drift.
  it('RNG scalar parity: rngState identical after 500 ticks', () => {
    const seed = 17;
    const worldA = createScenario(seed);
    const worldB = createScenario(seed);
    for (let i = 0; i < 500; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }
    expect(worldA.rngState).toBe(worldB.rngState);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Phase 09.1 Chunk 4 (plan 09.1-04) — cross-grid combat parity (REQ-C4c)
// ---------------------------------------------------------------------------
//
// The generic two-colony parity cases above do NOT exercise the Chunk-4
// tile-key extension (makeTileKey's new gridColonyId byte) because their
// scenarios never produce an ant with `ants.currentGridColonyId[id] !==
// ants.colonyId[id]` — i.e., no ant descends into a FOREIGN underground grid.
// Without that divergence, the new gridByte in the bucket key is always 0 for
// underground ants and the cross-grid bucketing path goes untested.
//
// This describe block stages an explicit cross-grid scenario: a player Fighting
// ant standing on the enemy entrance tile descends (Chunk 3 descent-intent
// gate) and the `currentGridColonyId` byte flips to ENEMY_COLONY_ID. Inside
// the foreign grid it engages combat with a pre-placed enemy hostile (Chunk 4
// tile-key extension buckets them together correctly).
//
// MANDATORY divergence guard at midTick: at least one underground ant must
// have `currentGridColonyId !== colonyId`. If that guard ever fails, the
// scenario is no longer exercising cross-grid bucketing and the parity check
// is no longer proving REQ-C4c — fail loudly rather than silently pass.

/**
 * Stage a cross-grid combat scenario on top of `createScenario`. Returns the
 * world. The invader is placed on the enemy entrance tile (Surface) with
 * task=Fighting; a hostile is pinned inside the enemy grid's foreign
 * corridor; an open rectangle is carved from the enemy entrance column to
 * the hostile so the invader's greedy-Manhattan stepper can reach it.
 *
 * Same pattern as invasion-routing.test.ts's distance-decrease scenario — we
 * reuse it here specifically to exercise Chunk-4 cross-grid combat bucketing.
 */
function buildCrossGridCombatWorld(seed: number): WorldState {
  const world = createScenario(seed);

  // #164 pre-descent gate: createScenario spawns the enemy queen ON her start
  // tile, which is also the enemy entrance. A foreign Fighter must now engage a
  // surface queen on an entrance rather than descend past her — which would
  // block this scenario's underground cross-grid combat. Relocate the enemy
  // queen off the entrance tile (she holds position — no completed Queen
  // chamber) so the invader's descent still fires.
  const enemyQueenId = world.colonies[ENEMY_COLONY_ID]!.queenEntityId;
  world.ants.posX[enemyQueenId] = (ENEMY_START_X + 6) << FP_SHIFT;

  // Spawn 1 player Fighter on the enemy entrance tile (Surface).
  const playerAntId = allocateEntityId(world);
  initAnt(world.ants, playerAntId, {
    colonyId: PLAYER_COLONY_ID,
    posX: (ENEMY_START_X << FP_SHIFT) + (FP_ONE >> 1),
    posY: (ENEMY_START_Y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Surface,
  });
  world.colonies[PLAYER_COLONY_ID]!.workers.push(playerAntId);
  world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;
  // Model real game state: rally + fight ratio > 0 so recall logic doesn't
  // fire immediately after descent (which would break the divergence guard).
  world.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: ENEMY_START_X, tileY: ENEMY_START_Y };
  world.colonies[PLAYER_COLONY_ID]!.targetRatio.fight = 5;

  // Pin an enemy hostile a few tiles east + below the entrance shaft.
  const hostileTileX = ENEMY_START_X + 3;
  const hostileTileY = 5;
  const hostileId = allocateEntityId(world);
  initAnt(world.ants, hostileId, {
    colonyId: ENEMY_COLONY_ID,
    posX: (hostileTileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (hostileTileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle,
    subTask: 0,
    speed: 0, // pinned — keeps the test scenario stable and combat-reachable
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Underground,
  });
  world.ants.currentGridColonyId[hostileId] = ENEMY_COLONY_ID;
  world.colonies[ENEMY_COLONY_ID]!.workers.push(hostileId);
  world.colonies[ENEMY_COLONY_ID]!.workerCount += 1;

  // Carve an open rectangle in the enemy grid from shaft column to hostile.
  // createScenario pre-excavates the shaft (y=0..1); we widen it so
  // greedy-Manhattan stepping doesn't pin at an elbow (same rationale as
  // invasion-routing's distance-decrease test).
  const enemyGrid = world.undergroundGrids[ENEMY_COLONY_ID]!;
  for (let y = 0; y <= hostileTileY; y++) {
    for (let x = ENEMY_START_X; x <= hostileTileX; x++) {
      ugSet(enemyGrid, x, y, UndergroundTileState.Open);
    }
  }

  return world;
}

describe('Phase 09.1 Chunk 4 — cross-grid combat parity (REQ-C4c)', () => {
  // Seed and tick budget chosen so descent + combat + cleanup all occur
  // inside the parity window AND the divergence guard at midTick finds an
  // ant with currentGridColonyId != colonyId.
  //
  // Seed 31337 chosen empirically: produces a descent around t≈3-5 ticks
  // (one pass through tickAntMovement's descent block with scenario's
  // default PRNG rolls — not rng-dependent for the descent itself since
  // the gate is deterministic on task+entrance state), keeps the invader
  // alive long enough to reach the midTick check, and matches the cadence
  // used by the neighbouring parity cases above.
  const SEED = 31337;
  const N = 500;
  // MID_TICK chosen to be AFTER descent (zone flip is t=1 in this scenario)
  // but BEFORE the invader is killed in combat (combat resolves around t=11 per
  // debug trace). At t=10 the invader is alive, Underground, in the enemy grid
  // — divergence guard has a live subject to find.
  const MID_TICK = 10;

  it('cross-grid parity: same seed produces identical serialization with divergence guard active', () => {
    const worldA = buildCrossGridCombatWorld(SEED);
    const worldB = buildCrossGridCombatWorld(SEED);

    // Run to midTick, capture divergence guard state from worldA.
    for (let i = 0; i < MID_TICK; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }

    // MANDATORY divergence guard: at least one underground ant has
    // currentGridColonyId != colonyId. If this fails, the scenario isn't
    // actually exercising cross-grid bucketing — parity alone could then
    // pass trivially without ever touching the Chunk-4 extension.
    let anyDiverged = false;
    let playerFighterInEnemyGrid = false;
    for (let id = 0; id < worldA.ants.alive.length; id++) {
      if (worldA.ants.alive[id] !== 1) continue;
      if (worldA.ants.zone[id] !== Zone.Underground) continue;
      const owner = worldA.ants.colonyId[id];
      const grid = worldA.ants.currentGridColonyId[id];
      if (owner !== grid) {
        anyDiverged = true;
        if (owner === PLAYER_COLONY_ID && grid === ENEMY_COLONY_ID) {
          playerFighterInEnemyGrid = true;
        }
      }
    }
    expect(anyDiverged).toBe(true);
    expect(playerFighterInEnemyGrid).toBe(true);

    // Parity check midrun — catches drift BEFORE the full run.
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));

    // Run the rest of the budget, then re-check parity at t=N.
    for (let i = MID_TICK; i < N; i++) {
      tick(worldA, []);
      tick(worldB, []);
    }
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S0a: V13 replay determinism under V14 code (Q5 — Format A.2)
//
// Regression guard: V14 sim-version gates must not perturb worlds that carry
// simVersion=SIM_VERSION_V13_INVARIANT_FIXES. Two independent V13 worlds run
// from the same seed must produce byte-identical state at tick 100.
// ---------------------------------------------------------------------------

describe('SCEN-06: V13 replay determinism under V14 code', () => {
  it('V13 world replays byte-identical across two independent 100-tick runs', () => {
    const TICKS = 100;

    const worldA = createScenario(42);
    worldA.simVersion = SIM_VERSION_V13_INVARIANT_FIXES;
    for (let t = 0; t < TICKS; t++) tick(worldA, []);

    const worldB = createScenario(42);
    worldB.simVersion = SIM_VERSION_V13_INVARIANT_FIXES;
    for (let t = 0; t < TICKS; t++) tick(worldB, []);

    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  });
});
// ---------------------------------------------------------------------------
// S3 V20 — spider replay determinism (Hunting / Striking / Rampaging)
//
// The serializer now includes world.spider, spiderPriorityColonyId, and
// scatterReticleTile, so any RNG use or non-deterministic branch in tickSpider
// or resolveSpiderCombatOnTile surfaces as a divergence between the two
// independent runs. The divergence guard ensures the spider actually reached
// at least one non-Patrolling state during the 400-tick budget.
// ---------------------------------------------------------------------------

describe('S3 V20: spider replay determinism (Hunting → Striking → Rampaging)', () => {
  // Stage the spider already in Hunting state with an expired timer so tick 1
  // immediately transitions to Striking, and pre-saturate hunger so that after
  // Striking exits to Patrolling the spider immediately rampages. This drives
  // Hunting → Striking → Patrolling → Rampaging within the first ~90 ticks
  // without requiring workers on a specific tile, covering all three states
  // called out in the Codex P1 finding.
  it('two V20 worlds from seed 7777 run byte-identical over 400 ticks through Hunting/Striking/Rampaging', () => {
    const SEED = 7777;
    const TICKS = 400;

    function buildSpiderWorld(): WorldState {
      const world = createScenario(SEED);
      // Fast-fail: world must be V20 so world.spider is non-null.
      // regresses to a sub-V20 LATEST, this assert fires before the spider!-dereference
      // below would throw a TypeError — clearer than an opaque null-deref.
      expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V20_SPIDER);
      const spider = world.spider!;
      // Lock the lair coordinates for seed 7777. If _placeSpider changes behaviour
      // (scan order, grid dimensions, etc.), this fails loudly rather than silently
      // breaking the distance safety bound used in the comment below.
      expect(spider.lairTileX).toBe(62);
      expect(spider.lairTileY).toBe(40);
      // Pin position to lair tile so moveTowardTile during Striking cannot drift the
      // spider relative to the workers' starting distance.
      spider.posX = spider.lairTileX << FP_SHIFT;
      spider.posY = spider.lairTileY << FP_SHIFT;
      // Pre-stage Hunting with an expired hunt timer so Striking fires on first tick.
      spider.state = 'Hunting';
      spider.huntTargetTileX = spider.lairTileX;
      spider.huntTargetTileY = spider.lairTileY;
      // Start past the V23 start-of-match grace window so the spider actually
      // predates (rampages) instead of staying dormant; see SPIDER_GRACE_TICKS / #177.
      world.tick = SPIDER_GRACE_TICKS;
      // huntStartTick = world.tick so Hunting persists for SPIDER_TELEGRAPH_TICKS ticks
      // before transitioning to Striking, allowing statesVisited to observe 'Hunting'.
      // (On first call tick-huntStartTick=0<120 → stays Hunting; 120 calls later → Striking.)
      spider.huntStartTick = SPIDER_GRACE_TICKS;
      // NORMAL_TIER_INDEX=1 → threshold 1800. After Striking exits to Patrolling
      // hunger will be ≥1800, triggering an immediate Rampaging transition.
      // Safety: createScenario places STARTING_WORKERS=3 at PLAYER_START_X/Y (24,64) and
      // ENEMY_START_X/Y (104,64). The lair is at (62,40) (#181 margin-inset sampling);
      // nearest colony workers start at Manhattan distance 62 tiles. The combined
      // Hunting+Striking window is 200 ticks
      // (120+80); at WORKER_BASE_SPEED=0.5 tile/tick the theoretical straight-line coverage
      // is 100 tiles — exceeding the 62-tile gap. However, Foraging ants follow pheromones
      // and search randomly, not toward the spider lair; in practice they cannot reach
      // (62,40) from (24,64) in 200 ticks of pheromone-guided wandering. The lair coord
      // assertion on lines above will catch a future _placeSpider regression that places
      // the lair near a colony start before the margin narrows.
      spider.hungerTicks = SPIDER_HUNGER_MAX_TICKS[1];
      return world;
    }

    const worldA = buildSpiderWorld();
    const worldB = buildSpiderWorld();
    const statesVisited = new Set<string>();
    for (let t = 0; t < TICKS; t++) {
      tick(worldA, []);
      if (worldA.spider !== null) statesVisited.add(worldA.spider.state);
    }
    for (let t = 0; t < TICKS; t++) tick(worldB, []);

    // Guard: all three required states must have been reached. worldB divergence surfaces
    // via the parity assert below (any divergence in spider fields produces different JSON).
    expect(statesVisited.has('Hunting')).toBe(true);
    expect(statesVisited.has('Striking')).toBe(true);
    expect(statesVisited.has('Rampaging')).toBe(true);

    // Byte-identical parity including V20 fields.
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S3 V23 — spider chase (#146) + fighter auto-aggro (#147) replay determinism
//
// Exercises the V23-gated paths: findChaseTarget / Chasing transitions+movement
// (spider.ts), the widened spider-combat gate (combat.ts), and the spider
// candidate in the fighter proximity scan (ant-system.ts). The serializer spreads
// the whole spider object, so the new chaseTargetAntId/chaseStartTick fields are
// covered — any RNG or non-deterministic branch surfaces as a JSON divergence.
// ---------------------------------------------------------------------------

describe('S3 V23: spider chase + fighter aggro replay determinism', () => {
  it('two V23 worlds from seed 7777 run byte-identical over 200 ticks through Chasing', () => {
    const SEED = 7777;
    const TICKS = 200;

    function buildChaseWorld(): WorldState {
      const world = createScenario(SEED);
      // V23 behavior must be active for chase + fighter aggro to fire.
      expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V23_SPIDER_AGGRO);
      const spider = world.spider!;
      const player = world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!;
      expect(player.workers.length).toBeGreaterThanOrEqual(2);

      // Anchor on the first starting worker's surface tile.
      const prey = player.workers[0]!;
      const wx = world.ants.posX[prey]! >> FP_SHIFT;
      const wy = world.ants.posY[prey]! >> FP_SHIFT;

      // Park the spider 2 tiles from the worker cluster so findChaseTarget fires
      // on the first tick (within SPIDER_CHASE_TRIGGER_RADIUS=4). Under the V23
      // redesign a sated spider ignores workers, so saturate hunger past the
      // threshold — a hungry spider opportunistically Chases a lone ant in radius.
      spider.state = 'Patrolling';
      spider.posX = (wx + 2) << FP_SHIFT;
      spider.posY = wy << FP_SHIFT;
      spider.lairTileX = wx + 2;
      spider.lairTileY = wy;
      spider.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1]!;
      spider.hp = SPIDER_HP_FULL;
      spider.chaseTargetAntId = -1;
      spider.chaseStartTick = 0;

      // Convert a second worker into a fighter adjacent to the spider and rally it
      // on its own (non-entrance) tile so the proximity-aggro scan runs and folds
      // the spider in as a candidate.
      const fighter = player.workers[1]!;
      world.ants.task[fighter] = AntTask.Fighting;
      world.ants.posX[fighter] = ((wx + 1) << FP_SHIFT) + (FP_ONE >> 1);
      world.ants.posY[fighter] = (wy << FP_SHIFT) + (FP_ONE >> 1);
      player.rallyPoint = { tileX: wx + 1, tileY: wy };
      return world;
    }

    const worldA = buildChaseWorld();
    const worldB = buildChaseWorld();
    const statesVisited = new Set<string>();
    for (let t = 0; t < TICKS; t++) {
      tick(worldA, []);
      if (worldA.spider !== null) statesVisited.add(worldA.spider.state);
    }
    for (let t = 0; t < TICKS; t++) tick(worldB, []);

    // Guard: the chase path must actually have been exercised.
    expect(statesVisited.has('Chasing')).toBe(true);

    // Byte-identical parity including the new V23 spider fields.
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S3 V23 redesign — hunger-gated meander + feed-after-kill replay determinism
//
// Exercises the redesign-specific deterministic surfaces that the chase test
// above does not reach:
//   - the meander hash (Patrolling wander target derived from terrainSeed ^ tick)
//   - the feed-after-kill path: killedThisTick → hunger reset → computeFeedAwayTile
//     (feed-direction hash) → Feeding heal window
//   - the rampage pick (pickRampageTarget) when no chase/hunt target is available
// None of these draw world.rngState, so two independent runs must serialize
// byte-identically AND leave rngState in lockstep.
// ---------------------------------------------------------------------------

describe('S3 V23 redesign: meander + feed-after-kill replay determinism', () => {
  // Build a hungry spider sitting on top of a lone player worker with no
  // fighters anywhere, so the predation→kill→feed loop fires: combat resolves
  // on the shared tile (kill), the spider resets hunger and — finding no
  // adjacent fighter — retreats ~10 tiles and Feeds. Running long enough also
  // lets hunger re-accrue past the threshold and drive a second predation beat.
  function buildFeedWorld(): WorldState {
    const world = createScenario(7777);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V23_SPIDER_AGGRO);
    const spider = world.spider!;
    const player = world.colonies[PLAYER_COLONY_ID as unknown as ColonyId]!;
    expect(player.workers.length).toBeGreaterThanOrEqual(1);

    // Anchor the spider directly on the first worker's surface tile so the
    // first combat pass already has a victim on the tile.
    const prey = player.workers[0]!;
    const wx = world.ants.posX[prey]! >> FP_SHIFT;
    const wy = world.ants.posY[prey]! >> FP_SHIFT;
    spider.state = 'Patrolling';
    spider.posX = wx << FP_SHIFT;
    spider.posY = wy << FP_SHIFT;
    spider.lairTileX = wx;
    spider.lairTileY = wy;
    spider.hp = SPIDER_HP_FULL - 25; // leave headroom so Feeding heal is observable
    spider.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1]!; // hungry → predates
    // Past the V23 start-of-match grace window so the hungry spider predates rather
    // than staying dormant (Patrolling + self-defense only); see SPIDER_GRACE_TICKS / #177.
    world.tick = SPIDER_GRACE_TICKS;
    return world;
  }

  it('two redesign worlds from seed 7777 run byte-identical over 400 ticks through Feeding', () => {
    const TICKS = 400;
    const worldA = buildFeedWorld();
    const worldB = buildFeedWorld();
    const statesVisited = new Set<string>();
    for (let t = 0; t < TICKS; t++) {
      tick(worldA, []);
      if (worldA.spider !== null) statesVisited.add(worldA.spider.state);
    }
    for (let t = 0; t < TICKS; t++) tick(worldB, []);

    // Guard: the feed-after-kill path must actually have been exercised.
    expect(statesVisited.has('Feeding')).toBe(true);

    // Byte-identical parity AND rngState lockstep (spider logic draws no RNG).
    expect(serializeWorldState(worldA)).toBe(serializeWorldState(worldB));
    expect(worldA.rngState).toBe(worldB.rngState);
  }, 30_000);

  it('save round-trip mid-Feeding deep-equals the spider, with killedThisTick forced to 0 on load', async () => {
    const { serializeWorldState: saveWorld, deserializeWorldState: loadWorld } =
      await import('../platform/save.js');

    const world = buildFeedWorld();
    // Advance until the spider is mid-Feeding (kill → feed transition).
    let reachedFeeding = false;
    for (let t = 0; t < 400; t++) {
      tick(world, []);
      if (world.spider !== null && world.spider.state === 'Feeding') {
        reachedFeeding = true;
        break;
      }
    }
    expect(reachedFeeding).toBe(true);

    // killedThisTick is a transient combat→spider flag; force it set so we can
    // prove deserialize hard-defaults it back to 0 (it must never persist as 1).
    world.spider!.killedThisTick = 1;
    const before = { ...world.spider! };

    const restored = loadWorld(saveWorld(world));
    expect(restored.spider).not.toBeNull();
    const after = restored.spider!;

    // Every field round-trips except killedThisTick, which is hard-defaulted 0.
    expect(after.killedThisTick).toBe(0);
    expect({ ...after, killedThisTick: before.killedThisTick }).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// SCEN-06: the #226 V32 StartAIOperation command-application gate replays
// deterministically through the full tick pipeline (AGENTS.md:132 — command-
// application changes must include a deterministic replay test).
// ---------------------------------------------------------------------------
describe('SCEN-06: StartAIOperation V32 gate replay (#226)', () => {
  it('a StartAIOperation applied through tick replays byte-identically', () => {
    function run(): string {
      const world = createScenario(7);
      world.simVersion = SIM_VERSION_V32_AI_OP_VALIDATION;
      // Force the AI colony to the legal source state so the injected Probe is
      // APPLIED through the V32 gate (exercises the apply path and its downstream
      // rally behavior across the replay window, not just a no-op drop).
      const ai = world.aiState.find((a) => a.colonyId === ENEMY_COLONY_ID);
      if (ai) ai.state = 'WarFooting';
      const cmd: SimCommand = {
        type: 'StartAIOperation',
        colonyId: ENEMY_COLONY_ID as ColonyId,
        kind: 'Probe',
        rallyTileX: 40,
        rallyTileY: 40,
        fighterIds: [10, 11, 12],
        issuedAtTick: 0,
      };
      for (let t = 0; t < 20; t++) tick(world, t === 0 ? [cmd] : []);
      return serializeWorldState(world);
    }
    // Two independent replays from the same seed + input sequence must be
    // byte-for-byte identical — the new V32 apply/drop path introduces no
    // non-determinism into command application.
    expect(run()).toBe(run());
  });
});
