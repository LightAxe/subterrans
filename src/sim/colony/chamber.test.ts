// chamber.test.ts — PRD §2d PendingChamber and CHAMBER_DIMENSIONS unit tests
//
// Run: npx vitest run src/sim/colony/chamber.test.ts

import { describe, expect, it } from 'vitest';
import { ChamberType } from '../enums.js';
import { CHAMBER_DIMENSIONS } from './chamber.js';
import type { PendingChamber } from './chamber.js';

describe('CHAMBER_DIMENSIONS', () => {
  it('has entries for all 3 ChamberType values', () => {
    expect(CHAMBER_DIMENSIONS[ChamberType.Queen]).toBeDefined();
    expect(CHAMBER_DIMENSIONS[ChamberType.Nursery]).toBeDefined();
    expect(CHAMBER_DIMENSIONS[ChamberType.FoodStorage]).toBeDefined();
  });

  it('Queen chamber is 5×3 (PRD §2d)', () => {
    expect(CHAMBER_DIMENSIONS[ChamberType.Queen].width).toBe(5);
    expect(CHAMBER_DIMENSIONS[ChamberType.Queen].height).toBe(3);
  });

  it('Nursery chamber is 4×3 (PRD §2d)', () => {
    expect(CHAMBER_DIMENSIONS[ChamberType.Nursery].width).toBe(4);
    expect(CHAMBER_DIMENSIONS[ChamberType.Nursery].height).toBe(3);
  });

  it('FoodStorage chamber is 4×3 (PRD §2d)', () => {
    expect(CHAMBER_DIMENSIONS[ChamberType.FoodStorage].width).toBe(4);
    expect(CHAMBER_DIMENSIONS[ChamberType.FoodStorage].height).toBe(3);
  });

  it('keys are numeric (0, 1, 2)', () => {
    expect(CHAMBER_DIMENSIONS[0]).toBeDefined();
    expect(CHAMBER_DIMENSIONS[1]).toBeDefined();
    expect(CHAMBER_DIMENSIONS[2]).toBeDefined();
  });
});

describe('PendingChamber interface', () => {
  it('can be constructed with anchorTileX and anchorTileY (no chamberId field)', () => {
    const pending: PendingChamber = {
      colonyId: 1,
      chamberType: ChamberType.Queen,
      anchorTileX: 60,
      anchorTileY: 30,
      width: CHAMBER_DIMENSIONS[ChamberType.Queen].width,
      height: CHAMBER_DIMENSIONS[ChamberType.Queen].height,
    };
    expect(pending.anchorTileX).toBe(60);
    expect(pending.anchorTileY).toBe(30);
    expect(pending.colonyId).toBe(1);
    expect(pending.chamberType).toBe(ChamberType.Queen);
  });

  it('PendingChamber has no chamberId field', () => {
    const pending: PendingChamber = {
      colonyId: 1,
      chamberType: ChamberType.Nursery,
      anchorTileX: 50,
      anchorTileY: 20,
      width: 4,
      height: 3,
    };
    // chamberId must not exist on the object
    expect('chamberId' in pending).toBe(false);
  });

  it('can construct PendingChamber for FoodStorage', () => {
    const pending: PendingChamber = {
      colonyId: 2,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: 100,
      anchorTileY: 50,
      width: CHAMBER_DIMENSIONS[ChamberType.FoodStorage].width,
      height: CHAMBER_DIMENSIONS[ChamberType.FoodStorage].height,
    };
    expect(pending.chamberType).toBe(ChamberType.FoodStorage);
    expect(pending.width).toBe(4);
    expect(pending.height).toBe(3);
  });
});
