// chamber.ts — PRD §2d PendingChamber interface and CHAMBER_DIMENSIONS constant
//
// PendingChamber has NO chamberId — the PRD keys pending chambers by
// `${colonyId}:${anchorTileX}:${anchorTileY}` in a Record.
//
// CHAMBER_DIMENSIONS maps ChamberType (0|1|2) to { width, height }.
// Uses numeric keys [0], [1], [2] because ChamberType values are 0|1|2
// from the object-const pattern in enums.ts.
//
// Compatible with Node --experimental-strip-types (no const enum, no enums).

import type { ChamberType } from '../enums.js';
import type { ColonyId } from './colony-store.js';

// ---------------------------------------------------------------------------
// PendingChamber — a chamber queued for excavation (PRD §2d)
//
// anchorTileX / anchorTileY: top-left tile position in the underground grid.
// No chamberId: identity is derived from colonyId + anchor position.
// ---------------------------------------------------------------------------

export interface PendingChamber {
  colonyId: ColonyId;
  chamberType: ChamberType;
  anchorTileX: number; // top-left tile X in underground grid
  anchorTileY: number; // top-left tile Y in underground grid
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// CHAMBER_DIMENSIONS — PRD §2d canonical chamber sizes
//
// ChamberType values: 0 = Queen, 1 = Nursery, 2 = FoodStorage
// ---------------------------------------------------------------------------

export const CHAMBER_DIMENSIONS: Record<ChamberType, { width: number; height: number }> = {
  [0]: { width: 5, height: 3 }, // Queen:       5×3
  [1]: { width: 4, height: 3 }, // Nursery:     4×3
  [2]: { width: 4, height: 3 }, // FoodStorage: 4×3
};
