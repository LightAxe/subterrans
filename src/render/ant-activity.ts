// ant-activity.ts — Pure helpers for the HUD ant-activity breakdown popup.
//
// Backlog item: "HUD stats should support an ant-activity breakdown popup."
// Clicking the `Ants` HUD stat opens a small colony-status panel that explains
// what the colony is actually doing right now, so the player can answer
// "where did my ants go?" and "why is the colony starving / not digging?"
// without internal debug tools.
//
// Headline vs popup — deliberate split:
//   - HUD headline (`computeHudStats.antCount`) is unchanged: workers +
//     (queen alive ? 1 : 0). Brood stays OUT so the top-line number remains
//     "capable ants right now".
//   - This module's `capableAnts` mirrors that definition; eggs + larvae
//     live only inside the popup so curious players can see them without
//     the headline number lying about usable headcount.
//
// Worker bucket mapping:
//   - Foraging.SearchingFood          -> foraging.searching
//   - Foraging.CarryingFood           -> foraging.carrying
//   - Foraging.ReturningToNest        -> foraging.returning
//       (the 09 excursion-foraging memo made ReturningToNest a real, visible
//        sim state — ants that ran past their search leash without finding
//        food now explicitly walk home to reset. Surfacing this lets the
//        player see "my foragers are empty-handed on the way back" vs.
//        "my foragers are delivering", which are meaningfully different.)
//   - Digging.MovingToTile            -> digging.movingToSite
//   - Digging.Excavating              -> digging.excavating
//   - Fighting (any sub)              -> fighting
//   - Nursing (any sub)               -> nursing
//   - Idle (or unknown task value)    -> idle
//
// Pure + Node-testable: no Phaser imports.

import type { WorldState } from '../sim/types.js';
import type { ColonyRecord } from '../sim/colony/colony-store.js';
import { isAlive } from '../sim/ant/ant-store.js';
import { AntTask, ForagingSubState, DiggingSubState } from '../sim/enums.js';
import type { HudRect } from './hud-layout.js';

export interface ForagingBreakdown {
  searching: number;
  returning: number;
  carrying: number;
  total: number;
}

export interface DiggingBreakdown {
  movingToSite: number;
  excavating: number;
  total: number;
}

export interface AntActivity {
  capableAnts: number;
  queenAlive: boolean;
  eggs: number;
  larvae: number;
  foraging: ForagingBreakdown;
  digging: DiggingBreakdown;
  fighting: number;
  nursing: number;
  idle: number;
  totalWorkers: number;
}

export function computeAntActivity(world: WorldState, colony: ColonyRecord): AntActivity {
  const ants = world.ants;
  const queenAlive = isAlive(ants, colony.queenEntityId);

  let searching = 0;
  let returning = 0;
  let carrying = 0;
  let movingToSite = 0;
  let excavating = 0;
  let fighting = 0;
  let nursing = 0;
  let idle = 0;
  let workers = 0;

  for (let i = 0; i < colony.workers.length; i++) {
    const id = colony.workers[i]!;
    if (!isAlive(ants, id)) continue;
    workers += 1;

    const task = ants.task[id]!;
    const sub = ants.subTask[id]!;

    if (task === AntTask.Foraging) {
      if (sub === ForagingSubState.CarryingFood) {
        carrying += 1;
      } else if (sub === ForagingSubState.ReturningToNest) {
        returning += 1;
      } else {
        searching += 1;
      }
    } else if (task === AntTask.Digging) {
      if (sub === DiggingSubState.Excavating) {
        excavating += 1;
      } else {
        movingToSite += 1;
      }
    } else if (task === AntTask.Fighting) {
      fighting += 1;
    } else if (task === AntTask.Nursing) {
      nursing += 1;
    } else {
      idle += 1;
    }
  }

  return {
    capableAnts: workers + (queenAlive ? 1 : 0),
    queenAlive,
    eggs: colony.eggCount,
    larvae: colony.larvaeCount,
    foraging: {
      searching,
      returning,
      carrying,
      total: searching + returning + carrying,
    },
    digging: { movingToSite, excavating, total: movingToSite + excavating },
    fighting,
    nursing,
    idle,
    totalWorkers: workers,
  };
}

/**
 * Produce the human-readable text lines shown inside the popup, in order.
 * Pure string formatting so the output is deterministic and unit-testable
 * without a Phaser scene. UIScene joins these with '\n' and renders them
 * as a single multi-line Text widget.
 */
export function formatAntActivityLines(a: AntActivity): string[] {
  const queenLine = a.queenAlive ? '  Queen: alive' : '  Queen: dead';
  return [
    `Capable ants: ${a.capableAnts}`,
    queenLine,
    `  Workers: ${a.totalWorkers}`,
    '',
    `Brood:`,
    `  Eggs:   ${a.eggs}`,
    `  Larvae: ${a.larvae}`,
    '',
    `Worker activity:`,
    `  Foraging: ${a.foraging.total}`,
    `    searching: ${a.foraging.searching}`,
    `    returning: ${a.foraging.returning}`,
    `    carrying:  ${a.foraging.carrying}`,
    `  Digging:  ${a.digging.total}`,
    `    moving:    ${a.digging.movingToSite}`,
    `    digging:   ${a.digging.excavating}`,
    `  Fighting: ${a.fighting}`,
    `  Nursing:  ${a.nursing}`,
    `  Idle:     ${a.idle}`,
  ];
}

// ---------------------------------------------------------------------------
// Panel layout
// ---------------------------------------------------------------------------

/**
 * Fixed screen rect the popup renders into, derived from the passed stats rect
 * (hud.STATS). Anchored just below the stats bar (top-left), wide enough to hold
 * the longest formatted line without clipping (`  carrying:  NN` at 10px
 * monospace), tall enough for the 19 lines in `formatAntActivityLines` plus
 * padding. At the default 800×592 layout (stats = {x:8, y:8, w:200, h:24}) this
 * yields the former `ANT_ACTIVITY_PANEL` constant: {x:8, y:36, w:220, h:264}.
 *
 * Used by `isPointerOverHUD` (camera-input) so clicks inside the panel don't
 * fall through to the world while it is visible.
 */
export function antActivityPanelRect(stats: HudRect): HudRect {
  return {
    x: stats.x,
    y: stats.y + stats.h + 4,
    w: 220,
    h: 264,
  };
}

export const ANT_ACTIVITY_PANEL_COLORS = {
  background: 0x000000,
  backgroundAlpha: 0.78,
  border: 0x444444,
  textCss: '#ffffff',
} as const;
