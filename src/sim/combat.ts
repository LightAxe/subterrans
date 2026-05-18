// src/sim/combat.ts
// Phase 9 / CMBT-04..07 — pure-sim combat detection and resolution.
//
// V15 (legacy): coin-flip instant-kill resolver (resolveCombatOnTile_v15).
// V16 (S1): HP/damage/cooldown resolver (resolveCombatOnTile_v16).
//   - One active pair per contested tile per tick (lowest slot indices).
//   - Windup on first contested tick: attackCooldown=COMBAT_COOLDOWN_TICKS, no strike.
//   - Strike when cooldown decrements to 0; resets to COMBAT_COOLDOWN_TICKS.
//   - Strikes are simultaneous: both ants can die the same tick.
//   - Home-ground damage bonus: COMBAT_DAMAGE_HOMEGROUND on own grid (underground only).
//   - Home-ground HP buffer: homeGroundBonusHp depletes before hp.
//
// killAnt now emits combat_kill and writes pendingQueenDeathContexts when victim is queen.
// checkQueenDeath (game-over.ts) reads and clears pendingQueenDeathContexts each tick.

import { Rng } from './rng.js';
import { AntTask } from './enums.js';
import { makeTileKey } from './tile-key.js';
import type { WorldState, KillerKind, QueenDeathContext } from './types.js';
import { SIM_VERSION_V13_INVARIANT_FIXES, SIM_VERSION_V16_COMBAT_HPDPS } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import type { Zone } from './terrain.js';
import { FP_SHIFT } from './fixed.js';
import { emitEvent } from './telemetry.js';
import {
  COMBAT_HP_BASE,
  COMBAT_HP_HOMEGROUND_BONUS,
  COMBAT_DAMAGE_BASE,
  COMBAT_DAMAGE_HOMEGROUND,
  COMBAT_COOLDOWN_TICKS,
} from './constants.js';

/**
 * Sweep all live ants, bucket by tile, and resolve combat on tiles shared by 2+ colonies.
 * Dispatches to V15 (coin-flip) or V16 (HP/damage/cooldown) based on world.simVersion.
 */
export function detectAndResolveCombat(world: WorldState, rng: Rng): void {
  const { ants } = world;
  const count = ants.alive.length;

  // Bucket live ants by tileKey.
  const bucket = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.colonyId[i] === 0) continue;
    const tileX = ants.posX[i]! >> FP_SHIFT;
    const tileY = ants.posY[i]! >> FP_SHIFT;
    const key = makeTileKey(
      ants.zone[i] as unknown as Zone,
      tileX,
      tileY,
      ants.currentGridColonyId[i] as ColonyId,
    );
    const slot = bucket.get(key);
    if (slot === undefined) bucket.set(key, [i]);
    else slot.push(i);
  }

  // Deterministic iteration: sort tileKeys ascending.
  const keys = Array.from(bucket.keys()).sort((a, b) => a - b);
  for (const key of keys) {
    const participants = bucket.get(key)!;
    if (participants.length < 2) continue;
    const firstCid = ants.colonyId[participants[0]!]!;
    let multiColony = false;
    for (let j = 1; j < participants.length; j++) {
      if (ants.colonyId[participants[j]!]! !== firstCid) {
        multiColony = true;
        break;
      }
    }
    if (!multiColony) continue;
    if (world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS) {
      resolveCombatOnTile_v16(world, key, participants);
    } else {
      resolveCombatOnTile_v15(world, key, participants, rng);
    }
  }

  // Clear pendingQueenDeathContexts for ants that survived (i.e., where the queen kill
  // context was never consumed because the queen is alive). checkQueenDeath will consume
  // valid contexts the same tick. Reset transient array for next tick.
  // NOTE: actual clearing happens in checkQueenDeath per-colony; we leave the array
  // intact here so checkQueenDeath can read it after combat resolves.
}

// ---------------------------------------------------------------------------
// V15 legacy resolver — coin-flip instant-kill (frozen, byte-identical replay)
// ---------------------------------------------------------------------------

/**
 * Resolve combat on a single tile using the pre-V16 coin-flip model.
 * Called only when world.simVersion < SIM_VERSION_V16_COMBAT_HPDPS.
 */
export function resolveCombatOnTile_v15(world: WorldState, _tileKey: number, participants: readonly number[], rng: Rng): void {
  const { ants } = world;

  for (let iter = 0; iter < participants.length; iter++) {
    const byColony = new Map<ColonyId, number[]>();
    for (const idx of participants) {
      if (ants.alive[idx] !== 1) continue;
      const cid = ants.colonyId[idx]! as ColonyId;
      const list = byColony.get(cid);
      if (list === undefined) byColony.set(cid, [idx]);
      else list.push(idx);
    }
    if (byColony.size < 2) break;

    const cids = Array.from(byColony.keys()).sort((a, b) => a - b);
    const cidA = cids[0]!;
    const cidB = cids[1]!;
    const groupA = byColony.get(cidA)!;
    const groupB = byColony.get(cidB)!;
    groupA.sort((a, b) => a - b);
    groupB.sort((a, b) => a - b);
    const antA = groupA[0]!;
    const antB = groupB[0]!;

    const flip = rng.nextInt(2);
    if (flip === 0) {
      killAnt(world, antB, cidA, antA, 'Ant');
    } else {
      killAnt(world, antA, cidB, antB, 'Ant');
    }
  }
}

// ---------------------------------------------------------------------------
// V16 resolver — HP / damage / cooldown (S1 / D-32)
// ---------------------------------------------------------------------------

/**
 * Apply `damage` to `antIdx`, depleting homeGroundBonusHp first, then hp.
 * Returns true if the ant should die (hp <= 0 after depletion).
 */
function applyDamage(world: WorldState, antIdx: number, damage: number): boolean {
  const { ants } = world;
  let bonus = ants.homeGroundBonusHp[antIdx]!;
  if (bonus > 0) {
    if (damage <= bonus) {
      ants.homeGroundBonusHp[antIdx] = bonus - damage;
      return false;
    }
    // Damage overflows bonus into hp
    damage -= bonus;
    ants.homeGroundBonusHp[antIdx] = 0;
  }
  ants.hp[antIdx] = (ants.hp[antIdx]! - damage);
  return ants.hp[antIdx]! <= 0;
}

/**
 * Resolve combat on a single tile using the V16 HP/damage/cooldown model.
 * One active pair per tick (lowest slot from each colony). Strikes are simultaneous.
 */
function resolveCombatOnTile_v16(world: WorldState, _tileKey: number, participants: readonly number[]): void {
  const { ants } = world;

  // Group alive participants by colony; sort colony ids ascending for determinism.
  const byColony = new Map<ColonyId, number[]>();
  for (const idx of participants) {
    if (ants.alive[idx] !== 1) continue;
    const cid = ants.colonyId[idx]! as ColonyId;
    const list = byColony.get(cid);
    if (list === undefined) byColony.set(cid, [idx]);
    else list.push(idx);
  }
  if (byColony.size < 2) return;

  const cids = Array.from(byColony.keys()).sort((a, b) => a - b);
  const cidA = cids[0]!;
  const cidB = cids[1]!;
  const groupA = byColony.get(cidA)!;
  const groupB = byColony.get(cidB)!;
  groupA.sort((a, b) => a - b);
  groupB.sort((a, b) => a - b);
  // Active pair: lowest slot from each colony.
  const antA = groupA[0]!;
  const antB = groupB[0]!;

  // Windup: if either ant is not yet in combat (cooldown=0), both wind up together.
  // Resetting the veteran's cooldown prevents a cooldown phase lock when a replacement
  // opponent joins mid-cycle (otherwise the two cooldowns could cycle out of phase forever).
  const aNew = ants.attackCooldown[antA] === 0;
  const bNew = ants.attackCooldown[antB] === 0;

  if (aNew || bNew) {
    ants.attackCooldown[antA] = COMBAT_COOLDOWN_TICKS;
    ants.attackCooldown[antB] = COMBAT_COOLDOWN_TICKS;
    // New ants get a fresh bonus based on their current position. Veteran ants
    // (forced into re-windup because their opponent is new) keep their depleted bonus
    // if still on home ground; it's zeroed if they've since moved off home ground.
    // This prevents both unintended healing (bonus restored on replacement) and
    // stale bonus (bonus persists after leaving home ground).
    const aOnHome = ants.zone[antA] === 1 && ants.currentGridColonyId[antA] === ants.colonyId[antA]!;
    const bOnHome = ants.zone[antB] === 1 && ants.currentGridColonyId[antB] === ants.colonyId[antB]!;
    if (aNew) {
      ants.homeGroundBonusHp[antA] = aOnHome ? COMBAT_HP_HOMEGROUND_BONUS : 0;
    } else if (!aOnHome) {
      ants.homeGroundBonusHp[antA] = 0;
    }
    if (bNew) {
      ants.homeGroundBonusHp[antB] = bOnHome ? COMBAT_HP_HOMEGROUND_BONUS : 0;
    } else if (!bOnHome) {
      ants.homeGroundBonusHp[antB] = 0;
    }
    return;
  }

  // Decrement cooldowns. Strike when either reaches 0.
  ants.attackCooldown[antA] = ants.attackCooldown[antA]! - 1;
  ants.attackCooldown[antB] = ants.attackCooldown[antB]! - 1;

  const aStrikes = ants.attackCooldown[antA] === 0;
  const bStrikes = ants.attackCooldown[antB] === 0;

  if (!aStrikes && !bStrikes) return;

  // Compute damage dealt by each striker. Only AntTask.Fighting ants deal damage;
  // workers, nurses, and queens caught in combat do not strike back (spec Part A §3).
  const aDamage = aStrikes && ants.task[antA] === AntTask.Fighting
    ? ((ants.zone[antA] === 1 && ants.currentGridColonyId[antA] === ants.colonyId[antA]!)
        ? COMBAT_DAMAGE_HOMEGROUND
        : COMBAT_DAMAGE_BASE)
    : 0;
  const bDamage = bStrikes && ants.task[antB] === AntTask.Fighting
    ? ((ants.zone[antB] === 1 && ants.currentGridColonyId[antB] === ants.colonyId[antB]!)
        ? COMBAT_DAMAGE_HOMEGROUND
        : COMBAT_DAMAGE_BASE)
    : 0;

  // Simultaneous damage: compute both death results before killing either.
  const aDies = bDamage > 0 && applyDamage(world, antA, bDamage);
  const bDies = aDamage > 0 && applyDamage(world, antB, aDamage);

  // Reset cooldowns for survivors (dead ants' cooldowns are irrelevant).
  if (aStrikes && !aDies) ants.attackCooldown[antA] = COMBAT_COOLDOWN_TICKS;
  if (bStrikes && !bDies) ants.attackCooldown[antB] = COMBAT_COOLDOWN_TICKS;

  // Kill dead ants. Event ordering: combat_kill emitted first (in killAnt),
  // then queen_death (in checkQueenDeath after this resolver returns).
  if (bDies) killAnt(world, antB, cidA as ColonyId, antA, 'Ant');
  if (aDies) killAnt(world, antA, cidB as ColonyId, antB, 'Ant');

  // After a kill, survivors retain their current cooldown (set to COMBAT_COOLDOWN_TICKS
  // above on their strike tick). When a new opponent joins on the next tick, the
  // "reset both when either is new" rule synchronizes their cooldowns — no separate
  // reset needed here. Zeroing cooldown here would falsely mark the survivor as "new"
  // on the next tick, which would reset their home-ground bonus (unintended healing).
}

// ---------------------------------------------------------------------------
// killAnt — single write path for ant death
// ---------------------------------------------------------------------------

/**
 * Kill ant at `antIndex`. Emits a combat_kill event (S1). Writes
 * pendingQueenDeathContexts if the victim is a queen (read by checkQueenDeath
 * later the same tick to fill in queen_death cause). Increments killer killCount.
 *
 * killerColonyId: colony that made the kill (null for environmental kills).
 * killerId: entity slot of the killing ant (null for non-ant kills).
 * killerKind: 'Ant' in S1/S2; 'Spider' in S5; 'Environment' reserved.
 *
 * Issue #107 (v13+) — atomically clears bidirectional carry pointers.
 */
export function killAnt(
  world: WorldState,
  antIndex: number,
  killerColonyId: ColonyId | null,
  killerId: number | null,
  killerKind: KillerKind,
): void {
  const ants = world.ants;
  if (world.simVersion >= SIM_VERSION_V13_INVARIANT_FIXES) {
    const carrying = ants.carryingBroodId[antIndex]!;
    if (carrying !== -1) {
      ants.carriedBy[carrying] = -1;
      ants.carryingBroodId[antIndex] = -1;
    }
    const carrier = ants.carriedBy[antIndex]!;
    if (carrier !== -1) {
      ants.carryingBroodId[carrier] = -1;
      ants.carriedBy[antIndex] = -1;
    }
  }

  const victimColonyId = ants.colonyId[antIndex]! as ColonyId;
  const tileX = ants.posX[antIndex]! >> FP_SHIFT;
  const tileY = ants.posY[antIndex]! >> FP_SHIFT;
  const currentGridColonyId = ants.currentGridColonyId[antIndex]! as ColonyId;

  // Emit combat_kill event and write queen death context (S1 telemetry, V16+ only).
  if (world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS) {
    const victimColony = world.colonies[victimColonyId];
    const isQueenVictim = victimColony !== undefined && antIndex === victimColony.queenEntityId;

    // combat_kill is only emitted for Ant/Spider kills; Environment is reserved (no event).
    if (killerKind !== 'Environment') {
      emitEvent(world, {
        tick: world.tick,
        type: 'combat_kill',
        payload: {
          killer: { kind: killerKind, id: killerId, colonyId: killerColonyId },
          victim: {
            // Queen victims use kind 'Queen' so analytics can filter without re-deriving role.
            kind: isQueenVictim ? 'Queen' : 'Ant',
            id: antIndex,
            colonyId: victimColonyId,
          },
          location: {
            x: tileX,
            y: tileY,
            grid: ants.zone[antIndex] === 0 ? 'surface' : 'underground',
          },
        },
      });
    }

    // Write queen death context regardless of killerKind so checkQueenDeath can
    // fill in the cause field for queen_death events from any kill source.
    if (isQueenVictim) {
      const ctx: QueenDeathContext = {
        tile: { x: tileX, y: tileY },
        currentGridColonyId,
        killerColonyId,
        killerId,
        killerKind,
      };
      world.pendingQueenDeathContexts[victimColonyId] = ctx;
    }
  }

  ants.alive[antIndex] = 0;
  // Reset combat state so replacement ants wind up fresh.
  ants.attackCooldown[antIndex] = 0;

  if (killerColonyId !== null && killerColonyId !== 0) {
    const killerColony = world.colonies[killerColonyId];
    if (killerColony !== undefined) {
      killerColony.killCount += 1;
    }
  }
}
