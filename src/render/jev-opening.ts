// jev-opening.ts — the code-owned opening the Jev opponent plays before it starts
// asking Jev anything.
//
// Rationale (validated in the spike): the first few thousand ticks are a solved
// build order and spending model beats on it produced worse colonies and burned
// latency budget. What changed since: the opening used to *replay* the
// rule-based AI's own helpers, which meant it also inherited the AI's tempo —
// dig a shaft ~18 rows deep five tiles at a time, place Queen, then
// FoodStorage, then Nursery, and only hand off once all three had finished
// excavating (tick ~3,500-4,500, three real minutes of a round in which Jev
// never got a say).
//
// A human does not play like that. They draw the whole nest on the first
// screen and let the colony catch up, because the command surface allows it:
//   - `MarkDigTile` has no reachability requirement at all, so the entire
//     entrance shaft can be marked on tick 0.
//   - `PlaceChamber` (v5+) accepts an anchor on Solid or Marked dirt as long as
//     the footprint would be connected once every Marked / BeingDug tile is
//     excavated — `isFootprintReachableAfterDigs` in tick.ts. A chamber beside
//     a freshly-marked shaft column qualifies.
// So this module PLANS: one vertical spine below the entrance, the Queen
// chamber hung off the bottom of it, the Nursery and the first FoodStorage off
// the top, all committed within the first couple of ticks. The single digger
// then works the plan in the background while Jev plays the actual game.
//
// Handoff is therefore "the nest is PLANNED", not "the nest is built":
// `isOpeningPlanned` is true as soon as all three chambers exist as pending (or
// completed) chambers. Both predicates here are pure functions of WorldState,
// so a controller created by bootFromSave detects its phase from the loaded
// world rather than assuming a fresh start — and the planner itself re-derives
// what is missing every tick, so a save taken mid-plan simply resumes.

import type { WorldState } from '../sim/types.js';
import type { ColonyId, BehaviorRatio } from '../sim/colony/colony-store.js';
import type {
  MarkDigTileCommand,
  PlaceChamberCommand,
  SetBehaviorRatioCommand,
} from '../sim/commands.js';
import { MAX_COMMANDS_PER_TICK } from '../sim/commands.js';
import { ChamberType } from '../sim/enums.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import { UNDERGROUND_CEILING_ROW_Y } from '../sim/constants.js';
import { aiInitialSetup } from './ai-controller.js';
import {
  chamberFootprints,
  findReachableChamberSpot,
  isChamberAnchorPlaceable,
  undergroundComponent,
  type ChamberBox,
  type UndergroundComponent,
} from './jev-candidates.js';
import type { JevCommandLedger } from './jev-commands.js';
import type { Tile } from './jev-types.js';

/** Fixed Behavior ratio for the opening — the rule-based AI's own 7:3. */
export const JEV_OPENING_RATIO: BehaviorRatio = { forage: 7, fight: 3 };

/**
 * Row the Queen chamber's TOP sits on. Her 5×3 footprint extends down from the
 * anchor, so the nest bottoms out at row 13.
 *
 * Why 11 and not the rule-based AI's `AI_QUEEN_CHAMBER_DEPTH = 18`: the extra
 * depth buys nothing mechanically (nothing in the sim reads chamber depth) and
 * costs the one available digger ~7 extra rows of spine before the queen can
 * move in and start laying. Row 11 still reads as a real nest rather than a
 * surface scrape — it is a visible walk below the entrance — while getting the
 * colony reproducing far sooner. A human opening looks like this; an 18-row
 * mineshaft does not.
 */
export const JEV_QUEEN_ANCHOR_ROW = 11;

/**
 * Row the Nursery and the first FoodStorage sit on — high on the spine, one on
 * each side, so the two chambers the colony needs *early* (somewhere to raise
 * brood, somewhere to put food) are the first things the digger reaches on its
 * way down to the Queen.
 */
export const JEV_UPPER_CHAMBER_ROW = 4;

/**
 * Self-imposed cap on commands the planner adds to a single drain. tick.ts
 * applies at most `MAX_COMMANDS_PER_TICK` (64) non-Sync commands per tick and
 * silently drops the rest, and the planner shares that drain with the player's
 * own clicks. The whole plan is ~16 commands, so this never actually bites — it
 * is the guard that keeps it that way if the layout ever grows.
 */
export const JEV_PLAN_COMMANDS_PER_TICK = 32;

/**
 * Ticks the planner waits for its own planned anchor to become legal before
 * giving up on the layout and taking whatever `findReachableChamberSpot`
 * offers. The normal path needs exactly one tick — the spine has to be Marked
 * before a chamber hung off it is reachable — so this is slack for a loaded
 * world whose dirt does not match the plan (2 s at the fixed 20 Hz timestep).
 */
export const JEV_PLAN_PATIENCE_TICKS = 40;

/**
 * How long to wait, in ticks, before re-running a fallback anchor search that
 * came up empty. Validating a planned anchor is O(footprint) and carries the
 * normal two-tick path, but `findReachableChamberSpot` sweeps the whole nest
 * neighbourhood — and a colony that cannot place a chamber ANYWHERE would
 * otherwise pay for that sweep on every tick, forever. Only failed searches back
 * off: a search that finds a spot ends in a placement, so it never repeats. Same
 * reasoning and the same order of magnitude as the rule-based AI's own
 * `AI_CHAMBER_INTERVAL`.
 */
export const JEV_FALLBACK_SEARCH_INTERVAL = 40;

/** The three chambers the opening plans, in the order it commits them. */
export const JEV_OPENING_CHAMBERS: readonly ChamberType[] = [
  ChamberType.Queen,
  ChamberType.Nursery,
  ChamberType.FoodStorage,
];

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface JevPlannedChamber {
  readonly chamberType: ChamberType;
  /** Preferred anchor, or `null` when the plan's geometry does not fit this grid. */
  readonly anchor: Tile | null;
}

export interface JevNestPlan {
  /** The entrance column — the spine every chamber hangs off. */
  readonly columnX: number;
  /** First spine row the plan marks. Row 0 is the ceiling; tick.ts rejects it. */
  readonly columnTopY: number;
  /** Last spine row the plan marks — the Queen chamber's bottom row. */
  readonly columnBottomY: number;
  readonly chambers: readonly JevPlannedChamber[];
}

/**
 * Where this colony's nest goes. A pure function of the world: same world, same
 * plan, which is what makes `runJevOpeningTick` idempotent and resumable.
 */
export function computeNestPlan(world: WorldState, colonyId: ColonyId): JevNestPlan | null {
  const colony = world.colonies[colonyId];
  const grid = world.undergroundGrids[colonyId];
  if (colony === undefined || grid === undefined) return null;
  const entrance = colony.entrances.find((e) => e.isOpen) ?? colony.entrances[0];
  if (entrance === undefined) return null;
  // Integer + bounds, the issue #60 shape: a NaN `surfaceTileX` must not reach
  // the anchor arithmetic and produce `${colonyId}:NaN:NaN` placements.
  const columnX = entrance.surfaceTileX;
  if (!Number.isInteger(columnX) || columnX < 0 || columnX >= grid.width) return null;

  const queenDims = CHAMBER_DIMENSIONS[ChamberType.Queen];
  const columnBottomY = Math.min(grid.height - 1, JEV_QUEEN_ANCHOR_ROW + queenDims.height - 1);

  // Queen deep on the right, Nursery high on the right, FoodStorage high on the
  // left: nothing overlaps the spine or another footprint, and each chamber has
  // a whole edge against the spine. One 4-adjacent tile is all the reachability
  // BFS needs; a whole edge means the digger never has to detour to get in.
  return {
    columnX,
    columnTopY: UNDERGROUND_CEILING_ROW_Y + 1,
    columnBottomY,
    chambers: dropSelfOverlaps([
      planChamber(ChamberType.Queen, JEV_QUEEN_ANCHOR_ROW, 'right', columnX, grid.width),
      planChamber(ChamberType.Nursery, JEV_UPPER_CHAMBER_ROW, 'right', columnX, grid.width),
      planChamber(ChamberType.FoodStorage, JEV_UPPER_CHAMBER_ROW, 'left', columnX, grid.width),
    ]),
  };
}

/** One chamber hung off `side` of the spine, mirrored to the other side if that side is off-grid. */
function planChamber(
  chamberType: ChamberType,
  anchorY: number,
  side: 'left' | 'right',
  columnX: number,
  gridW: number,
): JevPlannedChamber {
  const { width } = CHAMBER_DIMENSIONS[chamberType];
  const preferred = side === 'right' ? columnX + 1 : columnX - width;
  const mirrored = side === 'right' ? columnX - width : columnX + 1;
  const fits = (x: number): boolean => x >= 0 && x + width <= gridW;
  const anchorX = fits(preferred) ? preferred : fits(mirrored) ? mirrored : null;
  return { chamberType, anchor: anchorX === null ? null : { x: anchorX, y: anchorY } };
}

/**
 * Null out any planned anchor that lands on one the plan already committed to.
 * That only happens when a chamber had to be MIRRORED to the other side of the
 * spine — an entrance hard against a grid edge — and came down on its
 * neighbour's footprint. Nulling the anchor sends that chamber straight to the
 * generic search instead of making it sit out `JEV_PLAN_PATIENCE_TICKS` waiting
 * for a spot it is never going to get.
 */
function dropSelfOverlaps(planned: readonly JevPlannedChamber[]): JevPlannedChamber[] {
  const taken: ChamberBox[] = [];
  const out: JevPlannedChamber[] = [];
  for (const p of planned) {
    if (p.anchor === null) {
      out.push(p);
      continue;
    }
    const dims = CHAMBER_DIMENSIONS[p.chamberType];
    const box: ChamberBox = { x: p.anchor.x, y: p.anchor.y, w: dims.width, h: dims.height };
    if (overlapsAny(box, taken)) {
      out.push({ chamberType: p.chamberType, anchor: null });
      continue;
    }
    taken.push(box);
    out.push(p);
  }
  return out;
}

/** Standard rectangle overlap of `box` against any of `boxes`. */
function overlapsAny(box: ChamberBox, boxes: readonly ChamberBox[]): boolean {
  for (const b of boxes) {
    if (box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Running the plan
// ---------------------------------------------------------------------------

export interface JevOpeningState {
  /** First tick this state ran the planner against a world it could plan for. */
  startedTick: number | null;
  /** Chamber type → the tick we pushed its PlaceChamber on (cleared once judged). */
  readonly issued: Map<ChamberType, number>;
  /** Types whose planned anchor tick.ts refused — those use the generic spot from now on. */
  readonly fellBack: Set<ChamberType>;
  /** Chamber type → the earliest tick its fallback search may run again (see the interval). */
  readonly fallbackRetryTick: Map<ChamberType, number>;
}

export function createJevOpeningState(): JevOpeningState {
  return {
    startedTick: null,
    issued: new Map(),
    fellBack: new Set(),
    fallbackRetryTick: new Map(),
  };
}

/** One tick of the opening for `colonyId`. Idempotent; call every tick until handoff. */
export function runJevOpeningTick(
  world: WorldState,
  colonyId: ColonyId,
  ledger: JevCommandLedger,
  st: JevOpeningState,
): void {
  const colony = world.colonies[colonyId];
  if (colony === undefined || colony.defeated) return;

  // aiInitialSetup is the guarded Entrance-recovery path (createScenario already
  // seeds an open Entrance + shaft, so this is normally a no-op). The plan hangs
  // off the entrance column, so it has to run before anything below — and before
  // the budget, so whatever it queued counts against the same drain.
  ledger.adopt(world, () => aiInitialSetup(world, colony));

  let budget = planBudget(world);
  if (budget <= 0) return;

  // The opening ratio. There is deliberately no "already issued" flag: the
  // colony's own targetRatio is the latch, so a push that fell off the end of a
  // full drain is simply re-issued next tick instead of being lost for the round.
  if (
    colony.targetRatio.forage !== JEV_OPENING_RATIO.forage ||
    colony.targetRatio.fight !== JEV_OPENING_RATIO.fight
  ) {
    const cmd: SetBehaviorRatioCommand = {
      type: 'SetBehaviorRatio',
      colonyId,
      ratio: { ...JEV_OPENING_RATIO },
      issuedAtTick: world.tick,
    };
    ledger.issue(world, cmd);
    budget -= 1;
  }

  const plan = computeNestPlan(world, colonyId);
  if (plan === null) return;
  st.startedTick ??= world.tick;

  // A PlaceChamber pushed on an earlier tick that did not turn into a pending
  // chamber was refused by tick.ts (a candidate/gate mismatch, or it fell off
  // the end of a full drain). Stop trusting the planned anchor for that type and
  // take whatever the generic search offers instead.
  for (const [chamberType, issuedTick] of st.issued) {
    if (issuedTick >= world.tick) continue;
    st.issued.delete(chamberType);
    if (!hasChamberOrPending(world, colonyId, chamberType)) st.fellBack.add(chamberType);
  }

  const grid = world.undergroundGrids[colonyId];
  if (grid === undefined) return;

  // 1. The spine. Solid tiles only — anything already Marked / BeingDug / Open
  //    is skipped, which is the whole of the resume-from-a-partial-plan story.
  for (let y = plan.columnTopY; y <= plan.columnBottomY; y++) {
    if (budget <= 0) return;
    if (ugGet(grid, plan.columnX, y) !== UndergroundTileState.Solid) continue;
    const cmd: MarkDigTileCommand = {
      type: 'MarkDigTile',
      colonyId,
      tileX: plan.columnX,
      tileY: y,
      issuedAtTick: world.tick,
    };
    ledger.issue(world, cmd);
    budget -= 1;
  }

  // 2. The chambers. A footprint is only reachable once the spine beside it is
  //    Marked, and step 1's marks are still sitting in the command queue — so on
  //    a fresh world this pass places nothing on the first tick and everything
  //    on the second. No phase flag needed: the gate IS the world.
  const boxes = chamberFootprints(world, colonyId);
  // The component BFS floods every non-Solid tile, so it is derived lazily and
  // only once every cheaper gate below has agreed there is a decision to make.
  // A colony with nothing left to place — or one that is backing off a fallback
  // search that came up empty — never pays for it at all.
  let comp: UndergroundComponent | null = null;
  let compDerived = false;
  for (const planned of plan.chambers) {
    if (budget <= 0) return;
    const chamberType = planned.chamberType;
    if (hasChamberOrPending(world, colonyId, chamberType)) continue;
    // Anything still in `st.issued` after the sweep above was pushed on THIS
    // tick and has not been through tick() yet, so `hasChamberOrPending` cannot
    // see it. Without this, a second call inside one seam would push a duplicate
    // PlaceChamber that tick.ts rejects on the pendingChambers key.
    if (st.issued.has(chamberType)) continue;

    const plannedAnchor = believePlannedAnchor(world, planned, st, boxes) ? planned.anchor : null;
    if (plannedAnchor === null && !fallbackReady(world, st, chamberType)) continue;

    if (!compDerived) {
      compDerived = true;
      comp = undergroundComponent(world, colonyId);
    }

    let anchor: Tile | null;
    if (plannedAnchor !== null) {
      anchor = isChamberAnchorPlaceable(
        world,
        colonyId,
        chamberType,
        plannedAnchor.x,
        plannedAnchor.y,
        comp,
        boxes,
      )
        ? plannedAnchor
        : null;
    } else {
      // `boxes` — not the world's own footprint list — so a second fallback
      // placement in this same seam cannot be handed an overlapping anchor.
      anchor = findReachableChamberSpot(world, colonyId, chamberType, comp, boxes);
      if (anchor === null) {
        st.fallbackRetryTick.set(chamberType, world.tick + JEV_FALLBACK_SEARCH_INTERVAL);
      }
    }
    if (anchor === null) continue;
    const cmd: PlaceChamberCommand = {
      type: 'PlaceChamber',
      colonyId,
      chamberType,
      anchorTileX: anchor.x,
      anchorTileY: anchor.y,
      issuedAtTick: world.tick,
    };
    ledger.issue(world, cmd);
    st.issued.set(chamberType, world.tick);
    // The command has not been applied yet, so `world.pendingChambers` cannot
    // keep the next chamber in this loop off this footprint. Do it here.
    const dims = CHAMBER_DIMENSIONS[chamberType];
    boxes.push({ x: anchor.x, y: anchor.y, w: dims.width, h: dims.height });
    budget -= 1;
  }
}

/**
 * Do we still believe in the plan's own anchor for this chamber?
 *
 * No when there is no planned anchor, when a placement there was already refused,
 * when the patience clock has run out — or when a footprint we already own is
 * sitting on it. That last case earns its own check because
 * `isChamberAnchorPlaceable` answers "no" to two very different questions with
 * the same bit: "the spine beside it is not Marked *yet*" (true one tick later)
 * and "a chamber is parked there" (never true again). Waiting out
 * `JEV_PLAN_PATIENCE_TICKS` for the second is two seconds of an opponent doing
 * nothing, and the information to tell them apart is already in `boxes`.
 */
function believePlannedAnchor(
  world: WorldState,
  planned: JevPlannedChamber,
  st: JevOpeningState,
  boxes: readonly ChamberBox[],
): boolean {
  const anchor = planned.anchor;
  if (anchor === null) return false;
  if (st.fellBack.has(planned.chamberType)) return false;
  if (st.startedTick !== null && world.tick - st.startedTick >= JEV_PLAN_PATIENCE_TICKS) {
    return false;
  }
  const dims = CHAMBER_DIMENSIONS[planned.chamberType];
  return !overlapsAny({ x: anchor.x, y: anchor.y, w: dims.width, h: dims.height }, boxes);
}

/**
 * May the fallback sweep run for this chamber on this tick? Two reasons it may
 * not, both answerable without touching the grid:
 *
 *   - This is the planner's FIRST tick, so the spine it just marked is still in
 *     the command queue and the component is nothing but the entrance shaft. A
 *     spot chosen against that would anchor the nest to a two-tile hole at the
 *     surface. One tick later the spine exists and the search is worth running.
 *   - A previous sweep came up empty and is backing off (see the interval).
 */
function fallbackReady(world: WorldState, st: JevOpeningState, chamberType: ChamberType): boolean {
  if (st.startedTick !== null && world.tick === st.startedTick) return false;
  return world.tick >= (st.fallbackRetryTick.get(chamberType) ?? 0);
}

/**
 * How many commands the planner may still add to THIS drain. tick.ts applies the
 * first `MAX_COMMANDS_PER_TICK` non-Sync commands of the drained queue and drops
 * the rest, so anything already queued ahead of us eats into what we can push.
 */
function planBudget(world: WorldState): number {
  let queued = 0;
  for (const cmd of world.commandQueue) {
    if (cmd.type !== 'SyncAIState') queued += 1;
  }
  return Math.min(JEV_PLAN_COMMANDS_PER_TICK, MAX_COMMANDS_PER_TICK - queued);
}

/** True if `colonyId` owns a chamber of this type — completed OR still being excavated. */
export function hasChamberOrPending(
  world: WorldState,
  colonyId: ColonyId,
  chamberType: ChamberType,
): boolean {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return false;
  if (colony.chambers.some((c) => c.chamberType === chamberType)) return true;
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    const pc = world.pendingChambers[key]!;
    if (pc.colonyId === colonyId && pc.chamberType === chamberType) return true;
  }
  return false;
}

/**
 * Handoff: Queen, Nursery and first FoodStorage are all PLACED — pending counts.
 * Excavation is the digger's problem, not Jev's, and waiting for it was the
 * whole ~4,000-tick hole this module exists to close.
 */
export function isOpeningPlanned(world: WorldState, colonyId: ColonyId): boolean {
  if (world.colonies[colonyId] === undefined) return false;
  for (const chamberType of JEV_OPENING_CHAMBERS) {
    if (!hasChamberOrPending(world, colonyId, chamberType)) return false;
  }
  return true;
}

/**
 * The older, stricter milestone: all three chambers finished excavating and
 * nothing of ours is pending. No longer the handoff gate — it is kept because it
 * is exactly the "the nest is actually built" predicate, which is what the
 * candidate / live-phase test fixtures want to run a world up to.
 */
export function isHandoffComplete(world: WorldState, colonyId: ColonyId): boolean {
  const colony = world.colonies[colonyId];
  if (colony === undefined) return false;
  const has = (t: ChamberType): boolean => colony.chambers.some((c) => c.chamberType === t);
  if (!has(ChamberType.Queen) || !has(ChamberType.Nursery) || !has(ChamberType.FoodStorage)) {
    return false;
  }
  for (const key in world.pendingChambers) {
    if (!Object.hasOwn(world.pendingChambers, key)) continue;
    if (world.pendingChambers[key]!.colonyId === colonyId) return false;
  }
  return true;
}
