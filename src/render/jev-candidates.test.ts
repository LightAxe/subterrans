// jev-candidates.test.ts — seat-agnosticism and candidate LEGALITY.
//
// The contract these tests defend: every option the Jev opponent is offered must
// be something tick.ts will actually accept, and nothing in this module may
// depend on which seat it is driving. Ported from the spike.

import { beforeAll, describe, it, expect } from 'vitest';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { copyWorldState, type WorldState } from '../sim/types.js';
import { ChamberType } from '../sim/enums.js';
import { UndergroundTileState, ugGet } from '../sim/terrain.js';
import { ENEMY_COLONY_ID, PLAYER_COLONY_ID } from '../sim/constants.js';
import { isSurfaceTileInComponent } from '../sim/surface-features.js';
import { runAIController } from './ai-controller.js';
import { JevCommandLedger } from './jev-commands.js';
import { createJevOpeningState, isHandoffComplete, runJevOpeningTick } from './jev-opening.js';
import {
  RECENT_WINDOW_TICKS,
  buildCandidates,
  computeFacts,
  digFrontier,
  findReachableChamberSpot,
  foodCapacity,
  livingWorkers,
  manhattan,
  undergroundComponent,
} from './jev-candidates.js';
import { JEV_ID_PATTERN, buildQuestions } from './jev-encode.js';
import type { DigDirection, RawFacts, Seats } from './jev-types.js';

const PLAYER_SEATS: Seats = { mySeat: PLAYER_COLONY_ID, opponentSeat: ENEMY_COLONY_ID };
const ENEMY_SEATS: Seats = { mySeat: ENEMY_COLONY_ID, opponentSeat: PLAYER_COLONY_ID };
const DIRECTED: readonly DigDirection[] = ['deeper', 'wider_left', 'wider_right', 'toward_surface'];

const SEED = 1;

/** Build a world past the opening handoff for the player seat (rule-based enemy running). */
function buildHandoffWorld(maxTicks = 8000): WorldState {
  const world = createScenario(SEED, 'Normal');
  const ledger = new JevCommandLedger();
  const st = createJevOpeningState();
  while (!isHandoffComplete(world, PLAYER_COLONY_ID)) {
    if (world.tick >= maxTicks) throw new Error(`no handoff by tick ${maxTicks}`);
    runAIController(world, ENEMY_COLONY_ID);
    runJevOpeningTick(world, PLAYER_COLONY_ID, ledger, st);
    tick(world, world.commandQueue.splice(0));
  }
  return world;
}

/**
 * The opening is ~4k ticks of real simulation, so it runs ONCE for the file and
 * each test gets a clone. #227 precedent: the build carries an explicit generous
 * timeout so the local coverage gate passes under v8 instrumentation, while the
 * default 5s stays the tripwire for every individual test below.
 */
let template!: WorldState;
beforeAll(() => {
  template = buildHandoffWorld();
}, 120_000);

/** A fresh, independently-mutable copy of the post-handoff world. */
function worldAtHandoff(): WorldState {
  const clone = createScenario(SEED, 'Normal');
  copyWorldState(template, clone);
  return clone;
}

function factsFor(world: WorldState, seats: Seats): RawFacts {
  const facts = computeFacts(world, seats, 'recall');
  if (facts === null) throw new Error('expected facts for a live seat');
  return facts;
}

describe('candidates — seat-agnostic', () => {
  it('references only the seat it is given (mirrored-state check)', () => {
    const world = worldAtHandoff();
    for (const seats of [PLAYER_SEATS, ENEMY_SEATS]) {
      const me = world.colonies[seats.mySeat]!;
      const opp = world.colonies[seats.opponentSeat]!;
      const facts = factsFor(world, seats);
      const c = buildCandidates(world, seats, facts);

      const gh = c.posture.guard_home!;
      expect(
        me.entrances.some((e) => e.surfaceTileX === gh.tile!.x && e.surfaceTileY === gh.tile!.y),
      ).toBe(true);
      const as = c.posture.assault!;
      expect(
        opp.entrances.some(
          (e) => e.isOpen && e.surfaceTileX === as.tile!.x && e.surfaceTileY === as.tile!.y,
        ),
      ).toBe(true);

      // Frontier tiles live in MY grid, are Solid, and touch my component.
      const comp = undergroundComponent(world, seats.mySeat)!;
      for (const dir of DIRECTED) {
        for (const t of digFrontier(world, seats.mySeat, dir, comp).slice(0, 10)) {
          expect(ugGet(world.undergroundGrids[seats.mySeat]!, t.x, t.y)).toBe(
            UndergroundTileState.Solid,
          );
          const adjacent = [
            [t.x, t.y - 1],
            [t.x + 1, t.y],
            [t.x, t.y + 1],
            [t.x - 1, t.y],
          ].some(([x, y]) => comp.mask[y! * comp.width + x!] === 1);
          expect(adjacent).toBe(true);
        }
      }

      expect(facts.ownWorkers).toBe(me.workers.filter((id) => world.ants.alive[id] === 1).length);
      expect(facts.ownWorkers).toBe(livingWorkers(world, seats.mySeat));
      expect(facts.foodCapacity).toBe(foodCapacity(me));
    }
  });

  it('swapping seats swaps the assault target between the two colonies', () => {
    const world = worldAtHandoff();
    const a = buildCandidates(world, PLAYER_SEATS, factsFor(world, PLAYER_SEATS));
    const b = buildCandidates(world, ENEMY_SEATS, factsFor(world, ENEMY_SEATS));
    const enemyEntrance = world.colonies[ENEMY_COLONY_ID]!.entrances[0]!;
    const playerEntrance = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!;
    expect(a.posture.assault!.tile).toEqual({
      x: enemyEntrance.surfaceTileX,
      y: enemyEntrance.surfaceTileY,
    });
    expect(b.posture.assault!.tile).toEqual({
      x: playerEntrance.surfaceTileX,
      y: playerEntrance.surfaceTileY,
    });
    expect(a.posture.guard_home!.tile).toEqual(b.posture.assault!.tile);
  });

  it('omits assault when the opponent has no open entrance', () => {
    const w = worldAtHandoff();
    for (const e of w.colonies[ENEMY_COLONY_ID]!.entrances)
      (e as { isOpen: boolean }).isOpen = false;
    const c = buildCandidates(w, PLAYER_SEATS, factsFor(w, PLAYER_SEATS));
    expect(c.posture.assault).toBeUndefined();
    expect(c.posture.guard_home).toBeDefined();
  });

  it('every rally candidate is in the surface walkable component', () => {
    const world = worldAtHandoff();
    const c = buildCandidates(world, PLAYER_SEATS, factsFor(world, PLAYER_SEATS));
    for (const [k, p] of Object.entries(c.posture)) {
      if (p.tile === null) {
        expect(k).toBe('recall');
        continue;
      }
      expect(isSurfaceTileInComponent(world, p.tile.x, p.tile.y)).toBe(true);
    }
  });

  it('produces only proxy-legal question ids and option keys', () => {
    const world = worldAtHandoff();
    const c = buildCandidates(world, PLAYER_SEATS, factsFor(world, PLAYER_SEATS));
    const questions = buildQuestions(c, true);
    for (const [id, q] of Object.entries(questions)) {
      expect(id).toMatch(JEV_ID_PATTERN);
      for (const key of Object.keys(q.criteria)) expect(key).toMatch(JEV_ID_PATTERN);
    }
  });

  it('`hold` is always offered; directed digs are offered only when a frontier exists', () => {
    const world = worldAtHandoff();
    const c = buildCandidates(world, PLAYER_SEATS, factsFor(world, PLAYER_SEATS));
    expect(c.dig.hold.available).toBe(true);
    for (const dir of DIRECTED) {
      expect(c.dig[dir].available).toBe(digFrontier(world, PLAYER_SEATS.mySeat, dir).length > 0);
    }
  });
});

describe('computeFacts', () => {
  it('returns null when a seat does not exist (defensive, never in a real round)', () => {
    const world = createScenario(1, 'Normal');
    expect(
      computeFacts(world, { mySeat: 99, opponentSeat: PLAYER_COLONY_ID }, 'recall'),
    ).toBeNull();
    expect(
      computeFacts(world, { mySeat: PLAYER_COLONY_ID, opponentSeat: 99 }, 'recall'),
    ).toBeNull();
  });

  it('counts only combat kills inside the recent window, attributed by seat', () => {
    const world = worldAtHandoff();
    const kill = (t: number, victim: number, killer: number) => ({
      tick: t,
      type: 'combat_kill' as const,
      payload: {
        killer: { kind: 'Ant' as const, id: 1, colonyId: killer },
        victim: { kind: 'Ant' as const, id: 2, colonyId: victim },
        location: { x: 0, y: 0, grid: 'surface' as const },
      },
    });
    // The opening produces real kills, so assert on the DELTA our events add.
    const before = factsFor(world, PLAYER_SEATS);
    world.events.push(kill(world.tick - 10, ENEMY_COLONY_ID, PLAYER_COLONY_ID));
    world.events.push(kill(world.tick - 10, PLAYER_COLONY_ID, ENEMY_COLONY_ID));
    // Well outside the window — must be ignored entirely.
    world.events.push(
      kill(world.tick - RECENT_WINDOW_TICKS - 1, PLAYER_COLONY_ID, ENEMY_COLONY_ID),
    );

    const after = factsFor(world, PLAYER_SEATS);
    expect(after.ownKillsRecent - before.ownKillsRecent).toBe(1);
    expect(after.oppLossesRecent - before.oppLossesRecent).toBe(1);
    expect(after.ownLossesRecent - before.ownLossesRecent).toBe(1);
  });

  it('sorts food piles by distance from our home entrance', () => {
    const world = worldAtHandoff();
    const facts = factsFor(world, PLAYER_SEATS);
    const home = world.colonies[PLAYER_COLONY_ID]!.entrances[0]!;
    for (let i = 1; i < facts.piles.length; i++) {
      expect(facts.piles[i - 1]!.distOwn).toBeLessThanOrEqual(facts.piles[i]!.distOwn);
    }
    if (facts.piles.length > 0) {
      const first = facts.piles[0]!;
      expect(first.distOwn).toBe(
        manhattan(first.tile.x, first.tile.y, home.surfaceTileX, home.surfaceTileY),
      );
    }
  });
});

describe('candidates — apply through a real tick()', () => {
  it('dig marks, a rally point, a food priority and a storage chamber all apply', () => {
    const world = worldAtHandoff();
    const ledger = new JevCommandLedger();
    const c = buildCandidates(world, PLAYER_SEATS, factsFor(world, PLAYER_SEATS));

    const tiles = digFrontier(world, PLAYER_COLONY_ID, 'deeper').slice(0, 5);
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      ledger.issue(world, {
        type: 'MarkDigTile',
        colonyId: PLAYER_COLONY_ID,
        tileX: t.x,
        tileY: t.y,
        issuedAtTick: world.tick,
      });
    }
    const assault = c.posture.assault!.tile!;
    ledger.issue(world, {
      type: 'SetRallyPoint',
      colonyId: PLAYER_COLONY_ID,
      tileX: assault.x,
      tileY: assault.y,
      issuedAtTick: world.tick,
    });
    const pileA = c.foodPriority.pile_a!;
    ledger.issue(world, {
      type: 'MarkFoodPile',
      colonyId: PLAYER_COLONY_ID,
      tileX: pileA.tile!.x,
      tileY: pileA.tile!.y,
      issuedAtTick: world.tick,
    });
    const spot = findReachableChamberSpot(world, PLAYER_COLONY_ID, ChamberType.FoodStorage);
    expect(spot).not.toBeNull();
    ledger.issue(world, {
      type: 'PlaceChamber',
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: spot!.x,
      anchorTileY: spot!.y,
      issuedAtTick: world.tick,
    });

    tick(world, world.commandQueue.splice(0));
    ledger.settle(world);

    expect(ledger.counts.rejected).toBe(0);
    expect(ledger.counts.noop).toBe(0);
    expect(ledger.counts.applied).toBe(ledger.issuedCount);
    expect(world.colonies[PLAYER_COLONY_ID]!.rallyPoint).toEqual({
      tileX: assault.x,
      tileY: assault.y,
    });
    expect(world.colonies[PLAYER_COLONY_ID]!.priorityFoodPileId).toBe(pileA.pileId);
    expect(Object.hasOwn(world.pendingChambers, `${PLAYER_COLONY_ID}:${spot!.x}:${spot!.y}`)).toBe(
      true,
    );
  });

  it('offers expand_storage only once stores are nearly full, and the anchor is legal', () => {
    const world = worldAtHandoff();
    const base = factsFor(world, PLAYER_SEATS);
    expect(
      buildCandidates(world, PLAYER_SEATS, { ...base, foodTotal: 0 }).expandStorage,
    ).toBeNull();

    const full = { ...base, foodTotal: base.foodCapacity };
    const c = buildCandidates(world, PLAYER_SEATS, full);
    expect(c.expandStorage).not.toBeNull();
    const ledger = new JevCommandLedger();
    ledger.issue(world, {
      type: 'PlaceChamber',
      colonyId: PLAYER_COLONY_ID,
      chamberType: ChamberType.FoodStorage,
      anchorTileX: c.expandStorage!.anchor.x,
      anchorTileY: c.expandStorage!.anchor.y,
      issuedAtTick: world.tick,
    });
    tick(world, world.commandQueue.splice(0));
    ledger.settle(world);
    expect(ledger.counts.applied).toBe(1);
  });
});
