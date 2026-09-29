// #372 — pinned V63: the fighter paths #372 rewrote behave exactly as before it.
//
// #372 routes every "has this fighter orders?" and "which entrance does it defend?"
// question through per-fighter predicates (fighter-orders.ts, fighterDefendedEntrance,
// fighterIsRecalled) instead of reading the colony's rally point, and adds a
// step-8 check to the surplus-sentry stand-down. Below V64 each predicate reduces to
// the old colony-level read, so nothing may change. The byte gate's scenarios do not
// reach all of these paths (an enemy fighter below ground in a nest with a garrison
// of sentries; an AI probe that recorded fewer fighters than it has; invaders recalled
// from inside the nest; a surplus to stand down with an intruder below), so this
// pins them at V63 through the whole tick: the fingerprint of every ant's tile, zone,
// task and sub-task over the run must equal the one the base tree produces (GOLDEN
// was captured by running this file on fix/374-ai-deep-queen at adfcbd5, before #372).
// Non-vacuity: the run has an enemy probe with fighters outside its cohort, enemy
// fighters below in the player's nest beside its sentries, and a recall.
import { describe, it, expect } from 'vitest';
import { tick } from './tick.js';
import { createScenario } from './scenario.js';
import { allocateEntityId } from './types.js';
import type { WorldState } from './types.js';
import type { SimCommand } from './commands.js';
import { initAnt } from './ant/ant-store.js';
import { getAIStateForColony } from './ai-state.js';
import { AntTask } from './enums.js';
import { Zone, UndergroundTileState, ugSet } from './terrain.js';
import { FP_SHIFT, FP_ONE } from './fixed.js';
import {
  PLAYER_COLONY_ID,
  ENEMY_COLONY_ID,
  WORKER_BASE_SPEED,
  WORKER_LIFESPAN_TICKS,
} from './constants.js';

/** simVersion 63 (SIM_VERSION_V63_AI_DEEP_QUEEN). */
const V63 = 63;
const TICKS = 700;
/** Captured on fix/374-ai-deep-queen at adfcbd5 (before #372) by running this file there. */
const GOLDEN = '78352e64';

function spawn(world: WorldState, colonyId: number, x: number, y: number, zone: number): number {
  const id = allocateEntityId(world);
  initAnt(world.ants, id, {
    colonyId,
    posX: (x << FP_SHIFT) + (FP_ONE >> 1),
    posY: (y << FP_SHIFT) + (FP_ONE >> 1),
    task: AntTask.Fighting,
    subTask: 0,
    speed: WORKER_BASE_SPEED,
    lifespan: WORKER_LIFESPAN_TICKS,
    zone: zone as Zone,
  });
  world.ants.currentGridColonyId[id] = colonyId;
  world.colonies[colonyId]!.workers.push(id);
  world.colonies[colonyId]!.workerCount += 1;
  return id;
}

/** FNV-1a over a string: a short, stable fingerprint. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

describe('#372 — pinned V63: fighter orders and defence are unchanged below V64', () => {
  it('a garrison, intruders, a partial AI probe and a recall move exactly as before', () => {
    const world = createScenario(7, 'Normal');
    world.simVersion = V63;
    world.spider = null;
    const P = PLAYER_COLONY_ID;
    const E = ENEMY_COLONY_ID;
    const player = world.colonies[P]!;
    const enemy = world.colonies[E]!;
    const pa = player.entrances.find((en) => en.isOpen)!;
    const ee = enemy.entrances.find((en) => en.isOpen)!;
    // The player's nest: a shaft to a tunnel along row 3.
    const grid = world.undergroundGrids[P]!;
    for (let y = 0; y <= 3; y++) ugSet(grid, pa.surfaceTileX, y, UndergroundTileState.Open);
    for (let x = pa.surfaceTileX - 12; x <= pa.surfaceTileX + 12; x++) {
      ugSet(grid, x, 3, UndergroundTileState.Open);
    }
    player.digFlowFieldDirty = true;
    // A player garrison of five sentries (no rally), a ratio asking for fewer: a
    // surplus the stand-down would release.
    const garrison: number[] = [];
    for (let i = 0; i < 5; i++)
      garrison.push(spawn(world, P, pa.surfaceTileX + 2, pa.surfaceTileY, Zone.Surface));
    player.targetRatio.forage = 8;
    player.targetRatio.fight = 3;
    // Six enemy fighters at home, the AI ready to probe.
    const theirs: number[] = [];
    for (let i = 0; i < 6; i++)
      theirs.push(spawn(world, E, ee.surfaceTileX + 2, ee.surfaceTileY, Zone.Surface));
    enemy.targetRatio.forage = 4;
    enemy.targetRatio.fight = 6;
    getAIStateForColony(world, E)!.state = 'WarFooting';
    // Two enemy fighters already below in the player's nest, invading.
    const intruders = [pa.surfaceTileX + 8, pa.surfaceTileX - 9].map((x) => {
      const id = spawn(world, E, x, 3, Zone.Underground);
      world.ants.currentGridColonyId[id] = P;
      return id;
    });

    const probeTarget = { x: ee.surfaceTileX, y: ee.surfaceTileY + 12 };
    const frames: string[] = [];
    let probed = 0;
    let belowTogether = 0;
    let recalledOut = 0;
    for (let t = 0; t < TICKS; t++) {
      const cmds: SimCommand[] = [];
      if (t === 5) {
        // The AI probes with three of its fighters; the rally is the probe's.
        cmds.push(
          {
            type: 'StartAIOperation',
            colonyId: E,
            kind: 'Probe',
            rallyTileX: probeTarget.x,
            rallyTileY: probeTarget.y,
            fighterIds: theirs.slice(0, 3),
            issuedAtTick: world.tick,
          },
          {
            type: 'SetRallyPoint',
            colonyId: E,
            tileX: probeTarget.x,
            tileY: probeTarget.y,
            issuedAtTick: world.tick,
          },
        );
      }
      if (t === 300) {
        // The probe is called off (a recall: its rally cleared), the intruders with it.
        cmds.push({ type: 'ClearRallyPoint', colonyId: E, issuedAtTick: world.tick });
      }
      tick(world, cmds);
      if (getAIStateForColony(world, E)!.state === 'Probing') probed += 1;
      if (
        t > 300 &&
        intruders.some((i) => world.ants.alive[i] === 1 && world.ants.zone[i] === Zone.Surface)
      ) {
        recalledOut += 1;
      }
      const a = world.ants;
      if (
        intruders.some((i) => a.alive[i] === 1) &&
        garrison.some(
          (g) =>
            a.alive[g] === 1 &&
            a.task[g] === AntTask.Fighting &&
            a.zone[g] === Zone.Underground &&
            a.currentGridColonyId[g] === P,
        )
      ) {
        belowTogether += 1;
      }
      let f = `${world.tick}`;
      for (const id of [...garrison, ...theirs, ...intruders]) {
        f += `|${id}:${a.alive[id]}:${a.posX[id]! >> FP_SHIFT},${a.posY[id]! >> FP_SHIFT}:${a.zone[id]}:${a.currentGridColonyId[id]}:${a.task[id]}:${a.subTask[id]}`;
      }
      frames.push(f);
    }
    // Non-vacuity: the probe ran, and a recalled intruder came out.
    expect(probed).toBeGreaterThan(100);
    expect(belowTogether).toBe(0); // at V63 the sentries never go down after them
    expect(recalledOut).toBeGreaterThan(0); // a recalled intruder climbed out
    expect(fnv(frames.join('\n'))).toBe(GOLDEN);
  }, 60_000);
});
