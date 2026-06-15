// src/render/command-projection.ts — Stage 3a (Command Legibility, issue #18).
//
// The PROJECTED WORLD: the committed world with the COMPLETE command queue folded
// through the real sim handlers (applyCommands). It is the single client-side source
// of truth for BOTH input (tap / chamber-menu decisions — superseding the Stage-1
// effectiveDigState hand-fold) AND render (feedforward + ghosts), so the cue and the
// command a tap emits can never disagree (Codex R2-3/4, R3-6).
//
// Render-side: this owns the buffer lifecycle + memoization and reads world +
// world.commandQueue, but the clone+fold MUTATION lives in the sim layer (projectWorld,
// src/sim/projection.ts) — render never writes a WorldState, even a throwaway clone
// (AGENTS.md sim/render boundary; Codex P1). This class only CALLS projectWorld + returns it.

import type { WorldState } from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { projectWorld } from '../sim/projection.js';

/**
 * Lazily-rebuilt projected world, memoized so it is cheap to call on every input
 * event AND every render frame (Codex R3-5 — taps fire from Phaser events outside
 * the frame update, so each access re-checks freshness).
 *
 * - Folds the COMPLETE queue (player + AI), not player-only — the real drain applies
 *   all queued non-Sync commands FIFO under one cap, and AI commands can change
 *   player validity (Codex R2-9). Player-only is applied later, to the ghost VISUALS.
 * - Rebuilds on world IDENTITY / tick / queue-length change (Codex R2-10 / R3-2);
 *   while paused the queue only grows, so length-change is a reliable signal.
 * - Aliases to the live world (no clone) when the WHOLE queue is empty — the common
 *   running frame pays nothing (Codex R3-2 / R4-6: aliasing on "no *player* commands"
 *   would wrongly skip queued AI commands).
 * - `revision` bumps whenever the result changes; feedforward caches on it.
 */
export class CommandProjection {
  private buf: WorldState | null = null;
  private lastResult: WorldState | null = null;
  private lastWorld: WorldState | null = null;
  private lastTick = -1;
  private lastQueueLen = -1;
  private rev = 0;

  /** Monotonic id; bumps whenever the projected world result changes. */
  get revision(): number {
    return this.rev;
  }

  /** Return the projected world for `world` (the live world itself when the queue is empty). */
  get(world: WorldState): WorldState {
    const queueLen = world.commandQueue.length;

    // Empty queue → alias the live world (zero projection-build cost).
    if (queueLen === 0) {
      if (this.lastResult !== world) {
        this.lastResult = world;
        this.lastWorld = world;
        this.lastTick = world.tick;
        this.lastQueueLen = 0;
        this.rev++;
      }
      return world;
    }

    // Memoized projection still valid? (identity ⊕ tick ⊕ length)
    if (
      this.buf !== null &&
      this.lastResult === this.buf &&
      this.lastWorld === world &&
      this.lastTick === world.tick &&
      this.lastQueueLen === queueLen
    ) {
      return this.buf;
    }

    // Rebuild. Buffer is created once via createScenario (the proven copyWorldState
    // destination shape — same as game-scene's prevState); its generated terrain is
    // immediately overwritten by the projectWorld clone.
    if (this.buf === null) this.buf = createScenario(world.terrainSeed, world.difficulty);
    // Clone + full-queue fold runs in the SIM layer (render never writes a WorldState, even this
    // throwaway clone — AGENTS.md boundary / Codex P1). This class only owns the buffer + memo.
    projectWorld(world, world.commandQueue, this.buf);

    this.lastResult = this.buf;
    this.lastWorld = world;
    this.lastTick = world.tick;
    this.lastQueueLen = queueLen;
    this.rev++;
    return this.buf;
  }
}
