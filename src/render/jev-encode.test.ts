// jev-encode.test.ts — bucketing, the digit-free state contract, question
// shaping and answer decoding. Ported from the spike's encode tests.
//
// Fixtures are hand-built here on purpose: `encodeBeat` is a pure function of
// (facts, candidates), so a real world would only re-test jev-candidates.ts.
// The candidate-legality half of the contract lives in jev-candidates.test.ts.

import { describe, it, expect } from 'vitest';
import {
  JEV_ID_PATTERN,
  JEV_MAX_QUESTIONS,
  bucket,
  buildQuestions,
  containsDigits,
  decodeAnswers,
  encodeBeat,
  tablesFor,
  type JevAnswerMap,
} from './jev-encode.js';
import { DIG_DESCRIBE, RATIO_CANDIDATES } from './jev-candidates.js';
import type { CandidateSet, DigDirection, RawFacts } from './jev-types.js';

const ALL_DIG: readonly DigDirection[] = [
  'deeper',
  'wider_left',
  'wider_right',
  'toward_surface',
  'hold',
];

function makeFacts(over: Partial<RawFacts> = {}): RawFacts {
  return {
    tick: 5000,
    ownWorkers: 20,
    oppWorkers: 18,
    ownBrood: 6,
    ownFightersSurface: 3,
    ownForagersOut: 5,
    oppFightersSurface: 2,
    oppFightersNearOurEntrance: 0,
    foodTotal: 1000,
    foodCapacity: 4000,
    storageChambers: 1,
    ownEntrancesOpen: 1,
    oppEntrancesOpen: 1,
    spider: null,
    piles: [
      {
        id: 7,
        tile: { x: 10, y: 3 },
        remaining: 30,
        initial: 40,
        distOwn: 8,
        distOpp: 40,
        contested: false,
      },
      {
        id: 9,
        tile: { x: 40, y: 2 },
        remaining: 5,
        initial: 40,
        distOwn: 30,
        distOpp: 12,
        contested: true,
      },
    ],
    ownLossesRecent: 1,
    oppLossesRecent: 2,
    ownKillsRecent: 0,
    currentRatio: { forage: 7, fight: 3 },
    currentPosture: 'recall',
    ...over,
  };
}

function makeCandidates(facts: RawFacts, over: Partial<CandidateSet> = {}): CandidateSet {
  const dig = Object.fromEntries(
    ALL_DIG.map((d) => [d, { describe: DIG_DESCRIBE[d], available: d !== 'toward_surface' }]),
  ) as CandidateSet['dig'];
  return {
    ratio: RATIO_CANDIDATES,
    posture: {
      recall: { tile: null, describe: 'everyone home' },
      guard_home: { tile: { x: 20, y: 0 }, describe: 'hold our entrance' },
      assault: { tile: { x: 90, y: 0 }, describe: 'storm their entrance' },
    },
    dig,
    foodPriority: {
      none: { pileId: null, tile: null, describe: 'no priority pile' },
      pile_a: { pileId: 7, tile: { x: 10, y: 3 }, describe: 'prioritize pile_a' },
      pile_b: { pileId: 9, tile: { x: 40, y: 2 }, describe: 'prioritize pile_b' },
    },
    spiderPriority: null,
    expandStorage: null,
    facts,
    ...over,
  };
}

describe('buckets', () => {
  it('coarse boundaries', () => {
    const T = tablesFor('coarse');
    expect(bucket(0, T.fraction)).toBe('empty');
    expect(bucket(0.05, T.fraction)).toBe('low');
    expect(bucket(0.299, T.fraction)).toBe('low');
    expect(bucket(0.3, T.fraction)).toBe('half');
    expect(bucket(1, T.fraction)).toBe('full');
    expect(bucket(0, T.count)).toBe('none');
    expect(bucket(3, T.count)).toBe('few');
    expect(bucket(4, T.count)).toBe('many');
    expect(bucket(0.49, T.ratioVs)).toBe('far_fewer');
    expect(bucket(1, T.ratioVs)).toBe('similar');
    expect(bucket(2, T.ratioVs)).toBe('far_more');
  });

  it('fine has strictly more levels than coarse everywhere', () => {
    const C = tablesFor('coarse');
    const F = tablesFor('fine');
    for (const k of Object.keys(C) as (keyof typeof C)[]) {
      expect(F[k].labels.length).toBeGreaterThan(C[k].labels.length);
      expect(F[k].labels.length).toBe(F[k].thresholds.length + 1);
      expect(C[k].labels.length).toBe(C[k].thresholds.length + 1);
    }
  });
});

describe('encodeBeat', () => {
  const facts = makeFacts();
  const cands = makeCandidates(facts);

  it('sends no digits, with or without standing orders', () => {
    for (const orders of ['', 'Strike early and often.']) {
      const enc = encodeBeat(facts, cands, orders, 'coarse');
      expect(containsDigits(enc.state)).toBe(false);
      expect(containsDigits(enc.questions)).toBe(false);
      expect('standing_orders' in enc.state).toBe(orders !== '');
    }
  });

  it('asks the four core questions and stays inside the proxy limits', () => {
    const enc = encodeBeat(facts, cands, '', 'coarse');
    expect(Object.keys(enc.questions)).toEqual(
      expect.arrayContaining(['ratio', 'posture', 'dig', 'food_priority']),
    );
    expect(Object.keys(enc.questions).length).toBeLessThanOrEqual(JEV_MAX_QUESTIONS);
    expect(enc.estimatedTokens).toBeLessThan(3000);
  });

  it('every question id and option key matches the proxy id pattern', () => {
    const enc = encodeBeat(
      facts,
      makeCandidates(facts, {
        spiderPriority: { describe: 'hunt the spider' },
        expandStorage: { anchor: { x: 5, y: 9 }, describe: 'more storage' },
      }),
      '',
      'coarse',
    );
    for (const [id, q] of Object.entries(enc.questions)) {
      expect(id).toMatch(JEV_ID_PATTERN);
      for (const key of Object.keys(q.criteria)) expect(key).toMatch(JEV_ID_PATTERN);
    }
    // v2: the proxy derives its questions from the candidate keys, so those are
    // the ids that actually go over the wire and have to pass its validation.
    const candidates = enc.state.candidates as Record<string, unknown>;
    expect(Object.keys(candidates).length).toBeLessThanOrEqual(JEV_MAX_QUESTIONS);
    for (const [id, group] of Object.entries(candidates)) {
      expect(id).toMatch(JEV_ID_PATTERN);
      if (typeof group === 'string') continue; // yes/no question
      for (const key of Object.keys(group as Record<string, string>)) {
        expect(key).toMatch(JEV_ID_PATTERN);
      }
    }
  });

  it('omits unavailable dig directions from candidates AND from the question', () => {
    const enc = encodeBeat(facts, cands, '', 'coarse');
    const digCandidates = (enc.state.candidates as { dig: Record<string, string> }).dig;
    expect(Object.keys(digCandidates)).not.toContain('toward_surface');
    expect(Object.keys(enc.questions.dig!.criteria)).not.toContain('toward_surface');
    expect(Object.keys(enc.questions.dig!.criteria)).toContain('hold');
  });

  it('reports trends against the previous beat, and "unknown" on the first one', () => {
    const first = encodeBeat(facts, cands, '', 'coarse');
    const own = first.state.our_colony as Record<string, string>;
    expect(own.food_trend).toBe('unknown');
    expect(own.workers_trend).toBe('unknown');
    expect(own.brood_vs_workers).toBeTypeOf('string');

    const later = encodeBeat(
      makeFacts({ foodTotal: 3000, ownWorkers: 12 }),
      cands,
      '',
      'coarse',
      facts,
    );
    const ownLater = later.state.our_colony as Record<string, string>;
    expect(ownLater.food_trend).toBe('rising');
    expect(ownLater.workers_trend).toBe('falling');
  });

  it('worst case (spider rampaging, stores full, orders maxed) stays digit-free and small', () => {
    const worst = makeFacts({
      spider: { state: 'Rampaging', distOwn: 3, distOpp: 90, targetingUs: true },
      foodTotal: 4000,
      ownLossesRecent: 12,
      oppLossesRecent: 40,
      ownKillsRecent: 7,
    });
    const c = makeCandidates(worst, {
      spiderPriority: { describe: 'hunt the spider' },
      expandStorage: { anchor: { x: 5, y: 9 }, describe: 'more storage' },
    });
    const enc = encodeBeat(worst, c, 'x'.repeat(300), 'fine');
    expect(containsDigits(enc.state)).toBe(false);
    expect(enc.estimatedTokens).toBeLessThan(3000);
    expect(enc.questions.spider_priority?.type).toBe('noul');
    expect(enc.questions.expand_storage?.type).toBe('noul');
    expect((enc.state.spider as Record<string, string>).threat).toBe('rampaging_against_us');
  });
});

describe('decodeAnswers', () => {
  const facts = makeFacts();
  const cands = makeCandidates(facts);

  it('decodes valid answers and falls back on invalid ones', () => {
    const q = buildQuestions(cands, false);
    expect(Object.keys(q)).toContain('posture');
    const answers: JevAnswerMap = {
      ratio: {
        type: 'choice',
        choice: 'military',
        confidence: 0.9,
        probabilities: { military: 0.9 },
      },
      posture: { type: 'choice', choice: 'not_an_option', confidence: 0.5, probabilities: {} },
      dig: { type: 'choice', choice: 'deeper', confidence: 0.5, probabilities: {} },
      food_priority: { type: 'choice', choice: 'pile_b', confidence: 0.5, probabilities: {} },
    };
    const { decision, invalid } = decodeAnswers(answers, cands, facts);
    expect(decision.ratio).toBe('military');
    expect(decision.dig).toBe('deeper');
    expect(decision.foodPriority).toBe('pile_b');
    expect(decision.posture).toBe('recall'); // fell back — current posture
    expect(decision.spiderPriority).toBeNull();
    expect(decision.expandStorage).toBeNull();
    expect(invalid).toEqual(['posture']);
  });

  it('accepts the ratio answer under the candidate id the proxy builds its question from', () => {
    // The proxy names each question after the `state.candidates` key it came
    // from, so the split of workers answers as `fight_ratio` while this module's
    // own question map calls it `ratio`. Both have to decode.
    const answers: JevAnswerMap = {
      fight_ratio: {
        type: 'choice',
        choice: 'military',
        confidence: 0.9,
        probabilities: { military: 0.9 },
      },
    };
    const { decision, invalid } = decodeAnswers(answers, cands, facts);
    expect(decision.ratio).toBe('military');
    expect(invalid).not.toContain('ratio');
    expect(invalid).not.toContain('fight_ratio');
  });

  it('never picks an unavailable dig direction, even if asked to', () => {
    const answers: JevAnswerMap = {
      dig: { type: 'choice', choice: 'toward_surface', confidence: 1, probabilities: {} },
    };
    const { decision, invalid } = decodeAnswers(answers, cands, facts);
    expect(decision.dig).toBe('hold');
    expect(invalid).toContain('dig');
  });

  it('treats a missing answer as invalid and keeps the current ratio', () => {
    const { decision, invalid } = decodeAnswers({}, cands, facts);
    expect(decision.ratio).toBe('economy'); // the 7:3 the facts already carry
    expect(invalid).toEqual(['ratio', 'posture', 'dig', 'food_priority']);
  });

  it('thresholds a noul at 0.5 and counts a wrong-typed noul as invalid', () => {
    const c = makeCandidates(facts, {
      spiderPriority: { describe: 'hunt the spider' },
      expandStorage: { anchor: { x: 5, y: 9 }, describe: 'more storage' },
    });
    const yes = decodeAnswers(
      {
        spider_priority: { type: 'noul', noul: 0.5 },
        expand_storage: { type: 'noul', noul: 0.49 },
      },
      c,
      facts,
    );
    expect(yes.decision.spiderPriority).toBe(true);
    expect(yes.decision.expandStorage).toBe(false);

    const wrongType = decodeAnswers(
      { spider_priority: { type: 'choice', choice: 'true', confidence: 1, probabilities: {} } },
      c,
      facts,
    );
    expect(wrongType.decision.spiderPriority).toBe(false);
    expect(wrongType.invalid).toContain('spider_priority');
  });

  it('falls back to `economy` when the colony is on a ratio with no candidate key', () => {
    const odd = makeFacts({ currentRatio: { forage: 4, fight: 6 } });
    const { decision } = decodeAnswers({}, makeCandidates(odd), odd);
    expect(decision.ratio).toBe('economy');
  });
});
