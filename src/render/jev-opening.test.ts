// jev-opening.test.ts — the code-owned nest planner and the two phase predicates.
//
// Drives a REAL createScenario world through real tick()s, exactly as the game
// loop would: the rule-based AI plays the enemy seat while the Jev opening plans
// the player seat's nest, so the two openings are directly comparable.
//
// The contract under test is the shape of the opening, not just its outputs: the
// whole nest is committed in the first couple of ticks (every command applied,
// nothing rejected), the controller may hand off immediately, and the colony's
// single digger finishes the excavation on its own while Jev plays.
//
// Measured on this harness, seed 1 — the old replay-the-AI opening against the
// planner: handoff 4704 -> 2, FoodStorage built 4601 -> 323, Queen chamber
// 4360 -> 592, Nursery 4704 -> 639, first egg 4705 -> 988. The thresholds below
// sit a little under 2x those figures rather than at a round number, because a
// regression in exactly this is the thing the file exists to catch.

import { beforeAll, describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import type { WorldState } from '../sim/types.js';
import { MAX_COMMANDS_PER_TICK, pushCommand, type SimCommand } from '../sim/commands.js';
import { ChamberType } from '../sim/enums.js';
import { UndergroundTileState, ugGet, ugSet } from '../sim/terrain.js';
import type { PendingChamber } from '../sim/colony/chamber.js';
import { CHAMBER_DIMENSIONS } from '../sim/colony/chamber.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { runAIController } from './ai-controller.js';
import { JevCommandLedger } from './jev-commands.js';
import {
  JEV_OPENING_RATIO,
  JEV_PLAN_PATIENCE_TICKS,
  JEV_QUEEN_ANCHOR_ROW,
  JEV_UPPER_CHAMBER_ROW,
  computeNestPlan,
  createJevOpeningState,
  isHandoffComplete,
  isOpeningPlanned,
  runJevOpeningTick,
} from './jev-opening.js';

/**
 * Deadline for the unaided excavation, not a target: the run stops as soon as
 * all three chambers are up and the queen has laid, which on seed 1 is tick 988
 * — well inside this.
 */
const MAX_TICKS = 6000;
/** rows 2..13 of the spine: rows 0-1 are the scenario's pre-dug entrance shaft. */
const SPINE_MARKS = 12;
/** Slack over the measured 639 / 988. Tight enough that a 2x regression fails. */
const MAX_CHAMBER_BUILT_TICK = 1200;
const MAX_FIRST_EGG_TICK = 1600;
const SEED = 1;
const CHAMBERS = [ChamberType.Queen, ChamberType.Nursery, ChamberType.FoodStorage] as const;

interface IssuedRecord {
  tick: number;
  cmd: SimCommand;
}

interface OpeningRun {
  world: WorldState;
  ledger: JevCommandLedger;
  issued: IssuedRecord[];
  /** First tick at which `isOpeningPlanned` holds — the controller's handoff tick. */
  plannedTick: number;
  /** First tick each chamber type finished excavating. */
  completed: Map<ChamberType, number>;
  firstEggTick: number | null;
}

/**
 * The excavation takes a few hundred ticks of real simulation, so the run
 * happens ONCE for the file. #227 precedent: the build gets an explicit generous
 * timeout so the local coverage gate passes under v8 instrumentation; the
 * default 5s stays the tripwire for every individual test below.
 */
let opening!: OpeningRun;
beforeAll(() => {
  opening = runOpening();
}, 120_000);

/** Play the opening for the player seat against a rule-based enemy, recording everything. */
function runOpening(seed = SEED, maxTicks = MAX_TICKS): OpeningRun {
  const world = createScenario(seed, 'Normal');
  const ledger = new JevCommandLedger();
  const st = createJevOpeningState();
  const issued: IssuedRecord[] = [];
  const completed = new Map<ChamberType, number>();
  const colony = world.colonies[PLAYER_COLONY_ID]!;
  let plannedTick = -1;
  let firstEggTick: number | null = null;

  while (world.tick < maxTicks) {
    if (plannedTick < 0 && isOpeningPlanned(world, PLAYER_COLONY_ID)) plannedTick = world.tick;
    ledger.settle(world);
    runAIController(world, ENEMY_COLONY_ID);
    const before = world.commandQueue.length;
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    for (let i = before; i < world.commandQueue.length; i++) {
      issued.push({ tick: world.tick, cmd: world.commandQueue[i]! });
    }
    tick(world, world.commandQueue.splice(0));
    for (const ch of colony.chambers) {
      if (!completed.has(ch.chamberType)) completed.set(ch.chamberType, world.tick);
    }
    if (firstEggTick === null && colony.eggCount > 0) firstEggTick = world.tick;
    // Everything this file measures has happened — `maxTicks` is the deadline,
    // not a target, and simulating a thriving colony past it just costs time.
    if (completed.size === CHAMBERS.length && firstEggTick !== null && plannedTick >= 0) break;
  }
  if (plannedTick < 0) throw new Error(`the nest was never fully planned by tick ${maxTicks}`);
  return { world, ledger, issued, plannedTick, completed, firstEggTick };
}

/** Run a fresh world for `ticks` ticks of the planner alone (no rule-based enemy). */
function planFor(ticks: number, seed = SEED): { world: WorldState; issued: IssuedRecord[] } {
  const world = createScenario(seed, 'Normal');
  const ledger = new JevCommandLedger();
  const st = createJevOpeningState();
  const issued: IssuedRecord[] = [];
  for (let i = 0; i < ticks; i++) {
    const before = world.commandQueue.length;
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    for (let j = before; j < world.commandQueue.length; j++) {
      issued.push({ tick: world.tick, cmd: world.commandQueue[j]! });
    }
    tick(world, world.commandQueue.splice(0));
  }
  return { world, issued };
}

/** Every tile of every pending footprint this colony owns, as "x,y" keys. */
function pendingFootprintTiles(world: WorldState, colonyId: number): Set<string> {
  const out = new Set<string>();
  for (const p of Object.values(world.pendingChambers)) {
    if (p.colonyId !== colonyId) continue;
    for (let dy = 0; dy < p.height; dy++) {
      for (let dx = 0; dx < p.width; dx++) out.add(`${p.anchorTileX + dx},${p.anchorTileY + dy}`);
    }
  }
  return out;
}

describe('jev opening — planning', () => {
  it('commits the whole nest within the first few ticks and hands off on tick <= 5', () => {
    const { issued, plannedTick } = opening;
    expect(plannedTick).toBeLessThanOrEqual(5);
    const lastIssueTick = Math.max(...issued.map((r) => r.tick));
    expect(lastIssueTick).toBeLessThanOrEqual(5);
    // One ratio push, the whole spine, and exactly three chambers. Nothing after
    // that — and the spine length is fixed by the plan, not by how digging goes.
    expect(issued.filter((r) => r.cmd.type === 'PlaceChamber')).toHaveLength(3);
    expect(issued.filter((r) => r.cmd.type === 'SetBehaviorRatio')).toHaveLength(1);
    expect(issued.filter((r) => r.cmd.type === 'MarkDigTile')).toHaveLength(SPINE_MARKS);
    expect(issued).toHaveLength(SPINE_MARKS + 4);
  });

  it('marks the spine first and places the chambers only once it is Marked', () => {
    const { issued } = opening;
    const lastMark = Math.max(
      ...issued.filter((r) => r.cmd.type === 'MarkDigTile').map((r) => r.tick),
    );
    const firstPlace = Math.min(
      ...issued.filter((r) => r.cmd.type === 'PlaceChamber').map((r) => r.tick),
    );
    // A footprint is only reachable once the spine beside it is non-Solid, and
    // the marks are still queued when the planner runs — so the placements land
    // on a strictly later tick. That ordering IS the mechanism.
    expect(firstPlace).toBeGreaterThan(lastMark);
  });

  it('hangs the Queen deep and the Nursery + FoodStorage high, all off the entrance spine', () => {
    const { world } = planFor(2);
    const entranceX = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX;
    const plan = computeNestPlan(world, PLAYER_COLONY_ID)!;
    expect(plan.columnX).toBe(entranceX);

    const anchors = new Map<ChamberType, PendingChamber>();
    for (const p of Object.values(world.pendingChambers)) {
      if (p.colonyId === PLAYER_COLONY_ID) anchors.set(p.chamberType, p);
    }
    expect([...anchors.keys()].sort()).toEqual([...CHAMBERS].sort());

    const queen = anchors.get(ChamberType.Queen)!;
    expect(queen.anchorTileY).toBe(JEV_QUEEN_ANCHOR_ROW);
    expect(queen.anchorTileX).toBe(entranceX + 1);
    // Deep enough to be a real nest, far shallower than the rule-based AI's 18.
    expect(queen.anchorTileY + queen.height - 1).toBeLessThan(18);
    expect(queen.anchorTileY).toBeGreaterThanOrEqual(10);

    expect(anchors.get(ChamberType.Nursery)!.anchorTileY).toBe(JEV_UPPER_CHAMBER_ROW);
    expect(anchors.get(ChamberType.Nursery)!.anchorTileX).toBe(entranceX + 1);
    const storage = anchors.get(ChamberType.FoodStorage)!;
    expect(storage.anchorTileY).toBe(JEV_UPPER_CHAMBER_ROW);
    expect(storage.anchorTileX).toBe(entranceX - CHAMBER_DIMENSIONS[ChamberType.FoodStorage].width);

    // The spine is dug or queued for digging all the way to the Queen's floor,
    // and no footprint sits on it.
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    for (let y = plan.columnTopY; y <= plan.columnBottomY; y++) {
      expect(ugGet(grid, plan.columnX, y)).not.toBe(UndergroundTileState.Solid);
    }
    const footprint = pendingFootprintTiles(world, PLAYER_COLONY_ID);
    for (let y = plan.columnTopY; y <= plan.columnBottomY; y++) {
      expect(footprint.has(`${plan.columnX},${y}`)).toBe(false);
    }
  });

  it('sets the 7:3 opening behavior ratio exactly once, and every command it issues is applied', () => {
    const { world, ledger } = opening;
    expect(world.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual(JEV_OPENING_RATIO);
    // Every anchor is validated against the same gates tick.ts applies before it
    // is pushed, so a rejection here means a planner/gate mismatch.
    expect(ledger.issuedCount).toBeGreaterThan(0);
    expect(ledger.counts.rejected).toBe(0);
    expect(ledger.counts.noop).toBe(0);
    expect(ledger.counts.applied).toBe(ledger.issuedCount);
  });

  it('never marks a tile inside one of its own pending footprints', () => {
    // PlaceChamber flips every Solid footprint tile to Marked, so a later mark
    // would be a no-op at best — but the planner must not even try.
    const { world } = planFor(2);
    const footprint = pendingFootprintTiles(world, PLAYER_COLONY_ID);
    expect(footprint.size).toBeGreaterThan(0);
    const { issued } = planFor(8);
    for (const r of issued) {
      if (r.cmd.type !== 'MarkDigTile') continue;
      expect(footprint.has(`${r.cmd.tileX},${r.cmd.tileY}`)).toBe(false);
    }
  });
});

describe('jev opening — the colony finishes the plan on its own', () => {
  it('excavates Queen, Nursery and FoodStorage long before the old opening even handed off', () => {
    const { completed } = opening;
    for (const t of CHAMBERS) {
      expect(completed.get(t)).toBeDefined();
      // The replay-the-AI opening had not even handed off by ~4,400; every
      // chamber here is excavated inside a seventh of that.
      expect(completed.get(t)!).toBeLessThan(MAX_CHAMBER_BUILT_TICK);
    }
  });

  it('starts laying eggs an order of magnitude sooner than the old opening', () => {
    const { firstEggTick } = opening;
    expect(firstEggTick).not.toBeNull();
    expect(firstEggTick!).toBeLessThan(MAX_FIRST_EGG_TICK);
  });
});

describe('jev opening — idempotence', () => {
  it('pushes nothing new once the nest is planned', () => {
    const { world } = opening;
    const ledger = new JevCommandLedger();
    // The ratio is already 7:3, so the one guarded push is skipped too.
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, createJevOpeningState());
    expect(ledger.issuedCount).toBe(0);
  });

  it('resumes a mid-plan world with fresh state, issuing only what is missing', () => {
    // Tick 0 only: the spine is Marked, no chamber placed yet — exactly the
    // world a save taken one tick into the round would restore.
    const { world } = planFor(1);
    expect(Object.keys(world.pendingChambers)).toHaveLength(0);

    const ledger = new JevCommandLedger();
    const st = createJevOpeningState();
    const issued: IssuedRecord[] = [];
    for (let i = 0; i < 3; i++) {
      const before = world.commandQueue.length;
      runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
      for (let j = before; j < world.commandQueue.length; j++) {
        issued.push({ tick: world.tick, cmd: world.commandQueue[j]! });
      }
      tick(world, world.commandQueue.splice(0));
    }
    // Nothing re-marked (the spine is already Marked or BeingDug), and the three
    // missing chambers placed exactly once each.
    expect(issued.filter((r) => r.cmd.type === 'MarkDigTile')).toHaveLength(0);
    expect(issued.filter((r) => r.cmd.type === 'PlaceChamber')).toHaveLength(3);
    expect(ledger.counts.rejected).toBe(0);
    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('pushes nothing extra when called twice inside one tick seam', () => {
    // Neither guard can lean on world state here: the first call's commands are
    // still sitting in the queue, so `pendingChambers` has not heard of them.
    const world = createScenario(SEED, 'Normal');
    const ledger = new JevCommandLedger();
    const st = createJevOpeningState();
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st); // tick 0 — the spine
    tick(world, world.commandQueue.splice(0));

    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st); // tick 1 — the chambers
    const afterFirst = world.commandQueue.length;
    expect(afterFirst).toBe(3);
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st); // …and again, same seam
    expect(world.commandQueue).toHaveLength(afterFirst);

    tick(world, world.commandQueue.splice(0));
    ledger.settle(world);
    expect(ledger.counts.rejected).toBe(0);
    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('falls back to the generic spot when something already sits on a planned anchor', () => {
    // A chamber the planner did not put there, squatting exactly where the plan
    // wants the Nursery. The planned anchor can never become legal, so after
    // JEV_PLAN_PATIENCE_TICKS the generic search takes over and the nest still
    // completes — without ever pushing a placement tick.ts would refuse.
    const world = createScenario(SEED, 'Normal');
    const entranceX = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX;
    const squatter = { x: entranceX + 1, y: JEV_UPPER_CHAMBER_ROW };
    const dims = CHAMBER_DIMENSIONS[ChamberType.FoodStorage];
    world.pendingChambers[`${PLAYER_COLONY_ID}:${squatter.x}:${squatter.y}`] = {
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: squatter.x,
      anchorTileY: squatter.y,
      width: dims.width,
      height: dims.height,
    };

    const ledger = new JevCommandLedger();
    const st = createJevOpeningState();
    for (let i = 0; i < JEV_PLAN_PATIENCE_TICKS + 5; i++) {
      ledger.settle(world);
      runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
      tick(world, world.commandQueue.splice(0));
    }
    ledger.settle(world);

    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(true);
    expect(ledger.counts.rejected).toBe(0);
    const nursery = Object.values(world.pendingChambers).find(
      (p) => p.colonyId === PLAYER_COLONY_ID && p.chamberType === ChamberType.Nursery,
    )!;
    expect({ x: nursery.anchorTileX, y: nursery.anchorTileY }).not.toEqual(squatter);
  });

  it('survives a saturated drain — nothing is dropped and the ratio is not lost', () => {
    // The opening ratio used to be pushed outside the command budget behind a
    // one-shot flag: if that one push fell off the end of a full drain, the
    // colony played the entire round on the default 10:0 and nothing ever
    // repaired it. Now the budget refuses to push into a full queue at all, and
    // the colony's own targetRatio is the latch, so the next tick just retries.
    const world = createScenario(SEED, 'Normal');
    const ledger = new JevCommandLedger();
    const st = createJevOpeningState();
    for (let i = 0; i < 6; i++) {
      if (world.tick === 0) {
        // Fill the drain ahead of the planner with MAX_COMMANDS_PER_TICK commands.
        for (let k = 0; k < MAX_COMMANDS_PER_TICK; k++) {
          pushCommand(world, { type: 'NoOp', issuedAtTick: 0 }, 'ai');
        }
      }
      ledger.settle(world);
      runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
      tick(world, world.commandQueue.splice(0));
    }
    ledger.settle(world);

    expect(world.droppedCommandOverflowCount).toBe(0);
    expect(ledger.counts.rejected).toBe(0);
    expect(world.colonies[PLAYER_COLONY_ID]!.targetRatio).toEqual(JEV_OPENING_RATIO);
    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('is inert for a defeated or unknown colony', () => {
    const world = createScenario(SEED, 'Normal');
    const ledger = new JevCommandLedger();
    const st = createJevOpeningState();
    runJevOpeningTick(world, 99, ledger, st);
    expect(ledger.issuedCount).toBe(0);
    const colony = world.colonies[PLAYER_COLONY_ID]!;
    colony.defeated = true;
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    expect(ledger.issuedCount).toBe(0);
  });
});

describe('computeNestPlan', () => {
  it('is null for an unknown colony and for one with no entrance yet', () => {
    const world = createScenario(SEED, 'Normal');
    expect(computeNestPlan(world, 99)).toBeNull();
    world.colonies[PLAYER_COLONY_ID]!.entrances = [];
    expect(computeNestPlan(world, PLAYER_COLONY_ID)).toBeNull();
  });

  it('mirrors a chamber to the other side of the spine when its own side is off-grid', () => {
    const world = createScenario(SEED, 'Normal');
    const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
    // Entrance hard against the left wall: the Queen's and Nursery's own side
    // still fits, and every anchor the plan does keep is on-grid.
    world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX = 0;
    const plan = computeNestPlan(world, PLAYER_COLONY_ID)!;
    expect(plan.columnX).toBe(0);
    for (const c of plan.chambers) {
      if (c.anchor === null) continue;
      expect(c.anchor.x).toBeGreaterThanOrEqual(0);
      expect(c.anchor.x + CHAMBER_DIMENSIONS[c.chamberType].width).toBeLessThanOrEqual(grid.width);
    }
    expect(plan.chambers.find((c) => c.chamberType === ChamberType.Queen)!.anchor).toEqual({
      x: 1,
      y: JEV_QUEEN_ANCHOR_ROW,
    });
  });

  it('drops a mirrored anchor that would land on a chamber the plan already took', () => {
    // At x = 0 the FoodStorage's preferred left side is off-grid, so it mirrors
    // right — straight onto the Nursery. The plan gives up that anchor rather
    // than emitting a placement tick.ts would reject or that would sit unplaced
    // until the patience timer expires.
    const world = createScenario(SEED, 'Normal');
    world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX = 0;
    const plan = computeNestPlan(world, PLAYER_COLONY_ID)!;
    expect(plan.chambers.find((c) => c.chamberType === ChamberType.FoodStorage)!.anchor).toBeNull();
  });

  it('still plans the whole nest on time from a grid-edge entrance, in the nest not on top of it', () => {
    // The dropped anchor takes the generic search, but NOT on tick 0: the spine
    // it needs is still queued then, and a spot picked against a two-tile
    // component lands at row 1, level with the surface. Waiting the one tick for
    // the spine puts it down in the nest proper — assert that, because
    // `isOpeningPlanned` alone cannot tell a good nest from a degenerate one.
    for (const entranceX of [0, 127]) {
      const world = createScenario(SEED, 'Normal');
      const grid = world.undergroundGrids[PLAYER_COLONY_ID]!;
      world.colonies[PLAYER_COLONY_ID]!.entrances[0]!.surfaceTileX = entranceX;
      for (let sy = 0; sy < 2; sy++) ugSet(grid, entranceX, sy, UndergroundTileState.Open);
      const ledger = new JevCommandLedger();
      const st = createJevOpeningState();
      let plannedTick = -1;
      for (let i = 0; i < 8; i++) {
        if (plannedTick < 0 && isOpeningPlanned(world, PLAYER_COLONY_ID)) plannedTick = world.tick;
        ledger.settle(world);
        runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
        tick(world, world.commandQueue.splice(0));
      }
      ledger.settle(world);
      // Same schedule as any other colony — no patience timer burned.
      expect(plannedTick).toBe(2);
      expect(ledger.counts.rejected).toBe(0);

      const pending = Object.values(world.pendingChambers).filter(
        (p) => p.colonyId === PLAYER_COLONY_ID,
      );
      expect(pending).toHaveLength(3);
      const queen = pending.find((p) => p.chamberType === ChamberType.Queen)!;
      expect(queen.anchorTileY).toBe(JEV_QUEEN_ANCHOR_ROW);
      const storage = pending.find((p) => p.chamberType === ChamberType.FoodStorage)!;
      // Not row 1 — that is the "chosen before the spine existed" failure.
      expect(storage.anchorTileY).toBeGreaterThan(JEV_UPPER_CHAMBER_ROW);
      expect(storage.anchorTileY).toBeLessThanOrEqual(JEV_QUEEN_ANCHOR_ROW);
    }
  });
});

describe('isOpeningPlanned', () => {
  it('is false on a fresh scenario and for an unknown colony', () => {
    const world = createScenario(SEED, 'Normal');
    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(false);
    expect(isOpeningPlanned(world, 99)).toBe(false);
  });

  it('is true on pending chambers alone — excavation is not part of the gate', () => {
    const { world } = planFor(2);
    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(true);
    // Nothing is built yet; the colony is still all dirt and intent.
    expect(world.colonies[PLAYER_COLONY_ID]!.chambers).toHaveLength(0);
    expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(false);
  });

  it('is derived from the world, so a resumed save lands in the right phase', () => {
    expect(isOpeningPlanned(opening.world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('ignores the other colony’s chambers', () => {
    const { world } = planFor(2);
    for (const key of Object.keys(world.pendingChambers)) {
      const p = world.pendingChambers[key]!;
      world.pendingChambers[key] = { ...p, colonyId: ENEMY_COLONY_ID };
    }
    expect(isOpeningPlanned(world, PLAYER_COLONY_ID)).toBe(false);
    expect(isOpeningPlanned(world, ENEMY_COLONY_ID)).toBe(true);
  });
});

describe('isHandoffComplete', () => {
  it('is false on a fresh scenario and for an unknown colony', () => {
    const world = createScenario(SEED, 'Normal');
    expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(false);
    expect(isHandoffComplete(world, 99)).toBe(false);
  });

  it('is true once every chamber is excavated and nothing of ours is pending', () => {
    const { world } = opening;
    expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(true);
  });

  it('is false again while any chamber of OURS is still pending', () => {
    const { world } = opening;
    const key = `${PLAYER_COLONY_ID}:1:40`;
    const ourPending: PendingChamber = {
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: 1,
      anchorTileY: 40,
      width: 3,
      height: 3,
    };
    world.pendingChambers[key] = ourPending;
    try {
      expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(false);
      // Someone else's pending chamber does not hold OUR handoff back.
      world.pendingChambers[key] = { ...ourPending, colonyId: ENEMY_COLONY_ID };
      expect(isHandoffComplete(world, PLAYER_COLONY_ID)).toBe(true);
    } finally {
      delete world.pendingChambers[key];
    }
  });
});
