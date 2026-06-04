// Phase 5 scope: fixed 20Hz accumulator (MS_PER_TICK = 50 constant).
// Phase 8 wires onBeforeTick = copyWorldState; getMsPerTick/getIsPaused remain Phase 9 seams.
// Phase 9 scope: getMsPerTick/SpeedLevel + getIsPaused/pause wired at render/input entry points.
// Platform loop owns the only non-sim write path (world.commandQueue drain).
// FNDN-07 enforcement: ESLint nonSimMutationGuard + scripts/check-sim-boundary.sh (Plan 01).
// The Readonly<WorldState> Pattern 1b seam is Phase 8 scope (render/input entry points).
//
// GameLoopOpts contract:
//   onBeforeTick   - called before each tick fires; Phase 8 wires copyWorldState(world, prevWorld).
//   getMsPerTick   - queried once per frame for dynamic tick duration; Phase 9 wires SpeedLevel.
//   getIsPaused    - queried once per frame; Phase 9 wires pause state.
//   Spiral-of-death clamp = getMsPerTick() × MAX_CATCHUP_TICKS (dynamic, honors variable speed).
import type { WorldState } from '../sim/types.js';
import { GameOutcome } from '../sim/game-over.js';
import type { SimCommand } from '../sim/commands.js';

export const MS_PER_TICK = 50;
export const MAX_CATCHUP_TICKS = 5;

export interface GameLoop {
  update(dtMs: number): void;
  readonly accumulatorMs: number;
  /** Phase 9 Plan 06 — first-class pause. Sets internal paused flag; update() is a total no-op while paused. */
  pause(): void;
  /** Phase 9 Plan 06 — clears paused flag; resets accumulator to 0 to prevent catch-up burst. */
  resume(): void;
  /** Phase 9 Plan 06 — returns current paused flag value. */
  isPaused(): boolean;
}

/** Phase 8/9 extension seam for createGameLoop. All callbacks are optional for backward compat. */
export interface GameLoopOpts {
  /** Phase 8 seam: called before each tick fires. Phase 8 wires copyWorldState. */
  onBeforeTick?: (world: WorldState) => void;
  /** Phase 9 seam: dynamic tick duration for SpeedLevel. Default: () => MS_PER_TICK. */
  getMsPerTick?: () => number;
  /** Phase 9 seam: pause gate. Default: () => false. */
  getIsPaused?: () => boolean;
  /** Phase 9 seam: fires after world.commandQueue.splice(0) returns, before tickFn runs.
   *  Receives the just-drained commands so render-layer callers can push into inputLog
   *  for replay or debugging. Fired every tick (even if no commands — array may be empty). */
  onAfterDrain?: (cmds: readonly SimCommand[]) => void;
  /** Phase 9 seam: fires after tickFn returns, only when outcome !== GameOutcome.None.
   *  Triggers break out of the accumulator loop THIS frame after normal accumulator decrement,
   *  preventing subsequent ticks from firing while the render layer handles win/lose transition. */
  onTickOutcome?: (outcome: GameOutcome) => void;
}

type TickFn = (world: WorldState, commands: readonly SimCommand[]) => GameOutcome;

export function createGameLoop(tickFn: TickFn, world: WorldState, opts?: GameLoopOpts): GameLoop {
  const getMsPerTick = opts?.getMsPerTick ?? (() => MS_PER_TICK);
  const getIsPaused = opts?.getIsPaused;
  const onBeforeTick = opts?.onBeforeTick;
  const onAfterDrain = opts?.onAfterDrain;
  const onTickOutcome = opts?.onTickOutcome;

  let accumulatorMs = 0;
  let paused = false; // Phase 9 Plan 06 — imperative pause flag

  return {
    update(dtMs: number): void {
      // Phase 9 Plan 06: imperative pause gate — total no-op, no accumulator advance.
      if (paused) return;
      // Backward-compat predicate gate (honor existing getIsPaused opt).
      if (getIsPaused?.() === true) return;
      const msPerTick = getMsPerTick(); // queried once per frame
      accumulatorMs += dtMs;
      // PRD §3 spiral-of-death guard: dynamic clamp honors variable speed.
      const maxAcc = msPerTick * MAX_CATCHUP_TICKS;
      if (accumulatorMs > maxAcc) accumulatorMs = maxAcc;
      while (accumulatorMs >= msPerTick) {
        onBeforeTick?.(world); // Phase 8: copyWorldState seam
        const cmds = world.commandQueue.splice(0);
        onAfterDrain?.(cmds); // Phase 9: inputLog seam
        const outcome = tickFn(world, cmds);
        accumulatorMs -= msPerTick;
        if (outcome !== GameOutcome.None && onTickOutcome !== undefined) {
          onTickOutcome(outcome);
          break; // stop firing further ticks this frame
        }
      }
    },
    get accumulatorMs() {
      return accumulatorMs;
    },

    // Phase 9 Plan 06 — first-class pause/resume
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
      // Do NOT carry accumulated delta across the pause boundary — stale delta would
      // cause a burst of catch-up ticks that break determinism. Reset to 0.
      accumulatorMs = 0;
    },
    isPaused(): boolean {
      return paused;
    },
  };
}
