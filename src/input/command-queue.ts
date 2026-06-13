// command-queue.ts — Stage 1 controls rework (issue #18): single input-side
// command enqueue helper with a paused-overflow guard.
//
// Why this exists (Codex R1-6, R2-8):
//   tick() drains the queue FIFO and applies at most MAX_COMMANDS_PER_TICK
//   NON-Sync commands per tick, silently dropping the excess (see
//   src/sim/tick.ts — `if (nonSyncCmdCount >= MAX_COMMANDS_PER_TICK) break`).
//   While the loop is PAUSED the queue never drains, so an unbounded burst of
//   player orders (e.g. a long dig-paint stroke, or repeated chamber/behavior
//   commands) silently piles up past the cap; on resume only the first 64 take
//   effect and the rest vanish with no feedback.
//
//   The fix is purely input-side and emits the SAME SimCommands as today: every
//   player command producer — the gesture arbiter, the chamber context menu
//   (ui-scene.ts), and the Forage/Fight slider (ui-scene.ts) — routes through
//   ONE enqueueCommand() that, WHEN PAUSED, refuses to push a non-Sync command
//   once the queue already holds MAX_COMMANDS_PER_TICK non-Sync commands, and
//   reports the overflow so the hint strip can surface "paused queue full —
//   resume to continue". No sim change, no new command, determinism unaffected
//   (a dropped-at-the-cap command would have been dropped by tick.ts anyway).
//
// When NOT paused the queue drains every tick, so the steady-state depth is
// tiny and the cap is effectively never hit by hand-issued input — enqueue then
// pushes unconditionally, matching today's `world.commandQueue.push(cmd)`.

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
 * paused non-Sync cap.
 *
 * - Not paused: always pushes (returns true). The queue drains each tick so the
 *   cap is unreachable through hand input; matches the prior direct push.
 * - Paused: pushes only if the queue currently holds fewer than
 *   MAX_COMMANDS_PER_TICK non-Sync commands. If at/over the cap, drops the
 *   command (it would have been dropped by tick.ts on resume regardless) and
 *   returns false so the caller can surface the "paused queue full" hint.
 *
 * Never mutates anything but the queue array; never touches sim state beyond
 * the command queue (the legitimate input→sim seam per ARCHITECTURE.md).
 *
 * @returns true if the command was enqueued; false if it was dropped at the cap.
 */
export function enqueueCommand(world: WorldState, cmd: SimCommand, isPaused: boolean): boolean {
  if (isPaused && cmd.type !== 'SyncAIState') {
    if (countNonSyncQueued(world.commandQueue) >= MAX_COMMANDS_PER_TICK) {
      return false;
    }
  }
  world.commandQueue.push(cmd);
  return true;
}
