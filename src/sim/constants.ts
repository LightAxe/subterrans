// constants.ts — Phase 2 PRD §9c balance parameters for src/sim/
//
// All values are numeric literals or plain object literals — no imports, no computed values,
// no float division, no Math.* calls. FP unit comments reference FP_ONE=256 (FP_SHIFT=8)
// from fixed.ts for documentation purposes only; this file is a pure leaf dependency.
//
// To update a balance constant, change the literal here — the test in constants.test.ts
// will catch any drift from the PRD §9c table.

// ---------------------------------------------------------------------------
// Lifecycle ticks (PRD §9c)
// ---------------------------------------------------------------------------

/** PRD §9c — Ticks for an egg to hatch into a larva. */
export const EGG_HATCH_TICKS = 1200;

/** PRD §9c — Ticks for a larva to mature into a worker. */
export const LARVA_MATURE_TICKS = 2400;

/** PRD §9c — Worker lifespan: effectively immortal (INT32_MAX ticks). */
export const WORKER_LIFESPAN_TICKS = 0x7FFFFFFF;

/** PRD §9c — Ticks between queen egg-laying events. */
export const QUEEN_EGG_INTERVAL_TICKS = 300;

/** PRD §9c — Minimum food units (fp) the colony must hold for queen to lay. */
export const QUEEN_EGG_FOOD_THRESHOLD = 768; // 3 × FP_ONE

/**
 * PRD §9c — Ticks an ant can survive with no food before dying.
 *
 * Phase 8.5 stabilization (2026-04-19): raised from 100 → 300 (5s → 15s at
 * 20Hz). While the UI is still being stabilized, the early-game starvation
 * pressure was felt as "the queen keeps dying before I can figure out how to
 * feed her". The PRD (02 §4a, §4c) keeps the 100-tick target for final
 * balance; rebalance back toward it once the interface is trustworthy. Do
 * NOT read this value as load-bearing for the equilibrium formula — it is
 * prototype-stage tuning.
 */
export const STARVATION_GRACE_TICKS = 300;

/** PRD §9c — Ticks between colony-level food reconcile sweeps. */
export const RECONCILE_INTERVAL_TICKS = 100;

/** PRD §9c — Expected ticks for a forager round-trip (used for ratio calc). */
export const FORAGER_ROUND_TRIP_TICKS = 200;

// ---------------------------------------------------------------------------
// Food economy — fixed-point units (PRD §9c)
// FP_ONE = 256; values in comments show the human-readable quantity.
// ---------------------------------------------------------------------------

/** PRD §9c — Food units consumed by the queen per tick. */
export const QUEEN_FOOD_PER_TICK = 2;

/** PRD §9c — Food units consumed by a larva per tick. */
export const LARVA_FOOD_PER_TICK = 1;

/** PRD §9c — Food units consumed by a worker per tick (workers self-forage). */
export const WORKER_FOOD_PER_TICK = 0;

/** PRD §9c — Maximum food units (fp) a worker can carry. 1024 = 4 × FP_ONE. */
export const WORKER_CARRY_CAPACITY = 1024; // 4 × FP_ONE

/** PRD §9c — Food units (fp) picked up per forager visit to a food source. 512 = 2 × FP_ONE. */
export const FOOD_PICKUP_AMOUNT = 512; // 2 × FP_ONE

/** PRD §9c — Maximum food units (fp) in the colony food chamber. 5120 = 20 × FP_ONE. */
export const FOOD_CHAMBER_CAPACITY = 5120; // 20 × FP_ONE

/**
 * Issue #15 follow-up — minimum free space (fp) a FoodStorage chamber must have
 * to be considered an active deposit destination. Chambers with less free space
 * than this are treated as "saturated" — excluded from BFS food-flow seeds AND
 * rejected by the deposit-site test in tickForagerActions / antDepositFood.
 *
 * Why hysteresis: without it, a single QUEEN_FOOD_PER_TICK=2 drain immediately
 * marks the chamber non-full again. The flow-field re-seeds from it, the BFS
 * marks every tile inside the chamber footprint as -1 (source), and any
 * carrier ant standing on one of those tiles (e.g. mid-traversal toward
 * another, truly-empty chamber) gets pinned: movement reads -1 → hold; step
 * 16b deposits 2 fp → chamber full again; queen drains 2 next tick; repeat.
 * Carriers leak their entire load 2 fp at a time into the wrong chamber. See
 * /tmp/stuck-dump.json — seed 1294596103 tick 1876, ants 17/19/22/23.
 *
 * Sized to FOOD_PICKUP_AMOUNT (one pickup-quantum) so a forager arriving with
 * a fresh load is always either fully accepted by the targeted chamber or
 * routed past it. With QUEEN_FOOD_PER_TICK=2 the chamber must be queen-drained
 * for ~256 ticks (~13 s at 20 Hz) after the saturation point before it
 * reappears as a BFS seed — long enough to suppress the per-tick oscillation,
 * short enough that real consumption restores routing without UX-visible lag.
 */
export const FOOD_CHAMBER_DEPOSIT_HYSTERESIS_FP = FOOD_PICKUP_AMOUNT; // 512 fp = 2 × FP_ONE

/**
 * 09 backlog memo — BASE colony storage capacity (fp) before any FoodStorage
 * chamber is built. Small enough that a player must build storage to grow
 * beyond the early colony: sized to roughly cover STARTING_FOOD plus a little
 * foraging headroom. Effective capacity = BASE + N × FOOD_CHAMBER_CAPACITY
 * where N is the count of COMPLETED FoodStorage chambers (pending chambers do
 * not contribute). Tuning intent:
 *   - BASE alone supports queen + a couple larvae during the initial dig.
 *   - 1 FoodStorage chamber supports early growth but not indefinitely.
 *   - 2 FoodStorage chambers are needed to support ~30 ants comfortably.
 * 2048 fp = 8 × FP_ONE. With QUEEN_FOOD_PER_TICK=2, LARVA_FOOD_PER_TICK=1 this
 * is roughly 1024 tick-seconds of buffer for the queen alone — enough to feel
 * survivable without being unlimited.
 */
export const BASE_FOOD_STORAGE_CAPACITY = 2048; // 8 × FP_ONE

/** PRD §9c — Base movement speed of a worker in fixed-point units per tick. 128 = 0.5 × FP_ONE. */
export const WORKER_BASE_SPEED = 128; // 0.5 × FP_ONE

// ---------------------------------------------------------------------------
// Pheromone parameters (PRD §9c / §5)
// ---------------------------------------------------------------------------

/**
 * PRD §9c — Fixed-point decay rate applied to food-trail pheromone per tick.
 * Legacy value (v13 and earlier). 5 / 256 ≈ 1.95% per tick; half-life ~35 ticks.
 */
export const PHEROMONE_DECAY_FP = 5;

/**
 * S0a / issue #119 — V14 food-trail decay rate. 2 / 256 ≈ 0.78% per tick;
 * mathematical half-life ≈ 88 ticks. Trails persist ~2.5× longer than legacy.
 * Used when world.simVersion >= SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX.
 */
export const PHEROMONE_DECAY_FP_V14 = 2;

/** PRD §9c — Fixed-point decay rate applied to danger-trail pheromone per tick. */
export const DANGER_DECAY_FP = 10;

/** PRD §9c — Minimum pheromone value before cell resets to 0 (floor). */
export const PHEROMONE_FLOOR = 64;

/**
 * S0a / issue #119 — V14 pheromone floor. Raised to 128 to match the integer-
 * arithmetic stall point of PHEROMONE_DECAY_FP_V14=2: for s < 128,
 * `(s * 2) >> 8 = 0`, so decay rounds to zero. Without this floor bump the
 * trail would stall at ~127 forever under V14 constants, creating zombie
 * trails. With floor=128, any value that has decayed below 128 snaps to 0
 * immediately on the next decay tick (since `decayed < 128 → snap`).
 * Used when world.simVersion >= SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX.
 */
export const PHEROMONE_FLOOR_V14 = 128;

/** PRD §9c — Maximum pheromone value a cell can hold (cap). */
export const PHEROMONE_CAP = 65280;

/**
 * PRD §9c — Food-trail pheromone deposited per forager step. Legacy value
 * (v13 and earlier). 512 = 2 × FP_ONE.
 */
export const FOOD_TRAIL_DEPOSIT = 512; // 2 × FP_ONE

/**
 * S0a / issue #119 — V14 food-trail deposit per forager step. 1024 = 4 × FP_ONE;
 * doubles the trail strength per step vs legacy. Used when
 * world.simVersion >= SIM_VERSION_V14_PHEROMONE_AND_MOVEMENT_FIX.
 */
export const FOOD_TRAIL_DEPOSIT_V14 = 1024; // 4 × FP_ONE

/** PRD §9c — Percentage of ants that choose random explore over pheromone gradient. */
export const EXPLORE_RATE_PERCENT = 10;

// ---------------------------------------------------------------------------
// Allocation ratios (PRD §9c / §7)
// ---------------------------------------------------------------------------

/** PRD §9c — Ratio of foragers assigned as nurses: 1 nurse per NURSE_RATIO foragers. */
export const NURSE_RATIO = 3;

// ---------------------------------------------------------------------------
// Entity budget (PRD §9c)
// ---------------------------------------------------------------------------

/** PRD §9c — Maximum active entity count in the simulation. */
export const MAX_ENTITIES = 8192;

// ---------------------------------------------------------------------------
// Grid dimensions (PRD §9c)
// ---------------------------------------------------------------------------

/** PRD §9c — Width of the surface pheromone grid in tiles. */
export const SURFACE_GRID_WIDTH = 128;

/** PRD §9c — Height of the surface pheromone grid in tiles. */
export const SURFACE_GRID_HEIGHT = 128;

/** PRD §9c — Width of the underground pheromone grid in tiles. */
export const UNDERGROUND_GRID_WIDTH = 128;

/** PRD §9c — Height of the underground pheromone grid in tiles. */
export const UNDERGROUND_GRID_HEIGHT = 64;

/**
 * Issue #30 — y-coordinate of the underground "ceiling strip." Row 0 of the
 * underground grid renders as the underside of the surface grass (see the
 * `ty === 0` branch in `src/render/draw-underground.ts`); it's a visual cue
 * communicating "this is the surface boundary, not a diggable wall." Both
 * `handleUndergroundLeftClick` and `handleUndergroundDrag` reject clicks on
 * this row so the input gate stays in lockstep with the renderer's
 * ceiling-strip painting.
 */
export const UNDERGROUND_CEILING_ROW_Y = 0;

/**
 * Issue #35 — pause-while-searching cadence.
 *
 * Each tick a SearchingFood ant is walking, we sample the world RNG. If
 * `(rngU32 % SEARCH_PAUSE_TRIGGER_INV_PROB) === 0` the ant pauses for
 * `SEARCH_PAUSE_BASE_TICKS + (rngU32 % SEARCH_PAUSE_JITTER_TICKS)` ticks
 * (mimics the scurry-stop-scurry pattern of real ants).
 *
 * Tuning produces ~12% of total search time paused with these values:
 * trigger probability 1/50 = 2%/tick; pause duration 5-9 ticks (avg 7);
 * time paused ≈ 7 / (50 + 7) ≈ 12%. Inside the ±15% throughput band the
 * feature is gated to.
 */
export const SEARCH_PAUSE_TRIGGER_INV_PROB = 50 as const;
export const SEARCH_PAUSE_BASE_TICKS = 5 as const;
export const SEARCH_PAUSE_JITTER_TICKS = 5 as const;

// ---------------------------------------------------------------------------
// Default behavior ratio (PRD §7, §2)
// ---------------------------------------------------------------------------

/**
 * PRD §7 §2 + Phase 10 amendment (CTRL-01') — Default task distribution: forage 100%, fight 0%.
 * Two roles only (digging is auto-assigned per CTRL-06 — see allocation-system.ts and
 * tick.ts step 10a). Values are integer percentages on a 0–10 scale (10 = 100%).
 */
export const DEFAULT_BEHAVIOR_RATIO = {
  forage: 10,
  fight:  0,
} as const;

// ---------------------------------------------------------------------------
// Phase 7: Excavation & Terrain
// ---------------------------------------------------------------------------

/** Phase 7 PRD §2d — Ticks required to excavate one underground tile. 0.5s at 20 Hz. */
export const DIG_TICKS_PER_TILE = 10;

/** Phase 7 PRD §3 — Number of shaft tiles (tileY=0 and tileY=1) that must be Open for an entrance to open. */
export const ENTRANCE_SHAFT_DEPTH = 2;

/** Phase 7 PRD §3 — Maximum number of entrances a single colony may have. */
export const MAX_ENTRANCES_PER_COLONY = 4;

// ---------------------------------------------------------------------------
// Phase 7: Scenario Generation
// ---------------------------------------------------------------------------

/** Phase 7 PRD §6a — ColonyId for the player's colony. */
export const PLAYER_COLONY_ID = 1;

/** Phase 7 PRD §6a — ColonyId for the enemy colony. */
export const ENEMY_COLONY_ID = 2;

/** Phase 7 PRD §6b — Player colony starting tile X on the surface grid. */
export const PLAYER_START_X = 24;

/** Phase 7 PRD §6b — Player colony starting tile Y on the surface grid. */
export const PLAYER_START_Y = 64;

/** Phase 7 PRD §6b — Enemy colony starting tile X on the surface grid. */
export const ENEMY_START_X = 104;

/** Phase 7 PRD §6b — Enemy colony starting tile Y on the surface grid. */
export const ENEMY_START_Y = 64;

/**
 * Phase 7 PRD §6b — Starting food units (FP) for each colony.
 *
 * Phase 8.5 stabilization (2026-04-19): raised from 500 → 1280 (≈2.0 → 5.0
 * food units) so the queen starts above QUEEN_EGG_FOOD_THRESHOLD (768 FP =
 * 3.0) and can lay her first egg immediately, rather than stalling until
 * workers bring food back. Like STARVATION_GRACE_TICKS, this is prototype-
 * stage tuning to relax early-game pressure while the UI is being
 * stabilized; the PRD (02 §6b) retains the 500 target for final balance.
 */
export const STARTING_FOOD = 1280;

/** Phase 7 PRD §6b — Number of worker ants each colony starts with. */
export const STARTING_WORKERS = 3;

// ---------------------------------------------------------------------------
// Phase 7: Food Pile Scatter
// ---------------------------------------------------------------------------

/** Phase 7 PRD §6a — Total number of food piles placed at world generation. */
export const FOOD_PILE_COUNT = 15;

/** Phase 7 PRD §6a — Minimum Manhattan tile distance between a food pile and any colony start. */
export const FOOD_PILE_MIN_COLONY_DISTANCE = 8;

/** Phase 7 PRD §6a — Minimum Manhattan tile distance between any two food piles. */
export const FOOD_PILE_MIN_SEPARATION = 12;

/** Phase 7 PRD §6a — Maximum placement attempts before giving up on a food pile. */
export const FOOD_PILE_MAX_ATTEMPTS = 1000;

// ---------------------------------------------------------------------------
// Issue #112 — Food pile depletion + respawn (strategic survival mechanic)
// ---------------------------------------------------------------------------

/**
 * Issue #112 — Lower bound for the number of pickup-charges a freshly-spawned
 * (or scenario-seeded) food pile carries. Each successful `antPickupFood` call
 * decrements `pickupsRemaining` by `FOOD_PILE_PICKUP_DRAIN`; pile vanishes at 0.
 *
 * Pickup-charges are NOT the same as fixed-point food units transferred to the
 * ant — that quantity stays bound to FOOD_PICKUP_AMOUNT. Charges control pile
 * longevity (a balance lever); food carry stays the existing per-ant mechanic.
 *
 * Initial pickups balance: a small ephemeral pile (~20 charges) drains in a
 * dozen seconds of focused foraging; a strategic anchor (~150) lasts much
 * longer. Default values are best-guesses pending playtest retune.
 */
export const FOOD_PILE_INITIAL_PICKUPS_MIN = 20;

/** Issue #112 — Upper bound for initial pickup-charges on a food pile. */
export const FOOD_PILE_INITIAL_PICKUPS_MAX = 150;

/**
 * Issue #112 — Charges drained from `pile.pickupsRemaining` per successful
 * `antPickupFood` call. Default is 1 (one pickup = one charge consumed).
 */
export const FOOD_PILE_PICKUP_DRAIN = 1;

/**
 * Issue #112 — Spawn cadence: every N ticks, `tickFoodPileSpawn` attempts to
 * place one new pile somewhere on the surface. 1800 ticks ≈ 90 seconds at
 * 20Hz — midpoint of the 1–2 minute "respawn feel" target locked in the
 * issue planning thread.
 */
export const FOOD_PILE_SPAWN_INTERVAL_TICKS = 1800;

/**
 * Issue #112 — Soft ceiling on `world.foodPiles.length`. When at-or-above
 * this, the spawn step skips silently. Sits at FOOD_PILE_COUNT × 2 = 30,
 * comfortably under the validator hard cap MAX_FOOD_PILES = 60 (issue #109).
 */
export const FOOD_PILE_SOFT_CEILING = FOOD_PILE_COUNT * 2;

/**
 * Issue #112 — Spawn-placement anti-teleport guard. Reject candidate tiles
 * within FOOD_PILE_MIN_SEPARATION Manhattan tiles of any pile that depleted
 * in the last N ticks. Set equal to one spawn cycle so a depletion event has
 * a full cycle to drain pheromone trails before a replacement may appear in
 * the same neighborhood.
 */
export const FOOD_PILE_RECENT_DEPLETION_TICKS = FOOD_PILE_SPAWN_INTERVAL_TICKS;

/**
 * Issue #112 — Terrain-weighted placement. Grass tiles are accepted with
 * weight `GRASS`; non-grass passable tiles with weight `OTHER`. Implemented
 * via a single `nextU32() % (GRASS+OTHER) < OTHER` reject-roll: grass is
 * always accepted, non-grass is accepted with probability OTHER/(GRASS+OTHER).
 *
 * 4:1 default biases new piles toward vegetation ("food grows where vegetation
 * is") without making bare tiles impossible.
 */
export const FOOD_PILE_TERRAIN_GRASS_WEIGHT = 4;

/** Issue #112 — Non-grass placement weight (see FOOD_PILE_TERRAIN_GRASS_WEIGHT). */
export const FOOD_PILE_TERRAIN_OTHER_WEIGHT = 1;

// ---------------------------------------------------------------------------
// Phase 7: Surface Scatter
// ---------------------------------------------------------------------------

/** Phase 7 PRD §6a — Dirt coverage ratio in 1/256 units (~15% = 38/256). */
export const DIRT_SCATTER_RATIO_FP = 38;

// ---------------------------------------------------------------------------
// Phase 7: Chamber dimension constants (canonical values also in chamber.ts CHAMBER_DIMENSIONS)
// ---------------------------------------------------------------------------

/** Phase 7 PRD §2d — Queen chamber tile width. */
export const CHAMBER_QUEEN_WIDTH = 5;

/** Phase 7 PRD §2d — Queen chamber tile height. */
export const CHAMBER_QUEEN_HEIGHT = 3;

/** Phase 7 PRD §2d — Nursery chamber tile width. */
export const CHAMBER_NURSERY_WIDTH = 4;

/** Phase 7 PRD §2d — Nursery chamber tile height. */
export const CHAMBER_NURSERY_HEIGHT = 3;

/** Phase 7 PRD §2d — FoodStorage chamber tile width. */
export const CHAMBER_FOOD_WIDTH = 4;

/** Phase 7 PRD §2d — FoodStorage chamber tile height. */
export const CHAMBER_FOOD_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Phase 9 SearchingFood leash (09 digger-reassignment memo)
// ---------------------------------------------------------------------------

/**
 * Soft-leash radii for SearchingFood foragers, indexed by AntComponents.searchWave.
 * When a surface SearchingFood ant's Manhattan distance from its nearest own-colony
 * entrance exceeds its wave's radius, it is demoted to Idle (step 10a re-entry)
 * and its wave index increments (capped at SEARCH_LEASH_MAX_WAVE). On a successful
 * food pickup the wave resets to 0. Values per the memo's acceptable design:
 * base 25 → 40 → 55 → 70. Kept per-ant, not colony-memory.
 *
 * 09 excursion-foraging memo tuning (2026-04-20): the initial baseline radii
 * [25, 30, 35, 40] yielded 93% queen survival across 200 seeds × 2000 ticks —
 * 2pp below the ≥95% acceptance target. Widening the late-wave radii (base
 * wave 0 unchanged at 25 — same first-leash behaviour — while later waves
 * reach further) lets foragers who exhausted nearby search cones reach more
 * distant food piles before starvation. Base wave preserved because the
 * 09 digger-reassignment memo balances digger↔forager reassignment around it.
 */
export const SEARCH_LEASH_RADII: readonly number[] = [25, 40, 55, 70];

/** Highest valid index into SEARCH_LEASH_RADII. */
export const SEARCH_LEASH_MAX_WAVE = SEARCH_LEASH_RADII.length - 1;

/**
 * Issue #44 UAT round 3 — leash-boundary hysteresis margin (tiles).
 *
 * tickExcursionBoundary's ReturningToNest→SearchingFood breakout requires
 * the ant to be at Manhattan distance ≤ `SEARCH_LEASH_RADII[wave] −
 * LEASH_HYSTERESIS_TILES` from its nearest entrance before a food signal
 * (priority/scent/pheromone) can flip it back. The outbound flip
 * (SearchingFood → ReturningToNest) keeps its existing `dist > radius`
 * threshold — only the inbound side gets the deadband.
 *
 * Without this margin, an ant parked just outside its wave radius with
 * a steady pheromone signal nearby flip-flops between the two sub-states
 * every tick. Each flip clears the issue-#42 recent-tiles ring buffer,
 * so the no-revisit memory never accumulates and the ant cycles in a
 * 4-tile region indefinitely (observed in the seed=1806015051 tick=5863
 * snapshot, ant 24 at tile (112, 43), entrance at (104, 64),
 * Manhattan distance = 29 vs wave-0 radius 25).
 *
 * Five tiles is large enough to force several ticks of homeward
 * progress between flips — long enough for the recent-tiles buffer to
 * accumulate useful history when the ant later resumes searching —
 * while staying well inside the smallest leash radius (25), so
 * foragers within wave 0 still have a meaningful "deep" zone where
 * signals can promote them.
 *
 * Player-marked priority targets (`colony.priorityFoodPileId`) bypass
 * the deadband — explicit user intent always wins. The hysteresis
 * only suppresses ambient scent/pheromone signals.
 *
 * Gated on `world.simVersion >= SIM_VERSION_V8_LEASH_HYSTERESIS`. Must
 * remain strictly less than `SEARCH_LEASH_RADII[0]` (= 25) — otherwise
 * the v8 deadband threshold (`radius - LEASH_HYSTERESIS_TILES`) would
 * be ≤ 0, permanently suppressing the breakout for any wave-0 ant.
 * See `constants.test.ts` for the invariant.
 */
export const LEASH_HYSTERESIS_TILES = 5;

// ---------------------------------------------------------------------------
// Phase 9 excursion foraging memo — correlated outward walk constants
// ---------------------------------------------------------------------------

/**
 * Minimum ticks a SearchingFood forager commits to its current heading before
 * a turn check is rolled. With WORKER_BASE_SPEED = 128 (0.5 tile/tick), this
 * is roughly 4 tiles of motion — enough to feel like a coherent outbound arc
 * while still varying over a 25-tile excursion leash.
 */
export const EXCURSION_HEADING_MIN_TICKS = 8;

/**
 * Extra ticks (plus the minimum above) the forager may hold the same heading
 * before the next turn check. The full run length is
 * EXCURSION_HEADING_MIN_TICKS + rng.nextInt(EXCURSION_HEADING_JITTER_TICKS).
 */
export const EXCURSION_HEADING_JITTER_TICKS = 8;

/**
 * Probability (percentage) that a scheduled turn-check actually rotates the
 * heading by 90°. The remaining probability keeps the current heading — the
 * memo's "mostly maintain a heading, occasionally turn left or right".
 */
export const EXCURSION_TURN_PERCENT = 25;

/**
 * 09 excursion-foraging follow-up — subtle lateral wobble percent.
 *
 * At a scheduled turn-check, this is the chance that the ant emits a single
 * perpendicular (lateral) step while KEEPING its internal heading unchanged.
 * The next tick resumes along the committed heading, so the net effect is a
 * small sideways jog rather than a new direction — breaking up the visibly
 * "cardinal straight-line" feel without regressing into random walk.
 *
 * Non-overlapping with EXCURSION_TURN_PERCENT: at a turn-check, the turnRoll
 * in [0, EXCURSION_TURN_PERCENT) triggers a hard 90° turn; the turnRoll in
 * [100 - EXCURSION_WOBBLE_PERCENT, 100) triggers a one-tick wobble step.
 * These ranges must not overlap — enforcement is in chooseExcursionDirection.
 */
export const EXCURSION_WOBBLE_PERCENT = 20;

// ---------------------------------------------------------------------------
// Phase 9 excursion-foraging follow-up — entrance-side pheromone suppression
// ---------------------------------------------------------------------------

/**
 * 09 excursion-foraging follow-up — radius (Manhattan tiles) within which a
 * food-carrying ant's own entrance prevents a food-trail deposit.
 *
 * Observed issue: carrying ants repeatedly passing the same few tiles near
 * an entrance create a scalar local-peak that greedy gradient-following turns
 * into a two-tile oscillation — an outbound searching ant sees the highest
 * neighbor "behind" them near the nest and reverses into it. Suppressing
 * deposits within a small radius of the entrance keeps the trail's peak out
 * past the search-bootstrap zone, so outbound foragers aren't yanked back.
 *
 * Radius 3 eliminates the local peak at the entrance mouth while leaving the
 * meaningful outbound trail (4+ tiles out, along the path toward food) intact.
 */
export const ENTRANCE_DEPOSIT_SUPPRESS_RADIUS = 3;


// ---------------------------------------------------------------------------
// S1 — Combat math (HP / damage / cooldown)
// ---------------------------------------------------------------------------

/** S1 / D-32 — Base HP for any ant. Home-ground HP = HP_BASE + HP_HOMEGROUND_BONUS = 20. */
export const COMBAT_HP_BASE = 16 as const;

/** S1 / D-32 — Extra HP buffer for ants fighting on their own colony's grid.
 *  Depletes before the base HP pool (takes damage first). */
export const COMBAT_HP_HOMEGROUND_BONUS = 4 as const;

/** S1 / D-32 — Damage dealt per strike by an ant fighting on away ground. */
export const COMBAT_DAMAGE_BASE = 4 as const;

/** S1 / D-32 — Damage dealt per strike by an ant fighting on home ground (+25%, integer-clean). */
export const COMBAT_DAMAGE_HOMEGROUND = 5 as const;

/** S1 / D-32 — Ticks between strikes; also the windup length (first contested tick). */
export const COMBAT_COOLDOWN_TICKS = 5 as const;

// ---------------------------------------------------------------------------
// S1 follow-up — Fighter aggression radius + non-fighter combat stats
// ---------------------------------------------------------------------------

/** Manhattan tile radius within which a surface fighter scans for enemy ants before
 *  falling back to rally-point routing. Phase 4 PRD §3d. */
export const FIGHT_AGGRO_RADIUS = 4 as const;

/** Damage dealt per strike by a non-fighter ant (worker / forager / nurse) defending itself.
 *  25% of COMBAT_DAMAGE_BASE — non-fighters can fight back but weakly. */
export const COMBAT_DAMAGE_WORKER = 1 as const;

/** Damage dealt per strike by the queen ant. High value makes the queen dangerous to
 *  engage directly — it takes multiple fighters to bring her down.
 *  Flagged TBD: queen damage/HP may be tuned in S6-Tune once playtrace data exists. */
export const COMBAT_DAMAGE_QUEEN = 6 as const;

/** Base HP for the queen. Higher than workers so it takes a coordinated group of fighters
 *  to kill her. Flagged TBD for S6-Tune. */
export const COMBAT_HP_QUEEN = 30 as const;

// ---------------------------------------------------------------------------
// S2 — AI State Machine (D-20 / D-27 / D-29 / D-34)
// ---------------------------------------------------------------------------

/**
 * S2 / D-34 — Minimum round age (ticks) before AI can enter WarFooting on age alone.
 * 2400 ticks = 120s at 20Hz. The AI also has a frontage trigger (see
 * AI_FRONTAGE_PLAYER_WORKERS_ABS) that can fire before this tick.
 */
export const AI_WARFOOTING_MIN_TICK = 2400 as const;

/**
 * S2 / D-27 — Ticks between probe attempts while in WarFooting state.
 * 1800 ticks = 90s at 20Hz. Second probe ~4:30 given first at ~3:30.
 */
export const AI_PROBE_INTERVAL_TICKS = 1800 as const;

/**
 * S2 / D-27 — Number of fighters committed to a probe cohort.
 * Closest 3 alive AI fighters by ascending ant index.
 */
export const AI_PROBE_FIGHTER_COUNT = 3 as const;

/**
 * S2 / D-27 — Timeout after which a probe automatically ends if the cohort
 * hasn't completed normally. 600 ticks = 30s at 20Hz.
 */
export const AI_PROBE_TIMEOUT_TICKS = 600 as const;

/**
 * S2 / D-34 / QC Pass 4 AI1 — Minimum round age for full invasion.
 * 6600 ticks = 330s = 5:30 at 20Hz. Locks first Invading to the 5:30–6:30 arc.
 */
export const AI_INVADING_MIN_TICK = 6600 as const;

/**
 * S2 — Invasion timeout: max ticks an invasion can run before auto-ending.
 * 1800 ticks = 90s at 20Hz.
 */
export const AI_INVADING_TIMEOUT_TICKS = 1800 as const;

/**
 * S2 — Recovery duration after an invasion ends, indexed [Easy, Normal, Hard].
 * S2 reads only index NORMAL_TIER_INDEX=1. S5 wires the tier selector at V20.
 * 1200 ticks = 60s at 20Hz.
 */
export const AI_RECOVERY_DURATION_TICKS = [1200, 1200, 1200] as const;

/**
 * S2 / D-29 / CF-P1-010 — Fighter count threshold for WarFooting entry,
 * indexed [Easy, Normal, Hard]. S2 reads only NORMAL_TIER_INDEX=1.
 */
export const AI_WARFOOTING_FIGHTER_THRESHOLD = [10, 8, 6] as const;

/**
 * S2 — Fighter count threshold for Invading entry, indexed [Easy, Normal, Hard].
 * S2 reads only NORMAL_TIER_INDEX=1.
 */
export const AI_INVADING_FIGHTER_THRESHOLD = [18, 15, 12] as const;

/**
 * S2 / CF-P1-010 — Food storage minimum for WarFooting entry (integer percent, ×100 safe).
 * Usage: `aiFoodStored * 100 >= aiFoodCapacity * AI_WARFOOTING_FOOD_FRAC_PCT`
 */
export const AI_WARFOOTING_FOOD_FRAC_PCT = 50 as const;

/**
 * S2 — Food storage minimum for Invading entry (integer percent, ×100 safe).
 * Usage: `aiFoodStored * 100 >= aiFoodCapacity * AI_INVADING_FOOD_FRAC_PCT`
 */
export const AI_INVADING_FOOD_FRAC_PCT = 70 as const;

/**
 * S2 / D-29 — Absolute floor for the hybrid frontage trigger: player workers >= 24
 * AND player workers >= 1.3× AI workers triggers WarFooting regardless of age.
 */
export const AI_FRONTAGE_PLAYER_WORKERS_ABS = 24 as const;

/**
 * S2 / D-29 — Ratio multiplier (×100) for the hybrid frontage trigger.
 * Usage: `playerWorkers * 100 >= AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100 * aiWorkers`
 * Integer-safe; avoids float division. 130 → 1.3× threshold.
 */
export const AI_FRONTAGE_PLAYER_WORKERS_RATIO_X100 = 130 as const;

/**
 * S2 / CF-P0-005 — Fixed-length buffer size for committed fighter cohort.
 * `AIStateRecord.operationFighterIds` is always this length; unused slots are -1.
 */
export const AI_MAX_OPERATION_FIGHTERS = 32 as const;

/**
 * S2 — Fallback radius (tiles) for probe target selection when no marked food pile
 * exists. Picks closest unmarked surface pile within this distance of any open
 * player entrance.
 */
export const AI_PROBE_FALLBACK_RADIUS_TILES = 40 as const;
