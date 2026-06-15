// src/render/command-feedforward.ts — Stage 3a (Command Legibility, issue #18).
//
// Feedforward = "if I commit the command this tap will emit, what happens?" answered
// by TRIAL-APPLYING the candidate command on a scratch clone of the PROJECTED world
// via the real applyCommands, then detecting its effect by a PRE/POST DELTA (scratch
// vs projection — Codex R3-3, R4-4: NOT post-state existence, which false-greens when
// the anchor/column already exists). Using the real handler makes validity exact for
// every command type with zero hand-rolled validity logic to be incomplete.
//
// The SAME trial-apply is the input layer's emit gate (willTakeEffect): a tap enqueues
// its command iff committing it would actually change the world, so the feedforward cue
// and the emitted command can never disagree (Codex R2-3/4 invariant). A coarse tile-
// state predicate in the input layer would let a doomed no-op through over an Open tile
// (MarkDigTile no-ops on non-Solid) or an embedded-ant Marked tile (the CancelDigMark
// revert is blocked) while the cue painted it red.
//
// Three outcomes (Codex R2-2): 'valid' (took effect), 'invalid' (geometrically
// rejected), 'blocked' (geometrically fine but the live non-Sync queue is at the 64
// cap, so it can't be queued — a distinct treatment from geometric red).

import { createScenario } from '../sim/scenario.js';
import { projectWorld } from '../sim/projection.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { MAX_COMMANDS_PER_TICK } from '../sim/commands.js';
import type { WorldState } from '../sim/types.js';
import type { SimCommand } from '../sim/commands.js';

export type FeedforwardOutcome = 'valid' | 'invalid' | 'blocked';

function pendingChamberCount(w: WorldState): number {
  return Object.keys(w.pendingChambers).length;
}

/**
 * Did `candidate` take effect — i.e. would committing it actually change the world?
 * Pre/post delta on `before` (projected) vs `after` (scratch with the candidate
 * applied). Only the placement commands feedforward applies to are handled.
 */
function tookEffect(before: WorldState, after: WorldState, candidate: SimCommand): boolean {
  switch (candidate.type) {
    case 'MarkDigTile': {
      const g0 = before.undergroundGrids[candidate.colonyId];
      const g1 = after.undergroundGrids[candidate.colonyId];
      if (!g0 || !g1) return false;
      // Solid → Marked (only Solid tiles mark; Open/Marked/BeingDug are no-ops — Codex R1-5).
      return (
        ugGet(g0, candidate.tileX, candidate.tileY) === UndergroundTileState.Solid &&
        ugGet(g1, candidate.tileX, candidate.tileY) === UndergroundTileState.Marked
      );
    }
    case 'CancelDigMark': {
      const g0 = before.undergroundGrids[candidate.colonyId];
      const g1 = after.undergroundGrids[candidate.colonyId];
      // Marked → Solid at the tile, OR a pending chamber footprint was dropped.
      if (
        g0 &&
        g1 &&
        ugGet(g0, candidate.tileX, candidate.tileY) === UndergroundTileState.Marked &&
        ugGet(g1, candidate.tileX, candidate.tileY) === UndergroundTileState.Solid
      ) {
        return true;
      }
      return pendingChamberCount(after) < pendingChamberCount(before);
    }
    case 'PlaceChamber':
      // A new PendingChamber appeared (Codex R4-4 — count delta, not "key exists",
      // so re-placing where one already pends correctly reads invalid).
      return pendingChamberCount(after) > pendingChamberCount(before);
    case 'DesignateEntrance': {
      const c0 = before.colonies[candidate.colonyId];
      const c1 = after.colonies[candidate.colonyId];
      if (!c0 || !c1) return false;
      return c1.entrances.length > c0.entrances.length;
    }
    default:
      return false;
  }
}

/**
 * Stable identity for the trial-apply RESULT of `candidate` (the `tookEffect` bool):
 * the discriminating fields the four handled handlers read. Paired with the projection
 * `revision` to key the per-frame memo — the result can only change when the projected
 * world changes (new revision) or the candidate's target/type changes.
 */
function candidateKey(candidate: SimCommand): string {
  switch (candidate.type) {
    case 'MarkDigTile':
    case 'CancelDigMark':
      return `${candidate.type}:${candidate.colonyId}:${candidate.tileX}:${candidate.tileY}`;
    case 'PlaceChamber':
      return `PlaceChamber:${candidate.colonyId}:${candidate.chamberType}:${candidate.anchorTileX}:${candidate.anchorTileY}`;
    case 'DesignateEntrance':
      return `DesignateEntrance:${candidate.colonyId}:${candidate.surfaceTileX}:${candidate.surfaceTileY}`;
    default:
      return candidate.type;
  }
}

/**
 * Trial-apply feedforward against the projected world. Owns one reusable scratch
 * world. `liveQueueNonSyncCount` is the live world's non-Sync queue depth (the cap
 * applies to the live queue, NOT the scratch's single-command batch — Codex R2-2).
 */
export class CommandFeedforward {
  private scratch: WorldState | null = null;
  // Per-frame memo of the EXPENSIVE trial-apply (the tookEffect bool), keyed on the
  // projection revision + projection TICK + candidate identity (Codex R3-2 intent:
  // "feedforward caches on revision"). The cheap cap branch (blocked vs valid) is
  // recomputed every call from the live nonSync count, so a queue-depth change never
  // triggers a re-clone.
  //
  // Why tick AND revision: CommandProjection.revision bumps when the FOLDED result
  // changes, but on the empty-queue fast path the projection ALIASES the live world and
  // revision holds steady ACROSS ticks (it only bumps on world identity change). The live
  // world still mutates each tick (ants dig Solid→Open), which changes tookEffect, so the
  // memo must also break on projection.tick. With a non-empty queue projectWorld's clone carries
  // world.tick into the buffer, so projection.tick tracks the live tick in both cases.
  private memoRev = -1;
  private memoTick = -1;
  private memoKey = '';
  private memoTookEffect = false;

  /**
   * Would committing `candidate` against `projection` actually change the world? The
   * exact trial-apply the cue uses — the input layer gates its emit on this so the cue
   * and the emitted command can never disagree. Never memoized (taps are rare; a stale
   * revision must never let a doomed command through).
   */
  willTakeEffect(projection: WorldState, candidate: SimCommand): boolean {
    return this.trialApply(projection, candidate);
  }

  /**
   * `valid` / `invalid` / `blocked` for the hovered candidate. `revision` is the
   * CommandProjection's revision (bumps only when the projected world changes); pass it
   * so the per-frame render hover skips the world deep-clone when neither the projection
   * nor the candidate has changed (Codex R3-2).
   */
  outcome(
    projection: WorldState,
    candidate: SimCommand,
    liveQueueNonSyncCount: number,
    revision: number,
  ): FeedforwardOutcome {
    const key = candidateKey(candidate);
    let took: boolean;
    if (revision === this.memoRev && projection.tick === this.memoTick && key === this.memoKey) {
      took = this.memoTookEffect;
    } else {
      took = this.trialApply(projection, candidate);
      this.memoRev = revision;
      this.memoTick = projection.tick;
      this.memoKey = key;
      this.memoTookEffect = took;
    }
    if (!took) return 'invalid';
    return liveQueueNonSyncCount >= MAX_COMMANDS_PER_TICK ? 'blocked' : 'valid';
  }

  /** Deep-clone the projection, apply the candidate, return whether it took effect. */
  private trialApply(projection: WorldState, candidate: SimCommand): boolean {
    if (this.scratch === null) {
      this.scratch = createScenario(projection.terrainSeed, projection.difficulty);
    }
    // Clone + single-candidate fold runs in the sim layer (render never writes a WorldState,
    // even this scratch clone — AGENTS.md sim/render boundary; Codex P1).
    projectWorld(projection, [candidate], this.scratch);
    return tookEffect(projection, this.scratch, candidate);
  }
}
