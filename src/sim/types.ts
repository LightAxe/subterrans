// src/sim/types.ts
// WorldState snapshot interface, factory, copy, and entity ID allocator.
// PRD §1/§3 authoritative shape.
// Phase 5 scope: four fields (tick, rngState, nextEntityId, commandQueue).
// Phase 6 adds ants (AntComponents), colonies (Record<ColonyId, ColonyRecord>),
// pheromoneGrids (Record<string, PheromoneGrid>).
// Phase 7 adds terrain (surface, undergroundGrids), food piles, pendingChambers.
// #290 PR 2 (V50) replaces the food piles with the located food store (`food`).
import type { SimCommand } from './commands.js';
import type { AntComponents } from './ant/ant-store.js';
import { createAntComponents } from './ant/ant-store.js';
import type { ColonyId, ColonyRecord } from './colony/colony-store.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { PheromoneGrid } from './pheromone/pheromone-store.js';
import { createPheromoneGrid } from './pheromone/pheromone-store.js';
import type { SurfaceGrid, UndergroundGrid } from './terrain.js';
import { createSurfaceGrid, createUndergroundGrid } from './terrain.js';
import type { DepletionRecord } from './food.js';
import type { FoodStore } from './food/food-store.js';
import { copyFoodStore, createFoodStore } from './food/food-store.js';
import type { PendingChamber } from './colony/chamber.js';
import { RaidType } from './enums.js';
import { MAX_ENTITIES, SURFACE_GRID_WIDTH, SURFACE_GRID_HEIGHT } from './constants.js';
// PR 4 — runtime import for the procedural terrain bake. surface-features.ts
// back-imports WorldState as a TYPE only, so there is no runtime import cycle.
import { bakeSurfaceEffectGrid } from './surface-features.js';
import { invalidateWorldCaches } from './scratch.js';

export type EntityId = number; // incrementing counter from 0, no recycling per PRD §1/§3

/**
 * Sim-behavior version. Independent of SAVE_FORMAT_VERSION (which gates the
 * on-disk envelope shape).
 *
 * PRE-1.0 POLICY (2026-10-01; AGENTS.md "simVersion and saves"): a sim-behaviour
 * change adds a SIM_VERSION_V* constant, points LATEST_SIM_VERSION at it, and sets
 * MIN_ACCEPTED_SIM_VERSION (platform/save.ts) to the same value. Do NOT wrap the new
 * behaviour in a `simVersion >=` gate; older saves are rejected instead. The entries
 * below, up to V70, record the earlier gated policy: their gates let an older save
 * replay under the algorithm it was recorded with. Those gates stay until a separate
 * reaping decision; once MIN === LATEST they are production-dead.
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

/** S1 — Context written by despawnAnt (ant-death.ts) when a queen dies; read+cleared by checkQueenDeath same tick. */
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
 * Adds Timeout and Stalemate tiebreak conditions (checkTiebreaks in game-over.ts;
 * V67 removes the Timeout).
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
// PR 5 — path-aware forager routing (Fix-A: complete goal-field step replacing the
// naive cardinal step for scent + priority) and a deepened recent-tiles ring
// (C-both, with a compact canonical serialization). Steering algorithm + the
// recent-tiles buffer length both change behaviour and on-disk shape. Posture 2
// (bump + raise MIN_ACCEPTED, no cross-version gate); pre-V29 saves reject at load.
export const SIM_VERSION_V29_PATH_AWARE_ROUTING = 29 as const;
// PR 6-sim — #128 underground-embedding guards: a descent landing-tile validity
// check (an ant only lands on a tile it canEnterUndergroundTile for its task) and
// a task-aware occupancy guard on every passability-tightening underground
// mutation (CancelDigMark, chamber-cancel, dead-digger cleanup). Both change
// tick-level behaviour. Posture 2 (bump + raise MIN_ACCEPTED, no cross-version
// gate); pre-V30 saves reject at load. (PR 6-render is render-only — no bump.)
export const SIM_VERSION_V30_UNDERGROUND_EMBEDDING_GUARDS = 30 as const;
/**
 * V31 (#225) — Spider surface-terrain awareness. Previously spider movement
 * ignored passability: moveTowardTile stepped onto HardBlock features and the
 * V23 meander hash could pick a HardBlock target, parking the tile-coincident-
 * combat spider on a boulder where fighters dogpile adjacent tiles unable to
 * engage. Under V31+ (live V23 path only; frozen tickSpiderV22 untouched):
 * (a) the pursuit states (Hunting, Striking, Chasing, Rampaging) step ONE cardinal
 * tile down a BFS goal field toward the target (ensureSurfaceGoalField —
 * HardBlock-impassable, cached per world by target tile), so the spider ROUTES
 * AROUND obstacles instead of holding at a wall face; distance-to-target strictly
 * decreases each step, so it never oscillates. The Patrolling meander keeps a
 * cheaper greedy passable-step (refuse HardBlock, try the other axis, else hold)
 * toward its probed wander target. Escape hatch shared by both: a spider ALREADY on
 * an impassable tile (only a legacy/corrupt loaded position — fresh V31 lairs are
 * passability-filtered in _placeSpider), or one whose target is unreachable on the
 * frozen terrain, steps terrain-blind toward the target until it reaches passable
 * ground, so it can never be stranded;
 * (b) the meander picker keeps its two hash32 draws, then linear-probes (tile
 * index +1, wrapping at width*height) to the first passable tile — deterministic,
 * no rngState use. Feeding movement stays terrain-blind (its heal gate needs exact
 * arrival at feedAwayTile, which passability-aware stepping can't guarantee), but
 * computeFeedAwayTile probes the feed endpoint to a passable in-band tile so the
 * spider heals on open ground where an adjacent fighter can still interrupt it,
 * never inside a boulder. Pre-V31 saves keep the terrain-blind movement and the
 * un-probed feed endpoint (gated on simVersion >= V31) for byte-identical replay.
 */
export const SIM_VERSION_V31_SPIDER_TERRAIN = 31 as const;
/**
 * V32 (#226) — AI-operation validation + spider hunt-episode closure (one gate,
 * two deltas). (1) StartAIOperation is validated against the target colony's
 * current aiState.state: Probe applies only from WarFooting, Invasion only while
 * already Invading (the WarFooting→Invading transition fires in advanceAIState at
 * step 18b, before the render controller pushes the command); a malformed kind or
 * an illegal source silently drops, changing which replayed commands apply.
 * (2) A spider killed while Hunting (reachable under the V23 always-on combat gate)
 * emits the previously-missing spider_hunt_end; that emission can bump the
 * PERSISTED dropped-event counters at the event cap, so it shares the gate. Sticky
 * (simVersion >= V32): pre-V32 worlds keep the unvalidated command apply and the
 * dangling hunt episode for byte-identical replay. MIN_ACCEPTED unchanged (#228).
 */
export const SIM_VERSION_V32_AI_OP_VALIDATION = 32 as const;
/**
 * V33 (#243) — resolveSameColonyOccupancy shift-writes park the bumped ant at tile
 * CENTER (`(tile << FP_SHIFT) + (FP_ONE >> 1)`), like the other center-writing
 * position writers (the #70 class), not the tile CORNER. Both write pairs (exempt
 * shift + non-exempt claim) were corner writes, leaving a shifted ant half a tile
 * off-center. This is NOT behavior-inert: the movement integrator consumes RAW
 * fixed-point positions (`posX += dx * speed`, with `speed < FP_ONE`), so a
 * half-tile repark shifts that ant's subsequent tile-crossing timing — V33
 * trajectories genuinely diverge from V32 and cascade through pheromones / RNG draw
 * order / combat. That divergence is exactly why it is gated: pre-V33 keeps the
 * corner write (`simVersion >= V33`, the `: 0` arm bit-identical to the old write)
 * so older saves replay byte-identically. (Two zone-transition posY corner writes —
 * ascent/descent — are outside #243's scope and unchanged.) MIN_ACCEPTED unchanged.
 */
export const SIM_VERSION_V33_OCCUPANCY_CENTER = 33 as const;

/**
 * #209 PR A — surface idle reserve + pheromone-driven flee. Gates the new idle
 * worker behaviour: surface-milling idle reserve at open entrances (step 15b
 * `tickIdleReserveAndFlee`), a general flee state (`ants.fleeShelterUntilTick`)
 * that reads the spider's `DangerTrail` and dashes non-combat surface workers
 * (idle + foragers, empty or carrying) down the nearest own open entrance to
 * shelter until the danger decays, and a cross-colony ant-kill danger alarm
 * seeded on the victim colony's surface DangerTrail. Every mutation path is
 * gated `simVersion >= V34`, so pre-V34 saves replay byte-identically. The new
 * `fleeShelterUntilTick` column is optional-on-load (default -1); MIN_ACCEPTED
 * is UNCHANGED (pre-V34 in-window saves keep loading).
 */
export const SIM_VERSION_V34_IDLE_RESERVE_FLEE = 34 as const;

/**
 * #209 PR C — underground idle-reserve wander. Idle UNDERGROUND workers (which
 * PR A's surface-only milling left holding motionless) take a gentle
 * deterministic one-tile wander toward a hash-chosen enterable cardinal
 * neighbour (re-picked per retarget bucket, held when reached, confined to
 * non-shaft enterable tiles), so a food-saturated colony's surplus de-clumps
 * instead of freezing in a motionless blob. A pure movement layer — reuses
 * `targetPosX/Y` (no new save column), no allocation/backpressure change. Idle
 * ants at the shaft row ascend to the surface reserve instead of being captured
 * underground. Every mutation path is gated `simVersion >= V35`, so pre-V35
 * saves replay byte-identically. MIN_ACCEPTED unchanged.
 */
export const SIM_VERSION_V35_UNDERGROUND_IDLE_WANDER = 35 as const;

/**
 * A1 — risk-aware foraging routes. SearchingFood foragers penalize a candidate
 * step's FoodTrail score by the DangerTrail at that cell (`net = food −
 * (Math.imul(danger, DANGER_ROUTE_WEIGHT_FP) >> FP_SHIFT)`, clamped ≥ 0), and a
 * wandering forager's excursion edge-bounce softly steers away from tiles whose
 * danger is ≥ DANGER_ROUTE_AVOID_THRESHOLD. Soft bias, not a wall — lethal danger
 * stays the V34 flee (FLEE_THRESHOLD). The surface DangerTrail grid is threaded
 * into `sampleForagingDirection` and `chooseExcursionDirection` ONLY when
 * `simVersion >= V36` (undefined otherwise), so pre-V36 saves replay byte-
 * identically. The excursion-boundary leash scan `hasNearbyPheromoneSignal` stays
 * danger-blind (Option B). No new save column; MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V36_RISK_AWARE_FORAGING = 36 as const;

/**
 * A2 — battlefield scavenging / corpse food. A surface combat death drops
 * forageable "corpse food" (an ordinary `FoodPile`): an enemy-ant kill drops a
 * 1-charge worker/fighter pile (queen = 8, forward-compat/inert today), and the
 * spider's own death drops a 100-charge pile at its tile. Fixed yields, never
 * RNG-drawn — a drop advances only the entity-ID counter, which is exactly why
 * every A2 effect is gated `simVersion >= V37` (pre-V37 replays byte-identically,
 * consuming no IDs and touching no food piles). The new optional `FoodPile.isCorpse`
 * flag (present only on corpse piles at V37+) exempts corpse piles from the
 * natural-spawn soft ceiling and from the depletion "barren" cooldown, and lowers
 * the save-validator pickup floor to 1 for corpse piles only. No MIN_ACCEPTED raise
 * (no save wipe); natural piles carry no new column, so pre-V37 saves are unchanged.
 */
export const SIM_VERSION_V37_CORPSE_FOOD = 37 as const;

/**
 * #297 — homebound-forager doorstep push-through. V34's homebound surface HOLD
 * (`tickIdleReserveAndFlee`) parks a carrier in place whenever *every* open
 * entrance of its colony reads ≥ FLEE_THRESHOLD, and re-arms that hold every
 * tick for as long as that stays true. For a ONE-ENTRANCE colony — which is what
 * both scenario colonies are, and what the rule-based AI never grows out of — a
 * spider that keeps returning to the door holds the entrance DangerTrail at its
 * deposit/decay equilibrium (SPIDER_DANGER_DEPOSIT 1280 re-deposited every tick
 * against DANGER_DECAY_FP 10 settles near 32 768, 64× FLEE_THRESHOLD) for as long
 * as it stays. A single rampage is leashed by SPIDER_RAMPAGE_MAX_TICKS (1200) and
 * a camper also leaves via the chase-divert, but the hold re-arms for the whole
 * episode — and the episode is long: the longest CONTIGUOUS stretch above the
 * threshold at the AI entrance, over 10 seeds and counting only ticks while the
 * queen was ALIVE, is median 1 197.5 ticks / max 1 635 — about one rampage leash
 * plus its ~100-tick decay tail, and ~4× STARVATION_GRACE_TICKS. Across a match
 * the AI colony spent 2 300–4 100 of its first 12 000 ticks with at least one
 * homebound forager frozen, banked food on only 58–85 ticks, and lost its queen
 * on 25/30 Normal seeds.
 *
 * The predation itself is not the drain: across 8 dying seeds the colony lost only
 * 2–5 workers out of 11–21 alive in that window, but banked food on just 58–85
 * ticks. The hold is what converts a handful of kills into a total income
 * stoppage.
 *
 * V38 gives the hold the two exits it was missing:
 *
 *  1. DOORSTEP — a homebound forager within `FLEE_HOMEBOUND_PUSH_THROUGH_TILES`
 *     of one of its own OPEN and ENTERABLE entrances stops waiting for a safe
 *     door and makes the final dash through the danger (normal routing).
 *     "Enterable" excludes a door a RAMPAGING spider is blockading
 *     (`isDescentBlocked`, #165): there the ant provably cannot descend and the
 *     camper is deliberately pinned to bite it, so pushing through is pure loss
 *     and the V34 hold still applies.
 *  2. LOCAL ALL-CLEAR — the surface re-arm site now re-reads the ant's OWN tile.
 *     It previously keyed on entrance safety alone, so a carrier that armed the
 *     hold on a one-shot pulse stayed frozen in zero danger for as long as any
 *     door stayed camped, unable even to walk into the doorstep band.
 *
 * Carriers that are genuinely in danger and far from home keep the V34 hold, so
 * the Codex P2 intent behind it — "do not walk a laden ant across a raid into a
 * camped entrance" — still governs the long walk.
 *
 * Every behavioural site is gated `simVersion >= V38`, so pre-V38 saves replay
 * byte-identically. No new save column, no `WorldState` field, no PRNG draw and
 * no tick-order change. MIN_ACCEPTED is UNCHANGED (no save wipe).
 */
export const SIM_VERSION_V38_FORAGER_DOORSTEP_PUSH = 38 as const;

/**
 * Spider target-selection seat-bias fix. Every spider tie-break that previously
 * resolved on ascending colony id / ascending entity id handed the win to colony 1
 * (the starting cohort's ants hold the lower entity ids colony by colony), so in a
 * fully passive two-colony
 * game colony 1's queen died first 55.25% of the time (800 runs — 400 seeds x both
 * nest geometries, z = +2.97, p = 0.003) — a structural seat advantage, not emergent
 * play. With `world.spider = null` no queen dies at all; the map is symmetric and
 * swapping the nests' positions does not move the bias, so the channel is the id
 * ordering itself. Deterministic `hash32` keys (never a `world.rngState` draw — these
 * selectors are documented as making none) replace it:
 *
 *   1. `pickRampageTarget` (spider.ts) orders an exact score tie by a PER-COLONY key
 *      `hash32(terrainSeed ^ tick ^ SPIDER_TIEBREAK_SALT ^ colonyId)` instead of
 *      ascending colony id — so neither seat is structurally the "richer" colony the
 *      60/40 weighting then favors. The SCORE is untouched
 *      (`colony.foodStored + workerCount * 10`); because the pool pegs at
 *      BASE_FOOD_STORAGE_CAPACITY, ~36% of picks are exact ties, which is why the
 *      tiebreak mattered so much. Scoring on `colonyFoodTotal` (pool + FoodStorage
 *      chambers) was considered and DEFERRED to its own change: it is a no-op in the
 *      passive sweeps that measured this bias, and in a real game it would swamp the
 *      `workerCount * 10` term — a balance change needing an AI-economy sweep, not a
 *      tie fix.
 *   2. `findChaseTarget` / `findNearestAttackingFighter` (spider.ts) break an EQUAL
 *      Manhattan distance on the lower `hash32(terrainSeed ^ tick ^ antId)` instead
 *      of the lower ant id. Strict `<` on distance is unchanged — only exact ties move.
 *   3. `resolveSpiderCombatOnTile` (combat.ts) ranks the ants on the spider's tile by
 *      (Fighting first, then lower `hash32(terrainSeed ^ antId)`) instead of
 *      (Fighting first, then lowest tile slot), for both `activeAntIdx` and
 *      `swarmRetaliationTarget` — one substituted term, nothing else changed. The key
 *      is deliberately tick-FREE and the rule deliberately UNCONDITIONAL (not
 *      restricted to mixed-colony tiles): a spider-ant pairing
 *      (`combatOpponentId === -2` + windup) spans many ticks, so either a per-tick key
 *      or a rule that switched on the tile's colony composition would re-target
 *      mid-engagement and reset the spider's windup. As it stands the displacement
 *      rule is the same shape as pre-V39 — an arriving ant displaces the incumbent iff
 *      it ranks higher — so the expected churn is the same.
 *
 * Every mutation path is gated `simVersion >= V39`, so pre-V39 saves replay
 * byte-identically. Verified cross-build, not merely by inspection: the pre-change and
 * post-change trees were each run from `createScenario` with `world.simVersion` pinned
 * and their serialized `WorldState` hashed at 1 000-tick checkpoints (the harness used
 * for this is not committed; `scripts/analyze-snapshot.ts` performs the same
 * serialize-and-compare against a recorded snapshot). Identical at every pinned
 * version from 30 (= MIN_ACCEPTED) through 38, up to 25 seeds x 12 000 ticks each.
 * No new WorldState/save field; MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V39_SPIDER_TIEBREAK = 39 as const;

/**
 * #299 / #293 — small-colony survival. Tracing every AI-queen starvation on the
 * #297 AI-economy seeds showed the same shape: the spider camps the colony's single
 * entrance and takes one worker per rampage; the survivors are then either frozen
 * by a movement livelock or pulled off foraging. Three gated changes:
 *
 *   1. No-revisit box-in release (`pickNoRevisitSurfaceAlternate`). When every
 *      in-bounds neighbour of a surface SearchingFood forager is in its recent-tiles
 *      ring, the legacy answer is a {0,0} pause — and because the ring only advances
 *      on a real crossing, that pause was PERMANENT (foragers frozen 3 400-4 100 ticks
 *      at a map edge and in open ground). V40 clears the ring and takes the step.
 *   2. The queen is exempt from same-colony occupancy (`resolveSameColonyOccupancy`).
 *      She stands still for thousands of ticks beside the entrance until her chamber
 *      completes, so a searcher whose trail crossed her tile was bumped back onto the
 *      exempt entrance tile every tick and re-took the same step next tick — a
 *      livelock of 1 600-3 000 ticks per forager.
 *   3. No nurse carve-out below NURSE_MIN_WORKERS living workers (`computeNurseCount`,
 *      passed NURSE_MIN_WORKERS by its call sites). The ceil(workers/4) cap made the
 *      last worker of a 1-worker colony a nurse the moment brood >= NURSE_RATIO, so it nursed larvae
 *      the starving queen could not feed instead of foraging.
 *
 * None of the three adds a WorldState/save field, draws from `world.rngState`, or
 * changes tick order; all are gated `simVersion >= V40`, so pre-V40 saves replay
 * byte-identically (same-build self-compare + V40-vs-V39 liveness in
 * determinism.test.ts; both sides of each gate pinned in ant-movement.test.ts and
 * allocation-system.test.ts). MIN_ACCEPTED is UNCHANGED. (#299 was opened on a
 * brood-cap hypothesis — cap live brood by living workers — which was implemented,
 * measured neutral on both AI-economy gates while lowering peak workers, and dropped.)
 */
export const SIM_VERSION_V40_SMALL_COLONY_SURVIVAL = 40 as const;

/**
 * #289 — single ant-death chokepoint. Every production ant death now routes through
 * `despawnAnt` (ant-death.ts): combat and spider kills (formerly combat.ts
 * `killAnt`, now the `killAnt` sugar there), queen and larva starvation
 * (colony-system.ts tickFoodConsumption) and the worker lifespan check
 * (lifecycle-system.ts). The kill path is unchanged at every version. The non-kill
 * sites used to flip `alive = 0` inline with a subset of the cleanup; from V41 they
 * get the full one — bidirectional carry-pointer clear, combat-state reset,
 * `broodFieldDirty` (the starving-queen site never flagged it), and a queen-death
 * context with killerKind 'Environment', which checkQueenDeath infers as
 * 'Starvation' exactly as it did from a missing context. Two other reads in
 * game-over.ts switch branch on the context existing, and both coincide: the
 * queen_death `location` now comes from `ctx.tile` (captured at step 3) instead
 * of her posX/posY read at step 18, which agree because a dead ant never moves;
 * and the `aiStateAtTime` lookup now runs instead of being skipped, but compares
 * each `aiState[i].colonyId` against a null `killerColonyId`, so it never matches
 * and still yields null.
 *
 * What actually changes at V41, most visible first:
 *
 *   1. LIVE — a bereaved carrier drops off the `nurseDeposit` field one tick
 *      earlier. The carry-pointer clear is bidirectional (#107), so a larva dying
 *      at step 3 also clears its LIVE carrier's
 *      `carryingBroodId`. Step 16 (ant-motion.ts `v10Carrying`) picks the nurse's flow
 *      field by `subTask === Feeding && carryingBroodId !== -1`, and the carrier
 *      otherwise only drops a dead brood at step 16c, AFTER movement. So below V41 the
 *      nurse takes one more `nurseDeposit` step carrying a corpse toward the Nursery;
 *      at V41 it falls through to the `nursing` field for that tick. Both end Idle.
 *   2. INERT BUT SERIALIZED — the dead slot's own `carriedBy`, `attackCooldown`,
 *      `combatOpponentId`, and (when the dying ant was the carrier) its own
 *      `carryingBroodId`. Nothing reads a dead slot, but saves serialise dead slots,
 *      which is the whole reason the old bytes had to be preserved below the gate.
 *   2b. INERT, ON A LIVE SLOT — the mirror of 1 at the other death site. When the
 *      CARRIER dies (lifespan, step 7) the same bidirectional clear lands on the live
 *      brood's `carriedBy`. Inert because every reader treats carried-by-a-dead-ant as
 *      uncarried already (isBroodReclaimable, and the nursing/occupancy/render readers
 *      that go through it), and doubly dormant while WORKER_LIFESPAN_TICKS is
 *      INT32_MAX. Pinned on both sides of the gate in ant-death.test.ts.
 *   3. INERT — the starving queen's `broodFieldDirty`. Over-triggering that flag is
 *      output-identical by construction; chamber-flow-gating.test.ts pins
 *      gated ≡ recompute-every-tick. It is serialized, but step 9 consumes and clears
 *      it the same tick for any colony with an underground grid, so only a grid-less
 *      colony (test fixtures) could carry the extra `true` into a save.
 *   4. DORMANT — the S2 operation death counters. A committed-cohort fighter that
 *      starved or aged out now counts as an attacker loss, which no adult could do
 *      at V41 (workers did not eat; WORKER_LIFESPAN_TICKS is INT32_MAX). Live from
 *      V51 (#290 PR 4), when workers and fighters eat and can starve.
 *
 * No WorldState/save field, no `world.rngState` draw, no tick-order change; the only
 * ID-counter advance (the V37 corpse drop) stays kill-only. Same-build self-compare +
 * two V41-vs-V40 liveness proofs (1 and 2 above) in determinism.test.ts; both sides of
 * the gate pinned in
 * ant-death.test.ts. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V41_DEATH_CHOKEPOINT = 41 as const;

/**
 * C1 — colony alarm ("recall to nest"). A player-sounded, colony-wide stance:
 * while `ColonyRecord.alarmActive` is set, every surface civilian of that colony
 * behaves as if its own tile were dangerous and pours underground through the
 * V34 flee machinery, staying sheltered until the all-clear — and, like every
 * V34 shelterer, until the door it would leave through is actually safe.
 *
 * The alarm acts at THREE places, and needs all three:
 *
 *   1. RECALL (step 15b, ant/idle-reserve.ts) — one extra disjunct at four of
 *      the five DangerTrail reads: the flee trigger, the non-homebound dash
 *      abort, the underground poke-out resume, and the local-all-clear hold
 *      release. This is what pulls surface civilians in.
 *   2. NO REASSIGNMENT (step 10a, tick.ts) — step 10a reassigns none of an
 *      alarmed colony's Idle workers. (Other task writes still run — a full
 *      deposit still sets Idle, the search leash still demotes.) 10a runs five
 *      steps before 15b, and V34's check there
 *      only skipped ants ALREADY sheltering, so on the tick the alarm sounded an
 *      Idle surface worker was drafted to fight first, failed 15b's civilian
 *      filter, and was never recalled at all.
 *   3. NO ASCENT (step 16) — the only production ascent (ant/ant-movement.ts)
 *      asks holdAlarmedCivilianAtShaft (ant/idle-reserve.ts); that ascent
 *      admits an Idle worker with no target and any SearchingFood /
 *      ReturningToNest forager. Under the alarm those are an Idle worker at the
 *      shaft row (post-deposit at a chamberless shaft pool, a V35 wander clear,
 *      a matured larva or dropped carrier) and any forager that was STILL
 *      searching or returning underground when the alarm sounded — a one-shot
 *      population, since a full deposit sets Idle and (2) stops re-promotion.
 *      Each climbed out: with a safe door 15b recalled it next tick, and under a
 *      full camp it was not recalled at all. Such an adult ant is now turned
 *      into a SHELTERER at the shaft, so it leaves through 15b's danger-checked
 *      poke-out rather than on the player's all-clear alone — only where an open
 *      entrance is at its column, since the poke-out re-arms any other shelterer
 *      indefinitely, until an entrance opens there. Adults in their own colony's
 *      own grid only; fighters keep their existing rule.
 *
 * Of the five DangerTrail reads in (1), the fifth,
 * `entranceDanger` (via pickNearestSafeEntrance / setFleeTarget), deliberately
 * keeps reading REAL danger, so the alarm never TARGETS a camped door. Under a
 * full camp it therefore holds the two classes that CAN hold — idle workers
 * (target cleared) and homebound carriers (timed surface hold) — rather than
 * feeding them to the spider. A SearchingFood forager still wanders outward: it
 * keeps its own foraging dispatch by design (see the comment at that branch),
 * because freezing it would only make it stationary bait. (#322, V49: that froze
 * foragers far from home for the whole alarm; from V49 they muster home and wait
 * at the edge of the danger instead — see the V49 note.)
 *
 * Narrow claim, deliberately: it is the target that is safe, not the path. When
 * a camp exists setFleeTarget writes the safe entrance tile and movement
 * straight-lines to it, danger-blind en route, so a worker on the far side of a
 * camped door still walks over it. The alarm amplifies that pre-existing V34
 * behaviour by sending civilians the danger field would have left milling.
 *
 * What the alarm costs the player is the point of the lever: via (2) step 10a
 * reassigns none of the colony's Idle workers, so it neither promotes them into
 * foraging nor recruits them as fighters (from V65, #373, it does recruit
 * fighters — see the V65 note), and via (3) none of the colony's own
 * civilians in its own nest goes back out.
 * Safety versus income, one toggle, no per-ant control.
 *
 * New serialized field `ColonyRecord.alarmActive`, defaulting false and absent
 * from older saves (`?? false`), plus a new `SetColonyAlarm` command that tick()
 * ignores below V42. Every new read is behind `simVersion >= V42`, so a pre-V42
 * save replays byte-identically: the field cannot become true there, and no
 * branch consults it. No `world.rngState` draw (the flee path uses hash32), no
 * tick-order change, no new entity-ID advance. MIN_ACCEPTED is UNCHANGED.
 *
 * Scope note: the AI does NOT get the alarm in this pass — `runAIController`
 * never issues the command, so an AI colony's `alarmActive` stays false. Giving
 * the enemy the stance is a separate balance question.
 */
export const SIM_VERSION_V42_COLONY_ALARM = 42 as const;

/**
 * V43 (#323) — idle fighters become SENTRIES instead of bouncing at the entrance.
 *
 * Before V43 a Fighter whose colony had no rally point was routed to its
 * nearest open entrance's EXACT surface tile (`updateFightAntTargets`, step 10c).
 * Standing there, the descent block (step 16, ant-movement.ts) sent it down its
 * own shaft; underground in its own grid, `needsTransition` routed it straight
 * back up, and the ascent put it back on the entrance tile — every tick, forever.
 * A probe on main measured a zone flip on ~98% of fighter-ticks.
 *
 * From V43 a Fighter with no rally point is a SENTRY of its colony's nearest
 * OPEN entrance (unless its colony has spider priority on: step 10d is then
 * sending its fighters AT the spider, so none of the cover rules below apply).
 * On the surface a sentry, in priority order:
 *   1. TAKES COVER — heads for its entrance, and may go down its own shaft — when it
 *      sees the spider (within FIGHT_AGGRO_RADIUS = 4 of it), or when it is AT
 *      its entrance (within 4 of it: on its post, a hold tile, or nearer) while the
 *      spider is within 8 of the entrance. The entrance-relative half keeps it heading in
 *      instead of pacing between post and entrance while the spider lingers just out
 *      of sight;
 *   2. CHASES the nearest enemy ANT (worker or queen) within FIGHT_AGGRO_RADIUS of
 *      it and inside its GUARD AREA — within 8 of its entrance, what it can see from
 *      its post or a hold tile — but never the spider. The rallied fighters' sight
 *      scan, which the no-rally branch used to skip entirely. The guard area stops
 *      a passing enemy luring a sentry off, and lets recalled invaders walk home
 *      past the enemy's entrance instead of fighting on there;
 *   3. otherwise, from outside its guard area, walks to the entrance itself (the
 *      pre-V43 route home, which strands fewer fighters against multi-tile
 *      obstacles than steering straight at a post); inside it, walks to (and holds
 *      within 1 tile of) a SENTRY POST: a tile on the ring at Manhattan distance
 *      FIGHT_AGGRO_RADIUS - 1 around the entrance, so every sentry can see an enemy
 *      standing on it. Each entrance's posts are its qualifying ring tiles, listed in
 *      an order that spreads them around the ring; a sentry takes entry (rank mod
 *      count), its rank being its place in entity-id order among its colony's
 *      fighters bound for that entrance, so an entrance's first `count` sentries hold
 *      distinct posts. A fighter below ground counts at an entrance only where its exit
 *      is certain: in the top rows of that entrance's shaft (where a sheltering sentry
 *      waits), or anywhere in a nest with a single open entrance; deeper in a
 *      many-entrance nest it takes a slot once it surfaces. The ring sits inside the
 *      entrance's guaranteed-clear halo (SURFACE_ROOT_CLEARANCE_RADIUS). A ring
 *      tile qualifies if it is on the walkable surface component, no tile of its
 *      hold area is an entrance tile, and a sentry anywhere in its hold area would
 *      still be nearest THIS entrance — without that last rule, two open entrances a
 *      few tiles apart made sentries re-bind between their rings every tick. If no
 *      ring tile passes (other own entrances crowding it, as with three in adjacent
 *      columns), the last rule is dropped: the sentry walks out and usually
 *      re-binds to a neighbouring entrance. Past an entrance's post count, sentries share
 *      posts. A sentry starts holding only on the ring or outside it, never nearer
 *      the entrance; once holding (recorded as FightingSubState.Holding, so a fighter
 *      merely starting with no target doesn't count), it keeps holding within 2
 *      of its post and at most a
 *      tile inside the ring, so a holder bumped one tile by same-colony occupancy
 *      displacement (two sharing a post) stays put instead of walking back onto
 *      the taken tile every tick. And a sentry step 10c sends into cover or to
 *      its post passes through tiles its colony's ants hold in step 16's
 *      occupancy pass: sentries hold posts all round the entrance, and one bumped back
 *      off a holder's tile every tick froze on its way to a far-side post. (Walking
 *      home or chasing, it is bumped like any ant; those bumps slide it round
 *      obstacles.)
 * A sentry sheltering in its own nest stays below (the ascent is skipped) while
 * the spider is within 10 of the entrance: the cover radius 8 — 4 (watch) + 3 (post
 * ring) + 1 (hold), so no post or hold tile is in the spider's watch — plus two
 * tiles of hysteresis. The spider steps one tile a tick, so a spider pacing across
 * the cover radius can't bounce sentries down and up the shaft (with one shared
 * threshold it did, every tick). If its colony has no open entrance, a fighter
 * with no rally point still waits at the nearest closed shaft.
 *
 * And from V43 a Fighter descends its OWN open entrance only when its colony's
 * rally point is on that entrance (the Plan 09.1-03 defensive descent) or, as a
 * sentry, to take cover; and a Fighter with NO rally point never descends a
 * FOREIGN entrance — invading needs orders (a sentry that chased an enemy onto
 * its entrance, or a recalled invader surfacing at the entrance it just left, stays
 * out). A fighter crossing its own entrance on the way to a surface rally walks over
 * the shaft instead of dropping in and popping straight back out. (A rally on the
 * colony's own entrance still bounces; #325 turns it into a tunnel defence.)
 *
 * Balance note, measured: the bounce was an accidental DECOY. Bouncing idle
 * fighters kept a camping spider tied up at the AI's entrance (~27% of its time
 * within 6 tiles of it), where it wasted time on ants that kept vanishing
 * underground. With sentries the spider roams and kills more efficiently: over
 * 200 seeds of check:ai-economy the enemy queen is alive at tick 12k in 174 and
 * at 24k in 120 (main: 186 and 186). The owner chose to ship the fix and rebalance
 * deliberately in a follow-up (#327).
 *
 * No new serialized field, no command, no world.rngState draw, no entity-ID
 * advance, no tick-order change: every new read is behind `simVersion >= V43`,
 * so a pre-V43 save replays byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V43_FIGHTER_SENTRIES = 43 as const;

/**
 * V44 (#325) — a rally on the colony's OWN open entrance means "defend the nest
 * from inside".
 *
 * Before V44 fighters sent there went down the shaft (the Plan 09.1-03 defensive
 * descent) and, the next tick, underground movement routed every own-grid fighter
 * back to its entrance: they climbed straight back out, a zone flip on every
 * fighter-tick.
 *
 * From V44 a fighter whose colony's rally point is on one of its own open
 * entrances is a TUNNEL DEFENDER (unless the colony has sent its fighters at the
 * spider, which overrides it, as it does for sentries). It walks to that entrance
 * and goes down, and below, in the part of its nest that entrance's shaft
 * reaches, it stays (it neither routes to an entrance nor climbs out). A fighter
 * below in a part not joined to that shaft (a second entrance's fresh shaft, say)
 * climbs out and walks round, as before V44; without that, moving the rally from
 * such a shaft to the main one stranded the fighters below it for good. There:
 *   1. it goes after the nearest enemy ant it can reach anywhere in its colony's
 *      tunnels (no radius, as invaders hunt), stepping through them by BFS
 *      (pickInvaderUndergroundStep). "Can reach" is the part of the nest a BFS
 *      from the top of the defended shaft reaches: an invader in a shaft not yet
 *      joined to the nest doesn't pull every defender off its post to stand
 *      against rock;
 *   2. with no such invader, it holds a TUNNEL POST: the tiles that BFS reaches
 *      first, in N/E/S/W order, leaving the top ENTRANCE_SHAFT_DEPTH + 1 rows of
 *      every own entrance's shaft column clear. A defender takes post (rank mod
 *      count), its rank being its place in entity-id order among its colony's
 *      fighters outside foreign grids (on the surface too), so the posts spread
 *      one per tile along the first tunnel.
 * A defender holding its post or walking to it takes no part in the same-colony
 * occupancy pass: it neither claims a tile nor is bumped. The posts fill the
 * tunnels at the foot of the shaft, the way every worker comes and goes; holders
 * claiming their tiles bumped foragers back every tick (the V40 queen livelock),
 * trapped them below and starved the queen. A defender chasing an invader is
 * bumped like any ant.
 * Moving the rally point off the colony's own open entrances, or clearing it, makes
 * them ordinary fighters again: they climb out and go to the new rally point, or
 * take sentry posts. (Moved to another of its own open entrances, they stay
 * defenders and take posts below that one.)
 *
 * No new serialized field, no command, no world.rngState draw, no entity-ID
 * advance, no tick-order change: every new read is behind `simVersion >= V44`,
 * so a pre-V44 save replays byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V44_TUNNEL_DEFENCE = 44 as const;

/**
 * #327 — V45 workers walk through the sentry ring.
 *
 * V43 sentries hold posts on a ring round their entrance, and a holding sentry
 * claimed its tile in the same-colony occupancy pass, so any higher-id ant
 * stepping onto it was bumped back. After an invasion the AI's surviving
 * fighters (a war ratio makes most of the colony fighters, and fighters never
 * become workers again) came home and filled the ring solid; laden foragers
 * could not cross it, income stopped and the queen starved at her own door.
 * That, not the lost spider decoy, is most of the AI's post-V43 starvation.
 *
 * From V45 a sentry holding its post neither claims its tile nor is bumped, as
 * a V44 tunnel defender holding its post already did, so ants pass through the
 * ring. Because holders are no longer bumped apart, sentries sharing a post
 * would stand on one tile; so from V45 each entrance also has an OUTER ring of
 * posts at FIGHT_AGGRO_RADIUS (still in sight of the entrance tile), taken once
 * the inner ring is full. About 28 sentries get a post each; past that they
 * share one and stack on it.
 *
 * No new serialized field, no command, no world.rngState draw, no entity-ID
 * advance, no tick-order change: the one new read is behind `simVersion >= V45`,
 * so a pre-V45 save replays byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V45_SENTRY_RING_PASSABLE = 45 as const;

/**
 * #328 — V46 a sentry walking to its post keeps its entrance.
 *
 * A V43 sentry re-picked its entrance from its own tile every tick. The stable-post
 * filter only guarantees a post's HOLD AREA is bound to its own entrance, so in rare
 * layouts (about 1 in 500 random two- or three-entrance layouts) the first
 * half-tile of a step toward the post landed on a tile nearer another own entrance
 * whose post lay back the other way, and the sentry turned round every tick forever.
 *
 * From V46 a surface sentry's binding follows its POST, which does not move as it
 * steps: walking, its target (already serialized); holding, the post nearest
 * where it stands. It is bound to that post's own entrance (the one nearest the
 * post) when that entrance lists the post and the sentry is inside its guard
 * area; where entrances share a post, to the lowest-id one that lists it; with no
 * post (walking home, taking cover, chasing), to its nearest entrance as before.
 * (Binding every shared post to the lowest id settled too, but drained a crowded
 * garrison onto one entrance and stacked sentries on its posts.)
 *
 * No new serialized field, no command, no world.rngState draw, no entity-ID
 * advance, no tick-order change: the one new read is behind `simVersion >= V46`,
 * so a pre-V46 save replays byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V46_STICKY_SENTRY_ENTRANCE = 46 as const;

/**
 * #332 — V47 surplus sentries stand down.
 *
 * Step 10a only ever promotes Idle ants, so nothing turned a fighter back into a
 * worker (V40's stand-down only fires below the small-colony floor). A war ratio
 * makes most of a colony fighters — an AI invasion runs at 2:8 — and they stayed
 * fighters for the rest of the game: after the first invasion the AI kept ~28
 * sentries at its door through Recovery and Peacetime, doing nothing for the
 * economy.
 *
 * From V47, at the step-8 allocation checkpoint, a colony with more fighters than
 * its ratio allocates (more than one over) releases all but one of the surplus to
 * Idle — only SENTRIES that are
 * holding their post (no rally point, no spider priority, not alarmed, on the
 * surface, settled), highest entity id first so lower-ranked sentries keep their
 * posts. Step 10a promotes them the same tick. Fighters under orders (a rally,
 * the spider, tunnel defence, an invasion) and sentries chasing or taking cover
 * are never released.
 *
 * No new serialized field, no command, no world.rngState draw, no entity-ID
 * advance, no tick-order change: the new pass is behind `simVersion >= V47`, so a
 * pre-V47 save replays byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V47_SENTRY_STAND_DOWN = 47 as const;

/**
 * #333 — V48 a sentry walking home gets home.
 *
 * A sentry outside its guard area (SENTRY_GUARD_RADIUS, 8 tiles) walks home to
 * its entrance; inside it, it walks to its post. Both walks were straight-line
 * steps, so a sentry behind an obstacle either stuck against it or, right at the
 * guard edge, flipped every tick: at 9 tiles the step home slid it along the
 * obstacle to 8, and at 8 the step to its post slid it back to 9.
 *
 * From V48 a sentry that is not holding its post walks home until it is inside
 * the entrance's door area (SENTRY_DOOR_AREA_RADIUS, 4 tiles), not just inside
 * the guard area, and only then heads for its post; and walking home it steps by
 * its colony's surface entrance flow field (the obstacle-aware field homebound
 * foragers already use, #63), so it gets round obstacles. A sentry holding its
 * post keeps holding it wherever the hold rules allow.
 *
 * No new serialized field (the step-16 walk-home marker is same-tick scratch),
 * no command, no world.rngState draw, no entity-ID advance, no tick-order
 * change: the rules are behind `simVersion >= V48`, so a pre-V48 save replays
 * byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V48_SENTRY_WALK_HOME = 48 as const;

/**
 * #322 — V49 the colony alarm musters its civilians home.
 *
 * With the alarm on and every own entrance camped, V42 froze each homebound
 * forager wherever it stood, for as long as the alarm lasted: the alarm read
 * every tile as dangerous and also switched off V38's local all-clear release.
 * A searching forager kept searching out to its leash, then turned homebound and
 * froze out there too, often 30–55 tiles from home.
 *
 * From V49, while the alarm is on:
 *   - a homebound forager with no safe entrance holds only where its OWN tile
 *     reads real danger (FLEE_THRESHOLD); elsewhere it walks home on normal
 *     routing, so it waits at the edge of the danger by its entrance and enters
 *     as soon as the entrance clears;
 *   - V38's local all-clear release applies again to a held forager;
 *   - a searching forager turns homebound (step 9c), and a returning one never
 *     breaks out to search again;
 *   - a returning forager descends its own open entrance, as a carrier does;
 *   - step 9b does not demote a searcher to Idle (9c recalls it instead);
 *   - an idle worker on a quiet tile walks toward its nearest open entrance by
 *     the surface entrance flow field (round obstacles) and waits just outside
 *     the doorstep (FLEE_HOMEBOUND_PUSH_THROUGH_TILES); mustering idle workers
 *     neither claim a tile nor are bumped, so they never block a carrier.
 * A recalled searcher's leash wave is parked as -(wave + 1) and restored exactly
 * when it reaches home or turns back to searching, so a recall never counts as a
 * failed search.
 * With a safe entrance, the alarm still recalls everyone through it, and only
 * switching the alarm off lets sheltered civilians back out (unchanged).
 *
 * No new serialized field, no command, no world.rngState draw, no entity-ID
 * advance, no tick-order change: the rules are behind `simVersion >= V49`, so a
 * pre-V49 save replays byte-identically. MIN_ACCEPTED is UNCHANGED.
 */
export const SIM_VERSION_V49_ALARM_MUSTER = 49 as const;

/**
 * #290 PR 2 — V50 the located food store and the count-up hunger clock.
 *
 * Storage swap, no behaviour change, and a DELIBERATE save wipe (MIN_ACCEPTED is
 * raised to V50; see MIN_ACCEPTED_SIM_VERSION in platform/save.ts):
 *   - `world.foodPiles` (an array of pile objects), `ColonyRecord.foodStored` (the
 *     entrance pool) and `ChamberRecord.foodStored` (FoodStorage stock) become one
 *     structure-of-arrays table, `world.food` (src/sim/food/food-store.ts): one
 *     slot per Pile / Pool / Stock record, all quantities in fp, linked by
 *     `ColonyRecord.poolSlot` and `ChamberRecord.foodSlot`. Callers use the food
 *     facade (food/food-api.ts) unchanged.
 *   - `ants.starvationTimer` (a larva countdown) and `colony.queenStarvationTimer`
 *     become one count-up clock, `ants.lastMealTick` (src/sim/hunger.ts), with a
 *     hunger profile per kind. The queen and larva profiles reproduce the old
 *     countdown's death tick exactly.
 *   - Pre-declared for #290 PRs 4–6, all 0 / unused here: the three raid counters
 *     on ColonyRecord (`foodRaidedFp`, `foodLostToRaidsFp`, `raidTrips`) and
 *     FightingSubState Looting / Hauling.
 * A pre-V50 snapshot cannot be loaded into the new shape without a format
 * transform, which ADR-0014 forbids, hence the wipe (owner decision on #290,
 * 2026-09-25). Same RNG draws, same entity-id advance, same tick order: the
 * food-equivalence projection (platform/food-projection.ts) is identical to the
 * pre-V50 build's at every checkpoint of the byte-gate scenarios.
 */
export const SIM_VERSION_V50_LOCATED_FOOD = 50 as const;

/**
 * #288 / #290 PR 4 — V51 workers and fighters eat.
 *
 * Until V51 only the queen and larvae ate. From V51 every worker (fighters
 * included) has a hunger profile too (WORKER_HUNGER / FIGHTER_HUNGER in
 * src/sim/hunger.ts, the kind read at the moment of the check):
 *   - Step 3, after the queen and larvae, walks `colony.workers` in order. A
 *     worker whose meal is due eats one meal from the colony stores when it is
 *     AT HOME (underground in its own nest, or on the surface within
 *     HOME_EAT_RADIUS_TILES of an own open entrance), or from its own load when
 *     it is away and carrying food. A meal from the stores is skipped when it
 *     would leave the colony below QUEEN_MEAL_RESERVE_FP: the colony feeds the
 *     queen first, then larvae, then workers. A worker that misses a meal at or
 *     past its starve-after dies of starvation (despawnAnt, no corpse food).
 *   - Owner decision D11: a fighter away from home, empty-handed and hungry
 *     (FIGHTER_WALK_HOME_HUNGER_TICKS since its last meal) walks home to eat
 *     (step 10c; step 16 steps it by the surface entrance flow field, and an
 *     invader in a foreign nest climbs out first), unless it is fighting (an
 *     enemy in sight) or its colony has sent its fighters at the spider. Once
 *     it has eaten its ordinary routing takes it back to its rally or post.
 *     At home and still hungry (the colony could not feed it) it waits there.
 * No new serialized field (the walk-home marker is same-tick step-10c scratch;
 * the clock `ants.lastMealTick` was declared at V50), no command, no
 * world.rngState draw, no entity-ID advance, no tick-order change: the rules are
 * behind `simVersion >= V51`, so a V50 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V51_UNIFIED_HUNGER = 51 as const;

/**
 * #290 PR 5 — V52 automatic fighter raids.
 *
 * From V52 a fighter below ground in an ENEMY nest, sent there by a rally on that
 * nest's open entrance, steals from the enemy's FoodStorage chambers (owner
 * decisions D2–D5, D10, D13; policy in src/sim/ant/ant-raid.ts):
 *   - It LOOTS (FightingSubState.Looting) when `fighterMayLoot` holds: no hostile
 *     (an enemy worker or queen; brood does not count) within
 *     RAID_ENGAGE_RADIUS_TILES path tiles, empty-handed, not hungry (D11 walks
 *     it home first), not in a duel, and a FoodStorage chamber with food is
 *     reachable. It walks the per-tick stock flow field to that chamber. Else it
 *     fights as before: a hostile in reach, or — larder empty — the nearest
 *     hostile anywhere, the queen included (D10: loot first, then the queen).
 *     The entrance pool is never looted (D3).
 *   - Standing in the chamber it takes up to RAID_CARRY_FP (step 16e) and HAULS
 *     it (Hauling): out of the enemy nest by that nest's entrance flow field,
 *     home by its own surface entrance flow field, down its own shaft (the V43
 *     own-shaft rule lets a hauler in; a hauler never goes down a foreign shaft),
 *     and deposits it as a forager would (FoodStorage chamber, else the pool).
 *     Then it walks back to its rally. A hauler ignores the rally (a cleared rally
 *     still gets the food home), eats from its load when a meal is due (V51
 *     carried rations), is never stood down, and does not lay FoodTrail (only
 *     foragers do from V52), so foragers are not lured to the enemy's door.
 *   - A hauler that dies drops its load: on the surface as a corpse pile at its
 *     tile (whole pickups; the remainder is lost), in the enemy nest into the
 *     victim's pool (D13, capped; overflow is lost), in its own nest into its own
 *     pool.
 *   - ColonyRecord counters (declared at V50): `foodRaidedFp` / victim's
 *     `foodLostToRaidsFp` grow by each load taken and shrink by food a dying
 *     hauler hands back to the victim's pool; `raidTrips` counts hauls
 *     deposited in full.
 *   - Same-colony occupancy exempts work sites of the grid an ant stands in
 *     (raiders stacking in an enemy FoodStorage chamber), not of its own colony.
 * FightingSubState Looting 4 / Hauling 5 were reserved at V50; the save validator
 * accepts them from V52 only. No new serialized field (the stock flow field is
 * per-tick scratch), no command, no world.rngState draw, no entity-ID advance
 * except a hauler's corpse pile (as V37 corpse food), no tick-order change beyond
 * the two new V52-gated steps 10e (after 10d) and 16e (right after 16b). A V51 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V52_RAIDING = 52 as const;

/**
 * #290 PR 6b (V53) — owner decision D14: a fighter loots only when its own colony
 * has room for the loot (`lootVerdict`, ant-raid.ts):
 *   - to START, the room the colony can actually deposit into
 *     (`colonyDepositableRoom`: pool headroom plus the free space of each
 *     FoodStorage chamber that accepts a deposit), less what its raids have
 *     already committed (the loads its haulers carry, plus RAID_CARRY_FP per
 *     fighter of it already Looting, kept current through the step-10e pass),
 *     must hold one more full load (RAID_CARRY_FP), and some
 *     store must accept a deposit (not `colonyHasNoDepositTarget`);
 *   - one already Looting keeps on until the colony has nowhere at all to put
 *     food (`colonyHasNoDepositTarget`), then stops at its next step-10e decision.
 * A fighter that may not loot hunts, as a raider with an empty larder does (D10).
 * A hauler already carrying keeps hauling home. Every colony, player included (the
 * sim does not tell an AI from a human, and a full larder gains nothing from loot
 * either way). The render-side AI rule that places extra FoodStorage chambers when
 * the stores are nearly full is gated on V53 too, so a V52 world keeps its AI
 * command stream.
 * No new serialized field (the committed food is per-pass scratch), command, RNG
 * draw, entity-ID advance or tick-order change. A V52 save replays
 * byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V53_NO_LOOT_WHEN_FULL = 53 as const;

/**
 * #337 (V54) — a timed-out rampage moves on to another entrance (owner decision,
 * 2026-09-26).
 *
 * Up to V53 a hungry spider whose rampage timed out (SPIDER_RAMPAGE_MAX_TICKS with no
 * kill) could start a new one on the same entrance the next tick, so a colony
 * sheltering underground could be camped until its queen starved. From V54:
 *   - When a rampage TIMES OUT without a kill, the spider records the entrance it was camping as its
 *     rotation cursor (`SpiderState.rampageRotationEntranceId`, plus the timeout tick
 *     in `rampageRotationTick`).
 *   - While the cursor is set, a new rampage does not use the 60/40 colony picker. It
 *     camps the NEXT open entrance in ascending `entranceId` order across every colony
 *     (wrapping), skipping the cursor's entrance, and pins it
 *     (`SpiderState.rampageEntranceId`) so it camps that entrance, not merely the
 *     nearest one of its colony. When that rampage times out too, the cursor advances
 *     to it; so the spider cycles through all open entrances of both colonies.
 *   - Single-entrance rule: when the cursor's entrance is the only open entrance in the
 *     world, the spider may camp it again only SPIDER_RAMPAGE_REVISIT_COOLDOWN_TICKS
 *     after the timeout. Until then it does not rampage; it keeps patrolling, and still
 *     chases and hunts (density strikes) as a hungry spider does.
 *   - Any kill (whatever resets `hungerTicks`: step 3 of tickSpider) clears the cursor,
 *     and the next hungry spell starts from the 60/40 picker again. A rampage that ends
 *     for any other reason (a kill, a chase-divert, self-defense, a sealed entrance)
 *     does not move the cursor.
 * New serialized SpiderState fields (all -1 = none, and never written at V53):
 * rampageEntranceId, rampageRotationEntranceId, rampageRotationTick. No command, no
 * world.rngState draw (the order is by entranceId), no entity-ID advance, no tick-order
 * change. A V53 save replays byte-identically (apart from the three new fields, which
 * stay -1). MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V54_SPIDER_ROTATES_ENTRANCES = 54 as const;

/**
 * #343 + #346 (V55) — ants walking home route round what is in the way.
 *
 * Up to V54 three kinds of walker stepped in a straight line at their goal, so an
 * obstacle (or a bend) between them and it pinned them for good; since V51
 * workers eat, and a worker pinned away from home starves. From V55:
 *   - #343: a surface NURSE walking to its nearest open entrance steps by its
 *     colony's surface entrance flow field (obstacle-aware), as a homebound
 *     forager does (and as V48 sentries and V49 musterers do).
 *   - #343: a surface IDLE worker walking back from beyond home range
 *     (`idleWalksHome`, idle-reserve.ts: not at home, not fleeing, its colony not
 *     under the alarm, not dodging the spider's reticle, and no open entrance of
 *     its colony camped) steps by the same field, at the idle saunter
 *     (IDLE_MILL_TICK_DIVISOR). At home it mills as before.
 *   - #346: a RECALLED invader (its colony's rally cleared) inside an enemy nest
 *     walks out as a V52 hauler does: by that nest's entrance flow field, and off
 *     it by the wall-aware BFS step (`hungryExitStep`) toward the first open
 *     entrance of the nest it can reach, instead of a straight line at the
 *     nearest shaft.
 * No new serialized field, command, world.rngState draw, entity-ID advance or
 * tick-order change. A V54 save replays byte-identically. MIN_ACCEPTED is
 * UNCHANGED (V50).
 */
export const SIM_VERSION_V55_ROUTED_HOMING = 55 as const;

/**
 * #347 (V56) — an AI colony's frontage check reads its OPPONENT's workers.
 *
 * Up to V55 the Peacetime→WarFooting frontage trigger (`AI_FRONTAGE_PLAYER_WORKERS_*`)
 * always read the PLAYER colony's worker count, so a rule-based AI driving the
 * player colony (`check:ai-economy --both-ai`, a future AI-vs-AI mode) compared its
 * own workers with itself. From V56 it reads the opponent colony
 * (`opponentColonyId`): the player for the enemy AI — the only AI in real play, for
 * which nothing changes — and the enemy for a player-colony AI. The
 * `ai_state_transition` event's `triggerValues.playerWorkerCount` reports the same
 * number the check compared, at every version.
 * No new serialized field, command, world.rngState draw, entity-ID advance or
 * tick-order change. A V55 save replays byte-identically. MIN_ACCEPTED is
 * UNCHANGED (V50).
 */
export const SIM_VERSION_V56_OPPONENT_FRONTAGE = 56 as const;

/**
 * #357 + #358 (V57) — surface walkers bound for one particular entrance route round
 * what is in the way.
 *
 * Up to V56 two surface walkers stepped in a straight line at their entrance, so an
 * obstacle between them and it pinned them. Neither can use the colony's surface
 * entrance flow field: it leads to the NEAREST OPEN entrance, and each of these is
 * bound for one entrance that may not be it. From V57 each steps down the surface
 * goal field seeded at its own target tile (`stepTowardReachable`, the per-target
 * BFS field PR 5 foragers use, cached per tile on the frozen terrain):
 *   - #357: a fighter of a TUNNEL-DEFENCE colony (its rally on one of its own open
 *     entrances, V44) that step 10c's ordinary rally routing sends across the
 *     surface to that entrance (`defenderWalksToEntrance`) — a fed one, or a hungry
 *     one the D11 walk-home does not take (at home, or in a duel). It may go down
 *     only that shaft (fighterBarredFromOwnShaft), so the nearest-entrance field
 *     could lead it to an entrance it may not use.
 *   - #358: a surface DIGGER walking to its entrance target — the nearest of its
 *     colony's entrances, closed (designated, not yet dug through) or open, and
 *     from V57 nearest by PATH on those fields (by Manhattan a detour could flip
 *     its target back and forth). A closed entrance is not on the entrance flow
 *     field at all.
 * Off the field (a tile that cannot reach the target) each keeps its straight-line
 * step. No new serialized field, command, world.rngState draw, entity-ID advance
 * or tick-order change (the goal-field cache is derived, unserialized state). A
 * V56 save replays byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V57_ROUTED_TO_ENTRANCE = 57 as const;

/**
 * #363 (V58) — a STARVING fighter drops the fight to go eat.
 *
 * Up to V57 combat came first for a hungry fighter (D11): a duel in progress (the
 * spider's included), an enemy ant in sight, or its colony's order to fight the
 * spider kept it from walking home, so a fighter held in an on-and-off fight away
 * from home could starve there. From V58 a fighter away from home and empty-handed
 * that is STARVING — FIGHTER_STARVING_TICKS since its last meal, 600 ticks before
 * it would starve (`fighterIsStarving`) — walks home by the D11 walk-home anyway,
 * if its colony's stores can feed it (`storesCanSpareMeal`):
 *   - on the surface, from a duel, past enemy ants it sees, and out from under
 *     its colony's spider order (step 10d leaves a fighter walking home to eat alone);
 *   - below ground in an enemy nest, from a duel or with enemies near.
 * A hungry fighter short of starving still fights first, as before. No new
 * serialized field, command, world.rngState draw, entity-ID advance or tick-order
 * change. A V57 save replays byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V58_STARVING_FIGHTER_EATS = 58 as const;

/**
 * #364 (V59) — invaders piling on one defender go for the next reachable enemy.
 *
 * Combat fights one pair per tile per tick (the lowest-id ant of each colony on
 * it), and up to V58 every invader hunting in an enemy nest went for the same
 * nearest hostile by Manhattan distance, so a pile of invaders waited behind one
 * duel while other enemies stood free. A tile is SATURATED for invader `id` when
 * its colony already holds the duel there (`tileSaturatedFor`, ant-motion.ts): its
 * own tile when a lower-id friend stands on it too, any other tile when any friend
 * does. From V59:
 *   - an invader on the hunt steps toward the nearest hostile BY PATH on a tile not
 *     saturated for it (`invaderHuntStep`, invader-retarget.ts), not routing
 *     through tiles lower-id friends hold where the occupancy pass would bump it
 *     back. With none it can reach past them it holds (a free one lies beyond its
 *     friends) or walks to the nearest queue by path; only with no hostile the
 *     tunnels reach at all does it hunt as before;
 *   - a raider's reach check (ant-raid.ts hostileInReach) ignores hostiles on
 *     tiles saturated for it, so a duel a friend holds neither stops its looting
 *     nor draws it in to queue. Step 10e's aim, which an aimed raider follows
 *     instead of the hunt, is a free hostile when 10e picks it (a lower-id friend
 *     can reach its tile first that tick). The reach check counts adults only, the
 *     hunt brood too, as before V59: a looter loots beside unguarded brood.
 * No new serialized field, command, world.rngState draw, entity-ID advance or
 * tick-order change (the search buffers are derived, unserialized scratch). A V58
 * save replays byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V59_INVADER_RETARGET = 59 as const;

/**
 * #352 (V60) — raid orders: a rally on an enemy entrance carries a RAID TYPE.
 *
 * Up to V59 a rally on an enemy's open entrance always raided one way (V52/V53:
 * loot while the colony's own stores have room, then go for the queen). From V60
 * the colony stores a `RaidType` with its rally (`ColonyRecord.raidType`, set by
 * SetRallyPoint's optional `raidType`; absent = Loot; a cleared rally resets it to
 * Loot), and its fighters rallied on an enemy entrance act by it:
 *   - Loot: the V53 raid, unchanged.
 *   - Deny: loot regardless of room at home; a hauler reaching its own entrance
 *     drops what its stores cannot take (rounded up to whole pickups) there as a
 *     surface food pile and carries the rest down to store it
 *     (`denyHaulerDropsLoad`, ant-raid.ts).
 *   - Spoil: loot's eligibility, but a spoiler standing on an enemy FoodStorage
 *     chamber destroys RAID_CARRY_FP there every SPOIL_TICKS_PER_LOAD ticks and
 *     never goes home.
 *   - Blockade: fighters never go down; they hold a ring of posts round the enemy
 *     entrance and chase any enemy ant within BLOCKADE_RADIUS_TILES of it
 *     (ant-blockade.ts, tick step 10c2).
 *   - Assault: no looting; an invader goes for the enemy queen.
 * Loot, Deny and Spoil go for the queen too once there is nothing left to take
 * (no reachable stock by their own start / keep-going rule), not the hunt. While a
 * friend already holds the queen's tile (#364's saturation), any of the four goes
 * for a free enemy worker within RAID_ENGAGE_RADIUS_TILES path tiles (the fighters'
 * sight) instead, and with none in sight queues for the queen (raidQueenTarget).
 * New serialized field `ColonyRecord.raidType`, written only when not Loot, so
 * every pre-V60 save (always Loot) serializes as before;
 * the SetRallyPoint handler ignores `raidType` below V60. No world.rngState draw;
 * a new pass (step 10c2, a no-op without a blockade) and the Deny drop's entity-id
 * advance happen only for a non-Loot raid type. A V59 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V60_RAID_ORDERS = 60 as const;

/**
 * #370 (V61) — the rule-based AI places its first FoodStorage chamber without
 * waiting for a Queen chamber.
 *
 * Up to V60 the controller (`aiChamberPlacement`, src/render/ai-controller.ts) held
 * its first FoodStorage until a Queen chamber was pending (the #33 build order),
 * and the Queen waits for the bootstrap shaft to reach AI_QUEEN_CHAMBER_DEPTH. A
 * colony with no FoodStorage has no forage backpressure (V27 is scoped to colonies
 * that own one), so once its entrance pool filled (~tick 750) every forager parked
 * holding food (the #27 carrier wait) and none went Idle; auto-dig takes only Idle
 * workers (D-02), so the shaft was dug only when the queen ate a little headroom
 * into the pool — the Queen chamber landed ~tick 4 500 and the colony sat on its
 * three starting workers for ~5 minutes. From V61 the first FoodStorage goes in as
 * soon as the stores reach AI_FOOD_STORAGE_THRESHOLD, so carriers keep depositing
 * and a full store idles workers (V27) instead of parking them. The #33 hazard the
 * Queen-first order guarded against — a shallow first chamber ending the bootstrap
 * dig — is gone: the bootstrap runs until a Queen chamber is COMPLETED.
 * Render-side policy: the sim is unchanged; the gate keeps the AI command stream of
 * a pre-V61 world as it was recorded. No new serialized field, command,
 * world.rngState draw, entity-ID advance or tick-order change. A V60 save replays
 * byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V61_AI_EARLY_STORAGE = 61 as const;

/**
 * #371 (V62) — the rule-based AI defends its own nest, and tunnel defenders spread
 * over the invaders.
 *
 * Up to V61 the controller never rallied on its own entrance, so its fighters
 * stayed sentries on the surface while raiders walked past them, down the shaft
 * and to the queen (a 6-fighter Assault won ~240 ticks after the rally). From V62:
 *   - AI policy (src/render/ai-controller.ts, on the existing SetRallyPoint /
 *     ClearRallyPoint / SetBehaviorRatio commands, plus the new SetAIRaidClock): a RAID — an enemy fighter in
 *     the nest, or at least two on the surface near an own open entrance — lasts
 *     exactly as long as the raiders do (the colony's own numbers never end it).
 *     Throughout, the colony drafts fighters (AI_DEFENCE_RATIO), starts no probe,
 *     commits no invasion cohort and calls a probe in flight home (a committed
 *     invasion keeps its rally) — with no enemy inside, for at most
 *     AI_DEFENCE_OPS_HOLD_LIMIT_TICKS, timed by AIStateRecord.raidSinceTick. Its rally goes on the threatened entrance (tunnel
 *     defenders, V44) while raiders are inside or it is not stronger AT HOME
 *     (fighters in its nest or near its entrances; a probe's fighters away do not
 *     count), else on the nearest surface raider (a sally). When the raid is over
 *     the rally is cleared (`aiNestDefence`) and a probe gets its own back.
 *   - Sim (both colonies alike, CLNY-08): a tunnel defender after an invader moves
 *     by the #364 saturation-aware hunt (`invaderHuntStep`, where in the
 *     defender's own nest only a fighter or a lower-id nestmate holds a duel) instead of
 *     straight at the nearest invader, so a pack of defenders spreads over the
 *     raiders instead of stacking on one tile, where combat pairs only one of them.
 *   - Sim: AIStateRecord.raidSinceTick (-1 = none) and the SetAIRaidClock command
 *     that sets/clears it (no-op below V62). The field is serialized only when set,
 *     so a V61 world's snapshot is unchanged; an older save loads it as -1.
 * No world.rngState draw, entity-ID advance or tick-order change (the hunt's buffers
 * are derived, unserialized scratch). A V61 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V62_AI_NEST_DEFENCE = 62 as const;

/**
 * #374 (V63) — the rule-based AI digs its Queen chamber at least a third of the way
 * down the underground grid; its first FoodStorage (the larder) stays shallow.
 *
 * Up to V62 the controller (`aiChamberPlacement`, src/render/ai-controller.ts)
 * anchored the Queen chamber near AI_QUEEN_CHAMBER_DEPTH (18) and accepted any
 * anchor within AI_PLACEMENT_DEPTH_TOLERANCE (4) rows, so it landed as soon as the
 * bootstrap shaft reached row 14 — a few rows under the larder. A raid that came
 * for food met the queen first: she is a hostile in reach, so Loot / Deny / Spoil
 * fought her before taking anything and played like an Assault. From V63 the
 * Queen anchor row must satisfy `3 × row >= grid height` (row 22 of 64); the
 * bootstrap shaft simply digs further before the Queen goes in. On a grid too
 * shallow for the Queen footprint below that row, the floor falls back to the
 * deepest row the footprint fits (`aiQueenMinAnchorRow`). The policy is the AI
 * controller's for whatever colony it drives (CLNY-08); a player places their own.
 * Render-side policy: the sim is unchanged; the gate keeps the AI command stream of
 * a pre-V63 world as it was recorded. No new serialized field, command,
 * world.rngState draw, entity-ID advance or tick-order change. A V62 save replays
 * byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V63_AI_DEEP_QUEEN = 63 as const;

/**
 * #372 (V64) — automatic defence, and an AI probe sends only its cohort.
 *
 *   - Automatic defence (sim, every colony alike — CLNY-08): while an enemy ant is
 *     below ground in a colony's nest, in the part joined to one of its open
 *     entrances (the **breached entrance**: the first open entrance of the part of
 *     the nest the intruders are in; between unconnected parts, the one holding the
 *     most own fighters below, then the one nearest an intruder; none while the
 *     colony's rally is on an own open entrance), that colony's fighters with NO orders — the
 *     sentries — defend it as tunnel defenders do (V44): they go down the breached
 *     entrance and hunt the intruders (the V62 spread). Fighters with orders keep
 *     them. Once no intruder is left they are sentries again and go back to their
 *     posts. Surplus sentries do not stand down (V47) while an enemy is in the nest.
 *   - Probe cohort (sim): up to V63 a rally applied to every fighter of the colony,
 *     so an AI probe that recorded 3 fighters sent all of them. From V64, while a
 *     colony's rally is its AI probe's rally (AIStateRecord.operationKind 'Probe'
 *     and the rally on the operation's target tile), only the fighters in the
 *     probe's cohort (operationFighterIds) answer it; the rest have no orders.
 * No new serialized field, command, world.rngState draw, entity-ID advance or
 * tick-order change (the breached entrance is per-tick scratch, recomputed at step
 * 10c before anything reads it). A V63 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V64_AUTO_DEFENCE = 64 as const;

/**
 * #373 (V65) — the colony alarm during an invasion. Up to V64 the alarm made an
 * invasion worse: its civilians could not be recruited as fighters, so shifting the
 * ratio toward fighters did nothing, and they sheltered at the shaft top the
 * invaders come down. From V65 (every colony alike — CLNY-08):
 *   - The ratio always wins. While the alarm sounds, step 10a still recruits Idle
 *     workers into FIGHTING when the ratio asks for more fighters, sheltering ones
 *     included (the V34 skip of a worker on the flee timer no longer applies to
 *     them). It recruits them into nothing else: foraging, digging and nursing wait
 *     for the all-clear, as before. The new fighters have the fighters' orders (a
 *     rally, or, with none, the V64 automatic defence of a breached nest); step
 *     15b's reassignment guard ends their shelter the same tick. An EMPTY forager
 *     sheltering below (the alarm recalls searchers home and holds them at the
 *     shaft top) counts as a sheltering worker and is recruited too, its parked
 *     leash wave restored; a carrier is not. The alarm governs
 *     only the civilians left.
 *   - Shelter away from the invaders (ant/idle-reserve.ts, the shelter retreat).
 *     While an enemy ant is below
 *     ground in a colony's nest, its SHELTERERS (workers held underground on the flee
 *     timer: under the alarm, or after a V34 flee) walk by tunnel path to the chamber
 *     tile farthest from the invaders — one per connected part of the nest — if it
 *     is farther from them than where they stand; otherwise they stay put (so on a
 *     looped nest one can stop in a tunnel already farther than the chamber). They stay
 *     sheltering (no poke-out) until the nest is clear; a shelterer at the shaft top
 *     with nowhere to retreat keeps the V34 poke-out. Workers not sheltering
 *     (already deep: wanderers, nurses, carriers) and the queen do not move. With no
 *     intruder in the nest nothing changes for a shelterer at the shaft top: it
 *     waits there. The way to the chamber never runs through or beside an
 *     invader: where it would, the shelterer holds; one already beside an invader
 *     steps away from it first — but one on an invader's own tile holds, since every
 *     way out passes beside it. So in a nest with one shaft, invaders coming down
 *     it onto the shelterers at its top leave them holding there; the retreat
 *     matters once the invaders have moved on from the shaft top, or where the
 *     nest has other ways in, loops or side chambers. While the
 *     nest is invaded shelterers below ground neither claim a tile nor are bumped.
 *   - After the invasion a shelterer that retreated is below the shaft-top row,
 *     where the poke-out could never let it out; once its timer runs out it stops
 *     sheltering where it stands (an Idle worker below ground, like any other).
 *     The rule is keyed on the row, so it applies to ANY shelterer below row 0 at
 *     V65. Outside a retreat none is there in play (the descent and the alarm's
 *     hold put a shelterer on row 0, the occupancy-exempt shaft top), and before
 *     V65 such an ant was re-armed forever when no entrance was at its column.
 *   - Recruiting under the alarm does not lose a fighter to the dig slot: with no
 *     digger at work, a Mark's carve from the fight share is skipped (no digger
 *     would be recruited into it). The persisted computedAllocation.dig (the HUD's)
 *     still reads 1 for the Mark, as before.
 * No new serialized field, command, world.rngState draw, entity-ID advance or
 * tick-order change (the retreat field is per-tick scratch built at step 15b and
 * read at step 16). A V64 save replays byte-identically. MIN_ACCEPTED is UNCHANGED
 * (V50).
 */
export const SIM_VERSION_V65_ALARM_INVASION = 65 as const;

/**
 * #375 (V66) — the queen starves by losing health. Up to V65 a queen who could not
 * eat died outright once QUEEN_STARVE_AFTER_TICKS (300) passed since her last meal,
 * whatever her HP, so the HUD's queen bar had to show hunger, and a queen at 6/30 HP
 * read 100%. From V66 (every colony alike — CLNY-08), while she cannot eat she
 * loses 1 HP (`ants.hp`, not the home-ground combat buffer) each time the ticks
 * since her last meal reach a multiple of QUEEN_STARVE_HP_DRAIN_INTERVAL_TICKS (10),
 * and dies at 0 HP — a starvation death (despawnAnt 'starvation', so queen_death
 * still reports cause Starvation). A full-HP queen (COMBAT_HP_QUEEN 30) dies on the
 * same tick as at V65; a wounded one sooner, and a hungry one hit in combat dies
 * sooner too. A meal stops the drain and restarts the interval (ticks since meal
 * restart from 1). While fed she heals: on each tick she eats whose number is a
 * multiple of QUEEN_FED_HP_REGEN_INTERVAL_TICKS she regains 1 HP, up to
 * COMBAT_HP_QUEEN — any lost HP, combat wounds included (the home-ground buffer is
 * untouched). So a short hunger burst heals back and a long famine still kills.
 * It is the first HP regeneration any ant has had. Larvae, workers and fighters
 * keep their V65 starvation (death at their starve-after). The HUD shows the
 * queen's HP (render only). The drain is keyed on the existing hunger clock
 * (`ants.lastMealTick`) and the regen on world.tick, so there is no new serialized
 * field, command, world.rngState draw, entity-ID advance or tick-order change. A
 * V65 save replays byte-identically. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V66_QUEEN_STARVES_HP = 66 as const;

/**
 * #376 (V67) — no match timeout. Up to V66, when both queens were still alive at
 * MATCH_TIMEOUT_TICKS (24 000 ticks, 20 minutes), step 18's checkTiebreaks ended the
 * match: a Victory, Defeat or MutualDestruction by living worker count, with a
 * round_end 'TimeoutTiebreak' event. Nothing on screen counted down to it, so the
 * result came without warning. From V67 there is no time limit: a match with both
 * queens alive goes on until one dies (checkQueenDeath). The Stalemate tiebreak (no
 * food on the map and both colonies starving) is unchanged; past tick 24 000 it can
 * now fire where the Timeout used to take priority over it. Nothing replaces the
 * Timeout: two colonies that neither kill nor starve each other's queen play on —
 * until, hours in, entity IDs run out (they are never recycled; MAX_ENTITIES, #233):
 * from then on no egg, food pile, chamber or entrance can be made, so the match
 * eventually ends in a starving queen or the Stalemate.
 * The gate reads only world.simVersion and world.tick, so before tick 24 000 V66 and
 * V67 run the same code. From there a V67 world skips the Timeout: where a V66 match
 * ended with a TimeoutTiebreak, tick() returns None — or, if the Stalemate condition
 * holds, MutualDestruction with a StalemateTiebreak round_end. There is no
 * new serialized field, command, world.rngState draw, entity-ID advance or
 * tick-order change. A V66 save replays byte-identically and still ends at
 * MATCH_TIMEOUT_TICKS. MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V67_NO_MATCH_TIMEOUT = 67 as const;

/**
 * #377 (V68) — idle workers shelter from a spider rampage. Up to V67 an Idle worker
 * on the surface kept milling round its colony's entrance while the spider hunted,
 * and fled only from DangerTrail on its own tile, so a spider camping the door, or
 * passing it, picked the idle reserve off one at a time (its straggler chase, within
 * SPIDER_CHASE_TRIGGER_RADIUS). With stores full nearly every worker is idle — the
 * backpressure demotes searchers to Idle — so it was steady attrition. From V68
 * (every colony alike — CLNY-08), while the spider is ON A RAMPAGE (spider.ts
 * spiderOnRampage: out hunting hungry, from the moment it grows hungry until it eats
 * or dies — one hungry spell, of which the Rampaging state is only the
 * entrance-camping part: a camper diverts to chase any ant that comes near)
 * AND THREATENS THE COLONY (idle-reserve.ts rampageThreatens: it is camping, or on
 * its way to camp, one of the colony's entrances — Rampaging with
 * rampageTargetColonyId the colony — or it is within RAMPAGE_THREAT_RADIUS_TILES,
 * the spider's hunt-search radius, of one of the colony's open entrances, whatever it
 * is doing, a chase between camps included). A colony it is not threatening keeps its
 * idle reserve out, exactly as at V67. While it threatens one:
 *   - Every Idle worker on the surface of the colony, if its alarm is off, goes in. Only
 *     Idle workers: foragers (searchers, carriers, returners) keep working, under the
 *     V34 danger flee as before; fighters, nurses and diggers are untouched. It heads
 *     for the nearest of its colony's open entrances by path (the surface goal field)
 *     that reads no real danger and whose way there keeps out of the spider's reach —
 *     the spider is not within SPIDER_CHASE_TRIGGER_RADIUS (Manhattan, the chase
 *     trigger's own measure) of the worker's shortest path to it, door included,
 *     judged conservatively (it may hold a worker whose actual route would have kept clear) — and
 *     walks that goal field to it (not the V34 flee's straight line). So it never
 *     heads for the entrance the spider is camping or about to reach, nor past the
 *     spider. With no such entrance it holds where it stands, re-choosing every tick
 *     (within the scatter radius of the hunt reticle it keeps step 13e's away step).
 *     Once the spider is within SPIDER_CHASE_TRIGGER_RADIUS of it, every way passes
 *     within its reach, so it must only not walk toward the spider: it runs for the
 *     nearest such entrance whose next step in (the goal field's, re-chosen every
 *     tick) lands no nearer the spider than it stands, and holds if there is none. A
 *     dasher claims no tile in the occupancy pass, so no friend bumps it sideways; a
 *     holder still claims its tile, but a friend's bump shifts it only to a tile no
 *     nearer the spider, and with none it stays (#393).
 *     With the spider on its own tile any way out beats staying: the door's danger
 *     reading (then the spider's own) is not consulted. One already standing on an entrance goes down it unless the
 *     descent there is blocked (a Rampaging spider on it, #165).
 *     (ant/idle-reserve.ts pickRampageShelterEntrance.)
 *   - Once down it shelters at the shaft top, as a V34 flee shelterer does, and an
 *     Idle worker reaching the shaft top from below is held there the same way (the
 *     C1 alarm hook). The poke-out does not let an Idle shelterer out while the
 *     threat lasts, alarm or not; after it, the first poke-out whose exit reads no
 *     real danger does, as before — the shelter timer and the DangerTrail's decay
 *     are the hold-off. The #373 shelter retreat is unchanged, except that 10a may
 *     now recruit a retreating Idle shelterer (below).
 *   - Step 10a still recruits Idle shelterers while the threat lasts and the alarm is
 *     off (the V34 skip of a worker on the flee timer does not apply to any Idle
 *     shelterer then — from the rampage, a V34 danger flee or a #373 retreat), into
 *     any role the allocation asks for: a new fighter, nurse or digger leaves the
 *     shelter the same tick (step 15b's reassignment guard), and a new forager's
 *     poke-out falls due the same tick, so it climbs out unless its exit reads real
 *     danger — or invaders are in its nest, where it keeps sheltering by the #373
 *     retreat until they are gone. A rampage can last thousands of ticks; the ratio
 *     must not wait for it.
 *     Under the alarm the V65 rule stands.
 *   - While the colony alarm sounds it governs the colony's civilians exactly as at
 *     V67 (the rampage adds only the poke-out hold, which outlasts the all-clear).
 *     The spider-priority order moves fighters only: civilians shelter whether or
 *     not their colony has sent its fighters at the spider.
 * Read from saved state only (the spider's state, position, hungerTicks and
 * rampageTargetColonyId — only a Rampaging spider's target counts — world.tick,
 * world.difficulty, the colony's entrances and alarm, the DangerTrail, the hunt
 * reticle (world.scatterReticleTile), ant positions and tasks, and the V34 flee
 * column); the goal fields are the cached
 * derived surface fields. No new serialized field, command, world.rngState draw,
 * entity-ID advance or tick-order change. A V67 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V68_RAMPAGE_SHELTER = 68 as const;

/**
 * #395 (V69) — food-placement fairness at map generation. Up to V68 the FOOD_PILE_COUNT
 * scenario piles were scattered with no regard to who could reach them: about 30% of
 * colonies had no pile within 25 tiles of their entrance (18% none within 30), and a
 * colony that far from food, or with only a small pile near it, could starve in the
 * opening. From V69 createScenario, once the colonies are placed, runs
 * food-fairness.ts ensureFoodNearEachColony: every colony — any number of them,
 * wherever they stand (CLNY-08) — gets at least FOOD_FAIRNESS_MIN_PICKUPS (40)
 * pickups of natural food of its own within FOOD_FAIRNESS_RADIUS_TILES (25) of one of
 * its open entrances, by surface path. A pile within that range is a colony's own when
 * no other colony's open entrance is as near it, so a pile between two close colonies
 * serves neither. A colony short of that has the nearest pile of at least 40 pickups
 * that serves no colony (one nearer it than any other colony first: its own side of
 * the map) moved to a tile drawn uniformly (one world.rngState draw) from the tiles
 * that would serve it and keep the scatter's spacing rules. The pile keeps its id and
 * size, so the pile count and the map's food total do not change. (With no such pile
 * a new one is made — a second draw, for its size — unless the pile store or the
 * entity ids are full.) A map where every colony already has its food is untouched:
 * no draw, no change.
 * The gate is read at world creation only: createScenario takes the simVersion to
 * create (LATEST by default), and a replay from seed passes the recorded one
 * (analyze-snapshot, the byte gate), so a V68 world is generated byte-identically.
 * No new serialized field, command or tick-order change; the only new world.rngState
 * draws are at world creation. Food that spawns during play is placed as before.
 * V69 also gates one render-side AI fix (ai-controller.ts findOpenChamberSpot): a
 * queen still on the surface seeds the chamber-site search at the preferred depth
 * whatever her surface row, so a queen scattered off row 64 before her chamber
 * exists no longer deadlocks the AI's opening. A V68 save replays byte-identically.
 * MIN_ACCEPTED is UNCHANGED (V50).
 */
export const SIM_VERSION_V69_FOOD_FAIRNESS = 69 as const;

/**
 * #395 part 2 (V70) — the egg reserve. Up to V69 the queen laid whenever the colony's
 * stores held QUEEN_EGG_FOOD_THRESHOLD (3 food), so a new Nursery set off a brood
 * boom the player could not stop (the standard opening: a median 16 brood at 3:00)
 * that ate the larder and starved the colony in the opening. From V70 that threshold
 * is gone, at every stage of the match: the queen lays an egg only while the colony's
 * stored food (colonyFoodTotal — the stores meals are drawn from: the entrance pool and
 * every FoodStorage chamber; carried loads are not counted) is at least the egg reserve
 * (lifecycle-system.ts eggReserveFp):
 * every meal the whole colony would eat over QUEEN_EGG_RESERVE_RUNWAY_TICKS with no
 * food coming in, by the hunger profiles (hunger.ts runwayFoodFp) — the queen, each
 * living worker and fighter (workerHungerProfile), each larva, and each egg plus the
 * one about to be laid counted as the larvae they become. Any number of colonies and
 * storage chambers; no player/enemy branching (CLNY-08). The surplus-scaled egg
 * interval and the other gates are unchanged. A consequence of the numbers, not a
 * separate rule: the smallest reserve (3600 fp at the 60 s runway) is more than the
 * entrance pool holds, so a colony needs a FoodStorage chamber before its first egg,
 * and its storage capacity caps its brood (QUEEN_EGG_RESERVE_RUNWAY_TICKS).
 * Read from saved state only (the colony's stores, brood counts, worker roster and
 * tasks); no new serialized field, command, world.rngState draw, entity-ID advance
 * or tick-order change. A V69 save replays byte-identically. MIN_ACCEPTED is
 * UNCHANGED (V50).
 */
export const SIM_VERSION_V70_EGG_RESERVE = 70 as const;

/**
 * #400 (V71) — the health model. The first sim change under the pre-1.0 policy: no
 * version gate, and MIN_ACCEPTED is raised to V71 with it (every older save is
 * rejected). Every rule is colony-agnostic (CLNY-08).
 *   - Max HP by territory (health.ts antMaxHp): an ant's max HP is COMBAT_HP_BASE
 *     (16) away and 20 on its home ground (underground in its own nest); the queen's
 *     is COMBAT_HP_QUEEN away and QUEEN_HP_HOME in her nest. Damage just lowers HP;
 *     leaving home lowers the max and clamps HP down to it, coming home raises it
 *     without healing. The `ants.homeGroundBonusHp` buffer (granted on an ant's first
 *     fight at home and drained before its HP) is gone; the +25% home-ground damage
 *     stays. The queen's HUD bar is her HP out of her max where she stands.
 *   - Healing (health.ts tickHealth, new step 16f between movement and combat):
 *     every creature heals 1 HP per interval while fed (not hungry) and safe (not hit
 *     for HEAL_SAFE_TICKS — new per-creature `ants.lastHitTick` and
 *     `spider.lastHitTick`, stamped by combat). Ants heal only on their home ground
 *     (ANT_HEAL_INTERVAL_TICKS; the queen QUEEN_HEAL_INTERVAL_TICKS, replacing V66's
 *     fed regeneration, which healed her mid-fight). The spider heals anywhere
 *     (SPIDER_HEAL_INTERVAL_TICKS); eating no longer heals it (the V23 feeding heal is
 *     gone). Eggs are laid at their home max HP.
 *   - The queen's base HP is raised (COMBAT_HP_QUEEN) to make up for the lost
 *     mid-fight healing, and her starvation drain retuned so a queen at full home HP
 *     still starves QUEEN_STARVE_AFTER_TICKS after her last meal.
 *   - A spider priority (MarkSpiderPriority) stays on until the player clears it or
 *     the spider dies: no feed, hunt end, rampage end or chase divert clears it.
 */
export const SIM_VERSION_V71_HEALTH_MODEL = 71 as const;
export const LATEST_SIM_VERSION = SIM_VERSION_V71_HEALTH_MODEL;

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
  feedArrivedTick: number; // V23: tick the spider reached feedAwayTile (feed-window clock); -1 while traveling
  /**
   * #400 (V71): tick of the last blow an ant landed on the spider (combat.ts); -1 =
   * never hit. It heals only once HEAL_SAFE_TICKS have passed since (health.ts).
   */
  lastHitTick: number;
  /** V54 (#337): entranceId the current rampage camps (a rotated rampage); -1 = the
   *  nearest open entrance of rampageTargetColonyId (the pre-V54 rule). */
  rampageEntranceId: number;
  /** V54 (#337): entranceId of the entrance whose rampage most recently timed out, the
   *  rotation cursor; -1 = not rotating. Cleared by any kill. */
  rampageRotationEntranceId: number;
  /** V54 (#337): tick that timeout happened (single-entrance revisit cooldown); -1 = none. */
  rampageRotationTick: number;
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
  /**
   * #371 (V62) — the tick the current raid on this colony began, -1 when none. Set and
   * cleared only by the SetAIRaidClock command (the render AI controller's raid
   * detection), so a tick()-only replay reproduces it; the controller stops holding
   * operations for a raid with no enemy inside once it has lasted
   * AI_DEFENCE_OPS_HOLD_LIMIT_TICKS. Serialized only when set (never below V62).
   */
  raidSinceTick: number;
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
   *       and Stalemate tiebreak conditions (V67 removes the Timeout). Pre-V22
   *       saves load with difficulty='Normal' and replay byte-identically.
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
   * shares src's reference (read-only; derived from the copied
   * `bakedSurfaceEffect`) rather than recomputing it.
   */
  surfaceComponentMask: Uint8Array | null;

  /**
   * PR 5 — DERIVED (not serialized): per-target BFS goal-field cache for
   * passability-aware forager routing (`stepTowardReachable`). Keyed by target
   * tile index; terrain is immutable (PR 4) so entries never need invalidation
   * while the world lives. Null until first use; `copyWorldState` resets to null
   * (lazily recomputed in the copy) rather than sharing the growable Map.
   */
  surfaceGoalFields: Map<number, Int32Array> | null;

  /**
   * PR 5 — DERIVED (not serialized): reusable BFS frontier queue for building
   * `surfaceGoalFields` entries (one `Int32Array(SURFACE_TILE_COUNT)`). World-
   * owned (not a module-level singleton) so it stays inside the WorldState
   * snapshot per the ECS boundary; it is pure transient scratch — fully
   * overwritten before any read within a single `computeSurfaceGoalField` call,
   * so it carries no state across calls and is never serialized. Null until
   * first use; `copyWorldState` resets to null (the render-snapshot copy never
   * computes fields, so it never reallocates).
   */
  surfaceGoalBfsScratch: Int32Array | null;

  undergroundGrids: Record<ColonyId, UndergroundGrid>; // per-colony underground (UNDR-08)
  /**
   * #290 PR 2 (V50) — the located food store: every surface pile, colony entrance
   * pool and FoodStorage chamber stock, one SoA slot each (src/sim/food/
   * food-store.ts). Read and written only through the food facade
   * (food/food-api.ts). Serialized except its derived `surfacePileAt` index.
   */
  food: FoodStore;

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
   * #230 — TRANSIENT (not serialized, reset to 0 on load, like `events`): count of
   * gameplay (non-Sync) commands dropped this SESSION past MAX_COMMANDS_PER_TICK. An
   * observability signal for the formerly-silent FIFO drop; a plain field NOT
   * emitEvent (which could bump the PERSISTED dropped* counters at the 2000-event cap).
   */
  droppedCommandOverflowCount: number;

  /**
   * S1 — transient per-colony queen-kill context. Written by despawnAnt
   * (ant-death.ts) when a queen dies — any cause from V41, kills only before —
   * read and cleared by checkQueenDeath later the same tick.
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
    surfaceGoalFields: null,
    surfaceGoalBfsScratch: null,
    undergroundGrids: {},
    food: createFoodStore(),
    recentlyDepletedFood: [], // issue #112 — empty until first depletion
    pendingChambers: {}, // empty Record; PlaceChamberCommand creates entries
    // S0b — telemetry fields.
    events: [],
    droppedCommandOverflowCount: 0, // #230 — transient
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
 * #340 — dst may be reused: whatever dst held or cached before (including caches
 * built by its own earlier ticks), ticking dst afterwards behaves exactly like
 * ticking a fresh copy or a load of src.
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
  // #340 — a copy must leave dst exactly like a fresh or loaded world, so drop
  // everything dst's OWN earlier ticks cached off-WorldState (flow fields, scratch
  // arena). Otherwise a previously-ticked dst kept its stale flow fields (the copy
  // brings over src's clear dirty flags, so nothing forced a rebuild) and, once
  // ticked, diverged from a fresh copy. Two WeakMap deletes; no allocation.
  // A self-copy is a no-op (it would otherwise wipe the world's own events).
  if (src === dst) return;
  invalidateWorldCaches(dst);

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
  // #340 — but dst's OWN earlier events are emptied (length = 0: no allocation),
  // as a load resets them: emitEvent's cap eviction bumps the SERIALIZED dropped*
  // counters, so a previously-ticked dst still holding its old events would, once
  // ticked, hit the cap earlier than a fresh copy. (projectionCopy then replaces
  // dst.events with a copy of src's.)
  dst.events.length = 0;
  // droppedCombatKillCount / droppedStructuralCount are also telemetry-only.
  dst.droppedCombatKillCount = src.droppedCombatKillCount;
  dst.droppedStructuralCount = src.droppedStructuralCount;
  // droppedCommandOverflowCount (#230): transient session counter — intentionally
  // NOT copied to the render double-buffer (nothing reads prevState's value), like
  // events; reset to 0 as a load does (#340).
  dst.droppedCommandOverflowCount = 0;
  // pendingQueenDeathContexts: transient within-tick context, not copied (no render code
  // reads it). #340 — emptied in place (no allocation) as a load does: checkQueenDeath
  // clears only the entries of colonies whose queen died, so a previously-ticked dst can
  // hold a stale entry that would leak into a later queen_death event's payload.
  dst.pendingQueenDeathContexts.length = 0;

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
      d.raidSinceTick = s.raidSinceTick;
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
        raidSinceTick: s.raidSinceTick,
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
    ds.lastHitTick = ss.lastHitTick;
    ds.rampageEntranceId = ss.rampageEntranceId;
    ds.rampageRotationEntranceId = ss.rampageRotationEntranceId;
    ds.rampageRotationTick = ss.rampageRotationTick;
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
  dst.ants.lastMealTick.set(src.ants.lastMealTick);
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
  // Issue #35 — pause counter. Round-trips for SCEN-06 replay determinism
  // (same seed + commands → same pause schedule).
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
  dst.ants.lastHitTick.set(src.ants.lastHitTick);
  dst.ants.attackCooldown.set(src.ants.attackCooldown);
  dst.ants.combatOpponentId.set(src.ants.combatOpponentId);
  // #209 PR A (V34) — flee/shelter phase. Round-trips through the double-buffer
  // so the render prev-frame and SCEN-06 replay see the same flee state as the
  // current frame (-1 not fleeing / 0 dashing / >0 sheltering-until-tick).
  dst.ants.fleeShelterUntilTick.set(src.ants.fleeShelterUntilTick);

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
      fresh.broodFieldDirty = false; // #235
      fresh.killCount = 0;
      fresh.priorityFoodPileId = null;
      fresh.alarmActive = false;
      fresh.raidType = RaidType.Loot;
    }
    const d = dst.colonies[colonyId]!;

    // Scalar fields — direct assignment
    d.colonyId = s.colonyId;
    d.queenEntityId = s.queenEntityId;
    d.poolSlot = s.poolSlot;
    d.workerCount = s.workerCount;
    d.eggCount = s.eggCount;
    d.larvaeCount = s.larvaeCount;
    d.nurseCount = s.nurseCount;
    d.defeated = s.defeated;
    d.reconcileCountdown = s.reconcileCountdown;
    d.killCount = s.killCount;
    d.foodRaidedFp = s.foodRaidedFp;
    d.foodLostToRaidsFp = s.foodLostToRaidsFp;
    d.raidTrips = s.raidTrips;
    d.priorityFoodPileId = s.priorityFoodPileId;
    d.alarmActive = s.alarmActive;
    d.raidType = s.raidType;
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
    // broodFieldDirty (#235) — boolean assignment
    d.broodFieldDirty = s.broodFieldDirty;
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
  // PR 5 — derived goal-field cache: reset (lazily recomputed) rather than
  // sharing the growable Map between two independently-ticked worlds. The BFS
  // scratch queue is reset the same way (the render-snapshot dst never computes
  // goal fields, so it never reallocates; the live sim world keeps its buffer
  // across in-place ticks).
  dst.surfaceGoalFields = null;
  dst.surfaceGoalBfsScratch = null;

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

  // --- #290 PR 2: the food store — TypedArray.set per column (zero allocation),
  // including the derived surfacePileAt index (cheaper to copy than rebuild).
  copyFoodStore(src.food, dst.food);

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
