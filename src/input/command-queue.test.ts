// command-queue.test.ts — Vitest unit tests for the input-side enqueueCommand
// non-Sync cap helper (Stage 1 controls rework, issue #18, Codex R1-6/R2-8).
// The cap is enforced UNCONDITIONALLY (paused OR running) so a fast paint stroke
// can't silently lose tiles past tick.ts's MAX_COMMANDS_PER_TICK drop.

import { describe, it, expect } from 'vitest';
import { enqueueCommand } from './command-queue.js';
import { MAX_COMMANDS_PER_TICK, type SimCommand } from '../sim/commands.js';
import type { WorldState } from '../sim/types.js';

function makeWorld(queue: SimCommand[] = []): WorldState {
  return { tick: 0, commandQueue: queue } as unknown as WorldState;
}
const noop = (tick = 0): SimCommand => ({ type: 'NoOp', issuedAtTick: tick });

describe('enqueueCommand', () => {
  it('pushes when NOT paused and UNDER the non-Sync cap', () => {
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK - 1 }, (_, i) => noop(i)));
    const ok = enqueueCommand(world, noop(999), false);
    expect(ok).toBe(true);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK);
  });

  it('REFUSES (returns false, no push) when NOT paused AT the non-Sync cap', () => {
    // The fast-stroke fix: the cap is enforced UNCONDITIONALLY. tick.ts would
    // drop anything past 64 regardless of pause state, so refusing here lets the
    // caller defer the command instead of silently losing it.
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => noop(i)));
    const ok = enqueueCommand(world, noop(999), false);
    expect(ok).toBe(false);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK);
  });

  it('pushes while paused when under the non-Sync cap', () => {
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK - 1 }, (_, i) => noop(i)));
    const ok = enqueueCommand(world, noop(), true);
    expect(ok).toBe(true);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK);
  });

  it('REFUSES (returns false, no push) while paused at the non-Sync cap', () => {
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => noop(i)));
    const ok = enqueueCommand(world, noop(), true);
    expect(ok).toBe(false);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK);
  });

  it('does NOT count SyncAIState toward the cap (mirrors tick.ts accounting)', () => {
    // A queue full of SyncAIState should NOT block a real player command while paused.
    const syncCmd = { type: 'SyncAIState' } as unknown as SimCommand;
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK + 5 }, () => syncCmd));
    const ok = enqueueCommand(world, noop(), true);
    expect(ok).toBe(true);
  });

  it('a SyncAIState command itself is never capped while paused', () => {
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK }, (_, i) => noop(i)));
    const syncCmd = { type: 'SyncAIState' } as unknown as SimCommand;
    const ok = enqueueCommand(world, syncCmd, true);
    expect(ok).toBe(true);
  });
});
