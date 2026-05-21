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
import { SIM_VERSION_V13_INVARIANT_FIXES, SIM_VERSION_V16_COMBAT_HPDPS, SIM_VERSION_V17_COMBAT_AGGRO } from './types.js';
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
  COMBAT_DAMAGE_WORKER,
  COMBAT_DAMAGE_QUEEN,
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

  // First pass: collect all ants that are currently on multi-colony contested tiles.
  // Any live ant NOT in this set has disengaged; its combatOpponentId is stale and
  // must be cleared so the next encounter triggers a fresh windup (Codex P1 finding).
  if (world.simVersion >= SIM_VERSION_V16_COMBAT_HPDPS) {
    const contestedSet = new Set<number>();
    for (const key of keys) {
      const participants = bucket.get(key)!;
      if (participants.length < 2) continue;
      const firstCid = ants.colonyId[participants[0]!]!;
      let multiColony = false;
      for (let j = 1; j < participants.length; j++) {
        if (ants.colonyId[participants[j]!]! !== firstCid) { multiColony = true; break; }
      }
      if (multiColony) {
        for (const idx of participants) contestedSet.add(idx);
      }
    }
    for (let i = 0; i < count; i++) {
      if (ants.alive[i] === 1 && !contestedSet.has(i)) {
        ants.combatOpponentId[i] = -1;
      }
    }
  }

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
 * Damage dealt by `antId` when it strikes. Fighters use home-ground damage or base;
 * queen uses COMBAT_DAMAGE_QUEEN; all other non-fighters use COMBAT_DAMAGE_WORKER.
 * Returns 0 if the ant does not strike (strikes=false).
 */
function strikeDamage(world: WorldState, antId: number, strikes: boolean): number {
  if (!strikes) return 0;
  const { ants } = world;
  if (ants.task[antId] === AntTask.Fighting) {
    return (ants.zone[antId] === 1 && ants.currentGridColonyId[antId] === ants.colonyId[antId]!)
      ? COMBAT_DAMAGE_HOMEGROUND
      : COMBAT_DAMAGE_BASE;
  }
  // V17+: non-fighters retaliate with reduced damage. Pre-V17: 0 (replay-safe for V16 saves).
  if (world.simVersion < SIM_VERSION_V17_COMBAT_AGGRO) return 0;
  const cid = ants.colonyId[antId]! as ColonyId;
  const colony = world.colonies[cid];
  return colony != null && colony.queenEntityId === antId ? COMBAT_DAMAGE_QUEEN : COMBAT_DAMAGE_WORKER;
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

  // New-pairing detection: compare current opponent to the stored one.
  // This correctly handles veteran-veteran first contacts (both have non-zero
  // cooldowns from prior fights but combatOpponentId differs from the new match).
  const aNew = ants.combatOpponentId[antA] !== antB;
  const bNew = ants.combatOpponentId[antB] !== antA;

  // aFresh/bFresh: ant has never entered V16 combat (cooldown still 0 from initAnt
  // or save migration). Used to decide whether to grant a fresh home-ground bonus.
  // Distinct from aNew (new pairing) — a post-kill survivor has aNew=true (new
  // opponent) but aFresh=false (cooldown was COMBAT_COOLDOWN_TICKS, not 0).
  const aFresh = ants.attackCooldown[antA] === 0;
  const bFresh = ants.attackCooldown[antB] === 0;

  if (aNew || bNew) {
    ants.combatOpponentId[antA] = antB;
    ants.combatOpponentId[antB] = antA;
    // Fresh ants get a full bonus based on current location.
    // Veteran ants (new pairing, but were already in combat) keep their depleted
    // bonus if still on home ground; it's zeroed if they've moved off home ground.
    // This prevents unintended healing (bonus restored on replacement) while
    // also clearing stale bonus after a position change.
    const aOnHome = ants.zone[antA] === 1 && ants.currentGridColonyId[antA] === ants.colonyId[antA]!;
    const bOnHome = ants.zone[antB] === 1 && ants.currentGridColonyId[antB] === ants.colonyId[antB]!;
    if (aFresh) {
      ants.homeGroundBonusHp[antA] = aOnHome ? COMBAT_HP_HOMEGROUND_BONUS : 0;
    } else if (!aOnHome) {
      ants.homeGroundBonusHp[antA] = 0;
    }
    if (bFresh) {
      ants.homeGroundBonusHp[antB] = bOnHome ? COMBAT_HP_HOMEGROUND_BONUS : 0;
    } else if (!bOnHome) {
      ants.homeGroundBonusHp[antB] = 0;
    }
    // Fighters skip windup (always ready to strike); non-fighters wind up.
    // Only reset cooldown for the newly-paired side — the other side keeps its
    // accumulated progress to avoid penalizing an ongoing combatant on a re-entry.
    const aIsFighter = ants.task[antA] === AntTask.Fighting;
    const bIsFighter = ants.task[antB] === AntTask.Fighting;
    const skipWindup = world.simVersion >= SIM_VERSION_V17_COMBAT_AGGRO;
    const fighterStrikesNow = skipWindup && ((aNew && aIsFighter) || (bNew && bIsFighter));
    if (skipWindup) {
      // V17+: only reset the newly-paired side — veterans keep accumulated progress.
      // Non-fighters start at COMBAT_COOLDOWN_TICKS+1 when fighterStrikesNow so the
      // immediate decrement below leaves them at exactly COMBAT_COOLDOWN_TICKS.
      if (aNew) ants.attackCooldown[antA] = aIsFighter ? 1 : COMBAT_COOLDOWN_TICKS + (fighterStrikesNow ? 1 : 0);
      if (bNew) ants.attackCooldown[antB] = bIsFighter ? 1 : COMBAT_COOLDOWN_TICKS + (fighterStrikesNow ? 1 : 0);
    } else {
      // Pre-V17: reset both sides unconditionally — preserves V16 replay semantics.
      ants.attackCooldown[antA] = COMBAT_COOLDOWN_TICKS;
      ants.attackCooldown[antB] = COMBAT_COOLDOWN_TICKS;
    }
    // Return early unless a newly-paired V17 fighter is about to strike (cooldown=1).
    // In pre-V17, fighterStrikesNow is always false, so this always returns.
    if (!fighterStrikesNow) return;
  }

  // Decrement cooldowns. Strike when either reaches 0.
  ants.attackCooldown[antA] = ants.attackCooldown[antA]! - 1;
  ants.attackCooldown[antB] = ants.attackCooldown[antB]! - 1;

  const aStrikes = ants.attackCooldown[antA] === 0;
  const bStrikes = ants.attackCooldown[antB] === 0;

  if (!aStrikes && !bStrikes) return;

  // Damage by task: fighters deal full damage (with home-ground bonus); non-fighters
  // fight back weakly. Queen uses COMBAT_DAMAGE_QUEEN (identified via colony.queenEntityId);
  // all other non-fighters use COMBAT_DAMAGE_WORKER. Queen damage flagged TBD for S6-Tune.
  const aDamage = strikeDamage(world, antA, aStrikes);
  const bDamage = strikeDamage(world, antB, bStrikes);

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

  // After a kill, clear the survivor's opponent tracking so the next encounter
  // is detected as a new pairing (triggering proper windup and home-ground bonus
  // normalization). The survivor's cooldown stays at COMBAT_COOLDOWN_TICKS (set
  // at the strike tick above), so aFresh=false on the next windup — the depleted
  // bonus is preserved for home-ground survivors and zeroed for off-home ones.
  if (bDies && !aDies) ants.combatOpponentId[antA] = -1;
  if (aDies && !bDies) ants.combatOpponentId[antB] = -1;
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
  ants.combatOpponentId[antIndex] = -1;

  if (killerColonyId !== null && killerColonyId !== 0) {
    const killerColony = world.colonies[killerColonyId];
    if (killerColony !== undefined) {
      killerColony.killCount += 1;
    }
  }
}
