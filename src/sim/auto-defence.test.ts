// #372 (V64) — automatic defence, and an AI probe sends only its cohort.
//
// Automatic defence: while an enemy ant is below ground in a colony's nest (in the
// part one of its open entrances' shafts reaches), the colony's fighters with NO
// orders defend the breached entrance as tunnel defenders; fighters with orders keep
// them; once the intruders are gone the defenders are sentries again. Probe cohort:
// an AI probe's rally applies only to the fighters the probe recorded.
//
// The state-space audit (fighter order state × invasion state × which entrance ×
// where the fighter stands) drives step 10c directly (updateFightAntTargets) on a
// scenario nest, at V63 and at V64, and checks the V64 outcome is the automatic
// defence where it should fire and exactly the V63 outcome everywhere else. The
// behaviour through tick() is pinned below it.
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import {
  allocateEntityId,
  SIM_VERSION_V63_AI_DEEP_QUEEN,
  SIM_VERSION_V64_AUTO_DEFENCE,
} from './types.js';
import type { WorldState } from './types.js';
import { initAnt } from './ant/ant-store.js';
import {
  fighterBarredFromOwnShaft,
  fighterDefendsTunnels,
  fighterIsRecalled,
  updateFightAntTargets,
} from './ant/ant-combat-targeting.js';
import { standDownSurplusSentries } from './ant/ant-system.js';
import { createDefaultAIStateRecord, getAIStateForColony } from './ai-state.js';
import {
  colonyRallyIsProbe,
  fighterAnswersRally,
  fighterOutsideProbeCohort,
} from './fighter-orders.js';
import { getScratch } from './scratch.js';
import { AntTask, FightingSubState, RaidType } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;
const V63 = SIM_VERSION_V63_AI_DEEP_QUEEN;
const V64 = SIM_VERSION_V64_AUTO_DEFENCE;
/** Row of the nest's tunnel (the shafts run down to it). */
const TUNNEL_Y = 3;
/** Entrance B lies this many columns east of entrance A. */
const B_OFFSET = 10;

function spawn(
  world: WorldState,
  colonyId: number,
  x: number,
  y: number,
  zone: number,
  opts: { task?: number; grid?: number; speed?: number; subTask?: number } = {},
): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: (opts.task ?? AntTask.Fighting) as AntTask,
    subTask: opts.subTask ?? 0,
    speed: opts.speed ?? WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: zone as Zone,
  });
  world.ants.currentGridColonyId[id] = opts.grid ?? colonyId;
  const colony = world.colonies[colonyId]!;
  colony.workers.push(id);
  colony.workerCount += 1;
  return id;
}

/**
 * A quiet scenario world (no spider, no AI records) whose player nest has a shaft
 * under its open entrance A down to a tunnel along TUNNEL_Y, and, with `twoDoors`,
 * a second open entrance B = A + B_OFFSET whose shaft joins the same tunnel.
 */
function nest(
  version: number,
  twoDoors: boolean,
): {
  world: WorldState;
  a: { x: number; y: number; id: number };
  b: { x: number; y: number; id: number };
} {
  const world = createScenario(7, 'Normal');
  world.simVersion = version;
  world.spider = null;
  world.aiState = [];
  const colony = world.colonies[P]!;
  const ea = colony.entrances.find((en) => en.isOpen)!;
  const grid = world.undergroundGrids[P]!;
  const ax = ea.surfaceTileX;
  for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, ax, y, UndergroundTileState.Open);
  for (let x = ax - 14; x <= ax + B_OFFSET + 6; x++) {
    ugSet(grid, x, TUNNEL_Y, UndergroundTileState.Open);
  }
  const b = { x: ax + B_OFFSET, y: ea.surfaceTileY, id: -1 };
  if (twoDoors) {
    for (let y = 0; y <= TUNNEL_Y; y++) ugSet(grid, b.x, y, UndergroundTileState.Open);
    b.id = allocateEntityId(world);
    colony.entrances.push({ entranceId: b.id, surfaceTileX: b.x, surfaceTileY: b.y, isOpen: true });
  }
  colony.digFlowFieldDirty = true;
  return { world, a: { x: ax, y: ea.surfaceTileY, id: ea.entranceId }, b };
}

const tileOf = (world: WorldState, id: number): string =>
  `${world.ants.posX[id]! >> FP_SHIFT},${world.ants.posY[id]! >> FP_SHIFT}`;

const targetOf = (world: WorldState, id: number): string =>
  world.ants.targetPosX[id] === -1
    ? 'hold'
    : `${world.ants.targetPosX[id]! >> FP_SHIFT},${world.ants.targetPosY[id]! >> FP_SHIFT}`;

// ---------------------------------------------------------------------------
// The state-space audit
// ---------------------------------------------------------------------------

/** The fighter's order state. */
type Orders =
  | 'none' // no rally: a sentry
  | 'rallyField' // a rally on an open surface tile
  | 'rallyOwnA' // a rally on its own entrance A (tunnel defence)
  | 'rallyOwnB' // a rally on its own entrance B
  | 'raidEnemy' // a rally on the enemy's entrance (a raid)
  | 'blockadeEnemy' // a Blockade of the enemy's entrance
  | 'probeIn' // its AI colony probes and it is in the cohort
  | 'probeOut' // its AI colony probes and it is NOT in the cohort
  | 'invasionOp' // its AI colony runs an Invasion (every fighter's order)
  | 'spider' // its colony sent its fighters at the spider
  | 'hauling'; // a raider hauling loot home (no rally)

/** The invasion state of its nest. */
type Invasion =
  | 'none'
  | 'nearA' // an enemy fighter below, in the tunnel near shaft A
  | 'nearB' // …near shaft B (A's shaft reaches it too)
  | 'pocket' // an enemy fighter below, in a pocket no shaft reaches
  | 'doorstep' // an enemy fighter on the surface by entrance A, not in
  | 'nearAandB'; // one near A AND one near B

/** Where the fighter stands. */
type Where = 'surfA' | 'surfB' | 'below' | 'foreign';

const ORDERS: readonly Orders[] = [
  'none',
  'rallyField',
  'rallyOwnA',
  'rallyOwnB',
  'raidEnemy',
  'blockadeEnemy',
  'probeIn',
  'probeOut',
  'invasionOp',
  'spider',
  'hauling',
];
const INVASIONS: readonly Invasion[] = [
  'none',
  'nearA',
  'nearB',
  'pocket',
  'doorstep',
  'nearAandB',
];
const WHERE: readonly Where[] = ['surfA', 'surfB', 'below', 'foreign'];

interface Outcome {
  target: string;
  moving: number;
  defends: boolean;
  barredA: boolean;
  barredB: boolean;
  recalled: boolean;
  subTask: number;
}

/** Build the case at `version`, run step 10c once, read the fighter's outcome. */
function runCase(version: number, o: Orders, inv: Invasion, where: Where): Outcome {
  const twoDoors = true;
  const { world, a, b } = nest(version, twoDoors);
  const colony = world.colonies[P]!;
  const enemy = world.colonies[E]!;
  const ee = enemy.entrances.find((en) => en.isOpen)!;
  const field = { x: a.x + 5, y: a.y + 12 };

  // The fighter under test, and one other fighter of the colony (a cohort mate),
  // spawned after it so its rank never moves the tested fighter's post.
  const pos =
    where === 'surfA'
      ? { x: a.x + 2, y: a.y, zone: Zone.Surface, grid: P }
      : where === 'surfB'
        ? { x: b.x + 2, y: b.y, zone: Zone.Surface, grid: P }
        : where === 'below'
          ? { x: a.x + 4, y: TUNNEL_Y, zone: Zone.Underground, grid: P }
          : { x: ee.surfaceTileX, y: 1, zone: Zone.Underground, grid: E };
  const id = spawn(world, P, pos.x, pos.y, pos.zone, { grid: pos.grid });
  const mate = spawn(world, P, a.x - 3, a.y, Zone.Surface);
  if (o === 'hauling') world.ants.subTask[id] = FightingSubState.Hauling;

  switch (o) {
    case 'none':
    case 'hauling':
      break;
    case 'rallyField':
      colony.rallyPoint = { tileX: field.x, tileY: field.y };
      break;
    case 'rallyOwnA':
      colony.rallyPoint = { tileX: a.x, tileY: a.y };
      break;
    case 'rallyOwnB':
      colony.rallyPoint = { tileX: b.x, tileY: b.y };
      break;
    case 'raidEnemy':
      colony.rallyPoint = { tileX: ee.surfaceTileX, tileY: ee.surfaceTileY };
      break;
    case 'blockadeEnemy':
      colony.rallyPoint = { tileX: ee.surfaceTileX, tileY: ee.surfaceTileY };
      colony.raidType = RaidType.Blockade;
      break;
    case 'probeIn':
    case 'probeOut':
    case 'invasionOp': {
      const rec = createDefaultAIStateRecord(P);
      const probe = o !== 'invasionOp';
      const tx = probe ? field.x : ee.surfaceTileX;
      const ty = probe ? field.y : ee.surfaceTileY;
      rec.state = probe ? 'Probing' : 'Invading';
      rec.operationKind = probe ? 'Probe' : 'Invasion';
      rec.operationTargetTileX = tx;
      rec.operationTargetTileY = ty;
      rec.operationFighterIds[0] = mate;
      if (o === 'probeIn') rec.operationFighterIds[1] = id;
      rec.operationFighterCount = o === 'probeIn' ? 2 : 1;
      world.aiState.push(rec);
      colony.rallyPoint = { tileX: tx, tileY: ty };
      break;
    }
    case 'spider':
      world.spiderPriorityColonyId = P;
      break;
  }

  const intruderAt = (x: number, y: number, zone: number, grid: number): number =>
    spawn(world, E, x, y, zone, { grid, speed: 0 });
  if (inv === 'nearA' || inv === 'nearAandB') intruderAt(a.x - 2, TUNNEL_Y, Zone.Underground, P);
  if (inv === 'nearB' || inv === 'nearAandB') intruderAt(b.x + 3, TUNNEL_Y, Zone.Underground, P);
  if (inv === 'pocket') {
    ugSet(world.undergroundGrids[P]!, a.x + 6, TUNNEL_Y + 5, UndergroundTileState.Open);
    intruderAt(a.x + 6, TUNNEL_Y + 5, Zone.Underground, P);
  }
  if (inv === 'doorstep') intruderAt(a.x - 2, a.y + 1, Zone.Surface, E);

  updateFightAntTargets(world);
  return {
    target: targetOf(world, id),
    moving: getScratch(world).antTargeting.sentryMoving[id]!,
    defends: fighterDefendsTunnels(world, id),
    barredA: fighterBarredFromOwnShaft(world, id, colony, a.x, a.y),
    barredB: fighterBarredFromOwnShaft(world, id, colony, b.x, b.y),
    recalled: fighterIsRecalled(world, id),
    subTask: world.ants.subTask[id]!,
  };
}

/** Automatic defence applies to this case: a fighter with no orders (no rally, or
 *  outside an AI probe's cohort; not sent at the spider; not hauling) whose nest an
 *  intruder a shaft reaches is in. (In a foreign nest it only climbs out first.) */
function autoApplies(o: Orders, inv: Invasion): boolean {
  return (
    (o === 'none' || o === 'probeOut') &&
    (inv === 'nearA' || inv === 'nearB' || inv === 'nearAandB')
  );
}

describe('#372 (V64) — state-space audit: fighter orders × invasion × entrance × position', () => {
  // Every combination, V63 and V64 side by side.
  for (const o of ORDERS) {
    for (const inv of INVASIONS) {
      for (const where of WHERE) {
        it(`${o} / ${inv} / ${where}`, () => {
          const v63 = runCase(V63, o, inv, where);
          const v64 = runCase(V64, o, inv, where);
          // The breached entrance: the open one nearest an intruder (A for nearA and
          // for nearAandB, whose A-side intruder is the nearer; B for nearB).
          const breachedIsA = inv !== 'nearB';
          if (autoApplies(o, inv) && where === 'foreign') {
            // In the enemy's nest it climbs out first, as at V63 (recalled: no rally
            // holds it there); once out it may go down the breached shaft.
            const expected = { ...(o === 'probeOut' ? runCase(V63, 'none', inv, where) : v63) };
            if (breachedIsA) expected.barredA = false;
            else expected.barredB = false;
            expect(v64).toEqual(expected);
            expect(v64.recalled).toBe(true);
          } else if (autoApplies(o, inv)) {
            const { a, b } = nest(V64, true);
            const door = breachedIsA ? a : b;
            if (where === 'below') {
              // Below in the nest: a tunnel defender, after the nearest intruder.
              expect(v64.defends).toBe(true);
              const intruder =
                inv === 'nearB' ? `${b.x + 3},${TUNNEL_Y}` : `${a.x - 2},${TUNNEL_Y}`;
              expect(v64.target).toBe(intruder);
            } else {
              // On the surface: to the breached entrance, by the routed walk (V57).
              expect(v64.defends).toBe(false);
              expect(v64.target).toBe(`${door.x},${door.y}`);
              expect(v64.moving).toBe(4); // DEFENDER_MOVING_TO_ENTRANCE
            }
            // It may go down the breached shaft, and no other.
            expect(breachedIsA ? v64.barredA : v64.barredB).toBe(false);
            expect(breachedIsA ? v64.barredB : v64.barredA).toBe(true);
            expect(v64.recalled).toBe(o === 'none' || o === 'probeOut');
            // And at V63 it did not: a sentry (or the probe's follower).
            expect(v63.defends).toBe(false);
          } else if (o === 'probeOut') {
            // Outside the probe's cohort, with nothing to defend: exactly a sentry.
            expect(v64).toEqual(runCase(V64, 'none', inv, where));
            // …where at V63 it followed the probe's rally.
            expect(v63).toEqual(runCase(V63, 'probeIn', inv, where));
            expect(v64.recalled).toBe(true);
            expect(v63.recalled).toBe(false);
          } else {
            // Nothing new applies: exactly the V63 outcome.
            expect(v64).toEqual(v63);
          }
        });
      }
    }
  }

  it('the audit is not vacuous: sentries and followers act differently in it', () => {
    expect(runCase(V64, 'none', 'none', 'surfA')).not.toEqual(
      runCase(V64, 'rallyField', 'none', 'surfA'),
    );
    expect(runCase(V64, 'none', 'nearA', 'surfB')).not.toEqual(
      runCase(V64, 'none', 'none', 'surfB'),
    );
  });
});

// ---------------------------------------------------------------------------
// fighter-orders.ts
// ---------------------------------------------------------------------------

describe('#372 (V64) — fighter-orders: which fighters a probe rally applies to', () => {
  function probeWorld(version: number): { world: WorldState; inCohort: number; outside: number } {
    const { world, a } = nest(version, false);
    const colony = world.colonies[P]!;
    const inCohort = spawn(world, P, a.x + 2, a.y, Zone.Surface);
    const outside = spawn(world, P, a.x + 3, a.y, Zone.Surface);
    const rec = createDefaultAIStateRecord(P);
    rec.state = 'Probing';
    rec.operationKind = 'Probe';
    rec.operationTargetTileX = a.x + 20;
    rec.operationTargetTileY = a.y + 5;
    rec.operationFighterIds[0] = inCohort;
    rec.operationFighterCount = 1;
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: a.x + 20, tileY: a.y + 5 };
    return { world, inCohort, outside };
  }

  it('V64: only the cohort answers the probe rally', () => {
    const { world, inCohort, outside } = probeWorld(V64);
    expect(colonyRallyIsProbe(world, world.colonies[P]!)).toBe(true);
    expect(fighterAnswersRally(world, inCohort)).toBe(true);
    expect(fighterAnswersRally(world, outside)).toBe(false);
    expect(fighterOutsideProbeCohort(world, outside)).toBe(true);
  });

  it('V63 (pinned): every fighter answers it', () => {
    const { world, inCohort, outside } = probeWorld(V63);
    expect(colonyRallyIsProbe(world, world.colonies[P]!)).toBe(false);
    expect(fighterAnswersRally(world, inCohort)).toBe(true);
    expect(fighterAnswersRally(world, outside)).toBe(true);
  });

  it('a rally off the probe target (the AI moved it: nest defence) is every fighter’s', () => {
    const { world, outside } = probeWorld(V64);
    world.colonies[P]!.rallyPoint = { tileX: 3, tileY: 3 };
    expect(fighterAnswersRally(world, outside)).toBe(true);
    world.colonies[P]!.rallyPoint = { tileX: 3, tileY: world.colonies[P]!.rallyPoint.tileY };
    // Same row, other column: still not the target.
    expect(fighterAnswersRally(world, outside)).toBe(true);
  });

  it('an Invasion operation on the rally tile is every fighter’s', () => {
    const { world, outside } = probeWorld(V64);
    getAIStateForColony(world, P)!.operationKind = 'Invasion';
    expect(fighterAnswersRally(world, outside)).toBe(true);
  });

  it('no rally: nobody answers; another colony’s probe does not matter', () => {
    const { world, inCohort } = probeWorld(V64);
    world.colonies[P]!.rallyPoint = null;
    expect(fighterAnswersRally(world, inCohort)).toBe(false);
    expect(fighterOutsideProbeCohort(world, inCohort)).toBe(false);
    const other = probeWorld(V64);
    other.world.aiState[0]!.colonyId = E; // the probe is the enemy's, not this colony's
    expect(fighterAnswersRally(other.world, other.outside)).toBe(true);
  });

  it('fighters outside the cohort are ranked as sentries: they take distinct posts', () => {
    const { world, a } = nest(V64, false);
    const colony = world.colonies[P]!;
    const ids = [0, 1, 2].map(() => spawn(world, P, a.x + 2, a.y, Zone.Surface));
    const cohortMate = spawn(world, P, a.x - 2, a.y, Zone.Surface);
    const rec = createDefaultAIStateRecord(P);
    rec.state = 'Probing';
    rec.operationKind = 'Probe';
    rec.operationTargetTileX = a.x + 5;
    rec.operationTargetTileY = a.y + 12;
    rec.operationFighterIds[0] = cohortMate;
    rec.operationFighterCount = 1;
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: a.x + 5, tileY: a.y + 12 };
    updateFightAntTargets(world);
    const posts = ids.map((id) => targetOf(world, id));
    expect(new Set(posts).size, posts.join(' ')).toBe(3);
    expect(targetOf(world, cohortMate)).toBe(`${a.x + 5},${a.y + 12}`);
  });

  it('a probe rally on an own entrance takes only the cohort down it (the rule is per fighter)', () => {
    // Not a case the AI makes (a probe rallies on a food pile), but the rule must
    // not leak: the shaft rule reads the fighter's orders, not the colony's rally.
    const { world, a } = nest(V64, false);
    const colony = world.colonies[P]!;
    const inCohort = spawn(world, P, a.x + 2, a.y, Zone.Surface);
    const outside = spawn(world, P, a.x + 3, a.y, Zone.Surface);
    const rec = createDefaultAIStateRecord(P);
    rec.state = 'Probing';
    rec.operationKind = 'Probe';
    rec.operationTargetTileX = a.x;
    rec.operationTargetTileY = a.y;
    rec.operationFighterIds[0] = inCohort;
    rec.operationFighterCount = 1;
    world.aiState.push(rec);
    colony.rallyPoint = { tileX: a.x, tileY: a.y };
    updateFightAntTargets(world);
    expect(fighterBarredFromOwnShaft(world, inCohort, colony, a.x, a.y)).toBe(false);
    expect(fighterBarredFromOwnShaft(world, outside, colony, a.x, a.y)).toBe(true);
  });

  it('a non-fighter is never "outside the cohort"', () => {
    const { world, outside } = probeWorld(V64);
    world.ants.task[outside] = AntTask.Foraging;
    expect(fighterOutsideProbeCohort(world, outside)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The breached entrance
// ---------------------------------------------------------------------------

describe('#372 (V64) — which entrance is breached', () => {
  const breached = (world: WorldState): number | undefined =>
    getScratch(world).antTargeting.breachedEntrance.get(P);

  it('the open entrance nearest an intruder', () => {
    const { world, a, b } = nest(V64, true);
    spawn(world, E, b.x + 1, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBe(b.id);
    const w2 = nest(V64, true);
    spawn(w2.world, E, w2.a.x + 1, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(w2.world);
    expect(breached(w2.world)).toBe(a.id);
  });

  it('measured from each intruder, whatever their ids', () => {
    const { world, a } = nest(V64, true);
    // The lower-id intruder is by B but farther from its shaft (6) than the other is
    // from A's (5): A is breached.
    spawn(world, E, a.x + B_OFFSET + 3, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    spawn(world, E, a.x - 2, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBe(a.id);
  });

  it('on a tie, the lower entranceId', () => {
    const { world, a } = nest(V64, true);
    // Halfway between the shafts: equally near both.
    spawn(world, E, a.x + (B_OFFSET >> 1), TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBe(a.id); // A's id is below B's (B was allocated later)
  });

  it('skips a nearer entrance whose shaft does not reach the intruder', () => {
    const { world, a, b } = nest(V64, true);
    // Cut the tunnel between the shafts: B's shaft no longer reaches the A side.
    ugSet(world.undergroundGrids[P]!, b.x - 1, TUNNEL_Y, UndergroundTileState.Solid);
    // An intruder just west of the cut: nearer B's shaft by Manhattan, reached only from A.
    spawn(world, E, b.x - 2, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBe(a.id);
  });

  it('none for an intruder no shaft reaches, on the surface, or in another nest', () => {
    const { world, a } = nest(V64, false);
    ugSet(world.undergroundGrids[P]!, a.x + 6, 9, UndergroundTileState.Open);
    spawn(world, E, a.x + 6, 9, Zone.Underground, { grid: P, speed: 0 });
    spawn(world, E, a.x + 1, a.y, Zone.Surface, { grid: E, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBeUndefined();
  });

  it('none for a closed entrance: only an open shaft is defended', () => {
    const { world, a } = nest(V64, false);
    world.colonies[P]!.entrances[0]!.isOpen = false;
    spawn(world, E, a.x + 1, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBeUndefined();
  });

  it('cleared on the pass after the last intruder dies', () => {
    const { world, a } = nest(V64, false);
    const inv = spawn(world, E, a.x + 1, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBe(a.id);
    world.ants.alive[inv] = 0;
    updateFightAntTargets(world);
    expect(breached(world)).toBeUndefined();
  });

  it('none while the colony’s rally is every fighter’s order (they defend only by it)', () => {
    const { world, a } = nest(V64, false);
    world.colonies[P]!.rallyPoint = { tileX: a.x + 5, tileY: a.y + 12 };
    spawn(world, E, a.x + 1, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBeUndefined();
  });

  it('V63 (pinned): never', () => {
    const { world, a } = nest(V63, false);
    spawn(world, E, a.x + 1, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 });
    updateFightAntTargets(world);
    expect(breached(world)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Through tick()
// ---------------------------------------------------------------------------

/** A settled player garrison: `n` sentries holding posts round entrance A (and,
 *  with `twoDoors`, `n` more round B), no rally, the ratio asking for all of them. */
function garrison(
  version: number,
  n: number,
  twoDoors: boolean,
): {
  world: WorldState;
  a: { x: number; y: number; id: number };
  b: { x: number; y: number; id: number };
  atA: number[];
  atB: number[];
} {
  const { world, a, b } = nest(version, twoDoors);
  const colony = world.colonies[P]!;
  const atA: number[] = [];
  const atB: number[] = [];
  for (let i = 0; i < n; i++) atA.push(spawn(world, P, a.x + 2, a.y, Zone.Surface));
  if (twoDoors) for (let i = 0; i < n; i++) atB.push(spawn(world, P, b.x + 2, b.y, Zone.Surface));
  let other = 0;
  for (const w of colony.workers) {
    if (world.ants.alive[w] === 1 && world.ants.task[w] !== AntTask.Fighting) other += 1;
  }
  colony.targetRatio.forage = other;
  colony.targetRatio.fight = atA.length + atB.length;
  for (let t = 0; t < 120; t++) tick(world, []);
  return { world, a, b, atA, atB };
}

/** Enemy fighters below in the player's nest, invading (their rally on A). */
function invade(world: WorldState, a: { x: number; y: number }, xs: readonly number[]): number[] {
  const enemy = world.colonies[E]!;
  enemy.rallyPoint = { tileX: a.x, tileY: a.y };
  return xs.map((x) => spawn(world, E, x, TUNNEL_Y, Zone.Underground, { grid: P, speed: 0 }));
}

describe('#372 (V64) — automatic defence through tick()', () => {
  it('V64: the garrison goes down, kills the intruders, and comes back out to its posts', () => {
    const { world, a, atA } = garrison(V64, 4, false);
    expect(atA.every((id) => world.ants.subTask[id] === FightingSubState.Holding)).toBe(true);
    const invaders = invade(world, a, [a.x + 8, a.x + 11]);
    let wentDown = 0;
    for (let t = 0; t < 400 && invaders.some((i) => world.ants.alive[i] === 1); t++) {
      tick(world, []);
      wentDown = Math.max(
        wentDown,
        atA.filter((id) => world.ants.zone[id] === Zone.Underground).length,
      );
    }
    expect(invaders.map((i) => world.ants.alive[i])).toEqual([0, 0]);
    expect(wentDown).toBe(atA.length);
    // Beaten: sentries again, back out and holding their posts.
    for (let t = 0; t < 200; t++) tick(world, []);
    const alive = atA.filter((id) => world.ants.alive[id] === 1);
    expect(alive.length).toBeGreaterThan(0);
    for (const id of alive) {
      expect(world.ants.zone[id]).toBe(Zone.Surface);
      expect(world.ants.subTask[id]).toBe(FightingSubState.Holding);
    }
  }, 30_000);

  it('V63 (pinned): the garrison stays at its posts and the intruders live', () => {
    const { world, a, atA } = garrison(V63, 4, false);
    const invaders = invade(world, a, [a.x + 8, a.x + 11]);
    for (let t = 0; t < 300; t++) {
      tick(world, []);
      expect(atA.every((id) => world.ants.zone[id] === Zone.Surface)).toBe(true);
    }
    expect(invaders.map((i) => world.ants.alive[i])).toEqual([1, 1]);
  }, 30_000);

  it('sentries at the other entrance walk over and go down the breached one', () => {
    const { world, a, b, atA, atB } = garrison(V64, 2, true);
    // An intruder just below B: B is breached; A's sentries come round to it.
    const invaders = invade(world, a, [b.x + 3]);
    world.ants.hp[invaders[0]!] = 100_000; // outlasts the walk: we watch where they go in
    const entered = new Map<number, number>();
    for (let t = 0; t < 250; t++) {
      const before = atA.map((id) => world.ants.zone[id]);
      tick(world, []);
      atA.forEach((id, k) => {
        if (before[k] === Zone.Surface && world.ants.zone[id] === Zone.Underground) {
          entered.set(id, world.ants.posX[id]! >> FP_SHIFT);
        }
      });
    }
    expect([...entered.keys()].sort()).toEqual([...atA].sort());
    expect([...entered.values()].every((x) => x === b.x)).toBe(true);
    expect(atB.every((id) => world.ants.zone[id] === Zone.Underground)).toBe(true);
  }, 30_000);

  it('a colony-wide rally elsewhere keeps its fighters there: no automatic defence', () => {
    const { world, a, atA } = garrison(V64, 3, false);
    const colony = world.colonies[P]!;
    colony.rallyPoint = { tileX: a.x + 5, tileY: a.y + 12 };
    for (let t = 0; t < 80; t++) tick(world, []);
    invade(world, a, [a.x + 8]);
    for (let t = 0; t < 200; t++) {
      tick(world, []);
      expect(atA.every((id) => world.ants.zone[id] === Zone.Surface)).toBe(true);
    }
    for (const id of atA) {
      const d =
        Math.abs((world.ants.posX[id]! >> FP_SHIFT) - (a.x + 5)) +
        Math.abs((world.ants.posY[id]! >> FP_SHIFT) - (a.y + 12));
      expect(d, tileOf(world, id)).toBeLessThanOrEqual(3);
    }
  }, 30_000);

  it('surplus sentries do not stand down while the nest is invaded (V64), and do at V63', () => {
    for (const version of [V64, V63]) {
      const { world, a, atA } = garrison(version, 5, false);
      const colony = world.colonies[P]!;
      invade(world, a, [a.x + 11]);
      colony.computedAllocation.fight = 1; // surplus 4: three would go
      standDownSurplusSentries(world, colony);
      const idle = atA.filter((id) => world.ants.task[id] === AntTask.Idle).length;
      expect(idle, `v${version}`).toBe(version === V64 ? 0 : 3);
    }
  }, 30_000);
});

describe('#372 (V64) — an AI probe sends only its cohort (through tick())', () => {
  function probe(version: number): {
    world: WorldState;
    cohort: number[];
    others: number[];
    target: { x: number; y: number };
    home: { x: number; y: number };
  } {
    const world = createScenario(11, 'Normal');
    world.simVersion = version;
    world.spider = null;
    const enemy = world.colonies[E]!;
    const ee = enemy.entrances.find((en) => en.isOpen)!;
    const ids: number[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(spawn(world, E, ee.surfaceTileX + 2, ee.surfaceTileY, Zone.Surface));
    let other = 0;
    for (const w of enemy.workers) {
      if (world.ants.alive[w] === 1 && world.ants.task[w] !== AntTask.Fighting) other += 1;
    }
    enemy.targetRatio.forage = other;
    enemy.targetRatio.fight = ids.length;
    const rec = getAIStateForColony(world, E)!;
    rec.state = 'WarFooting';
    const target = { x: ee.surfaceTileX, y: ee.surfaceTileY + 12 };
    const cohort = ids.slice(0, 3);
    const cmds = [
      {
        type: 'StartAIOperation' as const,
        colonyId: E,
        kind: 'Probe' as const,
        rallyTileX: target.x,
        rallyTileY: target.y,
        fighterIds: cohort,
        issuedAtTick: world.tick,
      },
      {
        type: 'SetRallyPoint' as const,
        colonyId: E,
        tileX: target.x,
        tileY: target.y,
        issuedAtTick: world.tick,
      },
    ];
    tick(world, cmds);
    for (let t = 0; t < 250; t++) tick(world, []);
    return {
      world,
      cohort,
      others: ids.slice(3),
      target,
      home: { x: ee.surfaceTileX, y: ee.surfaceTileY },
    };
  }

  const dist = (world: WorldState, id: number, p: { x: number; y: number }): number =>
    Math.abs((world.ants.posX[id]! >> FP_SHIFT) - p.x) +
    Math.abs((world.ants.posY[id]! >> FP_SHIFT) - p.y);

  it('V64: the three recorded fighters go to the probe target; the rest stay sentries at home', () => {
    const { world, cohort, others, target, home } = probe(V64);
    expect(getAIStateForColony(world, E)!.state).toBe('Probing');
    for (const id of cohort)
      expect(dist(world, id, target), tileOf(world, id)).toBeLessThanOrEqual(3);
    for (const id of others) {
      expect(dist(world, id, home), tileOf(world, id)).toBeLessThanOrEqual(8);
      expect(world.ants.subTask[id]).toBe(FightingSubState.Holding);
    }
  }, 30_000);

  it('V63 (pinned): every fighter follows the probe', () => {
    const { world, cohort, others, target } = probe(V63);
    for (const id of [...cohort, ...others]) {
      expect(dist(world, id, target), tileOf(world, id)).toBeLessThanOrEqual(3);
    }
  }, 30_000);
});
