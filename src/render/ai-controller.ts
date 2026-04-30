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
import { UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { colonyFoodTotal } from '../sim/colony/colony-system.js';

export const AI_DIG_INTERVAL = 40 as const;       // every 2 seconds @ 20Hz
export const AI_DIG_MARK_BUDGET = 5 as const;
export const AI_QUEEN_CHAMBER_DEPTH = 18 as const;
export const AI_FOOD_STORAGE_THRESHOLD = 8 as const;
export const AI_NURSERY_THRESHOLD = 12 as const;

/**
 * Issue #33 — chamber placement depth tolerance (tiles). The findOpenChamberSpot
 * depth gate refuses to issue a placement until at least one candidate is
 * within ±TOLERANCE rows of preferredDepth. Without this gate the AI happily
 * anchored shallow chambers at the entrance shaft floor on tick 0, locking
 * in a near-surface layout before the bootstrap dig could reach the
 * intended depth band.
 *
 * Tuning rationale: 4 tiles is wide enough that bootstrap can hit the gate
 * within reasonable tick budget at the v2 scenario's underground grid
 * dimensions, while still putting the Queen near AI_QUEEN_CHAMBER_DEPTH
 * (footprint extends 3 rows below the anchor, so a Queen at delta=4
 * lands its bottom row at preferredDepth + 1 — well within the
 * acceptance criterion of "max chamber Y > 15").
 */
export const AI_PLACEMENT_DEPTH_TOLERANCE = 4 as const;

/**
 * Issue #33 — outward-extension dig budget (tiles per AI_DIG_INTERVAL).
 * Once the colony has more than one chamber, the dig heuristic reserves a
 * portion of AI_DIG_MARK_BUDGET for "frontier extension" tiles — perimeter
 * tiles whose 4-neighborhood touches at most ONE chamber footprint. This
 * keeps the dirt-clearing pattern from collapsing into a tight cluster
 * around the colony centroid (which is what the F9 snapshot showed).
 *
 * 3 of 5 budget tiles per cycle go to outward extension; the remaining 2
 * stay on the legacy full-perimeter pass (so chambers along internal
 * borders still get reliably connected to their neighbors).
 */
export const AI_DIG_OUTWARD_BUDGET = 3 as const;

/**
 * Phase 10 / D-05 — fixed AI BehaviorRatio (CMBT-02, two-role schema).
 *
 * Two roles only: forage and fight. Digging is auto-assigned per CTRL-06
 * (handled in tick.ts step 10a; mirrors auto-nurse / CLNY-09). The AI keeps
 * issuing MarkDigTileCommand at AI_DIG_INTERVAL cadence; those Marked tiles
 * drive the auto-dig path uniformly for both colonies (CLNY-08 colony parity).
 *
 * Tuning rationale (Candidate A — Plan 10-04 SUMMARY):
 *   Original ratio was {forage:5, dig:3, fight:2} — 5:2 ≈ 2.5:1 forage:fight
 *   emphasis. With dig auto-assigned (off the ratio entirely), Candidate A
 *   {forage:7, fight:3} preserves that emphasis (7:3 ≈ 2.33:1) on the 0-10
 *   integer scale. Minimal-surprise game-feel relative to the pre-Phase-10
 *   baseline; alternative candidates {6,4} more aggressive and {8,2} more
 *   passive were considered and rejected — see Plan 10-04 SUMMARY for the
 *   full candidate matrix.
 */
export const AI_BEHAVIOR_RATIO = { forage: 7, fight: 3 } as const;

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

  // Issue #33 — bootstrap-while-no-Queen. Pre-fix the bootstrap was gated
  // on `chambers.length === 0`, which meant the first chamber to LAND
  // (typically a shallow FoodStorage when the food gate fires before the
  // Queen depth gate would accept) terminated bootstrap permanently. The
  // Queen ended up unable to find a deep enough anchor and the colony was
  // stuck at a single near-surface chamber.
  //
  // The replacement gate keys off COMPLETED Queen chamber existence, not
  // pending (codex P1 follow-up). Gating on pending too would deadlock if
  // the Queen anchor sits behind unreachable Solid tiles: bootstrap halts
  // on the pending → no further dig marks are issued → workers can't
  // reach the anchor → Queen never completes. Continuing bootstrap while
  // the Queen is merely pending costs at most a few extra dig marks
  // around the deepest Open tile (the Queen anchor's vicinity, the same
  // tiles bootstrap was already targeting), and guarantees workers can
  // always reach the anchor by punching dirt as needed.
  const queenCompleted = colony.chambers.some((c) => c.chamberType === ChamberType.Queen);

  // Bootstrap branch — no Queen yet. Dig downward from the deepest Open tile.
  if (!queenCompleted) {
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

  // Issue #33 — frontier-extension pass. Before the legacy full-perimeter
  // pass, spend up to AI_DIG_OUTWARD_BUDGET tiles on perimeter tiles whose
  // 4-neighborhood touches AT MOST one chamber footprint — i.e. tiles
  // pointing AWAY from any cluster, not wedged BETWEEN chambers. Without
  // this the legacy heuristic re-marks tiles between chambers every cycle
  // and never punches outward, so the colony footprint collapses into a
  // tight blob next to the entrance shaft (the F9 snapshot in issue #33).
  //
  // Gated on `chambers.length > 1`: with a single chamber every perimeter
  // tile is "outward" already and the legacy pass extends uniformly.
  // Total mark budget is unchanged (AI_DIG_MARK_BUDGET); the frontier pass
  // just gets first dibs on AI_DIG_OUTWARD_BUDGET of those marks.
  if (colony.chambers.length > 1) {
    const frontier = collectFrontierTiles(world, colony, chambersSorted);
    const limit = Math.min(AI_DIG_OUTWARD_BUDGET, budget);
    for (let i = 0; i < frontier.length && budget > AI_DIG_MARK_BUDGET - limit; i++) {
      const cand = frontier[i]!;
      world.commandQueue.push({
        type: 'MarkDigTile',
        colonyId: colony.colonyId,
        tileX: cand.tileX,
        tileY: cand.tileY,
        issuedAtTick: world.tick,
      });
      budget -= 1;
    }
  }

  // Steady-state: dig the full perimeter of every chamber (legacy pass).
  // Each tile outside the footprint but 4-adjacent to some interior tile
  // is a candidate. (Earlier-history note: the original implementation
  // only marked the 4 cardinal neighbors of the anchor's top-left corner,
  // which for a 5×3 Queen chamber exposed only one diggable tile once the
  // interior was excavated — effectively stalling the AI after two
  // chambers landed. Per plan 09.1-01 Task 2 the loop now walks the full
  // border.)
  for (const ch of chambersSorted) {
    if (budget <= 0) break;
    const chTileX = ch.posX >> FP_SHIFT;
    const chTileY = ch.posY >> FP_SHIFT;
    // Top border
    for (let ox = 0; ox < ch.width && budget > 0; ox++) {
      const tx = chTileX + ox;
      const ty = chTileY - 1;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
    // Bottom border
    for (let ox = 0; ox < ch.width && budget > 0; ox++) {
      const tx = chTileX + ox;
      const ty = chTileY + ch.height;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
    // Left border
    for (let oy = 0; oy < ch.height && budget > 0; oy++) {
      const tx = chTileX - 1;
      const ty = chTileY + oy;
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) continue;
      world.commandQueue.push({ type: 'MarkDigTile', colonyId: colony.colonyId, tileX: tx, tileY: ty, issuedAtTick: world.tick });
      budget -= 1;
    }
    // Right border
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
  // Queen chamber — if missing, try to place near AI_QUEEN_CHAMBER_DEPTH.
  // Includes pending Queen so we don't spam duplicate PlaceChamber commands
  // into the queue between PlaceChamber issuance and Queen completion (the
  // sim layer would reject them, but no point queuing them in the first
  // place). Matches the FS / Nursery uniqueness pattern.
  if (!hasChamberOrPending(world, colony, ChamberType.Queen)) {
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
  //
  // Issue #33 — also gate on Queen-completed-or-pending. Pre-fix the FS
  // gate fired on tick 0 (starting foodStored=1280 ≫ threshold=8) and the
  // FS chamber landed at the entrance shaft floor (Y≈1). That single
  // shallow chamber preempted the bootstrap dig (which only ran while
  // chambers.length === 0) and the Queen never found a deep enough
  // anchor. The Queen-first ordering mirrors a human player's natural
  // build sequence and lets the bootstrap finish digging the entrance
  // shaft before the FS lands on it.
  // FS uniqueness check: a duplicate-issuance window opens once Queen-pending
  // exists (the FS gate above is now satisfied) and persists until the
  // first FS PendingChamber transitions to a ChamberRecord. tick.ts dedupes
  // by exact (anchorTileX, anchorTileY) so a second FS at the SAME spot is
  // rejected, but if the BFS picks a DIFFERENT valid anchor on a later
  // tick (e.g. when more Open tiles arrive and shift the spread-score
  // winner) a second FS PendingChamber would slip through. The previous
  // gate `!colony.chambers.some(...)` checked only completed chambers, so
  // this widened-window race already existed; widening hasChamberOrPending
  // here closes it. Net behavior: the AI places exactly one FoodStorage
  // chamber per colony — same as before this PR; the sim layer would
  // accept additional FS but the AI does not issue them.
  if (
    hasChamberOrPending(world, colony, ChamberType.Queen)
    && colonyFoodTotal(colony) >= AI_FOOD_STORAGE_THRESHOLD
    && !hasChamberOrPending(world, colony, ChamberType.FoodStorage)
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
    // PENDING Nursery counts as "has Nursery" so duplicate PlaceChamber
    // commands don't pile up while excavation is in-flight. Nursery is
    // intentionally unique per colony (09-BACKLOG memo item 2: one Queen,
    // one Nursery, multiple FoodStorage).
    const hasNursery = hasChamberOrPending(world, colony, ChamberType.Nursery);
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
 * True when the colony has a chamber of `chamberType`, or a PendingChamber
 * of that type. Used to gate AI placement decisions that need to wait for
 * a specific chamber to be in flight (e.g. issue #33 — FoodStorage waits
 * for Queen so the bootstrap dig can finish reaching the deeper Queen
 * preferredDepth before a shallow FS lands and stalls the dig).
 */
function hasChamberOrPending(
  world: WorldState,
  colony: ColonyRecord,
  chamberType: ChamberType,
): boolean {
  if (colony.chambers.some((c) => c.chamberType === chamberType)) return true;
  for (const pcKey in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, pcKey)) continue;
    const pc = world.pendingChambers[pcKey]!;
    if (pc.colonyId === colony.colonyId && pc.chamberType === chamberType) return true;
  }
  return false;
}

/**
 * Issue #33 — collect "frontier" perimeter tiles ordered for outward dig
 * extension.
 *
 * A frontier tile is a Solid (diggable) tile that:
 *   1. is 4-adjacent to exactly ONE chamber's footprint, AND
 *   2. lies on the outward side of that chamber relative to the colony
 *      centroid (so we extend AWAY from the cluster, not back into it).
 *
 * Ordering is deterministic: outermost chambers first (max Manhattan
 * distance from centroid), then by (tileY, tileX) ascending. The
 * deterministic ordering preserves SCEN-06 byte-identical replay; no PRNG
 * is involved.
 *
 * @returns frontier tile coordinates in dig-priority order (highest
 *          priority first).
 */
function collectFrontierTiles(
  world: WorldState,
  colony: ColonyRecord,
  chambersSorted: ColonyRecord['chambers'],
): Array<{ tileX: number; tileY: number }> {
  const grid = world.undergroundGrids[colony.colonyId];
  if (grid === undefined || chambersSorted.length === 0) return [];

  // Centroid of the chamber cluster — used to score "outward" direction.
  let cx = 0;
  let cy = 0;
  for (const ch of chambersSorted) {
    cx += (ch.posX >> FP_SHIFT) + (ch.width  >> 1);
    cy += (ch.posY >> FP_SHIFT) + (ch.height >> 1);
  }
  cx = (cx / chambersSorted.length) | 0;
  cy = (cy / chambersSorted.length) | 0;

  // "Footprint membership" lookup: tile-key set keyed by ty * width + tx.
  const footprint = new Set<number>();
  for (const ch of chambersSorted) {
    const ax = ch.posX >> FP_SHIFT;
    const ay = ch.posY >> FP_SHIFT;
    for (let oy = 0; oy < ch.height; oy++) {
      for (let ox = 0; ox < ch.width; ox++) {
        footprint.add((ay + oy) * grid.width + (ax + ox));
      }
    }
  }
  // Bounds-checked footprint membership. Without the bounds check (codex
  // P2 review), a candidate at the grid's right edge (tx === width-1)
  // probing `isFootprint(tx + 1, ty)` would produce the key
  // `ty*width + width === (ty+1)*width + 0`, which collides with
  // `(0, ty+1)` — i.e. a chamber footprint hugging the LEFT edge one row
  // below would falsely "block" right-edge frontier tiles. Same hazard
  // applies to (-1, ty) wrapping into (width-1, ty-1). The bounds guard
  // matches `canEnterUndergroundTile`'s out-of-bounds rejection (treats
  // off-grid cells as never inside any footprint).
  const isFootprint = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
    return footprint.has(ty * grid.width + tx);
  };

  const candidates: Array<{
    tileX: number;
    tileY: number;
    chamberDistFromCentroid: number;
    outwardScore: number;
  }> = [];

  // For each chamber, walk its 4-border and emit any Solid tile whose
  // 4-neighborhood touches no OTHER chamber's footprint. Outward score is
  // |tx-cx| + |ty-cy| (higher = farther from centroid, meaning the tile
  // points OUT of the cluster).
  for (const ch of chambersSorted) {
    const chTileX = ch.posX >> FP_SHIFT;
    const chTileY = ch.posY >> FP_SHIFT;
    const chCenterX = chTileX + (ch.width  >> 1);
    const chCenterY = chTileY + (ch.height >> 1);
    const chDist = Math.abs(chCenterX - cx) + Math.abs(chCenterY - cy);

    const consider = (tx: number, ty: number): void => {
      if (!isDirtTileUnderground(world, colony.colonyId, tx, ty)) return;
      // Reject tiles 4-adjacent to ANOTHER chamber's footprint (those are
      // "between" tiles; the legacy pass picks them up later if budget
      // remains).
      if (isFootprint(tx - 1, ty) && !(tx - 1 >= chTileX && tx - 1 < chTileX + ch.width  && ty >= chTileY && ty < chTileY + ch.height)) return;
      if (isFootprint(tx + 1, ty) && !(tx + 1 >= chTileX && tx + 1 < chTileX + ch.width  && ty >= chTileY && ty < chTileY + ch.height)) return;
      if (isFootprint(tx, ty - 1) && !(tx >= chTileX && tx < chTileX + ch.width  && ty - 1 >= chTileY && ty - 1 < chTileY + ch.height)) return;
      if (isFootprint(tx, ty + 1) && !(tx >= chTileX && tx < chTileX + ch.width  && ty + 1 >= chTileY && ty + 1 < chTileY + ch.height)) return;
      const outward = Math.abs(tx - cx) + Math.abs(ty - cy);
      candidates.push({ tileX: tx, tileY: ty, chamberDistFromCentroid: chDist, outwardScore: outward });
    };

    // Walk the four borders.
    for (let ox = 0; ox < ch.width; ox++) {
      consider(chTileX + ox, chTileY - 1);
      consider(chTileX + ox, chTileY + ch.height);
    }
    for (let oy = 0; oy < ch.height; oy++) {
      consider(chTileX - 1,           chTileY + oy);
      consider(chTileX + ch.width,    chTileY + oy);
    }
  }

  // De-dupe (a tile can appear once per neighboring chamber).
  const seen = new Set<number>();
  const unique = candidates.filter((c) => {
    const k = c.tileY * grid.width + c.tileX;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => {
    // 1. Outermost chamber first (its frontier has the most empty space
    //    on the other side to colonize).
    if (a.chamberDistFromCentroid !== b.chamberDistFromCentroid) {
      return b.chamberDistFromCentroid - a.chamberDistFromCentroid;
    }
    // 2. Highest outward score next (tile farthest from centroid).
    if (a.outwardScore !== b.outwardScore) return b.outwardScore - a.outwardScore;
    // 3. Deterministic tiebreak (tileY, tileX) ascending.
    if (a.tileY !== b.tileY) return a.tileY - b.tileY;
    return a.tileX - b.tileX;
  });
  return unique.map((c) => ({ tileX: c.tileX, tileY: c.tileY }));
}

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
  // Issue #30: the AI must never propose marks in the ceiling row. The
  // sim-layer MarkDigTile gate would reject them anyway, but having the AI
  // pre-filter avoids spamming AI_DIG_MARK_BUDGET on dead-on-arrival
  // commands every AI_DIG_INTERVAL ticks. The screenshot from PR #32 UAT
  // showed enemy chambers built straddling the grass strip because every
  // chamber at chTileY=1 (the typical near-surface case) had its top-
  // border perimeter loop hit ty=0 and excavate the ceiling.
  if (ty === UNDERGROUND_CEILING_ROW_Y) return false;
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

  // Issue #33 — depth gate, QUEEN PLACEMENT ONLY. Refuse to place the Queen
  // until at least one candidate is within AI_PLACEMENT_DEPTH_TOLERANCE
  // rows of preferredDepth. Without this gate the AI happily anchors the
  // Queen at the entrance shaft floor (Y≈1) on tick 0 because the
  // bootstrap dig hasn't yet excavated anything deeper. The chamber then
  // becomes a dig anchor that prevents the bootstrap path from running
  // again, so the colony never gets deeper than the first chamber's Y.
  // With this gate the AI defers Queen placement until the bootstrap has
  // dug deep enough; the chamber lands in the intended depth band and
  // steady-state perimeter dig extends from there.
  //
  // Codex P2 follow-up: restrict the gate to Queen. FoodStorage and
  // Nursery use shallower preferredDepth (5 / 7) and don't suffer from
  // the early-shallow-anchor problem (Queen-first ordering already
  // ensures the deep dig happens before they're considered). Applying
  // the gate to FS/Nursery introduces a hard-fail mode: if valid anchors
  // exist only outside ±tolerance (e.g. the dig has gone deeper than
  // preferredDepth before the gate fires), the chamber would be silently
  // never placed and the colony would stall.
  if (chamberType === ChamberType.Queen) {
    let bestDepthDelta = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const d = Math.abs(c.tileY - preferredDepth);
      if (d < bestDepthDelta) bestDepthDelta = d;
    }
    if (bestDepthDelta > AI_PLACEMENT_DEPTH_TOLERANCE) return null;
  }

  // Issue #33 — spatial-diversity scoring. The original sort picked the
  // first reachable anchor at the right depth and broke ties on
  // (tileY, tileX) ascending; with a centred queen and a uniform dig
  // pattern, every chamber landed adjacent to the previous one. The enemy
  // colony ended up wedged into ~12 tiles right next to its entrance
  // shaft (the F9 snapshot in issue #33).
  //
  // Three-key sort:
  //   1. Depth match — minimize |tileY - preferredDepth| strictly. For
  //      Queen, the depth gate above already guaranteed the best candidate
  //      is within AI_PLACEMENT_DEPTH_TOLERANCE rows of preferredDepth.
  //      For FS / Nursery, the gate is bypassed (codex P2): the sort still
  //      picks the closest available row, but there's no upper bound — if
  //      the dug area only contains rows far from preferredDepth, the
  //      chamber lands at the closest reachable Y.
  //   2. Spread score — among same-depth candidates, prefer anchors with
  //      the LARGEST Manhattan distance to the nearest existing chamber.
  //      Wins horizontal spread when the dug area has expanded laterally.
  //      With zero existing chambers (Queen placement), every candidate
  //      ties at spread = 0; falls through to (3).
  //   3. Deterministic tiebreak: (tileY, tileX) ascending. No PRNG —
  //      same seed → same layout per the issue's acceptance criteria.
  //
  // Determinism: all three keys are pure integer arithmetic over inputs
  // already deterministic by construction. SCEN-06 byte-identical replay
  // is preserved.
  const minChamberDist = (ax: number, ay: number): number => {
    if (colony.chambers.length === 0) return 0;
    let best = Number.POSITIVE_INFINITY;
    for (const ch of colony.chambers) {
      const cx = ch.posX >> FP_SHIFT;
      const cy = ch.posY >> FP_SHIFT;
      const d = Math.abs(ax - cx) + Math.abs(ay - cy);
      if (d < best) best = d;
    }
    return best === Number.POSITIVE_INFINITY ? 0 : best;
  };
  candidates.sort((a, b) => {
    const da = Math.abs(a.tileY - preferredDepth);
    const db = Math.abs(b.tileY - preferredDepth);
    if (da !== db) return da - db;
    const sa = minChamberDist(a.tileX, a.tileY);
    const sb = minChamberDist(b.tileX, b.tileY);
    if (sa !== sb) return sb - sa; // farther from existing chambers wins.
    if (a.tileY !== b.tileY) return a.tileY - b.tileY;
    return a.tileX - b.tileX;
  });
  return candidates[0]!;
}
