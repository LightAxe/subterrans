// summary-builder.ts — S0b: render-side PlaytraceSummary builder.
//
// Called once at game-over / upload time. Reads world + world.events;
// produces the v2 wire envelope's top-level `summary` block.
// This module is render-side: it may read world state but must NOT mutate
// it. It is NOT in src/sim/.
//
// S6 loss-screen attribution reuses buildPlaytraceSummary to derive the
// one-line narrative without uploading. Keep it import-friendly from render code.

import type { WorldState } from '../sim/types.js';
import type { SimEvent } from '../sim/telemetry.js';
import { ChamberType } from '../sim/enums.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { AntTask } from '../sim/enums.js';

// Player colony is always ColonyId 1 per scenario.ts convention.
const PLAYER_COLONY_ID = 1 as ColonyId;

// ---------------------------------------------------------------------------
// PlaytraceSummary — top-level v2 wire field
// ---------------------------------------------------------------------------

export interface StrategySignals {
  chamberCounts: { Queen: number; Nursery: number; FoodStorage: number };
  nurseryTileCount: number;
  fighterPeak: number;
  workerPeak: number;
  forageFightRatioHistory: Array<{ tick: number; forage: number; fight: number }>;
}

export interface OutcomeAttribution {
  primaryCause: string | null;
  narrativeSeed: string | null;
}

export interface CombatAggregate {
  killsByColony: Record<string, number>;
  killLocationBuckets: {
    surface: number;
    playerUnderground: number;
    enemyUnderground: number;
  };
  peakContestedTiles: number;
}

export interface TunableObserved {
  defenderHomegroundWinRate: number | null;
  invasionDefenderSurvival: number | null;
  spiderRampageThisRound: number;
  totalSpiderHunts: number;
  totalProbes: number;
  totalInvasions: number;
}

export interface EventOverflow {
  totalEmitted: number;
  stored: number;
  droppedCombatKill: number;
  droppedStructural: number;
}

export interface PlaytraceSummary {
  strategySignals: StrategySignals;
  outcomeAttribution: OutcomeAttribution;
  combatAggregate: CombatAggregate;
  tunableObserved: TunableObserved;
  eventOverflow: EventOverflow;
  difficulty: 'Easy' | 'Normal' | 'Hard' | null;
  eventsCoverage: 'full_round' | 'since_load' | 'unknown';
  eventsStartTick: number | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function buildStrategySignals(world: WorldState): StrategySignals {
  const colony = world.colonies[PLAYER_COLONY_ID];
  const chamberCounts = { Queen: 0, Nursery: 0, FoodStorage: 0 };
  let nurseryTileCount = 0;

  if (colony) {
    for (const ch of colony.chambers) {
      if (ch.chamberType === ChamberType.Queen) {
        chamberCounts.Queen += 1;
      } else if (ch.chamberType === ChamberType.Nursery) {
        chamberCounts.Nursery += 1;
        // 4×3 tiles per nursery (per CHAMBER_DIMENSIONS)
        nurseryTileCount += 12;
      } else if (ch.chamberType === ChamberType.FoodStorage) {
        chamberCounts.FoodStorage += 1;
      }
    }
  }

  // Count current workers and fighters (snapshot at game-over; S0b has no
  // per-tick peak tracking yet — peaks will be wired in a follow-up stage).
  let workerPeak = 0;
  let fighterPeak = 0;
  if (colony) {
    const count = world.ants.alive.length;
    for (let i = 0; i < count; i++) {
      if (!world.ants.alive[i]) continue;
      if (world.ants.colonyId[i] !== PLAYER_COLONY_ID) continue;
      const task = world.ants.task[i];
      if (task === AntTask.Fighting) fighterPeak += 1;
      else if (task !== AntTask.Idle) workerPeak += 1;
    }
  }

  // Emit current slider position as the sole history entry.
  const ratio = colony?.targetRatio ?? { forage: 10, fight: 0 };
  const forageFightRatioHistory = [
    { tick: 0, forage: ratio.forage, fight: ratio.fight },
  ];

  return {
    chamberCounts,
    nurseryTileCount,
    fighterPeak,
    workerPeak,
    forageFightRatioHistory,
  };
}

// S6: game outcome label passed in from game-scene when available,
// used to pick the tiebreak narrative for StalemateTiebreak.
export type GameOutcomeLabel = 'Victory' | 'Defeat' | 'MutualDestruction';

export function buildOutcomeAttribution(
  events: SimEvent[],
  gameOutcome?: GameOutcomeLabel,
): OutcomeAttribution {
  // S6: check for S5 tiebreak events first (round_end fires before queen_death in tick order).
  for (const ev of events) {
    if (ev.type === 'round_end') {
      const { reason } = ev.payload;
      if (reason === 'TimeoutTiebreak') {
        const { playerWorkerCount, aiWorkerCount } = ev.payload;
        let narrative: string;
        if (playerWorkerCount > aiWorkerCount) {
          narrative = 'The round timed out; your colony outlasted the enemy.';
        } else if (aiWorkerCount > playerWorkerCount) {
          narrative = 'The round timed out; the enemy colony outlasted yours.';
        } else {
          narrative = 'Both colonies were evenly matched when time ran out.';
        }
        return { primaryCause: 'TimeoutTiebreak', narrativeSeed: narrative };
      } else {
        // StalemateTiebreak: S5 always returns MutualDestruction; distinguish
        // by gameOutcome if provided, otherwise use a neutral fallback.
        let narrative: string;
        if (gameOutcome === 'Victory') {
          narrative = 'Both colonies ran out of food; the enemy starved first.';
        } else if (gameOutcome === 'Defeat') {
          narrative = 'Both colonies ran out of food; your queen starved first.';
        } else {
          narrative = 'Both colonies ran out of food and the round ended in a draw.';
        }
        return { primaryCause: 'StalemateTiebreak', narrativeSeed: narrative };
      }
    }
  }
  // S6: updated queen_death narrative strings (more descriptive than S0b's).
  for (const ev of events) {
    if (ev.type === 'queen_death') {
      const cause = ev.payload.cause;
      if (cause === null) {
        // Legacy traces (simVersion < V16) omit cause; derive direction from gameOutcome
        // so a Victory doesn't display a defeat line.
        let narrative: string;
        if (gameOutcome === 'Victory') {
          narrative = 'The enemy colony has fallen.';
        } else if (gameOutcome === 'MutualDestruction') {
          narrative = 'Both queens fell in the final battle.';
        } else {
          narrative = 'Your colony has fallen.';
        }
        return { primaryCause: null, narrativeSeed: narrative };
      }
      // queen_death can describe either queen; use gameOutcome to pick perspective.
      const victoryNarratives: Record<string, string> = {
        InvasionKill:      'Your fighters broke through to the enemy queen.',
        SpiderRampage:     'The spider reached the enemy nursery and killed their queen.',
        Starvation:        'The enemy queen starved after their colony ran out of food.',
        MutualDestruction: 'Both queens died in the same final fight.',
      };
      const defeatNarratives: Record<string, string> = {
        InvasionKill:      'Enemy fighters broke through a tunnel entrance and reached your queen.',
        SpiderRampage:     'The spider reached your nursery and killed the queen.',
        Starvation:        'Your queen starved after the colony ran out of food.',
        MutualDestruction: 'Both queens died in the same final fight.',
      };
      const narratives = gameOutcome === 'Victory' ? victoryNarratives : defeatNarratives;
      return {
        primaryCause: cause,
        narrativeSeed: narratives[cause] ?? null,
      };
    }
  }
  return { primaryCause: null, narrativeSeed: null };
}

function buildCombatAggregate(events: SimEvent[]): CombatAggregate {
  const killsByColony: Record<string, number> = {};
  const buckets = { surface: 0, playerUnderground: 0, enemyUnderground: 0 };

  for (const ev of events) {
    if (ev.type !== 'combat_kill') continue;
    const killerCid = ev.payload.killer.colonyId;
    if (killerCid !== null) {
      const key = String(killerCid);
      killsByColony[key] = (killsByColony[key] ?? 0) + 1;
    }
    const loc = ev.payload.location;
    if (loc.grid === 'surface') {
      // eslint-disable-next-line no-restricted-syntax -- false positive: `surface` is a local bucket key, not a WorldState field
      buckets.surface += 1;
    } else if (killerCid === PLAYER_COLONY_ID || ev.payload.victim.colonyId !== PLAYER_COLONY_ID) {
      buckets.enemyUnderground += 1;
    } else {
      buckets.playerUnderground += 1;
    }
  }

  return {
    killsByColony,
    killLocationBuckets: buckets,
    peakContestedTiles: 0, // surface contested tile tracking added in S1
  };
}

function buildTunableObserved(events: SimEvent[]): TunableObserved {
  let totalSpiderHunts = 0;
  let spiderRampageThisRound = 0;
  let totalProbes = 0;
  let totalInvasions = 0;

  for (const ev of events) {
    if (ev.type === 'spider_hunt_start') totalSpiderHunts += 1;
    if (ev.type === 'spider_rampage_start') spiderRampageThisRound += 1;
    if (ev.type === 'invasion_start') {
      totalInvasions += 1;
      // Probing is a sub-type of invasion in S2's AI state; for now every
      // invasion_start is also counted as a probe until S2 distinguishes them.
      totalProbes += 1;
    }
  }

  return {
    defenderHomegroundWinRate: null, // populated once combat data exists (S1)
    invasionDefenderSurvival: null,  // populated once combat data exists (S1)
    spiderRampageThisRound,
    totalSpiderHunts,
    totalProbes,
    totalInvasions,
  };
}

/**
 * Build the PlaytraceSummary for the completed session.
 *
 * @param world          - The terminal WorldState (post-outcome).
 * @param resumedFromSave - True if the session was loaded from a save; causes
 *                         eventsCoverage to be 'since_load'.
 * @param gameOutcome    - S6: optional outcome label for tiebreak narrative selection.
 */
export function buildPlaytraceSummary(
  world: WorldState,
  resumedFromSave: boolean,
  gameOutcome?: GameOutcomeLabel,
): PlaytraceSummary {
  const events = world.events;

  const stored = events.length;
  const droppedCombatKill = world.droppedCombatKillCount;
  const droppedStructural = world.droppedStructuralCount;
  const totalEmitted = stored + droppedCombatKill + droppedStructural;

  return {
    strategySignals: buildStrategySignals(world),
    outcomeAttribution: buildOutcomeAttribution(events, gameOutcome),
    combatAggregate: buildCombatAggregate(events),
    tunableObserved: buildTunableObserved(events),
    eventOverflow: {
      totalEmitted,
      stored,
      droppedCombatKill,
      droppedStructural,
    },
    difficulty: world.difficulty,
    eventsCoverage: resumedFromSave
      ? 'since_load'
      : totalEmitted > 0
        ? 'full_round'
        : 'unknown',
    eventsStartTick: events.length > 0 ? (events[0]?.tick ?? null) : null,
  };
}
