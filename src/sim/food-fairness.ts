// food-fairness.ts — #395 (V69): every colony starts with food of its own near home.
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
//          draw) from FOOD_FAIRNESS_MIN_PICKUPS to FOOD_PILE_INITIAL_PICKUPS_MAX.
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
  movePile,
  pileAmountFp,
  pileCount,
  pileIsCorpse,
  pileSlotAt,
  pileTileX,
  pileTileY,
  spawnPile,
} from './food/food-api.js';
import { isSurfaceTileInComponent } from './surface-features.js';
import { ensureSurfaceGoalField, SURFACE_GOAL_UNREACHED } from './surface-routing.js';
import type { Rng } from './rng.js';
import {
  FOOD_FAIRNESS_MIN_PICKUPS,
  FOOD_FAIRNESS_RADIUS_TILES,
  FOOD_PICKUP_AMOUNT,
  FOOD_PILE_HARD_CAP,
  FOOD_PILE_INITIAL_PICKUPS_MAX,
  FOOD_PILE_MIN_COLONY_DISTANCE,
  FOOD_PILE_MIN_SEPARATION,
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
  doors: readonly (readonly [number, number])[],
  h: number,
  x: number,
  y: number,
  skipSlot: number,
): boolean {
  if (!isSurfaceTileInComponent(world, x, y)) return false;
  if (servedHome(homes, tileIndex(x, y)) !== h) return false;
  for (const [dx, dy] of doors) {
    if (Math.abs(x - dx) + Math.abs(y - dy) < FOOD_PILE_MIN_COLONY_DISTANCE) return false;
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
 * open entrances (see the file header for the rules). World generation only: call once, after the colonies and
 * the scenario's piles are placed. Draws from `rng` once per pile it moves (twice for
 * one it makes), and not at all when every colony already has its food.
 */
export function ensureFoodNearEachColony(world: WorldState, rng: Rng): void {
  const homes = colonyHomes(world);
  const doors = entranceTiles(world);
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
      if (isDestination(world, homes, doors, h, x, y, donor)) count++;
      return false;
    });
    if (count === 0) continue; // nowhere to put one: leave the colony as it is

    let k = rng.nextInt(count);
    let destX = -1;
    let destY = -1;
    forEachCandidate(world, homes, h, (x, y) => {
      if (!isDestination(world, homes, doors, h, x, y, donor)) return false;
      if (k > 0) {
        k--;
        return false;
      }
      destX = x;
      destY = y;
      return true;
    });

    if (donor !== -1) {
      movePile(world, donor, destX, destY);
    } else {
      // No pile to move: make a new one, as big as a donor must be at least.
      const pickups = rng.nextRange(FOOD_FAIRNESS_MIN_PICKUPS, FOOD_PILE_INITIAL_PICKUPS_MAX);
      spawnPile(world, allocateEntityId(world), destX, destY, pickups * FOOD_PICKUP_AMOUNT, 0);
    }
  }
}
