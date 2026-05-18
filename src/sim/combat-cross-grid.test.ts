// combat-cross-grid.test.ts — Phase 09.1 Chunk 4 (plan 09.1-04) VALIDATION tests.
//
// Validates the tile-key extension that lets same-(tileX,tileY) ants from
// different underground grids AVOID bucketing together, while same-grid ants
// at the same tile still bucket (and fight when from different colonies):
//   - Positive: Player Fighting ant + enemy queen colocated on the SAME tile
//     inside the ENEMY grid → combat resolves → queen dies → checkQueenDeath
//     returns Victory.
//   - Negative: Ant A in the PLAYER underground grid at (tileX,tileY) and ant
//     B in the ENEMY underground grid at the same (tileX,tileY) do NOT fight
//     — different grids → different tile-keys → separate buckets.
//
// Assertion discipline — MANDATORY for every test:
//   - t=0 precondition assertions confirm the scenario is set up correctly
//     (ants alive, at expected tiles, in expected grids). A negative test
//     could otherwise pass "accidentally" because setup broke rather than
//     the tile-key correctly separating buckets.
//   - t=N outcome assertions confirm the tile-key extension produced the
//     expected result.
//
// RNG seed selection for Test 1 (player-wins):
//   combat.ts resolveCombatOnTile: flip = rng.nextInt(2); flip === 0 kills
//   groupB's first member (groupB = higher colonyId). PLAYER_COLONY_ID=1 is
//   groupA, ENEMY_COLONY_ID=2 is groupB, so flip=0 kills the enemy queen.
//   `new Rng(3).nextInt(2) === 0`, so we set world.rngState=3 immediately
//   before calling detectAndResolveCombat (directly; bypassing tick() to
//   keep the rng state stable — tickAntMovement advances the rng before
//   step 17 would run in the full tick).

import { describe, it, expect } from 'vitest';
import { detectAndResolveCombat } from './combat.js';
import { Rng } from './rng.js';
import { checkQueenDeath, GameOutcome } from './game-over.js';
import { createWorldState, allocateEntityId } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { WORKER_BASE_SPEED, WORKER_LIFESPAN_TICKS, PLAYER_COLONY_ID, ENEMY_COLONY_ID } from './constants.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CrossGridWorld {
  world:          WorldState;
  playerAntId:    number;
  enemyQueenId:   number;
}

/**
 * Build a world with two colonies (PLAYER=1, ENEMY=2) and place:
 *   - the enemy queen at (queenTileX, queenTileY) inside the ENEMY
 *     underground grid (currentGridColonyId=ENEMY);
 *   - a player Fighting ant at the SAME tile, also inside the ENEMY
 *     underground grid (currentGridColonyId=ENEMY — the invader).
 *
 * Both ants are Underground; both currentGridColonyId=ENEMY. Plans 0+3
 * establish the invariant that a player Fighter inside the enemy grid has
 * ants.currentGridColonyId=ENEMY even though ants.colonyId=PLAYER.
 *
 * The player Fighter has subTask=FightingSubState.Attacking and
 * speed=WORKER_BASE_SPEED — these don't affect bucketing but match the
 * shape of a realistic invader.
 *
 * Queens are placed at distinct tiles (not the combat tile) only when we
 * need a separate combat tile; here the enemy queen IS on the combat tile,
 * and the player queen lives elsewhere (tile (0,0) Surface) so she cannot
 * accidentally bucket into the combat tile.
 */
function buildCrossGridWorld(seed = 1, queenTileX = 5, queenTileY = 5): CrossGridWorld {
  const world = createWorldState(seed);

  // Player queen at surface (0,0) — far from combat tile, stays alive.
  const playerQueen = allocateEntityId(world);
  initAnt(world.ants, playerQueen, {
    colonyId: PLAYER_COLONY_ID,
    posX:     0 << FP_SHIFT,
    posY:     0 << FP_SHIFT,
    task:     AntTask.Idle,
    subTask:  0,
    speed:    0,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Surface,
  });
  const playerColony = createColonyRecord(PLAYER_COLONY_ID as ColonyId, playerQueen);
  playerColony.entrances = [];
  playerColony.rallyPoint = null;
  playerColony.digFlowFieldDirty = false;
  world.colonies[PLAYER_COLONY_ID] = playerColony;

  // Enemy queen at the combat tile in ENEMY underground grid.
  const enemyQueenId = allocateEntityId(world);
  initAnt(world.ants, enemyQueenId, {
    colonyId: ENEMY_COLONY_ID,
    posX:     (queenTileX << FP_SHIFT) + (FP_ONE >> 1),
    posY:     (queenTileY << FP_SHIFT) + (FP_ONE >> 1),
    task:     AntTask.Idle,
    subTask:  0,
    speed:    0,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Underground,
  });
  // Same colony, same grid — default from initAnt already sets
  // currentGridColonyId = colonyId = ENEMY, but we re-assign for clarity.
  world.ants.currentGridColonyId[enemyQueenId] = ENEMY_COLONY_ID;
  const enemyColony = createColonyRecord(ENEMY_COLONY_ID as ColonyId, enemyQueenId);
  enemyColony.entrances = [];
  enemyColony.rallyPoint = null;
  enemyColony.digFlowFieldDirty = false;
  world.colonies[ENEMY_COLONY_ID] = enemyColony;

  // Player Fighter colocated with the enemy queen, inside the ENEMY grid.
  // This ant is the outcome of plans 0+3: descended through the enemy
  // entrance, `currentGridColonyId=ENEMY` (grid of occupancy), while
  // `colonyId=PLAYER` (owning colony).
  const playerAntId = allocateEntityId(world);
  initAnt(world.ants, playerAntId, {
    colonyId: PLAYER_COLONY_ID,
    posX:     (queenTileX << FP_SHIFT) + (FP_ONE >> 1),
    posY:     (queenTileY << FP_SHIFT) + (FP_ONE >> 1),
    task:     AntTask.Fighting,
    subTask:  FightingSubState.Engaging,
    speed:    WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Underground,
  });
  world.ants.currentGridColonyId[playerAntId] = ENEMY_COLONY_ID;
  world.colonies[PLAYER_COLONY_ID]!.workers.push(playerAntId);
  world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;

  return { world, playerAntId, enemyQueenId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('combat cross-grid — tile-key gridColonyId extension (REQ-C4)', () => {
  it('REQ-C4a: player fighter kills enemy queen in enemy grid → Victory', () => {
    // seed=3 → new Rng(3).nextInt(2) === 0 → flip=0 kills groupB (enemy) first
    // (see file header for derivation). We also set world.rngState=3 right
    // before the combat call so no upstream consumer perturbs the state.
    const { world, playerAntId, enemyQueenId } = buildCrossGridWorld(3, 5, 5);

    // MANDATORY t=0 precondition assertions -----------------------------------
    expect(world.ants.alive[playerAntId]).toBe(1);
    expect(world.ants.alive[enemyQueenId]).toBe(1);
    expect(world.ants.zone[playerAntId]).toBe(Zone.Underground);
    expect(world.ants.zone[enemyQueenId]).toBe(Zone.Underground);
    // Both ants share the (tileX, tileY) pair inside the ENEMY grid.
    expect(world.ants.posX[playerAntId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[playerAntId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posX[enemyQueenId]! >> FP_SHIFT).toBe(5);
    expect(world.ants.posY[enemyQueenId]! >> FP_SHIFT).toBe(5);
    // Grid-of-occupancy: both are in the ENEMY grid.
    expect(world.ants.currentGridColonyId[playerAntId]).toBe(ENEMY_COLONY_ID);
    expect(world.ants.currentGridColonyId[enemyQueenId]).toBe(ENEMY_COLONY_ID);
    // Owning colonies diverge (player invades enemy territory).
    expect(world.ants.colonyId[playerAntId]).toBe(PLAYER_COLONY_ID);
    expect(world.ants.colonyId[enemyQueenId]).toBe(ENEMY_COLONY_ID);

    // Act --------------------------------------------------------------------
    // Pin rngState to the known-player-wins seed value immediately before combat.
    // Use V15 resolver: this test verifies cross-grid tile-key bucketing, not V16 HP math.
    world.rngState = 3;
    world.simVersion = 15;
    detectAndResolveCombat(world, new Rng(world.rngState));

    // MANDATORY t=N outcome assertions ---------------------------------------
    // Enemy queen is dead.
    expect(world.ants.alive[enemyQueenId]).toBe(0);
    // Player fighter is alive.
    expect(world.ants.alive[playerAntId]).toBe(1);
    // Victory: enemy queen dead + player queen alive.
    expect(checkQueenDeath(world)).toBe(GameOutcome.Victory);
  });

  it('REQ-C4b: ants at same (tileX,tileY) in DIFFERENT grids do NOT fight', () => {
    // Build a bare 2-colony world without the cross-grid player ant —
    // we'll construct a cleaner scenario where one ant lives in the player
    // grid and the other in the enemy grid, both at (7,7) Underground.
    const world = createWorldState(42);

    // Queens placed at distinct tiles far from the combat tile (7,7).
    const playerQueen = allocateEntityId(world);
    initAnt(world.ants, playerQueen, {
      colonyId: PLAYER_COLONY_ID,
      posX:     (0 << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (0 << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Idle,
      subTask:  0,
      speed:    0,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone:     Zone.Surface,
    });
    const pc = createColonyRecord(PLAYER_COLONY_ID as ColonyId, playerQueen);
    pc.entrances = []; pc.rallyPoint = null; pc.digFlowFieldDirty = false;
    world.colonies[PLAYER_COLONY_ID] = pc;

    const enemyQueen = allocateEntityId(world);
    initAnt(world.ants, enemyQueen, {
      colonyId: ENEMY_COLONY_ID,
      posX:     (1 << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (0 << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Idle,
      subTask:  0,
      speed:    0,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone:     Zone.Surface,
    });
    const ec = createColonyRecord(ENEMY_COLONY_ID as ColonyId, enemyQueen);
    ec.entrances = []; ec.rallyPoint = null; ec.digFlowFieldDirty = false;
    world.colonies[ENEMY_COLONY_ID] = ec;

    // Ant A: player-colony ant in the PLAYER grid at (7,7) Underground.
    const antA = allocateEntityId(world);
    initAnt(world.ants, antA, {
      colonyId: PLAYER_COLONY_ID,
      posX:     (7 << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (7 << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Idle,
      subTask:  0,
      speed:    WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone:     Zone.Underground,
    });
    world.ants.currentGridColonyId[antA] = PLAYER_COLONY_ID;
    world.colonies[PLAYER_COLONY_ID]!.workers.push(antA);
    world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;

    // Ant B: enemy-colony ant in the ENEMY grid at (7,7) Underground.
    const antB = allocateEntityId(world);
    initAnt(world.ants, antB, {
      colonyId: ENEMY_COLONY_ID,
      posX:     (7 << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (7 << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Idle,
      subTask:  0,
      speed:    WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone:     Zone.Underground,
    });
    world.ants.currentGridColonyId[antB] = ENEMY_COLONY_ID;
    world.colonies[ENEMY_COLONY_ID]!.workers.push(antB);
    world.colonies[ENEMY_COLONY_ID]!.workerCount += 1;

    // MANDATORY t=0 precondition assertions -----------------------------------
    expect(world.ants.alive[antA]).toBe(1);
    expect(world.ants.alive[antB]).toBe(1);
    expect(world.ants.zone[antA]).toBe(Zone.Underground);
    expect(world.ants.zone[antB]).toBe(Zone.Underground);
    expect(world.ants.posX[antA]! >> FP_SHIFT).toBe(7);
    expect(world.ants.posY[antA]! >> FP_SHIFT).toBe(7);
    expect(world.ants.posX[antB]! >> FP_SHIFT).toBe(7);
    expect(world.ants.posY[antB]! >> FP_SHIFT).toBe(7);
    // Key setup invariant: different grids.
    expect(world.ants.currentGridColonyId[antA]).toBe(PLAYER_COLONY_ID);
    expect(world.ants.currentGridColonyId[antB]).toBe(ENEMY_COLONY_ID);
    // And different owning colonies — so if they DID bucket, they'd fight.
    expect(world.ants.colonyId[antA]).toBe(PLAYER_COLONY_ID);
    expect(world.ants.colonyId[antB]).toBe(ENEMY_COLONY_ID);

    // Act --------------------------------------------------------------------
    detectAndResolveCombat(world, new Rng(world.rngState));

    // MANDATORY t=N outcome assertions ---------------------------------------
    // Neither ant died — they never bucketed together.
    expect(world.ants.alive[antA]).toBe(1);
    expect(world.ants.alive[antB]).toBe(1);
    // Neither colony scored a kill.
    expect(world.colonies[PLAYER_COLONY_ID]!.killCount).toBe(0);
    expect(world.colonies[ENEMY_COLONY_ID]!.killCount).toBe(0);
  });
});
