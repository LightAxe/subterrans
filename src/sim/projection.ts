// src/sim/projection.ts — Stage 3a (Command Legibility, issue #18).
//
// Sim-owned projection: clone a world into a caller-supplied buffer and fold a list of
// commands through the REAL handlers. The mutation lives HERE, in src/sim/, because
// render/input must never write a WorldState — even a throwaway clone (AGENTS.md sim/render
// boundary; Codex P1). The render layer (CommandProjection / CommandFeedforward) owns the
// buffer lifecycle + memoization and only CALLS these functions, then consumes `dst`.
//
// Pure + deterministic: applyCommands consumes no RNG (verified — the clone is inert), so
// projecting neither advances nor diverges the live simulation. tick() is UNCHANGED — this is
// additive sim code, not a tick-path edit (the apply-commands golden differential still holds).

import type { WorldState } from './types.js';
import type { SimCommand } from './commands.js';
import { copyWorldState } from './types.js';
import { ensureSurfaceComponentMask } from './surface-features.js';
import { applyCommands } from './tick.js';

/**
 * Complete projection clone (Codex R3-1 / R4-1). `copyWorldState` deep-copies everything
 * EXCEPT `events` (a deliberate render-double-buffer optimization) and transient
 * `pendingQueenDeathContexts`. The projection must ALSO copy `events` + the dropped-event
 * counters, because `applyCommands` can emit events (StartAIOperation) whose cap/eviction
 * behaviour depends on the existing event count — resetting would diverge from the real drain
 * and break projection parity. The surface-component-mask ref is copied by copyWorldState
 * (derived from static terrain; read-only).
 */
export function projectionCopy(src: WorldState, dst: WorldState): void {
  copyWorldState(src, dst);
  dst.events = src.events.map((e) => ({ ...e }));
  dst.droppedCombatKillCount = src.droppedCombatKillCount;
  dst.droppedStructuralCount = src.droppedStructuralCount;
}

/**
 * Clone `src` into `dst` and fold `commands` through the real handlers; the result is `dst`
 * (returns void). `ensureSurfaceComponentMask` mirrors tick()'s prologue so DesignateEntrance
 * validity is exact. Serves both the full-queue projection (CommandProjection) and the
 * single-candidate trial-apply (CommandFeedforward). Never mutates `src`.
 */
export function projectWorld(
  src: WorldState,
  commands: readonly SimCommand[],
  dst: WorldState,
): void {
  projectionCopy(src, dst);
  ensureSurfaceComponentMask(dst);
  applyCommands(dst, commands);
}
