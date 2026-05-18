// Phase 5 scope: outcome enum only. checkQueenDeath is Phase 9 scope — see Phase 4 PRD §5a.
// S0b: emits queen_death SimEvent on first detection (cause: null for pre-V16 saves).
// S1: reads pendingQueenDeathContexts (written by killAnt) to fill in cause=InvasionKill.

export const GameOutcome = {
  None: 0,
  Victory: 1,
  Defeat: 2,
  MutualDestruction: 3,
} as const;
export type GameOutcome = typeof GameOutcome[keyof typeof GameOutcome];

import type { WorldState } from './types.js';
import type { ColonyId, ColonyRecord } from './colony/colony-store.js';
import { emitEvent } from './telemetry.js';
import { SIM_VERSION_V16_COMBAT_HPDPS } from './types.js';

/**
 * Returns true if the colony's queen is alive per world.ants.
 * Side effect (idempotent): sets colony.defeated = true when queen is dead.
 * S1: reads world.pendingQueenDeathContexts to fill in queen_death cause.
 */
function isQueenAlive(world: WorldState, colony: ColonyRecord): boolean {
  const qid = colony.queenEntityId;
  const alive = world.ants.alive[qid] === 1;
  if (!alive) {
    if (!colony.defeated) {
      // Set before emitting (defensive guard against hypothetical re-entrancy).
      colony.defeated = true;

      // S1: read kill-site context written by combat.killAnt this same tick.
      const ctx = world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS
        ? (world.pendingQueenDeathContexts[colony.colonyId] ?? null)
        : null;

      // Determine cause: InvasionKill when the killer is from a different colony
      // than the grid the queen was in when killed (RC-P1-003).
      let cause: 'InvasionKill' | 'SpiderRampage' | 'Starvation' | 'MutualDestruction' | null = null;
      if (ctx !== null) {
        if (ctx.killerColonyId !== null && ctx.killerColonyId !== colony.colonyId) {
          cause = 'InvasionKill';
        }
        // SpiderRampage, Starvation, MutualDestruction: S2/S5/S6 will extend this.
      }

      // Location from kill-site context when available; fall back to queen's current tile.
      const locX = ctx ? ctx.tile.x : (world.ants.posX[qid] ?? 0) >> 8;
      const locY = ctx ? ctx.tile.y : (world.ants.posY[qid] ?? 0) >> 8;
      const grid: 'surface' | 'underground' = (world.ants.zone[qid] ?? 1) === 0 ? 'surface' : 'underground';

      emitEvent(world, {
        tick: world.tick,
        type: 'queen_death',
        payload: {
          cause,
          location: { x: locX, y: locY, grid },
          aiStateAtTime: null, // S2 fills this
        },
      });

      // Clear the context so it's not re-read if isQueenAlive is called again.
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

/**
 * Phase 9 / CMBT-06, CMBT-07 — determine phase-end outcome from queen liveness.
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

  const playerAlive = isQueenAlive(world, playerColony);

  let anyOtherAlive = false;
  let otherColonyCount = 0;
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const cid = Number(key) as ColonyId;
    if (cid === playerCid) continue;
    otherColonyCount += 1;
    const colony = world.colonies[cid]!;
    if (isQueenAlive(world, colony)) anyOtherAlive = true;
  }

  // Single-colony sandboxes: no enemies → no win condition.
  if (otherColonyCount === 0) {
    // Defeat only if the lone colony's queen is dead.
    return playerAlive ? GameOutcome.None : GameOutcome.Defeat;
  }

  if (playerAlive && !anyOtherAlive) return GameOutcome.Victory;
  if (!playerAlive && anyOtherAlive) return GameOutcome.Defeat;
  if (!playerAlive && !anyOtherAlive) return GameOutcome.MutualDestruction;
  return GameOutcome.None;
}
