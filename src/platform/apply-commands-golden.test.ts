// src/platform/apply-commands-golden.test.ts
//
// GOLDEN DIFFERENTIAL for the Stage-3a `applyCommands` extraction (issue #18).
//
// Contract (Codex R2-6/7, R3-7, R4-3): the command-application core (tick.ts
// lines 266–854: the SyncAIState pre-pass + 64-cap loop + command switch) is
// being lifted VERBATIM out of tick() into a pure `applyCommands(world, commands)`.
// To prove that move is byte-identical we capture full-state golden snapshots from
// the PRE-refactor tick() across the whole command matrix BEFORE extracting, then
// assert the post-refactor tick() reproduces them. (Running two worlds through the
// SAME tick() proves only determinism, not equivalence — hence committed fixtures.)
//
// Lives in src/platform/ (not src/sim/) so it can import the curated platform
// serializer + cross the layer; src/sim/ forbids platform imports and division.
//
// The comparator is a SUPERSET of the save serializer: it adds `world.events` +
// the dropped-event counters (which `serializeWorldState` deliberately omits, but
// which StartAIOperation/combat can mutate — Codex R2-7). Big typed-array fields
// are reduced to a stable SHA-1 so a divergence pin-points the subsystem without
// bloating the .snap; small command-mutated fields stay readable.
//
// Matrix: every one of the 12 SimCommand variants, invalid payloads, an unknown
// variant, the SyncAIState uncapped pre-pass, and interleaved Sync/non-Sync
// batches > MAX_COMMANDS_PER_TICK.

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { tick } from '../sim/tick.js';
import { serializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID, UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { ChamberType } from '../sim/enums.js';
import type { WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';

// --- compact full-state golden -------------------------------------------------

function sha1(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/**
 * Full post-tick golden: every command-mutated field, plus events + dropped
 * counters (which serializeWorldState omits). Voluminous arrays (ants, pheromone,
 * surface, underground) are hashed for a small, field-granular snapshot — a hash
 * mismatch names the exact subsystem that diverged.
 */
function golden(world: WorldState): unknown {
  const s = serializeWorldState(world);
  return {
    scalars: {
      tick: s.tick,
      rngState: s.rngState,
      nextEntityId: s.nextEntityId,
      simVersion: s.simVersion,
      terrainSeed: s.terrainSeed,
      difficulty: s.difficulty,
    },
    commandQueue: s.commandQueue,
    // readable command-mutated state:
    colonies: s.colonies,
    pendingChambers: s.pendingChambers,
    foodPiles: s.foodPiles,
    recentlyDepletedFood: s.recentlyDepletedFood,
    spider: s.spider,
    spiderPriorityColonyId: s.spiderPriorityColonyId,
    scatterReticleTile: s.scatterReticleTile,
    aiState: s.aiState,
    // Codex R2-7 — events + overflow counters (serializeWorldState skips events):
    events: world.events.map((e) => ({ ...e })),
    droppedCombatKillCount: s.droppedCombatKillCount,
    droppedStructuralCount: s.droppedStructuralCount,
    // hashed bulk arrays (byte-identity without .snap bloat):
    hashes: {
      ants: sha1(s.ants),
      pheromoneGrids: sha1(s.pheromoneGrids),
      surface: sha1(s.surface),
      bakedSurfaceEffect: sha1(s.bakedSurfaceEffect),
      undergroundGrids: sha1(s.undergroundGrids),
    },
  };
}

// --- matrix builders -----------------------------------------------------------

const TICK = 0;
function base(): WorldState {
  // Fixed seed → deterministic world; Normal difficulty.
  return createScenario(0x3a90d, 'Normal');
}

/** Run one tick of `commands` against a fresh scenario and return its golden. */
function run(commands: SimCommand[]): unknown {
  const w = base();
  tick(w, commands);
  return golden(w);
}

// A clearly-unknown variant (silent-dropped by the default case, exhaustive `never`).
const UNKNOWN = { type: 'BogusVariant', issuedAtTick: TICK } as unknown as SimCommand;

describe('applyCommands golden differential (byte-identity of the extraction)', () => {
  it('NoOp', () => {
    expect(run([{ type: 'NoOp', issuedAtTick: TICK }])).toMatchSnapshot();
  });

  it('SetBehaviorRatio — valid colony + nonexistent colony', () => {
    expect(
      run([
        {
          type: 'SetBehaviorRatio',
          colonyId: PLAYER_COLONY_ID,
          ratio: { forage: 30, fight: 70 },
          issuedAtTick: TICK,
        },
        {
          type: 'SetBehaviorRatio',
          colonyId: 999,
          ratio: { forage: 0, fight: 100 },
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('MarkDigTile — valid Solid, out-of-bounds, ceiling row, NaN', () => {
    expect(
      run([
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 20,
          tileY: 20,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID,
          tileX: -5,
          tileY: 10,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 30,
          tileY: UNDERGROUND_CEILING_ROW_Y,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID,
          tileX: Number.NaN,
          tileY: 12,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('MarkFoodPile — set + toggle the same tile twice', () => {
    expect(
      run([
        {
          type: 'MarkFoodPile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 40,
          tileY: 40,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkFoodPile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 40,
          tileY: 40,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('CancelDigMark — mark then cancel the same tile; cancel an unmarked tile', () => {
    expect(
      run([
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 22,
          tileY: 18,
          issuedAtTick: TICK,
        },
        {
          type: 'CancelDigMark',
          colonyId: PLAYER_COLONY_ID,
          tileX: 22,
          tileY: 18,
          issuedAtTick: TICK,
        },
        {
          type: 'CancelDigMark',
          colonyId: PLAYER_COLONY_ID,
          tileX: 50,
          tileY: 50,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('PlaceChamber — rejection gates (unreachable, ceiling overlap, NaN, nonexistent colony)', () => {
    expect(
      run([
        {
          type: 'PlaceChamber',
          colonyId: PLAYER_COLONY_ID,
          chamberType: ChamberType.Nursery,
          anchorTileX: 30,
          anchorTileY: 30,
          issuedAtTick: TICK,
        },
        {
          type: 'PlaceChamber',
          colonyId: PLAYER_COLONY_ID,
          chamberType: ChamberType.Queen,
          anchorTileX: 32,
          anchorTileY: UNDERGROUND_CEILING_ROW_Y,
          issuedAtTick: TICK,
        },
        {
          type: 'PlaceChamber',
          colonyId: PLAYER_COLONY_ID,
          chamberType: ChamberType.FoodStorage,
          anchorTileX: Number.NaN,
          anchorTileY: Number.NaN,
          issuedAtTick: TICK,
        },
        {
          type: 'PlaceChamber',
          colonyId: 999,
          chamberType: ChamberType.Nursery,
          anchorTileX: 10,
          anchorTileY: 10,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('DesignateEntrance — valid-ish surface tile + invalid (out-of-bounds)', () => {
    expect(
      run([
        {
          type: 'DesignateEntrance',
          colonyId: PLAYER_COLONY_ID,
          surfaceTileX: 64,
          surfaceTileY: 64,
          issuedAtTick: TICK,
        },
        {
          type: 'DesignateEntrance',
          colonyId: PLAYER_COLONY_ID,
          surfaceTileX: -1,
          surfaceTileY: 9999,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('SetRallyPoint then ClearRallyPoint', () => {
    expect(
      run([
        {
          type: 'SetRallyPoint',
          colonyId: PLAYER_COLONY_ID,
          tileX: 70,
          tileY: 60,
          issuedAtTick: TICK,
        },
        { type: 'ClearRallyPoint', colonyId: PLAYER_COLONY_ID, issuedAtTick: TICK },
      ]),
    ).toMatchSnapshot();
  });

  it('SyncAIState — uncapped pre-pass (enemy colony)', () => {
    expect(
      run([
        {
          type: 'SyncAIState',
          issuedAtTick: TICK,
          colonyId: ENEMY_COLONY_ID,
          state: 'Probing',
          enteredTick: 5,
          probeCount: 2,
          lastProbeEndTick: 3,
          invasionStartTick: 0,
          invasionRallyTileX: 10,
          invasionRallyTileY: 10,
          recoveryEndTick: 0,
          operationKind: 'Probe',
          operationStartTick: 4,
          operationTargetTileX: 12,
          operationTargetTileY: 12,
          operationFighterIds: [],
          operationFighterCount: 0,
          operationStartFighterCount: 0,
          operationAttackerDeaths: 0,
          operationDefenderDeaths: 0,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('StartAIOperation — emits events (enemy colony)', () => {
    expect(
      run([
        {
          type: 'StartAIOperation',
          colonyId: ENEMY_COLONY_ID,
          kind: 'Probe',
          rallyTileX: 64,
          rallyTileY: 64,
          fighterIds: [],
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('MarkSpiderPriority — toggle on then off', () => {
    expect(
      run([
        {
          type: 'MarkSpiderPriority',
          colonyId: PLAYER_COLONY_ID,
          isPriority: true,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkSpiderPriority',
          colonyId: PLAYER_COLONY_ID,
          isPriority: false,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('unknown variant — silent-dropped by the exhaustive default', () => {
    expect(run([UNKNOWN, { type: 'NoOp', issuedAtTick: TICK }])).toMatchSnapshot();
  });

  it('interleaved Sync/non-Sync batch > 64 — cap drops non-Sync past 64, Sync all apply', () => {
    const cmds: SimCommand[] = [];
    for (let i = 0; i < 70; i++) {
      // distinct dig tiles so the cap boundary is observable in the underground hash
      cmds.push({
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID,
        tileX: i + 5,
        tileY: 25,
        issuedAtTick: TICK,
      });
      if (i % 5 === 0) {
        cmds.push({
          type: 'SyncAIState',
          issuedAtTick: TICK,
          colonyId: ENEMY_COLONY_ID,
          state: 'Peacetime',
          enteredTick: i,
          probeCount: 0,
          lastProbeEndTick: 0,
          invasionStartTick: 0,
          invasionRallyTileX: 0,
          invasionRallyTileY: 0,
          recoveryEndTick: 0,
          operationKind: 'None',
          operationStartTick: 0,
          operationTargetTileX: 0,
          operationTargetTileY: 0,
          operationFighterIds: [],
          operationFighterCount: 0,
          operationStartFighterCount: 0,
          operationAttackerDeaths: 0,
          operationDefenderDeaths: 0,
        });
      }
    }
    expect(run(cmds)).toMatchSnapshot();
  });

  it('mixed sequence — ratio + dig + food + rally + spider in one batch', () => {
    expect(
      run([
        {
          type: 'SetBehaviorRatio',
          colonyId: PLAYER_COLONY_ID,
          ratio: { forage: 50, fight: 50 },
          issuedAtTick: TICK,
        },
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 15,
          tileY: 15,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkFoodPile',
          colonyId: PLAYER_COLONY_ID,
          tileX: 80,
          tileY: 80,
          issuedAtTick: TICK,
        },
        {
          type: 'SetRallyPoint',
          colonyId: PLAYER_COLONY_ID,
          tileX: 66,
          tileY: 66,
          issuedAtTick: TICK,
        },
        {
          type: 'MarkSpiderPriority',
          colonyId: PLAYER_COLONY_ID,
          isPriority: true,
          issuedAtTick: TICK,
        },
      ]),
    ).toMatchSnapshot();
  });

  it('empty batch (no commands)', () => {
    expect(run([])).toMatchSnapshot();
  });
});
