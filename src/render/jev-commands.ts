// jev-commands.ts — the ONLY path by which the Jev opponent touches the world.
//
// Two jobs:
//   1. Allowlist. Jev may only issue commands a human player could issue. The
//      assertion is a hard throw, not a filter: a new command type slipping into
//      the Jev path is a bug we want loud, in a test, not a silently wider
//      surface than the player's.
//   2. A light pre→post ledger. `issue` captures — in a closure, at push time —
//      the bit of world state the command would change; `settle`, called on the
//      NEXT tick seam (after tick() has drained and applied the queue), asks that
//      closure whether the command was applied, rejected, or a no-op. Purely
//      diagnostic — the controller never branches on it — but it is what caught
//      candidate-legality bugs in the spike, and it is cheap (a handful of
//      closures per beat in the render layer, not a sim hot loop).
//
// Boundary: every push goes through `pushCommand` (the #230 provenance
// chokepoint); nothing here writes WorldState.

import type { WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';
import { pushCommand } from '../sim/commands.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { FP_SHIFT } from '../sim/fixed.js';

/** Exactly the commands the player's own UI can produce (CONTEXT.md → Colony control). */
export const PLAYER_SURFACE_COMMANDS: ReadonlySet<SimCommand['type']> = new Set<SimCommand['type']>(
  [
    'SetBehaviorRatio',
    'MarkDigTile',
    'CancelDigMark',
    'MarkFoodPile',
    'PlaceChamber',
    'DesignateEntrance',
    'SetRallyPoint',
    'ClearRallyPoint',
    'MarkSpiderPriority',
  ],
);

export type CommandOutcome = 'applied' | 'rejected' | 'noop';

/** Asked once, on the tick seam AFTER the command went through tick(). */
type Classifier = (world: WorldState) => CommandOutcome;

export interface LedgerCounts {
  applied: number;
  rejected: number;
  noop: number;
}

const NOOP: Classifier = () => 'noop';
/** Unreachable for allowlisted commands; present because SimCommand is wider. */
const REJECTED: Classifier = () => 'rejected';

function tileState(world: WorldState, colonyId: number, x: number, y: number): number {
  const grid = world.undergroundGrids[colonyId];
  if (!grid || x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
  return ugGet(grid, x, y);
}

function chamberAtAnchor(world: WorldState, colonyId: number, x: number, y: number): boolean {
  const colony = world.colonies[colonyId];
  if (!colony) return false;
  for (const ch of colony.chambers) {
    if (ch.posX >> FP_SHIFT === x && ch.posY >> FP_SHIFT === y) return true;
  }
  return Object.hasOwn(world.pendingChambers, `${colonyId}:${x}:${y}`);
}

function entranceAt(world: WorldState, colonyId: number, x: number, y: number): boolean {
  const colony = world.colonies[colonyId];
  if (!colony) return false;
  return colony.entrances.some((e) => e.surfaceTileX === x && e.surfaceTileY === y);
}

function rallyEquals(world: WorldState, colonyId: number, x: number, y: number): boolean {
  const rp = world.colonies[colonyId]?.rallyPoint ?? null;
  return rp !== null && rp.tileX === x && rp.tileY === y;
}

function ratioEquals(world: WorldState, colonyId: number, forage: number, fight: number): boolean {
  const r = world.colonies[colonyId]?.targetRatio;
  return r !== undefined && r.forage === forage && r.fight === fight;
}

/**
 * Snapshot what `cmd` would change and return the question to ask afterwards.
 * "No-op" means the world already satisfied the command before it was issued;
 * "rejected" means tick.ts declined it (a stale candidate, an illegal tile).
 */
function classifierFor(world: WorldState, cmd: SimCommand): Classifier {
  switch (cmd.type) {
    case 'MarkDigTile': {
      if (tileState(world, cmd.colonyId, cmd.tileX, cmd.tileY) !== UndergroundTileState.Solid) {
        return NOOP;
      }
      return (w) =>
        tileState(w, cmd.colonyId, cmd.tileX, cmd.tileY) !== UndergroundTileState.Solid
          ? 'applied'
          : 'rejected';
    }
    case 'CancelDigMark': {
      if (tileState(world, cmd.colonyId, cmd.tileX, cmd.tileY) !== UndergroundTileState.Marked) {
        return NOOP;
      }
      return (w) =>
        tileState(w, cmd.colonyId, cmd.tileX, cmd.tileY) === UndergroundTileState.Solid
          ? 'applied'
          : 'rejected';
    }
    case 'PlaceChamber': {
      if (chamberAtAnchor(world, cmd.colonyId, cmd.anchorTileX, cmd.anchorTileY)) return NOOP;
      return (w) =>
        chamberAtAnchor(w, cmd.colonyId, cmd.anchorTileX, cmd.anchorTileY) ? 'applied' : 'rejected';
    }
    case 'DesignateEntrance': {
      if (entranceAt(world, cmd.colonyId, cmd.surfaceTileX, cmd.surfaceTileY)) return NOOP;
      return (w) =>
        entranceAt(w, cmd.colonyId, cmd.surfaceTileX, cmd.surfaceTileY) ? 'applied' : 'rejected';
    }
    case 'SetRallyPoint': {
      if (rallyEquals(world, cmd.colonyId, cmd.tileX, cmd.tileY)) return NOOP;
      return (w) => (rallyEquals(w, cmd.colonyId, cmd.tileX, cmd.tileY) ? 'applied' : 'rejected');
    }
    case 'ClearRallyPoint': {
      if ((world.colonies[cmd.colonyId]?.rallyPoint ?? null) === null) return NOOP;
      return (w) =>
        (w.colonies[cmd.colonyId]?.rallyPoint ?? null) === null ? 'applied' : 'rejected';
    }
    case 'SetBehaviorRatio': {
      const { forage, fight } = cmd.ratio;
      if (ratioEquals(world, cmd.colonyId, forage, fight)) return NOOP;
      return (w) => (ratioEquals(w, cmd.colonyId, forage, fight) ? 'applied' : 'rejected');
    }
    case 'MarkFoodPile': {
      // MarkFoodPile TOGGLES in tick.ts, so there is no "already satisfied"
      // pre-state to compare against — any change from what we captured means
      // the command landed.
      const before = world.colonies[cmd.colonyId]?.priorityFoodPileId ?? null;
      return (w) =>
        (w.colonies[cmd.colonyId]?.priorityFoodPileId ?? null) !== before ? 'applied' : 'rejected';
    }
    case 'MarkSpiderPriority': {
      const expected = cmd.isPriority ? cmd.colonyId : null;
      if (world.spiderPriorityColonyId === expected) return NOOP;
      return (w) => (w.spiderPriorityColonyId === expected ? 'applied' : 'rejected');
    }
    default:
      return REJECTED;
  }
}

/**
 * Allowlisted push path + applied/rejected/no-op counters.
 *
 * Usage contract: `issue` / `adopt` during a tick seam, then exactly one
 * `settle(world)` on the NEXT seam (once tick() has consumed the queue).
 */
export class JevCommandLedger {
  readonly counts: LedgerCounts = { applied: 0, rejected: 0, noop: 0 };
  /** Total commands ever pushed through this ledger. */
  issuedCount = 0;
  private pending: Classifier[] = [];

  issue(world: WorldState, cmd: SimCommand): void {
    assertPlayerSurface(cmd.type);
    this.pending.push(classifierFor(world, cmd));
    this.issuedCount += 1;
    pushCommand(world, cmd, 'ai');
  }

  /**
   * Run `fn` (which pushes via `pushCommand` itself — e.g. the rule-based AI's
   * exported opening helpers) and adopt whatever it enqueued, asserting the
   * allowlist on each adopted command.
   */
  adopt(world: WorldState, fn: () => void): number {
    const before = world.commandQueue.length;
    fn();
    let adopted = 0;
    for (let i = before; i < world.commandQueue.length; i++) {
      const cmd = world.commandQueue[i]!;
      assertPlayerSurface(cmd.type);
      this.pending.push(classifierFor(world, cmd));
      this.issuedCount += 1;
      adopted += 1;
    }
    return adopted;
  }

  /** Classify everything issued before the last tick(). Safe to call every tick. */
  settle(world: WorldState): void {
    if (this.pending.length === 0) return;
    const done = this.pending;
    this.pending = [];
    for (const classify of done) this.counts[classify(world)] += 1;
  }
}

function assertPlayerSurface(type: SimCommand['type']): void {
  if (!PLAYER_SURFACE_COMMANDS.has(type)) {
    throw new Error(`jev: command type '${type}' is not on the player surface`);
  }
}
