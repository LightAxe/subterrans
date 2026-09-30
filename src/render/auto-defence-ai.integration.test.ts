// #372 (V64) — automatic defence under the AI controller.
//
// The AI colony defends its nest two ways at once: the sim's automatic defence
// (its fighters with no orders go down the breached entrance, from the first tick
// an intruder is below) and the controller's V62 nest defence (#371), which puts a
// rally on the threatened entrance for two or more raiders or any in the nest. The
// two must hand over cleanly: the intruders die, and afterwards no fighter is left
// below in its own nest or stranded away from home, and the rally is cleared.
// Lives in src/render/ because it drives runAIController (the sim→render boundary
// rule has no test exemption).
import { describe, it, expect } from 'vitest';
import { runAIController } from './ai-controller.js';
import { createScenario } from '../sim/scenario.js';
import { tick } from '../sim/tick.js';
import { allocateEntityId, SIM_VERSION_V64_AUTO_DEFENCE } from '../sim/types.js';
import { initAnt } from '../sim/ant/ant-store.js';
import { AntTask, FightingSubState } from '../sim/enums.js';
import { Zone, UndergroundTileState, ugSet } from '../sim/terrain.js';
import { FP_SHIFT, FP_ONE } from '../sim/fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from '../sim/constants.js';

const P = PLAYER_COLONY_ID;
const E = ENEMY_COLONY_ID;

function run(intruderCount: number): {
  killedAt: number;
  below: number;
  rally: unknown;
  holding: number;
  fighters: number;
} {
  const world = createScenario(11, 'Normal');
  expect(world.simVersion).toBeGreaterThanOrEqual(SIM_VERSION_V64_AUTO_DEFENCE);
  world.spider = null;
  const enemy = world.colonies[E]!;
  const ee = enemy.entrances.find((en) => en.isOpen)!;
  const grid = world.undergroundGrids[E]!;
  for (let y = 0; y <= 3; y++) ugSet(grid, ee.surfaceTileX, y, UndergroundTileState.Open);
  for (let x = ee.surfaceTileX - 12; x <= ee.surfaceTileX + 12; x++) {
    ugSet(grid, x, 3, UndergroundTileState.Open);
  }
  enemy.digFlowFieldDirty = true;
  const spawn = (colonyId: number, x: number, y: number, zone: number, speed: number): number => {
    const id = allocateEntityId(world);
    initAnt(world.ants, id, {
      colonyId,
      posX: (x << FP_SHIFT) + (FP_ONE >> 1),
      posY: (y << FP_SHIFT) + (FP_ONE >> 1),
      task: AntTask.Fighting,
      subTask: 0,
      speed,
      lifespan: WORKER_LIFESPAN_TICKS,
      zone: zone as Zone,
    });
    world.ants.currentGridColonyId[id] = colonyId;
    world.colonies[colonyId]!.workers.push(id);
    world.colonies[colonyId]!.workerCount += 1;
    return id;
  };
  const garrison: number[] = [];
  for (let i = 0; i < 5; i++) {
    garrison.push(spawn(E, ee.surfaceTileX + 2, ee.surfaceTileY, Zone.Surface, WORKER_BASE_SPEED));
  }
  const step = (): void => {
    runAIController(world, E);
    tick(world, world.commandQueue.splice(0));
  };
  for (let t = 0; t < 100; t++) step();
  // Player fighters below in the AI's nest, invading (their rally on its entrance).
  world.colonies[P]!.rallyPoint = { tileX: ee.surfaceTileX, tileY: ee.surfaceTileY };
  const intruders: number[] = [];
  for (let i = 0; i < intruderCount; i++) {
    const id = spawn(P, ee.surfaceTileX + 8 + 2 * i, 3, Zone.Underground, 0);
    world.ants.currentGridColonyId[id] = E;
    intruders.push(id);
  }
  let killedAt = -1;
  for (let t = 0; t < 600 && killedAt < 0; t++) {
    step();
    if (intruders.every((i) => world.ants.alive[i] !== 1)) killedAt = t;
  }
  world.colonies[P]!.rallyPoint = null;
  for (let t = 0; t < 400; t++) step();
  const a = world.ants;
  const alive = garrison.filter((g) => a.alive[g] === 1 && a.task[g] === AntTask.Fighting);
  return {
    killedAt,
    below: alive.filter((g) => a.zone[g] === Zone.Underground).length,
    rally: world.colonies[E]!.rallyPoint,
    holding: alive.filter((g) => a.subTask[g] === FightingSubState.Holding).length,
    fighters: alive.length,
  };
}

describe('#372 (V64) — automatic defence with the AI controller’s nest defence', () => {
  for (const n of [1, 2]) {
    it(`${n} intruder(s): killed, then every fighter back out at its post and the rally cleared`, () => {
      const r = run(n);
      expect(r.killedAt).toBeGreaterThanOrEqual(0);
      expect(r.below).toBe(0);
      expect(r.rally).toBeNull();
      expect(r.fighters).toBeGreaterThan(0);
      expect(r.holding).toBe(r.fighters);
    }, 60_000);
  }
});
