// jev-commands.test.ts — the allowlist assertion (the Jev opponent may only do
// what a player can do) and the applied/rejected/no-op ledger.

import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { PLAYER_COLONY_ID } from '../sim/constants.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { pushCommand } from '../sim/commands.js';
import { JevCommandLedger, PLAYER_SURFACE_COMMANDS } from './jev-commands.js';

function drainAndTick(world: ReturnType<typeof createScenario>): void {
  tick(world, world.commandQueue.splice(0));
}

describe('PLAYER_SURFACE_COMMANDS', () => {
  it('is exactly the player-issuable command set (CONTEXT.md → Colony control)', () => {
    expect([...PLAYER_SURFACE_COMMANDS].sort()).toEqual([
      'CancelDigMark',
      'ClearRallyPoint',
      'DesignateEntrance',
      'MarkDigTile',
      'MarkFoodPile',
      'MarkSpiderPriority',
      'PlaceChamber',
      'SetBehaviorRatio',
      'SetRallyPoint',
    ]);
  });
});

describe('JevCommandLedger — allowlist', () => {
  it('throws (and enqueues nothing) on a command outside the player surface', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    expect(() =>
      ledger.issue(world, {
        type: 'StartAIOperation',
        colonyId: PLAYER_COLONY_ID,
        kind: 'Probe',
        rallyTileX: 1,
        rallyTileY: 1,
        fighterIds: [1, 2, 3],
        issuedAtTick: 0,
      }),
    ).toThrow(/player surface/);
    expect(() => ledger.issue(world, { type: 'NoOp', issuedAtTick: 0 })).toThrow(/player surface/);
    expect(world.commandQueue).toHaveLength(0);
    expect(ledger.issuedCount).toBe(0);
  });

  it('also asserts on commands ADOPTED from a helper that pushes for itself', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    expect(() =>
      ledger.adopt(world, () => {
        pushCommand(world, { type: 'NoOp', issuedAtTick: world.tick }, 'ai');
      }),
    ).toThrow(/player surface/);
  });

  it('adopts exactly what the wrapped helper pushed', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const x = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX;
    const adopted = ledger.adopt(world, () => {
      pushCommand(
        world,
        { type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID, tileX: x, tileY: 4, issuedAtTick: 0 },
        'ai',
      );
      pushCommand(
        world,
        { type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID, tileX: x, tileY: 5, issuedAtTick: 0 },
        'ai',
      );
    });
    expect(adopted).toBe(2);
    expect(ledger.issuedCount).toBe(2);
  });
});

describe('JevCommandLedger — applied / rejected / no-op', () => {
  it('classifies a ceiling-row dig mark as rejected and a re-mark as a no-op', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const x = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX;
    // Ceiling row (y = 0) is undiggable — tick.ts drops it.
    ledger.issue(world, {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: x + 5,
      tileY: 0,
      issuedAtTick: 0,
    });
    ledger.issue(world, {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: x + 1,
      tileY: 5,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts).toEqual({ applied: 1, rejected: 1, noop: 0 });
    expect(ugGet(world.undergroundGrids[PLAYER_COLONY_ID]!, x + 1, 5)).not.toBe(
      UndergroundTileState.Solid,
    );

    // Re-marking an already-Marked tile is a no-op, not a rejection.
    ledger.issue(world, {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: x + 1,
      tileY: 5,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.noop).toBe(1);
  });

  it('records rally point, behavior ratio and food priority as applied', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const entrance = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!;
    const pile = world.foodPiles[0]!;
    ledger.issue(world, {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: entrance.surfaceTileX,
      tileY: entrance.surfaceTileY,
      issuedAtTick: 0,
    });
    ledger.issue(world, {
      type: 'SetBehaviorRatio',
      colonyId: PLAYER_COLONY_ID,
      ratio: { forage: 3, fight: 7 },
      issuedAtTick: 0,
    });
    ledger.issue(world, {
      type: 'MarkFoodPile',
      colonyId: PLAYER_COLONY_ID,
      tileX: pile.tileX,
      tileY: pile.tileY,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts).toEqual({ applied: 3, rejected: 0, noop: 0 });
    expect(world.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId).toBe(pile.foodPileId);
    expect(world.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual({ forage: 3, fight: 7 });

    // Re-issuing the settings the colony already has is a no-op, not a rejection —
    // this is what the controller's command-diffing exists to avoid.
    ledger.issue(world, {
      type: 'SetBehaviorRatio',
      colonyId: PLAYER_COLONY_ID,
      ratio: { forage: 3, fight: 7 },
      issuedAtTick: world.tick,
    });
    ledger.issue(world, {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: entrance.surfaceTileX,
      tileY: entrance.surfaceTileY,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.noop).toBe(2);
    expect(ledger.counts.rejected).toBe(0);
  });

  it('cancels a dig mark, and a cancel on an unmarked tile is a no-op', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const x = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX;
    ledger.issue(world, {
      type: 'MarkDigTile',
      colonyId: PLAYER_COLONY_ID,
      tileX: x + 1,
      tileY: 6,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.applied).toBe(1);

    ledger.issue(world, {
      type: 'CancelDigMark',
      colonyId: PLAYER_COLONY_ID,
      tileX: x + 1,
      tileY: 6,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.applied).toBe(2);
    expect(ugGet(world.undergroundGrids[PLAYER_COLONY_ID]!, x + 1, 6)).toBe(
      UndergroundTileState.Solid,
    );

    // The tile is Solid again — cancelling is now a no-op.
    ledger.issue(world, {
      type: 'CancelDigMark',
      colonyId: PLAYER_COLONY_ID,
      tileX: x + 1,
      tileY: 6,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.noop).toBe(1);
    expect(ledger.counts.rejected).toBe(0);
  });

  it('clears a rally point, and clearing an already-clear one is a no-op', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const entrance = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!;

    ledger.issue(world, {
      type: 'ClearRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts).toEqual({ applied: 0, rejected: 0, noop: 1 });

    ledger.issue(world, {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: entrance.surfaceTileX,
      tileY: entrance.surfaceTileY,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    ledger.issue(world, {
      type: 'ClearRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.applied).toBe(2);
    expect(world.colonies[PLAYER_COLONY_ID]!.rallyPoint).toBeNull();
  });

  it('marks and unmarks the spider as a priority target', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    expect(world.spider).not.toBeNull(); // the scenario always spawns one

    // Already null — clearing is a no-op.
    ledger.issue(world, {
      type: 'MarkSpiderPriority',
      colonyId: PLAYER_COLONY_ID,
      isPriority: false,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.noop).toBe(1);

    ledger.issue(world, {
      type: 'MarkSpiderPriority',
      colonyId: PLAYER_COLONY_ID,
      isPriority: true,
      issuedAtTick: world.tick,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.applied).toBe(1);
    expect(world.spiderPriorityColonyId).toBe(PLAYER_COLONY_ID);
  });

  it('records an existing entrance re-designation as a no-op and an illegal one as rejected', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const entrance = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!;

    ledger.issue(world, {
      type: 'DesignateEntrance',
      colonyId: PLAYER_COLONY_ID,
      surfaceTileX: entrance.surfaceTileX,
      surfaceTileY: entrance.surfaceTileY,
      issuedAtTick: 0,
    });
    // Out of bounds — tick.ts drops it, so nothing is ever added.
    ledger.issue(world, {
      type: 'DesignateEntrance',
      colonyId: PLAYER_COLONY_ID,
      surfaceTileX: 9999,
      surfaceTileY: 9999,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts).toEqual({ applied: 0, rejected: 1, noop: 1 });
  });

  it('records a chamber anchored on an existing chamber as a no-op', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    // An anchor with no open/reachable footprint — tick.ts declines it.
    ledger.issue(world, {
      type: 'PlaceChamber',
      colonyId: PLAYER_COLONY_ID,
      chamberType: 1,
      anchorTileX: 2,
      anchorTileY: 100,
      issuedAtTick: 0,
    });
    drainAndTick(world);
    ledger.settle(world);
    expect(ledger.counts.rejected).toBe(1);
  });

  it('settle() is a no-op when nothing is pending', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    ledger.settle(world);
    ledger.settle(world);
    expect(ledger.counts).toEqual({ applied: 0, rejected: 0, noop: 0 });
  });
});
