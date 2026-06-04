import { describe, it, expect, vi } from 'vitest';
import { createGameLoop, MS_PER_TICK, MAX_CATCHUP_TICKS } from './game-loop.js';
import { createWorldState } from '../sim/types.js';
import type { WorldState } from '../sim/types.js';
import { GameOutcome } from '../sim/game-over.js';
import type { SimCommand } from '../sim/commands.js';

// Helper: create a spy tick function that records calls without advancing rngState etc.
function makeSpyTick(): {
  fn: (
    world: ReturnType<typeof createWorldState>,
    cmds: readonly SimCommand[],
  ) => (typeof GameOutcome)[keyof typeof GameOutcome];
  calls: Array<{ cmdCount: number }>;
} {
  const calls: Array<{ cmdCount: number }> = [];
  const fn = (
    _world: ReturnType<typeof createWorldState>,
    cmds: readonly SimCommand[],
  ): (typeof GameOutcome)[keyof typeof GameOutcome] => {
    calls.push({ cmdCount: cmds.length });
    return GameOutcome.None;
  };
  return { fn, calls };
}

// Helper: create a NoOp command
function makeNoOp(tick: number): SimCommand {
  return { type: 'NoOp', issuedAtTick: tick };
}

describe('accumulator — within-budget regime', () => {
  it('three update(16.67) calls fire exactly 1 tick (RESEARCH.md Pattern 4)', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(16.67); // acc=16.67, ticks=0
    expect(calls.length).toBe(0);
    loop.update(16.67); // acc=33.34, ticks=0
    expect(calls.length).toBe(0);
    loop.update(16.67); // acc=50.01, ticks=1
    expect(calls.length).toBe(1);
  });

  it('update(50) fires exactly 1 tick', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(MS_PER_TICK);
    expect(calls.length).toBe(1);
  });

  it('update(49) then update(1) fires exactly 1 tick (50ms accumulated)', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(49);
    expect(calls.length).toBe(0);
    loop.update(1);
    expect(calls.length).toBe(1);
  });

  it('update(49) then update(2) fires exactly 1 tick (51ms, 1ms residual)', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(49);
    expect(calls.length).toBe(0);
    loop.update(2);
    expect(calls.length).toBe(1);
    expect(loop.accumulatorMs).toBeCloseTo(1, 5);
  });

  it('update(100) fires exactly 2 ticks (floor(100/50)=2)', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(100);
    expect(calls.length).toBe(2);
  });
});

describe('accumulator — over-budget regime', () => {
  it('update(1000) fires exactly MAX_CATCHUP_TICKS (5) ticks — spiral-of-death guard (PRD §3)', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(1000); // would be 20 ticks without clamp
    expect(calls.length).toBe(MAX_CATCHUP_TICKS);
    expect(calls.length).toBe(5);
  });

  it('update(10000) still fires exactly MAX_CATCHUP_TICKS (5) ticks — clamp is magnitude-independent', () => {
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(10000);
    expect(calls.length).toBe(MAX_CATCHUP_TICKS);
  });

  it('after update(1000), accumulatorMs === 0 (clamp=250; 5 ticks drain 250; residual=0)', () => {
    const { fn } = makeSpyTick();
    const loop = createGameLoop(fn, createWorldState(42));

    loop.update(1000); // clamp to 250; 5*50=250 drained; residual = 0
    expect(loop.accumulatorMs).toBe(0);
  });
});

describe('commandQueue drain', () => {
  it('drains commandQueue before tick call (3 commands → tickSpy called with cmdCount=3)', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world);

    world.commandQueue.push(makeNoOp(0), makeNoOp(0), makeNoOp(0));
    loop.update(MS_PER_TICK);

    expect(world.commandQueue.length).toBe(0); // drained before tick
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmdCount).toBe(3);
  });

  it('100 commands passed through intact to tickSpy (cap enforcement is inside tick(), not accumulator)', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world);

    for (let i = 0; i < 100; i++) {
      world.commandQueue.push(makeNoOp(0));
    }
    loop.update(MS_PER_TICK);

    expect(calls.length).toBe(1);
    expect(calls[0]!.cmdCount).toBe(100);
  });
});

describe('createGameLoop — Phase 8 opts', () => {
  // ── onBeforeTick ──────────────────────────────────────────────────────────

  it('onBeforeTick is called once per tick that fires', () => {
    const world = createWorldState(42);
    const { fn } = makeSpyTick();
    const spy = vi.fn();
    const loop = createGameLoop(fn, world, { onBeforeTick: spy });

    loop.update(50); // 1 tick
    expect(spy).toHaveBeenCalledTimes(1);

    loop.update(150); // 3 more ticks
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('onBeforeTick receives the live world reference and fires before commandQueue is spliced', () => {
    const world = createWorldState(42);
    const receivedWorld: WorldState[] = [];
    const queueLengthAtHook: number[] = [];
    // Push a sentinel command; onBeforeTick should see it still in the queue (splice happens after).
    world.commandQueue.push({ type: 'NoOp', issuedAtTick: 0 });
    const { fn } = makeSpyTick();
    const loop = createGameLoop(fn, world, {
      onBeforeTick: (w) => {
        receivedWorld.push(w);
        queueLengthAtHook.push(w.commandQueue.length);
      },
    });

    loop.update(50); // 1 tick
    expect(receivedWorld[0]).toBe(world); // same object reference
    expect(queueLengthAtHook[0]).toBe(1); // command still present when hook fires
  });

  it('onBeforeTick is NOT called when no tick fires', () => {
    const world = createWorldState(42);
    const { fn } = makeSpyTick();
    const spy = vi.fn();
    const loop = createGameLoop(fn, world, { onBeforeTick: spy });

    loop.update(30); // 30 < 50, no tick
    expect(spy).toHaveBeenCalledTimes(0);
  });

  // ── getMsPerTick (dynamic) ─────────────────────────────────────────────────

  it('getMsPerTick=()=>100 halves the tick rate', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world, { getMsPerTick: () => 100 });

    loop.update(150); // floor(150/100) = 1 tick; 50ms residual
    expect(calls.length).toBe(1);
  });

  it('changing getMsPerTick mid-stream takes effect on next update', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    let mpt = 50;
    const loop = createGameLoop(fn, world, { getMsPerTick: () => mpt });

    loop.update(50); // mpt=50 → 1 tick
    expect(calls.length).toBe(1);

    mpt = 100;
    loop.update(100); // mpt=100, acc=0+100 → 1 tick; 0ms residual
    expect(calls.length).toBe(2);

    loop.update(50); // mpt=100, acc=0+50 → 0 ticks (50 < 100)
    expect(calls.length).toBe(2);
  });

  it('spiral-of-death clamp uses dynamic msPerTick (100×5=500, not old 250)', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world, { getMsPerTick: () => 100 });

    loop.update(10000); // clamp to 100×5=500 → exactly 5 ticks
    expect(calls.length).toBe(MAX_CATCHUP_TICKS);
    expect(loop.accumulatorMs).toBe(0);
  });

  // ── getIsPaused ────────────────────────────────────────────────────────────

  it('getIsPaused=()=>true prevents all ticks and does not accumulate', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world, { getIsPaused: () => true });

    loop.update(1000);
    expect(calls.length).toBe(0);
    expect(loop.accumulatorMs).toBe(0);
  });

  it('toggling pause resumes from zero accumulator', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    let paused = true;
    const loop = createGameLoop(fn, world, { getIsPaused: () => paused });

    loop.update(1000); // paused → 0 ticks, acc stays 0
    expect(calls.length).toBe(0);

    paused = false;
    loop.update(100); // acc=0+100 → 2 ticks (100/50)
    expect(calls.length).toBe(2);
  });

  // ── backward compatibility ─────────────────────────────────────────────────

  it('createGameLoop(tick, world) with no opts behaves identically to original contract', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world); // no opts

    loop.update(10000); // clamp = 50×5=250 → 5 ticks
    expect(calls.length).toBe(MAX_CATCHUP_TICKS);
    expect(loop.accumulatorMs).toBe(0);
  });
});

describe('GameLoopOpts Phase 9 seams', () => {
  it('onAfterDrain fires with the drained commands array in order', () => {
    const world = createWorldState(42);
    world.commandQueue.push(makeNoOp(1), makeNoOp(2));
    const drainedArrays: (readonly SimCommand[])[] = [];
    const loop = createGameLoop(makeSpyTick().fn, world, {
      onAfterDrain: (cmds) => {
        drainedArrays.push(cmds);
      },
    });
    loop.update(MS_PER_TICK);
    expect(drainedArrays.length).toBe(1);
    expect(drainedArrays[0]!.length).toBe(2);
    expect(drainedArrays[0]![0]!.issuedAtTick).toBe(1);
    expect(drainedArrays[0]![1]!.issuedAtTick).toBe(2);
    expect(world.commandQueue.length).toBe(0);
  });

  it('onTickOutcome does NOT fire when tickFn returns None', () => {
    const world = createWorldState(42);
    const { fn } = makeSpyTick(); // always returns None
    const outcomeSpy = vi.fn();
    const loop = createGameLoop(fn, world, { onTickOutcome: outcomeSpy });
    loop.update(MS_PER_TICK * 3);
    expect(outcomeSpy).toHaveBeenCalledTimes(0);
  });

  it('onTickOutcome fires exactly once and breaks accumulator loop when tickFn returns Victory', () => {
    const world = createWorldState(42);
    let callCount = 0;
    const tickFn = (): (typeof GameOutcome)[keyof typeof GameOutcome] => {
      callCount += 1;
      return callCount >= 2 ? GameOutcome.Victory : GameOutcome.None;
    };
    const outcomeSpy = vi.fn();
    const loop = createGameLoop(tickFn, world, { onTickOutcome: outcomeSpy });
    // 4 ticks worth of time: tickFn should only fire 2 times (break on Victory)
    loop.update(MS_PER_TICK * 4);
    expect(callCount).toBe(2);
    expect(outcomeSpy).toHaveBeenCalledTimes(1);
    expect(outcomeSpy).toHaveBeenCalledWith(GameOutcome.Victory);
    // 2 ticks were consumed (1 None + 1 Victory); 2 ticks remain in accumulator
    expect(loop.accumulatorMs).toBe(MS_PER_TICK * 2);
  });

  it('onTickOutcome fires on Defeat and MutualDestruction identically', () => {
    for (const outcome of [GameOutcome.Defeat, GameOutcome.MutualDestruction]) {
      const world = createWorldState(42);
      let callCount = 0;
      const tickFn = (): (typeof GameOutcome)[keyof typeof GameOutcome] => {
        callCount += 1;
        return callCount >= 2 ? outcome : GameOutcome.None;
      };
      const outcomeSpy = vi.fn();
      const loop = createGameLoop(tickFn, world, { onTickOutcome: outcomeSpy });
      loop.update(MS_PER_TICK * 4);
      expect(callCount).toBe(2);
      expect(outcomeSpy).toHaveBeenCalledTimes(1);
      expect(outcomeSpy).toHaveBeenCalledWith(outcome);
      expect(loop.accumulatorMs).toBe(MS_PER_TICK * 2);
    }
  });

  it('backward-compat: createGameLoop with only onBeforeTick compiles and runs', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world, { onBeforeTick: () => {} });
    loop.update(MS_PER_TICK);
    expect(calls.length).toBe(1);
  });

  it('backward-compat: createGameLoop with no opts compiles and runs', () => {
    const world = createWorldState(42);
    const { fn, calls } = makeSpyTick();
    const loop = createGameLoop(fn, world);
    loop.update(MS_PER_TICK);
    expect(calls.length).toBe(1);
  });
});

describe('GameLoop pause()/resume() (Phase 9 Plan 06 Task 1)', () => {
  it('pause() prevents any tickFn call even when deltaMs >> msPerTick', () => {
    const tickSpy = vi.fn(() => GameOutcome.None);
    const world = createWorldState(1);
    const loop = createGameLoop(tickSpy, world);
    loop.pause();
    loop.update(MS_PER_TICK * 5); // would fire 5 ticks if running
    expect(tickSpy).toHaveBeenCalledTimes(0);
    expect(loop.isPaused()).toBe(true);
  });

  it('resume() restores tickFn invocation on the next update()', () => {
    const tickSpy = vi.fn(() => GameOutcome.None);
    const world = createWorldState(1);
    const loop = createGameLoop(tickSpy, world);
    loop.pause();
    loop.update(MS_PER_TICK * 5);
    loop.resume();
    loop.update(MS_PER_TICK);
    expect(tickSpy).toHaveBeenCalledTimes(1);
    expect(loop.isPaused()).toBe(false);
  });

  it('resume() resets accumulator so there is NO catch-up burst', () => {
    const tickSpy = vi.fn(() => GameOutcome.None);
    const world = createWorldState(1);
    const loop = createGameLoop(tickSpy, world);
    // Run once to advance accumulator near a tick boundary
    loop.update(MS_PER_TICK - 1); // accumulator = MS_PER_TICK - 1, 0 ticks
    loop.pause();
    loop.update(MS_PER_TICK * 100); // paused — no-op; accumulator preserved internally BUT ignored on resume
    loop.resume(); // resume resets accumulator to 0
    loop.update(MS_PER_TICK - 1); // 0 ticks (accumulator rebuilds from zero)
    expect(tickSpy).toHaveBeenCalledTimes(0);
    loop.update(1); // crosses boundary → exactly 1 tick
    expect(tickSpy).toHaveBeenCalledTimes(1);
  });

  it('pause() is idempotent', () => {
    const world = createWorldState(1);
    const loop = createGameLoop(() => GameOutcome.None, world);
    loop.pause();
    loop.pause();
    expect(loop.isPaused()).toBe(true);
  });

  it('resume() on a running loop is idempotent', () => {
    const world = createWorldState(1);
    const loop = createGameLoop(() => GameOutcome.None, world);
    loop.resume();
    expect(loop.isPaused()).toBe(false);
  });

  it('getIsPaused opt still gates ticks independently of pause()/resume()', () => {
    const tickSpy = vi.fn(() => GameOutcome.None);
    const world = createWorldState(1);
    let externallyPaused = true;
    const loop = createGameLoop(tickSpy, world, { getIsPaused: () => externallyPaused });
    loop.update(MS_PER_TICK);
    expect(tickSpy).toHaveBeenCalledTimes(0); // gated by getIsPaused
    externallyPaused = false;
    loop.update(MS_PER_TICK);
    expect(tickSpy).toHaveBeenCalledTimes(1);
  });
});

describe('determinism — accumulator + tick composition', () => {
  it('two loops with same seed and same update schedule produce identical world state (SCEN-06)', async () => {
    // Use the real tick from src/sim/tick.ts to verify end-to-end determinism.
    const { tick } = await import('../sim/tick.js');

    const worldA = createWorldState(12345);
    const worldB = createWorldState(12345);

    const loopA = createGameLoop(tick, worldA);
    const loopB = createGameLoop(tick, worldB);

    // Same update schedule applied to both loops.
    const schedule = [16, 17, 50, 33, 1000, 25, 50];
    for (const dt of schedule) {
      loopA.update(dt);
      loopB.update(dt);
    }

    // Sim-state fields must be bit-identical.
    expect({
      tick: worldA.tick,
      rngState: worldA.rngState,
      nextEntityId: worldA.nextEntityId,
    }).toEqual({
      tick: worldB.tick,
      rngState: worldB.rngState,
      nextEntityId: worldB.nextEntityId,
    });
  });
});
