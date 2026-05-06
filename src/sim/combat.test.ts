import { describe, it, expect } from 'vitest';
import { detectAndResolveCombat, killAnt } from './combat.js';
import { createWorldState, allocateEntityId } from './types.js';
import { Rng } from './rng.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { WORKER_BASE_SPEED, WORKER_LIFESPAN_TICKS } from './constants.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

// Helper: build a minimal 2-colony world with seeded rngState.
function makeWorldWith2Colonies(seed = 42): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const world = createWorldState(seed);
  // Place queens at distinct tiles far from worker spawn points (tile 5,7 is the combat tile in tests).
  // Queens at tile (0,0) and (1,0) so they never collide with each other or the test workers.
  const queen1 = allocateEntityId(world);
  initAnt(world.ants, queen1, { colonyId: 1, posX: 0 << FP_SHIFT, posY: 0 << FP_SHIFT, task: AntTask.Idle, subTask: 0, speed: 0, lifespan: WORKER_LIFESPAN_TICKS });
  const colony1 = createColonyRecord(1 as ColonyId, queen1);
  colony1.entrances = [];
  colony1.rallyPoint = null;
  colony1.digFlowFieldDirty = false;
  world.colonies[1] = colony1;

  const queen2 = allocateEntityId(world);
  initAnt(world.ants, queen2, { colonyId: 2, posX: 1 << FP_SHIFT, posY: 0 << FP_SHIFT, task: AntTask.Idle, subTask: 0, speed: 0, lifespan: WORKER_LIFESPAN_TICKS });
  const colony2 = createColonyRecord(2 as ColonyId, queen2);
  colony2.entrances = [];
  colony2.rallyPoint = null;
  colony2.digFlowFieldDirty = false;
  world.colonies[2] = colony2;

  return { world, cid1: 1 as ColonyId, cid2: 2 as ColonyId };
}

// Helper: spawn a worker ant of colonyId at (tileX, tileY, zone). Returns slot index.
function spawnAnt(world: WorldState, colonyId: ColonyId, tileX: number, tileY: number, zone: Zone): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId, posX: (tileX << FP_SHIFT) + (FP_ONE >> 1), posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle, subTask: 0, speed: WORKER_BASE_SPEED, zone,
  });
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

describe('detectAndResolveCombat', () => {
  it('does nothing when no two ants share a tile', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const a = spawnAnt(world, cid1, 5, 5, Zone.Surface);
    const b = spawnAnt(world, cid2, 10, 10, Zone.Surface);
    detectAndResolveCombat(world, new Rng(world.rngState));
    expect(world.ants.alive[a]).toBe(1);
    expect(world.ants.alive[b]).toBe(1);
    expect(world.colonies[cid1]!.killCount).toBe(0);
    expect(world.colonies[cid2]!.killCount).toBe(0);
  });

  it('does nothing when ants share a tile but are from the same colony', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    const a = spawnAnt(world, cid1, 7, 7, Zone.Surface);
    const b = spawnAnt(world, cid1, 7, 7, Zone.Surface);
    detectAndResolveCombat(world, new Rng(world.rngState));
    expect(world.ants.alive[a]).toBe(1);
    expect(world.ants.alive[b]).toBe(1);
  });

  it('resolves combat when 2 ants from different colonies share a tile — one dies, winner killCount increments', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const a = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    const b = spawnAnt(world, cid2, 5, 7, Zone.Surface);
    detectAndResolveCombat(world, new Rng(world.rngState));
    const aliveCount = world.ants.alive[a]! + world.ants.alive[b]!;
    expect(aliveCount).toBe(1); // exactly one died
    const totalKills = world.colonies[cid1]!.killCount + world.colonies[cid2]!.killCount;
    expect(totalKills).toBe(1);
  });

  it('surface (5,7) and underground (5,7) do NOT fight (zone separation)', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const a = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    const b = spawnAnt(world, cid2, 5, 7, Zone.Underground);
    detectAndResolveCombat(world, new Rng(world.rngState));
    expect(world.ants.alive[a]).toBe(1);
    expect(world.ants.alive[b]).toBe(1);
    expect(world.colonies[cid1]!.killCount).toBe(0);
    expect(world.colonies[cid2]!.killCount).toBe(0);
  });

  it('is deterministic: same rngState + same placements produces the same survivor', () => {
    const build = () => {
      const x = makeWorldWith2Colonies(42);
      const a = spawnAnt(x.world, x.cid1, 5, 7, Zone.Surface);
      const b = spawnAnt(x.world, x.cid2, 5, 7, Zone.Surface);
      return { ...x, a, b };
    };
    const run1 = build();
    detectAndResolveCombat(run1.world, new Rng(run1.world.rngState));
    const run2 = build();
    detectAndResolveCombat(run2.world, new Rng(run2.world.rngState));
    expect(run1.world.ants.alive[run1.a]).toBe(run2.world.ants.alive[run2.a]);
    expect(run1.world.ants.alive[run1.b]).toBe(run2.world.ants.alive[run2.b]);
  });
});

describe('resolveCombatOnTile', () => {
  it('resolves 3-way combat until one colony remains', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    // Add a 3rd colony — queen placed at tile (2,0) to avoid collision with queens 1,2 at tiles (0,0)/(1,0).
    const queen3 = allocateEntityId(world);
    initAnt(world.ants, queen3, { colonyId: 3, posX: 2 << FP_SHIFT, posY: 0, task: AntTask.Idle, subTask: 0, speed: 0 });
    const colony3 = createColonyRecord(3 as ColonyId, queen3);
    colony3.entrances = [];
    colony3.rallyPoint = null;
    colony3.digFlowFieldDirty = false;
    world.colonies[3] = colony3;

    const a = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    const b = spawnAnt(world, cid2, 5, 7, Zone.Surface);
    const c = spawnAnt(world, 3 as ColonyId, 5, 7, Zone.Surface);
    detectAndResolveCombat(world, new Rng(world.rngState));
    const alive = [world.ants.alive[a] ?? 0, world.ants.alive[b] ?? 0, world.ants.alive[c] ?? 0];
    expect(alive.reduce((s, v) => s + v, 0)).toBe(1); // exactly one survives
  });

  it('advances the caller-passed rng exactly once per round (#58)', () => {
    // Issue #58 — combat no longer writes back to world.rngState; tick.ts
    // owns the single end-of-tick writeback via the shared rng_tick instance.
    // This test pins the new contract: combat advances the rng IT was given,
    // not world.rngState directly.
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    spawnAnt(world, cid1, 5, 7, Zone.Surface);
    spawnAnt(world, cid2, 5, 7, Zone.Surface);
    const rng = new Rng(world.rngState);
    const before = rng.getState();
    detectAndResolveCombat(world, rng);
    // One round = one nextInt(2) call = one state advance. State should differ.
    expect(rng.getState()).not.toBe(before);
    // And world.rngState is NOT touched by combat directly anymore.
    expect(world.rngState).toBe(before);
  });
});

describe('killAnt', () => {
  it('zeroes alive flag on victim', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    killAnt(world, v, cid2);
    expect(world.ants.alive[v]).toBe(0);
  });

  it('increments killer colony killCount by 1', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    expect(world.colonies[cid2]!.killCount).toBe(0);
    killAnt(world, v, cid2);
    expect(world.colonies[cid2]!.killCount).toBe(1);
  });

  it('does not increment killCount when killerColonyId is 0', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    killAnt(world, v, 0 as ColonyId);
    expect(world.ants.alive[v]).toBe(0);
    expect(world.colonies[cid1]!.killCount).toBe(0);
  });

  it('does NOT remove entity from roster (tickDeathCleanup owns roster swap-remove)', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    expect(world.colonies[cid1]!.workers).toContain(v);
    killAnt(world, v, cid2);
    // Combat.killAnt intentionally does NOT cleanup the roster. The alive=0 flag is enough;
    // tickDeathCleanup (colony-system.ts:165) handles the roster next tick.
    expect(world.colonies[cid1]!.workers).toContain(v);
    expect(world.colonies[cid1]!.workerCount).toBe(1); // unchanged by combat.killAnt
  });

  // ---------------------------------------------------------------------
  // Issue #107 — V13+ atomically clears bidirectional carry pointers.
  // ---------------------------------------------------------------------
  it('#107 (V13+) clears carryingBroodId and the brood\'s carriedBy when a carrier is killed', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 13;
    const carrier = spawnAnt(world, cid1, 5, 7, Zone.Underground);
    const brood = spawnAnt(world, cid1, 5, 7, Zone.Underground);
    world.ants.carryingBroodId[carrier] = brood;
    world.ants.carriedBy[brood] = carrier;
    killAnt(world, carrier, cid2);
    expect(world.ants.alive[carrier]).toBe(0);
    expect(world.ants.carryingBroodId[carrier]).toBe(-1);
    expect(world.ants.carriedBy[brood]).toBe(-1);
  });

  it('#107 (V13+) symmetric — when the carried entity is killed, carrier\'s carryingBroodId clears', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 13;
    const carrier = spawnAnt(world, cid1, 5, 7, Zone.Underground);
    const brood = spawnAnt(world, cid1, 5, 7, Zone.Underground);
    world.ants.carryingBroodId[carrier] = brood;
    world.ants.carriedBy[brood] = carrier;
    killAnt(world, brood, cid2);
    expect(world.ants.alive[brood]).toBe(0);
    expect(world.ants.carryingBroodId[carrier]).toBe(-1);
    expect(world.ants.carriedBy[brood]).toBe(-1);
  });

  it('#107 pre-V13 retains legacy stale-pointer behavior (replay byte-identity)', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 12; // legacy
    const carrier = spawnAnt(world, cid1, 5, 7, Zone.Underground);
    const brood = spawnAnt(world, cid1, 5, 7, Zone.Underground);
    world.ants.carryingBroodId[carrier] = brood;
    world.ants.carriedBy[brood] = carrier;
    killAnt(world, carrier, cid2);
    expect(world.ants.alive[carrier]).toBe(0);
    // Legacy: pointers persist past death — the bug this V13 fix addresses.
    expect(world.ants.carryingBroodId[carrier]).toBe(brood);
    expect(world.ants.carriedBy[brood]).toBe(carrier);
  });

  it('#107 (V13+) is a no-op for ants without active carry slots (regression guard)', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 13;
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    // Default state: carryingBroodId = -1, carriedBy = -1.
    killAnt(world, v, cid2);
    expect(world.ants.alive[v]).toBe(0);
    expect(world.ants.carryingBroodId[v]).toBe(-1);
    expect(world.ants.carriedBy[v]).toBe(-1);
  });
});

describe('coin flip distribution (CMBT-05)', () => {
  it('over 1000 fights, A-wins is within ±3σ of 500 (approx 453..547)', () => {
    // Issue #58 — combat now advances the rng instance the caller passes,
    // not world.rngState. Pass ONE shared rng across all iterations so the
    // sequence advances naturally between fights (the prior test relied on
    // combat's now-removed writeback to world.rngState).
    const { world, cid1, cid2 } = makeWorldWith2Colonies(42);
    const rng = new Rng(world.rngState);
    let aWins = 0;
    for (let i = 0; i < 1000; i++) {
      // Reset only the two combatants — keep rng unchanged between iterations.
      const a = spawnAnt(world, cid1, 5, 7, Zone.Surface);
      const b = spawnAnt(world, cid2, 5, 7, Zone.Surface);
      detectAndResolveCombat(world, rng);
      if (world.ants.alive[a] === 1) aWins += 1;
      // Kill the survivor (whichever) so next iteration starts fresh — set both alive=0 to avoid
      // cross-iteration state. spawnAnt allocates new ids so there is no slot collision.
      world.ants.alive[a] = 0;
      world.ants.alive[b] = 0;
      // Reset killCount deltas too — don't leak across iterations.
      world.colonies[cid1]!.killCount = 0;
      world.colonies[cid2]!.killCount = 0;
    }
    expect(aWins).toBeGreaterThanOrEqual(453);
    expect(aWins).toBeLessThanOrEqual(547);
  });
});
