// entrance.test.ts — PRD §3 NestEntrance interface unit tests
//
// Run: npx vitest run src/sim/colony/entrance.test.ts

import { describe, expect, it } from 'vitest';
import type { NestEntrance, NestEntranceId } from './entrance.js';

describe('NestEntrance interface', () => {
  it('can be constructed with isOpen=false (default closed state)', () => {
    const entrance: NestEntrance = {
      entranceId: 1 as NestEntranceId,
      surfaceTileX: 64,
      surfaceTileY: 64,
      isOpen: false,
    };
    expect(entrance.entranceId).toBe(1);
    expect(entrance.surfaceTileX).toBe(64);
    expect(entrance.surfaceTileY).toBe(64);
    expect(entrance.isOpen).toBe(false);
  });

  it('isOpen can be set to true', () => {
    const entrance: NestEntrance = {
      entranceId: 2 as NestEntranceId,
      surfaceTileX: 24,
      surfaceTileY: 24,
      isOpen: true,
    };
    expect(entrance.isOpen).toBe(true);
  });

  it('NestEntranceId is a number type', () => {
    const id: NestEntranceId = 99;
    expect(typeof id).toBe('number');
  });

  it('two NestEntrance objects are independent', () => {
    const e1: NestEntrance = { entranceId: 1, surfaceTileX: 10, surfaceTileY: 10, isOpen: false };
    const e2: NestEntrance = { entranceId: 2, surfaceTileX: 20, surfaceTileY: 20, isOpen: true };
    expect(e1.isOpen).toBe(false);
    expect(e2.isOpen).toBe(true);
    expect(e1.entranceId).not.toBe(e2.entranceId);
  });
});
