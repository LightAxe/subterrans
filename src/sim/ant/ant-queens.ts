// src/sim/ant/ant-queens.ts
// #212 Layer 1 (behavior): queen relocation + alive-queen collection. Depends only
// on the Layer-0 ant-motion primitives (+ sibling sim modules); nothing in Layer 1
// depends on it (only the orchestrator calls moveQueens / collectAliveQueenIds).
import type { WorldState } from '../types.js';
import {
  SurfaceMovementEffect,
  surfaceMovementAt,
  surfaceMovementAtCached,
  type SurfaceMovementCache,
} from '../surface-features.js';
import { AntTask, ChamberType } from '../enums.js';
import { hasCompletedChamber } from '../colony/colony-system.js';
import {
  SURFACE_GRID_WIDTH,
  SURFACE_GRID_HEIGHT,
  UNDERGROUND_GRID_WIDTH,
  UNDERGROUND_GRID_HEIGHT,
  QUEEN_EGG_INTERVAL_TICKS,
} from '../constants.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import type { EntranceFlowFields } from '../entrance-flow.js';
import type { ChamberFlowFields } from '../chamber-flow.js';
import { Zone, UndergroundTileState, ugGet } from '../terrain.js';
import {
  DIR_DX,
  DIR_DY,
  pickCardinalStep,
  unpackStepDx,
  unpackStepDy,
  cardinalStepScratch,
  diagonalizeFlowStep,
  canEnterUndergroundTile,
  canEnterSurfaceTile,
  pickSurfaceDetour,
  isInsideQueenChamber,
} from './ant-motion.js';

/**
 * Issue #67 — module-level scratch for `collectAliveQueenIds`. Cleared and
 * refilled each call. Reused across the per-tick lookup loops in
 * `tickAntMovement`. Single-threaded sim — no concurrent collection risk.
 */
// eslint-disable-next-line subterrans/sim-module-state -- sim-scratch: cleared+refilled at the top of each collectAliveQueenIds call
const QUEEN_IDS_SCRATCH = new Set<number>();

/**
 * Collect alive queen entity ids. Returns the module-level
 * `QUEEN_IDS_SCRATCH` singleton (filled in place) or `null` if no queens
 * qualify. Caller MUST consume the returned set before any other call to
 * `collectAliveQueenIds` — the next call clears and refills the same
 * instance, silently invalidating prior references. Today's only caller
 * (`tickAntMovement`) consumes inline within the same function body, so
 * the shared mutable is safe.
 */
export function collectAliveQueenIds(world: WorldState): Set<number> | null {
  // Only skip ants that the relocation pass actually drives. That requires a
  // completed Queen chamber AND task=Idle (the queen's canonical task). This
  // narrowing matters for test fixtures where the colony's queenEntityId
  // placeholder may point at a non-queen entity (e.g. setupForagerWorld uses
  // entity 0 as a forager and createColonyRecord(..., 0) as the queen slot).
  // Without a Queen chamber moveQueens is a no-op, so the main loop must
  // remain responsible for moving that entity.
  //
  // Issue #67 — clear-and-fill the module-level scratch instead of
  // allocating a new Set per tick. Returning `null` for "no queens to skip"
  // is preserved; callers fast-path on null without touching the set.
  QUEEN_IDS_SCRATCH.clear();
  let any = false;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const qId = colony.queenEntityId;
    if (world.ants.alive[qId] !== 1) continue;
    if (world.ants.task[qId] !== AntTask.Idle) continue;
    if (!hasCompletedChamber(colony, ChamberType.Queen)) continue;
    QUEEN_IDS_SCRATCH.add(qId);
    any = true;
  }
  return any ? QUEEN_IDS_SCRATCH : null;
}

/**
 * Move every alive colony queen one step toward (or around inside) her Queen chamber.
 *
 * No Queen chamber → queen holds (initial state — any starting position is
 * the "home" position for Phase 3 playability).
 * Queen already inside Queen chamber footprint → wander deterministically
 * between chamber Open tiles, advancing the target every QUEEN_EGG_INTERVAL_TICKS.
 * (Issue #16: prevents her sticking in whichever corner the flow-field first
 * delivered her to; also spreads brood across the chamber since eggs spawn
 * at the queen's current tile.)
 * Surface → step toward nearest OPEN entrance; descend when on the entrance
 * tile (Surface → Underground, posY = 0).
 * Underground → consume the per-colony `queen` chamber flow-field; fall back
 * to Manhattan step toward the nearest Queen-chamber Open tile when the
 * cache is absent (test harness path).
 *
 * Queens NEVER return to the surface once underground. Their passability
 * uses AntTask.Idle rules (blocks Solid + Marked) — the queen is not a
 * digger and must never cut through dirt.
 */
export function moveQueens(
  world: WorldState,
  queenIds: Set<number> | null,
  entranceFlowFields?: EntranceFlowFields,
  chamberFlowFields?: ChamberFlowFields,
  surfaceMoveCache?: SurfaceMovementCache,
): void {
  void entranceFlowFields; // entrance steering for queens uses Manhattan — no flow-field needed on surface.
  if (queenIds === null || queenIds.size === 0) return;

  const ants = world.ants;
  const surfaceMaxX = (SURFACE_GRID_WIDTH << FP_SHIFT) - 1;
  const surfaceMaxY = (SURFACE_GRID_HEIGHT << FP_SHIFT) - 1;
  const undergroundMaxX = (UNDERGROUND_GRID_WIDTH << FP_SHIFT) - 1;
  const undergroundMaxY = (UNDERGROUND_GRID_HEIGHT << FP_SHIFT) - 1;

  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const colony = world.colonies[key as unknown as number]!;
    const qId = colony.queenEntityId;
    if (!queenIds.has(qId)) continue;

    // Gate: no completed Queen chamber → queen holds at her current tile.
    if (!hasCompletedChamber(colony, ChamberType.Queen)) continue;

    const zone = ants.zone[qId]!;
    const prevPosX = ants.posX[qId]!;
    const prevPosY = ants.posY[qId]!;
    const tileX = prevPosX >> FP_SHIFT;
    const tileY = prevPosY >> FP_SHIFT;

    let dx = 0;
    let dy = 0;

    // Issue #16 — once the queen is inside her chamber, drift between Open
    // tiles instead of holding wherever the flow-field first delivered her
    // (always a corner). Cycles deterministically every QUEEN_EGG_INTERVAL_TICKS
    // so the target advances each egg-laying interval. Eggs spawn at her
    // current tile (lifecycle-system.ts), so the wander also distributes
    // brood across the chamber footprint.
    const isAlreadyHome = zone === Zone.Underground && isInsideQueenChamber(colony, tileX, tileY);
    if (isAlreadyHome) {
      const underground = world.undergroundGrids[ants.currentGridColonyId[qId]!];
      if (!underground) continue;
      let openCount = 0;
      for (let c = 0; c < colony.chambers.length; c++) {
        const ch = colony.chambers[c]!;
        if (ch.chamberType !== ChamberType.Queen) continue;
        const bx = ch.posX >> FP_SHIFT;
        const by = ch.posY >> FP_SHIFT;
        for (let ty = 0; ty < ch.height; ty++) {
          for (let tx = 0; tx < ch.width; tx++) {
            if (ugGet(underground, bx + tx, by + ty) === UndergroundTileState.Open) openCount++;
          }
        }
      }
      if (openCount === 0) continue;
      // `| 0` performs ECMA-262 ToInt32 — bit-identical across V8/JSC/SpiderMonkey
      // and integer-exact for any quotient that fits in Int32. The cast wraps
      // negative once `tick / interval` exceeds 2^31, i.e. tick > 2^31 × 300
      // ≈ 6.4×10^11 ticks (~1000 years at 20Hz). `((x % n) + n) % n` folds the
      // wrap deterministically back into [0, openCount) so the indexed match
      // below never falls off the end.
      // eslint-disable-next-line no-restricted-syntax -- integer division via `| 0`; tick / interval is integer arithmetic, not fixed-point math
      const cycleIndex = (world.tick / QUEEN_EGG_INTERVAL_TICKS) | 0;
      const targetIndex = ((cycleIndex % openCount) + openCount) % openCount;
      let i = 0;
      let targetTileX = -1;
      let targetTileY = -1;
      for (let c = 0; c < colony.chambers.length && targetTileX < 0; c++) {
        const ch = colony.chambers[c]!;
        if (ch.chamberType !== ChamberType.Queen) continue;
        const bx = ch.posX >> FP_SHIFT;
        const by = ch.posY >> FP_SHIFT;
        for (let ty = 0; ty < ch.height && targetTileX < 0; ty++) {
          for (let tx = 0; tx < ch.width; tx++) {
            const cx = bx + tx;
            const cy = by + ty;
            if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
            if (i === targetIndex) {
              targetTileX = cx;
              targetTileY = cy;
              break;
            }
            i++;
          }
        }
      }
      if (targetTileX < 0) continue;
      if (targetTileX === tileX && targetTileY === tileY) continue;
      // pickCardinalStep takes one 8-connected step per tick from the tile-space
      // delta (cardinal when an axis delta is zero, diagonal otherwise).
      const step = pickCardinalStep(ants, qId, targetTileX - tileX, targetTileY - tileY);
      dx = unpackStepDx(step);
      dy = unpackStepDy(step);
    } else if (zone === Zone.Surface) {
      // Pre-move descent: if the queen is already standing on one of her
      // colony's OPEN entrance tiles, descend immediately rather than computing
      // a (0,0) Manhattan delta and bailing via the zero-delta early return.
      // Debug case: starter colony spawns the queen on the entrance tile with a
      // completed Queen chamber already in place — without this short-circuit
      // she would sit on the entrance forever and Gate 6 would block egg
      // production indefinitely.
      for (let e = 0; e < colony.entrances.length; e++) {
        const entrance = colony.entrances[e]!;
        if (!entrance.isOpen) continue;
        if (entrance.surfaceTileX !== tileX || entrance.surfaceTileY !== tileY) continue;
        // PR 6-sim (V30, #128 class-ii) — landing-tile validity guard. This is the
        // queen's THIRD descent path (already standing on her open entrance); like
        // the worker descent and the queen step-onto-entrance descent, she lands
        // ONLY on an enterable (tileX, 0) tile, else holds on the surface this
        // tick. Fails CLOSED on a missing grid. Without this, a corrupt save
        // (isOpen true, column-top not enterable) — or the documented starter
        // case — would embed her, the exact class-ii write the sibling guards stop.
        const landingGrid = world.undergroundGrids[colony.colonyId];
        if (
          landingGrid === undefined ||
          !canEnterUndergroundTile(landingGrid, tileX, 0, ants.task[qId]! as AntTask)
        ) {
          continue;
        }
        ants.zone[qId] = Zone.Underground;
        // Phase 09.1 Chunk 0 — descent invariant: the entrance-owning colony
        // dictates the queen's occupied grid. Queens never invade, so this
        // is a byte-identical no-op today (colony.colonyId === own).
        ants.currentGridColonyId[qId] = colony.colonyId;
        ants.posY[qId] = 0;
        // posX preserved (entrance shaft is the same column); next tick the
        // underground branch steers her toward the Queen chamber via the
        // queen flow-field.
        break;
      }
      if (ants.zone[qId] === Zone.Underground) continue;

      // Route to the nearest OPEN entrance. Deterministic tie-break:
      // smallest entranceId wins (same rule tickAntMovement uses).
      let bestDist = -1;
      let bestId = -1;
      let targetTileX = -1;
      let targetTileY = -1;
      for (let e = 0; e < colony.entrances.length; e++) {
        const ent = colony.entrances[e]!;
        if (!ent.isOpen) continue;
        const d = Math.abs(ent.surfaceTileX - tileX) + Math.abs(ent.surfaceTileY - tileY);
        if (bestDist < 0 || d < bestDist || (d === bestDist && ent.entranceId < bestId)) {
          bestDist = d;
          bestId = ent.entranceId;
          targetTileX = ent.surfaceTileX;
          targetTileY = ent.surfaceTileY;
        }
      }
      if (targetTileX < 0) continue; // no open entrance — queen cannot descend yet.
      // Issue #34: see pickCardinalStep helper above.
      const step = pickCardinalStep(ants, qId, targetTileX - tileX, targetTileY - tileY);
      dx = unpackStepDx(step);
      dy = unpackStepDy(step);
    } else {
      // Underground → follow the queen flow-field (seeded only from Queen
      // chamber Open tiles). A Nursery-only chamber tile must NOT be a
      // resting target for the queen, so we never consume the nursing field
      // here.
      //
      // Phase 09.1 Chunk 0: queens never invade, so ants.currentGridColonyId[qId]
      // always equals colony.colonyId. Still, the grid lookup keys off the
      // queen's occupancy byte to match the invariant "all ant grid lookups
      // route through currentGridColonyId" (consistency with foragers/
      // nurses/diggers refactored above).
      const underground = world.undergroundGrids[ants.currentGridColonyId[qId]!];
      if (!underground) continue;

      let stepped = false;
      if (chamberFlowFields) {
        const flowField = chamberFlowFields.queen[colony.colonyId];
        if (flowField) {
          const idx = tileY * underground.width + tileX;
          const dir = flowField[idx]!;
          if (dir === -1) {
            // On a Queen chamber Open tile — isInsideQueenChamber covers this
            // earlier in the function, but the flow-field may still report
            // -1 on a queen-chamber Marked-tile-turned-Open boundary race.
            continue;
          }
          if (dir === -2) {
            // Unreachable — failsafe: hold. The queen cannot cut through
            // dirt. Once a digger excavates the intervening tile, dirty
            // flag will recompute the field.
            continue;
          }
          if (dir >= 0 && dir < 4) {
            // Issue #34 v4 follow-up: lift the cardinal step into a diagonal
            // when the next tile's flow-field direction is perpendicular and
            // the corner-cut check passes. Queens use AntTask.Idle for
            // passability rules — no Marked-tile traversal.
            diagonalizeFlowStep(
              underground,
              flowField,
              tileX,
              tileY,
              DIR_DX[dir]!,
              DIR_DY[dir]!,
              AntTask.Idle,
              world.simVersion,
              cardinalStepScratch,
            );
            dx = cardinalStepScratch.dx;
            dy = cardinalStepScratch.dy;
            stepped = true;
          }
        }
      }

      if (!stepped) {
        // No cache or no field yet — Manhattan fallback: nearest Queen
        // chamber Open tile.
        let bestDist = -1;
        let targetTileX = -1;
        let targetTileY = -1;
        for (let c = 0; c < colony.chambers.length; c++) {
          const ch = colony.chambers[c]!;
          if (ch.chamberType !== ChamberType.Queen) continue;
          const bx = ch.posX >> FP_SHIFT;
          const by = ch.posY >> FP_SHIFT;
          for (let ty = 0; ty < ch.height; ty++) {
            for (let tx = 0; tx < ch.width; tx++) {
              const cx = bx + tx;
              const cy = by + ty;
              if (ugGet(underground, cx, cy) !== UndergroundTileState.Open) continue;
              const d = Math.abs(cx - tileX) + Math.abs(cy - tileY);
              if (bestDist < 0 || d < bestDist) {
                bestDist = d;
                targetTileX = cx;
                targetTileY = cy;
              }
            }
          }
        }
        if (targetTileX < 0) continue;
        // Issue #34: see pickCardinalStep helper above.
        const step = pickCardinalStep(ants, qId, targetTileX - tileX, targetTileY - tileY);
        dx = unpackStepDx(step);
        dy = unpackStepDy(step);
      }
    }

    if (dx === 0 && dy === 0) continue;

    const baseSpeed = ants.speed[qId]!;
    // Surface SoftCost slowdown (issue #44 step 5 — gated on v6). When the
    // queen's current tile is a SoftCost feature (bush / grass clump),
    // halve effective speed for this tick. Integer-only; min 1 so a base
    // speed of 1 doesn't get clamped to zero. Pre-v6 queens move at base
    // speed regardless. Uses the per-tick cache when available; falls back
    // to direct compute when called from a test harness without a cache.
    let speed = baseSpeed;
    if (zone === Zone.Surface) {
      const movement =
        surfaceMoveCache !== undefined
          ? surfaceMovementAtCached(world, tileX, tileY, surfaceMoveCache)
          : surfaceMovementAt(world, tileX, tileY);
      if (movement === SurfaceMovementEffect.SoftCost) {
        const halved = baseSpeed >> 1;
        speed = halved < 1 ? 1 : halved;
      }
    }
    let posX = prevPosX + dx * speed;
    let posY = prevPosY + dy * speed;

    // Underground passability guard — queen uses AntTask.Idle rules, so
    // Solid and Marked are both blocked. She can only traverse Open and
    // BeingDug tiles, guaranteeing no dirt-cutting.
    //
    // Phase 09.1 Chunk 0: keys off currentGridColonyId for consistency with
    // the invariant. Queens never invade, so same grid as colony.colonyId
    // today.
    if (zone === Zone.Underground) {
      const underground = world.undergroundGrids[ants.currentGridColonyId[qId]!];
      if (underground) {
        const newTileX = posX >> FP_SHIFT;
        const newTileY = posY >> FP_SHIFT;
        const xCrossed = newTileX !== tileX;
        const yCrossed = newTileY !== tileY;
        if (xCrossed && yCrossed) {
          // Diagonal tile crossing (issue #34 v4) — corner-cut prevention.
          const destPassable = canEnterUndergroundTile(
            underground,
            newTileX,
            newTileY,
            AntTask.Idle,
          );
          const passXOnly = canEnterUndergroundTile(underground, newTileX, tileY, AntTask.Idle);
          const passYOnly = canEnterUndergroundTile(underground, tileX, newTileY, AntTask.Idle);
          if (destPassable && (passXOnly || passYOnly)) {
            // Diagonal allowed.
          } else if (passXOnly) {
            posY = prevPosY;
          } else if (passYOnly) {
            posX = prevPosX;
          } else {
            posX = prevPosX;
            posY = prevPosY;
          }
        } else if (xCrossed) {
          if (!canEnterUndergroundTile(underground, newTileX, tileY, AntTask.Idle)) {
            posX = prevPosX;
          }
        } else if (yCrossed) {
          if (!canEnterUndergroundTile(underground, tileX, newTileY, AntTask.Idle)) {
            posY = prevPosY;
          }
        }
      }
    }

    // Surface passability guard + detour.
    if (zone === Zone.Surface && (dx !== 0 || dy !== 0)) {
      const newTileX = posX >> FP_SHIFT;
      const newTileY = posY >> FP_SHIFT;
      const xCrossed = newTileX !== tileX;
      const yCrossed = newTileY !== tileY;
      let blocked = false;
      if (xCrossed && yCrossed) {
        const destPassable = canEnterSurfaceTile(world, newTileX, newTileY);
        const passXOnly = canEnterSurfaceTile(world, newTileX, tileY);
        const passYOnly = canEnterSurfaceTile(world, tileX, newTileY);
        if (destPassable && (passXOnly || passYOnly)) {
          // Diagonal allowed.
        } else if (passXOnly) {
          posY = prevPosY;
        } else if (passYOnly) {
          posX = prevPosX;
        } else {
          blocked = true;
        }
      } else if (xCrossed && !canEnterSurfaceTile(world, newTileX, tileY)) {
        blocked = true;
      } else if (yCrossed && !canEnterSurfaceTile(world, tileX, newTileY)) {
        blocked = true;
      }
      if (blocked) {
        // Queens don't carry a recent-tiles ring buffer (the buffer is
        // only populated for surface Foraging ants), so passing qId is
        // harmless — `isRecentTile` returns false for the unpopulated
        // sentinel-filled buffer. See pickSurfaceDetour docstring.
        const detour = pickSurfaceDetour(world, tileX, tileY, dx, dy, qId);
        if (detour.dx !== 0 || detour.dy !== 0) {
          // Snap to the detour tile (mirrors the tickAntMovement guard);
          // queens at half speed would otherwise nudge sub-tile and the
          // next tick's steering would nudge them back.
          posX = ((tileX + detour.dx) << FP_SHIFT) + (FP_ONE >> 1);
          posY = ((tileY + detour.dy) << FP_SHIFT) + (FP_ONE >> 1);
        } else {
          // No walkable detour candidate — hold in place.
          posX = prevPosX;
          posY = prevPosY;
        }
      }
    }

    // Clamp to zone bounds
    if (zone === Zone.Underground) {
      if (posX < 0) posX = 0;
      else if (posX > undergroundMaxX) posX = undergroundMaxX;
      if (posY < 0) posY = 0;
      else if (posY > undergroundMaxY) posY = undergroundMaxY;
    } else {
      if (posX < 0) posX = 0;
      else if (posX > surfaceMaxX) posX = surfaceMaxX;
      if (posY < 0) posY = 0;
      else if (posY > surfaceMaxY) posY = surfaceMaxY;
    }

    ants.posX[qId] = posX;
    ants.posY[qId] = posY;

    // Zone transition — Surface → Underground only. Queens never return to
    // the surface once they descend.
    if (zone === Zone.Surface) {
      const newTileX = posX >> FP_SHIFT;
      const newTileY = posY >> FP_SHIFT;
      for (let e = 0; e < colony.entrances.length; e++) {
        const entrance = colony.entrances[e]!;
        if (
          entrance.isOpen &&
          entrance.surfaceTileX === newTileX &&
          entrance.surfaceTileY === newTileY
        ) {
          // PR 6-sim (V30, #128 class-ii) — landing-tile validity guard, mirroring
          // the worker descent. The queen lands ONLY on an enterable (newTileX, 0)
          // tile; otherwise she holds on the surface this tick (re-checked next
          // tick). In normal play her entrance-column shaft top is Open, so this
          // never blocks her initial descent.
          // Fail CLOSED on a missing grid (unreachable in normal play), as the
          // worker descent does.
          const landingGrid = world.undergroundGrids[colony.colonyId];
          if (
            landingGrid === undefined ||
            !canEnterUndergroundTile(landingGrid, newTileX, 0, ants.task[qId]! as AntTask)
          ) {
            continue;
          }
          ants.zone[qId] = Zone.Underground;
          // Plan 09.1-00: every Surface→Underground transition must update
          // currentGridColonyId so the descending queen resolves to its own
          // colony's grid. Byte-identical today (queens never invade) but
          // required by the invariant for uniform downstream lookups.
          ants.currentGridColonyId[qId] = colony.colonyId;
          ants.posY[qId] = 0;
          break;
        }
      }
    }
  }
}
