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

// Helper: spawn a fighting ant (AntTask.Fighting) for V16 combat tests.
function spawnFighter(world: WorldState, colonyId: ColonyId, tileX: number, tileY: number, zone: Zone): number {
  const id = spawnAnt(world, colonyId, tileX, tileY, zone);
  world.ants.task[id] = AntTask.Fighting;
  return id;
}

describe('detectAndResolveCombat (V15 coin-flip path)', () => {
  it('does nothing when no two ants share a tile', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 15; // pin to V15 coin-flip path
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
    world.simVersion = 15;
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
      x.world.simVersion = 15;
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

describe('resolveCombatOnTile_v15 (legacy coin-flip)', () => {
  it('resolves 3-way combat until one colony remains', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 15;
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
    world.simVersion = 15;
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
    killAnt(world, v, cid2, null, 'Ant');
    expect(world.ants.alive[v]).toBe(0);
  });

  it('increments killer colony killCount by 1', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    expect(world.colonies[cid2]!.killCount).toBe(0);
    killAnt(world, v, cid2, null, 'Ant');
    expect(world.colonies[cid2]!.killCount).toBe(1);
  });

  it('does not increment killCount when killerColonyId is null', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    killAnt(world, v, null, null, 'Ant');
    expect(world.ants.alive[v]).toBe(0);
    expect(world.colonies[cid1]!.killCount).toBe(0);
  });

  it('does NOT remove entity from roster (tickDeathCleanup owns roster swap-remove)', () => {
    const { world, cid1, cid2 } = makeWorldWith2Colonies();
    world.simVersion = 15; // avoid combat_kill emit on V16
    const v = spawnAnt(world, cid1, 5, 7, Zone.Surface);
    expect(world.colonies[cid1]!.workers).toContain(v);
    killAnt(world, v, cid2, null, 'Ant');
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
    killAnt(world, carrier, cid2, null, 'Ant');
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
    killAnt(world, brood, cid2, null, 'Ant');
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
    killAnt(world, carrier, cid2, null, 'Ant');
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
    killAnt(world, v, cid2, null, 'Ant');
    expect(world.ants.alive[v]).toBe(0);
    expect(world.ants.carryingBroodId[v]).toBe(-1);
    expect(world.ants.carriedBy[v]).toBe(-1);
  });
});

describe('coin flip distribution (CMBT-05, V15 path)', () => {
  it('over 1000 fights, A-wins is within ±3σ of 500 (approx 453..547)', () => {
    // Issue #58 — combat now advances the rng instance the caller passes,
    // not world.rngState. Pass ONE shared rng across all iterations so the
    // sequence advances naturally between fights (the prior test relied on
    // combat's now-removed writeback to world.rngState).
    const { world, cid1, cid2 } = makeWorldWith2Colonies(42);
    world.simVersion = 15; // pin to V15 coin-flip path
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

// =============================================================================
// S1 — V16 HP/damage/cooldown combat tests
// =============================================================================

import { COMBAT_HP_BASE, COMBAT_HP_HOMEGROUND_BONUS, COMBAT_COOLDOWN_TICKS, COMBAT_DAMAGE_BASE, COMBAT_DAMAGE_WORKER, COMBAT_DAMAGE_QUEEN, COMBAT_HP_QUEEN } from './constants.js';

function makeV16World(seed = 42): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const r = makeWorldWith2Colonies(seed);
  r.world.simVersion = 16;
  return r;
}

/** Run N ticks of combat on a world where ants are already on a contested tile. */
function runCombatTicks(world: WorldState, n: number): void {
  const rng = new Rng(world.rngState);
  for (let t = 0; t < n; t++) {
    detectAndResolveCombat(world, rng);
  }
}

describe('V16 combat resolver', () => {
  it('windup: no ant dies on first contested tick', () => {
    const { world, cid1, cid2 } = makeV16World();
    const a = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const b = spawnFighter(world, cid2, 5, 7, Zone.Surface);
    runCombatTicks(world, 1);
    // Windup tick — no strike, both alive
    expect(world.ants.alive[a]).toBe(1);
    expect(world.ants.alive[b]).toBe(1);
    // cooldown set to COMBAT_COOLDOWN_TICKS
    expect(world.ants.attackCooldown[a]).toBe(COMBAT_COOLDOWN_TICKS);
    expect(world.ants.attackCooldown[b]).toBe(COMBAT_COOLDOWN_TICKS);
  });

  it('no strike until cooldown decrements to 0 (first strike at T=6)', () => {
    const { world, cid1, cid2 } = makeV16World();
    const a = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const b = spawnFighter(world, cid2, 5, 7, Zone.Surface);
    runCombatTicks(world, 4); // windup + 3 decrements → cooldown = 2
    expect(world.ants.alive[a]).toBe(1);
    expect(world.ants.alive[b]).toBe(1);
    expect(world.ants.attackCooldown[a]).toBe(2);
    expect(world.ants.attackCooldown[b]).toBe(2);
  });

  it('1v1 surface: symmetric fight produces mutual kill (both die after 4 strikes)', () => {
    // Surface fight: no home-ground bonus. HP=16, damage=4 per side.
    // 4 strikes kill (4×4=16). Strikes at T=6,11,16,21 (windup T=1, decrement 5 ticks).
    // Both deal same damage → both reach hp=0 simultaneously on strike 4 (mutual kill).
    const { world, cid1, cid2 } = makeV16World();
    const a = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const b = spawnFighter(world, cid2, 5, 7, Zone.Surface);
    runCombatTicks(world, 21);
    // Symmetric fight = mutual kill: both dead
    expect(world.ants.alive[a]).toBe(0);
    expect(world.ants.alive[b]).toBe(0);
  });

  it('1v1 underground home defender vs attacker: home defender wins with HP=4 remaining at T=20 (D-32 TTK)', () => {
    // Home defender: on own colony grid → homeGroundBonusHp=4, hp=16, deals COMBAT_DAMAGE_HOMEGROUND=5.
    // Attacker: on enemy grid → homeGroundBonusHp=0, hp=16, deals COMBAT_DAMAGE_BASE=4.
    // T=5 (windup+5 ticks): strike 1. Defender takes 4→hp=16 (bonus absorbs). Attacker takes 5→hp=11.
    // T=10: strike 2. Defender bonus=0, hp=16-4=12. Attacker hp=11-5=6.
    // T=15: strike 3. Defender hp=12-4=8. Attacker hp=6-5=1.
    // T=20: strike 4. Defender hp=8-4=4. Attacker hp=1-5=-4 → DEAD.
    const { world, cid1, cid2 } = makeV16World();
    // Defender (cid1) on their own grid (currentGridColonyId=cid1, zone=Underground)
    const defender = spawnFighter(world, cid1, 5, 7, Zone.Underground);
    world.ants.currentGridColonyId[defender] = Number(cid1) as unknown as typeof world.ants.currentGridColonyId[0];
    // Attacker (cid2) on cid1's grid (invasion)
    const attacker = spawnFighter(world, cid2, 5, 7, Zone.Underground);
    world.ants.currentGridColonyId[attacker] = Number(cid1) as unknown as typeof world.ants.currentGridColonyId[0];

    // Run exactly COMBAT_COOLDOWN_TICKS+1 = 6 ticks per round, 4 rounds = 24 ticks total
    // But windup is on tick 1, first strike at tick 1+5=6. So T=6, T=12, T=18, T=24?
    // Wait - let me recount: windup happens when cooldown=0. T=1: windup, cooldown=5.
    // T=2: decrement to 4. T=3: 3. T=4: 2. T=5: 1. T=6: decrement to 0 → strike 1, reset to 5.
    // T=7: 4. ... T=11: 0 → strike 2. T=12: reset. ... T=16: 0 → strike 3. T=17: reset. ... T=21: 0 → strike 4.
    // So 4 strikes at T=6, T=11, T=16, T=21 with COMBAT_COOLDOWN_TICKS=5.
    runCombatTicks(world, 21);
    // Attacker should be dead, defender should be alive
    expect(world.ants.alive[attacker]).toBe(0);
    expect(world.ants.alive[defender]).toBe(1);
    // Defender's hp should be 4 after 4 strikes absorbed: bonus(4-4=0)+hp(16-4*3=4)
    // Wait: Strike 1: bonus depletes (4-4=0), hp=16. Strike 2: hp=16-4=12. Strike 3: hp=12-4=8. Strike 4: hp=8-4=4.
    expect(world.ants.hp[defender]).toBe(4);
  });

  it('simultaneous kills: both ants die on same tick when both hp<=0', () => {
    // Force both ants to have hp=4 (one strike kills) and no homeground bonus.
    const { world, cid1, cid2 } = makeV16World();
    const a = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const b = spawnFighter(world, cid2, 5, 7, Zone.Surface);
    // Wind up both (1 tick), then set hp to low value
    runCombatTicks(world, 1); // windup tick
    world.ants.hp[a] = 4; // will die on next strike
    world.ants.hp[b] = 4;
    world.ants.homeGroundBonusHp[a] = 0;
    world.ants.homeGroundBonusHp[b] = 0;
    // One more full round (5 ticks) to reach the strike
    runCombatTicks(world, 5);
    // Both should die (4 damage each, both at hp=4)
    expect(world.ants.alive[a]).toBe(0);
    expect(world.ants.alive[b]).toBe(0);
  });

  it('2v1: only one attacker is active; replacement winds up fresh after first dies', () => {
    const { world, cid1, cid2 } = makeV16World();
    const a1 = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const a2 = spawnFighter(world, cid1, 5, 7, Zone.Surface); // backup
    const b  = spawnFighter(world, cid2, 5, 7, Zone.Surface);
    // After windup, a1 and b are in combat; a2 should NOT have cooldown set
    runCombatTicks(world, 1);
    expect(world.ants.attackCooldown[a1]).toBe(COMBAT_COOLDOWN_TICKS); // active
    expect(world.ants.attackCooldown[a2]).toBe(0); // NOT active (not paired)
    expect(world.ants.attackCooldown[b]).toBe(COMBAT_COOLDOWN_TICKS);
  });

  it('replacement ant winds up fresh after first ally dies', () => {
    // a1 and b fight. b kills a1. a2 (backup) should wind up against b on the next tick.
    const { world, cid1, cid2 } = makeV16World();
    const a1 = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const a2 = spawnFighter(world, cid1, 5, 7, Zone.Surface); // backup (higher slot)
    const b  = spawnFighter(world, cid2, 5, 7, Zone.Surface);
    // Force a1 to die quickly: set hp=4 so one strike kills.
    runCombatTicks(world, 1); // windup tick (a1 vs b paired, a2 unpaired)
    world.ants.hp[a1] = 4;
    world.ants.homeGroundBonusHp[a1] = 0;
    runCombatTicks(world, 5); // first strike tick: b hits a1 for 4 → a1 dies
    expect(world.ants.alive[a1]).toBe(0); // a1 is dead
    // a1's kill resets a2's cooldown (via cooldown=0 on replacement side).
    // On next tick, a2 (now lowest slot from cid1) winds up against b.
    expect(world.ants.attackCooldown[a2]).toBe(0); // not yet in combat
    runCombatTicks(world, 1); // windup tick for a2 vs b
    expect(world.ants.attackCooldown[a2]).toBe(COMBAT_COOLDOWN_TICKS); // now wound up
    expect(world.ants.alive[b]).toBe(1); // b still alive (just wound up together)
  });

  it('home-ground bonus HP depletes first before base HP', () => {
    const { world, cid1, cid2 } = makeV16World();
    const defender = spawnFighter(world, cid1, 5, 7, Zone.Underground);
    world.ants.currentGridColonyId[defender] = Number(cid1) as unknown as typeof world.ants.currentGridColonyId[0];
    const attacker = spawnFighter(world, cid2, 5, 7, Zone.Underground);
    world.ants.currentGridColonyId[attacker] = Number(cid1) as unknown as typeof world.ants.currentGridColonyId[0];
    // Fighters skip windup: first strike fires on tick 1.
    // Attacker deals COMBAT_DAMAGE_BASE=4; defender bonus=4 absorbs all → bonus=0, base HP intact.
    runCombatTicks(world, 1);
    expect(world.ants.homeGroundBonusHp[defender]).toBe(0);   // bonus fully depleted by first strike
    expect(world.ants.hp[defender]).toBe(COMBAT_HP_BASE);     // base HP untouched
    // Second strike fires at tick 1 + COMBAT_COOLDOWN_TICKS = 6. Bonus=0 → base HP takes damage.
    runCombatTicks(world, COMBAT_COOLDOWN_TICKS);
    expect(world.ants.homeGroundBonusHp[defender]).toBe(0);
    expect(world.ants.hp[defender]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_BASE);
  });
});

// =============================================================================
// S1 — 2v2 two-tile chamber frontage (spec validation target)
// =============================================================================

describe('V16 2v2 two-tile chamber frontage', () => {
  it('two adjacent tiles each resolve one independent pair; both defenders survive at hp=4', () => {
    // Spec: "two adjacent chamber/open tiles each contain one home defender and one invader.
    // Two active pairs resolve in parallel (one per tile). Both home defenders survive at HP 4;
    // both invaders die at T+20."
    const { world, cid1, cid2 } = makeV16World();

    // Tile A (5,7): defender from cid1 (home-ground) vs invader from cid2
    const defA = spawnFighter(world, cid1, 5, 7, Zone.Underground);
    const invA = spawnFighter(world, cid2, 5, 7, Zone.Underground);
    // Tile B (6,7): defender from cid1 (home-ground) vs invader from cid2
    const defB = spawnFighter(world, cid1, 6, 7, Zone.Underground);
    const invB = spawnFighter(world, cid2, 6, 7, Zone.Underground);

    // Place all four on cid1's grid (defenders are on home ground).
    const COLONY1 = 1;
    world.ants.currentGridColonyId[defA] = COLONY1;
    world.ants.currentGridColonyId[invA] = COLONY1;
    world.ants.currentGridColonyId[defB] = COLONY1;
    world.ants.currentGridColonyId[invB] = COLONY1;

    // Run 21 ticks: windup at T=1, strikes at T=6, T=11, T=16, T=21.
    runCombatTicks(world, 21);

    // Both invaders dead (defender deals 5 home-ground damage × 4 strikes = 20 total).
    expect(world.ants.alive[invA]).toBe(0);
    expect(world.ants.alive[invB]).toBe(0);
    // Both defenders alive (invader deals 4 damage × 4 strikes = 16; bonus absorbs first 4).
    expect(world.ants.alive[defA]).toBe(1);
    expect(world.ants.alive[defB]).toBe(1);
    // Each defender ends at hp=4 (took 16 total damage: 4 absorbed by bonus, 12 from hp=16).
    expect(world.ants.hp[defA]).toBe(4);
    expect(world.ants.hp[defB]).toBe(4);
    // Pairs are independent — each tile resolved its own fight.
    expect(world.colonies[cid1]!.killCount).toBe(2);
    expect(world.colonies[cid2]!.killCount).toBe(0);
  });
});


// =============================================================================
// Non-fighter and queen combat stats (S1 follow-up)
// =============================================================================

describe('non-fighter and queen combat stats (V16)', () => {
  it('fighter strikes on tick 1 against non-fighter; non-fighter winds up 5 ticks', () => {
    const { world, cid1, cid2 } = makeV16World();
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const worker  = spawnAnt(world, cid2, 5, 7, Zone.Surface);   // AntTask.Idle = non-fighter
    // Tick 1: fighter strikes immediately (no windup); worker starts winding up.
    runCombatTicks(world, 1);
    expect(world.ants.hp[worker]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_BASE); // fighter dealt 4
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE);                      // worker hasn't struck yet
    expect(world.ants.attackCooldown[worker]).toBe(COMBAT_COOLDOWN_TICKS - 1); // 5→4
    // Worker strikes at tick 1 + COMBAT_COOLDOWN_TICKS = 6.
    runCombatTicks(world, COMBAT_COOLDOWN_TICKS - 1); // ticks 2-5: worker cooldown → 0
    runCombatTicks(world, 1);                          // tick 6: worker strikes for COMBAT_DAMAGE_WORKER=1
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_WORKER);
  });

  it('non-fighter deals COMBAT_DAMAGE_WORKER damage per strike (not 0)', () => {
    const { world, cid1, cid2 } = makeV16World();
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const worker  = spawnAnt(world, cid2, 5, 7, Zone.Surface);
    // Run 1+5 = 6 ticks: worker winds up on tick 1, strikes on tick 6.
    runCombatTicks(world, 6);
    // Worker should have dealt COMBAT_DAMAGE_WORKER=1 damage (not 0).
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_WORKER);
  });

  it('queen deals COMBAT_DAMAGE_QUEEN damage per strike', () => {
    const { world, cid1, cid2 } = makeV16World();
    // Spawn a queen ant with full queen HP; designate it as cid2 queen.
    const queenAnt = allocateEntityId(world);
    initAnt(world.ants, queenAnt, {
      colonyId: Number(cid2),
      posX: (5 << FP_SHIFT) + (FP_ONE >> 1),
      posY: (7 << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Idle,
      hp: COMBAT_HP_QUEEN,
    });
    world.colonies[cid2]!.workers.push(queenAnt);
    world.colonies[cid2]!.workerCount += 1;
    world.colonies[cid2]!.queenEntityId = queenAnt;
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    // T=1: fighter strikes queen for COMBAT_DAMAGE_BASE=4 (no windup). Queen starts winding up.
    runCombatTicks(world, 1);
    expect(world.ants.hp[queenAnt]).toBe(COMBAT_HP_QUEEN - COMBAT_DAMAGE_BASE);
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE); // queen hasn't struck yet
    // T=6: queen strikes for COMBAT_DAMAGE_QUEEN=6. Fighter also strikes (second hit).
    runCombatTicks(world, COMBAT_COOLDOWN_TICKS);
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_QUEEN);
  });

  it('queen starts with COMBAT_HP_QUEEN HP when spawned via scenario', () => {
    // Verify that initAnt with hp:COMBAT_HP_QUEEN correctly initialises the queen's HP.
    // (Tested here via direct initAnt call to keep test fast and scenario-independent.)
    const { world, cid1 } = makeV16World();
    const queenSlot = allocateEntityId(world);
    const { FP_SHIFT: _shift } = { FP_SHIFT: 8 };
    initAnt(world.ants, queenSlot, {
      colonyId: Number(cid1), posX: 10 << 8, posY: 10 << 8,
      task: AntTask.Idle, hp: COMBAT_HP_QUEEN,
    });
    expect(world.ants.hp[queenSlot]).toBe(COMBAT_HP_QUEEN);
  });
});
