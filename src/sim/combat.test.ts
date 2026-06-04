import { describe, it, expect } from 'vitest';
import { detectAndResolveCombat, killAnt } from './combat.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V22_DIFFICULTY,
  SIM_VERSION_V23_SPIDER_AGGRO,
} from './types.js';
import { Rng } from './rng.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SPIDER_HP_FULL,
  SPIDER_HUNT_INTERVAL_TICKS,
} from './constants.js';
import type { WorldState, SpiderState, SpiderBehaviorState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

// Helper: build a minimal 2-colony world with seeded rngState.
function makeWorldWith2Colonies(seed = 42): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const world = createWorldState(seed);
  // Place queens at distinct tiles far from worker spawn points (tile 5,7 is the combat tile in tests).
  // Queens at tile (0,0) and (1,0) so they never collide with each other or the test workers.
  const queen1 = allocateEntityId(world);
  initAnt(world.ants, queen1, {
    colonyId: 1,
    posX: 0 << FP_SHIFT,
    posY: 0 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  const colony1 = createColonyRecord(1 as ColonyId, queen1);
  colony1.entrances = [];
  colony1.rallyPoint = null;
  colony1.digFlowFieldDirty = false;
  world.colonies[1] = colony1;

  const queen2 = allocateEntityId(world);
  initAnt(world.ants, queen2, {
    colonyId: 2,
    posX: 1 << FP_SHIFT,
    posY: 0 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  const colony2 = createColonyRecord(2 as ColonyId, queen2);
  colony2.entrances = [];
  colony2.rallyPoint = null;
  colony2.digFlowFieldDirty = false;
  world.colonies[2] = colony2;

  return { world, cid1: 1 as ColonyId, cid2: 2 as ColonyId };
}

// Helper: spawn a worker ant of colonyId at (tileX, tileY, zone). Returns slot index.
function spawnAnt(
  world: WorldState,
  colonyId: ColonyId,
  tileX: number,
  tileY: number,
  zone: Zone,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    zone,
  });
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

// Helper: spawn a fighting ant (AntTask.Fighting) for V16 combat tests.
function spawnFighter(
  world: WorldState,
  colonyId: ColonyId,
  tileX: number,
  tileY: number,
  zone: Zone,
): number {
  const id = spawnAnt(world, colonyId, tileX, tileY, zone);
  world.ants.task[id] = AntTask.Fighting;
  return id;
}

// Helper: place a spider on tile (tileX, tileY) in the given behavior state.
function placeSpider(
  world: WorldState,
  tileX: number,
  tileY: number,
  state: SpiderBehaviorState,
): SpiderState {
  const spider: SpiderState = {
    state,
    posX: tileX << FP_SHIFT,
    posY: tileY << FP_SHIFT,
    lairTileX: tileX,
    lairTileY: tileY,
    territoryRadiusTiles: 24,
    hp: SPIDER_HP_FULL,
    attackCooldown: 0,
    hungerTicks: 0,
    nextHuntTick: SPIDER_HUNT_INTERVAL_TICKS,
    huntStartTick: 0,
    strikeStartTick: 0,
    feedingStartTick: 0,
    retreatStartTick: 0,
    rampageStartTick: 0,
    huntTargetTileX: -1,
    huntTargetTileY: -1,
    killsThisStrike: 0,
    rampageKillsThisRampage: 0,
    rampageTargetColonyId: -1,
    chaseTargetAntId: -1,
    chaseStartTick: 0,
    killedThisTick: 0,
    lastKillTileX: -1,
    lastKillTileY: -1,
    feedAwayTileX: -1,
    feedAwayTileY: -1,
    feedArrivedTick: -1,
  };
  world.spider = spider;
  return spider;
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
  it("#107 (V13+) clears carryingBroodId and the brood's carriedBy when a carrier is killed", () => {
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

  it("#107 (V13+) symmetric — when the carried entity is killed, carrier's carryingBroodId clears", () => {
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

// =============================================================================
// S1 — V16 HP/damage/cooldown combat tests
// =============================================================================

import {
  COMBAT_HP_BASE,
  COMBAT_COOLDOWN_TICKS,
  COMBAT_DAMAGE_BASE,
  COMBAT_DAMAGE_WORKER,
  COMBAT_DAMAGE_QUEEN,
  COMBAT_HP_QUEEN,
} from './constants.js';

function makeV16World(seed = 42): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const r = makeWorldWith2Colonies(seed);
  r.world.simVersion = 16;
  return r;
}

function makeV17World(seed = 42): { world: WorldState; cid1: ColonyId; cid2: ColonyId } {
  const r = makeWorldWith2Colonies(seed);
  r.world.simVersion = 17;
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
    world.ants.currentGridColonyId[defender] = Number(
      cid1,
    ) as unknown as (typeof world.ants.currentGridColonyId)[0];
    // Attacker (cid2) on cid1's grid (invasion)
    const attacker = spawnFighter(world, cid2, 5, 7, Zone.Underground);
    world.ants.currentGridColonyId[attacker] = Number(
      cid1,
    ) as unknown as (typeof world.ants.currentGridColonyId)[0];

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
    const b = spawnFighter(world, cid2, 5, 7, Zone.Surface);
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
    const b = spawnFighter(world, cid2, 5, 7, Zone.Surface);
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
    world.ants.currentGridColonyId[defender] = Number(
      cid1,
    ) as unknown as (typeof world.ants.currentGridColonyId)[0];
    const attacker = spawnFighter(world, cid2, 5, 7, Zone.Underground);
    world.ants.currentGridColonyId[attacker] = Number(
      cid1,
    ) as unknown as (typeof world.ants.currentGridColonyId)[0];
    // Fighters skip windup: first strike fires on tick 1.
    // Attacker deals COMBAT_DAMAGE_BASE=4; defender bonus=4 absorbs all → bonus=0, base HP intact.
    runCombatTicks(world, 1); // first strike T=1 (no windup for fighters)
    expect(world.ants.homeGroundBonusHp[defender]).toBe(0); // bonus fully depleted by first strike
    expect(world.ants.hp[defender]).toBe(COMBAT_HP_BASE); // base HP untouched
    // Second strike fires after COMBAT_COOLDOWN_TICKS=5 more ticks. Bonus=0 → base HP takes damage.
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

describe('non-fighter and queen combat stats (V17)', () => {
  it('fighter strikes on tick 1 against non-fighter; non-fighter winds up 5 ticks', () => {
    const { world, cid1, cid2 } = makeV17World();
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const worker = spawnAnt(world, cid2, 5, 7, Zone.Surface); // AntTask.Idle = non-fighter
    // Tick 1: fighter strikes immediately (no windup); worker starts winding up.
    runCombatTicks(world, 1);
    expect(world.ants.hp[worker]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_BASE); // fighter dealt 4
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE); // worker hasn't struck yet
    expect(world.ants.attackCooldown[worker]).toBe(COMBAT_COOLDOWN_TICKS); // 6→5
    // Worker strikes at tick 1 + COMBAT_COOLDOWN_TICKS = 6.
    runCombatTicks(world, COMBAT_COOLDOWN_TICKS - 1); // ticks 2-5: worker cooldown → 1
    runCombatTicks(world, 1); // tick 6: worker cooldown → 0, strikes
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_WORKER);
  });

  it('non-fighter deals COMBAT_DAMAGE_WORKER damage per strike (not 0)', () => {
    const { world, cid1, cid2 } = makeV17World();
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    spawnAnt(world, cid2, 5, 7, Zone.Surface);
    // V17: fighter skips windup (strikes tick 1); worker winds up 5 ticks, strikes tick 6.
    runCombatTicks(world, 6);
    // Worker should have dealt COMBAT_DAMAGE_WORKER=1 damage (not 0).
    expect(world.ants.hp[fighter]).toBe(COMBAT_HP_BASE - COMBAT_DAMAGE_WORKER);
  });

  it('queen deals COMBAT_DAMAGE_QUEEN damage per strike', () => {
    const { world, cid1, cid2 } = makeV17World();
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
    initAnt(world.ants, queenSlot, {
      colonyId: Number(cid1),
      posX: 10 << 8,
      posY: 10 << 8,
      task: AntTask.Idle,
      hp: COMBAT_HP_QUEEN,
    });
    expect(world.ants.hp[queenSlot]).toBe(COMBAT_HP_QUEEN);
  });
});

// ---------------------------------------------------------------------------
// V23 (#146/#147): widened spider-combat gate.
// Pre-V23 the spider only engages in Striking/Rampaging; V23 also engages in the
// other surface states (Patrolling/Hunting/Chasing) so auto-aggro fighters can
// damage it and the spider defends itself.
// ---------------------------------------------------------------------------

describe('spider combat gate (V23 #146/#147)', () => {
  // Pair a fighter with the spider and arm it to strike on the next resolve tick.
  function armFighterAgainstSpider(world: WorldState, fighterId: number): void {
    world.ants.combatOpponentId[fighterId] = -2; // already paired (skip windup)
    world.ants.attackCooldown[fighterId] = 1; // decrements to 0 → strikes this tick
  }

  it('Patrolling spider takes fighter damage under V23', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const spider = placeSpider(world, 5, 7, 'Patrolling');
    armFighterAgainstSpider(world, fighter);

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(spider.hp).toBe(SPIDER_HP_FULL - COMBAT_DAMAGE_BASE);
  });

  it('Chasing spider takes fighter damage under V23', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const spider = placeSpider(world, 5, 7, 'Chasing');
    spider.chaseTargetAntId = fighter;
    armFighterAgainstSpider(world, fighter);

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(spider.hp).toBe(SPIDER_HP_FULL - COMBAT_DAMAGE_BASE);
  });

  it('Patrolling spider takes NO damage under a pre-V23 (V22) world — old-replay guard', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V22_DIFFICULTY;
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const spider = placeSpider(world, 5, 7, 'Patrolling');
    armFighterAgainstSpider(world, fighter);

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(spider.hp).toBe(SPIDER_HP_FULL); // gate closed pre-V23
  });

  it('Striking spider still engages even under a pre-V23 world (unchanged behavior)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V22_DIFFICULTY;
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    const spider = placeSpider(world, 5, 7, 'Striking');
    armFighterAgainstSpider(world, fighter);

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(spider.hp).toBe(SPIDER_HP_FULL - COMBAT_DAMAGE_BASE);
  });
});

// ---------------------------------------------------------------------------
// V23 (Codex P1): off-tile spider-pairing sentinel cleanup.
// Under V23 the gate engages in unbounded surface states (Patrolling/Hunting/
// Chasing), where no state transition is guaranteed — so an ant that brushed the
// spider (combatOpponentId === -2) and then walked off its tile must have the
// sentinel cleared every tick by detectAndResolveCombat, not just by a spider
// state-exit. Otherwise the stale -2 would skip the next encounter's windup and
// bypass normal stale-opponent cleanup.
// ---------------------------------------------------------------------------

describe('spider-pairing sentinel cleanup (V23 Codex P1)', () => {
  it('clears -2 on an ant that disengaged from a Patrolling spider (off-tile)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    placeSpider(world, 5, 7, 'Patrolling');
    // Ant was paired last tick (-2) and has since moved off the spider's tile.
    const ant = spawnFighter(world, cid1, 9, 9, Zone.Surface);
    world.ants.combatOpponentId[ant] = -2;

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(world.ants.combatOpponentId[ant]).toBe(-1);
  });

  it('preserves -2 on an ant still on the spider tile (ongoing windup)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    placeSpider(world, 5, 7, 'Patrolling');
    const ant = spawnFighter(world, cid1, 5, 7, Zone.Surface);
    world.ants.combatOpponentId[ant] = -2;
    world.ants.attackCooldown[ant] = 5; // mid-windup

    detectAndResolveCombat(world, new Rng(world.rngState));

    // Still engaged on the tile → sentinel kept so resolveSpiderCombatOnTile
    // continues the cooldown rather than restarting the windup.
    expect(world.ants.combatOpponentId[ant]).toBe(-2);
  });

  it('clears -2 when the ant descends underground (off the surface tile)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    placeSpider(world, 5, 7, 'Patrolling');
    // Same tile coords but underground — the spider is surface-only, so this is
    // a disengage.
    const ant = spawnFighter(world, cid1, 5, 7, Zone.Underground);
    world.ants.combatOpponentId[ant] = -2;

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(world.ants.combatOpponentId[ant]).toBe(-1);
  });

  it('does NOT clear off-tile -2 under a pre-V23 (V22) world — old-replay guard', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V22_DIFFICULTY;
    placeSpider(world, 5, 7, 'Striking');
    const ant = spawnFighter(world, cid1, 9, 9, Zone.Surface);
    world.ants.combatOpponentId[ant] = -2;

    detectAndResolveCombat(world, new Rng(world.rngState));

    // V22 clears -2 only via clearSpiderPairingSentinels on episode exit, never
    // in this pass — byte-identical guard.
    expect(world.ants.combatOpponentId[ant]).toBe(-2);
  });
});

// ---------------------------------------------------------------------------
// V23 (Codex P2): sated meander = self-defense only.
// The widened gate engages spider combat in Patrolling, but the hunger-gated
// design says a sated (Patrolling) spider ignores workers and only bites ants
// attacking it. Predation happens in Chasing/Hunting/Striking/Rampaging, never
// during a plain meander — so a Patrolling spider must NOT initiate a bite on a
// worker merely sharing its tile, while predatory states still eat any ant.
// ---------------------------------------------------------------------------

describe('sated meander self-defense (V23 Codex P2)', () => {
  it('Patrolling spider ignores a lone worker on its tile (no pairing)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const spider = placeSpider(world, 5, 7, 'Patrolling');
    const worker = spawnAnt(world, cid1, 5, 7, Zone.Surface); // AntTask.Idle

    detectAndResolveCombat(world, new Rng(world.rngState));

    // Sated spider does not engage a worker: no pairing, no windup, no damage.
    expect(world.ants.combatOpponentId[worker]).toBe(-1);
    expect(world.ants.alive[worker]).toBe(1);
    expect(spider.attackCooldown).toBe(0);
  });

  it('Patrolling spider still bites back a fighter sharing its tile (self-defense)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    const spider = placeSpider(world, 5, 7, 'Patrolling');
    const fighter = spawnFighter(world, cid1, 5, 7, Zone.Surface);

    detectAndResolveCombat(world, new Rng(world.rngState));

    // First contact: fighter is paired (-2) and the spider arms its windup.
    expect(world.ants.combatOpponentId[fighter]).toBe(-2);
    expect(spider.attackCooldown).toBe(COMBAT_COOLDOWN_TICKS);
  });

  it('Hunting spider DOES engage a lone worker on its tile (predatory)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    placeSpider(world, 5, 7, 'Hunting');
    const worker = spawnAnt(world, cid1, 5, 7, Zone.Surface); // AntTask.Idle

    detectAndResolveCombat(world, new Rng(world.rngState));

    // Predatory state pairs even a worker (it will be eaten over the next ticks).
    expect(world.ants.combatOpponentId[worker]).toBe(-2);
  });

  it('Rampaging spider DOES engage a lone worker on its tile (predatory)', () => {
    const { world, cid1 } = makeWorldWith2Colonies();
    world.simVersion = SIM_VERSION_V23_SPIDER_AGGRO;
    placeSpider(world, 5, 7, 'Rampaging');
    const worker = spawnAnt(world, cid1, 5, 7, Zone.Surface); // AntTask.Idle

    detectAndResolveCombat(world, new Rng(world.rngState));

    expect(world.ants.combatOpponentId[worker]).toBe(-2);
  });
});
