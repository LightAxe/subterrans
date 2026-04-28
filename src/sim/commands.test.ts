import { describe, it, expect } from 'vitest';
import {
  type SimCommand,
  type NoOpCommand,
  type SetBehaviorRatioCommand,
  type MarkDigTileCommand,
  type MarkFoodPileCommand,
  type CancelDigMarkCommand,
  type PlaceChamberCommand,
  type DesignateEntranceCommand,
  type SetRallyPointCommand,
  type ClearRallyPointCommand,
  MAX_COMMANDS_PER_TICK,
} from './commands.js';
import { ChamberType } from './enums.js';

describe('SimCommand', () => {
  describe('NoOpCommand assignability', () => {
    it('NoOpCommand literal is assignable to SimCommand', () => {
      const cmd: SimCommand = { type: 'NoOp', issuedAtTick: 0 };
      expect(cmd.type).toBe('NoOp');
      expect(cmd.issuedAtTick).toBe(0);
    });

    it('NoOpCommand has type discriminant "NoOp"', () => {
      const cmd: NoOpCommand = { type: 'NoOp', issuedAtTick: 42 };
      expect(cmd.type).toBe('NoOp');
      expect(cmd.issuedAtTick).toBe(42);
    });
  });

  describe('SetBehaviorRatioCommand', () => {
    it('can be constructed with correct type literal and fields', () => {
      const cmd: SetBehaviorRatioCommand = {
        type: 'SetBehaviorRatio',
        colonyId: 1,
        ratio: { forage: 7, fight: 1 },
        issuedAtTick: 10,
      };
      expect(cmd.type).toBe('SetBehaviorRatio');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.ratio.forage).toBe(7);
      expect(cmd.ratio.fight).toBe(1);
      expect(cmd.issuedAtTick).toBe(10);
    });

    it('is assignable to SimCommand union', () => {
      const cmd: SimCommand = {
        type: 'SetBehaviorRatio',
        colonyId: 2,
        ratio: { forage: 10, fight: 0 },
        issuedAtTick: 5,
      };
      expect(cmd.type).toBe('SetBehaviorRatio');
    });
  });

  describe('MarkDigTileCommand', () => {
    it('can be constructed with correct type literal and fields', () => {
      const cmd: MarkDigTileCommand = {
        type: 'MarkDigTile',
        colonyId: 1,
        tileX: 10,
        tileY: 20,
        issuedAtTick: 15,
      };
      expect(cmd.type).toBe('MarkDigTile');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.tileX).toBe(10);
      expect(cmd.tileY).toBe(20);
      expect(cmd.issuedAtTick).toBe(15);
    });

    it('is assignable to SimCommand union', () => {
      const cmd: SimCommand = {
        type: 'MarkDigTile',
        colonyId: 3,
        tileX: 5,
        tileY: 8,
        issuedAtTick: 3,
      };
      expect(cmd.type).toBe('MarkDigTile');
    });
  });

  describe('MarkFoodPileCommand', () => {
    it('can be constructed with correct type literal and fields', () => {
      const cmd: MarkFoodPileCommand = {
        type: 'MarkFoodPile',
        colonyId: 1,
        tileX: 32,
        tileY: 64,
        issuedAtTick: 7,
      };
      expect(cmd.type).toBe('MarkFoodPile');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.tileX).toBe(32);
      expect(cmd.tileY).toBe(64);
      expect(cmd.issuedAtTick).toBe(7);
    });

    it('is assignable to SimCommand union', () => {
      const cmd: SimCommand = {
        type: 'MarkFoodPile',
        colonyId: 4,
        tileX: 15,
        tileY: 30,
        issuedAtTick: 9,
      };
      expect(cmd.type).toBe('MarkFoodPile');
    });
  });

  describe('CancelDigMarkCommand', () => {
    it('can be constructed with correct type literal and fields', () => {
      const cmd: CancelDigMarkCommand = {
        type: 'CancelDigMark',
        colonyId: 1,
        tileX: 15,
        tileY: 25,
        issuedAtTick: 20,
      };
      expect(cmd.type).toBe('CancelDigMark');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.tileX).toBe(15);
      expect(cmd.tileY).toBe(25);
      expect(cmd.issuedAtTick).toBe(20);
    });

    it('is assignable to SimCommand union', () => {
      const cmd: SimCommand = {
        type: 'CancelDigMark',
        colonyId: 2,
        tileX: 10,
        tileY: 20,
        issuedAtTick: 5,
      };
      expect(cmd.type).toBe('CancelDigMark');
    });
  });

  describe('PlaceChamberCommand', () => {
    it('can be constructed with correct type literal and fields', () => {
      const cmd: PlaceChamberCommand = {
        type: 'PlaceChamber',
        colonyId: 1,
        chamberType: ChamberType.Nursery,
        anchorTileX: 8,
        anchorTileY: 12,
        issuedAtTick: 30,
      };
      expect(cmd.type).toBe('PlaceChamber');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.chamberType).toBe(ChamberType.Nursery);
      expect(cmd.anchorTileX).toBe(8);
      expect(cmd.anchorTileY).toBe(12);
      expect(cmd.issuedAtTick).toBe(30);
    });

    it('is assignable to SimCommand union', () => {
      const cmd: SimCommand = {
        type: 'PlaceChamber',
        colonyId: 1,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: 5,
        anchorTileY: 10,
        issuedAtTick: 7,
      };
      expect(cmd.type).toBe('PlaceChamber');
    });
  });

  describe('DesignateEntranceCommand', () => {
    it('can be constructed with correct type literal and fields', () => {
      const cmd: DesignateEntranceCommand = {
        type: 'DesignateEntrance',
        colonyId: 1,
        surfaceTileX: 24,
        surfaceTileY: 64,
        issuedAtTick: 50,
      };
      expect(cmd.type).toBe('DesignateEntrance');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.surfaceTileX).toBe(24);
      expect(cmd.surfaceTileY).toBe(64);
      expect(cmd.issuedAtTick).toBe(50);
    });

    it('is assignable to SimCommand union', () => {
      const cmd: SimCommand = {
        type: 'DesignateEntrance',
        colonyId: 2,
        surfaceTileX: 104,
        surfaceTileY: 64,
        issuedAtTick: 12,
      };
      expect(cmd.type).toBe('DesignateEntrance');
    });
  });

  describe('discriminated union type narrowing', () => {
    it('9-variant exhaustive switch: all variants handled, default never arm compiles', () => {
      // This function's type correctness is validated by TypeScript at compile time.
      // The runtime test verifies the discriminant values are correct for all 9 variants.
      function handleCommand(cmd: SimCommand): string {
        switch (cmd.type) {
          case 'NoOp':
            return `noop@${cmd.issuedAtTick}`;
          case 'SetBehaviorRatio':
            return `ratio:${cmd.colonyId}`;
          case 'MarkDigTile':
            return `dig:${cmd.tileX},${cmd.tileY}`;
          case 'MarkFoodPile':
            return `food:${cmd.tileX},${cmd.tileY}`;
          case 'CancelDigMark':
            return `cancel:${cmd.tileX},${cmd.tileY}`;
          case 'PlaceChamber':
            return `chamber:${cmd.anchorTileX},${cmd.anchorTileY}:type${cmd.chamberType}`;
          case 'DesignateEntrance':
            return `entrance:${cmd.surfaceTileX},${cmd.surfaceTileY}`;
          case 'SetRallyPoint':
            return `rally:${cmd.colonyId}:${cmd.tileX},${cmd.tileY}`;
          case 'ClearRallyPoint':
            return `clearrally:${cmd.colonyId}`;
          default: {
            // Exhaustive check — TypeScript will error here if a variant is unhandled
            const _exhaustive: never = cmd;
            return _exhaustive;
          }
        }
      }

      expect(handleCommand({ type: 'NoOp', issuedAtTick: 0 })).toBe('noop@0');
      expect(handleCommand({ type: 'SetBehaviorRatio', colonyId: 1, ratio: { forage: 5, fight: 2 }, issuedAtTick: 1 })).toBe('ratio:1');
      expect(handleCommand({ type: 'MarkDigTile', colonyId: 1, tileX: 4, tileY: 8, issuedAtTick: 2 })).toBe('dig:4,8');
      expect(handleCommand({ type: 'MarkFoodPile', colonyId: 1, tileX: 12, tileY: 16, issuedAtTick: 3 })).toBe('food:12,16');
      expect(handleCommand({ type: 'CancelDigMark', colonyId: 1, tileX: 5, tileY: 9, issuedAtTick: 4 })).toBe('cancel:5,9');
      expect(handleCommand({ type: 'PlaceChamber', colonyId: 1, chamberType: ChamberType.Queen, anchorTileX: 3, anchorTileY: 7, issuedAtTick: 5 })).toBe('chamber:3,7:type0');
      expect(handleCommand({ type: 'DesignateEntrance', colonyId: 1, surfaceTileX: 20, surfaceTileY: 64, issuedAtTick: 6 })).toBe('entrance:20,64');
      expect(handleCommand({ type: 'SetRallyPoint', colonyId: 1, tileX: 10, tileY: 20, issuedAtTick: 7 })).toBe('rally:1:10,20');
      expect(handleCommand({ type: 'ClearRallyPoint', colonyId: 1, issuedAtTick: 8 })).toBe('clearrally:1');
    });
  });

  describe('SetRallyPointCommand / ClearRallyPointCommand shape', () => {
    it('SetRallyPointCommand has issuedAtTick (extends SimCommandBase)', () => {
      const cmd: SetRallyPointCommand = {
        type: 'SetRallyPoint',
        colonyId: 1,
        tileX: 5,
        tileY: 7,
        issuedAtTick: 42,
      };
      expect(cmd.type).toBe('SetRallyPoint');
      expect(cmd.colonyId).toBe(1);
      expect(cmd.tileX).toBe(5);
      expect(cmd.tileY).toBe(7);
      expect(cmd.issuedAtTick).toBe(42);
    });

    it('ClearRallyPointCommand has issuedAtTick (extends SimCommandBase)', () => {
      const cmd: ClearRallyPointCommand = {
        type: 'ClearRallyPoint',
        colonyId: 2,
        issuedAtTick: 42,
      };
      expect(cmd.type).toBe('ClearRallyPoint');
      expect(cmd.colonyId).toBe(2);
      expect(cmd.issuedAtTick).toBe(42);
    });

    it('both are assignable to SimCommand union (9 variants)', () => {
      const a: SimCommand = { type: 'SetRallyPoint', colonyId: 1, tileX: 3, tileY: 9, issuedAtTick: 0 };
      const b: SimCommand = { type: 'ClearRallyPoint', colonyId: 1, issuedAtTick: 0 };
      expect(a.type).toBe('SetRallyPoint');
      expect(b.type).toBe('ClearRallyPoint');
    });
  });

  describe('MAX_COMMANDS_PER_TICK', () => {
    it('MAX_COMMANDS_PER_TICK is exactly 64', () => {
      expect(MAX_COMMANDS_PER_TICK).toBe(64);
    });

    it('an array of 64 NoOpCommands has length 64', () => {
      const cmds: SimCommand[] = Array.from({ length: 64 }, (_, i) => ({
        type: 'NoOp' as const,
        issuedAtTick: i,
      }));
      expect(cmds.length).toBe(64);
    });
  });
});
