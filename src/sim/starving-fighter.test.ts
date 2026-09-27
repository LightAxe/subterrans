// starving-fighter.test.ts — #363 (V58): a STARVING fighter drops the fight to go eat.
//
// Up to V57 combat came first for a hungry fighter (D11): a duel, an enemy ant in
// sight, or its colony's spider order held it, and a fighter held in an on-and-off
// fight away from home starved there. From V58 a fighter away from home that is
// starving (FIGHTER_STARVING_TICKS since its last meal, empty-handed) walks home by
// the D11 walk-home anyway. Every case is pinned at V57 (unchanged) and V58.
//
// Driven through updateFightAntTargets (step 10c) and tick() on createScenario
// worlds, like fighter-hunger.test.ts, which pins the V51 walk-home itself.

import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import {
  allocateEntityId,
  LATEST_SIM_VERSION,
  SIM_VERSION_V57_ROUTED_TO_ENTRANCE,
  SIM_VERSION_V58_STARVING_FIGHTER_EATS,
  type WorldState,
} from './types.js';
import { initAnt } from './ant/ant-store.js';
import { fighterWalksHomeToEat, updateFightAntTargets } from './ant/ant-system.js';
import { antIsAtHome, fighterIsHungry, fighterIsStarving } from './hunger.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone, ugSet, UndergroundTileState } from './terrain.js';
import { FP_ONE, FP_SHIFT } from './fixed.js';
import { isSurfaceTileInComponent } from './surface-features.js';
import { setPoolFoodForTest } from './food/food-test-utils.js';
import {
  ENEMY_COLONY_ID,
  FIGHT_AGGRO_RADIUS,
  FIGHTER_MEAL_INTERVAL_TICKS,
  FIGHTER_STARVE_AFTER_TICKS,
  FIGHTER_STARVING_TICKS,
  FIGHTER_WALK_HOME_HUNGER_TICKS,
  HOME_EAT_RADIUS_TILES,
  PLAYER_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

const V57 = SIM_VERSION_V57_ROUTED_TO_ENTRANCE;
const V58 = SIM_VERSION_V58_STARVING_FIGHTER_EATS;
/** Hungry but not yet starving. */
const HUNGRY = FIGHTER_WALK_HOME_HUNGER_TICKS + 10;
/** Starving. */
const STARVING = FIGHTER_STARVING_TICKS + 10;
/** Enough HP that neither side of a test duel dies of it. */
const UNKILLABLE_HP = 1_000_000;

/** A quiet world (no spider, no AI operations) with a well-stocked player pool. */
function quietWorld(ver: number, keepSpider = false): WorldState {
  const world = createScenario(7, 'Normal');
  world.simVersion = ver;
  if (!keepSpider) world.spider = null;
  world.aiState = [];
  setPoolFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 2000);
  return world;
}

function playerEntrance(world: WorldState): { x: number; y: number } {
  const e = world.colonies[PLAYER_COLONY_ID]!.entrances.find((en) => en.isOpen)!;
  return { x: e.surfaceTileX, y: e.surfaceTileY };
}

/** A walkable surface tile `dist` tiles (Manhattan) from the player entrance, on
 *  the side away from the enemy nest. */
function distantTile(world: WorldState, dist: number): { x: number; y: number } {
  const ent = playerEntrance(world);
  for (let dy = 0; dy <= dist; dy++) {
    for (const sy of [1, -1]) {
      const x = ent.x - (dist - dy) < 0 ? ent.x + (dist - dy) : ent.x - (dist - dy);
      const y = ent.y + sy * dy;
      if (isSurfaceTileInComponent(world, x, y)) return { x, y };
    }
  }
  throw new Error('no walkable tile at that distance');
}

/** Add one player Fighting ant on the surface at (x, y), `sinceMeal` ticks after
 *  its last meal; ask the ratio for every fighter so no stand-down releases it. */
function addFighter(world: WorldState, x: number, y: number, sinceMeal: number): number {
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: PLAYER_COLONY_ID,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: FightingSubState.MovingToRally,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: Zone.Surface,
    lastMealTick: world.tick - sinceMeal,
  });
  colony.workers.push(id);
  colony.workerCount += 1;
  let fight = 0;
  let other = 0;
  for (const w of colony.workers) {
    if (world.ants.alive[w] !== 1) continue;
    if (world.ants.task[w] === AntTask.Fighting) fight += 1;
    else other += 1;
  }
  colony.targetRatio.forage = other;
  colony.targetRatio.fight = fight;
  return id;
}

/** Add one Idle enemy worker at (x, y) in `zone` (grid `grid` below ground). */
function addEnemy(world: WorldState, x: number, y: number, zone: Zone, grid = 0): number {
  const enemy = world.colonies[ENEMY_COLONY_ID]!;
  const eid = allocateEntityId(world);
  initAnt(world.ants, eid, {
    colonyId: ENEMY_COLONY_ID,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle,
    zone,
    lastMealTick: world.tick,
  });
  if (zone === Zone.Underground) world.ants.currentGridColonyId[eid] = grid;
  enemy.workers.push(eid);
  enemy.workerCount += 1;
  return eid;
}

/** A player fighter at a rally 40 tiles from home, `sinceMeal` after its last meal. */
function atDistantRally(ver: number, sinceMeal: number, keepSpider = false) {
  const world = quietWorld(ver, keepSpider);
  const rally = distantTile(world, 40);
  world.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: rally.x, tileY: rally.y };
  const id = addFighter(world, rally.x, rally.y, sinceMeal);
  return { world, id, rally };
}

function targetTile(world: WorldState, id: number): { x: number; y: number } {
  return { x: world.ants.targetPosX[id]! >> FP_SHIFT, y: world.ants.targetPosY[id]! >> FP_SHIFT };
}

describe('#363 — the starving threshold (V58)', () => {
  it('LATEST is V58 or later', () => {
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(V58);
  });

  it('is one meal interval short of the starve-after, and past the walk-home threshold', () => {
    expect(FIGHTER_STARVING_TICKS).toBe(FIGHTER_STARVE_AFTER_TICKS - FIGHTER_MEAL_INTERVAL_TICKS);
    expect(FIGHTER_STARVING_TICKS).toBeGreaterThan(FIGHTER_WALK_HOME_HUNGER_TICKS);
    expect(FIGHTER_STARVING_TICKS).toBeLessThan(FIGHTER_STARVE_AFTER_TICKS);
  });

  it('fighterIsStarving: from FIGHTER_STARVING_TICKS, empty-handed, V58 only', () => {
    const { world, id } = atDistantRally(V58, FIGHTER_STARVING_TICKS - 1);
    expect(fighterIsHungry(world, id)).toBe(true);
    expect(fighterIsStarving(world, id)).toBe(false);
    world.ants.lastMealTick[id] = world.tick - FIGHTER_STARVING_TICKS;
    expect(fighterIsStarving(world, id)).toBe(true);
    world.ants.foodCarrying[id] = 1; // it can eat from its load
    expect(fighterIsStarving(world, id)).toBe(false);
    world.ants.foodCarrying[id] = 0;
    world.simVersion = V57;
    expect(fighterIsStarving(world, id)).toBe(false);
  });

  it('a fighter in a duel turns for home exactly at FIGHTER_STARVING_TICKS', () => {
    const { world, id } = atDistantRally(V58, FIGHTER_STARVING_TICKS - 1);
    world.ants.combatOpponentId[id] = -2; // paired with the spider
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    world.ants.lastMealTick[id] = world.tick - FIGHTER_STARVING_TICKS;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(true);
    expect(targetTile(world, id)).toEqual(playerEntrance(world));
  });
});

describe('#363 — on the surface, a starving fighter drops the fight', () => {
  for (const [ver, walks] of [
    [V57, false],
    [V58, true],
  ] as const) {
    it(`in a duel (the spider's or an ant's): ${walks ? 'walks home' : 'stays'} at V${ver}`, () => {
      for (const opp of [-2, 0]) {
        const { world, id } = atDistantRally(ver, STARVING);
        world.ants.combatOpponentId[id] = opp;
        updateFightAntTargets(world);
        expect(fighterWalksHomeToEat(world, id)).toBe(walks);
      }
    });

    it(`with an enemy ant in sight: ${walks ? 'walks home' : 'chases it'} at V${ver}`, () => {
      const { world, id, rally } = atDistantRally(ver, STARVING);
      addEnemy(world, rally.x + 2, rally.y, Zone.Surface);
      updateFightAntTargets(world);
      expect(fighterWalksHomeToEat(world, id)).toBe(walks);
      expect(targetTile(world, id)).toEqual(
        walks ? playerEntrance(world) : { x: rally.x + 2, y: rally.y },
      );
    });

    it(`under its colony's spider order: ${walks ? 'walks home' : 'goes at the spider'} at V${ver} (full tick)`, () => {
      const { world, id, rally } = atDistantRally(ver, STARVING, true);
      expect(world.spider).not.toBeNull();
      // The spider well out of the fighter's sight, so only the order sends it there.
      const sp = distantTile(world, 20);
      world.spider!.posX = (sp.x << FP_SHIFT) + (FP_ONE >> 1);
      world.spider!.posY = (sp.y << FP_SHIFT) + (FP_ONE >> 1);
      expect(Math.abs(sp.x - rally.x) + Math.abs(sp.y - rally.y)).toBeGreaterThan(
        FIGHT_AGGRO_RADIUS,
      );
      world.spiderPriorityColonyId = PLAYER_COLONY_ID;
      tick(world, []);
      expect(world.spiderPriorityColonyId).toBe(PLAYER_COLONY_ID);
      expect(fighterWalksHomeToEat(world, id)).toBe(walks);
      // Step 10d (after 10c) leaves the walker's target on its entrance; otherwise
      // it aims at the spider's tile as 10d saw it (the spider moves later in the
      // tick, at most one tile).
      const tgt = targetTile(world, id);
      if (walks) {
        expect(tgt).toEqual(playerEntrance(world));
      } else {
        const spX = world.spider!.posX >> FP_SHIFT;
        const spY = world.spider!.posY >> FP_SHIFT;
        expect(Math.abs(tgt.x - spX) + Math.abs(tgt.y - spY)).toBeLessThanOrEqual(1);
      }
    });
  }

  it('a hungry fighter short of starving still fights first at V58', () => {
    const { world, id, rally } = atDistantRally(V58, HUNGRY);
    world.ants.combatOpponentId[id] = -2;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    world.ants.combatOpponentId[id] = -1;
    addEnemy(world, rally.x + 2, rally.y, Zone.Surface);
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
    expect(targetTile(world, id)).toEqual({ x: rally.x + 2, y: rally.y });
    world.spiderPriorityColonyId = PLAYER_COLONY_ID;
    world.ants.alive[world.colonies[ENEMY_COLONY_ID]!.workers.at(-1)!] = 0; // test-only removal
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });

  it('a starving fighter carrying food eats from its load and keeps fighting', () => {
    const { world, id } = atDistantRally(V58, STARVING);
    world.ants.foodCarrying[id] = 1;
    world.ants.combatOpponentId[id] = -2;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });

  it('at home, a starving fighter in a duel stays in it (it is where it eats)', () => {
    const world = quietWorld(V58);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const ent = playerEntrance(world);
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, ent.x + 3, ent.y, STARVING);
    expect(antIsAtHome(world, id)).toBe(true);
    world.ants.combatOpponentId[id] = -2;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });

  it('in a famine (home cannot feed it) it keeps fighting, and does not flip at the edge of home', () => {
    // Starving, one tile past home range, with an unkillable enemy standing just
    // inside it. Home could not feed it, so it neither walks home nor turns back
    // and forth across the home-range edge: it goes at the enemy, every tick.
    const world = quietWorld(V58);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const ent = playerEntrance(world);
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const out = distantTile(world, HOME_EAT_RADIUS_TILES + 1);
    const inside = distantTile(world, HOME_EAT_RADIUS_TILES - 1);
    const id = addFighter(world, out.x, out.y, STARVING);
    world.ants.hp[id] = UNKILLABLE_HP;
    const eid = addEnemy(world, inside.x, inside.y, Zone.Surface);
    world.ants.hp[eid] = UNKILLABLE_HP;
    world.ants.speed[eid] = 0;
    expect(antIsAtHome(world, id)).toBe(false);
    for (let t = 0; t < 30; t++) {
      setPoolFoodForTest(world, colony, 0); // hold the famine
      world.ants.lastMealTick[eid] = world.tick;
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      expect(fighterWalksHomeToEat(world, id)).toBe(false);
      expect(targetTile(world, id)).toEqual(inside);
    }
    expect(Math.abs(ent.x - inside.x) + Math.abs(ent.y - inside.y)).toBe(HOME_EAT_RADIUS_TILES - 1);
  });

  it('with no OPEN entrance of its own, it keeps to its ordinary routing', () => {
    const world = quietWorld(V58);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    const rally = distantTile(world, 40);
    colony.rallyPoint = { tileX: rally.x, tileY: rally.y };
    const id = addFighter(world, rally.x, rally.y, STARVING);
    for (const e of colony.entrances) e.isOpen = false; // test-only
    world.ants.combatOpponentId[id] = -2;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });

  it('held in an endless duel, it starves at V57 and walks home and eats at V58 (full ticks)', () => {
    for (const ver of [V57, V58]) {
      // Hungry, 100 ticks short of starving. An unkillable enemy worker is put back
      // on the fighter's tile every tick: a fight it never wins or walks away from
      // (combat first) until it starves.
      const { world, id } = atDistantRally(ver, FIGHTER_STARVING_TICKS - 100);
      world.ants.hp[id] = UNKILLABLE_HP;
      const eid = addEnemy(world, 0, 0, Zone.Surface);
      world.ants.hp[eid] = UNKILLABLE_HP;
      world.ants.speed[eid] = 0; // it stands where it is put
      const lastBefore = world.ants.lastMealTick[id]!;
      let dueled = 0;
      let walkedHome = 0;
      let ate = false;
      for (let t = 0; t < FIGHTER_STARVE_AFTER_TICKS && world.ants.alive[id] === 1 && !ate; t++) {
        world.ants.posX[eid] = world.ants.posX[id]!;
        world.ants.posY[eid] = world.ants.posY[id]!;
        world.ants.lastMealTick[eid] = world.tick;
        tick(world, []);
        if (fighterWalksHomeToEat(world, id)) walkedHome++;
        if (world.ants.combatOpponentId[id] === eid) dueled++;
        ate = world.ants.lastMealTick[id] !== lastBefore;
      }
      if (ver === V57) {
        expect(dueled).toBeGreaterThan(100);
        expect(walkedHome).toBe(0);
        expect(world.ants.alive[id]).toBe(0); // starved in the duel
        expect(ate).toBe(false);
      } else {
        expect(walkedHome).toBeGreaterThan(0); // it ate because it walked home
        expect(world.ants.alive[id]).toBe(1);
        expect(ate).toBe(true);
        expect(world.tick - lastBefore).toBeLessThan(FIGHTER_STARVE_AFTER_TICKS);
      }
    }
  }, 30_000);
});

describe('#363 — below ground in an enemy nest, a starving invader leaves from a fight', () => {
  /** A player fighter below ground in the ENEMY nest, at the foot of its open shaft. */
  function invader(ver: number, sinceMeal: number) {
    const world = quietWorld(ver);
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const ent = enemy.entrances.find((e) => e.isOpen)!;
    world.colonies[PLAYER_COLONY_ID]!.rallyPoint = {
      tileX: ent.surfaceTileX,
      tileY: ent.surfaceTileY,
    };
    const id = addFighter(world, ent.surfaceTileX, 1, sinceMeal);
    world.ants.zone[id] = Zone.Underground;
    world.ants.currentGridColonyId[id] = ENEMY_COLONY_ID;
    return { world, id, shaftX: ent.surfaceTileX };
  }

  for (const [ver, leaves] of [
    [V57, false],
    [V58, true],
  ] as const) {
    it(`in a duel: ${leaves ? 'leaves' : 'stays'} at V${ver}`, () => {
      const { world, id } = invader(ver, STARVING);
      world.ants.combatOpponentId[id] = 0;
      updateFightAntTargets(world);
      expect(fighterWalksHomeToEat(world, id)).toBe(leaves);
    });

    it(`with an enemy within FIGHT_AGGRO_RADIUS: ${leaves ? 'leaves' : 'stays'} at V${ver}`, () => {
      const { world, id, shaftX } = invader(ver, STARVING);
      const grid = world.undergroundGrids[ENEMY_COLONY_ID]!;
      for (let y = 0; y <= 2 + FIGHT_AGGRO_RADIUS; y++) {
        ugSet(grid, shaftX, y, UndergroundTileState.Open);
      }
      addEnemy(world, shaftX, 1 + FIGHT_AGGRO_RADIUS, Zone.Underground, ENEMY_COLONY_ID);
      updateFightAntTargets(world);
      expect(fighterWalksHomeToEat(world, id)).toBe(leaves);
    });
  }

  it('in a famine a starving invader stays in its duel at V58', () => {
    const { world, id } = invader(V58, STARVING);
    setPoolFoodForTest(world, world.colonies[PLAYER_COLONY_ID]!, 0);
    world.ants.combatOpponentId[id] = 0;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });

  it('climbing out into an enemy on the entrance, it walks home through it and does not drop back in', () => {
    const { world, id } = invader(V58, STARVING);
    world.ants.hp[id] = UNKILLABLE_HP;
    const enemy = world.colonies[ENEMY_COLONY_ID]!;
    const ent = enemy.entrances.find((e) => e.isOpen)!;
    // Clear the entrance tile, then stand one unkillable enemy worker on it.
    for (const w of enemy.workers) world.ants.alive[w] = 0; // test-only removal
    enemy.workers.length = 0;
    enemy.workerCount = 0;
    const far = distantTile(world, 60);
    world.ants.posX[enemy.queenEntityId] = (far.x << FP_SHIFT) + (FP_ONE >> 1);
    world.ants.posY[enemy.queenEntityId] = (far.y << FP_SHIFT) + (FP_ONE >> 1);
    const eid = addEnemy(world, ent.surfaceTileX, ent.surfaceTileY, Zone.Surface);
    world.ants.hp[eid] = UNKILLABLE_HP;
    world.ants.speed[eid] = 0;
    const lastBefore = world.ants.lastMealTick[id]!;
    let surfaced = false;
    let redescents = 0;
    let walkedHomeOnSurface = 0;
    let ate = false;
    for (let t = 0; t < FIGHTER_MEAL_INTERVAL_TICKS && !ate; t++) {
      world.ants.lastMealTick[eid] = world.tick;
      tick(world, []);
      expect(world.ants.alive[id]).toBe(1);
      if (world.ants.zone[id] === Zone.Surface) {
        surfaced = true;
        if (fighterWalksHomeToEat(world, id)) walkedHomeOnSurface++;
      } else if (surfaced) redescents++;
      ate = world.ants.lastMealTick[id] !== lastBefore;
    }
    expect(surfaced).toBe(true);
    expect(redescents).toBe(0);
    expect(walkedHomeOnSurface).toBeGreaterThan(0);
    expect(ate).toBe(true);
  });

  it('a hungry invader short of starving still stays in its duel at V58', () => {
    const { world, id } = invader(V58, HUNGRY);
    world.ants.combatOpponentId[id] = 0;
    updateFightAntTargets(world);
    expect(fighterWalksHomeToEat(world, id)).toBe(false);
  });
});
