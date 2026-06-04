// chamber-flow.test.ts — Issue #173: capacity-aware Nursery deposit routing (V24).
//
// Covers computeNurseryDepositField: a Nursery at capacity (resident brood >=
// Open-tile count) drops out of the nurseDeposit seed set so carriers route to
// a non-full Nursery, with a fallback that seeds all when every Nursery is full
// (never strand a carrier). The V23 control uses the pre-V24 nearest-seed field
// (computeChamberFlowField) to pin the OLD funnel-to-nearest behavior.

import { describe, it, expect } from 'vitest';
import {
  computeNurseryDepositField,
  computeChamberFlowField,
  NURSERY_CHAMBER_TYPES,
} from './chamber-flow.js';
import { createWorldState, allocateEntityId } from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import type { ChamberRecord, ColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask, ChamberType } from './enums.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import { Zone, UndergroundTileState, ugSet, createUndergroundGrid } from './terrain.js';
import type { WorldState } from './types.js';

const W = 64;
const H = 32;
const COLONY_ID = 1;

// BFS step decode (matches bfs-flow-field.ts: 0=N,1=E,2=S,3=W; value = step
// toward source).
const DR = [-1, 0, 1, 0] as const;
const DC = [0, 1, 0, -1] as const;

interface Setup {
  world: WorldState;
  colony: ColonyRecord;
  underground: ReturnType<typeof createUndergroundGrid>;
  A: ChamberRecord;
  B: ChamberRecord;
  field: Int32Array;
  queue: Int32Array;
}

// Two Nurseries on one Open corridor: A (near the (5,5) pickup) and B (far).
function setup(): Setup {
  const world = createWorldState(42, 256);
  const underground = createUndergroundGrid(W, H);
  world.undergroundGrids[COLONY_ID] = underground;
  const queenId = allocateEntityId(world);
  initAnt(world.ants, queenId, { colonyId: COLONY_ID, posX: 0, posY: 0, speed: 0 });
  const colony = createColonyRecord(COLONY_ID, queenId);
  world.colonies[COLONY_ID] = colony;
  // Open band y[4..6], x[5..40] — pickup tile + both Nursery footprints + the
  // corridor connecting them.
  for (let y = 4; y <= 6; y++) {
    for (let x = 5; x <= 40; x++) ugSet(underground, x, y, UndergroundTileState.Open);
  }
  const A: ChamberRecord = {
    chamberId: 10,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: 10 << FP_SHIFT,
    posY: 4 << FP_SHIFT,
    width: 4,
    height: 3,
  };
  const B: ChamberRecord = {
    chamberId: 11,
    chamberType: ChamberType.Nursery,
    foodStored: 0,
    posX: 30 << FP_SHIFT,
    posY: 4 << FP_SHIFT,
    width: 4,
    height: 3,
  };
  colony.chambers.push(A, B);
  return {
    world,
    colony,
    underground,
    A,
    B,
    field: new Int32Array(W * H),
    queue: new Int32Array(W * H),
  };
}

function addResidentBrood(
  world: WorldState,
  colony: ColonyRecord,
  tileX: number,
  tileY: number,
): void {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId: COLONY_ID,
    posX: (tileX << FP_SHIFT) + (FP_ONE >> 1),
    posY: (tileY << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Idle,
    speed: 0,
    zone: Zone.Underground,
  });
  colony.eggs.push(id);
}

// Fill a Nursery footprint (4×3 = 12 tiles) to capacity with resident brood.
function fillNursery(world: WorldState, colony: ColonyRecord, ch: ChamberRecord): void {
  const bx = ch.posX >> FP_SHIFT;
  const by = ch.posY >> FP_SHIFT;
  for (let ty = 0; ty < ch.height; ty++) {
    for (let tx = 0; tx < ch.width; tx++) addResidentBrood(world, colony, bx + tx, by + ty);
  }
}

// Walk the flow field from (sx,sy) along step directions to its terminal source
// (-1). Returns the source tile reached. Asserts every step is reachable.
function followToSource(field: Int32Array, sx: number, sy: number): { x: number; y: number } {
  let x = sx;
  let y = sy;
  for (let guard = 0; guard < 5000; guard++) {
    const d = field[y * W + x]!;
    if (d === -1) return { x, y };
    expect(d).toBeGreaterThanOrEqual(0); // reachable, not -2 (unreachable)
    x += DC[d]!;
    y += DR[d]!;
  }
  throw new Error('followToSource did not terminate');
}

function insideChamber(ch: ChamberRecord, x: number, y: number): boolean {
  const bx = ch.posX >> FP_SHIFT;
  const by = ch.posY >> FP_SHIFT;
  return x >= bx && x < bx + ch.width && y >= by && y < by + ch.height;
}

describe('computeNurseryDepositField — capacity-aware routing (#173, V24)', () => {
  it('V24: a full Nursery is excluded from the deposit seeds; carriers route to the empty Nursery B', () => {
    const { world, colony, underground, A, B, field, queue } = setup();
    fillNursery(world, colony, A); // A at capacity (12/12); B empty

    computeNurseryDepositField(
      underground,
      colony.chambers,
      world.ants,
      colony.eggs,
      colony.larvae,
      field,
      queue,
    );

    // B advertises (its Open tiles are sources); A does NOT (excluded — its
    // tiles are reachable toward B but are not sources).
    expect(field[4 * W + 30]).toBe(-1); // B corner (30,4) is a source
    expect(field[4 * W + 10]).not.toBe(-1); // A corner (10,4) is excluded

    // A tile just east of A routes to B, not back into the full A.
    const term = followToSource(field, 14, 5);
    expect(insideChamber(B, term.x, term.y)).toBe(true);
    expect(insideChamber(A, term.x, term.y)).toBe(false);
  });

  it('V23 control: nearest-seed field still routes the same tile into the nearer (full) Nursery A', () => {
    const { world, colony, underground, A, field, queue } = setup();
    fillNursery(world, colony, A);

    // Pre-V24 path: plain nearest-seed field with no capacity filter.
    computeChamberFlowField(underground, colony.chambers, NURSERY_CHAMBER_TYPES, field, queue);

    expect(field[4 * W + 10]).toBe(-1); // A is still a source (no capacity awareness)
    const term = followToSource(field, 14, 5);
    expect(insideChamber(A, term.x, term.y)).toBe(true); // funnels into nearest A
  });

  it('V24 no-stranding: when EVERY Nursery is full, all are still seeded so a carrier can reach a target', () => {
    const { world, colony, underground, A, B, field, queue } = setup();
    fillNursery(world, colony, A);
    fillNursery(world, colony, B);

    computeNurseryDepositField(
      underground,
      colony.chambers,
      world.ants,
      colony.eggs,
      colony.larvae,
      field,
      queue,
    );

    // Fallback seeds all Nurseries, so the pickup tile still routes to a target
    // (the field is not empty) — a carrier is never stranded with nowhere to go.
    const term = followToSource(field, 5, 5);
    expect(insideChamber(A, term.x, term.y) || insideChamber(B, term.x, term.y)).toBe(true);
  });
});
