// #395 part 2 (V70) — the egg reserve across a save/load.
//
// V70 adds no serialized field: the egg reserve is derived each time from saved state
// (the colony's stores, brood counts, worker roster and tasks; the egg interval from
// queenLastEggTick as before). So a world saved mid-game — while the reserve is
// holding the queen back — must load and continue hash-for-hash with the world that
// was never saved. Lives in platform/ for the save serializer and hashWorldState.
import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { hashWorldState } from './world-hash.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { pushCommand } from '../sim/commands.js';
import type { SimCommand } from '../sim/commands.js';
import { LATEST_SIM_VERSION } from '../sim/types.js';
import { colonyFoodTotal } from '../sim/food/food-api.js';
import type { WorldState } from '../sim/types.js';
import { eggReserveFp } from '../sim/colony/lifecycle-system.js';
import { ChamberType } from '../sim/enums.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID, QUEEN_EGG_INTERVAL_TICKS } from '../sim/constants.js';
import { runAIController } from '../render/ai-controller.js';

const P = PLAYER_COLONY_ID;

/** The standard opening (Queen, Nursery, FoodStorage), ordered for the player at tick 0. */
function orderStandardOpening(world: WorldState): void {
  const order = (c: Record<string, unknown>): void => {
    pushCommand(
      world,
      { ...c, colonyId: P, issuedAtTick: world.tick } as unknown as SimCommand,
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

function step(world: WorldState): void {
  runAIController(world, ENEMY_COLONY_ID);
  tick(world, world.commandQueue.splice(0));
}

describe('#395 (V70) — a world saved mid-game continues exactly as the unsaved one', () => {
  it('saved at 2:00 of the standard opening, it matches hash-for-hash to 4:00', () => {
    // At LATEST: #400 raised MIN_ACCEPTED to V71, so a V70 save no longer loads.
    const live = createScenario(20, 'Normal');
    orderStandardOpening(live);
    for (let t = 0; t < 2400; t++) step(live);
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(live))));
    expect(loaded.simVersion).toBe(LATEST_SIM_VERSION);
    expect(hashWorldState(loaded)).toBe(hashWorldState(live));
    // Both read the same reserve straight after the load: nothing about it is lost.
    for (const c of [P, ENEMY_COLONY_ID]) {
      expect(eggReserveFp(loaded, loaded.colonies[c]!)).toBe(eggReserveFp(live, live.colonies[c]!));
    }

    const lays = (w: WorldState, last: { at: number; n: number }): void => {
      const tickNow = w.colonies[P]!.queenLastEggTick;
      if (tickNow !== last.at) {
        last.at = tickNow;
        last.n += 1;
      }
    };
    const liveLays = { at: live.colonies[P]!.queenLastEggTick, n: 0 };
    // Ticks of the continuation on which the reserve held the player's queen back:
    // her egg interval was up but the stores were short of the reserve. (Up to #400
    // this compared lays against the same save replayed as V69, which no longer loads.)
    let held = 0;
    for (let t = 1; t <= 2400; t++) {
      const col = live.colonies[P]!;
      if (
        live.tick - col.queenLastEggTick >= QUEEN_EGG_INTERVAL_TICKS &&
        colonyFoodTotal(live, col) < eggReserveFp(live, col)
      ) {
        held += 1;
      }
      step(live);
      step(loaded);
      lays(live, liveLays);
      if (t % 200 === 0)
        expect(hashWorldState(loaded), `tick ${live.tick}`).toBe(hashWorldState(live));
    }
    // Non-vacuity: across the continuation the queen laid, and was held back.
    expect(liveLays.n).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  }, 240_000); // sized for instrumented coverage runs (#227)
});
