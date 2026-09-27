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
 * flow-field caches (now FLOW_FIELD_CACHES below) and `surfaceGoalBfsScratch`. Pure move: sizes,
 * reset semantics, and iteration order are preserved verbatim, so replay stays
 * byte-identical (no simVersion bump).
 *
 * #256 — larva-maturation.ts's `nurseScratch` (a monotonic per-tick STAMP, not a
 * reset buffer) is now in the arena too (`nurse`), completing the migration: no
 * process-global mutable sim state remains. It was byte-safe even when shared, so
 * the move is byte-identical — a single world's stamp sequence is unchanged.
 *
 * Layering: this sits at `src/sim/` root (NOT under `src/sim/ant/`), so it stays
 * outside the ant-cycle graph that check-ant-cycles.ts enforces. Its only
 * ant-facing dependency is `import type { CardinalStep }` (erased at runtime).
 */
import type { WorldState } from './types.js';
import type { CardinalStep } from './ant/ant-motion.js';
import type { PheromoneGrid } from './pheromone/pheromone-store.js';
import type { DigFlowFields } from './dig-system.js';
import type { EntranceFlowFields } from './entrance-flow.js';
import type { ChamberFlowFields } from './chamber-flow.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  MAX_ENTITIES,
  RAID_START_CLEAR_RADIUS_TILES,
} from './constants.js';

/** Half-side of ant-raid.ts's "hostile in reach" BFS window: the larger radius. */
export const RAID_REACH_WINDOW_RADIUS = RAID_START_CLEAR_RADIUS_TILES;
/** Side of that window: 2W + 1 tiles. */
export const RAID_REACH_WINDOW_SIDE = 2 * RAID_REACH_WINDOW_RADIUS + 1;
/** Cells of that window. */
const RAID_REACH_WINDOW_CELLS = RAID_REACH_WINDOW_SIDE * RAID_REACH_WINDOW_SIDE;
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
    nearestEntrance: { x: number; y: number; colonyId: number; entranceId: number };
  };
  /** ant-combat-targeting.ts — underground BFS buffers (touched-cell restore) for
   *  the invader step; from V44 (#325) the nest survey (surveyDefendedNests)
   *  borrows the QX/QY queue, marking cells in its own defenderReach instead. */
  antTargeting: {
    invBfsDist: Int32Array;
    invBfsQX: Int32Array;
    invBfsQY: Int32Array;
    /** V43 (#323) — per-entity sentry slot (rank at its entrance; from V44 (#325)
     *  also a tunnel defender's rank), written every tick for the fighters it is
     *  read for, before any read. */
    sentrySlot: Int32Array;
    /** V43 (#323) — every colony's entrance tiles as [x0, y0, x1, y1, …], refilled
     *  at the start of each updateFightAntTargets pass for the sentry post filter. */
    sentryEntranceTiles: number[];
    /** V43 (#323) — per-entity: 1 if step 10c sent this sentry into cover or to
     *  its post this tick, or (V44, #325) this tunnel defender to its tunnel post;
     *  read by step 16's occupancy pass. Cleared at the start of each
     *  updateFightAntTargets pass. */
    sentryMoving: Uint8Array;
    /** V43 (#323) — entranceId → that entrance's sentry posts (listSentryPosts),
     *  and (V44, #325) -1 - entranceId → its tunnel posts (surveyDefendedNests);
     *  arrays reused across passes. `sentryPostsBuilt` holds the keys whose list
     *  was rebuilt this pass. */
    sentryPosts: Map<number, number[]>;
    sentryPostsBuilt: Set<number>;
    /** #332 (V47) — surface tiles within reach of an enemy ant, for
     *  standDownSurplusSentries: a cell equal to `standDownStamp` is threatened
     *  this call; `standDownSources` marks enemy tiles already stamped. Stamps,
     *  not clears: each call that has a surplus to release bumps the stamp. */
    standDownThreat: Int32Array;
    standDownSources: Int32Array;
    standDownStamp: number;
    /** #328 (V46) — entranceId → every ring tile listSentryPosts accepts for that
     *  entrance, before posts are given to one owner each (`sentryPosts` then keeps
     *  only the ones it owns). `sentryRawPostsBuilt`: keys rebuilt this pass. */
    sentryRawPosts: Map<number, number[]>;
    sentryRawPostsBuilt: Set<number>;
    /** V43 (#323) — entranceId → the next sentry (or, V44, defender) rank there. */
    sentryNextRank: Map<number, number>;
    /** V44 (#325) — colonyId → the cells of its grid reachable from the shaft of
     *  `entranceId`, the entrance it defends, marked with this tick's `stamp`, and
     *  the `invaders` (enemy ant ids, id order) standing on them
     *  (surveyDefendedNests, step 10c; the cells are read again at step 16). */
    defenderReach: Map<
      number,
      { cells: Int32Array; stamp: number; entranceId: number; invaders: number[] }
    >;
    /** #364 (V59) — ant-motion.ts tileSaturatedFor's one-cell window, cleared to 0
     *  after every call (so its fixed stamp 1 never meets a stale value). */
    saturationProbe: Int32Array;
    /** #364 (V59) — invader-retarget.ts's per-call buffers, sized to the largest
     *  nest grid seen: a cell equal to `stamp` holds a friend (`friend`), is
     *  claimed by a lower-id friend (`block`), holds any hostile (`anyHostile`) or
     *  a free one (`hostile`), or was reached by the BFS (`seen`) THIS call;
     *  `firstStep` is the reached cell's first step. Stamps, not clears: each call
     *  bumps `stamp`. */
    retarget: {
      friend: Int32Array;
      block: Int32Array;
      hostile: Int32Array;
      anyHostile: Int32Array;
      seen: Int32Array;
      firstStep: Int32Array;
      queueX: Int32Array;
      queueY: Int32Array;
      stamp: number;
    };
  };
  /** ant-movement.ts — same-colony occupancy resolution map. */
  movementOccupancy: Map<number, number>;
  /** tick.ts — step-10a idle-eligible ant list. */
  tickIdle: number[];
  /** ant-queens.ts — alive-queen id set (collectAliveQueenIds, cleared+refilled per call). */
  queenIds: Set<number>;
  /** ant-movement.ts — per-tick surface-movement effect cache (reset each tick). */
  surfaceMoveCache: SurfaceMovementCache;
  /**
   * ant-motion.ts — cross-module cardinal-step + detour out-params, plus the
   * ant-foraging.ts no-revisit alternate out-param (pickNoRevisitSurfaceAlternate).
   */
  motion: { cardinalStep: CardinalStep; detourResult: CardinalStep; noRevisitAlt: CardinalStep };
  /**
   * ant-movement.ts — per-tick colonyId→surface DangerTrail grid cache (A1/V36).
   * Reset (`length = 0`) then repopulated once per tick so the per-ant risk-aware
   * routing lookups (sampler / no-revisit / obstacle detour) index by colonyId
   * instead of building a `pheromoneGridKey` string per ant per tick (AGENTS.md
   * hot-loop rule). Transient scratch — never serialized.
   */
  surfaceDangerByColony: (PheromoneGrid | undefined)[];
  /**
   * larva-maturation.ts — per-tick nurse-claim STAMP (#256). NOT a reset-before-use
   * buffer: `currentStamp` is a monotonic counter bumped once per acceleration pass,
   * and `usedStamp[nurseId] === currentStamp` marks "claimed this tick". Provably
   * byte-safe even when shared across worlds (each pass bumps a fresh stamp), but
   * moved here so no process-global mutable sim state survives (Phase-7 rollback).
   */
  nurse: { usedStamp: Uint32Array; currentStamp: number };
  /**
   * ant-raid.ts (#290 PR 5, V52) — per grid (the colony whose nest it is) and
   * threshold (key `gridColonyId * 2 + start`: start = 1 seeds only chambers
   * holding RAID_LOOT_START_STOCK_FP, 0 any food): the stock flow field toward its
   * FoodStorage chambers, and the tick it was computed on (a field is valid only for that tick: step 10e computes it
   * for every nest a raider stands in and step 16 reads it back). `queue` is the
   * BFS queue. `reach*` is the bounded "hostile in reach" BFS over a
   * (2R+1)² window round the raider: `reachStamp` marks visited cells, `reachDist`
   * their path distance, `reachQ` the queue (window indices).
   */
  raid: {
    stockField: Map<number, Int32Array>;
    stockFieldTick: Map<number, number>;
    queue: Int32Array;
    reachStamp: Int32Array;
    reachDist: Int32Array;
    reachQ: Int32Array;
    reachCurrent: number;
    /** #364 (V59) — ant-raid.ts dropSaturatedCandidates: the reach window's cells
     *  holding a friend of the raider this call (== `friendCurrent`). Stamps, not
     *  clears: each call bumps `friendCurrent`. */
    friendStamp: Int32Array;
    friendCurrent: number;
    /** hostileInReach's candidates (hostiles within Manhattan R), refilled per call. */
    reachCand: number[];
    /**
     * V53 — per colony, the food (fp) its raids have already committed to bring
     * home: the loads its live haulers carry plus RAID_CARRY_FP for each fighter
     * of it that is Looting. Built at the start of each step-10e pass and kept
     * current through it as fighters start and stop looting; `committedTick` is
     * the tick of the pass in progress, -1 outside it (a between-ticks
     * fighterMayLoot query rebuilds it per call).
     */
    committedFp: Map<number, number>;
    committedTick: number;
  };
  /**
   * ant-blockade.ts (#352, V60) — `mark[id]` is BLOCKADE_MARK_WALKING or
   * BLOCKADE_MARK_HELD when step 10c left surface fighter `id` for step 10c2 to
   * route (its colony blockades an enemy entrance; HELD = it was holding its post
   * last tick), else 0; step 10c2 turns it to BLOCKADE_MARK_ROUTED for one it sends
   * to the entrance round obstacles (read by step 16). Cleared at the start of
   * each 10c pass. `posts` is the
   * ring-post list of the entrance being routed (flat [x0, y0, x1, y1, …]),
   * `rank` the next post index per colony; both refilled per 10c2 pass.
   */
  blockade: {
    mark: Uint8Array;
    posts: number[];
    postsEntranceId: number;
    rank: Map<number, number>;
  };
}

/** #352 — scratch.blockade.mark: step 10c left this fighter for step 10c2. */
export const BLOCKADE_MARK_WALKING = 1;
/** #352 — scratch.blockade.mark: as WALKING, and it was holding its post last tick. */
export const BLOCKADE_MARK_HELD = 2;
/** #352 — scratch.blockade.mark, written by step 10c2: it is beyond the leash and
 *  walks to the blockaded entrance round obstacles (ant-blockade.ts). */
export const BLOCKADE_MARK_ROUTED = 3;

// eslint-disable-next-line subterrans/sim-module-state -- sim-cache: per-world scratch arena keyed by WorldState identity; transient, never serialized, recreated per world (same pattern as FLOW_FIELD_CACHES below)
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
        nearestEntrance: { x: -1, y: -1, colonyId: -1, entranceId: -1 },
      },
      antTargeting: {
        invBfsDist: new Int32Array(0),
        invBfsQX: new Int32Array(0),
        invBfsQY: new Int32Array(0),
        sentrySlot: new Int32Array(0),
        sentryEntranceTiles: [],
        sentryMoving: new Uint8Array(0),
        sentryPosts: new Map(),
        sentryPostsBuilt: new Set(),
        standDownThreat: new Int32Array(0),
        standDownSources: new Int32Array(0),
        standDownStamp: 0,
        sentryRawPosts: new Map(),
        sentryRawPostsBuilt: new Set(),
        sentryNextRank: new Map(),
        defenderReach: new Map(),
        saturationProbe: new Int32Array(1),
        retarget: {
          friend: new Int32Array(0),
          block: new Int32Array(0),
          hostile: new Int32Array(0),
          anyHostile: new Int32Array(0),
          seen: new Int32Array(0),
          firstStep: new Int32Array(0),
          queueX: new Int32Array(0),
          queueY: new Int32Array(0),
          stamp: 0,
        },
      },
      movementOccupancy: new Map(),
      tickIdle: [],
      queenIds: new Set(),
      surfaceMoveCache: createSurfaceMovementCache(),
      motion: {
        cardinalStep: { dx: 0, dy: 0 },
        detourResult: { dx: 0, dy: 0 },
        noRevisitAlt: { dx: 0, dy: 0 },
      },
      // A1 (V36) — empty; ant-movement.ts resets length + repopulates per tick.
      surfaceDangerByColony: [],
      // #256 — nurse stamp starts at 0 (matches the old module-global init); the
      // first acceleration pass bumps it to 1, so no nurse is ever falsely pre-claimed.
      nurse: { usedStamp: new Uint32Array(MAX_ENTITIES), currentStamp: 0 },
      raid: {
        stockField: new Map(),
        stockFieldTick: new Map(),
        queue: new Int32Array(0),
        reachStamp: new Int32Array(RAID_REACH_WINDOW_CELLS),
        reachDist: new Int32Array(RAID_REACH_WINDOW_CELLS),
        reachQ: new Int32Array(RAID_REACH_WINDOW_CELLS),
        reachCurrent: 0,
        friendStamp: new Int32Array(RAID_REACH_WINDOW_CELLS),
        friendCurrent: 0,
        reachCand: [],
        committedFp: new Map(),
        committedTick: -1,
      },
      blockade: {
        mark: new Uint8Array(0),
        posts: [],
        postsEntranceId: -1,
        rank: new Map(),
      },
    };
    SCRATCH.set(world, a);
  }
  return a;
}

/** Test isolation — drop all arenas. Not required for correctness (WeakMap auto-collects). */
export function resetScratchArenas(): void {
  SCRATCH = new WeakMap();
}

/**
 * Issue #160 — a world's dig / entrance / chamber flow-field caches. Unlike the
 * arena above these are NOT reset-before-use: they persist across the world's
 * ticks and are rebuilt only when a colony's dirty flags say its topology (or
 * food / brood inputs) changed, or on first use. tick.ts owns their contents and
 * creation (getFlowFieldCaches); the storage lives here so copyWorldState can
 * drop it (see invalidateWorldCaches) without types.ts importing tick.ts.
 */
export interface FlowFieldCaches {
  dig: DigFlowFields;
  entrance: EntranceFlowFields;
  chamber: ChamberFlowFields;
}

// eslint-disable-next-line subterrans/sim-module-state -- sim-cache: per-world flow-field cache keyed by WorldState identity; derived/recomputable, never authoritative sim state
let FLOW_FIELD_CACHES = new WeakMap<WorldState, FlowFieldCaches>();

/** The world's flow-field caches, or undefined if it has none yet (tick.ts creates them). */
export function peekFlowFieldCaches(world: WorldState): FlowFieldCaches | undefined {
  return FLOW_FIELD_CACHES.get(world);
}

/** Attach freshly created flow-field caches to `world` (tick.ts only). */
export function storeFlowFieldCaches(world: WorldState, caches: FlowFieldCaches): void {
  FLOW_FIELD_CACHES.set(world, caches);
}

/** Drop every world's flow-field caches (tick.ts resetFlowFieldCaches). */
export function resetFlowFieldCacheStore(): void {
  FLOW_FIELD_CACHES = new WeakMap();
}

/**
 * #340 — forget everything derived that `world` has cached off-WorldState: its
 * scratch arena and its flow-field caches. copyWorldState calls this on its
 * destination, whose own earlier ticks may have left caches describing a
 * different world. The flow fields are the ones that bite: they are rebuilt only
 * on a dirty flag or on first use, and a copy brings over the source's (usually
 * clear) dirty flags, so a previously-ticked destination kept routing on its own
 * stale topology and diverged from a fresh copy. The arena is dropped too (its
 * tick-stamped entries, e.g. raid.stockFieldTick, are keyed by values a copy can
 * make recur), so the destination starts exactly like a fresh or loaded world:
 * nothing cached, everything built from its own state on first use.
 *
 * Two WeakMap deletes, no allocation. A destination that is never ticked (the
 * render double buffer, a command projection) never rebuilds anything; one that
 * is ticked pays the same first-tick build a fresh world pays.
 */
export function invalidateWorldCaches(world: WorldState): void {
  SCRATCH.delete(world);
  FLOW_FIELD_CACHES.delete(world);
}
