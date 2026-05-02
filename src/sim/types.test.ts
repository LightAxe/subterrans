import { describe, it, expect, beforeEach } from 'vitest';
import {
  type EntityId,
  createWorldState,
  copyWorldState,
  allocateEntityId,
} from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { createPheromoneGrid, phGet, phSet } from './pheromone/pheromone-store.js';
import { createUndergroundGrid } from './terrain.js';
import { MAX_ENTITIES, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';

describe('WorldState', () => {
  describe('createWorldState', () => {
    it('returns tick=0, rngState=seed, nextEntityId=0, commandQueue=[] for seed 42', () => {
      const world = createWorldState(42);
      expect(world.tick).toBe(0);
      expect(world.rngState).toBe(42);
      expect(world.nextEntityId).toBe(0);
      expect(world.commandQueue).toEqual([]);
      expect(world.commandQueue.length).toBe(0);
    });

    it('coerces negative seed to uint32 via seed >>> 0 (PRD §3)', () => {
      // -1 >>> 0 === 4294967295 (max uint32)
      const world = createWorldState(-1);
      expect(world.rngState).toBe(4294967295);
    });

    it('has exactly thirteen fields (4 Phase 5 + 3 Phase 6 + 4 Phase 7 + 1 issue #27 + 1 issue #44)', () => {
      const world = createWorldState(0);
      const keys = Object.keys(world);
      expect(keys).toHaveLength(13);
      expect(keys).toContain('tick');
      expect(keys).toContain('rngState');
      expect(keys).toContain('nextEntityId');
      expect(keys).toContain('commandQueue');
      expect(keys).toContain('simVersion');
      expect(keys).toContain('terrainSeed');
      expect(keys).toContain('ants');
      expect(keys).toContain('colonies');
      expect(keys).toContain('pheromoneGrids');
      expect(keys).toContain('surface');
      expect(keys).toContain('undergroundGrids');
      expect(keys).toContain('foodPiles');
      expect(keys).toContain('pendingChambers');
    });

    it('issue #44: terrainSeed is a deterministic, non-zero, non-rngState mix of the input seed', () => {
      // Same seed → same terrainSeed (deterministic).
      const a = createWorldState(42);
      const b = createWorldState(42);
      expect(a.terrainSeed).toBe(b.terrainSeed);

      // Different seeds → different terrainSeeds (the whole point — pre-#44
      // every world's surface looked identical because placement was
      // coordinate-only).
      const c = createWorldState(43);
      expect(a.terrainSeed).not.toBe(c.terrainSeed);

      // Non-zero so the surface hash actually mixes (a 0 terrainSeed XOR'd
      // into salt is a no-op — we'd reproduce the legacy coordinate-only
      // layout for seed=0, which is fine but worth documenting via a test).
      // Knuth golden-ratio mixer of a non-zero uint32 seed is non-zero.
      expect(a.terrainSeed).not.toBe(0);

      // NOT identical to rngState — coupling them would tie the very-first
      // decoration query to wherever the PRNG happens to land on tick 0.
      expect(a.terrainSeed).not.toBe(a.rngState);
    });

    it('issue #44: seed=0 yields terrainSeed=0 (pre-#44 layout) per Math.imul(0, k) === 0', () => {
      const world = createWorldState(0);
      expect(world.terrainSeed).toBe(0);
    });

    it('Phase 6 init: ants has 17 Int32Arrays of length MAX_ENTITIES', () => {
      const world = createWorldState(42);
      const antFields = [
        'posX', 'posY', 'colonyId', 'task', 'subTask',
        'speed', 'foodCarrying', 'starvationTimer', 'age', 'alive', 'lifespan',
        'zone', 'digTileX', 'digTileY', 'digTicksRemaining', 'targetPosX', 'targetPosY',
      ] as const;
      expect(antFields.length).toBe(17);
      for (const field of antFields) {
        expect(world.ants[field]).toBeInstanceOf(Int32Array);
        expect(world.ants[field].length).toBe(MAX_ENTITIES);
      }
    });

    it('Phase 6 init: colonies is empty object {}', () => {
      const world = createWorldState(42);
      expect(world.colonies).toEqual({});
      expect(Object.keys(world.colonies).length).toBe(0);
    });

    it('Phase 6 init: pheromoneGrids is empty object {}', () => {
      const world = createWorldState(42);
      expect(world.pheromoneGrids).toEqual({});
      expect(Object.keys(world.pheromoneGrids).length).toBe(0);
    });

    it('Phase 7 init: surface grid has correct dimensions (128×128 = 16384 bytes)', () => {
      const world = createWorldState(42);
      expect(world.surface).toBeDefined();
      expect(world.surface.data).toBeInstanceOf(Uint8Array);
      expect(world.surface.data.length).toBe(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT); // 16384
      expect(world.surface.width).toBe(SURFACE_GRID_WIDTH);
      expect(world.surface.height).toBe(SURFACE_GRID_HEIGHT);
    });

    it('Phase 7 init: undergroundGrids is empty object {}', () => {
      const world = createWorldState(42);
      expect(Object.keys(world.undergroundGrids).length).toBe(0);
    });

    it('Phase 7 init: foodPiles is empty array []', () => {
      const world = createWorldState(42);
      expect(Array.isArray(world.foodPiles)).toBe(true);
      expect(world.foodPiles.length).toBe(0);
    });

    it('Phase 7 init: pendingChambers is empty Record {}', () => {
      const world = createWorldState(42);
      expect(Object.keys(world.pendingChambers).length).toBe(0);
    });

    it('custom maxEntities: createWorldState(42, 256) yields ants.posX.length === 256', () => {
      const world = createWorldState(42, 256);
      expect(world.ants.posX.length).toBe(256);
      expect(world.ants.lifespan.length).toBe(256);
    });
  });

  describe('copyWorldState', () => {
    it('copies all Phase 5 scalar fields from src into dst', () => {
      const src = createWorldState(99);
      const dst = createWorldState(0);
      src.tick = 5;
      src.rngState = 12345;
      src.nextEntityId = 7;
      copyWorldState(src, dst);
      expect(dst.tick).toBe(5);
      expect(dst.rngState).toBe(12345);
      expect(dst.nextEntityId).toBe(7);
    });

    it('dst scalar changes do not affect src (no shared state)', () => {
      const src = createWorldState(1);
      const dst = createWorldState(2);
      src.tick = 10;
      copyWorldState(src, dst);
      dst.tick = 99;
      expect(src.tick).toBe(10);
    });

    it('commandQueue is independent after copy — push to src does not affect dst', () => {
      const src = createWorldState(1);
      const dst = createWorldState(2);
      copyWorldState(src, dst);
      // Push to src.commandQueue AFTER the copy
      src.commandQueue.push({ type: 'NoOp', issuedAtTick: 0 });
      expect(dst.commandQueue.length).toBe(0);
    });

    it('issue #44: terrainSeed round-trips through copyWorldState', () => {
      // dst was created with seed 2 — its terrainSeed differs from src's.
      // After copyWorldState, dst.terrainSeed must take src's value, otherwise
      // the prev/curr render snapshots would query different layouts each
      // frame and the surface decorations would shimmer.
      const src = createWorldState(42);
      const dst = createWorldState(7);
      expect(dst.terrainSeed).not.toBe(src.terrainSeed);
      copyWorldState(src, dst);
      expect(dst.terrainSeed).toBe(src.terrainSeed);
    });

    describe('AntComponents', () => {
      let src: ReturnType<typeof createWorldState>;
      let dst: ReturnType<typeof createWorldState>;

      beforeEach(() => {
        src = createWorldState(1, 64);
        dst = createWorldState(2, 64);
      });

      it('ant field round trip: posX and alive values are copied correctly', () => {
        src.ants.posX[0] = 100;
        src.ants.alive[0] = 1;
        copyWorldState(src, dst);
        expect(dst.ants.posX[0]).toBe(100);
        expect(dst.ants.alive[0]).toBe(1);
      });

      it('ant array independence: mutating src after copy does not affect dst', () => {
        src.ants.posX[0] = 100;
        copyWorldState(src, dst);
        expect(dst.ants.posX[0]).toBe(100);
        // Mutate src AFTER copy — dst must remain unchanged
        src.ants.posX[0] = 999;
        expect(dst.ants.posX[0]).toBe(100);
      });

      it('Phase 7 ant fields: zone[0] is copied correctly', () => {
        src.ants.zone[0] = 1; // Underground
        copyWorldState(src, dst);
        expect(dst.ants.zone[0]).toBe(1);
      });

      it('Phase 7 ant fields: digTileX, digTileY, digTicksRemaining copied', () => {
        src.ants.digTileX[0] = 10;
        src.ants.digTileY[0] = 20;
        src.ants.digTicksRemaining[0] = 5;
        copyWorldState(src, dst);
        expect(dst.ants.digTileX[0]).toBe(10);
        expect(dst.ants.digTileY[0]).toBe(20);
        expect(dst.ants.digTicksRemaining[0]).toBe(5);
      });

      it('Phase 7 ant fields: targetPosX, targetPosY copied', () => {
        src.ants.targetPosX[0] = 512;
        src.ants.targetPosY[0] = 256;
        copyWorldState(src, dst);
        expect(dst.ants.targetPosX[0]).toBe(512);
        expect(dst.ants.targetPosY[0]).toBe(256);
      });

      it('Phase 9 ant fields: searchWave copied (09 digger-reassignment memo)', () => {
        // Leash wave is live sim state — if copyWorldState drops it, prevState
        // drifts from curr and interpolation/tests that rely on WorldState
        // equality after copy start lying.
        src.ants.searchWave[0] = 3;
        src.ants.searchWave[1] = 1;
        copyWorldState(src, dst);
        expect(dst.ants.searchWave[0]).toBe(3);
        expect(dst.ants.searchWave[1]).toBe(1);
        // Independence: mutating src must not affect dst.
        src.ants.searchWave[0] = 0;
        expect(dst.ants.searchWave[0]).toBe(3);
      });

      it('Phase 9 ant fields: searchPrevTileX/Y copied (09 excursion-foraging follow-up)', () => {
        // Anti-backtrack prev-tile fields are live sim state read by the
        // pheromone sampler and excursion-boundary stale-trap check. A dropped
        // copy would desync prevState from curr and also mask anti-backtrack
        // regressions in any test that drives ticks via the render loop.
        src.ants.searchPrevTileX[0] = 11;
        src.ants.searchPrevTileY[0] = 22;
        src.ants.searchPrevTileX[1] = -1; // sentinel round-trips unchanged
        src.ants.searchPrevTileY[1] = -1;
        copyWorldState(src, dst);
        expect(dst.ants.searchPrevTileX[0]).toBe(11);
        expect(dst.ants.searchPrevTileY[0]).toBe(22);
        expect(dst.ants.searchPrevTileX[1]).toBe(-1);
        expect(dst.ants.searchPrevTileY[1]).toBe(-1);
        // Independence: mutating src after copy must NOT propagate to dst
        // (set() copies by value — this proves the arrays aren't aliased).
        src.ants.searchPrevTileX[0] = 99;
        src.ants.searchPrevTileY[0] = 99;
        expect(dst.ants.searchPrevTileX[0]).toBe(11);
        expect(dst.ants.searchPrevTileY[0]).toBe(22);
      });
    });

    describe('colonies', () => {
      let src: ReturnType<typeof createWorldState>;
      let dst: ReturnType<typeof createWorldState>;

      beforeEach(() => {
        src = createWorldState(1, 64);
        dst = createWorldState(2, 64);
      });

      it('colony creation: dst gains colony with correct scalar fields after copy', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        // Phase 3 PRD §2a caller-side init (required before copyWorldState reads these fields)
        src.colonies[1]!.entrances = []; src.colonies[1]!.rallyPoint = null; src.colonies[1]!.digFlowFieldDirty = false;
        src.colonies[1]!.foodStored = 500;
        copyWorldState(src, dst);
        expect(dst.colonies[1]).toBeDefined();
        expect(dst.colonies[1]!.foodStored).toBe(500);
        expect(dst.colonies[1]!.queenEntityId).toBe(42);
      });

      it('colony deletion propagation: colony removed from src is removed from dst on next copy', () => {
        src.colonies[2] = createColonyRecord(2, 50);
        // Phase 3 PRD §2a caller-side init
        src.colonies[2]!.entrances = []; src.colonies[2]!.rallyPoint = null; src.colonies[2]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        expect(dst.colonies[2]).toBeDefined();
        delete src.colonies[2];
        copyWorldState(src, dst);
        expect(dst.colonies[2]).toBeUndefined();
      });

      it('colony bucket arrays independence: workers array values copied but not same reference', () => {
        src.colonies[1] = createColonyRecord(1, 10);
        // Phase 3 PRD §2a caller-side init
        src.colonies[1]!.entrances = []; src.colonies[1]!.rallyPoint = null; src.colonies[1]!.digFlowFieldDirty = false;
        src.colonies[1]!.workers = [10, 20, 30];
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.workers).toEqual([10, 20, 30]);
        expect(dst.colonies[1]!.workers).not.toBe(src.colonies[1]!.workers);
      });

      it('nested plain-object reuse: targetRatio object identity preserved through copy (zero-alloc steady state)', () => {
        src.colonies[1] = createColonyRecord(1, 10);
        // Phase 3 PRD §2a caller-side init
        src.colonies[1]!.entrances = []; src.colonies[1]!.rallyPoint = null; src.colonies[1]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        const beforeRatio = dst.colonies[1]!.targetRatio;
        // Mutate src ratio, then copy again
        src.colonies[1]!.targetRatio.forage = 5;
        copyWorldState(src, dst);
        // Same object reference — field-by-field copy, not spread
        expect(dst.colonies[1]!.targetRatio).toBe(beforeRatio);
        // Values updated
        expect(dst.colonies[1]!.targetRatio.forage).toBe(5);
      });

      it('taskCensus shape preserved through copy: 4 fields (nurse, forage, dig, fight) — no idle', () => {
        src.colonies[1] = createColonyRecord(1, 10);
        // Phase 3 PRD §2a caller-side init
        src.colonies[1]!.entrances = []; src.colonies[1]!.rallyPoint = null; src.colonies[1]!.digFlowFieldDirty = false;
        src.colonies[1]!.taskCensus = { nurse: 2, forage: 3, dig: 1, fight: 0 };
        copyWorldState(src, dst);
        const keys = Object.keys(dst.colonies[1]!.taskCensus).sort();
        expect(keys).toEqual(['dig', 'fight', 'forage', 'nurse']);
        expect(dst.colonies[1]!.taskCensus.nurse).toBe(2);
        expect(dst.colonies[1]!.taskCensus.forage).toBe(3);
        expect(dst.colonies[1]!.taskCensus.dig).toBe(1);
        expect(dst.colonies[1]!.taskCensus.fight).toBe(0);
      });
    });

    describe('pheromoneGrids', () => {
      let src: ReturnType<typeof createWorldState>;
      let dst: ReturnType<typeof createWorldState>;

      beforeEach(() => {
        src = createWorldState(1, 64);
        dst = createWorldState(2, 64);
      });

      it('pheromone grid round trip: cell value copied correctly', () => {
        src.pheromoneGrids['1:0:surface'] = createPheromoneGrid(16, 16);
        phSet(src.pheromoneGrids['1:0:surface']!, 3, 3, 77);
        copyWorldState(src, dst);
        expect(phGet(dst.pheromoneGrids['1:0:surface']!, 3, 3)).toBe(77);
      });

      it('pheromone grid data independence: mutating src after copy does not affect dst', () => {
        src.pheromoneGrids['1:0:surface'] = createPheromoneGrid(16, 16);
        phSet(src.pheromoneGrids['1:0:surface']!, 3, 3, 77);
        copyWorldState(src, dst);
        // Mutate src AFTER copy — dst must remain unchanged
        phSet(src.pheromoneGrids['1:0:surface']!, 3, 3, 999);
        expect(phGet(dst.pheromoneGrids['1:0:surface']!, 3, 3)).toBe(77);
      });

      it('pheromone grid deletion propagation: grid removed from src is removed from dst on next copy', () => {
        src.pheromoneGrids['1:0:surface'] = createPheromoneGrid(16, 16);
        copyWorldState(src, dst);
        expect(dst.pheromoneGrids['1:0:surface']).toBeDefined();
        delete src.pheromoneGrids['1:0:surface'];
        copyWorldState(src, dst);
        expect(dst.pheromoneGrids['1:0:surface']).toBeUndefined();
      });
    });

    describe('Phase 7 terrain and entity fields', () => {
      let src: ReturnType<typeof createWorldState>;
      let dst: ReturnType<typeof createWorldState>;

      beforeEach(() => {
        src = createWorldState(1, 64);
        dst = createWorldState(2, 64);
      });

      it('surface grid data is copied (mutate src tile, copy, verify dst matches)', () => {
        src.surface.data[0] = 7;
        copyWorldState(src, dst);
        expect(dst.surface.data[0]).toBe(7);
      });

      it('surface grid independence: mutating src after copy does not affect dst', () => {
        src.surface.data[5] = 3;
        copyWorldState(src, dst);
        src.surface.data[5] = 99;
        expect(dst.surface.data[5]).toBe(3);
      });

      it('undergroundGrids: add grid to src, copy, verify dst has it', () => {
        src.undergroundGrids[1] = createUndergroundGrid(128, 64);
        src.undergroundGrids[1]!.data[0] = 5;
        copyWorldState(src, dst);
        expect(dst.undergroundGrids[1]).toBeDefined();
        expect(dst.undergroundGrids[1]!.data[0]).toBe(5);
      });

      it('undergroundGrids: mutate src grid after copy, verify dst unchanged', () => {
        src.undergroundGrids[1] = createUndergroundGrid(128, 64);
        src.undergroundGrids[1]!.data[0] = 5;
        copyWorldState(src, dst);
        src.undergroundGrids[1]!.data[0] = 99;
        expect(dst.undergroundGrids[1]!.data[0]).toBe(5);
      });

      it('undergroundGrids: grid removed from src is removed from dst on next copy', () => {
        src.undergroundGrids[1] = createUndergroundGrid(128, 64);
        copyWorldState(src, dst);
        expect(dst.undergroundGrids[1]).toBeDefined();
        delete src.undergroundGrids[1];
        copyWorldState(src, dst);
        expect(dst.undergroundGrids[1]).toBeUndefined();
      });

      it('foodPiles: add pile to src, copy, verify dst has it', () => {
        src.foodPiles.push({ foodPileId: 1, tileX: 10, tileY: 20 });
        copyWorldState(src, dst);
        expect(dst.foodPiles.length).toBe(1);
        expect(dst.foodPiles[0]!.tileX).toBe(10);
        expect(dst.foodPiles[0]!.tileY).toBe(20);
      });

      it('foodPiles: shrink src array, copy, verify dst shrinks', () => {
        src.foodPiles.push({ foodPileId: 1, tileX: 1, tileY: 1 });
        src.foodPiles.push({ foodPileId: 2, tileX: 2, tileY: 2 });
        copyWorldState(src, dst);
        expect(dst.foodPiles.length).toBe(2);
        src.foodPiles.pop();
        copyWorldState(src, dst);
        expect(dst.foodPiles.length).toBe(1);
      });

      it('pendingChambers: add entry by key, copy, verify dst has it', () => {
        src.pendingChambers['1:5:10'] = { colonyId: 1, chamberType: 0, anchorTileX: 5, anchorTileY: 10, width: 5, height: 3 };
        copyWorldState(src, dst);
        expect(dst.pendingChambers['1:5:10']).toBeDefined();
        expect(dst.pendingChambers['1:5:10']!.anchorTileX).toBe(5);
      });

      it('pendingChambers: remove entry from src, copy, verify dst entry removed', () => {
        src.pendingChambers['1:5:10'] = { colonyId: 1, chamberType: 0, anchorTileX: 5, anchorTileY: 10, width: 5, height: 3 };
        copyWorldState(src, dst);
        expect(dst.pendingChambers['1:5:10']).toBeDefined();
        delete src.pendingChambers['1:5:10'];
        copyWorldState(src, dst);
        expect(dst.pendingChambers['1:5:10']).toBeUndefined();
      });
    });

    describe('colony Phase 3 extension fields', () => {
      let src: ReturnType<typeof createWorldState>;
      let dst: ReturnType<typeof createWorldState>;

      beforeEach(() => {
        src = createWorldState(1, 64);
        dst = createWorldState(2, 64);
      });

      it('new-colony fallback patches Phase 3 defaults: entrances=[], rallyPoint=null, digFlowFieldDirty=false before extension copy', () => {
        // src has colony 1 with default Phase 3 fields; dst has no colony 1 yet
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        expect(dst.colonies[1]).toBeDefined();
        expect(Array.isArray(dst.colonies[1]!.entrances)).toBe(true);
        expect(dst.colonies[1]!.rallyPoint).toBeNull();
        expect(dst.colonies[1]!.digFlowFieldDirty).toBe(false);
      });

      it('copies colony.entrances: add entrance to src colony, copy, verify', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [{ entranceId: 1, surfaceTileX: 10, surfaceTileY: 64, isOpen: true }];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.entrances.length).toBe(1);
        expect(dst.colonies[1]!.entrances[0]!.surfaceTileX).toBe(10);
        expect(dst.colonies[1]!.entrances[0]!.isOpen).toBe(true);
      });

      it('copies colony.entrances: shrink src entrances array, copy, verify dst shrunk', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [
          { entranceId: 1, surfaceTileX: 10, surfaceTileY: 64, isOpen: false },
          { entranceId: 2, surfaceTileX: 20, surfaceTileY: 64, isOpen: false },
        ];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.entrances.length).toBe(2);
        src.colonies[1]!.entrances.pop();
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.entrances.length).toBe(1);
      });

      it('copies colony.rallyPoint: null → object → object-update → null transitions', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;

        // null → null
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.rallyPoint).toBeNull();

        // null → object
        src.colonies[1]!.rallyPoint = { tileX: 5, tileY: 10 };
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.rallyPoint).toEqual({ tileX: 5, tileY: 10 });

        // object → object update (same reference in dst)
        const prevRef = dst.colonies[1]!.rallyPoint;
        src.colonies[1]!.rallyPoint = { tileX: 7, tileY: 12 };
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.rallyPoint).toEqual({ tileX: 7, tileY: 12 });
        expect(dst.colonies[1]!.rallyPoint).toBe(prevRef); // object identity preserved

        // object → null
        src.colonies[1]!.rallyPoint = null;
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.rallyPoint).toBeNull();
      });

      it('copies colony.digFlowFieldDirty: true/false transitions', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = true;
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.digFlowFieldDirty).toBe(true);

        src.colonies[1]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.digFlowFieldDirty).toBe(false);
      });

      it('entrances array independence: pushing to dst does not affect src', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;
        copyWorldState(src, dst);
        dst.colonies[1]!.entrances.push({ entranceId: 99, surfaceTileX: 50, surfaceTileY: 64, isOpen: false });
        expect(src.colonies[1]!.entrances.length).toBe(0);
      });

      it('copyWorldState round-trips killCount', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;
        src.colonies[1]!.killCount = 5;

        dst.colonies[1] = createColonyRecord(1, 42);
        dst.colonies[1]!.entrances = [];
        dst.colonies[1]!.rallyPoint = null;
        dst.colonies[1]!.digFlowFieldDirty = false;
        dst.colonies[1]!.killCount = 99;

        copyWorldState(src, dst);
        expect(dst.colonies[1]!.killCount).toBe(5);
      });

      it('copyWorldState round-trips priorityFoodPileId (both a concrete id and null)', () => {
        src.colonies[1] = createColonyRecord(1, 42);
        src.colonies[1]!.entrances = [];
        src.colonies[1]!.rallyPoint = null;
        src.colonies[1]!.digFlowFieldDirty = false;
        src.colonies[1]!.priorityFoodPileId = 7;

        dst.colonies[1] = createColonyRecord(1, 42);
        dst.colonies[1]!.entrances = [];
        dst.colonies[1]!.rallyPoint = null;
        dst.colonies[1]!.digFlowFieldDirty = false;
        dst.colonies[1]!.priorityFoodPileId = 99;

        copyWorldState(src, dst);
        expect(dst.colonies[1]!.priorityFoodPileId).toBe(7);

        src.colonies[1]!.priorityFoodPileId = null;
        copyWorldState(src, dst);
        expect(dst.colonies[1]!.priorityFoodPileId).toBeNull();
      });
    });

  }); // end describe('copyWorldState')

  describe('allocateEntityId', () => {
    it('three sequential calls on a fresh WorldState return 0, 1, 2', () => {
      const world = createWorldState(0);
      const id0: EntityId = allocateEntityId(world);
      const id1: EntityId = allocateEntityId(world);
      const id2: EntityId = allocateEntityId(world);
      expect(id0).toBe(0);
      expect(id1).toBe(1);
      expect(id2).toBe(2);
    });

    it('nextEntityId === 3 after three allocations', () => {
      const world = createWorldState(0);
      allocateEntityId(world);
      allocateEntityId(world);
      allocateEntityId(world);
      expect(world.nextEntityId).toBe(3);
    });
  });
});
