// src/sim/ant/ant-system.barrel.test.ts
// #212: guards the PUBLIC API surface of the ant-system barrel. If the split ever
// drops (or accidentally widens) a re-export, this fails — tests repointing to the
// new sub-modules would otherwise mask a missing barrel export that production
// consumers (tick.ts / harness.ts) still import from ./ant-system.js.
import { describe, it, expect } from 'vitest';
import * as barrel from './ant-system.js';
import type { CardinalStep } from './ant-system.js';

// The exact public function surface of the pre-split ant-system.ts (21 functions).
const PUBLIC_FUNCTIONS = [
  'antDepositFood',
  'antPickupFood',
  'canEnterSurfaceTile',
  'canEnterUndergroundTile',
  'chooseExcursionDirection',
  'getTaskDirection',
  'pickCardinalStep',
  'pickInvaderUndergroundStep',
  'pickNearestHostileUnderground',
  'pickSurfaceDetour',
  'routeForagerPriority',
  'tickAntMovement',
  'tickDigExecution',
  'tickExcursionBoundary',
  'tickForagerActions',
  'tickIdleReserveAndFlee',
  'tickNurseActions',
  'tickPheromoneDeposit',
  'tickSearchLeash',
  'unpackStepDx',
  'unpackStepDy',
  'updateFightAntTargets',
] as const;

describe('ant-system barrel public API (#212)', () => {
  for (const name of PUBLIC_FUNCTIONS) {
    it(`re-exports ${name} as a function`, () => {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function');
    });
  }

  it('exports EXACTLY the 22 public functions (no accidental widening or narrowing)', () => {
    const exportedFns = Object.keys(barrel)
      .filter((k) => typeof (barrel as Record<string, unknown>)[k] === 'function')
      .sort();
    expect(exportedFns).toEqual([...PUBLIC_FUNCTIONS].sort());
  });

  it('pins the CardinalStep type re-export', () => {
    // Compile-time proof the type re-export resolves; runtime sanity on the shape.
    const step: CardinalStep = { dx: 0, dy: 0 };
    expect(step).toEqual({ dx: 0, dy: 0 });
  });
});
