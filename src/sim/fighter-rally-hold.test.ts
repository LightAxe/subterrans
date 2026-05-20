// fighter-rally-hold.test.ts — regression tests for the rally hold-radius fix.
//
// Bug: in debug snapshot subterrans-debug-seed1019075463-tick10204.json,
// four Fighting ants (ids 39, 41, 55, 61) clustered around colony 1's
// rallyPoint={tileX:99, tileY:58} visibly stutter ABAB between tiles every
// tick. Root cause: updateFightAntTargets (ant-system.ts tick step 10c)
// unconditionally writes the EXACT tile-center of the rally tile as
// targetPosX/targetPosY for every surface Fighting ant every tick. The
// occupancy resolver (resolveSameColonyOccupancy, post-movement pass) then
// bumps collided same-colony ants one tile N/E/S/W — and on the NEXT tick
// updateFightAntTargets re-writes the same rally target, so the fighter
// walks back, collides again, gets bumped again. Visible ABAB oscillation.
//
// Fix: updateFightAntTargets clears the target to -1 when the fighter is
// already within Manhattan RALLY_HOLD_RADIUS_TILES of the rally. The
// Fighting branch in tickAntMovement treats targetPosX/Y === -1 as "no
// target → dx=dy=0 hold in place". The occupancy resolver then sees
// distinct starting tiles, bumps nothing, ants stay put. No oscillation.
//
// Radius is 2 (Manhattan): the 13-tile hold zone (center + 12 M2 tiles)
// comfortably absorbs the occupancy resolver's single-step bump footprint
// for any realistic rally-gathering group, and still feels "at the rally"
// to the player visually.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { updateFightAntTargets } from './ant/ant-system.js';
import { createScenario } from './scenario.js';
import { createWorldState, allocateEntityId } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  ENEMY_START_X,
  ENEMY_START_Y,
} from './constants.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLONY_ID = 1 as ColonyId;

interface RallyWorld {
  world:       WorldState;
  fighterIds:  number[];
  rallyTileX:  number;
  rallyTileY:  number;
}

/**
 * Build a single-colony world with a queen far from the rally + N Fighting
 * ants placed at the given starting tiles. Rally is set to (rallyTileX,
 * rallyTileY). No entrances, no underground grid — surface-only scenario.
 */
function buildRallyWorld(
  rallyTileX: number,
  rallyTileY: number,
  startTiles: Array<readonly [number, number]>,
): RallyWorld {
  const world = createWorldState(42);

  // Queen at a distant tile — she must exist so checkQueenDeath doesn't fire
  // Defeat (queenEntityId defaults to 0, and ants.alive[0] would be 0 without
  // a real queen allocation). Place her far from the rally so she isn't in
  // any fighter's hold zone or bump path.
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId: COLONY_ID,
    posX:     (5 << FP_SHIFT) + (FP_ONE >> 1),
    posY:     (5 << FP_SHIFT) + (FP_ONE >> 1),
    task:     AntTask.Idle,
    subTask:  0,
    speed:    0,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone:     Zone.Surface,
  });

  const colony = createColonyRecord(COLONY_ID, queenId);
  colony.entrances         = [];
  colony.rallyPoint        = { tileX: rallyTileX, tileY: rallyTileY };
  colony.digFlowFieldDirty = false;
  colony.foodStored        = 100000; // ample — no starvation during the run
  world.colonies[COLONY_ID] = colony;

  const fighterIds: number[] = [];
  for (const [tx, ty] of startTiles) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: COLONY_ID,
      posX:     (tx << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (ty << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Fighting,
      subTask:  FightingSubState.MovingToRally,
      speed:    WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone:     Zone.Surface,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
    fighterIds.push(id);
  }

  return { world, fighterIds, rallyTileX, rallyTileY };
}

function tileXOf(world: WorldState, id: number): number {
  return world.ants.posX[id]! >> FP_SHIFT;
}
function tileYOf(world: WorldState, id: number): number {
  return world.ants.posY[id]! >> FP_SHIFT;
}
function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** Run N ticks (drain command queue each tick; there are no commands). */
function tickN(world: WorldState, n: number): void {
  for (let t = 0; t < n; t++) {
    const cmds = world.commandQueue.splice(0);
    tick(world, cmds);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fighter rally hold — anti-oscillation (snapshot-reproduction bug)', () => {
  // Tile coords taken directly from the reporting debug snapshot
  // subterrans-debug-seed1019075463-tick10204.json: colony 1 rallyPoint
  // {tileX:99, tileY:58}, 4 fighters observed at (99,58), (99,57), (99,56),
  // (100,58) — a 4-tile cross around the rally, the classic single-step
  // occupancy-bump footprint.
  const RALLY_X = 99;
  const RALLY_Y = 58;

  it('Test 1: six clustered fighters stabilize within the hold radius without oscillating ABAB', () => {
    // Six fighters placed at 6 distinct tiles: rally center + 4 cardinals
    // (radius 1) + a radius-2 tile. All within the target radius-2 hold
    // zone. With the hold-radius fix each fighter sees target=-1 and holds
    // (dx=dy=0). Without the fix each fighter re-targets the rally center
    // every tick, walks toward it, collides, gets bumped — visible ABAB.
    const startTiles: Array<readonly [number, number]> = [
      [RALLY_X,     RALLY_Y    ], // center
      [RALLY_X,     RALLY_Y - 1], // N
      [RALLY_X + 1, RALLY_Y    ], // E
      [RALLY_X,     RALLY_Y + 1], // S
      [RALLY_X - 1, RALLY_Y    ], // W
      [RALLY_X,     RALLY_Y - 2], // N2 (radius 2)
    ];
    const { world, fighterIds } = buildRallyWorld(RALLY_X, RALLY_Y, startTiles);

    // MANDATORY t=0 preconditions — confirm harness staged the scenario.
    expect(fighterIds.length).toBe(6);
    for (const id of fighterIds) {
      expect(world.ants.alive[id]).toBe(1);
      expect(world.ants.task[id]).toBe(AntTask.Fighting);
      expect(world.ants.zone[id]).toBe(Zone.Surface);
    }
    // No two fighters share a starting tile (precondition for the
    // "tile-end distinct" invariant assertion below — if setup broke and
    // two fighters started on the same tile, the resolver would move
    // one on tick 1 and the assertion would be meaningless).
    const startKeys = new Set<string>();
    for (const id of fighterIds) {
      startKeys.add(`${tileXOf(world, id)},${tileYOf(world, id)}`);
    }
    expect(startKeys.size).toBe(6);

    // Act — record each fighter's tile AND fixed-point position at every
    // tick. The tile coord is what the player "sees" in the debugger — but
    // occupancy-bump oscillation can be invisible at tile resolution if
    // the ant's movement in a tick undershoots the bump distance (e.g.
    // speed=0.5 tile/tick leaves the ant at half-tile fp positions that
    // floor to the same tile). The fp position is what the render layer
    // interpolates between (prev → current frame), so fp-level ABAB shows
    // up visually as jitter even when tile coords look stable across
    // end-of-tick snapshots.
    const TICKS = 30;
    interface Snap { tileX: number; tileY: number; posX: number; posY: number }
    const trace: Snap[][] = [];
    for (let t = 0; t < TICKS; t++) {
      const cmds = world.commandQueue.splice(0);
      tick(world, cmds);
      const snap: Snap[] = [];
      for (const id of fighterIds) {
        snap.push({
          tileX: tileXOf(world, id),
          tileY: tileYOf(world, id),
          posX:  world.ants.posX[id]!,
          posY:  world.ants.posY[id]!,
        });
      }
      trace.push(snap);
    }

    // Assertion A: no two fighters ever share a tile at tick-end (sanity —
    // the occupancy resolver already enforces this; confirms the resolver
    // is functioning and no fighter was accidentally teleported).
    for (let t = 0; t < TICKS; t++) {
      const perTickKeys = new Set<string>();
      for (const s of trace[t]!) {
        perTickKeys.add(`${s.tileX},${s.tileY}`);
      }
      expect(perTickKeys.size).toBe(6);
    }

    // Assertion B: after TICKS ticks, every fighter is within Manhattan
    // radius 3 of the rally — fighters stayed gathered. Radius 3 (not 2)
    // tolerates a single occupancy-bump step outside the hold zone, which
    // is legal transient state but should NOT repeat.
    for (const id of fighterIds) {
      const d = manhattan(tileXOf(world, id), tileYOf(world, id), RALLY_X, RALLY_Y);
      expect(d).toBeLessThanOrEqual(3);
    }

    // Assertion C (the RED discriminator): over the last 10 ticks each
    // fighter's fixed-point (posX, posY) MUST be stable — exactly one
    // unique fp coordinate per ant. Oscillating at fp-resolution makes
    // this set size ≥ 2; holding in place (target=-1 → dx=dy=0) makes
    // it 1. The unfixed code fails here because the occupancy resolver
    // snaps a bumped ant to `tile << FP_SHIFT` while the next tick's
    // "walk toward rally tile center" target is `(tile << FP_SHIFT) +
    // (FP_ONE >> 1)` — the ant moves +128 fp each tick and gets bumped
    // back the next tick, producing a two-state fp cycle that the
    // renderer interpolates as visible jitter.
    const TAIL = 10;
    const startIdx = TICKS - TAIL;
    for (let fi = 0; fi < fighterIds.length; fi++) {
      const positions = new Set<string>();
      for (let t = startIdx; t < TICKS; t++) {
        const s = trace[t]![fi]!;
        positions.add(`${s.posX},${s.posY}`);
      }
      expect(positions.size).toBe(1);
    }
  });

  it('Test 2: far-away fighter still travels toward rally (hold-radius must not strand distant fighters)', () => {
    const { world, fighterIds } = buildRallyWorld(RALLY_X, RALLY_Y, [[5, 5]]);
    const id = fighterIds[0]!;

    // MANDATORY t=0 preconditions.
    const d0 = manhattan(tileXOf(world, id), tileYOf(world, id), RALLY_X, RALLY_Y);
    expect(d0).toBe(Math.abs(5 - RALLY_X) + Math.abs(5 - RALLY_Y));
    expect(world.ants.task[id]).toBe(AntTask.Fighting);

    tickN(world, 50);

    // Outcome — the fighter moved strictly closer to the rally.
    const dN = manhattan(tileXOf(world, id), tileYOf(world, id), RALLY_X, RALLY_Y);
    expect(dN).toBeLessThan(d0);
  });

  it('Test 3: fighter exactly at rally → updateFightAntTargets clears target to -1', () => {
    const { world, fighterIds } = buildRallyWorld(RALLY_X, RALLY_Y, [[RALLY_X, RALLY_Y]]);
    const id = fighterIds[0]!;

    // MANDATORY t=0 preconditions.
    expect(tileXOf(world, id)).toBe(RALLY_X);
    expect(tileYOf(world, id)).toBe(RALLY_Y);
    expect(world.ants.task[id]).toBe(AntTask.Fighting);
    expect(world.ants.zone[id]).toBe(Zone.Surface);

    updateFightAntTargets(world);

    // Outcome — target cleared (hold in place).
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.targetPosY[id]).toBe(-1);
  });

  it('Test 4: fighter one tile east of rally (Manhattan=1, inside radius 2) → target cleared to -1', () => {
    const { world, fighterIds } = buildRallyWorld(RALLY_X, RALLY_Y, [[RALLY_X + 1, RALLY_Y]]);
    const id = fighterIds[0]!;

    // MANDATORY t=0 preconditions.
    expect(manhattan(tileXOf(world, id), tileYOf(world, id), RALLY_X, RALLY_Y)).toBe(1);
    expect(world.ants.task[id]).toBe(AntTask.Fighting);
    expect(world.ants.zone[id]).toBe(Zone.Surface);

    updateFightAntTargets(world);

    // Outcome — inside radius → target cleared.
    expect(world.ants.targetPosX[id]).toBe(-1);
    expect(world.ants.targetPosY[id]).toBe(-1);
  });

  it('Test 5: fighter three tiles west of rally (Manhattan=3, OUTSIDE radius 2) → target is rally tile center', () => {
    const { world, fighterIds } = buildRallyWorld(RALLY_X, RALLY_Y, [[RALLY_X - 3, RALLY_Y]]);
    const id = fighterIds[0]!;

    // MANDATORY t=0 preconditions.
    expect(manhattan(tileXOf(world, id), tileYOf(world, id), RALLY_X, RALLY_Y)).toBe(3);
    expect(world.ants.task[id]).toBe(AntTask.Fighting);
    expect(world.ants.zone[id]).toBe(Zone.Surface);

    updateFightAntTargets(world);

    // Outcome — outside radius → target is the rally tile center fp.
    expect(world.ants.targetPosX[id]).toBe((RALLY_X << FP_SHIFT) + (FP_ONE >> 1));
    expect(world.ants.targetPosY[id]).toBe((RALLY_Y << FP_SHIFT) + (FP_ONE >> 1));
  });
});

// ---------------------------------------------------------------------------
// Regression: rally-on-entrance must NOT trigger hold-radius (invasion path)
//
// Bug: when a player places the rally marker directly on an enemy open
// entrance, fighters approaching get within Manhattan radius 2 and the
// hold-radius code above clears their target to -1, stranding them 1-2
// tiles short of the entrance. The Surface→Underground descent block in
// tickAntMovement only fires when the ant is PHYSICALLY ON the entrance
// tile, so the fighters never descend and the invasion fails.
//
// Fix: updateFightAntTargets precomputes, once per call, a per-colony map
// of "does this colony's rally point coincide with any colony's open
// entrance tile?" If yes, the hold-radius suppression is skipped for that
// colony's fighters — they must walk onto the exact tile to trigger
// descent (or defensive descent, for rally-on-own-entrance).
//
// These tests exercise the 2-colony invasion case. Existing Tests 1-5
// above use a single-colony world with entrances=[], so the carve-out
// does NOT fire and the hold-radius still governs them.
// ---------------------------------------------------------------------------

/**
 * Build a 2-colony world using createScenario (which pre-excavates each
 * colony's shaft so entrance.isOpen=true). Set the player colony's rally
 * point to the enemy entrance tile. Spawn N player Fighting ants at the
 * provided surface tiles.
 *
 * Returns fighter ids plus the enemy entrance tile coords (which are also
 * the rally tile coords — that's the whole point of the test).
 */
interface InvasionRallyWorld {
  world:        WorldState;
  fighterIds:   number[];
  rallyTileX:   number;
  rallyTileY:   number;
}

function buildInvasionRallyWorld(
  startTiles: Array<readonly [number, number]>,
  seed = 42,
): InvasionRallyWorld {
  const world = createScenario(seed);

  const rallyTileX = ENEMY_START_X;
  const rallyTileY = ENEMY_START_Y;

  // Rally the PLAYER colony onto the enemy entrance tile.
  world.colonies[PLAYER_COLONY_ID]!.rallyPoint = {
    tileX: rallyTileX,
    tileY: rallyTileY,
  };

  // Sanity: enemy entrance is already open by createScenario.
  const enemyEntrances = world.colonies[ENEMY_COLONY_ID]!.entrances;
  if (enemyEntrances.length !== 1) {
    throw new Error(`expected exactly 1 enemy entrance, got ${enemyEntrances.length}`);
  }
  if (!enemyEntrances[0]!.isOpen) {
    throw new Error('expected enemy entrance to be open');
  }
  if (enemyEntrances[0]!.surfaceTileX !== rallyTileX
      || enemyEntrances[0]!.surfaceTileY !== rallyTileY) {
    throw new Error('expected enemy entrance to be at (ENEMY_START_X, ENEMY_START_Y)');
  }

  // Spawn player Fighting ants at the given start tiles.
  const fighterIds: number[] = [];
  for (const [tx, ty] of startTiles) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: PLAYER_COLONY_ID,
      posX:     (tx << FP_SHIFT) + (FP_ONE >> 1),
      posY:     (ty << FP_SHIFT) + (FP_ONE >> 1),
      task:     AntTask.Fighting,
      subTask:  FightingSubState.MovingToRally,
      speed:    WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone:     Zone.Surface,
    });
    world.colonies[PLAYER_COLONY_ID]!.workers.push(id);
    world.colonies[PLAYER_COLONY_ID]!.workerCount += 1;
    fighterIds.push(id);
  }

  // Model real game state: fight ratio > 0 so recall logic doesn't fire
  // immediately after descent (recall triggers when targetRatio.fight===0).
  world.colonies[PLAYER_COLONY_ID]!.targetRatio.fight = Math.max(5, fighterIds.length);

  return { world, fighterIds, rallyTileX, rallyTileY };
}

describe('fighter rally hold — carve out rally-on-entrance (invasion regression)', () => {
  it('Test 6: single fighter rallied on enemy entrance reaches the exact tile and descends', () => {
    // Start the fighter 5 tiles west of the rally/entrance on surface. At
    // WORKER_BASE_SPEED (~0.5 tiles/tick), 100 ticks is ample slack to
    // walk 5 tiles AND descend.
    const startX = ENEMY_START_X - 5;
    const startY = ENEMY_START_Y;
    const { world, fighterIds, rallyTileX, rallyTileY } = buildInvasionRallyWorld([
      [startX, startY],
    ]);
    const id = fighterIds[0]!;

    // MANDATORY t=0 preconditions — confirm harness staged the scenario.
    expect(world.ants.alive[id]).toBe(1);
    expect(world.ants.task[id]).toBe(AntTask.Fighting);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect(tileXOf(world, id)).toBe(startX);
    expect(tileYOf(world, id)).toBe(startY);
    expect(world.ants.colonyId[id]).toBe(PLAYER_COLONY_ID);
    expect(world.ants.currentGridColonyId[id]).toBe(PLAYER_COLONY_ID);
    expect(world.colonies[PLAYER_COLONY_ID]!.rallyPoint).toEqual({
      tileX: rallyTileX, tileY: rallyTileY,
    });

    // Act — tick until the fighter descends, or bail after MAX ticks.
    const MAX_TICKS = 100;
    let descendTick = -1;
    let prevTileX = startX;
    let prevTileY = startY;
    let tileBeforeDescend: [number, number] | null = null;
    for (let t = 0; t < MAX_TICKS; t++) {
      // Record tile at start of tick, BEFORE tick() runs — this is the
      // position from which any descent this tick will fire. If descent
      // fires during this tick, `tileBeforeDescend` captures the entry tile.
      prevTileX = tileXOf(world, id);
      prevTileY = tileYOf(world, id);

      const cmds = world.commandQueue.splice(0);
      tick(world, cmds);

      if (world.ants.zone[id] === Zone.Underground) {
        descendTick = t;
        tileBeforeDescend = [prevTileX, prevTileY];
        break;
      }
    }

    // MANDATORY outcome assertions -------------------------------------------
    // The fighter descended within the tick budget. WITHOUT the fix, this
    // will fail — the fighter gets within radius 2 and holds at (rallyX-2,
    // rallyY), never standing on the entrance tile.
    expect(descendTick).toBeGreaterThanOrEqual(0);
    // The tick before descent, the ant was one step from the entrance.
    // tickAntMovement applies its single-axis step AND the descent block in
    // the same tick, so the entrance tile itself is not observable at tick
    // boundaries — but arrival on it IS observable as the zone flip.
    // WITHOUT the fix, the ant gets within radius 2, the target is cleared,
    // and it holds at Manhattan=2 forever (descendTick stays -1 and the
    // assertion above fails first). WITH the fix, it marches to adjacent
    // (Manhattan≤1), then descends the next tick.
    expect(tileBeforeDescend).not.toBeNull();
    const manhattanBeforeDescend =
      Math.abs(tileBeforeDescend![0] - rallyTileX) +
      Math.abs(tileBeforeDescend![1] - rallyTileY);
    expect(manhattanBeforeDescend).toBeLessThanOrEqual(1);
    // Descent flipped the grid-of-occupancy to the enemy colony.
    expect(world.ants.zone[id]).toBe(Zone.Underground);
    expect(world.ants.currentGridColonyId[id]).toBe(ENEMY_COLONY_ID);
    // Ant's owning colony is still PLAYER — she's an invader, not a defector.
    expect(world.ants.colonyId[id]).toBe(PLAYER_COLONY_ID);
  });

  it('Test 7: four fighters rallied on enemy entrance all eventually descend', () => {
    // Four player Fighting ants at nearby tiles (not colocated — the
    // occupancy resolver would bump them apart on tick 1 anyway, but
    // distinct start tiles avoid confounding). They must descend
    // sequentially because only one ant can stand on the entrance tile
    // at a time (occupancy resolver enforces same-colony tile uniqueness
    // on the surface). Generous 300-tick budget covers all four.
    const startTiles: Array<readonly [number, number]> = [
      [ENEMY_START_X - 5, ENEMY_START_Y    ],
      [ENEMY_START_X - 5, ENEMY_START_Y + 1],
      [ENEMY_START_X - 4, ENEMY_START_Y    ],
      [ENEMY_START_X - 4, ENEMY_START_Y + 1],
    ];
    const { world, fighterIds } = buildInvasionRallyWorld(startTiles);
    expect(fighterIds.length).toBe(4);

    // MANDATORY t=0 preconditions for each fighter.
    for (const id of fighterIds) {
      expect(world.ants.alive[id]).toBe(1);
      expect(world.ants.task[id]).toBe(AntTask.Fighting);
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(world.ants.colonyId[id]).toBe(PLAYER_COLONY_ID);
      expect(world.ants.currentGridColonyId[id]).toBe(PLAYER_COLONY_ID);
    }

    // Act — tick until ALL four have descended, or bail after MAX.
    const MAX_TICKS = 300;
    const descended = new Set<number>();
    for (let t = 0; t < MAX_TICKS && descended.size < fighterIds.length; t++) {
      const cmds = world.commandQueue.splice(0);
      tick(world, cmds);
      for (const id of fighterIds) {
        if (world.ants.zone[id] === Zone.Underground) descended.add(id);
      }
    }

    // MANDATORY outcome assertions — every fighter ended up underground in
    // the enemy grid. WITHOUT the fix, ALL four get stranded within radius
    // 2 and never descend; descended.size stays 0.
    expect(descended.size).toBe(fighterIds.length);
    for (const id of fighterIds) {
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(world.ants.currentGridColonyId[id]).toBe(ENEMY_COLONY_ID);
      expect(world.ants.colonyId[id]).toBe(PLAYER_COLONY_ID);
    }
  });
});
