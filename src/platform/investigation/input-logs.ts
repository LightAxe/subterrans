// input-logs.ts — fixed, deterministic command schedules that drive the
// underground systems an empty tick stream never exercises (plan Phase 0 §1,
// P1-12: "empty ticks won't reproduce #128").
//
// Each builder returns a `SimCommand[][]` indexed by tick — the same shape
// `tick(world, commandsPerTick[t] ?? [])` consumes. AI construction in the
// shipped game is render-side (`src/render/ai-controller.ts`); the pure-sim
// harness reproduces the same command vocabulary here so the investigation
// stays inside `src/sim` + `src/platform` with no render dependency.
//
// Commands are pure data; building a log allocates no world state and is
// independent of seed, so the same log replays identically across seeds.

import type { SimCommand } from '../../sim/commands.js';
import type { ColonyId } from '../../sim/colony/colony-store.js';
import { ChamberType } from '../../sim/enums.js';
import { PLAYER_COLONY_ID, PLAYER_START_X } from '../../sim/constants.js';

/** Convenience: place a command array at tick `t`, growing the outer array. */
function at(log: SimCommand[][], t: number, cmds: SimCommand[]): void {
  while (log.length <= t) log.push([]);
  log[t] = cmds;
}

/** An empty log of length `ticks` — pure surface/auto behaviour (the #127 base
 *  case: foragers search with no player intervention). */
export function emptyLog(ticks: number): SimCommand[][] {
  const log: SimCommand[][] = [];
  while (log.length < ticks) log.push([]);
  return log;
}

/**
 * Construction log for the PLAYER colony: drives dig-marking, chamber
 * excavation, a second entrance designation, descent (diggers descend to
 * reach Marked tiles), and a mid-excavation dig cancellation.
 *
 * The cancellation (CancelDigMark on a still-Marked footprint tile) is the
 * lever for the #128 class-iv probe: `tick.ts` reverts Marked→Solid with no
 * occupancy check, so a digger standing on that tile becomes embedded.
 *
 * Coordinates target the player's start column (PLAYER_START_X = 24); the
 * starting entrance shaft (24, y=0..1) is pre-Open, everything below is Solid.
 */
export function playerConstructionLog(ticks: number): SimCommand[][] {
  const log: SimCommand[][] = [];
  const colonyId = PLAYER_COLONY_ID as ColonyId;
  const col = PLAYER_START_X;

  // 1) Mark a vertical shaft of Solid tiles below the pre-open shaft so diggers
  //    have a dig target and descend to reach it. y=2..8 are Solid at t0.
  const shaftMarks: SimCommand[] = [];
  for (let y = 2; y <= 8; y++) {
    shaftMarks.push({ type: 'MarkDigTile', colonyId, tileX: col, tileY: y, issuedAtTick: 5 });
  }
  at(log, 5, shaftMarks);

  // 2) Place a FoodStorage chamber (4×3) anchored at the bottom of the shaft so
  //    its footprint tiles get auto-Marked and excavated by routed diggers.
  at(log, 30, [
    {
      type: 'PlaceChamber',
      colonyId,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: col - 1,
      anchorTileY: 9,
      issuedAtTick: 30,
    },
  ]);

  // 3) Designate a second entrance a few columns east (exercises entrance
  //    designation + the surface-feature suppression that designation triggers,
  //    and gives the static-terrain oracle an entrance event to hash around).
  at(log, 60, [
    {
      type: 'DesignateEntrance',
      colonyId,
      surfaceTileX: col + 6,
      surfaceTileY: 64,
      issuedAtTick: 60,
    },
  ]);

  // 4) Mid-excavation cancellation: revert a still-Marked footprint tile while
  //    a digger may be standing on / routing through it (class-iv probe). The
  //    chamber footprint spans (col-1 .. col+2, y=9..11); cancel an interior
  //    tile. Issued late enough that diggers have descended and are working.
  at(log, 220, [
    { type: 'CancelDigMark', colonyId, tileX: col, tileY: 10, issuedAtTick: 220 },
    { type: 'CancelDigMark', colonyId, tileX: col + 1, tileY: 10, issuedAtTick: 220 },
  ]);

  while (log.length < ticks) log.push([]);
  return log;
}
