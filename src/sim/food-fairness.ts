// food-fairness.ts — #395 (V69): every colony starts with food of its own near home.
// It also hosts #403's matched-set balance of the home food (V76): balanceHomeFood, below.
//
// The scenario scatter (scenario.ts generateFoodPiles) places FOOD_PILE_COUNT piles
// at random, so on some maps a colony has no pile anywhere near its entrance, or only
// a small one, and its first foragers come home with too little while the queen
// starves. `ensureFoodNearEachColony` runs once at world generation, after the
// colonies and the piles are placed, and gives every colony that lacks it at least
// FOOD_FAIRNESS_MIN_PICKUPS pickups of its own within FOOD_FAIRNESS_RADIUS_TILES of
// home.
//
// It reads everything from the world: the colonies are `world.colonies` (any number,
// in ascending colony id), and a colony's home is the surface tiles of its open
// entrances. Nothing here knows which colony is the player's (CLNY-08) or where the
// colonies stand, so a map generator that places N colonies anywhere gets the
// guarantee by calling it.
//
// Distances are surface path lengths (the 4-connected goal field over the frozen
// terrain), so a pile behind a wall is as far as the walk round it. A tile's
// distance from a colony is its distance from the nearest of the colony's open
// entrances.
//
// Rules:
//   - A natural pile SERVES colony c when it is within FOOD_FAIRNESS_RADIUS_TILES of
//     c and strictly nearer c than every other colony (a pile equally near two
//     colonies serves neither). A pile serves at most one colony.
//   - A colony is satisfied when the piles serving it hold at least
//     FOOD_FAIRNESS_MIN_PICKUPS pickups between them. For each colony that is not
//     (ascending colony id):
//       1. The donor is the nearest natural pile to it that serves no colony and
//          holds at least FOOD_FAIRNESS_MIN_PICKUPS pickups, preferring one nearer it
//          than any other colony (its own side of the map); a tie goes to the
//          earlier pile in creation order.
//       2. The destination is drawn uniformly (one world.rngState draw) from every
//          tile that would serve the colony and keeps the scatter's spacing: walkable
//          and in the surface component, at least FOOD_PILE_MIN_COLONY_DISTANCE from
//          every colony's entrances, at least FOOD_PILE_MIN_SEPARATION from every
//          other pile.
//       3. The donor moves there (`movePile`): same id, same size, same place in
//          creation order. The pile count and the map's food total are unchanged.
//          With no donor, a new pile is made there instead, its size drawn (a second
//          draw) from FOOD_FAIRNESS_MIN_PICKUPS to FOOD_PILE_INITIAL_PICKUPS_MAX —
//          unless the store holds FOOD_PILE_HARD_CAP piles or the entity ids have run
//          out, in which case the colony is left as it is (no draw).
//     With no destination tile at all the colony is left as it is.
//   - A satisfied colony costs nothing: no draw, no change. A move never takes a
//     pile that serves a colony, and the moved pile serves only the colony it was
//     moved for, so one pass in colony order satisfies every colony that can be.
//
// World generation only (not the tick): it allocates freely (goal fields, small
// arrays). Deterministic: integer math, colony and pile iteration in a fixed order,
// and every random choice through the passed `rng`.

import type { WorldState } from './types.js';
import { allocateEntityId } from './types.js';
import {
  PICKUP_SHIFT,
  movePile,
  pileAmountFp,
  pileAtTile,
  pileCount,
  pileIsCorpse,
  pileSlotAt,
  pileTileX,
  pileTileY,
  resizePile,
  spawnPile,
} from './food/food-api.js';
import { isSurfaceTileInComponent } from './surface-features.js';
import { ensureSurfaceGoalField, SURFACE_GOAL_UNREACHED } from './surface-routing.js';
import type { Rng } from './rng.js';
import {
  FOOD_BALANCE_BAND_TILES,
  FOOD_BALANCE_RADIUS_TILES,
  FOOD_FAIRNESS_MIN_PICKUPS,
  FOOD_FAIRNESS_RADIUS_TILES,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
  FOOD_SCENT_RADIUS_TILES,
  MAX_ENTITIES,
  SURFACE_GRID_HEIGHT,
  SURFACE_GRID_WIDTH,
} from './constants.js';

/** Distance of a tile no open entrance of the colony reaches. */
const FAR = 0x7fffffff;

/** No colony (a pile or tile equally near two colonies, or near none). */
const NO_COLONY = -1;

/** The food (fp) a colony must have of its own near home, and a donor must hold. */
const MIN_FP = FOOD_FAIRNESS_MIN_PICKUPS * FOOD_PICKUP_AMOUNT;

/** One colony's home: the goal fields of its open entrances. */
interface Home {
  readonly colonyId: number;
  /** One per open entrance; a field holds each tile's path distance to that entrance. */
  readonly fields: readonly Int32Array[];
}

/**
 * Every colony's home, in ascending colony id. A colony with no open entrance has no
 * home tiles (empty `fields`): nothing is near it, it is never satisfied and never
 * given a pile (its foragers could not bring food home anyway).
 */
function colonyHomes(world: WorldState): Home[] {
  const homes: Home[] = [];
  const ids = Object.keys(world.colonies)
    .map(Number)
    .sort((a, b) => a - b);
  for (const colonyId of ids) {
    const colony = world.colonies[colonyId]!;
    const fields: Int32Array[] = [];
    // `?? []`: a hand-built test colony may have no entrances array at all.
    for (const e of colony.entrances ?? []) {
      if (e.isOpen) fields.push(ensureSurfaceGoalField(world, e.surfaceTileX, e.surfaceTileY));
    }
    homes.push({ colonyId, fields });
  }
  return homes;
}

/** Path distance from tile index `idx` to the nearest of `home`'s open entrances, or FAR. */
function homeDistance(home: Home, idx: number): number {
  let best = FAR;
  for (const field of home.fields) {
    const d = field[idx]!;
    if (d !== SURFACE_GOAL_UNREACHED && d < best) best = d;
  }
  return best;
}

/**
 * Index into `homes` of the colony strictly nearest tile `idx` (by path), or
 * NO_COLONY when two colonies tie for nearest or no colony reaches it.
 */
function nearestHome(homes: readonly Home[], idx: number): number {
  let best = NO_COLONY;
  let bestDist = FAR;
  let tied = false;
  for (let h = 0; h < homes.length; h++) {
    const d = homeDistance(homes[h]!, idx);
    if (d === FAR) continue;
    if (d < bestDist) {
      best = h;
      bestDist = d;
      tied = false;
    } else if (d === bestDist) {
      tied = true;
    }
  }
  return tied ? NO_COLONY : best;
}

/** Index into `homes` of the colony a pile on tile `idx` serves, or NO_COLONY. */
function servedHome(homes: readonly Home[], idx: number): number {
  const h = nearestHome(homes, idx);
  if (h === NO_COLONY) return NO_COLONY;
  return homeDistance(homes[h]!, idx) <= FOOD_FAIRNESS_RADIUS_TILES ? h : NO_COLONY;
}

function tileIndex(x: number, y: number): number {
  return y * SURFACE_GRID_WIDTH + x;
}

/**
 * Is tile (x, y) a place to put colony `homes[h]`'s pile? It must serve that colony
 * and keep the scatter's spacing: walkable and in the surface component, at least
 * FOOD_PILE_MIN_COLONY_DISTANCE (Manhattan) from every colony's entrances, and at
 * least FOOD_PILE_MIN_SEPARATION (Manhattan) from every pile but `skipSlot`.
 */
function isDestination(
  world: WorldState,
  homes: readonly Home[],
  entrances: readonly (readonly [number, number])[],
  h: number,
  x: number,
  y: number,
  skipSlot: number,
): boolean {
  if (!isSurfaceTileInComponent(world, x, y)) return false;
  if (servedHome(homes, tileIndex(x, y)) !== h) return false;
  for (const [ex, ey] of entrances) {
    if (Math.abs(x - ex) + Math.abs(y - ey) < FOOD_PILE_MIN_COLONY_DISTANCE) return false;
  }
  const n = pileCount(world);
  for (let o = 0; o < n; o++) {
    const slot = pileSlotAt(world, o);
    if (slot === skipSlot) continue;
    if (
      Math.abs(x - pileTileX(world, slot)) + Math.abs(y - pileTileY(world, slot)) <
      FOOD_PILE_MIN_SEPARATION
    ) {
      return false;
    }
  }
  return true;
}

/** Every colony's entrance tiles, open or not (the scatter keeps piles off all of them). */
function entranceTiles(world: WorldState): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const colony of Object.values(world.colonies)) {
    for (const e of colony.entrances ?? []) out.push([e.surfaceTileX, e.surfaceTileY]);
  }
  return out;
}

/** Do the natural piles serving colony `homes[h]` hold at least MIN_FP between them? */
function isSatisfied(world: WorldState, homes: readonly Home[], h: number): boolean {
  let fp = 0;
  const n = pileCount(world);
  for (let o = 0; o < n; o++) {
    const slot = pileSlotAt(world, o);
    if (pileIsCorpse(world, slot)) continue;
    if (servedHome(homes, tileIndex(pileTileX(world, slot), pileTileY(world, slot))) === h) {
      fp += pileAmountFp(world, slot);
    }
  }
  return fp >= MIN_FP;
}

/**
 * The pile to move to colony `homes[h]`: the nearest (by path) natural pile that
 * serves no colony and holds at least MIN_FP, preferring one nearer this colony than
 * any other (its own side of the map); ties go to the earlier pile in creation
 * order. -1 when there is none.
 */
function pickDonor(world: WorldState, homes: readonly Home[], h: number): number {
  let best = -1;
  let bestOwnSide = false;
  let bestDist = FAR;
  const n = pileCount(world);
  for (let o = 0; o < n; o++) {
    const slot = pileSlotAt(world, o);
    if (pileIsCorpse(world, slot) || pileAmountFp(world, slot) < MIN_FP) continue;
    const idx = tileIndex(pileTileX(world, slot), pileTileY(world, slot));
    if (servedHome(homes, idx) !== NO_COLONY) continue;
    const ownSide = nearestHome(homes, idx) === h;
    const d = homeDistance(homes[h]!, idx);
    if (best === -1 || (ownSide && !bestOwnSide) || (ownSide === bestOwnSide && d < bestDist)) {
      best = slot;
      bestOwnSide = ownSide;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Visit every candidate tile for colony `homes[h]` once, in row-major order: the
 * bounding box of the squares of half-width FOOD_FAIRNESS_RADIUS_TILES round its
 * open entrances, clipped to the map. Every tile that can serve the colony is in it
 * (path distance ≥ Manhattan distance). `visit` returns true to stop.
 */
function forEachCandidate(
  world: WorldState,
  homes: readonly Home[],
  h: number,
  visit: (x: number, y: number) => boolean,
): void {
  const colony = world.colonies[homes[h]!.colonyId]!;
  let x0 = SURFACE_GRID_WIDTH;
  let y0 = SURFACE_GRID_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (const e of colony.entrances ?? []) {
    if (!e.isOpen) continue;
    x0 = Math.min(x0, e.surfaceTileX - FOOD_FAIRNESS_RADIUS_TILES);
    y0 = Math.min(y0, e.surfaceTileY - FOOD_FAIRNESS_RADIUS_TILES);
    x1 = Math.max(x1, e.surfaceTileX + FOOD_FAIRNESS_RADIUS_TILES);
    y1 = Math.max(y1, e.surfaceTileY + FOOD_FAIRNESS_RADIUS_TILES);
  }
  x0 = Math.max(x0, 0);
  y0 = Math.max(y0, 0);
  x1 = Math.min(x1, SURFACE_GRID_WIDTH - 1);
  y1 = Math.min(y1, SURFACE_GRID_HEIGHT - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (visit(x, y)) return;
    }
  }
}

/**
 * #395 (V69) — give every colony in `world.colonies` at least FOOD_FAIRNESS_MIN_PICKUPS
 * pickups of natural food of its own within FOOD_FAIRNESS_RADIUS_TILES of one of its
 * open entrances (see the file header for the rules). World generation only: call
 * once, after the colonies and the scenario's piles are placed. Draws from `rng` once
 * per pile it moves (twice for one it makes), and not at all when every colony
 * already has its food.
 */
export function ensureFoodNearEachColony(world: WorldState, rng: Rng): void {
  const homes = colonyHomes(world);
  const entrances = entranceTiles(world);
  for (let h = 0; h < homes.length; h++) {
    if (homes[h]!.fields.length === 0) continue;
    if (isSatisfied(world, homes, h)) continue;

    const donor = pickDonor(world, homes, h);
    // With no pile to move a new one is made, if the store and the id counter allow.
    if (
      donor === -1 &&
      (pileCount(world) >= FOOD_PILE_HARD_CAP || world.nextEntityId >= MAX_ENTITIES)
    ) {
      continue;
    }
    let count = 0;
    forEachCandidate(world, homes, h, (x, y) => {
      if (isDestination(world, homes, entrances, h, x, y, donor)) count++;
      return false;
    });
    if (count === 0) continue; // nowhere to put one: leave the colony as it is

    let k = rng.nextInt(count);
    let destX = -1;
    let destY = -1;
    forEachCandidate(world, homes, h, (x, y) => {
      if (!isDestination(world, homes, entrances, h, x, y, donor)) return false;
      if (k > 0) {
        k--;
        return false;
      }
      destX = x;
      destY = y;
      return true;
    });

    // The two passes see the same world, so the k-th valid tile exists.
    if (destX < 0) throw new Error('ensureFoodNearEachColony: destination pass disagrees');
    if (donor !== -1) {
      if (!movePile(world, donor, destX, destY)) {
        throw new Error('ensureFoodNearEachColony: movePile refused a valid destination');
      }
    } else {
      // No pile to move: make a new one, as big as a donor must be at least.
      const pickups = rng.nextRange(FOOD_FAIRNESS_MIN_PICKUPS, FOOD_PILE_INITIAL_PICKUPS_MAX);
      const id = allocateEntityId(world);
      if (spawnPile(world, id, destX, destY, pickups * FOOD_PICKUP_AMOUNT, 0) < 0) {
        throw new Error('ensureFoodNearEachColony: spawnPile refused under the hard cap');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// #403 — balanceHomeFood: the food near home, dealt out in matched sets
// ---------------------------------------------------------------------------
//
// ensureFoodNearEachColony guarantees each colony some food within 25 tiles, but not
// the same food: on Normal seed 18 the player's first pile stood 18 tiles out, the
// AI's 9 and 12, and with the same rule-based play on both sides the AI had 18
// workers at 5:00 to the player's 2. Whether a colony can smell a pile from home
// (FOOD_SCENT_RADIUS_TILES) decides most openings: on V75 maps (Normal seeds 0-199,
// both colonies on the rule-based AI) one colony had at least twice the other's
// workers at 5:00 on 55% of the maps where only one of them could, 12% where both or
// neither could. balanceHomeFood runs straight after it and makes the food near
// every colony's home the same:
//
//   1. The pool: every natural pile within FOOD_BALANCE_RADIUS_TILES (surface path)
//      of some colony's open entrances, sorted by that distance (ties: creation
//      order). Each knows its side: the colony strictly nearest it.
//   2. With N colonies, the pool's piles are taken N at a time, nearest first, into
//      sets. A set's distance D is the floor of its piles' mean distance from home;
//      its size S the floor of their mean size (the remainder, under N pickups, is
//      dropped). The nearest set holds at least FOOD_FAIRNESS_MIN_PICKUPS, so the
//      #395 guarantee survives.
//   3. Each set gives every colony (ascending id) one pile, preferring one already on
//      its side: the pile stays where it is if its tile is within the set's band of
//      that colony (D ± FOOD_BALANCE_BAND_TILES, path) and keeps the scatter's
//      spacing; otherwise it moves to a tile drawn uniformly (one rng draw) from
//      every tile that is. With no such tile the band widens a tile each side, up to
//      BAND_WIDEN_STEPS; with none even then the pile moves to the valid tile on its
//      side nearest D (one draw), preferring D's side of the three edges below, and
//      stays where it is, unresized, only if its colony has no valid tile at all
//      (neither fallback ever fires on Normal seeds 0-199, where every set matched
//      exactly). The band never straddles FOOD_SCENT_RADIUS_TILES,
//      FOOD_FAIRNESS_RADIUS_TILES or FOOD_BALANCE_RADIUS_TILES, so a matched pile is
//      smelled from home, or within the first leash, for every colony or for none
//      (the fallback crosses an edge only when D's side holds no tile). Each pile
//      that was dealt is then resized to S.
//   4. The pool's last piles (fewer than N) move to a tile farther than
//      FOOD_BALANCE_RADIUS_TILES from every colony, as near equally far from each as
//      the map allows (one draw each).
//
// The pile count is unchanged and the food total changes only by the rounding in
// step 2 and the minimum in the nearest set. Deterministic: integer math, piles and
// colonies in a fixed order, every random choice through the passed rng. Like
// ensureFoodNearEachColony, it reads the colonies from the world (CLNY-08).

/** One natural pile of the balance pool. */
interface PoolPile {
  readonly slot: number;
  /** Place in creation order (the tie-break). */
  readonly order: number;
  /** Path distance to the nearest colony's open entrances. */
  readonly dist: number;
  /** Index into the homes of the colony strictly nearest it, or NO_COLONY. */
  readonly side: number;
  readonly pickups: number;
}

/** floor(sum / n) for 0 <= sum and 1 <= n, without `/` (world generation, small sums). */
function floorDiv(sum: number, n: number): number {
  let q = 0;
  while ((q + 1) * n <= sum) q++;
  return q;
}

/**
 * Is (x, y) a tile to put a pile of the set at [lo, hi] for colony `homes[h]`? It is
 * walkable and in the surface component, strictly nearer that colony than any other,
 * at path distance lo..hi from it, at least FOOD_PILE_MIN_COLONY_DISTANCE (Manhattan)
 * from every colony's entrances, holds no other pile, and is at least
 * FOOD_PILE_MIN_SEPARATION (Manhattan) from every pile that is not `selfSlot` and not
 * lifted (a pool pile not yet dealt).
 */
function isBalancedTile(
  world: WorldState,
  homes: readonly Home[],
  entrances: readonly (readonly [number, number])[],
  lifted: ReadonlySet<number>,
  h: number,
  x: number,
  y: number,
  lo: number,
  hi: number,
  selfSlot: number,
): boolean {
  if (!isSurfaceTileInComponent(world, x, y)) return false;
  const idx = tileIndex(x, y);
  if (nearestHome(homes, idx) !== h) return false;
  const d = homeDistance(homes[h]!, idx);
  if (d < lo || d > hi) return false;
  return isSpacedTile(world, entrances, lifted, x, y, selfSlot);
}

/** The scatter's spacing rules for a pile at (x, y), as isBalancedTile describes them. */
function isSpacedTile(
  world: WorldState,
  entrances: readonly (readonly [number, number])[],
  lifted: ReadonlySet<number>,
  x: number,
  y: number,
  selfSlot: number,
): boolean {
  for (const [ex, ey] of entrances) {
    if (Math.abs(x - ex) + Math.abs(y - ey) < FOOD_PILE_MIN_COLONY_DISTANCE) return false;
  }
  const occupant = pileAtTile(world, x, y);
  if (occupant !== -1 && occupant !== selfSlot) return false;
  const n = pileCount(world);
  for (let o = 0; o < n; o++) {
    const slot = pileSlotAt(world, o);
    if (slot === selfSlot || lifted.has(slot)) continue;
    if (
      Math.abs(x - pileTileX(world, slot)) + Math.abs(y - pileTileY(world, slot)) <
      FOOD_PILE_MIN_SEPARATION
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Visit every tile within Manhattan `radius` of one of colony `homes[h]`'s open
 * entrances' bounding box, row-major, clipped to the map (path distance >= Manhattan,
 * so every tile within path `radius` is visited). `visit` returns true to stop.
 */
function forEachTileNear(
  world: WorldState,
  homes: readonly Home[],
  h: number,
  radius: number,
  visit: (x: number, y: number) => boolean,
): void {
  const colony = world.colonies[homes[h]!.colonyId]!;
  let x0 = SURFACE_GRID_WIDTH;
  let y0 = SURFACE_GRID_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (const e of colony.entrances ?? []) {
    if (!e.isOpen) continue;
    x0 = Math.min(x0, e.surfaceTileX - radius);
    y0 = Math.min(y0, e.surfaceTileY - radius);
    x1 = Math.max(x1, e.surfaceTileX + radius);
    y1 = Math.max(y1, e.surfaceTileY + radius);
  }
  x0 = Math.max(x0, 0);
  y0 = Math.max(y0, 0);
  x1 = Math.min(x1, SURFACE_GRID_WIDTH - 1);
  y1 = Math.min(y1, SURFACE_GRID_HEIGHT - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (visit(x, y)) return;
    }
  }
}

/**
 * The band [lo, hi] of path distances for a set at distance `d` widened by `extra`:
 * d ± (FOOD_BALANCE_BAND_TILES + extra), kept on d's side of FOOD_SCENT_RADIUS_TILES,
 * FOOD_FAIRNESS_RADIUS_TILES and FOOD_BALANCE_RADIUS_TILES.
 */
function setBand(d: number, extra: number): readonly [number, number] {
  let lo = d - FOOD_BALANCE_BAND_TILES - extra;
  let hi = d + FOOD_BALANCE_BAND_TILES + extra;
  for (const edge of [
    FOOD_SCENT_RADIUS_TILES,
    FOOD_FAIRNESS_RADIUS_TILES,
    FOOD_BALANCE_RADIUS_TILES,
  ]) {
    if (d <= edge) {
      if (hi > edge) hi = edge;
    } else if (lo <= edge) {
      lo = edge + 1;
    }
  }
  return [lo, hi];
}

/** How many times a set's band widens by a tile each side when no tile fits it. */
const BAND_WIDEN_STEPS = 3;

/**
 * Deal the pile in `slot` to colony `homes[h]` at a tile in the set band round `d`:
 * keep it where it is if its tile is in the band, else move it to a tile drawn
 * uniformly (one draw) from those that are, widening the band a tile at a time up to
 * BAND_WIDEN_STEPS. If no tile fits even then, fall back to a tile drawn uniformly
 * (one draw) from the valid tiles on colony h's side (every rule but the band) whose
 * path distance is nearest `d`, preferring tiles on d's side of the three edges and
 * crossing one only when no tile is there. Returns false (no draw, no move) only when there is no
 * valid tile at all; the pile is then not dealt.
 */
function dealPile(
  world: WorldState,
  homes: readonly Home[],
  entrances: readonly (readonly [number, number])[],
  lifted: ReadonlySet<number>,
  rng: Rng,
  h: number,
  slot: number,
  d: number,
): boolean {
  const px = pileTileX(world, slot);
  const py = pileTileY(world, slot);
  for (let extra = 0; extra <= BAND_WIDEN_STEPS; extra++) {
    const [lo, hi] = setBand(d, extra);
    if (isBalancedTile(world, homes, entrances, lifted, h, px, py, lo, hi, slot)) return true;
    let count = 0;
    forEachTileNear(world, homes, h, hi, (x, y) => {
      if (isBalancedTile(world, homes, entrances, lifted, h, x, y, lo, hi, slot)) count++;
      return false;
    });
    if (count === 0) continue;
    let k = rng.nextInt(count);
    let destX = -1;
    let destY = -1;
    forEachTileNear(world, homes, h, hi, (x, y) => {
      if (!isBalancedTile(world, homes, entrances, lifted, h, x, y, lo, hi, slot)) return false;
      if (k > 0) {
        k--;
        return false;
      }
      destX = x;
      destY = y;
      return true;
    });
    if (destX < 0 || !movePile(world, slot, destX, destY)) {
      throw new Error('balanceHomeFood: destination pass disagrees');
    }
    return true;
  }
  // No tile in even the widest band: the nearest valid distance to d, on d's side of
  // the three edges if any tile is there, else on either.
  const [sideLo, sideHi] = setBand(d, FAR);
  return (
    dealNearest(world, homes, entrances, lifted, rng, h, slot, d, sideLo, sideHi) ||
    dealNearest(world, homes, entrances, lifted, rng, h, slot, d, 0, FAR)
  );
}

/**
 * Move the pile in `slot` to a tile drawn uniformly (one draw) from the valid tiles
 * on colony h's side at path distance lo..hi whose distance is nearest `d`. Returns
 * false (no draw, no move) when there is no such tile.
 */
function dealNearest(
  world: WorldState,
  homes: readonly Home[],
  entrances: readonly (readonly [number, number])[],
  lifted: ReadonlySet<number>,
  rng: Rng,
  h: number,
  slot: number,
  d: number,
  lo: number,
  hi: number,
): boolean {
  const valid = (x: number, y: number): boolean =>
    isBalancedTile(world, homes, entrances, lifted, h, x, y, lo, hi, slot);
  let bestGap = FAR;
  let count = 0;
  for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
      if (!valid(x, y)) continue;
      const gap = Math.abs(homeDistance(homes[h]!, tileIndex(x, y)) - d);
      if (gap < bestGap) {
        bestGap = gap;
        count = 0;
      }
      if (gap === bestGap) count++;
    }
  }
  if (count === 0) return false;
  let k = rng.nextInt(count);
  for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
      if (!valid(x, y)) continue;
      if (Math.abs(homeDistance(homes[h]!, tileIndex(x, y)) - d) !== bestGap) continue;
      if (k > 0) {
        k--;
        continue;
      }
      if (!movePile(world, slot, x, y)) throw new Error('balanceHomeFood: fallback move refused');
      return true;
    }
  }
  throw new Error('balanceHomeFood: fallback pass disagrees');
}

/**
 * Move a leftover pool pile in `slot` beyond FOOD_BALANCE_RADIUS_TILES of every
 * colony, to a tile drawn uniformly (one draw) from those whose distances to the
 * colonies differ least (spread 0, then 1, then 2, then any). Left where it is (no draw) when no tile is far enough from all.
 */
function dealLeftover(
  world: WorldState,
  homes: readonly Home[],
  entrances: readonly (readonly [number, number])[],
  lifted: ReadonlySet<number>,
  rng: Rng,
  slot: number,
): void {
  const spreadOk = (x: number, y: number, maxSpread: number): boolean => {
    if (!isSurfaceTileInComponent(world, x, y)) return false;
    const idx = tileIndex(x, y);
    let lo = FAR;
    let hi = -1;
    for (const home of homes) {
      const d = homeDistance(home, idx);
      if (d <= FOOD_BALANCE_RADIUS_TILES) return false;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    if (maxSpread >= 0 && hi - lo > maxSpread) return false;
    return isSpacedTile(world, entrances, lifted, x, y, slot);
  };
  const spreads = [0, 1, 2, -1];
  for (const maxSpread of spreads) {
    let count = 0;
    for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
      for (let x = 0; x < SURFACE_GRID_WIDTH; x++) if (spreadOk(x, y, maxSpread)) count++;
    }
    if (count === 0) continue;
    let k = rng.nextInt(count);
    for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
      for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
        if (!spreadOk(x, y, maxSpread)) continue;
        if (k > 0) {
          k--;
          continue;
        }
        if (!movePile(world, slot, x, y)) throw new Error('balanceHomeFood: leftover move refused');
        return;
      }
    }
  }
}

/**
 * #403 — deal the natural food within FOOD_BALANCE_RADIUS_TILES of the colonies out
 * again in matched sets, one pile per colony at the same distance from home and the
 * same size (see the section header). World generation only: call once, after
 * ensureFoodNearEachColony. Draws from `rng` once per pile it moves.
 */
export function balanceHomeFood(world: WorldState, rng: Rng): void {
  const homes = colonyHomes(world).filter((home) => home.fields.length > 0);
  const n = homes.length;
  if (n < 2) return;
  const entrances = entranceTiles(world);

  const pool: PoolPile[] = [];
  const count = pileCount(world);
  for (let o = 0; o < count; o++) {
    const slot = pileSlotAt(world, o);
    if (pileIsCorpse(world, slot)) continue;
    const idx = tileIndex(pileTileX(world, slot), pileTileY(world, slot));
    let dist = FAR;
    for (const home of homes) {
      const d = homeDistance(home, idx);
      if (d < dist) dist = d;
    }
    if (dist > FOOD_BALANCE_RADIUS_TILES) continue;
    pool.push({
      slot,
      order: o,
      dist,
      side: nearestHome(homes, idx),
      pickups: pileAmountFp(world, slot) >> PICKUP_SHIFT, // whole pickups
    });
  }
  // Nearest first; ties in creation order.
  pool.sort((a, b) => a.dist - b.dist || a.order - b.order);

  // The pool's slots not yet dealt: spacing ignores them (membership only, so the
  // Set's order never matters).
  const lifted = new Set<number>();
  for (const p of pool) lifted.add(p.slot);

  // Fewer piles than colonies: no set can be formed, so nothing is dealt (a leftover
  // dealt to the middle would take a colony's only near pile away).
  if (pool.length < n) return;

  let next = 0;
  let setIndex = 0;
  while (pool.length - next >= n) {
    const set = pool.slice(next, next + n);
    next += n;
    let distSum = 0;
    let sizeSum = 0;
    for (const p of set) {
      distSum += p.dist;
      sizeSum += p.pickups;
    }
    const d = floorDiv(distSum, n);
    let size = floorDiv(sizeSum, n);
    if (setIndex === 0 && size < FOOD_FAIRNESS_MIN_PICKUPS) size = FOOD_FAIRNESS_MIN_PICKUPS;
    const taken = new Uint8Array(n);
    for (let h = 0; h < n; h++) {
      let pick = -1;
      for (let i = 0; i < n; i++) {
        if (taken[i] === 0 && set[i]!.side === h) {
          pick = i;
          break;
        }
      }
      if (pick === -1) {
        for (let i = 0; i < n; i++) {
          if (taken[i] === 0) {
            pick = i;
            break;
          }
        }
      }
      taken[pick] = 1;
      const slot = set[pick]!.slot;
      const dealt = dealPile(world, homes, entrances, lifted, rng, h, slot, d);
      lifted.delete(slot);
      // A pile that found no tile at all stays where it is, at its own size.
      if (dealt) resizePile(world, slot, size * FOOD_PICKUP_AMOUNT);
    }
    setIndex++;
  }
  for (; next < pool.length; next++) {
    const slot = pool[next]!.slot;
    dealLeftover(world, homes, entrances, lifted, rng, slot);
    lifted.delete(slot);
  }
}
