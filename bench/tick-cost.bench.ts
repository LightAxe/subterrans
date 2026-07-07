// bench/tick-cost.bench.ts — whole-sim tick-cost benchmark (#235).
//
// Invocation: cd code && npx vitest run --config bench/vitest.bench.config.ts
//
// INFORMATIONAL ONLY — not run by `npm run verify` / CI (matches the #188
// rationale: instrumented/timing runs are local-only, never CI-gated). Prints
// ticks/sec for three whole-sim workloads at a pinned seed so the #235 gating
// PRs (brood-field dirty-gate, step-9 rebuild split) can quantify their win:
// run this, record idle/excavation/combat ticks/sec BEFORE and AFTER the gate,
// paste the delta into the PR body.
//
// Lives outside src/sim/ so performance.now is allowed (the simSafetyConfig
// ESLint glob does not apply here).
import { describe, it } from 'vitest';
import { createScenario } from '../src/sim/scenario.js';
import { tick } from '../src/sim/tick.js';
import { PLAYER_COLONY_ID } from '../src/sim/constants.js';
import { createWorldState, allocateEntityId, LATEST_SIM_VERSION } from '../src/sim/types.js';
import type { WorldState } from '../src/sim/types.js';
import { createColonyRecord } from '../src/sim/colony/colony-store.js';
import type { ColonyId } from '../src/sim/colony/colony-store.js';
import { initAnt } from '../src/sim/ant/ant-store.js';
import { createUndergroundGrid, ugSet, UndergroundTileState, Zone } from '../src/sim/terrain.js';
import { ChamberType, AntTask } from '../src/sim/enums.js';
import { FP_SHIFT } from '../src/sim/fixed.js';
import type { SimCommand } from '../src/sim/commands.js';

const SEED = 42;
const TICKS = 2000;
const WARMUP_TICKS = 200; // JIT warmup on a throwaway world
const PC = PLAYER_COLONY_ID as ColonyId;

function ticksPerSec(label: string, buildScript: () => SimCommand[][]): void {
  // Warmup a throwaway world to let the JIT settle before timing.
  {
    const warm = createScenario(SEED);
    const script = buildScript();
    for (let t = 0; t < WARMUP_TICKS; t++) tick(warm, script[t] ?? []);
  }
  const world = createScenario(SEED);
  const script = buildScript();
  const start = performance.now();
  for (let t = 0; t < TICKS; t++) tick(world, script[t] ?? []);
  const elapsedMs = performance.now() - start;
  const tps = TICKS / (elapsedMs / 1000);
  // eslint-disable-next-line no-console -- bench output is the deliverable
  console.log(
    `[tick-cost] ${label.padEnd(16)} ${tps.toFixed(0).padStart(8)} ticks/sec  (${elapsedMs.toFixed(1)}ms / ${TICKS} ticks)`,
  );
}

// idle — early-game, no player input (foraging/nursing/lifecycle only).
function idleScript(): SimCommand[][] {
  return [];
}

// excavation-heavy — ~10 dig marks over the first 100 ticks keeps diggers
// churning digFlowFieldDirty (the step-9 rebuild hot path #235 PR3 narrows).
function excavationScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const tileX = 20 + ((i * 3) % 12);
    const tileY = 2 + i;
    c[t] = [{ type: 'MarkDigTile', colonyId: PC, tileX, tileY, issuedAtTick: t }];
    t += 10;
  }
  return c;
}

// combat-heavy — rally the player's fighters + let the ENEMY_COLONY_ID AI invade;
// deaths exercise killAnt (the brood-field dirty trigger #235 PR2 adds).
function combatScript(): SimCommand[][] {
  const c: SimCommand[][] = [];
  c[0] = [{ type: 'SetRallyPoint', colonyId: PC, tileX: 64, tileY: 64, issuedAtTick: 0 }];
  c[20] = [
    { type: 'SetBehaviorRatio', colonyId: PC, ratio: { forage: 3, fight: 7 }, issuedAtTick: 20 },
  ];
  return c;
}

describe('whole-sim tick-cost benchmark (#235 — informational)', () => {
  it('reports ticks/sec for idle / excavation-heavy / combat-heavy workloads', () => {
    ticksPerSec('idle', idleScript);
    ticksPerSec('excavation', excavationScript);
    ticksPerSec('combat', combatScript);
  });
});

// A brood-heavy colony (Queen chamber + Nursery + brood) — the case the #235
// step-9 second-loop gate actually helps, since createScenario has no chambers.
// Times the SAME world gated (normal) vs forced (broodFieldDirty=true every tick,
// = the pre-#235 unconditional recompute) so the delta IS the gating win, with no
// dependence on comparing against another build.
const BROOD_CID = PLAYER_COLONY_ID as ColonyId;
function buildBroodColony(): WorldState {
  const world = createWorldState(1337, 256);
  world.simVersion = LATEST_SIM_VERSION;
  const ug = createUndergroundGrid(20, 20);
  world.undergroundGrids[BROOD_CID] = ug;
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++) ugSet(ug, 2 + dx, 2 + dy, UndergroundTileState.Open);
  const q = allocateEntityId(world);
  initAnt(world.ants, q, {
    colonyId: BROOD_CID,
    posX: 3 << FP_SHIFT,
    posY: 3 << FP_SHIFT,
    speed: 0,
    zone: Zone.Underground,
  });
  const c = createColonyRecord(BROOD_CID, q);
  c.entrances = [];
  c.rallyPoint = null;
  c.digFlowFieldDirty = false;
  c.foodFlowFieldDirty = false;
  c.broodFieldDirty = false;
  c.foodStored = 500_000;
  world.colonies[BROOD_CID] = c;
  c.chambers.push({
    chamberId: 1,
    chamberType: ChamberType.Queen,
    foodStored: 0,
    posX: 2 << FP_SHIFT,
    posY: 2 << FP_SHIFT,
    width: 3,
    height: 3,
  });
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++) ugSet(ug, 12 + dx, 12 + dy, UndergroundTileState.Open);
  c.chambers.push({
    chamberId: 2,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: 12 << FP_SHIFT,
    posY: 12 << FP_SHIFT,
    width: 3,
    height: 3,
  });
  for (let x = 4; x <= 13; x++) ugSet(ug, x, 3, UndergroundTileState.Open);
  for (let y = 3; y <= 13; y++) ugSet(ug, 13, y, UndergroundTileState.Open);
  for (let i = 0; i < 8; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: BROOD_CID,
      posX: (3 + (i % 2)) << FP_SHIFT,
      posY: (3 + (i % 2)) << FP_SHIFT,
      task: AntTask.Idle,
    });
    c.workers.push(id);
    c.workerCount += 1;
  }
  for (let i = 0; i < 2; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: BROOD_CID,
      posX: (10 + i) << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    c.larvae.push(id);
    c.larvaeCount += 1;
  }
  return world;
}

function timeBroodColony(force: boolean): number {
  {
    const warm = buildBroodColony();
    for (let t = 0; t < WARMUP_TICKS; t++) tick(warm, []);
  }
  const world = buildBroodColony();
  const start = performance.now();
  for (let t = 0; t < TICKS; t++) {
    if (force)
      for (const key in world.colonies) {
        if (!Object.hasOwn(world.colonies, key)) continue;
        world.colonies[key as unknown as ColonyId]!.broodFieldDirty = true;
      }
    tick(world, []);
  }
  const elapsedMs = performance.now() - start;
  return TICKS / (elapsedMs / 1000);
}

describe('step-9 brood-field gate win (#235 — informational)', () => {
  it('gated vs forced (every-tick recompute) on a brood-heavy colony', () => {
    const gated = timeBroodColony(false);
    const forced = timeBroodColony(true);
    const speedup = ((gated - forced) / forced) * 100;
    // eslint-disable-next-line no-console -- bench output is the deliverable
    console.log(
      `[tick-cost] brood gated=${gated.toFixed(0)} forced=${forced.toFixed(0)} ticks/sec  (gate saves ${speedup.toFixed(1)}%)`,
    );
  });
});
