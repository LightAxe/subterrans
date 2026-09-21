// src/platform/input-log-replay.ts — issue #296.
//
// The recorded `inputLog` is a FLAT list of commands, but the simulation never
// sees it flat: the platform loop drains `world.commandQueue.splice(0)` once per
// tick and hands that batch to `tick()`. Replaying the log therefore needs the
// batch boundaries back, and `issuedAtTick` is NOT them.
//
// For player and AI input the two coincide: those commands are pushed between
// ticks (or from `onBeforeTick`, before the drain), so they are drained on the
// very tick they were stamped with. For a command the SIM pushes for itself —
// `advanceAIState` emitting `ClearRallyPoint` at tick step 18b, stamped with the
// tick it is already inside — the next drain is one tick later. Grouping such a
// command by `issuedAtTick` applies it a tick EARLY, and from that point the
// replay is a different run: the rally point clears a tick sooner, fighters
// re-route a tick sooner, and the byte-compare fails.
//
// Two mechanisms, in priority order:
//
//   1. RECORDED (exact by construction). `stampDrainTick` (src/sim/commands.ts,
//      next to `pushCommand`) writes `drainTick` onto every command at the one
//      sanctioned drain site (`createGameLoop`), so the log carries the
//      boundaries the sim actually saw. Being a field on the command, it rides
//      along through `inputLog` into the debug snapshot, the playtrace envelope
//      and the save file with no extra plumbing — exactly the way `origin` does
//      (#230). The stamp itself is a SIM-layer operation: a drained command is
//      still a simulation object (aliased from `prevState.commandQueue`), so
//      writing to it from here would cross the platform boundary. This module
//      only READS the field.
//
//   2. DERIVED (fallback for logs recorded before this existed). A command
//      stamped `origin: 'sim'` was drained at `issuedAtTick + 1`; anything else
//      at `issuedAtTick`. This is exact for every log produced by a #230-or-
//      later build. A command with NO `origin` at all predates that too, and
//      there is no way to tell a sim-emitted `ClearRallyPoint` from a
//      player-issued one, so those keep the historical `issuedAtTick` placement
//      rather than guessing.
//
//      Be precise about what that buys: a provenance-less log is NOT rescued.
//      Its self-emits still land a tick early, so a capture taken after the
//      first probe still fails the byte-compare — it is simply no worse placed
//      than before. (It is not bit-identical to the old analyzer either: the
//      replay loop now also discards the regenerated queue, so the early
//      command is applied once rather than twice. Both runs diverge; the new
//      one diverges more cleanly.) The provenance-less case is pinned by a test
//      in input-log-replay.integration.test.ts so this stays an understood
//      limitation rather than a surprise.
//
// The other half of a correct replay lives at the call site and cannot be done
// here: the replaying world REGENERATES its own sim self-emits, so the replay
// loop must discard `world.commandQueue` before feeding each recorded batch.
// Otherwise the regenerated copies pile up in the queue (which is part of the
// serialized state) and are also applied a second time on a later tick. See
// {@link indexByDrainTick} for the loop shape.

import type { SimCommand } from '../sim/commands.js';

/** Ticks between a sim self-emit being pushed and the next drain. The platform
 *  loop drains once per tick unconditionally, so a command pushed during tick T
 *  is always picked up at the start of tick T+1 — never later. */
export const SIM_SELF_EMIT_DRAIN_LAG = 1;

/**
 * Is `cmd.drainTick` a usable recorded stamp? Shared by every reader so the
 * acceptance rule cannot drift between them.
 *
 * Rejects a non-integer, a negative tick, and — the case that actually bites —
 * a `drainTick` EARLIER than `issuedAtTick`, which is impossible by construction
 * (a command cannot be drained before it was pushed). Without the range check a
 * corrupt `drainTick` of -1 would land at `byTick[-1]`, which JavaScript stores
 * as a string property rather than an array index: the command would vanish from
 * the replay and the analyzer would report a SCEN-06 determinism regression
 * instead of "your snapshot is corrupt". Falling back to the derived rule turns
 * that into a replay that is merely as good as a pre-#296 log's.
 */
function hasUsableDrainTick(cmd: SimCommand): boolean {
  const d = cmd.drainTick;
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d >= cmd.issuedAtTick;
}

/**
 * The tick at which `cmd` was (or would have been) handed to `tick()`.
 * Prefers the recorded `drainTick`; falls back to the origin-derived rule.
 * See the module header for why an `origin`-less command keeps `issuedAtTick`.
 */
export function drainTickOf(cmd: SimCommand): number {
  if (hasUsableDrainTick(cmd)) return cmd.drainTick!;
  return cmd.origin === 'sim' ? cmd.issuedAtTick + SIM_SELF_EMIT_DRAIN_LAG : cmd.issuedAtTick;
}

/** How the batch boundaries for a given log were recovered. Reported by
 *  {@link summarizeDrainTickSource} so a tool can tell the reader whether it is
 *  replaying recorded boundaries or reconstructed ones. */
export interface DrainTickSource {
  /** Commands carrying a recorded `drainTick`. */
  recorded: number;
  /** Commands with `origin: 'sim'` but no `drainTick` — derived as +1. */
  derivedSelfEmit: number;
  /** Everything else: derived as `issuedAtTick` (player/AI input, and
   *  pre-#230 commands with no provenance at all). */
  derivedAtIssue: number;
}

export function summarizeDrainTickSource(log: readonly SimCommand[]): DrainTickSource {
  const out: DrainTickSource = { recorded: 0, derivedSelfEmit: 0, derivedAtIssue: 0 };
  for (const c of log) {
    if (hasUsableDrainTick(c)) out.recorded++;
    else if (c.origin === 'sim') out.derivedSelfEmit++;
    else out.derivedAtIssue++;
  }
  return out;
}

/**
 * Regroup a flat input log into per-tick drain batches: a sparse array where
 * index `t` holds the commands `tick()` received on tick `t`, in their recorded
 * order. Holes (ticks that drained nothing) are left empty — read them as `[]`.
 *
 * The replay loop this is built for:
 *
 * ```ts
 * const byDrainTick = indexByDrainTick(snapshot.inputLog);
 * for (let t = 0; t < snapshot.tick; t++) {
 *   world.commandQueue.splice(0); // discard REGENERATED self-emits: the
 *                                 // recorded batch already contains them
 *   tick(world, byDrainTick[t] ?? []);
 * }
 * ```
 */
export function indexByDrainTick(log: readonly SimCommand[]): SimCommand[][] {
  const byTick: SimCommand[][] = [];
  for (const cmd of log) {
    const t = drainTickOf(cmd);
    (byTick[t] ??= []).push(cmd);
  }
  return byTick;
}
