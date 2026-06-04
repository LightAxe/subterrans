// bfs-flow-field.ts — shared BFS expansion for tile-graph flow fields.
//
// Issue #87 — chamber-flow.ts, dig-system.ts, and entrance-flow.ts all run
// the same multi-source BFS expansion through Open + BeingDug tiles, with
// the same row/col decode (`(idx / width) | 0`), the same 4-cardinal step
// (N/E/S/W), and the same REVERSE encoding (out[neighbor] = direction
// pointing BACK to the source). Pre-#87 each file had its own copy with its
// own eslint-disable for the row-decode division.
//
// Single-sourced here so:
//   1. The eslint suppression for `(idx / width) | 0` lives in ONE place.
//   2. Bug fixes / micro-optimizations to the expansion propagate.
//   3. New flow fields can be added by writing only the seed step.
//
// What this module does NOT do:
//   - Allocate. Caller pre-fills `out` with -2, marks sources with -1, pushes
//     source indices onto `queue`, and passes the resulting tail pointer.
//   - Choose seed tiles. Each caller has its own seeding rule (chamber
//     footprints, Marked tiles, entrance shafts, brood positions).
//   - Validate input. Caller is responsible for `out`/`queue` length matching
//     `width * height` and `data.length === width * height`.

import { UndergroundTileState } from './terrain.js';

// 4-cardinal step encoding: 0=N, 1=E, 2=S, 3=W. The arrays index by
// direction; REVERSE[d] is the direction at the NEIGHBOR pointing back to
// the cell we expanded from (for flow-field "step toward source" semantics).
const REVERSE = [2, 3, 0, 1] as const;
const NEIGHBOR_DR = [-1, 0, 1, 0] as const;
const NEIGHBOR_DC = [0, 1, 0, -1] as const;

/**
 * Expand a seeded BFS frontier outward through Open + BeingDug tiles,
 * writing the step-direction-toward-source at each reached tile.
 *
 * Caller contract (must hold before this call):
 *   - `out` has length `width * height`. Source tiles are set to -1; all
 *     other tiles must be -2 (sentinel for "unvisited"). This function
 *     writes 0/1/2/3 (REVERSE direction codes) to reached tiles only.
 *   - `queue` has length >= number of reachable tiles. Source indices are
 *     already enqueued at positions `[0, initialTail)`.
 *   - `data` is the underground grid byte array (Uint8Array of
 *     UndergroundTileState values).
 *   - `width` * `height` matches `out.length` and `data.length`.
 *
 * Marked and Solid tiles are walls — BFS does not expand through them.
 * Pre-existing semantic across all three call sites; if any future caller
 * needs a different traversal predicate, take a different helper rather
 * than parameterizing this one.
 */
export function bfsExpandSeededField(
  out: Int32Array,
  queue: Int32Array,
  initialTail: number,
  data: Uint8Array,
  width: number,
  height: number,
): void {
  let head = 0;
  let tail = initialTail;
  while (head < tail) {
    const idx = queue[head++]!;
    // eslint-disable-next-line no-restricted-syntax -- integer division via `| 0`; BFS index→row conversion, not fixed-point math
    const row = (idx / width) | 0;
    const col = idx % width;

    for (let d = 0; d < 4; d++) {
      const nRow = row + NEIGHBOR_DR[d]!;
      const nCol = col + NEIGHBOR_DC[d]!;
      if (nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) continue;

      const nIdx = nRow * width + nCol;
      if (out[nIdx] !== -2) continue;

      const tileState = data[nIdx]!;
      if (tileState !== UndergroundTileState.Open && tileState !== UndergroundTileState.BeingDug) {
        continue;
      }

      out[nIdx] = REVERSE[d]!;
      queue[tail++] = nIdx;
    }
  }
}
