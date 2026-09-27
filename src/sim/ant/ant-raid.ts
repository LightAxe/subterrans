// src/sim/ant/ant-raid.ts
// #212 Layer 1 (behavior): automatic fighter raids (#290 PR 5, V52). Depends only on
// Layer-0 ant-motion (+ sibling sim modules: the food API, the stock flow field,
// hunger). The orchestrator (ant-movement.ts) and tick.ts call it; no behaviour
// module depends on it.
//
// A raid, in one paragraph. A fighter below ground in an ENEMY nest, sent there by
// its colony's rally on that nest's open entrance, LOOTS when `fighterMayLoot`
// holds: it walks the nest's stock flow field to a FoodStorage chamber that holds
// food (never the entrance pool, owner decision D3), takes one load
// (RAID_CARRY_FP) and HAULS it home — out of the enemy nest, across the surface,
// down its own shaft — where it deposits it as a forager would, then walks back to
// its rally and goes in again. A hostile in reach wins over loot (it fights); with
// the larder empty it hunts the nearest hostile anywhere, the queen included (D10).
//
// Extension point (plan §4.5). Everything about WHEN a fighter raids lives in
// `fighterMayLoot`: "rallied on this nest's entrance, nothing hostile within
// RAID_ENGAGE_RADIUS_TILES path tiles, empty-handed, not hungry, not in a duel,
// food reachable, and (V53) room at home to store it". An explicit Raid order (e.g. a rally intent) changes only that
// predicate — say, to loot even with a hostile in reach. The sub-states
// (FightingSubState.Looting / Hauling), the routing, the loot and deposit verbs and
// the counters stay as they are.
//
// Raid orders (#352, V60). The colony's raid type (`colonyRaidType`, raid-order.ts)
// branches here: lootVerdict lets Loot, Deny and Spoil loot (only Loot minds the
// room at home, the V53 gates) and never a Blockade or an Assault; a Deny hauler
// with nowhere to store its load drops it beside its own entrance
// (denyHaulerDropsLoad, step 10e); a Spoil looter destroys a load in place every
// SPOIL_TICKS_PER_LOAD ticks instead of taking it (step 16e); an Assault invader
// is pointed at the enemy queen (assaultQueenOf, step 10e). The Blockade itself is
// ant-blockade.ts. Below V60 every colony is Loot.
//
// Steps. 10e `updateRaiders` (after the fighter routing of 10c/10d) decides who
// loots this tick and points surface haulers at home; 16 (tickAntMovement) steps
// looters by the stock field and haulers by the entrance fields; 16e
// `tickRaidActions` (after the forager actions) takes and deposits.
//
// Determinism: integers only, no `/`, no RNG, no module-level mutable state (the
// stock field and the reach BFS live in the per-world scratch arena). Ants are
// visited in ascending id order, so two raiders on one chamber tile take in id
// order. Callers gate on `world.simVersion >= SIM_VERSION_V52_RAIDING`; below it
// nothing here writes Looting / Hauling, so every read of them is inert.
import type { ColonyRecord } from '../colony/colony-store.js';
import { computeStockFlowField } from '../chamber-flow.js';
import {
  RAID_CARRY_FP,
  RAID_ENGAGE_RADIUS_TILES,
  RAID_LOOT_START_STOCK_FP,
  RAID_START_CLEAR_RADIUS_TILES,
  SPOIL_TICKS_PER_LOAD,
} from '../constants.js';
import { AntTask, ChamberType, FightingSubState, RaidType } from '../enums.js';
import { FP_ONE, FP_SHIFT } from '../fixed.js';
import {
  chamberStock,
  colonyDepositableRoom,
  colonyHasNoDepositTarget,
  depositCarriedFood,
  depositIntoPool,
  isFoodChamberDepositable,
  pileDropRoomFp,
  takeFromStock,
  topUpOrSpawnCorpsePile,
  wholeLoadFp,
} from '../food/food-api.js';
import { fighterIsHungry } from '../hunger.js';
import { colonyRaidType, isAnyEntranceTile } from '../raid-order.js';
import { isSurfaceTileInComponent } from '../surface-features.js';
import { getScratch, RAID_REACH_WINDOW_RADIUS, RAID_REACH_WINDOW_SIDE } from '../scratch.js';
import { Zone } from '../terrain.js';
import {
  SIM_VERSION_V52_RAIDING,
  SIM_VERSION_V53_NO_LOOT_WHEN_FULL,
  SIM_VERSION_V59_INVADER_RETARGET,
  type WorldState,
} from '../types.js';
import {
  DIR_DX,
  DIR_DY,
  canEnterSurfaceTile,
  canEnterUndergroundTile,
  stampFriendTiles,
  tileSaturated,
} from './ant-motion.js';

/** Fighter `id` is hauling loot home (FightingSubState.Hauling; V52 only writes it). */
export function fighterIsHauling(world: WorldState, id: number): boolean {
  const ants = world.ants;
  return ants.task[id] === AntTask.Fighting && ants.subTask[id] === FightingSubState.Hauling;
}

/** Fighter `id` is on its way to loot a FoodStorage chamber this tick (Looting). */
export function fighterIsLooting(world: WorldState, id: number): boolean {
  const ants = world.ants;
  return ants.task[id] === AntTask.Fighting && ants.subTask[id] === FightingSubState.Looting;
}

/** `colony`'s rally point is on an OPEN entrance of `gridColony`. */
function rallyOnEntranceOf(colony: ColonyRecord, gridColony: ColonyRecord): boolean {
  const rp = colony.rallyPoint;
  const ents = gridColony.entrances;
  if (rp == null || ents == null) return false;
  for (let e = 0; e < ents.length; e++) {
    const ent = ents[e]!;
    if (ent.isOpen && ent.surfaceTileX === rp.tileX && ent.surfaceTileY === rp.tileY) return true;
  }
  return false;
}

/**
 * The stock flow field of colony `gridColonyId`'s nest for THIS tick (toward its
 * FoodStorage chambers holding food — with `start`, only those holding
 * RAID_LOOT_START_STOCK_FP; computeStockFlowField), computed on first use
 * in a tick and reused for the rest of it. Null if the nest or colony is missing.
 * Step 10e computes it for every nest a raider stands in, before anything that
 * tick could change a stock or a tile it reads (steps 11–15 move no food and dig
 * nothing; the loot step 16e runs after movement), so step 16 reads the same field.
 */
function stockFieldFor(world: WorldState, gridColonyId: number, start: boolean): Int32Array | null {
  const raid = getScratch(world).raid;
  const key = gridColonyId * 2 + (start ? 1 : 0);
  const grid = world.undergroundGrids[gridColonyId];
  const gridColony = world.colonies[gridColonyId];
  if (grid === undefined || gridColony === undefined) return null;
  const cells = grid.width * grid.height;
  let field = raid.stockField.get(key);
  if (
    field !== undefined &&
    field.length === cells &&
    raid.stockFieldTick.get(key) === world.tick
  ) {
    return field;
  }
  if (field === undefined || field.length !== cells) {
    field = new Int32Array(cells);
    raid.stockField.set(key, field);
  }
  if (raid.queue.length < cells) raid.queue = new Int32Array(cells);
  const min = start ? RAID_LOOT_START_STOCK_FP : 1;
  computeStockFlowField(world, grid, gridColony.chambers, field, raid.queue, min);
  raid.stockFieldTick.set(key, world.tick);
  return field;
}

/**
 * The stock flow field's step for looter `id` (in the nest it stands in): 0..3 a
 * cardinal step (DIR_DX / DIR_DY) toward the nearest FoodStorage chamber holding
 * food, -1 already on one, -2 none reachable (or no field).
 */
export function looterStepDir(world: WorldState, id: number): number {
  return stockStepDir(world, id, false);
}

/** The step (as looterStepDir) on the any-food field, or with `start` the one
 *  seeded only from chambers holding RAID_LOOT_START_STOCK_FP. */
function stockStepDir(world: WorldState, id: number, start: boolean): number {
  const ants = world.ants;
  const gridColonyId = ants.currentGridColonyId[id]!;
  const field = stockFieldFor(world, gridColonyId, start);
  const grid = world.undergroundGrids[gridColonyId];
  if (field === null || grid === undefined) return -2;
  const tx = ants.posX[id]! >> FP_SHIFT;
  const ty = ants.posY[id]! >> FP_SHIFT;
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return -2;
  return field[ty * grid.width + tx]!;
}

/**
 * #364 (V59) — drop from `cand` (hostiles within the reach window of raider `id`,
 * standing at (tx, ty) in nest `gridColonyId`) those on a tile SATURATED for it:
 * tileSaturatedFor's rule (ant-motion.ts) — its own tile when a lower-id friend
 * stands there too, any other tile when any friend does — evaluated from ONE pass
 * over the ants (stampFriendTiles) that stamps its friends' tiles in the reach
 * window, so each candidate is an O(1) lookup (not a scan of every entity per candidate). Keeps
 * `cand`'s order. Allocation-free (scratch window).
 */
function dropSaturatedCandidates(
  world: WorldState,
  id: number,
  gridColonyId: number,
  tx: number,
  ty: number,
  cand: number[],
): void {
  const ants = world.ants;
  const raid = getScratch(world).raid;
  const S = RAID_REACH_WINDOW_SIDE;
  const ox = tx - RAID_REACH_WINDOW_RADIUS;
  const oy = ty - RAID_REACH_WINDOW_RADIUS;
  const friendArr = raid.friendStamp;
  if (raid.friendCurrent >= 0x7fffffff) {
    friendArr.fill(0); // the stamp would wrap: start over
    raid.friendCurrent = 0;
  }
  const stamp = (raid.friendCurrent += 1);
  const ownHeld = stampFriendTiles(world, id, gridColonyId, ox, oy, S, S, friendArr, stamp);
  let kept = 0;
  for (let i = 0; i < cand.length; i++) {
    const c = cand[i]!;
    const wx = (ants.posX[c]! >> FP_SHIFT) - ox;
    const wy = (ants.posY[c]! >> FP_SHIFT) - oy;
    const own = wx === RAID_REACH_WINDOW_RADIUS && wy === RAID_REACH_WINDOW_RADIUS;
    if (tileSaturated(own, ownHeld, friendArr, wy * S + wx, stamp)) continue;
    cand[kept++] = c;
  }
  cand.length = kept;
}

/**
 * A hostile — an adult of another colony (a worker, fighter or nurse, or a queen;
 * brood does not count) — stands below ground in nest `gridColonyId` within
 * `R` PATH tiles of raider `id` (at most RAID_REACH_WINDOW_RADIUS): reached by a BFS through
 * tiles a fighter can enter, bounded to that radius. One Manhattan pass collects
 * the candidates (path distance is never shorter), so the BFS runs only with a
 * candidate near and the final pick reads only them. Returns that hostile (the nearest by path; the first found on a tie), or
 * -1 if none is in reach. Allocation-free (scratch window).
 * From V59 (#364) a hostile on a tile SATURATED for the raider does not count
 * (tileSaturatedFor's rule, applied by dropSaturatedCandidates: its colony already
 * holds the duel there). It neither stops the raider looting nor draws it in to
 * queue behind that duel.
 */
function hostileInReach(world: WorldState, id: number, gridColonyId: number, R: number): number {
  const ants = world.ants;
  const self = ants.colonyId[id]!;
  const tx = ants.posX[id]! >> FP_SHIFT;
  const ty = ants.posY[id]! >> FP_SHIFT;

  // Pass 1 — the hostiles within Manhattan R (path distance is never shorter), in
  // colony order, queen first then workers: the only ones that can be in reach.
  const raid = getScratch(world).raid;
  const cand = raid.reachCand;
  cand.length = 0;
  const v59 = world.simVersion >= SIM_VERSION_V59_INVADER_RETARGET;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const c = world.colonies[key as unknown as keyof typeof world.colonies]!;
    if (c.colonyId === self) continue;
    for (let w = -1; w < c.workers.length; w++) {
      const o = w < 0 ? c.queenEntityId : c.workers[w]!;
      if (o < 0 || ants.alive[o] !== 1) continue;
      if (ants.zone[o] !== Zone.Underground || ants.currentGridColonyId[o] !== gridColonyId)
        continue;
      const dx = (ants.posX[o]! >> FP_SHIFT) - tx;
      const dy = (ants.posY[o]! >> FP_SHIFT) - ty;
      if ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy) > R) continue;
      cand.push(o);
    }
  }
  if (v59 && cand.length > 0) dropSaturatedCandidates(world, id, gridColonyId, tx, ty, cand);
  if (cand.length === 0) return -1;

  // Pass 2 — bounded BFS (depth R) over the (2W+1)² window centred on the raider.
  const W = RAID_REACH_WINDOW_RADIUS;
  const grid = world.undergroundGrids[gridColonyId];
  if (grid === undefined) return cand[0]!; // defensive: no grid to path through, call it in reach
  const S = RAID_REACH_WINDOW_SIDE;
  const stampArr = raid.reachStamp;
  const dist = raid.reachDist;
  const q = raid.reachQ;
  if (raid.reachCurrent >= 0x7fffffff) {
    stampArr.fill(0); // the stamp would wrap: start over
    raid.reachCurrent = 0;
  }
  const stamp = (raid.reachCurrent += 1);
  const ox = tx - W;
  const oy = ty - W;
  const start = W * S + W;
  stampArr[start] = stamp;
  dist[start] = 0;
  q[0] = start;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cell = q[head++]!;
    const d = dist[cell]!;
    if (d >= R) continue;
    // Window cell → (wx, wy) without `/`: rows are S wide (S = 2 × the start radius + 1 = 13).
    let wy = 0;
    let rem = cell;
    while (rem >= S) {
      rem -= S;
      wy += 1;
    }
    const wx = rem;
    for (let i = 0; i < DIR_DX.length; i++) {
      const nwx = wx + DIR_DX[i]!;
      const nwy = wy + DIR_DY[i]!;
      if (nwx < 0 || nwy < 0 || nwx >= S || nwy >= S) continue;
      const ncell = nwy * S + nwx;
      if (stampArr[ncell] === stamp) continue;
      if (!canEnterUndergroundTile(grid, ox + nwx, oy + nwy, AntTask.Fighting)) continue;
      stampArr[ncell] = stamp;
      dist[ncell] = d + 1;
      q[tail++] = ncell;
    }
  }

  // Pass 3 — of those, the one on a reached cell nearest by path (first on a tie).
  let best = -1;
  let bestDist = R + 1;
  for (let i = 0; i < cand.length; i++) {
    const o = cand[i]!;
    const wx = (ants.posX[o]! >> FP_SHIFT) - ox;
    const wy = (ants.posY[o]! >> FP_SHIFT) - oy;
    if (wx < 0 || wy < 0 || wx >= S || wy >= S) continue;
    const cell = wy * S + wx;
    if (stampArr[cell] === stamp && dist[cell]! < bestDist) {
      bestDist = dist[cell]!;
      best = o;
    }
  }
  return best;
}

/**
 * THE raid predicate (plan §4.1; the one place a future explicit Raid order
 * changes). Fighter `id` of `colony` may loot this tick when every one holds:
 *   - the world is V52 or later, and `id` is a Fighter (D4: only fighters raid);
 *   - it is below ground in a FOREIGN nest (it went down that nest's entrance);
 *   - its colony's rally point is on an open entrance of that nest (D5: raiding is
 *     automatic on a rally into an enemy nest);
 *   - it is empty-handed, not in a duel, and not hungry (a hungry fighter walks
 *     home to eat first, D11 — fighterIsHungry);
 *   - V53+: its own colony has room for the loot (D14). To START, the room it can
 *     actually deposit into (`colonyDepositableRoom`: pool headroom plus the free
 *     space of each chamber that accepts a deposit) less what its raids have
 *     already committed (loads its haulers carry, plus one RAID_CARRY_FP per
 *     fighter of it already Looting) must be at least RAID_CARRY_FP, and the
 *     colony must have somewhere to deposit (not `colonyHasNoDepositTarget`). One
 *     already Looting keeps on until the colony has nowhere at all to put food,
 *     then stops. Either way it hunts instead: a full larder at home gains nothing
 *     from loot;
 *   - a FoodStorage chamber of that nest holds food and is reachable from it (the
 *     stock flow field; the entrance pool is never raided, D3);
 *   - no hostile (enemy worker or queen) within RAID_ENGAGE_RADIUS_TILES path
 *     tiles (combat first; with the larder empty it hunts the queen, D10).
 * With hysteresis: to START (it is not Looting yet) the chamber must hold
 * RAID_LOOT_START_STOCK_FP and nothing hostile may be within
 * RAID_START_CLEAR_RADIUS_TILES; so the answer depends on its current sub-state.
 * #352 (V60) — by raid type: Loot as above; Deny and Spoil skip the V53 room
 * gates (Deny keeps what will not fit by its door, Spoil takes nothing home);
 * a Blockade or an Assault never loots.
 */
export function fighterMayLoot(world: WorldState, colony: ColonyRecord, id: number): boolean {
  return lootVerdict(world, colony, id) === LOOT;
}

/** lootVerdict: may loot. */
const LOOT = -1;
/** lootVerdict: not a raider this tick (any condition but a hostile in reach fails). */
const NOT_A_RAIDER = -2;

/**
 * fighterMayLoot, with the reason: LOOT, NOT_A_RAIDER, or — when every condition
 * holds but a hostile is in reach — that hostile's id (step 10e sends the fighter
 * at it, so it closes on what stopped it instead of turning to another hostile
 * and stepping back out of reach: a loot/hunt flip-flop).
 */
function lootVerdict(world: WorldState, colony: ColonyRecord, id: number): number {
  if (world.simVersion < SIM_VERSION_V52_RAIDING) return NOT_A_RAIDER;
  // #352 (V60): a Blockade never goes in, and an Assault ignores food (step 10e
  // sends it at the queen instead); neither loots. Loot, Deny and Spoil do.
  const raidType = colonyRaidType(world, colony);
  if (raidType === RaidType.Blockade || raidType === RaidType.Assault) return NOT_A_RAIDER;
  const ants = world.ants;
  if (ants.task[id] !== AntTask.Fighting || ants.zone[id] !== Zone.Underground) {
    return NOT_A_RAIDER;
  }
  const gridColonyId = ants.currentGridColonyId[id]!;
  if (gridColonyId === ants.colonyId[id]) return NOT_A_RAIDER;
  const gridColony = world.colonies[gridColonyId];
  if (gridColony === undefined || !rallyOnEntranceOf(colony, gridColony)) return NOT_A_RAIDER;
  if (ants.foodCarrying[id] !== 0 || ants.combatOpponentId[id] !== -1) return NOT_A_RAIDER;
  if (fighterIsHungry(world, id)) return NOT_A_RAIDER;
  const looting = ants.subTask[id] === FightingSubState.Looting;
  // #352 (V60): only Loot minds the room at home. Deny steals regardless (what
  // will not fit is dropped by its own entrance) and Spoil brings nothing home.
  if (world.simVersion >= SIM_VERSION_V53_NO_LOOT_WHEN_FULL && raidType === RaidType.Loot) {
    // Stop: nowhere at all to put food. Start also needs room for a whole load.
    // Both gates must hold to start: with 3+ FoodStorage chambers each can sit
    // under its 512 fp deposit hysteresis while the total free space still holds
    // a load, and a start the stop gate refuses next tick would flip every tick.
    if (colonyHasNoDepositTarget(world, colony) || (!looting && !roomForALoad(world, colony))) {
      return NOT_A_RAIDER;
    }
  }
  // Hysteresis: a fighter not yet looting starts only for a reachable chamber
  // holding a full load and with nothing hostile within the wider start radius;
  // one looting keeps on while any food is reachable and nothing is in reach.
  const dir = stockStepDir(world, id, !looting);
  if (dir < -1) return NOT_A_RAIDER;
  const radius = looting ? RAID_ENGAGE_RADIUS_TILES : RAID_START_CLEAR_RADIUS_TILES;
  const blocker = hostileInReach(world, id, gridColonyId, radius);
  return blocker >= 0 ? blocker : LOOT;
}

/**
 * V53 — the per-colony committed raid food (see `ScratchArena.raid.committedFp`),
 * rebuilt from the ant store: every live Hauling fighter's load plus RAID_CARRY_FP
 * per Looting fighter. Ascending id order; integers only.
 */
function rebuildCommittedFp(world: WorldState): Map<number, number> {
  const raid = getScratch(world).raid;
  const committed = raid.committedFp;
  committed.clear();
  const ants = world.ants;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1 || ants.task[id] !== AntTask.Fighting) continue;
    const sub = ants.subTask[id]!;
    let fp = 0;
    if (sub === FightingSubState.Hauling) fp = ants.foodCarrying[id]!;
    else if (sub === FightingSubState.Looting) fp = RAID_CARRY_FP;
    if (fp === 0) continue;
    const c = ants.colonyId[id]!;
    committed.set(c, (committed.get(c) ?? 0) + fp);
  }
  return committed;
}

/** V53 — adjust colony `c`'s committed raid food by `fp` (a fighter starts or stops looting). */
function addCommittedFp(world: WorldState, c: number, fp: number): void {
  const committed = getScratch(world).raid.committedFp;
  committed.set(c, (committed.get(c) ?? 0) + fp);
}

/**
 * V53 — the raid START gate: the room `colony` can actually deposit into
 * (`colonyDepositableRoom`: pool headroom plus the free space of each chamber
 * that accepts a deposit — raw free capacity would count chambers under the
 * deposit hysteresis, which take nothing), less the food its raids have already
 * committed to bring home, holds at least one more full load.
 */
function roomForALoad(world: WorldState, colony: ColonyRecord): boolean {
  const raid = getScratch(world).raid;
  const committed =
    raid.committedTick === world.tick ? raid.committedFp : rebuildCommittedFp(world);
  const room = colonyDepositableRoom(world, colony);
  return room - (committed.get(colony.colonyId) ?? 0) >= RAID_CARRY_FP;
}

/**
 * Step 10e (V52; after 10c/10d fighter routing, which leaves haulers alone):
 *   - a hauler that has eaten its whole load goes back to its rally (no trip);
 *     on the surface a hauler heads for its colony's nearest open entrance (step
 *     16 steps it by the surface entrance flow field), below ground it needs no
 *     target (step 16 routes it by the entrance and food fields);
 *   - a fighter in a foreign nest loots this tick iff `fighterMayLoot`; one that
 *     no longer may (a hostile came into reach, the larder emptied, the rally
 *     moved) drops back to MovingToRally and fights or leaves as before — at the
 *     hostile in reach that stopped it, when that was the reason.
 */
export function updateRaiders(world: WorldState): void {
  if (world.simVersion < SIM_VERSION_V52_RAIDING) return;
  const ants = world.ants;
  // The stock field is recomputed this step whatever a between-ticks caller (a
  // fighterMayLoot query from render or tooling) may have cached: steps 3 and 10b
  // can have moved food or dug since.
  const raid = getScratch(world).raid;
  raid.stockFieldTick.clear();
  // V53: the committed raid food is built once here and kept current through the
  // loop as fighters start and stop looting (so a later raider sees less room).
  const v53 = world.simVersion >= SIM_VERSION_V53_NO_LOOT_WHEN_FULL;
  if (v53) {
    rebuildCommittedFp(world);
    raid.committedTick = world.tick;
  }
  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1 || ants.task[id] !== AntTask.Fighting) continue;
    const colonyId = ants.colonyId[id]!;
    const colony = world.colonies[colonyId];
    if (colony === undefined) continue;
    const sub = ants.subTask[id]!;
    if (sub === FightingSubState.Hauling) {
      if (ants.foodCarrying[id] === 0) {
        ants.subTask[id] = FightingSubState.MovingToRally;
        continue;
      }
      ants.targetPosX[id] = -1;
      ants.targetPosY[id] = -1;
      if (ants.zone[id] === Zone.Surface) {
        // #352 (V60): a Deny hauler at its door with nowhere to store the load
        // leaves it there as a food pile and goes back (denyHaulerDropsLoad).
        if (denyHaulerDropsLoad(world, colony, id)) continue;
        pointAtNearestOpenEntrance(world, colony, id);
      }
      continue;
    }
    const verdict = lootVerdict(world, colony, id);
    if (verdict === LOOT) {
      // V53: a raider starting now commits a load (later raiders see less room).
      if (v53 && sub !== FightingSubState.Looting) addCommittedFp(world, colonyId, RAID_CARRY_FP);
      ants.subTask[id] = FightingSubState.Looting;
      ants.targetPosX[id] = -1;
      ants.targetPosY[id] = -1;
      continue;
    }
    if (sub === FightingSubState.Looting) {
      ants.subTask[id] = FightingSubState.MovingToRally;
      if (v53) addCommittedFp(world, colonyId, -RAID_CARRY_FP);
    }
    if (verdict >= 0) {
      // A hostile in reach stopped it: go at THAT one (step 16's invader hunt
      // follows this target; without one it takes the nearest hostile in the nest).
      ants.targetPosX[id] = ants.posX[verdict]!;
      ants.targetPosY[id] = ants.posY[verdict]!;
      continue;
    }
    // #352 (V60): an Assault goes for the enemy queen (step 16 steps it there by
    // the wall-aware invader step, as it does a hunted hostile).
    const queen = assaultQueenOf(world, colony, id);
    if (queen >= 0) {
      ants.targetPosX[id] = ants.posX[queen]!;
      ants.targetPosY[id] = ants.posY[queen]!;
    }
  }
  // Outside this pass (a between-ticks fighterMayLoot query) the committed food is
  // rebuilt on every call, so it can never be read stale.
  raid.committedTick = -1;
}

/**
 * #352 (V60) — the queen fighter `id` of `colony` goes for on an Assault, or -1:
 * its colony's raid type is Assault, it is below ground in a FOREIGN nest whose
 * open entrance its colony is rallied on, it is not in a duel (a fight it is in
 * comes first: with no target, step 16's hunt takes the nearest hostile, which is
 * the one on its tile), and that nest's queen is alive and below ground in it. A
 * hungry one step 10c sent home to eat walks out before step 16 reads a target.
 */
function assaultQueenOf(world: WorldState, colony: ColonyRecord, id: number): number {
  if (colonyRaidType(world, colony) !== RaidType.Assault) return -1;
  const ants = world.ants;
  if (ants.zone[id] !== Zone.Underground || ants.combatOpponentId[id] !== -1) return -1;
  const gridColonyId = ants.currentGridColonyId[id]!;
  if (gridColonyId === ants.colonyId[id]) return -1;
  const gridColony = world.colonies[gridColonyId];
  if (gridColony === undefined || !rallyOnEntranceOf(colony, gridColony)) return -1;
  const q = gridColony.queenEntityId;
  if (q < 0 || ants.alive[q] !== 1 || ants.zone[q] !== Zone.Underground) return -1;
  return ants.currentGridColonyId[q] === gridColonyId ? q : -1;
}

/**
 * #352 (V60) — Deny: surface hauler `id` of `colony` drops its load beside its
 * own entrance when the colony cannot store it. It does when its colony's raid
 * type is Deny, it stands within one tile (Chebyshev) of one of its colony's open
 * entrances (it walks home by the surface entrance flow field, so it crosses that
 * ring before it can step onto the shaft and go down), and the room its stores
 * can take (`colonyDepositableRoom`) is less than its load. Where and how it drops:
 * `placeDenyLoad`. Returns true if it dropped.
 */
function denyHaulerDropsLoad(world: WorldState, colony: ColonyRecord, id: number): boolean {
  if (colonyRaidType(world, colony) !== RaidType.Deny) return false;
  const ants = world.ants;
  const load = ants.foodCarrying[id]!;
  if (load <= 0) return false;
  const ents = colony.entrances;
  if (ents == null) return false;
  const tx = ants.posX[id]! >> FP_SHIFT;
  const ty = ants.posY[id]! >> FP_SHIFT;
  let atDoor = false;
  for (let e = 0; e < ents.length && !atDoor; e++) {
    const ent = ents[e]!;
    if (!ent.isOpen) continue;
    const ex = ent.surfaceTileX - tx;
    const ey = ent.surfaceTileY - ty;
    atDoor = ex >= -1 && ex <= 1 && ey >= -1 && ey <= 1;
  }
  if (!atDoor) return false;
  if (colonyDepositableRoom(world, colony) >= load) return false;
  return placeDenyLoad(world, colony, id, tx, ty);
}

/**
 * #352 (V60) — Deny: hauler `id` of `colony` leaves its load as a surface food
 * pile at surface tile (tx, ty) — unless an entrance (of any colony) lies there,
 * where no pile may — or else on the first of its N/E/S/W neighbours that is
 * walkable and not an entrance; the first of those whose pile (or new pile) can
 * keep the whole load (`pileDropRoomFp`: never a full pile, over the pile cap or
 * off the surface component). The drop keeps whole pickups (a part-pickup
 * remainder is lost). It counts as a trip (`raidTrips`, as a deposit would) and
 * the hauler goes back to its rally. With no such tile it keeps its load and
 * returns false. A load under one pickup is nothing to drop: it is let go
 * without a trip. Its colony's foragers bring the pile in once there is room.
 */
function placeDenyLoad(
  world: WorldState,
  colony: ColonyRecord,
  id: number,
  tx: number,
  ty: number,
): boolean {
  const ants = world.ants;
  const fp = wholeLoadFp(ants.foodCarrying[id]!);
  if (fp <= 0) {
    ants.foodCarrying[id] = 0;
    ants.subTask[id] = FightingSubState.MovingToRally;
    return true;
  }
  let dropX = -1;
  let dropY = -1;
  for (let i = -1; i < DIR_DX.length && dropX < 0; i++) {
    const nx = i < 0 ? tx : tx + DIR_DX[i]!;
    const ny = i < 0 ? ty : ty + DIR_DY[i]!;
    if (!canEnterSurfaceTile(world, nx, ny)) continue;
    if (isAnyEntranceTile(world, nx, ny)) continue;
    if (pileDropRoomFp(world, nx, ny) < fp) continue;
    dropX = nx;
    dropY = ny;
  }
  if (dropX < 0) return false;
  topUpOrSpawnCorpsePile(world, dropX, dropY, fp);
  ants.foodCarrying[id] = 0;
  ants.subTask[id] = FightingSubState.MovingToRally;
  colony.raidTrips += 1;
  return true;
}

/** Target (tile centre) the open entrance of `colony` nearest to ant `id`
 *  (Manhattan; lower entranceId on a tie); none open → no target. */
function pointAtNearestOpenEntrance(world: WorldState, colony: ColonyRecord, id: number): void {
  const ants = world.ants;
  const ents = colony.entrances;
  if (ents == null) return;
  const tx = ants.posX[id]! >> FP_SHIFT;
  const ty = ants.posY[id]! >> FP_SHIFT;
  let best = -1;
  let bestDist = -1;
  let bestId = -1;
  for (let e = 0; e < ents.length; e++) {
    const ent = ents[e]!;
    if (!ent.isOpen) continue;
    const ex = ent.surfaceTileX - tx;
    const ey = ent.surfaceTileY - ty;
    const d = (ex < 0 ? -ex : ex) + (ey < 0 ? -ey : ey);
    if (best < 0 || d < bestDist || (d === bestDist && ent.entranceId < bestId)) {
      best = e;
      bestDist = d;
      bestId = ent.entranceId;
    }
  }
  if (best < 0) return;
  ants.targetPosX[id] = (ents[best]!.surfaceTileX << FP_SHIFT) + (FP_ONE >> 1);
  ants.targetPosY[id] = (ents[best]!.surfaceTileY << FP_SHIFT) + (FP_ONE >> 1);
}

/** (tx, ty) lies in chamber footprint (posX/posY anchor, width × height). */
function inFootprint(
  ch: { posX: number; posY: number; width: number; height: number },
  tx: number,
  ty: number,
): boolean {
  const bx = ch.posX >> FP_SHIFT;
  const by = ch.posY >> FP_SHIFT;
  return tx >= bx && tx < bx + ch.width && ty >= by && ty < by + ch.height;
}

/**
 * Step 16e (V52; right after the forager actions, 16b), ants in ascending id order:
 *   - LOOT: a Looting fighter standing in a FoodStorage chamber of the nest it is
 *     in that holds food takes up to RAID_CARRY_FP (`takeFromStock`; the first
 *     such chamber in chamber order) and turns Hauling. Its colony's
 *     `foodRaidedFp` and the victim's `foodLostToRaidsFp` grow by the amount.
 *   - DEPOSIT: a hauler below ground in its OWN nest, on a depositable FoodStorage
 *     chamber tile or at the top of one of its open shafts (where foragers use the
 *     pool), stores its load (`depositCarriedFood`: chamber, then pool). A full
 *     deposit completes the trip: `raidTrips` += 1 and it heads back to its rally
 *     (MovingToRally). A leftover waits on the ant; it retries each tick.
 */
export function tickRaidActions(world: WorldState): void {
  if (world.simVersion < SIM_VERSION_V52_RAIDING) return;
  const ants = world.ants;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (ants.alive[id] !== 1 || ants.task[id] !== AntTask.Fighting) continue;
    if (ants.zone[id] !== Zone.Underground) continue;
    const sub = ants.subTask[id]!;
    if (sub !== FightingSubState.Looting && sub !== FightingSubState.Hauling) continue;
    const colony = world.colonies[ants.colonyId[id]!];
    if (colony === undefined) continue;
    const gridColonyId = ants.currentGridColonyId[id]!;
    const tx = ants.posX[id]! >> FP_SHIFT;
    const ty = ants.posY[id]! >> FP_SHIFT;

    if (sub === FightingSubState.Looting) {
      if (gridColonyId === ants.colonyId[id] || ants.foodCarrying[id] !== 0) continue;
      const victim = world.colonies[gridColonyId];
      if (victim === undefined) continue;
      // #352 (V60): a spoiler destroys a load where it stands every
      // SPOIL_TICKS_PER_LOAD ticks (its id staggers the beat) and stays Looting.
      const spoil = colonyRaidType(world, colony) === RaidType.Spoil;
      if (spoil && (world.tick + id) % SPOIL_TICKS_PER_LOAD !== 0) continue;
      for (let c = 0; c < victim.chambers.length; c++) {
        const ch = victim.chambers[c]!;
        if (ch.chamberType !== ChamberType.FoodStorage || chamberStock(world, ch) <= 0) continue;
        if (!inFootprint(ch, tx, ty)) continue;
        if (spoil) {
          victim.foodLostToRaidsFp += takeFromStock(world, victim, ch, RAID_CARRY_FP);
          break;
        }
        const taken = takeFromStock(world, victim, ch, RAID_CARRY_FP);
        if (taken > 0) {
          ants.foodCarrying[id] = taken;
          ants.subTask[id] = FightingSubState.Hauling;
          ants.targetPosX[id] = -1;
          ants.targetPosY[id] = -1;
          colony.foodRaidedFp += taken;
          victim.foodLostToRaidsFp += taken;
        }
        break;
      }
      continue;
    }

    // Hauling: deposit at home.
    if (gridColonyId !== ants.colonyId[id]) continue;
    const load = ants.foodCarrying[id]!;
    if (load <= 0) continue;
    let site = false;
    for (let c = 0; c < colony.chambers.length && !site; c++) {
      const ch = colony.chambers[c]!;
      if (isFoodChamberDepositable(world, ch) && inFootprint(ch, tx, ty)) site = true;
    }
    const ents = colony.entrances;
    if (!site && ty === 0 && ents != null) {
      for (let e = 0; e < ents.length && !site; e++) {
        if (ents[e]!.isOpen && ents[e]!.surfaceTileX === tx) site = true;
      }
    }
    if (!site) continue;
    const left = depositCarriedFood(world, colony, tx, ty, load);
    ants.foodCarrying[id] = left;
    if (left === 0) {
      ants.subTask[id] = FightingSubState.MovingToRally;
      colony.raidTrips += 1;
    } else if (ty === 0 && ents != null && colonyRaidType(world, colony) === RaidType.Deny) {
      // #352 (V60): a Deny hauler that went down with room at the door and found
      // none (another hauler or a forager filled it first, or it came down under
      // Loot) does not wait for room: at the top of its shaft it leaves the rest
      // outside, beside the open entrance above it, and goes back.
      for (let e = 0; e < ents.length; e++) {
        const ent = ents[e]!;
        if (!ent.isOpen || ent.surfaceTileX !== tx) continue;
        placeDenyLoad(world, colony, id, ent.surfaceTileX, ent.surfaceTileY);
        break;
      }
    }
  }
}

/**
 * V52 — a hauler that dies drops its load (owner decision D13, plan §2.4):
 *   - on the surface, as a corpse pile at its tile (`topUpOrSpawnCorpsePile`, the
 *     V37 corpse path with its hard-cap and component guards: whole pickups, so a
 *     part-pickup remainder is lost);
 *   - below ground in a FOREIGN nest (the victim's), into that colony's pool
 *     (capped; the rest is lost), and the food handed back comes off the raider
 *     colony's `foodRaidedFp` and the victim's `foodLostToRaidsFp`;
 *   - below ground in its own nest, as a deposit where it stands (a depositable
 *     FoodStorage chamber under it, else the pool; capped).
 * Not handled (known limits): a hauler home with every store full parks at its
 * shaft until the queen makes room (as a forager carrier does); a hauler whose
 * colony has no open entrance holds until one opens or it has eaten its load.
 * Only a fighter carries food (a hauler; `foodCarrying > 0`), so a forager's
 * load is untouched (it is still lost on death). Called by despawnAnt
 * (ant-death.ts) at the ant's death tile. Returns true if it handled a load.
 */
export function dropHaulerLoad(world: WorldState, id: number): boolean {
  if (world.simVersion < SIM_VERSION_V52_RAIDING) return false;
  const ants = world.ants;
  if (ants.task[id] !== AntTask.Fighting) return false;
  const load = ants.foodCarrying[id]!;
  if (load <= 0) return false;
  ants.foodCarrying[id] = 0;
  const tx = ants.posX[id]! >> FP_SHIFT;
  const ty = ants.posY[id]! >> FP_SHIFT;
  if (ants.zone[id] === Zone.Surface) {
    // Under one whole pickup there is no pile to make and the load is lost: piles
    // hold whole pickups, and the facade refuses a zero-sized drop.
    topUpOrSpawnCorpsePile(world, tx, ty, load);
    return true;
  }
  const colonyId = ants.colonyId[id]!;
  const gridColonyId = ants.currentGridColonyId[id]!;
  const home = world.colonies[gridColonyId];
  if (home === undefined) return true;
  // In the enemy nest, the victim's pool (D13); at home, where it stands (a
  // depositable FoodStorage chamber, else the pool — as its deposit would have).
  const back =
    gridColonyId !== colonyId
      ? depositIntoPool(world, home, load)
      : load - depositCarriedFood(world, home, tx, ty, load);
  if (gridColonyId !== colonyId && back > 0) {
    const raider = world.colonies[colonyId];
    if (raider !== undefined) {
      raider.foodRaidedFp = raider.foodRaidedFp > back ? raider.foodRaidedFp - back : 0;
    }
    home.foodLostToRaidsFp = home.foodLostToRaidsFp > back ? home.foodLostToRaidsFp - back : 0;
  }
  return true;
}
