// jev-vocab.test.ts — the client's labels against the server's vocabulary.
//
// `jev-vocab.json` here is a COPY of the website Lambda's
// `infra/lambdas/src/jev-vocab.json` (the list the server validates every beat
// against). JSON cannot hold a comment, so the note lives here: when a label,
// bucket table or key set changes on either side, update BOTH copies together.
// Every bucket table the encoder uses has a same-named list in the vocabulary.

import { describe, it, expect } from 'vitest';
import vocab from './jev-vocab.json';
import { queenHealth, tablesFor } from './jev-encode.js';
import { DIG_DESCRIBE, RATIO_CANDIDATES } from './jev-candidates.js';
import type { DigDirection, FoodPriorityKey, PostureKey, RatioKey } from './jev-types.js';
import type { SpiderBehaviorState } from '../sim/types.js';

const TABLES = [
  'fraction',
  'ratioVs',
  'count',
  'workers',
  'brood',
  'distance',
  'pileSize',
] as const;

describe('vocabulary agreement with the server', () => {
  for (const mode of ['coarse', 'fine'] as const) {
    it.each(TABLES)(`${mode} %s labels are all in the server vocabulary`, (name) => {
      const labels = tablesFor(mode)[name].labels;
      const allowed: readonly string[] = vocab.buckets[name];
      for (const label of labels) expect(allowed).toContain(label);
    });
  }

  it('every vocabulary bucket list is covered by a client table', () => {
    expect([...Object.keys(vocab.buckets)].sort()).toEqual([...TABLES].sort());
  });

  it('queenHealth only emits vocabulary words', () => {
    const out = new Set([queenHealth(0, 50), queenHealth(30, 50), queenHealth(50, 50)]);
    expect([...out].sort()).toEqual([...vocab.queenHealth].sort());
  });

  it('every sim spider state, lower-cased as the encoder sends it, is a spider behaviour word', () => {
    // A Record over the union: a new sim state fails to compile here until it is listed.
    const states: Record<SpiderBehaviorState, true> = {
      Patrolling: true,
      Hunting: true,
      Chasing: true,
      Striking: true,
      Feeding: true,
      Rampaging: true,
      Retreating: true,
    };
    for (const s of Object.keys(states)) expect(vocab.spiderBehavior).toContain(s.toLowerCase());
  });

  it('ratio, dig, posture and food-priority keys are in the vocabulary', () => {
    const postures = [
      'recall',
      'guard_home',
      'hold_midfield',
      'assault',
      'contest_pile_a',
      'contest_pile_b',
      'contest_pile_c',
    ] satisfies PostureKey[];
    const foods = ['none', 'pile_a', 'pile_b', 'pile_c'] satisfies FoodPriorityKey[];
    const ratios = Object.keys(RATIO_CANDIDATES) as RatioKey[];
    const digs = Object.keys(DIG_DESCRIBE) as DigDirection[];
    expect([...ratios].sort()).toEqual([...vocab.ratioKeys].sort());
    expect([...digs].sort()).toEqual([...vocab.digKeys].sort());
    expect([...postures].sort()).toEqual([...vocab.postureKeys].sort());
    expect([...foods].sort()).toEqual([...vocab.foodPriorityKeys].sort());
  });

  it('ratio and dig descriptions match the server copy', () => {
    for (const k of Object.keys(RATIO_CANDIDATES) as RatioKey[]) {
      expect(RATIO_CANDIDATES[k].describe).toBe(
        (vocab.descriptions.fight_ratio as Record<string, string>)[k],
      );
    }
    for (const k of Object.keys(DIG_DESCRIBE) as DigDirection[]) {
      expect(DIG_DESCRIBE[k]).toBe((vocab.descriptions.dig as Record<string, string>)[k]);
    }
  });
});
