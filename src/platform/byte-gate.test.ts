// src/platform/byte-gate.test.ts
// Cross-build byte-identical gate for the #212 ant-system.ts split (PLAN.md §B).
//
// Lives in platform/ (NOT sim/) because the sacred sim→platform import boundary
// forbids a sim/ file from importing the full save serializer; platform→sim is
// allowed, so here we get BOTH createScenario/tick AND (via world-hash.ts) the
// save.ts serializer used by hashWorldState.
//
// NOT a normal-suite test: env-gated, SKIPS unless BYTE_GATE_MODE is set, so
// `npm run verify` stays green and no golden hash is committed (PLAN.md D2 — a
// permanent golden would fire on every legitimate future behavior change).
//
//   Capture the baseline ON THE PRE-SPLIT TREE, BEFORE any split edit:
//     BYTE_GATE_MODE=capture BYTE_GATE_FILE=/abs/baseline.json \
//       npx vitest run src/platform/byte-gate.test.ts
//   Verify the split reproduces it (on the split branch):
//     BYTE_GATE_MODE=verify  BYTE_GATE_FILE=/abs/baseline.json \
//       npx vitest run src/platform/byte-gate.test.ts
//   A version-gated change: add BYTE_GATE_SIM_VERSION=<base LATEST> to the verify
//   run (and optionally the capture) to pin every scenario to the pre-gate version.
//   Pre-1.0 there are no version-gated changes (AGENTS.md "simVersion and saves"),
//   so this pin is not used for new work. Once MIN === LATEST it accepts only LATEST.
//   It stays for the post-1.0 window. Behaviour-preserving refactors, gate reaping
//   included, still use plain capture/verify.
//
// Proof obligation: same scenarios ⇒ byte-identical serialized WorldState (incl.
// rngState — the RNG-pull-reorder detector) at every checkpoint and at the end.
//
// #290 — BYTE_GATE_PROJECTION=1 hashes the food-equivalence projection
// (`food-projection.ts`: the snapshot minus food-storage-shaped keys, plus the food
// state read through the facade) instead of the raw snapshot. Use it when a PR
// changes the food storage SHAPE but must keep behaviour: capture with
// BYTE_GATE_PROJECTION=1 on the base commit, verify with it on the branch. A
// baseline captured in one mode cannot be verified in the other.
//
// #408 — BYTE_GATE_SWEEP=1 adds a both-AI sweep (8 seeds × 12 000 ticks across the
// three difficulties) and a raid-type cycle (8 000 ticks) to the six scenarios: use it
// for a gate reap, or a refactor of raids or raid orders. It also runs both AIs, the
// colony alarm, spider priority, shelterers and rampages, but check RULE-COVERAGE
// before leaning on it for another rule: AI nest defence, alarm recruitment and rampage
// shelter have no counter of their own. The flag is stored in the baseline, so capture
// and verify must both set it. BYTE_GATE_COVERAGE=1 also prints a RULE-COVERAGE line
// per scenario (raid food taken and spoiled per colony, raid type and 1000-tick window,
// blockade, shelterers, rampages, the rotation cursor, queen deaths) to show a sweep is
// not vacuous. Run with `--reporter=dot` (or verbose) to see the per-scenario lines.
// Not covered: the spider's entrance rotation (V54) fires only on a rampage that times
// out with no kill, which none of these scenarios reach (rotationCursorSets is 0), so a
// change to it needs its own non-vacuity check.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import { hashWorldState } from './world-hash.js';
import { hashFoodProjection, hungerProjection } from './food-projection.js';
import type { WorldState } from '../sim/types.js';
import { allocateEntityId, LATEST_SIM_VERSION } from '../sim/types.js';
import { MIN_ACCEPTED_SIM_VERSION } from './save.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  STARVATION_GRACE_TICKS,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
  CORPSE_PICKUPS_FIGHTER,
  CORPSE_PICKUPS_QUEEN,
  CORPSE_PICKUPS_SPIDER,
  CORPSE_PICKUPS_WORKER,
  FOOD_PICKUP_AMOUNT,
} from '../sim/constants.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { AntTask, ChamberType, FightingSubState, RaidType } from '../sim/enums.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { runAIController } from '../render/ai-controller.js';
import { createDefaultAIStateRecord, getAIStateForColony } from '../sim/ai-state.js';
import { blockadedEntrance, rallyEnemyEntrance } from '../sim/raid-order.js';
import {
  chamberStock,
  colonyPoolFood,
  pileAmountFp,
  pileCount,
  pileFoodId,
  pileInitialFp,
  pileIsCorpse,
  pileSlotAt,
  pileTileX,
  pileTileY,
} from '../sim/food/food-api.js';
import { setColonyFoodForTest } from '../sim/food/food-test-utils.js';

/** Initial size (fp) of a freshly dropped corpse pile, one per corpse kind. */
const FRESH_CORPSE_PILE_FP: ReadonlySet<number> = new Set(
  [CORPSE_PICKUPS_WORKER, CORPSE_PICKUPS_FIGHTER, CORPSE_PICKUPS_QUEEN, CORPSE_PICKUPS_SPIDER].map(
    (n) => n * FOOD_PICKUP_AMOUNT,
  ),
);

const MODE = process.env.BYTE_GATE_MODE; // 'capture' | 'verify' | undefined
const FILE = process.env.BYTE_GATE_FILE ?? '';
const CHECKPOINT_EVERY = 25; // hash cadence for first-divergence localization
const PC = PLAYER_COLONY_ID as ColonyId;
const EC = ENEMY_COLONY_ID as ColonyId;
const COVERAGE = process.env.BYTE_GATE_COVERAGE === '1';
const PROJECTION = process.env.BYTE_GATE_PROJECTION === '1';
// #370 — BYTE_GATE_SIM_VERSION=N pins every scenario world to simVersion N, so a PR
// that adds a version gate can prove the pre-gate path byte-identical: capture on
// the base commit (where N is LATEST), verify on the branch with the same N. Since
// #395 the world is created at N (createScenario's simVersion), not created at
// LATEST and re-stamped, because map generation is version-gated too.
const PIN_SIM_VERSION = parsePinnedSimVersion(process.env.BYTE_GATE_SIM_VERSION);

/** A malformed pin must fail loudly: NaN would turn every `simVersion >=` gate off on
 *  BOTH sides and let the proof pass vacuously. */
function parsePinnedSimVersion(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (
    raw.trim() === '' ||
    !Number.isInteger(n) ||
    n < MIN_ACCEPTED_SIM_VERSION ||
    n > LATEST_SIM_VERSION
  ) {
    throw new Error(
      `BYTE_GATE_SIM_VERSION=${raw} is not a simVersion in ` +
        `[${MIN_ACCEPTED_SIM_VERSION}, ${LATEST_SIM_VERSION}]`,
    );
  }
  return n;
}
const hashFor: (world: WorldState) => string = PROJECTION ? hashFoodProjection : hashWorldState;

// #229 — fnv1a + hashWorldState moved to world-hash.ts (shared with the
// cross-engine determinism proof); imported above.

// Fixed command schedule: dig downward (diggers + descent toward the enemy grid →
// underground movement + invader/combat paths) and pivot the fight ratio — exercises
// the moved movement / dig / combat-targeting / queen clusters beyond passive
// foraging+nursing. Deterministic; no Math.random / wall-clock.
function digFightScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 2, issuedAtTick: 0 }];
  c[5] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 6, issuedAtTick: 5 }];
  c[10] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 24, tileY: 12, issuedAtTick: 10 }];
  c[20] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 30, tileY: 18, issuedAtTick: 20 }];
  c[40] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 5, fight: 5 }, issuedAtTick: 40 },
  ];
  c[200] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 2, fight: 8 }, issuedAtTick: 200 },
  ];
  c[600] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 8, fight: 2 }, issuedAtTick: 600 },
  ];
  return c;
}

function markDigScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 10, tileY: 5, issuedAtTick: 0 }];
  c[10] = [{ type: 'MarkDigTile', colonyId: PC, tileX: 15, tileY: 8, issuedAtTick: 10 }];
  c[30] = [{ type: 'CancelDigMark', colonyId: PC, tileX: 10, tileY: 5, issuedAtTick: 30 }];
  c[50] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 0, fight: 10 }, issuedAtTick: 50 },
  ];
  return c;
}

interface Scenario {
  name: string;
  seed: number;
  difficulty: 'Easy' | 'Normal' | 'Hard';
  ticks: number;
  commands: SimCommand[][];
  /** Deterministic pre-tick-0 world edits (food writes only through the facade / test utils). */
  setup?: (world: WorldState) => void;
  /** Extra commands for tick `t`, computed from the world (AI controllers + scripted player). */
  driver?: (world: WorldState, t: number) => SimCommand[];
}

// ---------------------------------------------------------------------------
// #290 — food-heavy scenarios. The four scenarios above never touch food storage
// in an interesting way (no FoodStorage chamber, no depletion, no corpse pile,
// pools pinned at cap), so they cannot prove a food-storage swap. These two drive
// both colonies with the real AI controller plus a scripted player, and read the
// world ONLY through the food facade, so the identical driver runs on both sides
// of the PR 2 storage swap. BYTE_GATE_COVERAGE=1 prints what each one exercised.
// ---------------------------------------------------------------------------

/** Player FoodStorage chambers flanking the pre-dug entrance shaft (column 24). */
const FS_ANCHORS: ReadonlyArray<[number, number]> = [
  [25, 1],
  [20, 1],
];

/** Tile of the live natural pile with the fewest pickups left, or null. */
function smallestNaturalPile(world: WorldState): { x: number; y: number; id: number } | null {
  let best = -1;
  for (let o = 0; o < pileCount(world); o++) {
    const s = pileSlotAt(world, o);
    if (pileIsCorpse(world, s)) continue;
    if (best < 0 || pileAmountFp(world, s) < pileAmountFp(world, best)) best = s;
  }
  if (best < 0) return null;
  return { x: pileTileX(world, best), y: pileTileY(world, best), id: pileFoodId(world, best) };
}

/**
 * Both colonies AI-driven (the player's AI until tick 4000, so it builds Queen +
 * Nursery and lays eggs), plus a scripted player:
 *  - two extra FoodStorage chambers at tick 1-2 (fullest-first withdraw across chambers);
 *  - every 250 ticks, MarkFoodPile the smallest natural pile. Foragers empty the
 *    marked pile and the depletion clears the mark (sc7: ticks ~3196 and ~6701;
 *    sc4: ~3337 — BYTE_GATE_COVERAGE's `markedPileDepletions`); the next 250-tick
 *    boundary marks a new one;
 *  - fight-heavy ratio at 2400, then all-fight at 4500 (food shortage: pool drawn
 *    below cap, queen and larvae go hungry);
 *  - rally on the enemy's entrance at 2600 and 5200, cleared at 4400 (surface and
 *    underground combat → corpse piles).
 */
function foodDriver(world: WorldState, t: number): SimCommand[] {
  runAIController(world, EC);
  if (t < 4000) runAIController(world, PC);
  const out: SimCommand[] = [];
  const at = t;
  if (t === 1 || t === 2) {
    const [ax, ay] = FS_ANCHORS[t - 1]!;
    out.push({
      type: 'PlaceChamber',
      colonyId: PC,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: ax,
      anchorTileY: ay,
      issuedAtTick: at,
    });
  }
  if (t > 0 && t % 250 === 0) {
    const pile = smallestNaturalPile(world);
    if (pile !== null && world.colonies[PC]!.priorityFoodPileId !== pile.id) {
      out.push({
        type: 'MarkFoodPile',
        colonyId: PC,
        tileX: pile.x,
        tileY: pile.y,
        issuedAtTick: at,
      });
    }
  }
  const en = world.colonies[EC]?.entrances.find((e) => e.isOpen);
  if (en !== undefined && (t === 2600 || t === 5200)) {
    out.push({
      type: 'SetRallyPoint',
      colonyId: PC,
      tileX: en.surfaceTileX,
      tileY: en.surfaceTileY,
      issuedAtTick: at,
    });
  }
  if (t === 4400) out.push({ type: 'ClearRallyPoint', colonyId: PC, issuedAtTick: at });
  if (t === 2400) {
    out.push({
      type: 'SetBehaviorRatio',
      colonyId: PC,
      ratio: { forage: 3, fight: 7 },
      issuedAtTick: at,
    });
  }
  if (t === 4500) {
    out.push({
      type: 'SetBehaviorRatio',
      colonyId: PC,
      ratio: { forage: 0, fight: 10 },
      issuedAtTick: at,
    });
  }
  for (const c of world.commandQueue.splice(0)) out.push(c);
  return out;
}

/**
 * Skirmish setup: 6 fighters per colony on the natural pile nearest the map's
 * middle column (combat deaths top up that pile, and corpse piles top up each
 * other), and the enemy pool set over its cap (the reconcile clamp trims it).
 */
function skirmishSetup(world: WorldState): void {
  let best = -1;
  for (let o = 0; o < pileCount(world); o++) {
    const s = pileSlotAt(world, o);
    if (best < 0 || Math.abs(pileTileX(world, s) - 64) < Math.abs(pileTileX(world, best) - 64)) {
      best = s;
    }
  }
  const x = pileTileX(world, best);
  const y = pileTileY(world, best);
  for (const cid of [PC, EC]) {
    const colony = world.colonies[cid]!;
    for (let i = 0; i < 6; i++) {
      const id = allocateEntityId(world);
      initAnt(world.ants, id, {
        colonyId: cid,
        posX: (x << FP_SHIFT) + (FP_ONE >> 1),
        posY: (y << FP_SHIFT) + (FP_ONE >> 1),
        task: AntTask.Fighting,
        subTask: 0,
        speed: WORKER_BASE_SPEED,
        zone: Zone.Surface,
        lifespan: WORKER_LIFESPAN_TICKS,
      });
      colony.workers.push(id);
      colony.workerCount += 1;
    }
  }
  setColonyFoodForTest(world, world.colonies[EC]!, 6000);
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'sc42-normal-2000-digfight',
    seed: 42,
    difficulty: 'Normal',
    ticks: 2000,
    commands: digFightScript(),
  },
  {
    name: 'sc99-hard-2000-digfight',
    seed: 99,
    difficulty: 'Hard',
    ticks: 2000,
    commands: digFightScript(),
  },
  {
    name: 'sc7777-normal-1500-passive',
    seed: 7777,
    difficulty: 'Normal',
    ticks: 1500,
    commands: [],
  },
  {
    name: 'sc42-normal-150-markdig',
    seed: 42,
    difficulty: 'Normal',
    ticks: 150,
    commands: markDigScript(),
  },
  {
    name: 'sc7-normal-8000-food-economy',
    seed: 7,
    difficulty: 'Normal',
    ticks: 8000,
    commands: [],
    driver: foodDriver,
  },
  {
    name: 'sc4-normal-5000-food-skirmish',
    seed: 4,
    difficulty: 'Normal',
    ticks: 5000,
    commands: [],
    setup: skirmishSetup,
    driver: foodDriver,
  },
];

// ---------------------------------------------------------------------------
// #408 — BYTE_GATE_SWEEP=1 adds a both-AI sweep and a raid-type cycle to the six
// scenarios above. The six barely run raids and raid orders, so a reap of those is
// proven on these too. They also drive both AIs, the colony alarm, spider priority
// and the spider's rampages; the spider's entrance rotation is not reached (see the
// header). The flag is stored in the baseline like the hash mode: a baseline
// captured with it cannot be verified without it, or the other way round.
// ---------------------------------------------------------------------------
const SWEEP = process.env.BYTE_GATE_SWEEP === '1';

/** Offsets from the first entrance tried for a second one, one per attempt. */
const SECOND_ENTRANCE_OFFSETS: ReadonlyArray<[number, number]> = [
  [10, 0],
  [-10, 0],
  [0, 10],
  [0, -10],
  [10, 10],
  [-10, 10],
  [10, -10],
  [-10, -10],
  [14, 0],
  [-14, 0],
  [0, 14],
  [0, -14],
];

/** The player's DesignateEntrance attempt `n` at a second entrance, or null once it has one. */
function secondEntrance(world: WorldState, n: number, at: number): SimCommand | null {
  const ents = world.colonies[PC]!.entrances;
  if (ents.length !== 1) return null;
  const [dx, dy] = SECOND_ENTRANCE_OFFSETS[n % SECOND_ENTRANCE_OFFSETS.length]!;
  return {
    type: 'DesignateEntrance',
    colonyId: PC,
    surfaceTileX: ents[0]!.surfaceTileX + dx,
    surfaceTileY: ents[0]!.surfaceTileY + dy,
    issuedAtTick: at,
  };
}

/** The enemy's first open entrance tile, or null. */
function enemyEntranceTile(world: WorldState): { x: number; y: number } | null {
  const en = world.colonies[EC]?.entrances.find((e) => e.isOpen);
  return en === undefined ? null : { x: en.surfaceTileX, y: en.surfaceTileY };
}

/** The player colony gets an AI state record, so its AI can go to war and raid
 *  (createScenario gives one to the enemy only; check-ai-economy --both-ai does the same). */
function bothAiSetup(world: WorldState): void {
  if (getAIStateForColony(world, PC) === null) world.aiState.push(createDefaultAIStateRecord(PC));
}

/** The player's AI drives it inside these windows; the scripted player owns it outside. */
function playerAiOn(t: number): boolean {
  return t < 5000 || (t >= 8000 && t < 10500);
}

/** The scripted player's ratio swings (all outside the player-AI windows). */
const SWEEP_RATIOS: ReadonlyMap<number, { forage: number; fight: number }> = new Map([
  [5000, { forage: 3, fight: 7 }],
  [6300, { forage: 8, fight: 2 }],
  [7200, { forage: 0, fight: 10 }],
  [10500, { forage: 5, fight: 5 }],
  [11200, { forage: 9, fight: 1 }],
]);

/**
 * Both colonies AI-driven, plus a scripted player:
 *  - a second player entrance (attempts from tick 600), so the spider has a door
 *    to rotate to;
 *  - MarkSpiderPriority on and off, twice;
 *  - SetColonyAlarm on and off, twice;
 *  - ratio swings and a Loot rally on the enemy's entrance while the player's AI
 *    is off (it re-syncs the ratio every tick it runs).
 */
function sweepDriver(world: WorldState, t: number): SimCommand[] {
  runAIController(world, EC);
  if (playerAiOn(t)) runAIController(world, PC);
  const out: SimCommand[] = [];
  const at = t;
  if (t >= 600 && t <= 3000 && t % 50 === 0) {
    const cmd = secondEntrance(world, (t - 600) / 50, at);
    if (cmd !== null) out.push(cmd);
  }
  if (t === 3500 || t === 9000) {
    out.push({ type: 'MarkSpiderPriority', colonyId: PC, isPriority: true, issuedAtTick: at });
  }
  if (t === 4500 || t === 9800) {
    out.push({ type: 'MarkSpiderPriority', colonyId: PC, isPriority: false, issuedAtTick: at });
  }
  if (t === 5500 || t === 10600) {
    out.push({ type: 'SetColonyAlarm', colonyId: PC, active: true, issuedAtTick: at });
  }
  if (t === 6200 || t === 11000) {
    out.push({ type: 'SetColonyAlarm', colonyId: PC, active: false, issuedAtTick: at });
  }
  const ratio = SWEEP_RATIOS.get(t);
  if (ratio !== undefined) {
    out.push({ type: 'SetBehaviorRatio', colonyId: PC, ratio: { ...ratio }, issuedAtTick: at });
  }
  if (t === 5100) {
    const en = enemyEntranceTile(world);
    if (en !== null) {
      out.push({ type: 'SetRallyPoint', colonyId: PC, tileX: en.x, tileY: en.y, issuedAtTick: at });
    }
  }
  if (t === 6800) out.push({ type: 'ClearRallyPoint', colonyId: PC, issuedAtTick: at });
  for (const c of world.commandQueue.splice(0)) out.push(c);
  return out;
}

/** The raid types the raid-type cycle walks, one per 1000 ticks from tick 3000. */
const RAID_CYCLE: readonly RaidType[] = [
  RaidType.Loot,
  RaidType.Deny,
  RaidType.Spoil,
  RaidType.Blockade,
  RaidType.Assault,
];

/**
 * Both colonies AI-driven until 3000 (the player's AI builds its nest and army),
 * then the scripted player sets an even ratio and rallies on the enemy's entrance
 * every 1000 ticks from 3000, cycling the raid type Loot → Deny → Spoil →
 * Blockade → Assault. The enemy's AI runs throughout. On seed 42 the player's
 * raiders take food in the Loot and Deny windows and spoil it in the Spoil window
 * (BYTE_GATE_COVERAGE's raidFoodByWindow), and the enemy queen lives into the
 * Blockade and Assault windows (queenDeathTick).
 */
function raidCycleDriver(world: WorldState, t: number): SimCommand[] {
  runAIController(world, EC);
  if (t < 3000) runAIController(world, PC);
  const out: SimCommand[] = [];
  const at = t;
  if (t === 3000) {
    out.push({
      type: 'SetBehaviorRatio',
      colonyId: PC,
      ratio: { forage: 5, fight: 5 },
      issuedAtTick: at,
    });
  }
  if (t >= 3000 && t % 1000 === 0) {
    const en = enemyEntranceTile(world);
    if (en !== null) {
      out.push({
        type: 'SetRallyPoint',
        colonyId: PC,
        tileX: en.x,
        tileY: en.y,
        raidType: RAID_CYCLE[((t - 3000) / 1000) % RAID_CYCLE.length]!,
        issuedAtTick: at,
      });
    }
  }
  for (const c of world.commandQueue.splice(0)) out.push(c);
  return out;
}

const SWEEP_SEEDS: ReadonlyArray<[number, 'Easy' | 'Normal' | 'Hard']> = [
  [3, 'Normal'],
  [11, 'Hard'],
  [23, 'Easy'],
  [37, 'Normal'],
  [51, 'Hard'],
  [64, 'Easy'],
  [77, 'Normal'],
  [90, 'Hard'],
];

const SWEEP_SCENARIOS: readonly Scenario[] = [
  ...SWEEP_SEEDS.map(
    ([seed, difficulty]): Scenario => ({
      name: `sweep-sc${seed}-${difficulty.toLowerCase()}-12000-both-ai`,
      seed,
      difficulty,
      ticks: 12_000,
      commands: [],
      setup: bothAiSetup,
      driver: sweepDriver,
    }),
  ),
  {
    name: 'sweep-sc42-normal-8000-raid-type-cycle',
    seed: 42,
    difficulty: 'Normal',
    ticks: 8000,
    commands: [],
    setup: bothAiSetup,
    driver: raidCycleDriver,
  },
];

const ACTIVE_SCENARIOS: readonly Scenario[] = SWEEP
  ? [...SCENARIOS, ...SWEEP_SCENARIOS]
  : SCENARIOS;

/** BYTE_GATE_COVERAGE=1 — what a scenario exercised of the rules the #408 reap touches. */
interface RuleCoverage {
  lootingTicks: number; // ant-ticks in FightingSubState.Looting
  haulingTicks: number; // ant-ticks in FightingSubState.Hauling
  /** `colonyId:raidType@kiloTick` → raid food (fp) the colony TOOK (its foodRaidedFp
   *  rose) and SPOILED (its victim's foodLostToRaidsFp rose by more than the raiders
   *  took) on ticks in that 1000-tick window, under the raid type it held then. */
  raidFoodByWindow: Record<string, { taken: number; spoiled: number }>;
  /** colonyId → the tick its queen was first seen dead (absent: alive at the end). */
  queenDeathTick: Record<string, number>;
  raidTripsByColony: Record<string, number>;
  raidTypesRallied: number[]; // raid types held while rallied on an enemy entrance
  blockadeTicks: number; // ticks some colony blockaded an enemy entrance
  shelterTicks: number; // ant-ticks in the flee/shelter phase
  alarmTicks: number;
  spiderPriorityTicks: number;
  rampageTicks: number;
  rampageStarts: number;
  rotationCursorSets: number; // the spider remembered a timed-out entrance
  maxPlayerEntrances: number;
}

function newRuleCoverage(): RuleCoverage {
  return {
    lootingTicks: 0,
    haulingTicks: 0,
    raidFoodByWindow: {},
    queenDeathTick: {},
    raidTripsByColony: {},
    raidTypesRallied: [],
    blockadeTicks: 0,
    shelterTicks: 0,
    alarmTicks: 0,
    spiderPriorityTicks: 0,
    rampageTicks: 0,
    rampageStarts: 0,
    rotationCursorSets: 0,
    maxPlayerEntrances: 0,
  };
}

function observeRules(
  world: WorldState,
  cov: RuleCoverage,
  prev: {
    rampaging: boolean;
    cursor: number;
    raided: Record<string, number>;
    lost: Record<string, number>;
  },
): void {
  const a = world.ants;
  for (let id = 0; id < world.nextEntityId; id++) {
    if (a.alive[id] !== 1) continue;
    if (a.fleeShelterUntilTick[id]! >= 0) cov.shelterTicks++;
    if (a.task[id] !== AntTask.Fighting) continue;
    const looting = a.subTask[id] === FightingSubState.Looting;
    const hauling = a.subTask[id] === FightingSubState.Hauling;
    if (looting) cov.lootingTicks++;
    else if (hauling) cov.haulingTicks++;
  }
  // Raid food this tick, by colony, raid type and 1000-tick window.
  const kilo = Math.floor(world.tick / 1000);
  const dRaided: Record<string, number> = {};
  const dLost: Record<string, number> = {};
  for (const [cid, c] of Object.entries(world.colonies)) {
    dRaided[cid] = c.foodRaidedFp - (prev.raided[cid] ?? 0);
    dLost[cid] = c.foodLostToRaidsFp - (prev.lost[cid] ?? 0);
    prev.raided[cid] = c.foodRaidedFp;
    prev.lost[cid] = c.foodLostToRaidsFp;
  }
  const bucket = (cid: string): { taken: number; spoiled: number } =>
    (cov.raidFoodByWindow[`${cid}:${world.colonies[Number(cid)]!.raidType}@${kilo}`] ??= {
      taken: 0,
      spoiled: 0,
    });
  for (const [cid, d] of Object.entries(dRaided)) if (d > 0) bucket(cid).taken += d;
  for (const [victim, lost] of Object.entries(dLost)) {
    let tookFromIt = 0;
    for (const [cid, d] of Object.entries(dRaided)) if (cid !== victim && d > 0) tookFromIt += d;
    const spoiled = lost - tookFromIt;
    if (spoiled <= 0) continue;
    for (const [cid, c] of Object.entries(world.colonies)) {
      if (cid !== victim && c.raidType === RaidType.Spoil) bucket(cid).spoiled += spoiled;
    }
  }
  let blockade = false;
  for (const [cid, c] of Object.entries(world.colonies)) {
    cov.raidTripsByColony[cid] = c.raidTrips;
    if (a.alive[c.queenEntityId] !== 1 && cov.queenDeathTick[cid] === undefined) {
      cov.queenDeathTick[cid] = world.tick;
    }
    if (c.alarmActive) cov.alarmTicks++;
    if (blockadedEntrance(world, c) !== null) blockade = true;
    if (rallyEnemyEntrance(world, c) !== null && !cov.raidTypesRallied.includes(c.raidType)) {
      cov.raidTypesRallied.push(c.raidType);
    }
  }
  if (blockade) cov.blockadeTicks++;
  if (world.spiderPriorityColonyId !== null) cov.spiderPriorityTicks++;
  cov.maxPlayerEntrances = Math.max(cov.maxPlayerEntrances, world.colonies[PC]!.entrances.length);
  const sp = world.spider;
  const rampaging = sp !== null && sp.state === 'Rampaging';
  if (rampaging) cov.rampageTicks++;
  if (rampaging && !prev.rampaging) cov.rampageStarts++;
  prev.rampaging = rampaging;
  const cursor = sp === null ? -1 : sp.rampageRotationEntranceId;
  if (cursor !== -1 && cursor !== prev.cursor) cov.rotationCursorSets++;
  prev.cursor = cursor;
}

/** BYTE_GATE_COVERAGE=1 — what a scenario exercised, read through the facade only. */
interface FoodCoverage {
  maxFoodStorageChambers: Record<string, number>;
  multiChamberWithdrawTicks: number; // a stock fell while >= 2 chambers held food
  naturalDepletions: number;
  corpseDepletions: number;
  naturalSpawns: number;
  corpsePilesCreated: number;
  pileTopUps: number; // an existing pile grew, or a new corpse pile was born > 1 yield
  poolClamps: number; // pool fell from over-cap to exactly the cap
  poolBelowCapTicks: number;
  poolDrawTicks: number;
  queenHungryTicks: number;
  larvaHungryTicks: number;
  markChanges: number;
  markedPileDepletions: number; // the marked pile emptied and its mark was cleared
}

function newCoverage(): FoodCoverage {
  return {
    maxFoodStorageChambers: {},
    multiChamberWithdrawTicks: 0,
    naturalDepletions: 0,
    corpseDepletions: 0,
    naturalSpawns: 0,
    corpsePilesCreated: 0,
    pileTopUps: 0,
    poolClamps: 0,
    poolBelowCapTicks: 0,
    poolDrawTicks: 0,
    queenHungryTicks: 0,
    larvaHungryTicks: 0,
    markChanges: 0,
    markedPileDepletions: 0,
  };
}

interface PileSeen {
  initialFp: number;
  corpse: boolean;
}

function observe(
  world: WorldState,
  cov: FoodCoverage,
  prev: {
    piles: Map<number, PileSeen>;
    stock: Record<string, number[]>;
    pool: Record<string, number>;
    mark: number | null;
  },
): void {
  const now = new Map<number, PileSeen>();
  for (let o = 0; o < pileCount(world); o++) {
    const s = pileSlotAt(world, o);
    now.set(pileFoodId(world, s), {
      initialFp: pileInitialFp(world, s),
      corpse: pileIsCorpse(world, s),
    });
  }
  for (const [id, p] of prev.piles) {
    if (!now.has(id)) {
      if (p.corpse) cov.corpseDepletions++;
      else cov.naturalDepletions++;
    }
  }
  for (const [id, p] of now) {
    const q = prev.piles.get(id);
    if (q === undefined) {
      if (p.corpse) {
        cov.corpsePilesCreated++;
        // A fresh corpse pile's size is one of the per-kind yields; anything else
        // means two deaths merged into it within one tick (a top-up).
        if (!FRESH_CORPSE_PILE_FP.has(p.initialFp)) cov.pileTopUps++;
      } else cov.naturalSpawns++;
    } else if (p.initialFp > q.initialFp) cov.pileTopUps++;
  }
  prev.piles = now;
  for (const [cid, c] of Object.entries(world.colonies)) {
    const fs = c.chambers.filter((ch) => ch.chamberType === ChamberType.FoodStorage);
    cov.maxFoodStorageChambers[cid] = Math.max(cov.maxFoodStorageChambers[cid] ?? 0, fs.length);
    const st = fs.map((ch) => chamberStock(world, ch));
    const pv = prev.stock[cid];
    if (pv !== undefined && pv.length === st.length && st.filter((v) => v > 0).length >= 2) {
      if (st.some((v, i) => v < pv[i]!)) cov.multiChamberWithdrawTicks++;
    }
    prev.stock[cid] = st;
    const pool = colonyPoolFood(world, c);
    const pp = prev.pool[cid];
    if (
      pp !== undefined &&
      pp > BASE_FOOD_STORAGE_CAPACITY &&
      pool === BASE_FOOD_STORAGE_CAPACITY
    ) {
      cov.poolClamps++;
    }
    if (pool < BASE_FOOD_STORAGE_CAPACITY) cov.poolBelowCapTicks++;
    if (pp !== undefined && pool < pp) cov.poolDrawTicks++;
    prev.pool[cid] = pool;
    const qh = hungerProjection(world, c.queenEntityId);
    if (qh !== null && qh < STARVATION_GRACE_TICKS) cov.queenHungryTicks++;
    for (const l of c.larvae) {
      const h = hungerProjection(world, l);
      if (h !== null && h < STARVATION_GRACE_TICKS) cov.larvaHungryTicks++;
    }
  }
  const mark = world.colonies[PC]!.priorityFoodPileId;
  if (mark !== prev.mark) cov.markChanges++;
  if (prev.mark !== null && mark === null && !now.has(prev.mark)) cov.markedPileDepletions++;
  prev.mark = mark;
}

interface ScenarioResult {
  final: string;
  checkpoints: Array<[number, string]>; // [tick, hash]
}

function runScenario(scn: Scenario): ScenarioResult {
  // #395 — the pin goes INTO createScenario: map generation is itself version-gated
  // (V69 food fairness), so a pinned world must be generated at the pinned version.
  const world =
    PIN_SIM_VERSION !== null
      ? createScenario(scn.seed, scn.difficulty, PIN_SIM_VERSION)
      : createScenario(scn.seed, scn.difficulty);
  scn.setup?.(world);
  const checkpoints: Array<[number, string]> = [];
  const cov = newCoverage();
  const prev = {
    piles: new Map<number, PileSeen>(),
    stock: {},
    pool: {},
    mark: null as number | null,
  };
  const rules = newRuleCoverage();
  const rulesPrev = { rampaging: false, cursor: -1, raided: {}, lost: {} };
  if (COVERAGE) observe(world, newCoverage(), prev); // prime: tick-0 piles are not spawns
  for (let t = 0; t < scn.ticks; t++) {
    const scripted = scn.commands[t] ?? [];
    tick(world, scn.driver ? [...scripted, ...scn.driver(world, t)] : scripted);
    if (COVERAGE) {
      observe(world, cov, prev);
      observeRules(world, rules, rulesPrev);
    }
    if ((t + 1) % CHECKPOINT_EVERY === 0) checkpoints.push([t + 1, hashFor(world)]);
  }
  if (COVERAGE) {
    console.log(`[byte-gate] COVERAGE ${scn.name} ${JSON.stringify(cov)}`);
    console.log(`[byte-gate] RULE-COVERAGE ${scn.name} ${JSON.stringify(rules)}`);
  }
  return { final: hashFor(world), checkpoints };
}

function firstDivergentTick(a: ScenarioResult, b: ScenarioResult): number {
  const n = Math.min(a.checkpoints.length, b.checkpoints.length);
  for (let i = 0; i < n; i++) {
    if (a.checkpoints[i]![1] !== b.checkpoints[i]![1]) return a.checkpoints[i]![0];
  }
  return -1;
}

describe.skipIf(!MODE)('byte-gate: cross-build determinism (#212 split)', () => {
  it(`${MODE ?? 'skip'} ${ACTIVE_SCENARIOS.length} scenarios`, () => {
    if (!FILE) throw new Error('BYTE_GATE_FILE env var must be an absolute path');
    const results: Record<string, ScenarioResult> = {};
    for (const scn of ACTIVE_SCENARIOS) results[scn.name] = runScenario(scn);

    const hashMode = PROJECTION ? 'projection' : 'snapshot';
    if (MODE === 'capture') {
      writeFileSync(FILE, JSON.stringify({ hashMode, sweep: SWEEP, results }));
      console.log(
        `[byte-gate] CAPTURED ${ACTIVE_SCENARIOS.length} ${hashMode} baselines ` +
          `(sweep ${SWEEP ? 'on' : 'off'}) -> ${FILE}`,
      );
      for (const scn of ACTIVE_SCENARIOS) {
        console.log(`  ${scn.name}: final=${results[scn.name]!.final} (${scn.ticks} ticks)`);
      }
      return; // capture asserts nothing
    }

    // verify
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    // Pre-#290 baselines are the bare results map (always snapshot mode).
    const wrapped = typeof parsed['hashMode'] === 'string';
    const baseMode = wrapped ? String(parsed['hashMode']) : 'snapshot';
    const baseline = (wrapped ? parsed['results'] : parsed) as Record<string, ScenarioResult>;
    if (baseMode !== hashMode) {
      throw new Error(`baseline was captured in ${baseMode} mode; this run is ${hashMode} mode`);
    }
    // #408 — baselines from before the sweep existed carry no flag (sweep off).
    const baseSweep = parsed['sweep'] === true;
    if (baseSweep !== SWEEP) {
      throw new Error(
        `baseline was captured with BYTE_GATE_SWEEP ${baseSweep ? 'on' : 'off'}; ` +
          `this run has it ${SWEEP ? 'on' : 'off'}`,
      );
    }
    console.log(
      `[byte-gate] VERIFY (${hashMode}, sweep ${SWEEP ? 'on' : 'off'}) against baseline ${FILE}`,
    );
    let allPass = true;
    for (const scn of ACTIVE_SCENARIOS) {
      const got = results[scn.name]!;
      const base = baseline[scn.name];
      if (!base) {
        allPass = false;
        console.log(`  BYTE-IDENTICAL: FAIL  ${scn.name} — MISSING from baseline`);
        continue;
      }
      // Every checkpoint must match, not just the final hash: a mid-run divergence
      // that later re-converges (e.g. a stale pointer overwritten a few ticks on)
      // is still a behaviour change.
      const div = firstDivergentTick(got, base);
      if (
        got.final === base.final &&
        div === -1 &&
        got.checkpoints.length === base.checkpoints.length
      ) {
        console.log(
          `  BYTE-IDENTICAL: PASS  ${scn.name} (final=${got.final}, ${scn.ticks} ticks, ` +
            `${got.checkpoints.length} checkpoints)`,
        );
      } else {
        allPass = false;
        console.log(
          `  BYTE-IDENTICAL: FAIL  ${scn.name} — first divergent checkpoint tick=${div}; ` +
            `final got=${got.final} baseline=${base.final}`,
        );
      }
    }
    expect(allPass, 'every scenario must be byte-identical to the pre-split baseline').toBe(true);
  }, 1_800_000);
});
