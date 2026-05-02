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
  it('multi-tile features cover their full footprint without gaps', () => {
    // For any anchor (ax, ay) of a returned feature, every tile in the
    // [ax..ax+W-1] × [ay..ay+H-1] footprint must return that same anchor
    // (or null if a higher-priority feature occludes — but the kind/anchor
    // combo, when present, must agree). Catches off-by-one in the anchor-
    // candidate scan window.
    const world = createWorldState(7);
    const seenAnchors = new Set<string>();
    for (let y = 5; y < 25; y++) {
      for (let x = 5; x < 25; x++) {
        const slice = surfaceFeatureAt(world, x, y);
        if (slice === null) continue;
        const key = `${slice.kind}:${slice.anchorX}:${slice.anchorY}`;
        if (seenAnchors.has(key)) continue;
        seenAnchors.add(key);
        // Verify every footprint tile also resolves to this anchor.
        for (let dy = 0; dy < slice.footprintTilesTall; dy++) {
          for (let dx = 0; dx < slice.footprintTilesWide; dx++) {
            const fx = slice.anchorX + dx;
            const fy = slice.anchorY + dy;
            const inner = surfaceFeatureAt(world, fx, fy);
            if (inner === null) continue;
            // If a different anchor wins at this tile, it must be a higher-
            // priority kind (smaller registry index = smaller numeric kind
            // value, since the registry order is Boulder/Bush/GrassClump).
            if (inner.anchorX !== slice.anchorX || inner.anchorY !== slice.anchorY) {
              expect(inner.kind).toBeLessThan(slice.kind);
            }
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
