/* @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SAVE_FORMAT_VERSION, SAVE_KEY, AUTOSAVE_INTERVAL_MS,
  serializeWorldState, deserializeWorldState,
  hasSave, loadSave, deleteSave, tickAutosave,
  migrateBehaviorRatio,
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
    it('pre-#17-Phase-1 saves (carry slots absent) deserialize to all-(-1)', () => {
      // Backward compatibility: a pre-v10 save omits carryingBroodId/carriedBy.
      // Loading defaults the fields to all-(-1), which is the correct "no
      // carries in flight" state for both pre-v10 (never read) and v10+.
      const w = createScenario(42);
      const s = serializeWorldState(w);
      delete (s.ants as { carryingBroodId?: number[] }).carryingBroodId;
      delete (s.ants as { carriedBy?: number[] }).carriedBy;
      const w2 = deserializeWorldState(s);
      expect(w2.ants.carryingBroodId[0]).toBe(-1);
      expect(w2.ants.carriedBy[0]).toBe(-1);
      expect(w2.ants.carryingBroodId[100]).toBe(-1);
      expect(w2.ants.carriedBy[100]).toBe(-1);
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
    it('round-trips simVersion (LATEST: v10 visible brood carry)', async () => {
      const { LATEST_SIM_VERSION, SIM_VERSION_V7_SURFACE_PASSABILITY } = await import('../sim/types.js');
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

    it('preserves a captured v7 save (sticky load → v7 replay path stays available)', async () => {
      const { SIM_VERSION_V7_SURFACE_PASSABILITY } = await import('../sim/types.js');
      // Saves recorded under v7 must round-trip as v7 (not auto-upgrade to
      // LATEST), so v7 replays remain byte-identical on resume even after
      // newer sim versions land.
      const w = createScenario(42);
      w.simVersion = SIM_VERSION_V7_SURFACE_PASSABILITY;
      const s = serializeWorldState(w);
      const w2 = deserializeWorldState(JSON.parse(JSON.stringify(s)));
      expect(w2.simVersion).toBe(SIM_VERSION_V7_SURFACE_PASSABILITY);
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

  // ---------------------------------------------------------------------------
  // Phase 10 / D-04 — silent BehaviorRatio migration on load
  //
  // Pre-Phase-10 saves serialize targetRatio as { forage, dig, fight } (3 fields).
  // Phase 10 narrows BehaviorRatio to { forage, fight }. The migrateBehaviorRatio
  // helper drops the dig field, snaps all-zero { forage:0, fight:0 } to the
  // default { forage:10, fight:0 }, and is idempotent on already-migrated saves.
  // No schema version bump per D-04 (pre-1.0, save compat is not a public contract).
  // ---------------------------------------------------------------------------
  describe('Phase 10 / D-04 — migrateBehaviorRatio', () => {
    it('(typical) drops dig field: { forage: 5, dig: 3, fight: 2 } → { forage: 5, fight: 2 }', () => {
      // The dig field is silently dropped — no proportional rescale.
      const result = migrateBehaviorRatio({ forage: 5, dig: 3, fight: 2 });
      expect(result).toEqual({ forage: 5, fight: 2 });
      // Sanity: the `dig` key is GONE, not zeroed.
      expect('dig' in result).toBe(false);
    });
    it('(all-zero edge / pre-Phase-10 pure-dig) snaps to { forage: 10, fight: 0 }', () => {
      // Pre-Phase-10 player who set pure dig: { forage: 0, dig: 10, fight: 0 }.
      // Under the two-role contract this would be all-zero; D-04 snaps to the
      // DEFAULT_BEHAVIOR_RATIO { forage: 10, fight: 0 }.
      const result = migrateBehaviorRatio({ forage: 0, dig: 10, fight: 0 });
      expect(result).toEqual({ forage: 10, fight: 0 });
    });
    it('(already-migrated, idempotent) { forage: 7, fight: 3 } → { forage: 7, fight: 3 }', () => {
      // No-op pass-through for post-Phase-10 saves (no dig field).
      // Applying the helper twice produces the same result as applying once.
      const once = migrateBehaviorRatio({ forage: 7, fight: 3 });
      expect(once).toEqual({ forage: 7, fight: 3 });
      const twice = migrateBehaviorRatio(once);
      expect(twice).toEqual({ forage: 7, fight: 3 });
    });
    it('(already-migrated, intentional zeros) { forage: 0, fight: 0 } passes through unchanged (WR-10)', () => {
      // Post-Phase-10 callers can legitimately set both fields to 0 (idle
      // slider, AI exotic state, replay tooling). The snap is restricted to
      // legacy or malformed inputs so snapshot-vs-replay determinism is
      // preserved for valid two-field zeros.
      const result = migrateBehaviorRatio({ forage: 0, fight: 0 });
      expect(result).toEqual({ forage: 0, fight: 0 });
    });
    it('(missing fields defensive) {} → { forage: 10, fight: 0 }', () => {
      // Missing/non-numeric forage and fight default to 0, which then triggers
      // the malformed-input branch of the snap. Garbage in → safe default out.
      const result = migrateBehaviorRatio({});
      expect(result).toEqual({ forage: 10, fight: 0 });
    });
    it('(NaN field defensive) { forage: NaN, fight: 0 } → { forage: 10, fight: 0 }', () => {
      // NaN counts as malformed — the snap fires defensively.
      const result = migrateBehaviorRatio({ forage: NaN, fight: 0 });
      expect(result).toEqual({ forage: 10, fight: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10 / D-04 — full save round-trip migration
  //
  // deserializeColony must invoke migrateBehaviorRatio so that loading a save
  // with a pre-Phase-10 3-field targetRatio produces a runtime ColonyRecord
  // with the post-Phase-10 2-field shape. Round-trip determinism: load legacy
  // → save → reload yields a stable two-field-only serialized targetRatio.
  // ---------------------------------------------------------------------------
  describe('Phase 10 / D-04 — save round-trip migration', () => {
    // Build a SerializedWorldState from createScenario, then mutate the player
    // colony's targetRatio to the desired legacy/post shape. Using the live
    // serializer keeps every other field of the envelope correct, so tests
    // assert ONLY the migration behavior — not the rest of the envelope.
    function legacySaveWithRatio(
      legacy: { forage: number; dig?: number; fight: number },
    ) {
      const w = createScenario(42);
      const s = serializeWorldState(w);
      const colonyKey = String(PLAYER_COLONY_ID);
      // Cast through unknown to inject the legacy 3-field shape (which the
      // SerializedColony type now accepts via `dig?: number`).
      (s.colonies[colonyKey] as { targetRatio: typeof legacy }).targetRatio = legacy;
      return s;
    }

    it('typical legacy save: { forage: 5, dig: 3, fight: 2 } loads with dig dropped', () => {
      // After deserialize, the runtime ColonyRecord has the post-Phase-10
      // two-field shape. The `dig` key is GONE, not zeroed (verifies the
      // migration is structural, not just numeric).
      const s = legacySaveWithRatio({ forage: 5, dig: 3, fight: 2 });
      const w2 = deserializeWorldState(s);
      const ratio = w2.colonies[PLAYER_COLONY_ID]!.targetRatio;
      expect(ratio).toEqual({ forage: 5, fight: 2 });
      expect('dig' in ratio).toBe(false);
    });
    it('pure-dig legacy save: { forage: 0, dig: 10, fight: 0 } snaps to default { forage: 10, fight: 0 }', () => {
      // The all-zero edge case: a pre-Phase-10 player who set pure dig had
      // forage===0 AND fight===0 under the new contract. D-04 snaps to the
      // DEFAULT_BEHAVIOR_RATIO { forage: 10, fight: 0 }.
      const s = legacySaveWithRatio({ forage: 0, dig: 10, fight: 0 });
      const w2 = deserializeWorldState(s);
      const ratio = w2.colonies[PLAYER_COLONY_ID]!.targetRatio;
      expect(ratio).toEqual({ forage: 10, fight: 0 });
      expect('dig' in ratio).toBe(false);
    });
    it('already-migrated save: { forage: 7, fight: 3 } loads unchanged (no-op pass-through)', () => {
      // Post-Phase-10 saves load idempotently — no re-snap, no field drift.
      const s = legacySaveWithRatio({ forage: 7, fight: 3 });
      const w2 = deserializeWorldState(s);
      expect(w2.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual({ forage: 7, fight: 3 });
    });
    it('two-colony round-trip: each colony migrates independently', () => {
      // Sanity: per-colony migration is independent. Player gets a typical
      // legacy ratio (dig dropped); enemy gets the pure-dig edge case (snap).
      const w = createScenario(42);
      const s = serializeWorldState(w);
      (s.colonies[String(PLAYER_COLONY_ID)] as { targetRatio: { forage: number; dig: number; fight: number } })
        .targetRatio = { forage: 5, dig: 3, fight: 2 };
      (s.colonies[String(ENEMY_COLONY_ID)] as { targetRatio: { forage: number; dig: number; fight: number } })
        .targetRatio = { forage: 0, dig: 10, fight: 0 };
      const w2 = deserializeWorldState(s);
      expect(w2.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual({ forage: 5, fight: 2 });
      expect(w2.colonies[ENEMY_COLONY_ID]!.targetRatio).toEqual({ forage: 10, fight: 0 });
    });
    it('round-trip determinism: load legacy → save → re-load produces byte-stable two-field targetRatio', () => {
      // Critical SCEN-06 contract: after migration, a re-saved snapshot
      // serializes a CLEAN two-field targetRatio, and a second load is the
      // idempotent no-op case in migrateBehaviorRatio. The second-save JSON
      // must contain no `dig` field.
      const s1 = legacySaveWithRatio({ forage: 5, dig: 3, fight: 2 });
      const w2 = deserializeWorldState(s1);
      const s2 = serializeWorldState(w2);
      const reSerializedRatio = s2.colonies[String(PLAYER_COLONY_ID)]!.targetRatio;
      expect(reSerializedRatio).toEqual({ forage: 5, fight: 2 });
      expect('dig' in reSerializedRatio).toBe(false);
      // Load a third time; the second-save JSON has no dig field, so this is
      // the post-migration idempotent pass-through path.
      const w3 = deserializeWorldState(s2);
      expect(w3.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual({ forage: 5, fight: 2 });
    });
    it('round-trip determinism: post-load tick sequence is deterministic', () => {
      // Two worlds loaded from the SAME legacy save and ticked the same
      // number of ticks must produce byte-identical serialized state.
      // This guards against migration introducing any non-determinism
      // (e.g. iteration order, PRNG drift) in the load path.
      const legacy = legacySaveWithRatio({ forage: 5, dig: 3, fight: 2 });
      const a = deserializeWorldState(legacy);
      const b = deserializeWorldState(legacy);
      for (let t = 0; t < 30; t++) {
        tick(a, []);
        tick(b, []);
      }
      expect(JSON.stringify(serializeWorldState(a)))
        .toBe(JSON.stringify(serializeWorldState(b)));
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
  describe('Phase 10 / WR-09 — inputLog migration on load', () => {
    function writeSave(file: { version: number; seed: number; inputLog: unknown[]; snapshot: unknown }): void {
      localStorage.setItem(SAVE_KEY, JSON.stringify(file));
    }

    it('typical legacy entry: SetBehaviorRatio { forage:5, dig:3, fight:2 } loads with dig dropped', () => {
      const w = createScenario(42);
      const legacyEntry = {
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID,
        ratio: { forage: 5, dig: 3, fight: 2 },
        issuedAtTick: 0,
      };
      writeSave({
        version: SAVE_FORMAT_VERSION, seed: 42,
        inputLog: [legacyEntry],
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave()!;
      expect(loaded.inputLog.length).toBe(1);
      const ratio = (loaded.inputLog[0] as { ratio: unknown }).ratio;
      expect(ratio).toEqual({ forage: 5, fight: 2 });
      expect('dig' in (ratio as object)).toBe(false);
    });

    it('pure-dig legacy entry: { forage:0, dig:10, fight:0 } snaps to default { forage:10, fight:0 }', () => {
      const w = createScenario(42);
      const legacyEntry = {
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID,
        ratio: { forage: 0, dig: 10, fight: 0 },
        issuedAtTick: 0,
      };
      writeSave({
        version: SAVE_FORMAT_VERSION, seed: 42,
        inputLog: [legacyEntry],
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave()!;
      const ratio = (loaded.inputLog[0] as { ratio: unknown }).ratio;
      expect(ratio).toEqual({ forage: 10, fight: 0 });
    });

    it('post-Phase-10 entry without dig field passes through unchanged (including idle {0,0})', () => {
      const w = createScenario(42);
      const modernIdle: SimCommand = {
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID as ColonyId,
        ratio: { forage: 0, fight: 0 },
        issuedAtTick: 7,
      };
      writeSave({
        version: SAVE_FORMAT_VERSION, seed: 42,
        inputLog: [modernIdle],
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave()!;
      expect((loaded.inputLog[0] as { ratio: unknown }).ratio).toEqual({ forage: 0, fight: 0 });
    });

    it('mixed inputLog: only SetBehaviorRatio entries are touched; other commands pass through', () => {
      const w = createScenario(42);
      writeSave({
        version: SAVE_FORMAT_VERSION, seed: 42,
        inputLog: [
          { type: 'SetBehaviorRatio', colonyId: PLAYER_COLONY_ID, ratio: { forage: 5, dig: 3, fight: 2 }, issuedAtTick: 0 },
          { type: 'MarkDigTile', colonyId: PLAYER_COLONY_ID, tileX: 7, tileY: 3, issuedAtTick: 5 },
          { type: 'NoOp', issuedAtTick: 10 },
        ],
        snapshot: serializeWorldState(w),
      });
      const loaded = loadSave()!;
      expect((loaded.inputLog[0] as { ratio: unknown }).ratio).toEqual({ forage: 5, fight: 2 });
      expect(loaded.inputLog[1]).toMatchObject({ type: 'MarkDigTile', tileX: 7, tileY: 3 });
      expect(loaded.inputLog[2]).toMatchObject({ type: 'NoOp' });
    });

    it('replay round-trip: pure-dig legacy inputLog → load → replay reproduces the migrated snapshot', () => {
      // The full SCEN-06 contract: migrated inputLog applied to a fresh
      // scenario reproduces the migrated snapshot byte-for-byte.
      //
      // Discriminating case: pure-dig legacy {forage:0, dig:5, fight:0} is
      // the only shape where migrated and verbatim playback produce
      // DIFFERENT results: migrated snaps to {forage:10, fight:0}, while
      // verbatim replay through the post-Phase-10 handler reads {forage:0,
      // fight:0} (idle, no allocation). Mid-dig and mid-forage cases like
      // {forage:5, dig:3, fight:2} → {forage:5, fight:2} cannot
      // discriminate — both paths give the same answer because the handler
      // ignores the `dig` field regardless.
      const seed = 42;
      const original = createScenario(seed);
      // Build the original world by applying the POST-MIGRATION shape:
      // {forage:10, fight:0} at tick 5. This is the state the migrated
      // legacy command should reproduce on replay.
      const postMigrationCmd: SimCommand = {
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID as ColonyId,
        ratio: { forage: 10, fight: 0 },
        issuedAtTick: 5,
      };
      for (let t = 0; t < 50; t++) {
        const cmds: SimCommand[] = (t === 5) ? [postMigrationCmd] : [];
        tick(original, cmds);
      }

      // Persist with a LEGACY pure-dig entry in the inputLog.
      const legacyEntry = {
        type: 'SetBehaviorRatio',
        colonyId: PLAYER_COLONY_ID,
        ratio: { forage: 0, dig: 5, fight: 0 },
        issuedAtTick: 5,
      };
      writeSave({
        version: SAVE_FORMAT_VERSION, seed,
        inputLog: [legacyEntry],
        snapshot: serializeWorldState(original),
      });

      const loaded = loadSave()!;
      // Sanity: the legacy entry got snapped to {forage:10, fight:0}.
      expect((loaded.inputLog[0] as { ratio: unknown }).ratio).toEqual({ forage: 10, fight: 0 });

      const replay = createScenario(loaded.seed);
      const byTick: SimCommand[][] = [];
      for (const c of loaded.inputLog) {
        const t = c.issuedAtTick;
        (byTick[t] ??= []).push(c);
      }
      for (let t = 0; t < 50; t++) tick(replay, byTick[t] ?? []);

      expect(JSON.stringify(serializeWorldState(replay)))
        .toBe(JSON.stringify(serializeWorldState(original)));
    });
  });
});
