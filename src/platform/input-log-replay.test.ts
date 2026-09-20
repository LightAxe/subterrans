// input-log-replay.test.ts — issue #296 unit coverage for the batch-boundary
// recovery rules. The end-to-end proof (live run vs replay, byte-for-byte)
// lives in src/render/input-log-replay.integration.test.ts; this file pins the
// individual rules so a failure there is easy to localize.

import { describe, it, expect } from 'vitest';
import {
  stampDrainTicks,
  drainTickOf,
  indexByDrainTick,
  indexByIssuedAtTick,
  summarizeDrainTickSource,
  SIM_SELF_EMIT_DRAIN_LAG,
} from './input-log-replay.js';
import type { SimCommand, CommandOrigin } from '../sim/commands.js';

/** A minimal command carrying only the fields the batching rules read. */
function cmd(issuedAtTick: number, origin?: CommandOrigin, drainTick?: number): SimCommand {
  const c: SimCommand = { type: 'NoOp', issuedAtTick };
  if (origin !== undefined) c.origin = origin;
  if (drainTick !== undefined) c.drainTick = drainTick;
  return c;
}

describe('stampDrainTicks', () => {
  it('stamps every command in the batch with the drain tick', () => {
    const batch = [cmd(3), cmd(3, 'player'), cmd(2, 'sim')];
    stampDrainTicks(batch, 7);
    expect(batch.map((c) => c.drainTick)).toEqual([7, 7, 7]);
  });

  it('overwrites a stale stamp rather than preserving it', () => {
    // A command can only be drained once, so a pre-existing stamp on a command
    // coming out of the queue means something re-queued it; the live drain is
    // the authority either way.
    const batch = [cmd(1, 'player', 99)];
    stampDrainTicks(batch, 4);
    expect(batch[0]!.drainTick).toBe(4);
  });

  it('is a no-op on an empty batch (drained nothing this tick)', () => {
    expect(() => stampDrainTicks([], 5)).not.toThrow();
  });
});

describe('drainTickOf', () => {
  it('prefers the recorded drainTick over anything derivable', () => {
    // Deliberately inconsistent with the derived rule: recorded wins.
    expect(drainTickOf(cmd(10, 'sim', 10))).toBe(10);
    expect(drainTickOf(cmd(10, 'player', 12))).toBe(12);
  });

  it('derives a sim self-emit as issuedAtTick + 1', () => {
    expect(drainTickOf(cmd(10, 'sim'))).toBe(10 + SIM_SELF_EMIT_DRAIN_LAG);
  });

  it('derives player and ai input at issuedAtTick', () => {
    expect(drainTickOf(cmd(10, 'player'))).toBe(10);
    expect(drainTickOf(cmd(10, 'ai'))).toBe(10);
  });

  it('leaves a provenance-less (pre-#230) command at issuedAtTick', () => {
    // ClearRallyPoint is both player-issuable and sim-emitted, so with no
    // `origin` there is nothing to distinguish them. Guessing +1 would break
    // logs that replay correctly today; keeping issuedAtTick never regresses one.
    expect(drainTickOf(cmd(10))).toBe(10);
  });

  it('ignores a non-integer drainTick and falls back to the derived rule', () => {
    const bad = { type: 'NoOp', issuedAtTick: 10, origin: 'sim', drainTick: 1.5 } as SimCommand;
    expect(drainTickOf(bad)).toBe(11);
    const worse = {
      type: 'NoOp',
      issuedAtTick: 10,
      origin: 'sim',
      drainTick: 'nope',
    } as unknown as SimCommand;
    expect(drainTickOf(worse)).toBe(11);
  });
});

describe('indexByDrainTick', () => {
  it('groups by drain tick and preserves within-batch order', () => {
    const a = cmd(1, 'player', 1);
    const b = cmd(1, 'ai', 1);
    const c = cmd(1, 'sim', 2);
    const byTick = indexByDrainTick([a, b, c]);
    expect(byTick[1]).toEqual([a, b]);
    expect(byTick[2]).toEqual([c]);
  });

  it('leaves ticks that drained nothing as holes the caller reads as []', () => {
    const byTick = indexByDrainTick([cmd(0, 'player', 0), cmd(0, 'player', 3)]);
    expect(byTick[1]).toBeUndefined();
    expect(byTick[1] ?? []).toEqual([]);
  });

  it('returns an empty index for an empty log', () => {
    expect(indexByDrainTick([])).toEqual([]);
  });

  it('separates a self-emit from the input issued on the same tick', () => {
    // The whole bug in one assertion: both are stamped issuedAtTick=5, but the
    // sim's own command was not drained until 6.
    const input = cmd(5, 'player');
    const selfEmit = cmd(5, 'sim');
    const byTick = indexByDrainTick([input, selfEmit]);
    expect(byTick[5]).toEqual([input]);
    expect(byTick[6]).toEqual([selfEmit]);
    // The pre-#296 grouping put them in the same batch.
    expect(indexByIssuedAtTick([input, selfEmit])[5]).toEqual([input, selfEmit]);
  });
});

describe('summarizeDrainTickSource', () => {
  it('counts recorded, derived-self-emit and derived-at-issue separately', () => {
    const summary = summarizeDrainTickSource([
      cmd(1, 'player', 1),
      cmd(2, 'sim', 3),
      cmd(4, 'sim'),
      cmd(5, 'ai'),
      cmd(6),
    ]);
    expect(summary).toEqual({ recorded: 2, derivedSelfEmit: 1, derivedAtIssue: 2 });
  });
});
