/**
 * #290 PR 1 — food-equivalence projection for the located-food rewrite.
 *
 * `hashWorldState` hashes the serialized snapshot, so it legitimately changes
 * when PR 2 swaps the food storage (piles → a store block, `foodStored` →
 * slots, `starvationTimer` → `lastMealTick`) even if behaviour is identical.
 * `projectForEquivalence` is the hash input that must NOT change: the snapshot
 * with every storage-shaped key stripped, plus the food state re-read ONLY
 * through the food facade (`sim/food/food-api.ts`) and the hunger state as a
 * derived "ticks until starvation" number.
 *
 * The stripped-key lists below already name the keys PR 2 introduces (they are
 * absent today, so stripping them is a no-op). PR 2 re-implements the facade
 * and `hungerProjection` underneath; this file's projection logic otherwise
 * runs unchanged on both sides, which is what makes the byte-gate's
 * `BYTE_GATE_PROJECTION=1` mode a proof: capture on the PR 1 merge commit,
 * verify on the PR 2 branch.
 *
 * Test/tooling only (never on a tick path): it serializes the whole world and
 * allocates freely.
 */
import type { WorldState } from '../sim/types.js';
import {
  chamberStock,
  colonyFoodCapacity,
  colonyFoodTotal,
  colonyPoolFood,
  pileAmountFp,
  pileCount,
  pileFoodId,
  pileInitialFp,
  pileIsCorpse,
  pileSlotAt,
  pileTileX,
  pileTileY,
} from '../sim/food/food-api.js';
import { serializeWorldState } from './save.js';
import { fnv1a } from './world-hash.js';

/** Top-level snapshot keys stripped from the projection. */
export const PROJECTION_STRIPPED_WORLD_KEYS: readonly string[] = [
  'simVersion', // PR 2 bumps LATEST; the gate compares behaviour, not the stamp
  'foodPiles', // PR 1 storage (re-read through the facade below)
  'food', // PR 2 storage block
];

/** Per-colony snapshot keys stripped from the projection. */
export const PROJECTION_STRIPPED_COLONY_KEYS: readonly string[] = [
  'foodStored', // PR 1 entrance pool
  'queenStarvationTimer', // PR 1 queen clock (re-read via hungerProjection)
  'poolSlot', // PR 2
  'foodRaidedFp', // PR 2 (declared at 0)
  'foodLostToRaidsFp', // PR 2 (declared at 0)
  'raidTrips', // PR 2 (declared at 0)
];

/** Per-chamber snapshot keys stripped from the projection. */
export const PROJECTION_STRIPPED_CHAMBER_KEYS: readonly string[] = [
  'foodStored', // PR 1 chamber stock
  'foodSlot', // PR 2
];

/** Ant-column snapshot keys stripped from the projection. */
export const PROJECTION_STRIPPED_ANT_KEYS: readonly string[] = [
  'starvationTimer', // PR 1 larva clock (re-read via hungerProjection)
  'lastMealTick', // PR 2 clock
];

/**
 * Ticks until starvation for an ant whose hunger the sim tracks today (the
 * queen and larvae), or `null` for every other ant. The value is today's
 * countdown: STARVATION_GRACE_TICKS right after a successful meal, minus one per
 * failed meal; the ant dies when a failed meal takes it to 0. PR 2 must return
 * the same number from its `lastMealTick` clock.
 */
export function hungerProjection(world: WorldState, id: number): number | null {
  const ants = world.ants;
  if (ants.alive[id] !== 1) return null;
  for (const colony of Object.values(world.colonies)) {
    if (colony.queenEntityId === id) return colony.queenStarvationTimer;
    if (colony.larvae.includes(id)) return ants.starvationTimer[id]!;
  }
  return null;
}

/** JSON with object keys sorted recursively, so key insertion order never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = src[k];
    return out;
  });
}

/**
 * The food-equivalence projection of `world` as canonical JSON. See the module
 * doc. Contents:
 *  - the serialized snapshot minus the PROJECTION_STRIPPED_* keys;
 *  - `food.colonies[id]`: pool, total, capacity and every chamber's stock (in
 *    `colony.chambers` order), all through the facade;
 *  - `food.piles`: every live pile in creation order as
 *    [foodId, x, y, amountFp, initialFp, corpse];
 *  - `hunger`: [antId, ticksUntilStarvation] for every ant `hungerProjection`
 *    tracks, ascending id.
 */
export function projectForEquivalence(world: WorldState): string {
  const snap = serializeWorldState(world) as unknown as Record<string, unknown>;
  for (const k of PROJECTION_STRIPPED_WORLD_KEYS) delete snap[k];

  const ants = snap['ants'] as Record<string, unknown>;
  for (const k of PROJECTION_STRIPPED_ANT_KEYS) delete ants[k];

  const colonies = snap['colonies'] as Record<string, Record<string, unknown>>;
  for (const c of Object.values(colonies)) {
    for (const k of PROJECTION_STRIPPED_COLONY_KEYS) delete c[k];
    for (const ch of c['chambers'] as Array<Record<string, unknown>>) {
      for (const k of PROJECTION_STRIPPED_CHAMBER_KEYS) delete ch[k];
    }
  }

  const foodColonies: Record<string, unknown> = {};
  for (const [cid, colony] of Object.entries(world.colonies)) {
    foodColonies[cid] = {
      pool: colonyPoolFood(world, colony),
      total: colonyFoodTotal(world, colony),
      capacity: colonyFoodCapacity(colony),
      stock: colony.chambers.map((ch) => [ch.chamberId, chamberStock(world, ch)]),
    };
  }
  const piles: number[][] = [];
  const n = pileCount(world);
  for (let o = 0; o < n; o++) {
    const s = pileSlotAt(world, o);
    piles.push([
      pileFoodId(world, s),
      pileTileX(world, s),
      pileTileY(world, s),
      pileAmountFp(world, s),
      pileInitialFp(world, s),
      pileIsCorpse(world, s) ? 1 : 0,
    ]);
  }

  const hunger: number[][] = [];
  for (let id = 0; id < world.nextEntityId; id++) {
    const h = hungerProjection(world, id);
    if (h !== null) hunger.push([id, h]);
  }

  return canonicalJson({ snapshot: snap, food: { colonies: foodColonies, piles }, hunger });
}

/** fnv1a of `projectForEquivalence` — the byte-gate's `BYTE_GATE_PROJECTION=1` hash. */
export function hashFoodProjection(world: WorldState): string {
  return fnv1a(projectForEquivalence(world));
}
