import { describe, it, expect } from 'vitest';
import { GameOutcome, checkQueenDeath, checkTiebreaks } from './game-over.js';
import {
  createWorldState,
  allocateEntityId,
  LATEST_SIM_VERSION,
  SIM_VERSION_V22_DIFFICULTY,
  SIM_VERSION_V66_QUEEN_STARVES_HP,
  SIM_VERSION_V67_NO_MATCH_TIMEOUT,
} from './types.js';
import { createColonyRecord } from './colony/colony-store.js';
import { initAnt } from './ant/ant-store.js';
import { AntTask } from './enums.js';
import type { ColonyId } from './colony/colony-store.js';
import type { WorldState } from './types.js';
import { MATCH_TIMEOUT_TICKS, STALEMATE_FOOD_THRESHOLD_FP } from './constants.js';
import { setPoolFoodForTest, setPilesForTest } from './food/food-test-utils.js';

function makeWorldWith2Colonies(): { world: WorldState; queen1: number; queen2: number } {
  const world = createWorldState(42);
  const queen1 = allocateEntityId(world);
  initAnt(world.ants, queen1, {
    colonyId: 1,
    posX: 0,
    posY: 0,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
  });
  const c1 = createColonyRecord(1 as ColonyId, queen1);
  c1.entrances = [];
  c1.rallyPoint = null;
  c1.digFlowFieldDirty = false;
  world.colonies[1] = c1;

  const queen2 = allocateEntityId(world);
  initAnt(world.ants, queen2, {
    colonyId: 2,
    posX: 0,
    posY: 0,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
  });
  const c2 = createColonyRecord(2 as ColonyId, queen2);
  c2.entrances = [];
  c2.rallyPoint = null;
  c2.digFlowFieldDirty = false;
  world.colonies[2] = c2;

  return { world, queen1, queen2 };
}

describe('game-over detection', () => {
  describe('checkQueenDeath', () => {
    it('is exported as a function', () => {
      expect(typeof checkQueenDeath).toBe('function');
    });

    it('returns None when both queens alive', () => {
      const { world } = makeWorldWith2Colonies();
      expect(checkQueenDeath(world)).toBe(GameOutcome.None);
    });

    it('returns Victory when enemy queen dead and player queen alive (CMBT-06)', () => {
      const { world, queen2 } = makeWorldWith2Colonies();
      world.ants.alive[queen2] = 0; // colony 2 queen dead
      expect(checkQueenDeath(world)).toBe(GameOutcome.Victory);
    });

    it('returns Defeat when player queen dead and enemy queen alive (CMBT-07)', () => {
      const { world, queen1 } = makeWorldWith2Colonies();
      world.ants.alive[queen1] = 0;
      expect(checkQueenDeath(world)).toBe(GameOutcome.Defeat);
    });

    it('returns MutualDestruction when all queens dead', () => {
      const { world, queen1, queen2 } = makeWorldWith2Colonies();
      world.ants.alive[queen1] = 0;
      world.ants.alive[queen2] = 0;
      expect(checkQueenDeath(world)).toBe(GameOutcome.MutualDestruction);
    });

    it('sets colony.defeated = true for dead-queen colonies (idempotent)', () => {
      const { world, queen2 } = makeWorldWith2Colonies();
      world.ants.alive[queen2] = 0;
      expect(world.colonies[2]!.defeated).toBe(false);
      const r1 = checkQueenDeath(world);
      expect(world.colonies[2]!.defeated).toBe(true);
      const r2 = checkQueenDeath(world);
      expect(r1).toBe(r2); // idempotent outcome
      expect(world.colonies[2]!.defeated).toBe(true);
    });

    it('single-colony world: returns None when queen alive', () => {
      const { world, queen2 } = makeWorldWith2Colonies();
      delete world.colonies[2];
      void queen2;
      expect(checkQueenDeath(world)).toBe(GameOutcome.None);
    });

    it('single-colony world: returns Defeat when queen dead', () => {
      const { world, queen1 } = makeWorldWith2Colonies();
      delete world.colonies[2];
      world.ants.alive[queen1] = 0;
      expect(checkQueenDeath(world)).toBe(GameOutcome.Defeat);
    });

    it('uses smallest colonyId as player when playerColonyId arg omitted (CLNY-08)', () => {
      const { world, queen1 } = makeWorldWith2Colonies();
      world.ants.alive[queen1] = 0;
      // Colony 1 is "player" by default (smallest id) → Defeat
      expect(checkQueenDeath(world)).toBe(GameOutcome.Defeat);
    });

    it('respects playerColonyId arg when provided', () => {
      const { world, queen1 } = makeWorldWith2Colonies();
      world.ants.alive[queen1] = 0;
      // Override: colony 2 is "player", colony 1 (now dead) is "enemy" → Victory
      expect(checkQueenDeath(world, 2 as ColonyId)).toBe(GameOutcome.Victory);
    });
  });

  describe('queen death causes', () => {
    it('queen slot alive=0 (regardless of cause) is detected as dead', () => {
      const { world, queen2 } = makeWorldWith2Colonies();
      // Simulate either combat (alive=0) or starvation (alive=0) — both look the same here.
      world.ants.alive[queen2] = 0;
      expect(checkQueenDeath(world)).toBe(GameOutcome.Victory);
    });
  });
});

// ---------------------------------------------------------------------------
// S5 (V22) — checkTiebreaks
// ---------------------------------------------------------------------------

function makeV22WorldWith2Colonies(
  playerColonyId = 1,
  aiColonyId = 2,
): {
  world: WorldState;
  queen1: number;
  queen2: number;
  addWorker: (colonyId: number) => number;
} {
  const world = createWorldState(42);
  world.simVersion = SIM_VERSION_V22_DIFFICULTY;
  world.difficulty = 'Normal';
  // Default food pile prevents spurious stalemate in tests that only check other conditions.
  // Stalemate tests explicitly clear the piles to override this.
  setPilesForTest(world, [
    { foodPileId: 1, tileX: 10, tileY: 10, pickupsRemaining: 1, pickupsInitial: 1 },
  ]);

  const queen1 = allocateEntityId(world);
  initAnt(world.ants, queen1, {
    colonyId: playerColonyId,
    posX: 0,
    posY: 0,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
  });
  const c1 = createColonyRecord(playerColonyId, queen1);
  c1.entrances = [];
  c1.rallyPoint = null;
  c1.digFlowFieldDirty = false;
  world.colonies[playerColonyId] = c1;

  const queen2 = allocateEntityId(world);
  initAnt(world.ants, queen2, {
    colonyId: aiColonyId,
    posX: 0,
    posY: 0,
    task: AntTask.Idle,
    subTask: 0,
    speed: 0,
  });
  const c2 = createColonyRecord(aiColonyId, queen2);
  c2.entrances = [];
  c2.rallyPoint = null;
  c2.digFlowFieldDirty = false;
  world.colonies[aiColonyId] = c2;

  const addWorker = (colonyId: number): number => {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId: colonyId,
      posX: 1,
      posY: 1,
      task: AntTask.Idle,
      subTask: 0,
      speed: 0,
    });
    // Must push into colony.workers so livingWorkerCount (which iterates colony.workers) sees this ant.
    world.colonies[colonyId]!.workers.push(id);
    world.colonies[colonyId]!.workerCount += 1;
    return id;
  };

  return { world, queen1, queen2, addWorker };
}

describe('checkTiebreaks (S5 V22)', () => {
  it('returns None when tick is below timeout cap', () => {
    const { world } = makeV22WorldWith2Colonies();
    world.tick = MATCH_TIMEOUT_TICKS - 1;
    expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.None);
  });

  describe('Timeout tiebreak', () => {
    it('returns MutualDestruction when worker counts are equal', () => {
      const { world, addWorker } = makeV22WorldWith2Colonies();
      world.tick = MATCH_TIMEOUT_TICKS;
      addWorker(1);
      addWorker(2); // one worker each
      expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.MutualDestruction);
    });

    it('returns Victory when player has more workers', () => {
      const { world, addWorker } = makeV22WorldWith2Colonies();
      world.tick = MATCH_TIMEOUT_TICKS;
      addWorker(1);
      addWorker(1);
      addWorker(2); // 2 player vs 1 AI
      expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.Victory);
    });

    it('returns Defeat when AI has more workers', () => {
      const { world, addWorker } = makeV22WorldWith2Colonies();
      world.tick = MATCH_TIMEOUT_TICKS;
      addWorker(1);
      addWorker(2);
      addWorker(2); // 1 player vs 2 AI
      expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.Defeat);
    });

    it('emits a round_end event with reason TimeoutTiebreak', () => {
      const { world } = makeV22WorldWith2Colonies();
      world.tick = MATCH_TIMEOUT_TICKS;
      checkTiebreaks(world, 1 as ColonyId);
      const ev = world.events.find((e) => e.type === 'round_end');
      expect(ev).toBeDefined();
      if (ev && ev.type === 'round_end') {
        expect(ev.payload.reason).toBe('TimeoutTiebreak');
      }
    });
  });

  describe('Stalemate tiebreak', () => {
    it('returns None when food piles remain on the map', () => {
      const { world } = makeV22WorldWith2Colonies();
      setPilesForTest(world, [
        { foodPileId: 99, tileX: 5, tileY: 5, pickupsRemaining: 1, pickupsInitial: 1 },
      ]);
      // both colonies below threshold
      expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.None);
    });

    it('returns None when one colony has food above threshold', () => {
      const { world } = makeV22WorldWith2Colonies();
      setPilesForTest(world, []);
      setPoolFoodForTest(world, world.colonies[1]!, STALEMATE_FOOD_THRESHOLD_FP + 100);
      setPoolFoodForTest(world, world.colonies[2]!, 0);
      expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.None);
    });

    it('returns MutualDestruction when food depleted and both colonies starving', () => {
      const { world } = makeV22WorldWith2Colonies();
      setPilesForTest(world, []);
      setPoolFoodForTest(world, world.colonies[1]!, 0);
      setPoolFoodForTest(world, world.colonies[2]!, 0);
      expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.MutualDestruction);
    });

    it('emits a round_end event with reason StalemateTiebreak', () => {
      const { world } = makeV22WorldWith2Colonies();
      setPilesForTest(world, []);
      setPoolFoodForTest(world, world.colonies[1]!, 0);
      setPoolFoodForTest(world, world.colonies[2]!, 0);
      checkTiebreaks(world, 1 as ColonyId);
      const ev = world.events.find((e) => e.type === 'round_end');
      expect(ev).toBeDefined();
      if (ev && ev.type === 'round_end') {
        expect(ev.payload.reason).toBe('StalemateTiebreak');
      }
    });

    it('timeout takes priority over stalemate when both conditions are met', () => {
      const { world } = makeV22WorldWith2Colonies();
      world.tick = MATCH_TIMEOUT_TICKS;
      setPilesForTest(world, []);
      setPoolFoodForTest(world, world.colonies[1]!, 0);
      setPoolFoodForTest(world, world.colonies[2]!, 0);
      checkTiebreaks(world, 1 as ColonyId);
      const ev = world.events.find((e) => e.type === 'round_end');
      if (ev && ev.type === 'round_end') {
        expect(ev.payload.reason).toBe('TimeoutTiebreak');
      }
    });
  });

  it('returns None when AI queen is dead (checkQueenDeath handles that, not checkTiebreaks)', () => {
    const { world, queen2 } = makeV22WorldWith2Colonies();
    world.tick = MATCH_TIMEOUT_TICKS;
    world.ants.alive[queen2] = 0;
    expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.None);
  });
});

// ---------------------------------------------------------------------------
// #376 (V67) — no match timeout
// ---------------------------------------------------------------------------

describe('#376 V67 — checkTiebreaks has no Timeout', () => {
  const V66 = SIM_VERSION_V66_QUEEN_STARVES_HP; // the last version with the Timeout

  it('new worlds are created at V67 or later', () => {
    expect(createWorldState(1).simVersion).toBe(LATEST_SIM_VERSION);
    expect(LATEST_SIM_VERSION).toBeGreaterThanOrEqual(SIM_VERSION_V67_NO_MATCH_TIMEOUT);
  });

  it.each([
    MATCH_TIMEOUT_TICKS,
    MATCH_TIMEOUT_TICKS + 1,
    MATCH_TIMEOUT_TICKS * 10,
    0x7fffffff, // the save loader's largest tick
  ])('V67: both queens alive at tick %i → None, no round_end event', (t) => {
    const { world, addWorker } = makeV22WorldWith2Colonies();
    world.simVersion = SIM_VERSION_V67_NO_MATCH_TIMEOUT;
    world.tick = t;
    addWorker(1);
    addWorker(1);
    addWorker(2); // 2 player vs 1 AI: a V66 world would call this a Victory
    expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.None);
    expect(world.events.some((e) => e.type === 'round_end')).toBe(false);
  });

  it('V66 (the last version with the Timeout): the same world at MATCH_TIMEOUT_TICKS → Victory', () => {
    const { world, addWorker } = makeV22WorldWith2Colonies();
    world.simVersion = V66;
    world.tick = MATCH_TIMEOUT_TICKS;
    addWorker(1);
    addWorker(1);
    addWorker(2);
    expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.Victory);
    const ev = world.events.find((e) => e.type === 'round_end');
    expect(ev?.type === 'round_end' && ev.payload.reason).toBe('TimeoutTiebreak');
  });

  it('V66: one tick before MATCH_TIMEOUT_TICKS is still None (the cap is unchanged)', () => {
    const { world } = makeV22WorldWith2Colonies();
    world.simVersion = V66;
    world.tick = MATCH_TIMEOUT_TICKS - 1;
    expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.None);
  });

  it('V67: past the old cap the Stalemate tiebreak still fires (the Timeout no longer pre-empts it)', () => {
    const { world } = makeV22WorldWith2Colonies();
    world.simVersion = SIM_VERSION_V67_NO_MATCH_TIMEOUT;
    world.tick = MATCH_TIMEOUT_TICKS + 500;
    setPilesForTest(world, []);
    setPoolFoodForTest(world, world.colonies[1]!, 0);
    setPoolFoodForTest(world, world.colonies[2]!, 0);
    expect(checkTiebreaks(world, 1 as ColonyId)).toBe(GameOutcome.MutualDestruction);
    const ends = world.events.filter((e) => e.type === 'round_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.type === 'round_end' && ends[0]!.payload.reason).toBe('StalemateTiebreak');
  });
});
