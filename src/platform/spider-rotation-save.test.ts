// src/platform/spider-rotation-save.test.ts — #337 (V54): the spider's entrance
// rotation state (rampageEntranceId, rampageRotationEntranceId, rampageRotationTick)
// survives save/load, replays identically, and is validated on load.

import { describe, it, expect } from 'vitest';
import type { WorldState } from '../sim/types.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import { PLAYER_COLONY_ID, SPIDER_RAMPAGE_MAX_TICKS } from '../sim/constants.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { hashWorldState } from './world-hash.js';

/** Force the scenario spider onto colony `cid`'s open entrance with its leash expired. */
function forceExpiredCamp(world: WorldState, cid: number): number {
  const e = world.colonies[cid as unknown as ColonyId]!.entrances.find((x) => x.isOpen)!;
  const s = world.spider!;
  s.state = 'Rampaging';
  s.rampageTargetColonyId = cid;
  s.rampageStartTick = world.tick - SPIDER_RAMPAGE_MAX_TICKS; // expires on the next tick
  s.rampageKillsThisRampage = 0;
  s.chaseTargetAntId = -1;
  s.hungerTicks = 5000;
  s.posX = (e.surfaceTileX << FP_SHIFT) + 128;
  s.posY = (e.surfaceTileY << FP_SHIFT) + 128;
  return e.entranceId;
}

function runTicks(world: WorldState, n: number): void {
  for (let i = 0; i < n; i++) tick(world, world.commandQueue.splice(0));
}

describe('V54 (#337) — save/load mid-rotation', () => {
  it('save/load mid-rotation round-trips and replays identically', () => {
    const world = createScenario(11);
    runTicks(world, 2000);
    expect(world.spider).not.toBeNull();
    forceExpiredCamp(world, PLAYER_COLONY_ID);
    runTicks(world, 3); // timed out; now rotating
    const s = world.spider!;
    expect(s.rampageRotationEntranceId).toBeGreaterThanOrEqual(0);
    // Save while it camps the rotated (pinned) entrance, so the pin round-trips too.
    for (let i = 0; i < 50 && !(s.state === 'Rampaging' && s.rampageEntranceId >= 0); i++) {
      runTicks(world, 1);
    }
    expect(s.state).toBe('Rampaging');
    expect(s.rampageEntranceId).toBeGreaterThanOrEqual(0);
    const saved = serializeWorldState(world);
    const loaded = deserializeWorldState(JSON.parse(JSON.stringify(saved)));
    expect(loaded.spider!.rampageRotationEntranceId).toBe(s.rampageRotationEntranceId);
    expect(loaded.spider!.rampageRotationTick).toBe(s.rampageRotationTick);
    expect(loaded.spider!.rampageEntranceId).toBe(s.rampageEntranceId);
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
    for (let i = 0; i < 1500; i++) {
      tick(world, world.commandQueue.splice(0));
      tick(loaded, loaded.commandQueue.splice(0));
    }
    expect(hashWorldState(loaded)).toBe(hashWorldState(world));
  }, 60_000); // several thousand full-pipeline ticks; generous for loaded CI runners
});

describe('V54 (#337) — save validation of the new spider fields', () => {
  function roundTrip(patch: Record<string, unknown>) {
    const world = createScenario(3);
    const saved = serializeWorldState(world) as unknown as {
      tick: number;
      spider: Record<string, unknown>;
    };
    Object.assign(saved.spider, patch);
    return deserializeWorldState(saved as never).spider!;
  }

  it('a pre-V54 save (fields absent) loads with all three at -1', () => {
    const world = createScenario(3);
    const saved = serializeWorldState(world) as unknown as { spider: Record<string, unknown> };
    delete saved.spider.rampageEntranceId;
    delete saved.spider.rampageRotationEntranceId;
    delete saved.spider.rampageRotationTick;
    const sp = deserializeWorldState(saved as never).spider!;
    expect(sp.rampageEntranceId).toBe(-1);
    expect(sp.rampageRotationEntranceId).toBe(-1);
    expect(sp.rampageRotationTick).toBe(-1);
  });

  it('keeps a valid cursor + tick in any state, and a pin only while Rampaging', () => {
    const a = roundTrip({
      state: 'Patrolling',
      rampageEntranceId: 9,
      rampageRotationEntranceId: 7,
      rampageRotationTick: 0, // the save's own tick (a fresh scenario is at 0)
    });
    expect(a.rampageRotationEntranceId).toBe(7);
    expect(a.rampageRotationTick).toBe(0);
    expect(a.rampageEntranceId).toBe(-1);
    const w = createScenario(3);
    const own = w.colonies[1]!.entrances[0]!.entranceId;
    const b = roundTrip({ state: 'Rampaging', rampageTargetColonyId: 1, rampageEntranceId: own });
    expect(b.rampageEntranceId).toBe(own);
  });

  it("drops a pin that is not one of the target colony's entrances", () => {
    const w = createScenario(3);
    const other = w.colonies[2]!.entrances[0]!.entranceId;
    const crossColony = roundTrip({
      state: 'Rampaging',
      rampageTargetColonyId: 1,
      rampageEntranceId: other,
    });
    expect(crossColony.rampageEntranceId).toBe(-1);
    const unknown = roundTrip({
      state: 'Rampaging',
      rampageTargetColonyId: 1,
      rampageEntranceId: 9999,
    });
    expect(unknown.rampageEntranceId).toBe(-1);
  });

  it('drops malformed values; a cursor without a valid tick is dropped as a pair', () => {
    const a = roundTrip({
      state: 'Rampaging',
      rampageTargetColonyId: 1,
      rampageEntranceId: 2.5,
      rampageRotationEntranceId: 7,
      rampageRotationTick: 'x',
    });
    expect(a.rampageEntranceId).toBe(-1);
    expect(a.rampageRotationEntranceId).toBe(-1);
    expect(a.rampageRotationTick).toBe(-1);
    const b = roundTrip({ rampageRotationEntranceId: -3, rampageRotationTick: 100 });
    expect(b.rampageRotationEntranceId).toBe(-1);
    expect(b.rampageRotationTick).toBe(-1);
    const c = roundTrip({ rampageRotationEntranceId: 7, rampageRotationTick: -1 });
    expect(c.rampageRotationEntranceId).toBe(-1);
  });

  it('drops a timeout tick later than the save tick (it would stretch the cooldown)', () => {
    const world = createScenario(3);
    const saved = serializeWorldState(world) as unknown as {
      tick: number;
      spider: Record<string, unknown>;
    };
    Object.assign(saved.spider, {
      rampageRotationEntranceId: 7,
      rampageRotationTick: saved.tick + 1,
    });
    const sp = deserializeWorldState(saved as never).spider!;
    expect(sp.rampageRotationEntranceId).toBe(-1);
    expect(sp.rampageRotationTick).toBe(-1);
  });

  it('drops the pin when the rampage target colony is invalid', () => {
    const sp = roundTrip({ state: 'Rampaging', rampageTargetColonyId: 0, rampageEntranceId: 9 });
    expect(sp.rampageTargetColonyId).toBe(-1);
    expect(sp.rampageEntranceId).toBe(-1);
  });
});
