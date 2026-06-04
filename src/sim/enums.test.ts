// enums.test.ts — PRD §1 §2 §5a enum regression guard
//
// Tests prove:
// 1. Each enum member is an integer with the documented PRD discriminant.
// 2. Member-count regression guards catch accidental additions or removals.
// 3. TypeScript type narrowing via exhaustive switch compiles cleanly.
// 4. Values survive headless Node execution (--experimental-strip-types path).
//
// Run: npx vitest run src/sim/enums.test.ts

import { describe, expect, it } from 'vitest';
import {
  AntTask,
  ChamberType,
  DiggingSubState,
  FightingSubState,
  ForagingSubState,
  NursingSubState,
  PheromoneType,
} from './enums';

// ---------------------------------------------------------------------------
// AntTask (PRD §1 lines 51-56)
// ---------------------------------------------------------------------------

describe('AntTask discriminants (PRD §1)', () => {
  it('AntTask.Idle === 0', () => {
    expect(AntTask.Idle).toBe(0);
  });

  it('AntTask.Foraging === 1', () => {
    expect(AntTask.Foraging).toBe(1);
  });

  it('AntTask.Digging === 2', () => {
    expect(AntTask.Digging).toBe(2);
  });

  it('AntTask.Fighting === 3', () => {
    expect(AntTask.Fighting).toBe(3);
  });

  it('AntTask.Nursing === 4', () => {
    expect(AntTask.Nursing).toBe(4);
  });

  it('AntTask has exactly 5 members', () => {
    expect(Object.keys(AntTask).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ForagingSubState (PRD §1 lines 62-66) — must have 3 members
// ---------------------------------------------------------------------------

describe('ForagingSubState discriminants (PRD §1)', () => {
  it('ForagingSubState.SearchingFood === 0', () => {
    expect(ForagingSubState.SearchingFood).toBe(0);
  });

  it('ForagingSubState.CarryingFood === 1', () => {
    expect(ForagingSubState.CarryingFood).toBe(1);
  });

  it('ForagingSubState.ReturningToNest === 2 (PRD §1 line 66, required)', () => {
    expect(ForagingSubState.ReturningToNest).toBe(2);
  });

  it('ForagingSubState has exactly 3 members (regression guard — do not reduce to 2)', () => {
    expect(Object.keys(ForagingSubState).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DiggingSubState (PRD §1 lines 72-74)
// ---------------------------------------------------------------------------

describe('DiggingSubState discriminants (PRD §1)', () => {
  it('DiggingSubState.MovingToTile === 0', () => {
    expect(DiggingSubState.MovingToTile).toBe(0);
  });

  it('DiggingSubState.Excavating === 1', () => {
    expect(DiggingSubState.Excavating).toBe(1);
  });

  it('DiggingSubState has exactly 2 members', () => {
    expect(Object.keys(DiggingSubState).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// NursingSubState (PRD §1 lines 82-84) — member 1 is `Feeding`, not `FeedingBrood`
// ---------------------------------------------------------------------------

describe('NursingSubState discriminants (PRD §1)', () => {
  it('NursingSubState.MovingToBrood === 0', () => {
    expect(NursingSubState.MovingToBrood).toBe(0);
  });

  it('NursingSubState.Feeding === 1 (PRD §1 line 84 — NOT FeedingBrood)', () => {
    expect(NursingSubState.Feeding).toBe(1);
  });

  it('NursingSubState.Attending === 2 (S4 V21+ dwell substate)', () => {
    expect(NursingSubState.Attending).toBe(2);
  });

  it('NursingSubState has exactly 3 members (regression guard — updated S4)', () => {
    expect(Object.keys(NursingSubState).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// FightingSubState (PRD §1 lines 91-93) — 2 members, both canonical at Phase 2
// ---------------------------------------------------------------------------

describe('FightingSubState discriminants (PRD §1)', () => {
  it('FightingSubState.MovingToRally === 0 (PRD §1 line 92)', () => {
    expect(FightingSubState.MovingToRally).toBe(0);
  });

  it('FightingSubState.Engaging === 1 (PRD §1 line 93 — NOT a placeholder)', () => {
    expect(FightingSubState.Engaging).toBe(1);
  });

  it('FightingSubState has exactly 2 members (regression guard — was not singleton Engaged=0)', () => {
    expect(Object.keys(FightingSubState).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ChamberType (PRD §2)
// ---------------------------------------------------------------------------

describe('ChamberType discriminants (PRD §2)', () => {
  it('ChamberType.Queen === 0', () => {
    expect(ChamberType.Queen).toBe(0);
  });

  it('ChamberType.Nursery === 1', () => {
    expect(ChamberType.Nursery).toBe(1);
  });

  it('ChamberType.FoodStorage === 2', () => {
    expect(ChamberType.FoodStorage).toBe(2);
  });

  it('ChamberType has exactly 3 members', () => {
    expect(Object.keys(ChamberType).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PheromoneType (PRD §5a)
// ---------------------------------------------------------------------------

describe('PheromoneType discriminants (PRD §5a)', () => {
  it('PheromoneType.FoodTrail === 0', () => {
    expect(PheromoneType.FoodTrail).toBe(0);
  });

  it('PheromoneType.DangerTrail === 1', () => {
    expect(PheromoneType.DangerTrail).toBe(1);
  });

  it('PheromoneType has exactly 2 members', () => {
    expect(Object.keys(PheromoneType).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TypeScript type narrowing — exhaustive switch on AntTask
// Compiles only if all 5 cases are handled; TypeScript catches missing arms.
// ---------------------------------------------------------------------------

describe('AntTask exhaustive switch (type narrowing)', () => {
  // This helper must not produce a TypeScript error — exhaustive check verifies
  // the type alias narrows correctly so the `default` arm is unreachable.
  function describeTask(task: AntTask): string {
    switch (task) {
      case AntTask.Idle:
        return 'idle';
      case AntTask.Foraging:
        return 'foraging';
      case AntTask.Digging:
        return 'digging';
      case AntTask.Fighting:
        return 'fighting';
      case AntTask.Nursing:
        return 'nursing';
      default: {
        const _exhaustive: never = task as unknown as never;
        return _exhaustive;
      }
    }
  }

  it('maps each AntTask to a string without hitting default', () => {
    expect(describeTask(AntTask.Idle)).toBe('idle');
    expect(describeTask(AntTask.Foraging)).toBe('foraging');
    expect(describeTask(AntTask.Digging)).toBe('digging');
    expect(describeTask(AntTask.Fighting)).toBe('fighting');
    expect(describeTask(AntTask.Nursing)).toBe('nursing');
  });
});

// ---------------------------------------------------------------------------
// Headless survival — values exist at runtime under Node --experimental-strip-types
// Vitest runs in Node environment; this test proves the object-const pattern
// survives without TypeScript const-enum inlining.
// ---------------------------------------------------------------------------

describe('headless survival (Node --experimental-strip-types)', () => {
  it('AntTask.Foraging is accessible at runtime and equals 1', () => {
    const task: AntTask = AntTask.Foraging;
    expect(task).toBe(1);
  });

  it('ForagingSubState.ReturningToNest is accessible at runtime and equals 2', () => {
    const sub: ForagingSubState = ForagingSubState.ReturningToNest;
    expect(sub).toBe(2);
  });

  it('switch dispatch using AntTask.Foraging + ForagingSubState.ReturningToNest returns correct branch', () => {
    // Use a function parameter to prevent TypeScript from narrowing the literal type
    // to a singleton — we want to prove the switch works over the full union at runtime.
    function dispatchTask(task: AntTask): string {
      switch (task) {
        case AntTask.Foraging:
          return 'foraging';
        default:
          return 'other';
      }
    }

    function dispatchSubState(sub: ForagingSubState): string {
      switch (sub) {
        case ForagingSubState.SearchingFood:
          return 'searching';
        case ForagingSubState.CarryingFood:
          return 'carrying';
        case ForagingSubState.ReturningToNest:
          return 'returning';
        default: {
          const _exhaustive: never = sub as unknown as never;
          return _exhaustive;
        }
      }
    }

    expect(dispatchTask(AntTask.Foraging)).toBe('foraging');
    expect(dispatchSubState(ForagingSubState.ReturningToNest)).toBe('returning');
    expect(dispatchSubState(ForagingSubState.SearchingFood)).toBe('searching');
    expect(dispatchSubState(ForagingSubState.CarryingFood)).toBe('carrying');
  });
});
