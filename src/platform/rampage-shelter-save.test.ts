// #377 (V68) — the rampage shelter across a save/load.
//
// V68 adds no serialized field: an idle worker's shelter is the V34 flee column
// (`fleeShelterUntilTick`), and the rampage and its threat are read from the spider's
// saved state (state, hungerTicks, rampageTargetColonyId, position), world.tick and
// difficulty. So a world saved mid-rampage —
// idle workers dashing in, others sheltering at the shaft top — must load and
// continue hash-for-hash with the world that was never saved, through the rampage
// and past the spider's meal (when they come back out). Lives in platform/ for the
// save serializer and hashWorldState.
import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { hashWorldState } from './world-hash.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { allocateEntityId, SIM_VERSION_V68_RAMPAGE_SHELTER } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { rampageShelterActive, rampageThreatens } from '../sim/ant/idle-reserve.js';
import { AntTask } from '../sim/enums.js';
import { Zone } from '../sim/terrain.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import {
  PLAYER_COLONY_ID,
  SHELTER_COOLDOWN_TICKS,
  SPIDER_GRACE_TICKS,
  SPIDER_HUNGER_THRESHOLD_TICKS,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../sim/constants.js';

const P = PLAYER_COLONY_ID;
const center = (t: number): number => (t << FP_SHIFT) + (FP_ONE >> 1);

/** Seed 7 at V68, past the grace, a hungry spider at its lair on its way to camp the
 *  player's colony (so it threatens it: the camp target, saved state), a 0:0 ratio,
 *  and ten idle workers east of the player's door (24,64), 2 to 14 tiles out. */
function world(): { w: WorldState; ids: number[] } {
  const w = createScenario(7, 'Normal');
  w.simVersion = SIM_VERSION_V68_RAMPAGE_SHELTER;
  w.aiState = [];
  // eslint-disable-next-line no-restricted-syntax -- test fixture: stage the world tick past the spider's grace
  w.tick = SPIDER_GRACE_TICKS + 500;
  w.spider!.hungerTicks = SPIDER_HUNGER_THRESHOLD_TICKS[1] + 10;
  w.spider!.nextHuntTick = w.tick + 100_000;
  w.spider!.state = 'Rampaging';
  w.spider!.rampageTargetColonyId = P;
  w.spider!.rampageEntranceId = -1;
  w.spider!.rampageStartTick = w.tick;
  // A 0:0 ratio: nothing recruits the idle workers away.
  w.colonies[P]!.targetRatio = { forage: 0, fight: 0 };
  const ids: number[] = [];
  for (let i = 0; i < 10; i++) {
    const id = allocateEntityId(w);
    initAnt(w.ants, id, {
      colonyId: P,
      posX: center(26 + (i % 5) * 3),
      posY: center(i < 5 ? 64 : 66),
      task: AntTask.Idle,
      subTask: 0,
      speed: WORKER_BASE_SPEED,
      lifespan: WORKER_LIFESPAN_TICKS,
      lastMealTick: w.tick,
      zone: Zone.Surface,
    });
    w.ants.currentGridColonyId[id] = P;
    w.colonies[P]!.workers.push(id);
    w.colonies[P]!.workerCount += 1;
    ids.push(id);
  }
  return { w, ids };
}

describe('#377 (V68) — a world saved mid-rampage continues exactly as the unsaved one', () => {
  it('saved while the reserve dashes in and shelters, it matches hash-for-hash to after the meal', () => {
    const { w: live, ids } = world();
    // Five ticks in: some idle workers dashing in (phase 0), some already below.
    for (let t = 0; t < 5; t++) tick(live, []);
    expect(rampageShelterActive(live)).toBe(true);
    expect(rampageThreatens(live, live.colonies[P]!)).toBe(true);
    const phases = ids.map((id) => live.ants.fleeShelterUntilTick[id]!);
    expect(phases.some((p) => p === 0)).toBe(true);
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(serializeWorldState(live))));
    expect(hashWorldState(loaded)).toBe(hashWorldState(live));
    let sheltered = 0;
    const lairX = live.spider!.lairTileX;
    const lairY = live.spider!.lairTileY;
    for (let t = 1; t <= 3 * SHELTER_COOLDOWN_TICKS; t++) {
      if (t < 2 * SHELTER_COOLDOWN_TICKS) {
        // Keep it hungry at its lair, on its way to camp the player's colony, in both
        // worlds alike.
        for (const w of [live, loaded]) {
          w.spider!.state = 'Rampaging';
          w.spider!.rampageTargetColonyId = P;
          w.spider!.posX = lairX << FP_SHIFT;
          w.spider!.posY = lairY << FP_SHIFT;
        }
      }
      if (t === 2 * SHELTER_COOLDOWN_TICKS) {
        // The spider eats, at its lair, in both worlds alike.
        for (const w of [live, loaded]) {
          w.spider!.state = 'Feeding';
          w.spider!.hungerTicks = 0;
          w.spider!.feedAwayTileX = w.spider!.posX >> FP_SHIFT;
          w.spider!.feedAwayTileY = w.spider!.posY >> FP_SHIFT;
          w.spider!.feedArrivedTick = w.tick;
        }
      }
      tick(live, []);
      tick(loaded, []);
      if (t % 25 === 0) expect(hashWorldState(loaded)).toBe(hashWorldState(live));
      if (t === 2 * SHELTER_COOLDOWN_TICKS - 1) {
        sheltered = ids.filter(
          (id) =>
            live.ants.alive[id] === 1 &&
            live.ants.zone[id] === Zone.Underground &&
            live.ants.fleeShelterUntilTick[id]! > 0,
        ).length;
      }
    }
    expect(hashWorldState(loaded)).toBe(hashWorldState(live));
    // Non-vacuous: the reserve was sheltering through the rampage, and is out after it.
    expect(sheltered).toBeGreaterThanOrEqual(8);
    const outAfter = ids.filter(
      (id) => live.ants.alive[id] === 1 && live.ants.zone[id] === Zone.Surface,
    ).length;
    expect(outAfter).toBeGreaterThanOrEqual(8);
  });
});
