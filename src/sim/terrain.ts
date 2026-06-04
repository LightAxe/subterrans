// terrain.ts — PRD §1 terrain grid types and accessors for src/sim/
//
// Pattern: object-const + type alias (established in enums.ts, Phase 5/6).
// This pattern is PRD-normative and compatible with:
//   - Vite/esbuild bundling
//   - Node --experimental-strip-types headless tests
//   - isolatedModules: true
//
// DO NOT use `const enum` or ordinary `enum` declarations.
// DO NOT import Phaser, DOM, or any non-sim module.

// ---------------------------------------------------------------------------
// Zone — identifies which grid a coordinate belongs to (PRD §1)
// ---------------------------------------------------------------------------

export const Zone = {
  Surface: 0,
  Underground: 1,
} as const;
export type Zone = (typeof Zone)[keyof typeof Zone];

// ---------------------------------------------------------------------------
// SurfaceTileState — tile content on the surface grid (PRD §1)
// ---------------------------------------------------------------------------

export const SurfaceTileState = {
  Grass: 0,
  Dirt: 1,
} as const;
export type SurfaceTileState = (typeof SurfaceTileState)[keyof typeof SurfaceTileState];

// ---------------------------------------------------------------------------
// UndergroundTileState — tile content in the underground grid (PRD §1)
// ---------------------------------------------------------------------------

export const UndergroundTileState = {
  Solid: 0,
  Marked: 1,
  BeingDug: 2,
  Open: 3,
} as const;
export type UndergroundTileState = (typeof UndergroundTileState)[keyof typeof UndergroundTileState];

// ---------------------------------------------------------------------------
// SurfaceGrid — 2D row-major Uint8Array grid for surface tiles (PRD §1)
//
// Layout: index = tileY * width + tileX
// Zero-initialized = all SurfaceTileState.Grass (0)
// ---------------------------------------------------------------------------

export interface SurfaceGrid {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// UndergroundGrid — 2D row-major Uint8Array grid for underground tiles (PRD §1)
//
// Layout: index = tileY * width + tileX
// Zero-initialized = all UndergroundTileState.Solid (0)
// ---------------------------------------------------------------------------

export interface UndergroundGrid {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Creates a new SurfaceGrid of the given dimensions.
 * All tiles initialize to SurfaceTileState.Grass (0).
 *
 * @param width  — tile width of the grid (typically SURFACE_GRID_WIDTH)
 * @param height — tile height of the grid (typically SURFACE_GRID_HEIGHT)
 */
export function createSurfaceGrid(width: number, height: number): SurfaceGrid {
  return {
    data: new Uint8Array(width * height),
    width,
    height,
  };
}

/**
 * Creates a new UndergroundGrid of the given dimensions.
 * All tiles initialize to UndergroundTileState.Solid (0).
 *
 * @param width  — tile width of the grid (typically UNDERGROUND_GRID_WIDTH)
 * @param height — tile height of the grid (typically UNDERGROUND_GRID_HEIGHT)
 */
export function createUndergroundGrid(width: number, height: number): UndergroundGrid {
  return {
    data: new Uint8Array(width * height),
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Accessor functions — row-major index: tileY * width + tileX
// ---------------------------------------------------------------------------

/**
 * Reads a tile state from a SurfaceGrid.
 */
export function sgGet(grid: SurfaceGrid, tileX: number, tileY: number): SurfaceTileState {
  return grid.data[tileY * grid.width + tileX] as SurfaceTileState;
}

/**
 * Writes a tile state to a SurfaceGrid.
 * Note: `readonly data` prevents reassignment of the array reference,
 * but Uint8Array element writes are allowed.
 */
export function sgSet(
  grid: SurfaceGrid,
  tileX: number,
  tileY: number,
  state: SurfaceTileState,
): void {
  grid.data[tileY * grid.width + tileX] = state;
}

/**
 * Reads a tile state from an UndergroundGrid.
 */
export function ugGet(grid: UndergroundGrid, tileX: number, tileY: number): UndergroundTileState {
  return grid.data[tileY * grid.width + tileX] as UndergroundTileState;
}

/**
 * Writes a tile state to an UndergroundGrid.
 */
export function ugSet(
  grid: UndergroundGrid,
  tileX: number,
  tileY: number,
  state: UndergroundTileState,
): void {
  grid.data[tileY * grid.width + tileX] = state;
}
