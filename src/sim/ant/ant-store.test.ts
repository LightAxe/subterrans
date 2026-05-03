// ant-store.test.ts — Vitest tests for AntComponents SoA and lifecycle helpers.
//
// Test grouping matches 06-VALIDATION.md "colony-stats" group.
// All tests run synchronously in < 10ms — no async, no allocations after setup.

import { describe, it, expect } from 'vitest';
import {
  createAntComponents,
  initAnt,
  killAnt,
  isAlive,
} from './ant-store.js';
import { AntTask, ForagingSubState } from '../enums.js';
import {
  MAX_ENTITIES,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../constants.js';

describe('ant-store', () => {
  // ---------------------------------------------------------------------------
  // 1. Allocation sizing
  // ---------------------------------------------------------------------------

  it('createAntComponents(8192) returns 11 Int32Arrays each of length 8192', () => {
    const ants = createAntComponents(8192);
    expect(ants.posX).toBeInstanceOf(Int32Array);
    expect(ants.posX.length).toBe(8192);
    expect(ants.posY).toBeInstanceOf(Int32Array);
    expect(ants.posY.length).toBe(8192);
    expect(ants.colonyId).toBeInstanceOf(Int32Array);
    expect(ants.colonyId.length).toBe(8192);
    expect(ants.task).toBeInstanceOf(Int32Array);
    expect(ants.task.length).toBe(8192);
    expect(ants.subTask).toBeInstanceOf(Int32Array);
    expect(ants.subTask.length).toBe(8192);
    expect(ants.speed).toBeInstanceOf(Int32Array);
    expect(ants.speed.length).toBe(8192);
    expect(ants.foodCarrying).toBeInstanceOf(Int32Array);
    expect(ants.foodCarrying.length).toBe(8192);
    expect(ants.starvationTimer).toBeInstanceOf(Int32Array);
    expect(ants.starvationTimer.length).toBe(8192);
    expect(ants.age).toBeInstanceOf(Int32Array);
    expect(ants.age.length).toBe(8192);
    expect(ants.alive).toBeInstanceOf(Int32Array);
    expect(ants.alive.length).toBe(8192);
    expect(ants.lifespan).toBeInstanceOf(Int32Array);
    expect(ants.lifespan.length).toBe(8192);
  });

  it('all 11 fields are zero-initialized after createAntComponents(8192)', () => {
    const ants = createAntComponents(8192);
    // Spot-check a few slots — Int32Array spec guarantees all zeros
    expect(ants.posX[0]).toBe(0);
    expect(ants.posY[4000]).toBe(0);
    expect(ants.alive[8191]).toBe(0);
    expect(ants.lifespan[1]).toBe(0);
    expect(ants.task[500]).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Default MAX_ENTITIES
  // ---------------------------------------------------------------------------

  it('createAntComponents() with no argument uses MAX_ENTITIES (8192)', () => {
    const ants = createAntComponents();
    expect(MAX_ENTITIES).toBe(8192); // guard: constant matches expectation
    expect(ants.posX.length).toBe(MAX_ENTITIES);
    expect(ants.alive.length).toBe(MAX_ENTITIES);
  });

  // ---------------------------------------------------------------------------
  // 3. Field independence (SoA correctness)
  // ---------------------------------------------------------------------------

  it('writing posX[5] does NOT affect posY[5] (SoA field independence)', () => {
    const ants = createAntComponents(16);
    ants.posX[5] = 100;
    expect(ants.posY[5]).toBe(0);
    expect(ants.colonyId[5]).toBe(0);
    expect(ants.task[5]).toBe(0);
    expect(ants.alive[5]).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 4. Independence across allocations
  // ---------------------------------------------------------------------------

  it('separate createAntComponents() calls produce independent arrays', () => {
    const a = createAntComponents(4);
    const b = createAntComponents(4);
    a.posX[0] = 7;
    expect(b.posX[0]).toBe(0); // b is not shared with a
    b.alive[2] = 1;
    expect(a.alive[2]).toBe(0); // a not affected by b
  });

  // ---------------------------------------------------------------------------
  // 5. initAnt — required fields + defaults
  // ---------------------------------------------------------------------------

  it('initAnt with required fields sets correct defaults', () => {
    const ants = createAntComponents(16);
    const id = 3;
    initAnt(ants, id, { colonyId: 1, posX: 512, posY: 256 });

    expect(ants.colonyId[id]).toBe(1);
    expect(ants.posX[id]).toBe(512);
    expect(ants.posY[id]).toBe(256);
    // Defaults
    expect(ants.task[id]).toBe(AntTask.Idle); // 0
    expect(ants.subTask[id]).toBe(0);
    expect(ants.speed[id]).toBe(WORKER_BASE_SPEED); // 128
    expect(ants.lifespan[id]).toBe(WORKER_LIFESPAN_TICKS); // 0x7FFFFFFF
    // Always-reset fields
    expect(ants.alive[id]).toBe(1);
    expect(ants.age[id]).toBe(0);
    expect(ants.foodCarrying[id]).toBe(0);
    expect(ants.starvationTimer[id]).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 6. initAnt — with overrides
  // ---------------------------------------------------------------------------

  it('initAnt with overrides applies the overridden values', () => {
    const ants = createAntComponents(16);
    const id = 7;
    initAnt(ants, id, {
      colonyId: 1,
      posX: 0,
      posY: 0,
      task: AntTask.Foraging,
      subTask: ForagingSubState.SearchingFood,
      speed: 64,
    });

    expect(ants.task[id]).toBe(AntTask.Foraging);        // 1
    expect(ants.subTask[id]).toBe(ForagingSubState.SearchingFood); // 0
    expect(ants.speed[id]).toBe(64);
    // alive still set to 1
    expect(ants.alive[id]).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 7. killAnt — flips alive, leaves other fields untouched
  // ---------------------------------------------------------------------------

  it('killAnt flips alive[id] to 0 and leaves other fields untouched', () => {
    const ants = createAntComponents(16);
    const id = 2;
    initAnt(ants, id, { colonyId: 1, posX: 42, posY: 99 });
    // Advance age to a non-zero value for the "untouched" check
    ants.age[id] = 5;

    killAnt(ants, id);

    expect(ants.alive[id]).toBe(0);
    // Other fields survive
    expect(ants.posX[id]).toBe(42);
    expect(ants.posY[id]).toBe(99);
    expect(ants.age[id]).toBe(5);
    expect(ants.colonyId[id]).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 8. isAlive — mirrors alive field
  // ---------------------------------------------------------------------------

  it('isAlive returns true for initialized ant, false after killAnt, false for uninitialized slot', () => {
    const ants = createAntComponents(16);
    const id = 10;

    // Never-initialized slot
    expect(isAlive(ants, id)).toBe(false);

    // After init
    initAnt(ants, id, { colonyId: 1, posX: 0, posY: 0 });
    expect(isAlive(ants, id)).toBe(true);

    // After kill
    killAnt(ants, id);
    expect(isAlive(ants, id)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 9. Repeated initAnt on same id — overwrites, no accumulation
  // ---------------------------------------------------------------------------

  it('calling initAnt twice on the same id overwrites fields (no accumulation)', () => {
    const ants = createAntComponents(16);
    const id = 0;

    initAnt(ants, id, { colonyId: 1, posX: 100, posY: 200, speed: 64 });
    // Manually age the ant to verify age reset
    ants.age[id] = 999;
    ants.foodCarrying[id] = 512;

    // Second init overwrites
    initAnt(ants, id, { colonyId: 2, posX: 50, posY: 75 });

    expect(ants.colonyId[id]).toBe(2);
    expect(ants.posX[id]).toBe(50);
    expect(ants.posY[id]).toBe(75);
    expect(ants.speed[id]).toBe(WORKER_BASE_SPEED); // back to default
    expect(ants.age[id]).toBe(0);                   // reset by initAnt
    expect(ants.foodCarrying[id]).toBe(0);           // reset by initAnt
    expect(ants.alive[id]).toBe(1);                  // stays 1
  });

  // ---------------------------------------------------------------------------
  // 10. Phase 7 — 17-field allocation verification
  // ---------------------------------------------------------------------------

  it('createAntComponents(64) returns object with all 17 keys, each Int32Array of length 64', () => {
    const ants = createAntComponents(64);
    const fields: Array<keyof typeof ants> = [
      'posX', 'posY', 'colonyId', 'task', 'subTask', 'speed',
      'foodCarrying', 'starvationTimer', 'age', 'alive', 'lifespan',
      'zone', 'digTileX', 'digTileY', 'digTicksRemaining', 'targetPosX', 'targetPosY',
    ];
    expect(fields.length).toBe(17);
    for (const field of fields) {
      expect(ants[field], `${field} should be Int32Array`).toBeInstanceOf(Int32Array);
      expect(ants[field].length, `${field}.length should be 64`).toBe(64);
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Phase 7 — correct default values after createAntComponents
  // ---------------------------------------------------------------------------

  it('Phase 7 fields have correct defaults after createAntComponents(64)', () => {
    const ants = createAntComponents(64);
    const indices = [0, 31, 63];
    for (const i of indices) {
      expect(ants.zone[i],              `zone[${i}] should be 0 (Surface)`).toBe(0);
      expect(ants.digTileX[i],          `digTileX[${i}] should be -1`).toBe(-1);
      expect(ants.digTileY[i],          `digTileY[${i}] should be -1`).toBe(-1);
      expect(ants.digTicksRemaining[i], `digTicksRemaining[${i}] should be 0`).toBe(0);
      expect(ants.targetPosX[i],        `targetPosX[${i}] should be -1`).toBe(-1);
      expect(ants.targetPosY[i],        `targetPosY[${i}] should be -1`).toBe(-1);
    }
  });

  // ---------------------------------------------------------------------------
  // 12. Phase 7 — initAnt Phase 7 defaults (no zone override)
  // ---------------------------------------------------------------------------

  it('initAnt with minimal spec sets Phase 7 field defaults', () => {
    const ants = createAntComponents(16);
    const id = 5;
    initAnt(ants, id, { colonyId: 1, posX: 100, posY: 200 });

    expect(ants.zone[id]).toBe(0);              // Surface
    expect(ants.digTileX[id]).toBe(-1);         // no claimed tile
    expect(ants.digTileY[id]).toBe(-1);         // no claimed tile
    expect(ants.digTicksRemaining[id]).toBe(0); // not digging
    expect(ants.targetPosX[id]).toBe(-1);       // no target
    expect(ants.targetPosY[id]).toBe(-1);       // no target
  });

  // ---------------------------------------------------------------------------
  // 13. Phase 7 — initAnt zone override
  // ---------------------------------------------------------------------------

  it('initAnt with zone: 1 sets zone to Underground', () => {
    const ants = createAntComponents(16);
    const id = 8;
    initAnt(ants, id, { colonyId: 1, posX: 0, posY: 0, zone: 1 });

    expect(ants.zone[id]).toBe(1); // Underground
    // Other Phase 7 fields still correct
    expect(ants.digTileX[id]).toBe(-1);
    expect(ants.targetPosX[id]).toBe(-1);
  });

  // ---------------------------------------------------------------------------
  // 14. Phase 7 — field independence for Phase 7 fields
  // ---------------------------------------------------------------------------

  it('writing zone[5] does not affect digTileX[5] or posX[5]', () => {
    const ants = createAntComponents(16);
    // digTileX and posX start at -1 and 0 respectively (no initAnt needed)
    ants.zone[5] = 1;
    expect(ants.digTileX[5]).toBe(-1); // still sentinel
    expect(ants.posX[5]).toBe(0);      // unchanged
  });

  // ---------------------------------------------------------------------------
  // 15. Phase 7 — cross-allocation independence for Phase 7 fields
  // ---------------------------------------------------------------------------

  it('two createAntComponents() results have independent Phase 7 arrays', () => {
    const a = createAntComponents(4);
    const b = createAntComponents(4);
    a.zone[0] = 1;
    expect(b.zone[0]).toBe(0); // b.zone not affected
    a.digTileX[0] = 99;
    expect(b.digTileX[0]).toBe(-1); // b.digTileX not affected
  });

  // ---------------------------------------------------------------------------
  // 16. Phase 09.1 — currentGridColonyId (grid-of-occupancy byte, Chunk 0)
  //
  // currentGridColonyId: Uint8Array is the single source of truth for "which
  // underground grid does this ant occupy right now." Today every ant's
  // currentGridColonyId === colonyId (no invasion yet). Chunks 3+4 break that
  // invariant for Fighter invaders in enemy grids.
  //
  // Invariant at spawn: currentGridColonyId[id] === spec.colonyId (initAnt).
  // ---------------------------------------------------------------------------

  it('createAntComponents allocates currentGridColonyId as a Uint8Array of the capacity length', () => {
    const ants = createAntComponents(64);
    expect(ants.currentGridColonyId).toBeInstanceOf(Uint8Array);
    expect(ants.currentGridColonyId.length).toBe(64);
  });

  it('initAnt sets currentGridColonyId[id] = spec.colonyId (grid-of-occupancy matches owning colony at spawn)', () => {
    const ants = createAntComponents(16);
    const id = 4;
    initAnt(ants, id, { colonyId: 1, posX: 0, posY: 0 });

    expect(ants.currentGridColonyId[id]).toBe(1);
  });

  it('killAnt then initAnt on the same slot produces currentGridColonyId matching the new colonyId (slot recycle hygiene)', () => {
    const ants = createAntComponents(16);
    const id = 9;

    // First life: colony 1 occupies the slot.
    initAnt(ants, id, { colonyId: 1, posX: 0, posY: 0 });
    expect(ants.currentGridColonyId[id]).toBe(1);

    // Kill and recycle as colony 0.
    killAnt(ants, id);
    initAnt(ants, id, { colonyId: 0, posX: 0, posY: 0 });

    expect(ants.currentGridColonyId[id]).toBe(0);
  });

  // Issue #17 Phase 1 — visible brood carry slot fields.
  it('createAntComponents fills carryingBroodId and carriedBy with -1', () => {
    const ants = createAntComponents(16);
    for (let i = 0; i < 16; i++) {
      expect(ants.carryingBroodId[i]).toBe(-1);
      expect(ants.carriedBy[i]).toBe(-1);
    }
  });

  it('initAnt resets carryingBroodId and carriedBy to -1', () => {
    const ants = createAntComponents(16);
    const id = 5;
    // Pre-pollute both slots so the reset is observable.
    ants.carryingBroodId[id] = 7;
    ants.carriedBy[id] = 3;
    initAnt(ants, id, { colonyId: 1, posX: 0, posY: 0 });
    expect(ants.carryingBroodId[id]).toBe(-1);
    expect(ants.carriedBy[id]).toBe(-1);
  });

  it('killAnt does NOT clear carryingBroodId or carriedBy (death-drop behaviour: brood stays carried-by-id until next nurse claim)', () => {
    const ants = createAntComponents(16);
    const nurseId = 4;
    const broodId = 7;
    initAnt(ants, nurseId, { colonyId: 1, posX: 0, posY: 0 });
    initAnt(ants, broodId, { colonyId: 1, posX: 0, posY: 0 });
    ants.carryingBroodId[nurseId] = broodId;
    ants.carriedBy[broodId] = nurseId;
    killAnt(ants, nurseId);
    // Death cleanup is up to the runtime (tickNurseActions / death sweep) —
    // killAnt itself is O(1) and only zeroes `alive`.
    expect(ants.carryingBroodId[nurseId]).toBe(broodId);
    expect(ants.carriedBy[broodId]).toBe(nurseId);
  });
});
