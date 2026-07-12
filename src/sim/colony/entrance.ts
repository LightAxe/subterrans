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

/**
 * #209 PR A — the OPEN entrance an ant sheltering at surface column `atTileX`
 * would ASCEND through: the FIRST open entrance whose `surfaceTileX === atTileX`.
 * Returns the entrance reference (or `null` if the column has no open entrance).
 * Allocation-free (returns an element of `entrances`, no new object).
 *
 * Column-match, NOT nearest-by-distance, and this is load-bearing: a sheltering
 * ant only knows its shaft COLUMN, and the ascent in ant-movement.ts matches by
 * `surfaceTileX === tileX` (first open entrance in `entrances` order) and emerges
 * at that entrance's `surfaceTileY`. This helper mirrors that selection exactly,
 * so the poke-head-out samples DangerTrail at the entrance the ant will really
 * ascend through. Sampling a Manhattan-nearest entrance in a DIFFERENT column
 * could clear the shelter timer off a safe entrance the ant never uses, sending
 * it back up through its own still-camped column entrance (#209 PR A, Codex P2).
 */
export function pickOpenEntranceAtColumn(
  entrances: readonly NestEntrance[],
  atTileX: number,
): NestEntrance | null {
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (ent.isOpen && ent.surfaceTileX === atTileX) return ent;
  }
  return null;
}
