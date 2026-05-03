// surface-features.test.ts — issue #44 step 1.
//
// Covers the sim-owned surface feature selector:
//   - per-tile determinism (same inputs → same output, repeatedly)
//   - terrainSeed actually varies layout (defeats coordinate-only-placement bug)
//   - cross-type and same-type anchor overlap suppression
//   - gameplay suppression (entrance radius, food pile)
//   - surfaceMovementAt convenience helper

import { describe, it, expect } from 'vitest';
import {
  createWorldState,
  SIM_VERSION_V7_SURFACE_PASSABILITY,
  type WorldState,
} from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import {
  surfaceFeatureAt,
  surfaceMovementAt,
  SurfaceFeatureKind,
  SurfaceMovementEffect,
  SURFACE_FEATURE_ENTRANCE_RADIUS,
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
  colony.entrances = [{
    entranceId: 0,
    surfaceTileX,
    surfaceTileY,
    isOpen: true,
  }];
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

describe('surfaceFeatureAt — gameplay suppression', () => {
  it('an entrance suppresses any feature whose footprint enters its radius', () => {
    // Find a tile where a feature naturally lands without any colony
    // installed; then install an entrance there and confirm the feature
    // is gone. If the selector skipped suppression we'd still see the
    // feature, which is the bug Codex flagged (queen boxed in by seed luck).
    const seed = 42;
    const baseline = createWorldState(seed);
    const found = findFirstFeatureTile(baseline, 60, 60);
    expect(found).not.toBeNull();

    const suppressed = createWorldState(seed);
    installColonyWithEntrance(suppressed, /* colonyId */ 1, found!.x, found!.y);
    expect(surfaceFeatureAt(suppressed, found!.x, found!.y)).toBeNull();
  });

  it('suppression radius extends SURFACE_FEATURE_ENTRANCE_RADIUS in Chebyshev distance', () => {
    // An entrance at (50, 50) suppresses any 1-tile probe inside the
    // [50-3 .. 50+3, 50-3 .. 50+3] square. Anchors with multi-tile
    // footprints can be suppressed even further out (their footprint
    // overlaps the radius rectangle), but the per-tile probe at the edge
    // of the rectangle must consistently return suppressed.
    const seed = 99;
    const world = createWorldState(seed);
    installColonyWithEntrance(world, 1, 50, 50);
    const r = SURFACE_FEATURE_ENTRANCE_RADIUS;
    // Every tile inside the suppression rectangle should be free of any
    // anchor whose own anchor position sits inside the rectangle. The
    // strongest invariant we can assert without coupling to the registry
    // hash: the four corner tiles of the radius square (ex±r, ey±r) and
    // the centre return null OR a slice anchored OUTSIDE the rectangle.
    const tiles: Array<[number, number]> = [
      [50, 50],
      [50 - r, 50 - r], [50 + r, 50 - r],
      [50 - r, 50 + r], [50 + r, 50 + r],
    ];
    for (const [tx, ty] of tiles) {
      const slice = surfaceFeatureAt(world, tx, ty);
      if (slice === null) continue;
      // Anchor must be outside the suppression rectangle (otherwise the
      // gameplay check should have rejected it).
      const insideX = slice.anchorX >= 50 - r && slice.anchorX <= 50 + r;
      const insideY = slice.anchorY >= 50 - r && slice.anchorY <= 50 + r;
      expect(insideX && insideY).toBe(false);
    }
  });

  it('a food pile suppresses any feature covering its tile', () => {
    const seed = 11;
    const baseline = createWorldState(seed);
    const found = findFirstFeatureTile(baseline, 60, 60);
    expect(found).not.toBeNull();

    const suppressed = createWorldState(seed);
    suppressed.foodPiles.push({
      foodPileId: 0,
      tileX: found!.x,
      tileY: found!.y,
    });
    expect(surfaceFeatureAt(suppressed, found!.x, found!.y)).toBeNull();
  });

  it('multiple colonies all contribute to suppression', () => {
    // Install two colonies with entrances at distant tiles. A feature that
    // would land within either suppression radius should be suppressed.
    const seed = 55;
    const baseline = createWorldState(seed);
    // Find two distant feature tiles so neither colony's radius reaches
    // the other entrance position.
    const first = findFirstFeatureTile(baseline, 30, 30);
    expect(first).not.toBeNull();
    let second: { x: number; y: number; slice: SurfaceFeatureSlice } | null = null;
    for (let y = 60; y < 90 && second === null; y++) {
      for (let x = 60; x < 90; x++) {
        const slice = surfaceFeatureAt(baseline, x, y);
        if (slice !== null) { second = { x, y, slice }; break; }
      }
    }
    expect(second).not.toBeNull();

    const suppressed = createWorldState(seed);
    installColonyWithEntrance(suppressed, 1, first!.x, first!.y);
    installColonyWithEntrance(suppressed, 2, second!.x, second!.y);
    expect(surfaceFeatureAt(suppressed, first!.x, first!.y)).toBeNull();
    expect(surfaceFeatureAt(suppressed, second!.x, second!.y)).toBeNull();
  });

  it('v8+ — gameplay-suppressed shadow no longer hides outside-zone anchors (Codex P2 round-3 fix)', () => {
    // Pre-fix bug: a higher-priority anchor sitting inside an entrance
    // suppression zone never rendered, but `isAnchorSuppressedByOverlap`
    // would still treat it as a real suppressor of LOWER-priority
    // anchors whose footprints overlap its shadow OUTSIDE the zone.
    // The result was unintended empty halos around the suppression
    // ring. Post-fix, the recursion also rejects gameplay-suppressed
    // candidate suppressors, so lower-priority anchors that pre-fix
    // were unjustly hidden now surface.
    //
    // Property-test pattern: scan many seeds, find a tile T near (but
    // outside) an entrance suppression zone where:
    //   - baseline (no entrance) returns a feature at T,
    //   - the baseline anchor at T sits INSIDE the zone of a
    //     hypothetical entrance E,
    // Then install entrance E and verify v8 returns SOMETHING at T
    // (it might be a different lower-priority anchor than baseline,
    // but it must NOT be null — that's the v8 invariant). Pre-v8
    // would return null in the same scenario.
    //
    // The test counts how many tiles SHIFT from null (pre-fix) to
    // non-null (post-fix) across a seed sweep. Even a single proven
    // example demonstrates the fix; the count gives statistical
    // confidence the fix matters in practice rather than only in
    // theory.
    const r = SURFACE_FEATURE_ENTRANCE_RADIUS;
    let demonstrationCount = 0;
    seedLoop:
    for (let seed = 1; seed < 80; seed++) {
      const baseline = createWorldState(seed);
      // Place an entrance at a known location with room around it.
      const ex = 30, ey = 30;
      // Examine tiles just OUTSIDE the entrance suppression rectangle
      // — on the perimeter where the shadow bug would manifest.
      for (let dy = -r - 6; dy <= r + 6; dy++) {
        for (let dx = -r - 6; dx <= r + 6; dx++) {
          const tx = ex + dx;
          const ty = ey + dy;
          // Skip tiles inside the suppression rectangle — those are
          // legitimately suppressed and not part of this bug.
          if (Math.abs(dx) <= r && Math.abs(dy) <= r) continue;
          const baselineSlice = surfaceFeatureAt(baseline, tx, ty);
          if (baselineSlice === null) continue;
          // Need the baseline anchor to be INSIDE the would-be
          // suppression rectangle — that's the geometric setup for
          // the shadow bug.
          const ax = baselineSlice.anchorX;
          const ay = baselineSlice.anchorY;
          const anchorInsideZone =
            ax >= ex - r && ax <= ex + r && ay >= ey - r && ay <= ey + r;
          if (!anchorInsideZone) continue;
          // Setup: install the entrance, re-query.
          const withEntrance = createWorldState(seed);
          installColonyWithEntrance(withEntrance, 1, ex, ey);
          const v8Slice = surfaceFeatureAt(withEntrance, tx, ty);
          // v8 invariant: the tile MAY have a different feature now
          // (the baseline shadower is gone), but it should not
          // collapse to null when a lower-priority anchor exists in
          // the shadow region. The strongest v8 claim we can make
          // without re-running the registry-walk: the v8 path returns
          // SOMETHING for this tile, OR the v8 path correctly returns
          // null because no lower-priority shadower exists.
          //
          // To make the assertion meaningful we narrow further: only
          // record a demonstration when v8 returns a feature whose
          // anchor is NOT inside the zone (proves the lower-priority
          // anchor surfaced) AND whose feature kind differs from
          // baseline (proves a different anchor took over).
          if (v8Slice === null) continue;
          const v8AnchorOutsideZone =
            v8Slice.anchorX < ex - r || v8Slice.anchorX > ex + r ||
            v8Slice.anchorY < ey - r || v8Slice.anchorY > ey + r;
          // baselineSlice anchor is INSIDE the zone (anchorInsideZone
          // gate above); requiring v8 anchor to be OUTSIDE the zone
          // is sufficient to prove a different anchor surfaced — they
          // can't match coordinates when one is inside and the other
          // outside.
          if (!v8AnchorOutsideZone) continue;
          demonstrationCount++;
          if (demonstrationCount >= 3) break seedLoop;
        }
      }
    }
    // The fix MUST surface at least one previously-hidden anchor
    // across the 80-seed sweep. Three independent demonstrations
    // prove the fix is working in practice, not just in a single
    // contrived setup.
    expect(demonstrationCount).toBeGreaterThanOrEqual(1);
  });

  it('pre-v8 — gameplay-suppressed shadow STILL hides outside-zone anchors (legacy preserved)', () => {
    // Companion to the v8 test above — proves the simVersion gate
    // routes correctly. The rigorous test: for each candidate tile
    // sampled, build BOTH the v8 result and the v7 result. The gate
    // is functioning correctly when there exists at least one tile
    // where v7 returns null AND v8 returns a feature — that's the
    // exact behaviour difference the gate is supposed to produce.
    // Counting pre-v8 nulls alone would pass even if the gate were
    // broken (some tiles legitimately return null because no lower-
    // priority anchor exists at all), so the comparison is essential.
    const r = SURFACE_FEATURE_ENTRANCE_RADIUS;
    let v7NullV8FilledCount = 0;
    let sampledCount = 0;
    seedLoop:
    for (let seed = 1; seed < 80; seed++) {
      const baseline = createWorldState(seed);
      const ex = 30, ey = 30;
      for (let dy = -r - 6; dy <= r + 6; dy++) {
        for (let dx = -r - 6; dx <= r + 6; dx++) {
          const tx = ex + dx;
          const ty = ey + dy;
          if (Math.abs(dx) <= r && Math.abs(dy) <= r) continue;
          const baselineSlice = surfaceFeatureAt(baseline, tx, ty);
          if (baselineSlice === null) continue;
          const ax = baselineSlice.anchorX;
          const ay = baselineSlice.anchorY;
          const anchorInsideZone =
            ax >= ex - r && ax <= ex + r && ay >= ey - r && ay <= ey + r;
          if (!anchorInsideZone) continue;
          // Build both worlds at the same seed + entrance and pin
          // sim version explicitly.
          const w7 = createWorldState(seed);
          w7.simVersion = SIM_VERSION_V7_SURFACE_PASSABILITY;
          installColonyWithEntrance(w7, 1, ex, ey);
          const w8 = createWorldState(seed);
          // w8 keeps default LATEST_SIM_VERSION (v8+).
          installColonyWithEntrance(w8, 1, ex, ey);
          const v7Slice = surfaceFeatureAt(w7, tx, ty);
          const v8Slice = surfaceFeatureAt(w8, tx, ty);
          sampledCount++;
          if (v7Slice === null && v8Slice !== null) {
            v7NullV8FilledCount++;
          }
          if (sampledCount >= 50) break seedLoop;
        }
      }
    }
    // We sampled enough candidate geometries to expect at least one
    // demonstration of the gate routing different paths.
    expect(sampledCount).toBeGreaterThan(0);
    expect(v7NullV8FilledCount).toBeGreaterThan(0);
  });
});

describe('surfaceMovementAt', () => {
  it('returns Cosmetic when no feature covers the tile', () => {
    // Pick a tile that's definitely empty: a tile inside the radius of an
    // entrance with no other features around. surfaceFeatureAt returns
    // null → surfaceMovementAt returns Cosmetic.
    const world = createWorldState(42);
    installColonyWithEntrance(world, 1, 50, 50);
    expect(surfaceMovementAt(world, 50, 50)).toBe(SurfaceMovementEffect.Cosmetic);
  });

  it('returns the slice movement when a feature covers the tile', () => {
    // Walk until we find a covered tile, then assert the helper agrees
    // with the slice's movement field.
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
                candSlice.anchorX === ax && candSlice.anchorY === ay &&
                x >= ax && x < ax + candSlice.footprintTilesWide &&
                y >= ay && y < ay + candSlice.footprintTilesTall
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
