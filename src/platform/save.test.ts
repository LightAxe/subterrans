/* @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SAVE_FORMAT_VERSION,
  SAVE_KEY,
  AUTOSAVE_INTERVAL_MS,
  serializeWorldState,
  deserializeWorldState,
  hasSave,
  loadSave,
  deleteSave,
  tickAutosave,
  manualSave,
  hasIncompatibleSave,
  classifySaveCompatibility,
  getSaveInfo,
  parseSaveFile,
  FutureSimVersionError,
  OldSimVersionError,
  SaveVersionMismatchError,
  unpackBakedSurfaceEffect,
  type SaveFile,
} from './save.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
} from '../sim/constants.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';
import { pheromoneKeyIsSurface } from '../sim/pheromone/pheromone-store.js';

describe('save.ts (SCEN-04 + SCEN-06)', () => {
  // Use window.localStorage to ensure jsdom's implementation (not Node 25 native localStorage)
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('serializeWorldState — envelope coverage', () => {
    it('includes every WorldState field (tick, rngState, nextEntityId, commandQueue, ants, colonies, pheromoneGrids, surface, undergroundGrids, foodPiles, pendingChambers)', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      expect(s.tick).toBe(0);
      expect(typeof s.rngState).toBe('number');
      expect(typeof s.nextEntityId).toBe('number');
      expect(Array.isArray(s.commandQueue)).toBe(true);
      expect(s.ants).toBeDefined();
      expect(s.colonies[String(PLAYER_COLONY_ID)]).toBeDefined();
      expect(s.surface.data.length).toBeGreaterThan(0);
      expect(s.undergroundGrids[String(PLAYER_COLONY_ID)]).toBeDefined();
    });
    it('serializes all 18 Int32Array ant fields as number[] (NOT "{}")', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const fields = [
        'posX',
        'posY',
        'colonyId',
        'task',
        'subTask',
        'speed',
        'foodCarrying',
        'starvationTimer',
        'age',
        'alive',
        'lifespan',
        'zone',
        'digTileX',
        'digTileY',
        'digTicksRemaining',
        'targetPosX',
        'targetPosY',
        'searchWave',
      ] as const;
      for (const f of fields) {
        expect(Array.isArray(s.ants[f])).toBe(true);
        expect(s.ants[f].length).toBeGreaterThan(0);
      }
    });
    it('serializes every Uint8Array grid .data as number[]', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      expect(Array.isArray(s.surface.data)).toBe(true);
      for (const cid of Object.keys(s.undergroundGrids)) {
        expect(Array.isArray(s.undergroundGrids[cid]!.data)).toBe(true);
      }
    });
    it('includes commandQueue (Pitfall 7 — autosave fires on wall clock, not tick boundary)', () => {
      const w = createScenario(42);
      w.commandQueue.push({
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID as ColonyId,
        tileX: 3,
        tileY: 4,
        issuedAtTick: 0,
      });
      const s = serializeWorldState(w);
      expect(s.commandQueue.length).toBe(1);
      expect(s.commandQueue[0]).toMatchObject({ type: 'MarkDigTile', tileX: 3, tileY: 4 });
    });
    it('uses Object.entries for colonies (plain-object invariant, ADR-0006)', () => {
      // No runtime check on implementation detail — prove by not throwing when world.colonies is a plain object.
      const w = createScenario(42);
      expect(() => serializeWorldState(w)).not.toThrow();
      // Additionally: make sure the output keys match Object.keys(world.colonies)
      const s = serializeWorldState(w);
      expect(Object.keys(s.colonies).sort()).toEqual(Object.keys(w.colonies).sort());
    });
    it('preserves ColonyRecord.killCount (Plan 01)', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.killCount = 7;
      const s = serializeWorldState(w);
      expect(s.colonies[String(PLAYER_COLONY_ID)]!.killCount).toBe(7);
    });
    it('preserves rallyPoint / entrances / digFlowFieldDirty', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.rallyPoint = { tileX: 10, tileY: 20 };
      const s = serializeWorldState(w);
      expect(s.colonies[String(PLAYER_COLONY_ID)]!.rallyPoint).toEqual({ tileX: 10, tileY: 20 });
    });
    it('preserves ColonyRecord.priorityFoodPileId (Phase 9 / PRD §3d — per-colony priority food target)', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId = 123;
      const s = serializeWorldState(w);
      expect(s.colonies[String(PLAYER_COLONY_ID)]!.priorityFoodPileId).toBe(123);
    });
    it('preserves ColonyRecord.priorityFoodPileId=null (no active priority target)', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId = null;
      const s = serializeWorldState(w);
      expect(s.colonies[String(PLAYER_COLONY_ID)]!.priorityFoodPileId).toBeNull();
    });
    it('preserves ColonyRecord.foodFlowFieldDirty (issue #15)', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.foodFlowFieldDirty = true;
      const s = serializeWorldState(w);
      expect(s.colonies[String(PLAYER_COLONY_ID)]!.foodFlowFieldDirty).toBe(true);
    });
  });

  describe('deserializeWorldState — round-trip', () => {
    it('round-trip: serialize → deserialize → re-serialize produces identical JSON (byte-for-byte)', () => {
      const w = createScenario(42);
      for (let t = 0; t < 50; t++) tick(w, []); // some non-trivial state
      const s1 = JSON.stringify(serializeWorldState(w));
      const w2 = deserializeWorldState(JSON.parse(s1));
      const s2 = JSON.stringify(serializeWorldState(w2));
      expect(s2).toBe(s1);
    });
    it('#243: the save still emits a pathErr zeros vestige (forward-compat for older builds)', () => {
      // The RUNTIME pathErr field is deleted, but the save format keeps a zeros
      // array so an older build (which still reads the key via copyIntoInt32) never
      // chokes on a missing field and deleteSave()s a newer-build save — including
      // migrated saves that keep their in-window sticky simVersion. This is the key
      // property: every window-stamped save carries every key the deployed
      // deserializer requires. Reap the vestige once MIN_ACCEPTED > V32.
      const w = createScenario(42);
      const s = serializeWorldState(w);
      expect('pathErr' in s.ants).toBe(true);
      // Pin length against the serialized `count` (the capacity anchor the LOADER
      // uses), not the impl's own `a.posX.length` — catches a capacity-coupling regression.
      expect(s.ants.pathErr.length).toBe(s.ants.count);
      expect(s.ants.pathErr.every((v) => v === 0)).toBe(true);
    });
    it('#243: deserialize ignores the pathErr vestige and never lets its values leak back out', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // Non-zero pathErr (as a legacy save could carry) must be ignored, not read
      // into any runtime state — the field no longer exists at runtime.
      const withValues = {
        ...s,
        ants: { ...s.ants, pathErr: new Array<number>(s.ants.count).fill(7) },
      };
      expect(() => deserializeWorldState(withValues)).not.toThrow();
      const w2 = deserializeWorldState(withValues);
      expect(Array.from(w2.ants.posX.slice(0, 5))).toEqual(Array.from(w.ants.posX.slice(0, 5)));
      // The 7s must not survive a re-serialize — the runtime field is gone, so the
      // emitted vestige is unconditionally zeros (write-only proven end-to-end).
      const reserialized = serializeWorldState(w2);
      expect(reserialized.ants.pathErr.every((v) => v === 0)).toBe(true);
    });
    it('rehydrates every Int32Array ant field with correct values', () => {
      const w = createScenario(42);
      for (let t = 0; t < 10; t++) tick(w, []);
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(s);
      expect(Array.from(w2.ants.posX.slice(0, 5))).toEqual(Array.from(w.ants.posX.slice(0, 5)));
      expect(Array.from(w2.ants.alive.slice(0, 5))).toEqual(Array.from(w.ants.alive.slice(0, 5)));
      expect(Array.from(w2.ants.zone.slice(0, 5))).toEqual(Array.from(w.ants.zone.slice(0, 5)));
    });
    it('preserves queued commands through serialize → deserialize', () => {
      const w = createScenario(42);
      w.commandQueue.push({
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID as ColonyId,
        tileX: 1,
        tileY: 2,
        issuedAtTick: 0,
      });
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.commandQueue.length).toBe(1);
      expect(w2.commandQueue[0]).toMatchObject({ type: 'MarkDigTile', tileX: 1, tileY: 2 });
    });
    it('round-trips ColonyRecord.priorityFoodPileId through serialize → deserialize (non-null)', () => {
      // Phase 9 regression guard: the priority food target lives on ColonyRecord
      // (moved off the shared FoodPile record). If this field is omitted from
      // the save envelope, Continue/autosave silently drops the player's
      // selected food target.
      const w = createScenario(42);
      const pileId = w.foodPiles[0]!.foodPileId;
      w.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId = pileId;
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId).toBe(pileId);
    });
    it('round-trips ColonyRecord.priorityFoodPileId=null through serialize → deserialize', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId = null;
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId).toBeNull();
    });
    it('round-trips ColonyRecord.foodFlowFieldDirty through serialize → deserialize (issue #15)', () => {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.foodFlowFieldDirty = true;
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.colonies[PLAYER_COLONY_ID]!.foodFlowFieldDirty).toBe(true);
    });

    it('round-trips per-chamber chamber.foodStored independently (issue #15)', () => {
      // Issue #15 regression: under the old pool-only model, save + reload
      // would re-derive chamber.foodStored from colony.foodStored at the next
      // reconcile, hiding any per-chamber drift. Post-#15, chamber.foodStored
      // is authoritative — the save MUST faithfully preserve each chamber's
      // contents, including disparate values across chambers.
      const w = createScenario(42);
      const colony = w.colonies[PLAYER_COLONY_ID]!;
      // Canonical FoodStorage dims: 4×3 (CHAMBER_DIMENSIONS[FoodStorage]).
      // Issue #101 boundary validator now enforces these.
      colony.chambers.push({
        chamberId: 999,
        chamberType: ChamberType.FoodStorage,
        foodStored: 1234,
        posX: 10 << 8,
        posY: 5 << 8,
        width: 4,
        height: 3,
      });
      colony.chambers.push({
        chamberId: 998,
        chamberType: ChamberType.FoodStorage,
        foodStored: 4321,
        posX: 16 << 8,
        posY: 5 << 8,
        width: 4,
        height: 3,
      });
      const w2 = deserializeWorldState(serializeWorldState(w));
      const c2 = w2.colonies[PLAYER_COLONY_ID]!;
      const ch1 = c2.chambers.find((c) => c.chamberId === 999)!;
      const ch2 = c2.chambers.find((c) => c.chamberId === 998)!;
      expect(ch1.foodStored).toBe(1234);
      expect(ch2.foodStored).toBe(4321);
    });
    it('round-trips non-zero ants.searchWave through serialize → deserialize (Phase 9 / 09 digger-reassignment memo)', () => {
      // Regression guard: if searchWave is dropped, Continue/autosave silently
      // resets all foragers to base wave 0, changing post-load leash behavior
      // vs. the pre-save session.
      const w = createScenario(42);
      w.ants.searchWave[0] = 3; // MAX wave
      w.ants.searchWave[1] = 1;
      w.ants.searchWave[2] = 2;
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.ants.searchWave[0]).toBe(3);
      expect(w2.ants.searchWave[1]).toBe(1);
      expect(w2.ants.searchWave[2]).toBe(2);
    });

    it('Issue #17 Phase 1: round-trips ants.carryingBroodId and carriedBy through serialize → deserialize', () => {
      // Regression guard: if either field is dropped, an autosaved snapshot
      // mid-carry would land all carries at the carrier's last position
      // (because the renderer position-syncs the brood to the carrier each
      // tick) but with the carry slot cleared — the brood would teleport
      // back to its idle position on the next tick. SCEN-06 byte-identity
      // would also break across reload.
      const w = createScenario(42);
      w.ants.carryingBroodId[0] = 7;
      w.ants.carriedBy[7] = 0;
      w.ants.carryingBroodId[1] = -1;
      w.ants.carriedBy[1] = -1;
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.ants.carryingBroodId[0]).toBe(7);
      expect(w2.ants.carriedBy[7]).toBe(0);
      expect(w2.ants.carryingBroodId[1]).toBe(-1);
      expect(w2.ants.carriedBy[1]).toBe(-1);
    });

    it('round-trips ants.currentGridColonyId through serialize → deserialize (Phase 09.1 Chunk 0 grid-of-occupancy)', () => {
      // Regression guard for the phase 09.1 verification gap: if
      // currentGridColonyId is dropped from the save envelope, every loaded
      // ant's grid byte zeros out. Enemy ants (colonyId=ENEMY_COLONY_ID=2)
      // would then silently target the player's underground grid on every
      // lookup, and a Fighter invader mid-attack (currentGridColonyId !=
      // colonyId) would snap back to its home grid on load. Cover all three
      // shapes: normal player ant, normal enemy ant, and invader.
      const w = createScenario(42);
      // createScenario already spawns ants in both colonies via initAnt, which
      // sets currentGridColonyId === colonyId. Confirm the precondition by
      // picking two alive ants from the scenario.
      const playerQueen = w.colonies[PLAYER_COLONY_ID]!.queenEntityId;
      const enemyQueen = w.colonies[ENEMY_COLONY_ID]!.queenEntityId;
      expect(w.ants.alive[playerQueen]).toBe(1);
      expect(w.ants.alive[enemyQueen]).toBe(1);
      expect(w.ants.colonyId[playerQueen]).toBe(PLAYER_COLONY_ID);
      expect(w.ants.colonyId[enemyQueen]).toBe(ENEMY_COLONY_ID);
      expect(w.ants.currentGridColonyId[playerQueen]).toBe(PLAYER_COLONY_ID);
      expect(w.ants.currentGridColonyId[enemyQueen]).toBe(ENEMY_COLONY_ID);
      // Synthesize a Fighter invader: a player-owned ant whose grid byte
      // points at the enemy grid (simulating the mid-invasion state Chunks
      // 3+4 of 09.1 will produce at runtime).
      const playerInvader = w.colonies[PLAYER_COLONY_ID]!.workers[0]!;
      expect(w.ants.alive[playerInvader]).toBe(1);
      expect(w.ants.colonyId[playerInvader]).toBe(PLAYER_COLONY_ID);
      w.ants.currentGridColonyId[playerInvader] = ENEMY_COLONY_ID;

      const s1 = JSON.stringify(serializeWorldState(w));
      const w2 = deserializeWorldState(JSON.parse(s1));

      // Alive ants: grid byte survives the round-trip untouched.
      expect(w2.ants.currentGridColonyId[playerQueen]).toBe(PLAYER_COLONY_ID);
      expect(w2.ants.currentGridColonyId[enemyQueen]).toBe(ENEMY_COLONY_ID);
      expect(w2.ants.currentGridColonyId[playerInvader]).toBe(ENEMY_COLONY_ID);
    });
    it('round-trips simVersion (LATEST: v10 visible brood carry)', async () => {
      const { LATEST_SIM_VERSION, SIM_VERSION_V7_SURFACE_PASSABILITY } =
        await import('../sim/types.js');
      // New worlds default to LATEST_SIM_VERSION. Save/load must preserve
      // it so any LATEST replay continues to apply the gated behaviour
      // (currently surface passability, soft cost, leash hysteresis,
      // cancel-drops-pending, and visible brood carry) on resume.
      const w = createScenario(42);
      expect(w.simVersion).toBe(LATEST_SIM_VERSION);
      // Sanity-check that LATEST is at least v7 — anything lower would
      // silently regress the #44 surface-passability behaviour.
      expect(w.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V7_SURFACE_PASSABILITY);
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(JSON.parse(JSON.stringify(s)));
      expect(w2.simVersion).toBe(LATEST_SIM_VERSION);
    });

    it('round-trips world.terrainSeed (issue #44)', () => {
      const w = createScenario(42);
      // createWorldState set this from the seed; pin a specific value to
      // verify the field actually survives save/load (not just "happens to
      // recompute identically from the seed envelope field").
      w.terrainSeed = 0xdeadbeef;
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(JSON.parse(JSON.stringify(s)));
      expect(w2.terrainSeed).toBe(0xdeadbeef);
    });
    it('pre-issue-#44 saves (terrainSeed absent) deserialize with terrainSeed=0', async () => {
      // Pre-#44 saves have no terrainSeed field. Loading them must default
      // to 0 (which reproduces the legacy coordinate-only layout — no
      // crashes, just a different decoration set than the recorded run).
      const w = createScenario(42);
      const s = serializeWorldState(w);
      delete (s as { terrainSeed?: number }).terrainSeed;
      const w2 = deserializeWorldState(s);
      expect(w2.terrainSeed).toBe(0);
    });
    it('V20: round-trips world.spider, spiderPriorityColonyId, and scatterReticleTile through serialize → deserialize', async () => {
      const { SIM_VERSION_V20_SPIDER } = await import('../sim/types.js');
      const w = createScenario(42);
      expect(w.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V20_SPIDER);
      const spider = w.spider!;
      spider.state = 'Hunting';
      spider.huntTargetTileX = 55;
      spider.huntTargetTileY = 33;
      spider.hungerTicks = 300;
      spider.killsThisStrike = 2;
      w.spiderPriorityColonyId = PLAYER_COLONY_ID;
      w.scatterReticleTile = { x: 10, y: 20 };

      const w2 = deserializeWorldState(serializeWorldState(w));

      expect(w2.spider).not.toBeNull();
      expect(w2.spider!.state).toBe('Hunting');
      expect(w2.spider!.huntTargetTileX).toBe(55);
      expect(w2.spider!.huntTargetTileY).toBe(33);
      expect(w2.spider!.hungerTicks).toBe(300);
      expect(w2.spider!.killsThisStrike).toBe(2);
      expect(w2.spiderPriorityColonyId).toBe(PLAYER_COLONY_ID);
      expect(w2.scatterReticleTile).toEqual({ x: 10, y: 20 });
    });

    it('V20: null spider (spider killed mid-game) round-trips through serialize → deserialize', () => {
      const w = createScenario(42);
      w.spider = null; // simulate spider having been killed
      w.spiderPriorityColonyId = null;
      w.scatterReticleTile = null;
      const w2 = deserializeWorldState(serializeWorldState(w));
      expect(w2.spider).toBeNull();
      expect(w2.spiderPriorityColonyId).toBeNull();
      expect(w2.scatterReticleTile).toBeNull();
    });

    it('V20: spider: null in a V20 save deserializes to null with priority and reticle also null (B11 coupling)', async () => {
      const { SIM_VERSION_V20_SPIDER } = await import('../sim/types.js');
      const w = createScenario(42);
      expect(w.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V20_SPIDER);
      const s = serializeWorldState(w);
      // Force spider null but leave priority/reticle non-null in the raw snapshot.
      (s as { spider: null }).spider = null;
      (s as { spiderPriorityColonyId: number }).spiderPriorityColonyId = PLAYER_COLONY_ID;
      (s as { scatterReticleTile: { x: number; y: number } }).scatterReticleTile = { x: 5, y: 5 };
      const w2 = deserializeWorldState(s);
      // B11: when spider is null, priority and reticle must also be null regardless of save data.
      expect(w2.spider).toBeNull();
      expect(w2.spiderPriorityColonyId).toBeNull();
      expect(w2.scatterReticleTile).toBeNull();
    });

    it('V20: spiderPriorityColonyId of Infinity, NaN, or float deserializes to null (B1 integer guard)', async () => {
      const { SIM_VERSION_V20_SPIDER } = await import('../sim/types.js');
      const w = createScenario(42);
      expect(w.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V20_SPIDER);
      const s = serializeWorldState(w);
      for (const bad of [Infinity, -Infinity, NaN, 1.5, -0.1]) {
        (s as { spiderPriorityColonyId: number }).spiderPriorityColonyId = bad;
        const w2 = deserializeWorldState(s);
        expect(w2.spiderPriorityColonyId).toBeNull();
      }
    });

    it('rejects non-integer terrainSeed (string, NaN, null, object) → falls back to 0 (issue #44 P2)', () => {
      const w = createScenario(42);
      const baseSnapshot = serializeWorldState(w);
      // Same boundary type-validation as simVersion: a hand-edited or
      // corrupted save with a non-integer terrainSeed must NOT propagate
      // into surface-features.tileHash (where it would XOR into the salt
      // and either NaN-poison or coerce to a surprising integer). Default
      // to 0 — same as a missing field.
      const cases: unknown[] = ['42', '', 'rng', null, NaN, {}, [], 1.5, true];
      for (const bad of cases) {
        const s = JSON.parse(JSON.stringify(baseSnapshot)) as Record<string, unknown>;
        s.terrainSeed = bad;
        const w2 = deserializeWorldState(
          s as unknown as Parameters<typeof deserializeWorldState>[0],
        );
        expect(w2.terrainSeed).toBe(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // PR 5 C-both — compact recentTiles pack/unpack round-trip + rejection
  // branches. The encoding is a flat number[] of records sorted by ascending
  // antId: `[antId, head, count, (slot, x, y)×count]`. unpackRecentTiles
  // throws on every malformed shape; without these tests a loosened bound or
  // a regression in the encoding would pass CI silently (the only prior
  // coverage lived in a repo-root test file excluded by vitest's
  // `src/**/*.test.ts` glob, so it never ran).
  // ---------------------------------------------------------------------------
  describe('recentTiles compact pack/unpack', () => {
    const RECENT_TILES_LEN = 12; // src/sim/ant/ant-store.ts
    const MAX_ENTITIES = 8192; // src/sim/constants.ts
    const SENTINEL = -1; // RECENT_TILES_SENTINEL

    // Seed a couple of ants' recent-tiles rings so packRecentTiles emits a
    // non-trivial stream (createScenario starts every ring sentinel-filled).
    // Uses ALIVE worker ids — packRecentTiles skips dead-but-allocated ants
    // (their rings are never read and would otherwise leak save size).
    function scenarioWithRecentTiles() {
      const w = createScenario(42);
      const [idA, idB] = w.colonies[PLAYER_COLONY_ID]!.workers as readonly number[];
      if (idA === undefined || idB === undefined) throw new Error('scenario lacks two workers');
      const set = (id: number, slot: number, x: number, y: number): void => {
        const base = id * RECENT_TILES_LEN;
        w.ants.recentTilesX[base + slot] = x;
        w.ants.recentTilesY[base + slot] = y;
      };
      set(idA, 0, 5, 6);
      set(idA, 2, 7, 8);
      w.ants.recentTilesHead[idA] = 3;
      set(idB, 1, 10, 20);
      w.ants.recentTilesHead[idB] = 1;
      return { w, idA, idB };
    }

    it('round-trips a populated ring exactly (slots, coords, head)', () => {
      const { w, idA, idB } = scenarioWithRecentTiles();
      const w2 = deserializeWorldState(serializeWorldState(w));
      const b1 = idA * RECENT_TILES_LEN;
      const b3 = idB * RECENT_TILES_LEN;
      expect(w2.ants.recentTilesX[b1 + 0]).toBe(5);
      expect(w2.ants.recentTilesY[b1 + 0]).toBe(6);
      expect(w2.ants.recentTilesX[b1 + 2]).toBe(7);
      expect(w2.ants.recentTilesY[b1 + 2]).toBe(8);
      expect(w2.ants.recentTilesHead[idA]).toBe(3);
      expect(w2.ants.recentTilesX[b3 + 1]).toBe(10);
      expect(w2.ants.recentTilesY[b3 + 1]).toBe(20);
      expect(w2.ants.recentTilesHead[idB]).toBe(1);
      // Slots not written stay sentinel.
      expect(w2.ants.recentTilesX[b1 + 1]).toBe(SENTINEL);
    });

    it('round-trips byte-for-byte through full serialize → deserialize → serialize', () => {
      const { w } = scenarioWithRecentTiles();
      const s1 = JSON.stringify(serializeWorldState(w));
      const w2 = deserializeWorldState(JSON.parse(s1));
      const s2 = JSON.stringify(serializeWorldState(w2));
      expect(s2).toBe(s1);
    });

    it('skips dead-but-allocated ants (populated ring on a dead ant is not serialized)', () => {
      // Regression: ids are never reused and dead rings are never read, but an
      // ant killed mid-Searching/CarryingFood keeps its populated ring forever.
      // Serializing it would grow every subsequent save monotonically.
      const { w, idA, idB } = scenarioWithRecentTiles();
      w.ants.alive[idA] = 0; // killed with a populated ring (e.g. spider combat)
      const w2 = deserializeWorldState(serializeWorldState(w));
      const b1 = idA * RECENT_TILES_LEN;
      expect(w2.ants.recentTilesX[b1 + 0]).toBe(SENTINEL);
      expect(w2.ants.recentTilesHead[idA]).toBe(0);
      // The surviving alive ant's ring still round-trips.
      expect(w2.ants.recentTilesX[idB * RECENT_TILES_LEN + 1]).toBe(10);
      expect(w2.ants.recentTilesHead[idB]).toBe(1);
    });

    // Build a valid serialized snapshot, then overwrite ants.recentTiles with a
    // tampered stream. Direct mutation of the serialized snapshot mirrors the
    // existing boundary-hardening tests in this file.
    function snapshotWithStream(stream: unknown): ReturnType<typeof serializeWorldState> {
      const s = serializeWorldState(createScenario(42));
      (s.ants as unknown as { recentTiles: unknown }).recentTiles = stream;
      return s;
    }

    it('rejects non-array stream', () => {
      expect(() => deserializeWorldState(snapshotWithStream({ bad: true }))).toThrow(
        'recentTiles: not an array',
      );
    });
    it('rejects truncated record header (fewer than 3 leading elements)', () => {
      expect(() => deserializeWorldState(snapshotWithStream([0, 1]))).toThrow(
        'recentTiles: truncated record header',
      );
    });
    it('rejects truncated record body (count exceeds remaining elements)', () => {
      // header [antId=0, head=0, count=2] promises 2 triples but supplies 1.
      expect(() => deserializeWorldState(snapshotWithStream([0, 0, 2, 0, 5, 6]))).toThrow(
        'recentTiles: truncated record body',
      );
    });
    it('rejects antId out of range (>= capacity)', () => {
      expect(() =>
        deserializeWorldState(snapshotWithStream([MAX_ENTITIES, 0, 1, 0, 5, 6])),
      ).toThrow(/antId .* out of range/);
    });
    it('rejects negative antId', () => {
      expect(() => deserializeWorldState(snapshotWithStream([-1, 0, 1, 0, 5, 6]))).toThrow(
        /antId .* out of range/,
      );
    });
    it('rejects non-integer antId', () => {
      expect(() => deserializeWorldState(snapshotWithStream([1.5, 0, 1, 0, 5, 6]))).toThrow(
        /antId .* out of range/,
      );
    });
    it('rejects antId not strictly ascending (duplicate / unsorted records)', () => {
      // two records for antId 1 — second one is not strictly greater.
      expect(() =>
        deserializeWorldState(snapshotWithStream([1, 0, 1, 0, 5, 6, 1, 0, 1, 1, 7, 8])),
      ).toThrow(/antId .* not strictly ascending/);
    });
    it('rejects head out of range', () => {
      expect(() =>
        deserializeWorldState(snapshotWithStream([0, RECENT_TILES_LEN, 1, 0, 5, 6])),
      ).toThrow(/head .* out of range/);
    });
    it('rejects count out of range (count = 0)', () => {
      expect(() => deserializeWorldState(snapshotWithStream([0, 0, 0]))).toThrow(
        /count .* out of range/,
      );
    });
    it('rejects count out of range (count > RECENT_TILES_LEN)', () => {
      expect(() => deserializeWorldState(snapshotWithStream([0, 0, RECENT_TILES_LEN + 1]))).toThrow(
        /count .* out of range/,
      );
    });
    it('rejects slot out of range', () => {
      expect(() =>
        deserializeWorldState(snapshotWithStream([0, 0, 1, RECENT_TILES_LEN, 5, 6])),
      ).toThrow(/slot .* out of range/);
    });
    it('rejects slot not strictly ascending within a record', () => {
      // two triples with slot 0 then slot 0 again.
      expect(() => deserializeWorldState(snapshotWithStream([0, 0, 2, 0, 5, 6, 0, 7, 8]))).toThrow(
        /slot .* not strictly ascending/,
      );
    });
    it('rejects x out of range', () => {
      expect(() => deserializeWorldState(snapshotWithStream([0, 0, 1, 0, 128, 6]))).toThrow(
        /x .* out of range/,
      );
    });
    it('rejects y out of range', () => {
      expect(() => deserializeWorldState(snapshotWithStream([0, 0, 1, 0, 5, 128]))).toThrow(
        /y .* out of range/,
      );
    });
  });

  describe('SaveFile envelope (PRD §8a: version + seed + inputLog + snapshot)', () => {
    it('hasSave returns false when localStorage empty', () => {
      expect(hasSave()).toBe(false);
    });
    it('hasSave returns true when valid envelope present', () => {
      const w = createScenario(42);
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 42,
          inputLog: [],
          snapshot: serializeWorldState(w),
        } satisfies SaveFile),
      );
      expect(hasSave()).toBe(true);
    });
    it('hasSave returns false on malformed JSON', () => {
      localStorage.setItem(SAVE_KEY, 'not-json');
      expect(hasSave()).toBe(false);
    });
    it('hasSave returns false on mismatched version', () => {
      const w = createScenario(42);
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: 999,
          seed: 42,
          inputLog: [],
          snapshot: serializeWorldState(w),
        }),
      );
      expect(hasSave()).toBe(false);
    });
    it('rejects v1 saves (issue #15 — chamber-authoritative food storage)', () => {
      // Pre-#15 saves stored the entire stockpile in `colony.foodStored`
      // and projected slices into `chamber.foodStored` on each reconcile.
      // Loading them under v2 would either double-count (slices + pool) or
      // silently truncate to BASE on the next reconcile. The version bump
      // forces the loader to reject the save and boot a fresh scenario,
      // which is the documented behaviour for breaking format changes.
      const w = createScenario(42);
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: 1,
          seed: 42,
          inputLog: [],
          snapshot: serializeWorldState(w),
        }),
      );
      expect(hasSave()).toBe(false);
      expect(loadSave()).toBeNull();
    });
    it('loadSave returns a SaveFile with seed + inputLog + snapshot fields', () => {
      const w = createScenario(42);
      const inputLog: SimCommand[] = [
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID as ColonyId,
          tileX: 5,
          tileY: 5,
          issuedAtTick: 10,
        },
      ];
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 42,
          inputLog,
          snapshot: serializeWorldState(w),
        } satisfies SaveFile),
      );
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.seed).toBe(42);
      expect(loaded!.inputLog.length).toBe(1);
      expect(loaded!.snapshot).toBeDefined();
    });
    it('loadSave returns null on malformed JSON (never throws)', () => {
      localStorage.setItem(SAVE_KEY, '{ bad }');
      expect(loadSave()).toBeNull();
    });
    it('deleteSave removes the key and does not throw on missing', () => {
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: serializeWorldState(createScenario(1)),
        }),
      );
      deleteSave();
      expect(localStorage.getItem(SAVE_KEY)).toBeNull();
      expect(() => deleteSave()).not.toThrow();
    });
  });

  describe('tickAutosave gating', () => {
    it('does not save before interval elapsed (returns lastSaveMs unchanged)', () => {
      const w = createScenario(42);
      const prev = 1000;
      const result = tickAutosave(42, [], w, prev, prev + AUTOSAVE_INTERVAL_MS - 1);
      expect(result).toBe(prev);
      expect(localStorage.getItem(SAVE_KEY)).toBeNull();
    });
    it('writes SaveFile after interval elapsed (returns nowMs)', () => {
      const w = createScenario(42);
      const now = AUTOSAVE_INTERVAL_MS + 500;
      const result = tickAutosave(42, [], w, 0, now);
      expect(result).toBe(now);
      const raw = localStorage.getItem(SAVE_KEY);
      expect(raw).not.toBeNull();
      const env = JSON.parse(raw!) as SaveFile;
      expect(env.version).toBe(SAVE_FORMAT_VERSION);
      expect(env.seed).toBe(42);
    });
    it('returns nowMs on setItem throw — honors cooldown to prevent retry storm (#80)', () => {
      const w = createScenario(42);
      // Spy on the actual localStorage instance (InMemoryStorage replaces Storage.prototype on Node 25)
      const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      try {
        const now = AUTOSAVE_INTERVAL_MS + 1;
        const result = tickAutosave(42, [], w, 0, now);
        // Pre-#80 returned 0 (lastSaveMs unchanged) → next frame instantly
        // satisfied the elapsed check and stormed setItem at 60 FPS.
        // Post-fix advances to nowMs so retry waits a full interval.
        expect(result).toBe(now);
      } finally {
        spy.mockRestore();
      }
    });
    it('after setItem throw, the next call within the interval is a no-op (cooldown observed)', () => {
      const w = createScenario(42);
      const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      try {
        const t1 = AUTOSAVE_INTERVAL_MS + 1;
        const lastSaveMs = tickAutosave(42, [], w, 0, t1);
        expect(spy).toHaveBeenCalledTimes(1);
        // Half an interval later — cooldown should suppress the retry.
        const t2 = t1 + AUTOSAVE_INTERVAL_MS / 2;
        const result = tickAutosave(42, [], w, lastSaveMs, t2);
        expect(spy).toHaveBeenCalledTimes(1); // no second attempt
        expect(result).toBe(lastSaveMs);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('SCEN-06 replay truth — seed + inputLog reproduce snapshot', () => {
    it('(a) seed round-trips', () => {
      const w = createScenario(777);
      tickAutosave(777, [], w, 0, AUTOSAVE_INTERVAL_MS + 1);
      expect(loadSave()!.seed).toBe(777);
    });
    it('(b) inputLog round-trips', () => {
      const w = createScenario(42);
      const log: SimCommand[] = [
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID as ColonyId,
          tileX: 2,
          tileY: 2,
          issuedAtTick: 1,
        },
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID as ColonyId,
          tileX: 3,
          tileY: 3,
          issuedAtTick: 5,
        },
      ];
      tickAutosave(42, log, w, 0, AUTOSAVE_INTERVAL_MS + 1);
      const loaded = loadSave()!;
      expect(loaded.inputLog.length).toBe(2);
      expect(loaded.inputLog[1]).toMatchObject({ tileX: 3, tileY: 3 });
    });
    it('(c) queued unprocessed commands round-trip via snapshot.commandQueue', () => {
      const w = createScenario(42);
      w.commandQueue.push({
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID as ColonyId,
        tileX: 9,
        tileY: 9,
        issuedAtTick: 0,
      });
      tickAutosave(42, [], w, 0, AUTOSAVE_INTERVAL_MS + 1);
      const loaded = loadSave()!;
      expect(loaded.snapshot.commandQueue.length).toBe(1);
      expect(loaded.snapshot.commandQueue[0]).toMatchObject({ tileX: 9, tileY: 9 });
    });
    it('(d) loaded snapshot when re-serialized equals original (byte-for-byte)', () => {
      const w = createScenario(42);
      for (let t = 0; t < 25; t++) tick(w, []);
      tickAutosave(42, [], w, 0, AUTOSAVE_INTERVAL_MS + 1);
      const loaded = loadSave()!;
      const rebuilt = deserializeWorldState(loaded.snapshot);
      expect(JSON.stringify(serializeWorldState(rebuilt))).toBe(
        JSON.stringify(serializeWorldState(w)),
      );
    });
    it('(e) inputLog replay: createScenario(seed) + tick(cmds[t]) for each tick reproduces snapshot', () => {
      // Build a reference world with a deterministic schedule
      const seed = 42;
      const schedule: SimCommand[][] = [];
      schedule[10] = [
        {
          type: 'MarkDigTile',
          colonyId: PLAYER_COLONY_ID as ColonyId,
          tileX: 7,
          tileY: 3,
          issuedAtTick: 10,
        },
      ];

      // Play 50 ticks while appending each tick's commands to inputLog (render-layer pattern)
      const original = createScenario(seed);
      const inputLog: SimCommand[] = [];
      for (let t = 0; t < 50; t++) {
        const cmds = schedule[t] ?? [];
        inputLog.push(...cmds);
        tick(original, cmds);
      }

      // Save
      tickAutosave(seed, inputLog, original, 0, AUTOSAVE_INTERVAL_MS + 1);
      const loaded = loadSave()!;
      expect(loaded.seed).toBe(seed);

      // Replay inputLog against a fresh scenario — use issuedAtTick to schedule
      const replay = createScenario(loaded.seed);
      const byTick: SimCommand[][] = [];
      for (const cmd of loaded.inputLog) {
        const t = cmd.issuedAtTick;
        (byTick[t] ??= []).push(cmd);
      }
      for (let t = 0; t < 50; t++) tick(replay, byTick[t] ?? []);

      expect(JSON.stringify(serializeWorldState(replay))).toBe(
        JSON.stringify(serializeWorldState(original)),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10 / WR-09 — inputLog SetBehaviorRatio migration on load
  //
  // SCEN-06 requires that `createScenario(seed) + tick(cmds[t])` reproduce the
  // loaded snapshot. Pre-Phase-10 v2 saves (issue #15 → Phase 10 transition)
  // can carry SetBehaviorRatio entries shaped as `{forage, dig, fight}` in
  // their inputLog. Replaying those verbatim under post-Phase-10 code would
  // silently drop the dig weight and (for pure-dig players) collapse to an
  // idle command. parseSaveFile walks inputLog and applies the same migration
  // semantics as deserializeColony's targetRatio: drop dig, snap all-zero
  // remainder to {forage:10, fight:0}, leave already-migrated entries alone.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Issue #82 — commandQueue migration parity.
  // parseSaveFile already migrates inputLog. Pre-fix code preserved
  // snapshot.commandQueue verbatim, which meant code paths that read
  // world.commandQueue directly (debug tools, tests, future remote
  // surfaces) would see legacy {forage, dig, fight} shapes until the
  // dispatcher consumed them. The fix runs migrateInputLogCommand on
  // each queued command at deserialize time too.
  // ---------------------------------------------------------------------------
  describe('Issue #82 — commandQueue migration on deserialize', () => {
    it('non-SetBehaviorRatio commandQueue entries pass through unchanged', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.commandQueue as unknown as Array<unknown>).push({
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID,
        tileX: 7,
        tileY: 3,
        issuedAtTick: 0,
      });
      const world = deserializeWorldState(s);
      expect(world.commandQueue[0]).toMatchObject({ type: 'MarkDigTile', tileX: 7, tileY: 3 });
    });
    it('post-Phase-10 commandQueue entry passes through unchanged (idempotent)', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.commandQueue as unknown as Array<unknown>).push({
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID,
        ratio: { forage: 7, fight: 3 },
        issuedAtTick: 5,
      });
      const world = deserializeWorldState(s);
      const cmd = world.commandQueue[0] as { ratio: unknown };
      expect(cmd.ratio).toEqual({ forage: 7, fight: 3 });
    });
  });

  describe('Phase 10 / WR-09 — inputLog migration on load', () => {
    function writeSave(file: {
      version: number;
      seed: number;
      inputLog: unknown[];
      snapshot: unknown;
    }): void {
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
    }

    it('post-Phase-10 entry without dig field passes through unchanged (including idle {0,0})', () => {
      const w = createScenario(42);
      const modernIdle: SimCommand = {
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID as ColonyId,
        ratio: { forage: 0, fight: 0 },
        issuedAtTick: 7,
      };
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: [modernIdle],
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave()!;
      expect((loaded.inputLog[0] as { ratio: unknown }).ratio).toEqual({ forage: 0, fight: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #65 — boundary validation for s.ants.count.
  // Pre-fix code accepted any positive number (1e9, Infinity), which flowed
  // into createAntComponents and allocated ~25 TypedArrays of that length —
  // a memory-DoS vector on save load.
  // ---------------------------------------------------------------------------
  describe('Issue #65 — ants.count boundary validation', () => {
    function makeSavedSnapshot(
      mut: (s: ReturnType<typeof serializeWorldState>) => void,
    ): ReturnType<typeof serializeWorldState> {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      mut(s);
      return s;
    }

    it('accepts count = 0 (legacy fallback to MAX_ENTITIES)', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = 0;
      });
      const w = deserializeWorldState(snapshot);
      // Capacity falls back to MAX_ENTITIES, which is the alive array length.
      expect(w.ants.alive.length).toBe(8192);
    });
    it('accepts a small positive integer count', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = 8;
      });
      expect(() => deserializeWorldState(snapshot)).not.toThrow();
    });
    it('rejects count > MAX_ENTITIES (memory-DoS guard)', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = 1_000_000_000;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('exact boundary: count = MAX_ENTITIES is accepted', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = 8192;
      });
      const w = deserializeWorldState(snapshot);
      expect(w.ants.alive.length).toBe(8192);
    });
    it('exact boundary: count = MAX_ENTITIES + 1 is rejected', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = 8193;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('rejects negative count', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = -1;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('rejects non-integer count', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = 1.5;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('rejects NaN count', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = NaN;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('rejects Infinity count', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.ants.count = Infinity;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('rejects non-number count (string)', () => {
      const snapshot = makeSavedSnapshot((s) => {
        (s.ants as unknown as { count: unknown }).count = '1e9';
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
    it('rejects null count (most likely tampered shape — JSON omission)', () => {
      const snapshot = makeSavedSnapshot((s) => {
        (s.ants as unknown as { count: unknown }).count = null;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(/Invalid ants\.count/);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #66 — boundary validation for s.simVersion.
  // Pre-fix code accepted any integer, including 99999 (every gate evaluates
  // true forever) and -1 (every gate false). Both silently break the
  // sticky-on-load determinism contract for tampered saves.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Issue #59 — boundary validation for nextEntityId.
  // Codex follow-up on #65: saves should reject snapshots whose
  // nextEntityId exceeds component capacity. The new allocateEntityId
  // soft-caps at MAX_ENTITIES, so a legitimate save can have
  // nextEntityId === MAX_ENTITIES; anything above is tampered.
  // ---------------------------------------------------------------------------
  describe('Issue #59 — nextEntityId boundary validation', () => {
    // Use spread+override rather than mutation: the FNDN-07 tripwire bans
    // direct `obj.nextEntityId = ...` assignment AST shapes even on
    // serialized snapshots, but spread syntax assembles a fresh object
    // and is invisible to that selector.
    function snapshotWith(nextEntityId: number): ReturnType<typeof serializeWorldState> {
      return { ...serializeWorldState(createScenario(42)), nextEntityId };
    }

    it('accepts nextEntityId in range', () => {
      expect(() => deserializeWorldState(snapshotWith(100))).not.toThrow();
    });
    it('accepts nextEntityId = 0 (fresh-scenario boundary)', () => {
      expect(() => deserializeWorldState(snapshotWith(0))).not.toThrow();
    });
    it('accepts nextEntityId = MAX_ENTITIES (saturated counter)', () => {
      expect(() => deserializeWorldState(snapshotWith(8192))).not.toThrow();
    });
    it('rejects nextEntityId > MAX_ENTITIES', () => {
      expect(() => deserializeWorldState(snapshotWith(8193))).toThrow(/Invalid nextEntityId/);
    });
    it('rejects negative nextEntityId', () => {
      expect(() => deserializeWorldState(snapshotWith(-1))).toThrow(/Invalid nextEntityId/);
    });
    it('rejects non-integer nextEntityId', () => {
      expect(() => deserializeWorldState(snapshotWith(1.5))).toThrow(/Invalid nextEntityId/);
    });
    it('rejects NaN/Infinity nextEntityId', () => {
      expect(() => deserializeWorldState(snapshotWith(NaN))).toThrow(/Invalid nextEntityId/);
      expect(() => deserializeWorldState(snapshotWith(Infinity))).toThrow(/Invalid nextEntityId/);
    });
  });

  describe('Issue #66 — simVersion boundary validation', () => {
    function makeSavedSnapshot(
      mut: (s: ReturnType<typeof serializeWorldState>) => void,
    ): ReturnType<typeof serializeWorldState> {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      mut(s);
      return s;
    }

    it('accepts simVersion = LATEST', () => {
      // LATEST_SIM_VERSION is 10 today; the value is whatever serializeWorldState
      // wrote out for a fresh scenario.
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const latest = s.simVersion;
      const out = deserializeWorldState(s);
      expect(out.simVersion).toBe(latest);
    });
    it('rejects simVersion above LATEST with FutureSimVersionError (recoverable signal)', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.simVersion = 99999;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(FutureSimVersionError);
    });
    it('future simVersion takes precedence over count check (a future build can legitimately bump MAX_ENTITIES)', () => {
      // Verifies validation ordering: a save from a hypothetical future build
      // that both bumped simVersion AND raised MAX_ENTITIES should be
      // classified as recoverable (FutureSimVersionError → bootFromSave
      // preserves bytes), not as tampering (plain Error → deleteSave).
      const snapshot = makeSavedSnapshot((s) => {
        s.simVersion = 99999;
        s.ants.count = 1_000_000; // would be tampering at current LATEST, but
        // simVersion=99999 means we don't know our
        // own MAX_ENTITIES governs this save.
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(FutureSimVersionError);
    });
    it('future simVersion takes precedence over ants-shape guard (future build may restructure layout)', () => {
      // A future build could split `s.ants` into per-colony arrays or
      // otherwise restructure the layout. Older builds must classify that
      // as recoverable (FutureSimVersionError → preserve), not as tampering
      // (plain "Invalid save shape" → deleteSave).
      // Build a snapshot-shaped object directly rather than mutating the
      // serialized result (FNDN-07 tripwire forbids direct sim-state writes
      // even on serialized snapshots — this is a hand-constructed tamper).
      const snapshot = {
        ...serializeWorldState(createScenario(42)),
        simVersion: 99999,
        ants: null as unknown as ReturnType<typeof serializeWorldState>['ants'],
      };
      expect(() => deserializeWorldState(snapshot)).toThrow(FutureSimVersionError);
    });
    it('rejects negative simVersion (all-gates-off guard)', () => {
      const snapshot = makeSavedSnapshot((s) => {
        s.simVersion = -1;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(OldSimVersionError);
    });
    it('exact boundary: simVersion = LATEST + 1 throws FutureSimVersionError (recoverable)', () => {
      // LATEST_SIM_VERSION is whatever the current sim writes for a fresh
      // scenario; the value is captured here to keep the test version-agnostic.
      const w = createScenario(42);
      const latest = serializeWorldState(w).simVersion;
      const snapshot = makeSavedSnapshot((s) => {
        s.simVersion = latest + 1;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(FutureSimVersionError);
    });
    it('exact boundary: simVersion = MIN_ACCEPTED - 1 throws OldSimVersionError', () => {
      // Any simVersion below MIN_ACCEPTED_SIM_VERSION (28 as of PR 4) is rejected
      // with OldSimVersionError so bootFromSave can handle it appropriately.
      const snapshot = makeSavedSnapshot((s) => {
        s.simVersion = 1;
      });
      expect(() => deserializeWorldState(snapshot)).toThrow(OldSimVersionError);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #78 — migrateInputLogCommand and migrateBehaviorRatio resilience.
  // Pre-fix code did `'dig' in ratioRaw` directly, which throws TypeError
  // for null / undefined / primitive ratios. parseSaveFile is wrapped in
  // a swallowing try/catch, so a single malformed command was escalating
  // to total save loss (the whole envelope returned null → bootFresh).
  // ---------------------------------------------------------------------------
  describe('Issue #78 — malformed BehaviorRatio resilience on load', () => {
    function writeSave(file: {
      version: number;
      seed: number;
      inputLog: unknown[];
      snapshot: unknown;
    }): void {
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
    }

    it('null ratio in inputLog: save still loads (command preserved verbatim)', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: [
          { type: 'SetBehaviorRatio', colonyId: PLAYER_COLONY_ID, ratio: null, issuedAtTick: 0 },
        ],
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.inputLog.length).toBe(1);
      expect((loaded!.inputLog[0] as { ratio: unknown }).ratio).toBeNull();
    });
    it('numeric ratio in inputLog: save still loads', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: [
          { type: 'SetBehaviorRatio', colonyId: PLAYER_COLONY_ID, ratio: 5, issuedAtTick: 0 },
        ],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).not.toBeNull();
    });
    it('string ratio in inputLog: save still loads', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: [
          { type: 'SetBehaviorRatio', colonyId: PLAYER_COLONY_ID, ratio: 'bogus', issuedAtTick: 0 },
        ],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Boundary hardening — issues #99, #101, #102, #103, #104, #105, #109, #110.
  // Each test verifies the validator rejects a tampered shape AND that a
  // legitimate scenario still round-trips (regression guard).
  // -------------------------------------------------------------------------

  describe('boundary hardening — issues #99 / #101 / #102 / #103 / #104 / #105 / #109 / #110', () => {
    function writeSave(file: {
      version: number;
      seed: unknown;
      inputLog: unknown;
      snapshot: unknown;
    }): void {
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
    }

    // -----------------------------------------------------------------------
    // #110 — envelope seed validation
    // -----------------------------------------------------------------------
    it('#110 rejects envelope seed: string', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 'abc' as unknown as number,
        inputLog: [],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).toBeNull();
    });
    it('#110 rejects envelope seed: null', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: null,
        inputLog: [],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).toBeNull();
    });
    it('#110 rejects envelope seed: missing', () => {
      const w = createScenario(42);
      const file = { version: SAVE_FORMAT_VERSION, inputLog: [], snapshot: serializeWorldState(w) };
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
      expect(loadSave()).toBeNull();
    });
    it('#110 rejects envelope seed: non-integer', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 1.5,
        inputLog: [],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).toBeNull();
    });
    it('#110 rejects envelope seed: out of int32 range', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 0x80000000,
        inputLog: [],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).toBeNull();
    });
    it('#110 accepts envelope seed: int32 boundary values', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 0x7fffffff,
        inputLog: [],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).not.toBeNull();
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: -0x80000000,
        inputLog: [],
        snapshot: serializeWorldState(w),
      });
      expect(loadSave()).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // #103 — non-array inputLog normalization (no soft-brick)
    // -----------------------------------------------------------------------
    it('#103 normalizes missing inputLog to empty array', () => {
      const w = createScenario(42);
      const file = { version: SAVE_FORMAT_VERSION, seed: 42, snapshot: serializeWorldState(w) };
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.inputLog).toEqual([]);
    });
    it('#103 normalizes null inputLog to empty array', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: null,
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.inputLog).toEqual([]);
    });
    it('#103 normalizes string inputLog to empty array', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: 'abc',
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.inputLog).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // #105 — null inputLog entry doesn't destroy the save
    // -----------------------------------------------------------------------
    it('#105 null inputLog entry passes through migrateInputLogCommand without throwing', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION,
        seed: 42,
        inputLog: [null] as unknown as SimCommand[],
        snapshot: serializeWorldState(w),
      });
      // Pre-fix: this returned null (loadSave swallowed the TypeError).
      // Post-fix: parseSaveFile completes; the null entry passes through.
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.inputLog).toHaveLength(1);
      expect(loaded!.inputLog[0]).toBeNull();
    });

    // -----------------------------------------------------------------------
    // #104 — snapshot.tick validation
    // -----------------------------------------------------------------------
    it('#104 rejects snapshot.tick: string', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // eslint-disable-next-line no-restricted-syntax
      (s as unknown as { tick: unknown }).tick = 'x';
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#104 rejects snapshot.tick: negative', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // eslint-disable-next-line no-restricted-syntax
      (s as unknown as { tick: number }).tick = -1;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#104 rejects snapshot.tick: non-integer', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // eslint-disable-next-line no-restricted-syntax
      (s as unknown as { tick: number }).tick = 1.5;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#104 rejects snapshot.rngState: non-integer', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // eslint-disable-next-line no-restricted-syntax
      (s as unknown as { rngState: unknown }).rngState = 'abc';
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#104 accepts legitimate large tick value (regression guard for normal long sessions)', () => {
      const w = createScenario(42);
      // eslint-disable-next-line no-restricted-syntax
      w.tick = 1_000_000;
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(s);
      expect(w2.tick).toBe(1_000_000);
    });

    // -----------------------------------------------------------------------
    // #101 — chamber dimensions validation. Helper: build a scenario with a
    // canonical chamber so we have something to mutate. createScenario(42)
    // doesn't seed chambers, so push a valid Queen chamber first.
    // -----------------------------------------------------------------------
    function scenarioWithChamber() {
      const w = createScenario(42);
      w.colonies[PLAYER_COLONY_ID]!.chambers.push({
        chamberId: 100,
        chamberType: ChamberType.Queen,
        foodStored: 0,
        posX: 10 << 8,
        posY: 5 << 8,
        width: 5,
        height: 3,
      });
      return w;
    }
    it('#101 rejects chamber.width: oversized (DoS via chamber-flow seed loop)', () => {
      const s = serializeWorldState(scenarioWithChamber());
      const c0 = s.colonies[String(PLAYER_COLONY_ID)]!.chambers[0]!;
      (c0 as { width: number }).width = 1_000_000_000;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#101 rejects chamber.chamberType: enum out-of-range', () => {
      const s = serializeWorldState(scenarioWithChamber());
      const c0 = s.colonies[String(PLAYER_COLONY_ID)]!.chambers[0]!;
      (c0 as { chamberType: number }).chamberType = 99;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#101 rejects chamber.posX: out-of-grid', () => {
      const s = serializeWorldState(scenarioWithChamber());
      const c0 = s.colonies[String(PLAYER_COLONY_ID)]!.chambers[0]!;
      (c0 as { posX: number }).posX = 1_000_000;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#101 rejects chamber.foodStored: exceeds capacity', () => {
      const s = serializeWorldState(scenarioWithChamber());
      const c0 = s.colonies[String(PLAYER_COLONY_ID)]!.chambers[0]!;
      (c0 as { foodStored: number }).foodStored = 99_999_999;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it("#101 rejects chamber dims: don't match canonical CHAMBER_DIMENSIONS", () => {
      const s = serializeWorldState(scenarioWithChamber());
      const c0 = s.colonies[String(PLAYER_COLONY_ID)]!.chambers[0]!;
      (c0 as { width: number }).width = 5; // canonical for Queen
      (c0 as { height: number }).height = 4; // BAD: Queen height is 3
      expect(() => deserializeWorldState(s)).toThrow();
    });

    // -----------------------------------------------------------------------
    // #102 — pendingChamber validation
    // -----------------------------------------------------------------------
    it('#102 rejects pendingChamber.width: oversized (DoS via CancelDigMark revert)', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.pendingChambers as Record<string, unknown>)['0:5:5'] = {
        colonyId: 1,
        chamberType: 1,
        anchorTileX: 0,
        anchorTileY: 1,
        width: 1_000_000_000,
        height: 1_000_000_000,
      };
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#102 rejects pendingChamber.anchor: out-of-grid', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.pendingChambers as Record<string, unknown>)['0:5:5'] = {
        colonyId: 1,
        chamberType: 1,
        anchorTileX: 1_000_000,
        anchorTileY: 1,
        width: 4,
        height: 3,
      };
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it("#102 rejects pendingChamber: dims don't match canonical CHAMBER_DIMENSIONS", () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.pendingChambers as Record<string, unknown>)['0:5:5'] = {
        colonyId: 1,
        chamberType: 0, // Queen wants 5×3
        anchorTileX: 0,
        anchorTileY: 1,
        width: 4,
        height: 3, // wrong dims for type 0
      };
      expect(() => deserializeWorldState(s)).toThrow();
    });

    // -----------------------------------------------------------------------
    // #109 — foodPiles array validation
    // -----------------------------------------------------------------------
    it('#109 rejects foodPiles: not an array', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s as unknown as { foodPiles: unknown }).foodPiles = 'abc';
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#109 rejects foodPiles: length exceeds cap', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const oversized = [];
      for (let i = 0; i < 1000; i++) {
        oversized.push({
          foodPileId: i,
          tileX: i % 128,
          tileY: 0,
          pickupsRemaining: 50,
          pickupsInitial: 50,
        });
      }
      s.foodPiles = oversized;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#109 rejects foodPile.tileX: out-of-grid', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      s.foodPiles = [
        { foodPileId: 1, tileX: 1_000_000, tileY: 0, pickupsRemaining: 50, pickupsInitial: 50 },
      ];
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#109 rejects foodPiles: duplicate foodPileId', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      s.foodPiles = [
        { foodPileId: 5, tileX: 10, tileY: 10, pickupsRemaining: 50, pickupsInitial: 50 },
        { foodPileId: 5, tileX: 20, tileY: 20, pickupsRemaining: 50, pickupsInitial: 50 },
      ];
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#109 rejects foodPiles: duplicate tile', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      s.foodPiles = [
        { foodPileId: 5, tileX: 10, tileY: 10, pickupsRemaining: 50, pickupsInitial: 50 },
        { foodPileId: 6, tileX: 10, tileY: 10, pickupsRemaining: 50, pickupsInitial: 50 },
      ];
      expect(() => deserializeWorldState(s)).toThrow();
    });

    // -----------------------------------------------------------------------
    // #99 — grid dims + map cardinality validation
    // -----------------------------------------------------------------------
    it('#99 rejects surface grid: oversized dimensions', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.surface as unknown as { width: number }).width = 20_000;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#99 rejects undergroundGrid: wrong dimensions', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const ugKey = String(PLAYER_COLONY_ID);
      (s.undergroundGrids[ugKey] as unknown as { height: number }).height = 1024;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#99 rejects pheromoneGrid: wrong dimensions', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const phKey = Object.keys(s.pheromoneGrids)[0]!;
      (s.pheromoneGrids[phKey] as unknown as { width: number }).width = 999;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#99 rejects colonies: cardinality cap exceeded', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // Clone a valid colony into many keys.
      const valid = s.colonies[String(PLAYER_COLONY_ID)]!;
      for (let i = 100; i < 200; i++) {
        (s.colonies as Record<string, unknown>)[String(i)] = valid;
      }
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#99 rejects pendingChambers: cardinality cap exceeded', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      for (let i = 0; i < 300; i++) {
        (s.pendingChambers as Record<string, unknown>)[`0:${i}:1`] = {
          colonyId: 1,
          chamberType: 1,
          anchorTileX: i % 100,
          anchorTileY: 1,
          width: 4,
          height: 3,
        };
      }
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#99 rejects colonies key: non-decimal-integer string', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const valid = s.colonies[String(PLAYER_COLONY_ID)]!;
      // Use a non-numeric key. Setting `obj['__proto__'] = ...` mutates the
      // prototype rather than creating an own property, so it never reaches
      // Object.entries — exercise the non-numeric-key branch directly.
      (s.colonies as Record<string, unknown>)['abc'] = valid;
      expect(() => deserializeWorldState(s)).toThrow();
    });
    it('#99 rejects pendingChambers key: __-prefixed string', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // Use Object.defineProperty to create an own __ -prefixed property; a
      // bare assignment of '__proto__' would mutate the prototype instead.
      Object.defineProperty(s.pendingChambers as object, '__shady', {
        value: {
          colonyId: 1,
          chamberType: 1,
          anchorTileX: 0,
          anchorTileY: 1,
          width: 4,
          height: 3,
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      expect(() => deserializeWorldState(s)).toThrow();
    });

    // -----------------------------------------------------------------------
    // Regression guard — legitimate scenarios still round-trip cleanly.
    // -----------------------------------------------------------------------
    it('all validators pass on a freshly-saved legitimate scenario', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      expect(() => deserializeWorldState(s)).not.toThrow();
    });
    it('post-deserialize world replays a tick byte-identically (SCEN-06 regression)', () => {
      const w = createScenario(42);
      tick(w, []); // advance one tick
      const s1 = serializeWorldState(w);
      const w2 = deserializeWorldState(s1);
      const s2 = serializeWorldState(w2);
      expect(s2.tick).toBe(s1.tick);
      expect(s2.rngState).toBe(s1.rngState);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #112 — finite food piles + recentlyDepletedFood persistence
  // ---------------------------------------------------------------------------
  describe('Issue #112 — depletion / spawn save format (v3)', () => {
    it('SAVE_FORMAT_VERSION === 3 and SAVE_KEY ends with :v3', () => {
      expect(SAVE_FORMAT_VERSION).toBe(3);
      expect(SAVE_KEY).toBe('subterrans:save:v3');
    });

    it('rejects v2 envelopes with SaveVersionMismatchError', () => {
      const v2Envelope = JSON.stringify({
        version: 2,
        seed: 42,
        inputLog: [],
        snapshot: serializeWorldState(createScenario(42)),
      });
      // hasSave / loadSave swallow the error; assert their no-save outcome
      // AND call parseSaveFile directly to confirm the typed throw — a
      // future refactor that downgrades to a generic Error would slip past
      // the swallowed-error path otherwise.
      localStorage.setItem(SAVE_KEY, v2Envelope);
      expect(hasSave()).toBe(false);
      expect(loadSave()).toBeNull();

      // Direct production-path assertion — calls the module-exported
      // parseSaveFile, which is the function that actually decides to throw.
      expect(() => parseSaveFile(v2Envelope)).toThrow(SaveVersionMismatchError);
    });

    it('purges legacy v2 keys on hasSave/loadSave', () => {
      localStorage.setItem('subterrans:save:v2', '{"version":2}');
      // Trigger the purge.
      hasSave();
      expect(localStorage.getItem('subterrans:save:v2')).toBeNull();
    });

    it('round-trips pickup-charge fields on every food pile', () => {
      const w = createScenario(42);
      const beforeShapes = w.foodPiles.map((p) => ({
        foodPileId: p.foodPileId,
        pickupsRemaining: p.pickupsRemaining,
        pickupsInitial: p.pickupsInitial,
      }));
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(s);
      expect(w2.foodPiles.length).toBe(w.foodPiles.length);
      for (let i = 0; i < w2.foodPiles.length; i++) {
        const after = w2.foodPiles[i]!;
        const before = beforeShapes[i]!;
        expect(after.foodPileId).toBe(before.foodPileId);
        expect(after.pickupsRemaining).toBe(before.pickupsRemaining);
        expect(after.pickupsInitial).toBe(before.pickupsInitial);
      }
    });

    it('round-trips recentlyDepletedFood — entries preserved field-by-field', () => {
      const w = createScenario(42);
      // Manually populate recentlyDepletedFood with a few synthetic entries
      // so the round-trip exercises the new array path.
      w.recentlyDepletedFood.push(
        { tick: 100, tileX: 5, tileY: 7 },
        { tick: 200, tileX: 12, tileY: 18 },
      );
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(s);
      expect(w2.recentlyDepletedFood.length).toBe(2);
      expect(w2.recentlyDepletedFood[0]).toEqual({ tick: 100, tileX: 5, tileY: 7 });
      expect(w2.recentlyDepletedFood[1]).toEqual({ tick: 200, tileX: 12, tileY: 18 });
    });

    it('validateFoodPile rejects pickupsRemaining=0 (live piles always have a charge)', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w) as unknown as { foodPiles: { pickupsRemaining: number }[] };
      s.foodPiles[0]!.pickupsRemaining = 0; // tampered value
      expect(() => deserializeWorldState(s as never)).toThrow(/pickupsRemaining/);
    });

    it('validateFoodPile rejects pickupsRemaining > pickupsInitial', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w) as unknown as {
        foodPiles: { pickupsRemaining: number; pickupsInitial: number }[];
      };
      s.foodPiles[0]!.pickupsRemaining = s.foodPiles[0]!.pickupsInitial + 1;
      expect(() => deserializeWorldState(s as never)).toThrow(/pickupsRemaining/);
    });

    it('validateFoodPile rejects pickupsInitial=0', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w) as unknown as {
        foodPiles: { pickupsInitial: number; pickupsRemaining: number }[];
      };
      s.foodPiles[0]!.pickupsInitial = 0;
      s.foodPiles[0]!.pickupsRemaining = 0;
      expect(() => deserializeWorldState(s as never)).toThrow(/pickupsInitial/);
    });

    it('validateFoodPile rejects pickupsInitial above max constant', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w) as unknown as {
        foodPiles: { pickupsInitial: number }[];
      };
      // FOOD_PILE_INITIAL_PICKUPS_MAX = 150 in constants.ts — pick one above.
      s.foodPiles[0]!.pickupsInitial = 1000;
      expect(() => deserializeWorldState(s as never)).toThrow(/pickupsInitial/);
    });

    it('rejects non-array recentlyDepletedFood', () => {
      const w = createScenario(42);
      const s = serializeWorldState(w) as unknown as { recentlyDepletedFood: unknown };
      s.recentlyDepletedFood = 'not an array';
      expect(() => deserializeWorldState(s as never)).toThrow(/recentlyDepletedFood/);
    });

    it('rejects recentlyDepletedFood entries with invalid tile coords', () => {
      const w = createScenario(42);
      w.recentlyDepletedFood.push({ tick: 1, tileX: 5, tileY: 5 });
      const s = serializeWorldState(w) as unknown as {
        recentlyDepletedFood: { tick: number; tileX: number; tileY: number }[];
      };
      s.recentlyDepletedFood[0]!.tileX = -1; // out of bounds
      expect(() => deserializeWorldState(s as never)).toThrow(/recentlyDepletedFood\[0\]\.tileX/);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #115 — manualSave + hasIncompatibleSave + getSaveInfo
  // -------------------------------------------------------------------------

  describe('Issue #115 — manualSave', () => {
    it('writes a parseable save under SAVE_KEY and returns true on success', () => {
      const world = createScenario(42);
      const ok = manualSave(42, [], world);
      expect(ok).toBe(true);
      expect(window.localStorage.getItem(SAVE_KEY)).not.toBeNull();
      // Round-trip via the public read path.
      const loaded = loadSave();
      expect(loaded).not.toBeNull();
      expect(loaded!.seed).toBe(42);
      expect(loaded!.snapshot.tick).toBe(0);
    });

    it('preserves the inputLog the caller supplies', () => {
      const world = createScenario(42);
      const log: SimCommand[] = [
        {
          type: 'SetBehaviorRatio',
          colonyId: PLAYER_COLONY_ID,
          ratio: { forage: 5, fight: 5 },
          issuedAtTick: 0,
        },
      ];
      manualSave(42, log, world);
      const loaded = loadSave();
      expect(loaded!.inputLog).toHaveLength(1);
      expect(loaded!.inputLog[0]!.type).toBe('SetBehaviorRatio');
    });

    it('returns false (does not throw) when localStorage.setItem rejects', () => {
      const world = createScenario(42);
      const orig = window.localStorage.setItem;
      window.localStorage.setItem = vi.fn(() => {
        throw new Error('QuotaExceededError');
      });
      try {
        const ok = manualSave(42, [], world);
        expect(ok).toBe(false);
      } finally {
        window.localStorage.setItem = orig;
      }
    });

    it('does NOT depend on or update the autosave timer (manual save is independent)', () => {
      // tickAutosave returns the new lastSaveMs each call. A manual save in
      // between two autosave windows must not bump the autosave's clock —
      // they share the SAVE_KEY but track cadence independently.
      const world = createScenario(42);
      // First autosave at t=0 → writes, returns 0.
      const t0 = tickAutosave(42, [], world, -AUTOSAVE_INTERVAL_MS, 0);
      expect(t0).toBe(0);
      // Manual save at t=5000 — should write, but the autosave's lastSaveMs
      // is whatever the caller passes; manualSave doesn't see it. Verify by
      // calling tickAutosave again at t = AUTOSAVE_INTERVAL_MS-1 with the
      // unchanged lastSaveMs → still NOT due (cooldown not elapsed).
      manualSave(42, [], world);
      const t1 = tickAutosave(42, [], world, t0, AUTOSAVE_INTERVAL_MS - 1);
      expect(t1).toBe(t0); // still pre-cooldown — unchanged
    });
  });

  describe('Issue #115 — hasIncompatibleSave', () => {
    it('returns false when localStorage is empty', () => {
      expect(hasIncompatibleSave()).toBe(false);
    });

    it('returns false for a freshly-written compatible save', () => {
      manualSave(42, [], createScenario(42));
      expect(hasIncompatibleSave()).toBe(false);
      // hasSave is the symmetric positive case
      expect(hasSave()).toBe(true);
    });

    it('returns true when SAVE_KEY holds a v2-shaped envelope (rejected by parseSaveFile)', () => {
      // Stash a known-v2 envelope. parseSaveFile throws SaveVersionMismatchError
      // → hasIncompatibleSave returns true; hasSave returns false. The pair
      // lets the dialog distinguish "no save" from "save present, this build
      // can't read it" instead of silently booting fresh.
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: 2,
          seed: 1,
          inputLog: [],
          snapshot: {},
        }),
      );
      expect(hasIncompatibleSave()).toBe(true);
      expect(hasSave()).toBe(false);
    });

    it('returns true when SAVE_KEY holds completely malformed JSON', () => {
      window.localStorage.setItem(SAVE_KEY, '{not-json');
      expect(hasIncompatibleSave()).toBe(true);
      expect(hasSave()).toBe(false);
    });

    it('round-3 (Codex P2): returns true when snapshot.simVersion exceeds LATEST_SIM_VERSION (future-build save)', async () => {
      // Build a parseable envelope and stamp simVersion above LATEST so
      // bootFromSave's deserialize would throw FutureSimVersionError. The
      // envelope itself parses fine — hasSave returns true today — but the
      // dialog needs to know this save is unloadable so Continue stays
      // disabled and the warning info line surfaces.
      const { LATEST_SIM_VERSION } = await import('../sim/types.js');
      const world = createScenario(7);
      const snap = serializeWorldState(world);
      snap.simVersion = LATEST_SIM_VERSION + 1;
      const env = {
        version: SAVE_FORMAT_VERSION,
        seed: 7,
        inputLog: [],
        snapshot: snap,
        savedAtMs: Date.now(),
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(env));
      expect(hasIncompatibleSave()).toBe(true);
      // hasSave still returns true (envelope parses) — caller is expected
      // to gate on `hasSave() && !hasIncompatibleSave()` for "loadable".
      expect(hasSave()).toBe(true);
    });

    it('round-3: returns false when simVersion equals LATEST_SIM_VERSION (loadable)', async () => {
      const { LATEST_SIM_VERSION } = await import('../sim/types.js');
      const world = createScenario(7);
      const snap = serializeWorldState(world);
      snap.simVersion = LATEST_SIM_VERSION;
      const env = {
        version: SAVE_FORMAT_VERSION,
        seed: 7,
        inputLog: [],
        snapshot: snap,
        savedAtMs: Date.now(),
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(env));
      expect(hasIncompatibleSave()).toBe(false);
      expect(hasSave()).toBe(true);
    });

    it('round-3: returns true when simVersion is omitted (old save below MIN_ACCEPTED — not loadable)', async () => {
      const world = createScenario(7);
      const snap = serializeWorldState(world);
      // Strip simVersion to simulate a pre-issue-#27 envelope.
      delete (snap as { simVersion?: number }).simVersion;
      const env = {
        version: SAVE_FORMAT_VERSION,
        seed: 7,
        inputLog: [],
        snapshot: snap,
        savedAtMs: Date.now(),
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(env));
      expect(hasIncompatibleSave()).toBe(true);
    });

    it('Codex round-3 P1: returns true when snapshot is null (parseable envelope, garbage payload)', () => {
      // parseSaveFile only validates the envelope. A v3 envelope with
      // snapshot=null parses fine but reading snapshot.simVersion would
      // throw and crash the dialog. Treat as incompatible.
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: null,
        }),
      );
      expect(hasIncompatibleSave()).toBe(true);
    });

    it('Codex round-3 P1: returns true when snapshot is a non-object (string / number)', () => {
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: 'not an object',
        }),
      );
      expect(hasIncompatibleSave()).toBe(true);
    });

    it('round-4 (Rob): returns true when snapshot is empty object (parseable but unloadable — Continue would lie)', async () => {
      // Pre-fix: parseSaveFile succeeds, snapshot is non-null object,
      // simVersion is missing (passes the prior check), Continue would
      // appear enabled — but bootFromSave would throw on missing required
      // fields and silently fall through to bootFresh. Now flagged via
      // the full-deserialize boundary check.
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: {},
        }),
      );
      expect(hasIncompatibleSave()).toBe(true);
    });

    it('round-4 (Rob): returns true when simVersion is below LEGACY_SIM_VERSION (tampered down)', async () => {
      const { LEGACY_SIM_VERSION } = await import('../sim/types.js');
      const world = createScenario(7);
      const snap = serializeWorldState(world);
      snap.simVersion = LEGACY_SIM_VERSION - 1;
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 7,
          inputLog: [],
          snapshot: snap,
          savedAtMs: Date.now(),
        }),
      );
      expect(hasIncompatibleSave()).toBe(true);
    });

    it('round-4 (Rob): returns true when snapshot.colonies is missing (deserialize would throw)', () => {
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: { tick: 0, rngState: 0, nextEntityId: 0, commandQueue: [] },
        }),
      );
      expect(hasIncompatibleSave()).toBe(true);
    });
  });

  describe('Issue #196 — classifySaveCompatibility (three-way verdict)', () => {
    // The boot path (game-scene decideBootMode) relies on this verdict to arm
    // autosaveSuspended ONLY for the recoverable future-build case and to leave
    // corrupt saves overwriting freely. hasIncompatibleSave() collapses both
    // incompatible verdicts to a single boolean, so these tests are the only
    // direct guard that the future-vs-corrupt split is wired correctly — a
    // refactor that swapped the two branches would otherwise stay green.
    it("returns 'none' when localStorage is empty", () => {
      expect(classifySaveCompatibility()).toBe('none');
    });

    it("returns 'compatible' for a freshly-written current-format save", () => {
      manualSave(42, [], createScenario(42));
      expect(classifySaveCompatibility()).toBe('compatible');
    });

    it("returns 'incompatible-future' when simVersion exceeds LATEST (recoverable → suspend autosave)", async () => {
      const { LATEST_SIM_VERSION } = await import('../sim/types.js');
      const snap = serializeWorldState(createScenario(7));
      snap.simVersion = LATEST_SIM_VERSION + 1;
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ version: SAVE_FORMAT_VERSION, seed: 7, inputLog: [], snapshot: snap }),
      );
      expect(classifySaveCompatibility()).toBe('incompatible-future');
    });

    it("returns 'incompatible-corrupt' when simVersion is below MIN_ACCEPTED (tampered down → overwrite freely)", async () => {
      // The load-bearing distinction from the future case above: a sub-MIN
      // save is NOT recoverable, so boot must NOT suspend autosave for it.
      const { LEGACY_SIM_VERSION } = await import('../sim/types.js');
      const snap = serializeWorldState(createScenario(7));
      snap.simVersion = LEGACY_SIM_VERSION - 1;
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ version: SAVE_FORMAT_VERSION, seed: 7, inputLog: [], snapshot: snap }),
      );
      expect(classifySaveCompatibility()).toBe('incompatible-corrupt');
    });

    it("returns 'incompatible-corrupt' for a stale save-format envelope (parseSaveFile throws)", () => {
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ version: 2, seed: 1, inputLog: [], snapshot: {} }),
      );
      expect(classifySaveCompatibility()).toBe('incompatible-corrupt');
    });

    it("returns 'incompatible-corrupt' for malformed JSON", () => {
      window.localStorage.setItem(SAVE_KEY, '{not-json');
      expect(classifySaveCompatibility()).toBe('incompatible-corrupt');
    });

    it("returns 'incompatible-corrupt' when snapshot is null (parseable envelope, garbage payload)", () => {
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ version: SAVE_FORMAT_VERSION, seed: 1, inputLog: [], snapshot: null }),
      );
      expect(classifySaveCompatibility()).toBe('incompatible-corrupt');
    });

    it("returns 'incompatible-corrupt' when the snapshot deserialize throws (empty object, missing fields)", () => {
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ version: SAVE_FORMAT_VERSION, seed: 1, inputLog: [], snapshot: {} }),
      );
      expect(classifySaveCompatibility()).toBe('incompatible-corrupt');
    });
  });

  describe('Issue #115 — getSaveInfo', () => {
    it('returns null when no save exists', () => {
      expect(getSaveInfo()).toBeNull();
    });

    it('returns null when the save is unreadable (would let the dialog show "incompatible save")', () => {
      window.localStorage.setItem(SAVE_KEY, '{not-json');
      expect(getSaveInfo()).toBeNull();
    });

    it('returns tick + player worker count + player food (human units) for a fresh save', () => {
      const world = createScenario(42);
      manualSave(42, [], world);
      const info = getSaveInfo();
      expect(info).not.toBeNull();
      expect(info!.tick).toBe(0);
      // Fresh scenario: queen alive; workerCount tracks living workers (no
      // hatched workers yet at tick 0). Match against the live colony.
      const playerColony = world.colonies[PLAYER_COLONY_ID]!;
      expect(info!.playerWorkers).toBe(playerColony.workerCount);
      // playerFoodStored is reported in human units (foodStored >> FP_SHIFT).
      const FP_SHIFT = 8;
      expect(info!.playerFoodStored).toBe(playerColony.foodStored >> FP_SHIFT);
    });

    it('returns the wall-clock savedAtMs from the envelope (issue #115)', () => {
      const before = Date.now();
      manualSave(42, [], createScenario(42));
      const after = Date.now();
      const info = getSaveInfo();
      expect(info!.savedAtMs).toBeGreaterThanOrEqual(before);
      expect(info!.savedAtMs).toBeLessThanOrEqual(after);
    });

    it('returns savedAtMs=0 when the envelope omits the field (pre-issue-#115 saves)', () => {
      // Simulate an older v3 envelope written before issue #115 added savedAtMs.
      // parseSaveFile must accept it (no version bump) and getSaveInfo falls
      // back to 0 ("unknown") rather than NaN or a 1970 stamp.
      const env = {
        version: SAVE_FORMAT_VERSION,
        seed: 1,
        inputLog: [],
        snapshot: serializeWorldState(createScenario(1)),
        // savedAtMs intentionally omitted
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(env));
      const info = getSaveInfo();
      expect(info).not.toBeNull();
      expect(info!.savedAtMs).toBe(0);
    });

    it('returns savedAtMs=0 when the envelope field is malformed (negative or non-finite)', () => {
      const env = {
        version: SAVE_FORMAT_VERSION,
        seed: 1,
        inputLog: [],
        snapshot: serializeWorldState(createScenario(1)),
        savedAtMs: -1,
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(env));
      const info = getSaveInfo();
      expect(info!.savedAtMs).toBe(0);
    });

    it('reflects updated tick count after the world advances', () => {
      const world = createScenario(42);
      for (let i = 0; i < 5; i++) tick(world, []);
      manualSave(42, [], world);
      const info = getSaveInfo();
      expect(info!.tick).toBe(5);
    });

    it('Codex round-3 P1: does NOT throw when snapshot is null (parseable envelope, garbage payload)', () => {
      // The dialog opens by calling getSaveInfo + hasIncompatibleSave. Both
      // need to survive a parseable-but-garbage envelope so the user sees
      // the "incompatible" warning + can use Delete/New Game to recover.
      // Pre-fix this case threw inside getSaveInfo and crashed dialog
      // rendering before the user could click anything.
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: null,
        }),
      );
      expect(() => getSaveInfo()).not.toThrow();
      expect(getSaveInfo()).toBeNull();
    });

    it('Codex round-3 P1: does NOT throw when snapshot.colonies is missing', () => {
      // A snapshot with tick/rngState/etc. but no `colonies` field.
      // Pre-fix: dereferencing colonies[playerKey] would throw TypeError.
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: { tick: 5, rngState: 1, nextEntityId: 0 },
        }),
      );
      expect(() => getSaveInfo()).not.toThrow();
      const info = getSaveInfo();
      expect(info).not.toBeNull();
      expect(info!.tick).toBe(5);
      expect(info!.playerWorkers).toBe(0);
      expect(info!.playerFoodStored).toBe(0);
    });

    it('Codex round-3 P1: returns 0 fields when snapshot.tick is missing/non-numeric', () => {
      window.localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          version: SAVE_FORMAT_VERSION,
          seed: 1,
          inputLog: [],
          snapshot: { colonies: {} },
        }),
      );
      const info = getSaveInfo();
      expect(info).not.toBeNull();
      expect(info!.tick).toBe(0);
    });

    it('returns 0 worker / 0 food when the player colony key is absent (defensive)', () => {
      // Hand-craft an envelope with a missing player colony record. This
      // should never happen in legitimate gameplay, but the dialog must not
      // crash if it does — surface zeros and let the player decide.
      const env = {
        version: SAVE_FORMAT_VERSION,
        seed: 1,
        inputLog: [],
        snapshot: {
          tick: 7,
          rngState: 1,
          nextEntityId: 0,
          commandQueue: [],
          ants: {
            count: 0,
            posX: [],
            posY: [],
            colonyId: [],
            task: [],
            subTask: [],
            speed: [],
            foodCarrying: [],
            starvationTimer: [],
            age: [],
            alive: [],
            lifespan: [],
            zone: [],
            digTileX: [],
            digTileY: [],
            digTicksRemaining: [],
            targetPosX: [],
            targetPosY: [],
            targetSet: [],
          },
          colonies: {}, // PLAYER_COLONY_ID intentionally missing
          pheromoneGrids: {},
          surface: { width: 1, height: 1, data: [0] },
          undergroundGrids: {},
          foodPiles: [],
          pendingChambers: {},
        },
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(env));
      const info = getSaveInfo();
      expect(info).not.toBeNull();
      expect(info!.tick).toBe(7);
      expect(info!.playerWorkers).toBe(0);
      expect(info!.playerFoodStored).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// PR 4 (Fable review) — bakedSurfaceEffect field-specific serialization (R1-12)
// + unpackBakedSurfaceEffect rejection paths + load-time connectivity rejection.
// ---------------------------------------------------------------------------

describe('bakedSurfaceEffect serialization', () => {
  const TILE_COUNT = SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT;
  // Build standard-base64 of a packed grid where tile 0 holds `code`, rest 0.
  const packedGridB64 = (code: number): string => {
    const packed = new Uint8Array((TILE_COUNT + 3) >> 2);
    packed[0] = code & 0x3;
    return Buffer.from(packed).toString('base64');
  };
  const allHardBlockB64 = (): string => {
    // every 2-bit code = 2 (HardBlock) → byte 0b10101010 = 0xAA.
    const packed = new Uint8Array((TILE_COUNT + 3) >> 2).fill(0xaa);
    return Buffer.from(packed).toString('base64');
  };

  it('save→load round-trips a MUTATED baked grid (not re-derived from terrainSeed)', () => {
    const world = createScenario(42, 'Normal');
    // Flip a procedurally-Cosmetic tile to SoftCost: walkable (no connectivity
    // break) but DIFFERENT from what terrainSeed would re-derive. A deserializer
    // that rebuilt the grid from the seed would lose this.
    let idx = -1;
    for (let i = 0; i < world.bakedSurfaceEffect.length; i++) {
      if (world.bakedSurfaceEffect[i] === 0) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    world.bakedSurfaceEffect[idx] = 1; // SoftCost
    const restored = deserializeWorldState(serializeWorldState(world));
    expect(restored.bakedSurfaceEffect[idx]).toBe(1);
    expect(restored.bakedSurfaceEffect.length).toBe(world.bakedSurfaceEffect.length);
  });

  it('unpackBakedSurfaceEffect rejects malformed input (all paths return null)', () => {
    // Wrong length: rejected by the DoS length pre-check, never reaches the decoder.
    expect(unpackBakedSurfaceEffect('AAAA', TILE_COUNT)).toBeNull();
    // Every other malformed input below must be the EXACT base64 length for a
    // full grid (ceil(packedBytes/3)*4) so it passes that length gate and
    // exercises the decoder branch its label names — a short string would be
    // length-rejected and shadow the branch under test.
    const valid = packedGridB64(0);
    expect(valid.length).toBe((((((TILE_COUNT + 3) >> 2) + 2) / 3) | 0) * 4);
    const corruptAt = (pos: number, repl: string): string =>
      valid.slice(0, pos) + repl + valid.slice(pos + repl.length);
    // Bad base64 char (c0 of a mid-string quartet → alphabet lookup fails):
    expect(unpackBakedSurfaceEffect(corruptAt(100, '!'), TILE_COUNT)).toBeNull();
    // '=' padding in a NON-final quartet (ch2 of the quartet at index 100):
    expect(unpackBakedSurfaceEffect(corruptAt(102, '='), TILE_COUNT)).toBeNull();
    // "x=y" padding form in the final quartet (ch2 '=', ch3 not '='):
    expect(unpackBakedSurfaceEffect(corruptAt(valid.length - 4, 'AB=C'), TILE_COUNT)).toBeNull();
    expect(unpackBakedSurfaceEffect(packedGridB64(3), TILE_COUNT)).toBeNull(); // enum code 3
    // Non-zero unused trailing bits in the final byte (expectedLen not /4):
    // byte 0b00110000 — tiles 0,1 = 0 but trailing bits 4-7 = 0b0011 ≠ 0.
    expect(unpackBakedSurfaceEffect(Buffer.from([0x30]).toString('base64'), 2)).toBeNull();
    // Sanity: a clean all-Cosmetic grid decodes.
    expect(unpackBakedSurfaceEffect(packedGridB64(0), TILE_COUNT)).not.toBeNull();
  });

  it('deserialize rejects a baked grid that violates connectivity (all HardBlock)', () => {
    const ser = serializeWorldState(createScenario(42, 'Normal'));
    // simVersion stays at LATEST so the version gate passes and we reach the
    // connectivity check; the all-HardBlock grid disconnects every pile/entrance.
    const corrupt = { ...ser, bakedSurfaceEffect: allHardBlockB64() };
    expect(() => deserializeWorldState(corrupt)).toThrow();
  });

  describe('#242 underground pheromone grids stay all-zero across serialize/deserialize', () => {
    it('a fresh + 30-tick world round-trips with every underground grid all-zero (skip invariant holds for a loaded save)', () => {
      const world = createScenario(42);
      for (let t = 0; t < 30; t++) tick(world, []);
      const restored = deserializeWorldState(serializeWorldState(world));
      for (const key in restored.pheromoneGrids) {
        if (pheromoneKeyIsSurface(key)) continue;
        const grid = restored.pheromoneGrids[key]!;
        let sum = 0;
        for (let i = 0; i < grid.data.length; i++) sum += grid.data[i]!;
        expect(sum).toBe(0);
      }
    });
  });
});
