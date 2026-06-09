// surface-features.test.ts — issue #44 step 1.
//
// Covers the sim-owned surface feature selector:
//   - per-tile determinism (same inputs → same output, repeatedly)
//   - terrainSeed actually varies layout (defeats coordinate-only-placement bug)
//   - cross-type and same-type anchor overlap suppression
//   - gameplay suppression (entrance radius, food pile)
//   - surfaceMovementAt convenience helper

import { describe, it, expect } from 'vitest';
import { createWorldState, type WorldState } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';
import {
  surfaceFeatureAt,
  surfaceMovementAt,
  surfaceFeatureProcedural,
  bakeSurfaceEffectGrid,
  bakeStaticTerrain,
  computeSurfaceComponentMask,
  SurfaceFeatureKind,
  SurfaceMovementEffect,
  type SurfaceFeatureSlice,
} from './surface-features.js';

// Helper: install a colony with a single open entrance at the given tile.
// Sets the Phase 3 caller-side fields (entrances, rallyPoint, digFlowFieldDirty)
// that surfaceFeatureAt's gameplay-suppression check reads. Other colony
// fields are left at their createColonyRecord defaults — surface-features
// only ever touches `entrances`.
function installColonyWithEntrance(
  world: WorldState,
  colonyId: number,
  surfaceTileX: number,
  surfaceTileY: number,
): void {
  const colony = createColonyRecord(colonyId, /* queenEntityId */ 0);
  colony.entrances = [
    {
      entranceId: 0,
      surfaceTileX,
      surfaceTileY,
      isOpen: true,
    },
  ];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  world.colonies[colonyId] = colony;
}

// Helper: scan a tile range and return the first tile where the selector
// returns a non-null slice. Used to locate a "naturally occurring" feature
// position so we can verify suppression actually changes the answer.
function findFirstFeatureTile(
  world: WorldState,
  xRange: number,
  yRange: number,
): { x: number; y: number; slice: SurfaceFeatureSlice } | null {
  for (let y = 0; y < yRange; y++) {
    for (let x = 0; x < xRange; x++) {
      const slice = surfaceFeatureAt(world, x, y);
      if (slice !== null) return { x, y, slice };
    }
  }
  return null;
}

describe('surfaceFeatureAt — determinism', () => {
  it('same (terrainSeed, tileX, tileY) → identical slice across repeated calls', () => {
    const world = createWorldState(42);
    // Walk a meaningful slab of tiles. Equality is structural — every field
    // must round-trip identically each call. If any non-determinism (e.g.
    // accidental Math.random, mutated module state) sneaks into the
    // selector, this test catches it.
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        const a = surfaceFeatureAt(world, x, y);
        const b = surfaceFeatureAt(world, x, y);
        expect(b).toEqual(a);
      }
    }
  });

  it('two worlds created with the same seed produce identical layouts', () => {
    const w1 = createWorldState(1234);
    const w2 = createWorldState(1234);
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        expect(surfaceFeatureAt(w2, x, y)).toEqual(surfaceFeatureAt(w1, x, y));
      }
    }
  });
});

describe('surfaceFeatureAt — terrainSeed varies layout', () => {
  it('different seeds produce visibly different anchor distributions', () => {
    // Pre-#44 placement was coordinate-only — every world looked identical.
    // After #44, terrainSeed XOR'd into the hash should change anchor
    // positions across seeds. We assert by counting feature-tiles in a
    // 60×60 region and requiring the per-tile match rate to be < 60%.
    // (Two truly random masks would match ~30% of the time on average; the
    // hash isn't cryptographic, but well-spread enough to clear 60% easily.)
    //
    // Integer-only comparison (sim/ bans float division): assert
    // `matches * 10 < total * 6`, equivalent to `matches/total < 0.6`.
    const a = createWorldState(1);
    const b = createWorldState(99999);
    let matches = 0;
    let total = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        const sa = surfaceFeatureAt(a, x, y);
        const sb = surfaceFeatureAt(b, x, y);
        // Compare existence + kind. Variant differences are expected even
        // when the kind matches; we want to know that the *layout* changed.
        const aHas = sa !== null;
        const bHas = sb !== null;
        if (aHas === bHas && (sa === null || sa.kind === sb!.kind)) matches++;
        total++;
      }
    }
    expect(matches * 10).toBeLessThan(total * 6);
  });

  it('seed=0 reproduces the pre-#44 coordinate-only layout (terrainSeed=0)', () => {
    // seed=0 → terrainSeed=0 (Math.imul(0, k) === 0). With terrainSeed=0
    // the salt XOR is a no-op so the hash matches the legacy render-side
    // hash; this is the "no-mixing" case. Worth a smoke test so a future
    // refactor that breaks the seed=0 boundary surfaces here.
    const world = createWorldState(0);
    expect(world.terrainSeed).toBe(0);
    // A few specific tiles should produce stable, well-defined output (we
    // don't pin exact slice contents — just that the call works and is
    // deterministic across two invocations).
    for (let i = 0; i < 5; i++) {
      const a = surfaceFeatureAt(world, i, i);
      const b = surfaceFeatureAt(world, i, i);
      expect(b).toEqual(a);
    }
  });
});

describe('surfaceFeatureAt — anchor overlap suppression', () => {
  it('multi-tile features cover their full footprint coherently (no half-features)', () => {
    // For any anchor (ax, ay) of a returned feature, every tile in the
    // [ax..ax+W-1] × [ay..ay+H-1] footprint must EITHER resolve to the
    // same anchor OR resolve to a different anchor whose ENTIRE footprint
    // also covers that tile (i.e. an occluding higher-priority anchor that
    // spans this point too — never a "partial" half-render).
    //
    // Step 4 update: the registry priority order (Boulder, Twig, Leaf,
    // BigLeaf, Bush, GrassClump) doesn't follow numeric kind order, so a
    // lower-priority same-anchor coexists with higher-priority overlapping
    // anchors. We can't compare numeric kinds directly; instead just check
    // that every "occluder" tile's resolved anchor footprint also covers
    // the tile being inspected.
    const world = createWorldState(7);
    const seenAnchors = new Set<string>();
    for (let y = 5; y < 25; y++) {
      for (let x = 5; x < 25; x++) {
        const slice = surfaceFeatureAt(world, x, y);
        if (slice === null) continue;
        const key = `${slice.kind}:${slice.anchorX}:${slice.anchorY}`;
        if (seenAnchors.has(key)) continue;
        seenAnchors.add(key);
        for (let dy = 0; dy < slice.footprintTilesTall; dy++) {
          for (let dx = 0; dx < slice.footprintTilesWide; dx++) {
            const fx = slice.anchorX + dx;
            const fy = slice.anchorY + dy;
            const inner = surfaceFeatureAt(world, fx, fy);
            if (inner === null) continue;
            // The resolved anchor's footprint must cover (fx, fy). Either
            // it's the same anchor or it's an occluding anchor whose own
            // footprint reaches here.
            const innerFx0 = inner.anchorX;
            const innerFy0 = inner.anchorY;
            const innerFx1 = inner.anchorX + inner.footprintTilesWide - 1;
            const innerFy1 = inner.anchorY + inner.footprintTilesTall - 1;
            expect(fx >= innerFx0 && fx <= innerFx1).toBe(true);
            expect(fy >= innerFy0 && fy <= innerFy1).toBe(true);
          }
        }
      }
    }
  });
});

describe('surfaceFeatureAt — STATIC terrain (PR 4): no dynamic suppression', () => {
  it('installing an entrance on a feature tile does NOT remove the feature', () => {
    // PR 4 deleted the dynamic entrance suppression halo — terrain is frozen at
    // bake. Installing an entrance on a feature tile must leave it unchanged.
    const seed = 42;
    const baseline = createWorldState(seed);
    const found = findFirstFeatureTile(baseline, 60, 60);
    expect(found).not.toBeNull();

    const withEntrance = createWorldState(seed);
    installColonyWithEntrance(withEntrance, /* colonyId */ 1, found!.x, found!.y);
    expect(surfaceFeatureAt(withEntrance, found!.x, found!.y)).toEqual(found!.slice);
  });

  it('adding a food pile on a feature tile does NOT remove the feature', () => {
    const seed = 11;
    const baseline = createWorldState(seed);
    const found = findFirstFeatureTile(baseline, 60, 60);
    expect(found).not.toBeNull();

    const withPile = createWorldState(seed);
    withPile.foodPiles.push({
      foodPileId: 0,
      tileX: found!.x,
      tileY: found!.y,
      pickupsRemaining: 50,
      pickupsInitial: 50,
    });
    expect(surfaceFeatureAt(withPile, found!.x, found!.y)).toEqual(found!.slice);
  });

  it('the baked carve override suppresses the rendered feature on a carved tile (R4-3)', () => {
    // A tile carved passable in bakedSurfaceEffect (root reservation / corridor)
    // must return null from surfaceFeatureAt so render paints no boulder over it,
    // and surfaceMovementAt must read Cosmetic.
    const seed = 42;
    const world = createWorldState(seed);
    const found = findFirstFeatureTile(world, 60, 60);
    expect(found).not.toBeNull();
    world.bakedSurfaceEffect[found!.y * SURFACE_GRID_WIDTH + found!.x] =
      SurfaceMovementEffect.Cosmetic;
    expect(surfaceFeatureAt(world, found!.x, found!.y)).toBeNull();
    expect(surfaceMovementAt(world, found!.x, found!.y)).toBe(SurfaceMovementEffect.Cosmetic);
  });
});

describe('surfaceMovementAt', () => {
  it('returns Cosmetic for a tile with no feature', () => {
    const world = createWorldState(42);
    let emptyX = -1;
    let emptyY = -1;
    outer: for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        if (surfaceFeatureAt(world, x, y) === null) {
          emptyX = x;
          emptyY = y;
          break outer;
        }
      }
    }
    expect(emptyX).toBeGreaterThanOrEqual(0);
    expect(surfaceMovementAt(world, emptyX, emptyY)).toBe(SurfaceMovementEffect.Cosmetic);
  });

  it('returns the slice movement when a feature covers the tile', () => {
    // Walk until we find a covered tile, then assert the helper agrees
    // with the slice's movement field (baked grid == procedural for a bare world).
    const world = createWorldState(42);
    const found = findFirstFeatureTile(world, 60, 60);
    expect(found).not.toBeNull();
    expect(surfaceMovementAt(world, found!.x, found!.y)).toBe(found!.slice.movement);
  });
});

describe('overlap-suppression invariant — UAT "two overlapping rocks" guard', () => {
  it('no tile is ever covered by two distinct same-kind anchors (across many seeds)', () => {
    // UAT round 1 reported "two rocks overlapping each other". The same-
    // type overlap suppression in `isAnchorSuppressedByOverlap` should
    // make this impossible — but that logic was originally written for
    // the smaller 2×2 footprints, and the post-step-3 4×4 (and 5×6
    // BigLeaf, 6×3 Twig) footprints exercise a wider scan window. This
    // test sweeps multiple seeds + a 64×64 region per seed and asserts
    // that no tile resolves to a feature anchored at one position
    // while a different anchor of the SAME kind would also "naturally"
    // anchor at a position whose footprint covers the same tile.
    //
    // If the suppression is broken we'd find two boulder anchors (or
    // two bush anchors, etc.) whose footprints both cover (x, y) but
    // surfaceFeatureAt only returns one — meaning the renderer would
    // see ONE on its own scan and the OTHER on the same-tile re-query
    // depending on which fires first. The right invariant is "for any
    // tile T, walking all anchors that geometrically cover T finds at
    // most one that isn't suppressed".
    for (let seed = 1; seed < 20; seed++) {
      const world = createWorldState(seed);
      // For each tile, find the anchor surfaceFeatureAt picked, then
      // independently scan ALL geometrically-covering anchor candidates
      // and verify none other than the picked one is "alive" (passes
      // probability + overlap suppression + gameplay suppression).
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const slice = surfaceFeatureAt(world, x, y);
          if (slice === null) continue;
          // Walk every position whose footprint could cover (x, y).
          // Window size = MAX footprint = 6×6 (BigLeaf is 5×6, Twig
          // 6×3 — max 6 in either axis).
          let candidatesActive = 0;
          for (let dy = 0; dy < 6; dy++) {
            for (let dx = 0; dx < 6; dx++) {
              const ax = x - dx;
              const ay = y - dy;
              const candSlice = surfaceFeatureAt(world, ax, ay);
              if (candSlice === null) continue;
              // Only count if THIS anchor's own footprint actually
              // includes (x, y). The selector at (ax, ay) might
              // resolve to an anchor at some OTHER position
              // (because (ax, ay) itself is covered by an
              // even-higher-priority anchor); that re-resolution is
              // fine — we only count the direct "anchor-covers-tile"
              // relationship.
              if (
                candSlice.anchorX === ax &&
                candSlice.anchorY === ay &&
                x >= ax &&
                x < ax + candSlice.footprintTilesWide &&
                y >= ay &&
                y < ay + candSlice.footprintTilesTall
              ) {
                candidatesActive++;
              }
            }
          }
          // At most ONE active anchor should claim this tile. More than
          // one means same-type or cross-type overlap suppression failed
          // and two boulders (or whatever kinds) would render on top.
          expect(candidatesActive).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('SURFACE_FEATURES registry contract', () => {
  it('movement effects: Boulder is HardBlock, Bush and GrassClump are SoftCost', () => {
    // The selector's movement field is sourced from the registry. Walking
    // a region and checking each kind's movement keeps the registry
    // contract under test (without exporting the raw registry).
    const world = createWorldState(42);
    const seen = new Map<SurfaceFeatureKind, SurfaceMovementEffect>();
    for (let y = 0; y < 80 && seen.size < 3; y++) {
      for (let x = 0; x < 80 && seen.size < 3; x++) {
        const slice = surfaceFeatureAt(world, x, y);
        if (slice === null) continue;
        if (!seen.has(slice.kind)) seen.set(slice.kind, slice.movement);
      }
    }
    // We may not see all three kinds in 80×80 with one seed, but for
    // any kind we DO see, assert the expected movement.
    if (seen.has(SurfaceFeatureKind.Boulder)) {
      expect(seen.get(SurfaceFeatureKind.Boulder)).toBe(SurfaceMovementEffect.HardBlock);
    }
    if (seen.has(SurfaceFeatureKind.Bush)) {
      expect(seen.get(SurfaceFeatureKind.Bush)).toBe(SurfaceMovementEffect.SoftCost);
    }
    if (seen.has(SurfaceFeatureKind.GrassClump)) {
      expect(seen.get(SurfaceFeatureKind.GrassClump)).toBe(SurfaceMovementEffect.SoftCost);
    }
  });
});

// ---------------------------------------------------------------------------
// PR 4 (Fable review) — load-bearing bake↔selector equivalence + component/
// corridor regression coverage. These were verified out-of-band during PR 4;
// committing them guards the carve-detection invariant against future drift.
// ---------------------------------------------------------------------------

describe('bakeSurfaceEffectGrid ≡ per-tile surfaceFeatureProcedural', () => {
  it('is byte-identical to the per-tile selector across seeds × all 16,384 tiles', () => {
    // surfaceFeatureAt's carve detection rests on baked[idx] ===
    // surfaceFeatureProcedural(...).movement for every un-carved tile; the
    // anchor-iterating bake must reproduce the per-tile selector exactly or
    // carved-vs-procedural desync silently hides sprites over walkable terrain.
    let mismatches = 0;
    for (const seed of [1, 7, 42, 99, 256, 2024]) {
      const w = createWorldState(seed);
      const baked = bakeSurfaceEffectGrid(w);
      for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
        for (let x = 0; x < SURFACE_GRID_WIDTH; x++) {
          const proc = surfaceFeatureProcedural(w, x, y);
          const expected = proc === null ? SurfaceMovementEffect.Cosmetic : proc.movement;
          if (baked[y * SURFACE_GRID_WIDTH + x] !== expected) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
  });
});

describe('computeSurfaceComponentMask', () => {
  it('marks only the region reachable from the root, excluding a walled-off pocket', () => {
    // Hand-built grid: a full-height HardBlock wall at x=64 splits left|right.
    const grid = new Uint8Array(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT);
    for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
      grid[y * SURFACE_GRID_WIDTH + 64] = SurfaceMovementEffect.HardBlock;
    }
    const mask = computeSurfaceComponentMask(grid, 10, 10); // root on the left
    expect(mask[10 * SURFACE_GRID_WIDTH + 10]).toBe(1); // root in component
    expect(mask[10 * SURFACE_GRID_WIDTH + 30]).toBe(1); // same (left) side
    expect(mask[10 * SURFACE_GRID_WIDTH + 64]).toBe(0); // the wall itself
    expect(mask[10 * SURFACE_GRID_WIDTH + 100]).toBe(0); // walled-off right pocket
  });
});

describe('bakeStaticTerrain corridor clears HardBlocks + connects roots (carveCorridor)', () => {
  it('carves through a procedural HardBlock on the corridor row, joining the two roots', () => {
    // carveCorridor clears the PROCEDURAL HardBlock features (via
    // surfaceFeatureProcedural) along the Manhattan path between two roots — so
    // this exercises the real carve on procedural terrain (not an injected wall,
    // which the carve does not recognise). Find a row with a procedural HardBlock
    // in the interior, run a corridor across it, and assert it is cleared and the
    // roots end mutually reachable.
    const world = createWorldState(42);
    const proc = world.bakedSurfaceEffect; // createWorldState bakes the procedural field
    let ry = -1;
    let hx = -1;
    outer: for (let y = 0; y < SURFACE_GRID_HEIGHT; y++) {
      for (let x = 25; x <= 95; x++) {
        if (proc[y * SURFACE_GRID_WIDTH + x] === SurfaceMovementEffect.HardBlock) {
          ry = y;
          hx = x;
          break outer;
        }
      }
    }
    expect(ry).toBeGreaterThanOrEqual(0); // a procedural HardBlock to clear exists
    expect(proc[ry * SURFACE_GRID_WIDTH + hx]).toBe(SurfaceMovementEffect.HardBlock);

    const leftRoot = { tileX: 20, tileY: ry };
    const rightRoot = { tileX: 100, tileY: ry };
    const baked = bakeStaticTerrain(world, [leftRoot, rightRoot]);
    // The HardBlock on the corridor row is cleared by the carve.
    expect(baked[ry * SURFACE_GRID_WIDTH + hx]).not.toBe(SurfaceMovementEffect.HardBlock);
    // Both roots are in one walkable component after the corridor carve.
    const post = computeSurfaceComponentMask(baked, leftRoot.tileX, leftRoot.tileY);
    expect(post[leftRoot.tileY * SURFACE_GRID_WIDTH + leftRoot.tileX]).toBe(1);
    expect(post[rightRoot.tileY * SURFACE_GRID_WIDTH + rightRoot.tileX]).toBe(1);
  });
});
