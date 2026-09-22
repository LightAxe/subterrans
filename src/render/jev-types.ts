// jev-types.ts — shared types for the Jev opponent (the enemy Colony driven by
// TypeSafe's Jev model instead of the rule-based AI controller).
//
// Ported from the validated headless spike (plan/jev-player-spike). Render-layer
// only: nothing here touches src/sim/, and no simVersion gate is involved — the
// Jev controller is a *policy* that reads WorldState and enqueues exactly the same
// SimCommands a player would, sitting beside ai-controller.ts.
//
// Seat-agnostic by construction: every module below is handed `{ mySeat,
// opponentSeat }` and never mentions PLAYER_COLONY_ID / ENEMY_COLONY_ID, so the
// same code can drive either Colony (the spike used that to A/B both seats).

import type { ColonyId, BehaviorRatio } from '../sim/colony/colony-store.js';

/** Which Colony a controller drives and which it plays against (CONTEXT.md: Seat). */
export interface Seats {
  readonly mySeat: ColonyId;
  readonly opponentSeat: ColonyId;
}

/** Bucket granularity for the encoded state. `coarse` is the shipped default. */
export type BucketMode = 'coarse' | 'fine';

export type RatioKey = 'all_in_economy' | 'economy' | 'balanced' | 'military' | 'all_in_war';
export type PostureKey =
  | 'recall'
  | 'guard_home'
  | 'hold_midfield'
  | 'assault'
  | 'contest_pile_a'
  | 'contest_pile_b'
  | 'contest_pile_c';
export type DigDirection = 'deeper' | 'wider_left' | 'wider_right' | 'toward_surface' | 'hold';
export type FoodPriorityKey = 'none' | 'pile_a' | 'pile_b' | 'pile_c';

export interface Tile {
  readonly x: number;
  readonly y: number;
}

export interface RatioCandidate {
  /** Behavior ratio (CONTEXT.md) pushed via SetBehaviorRatio when chosen. */
  readonly ratio: BehaviorRatio;
  readonly describe: string;
}

export interface PostureCandidate {
  /** null for `recall` (ClearRallyPoint); otherwise the Rally point tile. */
  readonly tile: Tile | null;
  readonly describe: string;
}

export interface DigCandidate {
  readonly describe: string;
  /** false when the frontier in that direction is currently empty (still selectable; executes as hold). */
  readonly available: boolean;
}

export interface FoodPriorityCandidate {
  readonly pileId: number | null;
  readonly tile: Tile | null;
  readonly describe: string;
}

export interface PileFact {
  readonly id: number;
  readonly tile: Tile;
  readonly remaining: number;
  readonly initial: number;
  readonly distOwn: number;
  readonly distOpp: number;
  readonly contested: boolean;
}

export interface SpiderFact {
  readonly state: string;
  readonly distOwn: number;
  readonly distOpp: number;
  readonly targetingUs: boolean;
}

/**
 * Raw (numeric) facts computed by code each beat. These are the INPUT to the
 * bucketed encoder — they are never sent to Jev, which cannot count (documented
 * model jaggedness). Every number here is turned into a word by jev-encode.ts.
 */
export interface RawFacts {
  readonly tick: number;
  readonly ownWorkers: number;
  readonly oppWorkers: number;
  readonly ownBrood: number;
  readonly ownFightersSurface: number;
  readonly ownForagersOut: number;
  readonly oppFightersSurface: number;
  readonly oppFightersNearOurEntrance: number;
  readonly foodTotal: number;
  readonly foodCapacity: number;
  readonly storageChambers: number;
  readonly ownEntrancesOpen: number;
  readonly oppEntrancesOpen: number;
  readonly spider: SpiderFact | null;
  readonly piles: readonly PileFact[];
  readonly ownLossesRecent: number;
  readonly oppLossesRecent: number;
  readonly ownKillsRecent: number;
  readonly currentRatio: BehaviorRatio;
  readonly currentPosture: PostureKey;
}

/** Every legal move this beat, keyed by the option id Jev answers with. */
export interface CandidateSet {
  readonly ratio: Readonly<Record<RatioKey, RatioCandidate>>;
  readonly posture: Readonly<Partial<Record<PostureKey, PostureCandidate>>>;
  readonly dig: Readonly<Record<DigDirection, DigCandidate>>;
  readonly foodPriority: Readonly<Partial<Record<FoodPriorityKey, FoodPriorityCandidate>>>;
  readonly spiderPriority: { readonly describe: string } | null;
  readonly expandStorage: { readonly anchor: Tile; readonly describe: string } | null;
  readonly facts: RawFacts;
}

/** One beat's decoded answer set. */
export interface Decision {
  readonly ratio: RatioKey;
  readonly posture: PostureKey;
  readonly dig: DigDirection;
  readonly foodPriority: FoodPriorityKey;
  /** null when the question was not offered this beat. */
  readonly spiderPriority: boolean | null;
  readonly expandStorage: boolean | null;
}
