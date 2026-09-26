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
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { tick } from '../sim/tick.js';
import { createScenario } from '../sim/scenario.js';
import { hashWorldState } from './world-hash.js';
import { hashFoodProjection, hungerProjection } from './food-projection.js';
import type { WorldState } from '../sim/types.js';
import { allocateEntityId } from '../sim/types.js';
import {
  BASE_FOOD_STORAGE_CAPACITY,
  ENEMY_COLONY_ID,
  PLAYER_COLONY_ID,
  STARVATION_GRACE_TICKS,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../sim/constants.js';
import type { SimCommand } from '../sim/commands.js';
import type { ColonyId } from '../sim/colony/colony-store.js';
import { AntTask, ChamberType } from '../sim/enums.js';
import { FP_ONE, FP_SHIFT } from '../sim/fixed.js';
import { Zone } from '../sim/terrain.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { runAIController } from '../render/ai-controller.js';
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

const MODE = process.env.BYTE_GATE_MODE; // 'capture' | 'verify' | undefined
const FILE = process.env.BYTE_GATE_FILE ?? '';
const CHECKPOINT_EVERY = 25; // hash cadence for first-divergence localization
const PC = PLAYER_COLONY_ID as ColonyId;
const EC = ENEMY_COLONY_ID as ColonyId;
const COVERAGE = process.env.BYTE_GATE_COVERAGE === '1';
const PROJECTION = process.env.BYTE_GATE_PROJECTION === '1';
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
        if (p.initialFp !== 512 && p.initialFp !== 8 * 512 && p.initialFp !== 100 * 512)
          cov.pileTopUps++;
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
  const world = createScenario(scn.seed, scn.difficulty);
  scn.setup?.(world);
  const checkpoints: Array<[number, string]> = [];
  const cov = newCoverage();
  const prev = {
    piles: new Map<number, PileSeen>(),
    stock: {},
    pool: {},
    mark: null as number | null,
  };
  if (COVERAGE) observe(world, newCoverage(), prev); // prime: tick-0 piles are not spawns
  for (let t = 0; t < scn.ticks; t++) {
    const scripted = scn.commands[t] ?? [];
    tick(world, scn.driver ? [...scripted, ...scn.driver(world, t)] : scripted);
    if (COVERAGE) observe(world, cov, prev);
    if ((t + 1) % CHECKPOINT_EVERY === 0) checkpoints.push([t + 1, hashFor(world)]);
  }
  if (COVERAGE) console.log(`[byte-gate] COVERAGE ${scn.name} ${JSON.stringify(cov)}`);
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
  it(`${MODE ?? 'skip'} ${SCENARIOS.length} scenarios`, () => {
    if (!FILE) throw new Error('BYTE_GATE_FILE env var must be an absolute path');
    const results: Record<string, ScenarioResult> = {};
    for (const scn of SCENARIOS) results[scn.name] = runScenario(scn);

    const hashMode = PROJECTION ? 'projection' : 'snapshot';
    if (MODE === 'capture') {
      writeFileSync(FILE, JSON.stringify({ hashMode, results }));
      console.log(`[byte-gate] CAPTURED ${SCENARIOS.length} ${hashMode} baselines -> ${FILE}`);
      for (const scn of SCENARIOS) {
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
    console.log(`[byte-gate] VERIFY (${hashMode}) against baseline ${FILE}`);
    let allPass = true;
    for (const scn of SCENARIOS) {
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
  }, 600_000);
});
