// jev-encode.ts — WorldState facts → digit-free bucketed state + the beat's
// questions, and the decode back to a Decision.
//
// Why digit-free: Jev cannot count or compare numbers (documented model
// jaggedness). Every quantity is bucketed into a WORD by code here — "few",
// "half", "far_more" — and the raw numbers never leave the render layer. A
// regression here is silent and expensive, so `containsDigits` is asserted in
// tests against both the state and the questions.
//
// Wire contract (the same-origin proxy): ids and option keys must match
// JEV_ID_PATTERN, at most JEV_MAX_QUESTIONS questions per request, and the
// serialized state must stay under JEV_MAX_STATE_BYTES.

import type {
  BucketMode,
  CandidateSet,
  Decision,
  DigDirection,
  FoodPriorityKey,
  PostureKey,
  RatioKey,
  RawFacts,
} from './jev-types.js';
import { RATIO_CANDIDATES } from './jev-candidates.js';

// ---------------------------------------------------------------------------
// Question / answer shapes (mirrors the proxy contract)
// ---------------------------------------------------------------------------

export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}
export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}
export type JevQuestion = ChoiceQuestion | NoulQuestion;
export type JevQuestionMap = Readonly<Record<string, JevQuestion>>;

export type JevAnswer =
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: 'noul'; readonly noul: number };
export type JevAnswerMap = Readonly<Record<string, JevAnswer>>;

/** Question ids and choice keys accepted by the proxy. */
export const JEV_ID_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
/** Maximum questions the proxy accepts in one request. */
export const JEV_MAX_QUESTIONS = 12;
/** Maximum serialized-state size the proxy accepts, in bytes. */
export const JEV_MAX_STATE_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export interface BucketSpec {
  /** value < thresholds[i] → labels[i]; otherwise the last label. */
  readonly thresholds: readonly number[];
  readonly labels: readonly string[]; // length = thresholds.length + 1
}

export function bucket(value: number, spec: BucketSpec): string {
  for (let i = 0; i < spec.thresholds.length; i++) {
    if (value < spec.thresholds[i]!) return spec.labels[i]!;
  }
  return spec.labels[spec.thresholds.length]!;
}

export interface BucketTables {
  readonly fraction: BucketSpec; // 0..1 food fraction
  readonly ratioVs: BucketSpec; // ours / theirs
  readonly count: BucketSpec; // small event / ant counts
  readonly workers: BucketSpec; // absolute worker count
  readonly brood: BucketSpec;
  readonly distance: BucketSpec; // tiles, spider / piles
  readonly pileSize: BucketSpec; // pickups remaining
}

const COARSE: BucketTables = {
  fraction: { thresholds: [0.05, 0.3, 0.6, 0.9], labels: ['empty', 'low', 'half', 'high', 'full'] },
  ratioVs: {
    thresholds: [0.5, 0.8, 1.25, 2],
    labels: ['far_fewer', 'fewer', 'similar', 'more', 'far_more'],
  },
  count: { thresholds: [1, 4], labels: ['none', 'few', 'many'] },
  workers: {
    thresholds: [6, 15, 30, 60],
    labels: ['tiny', 'small', 'medium', 'large', 'huge'],
  },
  brood: { thresholds: [1, 4, 10], labels: ['none', 'few', 'some', 'many'] },
  distance: { thresholds: [24, 48], labels: ['near', 'mid', 'far'] },
  pileSize: { thresholds: [10, 40], labels: ['small', 'medium', 'large'] },
};

const FINE: BucketTables = {
  fraction: {
    thresholds: [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.97],
    labels: [
      'empty',
      'very_low',
      'low',
      'below_half',
      'half',
      'above_half',
      'high',
      'nearly_full',
      'full',
    ],
  },
  ratioVs: {
    thresholds: [0.35, 0.5, 0.65, 0.8, 0.95, 1.05, 1.25, 1.6, 2, 3],
    labels: [
      'overwhelmingly_fewer',
      'far_fewer',
      'much_fewer',
      'fewer',
      'slightly_fewer',
      'equal',
      'slightly_more',
      'more',
      'much_more',
      'far_more',
      'overwhelmingly_more',
    ],
  },
  count: {
    thresholds: [1, 2, 4, 6, 10],
    labels: ['none', 'one', 'a_couple', 'few', 'several', 'many'],
  },
  workers: {
    thresholds: [4, 8, 12, 18, 25, 35, 50, 70],
    labels: [
      'minuscule',
      'tiny',
      'very_small',
      'small',
      'below_medium',
      'medium',
      'large',
      'very_large',
      'huge',
    ],
  },
  brood: {
    thresholds: [1, 2, 4, 7, 10, 15],
    labels: ['none', 'one', 'a_couple', 'few', 'some', 'several', 'many'],
  },
  distance: {
    thresholds: [12, 24, 36, 48, 72],
    labels: ['very_near', 'near', 'mid_near', 'mid', 'mid_far', 'far'],
  },
  pileSize: {
    thresholds: [5, 10, 20, 40, 80],
    labels: ['scraps', 'small', 'modest', 'medium', 'large', 'huge'],
  },
};

export function tablesFor(mode: BucketMode): BucketTables {
  return mode === 'fine' ? FINE : COARSE;
}

const PHASE: BucketSpec = {
  thresholds: [2400, 6600, 15000],
  labels: ['opening', 'early', 'mid', 'late'],
};

function wordCount(n: number): string {
  return n <= 0 ? 'none' : n === 1 ? 'one' : n === 2 ? 'two' : 'several';
}

function ratioKeyFor(r: { forage: number; fight: number }): RatioKey | 'custom' {
  for (const k of Object.keys(RATIO_CANDIDATES) as RatioKey[]) {
    const c = RATIO_CANDIDATES[k].ratio;
    if (c.forage === r.forage && c.fight === r.fight) return k;
  }
  return 'custom';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface EncodedBeat {
  readonly state: Record<string, unknown>;
  readonly questions: JevQuestionMap;
  readonly estimatedTokens: number;
}

export function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

export function containsDigits(obj: unknown): boolean {
  return /[0-9]/.test(JSON.stringify(obj));
}

function trend(now: number, before: number | null): string {
  if (before === null) return 'unknown';
  if (now < before * 0.9) return 'falling';
  if (now > before * 1.1) return 'rising';
  return 'steady';
}

/**
 * Encode one beat. `orders` is the player's standing orders — an empty string
 * means the `standing_orders` field is omitted entirely. `prev` is the previous
 * beat's facts, used for the food / worker trend words (null on the first beat →
 * "unknown").
 */
export function encodeBeat(
  facts: RawFacts,
  cands: CandidateSet,
  orders: string,
  mode: BucketMode,
  prev: RawFacts | null = null,
): EncodedBeat {
  const T = tablesFor(mode);
  const pileNames = ['pile_a', 'pile_b', 'pile_c'] as const;
  const piles = facts.piles.slice(0, 3).map((p, i) => ({
    name: pileNames[i]!,
    size: bucket(p.remaining, T.pileSize),
    distance_from_us: bucket(p.distOwn, T.distance),
    distance_from_opponent: bucket(p.distOpp, T.distance),
    contested: p.contested ? 'yes' : 'no',
  }));

  const spiderThreat =
    facts.spider === null
      ? 'absent'
      : facts.spider.targetingUs
        ? 'rampaging_against_us'
        : facts.spider.state === 'Rampaging'
          ? 'rampaging_against_opponent'
          : facts.spider.distOwn <= T.distance.thresholds[0]!
            ? 'prowling_near_us'
            : 'distant';

  const state: Record<string, unknown> = {};
  if (orders !== '') state.standing_orders = orders;
  state.game_phase = bucket(facts.tick, PHASE);
  state.our_colony = {
    workers: bucket(facts.ownWorkers, T.workers),
    brood: bucket(facts.ownBrood, T.brood),
    fighters_on_surface: bucket(facts.ownFightersSurface, T.count),
    foragers_out: bucket(facts.ownForagersOut, T.count),
    food_stored: bucket(
      facts.foodCapacity > 0 ? facts.foodTotal / facts.foodCapacity : 0,
      T.fraction,
    ),
    food_trend: trend(facts.foodTotal, prev === null ? null : prev.foodTotal),
    workers_trend: trend(facts.ownWorkers, prev === null ? null : prev.ownWorkers),
    brood_vs_workers: bucket(
      facts.ownWorkers > 0 ? facts.ownBrood / facts.ownWorkers : 99,
      T.ratioVs,
    ),
    storage_chambers: wordCount(facts.storageChambers),
    entrances_open: wordCount(facts.ownEntrancesOpen),
    current_fight_ratio: ratioKeyFor(facts.currentRatio),
    current_posture: facts.currentPosture,
    recent_losses: bucket(facts.ownLossesRecent, T.count),
    recent_kills: bucket(facts.ownKillsRecent, T.count),
  };
  state.opponent_colony = {
    workers_vs_ours: bucket(
      facts.oppWorkers > 0 ? facts.ownWorkers / facts.oppWorkers : 99,
      T.ratioVs,
    ),
    fighters_on_surface: bucket(facts.oppFightersSurface, T.count),
    fighters_at_our_entrance: bucket(facts.oppFightersNearOurEntrance, T.count),
    entrances_open: wordCount(facts.oppEntrancesOpen),
    has_open_entrance: facts.oppEntrancesOpen > 0 ? 'yes' : 'no',
    recent_losses: bucket(facts.oppLossesRecent, T.count),
  };
  state.spider =
    facts.spider === null
      ? 'absent'
      : {
          behavior: facts.spider.state.toLowerCase(),
          threat: spiderThreat,
          distance_to_us: bucket(facts.spider.distOwn, T.distance),
          distance_to_opponent: bucket(facts.spider.distOpp, T.distance),
        };
  state.food_piles = piles;

  const candidates: Record<string, unknown> = {
    fight_ratio: Object.fromEntries(Object.entries(cands.ratio).map(([k, v]) => [k, v.describe])),
    posture: Object.fromEntries(Object.entries(cands.posture).map(([k, v]) => [k, v.describe])),
    dig: Object.fromEntries(
      Object.entries(cands.dig)
        .filter(([, v]) => v.available)
        .map(([k, v]) => [k, v.describe]),
    ),
    food_priority: Object.fromEntries(
      Object.entries(cands.foodPriority).map(([k, v]) => [k, v.describe]),
    ),
  };
  if (cands.spiderPriority !== null) candidates.spider_priority = cands.spiderPriority.describe;
  if (cands.expandStorage !== null) candidates.expand_storage = cands.expandStorage.describe;
  state.candidates = candidates;

  const questions = buildQuestions(cands, orders !== '');
  return { state, questions, estimatedTokens: estimateTokens({ state, questions }) };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function preamble(hasOrders: boolean): string {
  return (
    'You command the ant colony described in `our_colony` against the colony in `opponent_colony`, ' +
    'with the neutral spider in `spider` and the surface food in `food_piles`. ' +
    (hasOrders ? 'Follow `standing_orders` above everything else. ' : '') +
    'Judge from the current state only. '
  );
}

export function buildQuestions(cands: CandidateSet, hasOrders: boolean): JevQuestionMap {
  const pre = preamble(hasOrders);
  const q: Record<string, JevQuestion> = {
    ratio: {
      type: 'choice',
      instructions:
        pre +
        'Choose the split of our workers between foraging and fighting for the next while. ' +
        'Options are listed under `candidates.fight_ratio`.',
      criteria: Object.fromEntries(Object.entries(cands.ratio).map(([k, v]) => [k, v.describe])),
    },
    posture: {
      type: 'choice',
      instructions:
        pre +
        'Choose where our fighters should be right now. Options are listed under `candidates.posture`; ' +
        'assaulting sends fighters into the opponent nest, guarding keeps them home.',
      criteria: Object.fromEntries(Object.entries(cands.posture).map(([k, v]) => [k, v.describe])),
    },
    dig: {
      type: 'choice',
      instructions:
        pre +
        'Choose how our diggers should extend the nest next. Options are listed under `candidates.dig`.',
      criteria: Object.fromEntries(
        Object.entries(cands.dig)
          .filter(([, v]) => v.available)
          .map(([k, v]) => [k, v.describe]),
      ),
    },
    food_priority: {
      type: 'choice',
      instructions:
        pre +
        'Choose which food pile our foragers should prioritize, if any. Options are listed under `candidates.food_priority`.',
      criteria: Object.fromEntries(
        Object.entries(cands.foodPriority).map(([k, v]) => [k, v.describe]),
      ),
    },
  };
  if (cands.spiderPriority !== null) {
    q.spider_priority = {
      type: 'noul',
      instructions:
        pre + 'Should our fighters treat the spider as their priority target right now?',
      criteria: {
        true: 'yes — fighters engage the spider before anything else',
        false: 'no — fighters keep to their posture and ignore the spider',
      },
    };
  }
  if (cands.expandStorage !== null) {
    q.expand_storage = {
      type: 'noul',
      instructions: pre + 'Should we place one more food storage chamber in the nest now?',
      criteria: {
        true: 'yes — our stores are nearly full and growth needs room',
        false: 'no — not worth the digging effort now',
      },
    };
  }
  return q;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export interface Decoded {
  readonly decision: Decision;
  /** Question ids whose answer was missing, the wrong type, or not a live candidate. */
  readonly invalid: readonly string[];
}

export function decodeAnswers(
  answers: JevAnswerMap,
  cands: CandidateSet,
  facts: RawFacts,
): Decoded {
  const invalid: string[] = [];
  const pick = <K extends string>(id: string, valid: readonly K[], fallback: K): K => {
    const a = answers[id];
    if (a === undefined || a.type !== 'choice') {
      invalid.push(id);
      return fallback;
    }
    if ((valid as readonly string[]).includes(a.choice)) return a.choice as K;
    invalid.push(id);
    return fallback;
  };
  const noul = (id: string, offered: boolean): boolean | null => {
    if (!offered) return null;
    const a = answers[id];
    if (a === undefined || a.type !== 'noul') {
      invalid.push(id);
      return false;
    }
    return a.noul >= 0.5;
  };
  const currentRatio = ratioKeyFor(facts.currentRatio);
  const decision: Decision = {
    ratio: pick<RatioKey>(
      'ratio',
      Object.keys(cands.ratio) as RatioKey[],
      currentRatio === 'custom' ? 'economy' : currentRatio,
    ),
    posture: pick<PostureKey>(
      'posture',
      Object.keys(cands.posture) as PostureKey[],
      facts.currentPosture in cands.posture ? facts.currentPosture : 'recall',
    ),
    dig: pick<DigDirection>(
      'dig',
      (Object.keys(cands.dig) as DigDirection[]).filter((d) => cands.dig[d].available),
      'hold',
    ),
    foodPriority: pick<FoodPriorityKey>(
      'food_priority',
      Object.keys(cands.foodPriority) as FoodPriorityKey[],
      'none',
    ),
    spiderPriority: noul('spider_priority', cands.spiderPriority !== null),
    expandStorage: noul('expand_storage', cands.expandStorage !== null),
  };
  return { decision, invalid };
}
