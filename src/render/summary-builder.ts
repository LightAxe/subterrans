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

function buildOutcomeAttribution(events: SimEvent[]): OutcomeAttribution {
  for (const ev of events) {
    if (ev.type === 'queen_death') {
      const cause = ev.payload.cause;
      if (cause === null) {
        return { primaryCause: null, narrativeSeed: null };
      }
      const narratives: Record<string, string> = {
        InvasionKill: 'The enemy colony overran your nest',
        SpiderRampage: 'A spider rampage reached your queen',
        Starvation: 'Your colony starved',
        MutualDestruction: 'Both queens fell at the same time',
      };
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
 */
export function buildPlaytraceSummary(
  world: WorldState,
  resumedFromSave: boolean,
): PlaytraceSummary {
  const events = world.events;

  const stored = events.length;
  const droppedCombatKill = world.droppedCombatKillCount;
  const droppedStructural = world.droppedStructuralCount;
  const totalEmitted = stored + droppedCombatKill + droppedStructural;

  return {
    strategySignals: buildStrategySignals(world),
    outcomeAttribution: buildOutcomeAttribution(events),
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
