// command-queue.ts — Stage 1 controls rework (issue #18): single input-side
// command enqueue helper that enforces the non-Sync command cap.
//
// Why this exists (Codex R1-6, R2-8; cap made unconditional for the fast-stroke
// drop fix):
//   tick() drains the queue FIFO and applies at most MAX_COMMANDS_PER_TICK
//   NON-Sync commands per tick, silently dropping the excess (see
//   src/sim/tick.ts — `if (nonSyncCmdCount >= MAX_COMMANDS_PER_TICK) break`).
//   That cap (64) lives in the sim and cannot change. Any producer that pushes
//   MORE than 64 non-Sync commands toward a single tick therefore loses the
//   overflow inside tick.ts with no feedback — whether the loop is paused (the
//   queue never drains) OR running (a single fast dig-paint stroke can emit far
//   more than 64 MarkDigTile in one pointer-move). The original guard only
//   capped WHILE PAUSED and pushed unconditionally when running, so a fast
//   unpaused stroke silently dropped its tail.
//
//   The fix is purely input-side and emits the SAME SimCommands as today: every
//   player command producer — the gesture arbiter, the chamber context menu
//   (ui-scene.ts), and the Forage/Fight slider (ui-scene.ts) — routes through
//   ONE enqueueCommand() that refuses to push a non-Sync command once the queue
//   already holds MAX_COMMANDS_PER_TICK non-Sync commands (paused OR not), and
//   reports the refusal so the caller can defer the command. No sim change, no
//   new command, determinism unaffected (a command refused at the cap would have
//   been dropped by tick.ts anyway).
//
// Paused vs running differ only in how the caller TREATS a refusal, not in
// whether the cap applies:
//   - Running: the queue drains every tick, so a refusal is transient back-
//     pressure — the paint producer holds its stroke cursor at the last enqueued
//     tile and re-emits the remainder on the next frame's flush as the queue
//     drains (≤64/tick). No hint; it catches up next tick.
//   - Paused: the queue genuinely cannot drain, so a refusal means the player
//     must resume before more commands take effect — the caller surfaces the
//     "paused queue full — resume to continue" hint.
// The isPaused param is retained so callers can pass it uniformly, but it no
// longer gates the cap (it never needed to — the cap is the same either way).

import { MAX_COMMANDS_PER_TICK, type SimCommand } from '../sim/commands.js';
import type { WorldState } from '../sim/types.js';

/**
 * Count the non-Sync commands already queued. Mirrors tick.ts's accounting:
 * `SyncAIState` is applied in an uncapped pre-pass and excluded from the cap,
 * so it must not count against the paused budget here either (otherwise a
 * pending AI sync would shave one slot off the player's allowance).
 */
function countNonSyncQueued(queue: readonly SimCommand[]): number {
  let n = 0;
  for (const cmd of queue) {
    if (cmd.type !== 'SyncAIState') n++;
  }
  return n;
}

/**
 * enqueueCommand — push a player command onto world.commandQueue, enforcing the
 * non-Sync cap UNCONDITIONALLY (paused or not).
 *
 * - A non-Sync command pushes only if the queue currently holds fewer than
 *   MAX_COMMANDS_PER_TICK non-Sync commands. If at/over the cap, it is refused
 *   (returns false, nothing pushed): the command would have been dropped by
 *   tick.ts anyway, so refusing here lets the caller defer it instead of
 *   silently losing it. Running callers re-emit it next tick as the queue
 *   drains; paused callers surface the "paused queue full" hint.
 * - A SyncAIState command always pushes (returns true): tick.ts applies it in an
 *   uncapped pre-pass, so it never competes for the non-Sync budget.
 *
 * `isPaused` is retained for a uniform caller signature but no longer affects the
 * cap (the cap is identical paused or running); callers use it only to decide
 * how to treat a refusal (hint vs silent re-emit).
 *
 * Never mutates anything but the queue array; never touches sim state beyond
 * the command queue (the legitimate input→sim seam per ARCHITECTURE.md).
 *
 * @returns true if the command was enqueued; false if it was refused at the cap.
 */
export function enqueueCommand(world: WorldState, cmd: SimCommand, isPaused: boolean): boolean {
  // isPaused is intentionally unused for the cap decision (kept for the caller
  // signature; see the doc above). Reference it so the unused-param lint stays
  // quiet without weakening the public shape.
  void isPaused;
  if (cmd.type !== 'SyncAIState') {
    if (countNonSyncQueued(world.commandQueue) >= MAX_COMMANDS_PER_TICK) {
      return false;
    }
  }
  world.commandQueue.push(cmd);
  return true;
}
