// ant-death.test.ts — #289: the single ant-death chokepoint.
//
// Every death gets the full cleanup whatever its cause (V41; the pre-V41 non-kill
// path was reaped once MIN_ACCEPTED passed V41). The tick()-driven liveness proof
// lives in determinism.test.ts.

import { describe, it, expect } from 'vitest';
import { despawnAnt, killAnt } from './ant-death.js';
import { createWorldState, allocateEntityId } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, NursingSubState } from './enums.js';
import { FP_SHIFT } from './fixed.js';
import { WORKER_BASE_SPEED, WORKER_LIFESPAN_TICKS } from './constants.js';
import { checkQueenDeath, GameOutcome } from './game-over.js';
import { pileCount } from './food/food-api.js';
import type { WorldState } from './types.js';
import type { ColonyId } from './colony/colony-store.js';

const CID = 1 as ColonyId;

/** One colony: a queen at (3,3), a Feeding nurse at (4,4) carrying a larva at (4,4).
 *  The larva's combat state is pre-polluted so a reset is observable, and
 *  broodFieldDirty is lowered after setup so a flag raise is observable. */
function makeWorld() {
  const world = createWorldState(7);
  const queen = allocateEntityId(world);
  initAnt(world.ants, queen, {
    colonyId: CID,
    posX: 3 << FP_SHIFT,
    posY: 3 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  const colony = createColonyRecord(CID, queen);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[CID] = colony;

  const nurse = allocateEntityId(world);
  initAnt(world.ants, nurse, {
    colonyId: CID,
    posX: 4 << FP_SHIFT,
    posY: 4 << FP_SHIFT,
    task: AntTask.Nursing,
    subTask: NursingSubState.Feeding,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  colony.workers.push(nurse);
  colony.workerCount = 1;

  const larva = allocateEntityId(world);
  initAnt(world.ants, larva, {
    colonyId: CID,
    posX: 4 << FP_SHIFT,
    posY: 4 << FP_SHIFT,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
    lifespan: WORKER_LIFESPAN_TICKS,
  });
  colony.larvae.push(larva);
  colony.larvaeCount = 1;
  world.ants.carryingBroodId[nurse] = larva;
  world.ants.carriedBy[larva] = nurse;
  world.ants.attackCooldown[larva] = 3;
  world.ants.combatOpponentId[larva] = 9;
  colony.broodFieldDirty = false;
  return { world, colony, queen, nurse, larva };
}

function combatKills(world: WorldState) {
  return world.events.filter((e) => e.type === 'combat_kill');
}

describe('#289 despawnAnt — non-kill deaths get the full cleanup', () => {
  it('starvation of a carried larva: clears both carry pointers, resets combat state, flags broodFieldDirty, no event / context / corpse', () => {
    const { world, colony, nurse, larva } = makeWorld();
    despawnAnt(world, larva, { cause: 'starvation' });
    expect(world.ants.alive[larva]).toBe(0);
    expect(world.ants.carryingBroodId[nurse]).toBe(-1);
    expect(world.ants.carriedBy[larva]).toBe(-1);
    expect(world.ants.attackCooldown[larva]).toBe(0);
    expect(world.ants.combatOpponentId[larva]).toBe(-1);
    expect(colony.broodFieldDirty).toBe(true);
    expect(combatKills(world)).toHaveLength(0);
    expect(world.pendingQueenDeathContexts[CID] ?? null).toBeNull();
    expect(pileCount(world)).toBe(0);
    expect(colony.killCount).toBe(0);
  });

  it('starvation of the queen: writes an Environment queen-death context at her tile and flags broodFieldDirty', () => {
    const { world, colony, queen } = makeWorld();
    despawnAnt(world, queen, { cause: 'starvation' });
    expect(world.ants.alive[queen]).toBe(0);
    expect(world.pendingQueenDeathContexts[CID]).toEqual({
      tile: { x: 3, y: 3 },
      currentGridColonyId: CID,
      killerColonyId: null,
      killerId: null,
      killerKind: 'Environment',
    });
    expect(colony.broodFieldDirty).toBe(true);
    expect(combatKills(world)).toHaveLength(0);
  });

  it('lifespan death of the carrier nurse orphans its larva (both pointers cleared) and flags broodFieldDirty', () => {
    const { world, colony, nurse, larva } = makeWorld();
    despawnAnt(world, nurse, { cause: 'lifespan' });
    expect(world.ants.alive[nurse]).toBe(0);
    expect(world.ants.alive[larva]).toBe(1);
    expect(world.ants.carryingBroodId[nurse]).toBe(-1);
    expect(world.ants.carriedBy[larva]).toBe(-1);
    expect(colony.broodFieldDirty).toBe(true);
    expect(world.pendingQueenDeathContexts[CID] ?? null).toBeNull();
  });
});

describe('#289 despawnAnt — the kill path', () => {
  it('killAnt: clears pointers, resets combat state, emits combat_kill, flags broodFieldDirty', () => {
    const { world, colony, nurse, larva } = makeWorld();
    killAnt(world, larva, 2 as ColonyId, 99, 'Ant');
    expect(world.ants.alive[larva]).toBe(0);
    expect(world.ants.carryingBroodId[nurse]).toBe(-1);
    expect(world.ants.carriedBy[larva]).toBe(-1);
    expect(world.ants.attackCooldown[larva]).toBe(0);
    expect(world.ants.combatOpponentId[larva]).toBe(-1);
    expect(colony.broodFieldDirty).toBe(true);
    expect(combatKills(world)).toHaveLength(1);
    expect(combatKills(world)[0]).toMatchObject({
      type: 'combat_kill',
      payload: {
        killer: { kind: 'Ant', id: 99, colonyId: 2 },
        victim: { kind: 'Ant', id: larva, colonyId: CID },
        location: { x: 4, y: 4, grid: 'surface' },
      },
    });
  });

  it("leaves the victim slot's identity and position fields untouched, for a kill and a starvation", () => {
    // Relocated from the deleted ant-store `killAnt` test. It matters because
    // game-over.ts reads the DEAD queen's posX/posY/zone for the queen_death
    // location, and any future on-death hook here will read the corpse's tile too.
    const killed = makeWorld();
    killed.world.ants.age[killed.larva] = 5;
    killAnt(killed.world, killed.larva, 2 as ColonyId, 99, 'Ant');
    expect(killed.world.ants.posX[killed.larva]).toBe(4 << FP_SHIFT);
    expect(killed.world.ants.posY[killed.larva]).toBe(4 << FP_SHIFT);
    expect(killed.world.ants.age[killed.larva]).toBe(5);
    expect(killed.world.ants.colonyId[killed.larva]).toBe(CID);
    expect(killed.world.ants.zone[killed.larva]).toBe(0);

    const starved = makeWorld();
    starved.world.ants.age[starved.queen] = 11;
    despawnAnt(starved.world, starved.queen, { cause: 'starvation' });
    expect(starved.world.ants.posX[starved.queen]).toBe(3 << FP_SHIFT);
    expect(starved.world.ants.posY[starved.queen]).toBe(3 << FP_SHIFT);
    expect(starved.world.ants.age[starved.queen]).toBe(11);
    expect(starved.world.ants.colonyId[starved.queen]).toBe(CID);
    expect(starved.world.ants.zone[starved.queen]).toBe(0);
  });

  it('a spider kill of the queen writes a Spider context (unchanged)', () => {
    const { world, queen } = makeWorld();
    killAnt(world, queen, null, null, 'Spider');
    expect(world.pendingQueenDeathContexts[CID]).toMatchObject({ killerKind: 'Spider' });
  });
});

describe('#289 checkQueenDeath — a starvation context reports as Starvation', () => {
  function starveQueen() {
    const { world, queen } = makeWorld();
    despawnAnt(world, queen, { cause: 'starvation' });
    const outcome = checkQueenDeath(world, CID);
    const queenDeath = world.events.find((e) => e.type === 'queen_death');
    return { world, outcome, queenDeath };
  }

  it('cause Starvation, location = queen tile, aiStateAtTime null, outcome Defeat', () => {
    const r = starveQueen();
    expect(r.outcome).toBe(GameOutcome.Defeat);
    expect(r.queenDeath).toMatchObject({
      type: 'queen_death',
      payload: {
        cause: 'Starvation',
        location: { x: 3, y: 3, grid: 'surface' },
        aiStateAtTime: null,
      },
    });
    // The V41 context is consumed the same tick, like a kill context.
    expect(r.world.pendingQueenDeathContexts[CID]).toBeNull();
  });
});
