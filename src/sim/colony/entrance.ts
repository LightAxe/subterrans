// entrance.ts — PRD §3 NestEntrance interface
//
// A NestEntrance represents a colony's tunnel opening to the surface.
// isOpen becomes true once both shaft tiles (tileY=0, tileY=1) are
// UndergroundTileState.Open — see ENTRANCE_SHAFT_DEPTH in constants.ts.
//
// Compatible with Node --experimental-strip-types (no const enum, no enums).

// ---------------------------------------------------------------------------
// NestEntranceId — integer alias for readability (PRD §3)
// ---------------------------------------------------------------------------

export type NestEntranceId = number;

// ---------------------------------------------------------------------------
// NestEntrance — colony tunnel entry point (PRD §3)
//
// surfaceTileX / surfaceTileY: position on the surface grid above the shaft.
// isOpen: true once shaft tiles at tileY=0 and tileY=1 are both Open.
// ---------------------------------------------------------------------------

export interface NestEntrance {
  entranceId: NestEntranceId;
  surfaceTileX: number;
  surfaceTileY: number;
  isOpen: boolean; // true once shaft tiles (y=0, y=1) are both Open
}
