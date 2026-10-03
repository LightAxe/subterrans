// #377 (V68) — idle workers shelter from a spider rampage.
//
// While the spider is on a rampage (out hunting hungry, until it eats or dies —
// spiderOnRampage), every colony's Idle workers on the surface go in by the nearest
// entrance whose way keeps out of the spider's reach, and stay in until it is over;
// Idle shelterers stay recruitable. Nothing else changes: foragers, fighters, nurses
// and the alarm's civilians keep their own rules (pinned by their own tests; the
// audit below runs only the Idle workers' cases where the rule applies).
//
// The state-space audit (worker × spider × alarm × where the spider is × ratio) runs
// through tick() every case where the rule applies and checks the rule's outcome. The
// rules are pinned through tick() below it.
import { afterAll, describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId, copyWorldState } from './types.js';
import type { SpiderBehaviorState, WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import { killAnt } from './ant-death.js';
import { addChamberForTest } from './food/food-test-utils.js';
import { rampageThreatens, rampageThreatRule } from './ant/ant-system.js';
import { rampageShelterActive, rampageShelterDashRoutes } from './ant/idle-reserve.js';
import { spiderOnRampage } from './spider.js';
import { depositDangerCross } from './pheromone/danger.js';
import { pheromoneGridKey } from './pheromone/pheromone-store.js';
import { canEnterSurfaceTile } from './ant/ant-motion.js';
import {
  AntTask,
  ChamberType,
  FightingSubState,
  ForagingSubState,
  PheromoneType,
} from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  SHELTER_COOLDOWN_TICKS,
  SPIDER_DANGER_DEPOSIT,
  SPIDER_GRACE_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  FOOD_PICKUP_AMOUNT,
  RAMPAGE_THREAT_RADIUS_TILES,
} from './constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
/** Seed 7: the player's entrance, and the spider's lair (far from both colonies). */
const DOOR = { x: 24, y: 64 } as const;
const LAIR = { x: 67, y: 117 } as const;
/** Eight tiles below the player's door: a hungry spider here threatens the player's
 *  colony (within RAMPAGE_THREAT_RADIUS_TILES, with room to take a step) while out of
 *  chase range of, and out of the way in for, the idle reserve round the door. */
const THREAT_SPOT = { x: 24, y: 64 + 8 } as const;
/** Below the player's door at exactly the threat radius, and one tile beyond it. */
const THREAT_EDGE = { x: 24, y: 64 + RAMPAGE_THREAT_RADIUS_TILES } as const;
const THREAT_OUT = { x: 24, y: 64 + RAMPAGE_THREAT_RADIUS_TILES + 1 } as const;
/** Row of the nest's tunnel (the shaft runs down to it). */
const TUNNEL_Y = 3;
/** Past the start-of-match grace, so a hungry spider hunts. */
const T0 = SPIDER_GRACE_TICKS + 500;
/** Hungry on Normal. */
const HUNGRY = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/**
 * A quiet seed-7 world at tick T0: no AI, no starting workers, a 0:0 ratio, and a
 * player nest with a shaft under its open entrance down to a tunnel along TUNNEL_Y
 * and a chamber at its east end. The spider is at its lair, sated.
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
  const colony = world.colonies[P]!;
  const grid = world.undergroundGrids[P]!;
  for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, DOOR.x, y, UndergroundTileState.Open);
  for (let x = DOOR.x - 4; x <= DOOR.x + 12; x++)
    ugSet(grid, x, TUNNEL_Y, UndergroundTileState.Open);
  for (let y = 2; y <= 4; y++) {
    for (let x = DOOR.x + 10; x < DOOR.x + 13; x++) ugSet(grid, x, y, UndergroundTileState.Open);
  }
  addChamberForTest(world, colony, {
    chamberId: allocateEntityId(world),
    chamberType: ChamberType.Nursery,
    posX: (DOOR.x + 10) << FP_SHIFT,
    posY: 2 << FP_SHIFT,
    width: 3,
    height: 3,
  });
  colony.digFlowFieldDirty = true;
  const sp = world.spider!;
  sp.posX = LAIR.x << FP_SHIFT;
  sp.posY = LAIR.y << FP_SHIFT;
  sp.hungerTicks = 0;
  sp.nextHuntTick = at + 100_000; // no density hunt in these short runs
  return world;
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

/** The DangerTrail a spider standing at (x, y) leaves (one tick's cross), on every
 *  colony's surface grid — as seedDangerPheromone deposits it. */
function spiderDanger(world: WorldState, x: number, y: number): void {
  for (const cid of [P, E]) {
    const grid = world.pheromoneGrids[pheromoneGridKey(cid, PheromoneType.DangerTrail, 'surface')];
    if (grid !== undefined) {
      depositDangerCross(grid, x, y, SPIDER_DANGER_DEPOSIT, SPIDER_DANGER_DEPOSIT >> 1);
    }
  }
}

/** What the spider is doing. */
type Spider =
  | 'none' // no spider
  | 'sated' // Patrolling, fed
  | 'feeding' // Feeding
  | 'grace' // hungry, but in the start-of-match grace
  | 'rampaging' // hungry, camping (or walking to) the player's entrance
  | 'rampagingOther' // hungry, camping (or walking to) the ENEMY's entrance
  | 'chasing' // hungry, Chasing (its target gone)
  | 'hungryPatrol'; // hungry, Patrolling (about to pick a hunt)

const ON_RAMPAGE: ReadonlySet<Spider> = new Set([
  'rampaging',
  'rampagingOther',
  'chasing',
  'hungryPatrol',
]);

/** Put the spider at (x, y) doing `s` (with the DangerTrail it leaves there). */
function setSpider(world: WorldState, s: Spider, x: number, y: number): void {
  if (s === 'none') {
    world.spider = null;
    return;
  }
  const sp = world.spider!;
  const state: SpiderBehaviorState =
    s === 'feeding'
      ? 'Feeding'
      : s === 'rampaging' || s === 'rampagingOther'
        ? 'Rampaging'
        : s === 'chasing'
          ? 'Chasing'
          : 'Patrolling';
  sp.state = state;
  sp.posX = x << FP_SHIFT;
  sp.posY = y << FP_SHIFT;
  sp.hungerTicks = s === 'sated' || s === 'feeding' ? 0 : HUNGRY;
  sp.rampageTargetColonyId = s === 'rampaging' ? P : s === 'rampagingOther' ? E : -1;
  sp.rampageEntranceId = -1;
  sp.rampageStartTick = world.tick;
  sp.rampageKillsThisRampage = 0;
  sp.chaseTargetAntId = -1;
  sp.chaseStartTick = world.tick;
  sp.feedAwayTileX = x;
  sp.feedAwayTileY = y;
  sp.feedArrivedTick = world.tick;
  if (s !== 'feeding') spiderDanger(world, x, y);
}

const tileX = (w: WorldState, id: number): number => w.ants.posX[id]! >> FP_SHIFT;
const tileY = (w: WorldState, id: number): number => w.ants.posY[id]! >> FP_SHIFT;
const fingerprint = (w: WorldState, id: number): string => {
  const a = w.ants;
  return [
    a.alive[id],
    a.task[id],
    a.subTask[id],
    a.zone[id],
    tileX(w, id),
    tileY(w, id),
    a.fleeShelterUntilTick[id],
    a.targetPosX[id],
    a.targetPosY[id],
    a.foodCarrying[id],
  ].join(',');
};

// ---------------------------------------------------------------------------
// The state-space audit
// ---------------------------------------------------------------------------

/** The player worker: where it stands, and as what. */
type Worker =
  | 'idleNear' // Idle on the surface, 3 tiles from the door
  | 'idleFar' // Idle on the surface, 20 tiles from the door
  | 'idleOnDoor' // Idle on the surface, on the entrance tile
  | 'idleDasher' // Idle on the surface, 3 tiles out, dashing in (V34 flee, phase 0)
  | 'shelterer' // Idle below at the shaft top, its shelter timer running out now
  | 'atShaft' // Idle below at the shaft top, not sheltering (it would climb out)
  | 'deep' // Idle below in the chamber, not sheltering
  | 'searcher' // Foraging, SearchingFood, on the surface 3 tiles out
  | 'carrier' // Foraging, CarryingFood, on the surface 6 tiles out
  | 'returner' // Foraging, ReturningToNest (empty), on the surface 6 tiles out
  | 'forageShelterer' // Foraging, ReturningToNest, sheltering at the shaft top
  | 'forageAtShaft' // Foraging, SearchingFood, below at the shaft top (it climbs out)
  | 'fighter' // a sentry on the surface by the door
  | 'nurse'; // Nursing, below in the chamber

/** Where the spider is, relative to the door and the worker. */
type Where =
  | 'far' // at its lair, far from both
  | 'atDoor' // on the entrance tile
  | 'onPath' // between the worker and the door
  | 'behind' // beyond the worker, away from the door, out of chase range
  | 'close' // within chase range of the worker, off its way in
  | 'besidePath' // three rows off the worker's way in, out of its chase range
  | 'edge' // exactly SPIDER_CHASE_TRIGGER_RADIUS from the worker (it is cornered)
  | 'wayEdge' // out of range, exactly on the way test's bound (m + ds = d + 2R)
  | 'wayOut' // out of range, just outside that bound (m + ds = d + 2R + 2: parity)
  // Cornered (within chase range), the worker's next step in must not land nearer
  // the spider than it stands.
  | 'cornerPath' // m = 2, beside the way in: the next step lands 1 from it
  | 'cornerOff' // m = 2, off to the side: the next step lands 3 from it
  | 'adjacentAway' // m = 1, on the far side from the door: it runs
  | 'adjacentAhead' // m = 1, between it and the door: the next step is its tile
  | 'onWorker' // m = 0, on the worker's own tile: every way leads away
  // Whether it threatens the player's colony at all (option 3): a spider not camping
  // it threatens it only within RAMPAGE_THREAT_RADIUS_TILES of its open entrance.
  | 'threatEdge' // RAMPAGE_THREAT_RADIUS_TILES from the player's door: it threatens
  | 'threatOut'; // one tile further: it threatens only as the camp target

/** Where the spider's position matters only to an idle worker: the others run the
 *  three that change what their door and exit read. */
const ALL_WHERES: Where[] = [
  'far',
  'atDoor',
  'onPath',
  'behind',
  'close',
  'besidePath',
  'edge',
  'wayEdge',
  'wayOut',
  'cornerPath',
  'cornerOff',
  'adjacentAway',
  'adjacentAhead',
  'onWorker',
  'threatEdge',
  'threatOut',
];
const SOME_WHERES: Where[] = ['far', 'atDoor', 'close'];

type Alarm = 'on' | 'off';
/** The behaviour ratio: nothing to recruit for, or all fighters. */
type Ratio = 'none' | 'fight';

/** What the rule makes the worker do in this case, or 'same' (it does not apply). */
type Expect =
  | 'same'
  | 'in' // it heads in (flee phase 0 at the door), or is already down sheltering
  | 'hold' // it holds on the surface: no target, not fleeing
  | 'stays' // a shelterer stays in (re-armed) where its poke-out would let it out
  | 'held' // an idle worker at the shaft top is held there as a shelterer
  | 'recruit'; // a shelterer is recruited as a fighter

const FAR_WORKER = { x: 44, y: 64 } as const;
const NEAR_WORKER = { x: 27, y: 64 } as const;

/** The spider's tile for `where`, given the worker's surface tile (near or far). */
function spiderTile(where: Where, far: boolean): { x: number; y: number } {
  switch (where) {
    case 'far':
      return LAIR;
    case 'atDoor':
      return DOOR;
    case 'onPath':
      return far ? { x: 34, y: 64 } : { x: 25, y: 64 };
    case 'behind':
      return far ? { x: 50, y: 64 } : { x: 33, y: 64 };
    case 'close':
      return far ? { x: 44, y: 67 } : { x: 27, y: 67 };
    case 'besidePath':
      return far ? { x: 34, y: 67 } : { x: 25, y: 67 };
    case 'edge':
      return far ? { x: 44, y: 68 } : { x: 27, y: 68 };
    case 'wayEdge':
      return far ? { x: 40, y: 68 } : { x: 26, y: 68 };
    case 'wayOut':
      return far ? { x: 40, y: 69 } : { x: 26, y: 69 };
    case 'cornerPath':
      return far ? { x: 43, y: 65 } : { x: 26, y: 65 };
    case 'cornerOff':
      return far ? { x: 44, y: 66 } : { x: 27, y: 66 };
    case 'adjacentAway':
      return far ? { x: 45, y: 64 } : { x: 28, y: 64 };
    case 'adjacentAhead':
      return far ? { x: 43, y: 64 } : { x: 26, y: 64 };
    case 'onWorker':
      return far ? FAR_WORKER : NEAR_WORKER;
    case 'threatEdge':
      return { x: DOOR.x, y: DOOR.y + RAMPAGE_THREAT_RADIUS_TILES };
    case 'threatOut':
      return { x: DOOR.x, y: DOOR.y + RAMPAGE_THREAT_RADIUS_TILES + 1 };
  }
}

/** Option 3: the spider on a rampage threatens the player's colony — it camps (or is
 *  on its way to camp) its entrance, or it is within RAMPAGE_THREAT_RADIUS_TILES of
 *  it. Only then does the rule apply. */
function threatened(s: Spider, where: Where, far: boolean): boolean {
  if (!ON_RAMPAGE.has(s)) return false;
  if (s === 'rampaging') return true;
  const t = spiderTile(where, far);
  return Math.abs(t.x - DOOR.x) + Math.abs(t.y - DOOR.y) <= RAMPAGE_THREAT_RADIUS_TILES;
}

function expected(w: Worker, s: Spider, a: Alarm, where: Where, ratio: Ratio): Expect {
  if (!threatened(s, where, w === 'idleFar')) return 'same';
  switch (w) {
    case 'idleNear':
    case 'idleFar':
    case 'idleDasher':
    case 'idleOnDoor':
      // Recruited as a fighter at step 10a (before 15b) whatever the spider does; and
      // under the alarm the alarm governs its civilians, not the rule.
      if (ratio === 'fight' || a === 'on') return 'same';
      // On the door it goes down, unless a Rampaging spider on it blocks the descent
      // (a Chasing or Patrolling one does not: the descent comes before the bite).
      if (w === 'idleOnDoor') {
        return where === 'atDoor' && (s === 'rampaging' || s === 'rampagingOther') ? 'hold' : 'in';
      }
      // The door itself reads the spider's danger (atDoor; onPath, cornered, beside
      // it), or the way passes within its chase range (besidePath, and wayEdge on
      // the bound), or — cornered — the next step lands nearer the spider than the
      // worker stands (cornerPath, adjacentAhead).
      if (where === 'atDoor' || where === 'onPath' || where === 'besidePath') return 'hold';
      if (where === 'wayEdge' || where === 'cornerPath' || where === 'adjacentAhead') return 'hold';
      // 'far', 'behind', 'wayOut', 'threatEdge' and 'threatOut' keep out of its chase
      // range (a camp target far off, or near enough to threaten); 'close', 'edge',
      // 'cornerOff', 'adjacentAway' and 'onWorker' are cornered, and the next step
      // leads no nearer the spider: it runs.
      return 'in';
    case 'shelterer':
      if (a === 'off' && ratio === 'fight') return 'recruit';
      if (a === 'on' || ratio === 'fight') return 'same';
      // The V34 poke-out keeps it in anyway while the spider's danger reads over the
      // shaft (the spider on the door, or beside it).
      return where === 'atDoor' || where === 'onPath' ? 'same' : 'stays';
    case 'atShaft':
      // Under the alarm the alarm holds it anyway; the fight ratio recruits it either way.
      return a === 'off' && ratio === 'none' ? 'held' : 'same';
    default:
      return 'same';
  }
}

const AUDIT_TICKS = 8;

/** A pristine quiet() world per start tick, copied into one reused world for each
 *  case (copyWorldState leaves the copy exactly like a fresh one, #340) — a
 *  createScenario per case would make the audit minutes long. The audit alone uses
 *  them, and clears them when it is done (afterAll). */
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

interface Run {
  frames: string[];
  task1: number;
  zone1: number;
  phase1: number;
  target1: [number, number];
}

function runCase(w: Worker, s: Spider, a: Alarm, where: Where, ratio: Ratio): Run {
  const world = freshQuiet(s === 'grace' ? SPIDER_GRACE_TICKS - 500 : T0);
  const colony = world.colonies[P]!;
  colony.alarmActive = a === 'on';
  // A 0:0 ratio would stand the lone sentry down to Idle (V40) on the first tick,
  // making the fighter row an idle worker's: it keeps its fight demand either way.
  colony.targetRatio =
    ratio === 'fight' || w === 'fighter' ? { forage: 0, fight: 10 } : { forage: 0, fight: 0 };
  const far = w === 'idleFar';
  const sp = spiderTile(where, far);
  setSpider(world, s, sp.x, sp.y);
  const ay = DOOR.y;
  let id: number;
  switch (w) {
    case 'idleNear':
      id = spawn(world, P, NEAR_WORKER.x, NEAR_WORKER.y, Zone.Surface);
      break;
    case 'idleFar':
      id = spawn(world, P, FAR_WORKER.x, FAR_WORKER.y, Zone.Surface);
      break;
    case 'idleOnDoor':
      id = spawn(world, P, DOOR.x, DOOR.y, Zone.Surface);
      break;
    case 'idleDasher':
      id = spawn(world, P, NEAR_WORKER.x, NEAR_WORKER.y, Zone.Surface);
      world.ants.fleeShelterUntilTick[id] = 0;
      break;
    case 'shelterer':
      id = spawn(world, P, DOOR.x, 0, Zone.Underground);
      world.ants.fleeShelterUntilTick[id] = world.tick;
      break;
    case 'atShaft':
      id = spawn(world, P, DOOR.x, 0, Zone.Underground);
      break;
    case 'deep':
      id = spawn(world, P, DOOR.x + 11, 3, Zone.Underground);
      break;
    case 'searcher':
      id = spawn(world, P, 27, ay, Zone.Surface, AntTask.Foraging, ForagingSubState.SearchingFood);
      break;
    case 'carrier':
      id = spawn(world, P, 30, ay, Zone.Surface, AntTask.Foraging, ForagingSubState.CarryingFood);
      world.ants.foodCarrying[id] = FOOD_PICKUP_AMOUNT;
      break;
    case 'returner':
      id = spawn(
        world,
        P,
        30,
        ay,
        Zone.Surface,
        AntTask.Foraging,
        ForagingSubState.ReturningToNest,
      );
      break;
    case 'forageShelterer':
      id = spawn(
        world,
        P,
        DOOR.x,
        0,
        Zone.Underground,
        AntTask.Foraging,
        ForagingSubState.ReturningToNest,
      );
      world.ants.fleeShelterUntilTick[id] = world.tick;
      break;
    case 'forageAtShaft':
      id = spawn(
        world,
        P,
        DOOR.x,
        0,
        Zone.Underground,
        AntTask.Foraging,
        ForagingSubState.SearchingFood,
      );
      break;
    case 'fighter':
      id = spawn(world, P, 27, ay - 1, Zone.Surface, AntTask.Fighting, FightingSubState.Holding);
      break;
    case 'nurse':
      id = spawn(world, P, DOOR.x + 11, 3, Zone.Underground, AntTask.Nursing);
      break;
  }
  if (world.ants.zone[id] === Zone.Surface && world.ants.task[id] === AntTask.Idle) {
    // A mill target it had been ambling to (a tile beside it): a hold must clear it.
    world.ants.targetPosX[id] = center(tileX(world, id) + 1);
    world.ants.targetPosY[id] = center(tileY(world, id));
  }
  const frames: string[] = [];
  let task1 = -1;
  let zone1 = -1;
  let phase1 = 0;
  let target1: [number, number] = [0, 0];
  // The spider stays where, and as what, the case put it: a hungry Patrolling spider
  // would start a rampage at once, and any spider would walk in or out of the threat
  // radius — the audit isolates the ants' rule.
  const pin = world.spider === null ? null : { ...world.spider };
  for (let t = 0; t < AUDIT_TICKS; t++) {
    tick(world, []);
    if (pin !== null && world.spider !== null) Object.assign(world.spider, pin);
    if (t === 0) {
      task1 = world.ants.task[id]!;
      zone1 = world.ants.zone[id]!;
      phase1 = world.ants.fleeShelterUntilTick[id]!;
      target1 = [world.ants.targetPosX[id]!, world.ants.targetPosY[id]!];
    }
    frames.push(fingerprint(world, id));
  }
  return { frames, task1, zone1, phase1, target1 };
}

/** '' when the run meets `want`, else what went wrong. */
function check(want: Exclude<Expect, 'same'>, run: Run): string {
  switch (want) {
    case 'in': {
      const down = run.zone1 === Zone.Underground && run.phase1 > 0;
      const dashing =
        run.zone1 === Zone.Surface &&
        run.phase1 === 0 &&
        run.target1[0] === center(DOOR.x) &&
        run.target1[1] === center(DOOR.y);
      return down || dashing ? '' : `not heading in: ${run.frames[0]}`;
    }
    case 'hold':
      return run.zone1 === Zone.Surface &&
        run.phase1 === -1 &&
        run.target1[0] === -1 &&
        run.target1[1] === -1
        ? ''
        : `not holding: ${run.frames[0]}`;
    case 'stays':
      return run.zone1 === Zone.Underground && run.phase1 > 0 ? '' : `let out: ${run.frames[0]}`;
    case 'held':
      return run.zone1 === Zone.Underground && run.phase1 > 0 ? '' : `not held: ${run.frames[0]}`;
    case 'recruit':
      return run.task1 === AntTask.Fighting && run.phase1 === -1
        ? ''
        : `not recruited: ${run.frames[0]}`;
  }
}

describe('#377 (V68) — state-space audit: worker × spider × alarm × where × ratio', () => {
  afterAll(() => {
    templates.clear();
    scratchWorld = null;
  });
  const WORKERS: Worker[] = [
    'idleNear',
    'idleFar',
    'idleOnDoor',
    'idleDasher',
    'shelterer',
    'atShaft',
    'deep',
    'searcher',
    'carrier',
    'returner',
    'forageShelterer',
    'forageAtShaft',
    'fighter',
    'nurse',
  ];
  const SPIDERS: Spider[] = [
    'none',
    'sated',
    'feeding',
    'grace',
    'rampaging',
    'rampagingOther',
    'chasing',
    'hungryPatrol',
  ];
  const ALARMS: Alarm[] = ['off', 'on'];
  const IDLE_WORKERS: ReadonlySet<Worker> = new Set([
    'idleNear',
    'idleFar',
    'idleOnDoor',
    'idleDasher',
    'shelterer',
    'atShaft',
  ]);
  const RATIOS: Ratio[] = ['none', 'fight'];
  const tally: Record<Expect, number> = { same: 0, in: 0, hold: 0, stays: 0, held: 0, recruit: 0 };
  for (const w of WORKERS) {
    for (const s of SPIDERS) {
      const cases: [Alarm, Where, Ratio, Exclude<Expect, 'same'>][] = [];
      for (const a of ALARMS) {
        for (const where of IDLE_WORKERS.has(w) ? ALL_WHERES : SOME_WHERES) {
          for (const ratio of RATIOS) {
            const want = expected(w, s, a, where, ratio);
            tally[want] += 1;
            // Where the rule does not apply, the worker's ordinary behaviour, pinned by
            // its own tests.
            if (want !== 'same') cases.push([a, where, ratio, want]);
          }
        }
      }
      if (cases.length === 0) continue;
      it(`${w}, spider ${s}`, () => {
        const failures: string[] = [];
        for (const [a, where, ratio, want] of cases) {
          const bad = check(want, runCase(w, s, a, where, ratio));
          if (bad !== '')
            failures.push(`alarm ${a}, spider ${where}, ratio ${ratio} → ${want}: ${bad}`);
        }
        expect(failures).toEqual([]);
      }, 60_000);
    }
  }
  it('the audit covers every class', () => {
    expect(tally.in).toBeGreaterThan(20);
    expect(tally.hold).toBeGreaterThan(10);
    // The threatening (spider, where) pairs for the near tiles: the camp target at all
    // 16 wheres, and the other three on-rampage spiders at the 14 within the radius
    // (all but 'far' and 'threatOut') — 58. 'stays' leaves out the two wheres whose
    // danger reaches the exit (atDoor, onPath).
    expect(tally.stays).toBe(14 + 3 * 12);
    expect(tally.held).toBe(16 + 3 * 14); // alarm off, ratio none
    expect(tally.recruit).toBe(16 + 3 * 14); // alarm off, ratio fight
  });
});

describe('fixtures', () => {
  it('seed 7: the doors, the lair, and the audit tiles are where the audit puts them', () => {
    const world = quiet();
    const ent = world.colonies[P]!.entrances[0]!;
    expect({ x: ent.surfaceTileX, y: ent.surfaceTileY, open: ent.isOpen }).toEqual({
      ...DOOR,
      open: true,
    });
    expect(world.colonies[P]!.entrances.filter((e) => e.isOpen)).toHaveLength(1);
    // Every surface tile the audit uses is walkable; row 64 is open from the door east.
    for (let x = DOOR.x; x <= 50; x++) expect(canEnterSurfaceTile(world, x, DOOR.y)).toBe(true);
    for (const [x, y] of [
      [27, 67],
      [44, 67],
      [34, 67],
      [25, 67],
      [44, 68],
      [27, 68],
      [40, 68],
      [26, 68],
      [40, 69],
      [26, 69],
      [42, 65],
      [26, 65],
      [44, 66],
      [27, 66],
      [43, 65],
    ] as const) {
      expect(canEnterSurfaceTile(world, x, y)).toBe(true);
    }
    expect(canEnterSurfaceTile(world, 27, 63)).toBe(true);
    expect(canEnterSurfaceTile(world, LAIR.x, LAIR.y)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rampage
// ---------------------------------------------------------------------------

describe('#377 — spiderOnRampage: out hunting hungry, until it eats', () => {
  const states: SpiderBehaviorState[] = [
    'Patrolling',
    'Hunting',
    'Chasing',
    'Striking',
    'Rampaging',
    'Feeding',
  ];
  it('no spider: never', () => {
    const world = quiet();
    world.spider = null;
    expect(spiderOnRampage(world)).toBe(false);
  });
  for (const state of states) {
    it(`${state}: on a rampage iff hungry and past the grace${state === 'Feeding' ? ' — never while Feeding' : ''}`, () => {
      const world = quiet();
      const sp = world.spider!;
      sp.state = state;
      for (const [difficulty, tier] of [
        ['Easy', 0],
        ['Normal', 1],
        ['Hard', 2],
      ] as const) {
        world.difficulty = difficulty;
        const threshold = SPIDER_HUNGER_THRESHOLD_TICKS[tier];
        sp.hungerTicks = threshold - 1;
        expect(spiderOnRampage(world)).toBe(false);
        sp.hungerTicks = threshold;
        expect(spiderOnRampage(world)).toBe(state !== 'Feeding');
        world.tick = SPIDER_GRACE_TICKS - 1;
        expect(spiderOnRampage(world)).toBe(false);
        world.tick = SPIDER_GRACE_TICKS;
        expect(spiderOnRampage(world)).toBe(state !== 'Feeding');
      }
    });
  }
  it('rampageShelterActive is the rampage', () => {
    const world = quiet();
    expect(rampageShelterActive(world)).toBe(false);
    world.spider!.hungerTicks = HUNGRY;
    expect(rampageShelterActive(world)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pinned through tick()
// ---------------------------------------------------------------------------

/** Six Idle workers milling round the player's door. */
function reserve(world: WorldState): number[] {
  const ids: number[] = [];
  for (const [x, y] of [
    [26, 63],
    [27, 65],
    [22, 64],
    [25, 66],
    [21, 62],
    [23, 67],
  ] as const) {
    ids.push(spawn(world, P, x, y, Zone.Surface));
  }
  return ids;
}

/** Hold the spider hungry and Patrolling at (x, y) for this tick. */
function holdSpider(world: WorldState, x: number, y: number): void {
  const sp = world.spider!;
  sp.state = 'Patrolling';
  sp.posX = x << FP_SHIFT;
  sp.posY = y << FP_SHIFT;
  sp.hungerTicks = HUNGRY;
  sp.rampageTargetColonyId = -1;
}

describe('#377 — the idle reserve goes in when the spider threatens its colony, and out after it eats', () => {
  function run(): { world: WorldState; ids: number[] } {
    const world = quiet();
    const ids = reserve(world);
    // It grows hungry within RAMPAGE_THREAT_RADIUS_TILES of the player's door.
    for (let t = 0; t < 20; t++) {
      holdSpider(world, THREAT_SPOT.x, THREAT_SPOT.y);
      tick(world, []);
    }
    return { world, ids };
  }

  it('the fixture: the threat spot is within the radius (with a step to spare), the edge on it', () => {
    const dist = (t: { x: number; y: number }): number =>
      Math.abs(t.x - DOOR.x) + Math.abs(t.y - DOOR.y);
    expect(dist(THREAT_SPOT)).toBeLessThan(RAMPAGE_THREAT_RADIUS_TILES - 1);
    expect([dist(THREAT_EDGE), dist(THREAT_OUT)]).toEqual([
      RAMPAGE_THREAT_RADIUS_TILES,
      RAMPAGE_THREAT_RADIUS_TILES + 1,
    ]);
  });

  it('every idle worker is below, sheltering at the shaft top, within 20 ticks', () => {
    const { world, ids } = run();
    expect(spiderOnRampage(world)).toBe(true);
    for (const id of ids) {
      expect(world.ants.alive[id]).toBe(1);
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect([tileX(world, id), tileY(world, id)]).toEqual([DOOR.x, 0]);
      expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(world.tick);
      expect(world.ants.task[id]).toBe(AntTask.Idle);
    }
  });

  it('they stay in while it hunts, however long, and come out once it has eaten', () => {
    const { world, ids } = run();
    // Keep it hungry and threatening for three shelter windows.
    for (let t = 0; t < 3 * SHELTER_COOLDOWN_TICKS; t++) {
      holdSpider(world, THREAT_SPOT.x, THREAT_SPOT.y);
      tick(world, []);
    }
    for (const id of ids) expect(world.ants.zone[id]).toBe(Zone.Underground);
    // It eats (a kill resets its hunger; it feeds far away).
    const sp = world.spider!;
    sp.state = 'Feeding';
    sp.hungerTicks = 0;
    sp.feedAwayTileX = LAIR.x;
    sp.feedAwayTileY = LAIR.y;
    sp.feedArrivedTick = world.tick;
    expect(spiderOnRampage(world)).toBe(false);
    for (let t = 0; t < SHELTER_COOLDOWN_TICKS + 5; t++) tick(world, []);
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    }
  });

  it('the spider dying ends it too', () => {
    const { world, ids } = run();
    world.spider = null;
    for (let t = 0; t < SHELTER_COOLDOWN_TICKS + 5; t++) tick(world, []);
    for (const id of ids) expect(world.ants.zone[id]).toBe(Zone.Surface);
  });

  it('once it no longer threatens the colony (still hungry), the next poke-out lets them out', () => {
    const { world, ids } = run();
    for (let t = 0; t < SHELTER_COOLDOWN_TICKS + 5; t++) {
      holdSpider(world, THREAT_OUT.x, THREAT_OUT.y); // one tile out of the radius
      tick(world, []);
    }
    expect(spiderOnRampage(world)).toBe(true);
    expect(rampageThreatens(world, world.colonies[P]!)).toBe(false);
    for (const id of ids) expect(world.ants.zone[id]).toBe(Zone.Surface);
  });
});

describe('#377 — a rampage that does not threaten this colony leaves its idle reserve out', () => {
  /** The reserve, 40 ticks, the spider held as `place` puts it each tick: every worker
   *  stays out, milling (on the surface, no flee timer, its mill target set), and the
   *  reserve moves (it is not holding). */
  function expectMillingOut(place: (world: WorldState) => void): void {
    const world = quiet();
    const ids = reserve(world);
    const frames = new Set<string>();
    for (let t = 0; t < 40; t++) {
      place(world);
      tick(world, []);
      for (const id of ids) {
        expect(world.ants.zone[id]).toBe(Zone.Surface);
        expect(world.ants.task[id]).toBe(AntTask.Idle);
        expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
        expect(world.ants.targetPosX[id]).not.toBe(-1);
      }
      frames.add(ids.map((id) => `${tileX(world, id)},${tileY(world, id)}`).join(' '));
    }
    expect(frames.size).toBeGreaterThan(1);
  }

  it('hungry and patrolling far from its doors: the reserve mills on the surface', () => {
    expectMillingOut((w) => holdSpider(w, LAIR.x, LAIR.y));
  });

  it('camping (on its way to) the enemy colony, far from the player: the reserve mills', () => {
    expectMillingOut((w) => {
      holdSpider(w, LAIR.x, LAIR.y);
      w.spider!.state = 'Rampaging';
      w.spider!.rampageTargetColonyId = E;
    });
  });

  it('just out of the radius (13 tiles), hungry: the reserve mills; at 12 it goes in', () => {
    expectMillingOut((w) => holdSpider(w, THREAT_OUT.x, THREAT_OUT.y));
    const world = quiet();
    const ids = reserve(world);
    for (let t = 0; t < 40; t++) {
      holdSpider(world, THREAT_EDGE.x, THREAT_EDGE.y);
      tick(world, []);
    }
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(world.tick); // sheltering
    }
  });

  it('camping the player colony from afar (on its way): it threatens — the reserve goes in', () => {
    const world = quiet();
    const ids = reserve(world);
    for (let t = 0; t < 20; t++) {
      holdSpider(world, LAIR.x, LAIR.y);
      world.spider!.state = 'Rampaging';
      world.spider!.rampageTargetColonyId = P;
      tick(world, []);
    }
    for (const id of ids) expect(world.ants.zone[id]).toBe(Zone.Underground);
  });

  it('rampageThreatens: the camp target, or within the radius of an open entrance — of this colony', () => {
    const world = quiet();
    const player = world.colonies[P]!;
    const enemy = world.colonies[E]!;
    const at = (x: number, y: number, state: SpiderBehaviorState, target: number): void => {
      holdSpider(world, x, y);
      world.spider!.state = state;
      world.spider!.rampageTargetColonyId = target;
    };
    at(LAIR.x, LAIR.y, 'Rampaging', P);
    expect([rampageThreatens(world, player), rampageThreatens(world, enemy)]).toEqual([
      true,
      false,
    ]);
    at(LAIR.x, LAIR.y, 'Rampaging', E);
    expect([rampageThreatens(world, player), rampageThreatens(world, enemy)]).toEqual([
      false,
      true,
    ]);
    // A stale target on a spider no longer Rampaging is not the camp.
    at(LAIR.x, LAIR.y, 'Chasing', P);
    expect(rampageThreatens(world, player)).toBe(false);
    for (const state of ['Chasing', 'Patrolling', 'Hunting', 'Striking', 'Rampaging'] as const) {
      at(THREAT_EDGE.x, THREAT_EDGE.y, state, -1);
      expect([state, rampageThreatens(world, player), rampageThreatens(world, enemy)]).toEqual([
        state,
        true,
        false,
      ]);
      at(THREAT_OUT.x, THREAT_OUT.y, state, -1);
      expect([state, rampageThreatens(world, player)]).toEqual([state, false]);
    }
    // A closed entrance does not count.
    at(THREAT_EDGE.x, THREAT_EDGE.y, 'Patrolling', -1);
    player.entrances[0]!.isOpen = false;
    expect(rampageThreatens(world, player)).toBe(false);
    player.entrances[0]!.isOpen = true;
    // Not on a rampage (fed): never.
    world.spider!.hungerTicks = 0;
    expect(rampageThreatens(world, player)).toBe(false);
  });

  it('rampageThreatRule (#397): the geometry alone, ungated; rampageThreatens is the shelter gate plus the rule', () => {
    const world = quiet();
    const player = world.colonies[P]!;
    const enemy = world.colonies[E]!;
    const placements: [{ x: number; y: number }, SpiderBehaviorState, number][] = [
      [LAIR, 'Rampaging', P],
      [LAIR, 'Rampaging', E],
      [LAIR, 'Chasing', P], // a stale target is not the camp
      [THREAT_EDGE, 'Patrolling', -1],
      [THREAT_EDGE, 'Rampaging', E],
      [THREAT_OUT, 'Hunting', -1],
    ];
    let rules = 0;
    let gatedOut = 0;
    for (const hunger of [HUNGRY, 0]) {
      for (const open of [true, false]) {
        for (const [tile, state, target] of placements) {
          holdSpider(world, tile.x, tile.y);
          world.spider!.state = state;
          world.spider!.rampageTargetColonyId = target;
          world.spider!.hungerTicks = hunger;
          player.entrances[0]!.isOpen = open;
          for (const colony of [player, enemy]) {
            const rule = rampageThreatRule(world, colony);
            expect(rampageThreatens(world, colony)).toBe(rampageShelterActive(world) && rule);
            if (rule) rules++;
            if (rule && !rampageShelterActive(world)) gatedOut++;
          }
        }
      }
    }
    expect(rules).toBeGreaterThan(10); // not vacuous
    expect(gatedOut).toBeGreaterThan(5); // the rule holds where the shelter gate does not
    // The rule asks only where the spider is: fed, camping our door.
    player.entrances[0]!.isOpen = true;
    holdSpider(world, LAIR.x, LAIR.y);
    world.spider!.state = 'Rampaging';
    world.spider!.rampageTargetColonyId = P;
    world.spider!.hungerTicks = 0;
    expect([rampageThreatRule(world, player), rampageThreatens(world, player)]).toEqual([
      true,
      false,
    ]);
    world.spider = null;
    expect(rampageThreatRule(world, player)).toBe(false);
  });
});

describe('#377 — it never walks toward the spider', () => {
  it('the spider camping the only door: the reserve holds out of its way, then goes in once it leaves', () => {
    const world = quiet();
    // Out of its chase range (Manhattan > 4 from the door).
    const ids = [spawn(world, P, 30, 64, Zone.Surface), spawn(world, P, 24, 70, Zone.Surface)];
    setSpider(world, 'rampaging', DOOR.x, DOOR.y);
    const start = ids.map((id) => [tileX(world, id), tileY(world, id)]);
    for (let t = 0; t < 30; t++) {
      tick(world, []);
      // Pinned on the door (the camp).
      world.spider!.posX = DOOR.x << FP_SHIFT;
      world.spider!.posY = DOOR.y << FP_SHIFT;
      world.spider!.rampageStartTick = world.tick;
      for (const id of ids) {
        expect(world.ants.zone[id]).toBe(Zone.Surface);
        expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
      }
    }
    expect(ids.map((id) => [tileX(world, id), tileY(world, id)])).toEqual(start);
    // It moves on to camp the enemy's door, far away: it no longer threatens the
    // player's colony, whose reserve stays out (its ordinary milling).
    for (let t = 0; t < 200; t++) {
      const sp = world.spider!;
      sp.state = 'Rampaging';
      sp.posX = 104 << FP_SHIFT;
      sp.posY = 64 << FP_SHIFT;
      sp.rampageTargetColonyId = E;
      sp.rampageStartTick = world.tick;
      tick(world, []);
    }
    expect(rampageThreatens(world, world.colonies[P]!)).toBe(false);
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    }
    // Back, hungry, off our door but within the threat radius, our door's trail long
    // gone: they go in.
    for (let t = 0; t < 60; t++) {
      holdSpider(world, THREAT_SPOT.x, THREAT_SPOT.y);
      tick(world, []);
    }
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0);
    }
  });

  it('two doors, the spider camping one: the idle workers by it go down the other, by path', () => {
    const world = quiet();
    const colony = world.colonies[P]!;
    // A second open entrance 12 tiles east of the first, its shaft dug to the tunnel.
    const east = { x: 36, y: 64 };
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: east.x,
      surfaceTileY: east.y,
      isOpen: true,
    });
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, east.x, y, UndergroundTileState.Open);
    colony.digFlowFieldDirty = true;
    // A worker west of the camped door, out of its chase range: its way to the east
    // door runs past the camp, so it holds. Workers east of the camp go down the
    // east door, the nearest whose way keeps out of the spider's reach.
    const westIds = [spawn(world, P, 16, 64, Zone.Surface)];
    const eastIds = [spawn(world, P, 30, 64, Zone.Surface), spawn(world, P, 31, 66, Zone.Surface)];
    setSpider(world, 'rampaging', DOOR.x, DOOR.y);
    let minDistToCamp = 99;
    for (let t = 0; t < 40; t++) {
      tick(world, []);
      world.spider!.posX = DOOR.x << FP_SHIFT;
      world.spider!.posY = DOOR.y << FP_SHIFT;
      world.spider!.rampageStartTick = world.tick;
      for (const id of [...westIds, ...eastIds]) {
        if (world.ants.zone[id] !== Zone.Surface) continue;
        const d = Math.abs(tileX(world, id) - DOOR.x) + Math.abs(tileY(world, id) - DOOR.y);
        if (d < minDistToCamp) minDistToCamp = d;
      }
    }
    // Nobody came within the spider's chase range of the camp.
    expect(minDistToCamp).toBeGreaterThan(4);
    for (const id of eastIds) {
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(tileX(world, id)).toBe(east.x);
    }
    for (const id of westIds) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    }
  });

  it('seed 7, the enemy colony: a worker behind an obstacle walks round it to its door (by path)', () => {
    // An obstacle at x103–108, y58–60 stands between the enemy entrance (104,64) and
    // (104,56); a straight-line step at the door from there runs into it.
    const world = quiet();
    for (let x = 103; x <= 108; x++) {
      for (let y = 58; y <= 60; y++) expect(canEnterSurfaceTile(world, x, y)).toBe(false);
    }
    const id = spawn(world, E, 104, 56, Zone.Surface);
    setSpider(world, 'rampaging', LAIR.x, LAIR.y);
    world.spider!.rampageTargetColonyId = E; // on its way to camp the enemy colony
    let downAt = -1;
    for (let t = 0; t < 80; t++) {
      tick(world, []);
      if (world.ants.zone[id] === Zone.Underground) {
        downAt = t;
        break;
      }
    }
    expect(downAt).toBeGreaterThan(0);
    expect(tileX(world, id)).toBe(104);
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0);
  });

  it('the spider behind an obstacle: its reach is Manhattan, through the obstacle, as its chase trigger', () => {
    // The worker at (108,61) walks row 61 under the obstacle to the enemy door
    // (104,64): 7 steps. The spider at (105,57), above the obstacle, is 4 tiles
    // (Manhattan) from (105,61) on that way, so it would turn to chase — though
    // 12 steps from the door by path. m + ds = 7 + 8 = d + 2R: the door is out.
    const world = quiet();
    for (let x = 104; x <= 108; x++) expect(canEnterSurfaceTile(world, x, 61)).toBe(true);
    const id = spawn(world, E, 108, 61, Zone.Surface);
    world.ants.targetPosX[id] = center(107);
    world.ants.targetPosY[id] = center(61);
    setSpider(world, 'hungryPatrol', 105, 57);
    tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    expect([world.ants.targetPosX[id], world.ants.targetPosY[id]]).toEqual([-1, -1]);
  });

  it('chased home: one step from its door, the spider beside it on the far side, it gets down alive', () => {
    // The straggler chase: the worker must not freeze a step short of the door (as
    // a fixed reach-1 way test for a cornered worker made it). Its step in leads
    // away from the spider, so it dashes; once the spider is on its tile the door
    // beside it reads the spider's danger, which is not consulted then (m = 0).
    const world = quiet();
    const id = spawn(world, P, DOOR.x + 1, DOOR.y, Zone.Surface);
    setSpider(world, 'chasing', DOOR.x + 2, DOOR.y);
    world.spider!.chaseTargetAntId = id;
    tick(world, []);
    expect(world.ants.fleeShelterUntilTick[id]).not.toBe(-1);
    for (let t = 0; t < 6 && world.ants.zone[id] === Zone.Surface; t++) tick(world, []);
    expect([world.ants.alive[id], world.ants.zone[id]]).toEqual([1, Zone.Underground]);
  });

  it('one tile out of chase range, round a bend: the way test decides, not the next step — it holds', () => {
    // The enemy colony: worker (106,61) under the obstacle, spider (105,57) above
    // it, door (104,64). m = 5, out of range, so the whole way must keep out of it:
    // m + ds = 5 + 8 = d + 2R, and the way can run by (105,61), 4 from the spider.
    // Its first step, diagonal to (105,62), lands 5 away: a step rule would dash.
    const world = quiet();
    for (const [x, y] of [
      [106, 61],
      [105, 61],
      [105, 62],
    ] as const) {
      expect(canEnterSurfaceTile(world, x, y)).toBe(true);
    }
    const id = spawn(world, E, 106, 61, Zone.Surface);
    world.ants.targetPosX[id] = center(107);
    world.ants.targetPosY[id] = center(61);
    setSpider(world, 'hungryPatrol', 105, 57);
    tick(world, []);
    expect(world.ants.zone[id]).toBe(Zone.Surface);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    expect([world.ants.targetPosX[id], world.ants.targetPosY[id]]).toEqual([-1, -1]);
  });

  it('cornered, one diagonal step from its door: the step keeps its distance from the spider — it goes in', () => {
    // Worker (23,63), spider (25,63), door (24,64): the diagonal step onto the door
    // lands 2 from the spider, as the worker stands. (A way test by Manhattan box
    // held it here: m + ds = d + 2(m - 1).)
    const world = quiet();
    for (const [x, y] of [
      [23, 63],
      [24, 63],
      [23, 64],
    ] as const) {
      expect(canEnterSurfaceTile(world, x, y)).toBe(true);
    }
    const id = spawn(world, P, 23, 63, Zone.Surface);
    setSpider(world, 'hungryPatrol', 25, 63);
    tick(world, []);
    // From the tile centre the diagonal crosses both axes at once: it is on the
    // door, and down, after one tick.
    expect(world.ants.zone[id]).toBe(Zone.Underground);
    expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0);
  });
});

describe('#377 — the alarm and the rampage', () => {
  it('after the all-clear, an idle shelterer stays in while the rampage lasts; a forager comes out', () => {
    const world = quiet();
    const colony = world.colonies[P]!;
    colony.alarmActive = true;
    const idle = spawn(world, P, DOOR.x, 0, Zone.Underground);
    const forager = spawn(
      world,
      P,
      DOOR.x,
      0,
      Zone.Underground,
      AntTask.Foraging,
      ForagingSubState.ReturningToNest,
    );
    for (const id of [idle, forager]) world.ants.fleeShelterUntilTick[id] = world.tick + 1;
    world.spider!.hungerTicks = HUNGRY;
    for (let t = 0; t < 5; t++) tick(world, []);
    expect(world.ants.zone[idle]).toBe(Zone.Underground);
    expect(world.ants.zone[forager]).toBe(Zone.Underground);
    colony.alarmActive = false; // the all-clear
    for (let t = 0; t < SHELTER_COOLDOWN_TICKS + 5; t++) {
      world.spider!.posX = THREAT_SPOT.x << FP_SHIFT;
      world.spider!.posY = THREAT_SPOT.y << FP_SHIFT;
      world.spider!.state = 'Patrolling';
      world.spider!.hungerTicks = HUNGRY;
      tick(world, []);
    }
    expect(world.ants.zone[idle]).toBe(Zone.Underground);
    expect(world.ants.fleeShelterUntilTick[idle]!).toBeGreaterThan(0);
    expect(world.ants.zone[forager]).toBe(Zone.Surface);
  });
});

describe('#377 — a recruited shelterer leaves the shelter for its new work', () => {
  it('the fight ratio mid-rampage makes fighters of the whole sheltering reserve at once', () => {
    const world = quiet();
    const ids = reserve(world);
    world.spider!.hungerTicks = HUNGRY;
    for (let t = 0; t < 20; t++) {
      world.spider!.posX = THREAT_SPOT.x << FP_SHIFT;
      world.spider!.posY = THREAT_SPOT.y << FP_SHIFT;
      world.spider!.state = 'Patrolling';
      world.spider!.hungerTicks = HUNGRY;
      tick(world, []);
    }
    for (const id of ids) expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(0);
    world.colonies[P]!.targetRatio = { forage: 0, fight: 10 };
    tick(world, []);
    for (const id of ids) {
      expect(world.ants.task[id]).toBe(AntTask.Fighting);
      expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    }
  });

  /** The reserve sheltering from a hungry spider at its lair, 20 ticks in. */
  function shelteringReserve(): { world: WorldState; ids: number[] } {
    const world = quiet();
    const ids = reserve(world);
    world.spider!.hungerTicks = HUNGRY;
    for (let t = 0; t < 20; t++) {
      world.spider!.posX = THREAT_SPOT.x << FP_SHIFT;
      world.spider!.posY = THREAT_SPOT.y << FP_SHIFT;
      world.spider!.state = 'Patrolling';
      world.spider!.hungerTicks = HUNGRY;
      tick(world, []);
    }
    for (const id of ids) {
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(world.ants.fleeShelterUntilTick[id]!).toBeGreaterThan(world.tick);
    }
    return { world, ids };
  }

  it('the forage ratio mid-rampage: the new foragers climb out at once, not at their poke-out', () => {
    const { world, ids } = shelteringReserve();
    world.colonies[P]!.targetRatio = { forage: 10, fight: 0 };
    tick(world, []);
    for (const id of ids) {
      expect(world.ants.task[id]).toBe(AntTask.Foraging);
      expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    }
  });

  it('the forage ratio with the spider camping the door: the new foragers wait a cooldown', () => {
    const { world, ids } = shelteringReserve();
    setSpider(world, 'rampaging', DOOR.x, DOOR.y);
    world.colonies[P]!.targetRatio = { forage: 10, fight: 0 };
    const at = world.tick;
    tick(world, []);
    for (const id of ids) {
      expect(world.ants.task[id]).toBe(AntTask.Foraging);
      expect(world.ants.zone[id]).toBe(Zone.Underground);
      expect(world.ants.fleeShelterUntilTick[id]).toBe(at + SHELTER_COOLDOWN_TICKS);
    }
  });
});

describe('#377 — the dash and the hold, in detail', () => {
  it('two dashers on one tile: neither is bumped off the way in (a dasher claims no tile)', () => {
    const world = quiet();
    const a = spawn(world, P, 30, 64, Zone.Surface);
    const b = spawn(world, P, 30, 64, Zone.Surface);
    setSpider(world, 'hungryPatrol', THREAT_SPOT.x, THREAT_SPOT.y);
    tick(world, []);
    for (const id of [a, b]) {
      expect(world.ants.fleeShelterUntilTick[id]).toBe(0);
      expect([tileX(world, id), tileY(world, id)]).toEqual([30, 64]);
    }
  });

  it('rampageShelterDashRoutes: an Idle surface dasher with a target, alarm off, its colony threatened', () => {
    const world = quiet();
    holdSpider(world, THREAT_SPOT.x, THREAT_SPOT.y);
    const id = spawn(world, P, 27, 64, Zone.Surface);
    world.ants.fleeShelterUntilTick[id] = 0;
    world.ants.targetPosX[id] = center(DOOR.x);
    world.ants.targetPosY[id] = center(DOOR.y);
    expect(rampageShelterDashRoutes(world, id)).toBe(true);
    // A rampage that does not threaten its colony: not a rampage dasher.
    holdSpider(world, LAIR.x, LAIR.y);
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
    holdSpider(world, THREAT_SPOT.x, THREAT_SPOT.y);
    // The colony alarm governs its civilians (the V42 straight line).
    world.colonies[P]!.alarmActive = true;
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
    world.colonies[P]!.alarmActive = false;
    world.ants.fleeShelterUntilTick[id] = -1;
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
    world.ants.fleeShelterUntilTick[id] = 0;
    world.ants.targetPosX[id] = -1;
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
    world.ants.targetPosX[id] = center(DOOR.x);
    world.ants.task[id] = AntTask.Foraging;
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
    world.ants.task[id] = AntTask.Idle;
    world.ants.zone[id] = Zone.Underground;
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
    world.ants.zone[id] = Zone.Surface;
    expect(rampageShelterDashRoutes(world, id)).toBe(true);
    world.spider!.hungerTicks = 0;
    expect(rampageShelterDashRoutes(world, id)).toBe(false);
  });

  it('a worker holding on the spider hunt reticle keeps the away step (it is not left on the strike tile)', () => {
    const world = quiet();
    // The spider on the door, hunting the tile the worker stands on: the door
    // reads its danger and the worker is within its chase range, so it holds.
    setSpider(world, 'hungryPatrol', DOOR.x, DOOR.y);
    const sp = world.spider!;
    sp.state = 'Hunting';
    sp.huntTargetTileX = 27;
    sp.huntTargetTileY = 64;
    sp.huntStartTick = world.tick;
    world.scatterReticleTile = { x: 27, y: 64 };
    const id = spawn(world, P, 27, 64, Zone.Surface);
    tick(world, []);
    // Step 13e pushed it off the reticle (on it exactly: north); the hold keeps that.
    expect(world.ants.fleeShelterUntilTick[id]).toBe(-1);
    expect([world.ants.targetPosX[id], world.ants.targetPosY[id]]).toEqual([
      center(27),
      center(63),
    ]);
  });
});

describe('#377 — the choice between doors', () => {
  function twoDoors(): { world: WorldState; eastId: number } {
    const world = quiet();
    const colony = world.colonies[P]!;
    const eastId = allocateEntityId(world);
    colony.entrances.push({ entranceId: eastId, surfaceTileX: 36, surfaceTileY: 64, isOpen: true });
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, 36, y, UndergroundTileState.Open);
    colony.digFlowFieldDirty = true;
    holdSpider(world, THREAT_SPOT.x, THREAT_SPOT.y);
    return { world, eastId };
  }

  it('the nearer by path; an exact tie goes to the lower entranceId', () => {
    const { world, eastId } = twoDoors();
    const westId = world.colonies[P]!.entrances[0]!.entranceId;
    expect(westId).toBeLessThan(eastId);
    const tie = spawn(world, P, 30, 64, Zone.Surface); // 6 from each door
    const nearEast = spawn(world, P, 33, 64, Zone.Surface); // 3 from the east door
    tick(world, []);
    expect([world.ants.targetPosX[tie], world.ants.targetPosY[tie]]).toEqual([
      center(DOOR.x),
      center(DOOR.y),
    ]);
    expect([world.ants.targetPosX[nearEast], world.ants.targetPosY[nearEast]]).toEqual([
      center(36),
      center(64),
    ]);
  });

  it('nearer by path, not by Manhattan: round the obstacle is farther', () => {
    // The enemy colony: its door A (104,64) is 8 from (105,57) by Manhattan but 12
    // by path (round the obstacle at x103–108, y58–60); a door B at (114,57) is 9.
    const world = quiet();
    const colony = world.colonies[E]!;
    expect(
      colony.entrances.filter((e) => e.isOpen).map((e) => [e.surfaceTileX, e.surfaceTileY]),
    ).toEqual([[104, 64]]);
    colony.entrances.push({
      entranceId: allocateEntityId(world),
      surfaceTileX: 114,
      surfaceTileY: 57,
      isOpen: true,
    });
    for (let x = 105; x <= 114; x++) expect(canEnterSurfaceTile(world, x, 57)).toBe(true);
    const id = spawn(world, E, 105, 57, Zone.Surface);
    setSpider(world, 'rampaging', LAIR.x, LAIR.y);
    world.spider!.rampageTargetColonyId = E; // on its way to camp the enemy colony
    tick(world, []);
    expect([world.ants.targetPosX[id], world.ants.targetPosY[id]]).toEqual([
      center(114),
      center(57),
    ]);
  });
});

describe('#377 — a door reading real danger that is not the spider (an enemy kill)', () => {
  /** An enemy kill's DangerTrail on the player's door, the spider elsewhere. */
  function killAtDoor(world: WorldState): void {
    const grid = world.pheromoneGrids[pheromoneGridKey(P, PheromoneType.DangerTrail, 'surface')]!;
    depositDangerCross(grid, DOOR.x, DOOR.y, SPIDER_DANGER_DEPOSIT, SPIDER_DANGER_DEPOSIT >> 1);
  }
  const holds = (world: WorldState, id: number): boolean =>
    world.ants.zone[id] === Zone.Surface &&
    world.ants.fleeShelterUntilTick[id] === -1 &&
    world.ants.targetPosX[id] === -1;

  it('the spider out of the way: the worker holds (the V34 rule: never a door that reads real danger)', () => {
    const world = quiet();
    const id = spawn(world, P, NEAR_WORKER.x, NEAR_WORKER.y, Zone.Surface);
    setSpider(world, 'hungryPatrol', THREAT_SPOT.x, THREAT_SPOT.y);
    killAtDoor(world);
    tick(world, []);
    expect(holds(world, id)).toBe(true);
  });

  it('cornered, the spider off its way: still not that door — it holds', () => {
    const world = quiet();
    const id = spawn(world, P, NEAR_WORKER.x, NEAR_WORKER.y, Zone.Surface);
    setSpider(world, 'hungryPatrol', NEAR_WORKER.x, NEAR_WORKER.y + 2);
    killAtDoor(world);
    tick(world, []);
    expect(holds(world, id)).toBe(true);
  });

  it('the spider on its own tile: any way out — it runs for the door', () => {
    const world = quiet();
    const id = spawn(world, P, NEAR_WORKER.x, NEAR_WORKER.y, Zone.Surface);
    setSpider(world, 'hungryPatrol', NEAR_WORKER.x, NEAR_WORKER.y);
    killAtDoor(world);
    tick(world, []);
    expect(world.ants.fleeShelterUntilTick[id]).toBe(0);
    expect([world.ants.targetPosX[id], world.ants.targetPosY[id]]).toEqual([
      center(DOOR.x),
      center(DOOR.y),
    ]);
  });
});

// ---------------------------------------------------------------------------
// #393 — the same-colony occupancy pass and a holder
// ---------------------------------------------------------------------------
//
// The audit above runs one worker per case; a bump needs a friend on the same tile, so
// the occupancy pass gets its own table here. The spider camps the player's only door:
// no way in is safe, so every Idle worker on the surface holds where it stands, and a
// higher-id holder stacked on a lower-id friend's tile is shifted by
// resolveSameColonyOccupancy only to a tile no nearer the spider.

/** The occupancy pass's neighbour order: N, E, S, W. */
const OCC_DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
const fromDoor = (x: number, y: number): number => Math.abs(x - DOOR.x) + Math.abs(y - DOOR.y);

describe('#393 (V68) — a holder bumped off a friend’s tile never lands nearer the spider', () => {
  /** Holder offsets from the camped door: adjacent (m = 1), cornered (m = 2), and out
   *  of chase range at m = 5, where one step nearer would put it within range. */
  const OFFSETS: readonly (readonly [number, number])[] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -2],
    [2, 0],
    [0, 2],
    [-2, 0],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [0, -5],
    [5, 0],
    [0, 5],
    [-5, 0],
    [3, 2],
    [2, -3],
    [-3, 2],
    [-2, -3],
  ];

  /** One tick: lower-id idle `blockers`, then a friend, then the holder on the
   *  friend's tile, with the spider camping the player's door. */
  function bump(
    hx: number,
    hy: number,
    blockers: readonly { x: number; y: number }[],
  ): { world: WorldState; h: number } {
    const world = quiet();
    setSpider(world, 'rampaging', DOOR.x, DOOR.y);
    for (const b of blockers) spawn(world, P, b.x, b.y, Zone.Surface);
    spawn(world, P, hx, hy, Zone.Surface);
    const h = spawn(world, P, hx, hy, Zone.Surface);
    tick(world, []);
    return { world, h };
  }

  const neighbours = (x: number, y: number): { x: number; y: number }[] =>
    OCC_DIRS.map(([dx, dy]) => ({ x: x + dx, y: y + dy }));

  for (const [ox, oy] of OFFSETS) {
    const hx = DOOR.x + ox;
    const hy = DOOR.y + oy;
    const m = fromDoor(hx, hy);
    it(`holder at (${ox}, ${oy}) from the camped door (m = ${m}): shifted away, or stays`, () => {
      const world0 = quiet();
      const open = (t: { x: number; y: number }): boolean => canEnterSurfaceTile(world0, t.x, t.y);
      const away = neighbours(hx, hy).filter((t) => open(t) && fromDoor(t.x, t.y) >= m);
      const toward = neighbours(hx, hy).filter((t) => open(t) && fromDoor(t.x, t.y) < m);
      // The case discriminates: a tile toward the spider is open (the bump an
      // unthreatened worker gets when it comes first, or when the others are taken).
      expect(toward.length).toBeGreaterThan(0);
      // A friend on its tile: it goes to the first open tile not nearer the spider.
      const pair = bump(hx, hy, []);
      expect([tileX(pair.world, pair.h), tileY(pair.world, pair.h)]).toEqual([
        away[0]!.x,
        away[0]!.y,
      ]);
      expect(pair.world.ants.fleeShelterUntilTick[pair.h]).toBe(-1); // still holding
      expect(pair.world.ants.targetPosX[pair.h]).toBe(-1);
      // Every such tile taken: it stays on its tile (a forced overlap) rather than
      // stepping toward the spider.
      const boxed = bump(hx, hy, away);
      expect([tileX(boxed.world, boxed.h), tileY(boxed.world, boxed.h)]).toEqual([hx, hy]);
      expect(boxed.world.ants.fleeShelterUntilTick[boxed.h]).toBe(-1);
    });
  }

  it('the crowded reserve of #393: only the tile toward the spider free — it stays out of chase range', () => {
    // m = 5, the spider straight north: the occupancy pass tries N first, which is
    // within SPIDER_CHASE_TRIGGER_RADIUS (4) of the spider.
    const hx = DOOR.x;
    const hy = DOOR.y + 5;
    const boxed = bump(hx, hy, [
      { x: hx + 1, y: hy },
      { x: hx, y: hy + 1 },
      { x: hx - 1, y: hy },
    ]);
    expect([tileX(boxed.world, boxed.h), tileY(boxed.world, boxed.h)]).toEqual([hx, hy]);
    // With E free it goes east (6 from the spider), not north (4).
    const pair = bump(hx, hy, []);
    expect([tileX(pair.world, pair.h), tileY(pair.world, pair.h)]).toEqual([hx + 1, hy]);
  });

  it('a stacked crowd of holders spreads out, never ends a tick nearer the spider, and settles', () => {
    const world = quiet();
    setSpider(world, 'rampaging', DOOR.x, DOOR.y);
    const pin = { ...world.spider! };
    const ids: number[] = [];
    // Two holders on every tile of a 5 × 3 block 5–7 rows below the door.
    for (let y = DOOR.y + 5; y <= DOOR.y + 7; y++) {
      for (let x = DOOR.x; x <= DOOR.x + 4; x++) {
        ids.push(spawn(world, P, x, y, Zone.Surface), spawn(world, P, x, y, Zone.Surface));
      }
    }
    const sharing = (): number => {
      const seen = new Map<number, number>();
      for (const id of ids) {
        const k = tileY(world, id) * 1000 + tileX(world, id);
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      let n = 0;
      for (const c of seen.values()) if (c > 1) n += c;
      return n;
    };
    const before = sharing();
    const frames: string[] = [];
    for (let t = 0; t < 20; t++) {
      const was = ids.map((id) => fromDoor(tileX(world, id), tileY(world, id)));
      tick(world, []);
      Object.assign(world.spider!, pin);
      ids.forEach((id, i) => {
        expect(world.ants.alive[id]).toBe(1);
        expect(world.ants.fleeShelterUntilTick[id]).toBe(-1); // holding throughout
        const now = fromDoor(tileX(world, id), tileY(world, id));
        expect(now).toBeGreaterThanOrEqual(was[i]!);
        expect(now).toBeGreaterThan(4); // never into chase range
      });
      frames.push(ids.map((id) => `${tileX(world, id)},${tileY(world, id)}`).join(' '));
    }
    expect(before).toBe(30);
    expect(sharing()).toBeLessThan(before); // the occupancy pass still spreads them
    // and every tile still shared is a forced overlap: each open neighbour no nearer
    // the spider is taken (there are some, so this is not vacuous).
    expect(sharing()).toBeGreaterThan(0);
    const taken = new Set(ids.map((id) => `${tileX(world, id)},${tileY(world, id)}`));
    const counts = new Map<string, number>();
    for (const k of ids.map((id) => `${tileX(world, id)},${tileY(world, id)}`))
      counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const [k, c] of counts) {
      if (c < 2) continue;
      const [x, y] = k.split(',').map(Number) as [number, number];
      for (const [dx, dy] of OCC_DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!canEnterSurfaceTile(world, nx, ny) || fromDoor(nx, ny) < fromDoor(x, y)) continue;
        expect([k, `${nx},${ny}`, taken.has(`${nx},${ny}`)]).toEqual([k, `${nx},${ny}`, true]);
      }
    }
    expect(frames.slice(-5).every((f) => f === frames.at(-1))).toBe(true); // no livelock
  });
});

describe('#393 — the occupancy rule moves only a threatened colony’s Idle holders', () => {
  /** Each tick's tiles of every spawned ant, the spider held as `place` puts it. */
  function tilesPerTick(
    setup: (world: WorldState) => number[],
    place: (world: WorldState) => void,
    ticks = 4,
  ): [number, number][][] {
    const world = quiet();
    place(world);
    const ids = setup(world);
    const out: [number, number][][] = [];
    for (let t = 0; t < ticks; t++) {
      tick(world, []);
      place(world);
      out.push(ids.map((id): [number, number] => [tileX(world, id), tileY(world, id)]));
    }
    return out;
  }
  const campDoor = (w: WorldState): void => {
    holdSpider(w, DOOR.x, DOOR.y);
    w.spider!.state = 'Rampaging';
    w.spider!.rampageTargetColonyId = P;
  };

  it('a colony the spider is not threatening: its stacked idle workers are bumped as usual', () => {
    // The spider camps the enemy from its lair, south-east: with N taken, the first
    // free tile (E) is nearer it.
    const place = (w: WorldState): void => {
      holdSpider(w, LAIR.x, LAIR.y);
      w.spider!.state = 'Rampaging';
      w.spider!.rampageTargetColonyId = E;
    };
    const setup = (w: WorldState): number[] => [
      spawn(w, P, 30, 69, Zone.Surface),
      spawn(w, P, 30, 70, Zone.Surface),
      spawn(w, P, 30, 70, Zone.Surface),
    ];
    // The stacked one goes east, nearer the spider, and stays there.
    const tiles = tilesPerTick(setup, place);
    for (const t of tiles) {
      expect(t).toEqual([
        [30, 69],
        [30, 70],
        [31, 70],
      ]);
    }
  });

  it('under the alarm its idle workers claim no tile (the V49 muster rule)', () => {
    // Holding on a dangerous tile or walking home, an alarmed Idle worker on the
    // surface passes through friends (idleMusterPassesThroughFriends), so the
    // occupancy pass never reaches it: rampageShelterHolds' alarm test is belt and
    // braces.
    const setup = (w: WorldState): number[] => {
      w.colonies[P]!.alarmActive = true;
      spiderDanger(w, DOOR.x, DOOR.y); // the door reads camped from the first tick
      spiderDanger(w, DOOR.x, DOOR.y + 5); // real danger on its tile: it holds
      return [
        spawn(w, P, DOOR.x, DOOR.y + 5, Zone.Surface),
        spawn(w, P, DOOR.x, DOOR.y + 5, Zone.Surface),
      ];
    };
    // Both hold, stacked on the one tile: nobody is bumped.
    for (const t of tilesPerTick(setup, campDoor)) {
      expect(t).toEqual([
        [DOOR.x, DOOR.y + 5],
        [DOOR.x, DOOR.y + 5],
      ]);
    }
  });

  it('foragers of the threatened colony are bumped as usual (north first, toward the spider)', () => {
    const setup = (w: WorldState): number[] => [
      spawn(
        w,
        P,
        DOOR.x,
        DOOR.y + 5,
        Zone.Surface,
        AntTask.Foraging,
        ForagingSubState.ReturningToNest,
      ),
      spawn(
        w,
        P,
        DOOR.x,
        DOOR.y + 5,
        Zone.Surface,
        AntTask.Foraging,
        ForagingSubState.ReturningToNest,
      ),
    ];
    expect(tilesPerTick(setup, campDoor, 1)).toEqual([
      [
        [DOOR.x, DOOR.y + 5],
        [DOOR.x, DOOR.y + 4],
      ],
    ]);
  });

  it('idle workers below ground in the threatened colony are bumped as usual', () => {
    // In the tunnel just west of the shaft: E (the shaft) is the first open tile.
    const setup = (w: WorldState): number[] => [
      spawn(w, P, DOOR.x - 1, TUNNEL_Y, Zone.Underground),
      spawn(w, P, DOOR.x - 1, TUNNEL_Y, Zone.Underground),
    ];
    expect(tilesPerTick(setup, campDoor, 1)).toEqual([
      [
        [DOOR.x - 1, TUNNEL_Y],
        [DOOR.x, TUNNEL_Y],
      ],
    ]);
  });
});
