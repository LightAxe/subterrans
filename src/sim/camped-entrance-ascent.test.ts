// #392 (V74) — no civilian climbs out onto the spider's blockade.
//
// While the spider camps an entrance (a Rampaging spider standing on the entrance
// tile: the #165 blockade, ant-motion.ts isSpiderBlockade) no ant goes down past it
// (isDescentBlocked). Up to V73 nothing stopped an ant coming UP onto it: a forager
// climbing its shaft landed on the spider, could not go back down, and was bitten or
// chased down. From V74 the hold at the shaft (idle-reserve.ts
// holdCivilianAtShaft) keeps a civilian (an adult Idle or Foraging ant in its
// own nest) below as a shelterer instead; it leaves by the ordinary poke-out once the
// DangerTrail over its exit has decayed. Fighters still climb out onto the camper.
// V74 also cuts the camp leash (SPIDER_RAMPAGE_MAX_TICKS) from 1200 to 300 ticks, so a
// camp nothing comes up at ends after 15 s.
import { afterAll, describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId, copyWorldState } from './types.js';
import type { SpiderBehaviorState, WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { killAnt } from './ant-death.js';
import { addChamberForTest } from './food/food-test-utils.js';
import { holdCivilianAtShaft } from './ant/idle-reserve.js';
import { isDescentBlocked, isSpiderBlockade } from './ant/ant-motion.js';
import { rampageThreatens } from './ant/ant-system.js';
import { resolveSpiderCombatOnTile } from './combat.js';
// eslint-disable-next-line no-restricted-imports -- the save-mid-hold proof round-trips the world through the platform serializer (telemetry.test.ts:13 pattern)
import { serializeWorldState, deserializeWorldState } from '../platform/save.js';
import { AntTask, ChamberType, ForagingSubState, FightingSubState } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SHELTER_COOLDOWN_TICKS,
  SPIDER_CHASE_TRIGGER_RADIUS,
  SPIDER_GRACE_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  SPIDER_RAMPAGE_MAX_TICKS,
  FOOD_PICKUP_AMOUNT,
  RAMPAGE_THREAT_RADIUS_TILES,
  SPIDER_EDGE_MARGIN_TILES,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from './constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
/** Seed 7: the player's entrance (rampage-shelter.test.ts pins it) and the spider's lair. */
const DOOR = { x: 24, y: 64 } as const;
const LAIR = { x: 67, y: 117 } as const;
/** Row of the nest's tunnel (the shaft runs down to it). */
const TUNNEL_Y = 3;
/** Past the start-of-match grace, so a hungry spider hunts. */
const T0 = SPIDER_GRACE_TICKS + 500;
/** Hungry on Normal. */
const HUNGRY = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);
const tileX = (w: WorldState, id: number): number => w.ants.posX[id]! >> FP_SHIFT;
const tileY = (w: WorldState, id: number): number => w.ants.posY[id]! >> FP_SHIFT;

/** Dig a shaft under `colonyId`'s entrance at column `x` down to TUNNEL_Y, and a tunnel
 *  along TUNNEL_Y from x - 4 to x + 12. */
function digNest(world: WorldState, colonyId: number, x: number): void {
  const grid = world.undergroundGrids[colonyId]!;
  for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, x, y, UndergroundTileState.Open);
  for (let tx = x - 4; tx <= x + 12; tx++) ugSet(grid, tx, TUNNEL_Y, UndergroundTileState.Open);
  world.colonies[colonyId]!.digFlowFieldDirty = true;
}

/**
 * A quiet seed-7 world at tick `at`: no AI, no starting workers, a 0:0 ratio, both
 * nests with a shaft under their open entrance and a tunnel along TUNNEL_Y. The
 * spider is at its lair, sated, with no density hunt due.
 */
function quiet(at = T0): WorldState {
  const world = createScenario(7, 'Normal');
  world.aiState = [];
  for (const cid of [P, E]) {
    const colony = world.colonies[cid]!;
    for (const id of [...colony.workers]) killAnt(world, id, null, null, 'Spider');
    colony.targetRatio = { forage: 0, fight: 0 };
  }
  world.tick = at;
  digNest(world, P, DOOR.x);
  const ed = world.colonies[E]!.entrances[0]!;
  digNest(world, E, ed.surfaceTileX);
  const sp = world.spider!;
  sp.state = 'Patrolling';
  sp.posX = center(LAIR.x);
  sp.posY = center(LAIR.y);
  sp.hungerTicks = 0;
  sp.nextHuntTick = at + 100_000; // no density hunt in these runs
  return world;
}

/** Put the spider on (x, y) as `state` (Rampaging: camping `target`'s door), hungry
 *  unless `fed`, its camp started `age` ticks ago. */
function camp(
  world: WorldState,
  x: number,
  y: number,
  opts: { target?: number; fed?: boolean; age?: number; state?: SpiderBehaviorState } = {},
): void {
  const sp = world.spider!;
  sp.state = opts.state ?? 'Rampaging';
  sp.posX = center(x);
  sp.posY = center(y);
  sp.hungerTicks = opts.fed === true ? 0 : HUNGRY;
  sp.rampageTargetColonyId = sp.state === 'Rampaging' ? (opts.target ?? P) : -1;
  sp.rampageEntranceId = -1;
  sp.rampageStartTick = world.tick - (opts.age ?? 0);
  sp.rampageKillsThisRampage = 0;
  sp.chaseTargetAntId = -1;
  sp.chaseStartTick = world.tick;
  sp.huntStartTick = world.tick;
  sp.strikeStartTick = world.tick;
  sp.feedAwayTileX = x;
  sp.feedAwayTileY = y;
  sp.feedArrivedTick = world.tick;
}

function spawn(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number,
  task: number = AntTask.Idle,
  subTask = 0,
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: center(x),
    posY: center(y),
    task: task as AntTask,
    subTask,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    lastMealTick: world.tick,
    zone: zone as Zone,
  });
  world.ants.currentGridColonyId[id] = colonyId;
  const colony = world.colonies[colonyId]!;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

const searcherBelow = (world: WorldState, colonyId: number, x: number, y: number): number =>
  spawn(world, colonyId, x, y, Zone.Underground, AntTask.Foraging, ForagingSubState.SearchingFood);

const carrierAt = (world: WorldState, x: number, y: number, zone: number): number => {
  const id = spawn(world, P, x, y, zone, AntTask.Foraging, ForagingSubState.CarryingFood);
  world.ants.foodCarrying[id] = FOOD_PICKUP_AMOUNT;
  return id;
};

const spiderOn = (world: WorldState, x: number, y: number): boolean =>
  world.spider !== null &&
  world.spider.posX >> FP_SHIFT === x &&
  world.spider.posY >> FP_SHIFT === y;

/** Manhattan tiles from the spider to (x, y). */
const spiderDist = (world: WorldState, x: number, y: number): number =>
  Math.abs((world.spider!.posX >> FP_SHIFT) - x) + Math.abs((world.spider!.posY >> FP_SHIFT) - y);

describe('fixtures', () => {
  it('seed 7: the player door is where the tests put it, and the enemy door is out of threat range', () => {
    const world = quiet();
    const ent = world.colonies[P]!.entrances[0]!;
    expect({ x: ent.surfaceTileX, y: ent.surfaceTileY, open: ent.isOpen }).toEqual({
      ...DOOR,
      open: true,
    });
    const ed = world.colonies[E]!.entrances[0]!;
    expect(ed.isOpen).toBe(true);
    expect(Math.abs(ed.surfaceTileX - DOOR.x) + Math.abs(ed.surfaceTileY - DOOR.y)).toBeGreaterThan(
      RAMPAGE_THREAT_RADIUS_TILES,
    );
  });
});

describe('isSpiderBlockade — the #165 footprint, shared by both shaft gates', () => {
  const STATES: SpiderBehaviorState[] = [
    'Patrolling',
    'Hunting',
    'Chasing',
    'Striking',
    'Feeding',
    'Rampaging',
    'Retreating',
  ];
  it('is a Rampaging spider on exactly that tile, hungry or fed, and nothing else', () => {
    const world = quiet();
    const colony = world.colonies[P]!;
    for (const state of STATES) {
      for (const fed of [false, true]) {
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
        ] as const) {
          camp(world, DOOR.x + dx, DOOR.y + dy, { state, fed });
          const want = state === 'Rampaging' && dx === 0 && dy === 0;
          const label = `${state} fed=${fed} ${dx},${dy}`;
          expect(isSpiderBlockade(world, DOOR.x, DOOR.y), label).toBe(want);
          // The descent gate reads the same predicate (its #164 arm needs a foreign
          // fighter, so an own forager sees only the blockade).
          expect(
            isDescentBlocked(world, AntTask.Foraging, true, colony, DOOR.x, DOOR.y),
            label,
          ).toBe(want);
        }
      }
    }
    world.spider = null;
    expect(isSpiderBlockade(world, DOOR.x, DOOR.y)).toBe(false);
  });
});

describe('isSpiderBlockade and the bite', () => {
  const LO = SPIDER_EDGE_MARGIN_TILES;
  const HI_X = SURFACE_GRID_WIDTH - 1 - LO;
  const HI_Y = SURFACE_GRID_HEIGHT - 1 - LO;

  /** Is a lone worker on (tx, ty) paired by the Rampaging spider (combat.ts)? */
  function bitten(world: WorldState, id: number, tx: number, ty: number): boolean {
    world.ants.posX[id] = center(tx);
    world.ants.posY[id] = center(ty);
    world.ants.combatOpponentId[id] = -1;
    world.ants.attackCooldown[id] = 0;
    world.spider!.attackCooldown = 0;
    resolveSpiderCombatOnTile(world);
    return world.ants.combatOpponentId[id] === -2;
  }

  it('off the edge band, the blockade is exactly the tile a camping spider bites', () => {
    const world = quiet();
    // One worker on the surface, alone (quiet() leaves no other workers; queens are
    // never bitten).
    const id = spawn(
      world,
      P,
      0,
      0,
      Zone.Surface,
      AntTask.Foraging,
      ForagingSubState.SearchingFood,
    );
    const failures: string[] = [];
    let blockades = 0;
    for (const sx of [LO + 1, 60, HI_X - 1]) {
      for (const sy of [LO + 1, 64, HI_Y - 1]) {
        camp(world, sx, sy);
        for (let dx = -4; dx <= 4; dx++) {
          for (let dy = -4; dy <= 4; dy++) {
            const b = bitten(world, id, sx + dx, sy + dy);
            const blockade = isSpiderBlockade(world, sx + dx, sy + dy);
            if (b !== blockade)
              failures.push(`spider ${sx},${sy} +${dx},${dy}: bite ${b}, blockade ${blockade}`);
            if (blockade) blockades += 1;
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(blockades).toBe(9);
  });

  it('known gap (as at V73): a door in the edge band, camped from the boundary tile, is no blockade though it is bitten', () => {
    // The spider is clamped LO tiles in from each edge (V26) and, Rampaging, bites the
    // band beyond its boundary tile (combat's fold); the #165 blockade is the exact
    // tile, so a band door is not one (isSpiderBlockade's doc; a follow-up).
    const world = quiet();
    const id = spawn(
      world,
      P,
      0,
      0,
      Zone.Surface,
      AntTask.Foraging,
      ForagingSubState.SearchingFood,
    );
    for (const [door, spiderAt] of [
      [
        { x: 1, y: DOOR.y },
        { x: LO, y: DOOR.y },
      ],
      [
        { x: SURFACE_GRID_WIDTH - 2, y: DOOR.y },
        { x: HI_X, y: DOOR.y },
      ],
      [
        { x: DOOR.x, y: 1 },
        { x: DOOR.x, y: LO },
      ],
    ] as const) {
      camp(world, spiderAt.x, spiderAt.y);
      expect(isSpiderBlockade(world, door.x, door.y)).toBe(false);
      expect(bitten(world, id, door.x, door.y)).toBe(true);
    }
  });
});

describe('#392 (V74) — a civilian does not climb out onto the spider blockade', () => {
  it('the #392 case: a searching forager coming up under a camp shelters at the shaft top and outlives the camp', () => {
    const world = quiet();
    camp(world, DOOR.x, DOOR.y);
    const id = searcherBelow(world, P, DOOR.x + 2, TUNNEL_Y);
    const hp0 = world.ants.hp[id]!;
    let heldAt = -1;
    // The camp's leash is SPIDER_RAMPAGE_MAX_TICKS (300 from V74), so
    // the run stops just short of it.
    for (let t = 0; t < SPIDER_RAMPAGE_MAX_TICKS - 5; t++) {
      tick(world, []);
      // The camp is still on: the forager meets the blockade the whole run.
      expect(world.spider!.state).toBe('Rampaging');
      expect(spiderOn(world, DOOR.x, DOOR.y)).toBe(true);
      expect(world.ants.alive[id], `tick ${world.tick}`).toBe(1);
      // V73 climbed out here, onto the spider, 7 ticks in, and was chased down and
      // eaten about 75 ticks later.
      expect(world.ants.zone[id], `tick ${world.tick}`).toBe(Zone.Underground);
      if (heldAt < 0 && tileY(world, id) === 0) heldAt = world.tick;
    }
    expect(heldAt).toBeGreaterThan(0);
    expect([tileX(world, id), tileY(world, id)]).toEqual([DOOR.x, 0]);
    expect(world.ants.task[id]).toBe(AntTask.Foraging);
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThanOrEqual(world.tick);
    expect(world.ants.hp[id]).toBeGreaterThanOrEqual(hp0);
  });

  it('the hold is the shaft shelter: its timer is armed the tick it would have climbed out', () => {
    const world = quiet();
    camp(world, DOOR.x, DOOR.y);
    const id = searcherBelow(world, P, DOOR.x, 0);
    const at = world.tick;
    tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
    expect([tileX(world, id), tileY(world, id)]).toEqual([DOOR.x, 0]);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(at + SHELTER_COOLDOWN_TICKS);
  });

  it('climbs out after the camp times out: once the spider has gone, not the tick it times out', () => {
    const world = quiet();
    camp(world, DOOR.x, DOOR.y, { age: SPIDER_RAMPAGE_MAX_TICKS - 60 }); // 60 ticks left
    const id = searcherBelow(world, P, DOOR.x, 0);
    let campEnded = -1;
    let surfacedAt = -1;
    let spiderGap = -1;
    for (let t = 0; t < 800 && surfacedAt < 0; t++) {
      tick(world, []);
      if (campEnded < 0 && !isSpiderBlockade(world, DOOR.x, DOOR.y)) campEnded = world.tick;
      if (world.ants.zone[id] === Zone.Surface) {
        surfacedAt = world.tick;
        spiderGap = spiderDist(world, DOOR.x, DOOR.y);
      }
    }
    expect(campEnded).toBeGreaterThan(0);
    expect(surfacedAt).toBeGreaterThan(campEnded);
    // Not stuck: out within the DangerTrail's decay plus one shelter cooldown.
    expect(surfacedAt - campEnded).toBeLessThan(400);
    // The poke-out waited for the spider to leave: it is well out of chase range.
    expect(spiderGap).toBeGreaterThan(SPIDER_CHASE_TRIGGER_RADIUS);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    for (let t = 0; t < 100; t++) tick(world, []);
    expect(world.ants.alive[id]).toBe(1);
  });

  it('climbs out after the spider eats elsewhere and leaves', () => {
    const world = quiet();
    camp(world, DOOR.x, DOOR.y);
    const id = searcherBelow(world, P, DOOR.x, 0);
    for (let t = 0; t < 30; t++) tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(0);
    // The spider has eaten and gone off to feed at its lair.
    const sp = world.spider!;
    sp.state = 'Feeding';
    sp.hungerTicks = 0;
    sp.posX = center(LAIR.x);
    sp.posY = center(LAIR.y);
    sp.feedAwayTileX = LAIR.x;
    sp.feedAwayTileY = LAIR.y;
    sp.feedArrivedTick = world.tick;
    sp.rampageTargetColonyId = -1;
    const from = world.tick;
    let surfacedAt = -1;
    for (let t = 0; t < 400 && surfacedAt < 0; t++) {
      tick(world, []);
      if (world.ants.zone[id] === Zone.Surface) surfacedAt = world.tick;
    }
    expect(surfacedAt).toBeGreaterThan(from);
    expect(surfacedAt - from).toBeLessThan(300);
  });

  it('a fighter still climbs out onto the camper, and fights it', () => {
    const world = quiet();
    const colony = world.colonies[P]!;
    colony.targetRatio = { forage: 0, fight: 10 };
    colony.rallyPoint = { tileX: DOOR.x + 20, tileY: DOOR.y }; // orders: not a sentry
    camp(world, DOOR.x, DOOR.y);
    const id = spawn(
      world,
      P,
      DOOR.x,
      0,
      Zone.Underground,
      AntTask.Fighting,
      FightingSubState.Holding,
    );
    tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect([tileX(world, id), tileY(world, id)]).toEqual([DOOR.x, DOOR.y]);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    // On the spider's tile it is the spider's opponent (the -2 pairing).
    expect(world.ants.combatOpponentId[id]).toBe(-2);
  });

  it('an idle worker is held at a blockade the rampage does not threaten (a camper that has eaten)', () => {
    const world = quiet();
    // Rampaging but fed: a kill with a fighter adjacent resets its hunger and keeps it
    // camping, so it is not on a rampage and the V68 threat does not hold the worker.
    camp(world, DOOR.x, DOOR.y, { fed: true });
    expect(rampageThreatens(world, world.colonies[P]!)).toBe(false);
    const id = spawn(world, P, DOOR.x, 0, Zone.Underground);
    tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Underground);
    expect(world.ants.fleeShelterUntilTick[id]).toBeGreaterThan(0);
  });

  it('not a blockade, not held: the spider beside the door, or on it but not camping', () => {
    const cases: [string, number, number, SpiderBehaviorState][] = [
      ['camping one tile east of the door', DOOR.x + 1, DOOR.y, 'Rampaging'],
      ['camping one tile south of the door', DOOR.x, DOOR.y + 1, 'Rampaging'],
      ['chasing across the door', DOOR.x, DOOR.y, 'Chasing'],
      ['patrolling hungry on the door', DOOR.x, DOOR.y, 'Patrolling'],
      ['hunting on the door', DOOR.x, DOOR.y, 'Hunting'],
    ];
    for (const [label, x, y, state] of cases) {
      const world = quiet();
      camp(world, x, y, { state });
      const id = searcherBelow(world, P, DOOR.x, 0);
      tick(world, []);
      expect(world.ants.zone[id], label).toBe(Zone.Surface);
      expect(world.ants.fleeShelterUntilTick[id], label).toBe(-1);
    }
  });

  it('two doors: a camp on one holds only the ant climbing out at it', () => {
    const world = quiet();
    // A second entrance B 12 tiles east of the door, its shaft joined to the tunnel.
    const bx = DOOR.x + 12;
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, bx, y, UndergroundTileState.Open);
    world.colonies[P]!.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: bx,
      surfaceTileY: DOOR.y,
      isOpen: true,
    });
    camp(world, DOOR.x, DOOR.y);
    const atCamped = searcherBelow(world, P, DOOR.x, 0);
    const atB = searcherBelow(world, P, bx, 0);
    tick(world, []);
    expect(world.ants.zone[atCamped]).toBe(Zone.Underground);
    expect(world.ants.fleeShelterUntilTick[atCamped]).toBeGreaterThan(0);
    expect(world.ants.zone[atB]).toBe(Zone.Surface);
    expect([tileX(world, atB), tileY(world, atB)]).toEqual([bx, DOOR.y]);
    expect(world.ants.fleeShelterUntilTick[atB]).toBe(-1);
  });

  it('CLNY-08: the enemy colony’s forager is held under a camp on its own door, and the player’s is not', () => {
    const world = quiet();
    const ed = world.colonies[E]!.entrances[0]!;
    camp(world, ed.surfaceTileX, ed.surfaceTileY, { target: E });
    const enemy = searcherBelow(world, E, ed.surfaceTileX, 0);
    const player = searcherBelow(world, P, DOOR.x, 0);
    tick(world, []);
    expect(world.ants.zone[enemy]).toBe(Zone.Underground);
    expect(world.ants.fleeShelterUntilTick[enemy]).toBeGreaterThan(0);
    expect(world.ants.zone[player]).toBe(Zone.Surface);
  });

  it('no deadlock: the held stack never blocks the shaft, and every ant gets where it was going once the camp ends', () => {
    const world = quiet();
    const colony = world.colonies[P]!;
    // A FoodStorage chamber off the tunnel's west end, so a carrier coming down walks
    // past the shaft top to bank.
    const grid = world.undergroundGrids[P]!;
    for (let y = 2; y <= 4; y++) {
      for (let x = DOOR.x - 7; x <= DOOR.x - 5; x++) ugSet(grid, x, y, UndergroundTileState.Open);
    }
    addChamberForTest(world, colony, {
      chamberId: allocateEntityId(world),
      chamberType: ChamberType.FoodStorage,
      posX: (DOOR.x - 7) << FP_SHIFT,
      posY: 2 << FP_SHIFT,
      width: 3,
      height: 3,
    });
    colony.foodFlowFieldDirty = true;
    colony.digFlowFieldDirty = true;
    camp(world, DOOR.x, DOOR.y);
    // Four searchers coming up the tunnel and one already at the top, an idle worker at
    // the top (the V68 shelter holds it), a carrier that has just come down, and two
    // carriers out on the surface walking home.
    const climbers = [
      searcherBelow(world, P, DOOR.x, 0),
      searcherBelow(world, P, DOOR.x + 1, TUNNEL_Y),
      searcherBelow(world, P, DOOR.x + 2, TUNNEL_Y),
      searcherBelow(world, P, DOOR.x + 3, TUNNEL_Y),
      searcherBelow(world, P, DOOR.x + 4, TUNNEL_Y),
      spawn(world, P, DOOR.x, 0, Zone.Underground),
    ];
    const down = carrierAt(world, DOOR.x, 0, Zone.Underground);
    const outside = [
      carrierAt(world, DOOR.x, DOOR.y + 8, Zone.Surface),
      carrierAt(world, DOOR.x + 1, DOOR.y + 8, Zone.Surface),
    ];
    const all = [...climbers, down, ...outside];
    const surfaced = new Map<number, number>();
    const banked = new Map<number, number>();
    const watch = (blockade: boolean): void => {
      for (const id of all) expect(world.ants.alive[id], `ant ${id} tick ${world.tick}`).toBe(1);
      for (const id of climbers) {
        if (world.ants.zone[id] === Zone.Surface && !surfaced.has(id)) {
          surfaced.set(id, world.tick);
          expect(blockade, `ant ${id} came up onto the camp at tick ${world.tick}`).toBe(false);
        }
        // A held climber waits on the shaft-top tile itself; nothing shifts it off.
        if (world.ants.zone[id] === Zone.Underground && world.ants.fleeShelterUntilTick[id]! > 0) {
          expect([tileX(world, id), tileY(world, id)]).toEqual([DOOR.x, 0]);
        }
      }
      for (const id of [down, ...outside]) {
        if (!banked.has(id) && world.ants.foodCarrying[id] === 0) banked.set(id, world.tick);
      }
    };

    // The camp: 300 ticks with the camper held on the door as it is (the audit's pin),
    // so it neither chases the carriers walking home nor times out.
    const pin = { ...world.spider! };
    for (let t = 0; t < 300; t++) {
      tick(world, []);
      Object.assign(world.spider!, pin);
      watch(true);
    }
    expect(surfaced.size).toBe(0);
    // Every climber is up at the shaft top, sheltering.
    for (const id of climbers) {
      expect([tileX(world, id), tileY(world, id)], `ant ${id}`).toEqual([DOOR.x, 0]);
      expect(world.ants.fleeShelterUntilTick[id], `ant ${id}`).toBeGreaterThan(0);
    }
    // The carrier that came down walked on past the held stack and banked.
    expect(banked.has(down)).toBe(true);
    // The carriers outside waited out of the door (they cannot go down past the camp).
    for (const id of outside) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(banked.has(id)).toBe(false);
    }

    // The camp ends: the spider eats elsewhere and goes off to feed at its lair.
    const sp = world.spider!;
    sp.state = 'Feeding';
    sp.hungerTicks = 0;
    sp.posX = center(LAIR.x);
    sp.posY = center(LAIR.y);
    sp.feedAwayTileX = LAIR.x;
    sp.feedAwayTileY = LAIR.y;
    sp.feedArrivedTick = world.tick;
    sp.rampageTargetColonyId = -1;
    const ended = world.tick;
    for (let t = 0; t < 800; t++) {
      tick(world, []);
      watch(false);
      if (surfaced.size === climbers.length && banked.size === all.length - climbers.length) break;
    }
    // Every climber came out (the idle worker too, the spider no longer threatening),
    // and both carriers outside got home down the shaft through the climbers and
    // banked: nothing waits on anything forever.
    expect(surfaced.size).toBe(climbers.length);
    for (const id of outside) expect(banked.get(id), `ant ${id}`).toBeGreaterThan(ended);
    expect(world.tick - ended).toBeLessThan(600);
  });

  it('determinism: a save mid-hold loads and continues exactly as the live world', () => {
    const world = quiet();
    camp(world, DOOR.x, DOOR.y, { age: SPIDER_RAMPAGE_MAX_TICKS - 120 });
    const ids = [searcherBelow(world, P, DOOR.x, 0), searcherBelow(world, P, DOOR.x + 3, TUNNEL_Y)];
    for (let t = 0; t < 40; t++) tick(world, []);
    expect(world.ants.fleeShelterUntilTick[ids[0]!]).toBeGreaterThan(0);
    const loaded = deserializeWorldState(serializeWorldState(world));
    for (let t = 0; t < 400; t++) {
      tick(world, []);
      tick(loaded, []);
    }
    expect(JSON.stringify(serializeWorldState(loaded))).toBe(
      JSON.stringify(serializeWorldState(world)),
    );
    // The run did go through the end of the camp: both are out.
    for (const id of ids) expect(world.ants.zone[id]).toBe(Zone.Surface);
  });
});

// ---------------------------------------------------------------------------
// State-space audit: every input to the hold at the shaft.
//
// holdCivilianAtShaft reads the ant's grid (own or foreign), task, speed (adult
// or brood), colony, the colony alarm, the V68 rampage threat (spider state, hunger,
// the grace window, camp target, distance) and, from V74, the spider blockade on the
// entrance tile it would climb out at (spider state and tile). The direct audit calls
// it over the whole product against an independent oracle; the second runs one tick()
// per (ascender × spider × alarm) case from the shaft top and checks who climbed out.
// ---------------------------------------------------------------------------

/** A spider configuration, labelled by hand: does it threaten the player's colony
 *  (V68), and is it a blockade on the player's door (#165)? */
interface SpiderCase {
  label: string;
  setup: (w: WorldState) => void;
  grace?: boolean;
  threat: boolean;
  blockade: boolean;
}
const SPIDER_CASES: SpiderCase[] = [
  { label: 'none', setup: (w) => (w.spider = null), threat: false, blockade: false },
  { label: 'camp, hungry', setup: (w) => camp(w, DOOR.x, DOOR.y), threat: true, blockade: true },
  {
    label: 'camp, fed',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { fed: true }),
    threat: false,
    blockade: true,
  },
  {
    label: 'camp, in the grace window',
    setup: (w) => camp(w, DOOR.x, DOOR.y),
    grace: true,
    threat: false,
    blockade: true,
  },
  {
    label: 'on the door, bound for the enemy door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { target: E }),
    threat: true,
    blockade: true,
  },
  {
    label: 'camping one east',
    setup: (w) => camp(w, DOOR.x + 1, DOOR.y),
    threat: true,
    blockade: false,
  },
  {
    label: 'camping one south',
    setup: (w) => camp(w, DOOR.x, DOOR.y + 1),
    threat: true,
    blockade: false,
  },
  {
    label: 'camping the enemy door',
    setup: (w) => {
      const ed = w.colonies[E]!.entrances[0]!;
      camp(w, ed.surfaceTileX, ed.surfaceTileY, { target: E });
    },
    threat: false,
    blockade: false,
  },
  {
    label: 'chasing on the door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { state: 'Chasing' }),
    threat: true,
    blockade: false,
  },
  {
    label: 'hungry patrol on the door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { state: 'Patrolling' }),
    threat: true,
    blockade: false,
  },
  {
    label: 'sated patrol on the door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { state: 'Patrolling', fed: true }),
    threat: false,
    blockade: false,
  },
  {
    label: 'hunting on the door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { state: 'Hunting' }),
    threat: true,
    blockade: false,
  },
  {
    label: 'striking on the door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { state: 'Striking' }),
    threat: true,
    blockade: false,
  },
  {
    label: 'feeding on the door',
    setup: (w) => camp(w, DOOR.x, DOOR.y, { state: 'Feeding', fed: true }),
    threat: false,
    blockade: false,
  },
];

/** A pristine quiet() world per start tick, copied into one reused world per case
 *  (copyWorldState leaves the copy exactly like a fresh one, #340). */
const templates = new Map<number, WorldState>();
let scratchWorld: WorldState | null = null;
function freshQuiet(at: number): WorldState {
  let tpl = templates.get(at);
  if (tpl === undefined) {
    tpl = quiet(at);
    templates.set(at, tpl);
  }
  scratchWorld ??= createScenario(7, 'Normal');
  copyWorldState(tpl, scratchWorld);
  return scratchWorld;
}
const startTick = (sc: SpiderCase): number => (sc.grace === true ? SPIDER_GRACE_TICKS - 500 : T0);

describe('#392 (V74) — state-space audit of the hold at the shaft', () => {
  afterAll(() => {
    templates.clear();
    scratchWorld = null;
  });

  it('the spider cases are what their labels say (fixture check)', () => {
    for (const sc of SPIDER_CASES) {
      const world = freshQuiet(startTick(sc));
      sc.setup(world);
      expect(rampageThreatens(world, world.colonies[P]!), sc.label).toBe(sc.threat);
      expect(isSpiderBlockade(world, DOOR.x, DOOR.y), sc.label).toBe(sc.blockade);
    }
  });

  it('direct: spider × task × adult/brood × own/foreign grid × alarm × exit tile, against the oracle', () => {
    const TASKS = [
      AntTask.Idle,
      AntTask.Foraging,
      AntTask.Digging,
      AntTask.Fighting,
      AntTask.Nursing,
    ];
    // The entrance tile it would climb out at: the door, or a tile beside it (where
    // only a spider standing there would be a blockade).
    const EXITS = [
      [DOOR.x, DOOR.y],
      [DOOR.x + 1, DOOR.y],
      [DOOR.x, DOOR.y + 1],
    ] as const;
    const failures: string[] = [];
    let held = 0;
    let heldByBlockadeAlone = 0;
    for (const sc of SPIDER_CASES) {
      for (const task of TASKS) {
        for (const adult of [true, false]) {
          for (const ownGrid of [true, false]) {
            for (const alarm of [false, true]) {
              for (const [ex, ey] of EXITS) {
                const world = freshQuiet(startTick(sc));
                sc.setup(world);
                world.colonies[P]!.alarmActive = alarm;
                const id = spawn(world, P, ex, 0, Zone.Underground, task);
                if (!adult) world.ants.speed[id] = 0;
                // Independent of the code under test: a Rampaging spider standing on the
                // exit tile (on the door, the hand label says so).
                const sp = world.spider;
                const blockadeHere =
                  sp !== null &&
                  sp.state === 'Rampaging' &&
                  sp.posX >> FP_SHIFT === ex &&
                  sp.posY >> FP_SHIFT === ey;
                if (ex === DOOR.x && ey === DOOR.y)
                  expect(blockadeHere, sc.label).toBe(sc.blockade);
                const civilian = task === AntTask.Idle || task === AntTask.Foraging;
                const want =
                  ownGrid &&
                  civilian &&
                  adult &&
                  (alarm || (task === AntTask.Idle && sc.threat) || blockadeHere);
                const got = holdCivilianAtShaft(world, id, ownGrid, ex, ey);
                const phase = world.ants.fleeShelterUntilTick[id]!;
                const wantPhase = want ? world.tick + SHELTER_COOLDOWN_TICKS : -1;
                if (got !== want || phase !== wantPhase) {
                  failures.push(
                    `${sc.label} task ${task} adult ${adult} own ${ownGrid} alarm ${alarm} exit ${ex},${ey}: got ${got}/${phase}, want ${want}/${wantPhase}`,
                  );
                }
                if (want) held += 1;
                if (want && !alarm && !(task === AntTask.Idle && sc.threat)) {
                  heldByBlockadeAlone += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // Held by the new reason alone (alarm off, no V68 threat hold): a forager at each
    // of the six blockades (four cases on the door, two camping beside it with the exit
    // under them), and an idle worker at the two that do not threaten (the fed camper,
    // the grace window).
    expect(heldByBlockadeAlone).toBe(6 + 2);
    expect(held).toBeGreaterThan(heldByBlockadeAlone);
  });

  it('through tick(): ascender × spider × alarm, from the shaft top — who climbs out', () => {
    type Kind = 'searcher' | 'returner' | 'idle' | 'fighter';
    const KINDS: Kind[] = ['searcher', 'returner', 'idle', 'fighter'];
    const failures: string[] = [];
    let cases = 0;
    for (const sc of SPIDER_CASES) {
      for (const kind of KINDS) {
        for (const alarm of [false, true]) {
          const world = freshQuiet(startTick(sc));
          const colony = world.colonies[P]!;
          colony.alarmActive = alarm;
          if (kind === 'fighter') {
            // Orders (a rally out on the surface), so it is no sentry, and a fight demand
            // so it is not stood down.
            colony.targetRatio = { forage: 0, fight: 10 };
            colony.rallyPoint = { tileX: DOOR.x + 20, tileY: DOOR.y };
          }
          sc.setup(world);
          const id =
            kind === 'searcher'
              ? spawn(
                  world,
                  P,
                  DOOR.x,
                  0,
                  Zone.Underground,
                  AntTask.Foraging,
                  ForagingSubState.SearchingFood,
                )
              : kind === 'returner'
                ? spawn(
                    world,
                    P,
                    DOOR.x,
                    0,
                    Zone.Underground,
                    AntTask.Foraging,
                    ForagingSubState.ReturningToNest,
                  )
                : kind === 'idle'
                  ? spawn(world, P, DOOR.x, 0, Zone.Underground)
                  : spawn(
                      world,
                      P,
                      DOOR.x,
                      0,
                      Zone.Underground,
                      AntTask.Fighting,
                      FightingSubState.Holding,
                    );
          tick(world, []);
          cases += 1;
          const heldWant =
            kind !== 'fighter' && (alarm || (kind === 'idle' && sc.threat) || sc.blockade);
          const zone = world.ants.zone[id]!;
          const phase = world.ants.fleeShelterUntilTick[id]!;
          const ok = heldWant
            ? zone === Zone.Underground && tileY(world, id) === 0 && phase > 0
            : zone === Zone.Surface &&
              tileX(world, id) === DOOR.x &&
              tileY(world, id) === DOOR.y &&
              phase === -1;
          if (!ok) {
            failures.push(
              `${kind}, spider ${sc.label}, alarm ${alarm}: zone ${zone} tile ${tileX(world, id)},${tileY(world, id)} phase ${phase}, want ${heldWant ? 'held' : 'out'}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(cases).toBe(SPIDER_CASES.length * 4 * 2);
  });
});

describe('#392 (V74) — a camp nothing comes up at ends at the 300-tick leash', () => {
  it('a waited-out camp times out SPIDER_RAMPAGE_MAX_TICKS (300) after it began, and the held forager then comes out', () => {
    expect(SPIDER_RAMPAGE_MAX_TICKS).toBe(300);
    const world = quiet();
    camp(world, DOOR.x, DOOR.y);
    const start = world.tick;
    const id = searcherBelow(world, P, DOOR.x, 0);
    let campEnded = -1;
    let surfacedAt = -1;
    for (let t = 0; t < 1000 && surfacedAt < 0; t++) {
      tick(world, []);
      if (campEnded < 0 && world.spider!.state !== 'Rampaging') campEnded = world.tick;
      if (campEnded < 0) expect(world.ants.zone[id], `tick ${world.tick}`).toBe(Zone.Underground);
      if (world.ants.zone[id] === Zone.Surface) surfacedAt = world.tick;
    }
    // Nothing came up, so the camp ran to the leash (300 ticks; 1200 before V74).
    expect(campEnded - start).toBeGreaterThanOrEqual(SPIDER_RAMPAGE_MAX_TICKS);
    expect(campEnded - start).toBeLessThanOrEqual(SPIDER_RAMPAGE_MAX_TICKS + 1);
    // The held forager comes out once the trail over the door has decayed.
    expect(surfacedAt).toBeGreaterThan(campEnded);
    expect(surfacedAt - campEnded).toBeLessThan(400);
    expect(world.ants.alive[id]).toBe(1);
  });
});
