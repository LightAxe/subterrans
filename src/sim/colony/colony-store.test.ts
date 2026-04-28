// colony-store.test.ts — Vitest tests for colony-store.ts (PRD §2)
//
// 11 tests covering Phase 2 fields:
//   (1)  Initial values from createColonyRecord
//   (2)  Empty bucket arrays
//   (3)  Fresh targetRatio per colony (independent mutation surface)
//   (4)  Fresh computedAllocation and taskCensus per colony
//   (5)  DEFAULT_BEHAVIOR_RATIO shape (forage=10, dig=0, fight=0)
//   (6)  createColonyStore plainness (no Map, plain Object)
//   (7)  Store assignment via integer key
//   (8)  ChamberRecord field types
//   (9)  taskCensus is 4-field WorkerAllocation (nurse/forage/dig/fight) — PRD §2 verbatim
//   (10) No idleCount field (regression guard against prior-revision drift)
//   (11) ColonyRecord Phase 2 factory returns 17 fields (Phase 3 extensions are undefined until caller assigns)
//
// Phase 3 PRD §2a caller-side init contract tests:
//   (12) Factory returns object where Phase 3 extension fields are undefined before caller assigns
//   (13) Caller-side assignment: independent entrances arrays and rallyPoint across colonies
//   (14) Phase 2 regression: independent bucket arrays/objects per colony (factory body unchanged guard)

import { describe, it, expect } from 'vitest';
import { ChamberType } from '../enums.js';
import { STARVATION_GRACE_TICKS, RECONCILE_INTERVAL_TICKS } from '../constants.js';
import {
  createColonyRecord,
  createColonyStore,
  type ChamberRecord,
} from './colony-store.js';

describe('createColonyRecord', () => {
  it('(1) initial values match PRD §2 factory defaults', () => {
    const r = createColonyRecord(1, 42);
    expect(r.colonyId).toBe(1);
    expect(r.queenEntityId).toBe(42);
    expect(r.foodStored).toBe(0);
    expect(r.workerCount).toBe(0);
    expect(r.eggCount).toBe(0);
    expect(r.larvaeCount).toBe(0);
    expect(r.nurseCount).toBe(0);
    expect(r.queenStarvationTimer).toBe(STARVATION_GRACE_TICKS); // 100
    expect(r.reconcileCountdown).toBe(RECONCILE_INTERVAL_TICKS); // 100
    expect(r.defeated).toBe(false);
  });

  it('(2) eggs, larvae, workers, chambers are empty arrays on a fresh record', () => {
    const r = createColonyRecord(1, 42);
    expect(Array.isArray(r.eggs)).toBe(true);
    expect(r.eggs.length).toBe(0);
    expect(Array.isArray(r.larvae)).toBe(true);
    expect(r.larvae.length).toBe(0);
    expect(Array.isArray(r.workers)).toBe(true);
    expect(r.workers.length).toBe(0);
    expect(Array.isArray(r.chambers)).toBe(true);
    expect(r.chambers.length).toBe(0);
  });

  it('(3) targetRatio is a fresh independent object per colony', () => {
    const a = createColonyRecord(1, 0);
    const b = createColonyRecord(2, 0);
    // Object identity must differ
    expect(a.targetRatio).not.toBe(b.targetRatio);
    // Mutating one does not affect the other
    a.targetRatio.forage = 0;
    expect(b.targetRatio.forage).toBe(10); // DEFAULT_BEHAVIOR_RATIO.forage = 10
  });

  it('(4) computedAllocation and taskCensus are independent fresh objects per colony', () => {
    const a = createColonyRecord(1, 0);
    const b = createColonyRecord(2, 0);
    // computedAllocation identity
    expect(a.computedAllocation).not.toBe(b.computedAllocation);
    // taskCensus identity
    expect(a.taskCensus).not.toBe(b.taskCensus);
    // Mutation isolation
    a.computedAllocation.nurse = 99;
    expect(b.computedAllocation.nurse).toBe(0);
    a.taskCensus.forage = 77;
    expect(b.taskCensus.forage).toBe(0);
  });

  it('(5) DEFAULT_BEHAVIOR_RATIO shape: forage=10, fight=0 (Phase 10 amendment, CTRL-01\')', () => {
    const r = createColonyRecord(1, 0);
    expect(r.targetRatio.forage).toBe(10);
    expect(r.targetRatio.fight).toBe(0);
    // dig field intentionally absent on BehaviorRatio post-Phase-10 (CTRL-06 owns dig).
    expect(Object.keys(r.targetRatio).sort()).toEqual(['fight', 'forage']);
  });

  it('(9) taskCensus has exactly the 4 WorkerAllocation fields from PRD §2 (nurse, forage, dig, fight)', () => {
    const r = createColonyRecord(1, 0);
    expect(Object.keys(r.taskCensus).sort()).toEqual(['dig', 'fight', 'forage', 'nurse']);
  });

  it('(10) no idleCount field on ColonyRecord (regression guard against prior-revision drift)', () => {
    const r = createColonyRecord(1, 0);
    expect('idleCount' in r).toBe(false);
  });

  it('(11) ColonyRecord Phase 2 factory returns 19 fields (17 Phase 2 + killCount + priorityFoodPileId; Phase 3 extensions are undefined until caller assigns)', () => {
    const r = createColonyRecord(1, 0);
    // Factory returns exactly 19 fields (17 Phase 2 + Phase 9 killCount + Phase 9 priorityFoodPileId)
    expect(Object.keys(r).length).toBe(19);
  });

  it('createColonyRecord initializes killCount to 0', () => {
    const c = createColonyRecord(1, 42);
    expect(c.killCount).toBe(0);
  });

  it('createColonyRecord initializes priorityFoodPileId to null (no default priority target)', () => {
    const c = createColonyRecord(1, 42);
    expect(c.priorityFoodPileId).toBeNull();
  });
});

describe('Phase 3 PRD §2a caller-side init contract', () => {
  it('(12) factory returns object where Phase 3 extension fields are undefined before caller assigns', () => {
    const colony = createColonyRecord(1, 42);
    // The factory intentionally does NOT set these — per PRD §2a extension contract
    expect((colony as unknown as Record<string, unknown>)['entrances']).toBeUndefined();
    expect((colony as unknown as Record<string, unknown>)['rallyPoint']).toBeUndefined();
    expect((colony as unknown as Record<string, unknown>)['digFlowFieldDirty']).toBeUndefined();
  });

  it('(13) caller-side assignment: independent entrances arrays and rallyPoint across colonies', () => {
    const a = createColonyRecord(1, 0);
    a.entrances = [];
    a.rallyPoint = null;
    a.digFlowFieldDirty = false;

    const b = createColonyRecord(2, 0);
    b.entrances = [];
    b.rallyPoint = null;
    b.digFlowFieldDirty = false;

    // entrances arrays are independent
    a.entrances.push({ entranceId: 1, surfaceTileX: 10, surfaceTileY: 64, isOpen: false });
    expect(b.entrances.length).toBe(0);

    // rallyPoint is independent
    a.rallyPoint = { tileX: 5, tileY: 10 };
    expect(b.rallyPoint).toBeNull();

    // digFlowFieldDirty is independent
    a.digFlowFieldDirty = true;
    expect(b.digFlowFieldDirty).toBe(false);
  });

  it('(14) Phase 2 regression: independent bucket arrays/objects per colony (factory body unchanged guard)', () => {
    const a = createColonyRecord(1, 0);
    const b = createColonyRecord(2, 0);

    // eggs, larvae, workers, chambers must be independent
    a.eggs.push(100);
    expect(b.eggs.length).toBe(0);

    a.larvae.push(200);
    expect(b.larvae.length).toBe(0);

    a.workers.push(300);
    expect(b.workers.length).toBe(0);

    a.chambers.push({ chamberId: 1, chamberType: 0, foodStored: 0, posX: 0, posY: 0, width: 5, height: 3 });
    expect(b.chambers.length).toBe(0);

    // targetRatio, computedAllocation, taskCensus must be independent objects
    a.targetRatio.forage = 99;
    expect(b.targetRatio.forage).toBe(10);

    a.computedAllocation.nurse = 77;
    expect(b.computedAllocation.nurse).toBe(0);

    a.taskCensus.dig = 55;
    expect(b.taskCensus.dig).toBe(0);
  });
});

describe('createColonyStore', () => {
  it('(6) returns a plain empty object — not a Map, not a subclass', () => {
    const store = createColonyStore();
    expect(Object.keys(store).length).toBe(0);
    expect(store instanceof Map).toBe(false);
    expect(store.constructor).toBe(Object);
  });

  it('(7) supports integer-key assignment and enumeration', () => {
    const store = createColonyStore();
    store[1] = createColonyRecord(1, 100);
    expect(Object.keys(store)).toEqual(['1']);
  });
});

describe('ChamberRecord', () => {
  it('(8) all fields are numeric (type-check-via-runtime — shape drift guard)', () => {
    const chamber: ChamberRecord = {
      chamberId:   1,
      chamberType: ChamberType.FoodStorage,
      foodStored:  0,
      posX:        512,
      posY:        256,
      width:       3,
      height:      3,
    };
    expect(typeof chamber.chamberId).toBe('number');
    expect(typeof chamber.chamberType).toBe('number');
    expect(typeof chamber.foodStored).toBe('number');
    expect(typeof chamber.posX).toBe('number');
    expect(typeof chamber.posY).toBe('number');
    expect(typeof chamber.width).toBe('number');
    expect(typeof chamber.height).toBe('number');
  });
});
