// #332 (V47) — surplus sentries stand down to Idle when the colony has more
// fighters than its ratio allocates. Only settled sentries (Holding, target -1,
// on the surface) go, highest entity id first, and never under orders.
import { describe, it, expect } from 'vitest';
import { standDownSurplusSentries } from './ant/ant-system.js';
import { createScenario } from './scenario.js';
import { tick } from './tick.js';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE,
  SIM_VERSION_V47_SENTRY_STAND_DOWN,
  type WorldState,
} from './types.js';
import { createColonyRecord, type ColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, FightingSubState } from './enums.js';
import { Zone } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { PLAYER_COLONY_ID, WORKER_BASE_SPEED, WORKER_LIFESPAN_TICKS } from './constants.js';

const COLONY_ID = 1;

function world(version: number = SIM_VERSION_V47_SENTRY_STAND_DOWN): {
  world: WorldState;
  colony: ColonyRecord;
} {
  const w = createWorldState(42, 64);
  w.simVersion = version;
  const colony = createColonyRecord(COLONY_ID, -1);
  colony.entrances = [{ entranceId: 1, surfaceTileX: 40, surfaceTileY: 40, isOpen: true }];
  colony.rallyPoint = null;
  w.colonies[COLONY_ID] = colony;
  return { world: w, colony };
}

/** A sentry holding its post (Holding, target -1) unless told otherwise. */
function addFighter(
  w: WorldState,
  colony: ColonyRecord,
  opts: { subTask?: number; target?: number; zone?: number } = {},
): number {
  const id = allocateEntityId(w);
  initAnt(w.ants, id, {
    colonyId: colony.colonyId,
    posX: (43 << FP_SHIFT) + (FP_ONE >> 1),
    posY: (40 << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: opts.subTask ?? FightingSubState.Holding,
  });
  w.ants.targetPosX[id] = opts.target ?? -1;
  w.ants.targetPosY[id] = opts.target ?? -1;
  w.ants.zone[id] = opts.zone ?? Zone.Surface;
  colony.workers.push(id);
  return id;
}

const tasks = (w: WorldState, ids: number[]): number[] => ids.map((id) => w.ants.task[id]!);

describe('standDownSurplusSentries (V47, #332)', () => {
  it('releases all but one of the surplus, highest entity id first, whatever the workers order', () => {
    const { world: w, colony } = world();
    const ids = [0, 1, 2, 3, 4, 5].map(() => addFighter(w, colony));
    colony.workers = [ids[3]!, ids[0]!, ids[5]!, ids[1]!, ids[4]!, ids[2]!]; // swap-removes reorder it
    colony.computedAllocation.fight = 2; // surplus 4: three go, one spare stays
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids)).toEqual([
      AntTask.Fighting,
      AntTask.Fighting,
      AntTask.Fighting,
      AntTask.Idle,
      AntTask.Idle,
      AntTask.Idle,
    ]);
    for (const id of ids.slice(3)) expect(w.ants.subTask[id]).toBe(0);
  });

  it('keeps one spare: a surplus of one (allocation wobble) releases nobody', () => {
    const { world: w, colony } = world();
    const ids = [0, 1, 2].map(() => addFighter(w, colony));
    colony.computedAllocation.fight = 2;
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids)).toEqual([AntTask.Fighting, AntTask.Fighting, AntTask.Fighting]);
  });

  it('releases nobody when the colony has no more fighters than it allocates', () => {
    const { world: w, colony } = world();
    const ids = [0, 1, 2].map(() => addFighter(w, colony));
    colony.computedAllocation.fight = 3;
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids)).toEqual([AntTask.Fighting, AntTask.Fighting, AntTask.Fighting]);
  });

  it('counts every fighter toward the surplus but releases only settled sentries', () => {
    const { world: w, colony } = world();
    const walking = addFighter(w, colony, {
      subTask: FightingSubState.ToPost,
      target: 44 << FP_SHIFT,
    });
    const chasing = addFighter(w, colony, {
      subTask: FightingSubState.MovingToRally,
      target: 50 << FP_SHIFT,
    });
    const below = addFighter(w, colony, { zone: Zone.Underground });
    const staleHold = addFighter(w, colony, { target: 44 << FP_SHIFT }); // Holding but retargeted
    const holder = addFighter(w, colony);
    colony.computedAllocation.fight = 0; // three over and more, but only one settled sentry
    standDownSurplusSentries(w, colony);
    expect(tasks(w, [walking, chasing, below, staleHold, holder])).toEqual([
      AntTask.Fighting,
      AntTask.Fighting,
      AntTask.Fighting,
      AntTask.Fighting,
      AntTask.Idle,
    ]);
  });

  it('does not release a fighter with no target that is not holding a post (e.g. newly promoted)', () => {
    const { world: w, colony } = world();
    const fresh = [0, 1].map(() =>
      addFighter(w, colony, { subTask: FightingSubState.MovingToRally }),
    );
    colony.computedAllocation.fight = 0;
    standDownSurplusSentries(w, colony);
    expect(tasks(w, fresh)).toEqual([AntTask.Fighting, AntTask.Fighting]);
  });

  it('does not release a holder already paired in combat (an ant, or the spider windup)', () => {
    const { world: w, colony } = world();
    const ids = [0, 1, 2, 3].map(() => addFighter(w, colony));
    w.ants.combatOpponentId[ids[3]!] = 50; // paired with an enemy ant
    w.ants.combatOpponentId[ids[2]!] = -2; // the spider is winding up on it
    colony.computedAllocation.fight = 0; // three over: two could go
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids)).toEqual([AntTask.Idle, AntTask.Idle, AntTask.Fighting, AntTask.Fighting]);
  });

  it("releases only its own colony's sentries", () => {
    const { world: w, colony } = world();
    const other = createColonyRecord(2, -1);
    other.entrances = [{ entranceId: 2, surfaceTileX: 80, surfaceTileY: 40, isOpen: true }];
    other.rallyPoint = null;
    w.colonies[2] = other;
    const mine = [0, 1, 2].map(() => addFighter(w, colony));
    const theirs = [0, 1, 2].map(() => addFighter(w, other)); // higher ids, no surplus of their own
    other.computedAllocation.fight = 3;
    colony.computedAllocation.fight = 0; // two of mine can go
    standDownSurplusSentries(w, colony);
    expect(tasks(w, mine)).toEqual([AntTask.Fighting, AntTask.Idle, AntTask.Idle]);
    expect(tasks(w, theirs)).toEqual([AntTask.Fighting, AntTask.Fighting, AntTask.Fighting]);
  });

  it('never takes a homebound forager (sub-state 2, no target) for a holder', () => {
    const { world: w, colony } = world();
    const fighters = [0, 1].map(() =>
      addFighter(w, colony, { subTask: FightingSubState.MovingToRally, target: 44 << FP_SHIFT }),
    );
    const forager = addFighter(w, colony); // Holding === ReturningToNest === 2
    w.ants.task[forager] = AntTask.Foraging;
    colony.computedAllocation.fight = 0;
    standDownSurplusSentries(w, colony);
    expect(w.ants.task[forager]).toBe(AntTask.Foraging);
    expect(tasks(w, fighters)).toEqual([AntTask.Fighting, AntTask.Fighting]);
  });

  it('skips a dead holder and releases the highest live one', () => {
    const { world: w, colony } = world();
    const ids = [0, 1, 2, 3].map(() => addFighter(w, colony));
    w.ants.alive[ids[3]!] = 0;
    colony.computedAllocation.fight = 1; // three alive: one goes
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids.slice(0, 3))).toEqual([AntTask.Fighting, AntTask.Fighting, AntTask.Idle]);
  });

  it('ignores dead fighters in the surplus count', () => {
    const { world: w, colony } = world();
    const ids = [0, 1, 2].map(() => addFighter(w, colony));
    w.ants.alive[ids[2]!] = 0;
    colony.computedAllocation.fight = 1; // two alive: one spare, nothing to release
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids.slice(0, 2))).toEqual([AntTask.Fighting, AntTask.Fighting]);
  });

  it('releases nobody while the colony is under orders', () => {
    const cases: Array<(w: WorldState, c: ColonyRecord) => void> = [
      (_w, c) => {
        c.rallyPoint = { tileX: 60, tileY: 40 };
      },
      (_w, c) => {
        c.alarmActive = true;
      },
      (w, c) => {
        w.spiderPriorityColonyId = c.colonyId;
      },
    ];
    for (const setOrders of cases) {
      const { world: w, colony } = world();
      const ids = [0, 1, 2].map(() => addFighter(w, colony));
      colony.computedAllocation.fight = 0;
      setOrders(w, colony);
      standDownSurplusSentries(w, colony);
      expect(tasks(w, ids)).toEqual([AntTask.Fighting, AntTask.Fighting, AntTask.Fighting]);
    }
  });

  it('pre-V47 (pinned V46): releases nobody', () => {
    const { world: w, colony } = world(SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE);
    const ids = [0, 1, 2].map(() => addFighter(w, colony));
    colony.computedAllocation.fight = 0;
    standDownSurplusSentries(w, colony);
    expect(tasks(w, ids)).toEqual([AntTask.Fighting, AntTask.Fighting, AntTask.Fighting]);
  });
});

describe('V47 (#332) through tick(): a war-sized garrison shrinks back to the ratio', () => {
  /** The player colony with 20 extra fighters at its entrance and a peacetime ratio. */
  function build(version: number): { world: WorldState; colony: ColonyRecord } {
    const w = createScenario(7, 'Normal');
    w.simVersion = version;
    w.spider = null;
    w.aiState = [];
    const colony = w.colonies[PLAYER_COLONY_ID]!;
    const ent = colony.entrances.find((e) => e.isOpen)!;
    for (let i = 0; i < 20; i++) {
      const id = allocateEntityId(w);
      initAnt(w.ants, id, {
        colonyId: PLAYER_COLONY_ID,
        posX: (ent.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1),
        posY: ((ent.surfaceTileY - 1) << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Fighting,
        subTask: FightingSubState.MovingToRally,
        speed: WORKER_BASE_SPEED,
        lifespan: WORKER_LIFESPAN_TICKS,
        zone: Zone.Surface,
      });
      colony.workers.push(id);
      colony.workerCount += 1;
    }
    colony.rallyPoint = null;
    colony.targetRatio.fight = 1;
    colony.targetRatio.forage = 9;
    return { world: w, colony };
  }

  const fighters = (w: WorldState, c: ColonyRecord): number =>
    c.workers.filter((id) => w.ants.alive[id] === 1 && w.ants.task[id] === AntTask.Fighting).length;

  function run(w: WorldState, n: number): void {
    for (let t = 0; t < n; t++) tick(w, w.commandQueue.splice(0));
  }

  it('V47: once they settle, fighters drop to the allocation and the rest go back to work', () => {
    const { world: w, colony } = build(SIM_VERSION_V47_SENTRY_STAND_DOWN);
    run(w, 400);
    expect(fighters(w, colony)).toBeLessThanOrEqual(colony.computedAllocation.fight + 1);
    const released = colony.workers.filter(
      (id) => w.ants.alive[id] === 1 && w.ants.task[id] === AntTask.Foraging,
    ).length;
    expect(released).toBeGreaterThan(10);
  });

  it('V46 (pinned): the same garrison stays fighters', () => {
    const { world: w, colony } = build(SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE);
    run(w, 400);
    expect(fighters(w, colony)).toBeGreaterThanOrEqual(20);
  });
});
