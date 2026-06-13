// command-queue.test.ts — Vitest unit tests for the input-side enqueueCommand
// paused-cap helper (Stage 1 controls rework, issue #18, Codex R1-6/R2-8).

import { describe, it, expect } from 'vitest';
import { enqueueCommand } from './command-queue.js';
import { MAX_COMMANDS_PER_TICK, type SimCommand } from '../sim/commands.js';
import type { WorldState } from '../sim/types.js';

function makeWorld(queue: SimCommand[] = []): WorldState {
  return { tick: 0, commandQueue: queue } as unknown as WorldState;
}
const noop = (tick = 0): SimCommand => ({ type: 'NoOp', issuedAtTick: tick });

describe('enqueueCommand', () => {
  it('always pushes when NOT paused (steady-state queue drains each tick)', () => {
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK + 50 }, (_, i) => noop(i)));
    const ok = enqueueCommand(world, noop(999), false);
    expect(ok).toBe(true);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK + 51);
  });

  it('pushes while paused when under the non-Sync cap', () => {
    const world = makeWorld(Array.from({ length: MAX_COMMANDS_PER_TICK - 1 }, (_, i) => noop(i)));
    const ok = enqueueCommand(world, noop(), true);
    expect(ok).toBe(true);
    expect(world.commandQueue).toHaveLength(MAX_COMMANDS_PER_TICK);
  });

  it('DROPS (returns false, no push) while paused at the non-Sync cap', () => {
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
