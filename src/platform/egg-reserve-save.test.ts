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
import { SIM_VERSION_V69_FOOD_FAIRNESS, SIM_VERSION_V70_EGG_RESERVE } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { eggReserveFp } from '../sim/colony/lifecycle-system.js';
import { ChamberType } from '../sim/enums.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
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
    const live = createScenario(20, 'Normal', SIM_VERSION_V70_EGG_RESERVE);
    orderStandardOpening(live);
    for (let t = 0; t < 2400; t++) step(live);
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(live))));
    expect(loaded.simVersion).toBe(SIM_VERSION_V70_EGG_RESERVE);
    expect(hashWorldState(loaded)).toBe(hashWorldState(live));
    // Both read the same reserve straight after the load: nothing about it is lost.
    for (const c of [P, ENEMY_COLONY_ID]) {
      expect(eggReserveFp(loaded, loaded.colonies[c]!)).toBe(eggReserveFp(live, live.colonies[c]!));
    }

    // The same saved world played on under the V69 rule (the only thing V70 changes
    // is the egg gate): if it lays more, the reserve held the V70 queen back during
    // the continuation, so the round trip was tested where the rule bites.
    const asV69 = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(live))));
    asV69.simVersion = SIM_VERSION_V69_FOOD_FAIRNESS;
    const lays = (w: WorldState, last: { at: number; n: number }): void => {
      const tickNow = w.colonies[P]!.queenLastEggTick;
      if (tickNow !== last.at) {
        last.at = tickNow;
        last.n += 1;
      }
    };
    const liveLays = { at: live.colonies[P]!.queenLastEggTick, n: 0 };
    const v69Lays = { at: asV69.colonies[P]!.queenLastEggTick, n: 0 };
    for (let t = 1; t <= 2400; t++) {
      step(live);
      step(loaded);
      step(asV69);
      lays(live, liveLays);
      lays(asV69, v69Lays);
      if (t % 200 === 0)
        expect(hashWorldState(loaded), `tick ${live.tick}`).toBe(hashWorldState(live));
    }
    // Non-vacuity: across the continuation the V70 queen laid, and was held back.
    expect(liveLays.n).toBeGreaterThan(0);
    expect(v69Lays.n).toBeGreaterThan(liveLays.n);
  }, 240_000); // sized for instrumented coverage runs (#227)
});
