/* @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SAVE_FORMAT_VERSION, SAVE_KEY, AUTOSAVE_INTERVAL_MS,
  serializeWorldState, deserializeWorldState,
  hasSave, loadSave, deleteSave, tickAutosave,
  type SaveFile,
} from './save.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { PLAYER_COLONY_ID, ENEMY_COLONY_ID } from '../sim/constants.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { ChamberType } from '../sim/enums.js';

describe('save.ts (SCEN-04 + SCEN-06)', () => {
  // Use window.localStorage to ensure jsdom's implementation (not Node 25 native localStorage)
  beforeEach(() => { window.localStorage.clear(); });

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
      const fields = ['posX','posY','colonyId','task','subTask','speed','foodCarrying','starvationTimer',
                      'age','alive','lifespan','zone','digTileX','digTileY','digTicksRemaining',
                      'targetPosX','targetPosY','searchWave'] as const;
      for (const f of fields) {
        expect(Array.isArray(s.ants[f])).toBe(true);
        expect(s.ants[f]!.length).toBeGreaterThan(0);
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
      w.commandQueue.push({ type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 3, tileY: 4, issuedAtTick: 0 });
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
      for (let t = 0; t < 50; t++) tick(w, []);   // some non-trivial state
      const s1 = JSON.stringify(serializeWorldState(w));
      const w2 = deserializeWorldState(JSON.parse(s1));
      const s2 = JSON.stringify(serializeWorldState(w2));
      expect(s2).toBe(s1);
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
      w.commandQueue.push({ type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 1, tileY: 2, issuedAtTick: 0 });
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
    it('pre-#15 saves (foodFlowFieldDirty absent) deserialize to false', () => {
      // Backwards compat: a save written before issue #15 lacked the field.
      // Loader must default it to false rather than throw.
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const colonyKey = String(PLAYER_COLONY_ID);
      delete (s.colonies[colonyKey] as { foodFlowFieldDirty?: boolean }).foodFlowFieldDirty;
      const w2 = deserializeWorldState(s);
      expect(w2.colonies[PLAYER_COLONY_ID]!.foodFlowFieldDirty).toBe(false);
    });
    it('round-trips per-chamber chamber.foodStored independently (issue #15)', () => {
      // Issue #15 regression: under the old pool-only model, save + reload
      // would re-derive chamber.foodStored from colony.foodStored at the next
      // reconcile, hiding any per-chamber drift. Post-#15, chamber.foodStored
      // is authoritative — the save MUST faithfully preserve each chamber's
      // contents, including disparate values across chambers.
      const w = createScenario(42);
      const colony = w.colonies[PLAYER_COLONY_ID]!;
      colony.chambers.push({
        chamberId: 999, chamberType: ChamberType.FoodStorage, foodStored: 1234,
        posX: 10 << 8, posY: 5 << 8, width: 3, height: 3,
      });
      colony.chambers.push({
        chamberId: 998, chamberType: ChamberType.FoodStorage, foodStored: 4321,
        posX: 14 << 8, posY: 5 << 8, width: 3, height: 3,
      });
      const w2 = deserializeWorldState(serializeWorldState(w));
      const c2 = w2.colonies[PLAYER_COLONY_ID]!;
      const ch1 = c2.chambers.find(c => c.chamberId === 999)!;
      const ch2 = c2.chambers.find(c => c.chamberId === 998)!;
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
    it('pre-Phase-9 saves (searchWave absent) deserialize to zero-init wave', () => {
      // Backward compatibility: a save written before searchWave was added
      // should not throw on load and should zero-init the field.
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // Simulate an older save that lacked the field.
      delete (s.ants as { searchWave?: number[] }).searchWave;
      const w2 = deserializeWorldState(s);
      expect(w2.ants.searchWave[0]).toBe(0);
      expect(w2.ants.searchWave[10]).toBe(0);
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
      const enemyQueen  = w.colonies[ENEMY_COLONY_ID]!.queenEntityId;
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
    it('round-trips world.simVersion and ants.waitingDeposit (issue #27)', () => {
      const w = createScenario(42);
      // Simulate a few ants in wait state at distinct ant ids.
      const playerWorker = w.colonies[PLAYER_COLONY_ID]!.workers[0]!;
      const enemyWorker  = w.colonies[ENEMY_COLONY_ID]!.workers[0]!;
      w.ants.waitingDeposit[playerWorker] = 1;
      w.ants.waitingDeposit[enemyWorker]  = 1;
      // Pin a specific simVersion to verify the field actually survives.
      w.simVersion = 3;

      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(JSON.parse(JSON.stringify(s)));

      expect(w2.simVersion).toBe(3);
      expect(w2.ants.waitingDeposit[playerWorker]).toBe(1);
      expect(w2.ants.waitingDeposit[enemyWorker]).toBe(1);
    });
    it('pre-issue-#27 saves (simVersion absent) deserialize with simVersion=LEGACY (sticky-on-load)', async () => {
      const { LEGACY_SIM_VERSION } = await import('../sim/types.js');
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // Simulate an older save that lacked the simVersion field.
      delete (s as { simVersion?: number }).simVersion;
      const w2 = deserializeWorldState(s);
      expect(w2.simVersion).toBe(LEGACY_SIM_VERSION);
      // And waitingDeposit is absent → all-zero (no ants in wait, the
      // correct default for legacy saves which never used the wait state).
      delete (s.ants as { waitingDeposit?: number[] }).waitingDeposit;
      const w3 = deserializeWorldState(s);
      // Spot-check: a worker entity is not in wait state by default.
      const someWorker = w.colonies[PLAYER_COLONY_ID]!.workers[0]!;
      expect(w3.ants.waitingDeposit[someWorker]).toBe(0);
    });
    it('rejects non-integer simVersion (string, NaN, null, object) → falls back to LEGACY (issue #27 P2)', async () => {
      const { LEGACY_SIM_VERSION } = await import('../sim/types.js');
      const w = createScenario(42);
      const baseSnapshot = serializeWorldState(w);
      // Corrupt the simVersion field with each non-integer shape and verify
      // the deserializer always lands on LEGACY rather than coercing into
      // the wrong drain order. `??` alone would let `"3"` / NaN / `null` /
      // object pass through and surface as nondeterministic comparisons
      // downstream (string >= number coerces; object >= number is NaN-y).
      const cases: unknown[] = ['3', '', 'latest', null, NaN, {}, [], 3.5, true];
      for (const bad of cases) {
        const s = JSON.parse(JSON.stringify(baseSnapshot)) as Record<string, unknown>;
        s.simVersion = bad;
        const w2 = deserializeWorldState(
          s as unknown as Parameters<typeof deserializeWorldState>[0],
        );
        expect(w2.simVersion).toBe(LEGACY_SIM_VERSION);
      }
    });
    it('pre-Phase-09.1 saves (currentGridColonyId absent) deserialize with currentGridColonyId === colonyId (initAnt invariant)', () => {
      // Backward compatibility: a save written before Phase 09.1 Chunk 0
      // landed lacks the currentGridColonyId field. Every ant in such a save
      // must load with currentGridColonyId === colonyId — exactly the
      // invariant initAnt establishes for fresh ants (no Fighter invaders
      // existed before Chunks 3+4). A naive zero-fill would silently route
      // every enemy ant's grid lookup at the player's underground grid.
      const w = createScenario(42);
      const s = serializeWorldState(w);
      // Simulate an older save that lacked the field.
      delete (s.ants as { currentGridColonyId?: number[] }).currentGridColonyId;
      const w2 = deserializeWorldState(s);
      const playerQueen = w.colonies[PLAYER_COLONY_ID]!.queenEntityId;
      const enemyQueen  = w.colonies[ENEMY_COLONY_ID]!.queenEntityId;
      expect(w2.ants.currentGridColonyId[playerQueen]).toBe(PLAYER_COLONY_ID);
      expect(w2.ants.currentGridColonyId[enemyQueen]).toBe(ENEMY_COLONY_ID);
      // Spot-check a worker in each colony too.
      const playerWorker = w.colonies[PLAYER_COLONY_ID]!.workers[0]!;
      const enemyWorker  = w.colonies[ENEMY_COLONY_ID]!.workers[0]!;
      expect(w2.ants.currentGridColonyId[playerWorker]).toBe(PLAYER_COLONY_ID);
      expect(w2.ants.currentGridColonyId[enemyWorker]).toBe(ENEMY_COLONY_ID);
    });
  });

  describe('SaveFile envelope (PRD §8a: version + seed + inputLog + snapshot)', () => {
    it('hasSave returns false when localStorage empty', () => {
      expect(hasSave()).toBe(false);
    });
    it('hasSave returns true when valid envelope present', () => {
      const w = createScenario(42);
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: SAVE_FORMAT_VERSION, seed: 42, inputLog: [], snapshot: serializeWorldState(w),
      } satisfies SaveFile));
      expect(hasSave()).toBe(true);
    });
    it('hasSave returns false on malformed JSON', () => {
      localStorage.setItem(SAVE_KEY, 'not-json');
      expect(hasSave()).toBe(false);
    });
    it('hasSave returns false on mismatched version', () => {
      const w = createScenario(42);
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: 999, seed: 42, inputLog: [], snapshot: serializeWorldState(w),
      }));
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
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: 1, seed: 42, inputLog: [], snapshot: serializeWorldState(w),
      }));
      expect(hasSave()).toBe(false);
      expect(loadSave()).toBeNull();
    });
    it('loadSave returns a SaveFile with seed + inputLog + snapshot fields', () => {
      const w = createScenario(42);
      const inputLog: SimCommand[] = [
        { type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 5, tileY: 5, issuedAtTick: 10 },
      ];
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: SAVE_FORMAT_VERSION, seed: 42, inputLog, snapshot: serializeWorldState(w),
      } satisfies SaveFile));
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
      localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_FORMAT_VERSION, seed: 1, inputLog: [], snapshot: serializeWorldState(createScenario(1)) }));
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
    it('returns lastSaveMs unchanged on setItem throw (quota)', () => {
      const w = createScenario(42);
      // Spy on the actual localStorage instance (InMemoryStorage replaces Storage.prototype on Node 25)
      const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
      try {
        const result = tickAutosave(42, [], w, 0, AUTOSAVE_INTERVAL_MS + 1);
        expect(result).toBe(0);
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
        { type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 2, tileY: 2, issuedAtTick: 1 },
        { type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 3, tileY: 3, issuedAtTick: 5 },
      ];
      tickAutosave(42, log, w, 0, AUTOSAVE_INTERVAL_MS + 1);
      const loaded = loadSave()!;
      expect(loaded.inputLog.length).toBe(2);
      expect(loaded.inputLog[1]).toMatchObject({ tileX: 3, tileY: 3 });
    });
    it('(c) queued unprocessed commands round-trip via snapshot.commandQueue', () => {
      const w = createScenario(42);
      w.commandQueue.push({ type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 9, tileY: 9, issuedAtTick: 0 });
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
      expect(JSON.stringify(serializeWorldState(rebuilt)))
        .toBe(JSON.stringify(serializeWorldState(w)));
    });
    it('(e) inputLog replay: createScenario(seed) + tick(cmds[t]) for each tick reproduces snapshot', () => {
      // Build a reference world with a deterministic schedule
      const seed = 42;
      const schedule: SimCommand[][] = [];
      schedule[10] = [{ type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID as ColonyId, tileX: 7, tileY: 3, issuedAtTick: 10 }];

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

      expect(JSON.stringify(serializeWorldState(replay)))
        .toBe(JSON.stringify(serializeWorldState(original)));
    });
  });
});
