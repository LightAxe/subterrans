/**
 * #231 — per-world scratch arena.
 *
 * The sim's module-level scratch buffers (combat sweep arrays, spider hunt
 * counters, invader-BFS buffers, occupancy map, idle list, motion out-params,
 * alive-queen id set, surface-movement cache) are all reset-before-use and safe
 * for sequential single-threaded ticking of ONE world — but they are shared across
 * every world in the process, which breaks the moment two worlds tick in the same
 * worker (Phase 6 background/replay sim) or a rolled-back world interleaves with
 * the live one (Phase 7 rollback). This module moves them to a per-world arena
 * keyed by WorldState identity — the proven pattern already used by tick.ts's
 * flow-field `cachesByWorld` WeakMap and `surfaceGoalBfsScratch`. Pure move: sizes,
 * reset semantics, and iteration order are preserved verbatim, so replay stays
 * byte-identical (no simVersion bump).
 *
 * #256 — larva-maturation.ts's `nurseScratch` (a monotonic per-tick STAMP, not a
 * reset buffer) is now in the arena too (`nurse`), completing the migration: no
 * process-global mutable sim state remains. It was byte-safe even when shared, so
 * the move is byte-identical — a single world's stamp sequence is unchanged.
 *
 * Layering: this sits at `src/sim/` root (NOT under `src/sim/ant/`), so it stays
 * outside the ant-cycle graph that check-ant-cycles.mjs enforces. Its only
 * ant-facing dependency is `import type { CardinalStep }` (erased at runtime).
 */
import type { WorldState } from './types.js';
import type { CardinalStep } from './ant/ant-motion.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT, MAX_ENTITIES } from './constants.js';
import { createSurfaceMovementCache, type SurfaceMovementCache } from './surface-features.js';

export interface ScratchArena {
  /** combat.ts — sweep-and-pair sort buffers + spider on-tile list. */
  combat: {
    liveIdx: number[];
    keyBySlot: Int32Array;
    contested: Uint8Array;
    spiderTile: number[];
  };
  /** spider.ts — hunt tile-count histogram (dirty-cleared) + nearest-entrance out-param. */
  spider: {
    huntTileCounts: Uint16Array;
    huntDirty: number[];
    nearestEntrance: { x: number; y: number; colonyId: number };
  };
  /** ant-combat-targeting.ts — invader underground BFS buffers (touched-cell restore). */
  antTargeting: {
    invBfsDist: Int32Array;
    invBfsQX: Int32Array;
    invBfsQY: Int32Array;
  };
  /** ant-movement.ts — same-colony occupancy resolution map. */
  movementOccupancy: Map<number, number>;
  /** tick.ts — step-10a idle-eligible ant list. */
  tickIdle: number[];
  /** ant-queens.ts — alive-queen id set (collectAliveQueenIds, cleared+refilled per call). */
  queenIds: Set<number>;
  /** ant-movement.ts — per-tick surface-movement effect cache (reset each tick). */
  surfaceMoveCache: SurfaceMovementCache;
  /** ant-motion.ts — cross-module cardinal-step + detour out-params. */
  motion: { cardinalStep: CardinalStep; detourResult: CardinalStep };
  /**
   * larva-maturation.ts — per-tick nurse-claim STAMP (#256). NOT a reset-before-use
   * buffer: `currentStamp` is a monotonic counter bumped once per acceleration pass,
   * and `usedStamp[nurseId] === currentStamp` marks "claimed this tick". Provably
   * byte-safe even when shared across worlds (each pass bumps a fresh stamp), but
   * moved here so no process-global mutable sim state survives (Phase-7 rollback).
   */
  nurse: { usedStamp: Uint32Array; currentStamp: number };
}

// eslint-disable-next-line subterrans/sim-module-state -- sim-cache: per-world scratch arena keyed by WorldState identity; transient, never serialized, recreated per world (same pattern as tick.ts cachesByWorld)
let SCRATCH = new WeakMap<WorldState, ScratchArena>();

/**
 * The world's scratch arena, lazily allocated on first use. Initial sizes match
 * today's module-level inits EXACTLY (combat `Int32Array(0)`/`Uint8Array(0)`; hunt
 * full SURFACE_*; invBFS `Int32Array(0)`) — every buffer is reset-before-use, so
 * these initial values are never observed; the grow-and-reassign logic in each
 * consumer sizes them on first real use.
 */
export function getScratch(world: WorldState): ScratchArena {
  let a = SCRATCH.get(world);
  if (a === undefined) {
    a = {
      combat: {
        liveIdx: [],
        keyBySlot: new Int32Array(0),
        contested: new Uint8Array(0),
        spiderTile: [],
      },
      spider: {
        huntTileCounts: new Uint16Array(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT),
        huntDirty: [],
        nearestEntrance: { x: -1, y: -1, colonyId: -1 },
      },
      antTargeting: {
        invBfsDist: new Int32Array(0),
        invBfsQX: new Int32Array(0),
        invBfsQY: new Int32Array(0),
      },
      movementOccupancy: new Map(),
      tickIdle: [],
      queenIds: new Set(),
      surfaceMoveCache: createSurfaceMovementCache(),
      motion: { cardinalStep: { dx: 0, dy: 0 }, detourResult: { dx: 0, dy: 0 } },
      // #256 — nurse stamp starts at 0 (matches the old module-global init); the
      // first acceleration pass bumps it to 1, so no nurse is ever falsely pre-claimed.
      nurse: { usedStamp: new Uint32Array(MAX_ENTITIES), currentStamp: 0 },
    };
    SCRATCH.set(world, a);
  }
  return a;
}

/** Test isolation — drop all arenas. Not required for correctness (WeakMap auto-collects). */
export function resetScratchArenas(): void {
  SCRATCH = new WeakMap();
}
