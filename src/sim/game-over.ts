// Phase 5 scope: outcome enum only. checkQueenDeath is Phase 9 scope — see Phase 4 PRD §5a.
// S0b: emits queen_death SimEvent on first detection (cause: null for pre-V16 saves).
// S1: reads pendingQueenDeathContexts (written by killAnt) to fill in cause=InvasionKill.
// S2: two-pass loop for MutualDestruction; reads aiState for aiStateAtTime; full inferCause.

export const GameOutcome = {
  None: 0,
  Victory: 1,
  Defeat: 2,
  MutualDestruction: 3,
} as const;
export type GameOutcome = typeof GameOutcome[keyof typeof GameOutcome];

import type { WorldState, AIState } from './types.js';
import type { ColonyId, ColonyRecord } from './colony/colony-store.js';
import { emitEvent } from './telemetry.js';
import { SIM_VERSION_V16_COMBAT_HPDPS, SIM_VERSION_V19_AI_STATE } from './types.js';
import { FP_SHIFT } from './fixed.js';

/**
 * S2 — infer queen_death cause from the kill context and game outcome.
 * Branch order per spec Part E (MutualDestruction → SpiderRampage → InvasionKill → Starvation).
 */
function inferCause(
  ctx: WorldState['pendingQueenDeathContexts'][number],
  gameOutcome: GameOutcome,
): 'InvasionKill' | 'SpiderRampage' | 'Starvation' | 'MutualDestruction' | null {
  if (gameOutcome === GameOutcome.MutualDestruction) return 'MutualDestruction';
  if (ctx === null || ctx === undefined) return 'Starvation'; // no killing strike
  if (ctx.killerKind === 'Spider') return 'SpiderRampage';
  if (ctx.killerKind === 'Ant' && ctx.killerColonyId !== null) {
    // Cross-grid: killer from outside the grid where the queen died
    if (ctx.killerColonyId !== ctx.currentGridColonyId) return 'InvasionKill';
    // Same-grid combat (rare but possible)
    return 'InvasionKill';
  }
  if (ctx.killerKind === 'Environment') return 'Starvation';
  return null; // Ant kill with null colonyId — unattributed; show no subtitle
}

/**
 * Returns true if the colony's queen is alive per world.ants.
 * Side effect (idempotent): sets colony.defeated = true when queen is dead.
 */
function isQueenAlive(world: WorldState, colony: ColonyRecord): boolean {
  const qid = colony.queenEntityId;
  return world.ants.alive[qid] === 1;
}

/**
 * Phase 9 / CMBT-06, CMBT-07 — determine phase-end outcome from queen liveness.
 * S2: two-pass loop for correct MutualDestruction attribution.
 *
 * CLNY-08: this module does NOT import the platform-layer player colony constant — player colony
 * is either the caller-supplied playerColonyId or (fallback) the smallest numeric colonyId present in world.colonies.
 *
 * Only mutation: `colony.defeated = true` for dead-queen colonies (idempotent).
 */
export function checkQueenDeath(world: WorldState, playerColonyId?: ColonyId): GameOutcome {
  const colonyKeys = Object.keys(world.colonies);
  if (colonyKeys.length === 0) return GameOutcome.None;

  // Determine player colony.
  let playerCid: ColonyId;
  if (playerColonyId !== undefined) {
    playerCid = playerColonyId;
  } else {
    // Smallest numeric colonyId.
    let minId = Number.POSITIVE_INFINITY;
    for (const key of colonyKeys) {
      const id = Number(key);
      if (id < minId) minId = id;
    }
    playerCid = minId as ColonyId;
  }

  const playerColony = world.colonies[playerCid];
  if (playerColony === undefined) return GameOutcome.None;

  // For pre-V17 saves: use legacy single-pass path (S1 behavior).
  if (world.simVersion < SIM_VERSION_V19_AI_STATE) {
    return _checkQueenDeathLegacy(world, playerCid, playerColony);
  }

  // --- S2 two-pass loop ---

  // Pass 1 (detection): find which queens died this tick; set colony.defeated.
  // Compute GameOutcome knowing all results.
  const diedThisTick: ColonyId[] = [];

  if (!isQueenAlive(world, playerColony) && !playerColony.defeated) {
    diedThisTick.push(playerCid);
  }

  let otherColonyCount = 0;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const cid = Number(key) as ColonyId;
    if (cid === playerCid) continue;
    otherColonyCount += 1;
    const colony = world.colonies[cid]!;
    if (!isQueenAlive(world, colony) && !colony.defeated) {
      diedThisTick.push(cid);
    }
  }

  // Compute GameOutcome from the set of newly-dead queens.
  const playerDied = diedThisTick.includes(playerCid);
  const otherDied = diedThisTick.some((cid) => cid !== playerCid);
  const playerCurrentlyAlive = isQueenAlive(world, playerColony);
  const anyOtherAlive = (() => {
    for (const key in world.colonies) {
      if (!Object.hasOwn(world.colonies, key)) continue;
      const cid = Number(key) as ColonyId;
      if (cid === playerCid) continue;
      const colony = world.colonies[cid]!;
      if (isQueenAlive(world, colony)) return true;
    }
    return false;
  })();

  // For GameOutcome: detect based on who JUST died.
  let gameOutcome: GameOutcome = GameOutcome.None;
  if (playerDied && otherDied && !anyOtherAlive) {
    // Player and last enemy queen died in same tick.
    gameOutcome = GameOutcome.MutualDestruction;
  } else if (playerDied) {
    gameOutcome = GameOutcome.Defeat;
  } else if (otherDied && !anyOtherAlive) {
    // All enemy colonies dead.
    gameOutcome = GameOutcome.Victory;
  }

  // Pass 2 (event emission): for each newly-dead queen, emit queen_death.
  for (const cid of diedThisTick) {
    const colony = world.colonies[cid]!;
    if (!colony.defeated) {
      colony.defeated = true;
    }

    const ctx = world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS
      ? (world.pendingQueenDeathContexts[cid] ?? null)
      : null;

    // S2: look up aiStateAtTime from world.aiState for the killer colony.
    let aiStateAtTime: AIState | null = null;
    if (ctx !== null && world.simVersion >= SIM_VERSION_V19_AI_STATE) {
      for (let i = 0; i < world.aiState.length; i++) {
        // Check if the AI colony was the killer
        if (world.aiState[i]!.colonyId === ctx.killerColonyId) {
          aiStateAtTime = world.aiState[i]!.state;
          break;
        }
      }
    }

    const cause = world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS
      ? inferCause(ctx, gameOutcome)
      : null;

    // Location from kill-site context when available; fall back to queen's current tile.
    const qid = colony.queenEntityId;
    const locX = ctx ? ctx.tile.x : (world.ants.posX[qid] ?? 0) >> FP_SHIFT;
    const locY = ctx ? ctx.tile.y : (world.ants.posY[qid] ?? 0) >> FP_SHIFT;
    const grid: 'surface' | 'underground' = (world.ants.zone[qid] ?? 1) === 0 ? 'surface' : 'underground';

    emitEvent(world, {
      tick: world.tick,
      type: 'queen_death',
      payload: {
        cause,
        location: { x: locX, y: locY, grid },
        aiStateAtTime,
      },
    });

    // Clear context.
    if (ctx !== null) {
      world.pendingQueenDeathContexts[cid] = null;
    }
  }

  // Return the outcome.
  if (otherColonyCount === 0) {
    return playerCurrentlyAlive ? GameOutcome.None : GameOutcome.Defeat;
  }
  if (playerCurrentlyAlive && !anyOtherAlive) return GameOutcome.Victory;
  if (!playerCurrentlyAlive && anyOtherAlive) return GameOutcome.Defeat;
  if (!playerCurrentlyAlive && !anyOtherAlive) return GameOutcome.MutualDestruction;
  return GameOutcome.None;
}

/**
 * Legacy single-pass path for pre-V17 saves (S1 behavior, byte-identical replay).
 */
function _checkQueenDeathLegacy(
  world: WorldState,
  playerCid: ColonyId,
  playerColony: ColonyRecord,
): GameOutcome {
  const playerAlive = _isQueenAliveAndEmitLegacy(world, playerColony);

  let anyOtherAlive = false;
  let otherColonyCount = 0;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const cid = Number(key) as ColonyId;
    if (cid === playerCid) continue;
    otherColonyCount += 1;
    const colony = world.colonies[cid]!;
    if (_isQueenAliveAndEmitLegacy(world, colony)) anyOtherAlive = true;
  }

  if (otherColonyCount === 0) {
    return playerAlive ? GameOutcome.None : GameOutcome.Defeat;
  }

  if (playerAlive && !anyOtherAlive) return GameOutcome.Victory;
  if (!playerAlive && anyOtherAlive) return GameOutcome.Defeat;
  if (!playerAlive && !anyOtherAlive) return GameOutcome.MutualDestruction;
  return GameOutcome.None;
}

/**
 * S1-compatible single-queen death detection and event emission (pre-V17 path).
 * Returns true if the colony's queen is alive.
 */
function _isQueenAliveAndEmitLegacy(world: WorldState, colony: ColonyRecord): boolean {
  const qid = colony.queenEntityId;
  const alive = world.ants.alive[qid] === 1;
  if (!alive) {
    if (!colony.defeated) {
      colony.defeated = true;

      const ctx = world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS
        ? (world.pendingQueenDeathContexts[colony.colonyId] ?? null)
        : null;

      let cause: 'InvasionKill' | 'SpiderRampage' | 'Starvation' | 'MutualDestruction' | null = null;
      if (ctx !== null) {
        if (ctx.killerColonyId !== null && ctx.killerColonyId !== ctx.currentGridColonyId) {
          cause = 'InvasionKill';
        }
      }

      const locX = ctx ? ctx.tile.x : (world.ants.posX[qid] ?? 0) >> FP_SHIFT;
      const locY = ctx ? ctx.tile.y : (world.ants.posY[qid] ?? 0) >> FP_SHIFT;
      const grid: 'surface' | 'underground' = (world.ants.zone[qid] ?? 1) === 0 ? 'surface' : 'underground';

      emitEvent(world, {
        tick: world.tick,
        type: 'queen_death',
        payload: {
          cause,
          location: { x: locX, y: locY, grid },
          aiStateAtTime: null,
        },
      });

      if (ctx !== null) {
        world.pendingQueenDeathContexts[colony.colonyId] = null;
      }
    } else {
      colony.defeated = true;
    }
    return false;
  }
  return true;
}
