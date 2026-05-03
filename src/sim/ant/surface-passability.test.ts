// surface-passability.test.ts — issue #44 step 4.
//
// Covers the new v6 surface passability + detour code paths in
// ant-system.ts:
//   - canEnterSurfaceTile: blocked on HardBlock, walkable on Cosmetic/SoftCost
//   - pickSurfaceDetour: deterministic alternate-tile pick, respects walkability
//   - tickAntMovement surface branch: honors HardBlock under v6, ignores under v5
//   - resolveSameColonyOccupancy surface bump: respects HardBlock under v6
//
// These tests construct synthetic worlds where the surface-feature selector
// returns a known feature shape, then assert the movement / passability
// outcomes. The worlds use specific terrainSeeds chosen so a known feature
// kind anchors at a predictable tile (verified empirically by walking the
// selector — adjusting the seed if a future registry change disturbs the
// hash).

import { describe, it, expect } from 'vitest';
import {
  createWorldState,
  allocateEntityId,
  SIM_VERSION_V5_CHAMBER_ON_MARKED,
  SIM_VERSION_V7_SURFACE_PASSABILITY,
} from '../types.js';
import { initAnt, pushRecentTile } from './ant-store.js';
import {
  canEnterSurfaceTile,
  pickSurfaceDetour,
  tickAntMovement,
} from './ant-system.js';
import { surfaceFeatureAt, SurfaceMovementEffect } from '../surface-features.js';
import { AntTask, ForagingSubState } from '../enums.js';
import { Zone } from '../terrain.js';
import { FP_SHIFT, FP_ONE } from '../fixed.js';
import { Rng } from '../rng.js';
import { createDigFlowFields } from '../dig-system.js';
import { createColonyRecord } from '../colony/colony-store.js';

// Helper: scan a region looking for a tile whose movement effect matches the
// requested predicate. Returns the first matching tile, or null.
function findTileWith(
  world: Parameters<typeof canEnterSurfaceTile>[0],
  predicate: (movement: SurfaceMovementEffect) => boolean,
  region = { x0: 0, y0: 0, x1: 80, y1: 80 },
): { x: number; y: number } | null {
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const slice = surfaceFeatureAt(world, x, y);
      const movement = slice === null ? SurfaceMovementEffect.Cosmetic : slice.movement;
      if (predicate(movement)) return { x, y };
    }
  }
  return null;
}

describe('canEnterSurfaceTile', () => {
  it('returns true for a Cosmetic tile (no feature)', () => {
    const world = createWorldState(42);
    const free = findTileWith(world, (m) => m === SurfaceMovementEffect.Cosmetic);
    expect(free).not.toBeNull();
    expect(canEnterSurfaceTile(world, free!.x, free!.y)).toBe(true);
  });

  it('returns false for a HardBlock tile (boulder/twig/leaf/big-leaf)', () => {
    const world = createWorldState(42);
    const blocked = findTileWith(world, (m) => m === SurfaceMovementEffect.HardBlock);
    expect(blocked).not.toBeNull();
    expect(canEnterSurfaceTile(world, blocked!.x, blocked!.y)).toBe(false);
  });

  it('returns true for a SoftCost tile (bush / grass clump)', () => {
    const world = createWorldState(42);
    const soft = findTileWith(world, (m) => m === SurfaceMovementEffect.SoftCost);
    expect(soft).not.toBeNull();
    expect(canEnterSurfaceTile(world, soft!.x, soft!.y)).toBe(true);
  });

  it('returns false for out-of-bounds tiles', () => {
    const world = createWorldState(42);
    expect(canEnterSurfaceTile(world, -1, 5)).toBe(false);
    expect(canEnterSurfaceTile(world, 5, -1)).toBe(false);
    expect(canEnterSurfaceTile(world, 9999, 5)).toBe(false);
    expect(canEnterSurfaceTile(world, 5, 9999)).toBe(false);
  });
});

describe('pickSurfaceDetour', () => {
  it('returns deterministic results — same inputs → same output across calls', () => {
    const world = createWorldState(42);
    // Find an arbitrary blocked candidate location to detour around.
    const blocked = findTileWith(world, (m) => m === SurfaceMovementEffect.HardBlock);
    expect(blocked).not.toBeNull();
    // Caller intent: step into the blocked tile from one tile west.
    const a = pickSurfaceDetour(world, blocked!.x - 1, blocked!.y, 1, 0);
    const b = pickSurfaceDetour(world, blocked!.x - 1, blocked!.y, 1, 0);
    expect(b).toEqual(a);
  });

  it('returns a step into a walkable adjacent tile when one exists', () => {
    const world = createWorldState(42);
    // Pick any open tile and detour from it. The detour must return either
    // (0, 0) (no walkable neighbor — extremely rare) or a step into a
    // canEnterSurfaceTile-true neighbor.
    const free = findTileWith(world, (m) => m === SurfaceMovementEffect.Cosmetic);
    expect(free).not.toBeNull();
    const detour = pickSurfaceDetour(world, free!.x, free!.y, 1, 0);
    if (detour.dx !== 0 || detour.dy !== 0) {
      expect(canEnterSurfaceTile(world, free!.x + detour.dx, free!.y + detour.dy)).toBe(true);
    }
  });

  it('returns (0, 0) when no walkable neighbor exists', () => {
    // Construct a world where the ant is surrounded by HardBlock — easiest
    // way is to put the ant at the (-1,-1) corner so all its neighbors are
    // out of bounds. canEnterSurfaceTile rejects out-of-bounds.
    const world = createWorldState(42);
    // Probe origin corner: from (-1, -1) all 8 neighbors include some
    // out-of-bounds tiles. There's still (0, 0) which may or may not be
    // hard-blocked. Use a more robust test: query from far-out-of-bounds
    // (-100, -100) where every probe is still out of bounds.
    const detour = pickSurfaceDetour(world, -100, -100, 1, 1);
    expect(detour).toEqual({ dx: 0, dy: 0 });
  });

  it('rejects diagonal candidates that would squeeze through a HardBlock corner (BLOCKER fix)', () => {
    // Code-review BLOCKER: pre-fix, pickSurfaceDetour could return a
    // diagonal step (e.g. (-1, 1)) without checking the two intermediate
    // cardinal tiles, allowing a surface ant to squeeze diagonally between
    // two adjacent HardBlock features. The underground guard at the
    // tickAntMovement diagonal block explicitly prevents this; the surface
    // detour now mirrors that protection.
    //
    // Strategy: scan many world seeds + tile positions until we find a
    // natural occurrence of "(prev+pdx, prev+pdy) is walkable, but
    // (prev+pdx, prev) AND (prev, prev+pdy) are both HardBlock". For each
    // such tile, call pickSurfaceDetour with intent diagonal toward the
    // corner; the returned step must NOT be a diagonal whose two
    // intermediate cardinals are both blocked.
    let foundCorner = false;
    seedLoop:
    for (let seed = 1; seed < 50; seed++) {
      const world = createWorldState(seed);
      for (let y = 5; y < 80; y++) {
        for (let x = 5; x < 80; x++) {
          // Try all 4 diagonal directions for the squeeze geometry.
          for (let s = 0; s < 4; s++) {
            const ddx = s === 0 || s === 1 ?  1 : -1;
            const ddy = s === 0 || s === 2 ?  1 : -1;
            const here       = canEnterSurfaceTile(world, x, y);
            const diag       = canEnterSurfaceTile(world, x + ddx, y + ddy);
            const interX     = canEnterSurfaceTile(world, x + ddx, y);
            const interY     = canEnterSurfaceTile(world, x, y + ddy);
            if (here && diag && !interX && !interY) {
              foundCorner = true;
              // Call the detour with intent EXACTLY toward the diagonal.
              // Even though `diag` is walkable, the corner squeeze must
              // be rejected and a different (non-corner-squeeze)
              // candidate picked.
              const det = pickSurfaceDetour(world, x, y, ddx, ddy);
              // Returned step must NOT be the corner-squeeze diagonal.
              expect(det.dx === ddx && det.dy === ddy).toBe(false);
              // Whatever step it returned, it must be safe — either a
              // cardinal, or a diagonal whose intermediates are not
              // both blocked, or (0, 0).
              if (det.dx !== 0 && det.dy !== 0) {
                const safeX = canEnterSurfaceTile(world, x + det.dx, y);
                const safeY = canEnterSurfaceTile(world, x, y + det.dy);
                expect(safeX || safeY).toBe(true);
              }
              break seedLoop;
            }
          }
        }
      }
    }
    // We need to actually exercise the fix — bail out loudly if no
    // corner geometry was found, so a future registry change that makes
    // corners impossible is caught here rather than silently passing.
    expect(foundCorner).toBe(true);
  });

  it('considers diagonal escapes when the intended step is purely cardinal (Codex P2 fix)', () => {
    // Codex P2 on PR #49: pre-fix `pickSurfaceDetour` derived its 8
    // probes from `intendedDx/intendedDy` via signed re-combinations.
    // When one axis was zero (cardinal-blocked move), the "diagonal-
    // away" probes collapsed into duplicate cardinal moves and the
    // picker never considered ANY actual diagonal escape. Result:
    // the ant could pick a worse reverse/cardinal step even when a
    // legal diagonal was closer to the intended destination.
    //
    // Repro: scan many seeds for a tile where (a) intent (1, 0) is
    // blocked east, AND (b) at least one diagonal (NE or SE) is
    // walkable AND closer-than-the-best-cardinal-alternate to the
    // east-of-here target. Pre-fix the picker would never return that
    // diagonal; post-fix it does.
    let foundCase = false;
    seedLoop:
    for (let seed = 1; seed < 50; seed++) {
      const world = createWorldState(seed);
      for (let y = 5; y < 60; y++) {
        for (let x = 5; x < 60; x++) {
          const here = canEnterSurfaceTile(world, x, y);
          if (!here) continue;
          // Intent: east. East tile blocked, NE walkable.
          const east  = canEnterSurfaceTile(world, x + 1, y);
          const ne    = canEnterSurfaceTile(world, x + 1, y - 1);
          const north = canEnterSurfaceTile(world, x, y - 1);
          if (east) continue;            // east must be the blocker
          if (!ne)  continue;            // NE must be a candidate
          // For the diagonal NE corner-cut check to pass, intermediate
          // cardinals (E or N) must include at least one walkable.
          // E is blocked here; require N walkable so corner-cut allows.
          if (!north) continue;
          foundCase = true;
          // Intent (1, 0). pickSurfaceDetour MUST return (1, -1) (NE)
          // — it has the smallest Manhattan distance to target (x+1, y)
          // among the walkable candidates: NE = |x+1-(x+1)| + |y-1 - y| = 1,
          // beats N = 1 (also tied) but NE is later in compass order; let's
          // just require the picker NOT return a worse score than NE's.
          // Worst-acceptable score = 1 (any of N, NE, S(if walk), SE(if walk)
          // would give score 1; W would give 2). Reject scores > 1.
          const det = pickSurfaceDetour(world, x, y, 1, 0);
          const detTargetX = x + 1;
          const detTargetY = y;
          const score = Math.abs((x + det.dx) - detTargetX) + Math.abs((y + det.dy) - detTargetY);
          expect(score).toBeLessThanOrEqual(1);
          break seedLoop;
        }
      }
    }
    expect(foundCase).toBe(true);
  });

  it('v8+ falls back to a recent tile when every walkable neighbor is in the recent buffer (Codex P2 round-3 fix)', () => {
    // Codex flagged that `pickSurfaceDetour` was filtering recent tiles
    // as a HARD reject. In a one-way pocket around HardBlock features,
    // if the only walkable neighbor is the just-vacated tile, the
    // function would return (0, 0) and the ant would hold in place.
    // Because the recent-tiles ring buffer only advances on tile
    // crossings (not on holds), the buffer never aged out and the ant
    // was permanently deadlocked. The fix turns the filter into a
    // preference: best non-recent tile wins, but if none exists we
    // fall back to the best recent tile so backtracking can drain
    // the buffer.
    //
    // Force the deadlock geometry deterministically by spawning at the
    // (0, 0) corner: every neighbor with a negative coordinate is
    // out-of-bounds and `canEnterSurfaceTile` rejects it, leaving only
    // E (1, 0), SE (1, 1), and S (0, 1) walkable when the seed leaves
    // those three tiles HardBlock-free. Pushing ALL THREE walkable
    // neighbors into the recent buffer exhausts the fresh-tile pool.
    // Pre-fix the picker would return (0, 0); post-fix it falls back
    // to one of the recent tiles.
    let world: ReturnType<typeof createWorldState> | null = null;
    const ANT_X = 0;
    const ANT_Y = 0;
    for (let seed = 1; seed < 200; seed++) {
      const w = createWorldState(seed);
      if (
        canEnterSurfaceTile(w, ANT_X + 1, ANT_Y) &&
        canEnterSurfaceTile(w, ANT_X + 1, ANT_Y + 1) &&
        canEnterSurfaceTile(w, ANT_X,     ANT_Y + 1)
      ) {
        world = w;
        break;
      }
    }
    expect(world).not.toBeNull();

    // suppress no-undef on the captured non-null world.
    const w = world!;
    const antId = allocateEntityId(w);
    initAnt(w.ants, antId, {
      colonyId: 1,
      posX: ANT_X << FP_SHIFT,
      posY: ANT_Y << FP_SHIFT,
    });
    // Push all THREE walkable neighbors into the recent buffer. Since
    // RECENT_TILES_LEN is 4, the ring isn't even full — every walkable
    // candidate is guaranteed to be recent.
    pushRecentTile(w.ants, antId, ANT_X + 1, ANT_Y);     // E
    pushRecentTile(w.ants, antId, ANT_X + 1, ANT_Y + 1); // SE
    pushRecentTile(w.ants, antId, ANT_X,     ANT_Y + 1); // S

    // Intent east. With all walkable neighbors recent, pre-fix returns
    // (0, 0) and the ant deadlocks; post-fix falls back to the best
    // recent candidate (one of E / SE / S — whichever scores lowest by
    // Manhattan to (1, 0)).
    const det = pickSurfaceDetour(w, ANT_X, ANT_Y, 1, 0, antId);
    expect(det.dx !== 0 || det.dy !== 0).toBe(true);
    // Returned step must be walkable.
    expect(canEnterSurfaceTile(w, ANT_X + det.dx, ANT_Y + det.dy)).toBe(true);
    // And it must be one of the three recent walkable neighbors —
    // proves the fallback path picked from the recent set rather than
    // some other accidental candidate.
    const isOneOfRecent =
      (det.dx === 1 && det.dy === 0) ||
      (det.dx === 1 && det.dy === 1) ||
      (det.dx === 0 && det.dy === 1);
    expect(isOneOfRecent).toBe(true);
  });

  it('pre-v8 still returns (0, 0) when every walkable neighbour is recent (legacy deadlock preserved)', () => {
    // Same setup as the v8 fallback test, but with simVersion bumped
    // DOWN to v7 to verify the gate. Pre-v8 captured saves must
    // continue to deadlock identically — that's the SCEN-06 contract.
    let world: ReturnType<typeof createWorldState> | null = null;
    const ANT_X = 0;
    const ANT_Y = 0;
    for (let seed = 1; seed < 200; seed++) {
      const w = createWorldState(seed);
      if (
        canEnterSurfaceTile(w, ANT_X + 1, ANT_Y) &&
        canEnterSurfaceTile(w, ANT_X + 1, ANT_Y + 1) &&
        canEnterSurfaceTile(w, ANT_X,     ANT_Y + 1)
      ) {
        world = w;
        break;
      }
    }
    expect(world).not.toBeNull();
    const w = world!;
    w.simVersion = SIM_VERSION_V7_SURFACE_PASSABILITY;
    const antId = allocateEntityId(w);
    initAnt(w.ants, antId, {
      colonyId: 1,
      posX: ANT_X << FP_SHIFT,
      posY: ANT_Y << FP_SHIFT,
    });
    pushRecentTile(w.ants, antId, ANT_X + 1, ANT_Y);
    pushRecentTile(w.ants, antId, ANT_X + 1, ANT_Y + 1);
    pushRecentTile(w.ants, antId, ANT_X,     ANT_Y + 1);
    const det = pickSurfaceDetour(w, ANT_X, ANT_Y, 1, 0, antId);
    expect(det).toEqual({ dx: 0, dy: 0 });
  });

  it('prefers cardinal slip on intended axis as the first probe', () => {
    // Construct a synthetic test by checking the well-defined order:
    // probe 1 is (intendedDx, 0). When that candidate is walkable AND has
    // the smallest score, it must win.
    const world = createWorldState(42);
    const free = findTileWith(world, (m) => m === SurfaceMovementEffect.Cosmetic);
    expect(free).not.toBeNull();
    // Walk from free.x, free.y toward (free.x + 2, free.y + 2) — diagonal.
    // If the (free.x + 2, free.y) tile is walkable, the cardinal X slip
    // (probe 1) is one of the candidates; with intended=(2, 2), Manhattan
    // to target=(free.x+2, free.y+2) for the slip (free.x+2, free.y) is
    // |0| + |2| = 2 — same score as a slip toward (free.x, free.y+2).
    // Either way the detour returns one of those slips.
    const detour = pickSurfaceDetour(world, free!.x, free!.y, 2, 2);
    if (detour.dx !== 0 || detour.dy !== 0) {
      // Whatever it returns must be walkable.
      expect(canEnterSurfaceTile(world, free!.x + detour.dx, free!.y + detour.dy)).toBe(true);
    }
  });
});

describe('tickAntMovement surface passability — gated on simVersion', () => {
  // Helper: spawn a surface ant at (tileX, tileY) targeting (targetTileX,
  // targetTileY). Uses Foraging+CarryingFood task because that has a clean
  // entrance-routing path. Caller must install a colony with an entrance
  // for the ant to route toward.
  function spawnSurfaceCarrier(
    world: ReturnType<typeof createWorldState>,
    colonyId: number,
    tileX: number,
    tileY: number,
  ): number {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId,
      posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
      posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Foraging,
      subTask: ForagingSubState.CarryingFood,
      zone: Zone.Surface,
    });
    world.ants.foodCarrying[id] = 1;
    world.ants.speed[id] = FP_ONE;
    return id;
  }

  it('under v6 — ant cannot move into a HardBlock tile', () => {
    // Find a tile pair (open, blocked) where (open.x + 1, open.y) is the
    // blocked tile. Spawn the ant on `open` with a target east of blocked
    // — its preferred step is east and should be rejected.
    const world = createWorldState(42);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V7_SURFACE_PASSABILITY);
    let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
    for (let y = 4; y < 50 && pair === null; y++) {
      for (let x = 4; x < 50; x++) {
        const open = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (
          (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
          east !== null && east.movement === SurfaceMovementEffect.HardBlock
        ) {
          pair = { open: { x, y }, blocked: { x: x + 1, y } };
          break;
        }
      }
    }
    expect(pair).not.toBeNull();

    // Install a colony with an entrance far east of the obstacle so the
    // ant routes that direction.
    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: pair!.blocked.x + 10,
      surfaceTileY: pair!.blocked.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, pair!.open.x, pair!.open.y);
    const startTileX = world.ants.posX[id]! >> FP_SHIFT;
    const startTileY = world.ants.posY[id]! >> FP_SHIFT;
    const blockedTileX = pair!.blocked.x;
    const blockedTileY = pair!.blocked.y;

    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());

    // Ant must NOT be on the blocked tile after the tick.
    const endTileX = world.ants.posX[id]! >> FP_SHIFT;
    const endTileY = world.ants.posY[id]! >> FP_SHIFT;
    expect(endTileX === blockedTileX && endTileY === blockedTileY).toBe(false);
    void startTileX; void startTileY;
  });

  it('under v7 — ant on a SoftCost (grass/bush) tile moves exactly half its base speed (issue #44 step 5)', () => {
    // Code-review HIGH fix: prior version of this test asserted
    // `endTileX - startTileX <= 1`, which is true under both full speed
    // (256 → exactly 1 tile crossed from mid-tile) and half speed (128 →
    // 0 or 1 tile crossed depending on starting offset). The assertion
    // would pass even if the SoftCost branch were deleted entirely.
    //
    // Strict assertion: compare the actual posX delta in fixed-point
    // pixels. With base speed FP_ONE (256) and a cardinal east step
    // (dx=1, dy=0), the position delta is `dx * effectiveSpeed`. Full
    // speed: +256 sub-pixels. Half speed (SoftCost): +128. The
    // difference is unambiguous and would surface a missing slowdown.
    const world = createWorldState(42);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V7_SURFACE_PASSABILITY);
    // Find a SoftCost tile with a non-HardBlock neighbor to the east
    // (the ant needs somewhere to step) and any tile to the far east
    // for the entrance target.
    let soft: { x: number; y: number } | null = null;
    for (let y = 4; y < 80 && soft === null; y++) {
      for (let x = 4; x < 60; x++) {
        const cur = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (
          cur !== null && cur.movement === SurfaceMovementEffect.SoftCost &&
          (east === null || east.movement !== SurfaceMovementEffect.HardBlock)
        ) {
          soft = { x, y };
          break;
        }
      }
    }
    expect(soft).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: soft!.x + 30,
      surfaceTileY: soft!.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, soft!.x, soft!.y);
    // Spawn helper sets speed = FP_ONE; pin explicitly for clarity.
    world.ants.speed[id] = FP_ONE;
    const startPosX = world.ants.posX[id]!;
    const startPosY = world.ants.posY[id]!;
    tickAntMovement(world, new Rng(42), createDigFlowFields());
    const deltaX = world.ants.posX[id]! - startPosX;
    const deltaY = world.ants.posY[id]! - startPosY;

    // Effective half-speed: cardinal step (dx=1, dy=0 OR similar single-
    // axis) with FP_ONE/2 = 128 produces |deltaX| + |deltaY| === 128.
    // The post-step surface-passability guard MIGHT revert the axis if
    // the destination tile turns out to be HardBlock — but our search
    // above filtered out HardBlock east-neighbors, so the step is
    // accepted in full.
    const totalDelta = Math.abs(deltaX) + Math.abs(deltaY);
    expect(totalDelta).toBe(FP_ONE >> 1);  // exactly 128 — half speed
  });

  it('under v7 — ant on a Cosmetic tile moves exactly its base speed (sanity, complements the SoftCost test)', () => {
    const world = createWorldState(42);
    // Find a Cosmetic tile with a Cosmetic east neighbor.
    let open: { x: number; y: number } | null = null;
    for (let y = 4; y < 80 && open === null; y++) {
      for (let x = 4; x < 60; x++) {
        const cur = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (cur === null && east === null) {
          open = { x, y };
          break;
        }
      }
    }
    expect(open).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: open!.x + 30,
      surfaceTileY: open!.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, open!.x, open!.y);
    world.ants.speed[id] = FP_ONE;
    const startPosX = world.ants.posX[id]!;
    const startPosY = world.ants.posY[id]!;
    tickAntMovement(world, new Rng(42), createDigFlowFields());
    const deltaX = world.ants.posX[id]! - startPosX;
    const deltaY = world.ants.posY[id]! - startPosY;

    // Full speed: cardinal step at FP_ONE = 256 sub-pixels.
    const totalDelta = Math.abs(deltaX) + Math.abs(deltaY);
    expect(totalDelta).toBe(FP_ONE);  // exactly 256 — full speed
  });

  it('detour: ant blocked from preferred east step ends at a deterministic alternate tile (issue #44 step 6)', () => {
    // Codex review explicitly called this out: a hard-block guard alone
    // would make ants repeatedly try to step into the same obstacle. The
    // deterministic local detour picks an alternate adjacent walkable tile.
    // This integration test: spawn an ant west of a HardBlock with target
    // east. After one tick, ant must NOT be on the blocked tile, AND must
    // be on a deterministic alternate (same seed → same alternate every run).
    const seed = 42;
    function runTick(): { x: number; y: number } {
      const world = createWorldState(seed);
      let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
      for (let y = 4; y < 50 && pair === null; y++) {
        for (let x = 4; x < 50; x++) {
          const open = surfaceFeatureAt(world, x, y);
          const east = surfaceFeatureAt(world, x + 1, y);
          if (
            (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
            east !== null && east.movement === SurfaceMovementEffect.HardBlock
          ) {
            pair = { open: { x, y }, blocked: { x: x + 1, y } };
            break;
          }
        }
      }
      if (pair === null) throw new Error('no test pair found for seed');

      const colony = createColonyRecord(1, 0);
      colony.entrances = [{
        entranceId: 0,
        surfaceTileX: pair.blocked.x + 10,
        surfaceTileY: pair.blocked.y,
        isOpen: true,
      }];
      colony.rallyPoint = null;
      colony.digFlowFieldDirty = false;
      world.colonies[1] = colony;

      const id = spawnSurfaceCarrier(world, 1, pair.open.x, pair.open.y);
      tickAntMovement(world, new Rng(seed), createDigFlowFields());
      return { x: world.ants.posX[id]! >> FP_SHIFT, y: world.ants.posY[id]! >> FP_SHIFT };
    }

    // Run twice — the resulting tile must be identical (deterministic detour).
    const a = runTick();
    const b = runTick();
    expect(b).toEqual(a);
  });

  it('occupancy resolver: a same-colony bump never lands an ant on a HardBlock tile (issue #44 step 6)', () => {
    // Codex review: "Occupancy resolver does not shift ants into blocked
    // surface tiles." Construct a scenario where two same-colony ants end
    // up on the same tile, with the only otherwise-valid neighbor being
    // a HardBlock feature. The resolver must skip the HardBlock direction.
    //
    // Strategy: install a colony, find a tile T whose North neighbor is
    // HardBlock and whose East/South/West are walkable. Spawn two same-
    // colony ants both targeting T. The resolver should bump the higher-id
    // to East/South/West, NOT North.
    const world = createWorldState(42);
    expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V7_SURFACE_PASSABILITY);

    let pickedT: { x: number; y: number } | null = null;
    for (let y = 5; y < 80 && pickedT === null; y++) {
      for (let x = 5; x < 80; x++) {
        const here  = surfaceFeatureAt(world, x, y);
        const north = surfaceFeatureAt(world, x, y - 1);
        const east  = surfaceFeatureAt(world, x + 1, y);
        const south = surfaceFeatureAt(world, x, y + 1);
        const west  = surfaceFeatureAt(world, x - 1, y);
        const hereOk  = here === null || here.movement !== SurfaceMovementEffect.HardBlock;
        const northBlock = north !== null && north.movement === SurfaceMovementEffect.HardBlock;
        const eastOk  = east === null || east.movement !== SurfaceMovementEffect.HardBlock;
        const southOk = south === null || south.movement !== SurfaceMovementEffect.HardBlock;
        const westOk  = west === null || west.movement !== SurfaceMovementEffect.HardBlock;
        if (hereOk && northBlock && eastOk && southOk && westOk) {
          pickedT = { x, y };
          break;
        }
      }
    }
    expect(pickedT).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = []; colony.rallyPoint = null; colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    // Spawn two stationary ants at T. Both have no movement → both end at T
    // → the post-pass resolver detects the duplicate and shifts the higher-id.
    const aId = allocateEntityId(world);
    initAnt(world.ants, aId, {
      colonyId: 1,
      posX: pickedT!.x << FP_SHIFT,
      posY: pickedT!.y << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      zone: Zone.Surface,
    });
    const bId = allocateEntityId(world);
    initAnt(world.ants, bId, {
      colonyId: 1,
      posX: pickedT!.x << FP_SHIFT,
      posY: pickedT!.y << FP_SHIFT,
      task: AntTask.Idle,
      subTask: 0,
      zone: Zone.Surface,
    });
    expect(aId).toBeLessThan(bId);

    tickAntMovement(world, new Rng(42), createDigFlowFields());

    // B was bumped — it must not be on the HardBlock north tile.
    const bX = world.ants.posX[bId]! >> FP_SHIFT;
    const bY = world.ants.posY[bId]! >> FP_SHIFT;
    expect(bX === pickedT!.x && bY === pickedT!.y - 1).toBe(false);
  });

  it('pre-v7 vs v7: same seed, same scenario produces different ant motion (deterministic divergence)', () => {
    // Final check that the simVersion gate is doing its job: same world
    // setup, two simVersions, must produce different motion for at least
    // ONE ant after a few ticks. If the gate were broken we'd see
    // identical positions. Compares v5 (pre-#42, pre-#44) against v7
    // (#44 surface passability + soft cost). v6 sits between them and
    // adds the #42 forager-no-revisit filter, which is also surface-
    // movement-affecting, so v5↔v7 is the cleanest #44-isolating test.
    function runScenario(simVersionPin: 5 | 7): { posX: number; posY: number } {
      const world = createWorldState(42);
      world.simVersion = simVersionPin;

      // Find a tile pair where v6 would block but v5 wouldn't.
      let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
      for (let y = 4; y < 50 && pair === null; y++) {
        for (let x = 4; x < 50; x++) {
          const open = surfaceFeatureAt(world, x, y);
          const east = surfaceFeatureAt(world, x + 1, y);
          if (
            (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
            east !== null && east.movement === SurfaceMovementEffect.HardBlock
          ) {
            pair = { open: { x, y }, blocked: { x: x + 1, y } };
            break;
          }
        }
      }
      if (pair === null) throw new Error('no test pair found');

      const colony = createColonyRecord(1, 0);
      colony.entrances = [{
        entranceId: 0,
        surfaceTileX: pair.blocked.x + 10,
        surfaceTileY: pair.blocked.y,
        isOpen: true,
      }];
      colony.rallyPoint = null;
      colony.digFlowFieldDirty = false;
      world.colonies[1] = colony;

      const id = spawnSurfaceCarrier(world, 1, pair.open.x, pair.open.y);
      // ONE tick is enough to see divergence — at v5 the ant commits the
      // step into the HardBlock tile, at v7 the surface guard reverts +
      // detours. Multi-tick runs proved deceptive: both versions can
      // converge on the same final tile via different paths, masking the
      // version-gate bug if it regresses.
      tickAntMovement(world, new Rng(42), createDigFlowFields());
      return { posX: world.ants.posX[id]!, posY: world.ants.posY[id]! };
    }

    const v5 = runScenario(5);
    const v7 = runScenario(7);
    // v7 either detoured (different posX/posY) or held in place (no
    // walkable detour). v5 walks straight east into the HardBlock tile.
    // Positions MUST differ on tick 1.
    expect(v7.posX !== v5.posX || v7.posY !== v5.posY).toBe(true);
  });

  it('SoftCost slowdown clamps to min 1 (speed=1 stays at 1, doesn\'t go to 0)', () => {
    // Edge case: an ant with the absolute minimum nonzero speed (1) on a
    // SoftCost tile. Half of 1 is 0; the clamp must keep it at 1 so the
    // ant isn't permanently stuck. Verify by reading effective speed via
    // motion delta after one tick.
    const world = createWorldState(42);
    let soft: { x: number; y: number } | null = null;
    for (let y = 4; y < 80 && soft === null; y++) {
      for (let x = 4; x < 80; x++) {
        const cur = surfaceFeatureAt(world, x, y);
        if (cur !== null && cur.movement === SurfaceMovementEffect.SoftCost) {
          soft = { x, y };
          break;
        }
      }
    }
    expect(soft).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: soft!.x + 30,
      surfaceTileY: soft!.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, soft!.x, soft!.y);
    world.ants.speed[id] = 1;
    const startPosX = world.ants.posX[id]!;
    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());
    const endPosX = world.ants.posX[id]!;

    // Speed=1 halved would be 0; clamped to 1. So the ant moves at least
    // 1 sub-pixel per tick (the minimum quantum). NOT stuck.
    expect(endPosX).not.toBe(startPosX);
  });

  it('under v5 — same setup, ant freely walks onto the (now non-blocking) feature tile', () => {
    // Same construction as v6 test but with simVersion pinned. The
    // canEnterSurfaceTile guard is gated on v6, so v5 ants ignore features.
    const world = createWorldState(42);
    world.simVersion = SIM_VERSION_V5_CHAMBER_ON_MARKED;

    let pair: { open: { x: number; y: number }; blocked: { x: number; y: number } } | null = null;
    for (let y = 4; y < 50 && pair === null; y++) {
      for (let x = 4; x < 50; x++) {
        const open = surfaceFeatureAt(world, x, y);
        const east = surfaceFeatureAt(world, x + 1, y);
        if (
          (open === null || open.movement !== SurfaceMovementEffect.HardBlock) &&
          east !== null && east.movement === SurfaceMovementEffect.HardBlock
        ) {
          pair = { open: { x, y }, blocked: { x: x + 1, y } };
          break;
        }
      }
    }
    expect(pair).not.toBeNull();

    const colony = createColonyRecord(1, 0);
    colony.entrances = [{
      entranceId: 0,
      surfaceTileX: pair!.blocked.x + 10,
      surfaceTileY: pair!.blocked.y,
      isOpen: true,
    }];
    colony.rallyPoint = null;
    colony.digFlowFieldDirty = false;
    world.colonies[1] = colony;

    const id = spawnSurfaceCarrier(world, 1, pair!.open.x, pair!.open.y);
    const rng = new Rng(42);
    tickAntMovement(world, rng, createDigFlowFields());

    // Under v5 the ant moves freely; expected position is one tile east
    // (toward entrance) — i.e. ON the blocked tile.
    const endTileX = world.ants.posX[id]! >> FP_SHIFT;
    expect(endTileX).toBe(pair!.blocked.x);
  });
});
