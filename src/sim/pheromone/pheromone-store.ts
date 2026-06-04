// pheromone-store.ts — PRD §5a pheromone grid data structure
//
// Provides a flat Int32Array grid with row-major layout, bounds-checked
// accessors, and a canonical key constructor for WorldState.pheromoneGrids.
//
// MUST NOT import Phaser, DOM, or any rendering dependency.
// No Math.floor — index expression uses | 0 per PRD §5a line 278/282.
// No division operator in index arithmetic.

// ---------------------------------------------------------------------------
// Zone — terrain layer classification for pheromone grids
// ---------------------------------------------------------------------------

/** String literal union for the two terrain zones per PRD §5a. */
export type Zone = 'surface' | 'underground';

// ---------------------------------------------------------------------------
// PheromoneGrid — flat Int32Array with row-major layout (PRD §5a)
// ---------------------------------------------------------------------------

/**
 * A 2-D pheromone intensity grid stored as a flat Int32Array in row-major
 * order.  Cell (x, y) is at index (y * width + x).
 *
 * All fields are readonly — mutate only via phSet().
 */
export interface PheromoneGrid {
  readonly data: Int32Array;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Allocate a zero-initialised PheromoneGrid of the given dimensions.
 * Int32Array is zero-initialised by the spec, so no explicit fill is needed.
 */
export function createPheromoneGrid(width: number, height: number): PheromoneGrid {
  return {
    data: new Int32Array(width * height),
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Accessors — verbatim PRD §5a
// ---------------------------------------------------------------------------

/**
 * Read cell (x, y) from grid g.
 * Returns 0 for any out-of-bounds coordinate — never throws.
 * Index expression uses | 0 per PRD §5a line 278.
 */
export function phGet(g: PheromoneGrid, x: number, y: number): number {
  if (x < 0 || x >= g.width || y < 0 || y >= g.height) return 0;
  // Non-null assertion is safe: bounds already checked above.
  // noUncheckedIndexedAccess requires `!` for TypedArray element access.
  return g.data[(y * g.width + x) | 0]!;
}

/**
 * Write v to cell (x, y) in grid g.
 * Silent no-op for any out-of-bounds coordinate — never throws.
 * Index expression uses | 0 per PRD §5a line 282.
 */
export function phSet(g: PheromoneGrid, x: number, y: number, v: number): void {
  if (x < 0 || x >= g.width || y < 0 || y >= g.height) return;
  g.data[(y * g.width + x) | 0] = v;
}

// ---------------------------------------------------------------------------
// Key constructor — PRD §5a line 287
// ---------------------------------------------------------------------------

/**
 * Build the canonical WorldState.pheromoneGrids map key.
 *
 * Format: `${colonyId}:${type}:${zone}`
 * Examples:
 *   pheromoneGridKey(1, PheromoneType.FoodTrail,   'surface')      → '1:0:surface'
 *   pheromoneGridKey(2, PheromoneType.DangerTrail, 'underground')  → '2:1:underground'
 *
 * @param colonyId  Integer colony identifier.
 * @param type      Numeric PheromoneType value (PheromoneType.FoodTrail = 0,
 *                  PheromoneType.DangerTrail = 1).  Accepts plain number so
 *                  call sites can pass the object-const value directly without
 *                  a branded import in this leaf module.
 * @param zone      Terrain layer: 'surface' or 'underground'.
 */
export function pheromoneGridKey(colonyId: number, type: number, zone: Zone): string {
  return `${colonyId}:${type}:${zone}`;
}
