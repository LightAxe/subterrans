// chamber-flow-gating.test.ts — #235 differential gate.
//
// PR2 gates tick.ts step-9's SECOND loop (the every-tick nursing-pickup + V24
// nursery-deposit O(grid) BFS rebuilds) behind ColonyRecord.broodFieldDirty. This
// is safe ONLY IF every real input-change to those fields sets the flag. This test
// is the proof: two worlds tick in lockstep from an identical brood-churning
// colony — world G ticks normally (gated), world F forces broodFieldDirty=true
// before every tick (= the pre-#235 unconditional recompute). serialize(G) must
// equal serialize(F) every tick; a divergence means a MISSING trigger (fix the
// trigger — never gate a divergence behind a simVersion).
import { describe, it, expect } from 'vitest';
import {
  createWorldState,
  allocateEntityId,
  LATEST_SIM_VERSION,
  type WorldState,
} from './types.js';
import { createColonyRecord, type ColonyId } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { createUndergroundGrid, ugSet, UndergroundTileState, Zone } from './terrain.js';
import { ChamberType, AntTask } from './enums.js';
import { FP_SHIFT } from './fixed.js';
import { LARVA_MATURE_TICKS, FOOD_CHAMBER_CAPACITY } from './constants.js';
import { tick, __getChamberFlowFieldsForTest } from './tick.js';
import { killAnt } from './combat.js';
import { tickFoodConsumption } from './colony/colony-system.js';
import { tickLifecycleTransitions } from './colony/lifecycle-system.js';
// eslint-disable-next-line no-restricted-imports -- #235 differential proof needs the platform serializer (telemetry.test.ts:8 pattern)
import { serializeWorldState } from '../platform/save.js';

const COLONY_ID = 1 as ColonyId;
const MAX_TEST_ENTITIES = 256;

/**
 * A brood-churning colony: Queen chamber (queen lays on cadence) + Nursery
 * (nurses carry+deposit) + connecting tunnel, all carved Open so the BFS fields
 * have topology; a fed colony so laying/maturation proceed; several workers the
 * allocator turns into nurses; a couple of seeded larvae to prime nursing. Built
 * identically for both G and F from the same seed.
 */
function buildBroodColony(seed: number): WorldState {
  const world = createWorldState(seed, MAX_TEST_ENTITIES);
  world.simVersion = LATEST_SIM_VERSION;
  const underground = createUndergroundGrid(20, 20);
  world.undergroundGrids[COLONY_ID] = underground;

  // Queen chamber (3x3 Open) at (2,2) + queen ant inside.
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++) ugSet(underground, 2 + dx, 2 + dy, UndergroundTileState.Open);
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, {
    colonyId: COLONY_ID,
    posX: 3 << FP_SHIFT,
    posY: 3 << FP_SHIFT,
    speed: 0,
    zone: Zone.Underground, // egg-laying Gate 6 requires the queen Underground + inside the Queen chamber
  });
  const colony = createColonyRecord(COLONY_ID, queenId);
  colony.entrances = [];
  colony.rallyPoint = null;
  colony.digFlowFieldDirty = false;
  colony.foodFlowFieldDirty = false;
  colony.broodFieldDirty = false;
  colony.foodStored = 500_000; // plenty — queen lays, larvae feed, no starvation
  world.colonies[COLONY_ID] = colony;
  colony.chambers.push({
    chamberId: 1,
    chamberType: ChamberType.Queen,
    foodStored: 0,
    posX: 2 << FP_SHIFT,
    posY: 2 << FP_SHIFT,
    width: 3,
    height: 3,
  });

  // Nursery (3x3 Open) at (12,12).
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++) ugSet(underground, 12 + dx, 12 + dy, UndergroundTileState.Open);
  colony.chambers.push({
    chamberId: 2,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: 12 << FP_SHIFT,
    posY: 12 << FP_SHIFT,
    width: 3,
    height: 3,
  });

  // FoodStorage (3x3 Open) at (5,6) — its foodStored is toggled across the
  // isFoodChamberDepositable boundary in the loop to fire foodFlowFieldDirty, so
  // the #235 PR3 food-decouple (food field rebuilds on food OR topology; the other
  // five first-loop fields on topology only) is exercised.
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++) ugSet(underground, 5 + dx, 6 + dy, UndergroundTileState.Open);
  colony.chambers.push({
    chamberId: 3,
    chamberType: ChamberType.FoodStorage,
    foodStored: 0,
    posX: 5 << FP_SHIFT,
    posY: 6 << FP_SHIFT,
    width: 3,
    height: 3,
  });

  // Tunnel connecting Queen (2..4,2..4) to Nursery (12..14,12..14).
  for (let x = 4; x <= 13; x++) ugSet(underground, x, 3, UndergroundTileState.Open);
  for (let y = 3; y <= 13; y++) ugSet(underground, 13, y, UndergroundTileState.Open);

  // Workers (allocator turns some into nurses) near the Queen chamber.
  for (let i = 0; i < 8; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: COLONY_ID,
      posX: (3 + (i % 2)) << FP_SHIFT,
      posY: (3 + (i % 2)) << FP_SHIFT,
      task: AntTask.Idle,
    });
    colony.workers.push(id);
    colony.workerCount += 1;
  }

  // Prime a couple of larvae on the tunnel outside the Nursery so nursing fires.
  // Real brood are stationary (speed 0, Idle, Underground) — matching the queen's
  // egg-lay initAnt; without speed 0 the movement system would drift them, which
  // is not a real input-change and would spuriously fail the differential.
  for (let i = 0; i < 2; i++) {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: COLONY_ID,
      posX: (10 + i) << FP_SHIFT,
      posY: 3 << FP_SHIFT,
      task: AntTask.Idle,
      speed: 0,
      zone: Zone.Underground,
    });
    colony.larvae.push(id);
    colony.larvaeCount += 1;
  }

  return world;
}

function serialize(world: WorldState): string {
  return JSON.stringify(serializeWorldState(world));
}

// Compact string of the gated chamber fields (nursing pickup + V24 deposit) for
// every colony, so a mismatch localizes the stale-field tick before behavioral drift.
function chamberFieldSig(world: WorldState): string {
  const cff = __getChamberFlowFieldsForTest(world);
  const parts: string[] = [];
  for (const key in world.colonies) {
    if (!Object.hasOwn(world.colonies, key)) continue;
    const cid = Number(key);
    parts.push(`${cid}:n:${Array.from(cff.nursing[cid] ?? []).join(',')}`);
    parts.push(`${cid}:d:${Array.from(cff.nurseDeposit[cid] ?? []).join(',')}`);
    // #235 PR3 — the food field is not serialized, so compare it here directly.
    parts.push(`${cid}:f:${Array.from(cff.food[cid] ?? []).join(',')}`);
  }
  return parts.join('|');
}

describe('chamber-flow gating (#235) — gated ≡ force-recompute-every-tick', () => {
  const SEEDS = [1337, 4242, 9001];
  const TICKS = 2000;

  for (const seed of SEEDS) {
    it(`seed ${seed}: ${TICKS} ticks of a brood-churning colony stay byte-identical`, () => {
      const g = buildBroodColony(seed); // gated (normal)
      const f = buildBroodColony(seed); // forced (baseline)
      const ga = g.ants;
      const gc = g.colonies[COLONY_ID]!;
      const fc = f.colonies[COLONY_ID]!;
      const gFood = gc.chambers.find((ch) => ch.chamberType === ChamberType.FoodStorage)!;
      const fFood = fc.chambers.find((ch) => ch.chamberType === ChamberType.FoodStorage)!;
      let layEvents = 0;
      let carryTicks = 0;
      let gatedSkips = 0;
      let foodFull = false;
      let prevLastEgg = gc.queenLastEggTick;
      let prevSig = chamberFieldSig(g);
      for (let t = 0; t < TICKS; t++) {
        // Toggle the FoodStorage chamber across the depositable boundary every 40
        // ticks, in BOTH worlds identically, and set foodFlowFieldDirty (the sole
        // trigger of that flag in the real sim = a deposit crossing full↔not-full).
        // This exercises PR3's food-decouple: G rebuilds ONLY the food field, F (all
        // flags forced) rebuilds every field — the food field must still match.
        if (t % 40 === 0) {
          foodFull = !foodFull;
          const fv = foodFull ? FOOD_CHAMBER_CAPACITY : 0;
          gFood.foodStored = fv;
          fFood.foodStored = fv;
          gc.foodFlowFieldDirty = true;
          fc.foodFlowFieldDirty = true;
        }
        tick(g, []);
        // F = the full pre-#235 baseline: force EVERY first-loop + second-loop
        // recompute (dig/food/brood dirty) before its tick, so any gate G applies
        // that changes output would diverge here.
        for (const key in f.colonies) {
          if (!Object.hasOwn(f.colonies, key)) continue;
          const c = f.colonies[key as unknown as ColonyId]!;
          c.digFlowFieldDirty = true;
          c.foodFlowFieldDirty = true;
          c.broodFieldDirty = true;
        }
        tick(f, []);

        // Field-level localizer first (pinpoints the stale tick), then full state.
        const gSig = chamberFieldSig(g);
        if (gSig !== chamberFieldSig(f)) {
          throw new Error(
            `seed ${seed}: chamber fields (nursing/deposit/food) diverged at tick ${t} — a gated rebuild went stale (missing broodFieldDirty trigger, or the PR3 food-decouple is unsafe)`,
          );
        }
        if (serialize(g) !== serialize(f)) {
          throw new Error(`seed ${seed}: world state diverged at tick ${t}`);
        }

        // Observe trigger activity (proves the run is non-vacuous) and gate action.
        if (gc.queenLastEggTick !== prevLastEgg) {
          layEvents++;
          prevLastEgg = gc.queenLastEggTick;
        }
        if (gc.workers.some((id) => ga.carryingBroodId[id] !== -1)) carryTicks++;
        if (gSig === prevSig) gatedSkips++; // field unchanged → the gate correctly skipped a rebuild
        prevSig = gSig;
      }
      // Non-vacuity: the run actually exercised the lay + pickup/deposit triggers,
      // AND the gate actually skipped rebuilds on the (many) no-change ticks — i.e.
      // this proves gated-and-equal, not every-tick-recompute-and-trivially-equal.
      expect(layEvents, 'queen never laid — egg-lay trigger unexercised').toBeGreaterThanOrEqual(2);
      expect(
        carryTicks,
        'no nurse ever carried — pickup/deposit triggers unexercised',
      ).toBeGreaterThan(0);
      expect(
        gatedSkips,
        'gate never skipped a rebuild — test does not exercise gating',
      ).toBeGreaterThan(1000);
    }, 30_000);
  }
});

describe('broodFieldDirty triggers (#235) — the two hardest, deterministically', () => {
  it('a carrier carrying a brood, killed, sets broodFieldDirty', () => {
    const world = buildBroodColony(1337);
    const colony = world.colonies[COLONY_ID]!;
    const ants = world.ants;
    // Make a worker carry a larva, then clear the flag and kill the carrier.
    const carrier = colony.workers[0]!;
    const brood = colony.larvae[0]!;
    ants.carryingBroodId[carrier] = brood;
    ants.carriedBy[brood] = carrier;
    colony.broodFieldDirty = false;
    killAnt(world, carrier, null, null, 'Ant');
    expect(colony.broodFieldDirty).toBe(true);
  });

  it('a larva starving to death sets broodFieldDirty', () => {
    const world = buildBroodColony(1337);
    const colony = world.colonies[COLONY_ID]!;
    const ants = world.ants;
    // Call tickFoodConsumption directly (a full tick would clear the flag in
    // step-9's second loop after the death). No food + a 1-tick timer → death.
    colony.foodStored = 0;
    const larva = colony.larvae[0]!;
    ants.starvationTimer[larva] = 1;
    colony.broodFieldDirty = false;
    tickFoodConsumption(world, colony);
    expect(ants.alive[larva]).toBe(0);
    expect(colony.broodFieldDirty).toBe(true);
  });

  it('a larva maturing to worker sets broodFieldDirty', () => {
    const world = buildBroodColony(1337);
    const colony = world.colonies[COLONY_ID]!;
    const ants = world.ants;
    // Age a larva to the brink so one lifecycle step promotes it (Nursery present
    // → not broodFrozen). Call tickLifecycleTransitions directly (a full tick would
    // clear the flag in step-9's second loop after the promotion).
    const larva = colony.larvae[0]!;
    ants.age[larva] = LARVA_MATURE_TICKS - 1;
    colony.broodFieldDirty = false;
    tickLifecycleTransitions(world, colony);
    expect(colony.workers).toContain(larva);
    expect(colony.broodFieldDirty).toBe(true);
  });
});
