// #395 part 2 — pinned V69: egg-laying is unchanged below V70.
//
// V70 replaces the queen's 3-food egg threshold with the egg reserve
// (lifecycle-system.ts eggReserveFp). It is gated on the world's simVersion, so a V69
// world must still lay — and so run — exactly as before. GOLDEN_RUNS were captured on
// 86a2b09 (V69 = LATEST there) with createScenario(seed, difficulty): the standard
// opening ordered at tick 0 for the player (Queen, Nursery and FoodStorage), the
// enemy driven by the AI controller, the full serialized world hashed every 1200
// ticks. By 3:00 both queens have been laying for minutes, so the egg gate is
// exercised on both sides.
import { describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { pushCommand } from '../sim/commands.js';
import type { SimCommand } from '../sim/commands.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { ChamberType } from '../sim/enums.js';
import { SIM_VERSION_V69_FOOD_FAIRNESS, SIM_VERSION_V70_EGG_RESERVE } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { runAIController } from '../render/ai-controller.js';
import { hashWorldState } from './world-hash.js';

type Difficulty = 'Easy' | 'Normal' | 'Hard';

/** The opening run's hash at ticks 1200, 2400 and 3600 from the V69 world, on 86a2b09. */
const GOLDEN_RUNS: ReadonlyArray<readonly [number, Difficulty, readonly string[]]> = [
  [20, 'Normal', ['4d2a0a36', '5f7f396f', '9bbbb5ec']], // player brood at 3:00: 14
  [12, 'Hard', ['b273bd06', '182530a3', '2de0c81c']], // 15
  [5, 'Easy', ['06e19ad2', 'eebf63be', 'b4cc779c']], // 13
];

/** The standard opening, ordered for the player at tick 0. */
function orderStandardOpening(world: WorldState): void {
  const order = (c: Record<string, unknown>): void => {
    pushCommand(
      world,
      { ...c, colonyId: PLAYER_COLONY_ID, issuedAtTick: world.tick } as unknown as SimCommand,
      'player',
    );
  };
  for (let y = 2; y <= 8; y++) order({ type: 'MarkDigTile', tileX: 24, tileY: y });
  order({ type: 'PlaceChamber', chamberType: ChamberType.Queen, anchorTileX: 22, anchorTileY: 9 });
  for (let x = 25; x <= 30; x++) order({ type: 'MarkDigTile', tileX: x, tileY: 5 });
  order({
    type: 'PlaceChamber',
    chamberType: ChamberType.Nursery,
    anchorTileX: 31,
    anchorTileY: 4,
  });
  for (let x = 21; x <= 23; x++) order({ type: 'MarkDigTile', tileX: x, tileY: 5 });
  order({
    type: 'PlaceChamber',
    chamberType: ChamberType.FoodStorage,
    anchorTileX: 17,
    anchorTileY: 4,
  });
}

/** Run the opening from `world` to tick 3600; the hash every 1200 ticks. */
function runOpening(world: WorldState): string[] {
  orderStandardOpening(world);
  const hashes: string[] = [];
  for (let t = 1; t <= 3600; t++) {
    runAIController(world, ENEMY_COLONY_ID);
    tick(world, world.commandQueue.splice(0));
    if (t % 1200 === 0) hashes.push(hashWorldState(world));
  }
  return hashes;
}

describe('#395 part 2 — pinned V69: egg-laying is unchanged below V70', () => {
  it('the standard opening at V69 runs as before, hash for hash, to 3:00', () => {
    expect(GOLDEN_RUNS.length).toBe(3);
    for (const [seed, difficulty, golden] of GOLDEN_RUNS) {
      const world = createScenario(seed, difficulty, SIM_VERSION_V69_FOOD_FAIRNESS);
      expect(runOpening(world), `seed ${seed} ${difficulty}`).toEqual(golden);
    }
  }, 120_000);

  it('non-vacuity: at V70 the same openings diverge, with a smaller brood', () => {
    for (const [seed, difficulty, golden] of GOLDEN_RUNS) {
      const v69 = createScenario(seed, difficulty, SIM_VERSION_V69_FOOD_FAIRNESS);
      const v70 = createScenario(seed, difficulty, SIM_VERSION_V70_EGG_RESERVE);
      const hashes = runOpening(v70);
      runOpening(v69);
      expect(hashes[2], `seed ${seed} ${difficulty}`).not.toBe(golden[2]);
      const brood = (w: WorldState): number =>
        w.colonies[PLAYER_COLONY_ID]!.eggCount + w.colonies[PLAYER_COLONY_ID]!.larvaeCount;
      expect(brood(v70), `seed ${seed} ${difficulty}`).toBeLessThan(brood(v69));
    }
  }, 120_000);
});
