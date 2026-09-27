// ant-death.ts — the single ant-death chokepoint (#289).
//
// Every production ant death routes through `despawnAnt`: combat and spider kills
// (combat.ts, via the `killAnt` sugar below), starvation (colony-system.ts
// tickFoodConsumption: queen and larva, and from V51 worker/fighter) and the worker lifespan check
// (lifecycle-system.ts). Before #289 only the kills had a write path — `killAnt`
// lived in combat.ts — while the starvation and lifespan sites flipped `alive = 0`
// inline with their own subset of the cleanup, so an on-death hook (corpse food,
// counters, a queen-death context) had to be added in three places or silently
// miss the non-combat deaths. scripts/check-sim-boundary.sh now fails any other
// `alive[…] = 0` in production src/.
//
// Replay contract. The kill path is the old combat.ts `killAnt`, unchanged at every
// simVersion. The non-kill paths are gated: below V41 they do exactly what the old
// inline sites did — `alive = 0`, plus `broodFieldDirty` for a larva or worker but
// NOT for a starving queen, and nothing else (carry pointers stay stale, no
// queen-death context, no combat-state reset) — because saves serialise dead slots
// too and a pre-V41 replay must land on the same bytes. From V41 every death gets
// the full cleanup whatever its cause. Nothing here draws from `world.rngState`;
// the only ID-counter advance (the V37 corpse drop) is kill-only and unchanged.
//
// V41 is NOT a pure-bookkeeping bump: clearing the live carrier's `carryingBroodId`
// (step 1) re-routes a bereaved nurse at step 16, because ant-motion.ts picks its flow
// field off that field and the carrier otherwise only drops a dead brood at step 16c.
// The V41 note in types.ts ranks that and the four quieter effects.
//
// Placement: this is a src/sim/ root module, not a src/sim/ant/ sub-module, for the
// same reason combat.ts is — it is a cross-cutting write path, not a per-tick ant
// behavior. The #212 ant layering (AGENTS.md) governs behavior sub-modules, which may
// depend only on Layer 0 (ant-motion/ant-store) and are consumed through the
// ant-system.ts barrel. `despawnAnt` depends on NO Layer-0 module and on six root ones
// (telemetry, food-system, pheromone/*, ai-state, constants, types); its production
// callers are combat.ts and colony/{colony,lifecycle}-system.ts, none of which imports
// the ant barrel. Moving it under ant/ would pull telemetry/ai-state/food-system into
// the ant subsystem and make the colony subsystem import the ant public surface to
// kill an ant. It also has no intra-ant imports, so check-ant-cycles.ts (which guards
// the ant/ graph) has nothing to say about it either way.
//
// MUST NOT import Phaser, DOM, or any non-sim module.

import { AntTask, PheromoneType } from './enums.js';
import {
  SIM_VERSION_V34_IDLE_RESERVE_FLEE,
  SIM_VERSION_V37_CORPSE_FOOD,
  SIM_VERSION_V41_DEATH_CHOKEPOINT,
} from './types.js';
import type { WorldState, KillerKind, QueenDeathContext } from './types.js';
import type { ColonyId } from './colony/colony-store.js';
import { FP_SHIFT } from './fixed.js';
import { emitEvent } from './telemetry.js';
import { spawnCorpseFood, corpseYield, type CorpseKind } from './food-system.js';
import { pheromoneGridKey } from './pheromone/pheromone-store.js';
import { depositDangerCross } from './pheromone/danger.js';
import { KILL_ALARM_DANGER_DEPOSIT } from './constants.js';
import { isInCohort } from './ai-state.js';

/**
 * How an ant died. `kill` carries the attacker, which the combat_kill event, the
 * S2 operation counters, killCount, the V34 kill alarm and the V37 corpse drop all
 * read; `starvation` and `lifespan` have no killer and surface as KillerKind
 * 'Environment' in a queen-death context (→ cause 'Starvation').
 */
export type AntDeath =
  | {
      readonly cause: 'kill';
      readonly killerKind: Exclude<KillerKind, 'Environment'>;
      /** Colony that made the kill — null for spider kills. */
      readonly killerColonyId: ColonyId | null;
      /** Entity slot of the killing ant — null for spider kills. */
      readonly killerId: number | null;
    }
  | { readonly cause: 'starvation' }
  | { readonly cause: 'lifespan' };

/**
 * Despawn ant `antIndex` (cause per `death`). Side effects, in this order
 * (`[kill]` = kill-only, `[V41+]` = also applied to non-kill deaths from V41; before V41 a non-kill death
 * performs only steps 5a and 2 (larva/worker), exactly as its old inline site did):
 *
 *   1. bidirectional carry-pointer clear (#107)                              [V41+]
 *   2. victim colony `broodFieldDirty` (#235)                    [V41+ for a queen]
 *   3. combat_kill event (S1)                                                [kill]
 *   4. pendingQueenDeathContexts[victim colony] if the victim is a queen — read
 *      and cleared by checkQueenDeath later the same tick to fill the queen_death
 *      cause ('Environment' infers 'Starvation')                            [V41+]
 *   5. alive = 0 (5a); attackCooldown = 0, combatOpponentId = -1 (5b)   [5b: V41+]
 *   6. S2 AI operation death counters                                       [V41+]
 *   7. killer colony killCount                                              [kill]
 *   8. V34 cross-colony kill alarm (DangerTrail cross at the death tile)    [kill]
 *   9. V37 corpse food at the death tile                                    [kill]
 */
export function despawnAnt(world: WorldState, antIndex: number, death: AntDeath): void {
  const ants = world.ants;
  const victimColonyId = ants.colonyId[antIndex]!;
  const victimColony = world.colonies[victimColonyId];
  const isQueenVictim = victimColony !== undefined && antIndex === victimColony.queenEntityId;

  if (death.cause !== 'kill' && world.simVersion < SIM_VERSION_V41_DEATH_CHOKEPOINT) {
    // Pre-V41 non-kill death: the old inline sites, verbatim. tickFoodConsumption's
    // larva branch and the lifespan check flagged broodFieldDirty; its queen branch
    // did not. Saves serialise dead slots, so nothing else may change here.
    //
    // The old sites flagged the ColonyRecord they were iterating; this resolves it
    // from `ants.colonyId[antIndex]` instead. Same record for every ant a colony
    // bucket contains (initAnt is the only writer of colonyId, and it writes the
    // owning colony), so the two agree — but an ant whose colonyId names a colony
    // absent from `world.colonies` would skip the flag here where the old code set
    // it. No production path constructs that; bare test worlds can.
    ants.alive[antIndex] = 0;
    if (victimColony !== undefined && !isQueenVictim) victimColony.broodFieldDirty = true;
    return;
  }

  // 1. Carry pointers — both ends, atomically (#107): a carried brood is orphaned, a
  // carrier's slot is freed. The second write lands on a LIVE ant and is the one
  // behavioural change V41 makes — see effect 1 in the V41 note (types.ts).
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

  const tileX = ants.posX[antIndex]! >> FP_SHIFT;
  const tileY = ants.posY[antIndex]! >> FP_SHIFT;
  const currentGridColonyId = ants.currentGridColonyId[antIndex]!;
  const killerKind: KillerKind = death.cause === 'kill' ? death.killerKind : 'Environment';
  const killerColonyId = death.cause === 'kill' ? death.killerColonyId : null;
  const killerId = death.cause === 'kill' ? death.killerId : null;

  // 2. #235 — a death may remove a reclaimable brood seed (brood killed) OR orphan a
  // carried brood (a carrier died — carry pointers cleared just above), both of
  // which change the pickup/deposit field seed set. Over-triggering on worker/
  // fighter deaths is deliberate (correct + simple; deaths are rare vs the
  // every-tick recompute this gate replaces).
  if (victimColony !== undefined) victimColony.broodFieldDirty = true;

  // 3. combat_kill is only emitted for Ant/Spider kills; Environment deaths emit
  // no event.
  if (death.cause === 'kill') {
    emitEvent(world, {
      tick: world.tick,
      type: 'combat_kill',
      payload: {
        killer: { kind: death.killerKind, id: death.killerId, colonyId: death.killerColonyId },
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

  // 4. Queen death context, whatever the cause, so checkQueenDeath can fill in the
  // queen_death cause (inferCause: Spider → SpiderRampage, Ant+colony →
  // InvasionKill, Environment → Starvation — the same answer it gives a missing
  // context, so a starving queen reports exactly as she did before V41).
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

  // 5. The death itself; reset combat state so a replacement ant winds up fresh.
  ants.alive[antIndex] = 0;
  ants.attackCooldown[antIndex] = 0;
  ants.combatOpponentId[antIndex] = -1;

  // 6. S2 — increment operation death counters if an active operation is running.
  // From V41 a non-kill death reaches this too: a committed-cohort fighter that
  // starved or aged out is a lost attacker like any other. From V51 (#290 PR 4)
  // workers and fighters eat and can starve, so this counts them; no adult ages
  // out (WORKER_LIFESPAN_TICKS is INT32_MAX).
  // QC Pass 4 AR-P1-001: precise predicates using committed-cohort lookup.
  // CLNY-08: no direct PLAYER_COLONY_ID / ENEMY_COLONY_ID equality branching.
  // Instead, iterate world.aiState to find any active operation that involves this death.
  for (let _ai = 0; _ai < world.aiState.length; _ai++) {
    const enemyAI = world.aiState[_ai]!;
    if (enemyAI.operationKind === 'None') continue;
    const aiColId = enemyAI.colonyId;
    // operationAttackerDeaths: victim is a committed-cohort AI fighter (any cause).
    if (
      victimColonyId === aiColId &&
      isInCohort(antIndex, enemyAI.operationFighterIds, enemyAI.operationFighterCount)
    ) {
      enemyAI.operationAttackerDeaths += 1;
    }
    // operationDefenderDeaths: victim is a non-AI ant (defender) killed by a committed-cohort AI fighter.
    if (
      victimColonyId !== aiColId &&
      killerKind === 'Ant' &&
      killerColonyId === aiColId &&
      killerId !== null &&
      isInCohort(killerId, enemyAI.operationFighterIds, enemyAI.operationFighterCount)
    ) {
      enemyAI.operationDefenderDeaths += 1;
    }
  }

  // 7. Killer colony kill tally (CMBT-06/07).
  if (killerColonyId !== null && killerColonyId !== 0) {
    const killerColony = world.colonies[killerColonyId];
    if (killerColony !== undefined) {
      killerColony.killCount += 1;
    }
  }

  // 8. #209 PR A (V34) — cross-colony kill alarm. When an ENEMY ant kills one of a
  // colony's SURFACE adult non-fighter workers, seed a DangerTrail cross on the
  // VICTIM colony's surface grid at the death tile so nearby reserve/forager
  // workers flee an active raid (same signal the spider emits). Precise
  // predicate: `killerColonyId !== null` guards the nullable killer id (a null
  // killer would otherwise satisfy `!== victimColonyId`); queens, brood
  // (excluded by workers[] membership), fighter victims (task === Fighting), and
  // same-colony kills do NOT alarm. Grid-guarded: skip if the victim colony's
  // surface DangerTrail grid is absent (bare/test worlds).
  if (
    world.simVersion >= SIM_VERSION_V34_IDLE_RESERVE_FLEE &&
    killerKind === 'Ant' &&
    killerColonyId !== null &&
    killerColonyId !== victimColonyId &&
    ants.zone[antIndex] === 0 && // Zone.Surface
    !isQueenVictim &&
    ants.task[antIndex] !== AntTask.Fighting &&
    victimColony !== undefined &&
    victimColony.workers.includes(antIndex)
  ) {
    const dangerKey = pheromoneGridKey(victimColonyId, PheromoneType.DangerTrail, 'surface');
    const dangerGrid = world.pheromoneGrids[dangerKey];
    if (dangerGrid !== undefined) {
      depositDangerCross(
        dangerGrid,
        tileX,
        tileY,
        KILL_ALARM_DANGER_DEPOSIT,
        KILL_ALARM_DANGER_DEPOSIT >> 1,
      );
    }
  }

  // 9. A2 (V37) — battlefield scavenging: an ant killed by an ENEMY ANT on the
  // SURFACE drops forageable corpse food at its (stationary) death tile. Predicate
  // mirrors the V34 kill-alarm's `killerColonyId !== null` and adds `killerId !==
  // null` so a synthetic `killAnt(world, v, cid, null, 'Ant')` (a colony but no real
  // killer entity) drops nothing; production ant kills always pass both non-null
  // (`killAnt(world, antB, cidA, antA, 'Ant')`). Spider kills (killerKind 'Spider',
  // null killer), starvation/lifespan deaths and underground deaths never drop —
  // widening to every corpse is #290's call, and is now a one-predicate change
  // here. Classify the victim explicitly — queen → fighter → worker → else no drop
  // (brood / unknown roles yield nothing). Gated `simVersion >= V37` so pre-V37
  // replays byte-identically (no ID-counter advance, no food-pile mutation). The
  // victim is dead + stationary, so its tile is unambiguous.
  if (
    world.simVersion >= SIM_VERSION_V37_CORPSE_FOOD &&
    killerKind === 'Ant' &&
    killerColonyId !== null &&
    killerColonyId !== victimColonyId && // enemy kill only (matches the V34 alarm predicate above)
    killerId !== null &&
    ants.zone[antIndex] === 0 // Zone.Surface
  ) {
    let corpseKind: CorpseKind | null = null;
    if (isQueenVictim) {
      // Forward-compat only: queen death ends the match today, so this morsel is
      // never retrievable — deterministic but inert. Kept for the multi-queen future.
      corpseKind = 'queen';
    } else if (ants.task[antIndex] === AntTask.Fighting) {
      corpseKind = 'fighter';
    } else if (victimColony !== undefined && victimColony.workers.includes(antIndex)) {
      corpseKind = 'worker';
    }
    if (corpseKind !== null) {
      spawnCorpseFood(world, tileX, tileY, corpseYield(corpseKind));
    }
  }
}

/**
 * A kill by an ant or the spider — `despawnAnt(world, victim, { cause: 'kill', … })`
 * in the historical combat.ts argument order, so the combat call sites and their
 * tests read unchanged. killerColonyId / killerId are null for spider kills (and
 * for a synthetic ant kill with no real attacker — see the V37 corpse predicate).
 */
export function killAnt(
  world: WorldState,
  antIndex: number,
  killerColonyId: ColonyId | null,
  killerId: number | null,
  killerKind: Exclude<KillerKind, 'Environment'>,
): void {
  despawnAnt(world, antIndex, { cause: 'kill', killerKind, killerColonyId, killerId });
}
