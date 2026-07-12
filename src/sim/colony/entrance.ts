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
 * #209 PR A — nearest OPEN entrance to a surface tile, by Manhattan distance
 * with lower `entranceId` breaking ties. Returns the entrance reference (or
 * `null` if none qualifies) — allocation-free (no new object, returns an element
 * of `entrances`). OPEN-ONLY: unlike the movement/queen fallbacks that may accept
 * a designated-but-closed shaft for Diggers, a fleeing/milling worker must never
 * target a closed entrance it cannot descend. Semantics match the inline surface
 * nearest-open loop in ant-movement.ts.
 *
 * DANGER-unaware by design: the flee path needs the nearest *safe* entrance, but
 * that scan is inlined in `idle-reserve.ts` (`pickNearestSafeEntrance`) to stay
 * allocation-free in the per-worker hot loop rather than passing a predicate
 * here — so this helper deliberately has no filter parameter.
 */
export function pickNearestOpenEntrance(
  entrances: readonly NestEntrance[],
  fromTileX: number,
  fromTileY: number,
): NestEntrance | null {
  let best: NestEntrance | null = null;
  let bestDist = -1;
  for (let e = 0; e < entrances.length; e++) {
    const ent = entrances[e]!;
    if (!ent.isOpen) continue;
    const dist = Math.abs(ent.surfaceTileX - fromTileX) + Math.abs(ent.surfaceTileY - fromTileY);
    if (
      bestDist < 0 ||
      dist < bestDist ||
      (dist === bestDist && best !== null && ent.entranceId < best.entranceId)
    ) {
      bestDist = dist;
      best = ent;
    }
  }
  return best;
}
