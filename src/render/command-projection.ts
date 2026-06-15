// src/render/command-projection.ts — Stage 3a (Command Legibility, issue #18).
//
// The PROJECTED WORLD: the committed world with the COMPLETE command queue folded
// through the real sim handlers (applyCommands). It is the single client-side source
// of truth for BOTH input (tap / chamber-menu decisions — superseding the Stage-1
// effectiveDigState hand-fold) AND render (feedforward + ghosts), so the cue and the
// command a tap emits can never disagree (Codex R2-3/4, R3-6).
//
// Render-only: reads world + world.commandQueue, builds a throwaway clone, never
// mutates the live world. NOT a sim change — it merely *calls* sim functions
// (copyWorldState, applyCommands, ensureSurfaceComponentMask) on a clone.

import type { WorldState } from '../sim/types.js';
import { copyWorldState, createWorldState } from '../sim/types.js';
import { createScenario } from '../sim/scenario.js';
import { ensureSurfaceComponentMask } from '../sim/surface-features.js';
import { applyCommands } from '../sim/tick.js';

void createWorldState; // (kept importable for callers/tests; buffer uses createScenario)

/**
 * Complete projection clone (Codex R3-1 / R4-1). `copyWorldState` deep-copies
 * everything EXCEPT `events` (a deliberate render-double-buffer optimization) and
 * transient `pendingQueenDeathContexts`. The projection must copy events + the
 * dropped-event counters too, because `applyCommands` can emit events
 * (StartAIOperation) whose cap/eviction behaviour depends on the existing event
 * count — resetting would diverge from the real drain and break projection parity.
 * The surface-component-mask ref is copied by copyWorldState (derived from static
 * terrain; read-only).
 */
export function projectionCopy(src: WorldState, dst: WorldState): void {
  copyWorldState(src, dst);
  dst.events = src.events.map((e) => ({ ...e }));
  dst.droppedCombatKillCount = src.droppedCombatKillCount;
  dst.droppedStructuralCount = src.droppedStructuralCount;
}

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
    // immediately overwritten by projectionCopy.
    if (this.buf === null) this.buf = createScenario(world.terrainSeed, world.difficulty);
    projectionCopy(world, this.buf);
    ensureSurfaceComponentMask(this.buf); // mirror tick()'s prologue so entrance validity is exact
    applyCommands(this.buf, world.commandQueue);

    this.lastResult = this.buf;
    this.lastWorld = world;
    this.lastTick = world.tick;
    this.lastQueueLen = queueLen;
    this.rev++;
    return this.buf;
  }
}
