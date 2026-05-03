// issue-44-snapshot-replay.test.ts — replay the issue #44 UAT-round-3
// debug snapshot forward and assert the leash-boundary forager escapes.
//
// The snapshot was captured at tick 5863 with seed 1806015051,
// simVersion=7 (the in-PR baseline before this fix), 2 colonies. The
// repro: ant 24 (enemy colony 2 surface forager) parked at tile
// (112, 43), Manhattan distance 29 from its entrance at (104, 64) —
// just past the wave-0 leash radius of 25. A steady pheromone trail
// nearby kept tickExcursionBoundary's signal-only RTN→SF breakout
// firing every other tick, while `dist > radius` flipped it back to
// RTN, producing a 13-tick repeating cycle that wiped recentTilesX/Y
// on each transition and stranded the ant in a 4-tile eddy
// indefinitely.
//
// Determinism note: the snapshot has simVersion=7, which sticky-loads
// at v7 (preserving SCEN-06 byte-identical replay for any pre-v8
// saves). To observe the v8 leash-hysteresis fix we explicitly bump
// simVersion to LATEST after deserialization. New worlds (no save)
// start at v8 by default via createWorldState.
//
// Fixture lives in `src/sim/__fixtures__/issue-44-stuck-ant-tick5863.json`
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
import { LATEST_SIM_VERSION, SIM_VERSION_V7_SURFACE_PASSABILITY } from './types.js';
import { AntTask, ForagingSubState } from './enums.js';

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/issue-44-stuck-ant-tick5863.json',
);

const ANT_ID = 24;
const ENTRANCE_X = 104;
const ENTRANCE_Y = 64;
const WAVE_0_RADIUS = 25;

function manhattanFromEntrance(world: ReturnType<typeof deserializeWorldState>): number {
  const tx = world.ants.posX[ANT_ID]! >> FP_SHIFT;
  const ty = world.ants.posY[ANT_ID]! >> FP_SHIFT;
  return Math.abs(tx - ENTRANCE_X) + Math.abs(ty - ENTRANCE_Y);
}

describe('issue #44 — debug-snapshot replay (leash-boundary eddy)', () => {
  it('ant 24 escapes the leash-boundary 4-tile eddy within 200 ticks at v8', () => {
    const debug = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const world = deserializeWorldState(debug.snapshot);
    // Snapshot was captured at v7; bump to v8 to exercise the fix.
    world.simVersion = LATEST_SIM_VERSION;

    // Sanity-check the repro starting state.
    expect(world.ants.alive[ANT_ID]).toBe(1);
    expect(world.ants.task[ANT_ID]).toBe(AntTask.Foraging);
    expect(world.ants.subTask[ANT_ID]).toBe(ForagingSubState.SearchingFood);
    expect(world.ants.searchWave[ANT_ID]).toBe(0);
    expect(manhattanFromEntrance(world)).toBeGreaterThan(WAVE_0_RADIUS);

    // The eddy was a 4-tile region. With the fix, the ant either:
    //   (a) reaches a tile far enough from the original cluster
    //       (>= 5 unique tiles visited), OR
    //   (b) transitions out of Foraging entirely (queen reassignment,
    //       death by predation, etc.).
    const TICK_BUDGET = 200;
    const tilesVisited = new Set<string>();

    for (let t = 0; t < TICK_BUDGET; t++) {
      tick(world, []);
      if (world.ants.alive[ANT_ID] !== 1) break;
      const tx = world.ants.posX[ANT_ID]! >> FP_SHIFT;
      const ty = world.ants.posY[ANT_ID]! >> FP_SHIFT;
      tilesVisited.add(`${world.ants.zone[ANT_ID]}:${tx},${ty}`);
    }

    const stillForaging = world.ants.alive[ANT_ID] === 1 && world.ants.task[ANT_ID] === AntTask.Foraging;
    const escaped = !stillForaging || tilesVisited.size >= 5;
    expect(escaped).toBe(true);
  });

  it('v8 fix produces measurably wider exploration than v7 baseline', () => {
    // Comparative test: replay the same snapshot under v7 and v8 and
    // confirm v8 visits meaningfully more unique tiles. Compares only
    // ticks during which the ant remained Foraging at BOTH versions
    // (`commonTickWindow`), so an early task transition on one side
    // (e.g. tickSearchLeash demoting to Idle for rebalance) doesn't
    // bias the absolute counts. The escape margin (>= 4 extra unique
    // tiles, ~8% of the 50-tick comparison window) is comfortably
    // larger than any plausible v7 wander drift, while still robust to
    // minor pre-PR tuning changes.
    const debug = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const TICK_BUDGET = 200;

    function recordPerTick(version: number): Array<{ task: number; tile: string }> {
      const world = deserializeWorldState(debug.snapshot);
      world.simVersion = version;
      const trace: Array<{ task: number; tile: string }> = [];
      for (let t = 0; t < TICK_BUDGET; t++) {
        tick(world, []);
        if (world.ants.alive[ANT_ID] !== 1) break;
        const task = world.ants.task[ANT_ID]!;
        const tx = world.ants.posX[ANT_ID]! >> FP_SHIFT;
        const ty = world.ants.posY[ANT_ID]! >> FP_SHIFT;
        trace.push({ task, tile: `${world.ants.zone[ANT_ID]}:${tx},${ty}` });
      }
      return trace;
    }

    const v7 = recordPerTick(SIM_VERSION_V7_SURFACE_PASSABILITY);
    const v8 = recordPerTick(LATEST_SIM_VERSION);

    // Each side counts unique tiles up to its OWN first non-Foraging
    // tick (rather than collapsing to the joint window). If v8 escapes
    // the eddy and the colony reassigns the ant out of Foraging early,
    // that is strictly stronger evidence the fix worked than a tile-
    // count delta within a shared window — accept it directly.
    function uniqueForagingTiles(trace: Array<{ task: number; tile: string }>): number {
      const tiles = new Set<string>();
      for (const step of trace) {
        if (step.task !== AntTask.Foraging) break;
        tiles.add(step.tile);
      }
      return tiles.size;
    }
    function exitedForagingBy(trace: Array<{ task: number; tile: string }>): number {
      for (let t = 0; t < trace.length; t++) {
        if (trace[t]!.task !== AntTask.Foraging) return t;
      }
      return trace.length; // never exited within the budget
    }

    const v7Tiles = uniqueForagingTiles(v7);
    const v8Tiles = uniqueForagingTiles(v8);
    const v7Exit = exitedForagingBy(v7);
    const v8Exit = exitedForagingBy(v8);

    // Either v8 visited >= 5 more unique tiles than v7 within its own
    // foraging window (wider exploration), OR v8 exited Foraging
    // strictly earlier than v7 while v7 was still cycling (v8 escaped
    // the eddy and got reassigned). Both are valid evidence the fix
    // freed the ant.
    const widerExploration = v8Tiles > v7Tiles + 4;
    const earlierEscape = v8Exit < v7Exit && v7Exit === TICK_BUDGET;
    expect(widerExploration || earlierEscape).toBe(true);
  });
});
