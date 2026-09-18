// jev-opening.test.ts — the code-owned opening and the handoff predicate.
//
// Drives a REAL createScenario world through real tick()s, exactly as the game
// loop would: the rule-based AI plays the enemy seat while the Jev opening plays
// the player seat, so both colonies open identically.

import { beforeAll, describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import type { WorldState } from '../sim/types.js';
import { ChamberType } from '../sim/enums.js';
import type { PendingChamber } from '../sim/colony/chamber.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { runAIController, resetAIControllerCache } from './ai-controller.js';
import { JevCommandLedger } from './jev-commands.js';
import {
  JEV_OPENING_RATIO,
  createJevOpeningState,
  isHandoffComplete,
  runJevOpeningTick,
} from './jev-opening.js';

const MAX_TICKS = 8000;

interface OpeningRun {
  world: WorldState;
  ledger: JevCommandLedger;
  handoffTick: number;
}

/**
 * The opening is ~4k ticks of real simulation, so it runs ONCE for the file.
 * #227 precedent: the build gets an explicit generous timeout so the local
 * coverage gate passes under v8 instrumentation; the default 5s stays the
 * tripwire for every individual test below.
 */
let opening!: OpeningRun;
beforeAll(() => {
  opening = runToHandoff(1);
}, 120_000);

/** Run the shared opening for the player seat until handoff. */
function runToHandoff(seed = 1): OpeningRun {
  resetAIControllerCache();
  const world = createScenario(seed, 'Normal');
  const ledger = new JevCommandLedger();
  const st = createJevOpeningState();
  for (;;) {
    if (isHandoffComplete(world, PLAYER_COLONY_ID)) {
      return { world, ledger, handoffTick: world.tick };
    }
    if (world.tick >= MAX_TICKS) throw new Error(`no handoff by tick ${MAX_TICKS}`);
    ledger.settle(world);
    runAIController(world, ENEMY_COLONY_ID);
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    tick(world, world.commandQueue.splice(0));
  }
}

describe('jev opening', () => {
  it('reaches handoff with Queen + Nursery + FoodStorage and no pending chambers', () => {
    const { world, handoffTick } = opening;
    expect(handoffTick).toBeGreaterThan(0);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    for (const t of [ChamberType.Queen, ChamberType.Nursery, ChamberType.FoodStorage]) {
      expect(colony.chambers.some((c) => c.chamberType === t)).toBe(true);
    }
    const ourPending = Object.values(world.pendingChambers).filter(
      (p) => p.colonyId === PLAYER_COLONY_ID,
    );
    expect(ourPending).toHaveLength(0);
  });

  it('sets the 7:3 opening behavior ratio exactly once, and nothing it issues is rejected', () => {
    const { world, ledger } = opening;
    expect(world.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual(JEV_OPENING_RATIO);
    // Everything the opening pushes is a legal player command by construction
    // (the allowlist would have thrown), and the helpers only push what the sim
    // will accept — a rejection here means a candidate/gate mismatch.
    expect(ledger.issuedCount).toBeGreaterThan(0);
    expect(ledger.counts.rejected).toBe(0);
  });

  it('is idempotent — calling it after handoff pushes nothing new', () => {
    const { world } = opening;
    const st = createJevOpeningState();
    const ledger = new JevCommandLedger();
    // The ratio is already 7:3, so the one guarded push is skipped too.
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    expect(ledger.issuedCount).toBe(0);
  });

  it('is inert for a defeated or unknown colony', () => {
    const world = createScenario(1, 'Normal');
    const ledger = new JevCommandLedger();
    const st = createJevOpeningState();
    runJevOpeningTick(world, 99, ledger, st);
    expect(ledger.issuedCount).toBe(0);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    colony.defeated = true;
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    expect(ledger.issuedCount).toBe(0);
  });
});

describe('isHandoffComplete', () => {
  it('is false on a fresh scenario and for an unknown colony', () => {
    const world = createScenario(1, 'Normal');
    expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(false);
    expect(isHandoffComplete(world, 99)).toBe(false);
  });

  it('is derived from the world, so a resumed save lands in the right phase', () => {
    const { world } = opening;
    // A controller constructed fresh against this world would immediately be live.
    expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('is false again while any chamber of OURS is still pending', () => {
    const { world } = opening;
    const key = `${PLAYER_COLONY_ID}:1:40`;
    const ourPending: PendingChamber = {
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: 1,
      anchorTileY: 40,
      width: 3,
      height: 3,
    };
    world.pendingChambers[key] = ourPending;
    try {
      expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(false);
      // Someone else's pending chamber does not hold OUR handoff back.
      world.pendingChambers[key] = { ...ourPending, colonyId: ENEMY_COLONY_ID };
      expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(true);
    } finally {
      delete world.pendingChambers[key];
    }
  });
});
