/**
 * #229 — canonical serialized-vs-transient field schema (single source of truth).
 *
 * These lists MIRROR the hand-written `serializeWorldState` / `serializeAnts`
 * bodies in `save.ts` (they do NOT drive them). Their job is to let
 * `serializer-completeness.test.ts` assert that the live struct's key set is
 * EXACTLY partitioned into "serialized" and "deliberately transient" — so a new
 * `WorldState` / `AntComponents` field that nobody added to either list fails a
 * test loudly, instead of silently escaping every byte-identity assertion (the
 * `search*` gap that determinism.test.ts:75-83 documents was exactly this class).
 *
 * Typed as `(keyof WorldState)[]` / `(keyof AntComponents)[]`, so a field RENAME
 * or REMOVAL fails `tsc` here first. Placed in `platform/` (not `save.ts`) to
 * keep the ~2,000-line serializer untouched and give the browser-run cross-engine
 * test a lean import graph.
 */
import type { WorldState } from '../sim/types.js';
import type { AntComponents } from '../sim/ant/ant-store.js';

/**
 * The 22 real `WorldState` fields `serializeWorldState` emits (save.ts:958-1010).
 * Order is irrelevant — the completeness test compares as sets.
 */
export const SERIALIZED_WORLD_FIELDS: readonly (keyof WorldState)[] = [
  'tick',
  'rngState',
  'nextEntityId',
  'simVersion',
  'difficulty',
  'terrainSeed',
  'commandQueue',
  'ants',
  'colonies',
  'pheromoneGrids',
  'surface',
  'bakedSurfaceEffect',
  'undergroundGrids',
  'foodPiles',
  'recentlyDepletedFood',
  'pendingChambers',
  'droppedCombatKillCount',
  'droppedStructuralCount',
  'aiState',
  'spider',
  'spiderPriorityColonyId',
  'scatterReticleTile',
];

/**
 * `WorldState` fields DELIBERATELY not serialized — each WHY verified against
 * `types.ts` `createWorldState` / `copyWorldState` and `serializeWorldState`.
 */
export const TRANSIENT_WORLD_FIELDS: readonly (keyof WorldState)[] = [
  'events', // telemetry ring; reset to [] on load, replay re-emits (types.ts:768, save.ts:974 "skip events")
  'surfaceComponentMask', // DERIVED connectivity mask, lazily rebuilt (types.ts:760)
  'surfaceGoalFields', // DERIVED per-target BFS cache (types.ts:761)
  'surfaceGoalBfsScratch', // pure BFS scratch, overwritten before read (types.ts:762)
  'pendingQueenDeathContexts', // within-tick transient, cleared every tick (types.ts:772, copyWorldState:817-819)
  'droppedCommandOverflowCount', // #230 — transient session counter, reset to 0 on load (like events)
];

/**
 * The 36 real `AntComponents` SoA fields covered by `serializeAnts`.
 * `recentTilesX/Y/Head` are persisted via the packed `recentTiles` encoding, so
 * they appear here (real struct fields), NOT `recentTiles` (a serialization key,
 * not a struct field). `pathErr` is NOT here — #243 deleted the runtime field;
 * `serializeAnts` still emits an all-zeros `pathErr` KEY (a write-only save
 * vestige, save.ts:454/764), which the serializer-tie test accounts for
 * explicitly rather than via this struct-field list.
 */
export const SERIALIZED_ANT_SOA_FIELDS: readonly (keyof AntComponents)[] = [
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
  'searchHeadingX',
  'searchHeadingY',
  'searchHeadingTicks',
  'searchPrevTileX',
  'searchPrevTileY',
  'searchPauseTicks',
  'currentGridColonyId',
  'waitingDeposit',
  'recentTilesX',
  'recentTilesY',
  'recentTilesHead',
  'carryingBroodId',
  'carriedBy',
  'hp',
  'homeGroundBonusHp',
  'attackCooldown',
  'combatOpponentId',
  'fleeShelterUntilTick',
];

/** Every `AntComponents` field is persisted today — none deliberately transient. */
export const TRANSIENT_ANT_FIELDS: readonly (keyof AntComponents)[] = [];
