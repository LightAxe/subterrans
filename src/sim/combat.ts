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
import { SIM_VERSION_V23_SPIDER_AGGRO } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import type { Zone } from './terrain.js';
import { FP_SHIFT } from './fixed.js';
import { emitEvent } from './telemetry.js';
import {
  COMBAT_HP_HOMEGROUND_BONUS,
  COMBAT_DAMAGE_BASE,
  COMBAT_DAMAGE_HOMEGROUND,
  COMBAT_COOLDOWN_TICKS,
  COMBAT_DAMAGE_WORKER,
  COMBAT_DAMAGE_QUEEN,
  SPIDER_DAMAGE,
  SPIDER_SWARM_FIGHTER_THRESHOLD,
} from './constants.js';
import { isInCohort } from './ai-state.js';

// ---------------------------------------------------------------------------
// Per-tick combat-sweep scratch (no-alloc rule, AGENTS.md hot-loop section).
//
// These module-level buffers are TRANSIENT scratch: reset at the top of
// detectAndResolveCombat and fully consumed within that single synchronous
// call. They hold no cross-tick or cross-world state — a tick runs to
// completion before any other world ticks — so, like SPIDER_TILE_SCRATCH
// below, sharing one module instance across worlds cannot bleed state (this
// is unlike the persistent flow-field caches, which are correctly scoped
// per-world). They replace the per-tick Map/Set/Array.from/sort allocations
// the bucketing sweep used to make on every tick, including no-combat ticks.
//
//   COMBAT_LIVE_IDX   — live, colony-affiliated ant slots, sorted by
//                       (tileKey, slot) ascending.
//   COMBAT_KEY_BY_SLOT — tileKey indexed by ant slot (written for live slots
//                       only; read by the sort comparator and run-walk).
//   COMBAT_CONTESTED  — 1 for ants on a multi-colony tile this tick, else 0.
const COMBAT_LIVE_IDX: number[] = [];
let COMBAT_KEY_BY_SLOT = new Int32Array(0);
let COMBAT_CONTESTED = new Uint8Array(0);

/** Sort comparator: tileKey ascending, then ant slot ascending (deterministic). */
function compareBySweepKey(a: number, b: number): number {
  const ka = COMBAT_KEY_BY_SLOT[a]!;
  const kb = COMBAT_KEY_BY_SLOT[b]!;
  return ka !== kb ? ka - kb : a - b;
}

/**
 * Sweep all live ants, group by tile, and resolve combat on tiles shared by 2+
 * colonies. Uses reusable scratch buffers instead of per-tick allocation: live
 * ants are sorted by (tileKey, slot) and processed in equal-tileKey runs.
 */
export function detectAndResolveCombat(world: WorldState, _rng: Rng): void {
  const { ants } = world;
  const count = ants.alive.length;

  if (COMBAT_KEY_BY_SLOT.length < count) COMBAT_KEY_BY_SLOT = new Int32Array(count);
  if (COMBAT_CONTESTED.length < count) COMBAT_CONTESTED = new Uint8Array(count);
  COMBAT_CONTESTED.fill(0, 0, count);

  // Collect live, colony-affiliated ants and their tileKeys (ascending by slot).
  const liveIdx = COMBAT_LIVE_IDX;
  liveIdx.length = 0;
  for (let i = 0; i < count; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.colonyId[i] === 0) continue;
    const tileX = ants.posX[i]! >> FP_SHIFT;
    const tileY = ants.posY[i]! >> FP_SHIFT;
    COMBAT_KEY_BY_SLOT[i] = makeTileKey(
      ants.zone[i] as unknown as Zone,
      tileX,
      tileY,
      ants.currentGridColonyId[i] as ColonyId,
    );
    liveIdx.push(i);
  }

  // Deterministic iteration: ants ordered by tileKey ascending, slot ascending.
  // Equal-tileKey runs are contiguous; within a run, slots ascend (so the first
  // ant of each colony in a run is that colony's lowest slot).
  liveIdx.sort(compareBySweepKey);
  const m = liveIdx.length;

  // First pass: flag every ant on a multi-colony contested tile. Any live ant
  // NOT flagged has disengaged; its combatOpponentId is stale and must be
  // cleared so the next encounter triggers a fresh windup (Codex P1 finding).
  for (let p = 0; p < m; ) {
    const runStart = p;
    const key = COMBAT_KEY_BY_SLOT[liveIdx[p]!]!;
    p++;
    while (p < m && COMBAT_KEY_BY_SLOT[liveIdx[p]!]! === key) p++;
    if (p - runStart < 2) continue;
    const firstCid = ants.colonyId[liveIdx[runStart]!]!;
    let multiColony = false;
    for (let q = runStart + 1; q < p; q++) {
      if (ants.colonyId[liveIdx[q]!]! !== firstCid) { multiColony = true; break; }
    }
    if (multiColony) {
      for (let q = runStart; q < p; q++) COMBAT_CONTESTED[liveIdx[q]!] = 1;
    }
  }
  for (let i = 0; i < count; i++) {
    // -2 is the spider-pairing sentinel; skip it here so resolveSpiderCombatOnTile
    // can preserve windup state. The sentinel is cleared by clearSpiderPairingSentinels.
    if (ants.alive[i] === 1 && COMBAT_CONTESTED[i] === 0 && ants.combatOpponentId[i] !== -2) {
      ants.combatOpponentId[i] = -1;
    }
  }

  // Second pass: resolve each multi-colony run. The resolver re-checks the
  // colony split internally and returns early for single-colony runs.
  for (let p = 0; p < m; ) {
    const runStart = p;
    const key = COMBAT_KEY_BY_SLOT[liveIdx[p]!]!;
    p++;
    while (p < m && COMBAT_KEY_BY_SLOT[liveIdx[p]!]! === key) p++;
    if (p - runStart < 2) continue;
    resolveCombatOnTile_v16(world, liveIdx, runStart, p);
  }

  // S3 — spider combat: resolve spider vs ants on the spider's tile.
  // Pre-V23: only the combat-active states (Striking, Rampaging) engage.
  // V23 (#146/#147): every surface state engages so the spider always bites back
  // any ant attacking it (always-on self-defense). Only Feeding sits off the gate
  // — interruption is handled in tickSpiderV23 the tick a fighter reaches it.
  // Retreating is unused in V23 (normalized to Patrolling on the first tick).
  if (world.spider !== null) {
    const ss = world.spider.state;
    const spiderCombatActive =
      ss === 'Striking' || ss === 'Rampaging' ||
      (world.simVersion >= SIM_VERSION_V23_SPIDER_AGGRO &&
        ss !== 'Feeding' && ss !== 'Retreating');
    if (spiderCombatActive) {
      resolveSpiderCombatOnTile(world);
    }
  }

  // Clear pendingQueenDeathContexts for ants that survived (i.e., where the queen kill
  // context was never consumed because the queen is alive). checkQueenDeath will consume
  // valid contexts the same tick. Reset transient array for next tick.
  // NOTE: actual clearing happens in checkQueenDeath per-colony; we leave the array
  // intact here so checkQueenDeath can read it after combat resolves.
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
  // Non-fighters retaliate with reduced damage.
  const cid = ants.colonyId[antId]! as ColonyId;
  const colony = world.colonies[cid];
  if (colony == null) return 0;
  if (colony.queenEntityId === antId) return COMBAT_DAMAGE_QUEEN;
  // Brood (eggs/larvae share AntTask.Idle with adult workers) cannot retaliate.
  if (colony.eggs.includes(antId) || colony.larvae.includes(antId)) return 0;
  return COMBAT_DAMAGE_WORKER;
}

/**
 * Resolve combat on a single tile using the V16 HP/damage/cooldown model.
 * One active pair per tick (lowest slot from each colony). Strikes are simultaneous.
 *
 * Participants are `liveIdx[lo..hi)` — alive, colony-affiliated ant slots sharing
 * one tileKey, ascending by slot. The active pair is the lowest slot from each of
 * the two lowest colony ids; a single pass finds them without allocating.
 */
function resolveCombatOnTile_v16(
  world: WorldState,
  liveIdx: readonly number[],
  lo: number,
  hi: number,
): void {
  const { ants } = world;

  // Single pass: track the two lowest colony ids (cidA < cidB) and, for each,
  // its lowest-slot ant. Because participants ascend by slot, the first ant seen
  // for a colony is that colony's lowest slot. Colonies above the two lowest are
  // ignored — only the active pair matters this tick.
  let cidA = -1, antA = -1, cidB = -1, antB = -1;
  for (let p = lo; p < hi; p++) {
    const idx = liveIdx[p]!;
    if (ants.alive[idx] !== 1) continue;
    const cid = ants.colonyId[idx]!;
    if (cid === cidA || cid === cidB) continue; // lowest slot already captured
    if (cidA === -1 || cid < cidA) {
      cidB = cidA; antB = antA; // demote current minimum
      cidA = cid; antA = idx;
    } else if (cidB === -1 || cid < cidB) {
      cidB = cid; antB = idx;
    }
    // else: cid is larger than both tracked colonies — not part of the active pair.
  }
  if (cidB === -1) return; // fewer than two distinct colonies present

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
    const fighterStrikesNow = (aNew && aIsFighter) || (bNew && bIsFighter);
    // Only reset the newly-paired side — veterans keep accumulated progress.
    // Non-fighters start at COMBAT_COOLDOWN_TICKS+1 when fighterStrikesNow so the
    // immediate decrement below leaves them at exactly COMBAT_COOLDOWN_TICKS.
    if (aNew) ants.attackCooldown[antA] = aIsFighter ? 1 : COMBAT_COOLDOWN_TICKS + (fighterStrikesNow ? 1 : 0);
    if (bNew) ants.attackCooldown[antB] = bIsFighter ? 1 : COMBAT_COOLDOWN_TICKS + (fighterStrikesNow ? 1 : 0);
    // Return early unless a newly-paired fighter is about to strike (cooldown=1).
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

  const victimColonyId = ants.colonyId[antIndex]! as ColonyId;
  const tileX = ants.posX[antIndex]! >> FP_SHIFT;
  const tileY = ants.posY[antIndex]! >> FP_SHIFT;
  const currentGridColonyId = ants.currentGridColonyId[antIndex]! as ColonyId;

  // Emit combat_kill event and write queen death context.
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

  ants.alive[antIndex] = 0;
  // Reset combat state so replacement ants wind up fresh.
  ants.attackCooldown[antIndex] = 0;
  ants.combatOpponentId[antIndex] = -1;

  // S2 — increment operation death counters if an active operation is running.
  // QC Pass 4 AR-P1-001: precise predicates using committed-cohort lookup.
  // CLNY-08: no direct PLAYER_COLONY_ID / ENEMY_COLONY_ID equality branching.
  // Instead, iterate world.aiState to find any active operation that involves this kill.
  for (let _ai = 0; _ai < world.aiState.length; _ai++) {
    const enemyAI = world.aiState[_ai]!;
    if (enemyAI.operationKind === 'None') continue;
    const aiColId = enemyAI.colonyId;
    const victimColId = ants.colonyId[antIndex]! as ColonyId;
    // operationAttackerDeaths: victim is a committed-cohort AI fighter.
    if (victimColId === aiColId
        && isInCohort(antIndex, enemyAI.operationFighterIds, enemyAI.operationFighterCount)) {
      enemyAI.operationAttackerDeaths += 1;
    }
    // operationDefenderDeaths: victim is a non-AI ant (defender) killed by a committed-cohort AI fighter.
    if (victimColId !== aiColId
        && killerKind === 'Ant'
        && killerColonyId === aiColId
        && killerId !== null
        && isInCohort(killerId, enemyAI.operationFighterIds, enemyAI.operationFighterCount)) {
      enemyAI.operationDefenderDeaths += 1;
    }
  }

  if (killerColonyId !== null && killerColonyId !== 0) {
    const killerColony = world.colonies[killerColonyId];
    if (killerColony !== undefined) {
      killerColony.killCount += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// S3 — Spider combat resolver
// ---------------------------------------------------------------------------

// Module-level scratch buffer: reused each call to resolveSpiderCombatOnTile to
// avoid per-tick allocation in the combat hot path (AGENTS.md no-alloc rule).
const SPIDER_TILE_SCRATCH: number[] = [];

/**
 * Resolve one combat tick between the spider and ants on its tile.
 * Called from detectAndResolveCombat after the ant-vs-ant loop.
 *
 * Spider gets its own active pair with the first fighter (or any ant) on
 * its tile. Swarm bonus applies when: world.spiderPriorityColonyId !== null AND
 * >= SPIDER_SWARM_FIGHTER_THRESHOLD fighters share the tile. Each
 * priority-colony fighter then acts with an independent cooldown (true N-fighter DPS).
 *
 * Per the evaluation-order rule (spec Part B): combat damage is applied
 * here; tickSpider (step 17.5) reads spider.hp and evaluates the
 * Retreating threshold afterward.
 */
export function resolveSpiderCombatOnTile(world: WorldState): void {
  const spider = world.spider!;
  const { ants } = world;

  const spiderTileX = spider.posX >> FP_SHIFT;
  const spiderTileY = spider.posY >> FP_SHIFT;

  // Collect non-queen ants on the spider's surface tile.
  // Queens are excluded: they are either underground or at a colony start — spider
  // combat targets workers and fighters, not colony queens.

  // Pre-scan colony queen IDs to avoid O(ants × colonies) nested loop per tick.
  // Two local vars cover the current max of 2 active colonies (player + AI).
  let queenId0 = -1;
  let queenId1 = -1;
  for (const ckey in world.colonies) {
    if (!Object.hasOwn(world.colonies, ckey)) continue;
    const col = world.colonies[ckey as unknown as import('./colony/colony-store.js').ColonyId];
    if (col === undefined) continue;
    if (queenId0 < 0) queenId0 = col.queenEntityId;
    else queenId1 = col.queenEntityId;
  }

  const onTile = SPIDER_TILE_SCRATCH;
  onTile.length = 0;
  const count = ants.alive.length;
  for (let i = 0; i < count; i++) {
    if (ants.alive[i] !== 1) continue;
    if (ants.zone[i] !== 0) continue; // surface only
    const ax = ants.posX[i]! >> FP_SHIFT;
    const ay = ants.posY[i]! >> FP_SHIFT;
    if (ax !== spiderTileX || ay !== spiderTileY) continue;
    if (i === queenId0 || i === queenId1) continue; // skip queens
    onTile.push(i);
  }
  if (onTile.length === 0) {
    // No ants on tile — nothing to resolve this tick.
    return;
  }

  // onTile was built by ascending-index scan — already in order; no sort needed.
  // INVARIANT: contents must remain ascending; downstream tiebreaks (activeAntIdx,
  // swarmRetaliationTarget) rely on lowest-slot-index winning.

  // Prefer AntTask.Fighting ants for the active pair; fall back to any ant.
  let activeAntIdx = onTile[0]!;
  for (const idx of onTile) {
    if (ants.task[idx] === AntTask.Fighting) {
      activeAntIdx = idx;
      break;
    }
  }

  // Swarm bonus: priority set AND enough fighters from the priority colony on tile.
  // Count only priority-colony fighters to avoid granting the bonus to enemy ants.
  const priorityColonyId = world.spiderPriorityColonyId;
  let fighterCount = 0;
  if (priorityColonyId !== null) {
    for (const idx of onTile) {
      if (ants.task[idx] === AntTask.Fighting && ants.colonyId[idx] === priorityColonyId) {
        fighterCount += 1;
      }
    }
  }
  const swarmActive = priorityColonyId !== null && fighterCount >= SPIDER_SWARM_FIGHTER_THRESHOLD;

  if (swarmActive) {
    // --- Swarm path: each priority-colony fighter acts independently per tick. ---
    // Spider retaliates once per tick against a priority-colony fighter.
    // This gives true N-fighter DPS rather than 4× single-fighter approximation.

    // Retaliation target = first priority-colony fighter on tile (lowest slot index).
    // anyVeteranPaired = true if at least one fighter is already paired this episode.
    // Used below to avoid resetting spider windup on late-joiner arrivals.
    // Use -1 sentinel (not activeAntIdx) so the first match is unconditionally accepted.
    let swarmRetaliationTarget = -1;
    let anyVeteranPaired = false;
    for (const idx of onTile) {
      // Veteran check is tile-wide: any -2 (including non-priority colony fighters)
      // counts as an ongoing engagement that should not reset the spider's windup.
      if (ants.combatOpponentId[idx] === -2) anyVeteranPaired = true;
      if (ants.task[idx] !== AntTask.Fighting || ants.colonyId[idx] !== priorityColonyId) continue;
      if (swarmRetaliationTarget === -1) swarmRetaliationTarget = idx;
    }
    // swarmActive guarantees fighterCount >= SPIDER_SWARM_FIGHTER_THRESHOLD >= 1,
    // so the loop above always finds at least one priority fighter.
    if (swarmRetaliationTarget === -1) swarmRetaliationTarget = activeAntIdx;

    let totalAntDamage = 0;
    let anyNewPairing = false;
    for (const idx of onTile) {
      if (ants.task[idx] !== AntTask.Fighting) continue;
      if (ants.colonyId[idx] !== priorityColonyId) continue;
      if (ants.combatOpponentId[idx] !== -2) {
        // First contact for this fighter: pair and set windup.
        ants.combatOpponentId[idx] = -2;
        ants.attackCooldown[idx] = COMBAT_COOLDOWN_TICKS;
        ants.homeGroundBonusHp[idx] = 0; // spider is surface-only; underground bonus does not apply
        anyNewPairing = true;
        continue;
      }
      const cd = ants.attackCooldown[idx]! - 1;
      ants.attackCooldown[idx] = cd;
      if (cd === 0) {
        totalAntDamage += COMBAT_DAMAGE_BASE;
        ants.attackCooldown[idx] = COMBAT_COOLDOWN_TICKS;
      }
    }

    // Spider windup: reset only on the first tick of engagement (no veterans yet paired).
    // A late-joining fighter should not pause the spider's attack cycle while veterans
    // are already dealing damage — that would be exploitable stagger.
    // Mirror non-swarm early-return: no decrement on the same tick as a first-ever engagement.
    if (anyNewPairing && !anyVeteranPaired) {
      spider.attackCooldown = COMBAT_COOLDOWN_TICKS;
    } else {
      spider.attackCooldown = spider.attackCooldown > 0 ? spider.attackCooldown - 1 : 0;
    }
    const spiderStrikes = spider.attackCooldown === 0;
    const spiderDamage = spiderStrikes ? SPIDER_DAMAGE : 0;

    if (totalAntDamage === 0 && spiderDamage === 0) return;

    // Apply simultaneously.
    const antDies = spiderDamage > 0 && applyDamage(world, swarmRetaliationTarget, spiderDamage);

    if (totalAntDamage > 0) {
      spider.hp -= totalAntDamage;
      if (spider.hp <= 0) {
        // Clear on-tile swarm fighter pairings immediately; off-tile sentinels
        // are cleared by clearSpiderPairingSentinels in tickSpider the same tick.
        for (const idx of onTile) {
          if (ants.colonyId[idx] === priorityColonyId && ants.combatOpponentId[idx] === -2) {
            ants.combatOpponentId[idx] = -1;
          }
        }
      }
    }
    if (spiderStrikes && spider.hp > 0) {
      spider.attackCooldown = COMBAT_COOLDOWN_TICKS;
    }
    if (antDies) {
      if (spider.state === 'Striking') spider.killsThisStrike += 1;
      if (spider.state === 'Rampaging') spider.rampageKillsThisRampage += 1;
      if (world.simVersion >= SIM_VERSION_V23_SPIDER_AGGRO) {
        spider.killedThisTick = 1;
        spider.lastKillTileX = spiderTileX;
        spider.lastKillTileY = spiderTileY;
      }
      killAnt(world, swarmRetaliationTarget, null, null, 'Spider');
    }
    return;
  }

  // --- Non-swarm path: single activeAntIdx, unchanged S1 semantics. ---
  const antCurrentOpponent = ants.combatOpponentId[activeAntIdx]!;
  const isNewPairing = antCurrentOpponent !== -2;

  if (isNewPairing) {
    // Fresh pair: set windup (no strike this tick).
    ants.attackCooldown[activeAntIdx] = COMBAT_COOLDOWN_TICKS;
    ants.combatOpponentId[activeAntIdx] = -2; // sentinel: paired with spider
    ants.homeGroundBonusHp[activeAntIdx] = 0; // spider is surface-only; underground bonus does not apply
    spider.attackCooldown = COMBAT_COOLDOWN_TICKS;
    return;
  }

  // Decrement cooldowns.
  const antCooldown = ants.attackCooldown[activeAntIdx]! - 1;
  ants.attackCooldown[activeAntIdx] = antCooldown;
  spider.attackCooldown = spider.attackCooldown > 0 ? spider.attackCooldown - 1 : 0;

  const antStrikes = antCooldown === 0;
  const spiderStrikes2 = spider.attackCooldown === 0;

  if (!antStrikes && !spiderStrikes2) return;

  // Ant damage: fighters only; no swarm multiplier (swarmActive is false here).
  let antDamage = 0;
  if (antStrikes && ants.task[activeAntIdx] === AntTask.Fighting) {
    antDamage = COMBAT_DAMAGE_BASE;
  }

  // Spider damage.
  const spiderDamage2 = spiderStrikes2 ? SPIDER_DAMAGE : 0;

  // Apply damage simultaneously.
  const antDies2 = spiderDamage2 > 0 && applyDamage(world, activeAntIdx, spiderDamage2);

  if (antDamage > 0) {
    spider.hp -= antDamage;
    if (spider.hp <= 0) {
      ants.combatOpponentId[activeAntIdx] = -1;
    }
  }

  if (antStrikes && !antDies2) {
    ants.attackCooldown[activeAntIdx] = COMBAT_COOLDOWN_TICKS;
  }
  if (spiderStrikes2 && spider.hp > 0) {
    spider.attackCooldown = COMBAT_COOLDOWN_TICKS;
  }

  if (antDies2) {
    if (spider.state === 'Striking') spider.killsThisStrike += 1;
    if (spider.state === 'Rampaging') spider.rampageKillsThisRampage += 1;
    if (world.simVersion >= SIM_VERSION_V23_SPIDER_AGGRO) {
      spider.killedThisTick = 1;
      spider.lastKillTileX = spiderTileX;
      spider.lastKillTileY = spiderTileY;
    }
    killAnt(world, activeAntIdx, null, null, 'Spider');
  }
}
