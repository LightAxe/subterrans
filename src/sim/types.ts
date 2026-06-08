// src/sim/types.ts
// WorldState snapshot interface, factory, copy, and entity ID allocator.
// PRD §1/§3 authoritative shape.
// Phase 5 scope: four fields (tick, rngState, nextEntityId, commandQueue).
// Phase 6 adds ants (AntComponents), colonies (Record<ColonyId, ColonyRecord>),
// pheromoneGrids (Record<string, PheromoneGrid>).
// Phase 7 adds terrain (surface, undergroundGrids), foodPiles, pendingChambers.
import type { SimCommand } from './commands.js';
import type { AntComponents } from './ant/ant-store.js';
import { createAntComponents } from './ant/ant-store.js';
import type { ColonyId, ColonyRecord } from './colony/colony-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { PheromoneGrid } from './pheromone/pheromone-store.js';
import { createPheromoneGrid } from './pheromone/pheromone-store.js';
import type { SurfaceGrid, UndergroundGrid } from './terrain.js';
import { createSurfaceGrid, createUndergroundGrid } from './terrain.js';
import type { DepletionRecord, FoodPile } from './food.js';
import type { PendingChamber } from './colony/chamber.js';
import { MAX_ENTITIES, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';
// PR 4 — runtime import for the procedural terrain bake. surface-features.ts
// back-imports WorldState as a TYPE only, so there is no runtime import cycle.
import { bakeSurfaceEffectGrid } from './surface-features.js';

export type EntityId = number; // incrementing counter from 0, no recycling per PRD §1/§3

/**
 * Sim-behavior version. Independent of SAVE_FORMAT_VERSION (which gates the
 * on-disk envelope shape). simVersion gates determinism-affecting algorithm
 * changes that DON'T change the snapshot shape — old saves still load fine,
 * but replay using the algorithm they were recorded under.
 *
 * v2 (LEGACY_SIM_VERSION) — issue #15 baseline. withdrawFood drains
 * FoodStorage chambers in colony.chambers array order; no carrier
 * WaitingToDeposit state. 4-connected ant movement (cardinal-only steps).
 *
 * v3 — issue #27 fix. withdrawFood drains the fullest FoodStorage chamber
 * first (array-index tie-break); carriers enter WaitingToDeposit when
 * storage is fully saturated. Movement remains 4-connected.
 *
 * v4 — issue #34 follow-up. 8-connected ant movement:
 * pickStep can return diagonal cardinals when both axes have remaining
 * work, with corner-cut prevention requiring at least one of the two
 * intermediate cardinal tiles to be passable. Underground flow-field
 * consumers also peek at the next tile's direction and combine into a
 * diagonal step when the next-tile flow is perpendicular. Diagonal moves
 * traverse √2× cardinal Manhattan distance per tick — standard 8-connected
 * speed semantics.
 *
 * v5 — issue #38. PlaceChamber accepts anchors on
 * Solid or Marked tiles in addition to Open. The handler auto-marks any
 * Solid tile in the chamber footprint and runs a reachability BFS from
 * the colony's entrances through Open + Marked + BeingDug + the new
 * footprint; placements that wouldn't be reachable after all current
 * digs complete are rejected. Pre-v5 saves keep the strict-Open anchor
 * + Solid-4-neighbor-required gates so SCEN-06 replays of recorded
 * commands stay byte-identical.
 *
 * Saves missing the `simVersion` field load with LEGACY_SIM_VERSION (sticky).
 * New worlds (createWorldState) start at LATEST_SIM_VERSION. Sticky on load
 * preserves SCEN-06 replay determinism — a save recorded before a given
 * fix keeps producing identical ticks across reload under the old algorithm.
 */
import type { SimEvent } from './telemetry.js';

/** S1 — Who killed an ant. 'Environment' reserved for future hazards (S5+). */
export type KillerKind = 'Ant' | 'Spider' | 'Environment';

/** S1 — Context written by killAnt when a queen dies; read+cleared by checkQueenDeath same tick. */
export interface QueenDeathContext {
  tile: { x: number; y: number };
  currentGridColonyId: ColonyId;
  killerColonyId: ColonyId | null;
  killerId: number | null;
  killerKind: KillerKind;
}

export const LEGACY_SIM_VERSION = 2 as const;
export const SIM_VERSION_V3 = 3 as const;
export const SIM_VERSION_V4_DIAGONAL_MOTION = 4 as const;
export const SIM_VERSION_V5_CHAMBER_ON_MARKED = 5 as const;
export const SIM_VERSION_V6_FORAGER_NO_REVISIT = 6 as const;
/**
 * v7 — issue #44 steps 4 + 5. Surface movement integration: HardBlock
 * features (boulders, twig-as-log, dead-leaf canopies, big-leaf "ships")
 * block surface ants and a deterministic local detour picks the best
 * walkable adjacent tile when the preferred step is blocked; SoftCost
 * features (bushes, grass clumps) halve effective speed (`speed >> 1`,
 * min 1) for the tick the ant occupies a SoftCost tile — integer-only,
 * no float math, no new RNG pulls. Pre-v7 saves replay with no surface
 * passability and no soft cost — same coordinate-only motion they
 * recorded — so SCEN-06 byte-identity holds.
 *
 * Originally landed as v6 on the #44 branch; renumbered to v7 during
 * the rebase onto main once #42 (PR #47) had already taken v6.
 */
export const SIM_VERSION_V7_SURFACE_PASSABILITY = 7 as const;
/**
 * v8 — issue #44 UAT round 3. Three converging
 * fixes for stuck/eddied surface foragers, all gated together:
 *
 *   (a) Leash-boundary hysteresis. The SearchingFood→ReturningToNest
 *       demotion still fires at `dist > SEARCH_LEASH_RADII[wave]`
 *       (unchanged), but the inverse ReturningToNest→SearchingFood
 *       breakout now also requires `dist <= radius -
 *       LEASH_HYSTERESIS_TILES` before any AMBIENT food signal can
 *       pull the ant back out. Player-marked priority piles bypass
 *       the deadband. Pre-v8 the symmetric signal-only breakout
 *       produced per-tick flip-flops at the radius boundary that wiped
 *       the issue-#42 recent-tiles ring buffer.
 *
 *   (b) Detour recent-tile fallback. `pickSurfaceDetour` now falls
 *       back to the best RECENT tile when every walkable neighbour
 *       has been recently visited, instead of returning (0, 0) and
 *       deadlocking the ant. The fallback step pushes a new ring-
 *       buffer entry, eventually rotating the original blocker out.
 *       Pre-v8 the picker hard-rejected recent tiles, stranding ants
 *       in one-way pockets around HardBlock features.
 *
 *   (c) Surface-feature shadow correctness. `isAnchorSuppressedByOverlap`
 *       now also rejects suppressors that themselves sit inside an
 *       entrance/food gameplay-suppression zone — pre-v8 a higher-
 *       priority anchor that would never render still cast an empty
 *       halo around the suppression zone, hiding lower-priority
 *       anchors that should have surfaced.
 *
 * Pre-v8 saves replay all three behaviours unchanged for SCEN-06
 * byte-identity.
 */
export const SIM_VERSION_V8_LEASH_HYSTERESIS = 8 as const;
export const SIM_VERSION_V9_CANCEL_DROPS_PENDING = 9 as const;
export const SIM_VERSION_V10_VISIBLE_BROOD_CARRY = 10 as const;
/**
 * v11 — defensive bundle from the codebase review pass (issues #57, #58, #63).
 * Three simultaneous sim fixes, gated together so pre-v11 saves replay byte-
 * identically with the bugged behaviour:
 *
 *   #57 — `tickPheromoneDeposit` now requires `ants.zone[id] === Zone.Surface`
 *         before depositing on the surface FoodTrail grid. Pre-v11 underground
 *         carriers wrote phantom trails on the surface using their underground
 *         tile coordinates (corrupting surface forager behaviour).
 *
 *   #58 — `detectAndResolveCombat` now receives the same `Rng` instance that
 *         `tickAntMovement` mutates. Pre-v11 combat read stale tick-start
 *         rngState and its writeback was overwritten by the end-of-tick
 *         rng_tick.getState() write, so combat's RNG advance was effectively
 *         dead code.
 *
 *   #63 — Surface ants targeting an entrance now consume the entrance flow-
 *         field on the surface side too. Pre-v11 they used straight-line
 *         pickCardinalStep steering and could permanently stall in HardBlock
 *         pockets formed by surface-feature clusters.
 */
export const SIM_VERSION_V11_DEFENSIVE_BUNDLE = 11 as const;
/**
 * v12 — sim correctness bundle (issues #62, #68). Two simultaneous fixes
 * gated together so pre-v12 saves replay byte-identically with the bugged
 * behaviour:
 *
 *   #62 — `updateFightAntTargets` now picks the nearest OPEN entrance for
 *         underground fighters (with a closed-entrance fallback so fighters
 *         stack near a soon-to-open shaft). Pre-v12 always targeted
 *         `entrances[0]` regardless of `isOpen`, so a fighter routed to a
 *         closed entrance walked to the surface column and stopped
 *         permanently — the zone-transition only promotes when the entrance
 *         is open.
 *
 *   #68 — `antDepositFood` chamber path now falls through to the entrance
 *         pool with any leftover food before entering wait-state. Pre-v12
 *         a partial chamber deposit left the ant carrying the remainder
 *         silently — no Idle flip (gated on `remaining === 0`), no wait
 *         state (only fired in the no-chamber branch), 1-tick stale-routing
 *         window. New flow: deposit chamber slice → deposit pool slice →
 *         transition Idle if all delivered, else wait-state.
 */
export const SIM_VERSION_V12_SIM_CORRECTNESS_BUNDLE = 12 as const;
/**
 * v13 — invariant fixes (issues #106, #107, #108). Three independent
 * state-invariant violations gated together so pre-v13 saves replay
 * byte-identically with the bugged behavior:
 *
 *   #106 — Underground→Surface ascent now reads `currentGridColonyId`
 *          instead of `colonyId` for the entrance lookup. Pre-v13, an
 *          invading Fighter at tileY=0 inside an enemy grid would warp
 *          home through any of the player's own-colony entrances that
 *          happened to share its underground tileX, bypassing the enemy
 *          ascent path. Post-v13 the ascent honors the grid the ant is
 *          actually in, AND restores the "Surface ⇒ currentGridColonyId
 *          === colonyId" invariant by snapping the grid id back on
 *          successful ascent.
 *
 *   #107 — `killAnt` now atomically clears bidirectional carry pointers
 *          (`carryingBroodId[killed]` and `carriedBy[their_carrier]`)
 *          before zeroing alive. Pre-v13, a nurse killed mid-Feeding
 *          left the brood orphaned with stale `carriedBy` pointing at
 *          a dead ant; if the nurse died on a Marked or Solid tile,
 *          the brood was unreclaimable until that tile became Open
 *          (chamber-flow.ts pickup-field seeds Open/BeingDug only).
 *
 *   #108 — `resolveSameColonyOccupancy` now zero-masks the gridColonyId
 *          portion of the per-tile key when zone === Surface, mirroring
 *          combat's tile-key encoding. Pre-v13, two same-colony surface
 *          ants with diverging `currentGridColonyId` (the post-#106
 *          ascent bug, or any future divergence path) produced different
 *          keys and stacked silently on the same tile.
 */
export const SIM_VERSION_V13_INVARIANT_FIXES = 13 as const;
/**
 * v14 — S0a bug-fix bundle (issues #119, #120). Two simultaneous sim fixes
 * gated together so pre-v14 saves replay byte-identically with the original
 * behaviour:
 *
 *   #119 — Pheromone trail tuning. `PHEROMONE_DECAY_FP` drops 5→2 (trails
 *          persist ~2.5× longer). `FOOD_TRAIL_DEPOSIT` doubles 512→1024 (each
 *          carrier step lays a stronger trail). Together they fix the
 *          "pheromone highways disappear seconds after foragers reach food"
 *          symptom. `PHEROMONE_VISUAL_MAX` drops 2048→512 (renderer-only,
 *          not gated — always at the new value).
 *
 *   #120 — Underground CarryingFood forager oscillation / FoodStorage
 *          chamber pile-up. Extends the surface SearchingFood recent-tiles
 *          ring buffer guard (introduced in v6) to underground
 *          Foraging+CarryingFood ants. When a proposed step lands on a tile
 *          in the ant's ring buffer, the picker scans 4-connected cardinal
 *          alternates for a non-recent passable tile; if none exists, the
 *          ant pauses for one tick. The ring buffer is pushed on every
 *          actual tile crossing (not on pause ticks) and cleared on full
 *          deposit (same as the surface path).
 */
export const SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX = 14 as const;
/**
 * V15 (S0b) — adds WorldState.events (SimEvent[]) + overflow counters for the
 * playtrace telemetry pipeline. Sticky-on-load: pre-V15 saves replay with
 * events=[] and counters=0, which is correct (no events to re-emit from a
 * pre-telemetry save).
 */
export const SIM_VERSION_V15_TELEMETRY = 15 as const;
/**
 * V16 (S1) — Combat math: HP/damage/cooldown replaces coin-flip resolver.
 * QueenDeathContext written by killAnt so checkQueenDeath can emit cause.
 */
export const SIM_VERSION_V16_COMBAT_HPDPS = 16 as const;
/**
 * V17 — Combat aggro: fighter sight-aggression (proximity scan) + immediate
 * fighter strikes on new pair (attackCooldown=1 vs COMBAT_COOLDOWN_TICKS).
 */
export const SIM_VERSION_V17_COMBAT_AGGRO = 17 as const;
/**
 * V18 — Wall-aware greedy step for underground invader fighters.
 * pickInvaderUndergroundStep replaces the raw-direction path that froze
 * fighters against Solid walls in enemy grids. Pre-V18 saves replay with
 * the old direct-hostile-position rawDx/rawDy path (byte-stable).
 */
export const SIM_VERSION_V18_INVADER_WALL_AWARE_STEP = 18 as const;
/**
 * V19 (S2) — AI state machine: adds WorldState.aiState (AIStateRecord[]) with
 * full operation-cohort tracking; advanceAIState/setAIRallyOperation/endAIRallyOperation
 * narrow sim helpers; probe/invasion mechanics; queen_death.aiStateAtTime populated.
 */
export const SIM_VERSION_V19_AI_STATE = 19 as const;
/**
 * V20 (S3) — Spider: neutral predator entity with hunger state machine.
 * Adds world.spider (SpiderState | null), world.spiderPriorityColonyId, world.scatterReticleTile.
 */
export const SIM_VERSION_V20_SPIDER = 20 as const;
/**
 * V21 (S4) — Reproduction lever: surplus-scaled egg interval, nurse Attending
 * substate with maturation acceleration, nursery throughput cap.
 * No new WorldState fields; all state derived from existing food/colony/nurse data.
 */
export const SIM_VERSION_V21_REPRODUCTION = 21 as const;
/**
 * V22 (S5) — Difficulty tier system. Adds WorldState.difficulty ('Easy' | 'Normal' | 'Hard').
 * Wires difficulty into four AI constants previously hardcoded to Normal-tier index.
 * Applies a per-difficulty brood modifier to AI colony egg interval (below the V21 150-tick
 * surplus floor, hard-clamped at MIN_EGG_INTERVAL_TICKS=100).
 * Adds Timeout and Stalemate tiebreak conditions (checkTiebreaks in game-over.ts).
 * Pre-V22 saves load with difficulty='Normal'; all V22-gated paths fall back to Normal-tier
 * behaviour for byte-identical replay of pre-V22 recordings.
 */
export const SIM_VERSION_V22_DIFFICULTY = 22 as const;
/**
 * V23 (S3 follow-up) — Spider surface-aggro loop (#146, #147).
 * - Spider gains an opportunistic Chasing state: while Patrolling it darts at the nearest
 *   live surface ant within SPIDER_CHASE_TRIGGER_RADIUS, engaging via the normal combat
 *   resolver, then returns to Patrolling on catch/escape/leash-timeout.
 * - Fighter ants autonomously target the spider when it is the nearest hostile within
 *   FIGHT_AGGRO_RADIUS (folded into the existing proximity-aggression scan).
 * - resolveSpiderCombatOnTile now runs in all surface states (not only Striking/Rampaging)
 *   so fighters can damage a Patrolling/Hunting/Chasing spider.
 * Adds SpiderState.chaseTargetAntId and SpiderState.chaseStartTick.
 * Pre-V23 saves load with chaseTargetAntId=-1, chaseStartTick=0 and replay with none of the
 * above behaviour (all three paths gate on simVersion >= V23) for byte-identical replay.
 */
export const SIM_VERSION_V23_SPIDER_AGGRO = 23 as const;
/**
 * V24 (#173) — Capacity-aware Nursery brood deposit. Previously the nearest-seed
 * `nurseDeposit` flow field routed every carrier to the Nursery nearest the Queen,
 * and `depositCarriedBrood` stacked brood in that one chamber (`broodId % openCount`)
 * with no occupancy check — so the nearest Nursery overflowed (multiple brood per
 * tile) while additional Nurseries stayed empty.
 * Under V24+: a Nursery at capacity (alive brood inside its footprint >= its Open
 * tile count, i.e. 1 brood/tile) stops advertising in `nurseDeposit` (computed via
 * computeNurseryDepositField every tick, mirroring the live pickup field), so carriers
 * physically walk to the next non-full Nursery. If ALL Nurseries are full, all are
 * seeded as a fallback so carriers are never stranded. Within the reached chamber,
 * deposit now prefers the first unoccupied Open tile (row-major) before falling back
 * to the legacy `broodId % openCount` slot.
 * No new WorldState fields. Pre-V24 saves keep the nearest-seed routing and modulo
 * deposit (gated on simVersion >= V24) for byte-identical replay.
 */
export const SIM_VERSION_V24_NURSERY_CAPACITY = 24 as const;
/**
 * V25 (#174) — Foreign-colony recall keys on the rally point alone, not the
 * fight ratio. Previously a Fighting invader inside an enemy grid was treated as
 * "recalled" whenever EITHER `targetRatio.fight === 0` OR `rallyPoint == null`.
 * So a player who set a rally on the enemy entrance (an explicit "invade here"
 * command) but left the fight ratio at 0 (don't produce MORE fighters) saw the
 * `fight === 0` disjunct fire: invaders navigated to the entrance and ascended
 * the moment they hit tileY=0, then re-descended next tick — a descend/ascend
 * oscillation that never let fighters commit inside the enemy colony.
 * Under V25+: an invader is recalled only when its colony's `rallyPoint == null`
 * (the rally was actually cleared). With a rally still set, `fight === 0` no
 * longer pulls fighters out — existing fighters hold the invasion while no new
 * ones are produced. Both gated predicates move together: the underground
 * recall-navigation step (route to exit) and the ascent `skipAscent` clear.
 * Pre-V25 saves keep the `fight === 0 || rallyPoint == null` predicate (gated on
 * simVersion >= V25) for byte-identical replay.
 */
export const SIM_VERSION_V25_RALLY_RECALL = 25 as const;
/**
 * V26 (#181) — Spider keeps a SPIDER_EDGE_MARGIN_TILES margin from every map edge
 * in all surface states. Previously the V23 chase/combat (and meander/rampage)
 * movement clamped the spider only to the grid bounds [0, max], so chasing an ant
 * into a corner pinned the spider against the boundary and its 3-tile (48px)
 * centered sprite rendered partly off the playfield (#176 had added inward
 * reflection for the feed-retreat endpoint, but the chase path had no equivalent
 * clamp). Under V26+ a single post-movement clamp tightens every surface state's
 * position to [margin, max-margin] on both axes, so the full sprite always stays
 * on-screen. Pre-V26 saves keep the to-the-edge movement (gated on simVersion >=
 * V26) for byte-identical replay.
 */
export const SIM_VERSION_V26_SPIDER_EDGE_MARGIN = 26 as const;
/**
 * V27 (#126) — Forager storage backpressure. The issue-#42 fix-#2 demotion
 * already sends surface SearchingFood ants to Idle when the colony has nowhere
 * to deposit (entrance pool at capacity AND no FoodStorage chamber depositable),
 * but the step-10a idle-reassignment re-promoted them to Foraging the very next
 * tick because it keyed only on `computedAllocation.forage`. Waves of would-be
 * carriers therefore churned Idle→Foraging→demote→Idle and piled up by the
 * hundreds at the entrance shaft with nowhere to unload.
 * Under V27+, step 10a additionally suppresses idle→FORAGING promotion (zeroes
 * the LOCAL `needForage`, never the persisted `computedAllocation`) for any
 * colony where `colonyForageBackpressure` holds. Only forage promotion is
 * suppressed: an idle ant that would have foraged still fills any remaining
 * dig/fight/nurse demand (the eligibles carve is a sequential need chain), and
 * only stays Idle when forage was the sole unmet demand. Forage promotion
 * resumes automatically once a chamber becomes depositable or the queen drains
 * the pool.
 * Backpressure (promotion suppression + the #42 demotion) is SCOPED to colonies
 * that own a FoodStorage chamber — the "hundreds of ants" pile-up only forms in
 * a mature, fully-saturated colony. A chamberless early-game colony keeps
 * foraging into its entrance pool; only its CARRIERS park, via the universal
 * #27 wait-wake gate (`colonyHasNoDepositTarget`), which keeps the pool topped
 * off at cap. Pre-V27 saves keep the churn AND the chamberless-inclusive
 * demotion (gated on simVersion >= V27) for byte-identical replay.
 */
export const SIM_VERSION_V27_FORAGE_BACKPRESSURE = 27 as const;
// PR 4 — static surface terrain: the baked movement-effect grid is a new stored
// WorldState field and the dynamic feature-suppression behaviour is removed, so
// the field semantics change. Posture 2 (bump + raise MIN_ACCEPTED, no
// cross-version gate); pre-V28 saves reject at load.
export const SIM_VERSION_V28_STATIC_TERRAIN = 28 as const;
export const LATEST_SIM_VERSION = SIM_VERSION_V28_STATIC_TERRAIN;

/**
 * S2 — AI colony state machine states.
 */
export type AIState = 'Peacetime' | 'WarFooting' | 'Probing' | 'Invading' | 'Recovery';

/**
 * S2 — Per-AI-colony state record. Lives in WorldState.aiState[].
 * Indexed by array position (iterate to find by colonyId — not dense by colonyId).
 */
/** S3 — Spider behavior states. */
export type SpiderBehaviorState =
  | 'Patrolling'
  | 'Hunting'
  | 'Chasing'
  | 'Striking'
  | 'Feeding'
  | 'Rampaging'
  | 'Retreating';

/** S3 — Single neutral spider entity. Lives in WorldState.spider (null if not in scenario). */
export interface SpiderState {
  state: SpiderBehaviorState;
  posX: number; // fixed-point (FP_SHIFT=8)
  posY: number;
  lairTileX: number; // integer tile coords
  lairTileY: number;
  territoryRadiusTiles: number;
  hp: number;
  attackCooldown: number;
  hungerTicks: number; // accrues only while state !== 'Feeding'
  nextHuntTick: number;
  huntStartTick: number;
  strikeStartTick: number;
  feedingStartTick: number;
  retreatStartTick: number;
  rampageStartTick: number; // tick at which current Rampaging episode began
  huntTargetTileX: number;
  huntTargetTileY: number;
  killsThisStrike: number;
  rampageKillsThisRampage: number;
  rampageTargetColonyId: number; // colony targeted for current rampage; -1 when not rampaging
  chaseTargetAntId: number; // V23: ant id being chased; -1 when not Chasing
  chaseStartTick: number; // V23: tick the current chase began (leash-timeout reference)
  killedThisTick: number; // V23: 0/1 flag set by combat (step 17), consumed by tickSpider (17.5); never persists as 1
  lastKillTileX: number; // V23: tile of the most recent kill (= spider tile); -1 default
  lastKillTileY: number;
  feedAwayTileX: number; // V23: ~10-tile feed destination after a kill; -1 default
  feedAwayTileY: number;
  feedArrivedTick: number; // V23: tick the spider reached feedAwayTile (heal-window clock); -1 while traveling
}

export interface AIStateRecord {
  colonyId: ColonyId;
  state: AIState;
  enteredTick: number; // tick at which the current state was entered
  probeCount: number; // probes fired since last Peacetime
  lastProbeEndTick: number; // for spacing between probes
  invasionStartTick: number; // 0 if not Invading
  invasionRallyTileX: number; // -1 if no active rally; integer tile coords
  invasionRallyTileY: number;
  recoveryEndTick: number; // 0 if not in Recovery

  // Committed-force operation tracking (CF-P0-005)
  operationKind: 'None' | 'Probe' | 'Invasion';
  operationStartTick: number;
  operationTargetTileX: number;
  operationTargetTileY: number;
  operationFighterIds: Int32Array; // committed cohort, fixed-length buffer (AI_MAX_OPERATION_FIGHTERS=32), padded with -1
  operationFighterCount: number; // active length of operationFighterIds
  operationStartFighterCount: number;
  operationAttackerDeaths: number;
  operationDefenderDeaths: number;
}

export interface WorldState {
  tick: number; // 0 at creation; incremented once per tick
  rngState: number; // Mulberry32 state (uint32); initialized from seed
  nextEntityId: EntityId; // starts at 0 (PRD §3); allocateEntityId returns current and post-increments
  commandQueue: SimCommand[]; // staging seam — drained by platform accumulator between ticks

  /**
   * Sim behavior version — gates determinism-affecting algorithm changes that
   * post-date issue #27 (carrier-oscillation fix). Sticky on load: a save
   * recorded at version N replays at version N regardless of the current
   * latest. New worlds use the latest version (LATEST_SIM_VERSION).
   *
   * Versions:
   *   2 = pre-fix array-order withdrawFood drain (issue #15 baseline);
   *       legacy greedy major-axis cardinal step movement.
   *   3 = drain-fullest-first withdrawFood + carrier WaitingToDeposit state;
   *       still legacy greedy 4-connected cardinal movement.
   *   4 = 8-connected diagonal ant movement (issue #34) + scurry-stop-scurry
   *       SearchingFood pause cadence (issue #35). The pause block consumes
   *       additional RNG pulls per tick, so v3 saves stay on the no-pause
   *       path forever to keep replay byte-identical.
   *   5 = PlaceChamber accepts Solid/Marked anchors with reachability check
   *       and auto-marks Solid footprint tiles (issue #38). Pre-v5 saves keep
   *       the strict-Open-anchor + Solid-4-neighbor gates so any v5-only
   *       commands that may sit in their inputLog stay rejected on replay.
   *   6 = Three early-game-pool fixes (issue #42): partial-deposit wait gate
   *       sets waitingDeposit=1 on leftover food; SearchingFood foragers
   *       demote to Idle when colony has nowhere to deposit; surface
   *       SearchingFood foragers refuse to step onto a tile from their
   *       last 4 moves (eddy escape). Pre-v6 saves keep the legacy paths.
   *   7 = Surface movement integration (issue #44 steps 4 + 5):
   *       (a) HardBlock features (boulders, twig-as-log, dead leaves, big
   *           leaves) block surface ants; deterministic local detour picks
   *           an alternate adjacent tile when the preferred step is blocked.
   *       (b) SoftCost features (bushes, grass clumps) halve the effective
   *           speed of any surface ant occupying a SoftCost tile.
   *       Pre-v7 saves replay with no surface passability and no soft cost
   *       — same coordinate-only motion they recorded.
   *   8 = Issue #44 UAT round 3 — three converging surface-forager
   *       fixes:
   *       (a) Leash-boundary hysteresis. The RTN→SF breakout in
   *           tickExcursionBoundary requires `dist <= radius -
   *           LEASH_HYSTERESIS_TILES` for AMBIENT signals (priority
   *           piles bypass).
   *       (b) Detour recent-tile fallback. pickSurfaceDetour falls
   *           back to the best recent tile when every walkable
   *           neighbour is recent — kills permanent deadlocks in
   *           one-way pockets around HardBlock features.
   *       (c) Surface-feature shadow correctness. Suppressors inside
   *           a gameplay-suppression zone no longer cast an empty
   *           halo over lower-priority anchors outside the zone.
   *       Pre-v8 saves keep the original behaviours for byte-identity.
   *   9 = Issue #54 — CancelDigMark on a tile inside a pending chamber's
   *       footprint drops the pending chamber entry (and reverts any
   *       remaining Marked footprint tiles to Solid). Pre-v9, the
   *       pending chamber stayed orphaned forever — for unique chamber
   *       types like Queen, both gates that scan `world.pendingChambers`
   *       (the underground context-menu Queen filter in
   *       `context-menu-layout.ts:hasPendingChamber` and the
   *       PlaceChamber Queen-uniqueness rule in `tick.ts`) stayed
   *       tripped, soft-locking re-placement. Pre-v9 saves replay
   *       byte-identical with the orphan-on-cancel behaviour.
   *  10 = Issue #17 Phase 1 — visible brood carry. Nurses pathfind to
   *       a brood entity (egg or larva) inside a Queen chamber, pick
   *       it up (sets `carryingBroodId` on the nurse and `carriedBy`
   *       on the brood), walk it to a Nursery Open tile, and deposit.
   *       Pre-v10 the `Feeding` substate ran the instant teleport in
   *       `transportBroodToNursery`. Pre-v10 saves replay byte-
   *       identically with the teleport behaviour. With no Nursery,
   *       no carry happens and brood sits where laid (matches pre-v10
   *       teleport-gate behaviour).
   *
   *  22 = S5 difficulty tier system. Adds `difficulty` field. Wires difficulty
   *       into AI constants (tierIndex vs NORMAL_TIER_INDEX), applies a brood-
   *       production modifier to AI colony egg intervals, and enables Timeout
   *       and Stalemate tiebreak conditions. Pre-V22 saves load with
   *       difficulty='Normal' and replay byte-identically.
   *
   * Round-trips through copyWorldState and save/load.
   */
  simVersion: number;

  /** S5 (V22) — player-selected difficulty. Wired into AI tier arrays and AI brood
   *  modifier. Pre-V22 saves load as 'Normal'. Round-trips through copyWorldState
   *  and save/load. */
  difficulty: 'Easy' | 'Normal' | 'Hard';

  /**
   * Issue #44 — terrain decoration seed. Independent of `rngState` so that
   * decoration layout stays stable across the lifetime of a world: rngState
   * advances every tick as the sim consumes random pulls, and a layout that
   * drifted with it would shift mid-game.
   *
   * Folded into the surface feature selector's spatial hash
   * (`src/sim/surface-features.ts`) so different game seeds produce
   * different boulder/grass layouts. Pre-#44 placement was coordinate-only
   * — every world looked identical from above.
   *
   * Initialized in `createWorldState(seed)` via a fixed mixer of the input
   * seed (so it's a deterministic function of the seed but doesn't equal
   * `rngState`). Round-trips through `copyWorldState` and save/load. Legacy
   * saves missing the field load with `terrainSeed = 0`; this changes their
   * decoration layout on first reload but not their world geometry.
   */
  terrainSeed: number;

  // Phase 6 additions (PRD §3):
  ants: AntComponents; // SoA ant component storage — 17 parallel Int32Arrays
  colonies: Record<ColonyId, ColonyRecord>; // per-colony state keyed by integer ColonyId
  pheromoneGrids: Record<string, PheromoneGrid>; // pheromone intensity grids keyed by pheromoneGridKey()

  // Phase 7 additions (PRD §2e):
  surface: SurfaceGrid; // shared surface terrain (SURF-01)

  /**
   * PR 4 (static terrain) — frozen per-tile surface movement-effect grid
   * (`SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT` bytes; values 0=Cosmetic,
   * 1=SoftCost, 2=HardBlock). Baked once at world-gen from the procedural
   * feature field + deterministic root-clearance/corridor carves; the SOURCE OF
   * TRUTH for `surfaceMovementAt`. Immutable after bake — pile/entrance events
   * never rewrite it (that was the #127/#128 static-terrain bug). Serialized
   * packed+base64 (save.ts). Bare `createWorldState` worlds get the raw
   * procedural bake (no carves).
   */
  bakedSurfaceEffect: Uint8Array;

  /**
   * PR 4 — DERIVED (not serialized): memoised 0/1 membership mask of the single
   * connected walkable surface component, lazily computed from
   * `bakedSurfaceEffect` via `ensureSurfaceComponentMask`. Null until first use;
   * terrain is immutable so it never needs invalidation. `copyWorldState`
   * recomputes lazily (set to null) rather than threading it.
   */
  surfaceComponentMask: Uint8Array | null;

  undergroundGrids: Record<ColonyId, UndergroundGrid>; // per-colony underground (UNDR-08)
  foodPiles: FoodPile[]; // surface food sources (SURF-02 + issue #112 depletion/respawn)

  /**
   * Issue #112 — Bounded record of recently-depleted food-pile tiles, used by
   * `tickFoodPileSpawn` as an anti-teleport guard. Each entry is `{ tick, tileX,
   * tileY }`. Capped at FOOD_PILE_SOFT_CEILING via append-time `shift()` so
   * autosave snapshots stay bounded between spawn passes; spawn-time prune
   * additionally drops entries older than FOOD_PILE_RECENT_DEPLETION_TICKS.
   */
  recentlyDepletedFood: DepletionRecord[];

  pendingChambers: Record<string, PendingChamber>; // keyed by `${colonyId}:${anchorTileX}:${anchorTileY}` (PRD §2d)

  // S0b — playtrace telemetry (ADR-0013 v2 / D-31 / D-34).
  // events: accumulated this session; NOT serialized to saves (transient —
  // reset to [] on load; deterministic replay re-generates from inputLog).
  // Counters ARE persisted so a resumed-from-save upload produces a truthful
  // eventOverflow block reflecting drops that happened before the save.
  events: SimEvent[];
  droppedCombatKillCount: number;
  droppedStructuralCount: number;

  /**
   * S1 — transient per-colony queen-kill context. Written by combat.killAnt when
   * a queen dies; read and cleared by checkQueenDeath later the same tick.
   * Index by victim colonyId. Empty array between ticks.
   */
  pendingQueenDeathContexts: (QueenDeathContext | null)[];

  /**
   * S2 — per-AI-colony state machine record. One entry per non-player colony.
   * Indexed by array position (iterate to find by colonyId — NOT dense by colonyId
   * since colonyId values may not be contiguous starting from 0).
   * Persisted in saves (V17+); pre-V17 saves get defensive defaults on load.
   */
  aiState: AIStateRecord[];

  /**
   * S3 — Single neutral spider entity; null if not present in this scenario.
   * V20+ only; pre-V20 saves load with spider: null.
   */
  spider: SpiderState | null;

  /**
   * S3 — Player-set flag: fighters route toward spider when true.
   * Cleared automatically when spider dies.
   */
  spiderPriorityColonyId: number | null;

  /**
   * S3 — Shadow field for one-tick-lag scatter. Written at end of tickSpider
   * (step 17.5); read by step 13e movement the following tick.
   * null when spider is not Hunting or Striking.
   */
  scatterReticleTile: { x: number; y: number } | null;
}

/**
 * Create a fresh WorldState with zero-initialised Phase 6 stores.
 *
 * @param seed        - Mulberry32 seed (uint32 coerced via >>> 0).
 * @param maxEntities - Ant entity slot count. Defaults to MAX_ENTITIES (8192).
 */
export function createWorldState(seed: number, maxEntities: number = MAX_ENTITIES): WorldState {
  const seedU32 = seed >>> 0;
  const world: WorldState = {
    tick: 0,
    rngState: seedU32,
    nextEntityId: 0, // PRD §3 line 130: starts at 0, no recycling
    commandQueue: [],
    simVersion: LATEST_SIM_VERSION,
    difficulty: 'Normal',
    // Issue #44 — derive terrainSeed from the input seed via Knuth's golden-
    // ratio multiplier so it's a deterministic function of the seed but
    // doesn't equal rngState. Using rngState directly would couple the very-
    // first decoration query to wherever the PRNG happens to land on tick 0.
    terrainSeed: Math.imul(seedU32, 2654435761) >>> 0,
    ants: createAntComponents(maxEntities),
    colonies: {},
    pheromoneGrids: {},
    // Phase 7 defaults:
    surface: createSurfaceGrid(SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT),
    // PR 4 — placeholder; overwritten with the procedural bake below (needs the
    // constructed world for terrainSeed + the procedural selector).
    bakedSurfaceEffect: new Uint8Array(SURFACE_GRID_WIDTH * SURFACE_GRID_HEIGHT),
    surfaceComponentMask: null,
    undergroundGrids: {},
    foodPiles: [],
    recentlyDepletedFood: [], // issue #112 — empty until first depletion
    pendingChambers: {}, // empty Record; PlaceChamberCommand creates entries
    // S0b — telemetry fields.
    events: [],
    droppedCombatKillCount: 0,
    droppedStructuralCount: 0,
    // S1 — transient; cleared between ticks by combat resolver.
    pendingQueenDeathContexts: [],
    // S2 — AI state machine. Populated by createScenario for non-player colonies.
    aiState: [],
    // S3 — spider entity.
    spider: null,
    spiderPriorityColonyId: null,
    scatterReticleTile: null,
  };
  // PR 4 — bake the raw procedural movement-effect field now that the world
  // (terrainSeed) exists. Bare worlds (no colonies) get no carves; createScenario
  // re-bakes with root reservation + corridor connectivity once colonies exist.
  world.bakedSurfaceEffect = bakeSurfaceEffectGrid(world);
  return world;
}

/**
 * Copy src into dst in place — double-buffer swap for render interpolation (PRD §1/§3).
 *
 * Steady-state: zero allocations after colonies and grids populated.
 * Allocation occurs only when the set of colony keys or grid keys grows.
 *
 * Ordered operations per PRD §3 line 566:
 *   1. Scalar fields (tick, rngState, nextEntityId)
 *   2. commandQueue — slice() (only allocation in the command path per PRD §3)
 *   3. AntComponents — 11 TypedArray.set calls (zero allocation)
 *   4. colonies — delete stale dst keys; upsert each src colony field-by-field
 *   5. pheromoneGrids — delete stale dst keys; upsert each src grid via Int32Array.set
 */
export function copyWorldState(src: WorldState, dst: WorldState): void {
  // --- Phase 5 scalar fields ---
  dst.tick = src.tick;
  dst.rngState = src.rngState;
  dst.nextEntityId = src.nextEntityId;
  dst.simVersion = src.simVersion;
  dst.difficulty = src.difficulty;
  dst.terrainSeed = src.terrainSeed;
  dst.commandQueue = src.commandQueue.slice(); // small in practice (user-input rate) — PRD §3 accepts this as the only Phase 1 allocation
  // events: intentionally not copied into the render double-buffer (prevState).
  // prevState.events is never read for interpolation; the only consumers of
  // events (buildPaytraceSummary, buildPayloadWithDowngrade) read the live
  // world directly. Skipping the copy avoids a per-tick O(n) allocation that
  // could grow to ~2,000 entries.
  // droppedCombatKillCount / droppedStructuralCount are also telemetry-only.
  dst.droppedCombatKillCount = src.droppedCombatKillCount;
  dst.droppedStructuralCount = src.droppedStructuralCount;
  // pendingQueenDeathContexts: transient within-tick (cleared by checkQueenDeath every tick,
  // always null at the tick boundary when copyWorldState runs). No render code reads it,
  // so no copy is needed and the allocation is skipped to preserve zero-alloc steady state.

  // S2 — aiState: deep-copy the array and each record's Int32Array buffer.
  // Length-adjust: grow or shrink dst.aiState to match src.aiState.
  while (dst.aiState.length > src.aiState.length) dst.aiState.pop();
  for (let i = 0; i < src.aiState.length; i++) {
    const s = src.aiState[i]!;
    if (i < dst.aiState.length) {
      // Reuse existing record — copy scalars, then copy Int32Array buffer.
      const d = dst.aiState[i]!;
      d.colonyId = s.colonyId;
      d.state = s.state;
      d.enteredTick = s.enteredTick;
      d.probeCount = s.probeCount;
      d.lastProbeEndTick = s.lastProbeEndTick;
      d.invasionStartTick = s.invasionStartTick;
      d.invasionRallyTileX = s.invasionRallyTileX;
      d.invasionRallyTileY = s.invasionRallyTileY;
      d.recoveryEndTick = s.recoveryEndTick;
      d.operationKind = s.operationKind;
      d.operationStartTick = s.operationStartTick;
      d.operationTargetTileX = s.operationTargetTileX;
      d.operationTargetTileY = s.operationTargetTileY;
      d.operationFighterIds.set(s.operationFighterIds);
      d.operationFighterCount = s.operationFighterCount;
      d.operationStartFighterCount = s.operationStartFighterCount;
      d.operationAttackerDeaths = s.operationAttackerDeaths;
      d.operationDefenderDeaths = s.operationDefenderDeaths;
    } else {
      // Grow: push a new deep copy.
      dst.aiState.push({
        colonyId: s.colonyId,
        state: s.state,
        enteredTick: s.enteredTick,
        probeCount: s.probeCount,
        lastProbeEndTick: s.lastProbeEndTick,
        invasionStartTick: s.invasionStartTick,
        invasionRallyTileX: s.invasionRallyTileX,
        invasionRallyTileY: s.invasionRallyTileY,
        recoveryEndTick: s.recoveryEndTick,
        operationKind: s.operationKind,
        operationStartTick: s.operationStartTick,
        operationTargetTileX: s.operationTargetTileX,
        operationTargetTileY: s.operationTargetTileY,
        operationFighterIds: Int32Array.from(s.operationFighterIds),
        operationFighterCount: s.operationFighterCount,
        operationStartFighterCount: s.operationStartFighterCount,
        operationAttackerDeaths: s.operationAttackerDeaths,
        operationDefenderDeaths: s.operationDefenderDeaths,
      });
    }
  }

  // S3 — spider: copy or null
  if (src.spider === null) {
    dst.spider = null;
  } else if (dst.spider === null) {
    dst.spider = { ...src.spider };
  } else {
    // Reuse existing object — copy all fields
    const ss = src.spider;
    const ds = dst.spider;
    ds.state = ss.state;
    ds.posX = ss.posX;
    ds.posY = ss.posY;
    ds.lairTileX = ss.lairTileX;
    ds.lairTileY = ss.lairTileY;
    ds.territoryRadiusTiles = ss.territoryRadiusTiles;
    ds.hp = ss.hp;
    ds.attackCooldown = ss.attackCooldown;
    ds.hungerTicks = ss.hungerTicks;
    ds.nextHuntTick = ss.nextHuntTick;
    ds.huntStartTick = ss.huntStartTick;
    ds.strikeStartTick = ss.strikeStartTick;
    ds.feedingStartTick = ss.feedingStartTick;
    ds.retreatStartTick = ss.retreatStartTick;
    ds.rampageStartTick = ss.rampageStartTick;
    ds.huntTargetTileX = ss.huntTargetTileX;
    ds.huntTargetTileY = ss.huntTargetTileY;
    ds.killsThisStrike = ss.killsThisStrike;
    ds.rampageKillsThisRampage = ss.rampageKillsThisRampage;
    ds.rampageTargetColonyId = ss.rampageTargetColonyId;
    ds.chaseTargetAntId = ss.chaseTargetAntId;
    ds.chaseStartTick = ss.chaseStartTick;
    ds.killedThisTick = ss.killedThisTick;
    ds.lastKillTileX = ss.lastKillTileX;
    ds.lastKillTileY = ss.lastKillTileY;
    ds.feedAwayTileX = ss.feedAwayTileX;
    ds.feedAwayTileY = ss.feedAwayTileY;
    ds.feedArrivedTick = ss.feedArrivedTick;
  }
  dst.spiderPriorityColonyId = src.spiderPriorityColonyId;
  // scatterReticleTile
  if (src.scatterReticleTile === null) {
    dst.scatterReticleTile = null;
  } else if (dst.scatterReticleTile === null) {
    dst.scatterReticleTile = { x: src.scatterReticleTile.x, y: src.scatterReticleTile.y };
  } else {
    dst.scatterReticleTile.x = src.scatterReticleTile.x;
    dst.scatterReticleTile.y = src.scatterReticleTile.y;
  }

  // --- AntComponents: 19 TypedArray.set calls (zero allocation) ---
  dst.ants.posX.set(src.ants.posX);
  dst.ants.posY.set(src.ants.posY);
  dst.ants.colonyId.set(src.ants.colonyId);
  dst.ants.task.set(src.ants.task);
  dst.ants.subTask.set(src.ants.subTask);
  dst.ants.speed.set(src.ants.speed);
  dst.ants.foodCarrying.set(src.ants.foodCarrying);
  dst.ants.starvationTimer.set(src.ants.starvationTimer);
  dst.ants.age.set(src.ants.age);
  dst.ants.alive.set(src.ants.alive);
  dst.ants.lifespan.set(src.ants.lifespan);
  // Phase 7 ant fields:
  dst.ants.zone.set(src.ants.zone);
  dst.ants.digTileX.set(src.ants.digTileX);
  dst.ants.digTileY.set(src.ants.digTileY);
  dst.ants.digTicksRemaining.set(src.ants.digTicksRemaining);
  dst.ants.targetPosX.set(src.ants.targetPosX);
  dst.ants.targetPosY.set(src.ants.targetPosY);
  // Phase 9 / 09 digger-reassignment memo — per-ant SearchingFood leash wave.
  dst.ants.searchWave.set(src.ants.searchWave);
  // Phase 9 / 09 excursion-foraging memo — correlated outward walk heading.
  dst.ants.searchHeadingX.set(src.ants.searchHeadingX);
  dst.ants.searchHeadingY.set(src.ants.searchHeadingY);
  dst.ants.searchHeadingTicks.set(src.ants.searchHeadingTicks);
  // Phase 9 / 09 excursion-foraging follow-up — per-ant anti-backtrack prev
  // tile. Live state read by sampleForagingDirection + hasNearbyPheromoneSignal,
  // so the render snapshot MUST round-trip it (previously dropped → the
  // interpolated prev frame looked "fresh" every tick and broke anti-backtrack
  // diagnostics / replay determinism boundary).
  dst.ants.searchPrevTileX.set(src.ants.searchPrevTileX);
  dst.ants.searchPrevTileY.set(src.ants.searchPrevTileY);
  // Phase 09.1 Chunk 0 — grid-of-occupancy byte. MUST round-trip through the
  // double-buffer so every prev-frame grid lookup sees the same value as the
  // current frame. See 09.1-00-PLAN.md Task 2.
  dst.ants.currentGridColonyId.set(src.ants.currentGridColonyId);
  // Issue #27 — carrier wait flag. Round-trips so render's interpolated frame
  // sees the same wait state as the current frame, and so SCEN-06 replay
  // determinism is preserved across save/reload boundaries.
  dst.ants.waitingDeposit.set(src.ants.waitingDeposit);
  // Issue #34 — Bresenham accumulator and #35 — pause counter. Both round-
  // trip for SCEN-06 replay determinism (same seed + commands → same
  // step pattern + pause schedule).
  dst.ants.pathErr.set(src.ants.pathErr);
  dst.ants.searchPauseTicks.set(src.ants.searchPauseTicks);
  // Issue #42 — recent-tiles ring buffer. The buffer is read by the v6
  // forager step-picker, so it must round-trip for replay determinism.
  dst.ants.recentTilesX.set(src.ants.recentTilesX);
  dst.ants.recentTilesY.set(src.ants.recentTilesY);
  dst.ants.recentTilesHead.set(src.ants.recentTilesHead);
  // Issue #17 Phase 1 — brood carry slot + reverse pointer. Both round-trip
  // because the v10 nurse state machine reads them every tick.
  dst.ants.carryingBroodId.set(src.ants.carryingBroodId);
  dst.ants.carriedBy.set(src.ants.carriedBy);
  // S1 — combat HP/damage/cooldown fields. Must round-trip: the V16 resolver
  // reads these every combat tick; the render interpolation reads them for
  // fighter-size visual. Not copying would cause one-frame stale combat state.
  dst.ants.hp.set(src.ants.hp);
  dst.ants.homeGroundBonusHp.set(src.ants.homeGroundBonusHp);
  dst.ants.attackCooldown.set(src.ants.attackCooldown);
  dst.ants.combatOpponentId.set(src.ants.combatOpponentId);

  // --- colonies: delete stale dst keys; upsert each src colony ---
  // Remove dst colonies that no longer exist in src
  for (const key in dst.colonies) {
    if (!(key in src.colonies)) {
      delete dst.colonies[key as unknown as ColonyId];
    }
  }

  for (const key in src.colonies) {
    const colonyId = key as unknown as ColonyId;
    const s = src.colonies[colonyId]!;

    // Create dst colony if absent (allocates once per colony, zero in steady state)
    if (!(colonyId in dst.colonies)) {
      dst.colonies[colonyId] = createColonyRecord(s.colonyId, s.queenEntityId);
      // Phase 3 PRD §2a caller-side extension defaults (factory does not set these):
      const fresh = dst.colonies[colonyId];
      fresh.entrances = [];
      fresh.rallyPoint = null;
      fresh.digFlowFieldDirty = false;
      fresh.foodFlowFieldDirty = false;
      fresh.killCount = 0;
      fresh.priorityFoodPileId = null;
    }
    const d = dst.colonies[colonyId]!;

    // Scalar fields — direct assignment
    d.colonyId = s.colonyId;
    d.queenEntityId = s.queenEntityId;
    d.queenStarvationTimer = s.queenStarvationTimer;
    d.foodStored = s.foodStored;
    d.workerCount = s.workerCount;
    d.eggCount = s.eggCount;
    d.larvaeCount = s.larvaeCount;
    d.nurseCount = s.nurseCount;
    d.defeated = s.defeated;
    d.reconcileCountdown = s.reconcileCountdown;
    d.killCount = s.killCount;
    d.priorityFoodPileId = s.priorityFoodPileId;
    d.queenLastEggTick = s.queenLastEggTick;
    d.eggIntervalNumerator = s.eggIntervalNumerator;

    // Bucket arrays — reuse via length truncation + index copy (no new array)
    d.eggs.length = s.eggs.length;
    for (let i = 0; i < s.eggs.length; i++) {
      d.eggs[i] = s.eggs[i]!;
    }

    d.larvae.length = s.larvae.length;
    for (let i = 0; i < s.larvae.length; i++) {
      d.larvae[i] = s.larvae[i]!;
    }

    d.workers.length = s.workers.length;
    for (let i = 0; i < s.workers.length; i++) {
      d.workers[i] = s.workers[i]!;
    }

    // chambers — nested ChamberRecord objects: pop/push(Object.assign) for reuse
    while (d.chambers.length > s.chambers.length) {
      d.chambers.pop();
    }
    for (let i = 0; i < s.chambers.length; i++) {
      if (i < d.chambers.length) {
        // Reuse existing object — Object.assign preserves object identity for test assertions
        Object.assign(d.chambers[i]!, s.chambers[i]!);
      } else {
        // Grow: push a fresh copy of the source chamber
        d.chambers.push(Object.assign({}, s.chambers[i]!));
      }
    }

    // Nested plain-object fields — field-by-field copy (NOT spread — preserves object identity)
    // Phase 10 (CTRL-01'): targetRatio is two-field {forage, fight}. WorkerAllocation
    // (computedAllocation, taskCensus) keeps its `dig` slot per D-03 — auto-dig writes it.
    d.targetRatio.forage = s.targetRatio.forage;
    d.targetRatio.fight = s.targetRatio.fight;

    d.computedAllocation.nurse = s.computedAllocation.nurse;
    d.computedAllocation.forage = s.computedAllocation.forage;
    d.computedAllocation.dig = s.computedAllocation.dig;
    d.computedAllocation.fight = s.computedAllocation.fight;

    d.taskCensus.nurse = s.taskCensus.nurse;
    d.taskCensus.forage = s.taskCensus.forage;
    d.taskCensus.dig = s.taskCensus.dig;
    d.taskCensus.fight = s.taskCensus.fight;

    // Phase 3 extension fields — typed copies (no `as any` — fields are required on interface)

    // entrances — reuse dst array, truncate/extend, field-by-field copy each NestEntrance
    while (d.entrances.length > s.entrances.length) d.entrances.pop();
    for (let i = 0; i < s.entrances.length; i++) {
      if (i < d.entrances.length) {
        Object.assign(d.entrances[i]!, s.entrances[i]!);
      } else {
        d.entrances.push(Object.assign({}, s.entrances[i]!));
      }
    }

    // rallyPoint — null-aware copy (avoid object churn when both sides are already null or both are objects)
    if (s.rallyPoint === null) {
      d.rallyPoint = null;
    } else if (d.rallyPoint === null) {
      d.rallyPoint = { tileX: s.rallyPoint.tileX, tileY: s.rallyPoint.tileY };
    } else {
      d.rallyPoint.tileX = s.rallyPoint.tileX;
      d.rallyPoint.tileY = s.rallyPoint.tileY;
    }

    // digFlowFieldDirty — boolean assignment
    d.digFlowFieldDirty = s.digFlowFieldDirty;
    // foodFlowFieldDirty (issue #15) — boolean assignment
    d.foodFlowFieldDirty = s.foodFlowFieldDirty;
  }

  // --- pheromoneGrids: delete stale dst keys; upsert each src grid ---
  for (const key in dst.pheromoneGrids) {
    if (!(key in src.pheromoneGrids)) {
      delete dst.pheromoneGrids[key];
    }
  }

  for (const key in src.pheromoneGrids) {
    const srcGrid = src.pheromoneGrids[key]!;

    // Create dst grid if absent (allocates once per grid, zero in steady state)
    if (!(key in dst.pheromoneGrids)) {
      dst.pheromoneGrids[key] = createPheromoneGrid(srcGrid.width, srcGrid.height);
    }
    const dstGrid = dst.pheromoneGrids[key]!;

    // Int32Array.set — zero allocation
    dstGrid.data.set(srcGrid.data);
  }

  // --- Phase 7: surface grid ---
  // Uint8Array.set — zero allocation; dimensions are fixed at world creation
  dst.surface.data.set(src.surface.data);

  // --- PR 4: baked static terrain (Uint8Array.set, fixed dims) + derived mask.
  // The component mask is derived + immutable; share the src reference (read-only)
  // so the double-buffered dst sees the same memoised mask without recompute.
  if (dst.bakedSurfaceEffect.length !== src.bakedSurfaceEffect.length) {
    dst.bakedSurfaceEffect = new Uint8Array(src.bakedSurfaceEffect.length);
  }
  dst.bakedSurfaceEffect.set(src.bakedSurfaceEffect);
  dst.surfaceComponentMask = src.surfaceComponentMask;

  // --- Phase 7: undergroundGrids — same delete-stale + upsert pattern as pheromoneGrids ---
  for (const key in dst.undergroundGrids) {
    if (!(key in src.undergroundGrids)) {
      delete dst.undergroundGrids[key as unknown as ColonyId];
    }
  }
  for (const key in src.undergroundGrids) {
    const colonyId = key as unknown as ColonyId;
    const srcGrid = src.undergroundGrids[colonyId]!;
    if (!(colonyId in dst.undergroundGrids)) {
      dst.undergroundGrids[colonyId] = createUndergroundGrid(srcGrid.width, srcGrid.height);
    }
    dst.undergroundGrids[colonyId]!.data.set(srcGrid.data);
  }

  // --- Phase 7: foodPiles — length-adjust + field-by-field copy (reuse objects in steady state) ---
  // Issue #112: Object.assign copies the new pickupsRemaining/pickupsInitial fields automatically.
  while (dst.foodPiles.length > src.foodPiles.length) dst.foodPiles.pop();
  for (let i = 0; i < src.foodPiles.length; i++) {
    if (i < dst.foodPiles.length) {
      Object.assign(dst.foodPiles[i]!, src.foodPiles[i]!);
    } else {
      dst.foodPiles.push(Object.assign({}, src.foodPiles[i]!));
    }
  }

  // --- Issue #112: recentlyDepletedFood — length-adjust + field-by-field copy ---
  while (dst.recentlyDepletedFood.length > src.recentlyDepletedFood.length)
    dst.recentlyDepletedFood.pop();
  for (let i = 0; i < src.recentlyDepletedFood.length; i++) {
    if (i < dst.recentlyDepletedFood.length) {
      Object.assign(dst.recentlyDepletedFood[i]!, src.recentlyDepletedFood[i]!);
    } else {
      dst.recentlyDepletedFood.push(Object.assign({}, src.recentlyDepletedFood[i]!));
    }
  }

  // --- Phase 7: pendingChambers — same delete-stale + upsert pattern as pheromoneGrids ---
  for (const key in dst.pendingChambers) {
    if (!(key in src.pendingChambers)) {
      delete dst.pendingChambers[key];
    }
  }
  for (const key in src.pendingChambers) {
    if (!(key in dst.pendingChambers)) {
      dst.pendingChambers[key] = Object.assign({}, src.pendingChambers[key]!);
    } else {
      Object.assign(dst.pendingChambers[key]!, src.pendingChambers[key]!);
    }
  }
}

/**
 * Sentinel returned by `allocateEntityId` when `world.nextEntityId` has
 * reached `MAX_ENTITIES`. Callers MUST check for this value before using
 * the result as an array index — writing to `world.ants.posX[-1]` is an
 * out-of-bounds TypedArray store (silent drop on most engines, but
 * incorrect behavior in any case). See issue #59.
 */
export const INVALID_ENTITY_ID: EntityId = -1;

/**
 * Allocate a fresh entity ID. No recycling (PRD §1/§3 incrementing counter).
 *
 * Issue #59 — soft-caps at `MAX_ENTITIES`. Pre-fix code post-incremented
 * unconditionally; once `world.nextEntityId` reached 8192, callers wrote
 * to `ants.posX[8192]` etc., which is out of range on the fixed-capacity
 * TypedArrays — silent corruption / wraparound depending on engine.
 *
 * Post-fix: returns `INVALID_ENTITY_ID` (-1) when at cap WITHOUT
 * incrementing the counter. The counter freezes at MAX_ENTITIES, so
 * subsequent calls also return -1. Callers must handle -1 by skipping
 * the spawn/allocation. This produces a soft population cap rather than
 * a mid-tick crash.
 */
export function allocateEntityId(world: WorldState): EntityId {
  if (world.nextEntityId >= MAX_ENTITIES) return INVALID_ENTITY_ID;
  const id = world.nextEntityId;
  world.nextEntityId = id + 1;
  return id;
}
