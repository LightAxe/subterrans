// jev-candidates.ts — seat-agnostic candidate generation + raw facts for the Jev
// opponent. Pure READS of WorldState; the only writes this feature makes are
// SimCommands pushed through jev-commands.ts (sim/render boundary, FNDN-07).
//
// Ported from the headless spike. Two invariants worth keeping:
//   1. Never reference PLAYER_COLONY_ID / ENEMY_COLONY_ID here — everything is
//      derived from the `Seats` it is handed, so the same code drives either seat.
//   2. Every candidate must be legal at the moment it is offered (a Rally point
//      inside the surface walkable component, a frontier tile that is actually
//      Solid and adjacent to our tunnels, a chamber anchor that mirrors tick.ts's
//      PlaceChamber gates). Jev is never offered a move the sim would reject.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import type { NestEntrance } from '../sim/colony/entrance.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import { Zone, UndergroundTileState, ugGet } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { isSurfaceTileInComponent } from '../sim/surface-features.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import { colonyFoodTotal } from '../sim/colony/colony-system.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  FOOD_CHAMBER_CAPACITY,
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_CEILING_ROW_Y,
} from '../sim/constants.js';
import type {
  Seats,
  Tile,
  RawFacts,
  PileFact,
  CandidateSet,
  DigCandidate,
  DigDirection,
  PostureKey,
  PostureCandidate,
  FoodPriorityKey,
  FoodPriorityCandidate,
  RatioKey,
  RatioCandidate,
} from './jev-types.js';

/** Lookback for "recent" kill/loss counts, in ticks (30 s @ 20 Hz). */
export const RECENT_WINDOW_TICKS = 600;
export const NEAR_ENTRANCE_TILES = 10;
export const SPIDER_NEAR_TILES = 24;
export const CONTEST_MAX_DIST = 60;
export const MIDFIELD_SEARCH_RADIUS = 8;
export const EXPAND_STORAGE_FRACTION_PCT = 80;

export const RATIO_CANDIDATES: Readonly<Record<RatioKey, RatioCandidate>> = {
  all_in_economy: {
    ratio: { forage: 9, fight: 1 },
    describe: 'almost everyone forages; a token guard fights',
  },
  economy: {
    ratio: { forage: 7, fight: 3 },
    describe: 'mostly forage, a modest share of fighters',
  },
  balanced: {
    ratio: { forage: 5, fight: 5 },
    describe: 'an even split between foraging and fighting',
  },
  military: {
    ratio: { forage: 3, fight: 7 },
    describe: 'mostly fighters, a thin foraging crew',
  },
  all_in_war: {
    ratio: { forage: 1, fight: 9 },
    describe: 'almost everyone fights; foraging nearly stops',
  },
};

export const DIG_DESCRIBE: Readonly<Record<DigDirection, string>> = {
  deeper: 'extend our tunnels downward, away from the surface',
  wider_left: 'extend our tunnels sideways to the left',
  wider_right: 'extend our tunnels sideways to the right',
  toward_surface: 'extend our tunnels upward toward the surface',
  hold: 'stop marking new tiles to dig for now',
};

const DIG_DIRECTIONS: readonly DigDirection[] = [
  'deeper',
  'wider_left',
  'wider_right',
  'toward_surface',
  'hold',
];

export function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function firstOpenEntrance(colony: ColonyRecord): NestEntrance | null {
  for (const e of colony.entrances) if (e.isOpen) return e;
  return null;
}

/** The tile we treat as "home" — our first open Entrance, else any Entrance. */
export function homeTile(colony: ColonyRecord): Tile | null {
  const e = firstOpenEntrance(colony) ?? colony.entrances[0] ?? null;
  return e === null ? null : { x: e.surfaceTileX, y: e.surfaceTileY };
}

export function nearestOpenOpponentEntrance(opp: ColonyRecord, from: Tile): NestEntrance | null {
  let best: NestEntrance | null = null;
  let bestD = Infinity;
  for (const e of opp.entrances) {
    if (!e.isOpen) continue;
    const d = manhattan(from.x, from.y, e.surfaceTileX, e.surfaceTileY);
    if (d < bestD || (d === bestD && best !== null && e.entranceId < best.entranceId)) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/** Nearest surface tile inside the walkable component to (x, y), within `radius`. */
export function nearestComponentTile(
  world: WorldState,
  x: number,
  y: number,
  radius: number,
): Tile | null {
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= SURFACE_GRID_WIDTH || ty >= SURFACE_GRID_HEIGHT) continue;
        if (isSurfaceTileInComponent(world, tx, ty)) return { x: tx, y: ty };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Underground component (mirrors tick.ts isFootprintReachableAfterDigs: BFS from
// each Entrance's underground row-0 tile through every non-Solid tile).
// ---------------------------------------------------------------------------

export interface UndergroundComponent {
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly cx: number;
  readonly cy: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export function undergroundComponent(
  world: WorldState,
  colonyId: ColonyId,
): UndergroundComponent | null {
  const grid = world.undergroundGrids[colonyId];
  const colony = world.colonies[colonyId];
  if (!grid || !colony) return null;
  const gridW = grid.width;
  const gridH = grid.height;
  const mask = new Uint8Array(gridW * gridH);
  const queue: number[] = [];
  for (const e of colony.entrances) {
    const sx = e.surfaceTileX;
    if (sx < 0 || sx >= gridW) continue;
    if (ugGet(grid, sx, 0) === UndergroundTileState.Solid) continue;
    if (mask[sx]) continue;
    mask[sx] = 1;
    queue.push(sx, 0);
  }
  let head = 0;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = gridW;
  let maxX = -1;
  let minY = gridH;
  let maxY = -1;
  while (head < queue.length) {
    const x = queue[head]!;
    const y = queue[head + 1]!;
    head += 2;
    count += 1;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const nbrs: ReadonlyArray<readonly [number, number]> = [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ];
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
      const k = ny * gridW + nx;
      if (mask[k]) continue;
      if (ugGet(grid, nx, ny) === UndergroundTileState.Solid) continue;
      mask[k] = 1;
      queue.push(nx, ny);
    }
  }
  if (count === 0) return null;
  return {
    mask,
    width: gridW,
    height: gridH,
    count,
    cx: sumX / count,
    cy: sumY / count,
    minX,
    maxX,
    minY,
    maxY,
  };
}

/** Solid tiles (y > ceiling row) 4-adjacent to the component, filtered + ordered by direction. */
export function digFrontier(
  world: WorldState,
  colonyId: ColonyId,
  dir: DigDirection,
  comp: UndergroundComponent | null = undergroundComponent(world, colonyId),
): Tile[] {
  if (dir === 'hold' || comp === null) return [];
  const grid = world.undergroundGrids[colonyId];
  if (!grid) return [];
  const gridW = comp.width;
  const gridH = comp.height;
  const seen = new Uint8Array(gridW * gridH);
  const out: Tile[] = [];
  for (let y = comp.minY; y <= comp.maxY; y++) {
    for (let x = comp.minX; x <= comp.maxX; x++) {
      if (!comp.mask[y * gridW + x]) continue;
      const nbrs: ReadonlyArray<readonly [number, number]> = [
        [x, y - 1],
        [x + 1, y],
        [x, y + 1],
        [x - 1, y],
      ];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || nx >= gridW || ny <= UNDERGROUND_CEILING_ROW_Y || ny >= gridH) continue;
        const k = ny * gridW + nx;
        if (seen[k]) continue;
        if (ugGet(grid, nx, ny) !== UndergroundTileState.Solid) continue;
        seen[k] = 1;
        const keep =
          dir === 'deeper'
            ? ny > comp.cy
            : dir === 'toward_surface'
              ? ny < comp.cy
              : dir === 'wider_left'
                ? nx < comp.cx
                : nx > comp.cx;
        if (keep) out.push({ x: nx, y: ny });
      }
    }
  }
  const cx = comp.cx;
  out.sort((a, b) => {
    switch (dir) {
      case 'deeper':
        return b.y - a.y || Math.abs(a.x - cx) - Math.abs(b.x - cx) || a.x - b.x;
      case 'toward_surface':
        return a.y - b.y || Math.abs(a.x - cx) - Math.abs(b.x - cx) || a.x - b.x;
      case 'wider_left':
        return a.x - b.x || a.y - b.y;
      default:
        return b.x - a.x || a.y - b.y;
    }
  });
  return out;
}

/** Mirrors tick.ts PlaceChamber gates; returns the most "spread out" legal anchor. */
export function findReachableChamberSpot(
  world: WorldState,
  colonyId: ColonyId,
  chamberType: ChamberType,
  comp: UndergroundComponent | null = undergroundComponent(world, colonyId),
): Tile | null {
  const grid = world.undergroundGrids[colonyId];
  const colony = world.colonies[colonyId];
  if (!grid || !colony || comp === null) return null;
  const dims = CHAMBER_DIMENSIONS[chamberType];
  const gridW = grid.width;
  const gridH = grid.height;
  const pendings = Object.values(world.pendingChambers).filter((p) => p.colonyId === colonyId);
  const boxes: { x: number; y: number; w: number; h: number }[] = [
    ...colony.chambers.map((c) => ({
      x: c.posX >> FP_SHIFT,
      y: c.posY >> FP_SHIFT,
      w: c.width,
      h: c.height,
    })),
    ...pendings.map((p) => ({ x: p.anchorTileX, y: p.anchorTileY, w: p.width, h: p.height })),
  ];
  const inComp = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < gridW && y < gridH && comp.mask[y * gridW + x] === 1;
  let best: Tile | null = null;
  let bestScore = -Infinity;
  const ay0 = Math.max(UNDERGROUND_CEILING_ROW_Y + 1, comp.minY - 6);
  const ay1 = Math.min(gridH - dims.height, comp.maxY + 6);
  const ax0 = Math.max(0, comp.minX - 8);
  const ax1 = Math.min(gridW - dims.width, comp.maxX + 8);
  for (let ay = ay0; ay <= ay1; ay++) {
    for (let ax = ax0; ax <= ax1; ax++) {
      if (Object.hasOwn(world.pendingChambers, `${colonyId}:${ax}:${ay}`)) continue;
      let bad = false;
      for (const b of boxes) {
        if (ax < b.x + b.w && ax + dims.width > b.x && ay < b.y + b.h && ay + dims.height > b.y) {
          bad = true;
          break;
        }
      }
      if (bad) continue;
      let reachable = false;
      for (let dy = 0; dy < dims.height && !bad; dy++) {
        for (let dx = 0; dx < dims.width; dx++) {
          const tx = ax + dx;
          const ty = ay + dy;
          if (ugGet(grid, tx, ty) === UndergroundTileState.BeingDug) {
            bad = true;
            break;
          }
          if (
            !reachable &&
            (inComp(tx, ty) ||
              inComp(tx, ty - 1) ||
              inComp(tx + 1, ty) ||
              inComp(tx, ty + 1) ||
              inComp(tx - 1, ty))
          ) {
            reachable = true;
          }
        }
      }
      if (bad || !reachable) continue;
      // Spread score: distance to the nearest existing box center (larger = better).
      let score = Infinity;
      const cxA = ax + dims.width / 2;
      const cyA = ay + dims.height / 2;
      for (const b of boxes) {
        const d = Math.abs(cxA - (b.x + b.w / 2)) + Math.abs(cyA - (b.y + b.h / 2));
        if (d < score) score = d;
      }
      if (boxes.length === 0) score = 0;
      if (
        score > bestScore ||
        (score === bestScore && best !== null && (ay < best.y || (ay === best.y && ax < best.x)))
      ) {
        best = { x: ax, y: ay };
        bestScore = score;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Raw facts
// ---------------------------------------------------------------------------

function countWorkers(
  world: WorldState,
  colony: ColonyRecord,
  pred: (id: number) => boolean,
): number {
  let n = 0;
  for (const id of colony.workers) {
    if (world.ants.alive[id] !== 1) continue;
    if (pred(id)) n += 1;
  }
  return n;
}

export function livingWorkers(world: WorldState, colonyId: ColonyId): number {
  const colony = world.colonies[colonyId];
  if (!colony) return 0;
  return countWorkers(world, colony, () => true);
}

export function fightersOnSurface(world: WorldState, colonyId: ColonyId): number {
  const colony = world.colonies[colonyId];
  if (!colony) return 0;
  const a = world.ants;
  return countWorkers(
    world,
    colony,
    (id) => a.task[id] === AntTask.Fighting && a.zone[id] === Zone.Surface,
  );
}

export function foodCapacity(colony: ColonyRecord): number {
  let cap = BASE_FOOD_STORAGE_CAPACITY;
  for (const ch of colony.chambers) {
    if (ch.chamberType === ChamberType.FoodStorage) cap += FOOD_CHAMBER_CAPACITY;
  }
  return cap;
}

/**
 * Snapshot every number the encoder needs. `world.events` is the telemetry ring
 * (transient, capped) — we read the tail of it for the recent-kill window rather
 * than keeping our own tally, so a resumed save simply starts from "nothing
 * recent" instead of replaying history.
 */
export function computeFacts(
  world: WorldState,
  seats: Seats,
  currentPosture: PostureKey,
): RawFacts | null {
  const me = world.colonies[seats.mySeat];
  const opp = world.colonies[seats.opponentSeat];
  if (!me || !opp) return null;
  const a = world.ants;
  const home = homeTile(me);
  const oppHome = homeTile(opp);

  const oppFightersNear =
    home === null
      ? 0
      : countWorkers(
          world,
          opp,
          (id) =>
            a.task[id] === AntTask.Fighting &&
            a.zone[id] === Zone.Surface &&
            manhattan(a.posX[id]! >> FP_SHIFT, a.posY[id]! >> FP_SHIFT, home.x, home.y) <=
              NEAR_ENTRANCE_TILES,
        );

  let ownLosses = 0;
  let oppLosses = 0;
  let ownKills = 0;
  const sinceTick = world.tick - RECENT_WINDOW_TICKS;
  for (const ev of world.events) {
    if (ev.tick < sinceTick) continue;
    if (ev.type !== 'combat_kill') continue;
    if (ev.payload.victim.colonyId === seats.mySeat) ownLosses += 1;
    if (ev.payload.victim.colonyId === seats.opponentSeat) oppLosses += 1;
    if (ev.payload.killer.colonyId === seats.mySeat) ownKills += 1;
  }

  const piles: PileFact[] = [];
  for (const p of world.foodPiles) {
    const dOwn = home === null ? Infinity : manhattan(p.tileX, p.tileY, home.x, home.y);
    const dOpp = oppHome === null ? Infinity : manhattan(p.tileX, p.tileY, oppHome.x, oppHome.y);
    piles.push({
      id: p.foodPileId,
      tile: { x: p.tileX, y: p.tileY },
      remaining: p.pickupsRemaining,
      initial: p.pickupsInitial,
      distOwn: dOwn,
      distOpp: dOpp,
      contested: dOpp <= dOwn && dOwn <= CONTEST_MAX_DIST,
    });
  }
  piles.sort((x, y) => x.distOwn - y.distOwn || x.id - y.id);

  let spider: RawFacts['spider'] = null;
  if (world.spider !== null) {
    const sx = world.spider.posX >> FP_SHIFT;
    const sy = world.spider.posY >> FP_SHIFT;
    spider = {
      state: world.spider.state,
      distOwn: home === null ? Infinity : manhattan(sx, sy, home.x, home.y),
      distOpp: oppHome === null ? Infinity : manhattan(sx, sy, oppHome.x, oppHome.y),
      targetingUs: world.spider.rampageTargetColonyId === seats.mySeat,
    };
  }

  return {
    tick: world.tick,
    ownWorkers: countWorkers(world, me, () => true),
    oppWorkers: countWorkers(world, opp, () => true),
    ownBrood: me.eggCount + me.larvaeCount,
    ownFightersSurface: fightersOnSurface(world, seats.mySeat),
    ownForagersOut: countWorkers(
      world,
      me,
      (id) => a.task[id] === AntTask.Foraging && a.zone[id] === Zone.Surface,
    ),
    oppFightersSurface: fightersOnSurface(world, seats.opponentSeat),
    oppFightersNearOurEntrance: oppFightersNear,
    foodTotal: colonyFoodTotal(me),
    foodCapacity: foodCapacity(me),
    storageChambers: me.chambers.filter((c) => c.chamberType === ChamberType.FoodStorage).length,
    ownEntrancesOpen: me.entrances.filter((e) => e.isOpen).length,
    oppEntrancesOpen: opp.entrances.filter((e) => e.isOpen).length,
    spider,
    piles,
    ownLossesRecent: ownLosses,
    oppLossesRecent: oppLosses,
    ownKillsRecent: ownKills,
    currentRatio: { ...me.targetRatio },
    currentPosture,
  };
}

// ---------------------------------------------------------------------------
// Candidate set
// ---------------------------------------------------------------------------

const PILE_KEYS: readonly ('pile_a' | 'pile_b' | 'pile_c')[] = ['pile_a', 'pile_b', 'pile_c'];
const CONTEST_KEYS: readonly ('contest_pile_a' | 'contest_pile_b' | 'contest_pile_c')[] = [
  'contest_pile_a',
  'contest_pile_b',
  'contest_pile_c',
];

export function buildCandidates(world: WorldState, seats: Seats, facts: RawFacts): CandidateSet {
  const me = world.colonies[seats.mySeat];
  const opp = world.colonies[seats.opponentSeat];
  const home = me === undefined ? null : homeTile(me);
  const comp = undergroundComponent(world, seats.mySeat);

  const posture: Partial<Record<PostureKey, PostureCandidate>> = {
    recall: {
      tile: null,
      describe: 'clear the rally point so every fighter returns home and idles inside the nest',
    },
  };
  if (home !== null && isSurfaceTileInComponent(world, home.x, home.y)) {
    posture.guard_home = {
      tile: home,
      describe: 'hold fighters on our own entrance so they defend the nest and descend if attacked',
    };
    const target = opp === undefined ? null : nearestOpenOpponentEntrance(opp, home);
    if (target !== null) {
      const t = { x: target.surfaceTileX, y: target.surfaceTileY };
      if (isSurfaceTileInComponent(world, t.x, t.y)) {
        posture.assault = {
          tile: t,
          describe:
            "rally every fighter on the opponent's nearest open entrance so they descend and fight inside the opponent nest",
        };
      }
      const mid = nearestComponentTile(
        world,
        Math.round((home.x + t.x) / 2),
        Math.round((home.y + t.y) / 2),
        MIDFIELD_SEARCH_RADIUS,
      );
      if (mid !== null) {
        posture.hold_midfield = {
          tile: mid,
          describe: 'hold fighters on the surface midway between the two nests',
        };
      }
    } else {
      const anyOpp = opp?.entrances[0];
      if (anyOpp !== undefined) {
        const mid = nearestComponentTile(
          world,
          Math.round((home.x + anyOpp.surfaceTileX) / 2),
          Math.round((home.y + anyOpp.surfaceTileY) / 2),
          MIDFIELD_SEARCH_RADIUS,
        );
        if (mid !== null) {
          posture.hold_midfield = {
            tile: mid,
            describe: 'hold fighters on the surface midway between the two nests',
          };
        }
      }
    }
  }
  // Contested piles: nearest three the opponent is at least as close to.
  const contested = facts.piles.filter((p) => p.contested).slice(0, 3);
  contested.forEach((p, i) => {
    const key = CONTEST_KEYS[i]!;
    const pileKey = PILE_KEYS[facts.piles.indexOf(p)] ?? null;
    if (isSurfaceTileInComponent(world, p.tile.x, p.tile.y)) {
      posture[key] = {
        tile: p.tile,
        describe: `send fighters to guard the contested food pile ${pileKey ?? 'listed under food_piles'}`,
      };
    }
  });

  const dig = {} as Record<DigDirection, DigCandidate>;
  for (const d of DIG_DIRECTIONS) {
    dig[d] = {
      describe: DIG_DESCRIBE[d],
      available: d === 'hold' ? true : digFrontier(world, seats.mySeat, d, comp).length > 0,
    };
  }

  const foodPriority: Partial<Record<FoodPriorityKey, FoodPriorityCandidate>> = {
    none: { pileId: null, tile: null, describe: 'no priority pile; foragers choose freely' },
  };
  facts.piles.slice(0, 3).forEach((p, i) => {
    const key = PILE_KEYS[i]!;
    foodPriority[key] = {
      pileId: p.id,
      tile: p.tile,
      describe: `prioritize ${key} (see food_piles)`,
    };
  });

  const spiderPriority =
    facts.spider !== null && facts.spider.distOwn <= SPIDER_NEAR_TILES
      ? { describe: 'mark the spider as the priority target so our fighters engage it' }
      : null;

  let expandStorage: CandidateSet['expandStorage'] = null;
  if (facts.foodTotal * 100 >= facts.foodCapacity * EXPAND_STORAGE_FRACTION_PCT) {
    const spot = findReachableChamberSpot(world, seats.mySeat, ChamberType.FoodStorage, comp);
    if (spot !== null) {
      expandStorage = { anchor: spot, describe: 'place one more food storage chamber in the nest' };
    }
  }

  return {
    ratio: RATIO_CANDIDATES,
    posture,
    dig,
    foodPriority,
    spiderPriority,
    expandStorage,
    facts,
  };
}
