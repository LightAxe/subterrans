// corpse-food-save.test.ts — A2 (V37) save/load: version-aware foodPile validator +
// hard-cap save-safety (Codex r1 #1 + #3). Lives under src/platform/ because it
// exercises save serialization; the sim/platform boundary forbids src/sim/ test files
// from importing platform/, so these save-round-trip cases can't sit beside the rest of
// the A2 matrix in src/sim/corpse-food.test.ts.

import { describe, it, expect } from 'vitest';
import { serializeWorldState, deserializeWorldState } from './save.js';
import { createScenario } from '../sim/scenario.js';
import { spawnCorpseFood } from '../sim/food-system.js';
import { SIM_VERSION_V36_RISK_AWARE_FORAGING } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { isSurfaceTileInComponent } from '../sim/surface-features.js';
import { FOOD_PILE_HARD_CAP, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from '../sim/constants.js';

/** First `n` walkable-component tiles — load rejects any food pile off the walkable component. */
function walkableTiles(world: WorldState, n: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SURFACE_GRID_HEIGHT && out.length < n; y++) {
    for (let x = 0; x < SURFACE_GRID_WIDTH && out.length < n; x++) {
      if (isSurfaceTileInComponent(world, x, y)) out.push({ x, y });
    }
  }
  return out;
}

describe('A2 version-aware foodPile save validator', () => {
  it('V37: a 1-charge CORPSE pile loads and its isCorpse round-trips', () => {
    const base = createScenario(42);
    const t = base.foodPiles[0]!; // known-walkable tile
    const s = serializeWorldState(base);
    s.foodPiles = [
      {
        foodPileId: t.foodPileId,
        tileX: t.tileX,
        tileY: t.tileY,
        pickupsRemaining: 1,
        pickupsInitial: 1,
        isCorpse: true,
      },
    ];
    const w = deserializeWorldState(s);
    expect(w.foodPiles).toHaveLength(1);
    expect(w.foodPiles[0]!.isCorpse).toBe(true);
    expect(w.foodPiles[0]!.pickupsInitial).toBe(1);
  });

  it('V37: a 1-charge NATURAL pile is rejected (a state the sim cannot generate)', () => {
    const base = createScenario(42);
    const t = base.foodPiles[0]!;
    const s = serializeWorldState(base);
    s.foodPiles = [
      {
        foodPileId: t.foodPileId,
        tileX: t.tileX,
        tileY: t.tileY,
        pickupsRemaining: 1,
        pickupsInitial: 1,
      },
    ];
    expect(() => deserializeWorldState(s)).toThrow();
  });

  it('pre-V37: a 1-charge pile with a smuggled isCorpse:true is rejected', () => {
    const base = createScenario(42);
    const t = base.foodPiles[0]!;
    const s = serializeWorldState(base);
    s.simVersion = SIM_VERSION_V36_RISK_AWARE_FORAGING;
    s.foodPiles = [
      {
        foodPileId: t.foodPileId,
        tileX: t.tileX,
        tileY: t.tileY,
        pickupsRemaining: 1,
        pickupsInitial: 1,
        isCorpse: true,
      },
    ];
    expect(() => deserializeWorldState(s)).toThrow();
  });

  it('V37 honors isCorpse; a pre-V37 load of the same blob drops the flag', () => {
    const base = createScenario(42);
    const t = base.foodPiles[0]!;
    const s = serializeWorldState(base);
    s.foodPiles = [
      {
        foodPileId: t.foodPileId,
        tileX: t.tileX,
        tileY: t.tileY,
        pickupsRemaining: 30,
        pickupsInitial: 30,
        isCorpse: true,
      },
    ];
    expect(deserializeWorldState(s).foodPiles[0]!.isCorpse).toBe(true);
    // Same blob declared pre-V37 → the corpse flag isn't honored; 30 >= MIN so it still
    // loads, as a NATURAL pile.
    s.simVersion = SIM_VERSION_V36_RISK_AWARE_FORAGING;
    expect(deserializeWorldState(s).foodPiles[0]!.isCorpse).toBeUndefined();
  });

  it('a corpse-topped-up natural pile round-trips (stays natural)', () => {
    const base = createScenario(42);
    const t = base.foodPiles[0]!;
    const w = createScenario(42);
    w.foodPiles = [
      {
        foodPileId: t.foodPileId,
        tileX: t.tileX,
        tileY: t.tileY,
        pickupsRemaining: 30,
        pickupsInitial: 30,
      },
    ];
    spawnCorpseFood(w, t.tileX, t.tileY, 100); // top up -> 130, still natural
    const w2 = deserializeWorldState(serializeWorldState(w));
    expect(w2.foodPiles[0]!.pickupsInitial).toBe(130);
    expect(w2.foodPiles[0]!.isCorpse).toBeUndefined();
  });
});

describe('A2 hard-cap save-safety (Codex r1 #1)', () => {
  // The "spawner never grows past FOOD_PILE_HARD_CAP" half of the finding is covered in
  // src/sim/corpse-food.test.ts (it needs a world.tick write, which the sim/platform
  // boundary forbids here). This asserts the other half: a full hard-cap set of corpse
  // piles — the most the drop + spawner can ever accumulate — round-trips through save.
  it('a full FOOD_PILE_HARD_CAP set of corpse piles serializes + deserializes', () => {
    const world = createScenario(42);
    const tiles = walkableTiles(world, FOOD_PILE_HARD_CAP);
    expect(tiles.length).toBe(FOOD_PILE_HARD_CAP);
    world.foodPiles = tiles.map((t, i) => ({
      foodPileId: 1000 + i,
      tileX: t.x,
      tileY: t.y,
      pickupsRemaining: 1,
      pickupsInitial: 1,
      isCorpse: true,
    }));
    const reloaded = deserializeWorldState(serializeWorldState(world));
    expect(reloaded.foodPiles).toHaveLength(FOOD_PILE_HARD_CAP);
  });
});
