// food.test.ts — PRD §6a pile pickup-charge shape unit tests + issue #112 fields
//
// Since #290 PR 2 (V50) the `FoodPile` interface is gone (piles live in the
// located food store, food/food-store.ts); `TestPile` from
// food/food-test-utils.ts is the same pre-V50 pickup-charge shape these tests
// checked, so they now exercise that instead.
//
// Run: npx vitest run src/sim/food.test.ts

import { describe, expect, it } from 'vitest';
import type { DepletionRecord, FoodPileId } from './food.js';
import type { TestPile } from './food/food-test-utils.js';

describe('TestPile (pickup-charge) shape', () => {
  it('can be constructed with all required fields including issue #112 charges', () => {
    const pile: TestPile = {
      foodPileId: 1 as FoodPileId,
      tileX: 24,
      tileY: 10,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    };
    expect(pile.foodPileId).toBe(1);
    expect(pile.tileX).toBe(24);
    expect(pile.tileY).toBe(10);
    expect(pile.pickupsRemaining).toBe(50);
    expect(pile.pickupsInitial).toBe(50);
  });

  it('FoodPileId is a number type', () => {
    const id: FoodPileId = 42;
    expect(typeof id).toBe('number');
  });

  it('two TestPile objects are independent', () => {
    const pile1: TestPile = {
      foodPileId: 1,
      tileX: 10,
      tileY: 20,
      pickupsRemaining: 30,
      pickupsInitial: 30,
    };
    const pile2: TestPile = {
      foodPileId: 2,
      tileX: 30,
      tileY: 40,
      pickupsRemaining: 100,
      pickupsInitial: 100,
    };
    expect(pile1.foodPileId).toBe(1);
    expect(pile2.foodPileId).toBe(2);
    expect(pile1.tileX).toBe(10);
    expect(pile2.tileX).toBe(30);
    // pickup-charge fields are independent per pile
    pile1.pickupsRemaining = 5;
    expect(pile2.pickupsRemaining).toBe(100);
  });

  it('pile objects do not carry a priority flag (priority lives on ColonyRecord per Phase 9)', () => {
    const pile: TestPile = {
      foodPileId: 5,
      tileX: 0,
      tileY: 0,
      pickupsRemaining: 20,
      pickupsInitial: 20,
    };
    expect(Object.prototype.hasOwnProperty.call(pile, 'isMarkedPriority')).toBe(false);
  });
});

describe('DepletionRecord interface (issue #112)', () => {
  it('captures tick + tile coordinates', () => {
    const r: DepletionRecord = { tick: 1234, tileX: 12, tileY: 34 };
    expect(r.tick).toBe(1234);
    expect(r.tileX).toBe(12);
    expect(r.tileY).toBe(34);
  });
});
