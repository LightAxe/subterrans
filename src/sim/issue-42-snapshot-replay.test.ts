// issue-42-snapshot-replay.test.ts — replay the issue #42 debug snapshot
// forward and assert no surface forager loops in a tight cycle.
//
// The snapshot was captured at tick 214 with seed 1701241663, simVersion=5,
// 2 colonies, both with foodStored at cap and no FoodStorage chambers. Pre-
// fix replay showed ant 18 (the surface forager with no food) cycling in
// a 4-tile region near the entrance for 200+ ticks. Post-fix the v6 code
// path (createWorldState defaults the loaded snapshot to v6 once we set
// simVersion) demotes the forager to Idle when there's no deposit target;
// the cycle dissolves.
//
// Determinism note: the snapshot has simVersion=5, which sticky-loads as
// v5 (preserves SCEN-06 byte-identical replay for any pre-v6 saves). To
// observe the v6 fix on the captured world we explicitly bump simVersion
// to LATEST after deserialization. New worlds (no save) start at v6 by
// default via createWorldState.
//
// Fixture lives in `src/sim/__fixtures__/issue-42-debug-tick214.json`
// (committed to the repo) so CI and fresh clones run the replay too.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// snapshot-replay test intentionally crosses the sim/platform boundary
// to round-trip the debug-snapshot JSON fixture through the save
// deserializer (the sim has no other path to inflate a captured
// WorldState). See `boundary` ESLint rule + AGENTS.md.
// eslint-disable-next-line no-restricted-imports
import { deserializeWorldState } from '../platform/save.js';
import { tick } from './tick.js';
import { FP_SHIFT } from './fixed.js';
import { LATEST_SIM_VERSION } from './types.js';

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/issue-42-debug-tick214.json',
);

describe('issue #42 — debug-snapshot replay', () => {
  it('forager 18 escapes the 4-tile eddy within 50 ticks at v6', () => {
    const debug = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const world = deserializeWorldState(debug.snapshot);
    // Snapshot was captured at v5; bump to v6 to exercise the fix.
    world.simVersion = LATEST_SIM_VERSION;

    const TICK_BUDGET = 50;
    const ANT_ID = 18; // the surface forager in the original repro
    const tilesVisited = new Set<string>();

    for (let t = 0; t < TICK_BUDGET; t++) {
      tick(world, []);
      if (world.ants.alive[ANT_ID] !== 1) break;
      const tx = world.ants.posX[ANT_ID]! >> FP_SHIFT;
      const ty = world.ants.posY[ANT_ID]! >> FP_SHIFT;
      tilesVisited.add(`${world.ants.zone[ANT_ID]}:${tx},${ty}`);
    }

    // Pre-fix: the ant cycled within a 4-tile region. Post-fix: the
    // colony has no deposit target → tickSearchLeash demotes the
    // forager to Idle (and step 10a re-evaluates against the colony's
    // computedAllocation). With no other allocation demand the ant
    // sits Idle, but the eddy is broken: the per-ant tile set should
    // reach at least one DIFFERENT tile, OR the ant transitions out
    // of Foraging+SearchingFood entirely. Either resolves the visual
    // "tight circle".
    const stillSearching =
      world.ants.task[ANT_ID] === 1 && world.ants.subTask[ANT_ID] === 0;
    const escaped = !stillSearching || tilesVisited.size > 4;
    expect(escaped).toBe(true);
  });

  it('all stuck carriers either deposit, enter wait, or otherwise progress within 50 ticks at v6', () => {
    const debug = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const world = deserializeWorldState(debug.snapshot);
    world.simVersion = LATEST_SIM_VERSION;

    // Snapshot identifies these 5 carriers all stacked at entrance
    // underground tiles (24,0) and (104,0). Post-fix, every one of them
    // should end the 50-tick replay either:
    //   (a) in waitingDeposit=1 (correctly waiting for pool drain), or
    //   (b) carrying less food than they started with (deposited progress).
    const STUCK_CARRIER_IDS = [17, 19, 22, 23, 24];
    const startCarry: Record<number, number> = {};
    for (const id of STUCK_CARRIER_IDS) {
      startCarry[id] = world.ants.foodCarrying[id]!;
    }

    for (let t = 0; t < 50; t++) tick(world, []);

    for (const id of STUCK_CARRIER_IDS) {
      if (world.ants.alive[id] !== 1) continue;
      const inWait = world.ants.waitingDeposit[id] === 1;
      const deposited = world.ants.foodCarrying[id]! < startCarry[id]!;
      const taskChanged = world.ants.task[id] !== 1 || world.ants.subTask[id] !== 1;
      // Any of three escape paths is acceptable. The pre-fix bug was that
      // 2 of the 5 sat at waitingDeposit=0 with leftover food forever.
      expect(inWait || deposited || taskChanged).toBe(true);
    }
  });
});
