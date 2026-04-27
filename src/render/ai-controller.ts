// src/render/ai-controller.ts
// Phase 9 / CMBT-01, CMBT-02, CMBT-03, CLNY-08 — rule-based AI controller.
// Location rationale: AI is a UI/render-layer decision-maker, not sim logic.
// The simulation has ONE code path for all colonies; AI differentiates at the CALLER
// (GameScene's onBeforeTick calls runAIController only for non-player colonyIds).

import type { WorldState } from '../sim/types.js';
import type { ColonyId, ColonyRecord } from '../sim/colony/colony-store.js';
import type {
  MarkDigTileCommand,
  PlaceChamberCommand,
  DesignateEntranceCommand,
  SetBehaviorRatioCommand,
} from '../sim/commands.js';
import { ChamberType } from '../sim/enums.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import { colonyFoodTotal } from '../sim/colony/colony-system.js';

export const AI_DIG_INTERVAL = 40 as const;       // every 2 seconds @ 20Hz
export const AI_DIG_MARK_BUDGET = 5 as const;
export const AI_QUEEN_CHAMBER_DEPTH = 10 as const;
export const AI_FOOD_STORAGE_THRESHOLD = 8 as const;
export const AI_NURSERY_THRESHOLD = 12 as const;

/**
 * Fixed AI behavior ratio per RESEARCH.md (0–10 scale).
 * AI is forage-leaning with meaningful dig + fight allocation.
 */
export const AI_BEHAVIOR_RATIO = { forage: 5, dig: 3, fight: 2 } as const;

/** Entry point — called by GameScene per-tick (via GameLoopOpts.onBeforeTick). */
export function runAIController(world: WorldState, aiColonyId: ColonyId): void {
  const colony = world.colonies[aiColonyId];
  if (colony === undefined || colony.defeated) return;

  aiInitialSetup(world, colony);
  aiDigHeuristic(world, colony);
  aiChamberPlacement(world, colony);
  aiEntranceDesignation(world, colony);
}

/**
 * CMBT-02: one-shot initialization on tick 0.
 * - Pushes SetBehaviorRatio with the fixed AI ratio.
 * - Pushes DesignateEntrance at the queen's surface tile (derived from queen position).
 */
export function aiInitialSetup(world: WorldState, colony: ColonyRecord): void {
  if (world.tick !== 0) return;

  // 1. Set fixed behavior ratio for AI (CMBT-02).
  const setRatioCmd: SetBehaviorRatioCommand = {
    type: 'SetBehaviorRatio',
    colonyId: colony.colonyId,
    ratio: { ...AI_BEHAVIOR_RATIO },
    issuedAtTick: world.tick,
  };
  world.commandQueue.push(setRatioCmd);

  // 2. Designate entrance at queen's surface tile.
  const queenTileX = world.ants.posX[colony.queenEntityId]! >> FP_SHIFT;
  // Queen Y is underground; the entrance is on the surface row directly above her column.
  const designateCmd: DesignateEntranceCommand = {
    type: 'DesignateEntrance',
    colonyId: colony.colonyId,
    surfaceTileX: queenTileX,
    surfaceTileY: 0,   // surface row
    issuedAtTick: world.tick,
  };
  world.commandQueue.push(designateCmd);
}

export function aiDigHeuristic(world: WorldState, colony: ColonyRecord): void {
  if (world.tick % AI_DIG_INTERVAL !== 0) return;
  // Find up to AI_DIG_MARK_BUDGET diggable Solid tiles.
  // Strategy:
  //   - Bootstrap branch: if colony has zero chambers, seed dig marks adjacent to the
  //     DEEPEST currently-Open tile in the colony's underground grid (the bottom of
  //     the entrance shaft at scenario start). Without this, aiChamberPlacement's
  //     findOpenChamberSpot BFS never finds an Open tile near the queen (scenario
  //     pre-excavates only y=0..1; queen spawns at y=64; BFS radius=32 is a 54-tile
  //     short of the shaft), the Queen PlaceChamber gate never fires, and the AI
  //     deadlocks forever. Documented in 09.1-MEMO.md §5; added per plan 09.1-01
  //     Task 2 pre-audit (commit dee93e5). Digging downward from the shaft floor
  //     progressively opens tiles until BFS-from-queen can find a candidate spot.
  //   - Steady-state: iterate colony.chambers to get seed positions (convert posX/posY
  //     from fixed-point to tiles). For each chamber, check its 4 cardinal neighbors;
  //     if tile is Solid (diggable), issue MarkDigTile. Stop after AI_DIG_MARK_BUDGET.
  //   - Deterministic ordering: iterate chambers by ascending (tileY, tileX); iterate
  //     neighbors N,E,S,W.
  let budget = AI_DIG_MARK_BUDGET;

  // Bootstrap branch — no chambers yet. Dig downward from the deepest Open tile.
  if (colony.chambers.length === 0) {
    const grid = world.undergroundGrids[colony.colonyId];
    if (grid !== undefined) {
      // Scan for the deepest Open tile (highest tileY). Deterministic tiebreak:
      // lowest tileX at that row. Bounded small scan (64 × 128 visited tiles at
      // AI_DIG_INTERVAL=40 cadence amortises to 1.6 visits/tick worst case).
      let deepestY = -1;
      let deepestX = -1;
      for (let ty = grid.height - 1; ty >= 0 && deepestY === -1; ty--) {
        for (let tx = 0; tx < grid.width; tx++) {
          if (ugGet(grid, tx, ty) === UndergroundTileState.Open) {
            if (ty > deepestY || (ty === deepestY && tx < deepestX)) {
              deepestY = ty;
              deepestX = tx;
            }
          }
        }
        if (deepestY !== -1) break;  // first row with any Open = deepest
      }
      if (deepestY !== -1) {
        // Mark diggable neighbors of the deepest Open tile: prefer deeper (S) first,
        // then sideways (E/W), then up (N). Deterministic ordering.
        for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
          if (budget <= 0) break;
          const tx = deepestX + dx;
          const ty = deepestY + dy;
          if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
          const cmd: MarkDigTileCommand = {
            type: 'MarkDigTile',
            colonyId: colony.colonyId,
            tileX: tx,
            tileY: ty,
            issuedAtTick: world.tick,
          };
          world.commandQueue.push(cmd);
          budget -= 1;
        }
      }
    }
    return;
  }

  const chambersSorted = [...colony.chambers].sort((a, b) => {
    const ay = a.posY >> FP_SHIFT;
    const by = b.posY >> FP_SHIFT;
    if (ay !== by) return ay - by;
    return (a.posX >> FP_SHIFT) - (b.posX >> FP_SHIFT);
  });
  // Steady-state: dig the full perimeter of every chamber. The original
  // implementation only marked the 4 cardinal neighbors of the anchor tile
  // (top-left corner), which for a 5×3 Queen chamber exposed only one
  // diggable tile (the cell directly left of the anchor) once the chamber
  // interior was excavated — effectively stalling the AI after the first
  // two chambers landed. Documented per plan 09.1-01 Task 2. Iterate the
  // full border: each tile outside the footprint but 4-adjacent to some
  // interior tile is a candidate.
  for (const ch of chambersSorted) {
    if (budget <= 0) break;
    const chTileX = ch.posX >> FP_SHIFT;
    const chTileY = ch.posY >> FP_SHIFT;
    // Top border: y = chTileY - 1, x = chTileX..chTileX+ch.width-1
    for (let ox = 0; ox < ch.width && budget > 0; ox++) {
      const tx = chTileX + ox;
      const ty = chTileY - 1;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
    // Bottom border: y = chTileY + ch.height, x = chTileX..chTileX+ch.width-1
    for (let ox = 0; ox < ch.width && budget > 0; ox++) {
      const tx = chTileX + ox;
      const ty = chTileY + ch.height;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
    // Left border: x = chTileX - 1, y = chTileY..chTileY+ch.height-1
    for (let oy = 0; oy < ch.height && budget > 0; oy++) {
      const tx = chTileX - 1;
      const ty = chTileY + oy;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
    // Right border: x = chTileX + ch.width, y = chTileY..chTileY+ch.height-1
    for (let oy = 0; oy < ch.height && budget > 0; oy++) {
      const tx = chTileX + ch.width;
      const ty = chTileY + oy;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
  }
}

export function aiChamberPlacement(world: WorldState, colony: ColonyRecord): void {
  // Queen chamber — if missing, try to place near AI_QUEEN_CHAMBER_DEPTH
  if (!colony.chambers.some((c) => c.chamberType === ChamberType.Queen)) {
    const placement = findOpenChamberSpot(world, colony, AI_QUEEN_CHAMBER_DEPTH, ChamberType.Queen);
    if (placement !== null) {
      const cmd: PlaceChamberCommand = {
        type: 'PlaceChamber',
        colonyId: colony.colonyId,
        chamberType: ChamberType.Queen,
        anchorTileX: placement.tileX,
        anchorTileY: placement.tileY,
        issuedAtTick: world.tick,
      };
      world.commandQueue.push(cmd);
    }
  }
  // Food storage — if food stockpile crossed threshold and no FoodStorage yet.
  // Issue #15: read total stash (entrance pool + every chamber.foodStored), not
  // the chamberless fallback bucket — colony.foodStored alone is now only the
  // entrance pool, so the AI gate would never fire once the first chamber filled.
  if (
    colonyFoodTotal(colony) >= AI_FOOD_STORAGE_THRESHOLD
    && !colony.chambers.some((c) => c.chamberType === ChamberType.FoodStorage)
  ) {
    const placement = findOpenChamberSpot(world, colony, 5, ChamberType.FoodStorage);  // near-surface storage
    if (placement !== null) {
      const cmd: PlaceChamberCommand = {
        type: 'PlaceChamber',
        colonyId: colony.colonyId,
        chamberType: ChamberType.FoodStorage,
        anchorTileX: placement.tileX,
        anchorTileY: placement.tileY,
        issuedAtTick: world.tick,
      };
      world.commandQueue.push(cmd);
    }
  }
  // Nursery — gate rewritten per plan 09.1-01 Task 2 (Option B, bootstrap-aware):
  // the original gate `(eggCount + larvaeCount) >= AI_NURSERY_THRESHOLD (12)`
  // creates a chicken-and-egg deadlock because tickQueenEggProduction requires
  // a COMPLETED Nursery chamber to lay eggs (Gate 5 in lifecycle-system.ts) —
  // so brood can never grow without a Nursery, so the Nursery gate never fires.
  // The PRD-sketched `workerCount >= 12 AND queen chamber` has the same failure
  // mode (workers can't grow without brood, brood can't grow without Nursery).
  // Correct gate: place Nursery as soon as a Queen chamber is completed and no
  // Nursery exists yet — mirrors the bootstrap order a human player follows.
  // Documented per plan 09.1-01 Task 2 pre-audit (commit dee93e5).
  //
  // AI_NURSERY_THRESHOLD is preserved as a backstop — if the colony somehow
  // grows brood past 12 (via some future mechanic) without a Nursery, this
  // still fires. The two conditions are OR-combined.
  {
    let hasNursery = colony.chambers.some((c) => c.chamberType === ChamberType.Nursery);
    // Also treat PENDING Nursery as "has Nursery" to prevent piling up duplicate
    // PlaceChamber commands while excavation is in-flight. Nursery is intentionally
    // unique (09-BACKLOG memo item 2: one Queen, one Nursery, multiple FoodStorage).
    if (!hasNursery) {
      for (const pcKey in world.pendingChambers) {
        if (!Object.hasOwn(world.pendingChambers, pcKey)) continue;
        const pc = world.pendingChambers[pcKey]!;
        if (pc.colonyId === colony.colonyId && pc.chamberType === ChamberType.Nursery) {
          hasNursery = true;
          break;
        }
      }
    }
    const hasQueen = colony.chambers.some((c) => c.chamberType === ChamberType.Queen);
    const broodPressure = (colony.eggCount + colony.larvaeCount) >= AI_NURSERY_THRESHOLD;
    if (!hasNursery && (hasQueen || broodPressure)) {
      const placement = findOpenChamberSpot(world, colony, 7, ChamberType.Nursery);
      if (placement !== null) {
        const cmd: PlaceChamberCommand = {
          type: 'PlaceChamber',
          colonyId: colony.colonyId,
          chamberType: ChamberType.Nursery,
          anchorTileX: placement.tileX,
          anchorTileY: placement.tileY,
          issuedAtTick: world.tick,
        };
        world.commandQueue.push(cmd);
      }
    }
  }
}

export function aiEntranceDesignation(world: WorldState, colony: ColonyRecord): void {
  if (colony.entrances.length > 0) return;
  // Recovery path: if somehow the tick-0 entrance didn't stick or was destroyed,
  // find a chamber near the surface and designate the surface tile above it.
  const surfaceEdgeY = 1;
  for (const ch of colony.chambers) {
    const chTileY = ch.posY >> FP_SHIFT;
    if (chTileY <= surfaceEdgeY + 2) {
      const cmd: DesignateEntranceCommand = {
        type: 'DesignateEntrance',
        colonyId: colony.colonyId,
        surfaceTileX: ch.posX >> FP_SHIFT,
        surfaceTileY: 0,
        issuedAtTick: world.tick,
      };
      world.commandQueue.push(cmd);
      return;
    }
  }
}

// --- Helpers ---

/**
 * True when (tx, ty) is within the AI's underground grid AND the tile is Solid (diggable dirt).
 * Handles missing grid and out-of-bounds defensively.
 */
function isDirtTileUnderground(
  world: WorldState,
  colonyId: ColonyId,
  tx: number,
  ty: number,
): boolean {
  const grid = world.undergroundGrids[colonyId];
  if (grid === undefined) return false;
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
  return ugGet(grid, tx, ty) === UndergroundTileState.Solid;
}

/**
 * BFS from the queen's tile outward; returns an anchor tile where a chamber of the
 * given type can be placed without rejection by PlaceChamber's validators. Per plan
 * 09.1-01 Task 2, this function now mirrors the tick.ts PlaceChamber checks so that
 * the issued command actually lands:
 *
 *   - anchor tile is Open
 *   - full w×h footprint fits in bounds
 *   - at least one 4-connected neighbor of the anchor is Solid
 *   - no footprint tile is BeingDug
 *   - no footprint tile overlaps an existing ChamberRecord
 *   - no footprint tile overlaps a PendingChamber
 *
 * Selection: BFS radius 32 around the queen's column. Among valid anchors, pick the
 * one minimizing |anchorY - preferredDepth|; deterministic tiebreaker (anchorY,
 * anchorX) ascending. No PRNG. Returns null if no valid anchor exists.
 *
 * Pre-09.1-01-Task-2 history: this function used to return ANY Open tile not inside
 * an existing chamber's footprint, but didn't verify the new footprint actually fit.
 * For Nursery/FoodStorage that ran AFTER an earlier chamber landed in the deepest
 * dug area, the returned anchor's 4×3 footprint frequently overlapped the earlier
 * 5×3 Queen chamber — PlaceChamber silently dropped the command forever. Documented
 * in 09.1-MEMO.md §5.
 */
function findOpenChamberSpot(
  world: WorldState,
  colony: ColonyRecord,
  preferredDepth: number,
  chamberType: ChamberType,
): { tileX: number; tileY: number } | null {
  const grid = world.undergroundGrids[colony.colonyId];
  if (grid === undefined) return null;
  const dims = CHAMBER_DIMENSIONS[chamberType];
  const rawQueenTileX = world.ants.posX[colony.queenEntityId]! >> FP_SHIFT;
  const rawQueenTileY = world.ants.posY[colony.queenEntityId]! >> FP_SHIFT;
  // Queen spawns on the Surface; her posX/posY are surface tiles that are
  // meaningful only as "the column the nest lives under". The Surface grid is
  // SURFACE_GRID_HEIGHT=128 tall; the Underground grid is only
  // UNDERGROUND_GRID_HEIGHT=64 tall. When queenTileY >= grid.height (pre-descent),
  // BFS starting at that tile is out-of-bounds and never expands — `findOpenChamberSpot`
  // silently returns null and the AI deadlocks. Clamp the BFS seed to preferredDepth
  // (or the valid row closest to it) so the chamber search is anchored on the
  // depth band the AI actually wants to build at. Documented per plan 09.1-01
  // Task 2 pre-audit (commit dee93e5).
  const queenTileX = Math.min(Math.max(rawQueenTileX, 0), grid.width - 1);
  const queenTileY = rawQueenTileY >= grid.height
    ? Math.min(Math.max(preferredDepth, 0), grid.height - 1)
    : Math.min(Math.max(rawQueenTileY, 0), grid.height - 1);

  const RADIUS = 32;

  // Build "occupied" footprint map: tiles already claimed by a ChamberRecord OR
  // a PendingChamber (same-colony). Used to reject overlaps up front.
  const occupied = new Set<number>();
  for (const ch of colony.chambers) {
    const chTX = ch.posX >> FP_SHIFT;
    const chTY = ch.posY >> FP_SHIFT;
    for (let oy = 0; oy < ch.height; oy++) {
      for (let ox = 0; ox < ch.width; ox++) {
        occupied.add((chTY + oy) * grid.width + (chTX + ox));
      }
    }
  }
  for (const pcKey in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, pcKey)) continue;
    const pc = world.pendingChambers[pcKey]!;
    if (pc.colonyId !== colony.colonyId) continue;
    for (let oy = 0; oy < pc.height; oy++) {
      for (let ox = 0; ox < pc.width; ox++) {
        occupied.add((pc.anchorTileY + oy) * grid.width + (pc.anchorTileX + ox));
      }
    }
  }

  // Validate that a w×h chamber anchored at (ax, ay) would pass all PlaceChamber
  // gates. Mirrors tick.ts:248+ logic.
  const footprintValid = (ax: number, ay: number): boolean => {
    // Bounds
    if (ax < 0 || ax + dims.width > grid.width) return false;
    if (ay < 0 || ay + dims.height > grid.height) return false;
    // Anchor tile must be Open
    if (ugGet(grid, ax, ay) !== UndergroundTileState.Open) return false;
    // At least one 4-connected neighbor of anchor is Solid
    let hasAdjSolid = false;
    if (ax - 1 >= 0          && ugGet(grid, ax - 1, ay) === UndergroundTileState.Solid) hasAdjSolid = true;
    if (!hasAdjSolid && ax + 1 < grid.width  && ugGet(grid, ax + 1, ay) === UndergroundTileState.Solid) hasAdjSolid = true;
    if (!hasAdjSolid && ay - 1 >= 0          && ugGet(grid, ax,     ay - 1) === UndergroundTileState.Solid) hasAdjSolid = true;
    if (!hasAdjSolid && ay + 1 < grid.height && ugGet(grid, ax,     ay + 1) === UndergroundTileState.Solid) hasAdjSolid = true;
    if (!hasAdjSolid) return false;
    // No footprint tile may be BeingDug, and no footprint tile may overlap an
    // existing/pending chamber (precomputed `occupied` set above).
    for (let dy = 0; dy < dims.height; dy++) {
      for (let dx = 0; dx < dims.width; dx++) {
        const tx = ax + dx;
        const ty = ay + dy;
        if (ugGet(grid, tx, ty) === UndergroundTileState.BeingDug) return false;
        if (occupied.has(ty * grid.width + tx)) return false;
      }
    }
    return true;
  };

  // BFS — collect Open tiles, then filter by footprintValid. BFS traverses regardless
  // of tile state so the search reaches Open tiles through Solid dirt.
  const visited = new Set<number>();
  const queue: Array<[number, number]> = [[queenTileX, queenTileY]];
  visited.add(queenTileY * grid.width + queenTileX);
  const candidates: Array<{ tileX: number; tileY: number }> = [];

  while (queue.length > 0) {
    const [tx, ty] = queue.shift()!;
    if (Math.abs(tx - queenTileX) > RADIUS || Math.abs(ty - queenTileY) > RADIUS) continue;
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) continue;

    if (footprintValid(tx, ty)) {
      candidates.push({ tileX: tx, tileY: ty });
    }

    // Expand N,E,S,W deterministically.
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      const nkey = ny * grid.width + nx;
      if (visited.has(nkey)) continue;
      visited.add(nkey);
      queue.push([nx, ny]);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const da = Math.abs(a.tileY - preferredDepth);
    const db = Math.abs(b.tileY - preferredDepth);
    if (da !== db) return da - db;
    if (a.tileY !== b.tileY) return a.tileY - b.tileY;
    return a.tileX - b.tileX;
  });
  return candidates[0]!;
}
